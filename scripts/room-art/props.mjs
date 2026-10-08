import { f, v, stops, reseed, rnd } from "./art-head.mjs";

// ---------- 渾天儀（アーミラリー天球儀） ----------
// viewBox 0 0 90 120。中心 (45,46)、半径 27
export function symArmillary() {
  const cx = 45, cy = 46, R = 27;
  const ring = (rx, ry, rot, w, cls, back = false) => {
    const id = `arm-c-${cls}`;
    return back
      ? `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" transform="rotate(${rot} ${cx} ${cy})" fill="none" stroke="url(#arm-g-back)" stroke-width="${w}"/>`
      : `<g transform="rotate(${rot} ${cx} ${cy})"><clipPath id="${id}"><rect x="0" y="${cy}" width="90" height="60"/></clipPath>
         <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="url(#arm-g-ring)" stroke-width="${w}" clip-path="url(#${id})"/>
         <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" style="stroke:${v("spec")}" stroke-width="${f(w * 0.25)}" stroke-dasharray="${f(rx * 0.9)} 400" stroke-dashoffset="${f(-rx * 2.2)}" clip-path="url(#${id})" opacity=".9"/></g>`;
  };
  let ticks = "";
  for (let i = 0; i < 36; i++) {
    const a = (i * Math.PI) / 18, r1 = R - 1.1, r2 = R + (i % 3 ? 0.2 : 1.1);
    ticks += `M${f(cx + r1 * Math.cos(a))},${f(cy + r1 * Math.sin(a))} L${f(cx + r2 * Math.cos(a))},${f(cy + r2 * Math.sin(a))} `;
  }
  return `
  <symbol id="armillary" viewBox="0 0 90 120" overflow="visible">
    <defs>
      <linearGradient id="arm-g-ring" gradientUnits="userSpaceOnUse" x1="14" y1="14" x2="76" y2="80">${stops([[0, "brass-hi"], [0.18, "brass-mid"], [0.5, "brass"], [1, "brass-dk"]])}</linearGradient>
      <linearGradient id="arm-g-back" gradientUnits="userSpaceOnUse" x1="14" y1="14" x2="76" y2="80">${stops([[0, "brass"], [1, "brass-dk"]])}</linearGradient>
      <radialGradient id="arm-g-earth" cx="0.35" cy="0.3" r="0.8">${stops([[0, "brass-hi"], [0.4, "brass"], [1, "brass-dk"]])}</radialGradient>
      <linearGradient id="arm-g-stem" x1="0" y1="0" x2="1" y2="0">${stops([[0, "wood-dk"], [0.28, "wood-lit"], [0.5, "wood"], [1, "wood-dk"]])}</linearGradient>
    </defs>
    <ellipse cx="47" cy="117" rx="26" ry="3.4" style="fill:${v("shadow")}" opacity=".5" filter="url(#fx-soft)"/>
    <!-- 台（ろくろ挽きの脚） -->
    <path d="M28,116.6 C28,113.6 34,112 45,112 C56,112 62,113.6 62,116.6 C62,118 56,119 45,119 C34,119 28,118 28,116.6 Z" fill="url(#arm-g-stem)"/>
    <path d="M30,113.6 C34,112.4 56,112.4 60,113.6" fill="none" style="stroke:${v("wood-lit")}" stroke-width=".6"/>
    <path d="M38,112.4 C39,108 41.6,106 42,101 C42.2,96 40,92 41.4,86 L48.6,86 C50,92 47.8,96 48,101 C48.4,106 51,108 52,112.4 Z" fill="url(#arm-g-stem)"/>
    <ellipse cx="45" cy="86" rx="5.4" ry="1.4" fill="url(#g-brass-h)"/>
    <path d="M45,86 L45,${cy + R + 2}" style="stroke:${v("brass-dk")}" stroke-width="2.4"/>
    <path d="M44.4,86 L44.4,${cy + R + 2}" style="stroke:${v("brass-hi")}" stroke-width=".5"/>
    <!-- 奥側の環 -->
    ${ring(R, 7.6, -23, 1.3, "eq", true)}
    ${ring(R, 9.6, 17, 2.6, "ec", true)}
    ${ring(R - 7, 5.6, -23, 0.8, "tr1", true)}
    <ellipse cx="${cx}" cy="${cy}" rx="34" ry="6.6" fill="none" stroke="url(#arm-g-back)" stroke-width="2.4"/>
    <!-- 軸と地球 -->
    <path d="M${f(cx - 33 * Math.sin(0.4))},${f(cy - 33 * Math.cos(0.4))} L${f(cx + 33 * Math.sin(0.4))},${f(cy + 33 * Math.cos(0.4))}" style="stroke:${v("brass-dk")}" stroke-width="1.1"/>
    <circle cx="${cx}" cy="${cy}" r="4.2" fill="url(#arm-g-earth)"/>
    <circle cx="${f(cx - 1.4)}" cy="${f(cy - 1.5)}" r="1" style="fill:${v("spec")}" opacity=".8"/>
    <!-- 子午環（正面の大きな輪）と目盛 -->
    <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="url(#arm-g-ring)" stroke-width="2.6"/>
    <circle cx="${cx}" cy="${cy}" r="${R + 1.3}" fill="none" style="stroke:${v("brass-dk")}" stroke-width=".4" opacity=".8"/>
    <path d="${ticks}" fill="none" style="stroke:${v("brass-dk")}" stroke-width=".35"/>
    <path d="M${cx - R + 2},${cy - 12} A${R},${R} 0 0 1 ${cx - 8},${cy - R + 1.2}" fill="none" style="stroke:${v("spec")}" stroke-width=".7" stroke-linecap="round" opacity=".9"/>
    <!-- 手前側の環 -->
    ${ring(R, 7.6, -23, 1.3, "eq")}
    ${ring(R, 9.6, 17, 2.6, "ec")}
    ${ring(R - 7, 5.6, -23, 0.8, "tr1")}
    <g><clipPath id="arm-c-hz"><rect x="0" y="${cy}" width="90" height="40"/></clipPath>
      <ellipse cx="${cx}" cy="${cy}" rx="34" ry="6.6" fill="none" stroke="url(#arm-g-ring)" stroke-width="2.4" clip-path="url(#arm-c-hz)"/>
      <ellipse cx="${cx}" cy="${f(cy + 0.8)}" rx="34" ry="6.6" fill="none" style="stroke:${v("brass-dk")}" stroke-width=".5" clip-path="url(#arm-c-hz)" opacity=".8"/>
    </g>
    <!-- 極の小さな球 -->
    <circle cx="${f(cx - 33 * Math.sin(0.4))}" cy="${f(cy - 33 * Math.cos(0.4))}" r="1.3" fill="url(#arm-g-earth)"/>
  </symbol>`;
}

// ---------- 銅版画の星図（額装） ----------
// viewBox 0 0 100 100
export function symChart() {
  const c = 50, r = 34;
  reseed(77);
  let stars = "";
  const pts = [];
  for (let i = 0; i < 46; i++) {
    const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * (r - 3);
    const x = c + d * Math.cos(a), y = c + d * Math.sin(a), s = rnd();
    pts.push([x, y]);
    stars += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(0.25 + s * s * 0.9)}"/>`;
  }
  // 星座の線（いくつか）
  const cons = [
    [[34, 36], [40, 33], [46, 35], [50, 31], [55, 33]],
    [[60, 52], [64, 47], [70, 50], [68, 57], [62, 58], [60, 52]],
    [[38, 58], [42, 64], [47, 62], [50, 68], [45, 72]],
    [[55, 40], [59, 44], [57, 39]],
  ];
  let lines = "";
  for (const k of cons) {
    lines += "M" + k.map((p) => p.join(",")).join(" L") + " ";
    for (const p of k) stars += `<circle cx="${p[0]}" cy="${p[1]}" r="0.9"/>`;
  }
  let ticks = "";
  for (let i = 0; i < 72; i++) {
    const a = (i * Math.PI) / 36, r1 = r + 0.2, r2 = r + (i % 6 ? 1.4 : 2.6);
    ticks += `M${f(c + r1 * Math.cos(a))},${f(c + r1 * Math.sin(a))} L${f(c + r2 * Math.cos(a))},${f(c + r2 * Math.sin(a))} `;
  }
  let merid = "";
  for (let i = 0; i < 6; i++) { const a = (i * Math.PI) / 6; merid += `M${f(c - r * Math.cos(a))},${f(c - r * Math.sin(a))} L${f(c + r * Math.cos(a))},${f(c + r * Math.sin(a))} `; }
  return `
  <symbol id="chart" viewBox="0 0 100 100" overflow="visible">
    <defs>
      <clipPath id="ch-in"><circle cx="${c}" cy="${c}" r="${r}"/></clipPath>
      <radialGradient id="ch-paper" cx="0.4" cy="0.35" r="0.8">${stops([[0, "chart-paper"], [1, "chart-paper-dk"]])}</radialGradient>
    </defs>
    <rect x="2" y="3.4" width="98" height="98" style="fill:${v("shadow")}" opacity=".45" filter="url(#fx-soft)"/>
    <!-- 黒檀の細い額＋金の細線 -->
    <rect x="0" y="0" width="100" height="100" style="fill:${v("frame")}"/>
    <rect x="0.5" y="0.5" width="99" height="99" fill="none" style="stroke:${v("frame-lit")}" stroke-width=".6"/>
    <rect x="3.2" y="3.2" width="93.6" height="93.6" fill="none" stroke="url(#g-foil)" stroke-width=".6"/>
    <rect x="4.2" y="4.2" width="91.6" height="91.6" fill="url(#ch-paper)"/>
    <!-- 四隅の線刻（放射とハッチング） -->
    <g opacity=".55">
      <path d="M4.2,4.2 L22,4.2 A40,40 0 0 0 4.2,22 Z M95.8,4.2 L78,4.2 A40,40 0 0 1 95.8,22 Z M4.2,95.8 L22,95.8 A40,40 0 0 1 4.2,78 Z M95.8,95.8 L78,95.8 A40,40 0 0 0 95.8,78 Z" fill="url(#pt-hatch)"/>
    </g>
    <circle cx="${c}" cy="${c}" r="${r + 5}" fill="none" style="stroke:${v("engr")}" stroke-width=".35"/>
    <circle cx="${c}" cy="${c}" r="${r + 3.6}" fill="none" style="stroke:${v("engr")}" stroke-width=".25"/>
    <path d="${ticks}" fill="none" style="stroke:${v("engr")}" stroke-width=".22"/>
    <circle cx="${c}" cy="${c}" r="${r}" fill="none" style="stroke:${v("engr")}" stroke-width=".5"/>
    <g clip-path="url(#ch-in)">
      <circle cx="${c}" cy="${c}" r="${r}" fill="url(#pt-stipple)" opacity=".35"/>
      <path d="${merid}" fill="none" style="stroke:${v("engr")}" stroke-width=".18" opacity=".7"/>
      <circle cx="${c}" cy="${c}" r="${r * 0.66}" fill="none" style="stroke:${v("engr")}" stroke-width=".2" opacity=".7"/>
      <circle cx="${c}" cy="${c}" r="${r * 0.33}" fill="none" style="stroke:${v("engr")}" stroke-width=".2" opacity=".7"/>
      <ellipse cx="${c + 4}" cy="${c - 3}" rx="${r * 0.86}" ry="${r * 0.8}" fill="none" style="stroke:${v("engr")}" stroke-width=".55" stroke-dasharray="1.2 .6" opacity=".8"/>
      <path d="${lines}" fill="none" style="stroke:${v("engr")}" stroke-width=".28"/>
      <g style="fill:${v("engr")}">${stars}</g>
    </g>
  </symbol>`;
}

// ---------- 燭台（真鍮の手燭＋蜜蝋） ----------
// viewBox 0 0 40 70。炎の芯 (20,18)
export function symCandle() {
  return `
  <symbol id="candle" viewBox="0 0 40 70" overflow="visible">
    <defs>
      <linearGradient id="cd-wax" x1="0" y1="0" x2="1" y2="0">${stops([[0, "wax-dk"], [0.3, "wax"], [0.55, "wax-lit"], [1, "wax-dk"]])}</linearGradient>
      <linearGradient id="cd-sss" x1="0" y1="0" x2="0" y2="1">${stops([[0, "flame-o", 0.85], [1, "flame-o", 0]])}</linearGradient>
      <radialGradient id="cd-bloom" cx="0.5" cy="0.5" r="0.5">${stops([[0, "#FFE7B8", 0.75], [0.25, "#FFC876", 0.32], [0.6, "#E8913A", 0.08], [1, "#E8913A", 0]])}</radialGradient>
    </defs>
    <ellipse cx="22" cy="67.4" rx="17" ry="2.4" style="fill:${v("shadow")}" opacity=".55" filter="url(#fx-soft)"/>
    <!-- 皿と指かけ -->
    <path d="M34,61.6 C38.6,61.2 39.6,64.6 36.8,65.6" fill="none" stroke="url(#g-brass-h)" stroke-width="1.6"/>
    <path d="M4,63.4 C4,61.4 11,60.2 20,60.2 C29,60.2 36,61.4 36,63.4 C36,65.6 29,67 20,67 C11,67 4,65.6 4,63.4 Z" fill="url(#g-brass-h)"/>
    <path d="M6,63 C9,61.4 31,61.4 34,63" fill="none" style="stroke:${v("spec")}" stroke-width=".5" opacity=".8"/>
    <path d="M14.6,61.6 C14.6,58.6 15.6,57 16.4,56.4 L23.6,56.4 C24.4,57 25.4,58.6 25.4,61.6 Z" fill="url(#g-brass-h)"/>
    <!-- 蜜蝋の蝋燭と垂れ -->
    <path d="M16.6,56.6 L16.6,22.8 C17.6,21.6 22.4,21.6 23.4,22.8 L23.4,56.6 Z" fill="url(#cd-wax)"/>
    <path d="M16.6,24 C16.4,28 16.2,31 16.8,33.6 C17.4,34.8 18,33.4 17.9,31 C17.8,28 18.6,25.6 19.6,24 Z" style="fill:${v("wax-lit")}"/>
    <path d="M22.2,23.6 C22.6,27 23.8,29 23.4,32 C23.2,33.6 22.6,33 22.6,31.6" fill="none" style="stroke:${v("wax-lit")}" stroke-width=".9" stroke-linecap="round"/>
    <path d="M16.6,22.8 C17.6,21.6 22.4,21.6 23.4,22.8 C22.4,23.8 17.6,23.8 16.6,22.8 Z" style="fill:${v("wax-dk")}"/>
    <rect class="lt-night" x="16.6" y="22.6" width="6.8" height="9" fill="url(#cd-sss)"/>
    <path d="M20,22.8 C20,21.6 20.2,20.6 19.9,19.6" fill="none" style="stroke:${v("wick")}" stroke-width=".6" stroke-linecap="round"/>
    <!-- 昼: 消したばかりの細い煙 -->
    <path class="lt-day" d="M19.7,19.4 C18.4,15.4 20.6,13 20.6,9.6 C20.6,6.4 21.4,3.6 23.6,0.6 C22.2,3.8 21.8,6.6 21.6,9.6 C21.4,13 19.6,15.6 20.4,19.4 Z" style="fill:${v("smoke")}" opacity=".2" filter="url(#fx-soft)"/>
    <!-- 夜: 炎（外の橙・内の白黄・根元の青）とにじみ -->
    <g class="lt-night flame">
      <circle cx="20" cy="13" r="16" fill="url(#cd-bloom)" style="mix-blend-mode:screen"/>
      <path d="M20,1.4 C22.6,6 24.2,9.6 24,13.6 C23.8,17 22.2,19.2 20,19.2 C17.8,19.2 16.2,17 16,13.6 C15.9,9.8 17.8,6 20,1.4 Z" fill="#F29A3A" opacity=".72" filter="url(#fx-flame)"/>
      <path d="M20,5.6 C21.6,8.6 22.6,11 22.4,13.8 C22.2,16.2 21.2,17.8 20,17.8 C18.8,17.8 17.8,16.2 17.6,13.8 C17.5,11.2 18.6,8.6 20,5.6 Z" fill="#FFE9B8"/>
      <path d="M20,9.6 C20.9,11.4 21.3,13 21.2,14.6 C21,16 20.6,16.8 20,16.8 C19.4,16.8 19,16 18.8,14.6 C18.7,13 19.1,11.4 20,9.6 Z" fill="#FFFBF0"/>
      <path d="M18.2,17.4 C18.8,18.6 21.2,18.6 21.8,17.4 C21.4,18.8 18.6,18.8 18.2,17.4 Z" fill="#6E8BD8" opacity=".8"/>
    </g>
  </symbol>`;
}

// ---------- インク壺（ガラスの角瓶・真鍮の口・紙の題箋）。羽根ペンは本の角に 1 本だけ（build.mjs の QUILL） ----------
// viewBox 0 0 30 34。瓶の高さ 26
export function symInk() {
  // 低いガラス瓶: なで肩、暗く透ける胴（インク）、斜めの鋭い映り込み 1 本、真鍮の口金。題箋は貼らない
  const body = "M6.2,33 C4.8,33 4,32.2 4,30.8 L4,21.4 C4,18 6.6,16 10.2,14.6 C11.6,14 12.2,13 12.2,11.8 L12.2,10 L17.8,10 L17.8,11.8 C17.8,13 18.4,14 19.8,14.6 C23.4,16 26,18 26,21.4 L26,30.8 C26,32.2 25.2,33 23.8,33 Z";
  return `
  <symbol id="ink" viewBox="0 0 30 34" overflow="visible">
    <defs>
      <linearGradient id="ik-glass" x1="0" y1="0" x2="1" y2="0">${stops([[0, "glass", 0.95], [0.12, "glass-dk", 0.9], [0.55, "ink-liquid", 0.96], [0.86, "glass-dk", 0.92], [1, "glass", 0.95]])}</linearGradient>
      <linearGradient id="ik-shoulder" x1="0" y1="0" x2="0" y2="1">${stops([[0, "glass-pale", 0.5], [1, "glass-pale", 0]])}</linearGradient>
      <clipPath id="ik-clip"><path d="${body}"/></clipPath>
    </defs>
    <ellipse cx="17.6" cy="33.4" rx="13.4" ry="1.7" style="fill:${v("shadow")}" opacity=".5" filter="url(#fx-soft)"/>
    <ellipse cx="15" cy="33.1" rx="11.2" ry=".9" style="fill:${v("shadow")}" opacity=".6"/>
    <path d="${body}" fill="url(#ik-glass)"/>
    <g clip-path="url(#ik-clip)">
      <!-- インクの面（肩の下）と、肩のガラスの淡い明るみ -->
      <path d="M3,19.4 C9,18.4 21,18.4 27,19.4 L27,34 L3,34 Z" style="fill:${v("ink-liquid")}" opacity=".55"/>
      <path d="M4.4,19.5 C10,18.7 20,18.7 25.6,19.5" fill="none" style="stroke:${v("glass-pale")}" stroke-width=".35" opacity=".45"/>
      <path d="M8,14 C12,12.6 18,12.6 22,14 L24,18 L6,18 Z" fill="url(#ik-shoulder)" opacity=".7"/>
      <!-- 厚い底 -->
      <path d="M4,31.4 C10,32.2 20,32.2 26,31.4" fill="none" style="stroke:${v("glass-pale")}" stroke-width=".5" opacity=".35"/>
    </g>
    <!-- 斜めの鋭い映り込み 1 本と、反対側の柔らかい縁の光 -->
    <path d="M6.6,30.4 L10.6,16.6 L11.8,16.4 L7.8,30.6 Z" fill="#fff" opacity=".38"/>
    <path d="M24.8,21 C25.2,24 25.2,28 24.8,31" fill="none" style="stroke:${v("spec")}" stroke-width=".7" opacity=".3" filter="url(#fx-hair)"/>
    <!-- 真鍮の口金 -->
    <path d="M11.4,10.6 L11.4,7.4 C11.4,6.8 11.8,6.4 12.4,6.4 L17.6,6.4 C18.2,6.4 18.6,6.8 18.6,7.4 L18.6,10.6 Z" fill="url(#g-brass-h)"/>
    <path d="M11.6,7.2 L18.4,7.2" style="stroke:${v("spec")}" stroke-width=".45" opacity=".85"/>
    <path d="M11.4,9.2 L18.6,9.2" style="stroke:${v("brass-dk")}" stroke-width=".4" opacity=".7"/>
    <path d="M11.4,10.6 L18.6,10.6" style="stroke:${v("brass-dk")}" stroke-width=".5" opacity=".6"/>
  </symbol>`;
}

// ---------- 机の奥に寝かせた 2 冊（革と布） ----------
// viewBox 0 0 70 22
export function symFlatBooks() {
  return `
  <symbol id="flatbooks" viewBox="0 0 70 22" overflow="visible">
    <ellipse cx="38" cy="21.2" rx="34" ry="1.6" style="fill:${v("shadow")}" opacity=".5" filter="url(#fx-soft)"/>
    <path d="M2,21 L66,21 L66,12.6 L2,12.6 Z" style="fill:${v("leather-2")}"/>
    <path d="M2,12.8 L66,12.8" style="stroke:${v("rim")}" stroke-width=".5" opacity=".35"/>
    <path d="M10,12.6 L10,21 M58,12.6 L58,21" style="stroke:${v("foil-line")}" stroke-width=".5" opacity=".75"/>
    <path d="M66,13 L68.6,13.6 L68.6,20.6 L66,21 Z" style="fill:${v("page-lit")}"/>
    <path d="M66.4,15 L68.4,15.2 M66.4,17 L68.4,17.2 M66.4,19 L68.4,19.1" style="stroke:${v("page-sh")}" stroke-width=".35"/>
    <path d="M6,12.6 L60,12.6 L60,5.4 L6,5.4 Z" style="fill:${v("leather-1")}"/>
    <path d="M6,5.6 L60,5.6" style="stroke:${v("rim")}" stroke-width=".5" opacity=".4"/>
    <path d="M13,6.8 L13,11.4 M53,6.8 L53,11.4 M20,9 L46,9" style="stroke:${v("foil-line")}" stroke-width=".45" opacity=".75"/>
    <path d="M60,5.8 L62.2,6.2 L62.2,12.2 L60,12.6 Z" style="fill:${v("page-lit")}"/>
    <path d="M2,21 L66,21" style="stroke:${v("shadow")}" stroke-width=".8" opacity=".7"/>
  </symbol>`;
}

// ---------- 右の壁: 小さな棚と天球儀・2 冊の本 ----------
// viewBox 0 0 90 80
export function symGlobeShelf() {
  return `
  <symbol id="globeshelf" viewBox="0 0 90 80" overflow="visible">
    <defs>
      <radialGradient id="gs-globe" cx="0.32" cy="0.3" r="0.85">${stops([[0, "globe-lit"], [0.45, "globe"], [1, "globe-dk"]])}</radialGradient>
    </defs>
    <!-- 棚板と持ち送り -->
    <path d="M4,62 L86,62 L86,66 L4,66 Z" style="fill:${v("wood-lit")}"/>
    <path d="M4,66 L86,66 L86,70 L4,70 Z" style="fill:${v("wood")}"/>
    <path d="M4,62.4 L86,62.4" style="stroke:${v("rim")}" stroke-width=".5" opacity=".6"/>
    <path d="M4,72 L86,72 L80,82 L10,82 Z" style="fill:${v("shadow")}" opacity=".28" filter="url(#fx-soft)"/>
    <path d="M14,70 L14,72 C14,77 18,80 24,80 L24,78 C19,78 16,75 16,70 Z M76,70 L76,72 C76,77 72,80 66,80 L66,78 C71,78 74,75 74,70 Z" style="fill:${v("wood-dk")}"/>
    <!-- 天球儀 -->
    <ellipse cx="33" cy="61.6" rx="13" ry="1.6" style="fill:${v("shadow")}" opacity=".6" filter="url(#fx-hair)"/>
    <path d="M26,61.8 C26,59.6 29,58.6 33,58.6 C37,58.6 40,59.6 40,61.8 Z" fill="url(#g-brass-h)"/>
    <path d="M32,58.6 L32,53 L34,53 L34,58.6 Z" fill="url(#g-brass-h)"/>
    <circle cx="33" cy="35" r="17" fill="url(#gs-globe)"/>
    <g opacity=".55" style="stroke:${v("foil-line")}" fill="none" stroke-width=".35">
      <ellipse cx="33" cy="35" rx="17" ry="5.4" transform="rotate(-18 33 35)"/>
      <ellipse cx="33" cy="35" rx="6" ry="17" transform="rotate(-18 33 35)"/>
      <ellipse cx="33" cy="35" rx="12.6" ry="17" transform="rotate(-18 33 35)"/>
      <path d="M22,30 L27,26 L31,29 L36,24 M36,40 L40,44 L44,41"/>
    </g>
    <path d="M33,15.6 A19.4,19.4 0 0 1 33,54.4" fill="none" stroke="url(#g-brass-v)" stroke-width="1.6"/>
    <path d="M18.4,46.6 C23,38.4 30.6,30 44,22.6" fill="none" style="stroke:${v("spec")}" stroke-width=".5" opacity=".3"/>
    <!-- 横に寝かせた 2 冊と砂時計 -->
    <path d="M52,61.8 L84,61.8 L84,56 L52,56 Z" style="fill:${v("leather-2")}"/>
    <path d="M52,56.2 L84,56.2" style="stroke:${v("foil-line")}" stroke-width=".4" opacity=".7"/>
    <path d="M54,56 L82,56 L82,50.6 L54,50.6 Z" style="fill:${v("leather-1")}"/>
    <path d="M54,52.2 L82,52.2 M54,54.6 L82,54.6" style="stroke:${v("foil-line")}" stroke-width=".35" opacity=".7"/>
    <path d="M52,61.8 L84,61.8" style="stroke:${v("shadow")}" stroke-width=".8" opacity=".6"/>
    <path d="M62,50.4 L76,50.4 L76,48.6 L62,48.6 Z M62,34.6 L76,34.6 L76,36.4 L62,36.4 Z" fill="url(#g-brass-h)"/>
    <path d="M63.6,36.4 C63.6,40 68.4,41.6 68.4,42.5 C68.4,43.4 63.6,45 63.6,48.6 L74.4,48.6 C74.4,45 69.6,43.4 69.6,42.5 C69.6,41.6 74.4,40 74.4,36.4 Z" style="fill:${v("glass-pale")}" opacity=".55"/>
    <path d="M65.6,48.6 C65.6,46.6 67.6,45.6 69,45.4 C70.4,45.6 72.4,46.6 72.4,48.6 Z" style="fill:${v("sand")}"/>
    <path d="M63.4,36.4 L63.4,48.6 M74.6,36.4 L74.6,48.6" style="stroke:${v("brass-dk")}" stroke-width=".7"/>
  </symbol>`;
}
