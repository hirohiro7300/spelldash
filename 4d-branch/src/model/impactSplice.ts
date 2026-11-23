// 3 年の影響の「組み直した形」（./impactGraph.ts）を、カードの枝を足す・消すだけの変更で、型付き配列を最初から作り直さずに直す
// （作業メモ SPEC v1 §7.1 の 1・perf-4: 地図の中の形の編集 = カードに子を足す（Tab）・その元に戻す・行き先を消す・枝ごと消す・その元に戻す）。
//
// 答えは compileDocTopo + fillNums で最初から作った物と、番号・並び・数まで同じ（tests/unit/impactEngine.test.ts・structEdits.test.ts・
// viewModelSlow.test.ts が配列ごと比べる）:
//   並べる順（compileDocTopo の、入口から入ってくる線を数えて減らす順）では、入口でないノードは「最後に数を 0 にした線」
//   （入ってくる線のうち一番後ろの番号の線）の順に並ぶ。入ってくる線が 1 本だけの枝（森）を足す・消すと、前からあるノードの並びは
//   変わらない（線の番号が詰まる・空くだけ）。足すときは、その順を入口から数え直して新しいカードの場所を決める（addSet）。
//   消すときは印の付いたノードと線を 1 回で詰める（removeSet）。どちらも O(ノード + 線) を 1 回（1 枚ずつ直すと O(枚数 × 形)）。
//   数は、変わったノード（枝の親と新しいカード）だけを fillNums と同じ決まり（numsNode・numsEdges）で入れ直し、ほかは続いている所ごとに
//   写す（番号で決まる既定の並び 1e9 + i だけは、ずれた所を入れ直す）。
// 入口・循環・合流・枝でないカードに関わる変更はここでは扱わない（null を返し、呼び手が最初から作り直す）。

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

/**
 * 番号のずれたノードの既定の並び（meta.rank の無いノードは 1e9 + 番号: fillNums と同じ）を入れ直す。from から後ろのノード
 */
function fixRanks(seen: Seen, rank: Float64Array, from: number): void {
  for (let i = from; i < rank.length; i++) {
    const r = seen.nodeObj[i]!.meta?.rank;
    rank[i] = typeof r === "number" && Number.isFinite(r) ? r : 1e9 + i;
  }
}

/** 前の番号 → 新しい番号（−1 は無い）の、続いている所 [前の始まり, 前の終わり, 新しい始まり]（番号の順は変わらないこと） */
function runsOf(map: Int32Array, len: number): number[] {
  const runs: number[] = [];
  let i = 0;
  while (i < len) {
    if (map[i]! < 0) {
      i++;
      continue;
    }
    const a = i;
    const d = map[i]!;
    while (i + 1 < len && map[i + 1] === map[i]! + 1) i++;
    i++;
    runs.push(a, i, d);
  }
  return runs;
}

/** 数をノードと線の続いている所ごとにまとめて写す（1 つずつ写すと 8 万枚で 30 ms ほど）。判断の今のままの線は線の番号を直す */
function copyNums(x: NumsArrays, nums: Nums, nodeMap: Int32Array, n: number, slotMap: Int32Array, S: number): void {
  const nr = runsOf(nodeMap, n);
  for (let k = 0; k < nr.length; k += 3) {
    const a = nr[k]!;
    const b = nr[k + 1]!;
    const d = nr[k + 2]!;
    x.kind.set(nums.kind.subarray(a, b), d);
    x.t.set(nums.t.subarray(a, b), d);
    x.rr.set(nums.rr.subarray(a * 3, b * 3), d * 3);
    x.rank.set(nums.rank.subarray(a, b), d);
    x.isBase.set(nums.isBase.subarray(a, b), d);
    x.noData.set(nums.noData.subarray(a, b), d);
    x.q.set(nums.q.subarray(a * 3, b * 3), d * 3);
    x.stub.set(nums.stub.subarray(a, b), d);
    x.sum.set(nums.sum.subarray(a, b), d);
    for (let i = a; i < b; i++) {
      const bs = nums.base[i]!;
      x.base[d + i - a] = bs < 0 ? bs : slotMap[bs]!;
      x.fam[d + i - a] = nums.fam[i]!;
    }
  }
  const sr = runsOf(slotMap, S);
  for (let k = 0; k < sr.length; k += 3) {
    const a = sr[k]!;
    const b = sr[k + 1]!;
    const d = sr[k + 2]!;
    x.w.set(nums.w.subarray(a, b), d);
    x.er.set(nums.er.subarray(a * 3, b * 3), d * 3);
    for (let s = a; s < b; s++) {
      x.rvKey[d + s - a] = nums.rvKey[s]!;
      x.rvCat[d + s - a] = nums.rvCat[s]!;
    }
  }
  x.likeBasis = nums.likeBasis;
}

/**
 * 印の付いたノード（drop[j] = 1）を、入ってくる線ごとまとめて形から外す（枝ごと消した・行き先の葉をいくつも消した: 見直し
 * speed-del-subtree-quadratic・speed-del-mid-undo。葉を 1 枚ずつ外すと、1 枚ごとに型付き配列を全部作り直す）。
 * 外すノードはどれも、入口でない・入ってくる線が 1 本・出る線の先がどれも外すノード（枝の下の方まで外す）。外さないノードの並びは
 * 変わらない（どのノードも、外さないノードからの線で並ぶ所が決まる: 線の番号が詰まるだけ）。外した線の元で残るノード（枝の親）の
 * 数を入れ直す（removeLeaf と同じ決まり）。nums があれば数も直す。外せない形なら null
 */
export function removeSet(topo: Topo, seen: Seen, nums: Nums | null, drop: Uint8Array): Spliced | null {
  const { n, off, tgt, src, roots } = topo;
  const S = off[n]!;
  const R = roots.length;
  /** 枝の親（外さないノードで、外すノードへの線の元） */
  const parents: number[] = [];
  const isParent = new Uint8Array(n);
  let k = 0;
  for (let j = 0; j < n; j++) {
    if (!drop[j]) continue;
    k++;
    if (j < R || topo.incOff[j + 1]! - topo.incOff[j]! !== 1) return null;
    for (let s = off[j]!; s < off[j + 1]!; s++) {
      const t = tgt[s]!;
      if (t < 0 || !drop[t]) return null;
    }
    const u = src[topo.incSlot[topo.incOff[j]!]!]!;
    if (!drop[u] && !isParent[u]) {
      isParent[u] = 1;
      parents.push(u);
    }
  }
  if (!k) return null;
  // 入口が出る線をみな失うと、数字を出す入口の決まりが変わることがある（removeLeaf と同じ）
  for (const u of parents) {
    if (u >= R) continue;
    let left = 0;
    for (let s = off[u]!; s < off[u + 1]!; s++) if (!drop[tgt[s]!]) left++;
    if (!left) return null;
  }
  parents.sort((a, b) => a - b);
  // 前の番号 → 新しい番号（外すノードは −1）。線も同じ（外す線 = 先が外すノードの線）
  const pmA = new Int32Array(n);
  let q = 0;
  for (let i = 0; i < n; i++) pmA[i] = drop[i] ? -1 : q++;
  const n2 = q;
  const smA = new Int32Array(S);
  let s2 = 0;
  for (let s = 0; s < S; s++) {
    const t = tgt[s]!;
    smA[s] = t >= 0 && drop[t] ? -1 : s2++;
  }
  const S2 = s2;
  const off2 = new Int32Array(n2 + 1);
  const tgt2 = new Int32Array(S2);
  const src2 = new Int32Array(S2);
  const eid2 = new Array<ID>(S2);
  const edgeObj2 = new Array<GEdge | undefined>(S2);
  for (let i = 0; i < n; i++) {
    const i2 = pmA[i]!;
    if (i2 < 0) continue;
    // 新しい番号 i2 の線の始まり = 前の番号 i の線の始まりより前に残った線の数
    let a = off[i]!;
    while (a < off[i + 1]! && smA[a]! < 0) a++;
    off2[i2] = a < off[i + 1]! ? smA[a]! : -1;
  }
  // 線の無いノードの始まりは次のノードの始まり（後ろから埋める）
  off2[n2] = S2;
  for (let i2 = n2 - 1; i2 >= 0; i2--) if (off2[i2]! < 0) off2[i2] = off2[i2 + 1]!;
  for (let s = 0; s < S; s++) {
    const x = smA[s]!;
    if (x < 0) continue;
    const t = tgt[s]!;
    tgt2[x] = t >= 0 ? pmA[t]! : -1;
    src2[x] = pmA[src[s]!]!;
    eid2[x] = topo.eid[s]!;
    edgeObj2[x] = seen.edgeObj[s];
  }
  const tgtLoose = new Map<number, ID>();
  for (const [s, id] of topo.tgtLoose) tgtLoose.set(smA[s]!, id);
  const ids = new Array<ID>(n2);
  const nodeObj = new Array<GNode | undefined>(n2);
  let first = -1;
  for (let i = 0; i < n; i++) {
    const i2 = pmA[i]!;
    if (i2 < 0) {
      if (first < 0) first = i;
      continue;
    }
    ids[i2] = topo.ids[i]!;
    nodeObj[i2] = seen.nodeObj[i];
  }
  const { incOff, incSlot, merges, firstParent } = withIncoming(n2, tgt2, src2);
  const topo2: Topo = {
    n: n2,
    ids,
    idx: indexOf(ids),
    loose: topo.loose,
    scopeSize: topo.scopeSize - k,
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
  const seen2: Seen = { nodeObj, edgeObj: edgeObj2 };
  const pos = (i: number): number => (i >= 0 && i < n ? pmA[i]! : -1);
  let nums2: Nums | null = null;
  if (nums) {
    let hadQ = false;
    for (let j = 0; j < n && !hadQ; j++) if (drop[j] && !Number.isNaN(nums.q[j * 3]!)) hadQ = true;
    const x = newNums(nums.H, n2, S2);
    // 外した線を指していた判断の今のままの線は −1（その親は下で入れ直す）
    copyNums(x, nums, pmA, n, smA, S);
    fixRanks(seen2, x.rank, Math.max(0, first));
    const b = numsBase(topo2, seen2);
    if (b.H !== nums.H) return null;
    // 枝の親を、番号の順（fillNums と同じ順）に入れ直す
    for (const u of parents) {
      const u2 = pmA[u]!;
      numsNode(topo2, seen2, x, b, u2, tFloorOf(topo2, x.t, u2));
      numsEdges(topo2, seen2, x, u2);
    }
    if (hadQ) {
      // 外したノードだけが q を持っていたかもしれない: 残りを数え直す
      let any = false;
      for (let i = 0; i < n2 && !any; i++) if (!Number.isNaN(x.q[i * 3]!)) any = true;
      x.likeBasis = any;
    }
    nums2 = x;
  }
  return { topo: topo2, seen: seen2, nums: nums2, pos };
}

/** addSet に渡す、足すカード 1 枚（そのカードへ入る道の線 e と、カード v） */
export interface AddedLeaf {
  e: GEdge;
  v: GNode;
}

/**
 * 範囲のカードから、新しいカードの枝（森）をまとめて足す（枝ごと消したのを元に戻した・行き先をいくつも足した: 見直し
 * speed-del-mid-undo。葉を 1 枚ずつ足すと、1 枚ごとに型付き配列を全部作り直す）。add は新しいカードの ID → そこへ入る 1 本の線と
 * カード（線の元は、範囲のカードか、足すカード）。新しいカードの道の線はどれも、足すカードへの add の線であること（呼び手が確かめる。
 * 入ってくる線は 1 本）。outOf はノードの今の出る線の ID（文書の索引）。並べる順は compileDocTopo と同じ（入口から、入ってくる線を
 * 数えて減らす順）で作り直す: 前からあるノードは前の順のまま（新しいカードから前のノードへの線は無い）、新しいカードはその線を数えた所に入る。
 * nums があれば数も直す（線を足した前のノードと新しいカードを fillNums と同じ決まりで入れ直す）。足せない形なら null
 */
export function addSet(topo: Topo, seen: Seen, nums: Nums | null, add: ReadonlyMap<ID, AddedLeaf>, outOf: (id: ID) => readonly ID[] | undefined): Spliced | null {
  const { n, off, tgt, roots } = topo;
  const S = off[n]!;
  const R = roots.length;
  const m = add.size;
  if (!m) return null;
  // 新しいカードの番号（仮）: n + 0..m-1
  const newIds: ID[] = [];
  const tmp = new Map<ID, number>();
  for (const [id, x] of add) {
    if (topo.idx.has(id) || topo.loose.has(id) || x.e.target !== id || x.v.id !== id) return null;
    tmp.set(id, n + newIds.length);
    newIds.push(id);
  }
  const ref = (id: ID): number => topo.idx.get(id) ?? tmp.get(id) ?? -1;
  /** 足す線の ID → 足すカードの ID */
  const byEdge = new Map<ID, ID>();
  for (const [id, x] of add) byEdge.set(x.e.id, id);
  // ノード（仮の番号）ごとの、新しい並びの出る線（前の線は前の線の番号、新しい線は −1 − 足すカードの仮の番号の位置）
  const newOut = new Map<number, number[]>();
  for (const id of newIds) {
    const e = add.get(id)!.e;
    const u = ref(e.source);
    if (u < 0) return null;
    if (u < R && off[u + 1]! - off[u]! === 0) return null;
    if (!newOut.has(u)) newOut.set(u, []);
  }
  for (const [u] of newOut) {
    const uid = u < n ? topo.ids[u]! : newIds[u - n]!;
    const list: number[] = [];
    let p = u < n ? off[u]! : 0;
    const end = u < n ? off[u + 1]! : 0;
    for (const eid of outOf(uid) ?? []) {
      if (p < end && topo.eid[p] === eid) {
        list.push(p++);
        continue;
      }
      // 足す線か（その線の先の足すカードへ入る線）
      const hit = byEdge.get(eid);
      if (hit !== undefined && add.get(hit)!.e.source === uid) list.push(-1 - (tmp.get(hit)! - n));
    }
    if (p !== end) return null;
    newOut.set(u, list);
  }
  // 足すカードの線がどれも並びに入ったか（入らない線 = 出る線の索引に無い）
  let placed = 0;
  for (const [, list] of newOut) for (const x of list) if (x < 0) placed++;
  if (placed !== m) return null;
  // 入口から、入ってくる線を数えて減らす順（compileDocTopo と同じ）
  const N = n + m;
  const isRoot = new Uint8Array(N);
  for (const r of roots) isRoot[r] = 1;
  const left = new Int32Array(N);
  for (let i = 0; i < n; i++) left[i] = topo.incOff[i + 1]! - topo.incOff[i]!;
  for (let k = 0; k < m; k++) left[n + k] = 1;
  const order: number[] = roots.slice();
  /** ノードの出る線を、新しい並びで（線の先の仮の番号を返す） */
  const each = (u: number, fn: (oldSlot: number, t: number) => void): void => {
    const list = newOut.get(u);
    if (list) {
      for (const x of list) fn(x, x >= 0 ? tgt[x]! : n + (-1 - x));
      return;
    }
    if (u < n) for (let s = off[u]!; s < off[u + 1]!; s++) fn(s, tgt[s]!);
  };
  for (let k = 0; k < order.length; k++) {
    each(order[k]!, (_s, t) => {
      if (t < 0 || isRoot[t]) return;
      if (--left[t]! === 0) order.push(t);
    });
  }
  if (order.length !== N) return null;
  // 前のノードは前の順のまま（違えば直せない: 最初から作る）
  let last = -1;
  for (const u of order) {
    if (u >= n) continue;
    if (u < last) return null;
    last = u;
  }
  const pmA = new Int32Array(N);
  for (let i = 0; i < N; i++) pmA[order[i]!] = i;
  // 線を新しい並びで振る
  let S2 = S + m;
  const off2 = new Int32Array(N + 1);
  const tgt2 = new Int32Array(S2);
  const src2 = new Int32Array(S2);
  const eid2 = new Array<ID>(S2);
  const edgeObj2 = new Array<GEdge | undefined>(S2);
  const smA = new Int32Array(S).fill(-1);
  /** 新しい線の新しい番号（足すカードの仮の番号の位置ごと） */
  const newSlot = new Int32Array(m).fill(-1);
  let s2 = 0;
  for (let i = 0; i < N; i++) {
    const u = order[i]!;
    off2[i] = s2;
    each(u, (x, t) => {
      tgt2[s2] = t >= 0 ? pmA[t]! : -1;
      src2[s2] = i;
      if (x >= 0) {
        smA[x] = s2;
        eid2[s2] = topo.eid[x]!;
        edgeObj2[s2] = seen.edgeObj[x];
      } else {
        const a = add.get(newIds[-1 - x]!)!;
        newSlot[-1 - x] = s2;
        eid2[s2] = a.e.id;
        edgeObj2[s2] = a.e;
      }
      s2++;
    });
  }
  off2[N] = s2;
  if (s2 !== S2) return null;
  S2 = s2;
  const tgtLoose = new Map<number, ID>();
  for (const [s, id] of topo.tgtLoose) tgtLoose.set(smA[s]!, id);
  const ids = new Array<ID>(N);
  const nodeObj = new Array<GNode | undefined>(N);
  let first = N;
  for (let i = 0; i < N; i++) {
    const u = order[i]!;
    if (u < n) {
      ids[i] = topo.ids[u]!;
      nodeObj[i] = seen.nodeObj[u];
    } else {
      const id = newIds[u - n]!;
      ids[i] = id;
      nodeObj[i] = add.get(id)!.v;
      if (i < first) first = i;
    }
  }
  const { incOff, incSlot, merges, firstParent } = withIncoming(N, tgt2, src2);
  const topo2: Topo = {
    n: N,
    ids,
    idx: indexOf(ids),
    loose: topo.loose,
    scopeSize: topo.scopeSize + m,
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
  const seen2: Seen = { nodeObj, edgeObj: edgeObj2 };
  const pos = (i: number): number => (i >= 0 && i < n ? pmA[i]! : -1);
  let nums2: Nums | null = null;
  if (nums) {
    const x = newNums(nums.H, N, S2);
    copyNums(x, nums, pmA, n, smA, S);
    if (first < N) fixRanks(seen2, x.rank, first);
    const b = numsBase(topo2, seen2);
    if (b.H !== nums.H) return null;
    // 線を足したノードと新しいカードを、番号の順（fillNums と同じ順）に入れ直す: ノードの数を先に、それから線
    const redo: number[] = [];
    for (const [u] of newOut) redo.push(pmA[u]!);
    for (let k = 0; k < m; k++) if (!newOut.has(n + k)) redo.push(pmA[n + k]!);
    redo.sort((a, c) => a - c);
    for (const i of redo) if (numsNode(topo2, seen2, x, b, i, tFloorOf(topo2, x.t, i))) x.likeBasis = true;
    for (const i of redo) numsEdges(topo2, seen2, x, i);
    nums2 = x;
  }
  return { topo: topo2, seen: seen2, nums: nums2, pos };
}
