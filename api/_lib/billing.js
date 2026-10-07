// ===== 課金（SpellDash Pro）共通（/api/billing/* と shared.js の reject() から使う） =====
//
// - Stripe は SDK を入れず fetch + Node の crypto で呼ぶ（form エンコード、ネストは a[b][c]）。
// - 本人の行（subscriptions）の読み取りは「本人のトークン + anon key」で行い、RLS に任せる。
//   service role key は webhook の書き込みにだけ使う。
// - entitlement の判定 isProRow は、クライアント（js/plan.js）と同じ式をここにも持つ。
// - 鍵（STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / SUPABASE_SERVICE_ROLE_KEY）と PII（メール・顧客 id）は
//   応答にもログにも出さない。ログは `billing/<label>: <種別> <状態>` だけ。
//
// 環境変数: STRIPE_SECRET_KEY（必須）, STRIPE_PRICE_MONTHLY（必須）, STRIPE_PRICE_YEARLY（任意）,
//   STRIPE_TRIAL_DAYS（任意・既定 0）, STRIPE_WEBHOOK_SECRET（webhook に必須）, SITE_ORIGIN（既定 https://www.spelldash.net）

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

// 本人の行を読むときの列（webhook の upsert で書く列と同じ）
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

// 「設定済み」= 秘密鍵と月額の Price が両方ある
export function billingConfigured() {
  return Boolean(stripeSecretKey()) && Boolean(priceIdFor("month"));
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

// bodyParser を切った関数で生ボディを読む（署名はこの文字列に対して計算する）
export async function readRawBody(req) {
  if (typeof req.body === "string") return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
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

export async function upsertSubscription(row) {
  const response = await serviceFetch("/rest/v1/subscriptions?on_conflict=user_id", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=representation" },
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
  return billingConfigured() && Boolean(webhookSecret()) && Boolean(serviceRoleKey());
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
