const XP_KEY = "spelldash_xp";
const STREAK_KEY = "spelldash_streak";

// レベルごとの称号（そのレベル以上で最後に到達したものが付く）
const TITLES = [
  { level: 1, name: "見習いタイピスト" },
  { level: 3, name: "駆け出しスペラー" },
  { level: 5, name: "単語コレクター" },
  { level: 8, name: "単語ハンター" },
  { level: 12, name: "スペルの旅人" },
  { level: 16, name: "タイピング職人" },
  { level: 20, name: "コンボアーティスト" },
  { level: 25, name: "単語マスター" },
  { level: 30, name: "スペルの賢者" },
  { level: 40, name: "疾風のタイピスト" },
  { level: 50, name: "伝説のスペルダッシャー" },
  { level: 60, name: "単語の覇者" },
  { level: 70, name: "記憶の錬金術師" },
  { level: 80, name: "語彙の巨人" },
  { level: 90, name: "スペルの神域" },
  { level: 100, name: "SpellDash マスター" }
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

// XPを加算し、加算前後のレベル状態を返す（レベルアップ検知用）
export function addXp(amount) {
  const before = getLevelState();
  const total = before.totalXp + Math.max(0, Math.round(amount));
  localStorage.setItem(XP_KEY, String(total));
  const after = getLevelState(total);

  return { before, after, gained: amount, leveledUp: after.level > before.level };
}

// ===== 連続プレイ日数（ストリーク） =====
// シールド: 5日連続ごとに1枚獲得（最大2枚）。
// 1日休んでも、次に開いたときにシールドが自動で消費されて連続記録を守る。

export const SHIELD_EARN_EVERY = 5;
export const SHIELD_MAX = 2;

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

function loadStreak() {
  const data = JSON.parse(localStorage.getItem(STREAK_KEY)) || {};
  return { last: null, current: 0, best: 0, shields: 0, shieldSavedOn: null, ...data };
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

  const current = data.last === yesterdayString() ? data.current + 1 : 1;
  const best = Math.max(current, data.best);

  // 節目（5日ごと）でシールドを獲得。途切れてもシールドは失わない
  let shields = data.shields;
  let earnedShield = false;
  if (current % SHIELD_EARN_EVERY === 0 && shields < SHIELD_MAX) {
    shields++;
    earnedShield = true;
  }

  const updated = { last: today, current, best, shields, shieldSavedOn: data.shieldSavedOn };
  localStorage.setItem(STREAK_KEY, JSON.stringify(updated));

  return { ...updated, isFirstToday: true, earnedShield };
}
