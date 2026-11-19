// 進め方（今日の手ごと）: 3 か月ごとに、おすすめになる手とその見込みの割合と、そうなる理由
// （設計: 作業メモ SPEC v1 §5.3。作業メモ user-2 (b)・user-7・truth-5）例: 「2027 年 5 月: 転職活動を続ける 72%（2027 年 2 月に転職せずなら）」
// 割合はその月に判断がある見込みの中で合計 100%。まとめた手に入って判断の無い見込みは viaSummary に分けて出す。
// 理由（when）は、その月の手どうしを一番よく分ける、これまでの結果（直前とは限らない。何期前でも）か、前の手:
//   その月の判断の 1 つ 1 つについて、k 期前の結果（手の種類・結果の名前）を並べ、どの k・どちらの分け方が手を一番よく分けるかを
//   「その鍵の中で一番多い手の見込み」の合計で比べる（同じくらいなら新しい方、次に手だけの方）。手が 1 つの月・何も分けない月は無し。

import { F_STUB, F_SUM, kindKey, quarterOf, ROLE_A, ROLE_S, type CompiledMap } from "./compile";
import { assertFresh, type Analysis } from "./passes";

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
  /** 直前の結果（その判断に来た結果）。見込みの多い順 */
  conds: PlanCond[];
  /** そうなる理由（その月の手どうしを分ける結果か前の手）。手が 1 つの月・何も分けない月は null */
  when: PlanWhen | null;
  /** 見込みの一番大きい判断（そこから道の画面を開く） */
  top: number;
  /** その判断で選ぶ手 */
  topOption: number;
}

export interface PlanWhenItem {
  /** その結果を出した手の種類（鍵） */
  fromKind: string;
  /** その手を選んだ月（0 か月目から） */
  mFrom: number;
  /** 結果の名前（見込みの多い順。結果が 1 つの手の結果は入れない）。手だけで分けたとき（byMove）は空 */
  labels: string[];
  /** その手の結果を全部含む（結果を問わず「〜の後」。結果が 1 つの手も） */
  all: boolean;
  /** この手の見込みの中の割合（0〜1） */
  share: number;
}

export interface PlanWhen {
  /** 分けた結果の月（0 か月目から） */
  m: number;
  /** 何期前の結果か（0 = この判断の直前の結果） */
  back: number;
  /** 前の手の種類だけで分けた（「〜の後」） */
  byMove: boolean;
  items: PlanWhenItem[];
  /** 出した物で覆う、この手の見込みの割合（0〜1。残りは「など」） */
  cover: number;
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
  /** その手を選ぶ判断と見込み */
  states: Array<[number, number]>;
}

/** 今日の手 f の進め方。conds は理由をいくつまで出すか */
export function planView(a: Analysis, f: number, opts: { conds?: number } = {}): PlanQuarter[] {
  assertFresh(a);
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
      if (!g) groups.set(key, (g = { kind: kind[c]!, mass: 0, count: 0, stubMass: 0, top: i, topMass: -1, conds: new Map(), states: [] }));
      g.mass += m;
      g.count++;
      g.states.push([i, m]);
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
      moves: [{ kind: kindKey(cm, f), share: 1, mass: 1, count: 1, stub: flags[f]! & F_STUB ? 1 : 0, conds: [], when: null, top: 0, topOption: f }],
    },
  ];
  const byQ: Group[][] = Array.from({ length: Q }, () => []);
  for (const [key, g] of groups) byQ[Math.floor(key / K)]!.push(g);
  for (let q = 1; q < Q; q++) {
    const list = byQ[q]!;
    if (!list.length && !(via[q]! > 0)) continue;
    const al = alive[q]!;
    list.sort((x, y) => y.mass - x.mass || x.kind - y.kind);
    const whens = separate(cm, list);
    out.push({
      m: Math.min(H, q * 3),
      alive: al,
      viaSummary: via[q]!,
      moves: list.map((g, k) => ({
        kind: cm.kindNames[g.kind]!,
        share: al > 0 ? g.mass / al : 0,
        mass: g.mass,
        count: g.count,
        stub: g.mass > 0 ? g.stubMass / g.mass : 0,
        conds: [...g.conds.values()]
          .sort((x, y) => y.mass - x.mass || (x.label < y.label ? -1 : x.label > y.label ? 1 : 0))
          .slice(0, maxConds)
          .map((c) => ({ label: c.label, fromKind: c.fromKind, single: c.single, share: c.mass / g.mass })),
        when: whens[k] ?? null,
        top: g.top,
        topOption: pi[g.top]!,
      })),
    });
  }
  return out;
}

/** 分けたと言える、一番多い手の割合からの上積み */
const SEP_MIN = 0.05;
/** 同じくらいよく分けるとみなす差 */
const SEP_TIE = 0.01;
/** 理由に出す結果の、手の見込みの中の合計（これに届くまで。3 つまで） */
const SEP_COVER = 0.85;

/** 判断 i の k 期前の結果（0 = i 自身。i は親の手の結果）。無ければ −1 */
function backChain(cm: CompiledMap, i: number): number[] {
  const out = [i];
  let x = i;
  for (;;) {
    const o = cm.parent[x]!;
    const d = o >= 0 ? cm.parent[o]! : -1;
    if (d < 0 || cm.role[d] !== ROLE_S) break;
    out.push(d);
    x = d;
  }
  return out;
}

/** その月の手（list）ごとの理由。手が 2 つ以上で、これまでの結果か前の手で分けられる月だけ */
function separate(cm: CompiledMap, list: readonly Group[]): Array<PlanWhen | null> {
  if (list.length < 2) return list.map(() => null);
  const map = cm.map;
  const G = list.length;
  const chains = list.map((g) => g.states.map(([i]) => backChain(cm, i)));
  let total = 0;
  let top = 0;
  for (const g of list) {
    total += g.mass;
    top = Math.max(top, g.mass);
  }
  if (!(total > 0)) return list.map(() => null);
  const maxK = Math.max(0, ...chains.flatMap((cs) => cs.map((c) => c.length - 1)));
  /** 結果の名前（結果が 1 つの手の結果は ""） */
  const labelOf = (x: number): string => {
    const o = cm.parent[x]!;
    return cm.kidOff[o + 1]! - cm.kidOff[o]! >= 2 ? map.label(x) : "";
  };
  const keyOf = (x: number, byMove: boolean): string => {
    if (x < 0) return "\u0001";
    const from = kindKey(cm, cm.parent[x]!);
    return byMove ? from : `${from}\u0000${labelOf(x)}`;
  };
  // 鍵は先に番号にしておく（分け方ごとに文字をつながない）。ids[gi][si] = [k 期前の手の鍵, k 期前の手と結果の鍵] の並び
  const intern = new Map<string, number>();
  const idOf = (key: string): number => {
    let v = intern.get(key);
    if (v === undefined) intern.set(key, (v = intern.size));
    return v;
  };
  const ids = chains.map((cs) => cs.map((c) => c.map((x) => [idOf(keyOf(x, true)), idOf(keyOf(x, false))] as const)));
  const none = idOf(keyOf(-1, true));
  // 分け方ごとの「鍵の中で一番多い手の見込み」の合計
  const score = (k: number, byMove: boolean): number => {
    const per = new Float64Array(intern.size * G);
    list.forEach((g, gi) => {
      g.states.forEach(([, m], si) => {
        const id = ids[gi]![si]![k]?.[byMove ? 0 : 1] ?? none;
        per[id * G + gi] = per[id * G + gi]! + m;
      });
    });
    let s = 0;
    for (let id = 0; id < intern.size; id++) {
      let mx = 0;
      for (let gi = 0; gi < G; gi++) mx = Math.max(mx, per[id * G + gi]!);
      s += mx;
    }
    return s / total;
  };
  const cands: Array<{ k: number; byMove: boolean; s: number }> = [];
  for (let k = 0; k <= maxK; k++) for (const byMove of [true, false]) cands.push({ k, byMove, s: score(k, byMove) });
  const best = Math.max(...cands.map((c) => c.s));
  // 分けたと言えるのは、一番多い手の割合から 5 ポイント（残りが少なければ残りの半分）より上積みできたときだけ
  const base = top / total;
  if (best - base < Math.min(SEP_MIN, 0.5 * (1 - base)) - 1e-12) return list.map(() => null);
  const pick = cands.find((c) => c.s >= best - SEP_TIE)!;
  return list.map((g, gi) => {
    // この手の鍵（見込みの多い順）
    const keys = new Map<string, { from: string; mFrom: number; label: string; mass: number; node: number; sibs: Set<string> }>();
    g.states.forEach(([, m], si) => {
      const x = chains[gi]![si]![pick.k] ?? -1;
      if (x < 0) return;
      const key = keyOf(x, pick.byMove);
      const o = cm.parent[x]!;
      let e = keys.get(key);
      if (!e) keys.set(key, (e = { from: kindKey(cm, o), mFrom: cm.month[o]!, label: labelOf(x), mass: 0, node: x, sibs: new Set() }));
      e.mass += m;
      // 分かれた手の結果の名前（結果を全部含むかを見る。結果が 1 つの手は数えない）
      if (cm.kidOff[o + 1]! - cm.kidOff[o]! >= 2) for (let s = cm.kidOff[o]!; s < cm.kidOff[o + 1]!; s++) e.sibs.add(map.label(cm.kids[s]!));
    });
    const sorted = [...keys.values()].sort((x, y) => y.mass - x.mass || (x.label < y.label ? -1 : x.label > y.label ? 1 : 0));
    const shown: typeof sorted = [];
    let cov = 0;
    for (const e of sorted) {
      if (shown.length >= 3 || cov >= SEP_COVER * g.mass) break;
      shown.push(e);
      cov += e.mass;
    }
    if (!shown.length) return null;
    // 手ごとにまとめる（結果の名前は見込みの多い順。その手の結果を全部含めば「結果を問わず」）
    const byFrom = new Map<string, PlanWhenItem & { sibs: Set<string> }>();
    for (const e of shown) {
      let it = byFrom.get(e.from);
      if (!it) byFrom.set(e.from, (it = { fromKind: e.from, mFrom: e.mFrom, labels: [], all: false, share: 0, sibs: new Set() }));
      if (!pick.byMove && e.label && !it.labels.includes(e.label)) it.labels.push(e.label);
      it.share += e.mass / g.mass;
      for (const l of e.sibs) it.sibs.add(l);
    }
    const items: PlanWhenItem[] = [...byFrom.values()].map(({ sibs, ...it }) => ({ ...it, all: pick.byMove || it.labels.length === 0 || [...sibs].every((l) => it.labels.includes(l)) }));
    return { m: cm.month[shown[0]!.node]!, back: pick.k, byMove: pick.byMove, items, cover: g.mass > 0 ? cov / g.mass : 0 };
  });
}
