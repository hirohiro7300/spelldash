// 見込みで重みを付けた分布（3 年の合計の分布・3 か月ごとの月の稼ぎの幅）。アプリの weightedQuantile・dist と同じ決まり

import { BAD_EPS } from "../../model/impact";
import { impactBin } from "../../model/impactFormat";

/** 重み付きの値の集まり（並べ替えて分位を出す） */
export class Weighted {
  private v: number[] = [];
  private w: number[] = [];
  add(value: number, weight: number): void {
    if (!(weight > 0) || !Number.isFinite(value)) return;
    this.v.push(value);
    this.w.push(weight);
  }
  get size(): number {
    return this.v.length;
  }
  get total(): number {
    let t = 0;
    for (const x of this.w) t += x;
    return t;
  }
  mean(): number {
    let t = 0;
    let s = 0;
    for (let k = 0; k < this.v.length; k++) {
      t += this.w[k]!;
      s += this.v[k]! * this.w[k]!;
    }
    return t > 0 ? s / t : 0;
  }
  /** 分位（アプリの weightedQuantile: 小さい順に重みを足し、q × 合計に届いた所の値） */
  quantiles(qs: readonly number[]): number[] {
    const n = this.v.length;
    const out = qs.map(() => 0);
    if (!n) return out;
    const order = new Int32Array(n);
    for (let k = 0; k < n; k++) order[k] = k;
    const v = this.v;
    order.sort((x, y) => v[x]! - v[y]! || x - y);
    const total = this.total;
    if (!(total > 0)) return out;
    for (let j = 0; j < qs.length; j++) {
      const goal = qs[j]! * total - 1e-12;
      let acc = 0;
      let val = v[order[n - 1]!]!;
      for (let k = 0; k < n; k++) {
        acc += this.w[order[k]!]!;
        if (acc >= goal) {
          val = v[order[k]!]!;
          break;
        }
      }
      out[j] = val;
    }
    return out;
  }
  values(): readonly number[] {
    return this.v;
  }
  weights(): readonly number[] {
    return this.w;
  }
}

const Q3 = [0.1, 0.5, 0.9] as const;

/** 3 年の合計の分布（ずっと今のままとの差の段で分ける） */
export interface Dist {
  /** 行き先の数（見込みのある物） */
  n: number;
  /** 見込みの合計（ふつう 1） */
  mass: number;
  /** 平均（3 年の合計・万円） */
  mean: number;
  p10: number;
  p50: number;
  p90: number;
  /** ずっと今のままより悪くなる見込み（3 万円より悪い。0〜1） */
  pWorse: number;
  /** 段（−4〜+4）ごとの見込み（9 個。ずっと今のままとの差の段。合計 1） */
  bins: number[];
  /** まとめた行き先（標準の選び方で続けた見積もり）に入った見込み（0〜1） */
  viaSummary: number;
}

/** 行き先の重み付きの合計から分布を作る。sum は、そのうちまとめた行き先の重み */
export function distOf(items: Weighted, vSQ: number, sum: number): Dist | null {
  const mass = items.total;
  if (!(mass > 0)) return null;
  const [p10, p50, p90] = items.quantiles(Q3) as [number, number, number];
  const bins = new Array<number>(9).fill(0);
  let worse = 0;
  const v = items.values();
  const w = items.weights();
  for (let k = 0; k < v.length; k++) {
    const share = w[k]! / mass;
    const b = impactBin(v[k]! - vSQ) + 4;
    bins[b] = bins[b]! + share;
    if (v[k]! < vSQ - BAD_EPS) worse += share;
  }
  return { n: items.size, mass, mean: items.mean(), p10, p50, p90, pWorse: worse, bins, viaSummary: sum / mass };
}

/** 幅（10%・50%・90% と平均） */
export interface Band3 {
  p10: number;
  p50: number;
  p90: number;
  mean: number;
}

export function band3(items: Weighted): Band3 | null {
  if (!(items.total > 0)) return null;
  const [p10, p50, p90] = items.quantiles(Q3) as [number, number, number];
  return { p10, p50, p90, mean: items.mean() };
}
