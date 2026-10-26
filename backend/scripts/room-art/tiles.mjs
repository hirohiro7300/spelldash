// 素材のタイル（紙・漆喰・木目・革）を feTurbulence で描き、PNG → WebP にする。
// 使い方: node scripts/room-art/tiles.mjs [name…]   → assets/images/room/tile-*.webp
// どれも「中間の灰色 ±α」のタイル。CSS 側で mix-blend-mode / background-blend-mode: soft-light | overlay で重ねる。
import fs from "fs"; import path from "path"; import { execFileSync } from "child_process";
import { chromium } from "/home/user/spelldash/node_modules/playwright-core/index.mjs";
const OUT = "/home/user/spelldash/assets/images/room";
const ONLY = process.argv.slice(2); // 名前を渡すとそれだけ（例: node scripts/room-art/tiles.mjs stone）

// k = コントラスト（0.5±k*(n-0.5)）
const grey = (k, ch = "R") => {
  const r = ch === "R" ? `${k} 0 0 0 ${0.5 - k * 0.5}` : `0 ${k} 0 0 ${0.5 - k * 0.5}`;
  return `<feColorMatrix type="matrix" values="${r} ${r} ${r} 0 0 0 0 1"/>`;
};
const tiles = {
  // 紙: 繊維（細かい）＋むら（大きい）
  paper: { sd: 12, w: 256, h: 256, body: `
    <filter id="f" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.68" numOctaves="3" seed="3" stitchTiles="stitch" result="fib"/>
      <feColorMatrix in="fib" type="matrix" values="1.15 0 0 0 -0.075  1.15 0 0 0 -0.075  1.15 0 0 0 -0.075  0 0 0 0 1" result="fibg"/>
      <feTurbulence type="fractalNoise" baseFrequency="0.0117" numOctaves="3" seed="8" stitchTiles="stitch" result="mot"/>
      <feColorMatrix in="mot" type="matrix" values="1.6 0 0 0 -0.3  1.6 0 0 0 -0.3  1.6 0 0 0 -0.3  0 0 0 0 1" result="motg"/>
      <feBlend in="fibg" in2="motg" mode="overlay"/>
      ${grey(0.55)}
    </filter><rect width="256" height="256" filter="url(#f)"/>` },
  // 漆喰・石灰岩: 大きなむら＋細かい砂
  plaster: { sd: 12, w: 384, h: 384, body: `
    <filter id="f" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.0078" numOctaves="4" seed="21" stitchTiles="stitch" result="a"/>
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="5" stitchTiles="stitch" result="b"/>
      <feColorMatrix in="a" type="matrix" values="2 0 0 0 -0.5  2 0 0 0 -0.5  2 0 0 0 -0.5  0 0 0 0 1" result="ag"/>
      <feColorMatrix in="b" type="matrix" values="0.9 0 0 0 0.05  0.9 0 0 0 0.05  0.9 0 0 0 0.05  0 0 0 0 1" result="bg"/>
      <feBlend in="bg" in2="ag" mode="overlay"/>
      ${grey(0.5)}
    </filter><rect width="384" height="384" filter="url(#f)"/>` },
  // 石灰岩のむら（±3 L*）: 大きな雲状のむら＋小さな気孔
  stone: { sd: 13, w: 320, h: 320, body: `
    <filter id="f" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.011" numOctaves="4" seed="33" stitchTiles="stitch" result="a"/>
      <feTurbulence type="fractalNoise" baseFrequency="0.55" numOctaves="2" seed="12" stitchTiles="stitch" result="b"/>
      <feColorMatrix in="a" type="matrix" values="2.2 0 0 0 -0.6  2.2 0 0 0 -0.6  2.2 0 0 0 -0.6  0 0 0 0 1" result="ag"/>
      <feColorMatrix in="b" type="matrix" values="0.6 0 0 0 0.2  0.6 0 0 0 0.2  0.6 0 0 0 0.2  0 0 0 0 1" result="bg"/>
      <feBlend in="bg" in2="ag" mode="overlay"/>
      ${grey(0.5)}
    </filter><rect width="320" height="320" filter="url(#f)"/>` },
  // 木目（横に流れる板）: 引き伸ばしたノイズ＋導管
  wood: { sd: 24, w: 512, h: 256, body: `
    <filter id="f" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.0039 0.125" numOctaves="4" seed="11" stitchTiles="stitch" result="g"/>
      <feColorMatrix in="g" type="matrix" values="2.6 0 0 0 -0.8  2.6 0 0 0 -0.8  2.6 0 0 0 -0.8  0 0 0 0 1" result="gg"/>
      <feTurbulence type="fractalNoise" baseFrequency="0.035 0.9" numOctaves="2" seed="4" stitchTiles="stitch" result="p"/>
      <feColorMatrix in="p" type="matrix" values="1.2 0 0 0 -0.1  1.2 0 0 0 -0.1  1.2 0 0 0 -0.1  0 0 0 0 1" result="pg"/>
      <feBlend in="pg" in2="gg" mode="multiply" result="m"/>
      <feColorMatrix in="m" type="matrix" values="0.8 0 0 0 0.14  0.8 0 0 0 0.14  0.8 0 0 0 0.14  0 0 0 0 1"/>
    </filter><rect width="512" height="256" filter="url(#f)"/>` },
  // 漆の下に透ける木目（縦の框・扉用と、横の棚板用）。ごく弱い
  lacqv: { sd: 7, w: 128, h: 512, body: `
    <filter id="f" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.16 0.006" numOctaves="4" seed="27" stitchTiles="stitch" result="g"/>
      <feColorMatrix in="g" type="matrix" values="2.4 0 0 0 -0.7  2.4 0 0 0 -0.7  2.4 0 0 0 -0.7  0 0 0 0 1"/>
    </filter><rect width="128" height="512" filter="url(#f)"/>` },
  lacqh: { sd: 7, w: 512, h: 128, body: `
    <filter id="f" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.006 0.16" numOctaves="4" seed="29" stitchTiles="stitch" result="g"/>
      <feColorMatrix in="g" type="matrix" values="2.4 0 0 0 -0.7  2.4 0 0 0 -0.7  2.4 0 0 0 -0.7  0 0 0 0 1"/>
    </filter><rect width="512" height="128" filter="url(#f)"/>` },
  // 革: しぼ（小さな粒）を左上の光で浮き出す
  leather: { sd: 16, w: 160, h: 160, body: `
    <filter id="f" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.5" numOctaves="2" seed="9" stitchTiles="stitch" result="n"/>
      <feDiffuseLighting in="n" surfaceScale="1.6" diffuseConstant="1" lighting-color="#fff" result="l">
        <feDistantLight azimuth="225" elevation="52"/>
      </feDiffuseLighting>
      <feColorMatrix type="matrix" values="0.7 0 0 0 0.12  0.7 0 0 0 0.12  0.7 0 0 0 0.12  0 0 0 0 1"/>
    </filter><rect width="160" height="160" filter="url(#f)"/>` },
};

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 600, height: 600 }, deviceScaleFactor: 1 });
const p = await ctx.newPage();
for (const [name, t] of Object.entries(tiles)) {
  if (ONLY.length && !ONLY.includes(name)) continue;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${t.w}" height="${t.h}" viewBox="0 0 ${t.w} ${t.h}">${t.body}</svg>`;
  await p.setContent(`<html><body style="margin:0;background:#808080">${svg}</body></html>`);
  const png = path.join(OUT, `tile-${name}.png`);
  await p.locator("svg").screenshot({ path: png });
  execFileSync("python3", ["-I", "-c", `
from PIL import Image, ImageStat
im = Image.open(${JSON.stringify(png)}).convert("L")
st = ImageStat.Stat(im)
m, sd = st.mean[0], st.stddev[0]
im = im.point(lambda v: max(0, min(255, round(128 + (v - m) * ${t.sd} / sd))))
st2 = ImageStat.Stat(im)
print("${name}", im.size, "mean", round(m,1), "sd", round(sd,1), "->", round(st2.mean[0],1), round(st2.stddev[0],1))
im.save(${JSON.stringify(png.replace(/\.png$/, ".webp"))}, "WEBP", quality=72, method=6)
`], { stdio: "inherit" });
  fs.unlinkSync(png);
}
await browser.close();
for (const f of fs.readdirSync(OUT).filter((f) => f.startsWith("tile-"))) console.log(f, fs.statSync(path.join(OUT, f)).size);
