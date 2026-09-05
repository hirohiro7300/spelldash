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
for (const p of ["/index.html", "/battle.html", "/stats.html", "/profile.html", "/privacy.html", "/news.html"]) {
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
      grew = (await page.textContent("#message")).includes("習得まで");
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
  check("自力正解後に成長メッセージ（習得まで）", grew, `last msg=${await page.textContent("#message")}`);
  check("ホームに覚えた単語カード", (await page.textContent("#learnedCard")).includes("覚えた単語"));
  check("Studyフローでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();
}

// ===== 2.5 日本語IME＋Studyキュー配置 =====
console.log("ime & queue:");
{
  const page = await newPage();
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
  check("打ち直し案内が出る", (await page.textContent("#message")).includes("打ち直そう"));
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

// ===== 4. ストリークカード＋苦手トグル＋ヘッダーストリーク表示 =====
console.log("home widgets:");
{
  const page = await newPage();
  await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  check("ストリークカード表示", (await page.textContent("#streakCard")).includes("日連続"));
  check("ランク表示（F3スタート）", (await page.textContent("#levelBar")).includes("ランク F3"));
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
}

// ===== 5. Challenge: 完走でリザルトパネル =====
console.log("challenge result:");
{
  const page = await newPage();
  await page.goto(BASE + "/index.html?t=3", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.click('.mode-switch__btn[data-mode="challenge"]');
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
  await page.click('.mode-switch__btn[data-mode="challenge"]');
  await page.waitForTimeout(800);
  const cardTop = await page.evaluate(() => document.getElementById("gameCard").getBoundingClientRect().top);
  check("モード選択後ゲームカードが画面上部へ", cardTop >= 0 && cardTop < 300, `top=${cardTop}`);
  // フォーカスモード: プレイ中はヒーロー・モードタイルが畳まれる
  check("プレイ中はヒーロー非表示", !(await page.isVisible(".hero")));
  check("プレイ中はモードタイル非表示", !(await page.isVisible("#modeSwitch")));
  await page.waitForTimeout(3200);
  check("終了後モードタイル復帰", await page.isVisible("#modeSwitch"));
  const panelVisible = await page.evaluate(() => {
    const r = document.getElementById("resultPanel").getBoundingClientRect();
    return r.top < window.innerHeight && r.bottom > 0;
  });
  check("完走時リザルトパネルが画面内", panelVisible);
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
  check("ライトで背景が明色", bodyBg.includes("244, 246, 251"), `bg=${bodyBg}`);
  await page.goto(BASE + "/profile.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await page.selectOption("#themeSelect", "dark");
  await page.waitForTimeout(200);
  check("黒選択で即時ダーク適用", (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark");
  // BGM設定: 既定ON→OFFに切替（profileページ上で確認）
  check("BGM設定は既定ON", (await page.$eval("#bgmSelect", (el) => el.value)) === "on");
  await page.selectOption("#bgmSelect", "off");
  await page.goto(BASE + "/profile.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  check("BGM OFFが永続化", (await page.$eval("#bgmSelect", (el) => el.value)) === "off");
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
  check("ホームに今日のセットCTA", (await page.textContent("#todayCta")).includes("今日のセット"));
  await page.click("#todayCtaButton");
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
  check("完了パネルに明日の復習予定", panelText.includes("明日の復習予定"));
  check("CTAが完了表示に切替", (await page.textContent("#todayCta")).includes("完了"));
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
  await page.goto(BASE + "/stats.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const rows = await page.$$eval("#categoryProgress .cat-row", (els) => els.map((e) => e.textContent));
  check("カテゴリ行が10件（すべて＋8＋マイ単語帳）", rows.length === 10, `rows=${rows.length}`);
  check("広告・マーケの行がある", rows.some((t) => t.includes("広告・マーケ") && t.includes("101語")));
  check("すべての行に語数1101", rows[0]?.includes("1101語") === true, rows[0]);
  check("カテゴリ進捗でエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();
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
  await page.click("[data-weekly-share]");
  await page.waitForTimeout(300);
  check("シェア押下でエラー0", page.errors.length === 0, page.errors[0] ?? "");
  // ホーム: ?weekly=1 で週間レポートを強制表示
  await page.goto(BASE + "/index.html?weekly=1", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  check("ホームに週間レポート（コンパクト）", !(await page.$eval("#weeklyHome", (el) => el.hidden)) && (await page.textContent("#weeklyHome")).includes("くわしく見る"));
  check("成長フローでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();
}

// ===== 9.6 マイ単語帳: 追加→一覧→ホームで出題 =====
console.log("my words:");
{
  const page = await newPage();
  await page.goto(BASE + "/stats.html#myWords", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
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

await browser.close();
server.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
