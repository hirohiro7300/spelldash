// かな（ひらがな・カタカナ・半角カナ）か漢字を含むか。romaji.js（約 25KB）を読み込まないページ（wordStore.js の読み上げの判定）でも使う
const JAPANESE_SCRIPT_RE = /[぀-ヿ㐀-鿿豈-﫿ｦ-ﾟ々〆]/;
export function hasJapaneseScript(text) {
  return JAPANESE_SCRIPT_RE.test(String(text ?? ""));
}
