// 進め方（今日の手ごと）: 3 か月ごとに、おすすめになる手とその見込みの割合と、そうなる理由（直前の結果）
// （設計: 作業メモ SPEC v1 §5.3。作業メモ user-2 (b)）例: 「2027 年 2 月: 昇格を狙う 80%（据え置きなら）／副業の 1 社目 20%」
// 割合はその月に判断がある見込みの中で合計 100%。まとめた手に入って判断の無い見込みは viaSummary に分けて出す。

import { F_STUB, F_SUM, kindKey, quarterOf, ROLE_A, ROLE_S } from "./compile";
import type { Analysis } from "./passes";

export interface PlanCond {
  /** 直前の結果の名前（その判断に来た理由） */
  label: string;
  /** その結果を出した手の種類（鍵） */
  fromKind: string;
  /** その結果が手のただ 1 つの結果（名前は「どの場合も」など。画面では「〜の後」と書く） */
  single: boolean;
  /** この手になる見込みの中の割合（0〜1） */
  share: number;
}

export interface PlanMove {
  /** おすすめになる手の種類（鍵） */
  kind: string;
  /** その月に判断がある見込みの中の割合（0〜1。その月の手で合計 1） */
  share: number;
  /** 今日の手を選んだ後の見込み（0〜1） */
  mass: number;
  /** その手がおすすめになる判断の数 */
  count: number;
  /** そのうち、まとめた手（標準の続き）が選ばれている割合（0〜1。ふつう 0） */
  stub: number;
  /** そうなる理由（直前の結果）。見込みの多い順 */
  conds: PlanCond[];
  /** 見込みの一番大きい判断（そこから道の画面を開く） */
  top: number;
  /** その判断で選ぶ手 */
  topOption: number;
}

export interface PlanQuarter {
  /** 判断の月（0 か月目から） */
  m: number;
  /** その月に判断がある見込み（今日の手を選んだ後。0〜1） */
  alive: number;
  /** まとめた手に入っていて、この月の判断が無い見込み（0〜1） */
  viaSummary: number;
  moves: PlanMove[];
}

interface Group {
  kind: number;
  mass: number;
  count: number;
  stubMass: number;
  top: number;
  topMass: number;
  conds: Map<string, { label: string; fromKind: string; single: boolean; mass: number }>;
}

/** 今日の手 f の進め方。conds は理由をいくつまで出すか */
export function planView(a: Analysis, f: number, opts: { conds?: number } = {}): PlanQuarter[] {
  const cm = a.cm;
  if (cm.parent[f] !== 0 || cm.role[f] !== ROLE_A) throw new RangeError(`今日の手ではありません: ${f}`);
  const maxConds = opts.conds ?? 3;
  const { size, role, month, kind, parent, flags, kidOff, H } = cm;
  const map = cm.map;
  const { reachIn, pi } = a.pi;
  const Q = quarterOf(H) + 1;
  const K = Math.max(1, cm.kindNames.length);
  const groups = new Map<number, Group>();
  const alive = new Float64Array(Q);
  const via = new Float64Array(Q);
  const hi = f + size[f]!;
  for (let i = f + 1; i < hi; i++) {
    const m = reachIn[i]!;
    if (!(m > 0)) continue;
    const r = role[i]!;
    if (r === ROLE_S) {
      const c = pi[i]!;
      if (c < 0) continue;
      const q = Math.min(Q - 1, quarterOf(month[i]!));
      alive[q] = alive[q]! + m;
      const key = q * K + kind[c]!;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { kind: kind[c]!, mass: 0, count: 0, stubMass: 0, top: i, topMass: -1, conds: new Map() }));
      g.mass += m;
      g.count++;
      if (flags[c]! & F_STUB) g.stubMass += m;
      if (m > g.topMass) (g.top = i), (g.topMass = m);
      const label = map.label(i);
      const from = parent[i]!;
      const fromKind = kindKey(cm, from);
      const ck = `${fromKind}\u0000${label}`;
      const cond = g.conds.get(ck);
      if (cond) cond.mass += m;
      else g.conds.set(ck, { label, fromKind, single: kidOff[from + 1]! - kidOff[from]! === 1, mass: m });
    } else if (kidOff[i] === kidOff[i + 1] && flags[i]! & F_SUM) {
      const from = quarterOf(month[parent[i]!]!);
      const q = Math.min(Q - 1, quarterOf(month[i]!));
      for (let k = from + 1; k < q; k++) via[k] = via[k]! + m;
    }
  }
  const out: PlanQuarter[] = [
    {
      m: 0,
      alive: 1,
      viaSummary: 0,
      moves: [{ kind: kindKey(cm, f), share: 1, mass: 1, count: 1, stub: flags[f]! & F_STUB ? 1 : 0, conds: [], top: 0, topOption: f }],
    },
  ];
  const byQ: Group[][] = Array.from({ length: Q }, () => []);
  for (const [key, g] of groups) byQ[Math.floor(key / K)]!.push(g);
  for (let q = 1; q < Q; q++) {
    const list = byQ[q]!;
    if (!list.length && !(via[q]! > 0)) continue;
    const al = alive[q]!;
    list.sort((x, y) => y.mass - x.mass || x.kind - y.kind);
    out.push({
      m: Math.min(H, q * 3),
      alive: al,
      viaSummary: via[q]!,
      moves: list.map((g) => ({
        kind: cm.kindNames[g.kind]!,
        share: al > 0 ? g.mass / al : 0,
        mass: g.mass,
        count: g.count,
        stub: g.mass > 0 ? g.stubMass / g.mass : 0,
        conds: [...g.conds.values()]
          .sort((x, y) => y.mass - x.mass || (x.label < y.label ? -1 : x.label > y.label ? 1 : 0))
          .slice(0, maxConds)
          .map((c) => ({ label: c.label, fromKind: c.fromKind, single: c.single, share: c.mass / g.mass })),
        top: g.top,
        topOption: pi[g.top]!,
      })),
    });
  }
  return out;
}
