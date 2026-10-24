// ===== 書斎コレクションの表（品・確率・数・文言を 1 か所に。import なし・DOM なし・localStorage なし） =====
// 保存と台帳の規則は js/collectionStore.js、単体の検査は scripts/test-collection.mjs（node で直に import する）。
// 無料の MVP（創業者の決定 2026-10-22）: 通貨は学習と無料の報酬だけで得る「記憶のインク」（コードの名前は memoryInk）。
// 「書斎くじ」はインクだけで引ける無料のくじ。販売・有料のくじ・ショップは作らない。
// 数・確率・文言はここの定数だけを替える。品・重み・有効・販売区分を替えたら DRAW_TABLE_VERSION を上げる（検査が指紋で見る）。

const freeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) freeze(v);
  }
  return value;
};

export const COLLECTION_KEY = "spelldash_collection";
export const COLLECTION_CORRUPT_KEY = "spelldash_collection_corrupt"; // 読めなかった値の写し（js/storageGuard.js の包み）
export const COLLECTION_VERSION = 1;

// 通貨の名前（画面の名・詰めた表示・数える語）
export const MEMORY_INK = freeze({ id: "memoryInk", name: "記憶のインク", short: "インク", unit: "つ" });

// 受け取りの数: 今日の贈り物・その日最初の 10 語・今日の復習・一冊
export const REWARDS = freeze({ daily: 1, study10: 2, review: 1, book: 5 });
export const STUDY10_WORDS = 10;
export const DRAW_COST = 3; // 書斎くじ 1 回
export const DUPLICATE_REFUND = 1; // 持っている品が出たときに戻す数
export const FOLD_DAYS = 60; // これより古い日次の受け取りと抽選を合計（carry）に畳む（今日のセットの 60 日と同じ型。js/dailySet.js）
export const RECENT_DRAWS = 5; // 最近の獲得の数

// レアリティ: 重みは整数（合計が 100 でなくてよい）。並びは抽選表の版の一部（帯の順）
export const RARITIES = freeze([
  { id: "N", label: "N", weight: 70 },
  { id: "R", label: "R", weight: 25 },
  { id: "SR", label: "SR", weight: 5 }
]);

export const SLOTS = freeze([
  { id: "bg", label: "書斎の背景", order: 1 },
  { id: "desk", label: "机の小物", order: 2 },
  { id: "binding", label: "本の装丁", order: 3 },
  { id: "fx", label: "正解の演出", order: 4 }
]);

// 品。id は永続（所持・装着・抽選の記録が指す。替えない）。見た目は asset が指す（仮は CSS の見本: ref を data 属性などで当てる）。
// 本番のアセットに替えるときは asset と placeholder だけを替える（例: { kind: "image", src: "assets/images/collection/<id>.webp", w, h }）。
// source は入手の方法（今は書斎くじだけ）。enabled: false は抽選に入れず装着もできない（所持は残す）。order は表示の順だけ（抽選に使わない）。
// sale は将来の販売区分の余地（今は null だけ。null 以外は抽選に入れない）
const item = (id, slot, rarity, name, desc, order) => ({
  id,
  slot,
  rarity,
  name,
  desc,
  asset: { kind: "css", ref: `ph-${id}` },
  placeholder: true,
  equippable: true,
  source: "draw",
  enabled: true,
  order,
  sale: null
});

// 仮の 12 品（各スロットに N・R・SR が 1 つずつ。名と説明は仮）
export const ITEMS = freeze([
  item("bg-stone", "bg", "N", "灰の石壁", "灰色の石を積んだ壁。", 1),
  item("bg-brick", "bg", "R", "煉瓦の壁", "赤茶の煉瓦を積んだ壁。", 2),
  item("bg-oldmap", "bg", "SR", "古地図の壁", "古い地図を貼った壁。", 3),
  item("desk-hourglass", "desk", "N", "砂時計", "机の端に置く小さな砂時計。", 4),
  item("desk-paperweight", "desk", "R", "真鍮の文鎮", "紙を押さえる真鍮の文鎮。", 5),
  item("desk-globe", "desk", "SR", "小さな天球儀", "星の位置を示す小さな天球儀。", 6),
  item("binding-linen", "binding", "N", "麻の装丁", "麻の布で包んだ表紙。", 7),
  item("binding-redleather", "binding", "R", "赤革の装丁", "赤い革の表紙。", 8),
  item("binding-gilt", "binding", "SR", "金の箔押し", "金の箔で縁を押した表紙。", 9),
  item("fx-ripple", "fx", "N", "波紋", "思い出したとき、枠に波紋が広がる。", 10),
  item("fx-petal", "fx", "R", "花びら", "思い出したとき、花びらが一枚落ちる。", 11),
  item("fx-feather", "fx", "SR", "羽根", "思い出したとき、羽根が一枚舞う。", 12)
]);

const BY_ID = new Map(ITEMS.map((it) => [it.id, it]));

export function getItem(id) {
  return (typeof id === "string" && BY_ID.get(id)) || null;
}

// 品の一覧（表示の順）。無効の品は includeDisabled のときだけ
export function listItems({ slot, rarity, includeDisabled = false } = {}) {
  return ITEMS.filter((it) => (includeDisabled || it.enabled) && (slot === undefined || it.slot === slot) && (rarity === undefined || it.rarity === rarity)).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
}

// ===== 抽選表と抽選（純な関数。表示の順・配列の順に依存しない） =====
// 帯の並びは rarities の並び（版の一部）。品は帯の中で id の辞書順（UTF-16 の順。言語の設定に依存しない）。
// 抽選に入れる品: 有効・販売区分 null・入手が書斎くじ。品の無いレアリティは帯を作らない
export const DRAW_TABLE_VERSION = "t1";

export function buildDrawTable(items = ITEMS, rarities = RARITIES, version = DRAW_TABLE_VERSION) {
  const eligible = (Array.isArray(items) ? items : []).filter((it) => it && typeof it.id === "string" && it.enabled !== false && it.sale == null && it.source === "draw");
  const bands = [];
  let from = 0;
  for (const r of Array.isArray(rarities) ? rarities : []) {
    const weight = r?.weight;
    if (!Number.isInteger(weight) || weight <= 0) continue;
    const ids = [...new Set(eligible.filter((it) => it.rarity === r.id).map((it) => it.id))].sort();
    if (ids.length === 0) continue;
    bands.push({ rarity: r.id, weight, from, to: from + weight, items: ids });
    from += weight;
  }
  return freeze({ version, total: from, bands });
}

export const DRAW_TABLE = buildDrawTable();

// 乱数 r ∈ [0, 1) → { rarity, item }。x = r × total の帯を選び、帯の中の位置で品を選ぶ（帯の中の品は等しい確率）。
// 同じ r と同じ表なら同じ結果（抽選の記録の r と版から再現できる）。r が範囲の外・数でない・表が空なら null
export function pickDraw(r, table = DRAW_TABLE) {
  if (typeof r !== "number" || !(r >= 0 && r < 1) || !table || !(table.total > 0) || !Array.isArray(table.bands)) return null;
  const x = r * table.total;
  const band = table.bands.find((b) => x < b.to) ?? table.bands[table.bands.length - 1];
  const n = band.items.length;
  const index = Math.min(n - 1, Math.max(0, Math.floor(((x - band.from) / band.weight) * n)));
  return { rarity: band.rarity, item: band.items[index] };
}

const round2 = (v) => Math.round(v * 100) / 100;

// 提供の割合（画面の表）: レアリティごとと品ごとの %（小数 2 桁まで）
export function rateTable(table = DRAW_TABLE) {
  if (!table || !(table.total > 0)) return [];
  return table.bands.map((b) => ({
    rarity: b.rarity,
    percent: round2((b.weight / table.total) * 100),
    items: b.items.map((id) => ({ id, percent: round2((b.weight / table.total / b.items.length) * 100) }))
  }));
}

// 表の指紋（版と突き合わせる。scripts/test-collection.mjs）
export function drawTableFingerprint(table = DRAW_TABLE) {
  return (table?.bands ?? []).map((b) => `${b.rarity}:${b.weight}:${b.items.join(",")}`).join("|");
}

// ===== 文言（画面の文はここだけ。常体・絵文字なし。数は上の定数から組む） =====
// 部屋の会話文・説明文には N・R・SR を入れない（コレクションの窓と抽選の結果ではそのまま）。
// 「無料」の文は部屋（#room）の外の窓に置く（部屋の中と「本を足す」の窓では E2E が「無料で」を禁じる）
const receivedText = (n) => `${MEMORY_INK.name}を${n}${MEMORY_INK.unit}受け取った。`;
export const TEXT = freeze({
  currency: MEMORY_INK.name,
  currencyShort: MEMORY_INK.short,
  dailyName: "今日の贈り物",
  daily: `今日の贈り物。${receivedText(REWARDS.daily)}`,
  study10: `${STUDY10_WORDS}語思い出した。${receivedText(REWARDS.study10)}`,
  review: `今日の復習を終えた。${receivedText(REWARDS.review)}`,
  book: (title) => `「${title}」を終えた。${receivedText(REWARDS.book)}`,
  drawName: "書斎くじ",
  drawCost: `無料。${MEMORY_INK.name}${DRAW_COST}${MEMORY_INK.unit}で1回引ける。`,
  short: (need) => `${MEMORY_INK.short}が足りない。あと${need}${MEMORY_INK.unit}。`,
  duplicate: `もう持っている。${MEMORY_INK.name}${DUPLICATE_REFUND}${MEMORY_INK.unit}に変わった。`,
  rates: "提供の割合",
  notYet: "まだ",
  equip: "使う",
  unequip: "外す",
  equipped: "使っている",
  deviceOnly: "この端末のコレクション。ほかの端末には移らない。",
  cannotSave: `この端末に保存できない。${MEMORY_INK.name}は受け取れない。`,
  balance: (n) => `${MEMORY_INK.name} ${n}${MEMORY_INK.unit}`
});
