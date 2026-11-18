// 3 年の分かれ道の概要の順位（設計: docs/DESIGN.md §4.7）
//   「3 年でやる価値が大きい手」: 手の種類ごとに、その種類の手を 3 年間ずっと使わない場合と比べた差（おすすめの選び方の 3 年の稼ぎ）
//   「避けたい手」: 出てくる所の差（今のままと比べた差）を、その道で来る見込みで重み付けした平均が −15 万円以下の種類
//   「この先の大事な判断」: 今日より後の判断を、おすすめの選び方で来る見込み × 一番良い手と今のままの差の順に

import type { ForecastResult } from "./forecast";
import type { ImpactResult } from "./impact";
import type { DocData, GNode, ID } from "./types";

/** 避けたい手に入れる平均の差（万円） */
export const IMPACT_AVOID_MEAN = -15;

export interface WorthRow {
  /** 手の種類（meta.fam） */
  fam: string;
  /** その種類の手をずっと使わない場合と比べた、おすすめの選び方の 3 年の稼ぎの差（万円） */
  k: number;
  /** 地図の中でその種類の手が出てくる所（その道で来る見込みの高い順） */
  instances: ID[];
  /** 仕事の領域（プロジェクト）。どれか 1 つに決まらなければ null */
  project: ID | null;
}

export interface AvoidRow {
  fam: string;
  /** 出てくる所の差の平均（その道で来る見込みで重み付け。万円） */
  mean: number;
  instances: ID[];
  project: ID | null;
}

export interface KeyDecision {
  /** 判断のノード */
  id: ID;
  /** おすすめの選び方でここへ来る見込み */
  p: number;
  /** 一番良い手と今のままの差（万円） */
  stakes: number;
  /** 一番良い手 */
  best: ID | null;
}

/** 手の種類（meta.fam、無ければ meta.ak） */
export function famOf(n: GNode | undefined): string {
  if (!n) return "";
  const f = n.meta?.fam;
  if (typeof f === "string" && f) return f;
  const k = n.meta?.ak;
  return typeof k === "string" ? k : "";
}

/** 出てくる所のプロジェクト（1 つだけ持つ物の多数決） */
function projectOf(doc: DocData, ids: ID[]): ID | null {
  const count = new Map<ID, number>();
  for (const id of ids) {
    const ps = doc.nodes[id]?.projectIds ?? [];
    if (ps.length === 1) count.set(ps[0]!, (count.get(ps[0]!) ?? 0) + 1);
  }
  let best: ID | null = null;
  let n = 0;
  for (const [p, c] of count) if (c > n || (c === n && best !== null && p < best)) (best = p), (n = c);
  return best;
}

/** 種類ごとの出てくる所（今のままを除く。その道で来る見込みの高い順、同じなら差の大きい順） */
function instancesByFam(doc: DocData, imp: ImpactResult, fc: ForecastResult | null): Map<string, Array<{ id: ID; p: number; delta: number | null }>> {
  const by = new Map<string, Array<{ id: ID; p: number; delta: number | null }>>();
  for (const [id, a] of imp.alt) {
    if (a.isBase) continue;
    const f = famOf(doc.nodes[id]);
    if (!f) continue;
    const list = by.get(f) ?? [];
    list.push({ id, p: fc?.reach.get(id)?.p ?? 0, delta: a.delta });
    by.set(f, list);
  }
  for (const list of by.values()) list.sort((x, y) => y.p - x.p || (y.delta ?? -Infinity) - (x.delta ?? -Infinity) || (x.id < y.id ? -1 : 1));
  return by;
}

/** 「3 年でやる価値が大きい手」と「避けたい手」 */
export function worthRanking(doc: DocData, imp: ImpactResult, fc: ForecastResult | null): { worth: WorthRow[]; avoid: AvoidRow[] } {
  if (!imp.active) return { worth: [], avoid: [] };
  const by = instancesByFam(doc, imp, fc);
  const worth: WorthRow[] = [];
  const avoid: AvoidRow[] = [];
  for (const fam of imp.families()) {
    const list = by.get(fam);
    if (!list?.length) continue;
    const ids = list.map((x) => x.id);
    const project = projectOf(doc, ids);
    const k = imp.never(fam).k;
    if (k !== null && Number.isFinite(k)) worth.push({ fam, k, instances: ids, project });
    let sw = 0;
    let sv = 0;
    for (const x of list) if (x.delta !== null && x.p > 0) (sw += x.p), (sv += x.p * x.delta);
    if (sw > 0 && sv / sw <= IMPACT_AVOID_MEAN) avoid.push({ fam, mean: sv / sw, instances: ids, project });
  }
  worth.sort((a, b) => b.k - a.k || (a.fam < b.fam ? -1 : 1));
  avoid.sort((a, b) => a.mean - b.mean || (a.fam < b.fam ? -1 : 1));
  return { worth, avoid: avoid.slice(0, 3) };
}

/** 「この先の大事な判断」（今日の判断を除く。おすすめの選び方で来る見込み × 差の大きい順） */
export function keyDecisions(imp: ImpactResult, limit = 8): KeyDecision[] {
  if (!imp.active) return [];
  const rows: KeyDecision[] = [];
  for (const [id, d] of imp.decision) {
    if (id === imp.root) continue;
    const p = imp.pPi.get(id) ?? 0;
    const stakes = d.stakes;
    if (!(p > 0) || stakes === null || !(stakes >= 1)) continue;
    rows.push({ id, p, stakes, best: d.best });
  }
  rows.sort((a, b) => b.p * b.stakes - a.p * a.stakes || (a.id < b.id ? -1 : 1));
  return rows.slice(0, limit);
}
