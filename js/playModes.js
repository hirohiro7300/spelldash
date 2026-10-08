import { isUnlocked, setsUntil } from "./unlocks.js";
import { isDailyPlayedToday } from "./dailyChallenge.js";

// ===== ほかの遊び方（Challenge・Daily Dash・Battle） =====
// 机の幕板に、静かな 1 行（ほかの遊び方 チャレンジ ・ Daily Dash ・ バトル）。
// Challenge は最初から、Daily は2セット、Battle は5セットで解放（既存ユーザーは最初から全部）。
// 錠は文字だけ（あと1セットで解放）。鍵のアイコンは出さない（部屋の中で錠に見せない）。

export function renderPlayModes({ onChallenge, onDaily } = {}) {
  const el = document.getElementById("playModes");
  if (!el) return;

  const rows = [
    {
      id: "challenge",
      action: `<button type="button" class="play-modes__go" data-mode="challenge">チャレンジ<span class="sr-only">: 60秒で何語打てるか</span></button>`
    },
    {
      id: "daily",
      action: isDailyPlayedToday()
        ? `<button type="button" class="play-modes__go play-modes__go--ghost" data-mode="daily"><span class="lat">Daily Dash</span><span class="sr-only">: 今日の結果を見る</span></button>`
        : `<button type="button" class="play-modes__go" data-mode="daily"><span class="lat">Daily Dash</span><span class="sr-only">: 毎日同じ問題で60秒。順位が出る</span></button>`,
      locked: `<span class="play-modes__text"><b class="lat">Daily Dash</b></span>`
    },
    {
      id: "battle",
      action: `<a class="play-modes__go" href="./battle.html">バトル<span class="sr-only">: CPU・友だちと対戦</span></a>`,
      locked: `<span class="play-modes__text"><b>バトル</b></span>`
    }
  ];

  el.innerHTML = `
    <h2 class="play-modes__title">ほかの遊び方</h2>
    <ul class="play-modes__list">
      ${rows
        .map((r) => {
          const unlocked = isUnlocked(r.id);
          const left = setsUntil(r.id);
          return `<li class="play-modes__row${unlocked ? "" : " play-modes__row--locked"}" data-play-mode="${r.id}">${
            unlocked ? r.action : `${r.locked}<span class="play-modes__lock">あと${left}セットで解放</span>`
          }</li>`;
        })
        .join("")}
    </ul>
  `;

  el.querySelector('[data-mode="challenge"]')?.addEventListener("click", () => onChallenge?.());
  el.querySelector('[data-mode="daily"]')?.addEventListener("click", () => onDaily?.());
}
