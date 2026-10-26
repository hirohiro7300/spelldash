// 静的な線画（金の細線）: 天井の星図・書架の帯飾り・切石の目地・はちゃんの紙片の縁。
// どれも色を固定した SVG ファイル。テーマの違いは CSS 側の不透明度で出す。
import { reseed, rnd, star4 } from "./art-head.mjs";
const f = (n) => Math.round(n * 10) / 10;

const G = "#D9B56C"; // 金の線
const svg = (w, h, body, par = "xMidYMax slice") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="${par}">${body}</svg>`;

// ---------- 天井（藍の漆喰に描いた星図）: 1600×150、極は上の外 ----------
export function vaultSvg() {
  const W = 1600, H = 150, px = 800, py = -560;
  let arcs = "";
  for (const R of [600, 632, 664, 696]) {
    const dy = H + 10 - py; // 下端まで
    const half = Math.sqrt(Math.max(0, R * R - (20 - py) ** 2));
    const a0 = Math.atan2(20 - py, -Math.min(half, 900)), a1 = Math.atan2(20 - py, Math.min(half, 900));
    // 円弧を折れ線で（範囲は画面内）
    let d = "";
    for (let i = 0; i <= 36; i++) {
      const a = Math.PI * 0.18 + (Math.PI * 0.64 * i) / 36;
      const x = px + R * Math.cos(a), y = py + R * Math.sin(a);
      d += `${i ? "L" : "M"}${f(x)},${f(y)} `;
    }
    arcs += `<path d="${d}" fill="none" stroke="${G}" stroke-width="${R === 664 ? 0.9 : 0.5}" opacity="${R === 664 ? 0.55 : 0.32}"/>`;
    void dy; void a0; void a1;
  }
  // 目盛つきの赤道（664 の円）
  let ticks = "";
  for (let i = 0; i <= 120; i++) {
    const a = Math.PI * 0.18 + (Math.PI * 0.64 * i) / 120;
    const r1 = 664, r2 = 664 + (i % 5 === 0 ? 7 : 3.4);
    ticks += `M${f(px + r1 * Math.cos(a))},${f(py + r1 * Math.sin(a))} L${f(px + r2 * Math.cos(a))},${f(py + r2 * Math.sin(a))} `;
  }
  // 子午線（極から放射）
  let mer = "";
  for (let k = -14; k <= 14; k++) {
    const a = Math.PI / 2 + (k * Math.PI) / 52;
    mer += `M${f(px + 560 * Math.cos(a))},${f(py + 560 * Math.sin(a))} L${f(px + 760 * Math.cos(a))},${f(py + 760 * Math.sin(a))} `;
  }
  // 黄道（傾いた大円の帯）
  const ex = 980, ey = -1700, ER = 1810;
  let ecl = "", ecl2 = "", eTicks = "";
  for (let i = 0; i <= 40; i++) {
    const a = Math.PI * 0.36 + (Math.PI * 0.3 * i) / 40;
    const x1 = ex + ER * Math.cos(a), y1 = ey + ER * Math.sin(a);
    const x2 = ex + (ER + 9) * Math.cos(a), y2 = ey + (ER + 9) * Math.sin(a);
    ecl += `${i ? "L" : "M"}${f(x1)},${f(y1)} `; ecl2 += `${i ? "L" : "M"}${f(x2)},${f(y2)} `;
    eTicks += `M${f(x1)},${f(y1)} L${f(x2)},${f(y2)} `;
  }
  // 天の川の点描（帯状に）
  reseed(91);
  let mw = "";
  for (let i = 0; i < 110; i++) {
    const t = rnd(), s = (rnd() + rnd() + rnd() - 1.5) * 26;
    const x = t * W, y = 20 + 0.07 * x + s + Math.sin(t * 7) * 10;
    if (y < 4 || y > H - 8) continue;
    mw += `M${x.toFixed(1)} ${y.toFixed(1)}h.01`;
  }
  // 星座: 3 つだけ（北斗七星・カシオペヤ・オリオン）。線は細く、星は明るさで 3 段
  const cons = [
    { pts: [[628, 58], [652, 52], [676, 60], [700, 62], [722, 76], [752, 70], [756, 46]], path: [0, 1, 2, 3, 4, 5, 6, 3], mag: [2, 2, 2, 3, 2, 2, 1] },
    { pts: [[858, 44], [880, 62], [902, 48], [926, 66], [948, 50]], path: [0, 1, 2, 3, 4], mag: [2, 1, 2, 2, 3] },
    { pts: [[1104, 40], [1150, 46], [1118, 76], [1128, 79], [1138, 82], [1098, 112], [1156, 108]], path: [0, 2, 5, -1, 1, 4, 6, -1, 2, 3, 4], mag: [1, 2, 2, 2, 2, 2, 1] },
  ];
  let lines = "", stars = "";
  reseed(17);
  for (const k of cons) {
    let d = "", pen = false;
    for (const i of k.path) { if (i < 0) { pen = false; continue; } d += `${pen ? "L" : "M"}${k.pts[i][0]},${k.pts[i][1]} `; pen = true; }
    lines += d;
    k.pts.forEach((p, i) => {
      const m = k.mag[i];
      stars += m === 1 ? `<path d="${star4(p[0], p[1], 4.2, 0.14)}"/><circle cx="${p[0]}" cy="${p[1]}" r="1.4"/>` : `<circle cx="${p[0]}" cy="${p[1]}" r="${m === 2 ? 1.5 : 1.05}"/>`;
    });
  }
  for (let i = 0; i < 70; i++) {
    const x = rnd() * W, y = 8 + rnd() * (H - 22), r = rnd();
    stars += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(0.4 + r * r * 0.8)}"/>`;
  }
  // 下端の細い二重罫（コーニスの上）
  const base = `<path d="M0,${H - 6} L${W},${H - 6} M0,${H - 3.5} L${W},${H - 3.5}" stroke="${G}" stroke-width=".6" opacity=".5"/>`;
  return svg(W, H, `
    <path d="${mw}" stroke="${G}" stroke-width="1.1" stroke-linecap="round" opacity=".18"/>
    ${arcs}
    <path d="${ticks}" fill="none" stroke="${G}" stroke-width=".5" opacity=".4"/>
    <path d="${mer}" fill="none" stroke="${G}" stroke-width=".45" opacity=".22"/>
    <path d="${ecl}" fill="none" stroke="${G}" stroke-width=".6" opacity=".38"/><path d="${ecl2}" fill="none" stroke="${G}" stroke-width=".6" opacity=".38"/>
    <path d="${eTicks}" fill="none" stroke="${G}" stroke-width=".4" opacity=".3"/>
    <path d="${lines}" fill="none" stroke="${G}" stroke-width=".6" opacity=".6"/>
    <g fill="${G}" opacity=".85">${stars}</g>
    ${base}`);
}

// ---------- 書架のコーニスの中央の彫り（子午線の弧・先細りの端・中央の菱・三日月 1 つ）: 340×34、繰り返さない ----------
export function friezeSvg() {
  const W = 340, H = 34, c = W / 2, m = 17;
  const tap = (x0, y0, cx, cy, x1, y1, w) => {
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L;
    return `M${f(x0)},${f(y0)} Q${f(cx + nx * w)},${f(cy + ny * w)} ${f(x1)},${f(y1)} Q${f(cx - nx * w * 0.25)},${f(cy - ny * w * 0.25)} ${f(x0)},${f(y0)} Z`;
  };
  let body = "";
  // 子午線の弧（上下 2 本、中央で太く端で細い）
  for (const sgn of [-1, 1]) {
    body += `<path d="${tap(c - 20, m, c - 80, m + sgn * 9, c - 150, m + sgn * 1.5, 1.1)}" fill="${G}" opacity=".85"/>`;
    body += `<path d="${tap(c + 20, m, c + 80, m + sgn * 9, c + 150, m + sgn * 1.5, 1.1)}" fill="${G}" opacity=".85"/>`;
  }
  // 弧の目盛（黄道帯の刻み）
  let ticks = "";
  for (let i = 1; i < 12; i++) {
    const t = i / 12;
    for (const side of [-1, 1]) {
      const x = c + side * (20 + 130 * t), y = m - 9 * 4 * t * (1 - t) * 0.92;
      ticks += `M${f(x)},${f(y)} L${f(x)},${f(y - (i % 3 ? 1.6 : 3))} `;
    }
  }
  body += `<path d="${ticks}" stroke="${G}" stroke-width=".6" opacity=".7"/>`;
  // 端の菱と、先細りの水平の線
  for (const side of [-1, 1]) {
    const x = c + side * 156;
    body += `<path d="M${x},${m - 3} L${x + side * 4},${m} L${x},${m + 3} L${x - side * 4},${m} Z" fill="${G}" opacity=".9"/>`;
    body += `<path d="${tap(x + side * 5, m, x + side * 9, m, c + side * 170, m, 0.4)}" fill="${G}" opacity=".6"/>`;
  }
  // 中央: 菱（ロゼンジ）と、その上に三日月 1 つ
  body += `<path d="M${c},${m - 11} L${c + 9},${m} L${c},${m + 11} L${c - 9},${m} Z" fill="none" stroke="${G}" stroke-width=".8" opacity=".95"/>`;
  body += `<path d="M${c},${m - 7} L${c + 5.6},${m} L${c},${m + 7} L${c - 5.6},${m} Z" fill="${G}" opacity=".2"/>`;
  body += `<path d="M${c + 1.6},${m - 4.4} a4.6,4.6 0 1 0 2.6,8.2 a3.7,3.7 0 1 1 -2.6,-8.2 Z" fill="${G}" opacity=".95"/>`;
  body += `<path d="M${c - 14},${m} L${c - 10},${m} M${c + 10},${m} L${c + 14},${m}" stroke="${G}" stroke-width=".7" opacity=".9"/>`;
  return svg(W, H, body, "xMidYMid meet");
}

// ---------- 歯飾り（上面は光、下面は陰、ブロックの右側面は暗く）: 12×10 を横に繰り返す ----------
export function dentilSvg() {
  return svg(12, 10, `
    <rect width="12" height="10" fill="#070A14"/>
    <rect x="0" y="0" width="8" height="9" fill="#2A3352"/>
    <rect x="0" y="0" width="8" height="1.4" fill="#56628A"/>
    <rect x="0" y="1.4" width="1" height="7.6" fill="#3E4A70"/>
    <rect x="6.8" y="1.4" width="1.2" height="7.6" fill="#1A2036"/>
    <rect x="0" y="8.2" width="8" height=".8" fill="#0C1020"/>
    <rect x="8" y="1" width="2.4" height="9" fill="#05070E" opacity=".9"/>`, "none");
}

// ---------- 切石の目地（6 段で 1 周期・石の幅はふぞろい）。目地の面取り: 上の縁は光、下の縁は陰 ----------
// 600×276。石ごとに明るさをわずかに変える
export function ashlarSvg(dark = false) {
  // 切石: 段の高さ 30〜62 のふぞろい、石の幅 56〜210。目地はくぼみ（石より暗い 2px）で、
  // 下の石の上の縁と右の石の左の縁に 1px の光の唇（光は左上の窓）、上の石の下の縁に陰。
  // 石ごとの色むらは 4 色 × 3 段の不透明度に量子化して、1 本の path にまとめる（軽くする）
  const W = 720, courses = [50, 42, 62, 46, 56, 40, 60];
  const H = courses.reduce((a, b) => a + b, 0);
  reseed(dark ? 11 : 17);
  const groutC = dark ? "rgba(0,0,0,.55)" : "rgba(60,54,46,.3)";
  const lipC = dark ? "rgba(255,206,150,.05)" : "rgba(255,250,238,.13)"; /* 白い唇は出さない（くぼみの目地だけ） */
  const shC = dark ? "rgba(0,0,0,.35)" : "rgba(50,44,36,.14)";
  const cols = dark ? ["#000", "#2a1e12"] : ["#fff", "#9a825a", "#6a6e6a", "#3a3630"];
  const bins = {};
  let grout = "", lip = "", sh = "", hiS = "", loS = "";
  let y = 0;
  for (const ch of courses) {
    const xs = [];
    let x = Math.round(rnd() * 140);
    const start = x;
    while (x < start + W - 50) { xs.push(x); x += 72 + Math.round(rnd() * rnd() * 190 + rnd() * 50); }
    for (let i = 0; i < xs.length; i++) {
      const a = xs[i], b2 = i + 1 < xs.length ? xs[i + 1] : start + W;
      const t = rnd(), lvl = Math.min(2, Math.floor(rnd() * 3));
      const ci = dark ? (t > 0.55 ? 0 : 1) : (t > 0.7 ? 0 : t > 0.45 ? 1 : t > 0.2 ? 2 : 3);
      const key = `${ci}-${lvl}`;
      for (const off of [0, -W]) {
        const ax = a + off, bx = b2 + off;
        if (bx < 0 || ax > W) continue;
        bins[key] = (bins[key] || "") + `M${ax} ${y}h${bx - ax}v${ch}h${ax - bx}z`;
        hiS += `M${ax + 2} ${y + 2}h${bx - ax - 4}v5h${ax - bx + 4}z`;
        loS += `M${ax + 2} ${y + ch - 7}h${bx - ax - 4}v5h${ax - bx + 4}z`;
        grout += `M${ax + 1} ${y + 1}V${y + ch}`;
        lip += `M${ax + 2.5} ${y + 3}V${y + ch - 1}`;
        sh += `M${bx - 0.5} ${y + 2}V${y + ch - 1}`;
      }
    }
    grout += `M0 ${y + 1}H${W}`;
    lip += `M0 ${y + 2.5}H${W}`;
    sh += `M0 ${y + ch - 0.5}H${W}`;
    y += ch;
  }
  const base = dark ? 0.04 : 0.035, step = dark ? 0.03 : 0.025;
  const tint = Object.entries(bins).map(([k, d]) => { const [ci, lvl] = k.split("-").map(Number); return `<path d="${d}" fill="${cols[ci]}" opacity="${f(base + lvl * step)}"/>`; }).join("");
  const body = `${tint}<path d="${hiS}" fill="#fff" opacity="${dark ? 0.015 : 0.05}"/><path d="${loS}" fill="#000" opacity="${dark ? 0.08 : 0.04}"/><path d="${sh}" stroke="${shC}" stroke-width="1" fill="none"/><path d="${grout}" stroke="${groutC}" stroke-width="2" fill="none"/><path d="${lip}" stroke="${lipC}" stroke-width="1" fill="none"/>`;
  return svg(W, H, body, "none");
}

// ---------- スマホの天井: 半月形の壁（ルネット）。藍の天井は弧の外だけに見せる（mask）と、石の肋（リブ） ----------
// どちらも 400×100、preserveAspectRatio none。リブの線は vector-effect で太さを保つ
export function lunetteSvg() {
  return svg(400, 100, `<path d="M0,0 L400,0 L400,100 L397,100 L397,96 A197,42 0 0 0 3,96 L3,100 L0,100 Z" fill="#000"/>`, "none");
}
export function ribSvg(dark = false) {
  // 石の肋: 平縁（光）→ 反曲（陰）→ 玉縁（光）→ 平縁（暗）の 4 段の繰形。下の壁に柔らかな影を落とす
  const arc = (d) => `M${3 - d},100 L${3 - d},96 A${197 + d},${42 + d} 0 0 1 ${397 + d},96 L${397 + d},100`;
  const ns = 'vector-effect="non-scaling-stroke" fill="none"';
  const k = dark ? 0.3 : 1;
  const c = (r, g, b) => `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`;
  return svg(400, 100, `
    <defs><filter id="b" x="-5%" y="-20%" width="110%" height="140%"><feGaussianBlur stdDeviation="3.2"/></filter></defs>
    <path d="${arc(-7)}" ${ns} stroke="rgba(${dark ? "0,0,0" : "40,40,46"},${dark ? 0.7 : 0.42})" stroke-width="9" filter="url(#b)"/>
    <path d="${arc(1)}" ${ns} stroke="${c(188, 188, 180)}" stroke-width="9"/>
    <path d="${arc(5)}" ${ns} stroke="${c(236, 235, 228)}" stroke-width="1.4"/>
    <path d="${arc(3.4)}" ${ns} stroke="${c(150, 150, 144)}" stroke-width="1.2"/>
    <path d="${arc(1.2)}" ${ns} stroke="${c(226, 225, 218)}" stroke-width="1.6"/>
    <path d="${arc(-0.6)}" ${ns} stroke="${c(168, 168, 160)}" stroke-width=".8"/>
    <path d="${arc(-2.4)}" ${ns} stroke="${c(96, 96, 92)}" stroke-width="1.4"/>
    <path d="${arc(-3.6)}" ${ns} stroke="rgba(255,252,240,${dark ? 0.05 : 0.3})" stroke-width=".7"/>
    <path d="${arc(7.6)}" ${ns} stroke="rgba(230,200,135,${dark ? 0.55 : 0.75})" stroke-width=".8"/>`, "none");
}

// 肋の足（持ち送り）: 弧の両端を受ける小さな石の腕木。左右は CSS で反転
export function corbelSvg(dark = false) {
  const k = dark ? 0.3 : 1;
  const c = (r, g, b) => `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`;
  return svg(24, 30, `
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c(232, 231, 224)}"/><stop offset=".55" stop-color="${c(190, 190, 182)}"/><stop offset="1" stop-color="${c(120, 120, 114)}"/></linearGradient>
    <filter id="s" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="1.4"/></filter></defs>
    <path d="M0,4 L16,4 C16,12 13,18 6,22 L0,26 Z" fill="rgba(${dark ? "0,0,0" : "40,40,46"},.4)" filter="url(#s)" transform="translate(2 3)"/>
    <path d="M0,0 L18,0 L18,4 L15,4 C15,11 12,17 6,20.5 L0,24 Z" fill="url(#g)"/>
    <path d="M0,.5 L18,.5" stroke="${c(246, 245, 238)}" stroke-width=".8"/>
    <path d="M0,4 L15,4" stroke="${c(110, 110, 104)}" stroke-width=".7"/>
    <path d="M15,4 C15,11 12,17 6,20.5 L0,24" fill="none" stroke="${c(96, 96, 90)}" stroke-width=".8"/>
    <path d="M4,9 C8,9 10,10.5 10.6,13" fill="none" stroke="rgba(230,200,135,${dark ? 0.5 : 0.7})" stroke-width=".6"/>`, "none");
}

// ---------- 頁の末尾の銅版画カット（天球儀＋先細りの罫＋菱形）: currentColor、120×40 ----------
export function tailpieceSvg() {
  const cx = 60, cy = 20, r = 11;
  let hatch = "";
  // 陰の側（右下）だけに、球面に沿って曲がる細いハッチング
  for (let k = 0; k < 9; k++) {
    const t = k / 8, x = cx + r * (0.05 + 0.9 * t);
    const h = Math.sqrt(Math.max(0, r * r - (x - cx) ** 2));
    const y0 = cy - h * (0.15 + 0.6 * t), y1 = cy + h * 0.98;
    hatch += `M${x.toFixed(2)},${y0.toFixed(2)} Q${(x + 0.8).toFixed(2)},${cy} ${x.toFixed(2)},${y1.toFixed(2)} `;
  }
  let stip = "";
  reseed(41);
  for (let i = 0; i < 22; i++) { const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * r * 0.9; const x = cx + d * Math.cos(a), y = cy + d * Math.sin(a); if (x > cx - 2) continue; stip += `M${x.toFixed(1)} ${y.toFixed(1)}h.01`; }
  const rule = (dir) => {
    const x0 = cx + dir * (r + 5), x1 = cx + dir * 52;
    return `<path d="M${x0},${cy - 0.5} L${x1},${cy - 0.08} L${x1},${cy + 0.08} L${x0},${cy + 0.5} Z" fill="currentColor"/>
      <path d="M${x1 + dir * 1},${cy} l${dir * 3},-2.2 l${dir * 3},2.2 l${-dir * 3},2.2 Z" fill="currentColor"/>
      <circle cx="${x0 + dir * 9}" cy="${cy - 3.6}" r=".6" fill="currentColor"/><circle cx="${x0 + dir * 17}" cy="${cy + 3.4}" r=".5" fill="currentColor"/>`;
  };
  return `<svg class="tailpiece" viewBox="0 0 120 40" aria-hidden="true" focusable="false">
    ${rule(-1)}${rule(1)}
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="currentColor" stroke-width=".7"/>
    <ellipse cx="${cx}" cy="${cy}" rx="${r}" ry="3.6" fill="none" stroke="currentColor" stroke-width=".45" transform="rotate(-20 ${cx} ${cy})"/>
    <ellipse cx="${cx}" cy="${cy}" rx="4.2" ry="${r}" fill="none" stroke="currentColor" stroke-width=".4"/>
    <path d="${hatch}" fill="none" stroke="currentColor" stroke-width=".3"/>
    <path d="${stip}" stroke="currentColor" stroke-width=".9" stroke-linecap="round"/>
    <path d="M${cx - r - 2.5},${cy + r + 2.5} L${cx + r + 2.5},${cy - r - 2.5}" stroke="currentColor" stroke-width=".55"/>
    <path d="M${cx - 2.6},${cy + r + 1} L${cx + 2.6},${cy + r + 1} L${cx + 1.6},${cy + r + 5} L${cx - 1.6},${cy + r + 5} Z" fill="currentColor"/>
    <path d="M${cx - 6},${cy + r + 5.6} L${cx + 6},${cy + r + 5.6}" stroke="currentColor" stroke-width=".7"/>
  </svg>`;
}
