import { saveWordStats, editWordStats } from "./storage.js";
import { markWordDirty } from "./sync.js";
import { noteFirstRecall, noteAnswer } from "./retentionLog.js";
import { touchStudyTime } from "./studyTime.js";
import { rankOf, answerContext, nextRank, isFirstAnswer, isKnownWaiting } from "./mastery.js";
import { noteRankCheck, tickMasteryMeta } from "./masteryMeta.js";

// 簡易SRS: 連続ノーミス正解数 → 次の復習までの日数
// 1回→1日後、3連続→3日後、10連続→30日後（それ以上は30日固定）
const REVIEW_INTERVAL_DAYS = [1, 2, 3, 5, 7, 10, 14, 21, 30];

function daysFromNow(days) {
  const d = new Date();
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
}

// 答える前の stat の控え（習熟度。js/mastery.js）。○ は recordCorrect が先に streak・mastered を書き換えるので、
// recordCorrect の先頭（写す前）で控え、同じタスクの recordRecallSuccess（id が同じとき）が使う。メモリーだけ（word_stats には書かない）。
// マイクロタスクで捨てる（答え表示の後の打ち直しで recordCorrect だけが呼ばれたとき、次の答えへ持ち越さない。js/storage.js の draft と同じ作法）
let pendingAnswer = null; // { id, rankBefore, streakBefore, knownBefore, clean, ctx }

function holdPendingAnswer(word, stat, wasClean) {
  try {
    const held = {
      id: word,
      rankBefore: rankOf(stat),
      streakBefore: stat.cleanCorrectStreak ?? 0,
      knownBefore: isKnownWaiting(stat), // 確認待ちの知ってた語か（js/mastery.js。streak 1 だけでなく期日でも見る）
      clean: !!wasClean,
      ctx: answerContext(stat, Date.now())
    };
    pendingAnswer = held;
    queueMicrotask(() => {
      if (pendingAnswer === held) pendingAnswer = null;
    });
  } catch {
    pendingAnswer = null; // 段の控えは記録を止めない（recordRecallSuccess は今の stat から読む）
  }
}

const SPEEDS = new Set(["fast", "normal", "slow", "unknown"]);

export function recordCorrect(word, wasClean) {
  const stats = editWordStats();

  if (!stats[word]) return;
  holdPendingAnswer(word, stats[word], wasClean);
  stats[word] = { ...stats[word] };

  stats[word].correctCount += 1;

  // 初見でノーミス自力正解 = もともと知っていた語。学習ではないので「覚えた」に数えず、
  // 復習も薄く（2週間後に1回確認）。知っている語で時間を使わせない。
  // 初見 = まだ一度も答えていない（js/mastery.js isFirstAnswer）。出題の回数は見ない（出題だけされて答えなかった語も知ってたになれる）
  if (wasClean && isFirstAnswer(stats[word])) {
    stats[word].knownOnSight = true;
    stats[word].cleanCorrectStreak = 1;
    stats[word].srsAdvancedOn = localDateString();
    stats[word].nextReviewAt = daysFromNow(14);
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

      stats[word].nextReviewAt = daysFromNow(
        reviewIntervalFor(stats[word].cleanCorrectStreak)
      );
    }
  } else {
    stats[word].cleanCorrectStreak = 0;
    stats[word].nextReviewAt = daysFromNow(1);
  }

  saveWordStats(stats);
  markWordDirty(word);
  touchStudyTime();
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
// 直近8回の思い出せた/思い出せなかった履歴（「昨日×→今日○」を語ごとに見せる）
function pushHistory(stat, r) {
  const h = Array.isArray(stat.history) ? stat.history : [];
  stat.history = [...h.slice(-7), { d: localDateString(), r }];
}

// 1日以上前に覚えていた語への挑戦か（復習の成否＝定着率の材料）
export function isReviewAttempt(stat) {
  if (!stat?.lastRecallSuccessAt) return false;
  return Date.now() - Date.parse(stat.lastRecallSuccessAt) >= 20 * 60 * 60 * 1000;
}

export function recordRecallFail(word) {
  const stats = editWordStats();

  if (!stats[word]) return;
  const nowMs = Date.now();
  const before = readRank(stats[word], nowMs); // 習熟度: 書く前の stat から（答える前の段と文脈）
  stats[word] = { ...stats[word] };
  const nowIso = new Date(nowMs).toISOString(); // 期日・思い出せなかった日時・段を決めた時刻は同じ文字列（rankOf が自分の × を「見ていない ×」と読まない）

  if (isReviewAttempt(stats[word])) {
    stats[word].lastReviewResult = "ng";
    stats[word].lastReviewAt = nowIso;
  }

  pushHistory(stats[word], "x");
  stats[word].recallFail += 1;
  stats[word].missCount += 1;
  stats[word].cleanCorrectStreak = 0;
  stats[word].mastered = false;
  stats[word].nextReviewAt = nowIso;
  stats[word].lastRecallFailAt = nowIso;
  writeRank(stats[word], before, { ok: false, clean: false, speed: "unknown" }, before?.ctx, nowIso);

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

// 段と段を決めた時刻を、書き手の写し（同じ 1 回の保存）に書く。masteryAt は書いた lastRecall*At と同じ文字列
function writeRank(stat, before, answer, ctx, nowIso) {
  if (!before || !ctx) return;
  try {
    stat.masteryRank = nextRank(before.rank, answer, ctx);
    stat.masteryAt = nowIso;
  } catch {
    // 段は次の答えで書き直す
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
// answer = { clean, speed }（js/game.js が渡す。clean = ノーミス、speed = "fast" | "normal" | "slow" | "unknown"）。
// 省略（Battle）: clean は recordCorrect が控えた wasClean、speed は "unknown"（どちらも無ければ打ち間違いありとみなす＝控えめ）
export function recordRecallSuccess(word, answer) {
  const stats = editWordStats();

  if (!stats[word]) return;
  const nowMs = Date.now();
  // 習熟度: 答える前の段と文脈は recordCorrect の先頭で控えたもの（同じ語のとき）。無ければ今の stat から
  const p = pendingAnswer?.id === word ? pendingAnswer : null;
  pendingAnswer = null;
  const before = p ? { rank: p.rankBefore, ctx: p.ctx } : readRank(stats[word], nowMs);
  stats[word] = { ...stats[word] };
  const nowIso = new Date(nowMs).toISOString(); // 自力正解の日時と段を決めた時刻は同じ文字列

  const prevRecallSuccessAt = stats[word].lastRecallSuccessAt ?? null; // 記憶の保持率の t0 判定にだけ使う（上書きの前に読む。Recall Loop には使わない）

  if (isReviewAttempt(stats[word])) {
    stats[word].lastReviewResult = "ok";
    stats[word].lastReviewAt = nowIso;
  }

  pushHistory(stats[word], "o");
  stats[word].lastRecallSuccessAt = nowIso;
  if (before?.ctx) {
    const clean = typeof answer?.clean === "boolean" ? answer.clean : p ? p.clean : false;
    const speed = SPEEDS.has(answer?.speed) ? answer.speed : "unknown";
    // 知ってた語の最初の確認は、答える前に確認待ちだったときだけ（recordCorrect の控え。isKnownWaiting は streak 1 を含む。控えが無ければ立てない）
    const ctx = { ...before.ctx, knownCheck: !!(p && p.knownBefore) };
    writeRank(stats[word], before, { ok: true, clean, speed }, ctx, nowIso);
  }

  saveWordStats(stats);
  markWordDirty(word);
  // 記憶の保持率: 初めての自力正解を t0 に（知ってた語・以前に自力正解のある語は除く。recordCorrect が先に走り knownOnSight は確定している）→ 窓の回答
  noteFirstRecall(word, stats[word], prevRecallSuccessAt);
  noteAnswer(word, "o", stats[word]);
  noteRankOutcome(word, before, true);
  touchStudyTime();
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
