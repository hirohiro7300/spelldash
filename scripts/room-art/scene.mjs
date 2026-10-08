// 天球（Celestial）の書斎: 場面の SVG を組み立てる（スマホ 390 と PC の 2 つの構図）。
// 色はすべて CSS 変数（--s-*）で、テーマは CSS だけで切り替わる。
import { f, v, stops } from "./art-head.mjs";
import { symWindow, WIN } from "./figures.mjs";
import { symHachan, HC } from "./hachan.mjs";
import { symArmillary, symChart, symCandle, symInk, symGlobeShelf, symFlatBooks } from "./props.mjs";

export function defs() {
  return `
  <linearGradient id="g-brass" x1="0" y1="0" x2="1" y2="1">${stops([[0, "#3E2C12"], [0.22, "#8A6A30"], [0.36, "#F3D58A"], [0.4, "#C9A35A"], [0.62, "#9C7A3C"], [1, "#3E2C12"]])}</linearGradient>
  <linearGradient id="g-brass-h" x1="0" y1="0" x2="1" y2="0">${stops([[0, "#4A3414"], [0.18, "#9C7A3C"], [0.3, "#F6E2A8"], [0.34, "#C9A35A"], [0.7, "#8A6A30"], [1, "#3E2C12"]])}</linearGradient>
  <linearGradient id="g-brass-v" x1="0" y1="0" x2="0" y2="1">${stops([[0, "#F3D58A"], [0.12, "#C9A35A"], [0.55, "#8A6A30"], [1, "#3E2C12"]])}</linearGradient>
  <linearGradient id="g-foil" x1="0" y1="0" x2="1" y2="0.2">${stops([[0, "#6E4E1E"], [0.35, "#B98A3E"], [0.48, "#F3D58A"], [0.56, "#A97A32"], [1, "#6B4A1C"]])}</linearGradient>
  <filter id="fx-soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.2"/></filter>
  <filter id="fx-hair" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="0.35"/></filter>
  <filter id="fx-flame" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="0.8"/></filter>
  <!-- 壁に落ちる影（光は左上 → 右下へ）。物そのものは描かず、影だけを返す -->
  <filter id="fx-cast" x="-20%" y="-20%" width="160%" height="150%" color-interpolation-filters="sRGB">
    <feGaussianBlur in="SourceAlpha" stdDeviation="3.2"/><feOffset dx="7" dy="3" result="b"/>
    <feFlood style="flood-color:${v("shadow")}" flood-opacity=".26"/><feComposite in2="b" operator="in"/>
  </filter>
  <filter id="fx-cast-sm" x="-20%" y="-20%" width="160%" height="150%" color-interpolation-filters="sRGB">
    <feGaussianBlur in="SourceAlpha" stdDeviation="2"/><feOffset dx="4" dy="2" result="b"/>
    <feFlood style="flood-color:${v("shadow")}" flood-opacity=".28"/><feComposite in2="b" operator="in"/>
  </filter>
  <pattern id="pt-hatch" width="1.6" height="1.6" patternUnits="userSpaceOnUse" patternTransform="rotate(38)"><rect width="1.6" height="0.32" style="fill:${v("engr")}"/></pattern>
  <pattern id="pt-hatch-hc" width="1.3" height="1.3" patternUnits="userSpaceOnUse" patternTransform="rotate(-52)"><rect width="1.3" height="0.3" style="fill:${v("robe-dk")}"/></pattern>
  <pattern id="pt-stipple" width="3" height="3" patternUnits="userSpaceOnUse"><circle cx="0.7" cy="0.8" r="0.28" style="fill:${v("engr")}"/><circle cx="2.2" cy="2.3" r="0.22" style="fill:${v("engr")}"/></pattern>
  ${symHachan()}
  ${symWindow()}
  ${symArmillary()}
  ${symChart()}
  ${symCandle()}
  ${symInk()}
  ${symGlobeShelf()}
  ${symFlatBooks()}
  `;
}

const use = (id, x, y, w, h, extra = "") => `<use href="#${id}" x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" ${extra}/>`;

// 構図: 窓（はちゃん）・紙片の位置・壁の額・机の上の燭台・インク壺・渾天儀（PC は壁の棚と寝かせた本も）
// 返す値: SVG と、光源（炎）の位置（CSS の光の溜まりに使う）
function compose(c) {
  const [W, H] = c.vb;
  const ws = c.win.s, hs = ws * 0.72;
  const seatY = c.win.y + WIN.seatTop * ws;
  const hx = c.win.x + (WIN.L + 3) * ws - HC.left * hs, hy = seatY - HC.seat * hs;
  const cd = c.candle, flame = [cd.x + 20 * cd.s, cd.y + 14 * cd.s];
  const svg = `<svg class="scene ${c.cls}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true" focusable="false">
    <!-- 壁に落ちる影（昼は窓 → 右下、夜はろうそく → 外側へ） -->
    ${use("chart", c.chart.x, c.chart.y, c.chart.s, c.chart.s, 'filter="url(#fx-cast)"')}
    ${c.shelf ? use("globeshelf", c.shelf.x, c.shelf.y, 90 * c.shelf.s, 80 * c.shelf.s, 'filter="url(#fx-cast)"') : ""}
    ${use("armillary", c.arm.x, c.arm.y, 90 * c.arm.s, 120 * c.arm.s, 'filter="url(#fx-cast)" class="lt-day"')}
    ${use("candle", cd.x, cd.y, 40 * cd.s, 70 * cd.s, 'filter="url(#fx-cast-sm)" class="lt-day"')}
    <!-- 窓とはちゃん（腰掛けのクッションの上、窓の開口の内側） -->
    ${use("win", c.win.x, c.win.y, WIN.w * ws, WIN.h * ws)}
    ${use("hachan", hx, hy, HC.w * hs, HC.h * hs)}
    <!-- 壁の額（銅版画の星図）と棚 -->
    ${use("chart", c.chart.x, c.chart.y, c.chart.s, c.chart.s)}
    ${c.shelf ? use("globeshelf", c.shelf.x, c.shelf.y, 90 * c.shelf.s, 80 * c.shelf.s) : ""}
    <!-- 机の奥の道具 -->
    ${c.books ? use("flatbooks", c.books.x, c.books.y, 70 * c.books.s, 22 * c.books.s) : ""}
    ${use("candle", cd.x, cd.y, 40 * cd.s, 70 * cd.s)}
    ${use("ink", c.ink.x, c.ink.y, 30 * c.ink.s, 34 * c.ink.s)}
    ${use("armillary", c.arm.x, c.arm.y, 90 * c.arm.s, 120 * c.arm.s)}
  </svg>`;
  return { svg, flame, glass: [c.win.x + WIN.cx * ws, c.win.y + (WIN.S + 20) * ws], hc: [hx, hy, hs] };
}

// スマホ（390×262、ヘッダーと天井の帯を含む。机の奥の縁 y=240）
export const PHONE = {
  vb: [390, 262], cls: "scene--phone", deskTop: 240,
  win: { x: 6, y: 70, s: 1 },
  candle: { x: 166, y: 196, s: 0.7 }, chart: { x: 300, y: 100, s: 66 },
  arm: { x: 302, y: 160, s: 0.72 }, ink: { x: 226, y: 223, s: 0.78 },
};
// 背の低いスマホ（高さ 700px 以下）: 部屋の帯を詰める（机の奥の縁 y=172）
export const SHORT = {
  vb: [390, 194], cls: "scene--short", deskTop: 172,
  win: { x: 10, y: 58, s: 0.66 },
  candle: { x: 160, y: 134, s: 0.56 }, chart: { x: 306, y: 70, s: 54 },
  arm: { x: 306, y: 112, s: 0.52 }, ink: { x: 214, y: 156, s: 0.64 },
};
// PC（机の列 640×430、机の奥の縁 y=398）
export const DESK = {
  vb: [640, 430], cls: "scene--desk", deskTop: 398,
  win: { x: 8, y: 104, s: 1.7 },
  candle: { x: 262, y: 300, s: 1.46 }, chart: { x: 494, y: 118, s: 100 },
  arm: { x: 520, y: 276, s: 1.05 }, ink: { x: 438, y: 366, s: 1.1 },
  shelf: { x: 292, y: 96, s: 1.5 }, books: { x: 338, y: 378, s: 1.15 },
};
export const PH = compose(PHONE), SH = compose(SHORT), DK = compose(DESK);
export const scenePhone = () => PH.svg;
export const sceneShort = () => SH.svg;
export const sceneDesk = () => DK.svg;
