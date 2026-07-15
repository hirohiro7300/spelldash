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

// レベルアップ時の解放メッセージ（該当しなければ空文字）
export function unlockNoteForLevel(level) {
  if (level === UNLOCK_NORMAL_LEVEL) return " 🔓 新しい難易度の単語が解放！";
  if (level === UNLOCK_HARD_LEVEL) return " 🔓 最高難易度の単語が解放！";
  return "";
}
