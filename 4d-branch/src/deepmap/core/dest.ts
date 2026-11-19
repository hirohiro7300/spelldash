// 2029 年 11 月の行き先を種類ごとにまとめる（設計: 作業メモ SPEC v1 §5.7。作業メモ user-14・truth-3）
// 種類 = 仕事・会社の答え・Pro・顧客の数の段・有料の人の段。どの種類も、見込みの合計と「N 通りの道」（行き先の数）と、
// 見込みの大きい順の行き先（押すと 1 つずつ見られる）を持つ。今日から（おすすめの選び方）でも、今日の手ごとでも出せる。
// まとめた行き先は mix があればその多い方・真ん中の数で、無ければ代表の状態で分ける（その割合を summary に出す）。
// いくつかの場合をまとめた行き先（顧客の数に幅 band がある・顧客の数が整数でない）は、顧客の数を丸めない:
//   幅が 1 社（0〜1 社など）なら、平均から多い方の見込み（cl − 下の数）で 2 つの種類に分け、
//   幅が 2 社以上なら「顧客 0〜2 社」の種類にする（その割合を merged に出す）。1 枚の行き先の名前も幅で書く。

import type { ImpactSt } from "../../demo/impact";
import type { MapBand, MapMix } from "../mapData";
import { F_SUM, ROLE_A } from "./compile";
import { assertFresh, type Analysis } from "./passes";

export interface DestClass {
  /** 仕事: 会社員 e・週 4 日 p・独立 i */
  j: ImpactSt["j"];
  /** 会社の届け出の答え（? まだ・a 全部可・s SpellDash だけ・n どちらも不可） */
  pm: ImpactSt["pm"];
  /** Pro を出している */
  pro: 0 | 1;
  /** 広告運用の顧客の段（0〜4。4 は 4 社以上）。幅のある行き先は下の段 */
  cl: number;
  /** 顧客の段の上（幅の無い行き先は cl と同じ） */
  clHi: number;
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
  /** 行き先の数（N 通りの道。2 つの種類に分けた行き先は両方で数える） */
  count: number;
  /** 行き先（見込みの大きい順） */
  ends: number[];
  /** 3 年の合計の平均・一番小さい・一番大きい */
  mean: number;
  lo: number;
  hi: number;
  /** そのうちまとめた行き先（標準の続きの見積もり）の見込みの割合（0〜1） */
  summary: number;
  /** そのうち、いくつかの場合をまとめた行き先（顧客の数に幅がある）の見込みの割合（0〜1） */
  merged: number;
}

const JOB: Record<ImpactSt["j"], string> = { e: "会社員", p: "週 4 日", i: "独立" };
const PERM: Record<ImpactSt["pm"], string> = { "?": "届け出はまだ", a: "全部可", s: "SpellDash だけ可", n: "どちらも不可" };

/** 顧客の数の書き方を決める物（いくつかの場合をまとめた結果は幅 band の顧客の数を使う） */
function clBand(st: ImpactSt, band: MapBand | null | undefined): [number, number] | null {
  const b = band?.cl;
  if (b && Number.isFinite(b[0]) && Number.isFinite(b[1])) return [Math.min(b[0], b[1]), Math.max(b[0], b[1])];
  const c = Number.isFinite(st.cl) ? st.cl : 0;
  // 幅の書いていない端数（開発用の木）: 前後の整数の 2 つの場合とみる
  if (Math.abs(c - Math.round(c)) > 0.05) return [Math.floor(c), Math.ceil(c)];
  return null;
}

/** 1 枚の行き先の種類（行き先のカードの名前に使う。顧客の数に幅があれば幅のまま） */
export function destClassOf(st: ImpactSt, mix: MapMix | null, band: MapBand | null = null): DestClass {
  if (mix) {
    const j = argmax(mix.j as Record<string, number>, st.j) as ImpactSt["j"];
    const pm = argmax(mix.pm as Record<string, number>, st.pm) as ImpactSt["pm"];
    const pro: 0 | 1 = mix.pro >= 0.5 ? 1 : 0;
    const c = clBin(mix.cl[1]);
    return { j, pm, pro, cl: c, clHi: c, pu: pro ? puBin(mix.pu[1]) : -1 };
  }
  const pro: 0 | 1 = st.pro ? 1 : 0;
  const pu = pro ? puBin(st.pu) : -1;
  const b = clBand(st, band);
  if (b) return { j: st.j, pm: st.pm, pro, cl: clBin(b[0]), clHi: clBin(b[1]), pu };
  const c = clBin(st.cl);
  return { j: st.j, pm: st.pm, pro, cl: c, clHi: c, pu };
}

/**
 * 行き先を種類に分ける割合（合計 1）。幅が 1 社の行き先は 2 つの種類（多い方の見込み = 平均 − 下の数）に分ける。
 * まとめた行き先（mix）・幅の無い行き先・幅が 2 社以上の行き先は 1 つ
 */
export function destParts(st: ImpactSt, mix: MapMix | null, band: MapBand | null = null): Array<{ cls: DestClass; w: number; merged: boolean }> {
  const one = destClassOf(st, mix, band);
  // 段が 1 つに決まる行き先（幅が 0・4 社以上どうし）は、そのまま
  if (mix || one.cl === one.clHi) return [{ cls: one, w: 1, merged: false }];
  const b = clBand(st, band)!;
  if (b[1] - b[0] !== 1) return [{ cls: one, w: 1, merged: true }];
  const pHi = Math.max(0, Math.min(1, (Number.isFinite(st.cl) ? st.cl : b[0]) - b[0]));
  const out: Array<{ cls: DestClass; w: number; merged: boolean }> = [];
  if (pHi < 1) out.push({ cls: { ...one, cl: one.cl, clHi: one.cl }, w: 1 - pHi, merged: true });
  if (pHi > 0) out.push({ cls: { ...one, cl: one.clHi, clHi: one.clHi }, w: pHi, merged: true });
  return out;
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
  return `${c.j}|${c.pm}|${c.pro}|${c.cl}|${c.clHi}|${c.pu}`;
}

/** 顧客の数の言葉（「副業なし」「顧客 2 社」「顧客 0〜1 社」「顧客 4 社以上」） */
function clText(c: DestClass): string {
  if (c.cl !== c.clHi) return c.clHi >= 4 ? `顧客 ${c.cl} 社以上` : `顧客 ${c.cl}〜${c.clHi} 社`;
  return c.cl === 0 ? (c.j === "i" ? "顧客 0 社" : "副業なし") : c.cl >= 4 ? "顧客 4 社以上" : `顧客 ${c.cl} 社`;
}

/**
 * まとめた行き先（標準の続きの見積もり）の種類の言葉: 中身の幅（mix）から、9 割がそろう事実だけを言い切り、ほかは「…の道が多い」
 * 「届け出の答えは道で違う」と幅で言う（行き先のカードの本文・数の行と食い違わない。作業メモ reader-6・SPEC §4.2）。
 * 行き先を種類にまとめる（destinations）のは今までどおり destClassOf（多い方・真ん中の数）
 */
export function mixLabel(mix: MapMix): string {
  const SURE = 0.9;
  const parts: string[] = [];
  const jobs = (["e", "p", "i"] as const).map((k) => [k, mix.j[k]] as const).sort((x, y) => y[1] - x[1]);
  const [jt, jp] = jobs[0]!;
  parts.push(jp >= SURE ? JOB[jt] : `${JOB[jt]}の道が多い`);
  // 独立した道は会社の答えに関わらない
  if (mix.j.i < SURE) {
    const pms = (["?", "a", "s", "n"] as const).map((k) => [k, mix.pm[k]] as const).sort((x, y) => y[1] - x[1]);
    parts.push(pms[0]![1] >= SURE ? PERM[pms[0]![0]] : "届け出の答えは道で違う");
  }
  const lo = Math.max(0, Math.round(mix.cl[0]));
  const hi = Math.max(0, Math.round(mix.cl[2]));
  parts.push(hi <= 0 ? (jt === "i" && jp >= SURE ? "顧客 0 社" : "副業なし") : lo === hi ? `顧客 ${lo} 社` : `顧客 ${lo}〜${hi} 社`);
  if (mix.pro >= SURE) {
    const a = Math.max(0, Math.round(mix.pu[0]));
    const b = Math.max(0, Math.round(mix.pu[2]));
    parts.push(a === b ? `有料 ${a} 人` : `有料 ${a}〜${b} 人`);
  } else if (mix.pro <= 0.1) parts.push("Pro なし");
  else parts.push(mix.pro >= 0.5 ? "Pro ありの道が多い" : "Pro ありの道は少ない");
  return parts.join("・");
}

export function destLabel(c: DestClass): string {
  const parts = [JOB[c.j] ?? c.j];
  // 独立した後は会社の答えは関わらない
  if (c.j !== "i") parts.push(PERM[c.pm] ?? "");
  parts.push(clText(c));
  parts.push(c.pro ? (c.pu <= 0 ? "有料 30 人未満" : c.pu === 1 ? "有料 30〜99 人" : "有料 100 人以上") : "Pro なし");
  return parts.filter((x) => x).join("・");
}

/** 行き先を種類ごとにまとめる。f が今日の手ならその手を選んだ後（おすすめの選び方）、null なら今日から */
export function destinations(a: Analysis, f: number | null = null): DestGroup[] {
  assertFresh(a);
  const cm = a.cm;
  if (f !== null && (cm.parent[f] !== 0 || cm.role[f] !== ROLE_A)) throw new RangeError(`今日の手ではありません: ${f}`);
  const { size, kidOff, flags } = cm;
  const map = cm.map;
  const { acc } = a.money;
  const { V } = a.pi;
  const wt = f === null ? a.pi.reach : a.pi.reachIn;
  const lo = f ?? 0;
  const hi = lo + size[lo]!;
  const groups = new Map<string, DestGroup & { members: Array<[number, number]>; tw: number; sumMass: number; mergedMass: number }>();
  let total = 0;
  for (let i = lo; i < hi; i++) {
    if (kidOff[i] !== kidOff[i + 1]) continue;
    const m = wt[i]!;
    if (!(m > 0)) continue;
    // 子の無いカードはどれも行き先として数える（36 か月目より前に止まった道も。分布と同じ）
    const isSum = (flags[i]! & F_SUM) !== 0;
    const tot = acc[i]! + V[i]!;
    for (const part of destParts(map.st(i), isSum ? map.mix(i) : null, map.band(i))) {
      const key = destKey(part.cls);
      const mm = m * part.w;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { key, cls: part.cls, label: destLabel(part.cls), share: 0, count: 0, ends: [], mean: 0, lo: Infinity, hi: -Infinity, summary: 0, merged: 0, members: [], tw: 0, sumMass: 0, mergedMass: 0 }));
      g.share += mm;
      g.count++;
      g.members.push([i, mm]);
      g.tw += mm * tot;
      if (isSum) g.sumMass += mm;
      if (part.merged) g.mergedMass += mm;
      if (tot < g.lo) g.lo = tot;
      if (tot > g.hi) g.hi = tot;
    }
    total += m;
  }
  const out: DestGroup[] = [];
  for (const g of groups.values()) {
    g.members.sort((x, y) => y[1] - x[1] || x[0] - y[0]);
    out.push({
      key: g.key,
      cls: g.cls,
      label: g.label,
      share: total > 0 ? g.share / total : 0,
      count: g.count,
      ends: g.members.map((x) => x[0]),
      mean: g.share > 0 ? g.tw / g.share : 0,
      lo: g.lo,
      hi: g.hi,
      summary: g.share > 0 ? g.sumMass / g.share : 0,
      merged: g.share > 0 ? g.mergedMass / g.share : 0,
    });
  }
  out.sort((x, y) => y.share - x.share || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  return out;
}
