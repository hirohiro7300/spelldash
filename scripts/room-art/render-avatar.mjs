// はちゃんのアバター（結果パネル・週間レポート・覚えたトースト用の 32px の丸）: 頭と肩の 3/4 を 96×96・192×192 の透過 PNG に。
// 使い方: node scripts/room-art/render-avatar.mjs → assets/images/hasumi.png, hasumi@2x.png, hasumi-happy.png, hasumi-happy@2x.png
import path from "path";
import { chromium } from "/home/user/spelldash/node_modules/playwright-core/index.mjs";
import { defs } from "./scene.mjs";
import { sceneLight, toCss } from "./tokens.mjs";
const OUT = "/home/user/spelldash/assets/images";
// happy: 目の線を上に反らせた弧と、口角を 1px 上げる（印は 3 つのまま）
const happy = `<g><path d="M65.6,151.2 Q68.2,148.6 70.8,151.2" fill="none" style="stroke:var(--s-face-ink)" stroke-width=".7" stroke-linecap="round"/>
  <ellipse cx="68.4" cy="151" rx="2.2" ry="1.4" style="fill:var(--s-skin-lit)"/>
  <path d="M65.6,151.2 Q68.2,148.6 70.8,151.2" fill="none" style="stroke:var(--s-face-ink)" stroke-width=".7" stroke-linecap="round"/>
  <path d="M71.6,159.9 Q72.8,160.6 73.6,159.2" fill="none" style="stroke:var(--s-face-ink)" stroke-width=".5" stroke-linecap="round"/>
  <ellipse cx="68.6" cy="158" rx="2.6" ry="1.6" style="fill:var(--s-cheek)" opacity=".4"/></g>`;
const html = (mood) => `<!doctype html><html><head><style>
  html,body{margin:0;background:transparent}
  :root{${toCss(sceneLight)}--hc-rim:.5;--hc-bounce:.3;--hc-warm:0}
  .lt-night{display:none}
  svg.av{display:block;width:96px;height:96px}
</style></head><body><svg width="0" height="0" style="position:absolute"><defs>${defs()}</defs></svg>
<svg class="av" viewBox="22 100 84 84" xmlns="http://www.w3.org/2000/svg"><use href="#hachan" x="0" y="0" width="200" height="260"/>${mood === "happy" ? happy : ""}</svg></body></html>`;
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
for (const mood of ["normal", "happy"]) for (const scale of [1, 2]) {
  const ctx = await browser.newContext({ viewport: { width: 96, height: 96 }, deviceScaleFactor: scale });
  const p = await ctx.newPage();
  await p.setContent(html(mood)); await p.waitForTimeout(200);
  const file = path.join(OUT, `hasumi${mood === "happy" ? "-happy" : ""}${scale === 2 ? "@2x" : ""}.png`);
  await p.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: 96, height: 96 } });
  console.log(file); await ctx.close();
}
await browser.close();
