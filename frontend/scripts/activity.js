// 日次アクティビティ（KPI計測の心拍）。
// ローカルで当日分をカウントし、同期時に activity_days へ1日1行 upsert する。
// 計測は装飾: 失敗してもゲームには一切影響させない（Local First）。

const ACTIVITY_KEY = "spelldash_activity";

function todayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function emptyDay() {
  return {
    date: todayString(),
    studyCorrect: 0,
    challengeRuns: 0,
    dailyDone: false,
    battleRuns: 0
  };
}

function load() {
  try {
    const data = JSON.parse(localStorage.getItem(ACTIVITY_KEY));
    if (data && data.date === todayString()) return { ...emptyDay(), ...data };
  } catch {
    // 壊れていたら作り直す
  }
  return emptyDay();
}

export function getTodayActivity() {
  return load();
}

// field: "studyCorrect" | "challengeRuns" | "battleRuns"
export function bumpActivity(field, amount = 1) {
  try {
    const data = load();
    data[field] = (data[field] ?? 0) + amount;
    localStorage.setItem(ACTIVITY_KEY, JSON.stringify(data));
  } catch {
    // 計測はゲームを止めない
  }
}

export function markDailyDone() {
  try {
    const data = load();
    data.dailyDone = true;
    localStorage.setItem(ACTIVITY_KEY, JSON.stringify(data));
  } catch {
    // 同上
  }
}

// sync.js から呼ばれる。upsert用の行データを返す（アクティビティゼロならnull）
export function buildActivityRow(userId) {
  const data = load();
  if (
    data.studyCorrect === 0 &&
    data.challengeRuns === 0 &&
    data.battleRuns === 0 &&
    !data.dailyDone
  ) {
    return null;
  }

  return {
    user_id: userId,
    day: data.date,
    study_correct: data.studyCorrect,
    challenge_runs: data.challengeRuns,
    daily_done: data.dailyDone,
    battle_runs: data.battleRuns,
    updated_at: new Date().toISOString()
  };
}
