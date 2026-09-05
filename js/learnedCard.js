import { computeCategoryProgress } from "./categoryProgress.js";
import { getRecalledTodayCount } from "./studyQueue.js";
import { getWeekDots } from "./dailySet.js";

// ===== ホーム「覚えた単語」カード =====
// 「いくつ覚えたか」を一等地に常設する（覚えた実感 v1）。
// 覚えた = 覚えかけ＋習得。選択中カテゴリの内訳も1行添える。

export function renderLearnedCard() {
  const el = document.getElementById("learnedCard");
  if (!el) return;

  const rows = computeCategoryProgress();
  if (rows.length === 0) return;

  const all = rows[0];
  const activeId = localStorage.getItem("spelldash_category") || "all";
  const current = rows.find((r) => r.id === activeId) ?? all;
  const today = getRecalledTodayCount();

  const currentLine =
    current.id === "all"
      ? `習得 ${all.mastered} ・ 覚えかけ ${all.learning} ・ 苦手 ${all.weak}`
      : `${current.label}: 覚えた ${current.learned} / ${current.total} ・ 苦手 ${current.weak}`;

  el.innerHTML = `
    <div class="learned-card__main">
      <span class="learned-card__label">🧠 覚えた単語</span>
      <span class="learned-card__num">${all.learned}<small> / ${all.total}</small></span>
      ${today > 0 ? `<span class="learned-card__today">今日 +${today}</span>` : ""}
    </div>
    <div class="learned-card__cat">${currentLine}</div>
    <div class="learned-card__week" aria-label="今週のセット完了">今週 ${getWeekDots().map((d) => `<i class="${d.done ? "on" : ""}${d.isToday ? " today" : ""}" title="${d.date}"></i>`).join("")}</div>
    <a class="learned-card__link" href="./stats.html#categories">カテゴリ別の一覧を見る →</a>
  `;
}
