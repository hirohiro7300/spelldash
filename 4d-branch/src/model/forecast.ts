// 見込みの計算（未来の道筋の予測）。
// 予測の入口（meta.forecastRoot のノード。「今日」）を 100% として、「進む」「条件付き」の線に沿って確からしさを流す。
// 分岐ノードでは、出ていく線の見込み（edge.meta.prob、0〜100 の %）の割合で分ける。分岐でないノードは、出ていく先へそのまま渡す。
// 合流では足し合わせる（未来の道筋では、合流してくる道は別々の選択肢なので、同時には起きない）。
// シナリオを選んでいるときは、そのシナリオを通る線だけで流し、分岐ごとに割合を配り直す（＝そのシナリオを選んだ場合の見込み）。
//
// 「3 年の分かれ道」（入口の meta.impact.v === 2）の範囲の中だけは、分かれ道の種類（forks.ts）で流し方を決める:
//   結果（chance）は線の % で分け、判断（decision）と通過は出ていく先へそのまま渡す（＝その手を選んだ場合の見込み）。
//   シナリオ（方針）で絞るのは判断から出る線だけ（運の結果は方針では選べないので絞らない）。
// アプリは同じ答えの速い作り ForecastPlan（下）を使う（方針に依らない所を 1 度作り、方針ごとに型付きの配列で流し直す）。
// computeForecast は基準（tests/unit/forecastFast.test.ts）と、1 回だけ数える所で使う

import { chanceWeights, flowOuts, forkKindOf, impactScope, probOf, type ForkKind } from "./forks";
import type { DocData, GEdge, GNode, ID } from "./types";

export interface Reach {
  /** ここに至る見込み（0〜1） */
  p: number;
  /** 今日から何歩目か（いちばん短い道） */
  minSteps: number;
  /** 今日から何歩目か（いちばん長い道） */
  maxSteps: number;
}

export interface ForecastResult {
  /** 予測の入口があるか（無ければ見込みは出さない） */
  active: boolean;
  reach: ReadonlyMap<ID, Reach>;
  /** 行き先（その先へ進む線が無いノード）を見込みの高い順に */
  ends: ID[];
  /** 入口から最も長い道の歩数 */
  longest: number;
  /** 流した順（入口から。届いたノードだけ） */
  order: ID[];
  /** 「3 年の分かれ道」の範囲（v2 の入口が無ければ空） */
  impactScope: ReadonlySet<ID>;
}

export const isForecastRoot = (n: GNode): boolean => n.meta?.forecastRoot === true;

/** 線の見込み（%）。数でなければ null */
export const edgeProb: (e: GEdge) => number | null = probOf;

/** 見込みの表し方: 10% 以上は整数、1% 以上は小数 1 桁、それより小さければ「0.1% 未満」まで */
export function formatPercent(p: number): string {
  const pct = p * 100;
  if (pct >= 99.95) return "100%";
  if (pct >= 10) return `${Math.round(pct)}%`;
  if (pct >= 0.95) return `${(Math.round(pct * 10) / 10).toFixed(1).replace(/\.0$/, "")}%`;
  if (pct >= 0.05) return `${pct.toFixed(1)}%`;
  return pct > 0 ? "0.1% 未満" : "0%";
}

/** 分岐から出る線ごとの割合（合計 1）。見込みの無い線には残りを等分する。kind は「3 年の分かれ道」の範囲の中だけ */
/**
 * 運の分かれ道の分け方を out に足す（chanceWeights(edges.slice(a, b)) と同じ数を同じ順の足し算で。並びを作らない: 8 万枚の計画で
 * 3 万回呼ぶ: 見直し perf-9）
 */
function pushChance(edges: readonly GEdge[], a: number, b: number, out: number[]): void {
  const cnt = b - a;
  if (!cnt) return;
  let sumKnown = 0;
  let unknown = 0;
  for (let k = a; k < b; k++) {
    const v = probOf(edges[k]!);
    if (v === null) unknown++;
    sumKnown = sumKnown + (v ?? 0);
  }
  if (unknown === cnt) {
    for (let k = 0; k < cnt; k++) out.push(1 / cnt);
    return;
  }
  const share = unknown ? Math.max(0, 100 - sumKnown) / unknown : 0;
  let total = 0;
  for (let k = a; k < b; k++) total = total + (probOf(edges[k]!) ?? share);
  if (total > 0) for (let k = a; k < b; k++) out.push((probOf(edges[k]!) ?? share) / total);
  else for (let k = 0; k < cnt; k++) out.push(1 / cnt);
}

function splitOf(node: GNode, edges: GEdge[], kind: ForkKind | null): number[] {
  if (kind !== null) return kind === "chance" ? chanceWeights(edges) : edges.map(() => 1);
  if (node.type !== "branch" || !edges.length) return edges.map(() => 1);
  const known = edges.map(edgeProb);
  if (known.every((v) => v === null)) return edges.map(() => 1);
  const sumKnown = known.reduce<number>((n, v) => n + (v ?? 0), 0);
  const unknown = known.filter((v) => v === null).length;
  const share = unknown ? Math.max(0, 100 - sumKnown) / unknown : 0;
  const raw = known.map((v) => v ?? share);
  const total = raw.reduce((n, v) => n + v, 0);
  return total > 0 ? raw.map((v) => v / total) : edges.map(() => 1 / edges.length);
}

/**
 * 見込みを計算する。out はノード → 出ていく線の id（graph の索引と同じ形）。
 * 循環に入ったノードは見込みを出さない（未来の道筋は循環しない）。
 */
export function computeForecast(doc: DocData, out: Map<ID, ID[]>, scenarioId: ID | null = null): ForecastResult {
  const roots: ID[] = [];
  for (const id in doc.nodes) if (isForecastRoot(doc.nodes[id]!)) roots.push(id);
  const reachMap = new Map<ID, Reach>();
  const result: ForecastResult = { active: roots.length > 0, reach: reachMap, ends: [], longest: 0, order: [], impactScope: new Set() };
  if (!roots.length) return result;
  const scope = impactScope(doc, out);
  result.impactScope = scope;
  const inScen = (e: GEdge) => !scenarioId || e.scenarioIds.length === 0 || e.scenarioIds.includes(scenarioId);
  const kinds = new Map<ID, ForkKind>();
  /** 範囲の中なら分かれ道の種類（シナリオで絞る前の線で決める）。範囲の外は null */
  const kindOf = (id: ID): ForkKind | null => {
    if (!scope.has(id)) return null;
    let k = kinds.get(id);
    if (k === undefined) kinds.set(id, (k = forkKindOf(doc.nodes[id]!, flowOuts(doc, out, id))));
    return k;
  };
  const outsOf = (id: ID): GEdge[] => {
    const all = (out.get(id) ?? []).map((eid) => doc.edges[eid]).filter((e): e is GEdge => !!e && (e.relation === "leads" || e.relation === "condition") && !!doc.nodes[e.target]);
    if (!scenarioId) return all;
    const k = kindOf(id);
    if (k !== null && k !== "decision") return all;
    return all.filter(inScen);
  };

  // 入口から届くノードと、いちばん短い歩数
  const minSteps = new Map<ID, number>(roots.map((r) => [r, 0]));
  const queue = [...roots];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    for (const e of outsOf(id)) {
      if (minSteps.has(e.target)) continue;
      minSteps.set(e.target, minSteps.get(id)! + 1);
      queue.push(e.target);
    }
  }
  // 届くノードの中で、入ってくる線の数を数え、入口から順に流す
  const indeg = new Map<ID, number>();
  for (const id of minSteps.keys()) indeg.set(id, 0);
  for (const id of minSteps.keys()) for (const e of outsOf(id)) indeg.set(e.target, indeg.get(e.target)! + 1);
  const mass = new Map<ID, number>(roots.map((r) => [r, 1]));
  const maxSteps = new Map<ID, number>(roots.map((r) => [r, 0]));
  const ready = [...minSteps.keys()].filter((id) => indeg.get(id) === 0);
  while (ready.length) {
    const id = ready.pop()!;
    const m = Math.min(1, mass.get(id) ?? 0);
    const d = maxSteps.get(id) ?? 0;
    const p = { p: m, minSteps: minSteps.get(id)!, maxSteps: d };
    reachMap.set(id, p);
    result.order.push(id);
    result.longest = Math.max(result.longest, d);
    const edges = outsOf(id);
    if (!edges.length) result.ends.push(id);
    const split = splitOf(doc.nodes[id]!, edges, kindOf(id));
    edges.forEach((e, i) => {
      mass.set(e.target, (mass.get(e.target) ?? 0) + m * split[i]!);
      maxSteps.set(e.target, Math.max(maxSteps.get(e.target) ?? 0, d + 1));
      const left = indeg.get(e.target)! - 1;
      indeg.set(e.target, left);
      if (left === 0) ready.push(e.target);
    });
  }
  result.ends.sort((a, b) => result.reach.get(b)!.p - result.reach.get(a)!.p || (doc.nodes[a]!.title || "").localeCompare(doc.nodes[b]!.title || "", "ja"));
  return result;
}

/** 見込みの速い作りに渡す物（見え方の計算が持っている物を使い回す） */
export interface ForecastInputs {
  /** 予測の入口（文書の順） */
  roots: readonly ID[];
  /** 「3 年の分かれ道」の範囲 */
  impactScope: ReadonlySet<ID>;
}

let endCollator: Intl.Collator | null = null;

/** 届いたノードの見込み（型付きの配列から、読まれたときに作る。同じ ID には同じ物） */
class ReachMap implements ReadonlyMap<ID, Reach> {
  private readonly made = new Map<ID, Reach>();
  constructor(
    private readonly idx: ReadonlyMap<ID, number>,
    private readonly done: Uint8Array,
    private readonly p: Float64Array,
    private readonly minS: Int32Array,
    private readonly maxS: Int32Array,
    private readonly order: readonly ID[],
  ) {}
  get size(): number {
    return this.order.length;
  }
  has(id: ID): boolean {
    const i = this.idx.get(id);
    return i !== undefined && this.done[i] === 1;
  }
  get(id: ID): Reach | undefined {
    let r = this.made.get(id);
    if (r) return r;
    const i = this.idx.get(id);
    if (i === undefined || this.done[i] !== 1) return undefined;
    r = { p: this.p[i]!, minSteps: this.minS[i]!, maxSteps: this.maxS[i]! };
    this.made.set(id, r);
    return r;
  }
  /** 流した順（computeForecast の Map の順と同じ） */
  keys(): MapIterator<ID> {
    return this.order[Symbol.iterator]() as MapIterator<ID>;
  }
  *values(): MapIterator<Reach> {
    for (const id of this.order) yield this.get(id)!;
  }
  *entries(): MapIterator<[ID, Reach]> {
    for (const id of this.order) yield [id, this.get(id)!];
  }
  [Symbol.iterator](): MapIterator<[ID, Reach]> {
    return this.entries();
  }
  forEach(fn: (value: Reach, key: ID, map: ReadonlyMap<ID, Reach>) => void, thisArg?: unknown): void {
    for (const id of this.order) fn.call(thisArg, this.get(id)!, id, this);
  }
}

/**
 * 見込みの計画（computeForecast と同じ答えを型付きの配列で出す速い作り。作業メモ perf-2）。
 * 方針（シナリオ）に依らない所（入口から道の線でたどれるノードの番号・出る線・分かれ道の種類・分け方）を 1 度だけ作り、
 * run(方針) は、その方針で通る線だけをたどり直して流す（O(ノード + 線) の型付きの配列。方針を変えるたびに文書を読み直さない）。
 * 同じ順に足すので、見込みの数は 1 ビットまで computeForecast と同じ。見込みの Reach は読まれたときに作り、行き先の並べ替えも読まれたときにする。
 * 作り直すのは、見込みに使う物（道の線・% ・線のシナリオ・入口・種類）が変わったとき（読み手が版で決める）。
 * tests/unit/forecastFast.test.ts が computeForecast と同じかを確かめる
 */
/** 計画のノード 1 つの分かれ道の種類と分け方（edges はそのノードの出る道の線。範囲の外は種類 null） */
function planNode(n: GNode, id: ID, edges: readonly GEdge[], scope: ReadonlySet<ID>): { kind: ForkKind | null; split: number[] } {
  const cnt = edges.length;
  let self = false;
  for (const e of edges) if (e.target === id) self = true;
  // 分かれ道の種類（自分への線を除く出る線で決める: forkKindOf）と分け方（splitOf）。印（meta.fork）のある所は並びを作らずに
  let kind: ForkKind | null = null;
  if (scope.has(id)) {
    const f = n.meta?.fork;
    if (cnt === 0 || (self && !edges.some((e) => e.source !== e.target))) kind = "leaf";
    else if (f === "decision" || f === "chance") kind = f;
    else kind = forkKindOf(n, edges.filter((e) => e.source !== e.target));
  }
  const split: number[] = [];
  if (kind !== null && kind !== "chance") for (let k = 0; k < cnt; k++) split.push(1);
  else if (kind === "chance") pushChance(edges, 0, cnt, split);
  else for (const x of splitOf(n, edges.slice(), kind)) split.push(x);
  return { kind, split };
}

/** 計画の中身（ForecastPlan が持つ物） */
interface PlanParts {
  ids: ID[];
  idx: Map<ID, number>;
  off: Int32Array;
  tgt: Int32Array;
  edges: GEdge[];
  kinds: Array<ForkKind | null>;
  split: Float64Array;
  rootIdx: number[];
}

/** 計画を作る（ノード 2,048 ずつ yield する: 空いた時間に少しずつ作れる。最後に中身を返す） */
function* planParts(doc: DocData, out: Map<ID, ID[]>, inp: ForecastInputs): Generator<void, PlanParts> {
  const scope = inp.impactScope;
  const ids: ID[] = [];
  const idx = new Map<ID, number>();
  for (const r of inp.roots) {
    if (idx.has(r)) continue;
    idx.set(r, ids.length);
    ids.push(r);
  }
  const rootIdx = inp.roots.map((r) => idx.get(r)!);
  const offL: number[] = [];
  const tgtL: number[] = [];
  const edges: GEdge[] = [];
  const kinds: Array<ForkKind | null> = [];
  const splitL: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    if ((i & 2047) === 2047) yield;
    const id = ids[i]!;
    const n = doc.nodes[id]!;
    offL.push(edges.length);
    const a = edges.length;
    for (const eid of out.get(id) ?? []) {
      const e = doc.edges[eid];
      if (!e || (e.relation !== "leads" && e.relation !== "condition") || !doc.nodes[e.target]) continue;
      edges.push(e);
      let j = idx.get(e.target);
      if (j === undefined) {
        j = ids.length;
        idx.set(e.target, j);
        ids.push(e.target);
      }
      tgtL.push(j);
    }
    const x = planNode(n, id, edges.slice(a), scope);
    kinds.push(x.kind);
    for (const w of x.split) splitL.push(w);
  }
  offL.push(edges.length);
  return { ids, idx, off: Int32Array.from(offL), tgt: Int32Array.from(tgtL), edges, kinds, split: Float64Array.from(splitL), rootIdx };
}

/** 少しずつ作る計画（step を true が返るまで呼ぶ。でき上がった計画は plan） */
export interface PlanSteps {
  step(): boolean;
  readonly plan: ForecastPlan | null;
}

export class ForecastPlan {
  /** 番号（方針なしで入口から届いた順） → ノード */
  private readonly ids: ID[];
  private readonly idx: Map<ID, number>;
  /** 出る線（outsOf の方針なしの物と同じ選び方・並び）: [off[i], off[i + 1]) */
  private off: Int32Array;
  private tgt: Int32Array;
  private edges: GEdge[];
  /** 分かれ道の種類（範囲の外は null） */
  private kinds: Array<ForkKind | null>;
  /** 方針なしの分け方（結果の線の割合。判断・通過は 1。範囲の外の分岐は方針で変わるので、方針があればその都度） */
  private split: Float64Array;
  private readonly rootIdx: number[];
  private scope: ReadonlySet<ID>;
  constructor(
    private doc: DocData,
    out: Map<ID, ID[]>,
    inp: ForecastInputs,
    parts?: PlanParts,
  ) {
    let p = parts;
    if (!p) {
      const g = planParts(doc, out, inp);
      for (let r = g.next(); ; r = g.next())
        if (r.done) {
          p = r.value;
          break;
        }
    }
    this.scope = inp.impactScope;
    this.ids = p.ids;
    this.idx = p.idx;
    this.off = p.off;
    this.tgt = p.tgt;
    this.edges = p.edges;
    this.kinds = p.kinds;
    this.split = p.split;
    this.rootIdx = p.rootIdx;
  }

  /**
   * 計画を少しずつ作る（空いた時間に: 8 万枚の地図では 1 度に作ると、4 倍遅いスマホで 0.4 秒ほどの 1 つの仕事になる。見直し perf-1）。
   * 作る間、文書と出る線の索引は、見込みに使う所が変わらないこと（変わったら呼ぶ側がやめて作り直す）
   */
  static steps(doc: DocData, out: Map<ID, ID[]>, inp: ForecastInputs): PlanSteps {
    const g = planParts(doc, out, inp);
    let plan: ForecastPlan | null = null;
    return {
      step: () => {
        if (plan) return true;
        const r = g.next();
        if (!r.done) return false;
        plan = new ForecastPlan(doc, out, inp, r.value);
        return true;
      },
      get plan() {
        return plan;
      },
    };
  }

  /** その方針（無ければ null）での見込み */
  /**
   * 見込みに使う所が同じまま文書の物だけ替わった（全部の入れ替えを変わった物だけで受けた: 見直し perf-4）: 新しい文書と、その線の物を読む
   * （前の文書の物を持ち続けない。見込みに使う所が変わったら、読み手は計画を作り直す）
   */
  rebase(doc: DocData): void {
    this.doc = doc;
    const edges = this.edges;
    for (let k = 0; k < edges.length; k++) {
      const e = doc.edges[edges[k]!.id];
      if (e) edges[k] = e;
    }
  }

  /**
   * 葉のカードを足した・消しただけの変更（Tab・その元に戻す・行き先を消す。見込みに使う所の変更はその線とノードだけ）を、
   * 計画を作り直さずに直す（作業メモ perf-4）。touched は線を足した・消したノードとその先（出る線・種類を読み直す）、gone は消したノード、
   * scope は変更の後の範囲。新しく届くノードは後ろの番号に足す（流す答えは番号の振り方に依らない: 入口・線の並び・届いた順だけで決まる）。
   * 入口を消すなど直せなければ false（読み手が作り直す）
   */
  patch(doc: DocData, out: Map<ID, ID[]>, scope: ReadonlySet<ID>, touched: Iterable<ID>, gone: Iterable<ID>): boolean {
    const idx = this.idx;
    const ids = this.ids;
    for (const id of gone) {
      const i = idx.get(id);
      if (i === undefined) continue;
      if (this.rootIdx.includes(i)) return false;
      // 消したノードの番号は使わない（そこへの線は、線の元を読み直して外す）
      idx.delete(id);
    }
    this.doc = doc;
    this.scope = scope;
    const lists = new Map<number, { edges: GEdge[]; tgt: number[]; kind: ForkKind | null; split: number[] }>();
    const queue: number[] = [];
    for (const id of touched) {
      const i = idx.get(id);
      if (i !== undefined && !lists.has(i)) {
        lists.set(i, { edges: [], tgt: [], kind: null, split: [] });
        queue.push(i);
      }
    }
    if (!queue.length) return true;
    for (let k = 0; k < queue.length; k++) {
      const i = queue[k]!;
      const id = ids[i]!;
      const n = doc.nodes[id];
      if (!n) return false;
      const x = lists.get(i)!;
      for (const eid of out.get(id) ?? []) {
        const e = doc.edges[eid];
        if (!e || (e.relation !== "leads" && e.relation !== "condition") || !doc.nodes[e.target]) continue;
        x.edges.push(e);
        let j = idx.get(e.target);
        if (j === undefined) {
          // 新しく届くノード: 後ろの番号に足し、その出る線も読む
          j = ids.length;
          idx.set(e.target, j);
          ids.push(e.target);
          lists.set(j, { edges: [], tgt: [], kind: null, split: [] });
          queue.push(j);
        }
        x.tgt.push(j);
      }
      const p = planNode(n, id, x.edges, scope);
      x.kind = p.kind;
      x.split = p.split;
    }
    // 線の並びを作り直す（読み直したノードはその線、ほかは前の線）
    const N = ids.length;
    let slots = 0;
    for (let i = 0; i < N; i++) {
      const x = lists.get(i);
      slots += x ? x.edges.length : this.off[i + 1]! - this.off[i]!;
    }
    const off = new Int32Array(N + 1);
    const tgt = new Int32Array(slots);
    const split = new Float64Array(slots);
    const edges = new Array<GEdge>(slots);
    const kinds = this.kinds.slice();
    let s = 0;
    for (let i = 0; i < N; i++) {
      off[i] = s;
      const x = lists.get(i);
      if (x) {
        for (let k = 0; k < x.edges.length; k++, s++) {
          tgt[s] = x.tgt[k]!;
          split[s] = x.split[k]!;
          edges[s] = x.edges[k]!;
        }
        kinds[i] = x.kind;
      } else {
        for (let k = this.off[i]!; k < this.off[i + 1]!; k++, s++) {
          tgt[s] = this.tgt[k]!;
          split[s] = this.split[k]!;
          edges[s] = this.edges[k]!;
        }
      }
    }
    off[N] = s;
    this.off = off;
    this.tgt = tgt;
    this.split = split;
    this.edges = edges;
    this.kinds = kinds;
    return true;
  }

  run(scenarioId: ID | null): ForecastResult {
    const ids = this.ids;
    const N = ids.length;
    const doc = this.doc;
    if (!this.rootIdx.length) return { active: false, reach: new Map(), ends: [], longest: 0, order: [], impactScope: this.scope };
    const { off, tgt, edges, kinds, split } = this;
    /** その方針で通る線か（判断の線と範囲の外の線だけを方針で絞る。運の結果は絞らない） */
    const pass = (i: number, k: number): boolean => {
      if (!scenarioId) return true;
      const kind = kinds[i]!;
      if (kind !== null && kind !== "decision") return true;
      const e = edges[k]!;
      return e.scenarioIds.length === 0 || e.scenarioIds.includes(scenarioId);
    };
    // 入口から届くノードと、いちばん短い歩数（届いた順）
    const minS = new Int32Array(N).fill(-1);
    const seq: number[] = [];
    for (const r of this.rootIdx) {
      if (minS[r]! >= 0) continue;
      minS[r] = 0;
      seq.push(r);
    }
    for (let q = 0; q < seq.length; q++) {
      const i = seq[q]!;
      for (let k = off[i]!; k < off[i + 1]!; k++) {
        if (!pass(i, k)) continue;
        const j = tgt[k]!;
        if (minS[j]! >= 0) continue;
        minS[j] = minS[i]! + 1;
        seq.push(j);
      }
    }
    // 届くノードの中で、入ってくる線の数を数え、入口から順に流す
    const indeg = new Int32Array(N);
    for (const i of seq) for (let k = off[i]!; k < off[i + 1]!; k++) if (pass(i, k)) indeg[tgt[k]!]!++;
    const mass = new Float64Array(N);
    const maxS = new Int32Array(N);
    const p = new Float64Array(N);
    const done = new Uint8Array(N);
    for (const r of this.rootIdx) mass[r] = 1;
    const ready: number[] = [];
    for (const i of seq) if (indeg[i] === 0) ready.push(i);
    const order: ID[] = [];
    const endIdx: number[] = [];
    let longest = 0;
    const tmpE: GEdge[] = [];
    const tmpK: number[] = [];
    while (ready.length) {
      const i = ready.pop()!;
      const m = Math.min(1, mass[i]!);
      const d = maxS[i]!;
      p[i] = m;
      done[i] = 1;
      order.push(ids[i]!);
      longest = Math.max(longest, d);
      const a = off[i]!;
      const b = off[i + 1]!;
      const kind = kinds[i]!;
      // 方針で線が減るのは判断の線か範囲の外の線（判断は分け方が 1、範囲の外の分岐は通る線だけで分け直す）
      const filtered = !!scenarioId && (kind === null || kind === "decision");
      if (!filtered) {
        if (a === b) endIdx.push(i);
        for (let k = a; k < b; k++) {
          const j = tgt[k]!;
          mass[j] = mass[j]! + m * split[k]!;
          maxS[j] = Math.max(maxS[j]!, d + 1);
          if (--indeg[j]! === 0) ready.push(j);
        }
        continue;
      }
      tmpE.length = 0;
      tmpK.length = 0;
      for (let k = a; k < b; k++) {
        if (!pass(i, k)) continue;
        tmpE.push(edges[k]!);
        tmpK.push(k);
      }
      if (!tmpE.length) endIdx.push(i);
      const w = kind === null ? splitOf(doc.nodes[ids[i]!]!, tmpE, null) : null;
      for (let x = 0; x < tmpK.length; x++) {
        const k = tmpK[x]!;
        const j = tgt[k]!;
        mass[j] = mass[j]! + m * (w ? w[x]! : 1);
        maxS[j] = Math.max(maxS[j]!, d + 1);
        if (--indeg[j]! === 0) ready.push(j);
      }
    }
    const reach = new ReachMap(this.idx, done, p, minS, maxS, order);
    const result: ForecastResult = { active: true, reach, ends: [], longest, order, impactScope: this.scope };
    // 行き先の並び（見込みの高い順・同じ見込みは題名の順。computeForecast の localeCompare("ja") と同じ並べ方）は、読まれたときに。
    // 題名はそのときの計画の文書から読む（流した時の文書を持ち続けない: 取り込みの写しを残さない。見直し perf-4）
    let ends: ID[] | null = null;
    const plan = this;
    Object.defineProperty(result, "ends", {
      enumerable: true,
      configurable: true,
      get: (): ID[] => {
        if (!ends) {
          const col = (endCollator ??= new Intl.Collator("ja"));
          const nodes = plan.doc.nodes;
          const sorted = endIdx.slice().sort((x, y) => p[y]! - p[x]! || col.compare(nodes[ids[x]!]?.title || "", nodes[ids[y]!]?.title || ""));
          ends = sorted.map((i) => ids[i]!);
        }
        return ends;
      },
    });
    return result;
  }
}

/** computeForecast と同じ答えの速い作り（計画を作って 1 回流す。何度も方針を変えるなら ForecastPlan を持っておく） */
export function computeForecastFast(doc: DocData, out: Map<ID, ID[]>, inp: ForecastInputs, scenarioId: ID | null = null): ForecastResult {
  return new ForecastPlan(doc, out, inp).run(scenarioId);
}
