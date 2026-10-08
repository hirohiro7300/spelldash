// はちゃん（第 3 回で描き直し）: 窓の腰掛けで膝を立て、膝に立てかけた本を読む見習いの魔女。
// viewBox 0 0 200 260。座面（クッションの上面）y=240。右（机と紙片の方）を向く 3/4、少しうつむく。
// 頭の高さ H=30（あご〜頭頂）。座高は約 3.1H、立てば 5.8 頭身。帽子: 山 1.1H、つば 2.1H、上 1/3 が後ろへ折れる。
// 光: 背後の窓（昼は日、夜は月）から縁の光。部屋の側（右）は照り返し（夜はろうそくの暖かさ）。
import { v, stops, taper } from "./art-head.mjs";

export const HC = { w: 200, h: 260, seat: 240, left: 27, right: 121, top: 105 };

const P = {
  // 長い衣: 背（窓の側壁にもたれる）→ 腰 → 後ろに溜まる裾 → クッション → 爪先の上の裾 → すね → 2 つの膝 → 腿 → 膝の上（本の下）
  robe: "M40,204 C39.2,210 38.2,218 37,225 C36,230.6 34.6,235 31.4,238 C30,239.4 28.4,240.2 26.6,240.6 L100.4,240.6 C102.6,240.6 104.6,240 105.8,238.6 C106,234 103.6,224 99.8,214.6 C96.8,207 93.4,199.6 90.4,191.4 C89.6,189 88.8,187.2 87.6,186.2 C86.8,185.6 85.8,185.6 85,185 C84,183.6 82.4,183 80.6,183.4 C77.6,184.2 73.4,188.4 70.2,193.4 C68,197 66.6,200 66,203 L64,190 Z",
  // 奥の腿（膝の上面から腰へ）: 手前の腿との重なりの線
  nearThigh: "M87.6,186.4 C83.2,189 77,195.2 71.6,204 C70.6,205.6 69.6,207 68.6,208 L70.2,208.8 C72.4,206 74.6,202.6 77.2,199 C80.6,194.4 84.4,190.4 88.6,188.6 Z",
  cape: "M49,171 C44.4,173 40.6,177.6 38.8,184 C37,190.5 35.8,198 35,205.4 C34.8,206.8 35.8,207.6 37.4,207.8 C43.2,209.4 48.2,207 52.4,208.6 C57.4,210.4 62.6,208 66.6,205.6 C69.6,204.4 72,202.8 73.4,201 C71.6,193 68.6,183 64.4,174.2 C60,172.4 54,171 49,171 Z",
  lining: "M64.4,174.2 C68.6,183 71.6,193 73.4,201 L71.2,202 C70,194 67.2,184.6 63,175.2 Z",
  sleeve: "M63.8,197.4 C65.6,196.8 67.4,196.2 69,195.6 L70.4,201.4 C68.4,202.2 66.4,202.8 64.4,203.2 Z",
  hand: "M67.9,195.2 C69.9,193.8 72.9,193.8 74.7,195.2 C75.9,196.5 75.9,198.8 74.9,200.0 C73.4,201.8 70.4,202.5 68.9,201.8 Z",
  handFar: "M82.2,180.6 C83.1,178.6 85.3,177.9 86.7,178.9 C87.7,179.6 87.7,181.0 87.0,182.0 C86.0,183.2 84.1,183.4 82.9,182.5 Z",
  book: "M66.4,201 L82.4,194.8 L85,178.8 L69,184.4 Z",
  pages: "M69,184.4 L85,178.8 L84.6,177 L69.4,182.6 Z",
  pageUp: "M69.4,182.6 L76.8,180 L77.8,177.2 L70.2,179.8 Z",
  face: "M58,143.6 L69.6,145.2 C70.8,146.4 71.6,148 71.8,149.6 C71.9,150.8 71.6,151.6 72.2,152.6 C73,153.6 74,154.8 74.6,155.6 C74.8,156 74.5,156.4 73.8,156.5 C73.9,157 74,157.5 73.6,157.9 C73.8,158.4 73.7,158.9 73.3,159.2 C73.2,160.6 72.6,162 71.6,163 C70,164.6 67.4,165.4 64.6,165 C60.6,164.2 57.4,161.6 55.6,158.4 L54.4,150 Z",
  neck: "M59,162 C60.8,164.6 63,165.6 65,165.6 C64.6,168.8 65,171.6 66,174 L56.4,175.4 C57.8,171.6 58.6,167 59,162 Z",
  hairBack: "M44.6,140.8 C39.8,145 37.8,151.4 38.6,157.6 C39.2,162 40.8,166 43.6,168.8 C45.6,170.6 48.6,171.2 51,170.6 C53.6,170 55.6,168.6 57,166.6 L60,150 L66,143 Z",
  hairLock: "M60.4,143.4 C58.4,148 57.4,153 57.8,158 C58.2,162 59.6,165.4 61.6,168 C60.2,168.4 58.4,167.8 57.2,166.6 C55,163.6 54,158.6 54.4,153.4 C54.8,149 56.2,145.4 58.4,143.2 Z",
  crown: "M42.8,140.2 C46.4,133.6 49.4,127 51.6,120 C50.4,116 47.8,111.6 43.6,108.4 C42.4,107.4 42.6,106 44,105.8 C50.4,105.4 57.6,108.6 61.8,114.8 C64.6,119 66.8,126 68.4,132.4 C69.2,135.6 70,138.4 70.8,141 C61.8,138.8 51.4,138.6 42.8,140.2 Z",
  band: "M44.6,136.6 C52.8,134.6 62,134.8 69.6,137 L70.8,141 C61.8,138.8 51.4,138.6 42.8,140.2 Z",
  // つば: 少し下から見た細い楕円（前＝右がわずかに下がる）。下面は前の側だけ細く見える
  brim: "M28.0,141.6 C29.1,139.6 39.2,138.2 51.5,138.6 C60.2,138.9 68.2,137.9 76.8,139.2 C80.4,139.7 83.4,140.4 84.8,141.0 C87.0,141.6 86.8,142.8 84.6,143.4 C77.3,145.0 65.3,145.6 55.2,145.4 C43.2,145.2 32.2,144.2 28.9,143.0 C28.1,142.7 27.8,142.2 28.0,141.6 Z",
  brimUnder: "M28.9,143.0 C32.2,144.2 43.2,145.2 55.2,145.4 C65.3,145.6 77.3,145.0 84.6,143.4 C82.8,145.2 74.5,147.2 63.1,147.4 C49.7,147.6 35.0,146.0 28.9,143.0 Z",
  boot: "M102.6,237 C105.6,235.6 109.6,235.8 112,237.6 C113.2,238.4 113,240.1 111.6,240.5 L103,240.6 Z",
};
// 衣のひだ: 膝から裾へ落ちる長い谷（先細り）と、その脇の明るい尾根
const VALLEYS = [
  [[85.4, 187], [89, 212], [93.6, 239.6], 1.05],
  [[80, 190], [78, 214], [76, 240], 0.95],
  [[90.6, 197], [94.6, 216], [99.4, 238], 0.6],
  [[70, 208], [64, 222], [58, 240], 0.9],
  [[44, 212], [43.2, 226], [38, 239.4], 0.72],
];
const RIDGES = [
  [[88.8, 190], [96, 212], [102.4, 237], 1.1],
  [[83, 188.6], [84.6, 212], [86.6, 239], 0.7],
  [[74, 201], [70.6, 220], [67, 240], 0.55],
];
const CAPE_FOLDS = [
  [[44, 181.6], [40.6, 193], [39.6, 206.8], 0.8],
  [[52, 179], [51, 193], [52, 208.6], 0.6],
];

export function symHachan() {
  const sil = ["robe", "cape", "sleeve", "hand", "handFar", "book", "pages", "pageUp", "neck", "hairBack", "face", "hairLock", "crown", "band", "brim", "brimUnder", "boot"];
  const tp = (list, color, op = 1, blur = "") => list.map(([a, c, b, w]) => `<path d="${taper(a, c, b, w)}" style="fill:${v(color)}" opacity="${op}"${blur ? ` filter="url(#${blur})"` : ""}/>`).join("");
  return `
  <symbol id="hachan" viewBox="0 0 200 260" overflow="visible">
    <defs>
      <g id="hc-sil">${sil.map((k) => `<path d="${P[k]}"/>`).join("")}</g>
      <linearGradient id="hc-felt" gradientUnits="userSpaceOnUse" x1="40" y1="104" x2="70" y2="146">${stops([[0, "felt-lit"], [0.35, "felt"], [1, "felt-dk"]])}</linearGradient>
      <linearGradient id="hc-brim" gradientUnits="userSpaceOnUse" x1="26" y1="0" x2="90" y2="0">${stops([[0, "felt-lit"], [0.4, "felt"], [1, "felt-dk"]])}</linearGradient>
      <linearGradient id="hc-cape" gradientUnits="userSpaceOnUse" x1="36" y1="172" x2="70" y2="210">${stops([[0, "felt-lit"], [0.3, "felt"], [1, "felt-dk"]])}</linearGradient>
      <linearGradient id="hc-robe" gradientUnits="userSpaceOnUse" x1="60" y1="186" x2="92" y2="242">${stops([[0, "robe-lit"], [0.32, "robe"], [1, "robe-dk"]])}</linearGradient>
      <!-- 腿の下の陰（膝から座面へ垂れる布の奥） -->
      <linearGradient id="hc-under" gradientUnits="userSpaceOnUse" x1="90" y1="196" x2="58" y2="238">${stops([[0, "robe-dk", 0.15], [0.4, "robe-dk", 0.7], [1, "robe-dk", 0.95]])}</linearGradient>
      <linearGradient id="hc-skin" gradientUnits="userSpaceOnUse" x1="74" y1="152" x2="56" y2="160">${stops([[0, "skin-lit"], [0.45, "skin"], [1, "skin-sh"]])}</linearGradient>
      <linearGradient id="hc-hair" gradientUnits="userSpaceOnUse" x1="40" y1="142" x2="58" y2="170">${stops([[0, "hair-lit"], [0.3, "hair"], [1, "hair-dk"]])}</linearGradient>
      <linearGradient id="hc-book" gradientUnits="userSpaceOnUse" x1="68" y1="184" x2="84" y2="198">${stops([[0, "leather-2"], [1, "leather-dk"]])}</linearGradient>
      <clipPath id="hc-face-clip"><path d="${P.face}"/></clipPath>
      <clipPath id="hc-robe-clip"><path d="${P.robe}"/></clipPath>
      <clipPath id="hc-cape-clip"><path d="${P.cape}"/></clipPath>
      <!-- 縁の光: 形から、右下へずらした形を抜く（光は背後の左上から） -->
      <filter id="hc-rimf" x="-5%" y="-5%" width="110%" height="110%" color-interpolation-filters="sRGB">
        <feOffset in="SourceAlpha" dx=".85" dy="1.05" result="o"/>
        <feComposite in="SourceAlpha" in2="o" operator="out" result="e"/>
        <feGaussianBlur in="e" stdDeviation=".28" result="eb"/>
        <feFlood style="flood-color:${v("rim")}"/>
        <feComposite in2="eb" operator="in"/>
      </filter>
      <!-- 部屋の側（右）の照り返し／夜はろうそく -->
      <filter id="hc-bncf" x="-5%" y="-5%" width="110%" height="110%" color-interpolation-filters="sRGB">
        <feOffset in="SourceAlpha" dx="-1.0" dy=".3" result="o"/>
        <feComposite in="SourceAlpha" in2="o" operator="out" result="e"/>
        <feGaussianBlur in="e" stdDeviation=".35" result="eb"/>
        <feFlood style="flood-color:${v("bounce")}"/>
        <feComposite in2="eb" operator="in"/>
      </filter>
      <!-- 逆光のにじみ（昼）: 形の外へ広がる柔らかな光 -->
      <filter id="hc-halo" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB">
        <feMorphology in="SourceAlpha" operator="dilate" radius="1.2" result="d"/>
        <feGaussianBlur in="d" stdDeviation="3.2" result="b"/>
        <feFlood style="flood-color:${v("rim")}"/>
        <feComposite in2="b" operator="in"/>
      </filter>
      <radialGradient id="hc-warm" gradientUnits="userSpaceOnUse" cx="150" cy="170" r="110">${stops([[0, "bounce", 0.9], [0.45, "bounce", 0.35], [1, "bounce", 0]])}</radialGradient>
      <filter id="hc-blur2" x="-50%" y="-20%" width="200%" height="140%"><feGaussianBlur stdDeviation="1.4"/></filter>
      <filter id="hc-soft" x="-50%" y="-10%" width="200%" height="120%"><feGaussianBlur stdDeviation=".55"/></filter>
      <mask id="hc-sil-m" maskUnits="userSpaceOnUse" x="0" y="90" width="200" height="170"><use href="#hc-sil" fill="#fff"/></mask>
    </defs>
    <!-- 逆光のにじみ（昼だけ） -->
    
    <!-- クッションに落ちる影と接地の影（光は背後の窓 → 手前へ） -->
    <ellipse cx="70" cy="241.6" rx="50" ry="3.4" style="fill:${v("shadow")}" opacity=".5" filter="url(#fx-soft)"/>
    <path d="M24,240 C50,239.2 90,239.2 122,240 L122,241.8 C90,242.4 50,242.4 24,241.8 Z" style="fill:${v("shadow")}" opacity=".55" filter="url(#fx-hair)"/>

    <!-- 長い衣（膝・すね・後ろに溜まる裾） -->
    <path d="${P.robe}" fill="url(#hc-robe)"/>
    <g clip-path="url(#hc-robe-clip)">
      <!-- 面: 腿の上（窓の光を受ける）／腿の下に垂れる布の奥（暗い）／すねの前（部屋の照り返し） -->
      <path d="M88.4,190.6 C82,197 74,206 68,216 C62,226 56,234 50,242 L95,242 C93,226 91,208 88.4,190.6 Z" fill="url(#hc-under)" filter="url(#hc-soft)"/>
      <path d="M66.6,202 C68.6,196 73,189.6 77.6,185.4 C80.4,183 84.4,183 86.6,185.2 C88,186.6 88.6,188.2 88.4,189.8 C84.6,190.6 80,193.6 76,198 C72.6,201.8 69.6,206 67.6,209 Z" style="fill:${v("robe-lit")}" opacity=".62" filter="url(#hc-soft)"/>
      <path d="M38.4,212 C37.6,220 36.4,228 33.6,234.6" fill="none" style="stroke:${v("robe-lit")}" stroke-width="1.6" opacity=".35" filter="url(#hc-soft)"/>
      <path d="${P.nearThigh}" style="fill:${v("robe-lit")}" opacity=".55"/>
      <path d="M36,209.4 C46,211.4 58,211 67,207.6" fill="none" style="stroke:${v("robe-dk")}" stroke-width="3.2" opacity=".75" filter="url(#hc-soft)"/>
      <path d="${taper([89.4, 191], [97, 212], [103.6, 236.4], 1.6)}" style="fill:${v("robe-lit")}" opacity=".45" filter="url(#hc-blur2)"/>
      <path d="M88,187.6 C84,190.4 78,196.4 72.6,205" fill="none" style="stroke:${v("robe-dk")}" stroke-width=".6" opacity=".5"/>
      ${tp(RIDGES, "robe-lit", 0.75, "hc-soft")}
      ${tp(VALLEYS, "robe-dk", 0.9, "hc-soft")}
      <!-- 膝の頭の明るみ -->
      <ellipse cx="81.4" cy="185" rx="3.6" ry="1.7" transform="rotate(-40 81.4 185)" style="fill:${v("robe-lit")}" opacity=".7" filter="url(#fx-hair)"/>
      <ellipse cx="87.6" cy="188.4" rx="3" ry="1.6" transform="rotate(-50 87.6 188.4)" style="fill:${v("robe-lit")}" opacity=".55" filter="url(#fx-hair)"/>
      <!-- 裾の折り返し（クッションに触れる線） -->
      <path d="M29,239.6 C40,238.8 58,239.4 74,238.6 C86,238.2 96,239 105.6,238" fill="none" style="stroke:${v("robe-dk")}" stroke-width=".9" opacity=".8"/>
      <path d="M30,238.6 C42,237.8 58,238.4 74,237.6 C86,237.2 96,238 105.4,237" fill="none" style="stroke:${v("robe-lit")}" stroke-width=".4" opacity=".55"/>
    </g>
    <!-- 爪先（裾からのぞく） -->
    <path d="${P.boot}" style="fill:${v("boot")}"/>
    <path d="M104,236.6 C106.6,235.8 109.8,236 111.6,237.4" fill="none" style="stroke:${v("rim")}" stroke-width=".45" opacity=".55"/>
    <path d="M105.8,238.6 C105.8,237.2 106.2,236.4 107.2,236" fill="none" style="stroke:${v("robe-dk")}" stroke-width=".8" opacity=".9"/>

    <!-- 腕（衣の袖）・本・手 -->
    <path d="${P.sleeve}" style="fill:${v("robe")}"/>
    <path d="M64,197.6 C65.8,197 67.4,196.4 68.8,195.8" fill="none" style="stroke:${v("robe-lit")}" stroke-width=".55" opacity=".8"/>
        <path d="M69,195.6 L70.4,201.4" fill="none" stroke="url(#g-foil)" stroke-width=".7"/>
    <path d="${P.book}" fill="url(#hc-book)"/>
    <path d="M68.2,199.6 L81.4,194.4 L83.6,180.4 L70.4,185 Z" fill="none" stroke="url(#g-foil)" stroke-width=".42" opacity=".9"/>
    <path d="M82.4,194.8 L85,178.8" fill="none" style="stroke:${v("leather-dk")}" stroke-width=".9"/>
    <path d="${P.pages}" style="fill:${v("page-lit")}"/>
    <path d="${P.pageUp}" style="fill:${v("page-lit")}"/>
    <path d="M69.8,181.4 L77.2,178.8" fill="none" style="stroke:${v("page-sh")}" stroke-width=".35"/>
    <path d="M69.4,182.6 L84.6,177" fill="none" style="stroke:${v("rim")}" stroke-width=".45" opacity=".85"/>
    <path d="${P.handFar}" style="fill:${v("skin-sh")}"/>
    <path d="${P.hand}" fill="url(#hc-skin)"/>
    <path d="M70.8,197 C72,197.6 73,197.8 74.2,197.4 M70.6,198.8 C71.8,199.4 72.8,199.6 73.8,199.2" fill="none" style="stroke:${v("skin-sh")}" stroke-width=".35" opacity=".9"/>

    <!-- 短いケープ: 3 本のひだ、前の縁にライラックの裏地、裾に金の縁取り -->
    <path d="${P.cape}" fill="url(#hc-cape)"/>
    <g clip-path="url(#hc-cape-clip)">
      ${tp(CAPE_FOLDS, "felt-dk", 0.85, "hc-soft")}
      <path d="${taper([46.4, 180], [45, 192], [44.2, 207], 0.55)}" style="fill:${v("felt-lit")}" opacity=".55"/>
      <path d="${taper([54.6, 179], [55.2, 193], [56.4, 208.4], 0.5)}" style="fill:${v("felt-lit")}" opacity=".45"/>
      <!-- 肩の丸み -->
      <path d="M44,176 C50,174.6 58,175.6 64,178.6 C58,178.4 50,178 44,179.6 Z" style="fill:${v("felt-lit")}" opacity=".5" filter="url(#fx-hair)"/>
    </g>
    <path d="M35.4,206.4 C43,208.8 48.2,206.4 52.4,208 C57.4,209.8 62.6,207.4 66.6,205.2 C69.6,204 72,202.6 73.2,200.8" fill="none" stroke="url(#g-foil)" stroke-width=".7"/>
    <path d="${P.lining}" style="fill:${v("lining")}"/>
    <path d="M63.4,175.4 C67.4,184.6 70.2,194 71.4,201.6" fill="none" style="stroke:${v("lining-dk")}" stroke-width=".4" opacity=".8"/>

    <!-- 首・留め金 -->
    <path d="${P.neck}" style="fill:${v("skin-sh")}"/>
    <path d="M59.4,163.4 C61.4,166 63.6,166.8 65.2,166.6 L65,168.6 C62.6,168.4 60.6,167 59.2,165.4 Z" style="fill:${v("shadow")}" opacity=".35" filter="url(#fx-hair)"/>
    <path d="M55.6,175.6 C58.6,174 62.6,173.6 66,174.4" fill="none" style="stroke:${v("lining")}" stroke-width=".7" opacity=".9"/>
    <path d="M60.4,174.2 a1.7,1.7 0 1 0 1.9,2.4 a1.3,1.3 0 1 1 -1.9,-2.4 Z" fill="url(#g-brass)"/>

    <!-- 髪（後ろ） -->
    <path d="${P.hairBack}" fill="url(#hc-hair)"/>
    <path d="${taper([42.6, 148], [40.6, 156], [43.2, 166.6], 0.7)}" style="fill:${v("hair-dk")}" opacity=".7"/>
    <path d="${taper([47.6, 146.6], [46.6, 156.6], [49, 169], 0.6)}" style="fill:${v("hair-dk")}" opacity=".55"/>
    <path d="${taper([51.6, 146], [52.2, 156], [53.6, 167.6], 0.5)}" style="fill:${v("hair-lit")}" opacity=".45"/>

    <!-- 顔: 3/4、うつむいて本を読む。印は 3 つだけ（伏せた目・鼻の陰・小さな口） -->
    <path d="${P.face}" fill="url(#hc-skin)"/>
    <g clip-path="url(#hc-face-clip)">
      <!-- つばの影（額から目の上まで） -->
      <path d="M52,142 L76,142 L76,149.4 C70,148.6 62,149.6 52,152.6 Z" style="fill:${v("shadow")}" opacity=".32" filter="url(#fx-hair)"/>
      <ellipse cx="68.4" cy="157.8" rx="2.4" ry="1.5" style="fill:${v("cheek")}" opacity=".28" filter="url(#fx-hair)"/>
    </g>
    <path d="${taper([65.8, 150.4], [68.2, 151.2], [70.6, 150.4], 0.5)}" style="fill:${v("face-ink")}"/>
    <ellipse cx="69" cy="151.5" rx=".85" ry=".6" style="fill:${v("face-ink")}" opacity=".9"/>
    <path d="M66,150.5 L65,149.9" fill="none" style="stroke:${v("face-ink")}" stroke-width=".45" stroke-linecap="round"/>
    <path d="${taper([66.2, 147.8], [68.4, 146.9], [70.8, 147.8], 0.28)}" style="fill:${v("hair-dk")}" opacity=".75"/>
    <path d="M73,156.9 C73.4,157.1 73.8,157 74,156.7" fill="none" style="stroke:${v("skin-sh")}" stroke-width=".5" stroke-linecap="round"/>
    <path d="M72,159.5 C72.6,159.8 73,159.7 73.3,159.4" fill="none" style="stroke:${v("face-ink")}" stroke-width=".42" stroke-linecap="round" opacity=".7"/>

    <!-- 髪（顔の脇の房）・つばの下からこぼれる数本・三日月の髪留め -->
    <path d="${P.hairLock}" fill="url(#hc-hair)"/>
    <path d="${taper([58.6, 146], [57, 156], [59.8, 166.4], 0.45)}" style="fill:${v("hair-dk")}" opacity=".6"/>
    <path d="${taper([64.2, 144.2], [66, 146.4], [67, 149.6], 0.32)}" style="fill:${v("hair")}"/>
    <path d="${taper([62.6, 146.4], [66.2, 151.6], [66.8, 158.4], 0.36)}" style="fill:${v("hair")}" opacity=".9"/>
    <path d="${taper([61.8, 144], [62.6, 146.6], [62.6, 150.2], 0.3)}" style="fill:${v("hair")}"/>
    <path d="${taper([43, 142.2], [40.4, 145], [38.6, 149.4], 0.32)}" style="fill:${v("hair")}"/>
    <path d="${taper([40.4, 149.6], [37.4, 153.6], [37, 158.2], 0.26)}" style="fill:${v("hair")}"/>
    <path d="${taper([45.6, 168.6], [44.6, 171], [42.2, 172.6], 0.26)}" style="fill:${v("hair")}"/>
    <path d="M55.8,150.4 a1.5,1.5 0 1 0 1.8,2.2 a1.15,1.15 0 1 1 -1.8,-2.2 Z" fill="url(#g-brass)"/>

    <!-- 帽子: 山（上 1/3 が後ろへ折れ、折れ目に 2 本の細い線）→ 天鵞絨の帯（金の細線 2 本・三日月のピン）→ つば -->
    <path d="${P.brimUnder}" style="fill:${v("felt-dk")}"/>
    <path d="${P.crown}" fill="url(#hc-felt)"/>
    <path d="${taper([52.4, 118.8], [55.6, 115.4], [59.4, 113.4], 0.42)}" style="fill:${v("felt-dk")}" opacity=".9"/>
    <path d="${taper([53.8, 122], [56.6, 119.6], [60, 118.6], 0.26)}" style="fill:${v("felt-dk")}" opacity=".7"/>
    <path d="${taper([45.4, 107.2], [52.4, 107.4], [59.6, 112.6], 0.35)}" style="fill:${v("felt-lit")}" opacity=".7"/>
    <path d="${taper([62.4, 117.4], [66, 126], [68.6, 136], 0.5)}" style="fill:${v("felt-dk")}" opacity=".65"/>
    <path d="${P.band}" style="fill:${v("band")}"/>
    <path d="M44.6,136.6 C52.8,134.6 62,134.8 69.6,137" fill="none" stroke="url(#g-foil)" stroke-width=".55"/>
    <path d="M43.2,139.6 C51.6,138 61.8,138.2 70.6,140.4" fill="none" stroke="url(#g-foil)" stroke-width=".55"/>
    <path d="M63.4,136.2 a1.6,1.6 0 1 0 1.8,2.3 a1.2,1.2 0 1 1 -1.8,-2.3 Z" fill="url(#g-brass)"/>
    <path d="${P.brim}" fill="url(#hc-brim)"/>
    <!-- つばの窓側の縁に 1px の暖かい光 -->
    <path d="M29,141.2 C34,139.6 43,138.8 51.5,138.6 C58,138.8 64,138.4 69.8,138.6" fill="none" style="stroke:${v("rim")}" stroke-width=".6" opacity=".85"/>
    <path d="M27.4,143.6 C32,145.6 44,147.4 55,147.6 C67,147.8 79.6,146.8 86.2,144.8" fill="none" style="stroke:${v("felt-dk")}" stroke-width=".7" opacity=".8"/>


    <!-- 縁の光（背後の窓: 昼は日、夜は月）と、部屋の側の照り返し（夜はろうそく） -->
    <use href="#hc-sil" filter="url(#hc-rimf)" style="opacity:var(--hc-rim,.9)"/>
    <use href="#hc-sil" filter="url(#hc-bncf)" style="opacity:var(--hc-bounce,.25)"/>
    <rect x="0" y="90" width="200" height="170" fill="url(#hc-warm)" mask="url(#hc-sil-m)" style="opacity:var(--hc-warm,0);mix-blend-mode:soft-light"/>
  </symbol>`;
}

export const hcSilhouette = () => `<g>${Object.keys(P).filter((k) => k !== "nearThigh" && k !== "lining").map((k) => `<path d="${P[k]}"/>`).join("")}</g>`;
