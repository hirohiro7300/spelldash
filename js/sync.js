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

// ===== Local First 同期 =====
// プレイ中は localStorage のみに書き、以下のタイミングでSupabaseへ同期する:
//   - Challenge終了時 / Studyで10語ごと / ページ離脱時 / ログイン直後（マージ）
// 毎入力での同期はしない。

const DIRTY_KEY = "spelldash_dirty_words";
const XP_KEY = "spelldash_xp";
const STREAK_KEY = "spelldash_streak";
const SYNCED_FLAG = "spelldash_synced_this_session"; // sessionStorage

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

export async function pushSync() {
  if (isPushing) return;

  const userId = await getUserId();
  if (!userId) return; // 未ログインなら何もしない（Local First）

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
    await flushPendingBattleSessions(userId);
  } finally {
    isPushing = false;
  }
}

async function pushUserProgress(userId) {
  const level = getLevelState();
  const battle = getBattleStore();

  await supabase.from("user_progress").upsert({
    user_id: userId,
    xp: getTotalXp(),
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

export async function initialSync() {
  if (sessionStorage.getItem(SYNCED_FLAG)) return false;

  const userId = await getUserId();
  if (!userId) return false;

  sessionStorage.setItem(SYNCED_FLAG, "1");

  const [wordResult, progressResult] = await Promise.all([
    supabase.from("word_progress").select("*"),
    supabase.from("user_progress").select("*").maybeSingle()
  ]);

  // 取得に失敗したらフラグを戻して次回再試行（データを壊さない）
  if (wordResult.error) {
    sessionStorage.removeItem(SYNCED_FLAG);
    throw new Error(`sync pull failed: ${wordResult.error.message}`);
  }

  const cloudRows = wordResult.data;
  const cloudProgress = progressResult.data;

  const local = getWordStats();
  const cloudMap = new Map((cloudRows ?? []).map((row) => [row.word_id, row]));

  let changedLocal = false;
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
      merged[wordId] = { ...rowToStat(c, l), ...recallFields };
      changedLocal = true;
    }
  }

  if (changedLocal) {
    saveWordStats(merged);
  }

  if (toUpload.length > 0) {
    // 一度に送りすぎないよう分割
    for (let i = 0; i < toUpload.length; i += 500) {
      await supabase.from("word_progress").upsert(toUpload.slice(i, i + 500));
    }
  }

  // user_progress のマージ（XP・ベスト・最長ストリークは大きい方を採用）
  if (cloudProgress) {
    const localXp = getTotalXp();
    if (cloudProgress.xp > localXp) {
      localStorage.setItem(XP_KEY, String(cloudProgress.xp));
      changedLocal = true;
    }

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
          shieldSavedOn: cloudStreak.shieldSavedOn ?? null
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

  await pushUserProgress(userId);
  await ensureProfile(userId);

  saveDirtyWords(new Set());

  if (changedLocal) {
    // 各ページに再描画を促す
    window.dispatchEvent(new CustomEvent("spelldash:synced"));
  }

  return true;
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
