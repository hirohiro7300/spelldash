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

import type { ForecastResult } from "./forecast";
import { chanceWeights, flowOuts, forkKindOf, impactConfigOf, impactScope, isImpactRoot, type ForkKind } from "./forks";
import { impactBin } from "./impactFormat";
import { dayNumber, isDateStr } from "./dates";
import type { DocData, GNode, ID } from "./types";

export type Vec3 = [number, number, number];

/** 年収（額面・万円）が入っていないときに仮に使う値 */
export const IMPACT_DEFAULT_ANNUAL = 360;
/** 年収として受け付ける範囲（万円） */
export const IMPACT_ANNUAL_MIN = 100;
export const IMPACT_ANNUAL_MAX = 3000;
/** ★（おすすめ）を付ける差（2 位より何万円良ければ） */
export const IMPACT_STAR_LEAD = 3;
/** 「悪くなる」と数える差（万円） */
const BAD_EPS = 0.05;

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
  card: Map<ID, number>;
}

export interface ImpactResult {
  active: boolean;
  root: ID | null;
  scope: Set<ID>;
  annual: number;
  /** 年収が入っている（false なら仮の値） */
  annualSet: boolean;
  S: number;
  tail: number;
  horizon: number;
  kind: Map<ID, ForkKind>;
  month: Map<ID, number>;
  /** その時点から horizon までの稼ぎ（その後は一番良い選び方） */
  value: Map<ID, number>;
  valueV: Map<ID, Vec3>;
  /** horizon での月の稼ぎ（万円/月） */
  rate: Map<ID, number>;
  /** 今日からそこまでの稼ぎ */
  acc: Map<ID, number>;
  /** おすすめ（または自分）の選び方でそこに来る見込み */
  pPi: Map<ID, number>;
  partial: Set<ID>;
  alt: Map<ID, AltInfo>;
  decision: Map<ID, DecisionInfo>;
  outcome: Map<ID, AltOutcome & { alt: ID }>;
  /** 選び方の道の上の線 */
  piEdges: Set<ID>;
  vRoot: number | null;
  vSQ: number | null;
  rRoot: number | null;
  rSQ: number | null;
  ends: ImpactEnd[];
  dist: ImpactDist | null;
  counts: { nodes: number; decisions: number; options: number; forks: number; ends: number };
  /** 自分で選んだ手がある */
  hasPicks: boolean;
  /** 年収を変えると今日の一番が入れ替わる所（遅延計算） */
  salaryFlips(): { below: SalaryFlip | null; above: SalaryFlip | null };
  /** その種類の手を 3 年間ずっとやらない場合（遅延計算） */
  never(fam: string): NeverResult;
  /** 手の種類（基準を除く） */
  families(): string[];
}

const LEAF = 0;
const PASS = 1;
const CHANCE = 2;
const DECISION = 3;
const KIND_NAMES: ForkKind[] = ["leaf", "pass", "chance", "decision"];

interface Compiled {
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
  fam: string[];
  roots: number[];
  /** 確かめるだけの事実を知る結果の線: 事実の名前と答え（meta.rv）。無ければ null */
  rvKey: Array<string | null>;
  rvCat: Array<string | null>;
  /** 入ってくる線（slot の番号） */
  incOff: Int32Array;
  incSlot: Int32Array;
  src: Int32Array;
}

interface Pass {
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
  salaryFlips: () => ({ below: null, above: null }),
  never: () => ({ k: null, card: new Map() }),
  families: () => [],
});

function vec3(v: unknown): Vec3 | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const a = v.map(Number);
  return a.every((x) => Number.isFinite(x)) ? [a[0]!, a[1]!, a[2]!] : null;
}

/** 年収の値として使えるか */
export function validAnnual(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= IMPACT_ANNUAL_MIN && x <= IMPACT_ANNUAL_MAX;
}

function compile(doc: DocData, out: Map<ID, ID[]>, scope: Set<ID>, scenarioId: ID | null, H: number, rootIds: ID[]): Compiled {
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
  const fam: string[] = new Array<string>(n);
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
    fam[i] = typeof node.meta?.fam === "string" ? (node.meta.fam as string) : typeof node.meta?.ak === "string" ? (node.meta.ak as string) : "";
    const fp = firstParent[i]!;
    const m = node.meta?.m;
    let ti: number;
    if (typeof m === "number" && Number.isFinite(m)) ti = m;
    else if (rootDay !== null && isDateStr(node.time.due)) ti = (dayNumber(node.time.due) - rootDay) / 30.44;
    else ti = fp >= 0 ? t[fp]! : 0;
    t[i] = Math.max(0, Math.min(H, ti));
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
  return { ids, idx, kind, t, rr, off, tgt, eid, w, er, allowed, base, stat, rank, isBase, fam, roots, rvKey, rvCat, incOff, incSlot, src };
}

/** 逆にたどる（mode 0: ふつう・1: ずっと今のまま・2: その種類の手を使わない） */
function backward(c: Compiled, S: number, tail: number, H: number, mode: 0 | 1 | 2, fam: string | null): Pass {
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
  for (let i = n - 1; i >= 0; i--) {
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
function forward(c: Compiled, p: Pass): Float64Array {
  const n = c.ids.length;
  const P = new Float64Array(n);
  for (const r of c.roots) P[r] = 1;
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

function sumV(V: Float64Array, i: number): number {
  return V[i * 3]! + V[i * 3 + 1]! + V[i * 3 + 2]!;
}

function weightedQuantile(items: Array<{ v: number; w: number }>, q: number): number {
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

/**
 * 3 年の影響を計算する。fc は同じ文書・同じシナリオの見込み（P_path と範囲に使う）。
 * 範囲（v2 の入口）が無ければ active = false
 */
export function computeImpact(doc: DocData, out: Map<ID, ID[]>, fc: ForecastResult | null, scenarioId: ID | null = null): ImpactResult {
  const scope = fc && fc.impactScope ? fc.impactScope : impactScope(doc, out);
  if (!scope.size) return emptyResult();
  const rootIds = [...scope].filter((id) => isImpactRoot(doc.nodes[id])).sort();
  if (!rootIds.length) return emptyResult();
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
  res.active = true;
  res.root = rootIds[0]!;
  res.scope = scope;
  res.annual = annual;
  res.annualSet = annualSet;
  res.S = S;
  res.tail = tail;
  res.horizon = H;
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
    res.kind.set(id, KIND_NAMES[k]!);
    res.month.set(id, c.t[i]!);
    const deg = c.off[i + 1]! - c.off[i]!;
    if (deg >= 2) forks++;
    if (k === DECISION) {
      if (deg >= 2) decisions++;
      options += deg;
    }
    if (k === LEAF) ends++;
    if (main.def[i]) {
      res.value.set(id, sumV(main.V, i));
      res.valueV.set(id, [main.V[i * 3]!, main.V[i * 3 + 1]!, main.V[i * 3 + 2]!]);
      res.rate.set(id, main.R[i]!);
      if (main.partial[i]) res.partial.add(id);
    }
    if (P[i]! > 0) res.pPi.set(id, P[i]!);
  }
  res.counts = { nodes: scope.size, decisions, options, forks, ends };

  // 今日からそこまでの稼ぎ（合流では、そこへ来る見込みで重みを付けた平均）
  const A = new Float64Array(n);
  const Adef = new Uint8Array(n);
  for (const r of c.roots) Adef[r] = 1;
  for (let i = 0; i < n; i++) {
    if (c.roots.includes(i)) {
      res.acc.set(c.ids[i]!, 0);
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
    res.acc.set(c.ids[i]!, A[i]!);
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
      let sw = 0;
      let sv = 0;
      let cnt = 0;
      for (let s = a; s < b; s++) {
        const j = c.tgt[s]!;
        const v = j >= 0 ? val.get(j) : undefined;
        if (v === undefined) continue;
        const ww = forced ? (c.rvKey[s] === R && c.rvCat[s] === cat ? 1 : 0) : c.w[s]!;
        sw += ww;
        sv += ww * (Wsum(s) + v);
        cnt++;
      }
      if (cnt) val.set(i, sw > 0 ? sv / sw : 0);
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
    // ★: 見送りを除いた候補（シナリオに入るもの）で上位 2 つ（同じ値なら今のまま、次に並びの前）
    const cands: Array<{ s: number; q: number }> = [];
    for (let s = a; s < b; s++) {
      const j = c.tgt[s]!;
      if (j < 0) continue;
      if (c.stat[j] === 1) hasPicks = true;
      const qs = Q(main, s);
      if (qs === null || !c.allowed[s] || c.stat[j] === 2) continue;
      cands.push({ s, q: qs });
    }
    cands.sort((x, y) => {
      if (Math.abs(x.q - y.q) > 1e-9) return y.q - x.q;
      const jx = c.tgt[x.s]!;
      const jy = c.tgt[y.s]!;
      if (c.isBase[jx] !== c.isBase[jy]) return c.isBase[jy]! - c.isBase[jx]!;
      return c.rank[jx]! - c.rank[jy]!;
    });
    const b1 = cands[0]?.s ?? -1;
    const q1 = cands[0]?.q ?? 0;
    const b2 = cands[1]?.s ?? -1;
    const q2 = cands[1]?.q ?? 0;
    for (let s = a; s < b; s++) {
      const j = c.tgt[s]!;
      if (j < 0) continue;
      const altId = c.ids[j]!;
      if (res.alt.has(altId)) continue;
      const qs = Q(main, s);
      const delta = qs !== null && qBase !== null ? qs - qBase : null;
      let deltaV: Vec3 | null = null;
      if (delta !== null && jBase >= 0) {
        const ws = W(s);
        const wb = W(bs);
        deltaV = [ws[0] + main.V[j * 3]! - wb[0] - main.V[jBase * 3]!, ws[1] + main.V[j * 3 + 1]! - wb[1] - main.V[jBase * 3 + 1]!, ws[2] + main.V[j * 3 + 2]! - wb[2] - main.V[jBase * 3 + 2]!];
      }
      const dR = main.def[j] && jBase >= 0 && main.def[jBase] ? main.R[j]! - main.R[jBase]! : null;
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
          if (u !== null) {
            if (u < -BAD_EPS) bad += ww;
            worst = worst === null ? u : Math.min(worst, u);
          }
        }
        pBad = qBase !== null && cnt ? bad : null;
      } else if (delta !== null) {
        pBad = delta < -BAD_EPS ? 1 : 0;
        worst = delta;
      }
      let mark: AltInfo["mark"] = null;
      if (b1 >= 0 && b2 >= 0) {
        if (s === b1 && q1 - q2 >= IMPACT_STAR_LEAD) mark = "star";
        else if ((s === b1 || s === b2) && q1 - q2 < IMPACT_STAR_LEAD) mark = "tie";
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
        partial: main.partial[j] === 1,
        outcomes,
      };
      res.alt.set(altId, info);
      for (const o of outcomes) if (o.node && !res.outcome.has(o.node)) res.outcome.set(o.node, { ...o, alt: altId });
      if (delta !== null) (minD = Math.min(minD, delta)), (maxD = Math.max(maxD, delta));
      altIds.push({ id: altId, rank: c.rank[j]!, delta });
    }
    altIds.sort((x, y) => x.rank - y.rank || (y.delta ?? -Infinity) - (x.delta ?? -Infinity));
    const bestS = main.best[d]!;
    const piS = main.pi[d]!;
    const qBest = bestS >= 0 ? Q(main, bestS) : null;
    res.decision.set(c.ids[d]!, {
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
      if (s >= 0) res.piEdges.add(c.eid[s]!);
    } else if (k === CHANCE || k === PASS) {
      for (let s = c.off[i]!; s < c.off[i + 1]!; s++) if (c.tgt[s]! >= 0 && main.def[c.tgt[s]!]) res.piEdges.add(c.eid[s]!);
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
  if (endItems.length && res.vSQ !== null) {
    const items = endItems.map((e) => ({ v: e.tot, w: e.p }));
    const total = items.reduce((s, x) => s + x.w, 0);
    const mean = items.reduce((s, x) => s + x.v * x.w, 0) / total;
    const bins = new Array<number>(9).fill(0);
    let worse = 0;
    for (const x of items) {
      bins[impactBin(x.v - res.vSQ) + 4] = bins[impactBin(x.v - res.vSQ) + 4]! + (x.w / total);
      if (x.v < res.vSQ - BAD_EPS) worse += x.w / total;
    }
    const sqBins = new Array<number>(9).fill(0);
    const sqTotal = sqItems.reduce((s, x) => s + x.w, 0);
    for (const x of sqItems) {
      const k = impactBin(x.v - res.vSQ) + 4;
      sqBins[k] = sqBins[k]! + (sqTotal > 0 ? x.w / sqTotal : 0);
    }
    res.dist = { mean, p10: weightedQuantile(items, 0.1), p50: weightedQuantile(items, 0.5), p90: weightedQuantile(items, 0.9), pWorse: worse, bins, sqBins };
  }

  // 遅延計算: 年収で今日の一番が入れ替わる所・その種類の手をずっとやらない場合
  let flips: { below: SalaryFlip | null; above: SalaryFlip | null } | null = null;
  res.salaryFlips = () => {
    if (flips) return flips;
    flips = { below: null, above: null };
    if (r0 === undefined) return flips;
    const bestAt = (a: number): number => {
      const p2 = backward(c, a / 12, tail, H, 0, null);
      const s = p2.best[r0]!;
      return s >= 0 ? c.tgt[s]! : -1;
    };
    const cur = main.best[r0]! >= 0 ? c.tgt[main.best[r0]!]! : -1;
    if (cur < 0) return flips;
    // 上: 20 万円ごとに見て、入れ替わったら境目を詰める
    let prev = annual;
    for (let a = Math.floor(annual / 20) * 20 + 20; a <= 1000; a += 20) {
      const alt = bestAt(a);
      if (alt !== cur) {
        let lo = prev;
        let hi = a;
        let altHi = alt;
        for (let k = 0; k < 14 && hi - lo > 0.5; k++) {
          const m = (lo + hi) / 2;
          const am = bestAt(m);
          if (am === cur) lo = m;
          else (hi = m), (altHi = am);
        }
        if (altHi >= 0) flips.above = { annual: Math.round(hi / 10) * 10, alt: c.ids[altHi]! };
        break;
      }
      prev = a;
    }
    // 下
    prev = annual;
    for (let a = Math.ceil(annual / 20) * 20 - 20; a >= 200; a -= 20) {
      const alt = bestAt(a);
      if (alt !== cur) {
        let lo = a;
        let hi = prev;
        let altLo = alt;
        for (let k = 0; k < 14 && hi - lo > 0.5; k++) {
          const m = (lo + hi) / 2;
          const am = bestAt(m);
          if (am === cur) hi = m;
          else (lo = m), (altLo = am);
        }
        if (altLo >= 0) flips.below = { annual: Math.round(lo / 10) * 10, alt: c.ids[altLo]! };
        break;
      }
      prev = a;
    }
    return flips;
  };
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
    for (const [id, info] of res.alt) {
      if (info.isBase) continue;
      const j = c.idx.get(id);
      if (j !== undefined && c.fam[j]) set.add(c.fam[j]!);
    }
    return [...set];
  };
  return res;
}
