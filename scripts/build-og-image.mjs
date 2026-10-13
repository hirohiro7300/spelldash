// og-image（SNS などに貼られたときの絵。1200×630 の PNG）を作り直す。
//   node scripts/build-og-image.mjs            → assets/images/og-image.png を上書き（全ページの og:image が指すファイル。URL は変えない）
//   node scripts/build-og-image.mjs --out x.png → 別の場所に書く（見比べる用）
// 型は scripts/og-image.html（色は css/tokens.css、字は css/fonts.css の自前のフォント）。このスクリプトは木をその場で配る小さな
// サーバーを立て、Chromium（CHROME_PATH、無ければ Playwright の置き場）で 1200×630・倍率 1 で撮る。自前のフォントが 3 つとも
// 読めていなければ撮らずに止める（代わりの書体で撮った絵を書かない）。大きさの目安は 300KB 以下（超えたら止める）。
// 中身を変えたら型を直してこれを流し、絵を目で確かめてからコミットする。

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright-core";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = "/scripts/og-image.html";
const DEFAULT_OUT = path.join(ROOT, "assets", "images", "og-image.png");
const WIDTH = 1200;
const HEIGHT = 630;
const MAX_BYTES = 300 * 1024;
// 型が使う書体（fonts.css の family 名・太さ）と、その書体で描く字。どれかが読めていなければ止める
const FONTS = [
  ['600 84px "Cormorant Garamond"', "SpellDash"],
  ['500 50px "Shippori Mincho"', "日本語の訳を見て、英単語を思い出して打つ。りんご"],
  ['500 66px "IBM Plex Mono"', "app"]
];

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2", ".webp": "image/webp", ".png": "image/png", ".svg": "image/svg+xml" };

function findChromium() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const root of [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers", path.join(process.env.HOME ?? "", ".cache", "ms-playwright")]) {
    if (!root || !fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root).filter((d) => d.startsWith("chromium"))) {
      for (const sub of ["chrome-linux/chrome", "chrome-linux64/chrome"]) {
        const p = path.join(root, dir, sub);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  throw new Error("Chromium が見つからない。CHROME_PATH を設定する");
}

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

const args = process.argv.slice(2);
const outArg = args.indexOf("--out");
const OUT = outArg >= 0 ? path.resolve(args[outArg + 1]) : DEFAULT_OUT;

const server = await serve();
const browser = await chromium.launch({ executablePath: findChromium() });
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("requestfailed", (r) => errors.push(`読めない: ${r.url()}`));
  page.on("response", (r) => { if (r.status() >= 400) errors.push(`${r.status()}: ${r.url()}`); });
  await page.goto(`http://127.0.0.1:${server.address().port}${TEMPLATE}`, { waitUntil: "networkidle" });
  // 使う字のサブセットを読ませてから確かめる（unicode-range で分かれた明朝は、描いた字のぶんだけ読まれる）
  const fonts = await page.evaluate(async (list) => {
    await Promise.all(list.map(([font, text]) => document.fonts.load(font, text)));
    await document.fonts.ready;
    return list.map(([font, text]) => [font, document.fonts.check(font, text)]);
  }, FONTS);
  const missing = fonts.filter(([, ok]) => !ok).map(([font]) => font);
  if (missing.length || errors.length) throw new Error(`撮らずに止めた: ${[...missing.map((f) => `書体が読めていない ${f}`), ...errors].join(" / ")}`);
  const size = await page.evaluate(() => { const r = document.querySelector(".og").getBoundingClientRect(); return [r.width, r.height]; });
  if (size[0] !== WIDTH || size[1] !== HEIGHT) throw new Error(`型の大きさが ${WIDTH}×${HEIGHT} でない: ${size.join("×")}`);
  const png = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
  if (png.length > MAX_BYTES) throw new Error(`PNG が ${Math.round(png.length / 1024)}KB（目安 ${MAX_BYTES / 1024}KB 以下）。型の質感・勾配を減らす`);
  fs.writeFileSync(OUT, png);
  console.log(`${path.relative(ROOT, OUT) || OUT}: ${WIDTH}×${HEIGHT}・${Math.round(png.length / 1024)}KB`);
} finally {
  await browser.close();
  server.close();
}
