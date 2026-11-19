// 見取り図・手の詳しい画面・道の画面（src/deepmap/views）の入口。試し版（src/preview）とアプリ（P2）で同じ物を使う
//   model.ts     画面に出す形（計算の芯の数に単位と言葉を付ける。DOM を使わない）
//   overview.ts  3 年の見取り図（今日の手ごとの行）
//   pages.ts     手の詳しい画面・道の画面の仮の形
//   fanChart.ts  月の稼ぎの扇（SVG・縦線の札・表）
//   sections.ts  分かれ道の帯・進め方・行き先・道の行・見方と前提
//   views.css    見た目（アプリの色の名前 --bg-* --text-* --line-* --accent* を使う）

export * from "./format";
export * from "./model";
export { renderOverview, overviewRow } from "./overview";
export { renderMoveDetail, renderPathPage, type PageHandle, type MoveDetailOpts } from "./pages";
export { fanChart, type FanChartHandle } from "./fanChart";
export { notesSection, stripSection, planSection, destSection, pathSection } from "./sections";
export { distBar, scaleLegend, pill, splitBar, miniStrip } from "./parts";
