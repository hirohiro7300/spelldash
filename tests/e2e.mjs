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

  // /api/explain-word の偽装: 固定の覚え方を返す（"401" を含む語なら未ログイン）
  if (urlPath === "/api/explain-word") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const word = (() => { try { return JSON.parse(raw).word ?? {}; } catch { return {}; } })();
      const json = (status, body) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
      if (String(word.en).includes("401")) return json(401, { error: "login_required", message: "ログインすると使えます（無料）。" });
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
      if (text.includes("401")) return json(401, { error: "login_required", message: "ログインすると使えます（無料）。" });
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
for (const p of ["/index.html", "/battle.html", "/stats.html", "/profile.html", "/privacy.html", "/news.html", "/list.html"]) {
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
  await page.$eval("#homeMore", (el) => { el.open = true; });
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
  check("数字1行にストリーク・週の目標", (await page.textContent("#todayStrip")).includes("連続記録") || (await page.textContent("#todayStrip")).includes("日連続"));
  check("ランク表示（F3スタート）", (await page.textContent("#todayStrip")).includes("F3"));
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
  await page.goto(BASE + "/stats.html#words", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const rows = await page.$$eval("#categoryProgress .cat-row", (els) => els.map((e) => e.textContent));
  check("カテゴリ行が11件（すべて＋9＋マイ単語帳）", rows.length === 11, `rows=${rows.length}`);
  check("広告・マーケの行がある", rows.some((t) => t.includes("広告・マーケ") && t.includes("101語")));
  check("すべての行に語数1101", rows[0]?.includes("1101語") === true, rows[0]);
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
  check("完了パネルに「覚えた！」の語チップ", panel.includes("覚えた！") && (await page.$$eval(".word-chip--learned", (els) => els.map((e) => e.textContent).join(""))).includes("invoice"));
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
  check("正解時発音の設定（既定ON）", (await page3.inputValue("#speakCorrectSelect")) === "on");
  await page3.selectOption("#speakCorrectSelect", "off");
  await page3.waitForTimeout(100);
  const audio = await page3.evaluate(() => JSON.parse(localStorage.getItem("spelldash_audio") || "{}"));
  check("正解時発音OFFが保存される", audio.speakOnCorrect === false, JSON.stringify(audio));
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
  check("初回は腕試しの案内から始まる", (await page.textContent("#message")).includes("腕試し"), await page.textContent("#message"));
  check("腕試し開始が記録される", (await page.evaluate(() => localStorage.getItem("spelldash_placement"))) === "started");
  const known = new Map();
  let placement = null;
  for (let i = 0; i < 40 && !placement; i++) {
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
    return ids.map((en) => m.getAllWords().find((w) => w.en === en)?.level);
  }, [...known.values()]);
  check("腕試しに普通・難しい語が混ざる", seenLevels.includes("normal") && seenLevels.includes("hard"), seenLevels.join(","));
  await waitUntil(async () => (await page.textContent("#message")).includes("腕試し:"), 2500);
  check("腕試し結果のメッセージ", (await page.textContent("#message")).includes("腕試し:"), await page.textContent("#message"));
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
  check("覚えたカードに週の目標（今週 1/3日）", /今週\s*1\s*\/\s*3日/.test(card.replace(/\s+/g, " ")), card.slice(0, 120));
  await page.press("#input", "Enter");
  await page.waitForTimeout(300);
  const startMsg = await page.textContent("#message");
  check("開始時にセットの中身予告（復習1・苦手1）", startMsg.includes("復習 1") && startMsg.includes("苦手 1") && startMsg.includes("からスタート"), startMsg);
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
  check("完了パネルに週の目標の進み具合", panel.includes("今週") && (panel.includes("目標") || panel.includes("達成")), panel.slice(0, 200));
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
  check("「ホーム画面に追加」の案内が出る", (await page2.textContent("#installCard")).trim().length > 10);
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
  const shareText = await page.evaluate(async () => {
    const m = await import("/js/setShare.js");
    return m.buildSetShareText(m.buildSetShareData({ recalled: 5 }));
  });
  check("セットのシェア文に今日覚えた語", shareText.includes("5語 思い出せた") && shareText.includes("今日覚えた: invoice"), shareText);
  const imgOk = await page.evaluate(async () => {
    const m = await import("/js/setShare.js");
    const c = m.buildSetShareImage(m.buildSetShareData({ recalled: 5 }));
    return c.width === 1080 && c.height === 1080;
  });
  check("セットのシェア画像が生成できる（1080×1080）", imgOk);
  check("ミスキー／シェアでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  const keyMissRaw = await page.evaluate(() => localStorage.getItem("spelldash_key_miss"));
  await page.close();

  // 学習データ: ミスキー表示・カレンダー・CSV・単語詳細
  const page2 = await newPage({ storage: { ...seed, spelldash_key_miss: keyMissRaw } });
  await page2.goto(BASE + "/stats.html#words", { waitUntil: "networkidle" });
  await page2.waitForTimeout(900);
  check("よく間違えるキーが表示される", (await page2.textContent("#keyMiss")).includes("よく間違える文字") && (await page2.$$(".keymap__key")).length === 26);
  const calDays = await page2.$$eval("#calendarGrid .cal .cal__day", (els) => ({ total: els.length, active: els.filter((e) => /cal__day--[1-4]/.test(e.className)).length }));
  check("学習カレンダー（13週×7日・学習日2）", calDays.total === 91 && calDays.active === 2 && (await page2.textContent("#calendarGrid")).includes("2日"), JSON.stringify(calDays));
  const csv = await page2.evaluate(async () => (await import("/js/exportCsv.js")).buildLearnedCsv());
  check("覚えた単語帳CSVに見出しと語", csv.includes("english,japanese") && csv.includes("invoice,請求書") && csv.includes("xo"), csv.slice(0, 120));
  await page2.click("#learnedWordList [data-word-detail]");
  await page2.waitForTimeout(200);
  check("単語詳細が開く（語・訳・状態・履歴）", !(await page2.$eval("#wordDetail", (el) => el.hidden)) && /invoice/.test(await page2.textContent("#wordDetailPanel")) && (await page2.textContent("#wordDetailPanel")).includes("請求書") && (await page2.textContent("#wordDetailPanel")).includes("覚えかけ") && (await page2.$("#wordDetailPanel .hist__x")) !== null, (await page2.textContent("#wordDetailPanel")).slice(0, 120));
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
  check("Challenge結果にカテゴリ別ベスト", panel1.includes("広告・マーケ") && panel1.includes("ベスト"), panel1.slice(0, 160));
  check("1回目は前回比なし", !panel1.includes("前回"));
  await page.click("#resultRetry");
  await waitUntil(async () => !(await page.$eval("#resultPanel", (el) => el.hidden)), 5000);
  const panel2 = await page.textContent("#resultPanel");
  check("2回目は前回比が出る", /前回 \d+ → 今回 \d+/.test(panel2), panel2.slice(0, 200));
  check("Challenge（Batch 4）でエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();

  // Esc = 分からない（答え表示）、Tab = 発音（エラーなし・進行しない）。ランクアップ演出（Lv1→2 = F3→F2）
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
  check("Tabで進行しない（発音のみ）", (await page2.textContent("#japanese")).trim() === ja && (await page2.evaluate(() => document.activeElement?.id)) === "input");
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
  check("完了パネルに明日の予告（語つき）", panel.includes("明日は") && panel.includes("の復習から"), panel.slice(0, 220));
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
  check("答え表示で用語と解説が出る", (await page.textContent("#word")).replace(/\s/g, "").includes(card.en.replace(/\s/g, "")) && (await page.textContent("#wordExplain")).includes("📘"));
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
  check("正解後も用語と解説が残る（読む時間）", (await page.textContent("#wordExplain")).includes("📘"));
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
  check("カードに場面・解説・状態・メモ", cpc.includes("CPC") && cpc.includes("100クリックで1万円") && cpc.includes("📘") && cpc.includes("覚えかけ") && cpc.includes("Cost per Click"));
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
  await page.goto(BASE + "/stats.html#words", { waitUntil: "networkidle" });
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
  check("単語帳に記憶ゲージ（3/10・復習2日後）", (await page4.$(".mem__bar")) !== null && listText.includes("3/10") && listText.includes("復習: 2日後"), listText.slice(0, 160));
  check("ジャンル全部覚えたら「制覇」", listText.includes("制覇"));
  check("ログイン案内／ゲージでエラー0", page4.errors.length === 0, page4.errors[0] ?? "");
  await page4.close();

  // 初回オンボーディングは「腕試し」導線
  const page5 = await newPage({ keepOnboarding: true });
  await page5.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await page5.waitForTimeout(800);
  check("初回カードは腕試しの案内", (await page5.textContent("#onboardingCard")).includes("腕試し"));
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
  check("分析タブでタイピング分析が見える", !(await page.$eval("#keyMiss", (el) => el.closest("[data-tab]").hidden)) && (await page.$eval("#weekly", (el) => el.hidden)));
  await page.goto(BASE + "/stats.html#learnedWords", { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  check("#learnedWords の深いリンクで単語帳タブが開く", !(await page.$eval("#learnedWords", (el) => el.hidden)) && (await page.$eval(".stats-tab--active", (el) => el.dataset.tab)) === "words");
  check("前回のタブを覚える", (await page.evaluate(() => localStorage.getItem("spelldash_stats_tab"))) === "words");
  const total = await page.evaluate(async () => {
    const m = await import("/js/setShare.js");
    const d = m.buildTotalShareData();
    const c = m.buildTotalShareImage(d);
    return { learned: d.learned, text: m.buildTotalShareText(d), w: c.width };
  });
  check("累計シェア（覚えた1語・画像1080）", total.learned === 1 && total.text.includes("覚えた英単語 1語") && total.text.includes("negotiate") && total.w === 1080, JSON.stringify(total).slice(0, 120));
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
  check("CTAにジャンル名（入札・配信）", (await page3.textContent("#todayCta")).includes("入札・配信"));
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
  await page.fill("#input", "1");
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
      sawConfusable = fam.includes("混同注意") && fam.includes(shown === "adapt" ? "adopt" : "adapt");
    }
    for (const ch of shown) await page2.press("#input", ch);
    await page2.waitForTimeout(350);
  }
  check("音で出題が混ざる（50%設定）", !!sawListen);
  check("紛らわしい語に「混同注意」（adapt ↔ adopt）", sawConfusable);
  check("音で出題／混同注意でエラー0", page2.errors.length === 0, page2.errors[0] ?? "");
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
  await page.goto(BASE + "/stats.html#words", { waitUntil: "networkidle" });
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
  check("すでにある語（CPC）はチェックが外れて「すでにあります」", (await page.$$eval("[data-cardgen-pick]", (els) => els.map((e) => e.checked))).join() === "true,false" && (await page.textContent("#cardGenPreview")).includes("すでにマイ単語帳にあります"));
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
  check("未ログイン時は「ログインすると使えます」", (await page.textContent("#cardGenStatus")).includes("ログインすると使えます"));
  // 0件
  await page.fill("#cardGenText", "empty のケース: 用語が見つからないテキストとして扱われます。");
  await page.click("#cardGenRun");
  await waitUntil(async () => (await page.textContent("#cardGenStatus")).includes("見つかりません"));
  check("0件のときは案内が出る", (await page.textContent("#cardGenStatus")).includes("見つかりませんでした"));
  check("カード生成フローでエラー0", page.errors.length === 0, page.errors[0] ?? "");
  await page.close();

  // ✨ 覚え方を作る: 答え表示時にボタン → 生成 → 保存され、単語詳細にも出る
  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  const page2 = await newPage({ storage: { spelldash_placement: "done", spelldash_streak: JSON.stringify({ count: 1, last: today }) } });
  await page2.goto(BASE + "/index.html?set=5", { waitUntil: "networkidle" });
  await page2.waitForTimeout(900);
  await page2.press("#input", "Enter");
  await page2.waitForTimeout(250);
  check("答え表示前は覚え方ボタンが無い", (await page2.$$("[data-word-ai-run]")).length === 0);
  await page2.press("#input", "Enter"); // 答え表示
  await page2.waitForTimeout(200);
  const shownWord = (await page2.textContent("#word")).trim();
  check("答え表示で「✨ 覚え方を作る」が出る", (await page2.$$("[data-word-ai-run]")).length === 1);
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
  const page3 = await newPage({ storage: { spelldash_word_ai: aiRaw } });
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
  const page = await newPage();
  await page.goto(BASE + "/list.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const packCount = (await page.$$(".pack")).length;
  check("教材ライブラリに65パック（36分野＋レベル別12＋文法6＋義務教育11）", packCount === 65, `packs=${packCount}`);
  const options = await page.$$eval("#listCategory option", (els) => els.map((e) => e.value));
  check("追加前はカテゴリ選択にパックが無い", !options.includes("realestate"), options.join(","));
  check("ライブラリはグループ見出しつき（5グループ以上）", (await page.$$(".pack-group")).length >= 5);
  await page.fill("#packsSearch", "介護");
  await page.waitForTimeout(100);
  check("分野の検索で絞れる", (await page.$$(".pack")).length >= 1 && (await page.$$(".pack")).length < 5 && (await page.textContent("#packsGrid")).includes("介護"));
  await page.fill("#packsSearch", "");
  await page.waitForTimeout(100);
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
  await page3.click('[data-pack-toggle="realestate"]');
  await waitUntil(async () => !(await page3.$$eval("#listCategory option", (els) => els.map((e) => e.value))).includes("realestate"));
  check("外すとカテゴリ選択から消える", !(await page3.$$eval("#listCategory option", (els) => els.map((e) => e.value))).includes("realestate"));
  check("外すとホームの保存カテゴリは「すべて」", (await page3.evaluate(() => localStorage.getItem("spelldash_category"))) === "all");
  await page3.close();

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

  // 文法パック（穴埋め）: 空欄つきの英文が出て、空欄の語を英語で打つ。発音は完成文
  const page7 = await newPage({ storage: { spelldash_packs: JSON.stringify(["grammar-jhs1"]), spelldash_category: "grammar-jhs1", spelldash_placement: "done", spelldash_level_boost: "2", spelldash_streak: JSON.stringify({ count: 1, last: today }) } });
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
  const page9 = await newPage({ storage: { spelldash_packs: JSON.stringify(["pref"]), spelldash_category: "pref", spelldash_placement: "done", spelldash_level_boost: "2", spelldash_streak: JSON.stringify({ count: 1, last: today }) } });
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
  const page10 = await newPage({ storage: { spelldash_packs: JSON.stringify(["pref"]) } });
  await page10.goto(BASE + "/list.html?category=pref", { waitUntil: "networkidle" });
  await page10.waitForTimeout(900);
  check("都道府県パックの一覧（60枚・地方ごとのジャンル）", (await page10.$$(".gcard")).length === 60 && (await page10.$$(".genre")).length >= 6);
  check("ライブラリに「義務教育」グループ（11パック）", (await page10.$$eval(".pack-group__title", (els) => els.map((e) => e.textContent))).some((t) => t.includes("義務教育")) && (await page10.$$('[data-pack-toggle="jhist1"], [data-pack-toggle="jsci2"], [data-pack-toggle="jmath"]')).length === 3);
  await page10.close();

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

await browser.close();
server.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
