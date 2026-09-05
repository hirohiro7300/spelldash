import { isDailySetDone, getSetSize, getSetsToday } from "./dailySet.js";
import { getDueReviewCount } from "./studyQueue.js";
import { isDailyPlayedToday } from "./dailyChallenge.js";

// ===== ホームの最優先CTA「今日のセット」 =====
// 1画面目で「次に押すボタン」が1つに決まる状態を作る（WF案A）。

export function renderTodayCta() {
  const el = document.getElementById("todayCta");
  if (!el) return;

  const done = isDailySetDone();
  const size = getSetSize();
  const due = getDueReviewCount();
  const dailyNote = isDailyPlayedToday() ? "" : `<span class="today-cta__daily">⚡ Daily Dashも未挑戦</span>`;

  if (done) {
    const sets = getSetsToday();
    el.className = "today-cta today-cta--done";
    el.innerHTML = `
      <div class="today-cta__text">
        <span class="today-cta__title">✓ 今日のぶん完了${sets > 1 ? `（${sets}セット）` : ""}</span>
        <span class="today-cta__sub">${due > 0 ? `復習 ${due}語 がまだ残っています` : "明日また少しだけ。"}</span>
      </div>
      <button type="button" class="today-cta__button today-cta__button--ghost" id="todayCtaButton">もう1セット（${size}語）</button>
      ${dailyNote}
    `;
    return;
  }

  el.className = "today-cta";
  el.innerHTML = `
    <div class="today-cta__text">
      <span class="today-cta__title">今日のセット <small>${size}語 ・ 約5分</small></span>
      <span class="today-cta__sub">${due > 0 ? `↻ 復習 ${due}語 待ち ・ 新しい単語も少し` : "新しい単語と苦手をバランスよく"}</span>
    </div>
    <button type="button" class="today-cta__button" id="todayCtaButton">▶ 始める</button>
    ${dailyNote}
  `;
}
