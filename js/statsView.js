import { initializeAuth } from "./auth.js";
import { initializeWordList } from "./wordList.js";
import { renderWeakWords } from "./ui.js";
import { setFooterYear } from "./footer.js";
import { renderHeaderStreak } from "./headerStreak.js";
import { computeSummary, computeTypingSummary } from "./summary.js";
import { getLevelState, getStreak } from "./level.js";
import { getWordStats, getSessionLog } from "./storage.js";
import { renderLevelBar } from "./levelUi.js";
import { computeCategoryProgress } from "./categoryProgress.js";
import { initializeMyWordsView } from "./myWordsView.js";
import { renderWeeklyReport } from "./weeklyReport.js";
import { getLearnedSeries, recordGrowthSnapshot } from "./growthLog.js";
import { getLearnedWordList, getKnownWordList, historyDotsHtml } from "./learnedWords.js";

import { initWordStore, getAllWords } from "./wordStore.js";
import { setupUnloadSync } from "./sync.js";

const overviewElement = document.getElementById("overview");
const progressElement = document.getElementById("progress");
const typingElement = document.getElementById("typingMetrics");

initializeAuth();
renderLevelBar();
setFooterYear();
renderHeaderStreak();
setupUnloadSync();

initWordStore().then(() => {
  renderOverview();
  renderTyping();
  renderWeeklySummary();
  renderScoreTrend();
  renderLearnedWords();
  renderCategoryProgress();
  renderGrowthTrend();
  renderWeeklyReport("weeklyReport");
  renderProgress();
  renderWordFamilies();
  renderWeakWords();
  initializeWordList();
  initializeMyWordsView(() => {
    renderCategoryProgress();
    renderLearnedWords();
    renderOverview();
  });
});

window.addEventListener("spelldash:synced", () => {
  renderLevelBar();
  renderOverview();
  renderTyping();
  renderWeeklySummary();
  renderScoreTrend();
  renderLearnedWords();
  renderCategoryProgress();
  renderGrowthTrend();
  renderWeeklyReport("weeklyReport");
  renderProgress();
  renderWordFamilies();
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

// ===== 語根ファミリー（Knowledge Map Phase A） =====
// 学習済みメンバーが1語以上ある族だけ表示（初心者にはノイズを出さない）

function renderWordFamilies() {
  const container = document.getElementById("wordFamilies");
  if (!container) return;

  const stats = getWordStats();
  const isLearned = (id) => (stats[id]?.correctCount ?? 0) > 0;

  // root → メンバー（重複IDは1つ）
  const families = new Map();
  const seen = new Set();
  for (const word of getAllWords()) {
    if (!word.root || seen.has(word.id)) continue;
    seen.add(word.id);
    if (!families.has(word.root)) families.set(word.root, []);
    families.get(word.root).push(word);
  }

  const rows = [...families.entries()]
    .map(([root, members]) => ({
      root,
      members,
      learned: members.filter((w) => isLearned(w.id)).length
    }))
    .filter((f) => f.learned > 0)
    .sort((a, b) => b.learned / b.members.length - a.learned / a.members.length);

  if (rows.length === 0) {
    container.innerHTML =
      '<p class="muted">まだありません。学習を進めると、覚えた単語の「仲間」がここに集まります。</p>';
    return;
  }

  container.innerHTML = `
    <div class="family-grid">
      ${rows
        .map((f) => {
          const complete = f.learned === f.members.length;
          return `
        <div class="family-card${complete ? " family-card--complete" : ""}">
          <div class="family-card__head">
            <span class="family-card__root">${f.root}族</span>
            <span class="family-card__count">${f.learned} / ${f.members.length}${complete ? " ✓" : ""}</span>
          </div>
          <div class="family-card__members">
            ${f.members
              .map(
                (w) =>
                  `<span class="family-chip${isLearned(w.id) ? " family-chip--learned" : ""}">${w.en}</span>`
              )
              .join("")}
          </div>
        </div>`;
        })
        .join("")}
    </div>
  `;
}

// ===== 今週のまとめ（月曜起点、先週との比較つき） =====

function startOfWeek(offsetWeeks = 0) {
  const d = new Date();
  const day = (d.getDay() + 6) % 7; // 月曜=0
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day - offsetWeeks * 7);
  return d.getTime();
}

function renderWeeklySummary() {
  const container = document.getElementById("weeklySummary");
  if (!container) return;

  const thisWeekStart = startOfWeek(0);
  const lastWeekStart = startOfWeek(1);
  const log = getSessionLog();

  const inRange = (iso, from, to) => {
    const t = Date.parse(iso ?? 0) || 0;
    return t >= from && (to == null || t < to);
  };

  const thisWeek = log.filter((e) => inRange(e.at, thisWeekStart, null));
  const lastWeek = log.filter((e) => inRange(e.at, lastWeekStart, thisWeekStart));

  const best = (entries) => (entries.length ? Math.max(...entries.map((e) => e.score)) : 0);
  const dailyCount = (entries) => entries.filter((e) => e.mode === "daily").length;

  // 今週「思い出せた」語数（lastRecallSuccessAtが今週の単語。先週分は上書きされるため比較しない）
  const stats = getWordStats();
  let recalledThisWeek = 0;
  for (const data of Object.values(stats)) {
    if (data.lastRecallSuccessAt && inRange(data.lastRecallSuccessAt, thisWeekStart, null)) {
      recalledThisWeek++;
    }
  }

  const diffLabel = (now, prev) => {
    if (prev === 0 && now === 0) return "";
    const diff = now - prev;
    if (diff === 0) return "（先週と同じ）";
    return diff > 0 ? `（先週 +${diff}）` : `（先週 ${diff}）`;
  };

  renderCards(container, [
    { label: "思い出せた単語", value: `${recalledThisWeek}語` },
    {
      label: "プレイ回数（Challenge/Daily）",
      value: `${thisWeek.length}回 ${diffLabel(thisWeek.length, lastWeek.length)}`
    },
    {
      label: "今週のベストスコア",
      value: `${best(thisWeek)} ${diffLabel(best(thisWeek), best(lastWeek))}`
    },
    {
      label: "Daily Dash完走",
      value: `${dailyCount(thisWeek)}回 ${diffLabel(dailyCount(thisWeek), dailyCount(lastWeek))}`
    }
  ]);
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

// ===== カテゴリ別の進捗（学習項目の一覧＋ステータス） =====
function renderCategoryProgress() {
  const container = document.getElementById("categoryProgress");
  if (!container) return;

  const rows = computeCategoryProgress();
  const pct = (v, total) => (total > 0 ? ((v / total) * 100).toFixed(1) : 0);

  container.innerHTML =
    rows
      .map(
        (r) => `
        <button type="button" class="cat-row" data-category="${r.id}">
          <div class="cat-row__head">
            <span class="cat-row__label">${r.label}<span class="cat-row__total">${r.total}語</span></span>
            <span class="cat-row__learned">覚えた <strong>${r.learned}</strong> / ${r.total}</span>
          </div>
          <div class="cat-bar" aria-hidden="true">
            <i class="cat-bar__mastered" style="width:${pct(r.mastered, r.total)}%"></i>
            <i class="cat-bar__learning" style="width:${pct(r.learning, r.total)}%"></i>
            <i class="cat-bar__weak" style="width:${pct(r.weak, r.total)}%"></i>
          </div>
          <div class="cat-row__legend">習得 ${r.mastered} ・ 覚えかけ ${r.learning} ・ 苦手 ${r.weak} ・ 未着手 ${r.untouched}</div>
        </button>
      `
      )
      .join("") +
    `<p class="cat-legend"><i class="cat-bar__mastered"></i>習得（10日以上かけてノーミス10回）<i class="cat-bar__learning"></i>覚えかけ（自力で思い出せた）<i class="cat-bar__weak"></i>苦手（最後に思い出せなかった）</p>`;

  container.querySelectorAll(".cat-row").forEach((row) => {
    row.addEventListener("click", () => {
      localStorage.setItem("spelldash_category", row.dataset.category);
      window.location.href = "/";
    });
  });
}

// ===== 覚えた単語の推移（30日） =====
function renderGrowthTrend() {
  const container = document.getElementById("growthTrend");
  if (!container) return;

  const all = computeCategoryProgress()[0];
  recordGrowthSnapshot({ learned: all.learned, mastered: all.mastered });
  const series = getLearnedSeries(30);
  const points = series.filter((p) => p.learned != null);

  if (points.length < 2) {
    container.innerHTML = '<p class="score-trend__empty">毎日少しずつ学ぶと、覚えた単語の増え方がここに描かれます（明日から）。</p>';
    return;
  }

  const width = 640;
  const height = 180;
  const pad = { top: 16, right: 12, bottom: 24, left: 36 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const values = series.map((p) => p.learned);
  const min = Math.min(...values.filter((v) => v != null));
  const max = Math.max(...values.filter((v) => v != null), min + 1);
  const x = (i) => pad.left + (i / (series.length - 1)) * innerW;
  const y = (v) => pad.top + innerH - ((v - min) / (max - min)) * innerH;

  let d = "";
  series.forEach((p, i) => {
    if (p.learned == null) return;
    d += `${d ? "L" : "M"}${x(i).toFixed(1)},${y(p.learned).toFixed(1)}`;
  });
  const firstIdx = series.findIndex((p) => p.learned != null);
  const lastIdx = series.length - 1;
  const area = `${d}L${x(lastIdx).toFixed(1)},${(pad.top + innerH).toFixed(1)}L${x(firstIdx).toFixed(1)},${(pad.top + innerH).toFixed(1)}Z`;
  const dots = series
    .map((p, i) => (p.active && p.learned != null ? `<circle cx="${x(i).toFixed(1)}" cy="${y(p.learned).toFixed(1)}" r="3.5" fill="#4ade80"><title>${p.date}: ${p.learned}語</title></circle>` : ""))
    .join("");

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="覚えた単語の推移">
      <text x="${pad.left - 6}" y="${pad.top + 4}" text-anchor="end" font-size="11" fill="#94a3b8">${max}</text>
      <text x="${pad.left - 6}" y="${pad.top + innerH}" text-anchor="end" font-size="11" fill="#94a3b8">${min}</text>
      <line x1="${pad.left}" y1="${pad.top + innerH}" x2="${width - pad.right}" y2="${pad.top + innerH}" stroke="rgba(148,163,184,0.3)" />
      <path d="${area}" fill="rgba(96,165,250,0.18)" />
      <path d="${d}" fill="none" stroke="#60a5fa" stroke-width="2.5" stroke-linejoin="round" />
      ${dots}
      <text x="${pad.left}" y="${height - 6}" font-size="11" fill="#94a3b8">${series[0].date.slice(5)}</text>
      <text x="${width - pad.right}" y="${height - 6}" text-anchor="end" font-size="11" fill="#94a3b8">今日 ${all.learned}語</text>
    </svg>
    <p class="score-trend__legend">● 学習した日</p>
  `;
}

// ===== 覚えた単語帳（語で見せる） =====
function renderLearnedWords() {
  const container = document.getElementById("learnedWordList");
  if (!container) return;

  const list = getLearnedWordList();
  const known = getKnownWordList();
  const count = document.getElementById("learnedWordsCount");
  if (count) count.textContent = `${list.length}語`;
  const knownSummary = document.getElementById("knownWordsSummary");
  if (knownSummary) knownSummary.textContent = `もともと知っていた語 ${known.length}語（覚えた数には入れていません）`;

  if (list.length === 0) {
    container.innerHTML = '<p class="muted">まだありません。思い出せなかった語が、次に自力で打てた時にここへ入ります。</p>';
  } else {
    const shown = list.slice(0, 60);
    container.innerHTML =
      shown
        .map(
          (w) => `
          <div class="learned-item">
            <span class="learned-item__en">${w.en}</span>
            <span class="learned-item__ja">${w.ja}</span>
            <span class="learned-item__meta">${w.label}${w.status === "mastered" ? " ・ 習得" : ""}</span>
            ${historyDotsHtml(w.stat)}
          </div>`
        )
        .join("") + (list.length > shown.length ? `<p class="muted">ほか ${list.length - shown.length} 語</p>` : "");
  }

  const knownContainer = document.getElementById("knownWordList");
  if (knownContainer) {
    knownContainer.innerHTML = known.length
      ? `<p class="known-words">${known.slice(0, 200).map((w) => `<span title="${w.ja}">${w.en}</span>`).join(" ")}${known.length > 200 ? " …" : ""}</p>`
      : '<p class="muted">まだありません。</p>';
  }
}
