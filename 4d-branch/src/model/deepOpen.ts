// 3 か月ごとの地図（版 7）を、時間で区切って開く（「全部ひらく」の代わり）。設計: 作業メモ SPEC v1 §5.8（見直し user-12・gaps-17）
//
// あるカードから「1 年先まで」開く = そのカードの先で、月が（そのカードの月 + 12）より前の判断・手をすべて開く。
// 月は今日から先へ減らないので、見えるのは「親の月が区切りより前」のカード（区切りの月の状態・行き先までが見える）。
// まとめた手（区切りより前）の行き先は 36 か月目でも見える（キャンバスでは 2029 年 11 月の列に置く）。
// 開いた後に見えるカードの数は、地図の番号の深さ優先の順（先は [i, i + size)）を 1 回なめて数える（O(先の数)。8 万枚でも 1 ms 前後）。
// 開いた後のキャンバス全体（すでに見えているカードを含む）が上限（3,000 枚）を超える区切りは開かず、見取り図で見るよう勧める（user-12）。

import type { CompiledMap } from "../deepmap/core/compile";
import type { Analysis } from "../deepmap/core/passes";
import { endsFrom } from "../deepmap/core/path";

/** 開いた後にキャンバスに見えるカードの上限（全体で） */
export const DEEP_OPEN_CAP = 3000;

/**
 * 1 つの区切りで開いた後の、並びの行の数の上限（行 = 開いた先で、先を開いていないカード。キャンバスの行の高さ 128 px で約 4 万 px:
 * 一番引いた 4% で 2 画面ほど）。これより縦に長い区切りは、キャンバスでは読めない（今日の「1 年先まで」は 1,400 行・18 万 px）ので
 * 見取り図で見る（見直し user-8）。今日の手ごとの「1 年先まで」（80〜180 行）は開ける
 */
export const DEEP_OPEN_ROWS = 320;

export interface DeepHorizon {
  /** 何か月先まで（12・24・36。地図の終わりまでなら、その手前で 1 つにまとめる） */
  months: number;
  /** 区切りの月（今日から。この月より前の判断・手を開く） */
  limit: number;
  /** 地図の終わり（2029 年 11 月）まで届く */
  toEnd: boolean;
  /** 開いた後に見える、そのカードの先のカードの数（そのカードは含まない） */
  count: number;
  /** 開いた後の並びの行の数（見える先のカードのうち、その先を開いていない物。キャンバスの高さ = 行 × 128 px） */
  rows: number;
}

/** カード i の先を、月 limit より前の判断・手まで開いたときに見えるカードの数と、開くカード */
export function openUntil(cm: CompiledMap, i: number, limit: number): { count: number; open: number[] } {
  const { size, parent, month, kidOff } = cm;
  const end = i + size[i]!;
  const open: number[] = [];
  let count = 0;
  for (let j = i; j < end; j++) {
    if (j > i) {
      const p = parent[j]!;
      // 親が開く（親の月が区切りより前）と見える。月は先へ減らないので、親の親も開いている
      if (!(month[p]! < limit)) continue;
      count++;
    }
    if (month[j]! < limit && kidOff[j + 1]! > kidOff[j]!) open.push(j);
  }
  return { count, open };
}

/** 区切り h で開くカード（地図の番号。押したときに数える） */
export function horizonOpen(cm: CompiledMap, i: number, h: DeepHorizon): number[] {
  return openUntil(cm, i, h.toEnd ? Infinity : h.limit).open;
}

/**
 * カード i から 1 年先・2 年先・地図の終わりまで（地図の終わりを超える区切りは 1 つにまとめる）。
 * 数は先を 1 回なめて、区切りごとにまとめて数える（カードを選ぶたびに作るので、開くカードの並びは作らない: horizonOpen）
 */
export function deepHorizons(cm: CompiledMap, i: number): DeepHorizon[] {
  // 形と数の版ごとに覚える（今日・今日の手の区切りは、概要を作るたびに 8 万枚をなめて数えていた: 見直し perf-6）
  const ver = `${cm.version.topology}|${cm.version.numbers}`;
  let memo = horizonMemo.get(cm);
  if (!memo || memo.ver !== ver) horizonMemo.set(cm, (memo = { ver, byCard: new Map() }));
  let hit = memo.byCard.get(i);
  if (!hit) memo.byCard.set(i, (hit = countHorizons(cm, i)));
  return hit;
}

/** 区切りの数え（カードごとに覚える物: deepHorizons） */
const horizonMemo = new WeakMap<CompiledMap, { ver: string; byCard: Map<number, DeepHorizon[]> }>();

function countHorizons(cm: CompiledMap, i: number, steps: readonly number[] = [12, 24, 36], skipSame = false): DeepHorizon[] {
  const m0 = cm.month[i]!;
  const H = cm.H;
  const cands: Array<{ months: number; limit: number; toEnd: boolean; lim: number }> = [];
  for (const months of steps) {
    const limit = Math.min(H, m0 + months);
    const toEnd = m0 + months >= H;
    if (cands.some((c) => c.limit === limit)) continue;
    cands.push({ months: toEnd ? H - m0 : months, limit, toEnd, lim: toEnd ? Infinity : limit });
    if (toEnd) break;
  }
  // 区切りは小さい順。親の月が入る一番小さい区切りに 1 つ数え、後で足し上げる（大きい区切りは小さい区切りの物を含む）。
  // 行（見えて、先を開いていないカード）は、見え始める区切りで 1 つ足し、そのカード自身が開く区切りで 1 つ引く
  const { size, parent, month, kidOff } = cm;
  const end = i + size[i]!;
  const first = new Array<number>(cands.length).fill(0);
  const rowsD = new Array<number>(cands.length + 1).fill(0);
  const firstIn = (m: number): number => {
    for (let c = 0; c < cands.length; c++) if (m < cands[c]!.lim) return c;
    return cands.length;
  };
  for (let j = i + 1; j < end; j++) {
    const c1 = firstIn(month[parent[j]!]!);
    if (c1 >= cands.length) continue;
    first[c1]!++;
    rowsD[c1]!++;
    if (kidOff[j + 1]! > kidOff[j]!) rowsD[firstIn(month[j]!)]!--;
  }
  const out: DeepHorizon[] = [];
  let count = 0;
  let rows = 0;
  for (let c = 0; c < cands.length; c++) {
    count += first[c]!;
    rows += rowsD[c]!;
    const x = cands[c]!;
    // 先が無い（行き先）・開いても何も増えない区切りは出さない（skipSame: 1 つ前の区切りと同じ数の区切りも。段数で開く）
    if (!count) continue;
    if (skipSame && out.length && out[out.length - 1]!.count === count) {
      // 終わりまでと同じなら、終わりまでの方を残す（「2029 年 11 月まで」）
      if (x.toEnd) out[out.length - 1] = { months: x.months, limit: x.limit, toEnd: true, count, rows };
      continue;
    }
    out.push({ months: x.months, limit: x.limit, toEnd: x.toEnd, count, rows });
  }
  return out;
}

// ------------------------------------------------------------ まとめて開く（段数・見込みの高い道・複数のカード・同じ時期まで）
// 設計: 作業メモ bulk/design.md。開く・閉じるは今までどおり見え方だけ（UiState.prefs.impactOpen）。
// A・C・D は覆う先を「ちょうどその段数まで」の形にする（区切りより前の判断・手を全部開き、区切りより後で開いていた物は閉じる）。
// だからボタンの枚数はそのまま開いた後の枚数で、繰り返し開いても開いた印が溜まらない。B は開いている物に道を足す。

/** 段数で開く区切り（か月。A・C）。地図の終わりを超える区切りは、地図の終わりまでの 1 つにまとめる */
export const DEPTH_STEPS: readonly number[] = [3, 6, 12, 24, 36];

/** 確かめずに開ける枚数（足す枚数。これより多い・縦に DEEP_OPEN_ROWS 行より長いときは、ページの中で聞いてから開く） */
export const BULK_ASK_CARDS = 1000;

/** 覚えておく開いたカードの数（入口ごと）。これを超えたら、閉じたカードの中に隠れている開いた印を捨てる（設定が膨らまないように） */
export const OPEN_LIST_BOUND = 4000;

/**
 * カード i から 3 か月先・半年先・1 年先・2 年先・地図の終わりまで（段数で開く: A）。数え方は deepHorizons と同じ 1 回なめる物で、
 * 形と数の版・カードごとに覚える
 */
export function deepDepths(cm: CompiledMap, i: number): DeepHorizon[] {
  const ver = `${cm.version.topology}|${cm.version.numbers}`;
  let memo = depthMemo.get(cm);
  if (!memo || memo.ver !== ver) depthMemo.set(cm, (memo = { ver, byCard: new Map() }));
  let hit = memo.byCard.get(i);
  if (!hit) memo.byCard.set(i, (hit = countHorizons(cm, i, DEPTH_STEPS, true)));
  return hit;
}

const depthMemo = new WeakMap<CompiledMap, { ver: string; byCard: Map<number, DeepHorizon[]> }>();

/** 時期で開く（D）の 1 つの時期: 今日からその月まで（月 limit より前の判断・手を全部開く） */
export interface QuarterOpen {
  /** 今日から何か月（3・6・… ・H） */
  months: number;
  /** 地図の終わり（H か月目）まで */
  toEnd: boolean;
  /** 開いた後に見える今日の先のカードの数（今日は含まない） */
  count: number;
  /** 開いた後の並びの行の数 */
  rows: number;
}

/** 今日から 3 か月ごとの時期まで開いたときの数（D。12 の時期を 1 回なめて数える。版ごとに覚える） */
export function quarterOpens(cm: CompiledMap): QuarterOpen[] {
  const ver = `${cm.version.topology}|${cm.version.numbers}`;
  const hit = quarterMemo.get(cm);
  if (hit && hit.ver === ver) return hit.list;
  const steps: number[] = [];
  for (let m = 3; m <= cm.H; m += 3) steps.push(m);
  const hs = countHorizons(cm, 0, steps);
  const list = hs.map((x) => ({ months: x.toEnd ? cm.H : x.months, toEnd: x.toEnd, count: x.count, rows: x.rows }));
  quarterMemo.set(cm, { ver, list });
  return list;
}

const quarterMemo = new WeakMap<CompiledMap, { ver: string; list: QuarterOpen[] }>();

/** 覆う先の 1 つ: カード i の先を、月 lim より前の判断・手まで（lim は Infinity で地図の終わりまで） */
export interface ShapePick {
  i: number;
  lim: number;
}

/** まとめて開く形（地図の番号） */
export interface ShapePlan {
  /** 開いているべきカード（覆う先の中。もう開いている物も含む） */
  open: number[];
  /** 閉じるカード（覆う先の中で、今開いていて、開いているべきでない物） */
  close: number[];
  /** 開いた後に見える、覆う先のカードの数（覆う先の頭のカードは含まない） */
  count: number;
  /** 開いた後の並びの行の数（見える覆う先のカードのうち、先を開いていない物） */
  rows: number;
  /** 覆う先の頭（ほかの覆う先の中に無い物。番号の順） */
  tops: number[];
}

/** 番号 j が、番号の順に並んだ覆う先の頭（[t, t + size)）のどれかの中か（頭そのものは含まない） */
export function insideTops(cm: CompiledMap, tops: readonly number[], j: number): boolean {
  let lo = 0;
  let hi = tops.length - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tops[mid]! < j) (at = mid), (lo = mid + 1);
    else hi = mid - 1;
  }
  if (at < 0) return false;
  const t = tops[at]!;
  return j < t + cm.size[t]!;
}

/**
 * 覆う先（picks）を、ちょうどその段数まで開く形（A・C・D）。入れ子の覆う先は深い方の区切りを取り、内側の頭までの親は開く
 * （内側の頭が見えたままになるように）。openNow: 今開いている地図の番号（覆う先の外の物は触らない）。O(覆う先の大きさ)
 */
export function shapePlan(cm: CompiledMap, picks: readonly ShapePick[], openNow: Iterable<number>): ShapePlan {
  const { size, parent, month, kidOff } = cm;
  const sorted = [...picks].sort((a, b) => a.i - b.i);
  const tops = topsOf(cm, sorted.map((p) => p.i));
  // 内側の頭から、それを覆う頭までの親を開く
  const forced = new Set<number>();
  for (const p of sorted) {
    if (tops.includes(p.i)) continue;
    for (let q = parent[p.i]!; q >= 0 && !forced.has(q); q = parent[q]!) {
      forced.add(q);
      if (tops.includes(q)) break;
    }
  }
  const open: number[] = [];
  let count = 0;
  let rows = 0;
  let k = 0;
  for (const t of tops) {
    const end = t + size[t]!;
    // 番号ごとの印（1: 開く・2: 見える）。覆う先の中だけ
    const flag = new Uint8Array(end - t);
    // 区切りの重なり（入れ子の覆う先: 深い方の区切り）
    const stack: Array<{ end: number; lim: number }> = [];
    let lim = -Infinity;
    while (k < sorted.length && sorted[k]!.i < t) k++;
    for (let j = t; j < end; j++) {
      while (stack.length && j >= stack[stack.length - 1]!.end) {
        stack.pop();
        lim = stack.length ? stack[stack.length - 1]!.lim : -Infinity;
      }
      while (k < sorted.length && sorted[k]!.i === j) {
        lim = Math.max(lim, sorted[k]!.lim);
        stack.push({ end: j + size[j]!, lim });
        k++;
      }
      const hasKids = kidOff[j + 1]! > kidOff[j]!;
      const want = hasKids && (month[j]! < lim || forced.has(j));
      const vis = j === t ? true : (flag[parent[j]! - t]! & 3) === 3;
      flag[j - t] = (want ? 1 : 0) | (vis ? 2 : 0);
      if (want) open.push(j);
      if (j > t && vis) {
        count++;
        if (!want) rows++;
      }
    }
  }
  const close: number[] = [];
  for (const j of openNow) {
    if (j < 0) continue;
    if (!insideTops(cm, tops, j) && !tops.includes(j)) continue;
    // 開いているべき物（open は番号の順）
    if (!sortedHas(open, j)) close.push(j);
  }
  return { open, close, count, rows, tops };
}

/** 覆う先の頭（ほかのカードの先に無い物。番号の順） */
export function topsOf(cm: CompiledMap, picks: readonly number[]): number[] {
  const tops: number[] = [];
  for (const i of [...picks].sort((a, b) => a - b)) {
    const last = tops[tops.length - 1];
    if (last !== undefined && i < last + cm.size[last]!) continue;
    tops.push(i);
  }
  return tops;
}

function sortedHas(xs: readonly number[], v: number): boolean {
  let lo = 0;
  let hi = xs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const x = xs[mid]!;
    if (x === v) return true;
    if (x < v) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/** 見込みの高い道（B） */
export interface LikelyPaths {
  /** 道の数（行き先が N より少なければその数） */
  n: number;
  /** 道の行き先（見込みの大きい順） */
  ends: number[];
  /** 道の見込みの合計（0〜1） */
  mass: number;
  /** 開くカード（x から行き先の親までの道の上のカード。番号の順） */
  open: number[];
}

/** x から下の行き先を見込みの大きい順（同じなら番号の小さい順）に並べた物（計算ごと・カードごとに覚える） */
function rankedEnds(a: Analysis, x: number): { ends: number[]; mass: number[] } {
  let byCard = endsMemo.get(a);
  if (!byCard) endsMemo.set(a, (byCard = new Map()));
  let hit = byCard.get(x);
  if (!hit) {
    const r = endsFrom(a, x);
    const idx = r.ends.map((_, k) => k);
    idx.sort((p, q) => r.mass[q]! - r.mass[p]! || r.ends[p]! - r.ends[q]!);
    hit = { ends: idx.map((k) => r.ends[k]!), mass: idx.map((k) => r.mass[k]!) };
    byCard.set(x, hit);
  }
  return hit;
}

const endsMemo = new WeakMap<Analysis, Map<number, { ends: number[]; mass: number[] }>>();

/**
 * x から見込みの高い道 n 本（B: 判断はおすすめの手か、これにした手で進む。endsFrom と同じ選び方）。開くのは道の上のカードだけで、
 * 道の横の兄弟は閉じたまま（+N の札）見える
 */
export function likelyPaths(a: Analysis, x: number, n: number): LikelyPaths {
  const { parent } = a.cm;
  const r = rankedEnds(a, x);
  const take = Math.min(n, r.ends.length);
  const set = new Set<number>();
  let mass = 0;
  const ends: number[] = [];
  for (let k = 0; k < take; k++) {
    const e = r.ends[k]!;
    ends.push(e);
    mass += r.mass[k]!;
    for (let q = e === x ? -1 : parent[e]!; q >= x && !set.has(q); q = q === x ? -1 : parent[q]!) set.add(q);
  }
  return { n: take, ends, mass, open: [...set].sort((p, q) => p - q) };
}

/**
 * カード x の先で、開いている物が isOpen のときに見えるカードの数（x は含まない）と行の数。O(x の先の数)
 */
export function visibleUnder(cm: CompiledMap, x: number, isOpen: (j: number) => boolean): { count: number; rows: number } {
  const { size, parent, kidOff } = cm;
  const end = x + size[x]!;
  const flag = new Uint8Array(end - x);
  let count = 0;
  let rows = 0;
  for (let j = x; j < end; j++) {
    const want = kidOff[j + 1]! > kidOff[j]! && isOpen(j);
    const vis = j === x || (flag[parent[j]! - x]! & 3) === 3;
    flag[j - x] = (want ? 1 : 0) | (vis ? 2 : 0);
    if (j > x && vis) {
      count++;
      if (!want) rows++;
    }
  }
  return { count, rows };
}

/**
 * visibleUnder をいくつかの開き方でまとめて 1 回なめて数える（見込みの高い道の 5 本・10 本: 今日なら 8 万枚を 1 回だけ）。
 * base: x の先の今開いている印（添え字は j − x）。adds[k]: k 番目の開き方で足す開くカード
 */
export function visibleUnderEach(cm: CompiledMap, x: number, base: Uint8Array, adds: ReadonlyArray<ReadonlySet<number>>): Array<{ count: number; rows: number }> {
  const { size, parent, kidOff } = cm;
  const end = x + size[x]!;
  const K = adds.length;
  const flags = adds.map(() => new Uint8Array(end - x));
  const out = adds.map(() => ({ count: 0, rows: 0 }));
  for (let j = x; j < end; j++) {
    const has = kidOff[j + 1]! > kidOff[j]!;
    const b = base[j - x] === 1;
    const p = j === x ? -1 : parent[j]! - x;
    for (let k = 0; k < K; k++) {
      const f = flags[k]!;
      const want = has && (b || adds[k]!.has(j));
      const vis = p < 0 || (f[p]! & 3) === 3;
      f[j - x] = (want ? 1 : 0) | (vis ? 2 : 0);
      if (p >= 0 && vis) {
        out[k]!.count++;
        if (!want) out[k]!.rows++;
      }
    }
  }
  return out;
}

/** 今日から時期まで（D）の数をもう数えてあるか（数えていなければ、起動の直後は空いた時間に回す） */
export function quarterOpensReady(cm: CompiledMap): boolean {
  const hit = quarterMemo.get(cm);
  return !!hit && hit.ver === `${cm.version.topology}|${cm.version.numbers}`;
}

/** x から下の行き先をもう並べてあるか（見込みの高い道） */
export function likelyReady(a: Analysis, x: number): boolean {
  return !!endsMemo.get(a)?.has(x);
}

/** まとめてたたむ: 頭のカードと、その先で開いている物を全部閉じる（番号） */
export function foldPlan(cm: CompiledMap, roots: readonly number[], openNow: Iterable<number>): number[] {
  const tops = topsOf(cm, roots);
  const out = new Set<number>(tops);
  for (const j of openNow) if (j >= 0 && insideTops(cm, tops, j)) out.add(j);
  return [...out];
}
