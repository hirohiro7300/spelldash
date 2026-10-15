import { getLevelState, RANKS } from "./level.js";
import { renderTodayStrip, pulseTodayStrip } from "./homeStrip.js";
import { emblemImgHtml, revealEmblem } from "./emblem.js";

// ページ内に #levelBar があればレベルバーを描画する（無いページでは何もしない）。#rankList があればランクの一覧も（学習データの分析タブ）
export function renderLevelBar() {
  renderTodayStrip(); // ホームの数字1行（#levelBar が無いページでも）
  const container = document.getElementById("levelBar");
  if (!container) return;

  const state = getLevelState();
  // 1行だけ（CONCEPT 原則9: XP・レベルは小さな文字で1行に）。進捗バー・昇格予告・問数は出さない。
  // 「経験値」の語は出さず、次のレベルまでの残りだけ（分析タブのタイルと同じラベルで別の数を並べない）
  const remaining = Math.max(0, state.neededXp - state.currentXp);
  // ランクの名前の前に小さな紋章（28 px。今のランク。js/emblem.js）。名前の文字はそのまま残す（絵だけで段を伝えない）。
  // 大きさは width／height で先に取るので、絵が読めても読めなくても行の高さ・折り返しは変わらない（読めない絵は透明のまま。外さない）
  container.innerHTML = `${emblemImgHtml(state.rank, { small: true, className: "level-bar__emblem" })}<span class="level-bar__line">${state.rank.name} ・ Lv.${state.level} ・ 次のレベルまで <span class="mono">${remaining}</span></span>`;
  revealEmblem(container.querySelector(".level-bar__emblem"), () => {});
  renderRankList(state.rank);
}

// ===== ランクの一覧（#levelBar の下の畳んだ「ランクの一覧」） =====
// 21 段を下（木 1）から上（神 3）へ: 多くの人のランクは下の方なので、開いてすぐ今のランクと次のランクが見え、Lv の数も上から下へ増える。
// 行は「紋章・名前・Lv.N から」、今のランクに「今」の札（色だけに頼らない）。読み上げは 1 行 1 文（「銀 2、レベル 15 から、今のランク」の sr-only。
// 見た目の部品は aria-hidden）。紋章は開いたときに初めて読む（閉じている間は img を置かない＝0 枚。枠の大きさは先に取ってある）。
// 描き直し（同期）では畳みを作り直さず、今の印だけ付け替える（開いたまま・読んだ絵もそのまま）
function renderRankList(current) {
  const host = document.getElementById("rankList");
  if (!host) return;
  let details = host.querySelector("details");
  if (!details) {
    host.innerHTML = `<details class="rank-list"><summary class="rank-list__summary">ランクの一覧</summary><ol class="rank-list__items">${RANKS.map(
      (rank) => `<li class="rank-list__item"><span class="sr-only"></span><span class="rank-list__row" aria-hidden="true"><span class="rank-list__emblem"></span><span class="rank-list__name">${rank.name}</span><span class="rank-list__lv">Lv.${rank.level} から</span></span></li>`
    ).join("")}</ol></details>`;
    details = host.querySelector("details");
    details.addEventListener("toggle", () => {
      if (details.open) fillRankEmblems(details);
    });
  }
  details.querySelectorAll(".rank-list__item").forEach((li, i) => {
    const rank = RANKS[i];
    const now = rank.name === current.name;
    li.classList.toggle("is-now", now);
    li.querySelector(".sr-only").textContent = `${rank.name}、レベル ${rank.level} から${now ? "、今のランク" : ""}`; // 読み上げは「Lv.」を「レベル」に（「エルブイ」と読まれない）
    const tag = li.querySelector(".rank-list__now");
    if (now && !tag) li.querySelector(".rank-list__row").insertAdjacentHTML("beforeend", `<span class="rank-list__now">今</span>`);
    if (!now && tag) tag.remove();
  });
  if (details.open) fillRankEmblems(details);
}

// 開いたときに 21 段の小さい紋章を置く（1 度だけ。読めない絵は透明のまま枠に残す）
function fillRankEmblems(details) {
  details.querySelectorAll(".rank-list__emblem").forEach((box, i) => {
    if (box.firstChild) return;
    box.innerHTML = emblemImgHtml(RANKS[i], { small: true, size: 32 });
    revealEmblem(box.firstChild, () => {});
  });
}

// レベルアップ演出（ホームの数字 1 行を一瞬強調するだけ。レベルバーの点滅は Batch 38 でやめた）
export function playLevelUpEffect() {
  pulseTodayStrip();
}
