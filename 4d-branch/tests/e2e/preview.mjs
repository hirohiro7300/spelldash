// 試し版（3 年の分かれ道）の E2E（node scripts/build-preview.mjs の後に node tests/e2e/preview.mjs [ページ] [写真の置き場]）
// 公開のときと同じ骨組みと CSP で包み、390×844（スマホ）と 1440×900 で開いて確かめる:
//   読み込める・横にはみ出さない・押す所は 44px 以上・英字の鍵が画面に出ない・コンソールにエラーが無い・
//   見取り図 → 手の詳しい画面 → 一番ありそうな道 → 戻る・年収を変えると計算し直す・扇の縦線の札
// 写真（deviceScaleFactor 1）は overview-*.png として置き場に残す。読み込みの時間も残す。
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright-core";

const SCRATCH = "/tmp/claude-0/-home-user-spelldash/342dd9ca-ed44-551f-af59-60da8aff2834/scratchpad/deepmap/view";
const PAGE = path.resolve(process.argv[2] || process.env.DEEPMAP_PREVIEW_OUT || path.join(SCRATCH, "preview.html"));
const SHOTS = path.resolve(process.argv[3] || process.env.DEEPMAP_PREVIEW_SHOTS || path.join(SCRATCH, "shots"));
if (!fs.existsSync(PAGE)) throw new Error(`${PAGE} がありません。先に node scripts/build-preview.mjs を実行してください`);
fs.mkdirSync(SHOTS, { recursive: true });

// 公開のときの骨組み（文字コード・viewport・小さな初期化。tests/e2e/artifact.mjs と同じ）
const SKELETON_HEAD =
  '<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style></head><body>';
const html = `${SKELETON_HEAD}${fs.readFileSync(PAGE, "utf8")}</body></html>`;
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:" });
  res.end(html);
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;

const results = [];
async function check(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`  ✗ ${name}\n      ${String(e?.stack || e).split("\n").slice(0, 4).join("\n      ")}`);
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m);
};

/** 画面に出ている文字に、英字の鍵（手の種類・結果・事実の鍵）が無いか */
const ID_RE = /\b(?:ad|sd|fc|ind|back)_[a-z0-9_]+\b|\b[a-z]+_[a-z0-9]+(?:_[a-z0-9]+)*\b|\bpm:\d+\b|\b(?:keep|stub|sum|undefined|null|NaN)\b/;

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const timings = [];

async function open(viewport, mobile) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  const t0 = Date.now();
  await page.goto(BASE);
  await page.waitForFunction(() => window.__deepmapPreview?.ready || window.__deepmapPreview?.error, null, { timeout: 60_000 });
  const wall = Date.now() - t0;
  const info = await page.evaluate(() => window.__deepmapPreview);
  assert(!info.error, `読み込めない: ${info.error}`);
  timings.push({ viewport: `${viewport.width}x${viewport.height}`, wallMs: wall, ...Object.fromEntries(Object.entries(info.timings).map(([k, v]) => [k, Math.round(v * 10) / 10])) });
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

async function shot(page, name, full = true) {
  await page.screenshot({ path: path.join(SHOTS, `overview-${name}.png`), fullPage: full });
}

for (const [vp, mobile, tag] of [
  [{ width: 390, height: 844 }, true, "390"],
  [{ width: 1440, height: 900 }, false, "1440"],
]) {
  console.log(`— ${tag}`);
  let s = null;
  await check(`${tag}: 読み込んで見取り図を出す`, async () => {
    s = await open(vp, mobile);
    const rows = await s.page.locator(".dm-row").count();
    assert(rows === 10, `見取り図の行が 10 ではない: ${rows}`);
    const first = await s.page.locator(".dm-row").first().innerText();
    assert(/分かれ道/.test(first) && /万円/.test(first), `行に分かれ道と万円が無い: ${first}`);
    await shot(s.page, `${tag}-top`, false);
    await shot(s.page, tag);
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
  await check(`${tag}: 手の詳しい画面（扇・分かれ道の帯・進め方・行き先）`, async () => {
    await page.locator(".dm-row").first().click();
    await page.waitForFunction(() => location.hash.startsWith("#move-"));
    await page.locator(".dm-fan-svg").waitFor();
    assert((await page.locator(".dm-strip-col").count()) >= 10, "分かれ道の帯の列が足りない");
    assert((await page.locator(".dm-plan-row").count()) >= 10, "進め方の行が足りない");
    assert((await page.locator(".dm-dest-row").count()) >= 3, "行き先の行が足りない");
    await layoutChecks(page, "手の詳しい画面");
    await shot(page, `move-${tag}`);
  });
  await check(`${tag}: 扇の縦線の札（指・マウス・キーボード）`, async () => {
    const plot = page.locator(".dm-fan-plot");
    await plot.scrollIntoViewIfNeeded();
    const b = await plot.boundingBox();
    await page.mouse.move(b.x + b.width * 0.55, b.y + b.height * 0.5);
    await page.locator(".dm-tip:not([hidden])").waitFor({ timeout: 3000 });
    const tip = await page.locator(".dm-tip").innerText();
    assert(/万円/.test(tip) && /月の稼ぎ/.test(tip), `札に数が無い: ${tip}`);
    await shot(page, `fan-${tag}`, false);
    await plot.focus();
    await page.keyboard.press("Home");
    const t0 = await page.locator(".dm-tip").innerText();
    assert(/今日/.test(t0), `Home で今日に行かない: ${t0}`);
    await page.keyboard.press("Escape");
  });
  await check(`${tag}: 扇を「まとめて」に切り替える`, async () => {
    const btn = page.locator(".dm-seg-btn", { hasText: "まとめて" });
    if (!(await btn.count())) return;
    await btn.click();
    assert((await btn.getAttribute("aria-pressed")) === "true", "まとめてが押された様子にならない");
    assert((await page.locator(".dm-legend li").first().innerText()).includes("この手の後"), "凡例が全体にならない");
    await page.locator(".dm-seg-btn", { hasText: "答えごと" }).click();
  });
  await check(`${tag}: 一番ありそうな道（仮の道の画面）と戻る`, async () => {
    if (!(await page.locator(".dm-btn.is-primary").count())) {
      await goOverview(page);
      await page.locator(".dm-row").first().click();
      await page.locator(".dm-fan-svg").waitFor();
    }
    await page.locator(".dm-btn.is-primary").first().click();
    await page.waitForFunction(() => location.hash.startsWith("#path-"));
    await page.locator(".dm-path-row").first().waitFor();
    const rows = await page.locator(".dm-path-row").count();
    assert(rows >= 10, `道の行が少ない: ${rows}`);
    const title = await page.locator("#pv-main .dm-h2").first().innerText();
    assert(/一番ありそうな道（見込み [\d.]+%）/.test(title), `題名が違う: ${title}`);
    await layoutChecks(page, "道の画面");
    await shot(page, `path-${tag}`);
    await page.locator(".dm-back").click();
    await page.waitForFunction(() => location.hash.startsWith("#move-"));
    await page.locator(".dm-fan-svg").waitFor();
    await page.locator(".dm-back").click();
    await page.waitForFunction(() => location.hash === "#overview");
    await page.locator(".dm-row").first().waitFor();
    assert((await page.locator(".dm-row").count()) === 10, "見取り図に戻らない");
  });
  await check(`${tag}: 行き先を押すと、その種類の道を 1 本ずつ見る`, async () => {
    await goOverview(page);
    await page.locator(".dm-row").nth(1).click();
    await page.waitForFunction(() => location.hash.startsWith("#move-"));
    const back = await page.evaluate(() => location.hash);
    const row = page.locator(".dm-dest-row").first();
    await row.click();
    await page.waitForFunction(() => location.hash.startsWith("#path-"));
    await page.locator(".dm-path-row, .dm-path-end").first().waitFor();
    const first = await page.evaluate(() => location.hash);
    await page.evaluate((h) => (location.hash = h), back);
    await page.locator(".dm-dest-row").first().waitFor();
    const next = await page.locator(".dm-dest-row").first().innerText();
    await page.locator(".dm-dest-row").first().click();
    await page.waitForFunction((f) => location.hash.startsWith("#path-") && location.hash !== f, first);
    assert(/次に見る道 2 \//.test(next) || /1 通りの道/.test(next), `次の番号が進まない: ${next}`);
    await page.evaluate(() => (location.hash = "#overview"));
    await page.locator(".dm-row").first().waitFor();
  });
  await check(`${tag}: 年収を変えると計算し直す`, async () => {
    await goOverview(page);
    const before = await page.locator(".dm-headline").innerText();
    await page.fill("#pv-annual", "540");
    await page.press("#pv-annual", "Enter");
    await page.waitForFunction((b) => document.querySelector(".dm-headline")?.textContent !== b, before);
    const msg = await page.locator(".pv-annual-msg").innerText();
    assert(msg.includes("540"), `計算し直したことが出ない: ${msg}`);
    const ms = await page.evaluate(() => window.__deepmapPreview.timings.recompute);
    timings.push({ viewport: tag, recomputeMs: Math.round(ms * 10) / 10 });
    await page.fill("#pv-annual", "abc");
    await page.press("#pv-annual", "Enter");
    assert((await page.locator(".pv-annual-msg").innerText()).includes("100〜3,000"), "読めない年収の知らせが出ない");
    await page.fill("#pv-annual", "360");
    await page.press("#pv-annual", "Enter");
    await page.waitForFunction(() => document.querySelector(".pv-annual-msg")?.textContent?.includes("360"));
  });
  await check(`${tag}: 直接ひらく（#move-… と #path-…）`, async () => {
    const p2 = await s.ctx.newPage();
    await p2.goto(`${BASE}#move-ind-quit`);
    await p2.waitForFunction(() => window.__deepmapPreview?.ready);
    await p2.locator(".dm-fan-svg").waitFor();
    assert((await p2.locator("#pv-main .dm-h2").first().innerText()).includes("辞めて独立する"), "#move-ind-quit で手の詳しい画面にならない");
    await p2.goto(`${BASE}#path-0`);
    await p2.waitForFunction(() => window.__deepmapPreview?.ready);
    await p2.locator(".dm-path-row").first().waitFor();
    assert((await p2.locator(".dm-path-row").count()) >= 10, "#path-0 で道にならない");
    await p2.close();
  });
  await check(`${tag}: コンソールにエラーが無い`, async () => {
    assert(errors.length === 0, errors.join("\n"));
  });
  await s.ctx.close();
}

// 読み込みの時間（3 回の一番速い物）: 1440×900 と、CPU を 4 倍遅くした 390×844（スマホの見立て。作業メモ SPEC v1 §7.2）
// 予算: 見取り図が出るまで 机 ≤ 0.8 秒・スマホ（4 倍）≤ 3 秒。ほかの作業と CPU を分け合うので、落とすのは大きく超えたときだけ
await check("読み込みの時間（3 回の一番速い物）", async () => {
  for (const [vp, rate, limit] of [
    [{ width: 1440, height: 900 }, 1, 1500],
    [{ width: 390, height: 844 }, 4, 6000],
  ]) {
    let best = null;
    for (let k = 0; k < 3; k++) {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      if (rate > 1) await (await ctx.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate });
      const t0 = Date.now();
      await page.goto(BASE);
      await page.waitForFunction(() => window.__deepmapPreview?.ready, null, { timeout: 60_000 });
      const wall = Date.now() - t0;
      const t = await page.evaluate(() => window.__deepmapPreview.timings);
      if (!best || wall < best.wallMs) best = { wallMs: wall, ...Object.fromEntries(Object.entries(t).map(([a, b]) => [a, Math.round(b)])) };
      await ctx.close();
    }
    timings.push({ viewport: `${vp.width}x${vp.height}`, cpu: `${rate}x`, best3: best });
    console.log(`    ${vp.width}×${vp.height}・CPU ${rate} 倍: 見取り図まで ${best.wallMs} ms（ほどく ${best.decode}・組み直し ${best.compile}・計算 ${best.analyze}・描く ${best.render}）`);
    assert(best.wallMs <= limit, `${vp.width}×${vp.height}（CPU ${rate} 倍）で ${best.wallMs} ms かかる（上限 ${limit} ms）`);
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
