import { saveWordStats, editWordStats, getWordStats, wordStatsChars, learnStateSource, recordsEpoch, whenWordStatsSaved } from "./storage.js";
import { markWordDirty } from "./sync.js";
import { noteFirstRecall, noteAnswer } from "./retentionLog.js";
import { touchStudyTime } from "./studyTime.js";
import { answerContext, nextRank, isFirstAnswer, isSlipFail, typedCharsOf, intervalAfter, keepLaterDue, unseenFailCap, SRS_STEPS, MAX_INTERVAL_DAYS, MIN_GAP_MS, isUnresolved, isKnownWord, isKnownWaiting } from "./mastery.js";
import { noteRankCheck, tickMasteryMeta } from "./masteryMeta.js";
import { localDay, dayDiff, dayNoOf } from "./retentionCalc.js";
import { BASE_VARIANT, readShadow, writeShadow, shadowOf, shadowInit, shadowPredict, shadowSuccess, shadowSameDay, shadowFail, migrateState } from "./memoryModel.js";
import {
  noteCalibration,
  noteSpeedNext,
  noteXNext,
  noteCapHit,
  noteSamples,
  noteInputCount,
  speedBasis,
  classP20,
  classTp,
  encodePend,
  decodePend,
  encodeMark,
  qBandOf,
  aBandOf,
  tickMemoryCheck,
  CLS_CODE,
  CLS_CHAR,
  T1_MIN as CHECK_T1_MIN,
  T1_MAX as CHECK_T1_MAX
} from "./memoryCheck.js";
import { getMemoryWord, putMemoryWord, tickMemoryWords, prefetchMemoryWords, useWordStatsReader } from "./memoryWords.js";
import { applyLearnAnswer, isAnswerKind } from "./learnState.js";

// 語ごとの記録の質（js/memoryWords.js）は、書く直前に語の記録と照らし合わせ（復元・消去の後の書きかけを書き戻さない）、
// 語の記録の字数を見て端末の枠を分ける（学習の記録と合わせて js/storageGuard.js SHARED_BUDGET 字まで）
useWordStatsReader(getWordStats, wordStatsChars);

// 簡易SRS: 連続ノーミス正解数 → 次の復習までの日数
// 1回→1日後、3連続→3日後、10連続→30日後（それ以上は30日固定）。表は js/mastery.js の SRS_STEPS の 1 か所（習熟度の S2 も同じ表を読む）
const REVIEW_INTERVAL_DAYS = SRS_STEPS;

function daysFromNow(days, nowMs = Date.now()) {
  const d = new Date(nowMs);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

export function localDateString(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function reviewIntervalFor(streak) {
  const index = Math.min(Math.max(streak, 1), REVIEW_INTERVAL_DAYS.length) - 1;
  return REVIEW_INTERVAL_DAYS[index];
}

// 書き手は editWordStats の表に書く（js/storage.js の中身は読み手と共有。表の写しは 1 タスク 1 回、書く語は写してから書く）
export function recordPlay(word) {
  const stats = editWordStats();
  stats[word] = stats[word] ? { ...stats[word] } : createInitialWordStats();

  stats[word].playCount += 1;
  stats[word].lastPlayed = new Date().toISOString();
  saveWordStats(stats);
  markWordDirty(word);
  touchStudyTime(); // 学習時間（js/studyTime.js）。計測は装飾: 失敗しても記録は済んでいる
  prefetchMemoryWords(); // 記録の質（spelldash_memory_words）を手が空いたときに読んでおく（答えのタスクで JSON から戻さない）
}

// 答える前の stat の控え（習熟度。js/mastery.js）。○ は recordCorrect が先に streak・mastered を書き換えるので、
// recordCorrect の先頭（写す前）で控え、同じタスクの recordRecallSuccess（id が同じとき）が使う。メモリーだけ（word_stats には書かない）。
// マイクロタスクで捨てる（答え表示の後の打ち直しで recordCorrect だけが呼ばれたとき、次の答えへ持ち越さない。js/storage.js の draft と同じ作法）。
// Battle（凍結）は recordCorrect(id, wasClean) → recordRecallSuccess(id) の今の呼び方なので、この控えの仕組みで答える前の段を渡す
let pendingAnswer = null; // { id, rankBefore, knownBefore, clean, ctx, streakDays, stat }

// ctx = 答える前の stat の answerContext。js/game.js は速さの分類のために同じ値を持っているので渡す（二重に計算しない）。
// 渡さない呼び方（Battle・答えを見た後の打ち直し）はここで計算する。段と確認待ちは ctx から読む（rank = rankOf、knownCheck = isKnownWaiting）
function holdPendingAnswer(word, stat, wasClean, ctx = null) {
  try {
    const c = ctx ?? answerContext(stat, Date.now());
    const held = {
      id: word,
      rankBefore: c.rank,
      knownBefore: c.knownCheck, // 確認待ちの知ってた語か（js/mastery.js isKnownWaiting。streak 1 だけでなく期日でも見る）
      clean: !!wasClean,
      ctx: c,
      streakDays: 0, // この答えで recordCorrect が streak から決めた日数（進まなければ 0）。S2・S3 が伸ばす起点（段階 2）
      stat // 答える前の記録（記録の質: 影の計算の移行の値・前の答えの控え。recordCorrect が写す前の表の値で、書き換えない）
    };
    pendingAnswer = held;
    queueMicrotask(() => {
      if (pendingAnswer === held) pendingAnswer = null;
    });
  } catch {
    pendingAnswer = null; // 段の控えは記録を止めない（recordRecallSuccess は今の stat から読む）
  }
}

// recordCorrect が streak から決めた日数を控えに足す（同じタスクの recordRecallSuccess が S2・S3 の起点に使う）
function noteStreakDays(word, days) {
  if (pendingAnswer?.id === word) pendingAnswer.streakDays = days;
}

const SPEEDS = new Set(["fast", "normal", "slow", "unknown"]);

// ctx（省略可）: 答える前の stat の answerContext（js/game.js が持っている値。holdPendingAnswer）
export function recordCorrect(word, wasClean, ctx = null) {
  const stats = editWordStats();

  if (!stats[word]) return;
  holdPendingAnswer(word, stats[word], wasClean, ctx);
  // 初見 = まだ一度も答えておらず、答えの綴りも見ていない（js/mastery.js isFirstAnswer。correctCount を足す前に読む）
  const firstAnswer = isFirstAnswer(stats[word]);
  stats[word] = { ...stats[word] };

  stats[word].correctCount += 1;

  // 初見でノーミス自力正解 = もともと知っていた語。学習ではないので「覚えた」に数えず、
  // 復習も薄く（2週間後に1回確認）。知っている語で時間を使わせない。
  // 出題の回数は見ない（出題だけされて答えなかった語も知ってたになれる）。別解を打って答えを見た語はなれない
  if (wasClean && firstAnswer) {
    stats[word].knownOnSight = true;
    stats[word].cleanCorrectStreak = 1;
    stats[word].srsAdvancedOn = localDateString();
    stats[word].nextReviewAt = daysFromNow(14);
    noteStreakDays(word, 14);
    saveWordStats(stats);
    markWordDirty(word);
    return;
  }

  if (wasClean) {
    // SRSの前進は1日1回まで。同日反復（New Word Learning Loop）は
    // 短期定着のためのもので、長期のSRS段階を進めない。
    // これによりmasteredは「複数日にまたがる10連続正解」の意味を保つ
    const today = localDateString();

    if (stats[word].srsAdvancedOn !== today) {
      // 欠損データでもNaN→toISOString例外にならないよう0起点で加算
      stats[word].cleanCorrectStreak = (stats[word].cleanCorrectStreak ?? 0) + 1;
      stats[word].srsAdvancedOn = today;

      if (stats[word].cleanCorrectStreak >= 10) {
        stats[word].mastered = true;
        stats[word].masteredAt = new Date().toISOString();
      }

      // 正解で期日を早めない（習熟度の S1。js/mastery.js keepLaterDue）: 期日が先の語を期日前に答えても、その期日より前にしない
      const nowMs = Date.now();
      const interval = reviewIntervalFor(stats[word].cleanCorrectStreak);
      stats[word].nextReviewAt = keepLaterDue(stats[word].nextReviewAt, daysFromNow(interval, nowMs), nowMs);
      noteStreakDays(word, interval);
    }
  } else {
    stats[word].cleanCorrectStreak = 0;
    stats[word].nextReviewAt = daysFromNow(1);
  }

  saveWordStats(stats);
  markWordDirty(word);
  touchStudyTime();
}

// 別解を打って答えの綴りを見た（js/game.js acceptAlternative。× は記録しない）。初見の語にだけ印 answerSeenAt を書く
// （端末だけの欄。打ち直せば correctCount が足されるが、打ち直す前に時間切れ・離れた語も、次の答えを「知ってた」にしない。js/mastery.js isFirstAnswer）。
// 答えの記録がある語・印のある語には書かない（語ごとに多くて 1 回）
export function recordAnswerSeen(word) {
  const stats = editWordStats();

  if (!stats[word] || !isFirstAnswer(stats[word])) return;
  stats[word] = { ...stats[word], answerSeenAt: new Date().toISOString() };
  saveWordStats(stats);
  markWordDirty(word);
}

// New Word Learning Loop: 同日の学習段階を保存（ローカル日付基準）
export function setDailyLearning(word, stage) {
  const stats = editWordStats();
  stats[word] = stats[word] ? { ...stats[word] } : createInitialWordStats();

  stats[word].dailyLearningDate = localDateString();
  stats[word].dailyLearningStage = stage;

  saveWordStats(stats);
  markWordDirty(word);
}

// 打ち間違い（覚えていたがタイプをミスした）。苦手判定には使わない
export function recordTypingMiss(word) {
  const stats = editWordStats();

  if (!stats[word]) return;
  stats[word] = { ...stats[word] };

  stats[word].typingMiss += 1;
  saveWordStats(stats);
  markWordDirty(word);
}

// 思い出せなかった（Enterで答えを見た）。これが本当の「苦手」
// lastRecallFailAt を更新 → 自力正解するまで Unresolved（未解決）状態になる
// 直近8回の思い出せた/思い出せなかった履歴（「昨日×→今日○」を語ごとに見せる）。extra: × の細目（k・p・a。記録の質。端末だけ）
function pushHistory(stat, r, extra = null) {
  const h = Array.isArray(stat.history) ? stat.history : [];
  stat.history = [...h.slice(-7), { d: localDateString(), r, ...(extra ?? {}) }];
}

// 別の日に覚えていた語への挑戦か（復習の成否＝定着率の材料）。「別の日」= 最後の自力正解とローカルの暦日が違い、かつ 6 時間以上
// （js/mastery.js answerContext の同じ日の扱いと同じ線。前日 23 時の正解を翌日 9 時に答えても復習。時計が戻って先に見える正解は復習にしない）
export function isReviewAttempt(stat, nowMs = Date.now()) {
  const okAt = Date.parse(stat?.lastRecallSuccessAt ?? "");
  if (!(okAt > 0)) return false;
  if (nowMs - okAt < MIN_GAP_MS) return false;
  return dayDiff(localDay(new Date(okAt)), localDay(new Date(nowMs))) >= 1;
}

// × の細目（js/game.js が渡す detail = { k, p, a, c }）→ history の 1 件に足す欄。k: e 答え表示・h ヒント・m 1 打ミス・p パス、
// 渡さない呼び方（Battle）・知らない値は u（不明）。p = 打てていた字数（綴りは受理した字、ローマ字は受理したキー。0 以上の整数のときだけ）、
// a = m のとき隣のキーを打ったか（真偽のときだけ）、c = ローマ字の答えの m のとき打ち終えていたかなの字数（0 以上の整数のときだけ。PR #180 のレビュー 3。
// 3 字目かどうかは js/mastery.js typedCharsOf が c → p の順で読む。綴りの答えは渡さないので今の形のまま）
const FAIL_KINDS = new Set(["e", "h", "m", "p"]);
function failFields(detail) {
  const k = FAIL_KINDS.has(detail?.k) ? detail.k : "u";
  const out = { k };
  if (k !== "u" && Number.isInteger(detail.p) && detail.p >= 0) out.p = detail.p;
  if (k === "m" && typeof detail.a === "boolean") out.a = detail.a;
  if (k === "m" && Number.isInteger(detail.c) && detail.c >= 0) out.c = detail.c;
  return out;
}

// detail（省略可）: × の細目（failFields）。Battle は引数なし（u）
export function recordRecallFail(word, detail = null) {
  const stats = editWordStats();

  if (!stats[word]) return;
  const nowMs = Date.now();
  const statBefore = stats[word]; // 答える前の記録（記録の質。書き換えない）
  const before = readRank(stats[word], nowMs); // 習熟度: 書く前の stat から（答える前の段と文脈）
  stats[word] = { ...stats[word] };
  const nowIso = new Date(nowMs).toISOString(); // 期日・思い出せなかった日時・段を決めた時刻は同じ文字列（rankOf が自分の × を「見ていない ×」と読まない）

  if (isReviewAttempt(stats[word], nowMs)) {
    stats[word].lastReviewResult = "ng";
    stats[word].lastReviewAt = nowIso;
  }

  const fail = failFields(detail);
  pushHistory(stats[word], "x", fail);
  stats[word].recallFail += 1;
  stats[word].missCount += 1;
  stats[word].cleanCorrectStreak = 0;
  stats[word].mastered = false;
  stats[word].nextReviewAt = nowIso;
  stats[word].lastRecallFailAt = nowIso;
  writeRank(stats[word], before, { ok: false, clean: false, speed: "unknown", slip: isSlipFail({ r: "x", ...fail }) }, before?.ctx, nowIso);
  noteMemory(word, stats[word], statBefore, before?.ctx, { ok: false, kind: fail.k }, nowMs); // 記録の質（影の計算・集計。期日・段は上で決めたまま）

  saveWordStats(stats);
  markWordDirty(word);
  noteAnswer(word, "x", stats[word]); // 記憶の保持率（js/retentionLog.js）。別キーに書く。word_stats は変えない
  noteRankOutcome(word, before, false);
  touchStudyTime();
}

// ===== 習熟度（js/mastery.js）の書き込み。どれも失敗しても記録（SRS・保持率）は止めない =====

function readRank(stat, nowMs) {
  try {
    const ctx = answerContext(stat, nowMs);
    return { rank: ctx.rank, ctx };
  } catch {
    return null;
  }
}

// 段と段を決めた時刻を、書き手の写し（同じ 1 回の保存）に書く。masteryAt は書いた lastRecall*At と同じ文字列。
// × で段を下げたら masteryDownAt にも同じ時刻（端末だけの欄。同じ日の ○ で戻さない: js/mastery.js answerContext の downToday）
function writeRank(stat, before, answer, ctx, nowIso) {
  if (!before || !ctx) return;
  try {
    stat.masteryRank = nextRank(before.rank, answer, ctx);
    stat.masteryAt = nowIso;
    if (!answer.ok && stat.masteryRank < before.rank) stat.masteryDownAt = nowIso;
    writePeak(stat, before, answer, ctx, nowIso);
  } catch {
    // 段は次の答えで書き直す
  }
}

// 1 打ミスで下がる前の段の控え masteryPeak と、その控えを置いた × の時刻 masteryPeakAt（M1。Batch 70・PR #180 のレビュー 1。端末だけの欄・送らない。
// js/mastery.js masteryPeakOf が「masteryPeakAt と lastRecallFailAt が同じ時刻」で使えるかを見る）。段と同じ写しに書く:
//   指の滑りの ×（answer.slip）で段が下がった → 控え ＝ max(答える前に使えた控え, 答える前の段)（続けて 1 打ミスで下がっても、どの段も 1 打ミスで下がったので上の段まで戻す）
//   指の滑りの × で段が下がらない（同じ日の 2 回目・段 1）→ 使えた控えを残す
//   ほかの ×（答え表示・ヒント・パス・2 字目までの隣でない字・全文入力の違う答え・Battle）→ 消す（下がった段は今の決まりで戻す）
//   ○ → 控えが今の段より上なら残す（遅い・打ち間違いあり・同じ日の ○ は戻さないので次の日に）、戻りきったら消す。使えない控え（見ていない × の後など）も消す
// 控えを残す × では masteryPeakAt ＝ この × の時刻（nowIso ＝ 書いた lastRecallFailAt）、○ では最後の × の時刻（使えた控えなら同じ時刻。
// masteryPeakAt の無い PR #180 の版の控えにはここで書き足す）。控えを消すときは一緒に消す
function writePeak(stat, before, answer, ctx, nowIso) {
  const usable = Number.isInteger(ctx.peak) ? ctx.peak : 0;
  let peak = 0;
  if (answer.ok) peak = usable;
  else if (answer.slip) peak = stat.masteryRank < before.rank ? Math.max(usable, before.rank) : usable;
  if (peak > stat.masteryRank) {
    stat.masteryPeak = peak;
    stat.masteryPeakAt = answer.ok ? stat.lastRecallFailAt : nowIso;
  } else {
    delete stat.masteryPeak;
    delete stat.masteryPeakAt;
  }
}

// 日をあけた正解の後、復習の間隔を伸ばす（習熟度の S2・S3。段階 2。js/mastery.js intervalAfter）。書き手の写しに書く（同じ 1 回の保存）。
// 当てるのはその日の最初の答え（前の答えの日があり、同じ日の扱いでない gap ≥ 1）のノーミス正解だけ。初めての答え（知ってたの 14 日）・
// 同じ日の答え・打ち間違いありの正解（recordCorrect が期日を翌日にする）には当てない。期日は伸ばすだけ（keepLaterDue）。
// 答えの後が streak 1・recallFail 0 になる答え（打ち間違いありの正解で streak 0 に戻った後の、別の日のノーミス。知ってた語でも、そうでない語でも）
// にも当てない: 確認待ちの知ってた語は同期する欄だけで「streak 1・recallFail 0・期日が最後の自力正解から 13 日以上先」の形で見分ける
// （js/mastery.js isKnownWord・isKnownWaiting。2 台目には knownOnSight が届かない）ので、ここで 13 日以上に伸ばすと確認待ちと読み違える。
// rankCap: 答える前の stat にこの端末の段が見ていない × があれば 1 段下の段（js/mastery.js unseenFailCap）。下限はそれより上の段で見ない
function extendInterval(stat, ctx, clean, speed, streakDays, nowMs, rankCap = null) {
  if (!clean || !ctx?.firstOfDay) return;
  if ((stat.cleanCorrectStreak ?? 0) === 1 && (stat.recallFail ?? 0) === 0) return;
  try {
    const rank = rankCap ? Math.min(stat.masteryRank, rankCap) : stat.masteryRank;
    const days = intervalAfter({ streakDays, gap: ctx.gap, rank, speed });
    if (days > 0) stat.nextReviewAt = keepLaterDue(stat.nextReviewAt, daysFromNow(days, nowMs), nowMs);
  } catch {
    // 間隔は recordCorrect が決めたまま
  }
}

// 段の確かめの集計（その日の最初の答えだけ。js/masteryMeta.js）。10 答えごとに保存
function noteRankOutcome(word, before, ok) {
  try {
    if (before?.ctx?.firstOfDay) noteRankCheck({ id: word, rankBefore: before.rank, gap: before.ctx.gap, ok });
    tickMasteryMeta();
  } catch {
    // 集計は学習を止めない
  }
}

// 答えを見ずに自力で正解した（打ち間違いはあってもよい）。
// 答え表示後の入力練習ではこの関数を呼ばないこと。
// answer = { clean, speed, speedless? }（js/game.js が渡す。clean = ノーミス、speed = "fast" | "normal" | "slow" | "unknown"、
// speedless = この問いの形では速さを測れない答え〔speed が unknown のときだけ。段の M1 だけが読む: js/mastery.js nextRank。保存しない〕）。
// 省略（Battle）: clean は recordCorrect が控えた wasClean、speed は "unknown"（どちらも無ければ打ち間違いありとみなす＝控えめ）
// measure（省略可。記録の質）: js/game.js の測りの札 { t1, pcMax, qLen, aLen, input, multi, outside, stalled, firstSight, lag }。測れなかった語は null。
// 何を残すかはここで決める（noteSpeedRecord）。期日・段・streak・速さの分類は measure を見ない
export function recordRecallSuccess(word, answer, measure = null) {
  const stats = editWordStats();

  if (!stats[word]) return;
  const nowMs = Date.now();
  // 習熟度: 答える前の段と文脈は recordCorrect の先頭で控えたもの（同じ語のとき）。無ければ今の stat から
  const p = pendingAnswer?.id === word ? pendingAnswer : null;
  pendingAnswer = null;
  const before = p ? { rank: p.rankBefore, ctx: p.ctx } : readRank(stats[word], nowMs);
  const statBefore = p?.stat ?? stats[word]; // 答える前の記録（recordCorrect が先に streak・期日を書き換えるので控えから。記録の質）
  stats[word] = { ...stats[word] };
  const nowIso = new Date(nowMs).toISOString(); // 自力正解の日時と段を決めた時刻は同じ文字列

  const prevRecallSuccessAt = stats[word].lastRecallSuccessAt ?? null; // 記憶の保持率の t0 判定にだけ使う（上書きの前に読む。Recall Loop には使わない）
  // 見ていない × の段の上限（S3 の下限だけに使う）。段と段を決めた時刻を書く前に読む（recordCorrect はこの 3 つの欄を書かないので、答える前の値と同じ）
  const rankCap = unseenFailCap(stats[word]);

  if (isReviewAttempt(stats[word], nowMs)) {
    stats[word].lastReviewResult = "ok";
    stats[word].lastReviewAt = nowIso;
  }

  pushHistory(stats[word], "o");
  stats[word].lastRecallSuccessAt = nowIso;
  if (before?.ctx) {
    const clean = typeof answer?.clean === "boolean" ? answer.clean : p ? p.clean : false;
    const speed = SPEEDS.has(answer?.speed) ? answer.speed : "unknown";
    const speedless = speed === "unknown" && answer?.speedless === true; // 間隔（extendInterval）・記録の質（noteMemory）には渡さない
    // 知ってた語の最初の確認は、答える前に確認待ちだったときだけ（recordCorrect の控え。isKnownWaiting は streak 1 を含む。控えが無ければ立てない）
    const ctx = { ...before.ctx, knownCheck: !!(p && p.knownBefore) };
    writeRank(stats[word], before, { ok: true, clean, speed, ...(speedless ? { speedless: true } : {}) }, ctx, nowIso);
    extendInterval(stats[word], ctx, clean, speed, p?.streakDays ?? 0, nowMs, rankCap); // S2・S3（段を書いた後。下限は答えた後の段。見ていない × があれば 1 段下まで）
    noteMemory(word, stats[word], statBefore, before.ctx, { ok: true, clean, speed, measure }, nowMs); // 記録の質（期日・段を決めた後。それらは変えない）
  }

  saveWordStats(stats);
  markWordDirty(word);
  // 記憶の保持率: 初めての自力正解を t0 に（知ってた語・以前に自力正解のある語は除く。recordCorrect が先に走り knownOnSight は確定している）→ 窓の回答
  noteFirstRecall(word, stats[word], prevRecallSuccessAt);
  noteAnswer(word, "o", stats[word]);
  noteRankOutcome(word, before, true);
  touchStudyTime();
}

// ===== 3 つの状態（これから・あやふや・覚えた。Batch 78。js/learnState.js・docs/SPEC_LEARN_STATE.md）の書き手 =====
// 中心の学習（これから・あやふや・覚えたの 3 つのモード）だけが、1 問に 1 回、上の書き手の後に呼ぶ。Battle・Challenge・Daily・タイピング・
// 非公開の旧教材の直接 URL は呼ばない（状態を変えない: 決定 §4）。kind = js/learnState.js ANSWER_KINDS（× のあった問いはその × の種類）、
// epoch = 回の始めに控えた js/storage.js recordsEpoch()（ほかのタブで記録が置き換わったら書かない）。
// ほかの書き手の欄と出力は変えない: 同じタスクの同じ写しの、この語の ls・lsd・lsAt だけを替え、保存は同じ 1 回（setItem はタスクに 1 回のまま）。
// 状態は同じタスクで読んだ語の欄から決める（回の列が持っている値は使わない）。公開の語だけ（非公開の語の記録には書かない）。
// 返り値 Promise<boolean>: 保存できたら true。書かなかった（公開の語でない・種類が違う・材料〔公開の語の表〕がまだ読めていない・
// 回の後に記録が置き換わった）・保存に失敗したら false（画面は変化を出さない: 受け入れ基準 14）
export function recordLearnAnswer(word, kind, { epoch = null } = {}) {
  const source = learnStateSource();
  if (!source || !source.vocab.isPublic(word) || !isAnswerKind(kind)) return Promise.resolve(false);
  if (epoch !== null && epoch !== recordsEpoch()) return Promise.resolve(false);
  const stats = editWordStats();
  stats[word] = applyLearnAnswer(stats[word] ?? createInitialWordStats(), kind, Date.now(), source.isDone);
  saveWordStats(stats);
  return whenWordStatsSaved();
}

// ===== 記録の質（docs/SPEC_MASTERY.md「記録の質」。D1 L1）。どれも失敗しても記録（SRS・段・保持率）は止めない =====
// 語ごとの欄は語の記録（spelldash_word_stats）に書かず、端末だけの別のキー spelldash_memory_words に置く（js/memoryWords.js。
// 正解のたびに語の表を丸ごと JSON にする保存を重くしない: Batch 58）。word_stats に足すのは history の × の細目 k・p・a だけ（同じ 1 回の保存）:
//   t      この書き手がこの語の答えを書いた時刻（ms。= lastRecall*At）。見ていない答え（2 台目・古い版・書く前に落ちたタブ）を見分ける
//          （hasUnseenAnswer。影の S を作り直し、速さの控え spP を数えずに捨てる）
//   sp     語ごとの速さ（直近 3 件 [日番号, T1(ms), q(%)|null, 分類 "f"|"n"|"s"|"u", 印]）。材料 (a) の答えだけ（noteSpeedRecord）
//   spP    速さの材料 (a)・(b) の答えの控え [日番号, 符号]（次のその日の最初の答えで speedNext に数えて消す。間に見ていない答えがあれば
//          数えずに捨てる。js/memoryCheck.js encodePend）
//   memSv  影の 7 通りの S（js/memoryModel.js VARIANTS の順）、memD・memD0 共通の難しさとその初めの値（どれも 0.1 刻みの整数: 値 × 10）
// 集計は js/memoryCheck.js（spelldash_memory_check）。出題・期日・段・streak・習得・保持率の記録はここで変えない（scripts/sim-writers.mjs で確かめる）
// sp の日番号（1970-01-01 からのローカル暦日の数）は js/retentionCalc.js dayNoOf（画面の js/recallSpeed.js と同じ関数）
const SP_KEEP = 3; // sp は直近 3 件
const SP_GAP_DAYS = 3; // 材料 (a): 前の答え（○でも × でも）から 3 暦日以上あいた、その日の最初の答え（または初めての答え）
const SP_B_RATIO = 0.5; // 材料 (b): 影の S（G0 1.5）で t ≥ 0.5 × S の、その日の最初の答え

// 答える前の記録から、影の S・D の初めの値（js/memoryModel.js migrateState。D1 §2.6）
function migratedShadow(st) {
  const m = migrateState({
    everRecalled: !!st.lastRecallSuccessAt,
    unresolved: isUnresolved(st),
    knownWaiting: isKnownWaiting(st),
    mastered: !!st.mastered,
    dueMs: Date.parse(st.nextReviewAt ?? "") || 0,
    okMs: Date.parse(st.lastRecallSuccessAt ?? "") || 0,
    recallFail: st.recallFail ?? 0,
    known: isKnownWord(st)
  });
  return shadowOf(m.S, m.D, m.D0);
}

// この端末の書き手が見ていない答えがあるか（2 台目・古い版で答えた・書く前にタブが落ちた）: 語ごとの欄を書いた時刻（at = 記録の質の t）
// より新しい lastRecall*At がある。t の無い語（at 0）は偽
function hasUnseenAnswer(st, at) {
  return at > 0 && Math.max(Date.parse(st.lastRecallSuccessAt ?? "") || 0, Date.parse(st.lastRecallFailAt ?? "") || 0) > at;
}

// 見ていない答えがある語（hasUnseenAnswer）の影の欄: S を同期する欄から作り直す。D は残し、見ていない × があれば +1（D1 §2.6。段の unseenFail と同じ作法）
function refreshShadow(sh, st, at) {
  const failAt = Date.parse(st.lastRecallFailAt ?? "") || 0;
  const m = migratedShadow(st);
  return { Sv: m.Sv, D: failAt > at ? Math.min(10, sh.D + 1) : sh.D, D0: sh.D0 };
}

// 前の答えの日（prevDay）の最初の × の種類（xNext の種類。js/memoryCheck.js X_KINDS）。k の無い古い × は数えない
function prevDayFailKind(history, prevDay) {
  if (!Array.isArray(history) || !prevDay) return null;
  const e = history.find((x) => x?.d === prevDay && x.r === "x" && typeof x.k === "string");
  if (!e) return null;
  if (e.k !== "m") return ["e", "h", "p", "u"].includes(e.k) ? e.k : null;
  const n = typedCharsOf(e); // ローマ字の答えは打ち終えたかなの字数 c（無ければ p。js/mastery.js。isSlipFail と同じ数え方）
  if (n !== null && n <= 1) return "m2"; // 1 打ミス 2 字目まで
  return e.a === true ? "m3a" : "m3"; // 3 字目以降（字数が分からない m も）: 隣のキーか、ほか
}

// 上限が効いている語（表で次に進めば上限 30 日を超える語）: 習得・streak が表の最後に届いた・期日が最後の自力正解から 30 日
function atCap(st) {
  if (st.mastered || (st.cleanCorrectStreak ?? 0) >= SRS_STEPS.length) return true;
  const due = Date.parse(st.nextReviewAt ?? "");
  const ok = Date.parse(st.lastRecallSuccessAt ?? "");
  return due > 0 && ok > 0 && due - ok >= (MAX_INTERVAL_DAYS - 0.5) * 86400000;
}

// 1 回の答えの記録の質。stat = 書き手の写し（答えた後。読むだけ: 段 masteryRank）、prev = 答える前の記録、ctx = 答える前の answerContext、
// ans = { ok, clean, speed, measure }（○）| { ok: false, kind }（×。kind は history の k）。語ごとの欄は spelldash_memory_words に置く（js/memoryWords.js）
function noteMemory(word, stat, prev, ctx, ans, nowMs) {
  try {
    if (!ctx || !prev) return;
    const before = getMemoryWord(word) ?? {}; // 答える前の語ごとの記録の質（書き換えない）
    const outcome = ans.ok ? "o" : ans.kind === "m" ? "xt" : "xm";
    const xCount = prev.recallFail ?? 0;
    const today = dayNoOf(ctx.today);
    const seenAt = Number(before.t) || 0;
    const unseen = hasUnseenAnswer(prev, seenAt); // この端末の書き手が見ていない答えがある（影の S を作り直し、速さの控えを捨てる）
    let sh = readShadow(before);
    let fresh = false;
    if (sh) {
      if (unseen) sh = refreshShadow(sh, prev, seenAt);
    } else if (ctx.prevDay === null && !ctx.unknownDays) {
      // 答えの記録が無い語: 初めての答えで作る（知ってた 14 日・打ち間違いありの正解 1 日・× と答えの綴りを見た語は 0 日＝まだ覚えていない）
      sh = shadowInit(ans.ok && ctx.firstAnswer ? (ans.clean ? "clean" : "typo") : "x");
      fresh = true;
    } else sh = migratedShadow(prev); // 影の欄の無い語（この版より前の記録・2 台目・上限で捨てた語）: 今の記録から作る
    const baseS = sh.Sv[BASE_VARIANT];
    let bMat = false;
    // 速さの控え。見ていない答えをはさんだ控えは数えずに捨てる（控えの次の答えはこの端末が見ていない答えなので、数えると結果を別の答えに、
    // 間隔を別の間隔に付ける。集計だけ書けて語ごとの欄が落ちた控えを 2 度数えることもある）。欠けた記録として扱う
    let spP = Array.isArray(before.spP) && !unseen ? before.spP : undefined;
    if (fresh) {
      if (ans.ok && !ctx.firstAnswer) sh = shadowSameDay(sh, { ok: true, xCount }); // 答えの綴りを見た後の自力正解: S 1
    } else if (ctx.firstOfDay) {
      const t = ctx.gap;
      if (baseS > 0) noteCalibration(word, shadowPredict(sh, t), outcome, nowMs); // 答える前の見込みと結果（覚えた語だけ）
      const pend = spP ? decodePend(spP[1]) : null;
      if (pend && today !== null && Number.isInteger(spP[0])) noteSpeedNext(pend, today - spP[0], outcome, nowMs);
      const xk = prevDayFailKind(prev.history, ctx.prevDay);
      if (xk) noteXNext(xk, t, outcome, nowMs);
      if (atCap(prev)) noteCapHit(t, outcome, nowMs);
      bMat = baseS > 0 && t >= SP_B_RATIO * baseS;
      sh = ans.ok ? shadowSuccess(sh, { t, speed: ans.speed, clean: ans.clean, xCount }) : shadowFail(sh);
      spP = undefined; // 控えはその日の最初の答えで数え終えた
    } else if (ans.ok) sh = shadowSameDay(sh, { ok: true, xCount }); // 同じ日: まだ覚えていない語の最初の自力正解だけ S 1
    const rec = { t: nowMs, memSv: null, memD: 0, memD0: 0, sp: Array.isArray(before.sp) ? before.sp.filter(Array.isArray) : null, spP: spP ?? null };
    writeShadow(rec, sh);
    if (ans.ok) noteSpeedRecord(rec, stat, ctx, ans, { bMat, today }, nowMs);
    putMemoryWord(word, compactRecord(rec));
    tickMemoryCheck();
    tickMemoryWords();
  } catch {
    // 記録の質は学習を止めない（期日・段・保持率はもう書いた）
  }
}

// 語ごとの記録の質の 1 件（無い欄は書かない。鍵の順は t・memSv・memD・memD0・sp・spP）
function compactRecord(rec) {
  const out = { t: rec.t, memSv: rec.memSv, memD: rec.memD, memD0: rec.memD0 };
  if (rec.sp?.length) out.sp = rec.sp;
  if (rec.spP) out.spP = rec.spP;
  return out;
}

// 速さの記録（ノーミス正解で、測りの札がある答え）。rec = この語の記録の質（spelldash_memory_words の 1 件）、stat = 書き手の写し（答えた後の段を読む）。
// sp に入れるのは材料 (a) だけ（(b) の印も付ける）、spP は (a)・(b) のどちらでも。
// 入れない: 一度に 2 字以上入った答え・置き換えの入力（multi）・1 打目の前に盤面の外へ焦点が移った答え（outside）・回の最初の語（lag。T1 が長く見えうる。
// PR #189 のレビュー）・T1 が 200ms 未満・30 秒超。
// q = T1 ÷ 本人の基準 ×100（基準は同じ経路の、同じ問いの字数帯の中央値。帯が 20 件未満なら経路全体。js/memoryCheck.js speedBasis）。
// 見本（字数帯・経路・初めての答え）は初めての答えかその日の最初の答えだけ（速さの箱と同じ）。止まった答え（stalled）は「T1 ＋ 最も長い止まり」を入れない
function noteSpeedRecord(rec, stat, ctx, ans, { bMat, today }, nowMs) {
  const m = ans.measure;
  if (!m || typeof m !== "object") return;
  noteInputCount(m.input, !!m.multi, nowMs);
  if (!ans.clean) return;
  const t1 = Number(m.t1);
  if (!Number.isFinite(t1) || t1 < CHECK_T1_MIN || t1 > CHECK_T1_MAX || m.multi || m.outside || m.lag) return;
  const aMat = !!ctx.firstAnswer || (!!ctx.firstOfDay && ctx.gap >= SP_GAP_DAYS);
  const sampled = !!ctx.firstAnswer || !!ctx.firstOfDay;
  if (!aMat && !bMat && !sampled) return;
  const pcMax = Number(m.pcMax);
  const tp = !m.stalled && m.pcMax !== null && Number.isFinite(pcMax) && pcMax >= 0 ? t1 + pcMax : null;
  if ((aMat || bMat) && today !== null) {
    const basis = speedBasis({ qLen: m.qLen, input: m.input }); // 入れる前の見本と比べる
    if (aMat) {
      const base = basis.band ?? basis.all;
      const q = base > 0 ? Math.round((t1 / base) * 100) : null;
      const mark = encodeMark({ a: true, b: bMat, qb: qBandOf(m.qLen), ab: aBandOf(m.aLen), first: !!ctx.firstAnswer, input: m.input });
      rec.sp = [...(rec.sp ?? []).slice(-(SP_KEEP - 1)), [today, Math.round(t1), q, CLS_CHAR[ans.speed] ?? "u", mark]];
    }
    rec.spP = [today, encodePend({ a: aMat, b: bMat, m: CLS_CODE[ans.speed] ?? 0, p: classP20(t1, basis.p20), t: classTp(tp, basis.tp), rank: stat.masteryRank ?? 0 })];
  }
  if (sampled) noteSamples({ t1, tp, qLen: m.qLen, aLen: m.aLen, input: m.input, first: !!ctx.firstAnswer }, nowMs);
}

function createInitialWordStats() {
  return {
    playCount: 0,
    correctCount: 0,
    missCount: 0,
    typingMiss: 0,
    recallFail: 0,
    cleanCorrectStreak: 0,
    mastered: false,
    masteredAt: null,
    lastPlayed: null,
    nextReviewAt: null,
    lastRecallFailAt: null,
    lastRecallSuccessAt: null,
    dailyLearningDate: null,
    dailyLearningStage: 0,
    srsAdvancedOn: null
  };
}
