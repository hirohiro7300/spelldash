import { getStreak, hasPlayedToday } from "./level.js";
import { icon } from "./icons.js";

// ===== ホームの「数字1行」 =====
// 連続日数だけを静かなチップ1つで。今週の学習日は「覚えた単語」カードと学習データにある。
// レベル・ランク・XP は学習データとプロフィールにある。ホームは「今日やる」ための最小限だけ。

export function renderTodayStrip() {
  const el = document.getElementById("todayStrip");
  if (!el) return;

  const streak = getStreak();
  const played = hasPlayedToday();

  const streakText = streak.current > 0 ? `${streak.current}日連続` : "連続記録 0日";

  el.innerHTML = `
    <span class="strip__chip strip__chip--streak${played ? " strip__chip--on" : ""}" title="連続プレイ日数（ベスト ${streak.best}日）">${icon("flame", { size: 14 })}${streakText}${played ? "" : `<small>今日はまだ</small>`}</span>
  `;
}

// レベルアップ時の演出フック（ホームにレベル表示は無いので何もしない。呼び出し元との互換のため残す）
export function pulseTodayStrip() {}
