import { getAllWords } from "./wordStore.js";

// Daily Dash: 1日1回だけ挑戦できる60秒チャレンジ。
// 問題は日付シードで決定論的に生成されるため全ユーザー共通（将来のランキングの土台）。
// 「今日の分」という希少性が毎日開く理由を作る。

const DAILY_KEY = "spelldash_daily";
export const DAILY_WORD_COUNT = 40; // 60秒で尽きない数
export const DAILY_BONUS_XP = 30;

function todayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 文字列→32bitシード
function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

// シード付き乱数（mulberry32）。同じ日付なら誰の端末でも同じ列になる
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 今日の出題（カテゴリ横断・重複IDは1つ・固定順シャッフル）
export function getDailyWords(date = todayString()) {
  const seen = new Set();
  const pool = getAllWords().filter((word) => {
    if (seen.has(word.id)) return false;
    seen.add(word.id);
    return true;
  });

  // 読み込み順の環境差をなくすため、シャッフル前にID順で固定する
  pool.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const rand = mulberry32(hashSeed(`spelldash-daily-${date}`));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return pool.slice(0, DAILY_WORD_COUNT);
}

function loadDaily() {
  try {
    return JSON.parse(localStorage.getItem(DAILY_KEY)) || null;
  } catch {
    return null;
  }
}

export function getDailyState() {
  const data = loadDaily();
  if (!data || data.date !== todayString()) {
    return { date: todayString(), played: false };
  }
  return data;
}

export function isDailyPlayedToday() {
  return getDailyState().played === true;
}

// 完走時に呼ぶ（完走でその日はロック。中断はやり直し可）
export function recordDailyResult({ score, typingMiss, recallFail, speed }) {
  localStorage.setItem(
    DAILY_KEY,
    JSON.stringify({
      date: todayString(),
      played: true,
      score,
      typingMiss,
      recallFail,
      speed
    })
  );
}

// ===== 表示 =====

export function renderDailyCard(onStart) {
  const container = document.getElementById("dailyCard");
  if (!container) return;

  const state = getDailyState();

  if (state.played) {
    container.classList.add("daily--done");
    container.innerHTML = `
      <div class="daily__head">⚡ Daily Dash</div>
      <div class="daily__result">今日のスコア <strong>${state.score}</strong> ✓</div>
      <span class="daily__note">また明日、新しい問題が届きます</span>
    `;
    return;
  }

  container.classList.remove("daily--done");
  container.innerHTML = `
    <div class="daily__head">⚡ Daily Dash</div>
    <span class="daily__desc">日替わり60秒チャレンジ。問題は全員共通・1日1回</span>
    <button type="button" class="daily__button" id="dailyStartButton">挑戦する</button>
  `;

  const button = document.getElementById("dailyStartButton");
  if (button && onStart) {
    button.addEventListener("click", onStart);
  }
}
