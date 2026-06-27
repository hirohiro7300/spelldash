import { getWordStats, saveWordStats } from "./storage.js";

export function recordPlay(word) {
  const stats = getWordStats();

  if (!stats[word]) {
    stats[word] = createInitialWordStats();
  }

  stats[word].playCount += 1;
  saveWordStats(stats);
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
  } else {
    stats[word].cleanCorrectStreak = 0;
  }

  saveWordStats(stats);
}

export function recordMiss(word) {
  const stats = getWordStats();

  if (!stats[word]) return;

  stats[word].missCount += 1;
  stats[word].cleanCorrectStreak = 0;
  stats[word].mastered = false;

  saveWordStats(stats);
}

function createInitialWordStats() {
  return {
    playCount: 0,
    correctCount: 0,
    missCount: 0,
    cleanCorrectStreak: 0,
    mastered: false,
    masteredAt: null
  };
}