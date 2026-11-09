// api の守りの単体（Batch 88。docs/SECURITY.md）:
//   AI の入口（api/_lib/shared.js の aiGate・aiTake、api/explain-word.js、api/generate-cards.js、api/_lib/aiLimits.js）:
//     ログインは確認済みのメールで匿名でない人だけ（ほかは 401 でモデルを呼ばない）・入力を確かめてから回数を取る（まちがった入力は回数を減らさない）・
//     本文が普通の object でなくても落ちない・回数はデータベースの ai_take で全部のインスタンスに 1 つ（無い・失敗ならインスタンスのメモリー）・
//     同じ人の同時の 2 つ目は 429 busy・昨日より前のメモリーの項目を捨てる・カードの自動生成は CARD_GEN_ENABLED=1 まで止めてある。
//   ほか（Batch 88 の A6）: 管理の門（ADMIN_USER_IDS があればメールでは通さない・未ログインは設定の有無より先に 401・設定が無い 503 の字に環境変数の名前を出さない）・
//     動線の数の行の読み残し（50 ページで止めて truncated）・cron の鍵の比べ方（timingSafeEqual）。
// ネットワークには出ない: fetch を差し替え、認証・REST・ai_take・AI の先を偽物で答える。子のプロセス（= 別のインスタンス）は
//   この検査が手元（127.0.0.1）に立てた偽のサーバーにだけつなぐ（子の fetch はどの宛先も手元へ向け直す）。鍵は偽の値。
// 使い方: node scripts/test-api-guard.mjs [--root <木>]
//   --root は別の木（直す前の main を git archive した所など。api/ と node_modules があればよい）の api/ に同じ検査を流す（直す前に落ちることを確かめる）
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ANON = "test-anon-key";
const WORD = { word: { en: "welcome", ja: "歓迎する" } };
const CARD_TEXT = { text: "顧客獲得単価（CPA）と広告費用対効果（ROAS）の関係を説明する研修資料の一文です。" };
const EXPLAIN_ANSWER = { mnemonic: "ウェルカムの音で迎える", example: "Welcome to our team.", exampleJa: "チームへようこそ。", pitfall: "" };
const CARDS_ANSWER = { cards: [{ q: "広告の費用を獲得した顧客の数で割った値", answer: "cpa", explain: "顧客 1 人を得るのにかかった費用", accept: [] }] };

// 認証の相手が返す人（トークン → 人）。確認済みのメール・確認の無い人・匿名の人・Pro の人と、検査ごとに別の人（回数が混ざらない）
const U = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const confirmed = (n, extra = {}) => ({ id: U(n), email: `user${n}@example.test`, email_confirmed_at: "2026-01-01T00:00:00Z", ...extra });
const USERS = {
  "tok-free": confirmed(1),
  "tok-unconfirmed": { id: U(2), email: "user2@example.test" },
  "tok-anon": { id: U(3), email: "", confirmed_at: "2026-01-01T00:00:00Z", is_anonymous: true },
  "tok-pro": confirmed(4),
  "tok-busy": confirmed(5),
  "tok-input": confirmed(6),
  "tok-take": confirmed(7),
  "tok-take2": confirmed(8),
  "tok-day-a": confirmed(9),
  "tok-day-b": confirmed(10),
  "tok-day-c": confirmed(11),
  "tok-cards": confirmed(12),
  "tok-multi": confirmed(13),
  "tok-fallback": confirmed(14),
  "tok-other": confirmed(15),
  "tok-fail": confirmed(16),
  "tok-weird": confirmed(17),
  "tok-legacy": { id: U(18), email: "user18@example.test", confirmed_at: "2026-01-01T00:00:00Z" },
  "tok-admin-id": confirmed(20),
  "tok-admin-mail": { id: U(21), email: "boss@example.test", email_confirmed_at: "2026-01-01T00:00:00Z" }
};
const PRO_ROW = { user_id: U(4), status: "active", current_period_end: new Date(Date.now() + 20 * 86400000).toISOString(), stripe_customer_id: null, stripe_subscription_id: null, price_id: null, plan_interval: "month", cancel_at_period_end: false, event_created: 1 };
const modelAnswer = (body) => {
  const cards = String(body).includes('"cards"');
  return { id: "msg_test", type: "message", role: "assistant", model: "test-model", stop_reason: "end_turn", stop_sequence: null, content: [{ type: "text", text: JSON.stringify(cards ? CARDS_ANSWER : EXPLAIN_ANSWER) }], usage: { input_tokens: 1, output_tokens: 1 } };
};

function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: undefined, ended: false };
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
  res.end = () => {
    res.ended = true;
    return res;
  };
  return res;
}
const aiReq = (token, body, headers = {}) => ({ method: "POST", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...headers }, body });

// ===== 子のプロセス（別のインスタンス）: node test-api-guard.mjs --child <木> <手元のポート> <トークン> <回数> =====
if (process.argv[2] === "--child") {
  const [root, port, token, times] = process.argv.slice(3);
  const local = `http://127.0.0.1:${port}`;
  const realFetch = globalThis.fetch;
  // どの宛先も手元の偽のサーバーへ（AI の先の既定の宛先も）。外へは出ない
  globalThis.fetch = (url, init) => {
    const u = new URL(url instanceof Request ? url.url : String(url));
    const target = `${local}${u.pathname}${u.search}`;
    return url instanceof Request ? realFetch(new Request(target, url)) : realFetch(target, init);
  };
  console.log = console.error;
  const explain = (await import(pathToFileURL(path.join(root, "api", "explain-word.js")).href)).default;
  const statuses = [];
  for (let i = 0; i < Number(times); i++) {
    const res = fakeRes();
    await explain(aiReq(token, WORD), res);
    statuses.push(res.statusCode);
  }
  process.stdout.write(`${JSON.stringify({ statuses })}\n`);
  process.exit(0);
}

// ===== ここから親（検査） =====
const rootArg = process.argv.indexOf("--root");
const ROOT = rootArg > 0 ? path.resolve(process.argv[rootArg + 1]) : path.join(path.dirname(SELF), "..");

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(5);
  }
  return cond();
}

// ---- 環境（偽の値。読み込みの前に置く: shared.js は SUPABASE_URL を読み込みの時に読む） ----
const DB = "https://db.test";
process.env.SUPABASE_URL = DB;
process.env.SUPABASE_ANON_KEY = ANON;
process.env.ANTHROPIC_API_KEY = "test-ai-key";
for (const name of ["EXPLAIN_WORD_DAILY_LIMIT", "EXPLAIN_WORD_DAILY_LIMIT_PRO", "CARD_GEN_DAILY_LIMIT", "CARD_GEN_DAILY_LIMIT_PRO", "CARD_GEN_ENABLED", "STRIPE_SECRET_KEY", "STRIPE_PRICE_MONTHLY"]) delete process.env[name];

// ---- 偽の相手（この検査のプロセスの fetch） ----
// take.mode: missing（関数が無い: 404 PGRST202）・count（人と scope ごとの数を 1 つ増やして返す）・error（500）・weird（数でない答え）
const S = { calls: [], unexpected: [], model: 0, modelGate: null, modelFail: 0, take: { mode: "missing", counts: new Map() }, funnelPages: 0 };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "request-id": "req_test" } });
const plainHeaders = (h) => Object.fromEntries(Object.entries(h instanceof Headers ? Object.fromEntries(h) : h || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url instanceof Request ? url.url : String(url));
  const call = { origin: u.origin, method: String(init.method || "GET").toUpperCase(), path: u.pathname, headers: plainHeaders(init.headers), body: typeof init.body === "string" ? init.body : "" };
  S.calls.push(call);
  if (u.origin === DB) return dbRoute(call);
  if (u.pathname.endsWith("/v1/messages")) {
    S.model++;
    if (S.modelGate) await S.modelGate;
    if (S.modelFail > 0) {
      S.modelFail--;
      return json(400, { type: "error", error: { type: "invalid_request_error", message: "test failure" } });
    }
    return json(200, modelAnswer(call.body));
  }
  S.unexpected.push(`${call.method} ${u.origin}${u.pathname}`);
  return json(404, {});
};
function dbRoute(call) {
  const token = String(call.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const user = USERS[token];
  if (call.path === "/auth/v1/user") return user ? json(200, user) : json(401, { msg: "invalid token" });
  if (call.path === "/rest/v1/subscriptions") return json(200, user && user.id === PRO_ROW.user_id ? [PRO_ROW] : []);
  if (call.path === "/rest/v1/rpc/ai_take") {
    if (S.take.mode === "missing") return json(404, { code: "PGRST202", message: "Could not find the function" });
    if (S.take.mode === "error") return json(500, { code: "XX000" });
    if (S.take.mode === "weird") return json(200, "abc");
    if (!user || call.headers.apikey !== ANON) return json(401, {});
    const key = `${user.id}:${JSON.parse(call.body || "{}").p_scope}`;
    const n = (S.take.counts.get(key) || 0) + 1;
    S.take.counts.set(key, n);
    return json(200, n);
  }
  if (call.path === "/rest/v1/daily_scores") return json(200, [{ day: "2026-11-09" }]);
  if (call.path === "/rest/v1/rpc/admin_funnel_counts") return json(404, { code: "PGRST202", message: "Could not find the function" });
  if (call.path === "/rest/v1/funnel_events") {
    // 動線の行: 1 ページ 1000 行で、全部の数は言わない（*）。前の形が読み続けないよう 60 ページで終える
    S.funnelPages++;
    if (S.funnelPages > 60) return json(200, []);
    const [from, to] = String(call.headers.range || "0-999").split("-").map(Number);
    const rows = Array.from({ length: to - from + 1 }, (_, k) => ({ device_id: `d${from + k}`, step: "first_visit", source: null, day: "2026-11-09" }));
    return new Response(JSON.stringify(rows), { status: 206, headers: { "content-type": "application/json", "content-range": `${from}-${to}/*` } });
  }
  S.unexpected.push(`${call.method} ${call.path}`);
  return json(404, {});
}
const takeCalls = () => S.calls.filter((c) => c.path === "/rest/v1/rpc/ai_take");

// 調べる側のログ（失敗の 1 行など）はここに取る
const logs = [];
const keep = (...args) => logs.push(args.map(String).join(" "));
Object.assign(console, { log: keep, error: keep, warn: keep });

const load = async (rel) => {
  try {
    return await import(pathToFileURL(path.join(ROOT, rel)).href);
  } catch (error) {
    return { loadError: String(error?.message || error) };
  }
};
const shared = await load("api/_lib/shared.js");
const explainMod = await load("api/explain-word.js");
const cardsMod = await load("api/generate-cards.js");
const explain = explainMod.default;
const cards = cardsMod.default;
if (!explain || !cards || shared.loadError) {
  out(`api の読み込みに失敗: ${shared.loadError ?? explainMod.loadError ?? cardsMod.loadError ?? "handler が無い"}`);
  process.exit(1);
}
async function invoke(handler, req) {
  const res = fakeRes();
  try {
    await handler(req, res);
  } catch (error) {
    // 配信の側は投げた関数に 500 を返す
    res.threw = String(error?.name || error);
    res.statusCode = 500;
  }
  return res;
}
const brief = (res) => JSON.stringify({ status: res.statusCode, body: res.body, threw: res.threw });

// ===== 1. ログインは確認済みのメールで匿名でない人だけ =====
{
  S.take.mode = "missing";
  let model = S.model;
  let res = await invoke(explain, aiReq("tok-free", WORD));
  ok("ログイン: 確認済みのメールの人は 200（覚え方が返る）・モデルを 1 回呼ぶ", res.statusCode === 200 && res.body?.mnemonic === EXPLAIN_ANSWER.mnemonic && S.model === model + 1, brief(res));
  const callsBefore = S.calls.length;
  model = S.model;
  res = await invoke(explain, aiReq("tok-unconfirmed", WORD));
  ok("ログイン: メールの確認が無い人は 401 login_required（字は前と同じ）・モデルも回数も呼ばない",
    res.statusCode === 401 && res.body?.error === "login_required" && res.body?.message === "ログインすると使える（無料）" && S.model === model && !S.calls.slice(callsBefore).some((c) => c.path === "/rest/v1/rpc/ai_take"), brief(res));
  res = await invoke(explain, aiReq("tok-anon", WORD));
  ok("ログイン: 匿名の人（is_anonymous）は確認の時刻があっても 401・モデルを呼ばない", res.statusCode === 401 && res.body?.error === "login_required" && S.model === model, brief(res));
  res = await invoke(explain, aiReq("tok-legacy", WORD));
  ok("ログイン: confirmed_at だけの人（前からの確認の形）は確認済みとして 200", res.statusCode === 200, brief(res));
  res = await invoke(explain, aiReq("", WORD));
  ok("ログイン: トークンが無ければ 401", res.statusCode === 401 && res.body?.error === "login_required", brief(res));
  if (typeof shared.verifyUserFull === "function") {
    const anon = await shared.verifyUserFull("Bearer tok-anon");
    const free = await shared.verifyUserFull("Bearer tok-free");
    eq("ログイン: verifyUserFull は isAnonymous を返す（匿名の人だけ真）", [anon?.isAnonymous, free?.isAnonymous], [true, false]);
  }
}

// ===== 2. 本文と入力: 落ちない・まちがった入力は回数を減らさない =====
{
  S.take.mode = "missing";
  const bodies = ["null", null, "[]", "5", '"x"', [], 7, "{not json"];
  const results = [];
  for (const body of bodies) results.push(await invoke(explain, aiReq("tok-input", body)));
  ok("本文: 'null'・null・配列・数・文字列・壊れた JSON は落ちずに 400 bad_word",
    results.every((r) => r.statusCode === 400 && r.body?.error === "bad_word" && !r.threw), results.map(brief).join(" "));
  if (typeof shared.readBody === "function") {
    eq("本文: readBody は普通の object だけを返す（ほかは {}）",
      [shared.readBody({ body: "null" }), shared.readBody({ body: [1] }), shared.readBody({ body: "5" }), shared.readBody({ body: '{"a":1}' }), shared.readBody({ body: { a: 2 } }), shared.readBody({ body: Buffer.from('{"a":3}') }), shared.readBody({ body: undefined })],
      [{}, {}, {}, { a: 1 }, { a: 2 }, { a: 3 }, {}]);
  }
  const callsBefore = S.calls.length;
  const model = S.model;
  await invoke(explain, aiReq("tok-input", { word: {} }));
  await invoke(explain, aiReq("tok-input", { word: { en: "x" } }));
  ok("入力: まちがった入力ではモデルも ai_take も呼ばない", S.model === model && !S.calls.slice(callsBefore).some((c) => c.path === "/rest/v1/rpc/ai_take"));
  const good = [];
  for (let i = 0; i < 4; i++) good.push((await invoke(explain, aiReq("tok-input", WORD))).statusCode);
  eq("入力: まちがった入力の後でも、正しい入力は無料の 3 回まで 200（4 回目が 429）", good, [200, 200, 200, 429]);
}

// ===== 3. 回数は ai_take（全部のインスタンスで 1 つ）・無い／失敗ならメモリー =====
{
  S.take.mode = "count";
  S.take.counts.set(`${U(7)}:explain`, 3);
  let callsBefore = S.calls.length;
  let model = S.model;
  let res = await invoke(explain, aiReq("tok-take", WORD));
  const take = S.calls.slice(callsBefore).find((c) => c.path === "/rest/v1/rpc/ai_take");
  ok("ai_take: 本人のトークンと公開の鍵で POST /rest/v1/rpc/ai_take { p_scope: explain } を呼ぶ",
    take?.method === "POST" && take.headers.authorization === "Bearer tok-take" && take.headers.apikey === ANON && JSON.stringify(JSON.parse(take.body || "{}")) === JSON.stringify({ p_scope: "explain" }), JSON.stringify(take ?? null));
  ok("ai_take: 返った数（ほかのインスタンスで 3 回使った後の 4）が無料の上限を超えたら 429 daily_limit・モデルを呼ばない",
    res.statusCode === 429 && res.body?.error === "daily_limit" && res.body?.message === "今日の無料ぶん（3回）は使い切った。" && S.model === model, brief(res));
  res = await invoke(explain, aiReq("tok-take2", WORD));
  ok("ai_take: 数が上限の中なら 200・数が 1 つ増える", res.statusCode === 200 && S.take.counts.get(`${U(8)}:explain`) === 1, brief(res));
  S.take.counts.set(`${U(4)}:explain`, 10);
  res = await invoke(explain, aiReq("tok-pro", WORD));
  ok("ai_take: Pro の人は Pro の上限（60）で見る（11 回目でも 200）", res.statusCode === 200, brief(res));

  for (const mode of ["error", "weird"]) {
    S.take.mode = mode;
    const user = mode === "error" ? "tok-fallback" : "tok-weird";
    const st = [];
    for (let i = 0; i < 4; i++) st.push((await invoke(explain, aiReq(user, WORD))).statusCode);
    eq(`ai_take: ${mode === "error" ? "失敗（500）" : "数でない答え"}ならこのインスタンスのメモリーで数える（3 回まで）`, st, [200, 200, 200, 429]);
  }
  S.take.mode = "missing";
}

// ===== 4. 同じ人の同時の 2 つ目は 429 busy =====
{
  let open;
  S.modelGate = new Promise((r) => (open = r));
  const model = S.model;
  const p1 = invoke(explain, aiReq("tok-busy", WORD));
  const reached = await waitFor(() => S.model === model + 1);
  const p2 = invoke(explain, aiReq("tok-busy", WORD));
  const r2 = await Promise.race([p2, sleep(800).then(() => null)]);
  const p3 = invoke(explain, aiReq("tok-other", WORD));
  await waitFor(() => S.model >= model + (r2 ? 2 : 3), 1500);
  open();
  S.modelGate = null;
  const [r1, , r3] = await Promise.all([p1, p2, p3]);
  ok("busy: 同じ人の処理中の 2 つ目は待たずに 429 busy（字は前と同じ）・モデルを呼ばない",
    reached && r2?.statusCode === 429 && r2.body?.error === "busy" && r2.body?.message === "混み合っている。少し待ってもう一度", r2 ? brief(r2) : "2 つ目もモデルを待った");
  ok("busy: 1 つ目は 200・ほかの人は止めない", r1.statusCode === 200 && r3.statusCode === 200, `${brief(r1)} ${brief(r3)}`);
  const r4 = await invoke(explain, aiReq("tok-busy", WORD));
  ok("busy: 終わった後の同じ人は 200（処理中の印は外れる）", r4.statusCode === 200, brief(r4));
  S.modelFail = 1;
  const r5 = await invoke(explain, aiReq("tok-fail", WORD));
  const r6 = await invoke(explain, aiReq("tok-fail", WORD));
  ok("busy: モデルが失敗しても印は外れる（502 の後の同じ人は 200）", r5.statusCode === 502 && r6.statusCode === 200, `${brief(r5)} ${brief(r6)}`);
}

// ===== 4b. 処理中の印は古くなったら効かない（Batch 88 の反証） =====
// 関数の時間切れ（vercel.json の maxDuration。最大 60 秒）で finally が走らないまま同じインスタンスが使い回されると、前は印が残り、
// その人は SDK の時間切れまでずっと 429 busy だった。90 秒より古い印は効かない。古い呼び出しが後から印を外しても、新しい印は外れない
{
  S.take.mode = "missing";
  const realNow = Date.now;
  const t0 = Date.UTC(2031, 0, 3, 9); // 下の 5 の日（1 月 10 日）より前: 5 が前の日の項目として捨てる
  const stale = { id: U(31), token: "tok-free", email: "user31@example.test", emailConfirmed: true, isAnonymous: false };
  const take = async () => {
    const res = fakeRes();
    const release = await shared.aiTake({ headers: {} }, res, stale, { scope: "explain", limit: 99 });
    return { status: res.statusCode, error: res.body?.error ?? null, release };
  };
  try {
    Date.now = () => t0;
    const a = await take(); // 終わらないまま（時間切れで finally が走らなかった形）
    Date.now = () => t0 + 30 * 1000;
    const b = await take();
    Date.now = () => t0 + 91 * 1000;
    const c = await take();
    a.release?.(); // 古い呼び出しが後から外す
    Date.now = () => t0 + 92 * 1000;
    const d = await take();
    c.release?.();
    const e = await take();
    e.release?.();
    eq("busy: 処理中の印は 30 秒後も効く（429）・91 秒後は古いので通る・古い呼び出しが後から外しても新しい印は残る（429）・新しい方を外せば通る",
      [typeof a.release, b.error, typeof c.release, d.error, typeof e.release], ["function", "busy", "function", "busy", "function"]);
  } finally {
    Date.now = realNow;
  }
}

// ===== 5. 昨日より前のメモリーの項目を捨てる（増やし続けない） =====
{
  S.take.mode = "missing";
  ok("メモリー: shared.js は aiMemory（回数・Pro の覚え・処理中の数）を出す", typeof shared.aiMemory === "function");
  if (typeof shared.aiMemory === "function") {
    const realNow = Date.now;
    const day = Date.UTC(2031, 0, 10, 12);
    try {
      Date.now = () => day;
      await invoke(explain, aiReq("tok-day-a", WORD));
      await invoke(explain, aiReq("tok-day-b", WORD));
      const first = shared.aiMemory();
      Date.now = () => day + 86400000;
      await invoke(explain, aiReq("tok-day-c", WORD));
      const second = shared.aiMemory();
      eq("メモリー: 日が替わると前の日の回数と古い Pro の覚えを捨てる（2 人 → 次の日の 1 人だけ）・処理中は 0",
        [first.usage, first.plans, second.usage, second.plans, second.busy], [2, 2, 1, 1, 0]);
    } finally {
      Date.now = realNow;
    }
  }
}

// ===== 6. カードの自動生成は CARD_GEN_ENABLED=1 まで止めてある =====
{
  const callsBefore = S.calls.length;
  let res = await invoke(cards, aiReq("tok-cards", CARD_TEXT));
  ok("カード: CARD_GEN_ENABLED が無いと 503 not_configured（字は前と同じ）・認証にもモデルにも出ない",
    res.statusCode === 503 && res.body?.error === "not_configured" && res.body?.message === "この機能は準備中" && S.calls.length === callsBefore, `${brief(res)} 要求 ${S.calls.length - callsBefore}`);
  process.env.CARD_GEN_ENABLED = "0";
  res = await invoke(cards, aiReq("tok-cards", CARD_TEXT));
  ok("カード: CARD_GEN_ENABLED=0 でも 503", res.statusCode === 503, brief(res));
  process.env.CARD_GEN_ENABLED = "1";
  res = await invoke(cards, aiReq("tok-unconfirmed", CARD_TEXT));
  ok("カード: 入れた後も、メールの確認が無い人は 401", res.statusCode === 401, brief(res));
  const st = [];
  st.push((await invoke(cards, aiReq("tok-cards", { text: "短い" }))).statusCode);
  st.push((await invoke(cards, aiReq("tok-cards", "null"))).statusCode);
  for (let i = 0; i < 3; i++) st.push((await invoke(cards, aiReq("tok-cards", CARD_TEXT))).statusCode);
  eq("カード: 入れた後は、まちがった入力（400）の後でも無料の 2 回まで 200（3 回目が 429）", st, [400, 400, 200, 200, 429]);
  delete process.env.CARD_GEN_ENABLED;
}

// ===== 7. 別のインスタンス（子のプロセス）: ai_take で数を 1 つにする・無ければインスタンスごと =====
{
  const M = { mode: "count", counts: new Map(), model: 0 };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const reply = (status, value) => {
        res.writeHead(status, { "content-type": "application/json", "request-id": "req_test" });
        res.end(JSON.stringify(value));
      };
      const user = USERS[String(req.headers.authorization || "").replace(/^Bearer\s+/i, "")];
      const p = new URL(req.url, "http://127.0.0.1").pathname;
      if (p === "/auth/v1/user") return user ? reply(200, user) : reply(401, {});
      if (p === "/rest/v1/subscriptions") return reply(200, []);
      if (p === "/rest/v1/rpc/ai_take") {
        if (M.mode === "missing") return reply(404, { code: "PGRST202", message: "Could not find the function" });
        if (!user || req.headers.apikey !== ANON) return reply(401, {});
        const key = `${user.id}:${JSON.parse(body || "{}").p_scope}`;
        const n = (M.counts.get(key) || 0) + 1;
        M.counts.set(key, n);
        return reply(200, n);
      }
      if (p.endsWith("/v1/messages")) {
        M.model++;
        return reply(200, modelAnswer(body));
      }
      return reply(404, {});
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const env = { ...process.env, SUPABASE_URL: `http://127.0.0.1:${port}`, SUPABASE_ANON_KEY: ANON, ANTHROPIC_API_KEY: "test-ai-key" };
  const run = promisify(execFile);
  const child = async (token, times) => {
    try {
      const { stdout } = await run(process.execPath, [SELF, "--child", ROOT, String(port), token, String(times)], { env, timeout: 60000 });
      return JSON.parse(stdout.trim().split("\n").pop()).statuses;
    } catch (error) {
      return [`子が落ちた: ${String(error?.message || error).slice(0, 120)}`];
    }
  };
  try {
    const four = [];
    for (let i = 0; i < 4; i++) four.push(...(await child("tok-multi", 1)));
    eq("インスタンス: 4 つの子が 1 回ずつ（同じ無料の人・同じ日）→ ai_take の数で 4 つ目は 429", four, [200, 200, 200, 429]);
    ok("インスタンス: モデルを呼んだのは 3 回だけ", M.model === 3, `モデル ${M.model} 回`);
    M.mode = "missing";
    const a = await child("tok-multi", 4);
    const b = await child("tok-multi", 1);
    eq("インスタンス: ai_take が無い（404 PGRST202）と、前のとおりインスタンスのメモリーで数える（1 つで 3 回まで・別のインスタンスは別）", [a, b], [[200, 200, 200, 429], [200]]);
  } finally {
    server.close();
  }
}

// ===== 8. 管理の門（Batch 88 A6。api/_lib/admin.js。docs/CRM.md） =====
const ADMIN_ENV = ["SUPABASE_SERVICE_ROLE_KEY", "ADMIN_EMAILS", "ADMIN_USER_IDS"];
const setAdminEnv = (over = {}) => {
  for (const name of ADMIN_ENV) delete process.env[name];
  Object.assign(process.env, over);
};
{
  const admin = await load("api/_lib/admin.js");
  const mailUser = { id: U(21), email: "boss@example.test", emailConfirmed: true };
  const idUser = { id: U(20), email: "other@example.test", emailConfirmed: true };
  setAdminEnv({ SUPABASE_SERVICE_ROLE_KEY: "test-service-role", ADMIN_EMAILS: "boss@example.test", ADMIN_USER_IDS: U(20) });
  eq("管理: ADMIN_USER_IDS が入っていれば、一覧のメールの確認済みアカウントでも管理者にしない（id の人だけ）", [admin.isAdmin(mailUser), admin.isAdmin(idUser)], [false, true]);
  setAdminEnv({ SUPABASE_SERVICE_ROLE_KEY: "test-service-role", ADMIN_EMAILS: "boss@example.test" });
  eq("管理: ADMIN_USER_IDS が無ければ前のとおり確認済みのメールで（確認の無いメールは通さない）", [admin.isAdmin(mailUser), admin.isAdmin({ ...mailUser, emailConfirmed: false })], [true, false]);
  setAdminEnv({});
  let res = fakeRes();
  let who = await admin.requireAdmin({ headers: {} }, res);
  ok("管理: 設定が無くても、未ログインは 401（設定の有無を先に言わない）", who === null && res.statusCode === 401 && res.body?.error === "login_required", brief(res));
  res = fakeRes();
  who = await admin.requireAdmin({ headers: { authorization: "Bearer tok-free" } }, res);
  ok("管理: ログインした人への「設定が無い」503 の字に環境変数の名前を出さない", who === null && res.statusCode === 503 && res.body?.error === "not_configured" && !/[A-Z]+_[A-Z_]+/.test(String(res.body?.message)), brief(res));
  setAdminEnv({ SUPABASE_SERVICE_ROLE_KEY: "test-service-role", ADMIN_EMAILS: "boss@example.test", ADMIN_USER_IDS: U(20) });
  res = fakeRes();
  who = await admin.requireAdmin({ headers: { authorization: "Bearer tok-admin-mail" } }, res);
  ok("管理: ADMIN_USER_IDS があると、一覧のメールの人は 403", who === null && res.statusCode === 403, brief(res));
  res = fakeRes();
  who = await admin.requireAdmin({ headers: { authorization: "Bearer tok-admin-id" } }, res);
  ok("管理: id の人は通る", who?.userId === U(20), brief(res));
}

// ===== 9. 動線の数: 行を読むのは 50 ページ（5 万行）まで（Batch 88 A6。api/admin/funnel.js） =====
{
  setAdminEnv({ SUPABASE_SERVICE_ROLE_KEY: "test-service-role", ADMIN_USER_IDS: U(20) });
  const funnel = (await load("api/admin/funnel.js")).default;
  S.funnelPages = 0;
  const res = await invoke(funnel, { method: "GET", headers: { authorization: "Bearer tok-admin-id" } });
  ok("動線の数: 関数が無いときの行の読み直しは 50 ページで止め、51 ページ目を読まない・応答に truncated: true",
    res.statusCode === 200 && res.body?.truncated === true && S.funnelPages === 50, `${res.statusCode} truncated=${res.body?.truncated} pages=${S.funnelPages}`);
  setAdminEnv({});
}

// ===== 10. cron の鍵の比べ方（Batch 88 A6。api/cron/keepalive.js） =====
{
  const cron = (await load("api/cron/keepalive.js")).default;
  process.env.CRON_SECRET = "test-cron-secret-0123456789";
  const call = async (auth) => (await invoke(cron, { method: "GET", headers: auth ? { authorization: auth } : {} })).statusCode;
  eq("cron: 鍵があると、見出しなし 401・ちがう鍵（同じ長さ・ちがう長さ）401・正しい鍵 200",
    [await call(""), await call("Bearer test-cron-secret-0123456780"), await call("Bearer short"), await call("Bearer test-cron-secret-0123456789")], [401, 401, 401, 200]);
  // 比べ方は、関数の字に timingSafeEqual があるかでなく、呼ぶ時に本当に使うかで見る（字の比べ方 !== に戻すと、上の答えは同じでも
  // ここで呼ばれた数が 0 になる。Batch 88 の反証: 前は字を探すだけで、助けの関数を残したまま !== に戻しても通った）
  const realTse = crypto.timingSafeEqual;
  let tseCalls = 0;
  crypto.timingSafeEqual = (a, b) => {
    tseCalls++;
    return realTse(a, b);
  };
  let codes = [];
  try {
    codes = [await call("Bearer test-cron-secret-0123456780"), await call("Bearer test-cron-secret-0123456789")];
  } finally {
    crypto.timingSafeEqual = realTse;
  }
  ok("cron: 同じ長さの鍵は timingSafeEqual で比べる（ちがう鍵 401・正しい鍵 200 のどちらでも呼ぶ。字の比べ方で時間の差を出さない）",
    JSON.stringify(codes) === "[401,200]" && tseCalls >= 2, JSON.stringify({ codes, tseCalls }));
  delete process.env.CRON_SECRET;
}

// ===== 11. ログ・外へ出ない =====
ok("ログ: 鍵・トークン・メールを書かない", !logs.some((l) => /test-ai-key|test-anon-key|test-service-role|test-cron-secret|tok-|@example\.test/.test(l)), logs.filter((l) => /test-|tok-|@/.test(l)).slice(0, 3).join(" | "));
ok("偽物の知らない要求は無い（どの要求も偽の相手が答えた）", S.unexpected.length === 0, S.unexpected.join(", "));

out(`test-api-guard: ${passed} passed, ${failed} failed${rootArg > 0 ? `（--root ${ROOT}）` : ""}`);
process.exit(failed ? 1 : 0);
