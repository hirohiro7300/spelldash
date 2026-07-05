import { initializeAuth } from "./auth.js";
import { initializeWordList } from "./wordList.js";
import { renderWeakWords } from "./ui.js";
import { setFooterYear } from "./footer.js";
import { getWordStats, getBestScore } from "./storage.js";
import { words } from "./words.js";

const overviewElement = document.getElementById("overview");
const progressElement = document.getElementById("progress");

initializeAuth();
renderOverview();
renderProgress();
renderWeakWords();
initializeWordList();
setFooterYear();

function computeSummary() {
  const stats = getWordStats();
  const entries = Object.values(stats);

  const total = words.length;
  const learned = words.filter((word) => (stats[word.en]?.playCount ?? 0) > 0).length;
  const mastered = words.filter((word) => stats[word.en]?.mastered).length;

  const totalCorrect = entries.reduce((sum, data) => sum + (data.correctCount ?? 0), 0);
  const totalMiss = entries.reduce((sum, data) => sum + (data.missCount ?? 0), 0);
  const totalPlays = entries.reduce((sum, data) => sum + (data.playCount ?? 0), 0);

  const attempts = totalCorrect + totalMiss;
  const accuracy = attempts > 0 ? Math.round((totalCorrect / attempts) * 100) : 0;
  const masteryRate = total > 0 ? Math.round((mastered / total) * 100) : 0;

  return {
    best: getBestScore(),
    total,
    learned,
    mastered,
    masteryRate,
    totalCorrect,
    totalMiss,
    totalPlays,
    accuracy
  };
}

function renderOverview() {
  const s = computeSummary();

  const cards = [
    { label: "ベストスコア", value: s.best },
    { label: "学習した単語", value: `${s.learned} / ${s.total}` },
    { label: "習得済み", value: s.mastered },
    { label: "習得率", value: `${s.masteryRate}%` },
    { label: "正答率", value: `${s.accuracy}%` },
    { label: "総プレイ", value: s.totalPlays }
  ];

  overviewElement.innerHTML = cards
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
