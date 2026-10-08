// 場面（窓・はちゃん・壁の額と棚・机の奥の道具・壁に落ちる影）を 2x の WebP に焼く。
// 使い方: node scripts/room-art/render.mjs  → assets/images/room/scene-{phone,short,desk}-{light,dark}.webp
// 背景は透明（壁・光の溜まり・机・本・本棚は CSS と DOM のまま）。テーマごとに 1 枚、CSS が [data-theme] と prefers-color-scheme で切り替える。
import fs from "fs"; import path from "path"; import { execFileSync } from "child_process";
import { chromium } from "/home/user/spelldash/node_modules/playwright-core/index.mjs";
import { defs, PH, SH, DK, PHONE, SHORT, DESK } from "./scene.mjs";
import { sceneLight, sceneDark, toCss } from "./tokens.mjs";
// 出力先: 本番の画像（css/room.css が読む）
const OUT = "/home/user/spelldash/assets/images/room";
const FIG = { light: { rim: 0.9, bounce: 0.3, warm: 0.2 }, dark: { rim: 0.72, bounce: 0.6, warm: 0.85 } };
const html = (theme, svg) => `<!doctype html><html><head><style>
  html,body{margin:0;background:transparent}
  :root{${toCss(theme === "dark" ? sceneDark : sceneLight)}--hc-rim:${FIG[theme].rim};--hc-bounce:${FIG[theme].bounce};--hc-warm:${FIG[theme].warm}}
  .lt-${theme === "dark" ? "day" : "night"}{display:none}
  svg.scene{display:block}
</style></head><body><svg width="0" height="0" style="position:absolute"><defs>${defs()}</defs></svg>${svg}</body></html>`;
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const sizes = {};
for (const [name, comp, cfg] of [["phone", PH, PHONE], ["short", SH, SHORT], ["desk", DK, DESK]]) for (const theme of ["light", "dark"]) {
  const [W, H] = cfg.vb;
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
  const p = await ctx.newPage(); const errs = [];
  p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  await p.setContent(html(theme, comp.svg)); await p.waitForTimeout(250);
  const png = path.join(OUT, `_scene-${name}-${theme}.png`), webp = path.join(OUT, `scene-${name}-${theme}.webp`);
  await p.screenshot({ path: png, omitBackground: true, clip: { x: 0, y: 0, width: W, height: H } });
  execFileSync("python3", ["-I", "-c", `from PIL import Image; im=Image.open(${JSON.stringify(png)}); im.save(${JSON.stringify(webp)}, "WEBP", quality=${name === "desk" ? 72 : 80}, method=6, alpha_quality=${name === "desk" ? 66 : 80})`]);
  fs.unlinkSync(png);
  sizes[`${name}-${theme}`] = Math.round(fs.statSync(webp).size / 1024) + "KB";
  if (errs.length) console.log(name, theme, errs.join(" | "));
  await ctx.close();
}
await browser.close();
console.log("scene webp", JSON.stringify(sizes));
