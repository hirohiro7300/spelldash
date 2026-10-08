import { v, stops, taper, reseed, rnd, star4 } from "./art-head.mjs";
const f = (n) => Math.round(n * 10) / 10;

// ================= はちゃん（窓の腰掛けで本を膝に、紙片の方を見上げる見習い） =================
// viewBox 0 0 100 120。座面（クッションの上面）y=116。右（机と紙片の方）を向く 3/4。
// 頭の高さ H=18 → 立てば 5.8 頭身。帽子: 山 1.15H、つば 2H、上 1/3 が後ろ（左）へ折れる。
export const HC = { w: 100, h: 120, seat: 116, top: 33.6, left: 12.8, right: 70.6 };

const P = {
  // 帽子の山: 背側（左）はわずかに凹、前（右）は凸。上 1/3 が後ろへ折れて丸い先
  crown: "M24.8,53.4 C24.1,50.3 23.9,47.3 24.6,44.6 C25.0,43.1 24.3,41.9 22.7,40.9 C20.5,39.6 17.7,38.7 15.1,38.5 C14.0,38.4 13.7,37.7 14.5,37.1 C17.9,35.0 22.7,34.0 26.7,34.6 C31.7,35.4 35.1,39.4 37.1,44.0 C38.6,47.3 39.7,50.2 40.5,52.8 C35.4,51.6 29.6,52.0 24.8,53.4 Z",
  band: "M24.6,51.2 C29.6,50.0 35.4,49.7 40.0,50.9 L40.6,53.2 C35.4,52.2 29.6,52.5 24.9,53.9 Z",
  // つば: 下から見た細い楕円。前（右）が少し上がり、ゆるく波打つ
  brim: "M13.6,56.2 C13.9,54.6 19.6,53.3 27.6,52.6 C35.8,51.9 46.4,51.6 50.6,52.6 C52.4,53.1 51.8,54.3 49.4,55.0 C45.0,56.3 37.4,57.5 29.4,57.9 C21.6,58.3 14.6,57.8 13.8,57.0 C13.6,56.8 13.5,56.5 13.6,56.2 Z",
  brimUnder: "M14.0,56.9 C16.8,57.7 22.6,58.2 29.4,57.9 C37.4,57.5 45.0,56.3 49.4,55.0 C47.6,56.6 40.6,58.7 31.4,59.3 C23.0,59.8 16.2,58.8 14.0,56.9 Z",
  face: "M31.4,56.8 L39.8,57.2 C40.6,58.0 41.1,58.9 41.3,59.7 C41.4,60.2 41.2,60.6 41.4,61.1 C42.0,61.9 43.0,62.6 43.6,63.1 C43.7,63.4 43.3,63.7 42.7,63.8 C42.9,64.2 43.0,64.6 42.8,64.9 C42.6,65.3 42.5,65.6 42.7,66.0 C42.7,66.8 42.4,67.6 41.8,68.3 C40.7,69.4 39.0,69.8 37.5,69.4 C35.7,68.9 34.2,67.8 33.1,66.4 L31.0,61.0 Z",
  neck: "M33.4,66.6 C34.8,68.2 36.2,69.0 37.6,69.3 C37.4,70.8 37.6,72.0 38.2,73.2 L31.4,74.0 C32.4,71.8 33.0,69.4 33.4,66.6 Z",
  hair: "M22.6,55.8 C21.0,58.8 20.8,62.8 21.8,66.1 C22.4,68.3 23.6,69.9 25.4,70.7 C27.0,71.3 29.0,71.3 30.6,70.7 C31.8,70.3 32.8,69.5 33.4,68.3 C33.0,66.9 33.4,65.1 33.8,63.1 C34.2,61.1 34.6,59.3 35.4,58.1 C36.6,58.9 37.8,59.5 38.8,59.5 C39.4,58.9 39.8,58.1 40.0,57.2 Z",
  collar: "M30.6,72.2 C33.4,71.4 36.4,71.6 38.8,72.6 L39.4,75.0 C36.8,74.2 33.6,74.2 30.8,75.2 Z",
  // 短いケープ（肩から肘の上まで）。前の縁は開いて、ライラックの裏地がのぞく
  cape: "M30.8,72.8 C27.0,73.8 23.4,75.8 21.0,79.0 C18.6,82.2 17.0,86.4 15.6,90.8 C19.6,92.2 24.4,93.0 29.4,92.8 C34.0,92.6 38.6,91.6 42.2,90.0 C43.4,89.4 44.4,88.8 45.0,88.2 C43.2,84.2 41.2,79.6 39.0,75.6 C38.6,74.8 38.2,74.2 37.8,73.8 Z",
  lining: "M37.8,73.8 C40.4,78.2 42.8,83.2 45.0,88.2 C44.0,88.6 43.2,88.8 42.4,89.0 C41.4,84.4 39.8,79.4 37.4,74.8 Z",
  liningBack: "M15.6,90.8 C17.4,90.0 19.4,90.4 21.0,91.6 C19.0,91.9 17.2,91.6 15.6,90.8 Z",
  // 長い衣: 背は窓の側壁にもたれ、膝を立て、膝から足首へ長いひだが落ちる
  robe: "M16.8,89.6 C17.4,95.0 18.2,100.0 18.6,104.5 C18.9,108.4 17.8,111.6 15.4,113.6 C14.2,114.7 13.4,115.5 12.8,116.0 L64.6,116.0 C66.4,115.7 68.0,114.9 68.2,113.6 C66.6,111.6 65.4,109.8 64.6,107.8 C63.4,104.4 62.2,100.2 61.2,96.6 C60.4,93.4 59.6,90.0 58.4,87.0 C57.4,84.8 55.8,83.4 53.8,83.4 C51.6,83.4 49.6,84.4 47.8,85.8 C45.6,87.4 43.4,89.0 41.2,90.4 C40.8,90.2 40.6,89.9 40.6,89.6 Z",
  // 奥の脚（膝の後ろにわずかに見える）
  farKnee: "M52.6,83.6 C54.4,81.6 57.0,81.0 59.2,82.0 C61.0,82.9 62.0,84.8 62.2,87.0 C62.6,90.8 63.0,94.6 63.8,98.4 C62.6,94.6 61.4,90.6 60.0,88.0 C58.4,85.2 55.6,83.6 52.6,83.6 Z",
  boot: "M62.0,113.0 C64.8,112.4 67.8,112.8 69.8,114.2 C70.6,114.9 70.2,116.0 69.2,116.0 L62.4,116.0 Z",
  bootFar: "M64.6,112.2 C66.6,111.8 68.8,112.0 70.4,113.2 L70.0,114.4 L65.0,114.0 Z",
  sleeve: "M33.6,86.6 C37.0,86.4 41.0,84.6 44.0,82.2 L45.8,84.8 C42.4,87.6 37.6,89.8 33.4,90.2 Z",
  hand: "M43.8,81.8 C44.9,80.9 46.6,81.0 47.3,82.0 C47.8,82.9 47.4,84.1 46.4,84.4 C45.4,84.7 44.3,84.3 43.8,83.5 Z",
  handFar: "M54.0,78.6 C55.0,77.9 56.4,78.1 56.8,79.0 C57.1,79.8 56.6,80.6 55.8,80.8 C55.0,81.0 54.2,80.6 53.9,79.9 Z",
  // 開いた本（表紙の外側が見える。頁の小口は上に明るく）
  bookNear: "M43.6,85.4 L45.8,76.6 L50.4,77.6 L48.8,86.6 Z",
  bookFar: "M48.8,86.6 L50.4,77.6 L55.6,75.8 L54.4,84.6 Z",
  pages: "M45.8,76.6 L50.4,77.6 L55.6,75.8 L55.4,74.7 L50.5,76.4 L46.0,75.5 Z",
};
const FOLDS = [
  // 膝から足首へ落ちる長いひだ 3 本（先細り）
  [[57.0, 87.2], [60.0, 100.0], [61.6, 113.6], 0.62],
  [[54.0, 87.6], [55.4, 101.0], [55.8, 115.2], 0.7],
  [[50.8, 88.8], [49.8, 102.0], [48.8, 115.2], 0.55],
  // 腿に沿うひだ、腰のたるみ
  [[24.0, 104.6], [36.0, 97.4], [49.4, 87.0], 0.38],
  [[20.6, 96.0], [21.2, 104.2], [23.6, 113.4], 0.42],
];
const FOLD_LIT = [
  [[58.6, 88.6], [61.8, 100.6], [64.0, 112.6], 0.32],
  [[55.6, 89.0], [57.2, 101.6], [57.8, 114.6], 0.3],
  [[52.4, 89.6], [51.8, 102.4], [51.2, 114.8], 0.26],
];
const CAPE_FOLDS = [
  [[24.6, 78.8], [22.4, 85.0], [21.4, 91.6], 0.42],
  [[31.0, 77.2], [30.8, 84.6], [30.6, 92.6], 0.4],
  [[36.8, 77.6], [38.0, 84.0], [39.2, 91.0], 0.3],
];

export function symHachan() {
  const silParts = ["crown", "brim", "brimUnder", "hair", "face", "neck", "cape", "robe", "boot", "bootFar", "sleeve", "bookNear", "bookFar", "pages"];
  const sil = `<g id="hc-sil">${silParts.map((k) => `<path d="${P[k]}"/>`).join("")}</g>`;
  const tp = (list, color, op = 1) => list.map(([a, c, b, w]) => `<path d="${taper(a, c, b, w)}" style="fill:${v(color)}" opacity="${op}"/>`).join("");
  return `
  <symbol id="hachan" viewBox="0 0 100 120" overflow="visible">
    <defs>
      ${sil}
      <linearGradient id="hc-felt" gradientUnits="userSpaceOnUse" x1="14" y1="34" x2="40" y2="94">${stops([[0, "felt-lit"], [0.28, "felt"], [1, "felt-dk"]])}</linearGradient>
      <linearGradient id="hc-cape" gradientUnits="userSpaceOnUse" x1="18" y1="74" x2="44" y2="94">${stops([[0, "felt-lit"], [0.35, "felt"], [1, "felt-dk"]])}</linearGradient>
      <linearGradient id="hc-robe" gradientUnits="userSpaceOnUse" x1="18" y1="86" x2="70" y2="118">${stops([[0, "robe-lit"], [0.3, "robe"], [1, "robe-dk"]])}</linearGradient>
      <linearGradient id="hc-skin" gradientUnits="userSpaceOnUse" x1="43" y1="62" x2="31" y2="66">${stops([[0, "skin"], [0.6, "skin"], [1, "skin-sh"]])}</linearGradient>
      <linearGradient id="hc-hair" gradientUnits="userSpaceOnUse" x1="21" y1="56" x2="33" y2="71">${stops([[0, "hair-lit"], [0.35, "hair"], [1, "hair-dk"]])}</linearGradient>
      <linearGradient id="hc-brimu" gradientUnits="userSpaceOnUse" x1="14" y1="0" x2="50" y2="0">${stops([[0, "felt-dk"], [0.6, "felt-dk"], [1, "felt"]])}</linearGradient>
      <linearGradient id="hc-shade" gradientUnits="userSpaceOnUse" x1="20" y1="88" x2="70" y2="116">${stops([[0, "#fff", 0], [0.45, "#fff", 0.15], [1, "#fff", 0.85]])}</linearGradient>
      <mask id="hc-shade-m" maskUnits="userSpaceOnUse" x="0" y="30" width="100" height="90"><path d="${P.robe}" fill="url(#hc-shade)"/><path d="${P.cape}" fill="url(#hc-shade)" opacity=".7"/></mask>
      <clipPath id="hc-face-clip"><path d="${P.face}"/></clipPath>
      <!-- 縁の光: 形と、右下へずらした形の差（窓＝背後の左上から） -->
      <mask id="hc-rim" maskUnits="userSpaceOnUse" x="0" y="30" width="100" height="90"><use href="#hc-sil" fill="#fff"/><use href="#hc-sil" fill="#000" transform="translate(.3 .78)"/></mask>
      <!-- 部屋側（右）の照り返し／夜はろうそく -->
      <mask id="hc-bounce" maskUnits="userSpaceOnUse" x="0" y="30" width="100" height="90"><use href="#hc-sil" fill="#fff"/><use href="#hc-sil" fill="#000" transform="translate(-.5 -.05)"/></mask>
    </defs>
    <!-- クッションに落ちる影（光は背後の窓 → 手前右へ） -->
    <ellipse cx="42" cy="116.6" rx="30" ry="2.1" style="fill:${v("shadow")}" opacity=".55" filter="url(#fx-soft)"/>
    <path d="M13,116 C30,114.6 52,114.4 70,115.6 L70,117.2 L13,117.2 Z" style="fill:${v("shadow")}" opacity=".35" filter="url(#fx-hair)"/>
    <!-- 奥の脚と長い衣 -->
    <path d="${P.bootFar}" style="fill:${v("felt-dk")}"/>
    <path d="${P.robe}" fill="url(#hc-robe)"/>
    <!-- 脚の形: 腿の上の明るい面と、腿の下（ふくらはぎの陰）の暗がり -->
    <path d="M19.6,111.6 C25,108.8 32.6,104.2 40.4,98.2 C45.6,94.2 50.4,90.4 54.6,88.6 C56.4,92.6 57.4,100 57.8,107 L58.2,116 L16,116 Z" style="fill:${v("robe-dk")}" opacity=".45" filter="url(#fx-hair)"/>
    <path d="M13.6,115.6 C15.6,114.2 17.6,112.2 18.4,109.6" fill="none" style="stroke:${v("robe-lit")}" stroke-width=".45" opacity=".7"/>
    <path d="${taper([17.2, 112.6], [22.6, 113.4], [30.4, 115.6], 0.35)}" style="fill:${v("robe-dk")}" opacity=".7"/>
    <path d="${taper([63.0, 108.6], [65.2, 112.0], [67.6, 113.8], 0.3)}" style="fill:${v("robe-lit")}" opacity=".55"/>
    <path d="M22.4,101.4 C30,97.4 39.4,91.6 47.4,86.4 C50.2,84.6 52.8,83.6 55.4,83.8 C52.6,85.4 49.8,87.4 46.8,89.6 C39.4,94.8 31,99.8 23.2,103.6 Z" style="fill:${v("robe-lit")}" opacity=".4" filter="url(#fx-hair)"/>
    ${tp(FOLD_LIT, "robe-lit", 0.55)}
    <path d="M47.6,85.8 C50.2,84.0 53.0,83.2 55.2,83.6 C57.0,84.0 58.2,85.4 58.8,87.4" fill="none" style="stroke:${v("rim")}" stroke-width=".4" opacity=".75"/>
    <path d="M13.4,115.6 C30,114.8 52,114.8 67.6,113.9" fill="none" stroke="url(#g-foil)" stroke-width=".35" opacity=".7"/>
    ${tp(FOLDS, "robe-dk", 0.95)}
    <!-- 陰の側の線刻ハッチング（小道具と同じ銅版画の線） -->
    <rect x="0" y="30" width="100" height="90" fill="url(#pt-hatch-hc)" mask="url(#hc-shade-m)" opacity=".5"/>
    <path d="${P.boot}" style="fill:${v("felt-dk")}"/>
    <path d="M62.8,113.0 C65.0,112.5 67.6,112.8 69.4,114.0" fill="none" style="stroke:${v("rim")}" stroke-width=".3" opacity=".6"/>
    <!-- 短いケープ: 3 本のひだ、前の縁にライラックの裏地 -->
    <path d="${P.cape}" fill="url(#hc-cape)"/>
    ${tp(CAPE_FOLDS, "felt-dk", 0.85)}
    <path d="M15.8,90.6 C19.6,92 24.4,92.8 29.4,92.6 C34,92.4 38.6,91.4 42.2,89.8 C43.4,89.2 44.4,88.6 45,88" fill="none" stroke="url(#g-foil)" stroke-width=".42" opacity=".95"/>
    <path d="${P.lining}" style="fill:${v("lining")}"/>
    <path d="${P.liningBack}" style="fill:${v("lining")}" opacity=".9"/>
    <path d="M38.4,74.6 C40.8,79 42.8,83.6 44.4,87.8" fill="none" style="stroke:${v("lining-dk")}" stroke-width=".3" opacity=".7"/>
    <!-- 腕・本・手 -->
    <path d="${P.sleeve}" style="fill:${v("robe-dk")}"/>
    <path d="M34.2,87.4 C37.6,87.0 41,85.4 44,83.2" fill="none" style="stroke:${v("robe-lit")}" stroke-width=".35" opacity=".7"/>
    <path d="${P.handFar}" style="fill:${v("skin-sh")}"/>
    <g transform="translate(49.6 81.2) scale(1.16) translate(-49.6 -81.2)">
    <path d="${P.bookFar}" style="fill:${v("leather-1")}"/>
    <path d="${P.bookNear}" style="fill:${v("leather-dk")}"/>
    <path d="M44.6,84.4 L46.4,77.4 L50.0,78.2" fill="none" stroke="url(#g-foil)" stroke-width=".28"/>
    <path d="M48.8,86.6 L50.4,77.6" fill="none" style="stroke:${v("brass-mid")}" stroke-width=".35" opacity=".8"/>
    <path d="${P.pages}" style="fill:${v("page-lit")}"/>
    <path d="M46.0,76.1 L50.4,77.0 L55.5,75.3" fill="none" style="stroke:${v("page-sh")}" stroke-width=".25"/>
    </g>
    <path d="${P.hand}" style="fill:${v("skin")}"/>
    <path d="M44.8,81.6 C45.4,82.6 46.2,83.2 47.2,83.0" fill="none" style="stroke:${v("skin-sh")}" stroke-width=".3"/>
    <!-- 首・襟・留め金 -->
    <path d="${P.neck}" style="fill:${v("skin-sh")}"/>
    <path d="${P.collar}" style="fill:${v("felt")}"/>
    <path d="M30.8,72.8 C33.4,72.0 36.4,72.2 38.9,73.1" fill="none" style="stroke:${v("lining")}" stroke-width=".35" opacity=".8"/>
    <path d="M37.1,74.0 a1.15,1.15 0 1 0 1.3,1.65 a.9,.9 0 1 1 -1.3,-1.65 Z" fill="url(#g-brass)"/>
    <!-- 顔: 3/4、紙片の方を見上げる。開いた目・小さな口 -->
    <path d="${P.face}" fill="url(#hc-skin)"/>
    <g clip-path="url(#hc-face-clip)">
      <path d="M29,56 L44,56 L44,59.6 C40,59.2 35,59.6 29,61.4 Z" style="fill:${v("shadow")}" opacity=".3" filter="url(#fx-hair)"/>
      <ellipse cx="41.4" cy="65.6" rx="1.6" ry="1" style="fill:${v("cheek")}" opacity=".35" filter="url(#fx-hair)"/>
    </g>
    <path d="M38.4,60.9 C39.2,60.3 40.3,60.2 41.0,60.6" fill="none" style="stroke:${v("face-ink")}" stroke-width=".5" stroke-linecap="round"/>
    <ellipse cx="40.15" cy="61.35" rx=".55" ry=".68" style="fill:${v("face-ink")}"/>
    <circle cx="40.35" cy="61.1" r=".16" style="fill:${v("glint")}"/>
    <path d="M38.5,60.9 L37.9,60.5" fill="none" style="stroke:${v("face-ink")}" stroke-width=".35" stroke-linecap="round"/>
    <path d="${taper([38.4, 59.0], [39.6, 58.5], [40.9, 58.8], 0.18)}" style="fill:${v("hair-dk")}" opacity=".8"/>
    <path d="M41.1,65.5 C41.6,65.75 42.1,65.7 42.45,65.35" fill="none" style="stroke:${v("face-ink")}" stroke-width=".32" stroke-linecap="round" opacity=".75"/>
    <!-- 髪（茶のボブ、つばの下から数本こぼれる）と三日月の髪留め -->
    <path d="${P.hair}" fill="url(#hc-hair)"/>
    <path d="${taper([24.0, 59.6], [23.2, 64.8], [25.2, 70.0], 0.4)}" style="fill:${v("hair-dk")}" opacity=".75"/>
    <path d="${taper([28.4, 58.6], [29.8, 64.4], [30.4, 70.4], 0.36)}" style="fill:${v("hair-dk")}" opacity=".6"/>
    <path d="${taper([32.4, 58.4], [33.0, 62.4], [32.6, 68.0], 0.22)}" style="fill:${v("hair-lit")}" opacity=".55"/>
    <path d="${taper([22.2, 57.2], [20.6, 60.0], [20.4, 63.4], 0.18)}" style="fill:${v("hair")}"/>
    <path d="${taper([36.8, 57.6], [38.0, 58.6], [38.6, 60.2], 0.2)}" style="fill:${v("hair")}"/>
    <path d="M26.4,60.6 a1.05,1.05 0 1 0 1.35,1.55 a.82,.82 0 1 1 -1.35,-1.55 Z" fill="url(#g-brass)"/>
    <!-- 帽子: 山 → 帯（藍の天鵞絨＋金の細線、三日月のピン）→ つば -->
    <path d="${P.crown}" fill="url(#hc-felt)"/>
    <path d="M24.8,53.4 C24.1,50.3 23.9,47.3 24.6,44.6 C25.0,43.1 24.3,41.9 22.7,40.9 L24.6,40.4 C26.4,41.6 27.0,43.2 26.6,44.8 C26.0,47.4 26.2,50.2 26.9,52.9 Z" style="fill:${v("felt-lit")}" opacity=".45"/>
    <path d="${taper([25.4, 39.2], [26.8, 39.8], [28.0, 41.0], 0.2)}" style="fill:${v("felt-dk")}"/>
    <path d="${taper([26.0, 41.4], [27.2, 42.0], [28.0, 43.0], 0.14)}" style="fill:${v("felt-dk")}" opacity=".8"/>
    <path d="M31.6,36.2 C34.4,38.4 36.4,41.8 37.6,45.4" fill="none" style="stroke:${v("felt-dk")}" stroke-width=".5" opacity=".55"/>
    <path d="${P.band}" style="fill:${v("band")}"/>
    <path d="M24.6,51.2 C29.6,50.0 35.4,49.7 40.0,50.9" fill="none" stroke="url(#g-foil)" stroke-width=".3"/>
    <path d="M24.9,53.9 C29.6,52.5 35.4,52.2 40.6,53.2" fill="none" stroke="url(#g-foil)" stroke-width=".3"/>
    <path d="M34.6,50.6 a1.1,1.1 0 1 0 1.25,1.6 a.86,.86 0 1 1 -1.25,-1.6 Z" fill="url(#g-brass)"/>
    <path d="${P.brim}" fill="url(#hc-felt)"/>
    <path d="${P.brimUnder}" fill="url(#hc-brimu)"/>
    <path d="M13.6,56.2 C13.9,54.6 19.6,53.3 27.6,52.6 C35.8,51.9 46.4,51.6 50.6,52.6" fill="none" style="stroke:${v("rim")}" stroke-width=".4" opacity=".95"/>
    <!-- 縁の光（窓の光が回りこむ: 昼は日、夜は月）と、部屋側の照り返し（夜はろうそく） -->
    <rect x="0" y="30" width="100" height="90" style="fill:${v("rim")};opacity:var(--hc-rim,.8)" mask="url(#hc-rim)"/>
    <rect x="0" y="30" width="100" height="90" style="fill:${v("bounce")};opacity:var(--hc-bounce,.3)" mask="url(#hc-bounce)"/>
  </symbol>`;
}

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
