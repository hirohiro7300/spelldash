// アプリの 3 年の影響の計算（エンジン）。設計: 作業メモ SPEC v1 §7.1 の 1〜4・7・11（見直し perf-1・perf-2・perf-5・perf-8・perf-11・perf-13・perf-14）
//
// 版 6 の地図も版 7 の地図も、利用者が形を変えた地図も、1 つのエンジンで数える。答えは ./impact.ts の computeImpact（基準の作り）と同じ
// （tests/unit/impactEngine*.test.ts。値・差・選び方・見込み・行き先・分布・印・年収の境目・やらない場合・おすすめの値）。
//
// 組み直した形（./impactGraph.ts）は版ごとに分けて持ち、文書の変更（ストアの ChangeInfo）を見て、要る所だけやり直す（perf-11）:
//   形（カード・線の増減と付け替え・入口）: 組み直す。版 7 の地図を組み立てたままなら同梱の地図の列から（文書を読み直さない: SPEC D6）
//   数（% ・月・月の稼ぎ・今のまま・種類・事実・q）: 文書から数を入れ直す
//   状態（選んだ・見送った）: 変わったノードだけ入れ直す
//   方針（シナリオ）・年収: 入れ直さず、計算（逆にたどる・前へ流す）だけやり直す
// 題名・本文・タグ・やること・位置・線の説明と条件だけの変更では何もしない（同じ結果の物を返す）。
//
// 結果（ImpactResult）は型付き配列の上の読み口で、ノードごとの Map を作らない（perf-2）。選択肢の詳細（AltInfo）・判断の詳細・結果の詳細は
// 読まれたときに作って覚える（会社の答えを聞く手の「同じ答えの世界」の計算 evalFixed もそのときだけ。見えている・選んだ手だけ）。
// おすすめの値は 1 回の計算（選んだ手を外し、方針で絞らない: perf-5）、年収の境目は 1 回の計算ずつ進められる（画面を描いた後に: perf-8）。

import type { CompiledMap } from "../deepmap/core/compile";
import type { MapData } from "../deepmap/mapData";
import { isFlowEdge, isImpactRoot, type ForkKind } from "./forks";
import { assemble, compileDocTopo, compileMapDoc, edgeIndex, fillAllowed, fillNums, fillStatus, rippleCounts, rootConfig, slotOfEdge, statusCode, type Nums, type Seen, type Topo } from "./impactGraph";
import {
  backward,
  BAD_EPS,
  CHANCE,
  compareCands,
  DECISION,
  decisionMarks,
  distOf,
  emptyImpact,
  forward,
  IMPACT_DEFAULT_ANNUAL,
  KIND_NAMES,
  LEAF,
  likeOf,
  likeVecOf,
  newPass,
  optionMark,
  PASS,
  salaryFlipSteps,
  shownDelta,
  sumV,
  validAnnual,
  type AltInfo,
  type AltOutcome,
  type Compiled,
  type DecisionInfo,
  type DecisionMarks,
  type ImpactDist,
  type ImpactEnd,
  type ImpactResult,
  type ImpactRipple,
  type NeverResult,
  type Pass,
  type SalaryFlips,
  type Vec3,
} from "./impact";
import { impactBin } from "./impactFormat";
import type { DocData, GEdge, GNode, ID } from "./types";

/** エンジンが文書の外から受け取る物 */
export interface EngineInputs {
  doc: DocData;
  /** 選んでいる方針（文書に無い方針なら null を渡す） */
  sid: ID | null;
  /** 文書の索引の出る線（形を文書から作り直すときだけ呼ぶ） */
  out: () => Map<ID, ID[]>;
  /** 3 年の分かれ道の入口（文書の順）。渡せば形を作り直すときに文書を全部なめて探さない（索引が持っている物: 見直し perf-9） */
  roots?: () => ID[];
  /** 見込み（P_path。合流のある地図で、そこまでの稼ぎの重みに使う）とその版。合流が無ければ呼ばない */
  reach: () => { version: number; of: (id: ID) => number };
}

/** 変わった物の印 */
const C_TOPO = 1;
const C_NUMS = 2;
const C_STATUS = 4;
const C_SCEN = 8;
const C_PRESENT = 16;

/** 計算に使わない・どれにも当たらないノードの所（変わっても何もしない） */
const NODE_SKIP: ReadonlySet<string> = new Set(["id", "title", "body", "tags", "conditions", "x", "y", "updatedAt", "collapsed", "createdAt", "status", "type", "meta", "time", "projectIds", "scenarioIds"]);
/** 数に使う meta の名前（変わったら数を入れ直す。forecastRoot は数字なしの手の見分けにも使う） */
const NODE_NUM_META: readonly string[] = ["fork", "m", "rr", "rank", "base", "fam", "ak", "end", "q", "stub", "sum", "forecastRoot"];
/** 数の meta と impact のほか（変わったら見せ方だけ）。ノードごとに作らない（全部の入れ替えでは 7 万枚を比べる） */
const META_SKIP: ReadonlySet<string> = new Set([...NODE_NUM_META, "impact"]);
const EDGE_SKIP: ReadonlySet<string> = new Set(["id", "label", "condition", "updatedAt", "collapsed", "createdAt", "source", "target", "relation", "scenarioIds", "meta"]);
const EDGE_NUM_META: readonly string[] = ["prob", "r", "rv"];

/**
 * 中身の比較（配列は要素ごと、オブジェクトはキーごと。深さ 4 段まで、それより深い所は物が同じかだけ）。物が違うときだけ呼ばれる
 * （取り込みの写しは物がどれも新しいので、入口の meta.never・premises のような中の配列・オブジェクトも中身で比べる: 見直し perf-4）
 */
function same1(a: unknown, b: unknown, depth = 4): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || depth <= 0) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!same1(a[i], b[i], depth - 1)) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra);
  if (ka.length !== Object.keys(rb).length) return false;
  for (const k of ka) if (!(k in rb) || !same1(ra[k], rb[k], depth - 1)) return false;
  return true;
}

/** names のほかの所が 1 段の比較で同じか（names は比べない） */
function sameRest(a: Record<string, unknown>, b: Record<string, unknown>, skip: ReadonlySet<string>): boolean {
  for (const k of Object.keys(a)) if (!skip.has(k) && !same1(a[k], b[k])) return false;
  for (const k of Object.keys(b)) if (!skip.has(k) && !(k in a)) return false;
  return true;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** ノードの変更の印（old と now は同じ ID の前と後。primary は数字を出す入口） */
function nodeChange(old: GNode, now: GNode, primary: boolean): number {
  const rootOld = isImpactRoot(old);
  const rootNow = isImpactRoot(now);
  if (rootOld !== rootNow) return C_TOPO;
  if (rootNow && old.createdAt !== now.createdAt) return C_TOPO;
  let c = 0;
  if (old.status !== now.status) c |= C_STATUS;
  if (old.type !== now.type) c |= C_NUMS;
  if (old.meta !== now.meta) {
    const a = old.meta ?? {};
    const b = now.meta ?? {};
    for (const k of NODE_NUM_META) if (!same1(a[k], b[k])) c |= C_NUMS;
    if (!same1(a.impact, b.impact)) {
      const ia = (a.impact ?? {}) as Record<string, unknown>;
      const ib = (b.impact ?? {}) as Record<string, unknown>;
      // 期間は月の上限（数）。年収・その後に足す月は計算の入力（結果の鍵で見る）
      if (!Object.is(ia.horizon, ib.horizon)) c |= C_NUMS;
      else c |= C_PRESENT;
    }
    if (!sameRest(a, b, META_SKIP)) c |= C_PRESENT;
  }
  if (!same1(old.time, now.time)) {
    // 月（meta.m）があれば期限は数に使わない。数字を出す入口の期限は、月の無いノードの月の元
    if (primary || !isNum(old.meta?.m) || !isNum(now.meta?.m)) c |= C_NUMS;
    else c |= C_PRESENT;
  }
  if (!same1(old.projectIds, now.projectIds) || !same1(old.scenarioIds, now.scenarioIds)) c |= C_PRESENT;
  if (!sameRest(old as unknown as Record<string, unknown>, now as unknown as Record<string, unknown>, NODE_SKIP)) c |= C_PRESENT;
  return c;
}

/** 線の変更の印（組み直した線の前と後） */
function edgeChange(old: GEdge, now: GEdge): number {
  if (old.source !== now.source || old.target !== now.target || isFlowEdge(old) !== isFlowEdge(now)) return C_TOPO;
  let c = 0;
  if (old.relation !== now.relation) c |= C_PRESENT;
  if (!same1(old.scenarioIds, now.scenarioIds)) c |= C_SCEN;
  if (old.meta !== now.meta) {
    const a = old.meta ?? {};
    const b = now.meta ?? {};
    for (const k of EDGE_NUM_META) if (!same1(a[k], b[k])) c |= C_NUMS;
    if (!sameRest(a, b, new Set(EDGE_NUM_META))) c |= C_PRESENT;
  }
  if (!sameRest(old as unknown as Record<string, unknown>, now as unknown as Record<string, unknown>, EDGE_SKIP)) c |= C_PRESENT;
  return c;
}

/** 計算の版（どれかが変わると結果を作り直す） */
interface Versions {
  topology: number;
  numbers: number;
  statuses: number;
  scenario: number;
  present: number;
}

/** 計算した物（年収・状態・方針ごと。表示の印だけの変更では同じ物を使い回す） */
interface Run {
  readonly key: string;
  readonly topo: Topo;
  readonly nums: Nums;
  readonly c: Compiled;
  readonly annual: number;
  readonly S: number;
  readonly tail: number;
  readonly H: number;
  readonly sid: ID | null;
  /** q のある地図で方針を選んでいるとき、方針の印（判断の線ごと。数は全部の手で数える: computeImpact と同じ）。それ以外は null */
  readonly shown: Uint8Array | null;
  readonly main: Pass;
  readonly P: Float64Array;
  readonly sq: Pass;
  readonly Psq: Float64Array;
  readonly A: Float64Array;
  readonly Adef: Uint8Array;
  /** 年収の境目の覚え（年収・方針・形・数・状態ごと） */
  readonly flipsKey: string;
}

/** 形と数ごとに 1 度だけ数える物（判断の持ち主の線・数） */
interface NumsInfo {
  /** 手 j を選択肢として持つ判断の線（computeImpact の「最初の判断」。無ければ −1） */
  owner: Int32Array;
  counts: { nodes: number; decisions: number; options: number; forks: number; ends: number };
  /** 判断の番号（並べる順） */
  decisions: number[];
  /** 選択肢の ID（線の順。初めて読まれたときに作る。結果ごとには作らない: 見直し perf-8） */
  altIds: ID[] | null;
  /** 手の種類（基準を除く。初めて読まれたときに） */
  families: string[] | null;
}

const numsInfo = new WeakMap<Nums, NumsInfo>();

function infoOf(topo: Topo, nums: Nums): NumsInfo {
  let x = numsInfo.get(nums);
  if (x) return x;
  const { n, off, tgt, src } = topo;
  const { kind } = nums;
  const owner = new Int32Array(n).fill(-1);
  let decisions = 0;
  let options = 0;
  let forks = 0;
  let ends = 0;
  const dl: number[] = [];
  for (let i = 0; i < n; i++) {
    const k = kind[i]!;
    const deg = off[i + 1]! - off[i]!;
    if (deg >= 2) forks++;
    if (k === DECISION) {
      dl.push(i);
      if (deg >= 2) decisions++;
      options += deg;
    }
    if (k === LEAF) ends++;
  }
  for (let s = 0; s < tgt.length; s++) {
    const j = tgt[s]!;
    if (j >= 0 && owner[j] === -1 && kind[src[s]!] === DECISION) owner[j] = s;
  }
  x = { owner, counts: { nodes: topo.scopeSize, decisions, options, forks, ends }, decisions: dl, altIds: null, families: null };
  numsInfo.set(nums, x);
  return x;
}

/** 範囲（数えるノードと、循環で数えないノード） */
class ScopeView implements ReadonlySet<ID> {
  constructor(private readonly topo: Topo) {}
  get size(): number {
    return this.topo.scopeSize;
  }
  has(id: ID): boolean {
    return this.topo.idx.has(id) || this.topo.loose.has(id);
  }
  *keys(): SetIterator<ID> {
    yield* this.topo.ids;
    yield* this.topo.loose;
  }
  values(): SetIterator<ID> {
    return this.keys();
  }
  *entries(): SetIterator<[ID, ID]> {
    for (const id of this.keys()) yield [id, id];
  }
  forEach(fn: (value: ID, key: ID, set: ReadonlySet<ID>) => void, thisArg?: unknown): void {
    for (const id of this.keys()) fn.call(thisArg, id, id, this);
  }
  [Symbol.iterator](): SetIterator<ID> {
    return this.keys();
  }
}

/** 番号ごとの値の読み口（at が undefined を返す番号は無い物として扱う） */
class IndexMap<V> implements ReadonlyMap<ID, V> {
  private count = -1;
  constructor(
    private readonly topo: Topo,
    private readonly at: (i: number) => V | undefined,
  ) {}
  get(id: ID): V | undefined {
    const i = this.topo.idx.get(id);
    return i === undefined ? undefined : this.at(i);
  }
  has(id: ID): boolean {
    return this.get(id) !== undefined;
  }
  get size(): number {
    if (this.count < 0) {
      let c = 0;
      for (let i = 0; i < this.topo.n; i++) if (this.at(i) !== undefined) c++;
      this.count = c;
    }
    return this.count;
  }
  *entries(): MapIterator<[ID, V]> {
    for (let i = 0; i < this.topo.n; i++) {
      const v = this.at(i);
      if (v !== undefined) yield [this.topo.ids[i]!, v];
    }
  }
  *keys(): MapIterator<ID> {
    for (const [k] of this.entries()) yield k;
  }
  *values(): MapIterator<V> {
    for (const [, v] of this.entries()) yield v;
  }
  forEach(fn: (value: V, key: ID, map: ReadonlyMap<ID, V>) => void, thisArg?: unknown): void {
    for (const [k, v] of this.entries()) fn.call(thisArg, v, k, this);
  }
  [Symbol.iterator](): MapIterator<[ID, V]> {
    return this.entries();
  }
}

/** ID の読み口（has と、全部を数える並び。並びは初めて使うときに作る） */
class LazySet implements ReadonlySet<ID> {
  private list: ID[] | null = null;
  constructor(
    private readonly hasFn: (id: ID) => boolean,
    private readonly listFn: () => ID[],
  ) {}
  private all(): ID[] {
    return (this.list ??= this.listFn());
  }
  get size(): number {
    return this.all().length;
  }
  has(id: ID): boolean {
    return this.hasFn(id);
  }
  *keys(): SetIterator<ID> {
    yield* this.all();
  }
  values(): SetIterator<ID> {
    return this.keys();
  }
  *entries(): SetIterator<[ID, ID]> {
    for (const id of this.all()) yield [id, id];
  }
  forEach(fn: (value: ID, key: ID, set: ReadonlySet<ID>) => void, thisArg?: unknown): void {
    for (const id of this.all()) fn.call(thisArg, id, id, this);
  }
  [Symbol.iterator](): SetIterator<ID> {
    return this.keys();
  }
}

/** ID ごとに作って覚える読み口（全部を並べるときは list の ID から） */
class LazyMap<V> implements ReadonlyMap<ID, V> {
  private readonly memo = new Map<ID, V | null>();
  private list: ID[] | null = null;
  constructor(
    private readonly make: (id: ID) => V | null,
    private readonly listFn: () => ID[],
  ) {}
  get(id: ID): V | undefined {
    let v = this.memo.get(id);
    if (v === undefined) this.memo.set(id, (v = this.make(id)));
    return v ?? undefined;
  }
  has(id: ID): boolean {
    return this.get(id) !== undefined;
  }
  private all(): ID[] {
    return (this.list ??= this.listFn().filter((id) => this.get(id) !== undefined));
  }
  get size(): number {
    return this.all().length;
  }
  *entries(): MapIterator<[ID, V]> {
    for (const id of this.all()) yield [id, this.get(id)!];
  }
  *keys(): MapIterator<ID> {
    yield* this.all();
  }
  *values(): MapIterator<V> {
    for (const id of this.all()) yield this.get(id)!;
  }
  forEach(fn: (value: V, key: ID, map: ReadonlyMap<ID, V>) => void, thisArg?: unknown): void {
    for (const [k, v] of this.entries()) fn.call(thisArg, v, k, this);
  }
  [Symbol.iterator](): MapIterator<[ID, V]> {
    return this.entries();
  }
}

/** 年収の境目の計算（エンジンが覚える。同じ鍵の結果は使い回す） */
interface FlipsTask {
  key: string;
  done: SalaryFlips | null;
  steps: Generator<void, SalaryFlips, void> | null;
}

/** 型付き配列の上の 3 年の影響の結果（computeImpact と同じ答え。詳細は読まれたときに作る） */
class EngineResult implements ImpactResult {
  readonly active = true;
  readonly root: ID;
  readonly scope: ReadonlySet<ID>;
  readonly annual: number;
  readonly annualSet: boolean;
  readonly S: number;
  readonly tail: number;
  readonly horizon: number;
  readonly likeBasis: boolean;
  readonly scenarioFree: boolean;
  readonly kind: ReadonlyMap<ID, ForkKind>;
  readonly month: ReadonlyMap<ID, number>;
  readonly value: ReadonlyMap<ID, number>;
  readonly valueV: ReadonlyMap<ID, Vec3>;
  readonly rate: ReadonlyMap<ID, number>;
  readonly acc: ReadonlyMap<ID, number>;
  readonly pPi: ReadonlyMap<ID, number>;
  readonly partial: ReadonlySet<ID>;
  readonly alt: ReadonlyMap<ID, AltInfo>;
  readonly decision: ReadonlyMap<ID, DecisionInfo>;
  readonly outcome: ReadonlyMap<ID, AltOutcome & { alt: ID }>;
  readonly piEdges: ReadonlySet<ID>;
  readonly vRoot: number | null;
  readonly vSQ: number | null;
  readonly rRoot: number | null;
  readonly rSQ: number | null;
  readonly counts: { nodes: number; decisions: number; options: number; forks: number; ends: number };
  private readonly info: NumsInfo;
  private endsCache: { ends: ImpactEnd[]; dist: ImpactDist | null } | null = null;
  private picks: boolean | null = null;
  private deltas: Float64Array | null = null;
  /** 判断ごとの印の元（作った判断だけ） */
  private readonly marks = new Map<number, DecisionMarks | null>();
  /** 同じ答えの世界の値（今のまま・事実・答えごと） */
  private readonly fixed = new Map<string, number | null>();
  private readonly neverMemo = new Map<string, NeverResult>();
  private rec: { v: number | null } | null = null;

  constructor(
    private readonly r: Run,
    private readonly flips: (r: Run) => FlipsTask,
    annualSet: boolean,
    private readonly scratch: () => Pass,
  ) {
    const { topo, nums, main, P, A, Adef } = r;
    const { t } = nums;
    this.info = infoOf(topo, nums);
    this.root = topo.rootIds[0]!;
    this.scope = new ScopeView(topo);
    this.annual = r.annual;
    // 年収が入っているか: 計算（Run）は年収の値ごとなので、仮の 360 と入れた 360 で同じ物を使う。印は結果ごとに今の物を（見直し equiv-2）
    this.annualSet = annualSet;
    this.S = r.S;
    this.tail = r.tail;
    this.horizon = r.H;
    this.likeBasis = nums.likeBasis;
    this.scenarioFree = r.shown !== null;
    this.kind = new IndexMap(topo, (i) => KIND_NAMES[nums.kind[i]!]);
    this.month = new IndexMap(topo, (i) => t[i]);
    this.value = new IndexMap(topo, (i) => (main.def[i] ? sumV(main.V, i) : undefined));
    this.valueV = new IndexMap(topo, (i) => (main.def[i] ? ([main.V[i * 3]!, main.V[i * 3 + 1]!, main.V[i * 3 + 2]!] as Vec3) : undefined));
    this.rate = new IndexMap(topo, (i) => (main.def[i] ? main.R[i] : undefined));
    this.acc = new IndexMap(topo, (i) => (Adef[i] ? A[i] : undefined));
    this.pPi = new IndexMap(topo, (i) => (P[i]! > 0 ? P[i] : undefined));
    this.partial = new LazySet(
      (id) => {
        const i = topo.idx.get(id);
        return i !== undefined && main.def[i] === 1 && main.partial[i] === 1;
      },
      () => topo.ids.filter((_, i) => main.def[i] === 1 && main.partial[i] === 1),
    );
    this.alt = new LazyMap((id) => this.makeAlt(id), () => this.altIds().slice());
    this.decision = new LazyMap((id) => this.makeDecision(id), () => this.decisionIds().slice());
    this.outcome = new LazyMap((id) => this.makeOutcome(id), () => this.outcomeIds());
    this.piEdges = new LazySet(
      (eid) => {
        const s = edgeIndex(topo).get(eid);
        return s !== undefined && this.onPi(s);
      },
      () => topo.eid.filter((_, s) => this.onPi(s)),
    );
    const r0 = topo.roots[0];
    this.vRoot = r0 !== undefined && main.def[r0] ? sumV(main.V, r0) : null;
    this.rRoot = r0 !== undefined && main.def[r0] ? main.R[r0]! : null;
    this.vSQ = r0 !== undefined && r.sq.def[r0] ? sumV(r.sq.V, r0) : null;
    this.rSQ = r0 !== undefined && r.sq.def[r0] ? r.sq.R[r0]! : null;
    this.counts = this.info.counts;
  }

  // ---- 小さな計算

  private Wsum(s: number): number {
    const er = this.r.c.er;
    return this.r.S * er[s * 3]! + er[s * 3 + 1]! + er[s * 3 + 2]!;
  }

  /** 手の線 s の値（computeImpact の Q）。数が出なければ null */
  private Q(p: Pass, s: number): number | null {
    const j = this.r.c.tgt[s]!;
    return j >= 0 && p.def[j] ? this.Wsum(s) + sumV(p.V, j) : null;
  }

  onPiEdge(e: { id: ID; target: ID }): boolean {
    const s = slotOfEdge(this.r.topo, e);
    return s >= 0 && this.onPi(s);
  }

  private onPi(s: number): boolean {
    const { c, main, P } = this.r;
    const i = c.src[s]!;
    if (!(P[i]! > 0)) return false;
    const k = c.kind[i]!;
    if (k === DECISION) return main.pi[i] === s;
    if (k === CHANCE || k === PASS) {
      const j = c.tgt[s]!;
      return j >= 0 && main.def[j] === 1;
    }
    return false;
  }

  /** 判断 d の ★・≒・おすすめの元 */
  private marksOf(d: number): DecisionMarks | null {
    let m = this.marks.get(d);
    if (m !== undefined) return m;
    const { c, main, S } = this.r;
    const cands: Array<{ s: number; q: number; l: number }> = [];
    for (let s = c.off[d]!; s < c.off[d + 1]!; s++) {
      const j = c.tgt[s]!;
      if (j < 0) continue;
      const qs = this.Q(main, s);
      if (qs === null || !c.allowed[s] || c.stat[j] === 2 || (c.noData[j] && c.stat[j] !== 1)) continue;
      cands.push({ s, q: qs, l: likeOf(c.q, j, S, qs) });
    }
    cands.sort((x, y) => compareCands(c, x, y));
    m = decisionMarks(cands, c.likeBasis);
    this.marks.set(d, m);
    return m;
  }

  /** 選択肢 j の印（AltInfo を作らない） */
  private markAt(s: number): AltInfo["mark"] {
    const { c, main, S } = this.r;
    const j = c.tgt[s]!;
    const m = this.marksOf(c.src[s]!);
    const qs = this.Q(main, s);
    const value = qs === null ? null : m?.like ? likeOf(c.q, j, S, qs) : qs;
    return optionMark(m, s, value, c.allowed[s] === 1 && c.stat[j] !== 2);
  }

  /** 画面に出す差（q のある地図は比べ方をそろえた値どうし: computeImpact と同じ shownDelta）。数が出なければ null */
  private shown(s: number, bs: number): ReturnType<typeof shownDelta> {
    const { c, main, S } = this.r;
    const j = c.tgt[s]!;
    if (bs < 0 || c.noData[j]) return null;
    return shownDelta(c, S, c.likeBasis, j, this.Q(main, s), c.tgt[bs]!, this.Q(main, bs));
  }

  /** 手ごとの今のままとの差（computeImpact の AltInfo.delta。持ち主の判断で。数が出なければ NaN）。順位のために 1 度だけ */
  private deltaArray(): Float64Array {
    if (this.deltas) return this.deltas;
    const { c } = this.r;
    const { owner } = this.info;
    const out = new Float64Array(c.ids.length).fill(NaN);
    for (let j = 0; j < out.length; j++) {
      const s = owner[j]!;
      if (s < 0 || c.noData[j]) continue;
      const sd = this.shown(s, c.base[c.src[s]!]!);
      if (sd) out[j] = sd.d;
    }
    this.deltas = out;
    return out;
  }

  /** 判断 d の差（DecisionInfo.stakes。q のある地図は選べる手の画面に出す差の一番大きい物、無い地図は一番良い手 − 今のまま） */
  private stakesAt(d: number): number | null {
    const { c, main } = this.r;
    const bs = c.base[d]!;
    const qBase = bs >= 0 ? this.Q(main, bs) : null;
    if (c.likeBasis) {
      let best: number | null = null;
      for (let s = c.off[d]!; s < c.off[d + 1]!; s++) {
        const j = c.tgt[s]!;
        if (j < 0) continue;
        // 候補（★ の候補と同じ: 方針に入り・見送りでなく・数が出る手）
        if (this.Q(main, s) === null || !c.allowed[s] || c.stat[j] === 2 || (c.noData[j] && c.stat[j] !== 1)) continue;
        const sd = this.shown(s, bs);
        if (sd && (best === null || sd.d > best)) best = sd.d;
      }
      if (best !== null) return best;
    }
    const bestS = main.best[d]!;
    const qBest = bestS >= 0 ? this.Q(main, bestS) : null;
    return qBest !== null && qBase !== null ? qBest - qBase : null;
  }

  /**
   * 選び方を決めたまま（main.pi）、start から先の値を出す。事実 R の答えを cat に決めた世界で数える（computeImpact の evalFixed と同じ）。
   * 今のまま・事実・答えごとに覚える（見えている・選んだ「聞く」手だけが呼ぶ）
   */
  private evalFixed(start: number, R: string, cat: string): number | null {
    const key = `${start}\u0000${R}\u0000${cat}`;
    if (this.fixed.has(key)) return this.fixed.get(key)!;
    const { c, main } = this.r;
    let out: number | null = null;
    if (main.def[start]) {
      const seen = new Set<number>();
      const stack = [start];
      while (stack.length) {
        const i = stack.pop()!;
        if (seen.has(i)) continue;
        seen.add(i);
        const k = c.kind[i]!;
        if (k === DECISION) {
          const s = main.pi[i]!;
          if (s >= 0) stack.push(c.tgt[s]!);
        } else if (k === CHANCE || k === PASS) {
          for (let s = c.off[i]!; s < c.off[i + 1]!; s++) if (c.tgt[s]! >= 0 && main.def[c.tgt[s]!]) stack.push(c.tgt[s]!);
        }
      }
      const val = new Map<number, number>();
      for (const i of [...seen].sort((a, b) => b - a)) {
        const k = c.kind[i]!;
        if (k === LEAF || c.off[i] === c.off[i + 1]) {
          val.set(i, sumV(main.V, i));
          continue;
        }
        if (k === DECISION) {
          const s = main.pi[i]!;
          const v = s >= 0 ? val.get(c.tgt[s]!) : undefined;
          if (v !== undefined) val.set(i, this.Wsum(s) + v);
          continue;
        }
        const a = c.off[i]!;
        const b = c.off[i + 1]!;
        let forced = false;
        for (let s = a; s < b; s++) if (c.rvKey[s] === R && c.rvCat[s] === cat) forced = true;
        let swF = 0;
        let svF = 0;
        let swA = 0;
        let svA = 0;
        let svE = 0;
        let cnt = 0;
        for (let s = a; s < b; s++) {
          const j = c.tgt[s]!;
          const v = j >= 0 ? val.get(j) : undefined;
          if (v === undefined) continue;
          const x = this.Wsum(s) + v;
          if (forced && c.rvKey[s] === R && c.rvCat[s] === cat) (swF += c.w[s]!), (svF += c.w[s]! * x);
          swA += c.w[s]!;
          svA += c.w[s]! * x;
          svE += x;
          cnt++;
        }
        if (cnt) val.set(i, forced && swF > 0 ? svF / swF : swA > 0 ? svA / swA : svE / cnt);
      }
      out = val.get(start) ?? null;
    }
    this.fixed.set(key, out);
    return out;
  }

  // ---- 詳細（読まれたときに作る）

  private makeAlt(id: ID): AltInfo | null {
    const { c, main, topo } = { c: this.r.c, main: this.r.main, topo: this.r.topo };
    const j = topo.idx.get(id);
    if (j === undefined) return null;
    const s = this.info.owner[j]!;
    if (s < 0) return null;
    const d = c.src[s]!;
    const bs = c.base[d]!;
    const qBase = bs >= 0 ? this.Q(main, bs) : null;
    const jBase = bs >= 0 ? c.tgt[bs]! : -1;
    const qs = this.Q(main, s);
    const sd = this.shown(s, bs);
    const delta = sd ? sd.d : null;
    let deltaV: Vec3 | null = null;
    const S = this.r.S;
    const er = c.er;
    if (sd && sd.basis === "q") {
      const vj = likeVecOf(c, j, S, [S * er[s * 3]! + main.V[j * 3]!, er[s * 3 + 1]! + main.V[j * 3 + 1]!, er[s * 3 + 2]! + main.V[j * 3 + 2]!])!;
      const vb = likeVecOf(c, jBase, S, [S * er[bs * 3]! + main.V[jBase * 3]!, er[bs * 3 + 1]! + main.V[jBase * 3 + 1]!, er[bs * 3 + 2]! + main.V[jBase * 3 + 2]!])!;
      deltaV = [vj[0] - vb[0], vj[1] - vb[1], vj[2] - vb[2]];
    } else if (delta !== null && jBase >= 0) {
      deltaV = [
        S * er[s * 3]! + main.V[j * 3]! - S * er[bs * 3]! - main.V[jBase * 3]!,
        er[s * 3 + 1]! + main.V[j * 3 + 1]! - er[bs * 3 + 1]! - main.V[jBase * 3 + 1]!,
        er[s * 3 + 2]! + main.V[j * 3 + 2]! - er[bs * 3 + 2]! - main.V[jBase * 3 + 2]!,
      ];
    }
    const dR = main.def[j] && !c.noData[j] && jBase >= 0 && main.def[jBase] ? main.R[j]! - main.R[jBase]! : null;
    const outcomes: AltOutcome[] = [];
    let pBad: number | null = null;
    let worst: number | null = null;
    const kj = c.kind[j]!;
    if (kj === CHANCE || kj === PASS) {
      let sw = 0;
      let cnt = 0;
      for (let o = c.off[j]!; o < c.off[j + 1]!; o++) {
        const t2 = c.tgt[o]!;
        if (t2 >= 0 && main.def[t2]) (sw += c.w[o]!), cnt++;
      }
      const equal = sw <= 0;
      const R = c.rvKey[c.off[j]!] ?? null;
      let matched: Map<string, number | null> | null = null;
      if (R !== null && bs >= 0 && jBase >= 0) {
        let same = true;
        for (let o = c.off[j]!; o < c.off[j + 1]!; o++) if (c.rvKey[o] !== R) same = false;
        if (same) {
          matched = new Map();
          for (let o = c.off[j]!; o < c.off[j + 1]!; o++) {
            const cat = c.rvCat[o]!;
            if (matched.has(cat)) continue;
            const v = this.evalFixed(jBase, R, cat);
            matched.set(cat, v === null ? null : this.Wsum(bs) + v);
          }
        }
      }
      let bad = 0;
      for (let o = c.off[j]!; o < c.off[j + 1]!; o++) {
        const t2 = c.tgt[o]!;
        const defined = t2 >= 0 && main.def[t2] === 1;
        const ww = defined && cnt ? (equal ? 1 : c.w[o]!) / (equal ? cnt : sw) : 0;
        const ref = matched ? (matched.get(c.rvCat[o]!) ?? qBase) : qBase;
        const u = defined && ref !== null ? this.Wsum(s) + this.Wsum(o) + sumV(main.V, t2) - ref : null;
        outcomes.push({ edge: c.eid[o]!, node: t2 >= 0 ? c.ids[t2]! : (topo.tgtLoose.get(o) ?? ""), w: ww, u, bin: impactBin(u) });
        if (u !== null && ww > 0) {
          if (u < -BAD_EPS) bad += ww;
          worst = worst === null ? u : Math.min(worst, u);
        }
      }
      pBad = qBase !== null && cnt ? bad : null;
    } else if (delta !== null) {
      pBad = delta < -BAD_EPS ? 1 : 0;
      worst = delta;
    }
    const m = this.marksOf(d);
    const value = qs === null ? null : m?.like ? likeOf(c.q, j, S, qs) : qs;
    const mark = optionMark(m, s, value, c.allowed[s] === 1 && c.stat[j] !== 2);
    if (c.isBase[j]) {
      pBad = null;
      worst = null;
    }
    return {
      decision: c.ids[d]!,
      edge: c.eid[s]!,
      isBase: c.isBase[j] === 1,
      allowed: (this.r.shown ?? c.allowed)[s] === 1,
      picked: c.stat[j] === 1,
      dropped: c.stat[j] === 2,
      delta,
      deltaBasis: sd ? sd.basis : null,
      deltaV,
      dR,
      pBad,
      worst,
      bin: impactBin(delta),
      mark,
      rec: !!m?.like && s === m.b1,
      partial: main.partial[j] === 1,
      outcomes,
    };
  }

  private makeDecision(id: ID): DecisionInfo | null {
    const { c, main, topo } = { c: this.r.c, main: this.r.main, topo: this.r.topo };
    const d = topo.idx.get(id);
    if (d === undefined || c.kind[d] !== DECISION) return null;
    const { owner } = this.info;
    const bs = c.base[d]!;
    const jBase = bs >= 0 ? c.tgt[bs]! : -1;
    const alts: Array<{ id: ID; rank: number; delta: number | null }> = [];
    let minD = Infinity;
    let maxD = -Infinity;
    for (let s = c.off[d]!; s < c.off[d + 1]!; s++) {
      const j = c.tgt[s]!;
      if (j < 0 || owner[j] !== s) continue;
      // その判断の手だけ（全部の手の差 deltaArray は順位のときだけ）。数の出し方は deltaArray と同じ
      const sd = this.shown(s, bs);
      const delta = sd ? sd.d : null;
      if (delta !== null) (minD = Math.min(minD, delta)), (maxD = Math.max(maxD, delta));
      alts.push({ id: c.ids[j]!, rank: c.rank[j]!, delta });
    }
    alts.sort((x, y) => x.rank - y.rank || (y.delta ?? -Infinity) - (x.delta ?? -Infinity));
    const bestS = main.best[d]!;
    const piS = main.pi[d]!;
    return {
      alts: alts.map((x) => x.id),
      base: jBase >= 0 ? c.ids[jBase]! : null,
      best: bestS >= 0 ? c.ids[c.tgt[bestS]!]! : null,
      chosen: piS >= 0 ? c.ids[c.tgt[piS]!]! : null,
      stakes: this.stakesAt(d),
      spread: minD <= maxD ? [minD, maxD] : null,
    };
  }

  /** 結果のノード（computeImpact の outcome: 選択肢の並びの順で最初にその結果を持つ手の、最初の線） */
  private makeOutcome(id: ID): (AltOutcome & { alt: ID }) | null {
    const { c, topo } = { c: this.r.c, topo: this.r.topo };
    const { owner } = this.info;
    let best = -1;
    let bestO = -1;
    const consider = (o: number) => {
      const u = c.src[o]!;
      const k = c.kind[u]!;
      if (k !== CHANCE && k !== PASS) return;
      const s = owner[u]!;
      if (s < 0) return;
      if (best < 0 || s < best || (s === best && o < bestO)) (best = s), (bestO = o);
    };
    const i = topo.idx.get(id);
    if (i !== undefined) for (let k = c.incOff[i]!; k < c.incOff[i + 1]!; k++) consider(c.incSlot[k]!);
    else if (topo.loose.has(id)) for (const [o, x] of topo.tgtLoose) if (x === id) consider(o);
    if (best < 0) return null;
    const u = c.src[bestO]!;
    const a = this.alt.get(c.ids[u]!);
    if (!a) return null;
    const o = a.outcomes[bestO - c.off[u]!]!;
    return { ...o, alt: c.ids[u]! };
  }

  private outcomeIds(): ID[] {
    const { c, topo } = { c: this.r.c, topo: this.r.topo };
    const out: ID[] = [];
    const seen = new Set<ID>();
    for (const aid of this.altIds()) {
      const u = topo.idx.get(aid)!;
      const k = c.kind[u]!;
      if (k !== CHANCE && k !== PASS) continue;
      for (let o = c.off[u]!; o < c.off[u + 1]!; o++) {
        const t2 = c.tgt[o]!;
        const nid = t2 >= 0 ? c.ids[t2]! : (topo.tgtLoose.get(o) ?? "");
        if (nid && !seen.has(nid)) (seen.add(nid), out.push(nid));
      }
    }
    return out;
  }

  // ---- 行き先と分布（初めて読まれたときに）

  private endsAndDist(): { ends: ImpactEnd[]; dist: ImpactDist | null } {
    if (this.endsCache) return this.endsCache;
    const { c, main, P, Psq, A, Adef, topo } = { c: this.r.c, main: this.r.main, P: this.r.P, Psq: this.r.Psq, A: this.r.A, Adef: this.r.Adef, topo: this.r.topo };
    const endItems: ImpactEnd[] = [];
    const sqItems: Array<{ v: number; w: number }> = [];
    const n = c.ids.length;
    // computeImpact の並べる順で数える（同じ見込み・同じ値の行き先の並びと、足す順を同じに）
    const order = topo.bfs;
    for (let k = 0; k < n; k++) {
      const i = order ? order[k]! : k;
      if (c.kind[i] !== LEAF || !main.def[i] || !Adef[i]) continue;
      const tot = A[i]! + sumV(main.V, i);
      if (P[i]! > 0) endItems.push({ id: c.ids[i]!, p: P[i]!, tot });
      if (Psq[i]! > 0) sqItems.push({ v: tot, w: Psq[i]! });
    }
    endItems.sort((x, y) => y.p - x.p || y.tot - x.tot);
    this.endsCache = { ends: endItems, dist: distOf(endItems, sqItems, this.vSQ) };
    return this.endsCache;
  }

  get ends(): ImpactEnd[] {
    return this.endsAndDist().ends;
  }

  get dist(): ImpactDist | null {
    return this.endsAndDist().dist;
  }

  get hasPicks(): boolean {
    if (this.picks === null) {
      const { c } = this.r;
      let h = false;
      for (const d of this.info.decisions) {
        for (let s = c.off[d]!; s < c.off[d + 1]!; s++) {
          const j = c.tgt[s]!;
          if (j >= 0 && c.stat[j] === 1) {
            h = true;
            break;
          }
        }
        if (h) break;
      }
      this.picks = h;
    }
    return this.picks;
  }

  // ---- 遅延計算

  salaryFlips(): SalaryFlips {
    let f = this.salaryFlipsStep();
    while (!f) f = this.salaryFlipsStep();
    return f;
  }

  salaryFlipsReady(): SalaryFlips | null {
    return this.flips(this.r).done;
  }

  salaryFlipsStep(): SalaryFlips | null {
    const task = this.flips(this.r);
    if (task.done) return task.done;
    if (!task.steps) {
      const { c, main, topo, tail, H } = this.r;
      const r0 = topo.roots[0];
      if (r0 === undefined) return (task.done = { below: null, above: null });
      const cur = main.best[r0]! >= 0 ? c.tgt[main.best[r0]!]! : -1;
      const bestAt = (a: number): number => {
        const p2 = backward(c, a / 12, tail, H, 0, null);
        const s = p2.best[r0]!;
        return s >= 0 ? c.tgt[s]! : -1;
      };
      task.steps = salaryFlipSteps(this.annual, cur, bestAt, (j) => c.ids[j]!);
    }
    const r = task.steps.next();
    if (r.done) {
      task.done = r.value;
      task.steps = null;
      return task.done;
    }
    return null;
  }

  never(f: string): NeverResult {
    const hit = this.neverMemo.get(f);
    if (hit) return hit;
    const { c, main, topo, S, tail, H } = this.r;
    // 深さ優先の順の木（同梱の地図から作った形）なら、判断の先だけを数える（選んだカードの 1 行のために全部を数えない）。
    // 判断の値はその先だけで決まるので、全部を数えた値と同じ。数えた後は数だけを覚え、計算はエンジンの入れ物 1 つに書いて捨てる
    // （カードを開くたびに地図の大きさの配列を残さない: 見直し perf-2・perf-3）
    const size = topo.cm ? topo.cm.size : null;
    const vals = new Map<number, number | null>();
    let whole = false;
    const valueAt = (i: number): number | null => {
      const v = vals.get(i);
      if (v !== undefined) return v;
      if (whole) return null;
      if (size) {
        const p = backward(c, S, tail, H, 2, f, i, i + size[i]!, this.scratch());
        const x = p.def[i] ? sumV(p.V, i) : null;
        vals.set(i, x);
        return x;
      }
      // 木でない形（文書から作った形）: 全部を 1 回数え、判断と入口の値を全部覚える
      const p = backward(c, S, tail, H, 2, f, 0, c.ids.length, this.scratch());
      for (const d of this.info.decisions) vals.set(d, p.def[d] ? sumV(p.V, d) : null);
      for (const r of topo.roots) vals.set(r, p.def[r] ? sumV(p.V, r) : null);
      whole = true;
      return vals.get(i) ?? null;
    };
    // 手ごとの差: computeImpact と同じく、並べる順で最初の（数の出る）判断の線から
    const cardOf = (id: ID): number | null => {
      const j = topo.idx.get(id);
      if (j === undefined || c.fam[j] !== f || c.isBase[j]) return null;
      for (let x = c.incOff[j]!; x < c.incOff[j + 1]!; x++) {
        const s = c.incSlot[x]!;
        const d = c.src[s]!;
        if (c.kind[d] !== DECISION) continue;
        const vd = valueAt(d);
        if (vd === null) continue;
        const qs = this.Q(main, s);
        if (qs !== null) return qs - vd;
      }
      return null;
    };
    const card = new LazyMap<number>(cardOf, () => {
      const ids: ID[] = [];
      for (let j = 0; j < c.ids.length; j++) if (c.fam[j] === f && !c.isBase[j]) ids.push(c.ids[j]!);
      return ids;
    });
    const r0 = topo.roots[0];
    let k: { v: number | null } | null = null;
    // 今日の値の差（やる価値の順位）だけが全部を数える（入口の先 = 地図の全部）
    const res: NeverResult = {
      get k(): number | null {
        if (!k) {
          const v = r0 !== undefined && main.def[r0] ? valueAt(r0) : null;
          k = { v: v !== null ? sumV(main.V, r0!) - v : null };
        }
        return k.v;
      },
      card,
    };
    this.neverMemo.set(f, res);
    return res;
  }

  families(): string[] {
    const info = this.info;
    if (!info.families) {
      const { c } = this.r;
      const set = new Set<string>();
      for (const id of this.altIds()) {
        const j = c.idx.get(id)!;
        if (c.isBase[j]) continue;
        if (c.fam[j]) set.add(c.fam[j]!);
      }
      info.families = [...set];
    }
    return info.families;
  }

  recommended(): number | null {
    if (this.rec) return this.rec.v;
    const { c, topo, nums, S, tail, H } = this.r;
    // 選んだ手（進行中・完了）を外す（見送りはそのまま）・方針で絞らない: 1 回の逆にたどる計算（perf-5）。
    // 形は assemble で作る（同じ形の物だけを計算に渡すと、計算の速さが落ちない）
    const stat = new Uint8Array(c.stat.length);
    for (let i = 0; i < stat.length; i++) stat[i] = c.stat[i] === 2 ? 2 : 0;
    const p = backward(assemble(topo, nums, stat, new Uint8Array(c.allowed.length).fill(1)), S, tail, H, 0, null);
    const r0 = topo.roots[0];
    this.rec = { v: r0 !== undefined && p.def[r0] ? sumV(p.V, r0) : null };
    return this.rec.v;
  }

  altIds(): readonly ID[] {
    const info = this.info;
    if (!info.altIds) {
      const { c } = this.r;
      const { owner } = info;
      const out: ID[] = [];
      for (let s = 0; s < c.tgt.length; s++) {
        const j = c.tgt[s]!;
        if (j >= 0 && owner[j] === s) out.push(c.ids[j]!);
      }
      info.altIds = out;
    }
    return info.altIds;
  }

  deltaOf(id: ID): number | null {
    const j = this.r.topo.idx.get(id);
    if (j === undefined) return null;
    const x = this.deltaArray()[j]!;
    return Number.isNaN(x) ? null : x;
  }

  markOf(id: ID): AltInfo["mark"] {
    const j = this.r.topo.idx.get(id);
    if (j === undefined) return null;
    const s = this.info.owner[j]!;
    return s < 0 ? null : this.markAt(s);
  }

  isBaseOf(id: ID): boolean {
    const j = this.r.topo.idx.get(id);
    return j !== undefined && this.info.owner[j]! >= 0 && this.r.c.isBase[j] === 1;
  }

  decisionIds(): readonly ID[] {
    const ids = this.r.c.ids;
    return this.info.decisions.map((d) => ids[d]!);
  }

  stakesOf(id: ID): number | null {
    const { c, topo } = this.r;
    const d = topo.idx.get(id);
    if (d === undefined || c.kind[d] !== DECISION) return null;
    return this.stakesAt(d);
  }

  bestOf(id: ID): ID | null {
    const { c, main, topo } = this.r;
    const d = topo.idx.get(id);
    if (d === undefined || c.kind[d] !== DECISION) return null;
    const s = main.best[d]!;
    return s >= 0 ? c.ids[c.tgt[s]!]! : null;
  }

  ripple(id: ID): ImpactRipple | null {
    const i = this.r.topo.idx.get(id);
    if (i === undefined) return null;
    const x = rippleCounts(this.r.topo, this.r.nums);
    return { decisions: x[i * 4]!, splits: x[i * 4 + 1]!, ends: x[i * 4 + 2]!, sumEnds: x[i * 4 + 3]! };
  }

  /** この結果の計算の鍵（同じ鍵なら同じ数） */
  get runKey(): string {
    return this.r.key;
  }
}

/** 地図の登録（組み立てたままの文書なら、その地図の列から形を作る） */
export interface MapDoc {
  map: MapData;
  doc: DocData;
  cm?: CompiledMap;
}

/**
 * 3 年の影響の計算のエンジン。文書の変更は note で受け（印を付けるだけ）、result で要る所だけやり直して結果を返す。
 * 同じ版の間は同じ結果の物を返す（画面の部品は結果の物が変わったときだけ作り直す）
 */
export class ImpactEngine {
  private topo: Topo | null = null;
  private seen: Seen | null = null;
  private nums: Nums | null = null;
  private stat: Uint8Array | null = null;
  private allowed: Uint8Array | null = null;
  private shown: Uint8Array | null = null;
  private allowedSid: ID | null = null;
  private dirty = C_TOPO;
  private readonly statusIdx = new Set<number>();
  readonly version: Versions = { topology: 0, numbers: 0, statuses: 0, scenario: 0, present: 0 };
  private run: Run | null = null;
  private res: ImpactResult = emptyImpact();
  private resKey = "";
  /** 組み立てたままの版 7 の地図（形と数を変えるまで、形をその列から作る） */
  private pristine: MapDoc | null = null;
  private readonly flipTasks = new Map<string, FlipsTask>();
  private accCache: { key: string; A: Float64Array; Adef: Uint8Array } | null = null;
  /** 数だけを取り出す計算（やらない場合）の入れ物。ノードの数の大きさで 1 つだけ（使うときに作る: 見直し perf-2） */
  private scratchPass: Pass | null = null;
  private readonly scratch = (): Pass => {
    const n = this.topo?.n ?? 0;
    if (!this.scratchPass || this.scratchPass.def.length !== n) this.scratchPass = newPass(n);
    return this.scratchPass;
  };
  /** 形を作った道（確かめ用）: "map" 同梱の地図の列から / "doc" 文書から */
  lastCompile: "map" | "doc" | null = null;
  /** 形・数・計算にかかった時間（確かめ用。ms） */
  readonly timings = { compile: 0, numbers: 0, passes: 0 };

  /** 組み立てたままの版 7 の地図と文書を知らせる（次に形を作るとき、その地図の列から作る）。null で忘れる */
  useMap(x: MapDoc | null): void {
    this.pristine = x;
    if (x) this.dirty |= C_TOPO;
  }

  /**
   * 全部の入れ替えで、物だけ新しく中身が同じノード・線（DocIndex.diffDoc の sameNodes・sameEdges）: 覚えた物を新しい物に替えるだけ
   * （比べ直さない。前の文書の物を持ち続けない: 見直し perf-4）。作り直しを待っているときは何もしない（作り直すときに全部読む）
   */
  rebindObjects(nodes: readonly GNode[], edges: readonly GEdge[]): void {
    const topo = this.topo;
    const seen = this.seen;
    if (!topo || !seen || this.dirty & C_TOPO) return;
    for (const n of nodes) {
      const i = topo.idx.get(n.id);
      if (i !== undefined && seen.nodeObj[i] !== undefined) seen.nodeObj[i] = n;
    }
    for (const e of edges) {
      const s = slotOfEdge(topo, e);
      if (s >= 0 && seen.edgeObj[s] !== undefined) seen.edgeObj[s] = e;
    }
  }

  /**
   * 全部の入れ替えを変わった物だけの変更として受けた後（note に渡し終えた後）: 形と数が同梱の地図のままなら、新しい文書を
   * その地図を組み立てた文書として覚え直し、その地図を返す（地図の列から作った形をそのまま使い続ける: 見直し perf-4）。そうでなければ null
   */
  rebindDoc(doc: DocData): MapData | null {
    const p = this.pristine;
    if (!p || p.doc === doc || this.dirty & (C_TOPO | C_NUMS) || this.lastCompile !== "map") return p && p.doc === doc ? p.map : null;
    this.pristine = { ...p, doc };
    return p.map;
  }

  /** 全部を作り直す */
  invalidate(): void {
    this.dirty |= C_TOPO;
    this.pristine = null;
  }

  /** 文書の変更を受ける（印を付けるだけ。O(変わった物)） */
  note(doc: DocData, info: { full: boolean; nodes: ReadonlySet<ID>; edges: ReadonlySet<ID>; projects: ReadonlySet<ID>; scenarios: ReadonlySet<ID> }): void {
    if (info.full) {
      this.dirty |= C_TOPO;
      if (!this.pristine || this.pristine.doc !== doc) this.pristine = null;
      return;
    }
    const topo = this.topo;
    const seen = this.seen;
    if (info.projects.size) this.dirty |= C_PRESENT;
    if (info.scenarios.size) this.dirty |= C_SCEN;
    if (!topo || !seen || this.dirty & C_TOPO) {
      // まだ形が無い: 入口ができたときだけ作り直す（形があって作り直す前なら、作り直すときに全部読む）
      if (!(this.dirty & C_TOPO)) for (const id of info.nodes) if (isImpactRoot(doc.nodes[id])) this.dirty |= C_TOPO;
      if (info.nodes.size || info.edges.size) this.pristine = null;
      return;
    }
    let c = 0;
    const r0 = topo.roots[0];
    for (const id of info.nodes) {
      const now = doc.nodes[id];
      const i = topo.idx.get(id);
      if (i === undefined) {
        if (topo.loose.has(id) || (now && isImpactRoot(now))) c |= C_TOPO;
        continue;
      }
      const old = seen.nodeObj[i];
      if (!now) {
        c |= C_TOPO;
        continue;
      }
      if (old === now) continue;
      seen.nodeObj[i] = now;
      const x = old ? nodeChange(old, now, i === r0) : C_TOPO;
      if (x & C_STATUS) this.statusIdx.add(i);
      c |= x;
    }
    const eidx = info.edges.size ? edgeIndex(topo) : null;
    for (const id of info.edges) {
      const now = doc.edges[id];
      const s = eidx!.get(id);
      if (s === undefined) {
        if (now) {
          if (isFlowEdge(now) && now.source !== now.target && (topo.idx.has(now.source) || topo.loose.has(now.source)) && doc.nodes[now.target]) c |= C_TOPO;
        } else if (topo.loose.size) c |= C_TOPO;
        continue;
      }
      const old = seen.edgeObj[s];
      if (!now) {
        c |= C_TOPO;
        continue;
      }
      if (old === now) continue;
      seen.edgeObj[s] = now;
      c |= old ? edgeChange(old, now) : C_TOPO;
    }
    if (c & (C_TOPO | C_NUMS)) this.pristine = null;
    this.dirty |= c;
  }

  /** 今の結果（版が同じなら前と同じ物） */
  result(inp: EngineInputs): ImpactResult {
    if (this.dirty & C_TOPO) this.rebuild(inp);
    const topo = this.topo;
    const seen = this.seen;
    if (!topo || !seen) {
      this.dirty = 0;
      if (this.resKey !== "empty") {
        this.res = emptyImpact();
        this.resKey = "empty";
      }
      return this.res;
    }
    if (this.dirty & C_NUMS || !this.nums) {
      const t0 = performance.now();
      this.nums = fillNums(topo, seen);
      this.version.numbers++;
      this.timings.numbers = performance.now() - t0;
      this.dirty |= C_SCEN;
    }
    const nums = this.nums;
    if (!this.stat) {
      this.stat = fillStatus(topo, seen);
      this.version.statuses++;
      this.statusIdx.clear();
    } else if (this.statusIdx.size) {
      const next = this.stat.slice();
      for (const i of this.statusIdx) next[i] = statusCode(seen.nodeObj[i]);
      this.statusIdx.clear();
      this.stat = next;
      this.version.statuses++;
    }
    const sid = inp.sid;
    if (this.dirty & C_SCEN || !this.allowed || sid !== this.allowedSid) {
      // q のある地図（版 7）: 数は方針で絞らず、方針は印だけ（computeImpact と同じ。作業メモ SPEC §5.11・gaps-12）
      const free = nums.likeBasis && sid !== null;
      this.allowed = fillAllowed(topo, nums, seen, free ? null : sid);
      this.shown = free ? fillAllowed(topo, nums, seen, sid) : null;
      this.allowedSid = sid;
      this.version.scenario++;
    }
    if (this.dirty & C_PRESENT) this.version.present++;
    this.dirty = 0;
    const cfg = rootConfig(topo, seen);
    const annualSet = validAnnual(cfg.annual);
    const annual = annualSet ? cfg.annual! : IMPACT_DEFAULT_ANNUAL;
    const tail = cfg.tail ?? 0;
    const reach = topo.merges ? inp.reach() : null;
    const v = this.version;
    const runKey = `${v.topology}|${v.numbers}|${v.statuses}|${v.scenario}|${annual}|${tail}|${reach ? reach.version : ""}`;
    // 年収が仮か（同じ 360 でも、入れたか仮かで結果の物を分ける。計算は同じ物を使う: 見直し equiv-2）
    const key = `${runKey}|${v.present}|${annualSet ? 1 : 0}`;
    if (key === this.resKey) return this.res;
    if (!this.run || this.run.key !== runKey) {
      const t0 = performance.now();
      this.run = this.compute(topo, nums, this.stat, this.allowed, this.shown, { annual, tail, sid, reach, key: runKey });
      this.timings.passes = performance.now() - t0;
    }
    this.res = new EngineResult(this.run, (r) => this.flipsTask(r), annualSet, this.scratch);
    this.resKey = key;
    return this.res;
  }

  /** 形を作り直す（組み立てたままの版 7 の地図なら、その地図の列から） */
  private rebuild(inp: EngineInputs): void {
    const t0 = performance.now();
    this.run = null;
    this.stat = null;
    this.allowed = null;
    this.shown = null;
    this.nums = null;
    this.statusIdx.clear();
    this.flipTasks.clear();
    const p = this.pristine;
    let made = false;
    if (p && p.doc === inp.doc) {
      const x = compileMapDoc(p.map, p.doc, p.cm);
      if (x) {
        this.topo = x.topo;
        this.seen = x.seen;
        this.nums = x.nums;
        this.version.numbers++;
        if (!p.cm) p.cm = x.topo.cm ?? undefined;
        this.lastCompile = "map";
        made = true;
      } else this.pristine = null;
    }
    if (!made) {
      const x = compileDocTopo(inp.doc, inp.out(), inp.roots?.());
      this.topo = x?.topo ?? null;
      this.seen = x?.seen ?? null;
      this.lastCompile = x ? "doc" : null;
    }
    this.version.topology++;
    this.dirty = (this.dirty & ~C_TOPO) | C_NUMS | C_SCEN;
    if (made) this.dirty &= ~C_NUMS;
    this.timings.compile = performance.now() - t0;
  }

  /** 計算（逆にたどる・前へ流す・そこまでの稼ぎ） */
  private compute(topo: Topo, nums: Nums, stat: Uint8Array, allowed: Uint8Array, shown: Uint8Array | null, o: { annual: number; tail: number; sid: ID | null; reach: { version: number; of: (id: ID) => number } | null; key: string }): Run {
    const c = assemble(topo, nums, stat, allowed);
    const S = o.annual / 12;
    const H = nums.H;
    const main = backward(c, S, o.tail, H, 0, null);
    const P = forward(c, main);
    const sq = backward(c, S, o.tail, H, 1, null);
    const Psq = forward(c, sq);
    const { A, Adef } = this.accOf(topo, nums, S, o.reach);
    const flipsKey = `${this.version.topology}|${this.version.numbers}|${this.version.statuses}|${this.version.scenario}|${o.annual}|${o.tail}`;
    return { key: o.key, topo, nums, c, annual: o.annual, S, tail: o.tail, H, sid: o.sid, shown, main, P, sq, Psq, A, Adef, flipsKey };
  }

  /**
   * 今日からそこまでの稼ぎ（合流では、そこへ来る見込みで重みを付けた平均。computeImpact と同じ）。
   * 状態・方針には依らないので、形・数・年収（と合流のある地図の見込み）が同じなら前の物を使う（これにするたびに数えない）
   */
  private accOf(topo: Topo, nums: Nums, S: number, reach: { version: number; of: (id: ID) => number } | null): { A: Float64Array; Adef: Uint8Array } {
    const key = `${this.version.topology}|${this.version.numbers}|${S}|${reach ? reach.version : ""}`;
    if (this.accCache && this.accCache.key === key) return this.accCache;
    const n = topo.n;
    const A = new Float64Array(n);
    const Adef = new Uint8Array(n);
    const isRoot = new Uint8Array(n);
    for (const r of topo.roots) (Adef[r] = 1), (isRoot[r] = 1);
    const er = nums.er;
    for (let i = 0; i < n; i++) {
      if (isRoot[i]) continue;
      let sw = 0;
      let sv = 0;
      let cnt = 0;
      let plain = 0;
      for (let k = topo.incOff[i]!; k < topo.incOff[i + 1]!; k++) {
        const s = topo.incSlot[k]!;
        const u = topo.src[s]!;
        if (!Adef[u]) continue;
        const pu = reach ? reach.of(topo.ids[u]!) : 0;
        const sw1 = (nums.kind[u] === CHANCE ? nums.w[s]! : 1) * pu;
        const val = A[u]! + (S * er[s * 3]! + er[s * 3 + 1]! + er[s * 3 + 2]!);
        sw += sw1;
        sv += sw1 * val;
        plain += val;
        cnt++;
      }
      if (!cnt) continue;
      A[i] = sw > 0 ? sv / sw : plain / cnt;
      Adef[i] = 1;
    }
    this.accCache = { key, A, Adef };
    return this.accCache;
  }

  /** 年収の境目の計算（年収・方針・形・数・状態が同じなら、前の結果の続きから・前の答えを使う） */
  private flipsTask(r: Run): FlipsTask {
    let t = this.flipTasks.get(r.flipsKey);
    if (!t) {
      if (this.flipTasks.size > 8) this.flipTasks.clear();
      this.flipTasks.set(r.flipsKey, (t = { key: r.flipsKey, done: null, steps: null }));
    }
    return t;
  }

  /**
   * 同梱の地図の列から作った今の形（組み立てたままの文書で、形を変えていない間だけ。それ以外は null）。
   * 見え方の計算が、3 年の分かれ道の範囲と先の数を、文書をたどらずにこの形から作る（作業メモ perf-3）
   */
  mapTopo(doc: DocData): Topo | null {
    const t = this.topo;
    return this.pristine && this.pristine.doc === doc && !(this.dirty & C_TOPO) && t && t.map && t.cm ? t : null;
  }

  /**
   * 同梱の地図の列から作った形のときの、地図の番号ごとの選んだ・見送った（0 まだ・1 選んだ・2 見送った。番号は地図と同じ）。
   * それ以外は null（見取り図・道の画面は文書から読む: src/app/deepState.ts）。result を呼んだ後に読む（前の変更が入っている）
   */
  mapStatus(doc: DocData): Uint8Array | null {
    return this.mapTopo(doc) && this.stat ? this.stat : null;
  }

  /** 今の形（確かめ用） */
  get graph(): { topo: Topo | null; nums: Nums | null } {
    return { topo: this.topo, nums: this.nums };
  }
}

