import { initializeAuth } from "./auth.js";
import { initializeWordList } from "./wordList.js";
import { renderWeakWords, scrollBehavior } from "./ui.js";
import { setFooterYear, revealPendingPage } from "./footer.js";
import { renderHeaderStreak } from "./headerStreak.js";
import { computeSummary, computeTypingSummary } from "./summary.js";
import { getStreak, getLostStreak, canRepairStreak, repairStreak } from "./level.js";
import { isPro } from "./plan.js";
import { canOfferPro } from "./proFunnel.js";
import { getWordStats, getSessionLog } from "./storage.js";
import { renderLevelBar } from "./levelUi.js";
import { computeCategoryProgress, computeLegacyLearnedCount, classifyWord } from "./categoryProgress.js";
import { renderWeeklyReport } from "./weeklyReport.js";
import { renderRetention } from "./retention.js";
import { getLearnedSeries, recordGrowthSnapshot, getGrowthLog } from "./growthLog.js";
import { getLearnedWordList, getKnownWordList, getDroppedLearnedCount, historyDotsHtml, getLearnedCount, getLearnedCounts } from "./learnedWords.js";
import { noteChipHtml, bindNoteEditors } from "./wordNotes.js";
import { renderCalendar } from "./calendarView.js";
import { downloadLearnedCsv } from "./exportCsv.js";
import { rankHtml, rankOf, RANK_GLOSS, RANK_RULE, RANK_NAMES } from "./mastery.js";
import { recallSpeedClass, SPEED_LABEL } from "./recallSpeed.js";
import { getMemoryWord } from "./memoryWords.js";
import { getRankCheck } from "./masteryMeta.js";
import { bindWordDetail } from "./wordDetail.js";

import { initWordStore, findWord, promptOf } from "./wordStore.js";
import { setupUnloadSync } from "./sync.js";
import { logTypingStage } from "./funnelLog.js";

const overviewElement = document.getElementById("overview");
const typingElement = document.getElementById("typingMetrics");
let trendsReady = false; // 推移グラフは単語ストアの初期化後にだけ描く（growth log を空の値で上書きしないため）
let weeklyReady = false; // 週間レポートを描いてよい（単語ストアの初期化と成長ログの今日の行の後。初期化に失敗したときは失敗の後: renderWeekly）
let resizeTimer = null;

// 週間レポート（Batch 72）: 単語ストアの初期化と成長ログの今日の行（renderGrowthTrend。前の形の行の語数も合わせる）の後にだけ描く。先に届いた知らせ
// （Pro の受付の返事 spelldash:billing・同期）で描くと、読み直す前の数で描いてすぐ描き直し、はちゃんの顔と一言が替わっていた（2 つ目の顔も読む）。
// 初めの描画は届いた知らせの後の状態を読むので、先に届いた分は描かなくてよい。同じ中身なら js/weeklyReport.js が描き直さない。
// 単語の表が読めない（オフラインで目録やパックの写しが無い）ときは、失敗の後に今の記録で描く（週間レポートは語の表を読まずに描ける。PR #189 のレビュー 3）
function renderWeekly() {
  if (weeklyReady) renderWeeklyReport("weeklyReport");
}

initializeAuth();
renderLevelBar();
setFooterYear();
renderHeaderStreak();
setupUnloadSync();
initializeTabs();
trackTypingEntry();

// 息抜きの入口（本文の最後の「息抜きに タイピング練習」。Batch 65 P3）: 押したら、タイピング練習・タイピングゲームから初めて来た端末だけ
// first_visit の typing_stats／tgame_stats を積む（移る直前なので次のページで送る。来た日で 1 回。js/funnelLog.js logTypingStage）。移動は止めない
function trackTypingEntry() {
  document.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("[data-typing-entry]") : null;
    if (!link) return;
    logTypingStage("stats", "typing");
    logTypingStage("stats", "tgame");
  });
}

// ===== 3タブ（今週／単語帳／分析）。#learnedWords 等の深いリンクは所属タブを開いてスクロール =====
function initializeTabs() {
  const sections = [...document.querySelectorAll("[data-tab]")].filter((el) => !el.classList.contains("stats-tab"));
  const tabs = [...document.querySelectorAll(".stats-tab")];
  if (tabs.length === 0) return;
  const TAB_KEY = "spelldash_stats_tab";

  const show = (tab, scrollToId = null) => {
    sections.forEach((el) => {
      el.hidden = el.dataset.tab !== tab || el.hasAttribute("data-tab-empty"); // 中身の無い節（習熟度の 0 語）はタブを開いても出さない
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
  renderGrowthTrend(); // 今日の行のスナップショットを先に取る（カレンダー・今月のまとめが同じ行を読む）
  trendsReady = true;
  weeklyReady = true;
  renderCalendar("calendarGrid");
  renderMonthlySummary();
  bindWordDetail({ onNoteSaved: () => { renderLearnedWords(); renderWeakWords(); } });
  document.getElementById("learnedCsv")?.addEventListener("click", (event) => {
    const n = downloadLearnedCsv();
    event.currentTarget.textContent = `書き出した（${n}語）`;
    setTimeout(() => (event.target.textContent = "CSV書き出し"), 2500);
  });
  renderScoreTrend();
  renderMastery();
  renderLearnedWords();
  renderCategoryProgress();
  renderWeekly();
  renderRetention("retentionReport");
  renderWeakWords();
  initializeWordList();
  // マイ単語帳の作成・管理は「単語帳」ページ（教材）へ移動。ここは記録だけ
  window.addEventListener("spelldash:mywords", () => {
    renderCategoryProgress();
    renderMastery();
    renderLearnedWords();
    renderOverview();
  });
  // 読み込みの間はタブより下とフッターを透明にしている（body[data-pending]。css/pages.css）。3 つのタブの中身を描き終えてから出す
}, () => {
  // 単語の表が読めなかった（初期化の失敗だけ。上の描画の失敗はここに来ない）: 週間レポートは今の記録で描く。後から届く知らせ（課金・修復・同期）でも描き直す
  weeklyReady = true;
  renderWeekly();
}).finally(revealPendingPage); // 語が読めなかったときも出す（描いた then と同じタスクのマイクロタスク＝描画の前に走る）

// Pro の状態が届いたら（ページ表示直後は未確定）、期間と修復の表示を合わせる。
// 推移は単語ストアの初期化後にだけ描く（先に描くと growth log の今日の行を 0 で上書きし、カレンダーの濃さが狂う）
document.addEventListener("spelldash:plan", () => {
  renderOverview();
  if (trendsReady) renderGrowthTrend();
});

// 同期で追加パックの選択が変わった: 語を読み直してから数え直す（読み直しの終わりを spelldash:store-ready で js/sync.js に知らせる。sync.js はそれを待ってから spelldash:synced を投げる）
window.addEventListener("spelldash:packs", (event) => {
  if (!event.detail?.synced) return;
  initWordStore().then(() => {
    renderOverview();
    renderMastery();
    renderLearnedWords();
    renderCategoryProgress();
    window.dispatchEvent(new CustomEvent("spelldash:store-ready"));
  });
});

// 同期で別の端末のメモが届いた
window.addEventListener("spelldash:notes", () => {
  renderLearnedWords();
  renderWeakWords();
});

window.addEventListener("spelldash:synced", () => {
  renderLevelBar();
  renderOverview();
  renderTyping();
  if (trendsReady) renderGrowthTrend(); // 単語ストアの初期化前に同期が届いても、今日の行を 0 で上書きしない
  renderCalendar("calendarGrid");
  renderMonthlySummary();
  renderScoreTrend();
  renderMastery();
  renderLearnedWords();
  renderCategoryProgress();
  renderWeekly();
  renderRetention("retentionReport");
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
    renderWeekly();
  });
  // 受付中かが分かったら「Pro なら…」の案内（修復の 1 行と週間レポートの 1 行）を出し直す（js/myWordsView.js・profileView.js と同じ。
  // 初めて開いた端末は /api/billing/config の返事が最初の描画より遅れることがある）
  document.addEventListener("spelldash:billing", () => {
    renderStreakRepair();
    renderWeekly();
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
    // 実際の期限（途切れた日＋7 日）を書く。受付前・アプリでは Pro の話をしない
    const deadline = new Date(`${lost.on}T00:00:00`);
    deadline.setDate(deadline.getDate() + 7);
    action = canOfferPro()
      ? `<span>Pro なら、${deadline.getMonth() + 1}/${deadline.getDate()} までこの ${lost.count} 日を戻せる（月 1 回）。<a href="./pro.html" data-funnel="repair">Pro について</a></span>`
      : "";
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
  // 内訳の行: 何も学んでいなければ「未着手 N語」。習得か苦手が 1 以上の行だけ内訳を出す（0 の項目は出さない。
  // 「覚えた」の数は見出しが持つ）
  const legendOf = (r) => {
    if (r.total === 0) return ""; // 語の無いカテゴリ（空のマイ単語帳）は内訳なし
    if (r.mastered + r.learning + r.weak === 0) return `<div class="cat-row__legend">未着手 ${r.untouched}語</div>`;
    if (r.mastered === 0 && r.weak === 0) return "";
    const parts = [r.mastered > 0 && `習得 ${r.mastered}`, r.learning > 0 && `覚えた ${r.learning}`, r.weak > 0 && `苦手 ${r.weak}`, r.untouched > 0 && `未着手 ${r.untouched}`].filter(Boolean);
    return `<div class="cat-row__legend">${parts.join(" ・ ")}</div>`;
  };

  container.innerHTML =
    rows
      .map(
        (r) => `
        <div class="cat-row" data-category="${r.id}">
          <div class="cat-row__head">
            <button type="button" class="cat-row__go" data-category="${r.id}" aria-label="${r.label} で練習を始める（覚えた ${r.learned} / ${r.total}）"><span class="cat-row__label">${r.label}<span class="cat-row__total mono">${r.total}語</span>${r.total > 0 && r.learned === r.total ? `<span class="cat-row__clear">全部済み</span>` : ""}</span></button>
            <span class="cat-row__learned">覚えた <strong class="mono">${r.learned}</strong> / ${r.total} <a class="cat-row__list" href="./list.html?category=${r.id}" data-stop>一覧</a></span>
          </div>
          <div class="cat-bar" aria-hidden="true">
            <i class="cat-bar__mastered" style="width:${pct(r.mastered, r.total)}%"></i>
            <i class="cat-bar__learning" style="width:${pct(r.learning, r.total)}%"></i>
            <i class="cat-bar__weak" style="width:${pct(r.weak, r.total)}%"></i>
          </div>
          ${legendOf(r)}
        </div>
      `
      )
      .join("") +
    `<p class="cat-legend"><i class="cat-bar__mastered"></i>習得（10日以上かけてノーミス10回）<i class="cat-bar__learning"></i>覚えた（自力で思い出せた）<i class="cat-bar__weak"></i>苦手（最後に思い出せなかった）</p>`;

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
  // カードではなく 1 行。「学習した日」は常に出し、0 の項目は出さない
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
      // グラフは 30 日のまま、案内だけ出す（受付前・アプリでは Pro へ送らない）
      const hint = document.createElement("p");
      hint.className = "trend-range__hint";
      hint.innerHTML = canOfferPro() ? '90日の推移は Pro で見られる。<a href="./pro.html" data-funnel="trend">Pro について</a>' : "90日の推移は Pro で見られる。";
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
  recordGrowthSnapshot({ ...getLearnedCounts(), legacyLearned: computeLegacyLearnedCount });
  // 90 日でも記録が短い人は、最初の記録の日から描く（左の空白で線が詰まらない）
  const fullSeries = getLearnedSeries(days);
  const firstRecorded = fullSeries.findIndex((p) => p.learned != null);
  const series = days === 90 && firstRecorded > 0 ? fullSeries.slice(Math.max(0, Math.min(firstRecorded, fullSeries.length - 30))) : fullSeries;
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
  // 底は 0 に固定（増分の大きさが傾きに出る。数字を誇張しない）
  const values = series.map((p) => p.learned);
  const min = 0;
  const max = Math.max(...values.filter((v) => v != null), 1);
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
  // 点が多すぎると打たない（90 日分だと間隔が 3px ほどになり、朱の帯に見える）。記録が短く 30 日ほどに切った 90 日は打つ
  const dots = (series.length > 45 ? [] : series)
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
      <text x="${width - pad.right}" y="${height - 6}" text-anchor="end" font-size="12" fill="var(--ink-3)">今日</text>
    </svg>
  `;
}

// ===== 習熟度（docs/SPEC_MASTERY.md §5.3）: 段ごとの語数 =====
// 行は段 5 → 1。目盛りと名前（見出しが「習熟度」なので aria-label には重ねない）・語数・入り方によらず真の短い説明（RANK_GLOSS）。
// 数えるのは語が引ける（findWord）語のうち段 1 以上（知ってた語・苦手の語も含む。外したパックの語は数えない）。0 の行は出さず、
// 1 語も無ければ節ごと出さない。その段に知ってた語（題箋と同じ「知ってた」= classifyWord が known。ホームの「覚えた N語」が除く語）が
// あるときだけ「（うち知ってた M語）」。率・合計・推移は出さない。段は rankOf で読むだけ（記録を書き換えない）。
// 思い出す速さと段ごとの実測（Batch 70。D1 §3.3）は、習熟度の行と注記の下に 1〜2 行（speedLines）
function renderMastery() {
  const section = document.getElementById("mastery");
  const container = document.getElementById("masteryReport");
  if (!section || !container) return;
  const counts = [0, 0, 0, 0, 0, 0];
  const known = [0, 0, 0, 0, 0, 0];
  const speeds = { fast: 0, normal: 0, slow: 0 };
  for (const [id, stat] of Object.entries(getWordStats())) {
    const r = rankOf(stat);
    const word = r >= 1 ? findWord(id) : null;
    if (!word) continue;
    counts[r]++;
    if (classifyWord(stat) === "known") known[r]++;
    if (r >= 2 && r <= 4) {
      const speed = recallSpeedClass({ sp: getMemoryWord(id)?.sp, rank: r, prompt: promptOf(word) });
      if (speed) speeds[speed]++;
    }
  }
  const empty = counts.every((n) => n === 0);
  section.toggleAttribute("data-tab-empty", empty);
  const activeTab = document.querySelector(".stats-tab--active")?.dataset.tab;
  section.hidden = empty || (activeTab != null && activeTab !== section.dataset.tab);
  if (empty) {
    container.innerHTML = "";
    return;
  }
  const rows = [5, 4, 3, 2, 1]
    .filter((r) => counts[r] > 0)
    .map(
      (r) => `
        <li class="mastery-row">
          ${rankHtml(r, { label: "" })}
          <span class="mastery-row__count"><b>${counts[r]}</b><small> 語</small>${known[r] ? `<small class="mastery-row__known">（うち知ってた ${known[r]}語）</small>` : ""}</span>
          <span class="mastery-row__gloss">${RANK_GLOSS[r]}</span>
        </li>`
    )
    .join("");
  container.innerHTML = `<ul class="mastery-rows" role="list">${rows}</ul>
    <p class="mastery-note">答えた記録から決める（予測ではない）。${RANK_RULE}最後に答えた時点の段。この端末の記録から。</p>${speedLines(speeds)}`;
}

// 段ごとの実測を出すのは、その段で 30 回答えてから（それより少ない回数の割合は揺れが大きい）
const MEASURED_MIN = 30;

// 思い出す速さ（Batch 70。D1 §3.3）: 「思い出す速さ すぐ N語 ・ ふつう N語 ・ 時間がかかる N語」。数えるのは段 2〜4 で速さが出る語だけ（js/recallSpeed.js。
// 段 5 は名前の「即答」に入る）。0 語の語は出さず、1 語も無ければ行ごと出さない。
// 段ごとの実測: 「日をあけて問うと思い出せた 身についた 120回のうち108回 ・ 思い出せる 300回のうち246回」。材料は spelldash_mastery_meta の check.rank
// （その日の最初の答え〔前の答えから 1 日以上〕の、答える前の段 × 間隔の帯 × ○／× の数。js/masteryMeta.js noteRankCheck）を段ごとに足した数。
// 30 回からその段を出し（段 5 → 1）、1 段も無ければ行も注記も出さない。注記「この端末の記録。予測ではない。」。率（%）・順位・推移は出さない。読むだけ。
// 描くたびに読むのは check.rank の写しだけ（meta 全体を写さない）。別のタブで答えた後の描き直し（同期・マイ単語帳）では保存を読み直す（PR #180 のレビュー 5）
function speedLines(speeds) {
  const items = ["fast", "normal", "slow"].filter((k) => speeds[k] > 0).map((k) => `${SPEED_LABEL[k]} ${speeds[k]}語`);
  const speedHtml = items.length ? `<p class="mastery-speed"><span class="mastery-speed__label">思い出す速さ</span> ${items.join(" ・ ")}</p>` : "";
  const check = getRankCheck(); // check.rank だけの写し（別のタブが書いた後は読み直す。js/masteryMeta.js）
  const measured = [5, 4, 3, 2, 1]
    .map((r) => {
      let ok = 0;
      let n = 0;
      for (const v of Object.values(check[r] ?? {})) {
        if (!Array.isArray(v)) continue;
        ok += Number(v[0]) || 0;
        n += (Number(v[0]) || 0) + (Number(v[1]) || 0);
      }
      return { r, ok, n };
    })
    .filter((m) => m.n >= MEASURED_MIN)
    .map((m) => `${RANK_NAMES[m.r]} ${m.n}回のうち${m.ok}回`);
  const measuredHtml = measured.length
    ? `<p class="mastery-measured"><span class="mastery-speed__label">日をあけて問うと思い出せた</span> ${measured.join(" ・ ")}</p><p class="mastery-measured-note">この端末の記録。予測ではない。</p>`
    : "";
  return speedHtml || measuredHtml ? `<div class="mastery-speed-block">${speedHtml}${measuredHtml}</div>` : "";
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
              <button type="button" class="learned-item__en mono" data-word-detail="${w.id}">${w.term}</button>
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
      ? `<p class="known-words">${known.slice(0, 200).map((w) => `<button type="button" class="known-words__item mono" data-word-detail="${w.id}" title="${w.ja}">${w.term}</button>`).join("")}${known.length > 200 ? `<span class="known-words__more">ほか ${known.length - 200}語</span>` : ""}</p>`
      : '<p class="muted">まだない。</p>';
  }
}
