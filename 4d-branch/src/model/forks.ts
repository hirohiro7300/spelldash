// 「3 年の分かれ道」（未来の道筋 v2）の範囲と分かれ道の種類。設計: docs/DESIGN.md §4.7
// 範囲 = 入口（meta.forecastRoot かつ meta.impact.v === 2）から「進む」「条件付き」の線でたどれるノード。
// 範囲の外（v1 の未来の道筋・ふつうの地図）は今までどおりに扱う。
//
// 範囲の中の分かれ道は 2 種類:
//   判断（decision）: 自分で選ぶ。線に見込み（%）は付けない。選ぶ手で計算する
//   結果（chance）  : 運で決まる。線の見込み（%）の割合で分ける
// 出る線が 1 本なら「通過」（pass）、無ければ「行き先」（leaf）。

import type { DocData, GEdge, GNode, ID } from "./types";

export type ForkKind = "decision" | "chance" | "pass" | "leaf";

/** 道として流れる線（進む・条件付き） */
export const isFlowEdge = (e: GEdge): boolean => e.relation === "leads" || e.relation === "condition";

export interface ImpactConfig {
  v: 2;
  /** 何か月先まで数えるか（36） */
  horizon: number;
  /** 年収（額面・万円）。無ければ仮の値で計算する */
  annual?: number;
  /** 36 か月の後に何か月分を足すか（0 か 12） */
  tail?: number;
}

/** 入口の meta.impact（v2 のときだけ） */
export function impactConfigOf(n: GNode | undefined): ImpactConfig | null {
  const v = n?.meta?.impact as Partial<ImpactConfig> | undefined;
  if (!v || typeof v !== "object" || v.v !== 2) return null;
  const horizon = typeof v.horizon === "number" && Number.isFinite(v.horizon) && v.horizon > 0 ? Math.min(240, v.horizon) : 36;
  const out: ImpactConfig = { v: 2, horizon };
  if (typeof v.annual === "number" && Number.isFinite(v.annual) && v.annual > 0) out.annual = v.annual;
  if (typeof v.tail === "number" && Number.isFinite(v.tail) && v.tail >= 0) out.tail = Math.min(120, v.tail);
  return out;
}

export const isImpactRoot = (n: GNode | undefined): boolean => !!n && n.meta?.forecastRoot === true && impactConfigOf(n) !== null;

/**
 * 数字と概要を出す入口を 1 つに決める（今日の複製や、別の地図の追加の読み込みで入口が 2 つ以上あるとき）。
 * 先へ進む線のある入口 → 早く作った物 → ID の順。入口が無ければ null。out が無ければ線をなめて調べる
 */
export function primaryImpactRoot(doc: DocData, out?: Map<ID, ID[]>): ID | null {
  let flowFrom: Set<ID> | null = null;
  const hasFlow = (id: ID): boolean => {
    if (out) return flowOuts(doc, out, id).length > 0;
    if (!flowFrom) {
      flowFrom = new Set<ID>();
      for (const e of Object.values(doc.edges)) if (isFlowEdge(e) && e.source !== e.target && doc.nodes[e.target]) flowFrom.add(e.source);
    }
    return flowFrom.has(id);
  };
  let best: ID | null = null;
  let bestFlow = false;
  for (const id of Object.keys(doc.nodes)) {
    const n = doc.nodes[id]!;
    if (!isImpactRoot(n)) continue;
    const f = hasFlow(id);
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

/** 線の見込み（%）。数でなければ null */
export function probOf(e: GEdge): number | null {
  const v = e.meta?.prob;
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null;
}

/** 範囲の中で、そのノードから出る道の線（先のノードがあるもの） */
export function flowOuts(doc: DocData, out: Map<ID, ID[]>, id: ID): GEdge[] {
  const list: GEdge[] = [];
  for (const eid of out.get(id) ?? []) {
    const e = doc.edges[eid];
    if (e && isFlowEdge(e) && e.source !== e.target && doc.nodes[e.target]) list.push(e);
  }
  return list;
}

/** v2 の入口からたどれるノード（入口を含む）。入口が無ければ空 */
export function impactScope(doc: DocData, out: Map<ID, ID[]>): Set<ID> {
  const scope = new Set<ID>();
  const stack: ID[] = [];
  for (const id in doc.nodes) if (isImpactRoot(doc.nodes[id])) (scope.add(id), stack.push(id));
  while (stack.length) {
    const id = stack.pop()!;
    for (const e of flowOuts(doc, out, id)) {
      if (scope.has(e.target)) continue;
      scope.add(e.target);
      stack.push(e.target);
    }
  }
  return scope;
}

/**
 * 範囲の中のノードの分かれ道の種類。outs はそのノードから出る道の線（シナリオで絞らない）。
 * meta.fork があればそれに従う。無ければ、線に % があれば結果、目標・分岐で 2 本以上なら判断、行動・結果で 2 本以上なら結果
 */
export function forkKindOf(n: GNode, outs: GEdge[]): ForkKind {
  if (outs.length === 0) return "leaf";
  const f = n.meta?.fork;
  if (f === "decision") return "decision";
  if (f === "chance") return "chance";
  if (outs.some((e) => probOf(e) !== null)) return "chance";
  if (outs.length >= 2) return n.type === "goal" || n.type === "branch" ? "decision" : "chance";
  return "pass";
}

/**
 * 結果の分かれ道の線ごとの割合（合計 1）。見込みの無い線には残りを等分する。どの線にも無ければ等分
 */
export function chanceWeights(edges: GEdge[]): number[] {
  if (!edges.length) return [];
  const known = edges.map(probOf);
  if (known.every((v) => v === null)) return edges.map(() => 1 / edges.length);
  const sumKnown = known.reduce<number>((n, v) => n + (v ?? 0), 0);
  const unknown = known.filter((v) => v === null).length;
  const share = unknown ? Math.max(0, 100 - sumKnown) / unknown : 0;
  const raw = known.map((v) => v ?? share);
  const total = raw.reduce((n, v) => n + v, 0);
  return total > 0 ? raw.map((v) => v / total) : edges.map(() => 1 / edges.length);
}
