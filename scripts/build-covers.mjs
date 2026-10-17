// 教材の小さな表紙（「本を足す」「本をさがす」の窓の行の左。js/covers.js・css/bookshelf.css .finder__cov）の絵を作る。
// 絵は創業者が用意した表紙（1024×1536 の PNG・背景透過・文字なし）。配信するのは assets/images/covers/<name>.webp だけで、
// 元の PNG はリポジトリに入れない（1 枚 3MB 前後。作り直すときは元の絵の置き場を渡す。scripts/build-emblems.mjs と同じ作法）。
//
// 使い方:
//   node scripts/build-covers.mjs --src <dir> [--sheet <png>] [--asis] [--out <dir>]
//       <dir>/<番号>-<名前>.png（下の COVERS）から assets/images/covers/<name>.webp を書く。
//       --sheet を添えると、配信する絵を昼と夜の羊皮紙の地に、表示の大きさ（1 倍・2 倍）と元の表紙の切り出す枠を並べた絵を書く（目で見る用）
//       --asis は色の寄せ（GRADE と TUNE）を掛けずに作る（元の色と見比べる用。配信する絵にはしない: --out <作業用のフォルダ> が要り、
//       既定の書き先と同じ所〔末尾の /・..・symlink を挟んだ別の書き方も〕なら止まる）
//       --out は書き先（既定 assets/images/covers）。既定の所では、表（COVERS）に無い名前の .webp を、名前を出してから消す（名前を替えた表紙の
//       前の絵を残さない）。ほかの書き先では、表の 22 枚を書くだけで、ほかの物は消さない（--out assets/images/room でも場面・タイルは残る）
//   node scripts/build-covers.mjs --check --src <dir> [--sheet <png>]
//       同じ元から作り直して、木の絵とバイト単位で同じかを見る（違えば exit 1。--sheet の並べた絵のほかは何も書かない）
// 引数の誤り（値の無い --src・--out・--sheet、-- で始まる値〔--out --asis〕、同じ引数が 2 つ、知らない引数〔--out=x の形・書き違い〕）と、
// 書けない書き先（途中にファイルがある・--sheet がフォルダ・--out がファイル）は、Chromium を立ち上げる前に止まる（何も書かず、消さない）。
// 無い書き先のフォルダ（--out・--sheet）は、絵を作り終えてから、書く直前に作る（途中で止まった回はフォルダも残さない）
//
// 配信する絵（1 種類）: 幅 48 × 高さ 64（3:4 の縦長）。窓の行の表示は 24×32 CSS px（360〜599px の幅では 21×28）。表示の 2 倍の画素。不透明。
//   表紙の全体ではなく、絵のある下の部分を縦長に切り出す（表紙の上 4 割は題の余白で、30px に縮めると色の札になる。審査の条件 1）。
//   切り出す枠は表紙の不透明な外接矩形に対する割合（CROP_DEFAULT と、絵の中心がずれた表紙の CROP）。
//   角は CSS の border-radius で丸める。不透明にするのは、透過を残すと Chromium の WebP が 2 倍前後に重くなるから。
// 色: 部屋の色（藍・胡桃・羊皮紙・真鍮。docs/DESIGN.md）に寄せる処理を全部の表紙に掛け（GRADE）、色の決まりとぶつかる表紙
//   （緑の地・光る物。docs/CONCEPT.md・DESIGN.md: 緑は使わない・光るのは炎だけ）は追加で寄せる（TUNE。1 か所の表。
//   元の色に戻すなら、その表紙の行を TUNE から消して作り直す。全部の寄せを外すなら GRADE を { sat: 1, warm: 0 } に）。
// 038（セキュリティ）は錠と鍵穴の絵なので使わない（docs/CONCEPT.md: 鍵穴・錠は有料に見える）。
// 大きさの上限（超えたら書かずに止める）: SIZE.maxBytes（1 枚）と TOTAL_MAX_BYTES（合計）。E2E（窓の表紙）はこの台本を import して同じ値で見る
//   （import しただけでは Chromium を立ち上げない: 下の「直接呼ばれたときだけ」）。
// 同じ元の絵・同じ Chromium で作り直すと、バイト単位で同じ絵になる（乱数・時刻を使わない。--check で確かめる）。
// 絵の処理と WebP の書き出しは Chromium の canvas（playwright-core。E2E と同じ）。ICC を外す stripIcc は build-emblems.mjs の物。

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { chromium } from "playwright-core";
import { stripIcc } from "./build-emblems.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "assets", "images", "covers");

// 名前 → 元の絵。名前は教科（js/covers.js の表が本の id・コースから引く。E2E が両方の名前の一致を見る）
export const COVERS = {
  english: "011-english.png",
  history: "012-history.png",
  science: "013-science.png",
  kokugo: "014-japanese.png",
  geography: "031-geography.png",
  civics: "032-civics.png",
  biology: "033-biology.png",
  physics: "034-physics.png",
  chemistry: "035-chemistry.png",
  math: "036-mathematics.png",
  it: "037-it-fundamentals.png",
  realestate: "039-real-estate.png",
  bookkeeping: "040-bookkeeping.png",
  japhist: "052-japanese-history.png",
  worldhist: "053-world-history.png",
  earth: "054-earth-science.png",
  kobun: "055-classical-japanese.png",
  kanbun: "056-classical-chinese.png",
  conversation: "057-english-conversation.png",
  exam: "058-english-exam.png",
  programming: "059-programming.png",
  bizlaw: "060-business-law.png"
};

// 1 種類だけ。上限は 1 枚 2.5KB・22 枚の合計 40KB（実測は BUILD の記録と docs/DESIGN.md）
export const SIZE = { w: 48, h: 64, quality: 0.8, maxBytes: 2.5 * 1024 };
export const TOTAL_MAX_BYTES = 40 * 1024;

// 切り出す枠（不透明な外接矩形に対する割合）: 縦は top〜bottom（上 46% の題の余白と下の縁の飾りを外す）、横は中心 cx・幅は縦 × 3/4
const CROP_DEFAULT = { top: 0.46, bottom: 0.94, cx: 0.5 };
// 絵の中心が真ん中から外れている表紙だけ（目で見て決めた。--sheet の枠で確かめる）
export const CROP = {
  history: { cx: 0.44 }, // 砂時計と地図
  realestate: { cx: 0.42 }, // 館と鍵
  bookkeeping: { cx: 0.42 }, // 算盤
  japhist: { cx: 0.44 }, // 城と扇
  bizlaw: { cx: 0.46 }, // 天秤と本
  exam: { cx: 0.48 }, // 懐中時計と札
  physics: { top: 0.42, bottom: 0.84 } // 振り子。下のプリズムの虹（光る物）を枠の外へ
};

// 全部の表紙に掛ける寄せ: 彩度を sat 倍（輝度へ寄せる）、暖色（R+、B−）を warm だけ
export const GRADE = { sat: 0.7, warm: 0.04 };

// 色の決まりとぶつかる表紙の追加の寄せ。1 つの op は色相の範囲 hue [h0, h1]（度。境から FEATHER = 14 度かけて弱める）の画素を、
// to（色相を寄せる先）・sat（彩度の倍率）・val（明度の倍率）で寄せる。minS・minV（0〜1）は境目: 彩度・明度がそれ以下の画素には掛けず（重み 0。
// 灰色の地・暗い所を残す）、境目から RAMP = 0.1 上がるまでになだらかに強め（0 → 1 へ一次）、その上は全部に掛ける。書かなければ境目なし（全部の画素）。
// 既定の値は無い（使う値は表に書く。表に無い名前のキーは止める: 書き違いで黙って寄せが外れない）。元の色に戻すなら、その表紙の行を消して作り直す
export const TUNE = {
  geography: [{ why: "緑の地を胡桃へ", hue: [62, 175], minS: 0.12, to: 34, sat: 0.62 }],
  biology: [{ why: "緑の地と葉を胡桃へ", hue: [62, 175], minS: 0.12, to: 34, sat: 0.62 }],
  bookkeeping: [{ why: "緑の地を胡桃へ", hue: [62, 175], minS: 0.12, to: 34, sat: 0.62 }],
  kobun: [{ why: "緑の地を胡桃へ", hue: [62, 175], minS: 0.12, to: 34, sat: 0.62 }],
  exam: [{ why: "緑の地を胡桃へ", hue: [62, 175], minS: 0.12, to: 34, sat: 0.62 }],
  science: [
    { why: "光るフラスコ（青緑）を沈める", hue: [150, 205], minV: 0.45, minS: 0.2, sat: 0.4, val: 0.6 },
    { why: "青緑の地を藍へ", hue: [150, 205], minS: 0.12, to: 218, sat: 0.85 }
  ],
  physics: [{ why: "枠に残る虹（プリズムの光）を沈める。真鍮の金色は残す", hue: [62, 340], minS: 0.35, minV: 0.5, sat: 0.4, val: 0.85 }],
  it: [{ why: "光る青い立方体を沈める", hue: [185, 250], minV: 0.4, minS: 0.25, sat: 0.45, val: 0.64 }],
  programming: [{ why: "光る青い立方体を沈める", hue: [185, 250], minV: 0.4, minS: 0.25, sat: 0.45, val: 0.64 }]
};

const ALPHA_FLOOR = 16;
const FEATHER = 14;
const RAMP = 0.1;
const TUNE_KEYS = new Set(["why", "hue", "to", "sat", "val", "minS", "minV"]);

const PAGE_LIB = String.raw`
async function decode(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
}
function canvasOf(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
// 不透明さ floor 以上の画素の外接矩形（x1・y1 は含む）
function boxOf(img, floor) {
  const { width: W, height: H, data: d } = img;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (d[(y * W + x) * 4 + 3] < floor) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) throw new Error("不透明な画素が無い");
  return { x0, y0, x1, y1 };
}
function rgb2hsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60; if (h < 0) h += 360;
  return [h, max ? d / max : 0, max / 255];
}
function hsv2rgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}
const clamp = (n) => Math.min(255, Math.max(0, Math.round(n)));
// 色相の範囲 [h0, h1] の中なら 1、外は feather 度かけて 0 へ
function hueWeight(h, [h0, h1], feather) {
  const inside = h0 <= h1 ? h >= h0 && h <= h1 : h >= h0 || h <= h1;
  if (inside) return 1;
  const dist = (a, b) => { const t = Math.abs(a - b) % 360; return Math.min(t, 360 - t); };
  return Math.max(0, 1 - Math.min(dist(h, h0), dist(h, h1)) / feather);
}
// 境目 lo（minS・minV）の重み: lo 以下は 0、lo から width 上がるまで 0 → 1 へ一次、その上は 1。lo が無ければ 1（境目なし）
const ramp = (x, lo, width) => (lo == null ? 1 : Math.max(0, Math.min(1, (x - lo) / width)));
function grade(d, sat, warm) {
  if (sat === 1 && !warm) return;
  for (let k = 0; k < d.length; k += 4) {
    const r = d[k], g = d[k + 1], b = d[k + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    d[k] = clamp(l + (r - l) * sat + 255 * warm * 0.6);
    d[k + 1] = clamp(l + (g - l) * sat + 255 * warm * 0.15);
    d[k + 2] = clamp(l + (b - l) * sat - 255 * warm * 0.5);
  }
}
function tune(d, ops, feather, rampW) {
  for (const op of ops) {
    for (let k = 0; k < d.length; k += 4) {
      const [h, s, v] = rgb2hsv(d[k], d[k + 1], d[k + 2]);
      const w = hueWeight(h, op.hue, feather) * ramp(s, op.minS, rampW) * ramp(v, op.minV, rampW);
      if (w <= 0) continue;
      let nh = h;
      if (op.to != null) { let delta = ((op.to - h + 540) % 360) - 180; nh = (h + delta * w + 360) % 360; }
      const ns = Math.min(1, s * (1 + w * ((op.sat ?? 1) - 1)));
      const nv = Math.min(1, v * (1 + w * ((op.val ?? 1) - 1)));
      const [r, g, b] = hsv2rgb(nh, ns, nv);
      d[k] = clamp(r); d[k + 1] = clamp(g); d[k + 2] = clamp(b);
    }
  }
}
// 半分ずつ縮めて（一度に大きく縮めると細い線がちらつく）、最後に目の大きさへ。出口の canvas は不透明（alpha: false）
function resizeTo(src, w, h) {
  let cur = src;
  while (cur.width / 2 >= w && cur.height / 2 >= h) {
    const next = canvasOf(Math.round(cur.width / 2), Math.round(cur.height / 2));
    const g = next.getContext("2d", { alpha: false }); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    g.drawImage(cur, 0, 0, next.width, next.height); cur = next;
  }
  const out = canvasOf(w, h);
  const g = out.getContext("2d", { alpha: false }); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
  g.drawImage(cur, 0, 0, w, h);
  return out;
}
const held = new Map();
window.coverLib = {
  // 元の絵 → 切り出した枠（元の画素のまま、不透明、色を寄せた canvas）をページに持つ
  async load(name, dataUrl, opt) {
    const bmp = await decode(dataUrl);
    const c = canvasOf(bmp.width, bmp.height);
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    const b = boxOf(g.getImageData(0, 0, c.width, c.height), opt.floor);
    const W = b.x1 - b.x0 + 1, H = b.y1 - b.y0 + 1;
    const wh = Math.round((opt.crop.bottom - opt.crop.top) * H);
    const ww = Math.round((wh * opt.w) / opt.h);
    const wy = b.y0 + Math.round(opt.crop.top * H);
    const wx = Math.min(b.x1 + 1 - ww, Math.max(b.x0, Math.round(b.x0 + opt.crop.cx * W - ww / 2)));
    const crop = canvasOf(ww, wh);
    const cg = crop.getContext("2d", { alpha: false, willReadFrequently: true });
    cg.fillStyle = "#2B1F17"; // 枠の中に透過は無いはずだが、あっても胡桃の革の色で不透明に
    cg.fillRect(0, 0, ww, wh);
    cg.drawImage(c, -wx, -wy);
    const img = cg.getImageData(0, 0, ww, wh);
    grade(img.data, opt.sat, opt.warm);
    tune(img.data, opt.ops, opt.feather, opt.ramp);
    cg.putImageData(img, 0, 0);
    held.set(name, crop);
    return { box: [b.x0, b.y0, W, H], win: [wx, wy, ww, wh], size: [bmp.width, bmp.height] };
  },
  render(name, w, h, q) { return resizeTo(held.get(name), w, h).toDataURL("image/webp", q); },
  // 並べた絵: 昼と夜の羊皮紙の地に、元の表紙（切り出す枠つき）・表示の大きさ（2 倍の画素のまま＝ 2x の画面の見え方）・その 3 倍に拡大
  async sheet(items, size) {
    const cell = 150, rows = items.length, bandW = 16 + 120 + 16 + size.w + 16 + size.w * 3 + 16;
    const out = canvasOf(bandW * 2, rows * cell + 16);
    const g = out.getContext("2d");
    for (let band = 0; band < 2; band++) {
      g.fillStyle = band ? "#2A231D" : "#EFE6D2"; g.fillRect(band * bandW, 0, bandW, out.height);
      for (let i = 0; i < items.length; i++) {
        const it = items[i], y = 16 + i * cell, x = band * bandW + 16;
        const full = await decode(it.src);
        const sc = (cell - 16) / full.height;
        g.drawImage(full, x, y, full.width * sc, full.height * sc);
        g.strokeStyle = "#E0B040"; g.lineWidth = 2;
        g.strokeRect(x + it.win[0] * sc, y + it.win[1] * sc, it.win[2] * sc, it.win[3] * sc);
        const im = await decode(it.url);
        g.drawImage(im, x + 120 + 16, y, size.w, size.h);
        g.imageSmoothingEnabled = false;
        g.drawImage(im, x + 120 + 16 + size.w + 16, y, size.w * 3, size.h * 3);
        g.imageSmoothingEnabled = true;
      }
    }
    return out.toDataURL("image/png");
  }
};
`;

const dataUrlOf = (file) => `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
const bufferOf = (url) => Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
const kb = (n) => `${(n / 1024).toFixed(2)}KB`;
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 12);

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

// 実の置き場（symlink・..・末尾の / を解いた絶対の道）。まだ無い道は、ある所まで遡って実の置き場にし、残りを足す
const realOf = (p) => {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(realOf(parent), path.basename(abs));
  }
};
// 同じ所か: 実の置き場が同じ、またはどちらもあって同じフォルダ（同じ dev と inode。大文字と小文字を区別しない置き場・bind mount でも）
function samePlace(a, b) {
  if (realOf(a) === realOf(b)) return true;
  try {
    const x = fs.statSync(a), y = fs.statSync(b);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}
// 引数: 値を取る物と印だけの物。値が無い・-- で始まる（--out --asis で「--asis」というフォルダに書かない）・同じ物が 2 つ・知らない物は止まる
const VALUE_ARGS = { "--src": "<dir>", "--out": "<dir>", "--sheet": "<png>" };
const FLAG_ARGS = ["--asis", "--check"];
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (Object.hasOwn(o, a)) throw new Error(`${a} が 2 つある`);
    if (Object.hasOwn(VALUE_ARGS, a)) {
      const v = argv[i + 1];
      if (v == null || v === "" || v.startsWith("--")) throw new Error(`${a} の後に値が無い（${a} ${VALUE_ARGS[a]}${v ? `。「${v}」は値にしない` : ""}）`);
      o[a] = v;
      i++;
    } else if (FLAG_ARGS.includes(a)) o[a] = true;
    else throw new Error(`知らない引数: ${a}（使えるのは ${[...Object.keys(VALUE_ARGS), ...FLAG_ARGS].join("・")}。値は空白で区切る: --out <dir>）`);
  }
  return o;
}
// 書き先を絵を作る前に確かめる（何も作らない）: 途中にファイルがある・--sheet がフォルダ・--out がファイル・書けない、なら止まる
function checkDest(flag, p, isFile) {
  const abs = path.resolve(p);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory() === isFile) throw new Error(`${flag} ${p} は${isFile ? "フォルダ（並べた絵のファイルの名前を渡す）" : "ファイル（フォルダを渡す）"}`);
  let dir = isFile ? path.dirname(abs) : abs;
  while (!fs.existsSync(dir)) dir = path.dirname(dir);
  if (!fs.statSync(dir).isDirectory()) throw new Error(`${flag} ${p} の途中にファイルがある（${dir}）`);
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    throw new Error(`${flag} ${p} に書けない（${dir}）`);
  }
}

async function main() {
  const arg = parseArgs(process.argv.slice(2));
  const srcDir = arg["--src"];
  const sheetOut = arg["--sheet"] ? path.resolve(arg["--sheet"]) : null;
  const outDir = arg["--out"] ? path.resolve(arg["--out"]) : OUT_DIR;
  const asis = !!arg["--asis"];
  const check = !!arg["--check"];
  if (!srcDir) throw new Error("元の絵の置き場を --src <dir> で渡す（011-english.png など 22 枚）");
  if (check && (asis || arg["--out"])) throw new Error("--check は木の絵と同じ作り方（--asis・--out なし）で見る");
  if (asis && !arg["--out"]) throw new Error("--asis は配る絵にしない。書き先を --out <作業用のフォルダ> で渡す");
  if (asis && samePlace(outDir, OUT_DIR)) throw new Error(`--asis は配る絵にしない。--out ${arg["--out"]} は既定の書き先（assets/images/covers）と同じ所。作業用のフォルダを渡す`);
  if (arg["--out"]) checkDest("--out", arg["--out"], false);
  if (sheetOut) checkDest("--sheet", arg["--sheet"], true);
  for (const file of Object.values(COVERS)) if (!fs.existsSync(path.join(srcDir, file))) throw new Error(`元の絵が無い: ${path.join(srcDir, file)}`);
  for (const [name, ops] of Object.entries(TUNE)) {
    // 表の自分の名前だけ（constructor・toString・__proto__ など Object.prototype の名前は通さない）
    if (!Object.hasOwn(COVERS, name)) throw new Error(`TUNE の ${name} は COVERS に無い`);
    if (!Array.isArray(ops)) throw new Error(`TUNE の ${name} は op の配列にする`);
    for (const op of ops) {
      const odd = Object.keys(op).filter((k) => !TUNE_KEYS.has(k));
      if (odd.length || !Array.isArray(op.hue) || op.hue.length !== 2) throw new Error(`TUNE の ${name}（${op.why}）: ${odd.length ? `知らないキー ${odd.join("・")}` : "hue は [h0, h1]"}`);
    }
  }

  const browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><title>covers</title>");
    await page.addScriptTag({ content: PAGE_LIB });
    const written = [];
    for (const [name, file] of Object.entries(COVERS)) {
      const src = dataUrlOf(path.join(srcDir, file));
      const o = {
        floor: ALPHA_FLOOR,
        feather: FEATHER,
        ramp: RAMP,
        w: SIZE.w,
        h: SIZE.h,
        crop: { ...CROP_DEFAULT, ...(CROP[name] ?? {}) },
        sat: asis ? 1 : GRADE.sat,
        warm: asis ? 0 : GRADE.warm,
        ops: asis ? [] : TUNE[name] ?? []
      };
      const r = await page.evaluate(([n, u, x]) => window.coverLib.load(n, u, x), [name, src, o]);
      const url = await page.evaluate(([n, w, h, q]) => window.coverLib.render(n, w, h, q), [name, SIZE.w, SIZE.h, SIZE.quality]);
      const buf = stripIcc(bufferOf(url));
      if (buf.length > SIZE.maxBytes) throw new Error(`${name}.webp が ${kb(buf.length)}（上限 ${kb(SIZE.maxBytes)}）。品質か画素を下げる`);
      if (buf.includes(Buffer.from("ALPH"))) throw new Error(`${name}.webp に透過が残った（不透明にする）`);
      written.push({ name, file: `${name}.webp`, buf, url, src: sheetOut ? src : null, win: r.win });
      console.log(`${name.padEnd(13)} ${file.padEnd(30)} 外接 ${r.box[2]}×${r.box[3]} → 枠 ${r.win[2]}×${r.win[3]}（${r.win[0]},${r.win[1]}）→ ${SIZE.w}×${SIZE.h} ${String(buf.length).padStart(5)} B ${sha(buf)}${o.ops.length ? `  寄せ: ${o.ops.map((x) => x.why).join("・")}` : ""}`);
    }
    const total = written.reduce((n, w) => n + w.buf.length, 0);
    if (total > TOTAL_MAX_BYTES) throw new Error(`合計が ${kb(total)}（上限 ${kb(TOTAL_MAX_BYTES)}）`);
    const sizes = written.map((w) => w.buf.length);
    console.log(`${written.length} 枚・合計 ${kb(total)}（上限 ${kb(TOTAL_MAX_BYTES)}）・最大 ${kb(Math.max(...sizes))}（上限 ${kb(SIZE.maxBytes)}）・最小 ${kb(Math.min(...sizes))}${asis ? "・寄せなし（--asis）" : ""}`);
    // 並べた絵も先に作り、書き先のフォルダ（無ければ）を作ってから書く（22 枚を書いた後で並べた絵の書き先が無くて止まらない）
    const sheetPng = sheetOut ? bufferOf(await page.evaluate(([items, s]) => window.coverLib.sheet(items, s), [written.map(({ url, src, win }) => ({ url, src, win })), SIZE])) : null;
    if (!check) fs.mkdirSync(outDir, { recursive: true });
    if (sheetOut) fs.mkdirSync(path.dirname(sheetOut), { recursive: true });

    if (check) {
      const differ = written.filter((w) => {
        const cur = path.join(OUT_DIR, w.file);
        return !fs.existsSync(cur) || !fs.readFileSync(cur).equals(w.buf);
      });
      const extra = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith(".webp") && !written.some((w) => w.file === f));
      if (differ.length || extra.length) {
        console.log(`木の絵と違う: ${differ.map((w) => w.file).join("・") || "なし"}／木にだけある: ${extra.join("・") || "なし"}`);
        process.exitCode = 1;
      } else console.log(`木の絵 ${written.length} 枚とバイト単位で同じ`);
    } else {
      // 消すのは既定の書き先（この生成器だけの所）にある、表に無い名前の .webp だけ（名前を替えた表紙の前の絵）。ほかの書き先では何も消さない
      if (samePlace(outDir, OUT_DIR)) {
        const keep = new Set(written.map((w) => w.file));
        const stale = fs.readdirSync(outDir).filter((f) => f.endsWith(".webp") && !keep.has(f)).sort();
        if (stale.length) console.log(`表に無い名前の絵を消す: ${stale.join("・")}`);
        for (const f of stale) fs.rmSync(path.join(outDir, f));
      }
      for (const w of written) fs.writeFileSync(path.join(outDir, w.file), w.buf);
      console.log(`→ ${path.relative(ROOT, outDir) || outDir}/（${written.length} 枚）`);
    }
    if (sheetPng) {
      fs.writeFileSync(sheetOut, sheetPng);
      console.log("並べた絵:", sheetOut);
    }
  } finally {
    await browser.close();
  }
}

// 直接呼ばれたときだけ作る（E2E が SIZE・TOTAL_MAX_BYTES・COVERS を読むために import しても Chromium を立ち上げない。build-emblems.mjs と同じ作り）
if (process.argv[1] && realOf(process.argv[1]) === realOf(fileURLToPath(import.meta.url))) await main();
