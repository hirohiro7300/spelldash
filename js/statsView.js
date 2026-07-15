import { initializeAuth } from "./auth.js";
import { initializeWordList } from "./wordList.js";
import { renderWeakWords } from "./ui.js";
import { setFooterYear } from "./footer.js";
import { computeSummary, computeTypingSummary } from "./summary.js";
import { getLevelState, getStreak } from "./level.js";
import { getWordStats, getSessionLog } from "./storage.js";
import { renderLevelBar } from "./levelUi.js";

import { initWordStore } from "./wordStore.js";
import { setupUnloadSync } from "./sync.js";

const overviewElement = document.getElementById("overview");
const progressElement = document.getElementById("progress");
const typingElement = document.getElementById("typingMetrics");

initializeAuth();
renderLevelBar();
setFooterYear();
setupUnloadSync();

initWordStore().then(() => {
  renderOverview();
  renderTyping();
  renderScoreTrend();
  renderProgress();
  renderWeakWords();
  initializeWordList();
});

window.addEventListener("spelldash:synced", () => {
  renderLevelBar();
  renderOverview();
  renderTyping();
  renderScoreTrend();
  renderProgress();
  renderWeakWords();
});

function renderCards(container, cards) {
  container.innerHTML = cards
    .map(
      (card) => `
        <div class="stat-card">
          <span>${card.label}</span>
          <strong>${card.value}</strong>
        </div>
      `
    )
    .join("");
}

function renderOverview() {
  const s = computeSummary();
  const level = getLevelState();
  const streak = getStreak();

  renderCards(overviewElement, [
    { label: "レベル", value: `Lv.${level.level}` },
    { label: "総XP", value: level.totalXp.toLocaleString() },
    { label: "連続プレイ", value: `${streak.current}日` },
    { label: "最長連続", value: `${streak.best}日` },
    { label: "ストリークシールド", value: `🛡️ × ${streak.shields ?? 0}` },
    { label: "ベストスコア", value: s.best },
    { label: "学習した単語", value: `${s.learned} / ${s.total}` },
    { label: "習得済み", value: s.mastered },
    { label: "習得率", value: `${s.masteryRate}%` },
    { label: "正答率", value: `${s.accuracy}%` },
    { label: "思い出し成功率", value: computeRecallRateLabel() },
    { label: "総プレイ", value: s.totalPlays }
  ]);
}

// 思い出し成功率 = 自力正解 / (自力正解 + 思い出せなかった回数)
// タイピングの正確さではなく「記憶から取り出せた割合」を見る指標
function computeRecallRateLabel() {
  const stats = getWordStats();
  let ok = 0;
  let fail = 0;

  for (const data of Object.values(stats)) {
    ok += data.correctCount ?? 0;
    fail += data.recallFail ?? 0;
  }

  const total = ok + fail;
  return total > 0 ? `${Math.round((ok / total) * 100)}%` : "-";
}

// ===== スコア推移（Challenge / Daily Dashの直近履歴） =====

function renderScoreTrend() {
  const container = document.getElementById("scoreTrend");
  if (!container) return;

  const log = getSessionLog().slice(-20);

  if (log.length < 2) {
    container.innerHTML =
      '<p class="score-trend__empty">ChallengeやDaily Dashを遊ぶと、ここにスコアの推移が表示されます。</p>';
    return;
  }

  const width = 640;
  const height = 180;
  const pad = { top: 16, right: 12, bottom: 24, left: 30 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const maxScore = Math.max(...log.map((e) => e.score), 1);
  const barSlot = innerW / log.length;

  const bars = log
    .map((entry, i) => {
      const barH = Math.max(2, (entry.score / maxScore) * innerH);
      const x = pad.left + i * barSlot + barSlot * 0.18;
      const y = pad.top + innerH - barH;
      const color = entry.mode === "daily" ? "#facc15" : "#3b82f6";
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barSlot * 0.64).toFixed(1)}" height="${barH.toFixed(1)}" rx="3" fill="${color}"><title>${entry.at?.slice(0, 10) ?? ""} ${entry.mode === "daily" ? "Daily" : "Challenge"}: ${entry.score}</title></rect>`;
    })
    .join("");

  // 目盛り: 0とベスト値のみ（ミニマル）
  const gridY = pad.top;
  const baseY = pad.top + innerH;
  const latest = log[log.length - 1];

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="直近${log.length}回のスコア推移" style="width:100%;height:auto;display:block">
      <line x1="${pad.left}" y1="${baseY}" x2="${width - pad.right}" y2="${baseY}" stroke="rgba(148,163,184,0.25)" stroke-width="1"/>
      <line x1="${pad.left}" y1="${gridY}" x2="${width - pad.right}" y2="${gridY}" stroke="rgba(148,163,184,0.12)" stroke-width="1" stroke-dasharray="4 4"/>
      <text x="${pad.left - 6}" y="${gridY + 4}" text-anchor="end" font-size="11" fill="#64748b">${maxScore}</text>
      <text x="${pad.left - 6}" y="${baseY + 4}" text-anchor="end" font-size="11" fill="#64748b">0</text>
      ${bars}
    </svg>
    <div class="score-trend__legend">
      <span><i class="score-trend__dot score-trend__dot--challenge"></i>Challenge</span>
      <span><i class="score-trend__dot score-trend__dot--daily"></i>Daily Dash</span>
      <span class="score-trend__latest">直近 ${latest.score} / ベスト ${maxScore}</span>
    </div>
  `;
}

function renderTyping() {
  const t = computeTypingSummary();

  renderCards(typingElement, [
    { label: "平均タップ / 秒", value: t.tapsPerSecond.toFixed(1) },
    { label: "ミスタイプ率", value: `${t.mistypeRate.toFixed(1)}%` },
    { label: "最高速度 (打/秒)", value: t.bestSpeed.toFixed(1) },
    { label: "推定WPM", value: Math.round(t.wordsPerMinute) },
    { label: "総タップ数", value: t.totalTaps.toLocaleString() },
    { label: "プレイ回数", value: t.sessions }
  ]);
}

function renderProgress() {
  const s = computeSummary();

  const rows = [
    { label: "習得率", detail: `${s.mastered} / ${s.total} 語`, percent: s.masteryRate },
    { label: "正答率", detail: `正解 ${s.totalCorrect} / ミス ${s.totalMiss}`, percent: s.accuracy }
  ];

  progressElement.innerHTML = rows
    .map(
      (row) => `
        <div class="progress-row">
          <div class="progress-row__head">
            <span>${row.label}</span>
            <strong>${row.percent}%</strong>
          </div>
          <div class="progress-bar">
            <div class="progress-bar__fill" style="width: ${row.percent}%;"></div>
          </div>
          <div class="progress-row__head" style="margin-top: 6px; margin-bottom: 0;">
            <span>${row.detail}</span>
          </div>
        </div>
      `
    )
    .join("");
}
