// 判定器: 出題した語に対して、打った綴り・読み・答えを正解とみなすか（純関数。DOM・記録・時刻・音に触らない）。
// 盤面（js/game.js の Study・Challenge・Daily）の判定の分岐はここを呼ぶ。scripts/test-judge.mjs（単体）と
// scripts/quality/sim-judge.mjs（全カードの判定のシミュレーション）も同じ関数で判定を再現する。
// ここに無いもの: 前の語の続きの持ち越し止め（spill）・正解後の待ち・次の語の直後の守り（どれも盤面の側。新しい語を頭から打つ判定は変えない）。
// Battle の判定（js/battle*.js）は別で、ここは使わない。
import { viableAnswers, completedAnswer, continuationsOf, isSpellingVariant } from "./answers.js";
import { createRomajiMatcher, readingEntries, primaryReading, hasJapaneseScript, hasKana } from "./romaji.js";

// ===== 答え方 =====

// 全文入力（Enter で答え全体を判定）: 答え（en）が a-z と - だけでない語（概念カードの英語の用語・英文・計算の答え）
export function isFreeAnswer(word) {
  return !!word && !/^[a-z-]+$/.test(word.en);
}

// ローマ字で打つ読みの一覧（日本語の答え: 鎌倉幕府 など。js/romaji.js readingEntries）。空 = ローマ字で打たない
export function romajiEntriesFor(word) {
  if (!word || word.calc || word.kanjiOnly || word.write || word.blank || word.kind !== "concept") return [];
  if (!hasJapaneseScript(word.en)) return [];
  const entries = readingEntries(word);
  // かなの読みが無い（英字の別解だけの自分の場面カード）は、答えを打てないので全文入力に戻す
  return entries.some((e) => hasKana(e.reading)) ? entries : [];
}

// 語の答え方: "romaji"（読みを 1 打ずつ。Enter なしで正解）／"free"（全文入力）／"spell"（英単語の綴りを 1 打ずつ。Enter なしで正解）。
// entries = ローマ字で打つ読み（romaji のときだけ中身がある）
export function answerModeOf(word) {
  const entries = romajiEntriesFor(word);
  if (entries.length > 0) return { mode: "romaji", entries };
  return { mode: isFreeAnswer(word) ? "free" : "spell", entries };
}

// ===== 綴り入力（英単語） =====

// いま受け付ける綴り: 答えを見た後は出題語だけ（別解でごまかせないように）。candidates の先頭は必ず出題語（js/answers.js acceptedAnswers）
export function candidatesNow(candidates, en, revealed) {
  return revealed ? [en] : candidates;
}

// 打った綴り（小文字）の続きになる候補が残っているか。残っていなければ、その字は 1 打ミス（×）
export function fitsAnswer(candidates, typed) {
  return viableAnswers(candidates, typed).length > 0;
}

// 打った綴りで完成する候補（null = まだ完成しない）。出題語を打ち切ったらその場で完成（gym に対して gymnasium が残っていても）。
// 出題語でない候補（別解）は、まだ伸びる候補が残っている間は完成としない（js/answers.js completedAnswer）
export function completesAs(candidates, typed) {
  return completedAnswer(candidates, typed);
}

// Enter: 打った綴りがそのまま候補の 1 つに一致して止まっているなら、その語で確定する（null = 答えを開く＝×）
export function enterAnswer(candidates, typed) {
  return completedAnswer(candidates, typed, { force: true });
}

// 打ち終えた綴りの続きになる、より長い候補の残り（gym で完成したときの nasium。盤面が続きを次の語の打鍵にしないために使う）
export function restsAfter(candidates, typed) {
  return continuationsOf(candidates, typed);
}

// 打ち終えた綴りの扱い: "exact"（出題語）／"variant"（綴り違い favourite／favorite。そのまま正解）／
// "alt"（別解。減点も × もしないが、出題語を見せて打ち直させる＝自力の正解にはしない）
export function finishKind(done, en) {
  if (done === en) return "exact";
  if (isSpellingVariant(done, en)) return "variant";
  return "alt";
}

// その完成が出題語として正解か（綴り違いを含む。別解は false）
export function isOwnAnswer(done, en) {
  return finishKind(done, en) !== "alt";
}

// 綴り入力の 1 打: ok = 受けたか（false は 1 打ミス）、typed = 受けた後の綴り、done = この打鍵で完成した綴り（null = まだ）
export function spellStep(candidates, typed, ch) {
  const next = String(typed ?? "") + String(ch ?? "").toLowerCase();
  if (!fitsAnswer(candidates, next)) return { ok: false, typed: String(typed ?? ""), done: null };
  return { ok: true, typed: next, done: completesAs(candidates, next) };
}

// ===== 全文入力 =====

// 表記ゆれを吸収して比較（全角/半角・空白・記号・大文字小文字・アポストロフィ）
export function normalizeAnswer(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s・／/\-‐－_（）()「」『』.,、。:：;；?？!！'’"”“]/g, "");
}

// 全文入力の答えが正解か（答え・データに書かれた別解のどれかに、表記ゆれを吸収して一致）
export function answerMatches(word, text) {
  const typed = normalizeAnswer(text);
  if (!typed) return false;
  const candidates = [word.en, ...(Array.isArray(word.accept) ? word.accept : [])];
  return candidates.some((c) => normalizeAnswer(c) === typed);
}

// ===== 新しい語を頭から打ったときの判定（単体の検査・判定のシミュレーション） =====

// 語を出した直後（前の語の続きは無い）に text を 1 字ずつ打ち、打ち終えたら Enter を押したときの結果。
// candidates = 綴り入力の候補（js/answers.js acceptedAnswers。先頭は出題語）。revealed = 答えを見た後（綴りは出題語だけ・読みは主な読みだけ）。
// 返り値:
//   how: "auto"（Enter なしで正解・別解）／"enter"（打ち終えて Enter で確定。× ではない）／"miss"（at 打目で 1 打ミス＝×）／
//        "reveal"（打ち終えても完成せず、Enter で答えが開く＝×）／"wrong"（全文入力の違う答え＝×）
//   kind: "exact" | "variant" | "alt"（how が auto・enter のとき）、done: 完成した綴り、at: 何打目（1 始まり。auto は完成した打鍵、miss は外れた打鍵、
//   enter・reveal・wrong は打った数）、expected: miss のときの期待した字、rest: auto で完成した後に残った字（盤面では前の語の続きとして飲む）
export function typeAnswer(word, candidates, text, { revealed = false } = {}) {
  const chars = [...String(text ?? "")];
  const { mode, entries } = answerModeOf(word);
  if (mode === "free") {
    return answerMatches(word, text) ? { how: "enter", kind: "exact", done: word.en, at: chars.length } : { how: "wrong", at: chars.length };
  }
  if (mode === "romaji") {
    const matcher = createRomajiMatcher(revealed ? [primaryReading(entries)] : entries);
    for (let i = 0; i < chars.length; i++) {
      const r = matcher.feed(chars[i]);
      if (r.ignored) continue; // ローマ字のキーでない字（空白・記号）は判定しない（js/game.js handleRomajiKey）
      if (!r.ok) return { how: "miss", at: i + 1, expected: r.expected };
      if (r.done) return { how: "auto", kind: "exact", done: matcher.entries[r.finished]?.reading ?? "", at: i + 1, rest: chars.slice(i + 1).join("") };
    }
    return { how: "reveal", at: chars.length };
  }
  const cands = candidatesNow(candidates, word.en, revealed);
  let typed = "";
  for (let i = 0; i < chars.length; i++) {
    const step = spellStep(cands, typed, chars[i]);
    if (!step.ok) return { how: "miss", at: i + 1, expected: word.en[typed.length] ?? "" };
    typed = step.typed;
    if (step.done) return { how: "auto", kind: finishKind(step.done, word.en), done: step.done, at: i + 1, rest: chars.slice(i + 1).join("") };
  }
  const done = enterAnswer(cands, typed);
  return done ? { how: "enter", kind: finishKind(done, word.en), done, at: chars.length } : { how: "reveal", at: chars.length };
}
