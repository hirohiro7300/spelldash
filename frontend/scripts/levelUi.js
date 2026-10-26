import { getLevelState, LEARNING_RANKS } from "./level.js";
import { renderTodayStrip, pulseTodayStrip } from "./homeStrip.js";
import { emblemImgHtml, revealEmblem } from "./emblem.js";

// ページ内に #levelBar があればレベルバーを描画する（無いページでは何もしない）。#rankList があればランクの一覧も（学習データの分析タブ）
export function renderLevelBar() {
  renderTodayStrip(); // ホームの数字1行（#levelBar が無いページでも）
  const container = document.getElementById("levelBar");
  if (!container) return;

  const state = getLevelState();
  // 小さな文字の 1 行（CONCEPT 原則9: XP・レベルは小さな文字で1行に。細い幅だけ下の 2 行）。進捗バー・昇格予告・問数は出さない。
  // 「経験値」の語は出さず、次のレベルまでの残りだけ（分析タブのタイルと同じラベルで別の数を並べない）
  const remaining = Math.max(0, state.neededXp - state.currentXp);
  const rankLine = `${state.rank.name} ・ Lv.${state.level}`;
  const nextLine = `次のレベルまで ${remaining}`;
  // ランクの名前の前に小さな紋章（28 px。今のランク。js/emblem.js）。名前の文字はそのまま残す（絵だけで段を伝えない）。
  // 大きさは width／height で先に取るので、絵が読めても読めなくても行の高さ・折り返しは変わらない（読めない絵は is-gone の印で透明のまま。外さない）。
  // 1 行に収まる幅の行は 1 行、細い幅では「ランク ・ Lv」と「次のレベルまで N」の 2 行に決めて組む（fitLevelBar・css/pages.css .level-bar--one）
  container.dataset.em = String(rowEm(`${rankLine} ・ ${nextLine}`));
  container.innerHTML = `<span class="level-bar__probe" aria-hidden="true"></span>${emblemImgHtml(state.rank, { small: true, className: "level-bar__emblem" })}<span class="level-bar__line"><span class="level-bar__part">${rankLine}</span><span class="level-bar__sep"> ・ </span><span class="level-bar__part">次のレベルまで <span class="mono">${remaining}</span></span></span>`;
  revealEmblem(container.querySelector(".level-bar__emblem"), { keep: true });
  fitLevelBar(container);
  watchLevelBar(container);
  renderRankList(state.rank);
}

// ===== 学習データの行を 1 行にするか 2 行にするか（PR #178 のレビュー 3） =====
// 字の幅を測らずに決める（書体が届く前と後で同じ形・行の高さ）: 字の数から出した 1 行の幅の上限（em）× 今の字の大きさ（文字の拡大〔端末の文字の大きさ・
// アプリの文字の倍率〕も入った値。拡大は em の長さには掛からないので、ここで掛ける）＋紋章が、行の箱の中身の幅に収まれば 1 行
const EMBLEM_PX = 28 + 6; // 紋章 28px と字との間 6px（css/pages.css .level-bar の gap）

// 1 行の幅の上限（em）: 字ごとに、どの書体でもこれより広くならない幅で数える（全角 1・半角 0.65・空白 0.35）。PR #178 のレビュー 3 の実測（自前の書体・
// 代わりの書体・広い代わりの書体）でいちばん長い「レジェンド 3 ・ Lv.69 ・ 次のレベルまで 3499」は字だけで 21.1〜21.7em（見積もり 22.6em）
function rowEm(text) {
  let em = 0;
  for (const ch of text) em += ch === " " ? 0.35 : ch.codePointAt(0) > 0xff ? 1 : 0.65;
  return Math.round(em * 100) / 100;
}

function fitLevelBar(container) {
  const cs = getComputedStyle(container);
  const width = container.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  if (!(width > 0)) return; // 隠れている（分析タブ以外を開いている）: 出たときに watchLevelBar が決める
  const line = container.querySelector(".level-bar__line");
  const size = parseFloat(getComputedStyle(line ?? container).fontSize) || 12;
  container.classList.toggle("level-bar--one", Number(container.dataset.em) * size + EMBLEM_PX <= width);
}

// 行の幅が変わったら（画面の幅・タブを開いて隠れていた行が出た）決め直す。見張るのは行の幅だけを持つ高さ 0 の印（.level-bar__probe）:
// 行そのものを見張ると、1 行／2 行の付け替えで高さが変わり、同じ描画の中でもう一度知らせが来る（ResizeObserver の輪）
let levelBarWatch = null;
function watchLevelBar(container) {
  if (typeof ResizeObserver !== "function") return;
  levelBarWatch?.disconnect();
  const probe = container.querySelector(".level-bar__probe");
  if (!probe) return;
  levelBarWatch = new ResizeObserver(() => fitLevelBar(container));
  levelBarWatch.observe(probe);
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
    host.innerHTML = `<details class="rank-list"><summary class="rank-list__summary">ランクの一覧</summary><ol class="rank-list__items">${LEARNING_RANKS.map(
      (rank) => `<li class="rank-list__item"><span class="sr-only"></span><span class="rank-list__row" aria-hidden="true"><span class="rank-list__emblem"></span><span class="rank-list__name">${rank.name}</span><span class="rank-list__lv">Lv.${rank.level} から</span></span></li>`
    ).join("")}</ol></details>`;
    const created = host.querySelector("details");
    details = created;
    created.addEventListener("toggle", () => {
      if (created.open) fillRankEmblems(created);
    });
    // オフラインで開いて読めなかった紋章は、通信が戻ったら開いたままでも読み直す（ページを開き直さなくてよい）
    window.addEventListener("online", () => {
      if (created.isConnected && created.open) fillRankEmblems(created);
    });
  }
  details.querySelectorAll(".rank-list__item").forEach((li, i) => {
    const rank = LEARNING_RANKS[i];
    const now = rank.name === current.name;
    li.classList.toggle("is-now", now);
    li.querySelector(".sr-only").textContent = `${rank.name}、レベル ${rank.level} から${now ? "、今のランク" : ""}`; // 読み上げは「Lv.」を「レベル」に（「エルブイ」と読まれない）
    const tag = li.querySelector(".rank-list__now");
    if (now && !tag) li.querySelector(".rank-list__row").insertAdjacentHTML("beforeend", `<span class="rank-list__now">今</span>`);
    if (!now && tag) tag.remove();
  });
  if (details.open) fillRankEmblems(details);
}

// 開いたときに 21 段の小さい紋章を置く。置いてある（読めた・読み込み中の）箱はそのまま。読めなかった絵は revealEmblem が箱から外すので
// （32px の枠は箱が持つ）、空の箱は次に開いたとき・同期で描き直したとき・通信が戻ったときに読み直す
function fillRankEmblems(details) {
  details.querySelectorAll(".rank-list__emblem").forEach((box, i) => {
    if (box.querySelector("img")) return;
    box.innerHTML = emblemImgHtml(LEARNING_RANKS[i], { small: true, size: 32 });
    revealEmblem(box.querySelector("img"));
  });
}

// レベルアップ演出（ホームの数字 1 行を一瞬強調するだけ。レベルバーの点滅は Batch 38 でやめた）
export function playLevelUpEffect() {
  pulseTodayStrip();
}
