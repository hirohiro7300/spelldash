// ===== 中心の学習の 3 つのモード（これから・あやふや・覚えた。Batch 78。創業者の決定 §4）: 出題の列と回の区切り（純関数） =====
// DOM なし・localStorage なし。import は js/learnState.js（状態の読み方と答えの種類）と js/judge.js（打ち終えた綴りの種類）だけ。
// Node から直に読む（scripts/test-learn-queue.mjs）。js/game.js は中心の学習を始めるときに動的 import で読む（ホームの読み込みを増やさない）。
//
// 入口は /?learn=new|unsure|learned（学習状況の 3 枚がここへ来る）と /?learn=next（ホームの「英単語を学ぶ」とナビ。resolveNextMode で 1 つのモードに決める）。
// 各モードは、その状態の語だけを出す:
//   これから（new）    状態の無い語だけ。公開の並び（js/publicVocab.js の order。機能語は最後）のまま。1 回 10 語
//   あやふや（unsure） 今日の分 = あやふやの語のうち、数えた日（lsd）が無いか今日より前の語（今日もう数えた語・時計が戻って先の日を数えている語は、
//                      今日は自力正解でも数えないので出さない）。中心の学習で最後に答えた時刻（lsAt。無ければ 0）の古い順、同じなら公開の並び。
//                      1 セットは最大 30 語（あやふやの語そのものは制限しない）。10 語ごとに区切り（ここで終える・続ける）、30 語の後に今日の分が
//                      残っていれば「続けて学ぶ」で次の 30 語。今日の分が 0 なら「今日の分は終わり」
//   覚えた（learned）  任意の復習。lsAt の古い順、同じなら公開の並び（答えるたびに後ろへ回るので、毎回同じ 10 語にはならない）。1 回 10 語
// 列は保存の中身だけから決まる（乱数・難しさの門・章の絞り込み・Battle と Challenge が書く欄〔期日・最後の出題〕を使わない）:
// 同じ保存なら同じ列。開き直しても入れ替わらない（PRESTART「出題の順」・contradictions c9）。
// 回の中で答えた語はもう出さない。順が来たときに対象でなくなっていた語（ほかのタブで答えた）は飛ばす。

import { LEARN_NEW, LEARN_UNSURE, LEARN_LEARNED, ANSWER_KINDS, learnStateOf, storedState, isUnsureDueToday } from "./learnState.js";
import { finishKind } from "./judge.js";

// 入口の値 → 状態（js/learnState.js の値）
export const LEARN_MODES = Object.freeze({ new: LEARN_NEW, unsure: LEARN_UNSURE, learned: LEARN_LEARNED });
// 1 セットの語数（あやふやは最初に出す 1 セットの上限。決定 §4）・区切りの間隔（あやふやのセットの途中だけ）
export const LEARN_SET_SIZE = Object.freeze({ new: 10, unsure: 30, learned: 10 });
export const LEARN_BREAK_EVERY = 10;

// 入口の値（?learn= の値）→ モードの名前。読めない値は null
export function parseLearnMode(value) {
  const v = String(value ?? "").trim();
  return Object.hasOwn(LEARN_MODES, v) ? v : null;
}

// 「英単語を学ぶ」（ホームのボタン・ナビ。Batch 78 段 5）の入口の値。モードではなく、回を始めるときにその人の今の記録から 1 つのモードに決める（resolveNextMode）
export const LEARN_NEXT = "next";
// 入口として読める値（3 つのモードと LEARN_NEXT）。読めない値は null
export function parseLearnEntry(value) {
  const v = String(value ?? "").trim();
  return v === LEARN_NEXT ? v : parseLearnMode(v);
}

// 「英単語を学ぶ」の行き先: あやふやの今日の分があれば あやふや、無ければ これから、これからも無ければ あやふや（今日の分は終わり）、
// 全部覚えたら 覚えた の復習。counts = js/learnState.js countLearnStates の数、due = あやふやの今日の分の語数（buildLearnQueue("unsure", …) の長さ）。
// ホームのボタンの文（js/pathView.js）と入口（js/game.js beginLearn）が同じこの決まりを使う
export function resolveNextMode(counts, due) {
  if (due > 0) return "unsure";
  if (counts?.new > 0) return "new";
  if (counts?.unsure > 0) return "unsure";
  return "learned";
}

// 中心の学習で最後に答えた時刻（無い・読めない値は 0 = いちばん古い）
function lsAtOf(stat) {
  const v = stat?.lsAt;
  return Number.isFinite(v) ? v : 0;
}

// 語がいまこのモードの対象か。stat = 語の記録、fallback = 欄の無い語の状態（移行が書けていない版 6 の間だけ: js/storage.js learnStateSource の pending）、
// today = 今日の日番号（js/learnState.js learnDayOf）。あやふやは今日の分だけ（数えた日が無いか今日より前。数えた日は欄に書いてある あやふや のときだけ読む）
export function isLearnTarget(mode, stat, fallback, today) {
  const want = LEARN_MODES[mode];
  if (want === undefined || learnStateOf(stat, fallback) !== want) return false;
  if (want !== LEARN_UNSURE) return true;
  return isUnsureDueToday(stat, today);
}

// このモードの列（id の並び。対象の語ぜんぶ。回の始めに 1 回だけ作る）。table = 語の記録、vocab = 公開の語（js/publicVocab.js）、pending = 上の fallback の Map
export function buildLearnQueue(mode, table, vocab, today, pending = null) {
  const ids = vocab.order.filter((id) => isLearnTarget(mode, table?.[id], pending?.get(id), today));
  if (mode === "new") return ids; // 公開の並びのまま
  return ids
    .map((id) => ({ id, at: lsAtOf(table?.[id]), pos: vocab.positionOf(id) }))
    .sort((a, b) => a.at - b.at || a.pos - b.pos)
    .map((x) => x.id);
}

// 列の from 番目から、まだ答えていない・今も対象の最初の語の番号（無ければ -1）。isTarget(id) = 今の保存で対象か（順が来たときに見る）
export function nextLearnIndex(queue, from, answered, isTarget) {
  for (let i = Math.max(0, from); i < queue.length; i++) {
    const id = queue[i];
    if (!answered.has(id) && isTarget(id)) return i;
  }
  return -1;
}

// 次の一手。setAnswered = このセットで答えた語の数、ackBreak = 区切りを見て「続ける」を選んだときの setAnswered（同じ所で 2 度出さない）、
// more = まだ出せる語があるか（nextLearnIndex が -1 でない）。返り値:
//   play   次の語を出す
//   break  あやふやのセットの途中の区切り（10・20 語。「ここで終える」「続ける」）
//   set    セットの終わり（10 語・あやふやは 30 語）。まだ出せる語がある: 「続けて学ぶ」で次のセット
//   done   出せる語が無い（これから・覚えたは尽きた、あやふやは今日の分は終わり）
export function learnStep(mode, { setAnswered, ackBreak = -1, more }) {
  if (!more) return "done";
  if (setAnswered >= LEARN_SET_SIZE[mode]) return "set";
  if (mode === "unsure" && setAnswered > 0 && setAnswered % LEARN_BREAK_EVERY === 0 && setAnswered !== ackBreak) return "break";
  return "play";
}

// ===== 1 問の答えの種類（js/learnState.js ANSWER_KINDS。自力正解かどうかは isCleanKind の 1 か所） =====
// × の無かった問いを打ち終えた綴り done と出題のカード word から: 出題語（大文字は小文字で比べる）exact・綴り違い variant（js/judge.js finishKind）・
// カードの accept にある別の語 altAccept・同じ訳の別のカードの語 altIndex（画面「それも正解」。どちらも自力正解: 決定 §3「別解」）
export function cleanKindOf(done, word) {
  const kind = finishKind(done, word?.en);
  if (kind === "exact") return ANSWER_KINDS.exact;
  if (kind === "variant") return ANSWER_KINDS.variant;
  const typed = String(done ?? "").toLowerCase().trim();
  const inAccept = Array.isArray(word?.accept) && word.accept.some((a) => String(a ?? "").toLowerCase().trim() === typed);
  return inAccept ? ANSWER_KINDS.altAccept : ANSWER_KINDS.altIndex;
}

// × の細目（js/game.js markRecallFail の detail.k: e 答え表示・m 1 打ミス・h ヒント）→ 種類。読めない細目は答え表示（× のまま）
export function failKindOf(k) {
  if (k === "m") return ANSWER_KINDS.miss;
  if (k === "h") return ANSWER_KINDS.hint;
  return ANSWER_KINDS.reveal;
}

// ===== 回の結果（答えた語の今の状態から数える。同じ語は 1 回だけ。保存できなかった答えは状態が動いていない） =====
// ids = この回で答えた語、返り値 { learned: 覚えた, unsure: あやふや, dayOne: あやふやのうち今日を 1 日目に数えた語 }
export function learnSummary(ids, table, pending, today) {
  let learned = 0;
  let unsure = 0;
  let dayOne = 0;
  for (const id of new Set(ids)) {
    const stat = table?.[id];
    const state = learnStateOf(stat, pending?.get(id));
    if (state === LEARN_LEARNED) learned++;
    else if (state === LEARN_UNSURE) {
      unsure++;
      if (storedState(stat) === LEARN_UNSURE && stat.lsd === today) dayOne++;
    }
  }
  return { learned, unsure, dayOne };
}
