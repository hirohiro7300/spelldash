// og-image（SNS などに貼られたときの絵。1200×630 の PNG）を作り直す。
//   node scripts/build-og-image.mjs            → assets/images/og-image.png を上書き（全ページ共通の絵。ファイル名は変えない）
//   node scripts/build-og-image.mjs --out x.png → 別の場所に書く（見比べる用。--page とも使える）
//   node scripts/build-og-image.mjs --page typing（typing-game）→ ページごとの絵 assets/images/og-<名前>.png（型は scripts/og-image-page.html、
//     背景は scripts/og-art/<名前>.webp。そのページの og:image だけが指す）
// 絵を変えたら版を上げる（SNS は絵を URL で覚える。どちらもファイル名は変えない）:
//   - 共通の絵: og:image の og-image.png?v=N を全ページ（packs は scripts/build-pack-pages.mjs）と tests/e2e.mjs の頭の OG_URL で 1 つ上げる
//   - ページごとの絵（--page）: そのページの og:image の og-<名前>.png?v=N と tests/e2e.mjs の頭の OG_PAGES だけを 1 つ上げる（共通の絵の版は上げない）
// 型は scripts/og-image.html・scripts/og-image-page.html（共通の部品は scripts/og-shared.css。色は css/tokens.css、字は css/fonts.css の自前のフォント）。
// このスクリプトは木をその場で配る小さなサーバーを立て、Chromium（CHROME_PATH、無ければ Playwright の置き場）で 1200×630・倍率 1 で撮る。
// 撮らずに止めるとき: 使う書体が読めていない（共通の型は 3 書体〔Cormorant・明朝・Plex Mono〕、ページごとの型は 2 書体〔Cormorant・明朝〕）・
// 読めないファイルがある・型が 1200×630 でない・PNG が 300KB を超える。ページごとの型ではさらに、型にそのページの中身が無い・
// 背景の絵が描かれていない（読めても絵として開けない・型が背景に使っていない）・題が 1 行に収まらない・題と説明の右端が 720px を超える（絵にかかる）。
// 中身を変えたら型を直してこれを流し、絵を目で確かめてからコミットする。

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright-core";
import { findChromium } from "./lib/canvas-art.mjs";
import { isMain } from "./lib/is-main.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEMPLATE = "/scripts/og-image.html";
const DEFAULT_OUT = path.join(ROOT, "assets", "images", "og-image.png");
const WIDTH = 1200;
const HEIGHT = 630;
const MAX_BYTES = 300 * 1024;
// ページごとの型: 題と説明の右端の上限（背景の絵の主役は右側。左 55% を空けた絵）
export const TEXT_RIGHT_MAX = 720;

// ページごとの型の見え方を型の中で調べる（tests/e2e.mjs も同じ関数を使う）: 背景の絵が型の背景に使われ、絵として開けて 1200×800 か、
// 題が 1 行か、題と説明の字の右端（字そのものの幅。箱の幅ではない）
export async function ogPageLook(name) {
  const og = document.querySelector(".og");
  const art = `og-art/${name}.webp`;
  const used = getComputedStyle(og).backgroundImage.includes(art);
  let decoded = false;
  let artNote = used ? "" : "型が背景に使っていない";
  if (used) {
    try {
      const img = new Image();
      img.src = art;
      await img.decode();
      decoded = img.naturalWidth === 1200 && img.naturalHeight === 800;
      if (!decoded) artNote = `大きさが ${img.naturalWidth}×${img.naturalHeight}`;
    } catch {
      artNote = "絵として開けない";
    }
  }
  const extent = (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = [...range.getClientRects()];
    return { right: Math.max(0, ...rects.map((r) => r.right)), lines: new Set(rects.map((r) => Math.round(r.top))).size };
  };
  const title = extent(document.querySelector(".og__title"));
  const sub = extent(document.querySelector(".og__sub"));
  return { artDrawn: used && decoded, artNote, titleLines: title.lines, textRight: Math.max(title.right, sub.right) };
}
// 型が使う書体（fonts.css の family 名・太さ）と、その書体で描く字。どれかが読めていなければ止める
const FONTS = [
  ['600 84px "Cormorant Garamond"', "SpellDash"],
  ['500 50px "Shippori Mincho"', "日本語の訳を見て、英単語を思い出して打つ。りんご"],
  ['500 66px "IBM Plex Mono"', "app"]
];

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2", ".webp": "image/webp", ".png": "image/png", ".svg": "image/svg+xml" };

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// 直接呼ばれたときだけ撮る（tests/e2e.mjs が ogPageLook・TEXT_RIGHT_MAX を読むために import しても撮らない）
if (isMain(import.meta.url)) await main();

async function main() {
  const args = process.argv.slice(2);
  const outArg = args.indexOf("--out");
  const pageArg = args.indexOf("--page");
  const PAGE = pageArg >= 0 ? args[pageArg + 1] : null;
  if (pageArg >= 0 && !/^[a-z-]+$/.test(PAGE ?? "")) throw new Error("--page の名前は英小文字とハイフンだけ（typing・typing-game）");
  const OUT = outArg >= 0 ? path.resolve(args[outArg + 1]) : PAGE ? path.join(ROOT, "assets", "images", `og-${PAGE}.png`) : DEFAULT_OUT;
  const URL_PATH = PAGE ? `/scripts/og-image-page.html?page=${PAGE}` : TEMPLATE;

  const server = await serve();
  const browser = await chromium.launch({ executablePath: findChromium() });
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("requestfailed", (r) => errors.push(`読めない: ${r.url()}`));
    page.on("response", (r) => { if (r.status() >= 400) errors.push(`${r.status()}: ${r.url()}`); });
    await page.goto(`http://127.0.0.1:${server.address().port}${URL_PATH}`, { waitUntil: "networkidle" });
    // ページごとの型は、そのページの題と説明の字で書体を確かめる（Plex Mono は使わない）
    let fontList = FONTS;
    if (PAGE) {
      const pageText = await page.evaluate(() => ({ known: document.querySelector(".og").dataset.page, text: document.querySelector(".og__title").textContent + document.querySelector(".og__sub").textContent }));
      if (pageText.known !== PAGE) throw new Error(`型に ${PAGE} の中身が無い（scripts/og-image-page.html の PAGES）`);
      fontList = [FONTS[0], ['500 72px "Shippori Mincho"', pageText.text]];
    }
    // 使う字のサブセットを読ませてから確かめる（unicode-range で分かれた明朝は、描いた字のぶんだけ読まれる）
    const fonts = await page.evaluate(async (list) => {
      await Promise.all(list.map(([font, text]) => document.fonts.load(font, text)));
      await document.fonts.ready;
      return list.map(([font, text]) => [font, document.fonts.check(font, text)]);
    }, fontList);
    const missing = fonts.filter(([, ok]) => !ok).map(([font]) => font);
    if (missing.length || errors.length) throw new Error(`撮らずに止めた: ${[...missing.map((f) => `書体が読めていない ${f}`), ...errors].join(" / ")}`);
    const size = await page.evaluate(() => { const r = document.querySelector(".og").getBoundingClientRect(); return [r.width, r.height]; });
    if (size[0] !== WIDTH || size[1] !== HEIGHT) throw new Error(`型の大きさが ${WIDTH}×${HEIGHT} でない: ${size.join("×")}`);
    if (PAGE) {
      const look = await page.evaluate(ogPageLook, PAGE);
      if (!look.artDrawn) throw new Error(`撮らずに止めた: 背景の絵 scripts/og-art/${PAGE}.webp が描かれていない（${look.artNote}）`);
      if (look.titleLines !== 1) throw new Error(`撮らずに止めた: 題が 1 行に収まらない（${look.titleLines} 行）`);
      if (look.textRight > TEXT_RIGHT_MAX) throw new Error(`撮らずに止めた: 題と説明の右端が ${Math.round(look.textRight)}px（${TEXT_RIGHT_MAX}px 以下。絵にかかる）`);
    }
    const png = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
    if (png.length > MAX_BYTES) throw new Error(`PNG が ${Math.round(png.length / 1024)}KB（目安 ${MAX_BYTES / 1024}KB 以下）。型の質感・勾配を減らす`);
    fs.writeFileSync(OUT, png);
    console.log(`${path.relative(ROOT, OUT) || OUT}: ${WIDTH}×${HEIGHT}・${Math.round(png.length / 1024)}KB`);
  } finally {
    await browser.close();
    server.close();
  }
}
