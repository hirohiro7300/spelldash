const STORAGE_KEY = "spelldash_word_stats";
const BEST_SCORE_KEY = "spelldash_best_score";
const TYPING_KEY = "spelldash_typing_stats";
const SCHEMA_VERSION_KEY = "spelldash_schema_version";

// 既存ユーザーのデータを壊さずに新フィールドを追加するmigration。
// スキーマを変えるときは CURRENT_SCHEMA_VERSION を上げて処理を足す。
const CURRENT_SCHEMA_VERSION = 2;

function migrateStorage() {
  const version = Number(localStorage.getItem(SCHEMA_VERSION_KEY)) || 1;
  if (version >= CURRENT_SCHEMA_VERSION) return;

  // v1 → v2: 単語statsに lastPlayed / nextReviewAt を追加
  const stats = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  for (const en of Object.keys(stats)) {
    stats[en] = { lastPlayed: null, nextReviewAt: null, ...stats[en] };
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));

  localStorage.setItem(SCHEMA_VERSION_KEY, String(CURRENT_SCHEMA_VERSION));
}

migrateStorage();

export function getWordStats() {
  return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
}

export function saveWordStats(stats) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
}

export function getBestScore() {
  return Number(localStorage.getItem(BEST_SCORE_KEY)) || 0;
}

export function saveBestScore(newScore) {
  const best = getBestScore();

  if (newScore > best) {
    localStorage.setItem(BEST_SCORE_KEY, String(newScore));
  }
}

export function getTypingStats() {
  const defaults = {
    correctChars: 0,
    missChars: 0,
    seconds: 0,
    sessions: 0,
    bestSpeed: 0
  };

  return { ...defaults, ...(JSON.parse(localStorage.getItem(TYPING_KEY)) || {}) };
}

export function recordTypingSession({ correctChars, missChars, seconds, speed }) {
  if (correctChars + missChars <= 0) return;

  const stats = getTypingStats();

  stats.correctChars += correctChars;
  stats.missChars += missChars;
  stats.seconds += seconds;
  stats.sessions += 1;

  if (speed > stats.bestSpeed) {
    stats.bestSpeed = speed;
  }

  localStorage.setItem(TYPING_KEY, JSON.stringify(stats));
}