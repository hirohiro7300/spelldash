// 絵の生成器（build-emblems・build-covers・build-hasumi・room-art/render・build-og-image）の共通の部品。絵の処理は Chromium の canvas（playwright-core）。
//   Node の側: findChromium（Chromium の置き場）・dataUrlOf・bufferOf（ページとの受け渡し）・stripIcc（canvas の WebP の ICC を外す）・webpSize（WebP の幅と高さ）
//   ページの側: PAGE_CANVAS（decode・canvasOf・resizeTo。各台本の PAGE_LIB の頭に置く文字列）
// tests/e2e.mjs・scripts/test-level.mjs も webpSize を使う（WebP の頭の読み方は 1 つ）。import しても Chromium は立ち上がらない。
import fs from "fs";
import path from "path";

// Chromium の置き場（CHROME_PATH、無ければ Playwright の置き場）
export function findChromium() {
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

// ファイル → data URL（ページへ渡す）。data URL → Buffer（ページから受け取る）
export const dataUrlOf = (file, mime = "image/png") => `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
export const bufferOf = (url) => Buffer.from(url.slice(url.indexOf(",") + 1), "base64");

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

// WebP の画素の幅と高さ [w, h]。最初の塊（12 バイト目）の頭を読む: VP8X（透過・拡張）・VP8 （不可逆）・VP8L（可逆）。WebP でなければ null
export function webpSize(buf) {
  if (!buf || buf.length < 30 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") return null;
  const tag = buf.toString("ascii", 12, 16);
  if (tag === "VP8X") return [buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1];
  if (tag === "VP8 ") return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
  if (tag === "VP8L") {
    const bits = buf.readUInt32LE(21);
    return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
  }
  return null;
}

// ---- ページの中で動く関数（canvas）。各台本の PAGE_LIB の頭に置く。引数と戻り値は文字列と数だけ ----
export const PAGE_CANVAS = String.raw`
async function decode(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
}
function canvasOf(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}
// 半分ずつ縮めて（canvas の高品質の縮小は 1/2 より大きく縮めると細い線が欠ける）、最後の 1 回で目の大きさへ。
// opaque: 途中も出口も不透明の canvas（alpha: false）に描き、同じ大きさでも出口の canvas を作る（表紙）
function resizeTo(src, w, h = w, { opaque = false } = {}) {
  const ctxOf = (c) => {
    const g = opaque ? c.getContext("2d", { alpha: false }) : c.getContext("2d");
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    return g;
  };
  let cur = src;
  while (cur.width / 2 >= w && cur.height / 2 >= h) {
    const next = canvasOf(Math.round(cur.width / 2), Math.round(cur.height / 2));
    ctxOf(next).drawImage(cur, 0, 0, next.width, next.height);
    cur = next;
  }
  if (!opaque && cur.width === w && cur.height === h) return cur;
  const out = canvasOf(w, h);
  ctxOf(out).drawImage(cur, 0, 0, w, h);
  return out;
}
`;
