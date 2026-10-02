import { getLevelState } from "./level.js";
import { renderTodayStrip, pulseTodayStrip } from "./homeStrip.js";

// ページ内に #levelBar があればレベルバーを描画する（無いページでは何もしない）
export function renderLevelBar() {
  renderTodayStrip(); // ホームの数字1行（#levelBar が無いページでも）
  const container = document.getElementById("levelBar");
  if (!container) return;

  const state = getLevelState();
  // 1行だけ（CONCEPT 原則9: XP・レベルは小さな文字で1行に）。進捗バー・昇格予告・問数は出さない。
  // 「経験値」の語は出さず、次のレベルまでの残りだけ（分析タブのタイルと同じラベルで別の数を並べない）
  const remaining = Math.max(0, state.neededXp - state.currentXp);
  container.innerHTML = `<span class="level-bar__line">${state.title} ・ Lv.${state.level} ・ 次のレベルまで <span class="mono">${remaining}</span></span>`;
}

// レベルアップ演出（ホームの数字 1 行を一瞬強調するだけ。レベルバーの点滅は Batch 38 でやめた）
export function playLevelUpEffect() {
  pulseTodayStrip();
}
