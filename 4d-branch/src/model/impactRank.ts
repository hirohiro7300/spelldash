// 3 年の分かれ道の概要の順位（設計: docs/DESIGN.md §4.7）
//   「3 年でやる価値が大きい手」: 手の種類ごとに、その種類の手を 3 年間ずっと使わない場合と比べた差（おすすめの選び方の 3 年の稼ぎ）
//   「避けたい手」: 出てくる所の差（今のままと比べた差）を、その道で来る見込みで重み付けした平均が −15 万円以下の種類
//   「この先の大事な判断」: 今日より後の判断を、おすすめの選び方で来る見込み × 一番良い手と今のままの差の順に
// 手の種類の名前は、同梱の地図の入口の meta.fams（{ 種類: 名前 }。scripts/impact/world.json の familyLabels）

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

/**
 * 種類ごとの出てくる所（今のままを除く。その道で来る見込みの高い順、同じなら差の大きい順）。
 * 選択肢の詳細（AltInfo）は作らず、差だけを読む（8 万枚の地図で 3.5 万の手: 作業メモ perf-2）
 */
function instancesByFam(doc: DocData, imp: ImpactResult, fc: ForecastResult | null): Map<string, Array<{ id: ID; p: number; delta: number | null }>> {
  const by = new Map<string, Array<{ id: ID; p: number; delta: number | null }>>();
  for (const id of imp.altIds()) {
    if (imp.isBaseOf(id)) continue;
    const f = famOf(doc.nodes[id]);
    if (!f) continue;
    const list = by.get(f) ?? [];
    list.push({ id, p: fc?.reach.get(id)?.p ?? 0, delta: imp.deltaOf(id) });
    by.set(f, list);
  }
  for (const list of by.values()) list.sort((x, y) => y.p - x.p || (y.delta ?? -Infinity) - (x.delta ?? -Infinity) || (x.id < y.id ? -1 : 1));
  return by;
}

export interface WorthRanking {
  worth: WorthRow[];
  avoid: AvoidRow[];
}

/** 種類ごとの出てくる所（結果ごとに 1 度だけ数える。やる価値と避けたい手で使い回す） */
const byFamCache = new WeakMap<ImpactResult, Map<string, Array<{ id: ID; p: number; delta: number | null }>>>();
function cachedByFam(doc: DocData, imp: ImpactResult, fc: ForecastResult | null): Map<string, Array<{ id: ID; p: number; delta: number | null }>> {
  let by = byFamCache.get(imp);
  if (!by) byFamCache.set(imp, (by = instancesByFam(doc, imp, fc)));
  return by;
}

/** 「避けたい手」（出てくる所の差の平均。やる価値と違って、逆にたどる計算は要らない） */
function avoidRows(doc: DocData, imp: ImpactResult, fc: ForecastResult | null): AvoidRow[] {
  if (!imp.active) return [];
  const by = cachedByFam(doc, imp, fc);
  const avoid: AvoidRow[] = [];
  for (const fam of imp.families()) {
    const list = by.get(fam);
    if (!list?.length) continue;
    let sw = 0;
    let sv = 0;
    for (const x of list) if (x.delta !== null && x.p > 0) (sw += x.p), (sv += x.p * x.delta);
    if (sw > 0 && sv / sw <= IMPACT_AVOID_MEAN) {
      const ids = list.map((x) => x.id);
      avoid.push({ fam, mean: sv / sw, instances: ids, project: projectOf(doc, ids) });
    }
  }
  avoid.sort((a, b) => a.mean - b.mean || (a.fam < b.fam ? -1 : 1));
  return avoid.slice(0, 3);
}

/** 「3 年でやる価値が大きい手」と「避けたい手」 */
export function worthRanking(doc: DocData, imp: ImpactResult, fc: ForecastResult | null): WorthRanking {
  if (!imp.active) return { worth: [], avoid: [] };
  const by = cachedByFam(doc, imp, fc);
  const worth: WorthRow[] = [];
  for (const fam of imp.families()) {
    const list = by.get(fam);
    if (!list?.length) continue;
    const ids = list.map((x) => x.id);
    const k = imp.never(fam).k;
    if (k !== null && Number.isFinite(k)) worth.push({ fam, k, instances: ids, project: projectOf(doc, ids) });
  }
  worth.sort((a, b) => b.k - a.k || (a.fam < b.fam ? -1 : 1));
  return { worth, avoid: cachedAvoidRanking(doc, imp, fc) };
}

const avoidCache = new WeakMap<ImpactResult, AvoidRow[]>();

/** 「避けたい手」を結果ごとに覚えておく（やる価値の逆にたどる計算を待たずに出せる） */
export function cachedAvoidRanking(doc: DocData, imp: ImpactResult, fc: ForecastResult | null): AvoidRow[] {
  let hit = avoidCache.get(imp);
  if (!hit) avoidCache.set(imp, (hit = avoidRows(doc, imp, fc)));
  return hit;
}

const worthCache = new WeakMap<ImpactResult, WorthRanking>();
/** 「やる価値」（never(fam).k: 1 回の逆にたどる計算）を数え終えた手の種類（結果ごと） */
const worthDone = new WeakMap<ImpactResult, Set<string>>();

/** 「3 年でやる価値が大きい手」の数が揃っているか（揃うまでは、手が空いたときに worthStep で 1 種類ずつ数える） */
export function worthReady(imp: ImpactResult): boolean {
  if (!imp.active || worthCache.has(imp)) return true;
  const done = worthDone.get(imp);
  return !!done && imp.families().every((f) => done.has(f));
}

/** まだ数えていない手の種類を 1 つ数える（逆にたどる計算 1 回）。全部揃ったら true */
export function worthStep(imp: ImpactResult): boolean {
  if (worthReady(imp)) return true;
  let done = worthDone.get(imp);
  if (!done) worthDone.set(imp, (done = new Set()));
  for (const f of imp.families()) {
    if (done.has(f)) continue;
    void imp.never(f).k;
    done.add(f);
    break;
  }
  return worthReady(imp);
}

/**
 * worthRanking を 3 年の影響の結果（imp）ごとに覚えておく（同梱の地図で 20 ms ほど。概要を作り直すたびには計算しない）。
 * 使う物（手の種類・プロジェクト・つなぎ方・見込み %・方針）が変わると imp が新しくなるので、imp が同じなら結果も同じ。
 * doc・fc は imp を計算したときの物（題名だけの変更で新しくなった物でもよい）を渡す
 */
export function cachedWorthRanking(doc: DocData, imp: ImpactResult, fc: ForecastResult | null): WorthRanking {
  let hit = worthCache.get(imp);
  if (!hit) {
    hit = worthRanking(doc, imp, fc);
    worthCache.set(imp, hit);
  }
  return hit;
}

/** 入口の meta.fams（手の種類 → 名前）。無ければ空 */
function famLabelsOf(doc: DocData, rootId: ID | null): Record<string, unknown> {
  const fams = rootId ? doc.nodes[rootId]?.meta?.fams : undefined;
  return fams && typeof fams === "object" && !Array.isArray(fams) ? (fams as Record<string, unknown>) : {};
}

/**
 * 手の種類の名前: 入口（今日）の meta.fams にあればその名前、無ければ出てくる所の最初のカードの題名、それも無ければ種類の ID
 * （名前を持たない古い版の地図・自分で足した種類でも、何か読める物を出す）
 */
export function famLabel(doc: DocData, rootId: ID | null, fam: string, instances: readonly ID[]): string {
  const named = famLabelsOf(doc, rootId)[fam];
  if (typeof named === "string" && named.trim()) return named.trim();
  const title = instances.length ? doc.nodes[instances[0]!]?.title.trim() : "";
  return title || fam;
}

/** 手の種類の名前を入口の meta.fams から出したか（false なら、最初のカードの題名か ID） */
export function hasFamLabel(doc: DocData, rootId: ID | null, fam: string): boolean {
  const named = famLabelsOf(doc, rootId)[fam];
  return typeof named === "string" && !!named.trim();
}

/** 「この先の大事な判断」（今日の判断を除く。おすすめの選び方で来る見込み × 差の大きい順） */
export function keyDecisions(imp: ImpactResult, limit = 8): KeyDecision[] {
  if (!imp.active) return [];
  const rows: KeyDecision[] = [];
  // 判断の詳細（DecisionInfo）は作らず、来る見込みと差だけを読む
  for (const id of imp.decisionIds()) {
    if (id === imp.root) continue;
    const p = imp.pPi.get(id) ?? 0;
    if (!(p > 0)) continue;
    const stakes = imp.stakesOf(id);
    if (stakes === null || !(stakes >= 1)) continue;
    rows.push({ id, p, stakes, best: imp.bestOf(id) });
  }
  rows.sort((a, b) => b.p * b.stakes - a.p * a.stakes || (a.id < b.id ? -1 : 1));
  return rows.slice(0, limit);
}
