// 画面の幅の区切り。app.css の @media と同じ値にする（片方だけ変えない）

/** これ以下の幅では、左右のパネルを閉じて始め、開くとキャンバスの上に重ねて出す（app.css の @media (max-width: 860px)） */
export const NARROW_MAX_PX = 860;

/**
 * これ以下の幅では、上部バーをまとめる（表示の切替・表示の設定・やり直す・ヘルプは ⋯ メニューへ）。
 * まとめない形の最小の幅（762px）が入らなくなる所。出し方は app.css の「上部バーの段階」（@media (max-width: 761px)）
 */
export const COMPACT_TOPBAR_MAX_PX = 761;

/** CSS の @media と同じ判定（innerWidth と違い、拡大率で端数の幅になっても CSS と食い違わない） */
function widthAtMost(px: number): boolean {
  return globalThis.matchMedia?.(`(max-width: ${px}px)`).matches ?? false;
}

/** 左右のパネルを重ねて出す狭い画面か */
export const isNarrowScreen = (): boolean => widthAtMost(NARROW_MAX_PX);

/** 上部バーをまとめている幅か */
export const isCompactTopbar = (): boolean => widthAtMost(COMPACT_TOPBAR_MAX_PX);
