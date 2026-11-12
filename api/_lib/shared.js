// ===== API共通（Vercel関数から使う。`_` で始まるディレクトリはルートにならない） =====
//
// - Supabaseのアクセストークン検証（ログイン必須の機能に使う）
// - AI の入口（Batch 88）: aiGate（メソッド・鍵・ログイン。確認済みのメールで匿名でない人だけ）→ 各 api が入力を確かめる（400）→
//   aiTake（同じ人の処理中は 429 busy・1 日の回数）→ モデル → aiTake が返した関数で処理中の印を外す。まちがった入力は回数を減らさない
// - 1 日の回数: まずデータベースの ai_take（本人のトークン。docs/SQL_AI_USAGE.md。全部のインスタンスで 1 つの数）。
//   関数が無い・失敗・数でない答えなら、前のとおりインスタンス内メモリで数える（厳密ではないが暴走の歯止め。SQL を流す前も同じに動く）
//   上限は無料と Pro で変える（本人の subscriptions 行を 5 分キャッシュして判定。詳細は _lib/billing.js）
// - JSON応答ヘルパー

export const SUPABASE_URL = process.env.SUPABASE_URL || "https://sujvgwozsnzjsjmkcrnk.supabase.co";
export const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN1anZnd296c256anNqbWtjcm5rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2MDA5NDIsImV4cCI6MjA5ODE3Njk0Mn0.NkgB0vIgI4Q3DL5fSuF4kbtF3P4ORMbHzoPGbnOG3mc";

export function send(res, status, body) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(body);
}

// 要求の本文（JSON）。普通の object でなければ {}（'null'・配列・数・文字列・壊れた JSON で落ちない。Batch 88）
export function readBody(req) {
  let value = req.body;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) value = value.toString("utf8");
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return isPlainObject(value) ? value : {};
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function bearerToken(authorization) {
  return String(authorization || "").replace(/^Bearer\s+/i, "").trim();
}

// ログインのアクセストークンを検証し、{ id, email, emailConfirmed, isAnonymous } を返す（無効なら null）
export async function verifyUserFull(authorization) {
  const token = bearerToken(authorization);
  if (!token) return null;
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` }
    });
    if (!response.ok) return null;
    const user = await response.json();
    if (!user?.id) return null;
    return {
      id: String(user.id),
      email: typeof user.email === "string" ? user.email : "",
      emailConfirmed: Boolean(user.email_confirmed_at || user.confirmed_at),
      isAnonymous: user.is_anonymous === true
    };
  } catch {
    return null;
  }
}

// ユーザーIDだけ要るとき（無効なら null）
export async function verifyUser(authorization) {
  const user = await verifyUserFull(authorization);
  return user ? user.id : null;
}

// このインスタンスのメモリー: 回数（"<scope>:<user>" → { day, count }。ai_take が使えないときだけ）・Pro の覚え・処理中の人
const usage = new Map();
const busy = new Map(); // 処理中の人 → 印（{ at: 始めた時刻 }）
// 処理中の印は BUSY_STALE_MS で古いとみなす（関数の時間切れ〔vercel.json の maxDuration。最大 60 秒〕で finally が走らないまま、
// 同じインスタンスが使い回されても、その人をずっと 429 busy にしない。Batch 88 の反証）
const BUSY_STALE_MS = 90 * 1000;

// 本人が Pro かどうか（ユーザーごと 5 分のメモリキャッシュ。読めなければ無料として扱う）。
// 無料も覚える。無料の上限で断る前は、30 秒より古い答えなら読み直す（fresh。加入した直後の人を無料の上限で断らない。
// 上限の人が連打しても、読み直すのは 30 秒に 1 回まで）
const PLAN_CACHE_MS = 5 * 60 * 1000;
const PLAN_FRESH_MS = 30 * 1000;
const planCache = new Map();

async function isProUser(token, userId, { fresh = false } = {}) {
  const now = Date.now();
  const cached = planCache.get(userId);
  if (cached && now - cached.at < (fresh ? PLAN_FRESH_MS : PLAN_CACHE_MS)) return cached.pro;
  let pro = false;
  try {
    const billing = await import("./billing.js");
    pro = billing.isProRow(await billing.fetchOwnSubscription(token, userId), now);
  } catch {
    pro = false;
  }
  planCache.set(userId, { at: now, pro });
  return pro;
}

// 「Pro なら…」を添えてよいか: 受付中（_lib/billing.js billingConfigured。Batch 94 から 4 つの変数がそろってから）で、アプリからの呼び出しではない（ストアの規約）
async function canOfferPro(req) {
  if (APP_ORIGINS.has(req.headers.origin)) return false;
  try {
    const billing = await import("./billing.js");
    return billing.billingConfigured();
  } catch {
    return false;
  }
}

// 今日（UTC の日）。時刻は Date.now から読む（検査が日を替えられる）
const todayUtc = () => new Date(Date.now()).toISOString().slice(0, 10);

// 昨日より前の回数と、古い Pro の覚えを捨てる（日が替わって最初の 1 回だけ見る。メモリーを増やし続けない）
let prunedDay = "";
function pruneMemory(today) {
  if (prunedDay === today) return;
  prunedDay = today;
  for (const [key, entry] of usage) if (entry.day !== today) usage.delete(key);
  const now = Date.now();
  for (const [key, entry] of planCache) if (now - entry.at >= PLAN_CACHE_MS) planCache.delete(key);
  for (const [key, mark] of busy) if (now - mark.at >= BUSY_STALE_MS) busy.delete(key); // 外されないまま古くなった印
}

// 検査とログ用: メモリーの項目の数
export function aiMemory() {
  return { usage: usage.size, plans: planCache.size, busy: busy.size };
}

// このインスタンスのメモリーで、今日の数を 1 つ増やして返す
function memoryTake(scope, userId, today) {
  const key = `${scope}:${userId}`;
  const entry = usage.get(key);
  if (!entry || entry.day !== today) {
    usage.set(key, { day: today, count: 1 });
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

// 今日の数を 1 つ増やして返す。まずデータベースの ai_take（本人のトークン・公開の鍵。数は本人の分だけ: docs/SQL_AI_USAGE.md）。
// 関数が無い（404・PGRST202）・ほかの失敗・3 秒で答えない・数でない答えなら、このインスタンスのメモリーで数える
const TAKE_TIMEOUT_MS = 3000;
async function takeCount(scope, user, today) {
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ai_take`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_scope: scope }),
      signal: AbortSignal.timeout(TAKE_TIMEOUT_MS)
    });
    if (response.ok) {
      const value = await response.json();
      if (Number.isInteger(value) && value > 0) return value;
    }
  } catch {
    // 読めない・待ちきれない: メモリーで数える
  }
  return memoryTake(scope, user.id, today);
}

// アプリ（Capacitor の WebView）からの呼び出しを許可する（本番 Web は同一オリジンなので不要）
const APP_ORIGINS = new Set(["capacitor://localhost", "https://localhost", "http://localhost", "ionic://localhost"]);

function allowAppOrigin(req, res) {
  const origin = req.headers.origin;
  if (!origin || !APP_ORIGINS.has(origin)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

const NOT_CONFIGURED = { error: "not_configured", message: "この機能は準備中" };
const LOGIN_REQUIRED = { error: "login_required", message: "ログインすると使える（無料）" };
const BUSY = { error: "busy", message: "混み合っている。少し待ってもう一度" };

// AI の入口の前半: メソッド・鍵・ログイン。ログインは確認済みのメールで、匿名でない人だけ（AI の費用を守る）。
// 問題があれば応答して null を返す。通れば本人（{ id, email, emailConfirmed, isAnonymous, token }）
export async function aiGate(req, res) {
  allowAppOrigin(req, res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return null;
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    send(res, 405, { error: "method_not_allowed" });
    return null;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    send(res, 503, NOT_CONFIGURED);
    return null;
  }
  const user = await verifyUserFull(req.headers.authorization);
  if (!user || !user.emailConfirmed || user.isAnonymous) {
    send(res, 401, LOGIN_REQUIRED);
    return null;
  }
  return { ...user, token: bearerToken(req.headers.authorization) };
}

// AI の入口の後半（入力を確かめた後で呼ぶ）: 同じ人の処理中は 429 busy（このインスタンスで 1 人 1 つ）、1 日の回数を 1 つ取って上限なら 429 daily_limit。
// 断ったら応答して null。通れば、終わりに必ず呼ぶ関数（処理中の印を外す）を返す
// limit は無料の 1 日上限、proLimit は Pro の上限（省略時は limit と同じ）
export async function aiTake(req, res, user, { scope, limit, proLimit = limit }) {
  const held = busy.get(user.id);
  if (held && Date.now() - held.at < BUSY_STALE_MS) {
    send(res, 429, BUSY);
    return null;
  }
  const mark = { at: Date.now() };
  busy.set(user.id, mark);
  let released = false;
  // 外すのは自分の印だけ（古い印の呼び出しが後から終わっても、後から始めた人の印を外さない）
  const release = () => {
    if (released) return;
    released = true;
    if (busy.get(user.id) === mark) busy.delete(user.id);
  };
  try {
    const today = todayUtc();
    pruneMemory(today);
    let [pro, count] = await Promise.all([isProUser(user.token, user.id), takeCount(scope, user, today)]);
    // 無料の上限で断る前に読み直す（加入した直後に、覚えていた「無料」で断らない。30 秒以内に読んでいればそのまま）
    if (!pro && proLimit > limit && count > limit) pro = await isProUser(user.token, user.id, { fresh: true });
    const max = pro ? proLimit : limit;
    if (count > max) {
      release();
      if (pro) {
        send(res, 429, { error: "daily_limit", upgrade: false, message: `今日の上限（${max}回）に達した。また明日` });
        return null;
      }
      // Pro の案内は別の欄（表示側は受付中のときだけ足す。文を削って消さない）
      const upgrade = await canOfferPro(req);
      send(res, 429, { error: "daily_limit", upgrade, message: `今日の無料ぶん（${limit}回）は使い切った。`, ...(upgrade ? { offer: `Pro なら1日${proLimit}回` } : {}) });
      return null;
    }
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

// Claude SDKの例外を利用者向けの応答にする
export function sendUpstreamError(res, Anthropic, error, label) {
  if (error instanceof Anthropic.AuthenticationError) {
    return send(res, 503, NOT_CONFIGURED);
  }
  if (error instanceof Anthropic.RateLimitError) {
    return send(res, 429, BUSY);
  }
  console.error(`${label} failed:`, error instanceof Anthropic.APIError ? `${error.status} ${error.message}` : error);
  return send(res, 502, { error: "upstream", message: "作れなかった。時間をおいてもう一度" });
}
