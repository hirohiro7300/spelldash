import { loadAllWords, loadManifest } from "./wordData.js";

// 読み込んだ単語をページ内で共有するストア。
// ゲームはここからカテゴリで絞った出題リストを取り出す。

let allWords = [];
const wordIndex = new Map();
let manifest = null;

export async function initWordStore(subjectId = "english") {
  manifest = await loadManifest();
  allWords = await loadAllWords(subjectId);

  wordIndex.clear();
  for (const word of allWords) {
    // 同じ単語が複数カテゴリにある場合は最初のものを索引に使う
    // （idは教科-単語 形式なので、カテゴリ違いの同一単語は同じidを持ち、統計を共有する）
    if (!wordIndex.has(word.id)) {
      wordIndex.set(word.id, word);
    }
  }

  return allWords;
}

export function getAllWords() {
  return allWords;
}

export function getWordsByCategory(categoryId) {
  if (!categoryId || categoryId === "all") {
    return allWords;
  }
  return allWords.filter((word) => word.category === categoryId);
}

export function findWord(wordId) {
  return wordIndex.get(wordId) ?? null;
}

export function getCategories(subjectId = "english") {
  const subject = manifest?.subjects.find((s) => s.id === subjectId);
  return subject?.categories ?? [];
}
