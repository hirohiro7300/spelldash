// 3 年の影響の計算の「組み直した形」（型付き配列）。設計: 作業メモ SPEC v1 §7.1 の 1・11（見直し perf-1・perf-2・perf-11・perf-14）
//
// 計算（./impact.ts の backward・forward。./impactEngine.ts が使う）に渡す形 Compiled を、版ごとに分けて持つ:
//   形（Topo）    : 範囲・並べる順・線（CSR）・入ってくる線・入口・下の数。カードや線が増減・付け替わったときだけ作り直す
//   数（Nums）    : 分かれ道の種類・月・月の稼ぎ・割合・線の稼ぎ・並び・今のまま・数字なし・手の種類・事実・q。数が変わったら作り直す
//   状態（stat）  : 選んだ・見送った。変わったノードだけ写しに入れ直す
//   方針（allowed）: 判断の線が選んだ方針に入るか。方針・線のシナリオが変わったら作り直す
// どれも作った後は書き換えない（前の版の計算の結果が、後から新しい数を読まない）。年収は計算の入力でここには持たない。
//
// 2 つの作り方（どちらも ./impact.ts の compile と同じ数。tests/unit/impactEngine.test.ts で確かめる）:
//   compileDocTopo + fillNums: 文書の 3 年の分かれ道の範囲から（版 6 の地図・利用者が形を変えた地図・自分で作った地図）。
//                              並べる順も computeImpact と同じ（合流・循環・入口が 2 つ以上でも同じ答え）
//   compileMapDoc            : 同梱の地図（版 7）の列から（buildQuarterDoc で組み立てたまま、形と数を変えていない文書だけ。
//                              作業メモ SPEC D6・perf-1: 文書を読み直さない）。並べる順は地図の深さ優先の順（地図・計算の芯と同じ番号）。
//                              同じ値の行き先の並びは computeImpact と同じ（幅優先の順で数える: bfs）

import { compileMap, F_BASE, F_STUB, ROLE_A, ROLE_E, ROLE_R, type CompiledMap } from "../deepmap/core/compile";
import { quarterIdTable } from "../demo/quarterIds";
import type { MapData } from "../deepmap/mapData";
import { dayNumber, isDateStr } from "./dates";
import { flowOuts, impactConfigOf, isFlowEdge, isImpactRoot } from "./forks";
import { CHANCE, DECISION, LEAF, PASS, type Compiled } from "./impact";
import type { DocData, GEdge, GNode, ID } from "./types";

/** 形（カード・線の増減と付け替えで作り直す） */
export interface Topo {
  /** 数えるノードの数 */
  readonly n: number;
  /** 並べる順のノードの ID */
  readonly ids: ID[];
  readonly idx: Map<ID, number>;
  /** 範囲に入るが、循環のために数えないノード（computeImpact と同じく値を出さない） */
  readonly loose: Set<ID>;
  /** 範囲のノードの数（数えないノードを含む。counts.nodes） */
  readonly scopeSize: number;
  /** 入口の ID（数字と概要を出す入口が先頭。ほかは ID の順） */
  readonly rootIds: ID[];
  /** 入口の番号（rootIds の順） */
  readonly roots: number[];
  readonly off: Int32Array;
  readonly tgt: Int32Array;
  readonly src: Int32Array;
  readonly eid: ID[];
  /** 線の ID → 線の番号（初めて使うときに作る: edgeIndex） */
  eidx: Map<ID, number> | null;
  /** 先が数えないノードの線（tgt = −1）の、先の ID */
  readonly tgtLoose: Map<number, ID>;
  readonly incOff: Int32Array;
  readonly incSlot: Int32Array;
  /** 最初に自分へ線を出したノード（月の稼ぎ・月を受け継ぐ。無ければ −1） */
  readonly firstParent: Int32Array;
  /** 2 本以上の線が入ってくるノードがある（合流。そこまでの稼ぎに見込みを使う） */
  readonly merges: boolean;
  /** 行き先を数える順（computeImpact の並べる順。同じ見込み・同じ値の行き先の並び）。null なら番号の順 */
  readonly bfs: Int32Array | null;
  /** 同梱の地図から作ったとき、その地図と計算の芯（番号は地図と同じ）。文書から作ったときは null */
  readonly map: MapData | null;
  readonly cm: CompiledMap | null;
}

/** 数（形が同じで、数・種類が変わったら作り直す） */
export interface Nums {
  readonly H: number;
  readonly kind: Uint8Array;
  readonly t: Float64Array;
  readonly rr: Float64Array;
  readonly w: Float64Array;
  readonly er: Float64Array;
  readonly base: Int32Array;
  readonly rank: Float64Array;
  readonly isBase: Uint8Array;
  readonly noData: Uint8Array;
  readonly fam: string[];
  readonly rvKey: Array<string | null>;
  readonly rvCat: Array<string | null>;
  readonly q: Float64Array;
  /** まとめた手（meta.stub。画面に出す差では、その値が比べ方をそろえた値） */
  readonly stub: Uint8Array;
  readonly likeBasis: boolean;
  /** まとめた行き先（meta.sum。先の数の「標準の続きの見積もり」） */
  readonly sum: Uint8Array;
}

/** 文書の物（変わったかを比べる元。変更を受けるたびに新しい物に替える） */
export interface Seen {
  nodeObj: Array<GNode | undefined>;
  edgeObj: Array<GEdge | undefined>;
}

/** 線の状態の符号（computeImpact と同じ: 進行中・完了 1、見送り 2、ほか 0） */
export const statusCode = (n: GNode | undefined): number => (!n ? 0 : n.status === "active" || n.status === "done" ? 1 : n.status === "dropped" ? 2 : 0);

/** 入口の決まり（forks.ts の primaryImpactRoot と同じ: 先へ進む線のある入口 → 早く作った物 → ID の順）。入口の中だけで決める */
function primaryOf(doc: DocData, out: Map<ID, ID[]>, roots: readonly ID[]): ID | null {
  let best: ID | null = null;
  let bestFlow = false;
  for (const id of roots) {
    const n = doc.nodes[id]!;
    const f = flowOuts(doc, out, id).length > 0;
    if (best === null) {
      best = id;
      bestFlow = f;
      continue;
    }
    const b = doc.nodes[best]!;
    const better = f !== bestFlow ? f : n.createdAt !== b.createdAt ? n.createdAt < b.createdAt : id < best;
    if (better) {
      best = id;
      bestFlow = f;
    }
  }
  return best;
}

/**
 * 文書の 3 年の分かれ道の形を組み直す（computeImpact の impactScope・入口の決め方・並べる順と同じ）。入口が無ければ null。
 * out は graph の索引（ノード → 出る線の ID）。線は 1 度だけ読み、範囲の番号で持つ（Map を引き直さない・線の並びを作り直さない）
 */
export function compileDocTopo(doc: DocData, out: Map<ID, ID[]>, rootOrder?: readonly ID[]): { topo: Topo; seen: Seen } | null {
  // 入口（impactScope と同じく文書の順に。rootOrder を渡されたらその物: 索引が文書の順で持っている）と範囲（入口から進む線で深さ優先にたどった順。番号はたどった順）
  const tmp = new Map<ID, number>();
  const tid: ID[] = [];
  const stack: number[] = [];
  const rootList: ID[] = [];
  const addRoot = (id: ID): void => {
    rootList.push(id);
    tmp.set(id, tid.length);
    stack.push(tid.length);
    tid.push(id);
  };
  if (rootOrder) {
    for (const id of rootOrder) if (isImpactRoot(doc.nodes[id])) addRoot(id);
  } else {
    for (const id in doc.nodes) if (isImpactRoot(doc.nodes[id])) addRoot(id);
  }
  if (!rootList.length) return null;
  // 範囲のノードごとの出る道の線（flowOuts と同じ選び方・同じ並び）: outE / outT の [outA[u], outA[u] + outN[u])
  const outE: GEdge[] = [];
  const outT: number[] = [];
  const outA: number[] = [];
  const outN: number[] = [];
  while (stack.length) {
    const u = stack.pop()!;
    outA[u] = outE.length;
    for (const eid of out.get(tid[u]!) ?? []) {
      const e = doc.edges[eid];
      if (!e || !isFlowEdge(e) || e.source === e.target || !doc.nodes[e.target]) continue;
      let v = tmp.get(e.target);
      if (v === undefined) {
        v = tid.length;
        tmp.set(e.target, v);
        stack.push(v);
        tid.push(e.target);
      }
      outE.push(e);
      outT.push(v);
    }
    outN[u] = outE.length - outA[u]!;
  }
  const T = tid.length;
  // 入口の並び（ID の順。数字と概要を出す入口を先頭へ）
  const rootIds = rootList.slice().sort();
  const primary = primaryOf(doc, out, rootIds);
  if (primary !== null) rootIds.splice(0, rootIds.length, primary, ...rootIds.filter((r) => r !== primary));
  const isRoot = new Uint8Array(T);
  for (const r of rootIds) isRoot[tmp.get(r)!] = 1;
  // 並べる順（入口から。入口へ戻る線は数えない。循環に入ったノードは外す）
  const indeg = new Int32Array(T);
  for (let k = 0; k < outT.length; k++) if (!isRoot[outT[k]!]) indeg[outT[k]!]!++;
  const queue: number[] = rootIds.map((r) => tmp.get(r)!);
  for (let u = 0; u < T; u++) if (!isRoot[u] && indeg[u] === 0) queue.push(u);
  for (let k = 0; k < queue.length; k++) {
    const u = queue[k]!;
    for (let x = outA[u]!, end = x + outN[u]!; x < end; x++) {
      const v = outT[x]!;
      if (isRoot[v]) continue;
      if (--indeg[v]! === 0) queue.push(v);
    }
  }
  const n = queue.length;
  const pos = new Int32Array(T).fill(-1);
  for (let i = 0; i < n; i++) pos[queue[i]!] = i;
  const ids = new Array<ID>(n);
  const loose = new Set<ID>();
  // 範囲の ID の表をそのまま番号の表にする（同じ大きさの表を 2 つ作らない）
  const idx = tmp;
  for (let u = 0; u < T; u++) {
    const p = pos[u]!;
    if (p >= 0) {
      ids[p] = tid[u]!;
      idx.set(tid[u]!, p);
    } else {
      loose.add(tid[u]!);
      idx.delete(tid[u]!);
    }
  }
  const off = new Int32Array(n + 1);
  let slots = 0;
  for (let i = 0; i < n; i++) {
    off[i] = slots;
    slots += outN[queue[i]!]!;
  }
  off[n] = slots;
  const tgt = new Int32Array(slots);
  const src = new Int32Array(slots);
  const eid = new Array<ID>(slots);
  const tgtLoose = new Map<number, ID>();
  const firstParent = new Int32Array(n).fill(-1);
  const nodeObj = new Array<GNode | undefined>(n);
  const edgeObj = new Array<GEdge | undefined>(slots);
  const incCount = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const u = queue[i]!;
    nodeObj[i] = doc.nodes[ids[i]!];
    const a = outA[u]!;
    const cnt = outN[u]!;
    for (let k = 0; k < cnt; k++) {
      const s = off[i]! + k;
      const e = outE[a + k]!;
      const j = pos[outT[a + k]!]!;
      tgt[s] = j;
      src[s] = i;
      eid[s] = e.id;
      edgeObj[s] = e;
      if (j < 0) tgtLoose.set(s, e.target);
      else {
        incCount[j + 1]!++;
        if (firstParent[j] === -1) firstParent[j] = i;
      }
    }
  }
  const { incOff, incSlot, merges } = incoming(n, tgt, incCount);
  const roots: number[] = [];
  for (const r of rootIds) {
    const j = idx.get(r);
    if (j !== undefined) roots.push(j);
  }
  const topo: Topo = { n, ids, idx, loose, scopeSize: T, rootIds, roots, off, tgt, src, eid, eidx: null, tgtLoose, incOff, incSlot, firstParent, merges, bfs: null, map: null, cm: null };
  return { topo, seen: { nodeObj, edgeObj } };
}

/** 線の ID → 線の番号（初めて使うときに 1 度だけ作る。7 万本で 15 ms ほどかかるので、形を作るときには作らない） */
export function edgeIndex(topo: Topo): Map<ID, number> {
  if (topo.eidx) return topo.eidx;
  const m = new Map<ID, number>();
  const { eid } = topo;
  for (let s = 0; s < eid.length; s++) if (!m.has(eid[s]!)) m.set(eid[s]!, s);
  topo.eidx = m;
  return m;
}

/** 線 e（文書の物）の線の番号。範囲の線でなければ −1（線の ID の表を作らずに、先のノードに入る線から探す） */
export function slotOfEdge(topo: Topo, e: { id: ID; target: ID }): number {
  const j = topo.idx.get(e.target);
  if (j === undefined) return topo.tgtLoose.size ? (edgeIndex(topo).get(e.id) ?? -1) : -1;
  for (let k = topo.incOff[j]!; k < topo.incOff[j + 1]!; k++) {
    const s = topo.incSlot[k]!;
    if (topo.eid[s] === e.id) return s;
  }
  return -1;
}

/** 入ってくる線（incCount[j + 1] = j へ入る線の数）。2 本以上入るノードがあれば merges */
export function incoming(n: number, tgt: Int32Array, incCount: Int32Array): { incOff: Int32Array; incSlot: Int32Array; merges: boolean } {
  const incOff = new Int32Array(n + 1);
  let merges = false;
  for (let i = 0; i < n; i++) {
    if (incCount[i + 1]! > 1) merges = true;
    incOff[i + 1] = incOff[i]! + incCount[i + 1]!;
  }
  const fill = new Int32Array(n);
  const incSlot = new Int32Array(incOff[n]!);
  for (let s = 0; s < tgt.length; s++) {
    const j = tgt[s]!;
    if (j < 0) continue;
    incSlot[incOff[j]! + fill[j]!] = s;
    fill[j]!++;
  }
  return { incOff, incSlot, merges };
}

/** 入口の設定（数字と概要を出す入口の meta.impact）。読めなければ既定 */
export function rootConfig(topo: Topo, seen: Seen): { horizon: number; annual?: number; tail?: number } {
  const r = topo.roots[0];
  const node = r !== undefined ? seen.nodeObj[r] : undefined;
  return impactConfigOf(node) ?? { horizon: 36 };
}

/** vec3（./impact.ts）と同じ読み方で、3 つの数を out[at..at+2] に書く。読めなければ false（書かない）。配列を作らない */
function read3(v: unknown, out: Float64Array, at: number): boolean {
  if (!Array.isArray(v) || v.length !== 3) return false;
  const a = Number(v[0]);
  const b = Number(v[1]);
  const c = Number(v[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return false;
  out[at] = a;
  out[at + 1] = b;
  out[at + 2] = c;
  return true;
}

/** 線の見込み（forks.ts の probOf と同じ。数でなければ NaN） */
function probNum(e: GEdge): number {
  const v = e.meta?.prob;
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : NaN;
}

/** 数の入れ物（作るときだけ書く。Nums として渡した後は書き換えない） */
export type NumsArrays = { -readonly [K in keyof Nums]: Nums[K] };

/** 数を入れるときの入口の物（期限の起点・入口の月の稼ぎ・線の見込みの入れ物） */
export interface NumsBase {
  readonly H: number;
  readonly rootDay: number | null;
  readonly rootRR: Float64Array;
  readonly probs: Float64Array;
}

export function numsBase(topo: Topo, seen: Seen): NumsBase {
  const r0 = topo.roots[0];
  const rootNode = r0 !== undefined ? seen.nodeObj[r0] : undefined;
  const rootDay = rootNode && isDateStr(rootNode.time.due) ? dayNumber(rootNode.time.due) : null;
  const rootRR = new Float64Array(3);
  if (!read3(rootNode?.meta?.rr, rootRR, 0)) rootRR.set([1, 0, 0]);
  return { H: rootConfig(topo, seen).horizon, rootDay, rootRR, probs: new Float64Array(16) };
}

/**
 * ノード i の数（fillNums の 1 回目の所。tFloorI は先に数えた親の月の大きい方）: 種類・並び・今のまま・数字なし・手の種類・q・まとめ・月・
 * 月の稼ぎと、出る線の割合と線の並び。q を読んだら true
 */
export function numsNode(topo: Topo, seen: Seen, x: NumsArrays, b: NumsBase, i: number, tFloorI: number): boolean {
  const { off, firstParent } = topo;
  const { kind, t, rr, w, rank, isBase, noData, fam, rvKey, rvCat, q, stub, sum } = x;
  const node = seen.nodeObj[i]!;
  const edgeObj = seen.edgeObj;
  const meta = node.meta;
  const a = off[i]!;
  const e = off[i + 1]!;
  const deg = e - a;
  // 線の見込み（null は NaN）
  let anyProb = false;
  let known = 0;
  let sumKnown = 0;
  const pr = deg <= b.probs.length ? b.probs : new Float64Array(deg);
  for (let s = a; s < e; s++) {
    const p = probNum(edgeObj[s]!);
    pr[s - a] = p;
    if (!Number.isNaN(p)) {
      anyProb = true;
      known++;
      sumKnown = sumKnown + p;
    } else sumKnown = sumKnown + 0;
  }
  // 分かれ道の種類（forkKindOf と同じ順で決める）
  let k: number;
  const fork = meta?.fork;
  if (deg === 0) k = LEAF;
  else if (fork === "decision") k = DECISION;
  else if (fork === "chance") k = CHANCE;
  else if (anyProb) k = CHANCE;
  else if (deg >= 2) k = node.type === "goal" || node.type === "branch" ? DECISION : CHANCE;
  else k = PASS;
  kind[i] = k;
  rank[i] = typeof meta?.rank === "number" && Number.isFinite(meta.rank) ? (meta.rank as number) : 1e9 + i;
  isBase[i] = meta?.base === true ? 1 : 0;
  const ownRR = read3(meta?.rr, rr, i * 3);
  noData[i] = deg === 0 && !ownRR && typeof meta?.ak !== "string" && meta?.end !== true && !meta?.forecastRoot ? 1 : 0;
  fam[i] = typeof meta?.fam === "string" ? (meta.fam as string) : typeof meta?.ak === "string" ? (meta.ak as string) : "";
  let hasQ = false;
  if (read3(meta?.q, q, i * 3)) hasQ = true;
  else q[i * 3] = q[i * 3 + 1] = q[i * 3 + 2] = NaN;
  stub[i] = meta?.stub === true ? 1 : 0;
  sum[i] = meta?.sum === true ? 1 : 0;
  const fp = firstParent[i]!;
  const m = meta?.m;
  let ti: number;
  if (typeof m === "number" && Number.isFinite(m)) ti = m;
  else if (b.rootDay !== null && isDateStr(node.time.due)) ti = (dayNumber(node.time.due) - b.rootDay) / 30.44;
  else ti = fp >= 0 ? t[fp]! : 0;
  t[i] = Math.min(b.H, Math.max(0, tFloorI, ti));
  if (!ownRR) {
    if (fp >= 0) {
      rr[i * 3] = rr[fp * 3]!;
      rr[i * 3 + 1] = rr[fp * 3 + 1]!;
      rr[i * 3 + 2] = rr[fp * 3 + 2]!;
    } else {
      rr[i * 3] = b.rootRR[0]!;
      rr[i * 3 + 1] = b.rootRR[1]!;
      rr[i * 3 + 2] = b.rootRR[2]!;
    }
  }
  // 結果の割合（chanceWeights と同じ: % の無い線には残りを等分。どれにも無いか合計が 0 なら等分）
  if (k === CHANCE) {
    if (known === 0) for (let s = a; s < e; s++) w[s] = 1 / deg;
    else {
      const unknown = deg - known;
      const share = unknown ? Math.max(0, 100 - sumKnown) / unknown : 0;
      let total = 0;
      for (let s = a; s < e; s++) {
        const p = pr[s - a]!;
        total = total + (Number.isNaN(p) ? share : p);
      }
      for (let s = a; s < e; s++) {
        const p = pr[s - a]!;
        w[s] = total > 0 ? (Number.isNaN(p) ? share : p) / total : 1 / deg;
      }
    }
  } else for (let s = a; s < e; s++) w[s] = 1;
  for (let s = a; s < e; s++) {
    const rv = edgeObj[s]!.meta?.rv;
    if (Array.isArray(rv) && typeof rv[0] === "string" && typeof rv[1] === "string") {
      rvKey[s] = rv[0];
      rvCat[s] = rv[1];
    } else rvKey[s] = rvCat[s] = null;
  }
  return hasQ;
}

/** ノード i の出る線の稼ぎと、判断の今のままの線（fillNums の 2 回目の所。全部の月が決まってから） */
export function numsEdges(topo: Topo, seen: Seen, x: NumsArrays, i: number): void {
  const { off, tgt } = topo;
  const { kind, t, rr, er, base, isBase } = x;
  for (let s = off[i]!; s < off[i + 1]!; s++) {
    if (!read3(seen.edgeObj[s]!.meta?.r, er, s * 3)) {
      const j = tgt[s]!;
      const dt = j >= 0 ? Math.max(0, t[j]! - t[i]!) : 0;
      er[s * 3] = rr[i * 3]! * dt;
      er[s * 3 + 1] = rr[i * 3 + 1]! * dt;
      er[s * 3 + 2] = rr[i * 3 + 2]! * dt;
    }
  }
  base[i] = -1;
  if (kind[i] === DECISION) {
    for (let s = off[i]!; s < off[i + 1]!; s++) {
      const j = tgt[s]!;
      if (j >= 0 && isBase[j]) {
        base[i] = s;
        break;
      }
    }
  }
}

/** 空の数の入れ物（n ノード・slots 本の線） */
export function newNums(H: number, n: number, slots: number): NumsArrays {
  return {
    H,
    kind: new Uint8Array(n),
    t: new Float64Array(n),
    rr: new Float64Array(n * 3),
    w: new Float64Array(slots),
    er: new Float64Array(slots * 3),
    base: new Int32Array(n).fill(-1),
    rank: new Float64Array(n),
    isBase: new Uint8Array(n),
    noData: new Uint8Array(n),
    fam: new Array<string>(n),
    rvKey: new Array<string | null>(slots).fill(null),
    rvCat: new Array<string | null>(slots).fill(null),
    q: new Float64Array(n * 3).fill(NaN),
    stub: new Uint8Array(n),
    likeBasis: false,
    sum: new Uint8Array(n),
  };
}

/**
 * 数を文書から入れる（computeImpact の compile の数の所と同じ。形は topo のまま）。seen は今の文書の物（ノードは番号ごと、線は線ごと）。
 * 分かれ道の種類（forkKindOf）・結果の割合（chanceWeights）・3 つの数（vec3）は、同じ決まり・同じ足し算の順で、配列を作らずに数える
 */
export function fillNums(topo: Topo, seen: Seen): Nums {
  const { n, off, tgt } = topo;
  const b = numsBase(topo, seen);
  const x = newNums(b.H, n, off[n]!);
  const tFloor = new Float64Array(n);
  const t = x.t;
  for (let i = 0; i < n; i++) {
    if (numsNode(topo, seen, x, b, i, tFloor[i]!)) x.likeBasis = true;
    for (let s = off[i]!; s < off[i + 1]!; s++) {
      const j = tgt[s]!;
      if (j >= 0 && t[i]! > tFloor[j]!) tFloor[j] = t[i]!;
    }
  }
  // 線の稼ぎ（先のノードの月が要るので、全部の月が決まってから）
  for (let i = 0; i < n; i++) numsEdges(topo, seen, x, i);
  return x;
}

/** 状態を文書の物から全部入れる */
export function fillStatus(topo: Topo, seen: Seen): Uint8Array {
  const stat = new Uint8Array(topo.n);
  for (let i = 0; i < topo.n; i++) stat[i] = statusCode(seen.nodeObj[i]);
  return stat;
}

/** 判断の線が方針に入るか（computeImpact と同じ: 判断でない線・方針を選んでいない・線のシナリオが空・含む なら 1） */
export function fillAllowed(topo: Topo, nums: Nums, seen: Seen, sid: ID | null): Uint8Array {
  const { n, off } = topo;
  const allowed = new Uint8Array(off[n]!).fill(1);
  if (sid === null) return allowed;
  for (let i = 0; i < n; i++) {
    if (nums.kind[i] !== DECISION) continue;
    for (let s = off[i]!; s < off[i + 1]!; s++) {
      const sc = seen.edgeObj[s]!.scenarioIds;
      allowed[s] = sc.length === 0 || sc.includes(sid) ? 1 : 0;
    }
  }
  return allowed;
}

/** 計算に渡す形（./impact.ts の backward・forward がそのまま読む） */
export function assemble(topo: Topo, nums: Nums, stat: Uint8Array, allowed: Uint8Array): Compiled {
  return {
    ids: topo.ids,
    idx: topo.idx,
    kind: nums.kind,
    t: nums.t,
    rr: nums.rr,
    off: topo.off,
    tgt: topo.tgt,
    eid: topo.eid,
    w: nums.w,
    er: nums.er,
    allowed,
    base: nums.base,
    stat,
    rank: nums.rank,
    isBase: nums.isBase,
    noData: nums.noData,
    fam: nums.fam,
    roots: topo.roots,
    rvKey: nums.rvKey,
    rvCat: nums.rvCat,
    incOff: topo.incOff,
    incSlot: topo.incSlot,
    src: topo.src,
    q: nums.q,
    stub: nums.stub,
    likeBasis: nums.likeBasis,
  };
}

const rippleMemo = new WeakMap<Nums, Int32Array>();

/**
 * 先の数（自分を含む）: [判断, 出来事の分かれ, 行き先, まとめた行き先] を 4 つずつ。子は後ろの番号の物だけ足す（入口へ戻る線・循環を数えない）。
 * 下から 1 度だけ数えて、形と数（分かれ道の種類）ごとに覚える（perf-14。描くたび・選ぶたびにたどらない）
 */
export function rippleCounts(topo: Topo, nums: Nums): Int32Array {
  const hit = rippleMemo.get(nums);
  if (hit) return hit;
  const { n, off, tgt } = topo;
  const out = new Int32Array(n * 4);
  for (let x = n - 1; x >= 0; x--) {
    const k = nums.kind[x]!;
    const deg = off[x + 1]! - off[x]!;
    const x4 = x * 4;
    if (k === DECISION && deg >= 2) out[x4]!++;
    if (k === CHANCE && deg >= 2) out[x4 + 1]!++;
    if (k === LEAF) {
      out[x4 + 2]!++;
      if (nums.sum[x]) out[x4 + 3]!++;
    }
    for (let s = off[x]!; s < off[x + 1]!; s++) {
      const y = tgt[s]!;
      if (y <= x) continue;
      const y4 = y * 4;
      out[x4] = out[x4]! + out[y4]!;
      out[x4 + 1] = out[x4 + 1]! + out[y4 + 1]!;
      out[x4 + 2] = out[x4 + 2]! + out[y4 + 2]!;
      out[x4 + 3] = out[x4 + 3]! + out[y4 + 3]!;
    }
  }
  rippleMemo.set(nums, out);
  return out;
}

// ------------------------------------------------------------ 同梱の地図（版 7）から

/**
 * 地図の番号ごとのノードと親からの線の ID（buildQuarterDoc と同じ: n_i_ / e_i_ + 鍵の 64 ビットの指紋 14 文字。
 * src/demo/impact.ts の impactNodeId64・impactEdgeId64 と同じ文字。初めから 1 つの文字列で作る）
 */
export function quarterIds(map: MapData): { node: readonly ID[]; edge: readonly ID[] } {
  // 組み立て・保存の基準・地図の画面と同じ表（地図ごとに 1 度だけ数える: src/demo/quarterIds.ts）
  return quarterIdTable(map);
}

/** 版 7 の地図の計算の芯（同じ地図なら 1 度だけ作る。見取り図などの画面もこれを使う） */
const cmMemo = new WeakMap<MapData, CompiledMap>();
export function compiledMapOf(map: MapData): CompiledMap {
  let cm = cmMemo.get(map);
  if (!cm) cmMemo.set(map, (cm = compileMap(map)));
  return cm;
}

/**
 * 地図の番号ごとの、文書のノードと親からの線（ID と物）。組み立てたままの文書は、ノードも線も地図の番号の順に入っているので、
 * 文書の鍵の並びをそのまま使う（同じ文字列の鍵で引くと速い。新しく作った ID の文字列で 7 万回引くと、それだけで 30 ms ほどかかる）。
 * 並びが違えば（後から入れ替えた文書など）、鍵の指紋から作った ID で引く。どちらでも、ノードの鍵（meta.key）・線の両端を確かめ、合わなければ null
 */
function docObjectsOf(map: MapData, cm: CompiledMap, doc: DocData): { ids: ID[]; eids: ID[]; nodeObj: Array<GNode | undefined>; edgeObj: Array<GEdge | undefined> } | null {
  const n = cm.n;
  const { parent } = cm;
  // 文書の鍵の並び（組み立ての順）が地図の番号の順か: 数と、飛び飛びの番号（と最初と最後）のノードの鍵・線の両端で確かめる。
  // 形を変えるとエンジンは組み立てたままと見なさなくなるので（ImpactEngine.note）、ここに来る文書は組み立てたまま。並びの確かめは念のため
  const nodeKeys = Object.keys(doc.nodes);
  const edgeKeys = Object.keys(doc.edges);
  const STEP = 61;
  const fits = (i: number): boolean => {
    const x = doc.nodes[nodeKeys[i]!];
    if (!x || x.meta?.key !== map.key(i)) return false;
    if (i === 0) return true;
    const e = doc.edges[edgeKeys[i - 1]!];
    return !!e && e.target === nodeKeys[i] && e.source === nodeKeys[parent[i]!] && isFlowEdge(e);
  };
  let ok = nodeKeys.length >= n && edgeKeys.length >= n - 1;
  for (let i = 0; ok && i < n; i += STEP) ok = fits(i);
  if (ok) ok = fits(n - 1);
  const ids = new Array<ID>(n);
  const eids = new Array<ID>(n);
  const nodeObj = new Array<GNode | undefined>(n);
  const edgeObj = new Array<GEdge | undefined>(n);
  if (ok) {
    for (let i = 0; i < n; i++) {
      const id = nodeKeys[i]!;
      ids[i] = id;
      nodeObj[i] = doc.nodes[id];
    }
    for (let c = 1; c < n; c++) {
      const id = edgeKeys[c - 1]!;
      eids[c] = id;
      edgeObj[c] = doc.edges[id];
    }
    for (let i = 0; i < n; i++) if (!nodeObj[i]) return null;
    for (let c = 1; c < n; c++) if (!edgeObj[c]) return null;
    return { ids, eids, nodeObj, edgeObj };
  }
  // 並びが違う: 鍵の指紋から作った ID で引き、全部を確かめる
  const made = quarterIds(map);
  for (let i = 0; i < n; i++) {
    const x = doc.nodes[made.node[i]!];
    if (!x || x.meta?.key !== map.key(i)) return null;
    ids[i] = made.node[i]!;
    nodeObj[i] = x;
  }
  for (let c = 1; c < n; c++) {
    const id = made.edge[c]!;
    const e = doc.edges[id];
    if (!e || e.target !== ids[c] || e.source !== ids[parent[c]!] || !isFlowEdge(e)) return null;
    eids[c] = id;
    edgeObj[c] = e;
  }
  return { ids, eids, nodeObj, edgeObj };
}

/**
 * 同梱の地図の列から形と数を作る（数は文書を読み直さない。文書からは、ノードと線の物と状態だけを引く）。
 * 文書が地図のとおりに組み立てたままでない（ノード・線が無い・親子が違う）ときは null（compileDocTopo で作り直す）。
 * 文書にほかの入口や、地図のカードから出る別の線が無いことは、呼ぶ側が確かめておく（組み立ててから形を変えていない）
 */
export function compileMapDoc(map: MapData, doc: DocData, cm0?: CompiledMap): { topo: Topo; nums: Nums; seen: Seen } | null {
  const cm = cm0 && cm0.map === map ? cm0 : compiledMapOf(map);
  const n = cm.n;
  const objs = docObjectsOf(map, cm, doc);
  if (!objs) return null;
  const { ids, nodeObj } = objs;
  if (!isImpactRoot(nodeObj[0])) return null;
  const { kidOff, kids, role, parent } = cm;
  const slots = n - 1;
  const off = kidOff;
  const tgt = kids;
  const src = new Int32Array(slots);
  const eid = new Array<ID>(slots);
  const edgeObj = new Array<GEdge | undefined>(slots);
  for (let i = 0; i < n; i++) {
    for (let s = off[i]!; s < off[i + 1]!; s++) {
      const c = tgt[s]!;
      src[s] = i;
      eid[s] = objs.eids[c]!;
      edgeObj[s] = objs.edgeObj[c];
    }
  }
  const idx = new Map<ID, number>();
  for (let i = 0; i < n; i++) idx.set(ids[i]!, i);
  const incCount = new Int32Array(n + 1);
  for (let s = 0; s < slots; s++) incCount[tgt[s]! + 1]!++;
  const { incOff, incSlot } = incoming(n, tgt, incCount);
  const firstParent = Int32Array.from(parent);
  // 行き先を数える順（computeImpact の並べる順 = 幅優先、兄弟は並べる順）
  const bfs = new Int32Array(n);
  bfs[0] = 0;
  for (let h = 0, len = 1; h < len; h++) {
    const x = bfs[h]!;
    for (let s = off[x]!; s < off[x + 1]!; s++) bfs[len++] = tgt[s]!;
  }
  const topo: Topo = {
    n,
    ids,
    idx,
    loose: new Set(),
    scopeSize: n,
    rootIds: [ids[0]!],
    roots: [0],
    off,
    tgt,
    src,
    eid,
    eidx: null,
    tgtLoose: new Map(),
    incOff,
    incSlot,
    firstParent,
    merges: false,
    bfs,
    map,
    cm,
  };
  // 数: 計算の芯の列から（アプリの compile と同じ決まりで作ってある: 月は親より前にせず H に収める・手の月の稼ぎは判断の物・
  // 手への線の稼ぎは判断の月の稼ぎ × 経った月・結果の割合は chanceWeights と同じ）
  const H = cm.H;
  const kind = new Uint8Array(n);
  const w = new Float64Array(slots);
  const er = new Float64Array(slots * 3);
  const base = new Int32Array(n).fill(-1);
  const rank = new Float64Array(n);
  const isBase = new Uint8Array(n);
  const fam = new Array<string>(n);
  const rvKey = new Array<string | null>(slots).fill(null);
  const rvCat = new Array<string | null>(slots).fill(null);
  const sum = new Uint8Array(n);
  const stub = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = off[i]!;
    const b = off[i + 1]!;
    const r = role[i]!;
    kind[i] = a === b ? LEAF : r === ROLE_A ? CHANCE : DECISION;
    rank[i] = i === 0 ? 1e9 : cm.rank[i]!;
    const f = cm.flags[i]!;
    isBase[i] = f & F_BASE ? 1 : 0;
    if (r === ROLE_A && f & F_STUB) stub[i] = 1;
    fam[i] = r === ROLE_A ? cm.famNames[cm.fam[i]!]! : "";
    if (r === ROLE_E && map.sum(i)) sum[i] = 1;
    for (let s = a; s < b; s++) {
      const c = tgt[s]!;
      w[s] = r === ROLE_A ? cm.w[c]! : 1;
      if (r === ROLE_A) {
        // 結果の線: 地図の稼ぎ（文書の線の meta.r と同じ）
        er[s * 3] = cm.e[c * 3]!;
        er[s * 3 + 1] = cm.e[c * 3 + 1]!;
        er[s * 3 + 2] = cm.e[c * 3 + 2]!;
      } else {
        // 手への線（meta.r が無い）: 判断の月の稼ぎ × 経った月（computeImpact と同じ掛け算。0 か月でも −0 まで同じ）
        const dt = Math.max(0, cm.month[c]! - cm.month[i]!);
        er[s * 3] = cm.rr[i * 3]! * dt;
        er[s * 3 + 1] = cm.rr[i * 3 + 1]! * dt;
        er[s * 3 + 2] = cm.rr[i * 3 + 2]! * dt;
      }
      const fi = cm.rvFact[c]!;
      if (fi >= 0) {
        rvKey[s] = cm.facts[fi]!;
        rvCat[s] = cm.answers[cm.rvAns[c]!]!;
      }
      if (base[i]! < 0 && r !== ROLE_A && (cm.flags[c]! & F_BASE) !== 0) base[i] = s;
    }
  }
  if (role[0] !== ROLE_R) return null;
  const nums: Nums = { H, kind, t: cm.month, rr: cm.rr, w, er, base, rank, isBase, noData: new Uint8Array(n), fam, rvKey, rvCat, q: cm.q, stub, likeBasis: cm.has.q > 0, sum };
  return { topo, nums, seen: { nodeObj, edgeObj } };
}

