// 品質の規則（scripts/quality/rules/*.mjs）で共有する小さな関数。DOM にもファイルにも触らない。

// 漢字だけを並べた文字列（「民撰議院設立の建白書」→「民撰議院設立建白書」）
export function kanjiOf(s) {
  return (String(s ?? "").match(/[㐀-鿿々〆]/g) ?? []).join("");
}

// 英単語のカード（概念カードでない・en と ja がある。基本カテゴリの英単語とレベル別パック）
export function wordCards(ctx) {
  return ctx.cards.filter((w) => w.kind !== "concept" && w.en && w.ja);
}

// かっこ書きを落として「・、／,」で区切った訳の語（js/jaAmbiguity.js の jaTokens と js/answers.js の altKey と同じ）
export function jaWords(ctx, ja) {
  const { jaTokens } = ctx.modules.jaAmbiguity;
  const { altKey } = ctx.modules.answers;
  return jaTokens(ja).map(altKey).filter(Boolean);
}

// 答えの漏れの率。答えの字のうち、問題文に出る 2 字以上の並びに入る字の割合（L2）と、
// 1 字ずつ問題文に出る字の割合（L1）。比べる前に NFKC・記号と空白を落とす・漢数字を数字に・小文字。問題文の「n月m日」は「nm」に
const KANSUJI = { 〇: "0", 一: "1", 二: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9", 十: "10" };
const normLeak = (s) =>
  String(s ?? "")
    .normalize("NFKC")
    .replace(/[・･\s「」『』（）()、。,.]/g, "")
    .replace(/[〇一二三四五六七八九十]/g, (c) => KANSUJI[c])
    .toLowerCase();
export function leakRates(answer, q) {
  const a = [...normLeak(answer)];
  const qq = normLeak(String(q ?? "").replace(/(\d+)月(\d+)日/g, "$1$2"));
  if (a.length < 2) return null;
  const cov2 = new Array(a.length).fill(false);
  const cov1 = new Array(a.length).fill(false);
  for (let i = 0; i < a.length; i++) {
    if (qq.includes(a[i])) cov1[i] = true;
    for (let j = i + 2; j <= a.length; j++) if (qq.includes(a.slice(i, j).join(""))) for (let k = i; k < j; k++) cov2[k] = true;
  }
  return { L2: cov2.filter(Boolean).length / a.length, L1: cov1.filter(Boolean).length / a.length };
}

// 漏れを測る概念カード（問題文がある・計算でない・英作文と文法の穴埋めでない）
export function leakTarget(w) {
  return w.kind === "concept" && w.raw.q && !w.calc && !w.write && !w.blank;
}

export const pct = (x) => `${Math.round(x * 100)}%`;

// 漢字の別表記に結んだ読み（docs/PACK_FORMAT.md「別表記の読み」）。カードの acceptReadings
// { "<accept の別表記>": "<読み>" | ["<読み>", …] } → Map(別表記 → 読みの配列〔書いたまま。正規化は呼ぶ側〕)。
// 形が違う値（オブジェクトでない・文字列でも文字列の配列でもない）は空の配列にする（validate-words が形の誤りを出す）
export function acceptReadingsOf(card) {
  const m = card?.acceptReadings ?? card?.raw?.acceptReadings;
  const out = new Map();
  if (!m || typeof m !== "object" || Array.isArray(m)) return out;
  for (const [alt, v] of Object.entries(m)) {
    out.set(alt, typeof v === "string" ? [v] : Array.isArray(v) && v.every((x) => typeof x === "string") ? v : []);
  }
  return out;
}
