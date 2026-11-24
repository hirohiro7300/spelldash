// 見取り図・手の詳しい画面・道の画面（src/deepmap/views）の入口。試し版（src/preview）とアプリ（P2）で同じ物を使う
//   model.ts     画面に出す形（計算の芯の数に単位と言葉を付ける。DOM を使わない）
//   overview.ts  3 年の見取り図（「10 の手をひと目で」と今日の手ごとの行・一番ありそうな道と真ん中あたりの道のボタン）
//   pages.ts     手の詳しい画面
//   path.ts      道の画面（3 か月に 1 行・開くと文章とほかの結果・手・切り替え・次の 3 か月へ）
//   fanChart.ts  月の稼ぎの扇（SVG・縦線の札・表）
//   sections.ts  分かれ道の帯・進め方・行き先・見方と前提
//   goal.ts      資産のゴール（見取り図の帯・芽の札・手の詳しい画面と道の終わりの 1 行。見た目は src/styles/goal.css）
//   views.css    見た目（アプリの色の名前 --bg-* --text-* --line-* --accent* を使う）

export * from "./format";
export * from "./model";
export { renderOverview, overviewRow, chainLinks, type OverviewMemo } from "./overview";
export { renderMoveDetail, type PageHandle, type MoveDetailOpts } from "./pages";
export { renderPathPage, type PathPageHandle, type PathPageOpts } from "./path";
export { fanChart, type FanChartHandle } from "./fanChart";
export { notesSection, stripSection, planSection, destSection } from "./sections";
export { distBar, scaleLegend, pill, pillValue, splitBar, miniStrip } from "./parts";
export {
  fillGoalSlots,
  goalEndText,
  goalMoveVM,
  goalOverviewVM,
  goalSeedEl,
  goalSkeletonEl,
  goalStripEl,
  goalViewKey,
  okuRange,
  type GoalMoveVM,
  type GoalNameOf,
  type GoalOverviewVM,
  type GoalSeedVM,
  type GoalStripVM,
  type GoalTileVM,
} from "./goal";
