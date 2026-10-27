import { loadAllWords, loadManifest, loadCategory } from "./wordData.js";
import { toWordObjects } from "./myWords.js";
import { isCategoryLoaded, packsOf } from "./packs.js";
import { buildAlternativeIndex, buildAlternativeIndexById, acceptedAnswers } from "./answers.js";
import { hasJapaneseScript } from "./jaScript.js";

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
  // 同じ id の語が複数の基本カテゴリにあっても「すべて」では 1 語（数えるのも出すのも 1 回）
  const seenGeneral = new Set();
  generalWords = allWords.filter((w) => !isConceptWord(w) && !w.pack && !seenGeneral.has(w.id) && seenGeneral.add(w.id));
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

// 発音に使う英語（概念カードは say があればそれ、無ければ英語キー。日本語なら読まない）。
// 答えが日本語のカード（鎌倉幕府・車検 など）は say があっても読まない（Batch 58。日本語で答える問題に英語の音は要らない）
export function speechTextOf(word) {
  if (!word) return "";
  if (hasJapaneseScript(word.en)) return "";
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
  // 漢字の書き分けが目的のカード（kanjiOnly: 問題文に読みが書いてある）は、ローマ字で読みを打つ方式では問えないので出さない。
  // データは残す（findWord では引ける。記録・単語帳の古い行のため）。docs/PACK_FORMAT.md
  return allWords.filter((word) => word.category === categoryId && !word.kanjiOnly);
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

// ===== 公開の英単語（中心の学習の 3 つのモード: これから・あやふや・覚えた。Batch 78） =====
// 中心の学習は公開の 24 巻（data/public/english.json の packs。NGSL）のカードだけを出す。同じ id の語が基本カテゴリにもあると findWord は
// 基本カテゴリの版を返すので、公開の版はここで別に引く（findWord・answersFor・getWordsByCategory の結果は変えない: Battle・Study は今のまま）。
// 別解の索引は公開のカードだけから、カードの id で作る（js/answers.js buildAlternativeIndexById: 同じ綴りのカードの別解を混ぜない）。
// 紛らわしい訳（同じ訳の語に例文の訳を添える）は、そのカードの巻の中だけで見る（publicPackWords。2,857 語を毎問走査しない）。
// 読むのは中心の学習を始めるときだけ（ホームの読み込みでは取らない）。別解はどの巻の語でもありうるので、24 巻を並べて取る。
// 読めなければ null（投げない。次に呼んだときに読み直す）
let publicStore = null; // { byId: id → カード, byPack: 巻の id → カードの列, altIndex: id → 別解の綴りの集合 }
let publicLoading = null;

export function loadPublicWords(subjectId = "english") {
  if (publicStore) return Promise.resolve(publicStore);
  publicLoading ??= import("./publicVocab.js")
    .then((pv) => fetch(pv.PUBLIC_VOCAB_URL))
    .then((res) => {
      if (!res.ok) throw new Error(`公開の英単語: ${res.status}`);
      return res.json();
    })
    .then(async (json) => {
      const packs = Array.isArray(json?.packs) ? json.packs : [];
      const lists = await Promise.all(packs.map((id) => loadCategory(subjectId, id)));
      const byId = new Map();
      const byPack = new Map();
      packs.forEach((id, i) => {
        const words = lists[i].filter((w) => !w.kanjiOnly);
        byPack.set(id, words);
        for (const w of words) if (!byId.has(w.id)) byId.set(w.id, w);
      });
      if (byId.size === 0) throw new Error("公開の英単語: カードが無い");
      publicStore = { byId, byPack, altIndex: buildAlternativeIndexById([...byId.values()]) };
      return publicStore;
    })
    .catch(() => null)
    .finally(() => {
      publicLoading = null;
    });
  return publicLoading;
}

// 公開の版のカード（読めていない・公開の語でなければ null）
export function publicWord(wordId) {
  return publicStore?.byId.get(wordId) ?? null;
}

// 公開のカードを出したときに正解として受け入れる綴り（先頭は出題語。別解は公開のカードの id の索引から）
export function publicAnswersFor(word) {
  return acceptedAnswers(word, publicStore?.altIndex ?? null, word?.id);
}

// そのカードの巻の語（紛らわしい訳の判定の範囲）
export function publicPackWords(word) {
  return publicStore?.byPack.get(word?.category) ?? [];
}
