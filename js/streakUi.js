import { getStreak, hasPlayedToday, SHIELD_MAX, SHIELD_EARN_EVERY } from "./level.js";
import { hasumiStreakLine } from "./hasumi.js";

// ホーム画面のストリークカード。
// 「今日やったか / やっていないか」を常に見せて、毎日開く理由を作る

function todayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function renderStreakCard() {
  const container = document.getElementById("streakCard");
  if (!container) return;

  const streak = getStreak();
  const playedToday = hasPlayedToday();

  let statusHtml;
  if (playedToday) {
    statusHtml = `<span class="streak-card__status streak-card__status--done">今日クリア ✓</span>`;
  } else if (streak.current > 0) {
    statusHtml = `<span class="streak-card__status streak-card__status--pending">今日プレイで ${streak.current + 1} 日目</span>`;
  } else {
    statusHtml = `<span class="streak-card__status streak-card__status--pending">今日から連続記録を始めよう</span>`;
  }

  // シールドで守られた日は、それを伝える（黙って守ると価値が伝わらない）
  const savedNote =
    streak.shieldSavedOn === todayString()
      ? `<span class="streak-card__saved">🛡️ シールドが連続記録を守りました</span>`
      : "";

  // はちゃんの一言（記録更新が近い時などだけ・出しゃばらない）
  const hasumiLine = hasumiStreakLine();
  const hasumiNote = hasumiLine ? `<span class="streak-card__hasumi">${hasumiLine}</span>` : "";

  const shieldIcons = Array.from({ length: SHIELD_MAX }, (_, i) =>
    i < (streak.shields ?? 0)
      ? `<span class="streak-card__shield">🛡️</span>`
      : `<span class="streak-card__shield streak-card__shield--empty">🛡️</span>`
  ).join("");

  container.classList.toggle("streak-card--active", playedToday);
  container.innerHTML = `
    <div class="streak-card__flame ${streak.current > 0 && playedToday ? "" : "streak-card__flame--off"}">🔥</div>
    <div class="streak-card__main">
      <div class="streak-card__count">
        <strong>${streak.current}</strong><span>日連続</span>
      </div>
      ${statusHtml}
      ${savedNote}
      ${hasumiNote}
    </div>
    <div class="streak-card__side">
      <div class="streak-card__shields" title="${SHIELD_EARN_EVERY}日連続ごとに1枚獲得。休んだ日に自動で使われて連続記録を守ります（最大${SHIELD_MAX}枚）">
        ${shieldIcons}
      </div>
      <span class="streak-card__best">ベスト ${streak.best} 日</span>
    </div>
  `;
}
