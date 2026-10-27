// ===== 公開する英単語（教材「英単語」の 2,857 語。Batch 78）の読み手 =====
// 表は data/public/english.json（scripts/build-public-vocab.mjs の生成物。公開の id の唯一の表と学ぶ順。形は docs/PACK_FORMAT.md「公開する英単語」）。
// 語数はファイルの total（生成器の EXPECTED_TOTAL の 1 か所で決まる。ここに数を持たない）。3 状態（js/learnState.js）とランク（js/rank.js）が数える母集団。
// 上の makePublicVocab は純な関数（import なし・DOM なし。Node から直に読む: scripts/test-learn-state.mjs）。読み込み（fetch）は loadPublicVocab だけ。
// 表は後から読む（ページの読み込みでは取らない。js/storage.js のスキーマ 7 の移行と、中心の学習・学習状況が使うときに 1 回だけ取る）

export const PUBLIC_VOCAB_URL = "./data/public/english.json";

// 表の JSON → 読み手の形 { id, label, total, order, packs, source, positionOf(id), isPublic(id) }（packs = カードを持つ巻の id の並び）。
// order は学ぶ順（機能語は最後）。positionOf は order の何番目か（無い id は -1）。形が違う（語数と order の長さが合わない・id が重なる・文字列でない）なら投げる
export function makePublicVocab(json) {
  const order = json?.order;
  if (!Array.isArray(order) || order.length === 0) throw new Error("公開の英単語: order が無い");
  if (json.total !== order.length) throw new Error(`公開の英単語: total ${json.total} と order の ${order.length} 語が合わない`);
  const position = new Map();
  order.forEach((id, i) => {
    if (typeof id !== "string" || !id) throw new Error(`公開の英単語: ${i} 番目の id が文字列でない`);
    if (position.has(id)) throw new Error(`公開の英単語: id が重なる（${id}）`);
    position.set(id, i);
  });
  return Object.freeze({
    id: json.id ?? "english",
    label: json.label ?? "英単語",
    total: order.length,
    order: Object.freeze([...order]),
    packs: Object.freeze(Array.isArray(json.packs) ? [...json.packs] : []),
    source: json.source ? Object.freeze({ ...json.source }) : null,
    positionOf: (id) => position.get(id) ?? -1,
    isPublic: (id) => position.has(id)
  });
}

// ===== 読み込み（1 ページに 1 回。失敗したら次に呼んだときに取り直す） =====
let loaded = null; // 読めた表
let loading = null; // 読んでいる途中の Promise

export function loadPublicVocab() {
  if (loaded) return Promise.resolve(loaded);
  if (!loading) {
    loading = fetch(PUBLIC_VOCAB_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`公開の英単語: ${res.status}`);
        return res.json();
      })
      .then((json) => (loaded = makePublicVocab(json)))
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

// 読めていれば表、まだなら null（待たない読み手: js/stats.js の書き手は中心の学習が表を読んだ後にだけ呼ばれる）
export function publicVocabNow() {
  return loaded;
}
