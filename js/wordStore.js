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
    if (!wordIndex.has(word.en)) {
      wordIndex.set(word.en, word);
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

export function findWord(en) {
  return wordIndex.get(en) ?? null;
}

export function getCategories(subjectId = "english") {
  const subject = manifest?.subjects.find((s) => s.id === subjectId);
  return subject?.categories ?? [];
}
