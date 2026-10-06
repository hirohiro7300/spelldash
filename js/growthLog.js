import { localDateString } from "./stats.js";
import { touchItem } from "./userItemsSync.js";

// ===== 成長ログ =====
// 1日1行 {date, learned, mastered, active} を端末に残し、
// 「今週 +N語」「30日の推移」「学習日数 x/7」の材料にする（最大120日）。
// 学習記録そのものではなく派生値のスナップショット。失っても学習には影響しない。
// ログイン中は 1 日分を user_items の day 項目として端末間で合わせる（js/userItemsSync.js。変わった日だけ touchItem）。

const KEY = "spelldash_growth_log";
const MAX_DAYS = 120;

export function getGrowthLog() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function save(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX_DAYS)));
  } catch {
    // 端末容量等で失敗しても学習は止めない
  }
}

// 今日の行を最新値で上書き（無ければ追加）。active は一度trueになったら保持
// v2（2026-10）: learned は「覚えた語の数」（パックの語も含む、js/learnedWords.js getLearnedCount）。
// それ以前の行は基本カテゴリだけの数だったので、最初の v2 を書くときに legacyLearned（同じ日の旧式の数）との差で
// 古い行を底上げし、推移が段差にならないようにする（近似。失っても学習には影響しない）
// legacyLearned は数でも関数でもよい（旧式の数は v1 の行を直す初回だけ要るので、関数なら必要なときだけ呼ぶ）
export function recordGrowthSnapshot({ learned, mastered, active = false, legacyLearned = null }) {
  const list = getGrowthLog();
  const today = localDateString();
  const legacy = list.length > 0 && !list.some((e) => e.v === 2) ? (typeof legacyLearned === "function" ? legacyLearned() : legacyLearned) : null;
  if (legacy != null) {
    const offset = learned - legacy;
    if (offset !== 0) for (const e of list) e.learned = Math.max(0, (e.learned ?? 0) + offset);
  }
  const idx = list.findIndex((e) => e.date === today);
  const prev = idx >= 0 ? list[idx] : null;
  const row = { date: today, learned, mastered, active: !!(prev?.active || active), v: 2 };
  if (idx >= 0) list[idx] = row;
  else list.push(row);
  list.sort((a, b) => (a.date < b.date ? -1 : 1));
  save(list);
  // 描画のたびに呼ばれるので、今日の行の値が変わったとき（または旧式の行を直したとき）だけ同期の印を付ける
  if (legacy != null || !prev || prev.learned !== row.learned || prev.mastered !== row.mastered || !!prev.active !== row.active) touchItem("day", today);
  return row;
}

export function markActiveToday() {
  const list = getGrowthLog();
  const today = localDateString();
  const idx = list.findIndex((e) => e.date === today);
  if (idx >= 0) {
    if (!list[idx].active) {
      list[idx].active = true;
      save(list);
      touchItem("day", today);
    }
    return;
  }
  const last = list[list.length - 1];
  list.push({ date: today, learned: last?.learned ?? 0, mastered: last?.mastered ?? 0, active: true, v: last?.v });
  save(list);
  touchItem("day", today);
}

function dateKeyDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return localDateString(d);
}

// ===== 週の学習日目標（月曜始まり） =====
// 「毎日」ではなく「週○日」を目標にする（罪悪感なしで続く設計）。既定4日
const WEEK_GOAL_KEY = "spelldash_week_goal";
export const WEEK_GOAL_OPTIONS = [3, 4, 5, 7];

export function getWeekGoal() {
  const v = Number(localStorage.getItem(WEEK_GOAL_KEY));
  return WEEK_GOAL_OPTIONS.includes(v) ? v : 4;
}

export function setWeekGoal(v) {
  if (WEEK_GOAL_OPTIONS.includes(Number(v))) localStorage.setItem(WEEK_GOAL_KEY, String(v));
}

// 今週（月〜日）の各日 {date, active, isToday, isFuture}
export function getThisWeekDays() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = (today.getDay() + 6) % 7; // 月曜=0
  const active = new Set(getGrowthLog().filter((e) => e.active).map((e) => e.date));
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - dow + i);
    const key = localDateString(d);
    days.push({ date: key, active: active.has(key), isToday: i === dow, isFuture: i > dow });
  }
  return days;
}

export function getActiveDaysThisWeek() {
  return getThisWeekDays().filter((d) => d.active).length;
}

// 直近7日で「学習した日」の数
export function getActiveDaysLast7(endOffset = 0) {
  // endOffset=1 なら「昨日までの 7 日」
  const since = dateKeyDaysAgo(6 + endOffset);
  const until = dateKeyDaysAgo(endOffset);
  return getGrowthLog().filter((e) => e.active && e.date >= since && e.date <= until).length;
}

// 直近7日の「覚えた」増分（7日前時点の値との差。基準が無ければ最古の行）
// endOffset=1 なら「昨日までの 7 日」（週間レポートの窓と合わせる）
export function getLearnedDelta7(currentLearned, endOffset = 0) {
  const log = getGrowthLog();
  if (log.length === 0) return 0;
  const latestOnOrBefore = (key) => [...log].reverse().find((e) => e.date <= key);
  const baseline = latestOnOrBefore(dateKeyDaysAgo(7 + endOffset)) ?? log[0];
  // 窓の終わりが昨日なら「昨日時点の値」から引く（今日の分は窓の外）。記録が無ければ今の値
  const current = endOffset > 0 ? (latestOnOrBefore(dateKeyDaysAgo(endOffset))?.learned ?? currentLearned) : currentLearned;
  return Math.max(0, current - (baseline.learned ?? 0));
}

// 直近N日の系列（欠損日は直前の値で埋める）
export function getLearnedSeries(days = 30) {
  const log = getGrowthLog();
  const byDate = new Map(log.map((e) => [e.date, e]));
  const series = [];
  let lastLearned = null;
  for (let i = days - 1; i >= 0; i--) {
    const key = dateKeyDaysAgo(i);
    const row = byDate.get(key);
    if (row) lastLearned = row.learned;
    series.push({ date: key, learned: lastLearned, active: !!row?.active });
  }
  // 先頭の欠損は最初の実測値より前なので、それ以前の実測が無い限りnullのまま
  return series;
}
