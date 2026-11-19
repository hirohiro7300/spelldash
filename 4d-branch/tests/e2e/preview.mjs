// 試し版（3 年の分かれ道）の E2E: npm run e2e:preview（= node tests/e2e/preview.mjs）
//   node tests/e2e/preview.mjs [ページ] [写真の置き場] [--no-build]
//     ページを渡さなければ、先に scripts/build-preview.mjs でページを作る（木は DEEPMAP_TREE か作業メモの r1-tree.json.gz）
//     PW_CHROMIUM でブラウザの場所を変えられる。E2E_ONLY に名前の一部を渡すと、その確かめだけ（前の状態を使う物は単独では動かない）
// 公開のときの骨組み（<!doctype html><html><head><meta charset=utf8><meta name=viewport …></head><body>ページ</body></html>）で包み、
// 外の物を読めない CSP の下で、390×844（スマホ）と 1440×900 で開いて確かめる:
//   コンソールにエラーが無い・390px で横にはみ出さない・押す所は 44px 以上・英字の鍵が画面に出ない・
//   見取り図の 10 行・手の詳しい画面と扇・2029 年 11 月（36 か月目）までの道・ほかの結果や手への切り替え（戻る・進むも）・
//   静かな期のまとめ・標準の続きの薄い行・次の 3 か月へ・年収を変えると計算し直す
// 時間（作業メモ SPEC v1 §7.2）: 開き始めから見取り図が描かれるまで（3 回の一番速い物）を 1440×900 と CPU 4 倍遅くした 390×844 で。
//   上限 机 1.5 秒・スマホ（4 倍）5 秒。道の切り替え（押してから次の画面まで）は机で 50ms 以下（真ん中の値）
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
const PAGE = path.resolve(pos[0] || process.env.DEEPMAP_PREVIEW_OUT || path.join(SCRATCH, "preview.html"));
const SHOTS = path.resolve(pos[1] || process.env.DEEPMAP_PREVIEW_SHOTS || path.join(SCRATCH, "shots"));
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
const ID_RE = /\b(?:ad|sd|fc|ind|back)_[a-z0-9_]+\b|\b[a-z]+_[a-z0-9]+(?:_[a-z0-9]+)*\b|\bpm:\d+\b|\b(?:keep|stub|sum|undefined|null|NaN)\b/;

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
  // 全体の写真は上から（追いかける欄が途中に写らないように）
  if (full) await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: full });
}

// 前の版の写真の名前（overview-move-* など）は消す（この版の名前と混ざらないように）
for (const f of fs.readdirSync(SHOTS)) if (/^overview-(move|path|fan)-/.test(f)) fs.rmSync(path.join(SHOTS, f));

for (const [vp, mobile, tag] of [
  [{ width: 390, height: 844 }, true, "390"],
  [{ width: 1440, height: 900 }, false, "1440"],
]) {
  console.log(`— ${tag}`);
  let s = null;
  await check(`${tag}: 読み込んで見取り図の 10 行を出す`, async () => {
    s = await open(vp, mobile);
    const rows = await s.page.locator(".dm-row").count();
    assert(rows === 10, `見取り図の行が 10 ではない: ${rows}`);
    const first = await s.page.locator(".dm-row").first().innerText();
    assert(/分かれ道/.test(first) && /万円/.test(first), `行に分かれ道と万円が無い: ${first}`);
    await shot(s.page, `overview-${tag}-top`, false);
    await shot(s.page, `overview-${tag}`);
  });
  if (!s) continue;
  const { page, errors } = s;
  await check(`${tag}: 見取り図の形（はみ出し・押す所・英字の鍵）`, () => layoutChecks(page, "見取り図"));
  await check(`${tag}: 見取り図の中身（数・言葉）`, async () => {
    const t = await page.locator(".dm-overview").innerText();
    for (const want of ["今やる vs 3 か月待つ", "3 年の合計", "ずっと今のままより", "この先の分かれ道", "判断", "出来事の分かれ", "見込み 1% 以上", "標準の続きの見積もり", "会社の答え", "3 年後の幅は、この手より、この先の分かれ道での選び方と運で決まる"]) assert(t.includes(want), `見取り図に「${want}」が無い`);
    const head = await page.locator(".pv-head").innerText();
    for (const want of ["3 年の分かれ道（試し版）", "時点の地図", "年収", "万円で計算", "カード", "分かれ道"]) assert(head.includes(want), `見出しに「${want}」が無い`);
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
    for (const want of ["12 月〜2 月の手", "→", "%", "月の稼ぎ", "万円", "ここまでの稼ぎ", "ほかの結果", "ほかの手"]) assert(head.includes(want), `行に「${want}」が無い: ${head}`);
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
    assert((await page.locator(".dm-tl-item.is-light").first().innerText()).includes("標準の選び方で続けた見積もり"), "薄い行の言葉が違う");
    await layoutChecks(page, "標準の続きの道");
    await shot(page, `path-${tag}-summary`);
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
  await check(`${tag}: 直接ひらく（#move-… と #path-…）`, async () => {
    const p2 = await s.ctx.newPage();
    await p2.goto(`${BASE}#move-ind-quit`);
    await p2.waitForFunction(() => window.__deepmapPreview?.visible);
    await p2.locator(".dm-fan-svg").waitFor();
    assert((await p2.locator("#pv-main .dm-h2").first().innerText()).includes("辞めて独立する"), "#move-ind-quit で手の詳しい画面にならない");
    await p2.goto(`${BASE}#path-0`);
    await p2.waitForFunction(() => window.__deepmapPreview?.visible);
    await p2.locator(".dm-tl-end").waitFor();
    assert((await p2.locator(".dm-tl-item.is-step").count()) === 12, "#path-0 で 12 行の道にならない");
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
  await page.goto(`${BASE}host#path-0`);
  await page.waitForFunction(() => window.__deepmapPreview?.visible, null, { timeout: 60_000 });
  const c = await page.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, scheme: getComputedStyle(document.documentElement).colorScheme, fg: getComputedStyle(document.body).color }));
  assert(c.bg === "rgb(7, 9, 13)" && c.scheme === "dark", `暗い見た目にならない: ${JSON.stringify(c)}`);
  assert(errors.length === 0, errors.join("\n"));
  await ctx.close();
});

// 読み込みの時間（3 回の一番速い物）: 開き始めから見取り図が描かれた次の画面まで（performance の 0 から）。
// 1440×900（CPU そのまま）と、CPU を 4 倍遅くした 390×844（スマホの見立て）。予算 1.5 秒・5 秒（作業メモ SPEC v1 §7.2）
await check("読み込みの時間（3 回の一番速い物）と、スマホの見立てでの道の切り替え", async () => {
  for (const [vp, rate, limit] of [
    [{ width: 1440, height: 900 }, 1, 1500],
    [{ width: 390, height: 844 }, 4, 5000],
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
        await page.evaluate(() => (location.hash = "#path-0"));
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

// DecompressionStream の無いブラウザ: はっきりした言葉で止まる
await check("圧縮をほどけないブラウザでは、訳を出して止まる", async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(() => {
    delete window.DecompressionStream;
  });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForFunction(() => window.__deepmapPreview?.error);
  const t = await page.locator(".pv-error").innerText();
  assert(t.includes("圧縮したデータを開けない"), `訳が出ない: ${t}`);
  await ctx.close();
});

await browser.close();
server.close();
fs.appendFileSync(path.join(path.dirname(SHOTS), "timings-preview.jsonl"), JSON.stringify({ at: new Date().toISOString(), page: PAGE, timings }) + "\n");
console.log("時間:", JSON.stringify(timings));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 件 OK${failed.length ? `（失敗: ${failed.map((f) => f.name).join("、")}）` : ""}`);
process.exit(failed.length ? 1 : 0);
