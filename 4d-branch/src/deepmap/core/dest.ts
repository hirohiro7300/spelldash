// 2029 年 11 月の行き先を種類ごとにまとめる（設計: 作業メモ SPEC v1 §5.7。作業メモ user-14）
// 種類 = 仕事・会社の答え・Pro・顧客の数の段・有料の人の段。どの種類も、見込みの合計と「N 通りの道」（行き先の数）と、
// 見込みの大きい順の行き先（押すと 1 つずつ見られる）を持つ。今日から（おすすめの選び方）でも、今日の手ごとでも出せる。
// まとめた行き先は mix があればその多い方・真ん中の数で、無ければ代表の状態で分ける（その割合を summary に出す）。

import type { ImpactSt } from "../../demo/impact";
import type { MapMix } from "../mapData";
import { F_SUM, ROLE_A } from "./compile";
import type { Analysis } from "./passes";

export interface DestClass {
  /** 仕事: 会社員 e・週 4 日 p・独立 i */
  j: ImpactSt["j"];
  /** 会社の届け出の答え（? まだ・a 全部可・s SpellDash だけ・n どちらも不可） */
  pm: ImpactSt["pm"];
  /** Pro を出している */
  pro: 0 | 1;
  /** 広告運用の顧客の段（0〜4。4 は 4 社以上） */
  cl: number;
  /** 有料の人の段（−1 Pro なし・0 30 人未満・1 30〜99 人・2 100 人以上） */
  pu: number;
}

export interface DestGroup {
  key: string;
  cls: DestClass;
  /** 画面に出す名前（例: 会社員・SpellDash だけ可・副業なし・有料 30〜99 人） */
  label: string;
  /** 見込みの合計（0〜1） */
  share: number;
  /** 行き先の数（N 通りの道） */
  count: number;
  /** 行き先（見込みの大きい順） */
  ends: number[];
  /** 3 年の合計の平均・一番小さい・一番大きい */
  mean: number;
  lo: number;
  hi: number;
  /** そのうちまとめた行き先（標準の続きの見積もり）の見込みの割合（0〜1） */
  summary: number;
}

const JOB: Record<ImpactSt["j"], string> = { e: "会社員", p: "週 4 日", i: "独立" };
const PERM: Record<ImpactSt["pm"], string> = { "?": "届け出はまだ", a: "全部可", s: "SpellDash だけ可", n: "どちらも不可" };

export function destClassOf(st: ImpactSt, mix: MapMix | null): DestClass {
  if (mix) {
    const j = argmax(mix.j as Record<string, number>, st.j) as ImpactSt["j"];
    const pm = argmax(mix.pm as Record<string, number>, st.pm) as ImpactSt["pm"];
    const pro: 0 | 1 = mix.pro >= 0.5 ? 1 : 0;
    return { j, pm, pro, cl: clBin(mix.cl[1]), pu: pro ? puBin(mix.pu[1]) : -1 };
  }
  const pro: 0 | 1 = st.pro ? 1 : 0;
  return { j: st.j, pm: st.pm, pro, cl: clBin(st.cl), pu: pro ? puBin(st.pu) : -1 };
}

function argmax(x: Record<string, number>, dflt: string): string {
  let best = dflt;
  let bv = -Infinity;
  for (const [k, v] of Object.entries(x)) if (v > bv) (bv = v), (best = k);
  return best;
}

function clBin(cl: number): number {
  const c = Math.round(Number.isFinite(cl) ? cl : 0);
  return Math.max(0, Math.min(4, c));
}

function puBin(pu: number): number {
  return pu < 30 ? 0 : pu < 100 ? 1 : 2;
}

export function destKey(c: DestClass): string {
  return `${c.j}|${c.pm}|${c.pro}|${c.cl}|${c.pu}`;
}

export function destLabel(c: DestClass): string {
  const parts = [JOB[c.j] ?? c.j];
  // 独立した後は会社の答えは関わらない
  if (c.j !== "i") parts.push(PERM[c.pm] ?? "");
  parts.push(c.cl === 0 ? (c.j === "i" ? "顧客 0 社" : "副業なし") : c.cl >= 4 ? "顧客 4 社以上" : `顧客 ${c.cl} 社`);
  parts.push(c.pro ? (c.pu <= 0 ? "有料 30 人未満" : c.pu === 1 ? "有料 30〜99 人" : "有料 100 人以上") : "Pro なし");
  return parts.filter((x) => x).join("・");
}

/** 行き先を種類ごとにまとめる。f が今日の手ならその手を選んだ後（おすすめの選び方）、null なら今日から */
export function destinations(a: Analysis, f: number | null = null): DestGroup[] {
  const cm = a.cm;
  if (f !== null && (cm.parent[f] !== 0 || cm.role[f] !== ROLE_A)) throw new RangeError(`今日の手ではありません: ${f}`);
  const { size, kidOff, flags } = cm;
  const map = cm.map;
  const { acc } = a.money;
  const { V } = a.pi;
  const wt = f === null ? a.pi.reach : a.pi.reachIn;
  const lo = f ?? 0;
  const hi = lo + size[lo]!;
  const groups = new Map<string, DestGroup & { members: Array<[number, number]>; tw: number; sumMass: number }>();
  let total = 0;
  for (let i = lo; i < hi; i++) {
    if (kidOff[i] !== kidOff[i + 1]) continue;
    const m = wt[i]!;
    if (!(m > 0)) continue;
    // 子の無いカードはどれも行き先として数える（36 か月目より前に止まった道も。分布と同じ）
    const isSum = (flags[i]! & F_SUM) !== 0;
    const cls = destClassOf(map.st(i), isSum ? map.mix(i) : null);
    const key = destKey(cls);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, cls, label: destLabel(cls), share: 0, count: 0, ends: [], mean: 0, lo: Infinity, hi: -Infinity, summary: 0, members: [], tw: 0, sumMass: 0 }));
    const tot = acc[i]! + V[i]!;
    g.share += m;
    g.count++;
    g.members.push([i, m]);
    g.tw += m * tot;
    if (isSum) g.sumMass += m;
    if (tot < g.lo) g.lo = tot;
    if (tot > g.hi) g.hi = tot;
    total += m;
  }
  const out: DestGroup[] = [];
  for (const g of groups.values()) {
    g.members.sort((x, y) => y[1] - x[1] || x[0] - y[0]);
    out.push({ key: g.key, cls: g.cls, label: g.label, share: total > 0 ? g.share / total : 0, count: g.count, ends: g.members.map((x) => x[0]), mean: g.share > 0 ? g.tw / g.share : 0, lo: g.lo, hi: g.hi, summary: g.share > 0 ? g.sumMass / g.share : 0 });
  }
  out.sort((x, y) => y.share - x.share || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  return out;
}
