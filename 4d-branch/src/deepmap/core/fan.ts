// 選んだ手の扇（3 か月ごとの月の稼ぎの幅）と分かれ道の帯（3 か月ごとの判断の数）（設計: 作業メモ SPEC v1 §5.2。作業メモ user-1 (2)）
// 扇: 0・3・…・36 か月目のそれぞれで、その手を選んだ後おすすめの選び方で進んだときの月の稼ぎ w(rr) の 10%・50%・90%
//     （来る見込みで重み付け）。比べる帯はずっと今のまま。事実を知る手（会社の答えなど）は答えごとに 1 本ずつ。
//     子の無い状態（36 か月目より前の行き先）は、その月の稼ぎのまま 36 か月目まで続くとして数える（値の決まりと同じ）。
//     まとめた行き先は 36 か月目にだけ入れ、その手の後 36 か月目までの段は「標準の続きの見積もり」（viaSummary）として外に出す。

import { F_SUM, quarterOf, ROLE_A, ROLE_E, ROLE_S, type CompiledMap } from "./compile";
import { outcomesOf } from "./moves";
import type { Analysis } from "./passes";
import { band3, Weighted } from "./stats";

export interface FanPoint {
  /** 0 か月目からの月（0・3・…・36） */
  m: number;
  /** 月の稼ぎ（万円/月）の 10%・50%・90% と平均。その段に数が無ければ null */
  p10: number | null;
  p50: number | null;
  p90: number | null;
  mean: number | null;
  /** その段で数えた見込み（帯の中で 0〜1） */
  mass: number;
  /** まとめた手に入っていて、この段の数が無い見込み（帯の中で 0〜1） */
  viaSummary: number;
  /** この段の数のうち、まとめた行き先（標準の続きの見積もり）から来た割合（0〜1。36 か月目だけ。ふつう 0） */
  estimated: number;
}

export interface FanBand {
  /** 帯の名前（答えごとの帯は結果の名前。全体は ""） */
  label: string;
  /** 答えの鍵（画面には出さない。全体は null） */
  answer: string | null;
  /** その帯になる見込み（0〜1） */
  share: number;
  /** 帯の元になったこの手の結果 */
  outcomes: number[];
  points: FanPoint[];
}

export interface FanData {
  /** 今日の手 */
  node: number;
  /** 全体の帯 */
  all: FanBand;
  /** 答えごとの帯（事実を知る手だけ。そうでなければ空） */
  answers: FanBand[];
  /** ずっと今のまま（今日から） */
  keep: FanPoint[];
}

/** 段（0〜H/3）ごとの月の稼ぎ。starts は数える部分木の始め（その部分木全体をなめる。見込みは始めの見込みの合計で割る） */
function fanOver(a: Analysis, starts: readonly number[], wt: Float64Array): FanPoint[] {
  const cm = a.cm;
  const { size, role, month, kidOff, flags, parent, H } = cm;
  const { Wrr } = a.money;
  const Q = quarterOf(H) + 1;
  const buckets: Weighted[] = [];
  for (let q = 0; q < Q; q++) buckets.push(new Weighted());
  const via = new Float64Array(Q);
  const est = new Float64Array(Q);
  let total = 0;
  for (const lo of starts) {
    total += wt[lo]! > 0 ? wt[lo]! : 0;
    const hi = lo + size[lo]!;
    for (let i = lo; i < hi; i++) {
      const r = role[i]!;
      if (r !== ROLE_S && r !== ROLE_E) continue;
      const m = wt[i]!;
      if (!(m > 0)) continue;
      const q = Math.min(Q - 1, quarterOf(month[i]!));
      buckets[q]!.add(Wrr[i]!, m);
      if (kidOff[i] !== kidOff[i + 1]) continue;
      if (flags[i]! & F_SUM) {
        // まとめた行き先: その手の月から 36 か月目までの間の段は数が無い
        const from = quarterOf(month[parent[i]!]!);
        for (let k = from + 1; k < q; k++) via[k] = via[k]! + m;
        est[q] = est[q]! + m;
      } else {
        // 36 か月目より前の行き先: その月の稼ぎのまま続く
        for (let k = q + 1; k < Q; k++) buckets[k]!.add(Wrr[i]!, m);
      }
    }
  }
  const norm = total > 0 ? total : 1;
  const out: FanPoint[] = [];
  for (let q = 0; q < Q; q++) {
    const b = band3(buckets[q]!);
    const mass = buckets[q]!.total;
    out.push({ m: Math.min(H, q * 3), p10: b?.p10 ?? null, p50: b?.p50 ?? null, p90: b?.p90 ?? null, mean: b?.mean ?? null, mass: mass / norm, viaSummary: via[q]! / norm, estimated: mass > 0 ? est[q]! / mass : 0 });
  }
  return out;
}

/** 0 か月目（今日）の点: 今日の月の稼ぎ */
function withToday(a: Analysis, pts: FanPoint[]): FanPoint[] {
  const x = a.money.Wrr[0]!;
  pts[0] = { m: 0, p10: x, p50: x, p90: x, mean: x, mass: 1, viaSummary: 0, estimated: 0 };
  return pts;
}

/** 選んだ今日の手 f の扇 */
export function fanData(a: Analysis, f: number): FanData {
  const cm = a.cm;
  if (cm.parent[f] !== 0 || cm.role[f] !== ROLE_A) throw new RangeError(`今日の手ではありません: ${f}`);
  const { reachIn } = a.pi;
  const all: FanBand = { label: "", answer: null, share: 1, outcomes: kidsOf(cm, f), points: withToday(a, fanOver(a, [f], reachIn)) };
  const answers: FanBand[] = [];
  const { reveals } = outcomesOf(a, f);
  if (reveals) {
    for (const g of reveals.answers) {
      // 答えごとの帯は、その答えの結果の部分木だけ（見込みはその答えの中の割合: fanOver が始めの見込みの合計で割る）
      const pts = fanOver(a, g.outcomes, reachIn);
      answers.push({ label: g.label, answer: g.answer, share: g.share, outcomes: g.outcomes, points: withToday(a, pts) });
    }
  }
  return { node: f, all, answers, keep: keepFan(a) };
}

/** ずっと今のまま の扇（今日から） */
export function keepFan(a: Analysis): FanPoint[] {
  const { reach } = a.keep;
  const starts: number[] = [];
  for (const f of a.cm.firstMoves) if (reach[f]! > 0) starts.push(f);
  return withToday(a, fanOver(a, starts, reach));
}

function kidsOf(cm: CompiledMap, i: number): number[] {
  return Array.from(cm.kids.subarray(cm.kidOff[i]!, cm.kidOff[i + 1]!));
}

/** 分かれ道の帯: 3 か月ごとの判断と出来事の分かれの数 */
export interface ForkStrip {
  /** 段の月（0・3・…・36） */
  months: number[];
  /** その月の判断（手が 2 つ以上の状態）の数（形） */
  decisions: number[];
  /** そのうち、この手の後おすすめの選び方で来る見込みのある物 */
  reachDecisions: number[];
  /** その月に始まる手のうち、結果が 2 つ以上に分かれる物の数（形） */
  splits: number[];
  /** そのうち、来る見込みのある物 */
  reachSplits: number[];
  /** 合わせた数 */
  total: { decisions: number; splits: number; forks: number };
}

export function forkStrip(a: Analysis, f: number): ForkStrip {
  const cm = a.cm;
  const { size, role, month, kidOff, H } = cm;
  const { reachIn } = a.pi;
  const Q = quarterOf(H) + 1;
  const decisions = new Array<number>(Q).fill(0);
  const reachDecisions = new Array<number>(Q).fill(0);
  const splits = new Array<number>(Q).fill(0);
  const reachSplits = new Array<number>(Q).fill(0);
  const hi = f + size[f]!;
  for (let i = f; i < hi; i++) {
    const deg = kidOff[i + 1]! - kidOff[i]!;
    if (deg < 2) continue;
    const q = Math.min(Q - 1, quarterOf(month[i]!));
    const reached = reachIn[i]! > 0;
    if (role[i] === ROLE_S) {
      decisions[q]!++;
      if (reached) reachDecisions[q]!++;
    } else if (role[i] === ROLE_A) {
      splits[q]!++;
      if (reached) reachSplits[q]!++;
    }
  }
  const months = decisions.map((_, q) => Math.min(H, q * 3));
  const d = decisions.reduce((s, x) => s + x, 0);
  const sp = splits.reduce((s, x) => s + x, 0);
  return { months, decisions, reachDecisions, splits, reachSplits, total: { decisions: d, splits: sp, forks: d + sp } };
}
