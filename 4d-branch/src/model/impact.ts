// 3 年の影響の計算（未来の道筋 v2「3 年の分かれ道」）。設計: docs/DESIGN.md §4.7
//
// 入口（今日）から horizon（36）か月目までの稼ぎ（税引き前・万円）を、判断（自分で選ぶ）と結果（運で決まる）の木で逆にたどって求める。
//   線の稼ぎ W: 線の meta.r = [給与の月数, 広告運用・独立の万円, SpellDash の万円]。給与の月数には月給 S（年収 / 12）を掛ける。
//              meta.r が無ければ「何も変わらない」として、元のノードの月の稼ぎ（meta.rr）× 経った月数。
//   行き先 V : 月の稼ぎ（meta.rr）×（horizon までの残りの月 + その後に足す月）。生成した行き先は 36 か月目なので 0
//   結果     : 見込み（%）で重みを付けた平均
//   判断     : 選んだ手（進行中・完了）があればその中で、無ければ見送った手を除いて一番良い手を選ぶ（π）
// 各選択肢の「3 年の影響」Δ = その手の値 − 同じ判断の「今のまま」（meta.base）の値。どちらもその後は一番良い選び方をする。
// 計算は O(ノード + 線)。1,800 ノードで数 ms。
//
// アプリが使うのは型付き配列の計算（./impactEngine.ts。文書の変わった所に応じて組み直し・入れ直し・計算し直しを分ける）。
// ここの computeImpact は、その答えの決まり（基準の作り）で、同じ答えになるかのテスト（tests/unit/impactEngine*.test.ts）と生成の点検だけが使う。
// 逆にたどる・前へ流す計算（backward・forward）と組み直した形（Compiled）は、エンジンもそのまま使う（足す順まで同じ数になる）。
// ★ の決まり（作業メモ SPEC v1 §5.6・見直し user-10・truth-2）: 手に q（比べ方をそろえた見積もり）がある地図（版 7）では、
//   一番の手（木の値）が、ほかの手より q の見積もりで max(10 万円, 判断の幅の 3 割) 以上良いときだけ ★。そうでなければ、その幅の内の手が ≒。
//   どの判断でも一番の手に控えめな「おすすめ」の印（AltInfo.rec）。q の無い地図（版 6）は前のまま（2 位より 10 万円以上で ★・おすすめの印なし）

import type { ForecastResult } from "./forecast";
import { chanceWeights, flowOuts, forkKindOf, impactConfigOf, impactScope, isImpactRoot, primaryImpactRoot, type ForkKind } from "./forks";
import { impactBin } from "./impactFormat";
import { dayNumber, isDateStr } from "./dates";
import type { DocData, GNode, ID } from "./types";

export type Vec3 = [number, number, number];

/** 年収（額面・万円）が入っていないときに仮に使う値 */
export const IMPACT_DEFAULT_ANNUAL = 360;
/** 年収として受け付ける範囲（万円） */
export const IMPACT_ANNUAL_MIN = 100;
export const IMPACT_ANNUAL_MAX = 3000;
/** ★（おすすめ）を付ける差（2 位より何万円良ければ）。差がこれより小さい手は「≒ ほぼ同じ」（数はモデルの目安なので、小さな差で 1 つに決めない） */
export const IMPACT_STAR_LEAD = 10;
/** q のある地図の ★: 判断の幅（比べ方をそろえた値の一番上と一番下の差）のこの割合以上（かつ IMPACT_STAR_LEAD 以上）良ければ ★ */
export const IMPACT_STAR_SHARE = 0.3;
/** 「悪くなる」と数える差（万円）。色の「ほぼ同じ」（3 万円未満）より悪い結果だけを数える */
export const BAD_EPS = 3;

export interface AltOutcome {
  edge: ID;
  node: ID;
  /** その結果になる見込み（この手を選んだ場合・0〜1） */
  w: number;
  /** この結果なら今のままよりどれだけ変わるか（万円） */
  u: number | null;
  bin: number;
}

export interface AltInfo {
  /** この手を選ぶ判断 */
  decision: ID;
  /** 判断からこの手への線 */
  edge: ID;
  isBase: boolean;
  /** 選んだ方針（シナリオ）に入るか */
  allowed: boolean;
  picked: boolean;
  dropped: boolean;
  /** 3 年の影響（万円）。基準が無い・数が出せないときは null */
  delta: number | null;
  /** 影響の内訳 [本業, 広告運用・独立, SpellDash] */
  deltaV: Vec3 | null;
  /** 3 年後の月の稼ぎの差（万円/月） */
  dR: number | null;
  /** 今のままより悪くなる見込み（0〜1） */
  pBad: number | null;
  /** 悪い場合の差（いちばん悪い結果） */
  worst: number | null;
  bin: number;
  /** ★ おすすめ・≒ ほぼ同じ */
  mark: "star" | "tie" | null;
  /** その判断の一番良い手（控えめな「おすすめ」の印。q のある地図だけ。候補が 2 つ以上の判断） */
  rec: boolean;
  /** 先に数の出ない所がある */
  partial: boolean;
  outcomes: AltOutcome[];
}

export interface DecisionInfo {
  /** 選択肢（表示の順） */
  alts: ID[];
  base: ID | null;
  /** 一番良い手（自分で選んだ手は考えない） */
  best: ID | null;
  /** 計算で選ぶ手（自分で選んだ手があればその中で一番良い手） */
  chosen: ID | null;
  /** この判断で最大どれだけ差が出るか（一番良い手 − 今のまま） */
  stakes: number | null;
  spread: [number, number] | null;
}

export interface ImpactEnd {
  id: ID;
  /** おすすめ（または自分）の選び方でここに来る見込み */
  p: number;
  /** 今日から 3 年の稼ぎの合計 */
  tot: number;
}

export interface ImpactDist {
  mean: number;
  p10: number;
  p50: number;
  p90: number;
  /** ずっと今のままより悪くなる見込み */
  pWorse: number;
  /** 段（−4〜+4）ごとの見込み（9 個） */
  bins: number[];
  sqBins: number[];
}

export interface SalaryFlip {
  annual: number;
  alt: ID;
}

export interface NeverResult {
  /** その手を 3 年間ずっとやらない場合と比べた今日の値の差 */
  k: number | null;
  /** 手ごとの「ずっとやらない」場合との差 */
  card: ReadonlyMap<ID, number>;
}

/** 年収で今日の一番が入れ替わる所 */
export interface SalaryFlips {
  below: SalaryFlip | null;
  above: SalaryFlip | null;
}

/** そのカードの先（自分を含む）の数（形と分かれ道の種類だけで決まる。作業メモ perf-14・user-13・truth-18） */
export interface ImpactRipple {
  /** 判断（手が 2 つ以上） */
  decisions: number;
  /** 出来事の分かれ（結果が 2 つ以上の手） */
  splits: number;
  /** 行き先（先の無いカード） */
  ends: number;
  /** そのうち、まとめた行き先（標準の続きの見積もり） */
  sumEnds: number;
}

export interface ImpactResult {
  active: boolean;
  root: ID | null;
  /** 範囲（入口からたどれるノード。循環に入って数えないノードも含む） */
  scope: ReadonlySet<ID>;
  annual: number;
  /** 年収が入っている（false なら仮の値） */
  annualSet: boolean;
  S: number;
  tail: number;
  horizon: number;
  kind: ReadonlyMap<ID, ForkKind>;
  month: ReadonlyMap<ID, number>;
  /** その時点から horizon までの稼ぎ（その後は一番良い選び方） */
  value: ReadonlyMap<ID, number>;
  valueV: ReadonlyMap<ID, Vec3>;
  /** horizon での月の稼ぎ（万円/月） */
  rate: ReadonlyMap<ID, number>;
  /** 今日からそこまでの稼ぎ */
  acc: ReadonlyMap<ID, number>;
  /** おすすめ（または自分）の選び方でそこに来る見込み */
  pPi: ReadonlyMap<ID, number>;
  partial: ReadonlySet<ID>;
  alt: ReadonlyMap<ID, AltInfo>;
  decision: ReadonlyMap<ID, DecisionInfo>;
  outcome: ReadonlyMap<ID, AltOutcome & { alt: ID }>;
  /** 選び方の道の上の線 */
  piEdges: ReadonlySet<ID>;
  /** 線が選び方の道の上か（piEdges.has(e.id) と同じ。線の物から引くので、描くたびに線の ID の表を作らない） */
  onPiEdge(e: { id: ID; target: ID }): boolean;
  vRoot: number | null;
  vSQ: number | null;
  rRoot: number | null;
  rSQ: number | null;
  ends: ImpactEnd[];
  dist: ImpactDist | null;
  counts: { nodes: number; decisions: number; options: number; forks: number; ends: number };
  /** 自分で選んだ手がある */
  hasPicks: boolean;
  /** 手に q（比べ方をそろえた見積もり）がある地図（★ の決まりとおすすめの印がそれに従う） */
  likeBasis: boolean;
  /** 年収を変えると今日の一番が入れ替わる所（遅延計算） */
  salaryFlips(): SalaryFlips;
  /** salaryFlips がもう出ていればその答え、まだなら null（計算しない） */
  salaryFlipsReady(): SalaryFlips | null;
  /** salaryFlips の計算を、逆にたどる計算 1 回分だけ進める。済んだら答え、まだなら null（画面を描いた後に少しずつ進める: 作業メモ perf-8） */
  salaryFlipsStep(): SalaryFlips | null;
  /** その種類の手を 3 年間ずっとやらない場合（遅延計算） */
  never(fam: string): NeverResult;
  /** 手の種類（基準を除く） */
  families(): string[];
  /** おすすめの選び方（自分で選んだ手を外し、見送りはそのまま、方針で絞らない）での今日の値（遅延計算） */
  recommended(): number | null;
  /** 選択肢の ID（alt の鍵と同じ物）。AltInfo を作らずに順位を作るため */
  altIds(): readonly ID[];
  /** alt.get(id)?.delta と同じ（AltInfo を作らない） */
  deltaOf(id: ID): number | null;
  /** alt.get(id)?.mark と同じ（AltInfo を作らない） */
  markOf(id: ID): AltInfo["mark"];
  /** alt.get(id)?.isBase と同じ */
  isBaseOf(id: ID): boolean;
  /** 判断の ID（decision の鍵と同じ物） */
  decisionIds(): readonly ID[];
  /** decision.get(id)?.stakes と同じ（DecisionInfo を作らない） */
  stakesOf(id: ID): number | null;
  /** decision.get(id)?.best と同じ */
  bestOf(id: ID): ID | null;
  /** そのカードの先の判断・出来事の分かれ・行き先の数（範囲の外は null） */
  ripple(id: ID): ImpactRipple | null;
}

export const LEAF = 0;
export const PASS = 1;
export const CHANCE = 2;
export const DECISION = 3;
export const KIND_NAMES: readonly ForkKind[] = ["leaf", "pass", "chance", "decision"];

/**
 * 組み直した形（型付き配列）。ノードは並べる順（親は子より前）、線は元のノードごとの続いた番号（off）。
 * ここの compile と、エンジンの 2 つの作り方（./impactGraph.ts）が同じ物を作る
 */
export interface Compiled {
  ids: ID[];
  idx: Map<ID, number>;
  kind: Uint8Array;
  t: Float64Array;
  rr: Float64Array;
  off: Int32Array;
  tgt: Int32Array;
  eid: ID[];
  w: Float64Array;
  er: Float64Array;
  allowed: Uint8Array;
  base: Int32Array;
  stat: Uint8Array;
  rank: Float64Array;
  isBase: Uint8Array;
  /** 数の材料が無い手（自分で足した、先も月の稼ぎも無い行き止まり）。選んだときだけ数える */
  noData: Uint8Array;
  fam: string[];
  roots: number[];
  /** 確かめるだけの事実を知る結果の線: 事実の名前と答え（meta.rv）。無ければ null */
  rvKey: Array<string | null>;
  rvCat: Array<string | null>;
  /** 入ってくる線（slot の番号） */
  incOff: Int32Array;
  incSlot: Int32Array;
  src: Int32Array;
  /** 手の q（比べ方をそろえた見積もり。[給与の月数, 広告運用 万円, SpellDash 万円] を 3 つずつ。無ければ NaN） */
  q: Float64Array;
  /** q のある手がある（★ の決まり・おすすめの印） */
  likeBasis: boolean;
}

export interface Pass {
  V: Float64Array;
  def: Uint8Array;
  R: Float64Array;
  RV: Float64Array;
  partial: Uint8Array;
  pi: Int32Array;
  best: Int32Array;
}

/** 範囲が無いときの結果（active = false） */
export const emptyImpact = (): ImpactResult => emptyResult();

const NO_FLIPS: SalaryFlips = Object.freeze({ below: null, above: null });

const emptyResult = (): ImpactResult => ({
  active: false,
  root: null,
  scope: new Set(),
  annual: IMPACT_DEFAULT_ANNUAL,
  annualSet: false,
  S: IMPACT_DEFAULT_ANNUAL / 12,
  tail: 0,
  horizon: 36,
  kind: new Map(),
  month: new Map(),
  value: new Map(),
  valueV: new Map(),
  rate: new Map(),
  acc: new Map(),
  pPi: new Map(),
  partial: new Set(),
  alt: new Map(),
  decision: new Map(),
  outcome: new Map(),
  piEdges: new Set(),
  vRoot: null,
  vSQ: null,
  rRoot: null,
  rSQ: null,
  ends: [],
  dist: null,
  counts: { nodes: 0, decisions: 0, options: 0, forks: 0, ends: 0 },
  hasPicks: false,
  likeBasis: false,
  onPiEdge: () => false,
  salaryFlips: () => ({ below: null, above: null }),
  salaryFlipsReady: () => NO_FLIPS,
  salaryFlipsStep: () => NO_FLIPS,
  never: () => ({ k: null, card: new Map() }),
  families: () => [],
  recommended: () => null,
  altIds: () => [],
  deltaOf: () => null,
  markOf: () => null,
  isBaseOf: () => false,
  decisionIds: () => [],
  stakesOf: () => null,
  bestOf: () => null,
  ripple: () => null,
});

/** 3 つの数の配列（文字の数も Number で読む。読めなければ null。computeImpact の読み方） */
export function vec3(v: unknown): Vec3 | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const a = v.map(Number);
  return a.every((x) => Number.isFinite(x)) ? [a[0]!, a[1]!, a[2]!] : null;
}

/** 年収の値として使えるか */
export function validAnnual(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= IMPACT_ANNUAL_MIN && x <= IMPACT_ANNUAL_MAX;
}

export function compile(doc: DocData, out: Map<ID, ID[]>, scope: ReadonlySet<ID>, scenarioId: ID | null, H: number, rootIds: ID[]): Compiled {
  // 並べる順（入口から。入口へ戻る線は数えない。循環に入ったノードは外す）
  const rootSet = new Set(rootIds);
  const outsAll = new Map<ID, ReturnType<typeof flowOuts>>();
  const indeg = new Map<ID, number>();
  for (const id of scope) indeg.set(id, 0);
  for (const id of scope) {
    const list = flowOuts(doc, out, id).filter((e) => scope.has(e.target));
    outsAll.set(id, list);
    for (const e of list) if (!rootSet.has(e.target)) indeg.set(e.target, indeg.get(e.target)! + 1);
  }
  const ids: ID[] = [];
  const queue: ID[] = rootIds.filter((r) => scope.has(r));
  for (const id of scope) if (!rootSet.has(id) && indeg.get(id) === 0) queue.push(id);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    ids.push(id);
    for (const e of outsAll.get(id)!) {
      if (rootSet.has(e.target)) continue;
      const left = indeg.get(e.target)! - 1;
      indeg.set(e.target, left);
      if (left === 0) queue.push(e.target);
    }
  }
  const n = ids.length;
  const idx = new Map<ID, number>();
  ids.forEach((id, i) => idx.set(id, i));
  const kind = new Uint8Array(n);
  const t = new Float64Array(n);
  const rr = new Float64Array(n * 3);
  const base = new Int32Array(n).fill(-1);
  const stat = new Uint8Array(n);
  const rank = new Float64Array(n);
  const isBase = new Uint8Array(n);
  const noData = new Uint8Array(n);
  const fam: string[] = new Array<string>(n);
  const q = new Float64Array(n * 3).fill(NaN);
  let likeBasis = false;
  const off = new Int32Array(n + 1);
  let slots = 0;
  for (let i = 0; i < n; i++) {
    off[i] = slots;
    slots += outsAll.get(ids[i]!)!.length;
  }
  off[n] = slots;
  const tgt = new Int32Array(slots);
  const eid: ID[] = new Array<ID>(slots);
  const w = new Float64Array(slots);
  const er = new Float64Array(slots * 3);
  const allowed = new Uint8Array(slots);
  const src = new Int32Array(slots);
  const rvKey: Array<string | null> = new Array<string | null>(slots).fill(null);
  const rvCat: Array<string | null> = new Array<string | null>(slots).fill(null);
  const firstParent = new Int32Array(n).fill(-1);
  // 親の月のいちばん遅い所（子の月はこれより前にしない。日付を逆に入れても、同じ月を 2 度数えない）
  const tFloor = new Float64Array(n);

  const rootNode = doc.nodes[rootIds[0]!];
  const rootDay = rootNode && isDateStr(rootNode.time.due) ? dayNumber(rootNode.time.due) : null;
  const rootRR = vec3(rootNode?.meta?.rr) ?? ([1, 0, 0] as Vec3);

  // ノードの性質（先に親の月・稼ぎが要るので、並べた順に決める）
  for (let i = 0; i < n; i++) {
    const node = doc.nodes[ids[i]!]!;
    const list = outsAll.get(ids[i]!)!;
    kind[i] = KIND_NAMES.indexOf(forkKindOf(node, list));
    stat[i] = node.status === "active" || node.status === "done" ? 1 : node.status === "dropped" ? 2 : 0;
    rank[i] = typeof node.meta?.rank === "number" && Number.isFinite(node.meta.rank) ? (node.meta.rank as number) : 1e9 + i;
    isBase[i] = node.meta?.base === true ? 1 : 0;
    noData[i] = list.length === 0 && vec3(node.meta?.rr) === null && typeof node.meta?.ak !== "string" && node.meta?.end !== true && !node.meta?.forecastRoot ? 1 : 0;
    fam[i] = typeof node.meta?.fam === "string" ? (node.meta.fam as string) : typeof node.meta?.ak === "string" ? (node.meta.ak as string) : "";
    const qv = vec3(node.meta?.q);
    if (qv) {
      q[i * 3] = qv[0];
      q[i * 3 + 1] = qv[1];
      q[i * 3 + 2] = qv[2];
      likeBasis = true;
    }
    const fp = firstParent[i]!;
    const m = node.meta?.m;
    let ti: number;
    if (typeof m === "number" && Number.isFinite(m)) ti = m;
    else if (rootDay !== null && isDateStr(node.time.due)) ti = (dayNumber(node.time.due) - rootDay) / 30.44;
    else ti = fp >= 0 ? t[fp]! : 0;
    t[i] = Math.min(H, Math.max(0, tFloor[i]!, ti));
    const r = vec3(node.meta?.rr) ?? (fp >= 0 ? ([rr[fp * 3]!, rr[fp * 3 + 1]!, rr[fp * 3 + 2]!] as Vec3) : rootRR);
    rr[i * 3] = r[0];
    rr[i * 3 + 1] = r[1];
    rr[i * 3 + 2] = r[2];
    const ws = kind[i] === CHANCE ? chanceWeights(list) : list.map(() => 1);
    list.forEach((e, j) => {
      const s = off[i]! + j;
      const ti2 = idx.get(e.target);
      tgt[s] = ti2 ?? -1;
      eid[s] = e.id;
      w[s] = ws[j]!;
      src[s] = i;
      allowed[s] = kind[i] !== DECISION || !scenarioId || e.scenarioIds.length === 0 || e.scenarioIds.includes(scenarioId) ? 1 : 0;
      const rv = e.meta?.rv;
      if (Array.isArray(rv) && typeof rv[0] === "string" && typeof rv[1] === "string") {
        rvKey[s] = rv[0];
        rvCat[s] = rv[1];
      }
      if (ti2 !== undefined && firstParent[ti2] === -1) firstParent[ti2] = i;
      if (ti2 !== undefined) tFloor[ti2] = Math.max(tFloor[ti2]!, t[i]!);
    });
  }
  // 線の稼ぎ（先のノードの月が要るので、全部の月が決まってから）
  for (let i = 0; i < n; i++) {
    for (let s = off[i]!; s < off[i + 1]!; s++) {
      const e = doc.edges[eid[s]!]!;
      const r = vec3(e.meta?.r);
      if (r) {
        er[s * 3] = r[0];
        er[s * 3 + 1] = r[1];
        er[s * 3 + 2] = r[2];
      } else {
        const j = tgt[s]!;
        const dt = j >= 0 ? Math.max(0, t[j]! - t[i]!) : 0;
        er[s * 3] = rr[i * 3]! * dt;
        er[s * 3 + 1] = rr[i * 3 + 1]! * dt;
        er[s * 3 + 2] = rr[i * 3 + 2]! * dt;
      }
    }
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
  // 入ってくる線
  const incCount = new Int32Array(n + 1);
  for (let s = 0; s < slots; s++) if (tgt[s]! >= 0) incCount[tgt[s]! + 1]!++;
  const incOff = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) incOff[i + 1] = incOff[i]! + incCount[i + 1]!;
  const fill = new Int32Array(n);
  const incSlot = new Int32Array(incOff[n]!);
  for (let s = 0; s < slots; s++) {
    const j = tgt[s]!;
    if (j < 0) continue;
    incSlot[incOff[j]! + fill[j]!] = s;
    fill[j]!++;
  }
  const roots = rootIds.map((r) => idx.get(r)).filter((x): x is number => x !== undefined);
  return { ids, idx, kind, t, rr, off, tgt, eid, w, er, allowed, base, stat, rank, isBase, noData, fam, roots, rvKey, rvCat, incOff, incSlot, src, q, likeBasis };
}

/**
 * 逆にたどる（mode 0: ふつう・1: ずっと今のまま・2: その種類の手を使わない）。
 * lo・hi を渡すと、その番号の間だけ数える（深さ優先の順の木で、あるカードの先だけを数えるとき。間の外のノードは数が出ない扱い）
 */
export function backward(c: Compiled, S: number, tail: number, H: number, mode: 0 | 1 | 2, fam: string | null, lo = 0, hi = c.ids.length): Pass {
  const n = c.ids.length;
  const V = new Float64Array(n * 3);
  const RV = new Float64Array(n * 3);
  const R = new Float64Array(n);
  const def = new Uint8Array(n);
  const partial = new Uint8Array(n);
  const pi = new Int32Array(n).fill(-1);
  const best = new Int32Array(n).fill(-1);
  const q = (s: number, j: number): number => S * c.er[s * 3]! + c.er[s * 3 + 1]! + c.er[s * 3 + 2]! + V[j * 3]! + V[j * 3 + 1]! + V[j * 3 + 2]!;
  const better = (s: number, qs: number, b: number, qb: number): boolean => {
    if (b < 0) return true;
    if (qs > qb + 1e-9) return true;
    if (qs < qb - 1e-9) return false;
    const js = c.tgt[s]!;
    const jb = c.tgt[b]!;
    if (c.isBase[js] !== c.isBase[jb]) return c.isBase[js] === 1;
    return c.rank[js]! < c.rank[jb]!;
  };
  for (let i = hi - 1; i >= lo; i--) {
    const k = c.kind[i]!;
    const a = c.off[i]!;
    const b = c.off[i + 1]!;
    if (k === LEAF || a === b) {
      const left = Math.max(0, H - c.t[i]!) + tail;
      V[i * 3] = S * c.rr[i * 3]! * left;
      V[i * 3 + 1] = c.rr[i * 3 + 1]! * left;
      V[i * 3 + 2] = c.rr[i * 3 + 2]! * left;
      RV[i * 3] = S * c.rr[i * 3]!;
      RV[i * 3 + 1] = c.rr[i * 3 + 1]!;
      RV[i * 3 + 2] = c.rr[i * 3 + 2]!;
      R[i] = RV[i * 3]! + RV[i * 3 + 1]! + RV[i * 3 + 2]!;
      def[i] = 1;
      continue;
    }
    if (k === PASS || k === CHANCE) {
      let sw = 0;
      let cnt = 0;
      let part = 0;
      for (let s = a; s < b; s++) {
        const j = c.tgt[s]!;
        if (j < 0 || !def[j]) {
          part = 1;
          continue;
        }
        sw += c.w[s]!;
        cnt++;
      }
      if (cnt === 0) continue;
      const equal = sw <= 0;
      const norm = equal ? cnt : sw;
      for (let s = a; s < b; s++) {
        const j = c.tgt[s]!;
        if (j < 0 || !def[j]) continue;
        const ww = (equal ? 1 : c.w[s]!) / norm;
        V[i * 3] = V[i * 3]! + (ww * (S * c.er[s * 3]! + V[j * 3]!));
        V[i * 3 + 1] = V[i * 3 + 1]! + (ww * (c.er[s * 3 + 1]! + V[j * 3 + 1]!));
        V[i * 3 + 2] = V[i * 3 + 2]! + (ww * (c.er[s * 3 + 2]! + V[j * 3 + 2]!));
        RV[i * 3] = RV[i * 3]! + (ww * RV[j * 3]!);
        RV[i * 3 + 1] = RV[i * 3 + 1]! + (ww * RV[j * 3 + 1]!);
        RV[i * 3 + 2] = RV[i * 3 + 2]! + (ww * RV[j * 3 + 2]!);
        if (partial[j]) part = 1;
      }
      R[i] = RV[i * 3]! + RV[i * 3 + 1]! + RV[i * 3 + 2]!;
      def[i] = 1;
      partial[i] = part;
      continue;
    }
    // 判断
    let pickS = -1;
    let pickQ = 0;
    let bestS = -1;
    let bestQ = 0;
    let anyS = -1;
    let anyQ = 0;
    const bs = c.base[i]!;
    const forceBase = mode === 1 && bs >= 0 && c.allowed[bs] === 1 && c.tgt[bs]! >= 0 && def[c.tgt[bs]!] === 1;
    for (let s = a; s < b; s++) {
      const j = c.tgt[s]!;
      if (j < 0 || !def[j] || !c.allowed[s]) continue;
      if (mode === 2 && fam !== null && c.fam[j] === fam && !c.isBase[j]) continue;
      // 数の材料が無い手は、自分で選んだときだけ数える（一番良い手・★ にしない）
      if (c.noData[j] && c.stat[j] !== 1) continue;
      const qs = q(s, j);
      if (better(s, qs, anyS, anyQ)) (anyS = s), (anyQ = qs);
      if (c.stat[j] !== 2 && better(s, qs, bestS, bestQ)) (bestS = s), (bestQ = qs);
      if (c.stat[j] === 1 && better(s, qs, pickS, pickQ)) (pickS = s), (pickQ = qs);
    }
    if (anyS < 0) continue;
    if (bestS < 0) bestS = anyS;
    const piS = forceBase ? bs : pickS >= 0 ? pickS : bestS;
    const j = c.tgt[piS]!;
    V[i * 3] = S * c.er[piS * 3]! + V[j * 3]!;
    V[i * 3 + 1] = c.er[piS * 3 + 1]! + V[j * 3 + 1]!;
    V[i * 3 + 2] = c.er[piS * 3 + 2]! + V[j * 3 + 2]!;
    RV[i * 3] = RV[j * 3]!;
    RV[i * 3 + 1] = RV[j * 3 + 1]!;
    RV[i * 3 + 2] = RV[j * 3 + 2]!;
    R[i] = R[j]!;
    partial[i] = partial[j]!;
    def[i] = 1;
    pi[i] = piS;
    best[i] = bestS;
  }
  return { V, def, R, RV, partial, pi, best };
}

/** 選び方に沿って前へ流す（入口 = 1） */
export function forward(c: Compiled, p: Pass): Float64Array {
  const n = c.ids.length;
  const P = new Float64Array(n);
  // 入口が 2 つ以上でも、流すのは数字を出す入口（先頭）からだけ
  const r0 = c.roots[0];
  if (r0 !== undefined) P[r0] = 1;
  for (let i = 0; i < n; i++) {
    const m = P[i]!;
    if (!(m > 0) || !p.def[i]) continue;
    const k = c.kind[i]!;
    const a = c.off[i]!;
    const b = c.off[i + 1]!;
    if (k === DECISION) {
      const s = p.pi[i]!;
      if (s >= 0) P[c.tgt[s]!] = P[c.tgt[s]!]! + m;
      continue;
    }
    if (k === LEAF || a === b) continue;
    let sw = 0;
    let cnt = 0;
    for (let s = a; s < b; s++) {
      const j = c.tgt[s]!;
      if (j >= 0 && p.def[j]) (sw += c.w[s]!), cnt++;
    }
    if (!cnt) continue;
    const equal = sw <= 0;
    for (let s = a; s < b; s++) {
      const j = c.tgt[s]!;
      if (j >= 0 && p.def[j]) P[j] = P[j]! + (m * (equal ? 1 : c.w[s]!)) / (equal ? cnt : sw);
    }
  }
  return P;
}

export function sumV(V: Float64Array, i: number): number {
  return V[i * 3]! + V[i * 3 + 1]! + V[i * 3 + 2]!;
}

export function weightedQuantile(items: Array<{ v: number; w: number }>, q: number): number {
  const sorted = [...items].sort((a, b) => a.v - b.v);
  const total = sorted.reduce((s, x) => s + x.w, 0);
  if (!(total > 0)) return 0;
  let acc = 0;
  for (const x of sorted) {
    acc += x.w;
    if (acc >= q * total - 1e-12) return x.v;
  }
  return sorted[sorted.length - 1]!.v;
}

/** 判断の ★・≒・おすすめの元（decisionMarks）。並べた候補の最初が一番良い手（木の値） */
export interface DecisionMarks {
  /** 一番良い手（木の値）の線 */
  b1: number;
  /** ★ を付ける（一番の手が、決まりの差 thr 以上良い） */
  star: boolean;
  /** ≒ の基準: 一番の手の値（比べ方をそろえた値か木の値）と、その差の幅 */
  ref: number;
  thr: number;
  /** 比べ方をそろえた値（q）で比べた */
  like: boolean;
}

/**
 * 判断の ★ の決まり。sorted は候補（方針に入り・見送りでなく・数が出る手。数字なしの手は選んだときだけ）を木の値 q の大きい順
 * （同じなら今のまま、次に並びの前）に並べた物、l はその手の比べ方をそろえた値（q のある手は q の見積もり、無い手は木の値）。
 * 候補が 2 つ未満なら null（印を付けない）。
 *   like でない（q の無い地図）: 1 位と 2 位の木の値の差が IMPACT_STAR_LEAD 以上で ★、そうでなければ 1 位から IMPACT_STAR_LEAD 以内が ≒（今までどおり）
 *   like（q のある地図）: 1 位（木の値）の l と、ほかの候補の l の一番大きい物の差が max(IMPACT_STAR_LEAD, 候補の l の幅 × IMPACT_STAR_SHARE)
 *   以上で ★、そうでなければ 1 位の l からその幅の内の手が ≒
 */
export function decisionMarks(sorted: ReadonlyArray<{ s: number; q: number; l: number }>, like: boolean): DecisionMarks | null {
  if (sorted.length < 2) return null;
  const b1 = sorted[0]!;
  if (!like) return { b1: b1.s, star: b1.q - sorted[1]!.q >= IMPACT_STAR_LEAD, ref: b1.q, thr: IMPACT_STAR_LEAD, like: false };
  let hi = -Infinity;
  let lo = Infinity;
  let second = -Infinity;
  for (let k = 0; k < sorted.length; k++) {
    const l = sorted[k]!.l;
    if (l > hi) hi = l;
    if (l < lo) lo = l;
    if (k > 0 && l > second) second = l;
  }
  const thr = Math.max(IMPACT_STAR_LEAD, IMPACT_STAR_SHARE * (hi - lo));
  return { b1: b1.s, star: b1.l - second >= thr, ref: b1.l, thr, like: true };
}

/** その手の印。value はその手の値（m.like なら比べ方をそろえた値、そうでなければ木の値。数が出なければ null）、ok は方針に入り見送りでない */
export function optionMark(m: DecisionMarks | null, s: number, value: number | null, ok: boolean): AltInfo["mark"] {
  if (!m) return null;
  if (m.star) return s === m.b1 ? "star" : null;
  return value !== null && ok && m.ref - value < m.thr ? "tie" : null;
}

/** 手の比べ方をそろえた値（q があれば S·q0 + q1 + q2、無ければ木の値 tree） */
export function likeOf(q: Float64Array, j: number, S: number, tree: number): number {
  const q0 = q[j * 3]!;
  return Number.isNaN(q0) ? tree : S * q0 + q[j * 3 + 1]! + q[j * 3 + 2]!;
}

/** 候補の並べ方（木の値の大きい順。1e-9 以内なら今のまま、次に並びの前。computeImpact の ★ の並べ方） */
export function compareCands(c: Pick<Compiled, "tgt" | "isBase" | "rank">, x: { s: number; q: number }, y: { s: number; q: number }): number {
  if (Math.abs(x.q - y.q) > 1e-9) return y.q - x.q;
  const jx = c.tgt[x.s]!;
  const jy = c.tgt[y.s]!;
  if (c.isBase[jx] !== c.isBase[jy]) return c.isBase[jy]! - c.isBase[jx]!;
  return c.rank[jx]! - c.rank[jy]!;
}

/** 年収で今日の一番が入れ替わる所を、逆にたどる計算 1 回ごとに止まりながら探す（bestAt(年収) が 1 回の計算） */
export function* salaryFlipSteps(annual: number, cur: number, bestAt: (a: number) => number, idOf: (j: number) => ID): Generator<void, SalaryFlips, void> {
  const flips: SalaryFlips = { below: null, above: null };
  if (cur < 0) return flips;
  // 上: 20 万円ごとに見て、入れ替わったら境目を詰める
  let prev = annual;
  for (let a = Math.floor(annual / 20) * 20 + 20; a <= 1000; a += 20) {
    const alt = bestAt(a);
    yield;
    if (alt !== cur) {
      let lo = prev;
      let hi = a;
      let altHi = alt;
      for (let k = 0; k < 14 && hi - lo > 0.5; k++) {
        const m = (lo + hi) / 2;
        const am = bestAt(m);
        yield;
        if (am === cur) lo = m;
        else (hi = m), (altHi = am);
      }
      // 境目は今の年収から遠い側の 10 万円に丸める（「X より上なら」がいつも正しい）
      if (altHi >= 0) flips.above = { annual: Math.ceil(hi / 10) * 10, alt: idOf(altHi) };
      break;
    }
    prev = a;
  }
  // 下（1,000 万円より上は 100 万円ごと）
  const gridBelow = (x: number): number => (x > 1000 ? Math.ceil(x / 100) * 100 - 100 : Math.ceil(x / 20) * 20 - 20);
  prev = annual;
  for (let a = gridBelow(annual); a >= 200; a = gridBelow(a)) {
    const alt = bestAt(a);
    yield;
    if (alt !== cur) {
      let lo = a;
      let hi = prev;
      let altLo = alt;
      for (let k = 0; k < 14 && hi - lo > 0.5; k++) {
        const m = (lo + hi) / 2;
        const am = bestAt(m);
        yield;
        if (am === cur) hi = m;
        else (lo = m), (altLo = am);
      }
      if (altLo >= 0) flips.below = { annual: Math.floor(lo / 10) * 10, alt: idOf(altLo) };
      break;
    }
    prev = a;
  }
  return flips;
}

/**
 * 3 年の影響を計算する（基準の作り。アプリは ./impactEngine.ts）。fc は同じ文書・同じシナリオの見込み（P_path と範囲に使う）。
 * 範囲（v2 の入口）が無ければ active = false
 */
export function computeImpact(doc: DocData, out: Map<ID, ID[]>, fc: ForecastResult | null, scenarioId: ID | null = null): ImpactResult {
  const scope = fc && fc.impactScope ? fc.impactScope : impactScope(doc, out);
  if (!scope.size) return emptyResult();
  const rootIds = [...scope].filter((id) => isImpactRoot(doc.nodes[id])).sort();
  if (!rootIds.length) return emptyResult();
  // 入口が 2 つ以上（今日の複製・別の地図の追加の読み込み）: 年収・選び方の道・行き先・分布は 1 つの入口から（primaryImpactRoot）。
  // ほかの入口の先も、カードごとの差は同じ年収で出す
  const primary = primaryImpactRoot(doc, out);
  if (primary !== null && rootIds.includes(primary)) rootIds.splice(0, rootIds.length, primary, ...rootIds.filter((r) => r !== primary));
  const rootNode = doc.nodes[rootIds[0]!] as GNode;
  const cfg = impactConfigOf(rootNode)!;
  const annualSet = validAnnual(cfg.annual);
  const annual = annualSet ? cfg.annual! : IMPACT_DEFAULT_ANNUAL;
  const S = annual / 12;
  const tail = cfg.tail ?? 0;
  const H = cfg.horizon;
  const sid = scenarioId && doc.scenarios[scenarioId] ? scenarioId : null;
  const c = compile(doc, out, scope, sid, H, rootIds);
  const n = c.ids.length;
  const main = backward(c, S, tail, H, 0, null);
  const P = forward(c, main);
  const sq = backward(c, S, tail, H, 1, null);
  const Psq = forward(c, sq);

  const res = emptyResult();
  const kindM = new Map<ID, ForkKind>();
  const monthM = new Map<ID, number>();
  const valueM = new Map<ID, number>();
  const valueVM = new Map<ID, Vec3>();
  const rateM = new Map<ID, number>();
  const accM = new Map<ID, number>();
  const pPiM = new Map<ID, number>();
  const partialS = new Set<ID>();
  const altM = new Map<ID, AltInfo>();
  const decisionM = new Map<ID, DecisionInfo>();
  const outcomeM = new Map<ID, AltOutcome & { alt: ID }>();
  const piEdgesS = new Set<ID>();
  res.active = true;
  res.root = rootIds[0]!;
  res.scope = scope;
  res.annual = annual;
  res.annualSet = annualSet;
  res.S = S;
  res.tail = tail;
  res.horizon = H;
  res.likeBasis = c.likeBasis;
  res.kind = kindM;
  res.month = monthM;
  res.value = valueM;
  res.valueV = valueVM;
  res.rate = rateM;
  res.acc = accM;
  res.pPi = pPiM;
  res.partial = partialS;
  res.alt = altM;
  res.decision = decisionM;
  res.outcome = outcomeM;
  res.piEdges = piEdgesS;
  res.onPiEdge = (e) => piEdgesS.has(e.id);
  const W = (s: number): Vec3 => [S * c.er[s * 3]!, c.er[s * 3 + 1]!, c.er[s * 3 + 2]!];
  const Wsum = (s: number): number => S * c.er[s * 3]! + c.er[s * 3 + 1]! + c.er[s * 3 + 2]!;
  const Q = (pass: Pass, s: number): number | null => {
    const j = c.tgt[s]!;
    return j >= 0 && pass.def[j] ? Wsum(s) + sumV(pass.V, j) : null;
  };

  // ノードごとの値
  let decisions = 0;
  let options = 0;
  let forks = 0;
  let ends = 0;
  for (let i = 0; i < n; i++) {
    const id = c.ids[i]!;
    const k = c.kind[i]!;
    kindM.set(id, KIND_NAMES[k]!);
    monthM.set(id, c.t[i]!);
    const deg = c.off[i + 1]! - c.off[i]!;
    if (deg >= 2) forks++;
    if (k === DECISION) {
      if (deg >= 2) decisions++;
      options += deg;
    }
    if (k === LEAF) ends++;
    if (main.def[i]) {
      valueM.set(id, sumV(main.V, i));
      valueVM.set(id, [main.V[i * 3]!, main.V[i * 3 + 1]!, main.V[i * 3 + 2]!]);
      rateM.set(id, main.R[i]!);
      if (main.partial[i]) partialS.add(id);
    }
    if (P[i]! > 0) pPiM.set(id, P[i]!);
  }
  res.counts = { nodes: scope.size, decisions, options, forks, ends };

  // 今日からそこまでの稼ぎ（合流では、そこへ来る見込みで重みを付けた平均）
  const A = new Float64Array(n);
  const Adef = new Uint8Array(n);
  for (const r of c.roots) Adef[r] = 1;
  for (let i = 0; i < n; i++) {
    if (c.roots.includes(i)) {
      accM.set(c.ids[i]!, 0);
      continue;
    }
    let sw = 0;
    let sv = 0;
    let cnt = 0;
    let plain = 0;
    for (let k = c.incOff[i]!; k < c.incOff[i + 1]!; k++) {
      const s = c.incSlot[k]!;
      const u = c.src[s]!;
      if (!Adef[u]) continue;
      const pu = fc?.reach.get(c.ids[u]!)?.p ?? 0;
      const sw1 = (c.kind[u] === CHANCE ? c.w[s]! : 1) * pu;
      const val = A[u]! + Wsum(s);
      sw += sw1;
      sv += sw1 * val;
      plain += val;
      cnt++;
    }
    if (!cnt) continue;
    A[i] = sw > 0 ? sv / sw : plain / cnt;
    Adef[i] = 1;
    accM.set(c.ids[i]!, A[i]!);
  }

  /**
   * 選び方を決めたまま（main.pi）、start から先の値を出す。事実 R の答えを cat に決めた世界（R を知る結果の線は cat の線だけ）で数える。
   * 「聞く」手の結果を、聞かなかった場合の同じ答えの世界と比べるために使う（答えは会社ごとに決まった事実で、聞くたびに変わらない）
   */
  const evalFixed = (start: number, R: string, cat: string): number | null => {
    if (!main.def[start]) return null;
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
        if (v !== undefined) val.set(i, Wsum(s) + v);
        continue;
      }
      const a = c.off[i]!;
      const b = c.off[i + 1]!;
      let forced = false;
      for (let s = a; s < b; s++) if (c.rvKey[s] === R && c.rvCat[s] === cat) forced = true;
      // 答えを決めた世界: その答えの線だけを、それぞれの見込みの割合で（全部可・1 社目と全部可・まだ など）。
      // その答えの線がどれも 0% なら（この先ではその答えが出ない）、ふつうの割合で。割合が無ければ等分（逆にたどるときと同じ）
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
        const x = Wsum(s) + v;
        if (forced && c.rvKey[s] === R && c.rvCat[s] === cat) (swF += c.w[s]!), (svF += c.w[s]! * x);
        swA += c.w[s]!;
        svA += c.w[s]! * x;
        svE += x;
        cnt++;
      }
      if (cnt) val.set(i, forced && swF > 0 ? svF / swF : swA > 0 ? svA / swA : svE / cnt);
    }
    return val.get(start) ?? null;
  };

  // 判断と選択肢
  let hasPicks = false;
  for (let d = 0; d < n; d++) {
    if (c.kind[d] !== DECISION) continue;
    const a = c.off[d]!;
    const b = c.off[d + 1]!;
    const bs = c.base[d]!;
    const qBase = bs >= 0 ? Q(main, bs) : null;
    const jBase = bs >= 0 ? c.tgt[bs]! : -1;
    const altIds: Array<{ id: ID; rank: number; delta: number | null }> = [];
    let minD = Infinity;
    let maxD = -Infinity;
    // ★: 見送りを除いた候補（シナリオに入るもの）で上位（同じ値なら今のまま、次に並びの前）。q のある地図は比べ方をそろえた値で差を見る
    const cands: Array<{ s: number; q: number; l: number }> = [];
    for (let s = a; s < b; s++) {
      const j = c.tgt[s]!;
      if (j < 0) continue;
      if (c.stat[j] === 1) hasPicks = true;
      const qs = Q(main, s);
      if (qs === null || !c.allowed[s] || c.stat[j] === 2 || (c.noData[j] && c.stat[j] !== 1)) continue;
      cands.push({ s, q: qs, l: likeOf(c.q, j, S, qs) });
    }
    cands.sort((x, y) => compareCands(c, x, y));
    const marks = decisionMarks(cands, c.likeBasis);
    for (let s = a; s < b; s++) {
      const j = c.tgt[s]!;
      if (j < 0) continue;
      const altId = c.ids[j]!;
      if (altM.has(altId)) continue;
      const qs = Q(main, s);
      const delta = qs !== null && qBase !== null && !c.noData[j] ? qs - qBase : null;
      let deltaV: Vec3 | null = null;
      if (delta !== null && jBase >= 0) {
        const ws = W(s);
        const wb = W(bs);
        deltaV = [ws[0] + main.V[j * 3]! - wb[0] - main.V[jBase * 3]!, ws[1] + main.V[j * 3 + 1]! - wb[1] - main.V[jBase * 3 + 1]!, ws[2] + main.V[j * 3 + 2]! - wb[2] - main.V[jBase * 3 + 2]!];
      }
      const dR = main.def[j] && !c.noData[j] && jBase >= 0 && main.def[jBase] ? main.R[j]! - main.R[jBase]! : null;
      // 結果ごとの差
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
        // 確かめるだけの事実を知る手なら、基準は同じ答えの世界の今のまま（答えごとに 1 回だけ数える）
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
              const v = evalFixed(jBase, R, cat);
              matched.set(cat, v === null ? null : Wsum(bs) + v);
            }
          }
        }
        let bad = 0;
        for (let o = c.off[j]!; o < c.off[j + 1]!; o++) {
          const t2 = c.tgt[o]!;
          const defined = t2 >= 0 && main.def[t2] === 1;
          const ww = defined && cnt ? (equal ? 1 : c.w[o]!) / (equal ? cnt : sw) : 0;
          const ref = matched ? (matched.get(c.rvCat[o]!) ?? qBase) : qBase;
          const u = defined && ref !== null ? Wsum(s) + Wsum(o) + sumV(main.V, t2) - ref : null;
          outcomes.push({ edge: c.eid[o]!, node: t2 >= 0 ? c.ids[t2]! : (doc.edges[c.eid[o]!]?.target ?? ""), w: ww, u, bin: impactBin(u) });
          if (u !== null && ww > 0) {
            if (u < -BAD_EPS) bad += ww;
            // 起こらない結果（0%）は「悪くて」に入れない
            worst = worst === null ? u : Math.min(worst, u);
          }
        }
        pBad = qBase !== null && cnt ? bad : null;
      } else if (delta !== null) {
        pBad = delta < -BAD_EPS ? 1 : 0;
        worst = delta;
      }
      // ★: 決まりの差（q の無い地図は 10 万円）以上良い一番の手。差が小さければ、一番の手からその差の内の手はどれも ≒
      const value = qs === null ? null : marks?.like ? likeOf(c.q, j, S, qs) : qs;
      const mark = optionMark(marks, s, value, c.allowed[s] === 1 && c.stat[j] !== 2);
      // 基準（今のまま）は自分と比べるので、悪くなる見込みは出さない
      if (c.isBase[j]) {
        pBad = null;
        worst = null;
      }
      const info: AltInfo = {
        decision: c.ids[d]!,
        edge: c.eid[s]!,
        isBase: c.isBase[j] === 1,
        allowed: c.allowed[s] === 1,
        picked: c.stat[j] === 1,
        dropped: c.stat[j] === 2,
        delta,
        deltaV,
        dR,
        pBad,
        worst,
        bin: impactBin(delta),
        mark,
        rec: !!marks?.like && s === marks.b1,
        partial: main.partial[j] === 1,
        outcomes,
      };
      altM.set(altId, info);
      for (const o of outcomes) if (o.node && !outcomeM.has(o.node)) outcomeM.set(o.node, { ...o, alt: altId });
      if (delta !== null) (minD = Math.min(minD, delta)), (maxD = Math.max(maxD, delta));
      altIds.push({ id: altId, rank: c.rank[j]!, delta });
    }
    altIds.sort((x, y) => x.rank - y.rank || (y.delta ?? -Infinity) - (x.delta ?? -Infinity));
    const bestS = main.best[d]!;
    const piS = main.pi[d]!;
    const qBest = bestS >= 0 ? Q(main, bestS) : null;
    decisionM.set(c.ids[d]!, {
      alts: altIds.map((x) => x.id),
      base: jBase >= 0 ? c.ids[jBase]! : null,
      best: bestS >= 0 ? c.ids[c.tgt[bestS]!]! : null,
      chosen: piS >= 0 ? c.ids[c.tgt[piS]!]! : null,
      stakes: qBest !== null && qBase !== null ? qBest - qBase : null,
      spread: minD <= maxD ? [minD, maxD] : null,
    });
  }
  res.hasPicks = hasPicks;

  // 選び方の道の上の線
  for (let i = 0; i < n; i++) {
    if (!(P[i]! > 0)) continue;
    const k = c.kind[i]!;
    if (k === DECISION) {
      const s = main.pi[i]!;
      if (s >= 0) piEdgesS.add(c.eid[s]!);
    } else if (k === CHANCE || k === PASS) {
      for (let s = c.off[i]!; s < c.off[i + 1]!; s++) if (c.tgt[s]! >= 0 && main.def[c.tgt[s]!]) piEdgesS.add(c.eid[s]!);
    }
  }

  // 入口の値・ずっと今のまま・行き先と分布
  const r0 = c.roots[0];
  if (r0 !== undefined && main.def[r0]) {
    res.vRoot = sumV(main.V, r0);
    res.rRoot = main.R[r0]!;
  }
  if (r0 !== undefined && sq.def[r0]) {
    res.vSQ = sumV(sq.V, r0);
    res.rSQ = sq.R[r0]!;
  }
  const endItems: ImpactEnd[] = [];
  const sqItems: Array<{ v: number; w: number }> = [];
  for (let i = 0; i < n; i++) {
    if (c.kind[i] !== LEAF || !main.def[i] || !Adef[i]) continue;
    const tot = A[i]! + sumV(main.V, i);
    if (P[i]! > 0) endItems.push({ id: c.ids[i]!, p: P[i]!, tot });
    if (Psq[i]! > 0) sqItems.push({ v: tot, w: Psq[i]! });
  }
  endItems.sort((x, y) => y.p - x.p || y.tot - x.tot);
  res.ends = endItems;
  res.dist = distOf(endItems, sqItems, res.vSQ);

  // 遅延計算: 年収で今日の一番が入れ替わる所・その種類の手をずっとやらない場合・おすすめの選び方の値
  let flips: SalaryFlips | null = null;
  res.salaryFlips = () => {
    if (flips) return flips;
    if (r0 === undefined) return (flips = { below: null, above: null });
    const bestAt = (a: number): number => {
      const p2 = backward(c, a / 12, tail, H, 0, null);
      const s = p2.best[r0]!;
      return s >= 0 ? c.tgt[s]! : -1;
    };
    const cur = main.best[r0]! >= 0 ? c.tgt[main.best[r0]!]! : -1;
    const steps = salaryFlipSteps(annual, cur, bestAt, (j) => c.ids[j]!);
    let r = steps.next();
    while (!r.done) r = steps.next();
    flips = r.value;
    return flips;
  };
  res.salaryFlipsReady = () => flips;
  res.salaryFlipsStep = () => res.salaryFlips();
  const neverCache = new Map<string, NeverResult>();
  res.never = (f: string) => {
    const hit = neverCache.get(f);
    if (hit) return hit;
    const p2 = backward(c, S, tail, H, 2, f);
    const card = new Map<ID, number>();
    for (let d = 0; d < n; d++) {
      if (c.kind[d] !== DECISION || !p2.def[d]) continue;
      const vNever = sumV(p2.V, d);
      for (let s = c.off[d]!; s < c.off[d + 1]!; s++) {
        const j = c.tgt[s]!;
        if (j < 0 || c.fam[j] !== f || c.isBase[j]) continue;
        const qs = Q(main, s);
        if (qs !== null && !card.has(c.ids[j]!)) card.set(c.ids[j]!, qs - vNever);
      }
    }
    const k = r0 !== undefined && main.def[r0] && p2.def[r0] ? sumV(main.V, r0) - sumV(p2.V, r0) : null;
    const result = { k, card };
    neverCache.set(f, result);
    return result;
  };
  res.families = () => {
    const set = new Set<string>();
    for (const [id, info] of altM) {
      if (info.isBase) continue;
      const j = c.idx.get(id);
      if (j !== undefined && c.fam[j]) set.add(c.fam[j]!);
    }
    return [...set];
  };
  // おすすめの選び方: 自分で選んだ手（進行中・完了）を外し（見送りはそのまま）、方針でも絞らずに数え直した今日の値
  let rec: { v: number | null } | null = null;
  res.recommended = () => {
    if (rec) return rec.v;
    const nodes = { ...doc.nodes };
    for (const id of scope) {
      const x = nodes[id];
      if (x && (x.status === "active" || x.status === "done")) nodes[id] = { ...x, status: "open" };
    }
    rec = { v: computeImpact({ ...doc, nodes }, out, null, null).vRoot };
    return rec.v;
  };
  res.altIds = () => [...altM.keys()];
  res.deltaOf = (id) => altM.get(id)?.delta ?? null;
  res.markOf = (id) => altM.get(id)?.mark ?? null;
  res.isBaseOf = (id) => altM.get(id)?.isBase === true;
  res.decisionIds = () => [...decisionM.keys()];
  res.stakesOf = (id) => decisionM.get(id)?.stakes ?? null;
  res.bestOf = (id) => decisionM.get(id)?.best ?? null;
  // 先の数: 並べる順の後ろから、子（後ろの番号の物だけ。入口へ戻る線は数えない）の数を足す
  let rip: Int32Array | null = null;
  res.ripple = (id) => {
    const i = c.idx.get(id);
    if (i === undefined) return null;
    if (!rip) {
      rip = new Int32Array(n * 4);
      for (let x = n - 1; x >= 0; x--) {
        const k = c.kind[x]!;
        const deg = c.off[x + 1]! - c.off[x]!;
        if (k === DECISION && deg >= 2) rip[x * 4]!++;
        if (k === CHANCE && deg >= 2) rip[x * 4 + 1]!++;
        if (k === LEAF) {
          rip[x * 4 + 2]!++;
          if (doc.nodes[c.ids[x]!]?.meta?.sum === true) rip[x * 4 + 3]!++;
        }
        for (let s = c.off[x]!; s < c.off[x + 1]!; s++) {
          const y = c.tgt[s]!;
          if (y > x) for (let f = 0; f < 4; f++) rip[x * 4 + f] = rip[x * 4 + f]! + rip[y * 4 + f]!;
        }
      }
    }
    return { decisions: rip[i * 4]!, splits: rip[i * 4 + 1]!, ends: rip[i * 4 + 2]!, sumEnds: rip[i * 4 + 3]! };
  };
  return res;
}

/** 3 年後の分布（行き先の見込みの順の並び endItems と、ずっと今のままの行き先の並び sqItems から） */
export function distOf(endItems: readonly ImpactEnd[], sqItems: ReadonlyArray<{ v: number; w: number }>, vSQ: number | null): ImpactDist | null {
  if (!endItems.length || vSQ === null) return null;
  const items = endItems.map((e) => ({ v: e.tot, w: e.p }));
  const total = items.reduce((s, x) => s + x.w, 0);
  const mean = items.reduce((s, x) => s + x.v * x.w, 0) / total;
  const bins = new Array<number>(9).fill(0);
  let worse = 0;
  for (const x of items) {
    bins[impactBin(x.v - vSQ) + 4] = bins[impactBin(x.v - vSQ) + 4]! + (x.w / total);
    if (x.v < vSQ - BAD_EPS) worse += x.w / total;
  }
  const sqBins = new Array<number>(9).fill(0);
  const sqTotal = sqItems.reduce((s, x) => s + x.w, 0);
  for (const x of sqItems) {
    const k = impactBin(x.v - vSQ) + 4;
    sqBins[k] = sqBins[k]! + (sqTotal > 0 ? x.w / sqTotal : 0);
  }
  return { mean, p10: weightedQuantile(items, 0.1), p50: weightedQuantile(items, 0.5), p90: weightedQuantile(items, 0.9), pWorse: worse, bins, sqBins };
}
