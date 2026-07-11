// ===== Studyモードの調整値 =====
// Mix Control（出題比率）と New Word Learning Loop の数値をここに集約する。

// 回答済み（Familiar）割合の初期値。テンポ重視側に寄せる
export const DEFAULT_FAMILIAR_RATIO = 80;

// 同時に「学習中」にできるNew単語の上限（再出題でキューが埋まるのを防ぐ）
export const MAX_ACTIVE_NEW_WORDS = 3;

// New単語を「今日定着（Today Secured）」にするのに必要な同日の自力正解回数
export const NEW_WORD_DAILY_SUCCESS_TARGET = 4;

// n回目の自力正解後、何問後に再出題するか（±1のランダム幅を持たせる）
export const NEW_WORD_REVIEW_GAPS = [3, 5, 8];

// 同日2回目以降の自力正解に与えるXP（初回はフルXP。反復の目的は定着でありXPではない）
export const REPEAT_SUCCESS_XP = 3;
