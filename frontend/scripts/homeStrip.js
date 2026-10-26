import { getStreak, hasPlayedToday } from "./level.js";
import { isDailySetDone } from "./dailySet.js";
import { icon } from "./icons.js";

// ===== ホームの「数字1行」 =====
// 連続日数だけを静かなチップ1つで。今週の学習日は「覚えた単語」カードと学習データにある。
// レベル・ランク・XP は学習データとプロフィールにある。ホームは「今日やる」ための最小限だけ。

export function renderTodayStrip() {
  const el = document.getElementById("todayStrip");
  if (!el) return;

  const streak = getStreak();
  const played = hasPlayedToday();
  const done = isDailySetDone();

  // 0 日（まだ 1 セットもやっていない／途切れた朝）には 0 を見せない。1 セット終えれば「1日連続」として戻る
  if (streak.current === 0) {
    el.innerHTML = "";
    return;
  }

  const streakText = `${streak.current}日連続`;
  // 済みの見た目はセットが終わった日だけ。途中なら「途中」、まだなら「今日はまだ」
  const note = done ? "" : played ? "<small>途中</small>" : "<small>今日はまだ</small>";

  el.innerHTML = `
    <span class="strip__chip strip__chip--streak${done ? " strip__chip--on" : ""}" title="連続プレイ日数（ベスト ${streak.best}日）">${icon("flame", { size: 14 })}${streakText}${note}</span>
  `;
}

// レベルアップ時の演出フック（ホームにレベル表示は無いので何もしない。呼び出し元との互換のため残す）
export function pulseTodayStrip() {}
