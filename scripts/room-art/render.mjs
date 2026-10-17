// 場面（窓・窓辺のはちゃん・壁の額と棚・机の奥の道具・壁に落ちる影）を 2x の WebP に焼く。
// 使い方:
//   node scripts/room-art/render.mjs          → assets/images/room/scene-{phone,short,desk}-{light,dark}.webp
//   node scripts/room-art/render.mjs --check  → 書かずに、焼き直した 6 枚が木の 6 枚とバイト単位で同じかを見る（違えば終了コード 1）
// 背景は透明（壁・光の溜まり・机・本・本棚は CSS と DOM のまま）。テーマごとに 1 枚、CSS が [data-theme] と prefers-color-scheme で切り替える。
// 窓辺のはちゃんは scripts/room-art/figure-reading.webp（創業者が用意した絵 010 を scripts/build-hasumi.mjs が切り出した物。scripts/ はデプロイしない）。
//   絵を替えたら build-hasumi.mjs（--src）が切り出しから場面の焼き直しまで通す。窓・小物・置き方・昼夜の色の寄せだけ直したときはこの台本だけでよい。
// 書き出しは PIL（品質 80／desk 72・透過の品質 80／desk 66・method 6）。同じ元から焼き直すとバイト単位で同じ。
// 上限（1 枚でも超えたら 1 枚も書かずに止める）: SCENE_MAX_BYTES。E2E（4 ホーム・8.6 書斎は表示中の 1 枚、8.65 はちゃんの絵は 6 枚）はこの値を import して見る
// （import しただけでは Chromium を立ち上げない）。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { chromium } from "playwright-core";
import { defs, compose, SCENES } from "./scene.mjs";
import { sceneLight, sceneDark, toCss } from "./tokens.mjs";
import { findChromium, webpSize, webpAlpha } from "../lib/canvas-art.mjs";
import { isMain } from "../lib/is-main.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SCENE_DIR = "assets/images/room";
export const FIGURE_FILE = "scripts/room-art/figure-reading.webp";
// 1 枚の上限（表示する 1 枚だけ読む。表示 1 回の画像の予算 260KB は E2E 8.6・scripts/room-budget.mjs）
export const SCENE_MAX_BYTES = { phone: 40 * 1024, short: 32 * 1024, desk: 50 * 1024 };
const QUALITY = { phone: [80, 80], short: [80, 80], desk: [72, 66] };
export const sceneFiles = () => Object.keys(SCENES).flatMap((name) => ["light", "dark"].map((theme) => ({ name, theme, rel: `${SCENE_DIR}/scene-${name}-${theme}.webp` })));

const html = (theme, svg) => `<!doctype html><html><head><style>
  html,body{margin:0;background:transparent}
  :root{${toCss(theme === "dark" ? sceneDark : sceneLight)}}
  .lt-${theme === "dark" ? "day" : "night"}{display:none}
  svg.scene{display:block}
</style></head><body><svg width="0" height="0" style="position:absolute"><defs>${defs()}</defs></svg>${svg}</body></html>`;

// PNG（画面写し）→ WebP（PIL）。標準入力と標準出力で渡す（一時ファイルを作らない）
function encode(png, name) {
  const [q, aq] = QUALITY[name];
  return execFileSync("python3", ["-I", "-c", `import sys, io
from PIL import Image
im = Image.open(io.BytesIO(sys.stdin.buffer.read()))
out = io.BytesIO()
im.save(out, "WEBP", quality=${q}, method=6, alpha_quality=${aq})
sys.stdout.buffer.write(out.getvalue())`], { input: png, maxBuffer: 64 * 1024 * 1024 });
}

// 窓辺の絵の WebP → compose に渡す形（data URL と縦横比）。幅と高さは最初の塊（12 バイト目）の頭（webpSize）。
// 透過の絵なので透過も見る（webpAlpha: VP8X の透過の印と ALPH の塊など。不透明の VP8・印の無い VP8X は止める）
export function figureOf(buf) {
  const size = webpSize(buf);
  if (!size) throw new Error("窓辺の絵が WebP ではない");
  if (!webpAlpha(buf)) throw new Error("窓辺の絵に透過が無い（VP8X の透過の印と ALPH の塊、または透過のある VP8L が要る）");
  const [w, h] = size;
  return { href: `data:image/webp;base64,${buf.toString("base64")}`, aspect: h / w, w, h };
}

// 6 枚を焼く（書かない）。戻り値: [{ rel, name, theme, buf, max }]
export async function bakeScenes(browser, figureBuf, { place } = {}) {
  const figure = figureOf(figureBuf);
  const out = [];
  for (const { name, theme, rel } of sceneFiles()) {
    const cfg = SCENES[name];
    const [W, H] = cfg.vb;
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    const errs = [];
    p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    await p.setContent(html(theme, compose(cfg, figure, place).svg));
    await p.evaluate(() => Promise.all([...document.querySelectorAll("image")].map((i) => i.decode?.().catch(() => {}))));
    await p.waitForTimeout(250);
    const png = await p.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: W, height: H } });
    await ctx.close();
    if (errs.length) throw new Error(`${rel}: ${errs.join(" | ")}`);
    out.push({ rel, name, theme, buf: encode(png, name), max: SCENE_MAX_BYTES[name] });
  }
  return out;
}

// 書く／比べる。上限は書く前に全部を見る（1 枚でも超えたら何も書かない）。check: 書かずに木のファイルとバイト単位で比べ、違う物の数を返す
export function writeOrCheck(files, { check = false, root = ROOT } = {}) {
  const over = files.filter((f) => f.max && f.buf.length > f.max);
  if (over.length) throw new Error(`上限を超えた（何も書いていない）: ${over.map((f) => `${f.rel} ${f.buf.length}B > ${f.max}B`).join("・")}`);
  let diff = 0;
  for (const f of files) {
    const file = path.join(root, f.rel);
    if (check) {
      const same = fs.existsSync(file) && fs.readFileSync(file).equals(f.buf);
      if (!same) diff++;
      console.log(`${same ? "同じ" : "違う"} ${f.rel} ${f.buf.length}B${same ? "" : `（木 ${fs.existsSync(file) ? fs.statSync(file).size + "B" : "無し"}）`}`);
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, f.buf);
      console.log(`${f.rel} ${f.buf.length}B（${(f.buf.length / 1024).toFixed(1)}KB${f.max ? ` / 上限 ${f.max / 1024}KB` : ""}）`);
    }
  }
  return diff;
}

async function main() {
  const check = process.argv.includes("--check");
  const browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox"] });
  try {
    const files = await bakeScenes(browser, fs.readFileSync(path.join(ROOT, FIGURE_FILE)));
    const diff = writeOrCheck(files, { check });
    if (check && diff) {
      console.error(`焼き直した場面が ${diff} 枚 木と違う（node scripts/room-art/render.mjs で焼き直してコミットする）`);
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

// 直接呼ばれたときだけ焼く（build-hasumi.mjs・tests/e2e.mjs が bakeScenes・SCENE_MAX_BYTES を読むために import しても Chromium を立ち上げない）
if (isMain(import.meta.url)) await main();
