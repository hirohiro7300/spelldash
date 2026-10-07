// ===== API共通（Vercel関数から使う。`_` で始まるディレクトリはルートにならない） =====
//
// - Supabaseのアクセストークン検証（ログイン必須の機能に使う）
// - 1ユーザーの1日回数の目安（サーバーレスのインスタンス内メモリ: 厳密ではないが暴走の歯止め）
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

export function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try {
    return JSON.parse(typeof req.body === "string" ? req.body : "{}");
  } catch {
    return {};
  }
}

export function bearerToken(authorization) {
  return String(authorization || "").replace(/^Bearer\s+/i, "").trim();
}

// Supabaseのアクセストークンを検証し、{ id, email, emailConfirmed } を返す（無効なら null）
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
      emailConfirmed: Boolean(user.email_confirmed_at || user.confirmed_at)
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

const usage = new Map();

// 本人が Pro かどうか（ユーザーごと 5 分のメモリキャッシュ。読めなければ無料として扱う）
const PLAN_CACHE_MS = 5 * 60 * 1000;
const planCache = new Map();

async function isProUser(token, userId) {
  const now = Date.now();
  const cached = planCache.get(userId);
  if (cached && now - cached.at < PLAN_CACHE_MS) return cached.pro;
  let pro = false;
  try {
    const billing = await import("./billing.js");
    pro = billing.isProRow(await billing.fetchOwnSubscription(token, userId), now);
  } catch {
    pro = false;
  }
  // Pro のときだけ覚える（無料を覚えると、加入した直後の 5 分間は無料の上限のまま「Pro について」を返してしまう）
  if (pro) planCache.set(userId, { at: now, pro });
  return pro;
}

export function overDailyLimit(scope, userId, limit) {
  const today = new Date().toISOString().slice(0, 10);
  const key = `${scope}:${userId}`;
  const entry = usage.get(key);
  if (!entry || entry.day !== today) {
    usage.set(key, { day: today, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > limit;
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

// 共通の前処理: メソッド／キー／ログイン／回数。問題があれば応答して true を返す
// limit は無料の 1 日上限、proLimit は Pro の上限（省略時は limit と同じ）
export async function reject(req, res, { scope, limit, proLimit = limit }) {
  allowAppOrigin(req, res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return true;
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    send(res, 405, { error: "method_not_allowed" });
    return true;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    send(res, 503, { error: "not_configured", message: "この機能は準備中" });
    return true;
  }
  const userId = await verifyUser(req.headers.authorization);
  if (!userId) {
    send(res, 401, { error: "login_required", message: "ログインすると使える（無料）" });
    return true;
  }
  const pro = await isProUser(bearerToken(req.headers.authorization), userId);
  const max = pro ? proLimit : limit;
  if (overDailyLimit(scope, userId, max)) {
    const message = pro
      ? `今日の上限（${max}回）に達した。また明日`
      : `今日の無料ぶん（${limit}回）は使い切った。Pro なら1日${proLimit}回`;
    send(res, 429, { error: "daily_limit", upgrade: !pro, message });
    return true;
  }
  return false;
}

// Claude SDKの例外を利用者向けの応答にする
export function sendUpstreamError(res, Anthropic, error, label) {
  if (error instanceof Anthropic.AuthenticationError) {
    return send(res, 503, { error: "not_configured", message: "この機能は準備中" });
  }
  if (error instanceof Anthropic.RateLimitError) {
    return send(res, 429, { error: "busy", message: "混み合っている。少し待ってもう一度" });
  }
  console.error(`${label} failed:`, error instanceof Anthropic.APIError ? `${error.status} ${error.message}` : error);
  return send(res, 502, { error: "upstream", message: "作れなかった。時間をおいてもう一度" });
}
