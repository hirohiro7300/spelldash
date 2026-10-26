// ===== 管理 API 共通（/api/admin/* から使う。`_` で始まるディレクトリはルートにならない） =====
//
// - requireAdmin: Supabase のトークンを検証し、email が ADMIN_EMAILS（または id が ADMIN_USER_IDS）に
//   含まれる人だけ通す。通らないときは自分で 401 / 403 / 503 を応答して null を返す。
// - serviceFetch: service role key を付けて Supabase を呼ぶ。キーはサーバーの環境変数にだけ置く。
// - restAll: PostgREST の Range ヘッダで 1000 行ずつ全件を取る（既定の上限が 1000 行のため）。
// - isMissingTable / MissingTableError: 未作成のテーブル（404 / SQLSTATE 42P01）を「無い」として扱う。
// - jstToday / dayDiff / segmentOf: セグメント判定に使う日付の小さな関数（JST 固定、夏時間なし）。
//
// 方針: service role key と PII（メールアドレス）はログにも応答にも出さない。Supabase のエラー本文は
// 応答に含めず、ログにも状態コードと SQLSTATE だけを書く。CORS はアプリ由来の Origin も許可しない（Web のみ）。

import { SUPABASE_URL, SUPABASE_ANON_KEY, send } from "./shared.js";

export const PAGE_SIZE = 1000;
const MAX_PAGES = 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export const MESSAGES = {
  login: "ログインしてください。",
  forbidden: "このアカウントには権限がありません。",
  notConfigured:
    "管理画面はまだ設定されていません。Vercel の環境変数 SUPABASE_SERVICE_ROLE_KEY と ADMIN_EMAILS を設定してください（手順: docs/CRM.md）。",
  notesMissing: "メモとタグを保存するには crm_notes テーブルが必要です（手順: docs/SQL_CRM.md）。",
  method: "このメソッドは使えません。",
  upstream: "データを取得できませんでした。時間をおいてお試しください。",
  notFound: "該当するプレイヤーがいません。",
  badUserId: "userId が UUID ではありません。"
};

// ----- 日付（JST） -----

export function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

export function isDay(value) {
  return typeof value === "string" && DAY_RE.test(value);
}

// ミリ秒または日時文字列 → JST の 'YYYY-MM-DD'（解釈できなければ null）
export function jstDay(input) {
  const t = typeof input === "number" ? input : Date.parse(String(input ?? ""));
  if (!Number.isFinite(t)) return null;
  return new Date(t + JST_OFFSET_MS).toISOString().slice(0, 10);
}

export function jstToday() {
  return jstDay(Date.now());
}

// a − b を日数で（両方 'YYYY-MM-DD'。形式が違えば null）
export function dayDiff(a, b) {
  if (!isDay(a) || !isDay(b)) return null;
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS);
}

export function addDays(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

// lastActiveDay 無し → dormant。today − lastActiveDay が 0〜7 日 → active、8〜21 → atRisk、22 日以上 → churned
export function segmentOf(today, lastActiveDay) {
  if (!lastActiveDay) return "dormant";
  const diff = dayDiff(today, lastActiveDay);
  if (diff === null) return "dormant";
  if (diff <= 7) return "active";
  if (diff <= 21) return "atRisk";
  return "churned";
}

// createdAt（JST の日付に直す）が today から 7 日以内なら新規
export function isNewSince(today, createdAt) {
  const created = jstDay(createdAt);
  const diff = created ? dayDiff(today, created) : null;
  return diff !== null && diff <= 7;
}

// ----- 値の正規化（RPC 経由でも REST 経由でも同じ JSON になるように、ここを通す） -----

export function toInt(value, fallback = 0) {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

// jsonb の数値だけを受け付ける（SQL 側の jsonb_typeof(...) = 'number' と同じ扱い）
export function jsonNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
}

export function numberOrNull(value) {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function textOrNull(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

export function noteText(value) {
  return typeof value === "string" ? value : "";
}

export function tagList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((tag) => typeof tag === "string" && tag.trim() !== "").map((tag) => tag.trim());
}

// ----- 管理者判定 -----

function envList(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function serviceRoleKey() {
  return String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
}

export function adminConfigured() {
  return Boolean(serviceRoleKey()) && (envList("ADMIN_EMAILS").length > 0 || envList("ADMIN_USER_IDS").length > 0);
}

export function isAdmin(user) {
  const email = String(user?.email || "").trim().toLowerCase();
  const id = String(user?.id || "").trim().toLowerCase();
  // メールでの一致は、そのメールが確認済みのときだけ信じる（確認なしで名乗れる設定だった場合の備え）
  if (email && user?.emailConfirmed !== false && envList("ADMIN_EMAILS").includes(email)) return true;
  if (id && envList("ADMIN_USER_IDS").includes(id)) return true;
  return false;
}

// shared.js の verifyUser は id しか返さないので、email も返す版
export async function verifyUserFull(authorization) {
  const token = String(authorization || "").replace(/^Bearer\s+/i, "").trim();
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

// 設定 → ログイン → 権限 の順に確かめる。通らなければ応答して null
export async function requireAdmin(req, res) {
  if (!adminConfigured()) {
    send(res, 503, { error: "not_configured", message: MESSAGES.notConfigured });
    return null;
  }
  const user = await verifyUserFull(req.headers?.authorization);
  if (!user) {
    send(res, 401, { error: "login_required", message: MESSAGES.login });
    return null;
  }
  if (!isAdmin(user)) {
    send(res, 403, { error: "forbidden", message: MESSAGES.forbidden });
    return null;
  }
  return { userId: user.id, email: user.email };
}

export function rejectMethod(req, res, allowed) {
  if (req.method === allowed) return false;
  res.setHeader("Allow", allowed);
  send(res, 405, { error: "method_not_allowed", message: MESSAGES.method });
  return true;
}

// メソッド → 管理者 → 本体。本体が投げたら 502（詳細はログのみ）
export async function handleAdmin(req, res, { method, label }, run) {
  if (rejectMethod(req, res, method)) return;
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  try {
    await run(admin);
  } catch (error) {
    logUpstream(label, error);
    send(res, 502, { error: "upstream", message: MESSAGES.upstream });
  }
}

// ----- Supabase（service role） -----

export class UpstreamError extends Error {
  constructor(label, status, code) {
    super(`${label}: ${status}${code ? ` ${code}` : ""}`);
    this.name = "UpstreamError";
    this.label = label;
    this.status = status;
    this.code = code || "";
  }
}

export class MissingTableError extends Error {
  constructor(table) {
    super(`missing table: ${table}`);
    this.name = "MissingTableError";
    this.table = table;
  }
}

// ログには状態コードと SQLSTATE だけ（本文・キー・メールは書かない）
export function logUpstream(label, error) {
  if (error instanceof UpstreamError) {
    console.error(`admin/${label}: upstream ${error.label} ${error.status}${error.code ? ` ${error.code}` : ""}`);
  } else {
    console.error(`admin/${label}: ${error?.name || "Error"}: ${String(error?.message || "").slice(0, 200)}`);
  }
}

export async function serviceFetch(path, init = {}) {
  const key = serviceRoleKey();
  if (!key) throw new UpstreamError("service_role", 0, "missing_key");
  const headers = { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json", ...(init.headers || {}) };
  return fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
}

// PostgREST のエラー本文から SQLSTATE / PGRST コードを取り出す（本文は複製して読む）
export async function errorCode(response) {
  try {
    const source = typeof response.clone === "function" ? response.clone() : response;
    const parsed = JSON.parse(await source.text());
    return parsed && parsed.code != null ? String(parsed.code) : "";
  } catch {
    return "";
  }
}

// 404（スキーマキャッシュに無い）か SQLSTATE 42P01（relation does not exist）なら「テーブルが無い」
export async function isMissingTable(response) {
  if (!response || response.ok) return false;
  if (response.status === 404) return true;
  return (await errorCode(response)) === "42P01";
}

function parseContentRange(value) {
  const match = /^(\d+)-(\d+)\/(\d+|\*)$/.exec(String(value || "").trim());
  if (!match) return null;
  return { from: Number(match[1]), to: Number(match[2]), total: match[3] === "*" ? null : Number(match[3]) };
}

async function readRows(response, label) {
  if (!response.ok) {
    if (await isMissingTable(response)) throw new MissingTableError(label);
    throw new UpstreamError(label, response.status, await errorCode(response));
  }
  const rows = await response.json();
  return Array.isArray(rows) ? rows : [];
}

// Range ヘッダで PAGE_SIZE 行ずつ全件を辿る。GET のテーブルにも POST の RPC にも使う。
// 止める条件: 416 / 空ページ / Content-Range の total に達した / 1 ページが PAGE_SIZE 未満
function pageDone(response, batch) {
  if (batch.length === 0) return true;
  const range = parseContentRange(response.headers?.get?.("content-range"));
  if (range && range.total !== null && range.to + 1 >= range.total) return true;
  return batch.length < PAGE_SIZE;
}

async function pagedRows(label, path, init = {}, from = 0) {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await serviceFetch(path, {
      ...init,
      headers: { ...(init.headers || {}), Range: `${from}-${from + PAGE_SIZE - 1}`, "Range-Unit": "items" }
    });
    if (response.status === 416) break; // 範囲外 = もう無い
    const batch = await readRows(response, label);
    for (const row of batch) rows.push(row);
    if (pageDone(response, batch)) break;
    from += batch.length;
  }
  return rows;
}

// テーブルを全件（limit を付けない問い合わせに使う）
export function restAll(table, query) {
  return pagedRows(table, `/rest/v1/${table}?${query}`);
}

// limit 付きの小さな問い合わせ（1 回で済むので Range は付けない）
export async function restGet(table, query) {
  const response = await serviceFetch(`/rest/v1/${table}?${query}`);
  return readRows(response, table);
}

// 無いかもしれないテーブル → { rows, missing }
export async function restOptional(table, query, { all = true } = {}) {
  try {
    const rows = all ? await restAll(table, query) : await restGet(table, query);
    return { rows, missing: false };
  } catch (error) {
    if (error instanceof MissingTableError) return { rows: [], missing: true };
    throw error;
  }
}

// RPC（set を返す関数）。存在しなければ null（404 = PGRST202 など）。他の失敗も警告だけ出して null にし、REST 集計へ倒す。
// 1 ページ目で有無を確かめ、続きがあれば同じ Range の辿り方で取る。
export async function rpcAllOrNull(name, args) {
  const path = `/rest/v1/rpc/${name}`;
  const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args || {}) };
  const probe = await serviceFetch(path, {
    ...init,
    headers: { ...init.headers, Range: `0-${PAGE_SIZE - 1}`, "Range-Unit": "items" }
  });
  if (probe.status === 404) return null;
  if (!probe.ok) {
    const code = await errorCode(probe);
    console.warn(`admin/rpc ${name}: ${probe.status}${code ? ` ${code}` : ""} (fallback to REST)`);
    return null;
  }
  const first = await probe.json();
  const rows = Array.isArray(first) ? first.slice() : [];
  if (pageDone(probe, rows)) return rows;
  return rows.concat(await pagedRows(name, path, init, rows.length));
}

// ----- Supabase Auth（admin API） -----

export async function listAuthUsers() {
  const users = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await serviceFetch(`/auth/v1/admin/users?page=${page}&per_page=${PAGE_SIZE}`);
    if (!response.ok) throw new UpstreamError("auth_users", response.status, await errorCode(response));
    const body = await response.json();
    const batch = Array.isArray(body?.users) ? body.users : [];
    if (batch.length === 0) break;
    for (const user of batch) users.push(user);
    const total = Number(response.headers?.get?.("x-total-count"));
    if (Number.isFinite(total) && total > 0 && users.length >= total) break;
    if (batch.length < PAGE_SIZE) break;
  }
  return users;
}

export async function getAuthUser(userId) {
  const response = await serviceFetch(`/auth/v1/admin/users/${encodeURIComponent(userId)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new UpstreamError("auth_user", response.status, await errorCode(response));
  const user = await response.json();
  return user?.id ? user : null;
}

// ----- 小物 -----

// 全部待ってから、失敗があれば最初の 1 つを投げる（Promise.all と違い、未処理の reject を残さない）
export async function allOrThrow(promises) {
  const results = await Promise.allSettled(promises);
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  return results.map((result) => result.value);
}

export function queryParam(req, name) {
  const direct = req.query?.[name];
  if (typeof direct === "string") return direct;
  if (Array.isArray(direct)) return direct[0];
  try {
    return new URL(String(req.url || ""), "http://localhost").searchParams.get(name);
  } catch {
    return null;
  }
}

export function sortTexts(values) {
  return values.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
