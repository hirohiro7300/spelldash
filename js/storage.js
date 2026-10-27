import { WORD_STATS_CORRUPT_KEY as CORRUPT_KEY, CORRUPT_KEYS, SHADOW_KEYS, keepCorrupt as keepCorruptCopy, expireCorrupt, dropKeys, isQuotaError } from "./storageGuard.js";
import { fillLearnStates, hasUnfilled } from "./learnState.js";

// 語の記録の保存の鍵。index.html の <head> の 1 行（初回の判定）は CSP と速さのため写しを持つ（下の hasWordRecords と同じ読み方。E2E 8.8 が突き合わせる）
export const STORAGE_KEY = "spelldash_word_stats";
// 読めなかった語の記録（壊れた JSON・表でない値）の写し spelldash_word_stats_corrupt。上書きする前に 1 つだけ残す（端末だけ: 同期しない・読み手は無い。PR #170 のレビュー 1）。
// 包み・上限・期限は js/storageGuard.js（記録の質の語ごとの欄の写しも同じ作法）:
//   - 形は包み {"at": 退避した日時, "size": 元の字数, "head": 元の値（の頭）, "cut": 切ったら true}（at を先頭に置く: 読み込みのときに頭だけ見る）
//   - 30 日たったら読み込みのときに消す（読む所が無いので、端末の保存の上限〔Chromium は鍵と値の合計 5,242,880 字〕を食い続けない）
//   - 包みは 512K 字まで。超える値は頭と元の字数だけ残す（2M 字の表が壊れても写しは 512K 字）
//   - word_stats を書くときに上限の誤りが出たら、退避 → 影のデータ（記録の質）の順に消して、そのつど 1 回書き直す（flushWordStats。答えの記録を最優先。PR #172 のレビュー 1）
// バックアップには上限つきのまま入れる（端末を替える・送って見てもらうときに持ち出せる唯一の口。増えても 512K 字。復元すると at もそのままなので同じ日に消える）。
// 別のアカウントでログインしたときは前の持ち主の記録として消す（js/backup.js）
const BEST_SCORE_KEY = "spelldash_best_score";
const TYPING_KEY = "spelldash_typing_stats";
const SCHEMA_VERSION_KEY = "spelldash_schema_version";

// 既存ユーザーのデータを壊さずに新フィールドを追加するmigration。
// スキーマを変えるときは CURRENT_SCHEMA_VERSION を上げて処理を足す。
// v6 → v7（3 状態の欄 ls。Batch 78）だけは、公開の語の表と旧の判定を後から読むので、読み込みのときにはその場で書かない（下の migrateLearnStates。版はそこで上げる）
const CURRENT_SCHEMA_VERSION = 7;
const LEGACY_SCHEMA_VERSION = 6; // migrateStorage がその場で上げる版

function schemaVersion() {
  return Number(localStorage.getItem(SCHEMA_VERSION_KEY)) || 1;
}

// 今の形の id（教科の前置き付き: english-・concept-。マイ単語帳の my-・my-q-）か。v3 → v4 の付け替えはこれを飛ばす
// （版の鍵の無いバックアップを戻すと、新しい記録でも版 1 として読まれる。付け替えると概念カード・マイ単語帳の記録が english-concept-… に移って
// 元の id から見えなくなっていた。Batch 78 の前からの不具合: dataloss d10）
function hasIdPrefix(key) {
  return key.startsWith("english-") || key.startsWith("concept-") || key.startsWith("my-");
}

function migrateStorage() {
  let version = schemaVersion();
  if (version >= LEGACY_SCHEMA_VERSION) return;

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
      const newKey = hasIdPrefix(key) ? key : `english-${key}`;
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
              hasIdPrefix(key) ? key : `english-${key}`
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
  keepCorruptCopy(STORAGE_KEY, CORRUPT_KEY, raw, { report: true });
}

expireCorrupt(CORRUPT_KEY);
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

// 保存の成否（受け入れ基準 14: 保存に失敗したら、成功したような表示をしない）。flushWordStats が書くたびに決める。
// 待つ人（whenWordStatsSaved）には、このタスクの書き込みの成否を返す。失敗したら spelldash:save-failed も投げる（画面が短い 1 行を出す）
let lastSaveOk = true;
let saveWaiters = [];

// このタスクの書き込みが済んだら成否（true = 保存できた）。書きかけが無ければ最後の書き込みの成否
export function whenWordStatsSaved() {
  if (!pending) return Promise.resolve(lastSaveOk);
  return new Promise((resolve) => saveWaiters.push(resolve));
}

function settleSave(ok) {
  lastSaveOk = ok;
  const waiters = saveWaiters;
  saveWaiters = [];
  for (const resolve of waiters) resolve(ok);
  if (!ok) notifySaveFailed();
}

function notifySaveFailed() {
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
    window.dispatchEvent(new CustomEvent("spelldash:save-failed"));
  }
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
    writeWordStats(raw);
    memoRaw = raw;
  } catch (error) {
    memoRaw = null; // 書けなかった（容量）: 次の読みで保存の中身から作り直す
    memoStats = null;
    (globalThis.reportError ?? console.error)(error);
    settleSave(false);
    return;
  }
  settleSave(true);
}

// 上限で書けなかったら、読む所の無い退避の写し（語の記録・語ごとの欄の写し）→ 影のデータ（記録の質の spelldash_memory_words・
// spelldash_memory_check。消しても次に答えたとき今の記録から作り直す）の順に消して、そのつど 1 回だけ書き直す。答えの記録を最優先する
// （PR #170・#172 のレビュー 1）。速さの箱 spelldash_mastery_meta は分類に使うので消さない
function writeWordStats(raw) {
  try {
    localStorage.setItem(STORAGE_KEY, raw);
  } catch (error) {
    if (!isQuotaError(error)) throw error;
    let last = error;
    for (const keys of [CORRUPT_KEYS, SHADOW_KEYS]) {
      if (!dropKeys(keys)) continue;
      try {
        localStorage.setItem(STORAGE_KEY, raw);
        return;
      } catch (again) {
        last = again;
        if (!isQuotaError(again)) break;
      }
    }
    throw last;
  }
}

// 語の記録の保存の字数（js/memoryWords.js が端末の枠を語の記録と分けるのに使う。js/stats.js が渡す）。読んだ・書いた文字列があればその長さ
export function wordStatsChars() {
  if (memoRaw !== null) return memoRaw.length;
  try {
    return (localStorage.getItem(STORAGE_KEY) ?? "").length;
  } catch {
    return 0;
  }
}

// 保存を直に書き換えた所（バックアップの復元・端末の記録を消す）が呼ぶ。書きかけも捨てる
export function forgetWordStats() {
  pending = false;
  trusted = false;
  draft = null;
  memoRaw = null;
  memoStats = null;
  const waiters = saveWaiters; // 捨てた書きかけを待っていた人には「保存していない」
  saveWaiters = [];
  for (const resolve of waiters) resolve(false);
}

// ===== スキーマ 7: 3 状態の欄（ls。js/learnState.js・docs/SPEC_LEARN_STATE.md。Batch 78） =====
// 移行の式には公開の語の表（js/publicVocab.js。data/public/english.json）と旧の「済み」の判定（js/categoryProgress.js classifyWord。教材と出題の列の
// モジュールを連れてくる）が要るので、どちらも後から読む（動的 import。版 7 の端末と、埋める語の無い端末は読まない）。
// 移行は一度だけ: 状態の欄の無い公開の語のうち、答えの記録がある語に ls だけを書く（ほかの欄・非公開の語・欄のある語には触らない。何度流しても同じ）。
// 版は書けてから 7 に上げる。書けなかった（容量）・表が読めなかった（オフライン）ときは版 6 のまま、ページは止めない（モジュールの頭から投げない）。
// その間、読み手と書き手は欄の無い語を移行の式で読む（learnStateSource の isDone。メモリーの中だけ）。次に開いたときにやり直す（dataloss d1・d2）
let learnDeps = null; // { vocab, isDone }。読めたら持ち続ける
let learnDepsLoading = null;
let learnMigrating = null; // このページの移行（Promise<{ ok, filled }>）。容量で書けなかったら、次に開くまで書き直さない（表を丸ごと何度も書かない）

// 移行と 3 状態の読み手の材料を読む。読めなければ null（投げない。次に呼んだときに読み直す）
export function loadLearnStateDeps() {
  if (learnDeps) return Promise.resolve(learnDeps);
  learnDepsLoading ??= Promise.all([import("./publicVocab.js"), import("./categoryProgress.js"), import("./bookPace.js")])
    .then(async ([pv, cp, bp]) => {
      const vocab = await pv.loadPublicVocab();
      learnDeps = { vocab, isDone: (stat) => bp.isDoneState(cp.classifyWord(stat)) };
      return learnDeps;
    })
    .catch(() => null)
    .finally(() => {
      learnDepsLoading = null;
    });
  return learnDepsLoading;
}

// 読めた材料（まだなら null）
export function learnStateDeps() {
  return learnDeps;
}

// スキーマ 7 の移行が済んでいるか
export function learnStatesMigrated() {
  return schemaVersion() >= CURRENT_SCHEMA_VERSION;
}

// 3 状態の読み手（中心の学習・学習状況）と書き手（js/stats.js recordLearnAnswer）の材料: { vocab, isDone }。
// isDone は版 7 の前だけ（欄の無い語を移行の式で読む: js/learnState.js learnStateOf・countLearnStates）。材料がまだ読めていなければ null（loadLearnStates を待つ）
export function learnStateSource() {
  if (!learnDeps) return null;
  return { vocab: learnDeps.vocab, isDone: learnStatesMigrated() ? null : learnDeps.isDone };
}

// 移行（版 6 → 7）をその場で行う。deps = loadLearnStateDeps の材料。返り値 { ok: 版 7 になった（前から 7 も）, filled: 欄を書いた語の数 }
export function migrateLearnStates(deps = learnDeps) {
  if (learnStatesMigrated()) return { ok: true, filled: 0 };
  if (!deps || schemaVersion() < LEGACY_SCHEMA_VERSION) return { ok: false, filled: 0 }; // 古い版の段（migrateStorage）が先
  flushWordStats(); // このタスクの書きかけを先に書く（移行の表に入れる）
  const { table, filled } = fillLearnStates(getWordStats(), deps.vocab.isPublic, deps.isDone);
  if (table) {
    const raw = JSON.stringify(table);
    try {
      writeWordStats(raw); // 上限の守り（退避 → 影のデータの順に消して書き直す）を通す
    } catch (error) {
      (globalThis.reportError ?? console.error)(error);
      notifySaveFailed(); // 画面は容量の短い知らせを出せる（記録はそのまま）
      return { ok: false, filled: 0 };
    }
    memoRaw = raw;
    memoStats = FREEZE ? deepFreeze(table) : table;
    draft = null; // このタスクの書き手は移行の後の表から写す
  }
  if (!setCurrentSchema()) return { ok: false, filled };
  return { ok: true, filled };
}

function setCurrentSchema() {
  try {
    localStorage.setItem(SCHEMA_VERSION_KEY, String(CURRENT_SCHEMA_VERSION));
    return true;
  } catch (error) {
    (globalThis.reportError ?? console.error)(error);
    return false; // 欄は書けた。版は次に開いたときに上げる（欄のある語は飛ばすので同じ結果）
  }
}

// 版 7 の前なら移行を始める（読み込みのとき・復元の後）。埋める候補の無い端末はその場で版を上げる。返り値 Promise<{ ok, filled }>
function startLearnStates() {
  if (learnStatesMigrated()) return Promise.resolve({ ok: true, filled: 0 });
  if (!hasUnfilled(getWordStats())) return Promise.resolve({ ok: setCurrentSchema(), filled: 0 });
  learnMigrating ??= loadLearnStateDeps().then((deps) => {
    if (deps) return migrateLearnStates(deps);
    learnMigrating = null; // 表が読めなかった: 次に呼んだときに読み直す
    return { ok: false, filled: 0 };
  });
  return learnMigrating;
}

// 3 状態を読む前に待つ（中心の学習・学習状況）: 版 7 の前なら移行を試し、材料を読む。返り値は learnStateSource()（材料が読めなければ null）
export async function loadLearnStates() {
  await startLearnStates();
  await loadLearnStateDeps();
  return learnStateSource();
}

// バックアップの復元（js/backup.js applyBackup）が、書き戻した直後に呼ぶ: 版 6 の記録はその場で版 7 にする（再読み込みを待たない。
// 開いているほかのタブが、版 6 の表を「欄が無い = これから」と読まない: dataloss d9）。材料が読めていなければ版 7 の段は後から（startLearnStates）。
// 版 6 より前の記録（版の鍵の無いファイルも）は、今までどおり次に開いたときに古い版の段から流す（その間も、読み手と書き手は版を見て移行の式で読む）
export function migrateRestored() {
  forgetWordStats();
  learnMigrating = null;
  if (schemaVersion() < LEGACY_SCHEMA_VERSION) return { ok: false, filled: 0 };
  if (learnDeps) return migrateLearnStates(learnDeps);
  startLearnStates();
  return { ok: false, filled: 0 };
}

// ===== ほかのタブで記録が置き換わった（決定 §8・dataloss d12） =====
// 別のアカウントへの置き換え（持ち主 spelldash_owner〔js/sync.js OWNER_KEY〕が替わる・消える）・バックアップの復元（版が下がる・持ち主が消える）・
// 記録の消去（語の記録の鍵が消える）を、ほかのタブの storage イベントで数える。中心の学習の回は始めに recordsEpoch() を控えて書き手に渡す
// （違えば書かない: 前の人の回の答えを、新しい人の表に入れない）。回を終えるのは画面の側（spelldash:records-replaced を聞く）。
// 答えのたびに保存を読み直さない（読み直すのは、保存の文字列が変わったタスクだけ: getWordStats）
const OWNER_KEY = "spelldash_owner";
let recordsEpochNo = 0;

export function recordsEpoch() {
  return recordsEpochNo;
}

function isRecordsReplaced(event) {
  if (!event) return false;
  if (event.key === null) return true; // 全部消した
  if (event.key === OWNER_KEY) return event.oldValue !== null && event.oldValue !== event.newValue;
  if (event.key === STORAGE_KEY) return event.newValue === null;
  if (event.key === SCHEMA_VERSION_KEY) return (Number(event.newValue) || 1) < (Number(event.oldValue) || 1);
  return false;
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event) => {
    if (event.storageArea && event.storageArea !== localStorage) return;
    if (!isRecordsReplaced(event)) return;
    recordsEpochNo++;
    if (typeof CustomEvent === "function") window.dispatchEvent(new CustomEvent("spelldash:records-replaced"));
  });
}

startLearnStates();

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