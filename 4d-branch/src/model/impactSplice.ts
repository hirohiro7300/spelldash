// 3 年の影響の「組み直した形」（./impactGraph.ts）を、葉のカードを 1 枚足す・消すだけの変更で、型付き配列を最初から作り直さずに直す
// （作業メモ SPEC v1 §7.1 の 1・perf-4: 地図の中の形の編集 = カードに子を足す（Tab）・その元に戻す・行き先を消す）。
//
// 答えは compileDocTopo + fillNums で最初から作った物と、番号・並び・数まで同じ（tests/unit/impactEngine.test.ts が配列ごと比べる）:
//   並べる順（compileDocTopo の、入口から入ってくる線を数えて減らす順）では、入口でないノードは「最後に数を 0 にした線」
//   （入ってくる線のうち一番後ろの番号の線）の順に並ぶ。葉 v を u の線 sE で足すと、v はその線の番号で並ぶ所に入り、
//   ほかのノードの並びは変わらない（線の番号が 1 つずれるだけ）。葉を消すときはその逆。
//   数は、変わったノード（u と v）だけを fillNums と同じ決まり（numsNode・numsEdges）で入れ直し、ほかは写す
//   （番号で決まる既定の並び 1e9 + i だけは、ずれた所を入れ直す）。
// 入口・循環・合流・葉でないカードに関わる変更はここでは扱わない（呼び手が最初から作り直す）。

import { incoming, newNums, numsBase, numsEdges, numsNode, type Nums, type NumsArrays, type Seen, type Topo } from "./impactGraph";
import type { GEdge, GNode, ID } from "./types";

export interface Spliced {
  topo: Topo;
  seen: Seen;
  /** 数（渡した数が無ければ null） */
  nums: Nums | null;
  /** 前の番号 → 新しい番号（消したノードは −1） */
  pos(i: number): number;
}

/** 入口でないノード p の、最後に数を 0 にした線（入ってくる線の一番後ろの番号）。入ってくる線が無ければ −1 */
function readySlot(topo: Topo, p: number): number {
  const a = topo.incOff[p]!;
  const b = topo.incOff[p + 1]!;
  return b > a ? topo.incSlot[b - 1]! : -1;
}

/** 前に数えたノード（番号が小さい親）の月の大きい方（fillNums の tFloor と同じ） */
function tFloorOf(topo: Topo, t: Float64Array, i: number): number {
  let f = 0;
  for (let k = topo.incOff[i]!; k < topo.incOff[i + 1]!; k++) {
    const p = topo.src[topo.incSlot[k]!]!;
    if (p < i && t[p]! > f) f = t[p]!;
  }
  return f;
}

/** ID → 番号の表（並びから作り直す） */
function indexOf(ids: readonly ID[]): Map<ID, number> {
  const m = new Map<ID, number>();
  for (let i = 0; i < ids.length; i++) m.set(ids[i]!, i);
  return m;
}

/** 入ってくる線・最初の親を、線の先と元から作る */
function withIncoming(n: number, tgt: Int32Array, src: Int32Array): { incOff: Int32Array; incSlot: Int32Array; merges: boolean; firstParent: Int32Array } {
  const incCount = new Int32Array(n + 1);
  const firstParent = new Int32Array(n).fill(-1);
  for (let s = 0; s < tgt.length; s++) {
    const j = tgt[s]!;
    if (j < 0) continue;
    incCount[j + 1]!++;
    if (firstParent[j] === -1) firstParent[j] = src[s]!;
  }
  return { ...incoming(n, tgt, incCount), firstParent };
}

/** 配列 a の at に x を入れた写し */
function inserted<T>(a: readonly T[], at: number, x: T): T[] {
  const out = a.slice(0, at);
  out.push(x);
  for (let i = at; i < a.length; i++) out.push(a[i]!);
  return out;
}

/** 配列 a から at を除いた写し */
function removed<T>(a: readonly T[], at: number): T[] {
  const out = a.slice(0, at);
  for (let i = at + 1; i < a.length; i++) out.push(a[i]!);
  return out;
}

/** 型付き配列 a（1 つあたり w 個）の at 番目に w 個の空きを入れた写し・除いた写し */
function gapT<A extends Float64Array | Int32Array | Uint8Array>(make: (len: number) => A, a: A, at: number, w: number, add: boolean): A {
  const out = make(a.length + (add ? w : -w));
  out.set(a.subarray(0, at * w), 0);
  if (add) out.set(a.subarray(at * w), (at + 1) * w);
  else out.set(a.subarray((at + 1) * w), at * w);
  return out;
}

/**
 * 番号のずれたノードの既定の並び（meta.rank の無いノードは 1e9 + 番号: fillNums と同じ）を入れ直す。from から後ろのノード
 */
function fixRanks(seen: Seen, rank: Float64Array, from: number): void {
  for (let i = from; i < rank.length; i++) {
    const r = seen.nodeObj[i]!.meta?.rank;
    rank[i] = typeof r === "number" && Number.isFinite(r) ? r : 1e9 + i;
  }
}

/** 数の配列を、ノード（at・足すか消すか）と線（sAt）の所でずらして写す。u（新しい番号）の数はまだ入れていない */
function shiftNums(old: Nums, n2: number, slots2: number, at: number, sAt: number, add: boolean): NumsArrays {
  const x = newNums(old.H, n2, slots2);
  const U8 = (l: number) => new Uint8Array(l);
  const F64 = (l: number) => new Float64Array(l);
  const I32 = (l: number) => new Int32Array(l);
  x.kind = gapT(U8, old.kind, at, 1, add);
  x.t = gapT(F64, old.t, at, 1, add);
  x.rr = gapT(F64, old.rr, at, 3, add);
  x.rank = gapT(F64, old.rank, at, 1, add);
  x.isBase = gapT(U8, old.isBase, at, 1, add);
  x.noData = gapT(U8, old.noData, at, 1, add);
  x.q = gapT(F64, old.q, at, 3, add);
  x.stub = gapT(U8, old.stub, at, 1, add);
  x.sum = gapT(U8, old.sum, at, 1, add);
  x.base = gapT(I32, old.base, at, 1, add);
  x.w = gapT(F64, old.w, sAt, 1, add);
  x.er = gapT(F64, old.er, sAt, 3, add);
  if (add) {
    x.fam = inserted(old.fam, at, "");
    x.rvKey = inserted(old.rvKey, sAt, null);
    x.rvCat = inserted(old.rvCat, sAt, null);
  } else {
    x.fam = removed(old.fam, at);
    x.rvKey = removed(old.rvKey, sAt);
    x.rvCat = removed(old.rvCat, sAt);
  }
  // 判断の今のままの線（線の番号）を新しい番号に
  const base = x.base;
  for (let i = 0; i < base.length; i++) {
    const s = base[i]!;
    if (s >= sAt && (add || s !== sAt)) base[i] = add ? s + 1 : s - 1;
  }
  x.likeBasis = old.likeBasis;
  return x;
}

/**
 * 葉 v を、範囲のノード u（番号）の出る線の k 番目（線 e）として足す。v は今の形に無く、u は入口でないか、もう出る線のある入口。
 * nums があれば数も直す（u と v を入れ直す）。足せない形なら null
 */
export function addLeaf(topo: Topo, seen: Seen, nums: Nums | null, u: number, k: number, e: GEdge, v: GNode): Spliced | null {
  const { n, off, tgt, src, roots } = topo;
  const S = off[n]!;
  const R = roots.length;
  const degU = off[u + 1]! - off[u]!;
  if (u < 0 || u >= n || k < 0 || k > degU || topo.idx.has(v.id) || topo.loose.has(v.id)) return null;
  // 入口の出る線が 0 本から増えると、数字を出す入口の決まりが変わることがある
  if (u < R && degU === 0) return null;
  const sE = off[u]! + k;
  // v の並ぶ所: 入口でないノードのうち、最後に数を 0 にした線が sE より前の物の後ろ（二分探索。その線の番号の順に並んでいる）
  let lo = R;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const r = readySlot(topo, mid);
    if (r < 0) return null;
    if (r < sE) lo = mid + 1;
    else hi = mid;
  }
  const q = lo;
  if (q <= u) return null;
  const pm = (i: number): number => (i < q ? i : i + 1);
  const n2 = n + 1;
  const S2 = S + 1;
  // 出る線の始まり
  const off2 = new Int32Array(n2 + 1);
  for (let i = 0; i <= n2; i++) {
    const old = i < q ? i : i - 1;
    // 新しい番号 i の線の始まり = 前の番号のノードの線の始まり（u より後ろは足した線の分 1 つ後ろ）
    off2[i] = i === q ? off[q]! + 1 : off[old]! + (old > u ? 1 : 0);
  }
  const tgt2 = new Int32Array(S2);
  const src2 = new Int32Array(S2);
  const eid2 = new Array<ID>(S2);
  const edgeObj2 = new Array<GEdge | undefined>(S2);
  for (let s2 = 0; s2 < S2; s2++) {
    if (s2 === sE) {
      tgt2[s2] = q;
      src2[s2] = u;
      eid2[s2] = e.id;
      edgeObj2[s2] = e;
      continue;
    }
    const s = s2 < sE ? s2 : s2 - 1;
    const j = tgt[s]!;
    tgt2[s2] = j >= 0 ? pm(j) : -1;
    src2[s2] = pm(src[s]!);
    eid2[s2] = topo.eid[s]!;
    edgeObj2[s2] = seen.edgeObj[s];
  }
  const tgtLoose = new Map<number, ID>();
  for (const [s, id] of topo.tgtLoose) tgtLoose.set(s < sE ? s : s + 1, id);
  const ids = inserted(topo.ids, q, v.id);
  const { incOff, incSlot, merges, firstParent } = withIncoming(n2, tgt2, src2);
  const topo2: Topo = {
    n: n2,
    ids,
    idx: indexOf(ids),
    loose: topo.loose,
    scopeSize: topo.scopeSize + 1,
    rootIds: topo.rootIds,
    roots: roots.slice(),
    off: off2,
    tgt: tgt2,
    src: src2,
    eid: eid2,
    eidx: null,
    tgtLoose,
    incOff,
    incSlot,
    firstParent,
    merges,
    bfs: null,
    map: null,
    cm: null,
  };
  const seen2: Seen = { nodeObj: inserted(seen.nodeObj, q, v), edgeObj: edgeObj2 };
  let nums2: Nums | null = null;
  if (nums) {
    const x = shiftNums(nums, n2, S2, q, sE, true);
    fixRanks(seen2, x.rank, q + 1);
    const b = numsBase(topo2, seen2);
    if (b.H !== nums.H) return null;
    // u（番号は同じ）と v を、fillNums と同じ順（u → v、それから線）で入れ直す
    numsNode(topo2, seen2, x, b, u, tFloorOf(topo2, x.t, u));
    if (numsNode(topo2, seen2, x, b, q, tFloorOf(topo2, x.t, q))) x.likeBasis = true;
    numsEdges(topo2, seen2, x, u);
    numsEdges(topo2, seen2, x, q);
    nums2 = x;
  }
  return { topo: topo2, seen: seen2, nums: nums2, pos: pm };
}

/**
 * 葉 j（入口でない・出る線が無い・入ってくる線が 1 本）を、その線ごと形から外す。nums があれば数も直す。外せない形なら null
 */
export function removeLeaf(topo: Topo, seen: Seen, nums: Nums | null, j: number): Spliced | null {
  const { n, off, tgt, src, roots } = topo;
  const S = off[n]!;
  const R = roots.length;
  if (j < R || j >= n || off[j + 1] !== off[j] || topo.incOff[j + 1]! - topo.incOff[j]! !== 1) return null;
  const sE = topo.incSlot[topo.incOff[j]!]!;
  const u = src[sE]!;
  if (u < R && off[u + 1]! - off[u]! === 1) return null;
  const pm = (i: number): number => (i < j ? i : i === j ? -1 : i - 1);
  const n2 = n - 1;
  const S2 = S - 1;
  const off2 = new Int32Array(n2 + 1);
  for (let i = 0; i <= n2; i++) {
    const old = i < j ? i : i + 1;
    off2[i] = off[old]! - (old > u ? 1 : 0);
  }
  const tgt2 = new Int32Array(S2);
  const src2 = new Int32Array(S2);
  const eid2 = new Array<ID>(S2);
  const edgeObj2 = new Array<GEdge | undefined>(S2);
  for (let s2 = 0; s2 < S2; s2++) {
    const s = s2 < sE ? s2 : s2 + 1;
    const t = tgt[s]!;
    tgt2[s2] = t >= 0 ? pm(t) : -1;
    src2[s2] = pm(src[s]!);
    eid2[s2] = topo.eid[s]!;
    edgeObj2[s2] = seen.edgeObj[s];
  }
  const tgtLoose = new Map<number, ID>();
  for (const [s, id] of topo.tgtLoose) tgtLoose.set(s < sE ? s : s - 1, id);
  const ids = removed(topo.ids, j);
  const { incOff, incSlot, merges, firstParent } = withIncoming(n2, tgt2, src2);
  const topo2: Topo = {
    n: n2,
    ids,
    idx: indexOf(ids),
    loose: topo.loose,
    scopeSize: topo.scopeSize - 1,
    rootIds: topo.rootIds,
    roots: roots.slice(),
    off: off2,
    tgt: tgt2,
    src: src2,
    eid: eid2,
    eidx: null,
    tgtLoose,
    incOff,
    incSlot,
    firstParent,
    merges,
    bfs: null,
    map: null,
    cm: null,
  };
  const seen2: Seen = { nodeObj: removed(seen.nodeObj, j), edgeObj: edgeObj2 };
  let nums2: Nums | null = null;
  if (nums) {
    const hadQ = !Number.isNaN(nums.q[j * 3]!);
    const x = shiftNums(nums, n2, S2, j, sE, false);
    fixRanks(seen2, x.rank, j);
    const b = numsBase(topo2, seen2);
    if (b.H !== nums.H) return null;
    numsNode(topo2, seen2, x, b, u, tFloorOf(topo2, x.t, u));
    numsEdges(topo2, seen2, x, u);
    if (hadQ) {
      // 消したノードだけが q を持っていたかもしれない: 残りを数え直す
      let any = false;
      for (let i = 0; i < n2 && !any; i++) if (!Number.isNaN(x.q[i * 3]!)) any = true;
      x.likeBasis = any;
    }
    nums2 = x;
  }
  return { topo: topo2, seen: seen2, nums: nums2, pos: pm };
}
