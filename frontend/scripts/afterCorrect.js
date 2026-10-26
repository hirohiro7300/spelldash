// ===== 正解のあと: 次の語までの待ち（Batch 58） =====
// 自力で正解した例文つきの語・概念カードだけ、答えと例文・解説を少し見せる。ほかは手応え（250ms）だけ。
// 時間はここだけで決める（js/game.js completeWord が使う。E2E が表を確かめる）。何も import しない
export const AFTER_CORRECT_KEY = "spelldash_after_correct";
export const AFTER_CORRECT_PACES = ["quick", "standard", "long"];
export const FEEDBACK_MS = 250; // 手応えだけ（例文なし・答えを見た後・腕試し）
export const MILESTONE_MS = 1400; // 覚えた のスタンプ・レベルアップの幕（1,200＋消える 220）
export const ADVANCE_GUARD_MS = 300; // 次の語が出てから、その語にまだ打っていない Enter／Esc を飲む
export const ECHO_AFTER_DONE_MS = 1200; // タイマーで進んだとき、前の語を打ち終えてからこの間の、次の語にまだ打っていない Enter／Esc も飲む（打ち終えたら Enter で次へ、の癖）
export const NOTE_RECHECK_MS = 500; // 覚え方のメモを書いている間は進めず、見直す間隔
export const GLANCE_MS = {
  quick: { example: 250, concept: 250 },
  standard: { example: 700, concept: 900 },
  long: { example: 2200, concept: 2600 }
};

export function getAfterCorrect() {
  try {
    const v = localStorage.getItem(AFTER_CORRECT_KEY);
    return AFTER_CORRECT_PACES.includes(v) ? v : "standard";
  } catch {
    return "standard";
  }
}

export function setAfterCorrect(v) {
  if (AFTER_CORRECT_PACES.includes(v)) localStorage.setItem(AFTER_CORRECT_KEY, v);
}

// glance = 答え・例文・解説を出すか（renderExplain＋showAnswer）
export function waitAfterCorrect({ concept, withExample, revealed, placement, pace = "standard" }) {
  if (revealed || placement || (!concept && !withExample)) return { ms: FEEDBACK_MS, glance: false };
  const table = GLANCE_MS[pace] ?? GLANCE_MS.standard;
  return { ms: table[concept ? "concept" : "example"], glance: pace !== "quick" };
}
