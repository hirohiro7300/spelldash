// 別解（同じ訳になる別の英単語）の扱い。
//
// 「始める」と出して start だけを正解にすると、begin と打った人は
// 1文字目で不正解になる。正しい語を思い出せているのに打てない、という状態は
// 「思い出して打つ」練習として成り立たない（2026-09-24 創業者指摘: 受験生の声）。
//
// SpellDash は同じ訳を持つ語を自分のデータの中に持っている（広告 = ad / advertisement）。
// それを集めて「この訳ならこの語も正解」の表を作り、打っている途中の文字列が
// どれかに一致している限り受け入れる。
import { jaTokens } from "./jaAmbiguity.js";

// 訳の見出しとして比較できる形にする。かっこ書きは落とす（「たくさん（a ___ of）」→「たくさん」）
export function altKey(token) {
  return String(token ?? "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .trim();
}

// 別解の索引に入れるカード: 訳があり、答えを綴りで打つ英単語（a-z とハイフン）のカード。
// 問題文・英作文・穴埋め・計算・学校の用語のカードは入れない
export function isAltCard(w) {
  return !!w?.en && !!w.ja && !w.q && !w.write && !w.blank && !w.calc && !w.school && /^[a-z][a-z-]+$/.test(w.en);
}

// 訳ごとのまとめ: 訳の見出し（altKey）→ (en → { pos, surePos, cards })。別解の索引（buildAlternativeIndex）・品質の規則 P2・
// 判定のシミュレーションの 1 字の訳（scripts/quality/sim-judge.mjs）が同じまとめ方を使う。訳はカードの ja を jaTokens で区切ったもの。
//   pos      その訳を持つその語のカードの品詞の札（重なりなし。札の無いカードは足さない）
//   surePos  そのうち、その訳の札として確かな札。札はカードに 1 つ（docs/PACK_FORMAT.md「2品詞なら主な方」）なので、
//            確かなのは訳が 1 つのカードの札だけ。訳が 2 つ以上のカード（かっこだけの説明も 1 つと数える）の札は、どの訳の札か分からない
//            （ngsl02 の only「～だけ・唯一の」の札は副だが、「唯一の」は形容詞の意味）
//   cards    その訳を持つその語のカード（カードの並び）
// oneChar: true なら 1 字の訳だけを集める（既定は 2 字以上。1 字の訳は偶然ぶつかるので別解には使わない）
export function meaningGroups(words, { oneChar = false } = {}) {
  const groups = new Map();
  for (const w of words) {
    if (!isAltCard(w)) continue;
    const tokens = jaTokens(w.ja);
    const sure = tokens.length === 1;
    for (const token of tokens) {
      const key = altKey(token);
      if (oneChar ? key.length !== 1 : key.length < 2) continue;
      let ens = groups.get(key);
      if (!ens) groups.set(key, (ens = new Map()));
      let e = ens.get(w.en);
      if (!e) ens.set(w.en, (e = { pos: [], surePos: [], cards: [] }));
      if (w.pos) {
        if (!e.pos.includes(w.pos)) e.pos.push(w.pos);
        if (sure && !e.surePos.includes(w.pos)) e.surePos.push(w.pos);
      }
      if (e.cards[e.cards.length - 1] !== w) e.cards.push(w); // 同じカードに同じ訳が 2 つあっても 1 度
    }
  }
  return groups;
}

// 同じ訳の 2 語（meaningGroups の要素）が品詞をまたぐか: 両方に確かな札があり、札（確かでない札も含む）が 1 つも重ならない。
// 片方でも確かな札が無ければ（札の無いカード・訳が 2 つ以上のカードの札だけ）またがない＝結ぶ（誤った × を出さない側）
export function crossesPos(a, b) {
  return a.surePos.length > 0 && b.surePos.length > 0 && !a.pos.some((p) => b.pos.includes(p));
}

// en → 別解の集合。全カードの訳を見て、同じ訳を持つ語どうしを結ぶ。
// ただし品詞をまたぐ組は結ばない（Batch 69。PR #175 で札の確かな組だけに）: その訳の札が両方で確かで、重ならない
// （repeatedly〔副「繰り返し」〕と repetition〔名「繰り返し」〕、resemble〔動「似ている」〕と similar〔形「似ている」〕）なら、別の語を問う問題なので別解にしない。
// 札が確かでない組（circa〔前「およそ・〜ごろ」〕と approximately〔副「およそ」〕、only〔副「～だけ・唯一の」〕と sole〔形「唯一の・単独の」〕）と、
// 札の無いカード（基本カテゴリ）しか無い語は今までどおり結ぶ（crossesPos）
export function buildAlternativeIndex(words) {
  const index = new Map();
  for (const ens of meaningGroups(words).values()) {
    if (ens.size < 2) continue;
    for (const [en, a] of ens) {
      for (const [other, b] of ens) {
        if (other === en || crossesPos(a, b)) continue;
        if (!index.has(en)) index.set(en, new Set());
        index.get(en).add(other);
      }
    }
  }
  return index;
}

// 綴り入力（1 字ずつ判定する答え: 英単語・英字の答えの概念カード Cu・CPC）の別解に使える綴り（PR #191 のレビュー 2・4）。
// 画面キーボード（js/keyboard.js ROWS）と Android の OS キーボードの input 経路（js/game.js handleTextInput）が判定に届けるのは a〜z だけで、
// 空白・数字・記号・日本語は打てない。使えるのは次の 2 つ（小文字にして前後の空白を落とした形で見る。acceptedAnswers と同じ）:
//   1. 英小文字で始まり、英小文字とハイフンの語（英単語のカードの accept と同じ決まり。scripts/validate-words.mjs）。ハイフンも画面キーボードに無いが、
//      答えの綴り（check-in・Wi-Fi）にもあるので決まりに残す（打ち方は docs/BACKLOG）
//   2. 答えに続ける語句: 答え（answer）の綴りで始まり、続きが半角の字で英字で終わる（a → a large・rest → rest api・edta → edta-2k）。
//      答えを打ち切った時点で答えとして完成し（completedAnswer）、続きは持ち越し止め（js/game.js startSpellingSpill）が英字だけを受ける
//      （続きの頭の空白・記号・数字は読み飛ばす）ので、画面キーボードでも打てる。続きが英字で終わらない語句（icd → icd-10）は打ち切れない
// validate-words・sim-judge・マイ単語帳（js/myWords.js）もここを読む
export const SPELL_ALT = /^[a-z][a-z-]*$/;
const CONTINUATION = /^[\x20-\x7e]*[a-z]$/;
export function isSpellAlt(text, answer = "") {
  const s = String(text ?? "").toLowerCase().trim();
  if (SPELL_ALT.test(s)) return true;
  const a = String(answer ?? "").toLowerCase().trim();
  return a.length > 0 && s.length > a.length && s.startsWith(a) && CONTINUATION.test(s.slice(a.length));
}

// この語を出したときに正解として受け入れる綴りの一覧（先頭は必ず出題語）。綴り入力の候補なので、データの別解は綴り入力で打てるもの（isSpellAlt）だけ
// （利用者の場面カード〔js/myWords.js〕の日本語の別解 https化 を候補に入れると、h が × にならず、ヒントで「化」が入り、NISA口座 の「口座」が続きとして残る）
export function acceptedAnswers(word, index) {
  const out = [word?.en].filter(Boolean);
  const push = (s) => {
    const v = String(s ?? "").toLowerCase().trim();
    if (v && !out.includes(v)) out.push(v);
  };
  // データに書かれた別解が最優先
  if (Array.isArray(word?.accept)) for (const a of word.accept) if (isSpellAlt(a, word?.en)) push(a);
  // 同じ訳を持つ他のカードの語
  if (index && word?.en) (index.get(word.en) ?? []).forEach(push);
  return out;
}

// 打ち途中の文字列に対して、まだ可能性の残っている綴りを返す
export function viableAnswers(candidates, typed) {
  const prefix = String(typed ?? "").toLowerCase();
  return candidates.filter((c) => c.startsWith(prefix));
}

// つづり違い（favourite / favorite、practise / practice、maths / math）は「別の語」ではなく
// 同じ語の綴り違い。別解として案内するのではなく、そのまま正解にする。
// 先頭が同じで、編集距離が語長の1/4以内（最低1、最大3）なら同じ語とみなす。
export function isSpellingVariant(a, b) {
  const x = String(a ?? "").toLowerCase();
  const y = String(b ?? "").toLowerCase();
  if (!x || !y || x === y) return false;
  if (x[0] !== y[0]) return false;
  const limit = Math.min(3, Math.max(1, Math.floor(Math.max(x.length, y.length) / 4)));
  if (Math.abs(x.length - y.length) > limit) return false;
  // 編集距離（limit を超えたら打ち切る）
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    if (Math.min(...cur) > limit) return false;
    prev = cur;
  }
  return prev[y.length] <= limit;
}

// いま打ち終わっているか。出題語（candidates[0]）を優先する:
// - 出題語を打ち切ったら、それより長い候補が残っていてもその場で完成（gym に対して gymnasium、a に対して an、sport に対して sports。
//   以前は「まだ伸びる」として止め、Enter で答えが開いて×になっていた。K0-1）
// - 出題語でない候補（別解）は、まだ伸びる綴りが残っている間は完成としない（出題語が advertisement で別解が ad のとき、"ad" で止めない）。
//   force（Enter）のときは、打った綴りに一致する候補で確定する
export function completedAnswer(candidates, typed, { force = false } = {}) {
  const prefix = String(typed ?? "").toLowerCase();
  const viable = viableAnswers(candidates, prefix);
  const exact = viable.filter((c) => c === prefix);
  if (exact.length === 0) return null;
  if (exact.includes(candidates[0])) return candidates[0];
  const canGrow = viable.some((c) => c.length > prefix.length);
  if (canGrow && !force) return null;
  return exact[0];
}

// 打ち終えた綴りの続きになる候補の残り（gym で完成したときの gymnasium → "nasium"、a → an の "n"）。
// 続けて打たれたキーを次の語の打鍵にしないために使う（js/game.js の打ち越し止め）
export function continuationsOf(candidates, typed) {
  const prefix = String(typed ?? "").toLowerCase();
  return candidates.filter((c) => c.length > prefix.length && c.startsWith(prefix)).map((c) => c.slice(prefix.length));
}
