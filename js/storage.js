const STORAGE_KEY = "spelldash_word_stats";
const BEST_SCORE_KEY = "spelldash_best_score";
const TYPING_KEY = "spelldash_typing_stats";
const SCHEMA_VERSION_KEY = "spelldash_schema_version";

// 既存ユーザーのデータを壊さずに新フィールドを追加するmigration。
// スキーマを変えるときは CURRENT_SCHEMA_VERSION を上げて処理を足す。
const CURRENT_SCHEMA_VERSION = 6;

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

  // v4 → v5: Recall Loop用の日時を追加
  // lastRecallFailAt = 最後に思い出せなかった日時 / lastRecallSuccessAt = 最後に自力で思い出せた日時
  if (version < 5) {
    for (const key of Object.keys(stats)) {
      stats[key] = { lastRecallFailAt: null, lastRecallSuccessAt: null, ...stats[key] };
    }
    version = 5;
  }

  // v5 → v6: New Word Learning Loop（同日反復）とSRSの1日1回ゲート用フィールド
  if (version < 6) {
    for (const key of Object.keys(stats)) {
      stats[key] = {
        dailyLearningDate: null,
        dailyLearningStage: 0,
        srsAdvancedOn: null,
        ...stats[key]
      };
    }
    version = 6;
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
  localStorage.setItem(SCHEMA_VERSION_KEY, String(version));
}

migrateStorage();

// ===== 語の記録（spelldash_word_stats）: 読みは 1 タスク 1 回、書きは 1 タスク 1 回 =====
// 同じタスクの中では前に読んだ中身を返す。タスクが変わったら保存の文字列と比べ、同じなら parse しない
// （他のタブ・バックアップの復元・E2E の直の書き込みは文字列が変わるので拾う）。
// 中身は共有する。書き換えてよいのは js/stats.js の書き手だけで、editWordStats の写しに書く（タスクの初めに読んだ人の手元の値は変わらない）。
// 表の写しは 1 タスク 1 回（15,000 語の表の丸写しは 1 回 約 10ms。正解 1 回で書き手が 2〜3 回呼ぶ）。同じタスクの書き手どうしは同じ写しを使う。
// 書き込みは同じタスクの終わり（マイクロタスク）に必ず済む。次のタスク（閉じる・移る・裏に回る・タイマー）より前なので取りこぼさない
let memoRaw = null; // 最後に parse した／書いた保存の文字列
let memoStats = null; // その中身
let trusted = false; // いまのタスクの中では保存を読み直さない
let pending = false; // いまのタスクの中でまだ setItem していない書き込みがある
let draft = null; // このタスクで書き手が写した表（同じタスクの書き手が使い回す。タスクの終わりに捨てる）
// E2E だけ: 共有の中身を凍らせ、読み手の書き換えを例外（strict mode の TypeError → pageerror）で見つける
const FREEZE = typeof navigator !== "undefined" && navigator.webdriver === true;

function deepFreeze(obj) {
  if (!obj || typeof obj !== "object" || Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  for (const value of Object.values(obj)) deepFreeze(value);
  return obj;
}

function untrust() {
  trusted = false;
}

// E2E だけ: 書いている途中の表（凍らせていない写し）を読み手に渡すときは、書き換えると例外になる口を渡す
let readGuard = null; // { table, view }
const READ_ONLY = {
  set() { throw new TypeError("spelldash_word_stats: 読み手は書き換えない（js/stats.js の書き手を使う）"); },
  defineProperty() { throw new TypeError("spelldash_word_stats: 読み手は書き換えない"); },
  deleteProperty() { throw new TypeError("spelldash_word_stats: 読み手は書き換えない"); }
};
function forReaders(table) {
  if (!FREEZE || !table || Object.isFrozen(table)) return table;
  if (readGuard?.table !== table) readGuard = { table, view: new Proxy(table, READ_ONLY) };
  return readGuard.view;
}

export function getWordStats() {
  if (memoStats && (pending || trusted)) return forReaders(memoStats);
  const raw = localStorage.getItem(STORAGE_KEY);
  if (memoStats === null || raw !== memoRaw) {
    memoStats = (raw && JSON.parse(raw)) || {};
    memoRaw = raw;
    if (FREEZE) deepFreeze(memoStats);
  }
  trusted = true;
  queueMicrotask(untrust);
  return memoStats;
}

// 書き手（js/stats.js）が書いてよい表。同じタスクの中では同じ写しを返す（表を写すのは 1 タスク 1 回）。
// 語ごとの記録は共有のままなので、書く語は写してから書く（stats[id] = { ...stats[id] }）
export function editWordStats() {
  if (draft) return draft;
  draft = { ...(memoStats && (pending || trusted) ? memoStats : getWordStats()) };
  queueMicrotask(dropDraft);
  return draft;
}

function dropDraft() {
  if (!pending) draft = null; // 書かずに終えた（書いたなら flushWordStats が捨てる）
}

export function saveWordStats(stats) {
  memoStats = stats;
  draft = stats; // 同じタスクの次の書き手はこの表に書く
  // E2E: 語ごとの記録はすぐ凍らせる。表そのものは同じタスクの書き手が使い回すので、書き込みのときに凍らせる
  if (FREEZE) for (const value of Object.values(memoStats)) deepFreeze(value);
  if (pending) return;
  pending = true;
  queueMicrotask(flushWordStats); // このタスクの JS が終わった直後・描画の前・次のタスクより前に必ず走る
}

export function flushWordStats() {
  if (!pending) return;
  pending = false;
  draft = null;
  if (FREEZE) deepFreeze(memoStats);
  try {
    const raw = JSON.stringify(memoStats);
    localStorage.setItem(STORAGE_KEY, raw);
    memoRaw = raw;
  } catch (error) {
    memoRaw = null; // 書けなかった（容量）: 次の読みで保存の中身から作り直す
    memoStats = null;
    (globalThis.reportError ?? console.error)(error);
  }
}

// 保存を直に書き換えた所（バックアップの復元・端末の記録を消す）が呼ぶ。書きかけも捨てる
export function forgetWordStats() {
  pending = false;
  trusted = false;
  draft = null;
  memoRaw = null;
  memoStats = null;
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

// ===== カテゴリ別ベスト（Challenge） =====
const CATEGORY_BEST_KEY = "spelldash_best_by_category";

export function getCategoryBest(categoryId) {
  try {
    const all = JSON.parse(localStorage.getItem(CATEGORY_BEST_KEY) || "{}");
    return Number(all[categoryId]) || 0;
  } catch {
    return 0;
  }
}

// 更新したら true
export function saveCategoryBest(categoryId, score) {
  const best = getCategoryBest(categoryId);
  if (score <= best) return false;
  let all = {};
  try {
    all = JSON.parse(localStorage.getItem(CATEGORY_BEST_KEY) || "{}");
  } catch {
    all = {};
  }
  all[categoryId] = score;
  localStorage.setItem(CATEGORY_BEST_KEY, JSON.stringify(all));
  return true;
}

// ===== セッションログ（スコア推移グラフ用・ローカルのみ） =====
const SESSION_LOG_KEY = "spelldash_session_log";
const SESSION_LOG_MAX = 100;

export function getSessionLog() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_LOG_KEY)) || [];
  } catch {
    return [];
  }
}

export function appendSessionLog(entry) {
  const log = getSessionLog();
  log.push(entry);
  if (log.length > SESSION_LOG_MAX) {
    log.splice(0, log.length - SESSION_LOG_MAX);
  }
  localStorage.setItem(SESSION_LOG_KEY, JSON.stringify(log));
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