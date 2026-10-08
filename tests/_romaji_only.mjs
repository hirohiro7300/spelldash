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
      // 自力で打つ読み: ほかの読みが伸びない（打ち終えたら Enter なしで終わる）もの。無ければ主な読み＋Enter
      const self = cands.find((c) => r.matchRomaji(cands, keysOf(c)).done) ?? primary?.reading;
      const miss = [..."qxvlzjcfw"].find((k) => !r.matchRomaji(cands, k).alive) ?? "q";
      const romaji = entries.length > 0 ? { keys: keysOf(primary.reading), self: keysOf(self), selfEnter: !r.matchRomaji(cands, keysOf(self)).done, miss } : null;
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
  await page.press("#input", "Enter"); // 次へ
  await waitUntil(async () => (await findCard()) && (await findCard()).en !== card.en, 3000);
  // 2語目: 自力で答える。日本語は読みをローマ字で、英語の全文入力なら別解（accept）で、IMEの表記ゆれもOK
  card = await findCard();
  const typed = card.romaji ? card.romaji.self : card.free ? (card.accept[0] ?? card.en) : card.en;
  if (card.romaji) {
    await pressAll(typed);
    if (card.romaji.selfEnter) await page.press("#input", "Enter"); // 長い読みもあり得る読み（めいん／めいんこんばーじょん）は Enter で確定
  } else if (card.free) {
    await page.fill("#input", typed);
    await page.press("#input", "Enter");
  } else {
    for (const ch of typed) await page.press("#input", ch);
  }
  await waitUntil(async () => (await page.textContent("#score")).trim() === "2", 2000);
  check(`自力正解（${card.romaji ? "読みをローマ字で" : card.free ? "別解で全文入力" : "スペル入力"}）`, (await page.textContent("#score")).trim() === "2" && (await page.textContent("#recalledToday")).trim() === "1", `typed=${typed}`);
  check("正解後も用語と解説が残る（読む時間）", (await page.textContent("#wordExplain")).trim().length > 0);
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

  // 岩宿遺跡: 読み いわじゅく は いわじゅくいせき の手前。打ち終えても長い読みがあり得るので Enter で確定
  const w4 = W["concept-jh1-iwajuku"];
  await waitUntil(() => promptIs(page, w4), 3000);
  await pressAll(page, "iwajuku");
  await page.waitForTimeout(150);
  const notYet = (await num(page, "#score")) === 3 && (await page.textContent("#message")).includes("Enter で確定");
  await page.press("#input", "Enter");
  await waitUntil(async () => (await num(page, "#score")) === 4, 2000);
  check("ローマ字: 長い読みの手前の読み（いわじゅく）は「Enter で確定」→ Enter で正解", notYet && (await num(page, "#score")) === 4 && (await num(page, "#recallFail")) === 0);
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
  await page.press("#input", "Enter");

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
      prefix: (() => { const m = r.matchRomaji(["めいん", "めいんこんばーじょん"], "meinn"); return m.alive && !m.done && m.finished === 0; })()
    };
  });
  check("ローマ字の判定（shi/si・tsu/tu・っ・cha/tya・ん の nn/n'/n・fu/hu・ja/zya・カタカナ・ー・長い読みの手前）", Object.values(unit).every(Boolean), JSON.stringify(unit));
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
  for (let i = 0; i < 25 && swallowed === null; i++) {
    const q = (await pageC.textContent("#japanese")).trim();
    const w = jh1.find((x) => x.q === q);
    if (!w) break;
    const keys = keysOf(w);
    const m = matchRomaji(readingEntries(w), keys);
    const endsN = m.done && m.endedWithSingleN;
    const missBefore = await num(pageC, "#miss");
    await pressAll(pageC, endsN ? keys + "n" : keys);
    if (!m.done) await pageC.press("#input", "Enter"); // 長い読みもあり得る読みは Enter で確定
    await pageC.waitForTimeout(80);
    if (endsN) swallowed = (await num(pageC, "#miss")) === missBefore && (await pageC.textContent("#typedPreview")) === "" && (await pageC.textContent("#japanese")).trim() !== q;
  }
  check("Challenge: 語末の ん を n で終えた直後の n は次の語に持ち越さない", swallowed === true, String(swallowed));
  check("Challenge（ローマ字）でエラー0", pageC.errors.length === 0, pageC.errors[0] ?? "");
  await pageC.close();
}

await browser.close();
server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
