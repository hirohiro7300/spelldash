// 見込みの計算（未来の道筋の予測）。
// 予測の入口（meta.forecastRoot のノード。「今日」）を 100% として、「進む」「条件付き」の線に沿って確からしさを流す。
// 分岐ノードでは、出ていく線の見込み（edge.meta.prob、0〜100 の %）の割合で分ける。分岐でないノードは、出ていく先へそのまま渡す。
// 合流では足し合わせる（未来の道筋では、合流してくる道は別々の選択肢なので、同時には起きない）。
// シナリオを選んでいるときは、そのシナリオを通る線だけで流し、分岐ごとに割合を配り直す（＝そのシナリオを選んだ場合の見込み）。
//
// 「3 年の分かれ道」（入口の meta.impact.v === 2）の範囲の中だけは、分かれ道の種類（forks.ts）で流し方を決める:
//   結果（chance）は線の % で分け、判断（decision）と通過は出ていく先へそのまま渡す（＝その手を選んだ場合の見込み）。
//   シナリオ（方針）で絞るのは判断から出る線だけ（運の結果は方針では選べないので絞らない）。

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
  reach: Map<ID, Reach>;
  /** 行き先（その先へ進む線が無いノード）を見込みの高い順に */
  ends: ID[];
  /** 入口から最も長い道の歩数 */
  longest: number;
  /** 流した順（入口から。届いたノードだけ） */
  order: ID[];
  /** 「3 年の分かれ道」の範囲（v2 の入口が無ければ空） */
  impactScope: Set<ID>;
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
  const result: ForecastResult = { active: roots.length > 0, reach: new Map(), ends: [], longest: 0, order: [], impactScope: new Set() };
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
    result.reach.set(id, p);
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
