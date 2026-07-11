import { initializeAuth } from "./auth.js";
import { initializeWordList } from "./wordList.js";
import { renderWeakWords } from "./ui.js";
import { setFooterYear } from "./footer.js";
import { computeSummary, computeTypingSummary } from "./summary.js";
import { getLevelState, getStreak } from "./level.js";
import { renderLevelBar } from "./levelUi.js";

const overviewElement = document.getElementById("overview");
const progressElement = document.getElementById("progress");
const typingElement = document.getElementById("typingMetrics");

initializeAuth();
renderLevelBar();
renderOverview();
renderTyping();
renderProgress();
renderWeakWords();
initializeWordList();
setFooterYear();

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
    { label: "ベストスコア", value: s.best },
    { label: "学習した単語", value: `${s.learned} / ${s.total}` },
    { label: "習得済み", value: s.mastered },
    { label: "習得率", value: `${s.masteryRate}%` },
    { label: "正答率", value: `${s.accuracy}%` },
    { label: "総プレイ", value: s.totalPlays }
  ]);
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
