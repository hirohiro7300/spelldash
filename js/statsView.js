import { initializeAuth } from "./auth.js";
import { initializeWordList } from "./wordList.js";
import { renderWeakWords, scrollBehavior } from "./ui.js";
import { setFooterYear } from "./footer.js";
import { renderHeaderStreak } from "./headerStreak.js";
import { computeSummary, computeTypingSummary } from "./summary.js";
import { getStreak, getLostStreak, canRepairStreak, repairStreak } from "./level.js";
import { isPro } from "./plan.js";
import { getWordStats, getSessionLog } from "./storage.js";
import { renderLevelBar } from "./levelUi.js";
import { computeCategoryProgress } from "./categoryProgress.js";
import { renderWeeklyReport } from "./weeklyReport.js";
import { getLearnedSeries, recordGrowthSnapshot, getGrowthLog } from "./growthLog.js";
import { getLearnedWordList, getKnownWordList, getDroppedLearnedCount, historyDotsHtml, getLearnedCount } from "./learnedWords.js";
import { noteChipHtml, bindNoteEditors } from "./wordNotes.js";
import { renderCalendar } from "./calendarView.js";
import { downloadLearnedCsv } from "./exportCsv.js";
import { bindWordDetail } from "./wordDetail.js";

import { initWordStore } from "./wordStore.js";
import { setupUnloadSync } from "./sync.js";

const overviewElement = document.getElementById("overview");
const typingElement = document.getElementById("typingMetrics");
let trendsReady = false; // 推移グラフは単語ストアの初期化後にだけ描く（growth log を空の値で上書きしないため）
let resizeTimer = null;

initializeAuth();
renderLevelBar();
setFooterYear();
renderHeaderStreak();
setupUnloadSync();
initializeTabs();

// ===== 3タブ（今週／単語帳／分析）。#learnedWords 等の深いリンクは所属タブを開いてスクロール =====
function initializeTabs() {
  const sections = [...document.querySelectorAll("[data-tab]")].filter((el) => !el.classList.contains("stats-tab"));
  const tabs = [...document.querySelectorAll(".stats-tab")];
  if (tabs.length === 0) return;
  const TAB_KEY = "spelldash_stats_tab";

  const show = (tab, scrollToId = null) => {
    sections.forEach((el) => {
      el.hidden = el.dataset.tab !== tab;
    });
    tabs.forEach((t) => {
      const on = t.dataset.tab === tab;
      t.classList.toggle("stats-tab--active", on);
      if (on) t.setAttribute("aria-current", "true");
      else t.removeAttribute("aria-current");
    });
    localStorage.setItem(TAB_KEY, tab);
    rerenderTrends(); // 隠れていたタブのグラフは幅 0 で描かれているので描き直す
    if (scrollToId) {
      setTimeout(() => document.getElementById(scrollToId)?.scrollIntoView({ behavior: scrollBehavior(), block: "start" }), 50);
    }
  };

  const resolve = () => {
    const hash = location.hash.replace("#", "");
    if (["week", "words", "analysis"].includes(hash)) return show(hash);
    const target = hash ? document.getElementById(hash) : null;
    const owner = target?.closest("[data-tab]");
    if (owner) return show(owner.dataset.tab, hash);
    show(localStorage.getItem(TAB_KEY) || "week");
  };

  window.addEventListener("hashchange", resolve);
  resolve();
}

initializeTrendRange();
initializeStreakRepair();

initWordStore().then(() => {
  renderOverview();
  renderTyping();
  renderCalendar("calendarGrid");
  renderMonthlySummary();
  bindWordDetail({ onNoteSaved: () => { renderLearnedWords(); renderWeakWords(); } });
  document.getElementById("learnedCsv")?.addEventListener("click", (event) => {
    const n = downloadLearnedCsv();
    event.currentTarget.textContent = `書き出した（${n}語）`;
    setTimeout(() => (event.target.textContent = "CSV書き出し"), 2500);
  });
  renderScoreTrend();
  renderLearnedWords();
  renderCategoryProgress();
  renderGrowthTrend();
  trendsReady = true;
  renderWeeklyReport("weeklyReport");
  renderWeakWords();
  initializeWordList();
  // マイ単語帳の作成・管理は「単語帳」ページ（教材）へ移動。ここは記録だけ
  window.addEventListener("spelldash:mywords", () => {
    renderCategoryProgress();
    renderLearnedWords();
    renderOverview();
  });
});

// Pro の状態が届いたら（ページ表示直後は未確定）、期間と修復の表示を合わせる
document.addEventListener("spelldash:plan", () => {
  renderOverview();
  renderGrowthTrend();
});

window.addEventListener("spelldash:synced", () => {
  renderLevelBar();
  renderOverview();
  renderTyping();
  renderCalendar("calendarGrid");
  renderScoreTrend();
  renderLearnedWords();
  renderCategoryProgress();
  renderGrowthTrend();
  renderWeeklyReport("weeklyReport");
  renderWeakWords();
});

function renderCards(container, cards) {
  container.innerHTML = cards
    .map(
      (card) => `
        <div class="stat-card">
          <span>${card.label}</span>
          <strong class="mono"${card.title ? ` title="${card.title}"` : ""}>${card.value}</strong>
        </div>
      `
    )
    .join("");
}

function renderOverview() {
  const s = computeSummary();
  const streak = getStreak();
  const all = computeCategoryProgress()[0];

  // 概要は2枚だけ: 覚えた語数と連続日数（CONCEPT 原則9）。残りは「分析」タブの「その他の数字」へ
  renderCards(overviewElement, [
    { label: "覚えた", value: `${getLearnedCount()}語` },
    { label: "連続", value: `${streak.current}日` }
  ]);
  const more = document.getElementById("overviewMore");
  if (more) {
    // 4 枚（2 列でも孤立しない）。経験値は .level-bar の 1 行に任せる
    renderCards(more, [
      { label: "出会った語", value: s.learned, title: `${s.learned} / ${s.total}語` },
      { label: "ベストスコア", value: s.best },
      { label: "最長連続", value: `${streak.best}日` },
      { label: "プレイ回数", value: s.totalPlays }
    ]);
  }
  renderStreakRepair();
}

// ===== 連続記録の修復（Pro・月1回・途切れてから7日以内） =====
// 概要の数字の直後（#streakRepair）。途切れた記録が無ければ空のまま（CSS で非表示）
let repairedCount = null; // 直前に修復した日数（成功文を再描画で消さないため）

function initializeStreakRepair() {
  const container = document.getElementById("streakRepair");
  if (!container) return;
  container.addEventListener("click", (event) => {
    if (!event.target.closest("#streakRepairButton")) return;
    const result = repairStreak();
    if (!result.ok) {
      renderStreakRepair();
      return;
    }
    repairedCount = result.current;
    renderOverview();
    renderHeaderStreak();
    renderWeeklyReport("weeklyReport");
  });
}

function renderStreakRepair() {
  const container = document.getElementById("streakRepair");
  if (!container) return;
  container.classList.toggle("streak-repair--done", repairedCount != null);
  if (repairedCount != null) {
    container.innerHTML = `<span class="streak-repair__text">連続 <b>${repairedCount}</b> 日に戻した</span>`;
    return;
  }
  const lost = getLostStreak();
  if (!lost) {
    container.innerHTML = "";
    return;
  }
  const [, m, d] = lost.on.split("-");
  const when = `${Number(m)}/${Number(d)}`;
  let action;
  if (!isPro()) {
    action = `<span>Pro なら月 1 回、連続記録を修復できる。<a href="./pro.html">Pro について</a></span>`;
  } else if (canRepairStreak()) {
    action = `<button type="button" class="btn btn--sm" id="streakRepairButton">今月の修復を使う（月 1 回）</button>`;
  } else {
    action = `<span>今月の修復は使った</span>`;
  }
  container.innerHTML = `<span class="streak-repair__text">連続 <b>${lost.count}</b> 日が ${when} に途切れた。</span>${action}`;
}

// 推移グラフは viewBox をカードの実寸に合わせて描く（縮小で軸の文字が 12px 未満にならないように）
function trendWidth(container) {
  return Math.max(320, Math.round(container.clientWidth || 640));
}

function rerenderTrends() {
  if (!trendsReady) return;
  renderScoreTrend();
  renderGrowthTrend();
}
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(rerenderTrends, 150);
});

// ===== スコア推移（Challenge / Daily Dashの直近履歴） =====

function renderScoreTrend() {
  const container = document.getElementById("scoreTrend");
  if (!container) return;

  const log = getSessionLog().slice(-20);

  if (log.length < 2) {
    container.innerHTML =
      '<p class="score-trend__empty">ChallengeやDaily Dashを遊ぶと、スコアの推移がここに出る。</p>';
    return;
  }

  const width = trendWidth(container);
  const height = 180;
  const pad = { top: 16, right: 12, bottom: 24, left: 36 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const maxScore = Math.max(...log.map((e) => e.score), 1);
  const barSlot = innerW / log.length;

  const bars = log
    .map((entry, i) => {
      const barH = Math.max(2, (entry.score / maxScore) * innerH);
      const x = pad.left + i * barSlot + barSlot * 0.18;
      const y = pad.top + innerH - barH;
      const color = entry.mode === "daily" ? "var(--signal)" : "var(--ink)";
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barSlot * 0.64).toFixed(1)}" height="${barH.toFixed(1)}" rx="3" fill="${color}"><title>${entry.at?.slice(0, 10) ?? ""} ${entry.mode === "daily" ? "Daily" : "Challenge"}: ${entry.score}</title></rect>`;
    })
    .join("");

  // 目盛り: 0とベスト値のみ（ミニマル）
  const gridY = pad.top;
  const baseY = pad.top + innerH;
  const latest = log[log.length - 1];

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="直近${log.length}回のスコア推移" style="width:100%;height:auto;display:block">
      <line x1="${pad.left}" y1="${baseY}" x2="${width - pad.right}" y2="${baseY}" stroke="var(--line-2)" stroke-width="1"/>
      <line x1="${pad.left}" y1="${gridY}" x2="${width - pad.right}" y2="${gridY}" stroke="var(--line)" stroke-width="1" stroke-dasharray="4 4"/>
      <text x="${pad.left - 6}" y="${gridY + 4}" text-anchor="end" font-size="12" font-family="var(--font-mono)" fill="var(--ink-3)">${maxScore}</text>
      <text x="${pad.left - 6}" y="${baseY + 4}" text-anchor="end" font-size="12" font-family="var(--font-mono)" fill="var(--ink-3)">0</text>
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

  // 4 枚。単位は「打つ」で統一（1分あたりの語数は出さない）
  renderCards(typingElement, [
    { label: "1秒に打つ数", value: t.tapsPerSecond.toFixed(1) },
    { label: "最速", value: `${t.bestSpeed.toFixed(1)}／秒` },
    { label: "打ち間違い率", value: `${t.mistypeRate.toFixed(1)}%` },
    { label: "打った回数", value: t.totalTaps.toLocaleString() }
  ]);
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
        <div class="cat-row" data-category="${r.id}">
          <div class="cat-row__head">
            <button type="button" class="cat-row__go" data-category="${r.id}" aria-label="${r.label} で練習を始める（覚えた ${r.learned} / ${r.total}）"><span class="cat-row__label">${r.label}<span class="cat-row__total mono">${r.total}語</span>${r.total > 0 && r.learned === r.total ? `<span class="cat-row__clear">全部済み</span>` : ""}</span></button>
            <span class="cat-row__learned">覚えた <strong class="mono">${r.learned}</strong> / ${r.total}${r.id !== "all" ? ` <a class="cat-row__list" href="./list.html?category=${r.id}" data-stop>一覧</a>` : ""}</span>
          </div>
          <div class="cat-bar" aria-hidden="true">
            <i class="cat-bar__mastered" style="width:${pct(r.mastered, r.total)}%"></i>
            <i class="cat-bar__learning" style="width:${pct(r.learning, r.total)}%"></i>
            <i class="cat-bar__weak" style="width:${pct(r.weak, r.total)}%"></i>
          </div>
          <div class="cat-row__legend">${r.mastered + r.learning + r.weak === 0 ? `未着手 ${r.untouched}語` : `習得 ${r.mastered} ・ 覚えかけ ${r.learning} ・ 苦手 ${r.weak} ・ 未着手 ${r.untouched}`}</div>
        </div>
      `
      )
      .join("") +
    `<p class="cat-legend"><i class="cat-bar__mastered"></i>習得（10日以上かけてノーミス10回）<i class="cat-bar__learning"></i>覚えかけ（自力で思い出せた）<i class="cat-bar__weak"></i>苦手（最後に思い出せなかった）</p>`;

  // 練習開始はカテゴリ名のボタン（.cat-row__go）だけ。行全体は押しても何も起きない（「一覧」と押し分けられるように）
  container.querySelectorAll(".cat-row__go").forEach((button) => {
    button.addEventListener("click", () => {
      localStorage.setItem("spelldash_category", button.dataset.category);
      window.location.href = "/";
    });
  });
}

// ===== 今月のまとめ（学習した日・覚えた・セット。値が 0 の項目は出さない） =====
function renderMonthlySummary() {
  const container = document.getElementById("monthlySummary");
  if (!container) return;
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const log = getGrowthLog().filter((e) => e.date.startsWith(ym));
  const activeDays = log.filter((e) => e.active).length;
  const first = log.find((e) => e.learned != null);
  const last = [...log].reverse().find((e) => e.learned != null);
  const learnedDelta = first && last ? Math.max(0, (last.learned ?? 0) - (first.learned ?? 0)) : 0;
  let sets = 0;
  try {
    sets = (JSON.parse(localStorage.getItem("spelldash_daily_set") || "{}").history ?? []).filter((d) => d.startsWith(ym)).length;
  } catch {
    sets = 0;
  }
  // カードではなく 1 行。「学習した日」は常に出し、0 の項目は出さない（Challenge/Daily の回数はカレンダーの濃さで足りる）
  const parts = [`学習した日 <b>${activeDays}</b>日`];
  if (learnedDelta > 0) parts.push(`覚えた <b>+${learnedDelta}</b>`);
  if (sets > 0) parts.push(`セット <b>${sets}</b>回`);
  container.innerHTML = `<p class="monthly-line">${now.getMonth() + 1}月 ${parts.join(" ・ ")}</p>`;
}

// ===== 覚えた単語の推移（無料 30日・Pro 90日） =====
const TREND_RANGE_KEY = "spelldash_trend_range";

// 表示する日数。90 は Pro だけ（無料の人の保存値が 90 でも 30 で描く）
function getTrendRange() {
  const saved = localStorage.getItem(TREND_RANGE_KEY);
  return saved === "90" && isPro() ? 90 : 30;
}

function initializeTrendRange() {
  const group = document.querySelector(".trend-range");
  if (!group) return;
  group.addEventListener("click", (event) => {
    const button = event.target.closest("[data-trend-range]");
    if (!button) return;
    const days = button.dataset.trendRange;
    const card = group.closest(".result-card");
    card?.querySelector(".trend-range__hint")?.remove();
    if (days === "90" && !isPro()) {
      // グラフは 30 日のまま、案内だけ出す
      const hint = document.createElement("p");
      hint.className = "trend-range__hint";
      hint.innerHTML = '90 日の推移は Pro で見られる。<a href="./pro.html">Pro について</a>';
      card?.querySelector(".card-head")?.after(hint);
      return;
    }
    localStorage.setItem(TREND_RANGE_KEY, days === "90" ? "90" : "30");
    renderGrowthTrend();
  });
}

function syncTrendRangeButtons(days) {
  document.querySelectorAll("[data-trend-range]").forEach((button) => {
    const on = Number(button.dataset.trendRange) === days;
    button.classList.toggle("is-active", on);
    button.setAttribute("aria-pressed", String(on));
  });
  const label = document.getElementById("growthDays");
  if (label) label.textContent = String(days);
}

function renderGrowthTrend() {
  const container = document.getElementById("growthTrend");
  if (!container) return;

  const days = getTrendRange();
  syncTrendRangeButtons(days);
  const all = computeCategoryProgress()[0];
  recordGrowthSnapshot({ learned: getLearnedCount(), mastered: all.mastered });
  const series = getLearnedSeries(days);
  const points = series.filter((p) => p.learned != null);

  if (points.length < 2) {
    container.innerHTML = '<p class="score-trend__empty">毎日少しずつ学ぶと、覚えた語の増え方がここに描かれる（明日から）。</p>';
    return;
  }

  const width = trendWidth(container);
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
    .map((p, i) => (p.active && p.learned != null ? `<circle cx="${x(i).toFixed(1)}" cy="${y(p.learned).toFixed(1)}" r="3" fill="var(--signal)"><title>${p.date}: ${p.learned}語</title></circle>` : ""))
    .join("");

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="覚えた単語の推移" style="width:100%;height:auto;display:block">
      <text x="${pad.left - 6}" y="${pad.top + 4}" text-anchor="end" font-size="12" font-family="var(--font-mono)" fill="var(--ink-3)">${max}</text>
      <text x="${pad.left - 6}" y="${pad.top + innerH + 4}" text-anchor="end" font-size="12" font-family="var(--font-mono)" fill="var(--ink-3)">${min}</text>
      <line x1="${pad.left}" y1="${pad.top + innerH}" x2="${width - pad.right}" y2="${pad.top + innerH}" stroke="var(--line-2)" />
      <path d="${area}" fill="var(--paper-3)" />
      <path d="${d}" fill="none" stroke="var(--ink)" stroke-width="2" stroke-linejoin="round" />
      ${dots}
      <text x="${pad.left}" y="${height - 6}" font-size="12" font-family="var(--font-mono)" fill="var(--ink-3)">${series[0].date.slice(5)}</text>
      <text x="${width - pad.right}" y="${height - 6}" text-anchor="end" font-size="12" fill="var(--ink-3)">今日 ${all.learned}語</text>
    </svg>
    <p class="score-trend__legend"><i class="score-trend__dot score-trend__dot--daily"></i>学習した日</p>
  `;
}

// ===== 覚えた単語帳（語で見せる） =====
function renderLearnedWords() {
  const container = document.getElementById("learnedWordList");
  if (!container) return;

  const list = getLearnedWordList();
  const known = getKnownWordList();
  const dropped = getDroppedLearnedCount(); // 外したパックの語（単語帳には出せないが、記録は残っている）
  const count = document.getElementById("learnedWordsCount");
  if (count) count.textContent = `${list.length}語`;
  const knownSummary = document.getElementById("knownWordsSummary");
  if (knownSummary) knownSummary.textContent = `もともと知っていた語 ${known.length}語（覚えた数には入れない）`;

  if (list.length === 0) {
    container.innerHTML = '<p class="muted">まだない。思い出せなかった語が、次に自力で打てたときにここへ入る。</p>';
  } else {
    const shown = list.slice(0, 60);
    // 1行＝1語: 語・訳（・メモがある語だけメモ）／右端にカテゴリと履歴の点
    container.innerHTML =
      shown
        .map(
          (w) => `
          <div class="learned-item">
            <span class="learned-item__main">
              <button type="button" class="learned-item__en mono" data-word-detail="${w.id}">${w.en}</button>
              <span class="learned-item__ja">${w.ja}</span>
              <span class="learned-item__note">${noteChipHtml(w.id, { onlyIfHas: true })}</span>
            </span>
            <span class="learned-item__side">
              <span class="learned-item__meta">${w.label}${w.status === "mastered" ? ` <span class="gcard__status gcard__status--mastered">習得</span>` : ""}</span>
              ${historyDotsHtml(w.stat)}
            </span>
          </div>`
        )
        .join("") + (list.length > shown.length ? `<p class="muted">ほか ${list.length - shown.length}語</p>` : "");
    bindNoteEditors(container, () => renderLearnedWords());
  }
  if (dropped > 0) container.insertAdjacentHTML("beforeend", `<p class="muted learned-dropped">ほか ${dropped}語は外したパックの語</p>`);

  const knownContainer = document.getElementById("knownWordList");
  if (knownContainer) {
    // 並びは CSS の flex-wrap（空白文字に頼らない）
    knownContainer.innerHTML = known.length
      ? `<p class="known-words">${known.slice(0, 200).map((w) => `<button type="button" class="known-words__item mono" data-word-detail="${w.id}" title="${w.ja}">${w.en}</button>`).join("")}${known.length > 200 ? `<span class="known-words__more">ほか ${known.length - 200}語</span>` : ""}</p>`
      : '<p class="muted">まだない。</p>';
  }
}
