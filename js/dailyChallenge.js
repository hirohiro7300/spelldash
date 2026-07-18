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

  lines.push("今日も、はちゃんと少しだけ。");
  lines.push("https://www.spelldash.net");
  return lines.join("\n");
}

// ===== リザルト画像（Canvas生成・依存なし） =====
// SNSで目を引くOGP風カード。Web Share API Level 2（files）対応環境では画像付き共有

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function buildDailyResultImage(state = getDailyState()) {
  const W = 1080;
  const H = 1080;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  // 背景（ダークスレート＋ブルーのグロー）
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.85, H * 0.12, 60, W * 0.85, H * 0.12, 640);
  glow.addColorStop(0, "rgba(99,102,241,0.4)");
  glow.addColorStop(1, "rgba(99,102,241,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // ブランド
  const grad = ctx.createLinearGradient(80, 80, 176, 176);
  grad.addColorStop(0, "#3b82f6");
  grad.addColorStop(1, "#6366f1");
  ctx.fillStyle = grad;
  roundRect(ctx, 80, 80, 96, 96, 26);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "800 40px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("SD", 128, 130);
  ctx.textAlign = "left";
  ctx.font = "800 56px sans-serif";
  ctx.fillText("SpellDash", 208, 130);

  // タイトル
  const [, month, day] = state.date.split("-");
  ctx.fillStyle = "#facc15";
  ctx.font = "800 64px sans-serif";
  ctx.fillText(`⚡ Daily Dash ${Number(month)}/${Number(day)}`, 80, 320);

  // スコア（主役）
  ctx.fillStyle = "#f8fafc";
  ctx.font = "800 220px sans-serif";
  ctx.fillText(`${state.score}`, 80, 540);
  const scoreWidth = ctx.measureText(`${state.score}`).width;
  ctx.fillStyle = "#94a3b8";
  ctx.font = "700 56px sans-serif";
  ctx.fillText("語", 80 + scoreWidth + 24, 540);

  // ストリーク
  const streak = getStreak();
  if (streak.current > 0) {
    ctx.fillStyle = "#fb923c";
    ctx.font = "700 52px sans-serif";
    ctx.fillText(`🔥 ${streak.current}日連続`, 80, 660);
  }

  // 絵文字グリッド
  const cells = Array.from(state.emoji ?? "").slice(0, 30);
  ctx.font = "52px sans-serif";
  cells.forEach((cell, i) => {
    const cx = 80 + (i % 10) * 62;
    const cy = 760 + Math.floor(i / 10) * 66;
    ctx.fillText(cell, cx, cy);
  });

  // URL
  ctx.fillStyle = "#64748b";
  ctx.font = "600 40px sans-serif";
  ctx.fillText("spelldash.net", 80, H - 70);

  return canvas;
}

async function canvasToPng(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

// Web Share APIがあれば共有シート（画像対応環境は画像付き）、なければコピー
export async function shareDailyResult() {
  const text = buildDailyShareText();

  if (navigator.share) {
    // 画像付き共有（対応環境のみ）
    try {
      const blob = await canvasToPng(buildDailyResultImage());
      if (blob) {
        const file = new File([blob], "spelldash-daily.png", { type: "image/png" });
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ text, files: [file] });
          return "shared";
        }
      }
    } catch {
      // 画像生成/共有に失敗したらテキスト共有へフォールバック
    }

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

// 「次の問題まで HH:MM」カウントダウン（再訪トリガー。Wordleで実証済みの型）
let countdownTimer = null;

function startDailyCountdown() {
  clearInterval(countdownTimer);

  const tick = () => {
    const el = document.getElementById("dailyCountdown");
    if (!el) {
      clearInterval(countdownTimer);
      return;
    }

    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const remainMs = midnight - now;

    // 日付が変わったらカードを未挑戦状態に描き直す
    if (remainMs <= 0) {
      clearInterval(countdownTimer);
      renderDailyCard();
      return;
    }

    const h = Math.floor(remainMs / 3600000);
    const m = Math.floor((remainMs % 3600000) / 60000);
    el.textContent = `${h}時間${String(m).padStart(2, "0")}分`;
  };

  tick();
  countdownTimer = setInterval(tick, 30000);
}

let lastOnStart = null; // 0時の自動再描画でもボタンが機能するよう保持

export function renderDailyCard(onStart) {
  const container = document.getElementById("dailyCard");
  if (!container) return;

  if (onStart) lastOnStart = onStart;
  const startHandler = onStart ?? lastOnStart;

  const state = getDailyState();

  // モード選択タイル（ホーム）にも完了状態を反映
  const tile = document.getElementById("modeDailyTile");
  const tileDesc = document.getElementById("modeDailyDesc");
  if (tile && tileDesc) {
    tile.classList.toggle("mode-switch__btn--done", state.played);
    tileDesc.textContent = state.played
      ? `✓ 今日は完了（スコア ${state.score}）`
      : "1日1回・全員同じ問題";
  }

  if (state.played) {
    container.classList.add("daily--done");
    container.innerHTML = `
      <div class="daily__head">⚡ Daily Dash</div>
      <div class="daily__result">今日のスコア <strong>${state.score}</strong> ✓</div>
      <span class="daily__note">次の問題まで <strong id="dailyCountdown">--:--</strong></span>
      <button type="button" class="daily__share" id="dailyShareButton">結果をシェア</button>
      <div class="daily-rank" id="dailyRankArea" hidden></div>
    `;

    startDailyCountdown();

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
  if (button && startHandler) {
    button.addEventListener("click", startHandler);
  }

  renderDailyRanking(); // 挑戦前でも今日のTOPが見える＝参加動機
}
