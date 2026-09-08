import { getStreak, hasPlayedToday, getLevelState, getNextTitle } from "./level.js";
import { getWeekGoal, getActiveDaysThisWeek } from "./growthLog.js";

// ===== ホームの「数字1行」 =====
// ストリーク・レベル・週の目標を、カード3枚ではなくチップ3つの1行にまとめる。
// 詳しい数字は学習データにある。ホームは「今日やる」ための最小限だけ。

export function renderTodayStrip() {
  const el = document.getElementById("todayStrip");
  if (!el) return;

  const streak = getStreak();
  const played = hasPlayedToday();
  const level = getLevelState();
  const next = getNextTitle(level.level);
  const goal = getWeekGoal();
  const days = getActiveDaysThisWeek();
  const remainingWords = Math.max(1, Math.ceil((level.neededXp - level.currentXp) / 15));

  const streakText =
    streak.current > 0
      ? `${streak.current}日連続${played ? " ✓" : `・今日で${streak.current + 1}日目`}`
      : played
        ? "今日クリア ✓"
        : "今日から連続記録";

  el.innerHTML = `
    <span class="strip__chip strip__chip--streak${played ? " strip__chip--on" : ""}" title="連続プレイ日数（ベスト ${streak.best}日・シールド ${streak.shields ?? 0}枚）">🔥 ${streakText}</span>
    <span class="strip__chip strip__chip--level" title="あと約${remainingWords}問正解でLv.${level.level + 1}${next ? `・あと${next.level - level.level}レベルで ${next.name}` : ""}">Lv.${level.level} <b>${level.title}</b><i class="strip__bar"><b style="width:${Math.min(100, Math.round((level.currentXp / level.neededXp) * 100))}%"></b></i></span>
    <span class="strip__chip${days >= goal ? " strip__chip--on" : ""}" title="週の目標はプロフィールで変えられます">📅 今週 ${days}/${goal}日${days >= goal ? " 達成" : ""}</span>
  `;
}

// レベルアップ時にレベルチップを一瞬光らせる
export function pulseTodayStrip() {
  const chip = document.querySelector("#todayStrip .strip__chip--level");
  if (!chip) return;
  chip.classList.remove("strip__chip--pop");
  void chip.offsetWidth;
  chip.classList.add("strip__chip--pop");
}
