import { getLevelState } from "./level.js";
import { renderTodayStrip, pulseTodayStrip } from "./homeStrip.js";

// ページ内に #levelBar があればレベルバーを描画する（無いページでは何もしない）
export function renderLevelBar() {
  renderTodayStrip(); // ホームの数字1行（#levelBar が無いページでも）
  const container = document.getElementById("levelBar");
  if (!container) return;

  const state = getLevelState();
  // 1行だけ（CONCEPT 原則9: XP・レベルは小さな文字で1行に）。進捗バー・昇格予告・問数は出さない
  container.innerHTML = `<span class="level-bar__line">${state.title} ・ Lv.${state.level} ・ 経験値 <span class="mono">${state.currentXp}/${state.neededXp}</span></span>`;
}

// レベルアップ演出（ホームの数字 1 行を一瞬強調するだけ。レベルバーの点滅は Batch 38 でやめた）
export function playLevelUpEffect() {
  pulseTodayStrip();
}
