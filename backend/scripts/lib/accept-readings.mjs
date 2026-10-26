// カードの acceptReadings（漢字の別表記に結んだ読み。docs/PACK_FORMAT.md「別表記の読み」）を読む 1 か所。
// scripts/add-readings.mjs（書き足し）・scripts/validate-words.mjs（形の検査）・scripts/quality/common.mjs（品質の規則・sim-judge・反証の手がかり）が使う。
//   "acceptReadings": { "<accept の別表記>": "<読み>" | ["<読み>", …] }
// 形: 欄はオブジェクト（配列でない）。値は読み 1 つの文字列か、文字列の空でない配列。ほかの値（空の配列・文字列でない要素・数・オブジェクト）は形の誤り。
// 読みがひらがなの読みか・accept にあるか・別表記の形に合うかは、使う側（validate-words・規則 Q04）が見る

// 欄の形（オブジェクト）
export const isReadingsRecord = (m) => !!m && typeof m === "object" && !Array.isArray(m);

// 値 → 読みの配列（書いたまま）。形の誤りは null（空の配列も断る）
export function readingsList(v) {
  if (typeof v === "string") return [v];
  if (Array.isArray(v) && v.length && v.every((x) => typeof x === "string")) return v;
  return null;
}

// カードの欄（ファイルのカード、または ctx のカードの raw）。無い・形の誤りは null
export function readingsRecordOf(card) {
  const m = card?.acceptReadings ?? card?.raw?.acceptReadings;
  return isReadingsRecord(m) ? m : null;
}

// Map: 別表記 → 読みの配列（書いたまま。正規化は呼ぶ側）| null（値の形の誤り）。欄が無い・形の誤りなら空の Map
export function acceptReadingsOf(card) {
  const m = readingsRecordOf(card);
  return new Map(m ? Object.entries(m).map(([alt, v]) => [alt, readingsList(v)]) : []);
}
