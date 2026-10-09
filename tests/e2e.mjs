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
    const shelfPos = await page.evaluate(() => ({ left: document.getElementById("bookshelf").getBoundingClientRect().left, hidden: document.getElementById("bookshelf").hidden, board: Math.round(document.querySelector("#shelf-course .shelf__board")?.getBoundingClientRect().top ?? -1), desk: Math.round(document.querySelector(".desk").getBoundingClientRect().top) }));
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
    await page.click("#welcome .welcome__cta [data-welcome-start]");
    await waitUntil(async () => (await page.evaluate(() => localStorage.getItem("spelldash_category"))) === "jhist1" && (await page.isVisible("#backToPath")), 6000);
    const after = await page.evaluate(() => ({ cat: localStorage.getItem("spelldash_category"), packs: JSON.parse(localStorage.getItem("spelldash_packs") || "[]"), course: localStorage.getItem("spelldash_course"), welcome: !document.getElementById("welcome").offsetParent }));
    check("初回: スタートで選んだ本がパックに足され、机に出て、腕試しが始まる", after.cat === "jhist1" && after.packs.includes("jhist1") && (await page.isVisible("#backToPath")) && after.welcome, JSON.stringify(after));
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

// ===== 8.6 書斎の本棚（js/bookshelf.js）: 171 冊が 9 つの棚に。背を押すと机の本が替わる、函はコース、扉の奥は仕事の言葉、本をさがす =====
console.log("bookshelf:");
{
  const jhs1S = JSON.parse(fs.readFileSync(path.join(ROOT, "data/packs/jhs-english1.json"), "utf8")).words;
  const tagsS = [...new Set(jhs1S.map((w) => w.tags[0]))];
  const doneS = new Set(tagsS.slice(0, 3));
  const statsS = Object.fromEntries(jhs1S.filter((w) => doneS.has(w.tags[0])).map((w) => [w.id, { playCount: 1, knownOnSight: true, recallFail: 0 }]));
  const shelfSeed = (extra = {}) => ({ storage: { spelldash_course: "jhs-redo", spelldash_packs: JSON.stringify(["jhs-english1"]), spelldash_category: "jhs-english1", spelldash_word_stats: JSON.stringify(statsS), spelldash_placement: "done", ...extra } });
  const fontBytesOf = (names) => names.reduce((n, f) => { try { return n + fs.statSync(path.join(ROOT, "assets/fonts", f)).size; } catch { return n; } }, 0);

  // 背の文字（題・副題・巻数）の矩形が背のボタンの上下から 2px より出ていないか（scrollHeight では transform のずれを拾えない）
  const spineGeo = (pg) => pg.evaluate(() => [...document.querySelectorAll("#bookshelf button.spine, #bookshelf button.box")].map((b) => { const br = b.getBoundingClientRect(); const ts = [...b.querySelectorAll(".spine__t, .spine__s, .box__n")].map((t) => t.getBoundingClientRect()).filter((r) => r.height > 0); if (!ts.length) return null; const over = Math.round(Math.max(br.top - Math.min(...ts.map((r) => r.top)), Math.max(...ts.map((r) => r.bottom)) - br.bottom)); return over > 2 ? `${b.dataset.book || b.dataset.course}:${over}` : null; }).filter(Boolean));

  // 1200: 本は名前のあるボタン、背を押すと机の本が替わる、函でコース、扉、矢印キー、本をさがす
  {
    const page = await newPage({ viewport: { width: 1200, height: 900 }, ...shelfSeed() });
    const fontFiles = new Set();
    page.on("response", (r) => { if (r.request().resourceType() === "font") fontFiles.add(new URL(r.url()).pathname.split("/").pop()); });
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    const n = await page.evaluate(() => ({
      spines: document.querySelectorAll("#bookshelf button.spine").length, boxes: document.querySelectorAll("#bookshelf button.box").length, slots: document.querySelectorAll("#bookshelf .slot").length,
      unlabeled: [...document.querySelectorAll("#bookshelf button.spine, #bookshelf button.box")].filter((b) => !b.getAttribute("aria-label")).length,
      slot: document.querySelector("#bookshelf .slot")?.getAttribute("aria-label"), title: document.getElementById("bookshelfTitle")?.textContent.replace(/\s+/g, ""), shelves: document.querySelectorAll("#bookshelf .shelf").length
    }));
    check("本棚: 本は名前のあるボタン（背 64＋マイ単語帳・函 10・机の上の本は空き 1）、見出しは「本棚 171冊」、扉を開く前は 8 段", n.spines >= 60 && n.boxes === 10 && n.slots === 1 && n.unlabeled === 0 && n.slot?.includes("中学英語 1年") && n.title === "本棚171冊" && n.shelves === 8, JSON.stringify(n));
    const plates = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll("#bookshelf .shelf")].map((s) => [s.id.replace("shelf-", ""), s.querySelector(".shelf__lang")?.textContent.trim()])));
    check("本棚: 札の答え方（社会・理科・国語 = 答えは日本語、英単語・試験・文法・頻度順 = 答えは英語、コース = 順に進むコース）", plates.social === "答えは日本語" && plates.science === "答えは日本語" && plates.kokugo === "答えは日本語" && plates.eng === "答えは英語" && plates.exam === "答えは英語" && plates.grammar === "答えは英語" && plates.freq === "答えは英語" && plates.course === "順に進むコース", JSON.stringify(plates));
    const firstFonts1200 = new Set(fontFiles); // 初回表示で読んだフォント（扉と本をさがすを開く前）
    // 背を押す: 未追加の巻（jhs-english3、今のコースの巻）→ パックに足され、机に出る。コースはそのまま、第3巻／全8巻、焦点はスタート。元の本は棚に戻って読みかけ
    await page.click('#bookshelf button.spine[data-book="jhs-english3"]');
    const picked = await waitUntil(async () => (await page.evaluate(() => localStorage.getItem("spelldash_category"))) === "jhs-english3" && (await page.textContent("#pathCard")).includes("第3巻／全8巻"), 6000);
    const st = await page.evaluate(() => ({ packs: JSON.parse(localStorage.getItem("spelldash_packs") || "[]"), course: localStorage.getItem("spelldash_course"), focus: document.activeElement?.id, title: document.querySelector("#pathHead .path__title")?.textContent, slot: document.querySelector("#bookshelf .slot")?.getAttribute("aria-label"), back: document.querySelector('#bookshelf button.spine[data-book="jhs-english1"]')?.className, status: document.getElementById("bookshelfStatus")?.textContent }));
    check("本棚: 背を押すと机の本が替わる（未追加の巻はその場で読み込み、コースはそのまま、第3巻／全8巻、焦点はスタート、元の本は棚に戻って読みかけ）", picked && st.packs.includes("jhs-english3") && st.course === "jhs-redo" && st.focus === "pathStart" && st.title.includes("中学英語 3年") && st.slot?.includes("中学英語 3年") && st.back?.includes("spine--reading") && st.status.includes("机に出した"), JSON.stringify(st));
    // 函を押す: 英検のコースへ（制覇していない最初の巻 eiken5 から）
    await page.click('#bookshelf button.box[data-course="eiken"]');
    const boxed = await waitUntil(async () => (await page.evaluate(() => localStorage.getItem("spelldash_course"))) === "eiken" && (await page.textContent("#pathHead")).includes("英検5級"), 6000);
    const st2 = await page.evaluate(() => ({ cat: localStorage.getItem("spelldash_category"), box: document.querySelector('#bookshelf button.box[data-course="eiken"]').className, label: document.querySelector('#bookshelf button.box[data-course="eiken"]').getAttribute("aria-label"), prev: document.querySelector('#bookshelf button.box[data-course="jhs-redo"]').className, focus: document.activeElement?.id }));
    check("本棚: 函を押すとコースが替わる（eiken → eiken5、函に「いまのコース」、焦点は机のスタート）", boxed && st2.cat === "eiken5" && st2.box.includes("box--reading") && st2.label.includes("いまのコース") && !st2.prev.includes("box--reading") && st2.focus === "pathStart", JSON.stringify(st2));
    // 扉: 開くと 49 冊（8 段）。鍵穴は無い。最初の背に焦点。背の文字ははみ出さない
    const beforeDoors1200 = new Set(fontFiles); // ここから先（扉・本をさがす）で増えるフォント
    await page.click("#archiveDoors");
    await page.waitForTimeout(300);
    const d = await page.evaluate(() => ({ exp: document.getElementById("archiveDoors").getAttribute("aria-expanded"), n: document.querySelectorAll("#shelf-job button.spine").length, rows: document.querySelectorAll("#shelf-job .shelf").length, keyhole: document.querySelectorAll("#bookshelf [class*=keyhole], #bookshelf [class*=lock]").length, focus: document.activeElement?.dataset.book, go: document.querySelector("#archiveDoors .doors__go")?.textContent.trim(), overflow: [...document.querySelectorAll("#bookshelf .spine__l")].filter((l) => l.scrollHeight > l.clientHeight + 2 || l.scrollWidth > l.clientWidth + 2).map((l) => l.closest("button").dataset.book) }));
    check("本棚: 扉を開くと仕事の言葉 49 冊（8 段）。鍵穴は無く、最初の背に焦点、背の文字ははみ出さない", d.exp === "true" && d.n === 49 && d.rows === 8 && d.keyhole === 0 && d.focus === "accounting" && d.go.includes("閉じる") && d.overflow.length === 0, JSON.stringify(d));
    const geo1200 = await spineGeo(page);
    check("本棚（1200）: 背の文字が背の上下からはみ出さない（扉の中・題箋つきの長い題を含む）", geo1200.length === 0, geo1200.join(" "));
    // 段の中は ←→ で動き、Tab で止まるのは 1 本だけ
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    const kb = await page.evaluate(() => ({ focus: document.activeElement?.dataset.book, tab0: [...document.activeElement.closest(".books").querySelectorAll("button")].filter((b) => b.tabIndex === 0).map((b) => b.dataset.book) }));
    check("本棚: 段の中は ←→ で動き、Tab で止まるのは 1 本だけ（roving tabindex）", kb.focus === "hr" && kb.tab0.length === 1 && kb.tab0[0] === "hr", JSON.stringify(kb));
    // 本をさがす: 「歴史」で高校日本史・世界史も（別名）、「トーイック」で TOEIC。Esc で閉じて焦点は開いたボタンへ
    await page.click("#bookFinderOpen");
    await page.waitForTimeout(200);
    await page.fill("#bookFinderQ", "歴史");
    await page.waitForTimeout(100);
    const f = await page.evaluate(() => ({ open: document.getElementById("bookFinder").open, rows: document.querySelectorAll("#bookFinderList .finder__row").length, text: document.getElementById("bookFinderList").textContent, focus: document.activeElement?.id }));
    await page.fill("#bookFinderQ", "トーイック");
    await page.waitForTimeout(100);
    const f2 = await page.evaluate(() => document.getElementById("bookFinderList").textContent);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    const f3 = await page.evaluate(() => ({ open: document.getElementById("bookFinder").open, focus: document.activeElement?.id }));
    check("本棚: 本をさがす（「歴史」で 6 冊以上、高校日本史・世界史も。「トーイック」で TOEIC。Esc で閉じて焦点は開いたボタンへ）", f.open && f.rows >= 6 && f.text.includes("高校日本史") && f.text.includes("高校世界史") && f2.includes("TOEIC") && !f3.open && f3.focus === "bookFinderOpen", JSON.stringify({ ...f, text: f.text.slice(0, 80), f2: f2.slice(0, 40), f3 }));
    // 入力欄の Enter は最初の 1 冊（閉じるボタンがフォームの既定の submit になって閉じてしまわない）。古文単語はコース外: 鍵はそのまま
    await page.click("#bookFinderOpen");
    await page.fill("#bookFinderQ", "古文");
    await page.waitForTimeout(100);
    await page.keyboard.press("Enter");
    const entered = await waitUntil(async () => (await page.evaluate(() => localStorage.getItem("spelldash_category"))) === "hs-kobun", 6000);
    const st3 = await page.evaluate(() => ({ open: document.getElementById("bookFinder").open, course: localStorage.getItem("spelldash_course"), focus: document.activeElement?.id, title: document.querySelector("#pathHead .path__title")?.textContent }));
    check("本棚: 本をさがすの Enter は最初の 1 冊を机に（閉じるだけにならない。古文単語・コースの鍵はそのまま・焦点はスタート）", entered && !st3.open && st3.course === "eiken" && st3.focus === "pathStart" && st3.title?.includes("古文単語"), JSON.stringify(st3));
    // 本をさがすで選ぶ: コース外の本（都道府県）→ 机に出る。コースの鍵は触らず、柱は「社会の棚」、答えは日本語・60枚
    await page.click("#bookFinderOpen");
    await page.fill("#bookFinderQ", "都道府県");
    await page.waitForTimeout(100);
    await page.click("#bookFinderList .finder__row");
    const found = await waitUntil(async () => (await page.evaluate(() => localStorage.getItem("spelldash_category"))) === "pref", 6000);
    const st4 = await page.evaluate(() => ({ open: document.getElementById("bookFinder").open, kicker: document.querySelector("#pathHead .path__kicker")?.textContent, course: localStorage.getItem("spelldash_course"), focus: document.activeElement?.id, meta: document.querySelector("#pathHead .path__meta")?.textContent }));
    check("本棚: 本をさがすで選ぶと机に出る（コース外の本はコースの鍵を触らない: 柱は「社会の棚」、答えは日本語・60枚）", found && !st4.open && st4.kicker.includes("社会の棚") && st4.course === "eiken" && st4.focus === "pathStart" && st4.meta.includes("日本語") && st4.meta.includes("60枚"), JSON.stringify(st4));
    // フォント: 初回表示は ≤ 520KB。扉と本をさがすを開いたあとに増えるのは Shippori 500 のサブセットだけ（700 はスタートの分だけ。A の重さの規律）
    const added1200 = [...fontFiles].filter((f) => !beforeDoors1200.has(f));
    check("本棚（1200）: フォントは自前の明朝だけで初回表示 ≤ 520KB、扉と本をさがすで増えるのは Shippori 500 のサブセットだけ", [...fontFiles].every((f) => /^(shippori-mincho|cormorant-garamond|ibm-plex-mono)/.test(f)) && fontBytesOf([...firstFonts1200]) <= 520 * 1024 && added1200.every((f) => f.includes("shippori-mincho") && f.includes("-500-")), `first=${firstFonts1200.size} files ${Math.round(fontBytesOf([...firstFonts1200]) / 1024)}KB, after doors+finder=${fontFiles.size} files ${Math.round(fontBytesOf([...fontFiles]) / 1024)}KB, added=${added1200.join(" ")}`);
    check("本棚（1200）でエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // 390: 段の右端で切れているのは本物の背、DOM は本 → 札、横スクロール無し、続きのボタン、索引、背を押すと机へ、プレイ中は畳む、扉
  {
    const page = await newPage({ mobile: true, viewport: { width: 390, height: 844 }, ...shelfSeed() });
    const fontFiles = new Set();
    page.on("response", (r) => { if (r.request().resourceType() === "font") fontFiles.add(new URL(r.url()).pathname.split("/").pop()); });
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    const r = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#bookshelf .books--scroll")].map((ul) => { const box = ul.getBoundingClientRect(); const li = [...ul.children].find((l) => getComputedStyle(l).display !== "none" && l.getBoundingClientRect().right > box.right); if (!li) return "none"; const lr = li.getBoundingClientRect(); return `${li.querySelector(".spine, .slot, .box") ? "real" : li.className}:${Math.round(((box.right - lr.left) / lr.width) * 100)}%`; });
      const order = [...document.querySelectorAll("#bookshelf .shelf")].every((s) => { const a = s.querySelector(".books"), b = s.querySelector(".shelf__board"); return a && b && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); });
      return { rows, order, scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, more: document.querySelectorAll("#bookshelf .more:not([hidden])").length };
    });
    check("本棚（390）: 段の右端で切れているのは本物の背（本立て・寝かせた本でない）、DOM は本 → 札の順、横スクロール無し", r.rows.length >= 5 && r.rows.every((x) => x.startsWith("real:")) && r.order && r.scrollW <= r.innerW && r.more >= 5, JSON.stringify(r));
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(500);
    const firstFonts390 = new Set(fontFiles); // 初回表示（一番下までスクロール）で読んだフォント。扉を開く前
    await page.evaluate(() => window.scrollTo(0, 0));
    // 「あと N冊 →」: 段を右へ送る。端に着いたら「はじめへ」で戻る
    await page.click("#shelf-exam .more");
    await page.waitForTimeout(700);
    const m1 = await page.evaluate(() => ({ sl: document.querySelector("#shelf-exam .books").scrollLeft, txt: document.querySelector("#shelf-exam .more").textContent.trim() }));
    await page.click("#shelf-exam .more");
    await page.waitForTimeout(700);
    const m2 = await page.evaluate(() => ({ sl: document.querySelector("#shelf-exam .books").scrollLeft, txt: document.querySelector("#shelf-exam .more").textContent.trim() }));
    check("本棚（390）: 「あと N冊 →」で段が送られ、端で「はじめへ」になり、押すと戻る", m1.sl > 100 && (m1.txt.includes("はじめへ") ? m2.sl === 0 && m2.txt.includes("あと") : m2.sl > m1.sl), JSON.stringify({ m1, m2 }));
    // 索引: 棚の上端が画面の上に（前の棚の札が上に残らない）。URL のハッシュは変えない
    await page.click('.shelf-index a[href="#shelf-social"]');
    await page.waitForTimeout(1500);
    const j = await page.evaluate(() => ({ top: Math.round(document.getElementById("shelf-social").getBoundingClientRect().top), hash: location.hash }));
    check("本棚（390）: 索引で棚へ（その棚の上端が画面の上、URL のハッシュは変えない）", j.top >= -2 && j.top <= 40 && j.hash === "", JSON.stringify(j));
    // 背を押す（社会の本）: 机へ戻って焦点はスタート。柱は「社会の棚」、答えは日本語・75枚、コースの鍵はそのまま
    await page.click('#bookshelf button.spine[data-book="jhist1"]');
    const picked = await waitUntil(async () => (await page.evaluate(() => localStorage.getItem("spelldash_category"))) === "jhist1", 6000);
    await page.waitForTimeout(1500);
    const p = await page.evaluate(() => ({ focus: document.activeElement?.id, cardTop: Math.round(document.getElementById("pathCard").getBoundingClientRect().top), kicker: document.querySelector("#pathHead .path__kicker")?.textContent, course: localStorage.getItem("spelldash_course"), meta: document.querySelector("#pathHead .path__meta")?.textContent, n: document.querySelectorAll("#pathStart").length }));
    check("本棚（390）: 背を押すと机へ戻り、焦点はスタート（柱は「社会の棚」、答えは日本語・75枚、コースはそのまま、スタートは 1 個）", picked && p.focus === "pathStart" && p.cardTop > -300 && p.cardTop < 300 && p.kicker.includes("社会の棚") && p.course === "jhs-redo" && p.meta.includes("75枚") && p.n === 1, JSON.stringify(p));
    // プレイ中は本棚を畳み、机に戻ると出る。畳まれている間に組み直されても（同期）、出たときに段を測り直す（「あと N冊」が全冊にならない）
    await page.tap("#pathStart");
    await page.waitForTimeout(600);
    const hid = await page.evaluate(() => getComputedStyle(document.getElementById("bookshelf")).display);
    await page.evaluate(() => import("/js/bookshelf.js").then((m) => m.renderBookshelf())); // 同期で組み直したのと同じ（畳まれたまま）
    await page.waitForTimeout(100);
    await page.tap("#backToPath");
    await page.waitForTimeout(600);
    const shown = await page.evaluate(() => getComputedStyle(document.getElementById("bookshelf")).display);
    const moreAfter = await page.evaluate(() => {
      const btn = document.querySelector("#shelf-exam .more");
      const spines = document.querySelectorAll("#shelf-exam .spine, #shelf-exam .slot").length;
      return { hidden: btn?.hidden, txt: btn?.textContent.trim(), n: Number(btn?.querySelector("b")?.textContent), spines };
    });
    check("本棚（390）: プレイ中は畳まれ、机に戻ると出る", hid === "none" && shown !== "none", `${hid} → ${shown}`);
    check("本棚（390）: 畳まれている間に組み直されても、出たときに「あと N冊」を測り直す（N は全冊未満・ボタンは見える）", moreAfter.hidden === false && moreAfter.txt.includes("あと") && moreAfter.n >= 1 && moreAfter.n < moreAfter.spines, JSON.stringify(moreAfter));
    // 扉を開いても横スクロール無し・背の文字ははみ出さない・右端で切れるのは本物の背
    const beforeDoors390 = new Set(fontFiles); // 扉で増えるフォント（プレイの「続きから」の 700 はスタートの分）
    await page.click("#archiveDoors");
    await page.waitForTimeout(400);
    const jo = await page.evaluate(() => ({ n: document.querySelectorAll("#shelf-job button.spine").length, overflow: [...document.querySelectorAll("#bookshelf .spine__l")].filter((l) => l.scrollHeight > l.clientHeight + 2 || l.scrollWidth > l.clientWidth + 2).map((l) => l.closest("button").dataset.book), rows: [...document.querySelectorAll("#shelf-job .books--scroll")].map((ul) => { const box = ul.getBoundingClientRect(); const li = [...ul.children].find((l) => getComputedStyle(l).display !== "none" && l.getBoundingClientRect().right > box.right); return li ? (li.querySelector(".spine") ? "spine" : li.className) : "none"; }), scrollW: document.documentElement.scrollWidth }));
    check("本棚（390）: 扉を開いても 49 冊がはみ出さず、横スクロール無し、段の右端は本物の背", jo.n === 49 && jo.overflow.length === 0 && jo.rows.every((x) => x === "spine" || x === "none") && jo.scrollW <= 390, JSON.stringify(jo));
    const geo390 = await spineGeo(page);
    check("本棚（390）: 背の文字が背の上下からはみ出さない（扉の中・題箋つきの長い題を含む）", geo390.length === 0, geo390.join(" "));
    const added390 = [...fontFiles].filter((f) => !beforeDoors390.has(f));
    check("本棚（390）: 初回表示（本棚を一番下まで）のフォント ≤ 520KB、扉で増えるのは Shippori 500 のサブセットだけ", fontBytesOf([...firstFonts390]) <= 520 * 1024 && added390.every((f) => f.includes("shippori-mincho") && f.includes("-500-")), `first=${firstFonts390.size} files ${Math.round(fontBytesOf([...firstFonts390]) / 1024)}KB, after doors=${fontFiles.size} files ${Math.round(fontBytesOf([...fontFiles]) / 1024)}KB`);
    check("本棚（390）でエラー0", page.errors.length === 0, page.errors[0] ?? "");
    await page.close();
  }

  // 初回: 本棚は見えている。背を押すと机の本が替わるだけ（始めない・パックも足さない）。函は最初の巻を机に。スタートでコースの鍵が回り、その巻で始まる
  {
    const page = await newPage({ keepOnboarding: true, viewport: { width: 390, height: 844 } });
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    const v = await page.evaluate(() => ({ shown: !document.getElementById("bookshelf").hidden && getComputedStyle(document.getElementById("bookshelf")).display !== "none", welcome: document.body.classList.contains("welcome-open"), spines: document.querySelectorAll("#bookshelf button.spine").length }));
    await page.click('#bookshelf button.spine[data-book="hs-kobun"]');
    await page.waitForTimeout(400);
    const w = await page.evaluate(() => ({ t: document.querySelector('#welcomeBook [data-f="t"]').textContent, s: document.querySelector('#welcomeBook [data-f="s"]').textContent, book: document.querySelector("#welcome [data-welcome-start]").dataset.book, cat: localStorage.getItem("spelldash_category"), packs: localStorage.getItem("spelldash_packs") || "", welcome: !document.getElementById("welcome").hidden }));
    check("初回: 本棚が見え、背を押すと机の本が替わるだけ（国語・古文単語。始めない・パックも足さない）", v.shown && v.welcome && v.spines >= 60 && w.t.includes("国語") && w.s.includes("古文単語") && w.book === "hs-kobun" && w.cat === "jhs-english1" && !w.packs.includes("hs-kobun") && w.welcome, JSON.stringify({ v, w }));
    await page.click('#bookshelf button.box[data-course="toeic"]');
    await page.waitForTimeout(400);
    const b = await page.evaluate(() => ({ t: document.querySelector('#welcomeBook [data-f="t"]').textContent, book: document.querySelector("#welcome [data-welcome-start]").dataset.book, course: localStorage.getItem("spelldash_course") }));
    await page.click("#welcome .welcome__cta [data-welcome-start]");
    const started = await waitUntil(async () => (await page.evaluate(() => localStorage.getItem("spelldash_category"))) === "toeic500" && (await page.isVisible("#backToPath")), 8000);
    const a = await page.evaluate(() => ({ course: localStorage.getItem("spelldash_course"), packs: JSON.parse(localStorage.getItem("spelldash_packs") || "[]") }));
    check("初回: 函を押すと最初の巻（TOEIC 500点）が机に出て、スタートでコースの鍵が回りその巻で始まる", b.book === "toeic500" && b.course === "jhs-redo" && b.t.includes("TOEIC") && started && a.course === "toeic" && a.packs.includes("toeic500"), JSON.stringify({ b, a }));
    check("初回（本棚）でエラー0", page.errors.length === 0, page.errors[0] ?? "");
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
  const SKIN_PAGES = ["/list.html", "/stats.html", "/profile.html", "/pro.html", "/battle.html", "/news.html", "/privacy.html", "/terms.html", "/tokushoho.html", "/packs/accounting.html"];
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
    spelldash_test_session: "pro-token", spelldash_test_plan: JSON.stringify({ status: "active", interval: "month", current_period_end: new Date(Date.now() + 30 * 86400000).toISOString() })
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
  // 1 回の evaluate で読む計算値: 机の本の影・本棚の揺らぎ（.cabinet::after）・.page-room の夜の変数・動いている物・スタートの朱と墨・名札・場面の拡大・索引の帯
  const finish = () => {
    const cs = (sel, pseudo) => getComputedStyle(document.querySelector(sel), pseudo);
    const room = cs(".page-room"), tome = cs(".tome"), cab = cs(".cabinet", "::after"), start = cs("#pathStart"), plateEl = document.querySelector(".plate"), plate = getComputedStyle(plateEl);
    const ink = document.createElement("span"); ink.style.color = "var(--ink-page)"; plateEl.appendChild(ink); const inkPage = getComputedStyle(ink).color; ink.remove();
    const idx = document.querySelector(".shelf-index");
    const a = document.querySelector("#hasumiHome .hasumi__bubble")?.getBoundingClientRect(), b = document.getElementById("pathStart").getBoundingClientRect();
    return {
      theme: document.documentElement.dataset.theme,
      tome: tome.boxShadow, cabinet: cab.backgroundImage, flicker: cab.animationName,
      far: room.getPropertyValue("--far-page"), cast: room.getPropertyValue("--cast-l"), band: room.getPropertyValue("--desk-band"),
      anims: document.getAnimations().map((x) => { const t = x.effect.target; return ([...t.classList].pop() || t.id) + (x.effect.pseudoElement || ""); }).sort(),
      start: { bg: start.backgroundImage, color: start.color, bottom: Math.round(b.bottom), n: document.querySelectorAll("#pathStart").length },
      plate: { color: plate.color, inkPage, filter: plate.filter, blend: plate.mixBlendMode, inSink: document.querySelectorAll(".shelf__in .plate").length },
      scene: { transform: cs(".room__scene--phone").transform, stage: Math.round(document.querySelector(".room__stage").getBoundingClientRect().height), slipOverlap: a ? a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right : null },
      index: { height: Math.round(idx.getBoundingClientRect().height), rows: new Set([...idx.querySelectorAll("a")].map((x) => Math.round(x.getBoundingClientRect().top))).size, scrollW: idx.scrollWidth, clientW: idx.clientWidth },
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

  // 390×844 light／dark・320×568 light: 索引の帯・場面の拡大・スタートの位置・夜の層
  const phone = {};
  for (const [w, h, theme] of [[390, 844, "light"], [390, 844, "dark"], [320, 568, "light"]]) {
    const page = await openRoom({ mobile: true, viewport: { width: w, height: h }, ...finishSeed(theme) }, theme);
    const v = await page.evaluate(finish);
    // 帯を末尾まで送っても動くのは帯の中だけ（頁の幅は増えない）
    v.sent = await page.evaluate(() => { const el = document.querySelector(".shelf-index"); el.scrollLeft = 9999; return { left: el.scrollLeft, scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth }; });
    phone[`${w}-${theme}`] = v;
    await done(page);
  }
  const oneRow = (v) => v.index.height <= 48 && v.index.rows === 1 && v.index.scrollW > v.index.clientW && v.sent.left > 0 && v.scrollW <= v.innerW && v.sent.scrollW <= v.sent.innerW;
  check("書斎の仕上げ（390・320）: 索引の帯は 1 行で横に送る（高さ ≤ 48・末尾まで送っても頁は横スクロールしない）、1200 は 8 列 1 行のまま", oneRow(phone["390-light"]) && oneRow(phone["390-dark"]) && oneRow(phone["320-light"]) && L.index.rows === 1 && L.index.scrollW <= L.index.clientW + 1, JSON.stringify({ 390: { ...phone["390-light"].index, sent: phone["390-light"].sent }, 320: { ...phone["320-light"].index, sent: phone["320-light"].sent }, 1200: L.index }));

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

  // 56d: 段の見出し行（名札・答え方・「あと N冊 →」）は細い端末でも框に収まる（扉を開いた仕事の段も。320・360・390。≤599 は仕事の段の答え方、≤374 は送る段の答え方と仕事の冊数、≤359 は「あと N冊」の文字を畳む）
  const boardsFit = async (w) => {
    const page = await newPage({ mobile: true, viewport: { width: w, height: 844 }, storage: { spelldash_placement: "done", spelldash_onboarded: "1" } });
    await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
    await waitUntil(() => page.evaluate(() => document.querySelectorAll("#bookshelf .shelf__board").length >= 8));
    await page.click("#archiveDoors");
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => [...document.querySelectorAll(".shelf__board")].map((b) => {
      const cs = getComputedStyle(b), rect = b.getBoundingClientRect();
      const kids = [...b.children].filter((k) => !k.hidden && getComputedStyle(k).display !== "none");
      const inner = rect.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const need = kids.reduce((n, k) => n + k.getBoundingClientRect().width, 0) + (kids.length - 1) * (parseFloat(cs.columnGap) || 0);
      return { name: b.querySelector(".plate")?.textContent.trim().slice(0, 12), over: Math.round(need - inner) };
    }).filter((x) => x.over > 0));
    await done(page);
    return r;
  };
  const fit320 = await boardsFit(320), fit360 = await boardsFit(360), fit390 = await boardsFit(390);
  check("56d: 段の見出し行（名札・答え方・あと N冊）は 320・360・390 で框に収まる（扉の中の仕事の段も）", fit320.length === 0 && fit360.length === 0 && fit390.length === 0, JSON.stringify({ 320: fit320, 360: fit360, 390: fit390 }));

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

  // 夜の層はスタートと名札に掛からない: #pathStart の朱（--seal-1 系）と墨（--seal-ink）は dark でも light と同じ文字列。名札は --ink-page のまま、沈みの層（.shelf__in::after）の外で、filter も blend も無い
  const outside = (night, day) => night.start.bg === day.start.bg && night.start.color === day.start.color && night.plate.color === night.plate.inkPage && day.plate.color === day.plate.inkPage && night.plate.filter === "none" && night.plate.blend === "normal" && night.plate.inSink === 0;
  check("書斎の仕上げ（夜）: 夜の層はスタートと名札に掛からない（#pathStart の朱と墨は昼と同じ・名札は --ink-page のまま沈みの層の外。390・1200）", outside(D, L) && outside(phone["390-dark"], phone["390-light"]) && D.start.bg.includes("rgb(199, 62, 36)"), JSON.stringify({ 1200: { start: D.start, plate: D.plate }, 390: { start: phone["390-dark"].start, plate: phone["390-dark"].plate }, light: L.start }));
  check("書斎の仕上げでエラー0", errs.length === 0, errs[0] ?? "");
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
      message: document.getElementById("message").textContent.trim(),
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

  // ---- K2: 待ち 0.25 秒のあと、次の語の頭が前の語の続きと同じキー（鑑真 gannjin → 日米和親条約 ni…）でも、速く打った 1 打目は次の語に入る ----
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
    const r = await finishTimed(p, k1.at(-1), { afterChange: [{ at: 250, key: "n" }, { at: 340, key: "i" }], afterMs: 420 });
    check("ローマ字: 待ち 0.25 秒のあと、次の語の頭が続きと同じ n でも 1 打目は次の語に入る（ミス・思い出せず 同じ）", k1.endsWith("n") && keysOfA(w2).startsWith("ni") && r.ms !== null && r.ms <= 600 && r.after?.ja === w2.q && Number(r.after.miss) === miss0 && Number(r.after.recallFail) === rf0 && r.after.preview.endsWith("ni"), JSON.stringify({ ms: r.ms, miss: `${miss0}→${r.after?.miss}`, rf: `${rf0}→${r.after?.recallFail}`, preview: r.after?.preview }));
    check("ローマ字（続きと次の語の頭）でエラー0", p.errors.length === 0, p.errors[0] ?? "");
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
    for (const ch of await wordOf(p)) await p.press("#input", ch);
    await p.click("#noteEdit");
    await p.keyboard.type("nego");
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

  // ---- R3: 正解の 1 打で word_stats の書き込みは 1 回・2MB の parse は 1 回以下（記録 2,000 語） ----
  {
    const old = new Date(Date.now() - 30 * 86400000).toISOString();
    const heavy = {};
    for (let i = 0; i < 2000; i++) heavy[`r58-${i}`] = { playCount: 5, correctCount: 4, missCount: 1, typingMiss: 0, recallFail: 1, cleanCorrectStreak: 3, mastered: false, lastPlayed: old, nextReviewAt: new Date(Date.now() + 20 * 86400000).toISOString(), lastRecallFailAt: old, lastRecallSuccessAt: old, history: Array.from({ length: 8 }, () => ({ d: todayA, r: "o" })) };
    const p = await newPage({ storage: bizSeed({ spelldash_word_stats: JSON.stringify(heavy) }) });
    await p.addInitScript(() => {
      window.__io = { set: 0, parse: 0 };
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) { if (k === "spelldash_word_stats") window.__io.set++; return setItem.call(this, k, v); };
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
        document.getElementById("input").dispatchEvent(new KeyboardEvent("keydown", { key: last, bubbles: true, cancelable: true }));
        await Promise.resolve();
        return { ...window.__io, bytes: localStorage.getItem("spelldash_word_stats").length };
      }, f.w.en.at(-1));
      check("記録: 正解の 1 打で word_stats の書き込みは 1 回・2MB の parse は 1 回以下", io.set === 1 && io.parse <= 1 && io.bytes >= 100000, JSON.stringify(io));
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
  const spill1 = { score: await num(pageS, "#score"), miss: await num(pageS, "#miss"), preview: await pageS.textContent("#typedPreview") };
  check("Challenge: いわじゅく で正解、続けて打った iseki は次の語に持ち越さない（ミス 0・次の語は未入力）",
    spill1.score === 1 && spill1.miss === 0 && spill1.preview === "", JSON.stringify(spill1));
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
