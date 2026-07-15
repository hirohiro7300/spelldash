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

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const STUB = path.join(ROOT, "tests", "mocks", "supabase-stub.js");

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".webmanifest": "application/manifest+json"
};

function findChromium() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    process.env.HOME + "/.cache/ms-playwright"
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    if (c && fs.existsSync(c) && fs.statSync(c).isDirectory()) {
      const hit = fs
        .readdirSync(c)
        .filter((d) => d.startsWith("chromium"))
        .map((d) => path.join(c, d, "chrome-linux", "chrome"))
        .find((p) => fs.existsSync(p));
      if (hit) return hit;
    }
  }
  throw new Error("Chromiumが見つかりません。CHROME_PATH を設定してください。");
}

// ---- 静的サーバー（supabase.jsだけスタブ差し替え） ----
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (urlPath === "/") urlPath = "/index.html";

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
function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

const browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox"] });

async function newPage(init = {}) {
  const page = await browser.newPage(init.viewport ? { viewport: init.viewport } : {});
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
console.log("pages:");
for (const p of ["/index.html", "/battle.html", "/stats.html", "/profile.html", "/privacy.html"]) {
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
  check("初回スターターは短いeasy語", answer.length <= 4, `got=${answer}`);
  // デスクトップ: keydown経路
  for (const ch of answer) await page.press("#input", ch);
  await page.waitForTimeout(400);
  check("keydown経路で正解", (await page.textContent("#score")) === "1");
  // モバイル: inputイベント経路（2語目）
  await page.press("#input", "Enter");
  await page.waitForTimeout(150);
  const answer2 = (await page.textContent("#word")).trim();
  await page.evaluate((val) => {
    const input = document.getElementById("input");
    input.value = val;
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: val }));
  }, answer2);
  await page.waitForTimeout(400);
  check("inputイベント経路（ソフトキーボード）で正解", (await page.textContent("#score")) === "2");
  check("Studyフローでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();
}

// ===== 3. Daily Dash: 完走→ロック→カウントダウン =====
console.log("daily:");
{
  const page = await newPage();
  await page.goto(BASE + "/index.html?t=3", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.click("#dailyStartButton");
  await page.waitForTimeout(3800);
  const card = await page.textContent("#dailyCard");
  check("完走でロック（スコア表示）", card.includes("今日のスコア"));
  check("カウントダウン表示", card.includes("次の問題まで"));
  check("シェアボタンあり", (await page.$("#dailyShareButton")) !== null);
  const act = await page.evaluate(() => JSON.parse(localStorage.getItem("spelldash_activity") || "{}"));
  check("KPI心拍にdaily完走記録", act.dailyDone === true);
  check("Dailyフローでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();
}

// ===== 4. ストリークカード＋苦手トグル表示 =====
console.log("home widgets:");
{
  const page = await newPage();
  await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  check("ストリークカード表示", (await page.textContent("#streakCard")).includes("日連続"));
  check("苦手トグル（Study時）表示", await page.isVisible("#weakToggleButton"));
  await page.close();
}

await browser.close();
server.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
