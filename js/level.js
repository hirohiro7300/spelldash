import { isPro } from "./plan.js";

const XP_KEY = "spelldash_xp";
const STREAK_KEY = "spelldash_streak";

// レベルごとのランク（そのレベル以上で最後に到達したものが付く）
// F3スタート → F2 → F1 → E3 → … → S1 → レジェンド。
// 序盤は1レベルごとに上がって「進んでる感」を作り、上位ほど1段が重くなる
const TITLES = [
  { level: 1, name: "F3" },
  { level: 2, name: "F2" },
  { level: 3, name: "F1" },
  { level: 5, name: "E3" },
  { level: 7, name: "E2" },
  { level: 9, name: "E1" },
  { level: 12, name: "D3" },
  { level: 15, name: "D2" },
  { level: 18, name: "D1" },
  { level: 22, name: "C3" },
  { level: 26, name: "C2" },
  { level: 30, name: "C1" },
  { level: 35, name: "B3" },
  { level: 40, name: "B2" },
  { level: 45, name: "B1" },
  { level: 51, name: "A3" },
  { level: 57, name: "A2" },
  { level: 63, name: "A1" },
  { level: 70, name: "S3" },
  { level: 77, name: "S2" },
  { level: 84, name: "S1" },
  { level: 92, name: "レジェンド" }
];

// レベルnからn+1に上がるのに必要なXP（少しずつ重くなる）
export function xpToNext(level) {
  return 100 + (level - 1) * 50;
}

export function getTotalXp() {
  return Number(localStorage.getItem(XP_KEY)) || 0;
}

export function getLevelState(totalXp = getTotalXp()) {
  let level = 1;
  let remaining = totalXp;

  while (remaining >= xpToNext(level)) {
    remaining -= xpToNext(level);
    level++;
  }

  return {
    level,
    title: getTitle(level),
    currentXp: remaining,
    neededXp: xpToNext(level),
    totalXp
  };
}

export function getTitle(level) {
  let title = TITLES[0].name;

  for (const entry of TITLES) {
    if (level >= entry.level) {
      title = entry.name;
    }
  }

  return title;
}

// 次に到達するランク（最上位到達済みならnull）
export function getNextTitle(level) {
  return TITLES.find((entry) => entry.level > level) ?? null;
}

// XPを加算し、加算前後のレベル状態を返す（レベルアップ検知用）
export function addXp(amount) {
  const before = getLevelState();
  const total = before.totalXp + Math.max(0, Math.round(amount));
  localStorage.setItem(XP_KEY, String(total));
  const after = getLevelState(total);

  return { before, after, gained: amount, leveledUp: after.level > before.level };
}

// ===== 連続プレイ日数（ストリーク） =====
// シールド: 5日連続ごとに1枚獲得（最大2枚。Pro は3枚）。
// 1日休んでも、次に開いたときにシールドが自動で消費されて連続記録を守る。
// 途切れたときは直前の連続日数を lost に残し、Pro は月1回・7日以内なら取り戻せる（repairStreak）。

export const SHIELD_EARN_EVERY = 5;
const REPAIR_WINDOW_DAYS = 7;

export function shieldMax() {
  return isPro() ? 3 : 2;
}

function todayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function yesterdayString() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// "YYYY-MM-DD" 同士の日数差（UTC解釈なので丸1日単位で正確）
function daysBetween(fromYmd, toYmd) {
  return Math.round((Date.parse(toYmd) - Date.parse(fromYmd)) / 86400000);
}

function monthString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function loadStreak() {
  const data = JSON.parse(localStorage.getItem(STREAK_KEY)) || {};
  return { last: null, current: 0, best: 0, shields: 0, shieldSavedOn: null, lost: null, repairedMonth: null, ...data };
}

// 空白日をシールドで埋める。守れたら last を昨日扱いにして連続記録を維持する。
// getStreak / updateStreak の前に必ず通す（消費は保存されるので二重消費しない）
function normalizeStreak() {
  const data = loadStreak();
  if (!data.last || data.current === 0) return data;

  const missedDays = daysBetween(data.last, todayString()) - 1;
  if (missedDays <= 0) return data;

  if (missedDays <= data.shields) {
    data.shields -= missedDays;
    data.last = yesterdayString();
    data.shieldSavedOn = todayString();
    localStorage.setItem(STREAK_KEY, JSON.stringify(data));
  }

  return data;
}

export function getStreak() {
  const data = normalizeStreak();

  // 昨日までにプレイが途切れていたら、表示上は0に戻す
  if (data.last !== todayString() && data.last !== yesterdayString()) {
    return { ...data, current: 0 };
  }

  return data;
}

export function hasPlayedToday() {
  return loadStreak().last === todayString();
}

// ゲーム終了時に呼ぶ。今日最初のプレイかどうか・シールド獲得を返す
export function updateStreak() {
  const data = normalizeStreak();
  const today = todayString();

  if (data.last === today) {
    return { ...data, isFirstToday: false, earnedShield: false };
  }

  const continued = data.last === yesterdayString();
  const current = continued ? data.current + 1 : 1;
  const best = Math.max(current, data.best);

  // 途切れた（昨日でも今日でもない）: 直前の連続日数を残す（修復用。1日だけなら残さない）
  let lost = data.lost ?? null;
  if (!continued && data.last && data.current >= 2) {
    lost = { count: data.current, on: data.last };
  }

  // 節目（5日ごと）でシールドを獲得。途切れてもシールドは失わない
  let shields = data.shields;
  let earnedShield = false;
  if (current % SHIELD_EARN_EVERY === 0 && shields < shieldMax()) {
    shields++;
    earnedShield = true;
  }

  const updated = { last: today, current, best, shields, shieldSavedOn: data.shieldSavedOn, lost, repairedMonth: data.repairedMonth ?? null };
  localStorage.setItem(STREAK_KEY, JSON.stringify(updated));

  return { ...updated, isFirstToday: true, earnedShield };
}

// ===== 連続記録の修復（Pro・月1回・途切れてから7日以内） =====

// 7日以内に途切れた記録 { count, on } があれば返す。無ければ null。
// まだ updateStreak() が走っていない（途切れたまま開いただけ）でも、保存値から同じものを組み立てる
export function getLostStreak() {
  const data = normalizeStreak();
  const today = todayString();
  let lost = data.lost ?? null;
  if (!lost && data.last && data.current >= 2 && data.last !== today && data.last !== yesterdayString()) {
    lost = { count: data.current, on: data.last };
  }
  if (!lost || !lost.on || !(lost.count >= 2)) return null;
  const days = daysBetween(lost.on, today);
  if (!(days >= 0 && days <= REPAIR_WINDOW_DAYS)) return null;
  return { count: lost.count, on: lost.on };
}

export function canRepairStreak() {
  if (!isPro()) return false;
  const lost = getLostStreak();
  if (!lost) return false;
  return loadStreak().repairedMonth !== monthString();
}

// 直前の連続日数に戻す。今日すでにプレイしていれば +1。last はそのまま（今日未プレイなら昨日扱いで続く）
export function repairStreak() {
  if (!canRepairStreak()) return { ok: false, current: getStreak().current };
  const lost = getLostStreak();
  const data = loadStreak();
  const today = todayString();
  // 途切れたあとに積み直した日数（今日・昨日から続いているぶん）は失わず、その上に前の連続を戻す
  const rebuilt = data.last === today || data.last === yesterdayString() ? data.current : 0;
  const current = lost.count + rebuilt;
  // 積み直しが無ければ、昨日まで続いていたことにして次のプレイで +1 される
  const last = rebuilt > 0 ? data.last : yesterdayString();
  const updated = {
    ...data,
    last,
    current,
    best: Math.max(current, data.best ?? 0),
    repairedMonth: monthString(),
    lost: null
  };
  localStorage.setItem(STREAK_KEY, JSON.stringify(updated));
  return { ok: true, current };
}
