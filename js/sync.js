import { supabase } from "./supabase.js";
import { CORRUPT_KEYS, SHADOW_KEYS, dropKeys, isQuotaError } from "./storageGuard.js";
import { getWordStats, saveWordStats, whenWordStatsSaved, getBestScore, saveBestScore, loadLearnStateDeps, learnStatesMigrated } from "./storage.js";
import { fillLearnStates, learnFieldsOf } from "./learnState.js";
import { getTotalXp, getLevelState, getStreak } from "./level.js";
import {
  getBattleStore,
  saveBattleStore,
  getPendingBattleSessions,
  clearPendingBattleSessions
} from "./battleRank.js";
import { getStudyMix, adoptCloudRatio } from "./studyMix.js";
import { buildActivityRow } from "./activity.js";
import { pushUserItems, pullUserItems } from "./userItemsSync.js";
import { markVeteranIfReturning } from "./unlocks.js";
import { COURSES, startCourse } from "./course.js";
import { getEnabledPackIds, setPackEnabled } from "./packs.js";
import { getPackCatalog } from "./wordStore.js";

// ===== Local First 同期 =====
// プレイ中は localStorage のみに書き、以下のタイミングでSupabaseへ同期する:
//   - Challenge終了時 / Studyで10語ごと / ページ離脱時 / ログイン直後（マージ）
// 毎入力での同期はしない。
// 送信（push）はこのタブでクラウドの記録を取り込んで（pull）からだけ。取り込む前の空の端末の値でクラウドを上書きしない。
// 人ごとの保存の領域（js/areaGuard.js）: クラウドを読み書きするのは、ページの領域が "u:" + セッションの user id で、見張りの stillMine() のときだけ
// （areaAllows）。取り込み（initialSync）・送信（pushSync）・ユーザーの品の同期の頭で確かめ、送るたびにも確かめる（cloudFor の口は送る時に確かめる）。

const DIRTY_KEY = "spelldash_dirty_words";
const XP_KEY = "spelldash_xp";
const XP_SYNCED_KEY = "spelldash_xp_synced"; // この端末の XP のうち、クラウドにあると分かっている分（2 台で増えた分を足し合わせる基準）
const XP_WRITE_KEY = "spelldash_xp_write"; // 送ったが返事を確かめていない XP の書き込み { value, at }（次に読んだとき、届いていれば基準にする）
const STREAK_KEY = "spelldash_streak";
const OWNER_KEY = "spelldash_owner"; // この端末の記録の持ち主（最後に同期できたアカウントの user id）
const CATEGORY_KEY = "spelldash_category";
const COURSE_KEY = "spelldash_course";
const SYNCED_FLAG = "spelldash_synced_this_session"; // sessionStorage: このタブで同期を始めた（値は user id）
const PULLED_FLAG = "spelldash_pulled_this_session"; // sessionStorage: このタブでクラウドの記録を取り込み終えた（値は user id）
const DONE_FLAG = "spelldash_sync_done_this_session"; // sessionStorage: このタブで同期を最後まで終えた（値は user id）
const PULL_AT_FLAG = "spelldash_pull_started_at"; // sessionStorage: SYNCED_FLAG を立てた時刻（ms）。取り込みを始めるたびに新しくする
const PULL_GIVE_UP_MS = 120000; // 取り込みを始めてから 2 分たっても取り込み終えない印は止まったものとみなす（isPulling）
const LOGOUT_KEY = "spelldash_logout_at"; // 持ち主のある端末でログアウトした時刻（最初の 1 回。次の同期が済むまで残す。learnedSinceLogout）
const LEARN_FILLED_KEY = "spelldash_learn_filled"; // 3 状態の初めの埋めを済ませたアカウントの user id（この端末とアカウントで 1 回だけ。fillLearnStatesOnce）
const STORE_READY_TIMEOUT_MS = 5000;

let isPushing = false;

// ---- dirty管理（前回同期以降に変わった単語ID） ----

function getDirtyWords() {
  try {
    return new Set(JSON.parse(localStorage.getItem(DIRTY_KEY)) || []);
  } catch {
    return new Set();
  }
}

// 送る語の印。枠が上限のときは、学習の記録と同じ優先（退避 → 影のデータの順に消して書き直す。js/storageGuard.js）。
// それでも書けなければ投げずに続ける（答えの記録は書けている。印が欠けた語は次に答えたときに付く）
function saveDirtyWords(set) {
  const text = JSON.stringify([...set]);
  for (const drop of [null, CORRUPT_KEYS, SHADOW_KEYS]) {
    if (drop && !dropKeys(drop)) continue;
    try {
      localStorage.setItem(DIRTY_KEY, text);
      return;
    } catch (error) {
      if (!isQuotaError(error)) return;
    }
  }
}

export function markWordDirty(wordId) {
  const dirty = getDirtyWords();
  if (!dirty.has(wordId)) {
    dirty.add(wordId);
    saveDirtyWords(dirty);
  }
}

// ---- 変換 ----

function statToRow(userId, wordId, s) {
  return {
    user_id: userId,
    word_id: wordId,
    play_count: s.playCount ?? 0,
    correct_count: s.correctCount ?? 0,
    typing_miss: s.typingMiss ?? 0,
    recall_fail: s.recallFail ?? 0,
    clean_correct_streak: s.cleanCorrectStreak ?? 0,
    mastered: !!s.mastered,
    mastered_at: s.masteredAt ?? null,
    last_played: s.lastPlayed ?? null,
    next_review_at: s.nextReviewAt ?? null,
    last_recall_fail_at: s.lastRecallFailAt ?? null,
    last_recall_success_at: s.lastRecallSuccessAt ?? null,
    daily_learning_date: s.dailyLearningDate ?? null,
    daily_learning_stage: s.dailyLearningStage ?? 0,
    srs_advanced_on: s.srsAdvancedOn ?? null,
    updated_at: new Date().toISOString()
  };
}

function rowToStat(row, localStat) {
  return {
    playCount: row.play_count,
    correctCount: row.correct_count,
    typingMiss: row.typing_miss,
    recallFail: row.recall_fail,
    // missCountはローカル互換の合算値（クラウドには持たない）
    missCount: Math.max(localStat?.missCount ?? 0, row.recall_fail),
    cleanCorrectStreak: row.clean_correct_streak,
    mastered: row.mastered,
    masteredAt: row.mastered_at,
    lastPlayed: row.last_played,
    nextReviewAt: row.next_review_at,
    lastRecallFailAt: row.last_recall_fail_at ?? null,
    lastRecallSuccessAt: row.last_recall_success_at ?? null,
    dailyLearningDate: row.daily_learning_date ?? null,
    dailyLearningStage: row.daily_learning_stage ?? 0,
    srsAdvancedOn: row.srs_advanced_on ?? null
  };
}

// 2つのISO日時のうち新しい方（どちらか欠けていれば存在する方）
function newerIso(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

async function getUserId() {
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id ?? null;
}

// ---- 人ごとの保存の領域（DESIGN-FINAL §5） ----
// ページの領域がこのアカウントの領域で、見張りが「まだこのページの人の物」と言うときだけ、クラウドを読み書きする。見張りが無い所では送らない
function areaAllows(userId) {
  const area = globalThis.SpellDashArea;
  try {
    return Boolean(userId) && Boolean(area) && area.area === "u:" + userId && area.stillMine() === true;
  } catch {
    return false;
  }
}

// クラウドの口（supabase と同じ形）。表の呼び出しを控え、送る時（then）に areaAllows を確かめてから本物の口で流す。違えば何も送らずに失敗を返す
// （呼び手は送れなかったとして扱う。成功と見せない）。ユーザーの品の同期（js/userItemsSync.js）にもこの口を渡す
function cloudFor(userId) {
  return { auth: supabase.auth, from: (table) => guardedTable(table, userId) };
}
function guardedTable(table, userId) {
  const calls = [];
  const run = () => {
    if (!areaAllows(userId)) return Promise.resolve({ data: null, error: { message: "記録の持ち主が替わったため送らなかった。", code: "SD2_AREA" }, count: null });
    let query = supabase.from(table);
    for (const [method, args] of calls) query = query[method](...args);
    return Promise.resolve(query);
  };
  const proxy = new Proxy(function () {}, {
    get(_, prop) {
      if (prop === "then") return (resolve, reject) => run().then(resolve, reject);
      if (prop === "catch") return (fn) => run().catch(fn);
      if (prop === "finally") return (fn) => run().finally(fn);
      return (...args) => {
        calls.push([prop, args]);
        return proxy;
      };
    }
  });
  return proxy;
}

// ---- push: ローカル → クラウド ----

// ログアウト時に呼ぶ（js/auth.js）: 同じタブで次にログインしたとき、取り込みからやり直す。
// 持ち主のある端末ではログアウトの時刻も残す（最初の 1 回だけ。ログインをやめたときにも呼ばれるので上書きしない。次の同期が済んだら消す）
export function clearSyncedFlag() {
  try {
    sessionStorage.removeItem(SYNCED_FLAG);
    sessionStorage.removeItem(PULLED_FLAG);
    sessionStorage.removeItem(DONE_FLAG);
    sessionStorage.removeItem(PULL_AT_FLAG);
  } catch {
    // sessionStorage が使えない環境では何もしない
  }
  try {
    if (localStorage.getItem(OWNER_KEY) && !localStorage.getItem(LOGOUT_KEY)) localStorage.setItem(LOGOUT_KEY, new Date().toISOString());
  } catch {
    // 書けなければ、次のログインでは今までどおり確かめずに足す
  }
}

// このタブでクラウドの記録の取り込みを始めて、まだ取り込み終えていないか（本棚 js/bookshelf.js が、その間は棚を保存しない）。
// 取り込みの途中は記録だけ届いて現在地・パックがまだ前の値のことがある。逃げ道: 取り込みを始めてから 2 分たっても終わらない
// （途中でセッションが切れて印が残ったタブ）なら途中とみなさない。時刻はその取り込みを始めた時なので、同じアカウントの 2 回目の取り込みでも測り直す
export function isPulling() {
  try {
    const started = sessionStorage.getItem(SYNCED_FLAG);
    if (!started || sessionStorage.getItem(PULLED_FLAG) === started) return false;
    const at = Number(sessionStorage.getItem(PULL_AT_FLAG));
    return at > 0 && Date.now() - at < PULL_GIVE_UP_MS;
  } catch {
    return false;
  }
}

// options.leaving: ページを離れるとき（pagehide・裏に回す）。往復を減らすため XP は送らない（次の送信・次の同期で送る）
export async function pushSync(options = {}) {
  if (isPushing) return;
  // 取り込み（initialSync）が済むまで送らない: 空の端末の 0 でクラウドの user_progress を上書きしないため
  if (!sessionStorage.getItem(PULLED_FLAG)) return;

  const userId = await getUserId();
  if (!userId) return; // 未ログインなら何もしない（Local First）
  if (sessionStorage.getItem(PULLED_FLAG) !== userId) return; // 別のアカウントの取り込みでは送らない
  if (!areaAllows(userId)) return; // ページの領域がこのアカウントでない・切り替えの途中: 送らない
  const cloud = cloudFor(userId);

  isPushing = true;

  try {
    const dirty = getDirtyWords();
    const stats = getWordStats();

    if (dirty.size > 0) {
      const rows = [...dirty]
        .filter((wordId) => stats[wordId])
        .map((wordId) => statToRow(userId, wordId, stats[wordId]));

      const { error } = await cloud.from("word_progress").upsert(rows);
      if (!error) {
        saveDirtyWords(new Set());
      }
    }

    await pushUserProgress(cloud, userId, options);
    await pushActivityDay(cloud, userId);
    await flushPendingBattleSessions(cloud, userId);
    if (areaAllows(userId)) await pushUserItems(cloud, userId); // マイ単語帳・メモ・パック（テーブル未作成なら何もしない）
  } finally {
    isPushing = false;
  }
}

// KPI計測の心拍: 当日のアクティビティを1日1行upsert。
// テーブル未作成・失敗時は静かにスキップ（ゲームに影響なし）
async function pushActivityDay(cloud, userId) {
  try {
    const row = buildActivityRow(userId);
    if (!row) return;
    await cloud.from("activity_days").upsert(row);
  } catch {
    // 計測はベストエフォート
  }
}

// ---- XP: 2 台で増えた分を足し合わせる ----
// 基準 B ＝ この端末の XP のうち、クラウドにあると分かっている分。クラウドの値 C を読んだら
//   この端末の XP ＝ max(C, B) ＋（いまの XP − B）、B ＝ max(C, B)
// とする（基準が無い初回は大きい方。B ＝ C）。B を送った値に進めるのは、送信が成功したと分かったときだけ。
// 返事が届かずにページが閉じた書き込みは、次に読んだクラウドの updated_at が送った時刻と同じなら届いていたとみなす。
// 読み・計算・書き込みは await をはさまずに行う（その間に増えた XP を消さない）
function readJsonKey(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function settleXpWrite(cloudRow) {
  const pending = readJsonKey(XP_WRITE_KEY);
  if (!pending) return;
  if (cloudRow?.updated_at && Date.parse(cloudRow.updated_at) === Date.parse(pending.at)) {
    localStorage.setItem(XP_SYNCED_KEY, String(Number(pending.value) || 0));
  }
  localStorage.removeItem(XP_WRITE_KEY);
}

// クラウドの XP を取り込む。戻り値: 合わせた後のこの端末の XP
function absorbCloudXp(cloudXp) {
  const localXp = getTotalXp();
  const raw = localStorage.getItem(XP_SYNCED_KEY);
  const base = raw === null ? null : Number(raw) || 0;
  const merged = base === null ? Math.max(cloudXp, localXp) : Math.max(cloudXp, base) + Math.max(0, localXp - base);
  const nextBase = base === null ? cloudXp : Math.max(cloudXp, base);
  if (merged !== localXp) localStorage.setItem(XP_KEY, String(merged));
  localStorage.setItem(XP_SYNCED_KEY, String(nextBase));
  return merged;
}

async function pushUserProgress(cloud, userId, { leaving = false } = {}) {
  const battle = getBattleStore();
  const row = {
    user_id: userId,
    streak: getStreak(),
    best_score: getBestScore(),
    selected_category: localStorage.getItem("spelldash_category") || "all",
    selected_mode: localStorage.getItem("spelldash_mode") || "study",
    battle_rp: battle.rp,
    battle_wins: battle.wins,
    battle_losses: battle.losses,
    battle_draws: battle.draws,
    battle_current_win_streak: battle.currentWinStreak,
    battle_best_win_streak: battle.bestWinStreak,
    study_familiar_ratio: getStudyMix().familiarRatio
  };

  if (leaving) {
    // ページを離れるときは XP を読まずに、XP 以外の列だけ送る（upsert は渡した列だけを書き換える）
    await cloud.from("user_progress").upsert({ ...row, updated_at: new Date().toISOString() });
    return;
  }

  let current;
  try {
    current = await cloud.from("user_progress").select("xp,updated_at").maybeSingle();
  } catch {
    return;
  }
  if (!current || current.error) return; // 読めなければ送らない（次の送信で再試行）
  settleXpWrite(current.data);
  const xp = absorbCloudXp(Number(current.data?.xp) || 0);
  const at = new Date().toISOString();
  localStorage.setItem(XP_WRITE_KEY, JSON.stringify({ value: xp, at }));
  const { error } = await cloud.from("user_progress").upsert({ ...row, xp, level: getLevelState(xp).level, updated_at: at });
  if (!error) {
    localStorage.setItem(XP_SYNCED_KEY, String(xp));
    localStorage.removeItem(XP_WRITE_KEY);
  }
}

// battle_sessionsの送信待ち行列を送る（失敗しても残り、次回再送）
async function flushPendingBattleSessions(cloud, userId) {
  const pending = getPendingBattleSessions();
  if (pending.length === 0) return;

  const rows = pending.map((row) => ({ ...row, user_id: userId }));
  const { error } = await cloud.from("battle_sessions").insert(rows);

  if (!error) {
    clearPendingBattleSessions();
  }
}

// ---- play_sessions: Challenge終了ごとの履歴 ----

export async function recordPlaySession(session) {
  const userId = await getUserId();
  if (!userId || !areaAllows(userId)) return;

  await cloudFor(userId).from("play_sessions").insert({
    user_id: userId,
    mode: session.mode,
    score: session.score,
    typing_speed: session.typingSpeed,
    typing_miss: session.typingMiss,
    recall_fail: session.recallFail,
    duration_seconds: session.durationSeconds
  });
}

// ---- 初回同期（ログイン直後 / ページロード時に1回） ----
// パターン①クラウド空 → ローカルを全アップロード
// パターン②両方あり → 単語ごとに新しい方（last_played比較）を採用してマージ
// 人ごとの保存の領域（js/areaGuard.js・js/areaSwitch.js）: ページの領域はこのアカウントの領域だけ。ゲストの記録を移すかは切り替えの画面が 1 回たずねる。
// 別のアカウントの記録はその人の領域に分けて残る（端末の記録を差し替える確認と消去の道は無い）。
//
// 戻り値: "changed"（クラウドから何か取り込んだ）／"same"（同期したが変化なし）／
//         "cancelled"（ログアウトの後の記録を足すのを断った。何も書いていない）／
//         false（未ログイン・このタブで同期済み・ページの領域がこのアカウントでない）。取得の失敗は throw（ローカルは壊さない）

const MERGE_CONFIRM_TEXT = "この端末の記録を、このアカウントの記録に足す。別の人の記録なら、キャンセルしてログインをやめる。";

// 分野パックの一覧にある id か（基本カテゴリの id を「パック」として追加しない）
function isKnownPack(id) {
  try {
    return getPackCatalog().some((c) => c.id === id);
  } catch {
    return false;
  }
}

// ログアウトの後に、この端末で学んだ跡があるか（語の記録の最後の出題・答えの日時・中心の学習で最後に答えた時刻 lsAt がログアウトより後）。
// 未ログインのあいだに別の人が使ったかもしれないので、同じアカウントでログインし直したときも、足す前にたずねる
// （決定 §8「ログアウト…で別人の状態を混ぜない」。dataloss d7。創業者に送った既定）
function learnedSinceLogout() {
  const at = Date.parse(localStorage.getItem(LOGOUT_KEY) ?? "");
  if (!(at > 0)) return false;
  const ms = (iso) => Date.parse(iso ?? "") || 0;
  return Object.values(getWordStats()).some((s) => s && Math.max(ms(s.lastPlayed), ms(s.lastRecallSuccessAt), ms(s.lastRecallFailAt), Number(s.lsAt) || 0) > at);
}

let syncInFlight = false; // 同じページで 2 回走らせない（auth-ready と SIGNED_IN が続けて来る）

// options（freshLogin）は受けるが使わない（ゲストの記録を移すかは切り替えの画面がたずねる。呼び手の形を変えない）
export async function initialSync(options = {}) {
  if (syncInFlight) return false;
  syncInFlight = true;
  try {
    return await runInitialSyncOnce(options);
  } finally {
    syncInFlight = false;
  }
}

async function runInitialSyncOnce() {
  const userId = await getUserId();
  if (!userId) return false;
  // ページの領域がこのアカウントでない・切り替えの途中: 何も読まない・何も送らない（見張りが切り替えの画面へ移す）
  if (!areaAllows(userId)) return false;
  // このタブで最後まで済んでいれば何もしない（途中でページを移った場合は最初からやり直す）
  if (sessionStorage.getItem(DONE_FLAG) === userId) return false;
  const cloud = cloudFor(userId);

  // 領域の持ち主の印が別の人（人ごとの領域では起きない形）: 混ぜない・消さない・送らない
  const owner = localStorage.getItem(OWNER_KEY);
  if (owner && owner !== userId) return false;
  if (owner === userId && learnedSinceLogout()) {
    // 移行の前（この版より前）にログアウトの後で学んだ記録が、持ち主の印でこのアカウントの領域に入った: 足す前にたずねる（断ったら何も書かない。次のログインでまたたずねる）
    if (!window.confirm(MERGE_CONFIRM_TEXT)) return "cancelled";
  }

  sessionStorage.setItem(SYNCED_FLAG, userId);
  sessionStorage.setItem(PULL_AT_FLAG, String(Date.now()));
  sessionStorage.removeItem(PULLED_FLAG);

  // 3 状態の初めの埋め（fillLearnStatesOnce）の材料は、取り込みと並べて読む（取り込みの後から表を書き終えるまでのあいだに待ちをはさまない）
  const learnFill = localStorage.getItem(LEARN_FILLED_KEY) === userId ? null : loadLearnStateDeps();
  const [wordResult, progressResult, learnDeps] = await Promise.all([
    cloud.from("word_progress").select("*"),
    cloud.from("user_progress").select("*").maybeSingle(),
    learnFill
  ]);

  // どちらかの取得に失敗したらフラグを戻して次回再試行（データを壊さない。user_progress の上書きにも進まない）
  if (wordResult.error || progressResult.error) {
    sessionStorage.removeItem(SYNCED_FLAG);
    sessionStorage.removeItem(PULL_AT_FLAG);
    const error = wordResult.error || progressResult.error;
    throw new Error(`sync pull failed: ${error?.message ?? error}`);
  }

  const cloudRows = wordResult.data;
  const cloudProgress = progressResult.data;

  const local = getWordStats();
  // 学習記録の無い端末（2 台目の初回・置き換えた直後）。現在地（コース）をクラウドから採る
  const freshDevice = Object.keys(local).length === 0;
  const cloudMap = new Map((cloudRows ?? []).map((row) => [row.word_id, row]));

  let changedLocal = false;
  const toUpload = [];
  let merged = { ...local };

  const allIds = new Set([...Object.keys(local), ...cloudMap.keys()]);

  for (const wordId of allIds) {
    const l = local[wordId];
    const c = cloudMap.get(wordId);

    if (l && !c) {
      toUpload.push(statToRow(userId, wordId, l));
      continue;
    }

    if (!l && c) {
      merged[wordId] = rowToStat(c, null);
      changedLocal = true;
      continue;
    }

    // 両方ある: 行全体は新しい方を採用。
    // ただしRecall Loopの2つの日時は、フィールド単位で両端末の新しい方を採用する
    const localTime = Date.parse(l.lastPlayed ?? 0) || 0;
    const cloudTime = Date.parse(c.last_played ?? 0) || 0;

    const recallFields = {
      lastRecallFailAt: newerIso(l.lastRecallFailAt, c.last_recall_fail_at),
      lastRecallSuccessAt: newerIso(l.lastRecallSuccessAt, c.last_recall_success_at)
    };

    if (localTime > cloudTime) {
      const combined = { ...l, ...recallFields };
      merged[wordId] = combined;
      changedLocal = true;
      toUpload.push(statToRow(userId, wordId, combined));
    } else if (cloudTime > localTime) {
      // ローカルだけにある拡張フィールド（history / knownOnSight / lastReviewResult 等）は残す。
      // 3 状態の欄（ls・lsd・lsAt。送らない端末だけの欄）は、クラウドの行が新しくても（× を含んでいても）必ず端末の値（決定 §4・§8: 同期だけで届いた変化で状態を変えない）
      merged[wordId] = { ...l, ...rowToStat(c, l), ...recallFields, ...learnFieldsOf(l) };
      changedLocal = true;
    }
  }

  const filledLearn = fillLearnStatesOnce(merged, local, learnDeps);
  if (filledLearn.table) {
    merged = filledLearn.table;
    changedLocal = true;
  }

  // 取り込んだ表の保存の成否（埋めの印は、埋めた表が保存できたときだけ付ける。容量で書けなかったのに印を付けると、
  // 次の取り込みで埋めをやり直さず、届いた語が これから のまま残る: dataloss d5）
  let savedLocal = Promise.resolve(true);
  if (changedLocal) {
    saveWordStats(merged);
    savedLocal = whenWordStatsSaved();
  }
  // 別の端末の記録で 30 語以上になった人は「以前から使っている人」（同期より先に描いた画面が解放を "0" で保存していても直す）。
  // この端末だけで 30 語に達した新しい人は、従来どおりセット数で解放（js/unlocks.js）
  if (freshDevice) markVeteranIfReturning(Object.keys(merged).length);

  if (toUpload.length > 0) {
    // 一度に送りすぎないよう分割
    for (let i = 0; i < toUpload.length; i += 500) {
      await cloud.from("word_progress").upsert(toUpload.slice(i, i + 500));
    }
  }

  // user_progress のマージ（XP は 2 台で増えた分を足す・ベスト・最長ストリークは大きい方を採用）
  if (cloudProgress) {
    // 初回（基準なし）は大きい方。基準があれば「クラウドの値（か基準）＋この端末で基準から増えた分」（absorbCloudXp）
    const localXp = getTotalXp();
    settleXpWrite(cloudProgress);
    if (absorbCloudXp(Number(cloudProgress.xp) || 0) !== localXp) changedLocal = true;

    if (cloudProgress.best_score > getBestScore()) {
      saveBestScore(cloudProgress.best_score);
    }

    const localStreak = getStreak();
    const cloudStreak = cloudProgress.streak;
    if (cloudStreak && (cloudStreak.last ?? "") > (localStreak.last ?? "")) {
      // シールドは「最後にプレイした側」の値が正（消費の巻き戻しを防ぐため maxにしない）
      localStorage.setItem(
        STREAK_KEY,
        JSON.stringify({
          last: cloudStreak.last,
          current: cloudStreak.current,
          best: Math.max(cloudStreak.best ?? 0, localStreak.best ?? 0),
          shields: cloudStreak.shields ?? 0,
          shieldSavedOn: cloudStreak.shieldSavedOn ?? null,
          // 途切れの記録と修復の使用月（Pro の連続記録の修復用）も最後にプレイした側に合わせる
          lost: cloudStreak.lost ?? null,
          repairedMonth: cloudStreak.repairedMonth ?? null
        })
      );
      changedLocal = true;
    }

    // 出題比率: 更新が新しい方を採用
    const localMix = getStudyMix();
    const cloudProgressUpdated = Date.parse(cloudProgress.updated_at ?? 0) || 0;
    if (
      cloudProgress.study_familiar_ratio != null &&
      cloudProgressUpdated > (Date.parse(localMix.updatedAt ?? 0) || 0)
    ) {
      adoptCloudRatio(cloudProgress.study_familiar_ratio, cloudProgress.updated_at);
      changedLocal = true;
    }

    // Battle戦績: 更新が新しい方のスナップショットを採用（累計の二重計上を防ぐ）。
    // bestWinStreakのみ両者のmax
    const localBattle = getBattleStore();
    const cloudUpdated = Date.parse(cloudProgress.updated_at ?? 0) || 0;
    const localBattleUpdated = Date.parse(localBattle.updatedAt ?? 0) || 0;

    if ((cloudProgress.battle_rp ?? 0) > 0 || cloudUpdated > 0) {
      if (cloudUpdated > localBattleUpdated) {
        saveBattleStore({
          rp: cloudProgress.battle_rp ?? 0,
          wins: cloudProgress.battle_wins ?? 0,
          losses: cloudProgress.battle_losses ?? 0,
          draws: cloudProgress.battle_draws ?? 0,
          currentWinStreak: cloudProgress.battle_current_win_streak ?? 0,
          bestWinStreak: Math.max(
            cloudProgress.battle_best_win_streak ?? 0,
            localBattle.bestWinStreak ?? 0
          ),
          updatedAt: cloudProgress.updated_at
        });
        changedLocal = true;
      }
    }
  }

  // 現在地: 学習記録の無かった端末に限り、クラウドの選択（selected_category）を採る。
  // 記録のある端末同士は端末ごとの選択を尊重して触らない。
  // pull の前にコースを敷くと、追加したパックの印がクラウドより新しくなって取り込みが外れるので、ここでは値だけ決める
  const cloudCategory = freshDevice ? cloudProgress?.selected_category : null;
  const adoptCategory = cloudCategory && cloudCategory !== "all" ? cloudCategory : null;

  // 自分のデータ（マイ単語帳・メモ・追加したパック・日ごとの記録）の項目マージ。
  // 語の読み直し（spelldash:packs）は現在地の採用と合わせて 1 回にまとめる
  const items = areaAllows(userId) ? await pullUserItems(cloud, userId, { deferPacksEvent: true }) : { changed: null };
  const itemChanged = items.changed ?? null;
  if (itemChanged && (itemChanged.my_word || itemChanged.note || itemChanged.pack || itemChanged.day)) changedLocal = true;

  let packAdded = false;
  if (adoptCategory) {
    const packsBefore = getEnabledPackIds();
    const placeBefore = `${localStorage.getItem(COURSE_KEY)}|${localStorage.getItem(CATEGORY_KEY)}`;
    const course = Object.values(COURSES).find((c) => c.packs.includes(adoptCategory));
    if (course) {
      startCourse(course.id, adoptCategory);
    } else {
      // コースに無いパック（分野パック 1 本が道）: コースは外し、そのパックを追加して（読み込まれるように）カテゴリにする
      localStorage.removeItem(COURSE_KEY);
      if (!getEnabledPackIds().includes(adoptCategory) && isKnownPack(adoptCategory)) setPackEnabled(adoptCategory, true);
      localStorage.setItem(CATEGORY_KEY, adoptCategory);
    }
    packAdded = getEnabledPackIds().some((id) => !packsBefore.includes(id));
    if (packAdded || placeBefore !== `${localStorage.getItem(COURSE_KEY)}|${localStorage.getItem(CATEGORY_KEY)}`) changedLocal = true;
  }

  // 取り込みの途中で領域が替わった（ほかのタブで切り替えが始まった・セッションが替わった）: 取り込み済みの印を付けない・送らない
  if (!areaAllows(userId)) return false;
  // 取り込み（語・進捗・項目・現在地）はここまで。以降は送ってよい（pagehide の pushSync もここから効く）
  sessionStorage.setItem(PULLED_FLAG, userId);

  // 現在の値を送る（取り込みが済んだので、クラウドを空の値で上書きすることはない）
  await pushUserProgress(cloud, userId);
  await ensureProfile(cloud, userId);

  saveDirtyWords(new Set());
  localStorage.setItem(OWNER_KEY, userId);
  localStorage.removeItem(LOGOUT_KEY);
  if (filledLearn.done && (await savedLocal)) localStorage.setItem(LEARN_FILLED_KEY, userId);
  sessionStorage.setItem(DONE_FLAG, userId);

  // 追加したパックが変わったら、語の読み直しが終わるまで待ってから再描画を促す（読み直し前の語で数えないため）
  if (itemChanged?.pack || packAdded) {
    await reloadWordsAndWait();
  }

  if (changedLocal) {
    // 各ページに再描画を促す
    window.dispatchEvent(new CustomEvent("spelldash:synced"));
    return "changed";
  }

  return "same";
}

// 3 状態の初めの埋め（c6・dataloss d5。創業者に送った既定）: スキーマ 7 の後、この端末とアカウントで初めて取り込めたときに 1 回だけ、
// 状態の欄が無く、取り込む前の端末に答えの記録の無かった公開の語（2 台目の初回・置き換えた直後・記録を消した後に届いた語）を、移行の式で埋める
// （状態の変化ではなく移行として扱う。目安・ランクアップの幕・知らせには数えない）。それより後に届いた行では状態を変えない（欄は これから のまま、
// 中心の学習で答えたときに決まる）。端末にある状態・端末で答えた語は決して変えない。版 7 の前なら移行（js/storage.js）が埋めるので、ここでは埋めず印も付けない。
// 材料（公開の語の表）が読めなければ埋めず、印も付けない（次の取り込みでやり直す）。埋めた表が保存できなかった（容量）ときも印は付けない（呼ぶ側）。
// 返り値 { table: 埋めた表か null, done: 印を付けてよい }
function fillLearnStatesOnce(merged, local, deps) {
  if (!deps || !learnStatesMigrated()) return { table: null, done: false };
  const { table } = fillLearnStates(merged, deps.vocab.isPublic, deps.isDone, local);
  return { table, done: true };
}

// 語の読み直しを頼み（spelldash:packs）、読み直したページ（ホーム js/main.js・単語帳 js/listView.js・学習データ js/statsView.js）が
// 投げる spelldash:store-ready を最大 5 秒待つ。読み直さないページ（Pro・プロフィールなど。body に data-store-reload が無い）は待たない
function reloadWordsAndWait() {
  const waitsForStore = !!document.querySelector(".app--home, body[data-store-reload]");
  const ready = waitsForStore
    ? new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          window.removeEventListener("spelldash:store-ready", done);
          resolve();
        };
        const timer = setTimeout(done, STORE_READY_TIMEOUT_MS);
        window.addEventListener("spelldash:store-ready", done);
      })
    : Promise.resolve();
  window.dispatchEvent(new CustomEvent("spelldash:packs", { detail: { synced: true } }));
  return ready;
}

// profiles行がなければ作成（表示名・アバターはGoogleログイン情報から）
async function ensureProfile(cloud, userId) {
  const { data: existing } = await cloud
    .from("profiles")
    .select("user_id")
    .maybeSingle();

  if (existing) return;

  const { data } = await supabase.auth.getSession();
  const user = data.session?.user;
  const meta = user?.user_metadata ?? {};
  const audio = JSON.parse(localStorage.getItem("spelldash_audio") || "{}");

  await cloud.from("profiles").insert({
    user_id: userId,
    display_name: meta.full_name || meta.name || user?.email?.split("@")[0] || null,
    avatar_url: meta.avatar_url || null,
    audio_mode: audio.mode || "auto",
    preferred_accent: audio.accent || "us"
  });
}

// ---- ページ離脱時の送信（ベストエフォート） ----

export function setupUnloadSync() {
  window.addEventListener("pagehide", () => {
    pushSync({ leaving: true });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      pushSync({ leaving: true });
    }
  });
}
