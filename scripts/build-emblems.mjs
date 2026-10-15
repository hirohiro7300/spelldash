// 学習のランク（木・銅・銀・金・ダイヤ・レジェンド・神 × 1〜3 の 21 段。js/level.js RANKS・rankOf）の紋章の絵を作る。
// 絵は創業者が用意した 21 枚（1024×1024 の PNG・背景透過。各段の 1 → 2 → 3 で下の菱が 1 → 3 個に増え、飾りが豪華になる）。
// 配信するのは assets/images/emblems/ の WebP だけで、元の PNG はリポジトリに入れない（1 枚 1MB 前後。作り直すときは元の絵の置き場を渡す）。
//
// 使い方:
//   node scripts/build-emblems.mjs --src <dir> [--sheet <png>]
//       <dir>/emblem-<段>-<n>.png（段は wood・copper・silver・gold・diamond・legend〔legend-rainbow でも可〕・god、n は 1〜3）から配信する絵を書く。
//       --sheet を添えると、配信する 21 枚を昼と夜の地に並べた絵（幕の 112 と行・一覧の小さい絵の大きさ）を書く（目で見る用）
//   node scripts/build-emblems.mjs --selftest --src <dir> [--sheet <png>]
//       白い背景のまま届いた絵でも同じ形になるかを確かめる（元の絵を白に重ねて通し、透過の形〔不透明さ 128 以上〕の一致 0.97 以上・
//       外接矩形の差 6 画素以下を見る。配信する絵は書かない）。白は縁から続く所だけ消すので、絵に囲まれた透き間（ダイヤ 3・レジェンド・神 1〜2 の
//       光輪や冠の間）は白のまま残る（2026-10-15 の 21 枚: 15 枚が OK、6 枚は囲まれた透き間の分だけ形の一致が 0.94〜0.97 で NG）。
//       上の段の絵は背景透過の PNG で受け取る（今の 21 枚は透過なので、この手順は通らない）
//
// 配信する絵（どれも表示の大きさの 2 倍の画素。背景は透過）:
//   <段>-<n>.webp      224×224（ランクアップの幕。112 CSS px。css/game.css .rank-up__emblem）
//   <段>-<n>-sm.webp    96×96 （学習データの行 28 CSS px とランクの一覧 32 CSS px。3 倍の画面でもぼけない。css/pages.css .level-bar__emblem・.rank-list__emblem）
// 幕の絵を行と一覧に使い回さないのは、学習データを開くたびに出る行で 1 枚 10KB 台を読ませないため。
//
// 手順:
//   1. 外側の白を透明に: 縁の 6 割以上が不透明なら白い背景のまま届いたとみなし、縁から続く白に近い画素を塗りつぶしで透明にする。
//      境の 1 画素（白と絵が混ざった画素）は白の分だけ透明にする（白の上に置いた半透明の画素を戻す: 色から白を引く）
//   2. かすかな透過（不透明さ 16／255 未満）を消す（元の絵の外側に散る粉のような画素。切り詰めの外周を狂わせる）
//   3. 21 枚に共通の枠で切り詰める: 21 枚の不透明な画素の外接矩形を合わせた矩形の長い辺 × (1 + 2 × 2%) の正方形を、その中心に置いて切り出す。
//      1 枚ずつ切り詰めないのは、元の絵が同じ中心・同じ縮尺で描かれ、段が上がるほど大きくなる（木 1 の 780px → 神 3 の 910px）から。
//      1 枚ずつ詰めると木と銅の丸いメダルが翼のある神と同じ大きさに膨らみ、段が上がる感じが消える。共通の枠なら中心・縮尺・余白の基準が 21 枚で揃う
//   4. 配信する絵: 半分ずつ縮めて（一度に大きく縮めると細い線がちらつく）224px と 96px にし、WebP で書く
//   どの WebP も canvas が付ける sRGB の ICC（456 バイト）を外して書く（stripIcc。色は sRGB の既定と同じ。画素は 1 つも変わらない）
// 絵の処理と WebP の書き出しは Chromium の canvas（playwright-core。E2E と同じ。CHROME_PATH か Playwright の置き場）。ほかの道具は要らない。
// 大きさの上限（超えたら書かずに止める）: SIZES の maxBytes と TOTAL_MAX_BYTES。E2E（9.955 学習のランク）も同じ上限で見る。
// 絵を替えたら、書いた絵を目で確かめてからコミットする（--sheet）。

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright-core";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// 段の英字の名前（js/level.js RANK_TIERS と同じ並び。低い順）と、元の絵のファイル名に使われうる名前
export const TIERS = ["wood", "copper", "silver", "gold", "diamond", "legend", "god"];
const SRC_ALIASES = { legend: ["legend", "legend-rainbow"] };
export const STEPS = [1, 2, 3];
const OUT_DIR = path.join(ROOT, "assets", "images", "emblems");
// 幕用 224px（品質 0.75。上の段ほど細かく、神 3 で約 21KB。0.7〜0.9 を 4 倍で見比べて差が見えない所）・小さい絵 96px（一覧の 32 CSS px の 3 倍。行の 28 にも使う。
// 64px では 3 倍の画面〔多くのスマホ〕で引き伸ばされてぼけた）。上限: 幕用 1 枚 24KB・小さい絵 1 枚 10KB・21 段 × 2 種の合計 440KB（実測 約 385KB）。
// 読み込むのは幕で 1 枚（先読みで多くて 2 枚）・行で 1 枚・一覧を開いたときだけ小さい絵 21 枚
export const SIZES = [
  { suffix: "", px: 224, quality: 0.75, maxBytes: 24 * 1024 },
  { suffix: "-sm", px: 96, quality: 0.86, maxBytes: 10 * 1024 }
];
export const TOTAL_MAX_BYTES = 440 * 1024;
const PAD = 0.02;
const ALPHA_FLOOR = 16;

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

function srcFile(dir, tier, step) {
  for (const name of SRC_ALIASES[tier] ?? [tier]) {
    const file = path.join(dir, `emblem-${name}-${step}.png`);
    if (fs.existsSync(file)) return file;
  }
  throw new Error(`元の絵が無い: ${path.join(dir, `emblem-${tier}-${step}.png`)}`);
}

// ---- ページの中で動く関数（canvas）。引数と戻り値は文字列と数だけ ----
const PAGE_LIB = String.raw`
async function decode(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
}
function canvasOf(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}
function pixelsOf(bitmap) {
  const c = canvasOf(bitmap.width, bitmap.height);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0);
  return { c, g, img: g.getImageData(0, 0, c.width, c.height) };
}
// 1. 外側の白を透明に（縁が不透明なときだけ）。戻り値: 白い背景だったか
function clearWhiteBackground(img) {
  const { width: W, height: H, data: d } = img;
  const border = [];
  for (let x = 0; x < W; x++) border.push(x, (H - 1) * W + x);
  for (let y = 1; y < H - 1; y++) border.push(y * W, y * W + W - 1);
  const opaque = border.filter((i) => d[i * 4 + 3] >= 250).length;
  if (opaque < border.length * 0.6) return false;
  const nearWhite = (i) => {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    return d[i * 4 + 3] > 0 && Math.min(r, g, b) >= 228 && Math.max(r, g, b) - Math.min(r, g, b) <= 24;
  };
  const bg = new Uint8Array(W * H);
  const stack = border.filter(nearWhite);
  for (const i of stack) bg[i] = 1;
  while (stack.length) {
    const i = stack.pop();
    const x = i % W, y = (i / W) | 0;
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (!bg[j] && nearWhite(j)) { bg[j] = 1; stack.push(j); }
    }
  }
  for (let i = 0; i < W * H; i++) if (bg[i]) d[i * 4 + 3] = 0;
  // 境の 1 画素: 白の上に置いた半透明の画素とみなし、白の分を透明に（a = 白から最も離れた色の量、色 = (c − 255(1 − a)) / a）
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (bg[i]) continue;
    let edge = false;
    for (let dy = -1; dy <= 1 && !edge; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < W && ny < H && bg[ny * W + nx]) { edge = true; break; }
    }
    if (!edge) continue;
    const k = i * 4;
    const a = Math.max(255 - d[k], 255 - d[k + 1], 255 - d[k + 2]) / 255;
    if (a >= 0.999) continue;
    if (a <= 0.02) { d[k + 3] = 0; continue; }
    for (let c = 0; c < 3; c++) d[k + c] = Math.max(0, Math.min(255, Math.round((d[k + c] - 255 * (1 - a)) / a)));
    d[k + 3] = Math.round(d[k + 3] * a);
  }
  return true;
}
// 2. かすかな透過を消し、不透明な画素の外接矩形を返す（x1・y1 は含む）
function cleanAndBox(img, floor) {
  const { width: W, height: H, data: d } = img;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = (y * W + x) * 4;
    if (d[k + 3] < floor) { d[k] = d[k + 1] = d[k + 2] = d[k + 3] = 0; continue; }
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) throw new Error("不透明な画素が無い");
  return { x0, y0, x1, y1 };
}
// 半分ずつ縮める（最後の 1 回で目の大きさへ）。canvas の高品質の縮小は 1/2 より大きく縮めると細い線が欠ける
function resizeTo(src, px) {
  let cur = src;
  while (cur.width / 2 >= px) {
    const next = canvasOf(Math.round(cur.width / 2), Math.round(cur.height / 2));
    const g = next.getContext("2d");
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    g.drawImage(cur, 0, 0, next.width, next.height);
    cur = next;
  }
  if (cur.width === px) return cur;
  const out = canvasOf(px, px);
  const g = out.getContext("2d");
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
  g.drawImage(cur, 0, 0, px, px);
  return out;
}
// 元の絵（PNG の data URL）→ 白い背景を消し、かすかな透過を消した canvas と外接矩形
async function cleaned(dataUrl, floor) {
  const bmp = await decode(dataUrl);
  const { c, g, img } = pixelsOf(bmp);
  const white = clearWhiteBackground(img);
  const box = cleanAndBox(img, floor);
  g.putImageData(img, 0, 0);
  return { canvas: c, white, box, size: [bmp.width, bmp.height] };
}
// 外接矩形 → 正方形の枠（長い辺 × (1 + 2 × pad)、中心は外接矩形の中心）
function frameOf(box, pad) {
  const side = Math.ceil(Math.max(box.x1 - box.x0 + 1, box.y1 - box.y0 + 1) * (1 + 2 * pad));
  return { side, cx: (box.x0 + box.x1 + 1) / 2, cy: (box.y0 + box.y1 + 1) / 2 };
}
function cropTo(canvas, frame) {
  const sq = canvasOf(frame.side, frame.side);
  sq.getContext("2d").drawImage(canvas, Math.round(frame.side / 2 - frame.cx), Math.round(frame.side / 2 - frame.cy));
  return sq;
}
// 透過の形（不透明さ 128 以上）の一致の度合い（共通 ÷ 合併）
function maskIoU(a, b) {
  const pa = a.getContext("2d").getImageData(0, 0, a.width, a.height).data;
  const pb = b.getContext("2d").getImageData(0, 0, b.width, b.height).data;
  let inter = 0, uni = 0;
  for (let k = 3; k < pa.length; k += 4) {
    const x = pa[k] >= 128, y = pb[k] >= 128;
    if (x && y) inter++;
    if (x || y) uni++;
  }
  return uni ? inter / uni : 1;
}
const held = new Map();
window.emblemLib = {
  frameOf,
  // 1・2: 元の絵を読み、きれいにした canvas をページに持っておく（21 枚の外接矩形を合わせてから切り詰めるため）
  async load(name, dataUrl, floor) {
    const r = await cleaned(dataUrl, floor);
    held.set(name, r.canvas);
    return { white: r.white, box: r.box, size: r.size };
  },
  // 3・4: 共通の枠で切り詰め、sizes の大きさの WebP（data URL）にする
  render(name, frame, sizes) {
    const sq = cropTo(held.get(name), frame);
    return sizes.map((s) => resizeTo(sq, s.px).toDataURL("image/webp", s.quality));
  },
  // 白い背景の確かめ: 元の絵を白に重ねて同じ手順を通し、透過の形と外接矩形を元の絵の結果と比べる
  async whiteSelftest(dataUrl, pad, floor) {
    const bmp = await decode(dataUrl);
    const big = canvasOf(bmp.width + 64, bmp.height + 64);
    const g = big.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, big.width, big.height);
    g.drawImage(bmp, 32, 32);
    const onWhite = await cleaned(big.toDataURL("image/png"), floor);
    const plain = await cleaned(dataUrl, floor);
    const frame = frameOf(plain.box, pad);
    const moved = { ...frame, cx: frame.cx + 32, cy: frame.cy + 32 };
    const a = resizeTo(cropTo(onWhite.canvas, moved), 256);
    const b = resizeTo(cropTo(plain.canvas, frame), 256);
    const boxDiff = Math.max(...["x0", "y0", "x1", "y1"].map((k) => Math.abs(onWhite.box[k] - 32 - plain.box[k])));
    return { white: onWhite.white, plainWhite: plain.white, iou: maskIoU(a, b), boxDiff, url: resizeTo(cropTo(onWhite.canvas, moved), 224).toDataURL("image/png") };
  },
  // 並べた絵（目で見る用）: 昼と夜の地に、7 段 × 3 を 112px と小さい絵（28px・32px）で並べた PNG
  async sheet(urls, smallUrls, cols) {
    const big = 112, cell = big + 16, smallW = cols * 44;
    const rows = Math.ceil(urls.length / cols);
    const bandW = cols * cell + 16 + smallW + 16;
    const out = canvasOf(bandW * 2, rows * cell + 16);
    const g = out.getContext("2d");
    for (let band = 0; band < 2; band++) {
      g.fillStyle = band ? "#1d1a24" : "#efe6d2";
      g.fillRect(band * bandW, 0, bandW, out.height);
      for (let i = 0; i < urls.length; i++) {
        const r = Math.floor(i / cols), c = i % cols;
        const x = band * bandW + 16 + c * cell, y = 16 + r * cell;
        g.drawImage(await decode(urls[i]), x, y, big, big);
        const sm = await decode(smallUrls[i]);
        const sx = band * bandW + 16 + cols * cell + c * 44;
        g.drawImage(sm, sx, y + 8, 28, 28);
        g.drawImage(sm, sx, y + 48, 32, 32);
      }
    }
    return out.toDataURL("image/png");
  }
};
`;

const dataUrlOf = (file, mime) => `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
const bufferOf = (url) => Buffer.from(url.slice(url.indexOf(",") + 1), "base64");

// canvas の WebP には sRGB の ICC（456 バイト）が付く。色の定義は sRGB の既定と同じなので外す（小さい絵では 1 割前後の重さ）。
// RIFF の ICCP の塊を抜き、VP8X の ICC の印（0x20）を消して、RIFF の大きさを直す。ほかの塊（VP8・ALPH）はそのまま
export function stripIcc(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") return buf;
  const parts = [buf.subarray(0, 12)];
  let at = 12;
  while (at + 8 <= buf.length) {
    const tag = buf.toString("ascii", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const end = at + 8 + size + (size % 2);
    if (tag === "VP8X") {
      const chunk = Buffer.from(buf.subarray(at, end));
      chunk[8] &= ~0x20;
      parts.push(chunk);
    } else if (tag !== "ICCP") {
      parts.push(buf.subarray(at, end));
    }
    at = end;
  }
  const out = Buffer.concat(parts);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}
const kb = (n) => `${(n / 1024).toFixed(1)}KB`;

async function main() {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const srcDir = opt("--src");
  const sheetOut = opt("--sheet");
  const selftest = args.includes("--selftest");
  if (!srcDir) throw new Error("元の絵の置き場を --src <dir> で渡す（emblem-<段>-<n>.png が 21 枚）");

  const browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><title>emblems</title>");
    await page.addScriptTag({ content: PAGE_LIB });

    if (selftest) {
      let bad = 0;
      const shown = [];
      for (const tier of TIERS) for (const step of STEPS) {
        const r = await page.evaluate(([u, p, f]) => window.emblemLib.whiteSelftest(u, p, f), [dataUrlOf(srcFile(srcDir, tier, step), "image/png"), PAD, ALPHA_FLOOR]);
        shown.push(r.url);
        const ok = r.white && !r.plainWhite && r.iou >= 0.97 && r.boxDiff <= 6;
        if (!ok) bad++;
        console.log(`${ok ? "OK" : "NG"} ${tier}-${step}: 白い背景を消した=${r.white}（透過の元=${r.plainWhite}）・形の一致 ${r.iou.toFixed(4)}・外接矩形の差 ${r.boxDiff}px`);
      }
      if (sheetOut) {
        fs.writeFileSync(sheetOut, bufferOf(await page.evaluate(([u, c]) => window.emblemLib.sheet(u, u, c), [shown, 3])));
        console.log("並べた絵（白から切り抜いた 21 枚）:", sheetOut);
      }
      if (bad) process.exitCode = 1;
      return;
    }

    // 1・2: 21 枚を読み、外接矩形を集める
    const boxes = [];
    for (const tier of TIERS) for (const step of STEPS) {
      const name = `${tier}-${step}`;
      const r = await page.evaluate(([n, u, f]) => window.emblemLib.load(n, u, f), [name, dataUrlOf(srcFile(srcDir, tier, step), "image/png"), ALPHA_FLOOR]);
      boxes.push({ name, ...r });
    }
    // 3: 21 枚の外接矩形を合わせた矩形 → 共通の正方形の枠
    const union = boxes.reduce((u, b) => ({ x0: Math.min(u.x0, b.box.x0), y0: Math.min(u.y0, b.box.y0), x1: Math.max(u.x1, b.box.x1), y1: Math.max(u.y1, b.box.y1) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
    const frame = await page.evaluate(([u, p]) => window.emblemLib.frameOf(u, p), [union, PAD]);
    console.log(`共通の枠: 外接矩形の合わせ ${union.x1 - union.x0 + 1}×${union.y1 - union.y0 + 1}（${union.x0},${union.y0}〜${union.x1},${union.y1}）→ 正方形 ${frame.side}px・中心 ${frame.cx},${frame.cy}`);
    for (const b of boxes) {
      const w = b.box.x1 - b.box.x0 + 1, h = b.box.y1 - b.box.y0 + 1;
      console.log(`  ${b.name}: ${b.size.join("×")}${b.white ? "（白い背景を消した）" : ""} 外接 ${w}×${h} → 枠の幅 ${Math.round((w / frame.side) * 100)}%・高さ ${Math.round((h / frame.side) * 100)}%`);
    }

    // 4: 配信する絵
    const written = [];
    for (const b of boxes) {
      const urls = await page.evaluate(([n, f, s]) => window.emblemLib.render(n, f, s), [b.name, frame, SIZES.map(({ px, quality }) => ({ px, quality }))]);
      SIZES.forEach((s, i) => {
        const buf = stripIcc(bufferOf(urls[i]));
        if (buf.length > s.maxBytes) throw new Error(`${b.name}${s.suffix}.webp が ${kb(buf.length)}（上限 ${kb(s.maxBytes)}）。品質か画素を下げる`);
        written.push({ name: `${b.name}${s.suffix}.webp`, buf, url: urls[i], px: s.px });
      });
    }
    const total = written.reduce((a, w) => a + w.buf.length, 0);
    if (total > TOTAL_MAX_BYTES) throw new Error(`21 段の合計が ${kb(total)}（上限 ${kb(TOTAL_MAX_BYTES)}）`);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const keep = new Set(written.map((w) => w.name));
    for (const old of fs.readdirSync(OUT_DIR)) if (old.endsWith(".webp") && !keep.has(old)) fs.rmSync(path.join(OUT_DIR, old)); // 前の名前の絵を残さない
    for (const w of written) fs.writeFileSync(path.join(OUT_DIR, w.name), w.buf);
    for (const s of SIZES) {
      const list = written.filter((w) => w.px === s.px);
      console.log(`${s.px}px: ${list.map((w) => `${w.name} ${w.buf.length}`).join("・")}（計 ${kb(list.reduce((a, w) => a + w.buf.length, 0))}）`);
    }
    console.log(`21 段 × ${SIZES.length} 種の合計 ${kb(total)} → ${path.relative(ROOT, OUT_DIR)}/`);

    if (sheetOut) {
      const big = written.filter((w) => w.px === SIZES[0].px).map((w) => w.url);
      const small = written.filter((w) => w.px === SIZES[1].px).map((w) => w.url);
      fs.writeFileSync(sheetOut, bufferOf(await page.evaluate(([u, s, c]) => window.emblemLib.sheet(u, s, c), [big, small, 3])));
      console.log("並べた絵:", sheetOut);
    }
  } finally {
    await browser.close();
  }
}

await main();
