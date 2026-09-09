// ===== API共通（Vercel関数から使う。`_` で始まるディレクトリはルートにならない） =====
//
// - Supabaseのアクセストークン検証（ログイン必須の機能に使う）
// - 1ユーザーの1日回数の目安（サーバーレスのインスタンス内メモリ: 厳密ではないが暴走の歯止め）
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

// Supabaseのアクセストークンを検証し、ユーザーIDを返す（無効なら null）
export async function verifyUser(authorization) {
  const token = String(authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` }
    });
    if (!response.ok) return null;
    const user = await response.json();
    return user?.id || null;
  } catch {
    return null;
  }
}

const usage = new Map();

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

// 共通の前処理: メソッド／キー／ログイン／回数。問題があれば応答して true を返す
export async function reject(req, res, { scope, limit }) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    send(res, 405, { error: "method_not_allowed" });
    return true;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    send(res, 503, { error: "not_configured", message: "この機能は準備中です。" });
    return true;
  }
  const userId = await verifyUser(req.headers.authorization);
  if (!userId) {
    send(res, 401, { error: "login_required", message: "ログインすると使えます（無料）。" });
    return true;
  }
  if (overDailyLimit(scope, userId, limit)) {
    send(res, 429, { error: "daily_limit", message: "今日の上限に達しました。また明日どうぞ。" });
    return true;
  }
  return false;
}

// Claude SDKの例外を利用者向けの応答にする
export function sendUpstreamError(res, Anthropic, error, label) {
  if (error instanceof Anthropic.AuthenticationError) {
    return send(res, 503, { error: "not_configured", message: "この機能は準備中です。" });
  }
  if (error instanceof Anthropic.RateLimitError) {
    return send(res, 429, { error: "busy", message: "混み合っています。少し待ってからお試しください。" });
  }
  console.error(`${label} failed:`, error instanceof Anthropic.APIError ? `${error.status} ${error.message}` : error);
  return send(res, 502, { error: "upstream", message: "うまく作れませんでした。時間をおいてお試しください。" });
}
