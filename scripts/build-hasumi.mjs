// はちゃんの絵（創業者が用意した絵 006 お出迎え・008 学習成功・010 読書）を、配信する WebP と場面の窓辺の絵にする。
// 元の PNG（1254×1254・背景透過・1 枚 1〜2MB）はリポジトリに入れない（作り直すときは元の絵の置き場を --src で渡す）。
//
// 使い方:
//   node scripts/build-hasumi.mjs --src <dir>          作って書く（<dir> は 006-welcome.png・008-success.png・010-reading.png のある所か、その上の mascot/ のある所）
//   node scripts/build-hasumi.mjs --src <dir> --check  書かずに、作り直した 13 枚が木のファイルとバイト単位で同じかを見る（違えば終了コード 1）
//   3 枚がそろわない・ファイルでない・1254×1254 の PNG でない・透過が無い・中身が壊れて読めないときは、どのファイルかを言って止まり、何も書かない
//   （絵の処理の途中で止まったとき〔Chromium が落ちたなど〕は、Chromium の元の文を添えて止まる）
//
// 書く物:
//   assets/images/hasumi-normal.webp・@2x・@3x（30・60・90px）  006 の顔（帽子のつばの縁から襟まで）。ふつう: 結果のパネル・週間レポート・学習中の知らせ（3 つ続けて出てこない時）
//   assets/images/hasumi-happy.webp・@2x・@3x（30・60・90px）   008 の顔（右のきらめきは枠の外）。うれしい: 前より伸びた・セット完了・覚えた瞬間
//   scripts/room-art/figure-reading.webp（幅 300px）    010 の窓辺の姿（本の光を抑えた物。場面に焼く元で、配信しない）
//   assets/images/room/scene-{phone,short,desk}-{light,dark}.webp  上の窓辺の姿で場面を焼き直す（scripts/room-art/render.mjs の bakeScenes。枚数・名前・表示する 1 枚は今のまま）
//
// 手順:
//   1. かすかな透過（不透明さ 16／255 未満）を消す（元の絵の外に散る粉のような画素）
//   2. アバター: 顔の中心と一辺の正方形（FACE。006・008 は顔の位置が同じ）を、元の画素から直接の面積平均（前乗算の BOX。areaDown）で 90・60・30px に。
//      canvas の縮小（半分ずつ＋最後の半端な倍率の双線形）は柔らかくなる（勾配の鋭さが直接の BOX の 0.78〜0.88）ので使わない。透過の縁は前乗算で平均するので色がにじまない
//   3. 窓辺の姿: 010 の本の光を抑える（光るのは炎だけ。docs/CHARACTER.md §2.5）。頁の上に浮く光の霞（本体から離れた半透明の明るい画素）を消し、
//      頁の上の楕円に黄の補色を画素ごとに掛けて頁を紙の白に戻す。不透明な画素の外接矩形で切り詰め、幅 300px に
//   4. 場面の焼き直し（昼夜の色の寄せ・縁の光・座面の影は scripts/room-art/scene.mjs の FIG_LOOK・FIGURE）
//   どの WebP も canvas が付ける sRGB の ICC を外して書く（stripIcc）。場面は PIL（render.mjs）
//   Chromium の置き場・stripIcc・ページの中の decode・canvasOf・resizeTo は scripts/lib/canvas-art.mjs（build-emblems・build-covers と共通）
// 絵の処理と WebP の書き出しは Chromium の canvas（playwright-core。E2E と同じ）。同じ元から作り直すとバイト単位で同じ（--check で確かめられる）。
// 上限（1 枚でも超えたら 1 枚も書かずに止める）: SIZES の maxBytes と場面の SCENE_MAX_BYTES。E2E（5・8.65・9.5 覚えた瞬間 v2・9.55・9.99）はこの台本を import して同じ値で見る
// （import しただけでは Chromium を立ち上げない: 下の「直接呼ばれたときだけ」）。前の絵（ベクターの頭と肩の PNG 4 枚）は消した（E2E 8.65 が残っていないことを見る）。
import fs from "fs";
import path from "path";
import { chromium } from "playwright-core";
import { findChromium, dataUrlOf, bufferOf, stripIcc, PAGE_CANVAS } from "./lib/canvas-art.mjs";
import { isMain } from "./lib/is-main.mjs";
import { bakeScenes, writeOrCheck, FIGURE_FILE, SCENE_MAX_BYTES } from "./room-art/render.mjs";

// 元の絵のファイル名
export const SOURCES = { normal: "006-welcome.png", happy: "008-success.png", reading: "010-reading.png" };
// 配信するアバター（js/hasumi.js の AVATAR・AVATAR_2X・AVATAR_3X と同じ名前。E2E が突き合わせる）。img は 32×32 CSS px の丸で、枠 1px の内側（border-box）の
// 30 CSS px に絵を描く（css/pages.css・card.css）。その 1x・2x・3x の 30・60・90px（3 倍の画面〔iPhone・iOS のアプリ〕で引き伸ばさない・どの倍率でも半端に縮めない）。
// 1 画面で読むのは srcset が選ぶ 1 枚。上限: 1 枚 2.5／5／8KB
export const AVATAR_CSS_PX = 30;
export const AVATARS = ["normal", "happy"].flatMap((mood) => [
  { mood, dpr: 1, rel: `assets/images/hasumi-${mood}.webp`, px: AVATAR_CSS_PX, quality: 0.82, maxBytes: 2.5 * 1024 },
  { mood, dpr: 2, rel: `assets/images/hasumi-${mood}@2x.webp`, px: AVATAR_CSS_PX * 2, quality: 0.82, maxBytes: 5 * 1024 },
  { mood, dpr: 3, rel: `assets/images/hasumi-${mood}@3x.webp`, px: AVATAR_CSS_PX * 3, quality: 0.82, maxBytes: 8 * 1024 }
]);
export const SIZES = { avatar: AVATARS, figure: { px: 300, quality: 0.9, maxBytes: 60 * 1024 }, scene: SCENE_MAX_BYTES };
const ALPHA_FLOOR = 16;
// 顔の枠（元の絵 1254px の座標）。一辺 440 で、つばの縁と襟まで入り、008 の右のきらめき（x ≥ 922）は入らない。006 の振る手は右の端にわずかに入る
const FACE = { cx: 666, cy: 400, side: 440 };
// 元の絵の寸法。FACE と DEGLOW はこの寸法の座標なので、3 枚ともこの寸法でなければ読む前に止める（書き出し直した絵・別のポーズで違う所に当たらないように）。
// 背景透過でもなければ止める（PNG の色の種類が 4・6 か tRNS の塊があること〔読む前〕、読んだ絵に透明な画素があること〔読んだ所〕。透過が無いと背景まで顔と窓辺の姿に入る）
export const SRC_SIZE = 1254;
// 010 の本の光: 頁の上の楕円（中心・半径・ぼかしの幅）に黄の補色（薄い藤色）を掛ける。
// 霞: 楕円を haze 倍に広げた中で、不透明さ hazeAlpha 未満・明るさ（平均）hazeLum 以上の画素のうち、不透明な画素（solid 以上）から near px より離れた物だけ消す
// （本体から離れて浮く光の霞。頁・襟・金の縁のなめらかな縁は不透明な画素に接しているので残る。手元の 010: 頁の縁の明るい半透明は不透明な頁から 1〜2px、霞の 7 割は 12px より遠い）
const DEGLOW = { cx: 790, cy: 700, rx: 210, ry: 105, feather: 80, color: "#C9C2E8", haze: 1.35, hazeAlpha: 160, hazeLum: 150, solid: 200, near: 2 };

// ---- ページの中で動く関数（canvas）。引数と戻り値は文字列と数だけ。decode・canvasOf・resizeTo は PAGE_CANVAS（scripts/lib/canvas-art.mjs） ----
const PAGE_LIB = PAGE_CANVAS + String.raw`
// 2: 面積平均の縮小（前乗算の BOX）。元の ImageData の [ox, ox+side) × [oy, oy+side) を px 四方に。出口の 1 画素は元の s × s（s = side / px）の正方形を覆い、
//    覆う元の画素を重なりの面積 × 不透明さで重み付けて色を平均し、不透明さは面積で平均する（半透明の縁の色が透明な画素の色に引かれない）。元の外は透明
function areaDown(img, ox, oy, side, px) {
  const { width: W, height: H, data: d } = img;
  const s = side / px;
  const spans = [];
  for (let i = 0; i < px; i++) {
    const a = i * s, b = Math.min(side, (i + 1) * s), row = []; // 最後の端は side ちょうど（浮動小数の誤差で枠の外の 1 列を読まない）
    for (let x = Math.floor(a); x < Math.ceil(b); x++) row.push([x, Math.min(b, x + 1) - Math.max(a, x)]);
    spans.push(row);
  }
  const out = new ImageData(px, px), o = out.data;
  for (let j = 0; j < px; j++) for (let i = 0; i < px; i++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (const [y, wy] of spans[j]) {
      const Y = oy + y;
      if (Y < 0 || Y >= H) continue;
      for (const [x, wx] of spans[i]) {
        const X = ox + x;
        if (X < 0 || X >= W) continue;
        const k = (Y * W + X) * 4, w = wx * wy * d[k + 3];
        r += w * d[k]; g += w * d[k + 1]; b += w * d[k + 2]; a += w;
      }
    }
    const k = (j * px + i) * 4;
    if (a > 0) { o[k] = Math.round(r / a); o[k + 1] = Math.round(g / a); o[k + 2] = Math.round(b / a); }
    o[k + 3] = Math.round(a / (s * s));
  }
  return out;
}
// 3: 頁の上に浮く光の霞を消す（楕円を haze 倍に広げた中の、半透明で明るく、不透明な画素から near px より離れた画素）。消した数を返す。
//    消す画素は不透明さ hazeAlpha 未満（< solid）なので、消しても「不透明な画素が近くにあるか」の判定は変わらない
function clearHaze(img, dg) {
  const { width: W, height: H, data: d } = img;
  const ax = dg.rx * dg.haze, ay = dg.ry * dg.haze, n = dg.near;
  const solidNear = (x, y) => {
    for (let dy = -n; dy <= n; dy++) for (let dx = -n; dx <= n; dx++) {
      const X = x + dx, Y = y + dy;
      if (dx * dx + dy * dy <= n * n && X >= 0 && Y >= 0 && X < W && Y < H && d[(Y * W + X) * 4 + 3] >= dg.solid) return true;
    }
    return false;
  };
  let gone = 0;
  for (let y = Math.max(0, Math.floor(dg.cy - ay)); y <= Math.min(H - 1, Math.ceil(dg.cy + ay)); y++) for (let x = Math.max(0, Math.floor(dg.cx - ax)); x <= Math.min(W - 1, Math.ceil(dg.cx + ax)); x++) {
    const nx = (x - dg.cx) / ax, ny = (y - dg.cy) / ay;
    if (nx * nx + ny * ny > 1) continue;
    const k = (y * W + x) * 4;
    if (d[k + 3] > 0 && d[k + 3] < dg.hazeAlpha && (d[k] + d[k + 1] + d[k + 2]) / 3 >= dg.hazeLum && !solidNear(x, y)) { d[k] = d[k + 1] = d[k + 2] = d[k + 3] = 0; gone++; }
  }
  return gone;
}
// 3: 本の光を抑える。頁の上の楕円（半径 rx − feather/2 までは color、rx + feather で白）の色を、画素ごとに rgb に掛ける（不透明さは元のまま）。
//    canvas の multiply で重ねてから透過を戻す形は、半透明の画素が (1−α)·color + α·color·元の色 で明るくなり、正方形の外の α が二乗になった（PR #184 のレビュー 1）
function multiplyGlow(img, dg) {
  const { width: W, height: H, data: d } = img;
  const m = [1, 3, 5].map((i) => parseInt(dg.color.slice(i, i + 2), 16));
  const sy = dg.rx / dg.ry, r0 = dg.rx - dg.feather * 0.5, r1 = dg.rx + dg.feather;
  for (let y = Math.max(0, Math.floor(dg.cy - r1 / sy)); y <= Math.min(H - 1, Math.ceil(dg.cy + r1 / sy)); y++) for (let x = Math.max(0, Math.floor(dg.cx - r1)); x <= Math.min(W - 1, Math.ceil(dg.cx + r1)); x++) {
    const r = Math.hypot(x + 0.5 - dg.cx, (y + 0.5 - dg.cy) * sy);
    const k = (y * W + x) * 4;
    if (r >= r1 || !d[k + 3]) continue;
    const w = r <= r0 ? 1 : (r1 - r) / (r1 - r0);
    for (let c = 0; c < 3; c++) d[k + c] = Math.round((d[k + c] * (255 - w * (255 - m[c]))) / 255);
  }
}
const held = new Map(); // 名前 → 読んだ絵の canvas（窓辺の姿の切り詰め）
const pixels = new Map(); // 名前 → かすかな透過を消した ImageData（アバターの面積平均。getImageData の値。drawImage で canvas を一度通るが、縮小の 2 回目の丸めは入らない）
window.hasumiLib = {
  // 1・3: 読む。かすかな透過を消す。deglow があれば霞を消し、本の光を抑える。戻り値の clear は透明な画素の数（0 なら背景が塗ってある）。
  //   解読できない（createImageBitmap の InvalidStateError）ときだけ、投げずに decodeError を返す（Node の側で「壊れている」と言い分ける）
  async load(name, url, floor, deglow) {
    let bmp;
    try {
      bmp = await decode(url);
    } catch (e) {
      if (e && e.name === "InvalidStateError") return { decodeError: e.name + ": " + e.message };
      throw e;
    }
    const c = canvasOf(bmp.width, bmp.height);
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    const img = g.getImageData(0, 0, c.width, c.height); const d = img.data;
    let clear = 0;
    for (let k = 3; k < d.length; k += 4) if (d[k] < floor) { d[k - 3] = d[k - 2] = d[k - 1] = d[k] = 0; clear++; }
    let haze = 0;
    if (deglow) { haze = clearHaze(img, deglow); multiplyGlow(img, deglow); }
    g.putImageData(img, 0, 0);
    held.set(name, c);
    pixels.set(name, img);
    return { size: [c.width, c.height], haze, clear };
  },
  // 2: 正方形の枠（左上は元の (cx − side/2, cy − side/2) を丸めた所）を面積平均で px 四方にし、WebP（data URL）に
  square(name, f, px, q) {
    const c = canvasOf(px, px);
    c.getContext("2d").putImageData(areaDown(pixels.get(name), -Math.round(f.side / 2 - f.cx), -Math.round(f.side / 2 - f.cy), f.side, px), 0, 0);
    return c.toDataURL("image/webp", q);
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

const webpOf = (url) => stripIcc(bufferOf(url));

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// PNG の頭: IHDR の幅・高さ・色の種類と、IDAT より前に tRNS の塊があるか（塊の頭だけ読む）。ファイルでなければ { notFile }、PNG でなければ null
function pngHead(file) {
  const st = fs.statSync(file);
  if (!st.isFile()) return { notFile: st.isDirectory() ? "フォルダ" : "ファイルではない" };
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(33); // 署名 8・IHDR（長さ 4・名 4・中身 13・CRC 4）
    if (fs.readSync(fd, head, 0, 33, 0) < 33 || !head.subarray(0, 8).equals(PNG_SIG) || head.toString("ascii", 12, 16) !== "IHDR") return null;
    const out = { w: head.readUInt32BE(16), h: head.readUInt32BE(20), colorType: head[25], trns: false };
    const ch = Buffer.alloc(8);
    for (let at = 33; fs.readSync(fd, ch, 0, 8, at) === 8; at += 12 + ch.readUInt32BE(0)) {
      const tag = ch.toString("ascii", 4, 8);
      if (tag === "tRNS") out.trns = true;
      if (tag === "IDAT" || tag === "IEND") break; // tRNS は IDAT より前に置く決まり
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}
// 色の種類 4（灰＋透過）・6（RGBA）か、tRNS の塊（RGB・灰・色の表の透過）があれば背景透過の PNG
const hasAlpha = (h) => h.colorType === 4 || h.colorType === 6 || h.trns;
// 元の絵の置き場（3 枚のある所か、その上の mascot/ のある所）。読む前に、3 枚がそろい、どれも SRC_SIZE 四方の背景透過の PNG であることを確かめる（違えば何も書かずに止める）
function srcDirOf(dir) {
  const names = Object.values(SOURCES);
  const d = [dir, path.join(dir, "mascot"), path.join(dir, "assets", "mascot")].find((x) => names.some((f) => fs.existsSync(path.join(x, f))));
  if (!d) throw new Error(`元の絵が無い: ${dir} に ${names.join("・")} のどれも無い（3 枚のある所か、その上の mascot/ のある所を --src で渡す）`);
  const missing = names.filter((f) => !fs.existsSync(path.join(d, f)));
  if (missing.length) throw new Error(`元の絵が無い: ${missing.join("・")}（${d}。何も書いていない。3 枚そろえて渡す）`);
  const why = (f, h) =>
    !h ? `${f} が PNG ではない` : h.notFile ? `${f} が PNG ではない（${h.notFile}）` : h.w !== SRC_SIZE || h.h !== SRC_SIZE ? `${f} が ${h.w}×${h.h}` :
    !hasAlpha(h) ? `${f} に透過が無い（PNG の色の種類 ${h.colorType}・tRNS なし）` : null;
  const bad = names.map((f) => why(f, pngHead(path.join(d, f)))).filter(Boolean);
  if (bad.length) {
    throw new Error(`元の絵が想定と違う（何も書いていない）: ${bad.join("・")}。${SRC_SIZE}×${SRC_SIZE} の背景透過の PNG で渡す` +
      `（顔の枠と本の光の楕円は ${SRC_SIZE}×${SRC_SIZE} の座標で決めてある。別の寸法やポーズなら FACE と DEGLOW を決め直す。透過が無いと背景まで顔と窓辺の姿に入る）`);
  }
  return d;
}
// ページで読む。止まるときはどのファイルかを言う: 解読できない → 「壊れている」、透明な画素が無い → 「透過が無い」、
// ほかの失敗（霞・光の処理、Chromium が落ちたなど）→ 元の文の 1 行目を添える（「壊れている」とは言わない）
async function loadIn(page, name, file, deglow) {
  let r;
  try {
    r = await page.evaluate(([n, u, f, dg]) => window.hasumiLib.load(n, u, f, dg), [name, dataUrlOf(file), ALPHA_FLOOR, deglow]);
  } catch (e) {
    throw new Error(`元の絵の処理で止まった: ${file}（何も書いていない。元の文: ${String(e?.message ?? e).split("\n")[0]}）`, { cause: e });
  }
  if (r.decodeError) throw new Error(`元の絵が読めない: ${file}（PNG の中身が壊れている。何も書いていない。書き出し直して渡す。元の文: ${r.decodeError}）`);
  if (!r.clear) throw new Error(`元の絵が想定と違う（何も書いていない）: ${file} に透過が無い（背景が塗ってあり、透明な画素が 1 つも無い）。背景透過の PNG で書き出し直して渡す`);
  return r;
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
      await loadIn(page, mood, path.join(src, SOURCES[mood]), null);
      for (const a of AVATARS.filter((x) => x.mood === mood)) {
        const url = await page.evaluate(([n, f, px, q]) => window.hasumiLib.square(n, f, px, q), [mood, FACE, a.px, a.quality]);
        files.push({ rel: a.rel, buf: webpOf(url), max: a.maxBytes });
      }
    }
    // 3: 窓辺の姿（010）
    const read = await loadIn(page, "reading", path.join(src, SOURCES.reading), DEGLOW);
    const fig = await page.evaluate(([px, q, f]) => window.hasumiLib.trimmed("reading", px, q, f), [SIZES.figure.px, SIZES.figure.quality, ALPHA_FLOOR]);
    const figBuf = webpOf(fig.url);
    files.push({ rel: FIGURE_FILE, buf: figBuf, max: SIZES.figure.maxBytes });
    console.log(`窓辺の姿: 010 の外接矩形 ${fig.box[2]}×${fig.box[3]}（${fig.box[0]},${fig.box[1]}〜）→ 幅 ${SIZES.figure.px}px（頁の上に浮く霞 ${read.haze} 画素を消した）`);
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
if (isMain(import.meta.url)) await main();
