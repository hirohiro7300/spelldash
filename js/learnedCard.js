import { computeCategoryProgress, computeLegacyLearnedCount } from "./categoryProgress.js";
import { getRecalledTodayCount } from "./studyQueue.js";
import { getLearnedDelta7, recordGrowthSnapshot, getWeekGoal, getThisWeekDays } from "./growthLog.js";
import { getLearnedWordsToday, getLearnedCounts } from "./learnedWords.js";
import { getGenre, genreLabel, applyGenre } from "./genres.js";
import { getWordsByCategory } from "./wordStore.js";
import { getWordStats } from "./storage.js";
import { classifyWord } from "./categoryProgress.js";
import { icon } from "./icons.js";

// ===== ホーム「覚えた単語」カード =====
// 「いくつ覚えたか」を一等地に常設する（覚えた実感 v1）。
// 覚えた = 一度つまずいてから自力で思い出せた語（learning＋習得）。初見で知っていた語は別枠。
// 数字だけでなく「今日覚えた語」を語で見せる。

export function renderLearnedCard() {
  const el = document.getElementById("learnedCard");
  if (!el) return;

  const activeId = localStorage.getItem("spelldash_category") || "all";
  const current = activeId === "all" ? null : computeCategoryProgress(activeId)[0] ?? null; // 「すべて」のときは null（カテゴリの行は出さない）
  const today = getRecalledTodayCount();
  const counts = getLearnedCounts(); // パックの語も含む。学習データの概要と同じ数
  const learnedTotal = counts.learned;
  recordGrowthSnapshot({ ...counts, legacyLearned: computeLegacyLearnedCount });
  const week = getLearnedDelta7(learnedTotal);

  // 0 の項目は出さない（0 は情報ではない）
  let currentLine = current
    ? [`${current.label}: 覚えた ${current.learned} / ${current.total}`, current.weak > 0 && `苦手 ${current.weak}`, current.known > 0 && `知ってた ${current.known}`]
        .filter(Boolean)
        .join(" ・ ")
    : "";
  // ジャンルで絞っている時は、そのジャンルの進みを見せる
  const genre = getGenre();
  let genreNonZero = false;
  if (genre && current) {
    const stats = getWordStats();
    const words = applyGenre(getWordsByCategory(current.id), genre);
    const seen = new Set();
    let learnedG = 0;
    let weakG = 0;
    let totalG = 0;
    for (const w of words) {
      if (seen.has(w.id)) continue;
      seen.add(w.id);
      totalG++;
      const st = classifyWord(stats[w.id]);
      if (st === "learning" || st === "mastered") learnedG++;
      if (st === "weak") weakG++;
    }
    currentLine = `${genreLabel(genre)}: 覚えた ${learnedG} / ${totalG}${weakG > 0 ? ` ・ 苦手 ${weakG}` : ""}${learnedG === totalG && totalG > 0 ? " ・ 全部済み" : ""}`;
    genreNonZero = learnedG + weakG > 0;
  }

  const learnedToday = getLearnedWordsToday();
  const todayLine =
    learnedToday.length > 0
      ? `今日覚えた: ${learnedToday.slice(0, 4).map((w) => `<b title="${w.ja}">${w.en}</b>`).join("・")}${learnedToday.length > 4 ? ` ほか${learnedToday.length - 4}語` : ""}`
      : "今日はまだ。1セットで1語は増える";

  // 今週の学習日（月〜日）と週の目標。毎日でなくてよい設計
  const goal = getWeekGoal();
  const days = getThisWeekDays();
  const activeDays = days.filter((d) => d.active).length;
  const dots = days
    .map((d) => `<i class="${d.active ? "on" : ""}${d.isToday ? " today" : ""}${d.isFuture ? " future" : ""}" title="${d.date}"></i>`)
    .join("");
  // 「5/4日」のような分母超えの分数は出さない。数字を先に、達成は末尾に 1 語
  const weekLine = `今週 <b>${activeDays}</b>日 ・ 目標 ${goal}日${activeDays >= goal ? " 達成" : ""} ${dots}`;

  // 内訳の行は数字が全部 0 のときは出さない（0 の羅列は情報ではない）
  const showBreakdown = current ? (genre ? genreNonZero : current.learned + current.weak > 0) : false;

  // 折りたたみの見出しにも数字を出す（「覚えた単語 28」。Daily Dash の名前は入口のある #playModes だけに）
  const summary = document.querySelector("#homeMore > summary > span");
  if (summary) summary.textContent = `覚えた単語 ${learnedTotal}`;

  el.innerHTML = `
    <div class="learned-card__main">
      <span class="learned-card__label">覚えた単語</span>
      <span class="learned-card__num">${learnedTotal}</span>
      ${week > 0 ? `<span class="learned-card__today">7日で +${week}</span>` : today > 0 ? `<span class="learned-card__today">今日 ${today}語</span>` : ""}
    </div>
    <div class="learned-card__today-words">${todayLine}</div>
    ${showBreakdown ? `<div class="learned-card__cat">${currentLine}</div>` : ""}
    <div class="learned-card__week" aria-label="今週の学習日" title="週の目標はプロフィールの学習の設定で変えられます">${weekLine}</div>
    <a class="learned-card__link" href="./stats.html#learnedWords">覚えた単語帳を見る${icon("arrowRight", { size: 14 })}</a>
  `;
}
