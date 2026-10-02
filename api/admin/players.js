// ===== プレイヤー一覧（創業者専用の CRM、Vercel Serverless Function） =====
//
// GET /api/admin/players
//   Authorization: Bearer <Supabase アクセストークン>（ADMIN_EMAILS / ADMIN_USER_IDS の人だけ）
// → tests/fixtures/admin-players.json と同じ形
//
// 集計の元:
//   - Supabase Auth admin API（全ページ）: userId / email / createdAt / lastSignInAt
//   - RPC admin_player_summary があればそれ（docs/SQL_CRM.md）、無ければ
//     profiles / user_progress / activity_days / word_progress を REST で全件取って同じ値を出す
//   - user_items（pack）/ feedback / crm_notes は無ければ空として扱い、missing[] に名前を入れる
// 必要な環境変数: SUPABASE_SERVICE_ROLE_KEY, ADMIN_EMAILS（または ADMIN_USER_IDS）。無ければ 503。

import { send } from "../_lib/shared.js";
import {
  handleAdmin,
  allOrThrow,
  restAll,
  restOptional,
  rpcAllOrNull,
  listAuthUsers,
  jstToday,
  addDays,
  isDay,
  segmentOf,
  isNewSince,
  toInt,
  jsonNumber,
  textOrNull,
  noteText,
  tagList,
  sortTexts
} from "../_lib/admin.js";

const RPC_NAME = "admin_player_summary";
const SEGMENTS = ["active", "atRisk", "churned", "dormant"];
const OPTIONAL_ORDER = ["feedback", "user_items", "crm_notes"];

function emptyStats() {
  return {
    displayName: null,
    xp: 0,
    level: 1,
    streakCurrent: 0,
    streakBest: 0,
    lastActiveDay: null,
    activeDays7: 0,
    activeDays30: 0,
    studyCorrect30: 0,
    dailyDone30: 0,
    battleRuns30: 0,
    wordsPlayed: 0,
    wordsMastered: 0
  };
}

function statsFor(map, userId) {
  let stats = map.get(userId);
  if (!stats) {
    stats = emptyStats();
    map.set(userId, stats);
  }
  return stats;
}

// --- 速い道: RPC が 1 行ずつ user_id ごとの集計を返す ---
async function statsViaRpc(today) {
  const rows = await rpcAllOrNull(RPC_NAME, { p_today: today });
  if (!rows) return null;
  const map = new Map();
  for (const row of rows) {
    if (typeof row?.user_id !== "string") continue;
    map.set(row.user_id, {
      displayName: textOrNull(row.display_name),
      xp: toInt(row.xp),
      level: toInt(row.level, 1),
      streakCurrent: toInt(row.streak_current),
      streakBest: toInt(row.streak_best),
      lastActiveDay: isDay(row.last_active_day) ? row.last_active_day : null,
      activeDays7: toInt(row.active_days7),
      activeDays30: toInt(row.active_days30),
      studyCorrect30: toInt(row.study_correct30),
      dailyDone30: toInt(row.daily_done30),
      battleRuns30: toInt(row.battle_runs30),
      wordsPlayed: toInt(row.words_played),
      wordsMastered: toInt(row.words_mastered)
    });
  }
  return map;
}

// --- 通常の道: 4 テーブルを全件取って JS で集計（RPC と同じ定義） ---
async function statsViaTables(today) {
  const [profiles, progress, activity, words] = await allOrThrow([
    restAll("profiles", "select=user_id,display_name&order=user_id"),
    restAll("user_progress", "select=user_id,xp,level,streak&order=user_id"),
    restAll("activity_days", "select=user_id,day,study_correct,daily_done,battle_runs&order=user_id,day"),
    restAll("word_progress", "select=user_id,play_count,mastered&order=user_id,word_id")
  ]);
  const from7 = addDays(today, -6);
  const from30 = addDays(today, -29);
  const map = new Map();

  for (const row of profiles) {
    if (typeof row?.user_id !== "string") continue;
    statsFor(map, row.user_id).displayName = textOrNull(row.display_name);
  }
  for (const row of progress) {
    if (typeof row?.user_id !== "string") continue;
    const stats = statsFor(map, row.user_id);
    stats.xp = toInt(row.xp);
    stats.level = toInt(row.level, 1);
    stats.streakCurrent = jsonNumber(row.streak?.current);
    stats.streakBest = jsonNumber(row.streak?.best);
  }
  for (const row of activity) {
    if (typeof row?.user_id !== "string" || !isDay(row.day)) continue;
    const stats = statsFor(map, row.user_id);
    if (!stats.lastActiveDay || row.day > stats.lastActiveDay) stats.lastActiveDay = row.day;
    if (row.day >= from7) stats.activeDays7 += 1;
    if (row.day >= from30) {
      stats.activeDays30 += 1;
      stats.studyCorrect30 += toInt(row.study_correct);
      if (row.daily_done === true) stats.dailyDone30 += 1;
      stats.battleRuns30 += toInt(row.battle_runs);
    }
  }
  for (const row of words) {
    if (typeof row?.user_id !== "string") continue;
    const stats = statsFor(map, row.user_id);
    if (toInt(row.play_count) > 0) stats.wordsPlayed += 1;
    if (row.mastered === true) stats.wordsMastered += 1;
  }
  return map;
}

async function loadStats(today) {
  return (await statsViaRpc(today)) || statsViaTables(today);
}

// --- 無いかもしれない 3 テーブル ---
async function loadOptional() {
  const [items, feedback, notes] = await allOrThrow([
    restOptional("user_items", "select=user_id,key&kind=eq.pack&deleted=is.false&order=user_id,key"),
    restOptional("feedback", "select=user_id&user_id=not.is.null&order=id"),
    restOptional("crm_notes", "select=user_id,note,tags,pinned&order=user_id")
  ]);
  const packs = new Map();
  for (const row of items.rows) {
    if (typeof row?.user_id !== "string" || typeof row.key !== "string") continue;
    if (!packs.has(row.user_id)) packs.set(row.user_id, []);
    packs.get(row.user_id).push(row.key);
  }
  const feedbackCount = new Map();
  for (const row of feedback.rows) {
    if (typeof row?.user_id !== "string") continue;
    feedbackCount.set(row.user_id, (feedbackCount.get(row.user_id) || 0) + 1);
  }
  const noteRows = new Map();
  for (const row of notes.rows) {
    if (typeof row?.user_id !== "string") continue;
    noteRows.set(row.user_id, row);
  }
  const missingSet = new Set();
  if (feedback.missing) missingSet.add("feedback");
  if (items.missing) missingSet.add("user_items");
  if (notes.missing) missingSet.add("crm_notes");
  return { packs, feedbackCount, noteRows, missing: OPTIONAL_ORDER.filter((name) => missingSet.has(name)) };
}

function comparePlayers(a, b) {
  // 最終活動が新しい順（無しは最後）→ 登録が新しい順 → id
  if (a.lastActiveDay !== b.lastActiveDay) {
    if (!a.lastActiveDay) return 1;
    if (!b.lastActiveDay) return -1;
    return a.lastActiveDay < b.lastActiveDay ? 1 : -1;
  }
  const ca = String(a.createdAt || "");
  const cb = String(b.createdAt || "");
  if (ca !== cb) return ca < cb ? 1 : -1;
  return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
}

export default async function handler(req, res) {
  await handleAdmin(req, res, { method: "GET", label: "players" }, async () => {
    const today = jstToday();
    const [users, optional, stats] = await allOrThrow([listAuthUsers(), loadOptional(), loadStats(today)]);

    const players = [];
    for (const user of users) {
      if (typeof user?.id !== "string") continue;
      const s = stats.get(user.id) || emptyStats();
      const note = optional.noteRows.get(user.id);
      players.push({
        userId: user.id,
        email: typeof user.email === "string" ? user.email : "",
        displayName: s.displayName,
        createdAt: user.created_at || null,
        lastSignInAt: user.last_sign_in_at || null,
        lastActiveDay: s.lastActiveDay,
        activeDays7: s.activeDays7,
        activeDays30: s.activeDays30,
        studyCorrect30: s.studyCorrect30,
        dailyDone30: s.dailyDone30,
        battleRuns30: s.battleRuns30,
        xp: s.xp,
        level: s.level,
        streakCurrent: s.streakCurrent,
        streakBest: s.streakBest,
        wordsPlayed: s.wordsPlayed,
        wordsMastered: s.wordsMastered,
        packs: sortTexts(optional.packs.get(user.id) || []),
        feedbackCount: optional.feedbackCount.get(user.id) || 0,
        segment: segmentOf(today, s.lastActiveDay),
        isNew: isNewSince(today, user.created_at),
        tags: tagList(note?.tags),
        note: noteText(note?.note),
        pinned: note?.pinned === true
      });
    }
    players.sort(comparePlayers);

    const bySegment = Object.fromEntries(SEGMENTS.map((name) => [name, 0]));
    let newThisWeek = 0;
    for (const player of players) {
      bySegment[player.segment] += 1;
      if (player.isNew) newThisWeek += 1;
    }

    return send(res, 200, {
      generatedAt: new Date(Date.now()).toISOString(),
      today,
      missing: optional.missing,
      summary: { total: players.length, bySegment, newThisWeek },
      players
    });
  });
}
