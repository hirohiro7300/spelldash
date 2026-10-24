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

// スロット。id は永続（保存の equipped の鍵・品の id の頭）。MVP の窓の景色は window（部屋全体の背景は段 2 で別の id にする）
export const SLOTS = freeze([
  { id: "window", label: "窓の景色", order: 1 },
  { id: "desk", label: "机の小物", order: 2 },
  { id: "binding", label: "本の装丁", order: 3 },
  { id: "fx", label: "正解の演出", order: 4 }
]);

// 品の絵の置き場と名前: assets/images/collection/<item-id>-<variant>.webp（コアは参照の文字列だけを持つ。絵は別に入る）
export const COLLECTION_ASSET_DIR = "assets/images/collection/";
export const ASSET_VARIANTS = freeze(["day", "night", "thumb", "cover", "frame", "sprite", "prop"]);
export const assetPath = (id, variant) => `${COLLECTION_ASSET_DIR}${id}-${variant}.webp`;

// 品。id は永続（所持・装着・抽選の記録が指す。替えない。形は <スロット>-<名>）。見た目は asset が指す:
//   絵の品 { kind: "image", files: { <variant>: "assets/images/collection/<id>-<variant>.webp", … } }・CSS だけの品 { kind: "css", ref: <id> }。
// placeholder: true は絵がまだ入っていない（画面は CSS の仮の見た目で出す）。絵をコミットした品から false にする（CSS だけの品は最初から false）。
// source は入手の方法（今は書斎くじだけ）。enabled: false は抽選に入れず装着もできない（所持は残す）。order は表示の順だけ（抽選に使わない）。
// sale は将来の販売区分の余地（今は null だけ。null 以外は抽選に入れない）
const item = (id, slot, rarity, name, desc, order, variants) => ({
  id,
  slot,
  rarity,
  name,
  desc,
  asset: variants.length ? { kind: "image", files: Object.fromEntries(variants.map((v) => [v, assetPath(id, v)])) } : { kind: "css", ref: id },
  placeholder: variants.length > 0,
  equippable: true,
  source: "draw",
  enabled: true,
  order,
  sale: null
});

// MVP の候補（2026-10-24 の G の案。創業者の確定の前）: 12 品（各スロットに N・R・SR が 1 つずつ。名と説明は仮）。
// 1 品は 1 つのスロットだけを変える。同じ系統から無料に出すのは 2 スロットまで（3 スロットの揃いを作らない）
export const ITEMS = freeze([
  item("window-rain", "window", "N", "雨の町", "窓の外に雨の町が見える。", 1, ["day", "night"]),
  item("window-morning", "window", "R", "朝の町", "窓の外に朝の町が見える。", 2, ["day", "night"]),
  item("window-moon", "window", "SR", "月の町", "窓の外に月の出た町が見える。", 3, ["day", "night"]),
  item("desk-notebook", "desk", "N", "茶革の手帳", "机の端に置く茶色い革の手帳。", 4, ["prop"]),
  item("desk-hourglass", "desk", "R", "胡桃の砂時計", "胡桃の枠の砂時計。", 5, ["prop"]),
  item("desk-grimoire", "desk", "SR", "星空の魔導書箱", "星空を描いた魔導書の箱。", 6, ["prop"]),
  item("binding-brown", "binding", "N", "深茶の革", "深い茶色の革の表紙。", 7, ["cover", "thumb"]),
  item("binding-redleather", "binding", "R", "深紅の革と真鍮の角", "深紅の革に真鍮の角を付けた表紙。", 8, ["cover", "thumb"]),
  item("binding-memory-tree", "binding", "SR", "記憶の樹の藍", "藍の地に記憶の樹を押した表紙。", 9, ["cover", "thumb"]),
  item("fx-gold-edge", "fx", "N", "金の縁", "思い出したとき、枠が金に変わる。", 10, []),
  item("fx-layered-paper", "fx", "R", "重なる紙", "思い出したとき、紙が重なる。", 11, ["frame", "thumb"]),
  item("fx-ink-star", "fx", "SR", "雫が星に", "思い出したとき、雫が星に変わる。", 12, ["sprite"])
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
  deviceOnly: "この端末に保存。ほかの端末には移らない。",
  cannotSave: `この端末に保存できない。${MEMORY_INK.name}は受け取れない。`,
  balance: (n) => `${MEMORY_INK.name} ${n}${MEMORY_INK.unit}`,
  // 窓の UI の文（作業役 G の設計 §1 の案）
  openLabel: "コレクション",
  tabList: "一覧",
  tabDraw: "書斎くじ",
  howToEarn: `${STUDY10_WORDS}語思い出すと${REWARDS.study10}${MEMORY_INK.unit}、今日の復習を終えると${REWARDS.review}${MEMORY_INK.unit}受け取れる。`,
  draw: `引く（${MEMORY_INK.short}${DRAW_COST}${MEMORY_INK.unit}）`,
  drawAgain: "もう1回引く",
  got: (name) => `${name}を手に入れた。`,
  recent: `最近の${RECENT_DRAWS}回`,
  filterAll: "すべて",
  previewTitle: "書斎の見本",
  wasEquipped: (prev) => `${prev}は外した。`
});
