// SpellDash E2Eスモークテスト
//
// 実行: npm test（または node tests/e2e.mjs）
// 前提: playwright-core（npm i）と Chromium。
//   Chromiumの場所は環境変数 CHROME_PATH で指定できる。
//   未指定なら playwright の既定キャッシュ等から探す。
//
// 安全装置: ローカルサーバーが /js/supabase.js をテスト用スタブに
// 差し替えるため、テストが本番Supabaseに接続することはない。

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright-core";
import { syncModulePreload, baseDataFiles, WORD_PAGES } from "../scripts/modulepreload.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const STUB = path.join(ROOT, "tests", "mocks", "supabase-stub.js");

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".webmanifest": "application/manifest+json"
};

function findChromium() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    "/opt/pw-browsers",
    process.env.HOME + "/.cache/ms-playwright"
  ];
  for (const root of roots) {
    if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
    for (const dir of fs.readdirSync(root).filter((d) => d.startsWith("chromium"))) {
      // 旧形式(chrome-linux)と新Chrome for Testing形式(chrome-linux64)の両対応
      for (const sub of ["chrome-linux/chrome", "chrome-linux64/chrome"]) {
        const p = path.join(root, dir, sub);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  throw new Error("Chromiumが見つかりません。CHROME_PATH を設定してください。");
}

// ---- 端末間同期の検証用「クラウド」（Supabase の表のつもり。このプロセスのメモリ） ----
// スタブ（tests/mocks/supabase-stub.js）は localStorage の spelldash_test_cloud に id があるときだけ、from(table) を
// POST /__cloud/query に投げる。id ごとに表・設定・呼び出しの記録を持つので、検査どうしが混ざらない。
// 設定: failSelect { 表名: エラーの文 }（その表の select を失敗させる）、delayMs と delayTables（その表の select の応答を遅らせる）
const CLOUD_PK = { word_progress: ["user_id", "word_id"], user_progress: ["user_id"], user_items: ["user_id", "kind", "key"], profiles: ["user_id"], activity_days: ["user_id", "day"], funnel_events: ["device_id", "step", "source", "day"] };
const CLOUD_ANON_INSERT = new Set(["funnel_events"]); // 未ログインでも書ける表（RLS: user_id が空か本人。docs/SQL_FUNNEL.md）
const clouds = new Map();
let cloudSeq = 0;
function createCloud(tables = {}, config = {}) {
  const id = `cloud-${++cloudSeq}`;
  const cloud = {
    id,
    tables: Object.fromEntries(Object.entries(tables).map(([t, rows]) => [t, rows.map((r) => JSON.parse(JSON.stringify(r)))])),
    log: [],
    config: { failSelect: {}, delayMs: 0, delayTables: ["word_progress", "user_progress"], ...config },
    rows(t) { return (this.tables[t] ??= []); },
    writes(table, from = 0) { return this.log.slice(from).filter((e) => (!table || e.table === table) && e.kind !== "select" && !e.error); }
  };
  clouds.set(id, cloud);
  return cloud;
}
function runCloudQuery({ cloud: cloudKey, table, ops, userId }) {
  const cloud = clouds.get(cloudKey);
  if (!cloud) return { data: null, error: { message: `unknown cloud ${cloudKey}` }, count: null };
  let kind = null, payload = null, single = false, cols = "*", countMode = null, head = false;
  const filters = [];
  for (const [m, args] of ops) {
    if (m === "select") { kind ??= "select"; cols = args[0] ?? "*"; if (args[1]?.count) countMode = args[1].count; if (args[1]?.head) head = true; }
    else if (m === "upsert" || m === "insert" || m === "update") { kind = m; payload = args[0]; }
    else if (m === "delete") kind = "delete";
    else if (m === "eq") filters.push((r) => r[args[0]] === args[1]);
    else if (m === "gte") filters.push((r) => r[args[0]] >= args[1]);
    else if (m === "lte") filters.push((r) => r[args[0]] <= args[1]);
    else if (m === "in") filters.push((r) => (args[1] ?? []).includes(r[args[0]]));
    else if (m === "maybeSingle" || m === "single") single = true;
  }
  const entry = { table, kind, n: 0, userId };
  cloud.log.push(entry);
  if (kind === "select") {
    const fail = cloud.config.failSelect[table];
    if (fail) { entry.error = fail; return { data: null, error: { message: fail, code: "" }, count: null }; }
    let rows = cloud.rows(table).filter((r) => userId && r.user_id === userId && filters.every((f) => f(r))); // RLS: 本人の行だけ
    if (cols !== "*") { const names = cols.split(",").map((c) => c.trim()); rows = rows.map((r) => Object.fromEntries(names.map((k) => [k, r[k]]))); }
    entry.n = rows.length;
    const data = head ? null : single ? (rows[0] ?? null) : rows;
    return { data: JSON.parse(JSON.stringify(data)), error: null, count: countMode ? rows.length : null };
  }
  if (kind === "upsert" || kind === "insert") {
    const rows = Array.isArray(payload) ? payload : [payload];
    entry.n = rows.length;
    const allowed = CLOUD_ANON_INSERT.has(table) ? rows.every((r) => r.user_id == null || r.user_id === userId) : userId && rows.every((r) => r.user_id === userId);
    if (!allowed) { entry.error = "rls"; return { data: null, error: { message: "row-level security", code: "42501" }, count: null }; }
    const pk = CLOUD_PK[table];
    for (const r of rows) {
      const list = cloud.rows(table);
      const i = pk ? list.findIndex((x) => pk.every((k) => x[k] === r[k])) : -1;
      if (i >= 0) list[i] = { ...list[i], ...r };
      else list.push({ ...r });
    }
    return { data: null, error: null, count: null };
  }
  if (kind === "update") {
    for (const r of cloud.rows(table)) if (r.user_id === userId && filters.every((f) => f(r))) { Object.assign(r, payload); entry.n++; }
    return { data: null, error: null, count: null };
  }
  if (kind === "delete") {
    const before = cloud.rows(table).length;
    cloud.tables[table] = cloud.rows(table).filter((r) => !(r.user_id === userId && filters.every((f) => f(r))));
    entry.n = before - cloud.tables[table].length;
    return { data: null, error: null, count: null };
  }
  entry.error = "unsupported";
  return { data: null, error: { message: `stub: unsupported query ${ops.map((o) => o[0]).join(".")}` }, count: null };
}

// ---- 静的サーバー（supabase.jsだけスタブ差し替え） ----
let fakeTrialMonths = 0; // 偽の /api/billing/config が返す無料期間（月）。POST /__billing/trial?months=N で切り替える
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (urlPath === "/") urlPath = "/index.html";

  // 端末間同期の「クラウド」（上の createCloud。スタブが spelldash_test_cloud のあるときだけ投げてくる）
  if (urlPath === "/__billing/trial" && req.method === "POST") {
    fakeTrialMonths = Number(new URL(req.url, "http://x").searchParams.get("months")) || 0;
    res.writeHead(204).end();
    return;
  }
  if (urlPath === "/__cloud/query" && req.method === "POST") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const json = (body) => res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
      let q = null;
      try { q = JSON.parse(raw); } catch { return json({ data: null, error: { message: "bad json" } }); }
      const result = runCloudQuery(q);
      const cloud = clouds.get(q.cloud);
      const slow = cloud && cloud.config.delayMs > 0 && q.ops.some(([m]) => m === "select") && cloud.config.delayTables.includes(q.table);
      if (slow) setTimeout(() => json(result), cloud.config.delayMs);
      else json(result);
    });
    return;
  }

  // /api/explain-word の偽装: 固定の覚え方を返す（"401" を含む語なら未ログイン）
  if (urlPath === "/api/explain-word") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const word = (() => { try { return JSON.parse(raw).word ?? {}; } catch { return {}; } })();
      const json = (status, body) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
      if (String(word.en).includes("401")) return json(401, { error: "login_required", message: "ログインすると使える（無料）" });
      // "limit" を含む語なら無料ぶんを使い切った（429・upgrade:true → 表示側が「Pro について」を添える）
      if (String(word.en).includes("limit")) return json(429, { error: "daily_limit", upgrade: true, message: "今日の無料ぶん（3回）は使い切った。", offer: "Pro なら1日60回" });
      json(200, { mnemonic: `${word.en} は「${word.ja}」。音で覚える`, example: `Example with ${word.en}.`, exampleJa: `${word.en} を使った例文`, pitfall: "似た綴りの語に注意" });
    });
    return;
  }

  // /api/generate-cards の偽装（本物のClaude APIには接続しない）。
  // 本文に "401" があれば未ログイン、"empty" なら0件、それ以外は固定2枚を返す
  if (urlPath === "/api/generate-cards") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const text = (() => { try { return JSON.parse(raw).text ?? ""; } catch { return ""; } })();
      const json = (status, body) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
      if (text.includes("401")) return json(401, { error: "login_required", message: "ログインすると使える（無料）" });
      if (text.includes("empty")) return json(200, { cards: [] });
      json(200, {
        cards: [
          { q: "検索結果に連動して出る広告で、クリックごとに費用が発生する", answer: "リスティング広告", explain: "検索キーワードに連動する運用型広告", accept: ["検索連動型広告"] },
          { q: "1クリックあたりにかかった広告費", answer: "CPC", explain: "Cost ÷ Click", accept: ["クリック単価"] }
        ]
      });
    });
    return;
  }

  // /api/billing/* の偽装（SpellDash Pro。本物の Stripe・Supabase には接続しない）。
  // config は常に configured（月額 580・年額 4,800）。checkout は Bearer 無し → 401、pro-token → 409、他 → Checkout の代わりに
  // pro.html?pro=done へ。portal は pro-token → profile.html、他 → 404 no_subscription。webhook は偽装しない（オフラインテストで検証）
  if (urlPath.startsWith("/api/billing/")) {
    const json = (status, body) => res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
    const route = urlPath.slice("/api/billing/".length);
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (route === "config") {
      if (req.method !== "GET") return json(405, { error: "method_not_allowed", message: "許可されていないメソッドです。" });
      return json(200, { configured: true, prices: [{ interval: "month", amount: 580, currency: "jpy" }, { interval: "year", amount: 4800, currency: "jpy" }], trialDays: 0, trialMonths: fakeTrialMonths });
    }
    if (route !== "checkout" && route !== "portal") return json(404, { error: "not_found", message: "そのAPIはありません。" });
    if (req.method !== "POST") return json(405, { error: "method_not_allowed", message: "許可されていないメソッドです。" });
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = (() => { try { return JSON.parse(raw) ?? {}; } catch { return {}; } })();
      if (!token) return json(401, { error: "login_required", message: "加入にはログインが必要です。" });
      if (route === "checkout") {
        if (body.interval !== "month" && body.interval !== "year") return json(400, { error: "bad_request", message: "プランの指定が正しくありません。" });
        if (token === "pro-token") return json(409, { error: "already_subscribed", message: "すでに Pro です。" });
        return json(200, { url: BASE + "/pro.html?pro=done" });
      }
      if (token === "pro-token") return json(200, { url: BASE + "/profile.html" });
      json(404, { error: "no_subscription", message: "お支払いの情報がありません。Pro に加入すると使えます。" });
    });
    return;
  }

  // /api/admin/* の偽装（プレイヤー管理 CRM。本物の Supabase には接続しない）。
  // Authorization の値で分岐: 無し／不明 → 401、forbidden-token → 403、unconfigured-token → 503、
  // test-token と nonotes-token → 200（fixture は要求のたびにディスクから読む）。
  // players / player は GET のみ、note は POST のみ（それ以外は 405）。
  // note: 本文の userId が fixture の誰かなら {ok:true, note, tags, pinned} を返す。居なければ 404。
  //       nonotes-token なら crm_notes が無い想定で 503 not_configured（message に docs/SQL_CRM.md）。
  if (urlPath.startsWith("/api/admin/")) {
    const json = (status, body) => res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
    const fixture = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", name), "utf8"));
    const route = urlPath.slice("/api/admin/".length);
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!["players", "player", "note", "funnel"].includes(route)) return json(404, { error: "not_found", message: "そのAPIはありません。" });
    if (req.method !== (route === "note" ? "POST" : "GET")) return json(405, { error: "method_not_allowed", message: "許可されていないメソッドです。" });
    if (!["test-token", "nonotes-token", "forbidden-token", "unconfigured-token"].includes(token)) return json(401, { error: "login_required", message: "ログインしてください。" });
    if (token === "forbidden-token") return json(403, { error: "forbidden", message: "このアカウントには権限がありません。" });
    if (token === "unconfigured-token") return json(503, { error: "not_configured", message: "管理画面の設定がまだです。SUPABASE_SERVICE_ROLE_KEY と ADMIN_EMAILS を設定してください（docs/CRM.md）。" });
    if (route === "players") return json(200, fixture("admin-players.json"));
    if (route === "funnel") return json(200, token === "nonotes-token" ? { missing: true, today: "2026-10-06" } : fixture("admin-funnel.json"));
    if (route === "player") {
      const userId = new URL(req.url, "http://x").searchParams.get("userId") || "";
      if (!UUID_RE.test(userId)) return json(400, { error: "bad_request", message: "userId が UUID ではありません。" });
      if (!fixture("admin-players.json").players.some((p) => p.userId === userId)) return json(404, { error: "not_found", message: "該当するプレイヤーがいません。" });
      return json(200, fixture("admin-player.json"));
    }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = (() => { try { return JSON.parse(raw) ?? {}; } catch { return {}; } })();
      if (token === "nonotes-token") return json(503, { error: "not_configured", message: "メモの保存先（crm_notes）がまだありません。docs/SQL_CRM.md の SQL を実行してください。" });
      if (typeof body.userId !== "string" || !UUID_RE.test(body.userId)) return json(400, { error: "bad_request", message: "userId が UUID ではありません。" });
      const known = fixture("admin-players.json").players.find((p) => p.userId === body.userId);
      if (!known) return json(404, { error: "not_found", message: "該当するプレイヤーがいません。" });
      json(200, {
        ok: true,
        note: typeof body.note === "string" ? body.note : known.note,
        tags: Array.isArray(body.tags) ? body.tags : known.tags,
        pinned: typeof body.pinned === "boolean" ? body.pinned : known.pinned
      });
    });
    return;
  }

  const file =
    urlPath === "/js/supabase.js" ? STUB : path.join(ROOT, urlPath.slice(1));

  if (!path.resolve(file).startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }

  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ---- テストハーネス ----
let passed = 0;
let failed = 0;
// YYYY-MM-DD（端末の日付）。seed の日付ずらしに使う
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const ymdDaysAgo = (days) => { const d = new Date(); d.setDate(d.getDate() - days); return ymd(d); };

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

// 状態変化を待つ（固定waitだと負荷でズレるため）
async function waitUntil(fn, timeout = 2000, step = 50) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

const browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox"] });

async function newPage(init = {}) {
  const opts = {};
  if (init.viewport) opts.viewport = init.viewport;
  if (init.mobile) Object.assign(opts, { isMobile: true, hasTouch: true }); // pointer: coarse になり、画面キーボードが出る
  const page = await browser.newPage(opts);
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.addInitScript((seed) => {
    localStorage.setItem("spelldash_schema_version", "6");
    if (!seed.keepOnboarding) localStorage.setItem("spelldash_onboarded", "1");
    for (const [k, v] of Object.entries(seed.storage ?? {})) localStorage.setItem(k, v);
  }, init);
  return page;
}

// ===== 1. 全ページがエラーなく表示される =====
// 各ページの <link rel="modulepreload">（scripts/modulepreload.mjs）が import の依存と揃っている（足した import の先読みを忘れない）
console.log("modulepreload:");
{
  const stale = syncModulePreload();
  check("modulepreload が import の依存と揃っている（ずれたら node scripts/modulepreload.mjs）", stale.length === 0, stale.join(", "));
  // 教材の先読みが本当に使われる: 教材を読むページで、台帳と基本カテゴリの JSON はそれぞれ 1 回だけ取る（fetch と URL・CORS がずれると 2 回になる）
  for (const pageName of WORD_PAGES) {
    const page = await newPage();
    const counts = new Map();
    page.on("request", (req) => {
      const p = new URL(req.url()).pathname.slice(1);
      if (p.startsWith("data/")) counts.set(p, (counts.get(p) ?? 0) + 1);
    });
    await page.goto(BASE + "/" + pageName, { waitUntil: "networkidle" });
    await page.waitForTimeout(300);
    const wrong = baseDataFiles().filter((f) => counts.get(f) !== 1).map((f) => `${f}=${counts.get(f) ?? 0}`);
    check(`${pageName}: 先読みした教材はそれぞれ 1 回だけ取る（先読みが fetch に使われる）`, wrong.length === 0, wrong.join(" "));
    await page.close();
  }
}

// 各ページが外から読む CSS・スクリプトは、本番の Content-Security-Policy（vercel.json）が許す先だけ（許されない先は本番で黙って拒否される。2026-10 の Google Fonts）
console.log("csp:");
{
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
  const csp = vercel.headers.flatMap((h) => h.headers).find((h) => h.key === "Content-Security-Policy")?.value ?? "";
  const directives = csp.split(";").map((d) => d.trim().split(/\s+/));
  const directive = (name) => (directives.find((d) => d[0] === name) ?? directives.find((d) => d[0] === "default-src") ?? []).slice(1);
  const allowed = (url, name) => directive(name).some((src) => src.startsWith("http") && url.startsWith(src));
  const bad = [];
  const htmlFiles = [...fs.readdirSync(ROOT).filter((f) => f.endsWith(".html")), ...fs.readdirSync(path.join(ROOT, "packs")).filter((f) => f.endsWith(".html")).map((f) => `packs/${f}`)];
  for (const f of htmlFiles) {
    const html = fs.readFileSync(path.join(ROOT, f), "utf8");
    for (const m of html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="(https?:[^"]+)"/g)) if (!allowed(m[1], "style-src")) bad.push(`${f}: ${m[1]}`);
    for (const m of html.matchAll(/<script[^>]+src="(https?:[^"]+)"/g)) if (!allowed(m[1], "script-src")) bad.push(`${f}: ${m[1]}`);
  }
  check("外から読む CSS・スクリプトは本番の CSP が許す先だけ", csp !== "" && bad.length === 0, bad.slice(0, 3).join(" | "));
}

console.log("pages:");
for (const p of ["/index.html", "/battle.html", "/stats.html", "/profile.html", "/privacy.html", "/news.html", "/list.html", "/pro.html", "/tokushoho.html", "/terms.html"]) {
  const page = await newPage();
  await page.goto(BASE + p, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  check(`${p} エラー0`, page.errors.length === 0, page.errors[0] ?? "");
  await page.close();
}

// ===== 2. Study: デスクトップ入力＋モバイル入力 =====
console.log("study:");
{
  const page = await newPage();
  await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.press("#input", "Enter");
  await page.waitForTimeout(250);
  await page.press("#input", "Enter"); // 答え表示
  await page.waitForTimeout(150);
  const answer = (await page.textContent("#word")).trim();
  const answerJa = (await page.textContent("#japanese")).trim();
  check("初回スターターは短いeasy語", answer.length <= 4, `got=${answer}`);
  // デスクトップ: keydown経路
  for (const ch of answer) await page.press("#input", ch);
  await page.waitForTimeout(400);
  check("keydown経路で正解", (await page.textContent("#score")) === "1");
  check("単語の状態ラベル（新しい単語）", (await page.textContent("#wordMeta")).includes("新しい単語"));
  // モバイル: inputイベント経路（2語目）
  await page.press("#input", "Enter");
  await page.waitForTimeout(150);
  const answer2 = (await page.textContent("#word")).trim();
  await page.evaluate((val) => {
    const input = document.getElementById("input");
    input.value = val;
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: val }));
  }, answer2);
  await page.waitForTimeout(600);
  check("inputイベント経路（ソフトキーボード）で正解", (await page.textContent("#score")) === "2");
  // 自力正解の成長メッセージ: 1語目（答えを見た語）がRecall Loopで戻ってきたら見ずに打つ
  // 答えを見た語（既知）がRecall Loopで戻ってきたら、どれでも見ずに打つ＝自力正解
  const known = new Map([[answerJa, answer]]);
  let grew = false;
  for (let i = 0; i < 24 && !grew; i++) {
    const ja = (await page.textContent("#japanese")).trim();
    const hidden = !/^[a-z]+$/.test((await page.textContent("#word")).trim());
    if (known.has(ja) && hidden) {
      for (const ch of known.get(ja)) await page.press("#input", ch); // 自力正解（答えを見ない）
      await waitUntil(async () => (await page.textContent("#message")).includes("XP"));
      grew = /思い出せた|覚えた/.test(await page.textContent("#message"));
      break;
    }
    await page.press("#input", "Enter"); // 答え表示
    await waitUntil(async () => /^[a-z]+$/.test((await page.textContent("#word")).trim()), 1000);
    const shown = (await page.textContent("#word")).trim();
    if (!/^[a-z]+$/.test(shown)) continue;
    known.set(ja, shown);
    for (const ch of shown) await page.press("#input", ch); // 練習で通過
    await waitUntil(async () => (await page.textContent("#japanese")).trim() !== ja, 1500);
    await page.waitForTimeout(120);
  }
  check("自力正解後に学びのメッセージ（思い出せた/覚えた）", grew, `last msg=${await page.textContent("#message")}`);
  check("ホームに覚えた単語カード", (await page.textContent("#learnedCard")).includes("覚えた単語"));
  check("Studyフローでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();
}

// ===== 2.5 日本語IME＋Studyキュー配置 =====
console.log("ime & queue:");
{
  const page = await newPage({ storage: { spelldash_placement: "done" } }); // 腕試し中はキューを畳むので、腕試し済みで
  await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.press("#input", "Enter"); // Study開始
  await page.waitForTimeout(250);
  // 日本語IMEを模擬: 変換開始→かなが入る→確定
  await page.evaluate(() => {
    const input = document.getElementById("input");
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    input.value = "こんにちは";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "こんにちは" }));
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "こんにちは" }));
  });
  await page.waitForTimeout(200);
  check("IME確定後に入力欄が巻き戻る", (await page.inputValue("#input")) === "");
  check("日本語入力はミス扱いにしない", (await page.textContent("#miss")) === "0");
  check("英字モード案内が表示される", (await page.textContent("#message")).includes("英字モード"));
  // Studyキュー: 答えを見てUnresolvedチップを出し、入力欄と重ならないことを確認
  await page.press("#input", "Enter"); // 答えを表示（recallFail→キューに赤チップ）
  await page.waitForTimeout(400);
  const overlap = await page.evaluate(() => {
    const q = document.getElementById("studyQueue").getBoundingClientRect();
    const i = document.getElementById("input").getBoundingClientRect();
    if (q.width === 0 || q.height === 0) return "queue-empty";
    const separate = q.right <= i.left || q.left >= i.right || q.bottom <= i.top || q.top >= i.bottom;
    return separate ? "ok" : "overlap";
  });
  check("キューが入力欄と重ならない", overlap === "ok", `state=${overlap}`);
  check("IME/キューフローでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();
}

// ===== 2.6 1ミス＝不正解＋スペル表示（当てずっぽう防止） =====
console.log("strict miss:");
{
  const page = await newPage();
  await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.press("#input", "Enter"); // Study開始
  await page.waitForTimeout(250);
  await page.press("#input", "1"); // 絶対に一致しない文字＝1ミス
  await page.waitForTimeout(300);
  check("1ミスで不正解カウント", (await page.textContent("#recallFail")) === "1");
  check("1ミスでスペルが表示される", !(await page.textContent("#word")).includes("非表示"));
  check("打ち直し案内が出る", (await page.textContent("#message")).includes("打ち直す"), await page.textContent("#message"));
  // 表示されたスペルを見ながら打ち直すと次へ進める（練習扱い）
  const answer = await page.evaluate(() => document.getElementById("word").textContent.trim());
  await page.type("#input", answer, { delay: 20 });
  await page.waitForTimeout(400);
  check("打ち直しで完了して次の単語へ", (await page.inputValue("#input")) === "");
  check("strict missフローでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();
}

// ===== 3. Daily Dash: 完走→ロック→カウントダウン =====
console.log("daily:");
{
  const page = await newPage();
  await page.goto(BASE + "/index.html?t=3", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.$eval("#homeMore", (el) => { el.open = true; });
  // Batch 43: 未プレイの #dailyCard は home.css で display:none（.daily--done が付くまで畳む）なので Playwright の click は使えない。DOM 側で押す
  await page.$eval("#dailyStartButton", (el) => el.click());
  await page.waitForTimeout(3800);
  const card = await page.textContent("#dailyCard");
  check("完走でロック（スコア表示）", card.includes("今日のスコア"));
  check("カウントダウン表示", card.includes("次の問題まで"));
  const act = await page.evaluate(() => JSON.parse(localStorage.getItem("spelldash_activity") || "{}"));
  check("KPI心拍にdaily完走記録", act.dailyDone === true);
  check("Dailyフローでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();
}

// ===== 4. ストリークカード＋苦手トグル＋ヘッダーストリーク表示 =====
// Batch 42: 初回（ストリーク未設定: current 0・best 0）は #todayStrip が空・#headerStreak が hidden になったので、3 日連続の記録を seed して表示を見る
console.log("home widgets:");
{
  const todayYmd = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  const page = await newPage({ storage: { spelldash_streak: JSON.stringify({ last: todayYmd, current: 3, best: 3, shields: 0 }) } });
  await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  check("数字1行にストリーク・週の目標", (await page.textContent("#todayStrip")).includes("3日連続"), await page.textContent("#todayStrip"));
  check("ホームにランク表示は出さない（学習データにある）", !(await page.textContent("#todayStrip")).includes("F3") && !(await page.textContent("#todayStrip")).includes("Lv."));
  await page.click("#setupToggle"); // 出題設定は畳まれている
  check("苦手トグル（Study時）表示", await page.isVisible("#weakToggleButton"));
  check("ヘッダーストリーク表示", await page.isVisible("#headerStreak"));
  // はちゃん（ホーム一言）: 吹き出し＋アバター画像がロードされている
  check("はちゃんのホーム一言表示", await page.isVisible("#hasumiHome .hasumi__bubble"));
  const avatarLoaded = await page.evaluate(() => {
    const img = document.querySelector("#hasumiHome .hasumi__avatar");
    return img && img.complete && img.naturalWidth > 0;
  });
  check("はちゃんアバター画像ロード", avatarLoaded);
  await page.close();

  // 腕試しの途中で何語か答えて閉じた人（placement=started のまま）: 翌日のホームで「まず腕試し10語から。」を言い続けない
  const midPlacement = await newPage({
    storage: {
      spelldash_placement: "started",
      spelldash_streak: JSON.stringify({ last: ymdDaysAgo(1), current: 1, best: 1, shields: 0 }),
      spelldash_word_stats: JSON.stringify({ apple: { lastRecallSuccessAt: new Date(Date.now() - 86400000).toISOString(), recallSuccess: 1 } })
    }
  });
  await midPlacement.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await midPlacement.waitForTimeout(600);
  const midLine = (await midPlacement.textContent("#hasumiHome .hasumi__bubble")) ?? "";
  check("腕試し途中で答えた人のはちゃんは腕試しの話をしない", midLine && !midLine.includes("腕試し") && !midLine.includes("ちょうどいい所から"), midLine);
  await midPlacement.close();

  // 腕試しを開いて 1 語も答えずに戻った人（出した語の記録だけある）: 道のスタートは「今日のセット 15語」ではなく腕試しの案内。はちゃんは同じことを言わない
  const backFromPlacement = await newPage({
    storage: {
      spelldash_placement: "started",
      spelldash_word_stats: JSON.stringify({ apple: { seen: 1 } })
    }
  });
  await backFromPlacement.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await backFromPlacement.waitForTimeout(600);
  const startLabel = (await backFromPlacement.textContent("#pathCard")) ?? "";
  const backLine = (await backFromPlacement.textContent("#hasumiHome .hasumi__bubble").catch(() => "")) ?? "";
  check("腕試し前に戻った人の道のスタートは「腕試し10語」（今日のセットの語数を言わない）", startLabel.includes("腕試し10語") && !startLabel.includes("今日のセット"), startLabel.slice(0, 200));
  check("腕試し前に戻った人のはちゃんは道と同じ語数を繰り返さない", !backLine.includes("10語"), backLine);
  await backFromPlacement.close();
}

// ===== 5. Challenge: 完走でリザルトパネル =====
console.log("challenge result:");
{
  const page = await newPage();
  await page.goto(BASE + "/index.html?t=3", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.click('#playModes [data-mode="challenge"]');
  await page.waitForTimeout(3800);
  check("リザルトパネル表示", await page.isVisible("#resultPanel"));
  check("リザルトにはちゃんの一言", await page.isVisible("#resultPanel .hasumi__bubble"));
  check("もう一回でパネルが消える", await page.click("#resultRetry").then(async () => {
    await page.waitForTimeout(300);
    return !(await page.isVisible("#resultPanel"));
  }));
  check("Challengeフローでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();
}

// ===== 6. モバイル: ヘッダー1行＋完走時にリザルトが見える位置へスクロール =====
console.log("mobile flow:");
{
  const page = await newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(BASE + "/index.html?t=3", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const headerHeight = await page.evaluate(() => document.querySelector(".site-header").offsetHeight);
  check("モバイルヘッダーが1行（<70px）", headerHeight < 70, `height=${headerHeight}`);
  await page.click('#playModes [data-mode="challenge"]');
  await page.waitForTimeout(800);
  const cardTop = await page.evaluate(() => document.getElementById("gameCard").getBoundingClientRect().top);
  check("モード選択後ゲームカードが画面上部へ", cardTop >= 0 && cardTop < 300, `top=${cardTop}`);
  // フォーカスモード: プレイ中はヒーローと道が畳まれる
  check("プレイ中はヒーロー非表示", !(await page.isVisible(".hero")));
  check("プレイ中は道（ユニット一覧）非表示", !(await page.isVisible("#pathList .path__list")));
  await page.waitForTimeout(3200);
  check("終了後は「道に戻る」が見える", await page.isVisible("#backToPath"));
  const panelVisible = await page.evaluate(() => {
    const r = document.getElementById("resultPanel").getBoundingClientRect();
    return r.top < window.innerHeight && r.bottom > 0;
  });
  check("完走時リザルトパネルが画面内", panelVisible);
  await page.click("#backToPath");
  await page.waitForTimeout(300);
  check("道に戻るとユニット一覧が復帰", await page.isVisible("#pathList .path__list"));
  check("モバイルフローでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();
}

// ===== 7. お知らせページ＋フッターリンク =====
console.log("news:");
{
  const page = await newPage();
  await page.goto(BASE + "/news.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const items = await page.$$eval(".news-item", (els) => els.length);
  check("お知らせが3件以上表示", items >= 3, `items=${items}`);
  check("β公開エントリあり", (await page.textContent("#newsList")).includes("β公開"));
  await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const footerNav = await page.textContent(".site-footer__nav");
  check("フッターにお知らせリンク", footerNav.includes("お知らせ"));
  check("フッターからGitHubリンク削除", !footerNav.includes("GitHub"));
  check("newsフローでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();
}

// ===== 8. テーマ: 標準は白、プロフィールで黒に切替→永続化 =====
console.log("theme:");
{
  const page = await newPage();
  await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  check("標準テーマは白（light）", (await page.evaluate(() => document.documentElement.dataset.theme)) === "light");
  const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const bgLum = (() => { const m = bodyBg.match(/\d+/g) ?? []; return m.length >= 3 ? (Number(m[0]) + Number(m[1]) + Number(m[2])) / 3 : 0; })();
  check("ライトで背景が明色", bgLum > 235, `bg=${bodyBg}`);
  await page.goto(BASE + "/profile.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await page.selectOption("#themeSelect", "dark");
  await page.waitForTimeout(200);
  check("黒選択で即時ダーク適用", (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark");
  await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  check("ページ遷移後もダーク維持", (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark");
  check("テーマフローでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();
}

// ===== 9. 難易度ゲート: easy 0語のカテゴリ（IT）でもLv1で出題が枯渇しない =====
console.log("difficulty gate:");
{
  const page = await newPage({ storage: { spelldash_category: "it", spelldash_mode: "challenge" } });
  await page.goto(BASE + "/index.html?t=3", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.press("#input", "Enter");
  await page.waitForTimeout(400);
  const ja = (await page.textContent("#japanese")).trim();
  check("IT×Lv1でも出題される（最易難易度で救済）", ja !== "Challenge Mode" && ja.length > 0, `ja=${ja}`);
  check("IT×Lv1でエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();
}

// ===== 9.3 Challengeの手触り: 即時進行・カード内スコア・ベスト差分 =====
console.log("challenge feel:");
{
  const page = await newPage({ storage: { spelldash_mode: "challenge", spelldash_best_score: "3" } });
  await page.goto(BASE + "/index.html?t=3", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.press("#input", "Enter"); // 開始
  await page.waitForTimeout(200);
  check("プレイ中にカード内スコアが出る", !(await page.$eval("#playScore", (el) => el.hidden)));
  await page.press("#input", "Enter"); // 答え表示
  await waitUntil(async () => /^[a-z]+$/.test((await page.textContent("#word")).trim()), 1000);
  const shown = (await page.textContent("#word")).trim();
  const jaBefore = (await page.textContent("#japanese")).trim();
  for (const ch of shown) await page.press("#input", ch);
  await page.waitForTimeout(60); // 250ms待ちが無いことの確認: 60ms後には次の単語
  check("正解直後に即座に次の単語へ", (await page.textContent("#japanese")).trim() !== jaBefore);
  check("カード内スコアが1", (await page.textContent("#playScore")).includes("1"));
  await page.waitForTimeout(3600); // 終了まで
  const panel = await page.$eval("#resultPanel", (el) => (el.hidden ? "" : el.textContent));
  check("結果にベスト差分 or 更新", /ベスト/.test(panel), panel.slice(0, 60));
  check("Challenge手触りでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();
}

// ===== 9.4 今日のセット: CTA→開始→完了パネル→CTA完了表示 =====
console.log("daily set:");
{
  const page = await newPage();
  await page.goto(BASE + "/index.html?set=2", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  check("ホームの道にスタート1個（初回は腕試しの案内）", (await page.$$("#pathStart")).length === 1 && (await page.textContent("#pathCard")).includes("腕試し"));
  await page.click("#pathStart");
  await page.waitForTimeout(500);
  const ja0 = (await page.textContent("#japanese")).trim();
  check("CTAでStudyが始まる", ja0 !== "Study Mode" && ja0.length > 0, `ja=${ja0}`);
  check("セット進捗バーが出る", (await page.textContent("#setProgress")).includes("/ 2"));
  // 答えを見た語がRecall Loopで戻ってきたら自力で打つ、を2語ぶん繰り返す
  const known = new Map(); // ja -> en
  let done = false;
  for (let i = 0; i < 40 && !done; i++) {
    const panel = await page.$eval("#resultPanel", (el) => (el.hidden ? "" : el.textContent));
    if (panel.includes("今日のセット完了")) { done = true; break; }
    const ja = (await page.textContent("#japanese")).trim();
    if (known.has(ja)) {
      for (const ch of known.get(ja)) await page.press("#input", ch);
      await waitUntil(async () => (await page.textContent("#japanese")).trim() !== ja || !(await page.$eval("#resultPanel", (el) => el.hidden)), 1500);
      await page.waitForTimeout(100);
      continue;
    }
    await page.press("#input", "Enter"); // 答え表示
    await waitUntil(async () => /^[a-z]+$/.test((await page.textContent("#word")).trim()), 1000);
    const shown = (await page.textContent("#word")).trim();
    if (!/^[a-z]+$/.test(shown)) continue;
    known.set(ja, shown);
    for (const ch of shown) await page.press("#input", ch); // 練習で通過
    await waitUntil(async () => (await page.textContent("#japanese")).trim() !== ja, 1500);
    await page.waitForTimeout(100);
  }
  const panelText = await page.$eval("#resultPanel", (el) => (el.hidden ? "" : el.textContent));
  check("2語自力正解でセット完了パネル", panelText.includes("今日のセット完了"), panelText.slice(0, 60));
  check("完了パネルに明日の語と数字1行", panelText.includes("明日") && panelText.includes("思い出せた") && panelText.includes("思い出せず"), panelText.slice(0, 160));
  check("道のスタートが完了表示に切替", (await page.textContent("#pathCard")).includes("今日のぶんは完了"));
  check("今週ドットに今日が点灯", (await page.$$eval("#learnedCard .learned-card__week i.on", (els) => els.length)) >= 1);
  check("今日のセットフローでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  // 設定の永続化
  await page.goto(BASE + "/profile.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  await page.selectOption("#setSizeSelect", "25");
  await page.goto(BASE + "/profile.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  check("セット語数の設定が保存される", (await page.$eval("#setSizeSelect", (el) => el.value)) === "25");
  await page.close();
}

// ===== 9.5 学習データ: カテゴリ別の進捗一覧 =====
console.log("category progress:");
{
  const page = await newPage();
  await page.goto(BASE + "/stats.html#words", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const rows = await page.$$eval("#categoryProgress .cat-row", (els) => els.map((e) => e.textContent));
  check("カテゴリ行が10件（9＋マイ単語帳。「すべて」の行は出さない）", rows.length === 10 && !rows.some((t) => t.startsWith("すべて")), `rows=${rows.length}`);
  check("広告・マーケの行がある", rows.some((t) => t.includes("広告・マーケ") && t.includes("101語")));
  const zeroItem = (t) => /(習得|苦手|未着手) 0(?!\d)|覚えた 0(?! \/)/.test(t); // 見出しの「覚えた 0 / 160」は数字の事実なので除く
  check("カテゴリ行の内訳は 0 の項目を出さない（覚えかけ・未学習の呼び名も使わない）", !rows.some((t) => zeroItem(t) || t.includes("覚えかけ") || t.includes("未学習")), rows.find(zeroItem)?.replace(/\s+/g, " ") ?? "");
  check("カテゴリ進捗でエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();
}

// ===== 9.5 覚えた瞬間 v2: 知ってた／覚えた！／履歴／語チップ／単語帳／難易度ブースト =====
console.log("learned moment:");
{
  const y = new Date(Date.now() - 86400000);
  const yKey = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
  const page = await newPage({ storage: {
    spelldash_category: "my",
    spelldash_my_words: JSON.stringify([{ en: "invoice", ja: "請求書" }, { en: "negotiate", ja: "交渉する" }]),
    spelldash_word_stats: JSON.stringify({ "my-invoice": { playCount: 1, correctCount: 0, missCount: 1, typingMiss: 0, recallFail: 1, cleanCorrectStreak: 0, mastered: false, lastPlayed: y.toISOString(), nextReviewAt: y.toISOString(), lastRecallFailAt: y.toISOString(), lastRecallSuccessAt: null, history: [{ d: yKey, r: "x" }] } }),
    spelldash_first_sight: JSON.stringify(Array(11).fill(true))
  } });
  await page.goto(BASE + "/index.html?set=2", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.press("#input", "Enter");
  await page.waitForTimeout(300);
  check("昨日思い出せなかった語が先頭に出る", (await page.textContent("#japanese")).trim() === "請求書", await page.textContent("#japanese"));
  for (const ch of "invoice") await page.press("#input", ch);
  await waitUntil(async () => (await page.textContent("#message")).includes("覚えた"));
  check("日をまたいで自力正解→「覚えた！」", (await page.textContent("#message")).includes("覚えた！"), await page.textContent("#message"));
  check("はちゃんが語を名指しで喜ぶ", !(await page.$eval("#learnToast", (el) => el.hidden)) && (await page.textContent("#learnToast")).includes("invoice"));
  check("履歴ドット ×→○", (await page.$$eval("#wordHistory .hist i", (els) => els.map((e) => e.className).join(","))) === "hist__x,hist__o");
  await waitUntil(async () => (await page.textContent("#japanese")).trim() === "交渉する", 1500);
  for (const ch of "negotiate") await page.press("#input", ch);
  await waitUntil(async () => (await page.textContent("#message")).includes("知ってた"), 1500);
  check("初見ノーミス→「知ってた」", (await page.textContent("#message")).includes("知ってた"), await page.textContent("#message"));
  const stat = await page.evaluate(() => JSON.parse(localStorage.getItem("spelldash_word_stats"))["my-negotiate"]);
  check("知ってた語はknownOnSight＋同日反復に入らない", stat.knownOnSight === true && stat.dailyLearningStage >= 4, JSON.stringify(stat).slice(0, 80));
  check("初見12語中12語知ってた→難易度ブースト", (await page.evaluate(() => localStorage.getItem("spelldash_level_boost"))) === "1");
  await waitUntil(async () => !(await page.$eval("#resultPanel", (el) => el.hidden)), 2000);
  const panel = await page.textContent("#resultPanel");
  check("完了パネルに「覚えた」の語チップ", panel.includes("覚えた（前は出てこなかった語）") && (await page.$$eval(".word-chip--learned", (els) => els.map((e) => e.textContent).join(""))).includes("invoice"));
  await waitUntil(async () => (await page.textContent("#message")).includes("難しい単語"), 2500);
  check("ブースト時の案内メッセージ", (await page.textContent("#message")).includes("難しい単語"), await page.textContent("#message"));
  check("ホームカードに「今日覚えた: invoice」", (await page.textContent("#learnedCard")).includes("今日覚えた") && (await page.textContent("#learnedCard")).includes("invoice"));
  check("覚えた瞬間フローでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  // 学習後の状態を持って学習データへ（初期化スクリプトがseedを再適用するため新ページで）
  const statsAfter = await page.evaluate(() => localStorage.getItem("spelldash_word_stats"));
  const myWords = await page.evaluate(() => localStorage.getItem("spelldash_my_words"));
  await page.close();
  const page2 = await newPage({ storage: { spelldash_word_stats: statsAfter, spelldash_my_words: myWords } });
  await page2.goto(BASE + "/stats.html", { waitUntil: "networkidle" });
  await page2.waitForTimeout(900);
  const list = await page2.textContent("#learnedWordList");
  check("覚えた単語帳に invoice（履歴つき）", list.includes("invoice") && (await page2.$("#learnedWordList .hist__x")) !== null, list.slice(0, 80));
  check("知ってた語は別枠に negotiate", (await page2.textContent("#knownWordList")).includes("negotiate") && !list.includes("negotiate"));
  await page2.close();
}

// ===== 9.55 成長の証拠: 週間レポート・推移・今週+N =====
console.log("growth:");
{
  const page = await newPage({ storage: { spelldash_growth_log: JSON.stringify([
    { date: "2000-01-01", learned: 0, mastered: 0, active: true }
  ]) } });
  await page.goto(BASE + "/stats.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  check("週間レポートが表示", (await page.textContent("#weeklyReport")).includes("週間レポート"));
  check("週間レポートに学習した日", (await page.textContent("#weeklyReport")).includes("学習した日"));
  check("推移グラフ or 案内", (await page.$("#growthTrend svg")) !== null || (await page.textContent("#growthTrend")).includes("明日から"));
  const log = await page.evaluate(() => JSON.parse(localStorage.getItem("spelldash_growth_log") || "[]"));
  check("成長ログに今日の行", log.some((e) => e.date === new Date().toISOString().slice(0, 10) || e.date.length === 10) && log.length >= 2, `len=${log.length}`);
  check("学習データ（今週）でエラー0", page.errors.length === 0, page.errors[0] ?? "");
  check("成長フローでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();
}

// ===== 9.6 マイ単語帳: 追加→一覧→ホームで出題 =====
console.log("my words:");
{
  const page = await newPage();
  await page.goto(BASE + "/list.html#myWords", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  check("マイ単語帳は単語帳ページの折りたたみ（#myWords で開く）", await page.$eval("#myWords", (el) => el.open));
  await page.fill("#myWordEn", "Negotiate");
  await page.fill("#myWordJa", "交渉する");
  await page.click("#myWordForm button[type=submit]");
  await page.waitForTimeout(200);
  check("1語追加で一覧に出る", (await page.textContent("#myWordList")).includes("negotiate"));
  await page.fill("#myWordEn", "negotiate");
  await page.fill("#myWordJa", "重複");
  await page.click("#myWordForm button[type=submit]");
  await page.waitForTimeout(200);
  check("重複は拒否される", (await page.textContent("#myWordStatus")).includes("すでに"));
  await page.click(".my-words__bulk summary");
  await page.fill("#myWordBulk", "invoice, 請求書\ndeadline\t締め切り\nbad word!, だめ");
  await page.click("#myWordBulkAdd");
  await page.waitForTimeout(200);
  const status = await page.textContent("#myWordStatus");
  check("まとめて追加: 2語追加＋1件スキップ", status.includes("2語") && status.includes("スキップ 1"), status);
  check("単語帳のカテゴリ選択にマイ単語帳", (await page.$$eval("#listCategory option", (els) => els.map((e) => e.value))).includes("my"));
  // 単語帳でマイ単語帳を選ぶ: 上の一覧は畳んで下を指す（同じ語を 2 回並べない）。削除は下のカードの ×
  await page.selectOption("#listCategory", "my");
  await page.waitForTimeout(300);
  check("マイ単語帳を選ぶと、上の一覧は「下の一覧に」の 1 行だけ", (await page.$$("#myWordList .my-word")).length === 0 && (await page.textContent("#myWordList")).includes("下の一覧"), await page.textContent("#myWordList"));
  check("下の単語帳にマイ単語帳の語と ×", (await page.$$("#listBody [data-my-remove]")).length === 3 && (await page.textContent("#listBody")).includes("invoice"));
  await page.click('#listFilters [data-filter="weak"]');
  await page.waitForTimeout(200);
  check("下を絞り込んでいる間は、上の 1 行が「絞り込み中」と言う", (await page.textContent("#myWordList")).includes("絞り込み中"), await page.textContent("#myWordList"));
  await page.click('#listFilters [data-filter="all"]');
  await page.waitForTimeout(200);
  await page.click('#listBody [data-my-remove="invoice"]');
  await page.waitForTimeout(300);
  check("カードの × で消える（一覧と数）", !(await page.textContent("#listBody")).includes("invoice") && (await page.textContent("#myWordCount")).includes("2語"), await page.textContent("#myWordCount"));
  await page.evaluate(() => { localStorage.setItem("spelldash_my_words", JSON.stringify([...JSON.parse(localStorage.getItem("spelldash_my_words")), { en: "invoice", ja: "請求書", addedAt: new Date().toISOString() }])); });
  await page.goto(BASE + "/stats.html#words", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  check("カテゴリ進捗にマイ単語帳3語", (await page.textContent("#categoryProgress")).includes("マイ単語帳3語") || (await page.textContent("#categoryProgress")).includes("マイ単語帳") );
  // ホーム: カテゴリ「マイ単語帳」で出題される
  await page.evaluate(() => localStorage.setItem("spelldash_category", "my"));
  await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  check("チップにマイ単語帳3", (await page.textContent("#categoryPicker")).replace(/\s/g, "").includes("マイ単語帳3"));
  await page.press("#input", "Enter");
  await page.waitForTimeout(300);
  const ja = (await page.textContent("#japanese")).trim();
  check("マイ単語帳の語が出題される", ["交渉する", "請求書", "締め切り"].includes(ja), `ja=${ja}`);
  check("マイ単語帳フローでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();
}

// ===== 9.7 学びの質（Batch 1）: ヒント／メモ／難敵／正解時発音／バックアップ／ご意見 =====
console.log("learning quality:");
{
  // ヒント: 迷ったら次の1文字。見た時点で×扱い、残りを打っても自力扱いにならない
  const todayKey = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  const page = await newPage({ storage: {
    spelldash_category: "my",
    spelldash_streak: JSON.stringify({ last: todayKey, current: 1, best: 1, shields: 0 }), // 今日初プレイの祝いメッセージを外す
    spelldash_my_words: JSON.stringify([{ en: "invoice", ja: "請求書" }, { en: "negotiate", ja: "交渉する" }]),
    spelldash_word_stats: JSON.stringify({ "my-negotiate": { playCount: 5, correctCount: 0, missCount: 5, typingMiss: 0, recallFail: 5, cleanCorrectStreak: 0, mastered: false, lastPlayed: new Date().toISOString(), lastRecallFailAt: new Date(Date.now() - 86400000).toISOString(), lastRecallSuccessAt: null } })
  } });
  await page.goto(BASE + "/index.html?set=5&hintms=300", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.press("#input", "Enter");
  await page.waitForTimeout(300);
  // 難敵（5回思い出せていない negotiate）が先頭（Unresolved優先）
  check("難敵ラベル（4回以上思い出せていない語）", (await page.textContent("#wordMeta")).includes("難敵"), await page.textContent("#wordMeta"));
  const hintShown = await waitUntil(async () => !(await page.$eval("#hintButton", (el) => el.hidden)), 2000);
  check("迷っているとヒントボタンが出る", hintShown);
  await page.click("#hintButton");
  await page.waitForTimeout(150);
  check("ヒントで頭文字が入力される", (await page.inputValue("#input")) === "n", await page.inputValue("#input"));
  check("ヒント使用は×として記録", (await page.textContent("#recallFail")).trim() === "1");
  check("メモ欄が表示される（覚え方をメモ）", (await page.textContent("#wordNote")).includes("覚え方をメモ"));
  for (const ch of "egotiate") await page.press("#input", ch);
  await waitUntil(async () => (await page.textContent("#message")).includes("ヒントあり"), 1500);
  check("ヒントありで打てた→自力扱いではないメッセージ", (await page.textContent("#message")).includes("ヒントあり"), await page.textContent("#message"));
  const statHint = await page.evaluate(() => JSON.parse(localStorage.getItem("spelldash_word_stats"))["my-negotiate"]);
  check("ヒント正解は lastRecallSuccessAt を更新しない", !statHint.lastRecallSuccessAt && statHint.recallFail === 6, JSON.stringify(statHint).slice(0, 100));
  // メモ: 答え表示後に書く → 保存 → 表示
  await waitUntil(async () => (await page.textContent("#japanese")).trim() !== "交渉する", 1500);
  await page.press("#input", "Enter"); // 答えを見る
  await page.waitForTimeout(200);
  await page.click("#noteEdit");
  await page.fill("#noteInput", "in(中に)+voice(声) → 請求の声");
  await page.press("#noteInput", "Enter");
  await page.waitForTimeout(150);
  check("メモが保存・表示される", (await page.textContent("#wordNote")).includes("請求の声"), await page.textContent("#wordNote"));
  const notes = await page.evaluate(() => JSON.parse(localStorage.getItem("spelldash_word_notes") || "{}"));
  check("メモは spelldash_word_notes に保存", Object.values(notes).some((n) => n.includes("請求の声")));
  check("学びの質フローでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  const statsAfter = await page.evaluate(() => localStorage.getItem("spelldash_word_stats"));
  const myWords = await page.evaluate(() => localStorage.getItem("spelldash_my_words"));
  const notesRaw = await page.evaluate(() => localStorage.getItem("spelldash_word_notes"));
  await page.close();

  // 学習データ: 苦手単語に難敵タグとメモ
  const page2 = await newPage({ storage: { spelldash_word_stats: statsAfter, spelldash_my_words: myWords, spelldash_word_notes: notesRaw } });
  await page2.goto(BASE + "/stats.html", { waitUntil: "networkidle" });
  await page2.waitForTimeout(900);
  const weak = await page2.textContent("#weakWords");
  check("苦手単語に「難敵」タグ", weak.includes("難敵") && weak.includes("negotiate"), weak.slice(0, 80));
  check("苦手単語にメモが出る", weak.includes("請求の声"));
  check("学習データでエラー0", page2.errors.length === 0, page2.errors[0] ?? "");
  await page2.close();

  // プロフィール: 正解時発音の設定＋バックアップの書き出し/復元
  const page3 = await newPage({ storage: { spelldash_xp: "1234", spelldash_word_notes: notesRaw } });
  await page3.goto(BASE + "/profile.html", { waitUntil: "networkidle" });
  await page3.waitForTimeout(700);
  const backup = await page3.evaluate(async () => {
    const m = await import("/js/backup.js");
    return m.buildBackup();
  });
  check("バックアップにXPとメモが含まれる", backup.app === "SpellDash" && backup.data.spelldash_xp === "1234" && String(backup.data.spelldash_word_notes).includes("請求の声"));
  const restored = await page3.evaluate(async (b) => {
    const m = await import("/js/backup.js");
    localStorage.setItem("spelldash_xp", "0");
    localStorage.removeItem("spelldash_word_notes");
    m.applyBackup(b);
    return { xp: localStorage.getItem("spelldash_xp"), notes: localStorage.getItem("spelldash_word_notes") };
  }, backup);
  check("バックアップから復元できる", restored.xp === "1234" && String(restored.notes).includes("請求の声"));
  check("プロフィール（設定・バックアップ）でエラー0", page3.errors.length === 0, page3.errors[0] ?? "");
  await page3.close();

  // ご意見フォーム: フッターから開く→送信（スタブでは失敗→端末に保持）
  const page4 = await newPage();
  await page4.goto(BASE + "/news.html", { waitUntil: "networkidle" });
  await page4.waitForTimeout(500);
  await page4.click("[data-feedback-open]");
  await page4.waitForTimeout(150);
  check("ご意見モーダルが開く", !(await page4.$eval("#feedbackModal", (el) => el.hidden)));
  await page4.fill("#feedbackMessage", "テスト送信です");
  await page4.click("#feedbackSubmit");
  await waitUntil(async () => (await page4.textContent("#feedbackStatus")).includes("ありがとう"), 3000);
  const fbStatus = await page4.textContent("#feedbackStatus");
  const queue = await page4.evaluate(() => JSON.parse(localStorage.getItem("spelldash_feedback_queue") || "[]"));
  check("送信→お礼表示（未接続時は端末に保持）", fbStatus.includes("ありがとう") && (fbStatus.includes("届きました") || queue.length === 1), `${fbStatus} queue=${queue.length}`);
  check("ご意見フローでエラー0", page4.errors.length === 0, page4.errors[0] ?? "");
  await page4.close();
}

// ===== 9.8 初回体験と継続（Batch 2）: 腕試し／回収／中身予告／週の目標／ホーム画面に追加 =====
console.log("first run & retention:");
{
  // 腕試し: 初回は易3＋普通4＋難3の10語。全部答えを見ると「10語中0語知ってた」で基本から
  const page = await newPage();
  await page.goto(BASE + "/index.html?set=15", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.press("#input", "Enter");
  await page.waitForTimeout(300);
  check("初回の 1 語目: 案内は #word の Enter の 1 本だけ（#message は空）", (await page.textContent("#word")).includes("Enter") && (await page.textContent("#message")).trim() === "", await page.textContent("#message"));
  check("腕試し開始が記録される", (await page.evaluate(() => localStorage.getItem("spelldash_placement"))) === "started");
  const known = new Map();
  let placement = null;
  for (let i = 0; i < 90 && !placement; i++) { // 再出題の間隔がランダムなので余裕を持つ
    const ja = (await page.textContent("#japanese")).trim();
    const hidden = !/^[a-z]+$/.test((await page.textContent("#word")).trim());
    if (known.has(ja) && hidden) {
      for (const ch of known.get(ja)) await page.press("#input", ch);
    } else {
      await page.press("#input", "Enter");
      await waitUntil(async () => /^[a-z]+$/.test((await page.textContent("#word")).trim()), 1000);
      const shown = (await page.textContent("#word")).trim();
      if (!/^[a-z]+$/.test(shown)) continue;
      known.set(ja, shown);
      for (const ch of shown) await page.press("#input", ch);
    }
    await waitUntil(async () => (await page.textContent("#japanese")).trim() !== ja, 1500);
    await page.waitForTimeout(120);
    placement = await page.evaluate(() => {
      const raw = localStorage.getItem("spelldash_placement");
      return raw && raw !== "started" ? JSON.parse(raw) : null;
    });
  }
  check("10語で腕試しが確定（知ってた0）", placement && placement.total === 10 && placement.known === 0 && placement.boost === 0, JSON.stringify(placement));
  const seenLevels = await page.evaluate(async (ids) => {
    const m = await import("/js/wordStore.js");
    const pool = m.getWordsByCategory(localStorage.getItem("spelldash_category") || "all"); // 同じ綴りが他カテゴリにもあるので、出題中のカテゴリで引く
    return ids.map((en) => pool.find((w) => w.en === en)?.level);
  }, [...known.values()]);
  check("腕試しに普通・難しい語が混ざる", seenLevels.includes("normal") && seenLevels.includes("hard"), seenLevels.join(","));
  await waitUntil(async () => (await page.textContent("#message")).includes("腕試し"), 2500);
  check("腕試し結果のメッセージ", (await page.textContent("#message")).includes("腕試し"), await page.textContent("#message"));
  // 知ってた語が多い場合は即ブースト（モジュール直呼び）
  const boosted = await page.evaluate(async () => {
    const m = await import("/js/difficulty.js");
    localStorage.setItem("spelldash_placement", "started");
    localStorage.setItem("spelldash_first_sight", "[]");
    localStorage.setItem("spelldash_level_boost", "0");
    let r = null;
    for (let i = 0; i < 10; i++) r = m.recordFirstSight(i !== 3);
    return { boost: localStorage.getItem("spelldash_level_boost"), placement: r.placement, note: m.consumePlacementNote() };
  });
  check("10語中9語知ってた→難易度ブースト2", boosted.boost === "2" && boosted.placement?.known === 9 && boosted.note?.boost === 2, JSON.stringify(boosted));
  check("腕試しフローでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();
}
{
  // 中身予告＋回収: 苦手1（invoice, 昨日×）・復習1（budget, 期日到来）・新しい語2
  const y = new Date(Date.now() - 86400000);
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
  const yKey = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
  const todayKey = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  const page = await newPage({ storage: {
    spelldash_category: "my",
    spelldash_week_goal: "3",
    spelldash_growth_log: JSON.stringify([{ date: todayKey, learned: 0, mastered: 0, active: true }]),
    spelldash_my_words: JSON.stringify([{ en: "invoice", ja: "請求書" }, { en: "negotiate", ja: "交渉する" }, { en: "deadline", ja: "締め切り" }, { en: "budget", ja: "予算" }]),
    spelldash_word_stats: JSON.stringify({
      "my-invoice": { playCount: 1, correctCount: 0, missCount: 1, typingMiss: 0, recallFail: 1, cleanCorrectStreak: 0, mastered: false, lastPlayed: y.toISOString(), lastRecallFailAt: y.toISOString(), lastRecallSuccessAt: null, history: [{ d: yKey, r: "x" }] },
      "my-budget": { playCount: 2, correctCount: 2, missCount: 0, typingMiss: 0, recallFail: 0, cleanCorrectStreak: 2, mastered: false, lastPlayed: threeDaysAgo.toISOString(), nextReviewAt: y.toISOString(), lastRecallSuccessAt: threeDaysAgo.toISOString(), srsAdvancedOn: "2026-01-01" }
    })
  } });
  await page.goto(BASE + "/index.html?set=2", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const card = await page.textContent("#learnedCard");
  check("覚えたカードに週の目標（今週 1日 ・ 目標 3日）", /今週\s*1\s*日 ・ 目標 3日/.test(card.replace(/\s+/g, " ")), card.slice(0, 120)); // Batch 43: 「今週 N／M日」→「今週 N日 ・ 目標 M日」
  await page.press("#input", "Enter");
  await page.waitForTimeout(300);
  const startMsg = await page.textContent("#message");
  check("開始時にセットの中身予告（復習1・もう一度1）", startMsg.includes("復習 1") && startMsg.includes("もう一度 1") && startMsg.endsWith("から"), startMsg);
  check("苦手（Unresolved）が先頭", (await page.textContent("#japanese")).trim() === "請求書");
  await page.press("#input", "Enter"); // invoice: 答えを見る（思い出せず）
  await page.waitForTimeout(200);
  for (const ch of "invoice") await page.press("#input", ch);
  await waitUntil(async () => (await page.textContent("#japanese")).trim() !== "請求書", 1500);
  const answers = { 交渉する: "negotiate", 締め切り: "deadline", 予算: "budget" };
  for (let i = 0; i < 6; i++) {
    const done = !(await page.$eval("#resultPanel", (el) => el.hidden));
    if (done) break;
    const ja = (await page.textContent("#japanese")).trim();
    if (ja === "請求書") {
      await page.press("#input", "Enter");
      await page.waitForTimeout(150);
      for (const ch of "invoice") await page.press("#input", ch);
    } else if (answers[ja]) {
      for (const ch of answers[ja]) await page.press("#input", ch);
    }
    await page.waitForTimeout(450);
  }
  await waitUntil(async () => !(await page.$eval("#resultPanel", (el) => el.hidden)), 2000);
  const panel = await page.textContent("#resultPanel");
  check("完了パネルに「思い出せなかった1語をもう一度」", panel.includes("思い出せなかった1語をもう一度"), panel.slice(0, 160));
  check("完了パネルは数字1行（週の途中経過は出さない）", panel.includes("思い出せた") && panel.includes("思い出せず") && panel.includes("明日") && !panel.includes("目標まであと") && !/今週\s*\d+\s*\/\s*\d+日/.test(panel), panel.slice(0, 200));
  await page.click("#setRetry");
  await page.waitForTimeout(300);
  check("回収モードの案内", (await page.textContent("#message")).includes("もう一度"), await page.textContent("#message"));
  check("回収モードの進捗ラベル", (await page.textContent("#setProgress")).includes("もう一度") && (await page.textContent("#setProgress")).includes("/ 1"));
  check("回収モードでは思い出せなかった語だけ", (await page.textContent("#japanese")).trim() === "請求書", await page.textContent("#japanese"));
  for (const ch of "invoice") await page.press("#input", ch);
  await waitUntil(async () => (await page.textContent("#resultPanel")).includes("回収完了"), 2500);
  check("全部自力で打てたら「回収完了」", (await page.textContent("#resultPanel")).includes("回収完了"), (await page.textContent("#resultPanel")).slice(0, 80));
  const sets = await page.evaluate(() => JSON.parse(localStorage.getItem("spelldash_daily_set")).setsToday);
  check("回収はセット数に数えない", sets === 1, `setsToday=${sets}`);
  check("回収フローでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();

  const page2 = await newPage();
  await page2.goto(BASE + "/profile.html", { waitUntil: "networkidle" });
  await page2.waitForTimeout(600);
  check("週の目標の設定（既定4日）", (await page2.inputValue("#weekGoalSelect")) === "4");
  await page2.selectOption("#weekGoalSelect", "5");
  check("週の目標が保存される", (await page2.evaluate(() => localStorage.getItem("spelldash_week_goal"))) === "5");
  check("プロフィール（Batch 2）でエラー0", page2.errors.length === 0, page2.errors[0] ?? "");
  await page2.close();
}

// ===== 9.9 成長の証拠と獲得（Batch 3）: ミスキー／カレンダー／CSV／単語詳細／セットのシェア =====
console.log("growth evidence:");
{
  const todayKey = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  const y = new Date(Date.now() - 86400000);
  const yKey = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
  const now = new Date().toISOString();
  const seed = {
    spelldash_my_words: JSON.stringify([{ en: "invoice", ja: "請求書" }, { en: "negotiate", ja: "交渉する" }]),
    spelldash_growth_log: JSON.stringify([{ date: yKey, learned: 0, mastered: 0, active: true }, { date: todayKey, learned: 1, mastered: 0, active: true }]),
    spelldash_word_stats: JSON.stringify({
      "my-invoice": { playCount: 2, correctCount: 1, missCount: 1, typingMiss: 0, recallFail: 1, cleanCorrectStreak: 1, mastered: false, lastPlayed: now, nextReviewAt: new Date(Date.now() + 86400000).toISOString(), lastRecallFailAt: y.toISOString(), lastRecallSuccessAt: now, history: [{ d: yKey, r: "x" }, { d: todayKey, r: "o" }] }
    })
  };

  // ミスキー: Studyで1文字打ち間違える → 記録
  const page = await newPage({ storage: { ...seed, spelldash_category: "my" } });
  await page.goto(BASE + "/index.html?set=5", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.press("#input", "Enter");
  await page.waitForTimeout(300);
  await page.press("#input", "Enter"); // 答え表示
  await page.waitForTimeout(150);
  const shown = (await page.textContent("#word")).trim();
  const wrong = shown[0] === "z" ? "q" : "z";
  await page.press("#input", wrong); // 打ち間違い
  await page.waitForTimeout(150);
  const keyMiss = await page.evaluate(() => JSON.parse(localStorage.getItem("spelldash_key_miss") || "{}"));
  check("打ち間違いの文字と型が記録される", keyMiss.letters?.[shown[0]] === 1 && keyMiss.pairs?.[`${shown[0]}>${wrong}`] === 1, JSON.stringify(keyMiss));
  check("ミスキーでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  const keyMissRaw = await page.evaluate(() => localStorage.getItem("spelldash_key_miss"));
  await page.close();

  // 学習データ: ミスキー表示・カレンダー・CSV・単語詳細
  const page2 = await newPage({ storage: { ...seed, spelldash_key_miss: keyMissRaw } });
  await page2.goto(BASE + "/stats.html#words", { waitUntil: "networkidle" });
  await page2.waitForTimeout(900);
  const calDays = await page2.$$eval("#calendarGrid .cal .cal__day", (els) => ({ total: els.length, active: els.filter((e) => /cal__day--[1-4]/.test(e.className)).length }));
  check("学習カレンダー（13週×7日・学習日2）", calDays.total === 91 && calDays.active === 2, JSON.stringify(calDays)); // 「直近13週で N日」の行は Batch 46 で削除（カレンダーが見せる）
  const csv = await page2.evaluate(async () => (await import("/js/exportCsv.js")).buildLearnedCsv());
  check("覚えた単語帳CSVに見出しと語", csv.includes("english,japanese") && csv.includes("invoice,請求書") && csv.includes("xo"), csv.slice(0, 120));
  await page2.click("#learnedWordList [data-word-detail]");
  await page2.waitForTimeout(200);
  check("単語詳細が開く（語・訳・状態・履歴）", !(await page2.$eval("#wordDetail", (el) => el.hidden)) && /invoice/.test(await page2.textContent("#wordDetailPanel")) && (await page2.textContent("#wordDetailPanel")).includes("請求書") && (await page2.textContent("#wordDetailPanel")).includes("覚えた") && (await page2.$("#wordDetailPanel .hist__x")) !== null, (await page2.textContent("#wordDetailPanel")).slice(0, 120));
  await page2.fill("#wordDetailNote", "in+voice");
  await page2.press("#wordDetailNote", "Enter");
  await page2.waitForTimeout(150);
  const notes = await page2.evaluate(() => JSON.parse(localStorage.getItem("spelldash_word_notes") || "{}"));
  check("詳細からメモを保存できる", notes["my-invoice"] === "in+voice", JSON.stringify(notes));
  await page2.keyboard.press("Escape");
  await page2.waitForTimeout(100);
  check("Escで詳細が閉じる", await page2.$eval("#wordDetail", (el) => el.hidden));
  check("学習データ（Batch 3）でエラー0", page2.errors.length === 0, page2.errors[0] ?? "");
  await page2.close();
}

// ===== 9.95 Challenge・品質（Batch 4）: 前回比／カテゴリ別ベスト／Esc・Tab／ランクアップ／明日の予告／音量／オフライン =====
console.log("challenge & quality:");
{
  // Challenge 2回: 1回目はカテゴリ別ベスト、2回目は前回比
  const page = await newPage({ storage: { spelldash_category: "ads", spelldash_mode: "challenge" } });
  await page.goto(BASE + "/index.html?t=2", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.press("#input", "Enter");
  await waitUntil(async () => !(await page.$eval("#resultPanel", (el) => el.hidden)), 5000);
  const panel1 = await page.textContent("#resultPanel");
  check("Challenge結果の数字は1行（スコア・ベスト・速度・経験値）", panel1.includes("スコア") && panel1.includes("ベスト") && panel1.includes("速度") && panel1.includes("経験値") && !panel1.includes("広告・マーケ"), panel1.slice(0, 160));
  check("1回目は前回比なし", !panel1.includes("前回"));
  await page.click("#resultRetry");
  await waitUntil(async () => !(await page.$eval("#resultPanel", (el) => el.hidden)), 5000);
  const panel2 = await page.textContent("#resultPanel");
  check("2回目は前回比が出る", /前回 \d+ → \d+/.test(panel2), panel2.slice(0, 200));
  check("Challenge（Batch 4）でエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();

  // Esc = 分からない（答え表示）、Ctrl+. = 発音（エラーなし・進行しない）、Tab は既定どおり次の要素へ（キーボードトラップなし）。ランクアップ演出（Lv1→2 = F3→F2）
  const tomorrow = new Date(Date.now() + 20 * 3600000);
  const page2 = await newPage({ storage: {
    spelldash_category: "my",
    spelldash_xp: "95",
    spelldash_my_words: JSON.stringify([{ en: "invoice", ja: "請求書" }, { en: "budget", ja: "予算" }]),
    spelldash_word_stats: JSON.stringify({
      "my-budget": { playCount: 2, correctCount: 2, missCount: 0, typingMiss: 0, recallFail: 0, cleanCorrectStreak: 2, mastered: false, lastPlayed: new Date(Date.now() - 3 * 86400000).toISOString(), nextReviewAt: tomorrow.toISOString(), lastRecallSuccessAt: new Date(Date.now() - 3 * 86400000).toISOString(), srsAdvancedOn: "2026-01-01" }
    })
  } });
  await page2.goto(BASE + "/index.html?set=1", { waitUntil: "networkidle" });
  await page2.waitForTimeout(900);
  await page2.press("#input", "Enter");
  await page2.waitForTimeout(300);
  const ja = (await page2.textContent("#japanese")).trim();
  await page2.press("#input", "Tab");
  await page2.waitForTimeout(100);
  check("Tabで進行しない（フォーカスは入力欄から次の要素へ）", (await page2.textContent("#japanese")).trim() === ja && (await page2.evaluate(() => document.activeElement?.id)) !== "input");
  await page2.focus("#input");
  await page2.press("#input", "Control+.");
  await page2.waitForTimeout(100);
  check("Ctrl+.で発音のみ（進行せず・フォーカスは入力欄のまま）", (await page2.textContent("#japanese")).trim() === ja && (await page2.evaluate(() => document.activeElement?.id)) === "input");
  await page2.press("#input", "Escape");
  await page2.waitForTimeout(150);
  check("Escで答えが表示される（×扱い）", /^[a-z]+$/.test((await page2.textContent("#word")).trim()) && (await page2.textContent("#recallFail")).trim() === "1");
  const shown = (await page2.textContent("#word")).trim();
  for (const ch of shown) await page2.press("#input", ch);
  const rankUp = await waitUntil(async () => (await page2.$(".rank-up")) !== null, 1500);
  check("ランクアップ演出（F3→F2）", rankUp && (await page2.textContent(".rank-up")).includes("F2"));
  // 明日の予告: セットを完了させる（残り1語を自力で）
  await waitUntil(async () => !(await page2.$eval("#resultPanel", (el) => el.hidden)) || (await page2.textContent("#japanese")).trim() !== ja, 1500);
  const answers = { 請求書: "invoice", 予算: "budget" };
  for (let i = 0; i < 6; i++) {
    if (!(await page2.$eval("#resultPanel", (el) => el.hidden))) break;
    const j = (await page2.textContent("#japanese")).trim();
    if (answers[j]) for (const ch of answers[j]) await page2.press("#input", ch);
    await page2.waitForTimeout(450);
  }
  await waitUntil(async () => !(await page2.$eval("#resultPanel", (el) => el.hidden)), 2000);
  const panel = await page2.textContent("#resultPanel");
  check("完了パネルに明日の復習（語つき）", panel.includes("明日の復習: ") && /明日の復習: [a-z]/.test(panel) && !panel.includes("明日は "), panel.slice(0, 220));
  check("Esc/Tab/ランクアップでエラー0", page2.errors.length === 0, page2.errors[0] ?? "");
  await page2.close();

  // 音量設定＋オフライン表示
  const page3 = await newPage();
  await page3.goto(BASE + "/profile.html", { waitUntil: "networkidle" });
  await page3.waitForTimeout(600);
  check("音量スライダー（既定100%）", (await page3.inputValue("#volumeRange")) === "100");
  await page3.$eval("#volumeRange", (el) => { el.value = "50"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  const audio = await page3.evaluate(() => JSON.parse(localStorage.getItem("spelldash_audio") || "{}"));
  check("音量が保存される（0.5）", audio.volume === 0.5, JSON.stringify(audio));
  await page3.context().setOffline(true);
  const offlineShown = await waitUntil(async () => (await page3.$(".offline-banner:not([hidden])")) !== null, 2000);
  check("オフラインで案内バナー", offlineShown);
  await page3.context().setOffline(false);
  const offlineHidden = await waitUntil(async () => (await page3.$(".offline-banner:not([hidden])")) === null, 2000);
  check("オンライン復帰でバナーが消える", offlineHidden);
  check("音量／オフラインでエラー0", page3.errors.length === 0, page3.errors[0] ?? "");
  await page3.close();
}

// ===== 9.97 概念カード「リスティング広告 実務」: 場面→用語、日本語で答える全文入力モード =====
console.log("concept cards:");
{
  const page = await newPage({ storage: { spelldash_category: "listing", spelldash_placement: "done", spelldash_level_boost: "2",
    spelldash_streak: JSON.stringify({ last: (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })(), current: 1, best: 1, shields: 0 }) } });
  await page.goto(BASE + "/index.html?set=3", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  check("カテゴリチップに「リスティング広告 実務」", (await page.textContent("#categoryPicker")).includes("リスティング広告 実務"));
  const excluded = await page.evaluate(async () => {
    const ws = await import("/js/wordStore.js");
    const dc = await import("/js/dailyChallenge.js");
    return {
      all: ws.getWordsByCategory("all").some((w) => w.kind === "concept"),
      daily: dc.getDailyWords().some((w) => w.kind === "concept"),
      count: ws.getWordsByCategory("listing").length
    };
  });
  check("概念カードは「すべて」とDailyに混ざらない（127語）", !excluded.all && !excluded.daily && excluded.count === 127, JSON.stringify(excluded));
  await page.press("#input", "Enter");
  await page.waitForTimeout(300);
  const findCard = async () => {
    const prompt = (await page.textContent("#japanese")).trim();
    return page.evaluate(async (q) => {
      const ws = await import("/js/wordStore.js");
      const w = ws.getWordsByCategory("listing").find((x) => x.q === q);
      return w ? { en: w.en, accept: w.accept, explain: w.explain, free: !/^[a-z-]+$/.test(w.en) } : null;
    }, prompt);
  };
  let card = await findCard();
  check("出題文は場面の説明（q）", !!card && (await page.textContent("#japanese")).trim().length > 12, JSON.stringify(card));
  // 1語目: 答えを見る → 解説が出る → 答えを打って練習（全文入力なら fill+Enter）
  await page.press("#input", "Enter");
  await page.waitForTimeout(200);
  check("答え表示で用語と解説が出る", (await page.textContent("#word")).replace(/\s/g, "").includes(card.en.replace(/\s/g, "")) && (await page.textContent("#wordExplain")).trim().length > 0);
  if (card.free) {
    await page.fill("#input", card.en);
    await page.press("#input", "Enter");
  } else {
    for (const ch of card.en) await page.press("#input", ch);
  }
  await waitUntil(async () => (await page.textContent("#score")).trim() === "1", 2000);
  check("答えを打って練習できる（score 1）", (await page.textContent("#score")).trim() === "1");
  await page.press("#input", "Enter"); // 次へ
  await waitUntil(async () => (await findCard()) && (await findCard()).en !== card.en, 3000);
  // 2語目: 自力で答える。全文入力なら別解（accept）で、IMEの表記ゆれもOK
  card = await findCard();
  const typed = card.free ? (card.accept[0] ?? card.en) : card.en;
  if (card.free) {
    await page.fill("#input", typed);
    await page.press("#input", "Enter");
  } else {
    for (const ch of typed) await page.press("#input", ch);
  }
  await waitUntil(async () => (await page.textContent("#score")).trim() === "2", 2000);
  check(`自力正解（${card.free ? "別解で全文入力" : "スペル入力"}）`, (await page.textContent("#score")).trim() === "2" && (await page.textContent("#recalledToday")).trim() === "1", `typed=${typed}`);
  check("正解後も用語と解説が残る（読む時間）", (await page.textContent("#wordExplain")).trim().length > 0);
  await page.press("#input", "Enter"); // 待たずに次へ
  await waitUntil(async () => (await findCard()) && (await findCard()).en !== card.en, 3000);
  // 3語目: 全文入力で間違える → 答え表示＋×（1ミス＝不正解と同じ扱い）
  card = await findCard();
  const before = Number((await page.textContent("#recallFail")).trim());
  if (card.free) {
    await page.fill("#input", "まちがい");
    await page.press("#input", "Enter");
  } else {
    await page.press("#input", card.en[0] === "z" ? "q" : "z");
  }
  await page.waitForTimeout(200);
  check("間違えると答え表示＋思い出せず+1", Number((await page.textContent("#recallFail")).trim()) === before + 1 && (await page.textContent("#word")).replace(/\s/g, "").includes(card.en.replace(/\s/g, "")));
  check("概念カードでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();

  const page2 = await newPage();
  await page2.goto(BASE + "/battle.html", { waitUntil: "networkidle" });
  await page2.waitForTimeout(700);
  const opts = await page2.$$eval("#battleCategory option", (els) => els.map((e) => e.value));
  check("Battleのカテゴリに概念カードは出ない", opts.length > 0 && !opts.includes("listing"), opts.join(","));
  await page2.close();
}

// ===== 9.98 単語帳: ジャンルごとの一覧＋ジャンルで絞って練習 =====
console.log("genre list:");
{
  const page = await newPage({ storage: {
    spelldash_word_notes: JSON.stringify({ "concept-cpc": "Cost per Click" }),
    spelldash_word_stats: JSON.stringify({ "concept-cpc": { playCount: 2, correctCount: 1, missCount: 1, typingMiss: 0, recallFail: 1, cleanCorrectStreak: 1, mastered: false, lastPlayed: new Date().toISOString(), lastRecallFailAt: new Date(Date.now() - 86400000).toISOString(), lastRecallSuccessAt: new Date().toISOString(), history: [{ d: "2026-09-06", r: "x" }, { d: "2026-09-07", r: "o" }] } })
  } });
  await page.goto(BASE + "/list.html?category=listing", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  check("ナビに「単語帳」", (await page.textContent(".site-nav")).includes("単語帳"));
  const genres = await page.$$eval("#listGenres .genre-chip", (els) => els.map((e) => e.textContent.trim()));
  check("ジャンルのナビ（15ジャンル・ラベル化）", genres.length === 15 && genres.some((g) => g.startsWith("指標・略語")) && genres.some((g) => g.startsWith("計算ドリル")), genres.join(","));
  const cards = await page.$$eval(".gcard", (els) => els.length);
  check("127枚がジャンルごとに並ぶ", cards === 127 && (await page.$$eval(".genre", (els) => els.length)) === 15, `cards=${cards}`);
  const cpc = await page.$eval("#genre-metrics", (el) => el.textContent);
  check("カードに場面・解説・状態・メモ", cpc.includes("CPC") && cpc.includes("100クリックで1万円") && cpc.includes("覚えた") && cpc.includes("Cost per Click"));
  check("一覧のまとめ行", (await page.textContent("#listSummary")).includes("15ジャンル") && (await page.textContent("#listSummary")).includes("127語"));
  await page.fill("#listSearch", "重量税");
  await page.waitForTimeout(150);
  const hits = await page.$$eval(".gcard", (els) => els.length);
  check("検索で絞り込める（用語・場面・解説を横断）", hits >= 1 && hits <= 3 && (await page.textContent("#listBody")).includes("重量税還付"), `hits=${hits}`);
  await page.fill("#listSearch", "");
  await page.waitForTimeout(150);
  await page.selectOption("#listCategory", "ads");
  await page.waitForTimeout(200);
  check("カテゴリを切り替えると別のジャンル（広告・マーケ）", (await page.textContent("#listSummary")).includes("広告・マーケ") && (await page.$$eval(".gcard", (els) => els.length)) === 101);
  await page.selectOption("#listCategory", "listing");
  await page.waitForTimeout(200);
  await page.click('[data-practice="bidding"]');
  await page.waitForURL((u) => u.pathname === "/" || u.pathname === "/index.html", { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(900);
  check("「このジャンルを練習」でホームへ（カテゴリ＋ジャンルが保存）", (await page.evaluate(() => localStorage.getItem("spelldash_category"))) === "listing" && (await page.evaluate(() => localStorage.getItem("spelldash_genre"))) === "bidding");
  check("ホームにジャンルの絞り込み表示", (await page.textContent("#genreBar")).includes("入札・配信") && (await page.$("#genreClear")) !== null);
  await page.press("#input", "Enter");
  await page.waitForTimeout(300);
  const prompt = (await page.textContent("#japanese")).trim();
  const tag = await page.evaluate(async (q) => {
    const ws = await import("/js/wordStore.js");
    return ws.getWordsByCategory("listing").find((w) => w.q === q)?.tags?.[0] ?? null;
  }, prompt);
  check("Studyがそのジャンルだけになる", tag === "bidding", `tag=${tag}`);
  check("単語帳フローでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();

  const page2 = await newPage({ storage: { spelldash_category: "listing", spelldash_genre: "bidding" } });
  await page2.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await page2.waitForTimeout(900);
  await page2.click("#setupToggle");
  await page2.click('.category-chip[data-category="ads"]');
  await page2.waitForTimeout(100);
  check("カテゴリを変えるとジャンルは解除", (await page2.evaluate(() => localStorage.getItem("spelldash_genre"))) === null && !(await page2.textContent("#genreBar")).includes("解除"));
  await page2.close();

  const page3 = await newPage();
  await page3.goto(BASE + "/stats.html", { waitUntil: "networkidle" });
  await page3.waitForTimeout(800);
  check("カテゴリ別進捗に「一覧」リンク", (await page3.$$eval(".cat-row__list", (els) => els.map((e) => e.getAttribute("href")))).includes("./list.html?category=listing"));
  await page3.close();
}

// ===== 9.99 Batch 5a: マイ場面カード／まとめて追加／記憶ゲージ／救済／今月／制覇／ログイン案内 =====
console.log("my concept & retention:");
{
  const todayKey = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  const dayKey = (i) => { const d = new Date(Date.now() - i * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  // マイ単語帳: 場面カードのフォーム＋まとめて追加（→形式・タブ区切り見出しつき）
  const page = await newPage();
  await page.goto(BASE + "/list.html#myWords", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.click('[data-my-tab="concept"]');
  check("場面カードのタブでフォームが切り替わる", !(await page.$eval("#myConceptForm", (el) => el.hidden)) && (await page.$eval("#myWordForm", (el) => el.hidden)));
  await page.fill("#myConceptQ", "ユーザーが「車 買取」等を検索する");
  await page.fill("#myConceptAnswer", "検索需要");
  await page.fill("#myConceptExplain", "広告を出す前提になる量");
  await page.fill("#myConceptAccept", "検索ニーズ/需要");
  await page.click("#myConceptForm button[type=submit]");
  await page.waitForTimeout(200);
  check("場面カードを追加できる", (await page.textContent("#myWordStatus")).includes("検索需要") && (await page.textContent("#myWordList")).includes("車 買取"));
  await page.click(".my-words__bulk summary");
  await page.fill("#myWordBulk", "english\tjapanese\ninvoice\t請求書\nCost ÷ Click → CPC | クリック単価\n表示回数のうちクリックされた割合 → クリック率 | CTR | ctr/CTR");
  await page.click("#myWordBulkAdd");
  await page.waitForTimeout(200);
  const myWords = await page.evaluate(() => JSON.parse(localStorage.getItem("spelldash_my_words") || "[]"));
  check("まとめて追加: 見出し行を飛ばし、英単語1＋場面カード2", myWords.length === 4 && myWords.filter((w) => w.kind === "concept").length === 3 && myWords.some((w) => w.answer === "CPC") && myWords.some((w) => w.answer === "クリック率" && w.accept.includes("ctr")), JSON.stringify(myWords).slice(0, 200));
  await page.goto(BASE + "/stats.html#words", { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  check("今月のまとめが出る", (await page.textContent("#monthlySummary")).includes("学習した日"));
  check("マイ単語帳（場面カード）でエラー0", page.errors.length === 0, page.errors[0] ?? "");
  const myRaw = await page.evaluate(() => localStorage.getItem("spelldash_my_words"));
  await page.close();

  // ホーム: マイ単語帳の場面カードが全文入力で出題される（検索需要を別解で正解）
  const page2 = await newPage({ storage: { spelldash_category: "my", spelldash_my_words: myRaw, spelldash_placement: "done" } });
  await page2.goto(BASE + "/index.html?set=4", { waitUntil: "networkidle" });
  await page2.waitForTimeout(900);
  await page2.press("#input", "Enter");
  await page2.waitForTimeout(300);
  let answered = false;
  for (let i = 0; i < 6 && !answered; i++) {
    const q = (await page2.textContent("#japanese")).trim();
    if (q.includes("車 買取")) {
      await page2.fill("#input", "需要");
      await page2.press("#input", "Enter");
      await waitUntil(async () => (await page2.textContent("#recalledToday")).trim() === "1", 2000);
      answered = (await page2.textContent("#recalledToday")).trim() === "1";
      break;
    }
    await page2.press("#input", "Enter");
    await page2.waitForTimeout(150);
    await page2.press("#input", "Enter");
    await page2.waitForTimeout(300);
  }
  check("自分の場面カードが出題され、別解で自力正解", answered);
  check("マイ場面カードの出題でエラー0", page2.errors.length === 0, page2.errors[0] ?? "");
  await page2.close();

  // 救済: 3連続で思い出せなかったら、思い出せる語（Familiar）が次に挟まる
  const y = new Date(Date.now() - 3 * 86400000).toISOString();
  const page3 = await newPage({ storage: {
    spelldash_category: "my", spelldash_placement: "done",
    spelldash_study_mix: JSON.stringify({ familiarRatio: 0, updatedAt: null }), // 既知語（予算）は救済でしか出ないようにする
    spelldash_my_words: JSON.stringify([{ en: "invoice", ja: "請求書" }, { en: "negotiate", ja: "交渉する" }, { en: "deadline", ja: "締め切り" }, { en: "budget", ja: "予算" }, { en: "revenue", ja: "売上" }]),
    spelldash_word_stats: JSON.stringify({ "my-budget": { playCount: 3, correctCount: 3, missCount: 0, typingMiss: 0, recallFail: 0, cleanCorrectStreak: 3, mastered: false, lastPlayed: y, nextReviewAt: new Date(Date.now() + 5 * 86400000).toISOString(), lastRecallSuccessAt: y, srsAdvancedOn: "2026-01-01" } })
  } });
  await page3.goto(BASE + "/index.html?set=5", { waitUntil: "networkidle" });
  await page3.waitForTimeout(900);
  await page3.press("#input", "Enter");
  await page3.waitForTimeout(300);
  let breather = false;
  for (let i = 0; i < 3; i++) {
    const ja = (await page3.textContent("#japanese")).trim();
    if (ja === "予算") { breather = false; break; }
    await page3.press("#input", "Enter"); // 思い出せず
    await page3.waitForTimeout(150);
    if (i === 2) breather = !(await page3.$eval("#learnToast", (el) => el.hidden)) && (await page3.textContent("#learnToast")).includes("3つ続けて");
    const shown = (await page3.textContent("#word")).trim();
    for (const ch of shown) await page3.press("#input", ch);
    await page3.waitForTimeout(400);
  }
  check("3連続で思い出せず→はちゃんの助け舟", breather);
  check("次に思い出せる語（予算）が挟まる", (await page3.textContent("#japanese")).trim() === "予算", await page3.textContent("#japanese"));
  check("救済フローでエラー0", page3.errors.length === 0, page3.errors[0] ?? "");
  await page3.close();

  // ログイン案内（3日以上学習・未ログイン・1回だけ）＋ 記憶ゲージ ＋ 制覇
  const page4 = await newPage({ storage: {
    spelldash_growth_log: JSON.stringify([{ date: dayKey(4), learned: 1, mastered: 0, active: true }, { date: dayKey(2), learned: 2, mastered: 0, active: true }, { date: todayKey, learned: 3, mastered: 0, active: true }]),
    spelldash_my_words: JSON.stringify([{ en: "invoice", ja: "請求書" }]),
    spelldash_word_stats: JSON.stringify({ "my-invoice": { playCount: 4, correctCount: 3, missCount: 1, typingMiss: 0, recallFail: 1, cleanCorrectStreak: 3, mastered: false, lastPlayed: y, nextReviewAt: new Date(Date.now() + 2 * 86400000).toISOString(), lastRecallFailAt: new Date(Date.now() - 6 * 86400000).toISOString(), lastRecallSuccessAt: y, history: [{ d: dayKey(6), r: "x" }, { d: dayKey(3), r: "o" }] } })
  } });
  await page4.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await page4.waitForTimeout(900);
  check("3日以上学習した未ログインにログイン案内", (await page4.textContent("#loginNudge")).includes("ログイン") && (await page4.$("#loginNudgeLater")) !== null);
  await page4.click("#loginNudgeLater");
  check("「あとで」で消えて記録される", (await page4.textContent("#loginNudge")).trim() === "" && (await page4.evaluate(() => localStorage.getItem("spelldash_login_nudge"))) === "later");
  await page4.goto(BASE + "/list.html?category=my", { waitUntil: "networkidle" });
  await page4.waitForTimeout(800);
  const listText = await page4.textContent("#listBody");
  check("単語帳: 覚えた（習得前）の語には記憶ゲージが出ない", (await page4.$(".mem__bar")) === null && !listText.includes("/10"), listText.slice(0, 160));
  check("ジャンル全部覚えたら「全部済み」", listText.includes("全部済み"));
  check("ログイン案内／ゲージでエラー0", page4.errors.length === 0, page4.errors[0] ?? "");
  await page4.close();

  // 記憶ゲージは苦手（最後に思い出せなかったまま）の語だけ
  const pageW = await newPage({ storage: {
    spelldash_my_words: JSON.stringify([{ en: "invoice", ja: "請求書" }]),
    spelldash_word_stats: JSON.stringify({ "my-invoice": { playCount: 4, correctCount: 3, missCount: 1, typingMiss: 0, recallFail: 1, cleanCorrectStreak: 3, mastered: false, lastPlayed: new Date(Date.now() - 86400000).toISOString(), nextReviewAt: new Date(Date.now() + 2 * 86400000).toISOString(), lastRecallFailAt: new Date(Date.now() - 86400000).toISOString(), lastRecallSuccessAt: y, history: [{ d: dayKey(3), r: "o" }, { d: dayKey(1), r: "x" }] } })
  } });
  await pageW.goto(BASE + "/list.html?category=my", { waitUntil: "networkidle" });
  await pageW.waitForTimeout(800);
  const listTextW = await pageW.textContent("#listBody");
  check("単語帳: 苦手の語に記憶ゲージ（3/10・復習2日後）", (await pageW.$(".mem__bar")) !== null && listTextW.includes("3/10") && listTextW.includes("復習: 2日後"), listTextW.slice(0, 160));
  check("苦手ゲージでエラー0", pageW.errors.length === 0, pageW.errors[0] ?? "");
  await pageW.close();

  // 初回オンボーディングは「腕試し」導線
  const page5 = await newPage({ keepOnboarding: true });
  await page5.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await page5.waitForTimeout(800);
  // 初めての人: アプリの代わりにトップページ。1語体験 → 「無料で始める」で腕試しへ
  check("初回はトップページが出てアプリは隠れる", (await page5.isVisible("#welcome")) && !(await page5.isVisible("#pathCard")) && (await page5.textContent("#welcome")).includes("無料で始める"));
  await page5.click("#welcomeDemoInput");
  for (const ch of "apple") await page5.press("#welcomeDemoInput", ch);
  await page5.waitForTimeout(200);
  check("トップの1語体験: apple を打つと思い出せた", (await page5.textContent("#welcomeDemoMsg")).includes("思い出せた"));
  await page5.waitForTimeout(1200);
  await page5.press("#welcomeDemoInput", "Enter");
  check("トップの1語体験: Enter で答えが見える", (await page5.textContent("#welcomeDemoMsg")).includes("school"));
  check("初回は道のスタートに腕試しの案内・既定コースは中学英語やり直し", (await page5.textContent("#pathCard")).includes("腕試し") && (await page5.textContent("#pathCard")).includes("中学英語やり直し") && (await page5.evaluate(() => localStorage.getItem("spelldash_category"))) === "jhs-english1");
  check("初回は Daily・Battle が未解放、Challenge は解放", (await page5.$$("#playModes .play-modes__row--locked")).length === 2 && (await page5.$('#playModes [data-mode="challenge"]')) !== null);
  await page5.click("#welcome .welcome__cta [data-welcome-start]");
  await page5.waitForTimeout(900);
  check("「無料で始める」でトップが消え、腕試しが始まる", !(await page5.isVisible("#welcome")) && (await page5.isVisible("#pathCard")) && (await page5.evaluate(() => localStorage.getItem("spelldash_placement"))) === "started" && (await page5.evaluate(() => localStorage.getItem("spelldash_onboarded"))) === "1");
  check("トップページのフローでエラー0", page5.errors.length === 0, page5.errors[0] ?? "");
  // 深いリンク（?set= など）や2回目以降はトップページを出さない
  const page5b = await newPage({ keepOnboarding: true });
  await page5b.goto(BASE + "/index.html?set=5", { waitUntil: "networkidle" });
  await page5b.waitForTimeout(600);
  check("深いリンクではトップページを出さない", !(await page5b.isVisible("#welcome")) && (await page5b.isVisible("#pathCard")));
  await page5b.close();
  await page5.close();
}

// ===== 9.995 Batch 5b: 学習データ3タブ／一覧フィルタと苦手だけ練習／累計シェア／CTAのジャンル名 =====
console.log("tabs & filters:");
{
  const y = new Date(Date.now() - 86400000).toISOString();
  const seed = {
    spelldash_my_words: JSON.stringify([{ en: "invoice", ja: "請求書" }, { en: "negotiate", ja: "交渉する" }, { en: "deadline", ja: "締め切り" }]),
    spelldash_word_stats: JSON.stringify({
      "my-invoice": { playCount: 2, correctCount: 0, missCount: 2, typingMiss: 0, recallFail: 2, cleanCorrectStreak: 0, mastered: false, lastPlayed: y, lastRecallFailAt: y, lastRecallSuccessAt: null },
      "my-negotiate": { playCount: 2, correctCount: 1, missCount: 1, typingMiss: 0, recallFail: 1, cleanCorrectStreak: 1, mastered: false, lastPlayed: y, lastRecallFailAt: new Date(Date.now() - 3 * 86400000).toISOString(), lastRecallSuccessAt: y, history: [{ d: "2026-09-04", r: "x" }, { d: "2026-09-06", r: "o" }] }
    })
  };
  const page = await newPage({ storage: seed });
  await page.goto(BASE + "/stats.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  check("学習データは3タブ（既定は今週）", (await page.$$(".stats-tab")).length === 3 && !(await page.$eval("#weekly", (el) => el.hidden)) && (await page.$eval("#learnedWords", (el) => el.hidden)));
  await page.click('.stats-tab[data-tab="analysis"]');
  await page.waitForTimeout(150);
  check("分析タブでタイピング分析が見える", !(await page.$eval("#typingMetrics", (el) => el.closest("[data-tab]").hidden)) && (await page.$eval("#weekly", (el) => el.hidden)));
  await page.goto(BASE + "/stats.html#learnedWords", { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  check("#learnedWords の深いリンクで単語帳タブが開く", !(await page.$eval("#learnedWords", (el) => el.hidden)) && (await page.$eval(".stats-tab--active", (el) => el.dataset.tab)) === "words");
  check("前回のタブを覚える", (await page.evaluate(() => localStorage.getItem("spelldash_stats_tab"))) === "words");
  check("学習データ（タブ）でエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();

  const page2 = await newPage({ storage: seed });
  await page2.goto(BASE + "/list.html?category=my", { waitUntil: "networkidle" });
  await page2.waitForTimeout(800);
  await page2.click('[data-filter="weak"]');
  await page2.waitForTimeout(150);
  const weakCards = await page2.$$eval(".gcard__term", (els) => els.map((e) => e.textContent.trim()));
  check("一覧の「苦手」フィルタ", weakCards.length === 1 && weakCards[0] === "invoice", weakCards.join(","));
  await page2.click('[data-filter="learned"]');
  await page2.waitForTimeout(150);
  check("一覧の「覚えた」フィルタ", (await page2.$$eval(".gcard__term", (els) => els.map((e) => e.textContent.trim()))).join(",") === "negotiate");
  await page2.click('[data-filter="all"]');
  await page2.waitForTimeout(150);
  await page2.click("[data-practice-words]");
  await page2.waitForURL((u) => u.pathname === "/" || u.pathname === "/index.html", { timeout: 3000 }).catch(() => {});
  await page2.waitForTimeout(1200);
  check("「苦手だけ練習」でその語だけのセッションが始まる", (await page2.textContent("#setProgress")).includes("もう一度") && (await page2.textContent("#japanese")).trim() === "請求書", `${await page2.textContent("#setProgress")} / ${await page2.textContent("#japanese")}`);
  check("苦手だけ練習でエラー0", page2.errors.length === 0, page2.errors[0] ?? "");
  await page2.close();

  const page3 = await newPage({ storage: { spelldash_category: "listing", spelldash_genre: "bidding" } });
  await page3.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await page3.waitForTimeout(800);
  check("出題の要約にジャンル名（入札・配信）", (await page3.textContent("#setupSummary")).includes("入札・配信"));
  await page3.close();
}

// ===== 9.999 Batch 6: 計算ドリル／音で出題／混同注意 =====
console.log("calc & listen:");
{
  // 計算カード: 生成器の整合性（8種）
  const page = await newPage({ storage: { spelldash_category: "listing", spelldash_genre: "calc", spelldash_placement: "done", spelldash_level_boost: "2" } });
  await page.goto(BASE + "/index.html?set=3", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const calcOk = await page.evaluate(async () => {
    const m = await import("/js/calcCards.js");
    const out = {};
    const v = (kind) => m.generateCalc(kind);
    let g;
    g = v("cpc"); out.cpc = g.answer === String(g.values.cost / g.values.click) && g.accept.includes(`${g.values.cpc}円`);
    g = v("cpa"); out.cpa = g.answer === String(g.values.cost / g.values.cv);
    g = v("ctr"); out.ctr = g.answer === `${g.values.ctr}%` && Math.abs(g.values.click / g.values.imp * 100 - g.values.ctr) < 1e-9;
    g = v("cvr"); out.cvr = g.answer === `${g.values.cvr}%` && Math.abs(g.values.cv / g.values.click * 100 - g.values.cvr) < 1e-9;
    g = v("roas"); out.roas = g.answer === `${g.values.roas}%` && g.values.value / g.values.cost * 100 === g.values.roas;
    g = v("cpa-decomp"); out.decomp = Number(g.answer) === Math.round(g.values.cpc / (g.values.cvr / 100));
    g = v("lead-value"); out.lead = Number(g.answer) === g.values.deals * g.values.profit / 100;
    g = v("marginal-cpa"); out.marginal = Number(g.answer) === g.values.extraCost / g.values.extraCv && g.explain.includes("=");
    return out;
  });
  check("計算カード8種の答えが式と一致", Object.values(calcOk).every(Boolean), JSON.stringify(calcOk));
  // Studyで計算カードが出る → 数字を間違える → 答え＋計算過程 → ヒントは式
  await page.press("#input", "Enter");
  await page.waitForTimeout(300);
  check("計算カードのラベルと数字入りの出題", (await page.textContent("#gameCard .label")).includes("計算") && /[0-9]/.test(await page.textContent("#japanese")));
  const prompt = (await page.textContent("#japanese")).trim();
  const expected = await page.evaluate(async (q) => {
    // 出題文から数字を拾って CPC/CPA 等を逆算（Cost と Click/CV が明記されている型だけ）
    const nums = (q.match(/[0-9][0-9,]*/g) ?? []).map((n) => Number(n.replace(/,/g, "")));
    return nums;
  }, prompt);
  await page.fill("#input", "0"); // 0 は生成されない（答えが 1% のとき "1" だと正解扱いになる）
  await page.press("#input", "Enter");
  await page.waitForTimeout(250);
  const shownAnswer = (await page.textContent("#word")).trim();
  check("間違えると答えと計算過程", /^[0-9.]+%?$/.test(shownAnswer) && (await page.textContent("#wordExplain")).includes("=") && (await page.textContent("#recallFail")).trim() === "1", `answer=${shownAnswer} nums=${expected.join(",")}`);
  await page.fill("#input", shownAnswer);
  await page.press("#input", "Enter");
  await waitUntil(async () => (await page.textContent("#score")).trim() === "1", 2000);
  check("答えを打って練習できる", (await page.textContent("#score")).trim() === "1");
  await page.press("#input", "Enter");
  await page.waitForTimeout(400);
  await page.goto(BASE + "/index.html?set=3&hintms=200", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.press("#input", "Enter");
  const hintShown = await waitUntil(async () => !(await page.$eval("#hintButton", (el) => el.hidden)), 2000);
  if (hintShown) await page.click("#hintButton");
  await page.waitForTimeout(150);
  check("計算カードのヒントは式", hintShown && /[=÷×]/.test(await page.textContent("#word")), await page.textContent("#word"));
  check("計算ドリルでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();

  // 音で出題（100%相当は無いので50%を何回か試す）＋ 混同注意（adapt/adopt）
  const page2 = await newPage({ storage: {
    spelldash_category: "my", spelldash_placement: "done",
    spelldash_audio: JSON.stringify({ mode: "auto", accent: "us", listenRatio: 50 }),
    spelldash_my_words: JSON.stringify([{ en: "adapt", ja: "適応する" }, { en: "adopt", ja: "採用する" }, { en: "invoice", ja: "請求書" }, { en: "deadline", ja: "締め切り" }])
  } });
  await page2.goto(BASE + "/index.html?set=8", { waitUntil: "networkidle" });
  await page2.waitForTimeout(900);
  await page2.press("#input", "Enter");
  await page2.waitForTimeout(300);
  let sawListen = false;
  let sawConfusable = false;
  for (let i = 0; i < 10 && !(sawListen && sawConfusable); i++) {
    const prompt = (await page2.textContent("#japanese")).trim();
    if (prompt.includes("聞いて打つ")) sawListen = true;
    await page2.press("#input", "Enter"); // 答え表示
    await page2.waitForTimeout(150);
    const shown = (await page2.textContent("#word")).trim();
    if (sawListen && prompt.includes("聞いて打つ")) {
      check("音で出題: 答え表示で意味が出る", !(await page2.textContent("#japanese")).includes("聞いて打つ"));
      sawListen = "checked";
    }
    if (shown === "adapt" || shown === "adopt") {
      const fam = await page2.textContent("#wordFamily");
      sawConfusable = fam.includes("似た綴り") && fam.includes(shown === "adapt" ? "adopt" : "adapt");
    }
    for (const ch of shown) await page2.press("#input", ch);
    await page2.waitForTimeout(350);
  }
  check("音で出題が混ざる（50%設定）", !!sawListen);
  check("紛らわしい語に「似た綴り」（adapt ↔ adopt）", sawConfusable);
  check("音で出題／似た綴りでエラー0", page2.errors.length === 0, page2.errors[0] ?? "");
  await page2.close();

  const page3 = await newPage();
  await page3.goto(BASE + "/profile.html", { waitUntil: "networkidle" });
  await page3.waitForTimeout(500);
  await page3.selectOption("#listenSelect", "25");
  check("音で出題の設定が保存される", (await page3.evaluate(() => JSON.parse(localStorage.getItem("spelldash_audio") || "{}").listenRatio)) === 25);
  await page3.close();
}

// ===== 9.9995 Batch 7a: テキストから場面カードを作る（AI生成のUIフロー） =====
console.log("card generation:");
{
  const page = await newPage({ storage: { spelldash_my_words: JSON.stringify([{ kind: "concept", en: "cpc", answer: "CPC", q: "1クリックの費用", explain: "", accept: [], ja: "" }]) } });
  await page.goto(BASE + "/list.html#myWords", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.click('[data-my-tab="ai"]');
  check("「テキストから作る」タブでパネルが出る", !(await page.$eval("#myCardGen", (el) => el.hidden)) && (await page.$eval("#myWordForm", (el) => el.hidden)));
  check("短いテキストではボタンが無効", await page.$eval("#cardGenRun", (el) => el.disabled));
  await page.fill("#cardGenText", "リスティング広告は検索結果に連動して表示される広告で、クリックごとに費用（CPC）が発生する。");
  check("文字数カウンタが出る", /\d+ \/ 4000文字/.test(await page.textContent("#cardGenCount")));
  await page.click("#cardGenRun");
  await waitUntil(async () => (await page.$$("[data-cardgen-pick]")).length === 2);
  const picks = await page.$$("[data-cardgen-pick]");
  check("候補が2枚プレビューされる", picks.length === 2);
  check("すでにある語（CPC）はチェックが外れて「すでにある」", (await page.$$eval("[data-cardgen-pick]", (els) => els.map((e) => e.checked))).join() === "true,false" && (await page.textContent("#cardGenPreview")).includes("すでにマイ単語帳にある"));
  const previewText = await page.$$eval("#cardGenPreview [data-field]", (els) => els.map((e) => e.value).join(" | "));
  check("候補に場面・答え・別解が編集可能な欄で出る", ["リスティング広告", "検索連動型広告", "クリックごとに費用"].every((s) => previewText.includes(s)), previewText.slice(0, 120));
  // 追加前に文面を直せる（G8）
  await page.fill('#cardGenPreview .cardgen__card:first-child [data-field="explain"]', "検索キーワードに連動する運用型広告（編集済み）");
  await page.click("[data-cardgen-add]");
  await page.waitForTimeout(200);
  const myWords = await page.evaluate(() => JSON.parse(localStorage.getItem("spelldash_my_words") || "[]"));
  check("選んだ1枚だけ、編集後の文面でマイ単語帳に追加される", myWords.length === 2 && myWords.some((w) => w.answer === "リスティング広告" && w.accept.includes("検索連動型広告") && w.explain.includes("編集済み")), JSON.stringify(myWords).slice(0, 160));
  check("追加後に「練習する」導線とステータス", (await page.textContent("#cardGenPreview")).includes("練習する") && (await page.textContent("#cardGenStatus")).includes("1枚"));
  check("一覧にも反映", (await page.textContent("#myWordList")).includes("リスティング広告"));
  // 未ログイン（401）はやさしい文言
  await page.fill("#cardGenText", "401 のケース: このテキストはログインしていない扱いになります。");
  await page.click("#cardGenRun");
  await waitUntil(async () => (await page.textContent("#cardGenStatus")).includes("ログイン"));
  // 401 の文は API の body.message（api/_lib/shared.js「ログインすると使える（無料）」をスタブも返す）が優先、無ければ cardGen.js の既定「ログインすると使える（無料）」。どちらも含む語幹で見る
  check("未ログイン時は「ログインすると使え…」の案内", (await page.textContent("#cardGenStatus")).includes("ログインすると使え"), await page.textContent("#cardGenStatus"));
  // 0件
  await page.fill("#cardGenText", "empty のケース: 用語が見つからないテキストとして扱われます。");
  await page.click("#cardGenRun");
  await waitUntil(async () => (await page.textContent("#cardGenStatus")).includes("見つかりません"));
  check("0件のときは案内が出る", (await page.textContent("#cardGenStatus")).includes("見つからなかった"));
  check("カード生成フローでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();

  // 覚え方を作る: ログイン中に答え表示でボタン → 生成 → 保存され、単語詳細にも出る（未ログインではボタンを出さない）
  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  const pageOut = await newPage({ storage: { spelldash_placement: "done", spelldash_streak: JSON.stringify({ current: 1, best: 1, last: today }) } });
  await pageOut.goto(BASE + "/index.html?set=5", { waitUntil: "networkidle" });
  await pageOut.waitForTimeout(900);
  await pageOut.press("#input", "Enter");
  await pageOut.waitForTimeout(250);
  await pageOut.press("#input", "Enter"); // 答え表示
  await pageOut.waitForTimeout(300);
  check("未ログインでは覚え方ボタンを出さない", (await pageOut.$$("[data-word-ai-run]")).length === 0);
  await pageOut.close();
  const page2 = await newPage({ storage: { spelldash_placement: "done", spelldash_test_session: "1", spelldash_streak: JSON.stringify({ current: 1, best: 1, last: today }) } });
  await page2.goto(BASE + "/index.html?set=5", { waitUntil: "networkidle" });
  await page2.waitForTimeout(900);
  await page2.press("#input", "Enter");
  await page2.waitForTimeout(250);
  check("答え表示前は覚え方ボタンが無い", (await page2.$$("[data-word-ai-run]")).length === 0);
  await page2.press("#input", "Enter"); // 答え表示
  await page2.waitForTimeout(200);
  const shownWord = (await page2.textContent("#word")).trim();
  check("ログイン中は答え表示で「覚え方を作る」が出る", (await page2.$$("[data-word-ai-run]")).length === 1);
  await page2.click("[data-word-ai-run]");
  await waitUntil(async () => (await page2.textContent("#wordAi")).includes("音で覚える"));
  const aiText = await page2.textContent("#wordAi");
  check("覚え方・例文・注意点が表示される", aiText.includes("音で覚える") && aiText.includes("Example with") && aiText.includes("似た綴り"), aiText.slice(0, 120));
  const aiStore = await page2.evaluate(() => JSON.parse(localStorage.getItem("spelldash_word_ai") || "{}"));
  const aiKeys = Object.keys(aiStore);
  check("覚え方が端末に保存される", aiKeys.length === 1 && aiStore[aiKeys[0]].mnemonic.includes(shownWord), JSON.stringify(aiStore).slice(0, 120));
  check("生成後も入力欄にフォーカスが戻る", await page2.evaluate(() => document.activeElement?.id === "input"));
  check("覚え方AIでエラー0", page2.errors.length === 0, page2.errors[0] ?? "");
  const aiRaw = await page2.evaluate(() => localStorage.getItem("spelldash_word_ai"));
  await page2.close();

  // 単語詳細: 保存済みの覚え方はボタンではなく本文が出る
  const page3 = await newPage({ storage: { spelldash_word_ai: aiRaw, spelldash_packs: JSON.stringify(["jhs-english1"]), spelldash_category: "jhs-english1" } }); // 既定コースの語なのでパックを読み込む
  await page3.goto(BASE + "/stats.html#words", { waitUntil: "networkidle" });
  await page3.waitForTimeout(900);
  await page3.evaluate((id) => {
    const el = document.createElement("button");
    el.dataset.wordDetail = id;
    el.id = "aiDetailProbe";
    document.body.appendChild(el);
  }, aiKeys[0]);
  await page3.click("#aiDetailProbe");
  await page3.waitForTimeout(200);
  check("単語詳細に保存済みの覚え方が出る", (await page3.textContent("#wordDetailAi")).includes("音で覚える") && (await page3.$$("#wordDetailAi [data-word-ai-run]")).length === 0);
  await page3.close();
}

// ===== 9.9996 Batch 8: 分野パック（教材ライブラリ）: 追加→一覧→ホームのチップ→外す =====
console.log("domain packs:");
{
  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  const page = await newPage();
  await page.goto(BASE + "/list.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const packCount = (await page.$$(".pack")).length;
  // 期待値は manifest から取る（パックを足すたびに数字を書き換えると、書き換え漏れで落ちるため）。
  // 「全部描画されているか」を見るのが目的。合計が激減していないことだけ別に見る。
  const manifestPacks = await page.evaluate(async () => {
    const m = await (await fetch("/data/manifest.json")).json();
    return m.subjects.find((s) => s.id === "english").categories.filter((c) => c.pack).length;
  });
  check("教材ライブラリに manifest のパックが全部出る", packCount === manifestPacks, `画面=${packCount} manifest=${manifestPacks}`);
  check("教材ライブラリのパック数が減っていない（140以上）", manifestPacks >= 140, `manifest=${manifestPacks}`);
  const options = await page.$$eval("#listCategory option", (els) => els.map((e) => e.value));
  check("追加前はカテゴリ選択にパックが無い", !options.includes("realestate"), options.join(","));
  check("ライブラリはグループ見出しつき（5グループ以上）", (await page.$$(".pack-group")).length >= 5);
  await page.fill("#packsSearch", "介護");
  await page.waitForTimeout(100);
  check("検索中はグループが開く", (await page.$$("details.pack-group:not([open])")).length === 0);
  check("分野の検索で絞れる", (await page.$$(".pack")).length >= 1 && (await page.$$(".pack")).length < 5 && (await page.textContent("#packsGrid")).includes("介護"));
  await page.fill("#packsSearch", "");
  await page.waitForTimeout(150);
  check("分野のグループは畳んである（140超の分野が一度に並ばない）", (await page.$$("details.pack-group:not([open])")).length >= 5, `open=${(await page.$$("details.pack-group[open]")).length}`);
  // 見出しを押してグループを開いてから追加する（開いた状態は描き直しても残る）
  await page.click('details.pack-group:has([data-pack-toggle="realestate"]) > summary');
  await waitUntil(async () => await page.isVisible('[data-pack-toggle="realestate"]'));
  check("開いたグループは描き直しても開いたまま", await page.isVisible('[data-pack-toggle="realestate"]'));
  await page.click('[data-pack-toggle="realestate"]');
  await waitUntil(async () => (await page.textContent("#listSummary")).includes("不動産"));
  const summary = await page.textContent("#listSummary");
  const cards = (await page.$$(".gcard")).length;
  check("追加すると不動産の一覧がすぐ出る（40枚以上・ジャンル4以上）", summary.includes("不動産") && cards >= 40 && (await page.$$(".genre")).length >= 4, `${summary} cards=${cards}`);
  check("ジャンル名がパック内の表示名になる（re-…のままではない）", !(await page.$$eval("#listGenres .genre-chip", (els) => els.map((e) => e.textContent))).some((t) => /^re-/.test(t)));
  check("パックが「追加済み」表示になり、端末に保存", (await page.textContent('[data-pack-toggle="realestate"]')).includes("追加済み") && (await page.evaluate(() => JSON.parse(localStorage.getItem("spelldash_packs") || "[]"))).includes("realestate"));
  check("ホームのカテゴリが不動産に切り替わる", (await page.evaluate(() => localStorage.getItem("spelldash_category"))) === "realestate");
  check("パックの一覧に「気になる点を送る」導線", !(await page.$eval("#listReview", (el) => el.hidden)));
  await page.click("[data-pack-review]");
  await page.waitForTimeout(150);
  check("送る→ご意見フォームが分野名入りで開く", !(await page.$eval("#feedbackModal", (el) => el.hidden)) && (await page.inputValue("#feedbackMessage")).includes("不動産 実務"));
  await page.keyboard.press("Escape");
  check("分野パックでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  const packsRaw = await page.evaluate(() => localStorage.getItem("spelldash_packs"));
  await page.close();

  // ホーム: 追加したパックだけチップに出る。「＋ 分野を追加」の導線
  const page2 = await newPage({ storage: { spelldash_packs: packsRaw, spelldash_category: "realestate", spelldash_placement: "done" } });
  await page2.goto(BASE + "/index.html?set=5", { waitUntil: "networkidle" });
  await page2.waitForTimeout(900);
  await page2.click("#setupToggle");
  await page2.waitForTimeout(150);
  const chips = await page2.textContent("#categoryPicker");
  check("ホームのチップに「不動産 実務」、未追加の「簿記・会計」は無い", chips.includes("不動産 実務") && !chips.includes("簿記・会計"));
  check("「＋ 分野を追加」がライブラリへ", (await page2.getAttribute("#packsLink", "href")).includes("list.html#packs"));
  await page2.press("#input", "Enter");
  await page2.waitForTimeout(300);
  const prompt = (await page2.textContent("#japanese")).trim();
  check("不動産の場面カードが出題される", prompt.length > 20, `prompt=${prompt.slice(0, 40)}`);
  check("ホーム（パック）でエラー0", page2.errors.length === 0, page2.errors[0] ?? "");
  await page2.close();

  // 外す: カテゴリ選択から消え、ホームの保存カテゴリは「すべて」へ
  const page3 = await newPage({ storage: { spelldash_packs: packsRaw, spelldash_category: "realestate" } });
  await page3.goto(BASE + "/list.html?category=realestate", { waitUntil: "networkidle" });
  await page3.waitForTimeout(900);
  check("カテゴリ表示中は分野パックの棚が畳まれている", !(await page3.$eval("#packsFold", (el) => el.open)));
  await page3.click("#packsFold > summary"); // 棚を開いてから外す
  await page3.click('[data-pack-toggle="realestate"]');
  await waitUntil(async () => !(await page3.$$eval("#listCategory option", (els) => els.map((e) => e.value))).includes("realestate"));
  check("外すとカテゴリ選択から消える", !(await page3.$$eval("#listCategory option", (els) => els.map((e) => e.value))).includes("realestate"));
  check("外すとホームの保存カテゴリは「すべて」", (await page3.evaluate(() => localStorage.getItem("spelldash_category"))) === "all");
  await page3.close();

  // 同じ id の語が複数パックにあり、訳が違う場合（compile: IT=コンパイルする / TOEIC=まとめる）、
  // 一覧から開いた単語詳細はそのパックの版を出す
  {
    const pageDup = await newPage({ storage: { spelldash_packs: JSON.stringify(["tsl07"]), spelldash_category: "tsl07" } });
    await pageDup.goto(BASE + "/list.html?category=tsl07", { waitUntil: "networkidle" });
    await pageDup.waitForTimeout(900);
    await pageDup.fill("#listSearch", "compile");
    await pageDup.waitForTimeout(400);
    await pageDup.click('[data-word-detail="english-compile"]');
    await pageDup.waitForTimeout(300);
    const detail = await pageDup.textContent("#wordDetailPanel");
    check("単語詳細は開いたパックの版の訳を出す（同じ語が別パックにもあるとき）", detail.includes("まとめる") && !detail.includes("コンパイル"), detail.slice(0, 120));
    check("重複 id の単語詳細でエラー0", pageDup.errors.length === 0, pageDup.errors[0] ?? "");
    await pageDup.close();
  }

  // レベル別パック（英検・TOEIC）: 英単語形式。追加すると出題され、「すべて」や Daily には混ざらない
  const page5 = await newPage({ storage: { spelldash_packs: JSON.stringify(["eiken2"]), spelldash_category: "eiken2", spelldash_placement: "done", spelldash_level_boost: "2" } });
  await page5.goto(BASE + "/list.html?category=eiken2", { waitUntil: "networkidle" });
  await page5.waitForTimeout(900);
  const lvSummary = await page5.textContent("#listSummary");
  check("英検2級の一覧（110語以上・品詞タグつき）", lvSummary.includes("英検2級") && (await page5.$$(".gcard")).length >= 110 && (await page5.$$(".gcard__pos")).length >= 110, lvSummary);
  check("ライブラリに「試験・レベル別」グループ（12パック）", (await page5.$$eval(".pack-group", (els) => els.map((e) => e.textContent))).some((t) => t.includes("試験・レベル別")) && (await page5.$$('[data-pack-toggle^="eiken"], [data-pack-toggle^="toeic"]')).length === 12);
  const dailyPool = await page5.evaluate(async () => {
    const m = await import("/js/dailyChallenge.js");
    const s = await import("/js/wordStore.js");
    const all = s.getWordsByCategory("all");
    return { dailyHasPack: m.getDailyWords().some((w) => w.pack), allHasPack: all.some((w) => w.pack), eiken: s.getWordsByCategory("eiken2").length };
  });
  check("レベル別の語は「すべて」と Daily に混ざらない", !dailyPool.dailyHasPack && !dailyPool.allHasPack && dailyPool.eiken >= 110, JSON.stringify(dailyPool));
  await page5.close();
  const page6 = await newPage({ storage: { spelldash_packs: JSON.stringify(["eiken2"]), spelldash_category: "eiken2", spelldash_placement: "done", spelldash_level_boost: "2" } });
  await page6.goto(BASE + "/index.html?set=5", { waitUntil: "networkidle" });
  await page6.waitForTimeout(900);
  await page6.press("#input", "Enter");
  await page6.waitForTimeout(300);
  check("英検2級の語が出題され、ラベルに品詞", /日本語訳（[名動形副前接代助間]）/.test(await page6.textContent("#gameCard .label")), await page6.textContent("#gameCard .label"));
  check("レベル別パックの出題でエラー0", page6.errors.length === 0, page6.errors[0] ?? "");
  await page6.close();

  // 例文: 英単語カードは答え表示と正解時に例文（見出し語は太字）と訳が出る。単語帳・単語詳細にも
  const bizWords = JSON.parse(fs.readFileSync(path.join(ROOT, "data/english/business.json"), "utf8")).words;
  const page6b = await newPage({ storage: { spelldash_category: "business", spelldash_placement: "done", spelldash_level_boost: "2", spelldash_streak: JSON.stringify({ current: 1, best: 1, last: today }) } });
  await page6b.goto(BASE + "/index.html?set=5", { waitUntil: "networkidle" });
  await page6b.waitForTimeout(900);
  await page6b.press("#input", "Enter"); // 開始
  await page6b.waitForTimeout(300);
  await page6b.press("#input", "Enter"); // 答え表示
  await page6b.waitForTimeout(250);
  const exAnswer = (await page6b.textContent("#word")).trim();
  const exWord = bizWords.find((w) => w.en === exAnswer);
  const exText = (await page6b.textContent("#wordExample")).trim();
  check("例文: 答え表示で例文と訳が出る", !!exWord && exText.includes(exWord.ex) && exText.includes(exWord.exJa), `${exAnswer}: ${exText.slice(0, 60)}`);
  check("例文: 見出し語が太字", (await page6b.$eval("#wordExample", (el) => el.querySelector("b")?.textContent.toLowerCase() ?? "")) === (exWord?.exForm ?? exWord?.en ?? "").toLowerCase());
  for (const ch of exAnswer) await page6b.press("#input", ch); // 答えを見た語は従来どおり即次へ
  await page6b.waitForTimeout(400);
  check("例文: 答えを見た語は正解後すぐ次へ", (await page6b.textContent("#japanese")).trim() !== exWord.ja && !(await page6b.textContent("#wordExample")).includes(exWord.ex));
  // 自力で思い出した語: 正解後に例文が出て、読む時間が置かれる（Enter で即進行）
  let selfWord = null;
  for (let i = 0; i < 6 && !selfWord; i++) {
    const ja = (await page6b.textContent("#japanese")).trim();
    const cands = bizWords.filter((w) => w.ja === ja || w.ja.split("・").includes(ja));
    if (cands.length === 1) {
      selfWord = cands[0];
      break;
    }
    await page6b.press("#input", "Enter"); // 答え表示
    await page6b.waitForTimeout(150);
    for (const ch of (await page6b.textContent("#word")).trim()) await page6b.press("#input", ch);
    await page6b.waitForTimeout(400);
  }
  if (selfWord) {
    for (const ch of selfWord.en) await page6b.press("#input", ch);
    await page6b.waitForTimeout(500);
    check("例文: 自力正解のあとに例文が出て、読む時間が置かれる", (await page6b.textContent("#wordExample")).includes(selfWord.ex) && (await page6b.textContent("#japanese")).trim() !== "" , `${selfWord.en}: ${(await page6b.textContent("#wordExample")).slice(0, 50)}`);
  } else {
    check("例文: 自力正解のあとに例文が出て、読む時間が置かれる（一意な語が見つからずスキップ）", true);
  }
  await page6b.close();
  const page6c = await newPage();
  await page6c.goto(BASE + "/list.html?category=business", { waitUntil: "networkidle" });
  await page6c.waitForTimeout(900);
  check("例文: 単語帳のカードに例文", (await page6c.$$(".gcard__ex")).length >= 100 && (await page6c.textContent("#listBody")).includes(bizWords[0].ex));
  await page6c.click(`[data-word-detail="${bizWords[0].id}"]`);
  await page6c.waitForTimeout(300);
  check("例文: 単語詳細に例文と読み上げボタン", (await page6c.textContent(".word-detail__ex")).includes(bizWords[0].ex) && (await page6c.$(".word-detail__ex [data-example-speak]")) !== null);
  await page6c.close();

  // 文法パック（穴埋め）: 空欄つきの英文が出て、空欄の語を英語で打つ。発音は完成文
  const page7 = await newPage({ storage: { spelldash_packs: JSON.stringify(["grammar-jhs1"]), spelldash_category: "grammar-jhs1", spelldash_placement: "done", spelldash_level_boost: "2", spelldash_streak: JSON.stringify({ current: 1, best: 1, last: today }) } });
  await page7.goto(BASE + "/index.html?set=5", { waitUntil: "networkidle" });
  await page7.waitForTimeout(900);
  await page7.press("#input", "Enter");
  await page7.waitForTimeout(300);
  const gLabel = await page7.textContent("#gameCard .label");
  const gPrompt = (await page7.textContent("#japanese")).trim();
  check("文法カード: ラベルが「空欄に入る英語を打つ（文法項目）」", gLabel.startsWith("空欄に入る英語を打つ（"), gLabel);
  check("文法カード: 英文に空欄と日本語訳", gPrompt.includes("____") && /（.+）/.test(gPrompt), gPrompt.slice(0, 60));
  await page7.press("#input", "Enter"); // 答え表示
  await page7.waitForTimeout(200);
  const gAnswer = (await page7.textContent("#word")).trim();
  check("文法カード: 答え表示で空欄の語と解説", gAnswer.length > 0 && (await page7.textContent("#wordExplain")).trim().length > 0, `answer=${gAnswer}`);
  if (/^[a-z]+$/.test(gAnswer)) {
    for (const ch of gAnswer) await page7.press("#input", ch);
  } else {
    await page7.fill("#input", gAnswer);
    await page7.press("#input", "Enter");
  }
  await waitUntil(async () => (await page7.textContent("#score")).trim() === "1", 2000);
  check("文法カード: 空欄の語を打って正解になる", (await page7.textContent("#score")).trim() === "1", `answer=${gAnswer}`);
  check("文法カードでエラー0", page7.errors.length === 0, page7.errors[0] ?? "");
  await page7.close();
  const page8 = await newPage({ storage: { spelldash_packs: JSON.stringify(["grammar-jhs1"]) } });
  await page8.goto(BASE + "/list.html?category=grammar-jhs1", { waitUntil: "networkidle" });
  await page8.waitForTimeout(900);
  check("文法パックの一覧（60枚以上・文法項目のジャンル）", (await page8.$$(".gcard")).length >= 60 && (await page8.$$(".genre")).length >= 5 && (await page8.textContent("#listBody")).includes("____"));
  check("ライブラリに「文法」グループ（6パック）", (await page8.$$('[data-pack-toggle^="grammar-"]')).length === 6);
  await page8.close();

  // 義務教育パック: 日本語で答える。漢字の答えはひらがなの読みでも正解
  const page9 = await newPage({ storage: { spelldash_packs: JSON.stringify(["pref"]), spelldash_category: "pref", spelldash_placement: "done", spelldash_level_boost: "2", spelldash_streak: JSON.stringify({ current: 1, best: 1, last: today }) } });
  await page9.goto(BASE + "/index.html?set=5", { waitUntil: "networkidle" });
  await page9.waitForTimeout(900);
  await page9.press("#input", "Enter");
  await page9.waitForTimeout(300);
  check("義務教育カード: ラベルが「説明に合う語を答える」", (await page9.textContent("#gameCard .label")).includes("説明に合う語を答える"));
  const kana = await page9.evaluate(async () => {
    const s = await import("/js/wordStore.js");
    const w = s.getWordsByCategory("pref").find((x) => /[一-龯]/.test(x.answer));
    return { reading: (w.accept ?? []).find((a) => /^[ぁ-ゖー]+$/.test(a)) ?? "", q: w.q, id: w.id };
  });
  check("義務教育カード: 漢字の答えに読みの別解がある", kana.reading.length > 0, JSON.stringify(kana).slice(0, 100));
  await page9.close();
  // kanjiOnly: 問題文に読みが書いてあるカード（同音異義語・漢文の句法）は漢字で答えさせる。読みは別解に入れない
  const page9b = await newPage({ storage: { spelldash_packs: JSON.stringify(["jkokugo2"]) } });
  await page9b.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await page9b.waitForTimeout(600);
  const kanjiOnly = await page9b.evaluate(async () => {
    const s = await import("/js/wordStore.js");
    const ws = s.getWordsByCategory("jkokugo2").filter((x) => x.kanjiOnly);
    return { n: ws.length, leak: ws.filter((w) => (w.accept ?? []).some((a) => /^[ぁ-ゖー]+$/.test(a))).length };
  });
  check("kanjiOnly カード: 同音異義語10枚に読みの別解がない", kanjiOnly.n === 10 && kanjiOnly.leak === 0, JSON.stringify(kanjiOnly));
  await page9b.close();

  // 英作文パック: 日本語文を見て英文を丸ごと打つ。語順が違うと何語目かを指摘。並べ替えは語をシャッフルして見せる
  const page9c = await newPage({ storage: { spelldash_packs: JSON.stringify(["writing-jhs"]), spelldash_category: "writing-jhs", spelldash_placement: "done", spelldash_level_boost: "2", spelldash_streak: JSON.stringify({ current: 1, best: 1, last: today }) } });
  await page9c.goto(BASE + "/index.html?set=5", { waitUntil: "networkidle" });
  await page9c.waitForTimeout(900);
  await page9c.press("#input", "Enter");
  await page9c.waitForTimeout(300);
  const wLabel = await page9c.textContent("#gameCard .label");
  check("英作文カード: ラベルが「日本語を英文にして打つ（項目）」", wLabel.startsWith("日本語を英文にして打つ（"), wLabel);
  check("英作文カード: 入力欄は英文入力", (await page9c.getAttribute("#input", "placeholder")) === "英文を入力してEnter");
  const wPrompt = (await page9c.textContent("#japanese")).trim();
  await page9c.press("#input", "Enter"); // 答え表示
  await page9c.waitForTimeout(200);
  const wAnswer = (await page9c.textContent("#word")).trim();
  check("英作文カード: 日本語文が出て、答えは英文", /[ぁ-ん一-龯]/.test(wPrompt) && /^[A-Za-z].+\s.+/.test(wAnswer), `q=${wPrompt.slice(0, 30)} a=${wAnswer}`);
  await page9c.fill("#input", wAnswer.toLowerCase().replace(/[.?!]/g, ""));
  await page9c.press("#input", "Enter");
  await waitUntil(async () => (await page9c.textContent("#score")).trim() === "1", 2000);
  check("英作文カード: 大文字・句読点なしでも英文が合えば正解", (await page9c.textContent("#score")).trim() === "1");
  await page9c.press("#input", "Enter"); // 次へ
  await page9c.waitForTimeout(400);
  const wAnswer2 = await page9c.evaluate(async () => {
    const s = await import("/js/wordStore.js");
    const q = document.querySelector("#japanese").textContent.trim();
    return s.getWordsByCategory("writing-jhs").find((w) => w.q === q)?.en ?? "";
  });
  const scrambled = wAnswer2.replace(/[.?!]/g, "").split(" ").reverse().join(" ");
  await page9c.fill("#input", scrambled);
  await page9c.press("#input", "Enter");
  await page9c.waitForTimeout(300);
  check("英作文カード: 語順が違うと何語目が違うかを指摘", (await page9c.textContent("#message")).includes("語目"), (await page9c.textContent("#message")).slice(0, 60));
  check("英作文カードでエラー0", page9c.errors.length === 0, page9c.errors[0] ?? "");
  await page9c.close();
  const page9d = await newPage({ storage: { spelldash_packs: JSON.stringify(["writing-jhs-order"]), spelldash_category: "writing-jhs-order", spelldash_placement: "done", spelldash_level_boost: "2", spelldash_streak: JSON.stringify({ current: 1, best: 1, last: today }) } });
  await page9d.goto(BASE + "/index.html?set=5", { waitUntil: "networkidle" });
  await page9d.waitForTimeout(900);
  await page9d.press("#input", "Enter");
  await page9d.waitForTimeout(300);
  check("並べ替えカード: ラベルと語バンク（並べ替え:）", (await page9d.textContent("#gameCard .label")).startsWith("語を並べ替えて英文を打つ") && (await page9d.textContent("#word")).includes("並べ替え"), await page9d.textContent("#word"));
  await page9d.close();

  // 専用キーボード（A〜Z＋⌫）: タッチ端末ではプレイ中に画面下へ出て、OS キーボードは出さない（inputmode=none）
  const jhs1k = JSON.parse(fs.readFileSync(path.join(ROOT, "data/packs/jhs-english1.json"), "utf8")).words;
  const pageK = await newPage({ mobile: true, viewport: { width: 390, height: 844 }, storage: { spelldash_course: "jhs-redo", spelldash_packs: JSON.stringify(["jhs-english1"]), spelldash_category: "jhs-english1", spelldash_placement: "done", spelldash_word_stats: JSON.stringify({ "english-go": { playCount: 1 } }) } });
  await pageK.goto(BASE + "/index.html?set=3", { waitUntil: "networkidle" });
  await pageK.waitForTimeout(900);
  check("画面キーボード: プレイ前は出ない", !(await pageK.isVisible("#osk")));
  await pageK.tap("#pathStart");
  await pageK.waitForTimeout(700);
  check("画面キーボード: スマホでプレイ中に出て、OS キーボードは抑止", (await pageK.isVisible("#osk")) && (await pageK.getAttribute("#input", "inputmode")) === "none" && (await pageK.$$("#osk [data-key]")).length === 26);
  const jaK = (await pageK.textContent("#japanese")).trim();
  const wordK = jhs1k.find((w) => w.ja === jaK || w.ja.split("・").includes(jaK));
  for (const ch of wordK.en) await pageK.tap(`#osk [data-key="${ch}"]`);
  await waitUntil(async () => (await pageK.textContent("#score")).trim() === "1", 2000);
  check("画面キーボード: キーをタップして正解になる", (await pageK.textContent("#score")).trim() === "1", `word=${wordK.en}`);
  await pageK.waitForTimeout(2600); // 自力正解のあとは例文を読む間（2.2秒）がある
  await pageK.tap('#osk [data-action="enter"]');
  await pageK.waitForTimeout(300);
  check("画面キーボード: Enter キーで答え表示", /^[a-z]+$/.test((await pageK.textContent("#word")).trim()));
  check("画面キーボードでエラー0", pageK.errors.length === 0, pageK.errors[0] ?? "");
  await pageK.close();
  const pageD = await newPage({ storage: { spelldash_course: "jhs-redo", spelldash_packs: JSON.stringify(["jhs-english1"]), spelldash_category: "jhs-english1", spelldash_placement: "done" } });
  await pageD.goto(BASE + "/index.html?set=3", { waitUntil: "networkidle" });
  await pageD.waitForTimeout(700);
  await pageD.click("#pathStart");
  await pageD.waitForTimeout(500);
  check("画面キーボード: PC（自動）では出ない", !(await pageD.isVisible("#osk")) && (await pageD.getAttribute("#input", "inputmode")) === null);
  await pageD.close();
  const pageO = await newPage({ storage: { spelldash_osk: "on", spelldash_course: "jhs-redo", spelldash_packs: JSON.stringify(["jhs-english1"]), spelldash_category: "jhs-english1", spelldash_placement: "done" } });
  await pageO.goto(BASE + "/index.html?set=3", { waitUntil: "networkidle" });
  await pageO.waitForTimeout(700);
  await pageO.click("#pathStart");
  await pageO.waitForTimeout(500);
  check("画面キーボード: 設定「常にオン」なら PC でも出る", await pageO.isVisible("#osk"));
  await pageO.close();

  // 道: 済みユニットは✓、現在地にスタート、セクション制覇で「次のセクションへ」→ 次のパックが追加されて道が切り替わる
  const jhs1 = JSON.parse(fs.readFileSync(path.join(ROOT, "data/packs/jhs-english1.json"), "utf8")).words;
  const allKnown = Object.fromEntries(jhs1.map((w) => [w.id, { playCount: 1, knownOnSight: true, recallFail: 0 }]));
  const page9e = await newPage({ storage: { spelldash_course: "jhs-redo", spelldash_packs: JSON.stringify(["jhs-english1"]), spelldash_category: "jhs-english1", spelldash_word_stats: JSON.stringify(allKnown), spelldash_placement: "done" } });
  await page9e.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await page9e.waitForTimeout(900);
  check("道: 全ユニット済みで「次のセクションへ」", (await page9e.$("#pathNext")) !== null && (await page9e.textContent("#pathHead")).includes("ユニット済み") && (await page9e.$$(".path__node--done")).length === 3);
  // 全ユニット済みでも済みは「済み 9ユニット」＋直前の 2 つに畳まれ、goal は畳みと済み 2 つの直後（最初の画面内）
  const nextNode = await page9e.evaluate(() => {
    const fold = document.querySelector(".path__node--fold");
    const next = document.getElementById("pathNext");
    const doneOpen = [...document.querySelectorAll(".path__node--done:not(.path__node--fold)")];
    return { fold: fold?.textContent ?? "", nextTop: next?.getBoundingClientRect().top ?? -1, foldTop: fold?.getBoundingClientRect().top ?? -1, lastDoneTop: doneOpen.at(-1)?.getBoundingClientRect().top ?? -1, open: doneOpen.length, inner: window.innerHeight, label: next?.closest(".path__node")?.textContent ?? "" };
  });
  check("道: 全ユニット済みの済みは「済み 9ユニット」＋2 つに畳まれ、「次のセクションへ」は最初の画面内", nextNode.fold.includes("済み 9ユニット") && nextNode.open === 2 && nextNode.foldTop < nextNode.lastDoneTop && nextNode.lastDoneTop < nextNode.nextTop && nextNode.nextTop < nextNode.inner, JSON.stringify(nextNode));
  check("道: 全ユニット済みの goal は「次は「中学英語 2年」」だけ（「このセクション 全ユニット済み」は言わない）", nextNode.label.includes("次は「中学英語 2年") && !nextNode.label.includes("全ユニット済み"), nextNode.label);
  await page9e.click("#pathNext");
  await page9e.waitForTimeout(1200);
  const advanced = await page9e.evaluate(() => ({ cat: localStorage.getItem("spelldash_category"), packs: JSON.parse(localStorage.getItem("spelldash_packs") || "[]") }));
  check("道: 次のセクション（中学英語2年）が追加されてカテゴリになる", advanced.cat === "jhs-english2" && advanced.packs.includes("jhs-english2"), JSON.stringify(advanced));
  check("道: 見出しがセクション2／8に", (await page9e.textContent("#pathHead")).includes("セクション 2／8") && (await page9e.$("#pathStart")) !== null);
  // 済みユニットのタップで復習が始まる（その道の語だけ）
  const page9f = await newPage({ storage: { spelldash_course: "jhs-redo", spelldash_packs: JSON.stringify(["jhs-english1"]), spelldash_category: "jhs-english1", spelldash_word_stats: JSON.stringify(Object.fromEntries(jhs1.filter((w) => w.tags[0] === jhs1[0].tags[0]).map((w) => [w.id, { playCount: 1, knownOnSight: true, recallFail: 0 }]))), spelldash_placement: "done" } });
  await page9f.goto(BASE + "/index.html?set=3", { waitUntil: "networkidle" });
  await page9f.waitForTimeout(900);
  check("道: 1ユニット済み・2つ目が現在地", (await page9f.$$(".path__node--done")).length === 1 && (await page9f.textContent("#pathHead")).includes("ユニット 2／11"));
  await page9f.click("#pathStart");
  await page9f.waitForTimeout(600);
  const focusTag = jhs1.find((w) => w.tags[0] !== jhs1[0].tags[0]).tags[0];
  const ja1 = (await page9f.textContent("#japanese")).trim();
  const inUnit = jhs1.some((w) => (w.ja === ja1 || w.ja.split("・").includes(ja1)) && w.tags[0] === focusTag); // 訳が「授業・クラス」なら片方だけ出ることがある
  check("道: スタートで現在ユニットの語から出題、ゲームカードが出る", inUnit && (await page9f.isVisible("#backToPath")) && !(await page9f.isVisible("#pathList .path__list")), `ja=${ja1}`);
  check("道のフローでエラー0", page9e.errors.length === 0 && page9f.errors.length === 0, page9e.errors[0] ?? page9f.errors[0] ?? "");
  await page9e.close();
  await page9f.close();
  const page10 = await newPage({ storage: { spelldash_packs: JSON.stringify(["pref"]) } });
  await page10.goto(BASE + "/list.html?category=pref", { waitUntil: "networkidle" });
  await page10.waitForTimeout(900);
  check("都道府県パックの一覧（60枚・地方ごとのジャンル）", (await page10.$$(".gcard")).length === 60 && (await page10.$$(".genre")).length >= 6);
  check("ライブラリに「中学校」グループ（11パック）", (await page10.$$eval(".pack-group__title", (els) => els.map((e) => e.textContent))).some((t) => t.includes("中学校")) && (await page10.$$('[data-pack-toggle="jhist1"], [data-pack-toggle="jsci2"], [data-pack-toggle="jmath"]')).length === 3);
  await page10.close();

  // 自分のデータの端末間同期: 変更が dirty に積まれ、クラウド行のマージで新しい方が勝つ（テーブルはスタブ）
  const page12 = await newPage({ storage: { spelldash_my_words: JSON.stringify([{ en: "invoice", ja: "請求書", addedAt: "2026-09-01T00:00:00.000Z" }]) } });
  await page12.goto(BASE + "/list.html#myWords", { waitUntil: "networkidle" });
  await page12.waitForTimeout(800);
  // 棚が閉じていれば開く（#myWords で来たときは既に開いていることがある）
  if (!(await page12.$eval("#packsFold", (el) => el.open))) await page12.click("#packsFold > summary");
  await page12.click('details.pack-group:has([data-pack-toggle="realestate"]) > summary');
  await waitUntil(async () => await page12.isVisible('[data-pack-toggle="realestate"]'));
  await page12.click('[data-pack-toggle="realestate"]');
  await waitUntil(async () => (await page12.textContent("#listSummary")).includes("不動産"));
  await page12.fill("#myWordEn", "deadline");
  await page12.fill("#myWordJa", "締め切り");
  await page12.click("#myWordForm button[type=submit]");
  await page12.waitForTimeout(200);
  const dirty = await page12.evaluate(() => JSON.parse(localStorage.getItem("spelldash_user_items_dirty") || "[]"));
  check("同期: パック追加と単語追加が未送信として記録される", dirty.includes("pack:realestate") && dirty.includes("my_word:deadline"), dirty.join(","));
  const merged = await page12.evaluate(async () => {
    const m = await import("/js/userItemsSync.js");
    const future = new Date(Date.now() + 60000).toISOString();
    const past = "2026-08-01T00:00:00.000Z";
    const r = m.mergeCloudItems([
      { kind: "my_word", key: "negotiate", payload: { en: "negotiate", ja: "交渉する", addedAt: future }, deleted: false, updated_at: future }, // クラウドだけ → 追加
      { kind: "my_word", key: "invoice", payload: {}, deleted: true, updated_at: future }, // 新しい墓標 → 削除
      { kind: "my_word", key: "deadline", payload: { en: "deadline", ja: "古い訳", addedAt: past }, deleted: false, updated_at: past }, // 古いクラウド → ローカルが勝つ
      { kind: "note", key: "english-negotiate", payload: { text: "nego＝交渉" }, deleted: false, updated_at: future },
      { kind: "pack", key: "accounting", payload: { enabled: true }, deleted: false, updated_at: future }
    ], "u1");
    const words = JSON.parse(localStorage.getItem("spelldash_my_words") || "[]").map((w) => `${w.en}=${w.ja}`);
    return { words, notes: JSON.parse(localStorage.getItem("spelldash_word_notes") || "{}"), packs: JSON.parse(localStorage.getItem("spelldash_packs") || "[]"), upload: r.toUpload.map((x) => `${x.kind}:${x.key}`), changed: r.changed };
  });
  check("同期: クラウドの新しい行を反映（追加・墓標で削除・古い行はローカル優先）", merged.words.includes("negotiate=交渉する") && !merged.words.some((w) => w.startsWith("invoice=")) && merged.words.includes("deadline=締め切り"), merged.words.join(","));
  check("同期: メモとパックも反映し、ローカルが新しい項目はアップロード対象", merged.notes["english-negotiate"] === "nego＝交渉" && merged.packs.includes("accounting") && merged.packs.includes("realestate") && merged.upload.includes("my_word:deadline") && merged.upload.includes("pack:realestate"), JSON.stringify(merged).slice(0, 200));
  check("同期でエラー0", page12.errors.length === 0, page12.errors[0] ?? "");
  await page12.close();

  // 入口ページ（静的HTML）: 内容のサンプルと「追加して始める」→ ?add=
  const page11 = await newPage();
  await page11.goto(BASE + "/packs/pref.html", { waitUntil: "networkidle" });
  await page11.waitForTimeout(300);
  check("入口ページ: タイトル・見出し・CTA が ?add= に向く", (await page11.title()).includes("都道府県") && (await page11.textContent("h1")).includes("都道府県") && (await page11.getAttribute(".pp-cta", "href")) === "/list.html?add=pref" && (await page11.$$(".pp-card")).length === 8);
  check("入口ページ: canonical が www.spelldash.net/packs/", (await page11.getAttribute('link[rel="canonical"]', "href")) === "https://www.spelldash.net/packs/pref.html");
  await page11.goto(BASE + "/packs/index.html", { waitUntil: "networkidle" });
  check("入口ページ一覧: 全パックへのリンク", (await page11.$$('a[href^="/packs/"][href$=".html"]')).length >= 65);
  check("入口ページでエラー0", page11.errors.length === 0, page11.errors[0] ?? "");
  await page11.close();

  // ?add= の紹介リンクで直接追加
  const page4 = await newPage();
  await page4.goto(BASE + "/list.html?add=accounting", { waitUntil: "networkidle" });
  await page4.waitForTimeout(900);
  check("?add=accounting で簿記・会計が追加されて表示", (await page4.textContent("#listSummary")).includes("簿記") && (await page4.evaluate(() => JSON.parse(localStorage.getItem("spelldash_packs") || "[]"))).includes("accounting"));
  await page4.close();
}

// ===== 10. 新カテゴリ「広告・マーケ」: チップ表示＋Lv1で出題 =====
console.log("ads category:");
{
  const page = await newPage({ storage: { spelldash_category: "ads", spelldash_mode: "challenge" } });
  await page.goto(BASE + "/index.html?t=3", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  check("カテゴリチップに「広告・マーケ」", (await page.textContent("body")).includes("広告・マーケ"));
  await page.press("#input", "Enter");
  await page.waitForTimeout(400);
  const ja = (await page.textContent("#japanese")).trim();
  check("広告・マーケ×Lv1で出題される", ja !== "Challenge Mode" && ja.length > 0, `ja=${ja}`);
  check("広告・マーケでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();
}

// ===== 11. レビュー修正: 正解直後のキー・道に戻る・解放・トップページ・認証メッセージ・道の表示 =====
console.log("review fixes:");
{
  const todayR = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  const bizR = JSON.parse(fs.readFileSync(path.join(ROOT, "data/english/business.json"), "utf8")).words;
  const jhs1R = JSON.parse(fs.readFileSync(path.join(ROOT, "data/packs/jhs-english1.json"), "utf8")).words;
  const findByJa = (list, ja) => list.filter((w) => w.ja === ja || w.ja.split("・").includes(ja));

  // 正解直後の待ち（例文を読む時間）に打ったキーは次の語のミスにしない
  const pageA = await newPage({ storage: { spelldash_category: "business", spelldash_placement: "done", spelldash_level_boost: "2", spelldash_streak: JSON.stringify({ count: 1, last: todayR }) } });
  await pageA.goto(BASE + "/index.html?set=5", { waitUntil: "networkidle" });
  await pageA.waitForTimeout(900);
  await pageA.press("#input", "Enter");
  await pageA.waitForTimeout(300);
  const jaA = (await pageA.textContent("#japanese")).trim();
  const candA = findByJa(bizR, jaA);
  let ansA;
  if (candA.length === 1) {
    ansA = candA[0].en;
  } else {
    await pageA.press("#input", "Enter"); // 答え表示
    await pageA.waitForTimeout(200);
    ansA = (await pageA.textContent("#word")).trim();
  }
  const failBefore = Number(await pageA.textContent("#recallFail"));
  for (const ch of ansA) await pageA.press("#input", ch);
  await pageA.press("#input", "z"); // 待ち中のキー
  await pageA.press("#input", "q");
  await pageA.waitForTimeout(150);
  check("正解直後の待ち中に打ったキーはミスにならない（思い出せず が増えない）", Number(await pageA.textContent("#recallFail")) === failBefore && (await pageA.textContent("#word")).trim() === ansA, `fail ${failBefore}→${await pageA.textContent("#recallFail")}`);
  await pageA.press("#input", "Enter"); // 待たずに次へ
  await pageA.waitForTimeout(200);
  check("待ち中の Enter で次の語へ", (await pageA.textContent("#japanese")).trim() !== jaA && (await pageA.evaluate(() => document.getElementById("input").value)) === "");
  check("正解直後のキーでエラー0", pageA.errors.length === 0, pageA.errors[0] ?? "");
  await pageA.close();

  // 「← 道に戻る」でプレイ中のセットは止まる／道が見えている間の Enter は道のスタート扱い
  const pageB = await newPage({ storage: { spelldash_course: "jhs-redo", spelldash_packs: JSON.stringify(["jhs-english1"]), spelldash_category: "jhs-english1", spelldash_placement: "done", spelldash_word_stats: JSON.stringify({ "english-go": { playCount: 1 } }) } });
  await pageB.goto(BASE + "/index.html?set=3", { waitUntil: "networkidle" });
  await pageB.waitForTimeout(900);
  await pageB.press("#input", "Enter"); // 道が見えている状態の Enter
  await pageB.waitForTimeout(500);
  const jaB = (await pageB.textContent("#japanese")).trim();
  const unitTagB = await pageB.evaluate(async () => (await import("/js/studyQueue.js")).getFocusGenre());
  check("道の Enter は現在ユニットのスタートと同じ（ユニットに絞られる）", !!unitTagB && findByJa(jhs1R, jaB).some((w) => (w.tags ?? []).includes(unitTagB)) && (await pageB.isVisible("#backToPath")), `tag=${unitTagB} ja=${jaB}`);
  await pageB.click("#backToPath");
  await pageB.waitForTimeout(300);
  const playingB = await pageB.evaluate(async () => (await import("/js/game.js")).isGamePlaying());
  check("道に戻るとセットは止まり、道が出る", !playingB && (await pageB.isVisible("#pathList .path__list")) && !(await pageB.isVisible("#backToPath")));
  check("道に戻るでエラー0", pageB.errors.length === 0, pageB.errors[0] ?? "");
  await pageB.close();

  // 解放: 新しい人は統計が30語を超えても、セット数（Daily 2・Battle 5）で解放
  const manyStats = Object.fromEntries(jhs1R.slice(0, 40).map((w) => [w.id, { playCount: 1 }]));
  const pageC = await newPage({ storage: { spelldash_veteran: "0", spelldash_sets_total: "1", spelldash_course: "jhs-redo", spelldash_packs: JSON.stringify(["jhs-english1"]), spelldash_category: "jhs-english1", spelldash_placement: "done", spelldash_word_stats: JSON.stringify(manyStats) } });
  await pageC.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await pageC.waitForTimeout(900);
  check("解放: 新しい人は統計が多くても Daily はセット数で解放（🔒 あと1セット）", (await pageC.$$(".play-modes__lock")).length >= 2 && (await pageC.textContent("#playModes, .play-modes")).includes("あと1セット"));
  await pageC.close();
  const pageC2 = await newPage({ storage: { spelldash_course: "jhs-redo", spelldash_packs: JSON.stringify(["jhs-english1"]), spelldash_category: "jhs-english1", spelldash_placement: "done", spelldash_word_stats: JSON.stringify(manyStats) } });
  await pageC2.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await pageC2.waitForTimeout(900);
  check("解放: 以前から使っている人（初回判定で30語以上）は全部開いていて、判定が保存される", (await pageC2.$$(".play-modes__lock")).length === 0 && (await pageC2.evaluate(() => localStorage.getItem("spelldash_veteran"))) === "1");
  await pageC2.close();

  // トップページ: 計測用パラメータでは出す（?set= などの深いリンクだけ抑止）。認証メッセージは hero の外
  const pageE = await newPage({ keepOnboarding: true });
  await pageE.goto(BASE + "/index.html?utm_source=x", { waitUntil: "networkidle" });
  await pageE.waitForTimeout(700);
  check("トップページ: 計測用のパラメータ付きでも初回は出る", await pageE.isVisible("#welcome"));
  check("認証メッセージは hero の外にある（戻ってきた人にも見える）", await pageE.evaluate(() => !document.getElementById("hero").contains(document.getElementById("authMessage"))));
  // ソフトキーボード相当: input イベントで値を照合しても1語体験が進む
  await pageE.click("#welcomeDemoInput");
  await pageE.evaluate(() => {
    const el = document.getElementById("welcomeDemoInput");
    el.value = "apple";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await pageE.waitForTimeout(100);
  check("トップの1語体験: input イベント（ソフトキーボード）でも思い出せた", (await pageE.textContent("#welcomeDemoMsg")).includes("思い出せた"));
  check("トップページでエラー0", pageE.errors.length === 0, pageE.errors[0] ?? "");
  await pageE.close();

  // 道: 「すべて」はカテゴリごとのユニットで、スタートはそのカテゴリに絞る。空のマイ単語帳には案内
  const pageF = await newPage({ storage: { spelldash_category: "all", spelldash_placement: "done", spelldash_level_boost: "2" } });
  await pageF.goto(BASE + "/index.html?set=3", { waitUntil: "networkidle" });
  await pageF.waitForTimeout(900);
  const unitF = await pageF.getAttribute("#pathStart", "data-unit");
  check("道（すべて）: ユニットは基本カテゴリで、スタートはカテゴリに絞る", (unitF ?? "").startsWith("category:") && (await pageF.$$(".path__node")).length >= 5 && !(await pageF.textContent("#pathList")).includes("マイ単語帳"), `unit=${unitF}`);
  await pageF.click("#pathStart");
  await pageF.waitForTimeout(500);
  const catF = unitF.slice("category:".length);
  const wordsF = JSON.parse(fs.readFileSync(path.join(ROOT, `data/english/${catF}.json`), "utf8")).words;
  check("道（すべて）: スタートでそのカテゴリの語が出る", findByJa(wordsF, (await pageF.textContent("#japanese")).trim()).length > 0, `cat=${catF} ja=${await pageF.textContent("#japanese")}`);
  await pageF.close();
  const pageG = await newPage({ storage: { spelldash_category: "my", spelldash_placement: "done" } });
  await pageG.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await pageG.waitForTimeout(900);
  check("道: 語が無いカテゴリ（空のマイ単語帳）には案内が出る", (await pageG.textContent("#pathList")).includes("まだ語が無い") && (await pageG.$("#pathList a[href*='myWords']")) !== null);
  await pageG.close();

  // 静的ページのヘッダー右端（Batch 42）: 未ログインは「ログイン」→ /?login=1 でホームのログイン欄が開く。ログイン済みらしければ「設定」
  const pageS1 = await newPage();
  await pageS1.goto(BASE + "/news.html", { waitUntil: "networkidle" });
  await pageS1.waitForTimeout(300);
  check("静的ページ: 未ログインは「ログイン」リンクでチップは出ない", (await pageS1.textContent("#accountLink")).trim() === "ログイン" && (await pageS1.getAttribute("#accountLink", "href")).includes("login=1") && (await pageS1.$eval("#headerStreak", (el) => el.hidden)));
  await pageS1.close();
  const todayS = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  const pageS2 = await newPage({ storage: { spelldash_test_session: "1", spelldash_streak: JSON.stringify({ current: 3, best: 3, last: todayS }) } });
  await pageS2.goto(BASE + "/news.html", { waitUntil: "networkidle" });
  await pageS2.waitForTimeout(300);
  check("静的ページ: ログイン済みは「設定」と連続日数のチップ", (await pageS2.textContent("#accountLink")).trim() === "設定" && !(await pageS2.$eval("#headerStreak", (el) => el.hidden)) && (await pageS2.textContent("#headerStreak")).includes("3"));
  await pageS2.close();
  const pageS3 = await newPage({ storage: { spelldash_placement: "done" } });
  await pageS3.goto(BASE + "/index.html?login=1", { waitUntil: "networkidle" });
  await waitUntil(async () => (await pageS3.getAttribute("#loginToggle", "aria-expanded")) === "true", 4000);
  check("/?login=1 でログインのドロップダウンが開き、URL から login が消える", (await pageS3.getAttribute("#loginToggle", "aria-expanded")) === "true" && !pageS3.url().includes("login=1"));
  await pageS3.close();

  // 道（スマホ）: 制覇ノードの「次のセクションへ」で横にはみ出さない
  const allKnownR = Object.fromEntries(jhs1R.map((w) => [w.id, { playCount: 1, knownOnSight: true, recallFail: 0 }]));
  const pageH = await newPage({ mobile: true, viewport: { width: 320, height: 640 }, storage: { spelldash_course: "jhs-redo", spelldash_packs: JSON.stringify(["jhs-english1"]), spelldash_category: "jhs-english1", spelldash_word_stats: JSON.stringify(allKnownR), spelldash_placement: "done" } });
  await pageH.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await pageH.waitForTimeout(900);
  check("道（320px）: 「次のセクションへ」があっても横スクロールしない", (await pageH.$("#pathNext")) !== null && (await pageH.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)), `scrollWidth=${await pageH.evaluate(() => document.documentElement.scrollWidth)}`);
  check("道: 次のセクション名はまだ追加していないパックでも出る", (await pageH.textContent("#pathList")).includes("中学英語 2年"));
  await pageH.close();

  // 画面キーボード: セットが終わって結果パネルが出たら畳む
  const pageI = await newPage({ mobile: true, viewport: { width: 390, height: 844 }, storage: { spelldash_course: "jhs-redo", spelldash_packs: JSON.stringify(["jhs-english1"]), spelldash_category: "jhs-english1", spelldash_placement: "done", spelldash_word_stats: JSON.stringify({ "english-go": { playCount: 1 } }) } });
  await pageI.goto(BASE + "/index.html?set=2", { waitUntil: "networkidle" });
  await pageI.waitForTimeout(900);
  await pageI.tap("#pathStart");
  await pageI.waitForTimeout(600);
  for (let i = 0; i < 6 && (await pageI.$("#resultPanel[hidden]")) !== null; i++) {
    const ja = (await pageI.textContent("#japanese")).trim();
    const cand = findByJa(jhs1R, ja);
    let ans;
    if (cand.length === 1) {
      ans = cand[0].en;
    } else {
      await pageI.press("#input", "Enter");
      await pageI.waitForTimeout(200);
      ans = (await pageI.textContent("#word")).trim();
    }
    for (const ch of ans) await pageI.press("#input", ch);
    await pageI.waitForTimeout(150);
    await pageI.press("#input", "Enter"); // 待たずに次へ（最後の語なら結果へ）
    await pageI.waitForTimeout(400);
  }
  check("画面キーボード: セット完了で結果パネルが出て、盤面は畳まれる", (await pageI.$("#resultPanel:not([hidden])")) !== null && !(await pageI.isVisible("#osk")));
  check("画面キーボード（完了時）でエラー0", pageI.errors.length === 0, pageI.errors[0] ?? "");
  await pageI.close();
}

// ===== 12. コース選択と制覇の演出 =====
console.log("courses:");
{
  const jhs1C = JSON.parse(fs.readFileSync(path.join(ROOT, "data/packs/jhs-english1.json"), "utf8")).words;
  const findByJaC = (list, ja) => list.filter((w) => w.ja === ja || w.ja.split("・").includes(ja));
  // 「コースを変える」→ TOEIC コース: 最初のパックが追加されてカテゴリになり、道の見出しが変わる
  const page = await newPage({ storage: { spelldash_course: "jhs-redo", spelldash_packs: JSON.stringify(["jhs-english1"]), spelldash_category: "jhs-english1", spelldash_placement: "done" } });
  await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  check("コース: 見出しに「コースを変える」、パネルは閉じている", (await page.$("#pathCourse")) !== null && !(await page.isVisible("#pathCourses")));
  await page.click("#pathCourse");
  await page.waitForTimeout(150);
  check("コース: パネルに10コース、いまのコースに印", (await page.$$(".path__course")).length === 10 && (await page.textContent(".path__course--current")).includes("中学英語やり直し") && (await page.$$(".path__course-pick")).length === 9);
  await page.click('.path__course-pick[data-course="toeic"]');
  await waitUntil(async () => (await page.textContent("#pathHead")).includes("セクション 1／6"), 4000); // パネルの文にも「TOEIC 500」があるので見出しのセクション表示で待つ
  const st = await page.evaluate(() => ({ course: localStorage.getItem("spelldash_course"), category: localStorage.getItem("spelldash_category"), packs: JSON.parse(localStorage.getItem("spelldash_packs") || "[]") }));
  check("コース: TOEIC に乗り換えると toeic500 が追加されてカテゴリに", st.course === "toeic" && st.category === "toeic500" && st.packs.includes("toeic500") && (await page.textContent("#pathHead")).includes("セクション 1／6"), JSON.stringify(st));
  await page.click("#pathStart");
  await page.waitForTimeout(600);
  check("コース: 乗り換え後のスタートで TOEIC 500 の語が出る", (await page.textContent("#gameCard .label")).includes("日本語訳") && (await page.isVisible("#backToPath")));
  check("コースでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();

  // 乗り換えは「まだ制覇していない最初のセクション」から: 中学英語1年を全部覚えている人が中学英語やり直しに戻ると 2年から
  const allKnownC = Object.fromEntries(jhs1C.map((w) => [w.id, { playCount: 1, knownOnSight: true, recallFail: 0 }]));
  const page2 = await newPage({ storage: { spelldash_course: "toeic", spelldash_packs: JSON.stringify(["jhs-english1", "toeic500"]), spelldash_category: "toeic500", spelldash_word_stats: JSON.stringify(allKnownC), spelldash_placement: "done" } });
  await page2.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await page2.waitForTimeout(900);
  await page2.click("#pathCourse");
  await page2.click('.path__course-pick[data-course="jhs-redo"]');
  await waitUntil(async () => (await page2.textContent("#pathHead")).includes("中学英語 2年"), 4000);
  check("コース: 制覇済みのセクションは飛ばして続きから", (await page2.evaluate(() => localStorage.getItem("spelldash_category"))) === "jhs-english2" && (await page2.textContent("#pathHead")).includes("セクション 2／8"));
  await page2.close();

  // ユニット制覇の演出: 残り1語のユニットを終えると道に🎉が出る（はちゃんは出さない）
  const firstTagC = jhs1C[0].tags[0];
  const unitWords = jhs1C.filter((w) => w.tags[0] === firstTagC);
  // 残す1語は訳が一意な語（別の語と同じ訳だと答えを見ることになり「覚えた」にならない）
  const uniqueJa = (w) => findByJaC(jhs1C, w.ja).length === 1 && w.ja.split("・").every((j) => findByJaC(jhs1C, j).length === 1);
  const last = unitWords.slice().reverse().find(uniqueJa) ?? unitWords[unitWords.length - 1];
  const stats3 = Object.fromEntries(unitWords.filter((w) => w.id !== last.id).map((w) => [w.id, { playCount: 1, knownOnSight: true, recallFail: 0 }]));
  const page3 = await newPage({ storage: { spelldash_course: "jhs-redo", spelldash_packs: JSON.stringify(["jhs-english1"]), spelldash_category: "jhs-english1", spelldash_word_stats: JSON.stringify(stats3), spelldash_placement: "done", spelldash_level_boost: "2" } });
  await page3.goto(BASE + "/index.html?set=2", { waitUntil: "networkidle" });
  await page3.waitForTimeout(900);
  check("制覇の演出: 開始前はユニット 1／11・スタートは「スタート」だけ", (await page3.textContent("#pathHead")).includes("ユニット 1／11") && (await page3.textContent("#pathStart")).trim() === "スタート", (await page3.textContent("#pathHead")).slice(0, 80));
  await page3.click("#pathStart");
  await page3.waitForTimeout(600);
  let sawLast = false;
  for (let i = 0; i < 8 && (await page3.$("#resultPanel[hidden]")) !== null; i++) {
    const ja = (await page3.textContent("#japanese")).trim();
    const cand = findByJaC(jhs1C, ja);
    let ans;
    if (cand.length === 1) {
      ans = cand[0].en;
    } else {
      await page3.press("#input", "Enter");
      await page3.waitForTimeout(200);
      ans = (await page3.textContent("#word")).trim();
    }
    if (ans === last.en) sawLast = true;
    for (const ch of ans) await page3.press("#input", ch);
    await page3.waitForTimeout(150);
    await page3.press("#input", "Enter");
    await page3.waitForTimeout(400);
  }
  await waitUntil(async () => (await page3.$("#resultPanel:not([hidden])")) !== null, 4000).catch(() => {});
  // 行は session-end の次のフレームで見出しの直後に入るので、固定待ちではなく出るのを待つ（道のトースト #pathToast は Batch 47 で削除）
  await waitUntil(async () => (await page3.$("#resultPanel .result-panel__unit")) !== null, 4000).catch(() => {});
  const unitLine = (await page3.textContent("#resultPanel .result-panel__unit").catch(() => "")) ?? "";
  const unitPrev = await page3.$eval("#resultPanel .result-panel__unit", (el) => el.previousElementSibling?.className ?? "").catch(() => "");
  check("ユニット済みの演出: 完了パネルの見出し直下に「ユニット「…」済み」", sawLast && unitLine.includes("ユニット「") && unitLine.includes("」済み") && unitPrev.includes("result-panel__title") && (await page3.textContent("#pathHead")).includes("ユニット 2／11"), `sawLast=${sawLast} line=${unitLine} prev=${unitPrev}`);
  check("制覇の演出: 道にトーストは出さず、はちゃんも出さない", (await page3.$("#pathToast")) === null && !unitLine.includes("次は") && !(await page3.$eval("#resultPanel .result-panel__unit", (el) => el.innerHTML.includes("hasumi")).catch(() => true)));
  check("制覇の演出でエラー0", page3.errors.length === 0, page3.errors[0] ?? "");
  await page3.close();
}

// ===== 12.5 Batch 47: 「今日覚えた」の定義とコースをまたぐ復習 =====
console.log("learned today / cross-section review:");
{
  // (1) 「今日覚えた」= 最後の x の直後の o が今日。覚えたあとの復習成功（x o o）は今日覚えたに入らない
  const nowB = new Date().toISOString();
  const statsB = {
    "my-invoice": { playCount: 3, correctCount: 2, missCount: 0, recallFail: 1, mastered: false, lastPlayed: nowB, nextReviewAt: new Date(Date.now() + 3 * 86400000).toISOString(), lastRecallFailAt: new Date(Date.now() - 3 * 86400000).toISOString(), lastRecallSuccessAt: nowB, history: [{ d: ymdDaysAgo(3), r: "x" }, { d: ymdDaysAgo(2), r: "o" }, { d: ymdDaysAgo(0), r: "o" }] },
    "my-negotiate": { playCount: 2, correctCount: 1, missCount: 0, recallFail: 1, mastered: false, lastPlayed: nowB, nextReviewAt: new Date(Date.now() + 86400000).toISOString(), lastRecallFailAt: new Date(Date.now() - 3 * 86400000).toISOString(), lastRecallSuccessAt: nowB, history: [{ d: ymdDaysAgo(3), r: "x" }, { d: ymdDaysAgo(0), r: "o" }] }
  };
  const pageB = await newPage({ storage: { spelldash_category: "my", spelldash_placement: "done", spelldash_my_words: JSON.stringify([{ en: "invoice", ja: "請求書" }, { en: "negotiate", ja: "交渉する" }]), spelldash_word_stats: JSON.stringify(statsB) } });
  await pageB.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await pageB.waitForTimeout(900);
  const cardB = await pageB.textContent("#learnedCard");
  check("今日覚えた: x→o(今日) の語は入り、x→o(昔)→o(今日) の語は入らない", cardB.includes("今日覚えた: ") && cardB.includes("negotiate") && !cardB.includes("invoice"), cardB.slice(0, 160));
  check("ホームのカード行に 0 の項目（苦手 0・知ってた 0）を出さない", !/苦手 0(?!\d)|知ってた 0(?!\d)/.test(cardB) && cardB.includes("覚えた 2 / 2"), cardB.slice(0, 160));
  check("今日覚えたでエラー0", pageB.errors.length === 0, pageB.errors[0] ?? "");
  await pageB.close();

  // (2) コースをまたぐ復習: セクション 2（中学英語 2年）にいても、1年の語の期日が来れば「復習 N語から」でスタートの先頭に出る
  const jhs1X = JSON.parse(fs.readFileSync(path.join(ROOT, "data/packs/jhs-english1.json"), "utf8")).words;
  const dueIds = ["english-study", "english-read", "english-write"];
  const dueJa = new Set(jhs1X.filter((w) => dueIds.includes(w.id)).map((w) => w.ja));
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
  const statsX = Object.fromEntries(dueIds.map((id) => [id, { playCount: 2, correctCount: 2, missCount: 0, recallFail: 0, cleanCorrectStreak: 1, mastered: false, lastPlayed: twoDaysAgo, nextReviewAt: new Date(Date.now() - 86400000).toISOString(), lastRecallSuccessAt: twoDaysAgo, lastRecallFailAt: null, dailyLearningDate: null, history: [{ d: ymdDaysAgo(2), r: "o" }] }]));
  const pageX = await newPage({ storage: { spelldash_course: "jhs-redo", spelldash_packs: JSON.stringify(["jhs-english1", "jhs-english2"]), spelldash_category: "jhs-english2", spelldash_word_stats: JSON.stringify(statsX), spelldash_placement: "done" } });
  await pageX.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await pageX.waitForTimeout(900);
  const labelX = await pageX.textContent(".path__node--current .path__label");
  check("コースをまたぐ復習: セクション 2 の道のラベルに前セクションの期日「復習 3語から」", dueJa.size === 3 && labelX.includes("復習 3語から") && (await pageX.textContent("#pathHead")).includes("セクション 2／8"), labelX);
  await pageX.click("#pathStart");
  await waitUntil(async () => (await pageX.textContent("#japanese")).trim().length > 0, 2000);
  const firstJa = (await pageX.textContent("#japanese")).trim();
  check("コースをまたぐ復習: スタート後の 1 語目が中学英語 1年の期日の語", dueJa.has(firstJa), `ja=${firstJa}`);
  check("コースをまたぐ復習でエラー0", pageX.errors.length === 0, pageX.errors[0] ?? "");
  await pageX.close();
}

// ===== 13. 道: 済みユニットの折りたたみとユニットの一覧リンク =====
console.log("path fold:");
{
  const jhs1F = JSON.parse(fs.readFileSync(path.join(ROOT, "data/packs/jhs-english1.json"), "utf8")).words;
  const tagsF = [...new Set(jhs1F.map((w) => w.tags[0]))];
  const doneTags = new Set(tagsF.slice(0, 6)); // 最初の6ユニットを済みに
  const statsF = Object.fromEntries(jhs1F.filter((w) => doneTags.has(w.tags[0])).map((w) => [w.id, { playCount: 1, knownOnSight: true, recallFail: 0 }]));
  const page = await newPage({ mobile: true, viewport: { width: 390, height: 844 }, storage: { spelldash_course: "jhs-redo", spelldash_packs: JSON.stringify(["jhs-english1"]), spelldash_category: "jhs-english1", spelldash_word_stats: JSON.stringify(statsF), spelldash_placement: "done" } });
  await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  check("道: 済み6ユニットは「済み 4ユニット」＋直前の2つに畳まれる", (await page.$$(".path__node--done:not(.path__node--fold)")).length === 2 && (await page.textContent(".path__node--fold")).includes("済み 4ユニット") && (await page.textContent("#pathHead")).includes("ユニット 7／11"));
  const startTop = await page.$eval("#pathStart", (el) => el.getBoundingClientRect().top);
  check("道: 現在地のスタートが最初の画面内（スクロール不要）", startTop < 844, `top=${startTop}`);
  check("道: 現在ユニットに一覧リンク（ジャンルのアンカー）", (await page.getAttribute(".path__node--current .path__unit-link", "href")).includes(`#genre-${tagsF[6]}`));
  await page.click("#pathDoneFold");
  await page.waitForTimeout(200);
  check("道: 開くと済みユニットが全部出る", (await page.$$(".path__node--done:not(.path__node--fold)")).length === 6 && (await page.$(".path__node--fold")) === null && (await page.$$(".path__dot[data-review]")).length === 6);
  check("道の折りたたみでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();
}

// ===== 14. 前回の続きから =====
console.log("resume:");
{
  const bizR2 = JSON.parse(fs.readFileSync(path.join(ROOT, "data/english/business.json"), "utf8")).words;
  const byJa = (ja) => bizR2.filter((w) => w.ja === ja || w.ja.split("・").includes(ja));
  const todayS = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  const seed = { spelldash_category: "business", spelldash_placement: "done", spelldash_level_boost: "2", spelldash_streak: JSON.stringify({ count: 1, last: todayS }) };
  const page = await newPage({ storage: seed });
  await page.goto(BASE + "/index.html?set=5", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.press("#input", "Enter");
  await page.waitForTimeout(400);
  // 自力で2語思い出す（訳が一意な語だけ自力、他は答えを見て練習）
  let recalled = 0;
  for (let i = 0; i < 10 && recalled < 2; i++) {
    const ja = (await page.textContent("#japanese")).trim();
    const cand = byJa(ja);
    if (cand.length === 1) {
      for (const ch of cand[0].en) await page.press("#input", ch);
      recalled++;
    } else {
      await page.press("#input", "Enter");
      await page.waitForTimeout(150);
      for (const ch of (await page.textContent("#word")).trim()) await page.press("#input", ch);
    }
    await page.waitForTimeout(200);
    await page.press("#input", "Enter"); // 待たずに次へ
    await page.waitForTimeout(300);
  }
  const jaBefore = (await page.textContent("#japanese")).trim();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("spelldash_session") || "null"));
  check("続きから: プレイ中に残りの語と進みが保存される", !!saved && saved.category === "business" && saved.recalled.length === 2 && saved.queue.length > 0 && saved.setSize === 5, JSON.stringify(saved)?.slice(0, 120));
  await page.click("#backToPath");
  await page.waitForTimeout(300);
  // 開き直しても道に「続きから」
  await page.goto(BASE + "/index.html?set=5", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  check("続きから: 道のスタートが「続きから」になり、進みと残りが見える", (await page.textContent("#pathStart")).includes("続きから") && (await page.textContent(".path__node--current .path__label")).includes("2／5語 済み"));
  await page.click("#pathStart");
  await page.waitForTimeout(500);
  check("続きから: 中断した語から再開し、セットの進みは 2", (await page.textContent("#japanese")).trim() === jaBefore && (await page.textContent("#message")).includes("前回の続きから") && (await page.textContent("#setProgress, .set-progress")).includes("2"), `ja=${await page.textContent("#japanese")} msg=${await page.textContent("#message")}`);
  check("続きからでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();

  // セットを終えると消える（?set=2 で2語）
  const page2 = await newPage({ storage: seed });
  await page2.goto(BASE + "/index.html?set=2", { waitUntil: "networkidle" });
  await page2.waitForTimeout(900);
  await page2.press("#input", "Enter");
  await page2.waitForTimeout(400);
  for (let i = 0; i < 10 && (await page2.$("#resultPanel[hidden]")) !== null; i++) {
    const ja = (await page2.textContent("#japanese")).trim();
    const cand = byJa(ja);
    let ans;
    if (cand.length === 1) ans = cand[0].en;
    else {
      await page2.press("#input", "Enter");
      await page2.waitForTimeout(150);
      ans = (await page2.textContent("#word")).trim();
    }
    for (const ch of ans) await page2.press("#input", ch);
    await page2.waitForTimeout(200);
    await page2.press("#input", "Enter");
    await page2.waitForTimeout(300);
  }
  check("続きから: セット完了で保存が消え、道は通常のスタートに戻る", (await page2.evaluate(() => localStorage.getItem("spelldash_session"))) === null && !(await page2.textContent("#pathStart")).includes("続きから"));
  await page2.close();
}

// ===== 15. ネイティブアプリ（Capacitor を偽装）: ログイン非表示・packs リンク・StatusBar・Haptics・インストール案内 =====
console.log("native app:");
{
  const NATIVE = () => {
    window.__native = [];
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => "ios", nativePromise: (plugin, method, options) => { window.__native.push({ plugin, method, options }); return Promise.resolve({}); } };
    window.__opened = [];
    window.open = (url) => { window.__opened.push(url); return null; };
  };
  const page = await newPage({ mobile: true, viewport: { width: 390, height: 844 }, storage: { spelldash_course: "jhs-redo", spelldash_packs: JSON.stringify(["jhs-english1"]), spelldash_category: "jhs-english1", spelldash_placement: "done", spelldash_word_stats: JSON.stringify({ "english-go": { playCount: 1 } }) } });
  await page.addInitScript(NATIVE);
  await page.goto(BASE + "/index.html?set=3", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  check("アプリ: html.native-app が付き、起動時にステータスバーの色を合わせる", (await page.evaluate(() => document.documentElement.classList.contains("native-app") && document.documentElement.classList.contains("native-ios"))) && (await page.evaluate(() => window.__native.some((c) => c.plugin === "StatusBar" && c.method === "setStyle" && c.options.style === "LIGHT"))));
  await page.click("#loginToggle");
  await page.waitForTimeout(150);
  check("アプリ: ログイン欄は Google／メールを隠して案内だけ", (await page.isVisible(".account-menu__native")) && !(await page.isVisible("#googleLoginButton")) && !(await page.isVisible("#emailInput")));
  await page.tap("#pathStart");
  await page.waitForTimeout(600);
  await page.tap('#osk [data-key="a"]');
  await page.waitForTimeout(100);
  check("アプリ: 専用キーボードのタップで Haptics が鳴る（ブリッジ経由）", await page.evaluate(() => window.__native.some((c) => c.plugin === "Haptics" && c.method === "impact")));
  await page.evaluate(async () => { const t = await import("/js/theme.js"); t.setTheme("dark"); });
  check("アプリ: ダークにするとステータスバーも DARK", await page.evaluate(() => window.__native.some((c) => c.plugin === "StatusBar" && c.method === "setStyle" && c.options.style === "DARK")));
  check("アプリでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();

  const page2 = await newPage({ storage: { spelldash_packs: JSON.stringify(["jhs-english1"]) } });
  await page2.addInitScript(NATIVE);
  await page2.goto(BASE + "/list.html", { waitUntil: "networkidle" });
  await page2.waitForTimeout(900);
  await page2.click('.packs__lead a[href="/packs/"]');
  await page2.waitForTimeout(150);
  check("アプリ: /packs/ の紹介ページは本番サイトを外部で開く（WebView 内で壊れない）", (await page2.evaluate(() => window.__opened[0])) === "https://www.spelldash.net/packs/" && page2.url().endsWith("/list.html"));
  await page2.goto(BASE + "/profile.html", { waitUntil: "networkidle" });
  await page2.waitForTimeout(700);
  check("アプリ: 「ホーム画面に追加」の案内は出さない", (await page2.evaluate(() => (document.getElementById("installCard") ?? document.querySelector("[id*='install']"))?.textContent.trim() ?? "")) === "");
  await page2.goto(BASE + "/news.html", { waitUntil: "networkidle" });
  await page2.waitForTimeout(500);
  check("アプリ: お知らせページでも native-app（セーフエリア）", await page2.evaluate(() => document.documentElement.classList.contains("native-app")));
  check("アプリ（他ページ）でエラー0", page2.errors.length === 0, page2.errors[0] ?? "");
  await page2.close();
}

// ===== 16. 同じ訳の語には例文の訳を文脈として添える =====
console.log("prompt context:");
{
  const bizP = JSON.parse(fs.readFileSync(path.join(ROOT, "data/packs/jhs-english1.json"), "utf8")).words; // speak／talk（話す）、class／lesson（授業）がある
  const toks = (w) => String(w.ja).split(/[・、／,]/).map((t) => t.trim()).filter(Boolean);
  const ambiguous = bizP.find((w) => w.exJa && bizP.some((o) => o.id !== w.id && o.en !== w.en && toks(o).some((t) => toks(w).includes(t))));
  const unique = bizP.find((w) => w.exJa && !bizP.some((o) => o.id !== w.id && toks(o).some((t) => toks(w).includes(t))));
  // ===== 別解（同じ訳の別の英単語）=====
  // 受験生の指摘: 「話す」に talk と打つと1文字目で不正解になって答えられない
  console.log("alternative answers:");
  {
    const seed = { spelldash_packs: JSON.stringify(["jhs-english1"]), spelldash_category: "jhs-english1", spelldash_placement: "done" };
    const pageA = await newPage({ storage: seed });
    await pageA.goto(BASE + "/index.html?words=english-speak", { waitUntil: "networkidle" });
    await pageA.waitForTimeout(900);
    for (const ch of "talk") await pageA.press("#input", ch);
    await pageA.waitForTimeout(400);
    const msg = (await pageA.textContent("#message")).trim();
    check("別解: 「話す」に talk と打っても不正解にならない", msg.includes("talk") && msg.includes("speak"), msg);
    check("別解: 答え欄にこの問題の語が出る", (await pageA.textContent("#word")).trim() === "speak");
    const stat = await pageA.evaluate(() => JSON.parse(localStorage.getItem("spelldash_word_stats") || "{}")["english-speak"] ?? {});
    check("別解: 思い出せなかった扱いにしない（×を記録しない）", (stat.recallFail ?? 0) === 0 && (stat.typingMiss ?? 0) === 0, JSON.stringify(stat));
    // 続けて出題語を打てば正解になる
    for (const ch of "speak") await pageA.press("#input", ch);
    await pageA.waitForTimeout(400);
    check("別解: そのあと出題語を打つと正解になる", (await pageA.textContent("#score")) === "1");
    check("別解でエラー0", pageA.errors.length === 0, pageA.errors[0] ?? "");
    await pageA.close();

    // 別解でも何でもない綴りは、これまでどおり不正解
    const pageB = await newPage({ storage: seed });
    await pageB.goto(BASE + "/index.html?words=english-speak", { waitUntil: "networkidle" });
    await pageB.waitForTimeout(900);
    await pageB.press("#input", "x");
    await pageB.waitForTimeout(300);
    check("別解: 無関係な文字はこれまでどおり不正解", (await pageB.textContent("#word")).trim() === "speak" && (await pageB.textContent("#message")).includes("違"), (await pageB.textContent("#message")).trim());
    await pageB.close();

    // つづり違いは打ち直させずにそのまま正解にする
    const pageS = await newPage({ storage: seed });
    await pageS.goto(BASE + "/index.html?words=english-favorite", { waitUntil: "networkidle" });
    await pageS.waitForTimeout(900);
    for (const ch of "favourite") await pageS.press("#input", ch);
    await pageS.waitForTimeout(400);
    check("つづり違い: favourite と打っても正解（打ち直させない）", (await pageS.textContent("#score")) === "1" && (await pageS.textContent("#message")).includes("favorite"), (await pageS.textContent("#message")).trim());
    await pageS.close();

    // 答えを見た後は出題語だけ。別解でごまかせない
    const pageC = await newPage({ storage: seed });
    await pageC.goto(BASE + "/index.html?words=english-speak", { waitUntil: "networkidle" });
    await pageC.waitForTimeout(900);
    await pageC.press("#input", "Enter"); // 答えを見る
    await pageC.waitForTimeout(300);
    await pageC.press("#input", "t"); // talk を打とうとする
    await pageC.waitForTimeout(300);
    check("別解: 答えを見た後は出題語だけを受け付ける", (await pageC.textContent("#message")).includes("違"), (await pageC.textContent("#message")).trim());
    await pageC.close();
  }

  // 別解の表そのものを直接試す（出題の当たり外れに左右されない）
  {
    const pageD = await newPage();
    await pageD.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    const alt = await pageD.evaluate(async () => {
      const m = await import("/js/answers.js");
      const idx = m.buildAlternativeIndex([
        { en: "start", ja: "始める" }, { en: "begin", ja: "始める" },
        { en: "ad", ja: "広告" }, { en: "advertisement", ja: "広告" },
        { en: "invoice", ja: "請求書" }
      ]);
      const cand = (w) => m.acceptedAnswers(w, idx);
      const adv = cand({ en: "advertisement", ja: "広告" });
      return {
        start: cand({ en: "start", ja: "始める" }),
        alone: cand({ en: "invoice", ja: "請求書" }),
        adPartial: m.completedAnswer(adv, "ad"),
        adForced: m.completedAnswer(adv, "ad", { force: true }),
        advFull: m.completedAnswer(adv, "advertisement"),
        beginOk: m.completedAnswer(cand({ en: "start", ja: "始める" }), "begin"),
        junk: m.viableAnswers(cand({ en: "start", ja: "始める" }), "x").length
      };
    });
    check("別解の表: 同じ訳の語を集める / 訳が一意な語には別解を作らない", alt.start.join(",") === "start,begin" && alt.alone.join(",") === "invoice", JSON.stringify(alt));
    check("別解の表: 短い別解で長い出題語を打ち切らない（advertisement を ad で止めない）", alt.adPartial === null && alt.advFull === "advertisement" && alt.adForced === "ad", JSON.stringify(alt));
    check("別解の表: 別解は完成として認め、無関係な文字は認めない", alt.beginOk === "begin" && alt.junk === 0, JSON.stringify(alt));
    const spell = await pageD.evaluate(async () => {
      const m = await import("/js/answers.js");
      const same = [["favourite", "favorite"], ["practise", "practice"], ["maths", "math"], ["neighbour", "neighbor"], ["realise", "realize"]];
      const diff = [["talk", "speak"], ["begin", "start"], ["big", "large"], ["kid", "child"]];
      return { same: same.every(([a, b]) => m.isSpellingVariant(a, b)), diff: diff.every(([a, b]) => !m.isSpellingVariant(a, b)) };
    });
    check("つづり違い（favourite / favorite）は同じ語、別の語（talk / speak）とは区別する", spell.same && spell.diff, JSON.stringify(spell));
    await pageD.close();
  }

  // 訳の近さの判定そのものを直接試す（ほぼ同じ訳も拾えているか）。出題の当たり外れに左右されないよう単体で見る
  {
    const pageJa = await newPage();
    await pageJa.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    const amb = await pageJa.evaluate(async () => {
      const m = await import("/js/jaAmbiguity.js");
      return {
        same: m.jaLooksSame("始める", "始める"),
        sharedToken: m.jaLooksSame("義務づける・義務を負わせる", "義務づける"),
        paren: m.jaLooksSame("たくさん（a lot of）", "たくさんの"),
        diff: m.jaLooksSame("請求書", "締め切り"),
        shortNoise: m.jaLooksSame("犬", "犬小屋")
      };
    });
    check("訳の近さ: 同じ訳・訳の一部が共通・かっこ書きを拾い、無関係な訳は拾わない", amb.same && amb.sharedToken && amb.paren && !amb.diff && !amb.shortNoise, JSON.stringify(amb));
    await pageJa.close();
  }

  const seedP = { spelldash_course: "jhs-redo", spelldash_packs: JSON.stringify(["jhs-english1"]), spelldash_category: "jhs-english1", spelldash_placement: "done" };
  if (ambiguous && unique) {
    const page = await newPage({ storage: seedP });
    await page.goto(BASE + `/index.html?words=${ambiguous.id}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    await page.press("#input", "Enter");
    await page.waitForTimeout(400);
    check("文脈: 同じ訳の語が他にあるときは例文の訳を添える（英語は出さない）", (await page.textContent("#promptContext")).includes(ambiguous.exJa) && !(await page.textContent("#promptContext")).includes(ambiguous.en), `${ambiguous.en}/${ambiguous.ja}: ${await page.textContent("#promptContext")}`);
    await page.close();
    const page2 = await newPage({ storage: seedP });
    await page2.goto(BASE + `/index.html?words=${unique.id}`, { waitUntil: "networkidle" });
    await page2.waitForTimeout(900);
    await page2.press("#input", "Enter");
    await page2.waitForTimeout(400);
    check("文脈: 訳が一意な語には添えない", (await page2.textContent("#promptContext")).trim() === "" && (await page2.textContent("#japanese")).trim() !== "", `${unique.en}/${unique.ja}`);
    await page2.close();
  } else {
    check("文脈: テスト用の語が見つからずスキップ", true);
  }
}

// ===== 17. 答え表示後の操作が1行（H4） =====
console.log("compact actions:");
{
  const todayH = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  const page = await newPage({ mobile: true, viewport: { width: 390, height: 844 }, storage: { spelldash_osk: "off", spelldash_category: "business", spelldash_placement: "done", spelldash_level_boost: "2", spelldash_streak: JSON.stringify({ count: 1, last: todayH }) } });
  await page.goto(BASE + "/index.html?set=5", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.press("#input", "Enter");
  await page.waitForTimeout(300);
  await page.press("#input", "Enter"); // 答え表示
  await page.waitForTimeout(300);
  const tops = await page.evaluate(() => ["#noteEdit", "[data-word-ai-run]", "#speakButton"].map((sel) => { const el = document.querySelector(sel); if (!el || el.hidden) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height) }; }));
  const shown = tops.filter(Boolean);
  check("答え表示後: メモ・覚え方を作る・発音が同じ1行に並ぶ（スマホ）", shown.length >= 2 && Math.max(...shown.map((t) => t.top)) - Math.min(...shown.map((t) => t.top)) <= 6 && shown.every((t) => t.h <= 36), JSON.stringify(tops));
  const inputTop = await page.$eval("#input", (el) => el.getBoundingClientRect().top);
  check("答え表示後: 入力欄が画面内（390×844）", inputTop < 844, `inputTop=${inputTop}`);
  check("1行化でエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();
}

// ===== 18. プレイヤー管理 CRM（創業者専用の管理画面）=====
// 偽 API（/api/admin/*。上のローカルサーバー）と fixture（tests/fixtures/admin-*.json）に対して画面の契約を確かめる。
// ログインは spelldash_test_session の値で作る: "1" → test-token、それ以外の文字列はそのまま access_token になる。
console.log("admin crm:");
{
  const EMI = "11111111-1111-4111-8111-111111111111"; // pinned・active
  const KEN = "22222222-2222-4222-8222-222222222222"; // active・isNew
  const MIKE = "33333333-3333-4333-8333-333333333333"; // atRisk・タグ TOEIC（詳細 fixture の本人）
  const FUMI = "44444444-4444-4444-8444-444444444444"; // churned・wordsMastered 95
  const SIGNUP = "55555555-5555-4555-8555-555555555555"; // dormant・lastActiveDay null

  const adminPage = async (token, init = {}) => {
    const storage = { ...(init.storage ?? {}) };
    if (token) storage.spelldash_test_session = token;
    const page = await newPage({ ...init, storage });
    await page.goto(BASE + "/admin.html", { waitUntil: "networkidle" });
    return page;
  };
  const stateText = (page) => page.$eval("#adminState", (el) => (el.hidden ? "" : el.textContent.replace(/\s+/g, " ").trim()));
  const waitState = (page, needle) => waitUntil(async () => (await stateText(page)).includes(needle), 5000);
  const rowIds = (page) => page.$$eval(".admin-row[data-user-id]", (rows) => rows.map((r) => r.dataset.userId));
  const rowText = (page, userId) => page.$eval(`.admin-row[data-user-id="${userId}"]`, (el) => el.textContent.replace(/\s+/g, " ").trim());
  const listReady = (page) => waitUntil(async () => (await page.$eval("#adminState", (el) => el.hidden)) && (await rowIds(page)).length > 0, 6000);
  const drawerShown = (page) => page.$eval("#adminDrawer", (el) => !el.hidden && el.getClientRects().length > 0);

  // 0. Pro までの動線（/api/admin/funnel）: 段階ごとの端末の数・前の段からの割合・入口。表が無ければ SQL の案内
  {
    const page = await adminPage("1");
    await listReady(page);
    const shown = await waitUntil(async () => (await page.$$("#adminFunnel tbody tr")).length === 9, 5000);
    const funnel = await page.$eval("#adminFunnel", (el) => el.textContent.replace(/\s+/g, " ").trim());
    check("CRM: Pro までの動線が 9 段（加入した 4 ÷ 支払いへ進んだ 6 = 67%）と入口（フッター 11）。割合は意味のある組だけ", shown && funnel.includes("加入した") && funnel.includes("67%") && funnel.includes("÷ 支払いへ進んだ") && funnel.includes("フッター 11") && (await page.$$("#adminFunnel .admin-funnel__base")).length === 4, funnel.slice(0, 240));
    await page.close();
    const noTable = await adminPage("nonotes-token");
    await waitUntil(async () => (await noTable.$eval("#adminFunnel", (el) => !el.hidden).catch(() => false)), 5000);
    check("CRM: 動線の表が無ければ docs/SQL_FUNNEL.md の案内", (await noTable.$eval("#adminFunnel", (el) => el.textContent)).includes("docs/SQL_FUNNEL.md"));
    await noTable.close();
  }

  // 1. 未ログイン → 「ログイン」の案内
  {
    const page = await adminPage(null);
    check("CRM: 未ログインは「ログイン」の案内", await waitState(page, "ログイン"), await stateText(page));
    check("CRM: 未ログインでは一覧を出さない", await page.$eval("#adminMain", (el) => el.hidden) && (await rowIds(page)).length === 0);
    check("CRM: 未ログインでエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // 2. ログイン済みだが管理者でない（403）→ 「権限」
  {
    const page = await adminPage("forbidden-token");
    check("CRM: 管理者でないアカウントは「権限」の案内", await waitState(page, "権限"), await stateText(page));
    check("CRM: 権限なしでは一覧を出さない", await page.$eval("#adminMain", (el) => el.hidden));
    await page.close();
  }

  // 3. 未設定（503）→ API の message をそのまま＋「docs/CRM.md」
  {
    const page = await adminPage("unconfigured-token");
    const ok = await waitState(page, "docs/CRM.md");
    const text = await stateText(page);
    check("CRM: 未設定は API の message と docs/CRM.md の案内", ok && text.includes("SUPABASE_SERVICE_ROLE_KEY"), text);
    await page.close();
  }

  // 4〜10. 管理者（test-token）。同じページで一覧 → 絞り込み → 並び替え → 詳細 → メモ → CSV
  {
    const page = await adminPage("test-token", { viewport: { width: 1200, height: 900 } });
    check("CRM: 管理者には一覧が表示される（#adminState は hidden）", await listReady(page), await stateText(page));

    // 4. 要約行・行数・ピン留め先頭・セグメント表示・最終活動
    const summary = (await page.textContent("#adminSummary")).replace(/\s+/g, " ").trim();
    const wanted = ["全 6", "活動中 2", "離れかけ 1", "離脱 1", "登録のみ 2", "今週の新規 2"];
    check("CRM: 要約行（全 6 ・ 活動中 2 ・ 離れかけ 1 ・ 離脱 1 ・ 登録のみ 2 ・ 今週の新規 2）", wanted.every((s) => summary.includes(s)), summary);
    let ids = await rowIds(page);
    check("CRM: 行が 6", ids.length === 6, `rows=${ids.length}`);
    check("CRM: ピン留めの Emi が先頭", ids[0] === EMI && (await rowText(page, EMI)).includes("Emi"), `first=${ids[0]}`);
    const segs = await page.$$eval(".admin-row[data-user-id] .admin-seg", (els) => els.map((e) => `${e.className.match(/admin-seg--(\w+)/)?.[1]}:${e.textContent.trim()}`));
    check("CRM: セグメントの表示（active=活動中 / atRisk=離れかけ / churned=離脱 / dormant=登録のみ）", ["active:活動中", "atRisk:離れかけ", "churned:離脱", "dormant:登録のみ"].every((s) => segs.includes(s)) && segs.length === 6, JSON.stringify(segs));
    check("CRM: 今週の新規には「新規」のチップ", (await rowText(page, KEN)).includes("新規") && !(await rowText(page, EMI)).includes("新規"), await rowText(page, KEN));
    const last = { ken: await rowText(page, KEN), emi: await rowText(page, EMI), mike: await rowText(page, MIKE), signup: await rowText(page, SIGNUP) };
    check("CRM: 最終活動は今日との差（今日 / 昨日 / 12日前 / まだなし）", last.ken.includes("今日") && last.emi.includes("昨日") && last.mike.includes("12日前") && last.signup.includes("まだなし"), JSON.stringify(last));
    check("CRM: crm_notes が無い旨の案内（#adminMissing に docs/SQL_CRM.md）", await page.$eval("#adminMissing", (el) => !el.hidden && el.textContent.includes("docs/SQL_CRM.md")));

    // 5. チップ atRisk → mike だけ
    await page.click('.admin-chip[data-segment="atRisk"]');
    ids = await rowIds(page);
    check("CRM: チップ「離れかけ」で行が 1（mike のメール）", ids.length === 1 && ids[0] === MIKE && (await rowText(page, MIKE)).includes("mike@example.com"), JSON.stringify(ids));
    await page.click('.admin-chip[data-segment="all"]');
    check("CRM: チップ「すべて」で 6 に戻る", (await rowIds(page)).length === 6);

    // 6. 検索 TOEIC → タグで mike だけ。消すと 6 に戻る
    await page.fill("#adminSearch", "TOEIC");
    ids = await rowIds(page);
    check("CRM: 検索 TOEIC はタグで引っかかり行が 1（mike）", ids.length === 1 && ids[0] === MIKE, JSON.stringify(ids));
    await page.fill("#adminSearch", "");
    check("CRM: 検索を消すと 6 に戻る", (await rowIds(page)).length === 6);

    // 7. 並び替え wordsMastered → ピン留めの Emi が先頭のまま、次が ふみ（95）
    await page.selectOption("#adminSort", "wordsMastered");
    ids = await rowIds(page);
    check("CRM: 覚えた語で並べても先頭はピン留めの Emi、次が ふみ（95）", ids[0] === EMI && ids[1] === FUMI && (await rowText(page, FUMI)).includes("ふみ") && (await rowText(page, FUMI)).includes("95"), JSON.stringify(ids));

    // 8. 行を押す → 詳細パネル
    await page.click(`.admin-row[data-user-id="${MIKE}"]`);
    check("CRM: 行を押すと詳細パネル（#adminDrawer）が見える", await waitUntil(() => drawerShown(page), 2000));
    const detailLoaded = await waitUntil(async () => (await page.textContent("#adminFeedback")).includes("別解"), 5000);
    check("CRM: 詳細のご意見に「別解」", detailLoaded, (await page.textContent("#adminFeedback")).replace(/\s+/g, " ").trim().slice(0, 80));
    await waitUntil(async () => (await page.$("#adminPacks .admin-tag")) !== null, 8000); // パック名は教材データ（ドロワーで初めて読む）が来てから
    check("CRM: 詳細の追加しているパックに TOEIC 500点（id は title 属性）", (await page.$$eval("#adminPacks .admin-tag", (els) => els.map((e) => e.title))).includes("toeic500") && (await page.textContent("#adminPacks")).includes("500点") && !(await page.textContent("#adminPacks")).includes("toeic500"), (await page.textContent("#adminPacks")).trim());
    const bars = await page.$$eval("#adminActivity > *", (els) => els.length);
    check("CRM: 30 日の活動は棒が 30 本", bars === 30, `bars=${bars}`);
    check("CRM: 詳細を開いても一覧は裏に残る", (await rowIds(page)).length === 6);

    // 9. メモを書いて保存 → 「保存済み」、一覧の行のタグも更新
    await page.fill("#adminNote", "テストのメモ");
    await page.fill("#adminTags", "TOEIC, 要フォロー");
    await page.click("#adminSaveNote");
    const saved = await waitUntil(async () => (await page.textContent("#adminNoteStatus")).includes("保存済み"), 5000);
    check("CRM: メモを保存すると「保存済み」", saved, (await page.textContent("#adminNoteStatus")).trim());
    const rowAfter = await rowText(page, MIKE);
    check("CRM: 保存後に一覧の行のタグが更新される（要フォロー）", rowAfter.includes("要フォロー") && rowAfter.includes("TOEIC"), rowAfter);
    await page.keyboard.press("Escape");
    check("CRM: Escape で詳細を閉じる", await waitUntil(() => page.$eval("#adminDrawer", (el) => el.hidden), 1000));
    check("CRM: 一覧〜メモ保存でエラー0", page.errors.length === 0, page.errors[0] ?? "");

    // 10. buildCsv を import して直接試す（ヘッダ・6 行・" のエスケープ・数式インジェクション対策）
    const fixturePlayers = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "admin-players.json"), "utf8")).players;
    const csv = await page.evaluate(async (players) => {
      const m = await import("/js/adminView.js");
      if (typeof m.buildCsv !== "function") return { error: "buildCsv が export されていない" };
      players[1].displayName = 'Ken "the" Sato';
      players[2].note = "=SUM(A1:A9)";
      players[3].note = "+81 @home";
      const text = m.buildCsv(players);
      const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l !== "");
      return { bom: text.charCodeAt(0) === 0xfeff, header: lines[0], rows: lines.length - 1, text };
    }, fixturePlayers);
    const columns = ["email", "displayName", "segment", "lastActiveDay", "activeDays7", "activeDays30", "wordsMastered", "streakCurrent", "level", "plan", "tags", "note"];
    check("CRM: buildCsv のヘッダ行（12 列）", !csv.error && String(csv.header).replace(/"/g, "").split(",").join("|") === columns.join("|"), csv.error ?? csv.header);
    check("CRM: buildCsv はデータ 6 行・BOM 付き", csv.rows === 6 && csv.bom === true, `rows=${csv.rows} bom=${csv.bom}`);
    check('CRM: buildCsv は " を "" に', !!csv.text && csv.text.includes('"Ken ""the"" Sato"'), (csv.text ?? "").split("\n")[2]);
    check("CRM: buildCsv は = + @ 始まりの値に ' を前置（数式インジェクション対策）", !!csv.text && csv.text.includes("'=SUM(A1:A9)") && !csv.text.includes('"=SUM') && csv.text.includes("'+81 @home"), (csv.text ?? "").split("\n").slice(3, 5).join(" / "));
    check("CRM: CSV の書き出しボタンがある", (await page.$("#adminExport")) !== null && (await page.$eval("#adminExport", (el) => !el.hidden)));
    await page.close();
  }

  // 9b. crm_notes が無い環境（nonotes-token）: 一覧は出るが保存は docs/SQL_CRM.md の案内
  {
    const page = await adminPage("nonotes-token", { viewport: { width: 1200, height: 900 } });
    check("CRM: crm_notes が無くても一覧は出る", await listReady(page), await stateText(page));
    await page.click(`.admin-row[data-user-id="${MIKE}"]`);
    await waitUntil(() => drawerShown(page), 2000);
    await page.fill("#adminNote", "保存先が無いはず");
    await page.click("#adminSaveNote");
    const told = await waitUntil(async () => (await page.textContent("#adminNoteStatus")).includes("docs/SQL_CRM.md"), 5000);
    check("CRM: crm_notes が無いときの保存は docs/SQL_CRM.md の案内", told, (await page.textContent("#adminNoteStatus")).trim());
    check("CRM: nonotes でエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // 11. 検索エンジンに出さない・ナビからリンクしない
  {
    const adminHtml = fs.readFileSync(path.join(ROOT, "admin.html"), "utf8");
    check("CRM: admin.html に noindex, nofollow の meta", /<meta\s+name="robots"\s+content="[^"]*noindex[^"]*nofollow[^"]*"/i.test(adminHtml));
    check("CRM: admin.html の title は「プレイヤー | SpellDash」", adminHtml.includes("<title>プレイヤー | SpellDash</title>"));
    check("CRM: sitemap.xml に admin.html が無い", !fs.readFileSync(path.join(ROOT, "sitemap.xml"), "utf8").includes("admin.html"));
    check("CRM: robots.txt に Disallow: /admin.html", /^Disallow:\s*\/admin\.html\s*$/m.test(fs.readFileSync(path.join(ROOT, "robots.txt"), "utf8")));
    const linked = ["index.html", "stats.html", "list.html", "battle.html", "profile.html", "news.html", "privacy.html"].filter((f) => fs.readFileSync(path.join(ROOT, f), "utf8").includes("admin.html"));
    check("CRM: サイトのナビから admin.html にリンクしない", linked.length === 0, linked.join(","));
  }

  // 12. 390px（mobile）: 横スクロール無し・エラー 0（一覧でも詳細でも）
  {
    const page = await adminPage("test-token", { mobile: true, viewport: { width: 390, height: 844 } });
    check("CRM（390px）: 一覧が表示される", await listReady(page), await stateText(page));
    const widths = () => page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
    let w = await widths();
    check("CRM（390px）: 一覧で横スクロールしない", w.scrollWidth <= w.innerWidth, JSON.stringify(w));
    await page.click(`.admin-row[data-user-id="${MIKE}"]`);
    await waitUntil(async () => (await page.textContent("#adminFeedback")).includes("別解"), 5000);
    w = await widths();
    check("CRM（390px）: 詳細を開いても横スクロールしない", (await drawerShown(page)) && w.scrollWidth <= w.innerWidth, JSON.stringify(w));
    check("CRM（390px）: エラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }
}

// ===== 19. SpellDash Pro（月額サブスク）: 加入ページ・プランの表示・特典のゲート・特商法 =====
// 偽 API（/api/billing/*。上のローカルサーバー）とスタブ（subscriptions は spelldash_test_plan を本人の行として返す）に対して画面の契約を確かめる。
// ログイン: spelldash_test_session "1" → test-token（free）、"pro-token" → 偽 API が 409／Portal を返す。Pro かどうかは spelldash_test_plan の行で決まる。
console.log("pro:");
{
  const isoDaysFromNow = (days) => new Date(Date.now() + days * 86400000).toISOString();
  // subscriptions の行（スタブが返す）と、js/plan.js のキャッシュ（spelldash_plan。ページ表示直後の同期判定用）を同じ内容で用意する
  const planRow = (over = {}) => ({ status: "active", plan_interval: "month", current_period_end: isoDaysFromNow(20), cancel_at_period_end: false, ...over });
  const planCache = (row) => ({ status: row.status, interval: row.plan_interval, periodEnd: row.current_period_end, cancelAtPeriodEnd: row.cancel_at_period_end, checkedAt: new Date().toISOString() });
  const proStorage = (over = {}, extra = {}) => {
    const row = planRow(over);
    return { spelldash_test_session: "pro-token", spelldash_test_plan: JSON.stringify(row), spelldash_plan: JSON.stringify(planCache(row)), ...extra };
  };
  const text = (page, selector) => page.$eval(selector, (el) => el.textContent.replace(/\s+/g, " ").trim()).catch(() => "");
  const visible = (page, selector) => page.$eval(selector, (el) => !el.hidden && el.getClientRects().length > 0).catch(() => false);
  const theme = (page) => page.evaluate(() => document.documentElement.dataset.theme);
  const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

  // 1. 未ログイン: 価格 2 つ・CTA は「ログインして始める」（#proLoginStart）→ 押すとヘッダーのログインが開く（Batch 42: #proCheckoutMonth はログイン後だけ。#proState は空）
  {
    const page = await newPage({ viewport: { width: 1200, height: 900 } });
    await page.goto(BASE + "/pro.html", { waitUntil: "networkidle" });
    const loaded = await waitUntil(async () => (await page.$("#proLoginStart")) !== null, 5000);
    const plans = await text(page, "#proPlans");
    check("Pro: 未ログインでも価格が 2 つ出る（580 と 4,800）", loaded && plans.includes("580") && plans.includes("4,800"), plans);
    const terms = await text(page, ".pro-terms");
    check("Pro: 未ログインは年額ボタンを出さず、申し込みの前に（料金・更新・解約・支払い）をボタンの直下に", (await page.$("#proCheckoutYear")) === null && terms.includes("月額 ¥580 ／ 年額 ¥4,800（月あたり ¥400）（税込）") && terms.includes("自動で更新") && terms.includes("お支払いの管理") && terms.includes("Stripe"), terms);
    check("Pro: 見出しの直下（最初の画面）に料金と「いつでも解約できる」の 1 行", (await text(page, "#proPrice")) === "月額 ¥580 ／ 年額 ¥4,800（税込）。いつでも解約できる。" && (await page.$eval("#proPrice", (el) => el.getBoundingClientRect().bottom < window.innerHeight)), await text(page, "#proPrice"));
    check("Pro: h1 は「単語の学習は無料のまま」（「学習の核」は使わない）", (await text(page, "h1")).includes("単語の学習は無料のまま") && !(await page.content()).includes("学習の核"), await text(page, "h1"));
    check("Pro: 比較表は 5 項目", (await page.$$("#proCompare tbody tr")).length === 5);
    check("Pro: 未ログインは #proState が空で、#proCheckoutMonth は無く #proLoginStart「ログインして始める」", (await text(page, "#proState")) === "" && (await page.$("#proCheckoutMonth")) === null && (await text(page, "#proLoginStart")).includes("ログインして始める"), await text(page, "#proState"));
    await page.click("#proLoginStart");
    await waitUntil(async () => (await page.getAttribute("#loginToggle", "aria-expanded")) === "true", 2000);
    check("Pro: 未ログインで「ログインして始める」を押すとヘッダーのログイン（#loginToggle）が開く", (await page.getAttribute("#loginToggle", "aria-expanded")) === "true" && (await text(page, "#proMessage")) === "", `aria-expanded=${await page.getAttribute("#loginToggle", "aria-expanded")} msg=${await text(page, "#proMessage")}`);
    check("Pro: 「ログインして始める」で加入の途中の印（spelldash_pro_intent）が付く", await page.evaluate(() => Boolean(JSON.parse(localStorage.getItem("spelldash_pro_intent") || "null")?.at)));
    // ログインのリンクから戻った体（トップに戻る・URL に access_token）: 加入画面へ戻り、選ぶところから続く
    await page.evaluate(() => localStorage.setItem("spelldash_test_session", "1"));
    await page.goto(BASE + "/index.html#access_token=test&type=magiclink", { waitUntil: "networkidle" });
    const back = await waitUntil(() => page.url().includes("/pro.html"), 5000);
    const resumed = await waitUntil(async () => (await text(page, "#proMessage")) === "ログインした。月額か年額を選ぶ。", 5000);
    check("動線: ログインから戻ると加入画面へ戻り「ログインした。月額か年額を選ぶ。」", back && resumed && !page.url().includes("resume="), `${page.url()} / ${await text(page, "#proMessage")} / plans=${(await text(page, "#proPlans")).slice(0, 80)} / state=${await text(page, "#proState")} / intent=${await page.evaluate(() => localStorage.getItem("spelldash_pro_intent"))} / paid=${await page.evaluate(() => localStorage.getItem("spelldash_funnel_paid"))} / plan=${await page.evaluate(() => localStorage.getItem("spelldash_plan"))} / errors=${page.errors.join("|")}`);
    check("動線: 戻ったら加入の途中の印を消し、月額のボタンに焦点", (await page.evaluate(() => localStorage.getItem("spelldash_pro_intent"))) === null && (await page.evaluate(() => document.activeElement?.id)) === "proCheckoutMonth");
    check("Pro: ページ内に特商法のリンク", (await page.$$('a[href="./tokushoho.html"]')).length >= 2);
    check("Pro: よくある質問は 3 つ（「アプリ版でも使える」はアプリのログインができるまで出さない）、常体", (await page.$$("details.pro-faq")).length === 3 && !(await page.content()).includes("アプリ版でも使える") && !(await page.content()).includes("いつでも解約できますか") && !(await page.$$eval("details.pro-faq", (els) => els.map((e) => e.textContent).join(""))).includes("ますか"), String((await page.$$("details.pro-faq")).length));
    check("Pro: 未ログインでエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // 2. ログイン済み free: 月額ボタン → Checkout（偽: pro.html?pro=done）→ 反映されると「Pro になった」と、使えるようになったもの
  {
    const page = await newPage({ storage: { spelldash_test_session: "1" } });
    await page.goto(BASE + "/pro.html", { waitUntil: "networkidle" });
    const ready = await waitUntil(async () => (await page.$("#proCheckoutMonth")) !== null && !(await text(page, "#proState")).includes("ログイン"), 5000);
    check("Pro: ログイン済み free は CTA が有効で、ログインの案内は出ない", ready && (await page.$eval("#proCheckoutMonth", (el) => !el.disabled)), await text(page, "#proState"));
    // Checkout を済ませたことにする（webhook が subscriptions に書いた状態をスタブに持たせる）
    await page.evaluate((row) => localStorage.setItem("spelldash_test_plan", row), JSON.stringify(planRow()));
    await page.click("#proCheckoutMonth");
    const moved = await waitUntil(() => page.url().includes("/pro.html"), 5000);
    check("Pro: 月額ボタンで Checkout（偽）→ 加入画面に戻る", moved, page.url());
    const thanked = await waitUntil(async () => (await text(page, "#proWelcome")).includes("Pro になった"), 8000);
    check("Pro: ?pro=done で反映を待ち「Pro になった」と、使えるようになったもの 5 つ（マイ単語帳・テーマへのリンク）", thanked && (await page.$$("#proWelcome li")).length === 5 && (await page.$('#proWelcome a[href="./list.html#myWords"]')) !== null && (await page.$('#proWelcome a[href="./profile.html#appearance"]')) !== null, await text(page, "#proWelcome"));
    check("Pro: 加入直後は購入ボタンを出さず、URL の ?pro=done を消す", (await page.$("#proCheckoutMonth")) === null && !page.url().includes("pro=done"), page.url());
    await page.goto(BASE + "/profile.html", { waitUntil: "networkidle" });
    await waitUntil(async () => (await text(page, "#planValue")).includes("Pro"), 5000);
    check("Pro: プラン行が Pro になる", (await text(page, "#planValue")).includes("Pro"), await text(page, "#planValue"));
    check("Pro: 加入フローでエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // 2a. ログインから戻って加入画面へ移っても「いまログインした」のまま: 持ち主の印が無い端末の記録は、足すかをたずねる
  {
    const page = await newPage();
    page.dialogs = [];
    page.on("dialog", async (d) => { page.dialogs.push(d.message()); await d.dismiss(); });
    await page.goto(BASE + "/pro.html", { waitUntil: "networkidle" });
    await page.evaluate(() => {
      localStorage.setItem("spelldash_word_stats", JSON.stringify({ "zzz-guest": { playCount: 1, correctCount: 1, lastPlayed: new Date().toISOString() } }));
      localStorage.setItem("spelldash_pro_intent", JSON.stringify({ at: Date.now() }));
      localStorage.setItem("spelldash_test_session", "1");
    });
    await page.goto(BASE + "/index.html#access_token=test&type=magiclink", { waitUntil: "networkidle" });
    await waitUntil(() => page.url().includes("/pro.html"), 5000);
    const asked = await waitUntil(async () => page.dialogs.some((m) => m.startsWith("この端末の記録を、このアカウントの記録に足す。")), 5000);
    check("動線: ログインから戻って加入画面へ移っても、端末の記録を足すかをたずねる", asked, JSON.stringify(page.dialogs));
    await page.close();
  }

  // 2c. 支払いを終えて戻ったがログインが切れている: 支払い済みを伝える（購入ボタンだけの画面にしない）。旧い戻り先は加入画面へ
  {
    const page = await newPage();
    await page.goto(BASE + "/pro.html?pro=done", { waitUntil: "networkidle" });
    const told = await waitUntil(async () => (await text(page, "#proWelcome")).includes("手続きは完了。加入したアカウントでログインすると Pro になる"), 5000);
    check("動線: 加入直後にログインが切れていても「手続きは完了。…ログインすると Pro になる」", told, await text(page, "#proWelcome"));
    await page.goto(BASE + "/profile.html?pro=done", { waitUntil: "networkidle" });
    const forwarded = await waitUntil(() => page.url().includes("/pro.html"), 5000);
    check("動線: 旧い戻り先（profile.html?pro=done）は加入画面へ移る", forwarded, page.url());
    await page.close();
  }

  // 2b. 知る: フッターの「SpellDash Pro」（受付中のときだけ）と、7 日以上学んだ人の週間レポートの 1 行（Pro には出さない）
  {
    const page = await newPage();
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    const linked = await waitUntil(async () => (await page.$(".site-footer__nav [data-footer-pro]")) !== null, 5000);
    check("動線: 受付中ならフッターに「SpellDash Pro」", linked && (await text(page, ".site-footer__nav [data-footer-pro]")) === "SpellDash Pro");
    await page.close();

    const closed = await newPage({ storage: { spelldash_billing_open: JSON.stringify({ open: false, at: Date.now() }) } });
    await closed.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await closed.waitForTimeout(400);
    check("動線: 受付前（キャッシュが閉じている）ならフッターに出さない", (await closed.$(".site-footer__nav [data-footer-pro]")) === null);
    await closed.close();

    const week = Array.from({ length: 8 }, (_, i) => ({ date: ymdDaysAgo(7 - i), learned: 10 + i * 3, mastered: 0, active: true, v: 2 }));
    const open = JSON.stringify({ open: true, at: Date.now() });
    const free = await newPage({ storage: { spelldash_billing_open: open, spelldash_growth_log: JSON.stringify(week), spelldash_placement: "done" } });
    await free.goto(BASE + "/stats.html", { waitUntil: "networkidle" });
    await waitUntil(async () => (await text(free, "#weeklyReport")).includes("週間レポート"), 5000);
    check("動線: 7 日以上学んだ free の週間レポートに「Pro なら、…」の 1 行", (await text(free, "#weeklyReport .weekly__pro")).startsWith("Pro なら、マイ単語帳 1,000語・連続記録の修復。") && (await free.$('#weeklyReport .weekly__pro a[href="./pro.html"]')) !== null, await text(free, "#weeklyReport"));
    await free.close();

    const short = await newPage({ storage: { spelldash_billing_open: open, spelldash_growth_log: JSON.stringify(week.slice(-3)), spelldash_placement: "done" } });
    await short.goto(BASE + "/stats.html", { waitUntil: "networkidle" });
    await waitUntil(async () => (await text(short, "#weeklyReport")).includes("週間レポート"), 5000);
    check("動線: 学んだ日が 7 日未満なら週間レポートに Pro の行を出さない", (await short.$("#weeklyReport .weekly__pro")) === null);
    await short.close();

    const pro = await newPage({ storage: proStorage({}, { spelldash_billing_open: open, spelldash_growth_log: JSON.stringify(week), spelldash_placement: "done" }) });
    await pro.goto(BASE + "/stats.html", { waitUntil: "networkidle" });
    await waitUntil(async () => (await text(pro, "#weeklyReport")).includes("週間レポート"), 5000);
    check("動線: Pro の人の週間レポートには Pro の行を出さない", (await pro.$("#weeklyReport .weekly__pro")) === null);
    await pro.close();
  }

  // 2d. 支払い遅延（past_due）: 「ご利用中」と日付ではなく、カードの更新を言う（無料に戻る日は Stripe の再試行が決めるので出さない）。ボタンは「カードを更新する」
  {
    const page = await newPage({ storage: proStorage({ status: "past_due", current_period_end: isoDaysFromNow(-1) }) });
    await page.goto(BASE + "/pro.html", { waitUntil: "networkidle" });
    const told = await waitUntil(async () => (await text(page, "#proState")).includes("お支払いが確認できていない"), 5000);
    check("Pro: past_due は「お支払いが確認できていない。カードを更新しないと無料に戻る」（日付は出さない）と「カードを更新する」", told && (await text(page, "#proState")).includes("お支払いが確認できていない。カードを更新しないと無料に戻る") && (await text(page, "#proPortal")) === "カードを更新する", await text(page, "#proState"));
    await page.close();
  }

  // 2e. 支払い後に開き直した（まだ Pro に反映されていない）: 購入ボタンを出さない（二重の申し込みを防ぐ）
  {
    const page = await newPage({ storage: { spelldash_test_session: "1" } });
    await page.goto(BASE + "/pro.html", { waitUntil: "networkidle" });
    await page.evaluate(() => localStorage.setItem("spelldash_funnel_paid", new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10)));
    await page.reload({ waitUntil: "networkidle" });
    const waiting = await waitUntil(async () => (await text(page, "#proPlans")).includes("手続きは完了。反映を待っている。もう一度申し込まない"), 5000);
    check("Pro: 支払い後に開き直してもまだ反映されていなければ、購入ボタンの代わりに「反映を待っている。もう一度申し込まない」", waiting && (await page.$("#proCheckoutMonth")) === null, await text(page, "#proPlans"));
    check("Pro: 支払いの印は開いたアカウントに付く", (await page.evaluate(() => JSON.parse(localStorage.getItem("spelldash_funnel_paid") || "{}").user)) === "test-user");
    await page.close();
  }

  // 2e'. 別のアカウントの支払いの印が残っている（同じブラウザで別の人がログイン）: 購入ボタンを隠さない
  {
    const day = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    const page = await newPage({ storage: { spelldash_test_session: "1", spelldash_funnel_paid: JSON.stringify({ day, user: "someone-else" }) } });
    await page.goto(BASE + "/pro.html", { waitUntil: "networkidle" });
    const shown = await waitUntil(async () => (await page.$("#proCheckoutMonth")) !== null, 5000);
    check("Pro: 別のアカウントの支払いの印では「反映を待っている」を出さず、購入ボタンを出す", shown && !(await text(page, "#proPlans")).includes("反映を待っている"), await text(page, "#proPlans"));
    await page.close();
  }

  // 2e''. 別のアカウントの支払いの印が残っているところへ、もう Pro の人がログインした: 印を消さない（払った人の二重の申し込みを防ぐ）
  {
    const day = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    const page = await newPage({ storage: proStorage({}, { spelldash_funnel_paid: JSON.stringify({ day, user: "someone-else" }) }) });
    await page.goto(BASE + "/stats.html", { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    const mark = await page.evaluate(() => JSON.parse(localStorage.getItem("spelldash_funnel_paid") || "null"));
    check("Pro: 別のアカウントの支払いの印は、Pro の人が開いても消さない", mark?.user === "someone-else", JSON.stringify(mark));
    await page.close();
  }

  // 2g. 初めての方は 1 か月無料（STRIPE_TRIAL_MONTHS=1）: 未ログイン・初めての人・以前に加入した人で文を分ける
  {
    await fetch(BASE + "/__billing/trial?months=1", { method: "POST" });
    const guest = await newPage();
    await guest.goto(BASE + "/pro.html", { waitUntil: "networkidle" });
    await waitUntil(async () => (await text(guest, "#proPrice")).includes("¥580"), 5000);
    check("無料期間: 未ログインの料金の行に「初めての方は最初の1か月無料」", (await text(guest, "#proPrice")).includes("初めての方は最初の1か月無料"), await text(guest, "#proPrice"));
    check("無料期間: 未ログインの「申し込みの前に」に「初めての方だけ、最初の1か月は無料」", (await text(guest, ".pro-terms")).includes("初めての方だけ、最初の1か月は無料"), await text(guest, ".pro-terms"));
    await guest.close();

    const first = await newPage({ storage: { spelldash_test_session: "1" } });
    await first.goto(BASE + "/pro.html", { waitUntil: "networkidle" });
    await waitUntil(async () => (await first.$("#proCheckoutMonth")) !== null, 5000);
    const button = await text(first, "#proCheckoutMonth");
    check("無料期間: 初めての人のボタンは「1か月無料で始める（その後 月額 ¥580）」", button === "1か月無料で始める（その後 月額 ¥580）", button);
    check("無料期間: 初めての人には終わりの日（M/D に 月額…を請求）", /\d+\/\d+ に 月額 ¥580/.test(await text(first, ".pro-terms")), await text(first, ".pro-terms"));
    await first.close();

    const again = await newPage({ storage: proStorage({ status: "canceled", current_period_end: isoDaysFromNow(-40) }) });
    await again.goto(BASE + "/pro.html", { waitUntil: "networkidle" });
    await waitUntil(async () => (await again.$("#proCheckoutMonth")) !== null, 5000);
    check("無料期間: 以前に加入した人のボタンは「月額 ¥580 で始める」（無料と言わない）", (await text(again, "#proCheckoutMonth")) === "月額 ¥580 で始める" && !(await text(again, "#proPrice")).includes("無料"), `${await text(again, "#proCheckoutMonth")} / ${await text(again, "#proPrice")}`);
    check("無料期間: 以前に加入した人には「今回は加入した日に…請求」", (await text(again, ".pro-terms")).includes("以前に加入したことがあるので"), await text(again, ".pro-terms"));
    await again.close();
    await fetch(BASE + "/__billing/trial?months=0", { method: "POST" });
  }

  // 2f. 受付前（キャッシュが閉じている）: 上限の文に Pro の話とリンクを出さない
  {
    const hundred = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ en: `word${i}`, ja: `語${i}` })));
    const page = await newPage({ storage: { spelldash_billing_open: JSON.stringify({ open: false, at: Date.now() }), spelldash_my_words: hundred } });
    await page.goto(BASE + "/list.html#myWords", { waitUntil: "networkidle" });
    const status = await waitUntil(async () => (await text(page, "#myWordStatus")).includes("100語まで"), 5000);
    check("Pro: 受付前は上限の文が「無料で追加できるのは100語まで。」だけ（Pro の話もリンクも無い）", status && (await text(page, "#myWordStatus")) === "無料で追加できるのは100語まで。" && (await page.$('#myWordStatus a[href="./pro.html"]')) === null, await text(page, "#myWordStatus"));
    check("マイ単語帳: 100 語でも描くのは新しい 50 行と「すべて表示（100語）」", (await page.$$("#myWordList .my-word")).length === 50 && (await text(page, "#myWordMore")) === "すべて表示（100語）");
    await page.click("#myWordMore");
    check("マイ単語帳: 「すべて表示」で 100 行", await waitUntil(async () => (await page.$$("#myWordList .my-word")).length === 100, 3000));
    await page.close();
  }

  // 3. Pro（active）: pro.html は CTA 無し・ご利用中・お支払いの管理。profile.html のプラン行も Pro
  {
    const page = await newPage({ storage: proStorage() });
    await page.goto(BASE + "/pro.html", { waitUntil: "networkidle" });
    const shown = await waitUntil(async () => (await text(page, "#proState")).includes("Pro（次回の更新"), 5000);
    check("Pro: 加入済みは #proState に「Pro（次回の更新 …）」（プロフィールのプラン行と同じ文）", shown, await text(page, "#proState"));
    check("Pro: 加入済みには比較表と料金の 1 行を出さず、見出しは「プラン」", !(await visible(page, "#proCompareSection")) && !(await visible(page, "#proPrice")) && (await text(page, "#proPlansTitle")) === "プラン");
    check("Pro: 加入済みには CTA を出さない", (await page.$("#proCheckoutMonth")) === null && (await page.$("#proCheckoutYear")) === null);
    check("Pro: 加入済みには #proPortal「解約・お支払いの管理」", (await text(page, "#proPortal")) === "解約・お支払いの管理", await text(page, "#proPortal"));
    await page.click("#proPortal");
    const portal = await waitUntil(() => /\/profile\.html$/.test(page.url()), 5000);
    check("Pro: お支払いの管理 → Portal（偽: profile.html）", portal, page.url());
    const planText = await waitUntil(async () => (await text(page, "#planValue")).includes("Pro"), 5000);
    check("Pro: profile の #planValue に「Pro（次回の更新 …）」", planText && (await text(page, "#planValue")).includes("次回の更新"), await text(page, "#planValue"));
    check("Pro: profile に #planPortal、「Pro について」は隠す", (await visible(page, "#planPortal")) && !(await visible(page, "#planLink")));
    check("Pro: 加入済みの表示でエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // 4. 解約予定（cancel_at_period_end）: 期間末まで Pro、表示は「解約予定」
  {
    const page = await newPage({ storage: proStorage({ cancel_at_period_end: true }) });
    await page.goto(BASE + "/profile.html", { waitUntil: "networkidle" });
    const ok = await waitUntil(async () => (await text(page, "#planValue")).includes("解約予定"), 5000);
    check("Pro: 解約予定は #planValue に「解約予定」と期限", ok && (await text(page, "#planValue")).includes("まで"), await text(page, "#planValue"));
    await page.goto(BASE + "/pro.html", { waitUntil: "networkidle" });
    const state = await waitUntil(async () => (await text(page, "#proState")).includes("解約予定"), 5000);
    check("Pro: 解約予定でも pro.html は CTA 無し・#proState に「解約予定」", state && (await page.$("#proCheckoutMonth")) === null, await text(page, "#proState"));
    await page.close();
  }

  // 5. 失効（期限の 10 日後。3 日の猶予を過ぎている）→ Free。過ぎていない past_due は Pro
  {
    const page = await newPage({ storage: proStorage({ current_period_end: isoDaysFromNow(-10) }) });
    await page.goto(BASE + "/profile.html", { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    check("Pro: 失効（期限 + 3 日を過ぎた）は #planValue が「無料」", (await text(page, "#planValue")) === "無料", await text(page, "#planValue"));
    check("Pro: 失効したら「Pro について」のリンクが出る", (await visible(page, "#planLink")) && !(await visible(page, "#planPortal")));
    await page.close();
    const page2 = await newPage({ storage: proStorage({ status: "past_due", current_period_end: isoDaysFromNow(-1) }) });
    await page2.goto(BASE + "/profile.html", { waitUntil: "networkidle" });
    await page2.waitForTimeout(800);
    check("Pro: past_due でも期限 + 3 日以内なら Pro（猶予）", (await text(page2, "#planValue")).includes("Pro"), await text(page2, "#planValue"));
    await page2.close();
  }

  // 6. マイ単語帳: free は 100 語で止まる（「Pro について」）。Pro は追加できる
  {
    const hundred = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ en: `word${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`, ja: `語${i}` })));
    const page = await newPage({ storage: { spelldash_my_words: hundred } });
    await page.goto(BASE + "/list.html#myWords", { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    const status = await text(page, "#myWordStatus");
    check("Pro: free は 100 語で「追加する」が disabled、上限の文は読み込み時から", (await page.$eval("#myWordForm button[type=submit]", (el) => el.disabled)) && (await page.$eval("#myConceptForm button[type=submit]", (el) => el.disabled)) && status.includes("無料で追加できるのは100語まで") && !status.includes("登録できる"), status);
    check("Pro: 上限の文は入力欄の直前・朱ではない・「。」の直後に「Pro について」", (await page.$eval("#myWordStatus", (el) => el.nextElementSibling?.id === "myWordForm" && !el.classList.contains("my-words__status--error"))) && status.includes("）。Pro について"), status);
    check("Pro: 上限の案内に「Pro について」のリンク", (await page.$$('#myWordStatus a[href="./pro.html"]')).length === 1 && status.includes("Pro について"), status);
    await page.fill("#myWordEn", "negotiate");
    await page.fill("#myWordJa", "交渉する");
    await page.press("#myWordJa", "Enter"); // 送信ボタンが disabled なので Enter でも送らない
    await page.waitForTimeout(200);
    const count = await page.evaluate(() => JSON.parse(localStorage.getItem("spelldash_my_words") || "[]").length);
    check("Pro: free の 101 語目は保存されず、入力した語は消えない", count === 100 && (await page.inputValue("#myWordEn")) === "negotiate", `count=${count}`);
    await page.close();
    const page2 = await newPage({ storage: proStorage({}, { spelldash_my_words: hundred }) });
    await page2.goto(BASE + "/list.html#myWords", { waitUntil: "networkidle" });
    await page2.waitForTimeout(800);
    await page2.fill("#myWordEn", "negotiate");
    await page2.fill("#myWordJa", "交渉する");
    await page2.click("#myWordForm button[type=submit]");
    await page2.waitForTimeout(200);
    const count2 = await page2.evaluate(() => JSON.parse(localStorage.getItem("spelldash_my_words") || "[]").length);
    check("Pro: Pro は 101 語目を追加できる", count2 === 101 && (await text(page2, "#myWordList")).includes("negotiate"), `count=${count2} status=${await text(page2, "#myWordStatus")}`);
    check("Pro: マイ単語帳のゲートでエラー0", page.errors.length === 0 && page2.errors.length === 0, page.errors[0] ?? page2.errors[0] ?? "");
    await page2.close();
  }

  // 7. 推移: free が 90 を押しても 30 のまま（案内だけ）。Pro は 90 日で描き直し、選択を保存
  {
    const log = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ date: ymdDaysAgo(99 - i), learned: i, mastered: Math.floor(i / 2), active: true })));
    const page = await newPage({ storage: { spelldash_growth_log: log } });
    await page.goto(BASE + "/stats.html", { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    const before = await page.$eval("#growthTrend", (el) => el.innerHTML);
    check("Pro: 推移の期間は 30 が選ばれている", await page.$eval('[data-trend-range="30"]', (el) => el.classList.contains("is-active")));
    await page.click('[data-trend-range="90"]');
    await page.waitForTimeout(300);
    const hint = await text(page, ".trend-range__hint");
    check("Pro: free が 90 を押すと「Pro で見られる」の案内と「Pro について」", hint.includes("Pro で見られる") && (await page.$$('.trend-range__hint a[href="./pro.html"]')).length === 1, hint);
    check("Pro: free のグラフは 30 日のまま（描き直さない）", before === (await page.$eval("#growthTrend", (el) => el.innerHTML)) && (await page.$eval('[data-trend-range="30"]', (el) => el.classList.contains("is-active"))) && (await text(page, "#growthDays")) === "30");
    check("Pro: free は spelldash_trend_range を保存しない", (await page.evaluate(() => localStorage.getItem("spelldash_trend_range"))) !== "90");
    await page.close();
    const page2 = await newPage({ storage: proStorage({}, { spelldash_growth_log: log }) });
    await page2.goto(BASE + "/stats.html", { waitUntil: "networkidle" });
    await page2.waitForTimeout(900);
    const before2 = await page2.$eval("#growthTrend", (el) => el.innerHTML);
    await page2.click('[data-trend-range="90"]');
    await page2.waitForTimeout(300);
    check("Pro: Pro が 90 を押すと 90 が .is-active・見出しも 90 日", (await page2.$eval('[data-trend-range="90"]', (el) => el.classList.contains("is-active"))) && (await text(page2, "#growthDays")) === "90" && (await page2.$(".trend-range__hint")) === null);
    check("Pro: Pro は 90 日で描き直す（SVG が変わる）", before2 !== (await page2.$eval("#growthTrend", (el) => el.innerHTML)) && (await page2.$("#growthTrend svg")) !== null);
    check("Pro: 選択を spelldash_trend_range に保存", (await page2.evaluate(() => localStorage.getItem("spelldash_trend_range"))) === "90");
    await page2.reload({ waitUntil: "networkidle" });
    await page2.waitForTimeout(900);
    check("Pro: 再読込後も 90 日のまま", await page2.$eval('[data-trend-range="90"]', (el) => el.classList.contains("is-active")));
    check("Pro: 推移のゲートでエラー0", page.errors.length === 0 && page2.errors.length === 0, page.errors[0] ?? page2.errors[0] ?? "");
    await page2.close();
  }

  // 8. テーマ: free が紙を選ぶと案内が出て light のまま。Pro は紙・藍が効き、再読込後も残る（head スニペット）
  {
    const page = await newPage();
    await page.goto(BASE + "/profile.html", { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    check("Pro: テーマの選択肢に 紙（Pro）・藍（Pro）", (await page.$$eval("#themeSelect option", (els) => els.map((e) => e.value))).join(",") === "light,dark,paper,indigo", (await page.$$eval("#themeSelect option", (els) => els.map((e) => e.value))).join(","));
    await page.selectOption("#themeSelect", "paper");
    await page.waitForTimeout(200);
    const hint = await text(page, "#themeHint");
    check("Pro: free が紙を選ぶと #themeHint に「Pro のテーマ」と「Pro について」", (await visible(page, "#themeHint")) && hint.includes("Pro のテーマ") && (await page.$$('#themeHint a[href="./pro.html"]')).length === 1, hint);
    check("Pro: free の data-theme は light のまま・選択も戻る", (await theme(page)) === "light" && (await page.$eval("#themeSelect", (el) => el.value)) === "light" && (await page.evaluate(() => localStorage.getItem("spelldash_theme"))) !== "paper");
    await page.selectOption("#themeSelect", "indigo");
    await page.waitForTimeout(200);
    check("Pro: free が藍を選んでも light のまま", (await theme(page)) === "light");
    await page.close();
    const page2 = await newPage({ storage: proStorage() });
    await page2.goto(BASE + "/profile.html", { waitUntil: "networkidle" });
    await page2.waitForTimeout(600);
    await page2.selectOption("#themeSelect", "paper");
    await page2.waitForTimeout(200);
    check("Pro: Pro が紙を選ぶと data-theme=paper・案内は出ない", (await theme(page2)) === "paper" && !(await visible(page2, "#themeHint")));
    check("Pro: 紙の meta theme-color", (await page2.$eval('meta[name="theme-color"]', (el) => el.content)) === "#f3ecdd");
    await page2.goto(BASE + "/index.html", { waitUntil: "domcontentloaded" });
    const early = await theme(page2); // head スニペットが付ける（theme.js より前）
    await page2.waitForTimeout(600);
    check("Pro: 再読込後も紙（head スニペット → theme.js）", early === "paper" && (await theme(page2)) === "paper", `early=${early} after=${await theme(page2)}`);
    await page2.goto(BASE + "/profile.html", { waitUntil: "networkidle" });
    await page2.waitForTimeout(600);
    await page2.selectOption("#themeSelect", "indigo");
    await page2.waitForTimeout(200);
    check("Pro: Pro が藍を選ぶと data-theme=indigo", (await theme(page2)) === "indigo" && (await page2.$eval('meta[name="theme-color"]', (el) => el.content)) === "#121a2b");
    await page2.goto(BASE + "/stats.html", { waitUntil: "networkidle" });
    await page2.waitForTimeout(600);
    const bg = await page2.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const lum = (() => { const m = bg.match(/\d+/g) ?? []; return m.length >= 3 ? (Number(m[0]) + Number(m[1]) + Number(m[2])) / 3 : 255; })();
    check("Pro: 藍は別ページでも残り、背景は暗い", (await theme(page2)) === "indigo" && lum < 80, `bg=${bg}`);
    check("Pro: テーマのゲートでエラー0", page.errors.length === 0 && page2.errors.length === 0, page.errors[0] ?? page2.errors[0] ?? "");
    await page2.close();
  }

  // 9. 連続記録の修復: 5 日前に 7 日で途切れた → free は案内、Pro はボタン → 「連続 7 日に戻しました」→ もう一度は押せない
  {
    const streak = JSON.stringify({ last: ymdDaysAgo(5), current: 7, best: 7, shields: 0 });
    const page = await newPage({ storage: { spelldash_streak: streak } });
    await page.goto(BASE + "/stats.html", { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    const repair = await text(page, "#streakRepair");
    check("Pro: 途切れた記録があると #streakRepair「連続 7 日が M/D に途切れた」", repair.includes("連続 7 日") && repair.includes("途切れた"), repair);
    check("Pro: free は「Pro なら」の案内と「Pro について」", repair.includes("Pro なら") && (await page.$$('#streakRepair a[href="./pro.html"]')).length === 1 && (await page.$("#streakRepairButton")) === null, repair);
    await page.close();
    const page2 = await newPage({ storage: proStorage({}, { spelldash_streak: streak }) });
    await page2.goto(BASE + "/stats.html", { waitUntil: "networkidle" });
    await page2.waitForTimeout(900);
    check("Pro: Pro には #streakRepairButton「今月の修復を使う」", (await text(page2, "#streakRepairButton")).includes("今月の修復"), await text(page2, "#streakRepair"));
    await page2.click("#streakRepairButton");
    await page2.waitForTimeout(300);
    check("Pro: 押すと「連続 7 日に戻した」", (await text(page2, "#streakRepair")).includes("連続 7 日に戻した"), await text(page2, "#streakRepair"));
    const saved = await page2.evaluate(() => JSON.parse(localStorage.getItem("spelldash_streak") || "{}"));
    const thisMonth = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; })();
    check("Pro: 保存値は current 7・repairedMonth が今月・lost は消える", saved.current === 7 && saved.repairedMonth === thisMonth && !saved.lost, JSON.stringify(saved));
    check("Pro: 概要の連続日数が 7 に戻る", (await text(page2, "#overview")).includes("7"), await text(page2, "#overview"));
    check("Pro: 修復後はボタンが無い（もう一度は押せない）", (await page2.$("#streakRepairButton")) === null);
    await page2.close();
    // 同じ月にまた途切れた（repairedMonth が今月）→ 「今月の修復は使いました」。newPage の seed は再読込でも効くので別ページで
    const page3 = await newPage({ storage: proStorage({}, { spelldash_streak: JSON.stringify({ last: ymdDaysAgo(3), current: 4, best: 7, shields: 0, lost: null, repairedMonth: thisMonth }) }) });
    await page3.goto(BASE + "/stats.html", { waitUntil: "networkidle" });
    await page3.waitForTimeout(900);
    check("Pro: 今月すでに使っていれば「今月の修復は使った」でボタン無し", (await text(page3, "#streakRepair")).includes("今月の修復は使った") && (await page3.$("#streakRepairButton")) === null, await text(page3, "#streakRepair"));
    check("Pro: 修復フローでエラー0", page.errors.length === 0 && page2.errors.length === 0 && page3.errors.length === 0, page.errors[0] ?? page2.errors[0] ?? page3.errors[0] ?? "");
    await page3.close();
  }

  // 10. Checkout を中止して戻った（?pro=cancel）
  {
    const page = await newPage({ storage: { spelldash_test_session: "1" } });
    await page.goto(BASE + "/pro.html?pro=cancel", { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    check("Pro: ?pro=cancel で #proMessage に「中止」", (await text(page, "#proMessage")).includes("中止"), await text(page, "#proMessage"));
    check("Pro: 中止後も CTA は出る（再開できる）", await waitUntil(async () => (await page.$("#proCheckoutMonth")) !== null, 5000));
    await page.close();
  }

  // 11. 特商法ページと、全ページのフッターのリンク。プライバシーにお支払い情報の節
  {
    const page = await newPage();
    await page.goto(BASE + "/tokushoho.html", { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    check("Pro: tokushoho.html の h1「特定商取引法に基づく表記」", (await text(page, "h1")).includes("特定商取引法に基づく表記"));
    const dl = await page.$$eval("dl.legal dt", (els) => els.map((e) => e.textContent.trim()));
    check("Pro: 特商法の項目（販売事業者〜動作環境の 11 項目）", dl.length === 11 && ["販売事業者", "販売価格", "支払方法", "解約・返金", "動作環境"].every((s) => dl.includes(s)), dl.join(","));
    check("Pro: tokushoho.html エラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
    const LINK = '<a href="./tokushoho.html">特定商取引法に基づく表記</a>';
    const missing = ["index.html", "battle.html", "stats.html", "profile.html", "privacy.html", "news.html", "list.html", "admin.html", "pro.html", "tokushoho.html"].filter((f) => {
      const html = fs.readFileSync(path.join(ROOT, f), "utf8");
      const nav = html.match(/<nav class="site-footer__nav"[\s\S]*?<\/nav>/)?.[0] ?? "";
      return !(nav.includes(LINK) && nav.indexOf('href="./privacy.html"') < nav.indexOf(LINK));
    });
    check("Pro: 全 10 ページのフッターにプライバシーの直後の特商法リンク", missing.length === 0, missing.join(","));
    const privacy = fs.readFileSync(path.join(ROOT, "privacy.html"), "utf8");
    check("Pro: privacy.html に「お支払い情報」の節と Stripe のポリシーへのリンク", privacy.includes("<h3>お支払い情報</h3>") && /href="https:\/\/stripe\.com\/jp\/privacy"[^>]*rel="noopener"/.test(privacy) && privacy.includes("Stripe, Inc."));
    check("Pro: sitemap に pro.html と tokushoho.html、sw の precache にも", (() => { const sm = fs.readFileSync(path.join(ROOT, "sitemap.xml"), "utf8"); const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8"); return sm.includes("/pro.html") && sm.includes("/tokushoho.html") && sw.includes('"/pro.html"') && sw.includes('"/tokushoho.html"'); })());
  }

  // 12. 覚え方の解説: 無料ぶんを使い切った（429・upgrade）→ message と「Pro について」
  {
    const today = ymdDaysAgo(0);
    const page = await newPage({ storage: { spelldash_test_session: "1", spelldash_placement: "done", spelldash_category: "my", spelldash_my_words: JSON.stringify([{ en: "limit", ja: "限界" }]), spelldash_streak: JSON.stringify({ last: today, current: 1, best: 1, shields: 0 }) } });
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    await page.press("#input", "Enter");
    await page.waitForTimeout(300);
    check("Pro: マイ単語帳の limit が出題される", (await text(page, "#japanese")) === "限界", await text(page, "#japanese"));
    await page.press("#input", "Enter"); // 答え表示
    const button = await waitUntil(async () => (await page.$$("[data-word-ai-run]")).length === 1, 3000);
    check("Pro: ログイン中は覚え方ボタンが出る", button);
    await page.click("[data-word-ai-run]");
    const told = await waitUntil(async () => (await text(page, "#wordAi")).includes("Pro について"), 3000);
    const ai = await text(page, "#wordAi");
    check("Pro: 429（upgrade）は API の message と「Pro について」", told && ai.includes("使い切った") && ai.includes("60回") && ai.includes("Pro について）"), ai);
    check("Pro: 「Pro について」は .ai-upgrade で pro.html へ", (await page.$$('#wordAi a.ai-upgrade[href="./pro.html"]')).length === 1);
    check("Pro: 上限の案内は端末に保存しない", (await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("spelldash_word_ai") || "{}")).length)) === 0);
    check("Pro: 覚え方の 429 でエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // 13. CRM: プラン列・Pro の絞り込み・CSV の plan 列
  {
    const EMI = "11111111-1111-4111-8111-111111111111";
    const fixturePlayers = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "admin-players.json"), "utf8")).players;
    const proIds = fixturePlayers.filter((p) => p.plan === "pro").map((p) => p.userId).sort();
    const page = await newPage({ viewport: { width: 1200, height: 900 }, storage: { spelldash_test_session: "test-token" } });
    await page.goto(BASE + "/admin.html", { waitUntil: "networkidle" });
    const rowIds = () => page.$$eval(".admin-row[data-user-id]", (rows) => rows.map((r) => r.dataset.userId));
    check("Pro: CRM の一覧が出る", await waitUntil(async () => (await rowIds()).length > 0, 6000));
    check("Pro: Emi の行に .admin-plan のチップ", (await page.$$(`.admin-row[data-user-id="${EMI}"] .admin-plan`)).length === 1);
    check("Pro: free の行にはチップが無い", (await page.$$(".admin-row[data-user-id] .admin-plan")).length === proIds.length, `chips=${(await page.$$(".admin-row[data-user-id] .admin-plan")).length} pro=${proIds.length}`);
    check("Pro: 要約行に「Pro」の人数", (await text(page, "#adminSummary")).includes(`Pro ${proIds.length}`), await text(page, "#adminSummary"));
    await page.click('.admin-chip[data-plan="pro"]');
    await page.waitForTimeout(200);
    const filtered = (await rowIds()).sort();
    check("Pro: 「Pro」チップで絞ると pro の人だけ", filtered.join(",") === proIds.join(","), filtered.join(","));
    await page.click('.admin-chip[data-plan="pro"]');
    await page.waitForTimeout(200);
    check("Pro: もう一度押すと全員に戻る", (await rowIds()).length === fixturePlayers.length);
    const header = await page.evaluate(async (players) => {
      const m = await import("/js/adminView.js");
      return m.buildCsv(players).replace(/^﻿/, "").split(/\r?\n/)[0].replace(/"/g, "");
    }, fixturePlayers);
    const cols = header.split(",");
    check("Pro: CSV の見出しに plan（level の直後）", cols.includes("plan") && cols[cols.indexOf("level") + 1] === "plan", header);
    check("Pro: CRM のプラン列でエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // 14. アプリ（Capacitor）: 購入ボタンと価格を出さず、状態だけ。390px で横スクロールしない
  {
    const NATIVE = () => {
      window.__native = [];
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => "ios", nativePromise: () => Promise.resolve({}) };
    };
    const page = await newPage({ mobile: true, viewport: { width: 390, height: 844 }, storage: { spelldash_test_session: "1" } });
    await page.addInitScript(NATIVE);
    await page.goto(BASE + "/pro.html", { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    check("Pro（アプリ）: 価格と CTA を出さず、#proState に Web 版の案内", !(await visible(page, "#proPlans")) && (await page.$("#proCheckoutMonth")) === null && (await text(page, "#proState")).includes("Web 版"), await text(page, "#proState"));
    check("Pro（アプリ）: エラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
    const page2 = await newPage({ mobile: true, viewport: { width: 390, height: 844 } });
    await page2.goto(BASE + "/pro.html", { waitUntil: "networkidle" });
    await waitUntil(async () => (await page2.$("#proLoginStart")) !== null, 5000); // 未ログインの CTA
    check("Pro（390px）: 横スクロールしない", await noHorizontalScroll(page2));
    await page2.goto(BASE + "/tokushoho.html", { waitUntil: "networkidle" });
    await page2.waitForTimeout(300);
    check("Pro（390px）: 特商法ページも横スクロールしない", await noHorizontalScroll(page2));
    await page2.close();
  }
}

// ===== チュートリアル（Batch 44／45）: 初回の 1 セットに 1 文ずつ（docs/SPEC_TUTORIAL.md） =====
console.log("tutorial:");
{
  const coach = async (p) => {
    const el = await p.$(".coach:not(.coach--out)");
    return el ? { step: await el.getAttribute("data-step"), text: (await el.textContent()).trim() } : null;
  };
  // 初回: ?set=3 で短いセット。T2（答えを見た）→ T3（自力正解）→ 完了 → 道に戻る → T4（道）
  const page = await newPage();
  await page.goto(BASE + "/index.html?set=3", { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await page.press("#input", "Enter");
  await page.waitForTimeout(300);
  check("チュートリアル: 1 語目には札を出さない（#word の案内だけ）", (await coach(page)) === null);
  await page.press("#input", "Enter"); // 答えを見る
  await page.waitForTimeout(300);
  const t2 = await coach(page);
  check("チュートリアル: 初めて答えを見たら T2（数問後にもう一度）", t2?.step === "T2" && t2.text.includes("もう一度"), JSON.stringify(t2));
  const knownT = new Map();
  let t3 = null;
  let panel = false;
  for (let i = 0; i < 80 && !panel; i++) {
    const ja = (await page.textContent("#japanese")).trim();
    const hidden = !/^[a-z]+$/.test((await page.textContent("#word")).trim());
    if (knownT.has(ja) && hidden) {
      for (const ch of knownT.get(ja)) await page.press("#input", ch);
    } else {
      if (hidden) {
        await page.press("#input", "Enter");
        await page.waitForTimeout(250);
      }
      const shown = (await page.textContent("#word")).trim();
      if (!/^[a-z]+$/.test(shown)) continue;
      knownT.set(ja, shown);
      for (const ch of shown) await page.press("#input", ch);
    }
    await page.waitForTimeout(350);
    const c = await coach(page);
    if (c?.step === "T3") t3 = c;
    panel = !(await page.$eval("#resultPanel", (el) => el.hidden));
  }
  check("チュートリアル: 初めて自力で思い出せたら T3（日をあけて）", t3 !== null && t3.text.includes("日をあけて"), JSON.stringify(t3));
  await page.waitForTimeout(1800);
  check("チュートリアル: 完了パネルには札を出さない", panel && (await coach(page)) === null);
  await page.click("#backToPath");
  await page.waitForTimeout(400);
  const t4 = await coach(page);
  check("チュートリアル: 道に戻ると T4（毎日スタート）＋「わかった」", t4?.step === "T4" && t4.text.includes("スタート") && (await page.$(".coach__ok")) !== null, JSON.stringify(t4));
  await page.click(".coach__ok");
  await page.waitForTimeout(250);
  check("チュートリアル: 「わかった」で閉じる", (await coach(page)) === null);
  const seenAll = await page.evaluate(() => JSON.parse(localStorage.getItem("spelldash_tutorial") || "{}").seen?.length);
  check("チュートリアル: 3 つとも seen に記録", seenAll === 3, String(seenAll));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  await page.press("#input", "Enter");
  await page.waitForTimeout(200);
  await page.press("#input", "Enter");
  await page.waitForTimeout(300);
  check("チュートリアル: 2 回目の訪問では答えを見ても出ない", (await coach(page)) === null);
  check("チュートリアルでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();

  // 設定の「チュートリアルをもう一度」→ 次のセットで T2 が戻る
  // newPage の seed は遷移ごとに入れ直されるので、チュートリアルの状態は seed せず「腕試し済み」だけ渡す（初期化で全部 seen になる）
  const page2 = await newPage({ storage: { spelldash_placement: "done" } });
  await page2.goto(BASE + "/profile.html", { waitUntil: "networkidle" });
  await page2.click("#tutorialReset");
  check("設定: 「チュートリアルをもう一度」で案内文", (await page2.textContent("#tutorialResetStatus")).includes("次のセット"));
  await page2.goto(BASE + "/index.html?set=3", { waitUntil: "networkidle" });
  await page2.waitForTimeout(500);
  await page2.press("#input", "Enter");
  await page2.waitForTimeout(200);
  await page2.press("#input", "Enter");
  await page2.waitForTimeout(300);
  check("設定: もう一度のあと、答えを見ると T2 が出る", (await coach(page2))?.step === "T2");
  await page2.close();

  // 既存ユーザー（学習記録あり）には出ない
  const page3 = await newPage({ storage: { spelldash_placement: "done", spelldash_word_stats: JSON.stringify({ "english-apple": { playCount: 3, correctCount: 2, missCount: 1, lastRecallSuccessAt: Date.now() } }) } });
  await page3.goto(BASE + "/index.html?set=3", { waitUntil: "networkidle" });
  await page3.waitForTimeout(500);
  await page3.press("#input", "Enter");
  await page3.waitForTimeout(200);
  await page3.press("#input", "Enter");
  await page3.waitForTimeout(300);
  check("チュートリアル: 学習記録のある人には出ない", (await coach(page3)) === null && (await page3.evaluate(() => JSON.parse(localStorage.getItem("spelldash_tutorial") || "{}").seen?.length)) === 3);
  await page3.close();
}

// ===== 20. Batch 48: 2 台目の端末（ログイン・同期・マージ） =====
// 上の createCloud が「クラウド」。端末の localStorage に spelldash_test_cloud（クラウドの id）を入れるとスタブがそこへ読み書きする。
// seed は 1 回だけ入れる（newPage と違い、再読み込みや同期の書き込みを seed で上書きしない）
console.log("sync (2nd device):");
{
  const SYNC_USER = "test-user";
  const todayY = ymd(new Date());
  const isoDaysAgo = (days, hour = 9) => { const d = new Date(); d.setDate(d.getDate() - days); d.setHours(hour, 0, 0, 0); return d.toISOString(); };
  const packRaw = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "packs", "jhs-english1.json"), "utf8"));
  const syncWords = (Array.isArray(packRaw) ? packRaw : packRaw.words).slice(0, 40);
  // 先頭 10 語は端末 A が今日のセットで思い出した語（今日の day 行 set=true と矛盾しないように）
  const wpRow = (w, i) => {
    const ago = i < 10 ? 0 : 1;
    // 「今日」の記録は 1 時間前。ただし日付が変わって 1 時間以内に走っても今日になるよう、今日の 0:01 より前にしない
    const at = i < 10 ? new Date(Math.max(Date.now() - 60 * 60 * 1000, new Date().setHours(0, 1, 0, 0))).toISOString() : isoDaysAgo(1);
    return {
      user_id: SYNC_USER, word_id: w.id, play_count: 2, correct_count: 2, typing_miss: 0, recall_fail: 0, clean_correct_streak: 2,
      mastered: i >= 10 && i < 15, mastered_at: i >= 10 && i < 15 ? isoDaysAgo(1) : null, last_played: at, next_review_at: isoDaysAgo(-3),
      last_recall_fail_at: null, last_recall_success_at: at, daily_learning_date: ymdDaysAgo(ago), daily_learning_stage: 0,
      srs_advanced_on: ymdDaysAgo(ago), updated_at: at
    };
  };
  const userProgress = (extra = {}) => ({
    user_id: SYNC_USER, xp: 5240, level: 12, streak: { last: todayY, current: 5, best: 5, shields: 0 }, best_score: 3,
    selected_category: "jhs-english2", selected_mode: "study", battle_rp: 0, battle_wins: 0, battle_losses: 0, battle_draws: 0,
    battle_current_win_streak: 0, battle_best_win_streak: 0, study_familiar_ratio: 80, updated_at: isoDaysAgo(0, 0), ...extra
  });
  const dayRow = (date, payload) => ({ user_id: SYNC_USER, kind: "day", key: date, payload, deleted: false, updated_at: isoDaysAgo(0, 0) });
  // 端末 A が送った体のクラウド: 語 40・現在地は中学英語 2年・今日のセット済み（day 行）・連続 5 日
  const cloudTablesA = () => ({
    word_progress: syncWords.map(wpRow),
    user_progress: [userProgress()],
    user_items: [
      ...[4, 3, 2, 1].map((d) => dayRow(ymdDaysAgo(d), { learned: 8 * (5 - d), mastered: 0, active: true, set: true, sets: 1 })),
      dayRow(todayY, { learned: 40, mastered: 5, active: true, set: true, sets: 1 })
    ]
  });
  const localStat = { playCount: 1, correctCount: 1, missCount: 0, recallFail: 0, typingMiss: 0, lastPlayed: isoDaysAgo(2), lastRecallSuccessAt: isoDaysAgo(2) };

  async function syncDevice(storage, { dialog = "dismiss" } = {}) {
    const page = await browser.newPage();
    page.errors = [];
    page.dialogs = [];
    page.on("pageerror", (e) => page.errors.push(e.message));
    page.on("dialog", async (d) => {
      page.dialogs.push(d.message());
      if (dialog === "accept") await d.accept(); else await d.dismiss();
    });
    await page.addInitScript((seed) => {
      if (sessionStorage.getItem("spelldash_test_seeded")) return;
      sessionStorage.setItem("spelldash_test_seeded", "1");
      localStorage.setItem("spelldash_schema_version", "6");
      for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v);
    }, storage);
    return page;
  }
  const ls = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);
  const lsJson = async (page, key) => JSON.parse((await ls(page, key)) || "null");
  const ss = (page, key) => page.evaluate((k) => sessionStorage.getItem(k), key);
  const txt = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent?.replace(/\s+/g, " ").trim() ?? "", sel);
  const visible = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); return !!el && !el.hidden && el.getClientRects().length > 0; }, sel);
  const ownerSet = (page, timeout = 10000) => waitUntil(async () => (await ls(page, "spelldash_owner")) === SYNC_USER, timeout);
  const hidePage = (page) => page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const login = (cloud, extra = {}) => ({ spelldash_test_session: "1", spelldash_test_cloud: cloud.id, ...extra });

  // (1) 空の端末にログインして開く: 語・現在地・今日のぶん・連続日数・解放が届き、トップページとチュートリアルは出ない
  {
    const cloud = createCloud(cloudTablesA());
    const page = await syncDevice(login(cloud)); // onboarded も無い、まっさらな端末
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    const synced = await ownerSet(page);
    await waitUntil(async () => (await txt(page, "#authMessage")) === "記録を同期した。", 7000);
    const stats = (await lsJson(page, "spelldash_word_stats")) || {};
    const ds = (await lsJson(page, "spelldash_daily_set")) || {};
    const gl = (await lsJson(page, "spelldash_growth_log")) || [];
    check("同期: 空の端末で取り込みが終わり、持ち主が付く", synced, String(await ls(page, "spelldash_owner")));
    check("同期: クラウドの語 40 が届く", Object.keys(stats).length === 40, String(Object.keys(stats).length));
    check("同期: 30 語以上が届いたら veteran=1", (await ls(page, "spelldash_veteran")) === "1", String(await ls(page, "spelldash_veteran")));
    check("同期: 現在地はクラウドの selected_category（中学英語 2年・jhs-redo）", (await ls(page, "spelldash_category")) === "jhs-english2" && (await ls(page, "spelldash_course")) === "jhs-redo", `${await ls(page, "spelldash_category")} / ${await ls(page, "spelldash_course")}`);
    const pathHead = `${await txt(page, ".path__kicker")} | ${await txt(page, ".path__title")}`;
    check("同期: 道が中学英語 2年になる（開き直さずに）", pathHead.includes("中学英語 2年") || pathHead.includes("セクション 2／"), pathHead);
    check("同期: day 行で今日のぶんが済み（history・setsToday）", ds.history?.includes(todayY) && ds.setsTodayDate === todayY && ds.setsToday >= 1, JSON.stringify({ last: ds.history?.at(-1), setsToday: ds.setsToday, setsTodayDate: ds.setsTodayDate }));
    check("同期: 成長ログが届く（過去の日・今日）", gl.some((e) => e.date === ymdDaysAgo(2)) && gl.some((e) => e.date === todayY), JSON.stringify(gl.map((e) => e.date)));
    const up = cloud.rows("user_progress")[0];
    check("同期: クラウドの user_progress を空の端末の値で上書きしない（xp・selected_category）", up.xp === 5240 && up.selected_category === "jhs-english2", JSON.stringify({ xp: up.xp, cat: up.selected_category }));
    check("同期: ローカルの XP はクラウドの値", (await ls(page, "spelldash_xp")) === "5240", String(await ls(page, "spelldash_xp")));
    check("同期: ログイン済みにはトップページを出さず道が見える", !(await visible(page, "#welcome")) && (await visible(page, "#pathCard")));
    check("同期: 「すでに使っている方はログイン」は hidden", await page.evaluate(() => document.getElementById("welcomeLogin")?.hidden === true));
    check("同期: 文「記録を同期した。」", (await txt(page, "#authMessage")) === "記録を同期した。", await txt(page, "#authMessage"));
    const header = await page.evaluate(() => { const el = document.getElementById("headerStreak"); return el ? { hidden: el.hidden, text: el.textContent.trim() } : null; });
    check("同期: ヘッダーの連続日数が開き直さずに出る", header && !header.hidden && header.text.includes("5"), JSON.stringify(header));
    check("同期: チップが「途中」でなく済み（day 行）", !(await txt(page, "#todayStrip")).includes("途中") && (await page.$("#todayStrip .strip__chip--on")) !== null, await txt(page, "#todayStrip"));
    check("同期: Daily／Battle に錠が無い（30 語以上が届いた）", (await page.$$(".play-modes__lock")).length === 0, await txt(page, "#playModes"));
    check("同期: チュートリアルは既存の人として済み", (await lsJson(page, "spelldash_tutorial"))?.setDone === true, String(await ls(page, "spelldash_tutorial")));
    check("同期: ログインの案内は空", (await txt(page, "#loginNudge")) === "", await txt(page, "#loginNudge"));
    check("同期: 覚えた単語カードは今日思い出した語があるので「今日はまだ。1セットで1語は増える」を出さない", !(await txt(page, "#learnedCard")).includes("今日はまだ。1セットで1語は増える"), await txt(page, "#learnedCard"));
    check("同期: 同じタブの 2 回目の initialSync は false", (await page.evaluate(async () => (await import("/js/sync.js")).initialSync())) === false);
    await page.click("#pathStart");
    await page.waitForTimeout(500);
    await page.press("#input", "Enter"); // 1 語目で答えを見る
    await page.waitForTimeout(500);
    check("同期: 1 語目で答えを見てもチュートリアルの札が出ない", !(await visible(page, "body > .coach:not(.coach--out)")), await txt(page, "body > .coach"));

    // (10) ログアウト → 文と同期済みの印 → 同じタブで再ログインすると、同期がもう一度走る
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    await page.click("#avatarButton");
    await page.click("#logoutButton");
    await waitUntil(async () => (await txt(page, "#authMessage")).startsWith("ログアウト"), 3000);
    check("ログアウト: 文「ログアウトした。記録はこの端末に残る。」", (await txt(page, "#authMessage")) === "ログアウトした。記録はこの端末に残る。", await txt(page, "#authMessage"));
    check("ログアウト: 同期済みの印（sessionStorage）が消える", (await ss(page, "spelldash_synced_this_session")) === null && (await ss(page, "spelldash_pulled_this_session")) === null);
    check("ログアウト: 記録はこの端末に残る", Object.keys((await lsJson(page, "spelldash_word_stats")) || {}).length >= 40, String(Object.keys((await lsJson(page, "spelldash_word_stats")) || {}).length)); // 上で 1 語目を出したぶん増えうる
    const mark = cloud.log.length;
    await page.evaluate(() => window.__stubAuth.signIn());
    const reselected = await waitUntil(async () => cloud.log.slice(mark).some((e) => e.table === "word_progress" && e.kind === "select"), 5000);
    check("再ログイン: 同じタブで word_progress の取り込みがもう一度走る", reselected, JSON.stringify(cloud.log.slice(mark).map((e) => `${e.table}.${e.kind}`)));
    await waitUntil(async () => (await ss(page, "spelldash_pulled_this_session")) === SYNC_USER, 5000);
    check("再ログイン: ログアウトの文が消える", (await txt(page, "#authMessage")) !== "ログアウトした。記録はこの端末に残る。", await txt(page, "#authMessage"));
    check("同期（空の端末・再ログイン）でエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // (1b) 取り込みに失敗（user_progress の select）: pagehide でも送らない・持ち主は付かない・空の端末には文
  {
    const cloud = createCloud(cloudTablesA(), { failSelect: { user_progress: "boom" } });
    const page = await syncDevice(login(cloud));
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const mark = cloud.log.length;
    await hidePage(page);
    await page.waitForTimeout(800);
    check("同期失敗: pagehide・visibilitychange でも user_progress と word_progress を送らない", cloud.writes("user_progress").length === 0 && cloud.writes("word_progress").length === 0, JSON.stringify(cloud.writes(null, mark).map((e) => e.table)));
    check("同期失敗: 持ち主は付かず、同期済みの印は戻る", (await ls(page, "spelldash_owner")) === null && (await ss(page, "spelldash_synced_this_session")) === null);
    check("同期失敗（空の端末）: 文「記録を取り込めなかった。開き直すともう一度試す。」", (await txt(page, "#authMessage")) === "記録を取り込めなかった。開き直すともう一度試す。", await txt(page, "#authMessage"));
    check("同期失敗（空の端末）: トップページは畳まれ、文が見える", !(await visible(page, "#welcome")) && (await visible(page, "#authMessage")));
    check("同期失敗でエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }
  {
    // 記録のある端末で word_progress の select に失敗: 何も言わない（記録はそのまま）
    const cloud = createCloud(cloudTablesA(), { failSelect: { word_progress: "boom" } });
    const page = await syncDevice(login(cloud, { spelldash_onboarded: "1", spelldash_placement: "done", spelldash_owner: SYNC_USER, spelldash_word_stats: JSON.stringify({ [syncWords[0].id]: localStat }) }));
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    check("同期失敗（記録のある端末）: #authMessage は空で記録はそのまま", (await txt(page, "#authMessage")) === "" && Object.keys((await lsJson(page, "spelldash_word_stats")) || {}).length === 1, await txt(page, "#authMessage"));
    await page.close();
  }

  // (2) 取り込み中（select を 3 秒遅らせる）に pagehide: user_progress を送らない。遅延が終われば同期は完了
  {
    const cloud = createCloud(cloudTablesA(), { delayMs: 3000 });
    const page = await syncDevice(login(cloud));
    await page.goto(BASE + "/index.html", { waitUntil: "load" });
    await page.waitForTimeout(700);
    await hidePage(page);
    await page.waitForTimeout(500);
    check("取り込み前の pagehide: user_progress.upsert が飛ばない", cloud.writes("user_progress").length === 0, JSON.stringify(cloud.writes().map((e) => e.table)));
    cloud.config.delayMs = 0;
    const done = await ownerSet(page, 12000);
    check("取り込み前の pagehide: 遅延が終われば同期が終わり、クラウドの xp は 5240 のまま", done && cloud.rows("user_progress")[0].xp === 5240, JSON.stringify({ done, xp: cloud.rows("user_progress")[0].xp }));
    await page.close();
  }

  // (3) 端末の持ち主が別人で記録がある: confirm が出る。キャンセル → 何も書かずログインをやめる／OK → 置き換え
  const otherSeed = (cloud) => login(cloud, {
    spelldash_onboarded: "1", spelldash_placement: "done", spelldash_owner: "other-user", spelldash_theme: "dark", spelldash_xp: "777",
    spelldash_word_stats: JSON.stringify({ "zzz-only-other": localStat }), spelldash_my_words: JSON.stringify([{ en: "othersword", ja: "他人の語" }])
  });
  {
    const cloud = createCloud(cloudTablesA());
    const page = await syncDevice(otherSeed(cloud), { dialog: "dismiss" });
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await waitUntil(async () => (await txt(page, "#authMessage")).startsWith("ログインをやめた"), 5000);
    check("持ち主が別人: confirm「この端末には別のアカウントの記録がある。…」が出る", page.dialogs.length >= 1 && page.dialogs[0] === "この端末には別のアカウントの記録がある。消して、このアカウントの記録に置き換える", JSON.stringify(page.dialogs));
    check("持ち主が別人・キャンセル: 記録（語・XP・マイ単語帳・持ち主）はそのまま", (await lsJson(page, "spelldash_word_stats"))?.["zzz-only-other"] && (await ls(page, "spelldash_xp")) === "777" && (await ls(page, "spelldash_owner")) === "other-user" && (await ls(page, "spelldash_my_words")).includes("othersword"));
    check("持ち主が別人・キャンセル: クラウドに書き込みが無い", cloud.writes().filter((e) => e.table !== "funnel_events").length === 0, JSON.stringify(cloud.writes().map((e) => e.table)));
    check("持ち主が別人・キャンセル: 文「ログインをやめた。記録はこの端末に残る。」", (await txt(page, "#authMessage")) === "ログインをやめた。記録はこの端末に残る。", await txt(page, "#authMessage"));
    check("持ち主が別人・キャンセル: ログアウトして未ログインの表示（#accountGuest）", (await ls(page, "spelldash_test_session")) === null && !(await page.$eval("#accountGuest", (el) => el.hidden)) && (await page.$eval("#accountUser", (el) => el.hidden)));
    check("持ち主が別人（キャンセル）でエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }
  {
    // 持ち主の印が無い端末（未ログインで使っていた）でいまログインした: 足すかをたずね、キャンセルならログインをやめる
    const cloud = createCloud(cloudTablesA());
    const page = await syncDevice({ spelldash_test_cloud: cloud.id, spelldash_onboarded: "1", spelldash_placement: "done", spelldash_xp: "500", spelldash_word_stats: JSON.stringify({ "zzz-offline": localStat }) }, { dialog: "dismiss" });
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await page.evaluate(() => window.__stubAuth.signIn());
    await waitUntil(async () => (await txt(page, "#authMessage")).startsWith("ログインをやめた"), 5000);
    check("持ち主なし・いまログイン: 「この端末の記録を、このアカウントの記録に足す。…」をたずね、キャンセルで何も書かない", page.dialogs[0]?.startsWith("この端末の記録を、このアカウントの記録に足す。") && cloud.writes().filter((e) => e.table !== "funnel_events").length === 0 && (await ls(page, "spelldash_xp")) === "500", JSON.stringify({ dialogs: page.dialogs, writes: cloud.writes().length }));
    await page.close();
  }
  {
    // 開いた時点ですでにログインしていた端末（この版より前から使っている人）にはたずねない
    const cloud = createCloud(cloudTablesA());
    const page = await syncDevice(login(cloud, { spelldash_onboarded: "1", spelldash_placement: "done", spelldash_word_stats: JSON.stringify({ "zzz-offline": localStat }) }), { dialog: "dismiss" });
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await ownerSet(page);
    check("持ち主なし・ログイン済みで開いた: たずねずに足す（持ち主が付く）", page.dialogs.length === 0 && Boolean((await lsJson(page, "spelldash_word_stats"))?.["zzz-offline"]), JSON.stringify(page.dialogs));
    await page.close();
  }
  {
    // 語は無くても XP・マイ単語帳がある端末も確かめる（前の人の記録を確認なしに混ぜない）
    const cloud = createCloud(cloudTablesA());
    const page = await syncDevice(login(cloud, { spelldash_onboarded: "1", spelldash_owner: "other-user", spelldash_xp: "800", spelldash_my_words: JSON.stringify([{ en: "othersword", ja: "他人の語" }]) }), { dialog: "dismiss" });
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await waitUntil(async () => (await txt(page, "#authMessage")).startsWith("ログインをやめた"), 5000);
    check("持ち主が別人（語なし・XP とマイ単語帳あり）: confirm が出て、キャンセルで何も書かない", page.dialogs.length >= 1 && cloud.writes().filter((e) => e.table !== "funnel_events").length === 0 && (await ls(page, "spelldash_xp")) === "800", JSON.stringify({ dialogs: page.dialogs.length, writes: cloud.writes().map((e) => e.table) }));
    await page.close();
  }
  {
    const cloud = createCloud(cloudTablesA());
    const page = await syncDevice(otherSeed(cloud), { dialog: "accept" });
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await ownerSet(page);
    const stats = (await lsJson(page, "spelldash_word_stats")) || {};
    const my = (await lsJson(page, "spelldash_my_words")) || [];
    check("持ち主が別人・OK: 他人の語とマイ単語帳が消え、クラウドの記録（40 語）に置き換わる", !stats["zzz-only-other"] && Object.keys(stats).length === 40 && !my.some((w) => w.en === "othersword"), JSON.stringify({ words: Object.keys(stats).length, my: my.map((w) => w.en) }));
    check("持ち主が別人・OK: 端末の設定（theme）は残る", (await ls(page, "spelldash_theme")) === "dark");
    check("持ち主が別人・OK: 他人の語・マイ単語をクラウドへ上げない", !cloud.rows("word_progress").some((r) => r.word_id === "zzz-only-other") && !cloud.rows("user_items").some((r) => r.key === "othersword"));
    check("持ち主が別人（OK）でエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // (5) XP の差分マージ: 基準 5100・この端末 5240・クラウド 5240 → 両方 5380
  {
    const cloud = createCloud({ word_progress: syncWords.map(wpRow), user_progress: [userProgress({ xp: 5240 })], user_items: [] });
    const page = await syncDevice(login(cloud, { spelldash_onboarded: "1", spelldash_placement: "done", spelldash_owner: SYNC_USER, spelldash_xp: "5240", spelldash_xp_synced: "5100", spelldash_word_stats: JSON.stringify({ [syncWords[0].id]: localStat }) }));
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await waitUntil(async () => (await ls(page, "spelldash_xp")) === "5380" && cloud.rows("user_progress")[0].xp === 5380, 8000);
    check("XP: 基準 5100・端末 5240・クラウド 5240 → ローカルもクラウドも 5380", (await ls(page, "spelldash_xp")) === "5380" && cloud.rows("user_progress")[0].xp === 5380 && (await ls(page, "spelldash_xp_synced")) === "5380", JSON.stringify({ local: await ls(page, "spelldash_xp"), cloud: cloud.rows("user_progress")[0].xp, synced: await ls(page, "spelldash_xp_synced") }));
    await page.close();
  }

  // (9 の補助) user_items の表が無い: 今日のぶんの済みは推測しない（連続日数は 1 語でも今日になるので「済み」と言わない）
  {
    const cloud = createCloud(cloudTablesA(), { failSelect: { user_items: "relation \"public.user_items\" does not exist" } });
    const page = await syncDevice(login(cloud));
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await ownerSet(page);
    const ds = (await lsJson(page, "spelldash_daily_set")) || {};
    check("表なし: streak.last が今日でも今日のぶんを済みにしない（history・setsToday・累計は増えない）", !ds.history?.includes(todayY) && !(ds.setsToday > 0) && (await ls(page, "spelldash_sets_total")) === null, JSON.stringify({ ds, total: await ls(page, "spelldash_sets_total") }));
    check("表なし: 学習記録の同期は終わる（語 40）", Object.keys((await lsJson(page, "spelldash_word_stats")) || {}).length === 40);
    await page.close();
  }

  // (9) 端末 A（持ち主なし・成長ログ 30 日）がログインして開く: day 行がクラウドへ上がる
  {
    const cloud = createCloud({});
    const growth = Array.from({ length: 30 }, (_, i) => ({ date: ymdDaysAgo(29 - i), learned: i + 1, mastered: Math.floor(i / 6), active: true, v: 2 }));
    const history = growth.map((e) => e.date);
    const statsA = Object.fromEntries(syncWords.slice(0, 30).map((w) => [w.id, localStat]));
    const page = await syncDevice(login(cloud, {
      spelldash_onboarded: "1", spelldash_placement: "done", spelldash_word_stats: JSON.stringify(statsA), spelldash_growth_log: JSON.stringify(growth),
      spelldash_daily_set: JSON.stringify({ history, last: { date: todayY, count: 15 }, setsToday: 1, setsTodayDate: todayY }),
      spelldash_streak: JSON.stringify({ last: todayY, current: 30, best: 30, shields: 0 }), spelldash_xp: "3000"
    }));
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await ownerSet(page);
    await waitUntil(async () => cloud.rows("user_items").filter((r) => r.kind === "day").length >= 25, 5000);
    const days = cloud.rows("user_items").filter((r) => r.kind === "day");
    const todayRow = days.find((r) => r.key === todayY);
    check("端末 A: 成長ログの日数ぶん day 行がクラウドへ上がる（約 30 件）", days.length >= 25 && days.length <= 31, String(days.length));
    check("端末 A: 今日の day 行は set=true・sets≥1", todayRow?.payload?.set === true && todayRow.payload.sets >= 1, JSON.stringify(todayRow?.payload));
    check("端末 A: クラウドの user_progress に端末の XP が上がる", cloud.rows("user_progress")[0]?.xp === 3000, JSON.stringify(cloud.rows("user_progress")[0]?.xp));
    check("端末 A（送信）でエラー0", page.errors.length === 0, page.errors[0] ?? "");

    // 別の端末が先に送った今日の行（2 セット目・語数）と XP（+200）を、開いたままのこのタブの送信が巻き戻さない
    const cloudToday = cloud.rows("user_items").find((r) => r.kind === "day" && r.key === todayY);
    cloudToday.payload = { ...cloudToday.payload, set: true, sets: 3, learned: 999 };
    cloud.rows("user_progress")[0].xp = 3200;
    await page.evaluate(async (today) => {
      localStorage.setItem("spelldash_xp", "3140"); // この端末で +140
      const items = await import("/js/userItemsSync.js");
      items.touchItem("day", today);
      const sync = await import("/js/sync.js");
      await sync.pushSync();
    }, todayY);
    const after = cloud.rows("user_items").find((r) => r.kind === "day" && r.key === todayY)?.payload;
    check("2 台で同じ日: 送る前にクラウドの行と合わせ、sets・語数を巻き戻さない", after?.sets === 3 && after?.learned === 999 && after?.set === true, JSON.stringify(after));
    check("2 台で同じ日: XP は両方の増分を足す（3000 → 3200 と 3140 → 3340）", cloud.rows("user_progress")[0]?.xp === 3340 && (await ls(page, "spelldash_xp")) === "3340", JSON.stringify({ cloud: cloud.rows("user_progress")[0]?.xp, local: await ls(page, "spelldash_xp") }));

    // 返事が届く前にページが閉じた書き込み（クラウドには届いている）: 次の送信で二重に足さない
    const landedAt = cloud.rows("user_progress")[0].updated_at;
    await page.evaluate(async (at) => {
      localStorage.setItem("spelldash_xp_synced", "3200"); // 返事を確かめる前の基準
      localStorage.setItem("spelldash_xp_write", JSON.stringify({ value: 3340, at }));
      const sync = await import("/js/sync.js");
      await sync.pushSync();
    }, landedAt);
    check("返事の届かなかった書き込み: 届いていれば基準にして、XP を二重に足さない（3340 のまま）", cloud.rows("user_progress")[0]?.xp === 3340 && (await ls(page, "spelldash_xp")) === "3340", JSON.stringify({ cloud: cloud.rows("user_progress")[0]?.xp, local: await ls(page, "spelldash_xp") }));
    await page.close();
  }

  // (8) 成長ログの無い端末の学習データ（クラウドに day 行なし）: 週間レポートは「–」・はちゃん無し・注記
  {
    const cloud = createCloud({ word_progress: syncWords.map(wpRow), user_progress: [userProgress()], user_items: [] });
    const page = await syncDevice(login(cloud));
    await page.goto(BASE + "/stats.html", { waitUntil: "networkidle" });
    await ownerSet(page);
    await waitUntil(async () => (await txt(page, "#weeklyReport")).includes("この端末での記録は明日から"), 5000);
    const weekly = await txt(page, "#weeklyReport");
    check("週間（成長ログなし）: 学習した日・7日で覚えた が「–」", /学習した日\s*–/.test(weekly) && /7日で\s*覚えた\s*–/.test(weekly), weekly);
    check("週間（成長ログなし）: 注記「この端末での記録は明日から」", weekly.includes("この端末での記録は明日から"), weekly);
    check("週間（成長ログなし）: はちゃんと「今週は休み」を出さない", !(await visible(page, "#weeklyReport .hasumi")) && !weekly.includes("今週は休み"), weekly);
    check("学習データ: 同期の文「記録を同期した。」", (await txt(page, "#authMessage")) === "記録を同期した。", await txt(page, "#authMessage"));
    check("学習データ（同期）でエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // 単語帳: クラウドのマイ単語 3 語が開き直さずに出る
  {
    const myItem = (en, ja, d) => ({ user_id: SYNC_USER, kind: "my_word", key: en, payload: { en, ja, addedAt: isoDaysAgo(d) }, deleted: false, updated_at: isoDaysAgo(d) });
    const cloud = createCloud({ word_progress: syncWords.map(wpRow), user_progress: [userProgress()], user_items: [myItem("negotiate", "交渉する", 5), myItem("invoice", "請求書", 4), myItem("deadline", "締め切り", 3)] });
    const page = await syncDevice(login(cloud));
    await page.goto(BASE + "/list.html#myWords", { waitUntil: "networkidle" });
    await ownerSet(page);
    await waitUntil(async () => (await txt(page, "#myWordCount")) === "3語", 5000);
    check("単語帳: 同期で届いたマイ単語 3 語が開き直さずに出る", (await txt(page, "#myWordCount")) === "3語", await txt(page, "#myWordCount"));
    check("単語帳（同期）でエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // ログイン欄の並び（未ログイン）: 利点の 1 文が Google の上、メール側は操作だけ。トップの「すでに使っている方はログイン」は見える
  {
    const page = await newPage({ keepOnboarding: true });
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    const order = await page.evaluate(() => [...document.querySelectorAll("#accountLogin > *")].map((el) => el.id || el.textContent.replace(/\s+/g, " ").trim()));
    check("ログイン欄: 2 番目が「記録を別の端末でも。」、3 番目が Google", order[1] === "記録を別の端末でも。" && order[2] === "googleLoginButton", order.join(" | "));
    check("ログイン欄: メール側は「メールにログインリンクを送る」", order.includes("メールにログインリンクを送る"), order.join(" | "));
    check("未ログイン: トップページに「すでに使っている方はログイン」が見える", (await visible(page, "#welcome")) && (await visible(page, "#welcomeLogin")));
    await page.close();
  }
}


// ===== 21. Pro までの動線の計測（funnel_events。docs/SQL_FUNNEL.md） =====
console.log("funnel log:");
{
  const cloud = createCloud({});
  const steps = (step) => cloud.rows("funnel_events").filter((r) => r.step === step);
  const page = await newPage({ storage: { spelldash_test_cloud: cloud.id } });
  await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  const first = await waitUntil(async () => steps("first_visit").length === 1, 5000);
  const row = steps("first_visit")[0] ?? {};
  check("計測: 初めて来た端末で first_visit（端末の番号だけ・未ログインは user_id 空）", first && typeof row.device_id === "string" && row.device_id.length >= 8 && row.user_id == null && !("email" in row), JSON.stringify(row));
  await waitUntil(async () => (await page.$(".site-footer__nav [data-footer-pro]")) !== null, 5000);
  await page.click(".site-footer__nav [data-footer-pro]");
  await page.waitForURL(/pro\.html/, { timeout: 5000 }).catch(() => {});
  const entered = await waitUntil(async () => steps("entry").some((r) => r.source === "footer"), 5000);
  check("計測: フッターから加入画面へ → entry（入口 footer）が次のページで届く", entered, JSON.stringify(cloud.rows("funnel_events").map((r) => `${r.step}:${r.source}`)));
  check("計測: 加入画面を開いた → pro_view", await waitUntil(async () => steps("pro_view").length === 1, 5000));
  await waitUntil(async () => (await page.$("#proLoginStart")) !== null, 5000);
  await page.click("#proLoginStart");
  check("計測: 「ログインして始める」→ login_click", await waitUntil(async () => steps("login_click").length === 1, 5000));
  await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  check("計測: 同じ端末の first_visit は 1 回きり（開き直しても増えない）", steps("first_visit").length === 1, String(steps("first_visit").length));
  check("計測でエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();

  // 本当に初めてのブラウザ（保存形式の移行が spelldash_word_stats に "{}" を書く）でも first_visit を数える
  {
    const fresh = await browser.newPage();
    fresh.errors = [];
    fresh.on("pageerror", (e) => fresh.errors.push(e.message));
    await fresh.addInitScript((id) => { if (!localStorage.getItem("spelldash_test_cloud")) localStorage.setItem("spelldash_test_cloud", id); }, cloud.id);
    const before = steps("first_visit").length;
    await fresh.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    const counted = await waitUntil(async () => steps("first_visit").length === before + 1, 5000);
    check("計測: 保存形式の移行が走る本当に初めてのブラウザでも first_visit", counted && (await fresh.evaluate(() => localStorage.getItem("spelldash_funnel_first"))) === null, String(steps("first_visit").length - before));
    await fresh.close();
  }

  // ログイン済み free: 月額で支払いへ進む → checkout_start（入口 month）、戻って反映 → checkout_done（本人の user_id 付き）
  const buyer = await newPage({ storage: { spelldash_test_cloud: cloud.id, spelldash_test_session: "1" } });
  await buyer.goto(BASE + "/pro.html", { waitUntil: "networkidle" });
  await waitUntil(async () => (await buyer.$("#proCheckoutMonth")) !== null, 5000);
  await buyer.evaluate(() => localStorage.setItem("spelldash_test_plan", JSON.stringify({ status: "active", plan_interval: "month", current_period_end: new Date(Date.now() + 20 * 86400000).toISOString(), cancel_at_period_end: false })));
  await buyer.click("#proCheckoutMonth");
  const started = await waitUntil(async () => steps("checkout_start").some((r) => r.source === "month" && r.user_id), 5000);
  check("計測: 支払いへ進む → checkout_start（month・ログイン中は user_id 付き）", started, JSON.stringify(steps("checkout_start")));
  check("計測: 加入して戻る → checkout_done", await waitUntil(async () => steps("checkout_done").length === 1, 10000), JSON.stringify(steps("checkout_done")));
  check("計測（加入）でエラー0", buyer.errors.length === 0, buyer.errors[0] ?? "");
  await buyer.close();
}

await browser.close();
server.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
