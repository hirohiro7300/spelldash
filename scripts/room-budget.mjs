// 書斎の予算表: フォントの本数と量・場面の画像の量・LCP・CLS を、390×844／1200×900 × 昼／夜 × room／first で出す。
//   node scripts/room-budget.mjs            … 表
//   node scripts/room-budget.mjs --fonts    … 読まれたフォントのファイル名（700 がスタート以外に使われていないか）
//   node scripts/room-budget.mjs --3g       … Fast 3G 相当（1.6Mbps／150ms）でも 1 回
// scripts/ はデプロイされない（.vercelignore）。E2E と同じ静的サーバー（supabase.js はスタブ）
import http from "http"; import fs from "fs"; import path from "path"; import { fileURLToPath } from "url";
import { chromium } from "playwright-core";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname); if (p === "/") p = "/index.html";
  const file = p === "/js/supabase.js" ? path.join(ROOT, "tests/mocks/supabase-stub.js") : path.join(ROOT, p.slice(1));
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" }); fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const chromePath = process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath: chromePath, args: ["--no-sandbox"] });
const jhs1 = JSON.parse(fs.readFileSync(path.join(ROOT, "data/packs/jhs-english1.json"), "utf8")).words;
const tags = [...new Set(jhs1.map((w) => w.tags[0]))];
const stats = Object.fromEntries(jhs1.filter((w) => tags.slice(0, 3).includes(w.tags[0])).map((w) => [w.id, { playCount: 1, knownOnSight: true, recallFail: 0 }]));
const SEED = { room: { spelldash_onboarded: "1", spelldash_course: "jhs-redo", spelldash_packs: JSON.stringify(["jhs-english1"]), spelldash_category: "jhs-english1", spelldash_placement: "done", spelldash_word_stats: JSON.stringify(stats) }, first: {} };
const listFonts = process.argv.includes("--fonts");
const slow = process.argv.includes("--3g");
const rows = [];
for (const view of ["room", "first"]) for (const [w, h] of [[390, 844], [1200, 900]]) for (const theme of ["light", "dark"]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  if (slow) { const cdp = await ctx.newCDPSession(page); await cdp.send("Network.enable"); await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 }); }
  const fonts = []; let fontBytes = 0, imgBytes = 0; const imgs = [];
  page.on("response", async (r) => { try { const u = new URL(r.url()).pathname; const t = r.request().resourceType(); if (t === "font") { fontBytes += (await r.body()).length; fonts.push(u.split("/").pop()); } if (u.startsWith("/assets/images/room/")) { imgBytes += (await r.body()).length; imgs.push(u.split("/").pop()); } } catch {} });
  await page.addInitScript((seed) => { localStorage.setItem("spelldash_schema_version", "6"); for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v); }, { ...SEED[view], spelldash_theme: theme });
  await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(500);
  const perf = await page.evaluate(() => new Promise((resolve) => {
    let lcp = null, cls = 0;
    new PerformanceObserver((l) => { for (const e of l.getEntries()) lcp = { t: Math.round(e.startTime), el: e.element ? `${e.element.tagName.toLowerCase()}${e.element.id ? "#" + e.element.id : ""}.${[...e.element.classList].slice(0, 2).join(".")}` : "" }; }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) cls += e.value; }).observe({ type: "layout-shift", buffered: true });
    setTimeout(() => resolve({ lcp, cls: Math.round(cls * 1000) / 1000, fontFaces: document.fonts.size }), 300);
  }));
  rows.push({ view, size: `${w}×${h}`, theme, fonts: fonts.length, fontKB: Math.round(fontBytes / 1024), imgKB: Math.round(imgBytes / 1024), lcp: perf.lcp, cls: perf.cls });
  if (listFonts) console.log(`${view} ${w} ${theme}:`, fonts.sort().join(" "));
  await ctx.close();
}
await browser.close(); server.close();
console.table(rows.map((r) => ({ ...r, lcp: r.lcp ? `${r.lcp.t}ms ${r.lcp.el}` : "" })));
const bad = rows.filter((r) => r.fontKB > 520 || r.imgKB > 260);
if (bad.length) { console.error("予算を超えた:", JSON.stringify(bad)); process.exit(1); }
