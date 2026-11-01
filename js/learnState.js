// ===== 3 つの状態（これから・あやふや・覚えた。Batch 78。創業者の決定 §2・§3）の決まり（純関数） =====
// DOM なし・localStorage なし。import は js/mastery.js（answered）と js/retentionCalc.js（ローカルの暦日と日番号）だけ。Node から直に読む（scripts/test-learn-state.mjs）。
// 定義は docs/SPEC_LEARN_STATE.md。
//
// 記録: spelldash_word_stats の語ごとに、端末だけの欄 3 つ（js/sync.js statToRow は送らない。送る 15 列は変えない）:
//   ls    1 = あやふや、2 = 覚えた。欄が無ければ これから（0 は書かない）
//   lsd   あやふやの語で、自力正解を数えた日（ローカル暦日の日番号: js/retentionCalc.js dayNoOf）。数えていなければ無い
//   lsAt  中心の学習で最後に答えた時刻（ms）。状態が変わらない答えでも書く（あやふや・覚えたの出題の順に使う。Battle・Challenge は書かないので順が動かない）
//   lsf   目安（js/learnPace.js）の「初めて覚えた」の印。中心の学習で初めて覚えたになった日（日番号。1 以上）か、0 = 数えない
//         （移行・同期の初めの埋め・版 6 の式で覚えただった語。その語に中心の学習で初めて答えたときに付ける）。無ければまだ決めていない（Batch 78 段 4）
// 書くのは js/stats.js recordLearnAnswer（中心の学習の 3 つのモードだけが呼ぶ）、スキーマ 7 の移行（js/storage.js。ls だけ）、同期の初めの埋め（js/sync.js。ls だけ）。
// 数える母集団は公開の語（js/publicVocab.js）だけ。非公開の語の記録は残すが、欄を書かず、数えない。

import { answered } from "./mastery.js";
import { localDay, dayNoOf } from "./retentionCalc.js";

export const LEARN_NEW = 0; // これから（欄が無い）
export const LEARN_UNSURE = 1; // あやふや
export const LEARN_LEARNED = 2; // 覚えた
// 画面の名前はこの 3 つだけ（決定 §2。済み・習得・知ってたは出さない）。状態の値で引く
export const LEARN_LABELS = Object.freeze(["これから", "あやふや", "覚えた"]);
export const LEARN_FIELDS = Object.freeze(["ls", "lsd", "lsAt", "lsf"]);

// 欄に書いてある状態（1・2）。欄が無い・読めない値は null
export function storedState(stat) {
  const v = stat?.ls;
  return v === LEARN_UNSURE || v === LEARN_LEARNED ? v : null;
}

// 移行の式（旧の記録 → 状態。決定 §2「今の済み → 覚えた・解答記録あり・未済み → あやふや・解答記録なし → これから」）。
// 答えの記録 = js/mastery.js answered（自力正解・思い出せず・習得・知ってたのどれか。出題されただけの語・別解で答えを見ただけの語には無い）。
// 済み = isDone（呼ぶ側が渡す: js/categoryProgress.js classifyWord が learning・mastered・known＝js/bookPace.js isDoneState。写しをここに持たない。
// classifyWord は教材と出題の列のモジュールを連れてくるので、純なここからは import しない。js/storage.js loadLearnStateDeps が組む）。
// 済みの語には必ず答えの記録がある（知ってた・習得・自力正解の日時のどれか）ので、3 つは重ならない
export function stateFromRecord(stat, isDone) {
  if (!answered(stat)) return LEARN_NEW;
  return isDone(stat) ? LEARN_LEARNED : LEARN_UNSURE;
}

// 語の今の状態。欄があればその値、欄が無い語は fallback（ふだんは これから）。
// スキーマ 7 の移行が書けていない間だけ、呼ぶ側が fallback に「移行を試したときの記録から式で決めた状態」を渡す（js/storage.js learnStateSource の pending）。
// 今の記録に式を当て直さない: 同じタスクで先に走る今の書き手や Battle の答えで動いた記録から読むと、状態を変えない答えで状態が動く（反証 F1）
export function learnStateOf(stat, fallback = LEARN_NEW) {
  const s = storedState(stat);
  if (s !== null) return s;
  return fallback === LEARN_UNSURE || fallback === LEARN_LEARNED ? fallback : LEARN_NEW;
}

// あやふやの語が「今日の分」か（今日まだ 1 日分を数えていない: 数えた日 lsd が無いか、今日より前）。
// 中心の学習の出題の列（js/learnQueue.js）と学習状況の札（js/learnPace.js）が同じ決まりで数えるための 1 か所。
// 欄の無い語（版 6 の間の式の あやふや）は数えた日を持たないので、今日の分に入る
export function isUnsureDueToday(stat, today) {
  const day = storedState(stat) === LEARN_UNSURE && Number.isInteger(stat.lsd) ? stat.lsd : null;
  return day === null || (Number.isInteger(today) && day < today);
}

// 語の記録の状態の欄だけ（同期の取り込みで、端末の値を必ず残すのに使う: js/sync.js）
export function learnFieldsOf(stat) {
  const out = {};
  for (const key of LEARN_FIELDS) if (stat && stat[key] !== undefined) out[key] = stat[key];
  return out;
}

// 答えた時刻のローカル暦日の日番号（js/retentionCalc.js localDay → dayNoOf。端末の時間帯の 0 時で区切る。夏時間の日も 1 日は 1 日。
// 23:55 と翌日の 0:10 は別の日）。読めない時刻は null
export function learnDayOf(ms) {
  const ymd = localDay(new Date(ms));
  return ymd ? dayNoOf(ymd) : null;
}

// ===== 1 問の答えの種類 =====
// 中心の学習は 1 問に 1 回だけ書き手に渡す: × のあった問いはその × の種類（答え表示 reveal・1 打ミス miss・ヒント hint。後の打ち直しは渡さない）、
// × が無ければ打ち終えた種類:
//   exact      出題語そのまま
//   variant    綴り違い（favourite／favorite。js/judge.js finishKind）
//   altAccept  カードの accept にある別の語（画面「それも正解」）
//   altIndex   同じ訳の別のカードの語（js/answers.js の別解の索引。画面「それも正解」）
// 「それも正解」と出す別解は自力正解と同じに数える（決定 §3「別解」）。今の綴り入力に「表記ゆれを許すが正解に数えない」型は無い。
// 足すときは、ここに種類を足し、CLEAN_KINDS には入れない
export const ANSWER_KINDS = Object.freeze({
  exact: "exact",
  variant: "variant",
  altAccept: "altAccept",
  altIndex: "altIndex",
  reveal: "reveal",
  miss: "miss",
  hint: "hint"
});
const KINDS = new Set(Object.values(ANSWER_KINDS));
const CLEAN_KINDS = new Set([ANSWER_KINDS.exact, ANSWER_KINDS.variant, ANSWER_KINDS.altAccept, ANSWER_KINDS.altIndex]);

export function isAnswerKind(kind) {
  return KINDS.has(kind);
}

// 自力正解か（その問いに ×・ヒント・答え表示が無く、打ち終えた）。それ以外は ×
export function isCleanKind(kind) {
  return CLEAN_KINDS.has(kind);
}

// ===== 状態の動き（決定 §3・依頼の規則 5。速さは見ない） =====
// prev = { state, day }（day = lsd。無ければ null）、clean = 自力正解か、today = 答えた日の日番号。返り値も { state, day }:
//   これから + 自力正解 → 覚えた。これから + × → あやふや（数えた日なし）
//   あやふや + 自力正解: 数えた日なし → 今日を 1 日目に／数えた日が今日より前 → 覚えた／今日 → 変わらない（同じ日は何回でも 1 日分）／
//                        今日より後（時計が戻った・西へ日付をまたいだ）→ 変わらない（数えない。前に数えた日を残す: 前に数えた日より後の日だけを数える。
//                        置き直すと、元の日に戻ったときにその日を 2 日目にも数える。dataloss d13・創業者に送った既定）
//   あやふや + × → 数えた日を消す（その後の同じ日の自力正解が新しい 1 日目）
//   覚えた + 自力正解 → 変わらない。覚えた + × → あやふや（数えた日なし）
export function nextLearnState(prev, clean, today) {
  const state = prev?.state ?? LEARN_NEW;
  const day = Number.isInteger(prev?.day) ? prev.day : null;
  if (!clean) return { state: LEARN_UNSURE, day: null };
  if (state !== LEARN_UNSURE) return { state: LEARN_LEARNED, day: null };
  if (!Number.isInteger(today)) return { state, day }; // 日が読めない時刻: 数えない
  if (day === null) return { state: LEARN_UNSURE, day: today };
  if (day < today) return { state: LEARN_LEARNED, day: null };
  return { state, day }; // 今日・今日より後
}

// 中心の学習の 1 問の答えを語の記録に当てる（純）。stat = 答える前の語の記録（書き換えない）、kind = ANSWER_KINDS の値、nowMs = 答えた時刻、
// fallback = 欄の無い語の状態（learnStateOf と同じ。移行が書けていない間だけ渡す）。数えた日は、欄に書いてある あやふや のときだけ読む。
// 返り値 = 写した語の記録（ls・lsd・lsAt・lsf だけを替える。ほかの欄はそのまま）
export function applyLearnAnswer(stat, kind, nowMs, fallback = LEARN_NEW) {
  const prev = learnStateOf(stat, fallback);
  const day = storedState(stat) === LEARN_UNSURE && Number.isInteger(stat.lsd) ? stat.lsd : null;
  const today = learnDayOf(nowMs);
  const next = nextLearnState({ state: prev, day }, isCleanKind(kind), today);
  const out = { ...stat, ls: next.state };
  if (next.day === null) delete out.lsd;
  else out.lsd = next.day;
  out.lsAt = nowMs;
  const first = firstLearnedMark(stat, prev, next.state, today);
  if (first !== null) out.lsf = first;
  return out;
}

// ===== 目安の「初めて覚えた」の印 lsf（js/learnPace.js が数える。Batch 78 段 4。決定 §6「新しい覚えたの増加だけ」） =====
// 印はこの答えの写しに足すだけ（保存は recordLearnAnswer の同じ 1 回。setItem を増やさない）。一度付けたら替えない:
//   - 印の無い語が 覚えた のまま答えた（移行・同期の初めの埋め・版 6 の式で 覚えた だった語）→ 0（数えない。外れて戻っても数えない）
//   - 印の無い語が この答えで 覚えた になった → 今日の日番号（日が読めない時刻なら 0）
//   - それ以外（これから・あやふやのまま、印のある語）→ 足さない（null）
// 外れて戻った語は前の印のまま（もう一度は数えない）。移行・同期の埋め・今の書き手は印を書かない（その語に中心の学習で初めて答えたときに決まる）
export function firstLearnedMark(stat, prevState, nextState, today) {
  if (stat && stat.lsf !== undefined) return null;
  if (prevState === LEARN_LEARNED) return 0;
  if (nextState !== LEARN_LEARNED) return null;
  return Number.isInteger(today) && today > 0 ? today : 0;
}

// 目安に数える「初めて覚えた日」（1 以上の日番号）。数えない・まだ決めていない語は null
export function firstLearnedDay(stat) {
  const v = stat?.lsf;
  return Number.isInteger(v) && v > 0 ? v : null;
}

// ===== 移行・同期の初めの埋め（一度だけ書く） =====
// 状態の欄の無い公開の語のうち、答えの記録がある語に、移行の式で ls だけを書く（純）。table は書き換えない（語は写す）。
// ほかの欄・非公開の語・欄のある語・表でない値には触らない。何度当てても同じ（欄のある語は飛ばす）。
// before（同期の初めの埋めだけ）: 取り込む前の端末の表。その語に端末の答えの記録があれば埋めない
// （端末で答えた語の状態は、同期で届いた行で変えない。答えが Battle のものでも。決定 §4）。
// 返り値 { table: 埋めた表（埋めた語が無ければ null）, filled: 埋めた語の数, states: 埋めた語と状態（id → 1・2。Map。
// 移行が書けなかったときの読み手と書き手の fallback: js/storage.js learnStateSource） }
export function fillLearnStates(table, isPublic, isDone, before = null) {
  let next = null;
  const states = new Map();
  for (const id of Object.keys(table ?? {})) {
    const s = table[id];
    if (!s || typeof s !== "object" || storedState(s) !== null || !isPublic(id)) continue;
    if (before && answered(before[id])) continue;
    const state = stateFromRecord(s, isDone);
    if (state === LEARN_NEW) continue;
    next ??= { ...table };
    next[id] = { ...s, ls: state };
    states.set(id, state);
  }
  return { table: next, filled: states.size, states };
}

// 埋める候補があるか（欄の無い語に答えの記録がある）。公開の語かは見ない（表を読まずに決められる: スキーマ 7 の移行を、候補の無い端末ではその場で済ませる）
export function hasUnfilled(table) {
  for (const s of Object.values(table ?? {})) if (s && typeof s === "object" && storedState(s) === null && answered(s)) return true;
  return false;
}

// ===== 数え方（回の始め・回の終わり・学習状況だけ。答えのたびには数えない） =====
// 公開の語（vocab: js/publicVocab.js makePublicVocab）ごとに 1 回ずつ見る。これから = 総数 − あやふや − 覚えた（3 つの和は必ず総数）。
// pending = 移行が書けていない間だけ: 欄の無い語の状態（id → 1・2 の Map。js/storage.js learnStateSource。learnStateOf の fallback）
export function countLearnStates(table, vocab, pending = null) {
  let unsure = 0;
  let learned = 0;
  for (const id of vocab.order) {
    const s = learnStateOf(table?.[id], pending?.get(id));
    if (s === LEARN_UNSURE) unsure++;
    else if (s === LEARN_LEARNED) learned++;
  }
  return { new: vocab.total - unsure - learned, unsure, learned, total: vocab.total };
}
