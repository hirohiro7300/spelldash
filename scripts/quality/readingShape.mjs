// 別表記と読みの形が合うか（辞書を使わない粗い見張り。規則 Q04 が結んだ読みに使う。docs/PACK_FORMAT.md「別表記の読み」）。
// 字面のかな（ひらがな・カタカナ・ー）は、読みに同じ順でそのまま出る。かな以外の字の並びは、漢字 1 字が読みの 1〜4 字
// （魂 たましい・理 ことわり）、英字・数字 1 字が 1〜6 字（W → だぶりゅー）に当たる。漢字にはさまれた ケ・ヶ・ヵ・カ は漢字として数える
// （関ケ原・吉野ヶ里・一ヵ月）。記号・空白は読まない（normalizeReading で落ちる）。
// 答えと主な読みの 3,384 組で合わないのは 2 組だけ（平塚らいてう＝ひらつからいちょう の歴史的かなづかい、オイル漏れ＝おいるにじみ）
//   readingShapeOk("鎌倉ばくふ", "かまくらばくふ", normalizeReading) → true
//   readingShapeOk("大塩の乱", "おおしおらん", normalizeReading)   → false（「の」が読みに無い）
// normalizeReading は js/romaji.js の同じ関数（規則は ctx.modules.romaji から渡す。--root の木のコードで判定するため）
const KANA = /[ぁ-ゔー]/; // ゕ・ゖ（ヵ・ヶ を正規化した字）は か・が・こ と読むので かな に数えない
const LATIN = /[a-z0-9]/;
const PER_KANJI = 4;
const PER_LATIN = 6;

export function shapePattern(text, normalizeReading) {
  // 漢字にはさまれた ケ・ヶ・ヵ・カ は が・か・こ と読む字なので、漢字と同じに数える（々 に置き換える）。NFKC → ひらがな → 記号と空白を落とす → 小文字
  const t = normalizeReading(String(text ?? "").normalize("NFKC").replace(/(?<=[㐀-鿿々〆])[ケヶヵカ](?=[㐀-鿿々〆])/g, "々"));
  let src = "^";
  let min = 0;
  let max = 0;
  const flush = () => {
    if (min) src += `[ぁ-ゖーa-z0-9]{${min},${max}}`;
    min = max = 0;
  };
  for (const ch of t) {
    if (KANA.test(ch)) {
      flush();
      src += ch;
    } else {
      min += 1;
      max += LATIN.test(ch) ? PER_LATIN : PER_KANJI;
    }
  }
  flush();
  return new RegExp(src + "$");
}

export function readingShapeOk(text, reading, normalizeReading) {
  return shapePattern(text, normalizeReading).test(normalizeReading(reading));
}
