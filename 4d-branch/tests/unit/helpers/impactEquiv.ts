// エンジン（src/model/impactEngine.ts）と基準の作り（src/model/impact.ts の computeImpact）が、アプリが読む所すべてで同じ答えかを比べる道具
//   sameImpact(ref, eng)  値・差・内訳・選び方・見込み・そこまでの稼ぎ・行き先・分布・印・結果・年収の境目・やらない場合・おすすめの値・数
//   refRun / engRun        文書から両方を数える（同じ見込み・同じ方針）

import { expect } from "vitest";
import { computeForecast, type ForecastResult } from "../../../src/model/forecast";
import { buildIndex } from "../../../src/model/graph";
import { computeImpact, type AltInfo, type ImpactResult } from "../../../src/model/impact";
import { ImpactEngine, type MapDoc } from "../../../src/model/impactEngine";
import type { DocData, ID } from "../../../src/model/types";

const EPS = 1e-9;

function num(a: number | null | undefined, b: number | null | undefined, what: string): void {
  if (a === null || a === undefined || b === null || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) {
    if (!(a === b || (Number.isNaN(a) && Number.isNaN(b)))) expect([what, a ?? null]).toEqual([what, b ?? null]);
    return;
  }
  if (Math.abs(a - b) > EPS * Math.max(1, Math.abs(b))) expect([what, a]).toEqual([what, b]);
}

function vec(a: readonly number[] | null | undefined, b: readonly number[] | null | undefined, what: string): void {
  if (!a || !b) {
    expect([what, a ?? null]).toEqual([what, b ?? null]);
    return;
  }
  expect([what, a.length]).toEqual([what, b.length]);
  a.forEach((x, k) => num(x, b[k], `${what}[${k}]`));
}

function sameSet(a: ReadonlySet<ID> | Iterable<ID>, b: ReadonlySet<ID> | Iterable<ID>, what: string): void {
  const x = [...a].sort();
  const y = [...b].sort();
  expect([what, x.length]).toEqual([what, y.length]);
  if (x.join("\n") !== y.join("\n")) expect([what, x]).toEqual([what, y]);
}

function sameAlt(e: AltInfo, r: AltInfo, id: ID): void {
  const w = `選択肢 ${id}`;
  expect([w, e.decision, e.edge, e.isBase, e.allowed, e.picked, e.dropped, e.bin, e.mark, e.rec, e.partial]).toEqual([w, r.decision, r.edge, r.isBase, r.allowed, r.picked, r.dropped, r.bin, r.mark, r.rec, r.partial]);
  num(e.delta, r.delta, `${w} delta`);
  vec(e.deltaV, r.deltaV, `${w} deltaV`);
  num(e.dR, r.dR, `${w} dR`);
  num(e.pBad, r.pBad, `${w} pBad`);
  num(e.worst, r.worst, `${w} worst`);
  expect([w, e.outcomes.length]).toEqual([w, r.outcomes.length]);
  e.outcomes.forEach((o, k) => {
    const q = r.outcomes[k]!;
    expect([w, k, o.edge, o.node, o.bin]).toEqual([w, k, q.edge, q.node, q.bin]);
    num(o.w, q.w, `${w} 結果 ${k} w`);
    num(o.u, q.u, `${w} 結果 ${k} u`);
  });
}

export interface SameOpts {
  /** 年収の境目まで比べる（大きい地図では遅いので選べる） */
  flips?: boolean;
  /** やらない場合を比べる手の種類（既定は全部） */
  fams?: number;
  /** 選択肢・結果を全部比べる（既定 true） */
  details?: boolean;
}

/** エンジンの結果 eng が基準の結果 ref と、アプリが読む所すべてで同じ */
export function sameImpact(eng: ImpactResult, ref: ImpactResult, opts: SameOpts = {}, doc?: DocData): void {
  expect(eng.active).toBe(ref.active);
  if (!ref.active) return;
  expect([eng.root, eng.annual, eng.annualSet, eng.S, eng.tail, eng.horizon, eng.likeBasis, eng.hasPicks]).toEqual([ref.root, ref.annual, ref.annualSet, ref.S, ref.tail, ref.horizon, ref.likeBasis, ref.hasPicks]);
  expect(eng.counts).toEqual(ref.counts);
  num(eng.vRoot, ref.vRoot, "vRoot");
  num(eng.vSQ, ref.vSQ, "vSQ");
  num(eng.rRoot, ref.rRoot, "rRoot");
  num(eng.rSQ, ref.rSQ, "rSQ");
  sameSet(eng.scope, ref.scope, "範囲");
  expect(eng.scope.size).toBe(ref.scope.size);
  for (const id of ref.scope) expect(eng.scope.has(id)).toBe(true);
  // ノードごとの値（どれも、基準に無い ID はエンジンにも無い）
  expect([eng.kind.size, eng.month.size, eng.value.size, eng.valueV.size, eng.rate.size, eng.acc.size, eng.pPi.size]).toEqual([ref.kind.size, ref.month.size, ref.value.size, ref.valueV.size, ref.rate.size, ref.acc.size, ref.pPi.size]);
  for (const [id, k] of ref.kind) {
    expect([id, eng.kind.get(id)]).toEqual([id, k]);
    num(eng.month.get(id), ref.month.get(id), `月 ${id}`);
    num(eng.value.get(id), ref.value.get(id), `値 ${id}`);
    vec(eng.valueV.get(id), ref.valueV.get(id), `内訳 ${id}`);
    num(eng.rate.get(id), ref.rate.get(id), `月の稼ぎ ${id}`);
    num(eng.acc.get(id), ref.acc.get(id), `そこまで ${id}`);
    num(eng.pPi.get(id), ref.pPi.get(id), `来る見込み ${id}`);
    expect([id, eng.partial.has(id)]).toEqual([id, ref.partial.has(id)]);
  }
  sameSet(eng.partial, ref.partial, "先に数の出ない所");
  sameSet(eng.piEdges, ref.piEdges, "選び方の道の線");
  for (const e of ref.piEdges) expect(eng.piEdges.has(e)).toBe(true);
  if (doc) for (const e of Object.values(doc.edges)) expect([e.id, eng.onPiEdge(e)]).toEqual([e.id, ref.piEdges.has(e.id)]);
  // 判断
  expect(eng.decision.size).toBe(ref.decision.size);
  sameSet(eng.decisionIds(), ref.decisionIds(), "判断の ID");
  for (const [id, d] of ref.decision) {
    const x = eng.decision.get(id)!;
    expect([id, x.alts, x.base, x.best, x.chosen]).toEqual([id, d.alts, d.base, d.best, d.chosen]);
    num(x.stakes, d.stakes, `判断 ${id} stakes`);
    vec(x.spread, d.spread, `判断 ${id} spread`);
    num(eng.stakesOf(id), d.stakes, `stakesOf ${id}`);
    expect(eng.bestOf(id)).toBe(d.best);
  }
  // 選択肢（AltInfo を作らない読み口も）
  expect(eng.alt.size).toBe(ref.alt.size);
  sameSet(eng.altIds(), ref.altIds(), "選択肢の ID");
  for (const [id, a] of ref.alt) {
    num(eng.deltaOf(id), a.delta, `deltaOf ${id}`);
    expect([id, eng.markOf(id), eng.isBaseOf(id)]).toEqual([id, a.mark, a.isBase]);
    if (opts.details !== false) sameAlt(eng.alt.get(id)!, a, id);
  }
  if (opts.details !== false) {
    expect(eng.outcome.size).toBe(ref.outcome.size);
    for (const [id, o] of ref.outcome) {
      const x = eng.outcome.get(id)!;
      expect([id, x.alt, x.edge, x.node, x.bin]).toEqual([id, o.alt, o.edge, o.node, o.bin]);
      num(x.w, o.w, `結果 ${id} w`);
      num(x.u, o.u, `結果 ${id} u`);
    }
  }
  // 行き先と分布（同じ見込み・同じ値の並びまで同じ）
  expect(eng.ends.map((e) => e.id)).toEqual(ref.ends.map((e) => e.id));
  eng.ends.forEach((e, k) => {
    num(e.p, ref.ends[k]!.p, `行き先 ${k} p`);
    num(e.tot, ref.ends[k]!.tot, `行き先 ${k} tot`);
  });
  const d1 = eng.dist;
  const d0 = ref.dist;
  expect(d1 === null).toBe(d0 === null);
  if (d1 && d0) {
    for (const k of ["mean", "p10", "p50", "p90", "pWorse"] as const) num(d1[k], d0[k], `分布 ${k}`);
    vec(d1.bins, d0.bins, "分布の段");
    vec(d1.sqBins, d0.sqBins, "今のままの段");
  }
  // 手の種類・やらない場合
  const fams = ref.families();
  sameSet(eng.families(), fams, "手の種類");
  for (const f of fams.slice(0, opts.fams ?? fams.length)) {
    const a = eng.never(f);
    const b = ref.never(f);
    num(a.k, b.k, `やらない場合 ${f}`);
    expect(a.card.size).toBe(b.card.size);
    for (const [id, v] of b.card) num(a.card.get(id), v, `やらない場合 ${f} ${id}`);
  }
  num(eng.recommended(), ref.recommended(), "おすすめの値");
  if (opts.flips !== false) expect(eng.salaryFlips()).toEqual(ref.salaryFlips());
  for (const id of ref.kind.keys()) expect([id, eng.ripple(id)]).toEqual([id, ref.ripple(id)]);
}

export interface Runs {
  ref: ImpactResult;
  fc: ForecastResult;
  out: Map<ID, ID[]>;
}

/** 基準の作り（computeImpact）で数える */
export function refRun(doc: DocData, sid: ID | null = null): Runs {
  const idx = buildIndex(doc);
  const fc = computeForecast(doc, idx.out, sid && doc.scenarios[sid] ? sid : null);
  return { ref: computeImpact(doc, idx.out, fc, sid), fc, out: idx.out };
}

/** エンジンで数える（新しいエンジン。map があれば地図の列から形を作る） */
export function engRun(doc: DocData, sid: ID | null = null, map?: Omit<MapDoc, "doc">): { eng: ImpactResult; engine: ImpactEngine } {
  const engine = new ImpactEngine();
  if (map) engine.useMap({ ...map, doc });
  const idx = buildIndex(doc);
  const s = sid && doc.scenarios[sid] ? sid : null;
  let fc: ForecastResult | null = null;
  const eng = engine.result({ doc, sid: s, out: () => idx.out, reach: () => ((fc ??= computeForecast(doc, idx.out, s)), { version: 0, of: (id) => fc!.reach.get(id)?.p ?? 0 }) });
  return { eng, engine };
}
