// 3 か月ごとの地図の計算の芯: 結果のまとめ方（3 段階）・代表の状態・粗い表（手の順位を決めるだけ）・その表の通りに続けた正確な見積もり。
// R1 の試作（model-tree/core.ts）から移した物（作る順・足し算の順は試作のまま。並べ替えずに使うこと）。3 か月の計算は ./sim.ts（P2 の前提）、
// 結果のまとめ方は ./group.ts（事実は平均しない・顧客は整数の社数の場合の混ざり）。
// 粗い表は最初に通った正確な状態をそのマスの代表にするので、表を引く順で値が変わる。生成（gen.ts）は決まった順で引き、
// 順を変えた時の幅は入口（main.ts）が測って報告する（見直し truth-2）。マスの代表から正確な状態への補正は、学校の席を席の値段で数える（truth-1）

import type { Line } from "../group";
import { round2, round4, type Vec3 } from "../sim";
import { groupOutcomesQ, repStateQ, type OutcomeQ } from "./group";
import { driverQ, feasibleQ, uses } from "./quarter";
import { bookKey, runRateQ, simQ, type QSample, type QSt } from "./sim";
import { H, NSTAGE, type WorldQ } from "./world";

/** 結果のまとめ方: split 元の地図と同じ（3 個まで。次の手が全部違えば 4 個）・fact 数（遊ぶ人・有料・顧客）は平均し事実だけ分ける・lean fact に加えて昇格の結果も平均する */
export type Mode = "split" | "fact" | "lean";

/** 代表の状態（分類は一番多い物・数は平均・印は半分以上が持つ物・顧客は場合の混ざり） */
export const repState = repStateQ;

function meanR(items: Array<{ r: Vec3; w: number }>): Vec3 {
  const t = items.reduce((a, s) => a + s.w, 0);
  return [round4(items.reduce((a, s) => a + s.r[0] * s.w, 0) / t), round2(items.reduce((a, s) => a + s.r[1] * s.w, 0) / t), round2(items.reduce((a, s) => a + s.r[2] * s.w, 0) / t)];
}

/** 全部の数え上げを 1 つにした結果（「どの場合もこの道」） */
export function collapsed(w: WorldQ, samples: QSample[], mEnd: number): OutcomeQ {
  const st = repStateQ(w, samples.map((s) => ({ x: s.x, w: s.w })));
  const ln: Line = { metric: "none", at: mEnd, lo: null, hi: null, cat: "all" };
  return { id: "all", p: 100, w: 1, st, r: meanR(samples), lab: "—", short: "", line: "（どの場合もこの道）", ln, sig: "", local: 0 };
}

/** その手の分かれ方が数（遊ぶ人・有料・顧客）か、分け方が無いか（予算が足りなければ平均してよい）。事実（会社の答えなど）は平均しない */
export const isNumeric = (kind: string, s0: QSt): boolean => {
  const d = driverQ(kind, s0);
  return d.t === "num" || d.t === "none";
};

/** 3 か月の数え上げの回数（報告用） */
export const simCount = { n: 0 };

/** 手の 3 か月の結果（見込みは整数 %）。fine なら事実の小さい組も分けたまま（./group.ts。予算の使い道 1） */
export function quarterOutcomes(w: WorldQ, s0: QSt, kind: string, m0: number, mode: Mode, S: number, fine = false): OutcomeQ[] {
  simCount.n++;
  const samples = simQ(w, s0, kind, m0);
  if ((mode === "fact" || mode === "lean") && isNumeric(kind, s0)) return [collapsed(w, samples, m0 + 3)];
  if (mode === "lean" && kind === "fc_push") return [collapsed(w, samples, m0 + 3)];
  return groupOutcomesQ(w, kind, driverQ(kind, s0), s0, m0, samples, 3, S, fine);
}

/**
 * 同じ 3 か月の結果を何度も数えないための入れ物（「3 年やらない」見積もりの粗い表どうしで分け合う。生成の木では使わない）。
 * 結果は正確な状態・段・手・まとめ方と月給だけで決まる（状態は作った後に書き換えない）ので、分け合っても値は変わらない。
 * 月給 S は作る時に決め（まとめ方の目安の値に月給を使うので、違う月給の結果を混ぜない）、事実の小さい組はいつも分けない（fine = false）
 */
export class OutcomeCache {
  m = new Map<string, OutcomeQ[]>();
  hits = 0;
  constructor(public readonly S: number) {}
  get(w: WorldQ, s: number, x: QSt, kind: string, mode: Mode, S: number): OutcomeQ[] {
    if (S !== this.S) throw new Error(`3 か月の結果の入れ物は月給 ${this.S} 用です（${S} で引こうとした）`);
    const key = `${exactKey(s, x)}|${kind}|${mode}`;
    const hit = this.m.get(key);
    if (hit) {
      this.hits++;
      return hit;
    }
    const outs = quarterOutcomes(w, x, kind, 3 * s, mode, S);
    this.m.set(key, outs);
    return outs;
  }
}

/** 稼ぎ [給与の月数, 広告運用 万円, SpellDash 万円] を月給 S で万円にする */
export const Wsum = (r: Vec3, S: number): number => S * r[0] + r[1] + r[2];
export const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale3 = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];

/** 粗い表のマスの給与の刻み（給与の倍率 0.05 ごと） */
export const SAL_STEP = 0.05;

/**
 * 粗い表の鍵（段・仕事・答え・Pro・印・転職活動の期の数・顧客・給与・月額・学校の席）。SpellDash の数（遊ぶ人・有料）は入れず、
 * マスの代表からの 1 次の補正（CoarseDP.corr）で正確な状態に合わせる。学校の席は 1 校 40 席ごとに入れる（席は値段が違い、
 * 席のある状態とない状態を同じマスにすると、学校への提案の順位が席の無い代表で決まる。見直し truth-1）
 */
export function coarseKey(s: number, x: QSt): string {
  const f = x.fl;
  const fl =
    (f.includes("switched") ? "w" : "") +
    (f.includes("js") ? "j" : "") +
    (f.includes("jx") ? "x" : "") +
    (f.includes("pq") ? "q" : "") +
    (f.includes("scope") ? "c" : "") +
    (f.includes("portfolio") ? "o" : "") +
    // 転職活動: この会社での期の数・続けて決まらなかった期の数（上限は表と木で同じに効く）
    `${uses(x, "q")}${uses(x, "r")}`;
  return `${s}|${x.j}|${x.pm}|${x.pro}|${fl}|${Math.round(x.cl)}|${Math.round(x.sal / SAL_STEP)}|${Math.round(x.fee)}|${Math.round(x.seats / 40)}`;
}

export interface DPEntry {
  /** マスの代表の状態での、この段の初めから 36 か月目までの値（生成の年収の万円） */
  v: number;
  /** 手の順位（1 段先の値の大きい順。同じなら今のまま） */
  rank: Array<[string, number]>;
  /** マスの代表（最初に通った正確な状態） */
  rep: QSt;
}

/** 粗い表（手の順位を決めるだけ。書き出す数には使わない）: 引かれたマスだけ作り、そのマスでできる手を全部 1 段先まで正確に計算する */
export class CoarseDP {
  memo = new Map<string, DPEntry>();
  evals = 0;
  constructor(
    public w: WorldQ,
    public S: number,
    public kinds: string[],
    /** 3 か月の結果の入れ物（「3 年やらない」見積もりの表どうしで分け合う。無ければ毎回数える） */
    public oc: OutcomeCache | null = null,
  ) {}
  entry(s: number, x: QSt): DPEntry | null {
    if (s >= NSTAGE) return null;
    const key = coarseKey(s, x);
    const hit = this.memo.get(key);
    if (hit) return hit;
    this.evals++;
    const m0 = 3 * s;
    const rank: Array<[string, number]> = [];
    for (const k of this.kinds) {
      if (!feasibleQ(this.w, x, k, m0)) continue;
      let q = 0;
      const outs = this.oc ? this.oc.get(this.w, s, x, k, "fact", this.S) : quarterOutcomes(this.w, x, k, m0, "fact", this.S);
      for (const o of outs) q += o.w * (Wsum(o.r, this.S) + this.value(s + 1, o.st));
      rank.push([k, q]);
    }
    rank.sort((a, b) => b[1] - a[1] || Number(b[0] === "keep") - Number(a[0] === "keep"));
    const e: DPEntry = { v: rank[0]![1], rank, rep: x };
    this.memo.set(key, e);
    return e;
  }
  value(s: number, x: QSt): number {
    const e = this.entry(s, x);
    return e ? e.v + this.corr(s, x, e.rep) : 0;
  }
  /**
   * マスの代表から正確な状態への 1 次の補正（給与・顧客・有料会員・学校の席）。顧客の残り方は毎月 4% の平均（3 か月ごとの離れ方と同じ平均）。
   * 有料会員 pu は学校の席を含むので、席でない有料会員は 1 人 net、学校の席は 1 席 seatNet で数える（runRateQ と同じ。見直し truth-1）
   */
  corr(s: number, x: QSt, rep: QSt): number {
    const n = H - 3 * s;
    const c = this.w.constants;
    let raise = 0;
    for (let t = 3 * s + 1; t <= H; t++) raise += Math.pow(1 + c.aprilRaise, c.aprilMonths.filter((a) => a > 3 * s && a <= t).length);
    const salF = x.j === "e" ? 1 : x.j === "p" ? c.partFactor : 0;
    const keep = (1 - Math.pow(1 - c.churn, n)) / c.churn;
    const raised = x.cb.some((k) => k.f5 === 1 && k.w >= 0.5);
    const fee = x.cl > 0.05 ? x.fee : x.j === "i" ? c.indFee : raised ? this.w.q.feeRaised : this.w.q.feeFirst;
    const seatNet = c.seatNet ?? c.net;
    const sd = x.pro ? c.net * (x.pu - x.seats - (rep.pu - rep.seats)) + seatNet * (x.seats - rep.seats) : 0;
    return this.S * salF * raise * (x.sal - rep.sal) + fee * keep * (x.cl - rep.cl) + n * sd;
  }
  /** 正確な状態での表の手: そのマスの順位で、今できる一番上の手 */
  move(s: number, x: QSt): string {
    const e = this.entry(s, x)!;
    for (const [k] of e.rank) if (feasibleQ(this.w, x, k, 3 * s)) return k;
    return "keep";
  }
}

/** 続きの見積もりの 1 つの結果: 見込み（整数 %）・結果の名前（OutcomeQ の id）・その先 */
export interface RollKid {
  p: number;
  id: string;
  next: Roll;
}

/**
 * 続きの見積もり（3s か月目の正確な状態 x から、粗い表の手で 36 か月目まで）。正確な状態ごとに覚えるので、同じ状態から先は
 * 同じ物を指す（入れ子ではなく、合流のある形）。まとめた行き先の中身（mix）と標準の続き（cont）は、この形を後からたどって出す
 */
export interface Roll {
  /** 3s か月目から 36 か月目までの稼ぎ [給与の月数, 広告運用 万円, SpellDash 万円] */
  v: Vec3;
  /** 36 か月目の月の稼ぎの見込み */
  rr: Vec3;
  /** 36 か月目の代表の状態 */
  st: QSt;
  /** 段（36 か月目は NSTAGE）と、その段の初めの正確な状態 */
  s: number;
  x: QSt;
  /** 粗い表の手（36 か月目は ""）と、その 3 か月の結果（結果のまとめ方の順） */
  k: string;
  kids: RollKid[];
}

export const exactKey = (s: number, x: QSt) => `${s}|${x.j}|${x.pm}|${x.pro}|${x.mau}|${x.pu}|${x.seats}|${bookKey(x.cb)}|${x.sal}|${x.cv}|${x.fl.join("+")}`;

/**
 * 粗い表の手で 36 か月目まで続けた正確な見積もり（正確な状態ごとに覚える）。見込みはアプリと同じ整数 % で重みを付けるので、
 * 同じ選び方ならアプリの値と一致する。結果のまとめ方はいつも lean（事実だけ分け、数と昇格の結果は平均する）
 */
export class Rollouts {
  memo = new Map<string, Roll>();
  steps = 0;
  constructor(
    public w: WorldQ,
    public S: number,
    public dp: CoarseDP,
  ) {}
  roll(s: number, x: QSt): Roll {
    if (s >= NSTAGE) return { v: [0, 0, 0], rr: runRateQ(this.w, x), st: x, s: NSTAGE, x, k: "", kids: [] };
    const key = exactKey(s, x);
    const hit = this.memo.get(key);
    if (hit) return hit;
    this.steps++;
    const k = this.dp.move(s, x);
    const outs = this.dp.oc ? this.dp.oc.get(this.w, s, x, k, "lean", this.S) : quarterOutcomes(this.w, x, k, 3 * s, "lean", this.S);
    let v: Vec3 = [0, 0, 0];
    let rr: Vec3 = [0, 0, 0];
    const ends: Array<{ x: QSt; w: number }> = [];
    const kids: RollKid[] = [];
    for (const o of outs) {
      const c = this.roll(s + 1, o.st);
      const q = o.p / 100;
      v = add3(v, scale3(add3(o.r, c.v), q));
      rr = add3(rr, scale3(c.rr, q));
      ends.push({ x: c.st, w: q });
      kids.push({ p: o.p, id: o.id, next: c });
    }
    const res: Roll = { v, rr, st: ends.length === 1 ? ends[0]!.x : repStateQ(this.w, ends), s, x, k, kids };
    this.memo.set(key, res);
    return res;
  }
}
