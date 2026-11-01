// ===== 学習状況（stats.html の最初の画面。Batch 78 段 4。創業者の決定 §5・§6）の数と、全部覚えるまでの目安 =====
// 最初の画面に出す 6 つ（覚えた N / 総数・ランク・次のランクまであと M 語・これから・あやふや・覚えた）と、3 枚の札の下の目安の 1 行を、
// 語の記録（spelldash_word_stats）と最高到達ランク（spelldash_rank_peak）から決める純な関数。DOM なし・localStorage なし（Node から直に読む:
// scripts/test-learn-status.mjs）。描くのは js/statsView.js。
//
// 数（3 状態の語数）は js/learnState.js countLearnStates、ランクは js/rank.js（見せるランク = 最高到達ランクと今の語数の段の大きい方・
// 次のランクまで = 今の覚えた語数から正直に）。同じ決まりをここに写さない。
//
// 今日の分（あやふや）: あやふやの語のうち、今日まだ 1 日分を数えていない語（数えた日 lsd が無いか、今日より前の語。今日もう数えた語と、
//   時計が戻って先の日を数えている語〔今日答えても数えない〕は入れない）。0 で、あやふやが 1 語以上なら札に「今日の分は終わり」。
//   同じ決まりは中心の学習の列（js/learnQueue.js isLearnTarget。段 3）も持つ（二重に持っている。決まりを変えるときは両方を直す）。
//
// 目安（決定 §6「新しい覚えたの増加だけ」）: 進み = 中心の学習で初めて覚えたになった語（js/learnState.js の印 lsf の日）を、その日に 1 語ずつ数える。
//   移行・同期の初めの埋め・版 6 の式で覚えただった語（印 0）は数えない。外れて戻った語はもう一度は数えない（印は一度だけ付く）。× で引かない。
//   残り = 総数 − 今の覚えた。決まり（直近 14 暦日・進んだ日 3 日以上・1 日あたり = 進み ÷ 記録を始めてからの暦日数〔上限 14〕・365 日まで・
//   四捨五入）は Batch 76 の js/bookPace.js paceOf をそのまま使う（写さない）。
//   記録を始めた日 = 中心の学習で答えた跡のいちばん早い日（印 lsf の日と、最後に答えた時刻 lsAt の日の小さい方。lsAt は答えるたびに替わるので、
//   本当の始めの日より後になりうる。そのときは割る日数が短くなる）。どの語にも跡が無ければ待ちの文。
//   古い鍵 spelldash_book_pace（冊ごとの目安）は消さず、読まない。

import { LEARN_UNSURE, countLearnStates, learnStateOf, learnDayOf, firstLearnedDay, isUnsureDueToday } from "./learnState.js";
import { rankView } from "./rank.js";
import { paceOf, PACE_DAYS, PACE_WAIT, PACE_DEVICE_NOTE } from "./bookPace.js";

export const LEARN_PACE_TITLE = "全部覚えるまでの目安";
export const LEARN_PACE_NOTE = "覚えた で数えています。";
export const UNSURE_DONE_TODAY = "今日の分は終わり";

// あやふやの語のうち、今日まだ 1 日分を数えていない語の数（今日の分。数えた日が無いか今日より前）。pending = 版 6 の間の式の状態（js/storage.js learnStateSource）
export function unsureDueCount(table, vocab, pending, today) {
  let n = 0;
  for (const id of vocab.order) {
    const s = table?.[id];
    if (learnStateOf(s, pending?.get(id)) !== LEARN_UNSURE) continue;
    if (isUnsureDueToday(s, today)) n++;
  }
  return n;
}

// 目安の材料: 窓（今日−13〜今日）の中の、初めて覚えた日ごとの語の数 [[日, 数], ...]（日の昇順）と、記録を始めた日（無ければ null）
export function learnPaceRows(table, vocab, today) {
  const days = new Map();
  let start = null;
  const lo = Number.isInteger(today) ? today - (PACE_DAYS - 1) : null;
  for (const id of vocab.order) {
    const s = table?.[id];
    if (!s || typeof s !== "object") continue;
    const first = firstLearnedDay(s);
    if (first !== null) {
      start = start === null ? first : Math.min(start, first);
      if (lo !== null && first >= lo && first <= today) days.set(first, (days.get(first) ?? 0) + 1);
    }
    const at = Number.isFinite(s.lsAt) ? learnDayOf(s.lsAt) : null;
    if (Number.isInteger(at) && at > 0) start = start === null ? at : Math.min(start, at);
  }
  return { rows: [...days].sort((a, b) => a[0] - b[0]), start };
}

// 目安の 1 行。learned = 今の覚えた語数。返り値 { kind: "none" | "done" | "wait" | "pace", days?, line: { pre, num?, post? }, note }
// （none は出さない。line の num は太字にする数）
export function learnPaceOf({ table, vocab, learned, today }) {
  const { rows, start } = learnPaceRows(table, vocab, today);
  const r = paceOf({ total: vocab.total, done: learned, rows, start, today, unit: "語" });
  if (r.kind === "none") return { kind: "none", line: null, note: "" };
  if (r.kind === "done") return { kind: "done", line: { pre: "完了" }, note: LEARN_PACE_NOTE, gain: 0 };
  if (r.kind === "wait") return { kind: "wait", line: { pre: PACE_WAIT }, note: LEARN_PACE_NOTE, gain: r.gain, active: r.active };
  return {
    kind: "pace",
    days: r.days,
    gain: r.gain,
    active: r.active,
    span: r.span,
    line: { pre: "今のペースなら、あと約", num: r.days, post: "日です。" },
    note: `${LEARN_PACE_NOTE}${PACE_DEVICE_NOTE}`
  };
}

// 行の文字（検査・読み上げ用）
export function paceLineText(pace) {
  const l = pace?.line;
  return l ? `${l.pre}${l.num ?? ""}${l.post ?? ""}` : "";
}

// 最初の画面の数ぜんぶ。table = 語の記録、source = js/storage.js loadLearnStates の { vocab, pending }、peak = 最高到達ランク（js/rank.js readRankPeak）、
// today = 今日の日番号（js/bookPace.js todayNo）。返り値:
//   counts { new, unsure, learned, total }（3 つの和は total）・rank { rank, name, next: { rank, name, at, remaining } | null }・
//   computed = 今の語数の段（最高到達ランクより上なら、学習状況が spelldash_rank_peak を上げる）・due = 今日の分・pace = learnPaceOf
export function learnStatusOf({ table, source, peak = null, today }) {
  const { vocab, pending = null } = source;
  const counts = countLearnStates(table, vocab, pending);
  const rank = rankView(counts.learned, peak, vocab.total);
  return {
    counts,
    rank,
    computed: rankView(counts.learned, null, vocab.total).rank,
    due: unsureDueCount(table, vocab, pending, today),
    pace: learnPaceOf({ table, vocab, learned: counts.learned, today })
  };
}
