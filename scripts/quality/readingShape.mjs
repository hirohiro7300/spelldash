// 別表記と読みの形が合うか（辞書を使わない粗い見張り。規則 Q04 が結んだ読みに使う。docs/PACK_FORMAT.md「別表記の読み」）。
// 字面のかな（ひらがな・カタカナ・ー）は、読みに同じ順でそのまま出る。かな以外の字は、次の数の読みの字に当たる（並んだ字は数を足す）:
//   漢字          1 字に 1〜5 字（魂 たましい・志 こころざし・詔 みことのり・承る の 承 うけたまわ）
//   数字の並び    0 でない数字 1 字に 1 字から（並び全体で 1 字から）、位の読みの長さの和まで（1000 → せん・100000 → じゅうまん・
//                 1192 → せんひゃくきゅうじゅうに。読みに数字のまま書いた 1192ねん も合う）。0 の位は読まないので、数字 1 字に 1 字とはしない
//   英字          1 字に 1〜6 字（W → だぶりゅー・X線 → えっくすせん。読みに英字のまま書いた げんかいcpa も合う）。
//                 語として読む頭字語（LAN → らん）は 1 字に 1 字に足りないので合わない（読みに英字のまま lan と書くか、結ばない）
//   単位の記号    ℃ ℉ ％ ‰ ° は 1 字に 1〜5 字（ど・せっしど・ぱーせんと。読まない読みは誤り: 50％ → ごじゅう）
//   読む記号      ＆ × ÷ ＋ − ／ は 0〜4 字（Q&A → きゅーあんどえー・2×4 → つーばいふぉー・A/B → えーびー。読まなくてもよい）
//   漢字にはさまれた ケ・ヶ・ヵ・カ は漢字と同じ枠（関ケ原・吉野ヶ里・一ヵ月。markFreeKana。反証の表 kanjiReadings.mjs も同じ関数で見分け、
//                 か・が・こ・け の 1 字に並べる。どちらも け・か の字のままでは読まない）
// ほかの記号・空白は読まない（normalizeReading で落ちる）。
// 答えと主な読みの 3,384 組で合わないのは 2 組だけ（平塚らいてう＝ひらつからいちょう の歴史的かなづかい、オイル漏れ＝おいるにじみ）。
// 緩めた分（漢字 4 → 5 字・数字の並び・記号）の誤検出と見逃しの数は docs/PACK_FORMAT.md「別表記の読み」
//   readingShapeOk("鎌倉ばくふ", "かまくらばくふ", normalizeReading) → true
//   readingShapeOk("大塩の乱", "おおしおらん", normalizeReading)   → false（「の」が読みに無い）
// normalizeReading は js/romaji.js の同じ関数（規則は ctx.modules.romaji から渡す。--root の木のコードで判定するため）
const KANA = /[ぁ-ゔー]/; // ゕ・ゖ（ヵ・ヶ を正規化した字）は か・が・こ と読むので かな に数えない
export const PER_KANJI = 5;
const PER_LATIN = 6;
const UNIT_MAX = 5;
const OPT_MAX = 4;
// 私用領域の字（normalizeReading で落ちない・読みには出ない）を、数え方の印に使う
export const FREE = ""; // 漢字にはさまれた ケ・ヶ・ヵ・カ（漢字と同じ枠）
const UNIT = ""; // ℃ ℉ ％ ‰ °
const OPT = ""; // ＆ × ÷ ＋ − ／

// 漢字にはさまれた ケ・ヶ・ヵ・カ（が・か・こ と読む字）を FREE にした字面（NFKC 済み）。readingShape と kanjiReadings の 1 か所
export function markFreeKana(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/(?<=[㐀-鿿々〆])[ケヶヵカ](?=[㐀-鿿々〆])/g, FREE);
}

// 数字 n 桁の読みの長さの上限: 位ごとに 一の位 4（きゅう・ふぁいぶ）・十 6（きゅうじゅう）・百 6（きゅうひゃく）・千 5（きゅうせん）、
// 4 桁ごとに まん・おく・ちょう の 3
export function digitsMax(n) {
  let max = 0;
  for (let p = 0; p < n; p++) max += [4, 6, 6, 5][p % 4] + (p > 0 && p % 4 === 0 ? 3 : 0);
  return max;
}

export function shapePattern(text, normalizeReading) {
  // 単位の記号は NFKC の前に（℃ は NFKC で °C になる）。読む記号は NFKC の後に（＆ → & など）。そのあと ひらがな・記号と空白を落とす・小文字
  const marked = markFreeKana(String(text ?? "").replace(/[℃℉]/g, UNIT))
    .replace(/[%‰°]/g, UNIT)
    .replace(/[&×÷+−/]/g, OPT);
  const t = normalizeReading(marked);
  let src = "^";
  let min = 0;
  let max = 0;
  const flush = () => {
    if (max) src += `[ぁ-ゖーa-z0-9]{${min},${max}}`;
    min = max = 0;
  };
  for (const [s] of t.matchAll(/[0-9]+|[a-z]+|[^]/gu)) {
    if (KANA.test(s)) {
      flush();
      src += s;
    } else if (/^[0-9]/.test(s)) {
      min += Math.max(1, s.replace(/0/g, "").length);
      max += digitsMax(s.length);
    } else if (/^[a-z]/.test(s)) {
      min += s.length;
      max += s.length * PER_LATIN;
    } else if (s === UNIT) {
      min += 1;
      max += UNIT_MAX;
    } else if (s === OPT) {
      max += OPT_MAX;
    } else {
      // 漢字・FREE・ほかの字（ギリシャ文字など）
      min += 1;
      max += PER_KANJI;
    }
  }
  flush();
  return new RegExp(src + "$");
}

export function readingShapeOk(text, reading, normalizeReading) {
  return shapePattern(text, normalizeReading).test(normalizeReading(reading));
}
