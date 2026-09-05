import { localDateString } from "./stats.js";

// ===== 成長ログ =====
// 1日1行 {date, learned, mastered, active} を端末に残し、
// 「今週 +N語」「30日の推移」「学習日数 x/7」の材料にする（最大120日）。
// 学習記録そのものではなく派生値のスナップショット。失っても学習には影響しない。

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
export function recordGrowthSnapshot({ learned, mastered, active = false }) {
  const list = getGrowthLog();
  const today = localDateString();
  const idx = list.findIndex((e) => e.date === today);
  const prev = idx >= 0 ? list[idx] : null;
  const row = { date: today, learned, mastered, active: !!(prev?.active || active) };
  if (idx >= 0) list[idx] = row;
  else list.push(row);
  list.sort((a, b) => (a.date < b.date ? -1 : 1));
  save(list);
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
    }
    return;
  }
  const last = list[list.length - 1];
  list.push({ date: today, learned: last?.learned ?? 0, mastered: last?.mastered ?? 0, active: true });
  save(list);
}

function dateKeyDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return localDateString(d);
}

// 直近7日で「学習した日」の数
export function getActiveDaysLast7() {
  const since = dateKeyDaysAgo(6);
  return getGrowthLog().filter((e) => e.active && e.date >= since).length;
}

// 直近7日の「覚えた」増分（7日前時点の値との差。基準が無ければ最古の行）
export function getLearnedDelta7(currentLearned) {
  const log = getGrowthLog();
  if (log.length === 0) return 0;
  const cutoff = dateKeyDaysAgo(7);
  const baseline = [...log].reverse().find((e) => e.date <= cutoff) ?? log[0];
  return Math.max(0, currentLearned - (baseline.learned ?? 0));
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
