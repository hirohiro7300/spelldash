import { loadAllWords, loadManifest } from "./wordData.js";
import { toWordObjects } from "./myWords.js";
import { isCategoryLoaded, packsOf } from "./packs.js";

// 読み込んだ単語をページ内で共有するストア。
// ゲームはここからカテゴリで絞った出題リストを取り出す。

let allWords = [];
const wordIndex = new Map();
let manifest = null;

// マイ単語帳（端末ローカル）。「すべて」には含めず、カテゴリ "my" として扱う
let myWords = [];
const myIndex = new Map();

export const MY_CATEGORY = { id: "my", label: "マイ単語帳" };

export function refreshMyWords() {
  myWords = toWordObjects();
  myIndex.clear();
  for (const word of myWords) myIndex.set(word.id, word);
  return myWords;
}

window.addEventListener("spelldash:mywords", refreshMyWords);

export async function initWordStore(subjectId = "english") {
  manifest = await loadManifest();
  allWords = await loadAllWords(subjectId);

  // 「すべて」= 基本カテゴリの英単語だけ（概念カードと、追加式のパックの語は含めない）
  generalWords = allWords.filter((w) => !isConceptWord(w) && !w.pack);
  wordIndex.clear();
  for (const word of allWords) {
    // 同じ単語が複数カテゴリにある場合は最初のものを索引に使う
    // （idは教科-単語 形式なので、カテゴリ違いの同一単語は同じidを持ち、統計を共有する）
    if (!wordIndex.has(word.id)) {
      wordIndex.set(word.id, word);
    }
  }

  refreshMyWords();
  return allWords;
}

export function getAllWords() {
  return allWords;
}

// 概念カード（日本語で答えるカード）はカテゴリを選んだ人だけに出す。「すべて」には含めない
export function isConceptWord(word) {
  return word?.kind === "concept";
}

// 発音に使う英語（概念カードは say があればそれ、無ければ英語キー。日本語なら読まない）
export function speechTextOf(word) {
  if (!word) return "";
  if (word.say) return word.say;
  return /^[\x00-\x7f]+$/.test(word.en) ? word.en : "";
}

// 出題文（概念カードは場面の説明 q、それ以外は日本語訳）
export function promptOf(word) {
  return word?.q ?? word?.ja ?? "";
}

let generalWords = [];

export function getWordsByCategory(categoryId) {
  if (!categoryId || categoryId === "all") {
    return generalWords;
  }
  if (categoryId === MY_CATEGORY.id) {
    return myWords;
  }
  return allWords.filter((word) => word.category === categoryId);
}

export function findWord(wordId) {
  return wordIndex.get(wordId) ?? myIndex.get(wordId) ?? null;
}

// 表示・出題に使うカテゴリ（分野パックは追加済みのものだけ）＋マイ単語帳
export function getCategories(subjectId = "english") {
  const subject = manifest?.subjects.find((s) => s.id === subjectId);
  return [...(subject?.categories ?? []).filter(isCategoryLoaded), MY_CATEGORY];
}

// 教材ライブラリ用: 分野パックの一覧（追加の有無つき）
export function getPackCatalog(subjectId = "english") {
  const subject = manifest?.subjects.find((s) => s.id === subjectId);
  return packsOf(subject?.categories).map((c) => ({ ...c, enabled: isCategoryLoaded(c) }));
}
