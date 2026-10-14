// 語の記録の保存の鍵。index.html の <head> の 1 行（初回の判定）は CSP と速さのため写しを持つ（下の hasWordRecords と同じ読み方。E2E 8.8 が突き合わせる）
export const STORAGE_KEY = "spelldash_word_stats";
// 読めなかった語の記録（壊れた JSON・表でない値）の写し。上書きする前に 1 つだけ残す（端末だけ: 同期しない・読み手は無い。PR #170 のレビュー 1）。
// 形は包み {"at": 退避した日時, "size": 元の字数, "head": 元の値（の頭）, "cut": 切ったら true}（at を先頭に置く: 読み込みのときに頭だけ見る）。
//   - 30 日（CORRUPT_KEEP_MS）たったら読み込みのときに消す（読む所が無いので、端末の保存の上限〔Chromium は鍵と値の合計 5,242,880 字〕を食い続けない）
//   - 包みは CORRUPT_MAX 字まで。超える値は頭と元の字数だけ残す（2M 字の表が壊れても写しは 512K 字）
//   - word_stats を書くときに上限の誤りが出たら、まず退避を消して 1 回だけ書き直す（flushWordStats。答えの記録が写しより先）
// バックアップには上限つきのまま入れる（端末を替える・送って見てもらうときに持ち出せる唯一の口。増えても 512K 字。復元すると at もそのままなので同じ日に消える）。
// 別のアカウントでログインしたときは前の持ち主の記録として消す（js/backup.js）
const CORRUPT_KEY = "spelldash_word_stats_corrupt";
const CORRUPT_KEEP_MS = 30 * 86400000;
const CORRUPT_MAX = 512 * 1024;
const BEST_SCORE_KEY = "spelldash_best_score";
const TYPING_KEY = "spelldash_typing_stats";
const SCHEMA_VERSION_KEY = "spelldash_schema_version";

// 既存ユーザーのデータを壊さずに新フィールドを追加するmigration。
// スキーマを変えるときは CURRENT_SCHEMA_VERSION を上げて処理を足す。
const CURRENT_SCHEMA_VERSION = 6;

function migrateStorage() {
  let version = Number(localStorage.getItem(SCHEMA_VERSION_KEY)) || 1;
  if (version >= CURRENT_SCHEMA_VERSION) return;

  const raw = localStorage.getItem(STORAGE_KEY);
  const read = readStats(raw);
  if (read.broken) {
    // 壊れた値は移行しない（読めないので足すフィールドも無い）。退避は readStats が済ませた。保存は書き手が最初に書くまで触らない
    localStorage.setItem(SCHEMA_VERSION_KEY, String(CURRENT_SCHEMA_VERSION));
    return;
  }
  let stats = read.stats;

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

// 語の記録があるか（初回の判定。js/welcome.js shouldShowWelcome）。index.html の <head> の 1 行（id="firstVisit"。CSP と速さのため写しを持つ）と
// 同じ読み方: 保存の文字列を JSON として読み、鍵が 1 つ以上なら true。無い・""・"{}"・"null"・"[]" は false。読めない値（壊れた JSON）は true
// （初回と見ない。1 行は catch で何もしない）。getWordStats は使わない（壊れた値を退避して空の表として返す。Batch 67 C3）。
// 1 行と答えが同じことは E2E 8.8 の 144 通りの突き合わせで守る（読み方を変えるときは 1 行も変える）
export function hasWordRecords() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return Object.keys((raw && JSON.parse(raw)) || {}).length > 0;
  } catch {
    return true;
  }
}

// 保存の文字列を表にする。空・null は空の表。壊れた JSON と表でない値（配列・数・文字列）は、退避の鍵に写してから空の表として読む
// （止めない: 書斎・出題・学習データ・単語帳が使える。黙って捨てない: 最初の書き込みで上書きされる前に写しが残る）
function readStats(raw) {
  let value;
  try {
    value = raw ? JSON.parse(raw) : null;
  } catch {
    value = undefined;
  }
  if (value === null || (value !== undefined && !value)) return { stats: {}, broken: false }; // null・false・0・"" は今までどおり空
  if (value !== undefined && typeof value === "object" && !Array.isArray(value)) return { stats: value, broken: false };
  keepCorrupt(raw);
  return { stats: {}, broken: true };
}

function keepCorrupt(raw) {
  let text;
  try {
    if (sameCorrupt(localStorage.getItem(CORRUPT_KEY), raw)) return; // 同じ壊れた値を読み直した: 退避した日時を変えない
    text = corruptEnvelope(raw, new Date().toISOString());
    localStorage.setItem(CORRUPT_KEY, text);
  } catch (error) {
    // 容量で写せない: 元の鍵を退避の鍵へ移す（消してから書く。包みは 512K 字までなので大きい表ほど空きが増える）。それも書けなければ元に戻して知らせる
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.setItem(CORRUPT_KEY, text ?? corruptEnvelope(raw, new Date().toISOString()));
    } catch {
      try { localStorage.setItem(STORAGE_KEY, raw); } catch {}
    }
    (globalThis.reportError ?? console.error)(error);
  }
}

// 退避の包みの文字列（CORRUPT_MAX 字まで）。収まらなければ元の値の頭だけにして cut を付ける（JSON の escape で伸びる分も含めて量る）
function corruptEnvelope(raw, at) {
  if (raw.length < CORRUPT_MAX) {
    const whole = JSON.stringify({ at, size: raw.length, head: raw });
    if (whole.length <= CORRUPT_MAX) return whole;
  }
  let n = Math.min(raw.length, CORRUPT_MAX);
  for (let i = 0; i < 8 && n > 0; i++) {
    const text = JSON.stringify({ at, size: raw.length, head: raw.slice(0, n), cut: true });
    if (text.length <= CORRUPT_MAX) return text;
    n = Math.floor((n * CORRUPT_MAX) / text.length) - 64; // escape の割合で縮める（2〜3 回で収まる）
  }
  return JSON.stringify({ at, size: raw.length, head: "", cut: true });
}

// 退避の文字列から包みを読む。包みでない（Batch 67 の形＝元の値そのまま・読めない）なら null
function readCorrupt(text) {
  if (typeof text !== "string" || !text.startsWith('{"at":"')) return null;
  try {
    const value = JSON.parse(text);
    return typeof value?.at === "string" && typeof value.head === "string" && Number.isFinite(value.size) ? value : null;
  } catch {
    return null;
  }
}

function sameCorrupt(text, raw) {
  const kept = readCorrupt(text);
  return Boolean(kept) && kept.size === raw.length && (kept.cut ? raw.startsWith(kept.head) : kept.head === raw);
}

// 読み込みのとき: 30 日たった退避を消す。Batch 67 の形（日時が無い・大きさの上限が無い）は今の日時で包み直す（上限で切る）。
// 日時は文字列の頭だけで読む（包みは 512K 字まであり、毎回の読み込みで parse しない）
function expireCorrupt() {
  try {
    const text = localStorage.getItem(CORRUPT_KEY);
    if (text === null) return;
    const at = /^\{"at":"([^"]{1,40})"/.exec(text);
    if (!at) {
      localStorage.setItem(CORRUPT_KEY, corruptEnvelope(text, new Date().toISOString()));
      return;
    }
    const age = Date.now() - Date.parse(at[1]);
    if (!(age < CORRUPT_KEEP_MS && age > -CORRUPT_KEEP_MS)) localStorage.removeItem(CORRUPT_KEY); // 読めない日時・先の日時も消す
  } catch {
    // 包み直せない（容量）: 写しは捨てる（読む所は無い。語の記録の書き込みを優先する）
    try { localStorage.removeItem(CORRUPT_KEY); } catch {}
  }
}

function isQuotaError(error) {
  return error?.name === "QuotaExceededError" || error?.name === "NS_ERROR_DOM_QUOTA_REACHED" || error?.code === 22 || error?.code === 1014;
}

// 上限で書けなかったとき: 退避があれば消す（消したら true）
function dropCorrupt() {
  try {
    if (localStorage.getItem(CORRUPT_KEY) === null) return false;
    localStorage.removeItem(CORRUPT_KEY);
    return true;
  } catch {
    return false;
  }
}

expireCorrupt();
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
    memoStats = readStats(raw).stats;
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
  let raw = null;
  try {
    raw = JSON.stringify(memoStats);
    localStorage.setItem(STORAGE_KEY, raw);
    memoRaw = raw;
  } catch (error) {
    // 上限: 壊れた記録の写し（読む所は無い）を消して 1 回だけ書き直す。答えの記録を写しより先にする（PR #170 のレビュー 1）
    if (raw !== null && isQuotaError(error) && dropCorrupt()) {
      try {
        localStorage.setItem(STORAGE_KEY, raw);
        memoRaw = raw;
        return;
      } catch {}
    }
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

// カテゴリ別ベストの表 { [categoryId]: score }（壊れている・表でないなら空。本棚の移行 js/bookshelf.js が読む）
export function getCategoryBests() {
  try {
    const all = JSON.parse(localStorage.getItem(CATEGORY_BEST_KEY) || "{}");
    return all && typeof all === "object" && !Array.isArray(all) ? all : {};
  } catch {
    return {};
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