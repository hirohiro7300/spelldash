import { getLevelState } from "./level.js";

// ページ内に #levelBar があればレベルバーを描画する（無いページでは何もしない）
export function renderLevelBar() {
  const container = document.getElementById("levelBar");
  if (!container) return;

  const state = getLevelState();
  const percent = Math.min(100, Math.round((state.currentXp / state.neededXp) * 100));

  container.innerHTML = `
    <div class="level-bar__badge">Lv.${state.level}</div>
    <div class="level-bar__body">
      <div class="level-bar__head">
        <span class="level-bar__title">${state.title}</span>
        <span class="level-bar__xp">${state.currentXp} / ${state.neededXp} XP</span>
      </div>
      <div class="progress-bar progress-bar--slim">
        <div class="progress-bar__fill" style="width: ${percent}%;"></div>
      </div>
    </div>
  `;
}

// レベルアップ演出（バッジを一瞬光らせる）
export function playLevelUpEffect() {
  const container = document.getElementById("levelBar");
  if (!container) return;

  container.classList.remove("level-bar--levelup");
  void container.offsetWidth;
  container.classList.add("level-bar--levelup");
}
