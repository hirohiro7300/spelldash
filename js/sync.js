import { supabase } from "./supabase.js";
import { getWordStats, saveWordStats, getBestScore, saveBestScore } from "./storage.js";
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
import { clearLocalRecords } from "./backup.js";
import { markVeteranIfReturning } from "./unlocks.js";
import { COURSES, startCourse, ensureDefaultCourse } from "./course.js";
import { getEnabledPackIds } from "./packs.js";

// ===== Local First 同期 =====
// プレイ中は localStorage のみに書き、以下のタイミングでSupabaseへ同期する:
//   - Challenge終了時 / Studyで10語ごと / ページ離脱時 / ログイン直後（マージ）
// 毎入力での同期はしない。
// 送信（push）はこのタブでクラウドの記録を取り込んで（pull）からだけ。取り込む前の空の端末の値でクラウドを上書きしない。

const DIRTY_KEY = "spelldash_dirty_words";
const XP_KEY = "spelldash_xp";
const XP_SYNCED_KEY = "spelldash_xp_synced"; // 最後にクラウドと一致した XP（2 台で増えた分を足し合わせる基準）
const STREAK_KEY = "spelldash_streak";
const OWNER_KEY = "spelldash_owner"; // この端末の記録の持ち主（最後に同期できたアカウントの user id）
const CATEGORY_KEY = "spelldash_category";
const COURSE_KEY = "spelldash_course";
const SYNCED_FLAG = "spelldash_synced_this_session"; // sessionStorage: このタブで同期を始めた（値は user id）
const PULLED_FLAG = "spelldash_pulled_this_session"; // sessionStorage: このタブでクラウドの記録を取り込み終えた（値は user id）
const DONE_FLAG = "spelldash_sync_done_this_session"; // sessionStorage: このタブで同期を最後まで終えた（値は user id）
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

function saveDirtyWords(set) {
  localStorage.setItem(DIRTY_KEY, JSON.stringify([...set]));
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

// ---- push: ローカル → クラウド ----

// ログアウト時に呼ぶ（js/auth.js）: 同じタブで次にログインしたとき、取り込みからやり直す
export function clearSyncedFlag() {
  try {
    sessionStorage.removeItem(SYNCED_FLAG);
    sessionStorage.removeItem(PULLED_FLAG);
    sessionStorage.removeItem(DONE_FLAG);
  } catch {
    // sessionStorage が使えない環境では何もしない
  }
}

export async function pushSync() {
  if (isPushing) return;
  // 取り込み（initialSync）が済むまで送らない: 空の端末の 0 でクラウドの user_progress を上書きしないため
  if (!sessionStorage.getItem(PULLED_FLAG)) return;

  const userId = await getUserId();
  if (!userId) return; // 未ログインなら何もしない（Local First）
  if (sessionStorage.getItem(PULLED_FLAG) !== userId) return; // 別のアカウントの取り込みでは送らない

  isPushing = true;

  try {
    const dirty = getDirtyWords();
    const stats = getWordStats();

    if (dirty.size > 0) {
      const rows = [...dirty]
        .filter((wordId) => stats[wordId])
        .map((wordId) => statToRow(userId, wordId, stats[wordId]));

      const { error } = await supabase.from("word_progress").upsert(rows);
      if (!error) {
        saveDirtyWords(new Set());
      }
    }

    await pushUserProgress(userId);
    await pushActivityDay(userId);
    await flushPendingBattleSessions(userId);
    await pushUserItems(supabase, userId); // マイ単語帳・メモ・パック（テーブル未作成なら何もしない）
  } finally {
    isPushing = false;
  }
}

// KPI計測の心拍: 当日のアクティビティを1日1行upsert。
// テーブル未作成・失敗時は静かにスキップ（ゲームに影響なし）
async function pushActivityDay(userId) {
  try {
    const row = buildActivityRow(userId);
    if (!row) return;
    await supabase.from("activity_days").upsert(row);
  } catch {
    // 計測はベストエフォート
  }
}

// XP は 2 台で増えた分を足し合わせる（initialSync と同じ式）。開いたままのタブの送信が、別の端末で増えた分を消さないように
// 送る前にクラウドの値を読む。読めなければ送らない（次の送信で再試行）
function mergeXp(cloudXp, localXp) {
  const syncedRaw = localStorage.getItem(XP_SYNCED_KEY);
  const synced = syncedRaw === null ? null : Number(syncedRaw) || 0;
  return synced === null ? Math.max(cloudXp, localXp) : Math.max(cloudXp, synced) + Math.max(0, localXp - synced);
}

async function pushUserProgress(userId) {
  const battle = getBattleStore();
  let xp = getTotalXp();
  try {
    const current = await supabase.from("user_progress").select("xp").maybeSingle();
    if (!current || current.error) return;
    xp = mergeXp(Number(current.data?.xp) || 0, xp);
  } catch {
    return;
  }
  if (xp !== getTotalXp()) localStorage.setItem(XP_KEY, String(xp));
  const level = getLevelState(xp);

  const { error } = await supabase.from("user_progress").upsert({
    user_id: userId,
    xp,
    level: level.level,
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
    study_familiar_ratio: getStudyMix().familiarRatio,
    updated_at: new Date().toISOString()
  });
  if (!error) localStorage.setItem(XP_SYNCED_KEY, String(xp));
}

// battle_sessionsの送信待ち行列を送る（失敗しても残り、次回再送）
async function flushPendingBattleSessions(userId) {
  const pending = getPendingBattleSessions();
  if (pending.length === 0) return;

  const rows = pending.map((row) => ({ ...row, user_id: userId }));
  const { error } = await supabase.from("battle_sessions").insert(rows);

  if (!error) {
    clearPendingBattleSessions();
  }
}

// ---- play_sessions: Challenge終了ごとの履歴 ----

export async function recordPlaySession(session) {
  const userId = await getUserId();
  if (!userId) return;

  await supabase.from("play_sessions").insert({
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
// 別のアカウントの記録がある端末（spelldash_owner が違う）は混ぜずに、置き換えるかを本人に聞く。
//
// 戻り値: "changed"（クラウドから何か取り込んだ）／"same"（同期したが変化なし）／
//         "cancelled"（別のアカウントの記録があり、置き換えを断った。何も書いていない）／
//         false（未ログイン、またはこのタブで同期済み）。取得の失敗は throw（ローカルは壊さない）

const OWNER_CONFIRM_TEXT = "この端末には別のアカウントの記録がある。消して、このアカウントの記録に置き換える";

// 人の記録が 1 つでもあるか（語・XP・マイ単語帳・メモ・Battle・成長ログ・今日のセットの履歴）。持ち主の確認に使う
function hasPersonalRecords() {
  const json = (key, fallback) => {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const nonEmpty = (v) => (Array.isArray(v) ? v.length > 0 : v && typeof v === "object" ? Object.keys(v).length > 0 : false);
  const battle = json("spelldash_battle", {});
  return (
    nonEmpty(json("spelldash_word_stats", {})) ||
    (Number(localStorage.getItem(XP_KEY)) || 0) > 0 ||
    nonEmpty(json("spelldash_my_words", [])) ||
    nonEmpty(json("spelldash_word_notes", {})) ||
    (Number(battle.wins) || 0) + (Number(battle.losses) || 0) + (Number(battle.draws) || 0) > 0 ||
    nonEmpty(json("spelldash_growth_log", [])) ||
    nonEmpty(json("spelldash_daily_set", {}).history ?? [])
  );
}

let syncInFlight = false; // 同じページで 2 回走らせない（auth-ready と SIGNED_IN が続けて来る）

export async function initialSync() {
  if (syncInFlight) return false;
  syncInFlight = true;
  try {
    return await runInitialSyncOnce();
  } finally {
    syncInFlight = false;
  }
}

async function runInitialSyncOnce() {
  const userId = await getUserId();
  if (!userId) return false;
  // このタブで最後まで済んでいれば何もしない（途中でページを移った場合は最初からやり直す）
  if (sessionStorage.getItem(DONE_FLAG) === userId) return false;

  // 端末の持ち主: 別のアカウントの記録が残っていたら混ぜない（会社の PC などの共用端末）
  const owner = localStorage.getItem(OWNER_KEY);
  let cleared = false;
  if (owner && owner !== userId) {
    if (hasPersonalRecords()) {
      if (!window.confirm(OWNER_CONFIRM_TEXT)) return "cancelled";
      cleared = true;
    }
    // 記録が無くても、前の持ち主の残り（基準の XP・設定以外のキー）は混ぜない
    clearLocalRecords();
  }

  sessionStorage.setItem(SYNCED_FLAG, userId);
  sessionStorage.removeItem(PULLED_FLAG);

  const [wordResult, progressResult] = await Promise.all([
    supabase.from("word_progress").select("*"),
    supabase.from("user_progress").select("*").maybeSingle()
  ]);

  // どちらかの取得に失敗したらフラグを戻して次回再試行（データを壊さない。user_progress の上書きにも進まない）
  if (wordResult.error || progressResult.error) {
    sessionStorage.removeItem(SYNCED_FLAG);
    const error = wordResult.error || progressResult.error;
    throw new Error(`sync pull failed: ${error?.message ?? error}`);
  }

  const cloudRows = wordResult.data;
  const cloudProgress = progressResult.data;

  const local = getWordStats();
  // 学習記録の無い端末（2 台目の初回・置き換えた直後）。現在地（コース）をクラウドから採る
  const freshDevice = Object.keys(local).length === 0;
  const cloudMap = new Map((cloudRows ?? []).map((row) => [row.word_id, row]));

  let changedLocal = cleared;
  const toUpload = [];
  const merged = { ...local };

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
      // ローカルだけにある拡張フィールド（history / knownOnSight / lastReviewResult 等）は残す
      merged[wordId] = { ...l, ...rowToStat(c, l), ...recallFields };
      changedLocal = true;
    }
  }

  if (changedLocal) {
    saveWordStats(merged);
  }
  // 別の端末の記録で 30 語以上になった人は「以前から使っている人」（同期より先に描いた画面が解放を "0" で保存していても直す）。
  // この端末だけで 30 語に達した新しい人は、従来どおりセット数で解放（js/unlocks.js）
  if (freshDevice) markVeteranIfReturning(Object.keys(merged).length);

  if (toUpload.length > 0) {
    // 一度に送りすぎないよう分割
    for (let i = 0; i < toUpload.length; i += 500) {
      await supabase.from("word_progress").upsert(toUpload.slice(i, i + 500));
    }
  }

  // user_progress のマージ（XP は 2 台で増えた分を足す・ベスト・最長ストリークは大きい方を採用）
  if (cloudProgress) {
    const localXp = getTotalXp();
    const cloudXp = Number(cloudProgress.xp) || 0;
    // 初回（基準なし）は大きい方。基準があれば「クラウドの値（か基準）＋この端末で基準から増えた分」
    const mergedXp = mergeXp(cloudXp, localXp);
    if (mergedXp !== localXp) {
      localStorage.setItem(XP_KEY, String(mergedXp));
      changedLocal = true;
    }
    localStorage.setItem(XP_SYNCED_KEY, String(mergedXp));

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
  const items = await pullUserItems(supabase, userId, { deferPacksEvent: true });
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
      // コースに無いパック（分野パック 1 本が道）: コースは外してカテゴリだけ
      localStorage.removeItem(COURSE_KEY);
      localStorage.setItem(CATEGORY_KEY, adoptCategory);
    }
    packAdded = getEnabledPackIds().some((id) => !packsBefore.includes(id));
    if (packAdded || placeBefore !== `${localStorage.getItem(COURSE_KEY)}|${localStorage.getItem(CATEGORY_KEY)}`) changedLocal = true;
  } else if (cleared) {
    ensureDefaultCourse(); // 置き換えでコースが消え、クラウドにも選択が無い（新しいアカウント）とき
  }

  // 取り込み（語・進捗・項目・現在地）はここまで。以降は送ってよい（pagehide の pushSync もここから効く）
  sessionStorage.setItem(PULLED_FLAG, userId);

  // 現在の値を送る（取り込みが済んだので、クラウドを空の値で上書きすることはない）
  await pushUserProgress(userId);
  await ensureProfile(userId);

  saveDirtyWords(new Set());
  localStorage.setItem(OWNER_KEY, userId);
  sessionStorage.setItem(DONE_FLAG, userId);

  // 追加したパックが変わったら、語の読み直しが終わるまで待ってから再描画を促す（読み直し前の語で数えないため）
  if (itemChanged?.pack || packAdded || cleared) {
    await reloadWordsAndWait();
  }

  if (changedLocal) {
    // 各ページに再描画を促す
    window.dispatchEvent(new CustomEvent("spelldash:synced"));
    return "changed";
  }

  return "same";
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
async function ensureProfile(userId) {
  const { data: existing } = await supabase
    .from("profiles")
    .select("user_id")
    .maybeSingle();

  if (existing) return;

  const { data } = await supabase.auth.getSession();
  const user = data.session?.user;
  const meta = user?.user_metadata ?? {};
  const audio = JSON.parse(localStorage.getItem("spelldash_audio") || "{}");

  await supabase.from("profiles").insert({
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
    pushSync();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      pushSync();
    }
  });
}
