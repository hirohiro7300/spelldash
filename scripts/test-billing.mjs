// 課金のサーバー側の単体（Batch 83。api/_lib/billing.js・api/billing/{checkout,config,portal,webhook}.js・api/_lib/aiLimits.js）:
//   署名の確かめ（正しい・違う鍵・本文の書き換え・v1 が複数・300 秒の外・設定した鍵で確かめる・鍵の入れ替え）・webhook のイベントの書き込み（加入の完了・契約の作成／更新／解約、
//   人は client_reference_id か metadata、知らない人は書かない、表が無いときの応答）・最初の行は「入れるだけ」で、同時に届いても新しいイベントが残る・
//   生ボディの読み方（流れだけ・文字列・Buffer・読むと流れを使い切る body・rawBody を先に・解析済みの値しか無いときは作り直さない・
//   配信の補助が先に読み切って req.on を写しに付け替えた形〔本番の既定〕・写しが終わらなくても待ち続けない）・
//   加入の守り（受付前・ログイン・二重加入・無料期間は初めての人だけ・確定の画面の文〔提供の時期も〕）・お支払いの管理の守り・Pro の判定と無料期間の終わり・
//   受付前の config・比較表の AI の回数（サーバーの値と同じ）・ログに鍵とメールと顧客の番号を書かない。
//   Batch 94（7d）: 受付中は 4 つの変数がそろってから（config・加入の口・AI の「Pro なら…」）・加入の表が無ければ加入の口は 503（決済の会社へ出ない）。
//   Batch 94（7e）: 本人確認を確かめられない（4 秒で打ち切り・通信の失敗・5xx）と、加入の口とお支払いの管理の口は 502 auth_unavailable（401 は鍵が違うときだけ）。
// ネットワークには出ない: fetch を差し替え、決済の会社の API とデータベース（認証と REST）を偽物で答える。鍵は偽の値（本物の鍵の形にしない）。
// 使い方: node scripts/test-billing.mjs [--root <木>]
//   --root は別の木（例: 直す前の main を git archive した所。api/ と package.json があればよい）の api/ に同じ検査を流す（直す前に落ちることを確かめる）
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootArg = process.argv.indexOf("--root");
const ROOT = rootArg > 0 ? path.resolve(process.argv[rootArg + 1]) : path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
let failed = 0;
const out = (line) => process.stdout.write(`${line}\n`);
function ok(name, cond, detail = "") {
  if (cond) passed++;
  else {
    failed++;
    out(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);

// ===== 環境（偽の値） =====
const DB = "https://db.test";
const ENV = {
  STRIPE_SECRET_KEY: "test-secret-key",
  STRIPE_PRICE_MONTHLY: "price_month_test",
  STRIPE_WEBHOOK_SECRET: "test-signing-secret",
  STRIPE_TRIAL_MONTHS: "1",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
  SITE_ORIGIN: "https://site.test"
};
const ENV_NAMES = [...Object.keys(ENV), "STRIPE_PRICE_YEARLY", "STRIPE_TRIAL_DAYS", "ANTHROPIC_API_KEY", "EXPLAIN_WORD_DAILY_LIMIT", "EXPLAIN_WORD_DAILY_LIMIT_PRO"];
function setEnv(over = {}) {
  for (const name of ENV_NAMES) delete process.env[name];
  Object.assign(process.env, ENV);
  for (const [name, value] of Object.entries(over)) {
    if (value === null) delete process.env[name];
    else process.env[name] = value;
  }
}
process.env.SUPABASE_URL = DB; // api/_lib/shared.js は読み込みの時に読む
process.env.SUPABASE_ANON_KEY = "test-anon-key";
setEnv();

const load = async (rel) => {
  try {
    return await import(pathToFileURL(path.join(ROOT, rel)).href);
  } catch (error) {
    return { loadError: String(error?.message || error) };
  }
};
const lib = await load("api/_lib/billing.js");
const webhook = (await load("api/billing/webhook.js")).default;
const checkout = (await load("api/billing/checkout.js")).default;
const portal = (await load("api/billing/portal.js")).default;
const config = (await load("api/billing/config.js")).default;
const ai = await load("api/_lib/aiLimits.js");
if (lib.loadError || !webhook || !checkout || !portal || !config) {
  out(`api の読み込みに失敗: ${lib.loadError ?? "handler が無い"}`);
  process.exit(1);
}

// ===== 偽の相手（fetch の差し替え） =====
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const U3 = "33333333-3333-4333-8333-333333333333";
const USERS = { "tok-u1": { id: U1, email: "u1@example.com" }, "tok-u2": { id: U2, email: "u2@example.com" }, "tok-u3": { id: U3, email: "" } };

let calls = []; // 全部の要求（相手・メソッド・パス・問い合わせ・頭・本文）
let unexpected = []; // 偽物が知らない要求（検査の外へ出ようとした）
const P = { subs: new Map(), search: [], list: [], prices: new Map(), fail: new Set(), customers: [], sessions: [], idem: new Map(), seq: 0 }; // 決済の会社
// customers: 顧客（{ id, email, metadata, searchable }。作ったばかりの顧客は検索に出ない〔決済の会社の検索は遅れて出る〕）・sessions: 手続き（{ id, url, customer, status, expires_at }）・
// idem: 冪等キー → 最初の要求の本文と答え（同じキーで同じ本文なら同じ答え・違う本文なら 400 idempotency_error。決済の会社と同じ）
const D = { rows: new Map(), missing: false, readGate: null, writeGate: null }; // データベース（subscriptions）
// 本人確認（/auth/v1/user）の答え方（Batch 94 の 7e）: null は今どおり（トークンで答える）。"timeout"・"network" はその例外を投げる。
// "hang" は答えない（要求の打ち切りの合図で切れる。合図が無い要求は検査が止まらないよう 1 秒で偽物の側から切る）。数ならその番号で答える
const AUTH = { mode: null };

function fresh() {
  calls = [];
  unexpected = [];
  P.subs.clear();
  P.search = [];
  P.list = [];
  P.fail.clear();
  P.customers = [];
  P.sessions = [];
  P.idem.clear();
  P.seq = 0;
  lib.billingRateReset?.(); // 1 人 1 分の回数（Batch 88）を検査ごとに空に（前の形には無い）
  P.prices = new Map([["price_month_test", { id: "price_month_test", unit_amount: 980, currency: "jpy", recurring: { interval: "month" } }], ["price_year_test", { id: "price_year_test", unit_amount: 9800, currency: "jpy", recurring: { interval: "year" } }]]);
  D.rows.clear();
  D.missing = false;
  D.readGate = null;
  D.writeGate = null;
  AUTH.mode = null;
}

const json =(status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const lower = (headers) => Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
const clone = (value) => JSON.parse(JSON.stringify(value));
const ROW_DEFAULTS = { stripe_customer_id: null, stripe_subscription_id: null, status: "none", price_id: null, plan_interval: null, current_period_end: null, cancel_at_period_end: false, event_created: 0 };

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const call = { origin: u.origin, method: String(init.method || "GET").toUpperCase(), path: u.pathname, params: u.searchParams, headers: lower(init.headers), body: typeof init.body === "string" ? init.body : "", signal: init.signal ?? null };
  calls.push(call);
  if (u.origin === DB) return dbRoute(call);
  return providerRoute(call);
};

// ---- データベース: 認証（/auth/v1/user）と REST（/rest/v1/subscriptions） ----
async function dbRoute(call) {
  if (call.path === "/auth/v1/user") {
    if (AUTH.mode === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (AUTH.mode === "network") throw new TypeError("fetch failed");
    if (AUTH.mode === "hang") {
      return new Promise((_resolve, reject) => {
        if (call.signal) call.signal.addEventListener("abort", () => reject(call.signal.reason), { once: true });
        else setTimeout(() => reject(new Error("no abort signal on the request")), 1000);
      });
    }
    if (typeof AUTH.mode === "number") return json(AUTH.mode, { msg: "auth trouble" });
    const token = String(call.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const user = USERS[token];
    return user ? json(200, { id: user.id, email: user.email, email_confirmed_at: "2026-01-01T00:00:00Z" }) : json(401, { msg: "invalid token" });
  }
  // AI の回数の関数（Batch 94 の 7d で AI の「Pro なら…」を見る）: 関数がまだ無い形で答える（api/_lib/shared.js はインスタンスのメモリーで数える）
  if (call.path === "/rest/v1/rpc/ai_take") return json(404, { code: "PGRST202", message: "Could not find the function" });
  if (call.path !== "/rest/v1/subscriptions") {
    unexpected.push(`${call.method} ${call.path}`);
    return json(404, { code: "PGRST205" });
  }
  if (D.missing) return json(404, { code: "PGRST205", message: "Could not find the table" });
  const service = call.headers.apikey === ENV.SUPABASE_SERVICE_ROLE_KEY;
  if (call.method === "GET") {
    if (service && D.readGate) await D.readGate();
    const byUser = call.params.get("user_id");
    const byCustomer = call.params.get("stripe_customer_id");
    let rows = [...D.rows.values()];
    if (byUser) rows = rows.filter((r) => r.user_id === byUser.replace(/^eq\./, ""));
    if (byCustomer) rows = rows.filter((r) => r.stripe_customer_id === byCustomer.replace(/^eq\./, ""));
    if (!service) {
      // 本人のトークン（RLS）: 本人の行だけ
      const token = String(call.headers.authorization || "").replace(/^Bearer\s+/i, "");
      rows = rows.filter((r) => r.user_id === USERS[token]?.id);
    }
    return json(200, clone(rows.slice(0, Number(call.params.get("limit")) || rows.length)));
  }
  if (!service) return json(403, { code: "42501" }); // 本人は書けない
  const write = () => applyWrite(call);
  return D.writeGate ? D.writeGate(call, write) : write();
}

function applyWrite(call) {
  const body = JSON.parse(call.body || "{}");
  const prefer = call.headers.prefer || "";
  if (call.method === "POST") {
    const existing = D.rows.get(body.user_id);
    if (existing) {
      if (prefer.includes("resolution=ignore-duplicates")) return json(201, []);
      if (prefer.includes("resolution=merge-duplicates")) {
        const row = { ...existing, ...body };
        D.rows.set(body.user_id, row);
        return json(201, [clone(row)]);
      }
      return json(409, { code: "23505" });
    }
    const row = { ...ROW_DEFAULTS, ...body };
    D.rows.set(body.user_id, row);
    return json(201, [clone(row)]);
  }
  if (call.method === "PATCH") {
    const user = String(call.params.get("user_id") || "").replace(/^eq\./, "");
    const lte = call.params.get("event_created");
    const row = D.rows.get(user);
    if (!row || (lte !== null && !(Number(row.event_created) <= Number(lte.replace(/^lte\./, ""))))) return json(200, []);
    const next = { ...row, ...body };
    D.rows.set(user, next);
    return json(200, [clone(next)]);
  }
  unexpected.push(`${call.method} subscriptions`);
  return json(405, {});
}

// ---- 決済の会社（/v1/...）: 本文は form（a[b][c]）。読んだ形を call.form に残す ----
function providerRoute(call) {
  call.form = call.method === "GET" ? call.params : new URLSearchParams(call.body);
  const fail = (name) => P.fail.has(name);
  const p = call.path;
  // 冪等キー: 同じキーで同じ本文なら最初の答えを返す・違う本文なら 400（決済の会社と同じ。分の頭から作る値がずれると、ここで落ちる）
  // make は答えの値を返す（200 で返し、冪等キーがあれば本文と答えを覚える）
  const replay = (make) => {
    const key = call.headers["idempotency-key"];
    const seen = key ? P.idem.get(key) : null;
    if (seen) return seen.body === call.body ? json(200, clone(seen.answer)) : json(400, { error: { type: "idempotency_error" } });
    const answer = make();
    if (key) P.idem.set(key, { body: call.body, answer: clone(answer) });
    return json(200, clone(answer));
  };
  if (call.method === "GET" && p === "/v1/subscriptions/search") return fail("search") ? json(500, { error: { type: "api_error" } }) : json(200, { data: clone(P.search) });
  // 顧客の契約の一覧（customer があれば、その顧客の契約だけ。customer の無い項目はどの顧客にも出す: 前からの検査の形）
  if (call.method === "GET" && p === "/v1/subscriptions") {
    if (fail("list")) return json(500, { error: { type: "api_error" } });
    // 顧客を消した後の一覧（「その顧客は無い」の 4xx）と、つながらない一覧（fetch が投げる）
    if (fail("list_missing")) return json(404, { error: { type: "invalid_request_error", code: "resource_missing" } });
    if (fail("list_network")) throw new TypeError("fetch failed");
    const customer = call.params.get("customer");
    return json(200, { data: clone(P.list.filter((s) => !customer || !s.customer || s.customer === customer)) });
  }
  // 顧客: 検索（metadata['user_id']:'<uuid>'。作ったばかりの顧客は出ない）と作成（冪等キーで同じ顧客）
  if (call.method === "GET" && p === "/v1/customers/search") {
    if (fail("customer_search")) return json(500, { error: { type: "api_error" } });
    const user = (call.params.get("query") || "").match(/^metadata\['user_id'\]:'([0-9a-f-]{36})'$/)?.[1] ?? null;
    return json(200, { data: clone(P.customers.filter((c) => c.searchable && user && c.metadata?.user_id === user)) });
  }
  if (call.method === "POST" && p === "/v1/customers") {
    if (fail("customer_create")) return json(500, { error: { type: "api_error" } });
    return replay(() => {
      const customer = { id: `cus_new_${++P.seq}`, email: call.form.get("email") || null, metadata: { user_id: call.form.get("metadata[user_id]") || null }, searchable: false };
      P.customers.push(customer);
      return customer;
    });
  }
  // 顧客のメールを書き直す（作った後に書く。Batch 88 の反証）
  const custUpdate = call.method === "POST" && p.match(/^\/v1\/customers\/([^/]+)$/);
  if (custUpdate) {
    if (fail("customer_update")) return json(500, { error: { type: "api_error" } });
    const customer = P.customers.find((c) => c.id === decodeURIComponent(custUpdate[1]));
    if (!customer) return json(404, { error: { type: "invalid_request_error", code: "resource_missing" } });
    if (call.form.has("email")) customer.email = call.form.get("email");
    return json(200, clone(customer));
  }
  // 手続き: 一覧（customer・status）と期限切れにする
  if (call.method === "GET" && p === "/v1/checkout/sessions") {
    if (fail("session_list")) return json(500, { error: { type: "api_error" } });
    const customer = call.params.get("customer");
    const status = call.params.get("status");
    return json(200, { data: clone(P.sessions.filter((x) => (!customer || x.customer === customer) && (!status || x.status === status))) });
  }
  const expire = call.method === "POST" && p.match(/^\/v1\/checkout\/sessions\/([^/]+)\/expire$/);
  if (expire) {
    const session = P.sessions.find((x) => x.id === decodeURIComponent(expire[1]));
    if (fail("expire") || !session || session.status !== "open") return json(400, { error: { type: "invalid_request_error" } });
    session.status = "expired";
    return json(200, clone(session));
  }
  if (call.method === "GET" && p.startsWith("/v1/subscriptions/")) {
    const sub = P.subs.get(decodeURIComponent(p.slice("/v1/subscriptions/".length)));
    return fail("subscription") || !sub ? json(404, { error: { type: "invalid_request_error" } }) : json(200, clone(sub));
  }
  if (call.method === "GET" && p.startsWith("/v1/prices/")) {
    const price = P.prices.get(decodeURIComponent(p.slice("/v1/prices/".length)));
    return fail("price") || !price ? json(404, { error: { type: "invalid_request_error" } }) : json(200, clone(price));
  }
  if (call.method === "POST" && p === "/v1/checkout/sessions") {
    if (fail("checkout")) return json(500, { error: { type: "api_error" } });
    return replay(() => {
      const n = P.sessions.length + 1;
      const session = { id: `cs_test_${n}`, url: `https://pay.test/checkout/${n}`, customer: call.form.get("customer") || null, status: "open", expires_at: Number(call.form.get("expires_at")) || null };
      P.sessions.push(session);
      return session;
    });
  }
  if (call.method === "POST" && p === "/v1/billing_portal/sessions") return json(200, { url: "https://pay.test/portal/1" });
  unexpected.push(`${call.method} ${p}`);
  return json(404, { error: { type: "invalid_request_error" } });
}

const providerCalls = (method, p) => calls.filter((c) => c.origin !== DB && c.method === method && c.path === p);
const writes = () => calls.filter((c) => c.origin === DB && (c.method === "POST" || c.method === "PATCH"));

// ===== 応答と呼び方 =====
function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: undefined };
  res.setHeader = (name, value) => {
    res.headers[name.toLowerCase()] = value;
  };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  res.end = () => res;
  return res;
}

// 調べる側のログ（billing/<label>: …）は全部ここに取る（同時に 2 つ呼んでも混ざらないよう、最初に 1 度だけ差し替える。検査の結果は out で書く）
const logs = [];
const keep = (...args) => logs.push(args.map(String).join(" "));
Object.assign(console, { log: keep, error: keep, warn: keep });
async function invoke(handler, req) {
  const res = fakeRes();
  await handler(req, res);
  return res;
}

const post = (body, token = "") => ({ method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body });

// ===== webhook の要求の形 =====
const nowSec = () => Math.floor(Date.now() / 1000);
function sign(body, { secret = ENV.STRIPE_WEBHOOK_SECRET, t = nowSec() } = {}) {
  return `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}
const hookHeaders = (raw, opts) => ({ "content-type": "application/json; charset=utf-8", "stripe-signature": sign(raw, opts) });
// 流れ（IncomingMessage と同じ読み方）。中身は最初から内側の置き場にある
function streamReq(raw, headers) {
  const stream = new Readable({ read() {} });
  stream.push(Buffer.from(raw, "utf8"));
  stream.push(null);
  return Object.assign(stream, { method: "POST", headers });
}
// 配信の側が先に読み切った流れ（中身は残らない）
async function drainedReq(raw, headers) {
  const stream = streamReq(raw, headers);
  for await (const _chunk of stream); // 読み切る（中身は捨てる）
  return stream;
}
// body を読むと流れを使い切る（その場で中身を読んで解析した値を返す）。先に body を見ると、流れからはもう読めない
function consumingReq(raw, headers) {
  const stream = streamReq(raw, headers);
  Object.defineProperty(stream, "body", {
    configurable: true,
    get() {
      const chunk = stream.read();
      return chunk ? JSON.parse(chunk.toString("utf8")) : undefined;
    }
  });
  return stream;
}
// 配信の側のサーバーの関数の補助（既定で入る）の形（Batch 83 の反証。公開されている実行環境の版で確かめた形を自分で組み直したもの）:
// 関数を呼ぶ前に流れを最後まで読み（元の流れは readableEnded）、読み切ったバイト列の写しを持つ流れへ req.on('data'/'end')・req.addListener・req.read を
// 付け替える（自分の持ち物として上書き）。req.body は読んだ時に JSON にする。rawBody は置かない。bodyParser: false の指定は読まない
async function platformReq(raw, headers, { endCopy = true } = {}) {
  const stream = streamReq(raw, headers);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  const copy = new PassThrough();
  const ownOn = stream.on.bind(stream);
  const copyOn = copy.on.bind(copy);
  stream.read = copy.read.bind(copy);
  stream.on = stream.addListener = (name, listener) => (name === "data" || name === "end" ? copyOn(name, listener) : ownOn(name, listener));
  if (endCopy) copy.end(bytes);
  else copy.write(bytes); // 写しが終わらない（守りの検査: 待ち続けない）
  let parsed;
  Object.defineProperty(stream, "body", {
    configurable: true,
    enumerable: true,
    get() {
      parsed ??= JSON.parse(bytes.toString("utf8"));
      return parsed;
    }
  });
  return stream;
}
// 流れは読み切られ、生の値 rawBody はあるが、body を読むと例外（解析の失敗）。body を読んだ回数を数える
async function rawBodyFirstReq(raw, headers) {
  const stream = await drainedReq(raw, headers);
  let reads = 0;
  Object.defineProperty(stream, "body", {
    configurable: true,
    get() {
      reads++;
      throw new Error("Invalid JSON");
    }
  });
  return Object.assign(stream, { rawBody: Buffer.from(raw, "utf8"), bodyReads: () => reads });
}

const subOf = (over = {}) => ({
  id: "sub_test_1",
  object: "subscription",
  customer: "cus_test_1",
  status: "active",
  cancel_at_period_end: false,
  metadata: { user_id: U1 },
  items: { data: [{ price: { id: "price_month_test", recurring: { interval: "month" } }, current_period_end: 1767225600 }] },
  ...over
});
const eventOf = (type, object, created) => ({ id: `evt_${created}`, object: "event", type, created, data: { object } });
const hook = async (event, makeReq = streamReq, opts) => {
  const raw = JSON.stringify(event);
  return invoke(webhook, await makeReq(raw, hookHeaders(raw, opts)));
};

// ===== 1. 署名（verifyStripeSignature） =====
{
  const v = lib.verifyStripeSignature;
  const raw = JSON.stringify({ id: "evt_sig", type: "ping" });
  const t = 1_800_000_000;
  const good = (body = raw, secret = ENV.STRIPE_WEBHOOK_SECRET, at = t) => crypto.createHmac("sha256", secret).update(`${at}.${body}`).digest("hex");
  ok("署名: 正しい鍵と本文なら通る", v(raw, `t=${t},v1=${good()}`, ENV.STRIPE_WEBHOOK_SECRET, t) === true);
  ok("署名: 本文が Buffer でも同じ（バイト列で計算）", v(Buffer.from(raw), `t=${t},v1=${good()}`, ENV.STRIPE_WEBHOOK_SECRET, t) === true);
  ok("署名: 違う鍵で作った署名は通らない", v(raw, `t=${t},v1=${good(raw, "other-secret")}`, ENV.STRIPE_WEBHOOK_SECRET, t) === false);
  ok("署名: 本文を 1 字でも書き換えると通らない", v(raw.replace("ping", "pong"), `t=${t},v1=${good()}`, ENV.STRIPE_WEBHOOK_SECRET, t) === false);
  ok("署名: v1 が複数（鍵の入れ替えの途中）なら、どれか 1 つが合えば通る", v(raw, `t=${t},v1=${"0".repeat(64)},v1=${good()}`, ENV.STRIPE_WEBHOOK_SECRET, t) === true);
  ok("署名: v1 が全部違えば通らない・v0 は見ない", v(raw, `t=${t},v1=${"0".repeat(64)},v0=${good()}`, ENV.STRIPE_WEBHOOK_SECRET, t) === false);
  ok("署名: 時刻が 300 秒ちょうど前・後なら通る", v(raw, `t=${t},v1=${good()}`, ENV.STRIPE_WEBHOOK_SECRET, t + 300) === true && v(raw, `t=${t},v1=${good()}`, ENV.STRIPE_WEBHOOK_SECRET, t - 300) === true);
  ok("署名: 300 秒より古い・新しい時刻は通らない（同じ署名の使い回しを止める）", v(raw, `t=${t},v1=${good()}`, ENV.STRIPE_WEBHOOK_SECRET, t + 301) === false && v(raw, `t=${t},v1=${good()}`, ENV.STRIPE_WEBHOOK_SECRET, t - 301) === false);
  ok("署名: t が無い・v1 が無い・形が違う・鍵が空なら通らない",
    [`v1=${good()}`, `t=${t}`, "garbage", ""].every((h) => v(raw, h, ENV.STRIPE_WEBHOOK_SECRET, t) === false) && v(raw, `t=${t},v1=${good()}`, "", t) === false && v(raw, undefined, ENV.STRIPE_WEBHOOK_SECRET, t) === false);
  ok("署名: 長さの違う v1 は比べずに外す（例外を出さない）", v(raw, `t=${t},v1=abc`, ENV.STRIPE_WEBHOOK_SECRET, t) === false);
  // 確かめに使うのは渡された（設定した）鍵だけ: 同じ署名でも設定した鍵が違えば通らず、別の鍵で作った署名はその鍵を設定すれば通る
  // （ほかの検査はどれも同じ鍵を設定するので、決まった字の鍵で計算する作りでも通ってしまう。Batch 83 の反証）
  ok("署名: 設定した鍵で確かめる（同じ署名でも設定した鍵が違えば通らない・別の鍵で作った署名はその鍵を設定すれば通る）",
    v(raw, `t=${t},v1=${good()}`, "another-configured-secret", t) === false && v(raw, `t=${t},v1=${good(raw, "another-configured-secret")}`, "another-configured-secret", t) === true);
}

// ===== 2. webhook: 受け付けの前の守り =====
{
  fresh();
  setEnv();
  const event = eventOf("customer.subscription.created", subOf(), nowSec());
  const raw = JSON.stringify(event);
  let res = await invoke(webhook, { method: "GET", headers: {} });
  ok("webhook: POST 以外は 405", res.statusCode === 405 && res.headers.allow === "POST", JSON.stringify(res));
  setEnv({ STRIPE_WEBHOOK_SECRET: null });
  res = await invoke(webhook, streamReq(raw, hookHeaders(raw)));
  ok("webhook: 署名の鍵が無い（受付前）は 503 not_configured・何も読まない", res.statusCode === 503 && res.body?.error === "not_configured" && calls.length === 0, JSON.stringify(res.body));
  setEnv({ SUPABASE_SERVICE_ROLE_KEY: null });
  res = await invoke(webhook, streamReq(raw, hookHeaders(raw)));
  ok("webhook: service role の鍵が無いと 503", res.statusCode === 503, String(res.statusCode));
  setEnv();
  res = await invoke(webhook, streamReq(raw, { "content-type": "application/json" }));
  ok("webhook: 署名の頭が無いと 400 bad_signature・書かない", res.statusCode === 400 && res.body?.error === "bad_signature" && writes().length === 0, JSON.stringify(res.body));
  res = await invoke(webhook, streamReq(raw, hookHeaders(raw, { secret: "other-secret" })));
  ok("webhook: 違う鍵の署名は 400 bad_signature・書かない", res.statusCode === 400 && res.body?.error === "bad_signature" && writes().length === 0);
  res = await invoke(webhook, streamReq(raw.replace("active", "canceled"), hookHeaders(raw)));
  ok("webhook: 書き換えた本文は 400 bad_signature・書かない", res.statusCode === 400 && writes().length === 0);
  res = await invoke(webhook, streamReq(raw, hookHeaders(raw, { t: nowSec() - 400 })));
  ok("webhook: 400 秒前の署名は 400（300 秒の外）", res.statusCode === 400 && writes().length === 0);
  const broken = "{not json";
  res = await invoke(webhook, streamReq(broken, hookHeaders(broken)));
  ok("webhook: 署名は合うが JSON でない本文は 400 bad_request", res.statusCode === 400 && res.body?.error === "bad_request", JSON.stringify(res.body));
  // 署名の鍵を入れ替えた（STRIPE_WEBHOOK_SECRET を変えて Redeploy）: 前の鍵の署名は断り、新しい鍵の署名は通す
  fresh();
  setEnv({ STRIPE_WEBHOOK_SECRET: "rotated-secret" });
  res = await invoke(webhook, streamReq(raw, hookHeaders(raw)));
  const oldRefused = res.statusCode === 400 && res.body?.error === "bad_signature" && writes().length === 0;
  res = await invoke(webhook, streamReq(raw, hookHeaders(raw, { secret: "rotated-secret" })));
  ok("webhook: 署名の鍵を入れ替えると、前の鍵の署名は 400 bad_signature（書かない）・新しい鍵の署名は 200（設定した鍵で確かめる）", oldRefused && res.statusCode === 200 && D.rows.has(U1), JSON.stringify({ oldRefused, status: res.statusCode }));
  setEnv();
}

// ===== 3. webhook: イベントごとの書き込み =====
{
  // 加入の完了（mode=subscription・人は client_reference_id）→ 契約を取り直して 1 行
  fresh();
  setEnv();
  P.subs.set("sub_test_1", subOf({ status: "trialing" }));
  const created = nowSec();
  let res = await hook(eventOf("checkout.session.completed", { object: "checkout.session", mode: "subscription", client_reference_id: U1, subscription: "sub_test_1", customer: "cus_test_1" }, created));
  const row = D.rows.get(U1);
  ok("webhook: 加入の完了は 200 で、契約を取り直して本人の行を書く（状態・顧客・契約・Price・月・期限・解約予定・イベントの時刻）",
    res.statusCode === 200 && res.body?.received === true && providerCalls("GET", "/v1/subscriptions/sub_test_1").length === 1 &&
      row?.status === "trialing" && row.stripe_customer_id === "cus_test_1" && row.stripe_subscription_id === "sub_test_1" && row.price_id === "price_month_test" &&
      row.plan_interval === "month" && row.current_period_end === "2026-01-01T00:00:00.000Z" && row.cancel_at_period_end === false && row.event_created === created,
    JSON.stringify({ status: res.statusCode, row }));

  // 人は metadata.user_id でもよい
  fresh();
  P.subs.set("sub_test_1", subOf());
  res = await hook(eventOf("checkout.session.completed", { object: "checkout.session", mode: "subscription", client_reference_id: null, metadata: { user_id: U2 }, subscription: { id: "sub_test_1" } }, created));
  ok("webhook: 加入の完了の人は metadata.user_id からも取る（subscription が形でも id でもよい）", res.statusCode === 200 && D.rows.get(U2)?.status === "active", JSON.stringify([...D.rows.keys()]));

  // 一度きりの支払い（mode=payment）・人が分からない加入の完了は書かない
  fresh();
  res = await hook(eventOf("checkout.session.completed", { object: "checkout.session", mode: "payment", client_reference_id: U1 }, created));
  const payment = res.statusCode === 200 && writes().length === 0;
  res = await hook(eventOf("checkout.session.completed", { object: "checkout.session", mode: "subscription", client_reference_id: "not-a-uuid", subscription: "sub_test_1" }, created));
  ok("webhook: mode=payment と人の分からない加入の完了は 200 で何も書かない（決済の会社にも聞かない）", payment && res.statusCode === 200 && writes().length === 0 && providerCalls("GET", "/v1/subscriptions/sub_test_1").length === 0);

  // 契約の作成（metadata.user_id）→ 1 行
  fresh();
  res = await hook(eventOf("customer.subscription.created", subOf({ metadata: { user_id: U1 } }), created));
  ok("webhook: 契約の作成は metadata.user_id の人の行を書く", res.statusCode === 200 && D.rows.get(U1)?.event_created === created && D.rows.get(U1)?.stripe_subscription_id === "sub_test_1");

  // 最初の行は「入れるだけ」（同じ人の行がもうあれば上書きしない）
  const first = writes()[0];
  ok("webhook: 本人の行が無いときの最初の書き込みは「入れるだけ」（resolution=ignore-duplicates。merge-duplicates の上書きをしない）",
    first?.method === "POST" && /resolution=ignore-duplicates/.test(first.headers.prefer || "") && !/merge-duplicates/.test(first.headers.prefer || "") && first.params.get("on_conflict") === "user_id",
    JSON.stringify({ method: first?.method, prefer: first?.headers.prefer }));
  ok("webhook: 書き込みは service role の鍵で（本人のトークンでは書かない）", writes().every((c) => c.headers.apikey === ENV.SUPABASE_SERVICE_ROLE_KEY));

  // 契約の更新（metadata が無い・顧客の番号で前の行を引く）→ イベントの時刻を条件にした書き換え
  D.rows.set(U1, { ...D.rows.get(U1), event_created: created - 10 });
  calls = [];
  res = await hook(eventOf("customer.subscription.updated", subOf({ metadata: {}, cancel_at_period_end: true }), created + 5));
  const patch = writes()[0];
  ok("webhook: 契約の更新は、metadata が無ければ顧客の番号で前の行を引き、event_created が新しくないときだけ書き換える（PATCH の条件 lte）",
    res.statusCode === 200 && patch?.method === "PATCH" && patch.params.get("event_created") === `lte.${created + 5}` && D.rows.get(U1)?.cancel_at_period_end === true && D.rows.get(U1)?.event_created === created + 5,
    JSON.stringify({ status: res.statusCode, patch: patch && `${patch.method} ${patch.params}`, row: D.rows.get(U1) }));

  // 古いイベント（前の行より古い）は捨てる
  calls = [];
  res = await hook(eventOf("customer.subscription.updated", subOf({ status: "past_due" }), created - 100));
  ok("webhook: 前の行より古いイベントは 200 で書かない（逆順の到着）", res.statusCode === 200 && writes().length === 0 && D.rows.get(U1)?.status === "active", JSON.stringify(D.rows.get(U1)));

  // 解約（deleted）→ canceled
  calls = [];
  res = await hook(eventOf("customer.subscription.deleted", subOf({ status: "canceled" }), created + 50));
  ok("webhook: 契約の終わり（deleted）は status=canceled を書く（行は残す）", res.statusCode === 200 && D.rows.get(U1)?.status === "canceled" && D.rows.get(U1)?.event_created === created + 50);

  // 知らない人（metadata なし・顧客の番号も知らない）
  calls = [];
  res = await hook(eventOf("customer.subscription.updated", subOf({ metadata: {}, customer: "cus_unknown" }), created + 60));
  ok("webhook: 知らない人の契約（metadata なし・顧客の番号の行なし）は 200 で書かない", res.statusCode === 200 && writes().length === 0 && logs.some((l) => l.includes("no user for customer")));

  // 扱わないイベント
  calls = [];
  res = await hook(eventOf("invoice.paid", { object: "invoice" }, created));
  ok("webhook: 扱わないイベントは 200 で何もしない", res.statusCode === 200 && calls.length === 0);

  // 表が無い（docs/SQL_BILLING.md の前）→ 500（再送させる）
  fresh();
  D.missing = true;
  logs.length = 0;
  res = await hook(eventOf("customer.subscription.created", subOf(), created));
  ok("webhook: subscriptions の表が無いと 500 upstream「保存できませんでした。」・ログに subscriptions table missing", res.statusCode === 500 && res.body?.error === "upstream" && res.body?.message === "保存できませんでした。" && logs.some((l) => l.includes("subscriptions table missing")), JSON.stringify({ body: res.body, logs }));

  // 加入の完了で契約を取り直せない → 500
  fresh();
  P.fail.add("subscription");
  res = await hook(eventOf("checkout.session.completed", { object: "checkout.session", mode: "subscription", client_reference_id: U1, subscription: "sub_test_1" }, created));
  ok("webhook: 加入の完了で契約を取り直せないと 500（再送させる）・書かない", res.statusCode === 500 && writes().length === 0);
}

// ===== 4. webhook: 同時に届いた 2 つのイベント（本人の行がまだ無い） =====
// 2 つとも先に「行が無い」を読み、書き込みが新しい方 → 古い方の順で届く。最後に残るのは新しいイベントでなければならない
{
  const barrier = (n) => {
    let waiting = [];
    return () => new Promise((resolve) => {
      waiting.push(resolve);
      if (waiting.length >= n) {
        const go = waiting;
        waiting = [];
        D.readGate = null;
        go.forEach((f) => f());
      }
    });
  };
  const orderWrites = (n, newestFirst) => {
    const pending = [];
    return (call, write) => new Promise((resolve) => {
      pending.push({ call, write, resolve });
      if (pending.length < n) return;
      D.writeGate = null; // 後の書き込みはそのまま
      const created = (p) => Number(JSON.parse(p.call.body || "{}").event_created) || 0;
      pending.sort((a, b) => (newestFirst ? created(b) - created(a) : created(a) - created(b)));
      for (const p of pending) p.resolve(p.write());
    });
  };
  for (const newestFirst of [true, false]) {
    fresh();
    setEnv();
    D.readGate = barrier(2);
    D.writeGate = orderWrites(2, newestFirst);
    const t = nowSec();
    const older = eventOf("customer.subscription.created", subOf({ status: "incomplete" }), t - 30);
    const newer = eventOf("customer.subscription.updated", subOf({ status: "active" }), t - 10);
    const [a, b] = await Promise.all([hook(older), hook(newer)]);
    const row = D.rows.get(U1);
    ok(`webhook: 同時に届いた 2 つのイベントは、書き込みが${newestFirst ? "新しい方から" : "古い方から"}でも新しいイベント（active・event_created ${t - 10}）が残る`,
      a.statusCode === 200 && b.statusCode === 200 && row?.status === "active" && row?.event_created === t - 10,
      JSON.stringify({ row, codes: [a.statusCode, b.statusCode], writes: writes().map((c) => `${c.method} ${c.headers.prefer || ""} ${c.params.get("event_created") || ""}`) }));
  }
}

// ===== 5. 生ボディの読み方（配信の側の作りがどれでも、署名は届いたバイト列で確かめる） =====
{
  const cases = [
    ["流れだけ（body の欄なし）", (raw, h) => streamReq(raw, h), 200],
    ["流れは読み切られ、body が文字列", async (raw, h) => Object.assign(await drainedReq(raw, h), { body: raw }), 200],
    ["流れは読み切られ、body が Buffer", async (raw, h) => Object.assign(await drainedReq(raw, h), { body: Buffer.from(raw) }), 200],
    ["body を読むと流れを使い切る（先に流れを読む）", (raw, h) => consumingReq(raw, h), 200],
    ["流れは読み切られ、rawBody（Buffer）と解析済みの body", async (raw, h) => Object.assign(await drainedReq(raw, h), { rawBody: Buffer.from(raw), body: JSON.parse(raw) }), 200],
    ["流れは読み切られ、解析済みの body しか無い（作り直した JSON では確かめない）", async (raw, h) => Object.assign(await drainedReq(raw, h), { body: JSON.parse(raw) }), 400],
    ["流れでない要求（body が文字列）", (raw, h) => ({ method: "POST", headers: h, body: raw }), 200],
    // Batch 83 の反証（本番の既定の形）: 直す前は流れが読み終わっているので読まず、body は解析済みの値で 400 (no raw body) だった
    ["配信の補助が先に流れを読み切り、req.on('data'/'end') を写しに付け替え・body は読んだ時に解析・rawBody なし", (raw, h) => platformReq(raw, h), 200],
    ["流れは読み切られ、rawBody があり、body を読むと例外（rawBody を先に見る）", (raw, h) => rawBodyFirstReq(raw, h), 200]
  ];
  for (const [label, makeReq, expected] of cases) {
    fresh();
    setEnv();
    const res = await hook(eventOf("customer.subscription.created", subOf(), nowSec()), makeReq);
    const wrote = D.rows.has(U1);
    ok(`生ボディ: ${label} → ${expected}${expected === 200 ? "（行を書く）" : "（書かない）"}`, res.statusCode === expected && wrote === (expected === 200), JSON.stringify({ status: res.statusCode, body: res.body, wrote }));
  }
  // readRawBody そのもの: 読むと流れを使い切る body でも、届いたバイト列をそのまま返す（文字列でも Buffer でもよい）
  fresh();
  const raw = JSON.stringify({ id: "evt_raw", note: "日本語の本文" });
  const text = (value) => (value == null ? null : Buffer.isBuffer(value) ? value.toString("utf8") : typeof value === "string" ? value : null);
  ok("生ボディ: readRawBody は body を見る前に流れを読む（読むと流れを使い切る body でも届いたバイト列）", text(await lib.readRawBody(consumingReq(raw, {}))) === raw);
  ok("生ボディ: readRawBody は流れも生の値も無ければ空にする（解析済みの値から作り直さない）", !text(await lib.readRawBody(Object.assign(await drainedReq(raw, {}), { body: JSON.parse(raw) }))));
  // 配信の補助の形: 元の流れは読み終わっている（readableEnded）が、付け替えた req.on('data'/'end') から届いたバイト列がそのまま読める
  const platform = await platformReq(raw, {});
  const platformEnded = platform.readableEnded === true && Object.hasOwn(platform, "on");
  ok("生ボディ: readRawBody は、配信の補助が先に読み切って req.on を写しに付け替えた要求から、届いたバイト列をそのまま返す（body の解析済みの値は使わない）",
    platformEnded && text(await lib.readRawBody(platform)) === raw, JSON.stringify({ platformEnded }));
  // rawBody があれば body に触らない（body を読むと例外になる作りでも、生の値で確かめられる）
  const first = await rawBodyFirstReq(raw, {});
  let threw = "";
  const got = await lib.readRawBody(first).catch((error) => { threw = String(error?.message || error); return null; });
  ok("生ボディ: readRawBody は rawBody を先に見て、あれば body に触らない（body を読むと例外の作りでも生の値を返す）", text(got) === raw && first.bodyReads() === 0 && !threw, JSON.stringify({ threw, reads: first.bodyReads() }));
  // 付け替えた写しが終わらない（ありえない形の守り）: 待ち続けず、決めた時間で「読めない」にする（400 (no raw body)。関数の時間切れにしない）
  const stalled = await platformReq(raw, {}, { endCopy: false });
  const started = Date.now();
  const late = await Promise.race([lib.readRawBody(stalled, { waitMs: 50 }), new Promise((resolve) => setTimeout(() => resolve("hung"), 2000))]);
  ok("生ボディ: 付け替えた req.on の写しが終わらなくても待ち続けない（決めた時間で null）", late === null && Date.now() - started < 1500, JSON.stringify({ late: late === null ? null : String(late).slice(0, 20), ms: Date.now() - started }));
}

// ===== 6. 加入（checkout） =====
{
  const form = () => providerCalls("POST", "/v1/checkout/sessions").at(-1)?.form ?? new URLSearchParams();
  const msg = () => form().get("custom_text[submit][message]") || "";
  const noAmount = (text) => !/[¥￥]|\d\s*円/.test(text);

  fresh();
  setEnv({ STRIPE_SECRET_KEY: null });
  let res = await invoke(checkout, post({ interval: "month" }, "tok-u1"));
  ok("加入: 受付前（秘密鍵が無い）は 503 not_configured「Pro はまだ受付前です。」・外へ出ない", res.statusCode === 503 && res.body?.message === "Pro はまだ受付前です。" && calls.length === 0, JSON.stringify(res.body));
  setEnv({ STRIPE_PRICE_MONTHLY: null });
  res = await invoke(checkout, post({ interval: "month" }, "tok-u1"));
  ok("加入: 月額の Price が無いのも受付前（503）", res.statusCode === 503);

  setEnv();
  res = await invoke(checkout, { method: "GET", headers: {} });
  ok("加入: POST 以外は 405", res.statusCode === 405);
  res = await invoke(checkout, post({ interval: "month" }));
  ok("加入: ログインしていない（トークン無し）は 401 login_required", res.statusCode === 401 && res.body?.error === "login_required");
  res = await invoke(checkout, post({ interval: "month" }, "tok-bad"));
  ok("加入: 確かめられないトークンも 401・決済の会社には出ない", res.statusCode === 401 && calls.every((c) => c.origin === DB));
  res = await invoke(checkout, post({ interval: "week" }, "tok-u1"));
  ok("加入: interval が month／year 以外は 400", res.statusCode === 400 && res.body?.error === "bad_request");
  res = await invoke(checkout, post({ interval: "year" }, "tok-u1"));
  ok("加入: 年額の Price が無い（年額は出さない決定）ときの year は 400「年額プランはまだ用意されていません。」", res.statusCode === 400 && res.body?.message === "年額プランはまだ用意されていません。");

  // すでに Pro
  fresh();
  D.rows.set(U2, { ...ROW_DEFAULTS, user_id: U2, status: "active", stripe_customer_id: "cus_u2", current_period_end: new Date(Date.now() + 10 * 86400000).toISOString() });
  res = await invoke(checkout, post({ interval: "month" }, "tok-u2"));
  ok("加入: 本人の行が Pro なら 409 already_subscribed・新しい手続きを作らない", res.statusCode === 409 && res.body?.error === "already_subscribed" && providerCalls("POST", "/v1/checkout/sessions").length === 0);
  // 行は無いが決済の会社に生きている契約（webhook の前）
  fresh();
  P.search = [{ id: "sub_x", status: "trialing" }];
  res = await invoke(checkout, post({ interval: "month" }, "tok-u1"));
  ok("加入: 行が無くても決済の会社に生きている契約があれば 409（webhook の前の二重加入）", res.statusCode === 409 && providerCalls("POST", "/v1/checkout/sessions").length === 0);
  // 行はあるが期限切れ・顧客の生きている契約がある
  fresh();
  D.rows.set(U2, { ...ROW_DEFAULTS, user_id: U2, status: "canceled", stripe_customer_id: "cus_u2", current_period_end: new Date(Date.now() - 40 * 86400000).toISOString() });
  P.list = [{ id: "sub_y", status: "past_due" }];
  res = await invoke(checkout, post({ interval: "month" }, "tok-u2"));
  ok("加入: 前の行が終わっていても、同じ顧客に生きている契約があれば 409", res.statusCode === 409 && providerCalls("POST", "/v1/checkout/sessions").length === 0);

  // 初めての人: 無料期間（暦の 1 か月）と確定の画面の文
  fresh();
  setEnv();
  const before = Math.floor(Date.now() / 60000) * 60;
  res = await invoke(checkout, post({ interval: "month" }, "tok-u1"));
  const after = Math.floor(Date.now() / 60000) * 60; // 分の境をまたいでも落ちないように前後の 2 つと比べる
  const f = form();
  const sent = providerCalls("POST", "/v1/checkout/sessions").at(-1);
  const trialEnd = Number(f.get("subscription_data[trial_end]"));
  ok("加入: 初めての人（行も契約も無い）は 200 で手続きの URL を返す", res.statusCode === 200 && res.body?.url === "https://pay.test/checkout/1", JSON.stringify(res.body));
  // Batch 88: 初めての人も customer（本人の顧客。下の 6b）で作り、customer_email は渡さない（前は customer_email で、手続きのたびに別の顧客ができた）
  ok("加入: 手続きの中身（月額の Price 1 つ・本人の印 3 か所・戻り先は SITE_ORIGIN から・日本語・本人の顧客〔customer。customer_email は渡さない〕）",
    f.get("mode") === "subscription" && f.get("line_items[0][price]") === "price_month_test" && f.get("line_items[0][quantity]") === "1" && f.get("client_reference_id") === U1 &&
      f.get("metadata[user_id]") === U1 && f.get("subscription_data[metadata][user_id]") === U1 && f.get("success_url") === "https://site.test/pro.html?pro=done" &&
      f.get("cancel_url") === "https://site.test/pro.html?pro=cancel" && f.get("locale") === "ja" && /^cus_/.test(f.get("customer") || "") && !f.has("customer_email"),
    [...f.keys()].join(","));
  ok("加入: 初めての人の無料期間は暦の 1 か月（trial_end = 日本時間で同じ日付の 1 か月後。分の頭から数える）",
    trialEnd > 0 && [before, after].some((m) => trialEnd === lib.trialEndUnix(new Date(m * 1000))) && !f.has("subscription_data[trial_period_days]"), `${trialEnd} vs ${lib.trialEndUnix(new Date(before * 1000))}`);
  ok("加入: 冪等キーは人・月額・無料期間つき・分（同じ分の二度押しで 2 つ作らない）", new RegExp(`^checkout:${U1}:month:trial:\\d+$`).test(sent?.headers["idempotency-key"] || ""), sent?.headers["idempotency-key"]);
  const trialText = msg();
  ok("確定の画面の文: custom_text[submit][message] を送る（確定のボタンのそばに出る。form の a[b][c] の書き方）", trialText.length > 0, [...f.keys()].join(","));
  ok("確定の画面の文（無料期間あり）: 毎月自動で更新・最初の 1 か月は無料・無料期間の終わりに最初の請求・無料期間中に解約すれば請求なし",
    /毎月自動で更新/.test(trialText) && /最初の1か月は料金がかかりません/.test(trialText) && /無料期間が終わる日に最初の請求/.test(trialText) && /無料期間中に解約すれば請求はありません/.test(trialText), trialText);
  ok("確定の画面の文: 解約はいつでも「設定 → 解約・お支払いの管理」から・期間の終わりまで使える・日割りの返金はしない",
    trialText.includes("いつでも「設定 → 解約・お支払いの管理」から") && /期間の終わりまで使え/.test(trialText) && /日割りの返金はしません/.test(trialText), trialText);
  ok("確定の画面の文: 金額は書かない（画面が Price から出す）・500 字以内（決済の会社の上限の内）", noAmount(trialText) && trialText.length <= 500, `${trialText.length}字`);
  // 提供の時期（特定商取引法 12 条の 6 の最終確認の画面で分かるようにする項目。特商法の表記の「提供時期」と同じ: 手続きが終わるとすぐ・無料期間中も同じ）
  ok("確定の画面の文（無料期間あり）: 提供の時期「お申し込みの手続きが終わるとすぐに使えます（無料期間中も同じです）」",
    trialText.includes("お申し込みの手続きが終わるとすぐに使えます（無料期間中も同じです）。"), trialText);
  ok("加入: 同意の欄（consent_collection）は送らない（規約の URL を決済の会社の画面で設定するまで使えない）", ![...f.keys()].some((k) => k.startsWith("consent_collection")));

  // 以前に加入した人（行が canceled・顧客あり）: 無料期間なし・確定の画面の文も無料と言わない
  fresh();
  D.rows.set(U2, { ...ROW_DEFAULTS, user_id: U2, status: "canceled", stripe_customer_id: "cus_u2", current_period_end: new Date(Date.now() - 40 * 86400000).toISOString() });
  res = await invoke(checkout, post({ interval: "month" }, "tok-u2"));
  const g = form();
  const paidText = msg();
  ok("加入: 以前に加入した人は同じ顧客に付け（customer）、無料期間を付けない", res.statusCode === 200 && g.get("customer") === "cus_u2" && !g.has("customer_email") && !g.has("subscription_data[trial_end]") && !g.has("subscription_data[trial_period_days]"), [...g.keys()].join(","));
  ok("加入: 以前に加入した人の冪等キーは paid", /:month:paid:\d+$/.test(providerCalls("POST", "/v1/checkout/sessions").at(-1)?.headers["idempotency-key"] || ""));
  ok("確定の画面の文（無料期間なし）: お申し込みの日に最初の請求・毎月自動で更新・解約の方法。無料とは言わない",
    /お申し込みの日に最初の請求/.test(paidText) && /毎月自動で更新/.test(paidText) && paidText.includes("「設定 → 解約・お支払いの管理」") && /日割りの返金はしません/.test(paidText) && !/無料/.test(paidText) && noAmount(paidText), paidText);
  ok("確定の画面の文（無料期間なし）: 提供の時期「お申し込みの手続きが終わるとすぐに使えます。」（無料期間の話はしない）",
    paidText.includes("お申し込みの手続きが終わるとすぐに使えます。") && !paidText.includes("無料期間中"), paidText);

  // 行は無いが、決済の会社に終わった契約がある（webhook の前に解約）: 初めてではない
  fresh();
  P.search = [{ id: "sub_old", status: "canceled" }];
  res = await invoke(checkout, post({ interval: "month" }, "tok-u1"));
  ok("加入: 行が無くても決済の会社に終わった契約があれば無料期間を付けない（文も無料と言わない）", res.statusCode === 200 && !form().has("subscription_data[trial_end]") && !/無料/.test(msg()), msg());

  // 検索ができなくても初めての人の加入は止めない
  fresh();
  P.fail.add("search");
  res = await invoke(checkout, post({ interval: "month" }, "tok-u1"));
  ok("加入: 決済の会社の検索が失敗しても、行の無い初めての人は加入できる（無料期間つき）", res.statusCode === 200 && form().has("subscription_data[trial_end]"));

  // 無料期間を日数で（STRIPE_TRIAL_DAYS。月の指定が無いとき）
  fresh();
  setEnv({ STRIPE_TRIAL_MONTHS: null, STRIPE_TRIAL_DAYS: "7" });
  res = await invoke(checkout, post({ interval: "month" }, "tok-u1"));
  ok("加入: 日数の無料期間は trial_period_days・確定の画面の文は「最初の7日」", res.statusCode === 200 && form().get("subscription_data[trial_period_days]") === "7" && !form().has("subscription_data[trial_end]") && /最初の7日は料金がかかりません/.test(msg()), msg());

  // 無料期間の設定が無い初めての人: 無料と言わない
  fresh();
  setEnv({ STRIPE_TRIAL_MONTHS: null });
  res = await invoke(checkout, post({ interval: "month" }, "tok-u1"));
  ok("加入: 無料期間の設定が無ければ初めての人にも無料と言わない（お申し込みの日に最初の請求）", res.statusCode === 200 && !/無料/.test(msg()) && /お申し込みの日に最初の請求/.test(msg()), msg());

  // 年額（決定では出さないが、コードは Price があれば動く）: 文は「毎年」
  fresh();
  setEnv({ STRIPE_PRICE_YEARLY: "price_year_test" });
  res = await invoke(checkout, post({ interval: "year" }, "tok-u1"));
  ok("加入: 年額の手続きの確定の画面の文は「毎年自動で更新」（毎月と言わない）", res.statusCode === 200 && form().get("line_items[0][price]") === "price_year_test" && /毎年自動で更新/.test(msg()) && !/毎月/.test(msg()), msg());

  // 決済の会社が手続きを作れない
  fresh();
  setEnv();
  P.fail.add("checkout");
  res = await invoke(checkout, post({ interval: "month" }, "tok-u1"));
  ok("加入: 手続きを作れないと 502 upstream「手続きを始められませんでした。…」", res.statusCode === 502 && res.body?.error === "upstream" && /手続きを始められませんでした/.test(res.body?.message || ""));

  // 文を組む関数そのもの（api/_lib/billing.js checkoutSubmitMessage）
  const build = lib.checkoutSubmitMessage;
  ok("確定の画面の文: 組む関数（checkoutSubmitMessage）がある", typeof build === "function");
  if (typeof build === "function") {
    const m1 = build({ interval: "month", trialLabel: "1か月" });
    const m0 = build({ interval: "month" });
    ok("確定の画面の文: 関数は無料期間の名を入れたときだけ無料と言う・どちらも 500 字以内", /最初の1か月は料金がかかりません/.test(m1) && !/無料/.test(m0) && m1.length <= 500 && m0.length <= 500, `${m1} / ${m0}`);
    ok("確定の画面の文: 関数の文はどちらも提供の時期（手続きが終わるとすぐに使えます）を言う", m1.includes("手続きが終わるとすぐに使えます") && m0.includes("手続きが終わるとすぐに使えます"), `${m1} / ${m0}`);
  }
}

// ===== 6b. 1 人に顧客 1 人・開いた手続きを閉じる・別の契約の終わりで生きている行を上書きしない（Batch 88） =====
// d8f9d69 では、行の無い人の加入は customer_email だけで手続きを作り（手続きのたびに別の顧客）、前の手続きは開いたまま（期限 24 時間）。
// 2 つの手続きを両方払うと契約が 2 つになり、古い方の終わり（deleted）が生きている方の行を canceled にした（Pro でないのに課金は続く）
{
  const sessionsForm = () => providerCalls("POST", "/v1/checkout/sessions").at(-1)?.form ?? new URLSearchParams();
  const realNow = Date.now;
  const at = async (ms, fn) => {
    Date.now = () => ms;
    try {
      return await fn();
    } finally {
      Date.now = realNow;
    }
  };
  const minuteStart = Math.floor(realNow() / 60000) * 60000;

  // (a) 行の無い人: 顧客を探し、無ければ作る（冪等キー customer:<uuid>）→ 手続きは customer で（customer_email なし）・期限は今 + 30 分より後
  fresh();
  setEnv();
  let res = await at(minuteStart + 5000, () => invoke(checkout, post({ interval: "month" }, "tok-u1")));
  const search = providerCalls("GET", "/v1/customers/search").at(-1);
  const made = providerCalls("POST", "/v1/customers");
  const f = sessionsForm();
  const expiresAt = Number(f.get("expires_at"));
  const t0 = Math.floor((minuteStart + 5000) / 1000);
  const mailed = calls.filter((c) => c.origin !== DB && c.method === "POST" && /^\/v1\/customers\/[^/]+$/.test(c.path));
  ok("6b (a) 行の無い人: 顧客を metadata の user_id で探し、無ければ作る（冪等キー customer:<uuid>・本文は metadata[user_id] だけ）→ 作った後にメールを書く",
    res.statusCode === 200 && search?.params.get("query") === `metadata['user_id']:'${U1}'` && made.length === 1 && made[0].headers["idempotency-key"] === `customer:${U1}` &&
      made[0].form.get("metadata[user_id]") === U1 && !made[0].form.has("email") && mailed.length === 1 && mailed[0].form.get("email") === "u1@example.com" && P.customers[0]?.email === "u1@example.com",
    JSON.stringify({ status: res.statusCode, query: search?.params.get("query"), made: made.map((c) => [c.headers["idempotency-key"], c.body]), mailed: mailed.map((c) => c.body) }));
  ok("6b (a) 手続きは作った顧客で（customer=）・customer_email は渡さない",
    f.get("customer") === P.customers[0]?.id && !f.has("customer_email"), [...f.keys()].join(","));
  ok("6b (a) 手続きの期限（expires_at）は今 + 30 分より後・24 時間より前（古いタブから前の手続きを最後まで進められない）",
    expiresAt > t0 + 30 * 60 && expiresAt < t0 + 24 * 3600, `${expiresAt - t0} 秒後`);

  // (a2) 顧客の検索で見つかれば、作らずにその顧客を使う
  fresh();
  P.customers.push({ id: "cus_found", email: "u1@example.com", metadata: { user_id: U1 }, searchable: true });
  res = await invoke(checkout, post({ interval: "month" }, "tok-u1"));
  ok("6b (a2) 検索で本人の顧客が見つかれば作らずにその顧客で手続きを作る", res.statusCode === 200 && providerCalls("POST", "/v1/customers").length === 0 && sessionsForm().get("customer") === "cus_found", [...sessionsForm().keys()].join(","));

  // (a3) 顧客の検索が失敗しても止めない（冪等キーで同じ顧客になる）。(a4) 顧客を作れなければ 502・手続きを作らない
  fresh();
  P.fail.add("customer_search");
  res = await invoke(checkout, post({ interval: "month" }, "tok-u1"));
  ok("6b (a3) 顧客の検索が失敗しても加入は止めない（作る。冪等キーで同じ顧客）", res.statusCode === 200 && providerCalls("POST", "/v1/customers").length === 1 && /^cus_new_/.test(sessionsForm().get("customer") || ""));
  fresh();
  P.fail.add("customer_create");
  res = await invoke(checkout, post({ interval: "month" }, "tok-u1"));
  ok("6b (a4) 顧客を作れなければ 502 upstream・手続きを作らない（customer_email で作り直さない）", res.statusCode === 502 && providerCalls("POST", "/v1/checkout/sessions").length === 0);

  // (a5) 作ったばかりの顧客（まだ検索に出ない）で、2 回目の前にログインのメールが変わった（Batch 88 の反証）: 前は作る要求の本文にメールがあり、
  // 同じ冪等キーで本文が違うので決済の会社が断り（idempotency_error）、冪等キーの 24 時間は 502 のままだった。今は同じ顧客で手続きを作り、メールは新しい方
  fresh();
  res = await at(minuteStart + 5000, () => invoke(checkout, post({ interval: "month" }, "tok-u1")));
  const before = res.statusCode;
  const oldMail = USERS["tok-u1"].email;
  USERS["tok-u1"].email = "u1-new@example.com";
  try {
    res = await at(minuteStart + 3 * 60000 + 5000, () => invoke(checkout, post({ interval: "month" }, "tok-u1")));
  } finally {
    USERS["tok-u1"].email = oldMail;
  }
  ok("6b (a5) 2 回目の前にメールが変わっても、2 回目は 200・顧客は 1 人のまま（同じ顧客で手続き）・顧客のメールは新しい方",
    before === 200 && res.statusCode === 200 && P.customers.length === 1 && sessionsForm().get("customer") === P.customers[0]?.id && P.customers[0]?.email === "u1-new@example.com",
    JSON.stringify({ before, status: res.statusCode, body: res.body, customers: P.customers.map((c) => [c.id, c.email]) }));
  // (a6) メールを書けなくても手続きは作る（その画面でメールを聞く）
  fresh();
  P.fail.add("customer_update");
  res = await invoke(checkout, post({ interval: "month" }, "tok-u1"));
  ok("6b (a6) 顧客のメールを書けなくても、手続きは 200 で作る", res.statusCode === 200 && /^cus_new_/.test(sessionsForm().get("customer") || ""), JSON.stringify({ status: res.statusCode }));

  // (b) 2 分後の 2 回目（1 回目の手続きは開いたまま・作ったばかりの顧客はまだ検索に出ない）: 同じ顧客・1 回目の手続きを期限切れにしてから新しい手続き
  fresh();
  res = await at(minuteStart + 5000, () => invoke(checkout, post({ interval: "month" }, "tok-u1")));
  const first = res.body?.url;
  res = await at(minuteStart + 2 * 60000 + 5000, () => invoke(checkout, post({ interval: "month" }, "tok-u1")));
  const second = res.body?.url;
  const customersSent = providerCalls("POST", "/v1/checkout/sessions").map((c) => c.form.get("customer"));
  ok("6b (b) 2 分後の 2 回目: 顧客は 1 人のまま（冪等キーで同じ顧客）・2 つの手続きは同じ顧客",
    res.statusCode === 200 && P.customers.length === 1 && customersSent.length === 2 && customersSent[0] === customersSent[1] && customersSent[0] === P.customers[0].id,
    JSON.stringify({ customers: P.customers.map((c) => c.id), customersSent }));
  ok("6b (b) 2 回目は 1 回目の開いた手続きを期限切れにする（新しい手続きは開いたまま）・別の URL",
    first === "https://pay.test/checkout/1" && second === "https://pay.test/checkout/2" && P.sessions[0]?.status === "expired" && P.sessions[1]?.status === "open" &&
      providerCalls("POST", "/v1/checkout/sessions/cs_test_1/expire").length === 1 && providerCalls("POST", "/v1/checkout/sessions/cs_test_2/expire").length === 0,
    JSON.stringify({ first, second, sessions: P.sessions.map((x) => [x.id, x.status]) }));

  // (b2) 同じ分の二度押し: 冪等キーで同じ手続きが返り、それを閉じない（期限の値も分の頭から作るので、同じ本文になる）
  fresh();
  const r1 = await at(minuteStart + 1000, () => invoke(checkout, post({ interval: "month" }, "tok-u1")));
  const r2 = await at(minuteStart + 40000, () => invoke(checkout, post({ interval: "month" }, "tok-u1")));
  ok("6b (b2) 同じ分の二度押しは同じ手続き（同じ URL）で、それを期限切れにしない",
    r1.statusCode === 200 && r2.statusCode === 200 && r1.body?.url === r2.body?.url && P.sessions.length === 1 && P.sessions[0].status === "open",
    JSON.stringify({ r1: [r1.statusCode, r1.body], r2: [r2.statusCode, r2.body], sessions: P.sessions.map((x) => [x.id, x.status]) }));

  // (b3) 前の手続きを閉じられなくても新しい手続きは返す（閉じるのは守りの上乗せ。期限 35 分が残る）
  fresh();
  await at(minuteStart + 5000, () => invoke(checkout, post({ interval: "month" }, "tok-u1")));
  P.fail.add("expire");
  res = await at(minuteStart + 2 * 60000 + 5000, () => invoke(checkout, post({ interval: "month" }, "tok-u1")));
  ok("6b (b3) 前の手続きを期限切れにできなくても、新しい手続きは 200 で返す", res.statusCode === 200 && res.body?.url === "https://pay.test/checkout/2");

  // (e) 無料期間: 行も検索の契約も無いが、本人の顧客に解約済みの契約がある → 初めてではない（無料期間なし）
  fresh();
  P.customers.push({ id: "cus_old", email: "u1@example.com", metadata: { user_id: U1 }, searchable: true });
  P.list = [{ id: "sub_old", status: "canceled", customer: "cus_old" }];
  res = await invoke(checkout, post({ interval: "month" }, "tok-u1"));
  ok("6b (e) 本人の顧客に解約済みの契約があれば無料期間を付けない（行と契約の検索に無くても）",
    res.statusCode === 200 && sessionsForm().get("customer") === "cus_old" && !sessionsForm().has("subscription_data[trial_end]") && !sessionsForm().has("subscription_data[trial_period_days]"),
    [...sessionsForm().keys()].join(","));
  // (e2) 本人の顧客に生きている契約（webhook の前・検索に出る前）があれば 409
  fresh();
  P.customers.push({ id: "cus_live", email: "u1@example.com", metadata: { user_id: U1 }, searchable: true });
  P.list = [{ id: "sub_live", status: "trialing", customer: "cus_live" }];
  res = await invoke(checkout, post({ interval: "month" }, "tok-u1"));
  ok("6b (e2) 行が無く契約の検索にも出ていなくても、本人の顧客に生きている契約があれば 409・手続きを作らない", res.statusCode === 409 && providerCalls("POST", "/v1/checkout/sessions").length === 0);

  // (c) 2 つの契約が両方できてしまった（d8f9d69 の形や手での作成）: 古い方の終わり（deleted）で、生きている方の行を canceled にしない
  fresh();
  setEnv();
  const now = nowSec();
  // 期間の終わりは先（subOf の既定の 2026-01-01 は過ぎていて、Pro の行にならない）
  const liveItems = { data: [{ price: { id: "price_month_test", recurring: { interval: "month" } }, current_period_end: now + 30 * 86400 }] };
  const subA = subOf({ id: "sub_A", customer: "cus_one", status: "trialing", items: liveItems });
  const subB = subOf({ id: "sub_B", customer: "cus_one", status: "trialing", items: liveItems });
  P.subs.set("sub_A", subA);
  P.subs.set("sub_B", subB);
  P.list = [subA, subB];
  logs.length = 0;
  await hook(eventOf("checkout.session.completed", { object: "checkout.session", mode: "subscription", client_reference_id: U1, subscription: "sub_A" }, now - 100));
  await hook(eventOf("checkout.session.completed", { object: "checkout.session", mode: "subscription", client_reference_id: U1, subscription: "sub_B" }, now - 50));
  const dupLog = logs.find((l) => l.includes("duplicate live subscription")) ?? "";
  ok("6b (c) 生きている契約が 2 つになったら、新しい方を書き、ログに duplicate live subscription（番号は書かない）",
    D.rows.get(U1)?.stripe_subscription_id === "sub_B" && dupLog.startsWith("billing/webhook: duplicate live subscription") && !/sub_|cus_|@/.test(dupLog), JSON.stringify({ row: D.rows.get(U1), dupLog }));
  P.list = [{ ...subA, status: "canceled" }, subB];
  const res3 = await hook(eventOf("customer.subscription.deleted", { ...subA, status: "canceled" }, now - 10));
  const rowC = D.rows.get(U1);
  ok("6b (c) 古い方（sub_A）の deleted が来ても、行は生きている方（sub_B・trialing）のまま・Pro のまま・ログは other subscription ignored",
    res3.statusCode === 200 && rowC?.stripe_subscription_id === "sub_B" && rowC?.status === "trialing" && lib.isProRow(rowC) && logs.some((l) => l.includes("other subscription ignored")),
    JSON.stringify(rowC));
  res = await invoke(portal, post({}, "tok-u1"));
  ok("6b (c) 「解約・お支払いの管理」は同じ顧客（cus_one）で開く", res.statusCode === 200 && providerCalls("POST", "/v1/billing_portal/sessions").at(-1)?.form?.get("customer") === "cus_one");

  // (d2) 行の契約（sub_B）が終わっても、同じ顧客に生きている契約（sub_A）があれば、そちらを書く（Pro のまま）
  fresh();
  const subA2 = subOf({ id: "sub_A", customer: "cus_one", status: "active", items: liveItems });
  const subB2 = subOf({ id: "sub_B", customer: "cus_one", status: "active", items: liveItems });
  D.rows.set(U1, { ...ROW_DEFAULTS, user_id: U1, status: "active", stripe_customer_id: "cus_one", stripe_subscription_id: "sub_B", event_created: now - 50, current_period_end: new Date(Date.now() + 20 * 86400000).toISOString() });
  P.list = [subA2, { ...subB2, status: "canceled" }];
  logs.length = 0;
  res = await hook(eventOf("customer.subscription.deleted", { ...subB2, status: "canceled" }, now - 5));
  const rowD2 = D.rows.get(U1);
  ok("6b (d2) 行の契約が終わっても、同じ顧客に生きている別の契約があれば、そちらの契約を書く（Pro のまま。返金した重複の方を先に止めても行は壊れない）",
    res.statusCode === 200 && rowD2?.stripe_subscription_id === "sub_A" && rowD2?.status === "active" && lib.isProRow(rowD2) && rowD2?.event_created === now - 5,
    JSON.stringify(rowD2));

  // (d) ふつうの解約: 行の契約が終わり、ほかに生きている契約が無ければ前のとおり canceled（Pro が終わる）
  fresh();
  D.rows.set(U1, { ...ROW_DEFAULTS, user_id: U1, status: "active", stripe_customer_id: "cus_one", stripe_subscription_id: "sub_B", event_created: now - 50 });
  P.list = [{ ...subB2, status: "canceled" }, { ...subA2, status: "canceled" }];
  res = await hook(eventOf("customer.subscription.deleted", { ...subB2, status: "canceled" }, now - 5));
  ok("6b (d) 行の契約の deleted で、ほかに生きている契約が無ければ canceled（Pro が終わる）", res.statusCode === 200 && D.rows.get(U1)?.status === "canceled" && D.rows.get(U1)?.stripe_subscription_id === "sub_B" && !lib.isProRow(D.rows.get(U1)), JSON.stringify(D.rows.get(U1)));

  // (d3) 行が Pro でないとき（解約済み）に別の契約の終わりが届いても、前のとおり書く（生きている行を守るときだけ断る）
  fresh();
  D.rows.set(U1, { ...ROW_DEFAULTS, user_id: U1, status: "canceled", stripe_customer_id: "cus_one", stripe_subscription_id: "sub_B", event_created: now - 50 });
  res = await hook(eventOf("customer.subscription.updated", { ...subA2, status: "past_due" }, now - 5));
  ok("6b (d3) 行が Pro でなければ、別の契約の更新は前のとおり書く（入り直した人の新しい契約）", res.statusCode === 200 && D.rows.get(U1)?.stripe_subscription_id === "sub_A" && D.rows.get(U1)?.status === "past_due");

  // (d4)〜(d7) 行の契約の終わりで、同じ顧客のほかの契約の一覧が読めないとき（Batch 88 の反証）。前は一覧が読めないと毎回 500 で、
  // 顧客を消した後（一覧は「その顧客は無い」の 4xx を返し続ける）は再送が全部失敗し、解約した人が期限 + 3 日まで Pro のままだった
  const liveRow = (created) => ({ ...ROW_DEFAULTS, user_id: U1, status: "active", stripe_customer_id: "cus_gone", stripe_subscription_id: "sub_X", event_created: created, current_period_end: new Date(Date.now() + 20 * 86400000).toISOString() });
  const subX = subOf({ id: "sub_X", customer: "cus_gone", status: "canceled", items: liveItems });
  const deletedX = (created) => hook(eventOf("customer.subscription.deleted", subX, created));
  const rowState = () => [D.rows.get(U1)?.status, lib.isProRow(D.rows.get(U1))];
  // (d4) 顧客を消した（一覧は 404 resource_missing）: ほかの生きている契約は無いとみなして canceled を書く（消した顧客に生きている契約は残らない）
  fresh();
  D.rows.set(U1, liveRow(now - 50));
  P.fail.add("list_missing");
  logs.length = 0;
  res = await deletedX(now - 5);
  ok("6b (d4) 行の契約の deleted で、顧客を消した後の一覧が 4xx（その顧客は無い）なら、200 で canceled を書く（Pro が終わる。ログに番号を書かない）",
    res.statusCode === 200 && JSON.stringify(rowState()) === JSON.stringify(["canceled", false]) && !logs.some((l) => /sub_X|cus_gone/.test(l)), JSON.stringify({ status: res.statusCode, row: rowState(), logs: logs.slice(-2) }));
  // (d5) 一覧が一時的に失敗（500）: 届いてすぐは 500 で再送に任せる（ほかに生きている契約があるかもしれない）。再送で一覧が読めれば canceled
  fresh();
  D.rows.set(U1, liveRow(now - 50));
  P.fail.add("list");
  const firstTry = await deletedX(now - 5);
  const keptRow = rowState();
  P.fail.delete("list");
  const retried = await deletedX(now - 5);
  ok("6b (d5) 一覧が一時的に 500 なら、届いてすぐは 500（再送を待つ・行はそのまま）、再送で読めたら canceled",
    firstTry.statusCode === 500 && JSON.stringify(keptRow) === JSON.stringify(["active", true]) && retried.statusCode === 200 && JSON.stringify(rowState()) === JSON.stringify(["canceled", false]),
    JSON.stringify({ first: firstTry.statusCode, keptRow, retried: retried.statusCode, row: rowState() }));
  // (d6) 一覧の 500 が 1 時間より長く続いた（再送の間ずっと読めない）: 届いた状態（canceled）を書く。いつまでも Pro のままにしない
  fresh();
  D.rows.set(U1, liveRow(now - 7200));
  P.fail.add("list");
  res = await deletedX(now - 3700);
  ok("6b (d6) 一覧の失敗が届いてから 1 時間を過ぎても続くなら、200 で canceled を書く", res.statusCode === 200 && JSON.stringify(rowState()) === JSON.stringify(["canceled", false]), JSON.stringify({ status: res.statusCode, row: rowState() }));
  // (d7) つながらない（fetch が投げる）: 届いてすぐは 500、1 時間を過ぎたら canceled
  fresh();
  D.rows.set(U1, liveRow(now - 7200));
  P.fail.add("list_network");
  const netFresh = await deletedX(now - 5);
  const netFreshRow = rowState();
  const netOld = await deletedX(now - 3700);
  ok("6b (d7) 一覧につながらないときも、届いてすぐは 500（行はそのまま）、1 時間を過ぎた再送では canceled",
    netFresh.statusCode === 500 && JSON.stringify(netFreshRow) === JSON.stringify(["active", true]) && netOld.statusCode === 200 && JSON.stringify(rowState()) === JSON.stringify(["canceled", false]),
    JSON.stringify({ netFresh: netFresh.statusCode, netFreshRow, netOld: netOld.statusCode, row: rowState() }));
}

// ===== 7. お支払いの管理（portal） =====
{
  fresh();
  setEnv({ STRIPE_SECRET_KEY: null });
  let res = await invoke(portal, post({}, "tok-u2"));
  ok("管理: 受付前は 503", res.statusCode === 503 && res.body?.error === "not_configured");
  setEnv();
  res = await invoke(portal, post({}));
  ok("管理: ログインしていないと 401", res.statusCode === 401 && res.body?.error === "login_required");
  res = await invoke(portal, post({}, "tok-u1"));
  ok("管理: 本人の行（顧客の番号）が無いと 404 no_subscription・決済の会社に出ない", res.statusCode === 404 && res.body?.error === "no_subscription" && providerCalls("POST", "/v1/billing_portal/sessions").length === 0);
  D.rows.set(U2, { ...ROW_DEFAULTS, user_id: U2, status: "active", stripe_customer_id: "cus_u2" });
  D.rows.set(U1, { ...ROW_DEFAULTS, user_id: U1, status: "active", stripe_customer_id: "cus_u1" });
  res = await invoke(portal, post({}, "tok-u2"));
  const sent = providerCalls("POST", "/v1/billing_portal/sessions").at(-1)?.form;
  ok("管理: 本人の顧客の番号で管理の画面を作り、戻り先は SITE_ORIGIN/profile.html（ほかの人の行は読めない）", res.statusCode === 200 && res.body?.url === "https://pay.test/portal/1" && sent?.get("customer") === "cus_u2" && sent?.get("return_url") === "https://site.test/profile.html", JSON.stringify(res.body));
}

// ===== 7c. 加入とお支払いの管理は 1 人 1 分 10 回まで（Batch 88。インスタンスのメモリー。同じ人の連打で決済の会社を叩かない） =====
{
  fresh();
  setEnv();
  const realNow = Date.now;
  const t0 = Math.floor(realNow() / 60000) * 60000 + 1000;
  try {
    Date.now = () => t0;
    const st = [];
    for (let i = 0; i < 11; i++) st.push((await invoke(checkout, post({ interval: "month" }, "tok-u3"))).statusCode);
    const last = await invoke(checkout, post({ interval: "month" }, "tok-u3"));
    const other = await invoke(checkout, post({ interval: "month" }, "tok-u2"));
    ok("回数: 加入は同じ人の 1 分 10 回まで（11 回目から 429 too_many・短い字）・ほかの人は 200",
      st.slice(0, 10).every((x) => x === 200) && st[10] === 429 && last.statusCode === 429 && last.body?.error === "too_many" && typeof last.body?.message === "string" && last.body.message.length <= 40 && other.statusCode === 200,
      JSON.stringify({ st, last: last.body, other: other.statusCode }));
    D.rows.set(U1, { ...ROW_DEFAULTS, user_id: U1, status: "active", stripe_customer_id: "cus_u1" });
    D.rows.set(U2, { ...ROW_DEFAULTS, user_id: U2, status: "active", stripe_customer_id: "cus_u2" });
    const ps = [];
    for (let i = 0; i < 11; i++) ps.push((await invoke(portal, post({}, "tok-u1"))).statusCode);
    const otherPortal = await invoke(portal, post({}, "tok-u2"));
    ok("回数: 「解約・お支払いの管理」も同じ人の 1 分 10 回まで（11 回目は 429）・ほかの人は 200", ps.slice(0, 10).every((x) => x === 200) && ps[10] === 429 && otherPortal.statusCode === 200, JSON.stringify({ ps, other: otherPortal.statusCode }));
    Date.now = () => t0 + 61000;
    const next = await invoke(checkout, post({ interval: "month" }, "tok-u3"));
    ok("回数: 次の分にはまた加入できる（200）", next.statusCode === 200, String(next.statusCode));
  } finally {
    Date.now = realNow;
  }
}

// ===== 7b. 受付を急いで止めた後（月額の Price の変数を外して再デプロイ。docs/BILLING.md §2 の止め方） =====
// 新しい加入だけが止まり、もう加入している人の「解約・お支払いの管理」と webhook（解約予定・更新・支払いの失敗の反映）は動き続ける。
// 確定の画面の文は「解約はいつでも「設定 → 解約・お支払いの管理」からできます」と約束している
{
  fresh();
  setEnv({ STRIPE_PRICE_MONTHLY: null });
  let res = await invoke(config, { method: "GET", headers: {} });
  ok("止めた後: 価格は受付前（configured:false）で、加入画面は「受付前」になる", res.statusCode === 200 && res.body?.configured === false, JSON.stringify(res.body));
  res = await invoke(checkout, post({ interval: "month" }, "tok-u1"));
  ok("止めた後: 新しい加入は 503 not_configured", res.statusCode === 503 && res.body?.error === "not_configured", JSON.stringify(res.body));
  D.rows.set(U1, { ...ROW_DEFAULTS, user_id: U1, status: "active", stripe_customer_id: "cus_test_1", stripe_subscription_id: "sub_test_1", event_created: 100 });
  res = await invoke(portal, post({}, "tok-u1"));
  ok("止めた後: 加入している人の「解約・お支払いの管理」は開ける（200・本人の顧客の番号）", res.statusCode === 200 && providerCalls("POST", "/v1/billing_portal/sessions").at(-1)?.form?.get("customer") === "cus_test_1", JSON.stringify(res.body));
  res = await hook(eventOf("customer.subscription.updated", subOf({ cancel_at_period_end: true }), 200));
  ok("止めた後: webhook は加入している人の変化（解約予定）を書く（200）", res.statusCode === 200 && D.rows.get(U1)?.cancel_at_period_end === true && D.rows.get(U1)?.event_created === 200, JSON.stringify({ body: res.body, row: D.rows.get(U1) }));
  setEnv({ STRIPE_PRICE_MONTHLY: null, STRIPE_SECRET_KEY: null });
  res = await invoke(portal, post({}, "tok-u1"));
  const portalOff = res.statusCode === 503;
  res = await hook(eventOf("customer.subscription.updated", subOf({ cancel_at_period_end: false }), 300));
  ok("秘密鍵まで外すと、管理と webhook も 503（決済の会社は webhook を再送する）・書かない", portalOff && res.statusCode === 503 && D.rows.get(U1)?.event_created === 200, String(res.statusCode));
}

// ===== 7d. 受付中の条件と加入の表（Batch 94。DECISION §2 C）: 受付中（config の configured・加入の口・AI の「Pro なら…」）は 4 つ
// （秘密鍵 STRIPE_SECRET_KEY・月額の Price STRIPE_PRICE_MONTHLY・署名の鍵 STRIPE_WEBHOOK_SECRET・service role SUPABASE_SERVICE_ROLE_KEY）がそろってから。
// 前は秘密鍵と月額の Price だけで受付中になり、署名の鍵か service role が無いと、払っても webhook が 503 のままで Pro にならなかった。
// 加入の口は、本人の行を読むときに加入の表（subscriptions）が無ければ 503 not_configured（決済の会社へは 1 回も出ない）。前は「行が無い」と読んで手続きを作った。
// お支払いの管理・webhook・AI の Pro の判定は今の読み方のまま（管理は秘密鍵だけを見る・表が無ければ「行なし」）
{
  const shared = await load("api/_lib/shared.js");
  const providerAll = () => calls.filter((c) => c.origin !== DB).map((c) => `${c.method} ${c.path}`);
  const notConfigured = lib.MESSAGES?.notConfigured;
  // C1: 秘密鍵と月額の Price だけ（署名の鍵・service role なし）
  fresh();
  setEnv({ STRIPE_WEBHOOK_SECRET: null, SUPABASE_SERVICE_ROLE_KEY: null });
  let res = await invoke(config, { method: "GET", headers: {} });
  const c1Config = { status: res.statusCode, configured: res.body?.configured, prices: res.body?.prices?.length ?? null, provider: providerAll() };
  res = await invoke(checkout, post({ interval: "month" }, "tok-u1"));
  ok("受付の条件 C1（Batch 94）: 秘密鍵と月額の Price だけでは受付前（config は 200 で configured:false・価格を取りに出ない）・加入の口は 503 not_configured・決済の会社に 1 回も出ない",
    c1Config.status === 200 && c1Config.configured === false && c1Config.prices === 0 && c1Config.provider.length === 0
      && res.statusCode === 503 && res.body?.error === "not_configured" && res.body?.message === notConfigured && providerAll().length === 0,
    JSON.stringify({ c1Config, checkout: [res.statusCode, res.body?.error], provider: providerAll() }));
  // C2: 署名の鍵を足してもまだ受付前。service role も足すと受付中（4 つのどれが欠けても受付前）
  const configuredWith = (over) => {
    setEnv(over);
    return lib.billingConfigured();
  };
  const matrix = [
    configuredWith({}),
    configuredWith({ SUPABASE_SERVICE_ROLE_KEY: null }),
    configuredWith({ STRIPE_WEBHOOK_SECRET: null }),
    configuredWith({ STRIPE_WEBHOOK_SECRET: null, SUPABASE_SERVICE_ROLE_KEY: null }),
    configuredWith({ STRIPE_PRICE_MONTHLY: null }),
    configuredWith({ STRIPE_SECRET_KEY: null })
  ];
  fresh();
  setEnv({ SUPABASE_SERVICE_ROLE_KEY: null });
  res = await invoke(config, { method: "GET", headers: {} });
  const withSigning = res.body?.configured;
  setEnv();
  res = await invoke(config, { method: "GET", headers: {} });
  const withAll = res.body?.configured;
  ok("受付の条件 C2（Batch 94）: 署名の鍵を足してもまだ受付前（configured:false）・service role も足すと受付中（configured:true）・4 つのどれが欠けても受付前",
    JSON.stringify(matrix) === JSON.stringify([true, false, false, false, false, false]) && withSigning === false && withAll === true,
    JSON.stringify({ matrix, withSigning, withAll }));
  // C3（守り）: 4 つそろって月額の Price を外す（急いで止める手）→ 受付前。お支払いの管理（秘密鍵だけ）と webhook（秘密鍵・署名の鍵・service role）は自分の条件で動く
  fresh();
  setEnv({ STRIPE_PRICE_MONTHLY: null });
  res = await invoke(config, { method: "GET", headers: {} });
  const c3Config = res.body?.configured;
  res = await invoke(checkout, post({ interval: "month" }, "tok-u1"));
  const c3Checkout = res.statusCode;
  D.rows.set(U1, { ...ROW_DEFAULTS, user_id: U1, status: "active", stripe_customer_id: "cus_test_1", stripe_subscription_id: "sub_test_1", event_created: 100 });
  res = await invoke(portal, post({}, "tok-u1"));
  const c3Portal = res.statusCode;
  res = await hook(eventOf("customer.subscription.updated", subOf({ cancel_at_period_end: true }), 200));
  ok("受付の条件 C3（守り）: 4 つそろって月額の Price を外すと受付前（config・加入の口 503）。お支払いの管理は 200・webhook は 200 で書く（自分の条件のまま）",
    c3Config === false && c3Checkout === 503 && c3Portal === 200 && res.statusCode === 200 && D.rows.get(U1)?.cancel_at_period_end === true,
    JSON.stringify({ c3Config, c3Checkout, c3Portal, hook: res.statusCode }));
  // C4: 4 つそろっていても、データベースに加入の表（subscriptions）が無い（docs/SQL_BILLING.md の前）
  fresh();
  setEnv();
  D.missing = true;
  res = await invoke(checkout, post({ interval: "month" }, "tok-u1"));
  const c4 = { status: res.statusCode, error: res.body?.error, message: res.body?.message, provider: providerAll() };
  const beforePortal = providerAll().length;
  res = await invoke(portal, post({}, "tok-u1"));
  const c4Portal = [res.statusCode, res.body?.error, providerAll().length - beforePortal];
  ok("受付の条件 C4（Batch 94）: 4 つそろっていても加入の表が無ければ、加入の口は 503 not_configured「Pro はまだ受付前です。」・決済の会社への要求 0（顧客も手続きも作らない）",
    c4.status === 503 && c4.error === "not_configured" && c4.message === notConfigured && c4.provider.length === 0, JSON.stringify(c4));
  ok("受付の条件 C4（守り）: お支払いの管理は今の読み方のまま（表が無ければ行なし → 404 no_subscription・決済の会社へ出ない）",
    c4Portal[0] === 404 && c4Portal[1] === "no_subscription" && c4Portal[2] === 0, JSON.stringify(c4Portal));
  // C5: AI の無料の上限の答えの「Pro なら…」（api/_lib/shared.js canOfferPro）も同じ条件。同じ人が無料の 1 回を使い切った 2 回目で見る
  const aiOffer = async (over, scope) => {
    fresh();
    setEnv(over);
    const user = { id: U3, email: "", token: "tok-u3" };
    const req = { method: "POST", headers: { authorization: "Bearer tok-u3" } };
    const first = typeof shared.aiTake === "function" ? await shared.aiTake(req, fakeRes(), user, { scope, limit: 1, proLimit: 5 }) : null;
    if (typeof first === "function") first();
    const second = fakeRes();
    if (typeof shared.aiTake === "function") await shared.aiTake(req, second, user, { scope, limit: 1, proLimit: 5 });
    return { first: typeof first, status: second.statusCode, body: second.body ?? null };
  };
  const offOffer = await aiOffer({ STRIPE_WEBHOOK_SECRET: null, SUPABASE_SERVICE_ROLE_KEY: null }, "b94-offer-off");
  const onOffer = await aiOffer({}, "b94-offer-on");
  ok("受付の条件 C5（Batch 94）: AI の無料の上限の答えの「Pro なら…」も 4 つそろうまで出さない（秘密鍵と月額の Price だけでは upgrade:false・offer なし）・4 つそろえば upgrade:true・「Pro なら1日5回」",
    offOffer.first === "function" && offOffer.status === 429 && offOffer.body?.error === "daily_limit" && offOffer.body?.upgrade === false && !Object.hasOwn(offOffer.body ?? {}, "offer")
      && onOffer.status === 429 && onOffer.body?.upgrade === true && onOffer.body?.offer === "Pro なら1日5回",
    JSON.stringify({ offOffer, onOffer }));
  setEnv();
}

// ===== 7e. 本人確認が答えないとき（Batch 94。DECISION §2 H）: 加入の口とお支払いの管理の口は、本人確認を確かめられない（4 秒で打ち切り・通信の失敗・
// 本人確認の 5xx）と 502 auth_unavailable「いまは確かめられない。少し待ってもう一度」で答える。前は 401 login_required（ログインし直しても直らない）。
// 鍵が違う（401）ときは今どおり 401 login_required。どちらも決済の会社と加入の表には出ない。ログには種類と番号だけ（トークン・メール・鍵を書かない）。
// verifyUserFull の約束（何があっても null）と AI の口は今のまま
{
  const shared = await load("api/_lib/shared.js");
  const UNAVAILABLE = "いまは確かめられない。少し待ってもう一度";
  const beyondAuth = () => calls.filter((c) => !(c.origin === DB && c.path === "/auth/v1/user")).map((c) => `${c.method} ${c.path}`);
  const authAsked = () => calls.filter((c) => c.origin === DB && c.path === "/auth/v1/user").length;
  // 加入の口とお支払いの管理の口を、本人確認の答え方 mode で 1 回ずつ呼ぶ（ログは消さずに、この呼び出しの分だけ切り出す）
  const both = async (mode, token = "tok-u1") => {
    const rows = [];
    for (const [name, handler, body] of [["checkout", checkout, { interval: "month" }], ["portal", portal, {}]]) {
      fresh();
      setEnv();
      AUTH.mode = mode;
      const from = logs.length;
      const res = await invoke(handler, post(body, token));
      rows.push({ name, mode, status: res.statusCode, error: res.body?.error ?? null, message: res.body?.message ?? null, beyond: beyondAuth(), asked: authAsked(), logs: logs.slice(from) });
    }
    return rows;
  };
  const unavailableOk = (r, kind) => r.status === 502 && r.error === "auth_unavailable" && r.message === UNAVAILABLE && r.beyond.length === 0 && r.asked === 1
    && r.logs.some((l) => l.includes(kind));
  const quietLogs = (rows) => rows.every((r) => r.logs.every((l) => !/tok-u\d|@example\.com|test-|db\.test|Bearer/.test(l)));
  // H1: 打ち切りの例外・通信の失敗
  const h1 = [...(await both("timeout")), ...(await both("network"))];
  ok("本人確認 H1（Batch 94）: 本人確認が打ち切り（TimeoutError）・通信の失敗なら、加入の口もお支払いの管理の口も 502 auth_unavailable「いまは確かめられない。少し待ってもう一度」（401 にしない）・決済の会社と加入の表に出ない・ログに種類（timeout・network）",
    h1.length === 4 && h1.every((r) => unavailableOk(r, r.mode)), JSON.stringify(h1.map(({ beyond, ...r }) => ({ ...r, beyond: beyond.length }))));
  // H1b: 答えないまま（本物の打ち切り）。打ち切りの 4 秒（AbortSignal.timeout(4000)）を検査の中だけ 20ms に縮めて、要求に合図が付いていることも見る
  const seen = [];
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = (ms) => {
    seen.push(ms);
    return realTimeout.call(AbortSignal, 20);
  };
  let h1b;
  try {
    h1b = await both("hang");
  } finally {
    AbortSignal.timeout = realTimeout;
  }
  ok("本人確認 H1b（Batch 94）: 本人確認が答えないままなら 4 秒で打ち切る（要求に打ち切りの合図・AbortSignal.timeout(4000)）→ 2 つの口とも 502 auth_unavailable",
    seen.length === 2 && seen.every((ms) => ms === 4000) && h1b.every((r) => unavailableOk(r, "timeout")), JSON.stringify({ seen, rows: h1b.map((r) => [r.name, r.status, r.error, r.logs]) }));
  // H2: 本人確認の 5xx は確かめられない（502）。401 は鍵が違う（今どおり 401 login_required）。トークンが無ければ本人確認に聞かずに 401
  const h2 = [...(await both(500)), ...(await both(503))];
  ok("本人確認 H2（Batch 94）: 本人確認が 500・503 で答えたら、2 つの口とも 502 auth_unavailable（ログに番号）",
    h2.length === 4 && h2.every((r) => unavailableOk(r, String(r.mode))), JSON.stringify(h2.map((r) => [r.name, r.mode, r.status, r.error, r.logs])));
  // H2b: 本人確認が混み合い（429）・待ち切れ（408）で答えたときも確かめられない（502）。ログインし直しても直らないので「ログインが要る」と言わない
  const h2b = [...(await both(429)), ...(await both(408))];
  ok("本人確認 H2b（Batch 94 の直し）: 本人確認が 429・408 で答えたら、2 つの口とも 502 auth_unavailable（401 にしない・ログに番号）",
    h2b.length === 4 && h2b.every((r) => unavailableOk(r, String(r.mode))), JSON.stringify(h2b.map((r) => [r.name, r.mode, r.status, r.error, r.logs])));
  const wrong = [...(await both(401)), ...(await both(null, "tok-nobody")), ...(await both(null, ""))];
  ok("本人確認 H2（Batch 94・守り）: 鍵が違う（本人確認が 401・知らないトークン）・トークンが無いときは今どおり 401 login_required「加入にはログインが必要です。」・決済の会社に出ない（トークンが無ければ本人確認にも聞かない）",
    wrong.length === 6 && wrong.every((r, i) => r.status === 401 && r.error === "login_required" && r.message === lib.MESSAGES?.login && r.beyond.length === 0 && r.asked === (i >= 4 ? 0 : 1)),
    JSON.stringify(wrong.map((r) => [r.name, r.mode, r.status, r.error, r.asked])));
  // H3: ログには種類と番号だけ
  ok("本人確認 H3（Batch 94・守り）: 確かめられないときのログにトークン・メール・鍵・相手の所を書かない（種類と番号だけ）",
    quietLogs([...h1, ...h1b, ...h2, ...h2b, ...wrong]), JSON.stringify([...h1, ...h1b, ...h2].flatMap((r) => r.logs).slice(0, 6)));
  // 守り: verifyUserFull の約束（何があっても null。投げない）と AI の口（本人確認が 500 でも今どおり 401 login_required）
  const fullOf = async (mode, token = "tok-u1") => {
    fresh();
    AUTH.mode = mode;
    try {
      const user = await shared.verifyUserFull(`Bearer ${token}`);
      return user === null ? "null" : user?.id ?? "?";
    } catch (error) {
      return `throw ${error?.name}`;
    }
  };
  const fulls = [await fullOf("timeout"), await fullOf("network"), await fullOf(500), await fullOf(401), await fullOf(null)];
  fresh();
  setEnv({ ANTHROPIC_API_KEY: "test-ai-key" });
  AUTH.mode = 500;
  const aiRes = fakeRes();
  const aiUser = typeof shared.aiGate === "function" ? await shared.aiGate({ method: "POST", headers: { authorization: "Bearer tok-u1" } }, aiRes) : "none";
  ok("本人確認（Batch 94・守り）: verifyUserFull は今の約束のまま（打ち切り・通信の失敗・500・401 は null で投げない・本人なら id）・AI の口は本人確認が 500 でも今どおり 401 login_required",
    JSON.stringify(fulls) === JSON.stringify(["null", "null", "null", "null", U1]) && aiUser === null && aiRes.statusCode === 401 && aiRes.body?.error === "login_required",
    JSON.stringify({ fulls, ai: [aiRes.statusCode, aiRes.body?.error] }));
  AUTH.mode = null;
  setEnv();
}

// ===== 8. 価格（config）と比較表の AI の回数 =====
{
  fresh();
  setEnv({ STRIPE_SECRET_KEY: null, STRIPE_PRICE_MONTHLY: null });
  let res = await invoke(config, { method: "GET", headers: {} });
  ok("価格: 鍵が無い（受付前）は 200 { configured:false, prices:[] }・決済の会社に出ない", res.statusCode === 200 && res.body?.configured === false && Array.isArray(res.body?.prices) && res.body.prices.length === 0 && res.body.trialMonths === 0 && calls.length === 0, JSON.stringify(res.body));
  ok("価格: 受付前でも AI の回数の欄はある（AI の鍵が無ければ null）", Object.hasOwn(res.body || {}, "ai") && res.body.ai === null, JSON.stringify(res.body));
  setEnv({ STRIPE_SECRET_KEY: null, STRIPE_PRICE_MONTHLY: null, ANTHROPIC_API_KEY: "test-ai-key" });
  res = await invoke(config, { method: "GET", headers: {} });
  ok("価格: AI の鍵があれば ai.explain に 1 日の回数（無料 3・Pro 60。api/explain-word.js の既定と同じ）", JSON.stringify(res.body?.ai) === JSON.stringify({ explain: { free: 3, pro: 60 } }), JSON.stringify(res.body?.ai));
  setEnv({ ANTHROPIC_API_KEY: "test-ai-key", EXPLAIN_WORD_DAILY_LIMIT: "5", EXPLAIN_WORD_DAILY_LIMIT_PRO: "80" });
  res = await invoke(config, { method: "GET", headers: {} });
  const month = res.body?.prices?.find((p) => p.interval === "month");
  ok("価格: 受付中は月額の金額を Price から（980・jpy）・無料期間 1 か月と終わりの時刻", res.statusCode === 200 && res.body.configured === true && month?.amount === 980 && month.currency === "jpy" && res.body.trialMonths === 1 && res.body.trialDays === 0 && typeof res.body.trialEndsAt === "string" && res.body.prices.length === 1, JSON.stringify(res.body));
  ok("価格: AI の回数は環境変数（EXPLAIN_WORD_DAILY_LIMIT・_PRO）に従う", JSON.stringify(res.body?.ai) === JSON.stringify({ explain: { free: 5, pro: 80 } }), JSON.stringify(res.body?.ai));
  ok("価格: 鍵・メール・顧客の番号を応答に入れない", !JSON.stringify(res.body).match(/test-secret-key|test-ai-key|@|cus_/));
  setEnv({ STRIPE_PRICE_MONTHLY: "price_missing" });
  res = await invoke(config, { method: "GET", headers: {} });
  ok("価格: 月額の Price が取れないと 502", res.statusCode === 502 && res.body?.error === "upstream");

  // AI の回数の決まり（api/_lib/aiLimits.js）。api/explain-word.js のゲートも同じ関数を読む（数を 2 か所に書かない）
  ok("AI の回数: api/_lib/aiLimits.js がある", typeof ai.explainWordLimits === "function" && typeof ai.aiConfigured === "function", ai.loadError || "");
  if (typeof ai.explainWordLimits === "function") {
    eq("AI の回数: 既定は無料 3・Pro 60", ai.explainWordLimits({}), { free: 3, pro: 60 });
    eq("AI の回数: 環境変数で変わる・読めない値は既定", [ai.explainWordLimits({ EXPLAIN_WORD_DAILY_LIMIT: "4", EXPLAIN_WORD_DAILY_LIMIT_PRO: "40" }), ai.explainWordLimits({ EXPLAIN_WORD_DAILY_LIMIT: "x", EXPLAIN_WORD_DAILY_LIMIT_PRO: "0" })], [{ free: 4, pro: 40 }, { free: 3, pro: 60 }]);
    eq("AI の回数: 鍵の有無", [ai.aiConfigured({}), ai.aiConfigured({ ANTHROPIC_API_KEY: "k" })], [false, true]);
  }
  const explain = fs.readFileSync(path.join(ROOT, "api", "explain-word.js"), "utf8");
  ok("AI の回数: api/explain-word.js のゲートは api/_lib/aiLimits.js の explainWordLimits から数を読む（既定の数を自分で持たない）", /explainWordLimits\(\)/.test(explain) && !/EXPLAIN_WORD_DAILY_LIMIT\)\s*\|\|/.test(explain));
  // Batch 88: カードの自動生成の回数も同じ 1 か所（既定 2・20 は前と同じ）。比較表（config の ai）は前のとおり覚え方だけ
  ok("AI の回数: カードの自動生成の回数も api/_lib/aiLimits.js（cardGenLimits）", typeof ai.cardGenLimits === "function");
  if (typeof ai.cardGenLimits === "function") {
    eq("AI の回数: カードの既定は無料 2・Pro 20・環境変数で変わる・読めない値は既定",
      [ai.cardGenLimits({}), ai.cardGenLimits({ CARD_GEN_DAILY_LIMIT: "3", CARD_GEN_DAILY_LIMIT_PRO: "30" }), ai.cardGenLimits({ CARD_GEN_DAILY_LIMIT: "x", CARD_GEN_DAILY_LIMIT_PRO: "0" })],
      [{ free: 2, pro: 20 }, { free: 3, pro: 30 }, { free: 2, pro: 20 }]);
  }
  const cardsSource = fs.readFileSync(path.join(ROOT, "api", "generate-cards.js"), "utf8");
  ok("AI の回数: api/generate-cards.js も aiLimits の cardGenLimits から数を読む（既定の数を自分で持たない）", /cardGenLimits\(\)/.test(cardsSource) && !/CARD_GEN_DAILY_LIMIT(_PRO)?\)\s*\|\|/.test(cardsSource));
}

// ===== 9. Pro の判定・無料期間の終わり・form の書き方 =====
{
  const now = Date.parse("2026-11-09T00:00:00Z");
  const day = 86400000;
  const row = (status, end) => ({ status, current_period_end: end === null ? null : new Date(now + end * day).toISOString() });
  eq("Pro の判定: active・trialing・past_due で期限の前は Pro", ["active", "trialing", "past_due"].map((s) => lib.isProRow(row(s, 5), now)), [true, true, true]);
  eq("Pro の判定: canceled・unpaid・incomplete・none・行なしは無料", [...["canceled", "unpaid", "incomplete", "incomplete_expired", "none"].map((s) => lib.isProRow(row(s, 5), now)), lib.isProRow(null, now)], [false, false, false, false, false, false]);
  eq("Pro の判定: 期限から 3 日は猶予（2.9 日後は Pro・3.1 日後は無料）・期限が無ければ Pro", [lib.isProRow(row("past_due", -2.9), now), lib.isProRow(row("active", -3.1), now), lib.isProRow(row("active", null), now)], [true, false, true]);
  ok("Pro の判定: 読めない期限は無料", lib.isProRow({ status: "active", current_period_end: "not a date" }, now) === false);
  eq("CRM の形（planOf）: Pro・状態・期限・月", lib.planOf(row("trialing", 5), now), { plan: "pro", planStatus: "trialing", planPeriodEnd: new Date(now + 5 * day).toISOString(), planInterval: null });

  setEnv({ STRIPE_TRIAL_MONTHS: "1" });
  const jst = (iso) => new Date(lib.trialEndUnix(new Date(iso)) * 1000 + 9 * 3600000).toISOString().slice(0, 16);
  eq("無料期間の終わり: 日本時間で同じ日付の 1 か月後（朝 9 時前の加入も日本時間の日付で数える）", [jst("2026-11-08T23:30:00Z"), jst("2026-11-09T12:00:00Z")], ["2026-12-09T08:30", "2026-12-09T21:00"]);
  eq("無料期間の終わり: 無い日は月末に寄せる（1/31 → 2/28・3/31 → 4/30）・年をまたぐ", [jst("2027-01-31T01:00:00Z"), jst("2027-03-31T01:00:00Z"), jst("2026-12-15T03:00:00Z")], ["2027-02-28T10:00", "2027-04-30T10:00", "2027-01-15T12:00"]);
  setEnv({ STRIPE_TRIAL_MONTHS: "2" });
  eq("無料期間の終わり: 2 か月", jst("2026-11-09T03:00:00Z"), "2027-01-09T12:00");
  setEnv({ STRIPE_TRIAL_MONTHS: null });
  eq("無料期間: 月の指定が無ければ 0", lib.trialEndUnix(new Date(now)), 0);
  const parse = (env) => {
    setEnv(env);
    return [lib.trialMonths(), lib.trialDays()];
  };
  eq("無料期間: 読めない・0・負の値は 0、小数は切り捨て", [parse({ STRIPE_TRIAL_MONTHS: "abc", STRIPE_TRIAL_DAYS: "-3" }), parse({ STRIPE_TRIAL_MONTHS: "1.9", STRIPE_TRIAL_DAYS: "7.5" })], [[0, 0], [1, 7]]);
  setEnv();
  ok("受付中の判定: 秘密鍵・月額の Price・署名の鍵・service role の 4 つがそろうときだけ（Batch 94。どれか 1 つを外すと受付前）",
    lib.billingConfigured() === true && (setEnv({ STRIPE_PRICE_MONTHLY: null }), lib.billingConfigured()) === false && (setEnv({ STRIPE_SECRET_KEY: null }), lib.billingConfigured()) === false
      && (setEnv({ STRIPE_WEBHOOK_SECRET: null }), lib.billingConfigured()) === false && (setEnv({ SUPABASE_SERVICE_ROLE_KEY: null }), lib.billingConfigured()) === false);
  setEnv();
  eq("form: ネストは a[b][c]・配列は a[0]・空の値は送らない（確定の画面の文も同じ書き方）",
    lib.encodeForm({ mode: "subscription", line_items: [{ price: "p", quantity: 1 }], custom_text: { submit: { message: "毎月 → 解約" } }, skip: null }),
    "mode=subscription&line_items%5B0%5D%5Bprice%5D=p&line_items%5B0%5D%5Bquantity%5D=1&custom_text%5Bsubmit%5D%5Bmessage%5D=%E6%AF%8E%E6%9C%88%20%E2%86%92%20%E8%A7%A3%E7%B4%84");
}

// ===== 10. ログに鍵・メール・顧客や契約の番号を書かない／検査の外へ出ない =====
ok("ログ: 鍵（秘密鍵・署名の鍵・service role・AI の鍵・公開の鍵）・メール・顧客や契約の番号・ログインのトークンを書かない（Batch 94 からトークンと公開の鍵も見る）",
  !logs.some((l) => /test-secret-key|test-signing-secret|test-service-role|test-ai-key|test-anon-key|@example\.com|cus_|sub_test|tok-u\d|tok-nobody|Bearer /.test(l)), logs.filter((l) => /test-|@|cus_|sub_|tok-|Bearer/.test(l)).slice(0, 3).join(" | "));
ok("偽物の知らない要求は無い（どの要求も偽の相手が答えた）", unexpected.length === 0, unexpected.join(", "));

out(`test-billing: ${passed} passed, ${failed} failed${rootArg > 0 ? `（--root ${ROOT}）` : ""}`);
process.exit(failed ? 1 : 0);
