import { getWordStats, saveWordStats } from "./storage.js";
import { markWordDirty } from "./sync.js";

// 簡易SRS: 連続ノーミス正解数 → 次の復習までの日数
// 1回→1日後、3連続→3日後、10連続→30日後（それ以上は30日固定）
const REVIEW_INTERVAL_DAYS = [1, 2, 3, 5, 7, 10, 14, 21, 30];

function daysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function reviewIntervalFor(streak) {
  const index = Math.min(Math.max(streak, 1), REVIEW_INTERVAL_DAYS.length) - 1;
  return REVIEW_INTERVAL_DAYS[index];
}

export function recordPlay(word) {
  const stats = getWordStats();

  if (!stats[word]) {
    stats[word] = createInitialWordStats();
  }

  stats[word].playCount += 1;
  stats[word].lastPlayed = new Date().toISOString();
  saveWordStats(stats);
  markWordDirty(word);
}

export function recordCorrect(word, wasClean) {
  const stats = getWordStats();

  if (!stats[word]) return;

  stats[word].correctCount += 1;

  if (wasClean) {
    stats[word].cleanCorrectStreak += 1;

    if (stats[word].cleanCorrectStreak >= 10) {
      stats[word].mastered = true;
      stats[word].masteredAt = new Date().toISOString();
    }

    stats[word].nextReviewAt = daysFromNow(
      reviewIntervalFor(stats[word].cleanCorrectStreak)
    );
  } else {
    stats[word].cleanCorrectStreak = 0;
    stats[word].nextReviewAt = daysFromNow(1);
  }

  saveWordStats(stats);
  markWordDirty(word);
}

// 打ち間違い（覚えていたがタイプをミスした）。苦手判定には使わない
export function recordTypingMiss(word) {
  const stats = getWordStats();

  if (!stats[word]) return;

  stats[word].typingMiss += 1;
  saveWordStats(stats);
  markWordDirty(word);
}

// 思い出せなかった（Enterで答えを見た）。これが本当の「苦手」
export function recordRecallFail(word) {
  const stats = getWordStats();

  if (!stats[word]) return;

  stats[word].recallFail += 1;
  stats[word].missCount += 1;
  stats[word].cleanCorrectStreak = 0;
  stats[word].mastered = false;
  stats[word].nextReviewAt = new Date().toISOString();

  saveWordStats(stats);
  markWordDirty(word);
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
    nextReviewAt: null
  };
}
