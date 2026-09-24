import { loadAllWords, loadManifest } from "./wordData.js";
import { toWordObjects } from "./myWords.js";
import { isCategoryLoaded, packsOf } from "./packs.js";
import { buildAlternativeIndex, acceptedAnswers } from "./answers.js";

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
  categoryIndex.clear();
  for (const word of allWords) {
    // 同じ単語が複数カテゴリにある場合は最初のものを索引に使う
    // （idは教科-単語 形式なので、カテゴリ違いの同一単語は同じidを持ち、統計を共有する）
    if (!wordIndex.has(word.id)) {
      wordIndex.set(word.id, word);
    }
  }

  refreshMyWords();
  altIndex = buildAlternativeIndex(allWords);
  return allWords;
}

// 訳が同じ語どうしの表（広告 = ad / advertisement）。語の読み込み後に作り直す
let altIndex = new Map();

// この語を出したときに正解として受け入れる綴り（先頭は出題語）
export function answersFor(word) {
  return acceptedAnswers(word, altIndex);
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

// カテゴリ内の版を優先して引く。同じ id の語が複数カテゴリにある時（基本カテゴリと
// レベル別パックなど）、出題中のカテゴリの訳・品詞・例文を使う（統計は id で共有のまま）
const categoryIndex = new Map();
export function findWordIn(categoryId, wordId) {
  if (!categoryId || categoryId === "all" || categoryId === MY_CATEGORY.id) return findWord(wordId);
  let index = categoryIndex.get(categoryId);
  if (!index || index.size === 0) {
    index = new Map();
    for (const word of allWords) if (word.category === categoryId && !index.has(word.id)) index.set(word.id, word);
    categoryIndex.set(categoryId, index);
  }
  return index.get(wordId) ?? findWord(wordId);
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
