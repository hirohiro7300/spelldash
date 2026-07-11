const STORAGE_KEY = "spelldash_word_stats";
const BEST_SCORE_KEY = "spelldash_best_score";
const TYPING_KEY = "spelldash_typing_stats";
const SCHEMA_VERSION_KEY = "spelldash_schema_version";

// 既存ユーザーのデータを壊さずに新フィールドを追加するmigration。
// スキーマを変えるときは CURRENT_SCHEMA_VERSION を上げて処理を足す。
const CURRENT_SCHEMA_VERSION = 4;

function migrateStorage() {
  let version = Number(localStorage.getItem(SCHEMA_VERSION_KEY)) || 1;
  if (version >= CURRENT_SCHEMA_VERSION) return;

  let stats = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};

  // v1 → v2: lastPlayed / nextReviewAt を追加
  if (version < 2) {
    for (const key of Object.keys(stats)) {
      stats[key] = { lastPlayed: null, nextReviewAt: null, ...stats[key] };
    }
    version = 2;
  }

  // v2 → v3: ミスを「打ち間違い」と「思い出せなかった」に分離
  if (version < 3) {
    for (const key of Object.keys(stats)) {
      stats[key] = { typingMiss: 0, recallFail: 0, ...stats[key] };
    }
    version = 3;
  }

  // v3 → v4: 主キーを en から word.id（教科プレフィックス付き）へ変更
  // 例: "apple" → "english-apple"。ミッションの保存内容も同様に変換
  if (version < 4) {
    const rekeyed = {};
    for (const key of Object.keys(stats)) {
      const newKey = key.startsWith("english-") ? key : `english-${key}`;
      rekeyed[newKey] = stats[key];
    }
    stats = rekeyed;

    const missionRaw = localStorage.getItem("spelldash_mission");
    if (missionRaw) {
      try {
        const mission = JSON.parse(missionRaw);
        for (const listName of ["review", "new", "reviewDone", "newDone"]) {
          if (Array.isArray(mission[listName])) {
            mission[listName] = mission[listName].map((key) =>
              key.startsWith("english-") ? key : `english-${key}`
            );
          }
        }
        localStorage.setItem("spelldash_mission", JSON.stringify(mission));
      } catch {
        localStorage.removeItem("spelldash_mission");
      }
    }

    version = 4;
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
  localStorage.setItem(SCHEMA_VERSION_KEY, String(version));
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