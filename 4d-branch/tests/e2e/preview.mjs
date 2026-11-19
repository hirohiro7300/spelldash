// 試し版（3 年の分かれ道）の E2E: npm run e2e:preview（= node tests/e2e/preview.mjs）
//   node tests/e2e/preview.mjs [ページ] [写真の置き場] [--no-build]
//     ページを渡さなければ、先に scripts/build-preview.mjs でページを作る（地図は DEEPMAP_TREE か、版 7 の候補の同梱データ。
//     出力は DEEPMAP_PREVIEW_OUT か作業メモの view/preview-v2.html）。写真の置き場は DEEPMAP_PREVIEW_SHOTS か view/v2/shots
//     PW_CHROMIUM でブラウザの場所を変えられる。E2E_ONLY に名前の一部を渡すと、その確かめだけ（前の状態を使う物は単独では動かない）
// 公開のときの骨組み（<!doctype html><html><head><meta charset=utf8><meta name=viewport …></head><body>ページ</body></html>）で包み、
// 外の物を読めない CSP の下で、390×844（スマホ）と 1440×900 で開いて確かめる:
//   コンソールにエラーが無い・390px で横にはみ出さない・押す所は 44px 以上・英字の鍵が画面に出ない・
//   見取り図の 10 行と「10 の手をひと目で」（390×844 の最初の画面に 10 行）・手の詳しい画面と扇・2029 年 11 月（36 か月目）までの道・
//   ほかの結果や手への切り替え（戻る・進むも）・静かな期のまとめ・標準の続きの薄い行（cont のある地図は見積もりの印の行と代表の手、
//   無い地図は 1 本の行）・次の 3 か月へ・道の名前で直接ひらく（今の地図に無い道は知らせ）・年収を変えると計算し直す
// 文章（文章の組み立て。作業メモ SPEC v1 §4・§5.4）: 「文章は仮」がどこにも無い・起動ではカードを組み立てない・開いた行の手の本文は
//   150 字より長く、やることは手ごとにちょうど 3 つ（焼き込んだ地図）・まとめた手の後の行は開くと見積もりの印つきの文章とやること
// 時間（作業メモ SPEC v1 §7.2）: 開き始めから見取り図が描かれるまで（3 回の一番速い物）を 1440×900 と CPU 4 倍遅くした 390×844 で。
//   上限は最初に役に立つ画面の予算 机 0.8 秒・スマホ（4 倍）3 秒。道の切り替え（押してから次の画面まで）は机で 50ms 以下（真ん中の値）
// 写真（deviceScaleFactor 1）は写真の置き場に、時間はその隣の timings-preview.jsonl に残す。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRATCH = "/tmp/claude-0/-home-user-spelldash/342dd9ca-ed44-551f-af59-60da8aff2834/scratchpad/deepmap/view";
const args = process.argv.slice(2);
const pos = args.filter((a) => !a.startsWith("--"));
const NO_BUILD = args.includes("--no-build") || pos.length > 0;
const PAGE = path.resolve(pos[0] || process.env.DEEPMAP_PREVIEW_OUT || path.join(SCRATCH, "preview-v2.html"));
const SHOTS = path.resolve(pos[1] || process.env.DEEPMAP_PREVIEW_SHOTS || path.join(SCRATCH, "v2", "shots"));
const ONLY = process.env.E2E_ONLY || "";

// ---- ページを作る（渡されたページを使うときは作らない）
if (!NO_BUILD) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "build-preview.mjs")], { cwd: ROOT, stdio: "inherit", env: { ...process.env, DEEPMAP_PREVIEW_OUT: PAGE } });
  if (r.status !== 0) throw new Error("試し版のページを作れなかった（scripts/build-preview.mjs）");
}
if (!fs.existsSync(PAGE)) throw new Error(`${PAGE} がありません。先に node scripts/build-preview.mjs を実行してください`);
fs.mkdirSync(SHOTS, { recursive: true });

// 公開のときの骨組み（このとおりに包む）と、骨組みが足す小さな初期化（文字・余白・color-scheme: light）を入れた物
const pageHtml = fs.readFileSync(PAGE, "utf8");
/** 埋め込んだ地図の形（同梱データは DecompressionStream が無くても小さな伸長で開く。開発用の木は開けない） */
const FORMAT = /id="deepmap-data" data-format="([^"]+)"/.exec(pageHtml)?.[1] ?? "";
const IS_BUNDLE = FORMAT === "impact-bundle-gzip";
/** 開いたページの地図（版・指紋・文の型の版。最初の確かめで読む）。文の型の版が無い・dev の地図は、やることを焼き込んでいない */
let MAP = null;
const todoBaked = () => !!MAP && !!MAP.textVersion && MAP.textVersion !== "dev";
const WRAP = (page) => `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>${page}</body></html>`;
const HOST_STYLE = "<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>";
const html = WRAP(pageHtml);
const htmlHost = WRAP(pageHtml).replace("</head>", `${HOST_STYLE}</head>`);
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:" });
  res.end(req.url?.startsWith("/host") ? htmlHost : html);
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;

const results = [];
async function check(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`  ✗ ${name}\n      ${String(e?.stack || e).split("\n").slice(0, 5).join("\n      ")}`);
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m);
};
const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : NaN;
};
const r1 = (x) => Math.round(x * 10) / 10;

/** 画面に出ている文字に、英字の鍵（手の種類・結果・事実・文章の語彙の名前）が無いか */
const ID_RE = /\b(?:ad|sd|fc|ind|back)_[a-z0-9_]+\b|\b[a-z]+_[a-z0-9]+(?:_[a-z0-9]+)*\b|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\bpm:\d+\b|\b(?:keep|stub|sum|undefined|null|NaN)\b/;
const FRAME = "3 年後の幅は、この手より、この先の分かれ道での選び方と運で決まる";

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const timings = [];

async function open(viewport, mobile, hash = "") {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE + hash);
  await page.waitForFunction(() => window.__deepmapPreview?.visible || window.__deepmapPreview?.error, null, { timeout: 60_000 });
  const info = await page.evaluate(() => window.__deepmapPreview);
  assert(!info.error, `読み込めない: ${info.error}`);
  return { ctx, page, errors };
}

/** 横にはみ出さない・押す所は 44px 以上・英字の鍵が出ない */
async function layoutChecks(page, label) {
  const r = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const over = [];
    for (const el of document.querySelectorAll("body *")) {
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      if (el.closest(".dm-scroll")) continue;
      if (b.right > vw + 0.5 || b.left < -0.5) over.push(`${el.tagName.toLowerCase()}.${String(el.className?.baseVal ?? el.className).split(" ")[0]} ${Math.round(b.left)}〜${Math.round(b.right)}`);
    }
    const small = [];
    for (const el of document.querySelectorAll("a[href], button, input, summary, [tabindex='0']")) {
      const b = el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) continue;
      if (b.height < 44 - 0.5 || b.width < 44 - 0.5) small.push(`${el.tagName.toLowerCase()}「${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 20)}」${Math.round(b.width)}×${Math.round(b.height)}`);
    }
    return { scrollW: document.documentElement.scrollWidth, vw, over: over.slice(0, 8), small: small.slice(0, 8), text: document.body.innerText };
  });
  assert(r.scrollW <= r.vw, `${label}: 横にはみ出している（${r.scrollW} > ${r.vw}）: ${r.over.join(" / ")}`);
  assert(r.over.length === 0, `${label}: 画面の外に出ている要素: ${r.over.join(" / ")}`);
  assert(r.small.length === 0, `${label}: 44px より小さい押す所: ${r.small.join(" / ")}`);
  const m = ID_RE.exec(r.text);
  assert(!m, `${label}: 英字の鍵が画面に出ている: 「${m?.[0]}」（…${r.text.slice(Math.max(0, (m?.index ?? 0) - 30), (m?.index ?? 0) + 30)}…）`);
  // 文章は文章の組み立て（仮の文章の印は出ない）
  assert(!r.text.includes("文章は仮"), `${label}: 「文章は仮」が出ている`);
}

/**
 * 開いた道の行の文章（作業メモ SPEC v1 §4・§5.4）: 「文章は仮」が無い・手の本文は 150 字より長い・やることは手ごとにちょうど 3 つ
 * （焼き込んだ地図）・結果のカードにも本文。その行の文章を返す
 */
async function openedRowText(li, label) {
  const r = await li.evaluate((el) => {
    const body = el.querySelector(":scope > .dm-tl-body");
    const move = body?.querySelector(".dm-tl-card.is-move");
    return {
      all: body?.innerText ?? "",
      move: move?.querySelector(".dm-tl-text")?.textContent ?? "",
      todo: move ? move.querySelectorAll(".dm-tl-todo li").length : -1,
      out: body?.querySelector(".dm-tl-card.is-out .dm-tl-text")?.textContent ?? null,
      stub: el.classList.contains("is-stub"),
    };
  });
  assert(!r.all.includes("文章は仮"), `${label}: 「文章は仮」が出ている`);
  assert(r.move.length > 150, `${label}: 手の本文が 150 字以下（${r.move.length} 字）: ${r.move}`);
  if (todoBaked()) assert(r.todo === 3, `${label}: 手のやることが 3 つではない（${r.todo}）`);
  if (!r.stub) assert(r.out !== null && r.out.length > 20, `${label}: 結果の本文が無い・短い: ${r.out}`);
  return r;
}

/** 見取り図から始める（前の確かめが途中で落ちても続けられるように） */
async function goOverview(page) {
  await page.evaluate(() => (location.hash = "#overview"));
  await page.locator(".dm-row").first().waitFor();
}

/** 一番良い今日の手（見取り図の 1 行目）の一番ありそうな道を開く */
async function goChain(page) {
  await goOverview(page);
  await page.locator(".dm-row").first().click();
  await page.waitForFunction(() => location.hash.startsWith("#move-"));
  await page.locator(".dm-fan-svg").waitFor();
  await page.locator(".dm-btn.is-primary").first().click();
  await page.waitForFunction(() => location.hash.startsWith("#path-"));
  await page.locator(".dm-tl-end").waitFor();
}

/** 道の k 行目（まとめの外の行。0 から）を開く（開いていれば何もしない）。その行の locator を返す */
async function openRow(page, k) {
  const li = page.locator(".dm-tl > .dm-tl-item.is-step").nth(k);
  const head = li.locator(":scope > .dm-tl-head");
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  await li.locator(":scope > .dm-tl-body").waitFor();
  return li;
}

/** 道の画面の今の様子（題名・見込み・行の年月と手と結果・着いた所） */
async function pathState(page) {
  return page.evaluate(() => {
    const q = (s) => document.querySelector(s)?.textContent?.trim() ?? "";
    const steps = [...document.querySelectorAll(".dm-tl-item.is-step")].map((li) => ({
      key: li.dataset.key,
      when: li.querySelector(":scope > .dm-tl-head .dm-tl-when b")?.textContent ?? "",
      move: li.querySelector(":scope > .dm-tl-head .dm-tl-move-name")?.textContent ?? "",
      out: li.querySelector(":scope > .dm-tl-head .dm-tl-out")?.textContent ?? "",
      open: li.querySelector(":scope > .dm-tl-head")?.getAttribute("aria-expanded") === "true",
    }));
    return {
      hash: location.hash,
      title: q("#pv-main .dm-h2"),
      p: q(".dm-fig-value"),
      total: document.querySelectorAll(".dm-fig-value")[1]?.textContent ?? "",
      end: q(".dm-tl-end .dm-tl-card-head"),
      steps,
      groups: [...document.querySelectorAll(".dm-tl-item.is-group > .dm-tl-head")].map((b) => b.textContent),
      light: document.querySelectorAll(".dm-tl-item.is-light").length,
      summary: !!document.querySelector(".dm-tl-end.is-summary"),
      switches: window.__deepmapPreview.pathSwitches.slice(),
    };
  });
}

async function shot(page, name, full = true) {
  // 全体の写真は上から（追いかける欄が途中に写らないように）。画面の外を描くのを後回しにした所（content-visibility: auto）は、
  // 画面の外まで写す全体の写真では描かれないまま写るので、写す間だけ描く（ページの見た目は変えない。W-view の報告 §3）
  if (full)
    await page.evaluate(() => {
      scrollTo(0, 0);
      const st = document.createElement("style");
      st.id = "e2e-cv";
      st.textContent = "*{content-visibility:visible!important}";
      document.head.append(st);
    });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: full });
  if (full) await page.evaluate(() => document.getElementById("e2e-cv")?.remove());
}

// 前の版の写真の名前（overview-move-* など）は消す（この版の名前と混ざらないように）
for (const f of fs.readdirSync(SHOTS)) if (/^overview-(move|path|fan)-/.test(f)) fs.rmSync(path.join(SHOTS, f));

for (const [vp, mobile, tag] of [
  [{ width: 390, height: 844 }, true, "390"],
  [{ width: 1440, height: 900 }, false, "1440"],
]) {
  console.log(`— ${tag}`);
  let s = null;
  await check(`${tag}: 読み込んで見取り図の 10 行を出す（文章は組み立て・起動ではカードを組み立てない）`, async () => {
    s = await open(vp, mobile);
    const rows = await s.page.locator(".dm-row").count();
    assert(rows === 10, `見取り図の行が 10 ではない: ${rows}`);
    const first = await s.page.locator(".dm-row").first().innerText();
    assert(/分かれ道/.test(first) && /万円/.test(first), `行に分かれ道と万円が無い: ${first}`);
    const info = await s.page.evaluate(() => window.__deepmapPreview);
    MAP = info.map;
    assert(MAP && MAP.format === FORMAT, `埋め込んだ形と読んだ形が違う: ${JSON.stringify(MAP)} / ${FORMAT}`);
    assert(info.text && info.text.provisional === false, "文章が仮のまま（文章の組み立てがつながっていない）");
    assert(info.text.composed.cards === 0 && info.text.composed.cont === 0, `起動でカードを組み立てた: ${JSON.stringify(info.text.composed)}`);
    // 焼き込んだ文章の文の型の版と、ページの中の組み立ての版が同じ（作業メモ code-1: 題とやることが古い言い方のまま本文だけ新しくならない）
    if (todoBaked()) assert(info.text.composed.banks === MAP.textVersion, `文の型の版が違う: 地図 ${MAP.textVersion}・組み立て ${info.text.composed.banks}`);
    await shot(s.page, `overview-${tag}-top`, false);
    await shot(s.page, `overview-${tag}`);
  });
  if (!s) continue;
  const { page, errors } = s;
  await check(`${tag}: 見取り図の形（はみ出し・押す所・英字の鍵）`, () => layoutChecks(page, "見取り図"));
  await check(`${tag}: 見取り図の中身（数・言葉）`, async () => {
    const t = await page.locator(".dm-overview").innerText();
    const wants = ["今やる vs 3 か月待つ", "3 年の合計", "ずっと今のままより", "3 か月待っても", "この先の分かれ道", "会社の答え", FRAME, "の手をひと目で", "一番ありそうな道", "真ん中あたりの道", "低い方から"];
    // 判断・行き先の数の 1 行は、広い画面は見取り図に、狭い画面は手の詳しい画面に（作業メモ user-3）
    if (tag === "1440") wants.push("判断", "出来事の分かれ", "見込み 1% 以上", "標準の続きの見積もり");
    for (const want of wants) assert(t.includes(want), `見取り図に「${want}」が無い`);
    const head = await page.locator(".pv-head").innerText();
    for (const want of ["3 年の分かれ道（試し版）", "時点の地図", "年収", "万円で計算", "カード", "地図"]) assert(head.includes(want), `見出しに「${want}」が無い`);
    assert(!head.includes("木"), `見出しに「木」がある: ${head}`);
  });
  await check(`${tag}: 10 の手をひと目で（最初の画面に 10 行・共通の軸の棒・押すと手の詳しい画面）`, async () => {
    await goOverview(page);
    await page.evaluate(() => scrollTo(0, 0));
    const r = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".dm-glance-row")];
      const frame = document.querySelector(".dm-overview .dm-frame")?.getBoundingClientRect();
      return {
        n: rows.length,
        bottom: Math.max(...rows.map((e) => e.getBoundingClientRect().bottom)),
        bars: document.querySelectorAll(".dm-glance-range").length,
        mids: document.querySelectorAll(".dm-glance-mid").length,
        frameBottom: frame ? frame.bottom : 1e9,
        vh: innerHeight,
      };
    });
    assert(r.n === 10 && r.bars === 10 && r.mids === 10, `ひと目の行・棒が 10 ではない: ${JSON.stringify(r)}`);
    assert(r.frameBottom <= r.vh, `3 年の幅の読み方が最初の画面に無い（下端 ${Math.round(r.frameBottom)} > ${r.vh}）`);
    if (tag === "390") assert(r.bottom <= r.vh, `ひと目の 10 行が最初の画面に入らない（下端 ${Math.round(r.bottom)} > ${r.vh}）`);
    await page.locator(".dm-glance-row").last().click();
    await page.waitForFunction(() => location.hash.startsWith("#move-"));
    await page.locator(".dm-fan-svg").waitFor();
  });
  await check(`${tag}: 手の詳しい画面と扇（分かれ道の帯・進め方・行き先）`, async () => {
    await goOverview(page);
    await page.locator(".dm-row").first().click();
    await page.waitForFunction(() => location.hash.startsWith("#move-"));
    await page.locator(".dm-fan-svg").waitFor();
    assert((await page.locator(".dm-fan-svg path.dm-line").count()) >= 2, "扇の線が無い");
    assert((await page.locator(".dm-strip-col").count()) >= 10, "分かれ道の帯の列が足りない");
    assert((await page.locator(".dm-plan-row").count()) >= 10, "進め方の行が足りない");
    assert((await page.locator(".dm-dest-row").count()) >= 3, "行き先の行が足りない");
    const eyebrow = await page.locator(".dm-move .dm-eyebrow").first().innerText();
    assert(eyebrow.includes("2026 年 12 月〜2027 年 2 月"), `今日の手の 3 か月が違う: ${eyebrow}`);
    const head = await page.locator(".dm-move-head").innerText();
    for (const want of [FRAME, "＝ この手の分", "3 か月待っても出る分", "判断", "出来事の分かれ", "見込み 1% 以上", "標準の続きの見積もり", "一番ありそうな道", "真ん中あたりの道"]) assert(head.includes(want), `手の詳しい画面の見出しに「${want}」が無い`);
    // 進め方の残りの手は開ける（作業メモ user-8）
    const rest = page.locator(".dm-plan-rest summary").first();
    if (await rest.count()) {
      await rest.click();
      assert((await page.locator(".dm-plan-rest[open] .dm-plan-move").count()) >= 1, "残りの手が開かない");
    }
    await layoutChecks(page, "手の詳しい画面");
    await shot(page, `move-${tag}`);
  });
  await check(`${tag}: 扇の縦線の札（指・マウス・キーボード）`, async () => {
    const plot = page.locator(".dm-fan-plot");
    await plot.scrollIntoViewIfNeeded();
    const b = await plot.boundingBox();
    await page.mouse.move(b.x + b.width * 0.55, b.y + b.height * 0.5);
    await page.locator(".dm-fan-plot .dm-tip:not([hidden])").waitFor({ timeout: 3000 });
    const tip = await page.locator(".dm-fan-plot .dm-tip").innerText();
    assert(/万円/.test(tip) && /月の稼ぎ/.test(tip), `札に数が無い: ${tip}`);
    await shot(page, `fan-${tag}`, false);
    await plot.focus();
    await page.keyboard.press("Home");
    const t0 = await page.locator(".dm-fan-plot .dm-tip").innerText();
    assert(/今日/.test(t0), `Home で今日に行かない: ${t0}`);
    await page.keyboard.press("Escape");
  });
  await check(`${tag}: 一番ありそうな道は 2029 年 11 月（36 か月目）まで 3 か月ごとに続く`, async () => {
    await goChain(page);
    const st = await pathState(page);
    assert(st.title === "一番ありそうな道", `題名が違う: ${st.title}`);
    assert(/^[\d.]+%$/.test(st.p), `この道の見込みが無い: ${st.p}`);
    assert(st.end.startsWith("2029 年 11 月に着く所"), `2029 年 11 月まで続かない: ${st.end}`);
    assert(st.steps.length === 12, `3 か月ごとの行が 12 ではない: ${st.steps.length}`);
    assert(st.steps[0].when === "2026 年 11 月" && st.steps[11].when === "2029 年 8 月", `行の年月が違う: ${st.steps[0].when}〜${st.steps[11].when}`);
    const head = await page.locator(".dm-tl-item.is-step").first().innerText();
    for (const want of ["12 月〜2 月の手", "→", "%", "2027 年 2 月:", "月の稼ぎ", "万円", "ここまでの稼ぎ", "ほかの結果", "ほかの手"]) assert(head.includes(want), `行に「${want}」が無い: ${head}`);
    // 3 年の合計の位置（一番ありそうな道は低い側。作業メモ user-2・truth-6）
    assert(/の道の中で(低い方から|高い方から|真ん中)/.test(await page.locator(".dm-figs").innerText()), "3 年の合計の位置が無い");
    // 静かな期は 1 行（「転職活動を続ける（2 期・転職せず）」など）
    assert(st.groups.some((g) => /（\d+ 期・[^）]+）|（\d+ 期続けて）/.test(g)), `静かな期のまとめが無い: ${st.groups.join(" / ")}`);
    const t = await page.locator(".dm-pathv").innerText();
    for (const want of ["この道の見込み", "3 年の合計", "ずっと今のままより", "月の稼ぎ", "最初の 3 か月から読む"]) assert(t.includes(want), `道の画面に「${want}」が無い`);
    await layoutChecks(page, "道の画面");
    await shot(page, `path-${tag}-top`, false);
    await shot(page, `path-${tag}`);
  });
  await check(`${tag}: 行を開くと文章・数字の行・ほかの結果と手、「次の 3 か月へ」で次の行`, async () => {
    const row = await openRow(page, 1);
    assert((await row.locator(":scope > .dm-tl-head").getAttribute("aria-expanded")) === "true", "行が開かない");
    const body = row.locator(":scope > .dm-tl-body");
    assert((await body.locator(".dm-tl-card").count()) >= 2, "その 3 か月と結果の文章が無い");
    assert((await body.locator(".dm-tl-nums li").count()) >= 2, "数字の行が無い");
    assert((await body.locator("a.dm-alt").count()) >= 1, "ほかの結果・ほかの手が無い");
    assert((await body.locator(".dm-alt.is-current").count()) >= 1, "この道の物の印が無い");
    const t = await body.innerText();
    assert(t.includes("この手の結果") || t.includes("に選べる手"), `ほかの並びの見出しが無い: ${t.slice(0, 80)}`);
    // 組み立てた文章（「文章は仮」が無い・手の本文は 150 字より長い・やることは 3 つ）
    await openedRowText(row, "開いた行");
    await layoutChecks(page, "開いた行");
    await shot(page, `path-${tag}-open`, false);
    const before = await pathState(page);
    await body.locator(".dm-tl-next").click();
    await page.waitForFunction((k) => {
      const lis = [...document.querySelectorAll(".dm-tl-item.is-step")];
      const i = lis.findIndex((li) => li.dataset.key === k);
      return lis[i]?.querySelector(":scope > .dm-tl-head")?.getAttribute("aria-expanded") === "false" && lis[i + 1]?.querySelector(":scope > .dm-tl-head")?.getAttribute("aria-expanded") === "true";
    }, before.steps[1].key);
    // 開いた次の行はまとめの中でも見える（まとめも開く）
    assert(await page.locator(".dm-tl-item.is-step.is-open > .dm-tl-head").first().isVisible(), "次の行が見えない");
  });
  await check(`${tag}: 手の詳しい画面と今日の手の本文が、同じ行き先の数と 3 年の合計を言う（作業メモ reader-4・truth-4）`, async () => {
    await goOverview(page);
    await page.locator(".dm-row").first().click();
    await page.waitForFunction(() => location.hash.startsWith("#move-"));
    await page.locator(".dm-fan-svg").waitFor();
    const head = await page.locator(".dm-move-head").innerText();
    const numOf = (x) => Number(x.replace(/,/g, ""));
    const pf = /行き先: 地図にある ([\d,]+)（うち標準の続きの見積もり ([\d,]+)）・一番良い選び方で着く ([\d,]+)（見込み 1% 以上 ([\d,]+)）/.exec(head);
    assert(pf, `手の詳しい画面に行き先の 2 つの数が無い: ${head.slice(0, 300)}`);
    const pm = /平均 ([\d,]+) 万円/.exec(head);
    await page.locator(".dm-btn.is-primary").first().click();
    await page.waitForFunction(() => location.hash.startsWith("#path-"));
    await page.locator(".dm-tl-end").waitFor();
    const li = await openRow(page, 0);
    const body = await li.locator(":scope > .dm-tl-body .dm-tl-card.is-move .dm-tl-text").innerText();
    const bf = /地図にある行き先は ([\d,]+)（うち標準の続きの見積もり ([\d,]+)）で、一番良い選び方で着くのは ([\d,]+)（そのうち見込み 1 分以上は ([\d,]+)）/.exec(body);
    assert(bf, `今日の手の本文に行き先の 2 つの数が無い: ${body}`);
    for (let j = 1; j <= 4; j++) assert(numOf(pf[j]) === numOf(bf[j]), `行き先の数が違う（${j} 番目）: 画面 ${pf[0]} / 本文 ${bf[0]}`);
    assert(numOf(pf[1]) > numOf(pf[3]), `地図にある行き先が着く行き先より多くない: ${pf[0]}`);
    // 3 年の合計: 本文は見積もり方を言い、一番良い選び方の平均は画面と同じ数
    assert(body.includes("その後を標準の選び方で続けた見積もりで"), `今日の手の本文が見積もり方を言わない: ${body}`);
    const bm = /その後を一番良い選び方で進めば、平均 ([\d,]+) 万円/.exec(body);
    assert(pm && bm && pm[1] === bm[1], `3 年の合計の平均が画面と本文で違う: 画面 ${pm?.[0]} / 本文 ${bm?.[0]}`);
  });
  await check(`${tag}: 一番ありそうな道を「次の 3 か月へ」で最後まで読む（どの行も組み立てた文章・手の本文 150 字より長い・やること 3 つ）`, async () => {
    await goChain(page);
    // 前に開いた行（道ごとに覚えている）を閉じてから読む
    const opened = page.locator(".dm-tl-item.is-step.is-open > .dm-tl-head");
    while ((await opened.count()) > 0) await opened.first().click();
    const c0 = (await page.evaluate(() => window.__deepmapPreview.text.composed)).cards;
    await page.locator(".dm-pathv-actions .dm-btn", { hasText: "最初の 3 か月から読む" }).click();
    const n = await page.locator(".dm-tl-item.is-step").count();
    for (let k = 0; k < n; k++) {
      const li = page.locator(".dm-tl-item.is-step.is-open");
      await li.first().locator(":scope > .dm-tl-body .dm-tl-next").waitFor();
      assert((await li.count()) === 1, `開いている行が 1 行ではない（${k + 1} 行目で ${await li.count()}）`);
      const key = await li.first().getAttribute("data-key");
      await openedRowText(li.first(), `${k + 1} 行目`);
      await li.first().locator(":scope > .dm-tl-body .dm-tl-next").click();
      if (k < n - 1) await page.waitForFunction((x) => !document.querySelector(`.dm-tl-item.is-step.is-open[data-key="${x}"]`) && !!document.querySelector(".dm-tl-item.is-step.is-open"), key);
    }
    assert((await page.locator(".dm-tl-item.is-step.is-open").count()) === 0, "最後の行の次で行が閉じない");
    // 着いた所も組み立てた文章
    const end = await page.locator(".dm-tl-end .dm-tl-text").innerText();
    assert(end.length > 150 && !end.includes("文章は仮"), `着いた所の本文が短いか仮: ${end}`);
    // 組み立てたのは開いた行と道の始め・着いた所の分だけ（全部のカードではない）
    const c1 = (await page.evaluate(() => window.__deepmapPreview.text.composed)).cards;
    assert(c1 - c0 >= n && c1 - c0 <= 2 * n + 2, `組み立てた枚数が開いた行の分と合わない: ${c1 - c0}（行 ${n}）`);
  });
  await check(`${tag}: ほかの結果に切り替えると道が変わり、戻る・進むで行き来できる`, async () => {
    await goChain(page);
    const a0 = await pathState(page);
    // 2 行目（3 か月後の判断）を開いて、ほかの結果を押す
    const row = await openRow(page, 1);
    const head = row.locator(":scope > .dm-tl-head");
    const alt = row.locator(":scope > .dm-tl-body a.dm-alt").first();
    const altText = (await alt.innerText()).split("\n")[0];
    // 押す直前の行の位置（押す所を画面に入れてから測る）
    await alt.scrollIntoViewIfNeeded();
    const top0 = (await head.boundingBox()).y;
    await alt.click();
    await page.waitForFunction((h) => location.hash !== h, a0.hash);
    const a1 = await pathState(page);
    assert(a1.hash.startsWith("#path-") && a1.hash !== a0.hash, `道が変わらない: ${a1.hash}`);
    assert(a1.title === "切り替えた道", `題名が「切り替えた道」にならない: ${a1.title}`);
    assert(a1.steps[1].key === a0.steps[1].key && a1.steps[0].out === a0.steps[0].out, "切り替えた行より上が変わった");
    assert(a1.steps[1].out !== a0.steps[1].out || a1.steps[1].move !== a0.steps[1].move, `切り替えた行が変わらない: ${a1.steps[1].out}`);
    assert(a1.steps[1].open, "切り替えた行が開いていない");
    assert(a1.p !== a0.p, `この道の見込みが変わらない: ${a1.p}`);
    assert(a1.end.startsWith("2029 年 11 月"), `切り替えた道が 2029 年 11 月まで続かない: ${a1.end}`);
    const top1 = (await page.locator(".dm-tl > .dm-tl-item.is-step").nth(1).locator(":scope > .dm-tl-head").boundingBox()).y;
    assert(Math.abs(top1 - top0) <= 2, `切り替えた行の位置が動いた: ${Math.round(top0)} → ${Math.round(top1)}`);
    assert((await page.locator(".dm-pathv-offs").innerText()).includes("一番ありそうな道と違う所"), "違う所が出ない");
    assert(altText.length > 0, "押したほかの結果の名前が無い");
    await layoutChecks(page, "切り替えた道");
    await shot(page, `path-${tag}-switched`, false);
    // 戻る: 元の道（開いていた行もそのまま）・進む: 切り替えた道
    await page.goBack();
    await page.waitForFunction((h) => location.hash === h, a0.hash);
    const b0 = await pathState(page);
    assert(b0.title === "一番ありそうな道" && b0.p === a0.p, `戻ると元の道にならない: ${b0.title} ${b0.p}`);
    assert(b0.steps[1].open, "戻ったとき開いていた行が閉じている");
    await page.goForward();
    await page.waitForFunction((h) => location.hash === h, a1.hash);
    const f1 = await pathState(page);
    assert(f1.title === "切り替えた道" && f1.p === a1.p, `進むと切り替えた道にならない: ${f1.title} ${f1.p}`);
    // 一番ありそうな道に戻す
    await page.locator(".dm-pathv-actions a.dm-btn").click();
    await page.waitForFunction(() => document.querySelector("#pv-main .dm-h2")?.textContent === "一番ありそうな道");
  });
  await check(`${tag}: ほかの手（標準の続きの見積もりの手）に切り替えると、その先は薄い行と見積もりの着いた所`, async () => {
    await goChain(page);
    const row = await openRow(page, 1);
    const stubAlt = row.locator(":scope > .dm-tl-body a.dm-alt", { hasText: "この先は標準の続きの見積もり" }).first();
    assert((await stubAlt.count()) === 1, "標準の続きの見積もりの手が無い");
    await stubAlt.click();
    await page.waitForFunction(() => document.querySelector(".dm-tl-end.is-summary"));
    const st = await pathState(page);
    assert(st.light >= 1, "標準の続きの薄い行が無い");
    assert(st.summary && st.end.includes("標準の続きの見積もり"), `着いた所が見積もりにならない: ${st.end}`);
    const end = await page.locator(".dm-tl-end").innerText();
    assert(end.includes("標準の続きの平均"), "着いた所に「標準の続きの平均」が無い");
    // 薄い行の最初は、どの地図でも「標準の選び方で続けた見積もり」（cont のある地図は見積もりの印の行と、その後に代表の手。作業メモ code-1）
    const first = await page.locator(".dm-tl-item.is-light").first().innerText();
    assert(first.includes("標準の選び方で続けた見積もり"), `薄い行の言葉が違う: ${first}`);
    const has = await page.evaluate(() => window.__deepmapPreview.has);
    if (has.cont > 0) {
      assert(first.includes("見積もり") && (await page.locator(".dm-tl-item.is-light-head").count()) === 1, "見積もりの印の行が無い");
      assert(st.light >= 2, `cont の手の薄い行が無い（${st.light}）`);
    } else assert(st.light === 1, `cont の無い地図の薄い行が 1 本ではない（${st.light}）`);
    // 見込みは標準の続きに入るまで（この道の見込みとは書かない。作業メモ truth-1）
    const figs = await page.locator(".dm-figs").innerText();
    assert(figs.includes("標準の続きに入るまでの見込み") && !figs.includes("この道の見込み") && !figs.includes("出来事の分かれが無い道"), `見込みの言葉が違う: ${figs.slice(0, 80)}`);
    await layoutChecks(page, "標準の続きの道");
    await shot(page, `path-${tag}-summary`);
  });
  await check(`${tag}: まとめた手の後の行を開くと、見積もりの印つきの文章とやること（「次の 3 か月へ」はまとめた手の行から順に）`, async () => {
    const has = await page.evaluate(() => window.__deepmapPreview.has);
    // cont の無い地図は 1 本の薄い行（開けない。前の確かめで見た）
    if (!(has.cont > 0)) return;
    // 前の確かめの道（まとめた手に切り替えた道）の続き。単独で動かすときは切り替えから
    if (!(await page.locator(".dm-tl-end.is-summary").count())) {
      await goChain(page);
      const row = await openRow(page, 1);
      await row.locator(":scope > .dm-tl-body a.dm-alt", { hasText: "この先は標準の続きの見積もり" }).first().click();
      await page.waitForFunction(() => document.querySelector(".dm-tl-end.is-summary"));
    }
    const light = page.locator(".dm-tl-item.is-light-open");
    const nLight = await light.count();
    const allLight = await page.locator(".dm-tl-item.is-light").count();
    assert(nLight >= 1 && nLight === allLight - 1, `開ける標準の続きの行の数が違う: ${nLight}（薄い行 ${allLight}）`);
    // まとめた手の行（切り替えた行）の「次の 3 か月へ」は、着いた所でなく標準の続きの最初の行へ
    const stubRow = page.locator(".dm-tl-item.is-step.is-stub").last();
    const stubHead = stubRow.locator(":scope > .dm-tl-head");
    if ((await stubHead.getAttribute("aria-expanded")) !== "true") await stubHead.click();
    await stubRow.locator(":scope > .dm-tl-body .dm-tl-next").waitFor();
    await openedRowText(stubRow, "まとめた手の行");
    const next = stubRow.locator(":scope > .dm-tl-body .dm-tl-next");
    assert((await next.innerText()).includes("見積もり"), `まとめた手の行の「次の 3 か月へ」が標準の続きへ行かない: ${await next.innerText()}`);
    const cont0 = (await page.evaluate(() => window.__deepmapPreview.text.composed)).cont;
    await next.click();
    await light.first().locator(":scope > .dm-tl-body .dm-tl-card").waitFor();
    assert((await stubHead.getAttribute("aria-expanded")) === "false", "まとめた手の行が閉じない");
    /** 開いた標準の続きの行: 見積もりの印・題・本文・やること（1〜3 つ） */
    const contCard = async (li, label) => {
      const r = await li.evaluate((el) => {
        const card = el.querySelector(":scope > .dm-tl-body .dm-tl-card");
        return {
          est: !!card?.classList.contains("is-est"),
          chip: card?.querySelector(".dm-tl-card-head .dm-tl-tag.is-est")?.textContent ?? "",
          title: card?.querySelector(".dm-tl-card-title")?.textContent ?? "",
          body: card?.querySelector(".dm-tl-text")?.textContent ?? "",
          todo: card ? card.querySelectorAll(".dm-tl-todo li").length : -1,
          all: el.innerText,
        };
      });
      assert(r.est && r.chip === "見積もり", `${label}: 見積もりの印が無い`);
      assert(r.title.trim().length >= 2, `${label}: 題が無い`);
      assert(r.body.length > 100 && !r.all.includes("文章は仮"), `${label}: 本文が 100 字以下か仮: ${r.body}`);
      assert(r.todo >= 1 && r.todo <= 3, `${label}: やることの数が違う（${r.todo}）`);
    };
    await contCard(light.first(), "標準の続きの 1 行目");
    // 標準の続きの行の「次の 3 か月へ」は次の行へ（前の行は閉じる）。最後の行の次は着いた所
    if (nLight >= 2) {
      await light.first().locator(":scope > .dm-tl-body .dm-tl-next").click();
      await light.nth(1).locator(":scope > .dm-tl-body .dm-tl-card").waitFor();
      assert((await light.first().locator(":scope > .dm-tl-head").getAttribute("aria-expanded")) === "false", "前の標準の続きの行が閉じない");
      await contCard(light.nth(1), "標準の続きの 2 行目");
    }
    const lastHead = light.last().locator(":scope > .dm-tl-head");
    if ((await lastHead.getAttribute("aria-expanded")) !== "true") await lastHead.click();
    await light.last().locator(":scope > .dm-tl-body .dm-tl-card").waitFor();
    await contCard(light.last(), "標準の続きの最後の行");
    assert((await light.last().locator(":scope > .dm-tl-body .dm-tl-next").innerText()).includes("着いた所へ"), "標準の続きの最後の行の次が着いた所ではない");
    // 組み立てたのは開いた行の分だけ
    const opened = new Set([0, nLight >= 2 ? 1 : 0, nLight - 1]).size;
    const cont1 = (await page.evaluate(() => window.__deepmapPreview.text.composed)).cont;
    assert(cont1 - cont0 === opened, `標準の続きの文章を開いた行の分だけ組み立てていない: ${cont1 - cont0}（開いた行 ${opened}）`);
    // 写真: 今日の手の行・まとめた手の行・標準の続きの行を開いた道（全体）と、標準の続きの行（画面）
    const first = page.locator(".dm-tl > .dm-tl-item.is-step").first().locator(":scope > .dm-tl-head");
    if ((await first.getAttribute("aria-expanded")) !== "true") await first.click();
    if ((await stubHead.getAttribute("aria-expanded")) !== "true") await stubHead.click();
    await layoutChecks(page, "標準の続きの行を開いた道");
    await shot(page, `path-${tag}-summary-open`);
    await light.last().locator(":scope > .dm-tl-head").evaluate((el) => el.scrollIntoView({ block: "start" }));
    await shot(page, `path-${tag}-cont-open`, false);
  });
  await check(`${tag}: 道の切り替えの時間（押してから次の画面まで・5 回）`, async () => {
    await goChain(page);
    const n0 = (await pathState(page)).switches.length;
    for (let k = 0; k < 5; k++) {
      const row = await openRow(page, 2);
      await row.locator(":scope > .dm-tl-body a.dm-alt").first().click();
      await page.waitForFunction((c) => window.__deepmapPreview.pathSwitches.length > c, n0 + k);
    }
    const sw = (await pathState(page)).switches.slice(n0);
    const med = median(sw);
    timings.push({ viewport: tag, cpu: "1x", pathSwitchMs: sw.map(r1), median: r1(med) });
    console.log(`    道の切り替え（${tag}・CPU 1 倍）: ${sw.map((x) => `${Math.round(x)}`).join("・")} ms（真ん中 ${Math.round(med)} ms）`);
    if (tag === "1440") assert(med <= 50, `道の切り替えが遅い（真ん中 ${Math.round(med)} ms > 50 ms）`);
  });
  await check(`${tag}: 行き先を押すと、その種類の道を 1 本ずつ見る`, async () => {
    await goOverview(page);
    await page.locator(".dm-row").nth(1).click();
    await page.waitForFunction(() => location.hash.startsWith("#move-"));
    const back = await page.evaluate(() => location.hash);
    await page.locator(".dm-dest-row").first().click();
    await page.waitForFunction(() => location.hash.startsWith("#path-"));
    await page.locator(".dm-tl-end").waitFor();
    const first = await page.evaluate(() => location.hash);
    const st = await pathState(page);
    assert(st.end.startsWith("2029 年 11 月"), `行き先までの道が 2029 年 11 月まで無い: ${st.end}`);
    await page.evaluate((h) => (location.hash = h), back);
    await page.locator(".dm-dest-row").first().waitFor();
    const next = await page.locator(".dm-dest-row").first().innerText();
    await page.locator(".dm-dest-row").first().click();
    await page.waitForFunction((f) => location.hash.startsWith("#path-") && location.hash !== f, first);
    assert(/次に見る道 2 \//.test(next) || /1 通りの道/.test(next), `次の番号が進まない: ${next}`);
  });
  await check(`${tag}: 年収を変えると計算し直す（見取り図と道の画面）`, async () => {
    await goOverview(page);
    const before = await page.locator(".dm-headline").innerText();
    await page.fill("#pv-annual", "540");
    await page.press("#pv-annual", "Enter");
    await page.waitForFunction((b) => document.querySelector(".dm-headline")?.textContent !== b, before);
    const msg = await page.locator(".pv-annual-msg").innerText();
    assert(msg.includes("540"), `計算し直したことが出ない: ${msg}`);
    const ms = await page.evaluate(() => window.__deepmapPreview.timings.recompute);
    timings.push({ viewport: tag, recomputeMs: r1(ms) });
    // 道の画面でも: 3 年の合計が変わり、開いた行と道はそのまま
    await goChain(page);
    await openRow(page, 2);
    const p0 = await pathState(page);
    await page.fill("#pv-annual", "360");
    await page.press("#pv-annual", "Enter");
    await page.waitForFunction((t) => document.querySelectorAll(".dm-fig-value")[1]?.textContent !== t, p0.total);
    const p1 = await pathState(page);
    assert(p1.hash === p0.hash && p1.steps[2].open, "年収を変えると道か開いた行が変わる");
    await page.fill("#pv-annual", "abc");
    await page.press("#pv-annual", "Enter");
    assert((await page.locator(".pv-annual-msg").innerText()).includes("100〜3,000"), "読めない年収の知らせが出ない");
    await page.fill("#pv-annual", "360");
    await page.press("#pv-annual", "Enter");
  });
  await check(`${tag}: 年収 540 でも、道の行の「おすすめ」の印と本文のおすすめが同じ手（作業メモ truth-1・reader-8）`, async () => {
    await goOverview(page);
    await page.fill("#pv-annual", "540");
    await page.press("#pv-annual", "Enter");
    await page.waitForFunction(() => document.querySelector(".pv-annual-msg")?.textContent?.includes("540"));
    let rows = 0;
    // 届け出て副業・届け出て Pro・遊ぶ人を増やすの一番ありそうな道（年収 540 で生成の年収の一番の手と画面のおすすめが違う判断を通る道）
    for (const slug of ["ad-permside", "sd-permpro", "sd-grow"]) {
      await page.evaluate((x) => (location.hash = `#move-${x}`), slug);
      await page.locator(".dm-fan-svg").waitFor();
      await page.locator(".dm-btn.is-primary").first().click();
      await page.waitForFunction(() => location.hash.startsWith("#path-"));
      await page.locator(".dm-tl-end").waitFor();
      const n = await page.locator(".dm-tl > .dm-tl-item.is-step").count();
      for (let k = 1; k < n; k++) {
        // 行を開く（開いた行が積み重なると、下の行の見出しは追いかける欄の下になることがあるので、要素のクリックで開く）
        const li = page.locator(".dm-tl > .dm-tl-item.is-step").nth(k);
        const head = li.locator(":scope > .dm-tl-head");
        if ((await head.getAttribute("aria-expanded")) !== "true") await head.evaluate((el) => el.click());
        await li.locator(":scope > .dm-tl-body").waitFor();
        const r = await li.evaluate((el) => {
          const body = el.querySelector(":scope > .dm-tl-body");
          const items = [...(body?.querySelectorAll(".dm-alts li") ?? [])];
          const pi = items.find((x) => x.querySelector(".dm-alt-tag.is-pi"));
          return {
            body: body?.querySelector(".dm-tl-card.is-move .dm-tl-text")?.textContent ?? "",
            pi: pi?.querySelector(".dm-alt-name")?.textContent?.trim() ?? null,
            piCurrent: !!pi?.querySelector(".dm-alt.is-current"),
          };
        });
        if (!r.pi) continue;
        rows++;
        if (r.piCurrent) assert(r.body.includes("おすすめの手"), `${slug} ${k + 1} 行目: おすすめの手の本文がおすすめと言わない: ${r.body}`);
        for (const m of r.body.matchAll(/おすすめの『([^』]*)』/g)) assert(m[1] === r.pi, `${slug} ${k + 1} 行目: 本文のおすすめ『${m[1]}』と印の『${r.pi}』が違う`);
        const more = /(?<!見積もりでは)おすすめの『[^』]*』より [\d.,]+ 万円多い/.exec(r.body);
        assert(!more, `${slug} ${k + 1} 行目: おすすめより多いと言い切る: ${more?.[0]}`);
      }
    }
    assert(rows >= 10, `確かめた行が少ない（${rows}）`);
    await page.fill("#pv-annual", "360");
    await page.press("#pv-annual", "Enter");
    await page.waitForFunction(() => document.querySelector(".pv-annual-msg")?.textContent?.includes("360"));
  });
  await check(`${tag}: 地図の深さを確かめた年収（360〜540 万円）の外では、そう知らせる（作業メモ truth-5）`, async () => {
    await goOverview(page);
    await page.fill("#pv-annual", "600");
    await page.press("#pv-annual", "Enter");
    await page.waitForFunction(() => document.querySelector(".pv-annual-msg")?.textContent?.includes("600"));
    const out = await page.locator(".pv-annual-msg").innerText();
    assert(/360〜540 万円の外/.test(out), `範囲の外の知らせが無い: ${out}`);
    await page.fill("#pv-annual", "360");
    await page.press("#pv-annual", "Enter");
    await page.waitForFunction(() => document.querySelector(".pv-annual-msg")?.textContent?.includes("360"));
    const back = await page.locator(".pv-annual-msg").innerText();
    assert(!/の外/.test(back), `範囲の中に戻しても知らせが残る: ${back}`);
    // 画面の外の見方は描くのを後回しにする（content-visibility）ので、文字は textContent で読む
    const notes = (await page.locator(".pv-notes").textContent()) ?? "";
    assert(/地図の深さは年収 360〜540 万円で確かめた/.test(notes), "見方に地図の深さを確かめた年収が無い");
  });
  await check(`${tag}: 直接ひらく（#move-… と、道の名前の #path-t…。今の地図に無い道は知らせて見取り図）`, async () => {
    const p2 = await s.ctx.newPage();
    await p2.goto(`${BASE}#move-ind-quit`);
    await p2.waitForFunction(() => window.__deepmapPreview?.visible);
    await p2.locator(".dm-fan-svg").waitFor();
    assert((await p2.locator("#pv-main .dm-h2").first().innerText()).includes("辞めて独立する"), "#move-ind-quit で手の詳しい画面にならない");
    // 今日から一番ありそうな道のリンク（道の名前）で直接ひらく
    await p2.goto(`${BASE}#overview`);
    await p2.waitForFunction(() => window.__deepmapPreview?.visible);
    const href = await p2.locator(".dm-today a.dm-btn").first().getAttribute("href");
    assert(/^#path-t[0-9a-z]+$/.test(href ?? ""), `道のリンクが道の名前でない: ${href}`);
    const p3 = await s.ctx.newPage();
    await p3.goto(`${BASE}${href}`);
    await p3.waitForFunction(() => window.__deepmapPreview?.visible);
    await p3.locator(".dm-tl-end").waitFor();
    assert((await p3.locator(".dm-tl-item.is-step").count()) === 12, `${href} で 12 行の道にならない`);
    // 前の版の番号の道・今の地図に無い名前: 見取り図と知らせ（作業メモ code-2）
    for (const h of ["#path-0", "#path-tzzzzzzzz"]) {
      await p3.goto(`${BASE}${h}`);
      await p3.waitForFunction(() => window.__deepmapPreview?.visible);
      await p3.locator(".pv-notice").waitFor();
      assert((await p3.locator(".pv-notice").innerText()).includes("今の地図には無い"), `${h} の知らせが無い`);
      assert((await p3.locator(".dm-row").count()) === 10, `${h} で見取り図にならない`);
    }
    await p3.close();
    await p2.close();
  });
  await check(`${tag}: コンソールにエラーが無い`, async () => {
    assert(errors.length === 0, errors.join("\n"));
  });
  await s.ctx.close();
}

// 公開のときに骨組みが足す小さな初期化（color-scheme: light・body の文字）でも、暗い見た目のまま
await check("骨組みの初期化（color-scheme: light）でも暗い見た目", async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${BASE}host#overview`);
  await page.waitForFunction(() => window.__deepmapPreview?.visible, null, { timeout: 60_000 });
  const c = await page.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, scheme: getComputedStyle(document.documentElement).colorScheme, fg: getComputedStyle(document.body).color }));
  assert(c.bg === "rgb(7, 9, 13)" && c.scheme === "dark", `暗い見た目にならない: ${JSON.stringify(c)}`);
  assert(errors.length === 0, errors.join("\n"));
  await ctx.close();
});

// 読み込みの時間（3 回の一番速い物）: 開き始めから見取り図が描かれた次の画面まで（performance の 0 から。この画面で押せる）。
// 1440×900（CPU そのまま）と、CPU を 4 倍遅くした 390×844（スマホの見立て）。同梱データのページは最初に役に立つ画面（見取り図）の
// 予算 0.8 秒・3 秒（作業メモ SPEC v1 §7.2）。開発用の木（大きな JSON をほどく。開発で確かめる用）は押せるまでの予算 1.5 秒・5 秒
await check("読み込みの時間（3 回の一番速い物）と、スマホの見立てでの道の切り替え", async () => {
  for (const [vp, rate, limit] of [
    [{ width: 1440, height: 900 }, 1, IS_BUNDLE ? 800 : 1500],
    [{ width: 390, height: 844 }, 4, IS_BUNDLE ? 3000 : 5000],
  ]) {
    let best = null;
    const runs = [];
    for (let k = 0; k < 3; k++) {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, isMobile: vp.width < 600, hasTouch: vp.width < 600 });
      const page = await ctx.newPage();
      if (rate > 1) await (await ctx.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate });
      await page.goto(BASE);
      await page.waitForFunction(() => window.__deepmapPreview?.visible, null, { timeout: 60_000 });
      const t = await page.evaluate(() => window.__deepmapPreview.timings);
      runs.push(Math.round(t.visible));
      if (!best || t.visible < best.visible) best = Object.fromEntries(Object.entries(t).map(([a, b]) => [a, Math.round(b)]));
      // スマホの見立てでの道の切り替え（3 回目だけ・知らせるだけ）
      if (rate > 1 && k === 2) {
        await page.locator(".dm-today a.dm-btn").first().click();
        await page.locator(".dm-tl-end").waitFor();
        for (let j = 0; j < 3; j++) {
          const row = await openRow(page, 1);
          await row.locator(":scope > .dm-tl-body a.dm-alt").first().click();
          await page.waitForFunction((c) => window.__deepmapPreview.pathSwitches.length > c, j);
        }
        const sw = await page.evaluate(() => window.__deepmapPreview.pathSwitches);
        timings.push({ viewport: "390x844", cpu: "4x", pathSwitchMs: sw.map(r1), median: r1(median(sw)) });
        console.log(`    道の切り替え（390×844・CPU 4 倍）: ${sw.map((x) => `${Math.round(x)}`).join("・")} ms`);
      }
      await ctx.close();
    }
    timings.push({ viewport: `${vp.width}x${vp.height}`, cpu: `${rate}x`, visibleMs: runs, best3: best });
    console.log(`    ${vp.width}×${vp.height}・CPU ${rate} 倍: 見取り図まで ${runs.join("・")} ms（一番速い ${best.visible} ms: ほどく ${best.decode}・組み直し ${best.compile}・計算 ${best.analyze}・描く ${best.render}）`);
    assert(best.visible <= limit, `${vp.width}×${vp.height}（CPU ${rate} 倍）で ${best.visible} ms かかる（上限 ${limit} ms）`);
  }
});

// DecompressionStream の無いブラウザ（古い Safari など）: 同梱データは小さな伸長（src/demo/inflate.ts）で開く。開発用の木は、はっきりした言葉で止まる
await check(IS_BUNDLE ? "圧縮をほどけないブラウザでも、同梱データは小さな伸長で開く" : "圧縮をほどけないブラウザでは、訳を出して止まる", async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(() => {
    delete window.DecompressionStream;
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE);
  if (IS_BUNDLE) {
    await page.waitForFunction(() => window.__deepmapPreview?.visible || window.__deepmapPreview?.error, null, { timeout: 60_000 });
    const r = await page.evaluate(() => ({ error: window.__deepmapPreview.error, ds: typeof window.DecompressionStream, decode: window.__deepmapPreview.timings.decode }));
    assert(r.ds === "undefined", "DecompressionStream が消えていない");
    assert(!r.error, `開けない: ${r.error}`);
    assert((await page.locator(".dm-row").count()) === 10, "見取り図の 10 行が出ない");
    assert(errors.length === 0, errors.join("\n"));
    console.log(`    小さな伸長でほどいて読む時間: ${Math.round(r.decode)} ms`);
  } else {
    await page.waitForFunction(() => window.__deepmapPreview?.error);
    const t = await page.locator(".pv-error").innerText();
    assert(t.includes("圧縮したデータを開けない"), `訳が出ない: ${t}`);
  }
  await ctx.close();
});

await browser.close();
server.close();
fs.appendFileSync(path.join(path.dirname(SHOTS), "timings-preview.jsonl"), JSON.stringify({ at: new Date().toISOString(), page: PAGE, timings }) + "\n");
console.log("時間:", JSON.stringify(timings));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 件 OK${failed.length ? `（失敗: ${failed.map((f) => f.name).join("、")}）` : ""}`);
process.exit(failed.length ? 1 : 0);
