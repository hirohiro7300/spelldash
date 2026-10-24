// 書斎コレクション（Batch 77。無料 MVP の 12 品）の品の絵と、学習の報酬の行の絵を作る。
// 絵は創業者が用意した原本（PNG。部屋の絵 1536×1024・小物 1254×1254・表紙 1024×1536）。配信するのは assets/images/collection/ の WebP だけで、
// 元の PNG はリポジトリに入れない（1 枚 1〜3MB。作り直すときは原本の置き場を渡す。scripts/build-covers.mjs と同じ作法）。
//
// 使い方:
//   node scripts/build-collection-art.mjs --src <dir> [--sheet <png>] [--out <dir>]
//       <dir>（またはその 1 段下のフォルダ。z1〜z7）の「<名前>-<番号>.png」から ART の 20 枚を書く。原本は番号で探す（名前の字の正規化が
//       原本ごとに違う〔濁点の分かれた形が混ざる〕ので、名前では探さない）。
//       --sheet を添えると、書く絵を昼と夜の地に並べた絵を書く（目で見る用。配信しない。夜の地では机の小物と表紙に CSS の夜の filter を掛け、
//       表紙と重なる紙の縁には border-image の slice の位置に印を付ける）
//       --out は書き先（既定 assets/images/collection）。既定の所では、表（ART）に無い名前の .webp を、名前を出してから消す（名前を替えた品の
//       前の絵を残さない）。ほかの書き先では、表の 20 枚を書くだけで、ほかの物は消さない
//   node scripts/build-collection-art.mjs --check --src <dir> [--sheet <png>]
//       同じ原本から作り直して、木の絵とバイト単位で同じかを見る（違えば exit 1。--sheet の並べた絵のほかは何も書かない）
// 引数の誤り（値の無い --src・--out・--sheet、-- で始まる値、同じ引数が 2 つ、知らない引数）と書けない書き先は、絵を作る前に止まる（何も書かず、消さない）。
//
// 配信する絵（表 ART。js/collectionData.js の ITEMS[].asset が指す絵。名前は <item-id>-<variant>.webp と reward-*.webp）:
//   窓の景色 6 枚（window-*-day／-night）  216×272・透過。構図 B の部屋の絵の窓の右の明かり（ガラスの中で窓枠の入らない所）から切り出し、
//                                          ガラスの形（中心 (108, 108)・半径 108 の半円＋その下の矩形。縁は 1px なめらかに）の外を透明にする。
//                                          場面の窓のガラス（scripts/room-art/figures.mjs の WIN）と同じ形・同じ縦横比
//   机の小物 3 枚（desk-*-prop）           透過。不透明な外接矩形を上・左・右に 2% 広げて切り出す（下は広げない: 品の下端と影を机の線にそろえる）
//   本の装丁 6 枚（binding-*-cover／-thumb）透過（角の丸み）。不透明な外接矩形そのまま。-cover は #pathCard::before の border-image の元（表の slice）で、
//                                          中は塗られないので縁 44px の帯だけ残して中を透明にする（RIM）。-thumb は全体
//   正解の演出 3 枚（fx-*）                 重なる紙の縁（-frame。縁からの距離 ≤ 36px は不透明、52px で 0 へ一次で薄める）・その見本（-thumb。不透明）・
//                                          雫が星に（-sprite。透過）
//   報酬の行の絵 2 枚（reward-*）           透過。外接矩形を四方に 2%（原本の外へ出る所は透明）
//
// 手順（1 枚ずつ。同じ原本・同じ切り出しは 1 回だけ読む）:
//   1. 原本を読み、寸法（SOURCES）と、不透明（不透明さ 16／255 以上）の外接矩形（表の box）が表と同じかを見る（違う原本・書き出し直した原本を黙って使わない）
//   2. 切り出す（元の画素のまま）。不透明さを整える: 16／255 未満は透明に（原本の外に散る粉のような画素。scripts/build-emblems.mjs の手順 2）、
//      OPAQUE_FLOOR（244）以上は不透明に（手元の透過の原本は、不透明な所が 252・253 で 255 が無い。1% 透ける上に、透過の塊が数 KB 重くなる）
//   3. 色の寄せ（元の画素で）: 全部に GRADE、表の名前ごとに TUNE（色相の範囲の画素だけ）、明るさを寄せる物は LOOK（4×5 の色の行列。夜に焼く・窓を頁より暗く）
//   4. 縮める（拡げる）: 乗算済みの形（RGBa）で、半分ずつ縮めてから最後に LANCZOS で目の大きさへ（縁が黒ずまない・細い線がちらつかない。
//      scripts/build-emblems.mjs の手順 4 と同じ考え）
//   5. 形の透過（窓のガラス・紙の縁の帯・表紙の縁）を掛ける
//   6. WebP に書き出す（PIL。quality・alpha_quality・method 6。scripts/room-art/render.mjs と同じ呼び方: 標準入力と標準出力で渡し、一時ファイルを作らない）
// 大きさの上限（1 枚でも超えたら 1 枚も書かずに止める）: 表の maxBytes（1 枚）と TOTAL_MAX_BYTES（合計）。単体と E2E はこの台本を import して同じ値で見る
//   （import しただけでは原本を読まない・書かない: 下の「直接呼ばれたときだけ」）。
// 同じ原本・同じ PIL で作り直すと、バイト単位で同じ絵になる（乱数・時刻を使わない。--check で確かめる）。

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { webpSize, webpAlpha } from "./lib/canvas-art.mjs";
import { isMain } from "./lib/is-main.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ART_DIR = "assets/images/collection";
const OUT_DIR = path.join(ROOT, ART_DIR);
const KB = 1024;

// 原本の番号 → 寸法（読んだ原本がこの寸法でなければ止める。切り出しの座標はこの寸法の画素）
export const SOURCES = {
  3: { w: 1254, h: 1254, what: "胡桃枠の砂時計" },
  5: { w: 1254, h: 1254, what: "茶革の手帳" },
  6: { w: 1254, h: 1254, what: "星空柄の魔導書箱" },
  7: { w: 1536, h: 1024, what: "構図 B・朝" },
  18: { w: 1024, h: 1536, what: "深茶革の表紙" },
  22: { w: 1024, h: 1536, what: "真鍮の角の深紅の革の表紙" },
  30: { w: 1024, h: 1536, what: "記憶の樹の藍の表紙" },
  43: { w: 1254, h: 1254, what: "復習を終えた学習書" },
  44: { w: 1254, h: 1254, what: "完結した学習帳" },
  46: { w: 1536, h: 1024, what: "重なる紙" },
  50: { w: 1536, h: 1024, what: "構図 B・雨" },
  52: { w: 1536, h: 1024, what: "構図 B・星空の夜" },
  56: { w: 1536, h: 1024, what: "構図 B・月の夜" },
  60: { w: 1254, h: 1254, what: "雫が星に" },
  62: { w: 1536, h: 1024, what: "構図 B・陽だまり" }
};

// 窓の景色の切り出し（構図 B の窓の右の明かりの中。窓枠の入らない所は x 54〜210・y 240〜700）。56 だけ月をガラスの頂の半円に入れるため上へ
const WIN_CROP = [56, 312, 150, 190];
// 56: 仕様の (56, 200) では窓の上の飾り石の先（元の x 171〜178・y 211〜216）が半円の縁の内に 2.5px 入る。左へ 2・下へ 4 ずらすと
// 飾り石は半円の外に出て、月（中心 (105, 250)・半径 29）は半円の縁から 8px 内に残る
const WIN_CROP_MOON = [54, 204, 150, 190];
const WIN_OUT = { w: 216, h: 272, alpha: true, mask: "glass", quality: 80, alphaQuality: 90, maxBytes: 22 * KB };
const DESK = { alpha: true, quality: 80, alphaQuality: 80, maxBytes: 8 * KB };
// -cover は border-image の元で、中（slice の内）は塗られない。縁 RIM.keep px の帯だけ残して中を透明にする（見た目は変わらず、軽くなる。統合担当の決め）
const COVER = { alpha: true, mask: "rim", quality: 82, alphaQuality: 90, maxBytes: 16 * KB };
const THUMB = { alpha: true, quality: 82, alphaQuality: 90, maxBytes: 6 * KB }; // 見本は全体を見せる（中を残す）
const REWARD = { alpha: true, quality: 80, alphaQuality: 85, maxBytes: 4 * KB };

// 表: 名前（.webp を除く）・品の id（報酬の行の絵は null）・原本の番号・切り出し [x, y, 幅, 高さ]（原本の画素）・不透明な外接矩形 box [x0, y0, x1, y1)
// （透過の原本だけ。手順 1 で突き合わせる）・出力の幅と高さ・透過・形の透過（mask）・書き出しの品質・1 枚の上限。slice は border-image の初期値（CSS が使う）
export const ART = [
  { name: "window-rain-day", item: "window-rain", src: 50, crop: WIN_CROP, ...WIN_OUT },
  { name: "window-rain-night", item: "window-rain", src: 50, crop: WIN_CROP, ...WIN_OUT },
  { name: "window-morning-day", item: "window-morning", src: 7, crop: WIN_CROP, ...WIN_OUT },
  { name: "window-morning-night", item: "window-morning", src: 52, crop: WIN_CROP, ...WIN_OUT },
  { name: "window-moon-day", item: "window-moon", src: 62, crop: WIN_CROP, ...WIN_OUT },
  { name: "window-moon-night", item: "window-moon", src: 56, crop: WIN_CROP_MOON, ...WIN_OUT },
  { name: "desk-notebook-prop", item: "desk-notebook", src: 5, box: [256, 99, 1013, 1138], crop: [241, 78, 787, 1060], w: 82, h: 110, ...DESK },
  { name: "desk-hourglass-prop", item: "desk-hourglass", src: 3, box: [335, 84, 959, 1156], crop: [323, 63, 648, 1093], w: 65, h: 110, ...DESK },
  { name: "desk-grimoire-prop", item: "desk-grimoire", src: 6, box: [182, 228, 1149, 1027], crop: [163, 212, 1005, 815], w: 116, h: 94, ...DESK },
  { name: "binding-brown-cover", item: "binding-brown", src: 18, box: [52, 114, 973, 1395], crop: [52, 114, 921, 1281], w: 256, h: 356, slice: 24, ...COVER },
  { name: "binding-brown-thumb", item: "binding-brown", src: 18, box: [52, 114, 973, 1395], crop: [52, 114, 921, 1281], w: 96, h: 134, ...THUMB },
  { name: "binding-redleather-cover", item: "binding-redleather", src: 22, box: [51, 124, 970, 1423], crop: [51, 124, 919, 1299], w: 256, h: 362, slice: 30, ...COVER },
  { name: "binding-redleather-thumb", item: "binding-redleather", src: 22, box: [51, 124, 970, 1423], crop: [51, 124, 919, 1299], w: 96, h: 136, ...THUMB },
  { name: "binding-memory-tree-cover", item: "binding-memory-tree", src: 30, box: [67, 120, 958, 1413], crop: [67, 120, 891, 1293], w: 256, h: 372, slice: 36, ...COVER, maxBytes: 20 * KB }, // 藍の布の織り目が重く、中を透明にしても 16KB に入らない。上限だけ 20KB（統合担当の決め）
  { name: "binding-memory-tree-thumb", item: "binding-memory-tree", src: 30, box: [67, 120, 958, 1413], crop: [67, 120, 891, 1293], w: 96, h: 139, ...THUMB },
  { name: "fx-layered-paper-frame", item: "fx-layered-paper", src: 46, crop: [0, 0, 1536, 1024], w: 512, h: 341, alpha: true, mask: "frame", slice: 52, quality: 78, alphaQuality: 80, maxBytes: 20 * KB },
  { name: "fx-layered-paper-thumb", item: "fx-layered-paper", src: 46, crop: [0, 0, 1536, 1024], w: 96, h: 64, alpha: false, quality: 80, maxBytes: 5 * KB },
  { name: "fx-star-drop-sprite", item: "fx-star-drop", src: 60, box: [257, 261, 1009, 985], crop: [234, 239, 798, 768], w: 144, h: 139, alpha: true, quality: 80, alphaQuality: 85, maxBytes: 8 * KB },
  { name: "reward-review", item: null, src: 43, box: [17, 226, 1226, 1074], crop: [-7, 209, 1257, 882], w: 72, h: 51, ...REWARD },
  { name: "reward-book", item: null, src: 44, box: [129, 152, 1158, 1105], crop: [108, 133, 1071, 991], w: 72, h: 67, ...REWARD }
];
// 合計の上限（1 枚ずつの上限の和は 263KB。合計の方が効く）
export const TOTAL_MAX_BYTES = 240 * KB;

// 形の透過: 窓のガラス（半円の中心と半径は出力の画素。縁は 1px なめらかに）・紙の縁の帯（縁からの距離 ≤ solid は不透明、clear で 0 へ一次）・
// 表紙の縁（縁からの距離 ≤ keep は残し、その内は透明。slice 24〜36 は keep の内）
export const GLASS = { cx: 108, cy: 108, r: 108 };
export const FRAME = { solid: 36, clear: 52 };
export const RIM = { keep: 44 };

// 全部の絵に掛ける寄せ（部屋の色。docs/CONCEPT.md）: 彩度を sat 倍（輝度へ寄せる）、暖色（R+、B−）を warm だけ。scripts/build-covers.mjs と同じ式
export const GRADE = { sat: 0.85, warm: 0.02 };

// 色の決まりとぶつかる所の追加の寄せ（scripts/build-covers.mjs の TUNE と同じ書き方）。1 つの op は色相の範囲 hue [h0, h1]（度。境から FEATHER = 14 度
// かけて弱める）の画素を、to（色相を寄せる先）・sat（彩度の倍率）・val（明度の倍率）で寄せる。minS・minV（0〜1）は境目: それ以下の画素には掛けず、
// 境目から RAMP = 0.1 上がるまでになだらかに強める。maxA（0〜1）は不透明さの上の境目: それ以上の画素には掛けず、RAMP 下がるまでになだらかに強める。
// alpha は不透明さの倍率（淡い光を薄める）。書かなければ境目なし。表に無い名前のキー・知らないキーは止める
const GREEN = { why: "緑（木・丘・蔦）を沈める", hue: [62, 175], minS: 0.12, sat: 0.55, val: 0.92 };
export const TUNE = {
  "window-rain-day": [GREEN],
  "window-rain-night": [GREEN],
  "window-morning-day": [GREEN],
  "window-morning-night": [GREEN],
  "window-moon-day": [GREEN],
  "window-moon-night": [GREEN, { why: "月の周りの光の輪を沈める（光るのは炎だけ）", hue: [190, 260], minV: 0.5, val: 0.85 }],
  "desk-hourglass-prop": [{ why: "砂の明るい所を沈める（光らない）", hue: [20, 50], minV: 0.8, val: 0.92 }],
  "desk-grimoire-prop": [{ why: "星と真鍮の光る所を沈める", hue: [25, 55], minS: 0.35, minV: 0.85, val: 0.85 }],
  "binding-redleather-cover": [{ why: "赤を朱に見せない", hue: [340, 20], minS: 0.3, val: 0.9 }],
  "binding-redleather-thumb": [{ why: "赤を朱に見せない", hue: [340, 20], minS: 0.3, val: 0.9 }],
  "binding-memory-tree-cover": [{ why: "金の光る所を沈める", hue: [25, 60], minS: 0.3, minV: 0.8, val: 0.9 }],
  "binding-memory-tree-thumb": [{ why: "金の光る所を沈める", hue: [25, 60], minS: 0.3, minV: 0.8, val: 0.9 }],
  "fx-layered-paper-frame": [{ why: "赤い布を胡桃へ（朱に見せない）", hue: [340, 25], minS: 0.25, to: 28, sat: 0.55 }],
  "fx-layered-paper-thumb": [{ why: "赤い布を胡桃へ（朱に見せない）", hue: [340, 25], minS: 0.25, to: 28, sat: 0.55 }],
  "fx-star-drop-sprite": [{ why: "金の星の周りの淡い光を薄める", hue: [0, 360], minV: 0.6, maxA: 0.4, alpha: 0.6 }]
};

// 明るさの寄せ: 明るさ bright 倍・彩度 sat 倍・RGB の利き gain を 4×5 の色の行列で（scripts/room-art/scene.mjs の FIG_LOOK の書き方）。
// 夜に焼く物（昼の原本しか無い品）と、窓の明るさを部屋の決まりに入れる物（昼の窓は頁〔L* 94〜96〕より暗く L* 70〜85、夜の窓は L* 10〜30。
// いちばん明るいのは開いた本。docs/CONCEPT.md）。手元の原本の L*（不透明な画素の中央・99%）: 7 は 92.8・97.4 → 82.9・87.0、
// 62 は 90.3・97.6 → 80.6・87.0、56 は 36.8・93.3 → 29.5・76.2（50 の昼 74.0・83.4、52 の夜 28.8・51.6 は寄せない）
export const LOOK = {
  "window-rain-night": { why: "雨の町（昼）を夜に焼く", bright: 0.38, sat: 0.6, gain: [0.82, 0.9, 1.15] },
  "window-morning-day": { why: "昼の空を頁より暗く", bright: 0.88, sat: 1, gain: [1, 1, 1] },
  "window-moon-day": { why: "昼の空を頁より暗く", bright: 0.88, sat: 1, gain: [1, 1, 1] },
  "window-moon-night": { why: "夜の空を沈める", bright: 0.8, sat: 1, gain: [1, 1, 1] }
};

const ALPHA_FLOOR = 16;
const OPAQUE_FLOOR = 244;
const FEATHER = 14;
const RAMP = 0.1;
const TUNE_KEYS = new Set(["why", "hue", "to", "sat", "val", "minS", "minV", "maxA", "alpha"]);
const LOOK_KEYS = new Set(["why", "bright", "sat", "gain"]);

// ---- 色の寄せ（straight の RGBA の画素の列。元の画素の大きさで掛ける） ----
const clamp = (n) => Math.min(255, Math.max(0, Math.round(n)));
function rgb2hsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, max ? d / max : 0, max / 255];
}
function hsv2rgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}
// 色相の範囲 [h0, h1] の中なら 1、外は feather 度かけて 0 へ
function hueWeight(h, [h0, h1], feather) {
  const inside = h0 <= h1 ? h >= h0 && h <= h1 : h >= h0 || h <= h1;
  if (inside) return 1;
  const dist = (a, b) => {
    const t = Math.abs(a - b) % 360;
    return Math.min(t, 360 - t);
  };
  return Math.max(0, 1 - Math.min(dist(h, h0), dist(h, h1)) / feather);
}
// 境目 lo の重み: lo 以下は 0、lo から width 上がるまで 0 → 1 へ一次、その上は 1。lo が無ければ 1
const ramp = (x, lo, width) => (lo == null ? 1 : Math.max(0, Math.min(1, (x - lo) / width)));
function grade(d, { sat, warm }) {
  for (let k = 0; k < d.length; k += 4) {
    const r = d[k], g = d[k + 1], b = d[k + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    d[k] = clamp(l + (r - l) * sat + 255 * warm * 0.6);
    d[k + 1] = clamp(l + (g - l) * sat + 255 * warm * 0.15);
    d[k + 2] = clamp(l + (b - l) * sat - 255 * warm * 0.5);
  }
}
function tune(d, ops) {
  for (const op of ops) {
    for (let k = 0; k < d.length; k += 4) {
      if (!d[k + 3]) continue;
      const [h, s, v] = rgb2hsv(d[k], d[k + 1], d[k + 2]);
      const a = d[k + 3] / 255;
      const w = hueWeight(h, op.hue, FEATHER) * ramp(s, op.minS, RAMP) * ramp(v, op.minV, RAMP) * (op.maxA == null ? 1 : ramp(op.maxA - a, 0, RAMP));
      if (w <= 0) continue;
      let nh = h;
      if (op.to != null) nh = (h + (((op.to - h + 540) % 360) - 180) * w + 360) % 360;
      const ns = Math.min(1, s * (1 + w * ((op.sat ?? 1) - 1)));
      const nv = Math.min(1, v * (1 + w * ((op.val ?? 1) - 1)));
      const [r, g, b] = hsv2rgb(nh, ns, nv);
      d[k] = clamp(r);
      d[k + 1] = clamp(g);
      d[k + 2] = clamp(b);
      if (op.alpha != null) d[k + 3] = clamp(d[k + 3] * (1 + w * (op.alpha - 1)));
    }
  }
}
// 色の行列（3 行 × RGB。scene.mjs の grade と同じ組み方: 輝度へ寄せる彩度 × 行ごとの利き × 明るさ）
export function lookMatrix({ bright, sat, gain }) {
  const L = [0.2126, 0.7152, 0.0722];
  return [0, 1, 2].map((i) => L.map((l, j) => (i === j ? l + (1 - l) * sat : l * (1 - sat)) * gain[i] * bright));
}
function applyMatrix(d, m) {
  for (let k = 0; k < d.length; k += 4) {
    const r = d[k], g = d[k + 1], b = d[k + 2];
    for (let i = 0; i < 3; i++) d[k + i] = clamp(m[i][0] * r + m[i][1] * g + m[i][2] * b);
  }
}

// 不透明さを整える（手順 2）: floor 未満は透明（色も 0）、opaque 以上は不透明
function cleanAlpha(d, floor, opaque) {
  for (let k = 3; k < d.length; k += 4) {
    if (d[k] < floor) d[k] = d[k - 1] = d[k - 2] = d[k - 3] = 0;
    else if (d[k] >= opaque) d[k] = 255;
  }
}

// ---- 形の透過（出力の画素の大きさで、不透明さに掛ける） ----
function maskGlass(d, w, h) {
  const { cx, cy, r } = GLASS;
  for (let y = 0; y < h; y++) {
    const py = y + 0.5;
    if (py >= cy) continue; // 半円の下の矩形は全部ガラス
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - cx, dy = py - cy;
      const cover = Math.max(0, Math.min(1, r + 0.5 - Math.sqrt(dx * dx + dy * dy))); // 縁の 1px をなめらかに
      const k = (y * w + x) * 4 + 3;
      d[k] = Math.round(d[k] * cover);
    }
  }
}
function maskFrame(d, w, h) {
  const { solid, clear } = FRAME;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dist = Math.min(x + 0.5, y + 0.5, w - x - 0.5, h - y - 0.5);
    const keep = dist <= solid ? 1 : dist >= clear ? 0 : (clear - dist) / (clear - solid);
    const k = (y * w + x) * 4 + 3;
    d[k] = Math.round(d[k] * keep);
  }
}
function maskRim(d, w, h) {
  const { keep } = RIM;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (Math.min(x + 0.5, y + 0.5, w - x - 0.5, h - y - 0.5) > keep) d[(y * w + x) * 4 + 3] = 0;
  }
}
const MASKS = { glass: maskGlass, frame: maskFrame, rim: maskRim };

// ---- PIL（読む・縮める・書き出す・並べた絵）。render.mjs と同じく標準入力と標準出力で渡す ----
const PY = String.raw`import sys, io, json, base64
from PIL import Image
op = sys.argv[1]
a = [int(v) for v in sys.argv[2:]]
data = sys.stdin.buffer.read()
out = sys.stdout.buffer
if op == "load":
    # 原本 → 1 行目に寸法と不透明な外接矩形（JSON）、続けて切り出した画素（straight の RGBA。原本の外は透明）
    x, y, w, h, floor = a
    im = Image.open(io.BytesIO(data))
    im.load()
    rgba = im.convert("RGBA")
    box = rgba.getchannel("A").point(lambda v: 255 if v >= floor else 0).getbbox()
    out.write((json.dumps({"size": list(im.size), "box": list(box) if box else None}) + "\n").encode())
    out.write(rgba.crop((x, y, x + w, y + h)).tobytes())
elif op == "resize":
    # 乗算済みの形で、半分ずつ縮めてから（端数は切り上げ。Math.round と同じ）、最後に LANCZOS で目の大きさへ
    w, h, W, H = a
    im = Image.frombytes("RGBA", (w, h), data).convert("RGBa")
    while im.width / 2 >= W and im.height / 2 >= H:
        im = im.resize(((im.width + 1) // 2, (im.height + 1) // 2), Image.LANCZOS)
    if im.size != (W, H):
        im = im.resize((W, H), Image.LANCZOS)
    out.write(im.convert("RGBA").tobytes())
elif op == "encode":
    w, h, q, aq, alpha = a
    im = Image.frombytes("RGBA", (w, h), data)
    if not alpha:
        im = im.convert("RGB")
    b = io.BytesIO()
    im.save(b, "WEBP", quality=q, alpha_quality=aq, method=6)
    out.write(b.getvalue())
elif op == "sheet":
    # 並べた絵: 昼と夜の地を上下に。行ごとに絵を左から（画素のまま）。夜の地では night の filter（明るさ・彩度）を掛ける。slice の位置に地の上の印
    from PIL import ImageDraw, ImageEnhance, ImageFont
    spec = json.loads(data)
    font = ImageFont.load_default()
    gap, lab = 16, 14
    rows = [[dict(it, im=Image.open(io.BytesIO(base64.b64decode(it["webp"]))).convert("RGBA")) for it in row] for row in spec["rows"]]
    bw = max(sum(it["im"].width for it in row) + gap * (len(row) + 1) for row in rows)
    bh = sum(max(it["im"].height for it in row) + lab + gap for row in rows) + gap
    sheet = Image.new("RGBA", (bw, bh * 2))
    for band, (ground, ink) in enumerate(spec["grounds"]):
        g = Image.new("RGBA", (bw, bh), ground)
        d = ImageDraw.Draw(g)
        y = gap
        for row in rows:
            x = gap
            for it in row:
                im = it["im"]
                if band == 1 and it.get("night"):
                    al = im.getchannel("A")
                    rgb = ImageEnhance.Color(im.convert("RGB")).enhance(it["night"][1])
                    im = ImageEnhance.Brightness(rgb).enhance(it["night"][0])
                    im.putalpha(al)
                g.alpha_composite(im, (x, y))
                s = it.get("slice")
                if s:
                    W, H = im.size
                    for t in (s, W - s):
                        d.line([(x + t, y - 6), (x + t, y - 1)], fill="#D0308A")
                        d.line([(x + t, y + H), (x + t, y + H + 5)], fill="#D0308A")
                    for t in (s, H - s):
                        d.line([(x - 6, y + t), (x - 1, y + t)], fill="#D0308A")
                        d.line([(x + W, y + t), (x + W + 5, y + t)], fill="#D0308A")
                d.text((x, y + im.height + 2), it["label"], fill=ink, font=font)
                x += im.width + gap
            y += max(it["im"].height for it in row) + lab + gap
        sheet.paste(g, (0, band * bh))
    b = io.BytesIO()
    sheet.save(b, "PNG")
    out.write(b.getvalue())
`;
function py(op, args, input) {
  return execFileSync("python3", ["-I", "-c", PY, op, ...args.map(String)], { input, maxBuffer: 256 * 1024 * 1024 });
}

// 原本を番号で探す: <dir>/*-<番号>.png か <dir>/<フォルダ>/*-<番号>.png。ちょうど 1 枚でなければ止める
export function findSource(dir, no) {
  const hits = [];
  const scan = (d, depth) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth === 0) scan(p, 1);
      else if (e.isFile() && Number(e.name.match(/-(\d+)\.png$/i)?.[1]) === no) hits.push(p);
    }
  };
  scan(dir, 0);
  if (hits.length !== 1) throw new Error(`原本 ${no}（${SOURCES[no]?.what ?? "?"}）が ${hits.length ? `${hits.length} 枚ある: ${hits.join("・")}` : `無い（${dir} とその 1 段下の *-${no}.png）`}`);
  return hits[0];
}

const kb = (n) => `${(n / KB).toFixed(2)}KB`;
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 12);

// 実の置き場（symlink・..・末尾の / を解いた絶対の道）。まだ無い道は、ある所まで遡って実の置き場にし、残りを足す（scripts/build-covers.mjs と同じ）
const realOf = (p) => {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(realOf(parent), path.basename(abs));
  }
};
function samePlace(a, b) {
  if (realOf(a) === realOf(b)) return true;
  try {
    const x = fs.statSync(a), y = fs.statSync(b);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}
function insideOut(p) {
  const r = realOf(p), d = realOf(OUT_DIR);
  return samePlace(p, OUT_DIR) || r.startsWith(d + path.sep);
}
const VALUE_ARGS = { "--src": "<dir>", "--out": "<dir>", "--sheet": "<png>" };
const FLAG_ARGS = ["--check"];
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
// 表の形を確かめる（名前の形・重複・TUNE と LOOK のキー）
function checkTable() {
  const names = new Set();
  for (const r of ART) {
    if (!/^((window|desk|binding|fx)-[a-z0-9-]{1,40}-(day|night|thumb|cover|frame|sprite|prop)|reward-(review|book))$/.test(r.name)) throw new Error(`名前の形が違う: ${r.name}`);
    if (r.item && !r.name.startsWith(`${r.item}-`)) throw new Error(`${r.name} は品の id（${r.item}）で始まらない`);
    if (names.has(r.name)) throw new Error(`名前が 2 つある: ${r.name}`);
    names.add(r.name);
    if (!SOURCES[r.src]) throw new Error(`${r.name}: 原本 ${r.src} が SOURCES に無い`);
    if (r.mask && !MASKS[r.mask]) throw new Error(`${r.name}: 知らない形 ${r.mask}`);
  }
  for (const [name, ops] of Object.entries(TUNE)) {
    if (!names.has(name)) throw new Error(`TUNE の ${name} は ART に無い`);
    if (!Array.isArray(ops)) throw new Error(`TUNE の ${name} は op の配列にする`);
    for (const op of ops) {
      const odd = Object.keys(op).filter((k) => !TUNE_KEYS.has(k));
      if (odd.length || !Array.isArray(op.hue) || op.hue.length !== 2) throw new Error(`TUNE の ${name}（${op.why}）: ${odd.length ? `知らないキー ${odd.join("・")}` : "hue は [h0, h1]"}`);
    }
  }
  for (const [name, n] of Object.entries(LOOK)) {
    if (!names.has(name)) throw new Error(`LOOK の ${name} は ART に無い`);
    const odd = Object.keys(n).filter((k) => !LOOK_KEYS.has(k));
    if (odd.length || !Array.isArray(n.gain) || n.gain.length !== 3) throw new Error(`LOOK の ${name}: ${odd.length ? `知らないキー ${odd.join("・")}` : "gain は [r, g, b]"}`);
  }
}

// 20 枚を作る（書かない）。戻り値: [{ ...表の行, file, buf }]
export function buildArt(srcDir) {
  checkTable();
  const loaded = new Map();
  const loadCrop = (r) => {
    const key = `${r.src}:${r.crop.join(",")}`;
    if (!loaded.has(key)) {
      const file = findSource(srcDir, r.src);
      const out = py("load", [...r.crop, ALPHA_FLOOR], fs.readFileSync(file));
      const nl = out.indexOf(10);
      const info = JSON.parse(out.subarray(0, nl).toString());
      const px = out.subarray(nl + 1);
      const want = SOURCES[r.src];
      if (info.size[0] !== want.w || info.size[1] !== want.h) throw new Error(`原本 ${r.src}（${path.basename(file)}）が ${info.size.join("×")}（表は ${want.w}×${want.h}）`);
      if (px.length !== r.crop[2] * r.crop[3] * 4) throw new Error(`原本 ${r.src} の切り出しの画素の数が違う`);
      loaded.set(key, { file, info, px });
    }
    const got = loaded.get(key);
    if (r.box && got.info.box?.join(",") !== r.box.join(",")) throw new Error(`原本 ${r.src}（${path.basename(got.file)}）の不透明な外接矩形が ${got.info.box?.join(",")}（表は ${r.box.join(",")}）。原本が替わった`);
    return got;
  };
  const out = [];
  for (const r of ART) {
    const { file, px } = loadCrop(r);
    const d = Buffer.from(px); // 写し（同じ切り出しを使う次の行に寄せを持ち越さない）
    cleanAlpha(d, ALPHA_FLOOR, OPAQUE_FLOOR);
    grade(d, GRADE);
    tune(d, TUNE[r.name] ?? []);
    if (LOOK[r.name]) applyMatrix(d, lookMatrix(LOOK[r.name]));
    const small = Buffer.from(py("resize", [r.crop[2], r.crop[3], r.w, r.h], d));
    if (r.mask) MASKS[r.mask](small, r.w, r.h);
    const buf = py("encode", [r.w, r.h, r.quality, r.alphaQuality ?? 0, r.alpha ? 1 : 0], small);
    const size = webpSize(buf);
    if (!size || size[0] !== r.w || size[1] !== r.h) throw new Error(`${r.name}.webp の寸法が ${size?.join("×")}（表は ${r.w}×${r.h}）`);
    if (webpAlpha(buf) !== r.alpha) throw new Error(`${r.name}.webp の透過が表と違う（表は${r.alpha ? "透過" : "不透明"}）`);
    out.push({ ...r, file: `${r.name}.webp`, buf, srcFile: path.basename(file) });
  }
  return out;
}

// 並べた絵（PNG。目で見る用）: 昼と夜の地に、窓の景色・本の装丁・机の小物と正解の演出と報酬の行の絵を 3 行で。夜の地では机の小物と表紙に
// CSS の夜の filter（机の小物 brightness(0.62) saturate(0.82)・表紙 brightness(0.9)）を掛け、slice のある絵には地の上に slice の位置の印を付ける
export function sheetOf(written) {
  const it = (w) => ({
    label: w.name,
    webp: w.buf.toString("base64"),
    slice: w.slice ?? null,
    night: w.name.startsWith("desk-") ? [0.62, 0.82] : /^binding-.*-cover$/.test(w.name) ? [0.9, 1] : null
  });
  const pick = (re) => written.filter((w) => re.test(w.name)).map(it);
  const rows = [pick(/^window-/), pick(/^binding-/), [...pick(/^desk-/), ...pick(/^fx-/), ...pick(/^reward-/)]];
  return py("sheet", [], Buffer.from(JSON.stringify({ rows, grounds: [["#EFE6D2", "#3A2E24"], ["#2A231D", "#D8CBB4"]] })));
}

async function main() {
  const arg = parseArgs(process.argv.slice(2));
  const srcDir = arg["--src"];
  const sheetOut = arg["--sheet"] ? path.resolve(arg["--sheet"]) : null;
  const outDir = arg["--out"] ? path.resolve(arg["--out"]) : OUT_DIR;
  const check = !!arg["--check"];
  if (!srcDir) throw new Error("原本の置き場を --src <dir> で渡す（<名前>-<番号>.png。1 段下のフォルダも探す）");
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) throw new Error(`--src ${srcDir} はフォルダではない`);
  if (check && arg["--out"]) throw new Error("--check は木の絵（既定の書き先）と比べる。--out は渡さない");
  if (sheetOut && insideOut(path.dirname(sheetOut))) throw new Error(`--sheet ${arg["--sheet"]} は配る所（${ART_DIR}）の中。並べた絵は配らない所に書く`);
  if (arg["--out"]) checkDest("--out", arg["--out"], false);
  if (sheetOut) checkDest("--sheet", arg["--sheet"], true);

  const written = buildArt(srcDir);
  for (const w of written) {
    const ops = [...(TUNE[w.name] ?? []).map((o) => o.why), ...(LOOK[w.name] ? [LOOK[w.name].why] : [])];
    console.log(`${w.name.padEnd(26)} ${String(w.src).padStart(2)} 切り出し ${w.crop.join(",").padEnd(18)} → ${`${w.w}×${w.h}`.padEnd(7)} ${String(w.buf.length).padStart(6)} B（上限 ${w.maxBytes / KB}KB） ${sha(w.buf)}${ops.length ? `  寄せ: ${ops.join("・")}` : ""}`);
  }
  const over = written.filter((w) => w.buf.length > w.maxBytes);
  const total = written.reduce((n, w) => n + w.buf.length, 0);
  if (over.length || total > TOTAL_MAX_BYTES)
    throw new Error(`上限を超えた（何も書いていない）: ${[...over.map((w) => `${w.file} ${kb(w.buf.length)} > ${kb(w.maxBytes)}`), ...(total > TOTAL_MAX_BYTES ? [`合計 ${kb(total)} > ${kb(TOTAL_MAX_BYTES)}`] : [])].join("・")}`);
  console.log(`${written.length} 枚・合計 ${kb(total)}（上限 ${kb(TOTAL_MAX_BYTES)}）`);

  // 並べた絵も先に作る（20 枚を書いた後で止まらない）
  const sheet = sheetOut ? sheetOf(written) : null;
  if (!check) fs.mkdirSync(outDir, { recursive: true });
  if (sheetOut) fs.mkdirSync(path.dirname(sheetOut), { recursive: true });

  if (check) {
    const differ = written.filter((w) => {
      const cur = path.join(OUT_DIR, w.file);
      return !fs.existsSync(cur) || !fs.readFileSync(cur).equals(w.buf);
    });
    const extra = fs.existsSync(OUT_DIR) ? fs.readdirSync(OUT_DIR).filter((f) => f.endsWith(".webp") && !written.some((w) => w.file === f)) : [];
    if (differ.length || extra.length) {
      console.log(`木の絵と違う: ${differ.map((w) => w.file).join("・") || "なし"}／木にだけある: ${extra.join("・") || "なし"}`);
      process.exitCode = 1;
    } else console.log(`木の絵 ${written.length} 枚とバイト単位で同じ`);
  } else {
    // 消すのは既定の書き先（この生成器だけの所）にある、表に無い名前の .webp だけ。ほかの書き先では何も消さない
    if (samePlace(outDir, OUT_DIR)) {
      const keep = new Set(written.map((w) => w.file));
      const stale = fs.readdirSync(outDir).filter((f) => f.endsWith(".webp") && !keep.has(f)).sort();
      if (stale.length) console.log(`表に無い名前の絵を消す: ${stale.join("・")}`);
      for (const f of stale) fs.rmSync(path.join(outDir, f));
    }
    for (const w of written) fs.writeFileSync(path.join(outDir, w.file), w.buf);
    console.log(`→ ${path.relative(ROOT, outDir) || outDir}/（${written.length} 枚）`);
  }
  if (sheet) {
    fs.writeFileSync(sheetOut, sheet);
    console.log("並べた絵:", sheetOut);
  }
}

// 直接呼ばれたときだけ作る（単体・E2E が ART・TOTAL_MAX_BYTES を読むために import しても原本を読まない）
if (isMain(import.meta.url)) await main();
