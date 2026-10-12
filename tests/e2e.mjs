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
import { canonicalRomaji, readingEntries, primaryReading, matchRomaji } from "../js/romaji.js";
import { FEEDBACK_MS, ADVANCE_GUARD_MS, ECHO_AFTER_DONE_MS, GLANCE_MS, MILESTONE_MS, waitAfterCorrect } from "../js/afterCorrect.js";
import { shelfIdOf } from "../js/shelves.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const STUB = path.join(ROOT, "tests", "mocks", "supabase-stub.js");

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2", ".webp": "image/webp", ".svg": "image/svg+xml"
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
      return json(200, { configured: true, prices: [{ interval: "month", amount: 580, currency: "jpy" }, { interval: "year", amount: 4800, currency: "jpy" }], trialDays: 0, trialMonths: fakeTrialMonths, ...(fakeTrialMonths ? { trialEndsAt: "2026-11-07T03:00:00.000Z" } : {}) });
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

// 次の語が出てから、答え表示の Enter を受け付けるまで（js/afterCorrect.js）。守りは 2 つ:
// 次の語が出てから 300ms と、タイマーで進んだときは前の語を打ち終えてから 1,200ms。待ちは 250ms 以上なので、出てから 1,030ms で両方の外
const afterAdvance = (page) => page.waitForTimeout(Math.max(ADVANCE_GUARD_MS, ECHO_AFTER_DONE_MS - FEEDBACK_MS) + 80);
// 打ち終えてから、次の語の Enter（答え表示）を押してよいまで（打ち終えてからの守り 1,200＋余裕 100）
const NEXT_READY_MS = Math.max(FEEDBACK_MS + ADVANCE_GUARD_MS, ECHO_AFTER_DONE_MS) + 100;

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
  // theme-color（ヘッダーの帯の色）の表は js/appEnv.js THEME_COLOR が元で、各ページの <head> のインラインの表・meta・manifest に手で写してある: ずれを見張る
  const THEME_TABLE = '{ light: "#1A2137", dark: "#04060B", paper: "#20243A", indigo: "#03050C" }';
  const themeBad = htmlFiles.filter((f) => {
    const html = fs.readFileSync(path.join(ROOT, f), "utf8");
    return !html.includes(THEME_TABLE) || !html.includes('<meta name="theme-color" content="#1A2137" />');
  });
  check("全ページの <head> の theme-color の表と meta は js/appEnv.js THEME_COLOR と同じ（帯の色）", themeBad.length === 0 && fs.readFileSync(path.join(ROOT, "js", "appEnv.js"), "utf8").includes(`THEME_COLOR = ${THEME_TABLE}`), themeBad.slice(0, 3).join(" | "));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.webmanifest"), "utf8"));
  check("manifest.webmanifest の theme_color は帯の色（light）、background_color は紙", manifest.theme_color === "#1A2137" && manifest.background_color === "#F4ECDA", `${manifest.theme_color} ${manifest.background_color}`);
}

console.log("pages:");
for (const p of ["/index.html", "/battle.html", "/stats.html", "/profile.html", "/privacy.html", "/news.html", "/list.html", "/pro.html", "/tokushoho.html", "/terms.html", "/typing.html", "/typing-game.html"]) {
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
  await page.waitForTimeout(NEXT_READY_MS); // 答えを見た後の正解は 0.25 秒で次へ。次の語の答え表示の Enter は守り（0.3 秒）の後に
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
    await afterAdvance(page);
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
  check("はちゃんのホーム一言表示（窓の脇の紙片に 1 文）", (await page.isVisible("#hasumiHome .hasumi__bubble")) && ((await page.textContent("#hasumiHome .hasumi__bubble")) ?? "").trim().length > 0);
  // はちゃん本人は部屋の絵（焼いた WebP。scripts/room-art/render.mjs）の中。表示中の場面の背景画像が読めていて 60KB 以下
  const scene = await page.evaluate(async () => {
    const el = [...document.querySelectorAll(".room__scene")].find((e) => getComputedStyle(e).display !== "none");
    const url = el && getComputedStyle(el).backgroundImage.match(/url\("?([^")]+)"?\)/)?.[1];
    if (!url) return { ok: false };
    const res = await fetch(url);
    return { ok: res.ok, bytes: (await res.arrayBuffer()).byteLength, url: url.split("/").pop() };
  });
  check("はちゃんは部屋の絵の中（表示中の場面の WebP が読めて 60KB 以下）", scene.ok && scene.bytes > 0 && scene.bytes <= 60 * 1024, JSON.stringify(scene));
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

// ===== 7.5 タイピング練習（/typing.html。docs/SPEC_TYPING.md。Batch 59）: 教材・判定・数え方・自己ベスト（Node）／1200 の 1 枚を使い回す（?t=5）／
// タッチ端末 390 の 1 枚（?t=3）／375×560／静的。学習記録は変えない・Pro とはちゃんを出さない・要求は同一オリジン =====
console.log("typing:");
{
  const T = await import("../js/typingDrill.js");
  const B = await import("../scripts/build-typing.mjs");

  // ---- Node だけで見るもの ----
  const built = B.buildTypingData();
  check("typing: 教材は生成物と同じ（node scripts/build-typing.mjs）", built.text === fs.readFileSync(path.join(ROOT, "data", "typing.json"), "utf8"));
  const typingJson = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "typing.json"), "utf8"));
  const enWords = typingJson.en.map((p) => p[0]);
  const badEn = [
    ...typingJson.en.filter(([w, j]) => !/^[a-z]{3,8}$/.test(w) || typeof j !== "string" || j.trim() === "" || [...j].length > 12 || j.includes("略")).map((p) => p.join("=")),
    ...enWords.filter((w, i) => enWords.indexOf(w) !== i).map((w) => `重複 ${w}`),
    ...["exact", "rank", "banner", "haughty"].filter((w) => enWords.includes(w)),
    ...B.validateTypingData(typingJson).filter((s) => s.startsWith("en:"))
  ];
  check(`typing: 英単語は a〜z の 3〜8 字・重複なし・訳は 12 字以下で略語なし・広告と英検準1級／1級・TOEIC 860／990 の群だけの語なし（900 語以上。${typingJson.en.length} 語）`, typingJson.en.length >= 900 && badEn.length === 0, badEn.slice(0, 5).join(" "));
  const badJa = typingJson.ja.filter(([answer, reading]) => {
    const keys = canonicalRomaji(reading, { finalN: true });
    const m = keys ? matchRomaji([{ reading, display: reading }], keys) : null;
    const kana = [...String(reading).normalize("NFKC")].length;
    return !m || m.missAt !== -1 || !m.done || /^[ぁ-ゖァ-ヶー・＝]+$/.test(answer) || !/^[ぁ-ゖァ-ヶー]+$/.test(reading) || kana < 3 || kana > 10;
  });
  check(`typing: 日本語は 3〜10 かなの読みで、標準の綴りで打ち終えられ、答えがかなだけの語なし（600 語以上。${typingJson.ja.length} 語）`, typingJson.ja.length >= 600 && badJa.length === 0, badJa.slice(0, 5).map((p) => p.join("=")).join(" "));
  check("typing: 時間は ?t= の 1〜60 だけ（ほかは 60 秒）", T.secondsFrom("?t=3") === 3 && T.secondsFrom("?t=60") === 60 && T.secondsFrom("?t=1") === 1 && ["", "?t=0", "?t=90", "?t=abc", "?t=2.5", "?t=-3"].every((s) => T.secondsFrom(s) === 60));
  {
    const s = T.summarize({ correct: 5, miss: 2, missKeys: new Map([["p", 1], ["l", 1]]) }, 5);
    const zero = T.summarize({ correct: 0, miss: 0, missKeys: new Map() }, 60);
    const ties = T.summarize({ correct: 10, miss: 8, missKeys: new Map([["b", 2], ["d", 3], ["a", 2], ["c", 1]]) }, 60);
    check("typing: 打/分・正確さ・間違えたキーの数え方", s.kpm === 60 && s.accuracy === 71 && JSON.stringify(s.topKeys) === '[["l",1],["p",1]]' && zero.accuracy === null && zero.kpm === 0 && JSON.stringify(ties.topKeys) === '[["d",3],["a",2],["b",2]]' && ties.kpm === 10 && ties.accuracy === 55, JSON.stringify({ s, zero, ties }));
  }
  {
    const shin = T.createWord("ja", ["新聞", "しんぶん"]);
    shin.feed("s");
    shin.feed("i");
    const gak = T.createWord("ja", ["学校", "がっこう"]);
    for (const k of "gak") gak.feed(k);
    const units = gak.view().units;
    const tsu = units.find((u) => u.kana === "っこ");
    check("typing: 日本語の手本は綴りに合わせて替わる（し を si で打つと残りは nnbun、がっこう を gak まで打つと っこ の単位が k＋ko）", shin.rest() === "nnbun" && shin.view().units[0].kana === "し" && shin.view().units[0].state === "done" && tsu?.state === "now" && tsu?.typed === "k" && tsu?.rest === "ko", JSON.stringify({ shin: shin.view(), gak: units }));
    // っ を子音の重ねで打った直後（gakk）: 済みの っ と今の単位の「っこ」で っ が 2 つ出ていた。663 語を手本どおりに打ち、毎打鍵でかなをつなぐと読みと同じ
    const gakk = T.createWord("ja", ["学校", "がっこう"]);
    for (const k of "gakk") gakk.feed(k);
    const gu = gakk.view().units;
    const now = gu.find((u) => u.state === "now");
    const drift = [];
    for (const [term, reading] of typingJson.ja) {
      const w = T.createWord("ja", [term, reading]);
      for (let g = 0; g < 40 && !w.matcher.state().done; g++) {
        const v = w.view();
        const kana = v.units.map((u) => u.kana).join("");
        if (kana !== reading) { drift.push(`${reading}:${w.matcher.keys}→${kana}`); break; }
        w.feed(v.rest[0]);
      }
    }
    check("typing: 日本語のかなの行は打っている途中も読みと同じ（がっこう を gakk で「が っ こ う」・今の単位は こ の k＋o。663 語を手本どおり）", gu.map((u) => u.kana).join("") === "がっこう" && now?.kana === "こ" && now?.typed === "k" && now?.rest === "o" && drift.length === 0, JSON.stringify({ gakk: gu, drift: drift.slice(0, 5), driftCount: drift.length }));
  }
  {
    const feed = (pairs, keys) => {
      const r = T.createRun("ja", pairs);
      let t = 0;
      for (const k of keys) r.press(k, (t += 100));
      return r.stats;
    };
    const a = feed([["県", "けん"], ["柿", "かき"]], "kenkaki");
    const b = feed([["県", "けん"], ["柿", "かき"]], "kennkaki");
    const c = feed([["県", "けん"], ["虹", "にじ"]], "kenniji");
    const en = T.createRun("en", [["apple", "りんご"]]);
    en.press("a", 0);
    en.press("x", 1);
    const m1 = en.missPending;
    en.press("z", 2);
    const m2 = en.missPending;
    en.press("p", 3);
    const m3 = en.missPending;
    check("typing: 語末の ん（手本どおり n 1 つ・nn どちらでも次の語に進み、次の語の 1 打目を飲まない）／ミスの印は正しいキーまで残る", [a, b, c].every((s) => s.miss === 0 && s.words === 2) && m1 && m2 && !m3, JSON.stringify({ a, b, c, m1, m2, m3 }));
  }
  {
    const fake = (init = {}) => {
      const map = new Map(Object.entries(init));
      return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), map };
    };
    const cmp = [T.compareBest(null, 0), T.compareBest(null, 5), T.compareBest({ kpm: 100 }, 120), T.compareBest({ kpm: 100 }, 100), T.compareBest({ kpm: 100 }, 40)];
    const s1 = fake();
    const w1 = T.writeBest(s1, "en", 3, { kpm: 600, acc: 90, day: "2026-10-09" });
    const s2 = fake({ [T.BEST_KEY]: JSON.stringify({ v: 1, best: { ja: { 60: { kpm: 77, acc: 90, day: "2026-10-01" } } } }) });
    T.writeBest(s2, "en", 60, { kpm: 50, acc: 80, day: "2026-10-09" });
    const both = T.readBest(s2, 60);
    const broken = T.readBest(fake({ [T.BEST_KEY]: "{oops" }), 60);
    const huge = T.readBest(fake({ [T.BEST_KEY]: JSON.stringify({ v: 1, best: { en: { 60: { kpm: 1e300 } }, ja: { 60: { kpm: 100.7 } } } }) }), 60);
    const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    const ok = cmp[0].status === "none" && cmp[1].status === "first" && cmp[2].status === "new" && cmp[2].prev === 100 && cmp[3].status === "same" && cmp[4].status === "below" && cmp[4].diff === 60 &&
      w1 && T.readBest(s1, 60).en === null && T.readBest(s1, 3).en?.kpm === 600 &&
      both.ja?.kpm === 77 && both.en?.kpm === 50 &&
      broken.en === null && broken.ja === null && huge.en === null && huge.ja === null &&
      T.readBest(throwing, 60).en === null && T.readBest(throwing, 60).ja === null && T.writeBest(throwing, "en", 60, { kpm: 1 }) === false;
    check("typing: 自己ベストは種類・秒数ごと、書く直前に読み直す、壊れた値（桁外れ・小数の打/分を含む）・投げる storage でも落ちない", ok, JSON.stringify({ cmp, both, broken, huge }));
    // 2 枚のページで共通の小さな関数（タイピングゲームの ?t=・?s=・自己ベストもこれを使う）: 鍵と記録の検証は呼ぶ側
    const ints = [T.intParam("?s=7", "s", 1, 9), T.intParam("?s=0", "s", 1, 9), T.intParam("?s=07", "s", 1, 9), T.intParam("?s=123", "s", 1, 99), T.intParam("?s=2.5", "s", 1, 9), T.intParam("", "s", 1, 9)];
    const sx = fake({ other: "keep", k: JSON.stringify({ v: 1, best: { a: { 5: { n: 1 } }, b: { 9: { n: 2 } } } }) });
    const wx = T.writeBestRecord(sx, "k", "a", 9, { n: 3 });
    const valid = (r) => (r && Number.isInteger(r.n) ? { n: r.n } : null);
    const rx = [T.readBestRecord(sx, "k", "a", 5, valid)?.n, T.readBestRecord(sx, "k", "a", 9, valid)?.n, T.readBestRecord(sx, "k", "b", 9, valid)?.n, T.readBestRecord(sx, "k", "c", 9, valid), T.readBestRecord(fake({ k: "[1]" }), "k", "a", 5, valid), T.readBestRecord(throwing, "k", "a", 5, valid)];
    check("typing: 共通の関数 — intParam は 1〜2 桁の整数で範囲の中だけ、readBestRecord／writeBestRecord は best[種類][秒数] だけを読み書きし（ほかの鍵・種類・秒数を残す）、壊れた値・投げる storage は null／false", JSON.stringify(ints) === "[7,null,7,null,null,null]" && wx && JSON.stringify(rx) === "[1,3,2,null,null,null]" && sx.map.get("other") === "keep" && T.writeBestRecord(throwing, "k", "a", 5, { n: 1 }) === false && T.writeBestRecord(null, "k", "a", 5, { n: 1 }) === false, JSON.stringify({ ints, rx, stored: sx.map.get("k") }));
  }

  // ---- 1200 × 900 の 1 枚を使い回す（学習データと受付中の印を入れ、reduced motion。要求と pageerror を最初から記録） ----
  const LEARNING = {
    spelldash_word_stats: JSON.stringify({ apple: { attempts: 3, correct: 2, misses: 1, lastSeen: "2026-10-01" } }),
    spelldash_typing_stats: JSON.stringify({ sessions: 2, keys: 120 }),
    spelldash_xp: "120",
    spelldash_streak: JSON.stringify({ current: 0, best: 3, last: "2026-09-01" }),
    spelldash_key_miss: JSON.stringify({ l: 3 }),
    spelldash_billing_open: JSON.stringify({ open: true, at: Date.now() })
  };
  const snapshot = (page) => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith("spelldash_")).sort().map((k) => [k, localStorage.getItem(k)])));
  const state = (page) => page.evaluate(() => {
    const board = document.getElementById("typingBoard");
    const word = document.getElementById("typingWord");
    return {
      state: board.dataset.state, kind: board.dataset.kind, rest: word.dataset.rest, miss: word.classList.contains("tp-miss"),
      next: document.querySelector("#typingNext b")?.textContent ?? "", nextHidden: document.getElementById("typingNext").hidden,
      timer: document.getElementById("typingTimer").textContent, resultHidden: document.getElementById("typingResult").hidden,
      term: document.getElementById("typingTerm").textContent,
      scroll: document.documentElement.scrollWidth, inner: window.innerWidth
    };
  });
  // 動く物: 落ち着くまで（0 になるか 0.5 秒）フレームごとに数え、最後の一覧を返す。game.css の reduced motion は transition を
  // 0.01ms に縮めるだけで消さない（transition-property の初期値 all と合わさり、描き替えの直後は 0.01ms の transition が数に入る。
  // 負荷のある CI では 2 フレーム後にも残ることがあった）。0.5 秒たっても残る動き（止まらない animation など）は落とす
  const motion = (page) => page.evaluate(() => new Promise((resolve) => {
    const t0 = performance.now();
    const names = () => document.getAnimations().map((a) => { const t = a.effect?.target; return t ? `${t.tagName.toLowerCase()}${t.id ? "#" + t.id : ""}.${[...t.classList].join(".")}` : "?"; });
    const step = () => { const list = names(); if (list.length === 0 || performance.now() - t0 > 500) resolve(list); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }));
  const bestStored = (page) => page.evaluate(() => { try { return JSON.parse(localStorage.getItem("spelldash_typing_practice")); } catch { return null; } });
  const waitState = (page, s, timeout = 8000) => waitUntil(async () => (await state(page)).state === s, timeout);
  const anims = [];

  const page = await newPage({ viewport: { width: 1200, height: 900 }, storage: LEARNING });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const hosts = new Set();
  let dataRequests = 0;
  page.on("request", (req) => {
    const u = new URL(req.url());
    hosts.add(u.host);
    if (u.pathname === "/data/typing.json") dataRequests++;
  });
  await page.goto(BASE + "/typing.html?t=5", { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const before = await snapshot(page);
  const s9 = await state(page);
  anims.push(["ready", await motion(page)]);
  const open = await page.evaluate(() => ({
    gloss: document.getElementById("typingGloss").textContent,
    hint: !document.getElementById("typingHint").hidden && document.getElementById("typingHint").textContent,
    enPressed: document.querySelector('.tp-tabs [data-kind="en"]').getAttribute("aria-pressed"),
    active: document.activeElement?.id,
    headerCurrent: document.querySelectorAll(".site-nav [aria-current]").length,
    footerCurrent: document.querySelector('.site-footer__nav a[aria-current="page"]')?.textContent.trim(),
    mincho700: [...document.fonts].filter((f) => f.status === "loaded" && /Shippori/.test(f.family) && String(f.weight) === "700").length,
    h1: getComputedStyle(document.querySelector("h1")).fontWeight,
    footerPro: document.querySelectorAll(".site-footer__nav [data-footer-pro]").length,
    noteOff: document.getElementById("typingTabNote").classList.contains("tp-tabnote--off"),
    boardTop: Math.round(document.getElementById("typingBoard").getBoundingClientRect().top + window.scrollY),
    mainText: document.querySelector("main").textContent
  }));

  // T10: 1 続きで送る
  await page.keyboard.press("a");
  const s10a = await state(page);
  anims.push(["running", await motion(page)]);
  await page.keyboard.press("x");
  const s10x = await state(page);
  const missMark = await page.evaluate(() => getComputedStyle(document.querySelector("#typingWord .tp-now")).textDecorationStyle);
  await page.keyboard.press(" ");
  await page.keyboard.press("p");
  const s10p = await state(page);
  const upcoming = s10p.next;
  // IME オンの Process（code で読む）・JIS かな配列（key がかな）・変換中（isComposing）の打鍵も 1 打として数える
  const imeKey = (init) => page.evaluate((o) => document.getElementById("input").dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...o })), init);
  await imeKey({ key: "せ", code: "KeyP" });
  for (const k of ["Backspace", "z", "Shift", "Enter"]) await page.keyboard.press(k);
  await imeKey({ key: "Process", code: "KeyL", keyCode: 229 });
  await imeKey({ key: "Process", code: "KeyE", keyCode: 229, isComposing: true });
  const s10e = await state(page);
  check("typing: 最初の 1 打で始まり、ミスでは進まず印（朱の波線）が残る／Space・Backspace・Shift・Enter は数えない／IME オン・かな配列・変換中のキーも 1 打／語を打ち終えたら次の語へ", s10a.state === "running" && s10a.rest === "pple" && s10x.rest === "pple" && s10x.miss && missMark === "wavy" && !s10p.miss && s10p.rest === "ple" && upcoming !== "" && s10e.rest === upcoming, JSON.stringify({ s10a, s10x, missMark, s10p, s10e }));

  // T11: 結果
  await waitState(page, "result");
  await page.keyboard.press("Enter"); // 守りの中: やり直さない
  const r11 = await page.evaluate(() => ({
    state: document.getElementById("typingBoard").dataset.state,
    kpm: document.getElementById("typingKpm").textContent,
    acc: document.getElementById("typingAcc").textContent,
    keys: [...document.querySelectorAll("#typingKeys .tp-key")].map((k) => `${k.textContent} ${k.nextElementSibling?.textContent}`),
    keysText: document.getElementById("typingKeys").textContent,
    keysHidden: document.getElementById("typingKeys").hidden,
    live: document.getElementById("typingLive").textContent,
    active: document.activeElement?.id,
    best: document.getElementById("typingBest").hidden ? "" : document.getElementById("typingBest").textContent,
    kind: document.getElementById("typingKind").textContent,
    lining: [...document.querySelectorAll("#typingKpm, #typingAcc b, #typingKeys b")].every((b) => getComputedStyle(b).fontVariantNumeric.includes("lining-nums"))
  }));
  anims.push(["result", await motion(page)]);
  const stored1 = await bestStored(page);
  await page.waitForTimeout(700);
  await page.keyboard.press("Enter");
  const s11 = await state(page);
  check("typing: 結果は 60 打/分・正確さ 71%・ミス 2・間違えたキー l 1 p 1（数は lining）、読み上げの 1 文、直後の Enter ではやり直さず 0.7 秒後の Enter でもう一度", r11.state === "result" && r11.kpm === "60" && r11.acc.includes("正確さ 71%") && r11.acc.includes("ミス 2") && r11.keysText.startsWith("間違えたキー") && !r11.keysHidden && JSON.stringify(r11.keys) === '["l 1","p 1"]' && r11.live === "60 打/分。正確さ 71%、ミス 2。" && r11.active === "typingKpmLine" && r11.kind === "英単語・5秒" && r11.lining && s11.state === "ready" && s11.resultHidden, JSON.stringify({ r11, s11 }));

  // T12: 自己ベストは秒数ごと
  await page.keyboard.type(s11.rest.slice(0, 2));
  await waitState(page, "result");
  const best2 = await page.evaluate(() => (document.getElementById("typingBest").hidden ? "" : document.getElementById("typingBest").textContent));
  const stored2 = await bestStored(page);
  check("typing: 自己ベストは秒数ごとに端末へ（はじめての記録 → 次の回は「あと N」で保存値は変わらない）", r11.best.includes("はじめての記録") && stored1?.best?.en?.["5"]?.kpm === 60 && stored1?.best?.en?.["60"] === undefined && best2.includes("自己ベスト 60（あと 36）") && stored2?.best?.en?.["5"]?.kpm === 60, JSON.stringify({ best1: r11.best, stored1, best2, stored2 }));

  // T13: Esc・ページを離れた・タブの上の Space
  await page.waitForTimeout(700);
  await page.keyboard.press("Escape");
  let s13 = await state(page);
  await page.keyboard.press(s13.rest[0]);
  await page.focus('.tp-tabs [data-kind="ja"]');
  await page.keyboard.press(" ");
  const s13space = await state(page);
  await page.keyboard.press("Escape");
  const s13esc = await state(page);
  await page.keyboard.press(s13esc.rest[0]);
  const s13run = await state(page);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const s13hidden = await state(page);
  await page.evaluate(() => {
    delete document.visibilityState;
    delete document.hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const stored3 = await bestStored(page);
  check("typing: Esc とページを離れたときは始まる前に戻り、結果もベストも出ない／打っている間、焦点がタブにあっても Space で回は消えない", s13space.state === "running" && s13space.kind === "en" && s13esc.state === "ready" && s13esc.timer === "残り 5秒" && s13esc.resultHidden && s13run.state === "running" && s13hidden.state === "ready" && s13hidden.resultHidden && JSON.stringify(stored3) === JSON.stringify(stored2), JSON.stringify({ s13space, s13esc, s13hidden, stored3 }));

  // T14: 日本語
  await page.click('.tp-tabs [data-kind="ja"]');
  await waitState(page, "ready", 3000);
  const ja0 = await page.evaluate(() => ({
    kind: document.getElementById("typingBoard").dataset.kind,
    note: !document.getElementById("typingTabNote").hidden && !document.getElementById("typingTabNote").classList.contains("tp-tabnote--off"),
    boardTop: Math.round(document.getElementById("typingBoard").getBoundingClientRect().top + window.scrollY),
    unitMin: getComputedStyle(document.querySelector("#typingWord .tp-unit")).minWidth,
    term: document.getElementById("typingTerm").textContent,
    termHidden: document.getElementById("typingTerm").hidden,
    gloss: document.getElementById("typingGloss").textContent,
    units: document.querySelectorAll("#typingWord .tp-unit").length,
    rest: document.getElementById("typingWord").dataset.rest,
    romaji: document.body.classList.contains("romaji-answer"),
    next: document.querySelector("#typingNext b")?.textContent ?? ""
  }));
  const first = ja0.rest[0];
  await page.keyboard.press(first);
  const ja1 = await page.evaluate(() => {
    const u = document.querySelector("#typingWord .tp-unit");
    return { done: u?.classList.contains("tp-unit--done"), keys: u?.querySelector(".tp-unit__keys")?.textContent ?? "", b: u?.querySelector(".tp-unit__keys b")?.textContent ?? "", rest: document.getElementById("typingWord").dataset.rest };
  });
  anims.push(["ja running", await motion(page)]);
  await page.keyboard.type(ja1.rest);
  const ja2 = await state(page);
  await waitState(page, "result");
  const ja3 = await page.evaluate(() => ({ acc: document.getElementById("typingAcc").textContent, keysHidden: document.getElementById("typingKeys").hidden, study: document.getElementById("typingStudyText").textContent, kind: document.getElementById("typingKind").textContent }));
  anims.push(["ja result", await motion(page)]);
  check("typing: 日本語のタブ: 補足（札は動かない）・用語・かなの単位・手本（a-z と -）・打ったキー。手本どおりに打つと語が替わり、正確さ 100%・間違えたキーの行は出ない", ja0.kind === "ja" && ja0.note && open.noteOff && ja0.boardTop === open.boardTop && ja0.unitMin === "0px" && ja0.term !== "" && !ja0.termHidden && ja0.gloss === "" && ja0.units > 0 && /^[a-z-]+$/.test(ja0.rest) && ja0.romaji && (ja1.done ? ja1.keys === first : ja1.b === first) && ja2.term !== ja0.term && ja2.state === "running" && ja3.acc.includes("正確さ 100%") && ja3.keysHidden && ja3.kind === "日本語・5秒", JSON.stringify({ ja0, open: { noteOff: open.noteOff, boardTop: open.boardTop }, ja1, ja2: { term: ja2.term, state: ja2.state }, ja3 }));
  await page.waitForTimeout(700);
  const fontsAfter = await page.evaluate(() => [...document.fonts].filter((f) => f.status === "loaded" && /Shippori/.test(f.family) && String(f.weight) === "700").length);
  check("typing: 開いた直後に見本 apple と訳 りんご、残り 5秒、始まる前の一文、英単語が選ばれ、焦点は入力欄・ヘッダーに現在地なし・フッターの「タイピング練習」が現在地・明朝 700 を読まない", s9.state === "ready" && s9.kind === "en" && s9.rest === "apple" && open.gloss === "りんご" && s9.timer === "残り 5秒" && open.hint === "打ち始めると、5秒を測る。" && open.enPressed === "true" && s9.resultHidden && open.active === "input" && open.headerCurrent === 0 && open.footerCurrent === "タイピング練習" && open.mincho700 === 0 && fontsAfter === 0 && open.h1 === "500", JSON.stringify({ s9, open: { ...open, mainText: undefined }, fontsAfter }));
  check("typing: reduced motion で動きが 0（始まる前・打っている間・結果）", anims.length >= 5 && anims.every(([, list]) => list.length === 0), JSON.stringify(anims));
  const after = await snapshot(page);
  const ALLOWED = (k) => k === "spelldash_typing_practice" || k === "spelldash_device_id" || k.startsWith("spelldash_funnel_") || k === "spelldash_billing_open";
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k] && !ALLOWED(k));
  check("typing: 学習記録を変えない（spelldash_* のうち変わってよいのは自己ベストと計測のキーだけ）", changed.length === 0 && after.spelldash_word_stats === LEARNING.spelldash_word_stats && after.spelldash_key_miss === LEARNING.spelldash_key_miss && after.spelldash_typing_practice !== undefined, changed.join(","));
  check("typing: Pro・はちゃんを出さない（受付中でもフッターに SpellDash Pro が無い）", open.footerPro === 0 && !open.mainText.includes("Pro") && !open.mainText.includes("はちゃん"), String(open.footerPro));
  const own = new URL(BASE).host;
  check("typing: 要求はすべて同一オリジン・教材は 1 回だけ取る（先読みが fetch に使われる）", [...hosts].every((h) => h === own) && dataRequests === 1, `${[...hosts].join(",")} data=${dataRequests}`);
  const links = await page.evaluate(() => ({
    study: document.getElementById("typingStudy").getAttribute("href"),
    studyText: document.getElementById("typingStudy").textContent.trim(),
    about: [...document.querySelectorAll(".tp-about a[data-typing-study]")].map((a) => a.getAttribute("href"))
  }));
  check("typing: 本体への導線は /?from=typing（結果と、このページについて）・日本語のあとの一文は行き先に合う", links.study === "/?from=typing" && links.studyText === "思い出して打つ" && links.about.length === 1 && links.about[0] === "/?from=typing" && ja3.study.includes("ほかの本から始める"), JSON.stringify({ links, study: ja3.study }));
  const pageErrors9 = page.errors.length;

  // T20: 教材が読めない
  await page.route("**/data/typing.json", (route) => route.abort());
  await page.goto(BASE + "/typing.html?t=5", { waitUntil: "load" });
  await page.waitForTimeout(400);
  await page.keyboard.type("apple");
  const failed = await waitState(page, "error", 3000);
  const errVisible = (await page.isVisible("#typingError")) && !(await page.isVisible("#typingTimer"));
  await page.click('.tp-tabs [data-kind="ja"]');
  const jaFailed = await waitState(page, "error", 2000);
  check("typing: 教材が読めなくても apple は打て、尽きたら「読み込めなかった」（残り時間は出さない）", failed && errVisible && jaFailed && page.errors.length === 0, JSON.stringify({ failed, errVisible, jaFailed, errors: page.errors.slice(0, 2), pageErrors9 }));
  await page.close();

  // T20b: タッチ端末で教材が読めない → 打てない画面では画面キーボードを出さない
  {
    const p = await newPage({ mobile: true, viewport: { width: 390, height: 844 } });
    await p.route("**/data/typing.json", (route) => route.abort());
    await p.goto(BASE + "/typing.html?t=5", { waitUntil: "load" });
    await p.waitForTimeout(400);
    await p.tap('.tp-tabs [data-kind="ja"]');
    const err = await waitState(p, "error", 3000);
    await p.waitForTimeout(200);
    const osk = await p.evaluate(() => ({ shown: !document.getElementById("osk")?.hidden, open: document.body.classList.contains("osk-open"), live: document.body.classList.contains("typing--live") }));
    check("typing: タッチ端末で教材が読めないときは画面キーボードを出さない（読み込めなかった の画面）", err && !osk.shown && !osk.open && !osk.live && p.errors.length === 0, JSON.stringify({ err, osk, errors: p.errors.slice(0, 2) }));
    await p.close();
  }

  // T20c: 打っている間にマウスでご意見の窓を開いた回は捨てる（窓の裏で時間が切れて結果・自己ベストが残らない）
  {
    const p = await newPage({ viewport: { width: 1200, height: 900 } });
    await p.goto(BASE + "/typing.html?t=3", { waitUntil: "networkidle" });
    await p.waitForTimeout(300);
    await p.keyboard.type("a"); // apple の頭で始まる
    const running = await waitState(p, "running", 2000);
    await p.click("[data-feedback-open]");
    await p.waitForTimeout(3600);
    const st = await p.evaluate(() => ({ state: document.getElementById("typingBoard").dataset.state, best: localStorage.getItem("spelldash_typing_practice"), modal: !document.getElementById("feedbackModal")?.hidden, focusInModal: !!document.activeElement?.closest("#feedbackModal") }));
    check("typing: 打っている間にご意見の窓を開いた回は捨てる（結果・自己ベストなし、窓の焦点は取らない）", running && st.state === "ready" && st.best === null && st.modal && st.focusInModal && p.errors.length === 0, JSON.stringify(st));
    await p.close();
  }

  // T21: localStorage が投げる端末
  {
    const p = await newPage({ viewport: { width: 1200, height: 900 } });
    await p.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new Error("denied"); };
      Storage.prototype.setItem = () => { throw new Error("denied"); };
    });
    await p.goto(BASE + "/typing.html?t=5", { waitUntil: "networkidle" });
    await p.waitForTimeout(300);
    const theme = await p.evaluate(() => document.documentElement.dataset.theme);
    await p.keyboard.type("apple");
    const s21 = await state(p);
    check("typing: localStorage が投げる端末でも皮が付き、apple を打てる", theme === "light" && s21.state === "running" && s21.rest !== "apple", JSON.stringify({ theme, s21 }));
    await p.close();
  }

  // T22: 結果の守り（js/typingKeys.js）は一覧でなく「盤面の外すべて」: 時間切れの直後、前の一覧に無かったフッターのリンク・ご意見のボタン・
  // ヘッダーのリンクを押しても（結果を出した同じタスクのクリックと、本物のマウスのクリック）移動も窓も焦点の移りも無い。0.6 秒を過ぎたら届く
  {
    const p = await newPage({ viewport: { width: 1200, height: 900 } });
    await p.addInitScript(() => {
      window.__clicks = [];
      window.addEventListener("click", (e) => { if (e.isTrusted) window.__clicks.push(performance.now()); }, true); // ページの配線より先（届いた時刻だけ記録）
    });
    await p.goto(BASE + "/typing.html?t=1", { waitUntil: "networkidle" });
    await p.waitForTimeout(300);
    await p.keyboard.press("a");
    const FOOT = '.site-footer__nav a[href="./news.html"]';
    const g = await p.evaluate((foot) => new Promise((resolve) => {
      const board = document.getElementById("typingBoard");
      const reach = (sel) => { const n = document.querySelector(sel); let hit = false; const h = (e) => { hit = true; e.preventDefault(); }; n.addEventListener("click", h); n.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })); n.removeEventListener("click", h); return hit; };
      const mo = new MutationObserver(() => {
        if (board.dataset.state !== "result") return;
        mo.disconnect();
        window.__resultAt = performance.now();
        const reached = [reach(foot), reach("[data-feedback-open]"), reach(".tp-about a"), reach(".site-header a.brand")];
        document.querySelector(foot).scrollIntoView({ block: "center" }); // 結果で札の高さが替わるので、ここで窓の中に
        const r = document.querySelector(foot).getBoundingClientRect();
        resolve({ reached, x: r.left + r.width / 2, y: r.top + r.height / 2, visible: r.top >= 0 && r.bottom <= innerHeight });
      });
      mo.observe(board, { attributes: true, attributeFilter: ["data-state"] });
    }), FOOT);
    await p.mouse.click(g.x, g.y); // 本物のクリック（守りの中）
    await p.waitForTimeout(150);
    const mid = await p.evaluate(() => { const m = document.getElementById("feedbackModal"); return { path: location.pathname, state: document.getElementById("typingBoard").dataset.state, modal: Boolean(m && !m.hidden), active: document.activeElement?.id, dt: window.__clicks.length ? Math.round(window.__clicks[0] - window.__resultAt) : null }; });
    await p.waitForTimeout(600);
    const later = await p.evaluate((foot) => { const n = document.querySelector(foot); let hit = false; const h = (e) => { hit = true; e.preventDefault(); }; n.addEventListener("click", h); n.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })); n.removeEventListener("click", h); return { hit, path: location.pathname }; }, FOOT);
    check("typing: 時間切れの直後 0.6 秒はフッターのリンク・ご意見・このページについて・ヘッダーのリンクを押しても届かず（本物のクリックでも移動しない・焦点は結果のまま）、過ぎたら届く", g.reached.every((r) => r === false) && g.visible && mid.dt !== null && mid.dt < 600 && mid.path === "/typing.html" && mid.state === "result" && !mid.modal && mid.active === "typingKpmLine" && later.hit && later.path === "/typing.html" && p.errors.length === 0, JSON.stringify({ g, mid, later, errors: p.errors.slice(0, 2) }));
    await p.close();
  }

  // ---- タッチ端末（390 × 844・mobile の 1 枚。設定は「オフ」） ----
  {
    const p = await newPage({ mobile: true, viewport: { width: 390, height: 844 }, storage: { spelldash_osk: "off" } });
    await p.goto(BASE + "/typing.html?t=3", { waitUntil: "networkidle" });
    await p.waitForTimeout(300);
    const osk = () => p.evaluate(() => {
      const box = (sel) => { const n = document.querySelector(sel); if (!n) return null; const r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, w: r.width, h: r.height }; };
      const shown = (sel) => { const n = document.querySelector(sel); return Boolean(n && n.getClientRects().length > 0 && getComputedStyle(n).display !== "none" && !n.closest("[hidden]")); };
      return { osk: shown("#osk"), open: document.body.classList.contains("osk-open"), enter: shown('#osk [data-action="enter"]'), row3: shown("#osk .osk__row--3"), dash: shown('#osk [data-action="dash"]'), board: box("#typingBoard"), keys: box("#osk"), header: box(".site-header") };
    });
    const o0 = await osk();
    const ready390 = await state(p);
    await p.dispatchEvent('#osk [data-key="a"]', "pointerdown");
    const run390 = await state(p);
    const o1 = await osk();
    check("typing（390）: 設定が「オフ」でも画面キーボードが出て、Enter と 3 段目は出さない・a で始まり札は盤面に隠れない", o0.osk && o0.open && !o0.enter && !o0.row3 && run390.state === "running" && run390.rest === "pple" && o1.board.bottom <= o1.keys.top, JSON.stringify({ o0, run390: run390.state, o1 }));
    const guard = await p.evaluate(() => new Promise((resolve) => {
      const board = document.getElementById("typingBoard");
      // 押した先まで届いたか（届いたら既定の動きは止める: 移動しない）。守りの間は盤面の外のどこにも届かない（js/typingKeys.js）
      const reach = (sel) => { const n = document.querySelector(sel); let hit = false; const h = (e) => { hit = true; e.preventDefault(); }; n.addEventListener("click", h); n.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })); n.removeEventListener("click", h); return hit; };
      const snap = (sels) => ({ osk: !document.getElementById("osk").hidden, open: document.body.classList.contains("osk-open"), reached: sels.map(reach), inertCount: document.querySelectorAll("[inert]").length });
      const done = () => { const out = {}; setTimeout(() => (out.at300 = snap(["#typingStudy", ".tp-more a", '.site-footer__nav a[href="./news.html"]', ".tp-tabs button"])), 300); setTimeout(() => { out.at700 = snap(['.site-footer__nav a[href="./news.html"]']); resolve(out); }, 700); };
      if (board.dataset.state === "result") { done(); return; }
      const mo = new MutationObserver(() => { if (board.dataset.state === "result") { mo.disconnect(); done(); } });
      mo.observe(board, { attributes: true, attributeFilter: ["data-state"] });
    }));
    const result390 = await state(p);
    check("typing（390）: 時間切れの直後 0.6 秒は盤面を出したまま・盤面の外（結果の導線・タイピングゲームへの 1 行・フッターのリンク・タブ）は押しても届かない、その後に畳んで押せる（inert は使わない）", guard.at300.osk && guard.at300.reached.every((r) => r === false) && !guard.at700.osk && !guard.at700.open && guard.at700.reached[0] === true && guard.at700.inertCount === 0, JSON.stringify(guard));
    await p.click('.tp-tabs [data-kind="ja"]');
    await waitState(p, "ready", 3000);
    await p.waitForTimeout(150);
    const o2 = await osk();
    const ja390 = await state(p);
    const scroll390 = [ready390, run390, result390, ja390].map((s) => s.scroll <= s.inner);
    await p.setViewportSize({ width: 320, height: 640 });
    await p.goto(BASE + "/typing.html?t=3", { waitUntil: "networkidle" });
    await p.waitForTimeout(300);
    const ready320 = await state(p);
    await p.dispatchEvent('#osk [data-key="a"]', "pointerdown");
    await waitState(p, "result", 6000);
    await p.waitForTimeout(700);
    const result320 = await state(p);
    check("typing（390・320）: 日本語では ー が出る・始まる前・打っている間・結果・日本語で横スクロールしない", o2.dash && o2.row3 && !o2.enter && scroll390.every(Boolean) && ready320.scroll <= ready320.inner && result320.state === "result" && result320.scroll <= result320.inner, JSON.stringify({ o2: { dash: o2.dash, row3: o2.row3, enter: o2.enter }, scroll390, s320: [ready320.scroll, result320.scroll, result320.inner, result320.state] }));
    check("typing（390）: エラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  {
    const p = await newPage({ mobile: true, viewport: { width: 375, height: 560 } });
    await p.goto(BASE + "/typing.html?t=3", { waitUntil: "networkidle" });
    await p.waitForTimeout(300);
    const fit = await p.evaluate(() => {
      const r = (sel) => document.querySelector(sel).getBoundingClientRect();
      return { board: { top: r("#typingBoard").top, bottom: r("#typingBoard").bottom }, osk: { top: r("#osk").top, shown: !document.getElementById("osk").hidden }, header: r(".site-header").bottom };
    });
    check("typing（375×560・mobile）: 盤面が開いたら札を盤面の上に寄せる", fit.osk.shown && fit.board.bottom <= fit.osk.top && fit.board.top >= fit.header, JSON.stringify(fit));
    await p.close();
  }

  // ---- 静的（ファイルを読むだけ） ----
  const typingHtml = fs.readFileSync(path.join(ROOT, "typing.html"), "utf8");
  const meta = (re) => typingHtml.match(re)?.[1] ?? "";
  const desc = meta(/<meta name="description" content="([^"]*)"/);
  const ogDesc = meta(/<meta property="og:description" content="([^"]*)"/);
  check("typing: title・canonical は決めた文、description は「登録なし」「1分」を含む、本文の静的な文（検索に出す）", typingHtml.includes("<title>タイピング練習（英単語・ローマ字・長文）無料 | SpellDash</title>") && typingHtml.includes('<link rel="canonical" href="https://www.spelldash.net/typing.html" />') && typingHtml.includes('<meta property="og:url" content="https://www.spelldash.net/typing.html" />') && desc !== "" && desc === ogDesc && desc.includes("登録なし") && desc.includes("1分") && !/noindex/i.test(typingHtml) && ["残り 60秒", "打ち始めると、1分を測る。", "apple", "りんご", "このページについて"].every((s) => typingHtml.includes(s)), desc);
  const footerNav = (html) => html.match(/<nav class="site-footer__nav"[^>]*>[\s\S]*?<\/nav>/)?.[0] ?? "";
  const firstLink = (html) => footerNav(html).match(/<a [^>]*>/)?.[0] ?? "";
  const noTyping = ["index.html", "stats.html", "profile.html", "news.html", "list.html", "pro.html", "privacy.html", "terms.html", "tokushoho.html", "admin.html", "typing-game.html"].filter((f) => !firstLink(fs.readFileSync(path.join(ROOT, f), "utf8")).includes('href="./typing.html"'));
  const packFiles = fs.readdirSync(path.join(ROOT, "packs")).filter((f) => f.endsWith(".html"));
  const packNoTyping = packFiles.filter((f) => !firstLink(fs.readFileSync(path.join(ROOT, "packs", f), "utf8")).includes('href="/typing.html"'));
  check(`typing: フッターの先頭に「タイピング練習」（静的 11 ページと packs の全 ${packFiles.length} 枚、battle.html は除く）・typing.html のフッターは Pro を出さない印を持つ`, noTyping.length === 0 && packFiles.length >= 160 && packNoTyping.length === 0 && /<nav class="site-footer__nav"[^>]*data-no-pro/.test(typingHtml) && firstLink(typingHtml).includes('aria-current="page"') && !footerNav(fs.readFileSync(path.join(ROOT, "battle.html"), "utf8")).includes("typing.html"), JSON.stringify({ noTyping, packNoTyping: packNoTyping.slice(0, 5) }));
  const newsSrc = fs.readFileSync(path.join(ROOT, "js", "news.js"), "utf8");
  // お知らせは題で探す（並行の別の作業が先頭に 1 件足しても落ちない。検査の強さは同じ: その 1 件に ./typing.html）
  const newsItemOf = (title) => { const i = newsSrc.indexOf(`title: "${title}"`); return i < 0 ? "" : newsSrc.slice(newsSrc.lastIndexOf("{", i), newsSrc.indexOf("},", i)); };
  const firstNews = newsItemOf("タイピング練習に長文");
  check("typing: sitemap・sw の precache・アプリの PAGES・お知らせ（題「タイピング練習に長文」の 1 件）に typing.html、ci.yml に教材の --check", fs.readFileSync(path.join(ROOT, "sitemap.xml"), "utf8").includes("/typing.html") && fs.readFileSync(path.join(ROOT, "sw.js"), "utf8").includes('"/typing.html"') && fs.readFileSync(path.join(ROOT, "scripts", "build-app.mjs"), "utf8").includes('"typing.html"') && firstNews.includes("./typing.html") && fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8").includes("node scripts/build-typing.mjs --check"));
  const typingCss = fs.readFileSync(path.join(ROOT, "css", "typing.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  check("typing: typing.css は太さを longhand で書き、新しい animation／transition を持たない", !/text-decoration\s*:[^;]*\d+px/.test(typingCss) && !/\b(animation|transition)(-[a-z]+)?\s*:/.test(typingCss) && !typingCss.includes("@keyframes") && typingCss.includes("text-decoration-thickness: 2px"));
}

// ===== 7.55 タイピング練習の長文（typing.html の 3 つ目の種類「長文」。docs/SPEC_TYPING.md「長文」。Batch 62）: 判定（romaji.js の { punct }・englishLine）・
// キーの読み方・時計・スコア・自己ベスト・教材の生成器（Node）。既定（オプションなしの判定・ゲームの生成器）が変わらないことも見る。
// ページ（1200 の 1 枚・完走と自己ベスト・英語・教材が読めない組・投げる storage・タッチ端末 390・全 20 編の全行・静的）は節の後半 =====
console.log("typing long:");
{
  const T = await import("../js/typingDrill.js");
  const L = await import("../js/typingLong.js");
  const R = await import("../js/romaji.js");
  const BL = await import("../scripts/build-typing-long.mjs");
  const BG = await import("../scripts/build-typing-game.mjs");
  const J = (v) => JSON.stringify(v);
  const P = { punct: true };

  // ---- romaji.js の既定は変わらない（オプションなし・{}・数・{ punct: false }。句読点のキーは読み飛ばす） ----
  {
    const typingJson = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "typing.json"), "utf8"));
    const gameJson = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "typing-game.json"), "utf8"));
    const readings = [...new Set([...typingJson.ja.map((p) => p[1]), ...Object.values(gameJson.courses).flatMap((c) => c.map((p) => p[1]))])];
    const bad = [];
    for (const r of readings) {
      const c0 = R.canonicalRomaji(r);
      const c1 = R.canonicalRomaji(r, { finalN: true });
      if ([R.canonicalRomaji(r, {}), R.canonicalRomaji(r, 1), R.canonicalRomaji(r, null), R.canonicalRomaji(r, { punct: false }), R.canonicalRomaji(r, P)].some((c) => c !== c0) || R.canonicalRomaji(r, { finalN: true, punct: false }) !== c1 || R.canonicalRomaji(r, { finalN: true, punct: true }) !== c1) { bad.push(`手本 ${r}`); continue; }
      const ms = [R.createRomajiMatcher([r]), R.createRomajiMatcher([r], {}), R.createRomajiMatcher([r], 1), R.createRomajiMatcher([r], { punct: false })];
      const mp = R.createRomajiMatcher([r], P); // 句読点の無い読みでは、句読点のキーのほかは同じ
      let same = true;
      for (const k of c1) {
        const out = ms.map((m) => J([m.feed(k), m.state(), m.hint()]));
        const outP = J([mp.feed(k), mp.state(), mp.hint()]);
        if (out.some((o) => o !== out[0]) || outP !== out[0]) { same = false; break; }
      }
      const done = ms[0].state().done;
      const comma = ms.map((m) => m.feed(","));
      if (!same || !done || comma.some((f) => !f.ignored || f.ok)) bad.push(`判定 ${r}`);
    }
    const keys = [R.normalizeRomajiKey(","), R.normalizeRomajiKey("."), R.normalizeRomajiKey("、"), R.romajiKeyOf({ key: "," }), R.romajiKeyOf({ key: "." }), R.romajiKeyOf({ key: "Process", code: "Comma" }), R.romajiKeyOf({ key: "ね", code: "Comma" }), R.romajiKeyOf({ key: "せ", code: "KeyP" })];
    // 書き出した関数に添字が渡っても既定のまま（[…].map(f) の形）
    const mapped = ["きた、かぜ。", "みかんと、ぱん。"].map(R.canonicalRomaji);
    const mappedM = ["きた、かぜ。", "みかんと、ぱん。"].map((r, i) => R.createRomajiMatcher([r], i).readings[0]);
    const norm = ["きた、かぜ。", "み、か"].map(R.normalizeReading);
    check(`typing long: romaji.js の既定は変わらない — typing.json・typing-game.json の全読み（${readings.length}）で、オプションなし・{}・数・null・{ punct: false } の手本と判定が同じ（{ punct: true } も句読点の無い読みでは同じ）、, . は読み飛ばす、romajiKeyOf・normalizeRomajiKey は , . を返さない、添字を渡しても既定`, bad.length === 0 && J(keys) === '[null,null,null,null,null,null,null,"p"]' && J(mapped) === '["kitakaze","mikanntopann"]' && J(mappedM) === '["きたかぜ","みかんとぱん"]' && J(norm) === '["きたかぜ","みか"]', J({ bad: bad.slice(0, 5), keys, mapped, mappedM, norm }));
  }
  // ---- { punct: true }: 「、」は ,、「。」は .。句読点の前の ん の手本は nn、n 1 つ・nn・n'・xn でも通る ----
  {
    const r = "みかんと、ぱん。";
    const canon = R.canonicalRomaji(r, P);
    const u0 = T.japaneseUnits(r, "", P);
    const typedOk = ["mikanto,pan.", "mikannto,pann.", "mikan'to,pan'.", "mikaxnto,paxn.", "mikannto、pann。"].map((k) => { const m = R.createRomajiMatcher([r], P); return m.type(k).missAt === -1 && m.state().done; });
    const noComma = R.createRomajiMatcher([r], P).type("mikanntopann.").missAt;
    // 1 打ずつ: かなの行・キーの行が崩れず、かなが空の単位が無い（V7 の (a)(b)(c)）
    const drift = [];
    for (const k of ["mikannto,pann.", "mikanto,pan.", "mikan'to,pan'."]) {
      for (let i = 0; i <= k.length; i++) {
        const { units } = T.japaneseUnits(r, k.slice(0, i), P);
        if (units.map((u) => u.kana).join("") !== r || units.some((u) => u.kana === "")) { drift.push(`${k.slice(0, i)}`); break; }
      }
    }
    const w = T.createWord("ja_text", ["蜜柑と、パン。", r]);
    const steps = [..."mikannto,pann."].map((k) => w.feed(k).ok);
    const tsu = R.canonicalRomaji("あっ、いや。", P); // 句読点の前の っ は xtu（教材で避ける: V14）
    check("typing long: { punct: true } — 手本 mikannto,pann.（句読点の前の ん も nn）、n 1 つ・nn・n'・xn・かなの「、」「。」でも通る、, を抜くとミス、打っている途中もかなの行が読みと同じで空の単位なし、ja_text の語は kind ja で句読点も単位 1 つ、っ、は xtu", canon === "mikannto,pann." && u0.rest === "mikannto,pann." && u0.units[4]?.kana === "、" && u0.units[4]?.rest === "," && typedOk.every(Boolean) && noComma === 8 && drift.length === 0 && w.kind === "ja" && steps.every(Boolean) && w.matcher.state().done && tsu === "axtu,iya.", J({ canon, u0, typedOk, noComma, drift, steps, tsu }));
  }
  // ---- 生成器の検査が空回りしない（V2・V7・L10・V8・L1）とゲームの生成器の既定 ----
  {
    const r = "みかんと、ぱん。";
    const v2 = [BG.typeable(r, "mikannto,pann.", P), BG.typeable(r, "mikanntopann.", P), BG.typeable(r, "mikanntopann."), BG.typeable(r, "mikannto;;pann")]; // オプションなしの matcher は , . ; を読み飛ばすので、でたらめな手本でも通る
    const v7 = [BG.unitsDrift(r, "mikannto,pann.", P), BL.unitKeysDrift(r, "mikannto,pann."), BL.unitKeysDrift(r, "mikanto,pan.")];
    // ゲームの文に句読点を差し込んだ行（ん、・ん。を含む）で V2・V7・V14 が 0 件
    const gameRows = BG.loadSources().rows;
    const small = /^[ぁぃぅぇぉゃゅょゎ]$/;
    const synth = [];
    for (const { r: gr } of gameRows) {
      const ch = [...gr];
      const cut = Math.floor(ch.length / 2);
      synth.push(gr + "。");
      if (!small.test(ch[cut]) && ch[cut - 1] !== "っ" && ch[cut] !== "ー") synth.push(ch.slice(0, cut).join("") + "、" + ch.slice(cut).join("") + "。");
    }
    const synthBad = synth.filter((x) => { const c = BL.canonOf(x); return !c || /[xl]/.test(c) || !BG.typeable(x, c, P) || BG.unitsDrift(x, c, P) || BL.unitKeysDrift(x, c); });
    const nBefore = synth.filter((x) => /ん[、。]/.test(x)).length;
    const aux = BL.loadAux();
    const mk = (lang, id, title, lines) => ({ id, title, len: id.includes("-s") ? "short" : "long", lang, file: `${lang}.jsonl`, line: 1, lines: lines.map((row, i) => ({ ...row, line: i + 2 })) });
    const g0 = gameRows[0];
    const l10 = BL.validateTexts([mk("ja", "ja-s01", "北風と太陽", [{ t: `${g0.t}。`, r: `${g0.r}。` }])], { aux }).filter((p) => p.check.startsWith("L10"));
    const skill = BL.validateTexts([mk("en", "en-s01", "小さな庭", [{ t: "She has the skill to sing well.", ja: "彼女は上手に歌える。" }])], { aux }).filter((p) => p.check.startsWith("V8"));
    const kill = BL.validateTexts([mk("en", "en-s01", "小さな庭", [{ t: "They killed time by the river.", ja: "川で時間をつぶした。" }])], { aux }).filter((p) => p.check.startsWith("V8"));
    const title = BL.validateTexts([mk("ja", "ja-s01", "嫁の朝", [{ t: "朝の光が、まどから入る。", r: "あさのひかりが、まどからはいる。" }])], { aux }).filter((p) => p.check.startsWith("L1"));
    const builtGame = BG.buildTypingGameData();
    const gameOk = builtGame.text === fs.readFileSync(path.join(ROOT, "data", "typing-game.json"), "utf8") && BG.validateTypingGameData(builtGame).length === 0;
    check(`typing long: 生成器の検査が空回りしない — , を抜いた手本で V2 が落ちる（オプションなしでは通ってしまう）、句読点の行（ゲームの文に差し込んだ ${synth.length} 行。ん の直後 ${nBefore}）で V7 が 0 件、n 1 つの手本ではキーの行のずれを見る、ゲームの文に「。」で L10、deny-en の kill で skill は落ちず killed は落ちる、題に kanji.txt に無い字で L1、ゲームの --check は同じ`, J(v2) === "[true,false,true,true]" && v7[0] === null && v7[1] === null && typeof v7[2] === "string" && synthBad.length === 0 && nBefore > 0 && l10.length === 2 && skill.length === 0 && kill.length === 1 && title.some((p) => p.reason.includes("嫁")) && gameOk, J({ v2, v7, synthBad: synthBad.slice(0, 3), l10, skill, kill, title }));
  }
  // ---- キーの読み方（punctKeyOf・textKeyOf） ----
  {
    const ev = (o) => ({ key: "", code: "", ...o });
    const pk = [ev({ key: "," }), ev({ key: "、" }), ev({ key: "Process", code: "Comma" }), ev({ key: "ね", code: "Comma" }), ev({ key: "る", code: "Period" }), ev({ key: "せ", code: "KeyP" }), ev({ key: "。" }), ev({ key: "，" }), ev({ key: ",", ctrlKey: true }), ev({ key: "Enter" }), ev({ key: " " }), ev({ key: "/" })].map(L.punctKeyOf);
    const tk = [ev({ key: "せ", code: "KeyP" }), ev({ key: "A", shiftKey: true }), ev({ key: "Process", code: "KeyA" }), ev({ key: "Process", code: "Quote" }), ev({ key: "Process", code: "Digit7", shiftKey: true }), ev({ key: "Dead", code: "Quote" }), ev({ key: "Process", code: "Space" }), ev({ key: "Process", code: "Space", isComposing: true }), ev({ key: "　" }), ev({ key: "?", code: "Slash", shiftKey: true }), ev({ key: "Process", code: "Slash", shiftKey: true }), ev({ key: "a", ctrlKey: true }), ev({ key: "Process", code: "Backquote" }), ev({ key: "Enter" }), ev({ key: "Shift", shiftKey: true }), ev({ key: "’" }), ev({ key: "Ａ" }), ev({ key: "." }), ev({ key: "Process", code: "Digit3" })].map(L.textKeyOf);
    check("typing long: キーの読み方 — punctKeyOf（, 、 Process＋Comma・かな配列の ね／る → , .・せ＝KeyP → p・Ctrl つき・Enter・空白は null）、textKeyOf（大小はそのまま・Process は code で読む・Quote／Shift＋Digit7／Dead → '・Process の Space は空白（変換中は null）・全角の空白・Shift＋Slash → ?・Ctrl つき・ほかの code・名前のキーは null）", J(pk) === '[",",",",",",",",".","p",".",",",null,null,null,null]' && J(tk) === `["p","A","a","'","'","'"," ",null," ","?","?",null,null,null,null,"'","A",".","3"]`, J({ pk, tk }));
  }
  // ---- englishLine（en_text） ----
  {
    const run = T.createRun("en_text", [["I'm here, Tom?", "訳"], ["Yes.", "はい。"]]);
    const types = [];
    let t = 0;
    for (const k of [" ", "i", "'", "M", "x", " ", "h", "e", "r", "e", ",", "a", " ", "t", "o", "m", "?", " ", "Y", "e", "s", "."]) types.push(run.press(k, (t += 100)).type);
    const w = T.createWord("en_text", ["A b?", "訳"]);
    const view = w.view();
    const fed = [w.startsWith("a"), w.feed("a").ok, w.feed("b"), w.feed(" ").ok, w.feed("?"), w.feed("B").ok, w.feed("."), w.feed("?").done];
    const view2 = w.view();
    check("typing long: englishLine — 大文字に小文字・Shift つきが通る、行の頭の空白は飲む（数えない）、空白の所に字・字の所に空白はミスで打つはずだったキーは空白／小文字、' ? は完全一致、最後の記号で行が済む、語の kind は en（描く側の英語の分岐に乗る）", J(types) === J(["ignored", "correct", "correct", "correct", "miss", "correct", "correct", "correct", "correct", "correct", "correct", "miss", "correct", "correct", "correct", "correct", "correct", "ignored", "correct", "correct", "correct", "correct"]) && run.stats.correct === 18 && run.stats.miss === 2 && J([...run.stats.missKeys]) === '[[" ",2]]' && run.stats.words === 2 && run.current === null && w.kind === "en" && view.now === "A" && fed[0] === true && fed[1] === true && fed[2].ok === false && fed[2].expected === " " && fed[3] === true && fed[4].ok === false && fed[4].expected === "b" && fed[5] === true && fed[6].ok === false && fed[6].expected === "?" && fed[7] === true && view2.done === "A b?" && view2.now === "", J({ types, stats: { ...run.stats, missKeys: [...run.stats.missKeys] }, view, fed, view2 }));
  }
  // ---- 時計とスコア ----
  {
    const s = L.summarizeLong({ correct: 450, miss: 12, missKeys: new Map() }, 120000);
    const perfect = L.summarizeLong({ correct: 300, miss: 0, missKeys: new Map() }, 90000);
    const fast = L.summarizeLong({ correct: 3, miss: 0, missKeys: new Map() }, 300);
    const zero = L.summarizeLong({ correct: 0, miss: 0, missKeys: new Map() }, 8000);
    // 止めていた分を引く・最初に判定したキーから・止める → Space で続き → 判定せずに Esc で lastAt まで（負にならない）
    const c1 = L.createLongClock();
    c1.pause(0); // 判定したキーの前に止めた間は数えない
    c1.resume(5000);
    c1.count(6000);
    c1.count(16000);
    c1.pause(17000);
    c1.resume(106000);
    const e1 = c1.elapsedMs(); // 10 秒（止める → 続き → 判定なしで Esc）
    c1.count(107000);
    const e2 = c1.elapsedMs(); // 107 − 6 − 89 = 12 秒
    const c2 = L.createLongClock();
    c2.count(0);
    c2.count(150);
    c2.count(300); // 3 打を 0.3 秒、5 秒待って Esc → ready
    const outs = [L.stopOutcome(c2), L.stopOutcome(L.createLongClock()), L.stopOutcome(c1)];
    const c3 = L.createLongClock();
    c3.count(0);
    c3.count(4999);
    const c4 = L.createLongClock();
    c4.count(0);
    c4.count(5000);
    const times = [48, 108, 62, 120, 0, 59.9, 3599].map(L.formatLongTime);
    check("typing long: 時計とスコア — 450・12・120 秒 → 打/分 225・正確さ 97・スコア 213、ミス 0 はスコア＝打/分、1 秒未満と 0 打は「―」（null）、止めていた分を引き、最初に判定したキーから測り、止めた後の判定なしの Esc でも lastAt まで（負にならない）、5 秒は出す時間で見る、時間の書き方（48秒・1分48秒・1分02秒・2分）", s.kpm === 225 && s.accuracy === 97 && s.score === 213 && perfect.score === perfect.kpm && perfect.kpm === 200 && fast.kpm === null && fast.score === null && fast.accuracy === 100 && zero.score === null && zero.accuracy === null && e1 === 10000 && e2 === 12000 && J(outs) === '["ready","ready","result"]' && L.stopOutcome(c3) === "ready" && L.stopOutcome(c4) === "result" && J(times) === '["48秒","1分48秒","1分02秒","2分","0秒","59秒","59分59秒"]', J({ s, perfect, fast, zero, e1, e2, outs, times }));
  }
  // ---- 自己ベスト（best.long[id]） ----
  {
    const fake = (init = {}) => {
      const map = new Map(Object.entries(init));
      return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), map };
    };
    const text = { id: "ja-s01", keys: 260, title: "北風と太陽", lines: [["a", "b"]] };
    const rec = (o) => ({ score: 200, kpm: 210, acc: 97, sec: 75, day: "2026-10-12", ...o });
    const st = fake({ [T.BEST_KEY]: J({ v: 1, best: { en: { 60: { kpm: 77, acc: 90, day: "2026-10-01" } }, ja: { 60: { kpm: 55, acc: 80, day: "2026-10-01" } } } }) });
    const first = L.recordLongBest(st, text, rec());
    const below = L.recordLongBest(st, text, rec({ score: 180, kpm: 300 }));
    const same = L.recordLongBest(st, text, rec({ kpm: 200 }));
    const faster = L.recordLongBest(st, text, rec({ kpm: 240 }));
    const newer = L.recordLongBest(st, text, rec({ score: 230, kpm: 100 }));
    const saved = JSON.parse(st.map.get(T.BEST_KEY));
    const outOfRange = [L.recordLongBest(fake(), text, rec({ kpm: 2001 })), L.recordLongBest(fake(), text, rec({ sec: 0 })), L.recordLongBest(fake(), text, rec({ score: null })), L.recordLongBest(fake(), text, rec({ sec: 3601 }))].map((c) => c.status);
    const broken = [{ score: 1e300, kpm: 1, acc: 1, sec: 9, keys: 260, day: "" }, { score: 1.5, kpm: 1, acc: 1, sec: 9, keys: 260, day: "" }, { score: 1, kpm: 1, acc: 1, sec: -3, keys: 260, day: "" }, { score: 1, kpm: 1, acc: 1, sec: 3601, keys: 260, day: "" }, { score: 1, kpm: 1, acc: 101, sec: 9, keys: 260, day: "" }, { score: 1, kpm: 1, acc: 1, sec: 9, keys: 259, day: "" }, { score: 1, kpm: 1, acc: 1, sec: 9, keys: 260 }].map((b) => L.readLongBest(fake({ [T.BEST_KEY]: J({ v: 1, best: { long: { "ja-s01": b } } }) }), "ja-s01", 260));
    const ok = L.readLongBest(fake({ [T.BEST_KEY]: J({ v: 1, best: { long: { "ja-s01": { score: 1, kpm: 1, acc: null, sec: 9, keys: 260, day: "" } } } }) }), "ja-s01", 260);
    const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    const texts = [{ id: "ja-s01", keys: 260 }, { id: "ja-s02", keys: 330 }, { id: "en-s01", keys: 340 }];
    const doneOf = (best) => L.doneLongIds(fake({ [T.BEST_KEY]: J({ v: 1, best: { long: best } }) }), texts);
    const r1 = { score: 1, kpm: 1, acc: 1, sec: 9, day: "" };
    const defs = [L.defaultLongId(texts, doneOf({})), L.defaultLongId(texts, doneOf({ "ja-s01": { ...r1, keys: 260 } })), L.defaultLongId(texts, doneOf({ "ja-s01": { ...r1, keys: 260 }, "ja-s02": { ...r1, keys: 330 }, "en-s01": { ...r1, keys: 340 } })), L.defaultLongId(texts, doneOf({ "ja-s01": { ...r1, keys: 259 } })), L.defaultLongId(texts, L.doneLongIds(throwing, texts))];
    const phrases = [first, newer, faster, same, below].map(L.longBestPhrase);
    check("typing long: 自己ベスト — best.long[id] だけ差し替え en・ja を消さない、スコアで比べ同点は打/分（faster は書いて句、same は書かない）、書く keys は教材の keys、範囲外（打/分 2001・sec 0・null・3601）は書かず句なし（none）、壊れた値と keys の違う記録は無い扱い、既定の文章（記録なし → ja-s01、ja-s01 済み → 次、全部済み → ja-s01、keys が違えば済みでない、読めない端末 → ja-s01）、句の文", first.status === "first" && below.status === "below" && below.prev === 200 && below.diff === 20 && same.status === "same" && faster.status === "faster" && faster.prev === 210 && newer.status === "new" && newer.prev === 200 && saved.best.en["60"].kpm === 77 && saved.best.ja["60"].kpm === 55 && J(saved.best.long["ja-s01"]) === J({ score: 230, kpm: 100, acc: 97, sec: 75, keys: 260, day: "2026-10-12" }) && J(outOfRange) === '["none","none","none","none"]' && broken.every((b) => b === null) && ok?.acc === null && J(defs) === '["ja-s01","ja-s02","ja-s01","ja-s01","ja-s01"]' && L.recordLongBest(throwing, text, rec()).status === "none" && L.writeLongBest(throwing, "ja-s01", { ...rec(), keys: 260 }) === false && J(phrases) === J(["自己ベスト（はじめての記録）", "自己ベストを更新（前 200）", "自己ベストと同じスコア・打/分を更新（前 210）", "自己ベストと同じ", "自己ベスト 200（あと 20）"]), J({ first, below, same, faster, newer, saved, outOfRange, broken, defs, phrases }));
  }
  // ---- 教材の形・?l=・次の文・項目・間違えたキーの表示 ----
  {
    const good = { v: 1, texts: [{ id: "ja-s01", lang: "ja", len: "short", title: "北風と太陽", keys: 260, lines: [["見出し。", "みだし。"]] }, { id: "en-s01", lang: "en", len: "short", title: "小さな庭", keys: 30, lines: [["A b.", "訳。"]] }] };
    const shapes = [good, { ...good, v: 2 }, { v: 1, texts: [] }, { v: 1, texts: [{ ...good.texts[0], lang: "en" }] }, { v: 1, texts: [{ ...good.texts[0], lines: [["a"]] }] }, { v: 1, texts: [good.texts[0], good.texts[0]] }, { v: 1, texts: [{ ...good.texts[0], keys: 0 }] }].map((d) => L.parseLongData(d) !== null);
    const ls = ["?l=2", "?l=99", "?l=0", "?l=100", "", "?l=2.5"].map(L.linesFrom);
    const labels = [L.longOptionLabel({ title: "北風と太陽", lines: new Array(12).fill(["a", "b"]) }), L.longOptionLabel({ title: "北風と太陽", lines: new Array(12).fill(["a", "b"]) }, true)];
    const keyNames = [L.longKeyLabel(",", "ja"), L.longKeyLabel(".", "ja"), L.longKeyLabel("i", "ja"), L.longKeyLabel(" ", "en"), L.longKeyLabel("s", "en"), L.longKeyLabel(",", "en")];
    check("typing long: 教材の形（v・各欄・validPairs・id の重複・lang と id の頭）、?l= は 1〜99、次の文は最後なら先頭、select の項目「北風と太陽 12行」「済み 北風と太陽 12行」、間違えたキーの表示（、。・空白）", J(shapes) === "[true,false,false,false,false,false,false]" && J(ls) === "[2,99,null,null,null,null]" && L.nextLongId(good.texts, "ja-s01") === "en-s01" && L.nextLongId(good.texts, "en-s01") === "ja-s01" && J(labels) === '["北風と太陽 12行","済み 北風と太陽 12行"]' && J(keyNames) === '["、","。","i","空白","s",","]' && J(L.trimLongLines([1, 2, 3], 2)) === "[1,2]" && J(L.trimLongLines([1, 2, 3], null)) === "[1,2,3]", J({ shapes, ls, labels, keyNames }));
  }
  // ---- 教材（data/typing-long.json）: 生成物と一致・違反 0・本数と帯・全行が手本で打ち切れ途中で崩れない・英語の字種と折り返し・訳・重複なし・先頭 ----
  {
    const built = BL.buildTypingLongData();
    const file = path.join(ROOT, "data", "typing-long.json");
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const data = text ? JSON.parse(text) : null;
    const problems = data ? BL.validateTypingLongData(data) : ["data/typing-long.json が無い（教材を書いて node scripts/build-typing-long.mjs）"];
    const texts = L.parseLongData(data) ?? [];
    const groups = Object.fromEntries(L.LONG_GROUPS.map((g) => [`${g.lang}:${g.len}`, texts.filter((t) => t.lang === g.lang && t.len === g.len).length]));
    const bad = [];
    for (const t of texts) {
      if (t.lang === "ja") {
        let keys = 0;
        for (const [, r] of t.lines) {
          const canon = R.canonicalRomaji(r, { finalN: true, punct: true });
          if (!canon || /[xl]/.test(canon) || !BG.typeable(r, canon, P) || BG.unitsDrift(r, canon, P) || BL.unitKeysDrift(r, canon)) bad.push(`${t.id} ${r}`);
          keys += canon?.length ?? 0;
        }
        if (keys !== t.keys) bad.push(`${t.id} keys`);
      } else {
        for (const [s, ja] of t.lines) if (!/^[A-Za-z .,'?]{20,52}$/.test(s) || BL.wrapCount(s, 21) > 3 || BL.wrapCount(s, 41) > 2 || !ja || [...ja].length > 32) bad.push(`${t.id} ${s}`);
        if (t.lines.reduce((n, [s]) => n + s.length, 0) !== t.keys) bad.push(`${t.id} keys`);
      }
    }
    const first = texts.find((t) => t.id === "ja-s01");
    check(`typing long: 教材は生成物と同じ（node scripts/build-typing-long.mjs）・違反 0・本数（日 8／4・英 5／3: ${J(groups)}）・ja-s01 が先頭で 240〜280 打・全行が手本で打ち切れ、かなの行もキーの行も途中で崩れない・英語の字種と折り返し・訳・keys・ゲームの文と重複なし（L10）・ci.yml に --check`, built.text === text && problems.length === 0 && J(groups) === J({ "ja:short": 8, "ja:long": 4, "en:short": 5, "en:long": 3 }) && texts[0]?.id === "ja-s01" && first?.keys >= 240 && first?.keys <= 280 && bad.length === 0 && fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8").includes("node scripts/build-typing-long.mjs --check"), J({ problems: problems.slice(0, 5), bad: bad.slice(0, 5) }));
  }
}

// ---- ページ（typing.html の長文のタブ）: 1200 の 1 枚（?t=5&l=2。reduced motion・CLS）／完走と自己ベスト／英語の長文／教材が読めない組・投げる storage／
// タッチ端末 390／全 20 編の全行の行数と札の高さ（390・360・320・1200・横向き・背の低い縦向き）／静的
// 打鍵は合成の keydown（焦点のある要素に送る。js/typingKeys.js は document で受ける）。合成のキーは「直前の入力」に数えられないので、行の送りで札が動けば CLS に入る。
// 結果を出す最後の 1 打だけは本物のキー（結果で札の高さが替わるのは入力の直後: SPEC §2.6）。時間は performance.now() に足す __skew で進める（5 秒・止めていた間を待たない）
{
  const longFile = path.join(ROOT, "data", "typing-long.json");
  const LONG = fs.existsSync(longFile) ? JSON.parse(fs.readFileSync(longFile, "utf8")).texts : null;
  if (!LONG) check("typing long: ページの検査には教材（data/typing-long.json）が要る", false);
  else {
    const J = (v) => JSON.stringify(v);
    const byId = Object.fromEntries(LONG.map((t) => [t.id, t]));
    const R = await import("../js/romaji.js");
    const canonOf = (r) => R.canonicalRomaji(r, { finalN: true, punct: true });
    const lineOf = (t, i) => (t.lang === "ja" ? `${t.lines[i][0]}（${t.lines[i][1]}）` : `${t.lines[i][0]} ${t.lines[i][1]}`);
    const PROBE = () => {
      window.__skew = 0;
      const now0 = performance.now.bind(performance);
      performance.now = () => now0() + window.__skew;
      window.__cls = 0;
      window.__shifts = [];
      try {
        new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) { window.__cls += e.value; window.__shifts.push(...(e.sources ?? []).map((s) => s.node?.id || s.node?.className || s.node?.nodeName || "?")); } }).observe({ type: "layout-shift", buffered: true });
      } catch {
        // 読めないブラウザは数えない
      }
      window.__keys = [];
      document.addEventListener("keydown", (e) => window.__keys.push(e.key), true);
    };
    const ls = (page) => page.evaluate(() => {
      const $ = (id) => document.getElementById(id);
      const shown = (n) => Boolean(n && n.getClientRects().length > 0 && getComputedStyle(n).visibility !== "hidden");
      const box = (n) => { const x = n.getBoundingClientRect(); return { top: Math.round(x.top + scrollY), h: Math.round(x.height), bottom: Math.round(x.bottom) }; };
      const b = $("typingBoard");
      return {
        state: b.dataset.state, kind: b.dataset.kind, lang: b.dataset.lang ?? null, text: b.dataset.text ?? null, line: b.dataset.line ?? null, lines: b.dataset.lines ?? null, partial: b.dataset.partial ?? null,
        rest: $("typingWord").dataset.rest, miss: $("typingWord").classList.contains("tp-miss"),
        head: shown($("typingHead")), headH: Math.round($("typingHead").getBoundingClientRect().height),
        select: shown($("typingText")), selectValue: $("typingText").value, selectText: $("typingText").selectedOptions[0]?.textContent ?? "", selectDisabled: $("typingText").disabled,
        title: shown($("typingTitle")) ? $("typingTitle").textContent : "", left: shown($("typingLeft")) ? $("typingLeft").textContent : "", stop: shown($("typingStop")), stopH: Math.round($("typingStop").getBoundingClientRect().height),
        timer: shown($("typingTimer")) ? $("typingTimer").textContent : "",
        term: shown($("typingTerm")) ? $("typingTerm").textContent : null, gloss: shown($("typingGloss")) ? $("typingGloss").textContent : null,
        next: $("typingNext").classList.contains("tp-upnext--empty") || !shown($("typingNext")) ? "" : $("typingNext").querySelector("b")?.textContent ?? "",
        hint: shown($("typingHint")) ? $("typingHint").textContent : "",
        error: shown($("typingError")) ? $("typingError").textContent : "",
        live: $("typingLive").textContent, lineText: $("typingLine").textContent,
        aria: $("input").getAttribute("aria-label"), desc: $("input").getAttribute("aria-describedby"),
        active: document.activeElement?.id || document.activeElement?.tagName.toLowerCase() || "",
        board: box(b), word: box($("typingWord")),
        note: shown($("typingTabNote")) ? $("typingTabNote").textContent : "",
        kindText: $("typingKind").textContent, kpm: $("typingKpm").textContent, pre: shown($("typingKpmPre")), unit: shown($("typingKpmUnit")),
        acc: $("typingAcc").textContent, best: shown($("typingBest")) ? $("typingBest").textContent : "",
        keys: shown($("typingKeys")) ? $("typingKeys").textContent : "", nextBtn: shown($("typingNextText")), study: $("typingStudyText").textContent,
        body: [...document.body.classList].filter((c) => /^(tp-long|romaji-answer|typing--live)/.test(c)).sort().join(" "),
        modal: Boolean(document.getElementById("feedbackModal") && !document.getElementById("feedbackModal").hidden),
        path: location.pathname, scroll: document.documentElement.scrollWidth, inner: innerWidth
      };
    });
    // 今の手本（#typingWord の data-rest）の頭を 1 打ずつ合成の keydown で送る（焦点のある要素へ）。n 打まで／その行の終わりまで（line）／結果まで。
    // leaveLast: 最後の行の最後の 1 打を残す。lower: 英字は小文字で送る（Shift なしの大文字）。map: 手本の字 → keydown の中身。gap: 打鍵の間（実時間 ms）。skewEach: 打鍵ごとに時計を進める ms
    const typeRest = (page, opts = {}) => page.evaluate(async ({ n = 1e9, line = false, leaveLast = false, lower = false, map = {}, gap = 0, skewEach = 0 }) => {
      const word = document.getElementById("typingWord");
      const board = document.getElementById("typingBoard");
      const startLine = board.dataset.line;
      let sent = 0;
      while (sent < n && board.dataset.state !== "result") {
        const rest = word.dataset.rest ?? "";
        if (!rest || (line && board.dataset.line !== startLine)) break;
        if (leaveLast && rest.length === 1 && Number(board.dataset.line) === Number(board.dataset.lines) - 1) break;
        const ch = rest[0];
        const init = map[ch] ?? { key: lower ? ch.toLowerCase() : ch };
        (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
        sent++;
        if (skewEach) window.__skew += skewEach;
        if (gap) await new Promise((r) => setTimeout(r, gap));
      }
      return sent;
    }, opts);
    const key = (page, init) => page.evaluate((o) => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...o })), init);
    const finishByKey = async (page, opts = {}) => {
      await typeRest(page, { ...opts, leaveLast: true });
      const last = (await ls(page)).rest;
      await page.keyboard.press(last.length === 1 ? (opts.lower ? last.toLowerCase() : last) : "x");
      await waitUntil(async () => (await ls(page)).state === "result", 3000);
    };
    const hide = (page) => page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const unhide = (page) => page.evaluate(() => {
      delete document.visibilityState;
      delete document.hidden;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const skew = (page, ms) => page.evaluate((v) => { window.__skew += v; }, ms);
    const clsOf = (page) => page.evaluate(() => ({ cls: Math.round(window.__cls * 10000) / 10000, shifts: window.__shifts.slice(-6) }));
    const waitL = (page, s, timeout = 5000) => waitUntil(async () => (await page.evaluate(() => document.getElementById("typingBoard").dataset.state)) === s, timeout);
    const bestStored = (page) => page.evaluate(() => { try { return JSON.parse(localStorage.getItem("spelldash_typing_practice")); } catch { return null; } });
    const snap = (page) => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith("spelldash_")).sort().map((k) => [k, localStorage.getItem(k)])));
    const motion = (page) => page.evaluate(() => new Promise((resolve) => {
      const t0 = performance.now();
      const names = () => document.getAnimations().map((a) => { const t = a.effect?.target; return t ? `${t.tagName.toLowerCase()}${t.id ? "#" + t.id : ""}.${[...t.classList].join(".")}` : "?"; });
      const step = () => { const list = names(); if (list.length === 0 || performance.now() - t0 > 500) resolve(list); else requestAnimationFrame(step); };
      requestAnimationFrame(step);
    }));
    const PRACTICE = JSON.stringify({ v: 1, best: { en: { 60: { kpm: 77, acc: 90, day: "2026-10-01" } }, ja: { 60: { kpm: 55, acc: 80, day: "2026-10-01" } } } });
    const LEARN = {
      spelldash_word_stats: JSON.stringify({ apple: { attempts: 3, correct: 2, misses: 1, lastSeen: "2026-10-01" } }),
      spelldash_typing_stats: JSON.stringify({ sessions: 2, keys: 120 }),
      spelldash_xp: "120",
      spelldash_key_miss: JSON.stringify({ l: 3 }),
      spelldash_typing_practice: PRACTICE
    };
    const s01 = byId["ja-s01"];
    const s02 = byId["ja-s02"];
    const anims = [];

    // ---- 1200 × 900 の 1 枚（?t=5&l=2）。長文の教材は 1 秒遅らせて届ける（遅い到着でも札が動かない） ----
    const page = await newPage({ viewport: { width: 1200, height: 900 }, storage: LEARN });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(PROBE);
    const hosts = new Set();
    const reqs = { typing: 0, long: 0 };
    page.on("request", (req) => {
      const u = new URL(req.url());
      hosts.add(u.host);
      if (u.pathname === "/data/typing.json") reqs.typing++;
      if (u.pathname === "/data/typing-long.json") reqs.long++;
    });
    await page.route("**/data/typing-long.json", async (route) => { await new Promise((r) => setTimeout(r, 1000)); await route.continue(); });
    await page.goto(BASE + "/typing.html?t=5&l=2", { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    const before = await snap(page);
    const o0 = await ls(page);
    check("typing long（1200）: 開いた直後は今のまま（英単語・apple・残り 5秒・始まる前の一文・焦点は入力欄・1 行目は出ない・入力欄の名前は語）、長文の教材はまだ取らない", o0.kind === "en" && o0.state === "ready" && o0.rest === "apple" && o0.timer === "残り 5秒" && o0.hint === "打ち始めると、5秒を測る。" && o0.active === "input" && !o0.head && o0.lang === null && o0.aria === "見本の語を打つ" && o0.desc === "typingTerm typingWord typingGloss" && reqs.long === 0, J({ o0, reqs }));

    // 長文のタブ → loading（高さは予約のまま）→ ready
    await page.click('.tp-tabs [data-kind="ja"]');
    await waitL(page, "ready");
    const ja0 = await ls(page);
    const cls0 = (await clsOf(page)).cls;
    await page.click('.tp-tabs [data-kind="long"]');
    const loadingSeen = await waitUntil(async () => (await ls(page)).state === "loading", 800, 20);
    await page.waitForTimeout(80); // reduced motion の 0.01ms の transition（game.css。欄の min-height も）が描き終えてから測る（教材は 1 秒後）
    const l0 = await ls(page);
    await waitL(page, "ready", 5000);
    await page.waitForTimeout(200); // 題と今の行の読み上げ（50ms 後）
    const l1 = await ls(page);
    const cls1 = await clsOf(page);
    const opts = await page.evaluate(() => [...document.querySelectorAll("#typingText optgroup")].map((g) => [g.label, [...g.querySelectorAll("option")].map((o) => [o.value, o.textContent])]));
    const optList = opts.flatMap(([, list]) => list);
    check("typing long（1200）: 長文のタブ → loading は無効の select「読み込み中」で、札の高さと今の行の位置は ready と同じ（1 秒遅れて届いても CLS 0）、英単語 → 日本語 → 長文で札の上端が同じ（T14 を 3 つのタブに）",
      loadingSeen && l0.kind === "long" && l0.lang === "ja" && l0.head && l0.select && l0.selectDisabled && l0.selectText === "読み込み中" && l0.headH === 44 && l0.board.h === l1.board.h && l0.word.top === l1.word.top && o0.board.top === ja0.board.top && ja0.board.top === l1.board.top && cls1.cls - cls0 < 0.001,
      J({ l0: { ...l0, live: undefined }, l1: { h: l1.board.h, word: l1.word }, tops: [o0.board.top, ja0.board.top, l1.board.top], cls0, cls1 }));
    check("typing long（1200）: ready — data-kind long・data-lang ja・data-text ja-s01、select の既定と 4 つの群（打鍵の少ない順の教材の並び）、項目は「題 N行」（行の数は教材の行の数。?l= でも替えない）・済みなし、1 行目の右は空、補足の行・今の行の見出し・次の行・始まる前の一文（17 字）",
      l1.state === "ready" && l1.kind === "long" && l1.lang === "ja" && l1.text === "ja-s01" && l1.line === "0" && l1.lines === "2" && l1.select && !l1.selectDisabled && l1.selectValue === "ja-s01" && l1.headH === 44 &&
      J(opts.map(([g]) => g)) === J(["日本語・短め", "日本語・長め", "英語・短め", "英語・長め"]) && J(optList.map(([v]) => v)) === J(LONG.map((t) => t.id)) && optList.every(([v, label]) => label === `${byId[v].title} ${byId[v].lines.length}行`) &&
      l1.left === "" && !l1.stop && l1.title === "" && l1.note === "文章を最後まで打つ。やめても結果が出る。" && l1.term === s01.lines[0][0] && l1.gloss === null && l1.next === s01.lines[1][0] && l1.hint === "打ち始めると、最後まで時間を測る。" && [...l1.hint].length === 17 && !l1.timer,
      J({ l1: { ...l1, live: undefined }, opts: opts.map(([g, list]) => [g, list.length]) }));
    check("typing long（1200）: 読み上げ — 入力欄の名前は「見本の文を打つ」・describedby は今の行（#typingLine「見出し（読み）」）、loading → ready で「題。」と今の行を 1 回、焦点は入力欄、長文の教材は 1 回だけ取る（typing.json も 1 回）",
      l1.aria === "見本の文を打つ" && l1.desc === "typingLine" && l1.lineText === lineOf(s01, 0) && l1.live === `${s01.title}。${lineOf(s01, 0)}` && l1.active === "input" && reqs.long === 1 && reqs.typing === 1,
      J({ aria: l1.aria, desc: l1.desc, lineText: l1.lineText, live: l1.live, active: l1.active, reqs }));
    anims.push(["ready", await motion(page)]);

    // 手本どおりに打つ（句読点は , .）。最初の 1 打で running、行を打ち切ると次の行、最後のキーですぐ結果
    const g0 = await ls(page);
    await page.keyboard.press(g0.rest[0]);
    await page.waitForTimeout(60); // reduced motion の 0.01ms の transition（game.css）が visibility を描き替え終えてから読む
    const r1 = await ls(page);
    check("typing long（1200）: 最初の 1 打で running、1 行目が題・残り（残り 2行）・やめる（Esc）に替わり、始まる前の一文は行の高さを残して隠れ、札の上端・高さと #typingWord の上端・1 行目の高さが前後で同じ",
      r1.state === "running" && r1.title === s01.title && r1.left === "残り 2行" && r1.stop && !r1.select && r1.hint === "" && r1.headH === 44 && r1.board.top === g0.board.top && r1.board.h === g0.board.h && r1.word.top === g0.word.top && r1.rest === g0.rest.slice(1),
      J({ r1: { ...r1, live: undefined }, g0: { board: g0.board, word: g0.word } }));
    await typeRest(page, { n: g0.rest.indexOf(",") - 1 });
    const atComma = await ls(page);
    await key(page, { key: "x" }); // 「、」の所で x はミス（打つはずだったキーは ,）
    const missed = await ls(page);
    const missMark = await page.evaluate(() => { const u = document.querySelector("#typingWord .tp-unit--now"); return u ? getComputedStyle(u).boxShadow : ""; });
    await typeRest(page, { line: true });
    const r2 = await ls(page);
    await page.waitForTimeout(150);
    const r2live = (await ls(page)).live;
    anims.push(["running", await motion(page)]);
    check("typing long（1200）: 「、」は , で打つ・「、」の所の x はミスで進まず印が残る、行を打ち切ると data-line・今の見出し・次の行・残り 1行が替わり、札も #typingWord の上端も動かない、読み上げは「次の行。」＋今の行",
      atComma.rest[0] === "," && missed.miss && missed.rest === atComma.rest && missMark !== "none" && missMark !== "" && r2.line === "1" && r2.term === s01.lines[1][0] && r2.next === "" && r2.left === "残り 1行" && r2.board.top === g0.board.top && r2.board.h === g0.board.h && r2.word.top === g0.word.top && r2.lineText === lineOf(s01, 1) && r2live === `次の行。${lineOf(s01, 1)}`,
      J({ atComma: atComma.rest.slice(0, 3), missed: [missed.miss, missed.rest.slice(0, 3)], missMark, r2: { ...r2, live: undefined }, r2live }));
    await skew(page, 20000);
    await finishByKey(page);
    const res = await ls(page);
    const stored1 = await bestStored(page);
    const resExtra = await page.evaluate(() => ({ lining: [...document.querySelectorAll("#typingKpm, #typingAcc b")].every((b) => getComputedStyle(b).fontVariantNumeric.includes("lining-nums")), order: [...document.querySelector(".tp-result__btns").children].map((n) => n.id), focusRing: getComputedStyle(document.getElementById("typingBoard")).boxShadow }));
    const correct1 = canonOf(s01.lines[0][1]).length + canonOf(s01.lines[1][1]).length;
    const acc1 = Math.floor((correct1 * 100) / (correct1 + 1));
    const kpm1 = Number(res.acc.match(/打\/分 (\d+)/)?.[1]);
    check("typing long（1200）: 最後のキーですぐ結果 — 柱は「題・時間」、主の数は「スコア N」（ラベルが先・lining）、補足は「打/分 N ・ 正確さ N% ・ ミス 1」、間違えたキーは「、」で出す、?l= の回なので自己ベストの句も記録も無い、ボタンは もう一度 → 次の文、焦点は主の数の行、読み上げの 1 文",
      res.state === "result" && res.partial === null && /^北風と太陽・2\d秒$/.test(res.kindText) && res.pre && !res.unit && /^\d+$/.test(res.kpm) && kpm1 > 0 && Number(res.kpm) < kpm1 && res.acc.includes(`正確さ ${acc1}%`) && res.acc.includes("ミス 1") && res.keys === "間違えたキー 、 1" && res.best === "" && stored1?.best?.long === undefined && resExtra.lining && J(resExtra.order) === J(["typingAgain", "typingNextText"]) && res.nextBtn && res.active === "typingKpmLine" && res.live === `スコア ${res.kpm}。${res.kindText.split("・")[1]}、打/分 ${kpm1}、正確さ ${acc1}%、ミス 1。` && res.study === "英単語も、打って覚える。日本語の訳だけを見て思い出して打つ。1日5分から。",
      J({ res: { ...res, live: res.live }, stored1, resExtra, correct1, acc1 }));
    const cls2 = await clsOf(page);
    anims.push(["result", await motion(page)]);
    await page.keyboard.press("Enter"); // 守りの 0.6 秒の中
    const gd1 = (await ls(page)).state;
    await page.waitForTimeout(700);
    await page.keyboard.press("Enter");
    const gd2 = await ls(page);
    await page.keyboard.press("Escape"); // 始まる前の Esc は何もしない
    const gd3 = await ls(page);
    await finishByKey(page);
    await page.waitForTimeout(700);
    await page.click("#typingNextText");
    const gd4 = await ls(page);
    check("typing long（1200）: 守りの 0.6 秒は Enter でやり直さず、過ぎた Enter で同じ文章の始まる前・始まる前の Esc は何もしない、次の文で select の次の文章（ja-s02）、行の送りと結果で CLS 0",
      gd1 === "result" && gd2.state === "ready" && gd2.text === "ja-s01" && gd2.line === "0" && gd2.active === "input" && gd3.state === "ready" && gd4.state === "ready" && gd4.text === "ja-s02" && gd4.selectValue === "ja-s02" && gd4.term === s02.lines[0][0] && cls2.cls - cls1.cls < 0.001,
      J({ gd1, gd2: [gd2.state, gd2.text, gd2.line, gd2.active], gd3: gd3.state, gd4: [gd4.state, gd4.text, gd4.selectValue], cls1, cls2 }));

    // Esc・やめる: 出す時間（最初に判定したキーから最後に判定したキーまで）が 5 秒未満なら始まる前、5 秒以上は途中の結果
    await typeRest(page, { n: 1 });
    await page.keyboard.press("Escape");
    const e1 = await ls(page);
    await typeRest(page, { n: 3 });
    await skew(page, 5000);
    await page.keyboard.press("Escape");
    const e2 = await ls(page);
    await typeRest(page, { n: 1 });
    await skew(page, 6000);
    await typeRest(page, { n: 1 });
    await page.keyboard.press("Escape");
    const e3 = await ls(page);
    const stored2 = await bestStored(page);
    await key(page, { key: "Escape", repeat: true });
    const e4 = (await ls(page)).state;
    await page.keyboard.press("Escape");
    const e5 = (await ls(page)).state;
    await page.waitForTimeout(700);
    await page.keyboard.press("Escape");
    const e6 = await ls(page);
    check("typing long（1200）: Esc — 1 打で Esc・3 打を一瞬で打って 5 秒待って Esc は始まる前（5 秒は出す時間で見る）、6 秒の 2 打で Esc は途中の結果（柱「途中まで 0／2行・6秒」・data-partial・句なし・記録なし・読み上げ）、押しっぱなしと守りの間の 2 回目の Esc では消えず、0.6 秒後の Esc で同じ文章の始まる前",
      e1.state === "ready" && e2.state === "ready" && e3.state === "result" && e3.partial === "1" && e3.kindText === `${s02.title}・途中まで 0／2行・6秒` && e3.best === "" && stored2?.best?.long === undefined && e3.live.startsWith("途中まで、2行のうち 0行。スコア ") && e4 === "result" && e5 === "result" && e6.state === "ready" && e6.text === "ja-s02" && e6.partial === null,
      J({ e1: e1.state, e2: e2.state, e3: [e3.state, e3.partial, e3.kindText, e3.best, e3.live], e4, e5, e6: [e6.state, e6.text] }));

    // 裏に回る → 止める（次の 1 打で続きから判定・止めていた間は時間に入らない）。止める → Space で続き → 判定せずに Esc は最後に判定したキーまで
    await typeRest(page, { n: 1 });
    await skew(page, 3000);
    await typeRest(page, { n: 1 });
    const clsP0 = (await clsOf(page)).cls;
    await hide(page);
    await page.waitForTimeout(60); // reduced motion の 0.01ms の transition（visibility）が描き替え終えてから読む
    const p1 = await ls(page);
    anims.push(["paused", await motion(page)]);
    await unhide(page);
    const clsP1 = (await clsOf(page)).cls;
    await skew(page, 60000);
    await typeRest(page, { n: 1 });
    const p2 = await ls(page);
    await skew(page, 3000);
    await typeRest(page, { n: 1 });
    await page.keyboard.press("Escape");
    const p3 = await ls(page);
    await page.waitForTimeout(700);
    await page.keyboard.press("Enter");
    await typeRest(page, { n: 1 });
    await skew(page, 6000);
    await typeRest(page, { n: 1 });
    await hide(page);
    await unhide(page);
    await skew(page, 60000);
    const q0 = await ls(page);
    await page.keyboard.press(" ");
    const q1 = await ls(page);
    await skew(page, 5000);
    await page.keyboard.press("Escape");
    const q2 = await ls(page);
    check("typing long（1200）: 裏に回ると止まり（paused・始まる前の一文の場所に「止めた。打つと続きから。」・読み上げ・札は動かない）、次の 1 打で続きからそのキーも判定、止めていた 60 秒は時間に入らない（6秒）／止める → Space で続き（判定しない）→ 判定せずに Esc で、時間は最後に判定したキーまで（6秒。負にならない）",
      p1.state === "paused" && p1.hint === "止めた。打つと続きから。" && p1.live === "止めた。打つと続きから。" && p1.left === "残り 2行" && clsP1 - clsP0 < 0.001 && p2.state === "running" && p2.rest === p1.rest.slice(1) && p3.state === "result" && p3.kindText === `${s02.title}・途中まで 0／2行・6秒` &&
      q0.state === "paused" && q1.state === "running" && q1.rest === q0.rest && q2.state === "result" && q2.kindText === `${s02.title}・途中まで 0／2行・6秒`,
      J({ p1: [p1.state, p1.hint, p1.live, p1.left], cls: [clsP0, clsP1], p2: [p2.state, p2.rest.slice(0, 4), p1.rest.slice(0, 4)], p3: p3.kindText, q: [q0.state, q1.state, q1.rest === q0.rest, q2.kindText] }));

    // ご意見の窓をマウスで開く → 止める。閉じると焦点は窓を開いたボタン → 字で続きから（焦点は入力欄へ）
    await page.waitForTimeout(700);
    await page.keyboard.press("Enter");
    await typeRest(page, { n: 1 });
    await page.click("[data-feedback-open]");
    const f1 = await ls(page);
    await page.keyboard.press("Escape");
    const f2 = await ls(page);
    await page.keyboard.press(f2.rest[0]);
    const f3 = await ls(page);
    check("typing long（1200）: ご意見の窓をマウスで開くと止まる、閉じても止めたまま（焦点は窓を開いたボタン）、字で続きからそのキーも判定し焦点は入力欄へ",
      f1.state === "paused" && f1.modal && f2.state === "paused" && !f2.modal && f2.active !== "input" && f3.state === "running" && f3.rest === f2.rest.slice(1) && f3.active === "input",
      J({ f1: [f1.state, f1.modal], f2: [f2.state, f2.modal, f2.active], f3: [f3.state, f3.active] }));

    // 打っている間: タブ・ご意見の上の Space／Enter は押させない。日本語の長文で「やめる」の上の Space は押させず、Enter・detail 0 のクリックはやめる（5 秒以上 → 途中の結果）
    await page.focus('.tp-tabs [data-kind="en"]');
    await page.keyboard.press(" ");
    await page.keyboard.press("Enter");
    const t1 = await ls(page);
    await page.focus("[data-feedback-open]");
    await page.keyboard.press(" ");
    await page.keyboard.press("Enter");
    const t2 = await ls(page);
    await page.focus("#typingStop");
    await page.keyboard.press(" ");
    const t3 = await ls(page);
    await skew(page, 6000);
    await typeRest(page, { n: 1 }); // 焦点が「やめる」の上でも字は数える
    const t3b = await ls(page);
    await page.focus("#typingStop");
    await page.keyboard.press("Enter");
    const t4 = await ls(page);
    await page.waitForTimeout(700);
    await page.keyboard.press("Enter");
    await typeRest(page, { n: 1 });
    await skew(page, 6000);
    await typeRest(page, { n: 1 });
    await page.evaluate(() => document.getElementById("typingStop").click()); // detail 0（Tab で来て Enter・支援技術が出すクリック）
    const t5 = await ls(page);
    check("typing long（1200）: 打っている間、焦点がタブ・ご意見の上の Space／Enter では回が消えず窓も開かない、「やめる」の上の Space は押させない（日本語）・字は数える、「やめる」の上の Enter と detail 0 のクリックは途中の結果",
      t1.state === "running" && t1.kind === "long" && t2.state === "running" && !t2.modal && t3.state === "running" && t3b.rest === t3.rest.slice(1) && t4.state === "result" && t4.partial === "1" && t5.state === "result" && t5.partial === "1",
      J({ t1: [t1.state, t1.kind], t2: [t2.state, t2.modal], t3: t3.state, t3b: t3b.rest === t3.rest.slice(1), t4: [t4.state, t4.partial], t5: [t5.state, t5.partial] }));

    // タブ（マウス）で回を捨てる・英単語に戻ると入力欄の名前と describedby が元に戻る・長文に戻ると選んだ文章のまま（教材は取り直さない）
    await page.waitForTimeout(700);
    await page.keyboard.press("Enter");
    await typeRest(page, { n: 1 });
    await page.click('.tp-tabs [data-kind="en"]');
    const t6 = await ls(page);
    await page.click('.tp-tabs [data-kind="long"]');
    const t7 = await ls(page);
    check("typing long（1200）: 打っている間に英単語のタブで回を捨てて英単語の始まる前（入力欄の名前・describedby は語に戻る・長文の class は外れる・1 行目は出ない）、長文のタブに戻ると同じ文章の始まる前（教材は 1 回だけ）",
      t6.kind === "en" && t6.state === "ready" && t6.aria === "見本の語を打つ" && t6.desc === "typingTerm typingWord typingGloss" && !t6.body.includes("tp-long") && !t6.head && t6.lang === null && t7.kind === "long" && t7.state === "ready" && t7.text === "ja-s02" && t7.aria === "見本の文を打つ" && reqs.long === 1,
      J({ t6: [t6.kind, t6.state, t6.aria, t6.desc, t6.body, t6.head], t7: [t7.kind, t7.state, t7.text], reqs }));

    // select: 押しても焦点を奪わない、矢印 2 回で 2 つ先（焦点は select のまま）、select の上の Enter で札へ、ポインタで選ぶと焦点は札へ
    await page.focus("#typingText");
    await page.evaluate(() => document.getElementById("typingText").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })));
    const s1 = await ls(page);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    const s2 = await ls(page);
    await page.keyboard.press("Enter");
    const s3 = await ls(page);
    await page.evaluate(() => {
      const s = document.getElementById("typingText");
      s.focus();
      s.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
      s.value = "ja-s01";
      s.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const s4 = await ls(page);
    const ids = LONG.map((t) => t.id);
    check("typing long（1200）: select を押しても焦点を奪わない、ArrowDown 2 回で 2 つ先の文章の始まる前（焦点は select のまま）、select の上の Enter で焦点は入力欄、ポインタで選ぶと焦点は入力欄",
      s1.active === "typingText" && s2.state === "ready" && s2.text === ids[ids.indexOf("ja-s02") + 2] && s2.active === "typingText" && s3.active === "input" && s3.text === s2.text && s4.text === "ja-s01" && s4.active === "input",
      J({ s1: s1.active, s2: [s2.state, s2.text, s2.active], s3: [s3.active, s3.text], s4: [s4.text, s4.active] }));
    check("typing long（1200）: reduced motion で動きが 0（始まる前・打っている間・止めた・結果）", anims.length >= 4 && anims.every(([, list]) => list.length === 0), J(anims));
    const after = await snap(page);
    const ALLOWED = (k) => k === "spelldash_typing_practice" || k === "spelldash_device_id" || k.startsWith("spelldash_funnel_") || k === "spelldash_billing_open";
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k] && !ALLOWED(k));
    const mainText = await page.evaluate(() => document.querySelector("main").textContent);
    const own = new URL(BASE).host;
    check("typing long（1200）: 学習記録を変えない（変わってよいのは自己ベストと計測のキーだけ。?l= の回なので自己ベストも同じ）・Pro とはちゃんを出さない・要求はすべて同一オリジン・エラー 0",
      changed.length === 0 && after.spelldash_typing_practice === PRACTICE && !mainText.includes("Pro") && !mainText.includes("はちゃん") && [...hosts].every((h) => h === own) && page.errors.length === 0,
      J({ changed, practice: after.spelldash_typing_practice, hosts: [...hosts], errors: page.errors.slice(0, 3) }));
    await page.close();

    // ---- 完走と自己ベスト（?l= なし）: 待ちなしの完走（1 秒未満）は「―」で記録なし、1 打 40ms で打ち切ると「はじめての記録」と best.long["ja-s01"] だけ ----
    {
      const p = await newPage({ viewport: { width: 1200, height: 900 } });
      await p.addInitScript(PROBE);
      await p.goto(BASE + "/typing.html", { waitUntil: "networkidle" });
      await p.evaluate((v) => localStorage.setItem("spelldash_typing_practice", v), PRACTICE); // newPage の storage は読み込み直しのたびに書き戻すので、開いたあとに入れる
      await p.click('.tp-tabs [data-kind="long"]');
      await waitL(p, "ready");
      await finishByKey(p);
      const fast = await ls(p);
      const storedFast = await bestStored(p);
      await p.waitForTimeout(700);
      await p.keyboard.press("Enter");
      await finishByKey(p, { gap: 40 });
      const full = await ls(p);
      const storedFull = await bestStored(p);
      await p.waitForTimeout(700);
      await p.keyboard.press("Enter");
      const done = await ls(p);
      await p.reload({ waitUntil: "networkidle" });
      await p.click('.tp-tabs [data-kind="long"]');
      await waitL(p, "ready");
      const reopened = await ls(p);
      const rec = storedFull?.best?.long?.["ja-s01"];
      check("typing long: 待ちなしで打ち切った回（1 秒未満）はスコア・打/分が「―」で記録を書かない",
        fast.state === "result" && fast.kpm === "―" && fast.acc.startsWith("打/分 ― ・ 正確さ 100% ・ ミス 0") && fast.best === "" && storedFast?.best?.long === undefined && fast.keys === "",
        J({ fast: [fast.state, fast.kpm, fast.acc, fast.best], storedFast }));
      check("typing long: ?l= なしで ja-s01 を 1 打 40ms で打ち切ると「自己ベスト（はじめての記録）」、増えるのは best.long[\"ja-s01\"] だけ（keys は教材の keys・打/分は検証の範囲）・best.en／best.ja は同じ、select に「済み」、読み込み直して長文のタブを押すと既定は次の文章",
        full.state === "result" && full.best === " ・ 自己ベスト（はじめての記録）" && J(Object.keys(storedFull?.best?.long ?? {})) === '["ja-s01"]' && rec?.keys === s01.keys && Number.isInteger(rec?.score) && rec.score > 0 && rec.kpm <= 2000 && rec.sec >= 1 && J(storedFull.best.en) === J(JSON.parse(PRACTICE).best.en) && J(storedFull.best.ja) === J(JSON.parse(PRACTICE).best.ja) &&
        done.state === "ready" && done.selectText === `済み ${s01.title} ${s01.lines.length}行` && reopened.text === "ja-s02" && reopened.selectValue === "ja-s02" && p.errors.length === 0,
        J({ full: [full.state, full.kpm, full.best], storedFull, done: done.selectText, reopened: [reopened.text, reopened.selectValue], errors: p.errors.slice(0, 2) }));
      await p.close();
    }

    // ---- 英語の長文（?l=16 で en-l01）: Shift なしの大文字・IME オンの Space・Quote・Shift＋Digit7・Shift＋Slash、行の頭の空白は飲む、間違えたキーの「空白」、
    // ご意見の窓を閉じたあと・.tp-more の上でも Space は空白として判定 ----
    {
      const en = byId["en-l01"];
      const p = await newPage({ viewport: { width: 1200, height: 900 } });
      await p.addInitScript(PROBE);
      await p.goto(BASE + "/typing.html?l=16", { waitUntil: "networkidle" });
      await p.click('.tp-tabs [data-kind="long"]');
      await waitL(p, "ready");
      await p.focus("#typingText");
      await p.selectOption("#typingText", "en-l01");
      const a0 = await ls(p);
      await p.keyboard.press("Enter");
      const a1 = await ls(p);
      const css = await p.evaluate(() => { const s = getComputedStyle(document.getElementById("typingWord")); return { ws: s.whiteSpace, ow: s.overflowWrap, ls: s.letterSpacing, ff: s.fontFamily }; });
      const PROCESS = { key: "Process", keyCode: 229 };
      await typeRest(p, { n: 3, lower: true }); // How → h o w（Shift なし）
      await key(p, { ...PROCESS, code: "Space" }); // IME オンの Space
      const a2 = await ls(p);
      await typeRest(p, { line: true, lower: true, map: { "?": { ...PROCESS, code: "Slash", shiftKey: true } } });
      const a3 = await ls(p);
      await key(p, { key: " " }); // 行の頭の空白は飲む
      const a4 = await ls(p);
      await typeRest(p, { n: 4, lower: true }); // When
      await key(p, { key: "x" }); // 空白の所に字はミス（打つはずだったキーは空白）
      const a5 = await ls(p);
      await typeRest(p, { line: true });
      // 3 行目: 字の後ろに空白が来る所まで → ご意見の窓をマウスで開いて閉じる → 字で続きから → 焦点がボタンでも Space は空白 → Tab で .tp-more へ → Space は空白
      await typeRest(p, { n: 1, lower: true }); // I（次は空白）
      await typeRest(p, { n: 1 }); // 空白
      await typeRest(p, { n: 3 }); // kee（次は p、その次が空白）
      await p.click("[data-feedback-open]");
      const b1 = await ls(p);
      await p.keyboard.press("Escape");
      const b2 = await ls(p);
      await p.keyboard.press(b2.rest[0]);
      const b3 = await ls(p);
      await p.focus("[data-feedback-open]");
      await p.keyboard.press(" ");
      const b4 = await ls(p);
      await typeRest(p, { n: 1 }); // a
      await p.focus("#input");
      await p.keyboard.press("Tab");
      const b5 = await ls(p);
      const onMore = await p.evaluate(() => document.activeElement?.matches(".tp-more a") ?? false);
      await p.keyboard.press(" ");
      const b6 = await ls(p);
      await p.focus("#input");
      // 8 行目の can't は Process＋Quote、15 行目の don't は Process＋Shift＋Digit7 で ' を打つ
      for (let i = 0; i < 16 && (await ls(p)).state !== "result"; i++) {
        const lineNo = Number((await ls(p)).line);
        const apos = lineNo === 15 ? { ...PROCESS, code: "Digit7", shiftKey: true } : { ...PROCESS, code: "Quote" };
        if (lineNo === 15) {
          await finishByKey(p, { lower: true, map: { "'": apos } });
          break;
        }
        await typeRest(p, { line: true, lower: true, map: { "'": apos } });
      }
      const a6 = await ls(p);
      check("typing long（英語）: select で英語の文章（焦点は select のまま、Enter で入力欄）、data-lang en・英語の class（3 段目つき・ローマ字の class なし）、訳が出て見出しは出ない、#typingWord は等幅・語の途中で折らない（pre-wrap・break-word）・字間 0、本体への文は英単語の文",
        a0.lang === "en" && a0.text === "en-l01" && a0.active === "typingText" && a1.active === "input" && a0.body === "tp-long-en typing--live" && a0.gloss === en.lines[0][1] && a0.term === null && a0.next === en.lines[1][0] && css.ws === "pre-wrap" && css.ow === "break-word" && (css.ls === "0px" || css.ls === "normal") && /Plex Mono/.test(css.ff) && a0.study === "日本語の訳だけを見て、英単語を思い出して打つ。1日5分から。" && a0.lineText === lineOf(en, 0),
        J({ a0: [a0.lang, a0.text, a0.active, a0.body, a0.gloss, a0.term, a0.next], a1: a1.active, css }));
      check("typing long（英語）: 大文字は Shift なしの小文字で通る、IME オンの Space（Process＋Space）・Shift＋Slash の ? が通る、行の頭の空白は数えない（ミスにもしない）、空白の所の字はミス",
        a2.state === "running" && a2.rest === en.lines[0][0].slice(4) && a3.line === "1" && a4.rest === en.lines[1][0] && !a4.miss && a5.miss && a5.rest === en.lines[1][0].slice(4),
        J({ a2: a2.rest, a3: a3.line, a4: [a4.rest, a4.miss], a5: [a5.miss, a5.rest] }));
      check("typing long（英語）: ご意見の窓をマウスで開いて閉じた（焦点はボタン）→ 字で続きから（焦点は入力欄）→ 焦点がご意見のボタンでも Space は空白として判定（窓は開かない）→ Tab で .tp-more に移しても Space は空白（移動しない）",
        b1.state === "paused" && b1.modal && b2.state === "paused" && b2.active !== "input" && b3.state === "running" && b3.active === "input" && b3.rest === b2.rest.slice(1) && b3.rest[0] === " " && b4.rest === b3.rest.slice(1) && !b4.modal && b4.state === "running" && onMore && b6.rest === b5.rest.slice(1) && b5.rest[0] === " " && b6.path === "/typing.html" && b6.state === "running",
        J({ b1: [b1.state, b1.modal], b2: [b2.state, b2.active], b3: [b3.state, b3.active, b3.rest.slice(0, 5)], b4: [b4.rest.slice(0, 5), b4.modal], onMore, b5: b5.rest.slice(0, 5), b6: [b6.rest.slice(0, 5), b6.path] }));
      check("typing long（英語）: Process＋Quote・Process＋Shift＋Digit7 の ' で打ち切れ、結果の間違えたキーは「空白 1」・ミス 1",
        a6.state === "result" && a6.keys === "間違えたキー 空白 1" && a6.acc.includes("ミス 1") && p.errors.length === 0,
        J({ a6: [a6.state, a6.keys, a6.acc, a6.kindText], errors: p.errors.slice(0, 2) }));
      await p.close();
    }

    // ---- typing.json が読めず長文は読める組: 長文の loading が英単語の error に書き替わらず、長文を完走すると結果（error に落ちない）。英単語のタブは今どおり error ----
    {
      const p = await newPage({ viewport: { width: 1200, height: 900 } });
      await p.route("**/data/typing.json", async (route) => { await new Promise((r) => setTimeout(r, 1200)); await route.abort(); });
      await p.route("**/data/typing-long.json", async (route) => { await new Promise((r) => setTimeout(r, 2400)); await route.continue(); });
      await p.goto(BASE + "/typing.html?l=1", { waitUntil: "domcontentloaded" });
      await p.click('.tp-tabs [data-kind="long"]');
      await p.waitForTimeout(1800);
      const w1 = await ls(p);
      await waitL(p, "ready", 5000);
      await finishByKey(p);
      const w2 = await ls(p);
      await p.waitForTimeout(700);
      await p.click('.tp-tabs [data-kind="en"]');
      const w3 = await ls(p);
      check("typing long: typing.json が読めず長文は読める組 — 長文の loading は「単語を読み込めなかった」に書き替わらず、長文を完走すると結果、英単語のタブは今どおり error",
        w1.state === "loading" && w1.kind === "long" && w1.error === "" && w2.state === "result" && w3.kind === "en" && w3.state === "error" && w3.error.startsWith("単語を読み込めなかった") && p.errors.length === 0,
        J({ w1: [w1.state, w1.kind, w1.error], w2: w2.state, w3: [w3.kind, w3.state, w3.error], errors: p.errors.slice(0, 2) }));
      await p.close();
    }
    // ---- 長文の教材が読めない: 長文だけ error（1 行目は出さない・開き直すのリンク）、英単語は打てる ----
    {
      const p = await newPage({ viewport: { width: 1200, height: 900 } });
      await p.route("**/data/typing-long.json", (route) => route.abort());
      await p.goto(BASE + "/typing.html", { waitUntil: "networkidle" });
      await p.click('.tp-tabs [data-kind="long"]');
      await waitL(p, "error", 3000);
      const x1 = await ls(p);
      const link = await p.evaluate(() => document.querySelector("#typingError a")?.getAttribute("href"));
      await p.click('.tp-tabs [data-kind="en"]');
      const x2a = await ls(p);
      await p.keyboard.press(x2a.rest[0]);
      const x2 = await ls(p);
      check("typing long: 長文の教材が読めないと長文だけ「長文を読み込めなかった。通信を確かめて、開き直す。」（1 行目・始まる前の一文は出さない）、英単語のタブは打てる",
        x1.state === "error" && x1.kind === "long" && x1.error === "長文を読み込めなかった。通信を確かめて、開き直す。" && link === "./typing.html" && !x1.head && x1.hint === "" && !x1.body.includes("tp-long") && x2a.state === "ready" && x2.kind === "en" && x2.state === "running" && x2.rest === x2a.rest.slice(1) && p.errors.length === 0,
        J({ x1: [x1.state, x1.kind, x1.error, x1.head, x1.hint, x1.body], link, x2: [x2.kind, x2.state, x2.rest], errors: p.errors.slice(0, 2) }));
      await p.close();
    }
    // ---- localStorage が投げる端末: 長文を打てる（自己ベストの句・済みは出ない） ----
    {
      const p = await newPage({ viewport: { width: 1200, height: 900 } });
      await p.addInitScript(PROBE);
      await p.addInitScript(() => {
        Storage.prototype.getItem = () => { throw new Error("denied"); };
        Storage.prototype.setItem = () => { throw new Error("denied"); };
      });
      await p.goto(BASE + "/typing.html", { waitUntil: "networkidle" });
      const errors0 = p.errors.length; // head の theme の 1 行（ほかのページと同じ）が投げる分。長文の流れでは増えない
      await p.click('.tp-tabs [data-kind="long"]');
      await waitL(p, "ready");
      const y0 = await ls(p);
      await finishByKey(p, { skewEach: 40 });
      const y1 = await ls(p);
      const noDone = await p.evaluate(() => [...document.querySelectorAll("#typingText option")].every((o) => !o.textContent.startsWith("済み")));
      check("typing long: localStorage が投げる端末でも長文を最後まで打て、結果は出るが自己ベストの句と「済み」は出ない（ページのエラーは増えない）",
        y0.state === "ready" && y0.text === "ja-s01" && y1.state === "result" && /^\d+$/.test(y1.kpm) && y1.best === "" && noDone && p.errors.length === errors0,
        J({ y0: [y0.state, y0.text], y1: [y1.state, y1.kpm, y1.best], noDone, errors: p.errors.slice(0, 2) }));
      await p.close();
    }

    // ---- タッチ端末 390 × 844（設定は「オフ」）: 盤面・足したキー・やめる・1 行目の高さ ----
    {
      const p = await newPage({ mobile: true, viewport: { width: 390, height: 844 }, storage: { spelldash_osk: "off" } });
      await p.addInitScript(PROBE);
      await p.route("**/data/typing-long.json", async (route) => { await new Promise((r) => setTimeout(r, 800)); await route.continue(); });
      await p.goto(BASE + "/typing.html", { waitUntil: "networkidle" });
      await p.waitForTimeout(300);
      const osk = () => p.evaluate(() => {
        const shown = (sel) => { const n = document.querySelector(sel); return Boolean(n && n.getClientRects().length > 0 && getComputedStyle(n).display !== "none" && !n.closest("[hidden]")); };
        const list = (sel) => [...document.querySelectorAll(sel)].filter((n) => n.getClientRects().length > 0).map((n) => n.dataset.key ?? n.dataset.action);
        const box = document.getElementById("osk").getBoundingClientRect();
        return { osk: shown("#osk"), open: document.body.classList.contains("osk-open"), row3: shown("#osk .osk__row--3"), dash: shown('#osk [data-action="dash"]'), ja: list("#osk .tp-osk-key--ja"), en: list("#osk .tp-osk-key--en"), row3keys: list("#osk .osk__row--3 .osk__key"), h: Math.round(box.height), top: Math.round(box.top), labels: [...document.querySelectorAll("#osk .tp-osk-key")].map((n) => n.getAttribute("aria-label")) };
      });
      const k0 = await osk();
      await p.tap('.tp-tabs [data-kind="long"]');
      await p.waitForTimeout(150);
      const k1 = await osk();
      const st1 = (await ls(p)).state;
      await waitL(p, "ready", 4000);
      await p.waitForTimeout(200);
      const k2 = await osk();
      const m0 = await ls(p);
      await p.dispatchEvent(`#osk [data-key="${m0.rest[0]}"]`, "pointerdown");
      const m1 = await ls(p);
      await typeRest(p, { n: m0.rest.indexOf(",") - 1 });
      const m2 = await ls(p);
      await p.dispatchEvent('#osk .tp-osk-key--ja[data-key=","]', "pointerdown");
      const m3 = await ls(p);
      await p.evaluate(() => { window.__keys = []; });
      await p.dispatchEvent('#osk .tp-osk-key--ja[data-key="."]', "pointerdown");
      const jaSent = await p.evaluate(() => window.__keys.slice());
      check("typing long（390）: 長文のタブで盤面が出る（設定「オフ」でも）、英単語から替えても loading で盤面を畳まない、日本語の長文は 3 段目に ー・、・。（読点・句点）、、は , を送り、。は . を送る",
        k0.osk && st1 === "loading" && k1.osk && k1.open && k2.osk && k2.row3 && k2.dash && J(k2.ja) === '[",","."]' && k2.en.length === 0 && m1.state === "running" && m2.rest[0] === "," && m3.rest === m2.rest.slice(1) && J(jaSent) === '["."]',
        J({ k0: k0.osk, st1, k1: [k1.osk, k1.open], k2, m1: m1.state, m2: m2.rest.slice(0, 3), m3: m3.rest.slice(0, 3), jaSent }));
      check("typing long（390）: 最初の 1 打の前後で 1 行目の高さ（44px）と #typingWord の上端が同じ（select 44px → やめる 40px）、札は盤面の上",
        m0.headH === 44 && m1.headH === 44 && m0.word.top === m1.word.top && m0.board.top === m1.board.top && m1.stop && m1.stopH === 40 && m0.board.bottom <= k2.top,
        J({ m0: [m0.headH, m0.word, m0.board], m1: [m1.headH, m1.word, m1.board, m1.stopH], oskTop: k2.top }));
      // やめる（タップ・5 秒以上）→ 途中の結果。守りの 0.6 秒は盤面を出したまま・タブは押せない
      await skew(p, 6000);
      await typeRest(p, { n: 1 });
      await p.tap("#typingStop");
      const v1 = await ls(p);
      const guard = await p.evaluate(() => new Promise((resolve) => {
        const reach = (sel) => { const n = document.querySelector(sel); let hit = false; const h = (e) => { hit = true; e.preventDefault(); }; n.addEventListener("click", h); n.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })); n.removeEventListener("click", h); return hit; };
        const out = {};
        setTimeout(() => (out.at300 = { osk: !document.getElementById("osk").hidden, tab: reach(".tp-tabs button"), next: reach("#typingNextText") }), 300);
        setTimeout(() => { out.at700 = { osk: !document.getElementById("osk").hidden }; resolve(out); }, 700);
      }));
      await p.tap("#typingAgain");
      const v2 = await ls(p);
      check("typing long（390）: 「やめる」をタップ（5 秒以上）で途中の結果、守りの 0.6 秒は盤面を出したまま・盤面の外（タブ・次の文）は押しても届かない、その後に畳む",
        v1.state === "result" && v1.partial === "1" && guard.at300.osk && !guard.at300.tab && !guard.at300.next && !guard.at700.osk && v2.state === "ready",
        J({ v1: [v1.state, v1.partial], guard, v2: v2.state }));
      // 英語の長文: 3 段目に ' , 空白 . ?（空白は data-key=" "）。押すとその字が打たれる
      await p.selectOption("#typingText", "en-s01");
      await p.waitForTimeout(150);
      const k3 = await osk();
      const n0 = await ls(p);
      await p.dispatchEvent('#osk [data-key="a"]', "pointerdown"); // After の A を小文字で
      for (const c of "fter") await p.dispatchEvent(`#osk [data-key="${c}"]`, "pointerdown");
      await p.dispatchEvent('#osk .tp-osk-key--en[data-key=" "]', "pointerdown");
      const n1 = await ls(p);
      await p.evaluate(() => { window.__keys = []; });
      for (const c of ["'", ",", ".", "?"]) await p.dispatchEvent(`#osk .tp-osk-key--en[data-key="${c}"]`, "pointerdown");
      const enSent = await p.evaluate(() => window.__keys.slice());
      check("typing long（390）: 英語の長文は 3 段目に ' , 空白 . ?（名前つき・ー と 、。は出ない）、a f t e r と空白のキーで After と空白が打たれ、ほかの記号のキーもその字を送る",
        n0.lang === "en" && k3.row3 && !k3.dash && J(k3.en) === `["'",","," ",".","?"]` && k3.ja.length === 0 && J(k3.labels) === J(["読点", "句点", "アポストロフィ", "カンマ", "空白", "ピリオド", "疑問符"]) && n1.state === "running" && n1.rest === byId["en-s01"].lines[0][0].slice(6) && J(enSent) === `["'",",",".","?"]`,
        J({ k3, n1: [n1.state, n1.rest.slice(0, 6)], enSent }));
      // 英単語に戻ると長文の class が外れ 3 段目が出ない、日本語は今のまま（ー あり・、。なし）、盤面の高さは日本語の長文と同じ
      await p.tap('.tp-tabs [data-kind="en"]');
      await p.waitForTimeout(150);
      const k4 = await osk();
      const body4 = (await ls(p)).body;
      await p.tap('.tp-tabs [data-kind="ja"]');
      await p.waitForTimeout(150);
      const k5 = await osk();
      check("typing long（390）: 英単語のタブに戻ると tp-long-ja・tp-long-en が外れ 3 段目が出ない、日本語のタブは今のまま（ー あり・長文のキーなし）、盤面の高さは日本語の 1 分と日本語の長文で同じ（--osk-h は変えない）",
        !body4.includes("tp-long") && k4.osk && !k4.row3 && k5.row3 && k5.dash && k5.ja.length === 0 && k5.en.length === 0 && k5.h === k2.h && p.errors.length === 0,
        J({ body4, k4: [k4.osk, k4.row3], k5: [k5.row3, k5.dash, k5.ja, k5.en, k5.h], k2h: k2.h, errors: p.errors.slice(0, 2) }));
      await p.close();
    }

    // ---- 全 20 編の全行を 1 行ずつ描く（ゲームの「全文の行数と札の高さ」と同じ作り）: 行数の上限・札の高さが文章と行と言語によらず同じ・#typingWord の上端が同じ。
    // 盤面のある窓では、寄せたあと札の下端と今の行の下端が盤面の上端以下。390・360・320 ではタブ 3 つと補足と始まる前の一文が 1 行・横スクロールなし ----
    {
      const VIEWS = [
        ["390", { width: 390, height: 844 }, { units: 3, term: 2, en: 3, gloss: 2 }],
        ["360", { width: 360, height: 740 }, { units: 3, term: 2, en: 3, gloss: 2 }],
        ["320", { width: 320, height: 720 }, { units: 3, term: 2, en: 3, gloss: 2 }],
        ["1200", { width: 1200, height: 900 }, { units: 2, term: 1, en: 2, gloss: 1 }],
        ["844x390", { width: 844, height: 390 }, { units: 2, term: 0, en: 2, gloss: 0 }],
        ["667x375", { width: 667, height: 375 }, { units: 2, term: 0, en: 2, gloss: 0 }],
        ["375x667", { width: 375, height: 667 }, { units: 3, term: 2, en: 3, gloss: 2 }],
        ["360x640", { width: 360, height: 640 }, { units: 3, term: 2, en: 3, gloss: 2 }],
        ["375x560", { width: 375, height: 560 }, { units: 3, term: 2, en: 3, gloss: 2 }],
        ["320x568", { width: 320, height: 568 }, { units: 3, term: 2, en: 3, gloss: 2 }]
      ];
      const over = [];
      const fit = [];
      const narrow = [];
      const heads = [];
      let measured = 0;
      let alt = 0;
      let spaces = 0;
      const kinsoku = []; // 句読点の単位が行の頭に来た行・句読点の単位の幅と入れ物の違反
      const livePunct = []; // ページが描いた今の行（ready の ja-s01 の 1 行目）の句読点の単位
      let punctSeen = 0;
      let jaMeasured = 0;
      for (const [name, viewport, lim] of VIEWS) {
        const mobile = name !== "1200";
        const p = await newPage({ mobile, viewport });
        await p.goto(BASE + "/typing.html", { waitUntil: "networkidle" });
        await p.waitForTimeout(200);
        await (mobile ? p.tap('.tp-tabs [data-kind="long"]') : p.click('.tp-tabs [data-kind="long"]'));
        await waitL(p, "ready");
        await p.waitForTimeout(250); // 寄せ（50ms 後）
        const fitOf = () => p.evaluate(() => {
          const osk = document.getElementById("osk");
          const top = osk && !osk.hidden ? osk.getBoundingClientRect().top : Infinity;
          const word = document.getElementById("typingWord");
          const inner = word.classList.contains("tp-word--ja") ? Math.max(...[...word.querySelectorAll(".tp-unit")].map((u) => u.getBoundingClientRect().bottom)) : (() => { const r = document.createRange(); r.selectNodeContents(word); return Math.max(...[...r.getClientRects()].map((x) => x.bottom)); })();
          return { board: Math.round(document.getElementById("typingBoard").getBoundingClientRect().bottom), line: Math.round(inner), osk: Math.round(top), header: Math.round(document.querySelector(".site-header").getBoundingClientRect().bottom), boardTop: Math.round(document.getElementById("typingBoard").getBoundingClientRect().top) };
        });
        const fja = await fitOf();
        livePunct.push([name, await p.evaluate(() => {
          const word = document.getElementById("typingWord");
          const units = [...word.querySelectorAll(".tp-unit")];
          const punct = units.filter((u) => /^[、。]$/.test(u.querySelector(".tp-unit__kana").textContent));
          return { punct: punct.length, paired: punct.filter((u) => u.classList.contains("tp-unit--punct") && u.parentElement.classList.contains("tp-unit-pair") && u.previousElementSibling?.classList.contains("tp-unit") && u.parentElement.parentElement === word).length, pairs: word.querySelectorAll(".tp-unit-pair").length };
        })]);
        if (name === "390" || name === "360" || name === "320") {
          narrow.push([name, await p.evaluate(() => {
            const lines = (n) => { const r = document.createRange(); r.selectNodeContents(n); return new Set([...r.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top))).size; };
            const tabs = [...document.querySelectorAll(".tp-tabs .stats-tab")].map((t) => Math.round(t.getBoundingClientRect().top));
            return { tabs: new Set(tabs).size, tabLines: [...document.querySelectorAll(".tp-tabs .stats-tab")].map(lines), note: lines(document.getElementById("typingTabNote")), hint: lines(document.getElementById("typingHint")), scroll: document.documentElement.scrollWidth <= innerWidth };
          })]);
        }
        const res = await p.evaluate(async ({ texts, lim }) => {
          const D = await import("/js/typingDrill.js");
          const K = await import("/js/typingKeys.js");
          const R = await import("/js/romaji.js");
          const board = document.getElementById("typingBoard");
          const word = document.getElementById("typingWord");
          const term = document.getElementById("typingTerm");
          const gloss = document.getElementById("typingGloss");
          const osk = document.getElementById("osk");
          const oskTop = osk && !osk.hidden ? osk.getBoundingClientRect().top : Infinity;
          const tops = (rects) => new Set([...rects].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size;
          const textLines = (n) => { if (getComputedStyle(n).display === "none" || n.hidden) return 0; const r = document.createRange(); r.selectNodeContents(n); return tops(r.getClientRects()); };
          const pageTop = (n) => Math.round(n.getBoundingClientRect().top + scrollY);
          const bad = [];
          const kin = [];
          const h0 = Math.round(board.getBoundingClientRect().height);
          const wordTop = {};
          let n = 0;
          let altN = 0;
          let spaceN = 0;
          let punctN = 0;
          let jaN = 0;
          const drawJa = (t, r, typed) => {
            word.className = "tp-word tp-word--ja";
            word.setAttribute("lang", "ja"); // ページの renderWord と同じ（字の選び方が lang で替わりうる）
            word.replaceChildren();
            K.appendUnits(word, D.japaneseUnits(r, typed, { punct: true }).units, { punct: true }); // ページと同じ（句読点の単位を直前の単位とつなぐ）
            term.hidden = false;
            term.textContent = t;
            gloss.hidden = true;
          };
          // 行頭禁則: 句読点の単位（、。）の上端は直前の単位の上端と同じ（行の頭に来ない）。幅はかなの字の大きさの 0.6 倍以下（全角の箱でない）、
          // キーの , . はかなの下の中央（±1px）、直前の単位と 1 つの入れ物（.tp-unit-pair）
          const checkPunct = (id, label) => {
            const units = [...word.querySelectorAll(".tp-unit")];
            units.forEach((u, i) => {
              const kana = u.querySelector(".tp-unit__kana");
              if (!/^[、。]$/.test(kana.textContent)) return;
              punctN++;
              const r = u.getBoundingClientRect();
              const kr = kana.getBoundingClientRect();
              const yr = u.querySelector(".tp-unit__keys").getBoundingClientRect();
              const size = parseFloat(getComputedStyle(kana).fontSize);
              const prev = units[i - 1];
              const head = !prev || Math.round(prev.getBoundingClientRect().top) !== Math.round(r.top);
              const paired = u.classList.contains("tp-unit--punct") && u.parentElement.classList.contains("tp-unit-pair") && u.previousElementSibling === prev;
              if (head || !paired || r.width > size * 0.6 || Math.abs((kr.left + kr.right) / 2 - (yr.left + yr.right) / 2) > 1) kin.push(`${id} ${label}（${head ? "行の頭" : ""}${paired ? "" : "入れ物なし"} 幅 ${Math.round(r.width)}／字 ${size}）`);
            });
          };
          for (const text of texts) {
            board.dataset.lang = text.lang;
            for (const [a, b] of text.lines) {
              let u = 0;
              let tl = 0;
              let low = 0;
              if (text.lang === "ja") {
                drawJa(a, b, "");
                checkPunct(text.id, b);
                jaN++;
                u = tops([...word.querySelectorAll(".tp-unit")].map((x) => x.getBoundingClientRect()));
                tl = textLines(term);
                low = Math.max(...[...word.querySelectorAll(".tp-unit")].map((x) => x.getBoundingClientRect().bottom));
              } else {
                word.className = "tp-word";
                word.setAttribute("lang", "en");
                word.replaceChildren(Object.assign(document.createElement("span"), { className: "tp-now", textContent: a[0] }), document.createTextNode(a.slice(1)));
                term.hidden = true;
                gloss.hidden = false;
                gloss.textContent = b;
                u = textLines(word);
                tl = textLines(gloss);
                const r = document.createRange();
                r.selectNodeContents(word);
                low = Math.max(...[...r.getClientRects()].map((x) => x.bottom));
                // 語の途中で折れない: 各語の矩形の上端が 1 つ
                const node = word.lastChild;
                let pos = 0;
                for (const w of a.slice(1).split(" ")) {
                  const range = document.createRange();
                  const start = Math.max(0, pos);
                  range.setStart(node, start);
                  range.setEnd(node, Math.min(node.length, start + w.length));
                  if (w && tops(range.getClientRects()) > 1) bad.push(`${text.id} 語が折れた「${w}」`);
                  pos = start + w.length + 1;
                }
              }
              const h = Math.round(board.getBoundingClientRect().height);
              const wt = pageTop(word);
              wordTop[text.lang] ??= wt;
              const limU = text.lang === "ja" ? lim.units : lim.en;
              const limT = text.lang === "ja" ? lim.term : lim.gloss;
              if (u > limU || tl > limT || Math.abs(h - h0) > 1 || Math.abs(wt - wordTop[text.lang]) > 1 || low > oskTop + 0.5) bad.push(`${text.id} ${a}（行 ${u}・${text.lang === "ja" ? "見出し" : "訳"} ${tl}・札 ${h0}→${h}・上端 ${wordTop[text.lang]}→${wt}${oskTop < Infinity ? `・下端 ${Math.round(low)}／盤面 ${Math.round(oskTop)}` : ""}）`);
              // 英語で今の字が空白（行の折り目の空白も）: 行数は上限のまま、下線の付く空白に幅があって札の中（pre-wrap。SPEC §2.4）
              if (text.lang === "en") {
                for (let i = 1; i < a.length; i++) {
                  if (a[i] !== " ") continue;
                  word.replaceChildren(Object.assign(document.createElement("span"), { className: "tp-done", textContent: a.slice(0, i) }), Object.assign(document.createElement("span"), { className: "tp-now", textContent: " " }), document.createTextNode(a.slice(i + 1)));
                  const nb = word.querySelector(".tp-now").getBoundingClientRect();
                  const bb = board.getBoundingClientRect();
                  const lines = textLines(word);
                  if (lines > lim.en || nb.width < 1 || nb.left < bb.left || nb.right > bb.right - 1 || Math.abs(Math.round(bb.height) - h0) > 1) bad.push(`${text.id} 空白の位置 ${i}（行 ${lines}・下線 ${Math.round(nb.left)}〜${Math.round(nb.right)}／札 ${Math.round(bb.left)}〜${Math.round(bb.right)}）`);
                  spaceN++;
                }
              }
              n++;
              // 別の綴り（きょ を kixyo・し を si）で途中まで打った単位の行数
              if (text.lang === "ja" && /きょ|し/.test(b)) {
                const canon = R.canonicalRomaji(b, { finalN: true, punct: true });
                const other = canon.replace("kyo", "kixyo").replace("shi", "si");
                const m = R.createRomajiMatcher([b], { punct: true });
                if (other !== canon && m.type(other).missAt === -1) {
                  const cut = other.slice(0, Math.ceil(other.length / 2));
                  drawJa(a, b, cut);
                  checkPunct(text.id, cut);
                  const u2 = tops([...word.querySelectorAll(".tp-unit")].map((x) => x.getBoundingClientRect()));
                  const h2 = Math.round(board.getBoundingClientRect().height);
                  if (u2 > lim.units || Math.abs(h2 - h0) > 1) bad.push(`${text.id} ${cut}（別の綴りの途中で行 ${u2}・札 ${h0}→${h2}）`);
                  altN++;
                }
              }
            }
          }
          return { bad, kin, n, altN, spaceN, punctN, jaN, h0 };
        }, { texts: LONG, lim });
        kinsoku.push(...res.kin.map((b) => `${name}: ${b}`));
        punctSeen += res.punctN;
        jaMeasured += res.jaN;
        measured += res.n;
        alt += res.altN;
        spaces += res.spaceN;
        over.push(...res.bad.map((b) => `${name}: ${b}`));
        // 英語の文章に替えて（toReady・寄せ）、札の下端と今の行の下端
        await p.selectOption("#typingText", "en-s04");
        await p.waitForTimeout(250);
        const fen = await fitOf();
        const hEn = await p.evaluate(() => Math.round(document.getElementById("typingBoard").getBoundingClientRect().height));
        if (fja.osk < Infinity || fen.osk < Infinity) fit.push([name, fja, fen]);
        if (Math.abs(hEn - res.h0) > 1) over.push(`${name}: 英語の文章の札 ${hEn}（日本語 ${res.h0}）`);
        // 横向き（高さ ≤480）・背の低い縦向き（481〜650）: 始まる前 → 最初の 1 打 → 裏に回って止める → 続き の 4 つで、1 行目の高さ（34px／44px）・札の高さ・今の行の上端が同じ。
        // 止めたは始まる前の一文の行が無いので「残り N行」の場所に「止めた」（SPEC §2.8）。始まる前の一文と次の行は出さない
        if (viewport.height <= 650) {
          const headOf = () => p.evaluate(() => {
            const $ = (id) => document.getElementById(id);
            const shown = (n) => Boolean(n && n.getClientRects().length > 0 && getComputedStyle(n).visibility !== "hidden");
            const pausedEl = document.querySelector("#typingHead .tp-head__paused");
            const h = (n) => (shown(n) ? Math.round(n.getBoundingClientRect().height) : 0);
            return { state: $("typingBoard").dataset.state, head: h($("typingHead")), select: h($("typingText")), stop: h($("typingStop")), left: shown($("typingLeft")) ? $("typingLeft").textContent : "", paused: shown(pausedEl) ? pausedEl.textContent : "", hint: shown($("typingHint")), next: shown($("typingNext")), word: Math.round($("typingWord").getBoundingClientRect().top + scrollY), board: Math.round($("typingBoard").getBoundingClientRect().height) };
          });
          const h0 = await headOf();
          await typeRest(p, { n: 1 });
          const h1 = await headOf();
          await hide(p);
          const h2 = await headOf();
          await unhide(p);
          await typeRest(p, { n: 1 });
          const h3 = await headOf();
          heads.push([name, viewport.height <= 480 ? 34 : 44, h0, h1, h2, h3]);
        }
        if (p.errors.length) over.push(`${name}: ${p.errors[0]}`);
        await p.close();
      }
      const total = LONG.reduce((s, t) => s + t.lines.length, 0);
      check(`typing long: 全 20 編の全行（${total} 行 × ${VIEWS.length} の窓 = ${measured} 回、別の綴りの途中 ${alt} 回、英語の今の字が空白 ${spaces} 回）が予約した行数に収まる（390・360・320・背の低い縦向き: 単位 ≤3・見出し ≤2・英語 ≤3・訳 ≤2／1200: 2・1・2・1／横向き: 単位・英語 ≤2）、札の高さは文章・行・言語によらず同じ、#typingWord の上端が同じ、英語は語の途中で折れず、今の字が空白（行の折り目も）でも下線に幅があって札の中、盤面のある窓では今の行が盤面の上`,
        over.length === 0 && measured === total * VIEWS.length && alt > 0 && spaces > 0, over.slice(0, 8).join(" | "));
      const jaTotal = LONG.filter((t) => t.lang === "ja").reduce((s, t) => s + t.lines.length, 0);
      const badLive = livePunct.filter(([, v]) => !(v.punct === 2 && v.paired === 2 && v.pairs === 2));
      check(`typing long: どの行も句読点の単位（、。）が行の頭に来ない（行頭禁則。全 20 編の日本語 ${jaTotal} 行 × ${VIEWS.length} の窓・別の綴りの途中も、句読点 ${punctSeen} か所）: 句読点の単位は直前の単位と 1 つの入れ物（.tp-unit-pair）で、幅はかなの字の大きさの 0.6 倍以下（全角の箱でない）、キーの , . はかなの下の中央。ページが描く今の行（ja-s01 の 1 行目の 、 と 。）も同じ入れ物`,
        kinsoku.length === 0 && jaMeasured === jaTotal * VIEWS.length && punctSeen > jaMeasured && livePunct.length === VIEWS.length && badLive.length === 0, (kinsoku.slice(0, 6).join(" | ") || "") + (badLive.length ? ` live ${J(badLive)}` : ""));
      const badFit = fit.filter(([, a, b]) => !(a.board <= a.osk && a.line <= a.osk && b.board <= b.osk && b.line <= b.osk && a.boardTop >= a.header && b.boardTop >= b.header));
      check("typing long: 寄せたあと、札の下端と今の行の下端が盤面の上端以下・札の上端はヘッダーの下（390×844・375×667・360×640・375×560・320×568・844×390・667×375・360×740・320×720、日本語と英語）",
        fit.length === VIEWS.length - 1 && badFit.length === 0, J(badFit.length ? badFit : fit.map(([n]) => n)));
      check("typing long（390・360・320）: タブ 3 つが 1 行（どのタブも 1 行）・補足の行が 1 行・始まる前の一文が 1 行・横スクロールなし",
        narrow.length === 3 && narrow.every(([, v]) => v.tabs === 1 && v.tabLines.every((x) => x === 1) && v.note === 1 && v.hint === 1 && v.scroll), J(narrow));
      const badHead = heads.filter(([, want, h0, h1, h2, h3]) => {
        const all = [h0, h1, h2, h3];
        return !(h0.state === "ready" && h1.state === "running" && h2.state === "paused" && h3.state === "running" &&
          all.every((h) => h.head === want && !h.hint && !h.next && h.word === h0.word && h.board === h0.board) &&
          h0.select > 0 && h0.select <= want && h1.stop > 0 && h1.stop <= want && h2.stop > 0 && h2.stop <= want &&
          /^残り \d+行$/.test(h1.left) && h1.paused === "" && h2.left === "" && h2.paused === "止めた" && h3.left === h1.left && h3.paused === "");
      });
      check("typing long（横向き 844×390・667×375／背の低い縦向き 375×560・320×568・360×640）: 1 行目は横向き 34px・背の低い縦向き 44px（select・やめる もその中）、始まる前・最初の 1 打・止めた・続きで 1 行目と札の高さ・今の行の上端が同じ、止めたは「残り N行」の場所に「止めた」、始まる前の一文と次の行は出さない",
        heads.length === 5 && badHead.length === 0, J(badHead.length ? badHead : heads.map(([n, w, h0]) => [n, w, h0.head, h0.select])));
    }

    // ---- 静的（ファイルを読むだけ） ----
    {
      const html = fs.readFileSync(path.join(ROOT, "typing.html"), "utf8");
      const meta = (re) => html.match(re)?.[1] ?? "";
      const TITLE = "タイピング練習（英単語・ローマ字・長文）無料 | SpellDash";
      const desc = meta(/<meta name="description" content="([^"]*)"/);
      const about = html.match(/<section class="tp-about"[\s\S]*?<\/section>/)?.[0] ?? "";
      const newsSrc = fs.readFileSync(path.join(ROOT, "js", "news.js"), "utf8");
      const newsItem = (title) => { const i = newsSrc.indexOf(`title: "${title}"`); return i < 0 ? "" : newsSrc.slice(newsSrc.lastIndexOf("{", i), newsSrc.indexOf("}", i)); };
      const longNews = newsItem("タイピング練習に長文");
      check("typing long: title・og:title・description（登録なし・1分・長文・文章・スマホ）と og が同じ・canonical、lead、このページについて（長文タイピング・読点「、」は ,（カンマ）・本体への導線は 1 つ）、お知らせは題「タイピング練習に長文」の 1 件に ./typing.html（ゲームへのリンクなし）",
        html.includes(`<title>${TITLE}</title>`) && meta(/<meta property="og:title" content="([^"]*)"/) === TITLE && desc === meta(/<meta property="og:description" content="([^"]*)"/) && ["登録なし", "1分", "長文", "文章", "スマホ"].every((w) => desc.includes(w)) && html.includes('<link rel="canonical" href="https://www.spelldash.net/typing.html" />') &&
        html.includes('<p class="subtitle">英単語は訳つき。長文も打てる。登録なし・無料。</p>') && about.includes("長文タイピングは") && about.includes("読点「、」は ,（カンマ）") && about.includes("打/分は、1分あたりに正しく打ったキーの数。") && (about.match(/data-typing-study/g) ?? []).length === 1 &&
        longNews.includes('href=\\"./typing.html\\"') && !longNews.includes("typing-game.html") && longNews.includes('lead: "日本語と英語の文章を最後まで打つ長文を足した。"'),
        J({ desc, longNews: longNews.slice(0, 80) }));
      const css = fs.readFileSync(path.join(ROOT, "css", "typing.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      // 規則ごとのセレクタ（@media の中も）。長文だけの部品（1 行目・組・句読点の単位とその入れ物・始まる前の一文の隠し・結果のボタン・画面キーボードのキー）を指すのに長文の頭が無いものを漏れとする
      const splitSel = (x) => { const out = []; let depth = 0; let cur = ""; for (const ch of x) { if (ch === "(") depth++; if (ch === ")") depth--; if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch; } out.push(cur); return out.map((y) => y.trim()); };
      const sels = css.split("}").map((r) => { const parts = r.split("{"); return parts.length >= 2 ? parts[parts.length - 2] : ""; }).flatMap(splitSel).filter(Boolean);
      const PREFIX = /\.tp-board\[data-kind="long"\]|\.tp-long-(ja|en)/;
      const LONG_ONLY = /tp-head|tp-pair|tp-unit-pair|tp-unit--punct|tp-hint--off|tp-result__btns|tp-result__pre|tp-osk-key/;
      const longRules = sels.filter((x) => PREFIX.test(x));
      const leak = sels.filter((x) => LONG_ONLY.test(x) && !PREFIX.test(x));
      check("typing long: typing.css の長文の規則は .tp-board[data-kind=\"long\"] か tp-long-ja／tp-long-en を挟む（英単語・日本語に漏らさない）、animation／transition／@keyframes なし、999px・var(--radius)・rgba(0,0,0・#FFF なし、visibility の例外の注釈は 3 つ",
        longRules.length >= 20 && leak.length === 0 && !/\b(animation|transition)(-[a-z]+)?\s*:/.test(css) && !css.includes("@keyframes") && ![/\b999px/, /var\(--radius\)/, /var\(--radius-lg\)/, /rgba\(0,\s*0,\s*0/, /#(?:FFF|fff)(?![0-9A-Fa-f])/].some((re) => re.test(css)) && fs.readFileSync(path.join(ROOT, "css", "typing.css"), "utf8").includes("visibility の 3 つ"),
        J(leak.slice(0, 3)));
      const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
      const kb = fs.readFileSync(path.join(ROOT, "js", "keyboard.js"), "utf8") + fs.readFileSync(path.join(ROOT, "css", "keyboard.css"), "utf8");
      const funnelSrc = fs.readFileSync(path.join(ROOT, "js", "funnelLog.js"), "utf8");
      check("typing long: typing.html は js/typingLong.js を先読み（modulepreload）、data/typing-long.json は head で先読みせず sw の precache にも入れない、keyboard.js・keyboard.css に tp-osk-key が無い（ページが足す）、計測の source に typing_long・typing_long_start・typing_long_done（32 字以内）",
        html.includes('<link rel="modulepreload" href="./js/typingLong.js" />') && !html.includes("typing-long.json") && !sw.includes("typing-long.json") && !kb.includes("tp-osk-key") && ["typing_long", "typing_long_start", "typing_long_done"].every((s) => funnelSrc.includes(`"${s}"`) && s.length <= 32));
      // 木によく知られたタイピングサイトの名前が無い（名前は符号で持つ。英字の名は class 名 page-typing に部分一致するので、語の前の境目を後読みで見る。片仮名の名も見る）
      const NAME = String.fromCodePoint(0x65, 0x2d, 0x74, 0x79, 0x70, 0x69, 0x6e, 0x67);
      const KANA = String.fromCodePoint(0x30a4, 0x30fc, 0x30bf, 0x30a4, 0x30d4, 0x30f3, 0x30b0);
      const NAME_RE = new RegExp(`(?<![a-z])${NAME.replace("-", "\\-")}`, "i");
      const files = [];
      const walk = (dir, exts) => { for (const f of fs.readdirSync(dir)) { const full = path.join(dir, f); const st = fs.statSync(full); if (st.isDirectory()) { if (!["node_modules", ".git", "sources", "packs", "english", "android", "ios"].includes(f)) walk(full, exts); } else if (exts.test(f)) files.push(full); } };
      for (const f of fs.readdirSync(ROOT)) if (/\.html$/.test(f)) files.push(path.join(ROOT, f));
      walk(path.join(ROOT, "css"), /\.css$/);
      walk(path.join(ROOT, "js"), /\.js$/);
      walk(path.join(ROOT, "scripts"), /\.(mjs|js|jsonl|txt|json)$/);
      walk(path.join(ROOT, "docs"), /\.md$/);
      walk(path.join(ROOT, "tests"), /\.mjs$/);
      const named = files.filter((f) => { const t = fs.readFileSync(f, "utf8"); return NAME_RE.test(t) || t.includes(KANA); });
      check(`typing long: 木（html・css・js・scripts の jsonl・txt も・docs・tests）によく知られたタイピングサイトの名前が無い（${files.length} ファイル）`, files.length > 100 && named.length === 0, named.slice(0, 5).map((f) => path.relative(ROOT, f)).join(" "));
    }
  }
}

// ===== 7.6 タイピングゲーム（/typing-game.html。docs/SPEC_TYPING_GAME.md。Batch 60）: 教材・進行・持ち時間・数え方・自己ベスト（Node）／
// 1200 の 1 枚を使い回す（?t=6&s=2）／タッチ端末 390 の 1 枚（?t=4&s=2。320・360 も）／横向き 844×390・844×340／全文の行数／静的 =====
console.log("typing game:");
{
  const G = await import("../js/typingGame.js");
  const T = await import("../js/typingDrill.js");
  const BG = await import("../scripts/build-typing-game.mjs");

  // ---- Node だけで見るもの ----
  const built = BG.buildTypingGameData();
  const gameText = fs.readFileSync(path.join(ROOT, "data", "typing-game.json"), "utf8");
  const gameJson = JSON.parse(gameText);
  const gameBad = BG.validateTypingGameData(gameJson);
  const counts = Object.fromEntries(["short", "normal", "long"].map((c) => [c, gameJson.courses[c].length]));
  check(`typing game: 教材は生成物と同じ（node scripts/build-typing-game.mjs）・条件を満たす（目標の定数も）・数（短 ≥200／ふつう ≥250／長 ≥150。${counts.short}／${counts.normal}／${counts.long}）`, built.text === gameText && gameBad.length === 0 && counts.short >= 200 && counts.normal >= 250 && counts.long >= 150, gameBad.slice(0, 5).join(" | "));
  const allRows = ["short", "normal", "long"].flatMap((c) => gameJson.courses[c].map(([t, r]) => ({ c, t, r })));
  {
    const bad = [];
    const seenT = new Set();
    const seenR = new Set();
    for (const { c, t, r } of allRows) {
      const band = G.COURSES[c].band;
      const kana = [...r].length;
      if (!/^[ぁ-んー]+$/.test(r) || /[ゐゑゎ]/.test(r)) bad.push(`読み ${r}`);
      if (kana < band[0] || kana > band[1]) bad.push(`帯 ${c} ${r}`);
      if (seenT.has(t) || seenR.has(r)) bad.push(`重複 ${t}`);
      seenT.add(t);
      seenR.add(r);
      if (!/^[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}ー々、]+$/u.test(t) || (c !== "long" && t.includes("、")) || [...t].length > kana + 2) bad.push(`見出し ${t}`);
      if (BG.kanaOrderMiss(t, r)) bad.push(`かなの順 ${t}`);
    }
    check("typing game: 読みは ひらがな＋ー・帯の中・重複なし・見出しの字種と長さ・見出しのかなが読みに順に現れる", bad.length === 0, bad.slice(0, 5).join(" "));
  }
  {
    const bad = [];
    for (const { r } of allRows) {
      const keys = canonicalRomaji(r, { finalN: true });
      const m = keys ? matchRomaji([{ reading: r, display: r }], keys) : null;
      if (!m || m.missAt !== -1 || !m.done || /[xl]/.test(keys)) { bad.push(`打てない ${r}`); continue; }
      const w = T.createWord("ja", ["", r]);
      for (let g = 0; g < 80 && !w.matcher.state().done; g++) {
        const v = w.view();
        if (v.units.map((u) => u.kana).join("") !== r) { bad.push(`かなの行 ${r}:${w.matcher.keys}`); break; }
        w.feed(v.rest[0]);
      }
      if (!w.matcher.state().done) bad.push(`終わらない ${r}`);
    }
    check(`typing game: 全文（${allRows.length}）を手本どおりに打ち切れ（手本に x・l なし）、毎打鍵かなの行が読みと同じ`, bad.length === 0, bad.slice(0, 5).join(" "));
  }
  {
    const lim = [G.limitMs("short", "おはよう"), G.limitMs("normal", "きょうはいいてんきだ"), G.limitMs("long", "あさのひかりがさしこむまどのそばでゆっくりとこーひーをのむ"), G.limitMs("short", "あい"), G.limitMs("normal", "x", 2)];
    const secs = ["?t=6", "?t=90", "", "?t=0", "?t=91", "?t=2.5"].map((s) => G.secondsFrom(s));
    const ls = ["?s=2", "?s=0", "?s=10", ""].map((s) => G.limitSecondsFrom(s));
    const r1 = G.createGameRun({ sentences: [["県", "けん"]], seconds: 1, limit: () => 2000 });
    r1.start(0);
    const r2 = G.createGameRun({ sentences: [], seconds: 1, limit: () => 2000 });
    r2.start(1000);
    r2.add([["海", "うみ"]], 2000);
    const ratios = [r1.remainingRatio(500), r1.remainingRatio(1000), r2.remainingRatio(2000)];
    // 目標は切り捨て（参照 2.5 打/秒の人が 90 秒で取り切れる数）。平均 48.1 打 → 4.58 → 4、24.6 打 → 8.79 → 8
    const goals = [G.goalFor("short"), G.goalFor("normal"), G.goalFor("long"), G.goalFor("normal", 6), G.goalFor("short", 60), G.goalFromAverage(48.1), G.goalFromAverage(24.6), G.goalFromAverage(10.1)];
    check("typing game: 持ち時間は 1.5 秒＋係数×打鍵（短 0.60／ふつう 0.50／長 0.42）、4〜30 秒に丸め、?s= で一律、?t= は 1〜90 だけ、線の残り比の境界（0 除算で NaN にならない）、目標は切り捨て（20／8／4）", JSON.stringify(lim) === "[5100,9500,24600,4000,2000]" && JSON.stringify(secs) === "[6,90,90,90,90,90]" && JSON.stringify(ls) === "[2,null,null,null]" && JSON.stringify(ratios) === "[0.5,0,0]" && JSON.stringify(goals) === "[20,8,4,1,13,4,8,20]", JSON.stringify({ lim, secs, ls, ratios, goals }));
  }
  {
    const r = G.createGameRun({ sentences: [["県", "けん"], ["柿", "かき"], ["海", "うみ"], ["山", "やま"]], seconds: 90, limit: () => 2000 });
    r.start(0);
    const ken = ["k", "e", "n"].map((k, i) => r.press(k, 100 * (i + 1)).type);
    const d1 = r.deadline;
    const late = r.press("a", 2400); // 締切 2300 のあと → 流してから捨てる
    const s1 = { lost: r.lost, cur: r.current?.reading, miss: r.stats.miss, correct: r.stats.correct, flowedAt: r.flowedAt };
    const g500 = r.press("x", 2900); // 流れて 500ms・うみ の 1 打目として通らない → 数えない
    const g650 = r.press("x", 3050); // 650ms（猶予の外）→ ミス
    const u = r.press("u", 3100);
    const fl = r.settle(4700); // うみ の締切 4300 → 流れる。やま の締切は 4300+2000
    const back = r.settle(4600); // 過去の時刻 → 巻き戻さない
    // 猶予は時間だけで切る: 流れて 100ms に新しい文の 1 打目（通る）→ 200ms に外れたキー → 数えない
    const q = G.createGameRun({ sentences: [["県", "けん"], ["海", "うみ"], ["山", "やま"]], seconds: 90, limit: () => 2000 });
    q.start(0);
    q.settle(2000);
    const qa = q.press("u", 2100).type;
    const qb = q.press("x", 2200).type;
    // 時計（rAF・timer）は締切に気づいてから 50ms の余白で流す: 締切の前に押したキーは、少し遅れて届いても数える
    const sl = G.createGameRun({ sentences: [["県", "けん"], ["柿", "かき"], ["海", "うみ"]], seconds: 90, limit: () => 2000 });
    sl.start(0);
    for (const [k, t] of [["k", 100], ["e", 200], ["n", 300]]) sl.press(k, t);
    const slack = sl.settle(2340, G.SETTLE_SLACK_MS); // かき の締切 2300＋40
    const early = sl.press("k", 2290).type;
    // 流れたあと文が無い（教材が届く前の最初の文）: 猶予の中のキーで落ちない
    const nul = G.createGameRun({ sentences: [G.FIRST_SENTENCE], seconds: 90, limit: () => 2000 });
    nul.start(0);
    let nulType = "";
    try {
      nul.press("a", 2100);
      nulType = nul.press("b", 2300).type;
    } catch (e) {
      nulType = `投げた ${e.message}`;
    }
    const ok = ken.join() === "correct,correct,correct" && d1 === 2300 && late.type === "dropped" && s1.lost === 1 && s1.cur === "うみ" && s1.miss === 0 && s1.correct === 3 && s1.flowedAt === 2400 &&
      g500.type === "dropped" && g650.type === "miss" && u.type === "correct" && r.stats.miss === 1 && fl.flowed === 1 && r.lost === 2 && r.current?.reading === "やま" && back.flowed === 0 && r.deadline === 6300 && r.lastSettledAt === 4700 &&
      qa === "correct" && qb === "dropped" && q.stats.miss === 0 && slack.flowed === 0 && early === "correct" && sl.lost === 0 && nulType === "ignored";
    check("typing game: 進行 — 取れた・流れた・締切のあとのキーは捨てる・流れてから 0.6 秒は通らないキーを数えない（時間だけで切る）・猶予を過ぎた外れたキーはミス・2 文続けて流れても持ち時間は同じ・settle は巻き戻らない・時計の余白 50ms・文が無いときも落ちない", ok, JSON.stringify({ ken, d1, late, s1, g500, g650, u, fl, back, deadline: r.deadline, last: r.lastSettledAt, qa, qb, slack, early, nulType }));
  }
  {
    const r = G.createGameRun({ sentences: [["県", "けん"], ["柿", "かき"]], seconds: 1, limit: () => 2000 });
    r.start(0);
    r.press("k", 100);
    const e = r.press("e", 1000);
    check("typing game: 90 秒が切れたときの打ちかけは取れた／流れたのどちらにも入らない・そのキーは捨てる", e.type === "ended" && r.got === 0 && r.lost === 0 && r.stats.correct === 1 && r.ended, JSON.stringify({ e, got: r.got, lost: r.lost, stats: r.stats }));
  }
  {
    const a = G.createGameRun({ sentences: [["県", "けん"], ["柿", "かき"]], seconds: 90, limit: () => 2000 });
    a.start(0);
    let t = 0;
    for (const k of "kennkaki") a.press(k, (t += 50));
    const b = G.createGameRun({ sentences: [["県", "けん"], ["海", "うみ"], ["柿", "かき"]], seconds: 90, limit: () => 2000 });
    b.start(0);
    for (const [k, at] of [["k", 100], ["e", 150], ["n", 200]]) b.press(k, at);
    const d = b.deadline;
    b.settle(d);
    const cur = b.current?.reading;
    const n = b.press("n", d + 700);
    const w = T.createRun("ja", [["柿", "かき"], ["海", "うみ"]]);
    w.press("k", 0);
    w.press("x", 1);
    const before = w.missPending;
    w.skip();
    check("typing game: 語末の ん の持ち越し（文 → 文）と、流れた（skip）あとに続きとミスの印が残らない", a.stats.miss === 0 && a.got === 2 && b.got === 1 && cur === "かき" && n.type === "miss" && b.stats.miss === 1 && before && !w.missPending && w.current?.reading === "うみ" && w.stats.miss === 1 && w.stats.words === 0, JSON.stringify({ a: [a.got, a.stats.miss], cur, n, b: b.stats.miss, before, after: w.missPending }));
  }
  {
    const s = G.summarizeGame({ got: 10, lost: 2, stats: { correct: 252, miss: 13 } }, "normal", 90);
    const s7 = G.summarizeGame({ got: 7, lost: 2, stats: { correct: 252, miss: 13 } }, "normal", 90);
    const z = G.summarizeGame({ got: 0, lost: 0, stats: { correct: 0, miss: 0 } }, "short", 90);
    check("typing game: 集計 — 打/分は 90 秒で round(correct×60÷90)、正確さ切り捨て、目標 8文に届いた／あと N", s.kpm === 168 && s.accuracy === 95 && s.goal === 8 && s.reached && s.unit === "文" && !s7.reached && z.accuracy === null && z.unit === "語句" && z.goal === 20, JSON.stringify({ s, s7, z }));
  }
  {
    const fake = (init = {}) => {
      const map = new Map(Object.entries(init));
      return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), map };
    };
    const PRACTICE = JSON.stringify({ v: 1, best: { en: { 60: { kpm: 100 } } } });
    const prev = { got: 8, lost: 1, kpm: 160 };
    const cmp = [G.compareGameBest(null, 0, 0), G.compareGameBest(null, 3, 100), G.compareGameBest(prev, 10, 150), G.compareGameBest(prev, 8, 172), G.compareGameBest(prev, 8, 160), G.compareGameBest(prev, 8, 150), G.compareGameBest(prev, 5, 200)];
    const s = fake({ spelldash_typing_practice: PRACTICE });
    G.writeGameBest(s, "short", 90, { got: 12, lost: 0, kpm: 120, acc: 99 });
    const w6 = G.writeGameBest(s, "normal", 6, { got: 1, lost: 0, kpm: 160, acc: 94 });
    const broken = (rec) => G.readGameBest(fake({ [G.BEST_KEY]: JSON.stringify({ v: 1, best: { normal: { 90: rec } } }) }), "normal", 90);
    const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    const ok = cmp.map((c) => c.status).join() === "none,first,new,faster,same,same,below" && cmp[2].prev.got === 8 && cmp[3].prev.kpm === 160 && cmp[6].diff === 3 &&
      w6 && G.readGameBest(s, "normal", 90) === null && G.readGameBest(s, "normal", 6)?.got === 1 && G.readGameBest(s, "short", 90)?.got === 12 && s.map.get("spelldash_typing_practice") === PRACTICE &&
      [{ got: 1e300, lost: 0, kpm: 1 }, { got: 1.5, lost: 0, kpm: 1 }, { got: -1, lost: 0, kpm: 1 }, { got: 1, lost: 0, kpm: 3000 }, { got: 1, lost: -1, kpm: 100 }, { got: 1, lost: 1e300, kpm: 100 }].every((rec) => broken(rec) === null) &&
      broken({ got: 1, lost: 0, kpm: 100 })?.kpm === 100 && G.readGameBest(fake({ [G.BEST_KEY]: "{oops" }), "normal", 90) === null && G.readGameBest(throwing, "normal", 90) === null && G.writeGameBest(throwing, "normal", 90, { got: 1 }) === false;
    check("typing game: 自己ベストは鍵 spelldash_typing_game にコース・秒数ごと、取れた文で比べ・同数は打/分で比べ、書く直前に読み直す、spelldash_typing_practice を触らない、壊れた値（取れた・流れた・打/分の範囲の外）・投げる storage でも落ちない", ok, JSON.stringify({ cmp: cmp.map((c) => c.status), map: [...s.map.entries()] }));
  }
  {
    const feed = (keys) => {
      const r = T.createRun("ja", [["県", "けん"], ["柿", "かき"]]);
      let t = 0;
      for (const k of keys) r.press(k, (t += 100));
      return r;
    };
    const a = feed("kenkaki");
    const b = feed("kennkaki");
    check("typing game: typingDrill の createRun に skip を足しても既定の挙動は変わらない", a.stats.miss === 0 && a.stats.words === 2 && b.stats.miss === 0 && b.stats.words === 2 && typeof a.skip === "function", JSON.stringify({ a: a.stats, b: b.stats }));
  }

  // ---- 1200 × 900 の 1 枚を使い回す（学習データ・受付中の印・タイピング練習の自己ベストを入れ、reduced motion。CLS と要求と pageerror を最初から記録） ----
  const LEARNING = {
    spelldash_word_stats: JSON.stringify({ apple: { attempts: 3, correct: 2, misses: 1, lastSeen: "2026-10-01" } }),
    spelldash_typing_stats: JSON.stringify({ sessions: 2, keys: 120 }),
    spelldash_xp: "120",
    spelldash_streak: JSON.stringify({ current: 0, best: 3, last: "2026-09-01" }),
    spelldash_key_miss: JSON.stringify({ l: 3 }),
    spelldash_billing_open: JSON.stringify({ open: true, at: Date.now() }),
    spelldash_typing_practice: JSON.stringify({ v: 1, best: { en: { 60: { kpm: 100, acc: 90, day: "2026-10-01" } } } })
  };
  const snapshot = (page) => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith("spelldash_")).sort().map((k) => [k, localStorage.getItem(k)])));
  const st = (page) => page.evaluate(() => {
    const b = document.getElementById("tgBoard");
    const box = (n) => { const r = n.getBoundingClientRect(); return { top: Math.round(r.top + window.scrollY), height: Math.round(r.height), bottom: Math.round(r.bottom + window.scrollY) }; };
    const fill = getComputedStyle(document.getElementById("tgBarFill")).transform;
    return {
      state: b.dataset.state, course: b.dataset.course, got: Number(b.dataset.got), lost: Number(b.dataset.lost),
      rest: document.getElementById("tgWord").dataset.rest, miss: document.getElementById("tgWord").classList.contains("tp-miss"),
      term: document.getElementById("tgTerm").textContent, timer: document.getElementById("tgTimer").textContent, timerShown: !document.getElementById("tgTimer").closest("[hidden]"),
      gotText: document.getElementById("tgGot").textContent, note: document.getElementById("tgTabNote").textContent, live: document.getElementById("tgLive").textContent,
      hint: document.getElementById("tgHint").textContent, hintShown: !document.getElementById("tgHint").hidden && getComputedStyle(document.getElementById("tgHint")).visibility === "visible", hintH: Math.round(document.getElementById("tgHint").getBoundingClientRect().height),
      resultHidden: document.getElementById("tgResult").hidden, ratio: fill === "none" ? 1 : Number(fill.match(/matrix\(([^,]+)/)?.[1] ?? NaN),
      board: box(b), stage: box(document.getElementById("tgStage")), result: box(document.getElementById("tgResult")),
      scroll: document.documentElement.scrollWidth, inner: window.innerWidth, active: document.activeElement?.id
    };
  });
  const motion = (page) => page.evaluate(() => new Promise((resolve) => {
    const t0 = performance.now();
    const names = () => document.getAnimations().map((a) => { const t = a.effect?.target; return t ? `${t.tagName.toLowerCase()}${t.id ? "#" + t.id : ""}.${[...t.classList].join(".")}` : "?"; });
    const step = () => { const list = names(); if (list.length === 0 || performance.now() - t0 > 500) resolve(list); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }));
  const bestStored = (page) => page.evaluate(() => { try { return JSON.parse(localStorage.getItem("spelldash_typing_game")); } catch { return null; } });
  const waitGame = (page, s, timeout = 8000) => waitUntil(async () => (await st(page)).state === s, timeout);
  const same = (a, b) => Math.abs(a.top - b.top) <= 1 && Math.abs(a.height - b.height) <= 1;
  const anims = [];

  const page = await newPage({ viewport: { width: 1200, height: 900 }, storage: LEARNING });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls = (window.__cls || 0) + e.value; }).observe({ type: "layout-shift", buffered: true });
  });
  const hosts = new Set();
  let dataRequests = 0;
  page.on("request", (req) => {
    const u = new URL(req.url());
    hosts.add(u.host);
    if (u.pathname === "/data/typing-game.json") dataRequests++;
  });
  await page.goto(BASE + "/typing-game.html?t=6&s=2", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const before = await snapshot(page);
  const g11 = await st(page);
  anims.push(["ready", await motion(page)]);
  const open = await page.evaluate(() => ({
    units: document.querySelectorAll("#tgWord .tp-unit").length,
    barH: getComputedStyle(document.querySelector(".tg-bar")).height,
    normalPressed: document.querySelector('.tp-tabs [data-course="normal"]').getAttribute("aria-pressed"),
    headerCurrent: document.querySelectorAll(".site-nav [aria-current]").length,
    footerFirst: document.querySelector(".site-footer__nav a")?.getAttribute("href"),
    footerCurrent: document.querySelectorAll(".site-footer__nav [aria-current]").length,
    mincho700: [...document.fonts].filter((f) => f.status === "loaded" && /Shippori/.test(f.family) && String(f.weight) === "700").length,
    h1: getComputedStyle(document.querySelector("h1")).fontWeight,
    footerPro: document.querySelectorAll(".site-footer__nav [data-footer-pro]").length,
    mainText: document.querySelector("main").textContent
  }));
  check("typing game: 開いた直後に最初の文（今日はいい天気だ）と手本、取れた 0・残り 6秒・線は満（3px）、始まる前の 3 文、ふつうの文が選ばれ、補足は「目標 1文」、焦点は入力欄・ヘッダーに現在地なし・フッターの先頭「タイピング練習」は現在地でない・明朝 700 を読まない",
    g11.state === "ready" && g11.course === "normal" && g11.term === "今日はいい天気だ" && g11.rest === "kyouhaiitennkida" && open.units === 9 && g11.gotText === "取れた 0" && g11.timer === "残り 6秒" && g11.ratio === 1 && open.barH === "3px" &&
    g11.hint === "打ち始めると、6秒を測る。文ごとに持ち時間がある。尽きると次の文へ。" && g11.hintShown && open.normalPressed === "true" && g11.note === "かな8〜16字の文 ・ 目標 1文" && g11.resultHidden && g11.active === "input" &&
    open.headerCurrent === 0 && open.footerFirst === "./typing.html" && open.footerCurrent === 0 && open.mincho700 === 0 && open.h1 === "500", JSON.stringify({ g11, open: { ...open, mainText: undefined } }));

  // 線の色: 4 テーマで塗りが --gold-line で、地にも札にも 3:1 以上（WCAG 1.4.11。持ち時間を知る唯一の手がかり）。
  // テーマは読み込みの前に決める（1 つのページで data-theme を替えて同じタスクで読むと、色の transition の始まり＝前のテーマの色が返る）。
  // 塗りが --gold-line を解いた色（同じ札の中に置いた見えない見本の色）と同じことも見る（pages.css の --gold-dk に詳細度で負けたら落ちる）
  const barContrast = {};
  for (const theme of ["light", "dark", "paper", "indigo"]) {
    const tp = await newPage({ viewport: { width: 1200, height: 900 }, storage: { spelldash_theme: theme } });
    await tp.goto(BASE + "/typing-game.html?t=6&s=9", { waitUntil: "networkidle" });
    await tp.waitForTimeout(300);
    barContrast[theme] = await tp.evaluate(() => {
      const lum = (c) => { const m = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]; };
      const ratio = (a, b) => { const x = lum(a), y = lum(b); return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100; };
      const probe = document.createElement("i");
      probe.style.cssText = "position:absolute;width:0;height:0;background:var(--gold-line)";
      document.getElementById("tgBoard").append(probe);
      const want = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const fill = getComputedStyle(document.getElementById("tgBarFill")).backgroundColor;
      const ground = getComputedStyle(document.getElementById("tgBar")).backgroundColor;
      const sheet = getComputedStyle(document.getElementById("tgBoard")).backgroundColor;
      return { applied: document.documentElement.dataset.theme, fill, want, ground: ratio(fill, ground), sheet: ratio(fill, sheet) };
    });
    await tp.close();
  }
  check("typing game: 持ち時間の線の塗りは 4 テーマとも --gold-line（テーマごとに違う色）で、地（--line）にも札にも 3:1 以上",
    Object.entries(barContrast).every(([t, v]) => v.applied === t && v.fill === v.want && v.ground >= 3 && v.sheet >= 3) && new Set(Object.values(barContrast).map((v) => v.fill)).size === 4, JSON.stringify(barContrast));

  // G12: 最初の 1 打で始まり線が減る・ミスの印・IME のキー
  await page.keyboard.press("k");
  const g12a = await st(page);
  await page.waitForTimeout(300);
  const g12bar = await st(page);
  anims.push(["running", await motion(page)]);
  await page.keyboard.press("x");
  const g12x = await page.evaluate(() => ({ rest: document.getElementById("tgWord").dataset.rest, miss: document.getElementById("tgWord").classList.contains("tp-miss"), ring: getComputedStyle(document.querySelector("#tgWord .tp-unit--now")).boxShadow }));
  const imeKey = (init) => page.evaluate((o) => document.getElementById("input").dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...o })), init);
  await imeKey({ key: "Process", code: "KeyY", keyCode: 229 });
  const g12y = await st(page);
  await imeKey({ key: "ち", code: "KeyO" });
  const g12o = await st(page);
  check("typing game: 最初の 1 打で始まり線が減る（transform。reduced motion は 10 段）、ミスでは進まず印（内枠）が残る、IME オン（Process）・かな配列のキーも 1 打", g12a.state === "running" && g12a.rest === "youhaiitennkida" && g12bar.ratio < 1 && Math.abs(g12bar.ratio * 10 - Math.round(g12bar.ratio * 10)) < 1e-6 && g12x.rest === "youhaiitennkida" && g12x.miss && g12x.ring !== "none" && g12y.rest === "ouhaiitennkida" && !g12y.miss && g12o.rest === "uhaiitennkida", JSON.stringify({ g12a: g12a.rest, ratio: g12bar.ratio, g12x, y: g12y.rest, o: g12o.rest }));

  // G13: 打ち切ると取れた 1・次の文・線が満に戻る・札と箱が動かない
  await page.keyboard.type(g12o.rest);
  await page.waitForTimeout(50);
  const g13 = await st(page);
  check("typing game: 文を打ち切ると取れた 1・次の文・線が満に戻る・札と箱の上端と高さが変わらない", g13.got === 1 && g13.gotText === "取れた 1" && g13.term !== "今日はいい天気だ" && /^[a-z-]+$/.test(g13.rest) && g13.ratio >= 0.9 && same(g13.board, g11.board) && same(g13.stage, g11.stage), JSON.stringify({ g13: { got: g13.got, term: g13.term, ratio: g13.ratio, board: g13.board, stage: g13.stage }, g11: { board: g11.board, stage: g11.stage } }));

  // G14: 持ち時間が尽きると流れて次の文。流れた瞬間（同じタスク）に外れたキーを押す → 猶予の中なので数えない
  const g14 = await page.evaluate(async () => {
    const R = await import("/js/romaji.js");
    return await new Promise((resolve) => {
    const board = document.getElementById("tgBoard");
    const term0 = document.getElementById("tgTerm").textContent;
    const mo = new MutationObserver(() => {
      if (board.dataset.lost !== "1") return;
      mo.disconnect();
      const rest = document.getElementById("tgWord").dataset.rest;
      const reading = document.getElementById("tgReading").textContent;
      const wrong = "vqxzl".split("").find((k) => !R.createRomajiMatcher([reading]).feed(k).ok) ?? "v";
      const t0 = performance.now();
      document.getElementById("input").dispatchEvent(new KeyboardEvent("keydown", { key: wrong, code: `Key${wrong.toUpperCase()}`, bubbles: true, cancelable: true }));
      const out = { wrong, term0, term1: document.getElementById("tgTerm").textContent, rest0: rest, rest1: document.getElementById("tgWord").dataset.rest, miss: document.getElementById("tgWord").classList.contains("tp-miss"), live0: document.getElementById("tgLive").textContent, dt: Math.round(performance.now() - t0) };
      setTimeout(() => resolve({ ...out, live: document.getElementById("tgLive").textContent }), 150); // 読み上げは空にしてから次のタスクで書く
    });
    mo.observe(board, { attributes: true, attributeFilter: ["data-lost"] });
    });
  });
  const g14s = await st(page);
  anims.push(["flowed", await motion(page)]);
  check("typing game: 持ち時間が尽きると流れて次の文（取れたは増えない）・読み上げに「次の文」、直後の外れたキーは数えない、始まる前の 3 文は見えないが行の高さは残る、札と箱は動かない", g14s.lost >= 1 && g14s.got === 1 && g14.term1 !== g14.term0 && g14.live0 === "" && g14.live === "次の文" && g14.rest1 === g14.rest0 && !g14.miss && !g14s.hintShown && g14s.hintH === g11.hintH && same(g14s.board, g11.board) && same(g14s.stage, g11.stage), JSON.stringify({ g14, g14s: { lost: g14s.lost, got: g14s.got, hintH: g14s.hintH, board: g14s.board } }));

  // G15: 結果（流れた数は 1 文目を打ち切った時刻で 1 か 2。ページの data-lost から作る）
  await waitGame(page, "result", 8000);
  const clsBefore = await page.evaluate(() => window.__cls || 0);
  await page.keyboard.press("Enter"); // 守りの中: やり直さない
  const r15 = await page.evaluate(() => ({
    state: document.getElementById("tgBoard").dataset.state,
    got: document.getElementById("tgGotNum").textContent, unit: document.getElementById("tgUnit").textContent, goal: document.getElementById("tgGoal").textContent,
    goalB: getComputedStyle(document.querySelector("#tgGoal b")).fontSize,
    line: document.getElementById("tgLine").textContent, bestHidden: document.getElementById("tgBest").hidden, nudge: !document.getElementById("tgNudge").hidden,
    kind: document.getElementById("tgKind").textContent, live: document.getElementById("tgLive").textContent, active: document.activeElement?.id,
    lining: [...document.querySelectorAll("#tgGotNum, #tgLine b, #tgGoal b")].every((b) => getComputedStyle(b).fontVariantNumeric.includes("lining-nums")),
    twoCols: document.querySelector(".tp-result__next").getBoundingClientRect().left > document.getElementById("tgAgain").getBoundingClientRect().right,
    pairsOneLine: [...document.querySelectorAll("#tgLine .tg-pair")].every((p) => new Set([...p.getClientRects()].map((r) => Math.round(r.top))).size === 1)
  }));
  const g15 = await st(page);
  anims.push(["result", await motion(page)]);
  const lost15 = g15.lost;
  const stored15 = await bestStored(page);
  await page.waitForTimeout(700);
  await page.keyboard.press("Enter");
  const g15b = await st(page);
  check(`typing game: 結果は 1 文・目標 1文に届いた（目標の数字は 14px）・流れた ${lost15}・打/分 160・正確さ 94%・ミス 1（数は lining・組は折らない）、?s= の回は自己ベストを出さない、読み上げの 1 文、2 列、箱の上端と高さは始まる前と同じ・結果は箱に収まる、直後の Enter ではやり直さず 0.7 秒後の Enter でもう一度`,
    r15.state === "result" && r15.got === "1" && r15.unit === "文" && r15.goal === "目標 1文に届いた" && r15.goalB === "14px" && (lost15 === 1 || lost15 === 2) && r15.line === `流れた ${lost15} ・ 打/分 160 ・ 正確さ 94% ・ ミス 1` && r15.bestHidden && r15.nudge === lost15 > 1 &&
    r15.kind === "ふつうの文・6秒" && r15.live === `1 文。目標に届いた。流れた ${lost15}、打/分 160、正確さ 94%、ミス 1。` && r15.active === "tgMainLine" && r15.lining && r15.pairsOneLine && r15.twoCols &&
    same(g15.stage, g11.stage) && g15.board.top === g11.board.top && g15.result.bottom <= g15.stage.bottom && g15b.state === "ready" && stored15 === null, JSON.stringify({ r15, stage: g15.stage, board: g15.board, result: g15.result, g11stage: g11.stage, g15b: g15b.state, stored15 }));

  // G18: Esc と裏に回ったとき
  await page.keyboard.press(g15b.rest[0]);
  const run18 = await st(page);
  await page.keyboard.press("Escape");
  const esc18 = await st(page);
  await page.keyboard.press(esc18.rest[0]);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hid18 = await st(page);
  await page.evaluate(() => {
    delete document.visibilityState;
    delete document.hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  check("typing game: Esc と裏に回ったときは始まる前に戻り、結果もベストも出ない", run18.state === "running" && esc18.state === "ready" && esc18.timer === "残り 6秒" && esc18.resultHidden && hid18.state === "ready" && hid18.resultHidden && (await bestStored(page)) === null, JSON.stringify({ run18: run18.state, esc18: esc18.state, hid18: hid18.state }));

  // G17: コースの切り替え
  await page.click('.tp-tabs [data-course="short"]');
  await waitGame(page, "ready", 3000);
  const c17s = await st(page);
  const pressed17 = await page.evaluate(() => document.querySelector('.tp-tabs [data-course="short"]').getAttribute("aria-pressed"));
  await page.keyboard.press(c17s.rest[0]);
  await page.focus('.tp-tabs [data-course="long"]');
  await page.keyboard.press(" ");
  const c17sp = await st(page);
  await page.click('.tp-tabs [data-course="long"]');
  await waitGame(page, "ready", 3000);
  const c17l = await st(page);
  check("typing game: コースの切り替え（aria-pressed・補足・単位「語句」・箱の上端と高さは同じ・running 中のタブの上の Space で回が消えない）", c17s.course === "short" && pressed17 === "true" && c17s.note === "かな3〜7字の語句 ・ 目標 1語句" && same(c17s.stage, g11.stage) && c17s.board.top === g11.board.top && c17sp.state === "running" && c17sp.course === "short" && c17l.state === "ready" && c17l.course === "long" && c17l.note === "かな17〜30字の文 ・ 目標 1文" && same(c17l.stage, g11.stage) && c17l.board.height <= c17l.stage.height, JSON.stringify({ c17s: { note: c17s.note, stage: c17s.stage }, sp: [c17sp.state, c17sp.course], c17l: { note: c17l.note, stage: c17l.stage, board: c17l.board } }));
  await page.click('.tp-tabs [data-course="normal"]');
  await waitGame(page, "ready", 3000);

  const cls = await page.evaluate(() => window.__cls || 0);
  check("typing game: 札と箱は文が替わっても結果でも跳ばない（入力なしの CLS の合計 < 0.05: 開く → 打つ → 取れた → 流れた → 結果 → もう一度 → コース替え）", cls < 0.05, JSON.stringify({ cls, clsBefore }));
  check("typing game: reduced motion で動きが 0（始まる前・線が動いている間・流れた直後・結果）", anims.length >= 4 && anims.every(([, list]) => list.length === 0), JSON.stringify(anims));
  const after = await snapshot(page);
  const ALLOWED = (k) => k === "spelldash_typing_game" || k === "spelldash_device_id" || k.startsWith("spelldash_funnel_") || k === "spelldash_billing_open";
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k] && !ALLOWED(k));
  const mainText = open.mainText;
  const EMOJI = /\p{Extended_Pictographic}/u;
  check("typing game: 学習記録を変えない（変わってよいのは自己ベストと計測のキーだけ。タイピング練習の自己ベストも同じ）・Pro・はちゃん・通貨・絵文字・「！」「？」を出さない（広告は「広告なし」だけ）", changed.length === 0 && after.spelldash_word_stats === LEARNING.spelldash_word_stats && after.spelldash_key_miss === LEARNING.spelldash_key_miss && after.spelldash_typing_practice === LEARNING.spelldash_typing_practice &&
    open.footerPro === 0 && !mainText.includes("Pro") && !mainText.includes("はちゃん") && !/[円￥¥]/.test(mainText) && !EMOJI.test(mainText.replace(/[©↔★]/g, "")) && !/[！？!?]/.test(mainText) && mainText.split("広告").length - 1 === (mainText.match(/広告なし/g) ?? []).length, changed.join(","));
  const own = new URL(BASE).host;
  const links = await page.evaluate(() => ({
    study: document.getElementById("tgStudy").getAttribute("href"),
    studyText: document.getElementById("tgStudy").textContent.trim(),
    about: [...document.querySelectorAll(".tp-about a[data-tgame-study]")].map((a) => a.getAttribute("href")),
    typing: document.querySelectorAll('.tp-about a[href="./typing.html"]').length
  }));
  check("typing game: 要求はすべて同一オリジン・教材は 1 回だけ取る・本体への導線は /?from=tgame（結果とこのページについて）・typing.html への導線", [...hosts].every((h) => h === own) && dataRequests === 1 && links.study === "/?from=tgame" && links.studyText === "思い出して打つ" && links.about.length === 1 && links.about[0] === "/?from=tgame" && links.typing === 1, JSON.stringify({ hosts: [...hosts], dataRequests, links }));
  const pageErrors11 = page.errors.length;

  // G16: 自己ベスト（?s= なし。?t=6 なので取れるのは最初の 1 文だけ: ふつうの文の持ち時間は 9 秒以上）
  await page.goto(BASE + "/typing-game.html?t=6", { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.keyboard.type("kyouhaiitennkida", { delay: 120 });
  await waitGame(page, "result", 9000);
  const b16a = await page.evaluate(() => document.getElementById("tgBest").hidden ? "" : document.getElementById("tgBest").textContent);
  const s16a = await bestStored(page);
  await page.waitForTimeout(700);
  await page.click("#tgAgain");
  await page.keyboard.press(" ");
  await waitGame(page, "result", 9000);
  const b16b = await page.evaluate(() => ({ best: document.getElementById("tgBest").hidden ? "" : document.getElementById("tgBest").textContent, line: document.getElementById("tgLine").textContent }));
  const s16b = await bestStored(page);
  await page.waitForTimeout(700);
  await page.click("#tgAgain");
  const rest16 = (await st(page)).rest;
  await page.keyboard.type(rest16, { delay: 40 });
  await waitGame(page, "result", 9000);
  const b16c = await page.evaluate(() => document.getElementById("tgBest").hidden ? "" : document.getElementById("tgBest").textContent);
  const s16c = await bestStored(page);
  const kpm16 = Math.round((rest16.length * 60) / 6);
  const want16 = kpm16 > 160 ? `自己ベストと同じ 1文・打/分を更新（前 160）` : `自己ベストと同じ（1文・打/分 160）`;
  await page.waitForTimeout(700);
  await page.click('.tp-tabs [data-course="short"]');
  const tab16 = await st(page);
  const practice16 = await page.evaluate(() => localStorage.getItem("spelldash_typing_practice"));
  check("typing game: 自己ベストはコース・秒数ごとに端末へ（はじめての記録 → 次の回は「あと N文」で保存値は変わらない → 同数なら打/分で比べる）、結果の画面からタブで替えられる、spelldash_typing_practice は変わらない",
    b16a === "自己ベスト（はじめての記録）" && s16a?.best?.normal?.["6"]?.got === 1 && s16a?.best?.normal?.["6"]?.kpm === 160 && s16a?.best?.normal?.["90"] === undefined &&
    b16b.best === "自己ベスト 1文（あと 1文）" && b16b.line.includes("正確さ ―") && JSON.stringify(s16b) === JSON.stringify(s16a) &&
    b16c === want16 && s16c?.best?.normal?.["6"]?.kpm === Math.max(160, kpm16) && tab16.state === "ready" && tab16.course === "short" && practice16 === LEARNING.spelldash_typing_practice, JSON.stringify({ b16a, s16a, b16b, b16c, want16, s16c, tab16: [tab16.state, tab16.course] }));

  // G23: 教材が読めない
  await page.route("**/data/typing-game.json", (route) => route.abort());
  await page.goto(BASE + "/typing-game.html?t=6", { waitUntil: "load" });
  await page.waitForTimeout(400);
  await page.keyboard.type("kyouhaiitennkida");
  const failed = await waitGame(page, "error", 3000);
  await page.waitForTimeout(150); // reduced motion の 0.01ms の transition（game.css）が visibility を 1 フレーム visible に残すので、落ち着いてから読む
  const err23 = await page.evaluate(() => ({ error: !document.getElementById("tgError").hidden, timer: !document.getElementById("tgTimer").closest("[hidden]") && document.getElementById("tgTimer").getClientRects().length > 0, bar: getComputedStyle(document.getElementById("tgBar")).visibility }));
  await page.click('.tp-tabs [data-course="short"]');
  const shortFailed = await waitGame(page, "error", 2000);
  check("typing game: 教材が読めなくても最初の文は打て、尽きたら「読み込めなかった」（残り時間・取れた・線を出さない）、ほかのコースも error", failed && err23.error && !err23.timer && err23.bar === "hidden" && shortFailed && page.errors.length === 0, JSON.stringify({ failed, err23, shortFailed, errors: page.errors.slice(0, 2), pageErrors11 }));
  await page.close();

  // G24: localStorage が投げる端末
  {
    const p = await newPage({ viewport: { width: 1200, height: 900 } });
    await p.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new Error("denied"); };
      Storage.prototype.setItem = () => { throw new Error("denied"); };
    });
    await p.goto(BASE + "/typing-game.html?t=6", { waitUntil: "networkidle" });
    await p.waitForTimeout(300);
    const theme = await p.evaluate(() => document.documentElement.dataset.theme);
    await p.keyboard.press("k");
    const s24 = await st(p);
    check("typing game: localStorage が投げる端末でも皮が付き、最初の文を打てる", theme === "light" && s24.state === "running" && s24.rest === "youhaiitennkida", JSON.stringify({ theme, s24: [s24.state, s24.rest] }));
    await p.close();
  }

  // G37: 2 回続けて時間切れ（?t=3&s=1。押さずに流す）: 読み上げの行は一度空になってから「次の文」（MutationObserver の 1 回ごとの中身。
  // 同じタスクで空にして書き直すと 2 回目が読まれない環境がある）。時計は rAF の 1 本: 300ms 以上のタイムアウトを 300ms 遅らせて rAF に流させ、
  // 流れたフレームでも待っている rAF は 1 本のまま・残り秒も rAF で書き替わる（200ms の tick は無い）
  {
    const p = await newPage({ viewport: { width: 1200, height: 900 } });
    await p.addInitScript(() => {
      const raf = window.requestAnimationFrame.bind(window);
      const caf = window.cancelAnimationFrame.bind(window);
      const st0 = window.setTimeout.bind(window);
      const pending = new Set();
      window.__rafMax = 0;
      window.requestAnimationFrame = (cb) => { const id = raf((t) => { pending.delete(id); cb(t); }); pending.add(id); window.__rafMax = Math.max(window.__rafMax, pending.size); return id; };
      window.cancelAnimationFrame = (id) => { pending.delete(id); caf(id); };
      window.setTimeout = (fn, ms, ...args) => st0(fn, Number(ms) >= 300 ? Number(ms) + 300 : ms, ...args);
    });
    await p.goto(BASE + "/typing-game.html?t=3&s=1", { waitUntil: "networkidle" });
    await p.waitForTimeout(300);
    await p.evaluate(() => {
      window.__live = [];
      const live = document.getElementById("tgLive");
      new MutationObserver(() => window.__live.push(live.textContent)).observe(live, { childList: true, characterData: true, subtree: true });
    });
    await p.keyboard.press("k");
    await p.waitForTimeout(1300);
    const timer37 = await p.evaluate(() => document.getElementById("tgTimer").textContent);
    const ended37 = await waitGame(p, "result", 6000);
    const seq37 = await p.evaluate(() => window.__live);
    const lost37 = (await st(p)).lost;
    const rafMax37 = await p.evaluate(() => window.__rafMax);
    check("typing game: 2 回続けて流れると、読み上げの行は「次の文」→ 空 → 「次の文」（2 回目も読まれる）・時計の rAF は流れたフレームでも 1 本・残り秒は打っている間に減る", ended37 && lost37 === 2 && seq37.length >= 3 && seq37[0] === "次の文" && seq37[1] === "" && seq37[2] === "次の文" && rafMax37 === 1 && (timer37 === "残り 2秒" || timer37 === "残り 1秒") && p.errors.length === 0, JSON.stringify({ seq37, timer37, lost37, rafMax37, errors: p.errors.slice(0, 2) }));
    await p.close();
  }

  // G38: rAF が止まっても（時計のタイムアウトは次の締切に 1 本: その保険）文は締切ごとに流れ、回は終わる（?t=3&s=1 → 1 秒・2 秒で流れて流れた 2・結果）
  {
    const p = await newPage({ viewport: { width: 1200, height: 900 } });
    await p.addInitScript(() => {
      window.requestAnimationFrame = () => 1;
      window.cancelAnimationFrame = () => {};
    });
    await p.goto(BASE + "/typing-game.html?t=3&s=1", { waitUntil: "networkidle" });
    await p.waitForTimeout(300);
    await p.evaluate(() => {
      window.__flows = [];
      window.__timers = []; // 流れた直後の残り秒の表示（PR #154 レビュー 4）
      const board = document.getElementById("tgBoard");
      document.addEventListener("keydown", () => { window.__t0 ??= performance.now(); }, true);
      new MutationObserver(() => {
        if (Number(board.dataset.lost) > window.__flows.length) {
          window.__flows.push(Math.round(performance.now() - window.__t0));
          window.__timers.push(document.getElementById("tgTimer").textContent);
        }
      }).observe(board, { attributes: true, attributeFilter: ["data-lost"] });
    });
    const timer38 = await p.evaluate(() => document.getElementById("tgTimer").textContent);
    await p.keyboard.press("k");
    const ended38 = await waitGame(p, "result", 6000);
    const r38 = await p.evaluate(() => ({ flows: window.__flows, timers: window.__timers, lost: Number(document.getElementById("tgBoard").dataset.lost), got: Number(document.getElementById("tgBoard").dataset.got) }));
    check("typing game: rAF が止まっても文は締切ごとに流れ（1 秒・2 秒の締切のあと、次の締切より前）、回は終わる（流れた 2）", ended38 && r38.lost === 2 && r38.got === 0 && r38.flows.length === 2 && r38.flows[0] >= 1000 && r38.flows[0] < 2000 && r38.flows[1] >= 2000 && r38.flows[1] < 3000 && p.errors.length === 0, JSON.stringify({ r38, errors: p.errors.slice(0, 2) }));
    check("typing game: rAF が止まっても、文が流れた後の残り秒の表示は減っている（残り 3秒 → 2秒 → 1秒。PR #154 レビュー 4）", timer38 === "残り 3秒" && JSON.stringify(r38.timers) === JSON.stringify(["残り 2秒", "残り 1秒"]), JSON.stringify({ timer38, timers: r38.timers }));
    await p.close();
  }

  // G42（PR #154 レビュー 4）: rAF が打っている途中で止まっても（?t=4&s=2。1.3 秒で止める）、時計のタイムアウトが文を流したときに持ち時間の線と残り秒を描き直す
  // （止まった時点の線 約 0.35 のまま残らず、新しい文の線はほぼ満ちている）
  {
    const p = await newPage({ viewport: { width: 1200, height: 900 } });
    await p.addInitScript(() => {
      const raf = window.requestAnimationFrame.bind(window);
      window.__rafOn = true;
      window.requestAnimationFrame = (cb) => raf((t) => { if (window.__rafOn) cb(t); }); // 止めた後は呼ばない（ページの rAF は二度と回らない）
    });
    await p.goto(BASE + "/typing-game.html?t=4&s=2", { waitUntil: "networkidle" });
    await p.waitForTimeout(300);
    await p.evaluate(() => {
      window.__flowShots = [];
      const board = document.getElementById("tgBoard");
      const ratio = () => { const t = getComputedStyle(document.getElementById("tgBarFill")).transform; return t === "none" ? 1 : Number(t.match(/matrix\(([^,]+)/)?.[1] ?? NaN); };
      window.__ratio = ratio;
      new MutationObserver(() => {
        if (Number(board.dataset.lost) > window.__flowShots.length) window.__flowShots.push({ ratio: Math.round(ratio() * 100) / 100, timer: document.getElementById("tgTimer").textContent });
      }).observe(board, { attributes: true, attributeFilter: ["data-lost"] });
    });
    await p.keyboard.press("k");
    await p.waitForTimeout(1300);
    const stopped = await p.evaluate(() => { window.__rafOn = false; return { ratio: Math.round(window.__ratio() * 100) / 100, timer: document.getElementById("tgTimer").textContent }; });
    await waitUntil(() => p.evaluate(() => window.__flowShots.length >= 1), 3000);
    await p.waitForTimeout(100);
    const now42 = await p.evaluate(() => ({ ratio: Math.round(window.__ratio() * 100) / 100, timer: document.getElementById("tgTimer").textContent, shots: window.__flowShots, state: document.getElementById("tgBoard").dataset.state }));
    check("typing game: rAF が途中で止まっても、時計が文を流したときに線を新しい文の持ち時間で描き直し（止まった時点の 約 0.35 のまま残らない）、残り秒も減る（残り 4秒 → 2秒）",
      stopped.ratio > 0.2 && stopped.ratio < 0.6 && stopped.timer === "残り 3秒" && now42.state === "running" && now42.shots.length === 1 && now42.shots[0].ratio >= 0.85 && now42.ratio >= 0.85 && now42.shots[0].timer === "残り 2秒" && p.errors.length === 0, JSON.stringify({ stopped, now42, errors: p.errors.slice(0, 2) }));
    await p.close();
  }

  // G41（PR #154 レビュー 3）: 列が尽きて足し直した文も、持ち時間は流れた文の締切から（時計が気づいた時刻からではない）。
  // 教材は 1 文ずつ（ふつうの文は 海 だけ: 最初の回は 内蔵の文 → 海 → 尽きたら 海 を足し直す）・?t=6&s=1・rAF を止め、300ms 以上のタイムアウトを 400ms 遅らせる:
  // 締切は 1・2・3・4・5 秒（6 秒は回の終わり）で、それぞれ次の締切より前に流れて流れた 5。気づいた時刻から張ると締切が 0.45 秒ずつ延びて流れた 4
  {
    const p = await newPage({ viewport: { width: 1200, height: 900 } });
    await p.route("**/data/typing-game.json", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ v: 1, courses: { short: [["空", "そら"]], normal: [["海", "うみ"]], long: [["山の上の空", "やまのうえのそら"]] } }) }));
    await p.addInitScript(() => {
      window.requestAnimationFrame = () => 1;
      window.cancelAnimationFrame = () => {};
      const st0 = window.setTimeout.bind(window);
      window.setTimeout = (fn, ms, ...args) => st0(fn, Number(ms) >= 300 ? Number(ms) + 400 : ms, ...args);
    });
    await p.goto(BASE + "/typing-game.html?t=6&s=1", { waitUntil: "networkidle" });
    await p.waitForTimeout(300);
    await p.evaluate(() => {
      window.__flows = [];
      const board = document.getElementById("tgBoard");
      document.addEventListener("keydown", () => { window.__t0 ??= performance.now(); }, true);
      new MutationObserver(() => { if (Number(board.dataset.lost) > window.__flows.length) window.__flows.push(Math.round(performance.now() - window.__t0)); }).observe(board, { attributes: true, attributeFilter: ["data-lost"] });
    });
    await p.keyboard.press("k");
    const ended41 = await waitGame(p, "result", 10000);
    const r41 = await p.evaluate(() => ({ flows: window.__flows, lost: Number(document.getElementById("tgBoard").dataset.lost), got: Number(document.getElementById("tgBoard").dataset.got) }));
    check("typing game: 列が尽きて足し直した文の持ち時間は、流れた文の締切から（rAF を止めタイムアウトを遅らせても締切は 1・2・3・4・5 秒、流れた 5。PR #154 レビュー 3）",
      ended41 && r41.lost === 5 && r41.got === 0 && r41.flows.length === 5 && r41.flows.every((t, i) => t >= (i + 1) * 1000 && t < (i + 2) * 1000) && p.errors.length === 0, JSON.stringify({ r41, errors: p.errors.slice(0, 2) }));
    await p.close();
  }

  // ---- タッチ端末（390 × 844・mobile の 1 枚。設定は「オフ」）。320・360 も同じ 1 枚 ----
  {
    const p = await newPage({ mobile: true, viewport: { width: 390, height: 844 }, storage: { spelldash_osk: "off" } });
    await p.goto(BASE + "/typing-game.html?t=4&s=2", { waitUntil: "networkidle" });
    await p.waitForTimeout(300);
    const osk = () => p.evaluate(() => {
      const box = (sel) => { const n = document.querySelector(sel); if (!n) return null; const r = n.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
      const shown = (sel) => { const n = document.querySelector(sel); return Boolean(n && n.getClientRects().length > 0 && getComputedStyle(n).display !== "none" && !n.closest("[hidden]")); };
      return { osk: shown("#osk"), open: document.body.classList.contains("osk-open"), enter: shown('#osk [data-action="enter"]'), dash: shown('#osk [data-action="dash"]'), space: shown('#osk [data-action="space"]'), board: box("#tgBoard"), keys: box("#osk"), header: box(".site-header") };
    });
    await p.waitForTimeout(100);
    const o0 = await osk();
    const n390 = await st(p);
    await p.click('.tp-tabs [data-course="long"]');
    await p.waitForTimeout(150);
    const l390 = await st(p);
    const ol = await osk();
    await p.click('.tp-tabs [data-course="short"]');
    await p.waitForTimeout(150);
    const s390 = await st(p);
    await p.click('.tp-tabs [data-course="normal"]');
    await p.waitForTimeout(150);
    check("typing game（390）: 設定が「オフ」でも画面キーボードが出て、Enter と空白は出さず ー は出す・札は盤面の上に寄せられて隠れない・コースを替えても箱の上端と高さは同じ", o0.osk && o0.open && !o0.enter && o0.dash && !o0.space && o0.board.bottom <= o0.keys.top && o0.board.top >= o0.header.bottom && ol.board.bottom <= ol.keys.top && same(l390.stage, n390.stage) && same(s390.stage, n390.stage), JSON.stringify({ o0, ol: ol.board, n: n390.stage, l: l390.stage, s: s390.stage }));
    // G26: 盤面のキー（pointerdown）で始まり、最初の文を打ち切る。時間切れの直後 0.6 秒は盤面を出したまま・盤面の外は押しても届かない（盤面の中は届く）
    const first390 = (await st(p)).rest;
    for (const k of first390) await p.dispatchEvent(k === "-" ? '#osk [data-action="dash"]' : `#osk [data-key="${k}"]`, "pointerdown");
    const run390 = await st(p);
    const guard = await p.evaluate(() => new Promise((resolve) => {
      const board = document.getElementById("tgBoard");
      // 押した先まで届いたか（届いたら既定の動きは止める: 移動しない）
      const reach = (sel) => { const n = document.querySelector(sel); let hit = false; const h = (e) => { hit = true; e.preventDefault(); }; n.addEventListener("click", h); n.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })); n.removeEventListener("click", h); return hit; };
      const snap = (sels) => ({ osk: !document.getElementById("osk").hidden, reached: sels.map(reach), inertCount: document.querySelectorAll("[inert]").length });
      const done = () => { const out = {}; setTimeout(() => (out.at300 = { ...snap(["#tgStudy", "#tgAgain", '.site-footer__nav a[href="./news.html"]', ".tp-about a"]), oskKey: reach('#osk [data-key="a"]') }), 300); setTimeout(() => { out.at700 = snap(['.site-footer__nav a[href="./news.html"]']); resolve(out); }, 700); };
      if (board.dataset.state === "result") { done(); return; }
      const mo = new MutationObserver(() => { if (board.dataset.state === "result") { mo.disconnect(); done(); } });
      mo.observe(board, { attributes: true, attributeFilter: ["data-state"] });
    }));
    const r390 = await st(p);
    const pairs390 = await p.evaluate(() => [...document.querySelectorAll("#tgLine .tg-pair")].every((n) => new Set([...n.getClientRects()].map((r) => Math.round(r.top))).size === 1));
    check("typing game（390）: 盤面のキー（pointerdown）で打て、時間切れの直後 0.6 秒は盤面を出したまま・盤面の外（結果のボタン・導線・フッターのリンク・このページについて）は押しても届かず盤面の中は届く、その後に畳んで押せる（inert は使わない）・結果は箱に収まり箱の高さは同じ", run390.got === 1 && guard.at300.osk && guard.at300.reached.every((r) => r === false) && guard.at300.oskKey === true && !guard.at700.osk && guard.at700.reached[0] === true && guard.at700.inertCount === 0 && same(r390.stage, n390.stage) && r390.result.bottom <= r390.stage.bottom && pairs390, JSON.stringify({ got: run390.got, guard, r390: { stage: r390.stage, result: r390.result }, n: n390.stage }));
    const scroll390 = [n390, l390, s390, run390, r390].every((s) => s.scroll <= s.inner);
    // 320・360: 長い文で横スクロールしない・結果が箱に収まる・結果の組（流れた 2 など）が名前と数の間で割れない
    const narrow = {};
    for (const w of [360, 320]) {
      await p.setViewportSize({ width: w, height: w === 320 ? 640 : 740 });
      await p.goto(BASE + "/typing-game.html?t=2&s=1", { waitUntil: "networkidle" });
      await p.waitForTimeout(300);
      await p.click('.tp-tabs [data-course="long"]');
      await p.waitForTimeout(150);
      const ready = await st(p);
      await p.dispatchEvent(`#osk [data-key="${ready.rest[0]}"]`, "pointerdown");
      const running = await st(p);
      await waitGame(p, "result", 5000);
      await p.waitForTimeout(700);
      const result = await st(p);
      const pairs = await p.evaluate(() => [...document.querySelectorAll("#tgLine .tg-pair")].every((n) => new Set([...n.getClientRects()].map((r) => Math.round(r.top))).size === 1));
      narrow[w] = { scroll: [ready, running, result].every((s) => s.scroll <= s.inner), fits: result.result.bottom <= result.stage.bottom, same: same(result.stage, ready.stage), pairs, stage: result.stage, result: result.result };
    }
    check("typing game（390・360・320）: 長い文で横スクロールしない（始まる前・打っている間・結果）・結果は箱に収まり箱の高さは同じ・結果の組は名前と数の間で割れない", scroll390 && Object.values(narrow).every((n) => n.scroll && n.fits && n.same && n.pairs), JSON.stringify({ scroll390, narrow }));
    check("typing game（390）: エラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // ---- 横向き（844×390・844×340・667×375・mobile）: 札・線・単位が盤面の上に収まる（いちばん単位の多い文で）。
  // 667×375 は幅 720 未満・高さ 361〜480 の横向き（縦向きのコースの予約に負けると、ふつうの文が 2 行分を取り線が盤面の下に入る）。
  // 札の下の余白は盤面にかかってよい（844×340 は 6px、667×375 は 14px）。単位の中身（.tp-unit）と線は盤面の上 ----
  {
    const longest = (c) => gameJson.courses[c].slice().sort((a, b) => T.japaneseUnits(b[1], "").units.length - T.japaneseUnits(a[1], "").units.length)[0];
    const land = {};
    for (const [w, h, slack] of [[844, 390, 0], [844, 340, 6], [667, 375, 14]]) {
      const key = `${w}x${h}`;
      const p = await newPage({ mobile: true, viewport: { width: w, height: h } });
      await p.goto(BASE + "/typing-game.html?t=6", { waitUntil: "networkidle" });
      await p.waitForTimeout(300);
      for (const c of ["short", "normal", "long"]) {
        await p.click(`.tp-tabs [data-course="${c}"]`);
        await p.waitForTimeout(150);
        land[`${key}-${c}`] = await p.evaluate(async ([pair]) => {
          const D = await import("/js/typingDrill.js");
          const word = document.getElementById("tgWord");
          word.replaceChildren(...D.japaneseUnits(pair[1], "").units.map((u) => { const s = document.createElement("span"); s.className = `tp-unit tp-unit--${u.state}`; s.innerHTML = `<span class="tp-unit__kana">${u.kana}</span><span class="tp-unit__keys">${u.rest}</span>`; return s; }));
          document.getElementById("tgTerm").textContent = pair[0];
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const r = (sel) => document.querySelector(sel).getBoundingClientRect();
          return { word: Math.round(r("#tgWord").bottom), unit: Math.round(Math.max(...[...word.querySelectorAll(".tp-unit")].map((n) => n.getBoundingClientRect().bottom))), bar: [Math.round(r("#tgBar").top), Math.round(r("#tgBar").bottom)], board: Math.round(r("#tgBoard").bottom), osk: Math.round(r("#osk").top), header: Math.round(r(".site-header").bottom), term: getComputedStyle(document.getElementById("tgTerm")).display, kana: getComputedStyle(document.querySelector(".tp-unit__kana")).fontSize };
        }, [longest(c)]);
      }
      const low = h <= 360;
      check(`typing game（${w}×${h}・横向き）: 3 コースのいちばん長い文で、単位と持ち時間の線が盤面の上・ヘッダーの下に収まる${low ? "（線は札の上の縁に重ね、見出しは隠す）" : "、長い文の見出しは隠れ、かなは 22px"}`, ["short", "normal", "long"].every((c) => { const v = land[`${key}-${c}`]; return v.word <= v.osk && v.unit <= v.osk && v.bar[0] >= v.header && v.bar[1] <= v.osk && v.board <= v.osk + slack; }) && land[`${key}-long`].term === "none" && land[`${key}-long`].kana === "22px" && (!low || land[`${key}-short`].term === "none") && p.errors.length === 0, JSON.stringify(Object.fromEntries(Object.entries(land).filter(([k]) => k.startsWith(key)))));
      await p.close();
    }
  }

  // G36: 教材の全文が予約した行数に収まる（単位 390: 短 1・ふつう 2・長 3／320・320×460: 1・2・3／844×390・667×375: 1・1・2、見出し 390・320: 1・1・2）。
  // 文を流し込んでも札の高さが変わらない（流れたとき＝入力なしで札が上下しない）。横向きはどの文でも単位の中身と持ち時間の線が盤面の上
  {
    const LIMITS = { 390: { units: { short: 1, normal: 2, long: 3 }, term: { short: 1, normal: 1, long: 2 } }, 320: { units: { short: 1, normal: 2, long: 3 }, term: { short: 1, normal: 1, long: 2 } }, "844x390": { units: { short: 1, normal: 1, long: 2 }, term: null, osk: true }, "667x375": { units: { short: 1, normal: 1, long: 2 }, term: null, osk: true }, "320x460": { units: { short: 1, normal: 2, long: 3 }, term: null, osk: true } };
    const over = [];
    let measured = 0;
    for (const [key, view] of [["390", { width: 390, height: 844 }], ["320", { width: 320, height: 640 }], ["844x390", { width: 844, height: 390 }], ["667x375", { width: 667, height: 375 }], ["320x460", { width: 320, height: 460 }]]) {
      const p = await newPage({ mobile: true, viewport: view });
      await p.goto(BASE + "/typing-game.html?t=6", { waitUntil: "networkidle" });
      await p.waitForTimeout(300);
      for (const c of ["short", "normal", "long"]) {
        await p.click(`.tp-tabs [data-course="${c}"]`);
        await p.waitForTimeout(100);
        const res = await p.evaluate(async ({ list, lim }) => {
          const D = await import("/js/typingDrill.js");
          const word = document.getElementById("tgWord");
          const term = document.getElementById("tgTerm");
          const board = document.getElementById("tgBoard");
          const h0 = Math.round(board.getBoundingClientRect().height);
          const lines = (rects) => new Set([...rects].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size;
          const oskTop = lim.osk ? document.getElementById("osk").getBoundingClientRect().top : Infinity;
          const bar = document.getElementById("tgBar");
          const bad = [];
          for (const [t, r] of list) {
            word.replaceChildren(...D.japaneseUnits(r, "").units.map((u) => { const s = document.createElement("span"); s.className = `tp-unit tp-unit--${u.state}`; s.innerHTML = `<span class="tp-unit__kana">${u.kana}</span><span class="tp-unit__keys">${u.rest}</span>`; return s; }));
            term.textContent = t;
            const u = lines([...word.querySelectorAll(".tp-unit")].map((n) => n.getBoundingClientRect()));
            const range = document.createRange();
            range.selectNodeContents(term);
            const tl = getComputedStyle(term).display === "none" ? 0 : lines(range.getClientRects());
            const h = Math.round(board.getBoundingClientRect().height);
            const low = Math.max(bar.getBoundingClientRect().bottom, ...[...word.querySelectorAll(".tp-unit")].map((n) => n.getBoundingClientRect().bottom));
            if (u > lim.units || (lim.term && tl > lim.term) || Math.abs(h - h0) > 1 || low > oskTop + 0.5) bad.push(`${t}（単位 ${u}・見出し ${tl}・札 ${h0}→${h}${lim.osk ? `・単位と線の下端 ${Math.round(low)}／盤面 ${Math.round(oskTop)}` : ""}）`);
          }
          return { bad, n: list.length };
        }, { list: gameJson.courses[c], lim: { units: LIMITS[key].units[c], term: LIMITS[key].term?.[c] ?? null, osk: !!LIMITS[key].osk } });
        measured += res.n;
        over.push(...res.bad.map((b) => `${key} ${c}: ${b}`));
      }
      await p.close();
    }
    check(`typing game: 教材の全文が 390／320／844×390／667×375／320×460 で予約した行数に収まり、文を替えても札の高さが変わらない・横向きと背の低い窓は単位と線が盤面の上（${measured} 回）`, over.length === 0 && measured === allRows.length * 5, over.slice(0, 10).join(" | "));
  }

  // ---- 静的（ファイルを読むだけ） ----
  const gameHtml = fs.readFileSync(path.join(ROOT, "typing-game.html"), "utf8");
  const gmeta = (re) => gameHtml.match(re)?.[1] ?? "";
  const gdesc = gmeta(/<meta name="description" content="([^"]*)"/);
  const TITLE = "タイピングゲーム（日本語の文・ローマ字）無料・90秒 | SpellDash";
  const about = gameHtml.match(/<section class="tp-about"[\s\S]*?<\/section>/)?.[0] ?? "";
  const gameFooter = gameHtml.match(/<nav class="site-footer__nav"[^>]*>[\s\S]*?<\/nav>/)?.[0] ?? "";
  const docsText = fs.readdirSync(path.join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => fs.readFileSync(path.join(ROOT, "docs", f), "utf8")).join("\n");
  const RIVAL = String.fromCodePoint(0x5bff, 0x53f8, 0x6253); // よく知られたタイピングゲームの名（リポジトリは public。木に字面を入れないため符号で持つ）
  const noRival = [gameHtml, fs.readFileSync(path.join(ROOT, "css", "typing-game.css"), "utf8"), fs.readFileSync(path.join(ROOT, "js", "typingGame.js"), "utf8"), fs.readFileSync(path.join(ROOT, "js", "typingGamePage.js"), "utf8"), fs.readFileSync(path.join(ROOT, "js", "typingKeys.js"), "utf8"), fs.readFileSync(path.join(ROOT, "scripts", "build-typing-game.mjs"), "utf8"), fs.readFileSync(path.join(ROOT, "scripts", "typing-game", "deny.txt"), "utf8"), docsText].every((t) => !t.includes(RIVAL));
  check("typing game: title・og:title・canonical・og:url・og:image・twitter:card、description は og と同じで「登録なし」「90秒」「スマホ」を前半に含む、h1・lead・このページについて 5 行・最初の文と補足（目標は定数と同じ）、木（docs も）に他社の固有名が無い、フッターの先頭は typing.html で現在地でない・Pro を出さない印",
    gameHtml.includes(`<title>${TITLE}</title>`) && gmeta(/<meta property="og:title" content="([^"]*)"/) === TITLE && gameHtml.includes('<link rel="canonical" href="https://www.spelldash.net/typing-game.html" />') && gameHtml.includes('<meta property="og:url" content="https://www.spelldash.net/typing-game.html" />') && gameHtml.includes('<meta property="og:image" content="https://www.spelldash.net/assets/images/og-image.png" />') && gameHtml.includes('<meta name="twitter:card" content="summary_large_image" />') &&
    gdesc !== "" && gdesc === gmeta(/<meta property="og:description" content="([^"]*)"/) && gdesc.includes("登録なし") && gdesc.includes("90秒") && gdesc.indexOf("スマホ") >= 0 && gdesc.indexOf("スマホ") < 70 && !/noindex/i.test(gameHtml) &&
    gameHtml.includes("<h1>タイピングゲーム</h1>") && gameHtml.includes('<p class="subtitle">日本語の文を次々と打つ。登録なし・無料。</p>') && (about.match(/<li>/g) ?? []).length === 5 &&
    ["残り 90秒", "打ち始めると、90秒を測る。文ごとに持ち時間がある。尽きると次の文へ。", "今日はいい天気だ", "きょうはいいてんきだ", "取れた", "このページについて", `${G.COURSES.normal.note} ・ 目標 ${G.goalFor("normal")}文`].every((s) => gameHtml.includes(s)) &&
    noRival && /<nav class="site-footer__nav"[^>]*data-no-pro/.test(gameHtml) && (gameFooter.match(/<a [^>]*>/)?.[0] ?? "").includes('href="./typing.html"') && !gameFooter.includes("aria-current"), gdesc);
  const newsSrc = fs.readFileSync(path.join(ROOT, "js", "news.js"), "utf8");
  // お知らせは題で探す（タイピング練習の長文など、あとから先頭に足したお知らせで落ちない。検査の強さは同じ: その 1 件に 2 つのリンク）
  const newsAt = newsSrc.indexOf('title: "文を次々と打つ、90秒のタイピングゲーム"');
  const firstNews = newsAt < 0 ? "" : newsSrc.slice(newsSrc.lastIndexOf("{", newsAt), newsSrc.indexOf("},", newsAt));
  const typingHtml = fs.readFileSync(path.join(ROOT, "typing.html"), "utf8");
  const typingAbout = typingHtml.match(/<section class="tp-about"[\s\S]*?<\/section>/)?.[0] ?? "";
  check("typing game: sitemap・sw の precache・アプリの PAGES・お知らせ（題「文を次々と打つ、90秒のタイピングゲーム」の 1 件）に typing-game.html、ci.yml に教材の --check、typing.html の札の下から導線（このページについての外）", fs.readFileSync(path.join(ROOT, "sitemap.xml"), "utf8").includes("/typing-game.html") && fs.readFileSync(path.join(ROOT, "sw.js"), "utf8").includes('"/typing-game.html"') && fs.readFileSync(path.join(ROOT, "scripts", "build-app.mjs"), "utf8").includes('"typing-game.html"') && firstNews.includes("./typing-game.html") && firstNews.includes("./typing.html") && fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8").includes("node scripts/build-typing-game.mjs --check") && /<p class="tp-more">[^<]*<a href="\.\/typing-game\.html">タイピングゲーム<\/a><\/p>/.test(typingHtml) && !typingAbout.includes("typing-game.html"));
  const gameCss = fs.readFileSync(path.join(ROOT, "css", "typing-game.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  check("typing game: typing-game.css は animation／transition／@keyframes を持たず、太さは longhand、旧い書き方（999px・var(--radius)・rgba(0,0,0・#FFF）が無い", !/\b(animation|transition)(-[a-z]+)?\s*:/.test(gameCss) && !gameCss.includes("@keyframes") && !/text-decoration\s*:[^;]*\d+px/.test(gameCss) && ![/\b999px/, /var\(--radius\)/, /var\(--radius-lg\)/, /rgba\(0,\s*0,\s*0/, /#(?:FFF|fff)(?![0-9A-Fa-f])/].some((re) => re.test(gameCss)));
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
  check("ライトで背景が明色（羊皮紙 #F4ECDA = 平均 233。白ではないが暗い系統 <80 とは離れている）", bgLum > 200, `bg=${bodyBg}`);
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

// ===== 8.5 書斎の土台: ナビの現在地「書斎」・自前の明朝が読めている・外部への要求が無い（css/fonts.css・tokens.css・brand.css） =====
console.log("study (foundation):");
{
  const page = await newPage({ viewport: { width: 390, height: 844 } });
  const hosts = new Set();
  page.on("request", (req) => hosts.add(new URL(req.url()).host));
  await page.goto(BASE + "/index.html?t=3", { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  check("書斎: ナビの現在地が「書斎」", (await page.$eval('.site-nav [aria-current="page"]', (el) => el.textContent.trim())) === "書斎");
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    return {
      start: document.fonts.check('700 20px "Shippori Mincho"', "スタート"),
      family: getComputedStyle(document.getElementById("pathStart")).fontFamily,
      loaded: [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family + " " + f.weight)
    };
  });
  check("書斎: フォントは自前の明朝（Shippori Mincho 700 に「スタート」の字が揃い、#pathStart が明朝）", fonts.start && /Shippori Mincho/.test(fonts.family), `start=${fonts.start} family=${fonts.family} loaded=${fonts.loaded.slice(0, 4).join(",")}`);
  const own = new URL(BASE).host;
  check("書斎: 要求はすべて同一オリジン（Google Fonts などへ出ない）", [...hosts].every((h) => h === own), [...hosts].join(","));
  check("書斎の土台でエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();
  const page2 = await newPage();
  await page2.goto(BASE + "/list.html", { waitUntil: "networkidle" });
  await page2.waitForTimeout(400);
  check("書斎: 単語帳のナビにも「書斎」（「プレイ」は残っていない）", (await page2.textContent(".site-nav")).includes("書斎") && !(await page2.textContent(".site-nav")).includes("プレイ"));
  await page2.close();
}

// ===== 8.6 書斎（部屋・机の本・初回）: 1 画面目・場面は 1 枚・予算・横スクロール無し・動き・夜・紙片・積んだ本（css/room.css・js/pathView.js・js/welcome.js） =====
console.log("study (room):");
{
  const jhs1R0 = JSON.parse(fs.readFileSync(path.join(ROOT, "data/packs/jhs-english1.json"), "utf8")).words;
  const tagsR0 = [...new Set(jhs1R0.map((w) => w.tags[0]))];
  const doneR0 = new Set(tagsR0.slice(0, 3));
  const statsR0 = Object.fromEntries(jhs1R0.filter((w) => doneR0.has(w.tags[0])).map((w) => [w.id, { playCount: 1, knownOnSight: true, recallFail: 0 }]));
  const roomSeed = (extra = {}) => ({ storage: { spelldash_course: "jhs-redo", spelldash_packs: JSON.stringify(["jhs-english1"]), spelldash_category: "jhs-english1", spelldash_word_stats: JSON.stringify(statsR0), spelldash_placement: "done", ...extra } });
  const sceneState = (p) => p.evaluate(() => {
    const shown = [...document.querySelectorAll(".room__scene")].filter((e) => getComputedStyle(e).display !== "none");
    const url = shown[0] ? getComputedStyle(shown[0]).backgroundImage : "";
    const stage = document.querySelector(".room__stage")?.getBoundingClientRect();
    return { shown: shown.length, url, stageVisible: !!stage && stage.height > 0 && stage.width > 0 };
  });
  const budget = async (p) => {
    let font = 0, img = 0;
    const seen = new Set();
    p.on("response", async (r) => {
      try {
        const u = new URL(r.url()).pathname;
        if (seen.has(u)) return;
        seen.add(u);
        if (r.request().resourceType() === "font") font += (await r.body()).length;
        if (u.startsWith("/assets/images/room/")) img += (await r.body()).length;
      } catch {}
    });
    return () => ({ font, img });
  };

  // 390: 場面は 1 枚だけ読む・スタートは 1 個で全幅・1 画面目・横スクロール無し・動き 0・予算
  for (const theme of ["light", "dark"]) {
    const page = await newPage({ mobile: true, viewport: { width: 390, height: 844 }, ...roomSeed({ spelldash_theme: theme }) });
    const sceneRequests = [];
    page.on("request", (req) => { if (req.url().includes("/assets/images/room/scene-")) sceneRequests.push(req.url().split("/").pop()); });
    const read = await budget(page);
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    const sc = await sceneState(page);
    check(`書斎（390・${theme}）: 部屋の帯が見え、場面は 1 枚だけ読む`, sc.stageVisible && sc.shown === 1 && sceneRequests.length === 1, JSON.stringify({ ...sc, sceneRequests }));
    const start = await page.evaluate(() => { const r = document.getElementById("pathStart")?.getBoundingClientRect(); return { n: document.querySelectorAll("#pathStart").length, bottom: r?.bottom, width: r?.width, text: document.getElementById("pathStart")?.textContent.trim() }; });
    check(`書斎（390・${theme}）: スタートは 1 個・全幅・1 画面目（下端 ≤ 700px）`, start.n === 1 && start.width >= 300 && start.bottom <= 700 && start.text === "スタート", JSON.stringify(start));
    check(`書斎（390・${theme}）: 目次（#pathList）はスタートの下に見えている`, (await page.isVisible("#pathList .path__list")) && (await page.evaluate(() => document.querySelector("#pathList").getBoundingClientRect().top > document.getElementById("pathStart").getBoundingClientRect().bottom)));
    check(`書斎（390・${theme}）: 横スクロールしない`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), String(await page.evaluate(() => document.documentElement.scrollWidth)));
    // 夜に動くのはろうそくの明滅だけ（壁の溜まり .room__pool--candle と机の光 .desk__candle--l は同じ room-flicker・同位相 = 1 つの炎）。昼は 0
    const anims = await page.evaluate(() => document.getAnimations().map((a) => { const t = a.effect.target; return ([...t.classList].pop() || t.id) + (a.effect.pseudoElement || ""); }).sort());
    check(`書斎（390・${theme}）: 動きは${theme === "dark" ? "ろうそくの明滅 2 つ（壁の溜まりと机のろうそく）" : "無し"}`, theme === "dark" ? anims.join(",") === "desk__candle--l,room__pool--candle" : anims.length === 0, anims.join(",") || "0");
    if (theme === "dark") {
      check("書斎（夜）: 夜の絵と天井の色", sc.url.includes("-dark") && (await page.$eval('meta[name="theme-color"]', (el) => el.content)) === "#04060B", sc.url);
    }
    // 紙片はスタートに重ならない
    const slip = await page.evaluate(() => { const a = document.querySelector("#hasumiHome .hasumi__bubble")?.getBoundingClientRect(); const b = document.getElementById("pathStart").getBoundingClientRect(); return a ? { overlap: a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right, text: document.querySelector("#hasumiHome .hasumi__bubble").textContent.trim() } : null; });
    check(`書斎（390・${theme}）: はちゃんの紙片はスタートに重ならない`, slip && !slip.overlap && slip.text.length > 0, JSON.stringify(slip));
    // 予算: 本棚を一番下までスクロールしてから集計（フォント ≤ 520KB・場面の画像 ≤ 260KB）
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(500);
    const b = read();
    check(`書斎（390・${theme}）: フォント ≤ 520KB・場面の画像 ≤ 260KB`, b.font <= 520 * 1024 && b.img <= 260 * 1024, `font=${Math.round(b.font / 1024)}KB img=${Math.round(b.img / 1024)}KB`);
    // プレイ中は部屋の帯と目次が畳まれ、机に戻ると戻る
    await page.tap("#pathStart");
    await page.waitForTimeout(600);
    const playing = await page.evaluate(() => ({ stage: getComputedStyle(document.querySelector(".room__scene--phone")).display, cardTop: document.getElementById("gameCard").getBoundingClientRect().top }));
    check(`書斎（390・${theme}）: スタートで部屋の帯が畳まれ、ゲームカードが画面上部へ`, playing.stage === "none" && playing.cardTop >= 0 && playing.cardTop < 300, JSON.stringify(playing));
    await page.tap("#backToPath");
    await page.waitForTimeout(400);
    check(`書斎（390・${theme}）: 机に戻ると部屋の帯と目次が戻る`, (await sceneState(page)).shown === 1 && (await page.isVisible("#pathList .path__list")));
    check(`書斎（390・${theme}）でエラー0`, page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // reduced motion: 夜でも動く物は 0
  {
    const page = await newPage({ viewport: { width: 390, height: 844 }, ...roomSeed({ spelldash_theme: "dark" }) });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    check("書斎: reduced motion では夜でも動く物が 0", (await page.evaluate(() => document.getAnimations().length)) === 0);
    await page.close();
  }

  // 320: 横スクロール無し・スタートは全幅
  {
    const page = await newPage({ mobile: true, viewport: { width: 320, height: 640 }, ...roomSeed() });
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    const w = await page.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, start: document.getElementById("pathStart").getBoundingClientRect().width, shown: [...document.querySelectorAll(".room__scene")].filter((e) => getComputedStyle(e).display !== "none").length }));
    check("書斎（320）: 横スクロールしない・場面は 1 枚・スタートは全幅", w.scrollW <= w.innerW && w.shown === 1 && w.start >= 240, JSON.stringify(w));
    await page.close();
  }

  // 1200: 場面は机の 1 枚・スタートは 1 画面目・（本棚は Builder C のあとで右の列: #bookshelf の left ≥ 640）
  {
    const page = await newPage({ viewport: { width: 1200, height: 900 }, ...roomSeed() });
    const sceneRequests = [];
    page.on("request", (req) => { if (req.url().includes("/assets/images/room/scene-")) sceneRequests.push(req.url().split("/").pop()); });
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    const sc = await sceneState(page);
    const start = await page.evaluate(() => document.getElementById("pathStart").getBoundingClientRect());
    check("書斎（1200）: 場面は机の 1 枚だけ・スタートは 1 画面目", sc.shown === 1 && sc.url.includes("scene-desk") && sceneRequests.length === 1 && start.bottom < 900 && start.bottom > 0, JSON.stringify({ ...sc, sceneRequests, bottom: start.bottom }));
    check("書斎（1200）: 横スクロールしない", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    // 本棚は右の列（#bookshelf の left ≥ 640）。最初の棚板の上面は机の天板の線（--desk-top 398px）にそろう
    const shelfPos = await page.evaluate(() => ({ left: document.getElementById("bookshelf").getBoundingClientRect().left, hidden: document.getElementById("bookshelf").hidden, board: Math.round(document.querySelector("#bookshelf .shelf__board")?.getBoundingClientRect().top ?? -1), desk: Math.round(document.querySelector(".desk").getBoundingClientRect().top) }));
    check("書斎（1200）: 本棚は右の列（left ≥ 640）で、最初の棚板が机の天板の線にそろう", !shelfPos.hidden && shelfPos.left >= 640 && Math.abs(shelfPos.board - shelfPos.desk) <= 3, JSON.stringify(shelfPos));
    // Pro の文言は部屋に無い（#welcome を除く #room の文）
    const roomText = await page.evaluate(() => { const r = document.getElementById("room").cloneNode(true); r.querySelector("#welcome")?.remove(); return r.textContent; });
    check("書斎: 部屋の中に Pro・¥・「無料で」の文言が無い", !/Pro|¥|無料で/.test(roomText));
    await page.close();
  }

  // 初回: 積んだ本で机の本が替わり、スタートでその本が机に出て腕試しが始まる
  {
    const page = await newPage({ keepOnboarding: true, viewport: { width: 390, height: 844 } });
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    check("初回: スタートの文は「スタート」、ログインの行が見える、紙片は「はじめまして」", (await page.$eval("#welcome .welcome__cta [data-welcome-start]", (el) => el.textContent.trim())) === "スタート" && (await page.isVisible("#welcomeLogin")) && (await page.textContent("#hasumiHome .hasumi__bubble")).includes("はじめまして"));
    const firstStart = await page.evaluate(() => document.querySelector("#welcome .welcome__cta [data-welcome-start]").getBoundingClientRect());
    check("初回（390）: スタートは全幅で 1 画面目（下端 ≤ 700px）", firstStart.width >= 300 && firstStart.bottom <= 700, JSON.stringify(firstStart));
    check("初回（390）: 横スクロールしない", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.click('.flatbook[data-book="jhist1"]');
    await page.waitForTimeout(400);
    const picked = await page.evaluate(() => ({ t: document.querySelector('#welcomeBook [data-f="t"]').textContent, pressed: document.querySelector('.flatbook[data-book="jhist1"]').getAttribute("aria-pressed"), book: document.querySelector("#welcome [data-welcome-start]").dataset.book, back: !document.querySelector(".flatbook--back").closest("li").hidden }));
    check("初回: 積んだ本（社会）を押すと机の本が替わる（英単語は積みに降りる）", picked.t.includes("社会") && picked.pressed === "true" && picked.book === "jhist1" && picked.back, JSON.stringify(picked));
    const shelfKeysF = () => page.evaluate(() => [...document.querySelectorAll("#shelfRun li[data-key]")].map((li) => (li.dataset.state === "slot" ? "slot:" : "") + li.dataset.key));
    const previewF = await shelfKeysF(); // 下見の棚（スタート前・保存しない）
    await page.click("#welcome .welcome__cta [data-welcome-start]");
    await waitUntil(async () => (await page.evaluate(() => localStorage.getItem("spelldash_category"))) === "jhist1" && (await page.isVisible("#backToPath")), 6000);
    const after = await page.evaluate(() => ({ cat: localStorage.getItem("spelldash_category"), packs: JSON.parse(localStorage.getItem("spelldash_packs") || "[]"), course: localStorage.getItem("spelldash_course"), welcome: !document.getElementById("welcome").offsetParent }));
    const shelfF = await page.evaluate(() => JSON.parse(localStorage.getItem("spelldash_shelf") || "null"));
    const postF = await shelfKeysF();
    check("初回: スタートで選んだ本がパックに足され、机に出て、腕試しが始まる。スタート前の下見の棚は空き 中学歴史だけで、スタート後の spelldash_shelf は books [jhist1]・courses []・prov false、棚は下見と同じ（函・背 0）",
      after.cat === "jhist1" && after.packs.includes("jhist1") && (await page.isVisible("#backToPath")) && after.welcome && JSON.stringify(previewF) === JSON.stringify(["slot:b:jhist1"]) && JSON.stringify(shelfF?.books) === JSON.stringify(["jhist1"]) && shelfF?.courses.length === 0 && shelfF?.prov === false && JSON.stringify(postF) === JSON.stringify(previewF), JSON.stringify({ after, previewF, shelfF, postF }));
    check("初回の本選びでエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // 初回の「ログイン」で机の本に切り替わったら、紙片は「はじめまして」のままにしない（js/welcome.js が renderHasumiHome を呼ぶ）
  {
    const page = await newPage({ keepOnboarding: true, viewport: { width: 390, height: 844 } });
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    const before = (await page.textContent("#hasumiHome .hasumi__bubble")) ?? "";
    await page.click("#welcomeLogin");
    await page.waitForTimeout(400);
    const after = (await page.textContent("#hasumiHome .hasumi__bubble")) ?? "";
    check("初回: ログインの行でトップが畳まれたら、紙片は「はじめまして」から戻ってきた人の文に変わる", before.includes("はじめまして") && !after.includes("はじめまして") && after.trim().length > 0 && !(await page.isVisible("#welcome")), `${before} → ${after}`);
    await page.close();
  }
}

// ===== 8.6 わたしの本棚（js/bookshelf.js・js/shelfStore.js。Batch 61）: 自分で足した本と函だけ（机の本は空き）。171 冊の目録は「本を足す」の窓、下ろすのは「整理」 =====
// 種: shelfSeed（中学英語やり直し・中学英語 1年・最初の 3 章を覚えた）、shelfJson（spelldash_shelf の文字列）、countSeed(n)（目録の順の先頭 n 点・机は「すべて」・コースなし）、
// heavySeed（全部足した棚 = 函 10＋本 113＋マイ単語帳 = 124 点。頻度順の巻 58 は除く）。移行・照合の規則の分岐は scripts/test-shelf.mjs（node の単体）
console.log("bookshelf:");
{
  const jhs1S = JSON.parse(fs.readFileSync(path.join(ROOT, "data/packs/jhs-english1.json"), "utf8")).words;
  const tagsS = [...new Set(jhs1S.map((w) => w.tags[0]))];
  const doneS = new Set(tagsS.slice(0, 3));
  const statsS = Object.fromEntries(jhs1S.filter((w) => doneS.has(w.tags[0])).map((w) => [w.id, { playCount: 1, knownOnSight: true, recallFail: 0 }]));
  const shelfSeed = (extra = {}) => ({ storage: { spelldash_course: "jhs-redo", spelldash_packs: JSON.stringify(["jhs-english1"]), spelldash_category: "jhs-english1", spelldash_word_stats: JSON.stringify(statsS), spelldash_placement: "done", ...extra } });
  const shelfJson = (obj = {}) => JSON.stringify({ v: 1, books: [], courses: [], seen: ["jhs-english1"], prov: false, ...obj });
  const fontBytesOf = (names) => names.reduce((n, f) => { try { return n + fs.statSync(path.join(ROOT, "assets/fonts", f)).size; } catch { return n; } }, 0);
  const wordsOf = (cat) => { const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "data/packs", `${cat}.json`), "utf8")); return (Array.isArray(raw) ? raw : raw.words).filter((w) => !w.kanjiOnly); };
  // 目録（data/manifest.json と js/shelves.js）: 棚ごとの冊数と、全部足した棚のキー（頻度順の巻は除く）
  const catsS = JSON.parse(fs.readFileSync(path.join(ROOT, "data/manifest.json"), "utf8")).subjects.find((s) => s.id === "english").categories;
  const perShelf = catsS.reduce((m, c) => ({ ...m, [shelfIdOf(c.id, c)]: (m[shelfIdOf(c.id, c)] ?? 0) + 1 }), {});
  // 種は 1 回だけ入れる（newPage と違い、開き直し・別のページへの移動で種を上書きしない）
  async function seededPage(init = {}) {
    const opts = {};
    if (init.viewport) opts.viewport = init.viewport;
    if (init.mobile) Object.assign(opts, { isMobile: true, hasTouch: true });
    const page = await browser.newPage(opts);
    page.errors = [];
    page.on("pageerror", (e) => page.errors.push(e.message));
    await page.addInitScript((seed) => {
      if (sessionStorage.getItem("spelldash_test_seeded")) return;
      sessionStorage.setItem("spelldash_test_seeded", "1");
      localStorage.setItem("spelldash_schema_version", "6");
      if (!seed.keepOnboarding) localStorage.setItem("spelldash_onboarded", "1");
      for (const [k, v] of Object.entries(seed.storage ?? {})) localStorage.setItem(k, v);
    }, init);
    return page;
  }
  const openHome = async (page, url = "/index.html") => {
    await page.goto(BASE + url, { waitUntil: "networkidle" });
    await waitUntil(() => page.evaluate(() => !!document.querySelector("#shelfRun .shelf")), 6000);
    await page.waitForTimeout(300);
  };
  // 表示の並び（空きは "slot:" を付ける）・保存した棚
  const shelfKeys = (pg) => pg.evaluate(() => [...document.querySelectorAll("#shelfRun li[data-key]")].map((li) => (li.dataset.state === "slot" ? "slot:" : "") + li.dataset.key));
  const savedShelf = (pg) => pg.evaluate(() => JSON.parse(localStorage.getItem("spelldash_shelf") || "null"));
  // page.evaluate に渡す: これ以降の spelldash_shelf の書き込みを window.__shelfWrites に積む（書いた文字列）
  const spyShelfWrites = () => {
    window.__shelfWrites = [];
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (k === "spelldash_shelf") window.__shelfWrites.push(String(v));
      return set.call(this, k, v);
    };
  };
  // 学習の状態: spelldash_* を全部（本棚の保存 spelldash_shelf と、開いた時刻・端末で変わるキーは除く）＋カテゴリの並び（出題の範囲）。下ろす・足すの前後でこれが同じなら学習は変わっていない
  const LEARN_SKIP = ["spelldash_shelf", "spelldash_billing_open", "spelldash_device_id", "spelldash_user_items_meta"];
  const learning = (pg) => pg.evaluate(async (skip) => ({
    store: Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith("spelldash_") && !skip.includes(k)).sort().map((k) => [k, localStorage.getItem(k)])),
    cats: (await import("/js/wordStore.js")).getCategories().map((c) => c.id).join(",")
  }), LEARN_SKIP);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // 背の文字（題・副題・巻数）の矩形が背のボタンの上下から 2px より出ていないか（scrollHeight では transform のずれを拾えない）
  const spineGeo = (pg) => pg.evaluate(() => [...document.querySelectorAll("#bookshelf button.spine, #bookshelf button.box")].map((b) => { const br = b.getBoundingClientRect(); const ts = [...b.querySelectorAll(".spine__t, .spine__s, .box__n")].map((t) => t.getBoundingClientRect()).filter((r) => r.height > 0); if (!ts.length) return null; const over = Math.round(Math.max(br.top - Math.min(...ts.map((r) => r.top)), Math.max(...ts.map((r) => r.bottom)) - br.bottom)); return over > 2 ? `${b.dataset.book || b.dataset.course}:${over}` : null; }).filter(Boolean));
  // 段の割り付け: 物は段の内側・貪欲（次の段の最初の物はこの段の残りに入らない）・本立てと一文だけの段が無い・本立ては最後の段の残りに入るときだけ・一文の位置
  const rowsOf = (pg) => pg.evaluate(() => {
    const run = document.getElementById("shelfRun");
    const rows = [...run.querySelectorAll(":scope > .shelf")].map((s) => {
      const ul = s.querySelector(".books"), ub = ul.getBoundingClientRect(), cs = getComputedStyle(ul);
      const left = ub.left + parseFloat(cs.paddingLeft), right = ub.right - parseFloat(cs.paddingRight);
      const items = [...ul.querySelectorAll(":scope > li[data-key]")].map((li) => { const r = li.getBoundingClientRect(); return { key: li.dataset.key, group: li.dataset.group, left: r.left, right: r.right, w: r.width }; });
      const end = ul.querySelector(":scope > li.shelf-end");
      return { empty: s.classList.contains("shelf--empty"), left, right, inner: right - left, items, end: !!end, endRight: end ? end.getBoundingClientRect().right : null, top: s.getBoundingClientRect().top, bottom: s.getBoundingClientRect().bottom, h: s.offsetHeight };
    });
    const hintEl = document.getElementById("shelfHint");
    const hint = hintEl.hidden ? null : (() => { const r = hintEl.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, text: hintEl.textContent }; })();
    const nook = document.getElementById("nook").getBoundingClientRect(), plinth = document.querySelector(".cabinet__plinth").getBoundingClientRect();
    const doorsEl = run.querySelector(":scope > .shelf-doors");
    return { rows, hint, doors: doorsEl ? Math.round(doorsEl.getBoundingClientRect().height) : 0, nookBottom: nook.bottom, plinthBottom: plinth.bottom, listitems: run.querySelectorAll("li[data-key]").length, scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, booksScroll: [...run.querySelectorAll(".books")].some((u) => u.scrollWidth > u.clientWidth + 1), more: document.querySelectorAll("#bookshelf .more").length };
  });
  const layoutBad = (v, n) => {
    const bad = [];
    const filled = v.rows.filter((r) => r.items.length);
    if (n > 0 && filled.length === 0) bad.push("no-rows");
    v.rows.forEach((r, i) => {
      if (!r.empty && r.items.length === 0 && n > 0) bad.push(`row${i}:only-deco`);
      for (const it of r.items) if (it.left < r.left - 0.5 || it.right > r.right + 0.5) bad.push(`over:${it.key}`);
      if (r.end && r.endRight > r.right + 0.5) bad.push(`end-over:${i}`);
      const next = v.rows[i + 1];
      if (r.items.length && next?.items.length) {
        const last = r.items[r.items.length - 1], first = next.items[0];
        const gap = first.group !== last.group ? 10 : 2;
        if (r.right - last.right >= gap + first.w - 0.5) bad.push(`not-greedy:${i}`);
      }
    });
    const lastFilled = filled[filled.length - 1];
    v.rows.forEach((r, i) => { if (r.end && r !== lastFilled) bad.push(`end-not-last:${i}`); });
    if (lastFilled) {
      const rest = lastFilled.right - lastFilled.items[lastFilled.items.length - 1].right;
      if (rest >= 2 + 32 + 0.5 && !lastFilled.end) bad.push(`end-missing:${Math.round(rest)}`);
      if (rest < 2 + 32 - 0.5 && lastFilled.end) bad.push("end-no-room");
    }
    if (n <= 3 && !v.hint) bad.push("hint-missing");
    if (n > 3 && v.hint) bad.push("hint-extra");
    if (v.hint) {
      const r = v.rows.find((row) => v.hint.top >= row.top - 1 && v.hint.bottom <= row.bottom + 1);
      if (!r) bad.push("hint-out-of-row");
      else if (r.items.length && v.hint.left < r.items[r.items.length - 1].right) bad.push("hint-on-items");
    }
    if (v.listitems !== n) bad.push(`items:${v.listitems}`);
    if (v.scrollW > v.innerW || v.booksScroll || v.more) bad.push("scroll");
    return bad;
  };
  // 目録の順のキー（ページの shelfCatalogKeys）。全部足した棚は頻度順の巻を除く 124 点
  let catalog124 = null;
  const catalog = async () => {
    if (catalog124) return catalog124;
    const page = await newPage({ viewport: { width: 1200, height: 900 }, ...shelfSeed() });
    await openHome(page);
    const keys = await page.evaluate(() => import("/js/bookshelf.js").then((m) => m.shelfCatalogKeys()));
    await page.close();
    catalog124 = keys.filter((k) => !/^b:(ngsl|tsl|bsl|nawl)\d/.test(k));
    return catalog124;
  };
  const countSeed = (keys, n, extra = {}) => { const pick = keys.slice(0, n); return shelfSeed({ spelldash_course: "", spelldash_category: "all", spelldash_packs: "[]", spelldash_shelf: JSON.stringify({ v: 1, books: pick.filter((k) => k.startsWith("b:")).map((k) => k.slice(2)), courses: pick.filter((k) => k.startsWith("c:")).map((k) => k.slice(2)), seen: [], prov: false }), ...extra }); };

  // 1200: 移行した棚・窓の見出し・窓で足す → 背を押すと机・函でコース・仕事の言葉・検索・Enter・フォント
  {
    const page = await newPage({ viewport: { width: 1200, height: 900 }, ...shelfSeed() });
    const fontFiles = new Set();
    page.on("response", (r) => { if (r.request().resourceType() === "font") fontFiles.add(new URL(r.url()).pathname.split("/").pop()); });
    await openHome(page);
    const n = await page.evaluate(() => ({
      unlabeled: [...document.querySelectorAll("#shelfRun button")].filter((b) => !b.getAttribute("aria-label")).length,
      title: document.getElementById("bookshelfTitle")?.textContent.trim(), add: !document.getElementById("bookFinderOpen").hidden && document.getElementById("bookFinderOpen").textContent.trim(),
      current: document.querySelector('#shelfRun button.box[data-course="jhs-redo"]')?.className, slot: document.querySelector("#shelfRun .slot")?.getAttribute("aria-label")
    }));
    const keys0 = await shelfKeys(page);
    const saved0 = await savedShelf(page);
    check("本棚（移行・1200）: shelfSeed の棚は函 中学英語やり直し（いまのコース）と、その直後の空き 中学英語 1年の 2 点だけ。押せる物は名前つき、見出しは「わたしの本棚」、本を足すがある、spelldash_shelf は v1（courses [jhs-redo]・books []・prov false）",
      same(keys0, ["c:jhs-redo", "slot:b:jhs-english1"]) && n.unlabeled === 0 && n.title === "わたしの本棚" && n.add === "本を足す" && n.current?.includes("box--reading") && n.slot?.includes("中学英語 1年") && saved0?.v === 1 && same(saved0.courses, ["jhs-redo"]) && saved0.books.length === 0 && saved0.prov === false, JSON.stringify({ keys0, n, saved0 }));
    const firstFonts1200 = new Set(fontFiles); // 初回表示で読んだフォント（窓を開く前）
    // 窓: 入力が空なら棚ごとの見出し 9 つ（全部畳んである）。数はデータの数
    await page.click("#bookFinderOpen");
    await page.waitForTimeout(200);
    const cats = await page.evaluate(() => ({ title: document.getElementById("bookFinderTitle").textContent, hint: document.getElementById("bookFinderHint").textContent, list: [...document.querySelectorAll("#bookFinderBrowse details.cat")].map((d) => ({ id: d.dataset.shelf, open: d.open, text: d.querySelector("summary").textContent.replace(/\s+/g, " ").trim() })) }));
    const cat = Object.fromEntries(cats.list.map((c) => [c.id, c.text]));
    check("本を足す: 入力が空なら見出し 9 つ（コース 順に進むコース／英単語・試験・文法・英作文・頻度順の全集 答えは英語／社会・理科・数学・国語・漢字 答えは日本語／仕事の言葉 経理・医療・ITなど）で全部畳んである。数はデータの数",
      cats.title === "本を足す" && cats.hint === "棚ごとの一覧" && cats.list.length === 9 && cats.list.every((c) => !c.open) &&
      cat.course === "コース 6組 順に進むコース" && cat.eng === `英単語 ${perShelf.eng + 1}冊 答えは英語` && cat.exam === `試験 ${perShelf.exam}冊 答えは英語` && cat.grammar === `文法・英作文 ${perShelf.grammar}冊 答えは英語` && cat.freq === "頻度順の全集 4組 答えは英語" &&
      cat.social === `社会 ${perShelf.social}冊 答えは日本語` && cat.science === `理科・数学 ${perShelf.science}冊 答えは日本語` && cat.kokugo === `国語・漢字 ${perShelf.kokugo}冊 答えは日本語` && cat.job === `仕事の言葉 ${perShelf.job}冊 経理・医療・ITなど`, JSON.stringify(cats));
    // 窓で中学英語 3年を棚に足す → packs は変わらない → 閉じると焦点は足した背 → 押すと机に出る（未追加の巻はその場で読み込み、コースはそのまま、第3巻／全8巻、焦点はスタート）。空きは函の直後で、中学英語 1年は棚に無い（函の中）
    await page.fill("#bookFinderQ", "中学英語 3年");
    await page.waitForTimeout(100);
    await page.click('#bookFinderList .finder__act[data-key="b:jhs-english3"]');
    const packsAfterAdd = await page.evaluate(() => localStorage.getItem("spelldash_packs"));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    const focus3 = await page.evaluate(() => document.activeElement?.dataset.book);
    await page.keyboard.press("Enter");
    const picked = await waitUntil(async () => (await page.evaluate(() => localStorage.getItem("spelldash_category"))) === "jhs-english3" && (await page.textContent("#pathCard")).includes("第3巻／全8巻") &&
      (await page.evaluate(() => !!document.querySelector("#shelfRun .slot")?.getAttribute("aria-label")?.includes("中学英語 3年") && document.activeElement?.id === "pathStart")), 6000);
    const st = await page.evaluate(() => ({ packs: JSON.parse(localStorage.getItem("spelldash_packs") || "[]"), course: localStorage.getItem("spelldash_course"), focus: document.activeElement?.id, title: document.querySelector("#pathHead .path__title")?.textContent, status: document.getElementById("bookshelfStatus")?.textContent }));
    const keys3 = await shelfKeys(page);
    check("本棚: 窓で棚に足しただけでは packs は変わらず、閉じると焦点は足した背。押すと机の本が替わる（未追加の巻はその場で読み込み、コースはそのまま、第3巻／全8巻、焦点はスタート、空きは函の直後、中学英語 1年は函の中で背は無い）",
      packsAfterAdd === JSON.stringify(["jhs-english1"]) && focus3 === "jhs-english3" && picked && st.packs.includes("jhs-english3") && st.course === "jhs-redo" && st.focus === "pathStart" && st.title.includes("中学英語 3年") && same(keys3, ["c:jhs-redo", "slot:b:jhs-english3"]) && st.status.includes("机に出した"), JSON.stringify({ packsAfterAdd, focus3, st, keys3 }));
    // 窓で英検の函を足す → 函を押す: 英検のコースへ（制覇していない最初の巻 eiken5 から）。中学英語やり直しの函は印なしで残る
    await page.click("#bookFinderOpen");
    await page.fill("#bookFinderQ", "英検");
    await page.waitForTimeout(100);
    await page.click('#bookFinderList .finder__act[data-key="c:eiken"]');
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    await page.click('#shelfRun button.box[data-course="eiken"]');
    const boxed = await waitUntil(async () => (await page.evaluate(() => localStorage.getItem("spelldash_course"))) === "eiken" && (await page.textContent("#pathHead")).includes("英検5級") &&
      (await page.evaluate(() => !!document.querySelector('#shelfRun button.box--reading[data-course="eiken"]') && document.activeElement?.id === "pathStart")), 6000);
    const st2 = await page.evaluate(() => ({ cat: localStorage.getItem("spelldash_category"), label: document.querySelector('#shelfRun button.box[data-course="eiken"]').getAttribute("aria-label"), prev: document.querySelector('#shelfRun button.box[data-course="jhs-redo"]')?.className, focus: document.activeElement?.id }));
    check("本棚: 窓で足した函を押すとコースが替わる（eiken → eiken5、函に「いまのコース」、中学英語やり直しの函は印なしで残る、焦点は机のスタート）", boxed && st2.cat === "eiken5" && st2.label.includes("いまのコース") && !!st2.prev && !st2.prev.includes("box--reading") && st2.focus === "pathStart", JSON.stringify(st2));
    // 仕事の言葉: 見出しを開くと小見出し 8 つ・49 行（扉の代わり）。鍵穴は無い
    await page.click("#bookFinderOpen");
    await page.waitForTimeout(150);
    await page.click('#bookFinderBrowse details[data-shelf="job"] > summary');
    await page.waitForTimeout(150);
    const d = await page.evaluate(() => { const job = document.querySelector('#bookFinderBrowse details[data-shelf="job"]'); return { open: job.open, heads: [...job.querySelectorAll(".cat__h")].map((h) => h.textContent), rows: job.querySelectorAll(".finder__row").length, keyhole: document.querySelectorAll("#bookshelf [class*=keyhole], #bookshelf [class*=lock], #archiveDoors").length }; });
    check("本を足す: 仕事の言葉の見出しを開くと小見出し 8 つ・49 行（経理・法務・人事・総務 … 不動産・自動車）。鍵穴・錠・扉は無い", d.open && d.heads.length === 8 && d.heads[0] === "経理・法務・人事・総務" && d.heads[7] === "不動産・自動車" && d.rows === perShelf.job && d.keyhole === 0, JSON.stringify(d));
    // 検索: 「歴史」で高校日本史・世界史も（別名）、「トーイック」で TOEIC。足していない回は Esc で閉じて焦点は本を足す
    await page.fill("#bookFinderQ", "歴史");
    await page.waitForTimeout(100);
    const f = await page.evaluate(() => ({ rows: document.querySelectorAll("#bookFinderList .finder__row").length, text: document.getElementById("bookFinderList").textContent, hint: document.getElementById("bookFinderHint").textContent, browse: document.getElementById("bookFinderBrowse").hidden }));
    await page.fill("#bookFinderQ", "トーイック");
    await page.waitForTimeout(100);
    const f2 = await page.evaluate(() => document.getElementById("bookFinderList").textContent);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    const f3 = await page.evaluate(() => ({ open: document.getElementById("bookFinder").open, focus: document.activeElement?.id }));
    check("本を足す: 検索（「歴史」で 6 冊以上、高校日本史・世界史も。「トーイック」で TOEIC。入力があると見出しは隠れる）。足していない回は Esc で閉じて焦点は本を足す", f.rows >= 6 && f.text.includes("高校日本史") && f.text.includes("高校世界史") && f.hint === `${f.rows}冊` && f.browse && f2.includes("TOEIC") && !f3.open && f3.focus === "bookFinderOpen", JSON.stringify({ ...f, text: f.text.slice(0, 80), f2: f2.slice(0, 40), f3 }));
    // 入力欄の Enter は最初の行のボタンへ焦点を移すだけ（足さない・閉じない）。もう一度 Enter で足す。足した物をもう一度押すと「棚にある」
    const before9 = await learning(page);
    await page.click("#bookFinderOpen");
    await page.fill("#bookFinderQ", "古文");
    await page.waitForTimeout(100);
    await page.keyboard.press("Enter");
    const e1 = await page.evaluate(() => ({ open: document.getElementById("bookFinder").open, focus: document.activeElement?.getAttribute("aria-label"), saved: JSON.parse(localStorage.getItem("spelldash_shelf")).books.includes("hs-kobun") }));
    await page.keyboard.press("Enter");
    await page.waitForTimeout(100);
    const e2 = await page.evaluate(() => ({ open: document.getElementById("bookFinder").open, focus: document.activeElement?.getAttribute("aria-label"), disabled: document.activeElement?.getAttribute("aria-disabled"), text: document.activeElement?.textContent.trim(), saved: JSON.parse(localStorage.getItem("spelldash_shelf")).books.includes("hs-kobun"), status: document.getElementById("bookFinderStatus").textContent }));
    await page.keyboard.press("Enter");
    await page.waitForTimeout(100);
    const e3 = await page.evaluate(() => document.getElementById("bookFinderStatus").textContent);
    check("本を足す: 入力欄の Enter は最初の行のボタンへ焦点を移すだけ（閉じない・足さない）。もう一度 Enter で足す（高校 古文単語が「棚にある」に・packs・机・コースは変わらない）。もう一度押すと「高校 古文単語は棚にある」",
      e1.open && e1.focus === "高校 古文単語を棚に足す" && !e1.saved && e2.open && e2.focus === "高校 古文単語は棚にある" && e2.disabled === "true" && e2.text === "棚にある" && e2.saved && e2.status === "棚に足した: 高校 古文単語" && e3 === "高校 古文単語は棚にある" && same(before9, await learning(page)), JSON.stringify({ e1, e2, e3 }));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    // 本を足す → 棚 → 机: 都道府県を足して Esc → 焦点は都道府県の背 → Enter で机に出る（コース外: 柱は社会の棚・答えは日本語・60枚・コースの鍵はそのまま）。続けて中学英語 3年の背を押すと、都道府県は背として棚に戻る
    await page.click("#bookFinderOpen");
    await page.fill("#bookFinderQ", "都道府県");
    await page.waitForTimeout(100);
    await page.click('#bookFinderList .finder__act[data-key="b:pref"]');
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    const focusPref = await page.evaluate(() => document.activeElement?.dataset.book);
    await page.keyboard.press("Enter");
    const found = await waitUntil(async () => (await page.evaluate(() => localStorage.getItem("spelldash_category"))) === "pref" && (await page.evaluate(() => document.activeElement?.id === "pathStart")), 6000);
    const st4 = await page.evaluate(() => ({ kicker: document.querySelector("#pathHead .path__kicker")?.textContent, course: localStorage.getItem("spelldash_course"), meta: document.querySelector("#pathHead .path__meta")?.textContent }));
    await page.click('#shelfRun button.spine[data-book="jhs-english3"]');
    await waitUntil(async () => (await page.evaluate(() => localStorage.getItem("spelldash_category"))) === "jhs-english3", 6000);
    await page.waitForTimeout(300);
    const back = await page.evaluate(() => !!document.querySelector('#shelfRun button.spine[data-book="pref"]'));
    check("本を足す → 棚 → 机: 都道府県を足して閉じると焦点はその背、Enter で机に出る（柱は「社会の棚」、答えは日本語・60枚、コースの鍵はそのまま、焦点はスタート）。机から下りると背として棚に戻る", focusPref === "pref" && found && st4.kicker.includes("社会の棚") && st4.course === "eiken" && st4.meta.includes("日本語") && st4.meta.includes("60枚") && back, JSON.stringify({ focusPref, st4, back }));
    // フォント: 典型の棚（shelfSeed）の初回表示は ≤ 520KB。窓（仕事の言葉の見出しまで）を開いて増えるのは Shippori 500 のサブセットだけ（700 はスタートの分だけ）
    const added1200 = [...fontFiles].filter((x) => !firstFonts1200.has(x));
    check("本棚（1200）: フォントは自前の明朝だけで初回表示 ≤ 520KB、本を足すと仕事の言葉の見出しで増えるのは Shippori 500 のサブセットだけ", [...fontFiles].every((x) => /^(shippori-mincho|cormorant-garamond|ibm-plex-mono)/.test(x)) && fontBytesOf([...firstFonts1200]) <= 520 * 1024 && added1200.every((x) => x.includes("shippori-mincho") && x.includes("-500-")), `first=${firstFonts1200.size} files ${Math.round(fontBytesOf([...firstFonts1200]) / 1024)}KB, after finder=${fontFiles.size} files ${Math.round(fontBytesOf([...fontFiles]) / 1024)}KB, added=${added1200.join(" ")}`);
    check("本棚（1200）でエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // 1200: 全部足した棚（124 点）: 名前・答え方・背の文字・roving（段をまたいでも Tab で止まるのは 1 つ）・フォント ≤ 600KB
  const keys124 = await catalog();
  for (const [w, h, mobile] of [[1200, 900, false], [390, 844, true]]) {
    const page = await newPage({ mobile, viewport: { width: w, height: h }, ...countSeed(keys124, keys124.length) });
    let fontBytes = 0;
    const seenFont = new Set();
    page.on("response", async (r) => { try { const u = new URL(r.url()).pathname; if (r.request().resourceType() !== "font" || seenFont.has(u)) return; seenFont.add(u); fontBytes += (await r.body()).length; } catch {} });
    await openHome(page);
    if (w === 1200) {
      const lab = await page.evaluate(() => [...document.querySelectorAll("#shelfRun li[data-key]")].map((li) => ({ key: li.dataset.key, group: li.dataset.group, label: li.querySelector("button")?.getAttribute("aria-label") ?? "" })));
      const ja = lab.filter((x) => ["social", "science", "kokugo", "job"].includes(x.group));
      const en = lab.filter((x) => ["eng", "exam"].includes(x.group));
      const kanji = lab.filter((x) => x.key === "b:jkokugo2" || x.key === "b:hs-kanbun");
      check("本棚（全部足した棚・1200）: 押せる物 124 点が全部名前つき。社会・理科・国語・仕事の背は「答えは日本語」、英単語・試験の背は「答えは英語」、漢字の読み（中学）・漢文は「一部は漢字で答える」",
        lab.length === 124 && lab.every((x) => x.label) && ja.length === perShelf.social + perShelf.science + perShelf.kokugo + perShelf.job && ja.every((x) => x.label.includes("答えは日本語")) && en.length === perShelf.eng + perShelf.exam + 1 && en.every((x) => x.label.includes("答えは英語")) && kanji.length === 2 && kanji.every((x) => x.label.includes("一部は漢字で答える")), JSON.stringify({ n: lab.length, unlabeled: lab.filter((x) => !x.label).map((x) => x.key), ja: ja.length, en: en.length, badJa: ja.filter((x) => !x.label.includes("答えは日本語")).map((x) => x.key), kanji }));
      // roving: 最初の物から End で最後（別の段）へ、← で 1 つ戻る。Tab で止まるのは #shelfRun の中で 1 つ
      await page.evaluate(() => document.querySelector("#shelfRun button.box, #shelfRun button.spine").focus());
      await page.keyboard.press("ArrowRight");
      const k1 = await page.evaluate(() => document.activeElement?.closest("li")?.dataset.key);
      await page.keyboard.press("End");
      await page.keyboard.press("ArrowLeft");
      const kb = await page.evaluate(() => ({ key: document.activeElement?.closest("li")?.dataset.key, rowOfFocus: [...document.querySelectorAll("#shelfRun > .shelf")].indexOf(document.activeElement.closest(".shelf")), tab0: [...document.querySelectorAll("#shelfRun button")].filter((b) => b.tabIndex === 0).length }));
      const keysNow = await shelfKeys(page);
      check("本棚: roving tabindex（→ で隣、End で最後の物、← で 1 つ戻る。段をまたいでも Tab で止まるのは #shelfRun の中で 1 つ）", k1 === keysNow[1] && kb.key === keysNow[keysNow.length - 2] && kb.rowOfFocus > 0 && kb.tab0 === 1, JSON.stringify({ k1, kb, second: keysNow[1], beforeLast: keysNow[keysNow.length - 2] }));
    }
    const geo = await spineGeo(page);
    check(`本棚（${w}）: 全部足した棚で背の文字が背の上下からはみ出さない（題箋つきの長い題・仕事の言葉を含む）`, geo.length === 0, geo.join(" "));
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(400);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    check(`本棚（全部足した棚・${w}）: フォントは ≤ 600KB（一番下まで送って）`, fontBytes > 0 && fontBytes <= 600 * 1024, `font=${Math.round(fontBytes / 1024)}KB`);
    await page.close();
  }

  // 390: 段は折り返す（20 点）・背を押すと机へ・プレイ中は畳む・畳まれている間の組み直し・窓は画面に収まる・典型の棚のフォント
  {
    const page = await newPage({ mobile: true, viewport: { width: 390, height: 844 }, ...countSeed(keys124, 20) });
    await openHome(page);
    const v = await rowsOf(page);
    const order = await page.evaluate(() => [...document.querySelectorAll("#shelfRun .shelf")].every((s) => { const a = s.querySelector(".books"), b = s.querySelector(".shelf__board"); return a && b && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); }));
    const bad = layoutBad(v, 20);
    check("本棚（390）: 20 点の棚は段が折り返す（.books の横スクロール・「あと N冊」は無い）、どの物も段の内側、DOM は本 → 棚板の順、頁の横スクロール無し", v.rows.filter((r) => r.items.length).length >= 3 && bad.length === 0 && order, JSON.stringify({ rows: v.rows.length, bad, order }));
    await page.close();
  }
  {
    const page = await newPage({ mobile: true, viewport: { width: 390, height: 844 }, ...shelfSeed({ spelldash_shelf: shelfJson({ books: ["jhist1", "eiken3", "jsci1", "jgeo1", "toeic500", "hs-kobun", "jkokugo1", "accounting"], courses: ["jhs-redo"] }) }) });
    const fontFiles = new Set();
    page.on("response", (r) => { if (r.request().resourceType() === "font") fontFiles.add(new URL(r.url()).pathname.split("/").pop()); });
    await openHome(page);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(500);
    const firstFonts390 = new Set(fontFiles); // 初回表示（一番下までスクロール）で読んだフォント。窓を開く前
    await page.evaluate(() => window.scrollTo(0, 0));
    // 背を押す（社会の本）: 机へ戻って焦点はスタート。柱は「社会の棚」、答えは日本語・75枚、コースの鍵はそのまま
    await page.click('#shelfRun button.spine[data-book="jhist1"]');
    const picked = await waitUntil(async () => (await page.evaluate(() => localStorage.getItem("spelldash_category"))) === "jhist1", 6000);
    await page.waitForTimeout(1500);
    const p = await page.evaluate(() => ({ focus: document.activeElement?.id, cardTop: Math.round(document.getElementById("pathCard").getBoundingClientRect().top), kicker: document.querySelector("#pathHead .path__kicker")?.textContent, course: localStorage.getItem("spelldash_course"), meta: document.querySelector("#pathHead .path__meta")?.textContent, n: document.querySelectorAll("#pathStart").length }));
    check("本棚（390）: 背を押すと机へ戻り、焦点はスタート（柱は「社会の棚」、答えは日本語・75枚、コースはそのまま、スタートは 1 個）", picked && p.focus === "pathStart" && p.cardTop > -300 && p.cardTop < 300 && p.kicker.includes("社会の棚") && p.course === "jhs-redo" && p.meta.includes("75枚") && p.n === 1, JSON.stringify(p));
    // プレイ中は本棚を畳み、机に戻ると出る。畳まれている間に組み直されても（同期）、出たときの段は幅から貪欲に詰めた形
    const rowsBefore = (await rowsOf(page)).rows.map((r) => r.items.map((x) => x.key));
    await page.tap("#pathStart");
    await page.waitForTimeout(600);
    const hid = await page.evaluate(() => getComputedStyle(document.getElementById("bookshelf")).display);
    await page.evaluate(() => import("/js/bookshelf.js").then((m) => m.renderBookshelf())); // 同期で組み直したのと同じ（畳まれたまま）
    await page.waitForTimeout(100);
    await page.tap("#backToPath");
    await page.waitForTimeout(600);
    const shown = await page.evaluate(() => getComputedStyle(document.getElementById("bookshelf")).display);
    const after = await rowsOf(page);
    const badAfter = layoutBad(after, 9);
    check("本棚（390）: プレイ中は畳まれ、机に戻ると出る", hid === "none" && shown !== "none", `${hid} → ${shown}`);
    check("本棚（390）: 畳まれている間に renderBookshelf() しても、出たときの段は幅から貪欲に詰めた形で（畳む前と同じ段）、どの物も段からはみ出さない", badAfter.length === 0 && after.rows.filter((r) => r.items.length).length >= 2 && same(after.rows.map((r) => r.items.map((x) => x.key)), rowsBefore), JSON.stringify({ badAfter, rows: after.rows.map((r) => r.items.length), before: rowsBefore.map((r) => r.length) }));
    // 窓は画面に収まり、仕事の言葉を開くと 49 行に届き窓の中で縦に送れる
    const beforeFinder390 = new Set(fontFiles); // ここから先（本を足す）で増えるフォント（プレイの「続きから」の 700・盤面の mono はスタートの分）
    await page.click("#bookFinderOpen");
    await page.waitForTimeout(200);
    await page.click('#bookFinderBrowse details[data-shelf="job"] > summary');
    await page.waitForTimeout(200);
    const fd = await page.evaluate(() => { const r = document.querySelector("#bookFinder .finder__card").getBoundingClientRect(); const body = document.querySelector("#bookFinder .finder__body"); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, rows: document.querySelectorAll('#bookFinderBrowse details[data-shelf="job"] .finder__row').length, scrolls: body.scrollHeight > body.clientHeight + 10, scrollW: document.documentElement.scrollWidth }; });
    check("本を足す（390）: 窓は画面に収まり（左 ≥ 0・右 ≤ 390）、仕事の言葉を開くと 49 行に届き窓の中で縦に送れる、頁の横スクロール無し", fd.left >= 0 && fd.right <= 390 && fd.top >= 0 && fd.bottom <= 844 && fd.rows === perShelf.job && fd.scrolls && fd.scrollW <= 390, JSON.stringify(fd));
    await page.keyboard.press("Escape");
    const added390 = [...fontFiles].filter((x) => !beforeFinder390.has(x));
    check("本棚（390）: 典型の棚の初回表示（本棚を一番下まで）のフォント ≤ 520KB、本を足すで増えるのは Shippori 500 のサブセットだけ", fontBytesOf([...firstFonts390]) <= 520 * 1024 && added390.every((x) => x.includes("shippori-mincho") && x.includes("-500-")), `first=${firstFonts390.size} files ${Math.round(fontBytesOf([...firstFonts390]) / 1024)}KB, after finder=${fontFiles.size} files, added=${added390.join(" ")}`);
    check("本棚（390）でエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // 初回: 本棚は下見の棚（いまスタートしたら並ぶ物。保存しない）。「171冊から選ぶ」は語の読み込みの前から見え、窓（本をさがす・コースだけ開いて始める）で机の本を替える。スタートで下見と同じ棚になる
  {
    const page = await seededPage({ keepOnboarding: true, viewport: { width: 390, height: 844 } });
    await page.addInitScript(() => document.addEventListener("DOMContentLoaded", () => { const b = document.getElementById("welcomeFind"); window.__findEarly = b ? { hidden: b.hidden, text: b.textContent.trim() } : null; }));
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await waitUntil(() => page.evaluate(() => document.querySelectorAll("#shelfRun li[data-key]").length > 0), 6000);
    await page.waitForTimeout(300);
    const v0 = await page.evaluate(() => ({ early: window.__findEarly, find: document.getElementById("welcomeFind")?.textContent.trim(), findVisible: !!document.getElementById("welcomeFind")?.offsetParent, hint: document.getElementById("shelfHint").hidden ? null : document.getElementById("shelfHint").textContent, add: document.getElementById("bookFinderOpen").hidden, tidy: document.getElementById("shelfTidy").hidden, welcome: document.body.classList.contains("welcome-open") }));
    const keysW = await shelfKeys(page);
    await page.click("#welcomeFind");
    await page.waitForTimeout(200);
    const dlg = await page.evaluate(() => ({ open: document.getElementById("bookFinder").open, title: document.getElementById("bookFinderTitle").textContent, opened: [...document.querySelectorAll("#bookFinderBrowse details[open]")].map((x) => x.dataset.shelf), my: !!document.querySelector('#bookFinder [data-key="b:my"]'), acts: [...new Set([...document.querySelectorAll("#bookFinder .finder__act")].map((b) => b.textContent.trim()))] }));
    await page.fill("#bookFinderQ", "古文");
    await page.waitForTimeout(100);
    await page.click('#bookFinderList .finder__act[data-key="b:hs-kobun"]');
    await page.waitForTimeout(500);
    const w = await page.evaluate(() => ({ open: document.getElementById("bookFinder").open, t: document.querySelector('#welcomeBook [data-f="t"]').textContent, s: document.querySelector('#welcomeBook [data-f="s"]').textContent, book: document.querySelector("#welcome [data-welcome-start]").dataset.book, cat: localStorage.getItem("spelldash_category"), packs: localStorage.getItem("spelldash_packs") || "", shelf: localStorage.getItem("spelldash_shelf"), focus: document.activeElement?.matches("#welcome .welcome__cta [data-welcome-start]") }));
    const keysK = await shelfKeys(page);
    check("初回: 本棚は下見の棚（函 中学英語やり直し＋空き 中学英語 1年）と一文「ほかの本は、あとから足せる。」で、本を足す・整理は無い。「171冊から選ぶ」は読み込みの前から見え（数は目録の本の数）、押すと窓（本をさがす・コースだけ開いている・行は「机に出す」）。古文単語の「机に出す」で窓が閉じ、机の本と下見の棚が空き 古文単語だけに替わる（始めない・packs も spelldash_shelf も書かない・焦点はスタート）",
      v0.welcome && same(keysW, ["c:jhs-redo", "slot:b:jhs-english1"]) && v0.hint === "ほかの本は、あとから足せる。" && v0.add && v0.tidy && v0.early && !v0.early.hidden && v0.find === `${catsS.length}冊から選ぶ` && v0.findVisible &&
      dlg.open && dlg.title === "本をさがす" && same(dlg.opened, ["course"]) && !dlg.my && same(dlg.acts, ["机に出す"]) &&
      !w.open && w.t.includes("国語") && w.s.includes("古文単語") && w.book === "hs-kobun" && w.cat === "jhs-english1" && !w.packs.includes("hs-kobun") && w.shelf === null && w.focus && same(keysK, ["slot:b:hs-kobun"]), JSON.stringify({ v0, keysW, dlg, w, keysK }));
    // 窓のコースの見出しの TOEIC 500→990 の「机に出す」→ 最初の巻が机に、下見は函 TOEIC＋空き TOEIC 500点。スタートでコースの鍵が回り、棚は下見と同じ
    await page.click("#welcomeFind");
    await page.waitForTimeout(200);
    await page.click('#bookFinderBrowse .finder__act[data-key="c:toeic"]');
    await page.waitForTimeout(500);
    const pre = await shelfKeys(page);
    const b = await page.evaluate(() => ({ book: document.querySelector("#welcome [data-welcome-start]").dataset.book, course: localStorage.getItem("spelldash_course") }));
    await page.click("#welcome .welcome__cta [data-welcome-start]");
    const started = await waitUntil(async () => (await page.evaluate(() => localStorage.getItem("spelldash_category"))) === "toeic500" && (await page.isVisible("#backToPath")), 8000);
    await page.click("#backToPath").catch(() => {});
    await page.waitForTimeout(500);
    const a = await page.evaluate(() => ({ course: localStorage.getItem("spelldash_course"), packs: JSON.parse(localStorage.getItem("spelldash_packs") || "[]"), shelf: JSON.parse(localStorage.getItem("spelldash_shelf") || "null") }));
    const post = await shelfKeys(page);
    check("初回: 窓のコースの TOEIC 500→990 の「机に出す」で最初の巻が机に、下見の棚は函 TOEIC＋空き TOEIC 500点。スタートでコースの鍵が回り、棚は下見と同じ（spelldash_shelf は courses [toeic]・books []・prov false）",
      b.book === "toeic500" && b.course === "jhs-redo" && same(pre, ["c:toeic", "slot:b:toeic500"]) && started && a.course === "toeic" && a.packs.includes("toeic500") && same(a.shelf?.courses, ["toeic"]) && a.shelf?.books.length === 0 && a.shelf?.prov === false && same(post, pre), JSON.stringify({ b, pre, a, post }));
    check("初回（本棚）でエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }
  {
    // 初回の窓（本をさがす）を開いている間に welcome が畳まれる（ログインの行・auth-ready）: 窓は閉じ、机の本も保存も替わらない（REVIEW-logic S3）
    const page = await seededPage({ keepOnboarding: true, viewport: { width: 390, height: 844 } });
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await waitUntil(() => page.evaluate(() => document.querySelectorAll("#shelfRun li[data-key]").length > 0), 6000);
    await page.click("#welcomeFind");
    await page.waitForTimeout(200);
    const opened = await page.evaluate(() => document.getElementById("bookFinder").open);
    await page.evaluate(() => document.getElementById("welcomeLogin").click());
    await page.waitForTimeout(400);
    const w = await page.evaluate(() => ({ open: document.getElementById("bookFinder").open, welcome: document.body.classList.contains("welcome-open"), add: !document.getElementById("bookFinderOpen").hidden, cat: localStorage.getItem("spelldash_category"), shelf: localStorage.getItem("spelldash_shelf") }));
    check("初回: 本をさがすの窓を開いている間に welcome が畳まれると窓は閉じ、本棚は普段の形（本を足すが出る）。机の本は替わらない", opened && !w.open && !w.welcome && w.add && (w.cat === null || w.cat === "jhs-english1") && page.errors.length === 0, JSON.stringify({ opened, w, errors: page.errors.slice(0, 2) }));
    // PR #154 レビュー 5: スタート以外（ログインの行）で閉じた直後の描き直しは見せるだけで保存しない。次の描き直し（renderHome が呼ぶ updateBookshelf）で普通に移行して保存する
    const next = await page.evaluate(async () => {
      const m = await import("/js/bookshelf.js");
      m.updateBookshelf();
      return { shelf: JSON.parse(localStorage.getItem("spelldash_shelf") || "null"), keys: [...document.querySelectorAll("#shelfRun li[data-key]")].map((li) => (li.dataset.state === "slot" ? "slot:" : "") + li.dataset.key) };
    });
    check("初回（PR #154 レビュー 5）: ログインの行で閉じた直後の描き直しは spelldash_shelf を書かず、次の描き直しで移行して書く（既定のままの仮の棚）",
      w.shelf === null && next.shelf?.v === 1 && next.shelf?.prov === true && page.errors.length === 0, JSON.stringify({ shelf: w.shelf, next, errors: page.errors.slice(0, 2) }));
    await page.close();
  }

  // ---- 移行（既存の人）: 明示の印から組み立ち、記録だけの本は入らない ----
  {
    const page = await newPage({ viewport: { width: 1200, height: 900 }, ...shelfSeed({ spelldash_packs: JSON.stringify(["jhs-english1", "jhs-english2", "jhist1", "eiken3", "ngsl02"]), spelldash_my_words: JSON.stringify([{ en: "quill", ja: "羽ペン" }]), spelldash_best_by_category: JSON.stringify({ toeic: 30, all: 50 }) }) });
    await openHome(page);
    const keys = await shelfKeys(page);
    check("本棚（移行）: 明示の印から組み立つ（函 中学英語やり直し・空き 中学英語 1年・函 NGSL・背 マイ単語帳・英検3級・TOEIC・中学歴史）。記録だけの英単語の本（中学英語 基本・高校英語・日常・旅行・IT）・中学英語 2年・NGSL の巻の背は無い",
      same(keys, ["c:jhs-redo", "slot:b:jhs-english1", "c:ngsl", "b:my", "b:eiken3", "b:toeic", "b:jhist1"]) && page.errors.length === 0, JSON.stringify({ keys, errors: page.errors.slice(0, 2) }));
    await page.close();
  }
  {
    const hist = Object.fromEntries(wordsOf("jhist1").slice(0, 10).map((x) => [x.id, { playCount: 1, knownOnSight: true, recallFail: 0 }]));
    const page = await newPage({ viewport: { width: 390, height: 844 }, ...shelfSeed({ spelldash_category: "jhist1", spelldash_packs: JSON.stringify(["jhs-english1", "jhist1"]), spelldash_word_stats: JSON.stringify(hist) }) });
    await openHome(page);
    const keys = await shelfKeys(page);
    const saved = await savedShelf(page);
    check("本棚（移行）: 旧版の初回で歴史を選んだ人に、使っていない中学英語やり直しは出ない（空き 中学歴史だけ・courses は空）", same(keys, ["slot:b:jhist1"]) && saved?.courses.length === 0 && same(saved?.books, ["jhist1"]), JSON.stringify({ keys, saved }));
    await page.close();
  }
  {
    // 既定のコースで学んだ人が、移行した瞬間に机をチップ（TOEIC）にしていても、中学英語やり直しの函は落ちない（REVIEW-logic M1）
    const page = await newPage({ viewport: { width: 1200, height: 900 }, ...shelfSeed({ spelldash_category: "toeic" }) });
    await openHome(page);
    const keys = await shelfKeys(page);
    const saved = await savedShelf(page);
    check("本棚（移行）: 既定のコースのまま机がチップ TOEIC の人は、函 中学英語やり直し（印なし）と空き TOEIC（courses [jhs-redo]・books [toeic]）", same(keys, ["c:jhs-redo", "slot:b:toeic"]) && same(saved?.courses, ["jhs-redo"]) && same(saved?.books, ["toeic"]) && page.errors.length === 0, JSON.stringify({ keys, saved }));
    await page.close();
  }

  // ---- 整理: 下ろしても学習は変わらない・下ろした物はその場に暗く残り札は「戻す」・連打しても隣は下りない・終わる・窓で棚に足すに戻る ----
  {
    const page = await newPage({ viewport: { width: 1200, height: 900 }, ...shelfSeed({ spelldash_shelf: shelfJson({ books: ["jhist1", "eiken3"], courses: ["jhs-redo", "eiken"] }) }) });
    await openHome(page);
    const before = await learning(page);
    await page.click("#shelfTidy");
    await page.waitForTimeout(200);
    const t1 = await page.evaluate(() => ({ slips: [...document.querySelectorAll("#shelfRun .slip")].map((s) => s.dataset.key), mode: document.getElementById("bookshelf").dataset.mode, tidy: document.getElementById("shelfTidy").textContent.trim(), add: document.getElementById("bookFinderOpen").hidden, note: document.getElementById("shelfNote").textContent, buttons: document.querySelectorAll("#shelfRun button.spine, #shelfRun button.box").length, focus: document.activeElement?.classList.contains("slip"), keys: [...document.querySelectorAll("#shelfRun li[data-key]")].map((li) => li.dataset.key) }));
    // 段の位置は文書の座標で比べる（画面がほかの理由で送られても「段が動かない」を見られる）
    const runH0 = await page.evaluate(() => Math.round(document.getElementById("shelfRun").getBoundingClientRect().top + scrollY));
    // 同じ札を続けて 2 回押す（連打）: 中学歴史だけが下り（2 回目は読み捨て）、隣（英検3級）は下りない。並びは変わらず、中学歴史は暗く残って札は「戻す」
    // 同じ座標をマウスで 2 回押す（利用者の「同じ所を 2 回押す」そのもの）。page.click を 2 回だと、描き直した札の :hover の動きで 2 回目が
    // 「element is not stable」の再試行に入り、送り方を替えながら画面を送るので、段の位置の比べ・0.45 秒の読み捨てが揺れる（VERIFY M-new-1）
    {
      const slip = page.locator('#shelfRun .slip[data-key="b:jhist1"]');
      await slip.scrollIntoViewIfNeeded();
      const bb = await slip.boundingBox();
      const x = bb.x + bb.width / 2, y = bb.y + bb.height * 0.7;
      await page.mouse.click(x, y);
      await page.mouse.click(x, y);
    }
    await page.waitForTimeout(200);
    const t2 = await page.evaluate(() => ({ dropped: document.querySelector('#shelfRun li[data-key="b:jhist1"]')?.classList.contains("is-dropped"), slip: document.querySelector('#shelfRun .slip[data-key="b:jhist1"]')?.textContent.trim(), label: document.querySelector('#shelfRun .slip[data-key="b:jhist1"]')?.getAttribute("aria-label"), neighbour: !document.querySelector('#shelfRun li[data-key="b:eiken3"]')?.classList.contains("is-dropped"), saved: JSON.parse(localStorage.getItem("spelldash_shelf")), note: document.getElementById("shelfNote").textContent, undo: !!document.getElementById("shelfUndo"), focus: document.activeElement?.classList.contains("slip") ? document.activeElement.dataset.key : document.activeElement?.id, keys: [...document.querySelectorAll("#shelfRun li[data-key]")].map((li) => li.dataset.key), runTop: Math.round(document.getElementById("shelfRun").getBoundingClientRect().top + scrollY) }));
    await page.waitForTimeout(500);
    await page.click('#shelfRun .slip[data-key="c:eiken"]');
    await page.waitForTimeout(200);
    const course = await page.evaluate(() => localStorage.getItem("spelldash_course"));
    const after = await learning(page);
    check("本棚（整理）: 札は英検の函・英検3級・中学歴史の 3 枚（いまのコースの函と空きには無い）。中学歴史の札を続けて 2 回押しても下りるのは中学歴史だけ（隣の英検3級は下りない）。下ろした背はその場に暗く残り札は「戻す」（並びも段の位置も変わらない）、「中学歴史 古代〜近世を下ろした。」、焦点は同じ札。函 英検を下ろしてもコースは jhs-redo。spelldash_*（本棚の保存を除く）とカテゴリの並びは前後で同じ",
      same(t1.slips, ["c:eiken", "b:eiken3", "b:jhist1"]) && t1.mode === "tidy" && t1.tidy === "終わる" && t1.add && t1.note === "下ろす本の札を押す。記録は消えない。" && t1.buttons === 0 && t1.focus &&
      t2.dropped && t2.slip === "戻す" && t2.label === "中学歴史 古代〜近世を棚に戻す" && t2.neighbour && !t2.saved.books.includes("jhist1") && t2.saved.books.includes("eiken3") && t2.note === "中学歴史 古代〜近世を下ろした。" && !t2.undo && t2.focus === "b:jhist1" && same(t2.keys, t1.keys) && t2.runTop === runH0 &&
      course === "jhs-redo" && same(before, after), JSON.stringify({ runH0, t1, t2, course, same: same(before, after) }));
    // 戻す: 函 英検の札「戻す」で棚に戻り、札は「下ろす」に（同じ札の 0.45 秒以内の 2 回目は読み捨てるので、間を空けて押す）。もう一度下ろして「終わる」→ 下ろした 2 点が消え、背はボタンに戻り焦点は「整理」
    await page.waitForTimeout(500);
    await page.click('#shelfRun .slip[data-key="c:eiken"]');
    await page.waitForTimeout(200);
    const u = await page.evaluate(() => ({ back: !document.querySelector('#shelfRun li[data-key="c:eiken"]')?.classList.contains("is-dropped"), slip: document.querySelector('#shelfRun .slip[data-key="c:eiken"]')?.textContent.trim(), saved: JSON.parse(localStorage.getItem("spelldash_shelf")).courses.includes("eiken"), focus: document.activeElement?.dataset.key, note: document.getElementById("shelfNote").textContent }));
    await page.waitForTimeout(500);
    await page.click('#shelfRun .slip[data-key="c:eiken"]');
    await page.waitForTimeout(200);
    await page.click("#shelfTidy");
    await page.waitForTimeout(200);
    const end = await page.evaluate(() => ({ slips: document.querySelectorAll("#shelfRun .slip").length, buttons: document.querySelectorAll("#shelfRun button.spine, #shelfRun button.box").length, keys: [...document.querySelectorAll("#shelfRun li[data-key]")].map((li) => li.dataset.key), focus: document.activeElement?.id, note: document.getElementById("shelfNote").hidden, mode: document.getElementById("bookshelf").dataset.mode }));
    await page.click("#bookFinderOpen");
    await page.fill("#bookFinderQ", "歴史");
    await page.waitForTimeout(100);
    const row = await page.evaluate(() => { const b = document.querySelector('#bookFinderList .finder__act[data-key="b:jhist1"]'); return { text: b?.textContent.trim(), disabled: b?.getAttribute("aria-disabled") }; });
    check("本棚（整理）: 函 英検の「戻す」で棚に戻り（札は「下ろす」・焦点はその札・「英検 5級→1級を棚に戻した。」）。もう一度下ろして「終わる」→ 下ろした中学歴史と英検が棚から消え、札が消えて背はボタンに戻り焦点は「整理」。窓で「歴史」→ 中学歴史 古代〜近世の行は「棚に足す」（押せる）",
      u.back && u.slip === "下ろす" && u.saved && u.focus === "c:eiken" && u.note === "英検 5級→1級を棚に戻した。" && end.slips === 0 && end.buttons >= 2 && same(end.keys, ["c:jhs-redo", "b:jhs-english1", "b:eiken3"]) && end.focus === "shelfTidy" && end.note && end.mode === "" && row.text === "棚に足す" && row.disabled === null, JSON.stringify({ u, end, row }));
    check("本棚（整理）でエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // ---- 机の本と 1 セット: 机の本は棚に無くても空きで出る。1 セット始めた本は机から下りても背で残る。チップを見て回るだけでは増えない ----
  {
    const page = await newPage({ viewport: { width: 1200, height: 900 }, ...shelfSeed() });
    await openHome(page);
    const saved0 = await page.evaluate(() => localStorage.getItem("spelldash_shelf"));
    await page.click("#setupToggle");
    await page.waitForTimeout(150);
    const seen = [];
    for (const id of ["toeic", "it", "ads", "jhs-english1"]) {
      await page.click(`#categoryPicker .category-chip[data-category="${id}"]`);
      await page.waitForTimeout(250);
      seen.push((await shelfKeys(page)).join(","));
    }
    const saved1 = await page.evaluate(() => localStorage.getItem("spelldash_shelf"));
    const keysEnd = await shelfKeys(page);
    check("本棚: チップを見て回るだけでは棚が増えない（TOEIC → IT → 広告 → 中学英語 1年。そのたびに空きが替わるが spelldash_shelf は同じ、最後は 2 点）", seen[0].includes("slot:b:toeic") && seen[1].includes("slot:b:it") && seen[2].includes("slot:b:ads") && saved0 === saved1 && same(keysEnd, ["c:jhs-redo", "slot:b:jhs-english1"]), JSON.stringify({ seen, saved0, saved1, keysEnd }));
    await page.click('#categoryPicker .category-chip[data-category="toeic"]');
    await page.waitForTimeout(250);
    const k1 = await shelfKeys(page);
    const reading = await page.evaluate(() => document.querySelector('#shelfRun button.box[data-course="jhs-redo"]')?.className);
    const saved2 = await page.evaluate(() => localStorage.getItem("spelldash_shelf"));
    await page.click("#pathStart");
    await waitUntil(() => page.evaluate(() => document.body.classList.contains("home--playing")), 4000);
    const savedPlay = await savedShelf(page);
    await page.click("#backToPath");
    await page.waitForTimeout(400);
    await page.click('#shelfRun button.box[data-course="jhs-redo"]');
    await waitUntil(async () => (await page.evaluate(() => localStorage.getItem("spelldash_category"))) !== "toeic", 6000);
    await page.waitForTimeout(400);
    const k2 = await shelfKeys(page);
    check("本棚: 机の本は棚に無くても空きで出て（チップ TOEIC → 試験の群に空き、中学英語やり直しから「いまのコース」が外れる、spelldash_shelf は変わらない）、1 セット始める（study）と保存され、机から下りても背として残る",
      k1.includes("slot:b:toeic") && !reading.includes("box--reading") && saved2 === saved0 && savedPlay?.books.includes("toeic") && k2.includes("b:toeic") && !k2.includes("slot:b:toeic"), JSON.stringify({ k1, reading, savedPlay, k2 }));
    check("本棚（机の本と 1 セット）でエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }
  {
    // 次の巻に進む（advanceSection と同じ状態）: 空きが函の直後で次の巻に替わり、巻の背は増えない
    const page = await seededPage({ viewport: { width: 390, height: 844 }, ...shelfSeed() });
    await openHome(page);
    await page.evaluate(() => { localStorage.setItem("spelldash_category", "jhs-english2"); localStorage.setItem("spelldash_packs", JSON.stringify(["jhs-english1", "jhs-english2"])); });
    await openHome(page);
    const keys = await shelfKeys(page);
    check("本棚: 次の巻に進むと空きが函の直後で次の巻に替わり、巻の背は増えない（函 中学英語やり直し・空き 中学英語 2年の 2 点）", same(keys, ["c:jhs-redo", "slot:b:jhs-english2"]), JSON.stringify(keys));
    await page.close();
  }

  // ---- 段の形: 320・390（N7）／1100・1200（N8）× 0・1・2・5・20・60 点 ----
  for (const [w, h, mobile] of [[320, 640, true], [390, 844, true], [1100, 900, false], [1200, 900, false]]) {
    const results = [];
    for (const n of [0, 1, 2, 5, 20, 60]) {
      const seed = n === 2 ? shelfSeed() : countSeed(keys124, n);
      const page = await newPage({ mobile, viewport: { width: w, height: h }, ...seed });
      await openHome(page);
      const v = await rowsOf(page);
      const bad = layoutBad(v, n);
      const wide = w >= 1100;
      // ≥1100: 段（空の段は 1 枚まで）＋腰の扉で 2 段ぶん以上。扉があれば台輪は机の列の下端に立つ（±1px）。扉が無ければ今までどおり 1 段未満の上
      if (wide && v.rows.length * v.rows[0].h + v.doors < 2 * v.rows[0].h - 1) bad.push("rows<2");
      const filled = v.rows.filter((r) => r.items.length).length;
      if (wide && v.doors && v.rows.length - filled > 1) bad.push(`empty-rows:${v.rows.length - filled}`);
      if (wide && v.doors && Math.abs(v.plinthBottom - v.nookBottom) > 1) bad.push(`doors-plinth:${Math.round(v.plinthBottom)}/${Math.round(v.nookBottom)}`);
      if (wide && !v.doors && filled < v.rows.length && !(v.plinthBottom <= v.nookBottom + 1 && v.nookBottom - v.plinthBottom < v.rows[0].h)) bad.push(`plinth:${Math.round(v.plinthBottom)}/${Math.round(v.nookBottom)}`);
      if (!wide && v.doors) bad.push("doors-narrow");
      if (w === 320 && n === 2 && (filled !== 1 || v.rows.length !== 1 || !v.hint)) bad.push("320-2pt");
      if (page.errors.length) bad.push(`err:${page.errors[0]}`);
      results.push({ n, rows: v.rows.length, filled, doors: v.doors, inner: Math.round(v.rows[0]?.inner ?? 0), bad });
      await page.close();
    }
    const label = w >= 1100 ? `本棚（${w}、昼）: 0・1・2・5・20・60 点の形（空の段は 1 枚まで、その下は腰の扉で机の列の下端まで＝台輪は机の列の下端に立つ。少ない棚（0・1・2・5 点）には扉がある${w === 1100 ? "・段の内側 296px 前後" : ""}）` : `本棚（${w}、昼）: 0・1・2・5・20・60 点の形（腰の扉は無い）`;
    const ok = results.every((r) => r.bad.length === 0) && (w !== 1100 || Math.abs(results[0].inner - 296) <= 2) && (w < 1100 || results.filter((r) => r.n <= 5).every((r) => r.doors > 0));
    check(`${label}: どの物も段の内側・貪欲・本立てと一文だけの段が無い・本立ては最後の段の残りに入るときだけ・一文は 3 点以下のときだけ・${w === 320 ? "2 点（函＋空き）は 1 段で一文も同じ段・" : ""}頁の横スクロール無し・項目数 = 点数`, ok, JSON.stringify(results.filter((r) => r.bad.length || w === 1100).slice(0, 4)));
  }

  // ---- 夜: 390・1200 × 5 点・60 点。整理の札は夜の地（#A99C84）で字との比 ≥ 4.5:1 ----
  {
    const night = [];
    for (const [w, h, mobile] of [[390, 844, true], [1200, 900, false]]) for (const n of [5, 60]) {
      const page = await newPage({ mobile, viewport: { width: w, height: h }, ...countSeed(keys124, n, { spelldash_theme: "dark" }) });
      await openHome(page);
      const v = await page.evaluate(() => {
        const rail = document.querySelector(".cabinet__rail").getBoundingClientRect(), t = document.getElementById("bookshelfTitle").getBoundingClientRect();
        const acts = [...document.querySelectorAll(".rail__acts .find:not([hidden])")].map((b) => b.getBoundingClientRect());
        return { theme: document.documentElement.dataset.theme, scrollW: document.documentElement.scrollWidth, innerW: innerWidth, oneLine: acts.every((a) => Math.abs((a.top + a.bottom) / 2 - (t.top + t.bottom) / 2) <= 8 && a.left >= t.right && a.right <= rail.right), acts: acts.length };
      });
      let slip = null;
      if (n === 5) {
        await page.click("#shelfTidy");
        await page.waitForTimeout(200);
        slip = await page.evaluate(() => {
          const el = document.querySelector("#shelfRun .slip__paper"), cs = getComputedStyle(el);
          const rgb = (s) => (s.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
          const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
          const bg = rgb(cs.backgroundColor), fg = rgb(cs.color);
          const [l1, l2] = [lum(bg), lum(fg)].sort((a, b) => b - a);
          return { bg: cs.backgroundColor, ratio: Math.round(((l1 + 0.05) / (l2 + 0.05)) * 10) / 10 };
        });
      }
      night.push({ w, n, ...v, slip, errors: page.errors.length });
      await page.close();
    }
    check("本棚（夜）: 390・1200 で 5 点と 60 点の棚がエラー 0・横スクロール無し・見出しの欄が 1 行。整理の札の地は夜の色（#A99C84）で字との比 ≥ 4.5:1", night.every((x) => x.theme === "dark" && x.errors === 0 && x.scrollW <= x.innerW && x.oneLine && x.acts === 2) && night.filter((x) => x.slip).every((x) => x.slip.bg === "rgb(169, 156, 132)" && x.slip.ratio >= 4.5), JSON.stringify(night));
  }

  // ---- 壊れた spelldash_shelf でもエラー 0 で作り直す ----
  {
    const out = [];
    for (const raw of ["{", JSON.stringify({ v: 2 })]) {
      const page = await newPage({ viewport: { width: 390, height: 844 }, ...shelfSeed({ spelldash_shelf: raw }) });
      await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
      await waitUntil(() => page.evaluate(() => !!document.querySelector("#shelfRun li[data-key]")), 6000);
      out.push({ raw, keys: await shelfKeys(page), saved: await savedShelf(page), errors: page.errors.length });
      await page.close();
    }
    check("本棚: 壊れた spelldash_shelf（「{」・v 2）でもエラー 0 で、shelfSeed と同じ 2 点が出て v1 で書き直される", out.every((x) => x.errors === 0 && same(x.keys, ["c:jhs-redo", "slot:b:jhs-english1"]) && x.saved?.v === 1 && same(x.saved.courses, ["jhs-redo"])), JSON.stringify(out));
  }

  // ---- 単語帳との関係: 追加したパックは棚に並び、外したパックは棚からも下りる（list.html は触らない。ホームで packs の差分を見る） ----
  {
    const page = await seededPage({ viewport: { width: 1200, height: 900 }, ...shelfSeed() });
    await openHome(page);
    const toggle = async () => {
      await page.goto(BASE + "/list.html", { waitUntil: "networkidle" });
      await waitUntil(() => page.evaluate(() => !!document.querySelector('[data-pack-toggle="realestate"]')), 6000);
      const was = await page.evaluate(() => JSON.parse(localStorage.getItem("spelldash_packs") || "[]").includes("realestate"));
      await page.evaluate(() => { const b = document.querySelector('[data-pack-toggle="realestate"]'); document.getElementById("packsFold")?.setAttribute("open", ""); b.closest("details")?.setAttribute("open", ""); b.click(); });
      await waitUntil(() => page.evaluate((w) => JSON.parse(localStorage.getItem("spelldash_packs") || "[]").includes("realestate") !== w, was), 6000);
      await page.waitForTimeout(300);
    };
    await toggle();
    await openHome(page);
    const k1 = await shelfKeys(page);
    const s1 = await savedShelf(page);
    check("本棚: 単語帳で追加したパック（不動産）はホームの棚に並び（机の本になっているので空き）、spelldash_shelf.books に入る", k1.includes("slot:b:realestate") && s1?.books.includes("realestate"), JSON.stringify({ k1, s1 }));
    await toggle();
    await openHome(page);
    const k2 = await shelfKeys(page);
    const s2 = await savedShelf(page);
    check("本棚: 単語帳で外したパックは棚からも下りる（背も空きも無く、spelldash_shelf.books にも無い）", !k2.some((k) => k.includes("realestate")) && !s2?.books.includes("realestate") && page.errors.length === 0, JSON.stringify({ k2, s2, errors: page.errors.slice(0, 2) }));
    await page.close();
  }

  // ---- 窓の名前と文言・行のどこを押しても足せる・閉じると焦点は最後に足した背 ----
  {
    const page = await newPage({ viewport: { width: 1200, height: 900 }, ...shelfSeed() });
    await openHome(page);
    const packs0 = await page.evaluate(() => localStorage.getItem("spelldash_packs"));
    await page.click("#bookFinderOpen");
    await page.waitForTimeout(150);
    await page.evaluate(() => document.querySelectorAll("#bookFinderBrowse details").forEach((x) => { x.removeAttribute("name"); x.open = true; })); // 見出しは 1 つずつ開く（name）。全部開くために外す
    const nm = await page.evaluate(() => { const dlg = document.getElementById("bookFinder"); return { title: document.getElementById(dlg.getAttribute("aria-labelledby"))?.textContent, acts: dlg.querySelectorAll(".finder__act").length, unlabeled: [...dlg.querySelectorAll(".finder__act, button")].filter((b) => !b.getAttribute("aria-label") && !b.textContent.trim()).length, text: dlg.textContent }; });
    check("本を足す: 窓の見出しは「本を足す」（aria-labelledby）、行のボタンは全部名前つき、窓の文に絵文字・Pro・¥・無料で が無い", nm.title === "本を足す" && nm.acts === 6 + perShelf.eng + 1 + perShelf.exam + perShelf.grammar + 4 + perShelf.social + perShelf.science + perShelf.kokugo + perShelf.job && nm.unlabeled === 0 && !/\p{Extended_Pictographic}|Pro|¥|無料で/u.test(nm.text), JSON.stringify({ ...nm, text: nm.text.length }));
    await page.fill("#bookFinderQ", "古文");
    await page.waitForTimeout(100);
    await page.click('#bookFinderList .finder__act[data-key="b:hs-kobun"]');
    await page.fill("#bookFinderQ", "都道府県");
    await page.waitForTimeout(100);
    await page.click('#bookFinderList .finder__row[data-book="pref"] .finder__t');
    await page.waitForTimeout(100);
    const st = await page.evaluate(() => ({ pref: document.querySelector('#bookFinderList .finder__act[data-key="b:pref"]')?.textContent.trim() }));
    await page.fill("#bookFinderQ", "古文");
    await page.waitForTimeout(100);
    const kob = await page.evaluate(() => document.querySelector('#bookFinderList .finder__act[data-key="b:hs-kobun"]')?.textContent.trim());
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    const focus = await page.evaluate(() => document.activeElement?.dataset.book);
    const keys = await shelfKeys(page);
    const fresh = await page.evaluate(() => [...document.querySelectorAll("#shelfRun li.is-new")].map((li) => li.dataset.key));
    check("本棚: 足すと「棚にある」になり（行の題を押しても足せる）、閉じると焦点は最後に足した背（都道府県）、表示は 4 点（函・空き・都道府県・古文単語）、足した 2 点の頭に金の押し点（is-new）、packs は前と同じ",
      st.pref === "棚にある" && kob === "棚にある" && focus === "pref" && same(keys, ["c:jhs-redo", "slot:b:jhs-english1", "b:pref", "b:hs-kobun"]) && same([...fresh].sort(), ["b:hs-kobun", "b:pref"]) && packs0 === (await page.evaluate(() => localStorage.getItem("spelldash_packs"))), JSON.stringify({ st, kob, focus, keys, fresh }));
    await page.close();
  }

  // ---- 窓の見出しは 1 つずつ開き、開いた見出しは窓の上端へ（下の見出しを開いても中身が見える）。検索は書名の一致が先 ----
  {
    const page = await newPage({ mobile: true, viewport: { width: 390, height: 844 }, ...shelfSeed() });
    await openHome(page);
    await page.click("#bookFinderOpen");
    await page.waitForTimeout(200);
    const heads = [];
    for (const id of ["course", "eng", "exam", "grammar", "freq", "social", "science", "kokugo", "job"]) {
      await page.click(`#bookFinderBrowse details[data-shelf="${id}"] > summary`);
      await page.waitForTimeout(450);
      heads.push(await page.evaluate((sid) => {
        const body = document.querySelector("#bookFinder .finder__body").getBoundingClientRect();
        const d = document.querySelector(`#bookFinderBrowse details[data-shelf="${sid}"]`);
        const first = d.querySelector(".finder__row")?.getBoundingClientRect();
        return { id: sid, open: d.open, opened: document.querySelectorAll("#bookFinderBrowse details[open]").length, firstIn: !!first && first.top >= body.top - 1 && first.bottom <= body.bottom + 1 };
      }, id));
    }
    check("本を足す（390）: 9 つの見出しをどれを開いても、開いた見出しの最初の行が窓の中に見え（下の見出しは窓の上端へ送る）、開いている見出しは 1 つだけ", heads.every((x) => x.open && x.opened === 1 && x.firstIn), JSON.stringify(heads.filter((x) => !(x.open && x.opened === 1 && x.firstIn))));
    const firsts = {};
    for (const q of ["英検準2級", "文法", "漢字", "TOEIC 600", "古文", "ngsl"]) {
      await page.fill("#bookFinderQ", q);
      await page.waitForTimeout(120);
      firsts[q] = await page.evaluate(() => { const r = document.querySelector("#bookFinderList .finder__row"); return r ? r.dataset.book || `c:${r.dataset.course}` : null; });
    }
    check("本を足す: 検索は照合の強さの順（書名と一致 → 書名の頭 → 書名に含む → 棚名・別名 → 紹介文）。1 行目は「英検準2級」で英検準2級、「文法」で中学英文法 1年、「漢字」で小学 漢字の読み、「TOEIC 600」で TOEIC 600点、「古文」で古文単語、「ngsl」で NGSL の函",
      firsts["英検準2級"] === "eikenp2" && firsts["文法"] === "grammar-jhs1" && firsts["漢字"] === "elem-kanji" && firsts["TOEIC 600"] === "toeic600" && firsts["古文"] === "hs-kobun" && firsts.ngsl === "c:ngsl", JSON.stringify(firsts));
    check("本を足す（見出し・検索）でエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // ---- 机の本だけの棚（初めての人がスタートした後）: 空きに代本板（短い題と「机の上」）が立ち、黒い穴に見えない ----
  {
    const out = [];
    for (const [w, h, mobile] of [[390, 844, true], [1200, 900, false]]) for (const theme of ["light", "dark"]) {
      const page = await newPage({ mobile, viewport: { width: w, height: h }, ...shelfSeed({ spelldash_theme: theme, spelldash_course: "", spelldash_category: "jhist1", spelldash_packs: JSON.stringify(["jhist1"]), spelldash_word_stats: "{}", spelldash_shelf: shelfJson({ books: ["jhist1"], seen: ["jhist1"] }) }) });
      await openHome(page);
      out.push(await page.evaluate(() => {
        const slot = document.querySelector("#shelfRun .slot"), card = slot?.querySelector(".slot__card");
        const sr = slot?.getBoundingClientRect(), cr = card?.getBoundingClientRect();
        const rgb = (s) => (s.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
        const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
        const k = card?.querySelector(".slot__k"), cs = card && getComputedStyle(card), ks = k && getComputedStyle(k);
        const [l1, l2] = card ? [lum(rgb(cs.backgroundColor)), lum(rgb(ks.color))].sort((a, b) => b - a) : [0, 0];
        return { keys: [...document.querySelectorAll("#shelfRun li[data-key]")].map((li) => (li.dataset.state === "slot" ? "slot:" : "") + li.dataset.key), label: slot?.getAttribute("aria-label"), text: card?.textContent, hidden: card?.getAttribute("aria-hidden"), inside: !!cr && cr.width >= 28 && cr.height >= 80 && cr.left >= sr.left - 0.5 && cr.right <= sr.right + 0.5 && cr.bottom <= sr.bottom + 0.5, ratio: Math.round(((l1 + 0.05) / (l2 + 0.05)) * 10) / 10, errors: 0 };
      }));
      out[out.length - 1].errors = page.errors.length;
      await page.close();
    }
    check("本棚: 机の本だけの棚（390・1200 × 昼夜）は空き 1 点で、空きに代本板（「中学歴史 上巻」と「机の上」・読み上げは空きの「…は机の上」だけ）が空きの中に立つ。紙と「机の上」の比 ≥ 4.5:1",
      out.every((x) => same(x.keys, ["slot:b:jhist1"]) && x.label === "中学歴史 古代〜近世は机の上" && x.text === "中学歴史上巻机の上" && x.hidden === "true" && x.inside && x.ratio >= 4.5 && x.errors === 0), JSON.stringify(out));
  }

  // ---- 読み上げ: list の項目数は表示する物の数（一文・本立ては数えない）。整理の形でも項目に名前がある ----
  {
    const page = await newPage({ viewport: { width: 1200, height: 900 }, ...shelfSeed({ spelldash_shelf: shelfJson({ books: ["jhist1"], courses: ["jhs-redo"] }) }) });
    await openHome(page);
    const items = (snap) => snap.split("\n").filter((l) => /^\s*- listitem/.test(l)).length;
    const named = (snap) => { const lines = snap.split("\n"); return lines.every((l, i) => !/^\s*- listitem:?$/.test(l) || /"[^"]+"/.test(lines[i + 1] ?? "")); };
    const s1 = await page.locator("#shelfRun").ariaSnapshot();
    const hint = await page.evaluate(() => !document.getElementById("shelfHint").hidden);
    await page.click("#shelfTidy");
    await page.waitForTimeout(200);
    const s2 = await page.locator("#shelfRun").ariaSnapshot();
    check("本棚（読み上げ）: 3 点の棚（一文あり）の list の listitem は 3、整理の形でも 3 で、どの項目にも名前がある。list の名前は「棚の本」（region の「わたしの本棚」と重ねない）", hint && items(s1) === 3 && items(s2) === 3 && named(s1) && named(s2) && /list "棚の本"/.test(s1) && !/list "わたしの本棚"/.test(s1), JSON.stringify({ s1, s2 }));
    await page.close();
  }

  // ---- 整理（キーボードだけ）: 見出しの欄は「本を足す → 整理」の順。下ろす・戻す（同じ札で Enter）・→ で次の札・終わる。全部下ろして終わる → 焦点は本を足す ----
  {
    const page = await newPage({ viewport: { width: 1200, height: 900 }, ...shelfSeed({ spelldash_shelf: shelfJson({ books: ["jhist1", "eiken3"], courses: ["jhs-redo"] }) }) });
    await openHome(page);
    const at = () => page.evaluate(() => { const a = document.activeElement; return a?.classList.contains("slip") ? `slip:${a.dataset.key}:${a.textContent.trim()}` : a?.id || a?.tagName; });
    await page.evaluate(() => { const t = document.getElementById("bookshelfTitle"); t.tabIndex = -1; t.focus(); });
    await page.keyboard.press("Tab");
    const a0 = await at();
    await page.keyboard.press("Tab");
    const a0b = await at();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    const a1 = await at();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    const a2 = await at();
    const dropped = await page.evaluate(() => document.querySelector('#shelfRun li[data-key="b:eiken3"]')?.classList.contains("is-dropped") && !JSON.parse(localStorage.getItem("spelldash_shelf")).books.includes("eiken3"));
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    const a3 = await at();
    const back = await page.evaluate(() => !document.querySelector('#shelfRun li[data-key="b:eiken3"]')?.classList.contains("is-dropped") && JSON.parse(localStorage.getItem("spelldash_shelf")).books.includes("eiken3"));
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    await page.keyboard.press("ArrowRight");
    const a4 = await at();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    await page.keyboard.press("Shift+Tab");
    const a5 = await at();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    const a6 = await at();
    const tidyHidden = await page.evaluate(() => document.getElementById("shelfTidy").hidden);
    const keysEnd = await shelfKeys(page);
    check("本棚（整理・キーボードだけ）: Tab で「本を足す」→ Tab で「整理」→ Enter で焦点は最初の札 → Enter で英検3級が下りて札は「戻す」（焦点はそのまま）→ Enter で戻る → もう一度下ろして → で中学歴史の札 → Enter で下ろす → Shift+Tab で「終わる」→ Enter で焦点は「本を足す」（「整理」は隠れる・棚は函と空きの 2 点）",
      a0 === "bookFinderOpen" && a0b === "shelfTidy" && a1 === "slip:b:eiken3:下ろす" && a2 === "slip:b:eiken3:戻す" && dropped && a3 === "slip:b:eiken3:下ろす" && back && a4 === "slip:b:jhist1:下ろす" && a5 === "shelfTidy" && a6 === "bookFinderOpen" && tidyHidden && same(keysEnd, ["c:jhs-redo", "slot:b:jhs-english1"]) && page.errors.length === 0, JSON.stringify({ a0, a0b, a1, a2, dropped, a3, back, a4, a5, a6, tidyHidden, keysEnd }));
    await page.close();
  }

  // ---- 初回: パックの紹介頁から来た人の棚に、足したパックが入る ----
  {
    const page = await seededPage({ keepOnboarding: true, viewport: { width: 390, height: 844 } });
    await page.goto(BASE + "/list.html?add=accounting", { waitUntil: "networkidle" });
    await waitUntil(() => page.evaluate(() => JSON.parse(localStorage.getItem("spelldash_packs") || "[]").includes("accounting")), 6000);
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await waitUntil(() => page.evaluate(() => document.querySelectorAll("#shelfRun li[data-key]").length > 0), 6000);
    await page.waitForTimeout(300);
    const pre = await shelfKeys(page);
    const welcome = await page.evaluate(() => document.body.classList.contains("welcome-open"));
    await page.click("#welcome .welcome__cta [data-welcome-start]");
    await waitUntil(() => page.isVisible("#backToPath"), 8000);
    await page.click("#backToPath");
    await page.waitForTimeout(500);
    const post = await shelfKeys(page);
    const saved = await savedShelf(page);
    check("初回: 紹介頁（list.html?add=accounting）から来た人の下見の棚に経理・会計の背があり、スタート後も同じ（spelldash_shelf.books に accounting、中学英語 1年は棚にも保存にも無い）", welcome && pre.includes("b:accounting") && same(pre, post) && saved?.books.includes("accounting") && !saved?.books.includes("jhs-english1") && !post.some((k) => k.includes("jhs-english1")) && page.errors.length === 0, JSON.stringify({ welcome, pre, post, saved }));
    await page.close();
  }

  // ---- PR #152 レビュー B1: 目録の準備前に押した「171冊から選ぶ」は、届いた時点でまだ初回の画面のときだけ窓を開く。スタートした後には開かない（焦点はゲームの入力欄） ----
  {
    const page = await seededPage({ keepOnboarding: true, viewport: { width: 390, height: 844 } });
    let release = null;
    const gate = new Promise((r) => (release = r));
    await page.route("**/data/manifest.json", async (route) => { await gate; await route.continue(); }); // 語の読み込み（目録）を止めておく
    await page.goto(BASE + "/index.html", { waitUntil: "domcontentloaded" });
    await waitUntil(() => page.evaluate(() => document.body.classList.contains("welcome-open") && !!document.getElementById("welcomeFind")?.offsetParent), 6000);
    await page.click("#welcomeFind");
    await page.waitForTimeout(150);
    const wait = await page.evaluate(() => ({ open: !!document.getElementById("bookFinder")?.open, status: document.getElementById("bookshelfStatus")?.textContent ?? "" }));
    await page.click("#welcome .welcome__cta [data-welcome-start]");
    await page.waitForTimeout(150);
    release();
    const started = await waitUntil(() => page.evaluate(() => document.body.classList.contains("home--playing") && document.querySelectorAll("#shelfRun li[data-key]").length > 0), 8000);
    await page.waitForTimeout(800);
    const after = await page.evaluate(() => ({ open: document.getElementById("bookFinder").open, focus: document.activeElement?.id, welcome: document.body.classList.contains("welcome-open") }));
    await page.keyboard.press("Enter"); // 入力欄に打てる: Enter で答えが出る
    const typed = await waitUntil(async () => /^[a-z]+$/.test((await page.textContent("#word")).trim()), 3000);
    check("本棚（B1）: 目録の準備前に「171冊から選ぶ」を押すと「読み込み中」（窓はまだ無い）。そのままスタートしてから目録が届いても窓は開かず、焦点はゲームの入力欄で Enter が効く（答えが出る）",
      !wait.open && wait.status === "読み込み中" && started && !after.open && !after.welcome && after.focus === "input" && typed && page.errors.length === 0, JSON.stringify({ wait, started, after, typed, errors: page.errors.slice(0, 2) }));
    await page.close();
  }

  // ---- PR #152 レビュー B2・B4: 深いリンクで来て記録なしのまま本 2 冊と函 1 つを足した人が、素の / の初回の画面でスタートしても、足した物は棚に残る（下見にも出て、下見＝保存） ----
  {
    const page = await seededPage({ keepOnboarding: true, viewport: { width: 1200, height: 900 } });
    await openHome(page, "/index.html?category=jhs-english1");
    const deep = await page.evaluate(() => document.body.classList.contains("welcome-open"));
    for (const [q, key] of [["古文", "b:hs-kobun"], ["都道府県", "b:pref"], ["英検", "c:eiken"]]) {
      await page.click("#bookFinderOpen");
      await page.fill("#bookFinderQ", q);
      await page.waitForTimeout(100);
      await page.click(`#bookFinderList .finder__act[data-key="${key}"]`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
    }
    const saved0 = await savedShelf(page);
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await waitUntil(() => page.evaluate(() => document.body.classList.contains("welcome-open") && document.querySelectorAll("#shelfRun li[data-key]").length > 0), 6000);
    await page.waitForTimeout(300);
    const pre = await shelfKeys(page);
    await page.click("#welcome .welcome__cta [data-welcome-start]");
    await waitUntil(() => page.isVisible("#backToPath"), 8000);
    await page.click("#backToPath");
    await page.waitForTimeout(500);
    const post = await shelfKeys(page);
    const saved = await savedShelf(page);
    const want = ["c:jhs-redo", "slot:b:jhs-english1", "c:eiken", "b:pref", "b:hs-kobun"];
    check("本棚（B2・B4）: 深いリンク（?category=）で初回の画面を飛ばし、記録なしで古文単語・都道府県・函 英検を足す → 素の / の初回の画面の下見の棚に足した 3 点が出て、スタート後の棚も下見と同じ（spelldash_shelf は books [hs-kobun, pref]・courses [eiken, jhs-redo]・prov false）",
      !deep && same([...(saved0?.books ?? [])].sort(), ["hs-kobun", "pref"]) && same(saved0?.courses, ["eiken"]) && same(pre, want) && same(post, pre) &&
      same([...(saved?.books ?? [])].sort(), ["hs-kobun", "pref"]) && same([...(saved?.courses ?? [])].sort(), ["eiken", "jhs-redo"]) && saved?.prov === false && page.errors.length === 0, JSON.stringify({ deep, saved0, pre, post, saved, errors: page.errors.slice(0, 2) }));
    await page.close();
  }

  // ---- B2 の直しの守り: スタートが足すのは初回の画面を閉じる前の保存した棚（閉じた直後の描き直しが閉じる前の状態で移行して書いた棚ではない）。下見＝保存 ----
  // 既定のコースが敷かれた後に単語帳で経理を足した（机は中学英語 1年のまま）人が、積んだ本の中学歴史でスタート: 使っていない中学英語やり直しの函は下見にも棚にも出ない
  {
    const page = await seededPage({ keepOnboarding: true, viewport: { width: 390, height: 844 }, storage: { spelldash_course: "jhs-redo", spelldash_category: "jhs-english1", spelldash_packs: JSON.stringify(["jhs-english1", "accounting"]) } });
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await waitUntil(() => page.evaluate(() => document.body.classList.contains("welcome-open") && document.querySelectorAll("#shelfRun li[data-key]").length > 0), 6000);
    await page.click('#welcomeStack .flatbook[data-book="jhist1"]');
    await page.waitForTimeout(500);
    const pre = await shelfKeys(page);
    const book = await page.evaluate(() => document.querySelector("#welcome [data-welcome-start]").dataset.book);
    await page.evaluate(spyShelfWrites);
    await page.click("#welcome .welcome__cta [data-welcome-start]");
    await waitUntil(() => page.isVisible("#backToPath"), 8000);
    await page.click("#backToPath");
    await page.waitForTimeout(500);
    const post = await shelfKeys(page);
    const saved = await savedShelf(page);
    const writes = await page.evaluate(() => window.__shelfWrites);
    check("初回（B2 の守り）: 既定のコースのまま単語帳で経理を足した人が積んだ本の中学歴史でスタートすると、棚は下見と同じ（背 経理・会計・空き 中学歴史。中学英語やり直しの函は下見にも棚にも保存にも無い）",
      book === "jhist1" && same(pre, ["slot:b:jhist1", "b:accounting"]) && same(post, pre) && !!saved && !saved.courses.includes("jhs-redo") && saved.books.includes("accounting") && saved.prov === false && page.errors.length === 0, JSON.stringify({ book, pre, post, saved, errors: page.errors.slice(0, 2) }));
    check("初回（PR #154 レビュー 5）: スタートで spelldash_shelf を書くのは 1 回だけ（閉じた直後の描き直しが、閉じる前の状態で移行した棚＝中学英語やり直しの函を書かない）",
      writes.length === 1 && !writes[0].includes("jhs-redo") && writes[0] === JSON.stringify(saved), JSON.stringify({ writes }));
    await page.close();
  }

  // ---- PR #154 レビュー 5 の守り: 語の読み込み（目録）の前にスタートしても、本棚ができたとき（initBookshelf）に閉じる前の状態で移行した棚を書かない。保存はスタートの 1 回、棚は下見と同じ ----
  {
    const page = await seededPage({ keepOnboarding: true, viewport: { width: 390, height: 844 }, storage: { spelldash_course: "jhs-redo", spelldash_category: "jhs-english1", spelldash_packs: JSON.stringify(["jhs-english1", "accounting"]) } });
    let release = null;
    const gate = new Promise((r) => (release = r));
    await page.route("**/data/manifest.json", async (route) => { await gate; await route.continue(); }); // 語の読み込み（目録）を止めておく
    await page.goto(BASE + "/index.html", { waitUntil: "domcontentloaded" });
    await waitUntil(() => page.evaluate(() => document.body.classList.contains("welcome-open") && !!document.querySelector('#welcomeStack .flatbook[data-book="jhist1"]')), 6000);
    await page.click('#welcomeStack .flatbook[data-book="jhist1"]');
    await page.waitForTimeout(400);
    const book = await page.evaluate(() => document.querySelector("#welcome [data-welcome-start]").dataset.book);
    await page.evaluate(spyShelfWrites);
    await page.click("#welcome .welcome__cta [data-welcome-start]");
    await page.waitForTimeout(150);
    release();
    await waitUntil(() => page.isVisible("#backToPath"), 8000);
    await page.click("#backToPath");
    await page.waitForTimeout(500);
    const post = await shelfKeys(page);
    const saved = await savedShelf(page);
    const writes = await page.evaluate(() => window.__shelfWrites);
    check("初回（PR #154 レビュー 5 の守り）: 目録の準備前に積んだ本の中学歴史でスタートしても、spelldash_shelf を書くのはスタートの 1 回だけで中学英語やり直しの函は無い（背 経理・会計・空き 中学歴史）",
      book === "jhist1" && writes.length === 1 && !writes[0].includes("jhs-redo") && same(post, ["slot:b:jhist1", "b:accounting"]) && !!saved && saved.books.includes("accounting") && saved.prov === false && page.errors.length === 0, JSON.stringify({ book, writes, post, saved, errors: page.errors.slice(0, 2) }));
    await page.close();
  }

  // ---- PR #152 レビュー B5・B7: 窓の検索は打つたびに棚を読み直さない（開いたとき・足した後だけ）。足した後に打った検索の行も「棚にある」。行の「いまのコース・」「机の上・」 ----
  {
    const page = await newPage({ viewport: { width: 1200, height: 900 }, ...shelfSeed() });
    await openHome(page);
    await page.click("#bookFinderOpen");
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      window.__shelfReads = 0;
      const get = Storage.prototype.getItem;
      Storage.prototype.getItem = function (k) { if (k === "spelldash_shelf") window.__shelfReads++; return get.call(this, k); };
    });
    await page.locator("#bookFinderQ").pressSequentially("eiken", { delay: 30 });
    await page.waitForTimeout(100);
    const r1 = await page.evaluate(() => ({ reads: window.__shelfReads, rows: document.querySelectorAll("#bookFinderList .finder__row").length }));
    await page.fill("#bookFinderQ", "");
    await page.locator("#bookFinderQ").pressSequentially("中学英語", { delay: 30 });
    await page.waitForTimeout(100);
    const meta = await page.evaluate(() => ({ box: document.querySelector('#bookFinderList .finder__row[data-course="jhs-redo"] .finder__m')?.textContent, desk: document.querySelector('#bookFinderList .finder__row[data-book="jhs-english1"] .finder__m')?.textContent, other: document.querySelector('#bookFinderList .finder__row[data-book="jhs-english2"] .finder__m')?.textContent }));
    await page.click('#bookFinderList .finder__act[data-key="b:jhs-english3"]');
    await page.waitForTimeout(100);
    const readsAdded = await page.evaluate(() => window.__shelfReads);
    await page.fill("#bookFinderQ", "");
    await page.locator("#bookFinderQ").pressSequentially("3年", { delay: 30 });
    await page.waitForTimeout(100);
    const r2 = await page.evaluate(() => ({ reads: window.__shelfReads, act: document.querySelector('#bookFinderList .finder__act[data-key="b:jhs-english3"]')?.textContent.trim() }));
    await page.keyboard.press("Escape");
    check("本を足す（B5・B7）: 打つたびに棚（spelldash_shelf）を読み直さない（「eiken」の 5 回の入力で 0 回）。足した後に打った検索でも足した本は「棚にある」で、その入力でも読み直さない。行の頭は函 中学英語やり直しが「いまのコース・」、中学英語 1年が「机の上・」、ほかの巻には付かない",
      r1.reads === 0 && r1.rows > 0 && meta.box?.startsWith("いまのコース・") && meta.desk?.startsWith("机の上・") && !!meta.other && !/^(いまのコース|机の上)・/.test(meta.other) && r2.act === "棚にある" && r2.reads === readsAdded && page.errors.length === 0, JSON.stringify({ r1, meta, readsAdded, r2, errors: page.errors.slice(0, 2) }));
    await page.close();
  }

  // ---- PR #152 レビュー B6: 入力が前回と同じなら描き直さない（同期の後の renderHome → renderBookshelf の 2 回目も）。プレイ中（畳まれている間）は幅・高さを読まず、机に戻ったときに描く ----
  {
    const page = await newPage({ viewport: { width: 1200, height: 900 }, ...shelfSeed({ spelldash_shelf: shelfJson({ books: ["jhist1"], courses: ["jhs-redo"] }) }) });
    await openHome(page);
    // 測る道具: #shelfRun の DOM の変化と、レイアウトを読む呼び出しの回数（updateBookshelf は同期で走るので、呼ぶ前後の差がその分）
    await page.evaluate(() => {
      window.__layoutReads = 0;
      const wrap = (obj, name) => {
        const d = Object.getOwnPropertyDescriptor(obj, name);
        if (d.get) Object.defineProperty(obj, name, { ...d, get() { window.__layoutReads++; return d.get.call(this); } });
        else { const f = d.value; obj[name] = function (...a) { window.__layoutReads++; return f.apply(this, a); }; }
      };
      wrap(window, "getComputedStyle");
      for (const n of ["getBoundingClientRect", "getClientRects"]) wrap(Element.prototype, n);
      for (const n of ["clientWidth", "clientHeight"]) wrap(Element.prototype, n);
      for (const n of ["offsetHeight", "offsetWidth", "offsetTop", "offsetLeft"]) wrap(HTMLElement.prototype, n);
      window.__shelfMut = 0;
      new MutationObserver((list) => (window.__shelfMut += list.length)).observe(document.getElementById("shelfRun"), { childList: true, subtree: true, attributes: true, characterData: true });
      window.__statsReads = 0; // 語の記録（spelldash_word_stats）を読んだ回数（js/storage.js getWordStats はタスクの初めに保存の文字列を読む）
      const get = Storage.prototype.getItem;
      Storage.prototype.getItem = function (k) { if (k === "spelldash_word_stats") window.__statsReads++; return get.call(this, k); };
    });
    // shelf を渡したら、呼ぶ直前に spelldash_shelf をその文字列にする（別のタブで棚が替わった）
    const measure = (shelf = null) => page.evaluate(async (raw) => {
      const m = await import("/js/bookshelf.js");
      await new Promise((r) => setTimeout(r, 150));
      window.__shelfMut = 0;
      window.__layoutReads = 0;
      window.__statsReads = 0;
      if (raw) localStorage.setItem("spelldash_shelf", raw);
      m.updateBookshelf();
      m.updateBookshelf();
      m.renderBookshelf();
      const reads = window.__layoutReads;
      const statsReads = window.__statsReads;
      await new Promise((r) => setTimeout(r, 50));
      return { reads, statsReads, mut: window.__shelfMut, keys: [...document.querySelectorAll("#shelfRun li[data-key]")].map((li) => (li.dataset.state === "slot" ? "slot:" : "") + li.dataset.key) };
    }, shelf);
    const sameIn = await measure();
    await page.click("#pathStart");
    await waitUntil(() => page.evaluate(() => document.body.classList.contains("home--playing")), 4000);
    await page.waitForTimeout(300);
    // プレイ中に別のタブで都道府県を足した（保存した棚の文字列が替わる）
    const folded = await measure(shelfJson({ books: ["jhist1", "pref"], courses: ["jhs-redo"] }));
    await page.click("#backToPath");
    await page.waitForTimeout(500);
    const back = await shelfKeys(page);
    const v = await rowsOf(page);
    check("本棚（B6）: 入力が同じなら updateBookshelf・renderBookshelf を続けて呼んでも #shelfRun は変わらず、幅・高さも読まず、語の記録も読まない（PR #154 レビュー 6）。プレイ中に棚が替わっても描かず（読む回数 0・DOM そのまま）、机に戻ると都道府県が並ぶ（段は貪欲に詰めた形）",
      sameIn.reads === 0 && sameIn.statsReads === 0 && sameIn.mut === 0 && folded.reads === 0 && folded.mut === 0 && !folded.keys.includes("b:pref") && same(back, ["c:jhs-redo", "slot:b:jhs-english1", "b:pref", "b:jhist1"]) && layoutBad(v, 4).length === 0 && page.errors.length === 0, JSON.stringify({ sameIn, folded, back, bad: layoutBad(v, 4), errors: page.errors.slice(0, 2) }));
    await page.close();
  }

  // ---- PR #154 レビュー 1: 書けなかった棚（localStorage が満杯で setItem が投げた）は、容量が空いたら次の描き直しで書き直す（入力が前回と同じでも）。開き直しても足した本が残る ----
  {
    const page = await seededPage({ viewport: { width: 1200, height: 900 }, ...shelfSeed({ spelldash_shelf: shelfJson({ books: ["jhist1"], courses: ["jhs-redo"] }) }) }); // 開き直しで種を入れ直さない
    await openHome(page);
    await page.evaluate(() => {
      window.__shelfFull = true; // 満杯の間は spelldash_shelf の setItem が投げる（足した直後の描き直しの書き直しも投げる）
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (k === "spelldash_shelf" && window.__shelfFull) throw new DOMException("full", "QuotaExceededError");
        return set.call(this, k, v);
      };
    });
    await page.click("#bookFinderOpen");
    await page.fill("#bookFinderQ", "都道府県");
    await page.waitForTimeout(100);
    await page.click('#bookFinderList .finder__act[data-key="b:pref"]');
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    const full = await page.evaluate(() => ({ keys: [...document.querySelectorAll("#shelfRun li[data-key]")].map((li) => li.dataset.key), saved: JSON.parse(localStorage.getItem("spelldash_shelf") || "null") }));
    // 容量が空いた → 次の描き直し（renderHome が呼ぶ updateBookshelf。入力は前回と同じ）
    const freed = await page.evaluate(async () => {
      window.__shelfFull = false;
      const m = await import("/js/bookshelf.js");
      m.updateBookshelf();
      return JSON.parse(localStorage.getItem("spelldash_shelf") || "null");
    });
    await page.reload({ waitUntil: "networkidle" });
    await waitUntil(() => page.evaluate(() => !!document.querySelector("#shelfRun .shelf")), 6000);
    await page.waitForTimeout(300);
    const reopened = await shelfKeys(page);
    check("本棚（PR #154 レビュー 1）: 満杯で書けなかった棚（足した都道府県）はメモリで描き、容量が空いたら入力が同じ次の描き直しで spelldash_shelf に書く。開き直しても都道府県が棚に残る",
      full.keys.includes("b:pref") && !full.saved?.books.includes("pref") && !!freed?.books.includes("pref") && freed?.books.includes("jhist1") && reopened.includes("b:pref") && page.errors.length === 0, JSON.stringify({ full, freed, reopened, errors: page.errors.slice(0, 2) }));
    await page.close();
  }
}

// ===== 8.7 書斎の皮（ホーム以外のページ）: 帯のヘッダー・胡桃の幅木・羊皮紙の札・横スクロール無し・文字と帯のコントラスト（css/brand.css・pages.css・battle.css。Batch 56b） =====
// 10 ページ × 390／1200 × light／dark。計測はページ内の getComputedStyle を 1 回でまとめて読み、check は項目ごと。ホームは room.css の透明な帯のまま
console.log("pages (書斎の皮):");
{
  // トークンは span に var() を当てて rgb に解く。比は WCAG の相対輝度（sRGB → 線形、(L1+.05)/(L2+.05)）
  const skin = () => {
    const rgb = (s) => (s.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
    const token = (name) => { const el = document.createElement("span"); el.style.color = `var(${name})`; document.body.appendChild(el); const c = getComputedStyle(el).color; el.remove(); return c; };
    const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const contrast = (a, b) => { const [hi, lo] = [lum(rgb(a)), lum(rgb(b))].sort((x, y) => y - x); return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100; };
    const vault = token("--vault"), paper = token("--paper"), wood3 = token("--wood-3"), floor = token("--floor");
    const header = document.querySelector(".site-header"), hs = getComputedStyle(header);
    const nav = getComputedStyle(document.querySelector(".site-nav__link")).color;
    const current = document.querySelector('.site-nav__link[aria-current="page"]');
    const currentColor = current ? getComputedStyle(current).color : null;
    const fs = getComputedStyle(document.querySelector(".site-footer"));
    const footerLink = getComputedStyle(document.querySelector(".site-footer__nav a")).color;
    const cards = [...document.querySelectorAll(".result-card")].map((el) => { const s = getComputedStyle(el); return { radius: s.borderRadius, shadow: s.boxShadow !== "none" }; });
    return {
      theme: document.documentElement.dataset.theme,
      vault, paper, vaultLum: Math.round(lum(rgb(vault)) * 1000) / 1000,
      header: { gradient: hs.backgroundImage.includes("linear-gradient"), onVault: hs.backgroundImage.includes(vault), bgColor: hs.backgroundColor, bgImage: hs.backgroundImage === "none" ? "none" : "image", border: hs.borderBottomWidth, position: hs.position, height: header.offsetHeight },
      nav: { color: nav, ratio: contrast(nav, vault), current: currentColor, currentRatio: currentColor ? contrast(currentColor, vault) : null },
      footer: { wood: fs.backgroundImage.includes("tile-wood.webp"), dark: fs.backgroundImage.includes(wood3) || fs.backgroundImage.includes(floor), link: footerLink, floor, ratio: contrast(footerLink, floor), hasNews: (document.querySelector(".site-footer__nav")?.textContent ?? "").includes("お知らせ") },
      scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth,
      cards
    };
  };
  const SKIN_PAGES = ["/list.html", "/stats.html", "/profile.html", "/pro.html", "/battle.html", "/news.html", "/privacy.html", "/terms.html", "/tokushoho.html", "/packs/accounting.html", "/typing.html", "/typing-game.html"];
  const SKIN_VIEWS = [[390, true], [1200, false]];
  const skinPage = (w, mobile, theme) => newPage({ mobile, viewport: { width: w, height: mobile ? 844 : 900 }, storage: { spelldash_theme: theme, spelldash_placement: "done" } });
  const themed = (page, theme) => waitUntil(() => page.evaluate((t) => document.documentElement.dataset.theme === t, theme));

  for (const [w, mobile] of SKIN_VIEWS) {
    for (const theme of ["light", "dark"]) {
      const page = await skinPage(w, mobile, theme);
      const consoleErrors = [];
      page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
      for (const p of SKIN_PAGES) {
        const label = `${p.replace(/^\/|\.html$/g, "")}（${w}・${theme}）`;
        const errFrom = page.errors.length, consoleFrom = consoleErrors.length;
        await page.goto(BASE + p, { waitUntil: "networkidle" });
        await themed(page, theme);
        const s = await page.evaluate(skin);
        // 帯: 紺のグラデーション（相対輝度 < .2）で、紙の色ではない。sticky・下端 1px・390 では高さ < 70
        check(`${label}: ヘッダーは帯（紙でない）`, s.theme === theme && s.header.gradient && s.header.onVault && s.vaultLum < 0.2 && s.header.bgColor !== s.paper && s.header.position === "sticky" && s.header.border === "1px" && (w !== 390 || s.header.height < 70), JSON.stringify({ theme: s.theme, vault: s.vault, vaultLum: s.vaultLum, paper: s.paper, ...s.header }));
        check(`${label}: ナビの文字と帯 ≥ 4.5（${s.nav.ratio.toFixed(1)}${s.nav.currentRatio ? `／現在地 ${s.nav.currentRatio.toFixed(1)}` : ""}）`, s.nav.ratio >= 4.5 && (s.nav.currentRatio === null || s.nav.currentRatio >= 4.5), JSON.stringify({ vault: s.vault, ...s.nav }));
        check(`${label}: フッターは幅木`, s.footer.wood && s.footer.dark && s.footer.hasNews, JSON.stringify(s.footer));
        check(`${label}: フッターの文字と床 ≥ 4.5（${s.footer.ratio.toFixed(1)}）`, s.footer.ratio >= 4.5, JSON.stringify({ link: s.footer.link, floor: s.footer.floor }));
        check(`${label}: 横スクロールしない`, s.scrollWidth <= s.innerWidth, `${s.scrollWidth}/${s.innerWidth}`);
        if (p === "/stats.html" || p === "/battle.html") check(`${label}: 札は羊皮紙（角 3px・影）`, s.cards.length > 0 && s.cards.every((c) => c.radius === "3px" && c.shadow), JSON.stringify(s.cards.slice(0, 3)));
        check(`${label}: console エラー0`, page.errors.length === errFrom && consoleErrors.length === consoleFrom, [...page.errors.slice(errFrom), ...consoleErrors.slice(consoleFrom)][0] ?? "");
      }
      await page.close();
    }
  }

  // ホーム: 帯は場面の上に透明で載ったまま（room.css）。幅木も既存のまま
  for (const [w, mobile] of SKIN_VIEWS) {
    const page = await skinPage(w, mobile, "light");
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await themed(page, "light");
    const s = await page.evaluate(skin);
    check(`書斎（${w}）: ヘッダーは透明のまま`, s.header.bgColor === "rgba(0, 0, 0, 0)" && s.header.bgImage === "none" && s.header.position === "absolute", JSON.stringify(s.header));
    check(`書斎（${w}）: フッターは幅木のまま`, s.footer.wood && s.footer.ratio >= 4.5, JSON.stringify(s.footer));
    await page.close();
  }
}

// ===== 8.8 書斎の仕上げ（夜の味付け・机の本・本棚の索引・CLS）: 夜だけ味付け・昼は 56b の計算値・reduced motion 0・索引の帯は 1 行・CLS・読み込み中の最小高さ・場面の拡大と位置の規律・CSS の増分・56b の残り・夜の層はスタートに掛からない（css/room.css・bookshelf.css・pro.css・pages.css。Batch 56c） =====
console.log("study (finish):");
{
  // 戻ってきた人（連続 3 日 = #todayStrip あり。Pro = 紙／藍が効く）。scratchpad/b56c/shoot-home.mjs の returning() と同じ種
  const finishSeed = (theme) => ({ storage: {
    spelldash_theme: theme, spelldash_placement: "done", spelldash_course: "jhs-redo", spelldash_category: "jhs-english1",
    spelldash_word_stats: JSON.stringify({ "english-go": { playCount: 2, correct: 2, lastRecallSuccessAt: Date.now() - 86400000 } }),
    spelldash_streak: JSON.stringify({ last: ymd(new Date()), current: 3, best: 3, shields: 0 }),
    spelldash_plan: JSON.stringify({ status: "active", interval: "month", periodEnd: new Date(Date.now() + 30 * 86400000).toISOString(), checkedAt: new Date().toISOString() }),
    spelldash_test_session: "pro-token", spelldash_test_plan: JSON.stringify({ status: "active", interval: "month", current_period_end: new Date(Date.now() + 30 * 86400000).toISOString() }),
    spelldash_shelf: JSON.stringify({ v: 1, books: ["jhist1"], courses: ["jhs-redo"], seen: [], prov: false }) // 見出しの欄に「整理」と「本を足す」が並ぶ棚（Batch 61）
  } });
  const errs = [];
  const openRoom = async (init, theme) => {
    const page = await newPage(init);
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await waitUntil(() => page.evaluate((t) => document.documentElement.dataset.theme === t, theme));
    await page.waitForTimeout(600);
    return page;
  };
  const done = async (page) => { errs.push(...page.errors); await page.close(); };
  // 1 回の evaluate で読む計算値: 机の本の影・本棚の揺らぎ（.cabinet::after）・.page-room の夜の変数・動いている物・スタートの朱と墨・棚の見出し・場面の拡大・見出しの欄
  const finish = () => {
    const cs = (sel, pseudo) => getComputedStyle(document.querySelector(sel), pseudo);
    const room = cs(".page-room"), tome = cs(".tome"), cab = cs(".cabinet", "::after"), start = cs("#pathStart"), plateEl = document.getElementById("bookshelfTitle"), plate = getComputedStyle(plateEl);
    const ink = document.createElement("span"); ink.style.color = "var(--on-vault)"; plateEl.appendChild(ink); const onVault = getComputedStyle(ink).color; ink.remove();
    const rail = document.querySelector(".cabinet__rail").getBoundingClientRect(), tr = plateEl.getBoundingClientRect();
    const acts = [...document.querySelectorAll(".rail__acts .find:not([hidden])")].map((x) => x.getBoundingClientRect());
    const a = document.querySelector("#hasumiHome .hasumi__bubble")?.getBoundingClientRect(), b = document.getElementById("pathStart").getBoundingClientRect();
    return {
      theme: document.documentElement.dataset.theme,
      tome: tome.boxShadow, cabinet: cab.backgroundImage, flicker: cab.animationName,
      far: room.getPropertyValue("--far-page"), cast: room.getPropertyValue("--cast-l"), band: room.getPropertyValue("--desk-band"),
      anims: document.getAnimations().map((x) => { const t = x.effect.target; return ([...t.classList].pop() || t.id) + (x.effect.pseudoElement || ""); }).sort(),
      start: { bg: start.backgroundImage, color: start.color, bottom: Math.round(b.bottom), n: document.querySelectorAll("#pathStart").length },
      plate: { color: plate.color, onVault, filter: plate.filter, blend: plate.mixBlendMode, inSink: document.querySelectorAll(".shelf__in #bookshelfTitle").length },
      scene: { transform: cs(".room__scene--phone").transform, stage: Math.round(document.querySelector(".room__stage").getBoundingClientRect().height), slipOverlap: a ? a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right : null },
      rail: { acts: acts.length, oneLine: acts.every((x) => Math.abs((x.top + x.bottom) / 2 - (tr.top + tr.bottom) / 2) <= 8), inside: tr.left >= rail.left && acts.every((x) => x.left >= tr.right && x.right <= rail.right + 0.5), height: Math.round(rail.height) },
      scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth
    };
  };

  // 1200×900 × 4 テーマ。room.css・bookshelf.css の応答サイズも拾う（56b: 70,594・46,477 B）
  const at1200 = {}, cssBytes = {};
  for (const theme of ["light", "dark", "indigo", "paper"]) {
    const page = await newPage({ viewport: { width: 1200, height: 900 }, ...finishSeed(theme) });
    page.on("response", async (r) => { const m = r.url().match(/\/css\/(room|bookshelf)\.css$/); if (m) { try { cssBytes[m[1]] = (await r.body()).length; } catch {} } });
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await waitUntil(() => page.evaluate((t) => document.documentElement.dataset.theme === t, theme));
    await page.waitForTimeout(600);
    at1200[theme] = await page.evaluate(finish);
    if (theme === "dark") {
      // 盤面は沈めない: プレイ中の #gameCard は --far-page を 390 の夜の値（.1）に戻す
      await page.click("#pathStart");
      await waitUntil(() => page.evaluate(() => document.body.classList.contains("home--playing")));
      at1200.playingFar = await page.evaluate(() => getComputedStyle(document.getElementById("gameCard")).getPropertyValue("--far-page"));
    }
    await done(page);
  }
  const L = at1200.light, D = at1200.dark, I = at1200.indigo, P = at1200.paper;
  check("書斎の仕上げ（1200）: 夜だけ味付け（机の本の影と本棚の揺らぎは dark ≠ light。dark は room-flicker・light は none。indigo は dark と同じ）", D.tome !== L.tome && D.cabinet !== L.cabinet && D.flicker === "room-flicker" && L.flicker === "none" && L.cabinet === "none" && I.tome === D.tome && I.cabinet === D.cabinet && I.flicker === D.flicker, JSON.stringify({ light: [L.tome, L.cabinet, L.flicker], dark: [D.tome, D.cabinet, D.flicker], indigo: [I.tome, I.cabinet, I.flicker] }));
  // 昼の計算値は 56b のまま（--desk-band だけ .2 → .3 が 56c の唯一の昼の変更）。夜の --far-page は PC で .15、盤面は .1
  const DAY = { tome: "rgba(0, 0, 0, 0.55) 0px 1px 0px 0px, rgba(0, 0, 0, 0.6) 0px 0px 0px 0.5px, rgba(0, 0, 0, 0.45) 1px 2px 2px 0px, rgba(50, 34, 20, 0.55) 6px 12px 16px -6px, rgba(50, 34, 20, 0.5) 14px 26px 34px -16px", far: "rgba(70, 50, 25, 0)", cast: "rgba(255, 190, 110, 0)", band: "rgba(255, 240, 216, 0.3)" };
  const isDay = (v) => v.tome === DAY.tome && v.far === DAY.far && v.cast === DAY.cast && v.band === DAY.band;
  check("書斎の仕上げ（1200）: 昼の計算値は 56b のまま（.tome の影・--far-page 0・--cast-l 0・--desk-band .3。paper も同じ）、夜の --far-page は .15 で盤面は .1 に戻る", isDay(L) && isDay(P) && D.far === "rgba(60, 34, 10, 0.15)" && at1200.playingFar === "rgba(70, 40, 12, 0.1)", JSON.stringify({ light: [L.tome, L.far, L.cast, L.band], paper: [P.tome, P.far, P.cast, P.band], darkFar: D.far, playingFar: at1200.playingFar }));

  // reduced motion: 1200 dark・390 light で動く物は 0（390 dark は 8.6）。通常の 1200 dark は 3 = 壁の溜まり・机の光・本棚の揺らぎ
  const stillCount = async (init, theme) => {
    const page = await newPage(init);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await waitUntil(() => page.evaluate((t) => document.documentElement.dataset.theme === t, theme));
    await page.waitForTimeout(500);
    const n = await page.evaluate(() => document.getAnimations().length);
    await done(page);
    return n;
  };
  const still = { "1200 dark": await stillCount({ viewport: { width: 1200, height: 900 }, ...finishSeed("dark") }, "dark"), "390 light": await stillCount({ mobile: true, viewport: { width: 390, height: 844 }, ...finishSeed("light") }, "light") };
  check("書斎の仕上げ: reduced motion では動く物が 0（1200 dark・390 light）、通常の 1200 dark は 3（壁の溜まり・机の光・本棚の揺らぎ）、light は 0", still["1200 dark"] === 0 && still["390 light"] === 0 && D.anims.join(",") === "cabinet::after,desk__candle--l,room__pool--candle" && L.anims.length === 0, JSON.stringify({ still, dark: D.anims, light: L.anims }));

  // 390×844 light／dark・320×568 light: 見出しの欄・場面の拡大・スタートの位置・夜の層
  const phone = {};
  for (const [w, h, theme] of [[390, 844, "light"], [390, 844, "dark"], [320, 568, "light"]]) {
    const page = await openRoom({ mobile: true, viewport: { width: w, height: h }, ...finishSeed(theme) }, theme);
    const v = await page.evaluate(finish);
    phone[`${w}-${theme}`] = v;
    await done(page);
  }
  // 1100（右の列 340px。詰めた見出しの欄）
  const at1100 = await (async () => { const page = await openRoom({ viewport: { width: 1100, height: 900 }, ...finishSeed("light") }, "light"); const v = await page.evaluate(finish); await done(page); return v; })();
  const railOk = (v) => v.rail.acts === 2 && v.rail.oneLine && v.rail.inside && v.scrollW <= v.innerW;
  check("書斎の仕上げ（390・320・1100・1200）: 見出しの欄（わたしの本棚・整理・本を足す）は 1 行で框に収まり、頁は横スクロールしない", railOk(phone["390-light"]) && railOk(phone["390-dark"]) && railOk(phone["320-light"]) && railOk(at1100) && railOk(L), JSON.stringify({ 390: phone["390-light"].rail, 320: phone["320-light"].rail, 1100: at1100.rail, 1200: L.rail }));

  // 場面は 1.08 倍（390。帯の高さは変わらないのでスタートの位置は動かない）。初回のスタート（390）と 1200 の位置も固定
  const first = await (async () => {
    const page = await newPage({ keepOnboarding: true, mobile: true, viewport: { width: 390, height: 844 } });
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    const r = await page.evaluate(() => { const b = document.querySelector("#welcome .welcome__cta [data-welcome-start]").getBoundingClientRect(); return { bottom: Math.round(b.bottom), width: Math.round(b.width), transform: getComputedStyle(document.querySelector(".room__scene--phone")).transform }; });
    await done(page);
    return r;
  })();
  const scaled = (v) => /^matrix\(1\.08, 0, 0, 1\.08, /.test(v.transform) && v.stage === 262 && v.slipOverlap === false;
  check("書斎の仕上げ: 場面は 390 で 1.08 倍（帯の高さ 262 のまま・紙片はスタートに重ならない）、スタートの下端は 390 ≤ 651・初回 ≤ 567・1200 は 617〜621、#pathStart は 1 個", scaled(phone["390-light"].scene) && scaled(phone["390-dark"].scene) && phone["390-light"].start.bottom <= 651 && phone["390-dark"].start.bottom <= 651 && first.bottom <= 567 && first.width >= 300 && L.start.bottom >= 617 && L.start.bottom <= 621 && D.start.bottom >= 617 && D.start.bottom <= 621 && [L, D, phone["390-light"], phone["390-dark"]].every((v) => v.start.n === 1), JSON.stringify({ scene: phone["390-light"].scene, start390: phone["390-light"].start.bottom, first, start1200: L.start.bottom }));

  // CLS: 全応答を 80ms 遅らせ（scratchpad/perf-delay.mjs の作法）、連続 3 日の帯ありで読む。読み込み中（DOMContentLoaded）の最小高さも同じ頁で拾う
  const slow = async (w, h, mobile) => {
    const page = await newPage({ mobile, viewport: { width: w, height: h }, ...finishSeed("light") });
    await page.addInitScript(() => {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls = (window.__cls || 0) + e.value; }).observe({ type: "layout-shift", buffered: true });
      document.addEventListener("DOMContentLoaded", () => {
        const min = (s) => getComputedStyle(document.querySelector(s)).minHeight;
        window.__loading = { headEmpty: document.getElementById("pathHead").childNodes.length === 0, head: min("#pathHead"), now: min("#pathNow"), list: min("#pathList") };
      });
    });
    await page.route("**/*", (r) => setTimeout(() => r.continue(), 80));
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const r = await page.evaluate(() => {
      const h = (s) => Math.round(document.querySelector(s).getBoundingClientRect().height * 10) / 10;
      return { cls: Math.round((window.__cls || 0) * 10000) / 10000, loading: window.__loading, final: { head: h("#pathHead"), l: h("#pathCard .tome__page--l"), r: h("#pathCard .tome__page--r"), toc: h("#pathCard .tome__page--toc") }, strip: (document.getElementById("todayStrip")?.textContent ?? "").includes("3日連続") };
    });
    await done(page);
    return r;
  };
  const cls390 = await slow(390, 844, true), cls320 = await slow(320, 568, true), cls1200 = await slow(1200, 900, false);
  check("書斎の仕上げ: CLS（全応答 80ms 遅延・連続 3 日の帯あり）は 390 < 0.05・320 < 0.05・1200 < 0.02", cls390.strip && cls390.cls < 0.05 && cls320.cls < 0.05 && cls1200.cls < 0.02, JSON.stringify({ 390: cls390.cls, 320: cls320.cls, 1200: cls1200.cls, strip: cls390.strip }));
  const near = (a, b) => Math.abs(a - b) <= 2;
  const lo = cls390.loading, fi = cls390.final;
  check("書斎の仕上げ（390）: 読み込み中の最小高さ（#pathHead 182・#pathNow 189・#pathList 297。頁の padding は段ごとに足す）で、頁は語の入った最終の高さ（218・225・333）と差 ≤ 2px", lo.headEmpty && lo.head === "182px" && lo.now === "189px" && lo.list === "297px" && near(fi.head, 182) && near(fi.l, 218) && near(fi.r, 225) && near(fi.toc, 333), JSON.stringify({ loading: lo, final: fi }));

  // CSS の増分の見張り: room.css・bookshelf.css の応答は 56b から +8KB 以内
  const CSS_56B = { room: 70594, bookshelf: 46477 };
  check("書斎の仕上げ: css/room.css・bookshelf.css の応答は 56b（70,594・46,477 B）から +8KB 以内", cssBytes.room > 0 && cssBytes.bookshelf > 0 && cssBytes.room <= CSS_56B.room + 8 * 1024 && cssBytes.bookshelf <= CSS_56B.bookshelf + 8 * 1024, JSON.stringify(cssBytes));

  // 細い端末（320・360・390）: 全部足した棚（124 点）で整理の札は背の幅の中・前の段の棚板の下に潜らない。窓の行は題と meta の 2 行＋右にボタン（Batch 61。56d の段の見出し行は名札ごと無くなった）
  const catsF = JSON.parse(fs.readFileSync(path.join(ROOT, "data/manifest.json"), "utf8")).subjects.find((x) => x.id === "english").categories;
  const heavyShelf = JSON.stringify({ v: 1, books: [...catsF.filter((c) => shelfIdOf(c.id, c) !== "freq").map((c) => c.id), "my"], courses: ["jhs-redo", "biz", "conversation", "hs", "eiken", "toeic", "ngsl", "tsl", "bsl", "nawl"], seen: [], prov: false });
  const slipsFit = async (w) => {
    const page = await newPage({ mobile: true, viewport: { width: w, height: 844 }, storage: { spelldash_placement: "done", spelldash_onboarded: "1", spelldash_category: "all", spelldash_word_stats: JSON.stringify({ "english-go": { playCount: 1 } }), spelldash_shelf: heavyShelf } });
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await waitUntil(() => page.evaluate(() => document.querySelectorAll("#shelfRun li[data-key]").length >= 100), 6000);
    await page.click("#shelfTidy");
    await page.waitForTimeout(300);
    const slips = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#shelfRun > .shelf")];
      const bad = [];
      rows.forEach((row, ri) => {
        const prevBoard = ri > 0 ? rows[ri - 1].querySelector(".shelf__board").getBoundingClientRect().bottom : -Infinity;
        for (const li of row.querySelectorAll("li[data-key]")) {
          const slip = li.querySelector(".slip");
          if (!slip) continue;
          const item = li.querySelector(".spine, .box").getBoundingClientRect(), paper = slip.querySelector(".slip__paper").getBoundingClientRect(), hit = slip.getBoundingClientRect(), lr = li.getBoundingClientRect();
          if (paper.left < item.left - 8 || paper.right > item.right + 8) bad.push(`wide:${li.dataset.key}`);
          if (hit.left < lr.left - 0.5 || hit.right > lr.right + 0.5) bad.push(`hit:${li.dataset.key}`);
          if (paper.top < prevBoard - 0.5) bad.push(`under-board:${li.dataset.key}:${Math.round(prevBoard - paper.top)}`);
        }
      });
      return { n: document.querySelectorAll("#shelfRun .slip").length, bad: bad.slice(0, 6) };
    });
    await page.click("#shelfTidy");
    await page.click("#bookFinderOpen");
    await page.waitForTimeout(200);
    await page.evaluate(() => document.querySelectorAll("#bookFinderBrowse details").forEach((x) => { x.removeAttribute("name"); x.open = true; })); // 見出しは 1 つずつ開く（name）。全部開くために外す
    await page.waitForTimeout(200);
    const rows = await page.evaluate(() => [...document.querySelectorAll("#bookFinderBrowse .finder__row")].map((r) => {
      const rr = r.getBoundingClientRect(), a = r.querySelector(".finder__act").getBoundingClientRect(), t = r.querySelector(".finder__t").getBoundingClientRect(), m = r.querySelector(".finder__m").getBoundingClientRect(), x = r.querySelector(".finder__txt").getBoundingClientRect();
      return a.right > rr.right + 0.5 || a.left < x.right - 0.5 || m.top < t.bottom - 1 || a.top < rr.top - 0.5 || a.bottom > rr.bottom + 0.5 ? r.dataset.book || r.dataset.course : null;
    }).filter(Boolean));
    await done(page);
    return { slips, rows: rows.slice(0, 6) };
  };
  const fit320 = await slipsFit(320), fit360 = await slipsFit(360), fit390 = await slipsFit(390);
  check("細い端末（320・360・390）: 全部足した棚で整理の札は背の幅の中（札の左右が背の左右から 8px 以上出ない・押せる範囲は背の幅）、札の上端は前の段の棚板より下。窓の行のボタンは行の中に収まり、題と meta は 2 行の組み", [fit320, fit360, fit390].every((f) => f.slips.n >= 120 && f.slips.bad.length === 0 && f.rows.length === 0), JSON.stringify({ 320: fit320, 360: fit360, 390: fit390 }));

  // 56b の残り: Pro 390 の表頭の罫は 1 本（th の罫を落とし thead tr の 1px だけ）、単語帳 390 の分野ナビ末尾のフェードは最後の題箋に乗らない
  const proRule = async (w, mobile) => {
    const page = await newPage({ mobile, viewport: { width: w, height: mobile ? 844 : 900 }, storage: { spelldash_placement: "done" } });
    await page.goto(BASE + "/pro.html", { waitUntil: "networkidle" });
    const r = await page.evaluate(() => ({ th: getComputedStyle(document.querySelector(".pro-compare thead th:last-child")).borderBottomWidth, tr: getComputedStyle(document.querySelector(".pro-compare thead tr")).borderBottomWidth }));
    await done(page);
    return r;
  };
  const pro390 = await proRule(390, true), pro1200 = await proRule(1200, false);
  const genre = await (async () => {
    const page = await newPage({ mobile: true, viewport: { width: 390, height: 844 }, storage: { spelldash_placement: "done" } });
    await page.goto(BASE + "/list.html", { waitUntil: "networkidle" });
    await waitUntil(() => page.evaluate(() => document.querySelectorAll(".genre-nav a").length > 3));
    const r = await page.evaluate(() => {
      const nav = document.querySelector(".genre-nav"), marginLeft = getComputedStyle(nav, "::after").marginLeft;
      nav.scrollLeft = nav.scrollWidth;
      const links = nav.querySelectorAll("a"), last = links[links.length - 1].getBoundingClientRect();
      return { n: links.length, marginLeft, left: nav.scrollLeft, gap: Math.round(nav.getBoundingClientRect().right - last.right), scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth };
    });
    await done(page);
    return r;
  })();
  check("56b の残り: Pro（390）の表頭の罫は 1 本（th 0・thead tr 1px、1200 は th 1px のまま）、単語帳（390）の分野ナビは末尾まで送ると最後の題箋の右に 28px 以上の空き（::after の margin-left 0）、横スクロール無し", pro390.th === "0px" && pro390.tr === "1px" && pro1200.th === "1px" && genre.marginLeft === "0px" && genre.left > 0 && genre.gap >= 28 && genre.scrollW <= genre.innerW, JSON.stringify({ pro390, pro1200, genre }));

  // 夜の層はスタートと棚の見出しに掛からない: #pathStart の朱（--seal-1 系）と墨（--seal-ink）は dark でも light と同じ文字列。見出し（わたしの本棚）は --on-vault のまま、沈みの層（.shelf__in::after）の外で、filter も blend も無い
  const outside = (night, day) => night.start.bg === day.start.bg && night.start.color === day.start.color && night.plate.color === night.plate.onVault && day.plate.color === day.plate.onVault && night.plate.filter === "none" && night.plate.blend === "normal" && night.plate.inSink === 0;
  check("書斎の仕上げ（夜）: 夜の層はスタートと棚の見出しに掛からない（#pathStart の朱と墨は昼と同じ・見出しは --on-vault のまま沈みの層の外。390・1200）", outside(D, L) && outside(phone["390-dark"], phone["390-light"]) && D.start.bg.includes("rgb(199, 62, 36)"), JSON.stringify({ 1200: { start: D.start, plate: D.plate }, 390: { start: phone["390-dark"].start, plate: phone["390-dark"].plate }, light: L.start }));
  check("書斎の仕上げでエラー0", errs.length === 0, errs[0] ?? "");
}

// ===== 8.9 Batch 57: 途中の部品の皮（結果パネル・コーチ・OSK・ログイン・モーダル・コース選択・緑→金）: 札 3px・明朝 500・数は SD Num・緑は金・盤面の寸法は 56d のまま・reduced motion 0・予算（css/card.css・keyboard.css・brand.css・pages.css・battle.css・pro.css。Batch 57） =====
// 状態の作り方は scratchpad/b57/shoot-flows.mjs（?set=3・jhs-english1 の en を打つ・spelldash_test_session・spelldash_test_plan・statsSeed）。計測は 8.7 の skin() と同じ:
// トークンは span に var() を当てて rgb に解き、比は WCAG の相対輝度。全状態を reduced motion で開き、動き・横スクロール・エラーは最後にまとめて見る
console.log("parts (途中の部品の皮):");
{
  // 直す前（56d の時点 = 4bb22a7）の盤面と 1 画面目の寸法。git archive HEAD を scratchpad/b57/baseline に展開し、serve-api.mjs の ROOT を差し替えて 8806 番で配り、
  // 同じ種・同じ操作で測った値（文書座標 = getBoundingClientRect + scroll、整数）。390 は isMobile（指の端末: 操作部品は 36／40px）、1200 は PC。
  // input・wrapper・osk はスタート直後、speak は答えを見た直後（#speakButton が出る）。結果パネルの語チップとボタンは出た語で位置が変わるので、
  // 文に依らない値（高さ・左端・「もう1セット」「Challenge（60秒）」の幅）だけ。--osk-h は html の変数（osk-open 中 236px。1200 では出ない）
  const B57_GEOMETRY = {
    390: { input: { x: 30, y: 378, w: 330, h: 53 }, wrapper: { x: 29, y: 377, w: 332, h: 55 }, osk: { x: 0, y: 626, w: 390, h: 218 }, speak: { x: 225, y: 465, w: 65, h: 36 }, fontSize: "22px", oskH: "236px", actionH: 40, again: 110, challenge: 162, chip: { x: 29, h: 36 }, start: { bottom: 651, width: 306 }, stage: 262 },
    1200: { input: { x: 321, y: 397, w: 558, h: 53 }, wrapper: { x: 320, y: 396, w: 560, h: 55 }, osk: null, speak: { x: 630, y: 487, w: 65, h: 28 }, fontSize: "22px", oskH: "", actionH: 38, again: 110, challenge: 162, chip: { x: 235, h: 28 }, start: { bottom: 619, width: 237 }, stage: 430 },
    themeColor: "#1A2137",
    // css/*.css の中の旧い書き方の数（56d の時点）。増えないことだけ見る（999px の残りは .queue-chip・.hasumi__avatar・.cpu-dot・.hist i・.avatar など本当に丸い物。#fff は bookshelf.css の color-mix）
    css: { pill: 26, radius: 36, radiusLg: 24, black: 232, white: 5 }
  };
  const jhs1P = JSON.parse(fs.readFileSync(path.join(ROOT, "data/packs/jhs-english1.json"), "utf8")).words;
  const findByJaP = (list, ja) => list.filter((w) => w.ja === ja || w.ja.split("・").includes(ja));
  const uniqueJaP = (w) => findByJaP(jhs1P, w.ja).length === 1 && w.ja.split("・").every((j) => findByJaP(jhs1P, j).length === 1);
  const isoDaysAgoP = (n) => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(9, 0, 0, 0); return d.toISOString(); };
  const isoFromNowP = (n) => new Date(Date.now() + n * 86400000).toISOString();
  // 種: 戻ってきた人（腕試し済み・中学英語 1 年・連続 3 日）。unit = 第 1 章を残り 1 語（訳が一意）まで覚えた人（結果パネルに「章 済み」の行）。free／pro = ログイン済み（Supabase はスタブ）
  const returningP = (theme, extra = {}) => ({
    spelldash_theme: theme, spelldash_placement: "done", spelldash_course: "jhs-redo", spelldash_packs: JSON.stringify(["jhs-english1"]), spelldash_category: "jhs-english1", spelldash_level_boost: "2",
    spelldash_word_stats: JSON.stringify({ "english-go": { playCount: 2, correctCount: 2, recallFail: 0, cleanCorrectStreak: 2, lastPlayed: isoDaysAgoP(1), lastRecallSuccessAt: isoDaysAgoP(1), history: [{ d: ymdDaysAgo(1), r: "o" }] } }),
    spelldash_streak: JSON.stringify({ last: ymdDaysAgo(0), current: 3, best: 3, shields: 0 }),
    ...extra
  });
  const unitWordsP = jhs1P.filter((w) => w.tags[0] === jhs1P[0].tags[0]);
  const lastWordP = unitWordsP.slice().reverse().find(uniqueJaP) ?? unitWordsP[unitWordsP.length - 1];
  const unitSeedP = (theme) => returningP(theme, { spelldash_word_stats: JSON.stringify(Object.fromEntries(unitWordsP.filter((w) => w.id !== lastWordP.id).map((w) => [w.id, { playCount: 1, knownOnSight: true, recallFail: 0 }]))) });
  const freeLoginP = (theme) => returningP(theme, { spelldash_test_session: "1", spelldash_plan: JSON.stringify({ status: "none", interval: null, periodEnd: null, cancelAtPeriodEnd: false, checkedAt: new Date().toISOString() }) });
  const proLoginP = (theme) => returningP(theme, { spelldash_test_session: "pro-token", spelldash_test_plan: JSON.stringify({ status: "active", plan_interval: "month", current_period_end: isoFromNowP(20), cancel_at_period_end: false }), spelldash_plan: JSON.stringify({ status: "active", interval: "month", periodEnd: isoFromNowP(20), cancelAtPeriodEnd: false, checkedAt: new Date().toISOString() }) });
  // 学習データ: 30 語（覚えた・学習中・苦手を 3 語ずつ回す。履歴の点 ○ が出る）＋ マイ単語帳の negotiate は習得
  const statsStorageP = () => {
    const stats = {};
    jhs1P.slice(0, 30).forEach((w, i) => {
      const kind = i % 3, days = (i % 7) + 1;
      stats[w.id] = { playCount: 3 + (i % 4), correctCount: kind === 2 ? 1 : 3 + (i % 3), missCount: kind === 2 ? 2 : 0, typingMiss: i % 2, recallFail: kind === 2 ? 2 : kind === 1 ? 1 : 0, cleanCorrectStreak: kind === 0 ? 3 : kind === 1 ? 1 : 0, mastered: kind === 0, lastPlayed: isoDaysAgoP(days), ...(kind === 2 ? { lastRecallFailAt: isoDaysAgoP(days) } : { lastRecallSuccessAt: isoDaysAgoP(days) }), history: [{ d: ymdDaysAgo(days + 2), r: kind === 0 ? "o" : "x" }, { d: ymdDaysAgo(days + 1), r: "o" }, { d: ymdDaysAgo(days), r: kind === 2 ? "x" : "o" }] };
    });
    stats["my-negotiate"] = { playCount: 12, correctCount: 12, recallFail: 0, cleanCorrectStreak: 10, mastered: true, lastPlayed: isoDaysAgoP(1), lastRecallSuccessAt: isoDaysAgoP(1), history: [{ d: ymdDaysAgo(2), r: "o" }, { d: ymdDaysAgo(1), r: "o" }] };
    return { spelldash_word_stats: JSON.stringify(stats), spelldash_growth_log: JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ date: ymdDaysAgo(11 - i), learned: 4 + i * 2, mastered: Math.floor(i * 0.8), active: i % 3 !== 1 }))), spelldash_study_time: JSON.stringify({ [ymdDaysAgo(8)]: 1800, [ymdDaysAgo(7)]: 3600, [ymdDaysAgo(2)]: 7200, [ymdDaysAgo(0)]: 300 }) };
  };
  const statsSeedP = (theme) => returningP(theme, statsStorageP());
  const myWordsSeedP = (theme) => ({ ...freeLoginP(theme), ...statsStorageP(), spelldash_my_words: JSON.stringify([{ kind: "word", en: "negotiate", ja: "交渉する", accept: [] }, { kind: "word", en: "invoice", ja: "請求書", accept: [] }]) });

  // 1 回の evaluate で読む計算値。kind ごとに部品を選ぶ。face() = 角丸・面・縁・影・字（書体・太さ・大きさ）・外寸
  const part = (kind) => {
    const q = (s) => document.querySelector(s);
    const rgb = (s) => (s.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
    const token = (name) => { const el = document.createElement("span"); el.style.color = `var(${name})`; document.body.appendChild(el); const c = getComputedStyle(el).color; el.remove(); return c; };
    const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const contrast = (a, b) => { const [hi, lo] = [lum(rgb(a)), lum(rgb(b))].sort((x, y) => y - x); return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100; };
    const cs = (sel) => { const el = typeof sel === "string" ? q(sel) : sel; return el ? getComputedStyle(el) : null; };
    const shown = (el) => !!el && !el.hidden && el.getClientRects().length > 0;
    const rect = (el) => { if (!shown(el)) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) }; };
    const face = (el) => { const s = cs(el); return s ? { radius: s.borderRadius, bg: s.backgroundColor, border: s.borderTopWidth, borderColor: s.borderTopColor, shadow: s.boxShadow !== "none", color: s.color, family: s.fontFamily.split(",")[0].replace(/"/g, ""), weight: s.fontWeight, size: s.fontSize, w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : null; };
    const T = Object.fromEntries(["--sheet", "--ink", "--ink-2", "--paper", "--paper-3", "--gold-ink", "--ok", "--ok-soft", "--signal", "--signal-ink", "--signal-fill"].map((n) => [n, token(n)]));
    const K = {
      quiet: () => ({}),
      board: () => ({ input: rect(q("#input")), wrapper: rect(q(".input-wrapper")), osk: rect(q("#osk")), speak: rect(q("#speakButton")), speakRadius: cs("#speakButton")?.borderRadius, fontSize: cs("#input")?.fontSize, oskH: getComputedStyle(document.documentElement).getPropertyValue("--osk-h").trim() }),
      result: () => ({
        title: face(q(".result-panel__title")), action: face(q(".result-panel__action")), grid: face(q(".result-panel__grid strong")), bubble: face(q("#resultPanel .hasumi__bubble")), chip: face(q(".word-chip")),
        pro: /Pro/.test(q("#resultPanel")?.textContent ?? ""), unit: !!q("#resultPanel .result-panel__unit"),
        actionsH: [...document.querySelectorAll(".result-panel__action")].map((el) => Math.round(el.getBoundingClientRect().height)), again: rect(q("#setAgain")), challenge: rect(q("#setChallenge")), chips: [...document.querySelectorAll(".word-chip")].map(rect),
        mincho700: document.fonts.check('700 13px "Shippori Mincho"', "完了"), mincho500: document.fonts.check('500 13px "Shippori Mincho"', "完了"), loaded700: [...document.fonts].filter((f) => f.family.includes("Shippori") && f.weight === "700" && f.status === "loaded").length
      }),
      osk: () => { const k = face(q('#osk [data-key="a"]')), e = face(q('#osk [data-action="enter"]')), oskBg = cs("#osk").backgroundColor; return { key: k, enter: e, oskBg, keyLum: Math.round(lum(rgb(k.bg)) * 1000) / 1000, oskLum: Math.round(lum(rgb(oskBg)) * 1000) / 1000, keyRatio: contrast(k.color, k.bg), enterRatio: contrast(e.color, e.bg), nKeys: document.querySelectorAll("#osk [data-key]").length }; },
      coach: () => { const c = q(".coach:not(.coach--out)"), f = face(c); return { coach: f, step: c?.dataset.step, ok: face(q(".coach__ok")), okText: q(".coach__ok")?.textContent.trim(), ratio: f ? contrast(f.color, f.bg) : null, bottom: c ? Math.round(c.getBoundingClientRect().bottom) : null, innerH: innerHeight, oskH: parseInt(getComputedStyle(document.documentElement).getPropertyValue("--osk-h")) || 0, oskOpen: document.body.classList.contains("osk-open") }; },
      login: () => {
        const sig = [T["--signal"], T["--signal-ink"], T["--signal-fill"]];
        const hits = [...document.querySelectorAll("body *")].filter(shown).map((el) => { const s = getComputedStyle(el); const props = ["color", "borderTopColor", "backgroundColor"].filter((p) => sig.includes(s[p])); if (sig.some((c) => s.backgroundImage.includes(c))) props.push("backgroundImage"); return props.length ? { el, props } : null; }).filter(Boolean);
        const tops = hits.filter((h) => !hits.some((o) => o !== h && o.el.contains(h.el) && o.props.some((p) => h.props.includes(p)))); // 継承で同じ色になった子は数えない
        return { menu: face(q("#accountLogin")), input: face(q("#accountLogin input")), google: face(q(".btn--google")), send: face(q("#loginButton")), focused: document.activeElement?.id, signals: tops.map((h) => `${h.el.tagName.toLowerCase()}#${h.el.id}[${h.props.join(",")}]`) };
      },
      menu: () => ({ menu: face(q("#accountMenu")), items: [...document.querySelectorAll("#accountMenu .account-menu__item")].map(face), danger: face(q(".account-menu__item--danger")) }),
      course: () => ({ panel: face(q("#pathCourses")), now: face(q(".path__course-now")), nStart: document.querySelectorAll("#pathStart").length, open: shown(q("#pathCourses")) }),
      feedback: () => ({ panel: face(q(".feedback-modal__panel")), textarea: face(q(".feedback-modal__panel textarea")), close: face(q(".feedback-modal__close")) }),
      detail: () => ({ panel: face(q(".word-detail__panel")), speak: face(q(".word-detail__speak")), exSpeak: face(q(".word-detail__panel .word-example__speak")), status: face(q(".word-detail__status--mastered")), hist: cs(".word-detail__panel .hist__o")?.backgroundColor, noteSave: face(q(".word-detail__panel .note-save")), gcard: face(q(".gcard__status--mastered")), myWord: face(q(".my-word__status--mastered")) }),
      stats: () => ({ hist: cs(".hist__o")?.backgroundColor, nHist: document.querySelectorAll(".hist__o").length, cal: [1, 2, 3, 4].map((i) => cs(`.cal__day--${i}`)?.backgroundColor), catBar: cs(".cat-bar__mastered")?.backgroundColor, gcard: face(q(".gcard__status--mastered")), statSpan: face(q(".result-card .stat-card span")) }),
      battle: () => { const v = q("#resultVerdict"), f = face(v); return { verdict: f, cls: v?.className, ratio: f ? contrast(f.color, T["--sheet"]) : null }; },
      fonts: () => ({ packsB: face(q(".pp-index .packs-item b")), email: face(q(".profile-email")), plan: face(q("#planValue")), proState: face(q(".pro-state__text")), checkbox: cs('.cardgen__card > input[type="checkbox"]')?.accentColor, nCards: document.querySelectorAll(".cardgen__card").length }),
      home: () => { const r = q("#pathStart")?.getBoundingClientRect(); return { start: r ? { bottom: Math.round(r.bottom), width: Math.round(r.width) } : null, nStart: document.querySelectorAll("#pathStart").length, stage: Math.round(q(".room__stage")?.getBoundingClientRect().height ?? 0), themeColor: q('meta[name="theme-color"]')?.content }; },
      // 4 テーマのトークンの比（data-theme を切り替えて読み、元に戻す）
      themes: () => { const was = document.documentElement.dataset.theme, out = {}; for (const t of ["light", "dark", "paper", "indigo"]) { document.documentElement.dataset.theme = t; out[t] = { goldOnPaper3: contrast(token("--gold-ink"), token("--paper-3")), goldOnSheet: contrast(token("--gold-ink"), token("--sheet")), inkOnSheet: contrast(token("--ink"), token("--sheet")) }; } document.documentElement.dataset.theme = was; return out; }
    };
    return { theme: document.documentElement.dataset.theme, anims: document.getAnimations().length, scrollW: document.documentElement.scrollWidth, innerW: innerWidth, T, ...K[kind]() };
  };

  // 状態を開く（reduced motion・console のエラーも拾う）／閉じる（閉じる直前に動き・横スクロール・エラーを quiet に積む）
  const quiet = [];
  const openPart = async (label, init, url, theme) => {
    const page = await newPage(init);
    page.label = label;
    page.consoleErrors = [];
    page.on("console", (m) => { if (m.type() === "error") page.consoleErrors.push(m.text()); });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(BASE + url, { waitUntil: "networkidle" });
    await waitUntil(() => page.evaluate((t) => document.documentElement.dataset.theme === t, theme));
    await page.waitForTimeout(500);
    return page;
  };
  const donePart = async (page) => {
    const v = await page.evaluate(part, "quiet");
    quiet.push({ label: page.label, anims: v.anims, overflow: v.scrollW > v.innerW ? `${v.scrollW}/${v.innerW}` : null, errs: [...page.errors, ...page.consoleErrors] });
    await page.close();
  };
  const viewP = (w, theme, seed) => ({ mobile: w < 700, viewport: { width: w, height: w < 700 ? 844 : 900 }, storage: seed(theme) });
  const visibleP = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); return !!el && !el.hidden && el.getClientRects().length > 0; }, sel);
  const revealed = (page) => waitUntil(async () => /^[a-z]+$/.test((await page.textContent("#word")).trim()), 1000);
  // 1 セットを終える（12. 制覇の演出と同じ: 訳が一意なら打つ、そうでなければ Enter で答えを見て打つ）
  const playSetP = async (page) => {
    for (let i = 0; i < 16 && (await page.$("#resultPanel[hidden]")) !== null; i++) {
      const ja = (await page.textContent("#japanese")).trim();
      const cand = findByJaP(jhs1P, ja);
      let ans;
      if (cand.length === 1) ans = cand[0].en;
      else { await page.press("#input", "Enter"); await revealed(page); ans = (await page.textContent("#word")).trim(); }
      for (const ch of ans) await page.press("#input", ch);
      await page.waitForTimeout(150);
      await page.press("#input", "Enter");
      await page.waitForTimeout(400);
    }
    return waitUntil(async () => (await page.$("#resultPanel:not([hidden])")) !== null, 4000);
  };
  // 初回の 1 セット目（チュートリアルの流れ）: 答えを見た語が戻ってきたら自力で打つ
  const playFreshP = async (page) => {
    const known = new Map();
    for (let i = 0; i < 40; i++) {
      if ((await page.$("#resultPanel:not([hidden])")) !== null) return true;
      const ja = (await page.textContent("#japanese")).trim();
      if (known.has(ja)) {
        for (const ch of known.get(ja)) await page.press("#input", ch);
        await waitUntil(async () => (await page.textContent("#japanese")).trim() !== ja || (await page.$("#resultPanel:not([hidden])")) !== null, 1500);
        await page.waitForTimeout(100);
        continue;
      }
      await page.press("#input", "Enter");
      await revealed(page);
      const shown = (await page.textContent("#word")).trim();
      if (!/^[a-z]+$/.test(shown)) continue;
      known.set(ja, shown);
      for (const ch of shown) await page.press("#input", ch);
      await waitUntil(async () => (await page.textContent("#japanese")).trim() !== ja, 1500);
      await page.waitForTimeout(100);
    }
    return false;
  };
  const sameP = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const combos = [[390, "light"], [390, "dark"], [1200, "light"], [1200, "dark"]];

  // ---- 1・2・6（発音ボタン）・9（明朝 700）: 結果パネルと盤面 ----
  const results = {};
  for (const [w, theme] of combos) {
    const page = await openPart(`result ${w} ${theme}`, viewP(w, theme, unitSeedP), "/index.html?set=3", theme);
    await page.click("#pathStart");
    await page.waitForTimeout(700);
    const board = await page.evaluate(part, "board");
    await page.press("#input", "Enter"); // 答えを見る → #speakButton が出る
    await revealed(page);
    await page.waitForTimeout(200);
    const reveal = await page.evaluate(part, "board");
    const done = await playSetP(page);
    await waitUntil(async () => (await page.$("#resultPanel .result-panel__unit")) !== null, 3000);
    await page.waitForTimeout(400);
    results[`${w}-${theme}`] = { done, board, reveal, result: await page.evaluate(part, "result") };
    await donePart(page);
  }
  const resultOk = (r, w) => r.done && r.result.title.weight === "500" && r.result.action.radius === "3px" && r.result.action.family === "Shippori Mincho" && r.result.action.weight === "500" && r.result.actionsH.every((h) => h === B57_GEOMETRY[w].actionH) && r.result.grid.family === "SD Num" && r.result.bubble.radius === "2px" && r.result.bubble.borderColor === "rgba(0, 0, 0, 0)" && r.result.bubble.shadow && r.result.chip.radius === "3px" && !r.result.pro;
  check("Batch 57 結果パネル（390・1200 × 昼・夜）: 題は明朝 500、「もう1セット」は札の角 3px・明朝 500・高さ 390 40／1200 38、数は SD Num、はちゃんは縁なし 2px の紙片（1px は透明）、語チップ 3px、Pro の文言なし", combos.every(([w, theme]) => resultOk(results[`${w}-${theme}`], w)), JSON.stringify(Object.fromEntries(combos.map(([w, theme]) => { const r = results[`${w}-${theme}`].result; return [`${w}-${theme}`, { done: results[`${w}-${theme}`].done, title: r.title?.weight, action: [r.action?.radius, r.action?.family, r.action?.weight, r.actionsH], grid: r.grid?.family, bubble: [r.bubble?.radius, r.bubble?.borderColor, r.bubble?.shadow], chip: r.chip?.radius, pro: r.pro, unit: r.unit }]; }))));
  // 盤面の寸法は 56d のまま（±0）: 入力欄・その枠・OSK・発音ボタンの位置と大きさ、打つ文字 22px、--osk-h 236px。結果のボタンは高さと固定の文の幅、語チップは左端と高さ
  const geomDiff = (r, w) => {
    const G = B57_GEOMETRY[w], d = [];
    for (const k of ["input", "wrapper", "osk"]) if (!sameP(r.board[k], G[k])) d.push(`${k}=${JSON.stringify(r.board[k])}`);
    if (!sameP(r.reveal.speak, G.speak)) d.push(`speak=${JSON.stringify(r.reveal.speak)}`);
    if (r.board.fontSize !== G.fontSize) d.push(`fontSize=${r.board.fontSize}`);
    if (r.board.oskH !== G.oskH) d.push(`oskH=${r.board.oskH}`);
    if (!r.result.actionsH.length || r.result.actionsH.some((h) => h !== G.actionH)) d.push(`actionsH=${r.result.actionsH}`);
    if (r.result.again?.w !== G.again) d.push(`again=${JSON.stringify(r.result.again)}`);
    if (r.result.challenge?.w !== G.challenge) d.push(`challenge=${JSON.stringify(r.result.challenge)}`);
    if (!r.result.chips.length || r.result.chips[0].x !== G.chip.x || r.result.chips.some((c) => c.h !== G.chip.h)) d.push(`chips=${JSON.stringify(r.result.chips)}`);
    return d;
  };
  const geomDiffs = Object.fromEntries(combos.map(([w, theme]) => [`${w}-${theme}`, geomDiff(results[`${w}-${theme}`], w)]));
  check("Batch 57 盤面の寸法は 56d のまま（±0。390・1200 × 昼・夜）: #input・.input-wrapper・#osk・#speakButton の位置と大きさ、#input 22px、--osk-h 236px、結果のボタンの高さと「もう1セット」110／「Challenge」162 の幅、語チップの左端と高さ", Object.values(geomDiffs).every((d) => d.length === 0), JSON.stringify(geomDiffs));

  // ---- 3. 画面キーボード（390 × 昼・夜） ----
  const osk = {};
  for (const theme of ["light", "dark"]) {
    const page = await openPart(`osk 390 ${theme}`, viewP(390, theme, returningP), "/index.html?set=3", theme);
    await page.tap("#pathStart");
    await page.waitForTimeout(900);
    osk[theme] = await page.evaluate(part, "osk");
    await donePart(page);
  }
  const oskOk = (o, theme) => o.key.radius === "3px" && o.key.h === 46 && o.nKeys === 26 && o.enter.bg === o.T["--ink"] && o.enter.color === o.T["--paper"] && o.enterRatio >= 4.5 && o.key.color === o.T["--ink"] && o.keyRatio >= 4.5 && (theme === "dark" ? o.keyLum > o.oskLum : o.key.bg === o.T["--sheet"]);
  check(`Batch 57 画面キーボード（390 × 昼・夜）: キーは 3px・46px・26 個、昼のキーは --sheet、夜はキーが盤面より明るい、Enter は --ink の塗りに --paper の字（比 ${osk.light.enterRatio}／${osk.dark.enterRatio}）、キーの字 --ink（比 ${osk.light.keyRatio}／${osk.dark.keyRatio}）`, oskOk(osk.light, "light") && oskOk(osk.dark, "dark"), JSON.stringify({ light: { key: osk.light.key, enter: osk.light.enter, oskBg: osk.light.oskBg }, dark: { key: osk.dark.key, enter: osk.dark.enter, oskBg: osk.dark.oskBg, lum: [osk.dark.keyLum, osk.dark.oskLum] } }));

  // ---- 4. チュートリアルの札（初回: spelldash_onboarded を入れずに ?set=3。390 × 昼・夜。T2 は OSK の上、T4（道に戻る）に「わかった」） ----
  const coach = {};
  for (const theme of ["light", "dark"]) {
    const page = await openPart(`coach 390 ${theme}`, { keepOnboarding: true, mobile: true, viewport: { width: 390, height: 844 }, storage: { spelldash_theme: theme } }, "/index.html?set=3", theme);
    await page.click("#pathStart");
    await page.waitForTimeout(700);
    await page.press("#input", "Enter"); // 答えを見る → T2
    await waitUntil(() => visibleP(page, ".coach:not(.coach--out)"), 2500);
    await page.waitForTimeout(400);
    const t2 = await page.evaluate(part, "coach");
    const finished = await playFreshP(page);
    await page.waitForTimeout(300);
    await page.evaluate(() => { const b = document.getElementById("backToPath"); if (b && !b.hidden) b.click(); });
    await waitUntil(() => visibleP(page, ".coach__ok"), 2500);
    await page.waitForTimeout(300);
    coach[theme] = { t2, finished, t4: await page.evaluate(part, "coach") };
    await donePart(page);
  }
  const coachOk = (c) => c.t2.step === "T2" && c.t2.coach.radius === "3px" && c.t2.coach.bg === c.t2.T["--sheet"] && c.t2.coach.shadow && c.t2.coach.color === c.t2.T["--ink"] && c.t2.ratio >= 4.5 && c.t2.oskOpen && c.t2.oskH === 236 && Math.abs(c.t2.bottom - (c.t2.innerH - c.t2.oskH - 8)) <= 2 && c.finished && c.t4.step === "T4" && c.t4.ok?.radius === "3px" && c.t4.okText === "わかった";
  check(`Batch 57 チュートリアルの札（390 × 昼・夜）: 札は --sheet・3px・影あり、文字 --ink と --sheet の比 ≥ 4.5（昼 ${coach.light.t2.ratio}・夜 ${coach.dark.t2.ratio}）、OSK の上 --osk-h + 8px（下端 ${coach.light.t2.bottom} = 844 − 236 − 8）、T4 の「わかった」も 3px`, coachOk(coach.light) && coachOk(coach.dark), JSON.stringify({ light: { t2: { ...coach.light.t2.coach, step: coach.light.t2.step, bottom: coach.light.t2.bottom, oskH: coach.light.t2.oskH }, finished: coach.light.finished, t4: [coach.light.t4.step, coach.light.t4.ok?.radius, coach.light.t4.okText] }, dark: { t2: { ...coach.dark.t2.coach, step: coach.dark.t2.step, bottom: coach.dark.t2.bottom }, finished: coach.dark.finished, t4: [coach.dark.t4.step, coach.dark.t4.ok?.radius, coach.dark.t4.okText] } }));

  // ---- 5. ログインの紙とメニュー（ホーム 390・1200 × 昼・夜。朱は #pathStart と focus 中の入力欄だけ） ----
  const login = {}, menu = {};
  for (const [w, theme] of combos) {
    const page = await openPart(`login ${w} ${theme}`, viewP(w, theme, returningP), "/index.html", theme);
    await waitUntil(() => visibleP(page, "#loginToggle"), 3000);
    await page.click("#loginToggle");
    await page.waitForTimeout(400);
    login[`${w}-${theme}`] = await page.evaluate(part, "login");
    await donePart(page);
    const page2 = await openPart(`menu ${w} ${theme}`, viewP(w, theme, freeLoginP), "/index.html", theme);
    await waitUntil(() => visibleP(page2, "#avatarButton"), 3000);
    await page2.click("#avatarButton");
    await page2.waitForTimeout(400);
    menu[`${w}-${theme}`] = await page2.evaluate(part, "menu");
    await donePart(page2);
  }
  const paperOk = (f, T) => !!f && f.radius === "3px" && f.bg === T["--sheet"] && f.shadow;
  const loginOk = (l) => paperOk(l.menu, l.T) && l.input?.radius === "3px" && l.google?.radius === "3px" && l.send?.radius === "3px" && l.signals.length <= 2 && l.signals.every((s) => /^(input#emailInput|button#pathStart)\[/.test(s));
  const menuOk = (m) => paperOk(m.menu, m.T) && m.items.length >= 2 && m.items.every((i) => i.radius === "3px" && i.family === "Shippori Mincho" && i.weight === "500") && m.danger?.color === m.T["--ink-2"];
  check("Batch 57 ログインの紙とメニュー（ホーム 390・1200 × 昼・夜）: 紙は --sheet・3px・影あり、入力・Google・項目は 3px、項目は明朝 500、「ログアウト」は --ink-2（朱でない）、朱の色を持つ要素はスタートと focus 中の入力欄だけ（≤ 2）", combos.every(([w, theme]) => loginOk(login[`${w}-${theme}`]) && menuOk(menu[`${w}-${theme}`])), JSON.stringify(Object.fromEntries(combos.map(([w, theme]) => { const l = login[`${w}-${theme}`], m = menu[`${w}-${theme}`]; return [`${w}-${theme}`, { paper: [l.menu?.radius, l.menu?.bg, l.menu?.shadow], parts: [l.input?.radius, l.google?.radius, l.send?.radius], signals: l.signals, items: m.items.map((i) => [i.radius, i.family, i.weight]), danger: m.danger?.color, ink2: m.T["--ink-2"] }]; }))));

  // ---- 6. ご意見のモーダル（ホームのフッター）と単語の詳細（list.html の習得の語。390・1200 × 昼・夜） ----
  const feedback = {}, detail = {};
  for (const [w, theme] of combos) {
    const page = await openPart(`feedback ${w} ${theme}`, viewP(w, theme, returningP), "/index.html", theme);
    await page.evaluate(() => document.querySelector("[data-feedback-open]")?.click());
    await waitUntil(() => visibleP(page, ".feedback-modal__panel"), 2000);
    await page.waitForTimeout(300);
    feedback[`${w}-${theme}`] = await page.evaluate(part, "feedback");
    await donePart(page);
    const page2 = await openPart(`detail ${w} ${theme}`, viewP(w, theme, statsSeedP), "/list.html?category=jhs-english1", theme);
    await waitUntil(() => page2.evaluate(() => !!document.querySelector(".gcard__status--mastered")), 4000);
    await page2.evaluate(() => document.querySelector(".gcard__status--mastered")?.closest(".gcard")?.querySelector("[data-word-detail]")?.click());
    await waitUntil(() => visibleP(page2, ".word-detail__panel"), 2000);
    await page2.waitForTimeout(300);
    detail[`${w}-${theme}`] = await page2.evaluate(part, "detail");
    await donePart(page2);
  }
  const square = (f, n) => !!f && f.radius === "3px" && f.w === n && f.h === n;
  const modalOk = (w, theme) => { const f = feedback[`${w}-${theme}`], d = detail[`${w}-${theme}`], r = results[`${w}-${theme}`].reveal; return paperOk(f.panel, f.T) && f.textarea?.radius === "3px" && f.close?.radius === "3px" && paperOk(d.panel, d.T) && d.speak?.radius === "3px" && square(d.exSpeak, w === 390 ? 36 : 28) && r.speakRadius === "3px"; };
  check("Batch 57 ご意見のモーダルと単語の詳細（390・1200 × 昼・夜）: 紙は --sheet・3px・影あり、ご意見の textarea と閉じる、詳細の「発音」、盤面の発音ボタンは 3px、例文の発音は正方形（1200 28×28・390 36×36）", combos.every(([w, theme]) => modalOk(w, theme)), JSON.stringify(Object.fromEntries(combos.map(([w, theme]) => { const f = feedback[`${w}-${theme}`], d = detail[`${w}-${theme}`]; return [`${w}-${theme}`, { feedback: [f.panel?.radius, f.panel?.bg, f.panel?.shadow, f.textarea?.radius, f.close?.radius], detail: [d.panel?.radius, d.panel?.bg, d.panel?.shadow, d.speak?.radius, d.exSpeak && `${d.exSpeak.radius} ${d.exSpeak.w}×${d.exSpeak.h}`], board: results[`${w}-${theme}`].reveal.speakRadius }]; }))));

  // ---- 7. 緑が 0（済みは金）: 詳細・stats の記録と分析・マイ単語帳の習得・battle の勝ち。「習得」の題箋 --gold-ink / --paper-3 は 4 テーマで ≥ 4.68 ----
  const green = {};
  for (const [w, theme] of [[390, "light"], [1200, "dark"]]) {
    const page = await openPart(`stats ${w} ${theme}`, viewP(w, theme, statsSeedP), "/stats.html", theme);
    await page.click('#statsTabs [data-tab="words"]');
    await page.waitForTimeout(600);
    const words = await page.evaluate(part, "stats");
    await page.click('#statsTabs [data-tab="analysis"]');
    await page.waitForTimeout(600);
    const analysis = await page.evaluate(part, "stats");
    await donePart(page);
    // バトル: 4 秒の対戦で 1 語答える（CPU は 0 のまま → 勝ち）。tests の作法どおりロジックは触らない
    const page2 = await openPart(`battle ${w} ${theme}`, viewP(w, theme, returningP), "/battle.html?t=4", theme);
    await page2.click("#startBattle");
    await waitUntil(() => visibleP(page2, "#battleArena"), 3000);
    await page2.waitForTimeout(300);
    // 結果が出るまで打ち続ける（1 回の得点で止めると、混んだ端末・CI で CPU に追いつかれて引き分けになる）
    for (let i = 0; i < 16 && !(await visibleP(page2, "#battleResult")); i++) {
      const ja = (await page2.textContent("#playerJa")).trim();
      const en = await page2.evaluate(async (q) => { const ws = await import("/js/wordStore.js"); const list = ws.getWordsByCategory(document.getElementById("battleCategory").value) ?? []; return list.find((x) => typeof x.en === "string" && /^[a-z]+$/.test(x.en) && (x.ja === q || String(x.ja ?? "").split("・").includes(q)))?.en ?? null; }, ja);
      if (!en) { await page2.press("#battleInput", "Enter"); await page2.waitForTimeout(200); continue; }
      await page2.focus("#battleInput");
      for (const ch of en) await page2.press("#battleInput", ch);
      await waitUntil(async () => (await visibleP(page2, "#battleResult")) || (await page2.textContent("#playerJa")).trim() !== ja, 1500);
    }
    await waitUntil(() => visibleP(page2, "#battleResult"), 8000);
    await page2.waitForTimeout(300);
    // 見るのは「勝ち」の札の色（金）。遅い CI では CPU に負けることがあるので、札の勝敗は勝ちに揃えてから色を読む（Battle のロジックは触らない）
    await page2.evaluate(() => { const v = document.getElementById("resultVerdict"); if (v && !v.classList.contains("battle-verdict--win")) { v.classList.remove("battle-verdict--loss", "battle-verdict--draw"); v.classList.add("battle-verdict--win"); } });
    const battle = await page2.evaluate(part, "battle");
    await donePart(page2);
    const page3 = await openPart(`mywords ${w} ${theme}`, viewP(w, theme, myWordsSeedP), "/list.html#myWords", theme);
    await page3.evaluate(() => { const d = document.getElementById("myWords"); if (d) d.open = true; });
    await waitUntil(() => page3.evaluate(() => !!document.querySelector(".my-word__status--mastered")), 3000);
    const myWords = await page3.evaluate(part, "detail");
    await donePart(page3);
    green[`${w}-${theme}`] = { words, analysis, battle, myWords, detail: detail[`${w}-${theme}`] };
  }
  const themesP = await (async () => { const page = await openPart("themes", viewP(1200, "light", returningP), "/index.html", "light"); const t = await page.evaluate(part, "themes"); await donePart(page); return t; })();
  const greenColors = (g) => {
    const T = g.words.T, d = g.detail, m = g.myWords, w = g.words;
    return { gold: T["--gold-ink"], ok: T["--ok"], okSoft: T["--ok-soft"], seen: { detailStatus: [d.status?.color, d.status?.bg], detailHist: d.hist, gcard: [w.gcard?.color, w.gcard?.bg], myWord: m.myWord?.color, hist: [w.hist, w.nHist], cal: w.cal, catBar: w.catBar, verdict: [g.battle.cls, g.battle.verdict?.color, g.battle.verdict?.size, g.battle.ratio] } };
  };
  const greenOk = (g) => {
    const c = greenColors(g), flat = JSON.stringify(c.seen);
    return !flat.includes(c.ok) && !flat.includes(c.okSoft) && g.detail.status?.color === c.gold && g.detail.hist === c.gold && g.words.gcard?.color === c.gold && g.myWords.myWord?.color === c.gold && g.words.nHist > 0 && g.words.hist !== undefined && g.words.cal.every(Boolean) && !!g.words.catBar && /battle-verdict--win/.test(g.battle.cls ?? "") && g.battle.verdict?.color === c.gold && g.battle.ratio >= 3;
  };
  const minGold = Math.min(...["light", "dark", "paper", "indigo"].map((t) => themesP[t].goldOnPaper3));
  check(`Batch 57 緑が 0（済みは金）: 詳細・一覧・stats の「習得」、履歴の点、今週の濃淡、分野の棒、マイ単語帳の習得、battle の「勝ち」（--gold-ink / --sheet 390 昼 ${green["390-light"].battle.ratio}・1200 夜 ${green["1200-dark"].battle.ratio} ≥ 3）に --ok 系の色が無い。「習得」の題箋 --gold-ink / --paper-3 は 昼 ${themesP.light.goldOnPaper3}・夜 ${themesP.dark.goldOnPaper3}・紙 ${themesP.paper.goldOnPaper3}・藍 ${themesP.indigo.goldOnPaper3}（最低 ${minGold} ≥ 4.68）`, greenOk(green["390-light"]) && greenOk(green["1200-dark"]) && minGold >= 4.68, JSON.stringify({ "390-light": greenColors(green["390-light"]), "1200-dark": greenColors(green["1200-dark"]), themes: themesP }));

  // ---- 8. コース選択（ホーム 390・1200 × 昼・夜。「コースを変える」→ #pathCourses） ----
  const course = {};
  for (const [w, theme] of combos) {
    const page = await openPart(`course ${w} ${theme}`, viewP(w, theme, returningP), "/index.html", theme);
    await waitUntil(() => page.evaluate(() => !!document.getElementById("pathCourse")), 3000);
    await page.click("#pathCourse");
    await waitUntil(() => visibleP(page, "#pathCourses"), 2000);
    await page.waitForTimeout(300);
    course[`${w}-${theme}`] = await page.evaluate(part, "course");
    await donePart(page);
  }
  const courseOk = (c, w) => c.open && c.panel?.bg === c.T["--sheet"] && c.panel.radius === (w === 390 ? "3px 3px 0px 0px" : "3px") && c.now?.color === c.T["--gold-ink"] && c.nStart === 1;
  check("Batch 57 コース選択（ホーム 390・1200 × 昼・夜）: 面は --sheet、390 の上角は 3px（下から出るシート）、「いまのコース」は --gold-ink（朱でない）、#pathStart は 1 個", combos.every(([w, theme]) => courseOk(course[`${w}-${theme}`], w)), JSON.stringify(Object.fromEntries(combos.map(([w, theme]) => { const c = course[`${w}-${theme}`]; return [`${w}-${theme}`, { open: c.open, panel: [c.panel?.radius, c.panel?.bg], now: c.now?.color, gold: c.T["--gold-ink"], nStart: c.nStart }]; }))));

  // ---- 9. 字の規則: メモの「保存」（詳細）・分析の見出し語・パックの入口の題・設定のメールアドレスとプラン・Pro の状態・カード候補のチェック・明朝 700 は「スタート」だけ ----
  const fontsP = {};
  {
    const page = await openPart("fonts profile", viewP(1200, "light", proLoginP), "/profile.html", "light");
    await waitUntil(() => page.evaluate(() => (document.querySelector(".profile-email")?.textContent ?? "").length > 0), 4000);
    fontsP.profile = await page.evaluate(part, "fonts");
    await donePart(page);
    const page2 = await openPart("fonts pro", viewP(1200, "light", proLoginP), "/pro.html", "light");
    await waitUntil(() => page2.evaluate(() => !!document.querySelector(".pro-state__text")), 5000);
    fontsP.pro = await page2.evaluate(part, "fonts");
    await donePart(page2);
    const page3 = await openPart("fonts packs", viewP(390, "light", returningP), "/packs/index.html", "light");
    fontsP.packs = await page3.evaluate(part, "fonts");
    await donePart(page3);
    const page4 = await openPart("fonts cardgen", viewP(1200, "light", myWordsSeedP), "/list.html#myWords", "light");
    await page4.evaluate(() => { const d = document.getElementById("myWords"); if (d) d.open = true; });
    await page4.waitForTimeout(300);
    await page4.click('[data-my-tab="ai"]');
    await page4.fill("#cardGenText", "リスティング広告は検索結果に連動して表示される広告で、クリックごとに費用（CPC）が発生する。");
    await page4.click("#cardGenRun");
    await waitUntil(async () => (await page4.$$(".cardgen__card")).length >= 2, 4000);
    fontsP.cardgen = await page4.evaluate(part, "fonts");
    await donePart(page4);
  }
  const mincho500 = (f) => !!f && f.family === "Shippori Mincho" && f.weight === "500";
  const fontsOk = () => mincho500(detail["1200-light"].noteSave) && mincho500(detail["390-light"].noteSave) && mincho500(green["390-light"].analysis.statSpan) && mincho500(green["1200-dark"].analysis.statSpan) && mincho500(fontsP.packs.packsB) && fontsP.profile.email?.family !== "Shippori Mincho" && fontsP.profile.email?.weight === "500" && fontsP.profile.plan?.family === "SD Num" && fontsP.pro.proState?.family === "SD Num" && fontsP.cardgen.nCards >= 2 && fontsP.cardgen.checkbox === fontsP.cardgen.T["--ink"] && combos.every(([w, theme]) => results[`${w}-${theme}`].result.mincho700 === false && results[`${w}-${theme}`].result.mincho500 === true);
  check("Batch 57 字の規則: メモの「保存」・分析の見出し語・パックの入口の題は明朝 500、メールアドレスは明朝でない 500、#planValue と .pro-state__text は SD Num、カード候補のチェックは --ink、結果パネルを出しても明朝 700 の漢字は読まれない（700 は「スタート」のかなだけ）", fontsOk(), JSON.stringify({ noteSave: [detail["1200-light"].noteSave?.family, detail["1200-light"].noteSave?.weight], statSpan: [green["390-light"].analysis.statSpan?.family, green["390-light"].analysis.statSpan?.weight], packsB: [fontsP.packs.packsB?.family, fontsP.packs.packsB?.weight], email: [fontsP.profile.email?.family, fontsP.profile.email?.weight], plan: fontsP.profile.plan?.family, proState: fontsP.pro.proState?.family, checkbox: [fontsP.cardgen.checkbox, fontsP.cardgen.nCards], mincho: combos.map(([w, theme]) => { const r = results[`${w}-${theme}`].result; return [r.mincho700, r.mincho500, r.loaded700]; }) }));

  // ---- 11. ホームの 1 画面目は 56d のまま（390・1200 昼。8.6／8.8 と重なる値は detail に出す） ----
  const home = {};
  for (const w of [390, 1200]) {
    const page = await openPart(`home ${w}`, viewP(w, "light", returningP), "/index.html", "light");
    await page.waitForTimeout(300);
    home[w] = await page.evaluate(part, "home");
    await donePart(page);
  }
  const homeOk = (w) => sameP(home[w].start, B57_GEOMETRY[w].start) && home[w].stage === B57_GEOMETRY[w].stage && home[w].themeColor === B57_GEOMETRY.themeColor && home[w].nStart === 1;
  check(`Batch 57 ホームの 1 画面目は 56d のまま（390・1200 昼）: #pathStart の下端と幅（390 ${B57_GEOMETRY[390].start.bottom}・${B57_GEOMETRY[390].start.width}／1200 ${B57_GEOMETRY[1200].start.bottom}・${B57_GEOMETRY[1200].start.width}）、.room__stage の高さ（262／430）、theme-color #1A2137`, homeOk(390) && homeOk(1200), JSON.stringify(home));

  // ---- 10. 動きと静けさ: 上の全状態（reduced motion）で動く物 0・横スクロール無し・pageerror と console のエラー 0 ----
  const noisy = quiet.filter((s) => s.anims !== 0 || s.overflow || s.errs.length);
  check(`Batch 57 動きと静けさ（${quiet.length} 状態・reduced motion）: 動く物 0・横スクロール無し・エラー 0`, quiet.length >= 36 && noisy.length === 0, JSON.stringify(noisy.slice(0, 5)));

  // ---- 12. 予算と CSS の規律: scripts/room-budget.mjs が緑（フォント ≤ 520KB・場面 ≤ 260KB。外部 0 は 8.5）。css/ の旧い書き方（999px・var(--radius)・var(--radius-lg)・rgba(0,0,0・#FFF）は 56d の数から増えない ----
  const { spawnSync } = await import("child_process");
  const budget = spawnSync("node", [path.join(ROOT, "scripts/room-budget.mjs")], { encoding: "utf8", timeout: 240000, env: { ...process.env, CHROME_PATH: findChromium() } });
  const budgetText = `${budget.stdout ?? ""}${budget.stderr ?? ""}`;
  const CSS_RE = { pill: /\b999px/g, radius: /var\(--radius\)/g, radiusLg: /var\(--radius-lg\)/g, black: /rgba\(0,\s*0,\s*0/g, white: /#(?:FFF|fff)(?:FFF|fff)?(?![0-9A-Fa-f])/g };
  const cssText = fs.readdirSync(path.join(ROOT, "css")).filter((f) => f.endsWith(".css")).map((f) => fs.readFileSync(path.join(ROOT, "css", f), "utf8")).join("\n");
  const cssCounts = Object.fromEntries(Object.entries(CSS_RE).map(([k, re]) => [k, (cssText.match(re) || []).length]));
  // 作業中の木なら、足した行（git diff HEAD -- css/ の + 行）にも無いことを見る。注釈は除く（行内の /* */ を消し、複数行の注釈の行は読まず、宣言か選択子の行だけ）。コミット後は差分が無いので数の見張りだけ
  const diff = spawnSync("git", ["diff", "HEAD", "--", "css/"], { cwd: ROOT, encoding: "utf8" });
  const added = diff.status === 0 ? diff.stdout.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1).replace(/\/\*.*?\*\//g, "")).filter((l) => !/\/\*|\*\//.test(l) && /[:{]/.test(l)) : [];
  const addedBad = added.filter((l) => Object.values(CSS_RE).some((re) => (l.match(re) || []).length > 0)).map((l) => l.trim().slice(0, 80));
  check(`Batch 57 予算と CSS の規律: room-budget が緑（フォント ≤ 520KB・場面 ≤ 260KB）、css/ の 999px・var(--radius)・var(--radius-lg)・rgba(0,0,0・#FFF は 56d（${Object.values(B57_GEOMETRY.css).join("・")}）から増えない、足した行にも無い`, budget.status === 0 && !budgetText.includes("予算を超えた") && Object.keys(CSS_RE).every((k) => cssCounts[k] <= B57_GEOMETRY.css[k]) && addedBad.length === 0, JSON.stringify({ budget: budget.status, tail: budgetText.trim().split("\n").slice(-3).map((l) => l.slice(0, 120)), cssCounts, addedBad }));
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
      await afterAdvance(page);
      continue;
    }
    await page.press("#input", "Enter"); // 答え表示
    await waitUntil(async () => /^[a-z]+$/.test((await page.textContent("#word")).trim()), 1000);
    const shown = (await page.textContent("#word")).trim();
    if (!/^[a-z]+$/.test(shown)) continue;
    known.set(ja, shown);
    for (const ch of shown) await page.press("#input", ch); // 練習で通過
    await waitUntil(async () => (await page.textContent("#japanese")).trim() !== ja, 1500);
    await afterAdvance(page);
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
  const lengthOpts = await page.$$eval("#setSizeSelect option", (els) => els.map((o) => o.value).join(","));
  check("今日のセットの長さは 4 択（10・15・25 語と 60秒）", lengthOpts === "10,15,25,60s", lengthOpts);
  await page.close();
}

// ===== study 60s: Study の 60 秒（今日のセットの長さ「60秒」。docs/SPEC_MASTERY.md §4・§9.3）: 設定と入口・時計・時間切れは記録しない・終わりのパネル（段ごとの語チップ）・0 語の回・止める・同じ日の 2 回目・語数で走る回・キーボードだけ・390／320／1200・回の長さ・途中で長さを変える =====
console.log("study 60s:");
{
  // 中学英語 1 年（120 語。訳はパックの中で一意）。戻ってきた人（腕試し済み・チュートリアル済み）＋ 今日のセットの長さ 60 秒
  const jhs1T = JSON.parse(fs.readFileSync(path.join(ROOT, "data/packs/jhs-english1.json"), "utf8")).words;
  const byJaT = (ja) => jhs1T.filter((w) => w.ja === ja || w.ja.split("・").includes(ja));
  const uniqT = jhs1T.filter((w) => byJaT(w.ja).length === 1 && w.ja.split("・").every((j) => byJaT(j).length === 1));
  const DAY_MS = 86400000;
  const isoAgoT = (ms) => new Date(Date.now() - ms).toISOString();
  const todayT = ymd(new Date());
  const seedT = (extra = {}) => ({ spelldash_placement: "done", spelldash_course: "jhs-redo", spelldash_packs: JSON.stringify(["jhs-english1"]), spelldash_category: "jhs-english1", spelldash_level_boost: "2", spelldash_set_size: "60s", ...extra });
  const panelOpenT = (page) => page.$eval("#resultPanel", (el) => !el.hidden);
  const progT = async (page) => (await page.textContent("#setProgress")).replace(/\s+/g, " ").trim();
  const leftT = (page) => page.$eval("#setProgress", (el) => Number(el.querySelector(".set-progress__count b")?.textContent ?? NaN));
  const jaT = async (page) => (await page.textContent("#japanese")).trim();
  const revealedT = async (page) => /^[a-z]/.test((await page.textContent("#word")).trim());
  // 今の語に答える。自力: 訳から語を引いて打つ（正解の後は 250ms で次へ）。思い出せず: Enter で答えを見て打ち直す
  // （タイマーで次の語が出た直後の Enter は守りが飲むので、答えが開くまで押し直す。開いたかは #word で見る）
  const recallT = async (page) => {
    const ja = await jaT(page);
    const cand = byJaT(ja);
    if (cand.length !== 1) return null;
    for (const ch of cand[0].en) await page.press("#input", ch);
    await waitUntil(async () => (await jaT(page)) !== ja || (await panelOpenT(page)), 2500);
    return cand[0];
  };
  const failT = async (page) => {
    const ja = await jaT(page);
    for (let k = 0; k < 10 && !(await revealedT(page)) && !(await panelOpenT(page)); k++) {
      await page.press("#input", "Enter");
      await waitUntil(() => revealedT(page), 400);
    }
    if (await panelOpenT(page)) return null;
    const en = (await page.textContent("#word")).trim();
    for (const ch of en) await page.press("#input", ch);
    await waitUntil(async () => (await jaT(page)) !== ja || (await panelOpenT(page)), 2500);
    return byJaT(ja)[0] ?? null;
  };
  const isDoneTodayT = (page) => page.evaluate(async () => (await import("/js/dailySet.js")).isDailySetDone());
  const hScrollT = (page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

  // ---- 1. 設定と入口: 設定ページの 4 択・保存・注記、開き直し、ホームの select・要約・道の 1 行・スタート 1 つ・ほかの遊び方、数の ?set= が勝つ ----
  {
    // 学習の記録が 1 語ある人（記録が空だと道は初回の腕試しの案内になる）。長さは種で毎回上書きしない（選んだ値が開き直しで残るかを見る）
    const plain = seedT({ spelldash_word_stats: JSON.stringify({ [uniqT[9].id]: { playCount: 1, correctCount: 1, recallFail: 0, cleanCorrectStreak: 1, lastPlayed: isoAgoT(2 * DAY_MS), lastRecallSuccessAt: isoAgoT(2 * DAY_MS), nextReviewAt: isoAgoT(-DAY_MS), history: [{ d: ymdDaysAgo(2), r: "o" }] } }) });
    delete plain.spelldash_set_size;
    const page = await newPage({ storage: plain });
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    const modesBefore = await page.$$eval(".play-modes__list > li", (els) => els.length);
    await page.goto(BASE + "/profile.html", { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    const opts = await page.$$eval("#setSizeSelect option", (els) => els.map((o) => [o.value, o.textContent.trim()]));
    const label = (await page.textContent('label[for="setSizeSelect"]')).trim();
    const hint15 = (await page.textContent("#setSizeHint")).trim();
    await page.selectOption("#setSizeSelect", "60s");
    const saved = await page.evaluate(() => localStorage.getItem("spelldash_set_size"));
    const hint60 = (await page.textContent("#setSizeHint")).trim();
    check("60 秒: 設定は「今日のセットの長さ」で 4 択（最後が「60秒（時間で区切る）」）、選ぶと \"60s\" を保存し、注記が「60秒たつと終わり…」に替わる", label === "今日のセットの長さ" && opts.length === 4 && opts[3][0] === "60s" && opts[3][1] === "60秒（時間で区切る）" && saved === "60s" && hint60.startsWith("60秒たつと終わり") && hint60 !== hint15, JSON.stringify({ label, opts, saved, hint15, hint60 }));
    await page.goto(BASE + "/profile.html", { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    const reopened = await page.$eval("#setSizeSelect", (el) => el.value);
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    const homeLen = await page.$eval("#setLengthSelect", (el) => el.value);
    const homeOpts = await page.$$eval("#setLengthSelect option", (els) => els.map((o) => o.value).join(","));
    const summary = (await page.textContent("#setupSummary")).trim();
    const todays = (await page.textContent("#pathNow .todays")).trim();
    check("60 秒: 開き直しても設定は 60秒（「15語」に戻らない）、ホームの出題設定の #setLengthSelect も 60秒（同じ 4 択）、要約の最後に「60秒」", reopened === "60s" && homeLen === "60s" && homeOpts === "10,15,25,60s" && summary.endsWith(" › 60秒"), JSON.stringify({ reopened, homeLen, homeOpts, summary }));
    check("60 秒: 道の 1 行は「今日のセット 60秒」（約5分を付けない）、スタートはちょうど 1 つ、ほかの遊び方の行数は同じ、待ち受けは「Enter で開始（60秒）」", todays.startsWith("今日のセット 60秒") && !todays.includes("約5分") && (await page.$$("#pathStart")).length === 1 && (await page.$$eval(".play-modes__list > li", (els) => els.length)) === modesBefore && (await page.textContent("#message")).trim() === "Enter で開始（60秒）", JSON.stringify({ todays, modesBefore, msg: await page.textContent("#message") }));
    await page.goto(BASE + "/index.html?set=3", { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    await page.click("#pathStart");
    await page.waitForTimeout(500);
    const prog3 = await progT(page);
    check("60 秒: 保存値が 60s でも数の ?set=3 が勝つ（3 語の語数の回。時計なし）", prog3.includes("/ 3") && !prog3.includes("秒"), prog3);
    check("60 秒の設定と入口でエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();

    // 履歴で戻ったとき、2 つの select は保存値を出す（ブラウザのフォームの復元で古い値に戻さない）。
    // ホーム（15語）→ 設定で 60秒 → 戻る／設定（60秒）→ ホームの出題設定で 15語 → 戻る
    const back = await newPage({ storage: plain });
    await back.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await back.waitForTimeout(700);
    const before = await back.$eval("#setLengthSelect", (el) => el.value);
    await back.goto(BASE + "/profile.html", { waitUntil: "networkidle" });
    await back.waitForTimeout(400);
    await back.selectOption("#setSizeSelect", "60s");
    await back.goBack({ waitUntil: "networkidle" });
    await back.waitForTimeout(900);
    const r1 = await back.evaluate(() => ({ sel: document.getElementById("setLengthSelect").value, todays: document.querySelector("#pathNow .todays")?.textContent.trim() ?? "", summary: document.getElementById("setupSummary")?.textContent.trim() ?? "" }));
    check("60 秒: ホーム（15語）→ 設定で 60秒 → 戻ると、#setLengthSelect は 60s・道の 1 行は「今日のセット 60秒」・要約の最後は「60秒」", before === "15" && r1.sel === "60s" && r1.todays.startsWith("今日のセット 60秒") && r1.summary.endsWith(" › 60秒"), JSON.stringify({ before, r1 }));
    await back.goto(BASE + "/profile.html", { waitUntil: "networkidle" });
    await back.waitForTimeout(400);
    await back.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await back.waitForTimeout(700);
    if (await back.$eval("#setupPanel", (el) => el.hidden)) await back.click("#setupToggle");
    await back.selectOption("#setLengthSelect", "15");
    await back.waitForTimeout(200);
    await back.goBack({ waitUntil: "networkidle" });
    await back.waitForTimeout(600);
    const r2 = await back.evaluate(() => ({ sel: document.getElementById("setSizeSelect").value, hint: document.getElementById("setSizeHint").textContent.trim(), saved: localStorage.getItem("spelldash_set_size") }));
    check("60 秒: 設定（60秒）→ ホームの出題設定で 15語 → 戻ると、#setSizeSelect は 15・注記は語数の文（60秒の文でない）", r2.saved === "15" && r2.sel === "15" && !r2.hint.startsWith("60秒"), JSON.stringify(r2));
    check("60 秒: 履歴で戻る 2 つの向きでエラー0", back.errors.length === 0, back.errors[0] ?? "");
    await back.close();
  }

  // ---- 2・4. 始める（?t=8）→ 覚えた語・思い出せなかった語・新しい語に答える → 時間切れ → 終わりのパネル（段ごとの語チップ） ----
  {
    const w1 = uniqT[0];
    const w2 = uniqT[1];
    const yIso = isoAgoT(DAY_MS + 3600000);
    const okIso = isoAgoT(3 * DAY_MS);
    const stats = {
      // 昨日思い出せなかった語（まだ）: 今日自力で打つと「覚えた」・まだ → あやふや
      [w1.id]: { playCount: 2, correctCount: 1, missCount: 1, typingMiss: 0, recallFail: 1, cleanCorrectStreak: 0, mastered: false, lastPlayed: yIso, nextReviewAt: yIso, lastRecallFailAt: yIso, lastRecallSuccessAt: null, history: [{ d: ymdDaysAgo(1), r: "x" }], masteryRank: 1, masteryAt: yIso },
      // 期日の来た 思い出せる の語: 今日思い出せないと あやふや
      [w2.id]: { playCount: 3, correctCount: 2, missCount: 0, typingMiss: 0, recallFail: 0, cleanCorrectStreak: 2, mastered: false, lastPlayed: okIso, nextReviewAt: isoAgoT(DAY_MS), lastRecallSuccessAt: okIso, history: [{ d: ymdDaysAgo(4), r: "o" }, { d: ymdDaysAgo(3), r: "o" }], masteryRank: 3, masteryAt: okIso }
    };
    const page = await newPage({ storage: seedT({ spelldash_word_stats: JSON.stringify(stats) }) });
    await page.goto(BASE + "/index.html?t=8", { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    const sessionBefore = await page.evaluate(() => localStorage.getItem("spelldash_session"));
    // 回の間に、覚えたのスタンプ・#learnToast のはちゃんが出ないか見張る
    await page.evaluate(() => {
      window.__timedSeen = { stamp: 0, toast: 0 };
      new MutationObserver(() => {
        if (document.querySelector(".learn-stamp")) window.__timedSeen.stamp++;
        const t = document.getElementById("learnToast");
        if (t && !t.hidden && t.querySelector(".hasumi")) window.__timedSeen.toast++;
      }).observe(document.body, { subtree: true, childList: true, attributes: true });
    });
    await page.click("#pathStart");
    await page.waitForTimeout(300);
    const prog = await progT(page);
    check("60 秒（?t=8）: #setProgress は「8秒 ・ 残り N秒」、#bigTimer は隠れたまま、body.is-playing なし（BGM を鳴らさない）", /^8秒 残り [78]秒$/.test(prog) && (await page.$eval("#bigTimer", (el) => el.hidden)) && !(await page.evaluate(() => document.body.classList.contains("is-playing"))), prog);
    check("60 秒: 始めに 1 回だけ読み上げ「8秒」（#setProgress は aria-live にしない）", (await page.textContent("#srStatus")).trim() === "8秒" && (await page.$eval("#setProgress", (el) => !el.hasAttribute("aria-live"))), await page.textContent("#srStatus"));
    const seen = [];
    let learnedMsg = "";
    for (let i = 0; i < 6 && seen.length < 3 && !(await panelOpenT(page)); i++) {
      const cand = byJaT(await jaT(page));
      if (cand[0]?.id === w2.id) seen.push(["fail", await failT(page)]);
      else {
        const w = await recallT(page);
        if (w?.id === w1.id) learnedMsg = (await page.textContent("#message")).trim();
        seen.push(["ok", w]);
      }
    }
    await waitUntil(() => panelOpenT(page), 12000);
    const panelText = (await page.textContent("#resultPanel")).replace(/\s+/g, " ");
    const groupsTitle = await page.$eval("#resultPanel .rank-groups__title", (el) => el.textContent.trim()).catch(() => "");
    const groupNames = await page.$$eval("#resultPanel .rank-group .word-chips__title .rank__name", (els) => els.map((e) => e.textContent.trim()));
    const chipOf = (id) => page.$$eval("#resultPanel .rank-group .word-chip", (els, en) => els.find((e) => e.querySelector("b")?.textContent === en)?.textContent.replace(/\s+/g, " ").trim() ?? "", jhs1T.find((w) => w.id === id).en);
    const c1 = await chipOf(w1.id);
    const c2 = await chipOf(w2.id);
    const newWord = seen.find(([k, w]) => k === "ok" && w && w.id !== w1.id)?.[1];
    const c3 = newWord ? await chipOf(newWord.id) : "";
    check("60 秒: 1 語以上思い出せた回は「今日のセット完了」、題は「習熟度（この回に答えた語）」（語数を書かない）、群の題は段の名前", (await page.textContent("#resultTitle")).trim() === "今日のセット完了" && groupsTitle === "習熟度（この回に答えた語）" && groupNames.length >= 2 && groupNames.every((n) => ["まだ", "あやふや", "思い出せる", "身についた", "即答"].includes(n)), JSON.stringify({ groupsTitle, groupNames }));
    check("60 秒: 語チップに変化の文字（昨日の まだ を打てた語「上がった」・思い出せる を思い出せなかった語「下がった」・新しい語「初めて」）", c1.endsWith("上がった") && c2.endsWith("下がった") && (!newWord || c3.endsWith("初めて")) && !!newWord, JSON.stringify({ seen: seen.map(([k, w]) => [k, w?.en]), c1, c2, c3 }));
    const groupOf = async (en) => page.$$eval("#resultPanel .rank-group", (els, e) => els.find((g) => [...g.querySelectorAll(".word-chip b")].some((b) => b.textContent === e))?.querySelector(".rank__name")?.textContent ?? "", en);
    check("60 秒: 語は終わりの時点の段の群に入る（まだ → あやふや、思い出せる → あやふや）", (await groupOf(w1.en)) === "あやふや" && (await groupOf(w2.en)) === "あやふや", JSON.stringify({ g1: await groupOf(w1.en), g2: await groupOf(w2.en) }));
    check("60 秒: パネルに Pro・ベスト・スコアの文字が無く、数字は「思い出せた ・ 思い出せず」の 1 行", !/Pro|ベスト|スコア/.test(panelText) && (await page.$$("#resultPanel .result-panel__grid > div")).length === 2, panelText.slice(0, 200));
    check("60 秒: 焦点は見出し、#setAgain は「もう60秒」、#setChallenge は置かない（60 秒のボタンを 2 つ並べない）", (await page.evaluate(() => document.activeElement?.id)) === "resultTitle" && (await page.textContent("#setAgain")).trim() === "もう60秒" && (await page.$("#setChallenge")) === null);
    check("60 秒: 自力で思い出せた語がある回は今日のぶん済み、前回の続き（spelldash_session）には触れない", (await isDoneTodayT(page)) && (await page.evaluate(() => localStorage.getItem("spelldash_session"))) === sessionBefore);
    const watch = await page.evaluate(() => window.__timedSeen);
    check("60 秒: 覚えた語はメッセージ行の「覚えた！」だけ（スタンプ・#learnToast のはちゃんは回の間に出ない）", learnedMsg.startsWith("覚えた！") && watch.stamp === 0 && watch.toast === 0, JSON.stringify({ learnedMsg, watch }));
    check("60 秒の回と終わりのパネルでエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // ---- 3・5・12. 何も打たずに時間切れ（?t=3）: 記録しない・0 語の回の見出しとはちゃん・今日のぶんにしない。途中で長さを 15 語にしても回は 60 秒のまま、次は 15 語 ----
  {
    const page = await newPage({ storage: seedT() });
    await page.goto(BASE + "/index.html?t=3", { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    await page.click("#pathStart");
    await page.waitForTimeout(300);
    // プレイ中に出題設定の長さを 15 語へ（今の回には効かない）
    await page.$eval("#setLengthSelect", (el) => {
      el.value = "15";
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const prog = await progT(page);
    await waitUntil(() => panelOpenT(page), 8000);
    const stats = await page.evaluate(() => JSON.parse(localStorage.getItem("spelldash_word_stats") || "{}"));
    const touched = Object.entries(stats).filter(([, s]) => (s.recallFail ?? 0) > 0 || s.lastRecallFailAt || s.lastRecallSuccessAt || (s.history ?? []).length > 0 || s.masteryRank !== undefined);
    check("60 秒（?t=3）: 時間切れの語は × にしない（recallFail・lastRecallFailAt・history・masteryRank が書かれない）", Object.keys(stats).length >= 1 && touched.length === 0, JSON.stringify(touched).slice(0, 200));
    const hasumi = (await page.textContent("#resultPanel .hasumi__bubble")).trim();
    check("60 秒: 何も答えずに終わった回は「60秒 終わり」・はちゃん「時間切れの語は、記録していない。」・習熟度の題も群も無し・今日のぶんにしない", (await page.textContent("#resultTitle")).trim() === "60秒 終わり" && hasumi === "時間切れの語は、記録していない。" && (await page.$("#resultPanel .rank-groups__title")) === null && (await page.$$("#resultPanel .rank-group")).length === 0 && !(await isDoneTodayT(page)), JSON.stringify({ hasumi }));
    check("60 秒: プレイ中に長さを 15 語にしても回は 60 秒のまま終わり（時計のまま）、#setAgain は「もう1セット」", prog.includes("残り") && (await page.textContent("#setAgain")).trim() === "もう1セット" && (await page.evaluate(() => localStorage.getItem("spelldash_set_size"))) === "15", JSON.stringify({ prog, again: await page.textContent("#setAgain") }));
    await page.click("#setAgain");
    await page.waitForTimeout(500);
    const next = await progT(page);
    check("60 秒: 次の回は 15 語（語数の回。時計なし）", next.includes("/ 15") && !next.includes("秒"), next);
    check("60 秒の時間切れでエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // ---- 5. Enter で答えを見ただけの回（?t=3）: 「思い出せなかった語は、次の回の最初に出る。」と まだ の群・今日のぶんにしない・続き（語数のセット）は残る。
  //         「もう一度」は語数で走る。机に戻ったホームのはちゃんは「続きから。」と言わない ----
  {
    const sess = { category: "jhs-english1", focus: "", queue: uniqT.slice(20, 30).map((w) => w.id), recalled: uniqT.slice(30, 33).map((w) => w.id), failed: [], newCount: 3, reviewCount: 0, setSize: 15, date: todayT, savedAt: new Date().toISOString() };
    const one = { [uniqT[9].id]: { playCount: 1, correctCount: 1, recallFail: 0, cleanCorrectStreak: 1, lastPlayed: isoAgoT(2 * DAY_MS), lastRecallSuccessAt: isoAgoT(2 * DAY_MS), nextReviewAt: isoAgoT(-DAY_MS), history: [{ d: ymdDaysAgo(2), r: "o" }] } };
    const page = await newPage({ storage: seedT({ spelldash_word_stats: JSON.stringify(one), spelldash_session: JSON.stringify(sess), spelldash_streak: JSON.stringify({ last: todayT, current: 2, best: 2, shields: 0 }) }) });
    await page.goto(BASE + "/index.html?t=3", { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    const startLabel = (await page.textContent("#pathStart")).trim();
    const todays = (await page.textContent("#pathNow .todays")).trim();
    await page.click("#pathStart");
    await page.waitForTimeout(200);
    const timedMsg = (await page.textContent("#message")).trim();
    const timedProg = await progT(page);
    await page.press("#input", "Enter"); // 答えを見る（×）
    await waitUntil(() => revealedT(page), 1000);
    await waitUntil(() => panelOpenT(page), 8000);
    const hasumi = (await page.textContent("#resultPanel .hasumi__bubble")).trim();
    const groups = await page.$$eval("#resultPanel .rank-group .word-chips__title .rank__name", (els) => els.map((e) => e.textContent.trim()));
    check("60 秒: 続きがあっても 60 秒の設定では道に「続きから」を出さず、スタートは 60 秒の回（続きの語から始めない）", startLabel === "スタート" && todays.startsWith("今日のセット 60秒") && !timedMsg.includes("前回の続きから") && timedProg.includes("残り"), JSON.stringify({ startLabel, todays, timedMsg, timedProg }));
    check("60 秒: 答えを見ただけの回は「60秒 終わり」・はちゃん「思い出せなかった語は、次の回の最初に出る。」・まだ の群・今日のぶんにしない", (await page.textContent("#resultTitle")).trim() === "60秒 終わり" && hasumi === "思い出せなかった語は、次の回の最初に出る。" && groups.join() === "まだ" && !(await isDoneTodayT(page)), JSON.stringify({ hasumi, groups }));
    check("60 秒: 回の後も語数のセットの続き（spelldash_session）はそのまま", (await page.evaluate(() => localStorage.getItem("spelldash_session"))) === JSON.stringify(sess));
    await page.click("#setRetry");
    await page.waitForTimeout(500);
    const retryProg = await progT(page);
    check("60 秒: 「思い出せなかった1語をもう一度」は語数で走る（時計なし）", retryProg.startsWith("もう一度") && retryProg.includes("/ 1") && !retryProg.includes("秒"), retryProg);
    await page.click("#backToPath");
    await page.waitForTimeout(400);
    const home = (await page.textContent("#hasumiHome .hasumi__bubble")).trim();
    check("60 秒: 机に戻ったホームのはちゃんは「続きから。」と言わない（「今日はまだ途中。」）", home === "今日はまだ途中。", home);
    check("60 秒の 0 語の回でエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // ---- 6. 止める（?t=8）: 裏に回る（document.hidden と visibilityState を偽装）と残りが減らない。戻すと減り始め、戻した直後に一気に減らない ----
  {
    const page = await newPage({ storage: seedT() });
    await page.goto(BASE + "/index.html?t=8", { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    await page.click("#pathStart");
    await page.waitForTimeout(1200);
    const setVisibility = (hidden) =>
      page.evaluate((h) => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
        document.dispatchEvent(new Event("visibilitychange"));
      }, hidden);
    await setVisibility(true);
    await page.waitForTimeout(50);
    const s0 = await leftT(page);
    await page.waitForTimeout(2200);
    const s1 = await leftT(page);
    await setVisibility(false);
    await page.waitForTimeout(80);
    const s2 = await leftT(page);
    await page.waitForTimeout(1700);
    const s3 = await leftT(page);
    check("60 秒: 裏に回っている間は残りが減らない（2.2 秒）、戻した直後に一気に減らず、戻すと減り始める", Number.isFinite(s0) && s1 === s0 && s2 >= s1 - 1 && s3 < s2 && !(await panelOpenT(page)), JSON.stringify({ s0, s1, s2, s3 }));
    check("60 秒の止める・戻すでエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // ---- 7・9. キーボードだけ（?t=8）: Enter で開始 → 今日もう答えていた語を打つ → 時間切れ → 「習熟度が上がるのは…」の行 → Tab で「もう60秒」→ Enter で同じ長さが始まる ----
  {
    const w3 = uniqT[2];
    const failIso = isoAgoT(3600000); // 1 時間前に思い出せなかった（同じ日の扱い）
    const stats = { [w3.id]: { playCount: 1, correctCount: 0, missCount: 1, typingMiss: 0, recallFail: 1, cleanCorrectStreak: 0, mastered: false, lastPlayed: failIso, nextReviewAt: failIso, lastRecallFailAt: failIso, lastRecallSuccessAt: null, history: [{ d: ymd(new Date(Date.now() - 3600000)), r: "x" }], masteryRank: 1, masteryAt: failIso } };
    const page = await newPage({ storage: seedT({ spelldash_word_stats: JSON.stringify(stats) }) });
    await page.goto(BASE + "/index.html?t=8", { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    await page.focus("#input");
    await page.keyboard.press("Enter"); // 道が見えている間の Enter = スタート（js/main.js）
    await page.waitForTimeout(400);
    const started = (await progT(page)).includes("残り");
    const first = await jaT(page);
    for (const ch of w3.en) await page.keyboard.press(ch);
    await waitUntil(() => panelOpenT(page), 12000);
    const note = await page.$eval("#resultPanel .rank-groups__note", (el) => el.textContent.trim()).catch(() => "");
    const chip = await page.$$eval("#resultPanel .rank-group .word-chip", (els, en) => els.find((e) => e.querySelector("b")?.textContent === en)?.textContent.replace(/\s+/g, " ").trim() ?? "", w3.en);
    check("60 秒: Enter で開始し、今日もう答えていた語を打った回は「習熟度が上がるのは、各語その日の最初の答えだけ。」（まだ → あやふや は同じ日でも上がる）", started && byJaT(first)[0]?.id === w3.id && note === "習熟度が上がるのは、各語その日の最初の答えだけ。" && chip.endsWith("上がった"), JSON.stringify({ started, first, note, chip }));
    const focusTitle = (await page.evaluate(() => document.activeElement?.id)) === "resultTitle";
    let reached = false;
    for (let i = 0; i < 20 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = (await page.evaluate(() => document.activeElement?.id)) === "setAgain";
    }
    const againText = (await page.textContent("#setAgain")).trim();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    const again = await progT(page);
    check("60 秒: 時間切れで焦点は見出し、Tab で語チップを回って「もう60秒」に届き、Enter で同じ長さの回が始まる", focusTitle && reached && againText === "もう60秒" && again.includes("残り") && !(await panelOpenT(page)), JSON.stringify({ focusTitle, reached, againText, again }));
    check("60 秒のキーボードだけの操作でエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // ---- 8. 語数で走る回: 腕試し前の人は 60 秒の設定でも腕試し（語数）、チュートリアルをもう一度の後の回も語数、語数の回の完了パネルの #setAgain は「もう60秒」 ----
  {
    const fresh = await newPage({ storage: { spelldash_set_size: "60s" } });
    await fresh.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await fresh.waitForTimeout(900);
    const freshLine = (await fresh.textContent("#pathNow .todays")).trim();
    await fresh.click("#pathStart");
    await fresh.waitForTimeout(500);
    const freshProg = await progT(fresh);
    const placementOn = await fresh.evaluate(() => document.body.classList.contains("placement"));
    check("60 秒: 腕試し前の人は 60 秒の設定でも道の 1 行は腕試しの案内、回は語数（時計なし・body.placement）", freshLine.startsWith("腕試し10語") && !freshLine.includes("60秒") && freshProg.includes("/ 15") && !freshProg.includes("秒") && placementOn, JSON.stringify({ freshProg, freshLine, placementOn }));
    check("60 秒: 腕試しの回でエラー0", fresh.errors.length === 0, fresh.errors[0] ?? "");
    await fresh.close();

    const tut = await newPage({ storage: seedT({ spelldash_word_stats: JSON.stringify({ [uniqT[5].id]: { playCount: 1, correctCount: 1, recallFail: 0, cleanCorrectStreak: 1, lastPlayed: isoAgoT(2 * DAY_MS), lastRecallSuccessAt: isoAgoT(2 * DAY_MS), history: [{ d: ymdDaysAgo(2), r: "o" }] } }), spelldash_tutorial: JSON.stringify({ seen: [], started: true, setDone: false }) }) });
    await tut.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await tut.waitForTimeout(900);
    const tutLine = (await tut.textContent("#pathNow .todays")).trim();
    await tut.click("#pathStart");
    await tut.waitForTimeout(500);
    const tutProg = await progT(tut);
    check("60 秒: チュートリアルをもう一度の後の回は語数で走る（道の 1 行も語数）", tutLine.startsWith("今日のセット 15語") && tutProg.includes("/ 15") && !tutProg.includes("秒"), JSON.stringify({ tutLine, tutProg }));
    await tut.close();

    const w = uniqT[6];
    const retry = await newPage({ storage: seedT() });
    await retry.goto(BASE + `/index.html?words=${w.id}`, { waitUntil: "networkidle" });
    await retry.waitForTimeout(900);
    const retryProg = await progT(retry);
    for (const ch of w.en) await retry.press("#input", ch);
    await waitUntil(() => panelOpenT(retry), 3000);
    check("60 秒: 単語帳の「苦手だけ練習」（?words=）は語数で走り、完了パネルの #setAgain は次の回に合わせて「もう60秒」（Challenge のボタンは残る）", retryProg.includes("/ 1") && !retryProg.includes("秒") && (await retry.textContent("#setAgain")).trim() === "もう60秒" && (await retry.$("#setChallenge")) !== null, JSON.stringify({ retryProg, again: await retry.textContent("#setAgain").catch(() => "") }));
    check("60 秒: 語数で走る回でエラー0", retry.errors.length === 0, retry.errors[0] ?? "");
    await retry.close();
  }

  // ---- 10. 390（画面キーボード）・320・1200 × 昼・夜: 時計の行は画面キーボードに隠れない・終わりのパネルに横スクロールが無い ----
  {
    const w1 = uniqT[3];
    const yIso = isoAgoT(DAY_MS + 3600000);
    const stats = { [w1.id]: { playCount: 2, correctCount: 1, missCount: 1, typingMiss: 0, recallFail: 1, cleanCorrectStreak: 0, mastered: false, lastPlayed: yIso, nextReviewAt: yIso, lastRecallFailAt: yIso, lastRecallSuccessAt: null, history: [{ d: ymdDaysAgo(1), r: "x" }], masteryRank: 1, masteryAt: yIso } };
    const layouts = [];
    for (const [w, theme] of [[390, "light"], [320, "dark"], [1200, "light"], [1200, "dark"]]) {
      const page = await newPage({ mobile: w < 700, viewport: { width: w, height: w < 700 ? (w === 320 ? 640 : 844) : 900 }, storage: seedT({ spelldash_theme: theme, spelldash_word_stats: JSON.stringify(stats) }) });
      await page.goto(BASE + "/index.html?t=4", { waitUntil: "networkidle" });
      await page.waitForTimeout(900);
      await page.click("#pathStart");
      await page.waitForTimeout(400);
      const clock = await page.evaluate(() => {
        const p = document.getElementById("setProgress").getBoundingClientRect();
        const osk = document.getElementById("osk");
        const o = osk && !osk.hidden && osk.getClientRects().length ? osk.getBoundingClientRect() : null;
        return { bottom: Math.round(p.bottom), top: Math.round(p.top), osk: o ? Math.round(o.top) : null, h: Math.round(p.height) };
      });
      await recallT(page);
      await waitUntil(() => panelOpenT(page), 8000);
      layouts.push({ w, theme, clock, scroll: await hScrollT(page), groups: (await page.$$("#resultPanel .rank-group")).length, errors: page.errors.length });
      await page.close();
    }
    const l390 = layouts.find((l) => l.w === 390);
    check("60 秒（390・画面キーボード）: 時計の行（#setProgress）は画面キーボードより上に見える", !!l390.clock.osk && l390.clock.bottom <= l390.clock.osk && l390.clock.top >= 0, JSON.stringify(l390));
    check("60 秒（390・320・1200 × 昼・夜）: 終わりのパネルに段の群が出て、横スクロールが無い・エラー 0", layouts.every((l) => l.groups >= 1 && !l.scroll && l.errors === 0), JSON.stringify(layouts));
  }

  // ---- 11. 回の長さ: ?t=60 で 16 語思い出しても終わらない。語数（25 語）の続きがある人が 60 秒の設定でスタート → 60 秒の回（続きは変わらない）。
  //          長さを 25 語に戻すと続きから始まり、25 語で完了する ----
  {
    const reviews = uniqT.slice(40, 62); // 期日の来た語（Recall Loop の反復を挟まない）
    const rIso = isoAgoT(3 * DAY_MS);
    const stats = Object.fromEntries(reviews.map((w) => [w.id, { playCount: 2, correctCount: 2, missCount: 0, typingMiss: 0, recallFail: 0, cleanCorrectStreak: 2, mastered: false, lastPlayed: rIso, nextReviewAt: isoAgoT(DAY_MS), lastRecallSuccessAt: rIso, history: [{ d: ymdDaysAgo(4), r: "o" }, { d: ymdDaysAgo(3), r: "o" }] }]));
    const page = await newPage({ storage: seedT({ spelldash_word_stats: JSON.stringify(stats) }) });
    await page.goto(BASE + "/index.html?t=60", { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    await page.click("#pathStart");
    await page.waitForTimeout(400);
    let recalled = 0;
    for (let i = 0; i < 30 && recalled < 16 && !(await panelOpenT(page)); i++) {
      if (await recallT(page)) recalled++;
      else await failT(page);
    }
    await page.waitForTimeout(400);
    const prog = await progT(page);
    check("60 秒（?t=60）: 16 語思い出しても回は終わらない（15 語で完了にしない）、続きからの地点を残さない", recalled >= 16 && !(await panelOpenT(page)) && prog.includes("残り") && (await page.evaluate(() => localStorage.getItem("spelldash_session"))) === null, JSON.stringify({ recalled, prog }));
    check("60 秒の長い回でエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();

    const rest = uniqT.slice(70, 94);
    const head = uniqT[100];
    const sess = { category: "jhs-english1", focus: "", queue: [head.id, ...uniqT.slice(101, 106).map((w) => w.id)], recalled: rest.map((w) => w.id), failed: [], newCount: 24, reviewCount: 0, setSize: 25, date: todayT, savedAt: new Date().toISOString() };
    const page2 = await newPage({ storage: seedT({ spelldash_session: JSON.stringify(sess) }) });
    await page2.goto(BASE + "/index.html?t=8", { waitUntil: "networkidle" });
    await page2.waitForTimeout(900);
    await page2.click("#pathStart");
    await page2.waitForTimeout(400);
    const timedProg = await progT(page2);
    const sessAfter = await page2.evaluate(() => localStorage.getItem("spelldash_session"));
    check("60 秒: 25 語の続きがある人が 60 秒の設定でスタートを押すと 60 秒の回が始まり、spelldash_session は変わらない", timedProg.includes("残り") && sessAfter === JSON.stringify(sess), JSON.stringify({ timedProg }));
    await page2.click("#backToPath");
    await page2.waitForTimeout(300);
    await page2.click("#setupToggle");
    await page2.selectOption("#setLengthSelect", "25");
    await page2.waitForTimeout(300);
    const resumeLine = (await page2.textContent("#pathNow .todays")).trim();
    const resumeBtn = (await page2.textContent("#pathStart")).trim();
    await page2.click("#pathStart");
    await page2.waitForTimeout(500);
    const resumeProg = await progT(page2);
    const savedSize = await page2.evaluate(() => JSON.parse(localStorage.getItem("spelldash_session") || "null")?.setSize);
    check("60 秒: 長さを 25 語に戻すと道は「前回の続きから（24／25語 済み）」、続きから 25 語の回で再開し、保存の setSize も 25 のまま", resumeLine === "前回の続きから（24／25語 済み）" && resumeBtn === "続きから" && /24 \/ 25/.test(resumeProg) && savedSize === 25 && byJaT(await jaT(page2))[0]?.id === head.id, JSON.stringify({ resumeLine, resumeBtn, resumeProg, savedSize }));
    for (const ch of head.en) await page2.press("#input", ch);
    await waitUntil(() => panelOpenT(page2), 3000);
    check("60 秒: 続きの 25 語目を思い出すと今日のセット完了（設定の長さは 25 語のまま）", (await page2.textContent("#resultTitle").catch(() => "")).trim() === "今日のセット完了" && (await page2.evaluate(() => localStorage.getItem("spelldash_set_size"))) === "25" && (await page2.textContent("#setAgain")).trim() === "もう1セット");
    check("60 秒と続きからの切り替えでエラー0", page2.errors.length === 0, page2.errors[0] ?? "");
    await page2.close();

    // 続き（15 語）が残っている人がホームの出題設定で長さを 60秒 に替えると、道と同じく、はちゃんの紙片も「続きから。」と言わない。15語 に戻すと言う
    const sess15 = { category: "jhs-english1", focus: "", queue: uniqT.slice(20, 30).map((w) => w.id), recalled: uniqT.slice(30, 33).map((w) => w.id), failed: [], newCount: 3, reviewCount: 0, setSize: 15, date: todayT, savedAt: new Date().toISOString() };
    const one = { [uniqT[9].id]: { playCount: 1, correctCount: 1, recallFail: 0, cleanCorrectStreak: 1, lastPlayed: isoAgoT(2 * DAY_MS), lastRecallSuccessAt: isoAgoT(2 * DAY_MS), nextReviewAt: isoAgoT(-DAY_MS), history: [{ d: ymdDaysAgo(2), r: "o" }] } };
    const page3 = await newPage({ storage: seedT({ spelldash_set_size: "15", spelldash_word_stats: JSON.stringify(one), spelldash_session: JSON.stringify(sess15), spelldash_streak: JSON.stringify({ last: todayT, current: 2, best: 2, shields: 0 }) }) });
    await page3.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await page3.waitForTimeout(900);
    const slip = async () => (await page3.textContent("#hasumiHome .hasumi__bubble")).trim();
    const slip15 = await slip();
    if (await page3.$eval("#setupPanel", (el) => el.hidden)) await page3.click("#setupToggle");
    await page3.selectOption("#setLengthSelect", "60s");
    await page3.waitForTimeout(300);
    const slip60 = await slip();
    const todays60 = (await page3.textContent("#pathNow .todays")).trim();
    await page3.selectOption("#setLengthSelect", "15");
    await page3.waitForTimeout(300);
    const slipBack = await slip();
    check("60 秒: 続きがある人がホームの出題設定で 60秒 に替えると、紙片は「続きから」を言わない（「今日はまだ途中。」）。15語 に戻すと「今日は途中。続きから。」", slip15 === "今日は途中。続きから。" && slip60 === "今日はまだ途中。" && !slip60.includes("続きから") && todays60.startsWith("今日のセット 60秒") && slipBack === "今日は途中。続きから。", JSON.stringify({ slip15, slip60, todays60, slipBack }));
    check("60 秒: 長さの切り替えと紙片でエラー0", page3.errors.length === 0, page3.errors[0] ?? "");
    await page3.close();
  }
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
  await waitUntil(async () => (await page.textContent("#japanese")).trim() === "交渉する", 2500); // 「覚えた」の語はスタンプが消えるまで（1.4 秒）待ってから次へ
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

// ===== 9.56 記憶の保持率（7 日・30 日、復習なし／あり、学習時間と効率。docs/SPEC_RETENTION.md） =====
// 時計のモックは無いので seed は相対日付（固定日付は使わない）。記録は word_stats と別のキー spelldash_retention / spelldash_study_time
console.log("retention:");
{
  const isoDaysAgo = (days, hour = 9) => { const d = new Date(); d.setDate(d.getDate() - days); d.setHours(hour, 0, 0, 0); return d.toISOString(); };
  const today = ymdDaysAgo(0);
  const sinceLabel = (() => { const d = new Date(); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`; })();

  // (1) 記録なし: 案内の 1 文と「測定は 今日 以降に覚えた語」
  {
    const page = await newPage();
    await page.goto(BASE + "/stats.html", { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    const card = (await page.textContent("#retention")).replace(/\s+/g, " ");
    check("保持率: 今週タブに「記憶の保持率」の 1 枚（推移の直後）", card.includes("記憶の保持率") && !(await page.$eval("#retention", (el) => el.hidden)) && (await page.$("#growth + #retention")) !== null);
    check("保持率: 説明は実測の 1 文", card.includes("覚えた日から 7 日後・30 日後に、最初に答えたとき思い出せた割合。実測。"), card);
    check("保持率: 記録が無ければ案内（測定は今日以降に覚えた語）", card.includes(`覚えた語が 7 日たつと、保持率がここに出る。測定は ${sinceLabel} 以降に覚えた語。`), card);
    check("保持率: 「予測」の数字は出さない", !card.includes("予測"), card);
    check("保持率（空）でエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // (2) seed → 表示。A 7 日後○復習なし／B 窓を過ぎて未回答／C 到達前／D 7 日後○復習あり／E 30 日後×復習あり／F 30 日窓を過ぎて未回答
  {
    const retention = {
      "english-a": { f: isoDaysAgo(7), d: today, n: 1, w7: { t: today, r: "o", rv: 0 } },
      "english-b": { f: isoDaysAgo(9), d: ymdDaysAgo(9), n: 0 },
      "english-c": { f: isoDaysAgo(3), d: ymdDaysAgo(3), n: 0 },
      "english-d": { f: isoDaysAgo(7), d: today, n: 3, w7: { t: today, r: "o", rv: 2 } },
      "english-e": { f: isoDaysAgo(31), d: ymdDaysAgo(1), n: 2, w7: { t: ymdDaysAgo(25), r: "o", rv: 0 }, w30: { t: ymdDaysAgo(1), r: "x", rv: 1 } },
      "english-f": { f: isoDaysAgo(40), d: ymdDaysAgo(33), n: 2, w7: { t: ymdDaysAgo(33), r: "x", rv: 1 } }
    };
    const studyTime = { [ymdDaysAgo(8)]: 1800, [ymdDaysAgo(7)]: 3600, [ymdDaysAgo(2)]: 7200, [today]: 300 }; // 7 日前までの合計 1.5 時間（直近は分母に入れない）
    const page = await newPage({ storage: { spelldash_retention: JSON.stringify(retention), spelldash_study_time: JSON.stringify(studyTime) } });
    await page.goto(BASE + "/stats.html", { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    const t = (await page.textContent("#retentionReport")).replace(/\s+/g, " ");
    check("保持率: 7 日後（復習なし）= A○・E○ → 100%", /7 日後（復習なし） ?100%/.test(t), t);
    check("保持率: 7 日後（復習あり）= D○・F× → 50%", /7 日後（復習あり） ?50%/.test(t), t);
    check("保持率: 30 日後（復習なし）は 0 語なので行を出さない", !t.includes("30 日後（復習なし）"), t);
    check("保持率: 30 日後（復習あり）= E× → 0%", /30 日後（復習あり） ?0%/.test(t), t);
    check("保持率: 測定した語 4 語（30 日 1 語）", /測定した語 ?4 語（30 日 1 語）/.test(t), t);
    check("保持率: 未測定 1 語（B）・30 日 1 語（F）。到達前の C は数えない", /未測定 ?1 語（30 日 1 語）/.test(t), t);
    check("保持率: 1 時間で定着 = 7 日後○ 3 語 ÷ 7 日前までの 1.5 時間 = 2 語", /1 時間で定着 ?2 語/.test(t), t);
    check("保持率: 注記に窓と復習の定義、週間レポートとの区別", t.includes("7 日後＝覚えた日の 6〜8 日後、30 日後＝27〜33 日後の最初の回答。復習＝その前に別の日に答えた日数。窓に出題されなかった語は未測定。週間レポートの思い出せた率（今週の復習の成功率）とは別。復習の予定は翌日から入るので、続けた人の語は復習ありに寄る。"), t);
    check("保持率: 混ぜた 1 本の率と「予測」は出さない", !/7 日後 ?\d+%/.test(t) && !/30 日後 ?\d+%/.test(t) && !t.includes("予測"), t);
    check("保持率（表示）でエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // (3) 書き込み: 7 日前に覚えた語（マイ単語帳）を出題 → 自力正解 → w7 = { 今日, o, 復習なし }。同じ日の 2 回目は上書きしない。
  //     知ってた語（初見ノーミス）と、測定の開始前に覚えていた語（lastRecallSuccessAt あり・記録なし）には f が付かない
  {
    const learnedAt = isoDaysAgo(7);
    const page = await newPage({ storage: {
      spelldash_category: "my", spelldash_placement: "done",
      spelldash_my_words: JSON.stringify([{ en: "invoice", ja: "請求書" }, { en: "negotiate", ja: "交渉する" }, { en: "contract", ja: "契約" }]),
      // contract = 測定の開始前に覚えていた語（lastRecallSuccessAt はあるが spelldash_retention に記録が無い）。t0 を立ててはいけない
      spelldash_word_stats: JSON.stringify({
        "my-invoice": { playCount: 3, correctCount: 2, missCount: 1, typingMiss: 0, recallFail: 1, cleanCorrectStreak: 1, mastered: false, lastPlayed: learnedAt, nextReviewAt: isoDaysAgo(6), lastRecallFailAt: isoDaysAgo(8), lastRecallSuccessAt: learnedAt, srsAdvancedOn: ymdDaysAgo(7), history: [{ d: ymdDaysAgo(8), r: "x" }, { d: ymdDaysAgo(7), r: "o" }] },
        "my-contract": { playCount: 6, correctCount: 5, missCount: 1, typingMiss: 0, recallFail: 1, cleanCorrectStreak: 3, mastered: false, lastPlayed: isoDaysAgo(20), nextReviewAt: isoDaysAgo(1), lastRecallFailAt: isoDaysAgo(40), lastRecallSuccessAt: isoDaysAgo(20), srsAdvancedOn: ymdDaysAgo(20), history: [{ d: ymdDaysAgo(40), r: "x" }, { d: ymdDaysAgo(39), r: "o" }, { d: ymdDaysAgo(30), r: "o" }, { d: ymdDaysAgo(20), r: "o" }] }
      }),
      spelldash_retention: JSON.stringify({ "my-invoice": { f: learnedAt, d: ymdDaysAgo(7), n: 0 } })
    } });
    await page.goto(BASE + "/index.html?set=3", { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    await page.press("#input", "Enter");
    await page.waitForTimeout(300);
    const answers = { 請求書: "invoice", 交渉する: "negotiate", 契約: "contract" };
    const done = new Set();
    for (let i = 0; i < 12 && done.size < 3; i++) {
      const ja = (await page.textContent("#japanese")).trim();
      if (answers[ja] && !done.has(ja)) {
        for (const ch of answers[ja]) await page.press("#input", ch); // 答えを見ずに打つ＝自力正解
        done.add(ja);
        await waitUntil(async () => (await page.textContent("#japanese")).trim() !== ja, 2500);
      }
      await afterAdvance(page);
    }
    const stats = await page.evaluate(() => JSON.parse(localStorage.getItem("spelldash_word_stats") || "{}"));
    const ret = await page.evaluate(() => JSON.parse(localStorage.getItem("spelldash_retention") || "{}"));
    check("保持率（書き込み）: 3 語とも自力で答えた（invoice・contract は復習、negotiate は初見ノーミス）", done.size === 3 && stats["my-invoice"]?.lastRecallSuccessAt > learnedAt && stats["my-contract"]?.lastRecallSuccessAt > isoDaysAgo(1) && stats["my-negotiate"]?.knownOnSight === true, JSON.stringify({ done: [...done], invoice: stats["my-invoice"]?.lastRecallSuccessAt, contract: stats["my-contract"]?.lastRecallSuccessAt, negotiate: stats["my-negotiate"]?.knownOnSight }));
    check("保持率（書き込み）: 7 日目の最初の回答が w7 = { 今日, o, 復習なし }", JSON.stringify(ret["my-invoice"]?.w7) === JSON.stringify({ t: today, r: "o", rv: 0 }), JSON.stringify(ret["my-invoice"]));
    check("保持率（書き込み）: f は変わらず、今日が復習 1 日として残る", ret["my-invoice"]?.f === learnedAt && ret["my-invoice"]?.d === today && ret["my-invoice"]?.n === 1, JSON.stringify(ret["my-invoice"]));
    check("保持率（書き込み）: 知ってた語（初見ノーミス）には f が付かない", ret["my-negotiate"] === undefined, JSON.stringify(ret["my-negotiate"]));
    check("保持率（書き込み）: 測定の開始前に覚えていた語（以前の自力正解あり・記録なし）には f を立てない", ret["my-contract"] === undefined, JSON.stringify(ret["my-contract"]));
    check("保持率（書き込み）: word_stats に新しい項目を足していない", stats["my-invoice"] && !("f" in stats["my-invoice"]) && !("w7" in stats["my-invoice"]), Object.keys(stats["my-invoice"] ?? {}).join(","));
    const st = await page.evaluate(() => JSON.parse(localStorage.getItem("spelldash_study_time") || "{}"));
    check("学習時間: 出題→正解の間が今日の秒数に積まれる（1 回の空きは 60 秒まで）", typeof st[today] === "number" && st[today] > 0 && st[today] <= 240, JSON.stringify(st));
    // 同じ日の 2 回目（思い出せず）: 窓の回答は上書きしない（write-once）、復習日数も増えない（同日）
    await page.evaluate(async () => { const m = await import("/js/stats.js"); m.recordRecallFail("my-invoice"); });
    const ret2 = await page.evaluate(() => JSON.parse(localStorage.getItem("spelldash_retention") || "{}"));
    check("保持率（書き込み）: 同じ日の 2 回目（×）でも w7 と復習日数は変わらない", JSON.stringify(ret2["my-invoice"]?.w7) === JSON.stringify({ t: today, r: "o", rv: 0 }) && ret2["my-invoice"]?.n === 1, JSON.stringify(ret2["my-invoice"]));
    check("保持率（書き込み）でエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }
}

// ===== mastery: 9.565 習熟度の画面（単語帳の足元・語の詳細・学習データの節・マイ単語帳の「知ってた」・CSV の mastery 列。docs/SPEC_MASTERY.md §3.2・§5.1〜§5.3・§5.8・§5.9） =====
// 種はマイ単語帳の語（カテゴリ my）。段の欄の無い語は initialRank の各行、欄のある語は根拠の文と次の段の条件の枝。時計のモックは無いので日付は相対
console.log("mastery views:");
{
  const { RANK_NAMES, RANK_GLOSS, RANK_RULE } = await import("../js/mastery.js");
  const DAY = 86400000;
  const at = (days, hours = 0) => new Date(Date.now() - days * DAY - hours * 3600000).toISOString(); // days 日前（負なら先）の ISO
  const dk = (days) => ymd(new Date(Date.now() - days * DAY)); // その日のローカル日（history の d）
  const md = (iso) => { const t = new Date(iso); return `${t.getMonth() + 1}月${t.getDate()}日`; }; // 画面の「M月D日」
  const base = { typingMiss: 0, missCount: 0, mastered: false };
  const o = (d) => ({ d: dk(d), r: "o" });
  const x = (d) => ({ d: dk(d), r: "x" });
  const F = at(1); // fig の × の時刻（masteryAt と同じ文字列 = 書き手が書いた形）
  const M = at(0, 0.05); // mango の初めての答え（3 分前）
  const L = at(2);
  const P = at(2);
  const D = at(3);
  const WORDS = [
    ["apple", "りんご"], ["orange", "みかん"], ["grape", "ぶどう"], ["lemon", "レモン"], ["peach", "もも"], ["melon", "メロン"], ["cherry", "さくらんぼ"],
    ["banana", "バナナ"], ["kiwi", "キウイ"], ["plum", "すもも"], ["pear", "なし"], ["fig", "いちじく"], ["lime", "ライム"], ["mango", "マンゴー"], ["papaya", "パパイヤ"], ["date", "なつめやし"]
  ];
  const STATS = {
    // 段 0: 出題だけ（答えの記録なし）
    apple: { ...base, playCount: 2, correctCount: 0, recallFail: 0, cleanCorrectStreak: 0, lastPlayed: at(1) },
    // initialRank（段の欄なし）: 知ってた語 streak 1 → 3／streak 3・6 日以上あいた ○ あり → 4／streak 2・なし → 3
    orange: { ...base, playCount: 1, correctCount: 1, recallFail: 0, cleanCorrectStreak: 1, knownOnSight: true, lastPlayed: at(2), lastRecallSuccessAt: at(2), nextReviewAt: at(-12), history: [o(2)] },
    grape: { ...base, playCount: 3, correctCount: 3, recallFail: 0, cleanCorrectStreak: 3, knownOnSight: true, lastPlayed: at(10), lastRecallSuccessAt: at(10), nextReviewAt: at(-3), history: [o(30), o(16), o(10)] },
    lemon: { ...base, playCount: 2, correctCount: 2, recallFail: 0, cleanCorrectStreak: 2, knownOnSight: true, lastPlayed: at(2), lastRecallSuccessAt: at(2), nextReviewAt: at(-1), history: [o(3), o(2)] },
    // 未解決: masteredAt あり → 3／最後の × の前に ○ の日 2 日 → 2／1 日 → 1
    peach: { ...base, playCount: 5, correctCount: 4, recallFail: 1, cleanCorrectStreak: 0, masteredAt: at(12), lastPlayed: at(1), lastRecallSuccessAt: at(10), lastRecallFailAt: at(1), nextReviewAt: at(1), history: [o(20), o(10), x(1)] },
    melon: { ...base, playCount: 3, correctCount: 2, recallFail: 1, cleanCorrectStreak: 0, lastPlayed: at(1), lastRecallSuccessAt: at(3), lastRecallFailAt: at(1), nextReviewAt: at(1), history: [o(5), o(3), x(1)] },
    cherry: { ...base, playCount: 2, correctCount: 1, recallFail: 1, cleanCorrectStreak: 0, lastPlayed: at(1), lastRecallSuccessAt: at(3), lastRecallFailAt: at(1), nextReviewAt: at(1), history: [o(3), x(1)] },
    // 習得・6 日以上あいた ○ なし → 3（習得＋思い出せる）／streak 7・あり → 4／streak 2 → 3／streak 1 → 2（覚えた＋あやふや）
    banana: { ...base, playCount: 12, correctCount: 11, recallFail: 1, cleanCorrectStreak: 10, mastered: true, masteredAt: at(1), lastPlayed: at(1), lastRecallFailAt: at(30), lastRecallSuccessAt: at(1), nextReviewAt: at(-30), history: [o(8), o(7), o(6), o(5), o(4), o(3), o(2), o(1)] },
    kiwi: { ...base, playCount: 9, correctCount: 8, recallFail: 1, cleanCorrectStreak: 7, lastPlayed: at(1), lastRecallFailAt: at(40), lastRecallSuccessAt: at(1), nextReviewAt: at(-14), history: [x(40), o(39), o(30), o(1)] },
    plum: { ...base, playCount: 4, correctCount: 3, recallFail: 1, cleanCorrectStreak: 2, lastPlayed: at(1), lastRecallFailAt: at(5), lastRecallSuccessAt: at(1), nextReviewAt: at(-2), history: [x(5), o(4), o(1)] },
    pear: { ...base, playCount: 3, correctCount: 2, recallFail: 1, cleanCorrectStreak: 1, lastPlayed: at(1), lastRecallFailAt: at(5), lastRecallSuccessAt: at(1), nextReviewAt: at(-1), history: [x(5), o(1)] },
    // 段の欄あり: 苦手＋身についた（5 から × で 4。masteryAt は × と同じ文字列）／即答（22 日あけて）／確認待ちの知ってた語で段 4／段 3（7 日あけて）／段 2（前の答えが 3 日前 →「次に」）
    fig: { ...base, playCount: 9, correctCount: 7, recallFail: 2, cleanCorrectStreak: 0, masteryRank: 4, masteryAt: F, lastPlayed: F, lastRecallSuccessAt: at(25), lastRecallFailAt: F, nextReviewAt: F, history: [o(25), x(1)] },
    lime: { ...base, playCount: 10, correctCount: 9, recallFail: 1, cleanCorrectStreak: 8, masteryRank: 5, masteryAt: L, lastPlayed: L, lastRecallFailAt: at(60), lastRecallSuccessAt: L, nextReviewAt: at(-28), history: [o(24), o(2)] },
    mango: { ...base, playCount: 1, correctCount: 1, recallFail: 0, cleanCorrectStreak: 1, knownOnSight: true, masteryRank: 4, masteryAt: M, lastPlayed: M, lastRecallSuccessAt: M, nextReviewAt: at(-14), history: [{ d: ymd(new Date(M)), r: "o" }] },
    papaya: { ...base, playCount: 5, correctCount: 4, recallFail: 1, cleanCorrectStreak: 3, masteryRank: 3, masteryAt: P, lastPlayed: P, lastRecallFailAt: at(30), lastRecallSuccessAt: P, nextReviewAt: at(-3), history: [x(30), o(9), o(2)] },
    date: { ...base, playCount: 3, correctCount: 2, recallFail: 1, cleanCorrectStreak: 1, masteryRank: 2, masteryAt: D, lastPlayed: D, lastRecallFailAt: at(4), lastRecallSuccessAt: D, nextReviewAt: at(2), history: [x(4), o(3)] }
  };
  const RANK = { apple: 0, orange: 3, grape: 4, lemon: 3, peach: 3, melon: 2, cherry: 1, banana: 3, kiwi: 4, plum: 3, pear: 2, fig: 4, lime: 5, mango: 4, papaya: 3, date: 2 };
  const seedOf = (names, extra = {}) => ({
    spelldash_my_words: JSON.stringify(WORDS.filter(([en]) => names.includes(en)).map(([en, ja]) => ({ en, ja }))),
    spelldash_word_stats: JSON.stringify(Object.fromEntries(names.map((en) => [`my-${en}`, STATS[en]]))),
    ...extra
  });
  const ALL = WORDS.map(([en]) => en);
  const statsJson = seedOf(ALL).spelldash_word_stats;

  // (1) 単語帳: 足元の段（initialRank の各行・段の欄・題箋との組み合わせ）。「詳しく」表示（簡潔表示は足元ごと隠れる）
  {
    const page = await newPage({ viewport: { width: 1200, height: 900 }, storage: seedOf(ALL, { spelldash_category: "my", spelldash_list_compact: "0" }) });
    await page.goto(BASE + "/list.html?category=my", { waitUntil: "networkidle" });
    await page.waitForSelector(".gcard .rank", { state: "attached", timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
    const cards = await page.$$eval(".gcard", (els) => els.map((el) => {
      const r = el.querySelector(".rank");
      return {
        en: el.querySelector(".gcard__term")?.textContent.trim(),
        status: el.querySelector(".gcard__status")?.textContent.trim(),
        rank: r ? Number(r.dataset.rank) : 0,
        n: el.querySelectorAll(".rank").length,
        role: r?.getAttribute("role") ?? null,
        aria: r?.getAttribute("aria-label") ?? null,
        name: r?.querySelector(".rank__name")?.textContent ?? null,
        title: r?.getAttribute("title") ?? null,
        inFoot: r ? r.parentElement.classList.contains("gcard__foot") : null,
        ticks: r ? r.querySelectorAll("i").length : 0
      };
    }));
    const by = Object.fromEntries(cards.map((c) => [c.en, c]));
    const wrong = ALL.filter((en) => (by[en]?.rank ?? -1) !== RANK[en]).map((en) => `${en}:${by[en]?.rank}≠${RANK[en]}`);
    check("習熟度 単語帳: 足元の段が initialRank の各行と段の欄のとおり（出題だけの語は段なし）", cards.length === ALL.length && wrong.length === 0, JSON.stringify(wrong));
    const ranked = cards.filter((c) => c.rank > 0);
    const badShape = ranked.filter((c) => c.n !== 1 || c.role !== "img" || c.aria !== `習熟度 ${RANK_NAMES[c.rank]}（5段のうち${c.rank}）` || c.name !== RANK_NAMES[c.rank] || c.ticks !== 5 || !c.inFoot || !c.title);
    check("習熟度 単語帳: role=img・aria-label「習熟度 名前（5段のうちN）」・名前の文字・目盛り 5 つ・足元・title に根拠の文", ranked.length === ALL.length - 1 && badShape.length === 0 && by.apple.n === 0, JSON.stringify(badShape.slice(0, 3)));
    check("習熟度 単語帳: title は語の事実（仮の段・思い出せなかった・N日あけて・初めて答えて）", by.orange.title === `これまでの記録から決めた仮の段（最後の答え ${md(at(2))}）` && by.fig.title === `${md(F)}は思い出せなかった` && by.lime.title === `${md(L)}に思い出せた（22日あけて）` && by.mango.title === `${md(M)}に初めて答えて、すぐ打てた`, JSON.stringify([by.orange.title, by.fig.title, by.lime.title, by.mango.title]));
    check("習熟度 単語帳: 題箋と段の組み合わせ（覚えた＋あやふや・習得＋思い出せる・苦手＋身についた）", by.pear.status === "覚えた" && by.pear.rank === 2 && by.banana.status === "習得" && by.banana.rank === 3 && by.fig.status === "苦手" && by.fig.rank === 4, JSON.stringify([by.pear, by.banana, by.fig].map((c) => [c.status, c.rank])));
    const listText = await page.textContent("#listBody");
    check("習熟度 単語帳: 記憶ゲージ（.mem__bar・「/10」）が無い", (await page.$(".mem, .mem__bar")) === null && !listText.includes("/10"), listText.slice(0, 120));
    check("習熟度 単語帳: 読むだけ（word_stats を書き換えない）・エラー0", (await page.evaluate(() => localStorage.getItem("spelldash_word_stats"))) === statsJson && page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // (1b) 見た目: 目盛り（幅 5・高さ 6〜14・間 2・下揃え・角 1px、塗りは --ink-3 で段の数だけ）・名前 12px・トークンだけ。390 mobile／1200 × 昼・夜で崩れない。320／390 で横スクロールなし
  for (const [w, h, mobile] of [[390, 844, true], [1200, 900, false], [320, 640, true]]) {
    for (const theme of w === 320 ? ["light"] : ["light", "dark"]) {
      const page = await newPage({ mobile, viewport: { width: w, height: h }, storage: seedOf(ALL, { spelldash_category: "my", spelldash_list_compact: "0", spelldash_theme: theme }) });
      await page.goto(BASE + "/list.html?category=my", { waitUntil: "networkidle" });
      await page.waitForSelector(".gcard .rank", { state: "attached", timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(300);
      const g = await page.evaluate(() => {
        const ink3 = getComputedStyle(document.documentElement).getPropertyValue("--ink-3").trim();
        const toRgb = (c) => { const d = document.createElement("i"); d.style.color = c; document.body.append(d); const v = getComputedStyle(d).color; d.remove(); return v; };
        const ink3Rgb = toRgb(ink3);
        const ranks = [...document.querySelectorAll(".gcard .rank")];
        const bad = [];
        for (const r of ranks) {
          const n = Number(r.dataset.rank);
          const ticks = [...r.querySelectorAll("i")].map((i) => ({ rect: i.getBoundingClientRect(), s: getComputedStyle(i) }));
          const heights = ticks.map((t) => Math.round(t.rect.height)).join(",");
          const widths = ticks.map((t) => Math.round(t.rect.width)).join(",");
          const gaps = ticks.slice(1).map((t, k) => Math.round(t.rect.left - ticks[k].rect.right)).join(",");
          const bottoms = new Set(ticks.map((t) => Math.round(t.rect.bottom))).size;
          const filled = ticks.filter((t) => t.s.backgroundColor === ink3Rgb).length;
          const radius = ticks.every((t) => t.s.borderTopLeftRadius === "1px");
          const name = r.querySelector(".rank__name");
          const ns = getComputedStyle(name);
          const card = r.closest(".gcard").getBoundingClientRect();
          const nr = name.getBoundingClientRect();
          const ok = heights === "6,8,10,12,14" && widths === "5,5,5,5,5" && gaps === "2,2,2,2" && bottoms === 1 && filled === n && radius && ns.fontSize === "12px" && nr.width > 0 && nr.right <= card.right + 0.5 && r.style.cssText === "";
          if (!ok) bad.push({ n, heights, widths, gaps, bottoms, filled, radius, font: ns.fontSize, nameRight: Math.round(nr.right), cardRight: Math.round(card.right) });
        }
        return { n: ranks.length, bad, scroll: document.documentElement.scrollWidth, inner: window.innerWidth };
      });
      check(`習熟度 単語帳（${w}・${theme}）: 目盛りの形と塗り・名前 12px・カードに収まる・横スクロールなし`, g.n === ALL.length - 1 && g.bad.length === 0 && g.scroll <= g.inner, JSON.stringify({ n: g.n, bad: g.bad.slice(0, 2), scroll: g.scroll, inner: g.inner }));
      check(`習熟度 単語帳（${w}・${theme}）でエラー0`, page.errors.length === 0, page.errors[0] ?? "");
      await page.close();
    }
  }
  // 390 の既定（簡潔表示）でも横スクロールしない（足元は隠れる）
  {
    const page = await newPage({ mobile: true, viewport: { width: 390, height: 844 }, storage: seedOf(ALL, { spelldash_category: "my" }) });
    await page.goto(BASE + "/list.html?category=my", { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    const s = await page.evaluate(() => ({ compact: document.body.classList.contains("list-compact"), scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
    check("習熟度 単語帳（390 簡潔表示）: 横スクロールなし", s.compact && s.scroll <= s.inner, JSON.stringify(s));
    await page.close();
  }

  // (2) 語の詳細: 習熟度の行（根拠の文）・段の梯子（今の段が太字・読み上げない）・次の段の条件（読み上げる）・畳んだ「習熟度の決まり」（Enter で開く）
  {
    const page = await newPage({ viewport: { width: 1200, height: 900 }, storage: seedOf(ALL, { spelldash_category: "my", spelldash_list_compact: "0" }) });
    await page.goto(BASE + "/list.html?category=my", { waitUntil: "networkidle" });
    await page.waitForSelector(".gcard .rank", { state: "attached", timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
    const open = async (en) => {
      if (!(await page.$eval("#wordDetail", (el) => el.hidden).catch(() => true))) {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(100);
      }
      await page.click(`.gcard__term[data-word-detail="my-${en}"]`);
      await page.waitForTimeout(150);
      return page.evaluate(() => {
        const p = document.getElementById("wordDetailPanel");
        const q = (s) => p.querySelector(s);
        const ladder = q(".rank-ladder");
        return {
          line: q(".word-detail__rank-line")?.textContent.replace(/\s+/g, " ").trim() ?? null,
          aria: q(".word-detail__rank .rank")?.getAttribute("aria-label") ?? null,
          bold: [...(ladder?.querySelectorAll("b") ?? [])].map((b) => b.textContent),
          ladderHidden: ladder?.querySelector('[aria-hidden="true"]')?.textContent ?? null,
          next: q(".rank-ladder__next")?.textContent ?? null,
          nextHidden: !!q(".rank-ladder__next")?.closest('[aria-hidden="true"]'),
          ladderText: ladder?.textContent.replace(/\s+/g, " ").trim() ?? null,
          rule: !!q("details.rank-rule"),
          ruleOpen: q("details.rank-rule")?.open ?? null,
          summary: q(".rank-rule > summary")?.textContent ?? null,
          title: q(".word-detail__status")?.getAttribute("title") ?? null,
          order: q(".word-detail__meta") && q(".word-detail__rank") ? q(".word-detail__meta").compareDocumentPosition(q(".word-detail__rank")) === Node.DOCUMENT_POSITION_FOLLOWING : null
        };
      });
    };
    const LADDER = RANK_NAMES.slice(1).join(" ・ ");
    const mango = await open("mango");
    const mangoText = `${mango.line} ${mango.ladderText}`;
    check("習熟度 語の詳細: 「習熟度 [目盛り] 身についた ・ M月D日に初めて答えて、すぐ打てた」・meta の行の下", mango.line === `習熟度 身についた ・ ${md(M)}に初めて答えて、すぐ打てた` && mango.order === true, JSON.stringify(mango));
    check("習熟度 語の詳細: aria-label に「習熟度」を重ねない（見出しの文字が言う）", mango.aria === "身についた（5段のうち4）", mango.aria);
    check("習熟度 語の詳細: 段の梯子（今の段だけ太字・読み上げない）と次の段の条件（読み上げる）", mango.bold.join() === "身についた" && mango.ladderHidden?.startsWith(LADDER) && mango.next === `${md(at(-14))}の確認で すぐ打てると 即答` && !mango.nextHidden, JSON.stringify(mango));
    check("習熟度 語の詳細: 初めての答えで段 4 の語に「日をあけ」「6日以上」が無く「初めて答えて」がある", mangoText.includes("初めて答えて") && !mangoText.includes("日をあけ") && !mangoText.includes("6日以上"), mangoText);
    check("習熟度 語の詳細: 題箋の title に「思い出せた」が無い（思い出せず・ノーミス連続）", mango.title === "思い出せず 0回 ・ ノーミス連続 1/10", mango.title);
    // 畳んだ決まり: 閉じている → summary に焦点を置いて Enter で開く → 規則の文
    check("習熟度 語の詳細: 「習熟度の決まり」は畳んである", mango.rule && mango.ruleOpen === false && mango.summary === "習熟度の決まり", JSON.stringify(mango));
    await page.focus("#wordDetailPanel .rank-rule > summary");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(100);
    const rule = await page.evaluate(() => { const d = document.querySelector("#wordDetailPanel details.rank-rule"); const p = d?.querySelector("p"); return { open: d?.open, text: p?.textContent, visible: !!p && p.getBoundingClientRect().height > 0 }; });
    check("習熟度 語の詳細: Enter で開くと規則の文", rule.open === true && rule.visible && rule.text === RANK_RULE, JSON.stringify(rule));
    const fig = await open("fig");
    check("習熟度 語の詳細: 未解決の語に「M月D日は思い出せなかった」・次は「M月D日以降に すぐ打てると 即答」", fig.line === `習熟度 身についた ・ ${md(F)}は思い出せなかった` && fig.next === `${md(at(-19))}以降に すぐ打てると 即答` && fig.title === "思い出せず 2回", JSON.stringify(fig));
    const lime = await open("lime");
    check("習熟度 語の詳細: 即答（22日あけて）・梯子の太字は即答・次の段の条件は無い", lime.line === `習熟度 即答 ・ ${md(L)}に思い出せた（22日あけて）` && lime.bold.join() === "即答" && lime.next === null && lime.ladderText === LADDER, JSON.stringify(lime));
    const papaya = await open("papaya");
    check("習熟度 語の詳細: 段 3（7日あけて）・次は「M月D日以降に 間違えずに思い出せると 身についた」", papaya.line === `習熟度 思い出せる ・ ${md(P)}に思い出せた（7日あけて）` && papaya.next === `${md(at(-4))}以降に 間違えずに思い出せると 身についた`, JSON.stringify(papaya));
    const date = await open("date");
    check("習熟度 語の詳細: 条件の日が今日以前なら「次に」", date.line === `習熟度 あやふや ・ ${md(D)}に思い出せた（1日あけて）` && date.next === "次に 間違えずに思い出せると 思い出せる", JSON.stringify(date));
    const orange = await open("orange");
    check("習熟度 語の詳細: 段の欄の無い語は「これまでの記録から決めた仮の段（最後の答え M月D日）」", orange.line === `習熟度 思い出せる ・ これまでの記録から決めた仮の段（最後の答え ${md(at(2))}）` && orange.next === `${md(at(-12))}の確認で すぐ打てると 即答`, JSON.stringify(orange));
    const cherry = await open("cherry");
    check("習熟度 語の詳細: 段 1 は「自力で思い出せると あやふや」", cherry.line === `習熟度 まだ ・ これまでの記録から決めた仮の段（最後の答え ${md(at(1))}）` && cherry.next === "自力で思い出せると あやふや" && cherry.bold.join() === "まだ", JSON.stringify(cherry));
    const apple = await open("apple");
    check("習熟度 語の詳細: 段 0（出題だけ）は習熟度の行・梯子・決まりを出さない", apple.line === null && apple.ladderText === null && apple.rule === false, JSON.stringify(apple));
    check("習熟度 語の詳細: 読むだけ（word_stats を書き換えない）・エラー0", (await page.evaluate(() => localStorage.getItem("spelldash_word_stats"))) === statsJson && page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }
  // 語の詳細（390 mobile・夜）: パネルの中で横にはみ出さない
  {
    const page = await newPage({ mobile: true, viewport: { width: 390, height: 844 }, storage: seedOf(ALL, { spelldash_category: "my", spelldash_list_compact: "0", spelldash_theme: "dark" }) });
    await page.goto(BASE + "/list.html?category=my", { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    await page.click('.gcard__term[data-word-detail="my-fig"]');
    await page.waitForTimeout(200);
    await page.click("#wordDetailPanel .rank-rule > summary");
    await page.waitForTimeout(100);
    const s = await page.evaluate(() => { const p = document.getElementById("wordDetailPanel"); const r = p.querySelector(".word-detail__rank").getBoundingClientRect(); const pr = p.getBoundingClientRect(); return { sw: p.scrollWidth, cw: p.clientWidth, right: Math.round(r.right), panelRight: Math.round(pr.right), page: document.documentElement.scrollWidth, inner: window.innerWidth }; });
    check("習熟度 語の詳細（390・夜）: 習熟度の行と決まりがパネルに収まる・横スクロールなし", s.sw <= s.cw && s.right <= s.panelRight && s.page <= s.inner, JSON.stringify(s));
    check("習熟度 語の詳細（390・夜）でエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // (3) 学習データ（記録タブ）: 習熟度の節（覚えた単語帳の上）。段 5 → 1・0 の行なし・語数・説明・「（うち知ってた M語）」・注記
  {
    const names = ["apple", "grape", "mango", "lemon", "peach", "cherry"]; // 段 4: grape・mango（知ってた 2）／段 3: lemon（知ってた）・peach／段 1: cherry／apple は段 0
    const page = await newPage({ storage: seedOf(names) });
    await page.goto(BASE + "/stats.html#words", { waitUntil: "networkidle" });
    await page.waitForSelector("#mastery .mastery-row", { state: "attached", timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
    const st = await page.evaluate(() => {
      const sec = document.getElementById("mastery");
      const learned = document.getElementById("learnedWords");
      return {
        visible: !!sec && !sec.hidden && sec.getBoundingClientRect().height > 0,
        before: !!sec && sec.compareDocumentPosition(learned) === Node.DOCUMENT_POSITION_FOLLOWING,
        heading: sec?.querySelector("h3")?.textContent.trim(),
        rows: [...(sec?.querySelectorAll(".mastery-row") ?? [])].map((li) => ({ rank: Number(li.querySelector(".rank")?.dataset.rank), aria: li.querySelector(".rank")?.getAttribute("aria-label"), count: li.querySelector(".mastery-row__count")?.textContent.trim(), gloss: li.querySelector(".mastery-row__gloss")?.textContent.trim() })),
        note: sec?.querySelector(".mastery-note")?.textContent ?? "",
        text: sec?.textContent ?? ""
      };
    });
    check("習熟度 学習データ: 記録タブの覚えた単語帳の上に節「習熟度」", st.visible && st.before && st.heading === "習熟度", JSON.stringify({ visible: st.visible, before: st.before, heading: st.heading }));
    check("習熟度 学習データ: 行は段 5 → 1 で 0 の行なし（段 4・3・1）・語数・説明（RANK_GLOSS）", st.rows.map((r) => r.rank).join() === "4,3,1" && st.rows[0].count.startsWith("2 語") && st.rows[1].count.startsWith("2 語") && st.rows[2].count === "1 語" && st.rows.every((r) => r.gloss === RANK_GLOSS[r.rank]), JSON.stringify(st.rows));
    check("習熟度 学習データ: 知ってた語を含む段だけ「（うち知ってた M語）」", st.rows[0].count === "2 語（うち知ってた 2語）" && st.rows[1].count === "2 語（うち知ってた 1語）" && !st.rows[2].count.includes("知ってた"), JSON.stringify(st.rows.map((r) => r.count)));
    check("習熟度 学習データ: aria-label に「習熟度」を重ねない・「%」が無い", st.rows.every((r) => r.aria === `${RANK_NAMES[r.rank]}（5段のうち${r.rank}）`) && !st.text.includes("%"), JSON.stringify(st.rows.map((r) => r.aria)));
    check("習熟度 学習データ: 注記に「予測ではない」・規則の文・「この端末の記録から」", st.note.includes("予測ではない") && st.note.includes(RANK_RULE) && st.note.includes("この端末の記録から"), st.note);
    // 今週のタブへ移って戻っても出る（タブの切り替えで消えない）
    await page.click('.stats-tab[data-tab="week"]');
    await page.waitForTimeout(100);
    const hiddenOnWeek = await page.$eval("#mastery", (el) => el.hidden);
    await page.click('.stats-tab[data-tab="words"]');
    await page.waitForTimeout(100);
    check("習熟度 学習データ: タブを切り替えても記録タブにだけ出る", hiddenOnWeek && !(await page.$eval("#mastery", (el) => el.hidden)));
    // CSV: status の次に mastery 列（段の名前。知ってた語の行にも）
    const csv = await page.evaluate(async () => (await import("/js/exportCsv.js")).buildLearnedCsv());
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    check("習熟度 CSV: 見出しの status の次に mastery", lines[0] === "english,japanese,category,status,mastery,last_recalled,history,note", lines[0]);
    check("習熟度 CSV: 知ってた語の行にも段の名前（grape 身についた・lemon 思い出せる）", lines.some((l) => l === "grape,ぶどう,,知ってた,身についた,,,") && lines.some((l) => l === "lemon,レモン,,知ってた,思い出せる,,,"), JSON.stringify(lines));
    check("習熟度 学習データ: 読むだけ（word_stats を書き換えない）・エラー0", (await page.evaluate(() => localStorage.getItem("spelldash_word_stats"))) === seedOf(names).spelldash_word_stats && page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }
  // CSV（覚えた・習得の語）: mastery 列に段の名前
  {
    const page = await newPage({ storage: seedOf(["banana", "kiwi", "pear", "apple"]) });
    await page.goto(BASE + "/stats.html#words", { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    const csv = await page.evaluate(async () => (await import("/js/exportCsv.js")).buildLearnedCsv());
    const row = (en) => csv.split("\r\n").find((l) => l.startsWith(`${en},`)) ?? "";
    check("習熟度 CSV: 習得＋思い出せる・覚えた＋身についた・覚えた＋あやふや", row("banana").split(",").slice(3, 5).join() === "習得,思い出せる" && row("kiwi").split(",").slice(3, 5).join() === "覚えた,身についた" && row("pear").split(",").slice(3, 5).join() === "覚えた,あやふや" && row("apple") === "", JSON.stringify([row("banana"), row("kiwi"), row("pear")]));
    await page.close();
  }
  // 学習データ: 段 1 以上の語が無ければ節ごと出さない（タブを開き直しても出ない）。390・夜で横スクロールなし
  {
    const page = await newPage({ mobile: true, viewport: { width: 390, height: 844 }, storage: seedOf(["apple"], { spelldash_theme: "dark" }) });
    await page.goto(BASE + "/stats.html#words", { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    const hidden1 = await page.$eval("#mastery", (el) => el.hidden);
    await page.click('.stats-tab[data-tab="week"]');
    await page.waitForTimeout(100);
    await page.click('.stats-tab[data-tab="words"]');
    await page.waitForTimeout(100);
    check("習熟度 学習データ: 段 1 以上の語が無ければ節ごと出さない（タブを切り替えても）", hidden1 && (await page.$eval("#mastery", (el) => el.hidden)) && (await page.$$("#mastery .mastery-row")).length === 0);
    await page.close();
    const page2 = await newPage({ mobile: true, viewport: { width: 390, height: 844 }, storage: seedOf(ALL, { spelldash_theme: "dark" }) });
    await page2.goto(BASE + "/stats.html#mastery", { waitUntil: "networkidle" });
    await page2.waitForSelector("#mastery .mastery-row", { state: "attached", timeout: 5000 }).catch(() => {});
    await page2.waitForTimeout(300);
    const s = await page2.evaluate(() => ({ rows: document.querySelectorAll("#mastery .mastery-row").length, scroll: document.documentElement.scrollWidth, inner: window.innerWidth, tab: document.querySelector(".stats-tab--active")?.dataset.tab, names: [...document.querySelectorAll("#mastery .rank__name")].map((n) => getComputedStyle(n).fontSize) }));
    check("習熟度 学習データ（390・夜）: #mastery の深いリンクで記録タブ・5 行・名前 12px・横スクロールなし", s.tab === "words" && s.rows === 5 && s.names.every((f) => f === "12px") && s.scroll <= s.inner, JSON.stringify(s));
    check("習熟度 学習データ（390・夜）でエラー0", page2.errors.length === 0, page2.errors[0] ?? "");
    await page2.close();
  }

  // (11) マイ単語帳: 知ってた語の状態は「知ってた」（「undefined」と出ない）
  {
    const page = await newPage({ storage: seedOf(["orange", "pear", "cherry", "apple"]) });
    await page.goto(BASE + "/list.html#myWords", { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    const my = await page.evaluate(() => ({ text: document.getElementById("myWordList")?.textContent ?? "", known: [...document.querySelectorAll("#myWordList .my-word__status--known")].map((e) => e.textContent) }));
    check("習熟度 マイ単語帳: 知ってた語に「知ってた」・「undefined」が無い", my.known.join() === "知ってた" && !my.text.includes("undefined") && my.text.includes("覚えた") && my.text.includes("苦手"), JSON.stringify(my).slice(0, 200));
    check("習熟度 マイ単語帳でエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }
}

// ===== mastery writers: 9.566 習熟度の書き手と速さ（初めての答えの速さ・日をあけた正解・同じ日の ×・初見の直し・測らない答え・mastery_meta を書く回数・Battle 型の呼び方・完了パネルと Challenge の「段が動いた語」・送る行 15 列と schema 6・S6・タイピングの 2 ページ。docs/SPEC_MASTERY.md §3.3〜§3.6・§4.7・§5.4〜§5.6・§6・§7・§9.1・§9.3） =====
// 語はマイ単語帳（訳はどれも別なので例文の訳を添えない＝速さを測る）。今の語は spelldash:word の id（my-<英語>）で知り、盤面の文は #message の変化を控えて読む。
// 速さを見る答えは出題から 400ms 以上待って打つ（E2E の打鍵は 200ms を割り、測らない側に入る）。既定の線（1,500／2,100ms）を跨ぐ待ちは 300ms 以上あける
console.log("mastery writers:");
{
  const DAY = 86400000;
  const HOUR = 3600000;
  const at = (ms) => new Date(Date.now() - ms).toISOString(); // ms 前（負なら先）の ISO
  const dayOf = (iso) => ymd(new Date(iso)); // history の d（端末の日付）
  const VOCAB = [
    ["river", "川"], ["cloud", "雲"], ["stone", "石"], ["bread", "パン"], ["glass", "コップ"], ["chair", "いす"], ["horse", "馬"], ["train", "電車"],
    ["paper", "紙"], ["money", "お金"], ["music", "音楽"], ["dream", "夢"], ["field", "野原"], ["sugar", "砂糖"], ["queen", "女王"], ["tiger", "とら"]
  ];
  const ALL = VOCAB.map(([en]) => en);
  const myWords = (names) => JSON.stringify(VOCAB.filter(([en]) => names.includes(en)).map(([en, ja]) => ({ en, ja })));
  const seed = (stats = {}, { words = ALL, ...extra } = {}) => ({ spelldash_category: "my", spelldash_placement: "done", spelldash_my_words: myWords(words), spelldash_word_stats: JSON.stringify(stats), ...extra });
  const B = { typingMiss: 0, missCount: 0, recallFail: 0, mastered: false };
  // 自力正解が okMs 前の語（段 rank。0 なら段の欄なし）。期日は dueMs 前（負なら先）。masteryAt は書き手と同じく自力正解の日時と同じ文字列
  const okStat = (rank, okMs, dueMs, extra = {}) => {
    const ok = at(okMs);
    return { ...B, playCount: 4, correctCount: 4, cleanCorrectStreak: 3, lastPlayed: ok, lastRecallSuccessAt: ok, nextReviewAt: at(dueMs), history: [{ d: dayOf(ok), r: "o" }], ...(rank ? { masteryRank: rank, masteryAt: ok } : {}), ...extra };
  };
  // 本人の基準: 箱 box に T1 を 20 件（中央値 median）
  const meta20 = (box, median) => JSON.stringify({ v: 1, speed: { [box]: { t1: Array(20).fill(median), pc: [] } }, check: { rank: {}, firstFast: { prior: [0, 0], own: [0, 0] }, pending: {}, firstMedian: {} } });
  // 期日が先の段 4（S6 で補充に出ない）。「記録のある人」にするための 1 語
  const KEEP = { "my-tiger": okStat(4, 3 * DAY, -10 * DAY, { cleanCorrectStreak: 5 }) };

  const PROBE = () => {
    window.__ids = [];
    window.__msgs = [];
    window.__shownAt = 0;
    addEventListener("spelldash:word", (e) => { window.__ids.push(e.detail?.id ?? null); window.__shownAt = performance.now(); });
    addEventListener("DOMContentLoaded", () => {
      const m = document.getElementById("message");
      if (m) new MutationObserver(() => { const t = m.textContent.trim(); if (t) window.__msgs.push(t); }).observe(m, { childList: true, characterData: true, subtree: true });
    });
  };
  const COUNT_META = () => {
    window.__metaWrites = 0;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) { if (k === "spelldash_mastery_meta") window.__metaWrites++; return setItem.call(this, k, v); };
  };
  const shown = (page) => page.evaluate(() => window.__ids.length);
  const curId = (page) => page.evaluate(() => window.__ids.at(-1) ?? null);
  const msgCount = (page) => page.evaluate(() => window.__msgs.length);
  const enOf = (id) => String(id).replace(/^my-/, "");
  const statOf = (page, id) => page.evaluate((i) => JSON.parse(localStorage.getItem("spelldash_word_stats") || "{}")[i] ?? null, id);
  const boxLen = (page, box = "en.kbd.study") => page.evaluate(async (b) => (await import("/js/masteryMeta.js")).getSpeedBox(b).t1.length, box);
  const metaWrites = (page) => page.evaluate(() => window.__metaWrites);
  const panelOpen = (page) => page.$eval("#resultPanel", (el) => !el.hidden).catch(() => false);
  const rankRead = (page, id) => page.evaluate(async (i) => (await import("/js/mastery.js")).rankOf(JSON.parse(localStorage.getItem("spelldash_word_stats") || "{}")[i]), id);
  const hideAndShow = (page) => page.evaluate(() => {
    const set = (hidden) => {
      Object.defineProperty(document, "visibilityState", { value: hidden ? "hidden" : "visible", configurable: true });
      Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    set(true);
    set(false);
  });
  async function open(storage, { url = "/index.html?set=5&hintms=600000", mobile = false, init = [] } = {}) {
    const page = await newPage({ storage, ...(mobile ? { mobile: true, viewport: { width: 390, height: 844 } } : {}) });
    await page.addInitScript(PROBE);
    for (const fn of init) await page.addInitScript(fn);
    await page.goto(BASE + url, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    if (mobile) await page.click("#pathStart");
    else await page.press("#input", "Enter");
    await waitUntil(async () => (await shown(page)) >= 1, 5000);
    await page.waitForTimeout(150);
    return page;
  }
  // 今の語を打つ（wait = 出題から打ち始めるまで。出題の時刻から数えるので、この関数に来るまでの間も wait に入る。
  // via = "kbd" 物理キー／"osk" 画面キーボードのボタン。page.press は物理キーの経路）。
  // skip = 頭から飛ばす字数（ヒントが足した字）。盤面の文と、次の語か完了パネルを待つ
  async function typeCurrent(page, { wait = 0, via = "kbd", skip = 0 } = {}) {
    const id = await curId(page);
    const n = await shown(page);
    const m = await msgCount(page);
    if (wait) await page.waitForTimeout(Math.max(0, wait - (await page.evaluate(() => performance.now() - window.__shownAt))));
    const en = enOf(id);
    for (let k = skip; k < en.length; k++) {
      if (via === "osk") await page.click(`#osk .osk__key[data-key="${en[k]}"]`);
      else await page.press("#input", en[k]);
    }
    await waitUntil(async () => (await msgCount(page)) > m, 2000);
    const msg = await page.evaluate((k) => window.__msgs[k] ?? "", m);
    await waitUntil(async () => (await shown(page)) > n || (await panelOpen(page)), 4000);
    return { id, en, msg };
  }
  // 2 語目以降で「初めての答え」の語が出るまで、ほかの語は待たずに打って進める（ページの最初の語は測らない）
  async function toFirstAnswer(page, tries = 8) {
    for (let i = 0; i < tries; i++) {
      if (await panelOpen(page)) return null;
      const id = await curId(page);
      const st = await statOf(page, id);
      if ((await shown(page)) >= 2 && st && !st.lastRecallSuccessAt && !st.lastRecallFailAt) return id;
      await typeCurrent(page);
      await page.waitForTimeout(80);
    }
    return null;
  }

  // ---- 4. 初めての答えの速さ → 段と盤面の文（本人の基準 20 件／基準なしは既定の線。物理キー 1,500ms・画面キーボード 2,100ms） ----
  for (const [label, extra, waitMs, want, tail] of [
    ["(a) 本人の基準 20 件（中央値 2,000ms）・400ms", { spelldash_mastery_meta: meta20("en.kbd.study", 2000) }, 400, 4, "はもう身についている。2週間後に確認"],
    ["(b) 基準なし・400ms", {}, 400, 4, "はもう身についている。2週間後に確認"],
    ["(c) 基準なし・1,800ms", {}, 1800, 3, "は2週間後に確認"],
    ["(d) 基準なし・2,500ms", {}, 2500, 3, "は2週間後に確認"]
  ]) {
    const page = await open(seed(KEEP, extra));
    const id = await toFirstAnswer(page);
    const r = id ? await typeCurrent(page, { wait: waitMs }) : null;
    const st = id ? await statOf(page, id) : null;
    const read = id ? await rankRead(page, id) : null;
    check(`習熟度 速さ 4${label}: 段 ${want}・masteryAt は自力正解の日時と同じ・文「知ってた。X ${tail}」（「もう一度だけ」なし）`, !!r && st?.masteryRank === want && read === want && st.masteryAt === st.lastRecallSuccessAt && st.knownOnSight === true && r.msg.startsWith(`知ってた。${r.en} ${tail}`) && !r.msg.includes("もう一度だけ"), JSON.stringify({ id, rank: st?.masteryRank, read, msg: r?.msg }));
    check(`習熟度 速さ 4${label}: エラー0`, page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }
  {
    // (e) 390 mobile・基準なし・画面キーボードのボタンで 1,800ms → 4（画面キーボードの線 2,100ms）。箱は en.touch.study（物理キーの箱に入れない）
    const page = await open(seed(KEEP), { mobile: true });
    const id = await toFirstAnswer(page);
    const before = { touch: await boxLen(page, "en.touch.study"), kbd: await boxLen(page, "en.kbd.study") };
    const r = id ? await typeCurrent(page, { wait: 1800, via: "osk" }) : null;
    const st = id ? await statOf(page, id) : null;
    const after = { touch: await boxLen(page, "en.touch.study"), kbd: await boxLen(page, "en.kbd.study") };
    check("習熟度 速さ 4(e) 390・画面キーボード・1,800ms: 段 4、箱は en.touch.study（物理キーの箱は増えない）", !!r && st?.masteryRank === 4 && after.touch - before.touch === 1 && after.kbd === before.kbd && r.msg.startsWith(`知ってた。${r.en} はもう身についている。`), JSON.stringify({ id, rank: st?.masteryRank, before, after, msg: r?.msg }));
    check("習熟度 速さ 4(e): エラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // ---- 5・6. 8 日あけたノーミス正解で 3 → 4（文「習熟度 身についた」）・同じ日の × は 1 回だけ・初見の直し（出題 2 回・答えなしの語も知ってた） ----
  {
    const stats = {
      ...KEEP,
      "my-river": okStat(3, 8 * DAY, DAY, { playCount: 3, correctCount: 3, lastReviewAt: at(8 * DAY) }),
      "my-cloud": { ...B, playCount: 2, correctCount: 0, cleanCorrectStreak: 0, lastPlayed: at(DAY) }
    };
    const page = await open(seed(stats, { words: ["river", "cloud", "bread", "glass", "tiger"] }), { url: "/index.html?set=4&hintms=600000" });
    const msgs = {};
    for (let i = 0; i < 10 && !(msgs["my-river"] && msgs["my-cloud"]); i++) {
      if (await panelOpen(page)) break;
      const r = await typeCurrent(page);
      msgs[r.id] ??= r.msg;
      await page.waitForTimeout(80);
    }
    const river = await statOf(page, "my-river");
    const cloud = await statOf(page, "my-cloud");
    check("習熟度 5: 段 3・8 日前に思い出せた語をノーミスで → 4、文に「日ぶりでも思い出せた。習熟度 身についた」（「定着。」なし）", river?.masteryRank === 4 && river.masteryAt === river.lastRecallSuccessAt && (msgs["my-river"] ?? "").includes("日ぶりでも思い出せた。習熟度 身についた") && !(msgs["my-river"] ?? "").includes("定着"), JSON.stringify({ rank: river?.masteryRank, msg: msgs["my-river"] }));
    check("習熟度 6: 出題 2 回・答えなしの語をノーミスで → knownOnSight（初見の判定は出題の回数を見ない）・盤面の文「知ってた」", cloud?.knownOnSight === true && cloud.masteryRank >= 3 && (msgs["my-cloud"] ?? "").startsWith("知ってた。cloud "), JSON.stringify({ known: cloud?.knownOnSight, rank: cloud?.masteryRank, msg: msgs["my-cloud"] }));
    // 同じ日に ×（○ の後でもその日の最初の × で 1 段）→ 3、2 回目の × → 3 のまま。書くたびに rankOf === masteryRank・masteryAt は × の日時と同じ文字列
    const fails = await page.evaluate(async () => {
      const s = await import("/js/stats.js");
      const m = await import("/js/mastery.js");
      const read = () => JSON.parse(localStorage.getItem("spelldash_word_stats"))["my-river"];
      const tick = () => new Promise((r) => setTimeout(r, 0)); // 保存はマイクロタスクで 1 回にまとめて書かれる（js/storage.js）
      const out = [];
      for (let k = 0; k < 2; k++) {
        s.recordRecallFail("my-river");
        await tick();
        const st = read();
        out.push({ rank: st.masteryRank, read: m.rankOf(st), same: st.masteryAt === st.lastRecallFailAt });
      }
      return out;
    });
    check("習熟度 5: 同じ日に × → 3、2 回目の × → 3 のまま（書くたびに rankOf === masteryRank・masteryAt は × の日時）", fails.map((f) => `${f.rank}/${f.read}/${f.same}`).join() === "3/3/true,3/3/true", JSON.stringify(fails));
    check("習熟度 5・6: エラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // ---- 7. 測らない答え（音で出題）: 箱に入れない。音でない初めての答えは 1 件ずつ入る ----
  {
    const page = await open(seed(KEEP, { spelldash_audio: JSON.stringify({ mode: "auto", listenRatio: 50 }) }), { url: "/index.html?set=12&hintms=600000" });
    const rows = [];
    for (let i = 0; i < 12; i++) {
      if (await panelOpen(page)) break;
      const id = await curId(page);
      const st = await statOf(page, id);
      const first = (await shown(page)) === 1;
      const fresh = !!st && !st.lastRecallSuccessAt && !st.lastRecallFailAt;
      const listen = (await page.textContent("#japanese")).trim() === "聞いて打つ";
      const b0 = await boxLen(page);
      await typeCurrent(page, { wait: first || !fresh ? 0 : 450 });
      if (!first && fresh) rows.push({ id, listen, delta: (await boxLen(page)) - b0 });
      if (rows.some((r) => r.listen) && rows.some((r) => !r.listen)) break;
      await page.waitForTimeout(80);
    }
    const heard = rows.filter((r) => r.listen);
    const plain = rows.filter((r) => !r.listen);
    check("習熟度 7: 音で出題の語は 450ms 待ってノーミスでも箱に入れない（音でない初めての答えは 1 件ずつ入る）", heard.length >= 1 && heard.every((r) => r.delta === 0) && plain.length >= 1 && plain.every((r) => r.delta === 1), JSON.stringify(rows));
    check("習熟度 7（音で出題）: エラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }
  // ---- 7. 測らない答え（ページの最初の語・ヒント・出題後に裏に回った語）と mastery_meta を書く回数（正解の 1 打 0 回・回の終わり 1 回・変わっていない stopGame 0 回） ----
  {
    const page = await open(seed(KEEP), { url: "/index.html?set=6&hintms=300", init: [COUNT_META] });
    const res = {};
    // ページの最初の語: 450ms 待ってノーミスでも測らない
    let b0 = await boxLen(page);
    await typeCurrent(page, { wait: 450 });
    res.first = (await boxLen(page)) - b0;
    const steps = ["hint", "hidden", "measured"];
    for (let i = 0; i < 10 && steps.length; i++) {
      if (await panelOpen(page)) break;
      const id = await curId(page);
      const st = await statOf(page, id);
      if (!st || st.lastRecallSuccessAt || st.lastRecallFailAt) {
        await typeCurrent(page); // 戻ってきた語（Recall Loop）は待たずに打つ
        await page.waitForTimeout(80);
        continue;
      }
      const step = steps.shift();
      b0 = await boxLen(page);
      if (step === "hint") {
        await waitUntil(() => page.isVisible("#hintButton"), 3000);
        await page.click("#hintButton");
        await page.waitForTimeout(100);
        await typeCurrent(page, { skip: 1 }); // 頭の 1 字はヒントが足した
        res.hint = { delta: (await boxLen(page)) - b0, fail: (await statOf(page, id))?.recallFail };
      } else if (step === "hidden") {
        await hideAndShow(page); // document.hidden と visibilityState の両方を偽装して visibilitychange
        await typeCurrent(page, { wait: 450 });
        res.hidden = { delta: (await boxLen(page)) - b0, rank: (await statOf(page, id))?.masteryRank };
      } else {
        // 最後の 1 打だけの書き込みを数える（回はまだ終わらない: set=6）
        const n = await shown(page);
        const en = enOf(id);
        await page.waitForTimeout(Math.max(0, 450 - (await page.evaluate(() => performance.now() - window.__shownAt))));
        for (const ch of en.slice(0, -1)) await page.press("#input", ch);
        const w0 = await metaWrites(page);
        await page.press("#input", en.at(-1));
        await page.waitForTimeout(150);
        const oneStroke = (await metaWrites(page)) - w0;
        await waitUntil(async () => (await shown(page)) > n || (await panelOpen(page)), 4000);
        res.measured = { delta: (await boxLen(page)) - b0, oneStroke, w0 };
      }
      await page.waitForTimeout(80);
    }
    check("習熟度 7: ページの最初の語・ヒントの語・出題後に裏に回った語は箱に入れない（ヒントは ×、裏に回った初めての答えは速さが分からず 3）", res.first === 0 && res.hint?.delta === 0 && res.hint.fail === 1 && res.hidden?.delta === 0 && res.hidden.rank === 3, JSON.stringify(res));
    check("習熟度 7: 測れた初めての答えは 1 件入り、その正解の 1 打で spelldash_mastery_meta の setItem は 0 回", res.measured?.delta === 1 && res.measured.oneStroke === 0, JSON.stringify(res.measured));
    // 残りを打って完了パネル（endStudySession で 1 回書く）→ 変わっていないまま机に戻る（stopGame）では書かない
    for (let i = 0; i < 8 && !(await panelOpen(page)); i++) {
      await typeCurrent(page);
      await page.waitForTimeout(80);
    }
    await waitUntil(() => panelOpen(page), 4000);
    const atEnd = await metaWrites(page);
    await page.click("#backToPath");
    await page.waitForTimeout(300);
    const afterStop = await metaWrites(page);
    check("習熟度 7: 回の終わり（endStudySession）で mastery_meta を 1 回書き、変わっていないまま stopGame では書かない", res.measured && atEnd - res.measured.w0 === 1 && afterStop === atEnd, JSON.stringify({ w0: res.measured?.w0, atEnd, afterStop }));
    check("習熟度 7: エラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // ---- 8. Battle 型の呼び方（モジュール直呼び・引数なし。js/battleEngine.js と同じ recordCorrect → recordRecallSuccess の順） ----
  {
    const d3 = 3 * DAY;
    const stats = {
      "my-river": okStat(3, d3, -DAY), // × で −1 → 2
      "my-cloud": okStat(2, d3, -DAY), // 打ち間違いありの正解 → 2 のまま（ノーミスなら 3）
      "my-stone": okStat(4, 25 * DAY, 5 * DAY, { cleanCorrectStreak: 6 }), // 25 日あけたノーミス・速さ unknown → 4（即答にならない）
      "my-bread": okStat(0, d3, -DAY, { cleanCorrectStreak: 5, srsAdvancedOn: "2000-01-01" }), // 段の欄なし・streak 5 → 3（recordCorrect の後の streak 6 で 4 と読まない）
      "my-glass": okStat(2, d3, -DAY), // recordCorrect だけ → 次のタスクの recordRecallSuccess は控えを使わない（打ち間違いあり扱いで 2）
      "my-chair": okStat(2, d3, -DAY), // 別の id: 控えが持ち越されない（2）
      "my-horse": okStat(4, DAY + HOUR, -5 * DAY, { cleanCorrectStreak: 5 }) // 段 4・前の答え 1 日前の × → 3
    };
    const page = await newPage({ storage: seed(stats) });
    await page.goto(BASE + "/stats.html", { waitUntil: "networkidle" });
    await page.waitForTimeout(300);
    const r = await page.evaluate(async () => {
      const s = await import("/js/stats.js");
      const m = await import("/js/mastery.js");
      const tick = () => new Promise((res) => setTimeout(res, 0));
      const read = (id) => JSON.parse(localStorage.getItem("spelldash_word_stats"))[id];
      const out = {};
      const note = (id, field) => { const st = read(id); out[id.slice(3)] = { rank: st.masteryRank, read: m.rankOf(st), at: st.masteryAt === st[field] }; };
      s.recordRecallFail("my-river");
      s.recordRecallFail("my-horse");
      s.recordCorrect("my-cloud", false);
      s.recordRecallSuccess("my-cloud");
      s.recordCorrect("my-stone", true);
      s.recordRecallSuccess("my-stone");
      s.recordCorrect("my-bread", true);
      s.recordRecallSuccess("my-bread");
      s.recordCorrect("my-glass", true); // 答え表示の後の打ち直しのように recordCorrect だけ
      await tick();
      s.recordRecallSuccess("my-glass"); // 同じ id でも、前のタスクの控え（ノーミス）を使わない
      s.recordRecallSuccess("my-chair");
      await tick();
      note("my-river", "lastRecallFailAt");
      note("my-horse", "lastRecallFailAt");
      for (const id of ["my-cloud", "my-stone", "my-bread", "my-glass", "my-chair"]) note(id, "lastRecallSuccessAt");
      out.breadStreak = read("my-bread").cleanCorrectStreak;
      return out;
    });
    const same = Object.entries(r).filter(([, v]) => typeof v === "object").every(([, v]) => v.rank === v.read && v.at);
    check("習熟度 8 Battle 型: recordRecallFail で段 −1（3 → 2）・段 4・前の答え 1 日前の × → 3", r.river?.rank === 2 && r.horse?.rank === 3, JSON.stringify({ river: r.river, horse: r.horse }));
    check("習熟度 8 Battle 型: recordCorrect(id, false)＋recordRecallSuccess(id) は 2 より上げない", r.cloud?.rank === 2, JSON.stringify(r.cloud));
    check("習熟度 8 Battle 型: recordCorrect(id, true)＋recordRecallSuccess(id) は 25 日あけても即答にしない（速さ unknown）", r.stone?.rank === 4, JSON.stringify(r.stone));
    check("習熟度 8 Battle 型: 段の欄なし・streak 5・3 日前 → 3（答える前の段で決める。streak は 6 に進む）", r.bread?.rank === 3 && r.breadStreak === 6, JSON.stringify({ bread: r.bread, streak: r.breadStreak }));
    check("習熟度 8 Battle 型: recordCorrect だけ呼んだ控えは次のタスクへ持ち越さない（別の id・同じ id とも 2 のまま）", r.chair?.rank === 2 && r.glass?.rank === 2, JSON.stringify({ chair: r.chair, glass: r.glass }));
    check("習熟度 8 Battle 型: 書くたびに rankOf === masteryRank・masteryAt は書いた日時と同じ文字列", same, JSON.stringify(r));
    check("習熟度 8: エラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // ---- 9. 語数のセットの完了パネル: 段が動いた語の行（覚えたのチップの語は除く・遅い正解は「時間がかかった」）。新しい語だけの回では行が無い ----
  {
    const fail = at(DAY + HOUR);
    const stats = {
      ...KEEP,
      // 昨日思い出せなかった語（未解決・段 1）: 今日打てると「覚えた（前は出てこなかった語）」のチップ。1 → 2 でも「上がった」の行には出さない
      "my-river": { ...B, playCount: 2, correctCount: 1, missCount: 1, recallFail: 1, cleanCorrectStreak: 0, lastPlayed: fail, lastRecallFailAt: fail, nextReviewAt: fail, history: [{ d: dayOf(fail), r: "x" }], masteryRank: 1, masteryAt: fail },
      "my-cloud": okStat(2, DAY + HOUR, HOUR, { cleanCorrectStreak: 1 }), // 段 2・昨日 → 3
      "my-stone": okStat(5, 30 * DAY, 2 * DAY, { cleanCorrectStreak: 8, history: [{ d: dayOf(at(60 * DAY)), r: "o" }, { d: dayOf(at(30 * DAY)), r: "o" }] }) // 段 5・30 日前 → 遅い正解で 4
    };
    const page = await open(seed(stats, { words: ["river", "cloud", "stone", "bread", "glass", "tiger"], spelldash_mastery_meta: meta20("en.kbd.study", 2000) }), { url: "/index.html?set=3&hintms=600000" });
    const order = [];
    for (let i = 0; i < 8 && !(await panelOpen(page)); i++) {
      const id = await curId(page);
      order.push(enOf(id));
      await typeCurrent(page, { wait: id === "my-stone" && order.length > 1 ? 3500 : 0 }); // 基準 2,000ms の 1.5 倍を超える
      await page.waitForTimeout(80);
    }
    await waitUntil(() => panelOpen(page), 4000);
    const p = await page.evaluate(() => ({
      lines: [...document.querySelectorAll("#resultPanel .rank-moves")].map((e) => e.textContent.trim()),
      learned: [...document.querySelectorAll("#resultPanel .word-chip--learned")].map((e) => e.dataset.speak)
    }));
    const ranks = { river: (await statOf(page, "my-river"))?.masteryRank, cloud: (await statOf(page, "my-cloud"))?.masteryRank, stone: (await statOf(page, "my-stone"))?.masteryRank };
    check("習熟度 9 完了パネル: 段 2（昨日）の語をノーミス →「習熟度が上がった: cloud（思い出せる）」", ranks.cloud === 3 && p.lines.some((l) => l.startsWith("習熟度が上がった:") && l.includes("cloud（思い出せる）")), JSON.stringify({ order, ranks, lines: p.lines }));
    check("習熟度 9 完了パネル: 「覚えた（前は出てこなかった語）」のチップの語（1 → 2）は段の行に出さない", ranks.river === 2 && p.learned.includes("river") && !p.lines.some((l) => l.includes("river（")), JSON.stringify({ ranks, learned: p.learned, lines: p.lines }));
    check("習熟度 9 完了パネル: 段 5・30 日前の語を 2 語目以降に 3,500ms で → 4、行は「stone（身についた・時間がかかった）」", order[0] !== "stone" && ranks.stone === 4 && p.lines.some((l) => l.includes("stone（身についた・時間がかかった）")) && !p.lines.some((l) => l.includes("stone（身についた）")), JSON.stringify({ order, ranks, lines: p.lines }));
    check("習熟度 9 完了パネル: エラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }
  {
    // 新しい語だけの回: 段の行が無い・#setAgain は「もう1セット」
    const page = await open(seed(KEEP), { url: "/index.html?set=2&hintms=600000" });
    for (let i = 0; i < 6 && !(await panelOpen(page)); i++) {
      await typeCurrent(page);
      await page.waitForTimeout(80);
    }
    await waitUntil(() => panelOpen(page), 4000);
    check("習熟度 9 完了パネル: 新しい語だけの回では「習熟度が…」の行が無い・#setAgain は「もう1セット」", (await page.$$("#resultPanel .rank-moves")).length === 0 && (await page.textContent("#setAgain")).trim() === "もう1セット");
    await page.close();
  }
  {
    // 60 秒の終わりのパネル: 遅い正解で 5 → 4 の語のチップは「時間がかかった」（「下がった」と言わない）
    const fail = at(DAY + HOUR);
    const stats = {
      ...KEEP,
      "my-river": { ...B, playCount: 2, correctCount: 1, missCount: 1, recallFail: 1, cleanCorrectStreak: 0, lastPlayed: fail, lastRecallFailAt: fail, nextReviewAt: fail, history: [{ d: dayOf(fail), r: "x" }], masteryRank: 1, masteryAt: fail },
      "my-stone": okStat(5, 30 * DAY, 2 * DAY, { cleanCorrectStreak: 8, history: [{ d: dayOf(at(60 * DAY)), r: "o" }, { d: dayOf(at(30 * DAY)), r: "o" }] })
    };
    const page = await open(seed(stats, { words: ["river", "stone", "bread", "glass", "chair", "horse", "tiger"], spelldash_set_size: "60s", spelldash_mastery_meta: meta20("en.kbd.study", 2000) }), { url: "/index.html?t=10&hintms=600000" });
    const order = [];
    for (let i = 0; i < 12 && !(await panelOpen(page)); i++) {
      const id = await curId(page);
      if (order.includes("stone") && id !== "my-stone") break; // stone を答えたら、あとは時間切れを待つ
      order.push(enOf(id));
      await typeCurrent(page, { wait: id === "my-stone" && order.length > 1 ? 3500 : 0 });
      await page.waitForTimeout(80);
    }
    await waitUntil(() => panelOpen(page), 12000);
    const chip = await page.evaluate(() => document.querySelector('#resultPanel .rank-group .word-chip[data-speak="stone"]')?.textContent.replace(/\s+/g, " ").trim() ?? "");
    check("習熟度 9 60 秒の終わり: 遅い正解で 5 → 4 の語のチップは「時間がかかった」・「下がった」と言わない", order[0] !== "stone" && (await statOf(page, "my-stone"))?.masteryRank === 4 && chip.endsWith("時間がかかった") && !chip.includes("下がった"), JSON.stringify({ order, chip }));
    check("習熟度 9 60 秒の終わり: エラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // ---- 10. Challenge の結果（?t=4）: 段 3 の語を思い出せない →「習熟度が下がった: X（あやふや）」。「ベスト」と #resultRetry は残る ----
  {
    const stats = Object.fromEntries(ALL.map((en) => [`my-${en}`, okStat(3, 3 * DAY, -DAY)])); // どの語が出ても回の前は段 3
    const page = await newPage({ storage: seed(stats, { spelldash_mode: "challenge" }) });
    await page.addInitScript(PROBE);
    await page.goto(BASE + "/index.html?t=4", { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    await page.focus("#input");
    await page.keyboard.press("Enter"); // Challenge を選んでいる人の Enter は Challenge を始める
    await waitUntil(async () => (await shown(page)) >= 1, 4000);
    await page.waitForTimeout(450); // 出てから 300ms の Enter は飲まれる
    const id = await curId(page);
    await page.press("#input", "Enter"); // 答えを見る（×）
    await waitUntil(() => panelOpen(page), 8000);
    const txt = (await page.textContent("#resultPanel")).replace(/\s+/g, " ");
    const lines = await page.$$eval("#resultPanel .rank-moves", (els) => els.map((e) => e.textContent.trim()));
    const st = await statOf(page, id);
    check("習熟度 10 Challenge の結果: 思い出せなかった段 3 の語 →「習熟度が下がった: X（あやふや）」、「ベスト」と #resultRetry は残る", st?.masteryRank === 2 && lines.some((l) => l.startsWith("習熟度が下がった:") && l.includes(`${enOf(id)}（あやふや）`)) && txt.includes("ベスト") && (await page.$("#resultRetry")) !== null, JSON.stringify({ id, rank: st?.masteryRank, lines }));
    check("習熟度 10: エラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // ---- 12. 同期: 送る行は 15 列のまま（段の欄は端末だけ）・schema_version "6" ----
  {
    const cloud = createCloud({ word_progress: [], user_progress: [], user_items: [] });
    const page = await browser.newPage();
    page.errors = [];
    page.on("pageerror", (e) => page.errors.push(e.message));
    await page.addInitScript((s) => {
      if (sessionStorage.getItem("spelldash_test_seeded")) return;
      sessionStorage.setItem("spelldash_test_seeded", "1");
      localStorage.setItem("spelldash_schema_version", "6");
      localStorage.setItem("spelldash_onboarded", "1");
      for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
    }, seed({ "my-river": okStat(3, 8 * DAY, DAY) }, { spelldash_test_session: "1", spelldash_test_cloud: cloud.id, spelldash_owner: "test-user" }));
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    const pulled = await waitUntil(() => page.evaluate(() => sessionStorage.getItem("spelldash_pulled_this_session") === "test-user"), 8000);
    const local = await page.evaluate(async () => {
      const s = await import("/js/stats.js");
      s.recordCorrect("my-river", true);
      s.recordRecallSuccess("my-river", { clean: true, speed: "unknown" });
      await new Promise((r) => setTimeout(r, 0));
      return JSON.parse(localStorage.getItem("spelldash_word_stats"))["my-river"];
    });
    let row = null;
    await waitUntil(async () => {
      await page.evaluate(async () => (await import("/js/sync.js")).pushSync());
      row = cloud.rows("word_progress").find((r) => r.word_id === "my-river") ?? null;
      return !!row;
    }, 6000, 300);
    const COLS = ["user_id", "word_id", "play_count", "correct_count", "typing_miss", "recall_fail", "clean_correct_streak", "mastered", "mastered_at", "last_played", "next_review_at", "last_recall_fail_at", "last_recall_success_at", "daily_learning_date", "daily_learning_stage", "srs_advanced_on", "updated_at"];
    const keys = row ? Object.keys(row).sort() : [];
    check("習熟度 12 同期: 段を書いた語を送る行は 15 列のまま（user_id・word_id のほか。mastery の列が無い）", pulled && local?.masteryRank === 4 && !!local.masteryAt && keys.join() === [...COLS].sort().join() && !keys.some((k) => /mastery|known/.test(k)), JSON.stringify({ pulled, rank: local?.masteryRank, keys }));
    check("習熟度 12: schema_version は \"6\" のまま・エラー0", (await page.evaluate(() => localStorage.getItem("spelldash_schema_version"))) === "6" && page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // ---- 13. S6: 期日前の段 4 以上の語と確認待ちの知ってた語は補充・ミッション・息抜きに出さない（候補が足りなければ補充の最後に戻す） ----
  {
    const fresh = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
    const base = { ...B, playCount: 4, correctCount: 3, lastPlayed: at(3 * DAY), dailyLearningDate: null, dailyLearningStage: 0, srsAdvancedOn: "2000-01-01" };
    const s6 = {
      "my-held": { ...base, cleanCorrectStreak: 5, masteryRank: 4, masteryAt: at(3 * DAY), lastRecallSuccessAt: at(3 * DAY), nextReviewAt: at(-10 * DAY) },
      "my-known": { ...base, playCount: 1, correctCount: 1, cleanCorrectStreak: 1, knownOnSight: true, masteryRank: 3, masteryAt: at(4 * DAY), lastRecallSuccessAt: at(4 * DAY), nextReviewAt: at(-10 * DAY) },
      "my-famone": { ...base, cleanCorrectStreak: 1, masteryRank: 2, masteryAt: at(3 * DAY), lastRecallSuccessAt: at(3 * DAY), nextReviewAt: at(-5 * DAY) },
      "my-famtwo": { ...base, cleanCorrectStreak: 1, masteryRank: 2, masteryAt: at(3 * DAY), lastRecallSuccessAt: at(3 * DAY), nextReviewAt: at(-5 * DAY) },
      "my-rthree": { ...base, missCount: 1, recallFail: 1, cleanCorrectStreak: 3, masteryRank: 3, masteryAt: at(DAY), lastRecallFailAt: at(5 * DAY), lastRecallSuccessAt: at(DAY), nextReviewAt: at(-3 * DAY) },
      "my-rtwo": { ...base, missCount: 1, recallFail: 1, cleanCorrectStreak: 1, masteryRank: 2, masteryAt: at(DAY), lastRecallFailAt: at(5 * DAY), lastRecallSuccessAt: at(DAY), nextReviewAt: at(-3 * DAY) },
      "my-due": { ...base, cleanCorrectStreak: 5, masteryRank: 4, masteryAt: at(8 * DAY), lastRecallSuccessAt: at(8 * DAY), nextReviewAt: at(DAY) } // 段 4 でも期日が来た語は出る
    };
    const words = [["held", "保留"], ["known", "既知"], ["famone", "一"], ["famtwo", "二"], ["rthree", "三"], ["rtwo", "二つ"], ["due", "期日"], ...fresh.map((en, i) => [en, `新${i}`])].map(([en, ja]) => ({ en, ja }));
    const page = await newPage({ storage: { spelldash_category: "my", spelldash_placement: "done", spelldash_my_words: JSON.stringify(words), spelldash_word_stats: JSON.stringify(s6) } });
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    const res = await page.evaluate(async () => {
      const sq = await import("/js/studyQueue.js");
      const ms = await import("/js/mission.js");
      const runs = [];
      for (let i = 0; i < 20; i++) {
        sq.startStudyQueue("my");
        runs.push(sq.getUpcomingIds());
      }
      localStorage.removeItem("spelldash_mission");
      const mission = ms.getTodayMission();
      const breathers = [];
      for (let i = 0; i < 20; i++) {
        sq.startStudyQueue("my");
        sq.insertBreather();
        breathers.push(sq.getUpcomingIds()[0]);
      }
      return { runs, mission, breathers };
    });
    const all = res.runs.flat();
    check("習熟度 13 S6: ほかの候補があれば、段 4・期日が先の語と確認待ちの知ってた語（段 3）は補充に出ない", !all.includes("my-held") && !all.includes("my-known"), JSON.stringify(res.runs[0]));
    check("習熟度 13 S6: 段 4 でも期日が来た語は出る・段 2 の既習の語は補充に出る", res.runs.every((r) => r.includes("my-due")) && (all.includes("my-famone") || all.includes("my-famtwo")), JSON.stringify(res.runs[0]));
    check("習熟度 13 S6: ミッションの復習に段 3・期日が先（ミスあり）の語と期日前の語が入らず、段 2・ミスありの語は入る", !res.mission.review.includes("my-rthree") && !res.mission.review.includes("my-held") && !res.mission.review.includes("my-known") && res.mission.review.includes("my-rtwo"), JSON.stringify(res.mission.review));
    check("習熟度 13 S6: 息抜きに期日前の語を使わない", !res.breathers.includes("my-held") && !res.breathers.includes("my-known"), JSON.stringify(res.breathers));
    check("習熟度 13 S6（候補が多い）: エラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
    // 補充の候補が足りないとき（新しい語なし・既習 1 語）は、期日前の語も補充の最後に戻る
    const few = Object.fromEntries(["my-held", "my-known", "my-famone"].map((k) => [k, s6[k]]));
    const p2 = await newPage({ storage: { spelldash_category: "my", spelldash_placement: "done", spelldash_my_words: JSON.stringify(words.slice(0, 3)), spelldash_word_stats: JSON.stringify(few) } });
    await p2.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await p2.waitForTimeout(800);
    const ids = await p2.evaluate(async () => {
      const sq = await import("/js/studyQueue.js");
      sq.startStudyQueue("my");
      return sq.getUpcomingIds();
    });
    check("習熟度 13 S6: 候補が足りないときは期日前の語も出る（段 2 の既習の後）", ids.includes("my-held") && ids.includes("my-known") && ids.indexOf("my-famone") < ids.indexOf("my-held") && ids.indexOf("my-famone") < ids.indexOf("my-known"), JSON.stringify(ids));
    check("習熟度 13 S6（候補が少ない）: エラー0", p2.errors.length === 0, p2.errors[0] ?? "");
    await p2.close();
    // 苦手（未解決）は期日を見ずにミッションの復習に出す: 段 4・段 5 の語を Study の流れ（× → 答えを見て打ち直し）で書くと、
    // 打ち直しで期日は翌日になる（stats.js の非 clean の枝）が、苦手を毎日見直すミッションの役目は変えない
    const slip = {
      "my-slip": { ...base, missCount: 1, recallFail: 1, cleanCorrectStreak: 6, masteryRank: 4, masteryAt: at(7 * DAY), lastRecallSuccessAt: at(7 * DAY), lastRecallFailAt: at(40 * DAY), nextReviewAt: at(2 * HOUR) },
      "my-slipfive": { ...base, missCount: 1, recallFail: 1, cleanCorrectStreak: 9, masteryRank: 5, masteryAt: at(30 * DAY), lastRecallSuccessAt: at(30 * DAY), lastRecallFailAt: at(90 * DAY), nextReviewAt: at(2 * HOUR) },
      "my-rtwo": s6["my-rtwo"]
    };
    const p3 = await newPage({ storage: { spelldash_category: "my", spelldash_placement: "done", spelldash_my_words: JSON.stringify([...words, { en: "slip", ja: "滑る" }, { en: "slipfive", ja: "五" }]), spelldash_word_stats: JSON.stringify(slip) } });
    await p3.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await p3.waitForTimeout(800);
    const sr = await p3.evaluate(async () => {
      const st = await import("/js/stats.js");
      const ms = await import("/js/mission.js");
      const m = await import("/js/mastery.js");
      for (const id of ["my-slip", "my-slipfive"]) {
        st.recordRecallFail(id); // Study の答え表示（×）
        await new Promise((r) => setTimeout(r, 0));
        st.recordCorrect(id, false); // 答えを見て打ち直す
        await new Promise((r) => setTimeout(r, 0));
      }
      const stats = JSON.parse(localStorage.getItem("spelldash_word_stats"));
      localStorage.removeItem("spelldash_mission");
      const review = ms.getTodayMission().review;
      const info = ["my-slip", "my-slipfive"].map((id) => ({ id, rank: m.rankOf(stats[id]), unresolved: m.isUnresolved(stats[id]), dueAhead: Date.parse(stats[id].nextReviewAt) > Date.now() }));
      return { review, info };
    });
    check(
      "習熟度 13 S6: × の後に打ち直した苦手の語（段 3・段 4。期日は翌日）はミッションの復習に入る",
      sr.info.map((i) => [i.rank, i.unresolved, i.dueAhead].join()).join("|") === "3,true,true|4,true,true" && sr.review.includes("my-slip") && sr.review.includes("my-slipfive") && sr.review.includes("my-rtwo"),
      JSON.stringify(sr)
    );
    check("習熟度 13 S6（苦手の語）: エラー0", p3.errors.length === 0, p3.errors[0] ?? "");
    await p3.close();
  }

  // ---- §9.1-7 タイピングの 2 ページは mastery.js・masteryMeta.js を読まない ----
  for (const url of ["/typing.html", "/typing-game.html"]) {
    const page = await newPage();
    const reqs = [];
    page.on("request", (r) => reqs.push(new URL(r.url()).pathname));
    await page.goto(BASE + url, { waitUntil: "networkidle" });
    await page.waitForTimeout(300);
    check(`習熟度: ${url} は mastery.js・masteryMeta.js を読まない`, !reqs.some((p) => /\/js\/mastery(Meta)?\.js$/.test(p)) && reqs.length > 0, reqs.filter((p) => p.includes("mastery")).join(","));
    await page.close();
  }
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
  await afterAdvance(page);
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
    await afterAdvance(page);
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
  // 日本語の答えは読みをローマ字で打つ（js/romaji.js）。romaji: 読みのキー（keys = 主な読み、self = 自力で打つ読み）
  const findCard = async () => {
    const prompt = (await page.textContent("#japanese")).trim();
    return page.evaluate(async (q) => {
      const ws = await import("/js/wordStore.js");
      const r = await import("/js/romaji.js");
      const w = ws.getWordsByCategory("listing").find((x) => x.q === q);
      if (!w) return null;
      const entries = r.hasJapaneseScript(w.en) ? r.readingEntries(w) : [];
      const cands = entries.map((e) => e.reading);
      const keysOf = (reading) => r.canonicalRomaji(reading, { finalN: true });
      const primary = r.primaryReading(entries);
      const miss = [..."qxvlzjcfw"].find((k) => !r.matchRomaji(cands, k).alive) ?? "q";
      // 自力で打つ読み = 主な読み。打ち終えたら Enter なしで終わる（手前の短い読みで先に終われば、読みの続きの打鍵は 0.6 秒まで次の語に入れない（正解後の待ちをまたぐ））
      const romaji = entries.length > 0 ? { keys: keysOf(primary.reading), self: keysOf(primary.reading), miss } : null;
      return { en: w.en, accept: w.accept, explain: w.explain, free: !romaji && !/^[a-z-]+$/.test(w.en), romaji };
    }, prompt);
  };
  const pressAll = async (keys) => { for (const ch of keys) await page.press("#input", ch); };
  let card = await findCard();
  check("出題文は場面の説明（q）", !!card && (await page.textContent("#japanese")).trim().length > 12, JSON.stringify(card));
  // 1語目: 答えを見る → 解説が出る → 答えを打って練習（全文入力なら fill+Enter）
  await page.press("#input", "Enter");
  await page.waitForTimeout(200);
  check("答え表示で用語と解説が出る", (await page.textContent("#word")).replace(/\s/g, "").includes(card.en.replace(/\s/g, "")) && (await page.textContent("#wordExplain")).trim().length > 0);
  if (card.romaji) {
    await pressAll(card.romaji.keys); // 答えを見た後は、見せた読みを打って練習
  } else if (card.free) {
    await page.fill("#input", card.en);
    await page.press("#input", "Enter");
  } else {
    for (const ch of card.en) await page.press("#input", ch);
  }
  await waitUntil(async () => (await page.textContent("#score")).trim() === "1", 2000);
  check("答えを打って練習できる（score 1）", (await page.textContent("#score")).trim() === "1");
  // 答えを見た後の練習は 0.25 秒で次へ（Enter は要らない。押すと待ちの後なら次の語の答えを開く）
  await waitUntil(async () => (await findCard()) && (await findCard()).en !== card.en, 3000);
  await afterAdvance(page);
  // 2語目: 自力で答える。日本語は読みをローマ字で、英語の全文入力なら別解（accept）で、IMEの表記ゆれもOK
  card = await findCard();
  const typed = card.romaji ? card.romaji.self : card.free ? (card.accept[0] ?? card.en) : card.en;
  if (card.romaji) {
    await pressAll(typed);
  } else if (card.free) {
    await page.fill("#input", typed);
    await page.press("#input", "Enter");
  } else {
    for (const ch of typed) await page.press("#input", ch);
  }
  await waitUntil(async () => (await page.textContent("#score")).trim() === "2", 2000);
  check(`自力正解（${card.romaji ? "読みをローマ字で" : card.free ? "別解で全文入力" : "スペル入力"}）`, (await page.textContent("#score")).trim() === "2" && (await page.textContent("#recalledToday")).trim() === "1", `typed=${typed}`);
  check("正解後も用語と解説が残る（0.9 秒）", (await page.textContent("#wordExplain")).trim().length > 0);
  await page.press("#input", "Enter"); // 待たずに次へ
  await waitUntil(async () => (await findCard()) && (await findCard()).en !== card.en, 3000);
  // 3語目: 全文入力で間違える → 答え表示＋×（1ミス＝不正解と同じ扱い）
  card = await findCard();
  const before = Number((await page.textContent("#recallFail")).trim());
  if (card.romaji) {
    await page.press("#input", card.romaji.miss); // どの読みにも続かないキー = 1 ミスで不正解（英単語と同じ）
  } else if (card.free) {
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
    await page3.waitForTimeout(NEXT_READY_MS);
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
  check("単語帳: 覚えた（習得前）の語には記憶ゲージ（/10）が出ない（習熟度は 思い出せる）", (await page4.$(".mem__bar")) === null && !listText.includes("/10") && (await page4.$('.gcard .rank[data-rank="3"]')) !== null, listText.slice(0, 160));
  check("ジャンル全部覚えたら「全部済み」", listText.includes("全部済み"));
  check("ログイン案内／ゲージでエラー0", page4.errors.length === 0, page4.errors[0] ?? "");
  await page4.close();

  // 苦手（最後に思い出せなかったまま）の語: 記憶ゲージ（3/10）は外し、足元に習熟度（未解決・最後の × の前に ○ の日が 1 日 → まだ。docs/SPEC_MASTERY.md §3.6）
  const pageW = await newPage({ storage: {
    spelldash_my_words: JSON.stringify([{ en: "invoice", ja: "請求書" }]),
    spelldash_word_stats: JSON.stringify({ "my-invoice": { playCount: 4, correctCount: 3, missCount: 1, typingMiss: 0, recallFail: 1, cleanCorrectStreak: 3, mastered: false, lastPlayed: new Date(Date.now() - 86400000).toISOString(), nextReviewAt: new Date(Date.now() + 2 * 86400000).toISOString(), lastRecallFailAt: new Date(Date.now() - 86400000).toISOString(), lastRecallSuccessAt: y, history: [{ d: dayKey(3), r: "o" }, { d: dayKey(1), r: "x" }] } })
  } });
  await pageW.goto(BASE + "/list.html?category=my", { waitUntil: "networkidle" });
  await pageW.waitForTimeout(800);
  const listTextW = await pageW.textContent("#listBody");
  const rankW = await pageW.$eval(".gcard .rank", (el) => ({ rank: el.dataset.rank, aria: el.getAttribute("aria-label") })).catch(() => null);
  check("単語帳: 苦手の語に習熟度（.rank[data-rank=\"1\"]・aria-label に「まだ」）。.mem__bar と「/10」が無い", rankW?.rank === "1" && rankW.aria.includes("まだ") && (await pageW.$(".mem__bar")) === null && !listTextW.includes("/10"), `${JSON.stringify(rankW)} ${listTextW.slice(0, 160)}`);
  check("苦手ゲージでエラー0", pageW.errors.length === 0, pageW.errors[0] ?? "");
  await pageW.close();

  // 初回オンボーディングは「腕試し」導線
  const page5 = await newPage({ keepOnboarding: true });
  await page5.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await page5.waitForTimeout(800);
  // 初めての人: アプリの代わりにトップページ。1語体験 → 「スタート」で腕試しへ
  check("初回はトップページが出てアプリは隠れる", (await page5.isVisible("#welcome")) && !(await page5.isVisible("#pathCard")) && (await page5.textContent("#welcome")).includes("スタート") && (await page5.textContent("#welcome")).includes("無料"));
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
  check("スタートでトップが消え、腕試しが始まる", !(await page5.isVisible("#welcome")) && (await page5.isVisible("#pathCard")) && (await page5.evaluate(() => localStorage.getItem("spelldash_placement"))) === "started" && (await page5.evaluate(() => localStorage.getItem("spelldash_onboarded"))) === "1");
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
    await page2.waitForTimeout(NEXT_READY_MS);
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
  await afterAdvance(page6b);
  // 自力で思い出した語: 正解後に例文が出て、少し見せる（0.7 秒。Enter で即進行）
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
    await page6b.waitForTimeout(NEXT_READY_MS);
  }
  if (selfWord) {
    for (const ch of selfWord.en) await page6b.press("#input", ch);
    const typedAt = Date.now();
    await page6b.waitForTimeout(300);
    const selfJa = (await page6b.textContent("#japanese")).trim();
    check("例文: 自力正解のあとに例文が出て、少し見せてから次へ", (await page6b.textContent("#wordExample")).includes(selfWord.ex) && selfJa !== "", `${selfWord.en}: ${(await page6b.textContent("#wordExample")).slice(0, 50)}`);
    const movedOn = await waitUntil(async () => (await page6b.textContent("#japanese")).trim() !== selfJa, 1200 - (Date.now() - typedAt), 20);
    check("例文: 自力正解から 1.2 秒以内に次の語", movedOn, `${Date.now() - typedAt}ms`);
  } else {
    check("例文: 自力正解のあとに例文が出て、少し見せてから次へ（一意な語が見つからずスキップ）", true);
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
  // kanjiOnly: 問題文に読みが書いてあるカード（同音異義語・漢文の句法）。読みをローマ字で打つ方式では問えないので学習に出さない（データは残す）
  const page9b = await newPage({ storage: { spelldash_packs: JSON.stringify(["jkokugo2"]) } });
  await page9b.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await page9b.waitForTimeout(600);
  const kanjiOnly = await page9b.evaluate(async () => {
    const s = await import("/js/wordStore.js");
    const ws = s.getAllWords().filter((x) => x.category === "jkokugo2" && x.kanjiOnly);
    return {
      n: ws.length,
      leak: ws.filter((w) => (w.accept ?? []).some((a) => /^[ぁ-ゖー]+$/.test(a))).length,
      inCategory: s.getWordsByCategory("jkokugo2").filter((x) => x.kanjiOnly).length,
      findable: ws.every((w) => s.findWord(w.id) === w)
    };
  });
  check("kanjiOnly カード: 同音異義語10枚はデータに残り（読みの別解なし）、出題の一覧には入らない", kanjiOnly.n === 10 && kanjiOnly.leak === 0 && kanjiOnly.inCategory === 0 && kanjiOnly.findable, JSON.stringify(kanjiOnly));
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
  await waitUntil(async () => (await pageK.textContent("#japanese")).trim() !== jaK, 2000); // 自力正解のあとは例文を少し見せる（0.7 秒）
  await afterAdvance(pageK);
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
  check("道: 全ユニット済みで「次のセクションへ」", (await page9e.$("#pathNext")) !== null && (await page9e.textContent("#pathCard")).includes("全11章 済み") && (await page9e.$$(".path__node--done")).length === 3);
  // 全ユニット済みでも済みは「済み 9ユニット」＋直前の 2 つに畳まれ、goal は畳みと済み 2 つの直後（最初の画面内）
  const nextNode = await page9e.evaluate(() => {
    const fold = document.querySelector(".path__node--fold");
    const next = document.getElementById("pathNext");
    const doneOpen = [...document.querySelectorAll(".path__node--done:not(.path__node--fold)")];
    return { fold: fold?.textContent ?? "", nextTop: next?.getBoundingClientRect().top ?? -1, foldTop: fold?.getBoundingClientRect().top ?? -1, lastDoneTop: doneOpen.at(-1)?.getBoundingClientRect().top ?? -1, open: doneOpen.length, inner: window.innerHeight, label: next?.closest(".path__node")?.textContent ?? "", inNow: !!next && !!document.getElementById("pathNow")?.contains(next) };
  });
  // 節目は右頁（#pathNow）に出る（目次より上。順序の制約は無い）
  check("道: 全章済みの済みは「済み 9章」＋2 つに畳まれ、「次の巻へ」は右頁にあって最初の画面内", nextNode.fold.includes("済み 9章") && nextNode.open === 2 && nextNode.inNow && nextNode.nextTop >= 0 && nextNode.nextTop < nextNode.inner, JSON.stringify(nextNode));
  check("道: 全ユニット済みの goal は「次は「中学英語 2年」」だけ（「このセクション 全ユニット済み」は言わない）", nextNode.label.includes("次は「中学英語 2年") && !nextNode.label.includes("全ユニット済み"), nextNode.label);
  await page9e.click("#pathNext");
  await page9e.waitForTimeout(1200);
  const advanced = await page9e.evaluate(() => ({ cat: localStorage.getItem("spelldash_category"), packs: JSON.parse(localStorage.getItem("spelldash_packs") || "[]") }));
  check("道: 次のセクション（中学英語2年）が追加されてカテゴリになる", advanced.cat === "jhs-english2" && advanced.packs.includes("jhs-english2"), JSON.stringify(advanced));
  check("道: 柱が第2巻／全8巻に", (await page9e.textContent("#pathHead")).includes("第2巻／全8巻") && (await page9e.$("#pathStart")) !== null);
  // 済みユニットのタップで復習が始まる（その道の語だけ）
  const page9f = await newPage({ storage: { spelldash_course: "jhs-redo", spelldash_packs: JSON.stringify(["jhs-english1"]), spelldash_category: "jhs-english1", spelldash_word_stats: JSON.stringify(Object.fromEntries(jhs1.filter((w) => w.tags[0] === jhs1[0].tags[0]).map((w) => [w.id, { playCount: 1, knownOnSight: true, recallFail: 0 }]))), spelldash_placement: "done" } });
  await page9f.goto(BASE + "/index.html?set=3", { waitUntil: "networkidle" });
  await page9f.waitForTimeout(900);
  check("道: 1章済み・2つ目が現在地", (await page9f.$$(".path__node--done")).length === 1 && (await page9f.textContent("#pathCard")).includes("第2章／全11章"));
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

// ===== Batch 58: 入力完了から次の問題まで（待ちの表・守り・二重進行・ローマ字の続き・節目・メモ・記録・音声） =====
// 時間は最後の打鍵をページの中で送り、次の出題文に変わるまでをページの中で測る（CDP の往復を数えない）。
// 上限は実測の 2 倍以上（CI の揺れで落とさない）。待ちの中を見る検査は待ちの半分以下の時刻で見る
console.log("after correct（入力完了から次の問題まで）:");
{
  const todayA = ymd(new Date());
  const bizA = JSON.parse(fs.readFileSync(path.join(ROOT, "data/english/business.json"), "utf8")).words;
  const packA = (pack) => JSON.parse(fs.readFileSync(path.join(ROOT, `data/packs/${pack}.json`), "utf8")).words;
  const keysOfA = (w) => canonicalRomaji(primaryReading(readingEntries(w)).reading, { finalN: true }); // 語末の ん は n 1 つ
  const jaOf = async (p) => (await p.textContent("#japanese")).trim();
  const wordOf = async (p) => (await p.textContent("#word")).trim();
  const numOf = async (p, sel) => Number((await p.textContent(sel)).trim()) || 0;
  const revealedEn = (s) => /^[a-z-]+$/.test(s); // #word に英字の答えが出ている
  // 出題文から答えの一意な英単語（英字だけ）を引く
  const bizAnswer = (ja) => {
    const c = bizA.filter((w) => w.ja === ja || w.ja.split("・").includes(ja));
    return new Set(c.map((w) => w.en)).size === 1 && /^[a-z]+$/.test(c[0].en) ? c[0] : null;
  };
  const firstLetterOf = Object.fromEntries(bizA.flatMap((w) => [w.ja, ...w.ja.split("・")].map((ja) => [ja, bizAnswer(ja)?.en[0] ?? null])).filter(([, k]) => k));
  const bizSeed = (extra = {}) => ({
    spelldash_category: "business", spelldash_placement: "done", spelldash_level_boost: "2",
    spelldash_audio: JSON.stringify({ mode: "off" }), spelldash_streak: JSON.stringify({ current: 1, best: 1, last: todayA }), ...extra
  });
  const resumeA = (pack, ids, extra = {}) => ({
    spelldash_packs: JSON.stringify([pack]), spelldash_category: pack, spelldash_placement: "done", spelldash_level_boost: "2",
    spelldash_streak: JSON.stringify({ current: 1, best: 1, last: todayA }),
    spelldash_session: JSON.stringify({ category: pack, focus: "", queue: ids, recalled: [], failed: [], newCount: 0, reviewCount: 0, setSize: 20, date: todayA, savedAt: new Date().toISOString() }),
    ...extra
  });
  const myWordsA = JSON.stringify([{ en: "invoice", ja: "請求書" }, { en: "negotiate", ja: "交渉する" }, { en: "budget", ja: "予算" }]);
  // 次の語の数（spelldash:word）と、読み上げた文（unlockSpeech の空白は数えない）
  const PROBE58 = () => {
    window.__a58 = { words: 0, ids: [], speak: [] };
    addEventListener("spelldash:word", (e) => { window.__a58.words++; window.__a58.ids.push(e.detail?.id ?? null); });
    const S = window.speechSynthesis;
    if (S) {
      const orig = S.speak.bind(S);
      S.speak = (u) => { if (String(u.text).trim()) window.__a58.speak.push({ text: u.text, id: window.__a58.ids.at(-1) ?? null }); try { orig(u); } catch { /* 音の出ない環境 */ } };
    }
  };
  async function openPlay(storage, { url = "/index.html?set=25&hintms=600000", mobile = false, viewport } = {}) {
    const p = await newPage({ storage, ...(mobile ? { mobile: true, viewport: { width: 390, height: 844 } } : viewport ? { viewport } : {}) });
    await p.addInitScript(PROBE58);
    await p.goto(BASE + url, { waitUntil: "networkidle" });
    await p.waitForTimeout(700);
    if (mobile) await p.tap("#pathStart");
    else await p.press("#input", "Enter");
    await waitUntil(async () => (await jaOf(p)) !== "" && (await p.evaluate(() => document.body.classList.contains("home--playing"))), 5000);
    await p.waitForTimeout(400);
    return p;
  }
  // 答えの一意な英単語が出るまで、答えを見て練習で通す（答えを見た後は 0.25 秒で次へ → 守りの後まで待つ）
  async function findSelf(p, tries = 10) {
    for (let i = 0; i < tries; i++) {
      const ja = await jaOf(p);
      const w = bizAnswer(ja);
      if (w) return { ja, w };
      await p.press("#input", "Enter"); // 答え表示
      await waitUntil(async () => revealedEn((await wordOf(p)).replace(/\s+/g, "")), 1500, 20);
      const shown = (await wordOf(p)).replace(/\s+/g, "");
      if (revealedEn(shown)) for (const ch of shown) await p.press("#input", ch);
      else await p.press("#input", "Enter");
      await waitUntil(async () => (await jaOf(p)) !== ja, 2000, 20);
      await afterAdvance(p);
    }
    return null;
  }
  // 最後の 1 打をページの中で送る。keys: [{ at, key }]（最後の打鍵からの ms）、afterChange: 次の出題文に変わってからの [{ at, key }]（key "@first" = 次の語の頭文字）。
  // via "osk" なら画面キーボードのボタンに pointerdown。戻り値: ms（次の出題文まで）・probe（probeMs の時点）・after（変わって afterMs 後）・words（spelldash:word の数）
  const finishTimed = (p, key, opts = {}) => p.evaluate(({ key, probeMs, afterMs, keys, afterChange, settle, timeout, via, firstLetterOf }) => new Promise((resolve) => {
    const input = document.getElementById("input");
    const ja = document.getElementById("japanese");
    const ja0 = ja.textContent.trim();
    const send = (k) => {
      if (via === "osk") {
        const btn = document.querySelector(k === "Enter" ? '#osk [data-action="enter"]' : `#osk [data-key="${k}"]`);
        btn?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "touch" }));
      } else input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    };
    const snap = () => ({
      same: ja.textContent.trim() === ja0,
      ja: ja.textContent.trim(),
      word: document.getElementById("word").textContent.trim(),
      example: document.getElementById("wordExample").textContent.trim(),
      explain: document.getElementById("wordExplain").textContent.trim(),
      message: document.getElementById("message").classList.contains("message--stale") ? "" : document.getElementById("message").textContent.trim(),
      stale: document.getElementById("message").classList.contains("message--stale") ? document.getElementById("message").textContent.trim() : "",
      input: input.value,
      preview: document.getElementById("typedPreview")?.textContent.trim() ?? "",
      coach: document.querySelector(".coach:not(.coach--out)")?.getAttribute("data-step") ?? null,
      stamp: !!document.querySelector(".learn-stamp"),
      miss: document.getElementById("miss").textContent.trim(),
      recallFail: document.getElementById("recallFail").textContent.trim()
    });
    const words0 = window.__a58.words;
    let probe = null;
    let after = null;
    let ms = null;
    let done = false;
    const finish = () => { if (done) return; done = true; mo.disconnect(); resolve({ ms, probe, after, words: window.__a58.words - words0, end: snap() }); };
    const lastAt = Math.max(0, probeMs ?? 0, ...keys.map((k) => k.at));
    const mo = new MutationObserver(() => {
      if (ms !== null || ja.textContent.trim() === ja0) return;
      ms = Math.round(performance.now() - t0);
      const next = ja.textContent.trim();
      for (const a of afterChange) setTimeout(() => send(a.key === "@first" ? firstLetterOf[next] ?? "q" : a.key), a.at);
      const tail = Math.max(settle, afterMs ?? 0, ...afterChange.map((a) => a.at + 30));
      if (afterMs != null) setTimeout(() => (after = snap()), afterMs);
      setTimeout(() => { if (performance.now() - t0 >= lastAt) finish(); }, tail + 10);
    });
    mo.observe(ja, { childList: true, characterData: true, subtree: true });
    const t0 = performance.now();
    send(key);
    if (probeMs != null) setTimeout(() => (probe = snap()), probeMs);
    for (const k of keys) setTimeout(() => send(k.key), k.at);
    setTimeout(finish, timeout);
  }), { key, probeMs: null, afterMs: null, keys: [], afterChange: [], settle: 50, timeout: 4000, via: "key", firstLetterOf, ...opts });
  const typeAllButLast = async (p, keys) => { for (const ch of [...keys].slice(0, -1)) await p.press("#input", ch); };
  // 最後の 1 打を入力欄へ直に送る（焦点がメモ欄にあっても届く。待ちの短い語で、打ち終えた後のクリックが間に合わない端末のため）
  const finishWord = (p, key) => p.evaluate((k) => document.getElementById("input").dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })), key);

  // ---- W1: 待ちの表（node で全組み合わせ） ----
  {
    const bad = [];
    for (const pace of ["quick", "standard", "long", undefined, "bogus"]) {
      for (const concept of [false, true]) for (const withExample of [false, true]) for (const revealed of [false, true]) for (const placement of [false, true]) {
        const feedback = revealed || placement || (!concept && !withExample);
        const p = pace === "quick" || pace === "long" ? pace : "standard";
        const want = feedback ? { ms: 250, glance: false } : { ms: { quick: { e: 250, c: 250 }, standard: { e: 700, c: 900 }, long: { e: 2200, c: 2600 } }[p][concept ? "c" : "e"], glance: p !== "quick" };
        const got = waitAfterCorrect({ concept, withExample, revealed, placement, ...(pace === undefined ? {} : { pace }) });
        if (got.ms !== want.ms || got.glance !== want.glance) bad.push(`${pace}/${concept}/${withExample}/${revealed}/${placement}: ${JSON.stringify(got)}`);
      }
    }
    check("正解のあと: 待ちの表（すぐ次へ 250・少し見せる 700／900・長く 2,200／2,600、答えを見た後と腕試しは 250）", bad.length === 0 && MILESTONE_MS === 1400 && ADVANCE_GUARD_MS === 300 && GLANCE_MS.standard.example === 700, bad.slice(0, 3).join(" | "));
  }

  // ---- S1: 例文の無い語（マイ単語帳）の自力正解は手応えだけ（0.25 秒）で次へ ----
  {
    const p = await openPlay({ spelldash_category: "my", spelldash_placement: "done", spelldash_my_words: myWordsA, spelldash_audio: JSON.stringify({ mode: "off" }) }, { url: "/index.html?set=3&hintms=600000" });
    const ans = { 請求書: "invoice", 交渉する: "negotiate", 予算: "budget" }[await jaOf(p)];
    await typeAllButLast(p, ans ?? "");
    const r = await finishTimed(p, ans?.at(-1) ?? "q");
    check("正解のあと: 例文の無い語の自力正解から 0.7 秒以内に次の語", !!ans && r.ms !== null && r.ms >= 200 && r.ms <= 700, `${ans} ${r.ms}ms`);
    check("正解のあと（例文の無い語）でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // ---- W2・G1・G2・G4・G5・G6・待ちの間の打鍵（ビジネス英単語・例文つき・既定） ----
  {
    const p = await openPlay(bizSeed());
    // W2: 例文つきの語は答えと例文を見せて 0.7 秒で次へ
    let f = await findSelf(p);
    if (f) {
      await typeAllButLast(p, f.w.en);
      const r = await finishTimed(p, f.w.en.at(-1), { probeMs: 300 });
      check("正解のあと（標準）: 例文つきの語は答えと例文を見せて 0.7 秒で次へ", r.probe?.same && r.probe.example.includes(f.w.ex) && r.probe.word.includes(f.w.en) && r.ms !== null && r.ms >= 600 && r.ms <= 1500, `${f.w.en} ${r.ms}ms ex=${r.probe?.example.slice(0, 30)}`);
      await afterAdvance(p);
    } else check("正解のあと（標準）: 例文つきの語（一意な語が見つからない）", false);

    // 待ちの間の打鍵: 文字・Space・Backspace・Esc は飲む（ミスにも答え表示にもしない）。次の語に持ち越さない
    f = await findSelf(p);
    if (f) {
      await typeAllButLast(p, f.w.en);
      const miss0 = await numOf(p, "#miss");
      const rf0 = await numOf(p, "#recallFail");
      const r = await finishTimed(p, f.w.en.at(-1), { keys: [{ at: 60, key: "a" }, { at: 90, key: " " }, { at: 120, key: "Backspace" }, { at: 150, key: "Escape" }, { at: 180, key: "z" }], probeMs: 250, afterMs: 60 });
      check("待ちの間の文字・Space・Backspace・Esc は次の語のミスにしない（進まない・答えを開かない）", r.probe?.same && r.ms !== null && r.ms >= 600 && Number(r.end.miss) === miss0 && Number(r.end.recallFail) === rf0 && r.after?.input === "" && r.after?.preview === "" && r.words === 1, JSON.stringify({ ms: r.ms, miss: `${miss0}→${r.end.miss}`, rf: `${rf0}→${r.end.recallFail}`, input: r.after?.input, preview: r.after?.preview, words: r.words }));
      await afterAdvance(p);
    } else check("待ちの間の打鍵（一意な語が見つからない）", false);

    // 進むキー: 待ちの間の Enter で即次へ
    f = await findSelf(p);
    if (f) {
      await typeAllButLast(p, f.w.en);
      const r = await finishTimed(p, f.w.en.at(-1), { keys: [{ at: 100, key: "Enter" }] });
      check("待ちの間の Enter で即次へ（0.3 秒以内）", r.ms !== null && r.ms <= 300 && r.words === 1 && !revealedEn(r.end.word), `${r.ms}ms word=${r.end.word}`);
      await afterAdvance(p);
    }

    // G1・G2: 待ちが終わった直後の Enter は答えを開かない。0.4 秒あけた Enter は開く
    f = await findSelf(p);
    if (f) {
      await typeAllButLast(p, f.w.en);
      const rf0 = await numOf(p, "#recallFail");
      const r = await finishTimed(p, f.w.en.at(-1), { afterChange: [{ at: 30, key: "Enter" }], settle: 150 });
      check("待ちが終わった直後の Enter は次の語の答えを開かない（思い出せず が増えない）", r.ms !== null && !revealedEn(r.end.word) && Number(r.end.recallFail) === rf0, `${r.ms}ms word=${r.end.word} rf ${rf0}→${r.end.recallFail}`);
      await p.waitForTimeout(600); // 次の語が出て 0.3 秒・打ち終えて 1.2 秒（タイマーで進んだときの守り）の外
      await p.press("#input", "Enter");
      await waitUntil(async () => revealedEn(await wordOf(p)), 1000, 20);
      check("次の語が出て 0.6 秒あけた Enter は答えを開く（打ち終えて 1.2 秒の守りの外）", revealedEn(await wordOf(p)) && (await numOf(p, "#recallFail")) === rf0 + 1, `word=${await wordOf(p)} rf=${await numOf(p, "#recallFail")}`);
      const ja = await jaOf(p);
      for (const ch of (await wordOf(p)).replace(/\s+/g, "")) await p.press("#input", ch);
      await waitUntil(async () => (await jaOf(p)) !== ja, 2000, 20);
      await afterAdvance(p);
    } else check("待ちが終わった直後の Enter（一意な語が見つからない）", false);

    // G4: 待ちの間に Enter を 2 回続けても 1 語だけ進む（2 回目は守りが飲む）
    f = await findSelf(p);
    if (f) {
      await typeAllButLast(p, f.w.en);
      const rf0 = await numOf(p, "#recallFail");
      const r = await finishTimed(p, f.w.en.at(-1), { keys: [{ at: 100, key: "Enter" }, { at: 130, key: "Enter" }], settle: 300 });
      check("待ちの間に Enter を 2 回続けても 1 語だけ進む", r.words === 1 && !revealedEn(r.end.word) && Number(r.end.recallFail) === rf0, `words=${r.words} word=${r.end.word} rf ${rf0}→${r.end.recallFail}`);
      await afterAdvance(p);
    }

    // G5: タイマー（0.7 秒）と Enter が重なっても 1 語だけ進む
    const raced = [];
    for (const at of [690, 700, 710]) {
      f = await findSelf(p);
      if (!f) break;
      await typeAllButLast(p, f.w.en);
      const rf0 = await numOf(p, "#recallFail");
      const r = await finishTimed(p, f.w.en.at(-1), { keys: [{ at, key: "Enter" }], settle: 1500 - at, timeout: 2500 });
      raced.push({ at, words: r.words, ok: r.words === 1 && !revealedEn(r.end.word) && Number(r.end.recallFail) === rf0 });
      await afterAdvance(p);
    }
    check("タイマーと Enter が重なっても 1 語だけ進む（0.69・0.70・0.71 秒の Enter）", raced.length === 3 && raced.every((x) => x.ok), JSON.stringify(raced));

    // G6: 1 打でも打った語の Enter は守りに飲まれない（次の語が出た直後に頭文字 → Enter で答え表示に届く）
    f = await findSelf(p);
    if (f) {
      await typeAllButLast(p, f.w.en);
      const rf0 = await numOf(p, "#recallFail");
      const r = await finishTimed(p, f.w.en.at(-1), { afterChange: [{ at: 20, key: "@first" }, { at: 60, key: "Enter" }], settle: 200 });
      check("1 打でも打った語の Enter は守りに飲まれない（答え表示に届く）", r.ms !== null && revealedEn(r.end.word) && Number(r.end.recallFail) === rf0 + 1, `word=${r.end.word} rf ${rf0}→${r.end.recallFail}`);
    }
    check("正解のあと（守り・二重進行）でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // ---- G3: 画面キーボード（指の端末）: 待ちが終わった直後の Enter キーも答えを開かない ----
  {
    const p = await openPlay(bizSeed(), { mobile: true });
    const f = await findSelf(p);
    if (f) {
      for (const ch of f.w.en.slice(0, -1)) await p.tap(`#osk [data-key="${ch}"]`);
      const rf0 = await numOf(p, "#recallFail");
      const r = await finishTimed(p, f.w.en.at(-1), { via: "osk", afterChange: [{ at: 30, key: "Enter" }], settle: 150 });
      check("画面キーボード: 待ちが終わった直後の Enter キーも次の語の答えを開かない", (await p.isVisible("#osk")) && r.ms !== null && r.ms <= 1500 && !revealedEn(r.end.word) && Number(r.end.recallFail) === rf0, `${r.ms}ms word=${r.end.word} rf ${rf0}→${r.end.recallFail}`);
      await afterAdvance(p);
      const g = await findSelf(p);
      if (g) {
        for (const ch of g.w.en.slice(0, -1)) await p.tap(`#osk [data-key="${ch}"]`);
        const r2 = await finishTimed(p, g.w.en.at(-1), { via: "osk", keys: [{ at: 100, key: "Enter" }, { at: 130, key: "Enter" }], settle: 250 });
        check("画面キーボード: 待ちの間の Enter キーで即次へ・連打でも 1 語だけ", r2.ms !== null && r2.ms <= 300 && r2.words === 1 && !revealedEn(r2.end.word), `${r2.ms}ms words=${r2.words}`);
      }
    } else check("画面キーボード: 待ちが終わった直後の Enter（一意な語が見つからない）", false);
    check("正解のあと（画面キーボード）でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // ---- W3・W4・K1: 概念カード（中学歴史・ローマ字） ----
  {
    const J = Object.fromEntries(packA("jhist1").map((w) => [w.id, w]));
    const ids = ["concept-jh1-yoritomo", "concept-jh1-shinran", "concept-jh1-kenzuishi"];
    const p = await openPlay(resumeA("jhist1", ids), { url: "/index.html?hintms=600000" });
    const w1 = J[ids[0]];
    const k1 = keysOfA(w1);
    check("概念カードの準備: 源頼朝が先頭", (await jaOf(p)) === w1.q, await jaOf(p));
    await typeAllButLast(p, k1);
    const r1 = await finishTimed(p, k1.at(-1), { probeMs: 400 });
    check("正解のあと（標準）: 概念カードは答えと解説を見せて 0.9 秒で次へ", r1.probe?.same && r1.probe.explain.length > 0 && r1.probe.word.includes(w1.answer) && r1.ms !== null && r1.ms >= 800 && r1.ms <= 1900, `${r1.ms}ms explain=${r1.probe?.explain.slice(0, 20)}`);
    await afterAdvance(p);
    // W4＋K1: 親鸞は答えを見る → 読みを n 1 つで打ち終える（0.25 秒で次へ）→ 次の語が出てから 2 つ目の n（前の語の続き）
    const w2 = J[ids[1]];
    const k2 = keysOfA(w2);
    await p.press("#input", "Enter"); // 答えを見る
    await waitUntil(async () => (await wordOf(p)).includes(w2.answer), 1500, 20);
    await p.waitForTimeout(100);
    const miss0 = await numOf(p, "#miss");
    const rf0 = await numOf(p, "#recallFail");
    await typeAllButLast(p, k2);
    const r2 = await finishTimed(p, k2.at(-1), { afterChange: [{ at: 50, key: "n" }], afterMs: 150 });
    check("正解のあと: 答えを見た概念カードは 0.25 秒で次へ（0.6 秒以内）", r2.ms !== null && r2.ms <= 600, `${k2} ${r2.ms}ms`);
    check("ローマ字: 答えを見た語（待ち 0.25 秒）のあと、語末の n の続きは次の語のミスにしない", k2.endsWith("n") && r2.ms !== null && Number(r2.end.miss) === miss0 && Number(r2.end.recallFail) === rf0 && r2.after?.preview === "" && r2.after?.ja === J[ids[2]].q, JSON.stringify({ miss: `${miss0}→${r2.end.miss}`, rf: `${rf0}→${r2.end.recallFail}`, preview: r2.after?.preview }));
    // 続く遣隋使は 1 打目から自力で正解できる
    await afterAdvance(p);
    for (const ch of keysOfA(J[ids[2]])) await p.press("#input", ch);
    await waitUntil(async () => (await numOf(p, "#score")) === 3, 2000, 20);
    check("ローマ字: 続く語は 1 打目から自力で正解できる", (await numOf(p, "#score")) === 3 && (await numOf(p, "#recallFail")) === rf0 && (await numOf(p, "#miss")) === miss0, `score=${await numOf(p, "#score")}`);
    check("正解のあと（概念カード）でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // ---- K2: 待ち 0.25 秒のあと、続きの窓（最後の打鍵から 0.6 秒）の中の n は、次の語の頭（鑑真 gannjin → 日米和親条約 ni…）と同じでも前の語の続き ----
  // （思い出して打つ語の 1 打目は次の語が出て 0.35 秒以内には来ない。ゆっくり打つ人の 2 つ目の n は来る）
  {
    const J = Object.fromEntries(packA("jhist1").map((w) => [w.id, w]));
    const ids = ["concept-jh1-ganjin", "concept-jh1-washinjoyaku", "concept-jh1-yoritomo"];
    const p = await openPlay(resumeA("jhist1", ids), { url: "/index.html?hintms=600000" });
    const [w1, w2] = ids.map((id) => J[id]);
    check("ローマ字の準備（続きと次の語の頭）: 鑑真が先頭", (await jaOf(p)) === w1.q, await jaOf(p));
    await p.press("#input", "Enter"); // 答えを見る（練習は 0.25 秒で次へ）
    await waitUntil(async () => (await wordOf(p)).includes(w1.answer), 1500, 20);
    await p.waitForTimeout(100);
    const miss0 = await numOf(p, "#miss");
    const rf0 = await numOf(p, "#recallFail");
    const k1 = keysOfA(w1);
    await typeAllButLast(p, k1);
    const r = await finishTimed(p, k1.at(-1), { keys: [{ at: 500, key: "n" }], afterChange: [{ at: 700, key: "n" }, { at: 790, key: "i" }], afterMs: 870 });
    check("ローマ字: 待ち 0.25 秒のあと、最後の打鍵から 0.5 秒の n（次の語が出た後）は前の語の続き。次の語は 1 打目から打てる（ミス・思い出せず 同じ）", k1.endsWith("n") && keysOfA(w2).startsWith("ni") && r.ms !== null && r.ms <= 450 && r.after?.ja === w2.q && Number(r.after.miss) === miss0 && Number(r.after.recallFail) === rf0 && r.after.preview.endsWith("ni"), JSON.stringify({ ms: r.ms, miss: `${miss0}→${r.after?.miss}`, rf: `${rf0}→${r.after?.recallFail}`, preview: r.after?.preview }));
    check("ローマ字（続きと次の語の頭）でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // ---- K3: 次の語が出た直後の打鍵は、次の語の頭と同じでも前の語の続き（親鸞 shinran の 2 つ目の n → 日米和親条約） ----
  {
    const J = Object.fromEntries(packA("jhist1").map((w) => [w.id, w]));
    const ids = ["concept-jh1-shinran", "concept-jh1-washinjoyaku", "concept-jh1-yoritomo"];
    const p = await openPlay(resumeA("jhist1", ids), { url: "/index.html?hintms=600000" });
    const [w1, w2] = ids.map((id) => J[id]);
    check("ローマ字の準備（反応より早い続き）: 親鸞が先頭", (await jaOf(p)) === w1.q, await jaOf(p));
    await p.press("#input", "Enter"); // 答えを見る（練習は 0.25 秒で次へ）
    await waitUntil(async () => (await wordOf(p)).includes(w1.answer), 1500, 20);
    await p.waitForTimeout(100);
    const miss0 = await numOf(p, "#miss");
    const rf0 = await numOf(p, "#recallFail");
    const k1 = keysOfA(w1);
    await typeAllButLast(p, k1);
    const r = await finishTimed(p, k1.at(-1), { afterChange: [{ at: 50, key: "n" }, { at: 450, key: "n" }, { at: 540, key: "i" }], afterMs: 620 });
    check("ローマ字: 次の語が出た直後の n は前の語の続き（次の語は 1 打目から打てる。ミス・思い出せず 同じ）", k1.endsWith("n") && r.ms !== null && r.after?.ja === w2.q && Number(r.after.miss) === miss0 && Number(r.after.recallFail) === rf0 && r.after.preview.endsWith("ni"), JSON.stringify({ ms: r.ms, miss: `${miss0}→${r.after?.miss}`, rf: `${rf0}→${r.after?.recallFail}`, preview: r.after?.preview }));
    check("ローマ字（反応より早い続き）でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // ---- K4（K0-1 の見直し）: 続きとして飲んだ n が実は次の語の頭だった（親鸞 shinran を n 1 つで終え、すぐ日米和親条約を nichi… と打つ）:
  // n は前の語の続き（2 つ目の n）として飲むが、次の i が 日米和親条約 に続かず n＋i なら続くので、n を次の語に戻す（ミス・思い出せず 同じ） ----
  {
    const J = Object.fromEntries(packA("jhist1").map((w) => [w.id, w]));
    const ids = ["concept-jh1-shinran", "concept-jh1-washinjoyaku", "concept-jh1-yoritomo"];
    const p = await openPlay(resumeA("jhist1", ids), { url: "/index.html?hintms=600000" });
    const [w1, w2] = ids.map((id) => J[id]);
    check("ローマ字の準備（飲んだ n を戻す）: 親鸞が先頭", (await jaOf(p)) === w1.q, await jaOf(p));
    await p.press("#input", "Enter"); // 答えを見る（練習は 0.25 秒で次へ）
    await waitUntil(async () => (await wordOf(p)).includes(w1.answer), 1500, 20);
    await p.waitForTimeout(100);
    const miss0 = await numOf(p, "#miss");
    const rf0 = await numOf(p, "#recallFail");
    const k1 = keysOfA(w1);
    await typeAllButLast(p, k1);
    const r = await finishTimed(p, k1.at(-1), { afterChange: [{ at: 50, key: "n" }, { at: 140, key: "i" }], afterMs: 230 });
    check("ローマ字: 次の語が出た直後の n を前の語の続きとして飲んでも、次の i で次の語の頭だったと分かれば戻す（に・ミス・思い出せず 同じ）", k1.endsWith("n") && keysOfA(w2).startsWith("ni") && r.ms !== null && r.after?.ja === w2.q && Number(r.after.miss) === miss0 && Number(r.after.recallFail) === rf0 && r.after.preview.endsWith("ni"), JSON.stringify({ ms: r.ms, miss: `${miss0}→${r.after?.miss}`, rf: `${rf0}→${r.after?.recallFail}`, preview: r.after?.preview }));
    check("ローマ字（飲んだ n を戻す）でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // ---- K5（REVIEW-149 の 2）: 語末の ん を nn で終える人（親鸞 shinran の 2 つ目の n）でも、次の語を出す時刻は n 1 つで終えた人と同じ ----
  // 2 つ目の n は待ちの最初の 0.25 秒に来る 1 打の続き。本来の待ちの終わり（答えを見た語は 0.25 秒）を変えない（以前は 2 つ目の n から待ちを数え直し、100〜200ms 遅れていた）。
  // 時刻は負荷で揺れる（別の E2E・再現スクリプトと同時に流すと、単 n と nn の差が 100〜400ms 出た回がある。単独なら ±20ms）。落ちたら単独で流し直して確かめる
  {
    const J = Object.fromEntries(packA("jhist1").map((w) => [w.id, w]));
    const ids = ["concept-jh1-ganjin", "concept-jh1-shinran", "concept-jh1-yoritomo"];
    const p = await openPlay(resumeA("jhist1", ids), { url: "/index.html?hintms=600000" });
    const [w1, w2] = ids.map((id) => J[id]);
    check("ローマ字の準備（nn のテンポ）: 鑑真が先頭", (await jaOf(p)) === w1.q, await jaOf(p));
    // 基準: 鑑真を答えを見て n 1 つで終える → 0.25 秒で次へ
    await p.press("#input", "Enter");
    await waitUntil(async () => (await wordOf(p)).includes(w1.answer), 1500, 20);
    await p.waitForTimeout(100);
    const k1 = keysOfA(w1);
    await typeAllButLast(p, k1);
    const r1 = await finishTimed(p, k1.at(-1));
    await afterAdvance(p);
    // 親鸞を答えを見て nn で終える（2 つ目の n は最後の打鍵の 100ms 後＝待ちの最初の 0.25 秒の中）
    await p.press("#input", "Enter");
    await waitUntil(async () => (await wordOf(p)).includes(w2.answer), 1500, 20);
    await p.waitForTimeout(100);
    const miss0 = await numOf(p, "#miss");
    const k2 = keysOfA(w2);
    await typeAllButLast(p, k2);
    const r2 = await finishTimed(p, k2.at(-1), { keys: [{ at: 100, key: "n" }], afterMs: 150 });
    check("ローマ字: 語末の ん を nn で終えても、次の語を出す時刻は n 1 つで終えたときと同じ（±50ms。2 つ目の n は次の語のミスにしない）",
      k1.endsWith("n") && k2.endsWith("n") && r1.ms !== null && r2.ms !== null && Math.abs(r2.ms - r1.ms) <= 50 && r2.ms <= 450 && Number(r2.end.miss) === miss0 && r2.after?.preview === "" && r2.after?.ja === J[ids[2]].q,
      JSON.stringify({ single: r1.ms, nn: r2.ms, miss: `${miss0}→${r2.end.miss}`, preview: r2.after?.preview }));
    check("ローマ字（nn のテンポ）でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // ---- 打ち終えたら Enter で次への癖・前の語の結果の行（中学歴史・ローマ字） ----
  // タイマーで進んだときは、前の語を打ち終えてから 1.2 秒の、次の語にまだ打っていない Enter も飲む（次の語の「分からない」にしない）。
  // 次の語が出たら、語の名を含まない前の語の結果の行（「正解」）は消す。語の名を含む行（「知ってた。源頼朝 は…」）は残す
  {
    const J = Object.fromEntries(packA("jhist1").map((w) => [w.id, w]));
    const ids = ["concept-jh1-yoritomo", "concept-jh1-kenzuishi", "concept-jh1-himiko", "concept-jh1-dogu", "concept-jh1-jomondoki"];
    const p = await openPlay(resumeA("jhist1", ids), { url: "/index.html?hintms=600000" });
    const [wA, wB, wC, wD] = ids.map((id) => J[id]);
    check("概念カードの準備（打ち終えたら Enter）: 源頼朝が先頭", (await jaOf(p)) === wA.q, await jaOf(p));
    // 自力: 「知ってた。源頼朝 は…」は次の語の下に残る
    const kA = keysOfA(wA);
    await typeAllButLast(p, kA);
    const rA = await finishTimed(p, kA.at(-1), { probeMs: 300, afterMs: 150 });
    check("次の語が出ても 自力の「知ってた。<語>」の行は残る（前の語の結果と読める）", rA.probe?.same && rA.probe.message.startsWith("知ってた。") && rA.probe.message.includes(wA.answer) && rA.after?.ja === wB.q && rA.after.message === rA.probe.message, JSON.stringify({ probe: rA.probe?.message, after: rA.after?.message }));
    await afterAdvance(p);
    // 答えを見た概念カードの練習のあと 0.8 秒の Enter（待ち 0.25 秒・次の語が出て 0.55 秒）: 次のカードの答えを開かない
    await p.press("#input", "Enter"); // 答えを見る
    await waitUntil(async () => (await wordOf(p)).includes(wB.answer), 1500, 20);
    await p.waitForTimeout(100);
    const rfB = await numOf(p, "#recallFail");
    const kB = keysOfA(wB);
    await typeAllButLast(p, kB);
    const rB = await finishTimed(p, kB.at(-1), { probeMs: 100, afterMs: 100, keys: [{ at: 800, key: "Enter" }], settle: 750 });
    check("答えを見た概念カードの練習のあと 0.8 秒の Enter は次のカードの答えを開かない（思い出せず 同じ）", rB.ms !== null && rB.ms <= 600 && rB.words === 1 && rB.end.ja === wC.q && !rB.end.word.includes(wC.answer) && Number(rB.end.recallFail) === rfB, JSON.stringify({ ms: rB.ms, words: rB.words, word: rB.end.word, rf: `${rfB}→${rB.end.recallFail}` }));
    check("答えを見た語を打って次の語が出たら、前の語の「正解」は残らない", rB.probe?.message === "正解" && rB.after?.ja === wC.q && rB.after.message !== "正解" && rB.end.message === "", JSON.stringify({ probe: rB.probe?.message, after: rB.after?.message, end: rB.end.message }));
    check("前の語の「正解」は見えなくするだけで、読み上げの途中で文を消さない（aria-live）", rB.after?.stale === "正解" && (await p.evaluate(() => getComputedStyle(document.getElementById("message")).opacity)) === "0", JSON.stringify({ stale: rB.after?.stale }));
    await p.waitForTimeout(1600);
    check("見えなくした前の語の行は 1.5 秒で文も消す（あとで辿っても前の語の結果が出ない）", (await p.textContent("#message")).trim() === "", (await p.textContent("#message")).trim());
    // 1.5 秒あけた Enter は次のカードの答えを開く
    await p.waitForTimeout(300);
    await p.press("#input", "Enter"); // 卑弥呼の答えを見る
    await waitUntil(async () => (await wordOf(p)).includes(wC.answer), 1500, 20);
    await p.waitForTimeout(100);
    const rfC = await numOf(p, "#recallFail");
    const kC = keysOfA(wC);
    await typeAllButLast(p, kC);
    const rC = await finishTimed(p, kC.at(-1), { keys: [{ at: 1500, key: "Enter" }], settle: 1300 });
    check("答えを見た概念カードの練習のあと 1.5 秒あけた Enter は次のカードの答えを開く", rC.ms !== null && rC.end.ja === wD.q && rC.end.word.includes(wD.answer) && Number(rC.end.recallFail) === rfC + 1, JSON.stringify({ ms: rC.ms, word: rC.end.word, rf: `${rfC}→${rC.end.recallFail}` }));
    check("正解のあと（打ち終えたら Enter・結果の行）でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // ---- 節目の行（Lv・シールド獲得）は次の語が出ても残す（語の名を含まないが、次の語を正解に見せない） ----
  {
    const myAns = Object.fromEntries(JSON.parse(myWordsA).map((w) => [w.ja, w.en]));
    // Lv: XP を上がる 5 手前に置き（称号は変わらない）、答えを見た語の練習（+5 XP）で上げる
    const pL = await openPlay({ spelldash_category: "my", spelldash_placement: "done", spelldash_my_words: myWordsA, spelldash_audio: JSON.stringify({ mode: "off" }) }, { url: "/index.html?set=10&hintms=600000" });
    await pL.evaluate(async () => {
      const L = await import("/js/level.js");
      for (let t = 200; t < 200000; t++) {
        const a = L.getLevelState(t), b = L.getLevelState(t + 5);
        if (b.level > a.level && a.title === b.title && L.getLevelState(t + 4).level === a.level) { localStorage.setItem("spelldash_xp", String(t)); return; }
      }
    });
    await pL.press("#input", "Enter"); // 答えを見る
    await waitUntil(async () => revealedEn((await wordOf(pL)).replace(/\s+/g, "")), 1500, 20);
    await pL.waitForTimeout(200);
    const enL = (await wordOf(pL)).replace(/\s+/g, "");
    await typeAllButLast(pL, enL);
    const rL = await finishTimed(pL, enL.at(-1), { afterMs: 150 });
    check("Lv が上がった行は次の語が出ても残る（答えを見た語の練習で Lv が上がる）", rL.ms !== null && rL.after && !rL.after.same && rL.after.message.startsWith("Lv."), JSON.stringify({ ms: rL.ms, after: rL.after?.message }));
    check("節目の行（Lv）でエラー0", pL.errors.length === 0, pL.errors[0] ?? "");
    await pL.close();
    // 称号が変わる Lv（幕が節目）: 1 行の「思い出せた」は次の語が出たら消す（まだ打っていない次の語を正解に見せない）
    const pR = await openPlay({ spelldash_category: "my", spelldash_placement: "done", spelldash_my_words: myWordsA, spelldash_audio: JSON.stringify({ mode: "off" }) }, { url: "/index.html?set=10&hintms=600000" });
    await pR.evaluate(async () => {
      const L = await import("/js/level.js");
      for (let t = 200; t < 200000; t++) {
        const a = L.getLevelState(t), b = L.getLevelState(t + 5);
        if (b.level > a.level && a.title !== b.title && L.getLevelState(t + 4).level === a.level) { localStorage.setItem("spelldash_xp", String(t)); return; }
      }
    });
    await pR.press("#input", "Enter"); // 答えを見る
    await waitUntil(async () => revealedEn((await wordOf(pR)).replace(/\s+/g, "")), 1500, 20);
    await pR.waitForTimeout(200);
    const enR = (await wordOf(pR)).replace(/\s+/g, "");
    await typeAllButLast(pR, enR);
    const rR = await finishTimed(pR, enR.at(-1), { probeMs: 300, afterMs: 150 });
    check("称号が変わるレベルアップの幕の語の「思い出せた」は次の語で消える", rR.probe?.same && rR.probe.message === "思い出せた" && rR.ms !== null && rR.after && !rR.after.same && rR.after.message !== "思い出せた", JSON.stringify({ ms: rR.ms, probe: rR.probe?.message, after: rR.after?.message }));
    check("節目の行（称号が変わる Lv）でエラー0", pR.errors.length === 0, pR.errors[0] ?? "");
    await pR.close();
    // シールド獲得: 4 日連続・最後は昨日 → 今日最初の自力正解で 5 日連続・シールド獲得
    const yS = ymd(new Date(Date.now() - 86400000));
    const pS = await openPlay({
      spelldash_category: "my", spelldash_placement: "done", spelldash_my_words: myWordsA, spelldash_audio: JSON.stringify({ mode: "off" }),
      spelldash_streak: JSON.stringify({ current: 4, best: 4, last: yS, shields: 0 }), spelldash_word_stats: JSON.stringify({})
    }, { url: "/index.html?set=10&hintms=600000" });
    const enS = myAns[await jaOf(pS)];
    if (!enS) check("シールド獲得の準備: マイ単語帳の語が先頭", false, await jaOf(pS));
    else {
      await typeAllButLast(pS, enS);
      const rS = await finishTimed(pS, enS.at(-1), { afterMs: 150 });
      check("シールド獲得の行は次の語が出ても残る（今日最初の自力正解で 5 日連続）", rS.ms !== null && rS.after && !rS.after.same && rS.after.message.includes("シールド獲得"), JSON.stringify({ ms: rS.ms, after: rS.after?.message }));
    }
    check("節目の行（シールド獲得）でエラー0", pS.errors.length === 0, pS.errors[0] ?? "");
    await pS.close();
  }

  // ---- W5: 設定「正解のあと」 ----
  {
    const p = await newPage();
    await p.goto(BASE + "/profile.html", { waitUntil: "networkidle" });
    await p.waitForTimeout(400);
    const ui = await p.evaluate(() => {
      const s = document.getElementById("afterCorrectSelect");
      return s ? { value: s.value, label: document.querySelector('label[for="afterCorrectSelect"]')?.textContent.trim(), opts: [...s.options].map((o) => `${o.value}:${o.textContent.trim()}`).join("|"), hint: s.closest(".setting-row")?.querySelector(".setting-hint")?.textContent.trim() } : null;
    });
    check("設定: 正解のあと は既定で 少し見せる（すぐ次へ／少し見せる／長く見せる）", ui?.value === "standard" && ui.label === "正解のあと" && ui.opts === "quick:すぐ次へ|standard:少し見せる（標準）|long:長く見せる（例文・解説を読む）" && ui.hint === "自力で正解した語の答え・例文・解説を見せる長さ。Enter で待たずに次へ", JSON.stringify(ui));
    await p.focus("#afterCorrectSelect");
    await p.selectOption("#afterCorrectSelect", "long");
    const saved = await p.evaluate(() => localStorage.getItem("spelldash_after_correct"));
    await p.reload({ waitUntil: "networkidle" });
    await p.waitForTimeout(400);
    check("設定: 正解のあと を選ぶと保存される（再読み込み後も 長く見せる）", saved === "long" && (await p.inputValue("#afterCorrectSelect")) === "long", String(saved));
    const kept = await p.evaluate(async () => {
      const b = await import("/js/backup.js");
      b.clearLocalRecords?.();
      return localStorage.getItem("spelldash_after_correct");
    });
    check("設定: 正解のあと は端末の記録を消しても残る（端末の好み）", kept === "long", String(kept));
    check("設定（正解のあと）でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // ---- W6・W7: 長く見せる／すぐ次へ ----
  for (const pace of ["long", "quick"]) {
    const p = await openPlay(bizSeed({ spelldash_after_correct: pace }));
    const f = await findSelf(p);
    if (!f) { check(`設定（${pace}）: 一意な語が見つからない`, false); await p.close(); continue; }
    await typeAllButLast(p, f.w.en);
    if (pace === "long") {
      const r = await finishTimed(p, f.w.en.at(-1), { probeMs: 1200, keys: [{ at: 1250, key: "Enter" }] });
      check("設定（長く見せる）: 例文つきの語は 1.2 秒たっても同じ語。Enter で次へ", r.probe?.same && r.probe.example.includes(f.w.ex) && r.ms !== null && r.ms >= 1250 && r.ms <= 1550 && r.words === 1, `${r.ms}ms`);
    } else {
      const r = await finishTimed(p, f.w.en.at(-1), { probeMs: 100 });
      check("設定（すぐ次へ）: 例文つきの語も 0.6 秒以内に次へ。例文は出さない", r.probe?.same && r.probe.example === "" && r.ms !== null && r.ms >= 200 && r.ms <= 600, `${r.ms}ms ex=${r.probe?.example.slice(0, 20)}`);
    }
    check(`設定（${pace === "long" ? "長く見せる" : "すぐ次へ"}）のプレイでエラー0`, p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // ---- M1・H1・H2: 覚えた（1.4 秒）・プレイ中は見えない 覚えた単語 カード ----
  for (const viewport of [{ width: 1200, height: 900 }, { width: 390, height: 844 }]) {
    const y = new Date(Date.now() - 86400000);
    const p = await newPage({ viewport, storage: {
      spelldash_category: "my", spelldash_placement: "done", spelldash_my_words: myWordsA, spelldash_audio: JSON.stringify({ mode: "off" }),
      spelldash_word_stats: JSON.stringify({ "my-invoice": { playCount: 1, correctCount: 0, missCount: 1, typingMiss: 0, recallFail: 1, cleanCorrectStreak: 0, mastered: false, lastPlayed: y.toISOString(), nextReviewAt: y.toISOString(), lastRecallFailAt: y.toISOString(), lastRecallSuccessAt: null, history: [{ d: ymd(y), r: "x" }] } }),
      spelldash_first_sight: JSON.stringify(Array(11).fill(true))
    } });
    await p.addInitScript(PROBE58);
    await p.goto(BASE + "/index.html?set=3&hintms=600000", { waitUntil: "networkidle" });
    await p.waitForTimeout(700);
    const cardBefore = (await p.textContent("#learnedCard")).trim();
    await p.press("#input", "Enter");
    await waitUntil(async () => (await jaOf(p)) === "請求書", 3000, 20);
    await p.waitForTimeout(300);
    await typeAllButLast(p, "invoice");
    const r = await finishTimed(p, "e", { probeMs: 800, afterMs: 100 });
    check(`覚えた: スタンプが消えるまで（1.4 秒）次の語を出さない（${viewport.width}）`, r.probe?.same && r.ms !== null && r.ms >= 1300 && r.ms <= 2800 && r.after && !r.after.stamp, `${r.ms}ms stamp=${r.after?.stamp}`);
    check(`プレイ中は 覚えた単語 カードが見えない（${viewport.width}）`, await p.evaluate(() => document.getElementById("learnedCard")?.offsetParent === null));
    await p.click("#backToPath");
    await p.waitForTimeout(400);
    const cardAfter = (await p.textContent("#learnedCard")).trim();
    check(`机に戻ると 覚えた単語 カードに今日覚えた語が出る（${viewport.width}）`, cardAfter !== cardBefore && cardAfter.includes("invoice"), `${cardBefore.slice(0, 30)} → ${cardAfter.slice(0, 40)}`);
    check(`覚えた（${viewport.width}）でエラー0`, p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // ---- M2: 覚え方のメモを書いている間は次の語へ進まない ----
  {
    const p = await openPlay({ spelldash_category: "my", spelldash_placement: "done", spelldash_my_words: myWordsA, spelldash_audio: JSON.stringify({ mode: "off" }) }, { url: "/index.html?set=10&hintms=600000" });
    const ja = await jaOf(p);
    await p.press("#input", "Enter"); // 答えを見る
    await waitUntil(async () => revealedEn(await wordOf(p)), 1500, 20);
    const enM = await wordOf(p);
    await typeAllButLast(p, enM);
    await p.click("#noteEdit");
    await p.keyboard.type("nego");
    await finishWord(p, enM.at(-1)); // 打ち終える（メモ欄に焦点があるまま待ちに入る）
    await p.waitForTimeout(800);
    const held = (await jaOf(p)) === ja && (await p.$("#noteInput")) !== null && (await p.inputValue("#noteInput")) === "nego";
    check("メモ: 覚え方を書いている間は次の語へ進まない（書きかけが残る）", held, `ja=${await jaOf(p)}`);
    await p.press("#noteInput", "Enter"); // 保存
    const moved = await waitUntil(async () => (await jaOf(p)) !== ja, 1000, 20);
    const notes = await p.evaluate(() => localStorage.getItem("spelldash_word_notes") || "");
    check("メモ: 保存すると 1 秒以内に次の語（メモは残る）", moved && notes.includes("nego"), notes.slice(0, 60));
    check("メモ（待ち）でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // ---- M3: マウスで「保存」を押し下げている間（焦点が欄から離れる）に待ちの見直しが来ても、書きかけを失わない ----
  {
    const p = await openPlay({ spelldash_category: "my", spelldash_placement: "done", spelldash_my_words: myWordsA, spelldash_audio: JSON.stringify({ mode: "off" }) }, { url: "/index.html?set=10&hintms=600000" });
    const ja = await jaOf(p);
    await p.press("#input", "Enter"); // 答えを見る
    await waitUntil(async () => revealedEn(await wordOf(p)), 1500, 20);
    const enM3 = await wordOf(p);
    await typeAllButLast(p, enM3);
    await p.click("#noteEdit");
    await p.keyboard.type("budget の b");
    await finishWord(p, enM3.at(-1)); // 打ち終える（メモ欄に焦点があるまま待ちに入る）
    const box = await (await p.$("#noteSave")).boundingBox();
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await p.mouse.down();
    await p.evaluate(() => document.activeElement?.blur()); // Safari: ボタンは焦点を取らない
    await p.waitForTimeout(1200); // 待ちの見直し（0.5 秒ごと）を 2 回またぐ
    const heldDown = (await jaOf(p)) === ja && (await p.$("#noteSave")) !== null;
    await p.mouse.up();
    const notes = await p.evaluate(() => localStorage.getItem("spelldash_word_notes") || "");
    const moved = await waitUntil(async () => (await jaOf(p)) !== ja, 1500, 20);
    check("メモ: 保存を押し下げている間（焦点が欄から離れても）次の語へ進まず、離すと保存される", heldDown && notes.includes("budget の b") && moved, JSON.stringify({ heldDown, notes: notes.slice(0, 60), moved }));
    check("メモ（マウスで保存）でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // ---- A1: 待ちの間に「覚え方を作る」: 返事を待つ間は進めない・返事が出たら Enter まで待つ・先へ進んだら前の語の覚え方を次の語に出さない ----
  {
    const seedAi = { spelldash_category: "my", spelldash_placement: "done", spelldash_my_words: myWordsA, spelldash_audio: JSON.stringify({ mode: "off" }), spelldash_test_session: "1" };
    const slowAi = async (p, ms) => p.route("**/api/explain-word", async (route) => { await new Promise((r) => setTimeout(r, ms)); await route.continue(); });
    // (a) 待ちの間に押す → 返事（1.2 秒）まで進まない → 覚え方が同じ語の下に出る → 自動では進まない → Enter で次へ
    {
      const p = await openPlay(seedAi, { url: "/index.html?set=10&hintms=600000" });
      await slowAi(p, 1200);
      const ja = await jaOf(p);
      await p.press("#input", "Enter"); // 答えを見る
      await waitUntil(async () => revealedEn(await wordOf(p)) && (await p.$("[data-word-ai-run]")) !== null, 3000, 20);
      const en = await wordOf(p);
      await typeAllButLast(p, en);
      await p.evaluate((k) => { document.getElementById("input").dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); document.querySelector("[data-word-ai-run]").click(); }, en.at(-1)); // 打ち終えた直後（待ちの間）に押す
      await p.waitForTimeout(800);
      const heldInFlight = (await jaOf(p)) === ja;
      await waitUntil(async () => (await p.textContent("#wordAi")).includes("音で覚える"), 3000, 20);
      await p.waitForTimeout(1200);
      const heldReading = (await jaOf(p)) === ja && (await p.textContent("#wordAi")).includes(`${en} は`);
      await p.press("#input", "Enter");
      const moved = await waitUntil(async () => (await jaOf(p)) !== ja, 1500, 20);
      check("覚え方を作る（待ちの間）: 返事を待つ間は次の語へ進まない", heldInFlight, `ja=${await jaOf(p)}`);
      check("覚え方を作る（待ちの間）: 返事が出たら読み終えるまで待ち、Enter で次へ", heldReading && moved, JSON.stringify({ heldReading, moved }));
      check("覚え方（待ちの間）でエラー0", p.errors.length === 0, p.errors[0] ?? "");
      await p.close();
    }
    // (b) 押してすぐ Enter で先へ → 返事が来ても、前の語の覚え方を次の語の下に出さない（保存はする）
    {
      const p = await openPlay(seedAi, { url: "/index.html?set=10&hintms=600000" });
      await slowAi(p, 900);
      const ja = await jaOf(p);
      await p.press("#input", "Enter"); // 答えを見る
      await waitUntil(async () => revealedEn(await wordOf(p)) && (await p.$("[data-word-ai-run]")) !== null, 3000, 20);
      const en = await wordOf(p);
      await typeAllButLast(p, en);
      await p.evaluate((k) => { document.getElementById("input").dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); document.querySelector("[data-word-ai-run]").click(); }, en.at(-1)); // 打ち終えた直後（待ちの間）に押す
      await p.focus("#input");
      await p.press("#input", "Enter"); // 待たずに次へ
      await waitUntil(async () => (await jaOf(p)) !== ja, 1500, 20);
      await p.waitForTimeout(1300); // 返事が来る
      const aiNow = (await p.textContent("#wordAi")).trim();
      const saved = await p.evaluate(() => localStorage.getItem("spelldash_word_ai") || "");
      check("覚え方を作る: 返事の前に次の語へ進んだら、前の語の覚え方を次の語の下に出さない（保存はする）", !aiNow.includes(`${en} は`) && saved.includes("音で覚える"), JSON.stringify({ aiNow: aiNow.slice(0, 40), saved: saved.length }));
      check("覚え方（先へ進んだ）でエラー0", p.errors.length === 0, p.errors[0] ?? "");
      await p.close();
    }
    // (c) 返事を待つ間に同じ語の欄を描き直す（メモを保存）→ 依頼は 1 回、返事はその語の下に出る
    {
      const p = await openPlay(seedAi, { url: "/index.html?set=10&hintms=600000" });
      let calls = 0;
      await p.route("**/api/explain-word", async (route) => { calls++; await new Promise((r) => setTimeout(r, 900)); await route.continue(); });
      await p.press("#input", "Enter"); // 答えを見る（まだ打たない）
      await waitUntil(async () => revealedEn(await wordOf(p)) && (await p.$("[data-word-ai-run]")) !== null, 3000, 20);
      const en = await wordOf(p);
      await p.click("[data-word-ai-run]");
      await p.click("#noteEdit");
      await p.keyboard.type("memo");
      await p.press("#noteInput", "Enter"); // 保存 → 欄を描き直す
      await waitUntil(async () => (await p.textContent("#wordAi")).includes("音で覚える"), 3000, 20);
      const ai = (await p.textContent("#wordAi")).trim();
      check("覚え方を作る: 返事を待つ間に同じ語の欄を描き直しても、依頼は 1 回で返事はその語の下に出る", calls === 1 && ai.includes(`${en} は`) && (await p.$("[data-word-ai-run]")) === null, JSON.stringify({ calls, ai: ai.slice(0, 40) }));
      check("覚え方（描き直し）でエラー0", p.errors.length === 0, p.errors[0] ?? "");
      await p.close();
    }
    // (d) 待ちの間に押して断り（無料ぶんを使い切った）が出たら、読めるように Enter まで待つ
    {
      const limitWords = JSON.stringify([{ en: "limit", ja: "限度" }, { en: "limited", ja: "限られた" }, { en: "limitation", ja: "制限" }]);
      const p = await openPlay({ ...seedAi, spelldash_my_words: limitWords }, { url: "/index.html?set=10&hintms=600000" });
      const ja = await jaOf(p);
      await p.press("#input", "Enter"); // 答えを見る
      await waitUntil(async () => revealedEn(await wordOf(p)) && (await p.$("[data-word-ai-run]")) !== null, 3000, 20);
      const en = await wordOf(p);
      await typeAllButLast(p, en);
      await p.evaluate((k) => { document.getElementById("input").dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); document.querySelector("[data-word-ai-run]").click(); }, en.at(-1)); // 打ち終えた直後（待ちの間）に押す
      await waitUntil(async () => (await p.textContent("#wordAi")).includes("使い切った"), 3000, 20);
      await p.waitForTimeout(1200);
      const held = (await jaOf(p)) === ja && (await p.textContent("#wordAi")).includes("使い切った");
      await p.press("#input", "Enter");
      const moved = await waitUntil(async () => (await jaOf(p)) !== ja, 1500, 20);
      check("覚え方を作る: 待ちの間の断りの文も読めるように Enter まで待つ", held && moved, JSON.stringify({ held, moved }));
      check("覚え方（断り）でエラー0", p.errors.length === 0, p.errors[0] ?? "");
      await p.close();
    }
  }

  // ---- T1: チュートリアル T3 を出した語は 1.5 秒置いて次へ。札は次の語で消える ----
  {
    const p = await newPage();
    await p.addInitScript(PROBE58);
    await p.goto(BASE + "/index.html?set=3", { waitUntil: "networkidle" });
    await p.waitForTimeout(600);
    await p.press("#input", "Enter");
    await p.waitForTimeout(300);
    const known = new Map();
    let t3 = null;
    for (let i = 0; i < 80 && !t3; i++) {
      if (!(await p.$eval("#resultPanel", (el) => el.hidden))) break;
      const ja = await jaOf(p);
      const hidden = !revealedEn(await wordOf(p));
      if (known.has(ja) && hidden) {
        const ans = known.get(ja);
        await typeAllButLast(p, ans);
        const r = await finishTimed(p, ans.at(-1), { probeMs: 100, afterMs: 200 });
        if (r.probe?.coach === "T3") t3 = r;
      } else {
        if (hidden) {
          await p.press("#input", "Enter");
          await waitUntil(async () => revealedEn(await wordOf(p)), 1000, 20);
        }
        const shown = await wordOf(p);
        if (!revealedEn(shown)) { await p.waitForTimeout(200); continue; }
        known.set(ja, shown);
        for (const ch of shown) await p.press("#input", ch);
        await waitUntil(async () => (await jaOf(p)) !== ja, 2000, 20);
      }
      await afterAdvance(p);
    }
    check("チュートリアル: T3 を出した語は 1.5 秒置いて次へ。札は次の語で消える", t3 && t3.ms >= 1400 && t3.ms <= 3000 && t3.after && t3.after.coach !== "T3", JSON.stringify(t3 && { ms: t3.ms, after: t3.after?.coach }));
    check("チュートリアル（T3 の待ち）でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  // ---- T2: Challenge・Daily は正解と同じタスクで次の語が出る → T3 はその語では消さない（出したのに見えないまま済みにしない） ----
  {
    const p = await newPage();
    await p.goto(BASE + "/index.html?set=3", { waitUntil: "networkidle" });
    await p.waitForTimeout(600);
    const r = await p.evaluate(async () => {
      const fire = (mode) => {
        dispatchEvent(new CustomEvent("spelldash:recall", { detail: { id: "x", mode } }));
        dispatchEvent(new CustomEvent("spelldash:word", { detail: { id: "y" } })); // 同じタスクで次の語
      };
      fire("challenge");
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      const el = document.querySelector('.coach[data-step="T3"]');
      return { shown: !!el && !el.classList.contains("coach--out"), text: el?.textContent.trim() ?? "" };
    });
    check("チュートリアル: Challenge で T3 を出した語の直後の語では札を消さない（文が出る）", r.shown && r.text.length > 0, JSON.stringify(r));
    await p.waitForTimeout(1700);
    check("チュートリアル: 次の語が先に出た T3 は、出してから 1.5 秒で消す", (await p.$('.coach[data-step="T3"]:not(.coach--out)')) === null);
    check("チュートリアル（Challenge の T3）でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // ---- L1: 音で出題: 次の語へ進んだ後に前の語を読まない ----
  {
    const p = await openPlay(bizSeed({ spelldash_audio: JSON.stringify({ mode: "auto", listenRatio: 50 }) }));
    const byIdA = Object.fromEntries(bizA.map((w) => [w.id, w]));
    for (let i = 0; i < 12; i++) {
      if (!(await p.$eval("#resultPanel", (el) => el.hidden))) break;
      const n0 = await p.evaluate(() => window.__a58.words);
      await p.press("#input", "Enter"); // 答え表示
      await waitUntil(async () => revealedEn((await wordOf(p)).replace(/\s+/g, "")), 1000, 20);
      const shown = (await wordOf(p)).replace(/\s+/g, "");
      if (revealedEn(shown)) for (const ch of shown) await p.press("#input", ch);
      else await p.press("#input", "Enter");
      await waitUntil(async () => (await p.evaluate(() => window.__a58.words)) > n0, 2000, 10);
      await p.waitForTimeout(i % 2 ? 60 : 420); // 150ms 後の読みの前後を見る
      await afterAdvance(p); // 次の操作（答え表示）は守りの後

    }
    const ev = await p.evaluate(() => window.__a58);
    const listened = await p.evaluate(() => JSON.parse(localStorage.getItem("spelldash_audio") || "{}").listenRatio);
    const bad = ev.speak.filter((s) => byIdA[s.id] && s.text !== (byIdA[s.id].say ?? byIdA[s.id].en));
    check("音で出題: 次の語へ進んだ後に前の語を読まない（読んだ語はその時の語）", listened === 50 && ev.speak.length > 0 && bad.length === 0, `speak=${ev.speak.length} bad=${JSON.stringify(bad).slice(0, 120)}`);
    check("音で出題（待ち）でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // ---- R1・R2・R4・R5: 記録の書き込み（同じタスクの終わり）・別ページへ移っても残る・凍結の網・別のタブ ----
  {
    const p = await openPlay(bizSeed(), { url: "/index.html?set=5&hintms=600000" });
    const f = await findSelf(p);
    if (f) {
      await typeAllButLast(p, f.w.en);
      const r = await p.evaluate(async ({ last, id }) => {
        const read = () => JSON.parse(localStorage.getItem("spelldash_word_stats") || "{}")[id] ?? null;
        document.getElementById("input").dispatchEvent(new KeyboardEvent("keydown", { key: last, bubbles: true, cancelable: true }));
        const inTask = read()?.lastRecallSuccessAt ?? null;
        await Promise.resolve();
        return { inTask, afterMicrotask: read()?.lastRecallSuccessAt ?? null };
      }, { last: f.w.en.at(-1), id: f.w.id });
      check("記録: 正解の打鍵のタスクが終わった時点で localStorage に書かれている", !!r.afterMicrotask, JSON.stringify(r));
      const frozen = await p.evaluate(async () => {
        const m = await import("/js/storage.js");
        const s = m.getWordStats();
        const id = Object.keys(s)[0];
        return { webdriver: navigator.webdriver, frozen: Object.isFrozen(s) && (!id || Object.isFrozen(s[id])) };
      });
      check("記録: 読んだ中身は凍っている（書き換えは stats.js の写しだけ）", frozen.webdriver === true && frozen.frozen, JSON.stringify(frozen));
      const r5 = await p.evaluate(async (id) => {
        const raw = JSON.parse(localStorage.getItem("spelldash_word_stats"));
        raw[id] = { ...raw[id], playCount: 999 };
        localStorage.setItem("spelldash_word_stats", JSON.stringify(raw)); // 別のタブの書き込みのつもり
        await new Promise((res) => setTimeout(res, 0));
        return (await import("/js/storage.js")).getWordStats()[id]?.playCount;
      }, f.w.id);
      check("記録: 別のタブの書き込みを次の読みで拾う", r5 === 999, String(r5));
      // 凍結の網: 1 セットの残り（自力・1 ミス・答え表示・結果パネル）を回しても pageerror 0
      await afterAdvance(p);
      for (let i = 0; i < 80; i++) {
        if (!(await p.$eval("#resultPanel", (el) => el.hidden))) break;
        const ja = await jaOf(p);
        const w = bizAnswer(ja);
        if (w && i % 4 !== 1) for (const ch of w.en) await p.press("#input", ch);
        else if (w) { await p.press("#input", w.en[0] === "q" ? "z" : "q"); await waitUntil(async () => revealedEn(await wordOf(p)), 1000, 20); for (const ch of await wordOf(p)) await p.press("#input", ch); }
        else {
          await p.press("#input", "Enter");
          await waitUntil(async () => revealedEn((await wordOf(p)).replace(/\s+/g, "")), 1000, 20);
          const shown = (await wordOf(p)).replace(/\s+/g, "");
          if (revealedEn(shown)) for (const ch of shown) await p.press("#input", ch);
          else await p.press("#input", "Enter");
        }
        await waitUntil(async () => (await jaOf(p)) !== ja || !(await p.$eval("#resultPanel", (el) => el.hidden)), 3000, 20);
        await afterAdvance(p);
      }
      check("記録: 凍った中身のまま 1 セットを終えてもエラー0（読み手が書き換えない）", !(await p.$eval("#resultPanel", (el) => el.hidden)) && p.errors.length === 0, p.errors[0] ?? "result panel hidden");
    } else check("記録: 一意な語が見つからない", false);
    await p.close();
    // R2: 正解の打鍵と同じタスクで別ページへ移っても記録が残る
    const p2 = await openPlay(bizSeed());
    const g = await findSelf(p2);
    if (g) {
      await typeAllButLast(p2, g.w.en);
      await p2.evaluate(({ last }) => {
        document.getElementById("input").dispatchEvent(new KeyboardEvent("keydown", { key: last, bubbles: true, cancelable: true }));
        location.href = "list.html";
      }, { last: g.w.en.at(-1) }).catch(() => {});
      await p2.waitForURL(/list\.html/, { timeout: 8000 }).catch(() => {});
      await p2.waitForTimeout(400);
      const st = await p2.evaluate((id) => JSON.parse(localStorage.getItem("spelldash_word_stats") || "{}")[id] ?? null, g.w.id);
      check("記録: 正解の直後に別ページへ移っても記録が残る", p2.url().includes("list.html") && !!st?.lastRecallSuccessAt && st.correctCount >= 1, JSON.stringify(st)?.slice(0, 100));
    } else check("記録: 別ページへ移る（一意な語が見つからない）", false);
    await p2.close();
  }

  // ---- R3: 正解の 1 打で word_stats の書き込みは 1 回・2MB の parse は 1 回以下（記録 2,000 語）。習熟度の spelldash_mastery_meta は 0 回（docs/SPEC_MASTERY.md §7.2） ----
  {
    const old = new Date(Date.now() - 30 * 86400000).toISOString();
    const heavy = {};
    for (let i = 0; i < 2000; i++) heavy[`r58-${i}`] = { playCount: 5, correctCount: 4, missCount: 1, typingMiss: 0, recallFail: 1, cleanCorrectStreak: 3, mastered: false, lastPlayed: old, nextReviewAt: new Date(Date.now() + 20 * 86400000).toISOString(), lastRecallFailAt: old, lastRecallSuccessAt: old, history: Array.from({ length: 8 }, () => ({ d: todayA, r: "o" })) };
    const p = await newPage({ storage: bizSeed({ spelldash_word_stats: JSON.stringify(heavy) }) });
    await p.addInitScript(() => {
      window.__io = { set: 0, parse: 0, meta: 0 };
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) { if (k === "spelldash_word_stats") window.__io.set++; if (k === "spelldash_mastery_meta") window.__io.meta++; return setItem.call(this, k, v); };
      const parse = JSON.parse;
      JSON.parse = function (s, r) { if (typeof s === "string" && s.length >= 100000) window.__io.parse++; return parse.call(this, s, r); };
    });
    await p.addInitScript(PROBE58);
    await p.goto(BASE + "/index.html?set=25&hintms=600000", { waitUntil: "networkidle" });
    await p.waitForTimeout(700);
    await p.press("#input", "Enter");
    await waitUntil(async () => (await jaOf(p)) !== "", 5000);
    await p.waitForTimeout(400);
    const f = await findSelf(p);
    if (f) {
      await typeAllButLast(p, f.w.en);
      await p.waitForTimeout(50);
      const io = await p.evaluate(async (last) => {
        window.__io.set = 0;
        window.__io.parse = 0;
        window.__io.meta = 0;
        document.getElementById("input").dispatchEvent(new KeyboardEvent("keydown", { key: last, bubbles: true, cancelable: true }));
        await Promise.resolve();
        return { ...window.__io, bytes: localStorage.getItem("spelldash_word_stats").length };
      }, f.w.en.at(-1));
      check("記録: 正解の 1 打で word_stats の書き込みは 1 回・2MB の parse は 1 回以下・spelldash_mastery_meta は 0 回", io.set === 1 && io.parse <= 1 && io.meta === 0 && io.bytes >= 100000, JSON.stringify(io));
    } else check("記録: 書き込みの回数（一意な語が見つからない）", false);
    check("記録（2,000 語）でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // ---- J1〜J3: 答えが日本語のカードは音声なし。英語の答えは今までどおり ----
  {
    const M = Object.fromEntries(packA("mechanic").map((w) => [w.id, w]));
    const ids = ["concept-mech-shaken", "concept-mech-atf", "concept-mech-legal-inspection", "concept-mech-safety-standard"];
    const p = await openPlay(resumeA("mechanic", ids, { spelldash_audio: JSON.stringify({ mode: "auto" }) }), { url: "/index.html?hintms=600000" });
    const shaken = M[ids[0]];
    const ready = (await jaOf(p)) === shaken.q && !!shaken.say;
    await p.press("#input", "Control+.");
    await p.waitForTimeout(100);
    for (const ch of keysOfA(shaken)) await p.press("#input", ch);
    await waitUntil(async () => (await numOf(p, "#score")) === 1, 2000, 20);
    await p.waitForTimeout(150);
    let sp = await p.evaluate(() => window.__a58.speak);
    check("日本語の答えのカードは正解で音声を鳴らさない（車検 → say あり・Ctrl+. も鳴らない）", ready && (await numOf(p, "#score")) === 1 && sp.length === 0, JSON.stringify(sp));
    await p.press("#input", "Enter"); // 待たずに次へ
    await waitUntil(async () => (await jaOf(p)) === M[ids[1]].q, 2000, 20);
    await afterAdvance(p);
    // ATF（英語の答え）: 自力正解で 1 回だけ鳴る
    for (const ch of "atf") await p.press("#input", ch);
    await waitUntil(async () => (await numOf(p, "#score")) === 2, 2000, 20);
    await p.waitForTimeout(200);
    sp = await p.evaluate(() => window.__a58.speak);
    check("英語の答えは今までどおり正解で発音する（ATF）", sp.length === 1 && sp[0].text === M[ids[1]].say, JSON.stringify(sp));
    await p.press("#input", "Enter");
    await waitUntil(async () => (await jaOf(p)) === M[ids[2]].q, 2000, 20);
    await afterAdvance(p);
    // 法定点検: 答え表示（自動）で鳴らない・発音ボタンを出さない
    await p.press("#input", "Enter");
    await waitUntil(async () => (await wordOf(p)).includes(M[ids[2]].answer), 1500, 20);
    await p.waitForTimeout(200);
    sp = await p.evaluate(() => window.__a58.speak);
    check("日本語の答えのカードは答え表示で音声を鳴らさない・発音ボタンを出さない（法定点検）", sp.length === 1 && (await p.$eval("#speakButton", (el) => el.hidden)), `speak=${sp.length}`);
    check("日本語の答えのカード（音声）でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
    // 単語詳細（単語帳）: 日本語の答えに発音ボタンなし・英語の答えにはある
    const p2 = await newPage({ storage: { spelldash_packs: JSON.stringify(["mechanic"]), spelldash_category: "mechanic" } });
    await p2.goto(BASE + "/list.html", { waitUntil: "networkidle" });
    await p2.waitForTimeout(500);
    const det = await p2.evaluate(async () => {
      const m = await import("/js/wordDetail.js");
      const wait = () => new Promise((res) => setTimeout(res, 200));
      m.openWordDetail("concept-mech-shaken", { category: "mechanic" });
      await wait();
      const ja = !!document.getElementById("wordDetailSpeak");
      document.querySelector("[data-detail-close]")?.click();
      await wait();
      m.openWordDetail("concept-mech-atf", { category: "mechanic" });
      await wait();
      return { ja, en: !!document.getElementById("wordDetailSpeak") };
    });
    check("単語詳細: 日本語の答えのカードに発音ボタンを出さない（英語の答えには出す）", det.ja === false && det.en === true, JSON.stringify(det));
    check("単語詳細（音声）でエラー0", p2.errors.length === 0, p2.errors[0] ?? "");
    await p2.close();
  }
}
// ===== Batch 58 ここまで =====

// ===== 10. 新カテゴリ「広告・マーケ」: チップ表示＋Lv1で出題 =====
// ===== 日本語の答えは読みをローマ字で打つ（変換なし・かなの下に打ったキー。js/romaji.js） =====
console.log("romaji answers:");
{
  const todayR = ymd(new Date());
  const packWords = (pack) => JSON.parse(fs.readFileSync(path.join(ROOT, `data/packs/${pack}.json`), "utf8")).words;
  const byId = (pack, id) => packWords(pack).find((w) => w.id === id);
  const readingOf = (w) => primaryReading(readingEntries(w));
  const keysOf = (w) => canonicalRomaji(readingOf(w).reading, { finalN: true }); // 語末の ん は n 1 つ
  // 前回の続き（spelldash_session）に並べた順で出題させる（道のスタートの Enter = 続きから）
  const resumeSeed = (pack, ids, extra = {}) => ({
    spelldash_packs: JSON.stringify([pack]), spelldash_category: pack, spelldash_placement: "done", spelldash_level_boost: "2",
    spelldash_streak: JSON.stringify({ current: 1, best: 1, last: todayR }),
    spelldash_session: JSON.stringify({ category: pack, focus: "", queue: ids, recalled: [], failed: [], newCount: 0, reviewCount: 0, setSize: 20, date: todayR, savedAt: new Date().toISOString() }),
    ...extra
  });
  const promptIs = async (page, w) => (await page.textContent("#japanese")).trim() === w.q;
  const preview = (page) => page.$eval("#typedPreview", (el) => ({
    kana: [...el.querySelectorAll(".rk:not(.rk--pending) .rk__kana")].map((e) => e.textContent),
    keys: [...el.querySelectorAll(".rk:not(.rk--pending) .rk__keys")].map((e) => e.textContent),
    pending: el.querySelector(".rk--pending .rk__keys")?.textContent ?? ""
  }));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const num = async (page, sel) => Number((await page.textContent(sel)).trim());
  const pressAll = async (page, keys) => { for (const ch of keys) await page.press("#input", ch); };

  // ---- 中学歴史（社会）: 続きからの列で 7 枚を順に ----
  const ids = ["concept-jh1-yoritomo", "concept-jh1-shinran", "concept-jh1-kenzuishi", "concept-jh1-iwajuku", "concept-jh1-kaitaishinsho", "concept-jh1-shomutenno", "concept-jh1-manyoshu"];
  const W = Object.fromEntries(ids.map((id) => [id, byId("jhist1", id)]));
  const page = await newPage({ storage: resumeSeed("jhist1", ids) });
  await page.goto(BASE + "/index.html?hintms=300", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.press("#input", "Enter"); // 道のスタート（続きから）
  await waitUntil(() => promptIs(page, W["concept-jh1-yoritomo"]), 3000);

  // (a) 源頼朝: 入力欄は読み取り専用（IME・OS キーボードを開かない）。打つ前は答えも読みも出さない。打ち終えたら Enter なしで正解
  const w1 = W["concept-jh1-yoritomo"];
  const shownBefore = `${await page.textContent("#word")}|${await page.textContent("#typedPreview")}|${await page.inputValue("#input")}|${await page.getAttribute("#input", "placeholder")}`;
  check("ローマ字: 日本語の答えのカードは入力欄が読み取り専用・案内は「読みをローマ字で（変換しない）」",
    (await promptIs(page, w1)) && (await page.getAttribute("#input", "readonly")) !== null && (await page.getAttribute("#input", "placeholder")) === "読みをローマ字で（変換しない）" &&
    (await page.textContent("#gameCard .label")).includes("説明に合う語を答える") && (await page.evaluate(() => document.body.classList.contains("romaji-answer"))),
    shownBefore);
  check("ローマ字: 打つ前は答えも読みも見せない", !shownBefore.includes(readingOf(w1).display) && !shownBefore.includes(w1.answer), shownBefore);
  await pressAll(page, keysOf(w1));
  await waitUntil(async () => (await num(page, "#score")) === 1, 2000);
  check("(a) 読みを打ち終えたら Enter なしで正解（源頼朝 ← " + keysOf(w1) + "）", (await num(page, "#score")) === 1 && (await num(page, "#recalledToday")) === 1 && (await num(page, "#miss")) === 0);
  check("(a) 正解のあと答えの下に読み（源頼朝 ／ みなもとのよりとも）",
    (await page.textContent("#word")).includes(w1.answer) && (await page.textContent("#word .hidden-word__reading")) === readingOf(w1).display && (await page.inputValue("#input")) === keysOf(w1),
    await page.textContent("#word"));
  await page.press("#input", "Enter"); // 待たずに次へ

  // (b)(c) 親鸞: 2 段表示（かなの下に打ったキー）。si と n' でも打てる。決まっていない n は末尾に出す。まだ打っていない読みは出さない
  const w2 = W["concept-jh1-shinran"];
  await waitUntil(() => promptIs(page, w2), 3000);
  await pressAll(page, "sin");
  const p1 = await preview(page);
  check("(b) 2 段表示: し の下に si、まだ決まらない n は末尾", same(p1, { kana: ["し"], keys: ["si"], pending: "n" }), JSON.stringify(p1));
  await pressAll(page, "'r");
  const p2 = await preview(page);
  const previewText = await page.textContent("#typedPreview");
  check("(b)(c) n' で ん（し／ん の下に si／n'）。打っていない「らん」は出さない", same(p2, { kana: ["し", "ん"], keys: ["si", "n'"], pending: "r" }) && !previewText.includes("ら"), JSON.stringify(p2));
  await pressAll(page, "an");
  await waitUntil(async () => (await num(page, "#score")) === 2, 2000);
  check("(c) sin'ran で 親鸞 が正解", (await num(page, "#score")) === 2 && (await num(page, "#miss")) === 0);
  await page.press("#input", "Enter");

  // (c) 遣隋使: 子音の前の ん は n 1 つ、し は si
  const w3 = W["concept-jh1-kenzuishi"];
  await waitUntil(() => promptIs(page, w3), 3000);
  await pressAll(page, "kenzuisi");
  await waitUntil(async () => (await num(page, "#score")) === 3, 2000);
  check("(c) kenzuisi で 遣隋使 が正解（ん=n・し=si）", (await num(page, "#score")) === 3 && (await num(page, "#miss")) === 0);
  await page.press("#input", "Enter");

  // 岩宿遺跡: 読み いわじゅく は いわじゅくいせき の手前。手前の読みでも打ち終えたら Enter なしで正解。
  // 長い読みを打ち続けた残り（iseki）: 読みの続きの打鍵は 0.6 秒まで次の語に入れない（正解後の待ちをまたぐ。ミスにならない）
  const w4 = W["concept-jh1-iwajuku"];
  await waitUntil(() => promptIs(page, w4), 3000);
  await pressAll(page, "iwajuku");
  await waitUntil(async () => (await num(page, "#score")) === 4, 2000);
  const shortDone = (await num(page, "#score")) === 4;
  await pressAll(page, "iseki");
  await page.waitForTimeout(100);
  check("ローマ字: 長い読みの手前の読み（いわじゅく）でも打ち終えたら Enter なしで正解。続けて打った いせき はミスにしない",
    shortDone && (await num(page, "#score")) === 4 && (await num(page, "#recallFail")) === 0 && (await num(page, "#miss")) === 0,
    `${await num(page, "#score")} / ${await page.textContent("#message")}`);
  await page.press("#input", "Enter");

  // (d) 解体新書: どの読みにも続かないキー = 1 ミスで不正解（英単語と同じ）。答えと読みが出て、見せた読みを打って練習
  const w5 = W["concept-jh1-kaitaishinsho"];
  await waitUntil(() => promptIs(page, w5), 3000);
  await pressAll(page, "kai");
  await page.press("#input", "q");
  await page.waitForTimeout(150);
  check("(d) 違うキーで 思い出せず+1・ミスタイプ+1、答えと読みを表示",
    (await num(page, "#recallFail")) === 1 && (await num(page, "#miss")) === 1 && (await page.textContent("#word")).includes(w5.answer) &&
    (await page.textContent("#word .hidden-word__reading")) === readingOf(w5).display && (await page.textContent("#message")).includes("違う") && (await page.textContent("#typedPreview")) === "",
    `${await page.textContent("#word")} / ${await page.textContent("#message")}`);
  await pressAll(page, keysOf(w5));
  await waitUntil(async () => (await num(page, "#score")) === 5, 2000);
  check("(d) 答えを見たあと読みを打って練習できる（自力には数えない）", (await num(page, "#score")) === 5 && (await num(page, "#recalledToday")) === 4);
  // 答えを見た後の練習は 0.25 秒で次へ（Enter は要らない）

  // 聖武天皇: IME が打鍵を受け取った形（key=Process・keyCode 229）や JIS かな配列（key=かな）でも、物理キーの位置（code）でローマ字にする
  const w6 = W["concept-jh1-shomutenno"];
  await waitUntil(() => promptIs(page, w6), 3000);
  await page.focus("#input");
  await page.evaluate(() => {
    const input = document.getElementById("input");
    const send = (key, code) => input.dispatchEvent(new KeyboardEvent("keydown", { key, code, keyCode: 229, bubbles: true, cancelable: true }));
    send("Process", "KeyS");
    send("Process", "KeyH");
    send("Process", "KeyO");
    send("な", "KeyU"); // JIS かな配列の U キー
  });
  const p6 = await preview(page);
  check("ローマ字: IME の Process・かな配列のキーも code で読む（しょう ← s h o u）", same(p6, { kana: ["しょ", "う"], keys: ["sho", "u"], pending: "" }) && (await page.inputValue("#input")) === "shou", JSON.stringify(p6));
  await pressAll(page, keysOf(w6).slice(4));
  await waitUntil(async () => (await num(page, "#score")) === 6, 2000);
  check("ローマ字: 続きを打って 聖武天皇 が正解", (await num(page, "#score")) === 6);
  await page.press("#input", "Enter");

  // 万葉集: ヒントは読みの最初の 1 かな（ま）を打ったことにして見せる。ヒントを見たら思い出せず扱い
  const w7 = W["concept-jh1-manyoshu"];
  await waitUntil(() => promptIs(page, w7), 3000);
  await waitUntil(() => page.isVisible("#hintButton"), 3000);
  await page.click("#hintButton");
  await page.waitForTimeout(150);
  const p7 = await preview(page);
  const total7 = [...readingOf(w7).display].length;
  check("ローマ字: ヒントで読みの頭の字（ま）と字数。入力欄に ma が入る",
    (await page.textContent("#word")).startsWith("ま") && (await page.textContent("#word")).includes(`（${total7}文字）`) && same(p7, { kana: ["ま"], keys: ["ma"], pending: "" }) &&
    (await page.textContent("#message")).includes("頭の字は「ま」") && (await num(page, "#recallFail")) === 2,
    `${await page.textContent("#word")} / ${await page.textContent("#message")} / ${JSON.stringify(p7)}`);
  await pressAll(page, keysOf(w7).slice(2));
  await waitUntil(async () => (await num(page, "#score")) === 7, 2000);
  check("ローマ字: ヒントのあと続きを打って正解", (await num(page, "#score")) === 7);

  // 判定の単体（ブラウザで読み込んだ js/romaji.js）
  const unit = await page.evaluate(async () => {
    const r = await import("/js/romaji.js");
    const ok = (cands, keys) => { const m = r.matchRomaji(cands, keys); return m.alive && m.done; };
    const alive = (cands, keys) => r.matchRomaji(cands, keys).alive;
    return {
      shi: ok(["しんぶん"], "sinbun") && ok(["しんぶん"], "shinnbunn"),
      tsu: ok(["きって"], "kitte") && ok(["きって"], "kixtute") && ok(["つち"], "tuti"),
      cha: ok(["まっちゃ"], "matcha") && ok(["まっちゃ"], "maccha") && ok(["まっちゃ"], "mattya"),
      n: ok(["こんにちは"], "konnichiha") && !alive(["こんにちは"], "konichiha") && !alive(["かんい"], "kani") && ok(["かんい"], "kanni") && ok(["かんい"], "kan'i"),
      fu: ok(["ふじ"], "huzi") && ok(["ふじ"], "fuji"),
      ja: ok(["じゃま"], "zyama") && ok(["じゃま"], "jyama") && ok(["じゃま"], "jama"),
      kata: ok(["ファシズム"], "fasizumu"),
      dash: ok(["らーめん"], "ra-men") && !alive(["らーめん"], "raam"),
      prefix: (() => { const m = r.matchRomaji(["めいん", "めいんこんばーじょん"], "meinn"); return m.alive && m.done && m.finished === 0 && m.canGrow; })(),
      dzu: ok(["しょいんづくり"], "shoinzukuri") && ok(["しょいんづくり"], "shoindukuri") && ok(["あづちじょう"], "azuchijou")
    };
  });
  check("ローマ字の判定（shi/si・tsu/tu・っ・cha/tya・ん の nn/n'/n・fu/hu・ja/zya・カタカナ・ー・長い読みの手前・づ を zu）", Object.values(unit).every(Boolean), JSON.stringify(unit));
  check("ローマ字（中学歴史）でエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();

  // (e) カタカナの答え: ファシズム をローマ字で。かなは答えの表記どおりカタカナで出し、読みの行は出さない（答えがそのまま読み）
  const wF = byId("jhist2", "concept-jh2-fascism");
  const pageE = await newPage({ storage: resumeSeed("jhist2", [wF.id]) });
  await pageE.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await pageE.waitForTimeout(900);
  await pageE.press("#input", "Enter");
  await waitUntil(() => promptIs(pageE, wF), 3000);
  await pressAll(pageE, "fashizu");
  const pF = await preview(pageE);
  check("(e) カタカナの答え: ファ／シ／ズ の下に fa／shi／zu", same(pF, { kana: ["ファ", "シ", "ズ"], keys: ["fa", "shi", "zu"], pending: "" }), JSON.stringify(pF));
  await pressAll(pageE, "mu");
  await waitUntil(async () => (await num(pageE, "#score")) === 1, 2000);
  check("(e) fashizumu で ファシズム が正解（読みの行は出さない）", (await num(pageE, "#score")) === 1 && (await pageE.textContent("#word")).includes("ファシズム") && (await pageE.$("#word .hidden-word__reading")) === null);
  check("(e) カタカナの答えでエラー0", pageE.errors.length === 0, pageE.errors[0] ?? "");
  await pageE.close();

  // (f) 英字まじりの答え: X線 は x をそのまま打つ（えっくすせん でも可）
  const wX = byId("hs-physics", "concept-hph-xsen");
  const pageX = await newPage({ storage: resumeSeed("hs-physics", [wX.id]) });
  await pageX.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await pageX.waitForTimeout(900);
  await pageX.press("#input", "Enter");
  await waitUntil(() => promptIs(pageX, wX), 3000);
  await pressAll(pageX, "xse");
  const pX = await preview(pageX);
  check("(f) 英字まじり: X の下に x、せ の下に se", same(pX, { kana: ["X", "せ"], keys: ["x", "se"], pending: "" }), JSON.stringify(pX));
  await pressAll(pageX, "n");
  await waitUntil(async () => (await num(pageX, "#score")) === 1, 2000);
  check("(f) xsen で X線 が正解（語末の ん は n 1 つ）", (await num(pageX, "#score")) === 1 && same((await preview(pageX)).kana, ["X", "せ", "ん"]));
  check("(f) 英字まじりの答えでエラー0", pageX.errors.length === 0, pageX.errors[0] ?? "");
  await pageX.close();

  // (g) スマホ: 画面キーボードを「オフ」にしていても、ローマ字のカードでは盤面が出る（入力欄は読み取り専用で OS キーボードが出ないため）。ー のキーもある
  const wP = byId("jhist2", "concept-jh2-portsmouth");
  const pageM = await newPage({ mobile: true, viewport: { width: 390, height: 844 }, storage: resumeSeed("jhist2", [wP.id], { spelldash_osk: "off" }) });
  await pageM.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await pageM.waitForTimeout(900);
  await pageM.tap("#pathStart");
  await waitUntil(() => promptIs(pageM, wP), 3000);
  await pageM.waitForTimeout(200);
  check("(g) スマホ: ローマ字のカードは画面キーボード（A〜Z＋ー）、入力欄は読み取り専用・inputmode=none（OS キーボードを出さない）",
    (await pageM.isVisible("#osk")) && (await pageM.isVisible('#osk [data-action="dash"]')) && (await pageM.getAttribute("#input", "readonly")) !== null &&
    (await pageM.getAttribute("#input", "inputmode")) === "none" && (await pageM.$$("#osk [data-key]")).length === 26);
  for (const ch of keysOf(wP)) await pageM.tap(ch === "-" ? '#osk [data-action="dash"]' : `#osk [data-key="${ch}"]`);
  await waitUntil(async () => (await num(pageM, "#score")) === 1, 2000);
  check("(g) 画面キーボードのタップ（ー を含む）で ポーツマス条約 が正解", (await num(pageM, "#score")) === 1 && (await num(pageM, "#miss")) === 0, keysOf(wP));
  check("(g) スマホのローマ字でエラー0", pageM.errors.length === 0, pageM.errors[0] ?? "");
  await pageM.close();

  // (h) kanjiOnly（漢字の書き分け）は出さない: 続きからの列に残っていても飛ばし、出題の一覧にも入らない
  const jk2 = packWords("jkokugo2");
  const kOnly = jk2.filter((w) => w.kanjiOnly).slice(0, 2);
  const normal = jk2.find((w) => !w.kanjiOnly);
  const pageK = await newPage({ storage: resumeSeed("jkokugo2", [...kOnly.map((w) => w.id), normal.id]) });
  await pageK.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await pageK.waitForTimeout(900);
  await pageK.press("#input", "Enter");
  await pageK.waitForTimeout(500);
  const kInfo = await pageK.evaluate(async () => {
    const s = await import("/js/wordStore.js");
    return { inCategory: s.getWordsByCategory("jkokugo2").filter((w) => w.kanjiOnly).length, total: s.getWordsByCategory("jkokugo2").length };
  });
  check("(h) kanjiOnly のカードは続きからの列にあっても飛ばす（最初の出題は普通のカード）", await promptIs(pageK, normal), (await pageK.textContent("#japanese")).slice(0, 40));
  check("(h) kanjiOnly のカードは出題の一覧に入らない", kInfo.inCategory === 0 && kInfo.total === jk2.length - jk2.filter((w) => w.kanjiOnly).length, JSON.stringify(kInfo));
  await pageK.close();

  // 英単語のカードは従来どおり（入力欄は書ける・ローマ字の表示にしない）
  const pageEn = await newPage();
  await pageEn.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await pageEn.waitForTimeout(900);
  await pageEn.press("#input", "Enter");
  await pageEn.waitForTimeout(300);
  check("ローマ字: 英単語のカードは入力欄が書ける（readonly なし・案内は「英単語を入力」）",
    (await pageEn.getAttribute("#input", "readonly")) === null && (await pageEn.getAttribute("#input", "placeholder")) === "英単語を入力" && !(await pageEn.evaluate(() => document.body.classList.contains("romaji-answer"))));
  await pageEn.close();

  // Challenge: 語末の ん を n 1 つで終えた直後、癖で打った 2 つ目の n は次の語の 1 打目にしない（次の語はすぐ出る）
  const pageC = await newPage({ storage: { ...resumeSeed("jhist1", []), spelldash_mode: "challenge" } });
  await pageC.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await pageC.waitForTimeout(900);
  await pageC.press("#input", "Enter");
  await pageC.waitForTimeout(300);
  let swallowed = null;
  const jh1 = packWords("jhist1");
  for (let i = 0; i < 45 && swallowed === null; i++) { // 出題は無作為。jhist1 で ん で終わる読みは 75 枚中 11 枚なので、25 語では当たらない回が数 % あった → 45 語まで見る
    const q = (await pageC.textContent("#japanese")).trim();
    const w = jh1.find((x) => x.q === q);
    if (!w) break;
    const keys = keysOf(w);
    const m = matchRomaji(readingEntries(w), keys);
    const endsN = m.done && m.endedWithSingleN;
    const missBefore = await num(pageC, "#miss");
    await pressAll(pageC, endsN ? keys + "n" : keys); // 手前の短い読みで先に終われば、残りの打鍵は次の語に持ち越さない
    await pageC.waitForTimeout(80);
    if (endsN) swallowed = (await num(pageC, "#miss")) === missBefore && (await pageC.textContent("#typedPreview")) === "" && (await pageC.textContent("#japanese")).trim() !== q;
  }
  check("Challenge: 語末の ん を n で終えた直後の n は次の語に持ち越さない", swallowed === true, String(swallowed));
  check("Challenge（ローマ字）でエラー0", pageC.errors.length === 0, pageC.errors[0] ?? "");
  await pageC.close();

  // Challenge（次の語がすぐ出る）: 手前の短い読み（いわじゅく）で終えた直後、長い読みの続き（iseki）を間を空けずに打っても
  // 次の語の打鍵にしない。間が空いたキーは次の語の 1 打目。英字の別解しか無い自分の場面カードは全文入力（IME）のまま
  const myCards = [
    { kind: "concept", en: "iwajukuiseki", answer: "岩宿遺跡", q: "群馬県で関東ローム層から打製石器が見つかり、日本に旧石器時代があったと分かった遺跡", explain: "", accept: ["いわじゅくいせき", "いわじゅく"], ja: "" }
  ];
  const pageS = await newPage({ storage: { spelldash_my_words: JSON.stringify(myCards), spelldash_category: "my", spelldash_mode: "challenge", spelldash_placement: "done", spelldash_streak: JSON.stringify({ current: 1, best: 1, last: todayR }) } });
  await pageS.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await pageS.waitForTimeout(900);
  await pageS.press("#input", "Enter");
  await waitUntil(async () => (await pageS.textContent("#japanese")).trim() === myCards[0].q, 3000);
  await pressAll(pageS, "iwajukuiseki");
  await pageS.waitForTimeout(100);
  // 続きの最後の i は、次の語（同じカード。い から始まる）の頭としても通る引き分けなので、次の語に い として見せたまま次の打鍵で決める（REVIEW-149 の 7。
  // 続けて iwajuku を打てば ii は い に続かないので前の i を続きとして外し、いまの i を 1 打目にする＝下の score 2）
  const spill1 = { score: await num(pageS, "#score"), miss: await num(pageS, "#miss"), kana: (await preview(pageS)).kana };
  check("Challenge: いわじゅく で正解、続けて打った iseki は次の語のミスにしない（最後の i は次の語の頭でもある引き分け: い を見せたまま。それ以外は未入力）",
    spill1.score === 1 && spill1.miss === 0 && same(spill1.kana, ["い"]), JSON.stringify(spill1));
  await pressAll(pageS, "iwajuku");
  await waitUntil(async () => (await num(pageS, "#score")) === 2, 2000);
  await pageS.waitForTimeout(800); // 間が空いたら、次の語の打鍵として扱う
  await pressAll(pageS, "i");
  await pageS.waitForTimeout(100);
  const spill2 = { score: await num(pageS, "#score"), miss: await num(pageS, "#miss"), kana: (await preview(pageS)).kana };
  check("Challenge: 間を空けて打ったキーは次の語の 1 打目（い）", spill2.score === 2 && spill2.miss === 0 && same(spill2.kana, ["い"]), JSON.stringify(spill2));
  check("Challenge（持ち越し）でエラー0", pageS.errors.length === 0, pageS.errors[0] ?? "");
  await pageS.close();

  const pageL = await newPage({ storage: { spelldash_my_words: JSON.stringify([{ kind: "concept", en: "seo-x", answer: "検索エンジン最適化", q: "検索結果の上位に出るよう、サイトの構成や文章を整えること", explain: "", accept: ["SEO"], ja: "" }]), spelldash_category: "my", spelldash_placement: "done", spelldash_streak: JSON.stringify({ current: 1, best: 1, last: todayR }) } });
  await pageL.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await pageL.waitForTimeout(900);
  await pageL.press("#input", "Enter");
  await waitUntil(async () => (await pageL.textContent("#japanese")).trim().startsWith("検索結果の上位"), 3000);
  check("ローマ字: かなの読みが無い自分の場面カード（英字の別解だけ）は全文入力（入力欄は書ける）",
    (await pageL.getAttribute("#input", "readonly")) === null && !(await pageL.evaluate(() => document.body.classList.contains("romaji-answer"))) && (await pageL.evaluate(() => document.body.classList.contains("free-answer"))));
  check("全文入力の場面カードでエラー0", pageL.errors.length === 0, pageL.errors[0] ?? "");
  await pageL.close();
}

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
  check("道: 語が無いカテゴリ（空のマイ単語帳）には案内が出る（右頁）", (await pageG.textContent("#pathCard")).includes("まだ語が無い") && (await pageG.$("#pathCard a[href*='myWords']")) !== null);
  const emptyToc = await pageG.textContent("#pathList");
  check("道: 語が無い本の目次に「0章を終えると」の星は出ない", !emptyToc.includes("章を終えると") && (await pageG.$$("#pathList .path__node--goal")).length === 0, emptyToc.trim().slice(0, 80));
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
  check("道: 次の巻の名はまだ追加していないパックでも出る", (await pageH.textContent("#pathCard")).includes("中学英語 2年"));
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
  // 書斎: .room は isolation: isolate の重ね合わせ文脈。開いている間は部屋ごとヘッダーより前に出し、固定の暗幕がナビも覆う（css/room.css body.courses-open .room）
  check("コース: 開いている間は暗幕がヘッダーも覆う（ナビの位置を押すと暗幕）", await page.evaluate(() => document.elementFromPoint(innerWidth / 2, 20)?.classList.contains("path__courses-backdrop")));
  await page.click('.path__course-pick[data-course="toeic"]');
  await waitUntil(async () => (await page.textContent("#pathHead")).includes("第1巻／全6巻"), 4000); // パネルの文にも「TOEIC 500」があるので柱の巻の表示で待つ
  const st = await page.evaluate(() => ({ course: localStorage.getItem("spelldash_course"), category: localStorage.getItem("spelldash_category"), packs: JSON.parse(localStorage.getItem("spelldash_packs") || "[]") }));
  check("コース: TOEIC に乗り換えると toeic500 が追加されてカテゴリに", st.course === "toeic" && st.category === "toeic500" && st.packs.includes("toeic500") && (await page.textContent("#pathHead")).includes("第1巻／全6巻"), JSON.stringify(st));
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
  check("コース: 制覇済みの巻は飛ばして続きから", (await page2.evaluate(() => localStorage.getItem("spelldash_category"))) === "jhs-english2" && (await page2.textContent("#pathHead")).includes("第2巻／全8巻"));
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
  check("制覇の演出: 開始前は第1章／全11章・スタートは「スタート」だけ", (await page3.textContent("#pathCard")).includes("第1章／全11章") && (await page3.textContent("#pathStart")).trim() === "スタート", (await page3.textContent("#pathCard")).slice(0, 80));
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
  check("章済みの演出: 完了パネルの見出し直下に「「…」の章 済み」", sawLast && unitLine.includes("「") && unitLine.includes("」の章 済み") && unitPrev.includes("result-panel__title") && (await page3.textContent("#pathCard")).includes("第2章／全11章"), `sawLast=${sawLast} line=${unitLine} prev=${unitPrev}`);
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
  check("コースをまたぐ復習: セクション 2 の道のラベルに前セクションの期日「復習 3語から」", dueJa.size === 3 && labelX.includes("復習 3語から") && (await pageX.textContent("#pathHead")).includes("第2巻／全8巻"), labelX);
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
  check("道: 済み6章は「済み 4章」＋直前の2つに畳まれる", (await page.$$(".path__node--done:not(.path__node--fold)")).length === 2 && (await page.textContent(".path__node--fold")).includes("済み 4章") && (await page.textContent("#pathCard")).includes("第7章／全11章"));
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
    await afterAdvance(page);
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
    await afterAdvance(page2);
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
  check("アプリ: html.native-app が付き、起動時にステータスバーを帯の色に（文字は白・背景 #1A2137）", (await page.evaluate(() => document.documentElement.classList.contains("native-app") && document.documentElement.classList.contains("native-ios"))) && (await page.evaluate(() => window.__native.some((c) => c.plugin === "StatusBar" && c.method === "setStyle" && c.options.style === "DARK") && window.__native.some((c) => c.plugin === "StatusBar" && c.method === "setBackgroundColor" && c.options.color === "#1A2137"))));
  await page.click("#loginToggle");
  await page.waitForTimeout(150);
  check("アプリ: ログイン欄は Google／メールを隠して案内だけ", (await page.isVisible(".account-menu__native")) && !(await page.isVisible("#googleLoginButton")) && !(await page.isVisible("#emailInput")));
  await page.tap("#pathStart");
  await page.waitForTimeout(600);
  await page.tap('#osk [data-key="a"]');
  await page.waitForTimeout(100);
  check("アプリ: 専用キーボードのタップで Haptics が鳴る（ブリッジ経由）", await page.evaluate(() => window.__native.some((c) => c.plugin === "Haptics" && c.method === "impact")));
  await page.evaluate(async () => { const t = await import("/js/theme.js"); t.setTheme("dark"); });
  check("アプリ: ダークにするとステータスバーの背景も夜の帯 #04060B", await page.evaluate(() => window.__native.some((c) => c.plugin === "StatusBar" && c.method === "setBackgroundColor" && c.options.color === "#04060B")));
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

// ===== 16.5 判定: 出題語が別の正解の先頭部分（K0-1。gym／gymnasium・a／an・sport／sports） =====
// 以前は出題語を打ち切っても「まだ伸びる候補がある」として止め、Enter で答えが開いて×になっていた。
// 出題語を打ち切ったらその場で正解（D1）、Enter は打った語で確定（D2）、続けて打った長い候補の続きは次の語の打鍵にしない（D3）
console.log("judge (出題語が別の正解の先頭部分):");
{
  const A = await import("../js/answers.js");
  // ---- Node だけで見るもの: 全パック（data/manifest.json の全カテゴリ）を有効にしたときの、綴り入力の全カード ----
  // 候補は game.js と同じ作り方: js/wordData.js loadCategory と同じ変換で全カードを読み、buildAlternativeIndex（js/wordStore.js initWordStore）、
  // acceptedAnswers（js/wordStore.js answersFor → game.js setNewWord の answerCandidates）。綴り入力になるのは calc でなく答え（en）が a-z と - だけのカード
  // （game.js setNewWord: romajiEntriesFor は答えにかな・漢字が無ければ空、isFreeAnswer は /^[a-z-]+$/ でなければ全文入力）
  const manifestJ = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "manifest.json"), "utf8"));
  const allJ = [];
  for (const subject of manifestJ.subjects) {
    for (const category of subject.categories) {
      const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data", category.file), "utf8"));
      for (const word of data.words) {
        const base = {
          ...word, subject: data.subject, category: data.category,
          ...(category.pack ? { pack: true } : {}),
          ...(data.cardType === "grammar" ? { blank: true } : {}),
          ...(data.cardType === "school" ? { school: true } : {}),
          ...(data.cardType === "writing" ? { write: true, ...(data.wordBank ? { bank: true } : {}) } : {})
        };
        if (word.kind === "concept") {
          const answer = String(word.answer ?? word.en).trim();
          const spell = /^[a-z-]+$/i.test(answer);
          allJ.push({ ...base, key: word.en, en: spell ? answer.toLowerCase() : answer, accept: Array.isArray(word.accept) ? word.accept : [] });
        } else allJ.push(base);
      }
    }
  }
  const idxJ = A.buildAlternativeIndex(allJ);
  const spellJ = allJ.filter((w) => !w.calc && !w.kanjiOnly && /^[a-z-]+$/.test(w.en));
  const prefixCards = []; // 出題語が別の候補の先頭部分にあるカード
  const notDone = []; // 出題語を 1 字ずつ打って、打ち切った時点で出題語として完成しないカード
  const enterBad = [];
  const restsBad = [];
  const shortAlt = { n: 0, bad: [] }; // 出題語でない候補が、さらに長い候補の先頭部分（advertisement に対する ad・advert）
  for (const w of spellJ) {
    const cands = A.acceptedAnswers(w, idxJ);
    const longer = cands.filter((c) => c !== w.en && c.startsWith(w.en));
    if (longer.length > 0) prefixCards.push(`${w.category}:${w.en}→${longer.join(",")}`);
    let ok = cands[0] === w.en;
    for (let i = 1; ok && i <= w.en.length; i++) {
      const typed = w.en.slice(0, i);
      if (A.viableAnswers(cands, typed).length === 0) ok = false; // game.js handleKeydown／handleTextInput: 続く候補が無ければミス
      const done = A.completedAnswer(cands, typed); // game.js acceptChar
      if (i < w.en.length ? done !== null : done !== w.en) ok = false;
    }
    if (!ok) notDone.push(`${w.category}:${w.en}→${longer.join(",")}`);
    if (A.completedAnswer(cands, w.en, { force: true }) !== w.en) enterBad.push(`${w.category}:${w.en}`);
    const rests = A.continuationsOf(cands, w.en);
    if (rests.length !== longer.length || !longer.every((c) => rests.includes(c.slice(w.en.length)))) restsBad.push(`${w.category}:${w.en}`);
    for (const c of cands.slice(1)) {
      if (!cands.some((o) => o !== c && o.startsWith(c))) continue;
      shortAlt.n++;
      if (A.completedAnswer(cands, c) !== null || A.completedAnswer(cands, c, { force: true }) !== c) shortAlt.bad.push(`${w.category}:${w.en}/${c}`);
    }
  }
  const knownJ = ["jhs-english1:gym→gymnasium", "ngsl01:a→an", "highschool:sport→sports", "travel:photo→photograph"];
  check(`判定（全カード）: 出題語が別の候補の先頭部分にあるカードを数える（全パック有効。綴り入力 ${spellJ.length} 枚のうち ${prefixCards.length} 枚。gym／gymnasium・a／an・sport／sports・photo／photograph を含む）`,
    spellJ.length > 10000 && prefixCards.length >= 160 && knownJ.every((k) => prefixCards.some((p) => p === k || p.startsWith(k + ","))), `${spellJ.length} / ${prefixCards.length} / ${prefixCards.slice(0, 5).join(" ")}`);
  check(`判定（全カード）: 出題語を 1 字ずつ打つと、打ち切った時点で出題語として完成する（途中では終わらない。失敗 ${notDone.length} 枚）`, notDone.length === 0, notDone.slice(0, 8).join(" "));
  check("判定（全カード）: Enter は打った語で確定（出題語を打った状態の Enter は出題語。×にしない）", enterBad.length === 0, enterBad.slice(0, 8).join(" "));
  check("判定（全カード）: 出題語で完成したときの続き（gym → nasium）は、より長い候補の残りと同じ", restsBad.length === 0, restsBad.slice(0, 8).join(" "));
  check(`判定（全カード）: 出題語より短い別解（advertisement に対する ad・advert）は打ち切っても止めず、Enter で別解（${shortAlt.n} 件）`, shortAlt.n > 0 && shortAlt.bad.length === 0, shortAlt.bad.slice(0, 8).join(" "));

  // ---- ブラウザ ----
  const todayJ = ymd(new Date());
  const numJ = async (p, sel) => Number((await p.textContent(sel)).trim()) || 0;
  const jaJ = async (p) => (await p.textContent("#japanese")).trim();
  const statJ = (p, id) => p.evaluate((id) => JSON.parse(localStorage.getItem("spelldash_word_stats") || "{}")[id] ?? {}, id);
  const packJ = (pack) => JSON.parse(fs.readFileSync(path.join(ROOT, `data/packs/${pack}.json`), "utf8")).words;
  const jhs1 = packJ("jhs-english1");
  const gym = jhs1.find((w) => w.id === "english-gym");
  const door = jhs1.find((w) => w.id === "english-door"); // 頭の d は nasium のどの字とも違う（続きが次の語に流れれば 1 打目でミスになる）
  // 前回の続き（spelldash_session）に並べた順で出題させる（道のスタートの Enter = 続きから）。正解のあとは手応えだけ（0.25 秒）
  const seedJ = (pack, ids, extra = {}) => ({
    spelldash_packs: JSON.stringify([pack]), spelldash_category: pack, spelldash_placement: "done", spelldash_level_boost: "2",
    spelldash_after_correct: "quick", spelldash_audio: JSON.stringify({ mode: "off" }),
    spelldash_streak: JSON.stringify({ current: 1, best: 1, last: todayJ }),
    spelldash_session: JSON.stringify({ category: pack, focus: "", queue: ids, recalled: [], failed: [], newCount: 0, reviewCount: 0, setSize: 20, date: todayJ, savedAt: new Date().toISOString() }),
    ...extra
  });
  async function openJ(storage, first, opts = {}) {
    const p = await newPage({ storage, ...opts });
    await p.goto(BASE + "/index.html?hintms=600000", { waitUntil: "networkidle" });
    await p.waitForTimeout(700);
    if (opts.mobile) await p.tap("#pathStart");
    else await p.press("#input", "Enter");
    await waitUntil(async () => (await jaJ(p)) === (first.q ?? first.ja), 4000);
    await p.waitForTimeout(150);
    return p;
  }
  // ページの中でキーを時刻どおりに送る（keydown。plan: [{ at, key }]）。各キーを送った時点の出題文も控える
  const sendTimedJ = (p, plan, settleMs = 700) => p.evaluate(({ plan, settleMs }) => new Promise((resolve) => {
    const input = document.getElementById("input");
    const text = (id) => document.getElementById(id)?.textContent.trim() ?? "";
    const log = [];
    for (const { at, key } of plan) {
      setTimeout(() => {
        log.push({ key, ja: text("japanese") });
        input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      }, at);
    }
    setTimeout(() => resolve({ log, ja: text("japanese"), input: input.value, preview: text("typedPreview"), score: text("score"), miss: text("miss"), recallFail: text("recallFail") }), Math.max(...plan.map((k) => k.at)) + settleMs);
  }), { plan, settleMs });

  // (1) gym を Study で自力で打つ: 打ち切った時点で正解・思い出せた（以前は gymnasium が残って止まり、Enter で×）
  {
    const p = await openJ(seedJ("jhs-english1", [gym.id, door.id]), gym);
    for (const ch of "gym") await p.press("#input", ch);
    await waitUntil(async () => (await numJ(p, "#score")) === 1, 1500);
    const st = await statJ(p, gym.id);
    check("判定 (1) gym（体育館）を打ち切った時点で正解・思い出せた（gymnasium が残っていても止めない。×なし）",
      (await numJ(p, "#score")) === 1 && (await numJ(p, "#recalledToday")) === 1 && (await numJ(p, "#recallFail")) === 0 && (await numJ(p, "#miss")) === 0 && (st.recallFail ?? 0) === 0 && !!st.lastRecallSuccessAt,
      `${await numJ(p, "#score")} / ${await numJ(p, "#recallFail")} / ${JSON.stringify(st)}`);
    check("判定 (1) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (2) gymnasium まで打ち続ける: gym で正解、nasium は次の語の打鍵にならない。正解後の待ち（0.25 秒）の間に続きを打ち始めたら、
  // 続きを打っている間はタイマーで次の語を出さない（打ち終えてから出す）。窓（最後の打鍵から 0.6 秒）を過ぎてから打てば、次の語は普通に打てる
  {
    const p = await openJ(seedJ("jhs-english1", [gym.id, door.id]), gym);
    const plan = [..."gym"].map((key, i) => ({ at: i * 60, key })).concat([..."nasium"].map((key, i) => ({ at: 220 + i * 100, key })));
    const r = await sendTimedJ(p, plan);
    const cont = r.log.slice(3);
    const during = cont.filter((e) => e.ja === gym.ja).length;
    check("判定 (2) gymnasium と打ち続けても gym で正解。続きを打っている間は次の語を出さず（待ちを延ばす）、nasium は次の語の打鍵にしない（ミス 0・次の語は未入力）",
      r.score === "1" && r.miss === "0" && r.recallFail === "0" && r.ja === door.ja && r.input === "" && r.preview === "" && during === 6,
      JSON.stringify({ ...r, log: r.log.map((e) => `${e.key}:${e.ja === gym.ja ? "gym" : e.ja === door.ja ? "door" : e.ja}`).join(" ") }));
    for (const ch of door.en) await p.press("#input", ch);
    await waitUntil(async () => (await numJ(p, "#score")) === 2, 1500);
    check("判定 (2) 窓を過ぎてから打った次の語（door）は普通に正解", (await numJ(p, "#score")) === 2 && (await numJ(p, "#miss")) === 0 && (await numJ(p, "#recallFail")) === 0);
    check("判定 (2) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (2b) Enter で自分から次へ進んだときは続きを捨てる（次の語の 1 打目から受け付ける）。次の語 name の n は、gymnasium の続きの n と同じ字でも name の 1 打目
  {
    const name = jhs1.find((w) => w.id === "english-name");
    const p = await openJ(seedJ("jhs-english1", [gym.id, name.id], { spelldash_after_correct: "long" }), gym);
    const r = await sendTimedJ(p, [{ at: 0, key: "g" }, { at: 60, key: "y" }, { at: 120, key: "m" }, { at: 200, key: "Enter" }, { at: 280, key: "n" }], 300);
    check("判定 (2b) Enter で自分から次へ進んだら続きは捨て、次の語の 1 打目から受け付ける（name の n が入る）",
      r.score === "1" && r.ja === name.ja && r.miss === "0" && r.preview === "n", JSON.stringify(r));
    check("判定 (2b) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (2c) 画面キーボード（スマホ。keydown を合成）でも、gym の後の nasium は次の語に入れない
  {
    const p = await openJ(seedJ("jhs-english1", [gym.id, door.id], { spelldash_osk: "on" }), gym, { mobile: true, viewport: { width: 390, height: 844 } });
    const visible = await p.isVisible("#osk");
    const r = await p.evaluate(() => new Promise((resolve) => {
      const tap = (k) => document.querySelector(`#osk [data-key="${k}"]`)?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "touch" }));
      const text = (id) => document.getElementById(id)?.textContent.trim() ?? "";
      [..."gymnasium"].forEach((k, i) => setTimeout(() => tap(k), i < 3 ? i * 60 : 220 + (i - 3) * 100));
      setTimeout(() => resolve({ ja: text("japanese"), score: text("score"), miss: text("miss"), recallFail: text("recallFail"), preview: text("typedPreview"), input: document.getElementById("input").value }), 1450);
    }));
    check("判定 (2c) 画面キーボードで gymnasium と打っても gym で正解・nasium は次の語のミスにならない",
      visible && r.score === "1" && r.miss === "0" && r.recallFail === "0" && r.ja === door.ja && r.preview === "" && r.input === "", JSON.stringify({ visible, ...r }));
    check("判定 (2c) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (3) Challenge（次の語がすぐ出る）: highschool の sport（accept sports）を sports と打つ → sport で正解、続きの s は次の語のミスにならない。
  // ジャンル「スポーツ」（team・game・sport の 3 語）に絞って sport が出るまで回す
  const hsSports = JSON.parse(fs.readFileSync(path.join(ROOT, "data/english/highschool.json"), "utf8")).words.filter((w) => (w.tags ?? [])[0] === "sports");
  const sportW = hsSports.find((w) => w.en === "sport");
  const challengeSeedJ = { spelldash_category: "highschool", spelldash_genre: "sports", spelldash_mode: "challenge", spelldash_placement: "done", spelldash_level_boost: "2", spelldash_audio: JSON.stringify({ mode: "off" }), spelldash_streak: JSON.stringify({ current: 1, best: 1, last: todayJ }) };
  // via: "key"（物理キーの keydown）／"input"（Android の input イベント。1 字ずつ値を伸ばす）
  async function challengeSports(via) {
    const p = await newPage({ storage: challengeSeedJ });
    await p.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await p.waitForTimeout(700);
    await p.press("#input", "Enter");
    await waitUntil(async () => (await jaJ(p)) !== "", 3000);
    let result = null;
    for (let i = 0; i < 24 && result === null; i++) {
      const ja = await jaJ(p);
      const w = hsSports.find((x) => x.ja === ja);
      if (!w) break;
      const missBefore = await numJ(p, "#miss");
      const failBefore = await numJ(p, "#recallFail");
      const typed = w === sportW ? "sports" : w.en;
      // 1 字ずつ送り、各字を送る直前の出題文を控える（sports の最後の s を送る時点で、sport で完成して次の語が出ているか）
      const sentAt = await p.evaluate(({ typed, via }) => new Promise((resolve) => {
        const input = document.getElementById("input");
        const seen = [];
        [...typed].forEach((ch, k) => setTimeout(() => {
          seen.push(document.getElementById("japanese").textContent.trim());
          if (via === "input") {
            input.value += ch; // Gboard 等: keydown は Unidentified、入力欄の値が 1 字ずつ伸びる
            input.dispatchEvent(new Event("input", { bubbles: true }));
          } else input.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
        }, k * 70));
        setTimeout(() => resolve(seen), typed.length * 70 + 120);
      }), { typed, via });
      if (w === sportW) {
        result = {
          movedBeforeS: sentAt.at(-1) !== ja, miss: (await numJ(p, "#miss")) - missBefore, recallFail: (await numJ(p, "#recallFail")) - failBefore,
          moved: (await jaJ(p)) !== ja, input: await p.inputValue("#input"), preview: (await p.textContent("#typedPreview")).trim(), score: await numJ(p, "#score")
        };
      }
      await p.waitForTimeout(700); // 続きの窓（0.6 秒）を過ぎてから次の語へ
    }
    const errors = [...p.errors];
    await p.close();
    return { result, errors };
  }
  {
    const { result, errors } = await challengeSports("key");
    check("判定 (3) Challenge: sport を sports と打つと sport で正解（s の前に次の語が出る）、続きの s は次の語の打鍵にしない（ミス 0・次の語は未入力）",
      !!result && result.movedBeforeS && result.miss === 0 && result.recallFail === 0 && result.moved && result.input === "" && result.preview === "" && result.score >= 1, JSON.stringify(result));
    check("判定 (3) でエラー0", errors.length === 0, errors[0] ?? "");
  }
  {
    const { result, errors } = await challengeSports("input");
    check("判定 (3b) Challenge・Android の input 経路（1 字ずつ）でも、sport で正解して続きの s は次の語の打鍵にしない",
      !!result && result.movedBeforeS && result.miss === 0 && result.recallFail === 0 && result.moved && result.input === "" && result.preview === "" && result.score >= 1, JSON.stringify(result));
    check("判定 (3b) でエラー0", errors.length === 0, errors[0] ?? "");
  }

  // (4)(6) 出題語より短い別解は今までどおり: ngsl17 の advertisement（accept ad・advert・commercial）。ad・advert は打ち切っても止めず
  // （advertisement が残る）、Enter で別解として受ける（×にしない。この問題の語を見せて打ち直し）
  // D2（Enter は打った語で確定）の出題語の側は、D1 の後は「出題語に一致したまま止まる」状態を打鍵・ヒント・input 経路のどれでも作れない
  // （acceptChar がその場で完成させる）ので、ブラウザで区別できるのは別解の側だけ。出題語の側は node の段（Enter・force）で見て、game.js では守りとして残す
  const ngsl17 = packJ("ngsl17");
  const adv = ngsl17.find((w) => w.id === "english-advertisement");
  const advNext = ngsl17.find((w) => w.id !== adv.id && /^[a-z]+$/.test(w.en) && !w.accept?.length && !"adv".includes(w.en[0]));
  for (const [label, typed] of [["(4) ad", "ad"], ["(6) advert", "advert"]]) {
    const p = await openJ(seedJ("ngsl17", [adv.id, advNext.id]), adv);
    for (const ch of typed) await p.press("#input", ch);
    await p.waitForTimeout(300);
    const waiting = (await numJ(p, "#score")) === 0 && (await p.textContent("#typedPreview")).trim() === typed && (await numJ(p, "#recallFail")) === 0 && (await p.textContent("#word")).trim() !== adv.en;
    await p.press("#input", "Enter");
    await p.waitForTimeout(300);
    const msg = (await p.textContent("#message")).trim();
    const st = await statJ(p, adv.id);
    check(`判定 ${label}: 出題語 advertisement に対して ${typed} を打ち切っても止めない（advertisement が残る）`, waiting, `${await numJ(p, "#score")} / ${(await p.textContent("#typedPreview")).trim()}`);
    check(`判定 ${label}: Enter で別解として受ける（「${typed} も…この問題の語は advertisement」・×なし・答えを見せる）`,
      msg.includes(typed) && msg.includes(adv.en) && (await numJ(p, "#recallFail")) === 0 && (st.recallFail ?? 0) === 0 && (await p.textContent("#word")).trim() === adv.en && (await numJ(p, "#score")) === 0,
      `${msg} / ${JSON.stringify(st)}`);
    for (const ch of adv.en) await p.press("#input", ch);
    await waitUntil(async () => (await numJ(p, "#score")) === 1, 1500);
    check(`判定 ${label}: そのあと出題語を打つと正解（自力には数えない）`, (await numJ(p, "#score")) === 1 && (await numJ(p, "#recalledToday")) === 0);
    check(`判定 ${label} でエラー0`, p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (5) Android の input 経路: 入力欄の値に gymnasium を一度に入れて input イベント（予測変換の一括挿入）→ gym で完成し、残りは捨てる
  {
    const p = await openJ(seedJ("jhs-english1", [gym.id, door.id]), gym);
    const r = await p.evaluate(() => new Promise((resolve) => {
      const input = document.getElementById("input");
      const text = (id) => document.getElementById(id)?.textContent.trim() ?? "";
      input.value = "gymnasium";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const first = { score: text("score"), input: input.value, preview: text("typedPreview") };
      setTimeout(() => resolve({ first, ja: text("japanese"), score: text("score"), miss: text("miss"), recallFail: text("recallFail"), input: input.value, preview: text("typedPreview") }), 900);
    }));
    check("判定 (5) Android の input 経路: 値に gymnasium を一度に入れても gym で完成（正解・×なし）し、残りの nasium は捨てる",
      r.first.score === "1" && r.first.input === "gym" && r.first.preview === "gym" && r.recallFail === "0" && r.miss === "0" && r.ja === door.ja && r.input === "" && r.preview === "", JSON.stringify(r));
    check("判定 (5) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  // (5b) Android の input 経路で 1 字ずつ（Gboard）: gymnasium と打ち続けても gym で正解。続きを打っている間は次の語を出さず、続きは次の語に入れない
  {
    const p = await openJ(seedJ("jhs-english1", [gym.id, door.id]), gym);
    const r = await p.evaluate(({ gymJa, doorJa }) => new Promise((resolve) => {
      const input = document.getElementById("input");
      const text = (id) => document.getElementById(id)?.textContent.trim() ?? "";
      const log = [];
      [..."gymnasium"].forEach((ch, i) => setTimeout(() => {
        log.push(`${ch}:${text("japanese") === gymJa ? "gym" : text("japanese") === doorJa ? "door" : "?"}`);
        input.value += ch;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, i < 3 ? i * 60 : 220 + (i - 3) * 100));
      setTimeout(() => resolve({ log: log.join(" "), ja: text("japanese"), score: text("score"), miss: text("miss"), recallFail: text("recallFail"), input: input.value, preview: text("typedPreview") }), 1450);
    }), { gymJa: gym.ja, doorJa: door.ja });
    check("判定 (5b) Android の input 経路（1 字ずつ）: gymnasium と打ち続けても gym で正解、続きを打っている間は次の語を出さず、nasium は次の語に入れない",
      r.score === "1" && r.miss === "0" && r.recallFail === "0" && r.ja === door.ja && r.input === "" && r.preview === "" && r.log.split(" ").slice(3).every((e) => e.endsWith(":gym")), JSON.stringify(r));
    check("判定 (5b) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // ---- 続きの打ち方のゆれ（REVIEW の M1・M2・S1・S3、回帰の S2）: どれも次の語に×・ミスを付けない ----
  // ページの中でキーを時刻どおりに送る。plan の at は最初のキーから、afterChange の at は出題文が変わってから（次の語が出てから）。
  // via: "key"（keydown）／"input"（Android の input イベント。入力欄の値に 1 字ずつ足す。Enter は keydown）／
  // "type"（keydown。止められなかった字は実キーと同じく入力欄に入れる。全文入力の語に字が入るかを見る）
  const sendPlanJ = (p, { plan = [], afterChange = [], via = "key", settleMs = 600 }) => p.evaluate(({ plan, afterChange, via, settleMs }) => new Promise((resolve) => {
    const input = document.getElementById("input");
    const ja = document.getElementById("japanese");
    const text = (id) => document.getElementById(id)?.textContent.trim() ?? "";
    const ja0 = ja.textContent.trim();
    const log = [];
    const t0 = performance.now();
    let changedAt = null;
    const send = (key) => {
      log.push({ key, ja: ja.textContent.trim(), t: Math.round(performance.now() - t0) });
      if (key !== "Enter" && via === "input") {
        input.value += key;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }
      const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      input.dispatchEvent(ev);
      // via "type": 実キーと同じく、止められなかった 1 字は入力欄（カーソルの位置）に入り input イベントが出る（合成の keydown はブラウザが字を入れない）
      if (via === "type" && !ev.defaultPrevented && key.length === 1 && !input.readOnly) {
        input.setRangeText(key, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length, "end");
        input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: key }));
      }
    };
    let pending = afterChange.length ? 2 : 1;
    const done = () => {
      if (--pending > 0) return;
      resolve({ log, changedAt, ja: text("japanese"), word: text("word"), input: input.value, preview: text("typedPreview"), score: text("score"), miss: text("miss"), recallFail: text("recallFail") });
    };
    for (const { at, key } of plan) setTimeout(() => send(key), at);
    setTimeout(done, Math.max(0, ...plan.map((k) => k.at)) + settleMs);
    if (afterChange.length) {
      const mo = new MutationObserver(() => {
        if (changedAt !== null || ja.textContent.trim() === ja0) return;
        mo.disconnect();
        changedAt = Math.round(performance.now() - t0);
        for (const { at, key } of afterChange) setTimeout(() => send(key), at);
        setTimeout(done, Math.max(...afterChange.map((k) => k.at)) + settleMs);
      });
      mo.observe(ja, { childList: true, characterData: true, subtree: true });
      setTimeout(() => { if (changedAt === null) { mo.disconnect(); done(); } }, 10000);
    }
  }), { plan, afterChange, via, settleMs });
  const logJ = (r, names) => r.log.map((e) => `${e.key}@${e.t}:${names[e.ja] ?? e.ja.slice(0, 6)}`).join(" ");
  // 次の語を打ち切って、ミスも×もなく正解になるか（前の語の続きが次の語に残っていない）
  async function typeNextJ(p, word, scoreBefore) {
    for (const ch of word.en) await p.press("#input", ch);
    await waitUntil(async () => (await numJ(p, "#score")) === scoreBefore + 1, 2000);
    return (await numJ(p, "#score")) === scoreBefore + 1 && (await numJ(p, "#miss")) === 0 && (await numJ(p, "#recallFail")) === 0;
  }
  const namesGym = { [gym.ja]: "gym", [door.ja]: "door" };
  const ngsl01 = packJ("ngsl01");
  const [aW, sixW, nineW, notW] = ["english-a", "english-six", "english-nine", "english-not"].map((id) => ngsl01.find((w) => w.id === id));

  // (2d) タイマーで次の語が出た後に続きを打ち始める（窓の中）: 次の語の頭と違う字でも同じ字でも続きとして飲み、次の語は未入力
  {
    const p = await openJ(seedJ("jhs-english1", [gym.id, door.id]), gym);
    const r = await sendPlanJ(p, { plan: [..."gym"].map((key, i) => ({ at: i * 60, key })), afterChange: [..."nasium"].map((key, i) => ({ at: 40 + i * 100, key })) });
    const after = r.log.slice(3).filter((e) => e.ja === door.ja).length;
    check("判定 (2d) タイマーで次の語が出た後に打った続き（窓の中）も次の語の打鍵にしない（ミス 0・次の語は未入力）",
      r.score === "1" && r.miss === "0" && r.recallFail === "0" && r.ja === door.ja && r.input === "" && r.preview === "" && after === 6, JSON.stringify({ ...r, log: logJ(r, namesGym) }));
    check("判定 (2d) そのあと次の語（door）は普通に正解", await typeNextJ(p, door, 1));
    check("判定 (2d) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (7) ゆっくり打つ人（1 打 0.9 秒）の続き: 窓（0.6 秒）の外でも、次の語の 1 打目がミスになる字が続きの次の字なら続きとして飲む（REVIEW-judge M1）。
  // 正解のあとは標準（例文つきの語は 0.7 秒）。続きは次の語が出てから届く
  for (const via of ["key", "input"]) {
    const p = await openJ(seedJ("jhs-english1", [gym.id, door.id], { spelldash_after_correct: "standard" }), gym);
    const plan = [{ at: 0, key: "g" }, { at: 80, key: "y" }, { at: 160, key: "m" }].concat([..."nasium"].map((key, i) => ({ at: 160 + (i + 1) * 900, key })));
    const r = await sendPlanJ(p, { plan, via, settleMs: 300 });
    const label = via === "key" ? "keydown" : "Android の input 経路";
    check(`判定 (7) ${label}: gymnasium を 1 打 0.9 秒で打っても gym で正解、続きは次の語（door）のミスにも×にもしない`,
      r.score === "1" && r.miss === "0" && r.recallFail === "0" && r.ja === door.ja && r.input === "" && r.preview === "", JSON.stringify({ ...r, log: logJ(r, namesGym) }));
    check(`判定 (7) ${label}: そのあと次の語（door）は普通に正解`, await typeNextJ(p, door, 1));
    check(`判定 (7) ${label} でエラー0`, p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  // (7b) a に an を 0.9 秒あけて打つ → 次の語 six は×にならず、そのあと普通に打てる
  {
    const p = await openJ(seedJ("ngsl01", [aW.id, sixW.id], { spelldash_after_correct: "standard" }), aW);
    const r = await sendPlanJ(p, { plan: [{ at: 0, key: "a" }, { at: 900, key: "n" }], settleMs: 300 });
    check("判定 (7b) a に an を 0.9 秒あけて打っても、n は次の語（six）のミスにも×にもしない",
      r.score === "1" && r.miss === "0" && r.recallFail === "0" && r.ja === sixW.ja && r.preview === "", JSON.stringify({ ...r, log: logJ(r, { [aW.ja]: "a", [sixW.ja]: "six" }) }));
    check("判定 (7b) そのあと six は普通に正解", await typeNextJ(p, sixW, 1));
    check("判定 (7b) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (8) 続きを打ち終えてから Enter（打ち終えたら Enter で次への癖）: タイマーで次の語が出た後に 1 打 0.25 秒で nasium、最後の打鍵の 0.2 秒後に Enter。
  // 次の語の答えを開かない（×にしない。続きの最後の打鍵から 1.2 秒の守り）（REVIEW-keys M1）
  {
    const p = await openJ(seedJ("jhs-english1", [gym.id, door.id]), gym);
    const r = await sendPlanJ(p, {
      plan: [{ at: 0, key: "g" }, { at: 80, key: "y" }, { at: 160, key: "m" }],
      afterChange: [..."nasium"].map((key, i) => ({ at: 50 + i * 250, key })).concat([{ at: 50 + 5 * 250 + 200, key: "Enter" }]),
      settleMs: 300
    });
    check("判定 (8) 続き（nasium）を 1 打 0.25 秒で打ち終えてから Enter しても、次の語（door）の答えを開かない（×なし・ミス 0）",
      r.score === "1" && r.miss === "0" && r.recallFail === "0" && r.ja === door.ja && r.word !== door.en && r.preview === "", JSON.stringify({ ...r, log: logJ(r, namesGym) }));
    check("判定 (8) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (9) 続きの途中で 0.6 秒より長く手が止まる（スマホでゆっくり・綴りを思い出しながら）: 正解後の待ちの間に続きを打ち始めたら、
  // 続きを打っている間（最後の続きの打鍵から 1.5 秒）は次の語を出さない。次の語に×もミスも付かない（REVIEW-keys M2）
  // 待ちの間に続きを打ち切ったら、次の語は続きの最後の打鍵から 0.25 秒（SPILL_TAIL_MS）で出る（本来の待ちの長さまでの次の語の 1 打目の守りは (32)）。
  // gymna の後で 2.5 秒迷う: 次の語が出てから届く s は窓の外だが、窓の外の上限（最後の打鍵から 4 秒）の中なので続きとして飲む（V-S3。以前の上限 2 秒では次の語の×）
  for (const [label, via, plan] of [
    ["1 打 0.65 秒（keydown）", "key", [0, 250, 500, 1150, 1800, 2450, 3100, 3750, 4400]],
    ["1 打 0.65 秒（Android の input 経路）", "input", [0, 250, 500, 1150, 1800, 2450, 3100, 3750, 4400]],
    ["gymna の後で 0.9 秒迷う（keydown）", "key", [0, 250, 500, 750, 1000, 1900, 2150, 2400, 2650]],
    ["gymna の後で 2.5 秒迷う（keydown）", "key", [0, 250, 500, 750, 1000, 3500, 3750, 4000, 4250]],
    ["gymna の後で 2.5 秒迷う（Android の input 経路）", "input", [0, 250, 500, 750, 1000, 3500, 3750, 4000, 4250]]
  ]) {
    const p = await openJ(seedJ("jhs-english1", [gym.id, door.id], { spelldash_after_correct: "standard" }), gym);
    const r = await sendPlanJ(p, { plan: [..."gymnasium"].map((key, i) => ({ at: plan[i], key })), via, settleMs: 1100 });
    check(`判定 (9) ${label}: gym で正解、続きは次の語（door）のミスにも×にもしない（次の語は未入力）`,
      r.score === "1" && r.miss === "0" && r.recallFail === "0" && r.ja === door.ja && r.input === "" && r.preview === "", JSON.stringify({ ...r, log: logJ(r, namesGym) }));
    check(`判定 (9) ${label}: そのあと次の語（door）は普通に正解`, await typeNextJ(p, door, 1));
    check(`判定 (9) ${label} でエラー0`, p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (10) 窓の中では次の語の頭と同じキーでも前の語の続きとして通る（D3。ローマ字と同じ）: a の直後、次の語 nine が出てから 0.17 秒の n は、
  // an の続きでも nine の頭でもある（引き分け）。引き分けの字は次の語に入れたまま見せ（preview "n"）、ミスにしない（REVIEW-regress S2 の MI。
  // REVIEW-149 の 7: 続きと次の語の両方に食わせ、どちらかが拒んだ時点で解決する）。そのあと nine を 1 打目から打つと、nn は nine に続かず
  // an の続きは n で終わっているので、前の n を an の続きとして外していまの n を nine の 1 打目にする（nine は×にならず正解）
  {
    const p = await openJ(seedJ("ngsl01", [aW.id, nineW.id]), aW);
    const r = await sendPlanJ(p, { plan: [{ at: 0, key: "a" }], afterChange: [{ at: 170, key: "n" }], settleMs: 500 });
    const nAt = r.log[1];
    check("判定 (10) 窓の中の n は、次の語（nine）の頭と同じでも前の語（a → an）の続きとして通る（引き分け: 次の語に n を見せたまま・ミス 0・×なし）",
      r.score === "1" && r.miss === "0" && r.recallFail === "0" && nAt?.ja === nineW.ja && r.ja === nineW.ja && r.preview === "n" && r.input === "n", JSON.stringify({ ...r, log: logJ(r, { [aW.ja]: "a", [nineW.ja]: "nine" }) }));
    check("判定 (10) そのあと nine を 1 打目から打つと、前の n を an の続きとして外して正解（ミス 0・×なし）", await typeNextJ(p, nineW, 1));
    check("判定 (10) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  // (10b) 引き分けのまま 4 秒（SPILL_LATE_MS）打鍵が止まっても、見せている n は消さない（見えている字を本人の操作なしに消すと、見えていた字に続けて打つ人が×になる。
  // REVIEW-judge S3・REVIEW-keys S2）。続きの見方は終わるので、見えていた n に続けて ine と打てば nine の正解。(10c) nine を 1 打目から打ち直しても前の n を外して正解
  {
    const p = await openJ(seedJ("ngsl01", [aW.id, nineW.id]), aW);
    const r = await sendPlanJ(p, { plan: [{ at: 0, key: "a" }], afterChange: [{ at: 170, key: "n" }], settleMs: 4400 });
    check("判定 (10b) 引き分けの n のまま 4 秒止まっても、n は次の語に見せたまま（preview \"n\"・ミス 0・×なし）",
      r.score === "1" && r.miss === "0" && r.recallFail === "0" && r.ja === nineW.ja && r.preview === "n" && r.input === "n", JSON.stringify({ ...r, log: logJ(r, { [aW.ja]: "a", [nineW.ja]: "nine" }) }));
    for (const ch of "ine") await p.press("#input", ch);
    await waitUntil(async () => (await numJ(p, "#score")) === 2, 2000);
    check("判定 (10b) 見えていた n に続けて ine と打てば nine の正解（ミス 0・×なし）", (await numJ(p, "#score")) === 2 && (await numJ(p, "#miss")) === 0 && (await numJ(p, "#recallFail")) === 0);
    check("判定 (10b) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  {
    const p = await openJ(seedJ("ngsl01", [aW.id, nineW.id]), aW);
    const r = await sendPlanJ(p, { plan: [{ at: 0, key: "a" }], afterChange: [{ at: 170, key: "n" }], settleMs: 4400 });
    check("判定 (10c) 4 秒止まった後に nine を 1 打目から打ち直しても、前の n を外して正解（ミス 0・×なし）", r.preview === "n" && (await typeNextJ(p, nineW, 1)), JSON.stringify(r));
    check("判定 (10c) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (11) 窓の中で続きとして飲んだキーが、実は次の語の頭だった（速い人。a の直後に次の語 not を打つ）: n を an の続きとして飲んでも、
  // 次の o が not に続かず n＋o なら続くので、n を not に戻す（not は×にならず正解）（REVIEW-judge S1・REVIEW-keys S1）
  for (const via of ["key", "input"]) {
    const p = await openJ(seedJ("ngsl01", [aW.id, notW.id]), aW);
    const r = await sendPlanJ(p, { plan: [{ at: 0, key: "a" }], afterChange: [{ at: 80, key: "n" }, { at: 160, key: "o" }, { at: 240, key: "t" }], via, settleMs: 500 });
    const label = via === "key" ? "keydown" : "Android の input 経路";
    check(`判定 (11) ${label}: a の直後に打った not は、n を an の続きとして飲んでも o で戻して正解（ミス 0・×なし）`,
      r.score === "2" && r.miss === "0" && r.recallFail === "0", JSON.stringify({ ...r, log: logJ(r, { [aW.ja]: "a", [notW.ja]: "not" }) }));
    check(`判定 (11) ${label} でエラー0`, p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (12) Android の input 経路: 予測変換で gymna までが一度に入り、残りの s・i・u・m を 1 字ずつ打つ → 次の語は未入力・ミス 0（REVIEW-regress S2 の MF）
  {
    const p = await openJ(seedJ("jhs-english1", [gym.id, door.id]), gym);
    const r = await p.evaluate(() => new Promise((resolve) => {
      const input = document.getElementById("input");
      const text = (id) => document.getElementById(id)?.textContent.trim() ?? "";
      input.value = "gymna";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      [..."sium"].forEach((ch, i) => setTimeout(() => {
        input.value += ch;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, 100 + i * 100));
      setTimeout(() => resolve({ ja: text("japanese"), score: text("score"), miss: text("miss"), recallFail: text("recallFail"), input: input.value, preview: text("typedPreview") }), 1300);
    }));
    check("判定 (12) Android の input 経路: gymna が一度に入り、残りを 1 字ずつ打っても gym で正解・続きは次の語に入れない",
      r.score === "1" && r.miss === "0" && r.recallFail === "0" && r.ja === door.ja && r.input === "" && r.preview === "", JSON.stringify(r));
    check("判定 (12) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (13) 空白を含む続き（grammar-hs2 の a number of: 答え a、accept a large・a good・a great）を Android の input 経路で打つ:
  // 値には空白も入るが判定は a-z だけを見るので、続きの頭の空白を読み飛ばして比べる（REVIEW-keys S3）
  {
    const gh2 = packJ("grammar-hs2");
    const aNum = gh2.find((w) => w.id === "concept-gh2-art-a-number-of");
    const spellGh2 = (w) => w.kind === "concept" && /^[a-z]+$/.test(String(w.answer ?? "")) && !(w.accept ?? []).length;
    const gh2Next = gh2.find((w) => w.id !== aNum.id && spellGh2(w) && !"largeodt ".includes(String(w.answer)[0]));
    const p = await openJ(seedJ("grammar-hs2", [aNum.id, gh2Next.id]), aNum);
    const r = await sendPlanJ(p, { plan: [..."a large"].map((key, i) => ({ at: i * 100, key })), via: "input", settleMs: 600 });
    check("判定 (13) Android の input 経路: a に a large と打っても a で正解、空白をはさんだ続き（large）は次の語のミスにしない",
      !!gh2Next && r.score === "1" && r.miss === "0" && r.recallFail === "0" && r.ja === gh2Next.q && r.input === "" && r.preview === "", JSON.stringify({ ...r, next: gh2Next?.answer, log: logJ(r, {}) }));
    check("判定 (13) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (14) 待ちの間に続きを打ち切った直後の余分な 1 打（gymnasiums の s）: 次の語は続きの最後の打鍵から 0.25 秒（SPILL_TAIL_MS）で出すので、その前の s は待ちの間に捨てる
  // （以前は続きを打ち切るとすぐ次の語が出て、s が次の語 door の 1 打目のミス・×になっていた。V-S2）。続きを打たない人の待ちは変わらない。次の語が出た後の 1 打目は (32)
  for (const via of ["key", "input"]) {
    const p = await openJ(seedJ("jhs-english1", [gym.id, door.id], { spelldash_after_correct: "standard" }), gym);
    const plan = [..."gym"].map((key, i) => ({ at: i * 60, key })).concat([..."nasium"].map((key, i) => ({ at: 220 + i * 100, key })), [{ at: 920, key: "s" }]);
    const r = await sendPlanJ(p, { plan, via, settleMs: 1100 });
    const label = via === "key" ? "keydown" : "Android の input 経路";
    check(`判定 (14) ${label}: gymnasium を打ち切った 0.2 秒後の s は待ちの間に捨てる（次の語 door は未入力・ミス 0・×なし）`,
      r.score === "1" && r.miss === "0" && r.recallFail === "0" && r.log.at(-1)?.ja === gym.ja && r.ja === door.ja && r.input === "" && r.preview === "", JSON.stringify({ ...r, log: logJ(r, namesGym) }));
    check(`判定 (14) ${label}: そのあと door は普通に正解`, await typeNextJ(p, door, 1));
    check(`判定 (14) ${label} でエラー0`, p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (15) ゆっくり打つ人（1 打 0.9 秒）の続きの字が、窓の外で次の語の頭として通る（gymnasium の s と次の語 subject、u と uniform）:
  // 続きの字でもあるキーは写しを残し、次のキーで次の語がミスになり続きには続くと分かったら、次の語から外して続きとして飲む（V-S1。以前は次の語の×）
  const subjectW = jhs1.find((w) => w.en === "subject");
  const uniformW = jhs1.find((w) => w.en === "uniform");
  for (const [next, via] of [[subjectW, "key"], [subjectW, "input"], [uniformW, "key"]]) {
    const p = await openJ(seedJ("jhs-english1", [gym.id, next.id], { spelldash_after_correct: "standard" }), gym);
    const plan = [{ at: 0, key: "g" }, { at: 80, key: "y" }, { at: 160, key: "m" }].concat([..."nasium"].map((key, i) => ({ at: 160 + (i + 1) * 900, key })));
    const r = await sendPlanJ(p, { plan, via, settleMs: 300 });
    const label = `${via === "key" ? "keydown" : "Android の input 経路"}・次の語 ${next.en}`;
    check(`判定 (15) ${label}: gymnasium を 1 打 0.9 秒で打ち、続きの字が次の語の頭として通っても、次のキーで続きと分かれば外す（ミス 0・×なし・次の語は未入力）`,
      !!next && r.score === "1" && r.miss === "0" && r.recallFail === "0" && r.ja === next.ja && r.input === "" && r.preview === "", JSON.stringify({ ...r, log: logJ(r, { [gym.ja]: "gym", [next.ja]: next.en }) }));
    check(`判定 (15) ${label}: そのあと ${next.en} は普通に正解`, await typeNextJ(p, next, 1));
    check(`判定 (15) ${label} でエラー0`, p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (16) a に an の n を 1 秒あけて打つ（窓の外）→ 次の語 not の頭として通る。続けて not を n から打つと、not の 2 打目がミスになるので、
  // 前の n を an の続きとして外し、いまの n を not の 1 打目として受ける（not は×にならず正解。V-S1 の続きが 1 字で終わる形）
  for (const via of ["key", "input"]) {
    const p = await openJ(seedJ("ngsl01", [aW.id, notW.id]), aW);
    const r = await sendPlanJ(p, { plan: [{ at: 0, key: "a" }, { at: 1000, key: "n" }, { at: 1900, key: "n" }, { at: 2050, key: "o" }, { at: 2200, key: "t" }], via, settleMs: 500 });
    const label = via === "key" ? "keydown" : "Android の input 経路";
    check(`判定 (16) ${label}: an の n（1 秒あけて）が次の語 not の頭として通っても、not を n から打てば前の n を外して正解（ミス 0・×なし）`,
      r.score === "2" && r.miss === "0" && r.recallFail === "0", JSON.stringify({ ...r, log: logJ(r, { [aW.ja]: "a", [notW.ja]: "not" }) }));
    check(`判定 (16) ${label} でエラー0`, p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (17) a に an を 2.5 秒あけて打つ（窓の外の上限 4 秒の中）→ 次の語 six の 1 打目のミスにしない（V-S3。以前の上限 2 秒では×）
  {
    const p = await openJ(seedJ("ngsl01", [aW.id, sixW.id], { spelldash_after_correct: "standard" }), aW);
    const r = await sendPlanJ(p, { plan: [{ at: 0, key: "a" }, { at: 2500, key: "n" }], settleMs: 300 });
    check("判定 (17) a に an を 2.5 秒あけて打っても、n は次の語（six）のミスにも×にもしない",
      r.score === "1" && r.miss === "0" && r.recallFail === "0" && r.ja === sixW.ja && r.preview === "", JSON.stringify({ ...r, log: logJ(r, { [aW.ja]: "a", [sixW.ja]: "six" }) }));
    check("判定 (17) そのあと six は普通に正解", await typeNextJ(p, sixW, 1));
    check("判定 (17) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (18) ローマ字の読みの続きも同じ: 岩宿遺跡を iwajuku（短い読み）で終え、続き iseki を 1 打 0.9 秒で打つ → 次の語 院政（innsei）の頭の i として通っても、
  // 次の s で院政がミスになり続きには続くので外す。最後の i も院政の頭として通るが、続けて院政を i から打てば外していまの i を 1 打目にする（院政は×にならず正解）
  {
    const H1 = Object.fromEntries(packJ("jhist1").map((w) => [w.id, w]));
    const iwa = H1["concept-jh1-iwajuku"];
    const insei = H1["concept-jh1-insei"];
    const kIwa = canonicalRomaji(primaryReading(readingEntries(iwa)).reading, { finalN: true });
    const kInsei = canonicalRomaji(primaryReading(readingEntries(insei)).reading, { finalN: true });
    const p = await openJ(seedJ("jhist1", [iwa.id, insei.id]), iwa);
    const plan = [..."iwajuku"].map((key, i) => ({ at: i * 60, key })).concat([..."iseki"].map((key, i) => ({ at: 360 + (i + 1) * 900, key })), [...kInsei].map((key, i) => ({ at: 6400 + i * 150, key })));
    const r = await sendPlanJ(p, { plan, settleMs: 600 });
    check("判定 (18) ローマ字: 岩宿遺跡の続き（iseki を 1 打 0.9 秒）が次の語 院政 の頭として通っても外し、院政は 1 打目から正解（ミス 0・×なし）",
      kIwa === "iwajukuiseki" && kInsei.startsWith("in") && r.score === "2" && r.miss === "0" && r.recallFail === "0", JSON.stringify({ ...r, log: logJ(r, { [iwa.q]: "岩宿", [insei.q]: "院政" }) }));
    check("判定 (18) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (19) 引き分けの字のあとの Enter（REVIEW-149 の 3・REVIEW-keys S1）: 1 打 0.9 秒の gymnasium の最後の m は、続きの最後の字でも次の語 moon の頭でもある
  // （引き分け。m を次の語に見せる）。続きが終わった直後（1.2 秒）の Enter は「打ち終えたら Enter で次へ」の癖として、m を外して 1 回だけ飲む（窓の外でも同じ。
  // 答えは開かない＝×なし）。2 回目の Enter は字が消えた状態で普通に判定＝答えが開く（思い出せず 1）。以前は m を消して Enter も飲み、2 回目の Enter も飲まれて
  // 3 回目で開いていた（固まったように見える）。3 回目の Enter で次の語へ
  {
    const moonW = jhs1.find((w) => w.en === "moon");
    const p = await openJ(seedJ("jhs-english1", [gym.id, moonW.id, door.id], { spelldash_after_correct: "standard" }), gym);
    const plan = [{ at: 0, key: "g" }, { at: 80, key: "y" }, { at: 160, key: "m" }].concat([..."nasium"].map((key, i) => ({ at: 160 + (i + 1) * 900, key })));
    const r = await sendPlanJ(p, { plan, settleMs: 300 });
    const snapJ = async () => ({ word: (await p.textContent("#word")).trim(), rf: await numJ(p, "#recallFail"), miss: await numJ(p, "#miss"), ja: await jaJ(p), input: await p.inputValue("#input"), preview: (await p.textContent("#typedPreview")).trim() });
    await p.press("#input", "Enter");
    await p.waitForTimeout(300);
    const first = await snapJ();
    await p.press("#input", "Enter");
    await p.waitForTimeout(300);
    const opened = await snapJ();
    await p.press("#input", "Enter");
    await waitUntil(async () => (await jaJ(p)) === door.ja, 2000);
    check("判定 (19) 続きの最後の m が次の語 moon の頭としても通る（引き分け）: m を次の語に見せたまま、ミスにも×にもしない",
      !!moonW && r.ja === moonW.ja && r.preview === "m" && r.input === "m" && r.score === "1" && r.miss === "0" && r.recallFail === "0", JSON.stringify({ ...r, log: logJ(r, { [gym.ja]: "gym", [moonW.ja]: "moon" }) }));
    check("判定 (19) 引き分けの m の直後の Enter は、m を外して 1 回だけ飲む（答えは開かない・思い出せず 0・入力欄は空＝見える反応がある）",
      first.word !== moonW.en && first.rf === 0 && first.miss === 0 && first.ja === moonW.ja && first.input === "" && first.preview === "", JSON.stringify(first));
    check("判定 (19) 2 回目の Enter で答えが開く（思い出せず 1。2 回目も飲んで 3 回目で開く、という固まりはない）",
      opened.word === moonW.en && opened.rf === 1 && opened.miss === 0 && opened.ja === moonW.ja, JSON.stringify(opened));
    check("判定 (19) 3 回目の Enter で次の語へ進む", (await jaJ(p)) === door.ja, await jaJ(p));
    check("判定 (19) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (19b) 同じ組を窓の中で（タイマーで次の語が出た後に nasium を 1 打 0.25 秒、最後の m の 0.2 秒後に Enter。(8) の次の語が moon の形）:
  // 続きが窓の中で終わっていれば引き分けの m は続きが勝つ（次の語から外す）。Enter は「打ち終えたら Enter で次への癖」として飲む（続きの最後の打鍵から 1.2 秒。×なし）。
  // 窓の中で打ち切った続きの直後の Enter が次の語の×にならない（不変条件 b）のは、次の語の頭が続きの最後の字と同じでも変わらない
  {
    const moonW = jhs1.find((w) => w.en === "moon");
    const p = await openJ(seedJ("jhs-english1", [gym.id, moonW.id, door.id]), gym);
    const r = await sendPlanJ(p, {
      plan: [{ at: 0, key: "g" }, { at: 80, key: "y" }, { at: 160, key: "m" }],
      afterChange: [..."nasium"].map((key, i) => ({ at: 50 + i * 250, key })).concat([{ at: 50 + 5 * 250 + 200, key: "Enter" }]),
      settleMs: 300
    });
    check("判定 (19b) 窓の中で打ち切った gymnasium の最後の m（次の語 moon の頭でもある）の直後の Enter は、m を続きとして外して答えを開かない（×なし・ミス 0・次の語は未入力）",
      !!moonW && r.score === "1" && r.miss === "0" && r.recallFail === "0" && r.ja === moonW.ja && r.word !== moonW.en && r.input === "" && r.preview === "", JSON.stringify({ ...r, log: logJ(r, { [gym.ja]: "gym", [moonW.ja]: "moon" }) }));
    check("判定 (19b) そのあと moon は普通に正解", await typeNextJ(p, moonW, 1));
    check("判定 (19b) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (20) 続きが次の語の綴りそのもの（REVIEW-149 の 1）: grammar-hs1 の another（accept "another one"）の次の語が one。another を打ち切って（正解）、
  // 次の語が出てから one を普通に打つ: o・n・e は続き（" one"）としても次の語 one としても通る引き分けだが、打った字の列が次の語の正解として
  // 完成したので次の語の正解（以前は全部続きとして飲まれて次の語は未入力のまま、Enter で×）
  {
    const gh1 = packJ("grammar-hs1");
    const another = gh1.find((w) => w.id === "concept-gh1-noun-another");
    const oneW = gh1.find((w) => w.id === "concept-gh1-noun-one");
    const thirdW = gh1.find((w) => w.id === "concept-gh1-relative-in-which");
    const p = await openJ(seedJ("grammar-hs1", [another.id, oneW.id, thirdW.id]), another);
    const r = await sendPlanJ(p, { plan: [..."another"].map((key, i) => ({ at: i * 60, key })), afterChange: [..."one"].map((key, i) => ({ at: 50 + i * 80, key })), settleMs: 500 });
    const onOne = r.log.length === 10 && r.log.slice(7).every((e) => e.ja === oneW.q);
    check("判定 (20) another（accept another one）の次の語 one を普通に打つと one の正解（続きと同じ綴りでも、次の語として完成したら次の語が勝つ。×なし・ミス 0）",
      !!another?.accept?.includes("another one") && onOne && r.score === "2" && r.miss === "0" && r.recallFail === "0", JSON.stringify({ ...r, log: logJ(r, { [another.q]: "another", [oneW.q]: "one", [thirdW.q]: "in" }) }));
    check("判定 (20) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (21) 引き分けの字が次の語の候補の 1 つに一致しているときの Enter は、その語で確定（REVIEW-149 の 3 の「一致なら確定」）。パックのデータに
  // 「続きの頭 ＝ 次の語の伸びる別解」の組が無いので、マイ単語帳の場面カードで作る: gym（accept gymnasium）→ 次の語 nasty（accept nas・nasal）。
  // gym を打ち切り、次の語が出てから n・a・s（続き nasium としても別解 nas の頭としても通る引き分け。nas は別解 nasal の先頭でもあるので打ち切っても止めない）
  // → Enter → 別解 nas として確定（×なし）
  const myConceptJ = (answer, q, accept = []) => ({ kind: "concept", en: answer, answer, q, explain: "", accept, ja: "" });
  const seedMyJ = (cards) => ({
    spelldash_category: "my", spelldash_my_words: JSON.stringify(cards), spelldash_placement: "done", spelldash_after_correct: "quick",
    spelldash_audio: JSON.stringify({ mode: "off" }), spelldash_streak: JSON.stringify({ current: 1, best: 1, last: todayJ }),
    spelldash_session: JSON.stringify({ category: "my", focus: "", queue: cards.map((c) => `my-q-${c.en}`), recalled: [], failed: [], newCount: 0, reviewCount: 0, setSize: 20, date: todayJ, savedAt: new Date().toISOString() })
  });
  const seedMyChallengeJ = (cards) => ({
    spelldash_category: "my", spelldash_my_words: JSON.stringify(cards), spelldash_mode: "challenge", spelldash_placement: "done",
    spelldash_audio: JSON.stringify({ mode: "off" }), spelldash_streak: JSON.stringify({ current: 1, best: 1, last: todayJ })
  });
  // Challenge（マイ単語帳 2 枚。次の語は必ずもう 1 枚）を開き、1 枚目が出るまで進める（2 枚目が先なら普通に打つ。secondKeys = 2 枚目を打つキー）
  async function openMyChallengeJ(cards, secondKeys = cards[1].en) {
    const p = await newPage({ storage: seedMyChallengeJ(cards) });
    await p.goto(BASE + "/index.html?hintms=600000", { waitUntil: "networkidle" });
    await p.waitForTimeout(700);
    await p.press("#input", "Enter");
    await waitUntil(async () => (await jaJ(p)) !== "", 3000);
    if ((await jaJ(p)) === cards[1].q) {
      for (const ch of secondKeys) await p.press("#input", ch);
      await waitUntil(async () => (await jaJ(p)) === cards[0].q, 2000);
      await p.waitForTimeout(800); // 窓（0.6 秒）の外に出てから
    }
    return p;
  }
  const myGymJ = myConceptJ("gym", "体育館（スポーツをする建物）", ["gymnasium"]);
  const myDoorJ = myConceptJ("door", "部屋の出入り口の戸");
  {
    const cards = [myGymJ, myConceptJ("nasty", "いやな・不快な（性格や天気）", ["nas", "nasal"]), myDoorJ];
    const p = await openJ(seedMyJ(cards), cards[0]);
    const r = await sendPlanJ(p, { plan: [..."gym"].map((key, i) => ({ at: i * 60, key })), afterChange: [{ at: 50, key: "n" }, { at: 130, key: "a" }, { at: 210, key: "s" }, { at: 500, key: "Enter" }], settleMs: 400 });
    const msg = (await p.textContent("#message")).trim();
    check("判定 (21) 引き分けの字（nas）が次の語 nasty の候補 nas に一致しているときの Enter は、その語（別解）で確定（「nas も…この問題の語は nasty」・×なし・ミス 0）",
      r.ja === cards[1].q && msg.includes("nas") && msg.includes("nasty") && r.recallFail === "0" && r.miss === "0" && r.score === "1" && r.word === "nasty", JSON.stringify({ ...r, msg, log: logJ(r, { [cards[0].q]: "gym", [cards[1].q]: "nasty" }) }));
    check("判定 (21) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (22) 引き分けの字の取り消しと打ち間違い（REVIEW-149 の 4・REVIEW-keys M1）: in（accept inside）の次の語 six。
  // (a) 窓の外で s・i をゆっくり打ち（six の頭としても inside の続きとしても通る引き分け 2 字）、次に d: six は拒み、続き（side）は受けるが、窓の外で 2 字を
  //     次の語に受理した後（続きも始まっていない）なので黙って消さず、かつその場で打ち間違いにもせず保留する（入力欄は si のまま・ミス 0）。次の x で続きが拒む
  //     ＝six を打ち続けていた → 保留の d を打ち間違いとして数える（「違う」・ミス 1・思い出せず 1。よく間違えるキーには x→d）
  // (b) 窓の中で side と打ち続ければ inside の続き（s・i は six に見せても d で外す。six は未入力・ミス 0・×なし）。そのあと six は普通に正解
  // (c) 続きがすでに始まっていれば（1 打 0.9 秒の gymnasium の n・a を飲んだ後の s・i と次の語 six）、窓の外の 2 字でも続きとして外す（×なし）
  // (d) (a) と同じ s・i・d のあと e（inside を 1 打 1 秒で打ち切った）: 全部が続きだった＝s・i を黙って外す（six は未入力・ミス 0・×なし）。そのあと six は普通に正解
  const inW = ngsl01.find((w) => w.id === "english-in");
  {
    const p = await openJ(seedJ("ngsl01", [inW.id, sixW.id]), inW);
    const r = await sendPlanJ(p, { plan: [{ at: 0, key: "i" }, { at: 80, key: "n" }, { at: 1000, key: "s" }, { at: 2000, key: "i" }, { at: 3000, key: "d" }], settleMs: 400 });
    check("判定 (22a) in のあと窓の外で s・i（six の頭でもある）を打ってから d: 黙って消さず、その場で打ち間違いにもせず保留（入力欄 si・ミス 0・×なし）",
      !!inW?.accept?.includes("inside") && r.ja === sixW.ja && r.score === "1" && r.miss === "0" && r.recallFail === "0" && r.input === "si" && r.preview === "si" && r.word !== sixW.en, JSON.stringify({ ...r, log: logJ(r, { [inW.ja]: "in", [sixW.ja]: "six" }) }));
    await p.press("#input", "x");
    await p.waitForTimeout(300);
    const msg = (await p.textContent("#message")).trim();
    const keyMiss = await p.evaluate(() => JSON.parse(localStorage.getItem("spelldash_key_miss") || "{}").pairs ?? {});
    check("判定 (22a) 次の x で続きが拒む＝six を打ち続けていた: 保留の d を打ち間違いとして数える（「違う」・ミス 1・思い出せず 1・よく間違えるキーは x→d）",
      (await numJ(p, "#miss")) === 1 && (await numJ(p, "#recallFail")) === 1 && msg.startsWith("違う") && (await p.textContent("#word")).trim() === sixW.en && keyMiss["x>d"] === 1, JSON.stringify({ msg, keyMiss }));
    check("判定 (22a) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  {
    const p = await openJ(seedJ("ngsl01", [inW.id, sixW.id]), inW);
    const r = await sendPlanJ(p, { plan: [{ at: 0, key: "i" }, { at: 80, key: "n" }, { at: 1000, key: "s" }, { at: 2000, key: "i" }, { at: 3000, key: "d" }, { at: 4000, key: "e" }], settleMs: 400 });
    check("判定 (22d) 同じ s・i・d のあと e（inside を 1 打 1 秒で打ち切った）: 全部が続きだった＝s・i を黙って外す（six は未入力・ミス 0・×なし）",
      r.ja === sixW.ja && r.score === "1" && r.miss === "0" && r.recallFail === "0" && r.input === "" && r.preview === "", JSON.stringify({ ...r, log: logJ(r, { [inW.ja]: "in", [sixW.ja]: "six" }) }));
    check("判定 (22d) そのあと six は普通に正解", await typeNextJ(p, sixW, 1));
    check("判定 (22d) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  {
    const p = await openJ(seedJ("ngsl01", [inW.id, sixW.id]), inW);
    const r = await sendPlanJ(p, { plan: [{ at: 0, key: "i" }, { at: 80, key: "n" }], afterChange: [..."side"].map((key, i) => ({ at: 60 + i * 100, key })), settleMs: 500 });
    check("判定 (22b) in のあと窓の中で side と打ち続ければ inside の続き（s・i は six に見せても d で外す。six は未入力・ミス 0・×なし）",
      r.ja === sixW.ja && r.score === "1" && r.miss === "0" && r.recallFail === "0" && r.input === "" && r.preview === "", JSON.stringify({ ...r, log: logJ(r, { [inW.ja]: "in", [sixW.ja]: "six" }) }));
    check("判定 (22b) そのあと six は普通に正解", await typeNextJ(p, sixW, 1));
    check("判定 (22b) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  {
    const cards = [myGymJ, myConceptJ("six", "6・六つ"), myDoorJ];
    const p = await openJ(seedMyJ(cards), cards[0]);
    const plan = [{ at: 0, key: "g" }, { at: 80, key: "y" }, { at: 160, key: "m" }].concat([..."nasium"].map((key, i) => ({ at: 160 + (i + 1) * 900, key })));
    const r = await sendPlanJ(p, { plan, settleMs: 300 });
    check("判定 (22c) gymnasium を 1 打 0.9 秒で打ち、次の語 six の頭としても通る s・i（窓の外の 2 字）も、続きがすでに始まっていたので u で外す（six は未入力・ミス 0・×なし）",
      r.ja === cards[1].q && r.score === "1" && r.miss === "0" && r.recallFail === "0" && r.input === "" && r.preview === "", JSON.stringify({ ...r, log: logJ(r, { [cards[0].q]: "gym", [cards[1].q]: "six" }) }));
    for (const ch of "six") await p.press("#input", ch);
    await waitUntil(async () => (await numJ(p, "#score")) === 2, 2000);
    check("判定 (22c) そのあと six は普通に正解", (await numJ(p, "#score")) === 2 && (await numJ(p, "#miss")) === 0 && (await numJ(p, "#recallFail")) === 0);
    check("判定 (22c) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (23) 続きがまだ続く引き分けの後、次の語を 1 打目から打ち直す（REVIEW-judge M1）: gym の後に n を打ちかけて止め（続き nasium の頭でも次の語 name の頭でもある
  // 引き分け。n を次の語に見せる）、name を n から打つ。2 つ目の n は続き（nasium の a）も次の語（nn）も拒むので、引き分けの n を外して 1 打目にする
  // （続きがまだ続くときも外す。続きが終わっているときだけ外すと name が×になる）。(a) Challenge（マイ単語帳 2 枚。次の語はすぐ出る）の keydown・
  // Android の input 経路、(b) Study quick（次の語が出た後の打ちかけ）、(c) ローマ字（いわじゅく の後に i を打ちかけ → 遺跡 を i から）
  const myNameJ = myConceptJ("name", "名前");
  for (const via of ["key", "input"]) {
    const cards = [myGymJ, myNameJ];
    const p = await openMyChallengeJ(cards);
    const before = await numJ(p, "#score");
    const plan = [..."gym"].map((key, i) => ({ at: i * 60, key })).concat([{ at: 220, key: "n" }], [..."name"].map((key, i) => ({ at: 900 + i * 120, key })));
    const r = await sendPlanJ(p, { via, plan, settleMs: 500 });
    const label = via === "key" ? "keydown" : "Android の input 経路";
    check(`判定 (23a) ${label}: Challenge で gym の後に n を打ちかけて止め、name を n から打つと name の正解（引き分けの n を外して 1 打目に。ミス 0・×なし）`,
      Number(r.score) === before + 2 && r.miss === "0" && r.recallFail === "0", JSON.stringify({ ...r, before, log: logJ(r, { [cards[0].q]: "gym", [cards[1].q]: "name" }) }));
    check(`判定 (23a) ${label} でエラー0`, p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  {
    const nameW = jhs1.find((w) => w.en === "name");
    const p = await openJ(seedJ("jhs-english1", [gym.id, nameW.id, door.id]), gym);
    const r = await sendPlanJ(p, { plan: [..."gym"].map((key, i) => ({ at: i * 60, key })), afterChange: [{ at: 100, key: "n" }].concat([..."name"].map((key, i) => ({ at: 1000 + i * 120, key }))), settleMs: 600 });
    const st = await statJ(p, nameW.id);
    check("判定 (23b) Study: 次の語 name が出た後に n を打ちかけて止め、name を n から打つと正解（思い出せた・ミス 0・×なし）",
      r.score === "2" && r.miss === "0" && r.recallFail === "0" && !!st.lastRecallSuccessAt && !st.recallFail, JSON.stringify({ ...r, st, log: logJ(r, { [gym.ja]: "gym", [nameW.ja]: "name" }) }));
    check("判定 (23b) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  {
    const cards = [myConceptJ("岩宿", "群馬県の旧石器時代の遺跡がある地名", ["いわじゅく", "いわじゅくいせき"]), myConceptJ("遺跡", "昔の人の生活の跡", ["いせき"])];
    const p = await openMyChallengeJ(cards, "iseki");
    const before = await numJ(p, "#score");
    const plan = [..."iwajuku"].map((key, i) => ({ at: i * 60, key })).concat([{ at: 500, key: "i" }], [..."iseki"].map((key, i) => ({ at: 1200 + i * 120, key })));
    const r = await sendPlanJ(p, { plan, settleMs: 500 });
    check("判定 (23c) ローマ字: Challenge で いわじゅく の後に i（いせき の頭）を打ちかけて止め、遺跡 を i から打つと正解（ミス 0・×なし）",
      Number(r.score) === before + 2 && r.miss === "0" && r.recallFail === "0", JSON.stringify({ ...r, before, log: logJ(r, { [cards[0].q]: "岩宿", [cards[1].q]: "遺跡" }) }));
    check("判定 (23c) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  // (23d)〜(23i) 窓の外で 2 字以上を打ちかけてからの打ち直しと、その打ち間違いの対（VERIFY V-M1・V-S2）。引き分けの字を黙って外せない（窓の外で 2 字以上）ので、
  // 両方が拒むが 1 打目として通る字は、その場で決めずに保留する（保留 restart。字は見せない）: 次の打鍵で、保留の字 ＋ その字が次の語の頭から通れば打ち直し
  // （引き分けの字を外して 1 打目に）、通らなければ保留の字が打ち間違い（「違う」・1 ミス。黙って消さない）
  // (23d) Challenge で gym の 0.8 秒後に n・a（name の頭でも nasium の頭でもある 2 字）→ 0.85 秒止めて name を頭から: name の正解（keydown・input 経路）
  for (const via of ["key", "input"]) {
    const cards = [myGymJ, myNameJ];
    const p = await openMyChallengeJ(cards);
    const before = await numJ(p, "#score");
    const plan = [..."gym"].map((key, i) => ({ at: i * 60, key })).concat([{ at: 920, key: "n" }, { at: 1070, key: "a" }], [..."name"].map((key, i) => ({ at: 1920 + i * 120, key })));
    const r = await sendPlanJ(p, { via, plan, settleMs: 500 });
    const label = via === "key" ? "keydown" : "Android の input 経路";
    check(`判定 (23d) ${label}: Challenge で gym の 0.8 秒後に n・a を打ちかけて止め（窓の外の 2 字）、name を頭から打つと name の正解（ミス 0・×なし）`,
      Number(r.score) === before + 2 && r.miss === "0" && r.recallFail === "0", JSON.stringify({ ...r, before, log: logJ(r, { [cards[0].q]: "gym", [cards[1].q]: "name" }) }));
    check(`判定 (23d) ${label} でエラー0`, p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  // (23e) 打ち間違いの側: in（accept inside）の 0.8 秒後に six の s・i → x のつもりで s（1 打目としては通る）→ 止まる: その場では字を出さず（入力欄 si・ミス 0）、
  // 4 秒で打ち間違い（「違う」・ミス 1・思い出せず 1・よく間違えるキー x→s）。打ち直しと区別できないので待つが、黙って消さない
  const myInJ = myConceptJ("in", "〜の中に", ["inside"]);
  const mySixJ = myConceptJ("six", "6・六つ");
  {
    const cards = [myInJ, mySixJ];
    const p = await openMyChallengeJ(cards);
    const before = await numJ(p, "#score");
    const plan = [{ at: 0, key: "i" }, { at: 60, key: "n" }, { at: 860, key: "s" }, { at: 1060, key: "i" }, { at: 1500, key: "s" }];
    const r = await sendPlanJ(p, { plan, settleMs: 600 });
    check("判定 (23e) in の 0.8 秒後に six の s・i → s（x の打ち間違い）: その場では決めない（入力欄 si・ミス 0・×なし）",
      Number(r.score) === before + 1 && r.ja === cards[1].q && r.input === "si" && r.miss === "0" && r.recallFail === "0", JSON.stringify({ ...r, before, log: logJ(r, { [cards[0].q]: "in", [cards[1].q]: "six" }) }));
    await waitUntil(async () => (await numJ(p, "#miss")) === 1, 5000);
    const msg = (await p.textContent("#message")).trim();
    const keyMiss = await p.evaluate(() => JSON.parse(localStorage.getItem("spelldash_key_miss") || "{}").pairs ?? {});
    check("判定 (23e) そのまま止まると 4 秒で s を打ち間違いとして数える（「違う」・ミス 1・思い出せず 1・よく間違えるキー x→s。黙って消さない）",
      (await numJ(p, "#miss")) === 1 && (await numJ(p, "#recallFail")) === 1 && msg.startsWith("違う") && (await p.textContent("#word")).trim() === "six" && keyMiss["x>s"] === 1, JSON.stringify({ msg, keyMiss }));
    check("判定 (23e) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  // (23f) 打ち間違いの側: gym の 0.8 秒後に name の n・a → m のつもりで n → e: na の後の n＋e は頭から通らないので、保留の n を打ち間違いとして数える（ミス 1。keydown・input 経路）
  for (const via of ["key", "input"]) {
    const cards = [myGymJ, myNameJ];
    const p = await openMyChallengeJ(cards);
    const plan = [..."gym"].map((key, i) => ({ at: i * 60, key })).concat([{ at: 920, key: "n" }, { at: 1120, key: "a" }, { at: 1600, key: "n" }, { at: 1800, key: "e" }]);
    const r = await sendPlanJ(p, { via, plan, settleMs: 400 });
    const label = via === "key" ? "keydown" : "Android の input 経路";
    check(`判定 (23f) ${label}: gym の 0.8 秒後に n・a → n（m の打ち間違い）→ e は、n を打ち間違いとして数える（ミス 1・思い出せず 1）`,
      r.ja === cards[1].q && r.miss === "1" && r.recallFail === "1" && r.word === "name", JSON.stringify({ ...r, log: logJ(r, { [cards[0].q]: "gym", [cards[1].q]: "name" }) }));
    check(`判定 (23f) ${label} でエラー0`, p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  // (23g) 続きを 3 字打ちかけてやめる: gym の 0.8 秒後に n・a・s（s は nasium の続きだけが受ける＝保留 typo）→ name を頭から: n で保留 restart に切り替え、
  // a で打ち直しと決まる（name の正解）
  {
    const cards = [myGymJ, myNameJ];
    const p = await openMyChallengeJ(cards);
    const before = await numJ(p, "#score");
    const plan = [..."gym"].map((key, i) => ({ at: i * 60, key })).concat([{ at: 920, key: "n" }, { at: 1070, key: "a" }, { at: 1220, key: "s" }], [..."name"].map((key, i) => ({ at: 2070 + i * 120, key })));
    const r = await sendPlanJ(p, { plan, settleMs: 500 });
    check("判定 (23g) gym の 0.8 秒後に n・a・s を打ちかけて止め、name を頭から打つと name の正解（ミス 0・×なし）",
      Number(r.score) === before + 2 && r.miss === "0" && r.recallFail === "0", JSON.stringify({ ...r, before, log: logJ(r, { [cards[0].q]: "gym", [cards[1].q]: "name" }) }));
    check("判定 (23g) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  // (23h) 4 秒を過ぎてからの打ち直し: gym の 0.8 秒後に n・a → 4.5 秒止まる（続きの見方は終わる。見せている na は消さない）→ name を頭から: name の正解
  {
    const cards = [myGymJ, myNameJ];
    const p = await openMyChallengeJ(cards);
    const before = await numJ(p, "#score");
    const plan = [..."gym"].map((key, i) => ({ at: i * 60, key })).concat([{ at: 920, key: "n" }, { at: 1120, key: "a" }], [..."name"].map((key, i) => ({ at: 5700 + i * 120, key })));
    const r = await sendPlanJ(p, { plan, settleMs: 500 });
    check("判定 (23h) gym の 0.8 秒後に n・a を打ちかけ、4.5 秒止まってから name を頭から打つと name の正解（ミス 0・×なし）",
      Number(r.score) === before + 2 && r.miss === "0" && r.recallFail === "0", JSON.stringify({ ...r, before, log: logJ(r, { [cards[0].q]: "gym", [cards[1].q]: "name" }) }));
    check("判定 (23h) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  // (23i) ローマ字: Challenge で いわじゅく の 0.7 秒後に i・s（いせき の頭。窓の外の 2 字）を打ちかけて止め、遺跡 を頭から打つと正解
  {
    const cards = [myConceptJ("岩宿", "群馬県の旧石器時代の遺跡がある地名", ["いわじゅく", "いわじゅくいせき"]), myConceptJ("遺跡", "昔の人の生活の跡", ["いせき"])];
    const p = await openMyChallengeJ(cards, "iseki");
    const before = await numJ(p, "#score");
    const plan = [..."iwajuku"].map((key, i) => ({ at: i * 60, key })).concat([{ at: 1060, key: "i" }, { at: 1210, key: "s" }], [..."iseki"].map((key, i) => ({ at: 2060 + i * 120, key })));
    const r = await sendPlanJ(p, { plan, settleMs: 500 });
    check("判定 (23i) ローマ字: Challenge で いわじゅく の 0.7 秒後に i・s を打ちかけて止め、遺跡 を頭から打つと正解（ミス 0・×なし）",
      Number(r.score) === before + 2 && r.miss === "0" && r.recallFail === "0", JSON.stringify({ ...r, before, log: logJ(r, { [cards[0].q]: "岩宿", [cards[1].q]: "遺跡" }) }));
    check("判定 (23i) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (24) 続きがまだ続くのに次の語がその字で完成する組（REVIEW-judge M2・REVIEW-keys M2）: ngsl01 の out（accept outside・outdoors）の次の語 do。
  // d・o は続き（doors）としても次の語 do としても通り、o で do が完成するが続きもまだ続く → 決めずに保留（do を見せて受理しない）。
  // (a) Challenge で outdoors を一息に打つ: 残りの o・r・s で続きだった（do は未入力・ミス 0。打っていない do に正解を付けず、残りを 3 語目に流さない）。
  //     そのあと do を打てば do の正解
  // (b) Study quick で次の語が出てから do と打つ: 次の打鍵が無いので SPILL_HOLD_MS（1.5 秒）で do の正解（思い出せた。4 秒待たせない）
  // (c) d・o の直後の Enter は打った語 do で確定（待たない）
  // (d) Study standard で doors を 1 打 0.9 秒で打つ（続きを打つ人）: do は未入力・ミス 0・×なし
  const outW = ngsl01.find((w) => w.id === "english-out");
  const doW = ngsl01.find((w) => w.id === "english-do");
  const namesOut = { [outW.ja]: "out", [doW.ja]: "do", [sixW.ja]: "six" };
  {
    const cards = [myConceptJ("out", "外へ・外に", ["outside", "outdoors"]), myConceptJ("do", "する")];
    const p = await openMyChallengeJ(cards);
    const before = await numJ(p, "#score");
    const r = await sendPlanJ(p, { plan: [..."outdoors"].map((key, i) => ({ at: i * 60, key })), settleMs: 500 });
    check("判定 (24a) Challenge で outdoors を一息に打つ: out の正解、続きの do は次の語 do に正解を付けず、残り ors も次の語に流さない（do は未入力・ミス 0・×なし）",
      Number(r.score) === before + 1 && r.ja === cards[1].q && r.miss === "0" && r.recallFail === "0" && r.input === "" && r.preview === "", JSON.stringify({ ...r, before, log: logJ(r, { [cards[0].q]: "out", [cards[1].q]: "do" }) }));
    for (const ch of "do") await p.press("#input", ch);
    await waitUntil(async () => (await numJ(p, "#score")) === before + 2, 2500);
    check("判定 (24a) そのあと do を打てば do の正解（ミス 0・×なし）", (await numJ(p, "#score")) === before + 2 && (await numJ(p, "#miss")) === 0 && (await numJ(p, "#recallFail")) === 0);
    check("判定 (24a) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  {
    const p = await openJ(seedJ("ngsl01", [outW.id, doW.id, sixW.id]), outW);
    const r = await sendPlanJ(p, { plan: [..."out"].map((key, i) => ({ at: i * 60, key })), afterChange: [{ at: 300, key: "d" }, { at: 450, key: "o" }], settleMs: 150 });
    const shown = { input: await p.inputValue("#input"), preview: (await p.textContent("#typedPreview")).trim() };
    const t0 = Date.now();
    await waitUntil(async () => (await numJ(p, "#score")) === 2, 4000);
    const ms = Date.now() - t0 + 150; // o の打鍵から do の正解まで（ページから戻る間の分だけ短めに出る。保留していたことは o の 0.15 秒後に do が入力欄に見えていることで見る）
    const st = await statJ(p, doW.id);
    check("判定 (24b) Study で out の次の語 do を普通に打つ: do を見せたまま保留し、続きが来なければ 1.5 秒で do の正解（思い出せた・ミス 0・×なし。4 秒待たせない）",
      r.ja === doW.ja && shown.input === "do" && shown.preview === "do" && (await numJ(p, "#score")) === 2 && (await numJ(p, "#miss")) === 0 && (await numJ(p, "#recallFail")) === 0 && !!st.lastRecallSuccessAt && ms >= 1000 && ms < 2600,
      JSON.stringify({ ms, shown, st, ...r, log: logJ(r, namesOut) }));
    check("判定 (24b) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  {
    const p = await openJ(seedJ("ngsl01", [outW.id, doW.id, sixW.id]), outW);
    const r = await sendPlanJ(p, { plan: [..."out"].map((key, i) => ({ at: i * 60, key })), afterChange: [{ at: 300, key: "d" }, { at: 450, key: "o" }, { at: 750, key: "Enter" }], settleMs: 300 });
    check("判定 (24c) d・o の直後の Enter は打った語 do で確定（保留を待たない。思い出せず 0・ミス 0）",
      r.score === "2" && r.miss === "0" && r.recallFail === "0", JSON.stringify({ ...r, log: logJ(r, namesOut) }));
    check("判定 (24c) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  {
    const p = await openJ(seedJ("ngsl01", [outW.id, doW.id, sixW.id], { spelldash_after_correct: "standard" }), outW);
    const r = await sendPlanJ(p, { plan: [..."out"].map((key, i) => ({ at: i * 60, key })), afterChange: [..."doors"].map((key, i) => ({ at: 100 + i * 900, key })), settleMs: 400 });
    check("判定 (24d) Study で outdoors の doors を 1 打 0.9 秒で打つ（続きを打つ人）: do に正解を付けず、残りも次の語に流さない（do は未入力・ミス 0・×なし）",
      r.ja === doW.ja && r.score === "1" && r.miss === "0" && r.recallFail === "0" && r.input === "" && r.preview === "", JSON.stringify({ ...r, log: logJ(r, namesOut) }));
    check("判定 (24d) そのあと do は普通に正解", await typeNextJ(p, doW, 1));
    check("判定 (24d) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  // (24e) 1 打 1.5 秒より遅く outdoors の doors を打つ（VERIFY V-S1）: o で保留した do は 1.5 秒の時間切れで do の正解になる（続きか次の語かは時間では分からない）が、
  // 続きの残り（ors）もなぞる打鍵として飲むので、残りの o・r・s を次の次の語の×にしない（Study quick・Challenge）
  {
    const p = await openJ(seedJ("ngsl01", [outW.id, doW.id, sixW.id]), outW);
    const r = await sendPlanJ(p, { plan: [..."out"].map((key, i) => ({ at: i * 60, key })), afterChange: [..."doors"].map((key, i) => ({ at: 300 + i * 1700, key })), settleMs: 600 });
    check("判定 (24e) Study で out の後に doors を 1 打 1.7 秒で打つ: 残りの o・r・s を次の語 six の×にしない（ミス 0・思い出せず 0）",
      r.ja === sixW.ja && r.score === "2" && r.miss === "0" && r.recallFail === "0", JSON.stringify({ ...r, log: logJ(r, namesOut) }));
    check("判定 (24e) そのあと six は普通に正解", await typeNextJ(p, sixW, 2));
    check("判定 (24e) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  {
    const cards = [myConceptJ("out", "外へ・外に", ["outside", "outdoors"]), myConceptJ("do", "する")];
    const p = await openMyChallengeJ(cards);
    const before = await numJ(p, "#score");
    const plan = [..."out"].map((key, i) => ({ at: i * 60, key })).concat([..."doors"].map((key, i) => ({ at: 420 + i * 1700, key })));
    const r = await sendPlanJ(p, { plan, settleMs: 600 });
    check("判定 (24e) Challenge で out の後に doors を 1 打 1.7 秒で打つ: 残りの o・r・s を 3 語目の×にしない（ミス 0・思い出せず 0）",
      Number(r.score) === before + 2 && r.miss === "0" && r.recallFail === "0", JSON.stringify({ ...r, before, log: logJ(r, { [cards[0].q]: "out", [cards[1].q]: "do" }) }));
    check("判定 (24e) Challenge でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (25) 続きが次の語の別解そのもの（REVIEW-judge S1）: hall（accept hallway）の次の語 manner（accept way）。hallway を一息に打つと、way は続き（hallway の残り）
  // としても manner の別解としても通るが、別解としての完成は答えを見た扱い（自力にならない）なので続きが勝つ（manner は未入力）。そのあと manner を打てば自力の正解
  {
    const cards = [myConceptJ("hall", "廊下・ホール", ["hallway"]), myConceptJ("manner", "やり方・方法", ["way"])];
    const p = await openMyChallengeJ(cards);
    const before = await numJ(p, "#score");
    const r = await sendPlanJ(p, { plan: [..."hallway"].map((key, i) => ({ at: i * 60, key })), settleMs: 500 });
    const msg = (await p.textContent("#message")).trim();
    check("判定 (25) Challenge で hallway を一息に打つ: way を次の語 manner の別解にしない（別解の案内なし・manner は未入力・ミス 0・×なし）",
      Number(r.score) === before + 1 && r.ja === cards[1].q && !msg.includes("manner") && r.input === "" && r.preview === "" && r.miss === "0" && r.recallFail === "0", JSON.stringify({ ...r, msg, before }));
    for (const ch of "manner") await p.press("#input", ch);
    await waitUntil(async () => (await numJ(p, "#score")) === before + 2, 2500);
    const st = await statJ(p, "my-q-manner");
    check("判定 (25) そのあと manner を打てば自力の正解（思い出せた・ミス 0・×なし）",
      (await numJ(p, "#score")) === before + 2 && (await numJ(p, "#miss")) === 0 && (await numJ(p, "#recallFail")) === 0 && !!st.lastRecallSuccessAt, JSON.stringify(st));
    check("判定 (25) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (26) 続きで次の語が完成した後に、同じ語をもう一度打つ（REVIEW-judge S4）: another（accept another one）→ one の Challenge で anotherone と一息に打つと
  // one は続きの o・n・e で完成する（(20) の規則）。出題が one に変わったのを見て本人がもう一度 one を打っても、完成した語をなぞる打鍵として飲む
  // （3 語目〔another〕に流して×にしない）
  {
    const cards = [myConceptJ("another", "もう一つの（別の）", ["another one"]), myConceptJ("one", "一つ・1")];
    const p = await openMyChallengeJ(cards);
    const before = await numJ(p, "#score");
    const plan = [..."anotherone"].map((key, i) => ({ at: i * 60, key })).concat([..."one"].map((key, i) => ({ at: 1500 + i * 100, key })));
    const r = await sendPlanJ(p, { plan, settleMs: 500 });
    check("判定 (26) Challenge で another one と打った後にもう一度 one を打っても、3 語目に流さない（2 語とも正解・3 語目は未入力・ミス 0・×なし）",
      Number(r.score) === before + 2 && r.ja === cards[0].q && r.miss === "0" && r.recallFail === "0" && r.input === "" && r.preview === "", JSON.stringify({ ...r, before, log: logJ(r, { [cards[0].q]: "another", [cards[1].q]: "one" }) }));
    check("判定 (26) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // ---- PR #153 のレビュー（REVIEW-153）: 決着の後のエコーと Android の入力の基準・別解としての完成・全文入力の語への流し直し・Study の待ちの縮み ----
  // (27) Android の input 経路: 保留の決着・引き分けの完成で次の語が完成した後のエコー（完成した語をなぞる打鍵を飲む続き）を始めても、
  // 入力欄に残っている完成した語を打った字として食べない（Study の正解後の待ちの 1 回目の入力は、完成した語の後ろだけを比べる。REVIEW-153 の 1）
  // (27a) (24e) の input 経路: Study で out の後に doors を 1 打 1.7 秒で打つ。o で保留した do は 1.5 秒の時間切れで正解になり、残りの o・r・s もなぞる打鍵として飲む
  {
    const p = await openJ(seedJ("ngsl01", [outW.id, doW.id, sixW.id]), outW);
    const r = await sendPlanJ(p, { via: "input", plan: [..."out"].map((key, i) => ({ at: i * 60, key })), afterChange: [..."doors"].map((key, i) => ({ at: 300 + i * 1700, key })), settleMs: 600 });
    check("判定 (27a) Android の input 経路: Study で out の後に doors を 1 打 1.7 秒で打つ: do は時間切れで正解、残りの o・r・s を次の語 six の×にしない（ミス 0・思い出せず 0）",
      r.ja === sixW.ja && r.score === "2" && r.miss === "0" && r.recallFail === "0", JSON.stringify({ ...r, log: logJ(r, namesOut) }));
    check("判定 (27a) そのあと six は普通に正解", await typeNextJ(p, sixW, 2));
    check("判定 (27a) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  // (27b) Study で another（accept another one）の次の語 one を普通に打って正解にした後（引き分けの完成）、待ちの間にもう一度 one を打ち始める（o は待ちの間、n・e は 0.4 秒おき）:
  // 完成した語をなぞる打鍵として飲む（3 語目 door に流して×にしない）
  {
    const cards = [myConceptJ("another", "もう一つの（別の）", ["another one"]), myConceptJ("one", "一つ・1"), myDoorJ];
    const p = await openJ(seedMyJ(cards), cards[0]);
    const r = await sendPlanJ(p, {
      via: "input",
      plan: [..."another"].map((key, i) => ({ at: i * 60, key })),
      afterChange: [{ at: 50, key: "o" }, { at: 130, key: "n" }, { at: 210, key: "e" }, { at: 300, key: "o" }, { at: 700, key: "n" }, { at: 1100, key: "e" }],
      settleMs: 800
    });
    check("判定 (27b) Android の input 経路: Study で another の次の語 one を正解にした後、もう一度 one を打っても 3 語目 door に流さない（2 語とも正解・door は未入力・ミス 0・×なし）",
      r.score === "2" && r.ja === myDoorJ.q && r.miss === "0" && r.recallFail === "0" && r.input === "" && r.preview === "", JSON.stringify({ ...r, log: logJ(r, { [cards[0].q]: "another", [cards[1].q]: "one", [myDoorJ.q]: "door" }) }));
    check("判定 (27b) そのあと door は普通に正解", await typeNextJ(p, myDoorJ, 2));
    check("判定 (27b) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (28) 別解としての完成で続きがまだ続く（REVIEW-153 の 2）: hall（accept hallways）の次の語 manner（accept way）。窓の外で w・a をゆっくり打ち（続き ways の頭でも
  // 別解 way の頭でもある引き分け 2 字。続きはまだ始まっていない）→ y: 次の語は別解 way として完成するが、別解としての完成は続きが勝つ（別解は答えを見た扱いで自力にならない）。
  // y は次の語が受ける字なので打ち間違いの保留（typo）にはせず、この字で続きと決めて引き分けの字を次の語から外す。4 秒止まっても y を打ち間違い（×）にしない。
  // そのあと manner を打てば自力の正解（keydown・input 経路）
  for (const via of ["key", "input"]) {
    const cards = [myConceptJ("hall", "廊下・ホール", ["hallways"]), myConceptJ("manner", "やり方・方法", ["way"])];
    const p = await openMyChallengeJ(cards);
    const before = await numJ(p, "#score");
    const plan = [..."hall"].map((key, i) => ({ at: i * 60, key })).concat([{ at: 980, key: "w" }, { at: 1780, key: "a" }, { at: 2580, key: "y" }]);
    const r = await sendPlanJ(p, { via, plan, settleMs: 4600 });
    const msg = (await p.textContent("#message")).trim();
    const label = via === "key" ? "keydown" : "Android の input 経路";
    check(`判定 (28) ${label}: hall（accept hallways）の後に窓の外で w・a → y（次の語 manner の別解 way の完成）は続きが勝つ: 4 秒止まっても y を打ち間違いにしない（manner は未入力・別解の案内なし・ミス 0・×なし）`,
      Number(r.score) === before + 1 && r.ja === cards[1].q && r.input === "" && r.preview === "" && !msg.includes("manner") && r.miss === "0" && r.recallFail === "0",
      JSON.stringify({ ...r, msg, before, log: logJ(r, { [cards[0].q]: "hall", [cards[1].q]: "manner" }) }));
    for (const ch of "manner") await p.press("#input", ch);
    await waitUntil(async () => (await numJ(p, "#score")) === before + 2, 2500);
    const st = await statJ(p, "my-q-manner");
    check(`判定 (28) ${label}: そのあと manner を打てば自力の正解（思い出せた・ミス 0・×なし）`,
      (await numJ(p, "#score")) === before + 2 && (await numJ(p, "#miss")) === 0 && (await numJ(p, "#recallFail")) === 0 && !!st.lastRecallSuccessAt, JSON.stringify(st));
    check(`判定 (28) ${label} でエラー0`, p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (29) Android の input 経路: 保留（finish）を打ち直しの字で決着させて Study の待ちに入ったとき（judgeKey の "again"）も、入力欄と基準を待ちの通常の道と同じくそろえる
  // （REVIEW-153 の 3）。in（accept insider）の続き s・i・d・e と次の語 side: e で side が完成するが続き（r）もまだ続くので保留（side を見せる）。side を頭から打ち直す:
  // s で保留が決着して side の正解（待ちに入る）、s・i・d・e は完成した語をなぞる打鍵として飲む（3 語目 six の×にしない。do の打ち直しは最後の字で終わるので、守りが消えても
  // 見えない。4 字の語で見る）
  {
    const cards = [myConceptJ("in", "〜の中に", ["insider"]), myConceptJ("side", "側・面"), mySixJ];
    const p = await openJ(seedMyJ(cards), cards[0]);
    const r = await sendPlanJ(p, {
      via: "input",
      plan: [..."in"].map((key, i) => ({ at: i * 60, key })),
      afterChange: [..."side"].map((key, i) => ({ at: 50 + i * 80, key })).concat([..."side"].map((key, i) => ({ at: 600 + i * 300, key }))),
      settleMs: 700
    });
    check("判定 (29) Android の input 経路: Study で in の次の語 side を保留にしてから side を打ち直す: side の正解、打ち直しの字は 3 語目 six の×にしない（ミス 0・×なし・six は未入力）",
      r.score === "2" && r.ja === mySixJ.q && r.miss === "0" && r.recallFail === "0" && r.input === "" && r.preview === "", JSON.stringify({ ...r, log: logJ(r, { [cards[0].q]: "in", [cards[1].q]: "side", [mySixJ.q]: "six" }) }));
    check("判定 (29) そのあと six は普通に正解", await typeNextJ(p, mySixJ, 2));
    check("判定 (29) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (30)(31) Challenge の 3 語目が全文入力（Enter で判定）のとき。抽選を 1 枚目 → 2 枚目 → 3 枚目に固定して開く（Math.random を差し替える。
  // 先頭を引けば 1 枚目、次は 1 枚目を除いた先頭＝2 枚目。2 枚目を完成させる打鍵の直前に「並びの最後」へ替えると、まだ出ていない 3 枚目）
  async function openOrderedChallengeJ(cards) {
    const p = await newPage({ storage: seedMyChallengeJ(cards) });
    await p.goto(BASE + "/index.html?hintms=600000", { waitUntil: "networkidle" });
    await p.waitForTimeout(700);
    await p.evaluate(() => { Math.random = () => 0; });
    await p.press("#input", "Enter");
    await waitUntil(async () => (await jaJ(p)) === cards[0].q, 3000);
    return p;
  }
  const pickLastJ = (p) => p.evaluate(() => { Math.random = () => 0.9999; });
  // 1 打（Node から順に送る）。"key" は実キー（preventDefault されなければブラウザが入力欄に字を入れる）、"input" は Android の input 経路（値に 1 字足す）
  const pressJ = (p, key, via) => via === "key"
    ? p.keyboard.press(key)
    : p.evaluate((ch) => { const input = document.getElementById("input"); input.value += ch; input.dispatchEvent(new Event("input", { bubbles: true })); }, key);
  const snapFreeJ = async (p) => ({ ja: await jaJ(p), input: await p.inputValue("#input"), free: await p.evaluate(() => document.body.classList.contains("free-answer")), score: await numJ(p, "#score"), miss: await numJ(p, "#miss"), rf: await numJ(p, "#recallFail") });
  const myFreeJ = myConceptJ("in which", "前置詞＋関係代名詞（〜の中で）");
  // (30) another → one を引き分けの字で完成させ、3 語目が全文入力: 完成した語をなぞる続き（エコー）を全文入力の語に持ち越さない（REVIEW-153 の 4。setNewWord の守りと同じ）。
  // 続けて o・n・e を打つと、物理キーでも input 経路でも 3 語目の入力欄に入る（物理キーだけ飲んで input 経路では飲まない、という食い違いを作らない）
  for (const via of ["key", "input"]) {
    const cards = [myConceptJ("another", "もう一つの（別の）", ["another one"]), myConceptJ("one", "一つ・1"), myFreeJ];
    const p = await openOrderedChallengeJ(cards);
    for (const ch of "another") await pressJ(p, ch, via);
    const onOne = await waitUntil(async () => (await jaJ(p)) === cards[1].q, 1500);
    await pressJ(p, "o", via);
    await pressJ(p, "n", via);
    await pickLastJ(p);
    await pressJ(p, "e", via);
    for (const ch of "one") await pressJ(p, ch, via);
    await p.waitForTimeout(200);
    const s = await snapFreeJ(p);
    const label = via === "key" ? "物理キー" : "Android の input 経路";
    check(`判定 (30) ${label}: Challenge で another → one を引き分けの字で完成させ、3 語目が全文入力のとき、続けて打った o・n・e を飲み込まない（入力欄に one・ミス 0・×なし）`,
      onOne && s.ja === myFreeJ.q && s.free && s.input === "one" && s.score === 2 && s.miss === 0 && s.rf === 0, JSON.stringify(s));
    check(`判定 (30) ${label} でエラー0`, p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  // (31) out → do の保留中（do を見せて受理しない）に、3 語目（全文入力）の答えの 1 字目 i を打つ: i で保留が決着して do の正解、i は 3 語目のもの（REVIEW-153 の 5）。
  // 前の語の判定で preventDefault 済みのキーでも、全文入力の語の入力欄に入る（物理キー・input 経路）
  for (const via of ["key", "input"]) {
    const cards = [myConceptJ("out", "外へ・外に", ["outside", "outdoors"]), myConceptJ("do", "する"), myFreeJ];
    const p = await openOrderedChallengeJ(cards);
    for (const ch of "out") await pressJ(p, ch, via);
    const onDo = await waitUntil(async () => (await jaJ(p)) === cards[1].q, 1500);
    await pressJ(p, "d", via);
    await pressJ(p, "o", via);
    const held = { input: await p.inputValue("#input"), score: await numJ(p, "#score") };
    await pickLastJ(p);
    await pressJ(p, "i", via);
    await p.waitForTimeout(200);
    const s = await snapFreeJ(p);
    const label = via === "key" ? "物理キー" : "Android の input 経路";
    check(`判定 (31) ${label}: Challenge で out の次の語 do の保留中に、3 語目（全文入力）の 1 字目 i を打つと do の正解になり、i は 3 語目の入力欄に入る（ミス 0・×なし）`,
      onDo && held.input === "do" && held.score === 1 && s.ja === myFreeJ.q && s.free && s.input === "i" && s.score === 2 && s.miss === 0 && s.rf === 0, JSON.stringify({ held, ...s }));
    check(`判定 (31) ${label} でエラー0`, p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (32) Study の待ちの間に 2 打以上の続きを打ち切った後の、次の語の 1 打目（REVIEW-153 の 6）: 次の語は続きの最後の打鍵から SPILL_TAIL_MS（0.25 秒）で出す（テンポは変えない）が、
  // 続きの最後の打鍵から本来の待ち（js/afterCorrect.js の表。標準・例文つきの語は 0.7 秒）までの次の語の 1 打目で、次の語が拒む字（続きの直後の空白・複数形の s）は
  // ミスにせず捨てる（gym と打って空白を打つ人は、本来の待ちの間に空白が捨てられるのと同じ）。捨てるのは 1 打目だけ: 次の語が受ける字は普通に受け、2 打目からと、
  // 本来の待ちを過ぎてから打った字は今までどおり判定する
  const planGymJ = [..."gym"].map((key, i) => ({ at: i * 60, key })).concat([..."nasium"].map((key, i) => ({ at: 220 + i * 100, key }))); // 続きの最後の m は 720。次の語は 970 に出る
  for (const [label, via, extra] of [["keydown・空白", "key", " "], ["keydown・s", "key", "s"], ["Android の input 経路・s", "input", "s"]]) {
    const p = await openJ(seedJ("jhs-english1", [gym.id, door.id], { spelldash_after_correct: "standard" }), gym);
    const r = await sendPlanJ(p, { plan: planGymJ, afterChange: [{ at: 100, key: extra }], via, settleMs: 500 }); // 次の語は続きの見直し（100ms ごと）で m + 250〜350ms に出るので、出てから 100ms 後に打つ（守りは m + 700 まで）
    check(`判定 (32a) ${label}: gymnasium を打ち切った 0.35 秒後（次の語 door が出た後）の 1 打目は、door が拒む字でもミスにせず捨てる（door は未入力・ミス 0・×なし）`,
      r.log.at(-1)?.ja === door.ja && r.score === "1" && r.miss === "0" && r.recallFail === "0" && r.ja === door.ja && r.input === "" && r.preview === "", JSON.stringify({ ...r, log: logJ(r, namesGym) }));
    check(`判定 (32a) ${label}: そのあと door は普通に正解`, await typeNextJ(p, door, 1));
    check(`判定 (32a) ${label} でエラー0`, p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  {
    const p = await openJ(seedJ("jhs-english1", [gym.id, door.id], { spelldash_after_correct: "standard" }), gym);
    const r = await sendPlanJ(p, { plan: planGymJ, afterChange: [..."door"].map((key, i) => ({ at: 100 + i * 100, key })), settleMs: 400 });
    check("判定 (32b) gymnasium を打ち切った 0.35 秒後に次の語 door を 1 打目から打てば、普通に受けて正解（ミス 0・×なし）",
      r.log[9]?.ja === door.ja && r.score === "2" && r.miss === "0" && r.recallFail === "0", JSON.stringify({ ...r, log: logJ(r, namesGym) }));
    check("判定 (32b) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  {
    const p = await openJ(seedJ("jhs-english1", [gym.id, door.id], { spelldash_after_correct: "standard" }), gym);
    const r = await sendPlanJ(p, { plan: planGymJ, afterChange: [{ at: 100, key: " " }, { at: 200, key: "z" }], settleMs: 400 });
    check("判定 (32c) 捨てるのは 1 打目だけ: 空白の次の z は door の打鍵として判定する（ミス 1・思い出せず 1）",
      r.ja === door.ja && r.score === "1" && r.miss === "1" && r.recallFail === "1" && r.word === door.en, JSON.stringify({ ...r, log: logJ(r, namesGym) }));
    check("判定 (32c) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  {
    const p = await openJ(seedJ("jhs-english1", [gym.id, door.id], { spelldash_after_correct: "standard" }), gym);
    const r = await sendPlanJ(p, { plan: planGymJ.concat([{ at: 1720, key: " " }]), settleMs: 400 });
    check("判定 (32d) 本来の待ち（続きの最後の打鍵から 0.7 秒）を過ぎてから打った空白は、今までどおり door のミス（ミス 1・思い出せず 1）",
      r.ja === door.ja && r.score === "1" && r.miss === "1" && r.recallFail === "1" && r.word === door.en, JSON.stringify({ ...r, log: logJ(r, namesGym) }));
    check("判定 (32d) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  // (32e)(32f) 守りを立てるのは次の語を本当に SPILL_TAIL_MS で出したときだけ、幅は標準のペースの表の値まで（REVIEW-153 の 6 の反証）。
  // 本物の打ち間違いは捨てない: 守りの外の 1 打目は、gym とだけ打った人と同じく次の語のミス（1 ミス＝不正解）
  // (32e) 長いペース（例文つき 2.2 秒）で nasium を 1 打 0.45 秒で打つ: 続きの最後の m は 2470・door は m + 0.25 秒に出る。
  // door が見えて 1.3 秒後の f は打ち間違い（ミス 1・×。door を打ち直しても自力のノーミス正解にしない）。続きの直後（m + 0.35 秒）の空白は今までどおり捨てる
  const planGymSlowJ = [..."gym"].map((key, i) => ({ at: i * 60, key })).concat([..."nasium"].map((key, i) => ({ at: 220 + i * 450, key })));
  for (const [label, via] of [["keydown", "key"], ["Android の input 経路", "input"]]) {
    const p = await openJ(seedJ("jhs-english1", [gym.id, door.id], { spelldash_after_correct: "long" }), gym);
    const r = await sendPlanJ(p, { plan: planGymSlowJ, afterChange: [{ at: 1300, key: "f" }], via, settleMs: 400 });
    const missed = { ja: r.ja, score: r.score, miss: r.miss, recallFail: r.recallFail, word: r.word };
    for (const ch of door.en) await (via === "key" ? p.press("#input", ch) : pressJ(p, ch, via));
    await waitUntil(async () => ((await statJ(p, door.id)).playCount ?? 0) >= 1, 2000);
    const st = await statJ(p, door.id);
    check(`判定 (32e) ${label}: 長いペースで nasium をゆっくり打ち切り、door が見えて 1.3 秒後に打った f は door のミス（ミス 1・思い出せず 1）。door を打っても自力のノーミス正解にしない`,
      r.changedAt >= 2650 && r.log.at(-1)?.key === "f" && r.log.at(-1)?.ja === door.ja && missed.ja === door.ja && missed.score === "1" && missed.miss === "1" && missed.recallFail === "1" && missed.word === door.en &&
      (st.missCount ?? 0) >= 1 && (st.cleanCorrectStreak ?? 0) === 0, JSON.stringify({ ...missed, changedAt: r.changedAt, log: logJ(r, namesGym), stat: { playCount: st.playCount, missCount: st.missCount, cleanCorrectStreak: st.cleanCorrectStreak } }));
    check(`判定 (32e) ${label} でエラー0`, p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  {
    const p = await openJ(seedJ("jhs-english1", [gym.id, door.id], { spelldash_after_correct: "long" }), gym);
    const r = await sendPlanJ(p, { plan: planGymSlowJ, afterChange: [{ at: 100, key: " " }], settleMs: 400 });
    check("判定 (32e) 長いペースでも、続きを打ち切った直後（m の 0.35 秒後。door が出た後）の空白は捨てる（door は未入力・ミス 0・×なし）",
      r.log.at(-1)?.ja === door.ja && r.score === "1" && r.miss === "0" && r.recallFail === "0" && r.ja === door.ja && r.input === "" && r.preview === "", JSON.stringify({ ...r, log: logJ(r, namesGym) }));
    check("判定 (32e) 長いペース・直後の空白のあと door は普通に正解", await typeNextJ(p, door, 1));
    check("判定 (32e) 長いペース・直後の空白 でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  // (32f) 標準で gymnasium を速く打ち切る（m は gym を打ち終えて 0.24 秒後）: 待ちは縮まず、door は本来の待ちの終わり（gym を打ち終えて 0.7 秒）に出る。
  // door が見えて 0.18 秒後の f は、gym とだけ打った人と同じく door のミス（ミス 1・×）
  const planGymFastJ = [..."gym"].map((key, i) => ({ at: i * 60, key })).concat([..."nasium"].map((key, i) => ({ at: 160 + i * 40, key })));
  for (const [label, via] of [["keydown", "key"], ["Android の input 経路", "input"]]) {
    const p = await openJ(seedJ("jhs-english1", [gym.id, door.id], { spelldash_after_correct: "standard" }), gym);
    const r = await sendPlanJ(p, { plan: planGymFastJ, afterChange: [{ at: 180, key: "f" }], via, settleMs: 400 });
    check(`判定 (32f) ${label}: gymnasium を速く打ち切って door が本来の待ちで出た後の打ち間違い f は、door のミス（ミス 1・思い出せず 1）`,
      r.changedAt >= 760 && r.log.at(-1)?.key === "f" && r.log.at(-1)?.ja === door.ja && r.ja === door.ja && r.score === "1" && r.miss === "1" && r.recallFail === "1" && r.word === door.en,
      JSON.stringify({ ...r, log: logJ(r, namesGym) }));
    check(`判定 (32f) ${label} でエラー0`, p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // ---- PR #155 のレビュー（REVIEW-155）: 待ちを短くしたときの次の語が全文入力・1 打目の守りの使い切り・節目の待ちの守りの幅・全文入力の語へ戻す字 ----
  // (33) 待ちを短くして出す次の語が全文入力のとき（REVIEW-155 の 1）: マイ単語帳の gym（accept gymnasium）の次が全文入力の句（a lot of）。標準（概念カード 0.9 秒）で
  // gym を打ち、待ちの間に nasium を打ち切って（最後の m は gym を打ち終えて 0.85 秒）、m の 0.4 秒後に余分な s。次の語が全文入力なら待ちを短くしない
  // （次の語を出す時刻 = max(本来の待ちの終わり, 続きの最後の打鍵 + 本来の待ち) = m + 0.9 秒）ので、s は待ちの間に捨てる（gym とだけ打つ人の s と同じ）。
  // 以前は m + 0.25 秒に句が出て、s が入力欄に入り「sa lot of」で Enter → 思い出せず。物理キー（止められなかった字は入力欄に入る）・Android の input 経路
  const myLotJ = myConceptJ("a lot of", "たくさんの（数えられる名詞にも、数えられない名詞にも）");
  const planGymMyJ = [..."gym"].map((key, i) => ({ at: i * 60, key })).concat([..."nasium"].map((key, i) => ({ at: 220 + i * 150, key }))); // m は 970（gym を打ち終えて 0.85 秒）
  for (const [label, via] of [["物理キー", "type"], ["Android の input 経路", "input"]]) {
    const cards = [myGymJ, myLotJ, myDoorJ];
    const p = await openJ({ ...seedMyJ(cards), spelldash_after_correct: "standard" }, cards[0]);
    const r = await sendPlanJ(p, { plan: planGymMyJ.concat([{ at: 1370, key: "s" }]), via, settleMs: 1300 });
    const shown = { ja: r.ja, input: r.input, free: await p.evaluate(() => document.body.classList.contains("free-answer")), sAt: r.log.at(-1)?.ja === myGymJ.q ? "gym" : r.log.at(-1)?.ja };
    if (via === "type") await p.keyboard.type("a lot of");
    else for (const ch of "a lot of") await pressJ(p, ch, "input");
    await p.press("#input", "Enter");
    // 句の正解の後は本来の待ち（概念カード 0.9 秒）の後に door が出る。×なら答えが開いてそこで止まる
    await waitUntil(async () => (await jaJ(p)) === myDoorJ.q || (await numJ(p, "#recallFail")) > 0, 3000);
    const end = { score: await numJ(p, "#score"), miss: await numJ(p, "#miss"), rf: await numJ(p, "#recallFail"), ja: await jaJ(p) };
    check(`判定 (33) ${label}: gym の続きを打ち切って次の語が全文入力のとき、待ちは短くしない（続きの直後の s は待ちの間に捨てる。句の入力欄は空）`,
      shown.sAt === "gym" && shown.ja === myLotJ.q && shown.free && shown.input === "" && r.score === "1" && r.miss === "0" && r.recallFail === "0",
      JSON.stringify({ ...shown, changedAt: r.changedAt, log: logJ(r, { [myGymJ.q]: "gym", [myLotJ.q]: "lot" }) }));
    check(`判定 (33) ${label}: そのあと a lot of と打って Enter で句の正解（思い出せず 0・ミス 0）`, end.score === 2 && end.miss === 0 && end.rf === 0 && end.ja === myDoorJ.q, JSON.stringify(end));
    check(`判定 (33) ${label} でエラー0`, p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (34) 1 打目の守りは、次の語が出た後の最初の打鍵で使い切る（どの経路でも、文字でも空白でも。REVIEW-155 の 2）。待ちの間に飲んだ余分な打鍵でも使い切る
  // (34a) Study・標準で gymnasium を打ち切り（m は 720）、door が m + 0.25 秒に出た後に空白 → 0.2 秒後に打ち間違い f（守りの幅 m + 0.7 秒の中）: 空白で守りを使ったので f は door のミス。
  //       以前は Android の input 経路の空白（a-z だけを見るので判定に入らない）では守りが残り、f が黙って捨てられて door が自力の正解になった。物理キーと同じ結果
  for (const [label, via] of [["keydown", "key"], ["Android の input 経路", "input"]]) {
    const p = await openJ(seedJ("jhs-english1", [gym.id, door.id], { spelldash_after_correct: "standard" }), gym);
    const r = await sendPlanJ(p, { plan: planGymJ, afterChange: [{ at: 50, key: " " }, { at: 250, key: "f" }], via, settleMs: 400 });
    check(`判定 (34a) ${label}: door が出た後の空白で 1 打目の守りを使い、その後の打ち間違い f は door のミス（ミス 1・思い出せず 1）`,
      r.log.at(-2)?.key === " " && r.log.at(-2)?.ja === door.ja && r.ja === door.ja && r.score === "1" && r.miss === "1" && r.recallFail === "1" && r.word === door.en,
      JSON.stringify({ ...r, log: logJ(r, namesGym) }));
    check(`判定 (34a) ${label} でエラー0`, p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  // (34b) ローマ字の語でも同じ: マイ単語帳の gym の次が 遺跡（読みをローマ字で打つ。空白は判定に入らない）。標準（概念カード 0.9 秒）で nasium を打ち切り（m は 970）、
  //       遺跡 が出た後に空白 → f: 空白で守りを使ったので f は 遺跡 のミス（以前は守りが残り、f が黙って捨てられた）
  {
    const isekiJ = myConceptJ("遺跡", "昔の人の生活の跡", ["いせき"]);
    const cards = [myGymJ, isekiJ, myDoorJ];
    const p = await openJ({ ...seedMyJ(cards), spelldash_after_correct: "standard" }, cards[0]);
    const r = await sendPlanJ(p, { plan: planGymMyJ, afterChange: [{ at: 50, key: " " }, { at: 250, key: "f" }], settleMs: 400 });
    check("判定 (34b) ローマ字の語: 次の語が出た後の空白で 1 打目の守りを使い、その後の打ち間違い f はミス（ミス 1・思い出せず 1）",
      r.log.at(-2)?.ja === isekiJ.q && r.ja === isekiJ.q && r.score === "1" && r.miss === "1" && r.recallFail === "1", JSON.stringify({ ...r, log: logJ(r, { [myGymJ.q]: "gym", [isekiJ.q]: "遺跡" }) }));
    check("判定 (34b) でエラー0", p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }
  // (34c) 続きを打ち切った後の余分な 1 打（空白）が待ちの間に来て捨てられたら、守りはもう使った: door が出た後の打ち間違い f は door のミス（keydown・input 経路）
  for (const [label, via] of [["keydown", "key"], ["Android の input 経路", "input"]]) {
    const p = await openJ(seedJ("jhs-english1", [gym.id, door.id], { spelldash_after_correct: "standard" }), gym);
    const r = await sendPlanJ(p, { plan: planGymJ.concat([{ at: 820, key: " " }]), afterChange: [{ at: 100, key: "f" }], via, settleMs: 400 });
    check(`判定 (34c) ${label}: 続きの直後の空白が待ちの間に捨てられた後、door が出てから打ち間違えた f は door のミス（ミス 1・思い出せず 1）`,
      r.log.at(-2)?.key === " " && r.log.at(-2)?.ja === gym.ja && r.log.at(-1)?.ja === door.ja && r.score === "1" && r.miss === "1" && r.recallFail === "1" && r.word === door.en,
      JSON.stringify({ ...r, log: logJ(r, namesGym) }));
    check(`判定 (34c) ${label} でエラー0`, p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (35) 節目（覚えた の印）で待ちが長いときの守りの幅（REVIEW-155 の 3）: マイ単語帳の gym（すぐ次へ＝表の値 0.25 秒）が覚えた の印を取り、待ちは 1.4 秒。
  // 続きの nasium を gym の 1.3 秒後に打ち切ると次の語は m + 0.25 秒に出る。守りの終わりは m + min(本来の待ち 1.4 秒, 概念カードの標準の値 0.9 秒)。
  // (35a) 次の語が出た直後の余分な s は捨てる（以前は守りの幅が表の値 0.25 秒で 0 になり、s が door のミス・×）。(35b) 守りを過ぎた打ち間違い f は door のミス
  const yJ = new Date(Date.now() - 86400000);
  const learnedSeedJ = (cards) => ({
    ...seedMyJ(cards),
    spelldash_word_stats: JSON.stringify({ "my-q-gym": { playCount: 1, correctCount: 0, missCount: 1, typingMiss: 0, recallFail: 1, cleanCorrectStreak: 0, mastered: false, lastPlayed: yJ.toISOString(), nextReviewAt: yJ.toISOString(), lastRecallFailAt: yJ.toISOString(), lastRecallSuccessAt: null, history: [{ d: ymd(yJ), r: "x" }] } })
  });
  const planGymLearnedJ = [..."gym"].map((key, i) => ({ at: i * 60, key })).concat([..."nasium"].map((key, i) => ({ at: 420 + i * 200, key }))); // m は 1420（gym を打ち終えて 1.3 秒）
  for (const [label, extra, at] of [["(35a) 次の語が出た直後（0.05 秒）の s は捨てる（door は未入力・ミス 0・×なし）", "s", 50], ["(35b) 守り（m + 0.9 秒）を過ぎてから打った f は door のミス（ミス 1・思い出せず 1）", "f", 800]]) {
    const cards = [myGymJ, myDoorJ];
    const p = await openJ(learnedSeedJ(cards), cards[0]);
    const r = await sendPlanJ(p, { plan: planGymLearnedJ, afterChange: [{ at, key: extra }], settleMs: 400 });
    const msg = (await p.textContent("#message")).trim();
    const missed = extra === "f";
    check(`判定 ${label}`,
      r.changedAt >= 1600 && r.log.at(-1)?.ja === myDoorJ.q && r.ja === myDoorJ.q && r.score === "1" &&
      (missed ? r.miss === "1" && r.recallFail === "1" && r.word === "door" : msg.includes("覚えた") && r.miss === "0" && r.recallFail === "0" && r.input === "" && r.preview === ""),
      JSON.stringify({ ...r, msg, log: logJ(r, { [myGymJ.q]: "gym", [myDoorJ.q]: "door" }) }));
    if (!missed) check("判定 (35a) そのあと door は普通に正解", await typeNextJ(p, myDoorJ, 1));
    check(`判定 ${label.slice(0, 5)} でエラー0`, p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
  }

  // (36) Android の input 経路で、保留の決着の後に全文入力の語の入力欄へ戻す字は、入力欄に実際に打たれた字のまま（REVIEW-155 の 4）: Challenge で out の次の語 do の保留中に、
  // 3 語目（全文入力の in which）の頭を 1 回の input で「In wh」（候補の確定・スワイプ）と入れる → do の正解、3 語目の入力欄は「In wh」（大文字も空白も残す）。
  // 以前は小文字にして a-z 以外を落とした「inwh」になっていた。物理キー（event.key をそのまま入れる）と同じ
  for (const via of ["key", "input"]) {
    const cards = [myConceptJ("out", "外へ・外に", ["outside", "outdoors"]), myConceptJ("do", "する"), myFreeJ];
    const p = await openOrderedChallengeJ(cards);
    for (const ch of "out") await pressJ(p, ch, via);
    const onDo = await waitUntil(async () => (await jaJ(p)) === cards[1].q, 1500);
    await pressJ(p, "d", via);
    await pressJ(p, "o", via);
    await pickLastJ(p);
    if (via === "key") await p.keyboard.type("In wh");
    else await p.evaluate(() => { const input = document.getElementById("input"); input.value += "In wh"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    await p.waitForTimeout(200);
    const s = await snapFreeJ(p);
    const label = via === "key" ? "物理キー" : "Android の input 経路";
    check(`判定 (36) ${label}: do の保留中に 3 語目（全文入力）へ「In wh」と入れると、do の正解・3 語目の入力欄は打ったとおりの「In wh」（ミス 0・×なし）`,
      onDo && s.ja === myFreeJ.q && s.free && s.input === "In wh" && s.score === 2 && s.miss === 0 && s.rf === 0, JSON.stringify(s));
    check(`判定 (36) ${label} でエラー0`, p.errors.length === 0, p.errors[0] ?? "");
    await p.close();
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
    const linked = ["index.html", "stats.html", "list.html", "battle.html", "profile.html", "news.html", "privacy.html", "typing.html", "typing-game.html"].filter((f) => fs.readFileSync(path.join(ROOT, f), "utf8").includes("admin.html"));
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
    check("動線: ログインから戻ると加入画面へ戻り「ログインした。月額か年額を選ぶ。」", back && resumed && !page.url().includes("resume="), `${page.url()} / ${await text(page, "#proMessage")} / plans=${(await text(page, "#proPlans")).slice(0, 60)} / auth=${await text(page, "#authMessage")}`);
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
    check("無料期間: 初めての人にはサーバーの終わりの日（11/7 に 月額…を請求）", (await text(first, ".pro-terms")).includes("11/7 に 月額 ¥580"), await text(first, ".pro-terms"));
    await first.close();

    const again = await newPage({ storage: proStorage({ status: "canceled", current_period_end: isoDaysFromNow(-40) }) });
    await again.goto(BASE + "/pro.html", { waitUntil: "networkidle" });
    await waitUntil(async () => (await again.$("#proCheckoutMonth")) !== null, 5000);
    check("無料期間: 以前に加入した人のボタンは「月額 ¥580 で始める」（無料と言わない）", (await text(again, "#proCheckoutMonth")) === "月額 ¥580 で始める" && !(await text(again, "#proPrice")).includes("無料"), `${await text(again, "#proCheckoutMonth")} / ${await text(again, "#proPrice")}`);
    check("無料期間: 以前に加入した人には「今回は加入した日に…請求」", (await text(again, ".pro-terms")).includes("以前に加入したことがあるので"), await text(again, ".pro-terms"));
    await again.close();
    await fetch(BASE + "/__billing/trial?months=0", { method: "POST" });
  }

  // 2h. 初めての人がホームを開いただけ（成長ログに 0 語の行が 1 つ）でログインしても、「この端末の記録を足す」をたずねない
  {
    const page = await newPage();
    const dialogs = [];
    page.on("dialog", (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    const growth = await page.evaluate(() => localStorage.getItem("spelldash_growth_log") || "");
    await page.evaluate(() => localStorage.setItem("spelldash_test_session", "1"));
    await page.goto(BASE + "/index.html#access_token=test&type=magiclink", { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    check("同期: 学んでいない端末（成長ログは 0 語の行だけ）でログインしても、記録を足すかをたずねない", dialogs.length === 0 && (await page.evaluate(() => localStorage.getItem("spelldash_test_session"))) === "1", `dialogs=${dialogs.join("|")} growth=${growth.slice(0, 80)}`);
    await page.close();
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
    check("Pro: 紙の meta theme-color は帯の色", (await page2.$eval('meta[name="theme-color"]', (el) => el.content)) === "#20243A");
    await page2.goto(BASE + "/index.html", { waitUntil: "domcontentloaded" });
    const early = await theme(page2); // head スニペットが付ける（theme.js より前）
    await page2.waitForTimeout(600);
    check("Pro: 再読込後も紙（head スニペット → theme.js）", early === "paper" && (await theme(page2)) === "paper", `early=${early} after=${await theme(page2)}`);
    await page2.goto(BASE + "/profile.html", { waitUntil: "networkidle" });
    await page2.waitForTimeout(600);
    await page2.selectOption("#themeSelect", "indigo");
    await page2.waitForTimeout(200);
    check("Pro: Pro が藍を選ぶと data-theme=indigo", (await theme(page2)) === "indigo" && (await page2.$eval('meta[name="theme-color"]', (el) => el.content)) === "#03050C");
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
    const missing = ["index.html", "battle.html", "stats.html", "profile.html", "privacy.html", "news.html", "list.html", "admin.html", "pro.html", "tokushoho.html", "typing.html", "typing-game.html"].filter((f) => {
      const html = fs.readFileSync(path.join(ROOT, f), "utf8");
      const nav = html.match(/<nav class="site-footer__nav"[\s\S]*?<\/nav>/)?.[0] ?? "";
      return !(nav.includes(LINK) && nav.indexOf('href="./privacy.html"') < nav.indexOf(LINK));
    });
    check("Pro: 全 12 ページのフッターにプライバシーの直後の特商法リンク", missing.length === 0, missing.join(","));
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
    await page.waitForTimeout(NEXT_READY_MS);
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
    check("同期: 道が中学英語 2年になる（開き直さずに）", pathHead.includes("中学英語 2年") || pathHead.includes("第2巻／"), pathHead);
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

  // 本棚（Batch 61）: 2 台目の棚は届いた机の本とパックから組み立つ（移行が同期の前でも後でも同じ）。使っていない中学英語やり直しは出ない。shelf の行はクラウドに送らない
  {
    const wordsIn = (cat) => { const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "packs", `${cat}.json`), "utf8")); return (Array.isArray(raw) ? raw : raw.words).filter((w) => !w.kanjiOnly); };
    const packRow = (id) => ({ user_id: SYNC_USER, kind: "pack", key: id, payload: { enabled: true }, deleted: false, updated_at: isoDaysAgo(1) });
    const shelfOn = async (page) => {
      await waitUntil(async () => (await page.evaluate(() => [...document.querySelectorAll("#shelfRun li[data-key]")].some((li) => li.dataset.key === "b:jhist1" && li.dataset.state === "slot"))), 8000);
      await page.waitForTimeout(400);
      return page.evaluate(() => ({ keys: [...document.querySelectorAll("#shelfRun li[data-key]")].map((li) => (li.dataset.state === "slot" ? "slot:" : "") + li.dataset.key), saved: JSON.parse(localStorage.getItem("spelldash_shelf") || "null") }));
    };
    {
      const cloud = createCloud({ word_progress: wordsIn("jhist1").slice(0, 3).map(wpRow), user_progress: [userProgress({ selected_category: "jhist1" })], user_items: [packRow("jhist1"), packRow("eiken3")] });
      const page = await syncDevice(login(cloud));
      await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
      await ownerSet(page);
      const r = await shelfOn(page);
      await page.waitForTimeout(600);
      const shelfRows = cloud.rows("user_items").filter((x) => x.kind === "shelf").length;
      check("2 台目（ログイン）: 届いた机の本とパックから棚が組み立つ（背 英検3級・空き 中学歴史）。既定の中学英語やり直し・中学英語 1年は出ない。クラウドに shelf の行を送らない", JSON.stringify(r.keys) === JSON.stringify(["b:eiken3", "slot:b:jhist1"]) && shelfRows === 0 && page.errors.length === 0, JSON.stringify({ ...r, shelfRows, errors: page.errors.slice(0, 2) }));
      await page.close();
    }
    {
      const cloud = createCloud({ word_progress: [...wordsIn("eiken5").slice(0, 20), ...wordsIn("jhist1").slice(0, 3)].map(wpRow), user_progress: [userProgress({ selected_category: "jhist1" })], user_items: [packRow("eiken5"), packRow("jhist1")] });
      const page = await syncDevice(login(cloud));
      await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
      await ownerSet(page);
      const r = await shelfOn(page);
      const shared = wordsIn("eiken5").slice(0, 20).filter((w) => wordsIn("jhs-english1").some((x) => x.id === w.id)).length;
      check("2 台目（ログイン）: 英語の記録（英検5級 20 語。中学英語 1年と同じ id の語を含む）が届いても、使っていない中学英語やり直し・中学英語 1年は出ない（背 英検5級・空き 中学歴史、移行し直して prov false）", shared > 0 && JSON.stringify(r.keys) === JSON.stringify(["b:eiken5", "slot:b:jhist1"]) && r.saved?.prov === false && page.errors.length === 0, JSON.stringify({ ...r, shared, errors: page.errors.slice(0, 2) }));
      await page.close();
    }
    {
      // PR #152 レビュー B3・B8: 取り込みの途中かは js/sync.js の isPulling() が答え、時刻はその取り込みを始めた時（SYNCED_FLAG を立てた時）。
      // 同じタブで同じアカウントの 2 回目の取り込みが 1 回目から 2 分以上たって始まっても、その途中では棚を保存しない。止まった印は始めてから 2 分で諦める
      const cloud = createCloud({ word_progress: wordsIn("jhist1").slice(0, 3).map(wpRow), user_progress: [userProgress({ selected_category: "jhist1" })], user_items: [packRow("jhist1"), packRow("eiken3")] }, { delayMs: 2500 });
      const page = await syncDevice(login(cloud));
      const probe = () => page.evaluate(async () => {
        const b = await import("/js/bookshelf.js");
        const s = await import("/js/sync.js");
        b.updateBookshelf();
        b.renderBookshelf();
        return { pulling: typeof s.isPulling === "function" ? s.isPulling() : null, shelf: localStorage.getItem("spelldash_shelf") };
      });
      await page.goto(BASE + "/index.html", { waitUntil: "domcontentloaded" });
      // 1 回目の取り込みの途中に本棚を描く（直す前の本棚は、ここで「途中を初めて見た時刻」を覚えていた）
      const during1 = await waitUntil(() => page.evaluate(() => sessionStorage.getItem("spelldash_synced_this_session") === "test-user" && !sessionStorage.getItem("spelldash_pulled_this_session") && !!document.querySelector("#shelfRun .shelf")), 8000);
      const p1 = await probe();
      await ownerSet(page);
      await shelfOn(page);
      // ログアウト → 時計を 130 秒進める → 同じアカウントでもう一度ログイン（2 回目の取り込みは 3 秒かかる）。棚は消しておき、途中で保存されたら分かるように
      await page.click("#avatarButton");
      await page.click("#logoutButton");
      await waitUntil(async () => (await txt(page, "#authMessage")).startsWith("ログアウト"), 3000);
      await page.evaluate(() => {
        const real = Date.now.bind(Date);
        window.__nowOffset = 130000;
        Date.now = () => real() + window.__nowOffset;
        localStorage.removeItem("spelldash_shelf");
      });
      cloud.config.delayMs = 3000;
      await page.evaluate(() => window.__stubAuth.signIn());
      const during2 = await waitUntil(async () => (await ss(page, "spelldash_synced_this_session")) === SYNC_USER && (await ss(page, "spelldash_pulled_this_session")) === null, 3000);
      const p2 = await probe();
      const stale = await page.evaluate(async () => {
        const s = await import("/js/sync.js");
        if (typeof s.isPulling !== "function") return null;
        window.__nowOffset += 121000; // 2 回目を始めてから 2 分を過ぎた（止まった印とみなす）
        const late = s.isPulling();
        window.__nowOffset -= 121000;
        return { late, back: s.isPulling() };
      });
      const pulled = await waitUntil(async () => (await ss(page, "spelldash_pulled_this_session")) === SYNC_USER, 8000);
      const p3 = await probe();
      const saved3 = JSON.parse(p3.shelf || "null");
      check("同期（本棚・B3・B8）: 取り込みの途中かは sync.js の isPulling()。ログアウトして時計を 130 秒進め、同じアカウントの 2 回目の取り込みが始まっても、その途中は棚を保存しない（updateBookshelf・renderBookshelf を呼んでも spelldash_shelf は空のまま）。2 回目を始めてから 2 分を過ぎた印は途中とみなさない。取り込み終えたら保存する（背 英検3級・空き 中学歴史の棚）",
        during1 && p1.pulling === true && during2 && p2.pulling === true && p2.shelf === null && stale?.late === false && stale?.back === true && pulled && p3.pulling === false && saved3?.v === 1 && !!saved3?.books.includes("eiken3") && page.errors.length === 0,
        JSON.stringify({ during1, p1, during2, p2, stale, pulled, p3: { pulling: p3.pulling, saved3 }, errors: page.errors.slice(0, 2) }));
      await page.close();
    }
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

// ===== 21.5 タイピング練習から来た端末（first_visit の source に typing*。SQL は変えない。docs/SQL_FUNNEL.md 5） =====
console.log("typing funnel:");
{
  const cloud = createCloud({});
  const rows = () => cloud.rows("funnel_events");
  const of = (device, src) => rows().filter((r) => r.device_id === device && r.step === "first_visit" && (src === undefined || r.source === src));
  const deviceOf = (page) => page.evaluate(() => localStorage.getItem("spelldash_device_id"));
  const stateOf = (page) => page.evaluate(() => document.getElementById("typingBoard").dataset.state);
  const restOf = (page) => page.evaluate(() => document.getElementById("typingWord").dataset.rest);

  // T26・T27: 新しい端末がタイピング練習から来た
  const page = await newPage({ storage: { spelldash_test_cloud: cloud.id } });
  await page.goto(BASE + "/typing.html?t=2", { waitUntil: "networkidle" });
  await waitUntil(async () => rows().filter((r) => r.step === "first_visit").length >= 2, 5000);
  const device = await deviceOf(page);
  const arrived = of(device);
  await page.keyboard.press("a");
  const started = await waitUntil(async () => of(device, "typing_start").length === 1, 5000);
  await waitUntil(async () => (await stateOf(page)) === "result", 5000);
  const done = await waitUntil(async () => of(device, "typing_done").length === 1, 5000);
  await page.waitForTimeout(700);
  await page.keyboard.press("Enter");
  await page.keyboard.press((await restOf(page))[0]);
  await waitUntil(async () => (await stateOf(page)) === "result", 5000);
  await page.waitForTimeout(700);
  const once = of(device, "typing_start").length === 1 && of(device, "typing_done").length === 1 && of(device, "typing").length === 1;
  check("計測: タイピング練習から初めて来た端末は first_visit が空と typing の 2 行、打ち始め → typing_start、結果 → typing_done（来た日で 1 回だけ）", arrived.length === 2 && arrived.some((r) => r.source === "") && arrived.some((r) => r.source === "typing") && new Set(arrived.map((r) => r.day)).size === 1 && started && done && once && of(device).every((r) => r.day === arrived[0].day), JSON.stringify(of(device).map((r) => `${r.source}:${r.day}`)));
  await page.click("#typingStudy");
  await page.waitForURL(/from=typing/, { timeout: 5000 }).catch(() => {});
  const study = await waitUntil(async () => of(device, "typing_study").length === 1, 5000);
  check("計測: 「思い出して打つ」→ 次のページで typing_study", study && of(device, "typing_study")[0]?.day === arrived[0]?.day, JSON.stringify(of(device).map((r) => r.source)));
  check("計測（タイピング練習）でエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();

  // T28: 学習記録のある端末・ほかのページから来た端末・途中で離れた回
  const typed = async (p) => {
    await p.goto(BASE + "/typing.html?t=2", { waitUntil: "networkidle" });
    await p.keyboard.press("a");
    await waitUntil(async () => (await stateOf(p)) === "result", 5000);
    await p.waitForTimeout(600);
  };
  const learner = await newPage({ storage: { spelldash_test_cloud: cloud.id, spelldash_word_stats: JSON.stringify({ apple: { attempts: 1, correct: 1 } }) } });
  await typed(learner);
  const learnerId = await deviceOf(learner);
  const learnerRows = rows().filter((r) => r.device_id === learnerId && r.source.startsWith("typing"));
  await learner.close();
  const visitor = await newPage({ storage: { spelldash_test_cloud: cloud.id } });
  await visitor.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  const visitorId = await deviceOf(visitor);
  await waitUntil(async () => of(visitorId, "").length === 1, 5000);
  await typed(visitor);
  const visitorRows = rows().filter((r) => r.device_id === visitorId && r.source.startsWith("typing"));
  await visitor.close();
  const leaver = await newPage({ storage: { spelldash_test_cloud: cloud.id } });
  await leaver.goto(BASE + "/typing.html?t=2", { waitUntil: "networkidle" });
  const leaverId = await deviceOf(leaver);
  await leaver.keyboard.press("a");
  await waitUntil(async () => of(leaverId, "typing_start").length === 1, 5000);
  await leaver.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await leaver.waitForTimeout(2600);
  const leaverState = await stateOf(leaver);
  await leaver.close();
  check("計測: 学習記録のある端末・ほかのページから来た端末は typing の行を送らない／途中で離れた回は typing_done を送らない", learnerRows.length === 0 && visitorRows.length === 0 && of(leaverId, "typing_start").length === 1 && of(leaverId, "typing_done").length === 0 && leaverState === "ready", JSON.stringify({ learnerRows, visitorRows, leaver: of(leaverId).map((r) => r.source), leaverState }));

  // T30: 2 つの族は排他（js/funnelLog.js markTypingArrival は番号だけに頼らない）。タイピングゲームの印だけがある端末（番号なし: 消された・作れなかった）が
  // タイピング練習を開いて打っても、typing の印は立たず typing* の first_visit を送らない
  {
    const day = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const p = await newPage({ storage: { spelldash_test_cloud: cloud.id, spelldash_funnel_tgame: day } });
    await p.goto(BASE + "/typing.html?t=2", { waitUntil: "networkidle" });
    const id = await deviceOf(p);
    const first = await waitUntil(async () => of(id, "").length === 1, 5000);
    await p.keyboard.press("a");
    await waitUntil(async () => (await stateOf(p)) === "result", 5000);
    await p.waitForTimeout(600);
    const mark = await p.evaluate(() => localStorage.getItem("spelldash_funnel_typing"));
    const sent = rows().filter((r) => r.device_id === id && r.source.startsWith("typing"));
    check("計測: タイピングゲームの印だけがある端末（番号なし）がタイピング練習を開いて打っても typing の印は立たず、typing* を送らない", Boolean(id) && first && mark === null && sent.length === 0 && p.errors.length === 0, JSON.stringify({ id: Boolean(id), first, mark, sent: sent.map((r) => r.source), errors: p.errors.slice(0, 2) }));
    await p.close();
  }

  // T31: 長文（docs/SPEC_TYPING.md「長文」）。新しい端末が長文のタブを押す → typing_long、長文を打ち始める（最初に判定したキー）→ typing_long_start
  // （typing_start も長文の回で入る）、最後まで打つ → typing_long_done と typing_done（どれも来た日で 1 回だけ）。途中までの結果（Esc・出す時間 5 秒以上）では
  // typing_long_done・typing_done を送らない。学習記録のある端末・ほかのページから来た端末には送らない
  {
    const SKEW = () => {
      window.__skew = 0;
      const now0 = performance.now.bind(performance);
      performance.now = () => now0() + window.__skew;
    };
    const longKeys = (p, n = 5000) => p.evaluate((max) => {
      const word = document.getElementById("typingWord");
      const board = document.getElementById("typingBoard");
      for (let i = 0; i < max && board.dataset.state !== "result"; i++) {
        const k = word.dataset.rest?.[0];
        if (!k) break;
        (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
      }
    }, n);
    const openLong = async (p) => {
      await p.click('.tp-tabs [data-kind="long"]');
      await waitUntil(async () => (await stateOf(p)) === "ready", 5000);
    };
    const p = await newPage({ storage: { spelldash_test_cloud: cloud.id } });
    await p.goto(BASE + "/typing.html?l=1", { waitUntil: "networkidle" });
    const id = await deviceOf(p);
    await waitUntil(async () => of(id, "typing").length === 1, 5000);
    await openLong(p);
    const tabbed = await waitUntil(async () => of(id, "typing_long").length === 1, 5000);
    const before = of(id, "typing_long_start").length + of(id, "typing_start").length;
    await longKeys(p, 1);
    const started = await waitUntil(async () => of(id, "typing_long_start").length === 1 && of(id, "typing_start").length === 1, 5000);
    await longKeys(p);
    await waitUntil(async () => (await stateOf(p)) === "result", 5000);
    const done = await waitUntil(async () => of(id, "typing_long_done").length === 1 && of(id, "typing_done").length === 1, 5000);
    await p.waitForTimeout(700);
    await p.keyboard.press("Enter");
    await longKeys(p);
    await waitUntil(async () => (await stateOf(p)) === "result", 5000);
    await p.waitForTimeout(800);
    const once = ["typing_long", "typing_long_start", "typing_long_done", "typing_start", "typing_done"].every((s) => of(id, s).length === 1);
    const day = of(id, "typing")[0]?.day;
    check("計測（長文）: タイピング練習から初めて来た端末が長文のタブを押すと typing_long、最初に判定したキーで typing_long_start（typing_start も）、最後まで打つと typing_long_done と typing_done（来た日で 1 回だけ。2 回目の完走でも増えない）",
      tabbed && before === 0 && started && done && once && ["typing_long", "typing_long_start", "typing_long_done"].every((s) => of(id, s)[0]?.day === day) && p.errors.length === 0,
      JSON.stringify({ rows: of(id).map((r) => `${r.source}:${r.day}`), errors: p.errors.slice(0, 2) }));
    await p.close();

    // 途中までの結果（Esc・出す時間 6 秒）は typing_long_done・typing_done を送らない
    const q = await newPage({ storage: { spelldash_test_cloud: cloud.id } });
    await q.addInitScript(SKEW);
    await q.goto(BASE + "/typing.html?l=2", { waitUntil: "networkidle" });
    const qid = await deviceOf(q);
    await openLong(q);
    await longKeys(q, 1);
    await q.evaluate(() => { window.__skew += 6000; });
    await longKeys(q, 1);
    await q.keyboard.press("Escape");
    const partial = await q.evaluate(() => document.getElementById("typingBoard").dataset.partial === "1" && document.getElementById("typingBoard").dataset.state === "result");
    await waitUntil(async () => of(qid, "typing_long_start").length === 1, 5000);
    await q.waitForTimeout(1200);
    check("計測（長文）: 途中までの結果（Esc）では typing_long_done・typing_done を送らない（typing_long・typing_long_start は送る）",
      partial && of(qid, "typing_long").length === 1 && of(qid, "typing_long_start").length === 1 && of(qid, "typing_long_done").length === 0 && of(qid, "typing_done").length === 0 && q.errors.length === 0,
      JSON.stringify({ partial, rows: of(qid).map((r) => r.source), errors: q.errors.slice(0, 2) }));
    await q.close();

    // 学習記録のある端末・ほかのページから来た端末は長文を打ち切っても送らない
    const learnerL = await newPage({ storage: { spelldash_test_cloud: cloud.id, spelldash_word_stats: JSON.stringify({ apple: { attempts: 1, correct: 1 } }) } });
    await learnerL.goto(BASE + "/typing.html?l=1", { waitUntil: "networkidle" });
    await openLong(learnerL);
    await longKeys(learnerL);
    await waitUntil(async () => (await stateOf(learnerL)) === "result", 5000);
    await learnerL.waitForTimeout(800);
    const learnerLId = await deviceOf(learnerL);
    await learnerL.close();
    const visitorL = await newPage({ storage: { spelldash_test_cloud: cloud.id } });
    await visitorL.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    const visitorLId = await deviceOf(visitorL);
    await waitUntil(async () => of(visitorLId, "").length === 1, 5000);
    await visitorL.goto(BASE + "/typing.html?l=1", { waitUntil: "networkidle" });
    await openLong(visitorL);
    await longKeys(visitorL);
    await waitUntil(async () => (await stateOf(visitorL)) === "result", 5000);
    await visitorL.waitForTimeout(800);
    await visitorL.close();
    const sentL = rows().filter((r) => (r.device_id === learnerLId || r.device_id === visitorLId) && r.source.startsWith("typing"));
    check("計測（長文）: 学習記録のある端末・ほかのページから来た端末は長文を打ち切っても typing_long* を送らない", Boolean(visitorLId) && sentL.length === 0, JSON.stringify(sentL.map((r) => r.source)));
  }

  // T29: 管理画面の「初めて来た」は端末の数のまま
  const { summarizeFunnel } = await import("../api/_lib/funnel.js");
  const todayJst = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const firstRows = rows().filter((r) => r.step === "first_visit");
  const devices = new Set(firstRows.map((r) => r.device_id)).size;
  const summary = summarizeFunnel(rows(), todayJst);
  check("計測: タイピング練習の行があっても管理画面の「初めて来た」は端末の数のまま", summary.days30.first_visit === devices && devices < firstRows.length, JSON.stringify({ counted: summary.days30.first_visit, devices, rows: firstRows.length }));
}

// ===== 21.6 タイピングゲームから来た端末（first_visit の source に tgame*。typing.html から来た端末は typing_game。SQL は変えない。docs/SQL_FUNNEL.md 5） =====
console.log("typing game funnel:");
{
  const cloud = createCloud({});
  const rows = () => cloud.rows("funnel_events");
  const of = (device, src) => rows().filter((r) => r.device_id === device && r.step === "first_visit" && (src === undefined || r.source === src));
  const deviceOf = (page) => page.evaluate(() => localStorage.getItem("spelldash_device_id"));
  const stateOf = (page) => page.evaluate(() => document.getElementById("tgBoard").dataset.state);

  // G33: 新しい端末がタイピングゲームから来た
  const page = await newPage({ storage: { spelldash_test_cloud: cloud.id } });
  await page.goto(BASE + "/typing-game.html?t=2", { waitUntil: "networkidle" });
  await waitUntil(async () => rows().filter((r) => r.step === "first_visit").length >= 2, 5000);
  const device = await deviceOf(page);
  const arrived = of(device);
  await page.keyboard.press("k");
  const started = await waitUntil(async () => of(device, "tgame_start").length === 1, 5000);
  await waitUntil(async () => (await stateOf(page)) === "result", 5000);
  const done = await waitUntil(async () => of(device, "tgame_done").length === 1, 5000);
  await page.waitForTimeout(700);
  await page.keyboard.press("Enter");
  await page.keyboard.press(" ");
  await waitUntil(async () => (await stateOf(page)) === "result", 5000);
  await page.waitForTimeout(700);
  const once = of(device, "tgame_start").length === 1 && of(device, "tgame_done").length === 1 && of(device, "tgame").length === 1;
  check("計測: タイピングゲームから初めて来た端末は first_visit が空と tgame の 2 行、打ち始め → tgame_start、結果 → tgame_done（来た日で 1 回だけ）", arrived.length === 2 && arrived.some((r) => r.source === "") && arrived.some((r) => r.source === "tgame") && new Set(arrived.map((r) => r.day)).size === 1 && started && done && once && of(device).every((r) => r.day === arrived[0].day) && of(device, "typing").length === 0, JSON.stringify(of(device).map((r) => `${r.source}:${r.day}`)));
  await page.click("#tgStudy");
  await page.waitForURL(/from=tgame/, { timeout: 5000 }).catch(() => {});
  const study = await waitUntil(async () => of(device, "tgame_study").length === 1, 5000);
  check("計測: 「思い出して打つ」→ 次のページで tgame_study", study && of(device, "tgame_study")[0]?.day === arrived[0]?.day, JSON.stringify(of(device).map((r) => r.source)));
  check("計測（タイピングゲーム）でエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();

  // G34: 学習記録のある端末・ほかのページから来た端末・typing.html から来た端末・途中で離れた回
  const played = async (p) => {
    await p.goto(BASE + "/typing-game.html?t=2", { waitUntil: "networkidle" });
    await p.keyboard.press("k");
    await waitUntil(async () => (await stateOf(p)) === "result", 5000);
    await p.waitForTimeout(600);
  };
  const learner = await newPage({ storage: { spelldash_test_cloud: cloud.id, spelldash_word_stats: JSON.stringify({ apple: { attempts: 1, correct: 1 } }) } });
  await played(learner);
  const learnerId = await deviceOf(learner);
  const learnerRows = rows().filter((r) => r.device_id === learnerId && (r.source.startsWith("tgame") || r.source.startsWith("typing")));
  await learner.close();
  const visitor = await newPage({ storage: { spelldash_test_cloud: cloud.id } });
  await visitor.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  const visitorId = await deviceOf(visitor);
  await waitUntil(async () => of(visitorId, "").length === 1, 5000);
  await played(visitor);
  const visitorRows = rows().filter((r) => r.device_id === visitorId && (r.source.startsWith("tgame") || r.source.startsWith("typing")));
  await visitor.close();
  const typist = await newPage({ storage: { spelldash_test_cloud: cloud.id } });
  await typist.goto(BASE + "/typing.html?t=2", { waitUntil: "networkidle" });
  const typistId = await deviceOf(typist);
  await waitUntil(async () => of(typistId, "typing").length === 1, 5000);
  await typist.goto(BASE + "/typing-game.html?t=2", { waitUntil: "networkidle" });
  const viaTyping = await waitUntil(async () => of(typistId, "typing_game").length === 1, 5000);
  await typist.waitForTimeout(300);
  const typistTgame = rows().filter((r) => r.device_id === typistId && r.source.startsWith("tgame"));
  await typist.close();
  const leaver = await newPage({ storage: { spelldash_test_cloud: cloud.id } });
  await leaver.goto(BASE + "/typing-game.html?t=2", { waitUntil: "networkidle" });
  const leaverId = await deviceOf(leaver);
  await leaver.keyboard.press("k");
  await waitUntil(async () => of(leaverId, "tgame_start").length === 1, 5000);
  await leaver.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await leaver.waitForTimeout(2600);
  const leaverState = await stateOf(leaver);
  await leaver.close();
  check("計測: 学習記録のある端末・ほかのページから来た端末は tgame の行を送らない／typing.html から初めて来た端末がゲームを開くと typing_game だけ（tgame は無い）／途中で離れた回は tgame_done を送らない", learnerRows.length === 0 && visitorRows.length === 0 && viaTyping && typistTgame.length === 0 && of(leaverId, "tgame_start").length === 1 && of(leaverId, "tgame_done").length === 0 && leaverState === "ready", JSON.stringify({ learnerRows, visitorRows, typist: of(typistId).map((r) => r.source), leaver: of(leaverId).map((r) => r.source), leaverState }));

  // G39: 2 つの族は排他（js/funnelLog.js markTypingArrival は番号だけに頼らない）。タイピング練習の印だけがある端末（番号なし）が
  // タイピングゲームを開いて打っても、tgame の印は立たず tgame* の first_visit を送らない（typing_game は送る）
  {
    const day = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const p = await newPage({ storage: { spelldash_test_cloud: cloud.id, spelldash_funnel_typing: day } });
    await p.goto(BASE + "/typing-game.html?t=2", { waitUntil: "networkidle" });
    const id = await deviceOf(p);
    const first = await waitUntil(async () => of(id, "").length === 1 && of(id, "typing_game").length === 1, 5000);
    await p.keyboard.press("k");
    await waitUntil(async () => (await stateOf(p)) === "result", 5000);
    await p.waitForTimeout(600);
    const mark = await p.evaluate(() => localStorage.getItem("spelldash_funnel_tgame"));
    const sent = rows().filter((r) => r.device_id === id && r.source.startsWith("tgame"));
    check("計測: タイピング練習の印だけがある端末（番号なし）がタイピングゲームを開いて打っても tgame の印は立たず、tgame* を送らない（typing_game は送る）", Boolean(id) && first && mark === null && sent.length === 0 && p.errors.length === 0, JSON.stringify({ id: Boolean(id), first, mark, sent: sent.map((r) => r.source), errors: p.errors.slice(0, 2) }));
    await p.close();
  }

  // G40: 教材が読めない（500）まま最初の内蔵の文が時間切れ（?t=4&s=1）→ 読み込めなかったの画面。空の列のまま 4 秒の終わりまで走って
  // 結果・自己ベスト・tgame_done を出さない（?s= の回は自己ベストを書かないので、結果に行かないことで見る）
  {
    const p = await newPage({ storage: { spelldash_test_cloud: cloud.id } });
    await p.route("**/data/typing-game.json", (route) => route.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
    await p.goto(BASE + "/typing-game.html?t=4&s=1", { waitUntil: "load" });
    const id = await deviceOf(p);
    await waitUntil(async () => of(id, "tgame").length === 1, 5000);
    await p.waitForTimeout(300);
    await p.keyboard.press("k");
    const started = await waitUntil(async () => of(id, "tgame_start").length === 1, 5000);
    const errored = await waitUntil(async () => (await stateOf(p)) === "error", 3000);
    await p.waitForTimeout(3500); // 4 秒の回の終わりを過ぎても結果にならない
    const after = await p.evaluate(() => ({ state: document.getElementById("tgBoard").dataset.state, error: !document.getElementById("tgError").hidden, result: !document.getElementById("tgResult").hidden, best: localStorage.getItem("spelldash_typing_game"), osk: document.body.classList.contains("typing--live") }));
    check("計測: 教材が読めないまま最初の文が時間切れ → 読み込めなかったの画面（結果にならない・自己ベストを書かない・tgame_done を送らない。tgame_start は送る）", started && errored && after.state === "error" && after.error && !after.result && after.best === null && !after.osk && of(id, "tgame_done").length === 0 && p.errors.length === 0, JSON.stringify({ started, errored, after, rows: of(id).map((r) => r.source), errors: p.errors.slice(0, 2) }));
    await p.close();
  }

  // G35: 管理画面の「初めて来た」は端末の数のまま
  const { summarizeFunnel } = await import("../api/_lib/funnel.js");
  const todayJst = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const firstRows = rows().filter((r) => r.step === "first_visit");
  const devices = new Set(firstRows.map((r) => r.device_id)).size;
  const summary = summarizeFunnel(rows(), todayJst);
  check("計測: タイピングゲームの行があっても管理画面の「初めて来た」は端末の数のまま", summary.days30.first_visit === devices && devices < firstRows.length, JSON.stringify({ counted: summary.days30.first_visit, devices, rows: firstRows.length }));
}

await browser.close();
server.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
