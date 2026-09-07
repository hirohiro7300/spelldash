import { computeCategoryProgress } from "./categoryProgress.js";
import { getRecalledTodayCount } from "./studyQueue.js";
import { getLearnedDelta7, recordGrowthSnapshot, getWeekGoal, getThisWeekDays } from "./growthLog.js";
import { getLearnedWordsToday } from "./learnedWords.js";

// ===== ホーム「覚えた単語」カード =====
// 「いくつ覚えたか」を一等地に常設する（覚えた実感 v1）。
// 覚えた = 一度つまずいてから自力で思い出せた語（覚えかけ＋習得）。初見で知っていた語は別枠。
// 数字だけでなく「今日覚えた語」を語で見せる。

export function renderLearnedCard() {
  const el = document.getElementById("learnedCard");
  if (!el) return;

  const rows = computeCategoryProgress();
  if (rows.length === 0) return;

  const all = rows[0];
  const activeId = localStorage.getItem("spelldash_category") || "all";
  const current = rows.find((r) => r.id === activeId) ?? all;
  const today = getRecalledTodayCount();
  recordGrowthSnapshot({ learned: all.learned, mastered: all.mastered });
  const week = getLearnedDelta7(all.learned);

  const currentLine =
    current.id === "all"
      ? `覚えかけ ${all.learning} ・ 習得 ${all.mastered} ・ 苦手 ${all.weak} ・ 知ってた ${all.known}`
      : `${current.label}: 覚えた ${current.learned} / ${current.total} ・ 苦手 ${current.weak} ・ 知ってた ${current.known}`;

  const learnedToday = getLearnedWordsToday();
  const todayLine =
    learnedToday.length > 0
      ? `今日覚えた: ${learnedToday.slice(0, 4).map((w) => `<b title="${w.ja}">${w.en}</b>`).join("・")}${learnedToday.length > 4 ? ` ほか${learnedToday.length - 4}語` : ""}`
      : "今日はまだ。1セットで1語は覚えられるよ";

  // 今週の学習日（月〜日）と週の目標。毎日でなくてよい設計
  const goal = getWeekGoal();
  const days = getThisWeekDays();
  const activeDays = days.filter((d) => d.active).length;
  const dots = days
    .map((d) => `<i class="${d.active ? "on" : ""}${d.isToday ? " today" : ""}${d.isFuture ? " future" : ""}" title="${d.date}"></i>`)
    .join("");
  const weekLine =
    activeDays >= goal
      ? `🎯 今週の目標達成 ${activeDays}/${goal}日 ${dots}`
      : `今週 <b>${activeDays}</b>/${goal}日 ${dots}`;

  el.innerHTML = `
    <div class="learned-card__main">
      <span class="learned-card__label">🧠 覚えた単語</span>
      <span class="learned-card__num">${all.learned}<small> / ${all.total}</small></span>
      ${week > 0 ? `<span class="learned-card__today">今週 +${week}</span>` : today > 0 ? `<span class="learned-card__today">今日 ${today}語</span>` : ""}
    </div>
    <div class="learned-card__today-words">${todayLine}</div>
    <div class="learned-card__cat">${currentLine}</div>
    <div class="learned-card__week" aria-label="今週の学習日" title="週の目標はプロフィールの学習の設定で変えられます">${weekLine}</div>
    <a class="learned-card__link" href="./stats.html#learnedWords">覚えた単語帳を見る →</a>
  `;
}
