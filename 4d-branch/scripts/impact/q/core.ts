// 3 か月ごとの地図の計算の芯: 結果のまとめ方（3 段階）・代表の状態・粗い表（手の順位を決めるだけ）・その表の通りに続けた正確な見積もり。
// R1 の試作（model-tree/core.ts）を移した物で、計算は同じ（足し算の順まで同じにしてある。並べ替えずに使うこと）。
// 粗い表は最初に通った正確な状態をそのマスの代表にするので、表を引く順で値が変わる。生成（gen.ts）は試作と同じ順で引く

import { groupOutcomes, type Outcome } from "../group";
import { round2, round4, runRate, type Sample, type St, type Vec3 } from "../sim";
import { driverQ, feasibleQ, simQ } from "./quarter";
import { H, NSTAGE, type WorldQ } from "./world";

/** 結果のまとめ方: split 元の地図と同じ（3 個まで。次の手が全部違えば 4 個）・fact 数（遊ぶ人・有料・顧客）は平均し事実だけ分ける・lean fact に加えて昇格の結果も平均する */
export type Mode = "split" | "fact" | "lean";

/** 代表の状態（group.ts と同じ決まり: 分類は一番多い物・数は平均・印は半分以上が持つ物） */
export function repState(items: Array<{ x: St; w: number }>): St {
  const total = items.reduce((a, s) => a + s.w, 0);
  const mean = (f: (x: St) => number) => items.reduce((a, s) => a + f(s.x) * s.w, 0) / total;
  const mode = <T>(f: (x: St) => T): T => {
    const m = new Map<T, number>();
    for (const s of items) m.set(f(s.x), (m.get(f(s.x)) ?? 0) + s.w);
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  };
  const flags = new Map<string, number>();
  for (const s of items) for (const f of s.x.fl) flags.set(f, (flags.get(f) ?? 0) + s.w);
  return {
    j: mode((x) => x.j),
    pm: mode((x) => x.pm),
    pro: mode((x) => x.pro),
    mau: round2(mean((x) => x.mau)),
    pu: round2(mean((x) => x.pu)),
    seats: Math.round(mean((x) => x.seats)),
    cl: round4(mean((x) => x.cl)),
    fee: round2(mean((x) => (x.cl > 0 ? x.fee : 0)) / Math.max(1e-9, mean((x) => (x.cl > 0 ? 1 : 0))) || 0),
    sal: round4(mean((x) => x.sal)),
    cv: round4(mean((x) => x.cv)),
    fl: [...flags.entries()]
      .filter(([, v]) => v / total >= 0.5)
      .map(([f]) => f)
      .sort(),
  };
}

function meanR(items: Array<{ r: Vec3; w: number }>): Vec3 {
  const t = items.reduce((a, s) => a + s.w, 0);
  return [round4(items.reduce((a, s) => a + s.r[0] * s.w, 0) / t), round2(items.reduce((a, s) => a + s.r[1] * s.w, 0) / t), round2(items.reduce((a, s) => a + s.r[2] * s.w, 0) / t)];
}

/** 全部の数え上げを 1 つにした結果（「どの場合もこの道」） */
export function collapsed(samples: Sample[], mEnd: number): Outcome {
  const st = repState(samples.map((s) => ({ x: s.x, w: s.w })));
  return { id: "all", p: 100, w: 1, st, r: meanR(samples), lab: "—", short: "", line: "（どの場合もこの道）", ln: { metric: "none", at: mEnd, lo: null, hi: null, cat: "all" }, sig: "", local: 0 };
}

/** その手の分かれ方が数（遊ぶ人・有料・顧客）か、分け方が無いか（予算が足りなければ平均してよい）。事実（会社の答えなど）は平均しない */
export const isNumeric = (kind: string, s0: St): boolean => {
  const d = driverQ(kind, s0);
  return d.t === "num" || d.t === "none";
};

/** 3 か月の数え上げの回数（報告用） */
export const simCount = { n: 0 };

/** 手の 3 か月の結果（見込みは整数 %） */
export function quarterOutcomes(w: WorldQ, s0: St, kind: string, m0: number, mode: Mode, S: number): Outcome[] {
  simCount.n++;
  const samples = simQ(w, s0, kind, m0);
  if ((mode === "fact" || mode === "lean") && isNumeric(kind, s0)) return [collapsed(samples, m0 + 3)];
  if (mode === "lean" && kind === "fc_push") return [collapsed(samples, m0 + 3)];
  return groupOutcomes(w, kind === "fc_switch2" ? "fc_switch" : kind, driverQ(kind, s0), s0, m0, 3, samples, 3, S);
}

/** 稼ぎ [給与の月数, 広告運用 万円, SpellDash 万円] を月給 S で万円にする */
export const Wsum = (r: Vec3, S: number): number => S * r[0] + r[1] + r[2];
export const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale3 = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];

const lb2 = (v: number) => (v < 0.5 ? -9 : Math.floor(Math.log2(v)));

/** 粗い表のマス: sal は給与の刻み、sd は SpellDash の数もマスに入れるか、corr はマスの代表から正確な状態へ 1 次の補正をするか */
export interface Grid {
  sal: number;
  sd: boolean;
  corr: boolean;
}

/** 粗い表の鍵（段・仕事・答え・Pro・印・顧客・給与・月額。sd なら SpellDash の数の桁） */
export function coarseKey(s: number, x: St, g: Grid): string {
  const f = x.fl;
  const fl = (f.includes("switched") ? "w" : "") + (f.includes("js") ? "j" : "") + (f.includes("jx") ? "x" : "") + (f.includes("pq") ? "q" : "") + (f.includes("scope") ? "c" : "") + (f.includes("portfolio") ? "o" : "") + (g.sd && f.includes("pilot") ? "p" : "");
  const sd = g.sd ? `${Math.min(6, Math.max(0, lb2(x.mau / 40)))}|${Math.min(7, lb2(x.pu))}|${x.cv > 1.15 ? 1 : 0}|${Math.min(3, x.seats / 40)}` : "";
  return `${s}|${x.j}|${x.pm}|${x.pro}|${fl}|${Math.round(x.cl)}|${Math.round(x.sal / g.sal)}|${Math.round(x.fee)}|${sd}`;
}

export interface DPEntry {
  /** マスの代表の状態での、この段の初めから 36 か月目までの値（生成の年収の万円） */
  v: number;
  /** 手の順位（1 段先の値の大きい順。同じなら今のまま） */
  rank: Array<[string, number]>;
  /** マスの代表（最初に通った正確な状態） */
  rep: St;
}

/** 粗い表（手の順位を決めるだけ。書き出す数には使わない）: 引かれたマスだけ作り、そのマスでできる手を全部 1 段先まで正確に計算する */
export class CoarseDP {
  memo = new Map<string, DPEntry>();
  evals = 0;
  constructor(
    public w: WorldQ,
    public S: number,
    public kinds: string[],
    public grid: Grid,
  ) {}
  entry(s: number, x: St): DPEntry | null {
    if (s >= NSTAGE) return null;
    const key = coarseKey(s, x, this.grid);
    const hit = this.memo.get(key);
    if (hit) return hit;
    this.evals++;
    const m0 = 3 * s;
    const rank: Array<[string, number]> = [];
    for (const k of this.kinds) {
      if (!feasibleQ(this.w, x, k, m0)) continue;
      let q = 0;
      for (const o of quarterOutcomes(this.w, x, k, m0, "fact", this.S)) q += o.w * (Wsum(o.r, this.S) + this.value(s + 1, o.st));
      rank.push([k, q]);
    }
    rank.sort((a, b) => b[1] - a[1] || Number(b[0] === "keep") - Number(a[0] === "keep"));
    const e: DPEntry = { v: rank[0]![1], rank, rep: x };
    this.memo.set(key, e);
    return e;
  }
  value(s: number, x: St): number {
    const e = this.entry(s, x);
    return e ? e.v + this.corr(s, x, e.rep) : 0;
  }
  /** マスの代表から正確な状態への 1 次の補正（給与・顧客・有料会員） */
  corr(s: number, x: St, rep: St): number {
    if (!this.grid.corr) return 0;
    const n = H - 3 * s;
    const c = this.w.constants;
    let raise = 0;
    for (let t = 3 * s + 1; t <= H; t++) raise += Math.pow(1 + c.aprilRaise, c.aprilMonths.filter((a) => a > 3 * s && a <= t).length);
    const salF = x.j === "e" ? 1 : x.j === "p" ? c.partFactor : 0;
    const keep = (1 - Math.pow(1 - c.churn, n)) / c.churn;
    const fee = x.cl > 0.05 ? x.fee : x.j === "i" ? c.indFee : c.sideFee;
    return this.S * salF * raise * (x.sal - rep.sal) + fee * keep * (x.cl - rep.cl) + c.net * n * (x.pro ? x.pu - rep.pu : 0);
  }
  /** 正確な状態での表の手: そのマスの順位で、今できる一番上の手 */
  move(s: number, x: St): string {
    const e = this.entry(s, x)!;
    for (const [k] of e.rank) if (feasibleQ(this.w, x, k, 3 * s)) return k;
    return "keep";
  }
}

export interface Roll {
  /** 3s か月目から 36 か月目までの稼ぎ [給与の月数, 広告運用 万円, SpellDash 万円] */
  v: Vec3;
  /** 36 か月目の月の稼ぎの見込み */
  rr: Vec3;
  /** 36 か月目の代表の状態 */
  st: St;
}

const exactKey = (s: number, x: St) => `${s}|${x.j}|${x.pm}|${x.pro}|${x.mau}|${x.pu}|${x.seats}|${x.cl}|${x.fee}|${x.sal}|${x.cv}|${x.fl.join("+")}`;

/**
 * 粗い表の手で 36 か月目まで続けた正確な見積もり（正確な状態ごとに覚える）。見込みはアプリと同じ整数 % で重みを付けるので、
 * 同じ選び方ならアプリの値と一致する。mode はその手の結果のまとめ方（生成の、事実だけ分けるまとめ方と同じにする）
 */
export class Rollouts {
  memo = new Map<string, Roll>();
  steps = 0;
  constructor(
    public w: WorldQ,
    public S: number,
    public dp: CoarseDP,
    public mode: (kind: string, x: St) => Mode = () => "lean",
  ) {}
  roll(s: number, x: St): Roll {
    if (s >= NSTAGE) return { v: [0, 0, 0], rr: runRate(this.w, x), st: x };
    const key = exactKey(s, x);
    const hit = this.memo.get(key);
    if (hit) return hit;
    this.steps++;
    const k = this.dp.move(s, x);
    const outs = quarterOutcomes(this.w, x, k, 3 * s, this.mode(k, x), this.S);
    let v: Vec3 = [0, 0, 0];
    let rr: Vec3 = [0, 0, 0];
    const ends: Array<{ x: St; w: number }> = [];
    for (const o of outs) {
      const c = this.roll(s + 1, o.st);
      const q = o.p / 100;
      v = add3(v, scale3(add3(o.r, c.v), q));
      rr = add3(rr, scale3(c.rr, q));
      ends.push({ x: c.st, w: q });
    }
    const res: Roll = { v, rr, st: ends.length === 1 ? ends[0]!.x : repState(ends) };
    this.memo.set(key, res);
    return res;
  }
}
