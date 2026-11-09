// ===== 課金（SpellDash Pro）共通（/api/billing/* と shared.js の aiTake() から使う） =====
//
// - Stripe は SDK を入れず fetch + Node の crypto で呼ぶ（form エンコード、ネストは a[b][c]）。
// - 本人の行（subscriptions）の読み取りは「本人のトークン + anon key」で行い、RLS に任せる。
//   service role key は webhook の書き込みにだけ使う。
// - entitlement の判定 isProRow は、クライアント（js/plan.js）と同じ式をここにも持つ。
// - 鍵（STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / SUPABASE_SERVICE_ROLE_KEY）と PII（メール・顧客 id）は
//   応答にもログにも出さない。ログは `billing/<label>: <種別> <状態>` だけ。
//
// 環境変数: STRIPE_SECRET_KEY（必須）, STRIPE_PRICE_MONTHLY（必須）, STRIPE_PRICE_YEARLY（任意。年額は出さない決定なので入れない）,
//   STRIPE_TRIAL_MONTHS（任意・初めての方の無料期間の月。決定は 1）, STRIPE_TRIAL_DAYS（任意・既定 0。月が優先）,
//   STRIPE_WEBHOOK_SECRET（webhook に必須）, SITE_ORIGIN（既定 https://www.spelldash.net）
// 検査: scripts/test-billing.mjs（偽の fetch。外へ出ない）

import crypto from "node:crypto";
import { SUPABASE_URL, SUPABASE_ANON_KEY, send } from "./shared.js";
import { serviceFetch, serviceRoleKey, isMissingTable, errorCode, UpstreamError, MissingTableError, rejectMethod } from "./admin.js";

export { rejectMethod };

const STRIPE_API = "https://api.stripe.com";
const DEFAULT_ORIGIN = "https://www.spelldash.net";
const GRACE_MS = 3 * 86400000; // 期限切れ後 3 日の猶予（支払い失敗の再試行を待つ）
const SIGNATURE_TOLERANCE_SEC = 300;
const PRO_STATUSES = new Set(["active", "trialing", "past_due"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 本人の行を読むときの列（webhook が書く列と同じ）
export const SUBSCRIPTION_COLUMNS =
  "user_id,stripe_customer_id,stripe_subscription_id,status,price_id,plan_interval,current_period_end,cancel_at_period_end,event_created";

export const MESSAGES = {
  notConfigured: "Pro はまだ受付前です。",
  login: "加入にはログインが必要です。",
  badInterval: "プランの指定が正しくありません。",
  yearlyUnavailable: "年額プランはまだ用意されていません。",
  alreadySubscribed: "すでに Pro です。",
  noSubscription: "お支払いの情報がありません。Pro に加入すると使えます。",
  upstream: "手続きを始められませんでした。時間をおいてお試しください。",
  badSignature: "署名が正しくありません。",
  badRequest: "リクエストが正しくありません。",
  webhookFailed: "保存できませんでした。"
};

// ----- 設定 -----

export function stripeSecretKey() {
  return String(process.env.STRIPE_SECRET_KEY || "").trim();
}

export function priceIdFor(interval) {
  const name = interval === "year" ? "STRIPE_PRICE_YEARLY" : interval === "month" ? "STRIPE_PRICE_MONTHLY" : "";
  return name ? String(process.env[name] || "").trim() : "";
}

export function trialDays() {
  const n = Number(process.env.STRIPE_TRIAL_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// 無料期間を暦の月で（STRIPE_TRIAL_MONTHS。「初めての方は 1 か月無料」）。日数（STRIPE_TRIAL_DAYS）より優先する
export function trialMonths() {
  const n = Number(process.env.STRIPE_TRIAL_MONTHS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// 無料期間（月）の終わり（UNIX 秒）。日本時間で同じ日付の n か月後（無い日は月末に寄せる: 1/31 → 2/28）。月の指定が無ければ 0。
// 日数（STRIPE_TRIAL_DAYS）は Checkout の trial_period_days で渡す（trial_end は 48 時間以上先でないと Stripe が断るため、短い日数に使わない）
const JST_MS = 9 * 60 * 60 * 1000;
export function trialEndUnix(now = new Date()) {
  const months = trialMonths();
  if (months <= 0) return 0;
  const end = new Date(now.getTime() + JST_MS); // 日本時間の暦で数える（UTC だと朝 9 時前の加入が 1 日ずれる）
  const day = end.getUTCDate();
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(day, lastDay));
  return Math.floor((end.getTime() - JST_MS) / 1000);
}

export function siteOrigin() {
  return String(process.env.SITE_ORIGIN || DEFAULT_ORIGIN).trim().replace(/\/+$/, "") || DEFAULT_ORIGIN;
}

// 「設定済み」= 秘密鍵と月額の Price が両方ある（受付中。価格 /api/billing/config と加入 /api/billing/checkout が見る）
export function billingConfigured() {
  return Boolean(stripeSecretKey()) && Boolean(priceIdFor("month"));
}

// 秘密鍵がある（決済の会社に問い合わせられる）。もう加入している人の「解約・お支払いの管理」（portal）と webhook はこれだけを見る:
// 月額の Price の変数を外して受付を急いで止めても（docs/BILLING.md §2 の止め方）、加入者の解約・カードの変更と状態の反映は止まらない
export function secretKeyConfigured() {
  return Boolean(stripeSecretKey());
}

export function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

// ----- entitlement -----

// 行があり、status が active / trialing / past_due で、期限が無いか「期限 + 3 日」がまだ先なら Pro
export function isProRow(row, now = Date.now()) {
  if (!row || !PRO_STATUSES.has(String(row.status))) return false;
  if (!row.current_period_end) return true;
  return Date.parse(row.current_period_end) + GRACE_MS > now;
}

// CRM 用: subscriptions の行 → { plan, planStatus, planPeriodEnd, planInterval }（行が無ければ free）
export function planOf(row, now = Date.now()) {
  const end = row?.current_period_end ? Date.parse(row.current_period_end) : NaN;
  const interval = row?.plan_interval;
  return {
    plan: isProRow(row, now) ? "pro" : "free",
    planStatus: typeof row?.status === "string" && row.status.trim() ? row.status.trim() : null,
    planPeriodEnd: Number.isFinite(end) ? new Date(end).toISOString() : null,
    planInterval: interval === "month" || interval === "year" ? interval : null
  };
}

// ----- Stripe -----

// application/x-www-form-urlencoded。ネストしたオブジェクト・配列は a[b][c] / a[0] に展開する
export function encodeForm(params) {
  const pairs = [];
  const walk = (key, value) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(`${key}[${index}]`, item));
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(`${key}[${k}]`, v);
    } else {
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  };
  for (const [key, value] of Object.entries(params || {})) walk(key, value);
  return pairs.join("&");
}

// Stripe API を 1 回呼ぶ。失敗は UpstreamError("stripe", status, error.type) で投げる（本文は持ち回らない）
export async function stripeFetch(path, params = null, { method = "POST", idempotencyKey = "" } = {}) {
  const key = stripeSecretKey();
  if (!key) throw new UpstreamError("stripe", 0, "missing_key");
  const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };
  const init = { method, headers };
  let url = `${STRIPE_API}${path}`;
  if (method === "GET") {
    const query = encodeForm(params);
    if (query) url += `?${query}`;
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = encodeForm(params);
  }
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const response = await fetch(url, init);
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) throw new UpstreamError("stripe", response.status, String(data?.error?.type || data?.error?.code || ""));
  return data;
}

// ----- 1 人に顧客 1 人・開いた手続きは 1 つ（Batch 88） -----
// 前は行の無い人の手続きを customer_email だけで作っていたので、手続きのたびに決済の会社に別の顧客ができ、開いたままの手続きを 2 つとも払うと
// 契約が 2 つになった（「解約・お支払いの管理」は片方の顧客しか開けず、片方の終わりで行が canceled になると Pro でないのに課金が続く）。
// 今は手続きの前に本人の顧客を決め（行の顧客 → metadata の user_id で検索 → 冪等キー customer:<uuid> で作る）、手続きはいつも customer で作る。
// 新しい手続きを作ったら、同じ顧客の開いている別の手続きを期限切れにする（古いタブ・履歴から前の手続きを最後まで進められない）。

// 契約が「生きている」（Pro の判定と同じ 3 つ。新しい手続きを断る側は unpaid も生きているとみなす: checkout.js の LIVE_STATUSES）
export const LIVE_SUBSCRIPTION_STATUSES = PRO_STATUSES;

// 本人の顧客の番号。行に顧客があればそれ。無ければ metadata の user_id で探し（決済の会社の検索は少し遅れて出るので、見つからなければ）、
// 冪等キー customer:<uuid> で作る（24 時間は同じ顧客が返る。その後は webhook が行に顧客を書いている）。検索の失敗は止めない。作れなければ投げる
export async function customerFor(user, row) {
  if (typeof row?.stripe_customer_id === "string" && row.stripe_customer_id) return row.stripe_customer_id;
  if (!isUuid(user?.id)) throw new UpstreamError("stripe", 0, "bad_user");
  try {
    const found = await stripeFetch("/v1/customers/search", { query: `metadata['user_id']:'${user.id}'`, limit: 1 }, { method: "GET" });
    const id = Array.isArray(found?.data) ? found.data.find((c) => typeof c?.id === "string" && c.metadata?.user_id === user.id)?.id : null;
    if (id) return id;
  } catch {
    // 検索できなくても作る（冪等キーで同じ顧客になる）
  }
  const params = { metadata: { user_id: user.id } };
  if (user.email) params.email = user.email;
  const created = await stripeFetch("/v1/customers", params, { idempotencyKey: `customer:${user.id}` });
  if (typeof created?.id !== "string" || !created.id) throw new UpstreamError("stripe", 0, "no_customer");
  return created.id;
}

// 顧客の契約（状態を問わず。最大 20）。読めなければ投げる（生きている契約が無いと確かめられないまま手続きを作らない）
export async function subscriptionsOfCustomer(customerId) {
  const list = await stripeFetch("/v1/subscriptions", { customer: customerId, status: "all", limit: 20 }, { method: "GET" });
  return Array.isArray(list?.data) ? list.data : [];
}

// 同じ顧客の開いている手続きのうち、keepId でない物を期限切れにする（守りの上乗せ。失敗しても止めない: 手続きの期限〔作ってから 35 分〕が残る）
export async function expireOtherOpenSessions(customerId, keepId) {
  try {
    const open = await stripeFetch("/v1/checkout/sessions", { customer: customerId, status: "open", limit: 10 }, { method: "GET" });
    for (const session of Array.isArray(open?.data) ? open.data : []) {
      if (typeof session?.id !== "string" || !session.id || session.id === keepId) continue;
      try {
        await stripeFetch(`/v1/checkout/sessions/${encodeURIComponent(session.id)}/expire`, {});
      } catch {
        // もう払われた・期限が来た手続きなど
      }
    }
  } catch {
    // 一覧が読めない
  }
}

// Stripe-Signature: t=<unix 秒>,v1=<hex>[,v1=<hex>...]。
// HMAC-SHA256(secret, `${t}.${rawBody}`) の hex を v1 のどれかと timingSafeEqual（長さ違いは不一致）。|now - t| が 300 秒超なら拒否
export function verifyStripeSignature(rawBody, header, secret, now = Math.floor(Date.now() / 1000)) {
  if (!secret || typeof header !== "string" || rawBody == null) return false;
  let timestamp = NaN;
  const signatures = [];
  for (const part of header.split(",")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (name === "t") timestamp = Number(value);
    else if (name === "v1" && value) signatures.push(value);
  }
  if (!Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(now - timestamp) > SIGNATURE_TOLERANCE_SEC) return false;
  const expected = Buffer.from(crypto.createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex"), "utf8");
  return signatures.some((signature) => {
    const given = Buffer.from(signature, "utf8");
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}

// 生ボディ（署名を計算する元のバイト列）を読む。戻り値は Buffer か文字列。読めなければ null（そのときは署名を確かめられない → 400）。
// 今の配信のサーバーの関数は、既定の補助（helpers）が関数を呼ぶ前に本文の流れを最後まで読み、読み切ったバイト列の写しを持つ流れへ
// req.on('data'/'end')（と req.read）を付け替え、req.body は読んだ時に JSON にする（rawBody は置かない。bodyParser: false の指定は読まない）。
// 元の流れは読み終わっている（readableEnded）ので、流れを直に読む作りでは何も読めない（Batch 83 の反証。公開されている実行環境の版で確かめた）。
// ほかの作りもありうるので、どの作りでも届いたバイト列だけで確かめる:
//   1. 生の値の req.rawBody（文字列か Buffer）があればそれ。req.body には触らない（body を読むと解析する・例外を出す・流れを使い切る作りがある）
//   2. req.on が自分の持ち物として付け替えられていれば（配信の補助）、それで 'data' を集めて 'end' を待つ（写しが終わらなくても RAW_BODY_WAIT_MS で諦める）
//   3. そうでなく、まだ読まれていない流れ（IncomingMessage）なら、それを読む
//   4. それでも空なら、文字列か Buffer の req.body。解析済みの値（object）しか無ければ null。JSON を作り直して確かめない（届いたバイト列と同じになる保証が無い）
const RAW_BODY_WAIT_MS = 5000;

function bytesOf(value) {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (value instanceof Uint8Array) return value.length > 0 ? Buffer.from(value) : null;
  return null;
}

// 付け替えた req.on から集める。終わらなければ waitMs で null（関数の時間切れまで待たない）。流れの失敗は投げる（呼び手は 400）
function readThroughListeners(req, waitMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let done = false;
    let timer = null;
    const finish = (value, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    timer = setTimeout(() => finish(null), waitMs);
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => finish(Buffer.concat(chunks)));
    req.on("error", (error) => finish(null, error));
  });
}

export async function readRawBody(req, { waitMs = RAW_BODY_WAIT_MS } = {}) {
  if (!req) return null;
  const raw = bytesOf(req.rawBody);
  if (raw !== null) return raw;
  let read = null;
  if (typeof req.on === "function" && Object.prototype.hasOwnProperty.call(req, "on")) {
    read = await readThroughListeners(req, waitMs);
  } else if (typeof req[Symbol.asyncIterator] === "function" && !req.readableEnded) {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    read = Buffer.concat(chunks);
  }
  if (read && read.length > 0) return read;
  try {
    return bytesOf(req.body);
  } catch {
    return null; // body を読むと例外（解析の失敗など）: 生の値は無い
  }
}

// 確定の画面（決済の会社の Checkout。確定のボタンのそば）に出す文: custom_text[submit][message]。
// 特定商取引法 12 条の 6（最終確認の画面）: 自動で更新すること・最初の請求がいつか・提供の時期・解約の方法と条件を、申し込みを確定する画面で分かるようにする。
// 提供の時期は特商法の表記（tokushoho.html の提供時期）と同じ: 手続きが終わるとすぐ・無料期間中も同じ。
// 金額は書かない（その画面が同じ Price から出す）。trialLabel は無料期間が付くときだけ（「1か月」「7日」）。決済の会社の上限より十分短く（500 字以内）
export function checkoutSubmitMessage({ interval = "month", trialLabel = "" } = {}) {
  const every = interval === "year" ? "毎年" : "毎月";
  const first = trialLabel
    ? `初めての方の無料期間として、最初の${trialLabel}は料金がかかりません。無料期間が終わる日に最初の請求があり、その後は${every}自動で更新します。`
    : `お申し込みの日に最初の請求があり、その後は${every}自動で更新します。`;
  const provide = `お申し込みの手続きが終わるとすぐに使えます${trialLabel ? "（無料期間中も同じです）" : ""}。`;
  const cancel = `解約はいつでも「設定 → 解約・お支払いの管理」からできます。${trialLabel ? "無料期間中に解約すれば請求はありません。" : ""}解約しても期間の終わりまで使え、日割りの返金はしません。`;
  return first + provide + cancel;
}

// ----- Supabase: subscriptions -----

async function rowsOf(response, label) {
  if (!response.ok) {
    if (await isMissingTable(response)) throw new MissingTableError(label);
    throw new UpstreamError(label, response.status, await errorCode(response));
  }
  const rows = await response.json();
  return Array.isArray(rows) ? rows : [];
}

// 本人の行（本人のトークン + anon key。RLS で本人の行しか返らない）。テーブルが無ければ「行なし」
export async function fetchOwnSubscription(token, userId) {
  if (!token || !isUuid(userId)) return null;
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=${SUBSCRIPTION_COLUMNS}&limit=1`,
    { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, Accept: "application/json" } }
  );
  try {
    return (await rowsOf(response, "subscriptions"))[0] || null;
  } catch (error) {
    if (error instanceof MissingTableError) return null;
    throw error;
  }
}

// 以下は service role（webhook だけが使う）。テーブルが無ければ MissingTableError を投げる
export async function readSubscription(userId) {
  const response = await serviceFetch(`/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=${SUBSCRIPTION_COLUMNS}&limit=1`);
  return (await rowsOf(response, "subscriptions"))[0] || null;
}

export async function findSubscriptionByCustomer(customerId) {
  if (typeof customerId !== "string" || !customerId) return null;
  const response = await serviceFetch(
    `/rest/v1/subscriptions?stripe_customer_id=eq.${encodeURIComponent(customerId)}&select=${SUBSCRIPTION_COLUMNS}&limit=1`
  );
  return (await rowsOf(response, "subscriptions"))[0] || null;
}

// 本人の行がまだ無いときの最初の書き込み: 入れるだけ（同じ人の行がもうあれば何もしない。データベースの REST の resolution=ignore-duplicates ＝
// ON CONFLICT (user_id) DO NOTHING。前の upsert の merge-duplicates と同じ書き方の別の値）。入れた行を返す。入らなかった（同時に届いた
// 別のイベントが先に入れた）ら null で、呼び手は event_created を条件にした書き換え（updateSubscriptionIfNotNewer）へ進む。
// 前は merge-duplicates の upsert で、2 つのイベントが同時に「行が無い」を読むと、後から書いた古いイベントが新しいイベントを上書きした
export async function insertSubscriptionIfAbsent(row) {
  const response = await serviceFetch("/rest/v1/subscriptions?on_conflict=user_id", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify(row)
  });
  return (await rowsOf(response, "subscriptions"))[0] || null;
}

export function webhookSecret() {
  return String(process.env.STRIPE_WEBHOOK_SECRET || "").trim();
}

// 既存行を、event_created がこのイベント以下のときだけ書き換える（同時到着でも古い状態で上書きしない）。
// 条件に合わず何も更新されなければ null
export async function updateSubscriptionIfNotNewer(row) {
  const response = await serviceFetch(
    `/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(row.user_id)}&event_created=lte.${Number(row.event_created) || 0}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify(row)
    }
  );
  return (await rowsOf(response, "subscriptions"))[0] || null;
}

export function webhookConfigured() {
  return secretKeyConfigured() && Boolean(webhookSecret()) && Boolean(serviceRoleKey());
}

// ----- 応答・ログ -----

// ログには種別と状態コードだけ（本文・鍵・メール・顧客 id は書かない）
export function logBilling(label, error) {
  if (error instanceof UpstreamError) {
    console.error(`billing/${label}: upstream ${error.label} ${error.status}${error.code ? ` ${error.code}` : ""}`);
  } else {
    console.error(`billing/${label}: ${error?.name || "Error"}: ${String(error?.message || "").slice(0, 200)}`);
  }
}

export function sendUpstream(res, label, error) {
  logBilling(label, error);
  return send(res, 502, { error: "upstream", message: MESSAGES.upstream });
}
