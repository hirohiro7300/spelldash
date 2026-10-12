import { localDateString } from "./stats.js";
import { bumpTotalSets } from "./unlocks.js";
import { touchItem } from "./userItemsSync.js";

// ===== 今日のセット（Daily Set） =====
//
// 「N語を自力で思い出せたら今日のぶん完了」。無限に続くStudyに終わりを作り、
// 「今日やることを決めてくれて5分で終わる」体験の中核にする。
// 長さは設定（10/15/25 語・60 秒、標準 15 語）。完了日は端末に記録して7日ドットに使う。
// 60 秒は今日のセットの長さの 1 つ（入口・出題・記録は Study のまま。js/game.js の runKind "timed"。docs/SPEC_MASTERY.md §4）。
// ログイン中は完了日と今日のセット数を user_items の day 項目で端末間に合わせる（js/userItemsSync.js）。

const SIZE_KEY = "spelldash_set_size";
const STATE_KEY = "spelldash_daily_set";
export const SET_SIZES = [10, 15, 25];
export const SET_LENGTHS = ["10", "15", "25", "60s"]; // 保存値（spelldash_set_size）。"60s" = 60 秒で区切る
const TIMED = "60s";

// デバッグ用: ?set=2 でセット語数を上書き（E2E・動作確認用。?t= と同じ流儀）。?set=60s で 60 秒の回。
// 数の ?set=N は保存値の "60s" に勝つ（E2E の ?set=2／3／5 に 60 秒が混ざらない）
const setParam = new URLSearchParams(location.search).get("set");
const sizeOverride = Number(setParam) || null;
const timedOverride = setParam === TIMED;

function savedLength() {
  try {
    const v = localStorage.getItem(SIZE_KEY);
    return SET_LENGTHS.includes(v) ? v : "15";
  } catch {
    return "15";
  }
}

// 設定の select（設定ページの #setSizeSelect・ホームの #setLengthSelect）の値: 保存値そのまま（不正な値は "15"）。URL の ?set= は見ない
export function getSetLength() {
  return savedLength();
}

// 今日のセットの長さが 60 秒か（URL の ?set=60s、または数の ?set= が無く保存値が "60s"）
export function isTimedSet() {
  if (timedOverride) return true;
  if (sizeOverride) return false;
  return savedLength() === TIMED;
}

// 語数（60 秒のときは 15 を返す: 今の呼び手を壊さない。古い版は Number("60s") が NaN で 15 語に戻る）
export function getSetSize() {
  if (sizeOverride) return sizeOverride;
  const saved = Number(savedLength());
  return SET_SIZES.includes(saved) ? saved : 15;
}

export function setSetSize(size) {
  const v = String(size);
  if (SET_LENGTHS.includes(v)) localStorage.setItem(SIZE_KEY, v);
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
  bumpTotalSets(); // 遊び方の解放（Daily・Battle）に使う累計
  touchItem("day", today);
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
