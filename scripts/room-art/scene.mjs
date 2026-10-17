// 天球（Celestial）の書斎: 場面の SVG を組み立てる（スマホ 390・背の低いスマホ・PC の 3 つの構図）。
// 色はすべて CSS 変数（--s-*）で、テーマは CSS だけで切り替わる。
import { f, v, stops } from "./art-head.mjs";
import { symWindow, WIN } from "./figures.mjs";
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
  <pattern id="pt-stipple" width="3" height="3" patternUnits="userSpaceOnUse"><circle cx="0.7" cy="0.8" r="0.28" style="fill:${v("engr")}"/><circle cx="2.2" cy="2.3" r="0.22" style="fill:${v("engr")}"/></pattern>
  ${figureFilters()}
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

// ================= 窓辺のはちゃん（創業者が用意した絵 010 読書。scripts/build-hasumi.mjs が scripts/room-art/figure-reading.webp に切り出す） =================
// 置き方（窓の座標 WIN の単位。開口は L16〜R124 の 108、腰掛けの上面 143）: 幅 w、左は開口の左端 + dx、下は腰掛けの上面 + dy（裾と靴が腰掛けの前に少しかかる）。
// 幅は開口の 0.6 強（夜の窓の月を隠さない・机の紙片とスタートより目立たない）。
export const FIGURE = { w: 66, dx: 9, dy: 3 };

// 色の寄せ（4×5 の色の行列）: 彩度 sat → 色ごとの利き gain → コントラスト contrast（0.5 を中心に）
function grade({ sat, gain, contrast }) {
  const L = [0.2126, 0.7152, 0.0722];
  const rows = [0, 1, 2].map((i) => {
    const row = L.map((l, j) => (i === j ? l + (1 - l) * sat : l * (1 - sat)) * gain[i] * contrast);
    return [...row, 0, (0.5 * (1 - contrast)) * gain[i]];
  });
  return [...rows, [0, 0, 0, 1, 0]].flat().map((n) => Math.round(n * 10000) / 10000).join(" ");
}
// 縁の光: 形と、(dx,dy) ずらした形の差（形の内側の細い帯）を少しぼかし、形の中に収めて色を付ける。単位は絵の外接矩形に対する割合（スマホと PC で同じ見え方）
const edge = (id, dx, dy, blur, color, opacity) => `
    <feOffset in="SourceAlpha" dx="${dx}" dy="${dy}" result="${id}-s"/>
    <feComposite in="SourceAlpha" in2="${id}-s" operator="out" result="${id}-e"/>
    <feGaussianBlur in="${id}-e" stdDeviation="${blur}" result="${id}-b"/>
    <feComposite in="${id}-b" in2="SourceAlpha" operator="in" result="${id}-m"/>
    <feFlood style="flood-color:${v(color)}" flood-opacity="${opacity}"/>
    <feComposite in2="${id}-m" operator="in" result="${id}"/>`;
// 昼: 光は背後の北窓（左上）。絵は前から照らした厚塗りなので、北窓の冷たい昼に寄せ（彩度・赤を引く・コントラストを浅く）、
//     左上の縁に窓の光、部屋側（右）に机からの弱い照り返し。
// 夜: 部屋の光はろうそく（右の机の上）、窓の外は月。暗く暖かく沈め、上の縁に月の光（つばと帽子の山が暗い空に沈まない）、右の縁にろうそくの照り返し。
// rim・bounce: [dx, dy, ぼかし, 不透明さ]（絵の外接矩形に対する割合）。rimFade: 縁の光の強さを上 → 下で [上, 中ほど, 下] に（光は上から。裾まで同じ強さだと切り抜きの白い縁に見える）
export const FIG_LOOK = {
  day: { grade: { sat: 0.84, gain: [0.94, 0.96, 1.0], contrast: 0.92 }, rim: [0.012, 0.011, 0.0025, 0.85], rimFade: [1, 0.6, 0.2], bounce: [-0.01, 0.002, 0.003, 0.2] },
  night: { grade: { sat: 0.78, gain: [0.66, 0.6, 0.55], contrast: 0.96 }, rim: [0.005, 0.016, 0.0022, 1], rimFade: [1, 0.5, 0.1], bounce: [-0.012, 0.003, 0.004, 0.45] },
};
function figureFilters() {
  return Object.entries(FIG_LOOK).map(([k, o]) => `
  <filter id="fx-fig-${k}" x="-4%" y="-4%" width="108%" height="108%" primitiveUnits="objectBoundingBox" color-interpolation-filters="sRGB">
    <feColorMatrix in="SourceGraphic" type="matrix" values="${grade(o.grade)}" result="base"/>${edge("bounce", ...o.bounce.slice(0, 3), "bounce", o.bounce[3])}
    <feMerge><feMergeNode in="base"/><feMergeNode in="bounce"/></feMerge>
  </filter>
  <filter id="fx-fig-${k}-rim" x="-4%" y="-4%" width="108%" height="108%" primitiveUnits="objectBoundingBox" color-interpolation-filters="sRGB">${edge("rim", ...o.rim.slice(0, 3), "rim", o.rim[3])}
  </filter>
  <linearGradient id="g-fig-${k}-rim" x1="0" y1="0" x2="0" y2="1">${stops([[0, "#fff", o.rimFade[0]], [0.5, "#fff", o.rimFade[1]], [1, "#fff", o.rimFade[2]]])}</linearGradient>
  <mask id="m-fig-${k}-rim" maskContentUnits="objectBoundingBox"><rect width="1" height="1" fill="url(#g-fig-${k}-rim)"/></mask>`).join("");
}
// 窓辺の絵を腰掛けに置く。腰掛けに落ちる影（接地。昼は窓の光で右下へ短く、夜はろうそくで左へ薄く）＋昼と夜（.lt-day／.lt-night を片方だけ見せる）。
// 絵は 1 度だけ置き（<defs>）、色を寄せた本体と縁の光を <use> で重ねる
function figureAt(c, fig, seatY, place) {
  const ws = c.win.s, w = place.w * ws, h = w * fig.aspect;
  const x = c.win.x + (WIN.L + place.dx) * ws, y = seatY + place.dy * ws - h;
  const id = `fig-${c.cls}`;
  const shadow = (cls, cx, op) => `<ellipse cx="${f(x + w * cx)}" cy="${f(seatY + 1.2 * ws)}" rx="${f(w * 0.44)}" ry="${f(2.6 * ws)}" style="fill:${v("shadow")}" opacity="${op}" filter="url(#fx-soft)" class="${cls}"/>`
    + `<ellipse cx="${f(x + w * cx)}" cy="${f(seatY + 0.6 * ws)}" rx="${f(w * 0.3)}" ry="${f(1.1 * ws)}" style="fill:${v("shadow")}" opacity="${op}" filter="url(#fx-hair)" class="${cls}"/>`;
  const look = (k) => `<g class="lt-${k}"><use href="#${id}" filter="url(#fx-fig-${k})"/><use href="#${id}" filter="url(#fx-fig-${k}-rim)" mask="url(#m-fig-${k}-rim)"/></g>`;
  return `<defs><image id="${id}" href="${fig.href}" x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" preserveAspectRatio="none"/></defs>`
    + `${shadow("lt-day", 0.56, 0.5)}${shadow("lt-night", 0.46, 0.34)}${look("day")}${look("night")}`;
}

// 構図: 窓（窓辺のはちゃん）・紙片の位置・壁の額・机の上の燭台・インク壺・渾天儀（PC は壁の棚と寝かせた本も）
// figure: 窓辺の絵（{ href: data URL, aspect: 高さ／幅 }。render.mjs が figure-reading.webp から渡す）
// 返す値: SVG と、光源（炎）の位置（CSS の光の溜まりに使う）
export function compose(c, figure, place = FIGURE) {
  if (!figure) throw new Error("窓辺の絵（figure）が要る");
  const [W, H] = c.vb;
  const ws = c.win.s;
  const seatY = c.win.y + WIN.seatTop * ws;
  const cd = c.candle, flame = [cd.x + 20 * cd.s, cd.y + 14 * cd.s];
  const svg = `<svg class="scene ${c.cls}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true" focusable="false">
    <!-- 壁に落ちる影（昼は窓 → 右下、夜はろうそく → 外側へ） -->
    ${use("chart", c.chart.x, c.chart.y, c.chart.s, c.chart.s, 'filter="url(#fx-cast)"')}
    ${c.shelf ? use("globeshelf", c.shelf.x, c.shelf.y, 90 * c.shelf.s, 80 * c.shelf.s, 'filter="url(#fx-cast)"') : ""}
    ${use("armillary", c.arm.x, c.arm.y, 90 * c.arm.s, 120 * c.arm.s, 'filter="url(#fx-cast)" class="lt-day"')}
    ${use("candle", cd.x, cd.y, 40 * cd.s, 70 * cd.s, 'filter="url(#fx-cast-sm)" class="lt-day"')}
    <!-- 窓とはちゃん（腰掛けのクッションの上、窓の開口の内側） -->
    ${use("win", c.win.x, c.win.y, WIN.w * ws, WIN.h * ws)}
    ${figureAt(c, figure, seatY, place)}
    <!-- 壁の額（銅版画の星図）と棚 -->
    ${use("chart", c.chart.x, c.chart.y, c.chart.s, c.chart.s)}
    ${c.shelf ? use("globeshelf", c.shelf.x, c.shelf.y, 90 * c.shelf.s, 80 * c.shelf.s) : ""}
    <!-- 机の奥の道具 -->
    ${c.books ? use("flatbooks", c.books.x, c.books.y, 70 * c.books.s, 22 * c.books.s) : ""}
    ${use("candle", cd.x, cd.y, 40 * cd.s, 70 * cd.s)}
    ${use("ink", c.ink.x, c.ink.y, 30 * c.ink.s, 34 * c.ink.s)}
    ${use("armillary", c.arm.x, c.arm.y, 90 * c.arm.s, 120 * c.arm.s)}
  </svg>`;
  return { svg, flame, glass: [c.win.x + WIN.cx * ws, c.win.y + (WIN.S + 20) * ws] };
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
// 場面の 3 つの構図（render.mjs が順に焼く。名前はファイル名 scene-<name>-<theme>.webp の <name>）
export const SCENES = { phone: PHONE, short: SHORT, desk: DESK };
