// はちゃんの絵（創業者が用意した絵 006 お出迎え・008 学習成功・010 読書）を、配信する WebP と場面の窓辺の絵にする。
// 元の PNG（1254×1254・背景透過・1 枚 1〜2MB）はリポジトリに入れない（作り直すときは元の絵の置き場を --src で渡す）。
//
// 使い方:
//   node scripts/build-hasumi.mjs --src <dir>          作って書く（<dir> は 006-welcome.png・008-success.png・010-reading.png のある所か、その上の mascot/ のある所）
//   node scripts/build-hasumi.mjs --src <dir> --check  書かずに、作り直した 11 枚が木のファイルとバイト単位で同じかを見る（違えば終了コード 1）
//
// 書く物:
//   assets/images/hasumi-normal.webp・@2x（32・64px）  006 の顔（帽子のつばの縁から襟まで）。ふつう: 結果のパネル・週間レポート・学習中の知らせ（3 つ続けて出てこない時）
//   assets/images/hasumi-happy.webp・@2x（32・64px）   008 の顔（右のきらめきは枠の外）。うれしい: 前より伸びた・セット完了・覚えた瞬間
//   scripts/room-art/figure-reading.webp（幅 300px）    010 の窓辺の姿（本の光を抑えた物。場面に焼く元で、配信しない）
//   assets/images/room/scene-{phone,short,desk}-{light,dark}.webp  上の窓辺の姿で場面を焼き直す（scripts/room-art/render.mjs の bakeScenes。枚数・名前・表示する 1 枚は今のまま）
//
// 手順:
//   1. かすかな透過（不透明さ 16／255 未満）を消す（元の絵の外に散る粉のような画素）
//   2. アバター: 顔の中心と一辺の正方形（FACE。006・008 は顔の位置が同じ）で切り、半分ずつ縮めて 64px と 32px に（一度に大きく縮めると細い線がちらつく）
//   3. 窓辺の姿: 010 の本の光を抑える（光るのは炎だけ。docs/CHARACTER.md §2.5）。頁の上の楕円に黄の補色を乗算で重ねて頁を紙の白に戻し、
//      頁の上に浮く光の霞（半透明の明るい画素）を消す。不透明な画素の外接矩形で切り詰め、幅 300px に
//   4. 場面の焼き直し（昼夜の色の寄せ・縁の光・座面の影は scripts/room-art/scene.mjs の FIG_LOOK・FIGURE）
//   どの WebP も canvas が付ける sRGB の ICC を外して書く（scripts/build-emblems.mjs の stripIcc）。場面は PIL（render.mjs）
// 絵の処理と WebP の書き出しは Chromium の canvas（playwright-core。E2E と同じ）。同じ元から作り直すとバイト単位で同じ（--check で確かめられる）。
// 上限（1 枚でも超えたら 1 枚も書かずに止める）: SIZES の maxBytes と場面の SCENE_MAX_BYTES。E2E（5・8.65・9.5 覚えた瞬間 v2・9.55・9.99）はこの台本を import して同じ値で見る
// （import しただけでは Chromium を立ち上げない: 下の「直接呼ばれたときだけ」）。前の絵（ベクターの頭と肩の PNG 4 枚）は消した（E2E 8.65 が残っていないことを見る）。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright-core";
import { stripIcc, findChromium } from "./build-emblems.mjs";
import { bakeScenes, writeOrCheck, FIGURE_FILE, SCENE_MAX_BYTES } from "./room-art/render.mjs";

// 元の絵のファイル名
export const SOURCES = { normal: "006-welcome.png", happy: "008-success.png", reading: "010-reading.png" };
// 配信するアバター（js/hasumi.js の AVATAR・AVATAR_2X と同じ名前。E2E が突き合わせる）。表示は 32 CSS px の丸（css/pages.css・card.css）、1x と 2x
export const AVATARS = ["normal", "happy"].flatMap((mood) => [
  { mood, rel: `assets/images/hasumi-${mood}.webp`, px: 32, quality: 0.82, maxBytes: 2.5 * 1024 },
  { mood, rel: `assets/images/hasumi-${mood}@2x.webp`, px: 64, quality: 0.82, maxBytes: 5 * 1024 }
]);
export const SIZES = { avatar: AVATARS, figure: { px: 300, quality: 0.9, maxBytes: 60 * 1024 }, scene: SCENE_MAX_BYTES };
const ALPHA_FLOOR = 16;
// 顔の枠（元の絵 1254px の座標）。一辺 440 で、つばの縁と襟まで入り、008 の右のきらめき（x ≥ 922）は入らない。006 の振る手は右の端にわずかに入る
const FACE = { cx: 666, cy: 400, side: 440 };
// 010 の本の光: 頁の上の楕円（中心・半径・ぼかしの幅）に黄の補色（薄い藤色）を乗算。霞: 楕円を haze 倍に広げた中で、不透明さ 160 未満かつ明るい（平均 150 以上）画素を消す
const DEGLOW = { cx: 790, cy: 700, rx: 210, ry: 105, feather: 80, color: "#C9C2E8", haze: 1.35, hazeAlpha: 160, hazeLum: 150 };

// ---- ページの中で動く関数（canvas）。引数と戻り値は文字列と数だけ ----
const PAGE_LIB = String.raw`
async function decode(url) {
  const blob = await (await fetch(url)).blob();
  return createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
}
function canvasOf(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
// 半分ずつ縮める（最後の 1 回で目の大きさへ）
function resizeTo(src, w, h) {
  let cur = src;
  while (cur.width / 2 >= w) {
    const n = canvasOf(Math.round(cur.width / 2), Math.round(cur.height / 2));
    const g = n.getContext("2d"); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    g.drawImage(cur, 0, 0, n.width, n.height); cur = n;
  }
  if (cur.width === w && cur.height === h) return cur;
  const o = canvasOf(w, h); const g = o.getContext("2d"); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
  g.drawImage(cur, 0, 0, w, h); return o;
}
const held = new Map();
window.hasumiLib = {
  // 1・3: 読む。かすかな透過を消す。deglow があれば本の光を抑え、霞を消す
  async load(name, url, floor, deglow) {
    const bmp = await decode(url);
    const c = canvasOf(bmp.width, bmp.height);
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    const img = g.getImageData(0, 0, c.width, c.height); const d = img.data;
    for (let k = 3; k < d.length; k += 4) if (d[k] < floor) d[k - 3] = d[k - 2] = d[k - 1] = d[k] = 0;
    if (deglow) {
      const { cx, cy, rx, ry, haze, hazeAlpha, hazeLum } = deglow;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        const nx = (x - cx) / (rx * haze), ny = (y - cy) / (ry * haze);
        if (nx * nx + ny * ny > 1) continue;
        const k = (y * c.width + x) * 4;
        if (d[k + 3] > 0 && d[k + 3] < hazeAlpha && (d[k] + d[k + 1] + d[k + 2]) / 3 >= hazeLum) d[k] = d[k + 1] = d[k + 2] = d[k + 3] = 0;
      }
    }
    g.putImageData(img, 0, 0);
    if (!deglow) { held.set(name, c); return [c.width, c.height]; }
    const t = canvasOf(c.width, c.height); const tg = t.getContext("2d");
    tg.drawImage(c, 0, 0);
    tg.globalCompositeOperation = "multiply";
    tg.save(); tg.translate(deglow.cx, deglow.cy); tg.scale(1, deglow.ry / deglow.rx);
    const r = deglow.rx + deglow.feather;
    const gr = tg.createRadialGradient(0, 0, 0, 0, 0, r);
    gr.addColorStop(0, deglow.color); gr.addColorStop((deglow.rx - deglow.feather * 0.5) / r, deglow.color); gr.addColorStop(1, "#FFFFFF");
    tg.fillStyle = gr; tg.fillRect(-r, -r, 2 * r, 2 * r); tg.restore();
    tg.globalCompositeOperation = "destination-in"; tg.drawImage(c, 0, 0); // 透過は元のまま
    held.set(name, t);
    return [c.width, c.height];
  },
  // 2: 正方形の枠で切り、px の WebP（data URL）に
  square(name, f, px, q) {
    const s = canvasOf(f.side, f.side);
    s.getContext("2d").drawImage(held.get(name), Math.round(f.side / 2 - f.cx), Math.round(f.side / 2 - f.cy));
    return resizeTo(s, px, px).toDataURL("image/webp", q);
  },
  // 3: 不透明な画素の外接矩形で切り詰め、幅 px の WebP に
  trimmed(name, px, q, floor) {
    const c = held.get(name); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] >= floor) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const t = canvasOf(w, h); t.getContext("2d").drawImage(c, -x0, -y0);
    return { url: resizeTo(t, px, Math.round((px * h) / w)).toDataURL("image/webp", q), box: [x0, y0, w, h] };
  }
};`;

const dataUrlOf = (file) => `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
const bufferOf = (url) => stripIcc(Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));

function srcDirOf(dir) {
  for (const d of [dir, path.join(dir, "mascot"), path.join(dir, "assets", "mascot")]) if (fs.existsSync(path.join(d, SOURCES.reading))) return d;
  throw new Error(`元の絵が無い: ${path.join(dir, SOURCES.reading)}（${Object.values(SOURCES).join("・")} のある所を --src で渡す）`);
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf("--src");
  if (at < 0 || !args[at + 1]) throw new Error("元の絵の置き場を --src <dir> で渡す（006-welcome.png・008-success.png・010-reading.png）");
  const src = srcDirOf(args[at + 1]);
  const check = args.includes("--check");
  const browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><title>hasumi</title>");
    await page.addScriptTag({ content: PAGE_LIB });
    const files = [];
    // 1・2: アバター（006 → ふつう、008 → うれしい）
    for (const mood of ["normal", "happy"]) {
      await page.evaluate(([n, u, f]) => window.hasumiLib.load(n, u, f, null), [mood, dataUrlOf(path.join(src, SOURCES[mood])), ALPHA_FLOOR]);
      for (const a of AVATARS.filter((x) => x.mood === mood)) {
        const url = await page.evaluate(([n, f, px, q]) => window.hasumiLib.square(n, f, px, q), [mood, FACE, a.px, a.quality]);
        files.push({ rel: a.rel, buf: bufferOf(url), max: a.maxBytes });
      }
    }
    // 3: 窓辺の姿（010）
    await page.evaluate(([u, f, dg]) => window.hasumiLib.load("reading", u, f, dg), [dataUrlOf(path.join(src, SOURCES.reading)), ALPHA_FLOOR, DEGLOW]);
    const fig = await page.evaluate(([px, q, f]) => window.hasumiLib.trimmed("reading", px, q, f), [SIZES.figure.px, SIZES.figure.quality, ALPHA_FLOOR]);
    const figBuf = bufferOf(fig.url);
    files.push({ rel: FIGURE_FILE, buf: figBuf, max: SIZES.figure.maxBytes });
    console.log(`窓辺の姿: 010 の外接矩形 ${fig.box[2]}×${fig.box[3]}（${fig.box[0]},${fig.box[1]}〜）→ 幅 ${SIZES.figure.px}px`);
    // 4: 場面の焼き直し
    files.push(...(await bakeScenes(browser, figBuf)));
    const diff = writeOrCheck(files, { check });
    if (check && diff) {
      console.error(`作り直した絵が ${diff} 枚 木と違う`);
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

// 直接呼ばれたときだけ作る（tests/e2e.mjs が AVATARS・SIZES を読むために import しても Chromium を立ち上げない）
const realOf = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
if (process.argv[1] && realOf(process.argv[1]) === realOf(fileURLToPath(import.meta.url))) await main();
