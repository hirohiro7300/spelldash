import { isUnlocked, setsUntil } from "./unlocks.js";
import { isDailyPlayedToday } from "./dailyChallenge.js";

// ===== ほかの遊び方（Challenge・Daily Dash・Battle） =====
// 1画面目のモード切替をやめ、道の下に解放式の一覧として置く。
// Challenge は最初から、Daily は2セット、Battle は5セットで解放（既存ユーザーは最初から全部）。

export function renderPlayModes({ onChallenge, onDaily } = {}) {
  const el = document.getElementById("playModes");
  if (!el) return;

  const rows = [
    {
      id: "challenge",
      icon: "⏱",
      label: "Challenge",
      desc: "60秒で何語打てるか。記録に挑戦",
      action: `<button type="button" class="play-modes__go" data-mode="challenge">遊ぶ →</button>`
    },
    {
      id: "daily",
      icon: "⚡",
      label: "Daily Dash",
      desc: "毎日同じ10語で、全員と順位を競う",
      action: isDailyPlayedToday()
        ? `<button type="button" class="play-modes__go play-modes__go--ghost" data-mode="daily">今日の結果 →</button>`
        : `<button type="button" class="play-modes__go" data-mode="daily">挑戦 →</button>`
    },
    {
      id: "battle",
      icon: "⚔️",
      label: "Battle",
      desc: "CPU・友だちとタイピング対決",
      action: `<a class="play-modes__go" href="./battle.html">対戦 →</a>`
    }
  ];

  el.innerHTML = `
    <h3 class="play-modes__title">ほかの遊び方</h3>
    <ul class="play-modes__list">
      ${rows
        .map((r) => {
          const unlocked = isUnlocked(r.id);
          const left = setsUntil(r.id);
          return `<li class="play-modes__row${unlocked ? "" : " play-modes__row--locked"}" data-play-mode="${r.id}">
            <span class="play-modes__icon" aria-hidden="true">${r.icon}</span>
            <span class="play-modes__text"><b>${r.label}</b><span>${r.desc}</span></span>
            ${unlocked ? r.action : `<span class="play-modes__lock">🔒 あと${left}セットで解放</span>`}
          </li>`;
        })
        .join("")}
    </ul>
  `;

  el.querySelector('[data-mode="challenge"]')?.addEventListener("click", () => onChallenge?.());
  el.querySelector('[data-mode="daily"]')?.addEventListener("click", () => onDaily?.());
}
