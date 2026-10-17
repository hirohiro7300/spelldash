// 天球（Celestial）の書斎 — 場面の SVG。
// 色はすべて CSS 変数（--s-*）。昼／夜は CSS だけで切り替わる（.lt-day / .lt-night を片方だけ見せる）。
// 光: 昼＝北窓の光（左上から）、夜＝机のろうそく（本の左上）＋窓の月光。

let _seed = 7;
export const rnd = () => ((_seed = (_seed * 16807) % 2147483647) / 2147483647);
export const reseed = (s) => { _seed = s; };
export const f = (n) => Math.round(n * 100) / 100;
export const v = (name) => `var(--s-${name})`;
export const stops = (list) => list.map(([o, c, a]) => `<stop offset="${o}" style="stop-color:${c.startsWith("#") ? c : v(c)};stop-opacity:${a ?? 1}"/>`).join("");

// 縁の光: 形と、(dx,dy) ずらした形の差だけを白く残すマスク
export function rimMask(id, shapeRef, dx, dy, box = [-50, -50, 400, 400]) {
  return `<mask id="${id}" maskUnits="userSpaceOnUse" x="${box[0]}" y="${box[1]}" width="${box[2]}" height="${box[3]}">
    <use href="#${shapeRef}" fill="#fff"/><use href="#${shapeRef}" fill="#000" transform="translate(${dx} ${dy})"/></mask>`;
}

// 先細りの線（塗りの細い三日月）: p0 → p1 を、制御点 c で曲げ、幅 w
export function taper(p0, c, p1, w) {
  const [x0, y0] = p0, [cx, cy] = c, [x1, y1] = p1;
  const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1;
  const nx = -dy / L, ny = dx / L;
  return `M${f(x0)},${f(y0)} Q${f(cx + nx * w)},${f(cy + ny * w)} ${f(x1)},${f(y1)} Q${f(cx - nx * w * 0.2)},${f(cy - ny * w * 0.2)} ${f(x0)},${f(y0)} Z`;
}

// 4 本の光条をもつ小さな星（銅版画の星）。グリフではなくパス
export function star4(x, y, r, thin = 0.18) {
  const t = r * thin;
  return `M${f(x)},${f(y - r)} L${f(x + t)},${f(y - t)} L${f(x + r)},${f(y)} L${f(x + t)},${f(y + t)} L${f(x)},${f(y + r)} L${f(x - t)},${f(y + t)} L${f(x - r)},${f(y)} L${f(x - t)},${f(y - t)} Z`;
}
