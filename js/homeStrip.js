import { getStreak, hasPlayedToday } from "./level.js";
import { getWeekGoal, getActiveDaysThisWeek } from "./growthLog.js";
import { icon } from "./icons.js";

// ===== ホームの「数字1行」 =====
// 連続日数と今週の学習日だけを、静かなチップ2つで1行に。
// レベル・ランク・XP は学習データとプロフィールにある。ホームは「今日やる」ための最小限だけ。

export function renderTodayStrip() {
  const el = document.getElementById("todayStrip");
  if (!el) return;

  const streak = getStreak();
  const played = hasPlayedToday();
  const goal = getWeekGoal();
  const days = getActiveDaysThisWeek();

  const streakText = streak.current > 0 ? `${streak.current}日連続` : "連続記録 0日";

  el.innerHTML = `
    <span class="strip__chip strip__chip--streak${played ? " strip__chip--on" : ""}" title="連続プレイ日数（ベスト ${streak.best}日）">${icon("flame", { size: 14 })}${streakText}${played ? "" : `<small>今日はまだ</small>`}</span>
    <span class="strip__chip${days >= goal ? " strip__chip--on" : ""}" title="週の目標はプロフィールで変えられます">今週 ${days}/${goal}日</span>
  `;
}

// レベルアップ時の演出フック（ホームにレベル表示は無いので何もしない。呼び出し元との互換のため残す）
export function pulseTodayStrip() {}
