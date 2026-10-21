// 綴り入力（英単語・英字だけの答えの概念カード: Cu・CPC）で打てる別解かを決める 1 か所（Batch 73）。
// scripts/validate-words.mjs（綴り入力のカードの accept に打てない字があれば NG）と scripts/quality/sim-judge.mjs（打てない別解は untypeable の行）が使う。
// 綴り入力は物理キーの 1 字ずつ（js/judge.js spellStep）で、日本語は打てない（js/game.js handleCompositionEnd が英字に戻させる）。
// 判定の候補（js/answers.js acceptedAnswers）と同じく、小文字にして前後の空白を落とした形で見る。打てるのは半角の 0x20〜0x7e（英字・数字・記号・空白）だけ
export const SPELL_TYPEABLE = /^[\x20-\x7e]+$/;

export function isSpellTypeable(text) {
  return SPELL_TYPEABLE.test(String(text ?? "").toLowerCase().trim());
}
