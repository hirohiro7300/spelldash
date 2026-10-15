// 品質の規則（scripts/quality/rules/*.mjs）に渡す ctx を作る。読むだけ（データは書き換えない）。
//
//   import { loadContext } from "./ctx.mjs";
//   const ctx = await loadContext();                       // この木の data/ を読む
//   const ctx = await loadContext({ root, patch(files) }); // patch: 読んだ JSON（Map: カテゴリ id → ファイルの中身）を
//                                                          // カードにする前に書き換える（scripts/quality/test-check.mjs が使う）
//   const ctx = await loadContext({ dataRoot });           // data/ だけ別の木から読む（js/ はこの木。check.mjs --base が前の木の教材を
//                                                          // 今のコードで読むのに使う）
//
// ctx の中身（規則はこれだけを使う。js/ のモジュールは ctx.modules から。ファイルを自分で読まない）:
//   root           木の絶対パス（js/ を読む木）
//   dataRoot       data/ を読んだ木の絶対パス（ふだんは root と同じ）
//   manifest       data/manifest.json
//   categories     manifest の全カテゴリ（manifest の並び。各要素に subject を足した写し）
//   categoryById   Map: カテゴリ id → 上の要素
//   files          Map: カテゴリ id → カテゴリのファイル（data/<file> の JSON。words は生のカード）
//   cards          全カード。ゲームが読むのと同じ形（js/wordData.js の loadCategory を、fetch を data/ の読み込みに替えて呼ぶ）。
//                  manifest の並び・ファイルの中の並び。各カードに数えない（列挙されない）欄を 3 つ足してある:
//                    card.ref   "カテゴリ id:カード id"（基準線の書き方。例 "listing:concept-cpc"）
//                    card.raw   ファイルに書かれたままのカード（概念カードの answer の大文字など、読み込みで変わる前の値）
//                    card.entry manifest のカテゴリ（pack・group・label など）
//   cardsOf(id)    そのカテゴリのカード（manifest の並び）
//   cardByRef      Map: ref → カード
//   baseCards      基本カテゴリ（manifest で pack でない）のカード。ゲームでいつも読み込まれる
//   packIds        パック（manifest で pack:true）の id（manifest の並び）
//   ref(card)      card.ref と同じ（カテゴリ id とカード id から作る）
//   packRef(id)    パックそのものの当たり（説明文など）を書くときの ref: "<パック id>:*"
//   modules        { answers, romaji, jaAmbiguity, jaScript, wordData }（この木の js/ を読み込んだもの）
//   buildAlternativeIndex(words)  js/answers.js の同じ関数
//   altIndex(packIds = [])        基本カテゴリ＋指定のパックを有効にしたときの別解の索引（js/wordStore.js と同じ: manifest の並びの
//                                 カードから buildAlternativeIndex）。同じ組み合わせは 1 度だけ作る
//   altIndexAll()                 全カテゴリを有効にしたときの別解の索引
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let loadSeq = 0;

export async function loadContext({ root = ROOT, dataRoot, patch } = {}) {
  root = path.resolve(root);
  dataRoot = path.resolve(dataRoot ?? root);
  const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(dataRoot, "data", rel), "utf8"));
  const manifest = readJson("manifest.json");
  const categories = [];
  for (const s of manifest.subjects ?? []) for (const c of s.categories ?? []) categories.push({ ...c, subject: s.id });
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const files = new Map(categories.map((c) => [c.id, readJson(c.file)]));
  if (typeof patch === "function") patch(files, { manifest, categories });

  const importJs = (name, fresh = false) => import(pathToFileURL(path.join(root, "js", name)).href + (fresh ? `?ctx=${++loadSeq}` : ""));
  const [answers, romaji, jaAmbiguity, jaScript] = await Promise.all(["answers.js", "romaji.js", "jaAmbiguity.js", "jaScript.js"].map((n) => importJs(n)));

  // ゲームと同じ読み込み（js/wordData.js）。fetch("./data/<file>") を、上で読んだ（patch 済みの）JSON の写しに替える。
  // wordData.js は読み込んだカテゴリを覚えるので、loadContext ごとに別の写しを読み込む（?ctx=N）
  const byFile = new Map([["manifest.json", manifest], ...categories.map((c) => [c.file, files.get(c.id)])]);
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const rel = String(url).replace(/^\.?\/?data\//, "");
    if (!byFile.has(rel)) throw new Error(`ctx: 知らないデータの読み込み ${url}`);
    const body = structuredClone(byFile.get(rel));
    return { ok: true, status: 200, json: async () => body };
  };
  let wordData;
  const cards = [];
  const byCategory = new Map();
  try {
    wordData = await importJs("wordData.js", true);
    for (const c of categories) {
      const loaded = await wordData.loadCategory(c.subject, c.id);
      const raws = files.get(c.id).words ?? [];
      if (loaded.length !== raws.length) throw new Error(`ctx: ${c.id} の枚数が合わない（読み込み ${loaded.length}・ファイル ${raws.length}）`);
      const list = loaded.map((card, i) => {
        Object.defineProperties(card, {
          ref: { value: `${c.id}:${raws[i].id}`, enumerable: false },
          raw: { value: raws[i], enumerable: false },
          entry: { value: c, enumerable: false }
        });
        return card;
      });
      byCategory.set(c.id, list);
      cards.push(...list);
    }
  } finally {
    globalThis.fetch = prevFetch;
  }

  const cardByRef = new Map(cards.map((w) => [w.ref, w]));
  const baseCards = cards.filter((w) => !w.entry.pack);
  const packIds = categories.filter((c) => c.pack).map((c) => c.id);
  const indexCache = new Map();
  const altIndex = (ids = []) => {
    const set = new Set(ids);
    const key = categories.filter((c) => c.pack && set.has(c.id)).map((c) => c.id).join(",");
    if (!indexCache.has(key)) indexCache.set(key, answers.buildAlternativeIndex(cards.filter((w) => !w.entry.pack || set.has(w.entry.id))));
    return indexCache.get(key);
  };
  let allIndex = null;
  return {
    root,
    dataRoot,
    manifest,
    categories,
    categoryById,
    files,
    cards,
    cardsOf: (id) => byCategory.get(id) ?? [],
    cardByRef,
    baseCards,
    packIds,
    ref: (card) => card?.ref ?? `${card?.category}:${card?.id}`,
    packRef: (id) => `${id}:*`,
    modules: { answers, romaji, jaAmbiguity, jaScript, wordData },
    buildAlternativeIndex: answers.buildAlternativeIndex,
    altIndex,
    altIndexAll: () => (allIndex ??= answers.buildAlternativeIndex(cards))
  };
}
