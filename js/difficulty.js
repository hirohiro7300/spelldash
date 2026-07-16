import { getLevelState } from "./level.js";

// 単語難易度のレベル解放。
// 「最初から難しい単語が出て離脱する」を防ぎ、レベルアップに
// 「新しい単語が解放される」という報酬性を持たせる。
//
// 適用範囲: 新出単語の導入（Study補充・Challenge抽選・ミッションNew）のみ。
//   - 既にプレイしたことのある単語は常に出題対象（学習記録を壊さない）
//   - Daily Dash は全員共通問題のため適用しない（公平性維持）

export const UNLOCK_NORMAL_LEVEL = 5;
export const UNLOCK_HARD_LEVEL = 10;

// 解放されている難易度のSet。全解放ならnull（フィルタ不要の意）
export function allowedWordLevels(playerLevel = getLevelState().level) {
  if (playerLevel < UNLOCK_NORMAL_LEVEL) return new Set(["easy"]);
  if (playerLevel < UNLOCK_HARD_LEVEL) return new Set(["easy", "normal"]);
  return null;
}

export function isWordLevelAllowed(word, allowed = allowedWordLevels()) {
  return !allowed || allowed.has(word.level);
}

// 新出単語リストへのゲート適用。
// 解放難易度の語が1語も無いカテゴリ（例: ITはeasy 0語）では、
// そのカテゴリに存在する最も易しい難易度を許可する。
// カテゴリ選択はユーザーの明示的な意思なので「何も出ない」を絶対に作らない
export function filterByAllowedLevels(words, allowed = allowedWordLevels()) {
  if (!allowed) return words;

  const gated = words.filter((w) => allowed.has(w.level));
  if (gated.length > 0) return gated;

  for (const level of ["easy", "normal", "hard"]) {
    const fallback = words.filter((w) => w.level === level);
    if (fallback.length > 0) return fallback;
  }

  return words;
}

// レベルアップ時の解放メッセージ（該当しなければ空文字）
export function unlockNoteForLevel(level) {
  if (level === UNLOCK_NORMAL_LEVEL) return " 🔓 新しい難易度の単語が解放！";
  if (level === UNLOCK_HARD_LEVEL) return " 🔓 最高難易度の単語が解放！";
  return "";
}
