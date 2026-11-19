// 3 か月ごと 12 段の地図を、最初の手ごとの予算（分かれ道の数）で作る。設計: 作業メモ SPEC v1 §2、R1 の報告 §6
// R1 の試作（model-tree/gen.ts）を移した物で、計算も作る順も同じ（粗い表は引く順で値が変わるので、順を変えないこと）。
// 1. 最初の手の 3 か月を元の地図と同じまとめ方で分け、その結果（次の判断）を、そこへ来る見込みの大きい順に取り出す
// 2. 判断では候補の手を正確に見積もり（3 か月 + 粗い表の通りに続けた見積もり）、一番良い手だけを広げる。
//    ほかに見せる手（今のまま・別の領域・避けたい手）は「まとめた手」: 3 か月の結果と、36 か月目のまとめた行き先だけ
// 3. 予算が残っていれば数の結果も分け（split）、足りなければ事実だけ（fact）、さらに足りなければ昇格の結果も平均する（lean）
// 4. 予算の合わせ込み: 分かれ道の数が目標の ±2% に入るまで、内側の予算を変えて作り直す（8 回まで）
// 一貫性（報告 §6.4 の決まり 1〜4）: 広げた手はいつもアプリの選ぶ一番良い手になり、おすすめの道はまとめた手に入らない

import type { MapRole, MapWhy } from "../../../src/deepmap/mapData";
import type { Outcome } from "../group";
import { runRate, type St, type Vec3 } from "../sim";
import { add3, CoarseDP, quarterOutcomes, Rollouts, Wsum, type Mode, type Roll } from "./core";
import { driverQ, feasibleQ } from "./quarter";
import { H, NSTAGE, type WorldQ } from "./world";

export interface QNode {
  key: string;
  /** 今日 r・手 a・3 か月ごとの状態 s・36 か月目の行き先 e */
  role: MapRole;
  /** 判断・結果・行き先はその月。手は始める月 */
  m: number;
  st: St;
  /** 判断の段（0..11。行き先は 12） */
  stage: number;
  kind?: string;
  out?: Outcome;
  /** この結果・行き先への線の稼ぎ [給与の月数, 広告運用 万円, SpellDash 万円]（まとめた行き先: その 3 か月 + 続きの見積もり） */
  r?: Vec3;
  /** 行き先の月の稼ぎ（まとめた行き先: 36 か月目の見込み） */
  rr?: Vec3;
  kids: QNode[];
  parent: QNode | null;
  /** その最初の手を選び、後はおすすめの手を選んだときに、ここへ来る見込み（取り出す順） */
  pPath: number;
  /** 手がカードの並びにある訳（menu は今日の決まった 10 手） */
  why?: MapWhy | "menu";
  /** まとめた手（子はまとめた行き先だけ） */
  stub?: boolean;
  /** まとめた行き先 */
  sumEnd?: boolean;
  /** ずっと今のままの道（今のまま も広げる） */
  chain?: boolean;
  /** おすすめの道の上 */
  onPi?: boolean;
  /** 数の結果も分けた判断 */
  split?: boolean;
  /** この判断の値が、その状態の続きの見積もりをどこまで下回ってよいか（上の判断の余裕。決まり 3） */
  allow?: number;
  /** アプリと同じ後ろからの値（rollbackApp が入れる） */
  V: number;
  /** 手の見積もり（3 か月 + 続きの見積もり） */
  Q?: number;
}

export interface Params {
  /** 最初の手ごとの分かれ道の数 */
  B: number;
  /** 今日の後の判断で見せる手の数（今のまま・一番良い手・別の領域・避けたい手）。altsBy[段] があればそちら */
  maxAlts: number;
  altsBy?: number[];
  /** まとめた手の結果のまとめ方 */
  stubMode: Mode;
  /** 顧客の数（営業の結果）を事実として必ず分ける */
  factCl: boolean;
  /** 粗い表の上から何個を正確に見積もるか */
  topN: number;
  /** 避けたい手: 今のままとの差がこれ以下（万円） */
  warn: number;
  /** ずっと今のままの道（おすすめの道でない所）の取り出す見込みに掛ける数 */
  chainDiscount: number;
}

export const DEFAULTS: Params = { B: 2000, maxAlts: 4, stubMode: "split", factCl: false, topN: 3, warn: -15, chainDiscount: 0.3 };

/** R1 が選んだ形（報告 §11）: 1 年目 4・2 年目 3・3 年目 2 の手を見せる */
export const R1_ALTS_BY: readonly number[] = [0, 4, 4, 4, 4, 3, 3, 3, 3, 2, 2, 2];

/** 鍵に使う手の短い名前（今日の後の手の鍵は「段 + 短い名前」。例 1fp・3fw2） */
export const CODE: Record<string, string> = {
  keep: "k",
  sd_permpro: "pp",
  sd_grow: "sg",
  sd_pilot: "sp",
  sd_pro: "pr",
  sd_school: "ss",
  sd_ads: "sa",
  sd_retain: "sr",
  fc_scope: "fs",
  fc_push: "fp",
  fc_switch: "fw",
  fc_switch2: "fw2",
  part: "pt",
  ad_portfolio: "ap",
  ad_perm: "ae",
  ad_permside: "as",
  ad_side: "ad",
  ad_more: "am",
  ind_quit: "iq",
  back_emp: "be",
};

/** 大きい順に取り出す山（同じ大きさの取り出す順もこの作りで決まる。作る順に効くので変えないこと） */
export class Heap<T> {
  a: Array<[number, T]> = [];
  push(p: number, v: T): void {
    const a = this.a;
    a.push([p, v]);
    let i = a.length - 1;
    while (i > 0) {
      const j = (i - 1) >> 1;
      if (a[j]![0] >= a[i]![0]) break;
      [a[i], a[j]] = [a[j]!, a[i]!];
      i = j;
    }
  }
  pop(): T | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l]![0] > a[m]![0]) m = l;
        if (r < a.length && a[r]![0] > a[m]![0]) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m]!, a[i]!];
        i = m;
      }
    }
    return top[1];
  }
  get size(): number {
    return this.a.length;
  }
}

export interface MoveStats {
  kind: string;
  /** 分かれ道（子が 2 つ以上のノード） */
  forks: number;
  nodes: number;
  /** 判断（子が 2 つ以上の状態） */
  decisions: number;
  options: number;
  stubs: number;
  ends: number;
  sumEnds: number;
  splitDecisions: number;
  maxDepth: number;
  /** 段ごとの状態の数（1..11 が 3..33 か月目） */
  byStage: number[];
  /** 分かれ道の内訳: 広げた手で結果が 2 つ以上・まとめた手で結果が 2 つ以上 */
  fe: number;
  fs: number;
  ms: number;
  /** 予算の合わせ込みの回数と、最後の内側の予算 */
  passes: number;
  Bint: number;
}

type Eval = { q: number; outs: Outcome[]; conts: Roll[] };

export class Gen {
  ro: Rollouts;
  kinds: string[];
  /** 正確な見積もりの回数・決まり 3 で分け方を落とした回数と、その時の不足（万円） */
  evals = 0;
  guards = 0;
  shortfalls: number[] = [];
  constructor(
    public w: WorldQ,
    public S: number,
    public dp: CoarseDP,
    public P: Params,
  ) {
    this.ro = new Rollouts(w, S, dp, (k, x) => this.modeFor(k, x, "lean"));
    this.kinds = Object.keys(w.kinds);
  }
  area(kind: string): string {
    return this.w.kinds[kind]!.area;
  }
  fam(kind: string): string {
    return this.w.kinds[kind]!.family;
  }
  isKeyFam(kind: string): boolean {
    return this.w.keyFamilies.includes(this.fam(kind));
  }
  modeFor(kind: string, x: St, level: Mode): Mode {
    if (level === "split") return "split";
    if (this.P.factCl) {
      const d = driverQ(kind, x);
      if (d.t === "num" && d.metric === "cl") return "split";
    }
    return level;
  }
  /** その手のここでの正確な見積もり: 3 か月の結果 + その後は粗い表の通りに続けた見積もり */
  evalMove(s: number, x: St, kind: string, mode: Mode): Eval {
    this.evals++;
    const outs = quarterOutcomes(this.w, x, kind, 3 * s, mode, this.S);
    let q = 0;
    const conts = outs.map((o) => this.ro.roll(s + 1, o.st));
    outs.forEach((o, i) => (q += (o.p / 100) * (Wsum(o.r, this.S) + Wsum(conts[i]!.v, this.S))));
    return { q, outs, conts };
  }

  /** 今日と最初の手（only があればその手だけ）。最初の手ごとに予算を合わせ込む */
  build(only?: string[]): { root: QNode; stats: MoveStats[] } {
    const w = this.w;
    const root: QNode = { key: "r", role: "r", m: 0, st: w.today, stage: 0, kids: [], parent: null, pPath: 1, V: 0, onPi: true };
    const stats: MoveStats[] = [];
    for (const k0 of w.rootMenu) {
      if (only && !only.includes(k0)) continue;
      const t0 = performance.now();
      // 事実はいつも分けるので、1 回目は目標を超えやすい。内側の予算を変えて作り直す
      let Bint = this.P.B;
      let a0 = this.firstMove(root, k0, Bint);
      let st = this.countSub(a0);
      let passes = 1;
      let lo = 0;
      let hi = Infinity;
      while (passes < 8 && Math.abs(st.forks - this.P.B) > this.P.B * 0.02) {
        if (st.forks > this.P.B) hi = Math.min(hi, Bint);
        else lo = Math.max(lo, Bint);
        const next = hi === Infinity ? Bint * (this.P.B / Math.max(1, st.forks)) * 1.02 : lo === 0 ? Bint * (this.P.B / Math.max(1, st.forks)) : (lo + hi) / 2;
        if (Math.abs(next - Bint) < 5) break;
        Bint = next;
        root.kids.splice(root.kids.indexOf(a0), 1);
        a0 = this.firstMove(root, k0, Bint);
        st = this.countSub(a0);
        passes++;
      }
      stats.push({ ...st, kind: k0, ms: performance.now() - t0, passes, Bint: Math.round(Bint) });
    }
    return { root, stats };
  }

  /** 最初の手 k0 の木（内側の予算 Bint）。今日の子の最後に足す */
  firstMove(root: QNode, k0: string, Bint: number): QNode {
    const w = this.w;
    const S = this.S;
    const a0: QNode = { key: `r.${k0}`, role: "a", m: 0, st: w.today, stage: 0, kind: k0, kids: [], parent: root, pPath: 1, V: 0, why: k0 === "keep" ? "keep" : "menu" };
    root.kids.push(a0);
    const heap = new Heap<QNode>();
    let forks = 0;
    let reserved = 0;
    // 数を分けない判断 1 つあたりの分かれ道の数（これまでの平均）。取り出す前の判断には、その先の段の数だけ取り置く
    let cBase = 2.0;
    let seen = 0;
    let sumC = 0;
    const resv = (s: number) => (NSTAGE - s) * cBase;
    const outs0 = quarterOutcomes(w, w.today, k0, 0, "split", S);
    if (outs0.length >= 2) forks++;
    for (const o of outs0) {
      const d: QNode = { key: `${a0.key}.${o.id}`, role: "s", m: 3, st: o.st, stage: 1, out: o, r: o.r, kids: [], parent: a0, pPath: o.p / 100, V: 0, chain: k0 === "keep", onPi: true };
      a0.kids.push(d);
      heap.push(d.pPath, d);
      reserved += resv(1);
    }
    while (heap.size) {
      const d = heap.pop()!;
      const s = d.stage;
      reserved -= resv(s);
      const avail = Bint - forks - reserved;
      // 数も分けると、その先の道 1 本分ずつ増える
      const extra = Math.max(0, NSTAGE - s - 1) * cBase + 1;
      const level: Mode = avail >= resv(s) + extra ? "split" : avail >= resv(s) ? "fact" : "lean";
      d.split = level === "split";
      const before = forks;
      const { children, bestSplitExtra } = this.decide(d, level);
      forks += this.forksAt(d);
      for (const c of children) {
        heap.push(c.pPath, c);
        reserved += resv(c.stage);
      }
      seen++;
      sumC += forks - before - bestSplitExtra;
      cBase = Math.max(1, sumC / seen);
    }
    return a0;
  }

  forksAt(d: QNode): number {
    let f = d.kids.length >= 2 ? 1 : 0;
    for (const a of d.kids) if (a.kids.length >= 2) f++;
    return f;
  }

  /** 判断 d で見せる手を選んで広げる。広げた手の結果（次の判断）を返す */
  decide(d: QNode, level0: Mode): { children: QNode[]; bestSplitExtra: number } {
    let level = level0;
    const w = this.w;
    const S = this.S;
    const s = d.stage;
    const m0 = 3 * s;
    const x = d.st;
    const feas = this.kinds.filter((k) => feasibleQ(w, x, k, m0));
    const rank = this.dp.entry(s, x)!.rank.filter(([k]) => feas.includes(k));
    // 正確に見積もる候補: 今のまま・表の上から topN・領域ごとの表の一番・主な種類で表の一番下
    const cand = new Set<string>(["keep"]);
    rank.slice(0, this.P.topN).forEach(([k]) => cand.add(k));
    for (const ar of ["sd", "fc", "ind"]) {
      const b = rank.find(([k]) => this.area(k) === ar);
      if (b) cand.add(b[0]);
    }
    const worst = [...rank].reverse().find(([k]) => this.isKeyFam(k));
    if (worst) cand.add(worst[0]);
    const evalAll = (lv: Mode) => {
      const m = new Map<string, Eval>();
      for (const k of cand) if (feas.includes(k)) m.set(k, this.evalMove(s, x, k, this.modeFor(k, x, lv)));
      return m;
    };
    const sortEv = (m: Map<string, Eval>) => [...m.entries()].sort((a, b) => b[1].q - a[1].q || Number(b[0] === "keep") - Number(a[0] === "keep"));
    let ev = evalAll(level);
    let order = sortEv(ev);
    // 決まり 2・3: 続きの見積もり（lean）より細かく分けるのは、その一番良い手がこの状態の続きの見積もり以上の時か、上の判断の余裕の内だけ。
    // 帰納的に、広げた木の値はいつもその状態の続きの見積もり以上になり、同じ見積もりのまとめた手に負けない
    const floor = Wsum(this.ro.roll(s, x).v, S);
    const allow = d.allow ?? Infinity;
    while (level !== "lean" && floor - order[0]![1].q > allow + 1e-9) {
      this.shortfalls.push(floor - order[0]![1].q);
      level = level === "split" ? "fact" : "lean";
      ev = evalAll(level);
      order = sortEv(ev);
      this.guards++;
    }
    const usedHere = Math.max(0, floor - order[0]![1].q);
    d.split = level === "split";
    const qKeep = ev.get("keep")!.q;
    const best = order[0]![0];
    const maxAlts = this.P.altsBy?.[s] ?? this.P.maxAlts;
    const shown: Array<[string, MapWhy]> = [["keep", "keep"]];
    if (best !== "keep") shown.push([best, "best"]);
    const area = order.find(([k]) => k !== best && k !== "keep" && this.area(k) !== this.area(best));
    if (area && shown.length < maxAlts) shown.push([area[0], "area"]);
    const avoid = [...order].reverse().find(([k, e]) => this.isKeyFam(k) && !shown.some(([z]) => z === k) && e.q - qKeep <= this.P.warn);
    if (avoid && shown.length < maxAlts) shown.push([avoid[0], "avoid"]);
    if (shown.length < 2 && order.length > 1) shown.push([order.find(([k]) => k !== "keep")![0], "area"]);
    // 広げる手: 一番良い手。ずっと今のままの道では今のままも（おすすめの道でなければ今のままだけ）
    const expand = new Set<string>([best]);
    if (d.chain) {
      expand.add("keep");
      if (!d.onPi && best !== "keep") expand.delete(best);
    }
    // まとめた手は、判断より粗いまとめ方で見せてよい（一番良い手を超えない時だけ。決まり 4）
    const disp = new Map<string, Eval>();
    for (const [k] of shown) {
      let e = ev.get(k)!;
      if (!expand.has(k) && this.P.stubMode !== "split" && level !== this.P.stubMode && level !== "lean") {
        const f = this.evalMove(s, x, k, this.modeFor(k, x, this.P.stubMode));
        if (f.q <= order[0]![1].q + 1e-9) e = f;
      }
      disp.set(k, e);
    }
    // この判断の余裕: 広げた一番良い手の値が、見せたまとめた手に負けずに下がってよい幅
    const stubQs = shown.filter(([k]) => !expand.has(k)).map(([k]) => disp.get(k)!.q);
    const margin = stubQs.length ? order[0]![1].q - Math.max(...stubQs) : Infinity;
    const childAllow = Math.min(margin, allow - usedHere);
    const children: QNode[] = [];
    let bestSplitExtra = 0;
    for (const [k, why] of shown) {
      const e = disp.get(k)!;
      const tok = s === 0 ? k : `${s}${CODE[k] ?? k}`;
      const a: QNode = { key: `${d.key}.${tok}`, role: "a", m: m0, st: x, stage: s, kind: k, kids: [], parent: d, pPath: d.pPath, V: 0, why, Q: e.q };
      d.kids.push(a);
      const isExp = expand.has(k);
      a.stub = !isExp && s + 1 < NSTAGE;
      if (isExp && k === best && e.outs.length >= 2 && level === "split") bestSplitExtra = e.outs.length - 1;
      e.outs.forEach((o, i) => {
        const key = `${a.key}.${o.id}`;
        if (s + 1 >= NSTAGE) {
          a.kids.push({ key, role: "e", m: H, st: o.st, stage: NSTAGE, out: o, r: o.r, rr: runRate(w, o.st), kids: [], parent: a, pPath: d.pPath * (o.p / 100), V: 0 });
          return;
        }
        if (!isExp) {
          const c = e.conts[i]!;
          a.kids.push({ key, role: "e", m: H, st: c.st, stage: NSTAGE, out: o, r: add3(o.r, c.v), rr: c.rr, kids: [], parent: a, pPath: d.pPath * (o.p / 100), V: 0, sumEnd: true });
          return;
        }
        const onPi = !!d.onPi && k === best;
        const chain = !!d.chain && k === "keep";
        const pPath = d.pPath * (o.p / 100) * (onPi || !chain ? 1 : this.P.chainDiscount);
        const c: QNode = { key, role: "s", m: m0 + 3, st: o.st, stage: s + 1, out: o, r: o.r, kids: [], parent: a, pPath, V: 0, chain, onPi, allow: k === best ? childAllow : 0 };
        a.kids.push(c);
        children.push(c);
      });
    }
    return { children, bestSplitExtra };
  }

  countSub(a0: QNode): Omit<MoveStats, "kind" | "ms" | "passes" | "Bint"> {
    let forks = 0;
    let nodes = 0;
    let decisions = 0;
    let options = 0;
    let stubs = 0;
    let ends = 0;
    let sumEnds = 0;
    let splitDecisions = 0;
    let maxDepth = 0;
    let fe = 0;
    let fs = 0;
    const byStage = new Array<number>(NSTAGE + 1).fill(0);
    const walk = (n: QNode, depth: number) => {
      nodes++;
      maxDepth = Math.max(maxDepth, depth);
      if (n.kids.length >= 2) forks++;
      if (n.kids.length >= 2 && n.role === "a") {
        if (n.stub) fs++;
        else fe++;
      }
      if (n.role === "s") {
        if (n.kids.length >= 2) decisions++;
        byStage[n.stage]!++;
        if (n.split) splitDecisions++;
      }
      if (n.role === "a") {
        options++;
        if (n.stub) stubs++;
      }
      if (n.role === "e") {
        ends++;
        if (n.sumEnd) sumEnds++;
      }
      for (const k of n.kids) walk(k, depth + 1);
    };
    walk(a0, 1);
    return { forks, nodes, decisions, options, stubs, ends, sumEnds, splitDecisions, maxDepth, byStage, fe, fs };
  }
}

/** 試作と同じ順で粗い表を引き始めてから作る（表の代表の状態は最初に通った状態なので、この順も結果の一部） */
export function generate(w: WorldQ, P: Params, only?: string[]): { root: QNode; stats: MoveStats[]; gen: Gen; dp: CoarseDP; msTable: number; msGen: number } {
  const S = w.annual / 12;
  const t0 = performance.now();
  const dp = new CoarseDP(w, S, Object.keys(w.kinds), { sal: 0.05, sd: false, corr: true });
  // 試作の入口（proto.ts）と同じ: 今日の状態の 3 か月後のマスから表を引き始める（今日の手が無い世界では引かない）
  if (w.rootMenu.length > 0) dp.value(1, w.today);
  const t1 = performance.now();
  const gen = new Gen(w, S, dp, P);
  const { root, stats } = gen.build(only);
  return { root, stats, gen, dp, msTable: t1 - t0, msGen: performance.now() - t1 };
}

/**
 * アプリと同じ後ろからの値（見込みは整数 %。判断は一番良い手。同じなら今のまま）を V に入れる。
 * keepOnly: どの判断でも今のまま（ずっと今のまま）の値
 */
export function rollbackApp(root: QNode, S: number, keepOnly = false): number {
  const visit = (n: QNode): number => {
    if (n.role === "e") return (n.V = 0);
    if (n.role === "a") {
      let v = 0;
      for (const c of n.kids) v += (c.out!.p / 100) * (Wsum(c.r!, S) + visit(c));
      return (n.V = v);
    }
    if (keepOnly) {
      const b = n.kids.find((a) => a.kind === "keep");
      if (b) {
        for (const a of n.kids) visit(a);
        return (n.V = b.V);
      }
    }
    let best = -Infinity;
    let bestNode: QNode | null = null;
    for (const a of n.kids) {
      const q = visit(a);
      if (q > best + 1e-9 || (Math.abs(q - best) <= 1e-9 && a.kind === "keep" && bestNode?.kind !== "keep")) {
        best = q;
        bestNode = a;
      }
    }
    return (n.V = best === -Infinity ? 0 : best);
  };
  return visit(root);
}

export interface Consistency {
  /** おすすめの道の上の判断の数と、まとめた手が広げた手に勝った数（一番大きい差 万円） */
  decisions: number;
  violations: number;
  worst: number;
  /** 最初の手ごとのおすすめの道: 通る判断の数と、まとめた手に入った数 */
  piDecisions: number;
  piIntoStub: number;
  /** 広げた一番良い手の木の値 − その手の見積もり（並べて小さい順） */
  improv: number[];
}

/** 一貫性の点検（rollbackApp の後に呼ぶ）: おすすめの道ではアプリの一番良い手がいつも広げた手で、おすすめの道はまとめた手に入らない */
export function consistencyOf(root: QNode): Consistency {
  let violations = 0;
  let worst = 0;
  let decisions = 0;
  const improv: number[] = [];
  const walk = (n: QNode) => {
    if (n.role === "s" && n.onPi) {
      const exp = n.kids.filter((a) => !a.stub);
      const best = n.kids.reduce((b, a) => (a.V > b.V + 1e-9 || (Math.abs(a.V - b.V) <= 1e-9 && a.kind === "keep") ? a : b));
      decisions++;
      if (best.stub) {
        violations++;
        const e = Math.max(...exp.map((a) => a.V));
        worst = Math.max(worst, best.V - e);
      }
      const b = n.kids.find((a) => a.why === "best" || (a.kind === "keep" && !n.kids.some((z) => z.why === "best")));
      if (b && !b.stub && b.Q !== undefined) improv.push(b.V - b.Q);
    }
    for (const k of n.kids) walk(k);
  };
  walk(root);
  let piDecisions = 0;
  let piIntoStub = 0;
  const piWalk = (n: QNode) => {
    if (n.role === "e") return;
    if (n.role === "a") {
      for (const c of n.kids) piWalk(c);
      return;
    }
    const best = n.kids.reduce((b, a) => (a.V > b.V + 1e-9 || (Math.abs(a.V - b.V) <= 1e-9 && a.kind === "keep" && b.kind !== "keep") ? a : b));
    if (n.role === "s") piDecisions++;
    if (best.stub) {
      piIntoStub++;
      return;
    }
    piWalk(best);
  };
  // 最初の手はどれも選んだ物として（地図は最初の手ごとに、その後のおすすめの続きを見せる）
  for (const a of root.kids) piWalk(a);
  improv.sort((a, b) => a - b);
  return { decisions, violations, worst, piDecisions, piIntoStub, improv };
}
