// 判定器: 出題した語に対して、打った綴り・読み・答えを正解とみなすか（純関数。DOM・記録・時刻・音に触らない）。
// 盤面（js/game.js の Study・Challenge・Daily）は 1 打ごとに、ここの 1 打の関数（綴りの spellStep・ローマ字の romajiStep）を呼ぶ
// （物理キー・画面キーボード・Android の input 経路・前の語の続きとの突き合わせ judgeKey の見通しも、ここの関数で決める）。
// typeAnswer（新しい語を頭から打ったときの判定）は、その 1 打の関数を繰り返すだけ。scripts/test-judge.mjs（単体）と
// scripts/quality/sim-judge.mjs（全カードの判定のシミュレーション）は typeAnswer で判定を再現する。
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

// 綴り入力の 1 打（盤面の keydown・画面キーボード・Android の input 経路と typeAnswer が呼ぶ）。candidates = いま受け付ける綴り（candidatesNow）、
// typed = 受理した綴り、ch = 打った字（大文字は小文字で比べる）。返り値:
//   ok     受けたか（false は 1 打ミス＝×。typed は進めない）
//   typed  受けた後の綴り
//   done   この打鍵で完成した綴り（null = まだ）。出題語を打ち切ったら、より長い候補が残っていてもその場で完成（gym に対して gymnasium）。
//          別解は、まだ伸びる候補が残っている間は完成としない（advertisement の問いの ad。js/answers.js completedAnswer）
//   rests  完成したときに残る、より長い候補の続き（gym で完成したときの nasium。盤面が続きを次の語の打鍵にしない: js/game.js startSpellingSpill）
export function spellStep(candidates, typed, ch) {
  const before = String(typed ?? "");
  const next = before + String(ch ?? "").toLowerCase();
  if (viableAnswers(candidates, next).length === 0) return { ok: false, typed: before, done: null, rests: [] };
  const done = completedAnswer(candidates, next);
  return { ok: true, typed: next, done, rests: done ? continuationsOf(candidates, next) : [] };
}

// keys を新しい語の頭から 1 打ずつ打つと、どの打鍵も外れずに通るか（spellStep を繰り返す。状態を持たない。js/game.js judgeKey の見通し）
export function spellFitsFromStart(candidates, keys) {
  let typed = "";
  for (const ch of String(keys ?? "")) {
    const r = spellStep(candidates, typed, ch);
    if (!r.ok) return false;
    typed = r.typed;
  }
  return true;
}

// ===== ローマ字（日本語の答え） =====

// 1 語ぶんのローマ字の判定（js/romaji.js createRomajiMatcher）を作る。entries = ローマ字で打つ読み（romajiEntriesFor）。
// 答えを見た後は主な読みだけ（見せた読みを打って練習する。別の読みでは打ち直せない。盤面の revealAnswer と typeAnswer の revealed）
export function romajiMatcherFor(entries, { revealed = false } = {}) {
  return createRomajiMatcher(revealed ? [primaryReading(entries)] : entries);
}

// ローマ字の 1 打（盤面の keydown と typeAnswer が呼ぶ）: matcher（romajiMatcherFor）を 1 打進める。返り値:
//   ignored   ローマ字のキーでない字（空白・記号。判定しない・ミスにしない。matcher は変わらない）
//   ok        受けたか（ignored でなく false なら 1 打ミス＝×。matcher は変わらない）
//   done      この打鍵で、どれかの読みを打ち終えた（Enter なしで正解）。finished = 打ち終えた読みの番号（matcher.entries）
//   expected  ミスのとき、正しい綴りなら次に来た字（キーミスの記録用）
export function romajiStep(matcher, key) {
  const r = matcher.feed(key);
  return { ignored: r.ignored, ok: r.ok, done: r.ok && !!r.done, finished: r.finished, expected: r.expected };
}

// 状態を変えずに: matcher と同じ読みを keys で頭から打つと、どの打鍵も外れずに通るか（fits）・打ち終えるか（done）
// （js/game.js judgeKey の見通し: この字で読みを打ち終えるか・この字が 1 打目として通るか。答えを見た後は matcher と同じく主な読みだけ）
export function romajiFromStart(matcher, keys) {
  const r = createRomajiMatcher(matcher.entries).type(keys);
  return { fits: r.missAt === -1, done: r.missAt === -1 && !!r.done };
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

// 語を出した直後（前の語の続きは無い）に text を 1 字ずつ打ち、打ち終えたら Enter を押したときの結果。盤面と同じ 1 打の関数（spellStep・romajiStep）を
// 繰り返す。candidates = 綴り入力の候補（js/answers.js acceptedAnswers。先頭は出題語）。revealed = 答えを見た後（綴りは出題語だけ・読みは主な読みだけ）。
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
    const matcher = romajiMatcherFor(entries, { revealed });
    for (let i = 0; i < chars.length; i++) {
      const r = romajiStep(matcher, chars[i]);
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
  // Enter: 打った綴りがそのまま候補の 1 つに一致して止まっているなら、その語で確定する（null = 答えを開く＝×。js/game.js triggerEnter）
  const done = completedAnswer(cands, typed, { force: true });
  return done ? { how: "enter", kind: finishKind(done, word.en), done, at: chars.length } : { how: "reveal", at: chars.length };
}
