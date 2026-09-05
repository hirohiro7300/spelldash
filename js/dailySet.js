import { localDateString } from "./stats.js";

// ===== 今日のセット（Daily Set） =====
//
// 「N語を自力で思い出せたら今日のぶん完了」。無限に続くStudyに終わりを作り、
// 「今日やることを決めてくれて5分で終わる」体験の中核にする。
// 語数は設定（10/15/25、標準15）。完了日は端末に記録して7日ドットに使う。

const SIZE_KEY = "spelldash_set_size";
const STATE_KEY = "spelldash_daily_set";
export const SET_SIZES = [10, 15, 25];

// デバッグ用: ?set=2 でセット語数を上書き（E2E・動作確認用。?t= と同じ流儀）
const sizeOverride = Number(new URLSearchParams(location.search).get("set")) || null;

export function getSetSize() {
  if (sizeOverride) return sizeOverride;
  const saved = Number(localStorage.getItem(SIZE_KEY));
  return SET_SIZES.includes(saved) ? saved : 15;
}

export function setSetSize(size) {
  if (SET_SIZES.includes(Number(size))) localStorage.setItem(SIZE_KEY, String(size));
}

function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem(STATE_KEY) || "{}");
    return { history: Array.isArray(raw.history) ? raw.history : [], last: raw.last ?? null, setsToday: raw.setsToday ?? 0, setsTodayDate: raw.setsTodayDate ?? null };
  } catch {
    return { history: [], last: null, setsToday: 0, setsTodayDate: null };
  }
}

function saveState(state) {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}

export function isDailySetDone(date = localDateString()) {
  return loadState().history.includes(date);
}

// 今日完了したセット数（「もう1セット」の回数表示用）
export function getSetsToday() {
  const s = loadState();
  return s.setsTodayDate === localDateString() ? s.setsToday : 0;
}

export function markDailySetDone(count) {
  const s = loadState();
  const today = localDateString();
  if (!s.history.includes(today)) s.history.push(today);
  s.history = s.history.slice(-60);
  s.setsToday = (s.setsTodayDate === today ? s.setsToday : 0) + 1;
  s.setsTodayDate = today;
  s.last = { date: today, count };
  saveState(s);
  return s;
}

// 直近7日（今日を右端）の完了ドット
export function getWeekDots() {
  const done = new Set(loadState().history);
  const dots = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = localDateString(d);
    dots.push({ date: key, done: done.has(key), isToday: i === 0 });
  }
  return dots;
}
