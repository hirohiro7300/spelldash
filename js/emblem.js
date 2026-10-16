// 学習のランクの紋章の絵（21 段。ランクは js/level.js LEARNING_RANKS・learningRankOf。絵は scripts/build-emblems.mjs が作る assets/images/emblems/<段>-<n>.webp）。
// 絵は飾り: alt="" と aria-hidden。ランクの名前の文字はそのまま出す（絵だけで段を伝えない）。読めない絵（読み込み中・オフライン・404）は
// 透明のまま枠だけ空ける（壊れた画像の印を出さない。css/game.css .rank-up__emblem・css/pages.css .level-bar__emblem・.rank-list__emblem）。
import { getLevelState, getTotalXp, nextLearningRankOf, LEARNING_RANKS, LEARNING_RANK_TIERS } from "./level.js";

const DIR = "/assets/images/emblems/";
const TIER_IDS = new Set(LEARNING_RANK_TIERS.map((tier) => tier.id));

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

// 絵が読めたら見せる（is-ready）。読めなかった絵（オフライン・404）は、どこでも「出さずに、次に描くときに読み直す」:
//   既定 — 要素ごと外す。枠は外側の箱が持つ（幕の .rank-up__emblem・一覧の .rank-list__emblem）。空の箱は次に描くとき（一覧を開き直す・同期・通信の戻り）に読み直す
//   keep — 要素が自分で枠を持つとき（行の .level-bar__emblem: 外すと字が寄って行が動く）は、is-gone の印を付けて透明のまま残す。行は描き直しのたびに作り直す
// 先読みで手元にある絵は、足した時点で complete（開いた瞬間から出る）
export function revealEmblem(img, { keep = false } = {}) {
  if (!img) return;
  const ready = () => img.classList.add("is-ready");
  const gone = () => {
    if (keep) img.classList.add("is-gone");
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

// ===== 先読み（手の空いたとき。答えのタスクの外） =====
// 幕に出るのは新しいランクの絵なので、読むのは次のランクの幕用の絵（今のランクの絵は幕に出ないので読まない）。参照を持って画像のキャッシュに残す。
// reach（XP）を渡すと、今の XP にその分を足して届きうる先のランクまで読む（多くて PRELOAD_MAX 枚）: XP を回の終わりにまとめて足す Challenge／Daily は、
// 1 レベルごとに上がる下の段で 2 つ以上先へ飛ぶことがある（初めての人の Challenge で木 1 → 銅 1 など）。
// 回の途中でランクが変わったら（幕を出した・60 秒の回と腕試しで幕を回の終わりに回した）、その時点の次のランクを読み直す（js/game.js）
export const PRELOAD_MAX = 3;
const kept = new Map();

// 読む絵のランク（低い順）: 次のランクと、xp + reach で届くところまでの先のランク。多くて PRELOAD_MAX。神 3 に届いていれば無し
export function preloadRanks({ xp = getTotalXp(), reach = 0 } = {}) {
  const level = getLevelState(xp).level;
  const next = nextLearningRankOf(level);
  if (!next) return [];
  const far = reach > 0 ? getLevelState(xp + reach).level : level;
  return LEARNING_RANKS.filter((rank) => rank === next || (rank.level > next.level && rank.level <= far)).slice(0, PRELOAD_MAX);
}

export function preloadEmblems(opts = {}) {
  for (const rank of preloadRanks(opts)) {
    const src = emblemSrc(rank);
    if (!src || kept.has(src)) continue;
    const img = new Image();
    img.decoding = "async";
    img.addEventListener("error", () => kept.delete(src), { once: true }); // 読めなかった（オフライン等）なら次の先読みでもう一度
    img.src = src;
    kept.set(src, img);
  }
}

// 回の初め（startGame）と、回の途中でランクが変わったときに呼ぶ。requestIdleCallback が無い端末（Safari）は少し遅らせた setTimeout。
// XP は走るときに読む（呼んだ答えのタスクで足した XP も入る）
export function scheduleEmblemPreload({ reach = 0 } = {}) {
  const run = () => {
    try {
      preloadEmblems({ reach });
    } catch {
      // 先読みは飾り。失敗しても回は続ける
    }
  };
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 3000 });
  else setTimeout(run, 1200);
}
