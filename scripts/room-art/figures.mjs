import { v, stops, reseed, rnd } from "./art-head.mjs";
const f = (n) => Math.round(n * 10) / 10;

// ================= 窓（半円アーチ・2 つの小アーチ・四つ葉の円窓・鉛の菱格子・深い腰掛け） =================
// 寸法は viewBox の単位。スマホでは 1 単位 ≒ 1px。PC では 1.6 倍で使う。
// ガラス x L..R、頂 T、起拱線 S、敷居（座面の石）B。はちゃんは座面 B-7（クッションの上）に座る。
export const WIN = { w: 140, h: 172, L: 16, R: 124, T: 14, S: 68, B: 150, cx: 70, r: 54, seatTop: 143 };

function arcPts(cx, cy, r, a0, a1, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) { const a = a0 + ((a1 - a0) * i) / n; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return pts;
}
const poly = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${f(p[0])},${f(p[1])}`).join(" ");

export function symWindow() {
  const { w, h, L, R, T, S, B, cx, r } = WIN;
  const bw = 2.6;                       // 石の桟の幅
  const r2 = (r - bw / 2) / 2;          // 小アーチの半径
  const xs1 = L + r2, xs2 = R - r2;     // 小アーチの中心
  const ro = (r * (r - r2)) / (r + r2) - 0.6; // 円窓の半径（主アーチ・小アーチに接する）
  const yo = S - (r - ro) + 0.4;
  const glass = `M${L},${B} L${L},${S} A${r},${r} 0 0 1 ${R},${S} L${R},${B} Z`;
  // 鉛の菱格子（小アーチの下・2 つの明かりの中）
  const qw = 15, qh = 22;
  let cames = "", quarries = "", stain = "";
  const qa = [], qb = [];
  reseed(41);
  const lights = [[L, cx - bw / 2], [cx + bw / 2, R]];
  for (const [x0, x1] of lights) {
    const mid = (x0 + x1) / 2;
    for (let k = -8; k <= 8; k++) {
      const xa = mid + k * qw;
      cames += `M${f(xa)},${S - 30} L${f(xa + ((B - S + 34) * qw) / (2 * qh))},${B + 4} `;
      cames += `M${f(xa)},${S - 30} L${f(xa - ((B - S + 34) * qw) / (2 * qh))},${B + 4} `;
    }
    const r2i = r2 - bw / 2, xc = x0 < cx ? xs1 : xs2;
    for (let row = -4; row < 12; row++) for (let col = -4; col < 5; col++) {
      const x = mid + col * qw + (row % 2 ? qw / 2 : 0), y = S - 30 + row * (qh / 2);
      const t = rnd(), o = 0.03 + rnd() * 0.07;
      // 明かりの中（小アーチの下）にかかる菱だけを描く
      const yc = y + qh / 2;
      if (x < x0 - qw / 2 || x > x1 + qw / 2 || yc > B + qh / 2) continue;
      if (yc < S && Math.hypot(x - xc, Math.max(0, S - yc - qh / 2)) > r2i + qw / 2) continue;
      (t > 0.5 ? qa : qb).push(`<path d="M${f(x)} ${f(y)}l${f(qw / 2)} ${f(qh / 2)} ${f(-qw / 2)} ${f(qh / 2)} ${f(-qw / 2)} ${f(-qh / 2)}z" opacity="${f(o)}"/>`);
    }
  }
  // 琥珀の小さな菱 2 枚（縁に沿って光を受ける。星の印は置かない）
  for (const [x, y, o] of [[L + qw * 0.55, B - qh * 0.9, 0.3], [R - qw * 0.6, S + qh * 0.35, 0.26]]) {
    stain += `<path d="M${f(x)},${f(y - qh / 2)} l${f(qw / 2)},${f(qh / 2)} l${f(-qw / 2)},${f(qh / 2)} l${f(-qw / 2)},${f(-qh / 2)} Z" style="fill:${v("stain")}" opacity="${o}"/><path d="M${f(x - qw / 2 + 1.4)},${f(y)} L${f(x)},${f(y - qh / 2 + 2)}" style="stroke:#fff" stroke-width=".5" opacity="${f(o * 1.2)}"/>`;
  }
  // 円窓の四つ葉
  const ri = ro - bw * 0.9;
  const foil = [0, 1, 2, 3].map((i) => { const a = (i * Math.PI) / 2; return `<circle cx="${f(cx + ri * 0.42 * Math.cos(a))}" cy="${f(yo + ri * 0.42 * Math.sin(a))}" r="${f(ri * 0.48)}"/>`; }).join("");
  const lightL = `M${L + bw / 2},${B + 2} L${L + bw / 2},${S} A${r2 - bw / 2},${r2 - bw / 2} 0 0 1 ${cx - bw},${S} L${cx - bw},${B + 2} Z`;
  const lightR = `M${cx + bw},${B + 2} L${cx + bw},${S} A${r2 - bw / 2},${r2 - bw / 2} 0 0 1 ${R - bw / 2},${S} L${R - bw / 2},${B + 2} Z`;
  // 脇の小円窓: 主アーチ・小アーチ・円窓から等しく離れた点（内接円）に置く
  let best = [0, 0, 0];
  for (let x = L; x < cx; x += 0.25) for (let y = T; y < S; y += 0.25) {
    const dm = r - Math.hypot(x - cx, y - S), ds = Math.hypot(x - xs1, y - S) - (r2 + bw / 2), dO = Math.hypot(x - cx, y - yo) - ro;
    const d = Math.min(dm, ds, dO);
    if (d > best[2]) best = [x, y, d];
  }
  const spX = cx - best[0], spY = best[1], spR = Math.max(1.6, best[2] - bw * 0.7);
  const spandrels = [-1, 1].map((g) => `<circle cx="${f(cx + g * spX)}" cy="${f(spY)}" r="${f(spR)}"/>`).join("");
  // 遠景（昼）: 地平線と遠い天文台の塔 1 本。ぼかさず（遠さは濃さで）、低いコントラスト
  const hz = B - 30;
  const far = `M${L},${hz + 1.5} C${L + 20},${hz - 2.5} ${L + 40},${hz - 1} ${cx},${hz - 2.8} C${cx + 20},${hz - 4.4} ${R - 20},${hz - 1.4} ${R},${hz - 2} L${R},${B + 4} L${L},${B + 4} Z`;
  const tx = cx + 30, ty = hz - 2.6;
  const tower = `M${tx - 3.2},${ty} L${tx - 2.6},${ty - 26} L${tx - 3.4},${ty - 26.6} L${tx - 3.4},${ty - 28} L${tx + 3.4},${ty - 28} L${tx + 3.4},${ty - 26.6} L${tx + 2.6},${ty - 26} L${tx + 3.2},${ty} Z M${tx - 3},${ty - 28} A3.4,3.4 0 0 1 ${tx + 3},${ty - 28} Z M${tx - .3},${ty - 31.2} L${tx - .3},${ty - 34} L${tx + .3},${ty - 34} L${tx + .3},${ty - 31.2} Z`;
  // 外枠の石（モールディング 3 段＋要石）
  const ring = (o) => `M${L - o},${B + 2} L${L - o},${S} A${r + o},${r + o} 0 0 1 ${R + o},${S} L${R + o},${B + 2}`;
  return `
  <symbol id="win" viewBox="0 0 ${w} ${h}" overflow="visible">
    <defs>
      <clipPath id="win-clip"><path d="${glass}"/></clipPath>
      <clipPath id="win-lights"><path d="${lightL}"/><path d="${lightR}"/></clipPath>
      <filter id="win-haze" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation=".45"/></filter>
      <linearGradient id="win-hz" x1="0" y1="0" x2="0" y2="1">${stops([[0, "sky-glow", 0], [0.55, "sky-glow", 0.55], [1, "sky-glow", 0]])}</linearGradient>
      <linearGradient id="win-sky" x1="0" y1="${T}" x2="0" y2="${hz}" gradientUnits="userSpaceOnUse">${stops([[0, "sky1"], [0.55, "sky2"], [0.92, "sky3"], [1, "sky-hz"]])}</linearGradient>
      <linearGradient id="win-far" x1="0" y1="${hz - 26}" x2="0" y2="${B}" gradientUnits="userSpaceOnUse">${stops([[0, "far"], [1, "far-2"]])}</linearGradient>
      <linearGradient id="win-rev-l" x1="0" y1="0" x2="1" y2="0">${stops([[0, "stone-sh"], [1, "stone-lit"]])}</linearGradient>
      <linearGradient id="win-rev-r" x1="1" y1="0" x2="0" y2="0">${stops([[0, "stone-dk"], [1, "stone-sh"]])}</linearGradient>
      <linearGradient id="win-sill" x1="0" y1="0" x2="0" y2="1">${stops([[0, "stone-lit"], [1, "stone"]])}</linearGradient>
      <linearGradient id="win-mould" x1="0" y1="0" x2="1" y2="1">${stops([[0, "stone-lit"], [0.5, "stone"], [1, "stone-sh"]])}</linearGradient>
      <linearGradient id="win-bar" x1="0" y1="0" x2="1" y2="0">${stops([[0, "bar-lit"], [0.35, "bar"], [1, "bar-dk"]])}</linearGradient>
      <radialGradient id="win-glow" cx="0.5" cy="0.62" r="0.6">${stops([[0, "sky-glow", 0.5], [0.5, "sky-glow", 0.16], [1, "sky-glow", 0]])}</radialGradient>
      <linearGradient id="win-soffit" x1="0" y1="0" x2="0" y2="1">${stops([[0, "shadow", 0.42], [1, "shadow", 0]])}</linearGradient>
      <linearGradient id="win-cush" x1="0" y1="0" x2="0" y2="1">${stops([[0, "cushion-lit"], [0.4, "cushion"], [1, "robe-dk"]])}</linearGradient>
      <linearGradient id="win-spec" x1="0" y1="0" x2="1" y2="0">${stops([["0", "#fff", 0], [0.5, "#fff", 0.5], [1, "#fff", 0]])}</linearGradient>
    </defs>
    <!-- 壁に落ちる窓の陰（外枠の右下） -->
    <path d="M${R + 10},${S} A${r + 10},${r + 10} 0 0 0 ${cx},${T - 10} L${cx + 5},${T - 7} A${r + 10},${r + 10} 0 0 1 ${R + 14},${S + 3} L${R + 14},${B + 14} L${R + 10},${B + 14} Z" style="fill:${v("shadow")}" opacity=".2" filter="url(#fx-soft)"/>
    <!-- 外枠の石 -->
    <path d="${ring(10)} Z" fill="url(#win-mould)"/>
    <path d="${ring(10)}" fill="none" style="stroke:${v("stone-dk")}" stroke-width=".8" opacity=".5"/>
    <path d="${ring(8.2)}" fill="none" style="stroke:${v("stone-lit")}" stroke-width="1"/>
    <path d="${ring(6.4)}" fill="none" style="stroke:${v("stone-dk")}" stroke-width=".55" opacity=".5"/>
    <path d="${ring(4.4)}" fill="none" style="stroke:${v("stone-lit")}" stroke-width=".7" opacity=".8"/>
    <!-- 要石 -->
    <path d="M${cx - 6.5},${T - 13} L${cx + 6.5},${T - 13} L${cx + 4.6},${T + 1} L${cx - 4.6},${T + 1} Z" style="fill:${v("stone-lit")}"/>
    <path d="M${cx + 6.5},${T - 13} L${cx + 4.6},${T + 1} L${cx - 4.6},${T + 1}" fill="none" style="stroke:${v("stone-dk")}" stroke-width=".6" opacity=".6"/>
    <path d="M${cx - 3.4},${T - 8.4} L${cx + 3.4},${T - 8.4}" fill="none" stroke="url(#g-foil)" stroke-width=".45"/>
    <!-- 窓の奥行き（側壁・アーチの裏） -->
    <path d="M${L - 4},${B} L${L - 4},${S} A${r + 4},${r + 4} 0 0 1 ${R + 4},${S} L${R + 4},${B} L${R},${B} L${R},${S} A${r},${r} 0 0 0 ${L},${S} L${L},${B} Z" style="fill:${v("stone-sh")}"/>
    <!-- 空とガラス -->
    <g clip-path="url(#win-clip)">
      <rect x="0" y="0" width="${w}" height="${h}" fill="url(#win-sky)"/>
      <g class="lt-night">
        <path d="M${cx + 16},${S - 10} a6.4,6.4 0 1 0 4.8,10.6 a5.2,5.2 0 1 1 -4.8,-10.6 Z" style="fill:${v("moon")}"/>
        <circle cx="${cx + 15}" cy="${S - 4}" r="13" style="fill:${v("moon")}" opacity=".08"/>
        <g style="fill:${v("star")}">
          <circle cx="${L + 14}" cy="${S + 6}" r=".8"/><circle cx="${L + 30}" cy="${S + 24}" r=".45"/><circle cx="${cx - 8}" cy="${T + 18}" r=".5"/>
          <circle cx="${cx + 14}" cy="${S + 30}" r=".5"/><circle cx="${R - 10}" cy="${S + 40}" r=".42"/><circle cx="${L + 8}" cy="${S + 44}" r=".4"/>
          <circle cx="${cx + 42}" cy="${S + 18}" r=".7"/><circle cx="${cx - 22}" cy="${S - 18}" r=".55"/>
          <circle cx="${L + 14}" cy="${S + 6}" r="2.4" opacity=".12"/><circle cx="${cx + 42}" cy="${S + 18}" r="2.2" opacity=".1"/>
        </g>
      </g>
      <rect x="0" y="0" width="${w}" height="${h}" fill="url(#win-glow)"/>
      <!-- 遠景: 霞んだ低い丘と、遠い天文台の塔 1 本（低いコントラスト、柔らかい輪郭） -->
      <path d="${far}" style="fill:${v("far")}" opacity=".5"/>
      <path d="${tower}" style="fill:${v("far")}" opacity=".58"/>
      <rect x="0" y="${hz - 8}" width="${w}" height="14" fill="url(#win-hz)"/>
      <!-- 鉛の桟: 2 つの明かりの中だけ。細く、低いコントラスト -->
      <g clip-path="url(#win-lights)">
        <path d="${cames}" fill="none" style="stroke:${v("lead")}" stroke-width=".85" opacity=".42"/>
        <path d="${cames}" fill="none" style="stroke:${v("lead-hi")}" stroke-width=".35" opacity=".4" transform="translate(-.45 -.35)"/>
      </g>
      <!-- 斜めの映り込み（明かりごとに 1 本、柔らかく） -->
      <g filter="url(#win-haze)">
        <path d="M${L + 6},${B - 6} L${L + 34},${S - 20} L${L + 38},${S - 20} L${L + 10},${B - 6} Z" fill="url(#win-spec)" opacity=".22"/>
        <path d="M${cx + 8},${B - 12} L${cx + 34},${S - 6} L${cx + 36},${S - 6} L${cx + 10},${B - 12} Z" fill="url(#win-spec)" opacity=".18"/>
      </g>
    </g>
    <!-- 石の網（板トレーサリー）: 小アーチ 2 つ・中方立・四つ葉を抜いた円窓・脇の小円窓。主アーチと方立に一体 -->
    <mask id="win-tr-m" maskUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}">
      <path d="${glass}" fill="#fff"/>
      <path d="${lightL}" fill="#000"/><path d="${lightR}" fill="#000"/>
      <g fill="#000">${foil}${spandrels}</g>
    </mask>
    <rect x="0" y="0" width="${w}" height="${h}" fill="url(#win-bar)" mask="url(#win-tr-m)"/>
    <!-- 円窓の刻み線と、小アーチの外の縁 -->
    <g fill="none" stroke-width=".5">
      <circle cx="${cx}" cy="${f(yo)}" r="${f(ro)}" style="stroke:${v("bar-dk")}" opacity=".7"/>
      <circle cx="${cx}" cy="${f(yo)}" r="${f(ro - 0.8)}" style="stroke:${v("bar-lit")}" opacity=".6"/>
      <path d="M${L},${S} A${r2 + bw / 2},${r2 + bw / 2} 0 0 1 ${f(cx)},${S} A${r2 + bw / 2},${r2 + bw / 2} 0 0 1 ${R},${S}" style="stroke:${v("bar-dk")}" opacity=".55"/>
    </g>
    <!-- 桟の縁の光と陰（光は外から: 桟の内側の縁が明るい） -->
    <g fill="none" stroke-width=".5">
      <path d="M${L + bw - 0.2},${B} L${L + bw - 0.2},${S} A${r2 - bw / 2 + 0.2},${r2 - bw / 2 + 0.2} 0 0 1 ${cx - bw * 1.5 + 0.2},${S} L${cx - bw * 1.5 + 0.2},${B}" style="stroke:${v("bar-dk")}" opacity=".7"/>
      <path d="M${cx + bw * 1.5 - 0.2},${B} L${cx + bw * 1.5 - 0.2},${S} A${r2 - bw / 2 + 0.2},${r2 - bw / 2 + 0.2} 0 0 1 ${R - bw + 0.2},${S} L${R - bw + 0.2},${B}" style="stroke:${v("bar-dk")}" opacity=".7"/>
      <circle cx="${cx}" cy="${yo}" r="${f(ro - bw + 0.2)}" style="stroke:${v("bar-dk")}" opacity=".6"/>
      <path d="M${cx - bw / 2 + 0.3},${B} L${cx - bw / 2 + 0.3},${S + 2}" style="stroke:${v("bar-lit")}" opacity=".9"/>
      <path d="M${L - 0.2},${B} L${L - 0.2},${S} A${r + 0.2},${r + 0.2} 0 0 1 ${R + 0.2},${S} L${R + 0.2},${B}" style="stroke:${v("stone-dk")}" stroke-width=".9" opacity=".55"/>
    </g>
    <!-- 側壁の陰影とアーチ裏の影 -->
    <path d="M${L},${B} L${L},${S} L${L - 4},${S} L${L - 4},${B} Z" fill="url(#win-rev-l)" opacity=".9"/>
    <path d="M${R},${B} L${R},${S} L${R + 4},${S} L${R + 4},${B} Z" fill="url(#win-rev-r)" opacity=".95"/>
    <path d="M${L - 4},${S} A${r + 4},${r + 4} 0 0 1 ${R + 4},${S} L${R + 4},${S + 30} L${R},${S + 30} L${R},${S} A${r},${r} 0 0 0 ${L},${S} L${L},${S + 30} L${L - 4},${S + 30} Z" fill="url(#win-soffit)"/>
    <!-- 窓台（深い腰掛け）とクッション -->
    <path d="M${L - 13},${B} L${R + 13},${B} L${R + 13},${B + 5} L${L - 13},${B + 5} Z" fill="url(#win-sill)"/>
    <path d="M${L - 13},${B + 5} L${R + 13},${B + 5} L${R + 13},${B + 12} L${L - 13},${B + 12} Z" style="fill:${v("stone-sh")}"/>
    <path d="M${L - 13},${B + 0.4} L${R + 13},${B + 0.4}" style="stroke:${v("stone-lit")}" stroke-width=".9"/>
    <path d="M${L - 13},${B + 5} L${R + 13},${B + 5}" style="stroke:${v("stone-dk")}" stroke-width=".55" opacity=".6"/>
    <path d="M${L - 13},${B + 12} L${R + 13},${B + 12}" style="stroke:${v("stone-dk")}" stroke-width=".9" opacity=".7"/>
    <path d="M${L - 11},${B + 13} L${R + 11},${B + 13} L${R + 7},${B + 21} L${L - 7},${B + 21} Z" style="fill:${v("shadow")}" opacity=".25" filter="url(#fx-soft)"/>
    <path d="M${L - 3},${B} C${L - 3},${B - 5} ${L - 1},${B - 7.4} ${L + 6},${B - 7.6} L${R - 6},${B - 7.6} C${R + 1},${B - 7.4} ${R + 3},${B - 5} ${R + 3},${B} Z" fill="url(#win-cush)"/>
    <path d="M${L + 2},${B - 7} C${L + 30},${B - 8.4} ${R - 30},${B - 8.4} ${R - 2},${B - 7}" fill="none" style="stroke:${v("rim")}" stroke-width=".55" opacity=".75"/>
    <path d="M${L - 2.4},${B - 1.2} C${L + 30},${B - 2.2} ${R - 30},${B - 2.2} ${R + 2.4},${B - 1.2}" fill="none" stroke="url(#g-foil)" stroke-width=".5" opacity=".7"/>
    <path d="M${R + 1.6},${B - 4} C${R + 3.6},${B - 2} ${R + 4.2},${B + 2} ${R + 3},${B + 6} L${R + 4.4},${B + 6.4} C${R + 5.6},${B + 2} ${R + 5},${B - 2} ${R + 2.6},${B - 4.6} Z" fill="url(#g-brass)"/>
  </symbol>`;
}
