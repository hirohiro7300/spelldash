import { getLevelState, getNextTitle } from "./level.js";

// ページ内に #levelBar があればレベルバーを描画する（無いページでは何もしない）
export function renderLevelBar() {
  const container = document.getElementById("levelBar");
  if (!container) return;

  const state = getLevelState();
  const percent = Math.min(100, Math.round((state.currentXp / state.neededXp) * 100));

  // 次の称号予告（あと少しで手が届く目標を常に見せる）
  const next = getNextTitle(state.level);
  const nextText = next
    ? `<span class="level-bar__next">あと${next.level - state.level}レベルで「${next.name}」</span>`
    : "";

  // XPを「あと何問」という行動の言葉に翻訳する（自力正解1問 ≈ 15XP。docs/PMF.md 候補C）
  const remainingWords = Math.max(1, Math.ceil((state.neededXp - state.currentXp) / 15));
  const remainingText = `<span class="level-bar__remaining">あと約${remainingWords}問正解でLv.${state.level + 1}</span>`;

  container.innerHTML = `
    <div class="level-bar__badge">Lv.${state.level}</div>
    <div class="level-bar__body">
      <div class="level-bar__head">
        <span class="level-bar__title">${state.title}${nextText}</span>
        <span class="level-bar__xp">${state.currentXp} / ${state.neededXp} XP</span>
      </div>
      <div class="progress-bar progress-bar--slim">
        <div class="progress-bar__fill" style="width: ${percent}%;"></div>
      </div>
      ${remainingText}
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
