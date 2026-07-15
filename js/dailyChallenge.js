import { getAllWords } from "./wordStore.js";
import { getStreak } from "./level.js";
import { renderDailyRanking } from "./dailyRank.js";

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
// emoji: 単語ごとの結果（🟩自力正解 🟨答えを見て正解 ⬛パス）を並べた文字列
export function recordDailyResult({ score, typingMiss, recallFail, speed, emoji }) {
  localStorage.setItem(
    DAILY_KEY,
    JSON.stringify({
      date: todayString(),
      played: true,
      score,
      typingMiss,
      recallFail,
      speed,
      emoji: emoji ?? ""
    })
  );
}

// ===== シェア（Wordle式テキスト） =====

// 例:
// SpellDash Daily Dash 7/15
// ⚡ 14語 / 🔥 6日連続
// 🟩🟩🟨🟩🟩⬛🟩🟩🟩🟩
// 🟩🟩🟨🟩
// https://www.spelldash.net
export function buildDailyShareText(state = getDailyState()) {
  const [, month, day] = state.date.split("-");
  const streak = getStreak();

  const lines = [`SpellDash Daily Dash ${Number(month)}/${Number(day)}`];

  let scoreLine = `⚡ ${state.score}語`;
  if (streak.current > 0) scoreLine += ` / 🔥 ${streak.current}日連続`;
  lines.push(scoreLine);

  // 絵文字グリッドは10個ずつ改行（Wordleの行形式）。長すぎ防止で3行まで
  const cells = Array.from(state.emoji ?? "");
  for (let i = 0; i < cells.length && i < 30; i += 10) {
    lines.push(cells.slice(i, i + 10).join(""));
  }
  if (cells.length > 30) lines.push("…");

  lines.push("https://www.spelldash.net");
  return lines.join("\n");
}

// Web Share APIがあれば共有シート、なければクリップボードへコピー
export async function shareDailyResult() {
  const text = buildDailyShareText();

  if (navigator.share) {
    try {
      await navigator.share({ text });
      return "shared";
    } catch {
      // キャンセル時はコピーにフォールバックしない（ユーザーの意思を尊重）
      return "cancelled";
    }
  }

  await navigator.clipboard.writeText(text);
  return "copied";
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
      <button type="button" class="daily__share" id="dailyShareButton">結果をシェア</button>
      <div class="daily-rank" id="dailyRankArea" hidden></div>
    `;

    const shareButton = document.getElementById("dailyShareButton");
    shareButton.addEventListener("click", async () => {
      const outcome = await shareDailyResult().catch(() => "failed");
      if (outcome === "copied") {
        shareButton.textContent = "コピーしました！SNSに貼り付けてね";
        setTimeout(() => {
          shareButton.textContent = "結果をシェア";
        }, 2500);
      }
    });

    renderDailyRanking(state.score); // 失敗時は非表示のまま（await不要）
    return;
  }

  container.classList.remove("daily--done");
  container.innerHTML = `
    <div class="daily__head">⚡ Daily Dash</div>
    <span class="daily__desc">日替わり60秒チャレンジ。問題は全員共通・1日1回</span>
    <button type="button" class="daily__button" id="dailyStartButton">挑戦する</button>
    <div class="daily-rank" id="dailyRankArea" hidden></div>
  `;

  const button = document.getElementById("dailyStartButton");
  if (button && onStart) {
    button.addEventListener("click", onStart);
  }

  renderDailyRanking(); // 挑戦前でも今日のTOPが見える＝参加動機
}
