// ===== プレイヤー詳細（創業者専用の CRM、Vercel Serverless Function） =====
//
// GET /api/admin/player?userId=<uuid>
//   Authorization: Bearer <Supabase アクセストークン>（ADMIN_EMAILS / ADMIN_USER_IDS の人だけ）
// → tests/fixtures/admin-player.json と同じ形
//   activityDays: 直近 90 日・日付降順 / playSessions・battleSessions・dailyScores: 最新 10 件
//   recentMastered: mastered_at 降順 20 件 / feedback: そのユーザーの全件（新しい順）
// userId が UUID でなければ 400、該当ユーザーが居なければ 404。

import { send } from "../_lib/shared.js";
import {
  handleAdmin,
  allOrThrow,
  restAll,
  restGet,
  restOptional,
  getAuthUser,
  queryParam,
  isUuid,
  isDay,
  jstToday,
  addDays,
  segmentOf,
  isNewSince,
  toInt,
  jsonNumber,
  numberOrNull,
  textOrNull,
  noteText,
  tagList,
  sortTexts,
  MESSAGES
} from "../_lib/admin.js";

function text(value) {
  return typeof value === "string" ? value : "";
}

export default async function handler(req, res) {
  await handleAdmin(req, res, { method: "GET", label: "player" }, async () => {
    const userId = String(queryParam(req, "userId") || "").trim();
    if (!isUuid(userId)) return send(res, 400, { error: "bad_request", message: MESSAGES.badUserId });

    const user = await getAuthUser(userId);
    if (!user) return send(res, 404, { error: "not_found", message: MESSAGES.notFound });

    const today = jstToday();
    const from90 = addDays(today, -89);
    const own = `user_id=eq.${userId}`;

    const [profile, progress, lastDay, activity, words, mastered, plays, battles, daily, packs, feedback, notes] =
      await allOrThrow([
        restGet("profiles", `select=display_name&${own}&limit=1`),
        restGet("user_progress", `select=xp,level,streak&${own}&limit=1`),
        restGet("activity_days", `select=day&${own}&order=day.desc&limit=1`),
        restAll("activity_days", `select=day,study_correct,challenge_runs,daily_done,battle_runs&${own}&day=gte.${from90}&order=day.desc`),
        restAll("word_progress", `select=play_count,mastered&${own}&order=word_id`),
        restGet("word_progress", `select=word_id,mastered_at&${own}&mastered=is.true&order=mastered_at.desc.nullslast&limit=20`),
        restGet("play_sessions", `select=mode,score,typing_speed,typing_miss,recall_fail,duration_seconds,played_at&${own}&order=played_at.desc&limit=10`),
        restGet(
          "battle_sessions",
          `select=opponent_type,opponent_name,category,result,player_score,opponent_score,rp_change,correct_count,duration_seconds,played_at&${own}&order=played_at.desc&limit=10`
        ),
        restGet("daily_scores", `select=day,score,typing_speed&${own}&order=day.desc&limit=10`),
        restOptional("user_items", `select=key&${own}&kind=eq.pack&deleted=is.false`),
        restOptional("feedback", `select=id,message,contact,page,created_at&${own}&order=created_at.desc`),
        restOptional("crm_notes", `select=note,tags,pinned&${own}&limit=1`, { all: false })
      ]);

    const streak = progress[0]?.streak;
    const lastActiveDay = isDay(lastDay[0]?.day) ? lastDay[0].day : null;
    const note = notes.rows[0];

    const activityDays = activity
      .filter((row) => isDay(row?.day))
      .map((row) => ({
        day: row.day,
        studyCorrect: toInt(row.study_correct),
        challengeRuns: toInt(row.challenge_runs),
        dailyDone: row.daily_done === true,
        battleRuns: toInt(row.battle_runs)
      }))
      .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));

    let wordsPlayed = 0;
    let wordsMastered = 0;
    for (const row of words) {
      if (toInt(row?.play_count) > 0) wordsPlayed += 1;
      if (row?.mastered === true) wordsMastered += 1;
    }

    return send(res, 200, {
      userId: user.id,
      email: text(user.email),
      displayName: textOrNull(profile[0]?.display_name),
      createdAt: user.created_at || null,
      lastSignInAt: user.last_sign_in_at || null,
      segment: segmentOf(today, lastActiveDay),
      isNew: isNewSince(today, user.created_at),
      xp: toInt(progress[0]?.xp),
      level: toInt(progress[0]?.level, 1),
      streakCurrent: jsonNumber(streak?.current),
      streakBest: jsonNumber(streak?.best),
      wordsPlayed,
      wordsMastered,
      packs: sortTexts(packs.rows.map((row) => row?.key).filter((key) => typeof key === "string")),
      activityDays,
      playSessions: plays.map((row) => ({
        mode: text(row?.mode),
        score: toInt(row?.score),
        typingSpeed: numberOrNull(row?.typing_speed),
        typingMiss: toInt(row?.typing_miss),
        recallFail: toInt(row?.recall_fail),
        durationSeconds: numberOrNull(row?.duration_seconds),
        playedAt: row?.played_at || null
      })),
      battleSessions: battles.map((row) => ({
        opponentType: text(row?.opponent_type),
        opponentName: textOrNull(row?.opponent_name),
        category: textOrNull(row?.category),
        result: text(row?.result),
        playerScore: toInt(row?.player_score),
        opponentScore: toInt(row?.opponent_score),
        rpChange: numberOrNull(row?.rp_change),
        correctCount: toInt(row?.correct_count),
        durationSeconds: numberOrNull(row?.duration_seconds),
        playedAt: row?.played_at || null
      })),
      dailyScores: daily.map((row) => ({
        day: text(row?.day),
        score: toInt(row?.score),
        typingSpeed: numberOrNull(row?.typing_speed)
      })),
      recentMastered: mastered.map((row) => ({
        wordId: text(row?.word_id),
        masteredAt: row?.mastered_at || null
      })),
      feedback: feedback.rows.map((row) => ({
        id: row?.id ?? null,
        message: text(row?.message),
        contact: text(row?.contact),
        page: text(row?.page),
        createdAt: row?.created_at || null
      })),
      tags: tagList(note?.tags),
      note: noteText(note?.note),
      pinned: note?.pinned === true
    });
  });
}
