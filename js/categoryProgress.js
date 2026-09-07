import { getCategories, getWordsByCategory } from "./wordStore.js";
import { getWordStats } from "./storage.js";
import { isUnresolved, isFamiliar } from "./studyQueue.js";

// ===== カテゴリ別の学習ステータス =====
//
// 単語ごとの状態を4つに分ける（学習者に見せる用語）:
//   習得     = mastered（複数日にまたがる10回のノーミス正解）
//   覚えかけ = 自力で思い出せたことがあり、未解決ではない（Familiar）
//   苦手     = 最後に思い出せなかったまま（Unresolved）
//   未着手   = まだ一度も出題されていない
//   知ってた = 初見でノーミス自力正解（学習ではないので「覚えた」に数えない）
// 語数はカテゴリチップと同じ数え方（カテゴリ間の重複語もそのまま数える）。

export function classifyWord(stat) {
  if (!stat || (stat.playCount ?? 0) === 0) return "untouched";
  // 初見で知っていた語（一度もつまずいていない）: 学習ではないので「覚えた」に数えない
  if (stat.knownOnSight && (stat.recallFail ?? 0) === 0 && !stat.mastered) return "known";
  if (stat.mastered) return "mastered";
  if (isUnresolved(stat)) return "weak";
  if (isFamiliar(stat)) return "learning";
  return "untouched";
}

export function computeCategoryProgress() {
  const stats = getWordStats();
  const categories = [{ id: "all", label: "すべて" }, ...getCategories()];

  return categories.map((c) => {
    const words = getWordsByCategory(c.id);
    const row = { id: c.id, label: c.label, total: words.length, untouched: 0, weak: 0, learning: 0, mastered: 0, known: 0 };
    for (const word of words) row[classifyWord(stats[word.id])]++;
    row.learned = row.learning + row.mastered;
    return row;
  });
}
