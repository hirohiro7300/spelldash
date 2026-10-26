// 単語データのローダー。data/manifest.json を台帳として、
// カテゴリごとのJSONを fetch して読み込む（読み込み済みはキャッシュ）。
// 将来 math などの教科が増えても manifest に追記するだけで動く。

import { isCategoryLoaded } from "./packs.js";

const DATA_BASE = "/data/";

let manifestCache = null;
const categoryCache = new Map();

// 分野パックが持つジャンル表示名（tags[0] → ラベル）。読み込んだ分だけ溜まる
export const packGenreLabels = {};

export async function loadManifest() {
  if (!manifestCache) {
    const res = await fetch(`${DATA_BASE}manifest.json`);
    manifestCache = await res.json();
  }
  return manifestCache;
}

export async function getSubject(subjectId) {
  const manifest = await loadManifest();
  return manifest.subjects.find((s) => s.id === subjectId) ?? null;
}

// データの 1 語（data/*.json の words の 1 つ）を盤面で使う形にする（読み込みと、Node の検査・判定のシミュレーションで共通。純関数）。
// data = そのファイルの中身（subject・category・cardType・wordBank）、category = manifest のカテゴリ（pack）
export function toCard(word, data, category) {
  // pack: 分野パック／レベル別パックの語（追加した人だけに出る。「すべて」や Daily には混ぜない）
  // blank: 文法パック（穴埋め）。ラベルと入力欄の文言が変わる
  const base = {
    ...word,
    subject: data.subject,
    category: data.category,
    ...(category?.pack ? { pack: true } : {}),
    ...(data.cardType === "grammar" ? { blank: true } : {}),
    ...(data.cardType === "school" ? { school: true } : {}),
    // write: 英作文パック（日本語→英文を丸ごと打つ）。bank: 並べ替え（答えの語をシャッフルして見せる）
    ...(data.cardType === "writing" ? { write: true, ...(data.wordBank ? { bank: true } : {}) } : {})
  };
  // 概念カード: id のキーは word.en のまま残し、入力に使う en は「答え」に差し替える。
  // 答えが a-z のみ（cpc 等）なら通常のスペル入力、日本語や空白入りなら全文入力モードになる。
  // 英字だけの答えは、判定のために en を小文字にする（打つのは小文字で比べる）。表示は元の綴りのまま（answer。Cu・NaCl・ASEAN。answerLabel）
  if (word.kind === "concept") {
    const answer = String(word.answer ?? word.en).trim();
    const spell = /^[a-z-]+$/i.test(answer);
    return { ...base, key: word.en, en: spell ? answer.toLowerCase() : answer, accept: Array.isArray(word.accept) ? word.accept : [] };
  }
  return base;
}

// 答えの表示の綴り。判定の形（en。英字だけの答えは小文字）と大文字・小文字だけが違う元の答え（answer）があれば、そちらを見せる
// （元素記号の Cu・化学式の NaCl・略語の ASEAN。判定は en のまま小文字で比べるので、cu と打っても正解）。それ以外は en
export function answerLabel(word) {
  const en = String(word?.en ?? "");
  const raw = typeof word?.answer === "string" ? word.answer.trim() : "";
  return raw && raw !== en && raw.toLowerCase() === en ? raw : en;
}

// 1カテゴリ分の単語を読み込む。各単語に subject / category / label を注入して返す
export async function loadCategory(subjectId, categoryId) {
  const cacheKey = `${subjectId}/${categoryId}`;

  if (!categoryCache.has(cacheKey)) {
    const subject = await getSubject(subjectId);
    const category = subject?.categories.find((c) => c.id === categoryId);
    if (!category) return [];

    const res = await fetch(`${DATA_BASE}${category.file}`);
    const data = await res.json();
    if (data.genres && typeof data.genres === "object") Object.assign(packGenreLabels, data.genres);

    const words = data.words.map((word) => toCard(word, data, category));

    categoryCache.set(cacheKey, words);
  }

  return categoryCache.get(cacheKey);
}

// 教科の全カテゴリをまとめて読み込む（分野パックは追加済みのものだけ）
export async function loadAllWords(subjectId = "english") {
  const subject = await getSubject(subjectId);
  if (!subject) return [];

  const lists = await Promise.all(
    subject.categories.filter(isCategoryLoaded).map((c) => loadCategory(subjectId, c.id))
  );

  return lists.flat();
}
