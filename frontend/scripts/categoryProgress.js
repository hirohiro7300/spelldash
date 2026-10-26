import { getCategories, getWordsByCategory } from "./wordStore.js";
import { getWordStats } from "./storage.js";
import { isUnresolved, isFamiliar } from "./studyQueue.js";

// ===== カテゴリ別の学習ステータス =====
//
// 単語ごとの状態を4つに分ける（学習者に見せる用語）:
//   習得     = mastered（複数日にまたがる10回のノーミス正解）
//   覚えた   = 自力で思い出せたことがあり、未解決ではない（Familiar。内部名は learning）
//   苦手     = 最後に思い出せなかったまま（Unresolved）
//   未着手   = まだ一度も出題されていない
//   知ってた = 初見でノーミス自力正解（学習ではないので「覚えた」に数えない）
// 語数はカテゴリチップと同じ数え方（カテゴリ間の重複語もそのまま数える）。
// 「すべて」の行は出さない（総数は js/learnedWords.js getLearnedCount が持つ）。

export function classifyWord(stat) {
  if (!stat || (stat.playCount ?? 0) === 0) return "untouched";
  // 初見で知っていた語（一度もつまずいていない）: 学習ではないので「覚えた」に数えない
  if (stat.knownOnSight && (stat.recallFail ?? 0) === 0 && !stat.mastered) return "known";
  if (stat.mastered) return "mastered";
  if (isUnresolved(stat)) return "weak";
  if (isFamiliar(stat)) return "learning";
  return "untouched";
}

// onlyId を渡すとそのカテゴリの行だけ（ホームのカードは現在のカテゴリ 1 行しか使わない）
export function computeCategoryProgress(onlyId = null) {
  const stats = getWordStats();
  return getCategories().filter((c) => !onlyId || c.id === onlyId).map((c) => {
    const words = getWordsByCategory(c.id);
    const row = { id: c.id, label: c.label, total: words.length, untouched: 0, weak: 0, learning: 0, mastered: 0, known: 0 };
    for (const word of words) row[classifyWord(stats[word.id])]++;
    row.learned = row.learning + row.mastered;
    return row;
  });
}


// 旧式の「覚えた」数（基本カテゴリの語だけ）。growth log の v1 の行を v2 に直すときの差分にだけ使う
export function computeLegacyLearnedCount() {
  const stats = getWordStats();
  let n = 0;
  for (const word of getWordsByCategory("all")) {
    const st = classifyWord(stats[word.id]);
    if (st === "learning" || st === "mastered") n++;
  }
  return n;
}
