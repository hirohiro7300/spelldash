// 学習のランクの紋章の絵（21 段。ランクは js/level.js RANKS・rankOf。絵は scripts/build-emblems.mjs が作る assets/images/emblems/<段>-<n>.webp）。
// 絵は飾り: alt="" と aria-hidden。ランクの名前の文字はそのまま出す（絵だけで段を伝えない）。読めない絵（読み込み中・オフライン・404）は
// 透明のまま枠だけ空ける（壊れた画像の印を出さない。css/game.css .rank-up__emblem・css/pages.css .level-bar__emblem・.rank-list__emblem）。
import { getLevelState, nextRankOf, rankOf, RANK_TIERS } from "./level.js";

const DIR = "/assets/images/emblems/";
const TIER_IDS = new Set(RANK_TIERS.map((tier) => tier.id));

// ランク → 絵の URL（幕は 224px、small は行と一覧の 96px。知らないランクは ""）
export function emblemSrc(rank, { small = false } = {}) {
  if (!rank || !TIER_IDS.has(rank.tier) || ![1, 2, 3].includes(rank.step)) return "";
  return `${DIR}${rank.tier}-${rank.step}${small ? "-sm" : ""}.webp`;
}

// 絵の要素の HTML（大きさは width／height で先に決める: 読み込みで行や幕の高さが動かない）
export function emblemImgHtml(rank, { small = false, className = "", size = small ? 28 : 112 } = {}) {
  const src = emblemSrc(rank, { small });
  if (!src) return "";
  return `<img class="${className}" src="${src}" width="${size}" height="${size}" alt="" aria-hidden="true" decoding="async" draggable="false">`;
}

// 絵が読めたら見せる（is-ready）。読めなければ要素ごと外す（枠は外側の箱か width／height の予約が持つ）。
// 先読みで手元にある絵は、足した時点で complete（開いた瞬間から出る）
export function revealEmblem(img, onGone = null) {
  if (!img) return;
  const ready = () => img.classList.add("is-ready");
  const gone = () => {
    if (onGone) onGone(img);
    else img.remove();
  };
  if (img.complete) {
    if (img.naturalWidth > 0) ready();
    else gone();
    return;
  }
  img.addEventListener("load", ready, { once: true });
  img.addEventListener("error", gone, { once: true });
}

// ===== 先読み（回の初めの手の空いたとき。答えのタスクの外） =====
// 幕に出るのは新しいランクの絵。今のランクと次のランクの幕用の絵（多くて 2 枚）を読んでおき、参照を持って画像のキャッシュに残す
const kept = new Map();

export function preloadEmblems(level = getLevelState().level) {
  for (const rank of [rankOf(level), nextRankOf(level)]) {
    const src = emblemSrc(rank);
    if (!src || kept.has(src)) continue;
    const img = new Image();
    img.decoding = "async";
    img.addEventListener("error", () => kept.delete(src), { once: true }); // 読めなかった（オフライン等）なら次の回でもう一度
    img.src = src;
    kept.set(src, img);
  }
}

// 回の初め（startGame）に呼ぶ。requestIdleCallback が無い端末（Safari）は少し遅らせた setTimeout
export function scheduleEmblemPreload() {
  const run = () => {
    try {
      preloadEmblems();
    } catch {
      // 先読みは飾り。失敗しても回は続ける
    }
  };
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 3000 });
  else setTimeout(run, 1200);
}
