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
  { level: 50, name: "伝説のスペルダッシャー" }
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

function todayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function yesterdayString() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function getStreak() {
  const data = JSON.parse(localStorage.getItem(STREAK_KEY)) || {
    last: null,
    current: 0,
    best: 0
  };

  // 昨日までにプレイが途切れていたら、表示上は0に戻す
  if (data.last !== todayString() && data.last !== yesterdayString()) {
    return { ...data, current: data.last ? 0 : data.current };
  }

  return data;
}

// ゲーム終了時に呼ぶ。今日最初のプレイかどうかを返す
export function updateStreak() {
  const data = JSON.parse(localStorage.getItem(STREAK_KEY)) || {
    last: null,
    current: 0,
    best: 0
  };
  const today = todayString();

  if (data.last === today) {
    return { ...data, isFirstToday: false };
  }

  const current = data.last === yesterdayString() ? data.current + 1 : 1;
  const best = Math.max(current, data.best);
  const updated = { last: today, current, best };

  localStorage.setItem(STREAK_KEY, JSON.stringify(updated));

  return { ...updated, isFirstToday: true };
}
