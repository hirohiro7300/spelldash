// 3 か月ごと 12 段の地図を、最初の手ごとの予算（分かれ道の数）で作る。設計: 作業メモ SPEC v1 §2・D1・D2、R1 の報告 §6
// R1 の試作（model-tree/gen.ts）を移した物で、作る順も同じ（粗い表は引く順で値が変わるので、順を変えないこと）。3 か月の計算は P2 の前提（./sim.ts）
// 1. 最初の手の 3 か月を元の地図と同じまとめ方で分け、その結果（次の判断）を、そこへ来る見込みの大きい順に取り出す
// 2. 判断では候補の手を正確に見積もり（3 か月 + 粗い表の通りに続けた見積もり）、一番良い手だけを広げる。
//    ほかに見せる手（今のまま・別の領域・避けたい手）は「まとめた手」: 3 か月の結果と、36 か月目のまとめた行き先だけ
// 3. 予算が残っていれば数の結果も分け（split）、足りなければ事実だけ（fact）、さらに足りなければ昇格の結果も平均する（lean）
// 4. 予算の合わせ込み（D1・見直し truth-1）: 分かれ道の数が min(目標, 届く上限) の ±2% に入るように、内側の予算を単調とみて探す。
//    予算を増やしても分かれ道が増えない（飽和）と分かったら、予算を次の 2 つに使う: (1) 段 3 までの判断で、事実の小さい組（minOutcomeP 未満）も
//    分ける、(2) おすすめの道で来る見込みの大きい判断から順に、別の領域の手（area）も広げる
// 一貫性（報告 §6.4 の決まり 1〜4）: 広げた手はいつもアプリの選ぶ一番良い手になり、おすすめの道はまとめた手に入らない。
// 別の領域の手を広げても、その木の値が一番良い手を超えたら、まとめた手に戻す（おすすめの道は変えない）
// 書き出す値（D2）: まとめた手でない手（今日の手・広げた手・33 か月目の手）にはどれも q（その 3 か月は正確に・その後は粗い表の通り。
// まとめた手と同じ見積もり方）を付ける

import type { MapContStep, MapMix, MapRole, MapWhy } from "../../../src/deepmap/mapData";
import type { Vec3 } from "../sim";
import { add3, CoarseDP, quarterOutcomes, Rollouts, scale3, Wsum, type Mode, type Roll } from "./core";
import type { OutcomeQ } from "./group";
import { feasibleQ } from "./quarter";
import { runRateQ, toQ, type QSt } from "./sim";
import { H, NSTAGE, type WorldQ } from "./world";

export interface QNode {
  key: string;
  /** 今日 r・手 a・3 か月ごとの状態 s・36 か月目の行き先 e */
  role: MapRole;
  /** 判断・結果・行き先はその月。手は始める月 */
  m: number;
  st: QSt;
  /** 判断の段（0..11。行き先は 12） */
  stage: number;
  kind?: string;
  out?: OutcomeQ;
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
  /** まとめた手でない手の q: Q と同じ見積もりの稼ぎ [給与の月数, 広告運用 万円, SpellDash 万円]（その判断から 36 か月目まで。まとめた手には付けない） */
  qv?: Vec3;
  /** 手の見積もりの中身（広げた別の領域の手をまとめた手に戻す時に使う） */
  ev?: Eval;
  /** 予算の使い道 2 で広げた別の領域の手 */
  areaExp?: boolean;
  /** まとめた行き先: その結果の状態からの続きの見積もり（mix・cont はここから出す） */
  roll?: Roll;
  /** まとめた行き先の中身と標準の続き（./outputs.ts の summaryOutputs が入れる） */
  mix?: MapMix;
  cont?: MapContStep[];
}

export interface Params {
  /** 最初の手ごとの分かれ道の数 */
  B: number;
  /** 今日の後の判断で見せる手の数（今のまま・一番良い手・別の領域・避けたい手）。altsBy[段] があればそちら */
  maxAlts: number;
  altsBy?: number[];
  /** 粗い表の上から何個を正確に見積もるか */
  topN: number;
  /** 避けたい手: 今のままとの差がこれ以下（万円） */
  warn: number;
  /** ずっと今のままの道（おすすめの道でない所）の取り出す見込みに掛ける数 */
  chainDiscount: number;
  /** 分かれ道の数の目標の幅（±） */
  tol: number;
  /** 予算の使い道 1: 事実の小さい組も分ける判断の段の上限（0 が今日） */
  fineDepth: number;
  /** 予算の使い道 2: 広げた別の領域の手の先の、取り出す見込みに掛ける数 */
  areaDiscount: number;
}

export const DEFAULTS: Params = { B: 2000, maxAlts: 4, topN: 3, warn: -15, chainDiscount: 0.3, tol: 0.02, fineDepth: 3, areaDiscount: 0.3 };

/** R1 が選んだ形（報告 §11）: 1 年目 4・2 年目 3・3 年目 2 の手を見せる */
export const R1_ALTS_BY: readonly number[] = [0, 4, 4, 4, 4, 3, 3, 3, 3, 2, 2, 2];

/** 鍵に使う手の短い名前（今日の後の手の鍵は「段 + 短い名前」。例 1fp・3fw2） */
export const CODE: Record<string, string> = {
  keep: "k",
  sd_permpro: "pp",
  sd_grow: "sg",
  sd_pilot: "sp",
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

/** 最初の手 1 つの予算の使い方（合わせ込みが決める）: fine 段 fineDepth までの判断で事実の小さい組も分ける・areaN 別の領域の手を広げる判断の数 */
export interface SinkCfg {
  fine: boolean;
  areaN: number;
}

/** 1 回作った時の数 */
export interface PassStats {
  /** 分かれ道（別の領域の手を戻した後） */
  forks: number;
  /** 予算が足りずに数の結果を分けなかった判断（0 なら、予算を増やしても木は変わらない） */
  limited: number;
  /** 別の領域の手を広げられる判断（おすすめの道の上で別の領域の手を見せ、その先がある）・広げた数・木の値が一番良い手を超えたので戻した数 */
  areaEligible: number;
  areaUsed: number;
  areaReverted: number;
}

/** 予算の合わせ込みの報告（最初の手ごと） */
export interface Calib {
  /** 目標（min(B, 届く上限)） */
  target: number;
  /** 分ける予算だけでは目標に届かなかった（飽和）。その時の分かれ道（予算 ∞） */
  saturated: boolean;
  splitMax: number | null;
  /** 予算の使い道 1 を使った・その時の分かれ道（予算 ∞） */
  fine: boolean;
  fineMax: number | null;
  /** 予算の使い道 2: 別の領域の手を広げる判断の数（上限）・広げた・戻した・広げられる判断 */
  areaN: number;
  areaUsed: number;
  areaReverted: number;
  areaEligible: number;
  /** 予算の使い道を全部使っても目標に届かなかった時の、届く上限（届いたら null） */
  reachMax: number | null;
  /** 内側の予算（∞ は Infinity）・作った回数・目標の ±tol に入った */
  Bint: number;
  passes: number;
  hit: boolean;
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
  /** 広げた別の領域の手 */
  areaExp: number;
  ms: number;
  /** 予算の合わせ込みの回数と、最後の内側の予算（∞ は Infinity） */
  passes: number;
  Bint: number;
  calib: Calib;
}

export type Eval = { q: number; outs: OutcomeQ[]; conts: Roll[] };

/** 見積もりの稼ぎ（R3）: Σ 見込み × (その 3 か月 + 続き)。Q（万円）と同じ足し方の順 */
export function qOf(outs: readonly OutcomeQ[], conts: readonly Roll[]): Vec3 {
  let v: Vec3 = [0, 0, 0];
  outs.forEach((o, i) => (v = add3(v, scale3(add3(o.r, conts[i]!.v), o.p / 100))));
  return v;
}

/** 合わせ込みの 1 点: 内側の予算 B で作った分かれ道の数と、予算が足りずに分けなかった判断の数 */
export interface CalibPoint {
  forks: number;
  limited: number;
}

export interface CalibResult {
  /** 一番近かった内側の予算と、その分かれ道 */
  B: number;
  forks: number;
  /** 目標の ±tol に入った */
  hit: boolean;
  /** 予算 ∞ でも目標の下限に届かない（このとき B = Infinity・forks はその上限） */
  saturated: boolean;
  passes: number;
}

/**
 * 内側の予算の合わせ込み（単調とみる探し方。二分ではない）: 分かれ道の数は内側の予算について減らないとみて、目標 ±tol に入る予算を探す。
 *   - 下限に届かず、予算が足りずに分けなかった判断が 0 なら、予算を増やしても木は変わらない（飽和）。0 でなければ予算 ∞ を 1 回試し、
 *     それでも届かなければ飽和（上限 = その数）
 *   - 片側しか分からない間は目標との比で上げ下げし、両側が分かったら間を比例で詰める（端から 1 割は内側に取るので、幅は必ず縮む）
 *   - maxPasses 回で入らなければ、一番近かった予算を返す（hit = false）
 * run は作るたびに木を作り直す。返す予算が最後に作った予算と違えば、呼ぶ側が作り直す
 */
export function calibrate(run: (B: number) => CalibPoint, target: number, tol: number, B0: number, maxPasses: number): CalibResult {
  const lo = target * (1 - tol);
  const hi = target * (1 + tol);
  const inside = (f: number) => f >= lo - 1e-9 && f <= hi + 1e-9;
  let best: { B: number; forks: number } | null = null;
  const note = (B: number, forks: number) => {
    if (!best || Math.abs(forks - target) < Math.abs(best.forks - target)) best = { B, forks };
  };
  let passes = 0;
  // 下側（分かれ道 < 下限）で一番大きい予算・上側（> 上限）で一番小さい予算
  let loB = -Infinity;
  let loF = 0;
  let hiB = Infinity;
  let hiF = 0;
  let B = B0;
  let triedInf = false;
  /** どれかの予算（∞ も）で上限を超えた */
  let above = false;
  while (passes < maxPasses) {
    const r = run(B);
    passes++;
    note(B, r.forks);
    if (inside(r.forks)) return { B, forks: r.forks, hit: true, saturated: false, passes };
    if (r.forks < lo) {
      // 飽和とみるのは、まだどの予算でも上限を超えていない時だけ（超えた予算があれば、単調でない谷なので間を詰める）
      if (!above && (r.limited === 0 || B === Infinity)) return { B: Infinity, forks: r.forks, hit: false, saturated: true, passes };
      if (B > loB) (loB = B), (loF = r.forks);
    } else {
      above = true;
      if (B < hiB) (hiB = B), (hiF = r.forks);
    }
    let next: number;
    if (hiB === Infinity) {
      // まだ上側が無い: 一度だけ予算 ∞ で飽和を確かめ、その後は比で上げる
      if (!triedInf) {
        triedInf = true;
        next = Infinity;
      } else next = B * Math.min(4, Math.max(1.1, (target / Math.max(1, r.forks)) * 1.02));
    } else if (loB === -Infinity) next = B * Math.max(0.25, Math.min(0.95, target / Math.max(1, r.forks)));
    else {
      const w = hiB - loB;
      if (w < 0.5) break;
      next = hiF > loF ? loB + ((target - loF) * w) / (hiF - loF) : loB + w / 2;
      next = Math.min(hiB - 0.1 * w, Math.max(loB + 0.1 * w, next));
    }
    if (next !== Infinity && Math.abs(next - B) < 0.25) break;
    // 予算 ∞ が上側になった（届く）ので、比で上げる探し方に戻る
    if (B === Infinity && hiB === Infinity) next = Math.max(B0, loB) * Math.min(4, Math.max(1.1, (target / Math.max(1, loF)) * 1.02));
    B = next;
  }
  const b = best as { B: number; forks: number } | null;
  return { B: b ? b.B : B0, forks: b ? b.forks : 0, hit: false, saturated: false, passes };
}

/**
 * 最初の手 1 つの予算の合わせ込みの手順（D1・見直し truth-1）。run(内側の予算, 予算の使い方) は木を作り直して数を返す（テストでは作り物でよい）。
 *   1) 分ける予算だけで目標 B ±tol を探す（calibrate）。届けばそれで終わり
 *   2) 飽和したら、予算の使い道 1（事実の小さい組も分ける）を足し、予算 ∞ で下限に届くなら、その形で内側の予算を合わせ込む
 *   3) それでも届かなければ予算の使い道 2: 別の領域の手を広げる判断の数 n を、予算 ∞ で下限に届く一番少ない数まで増やす（1・2・4…の後に間を詰める）。
 *      届いたらその n で内側の予算を合わせ込む。広げられる判断を全部使っても届かなければ、その上限（予算 ∞・全部）を目標にする
 * 返す chosen が最後に作った形と違えば、呼ぶ側が作り直す。calib の数（広げた・戻した・入ったか）は作り直した後に呼ぶ側が入れる
 */
export function planBudget(run: (Bint: number, cfg: SinkCfg) => PassStats, B: number, tol: number): { chosen: { B: number; cfg: SinkCfg }; calib: Calib } {
  const lo = B * (1 - tol);
  const calib: Calib = { target: B, saturated: false, splitMax: null, fine: false, fineMax: null, areaN: 0, areaUsed: 0, areaReverted: 0, areaEligible: 0, reachMax: null, Bint: B, passes: 0, hit: false };
  const tune = (c: SinkCfg): CalibResult => calibrate((x) => run(x, c), B, tol, B, 14);
  const done = (Bint: number, cfg: SinkCfg) => {
    calib.Bint = Bint;
    calib.areaN = cfg.areaN;
    return { chosen: { B: Bint, cfg }, calib };
  };
  const plain: SinkCfg = { fine: false, areaN: 0 };
  const r1 = tune(plain);
  if (!r1.saturated) return done(r1.B, plain);
  calib.saturated = true;
  calib.splitMax = r1.forks;
  // 1) 事実の小さい組も分ける
  const fine: SinkCfg = { fine: true, areaN: 0 };
  calib.fine = true;
  const pf = run(Infinity, fine);
  calib.fineMax = pf.forks;
  calib.areaEligible = pf.areaEligible;
  if (pf.forks >= lo - 1e-9) return done(tune(fine).B, fine);
  // 2) 別の領域の手を広げる判断の数: 予算 ∞ で下限に届く一番少ない数
  const elig = pf.areaEligible;
  let below = 0;
  let n = Math.min(1, elig);
  let top = pf.forks;
  while (n > 0) {
    const p = run(Infinity, { fine: true, areaN: n });
    top = p.forks;
    if (p.forks >= lo - 1e-9) break;
    if (n >= elig) break;
    below = n;
    n = Math.min(elig, 2 * n);
  }
  if (top < lo - 1e-9) {
    calib.reachMax = top;
    calib.target = top;
    return done(Infinity, { fine: true, areaN: elig });
  }
  let above = n;
  while (above - below > 1) {
    const mid = Math.floor((above + below) / 2);
    if (run(Infinity, { fine: true, areaN: mid }).forks >= lo - 1e-9) above = mid;
    else below = mid;
  }
  const cfg: SinkCfg = { fine: true, areaN: above };
  return done(tune(cfg).B, cfg);
}

export class Gen {
  ro: Rollouts;
  kinds: string[];
  /** 正確な見積もりの回数・決まり 3 で分け方を落とした回数と、その時の不足（万円） */
  evals = 0;
  guards = 0;
  shortfalls: number[] = [];
  /** 作っている最初の手の予算の使い方（firstMove の間だけ） */
  private fineStage = -1;
  private areaLeft = 0;
  private pass: PassStats = { forks: 0, limited: 0, areaEligible: 0, areaUsed: 0, areaReverted: 0 };
  constructor(
    public w: WorldQ,
    public S: number,
    public dp: CoarseDP,
    public P: Params,
  ) {
    this.ro = new Rollouts(w, S, dp);
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
  /** その手のここでの正確な見積もり: 3 か月の結果 + その後は粗い表の通りに続けた見積もり。fine なら事実の小さい組も分ける */
  evalMove(s: number, x: QSt, kind: string, mode: Mode, fine = false): Eval {
    this.evals++;
    const outs = quarterOutcomes(this.w, x, kind, 3 * s, mode, this.S, fine);
    let q = 0;
    const conts = outs.map((o) => this.ro.roll(s + 1, o.st));
    outs.forEach((o, i) => (q += (o.p / 100) * (Wsum(o.r, this.S) + Wsum(conts[i]!.v, this.S))));
    return { q, outs, conts };
  }

  /** 今日と最初の手（only があればその手だけ）。最初の手ごとに予算を合わせ込む（D1） */
  build(only?: string[]): { root: QNode; stats: MoveStats[] } {
    const w = this.w;
    const root: QNode = { key: "r", role: "r", m: 0, st: toQ(w, w.today), stage: 0, kids: [], parent: null, pPath: 1, V: 0, onPi: true };
    const stats: MoveStats[] = [];
    for (const k0 of w.rootMenu) {
      if (only && !only.includes(k0)) continue;
      const t0 = performance.now();
      const { a0, calib } = this.calibrated(root, k0);
      stats.push({ ...this.countSub(a0), kind: k0, ms: performance.now() - t0, passes: calib.passes, Bint: calib.Bint, calib });
    }
    return { root, stats };
  }

  /** 最初の手 k0 の予算の合わせ込み（D1。手順は planBudget）。選んだ形で作った木と報告 */
  calibrated(root: QNode, k0: string): { a0: QNode; calib: Calib } {
    let a0: QNode | null = null;
    let last: { B: number; cfg: SinkCfg } | null = null;
    let passes = 0;
    const run = (Bint: number, cfg: SinkCfg): PassStats => {
      if (a0) root.kids.splice(root.kids.indexOf(a0), 1);
      const r = this.firstMove(root, k0, Bint, cfg);
      a0 = r.a0;
      last = { B: Bint, cfg };
      passes++;
      return r.ps;
    };
    const { chosen, calib } = planBudget(run, this.P.B, this.P.tol);
    // 選んだ形で作り直す（最後に作った物と違えば）。同じ形なら、表と続きの見積もりは増えるだけなので同じ木になる
    const l = last as { B: number; cfg: SinkCfg } | null;
    if (!l || l.B !== chosen.B || l.cfg.fine !== chosen.cfg.fine || l.cfg.areaN !== chosen.cfg.areaN) run(chosen.B, chosen.cfg);
    const fin = this.pass;
    calib.areaUsed = fin.areaUsed;
    calib.areaReverted = fin.areaReverted;
    if (!calib.saturated) calib.areaEligible = fin.areaEligible;
    calib.passes = passes;
    calib.hit = Math.abs(fin.forks - calib.target) <= calib.target * this.P.tol + 1e-9;
    return { a0: a0!, calib };
  }

  /** 最初の手 k0 の木（内側の予算 Bint・予算の使い方 cfg）。今日の子の最後に足す */
  firstMove(root: QNode, k0: string, Bint: number, cfg: SinkCfg = { fine: false, areaN: 0 }): { a0: QNode; ps: PassStats } {
    const w = this.w;
    const S = this.S;
    this.fineStage = cfg.fine ? this.P.fineDepth : -1;
    this.areaLeft = cfg.areaN;
    this.pass = { forks: 0, limited: 0, areaEligible: 0, areaUsed: 0, areaReverted: 0 };
    const a0: QNode = { key: `r.${k0}`, role: "a", m: 0, st: root.st, stage: 0, kind: k0, kids: [], parent: root, pPath: 1, V: 0, why: k0 === "keep" ? "keep" : "menu" };
    root.kids.push(a0);
    const heap = new Heap<QNode>();
    let forks = 0;
    let reserved = 0;
    // 数を分けない判断 1 つあたりの分かれ道の数（これまでの平均）。取り出す前の判断には、その先の段の数だけ取り置く
    let cBase = 2.0;
    let seen = 0;
    let sumC = 0;
    const resv = (s: number) => (NSTAGE - s) * cBase;
    const outs0 = quarterOutcomes(w, root.st, k0, 0, "split", S, 0 <= this.fineStage);
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
      if (level !== "split") this.pass.limited++;
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
    // 今日の手の q: その 3 か月 + 結果ごとの続きの見積もり（結果の判断で数えた物を引くだけ）
    a0.qv = qOf(outs0, outs0.map((o) => this.ro.roll(1, o.st)));
    if (this.pass.areaUsed) this.pass.areaReverted = this.revertAreas(a0);
    this.pass.forks = this.countSub(a0).forks;
    this.fineStage = -1;
    this.areaLeft = 0;
    return { a0, ps: { ...this.pass } };
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
    const fine = s <= this.fineStage;
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
      for (const k of cand) if (feas.includes(k)) m.set(k, this.evalMove(s, x, k, lv, fine));
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
    // 予算の使い道 2: おすすめの道の上で、来る見込みの大きい判断から順に、別の領域の手も広げる（その先がある判断だけ）
    const areaK = shown.find(([, why]) => why === "area")?.[0] ?? null;
    if (d.onPi && areaK && s + 1 < NSTAGE) {
      this.pass.areaEligible++;
      if (this.areaLeft > 0) {
        this.areaLeft--;
        this.pass.areaUsed++;
        expand.add(areaK);
      }
    }
    // まとめた手は判断と同じまとめ方で見せる（R1 の決まり 4 の「より粗いまとめ方」は使わない: 見積もりは広げた手と同じ）
    // この判断の余裕: 広げた一番良い手の値が、見せたほかの手（まとめた手と、広げた別の領域の手）の見積もりに負けずに下がってよい幅。
    // 別の領域の手も入れるので、その手を後でまとめた手に戻しても決まり 2 が保たれる。ずっと今のままの道で広げた今のままは入れない（元の決まり）
    const stubQs = shown.filter(([k]) => k !== best && !(k === "keep" && d.chain)).map(([k]) => ev.get(k)!.q);
    const margin = stubQs.length ? order[0]![1].q - Math.max(...stubQs) : Infinity;
    const childAllow = Math.min(margin, allow - usedHere);
    const children: QNode[] = [];
    let bestSplitExtra = 0;
    for (const [k, why] of shown) {
      const e = ev.get(k)!;
      const tok = s === 0 ? k : `${s}${CODE[k] ?? k}`;
      const a: QNode = { key: `${d.key}.${tok}`, role: "a", m: m0, st: x, stage: s, kind: k, kids: [], parent: d, pPath: d.pPath, V: 0, why, Q: e.q };
      d.kids.push(a);
      const isExp = expand.has(k);
      a.stub = !isExp && s + 1 < NSTAGE;
      // まとめた手でない手にはどれも q（まとめた手と同じ見積もり方。まとめた手は子の行き先から同じ値になる。33 か月目の手は 3 か月だけ）
      if (!a.stub) a.qv = qOf(e.outs, e.conts);
      const isArea = isExp && k === areaK && k !== best && !(k === "keep" && d.chain);
      if (isArea) {
        a.areaExp = true;
        a.ev = e;
      }
      if (isExp && k === best && e.outs.length >= 2 && level === "split") bestSplitExtra = e.outs.length - 1;
      e.outs.forEach((o, i) => {
        const key = `${a.key}.${o.id}`;
        if (s + 1 >= NSTAGE) {
          a.kids.push({ key, role: "e", m: H, st: o.st, stage: NSTAGE, out: o, r: o.r, rr: runRateQ(w, o.st), kids: [], parent: a, pPath: d.pPath * (o.p / 100), V: 0 });
          return;
        }
        if (!isExp) {
          a.kids.push(this.sumEndOf(a, o, e.conts[i]!));
          return;
        }
        const onPi = !!d.onPi && k === best;
        const chain = !!d.chain && k === "keep";
        const pPath = d.pPath * (o.p / 100) * (onPi ? 1 : chain ? this.P.chainDiscount : isArea ? this.P.areaDiscount : 1);
        const c: QNode = { key, role: "s", m: m0 + 3, st: o.st, stage: s + 1, out: o, r: o.r, kids: [], parent: a, pPath, V: 0, chain, onPi, allow: k === best ? childAllow : 0 };
        a.kids.push(c);
        children.push(c);
      });
    }
    return { children, bestSplitExtra };
  }

  /** まとめた手 a の結果 o の、36 か月目のまとめた行き先（その 3 か月 + 続きの見積もり c） */
  sumEndOf(a: QNode, o: OutcomeQ, c: Roll): QNode {
    return { key: `${a.key}.${o.id}`, role: "e", m: H, st: c.st, stage: NSTAGE, out: o, r: add3(o.r, c.v), rr: c.rr, kids: [], parent: a, pPath: a.pPath * (o.p / 100), V: 0, sumEnd: true, roll: c };
  }

  /**
   * 広げた別の領域の手の木の値（アプリと同じ後ろからの値・生成の年収）が、その判断の一番良い手を超えたら、まとめた手に戻す（後ろから）。
   * 一番良い手の値は、見せたほかの手の見積もり以上（決まり 2。余裕に別の領域の手も入れてある）なので、戻した後もアプリの一番良い手は変わらない
   */
  revertAreas(a0: QNode): number {
    const S = this.S;
    let reverted = 0;
    const val = (n: QNode): number => {
      if (n.role === "e") return (n.V = 0);
      if (n.role === "a") {
        let v = 0;
        for (const c of n.kids) v += (c.out!.p / 100) * (Wsum(c.r!, S) + val(c));
        return (n.V = v);
      }
      for (const a of n.kids) val(a);
      const best = n.kids.find((a) => a.why === "best") ?? n.kids.find((a) => a.kind === "keep")!;
      for (const a of n.kids) {
        if (!a.areaExp || a.V <= best.V + 1e-9) continue;
        const e = a.ev!;
        a.kids = e.outs.map((o, i) => this.sumEndOf(a, o, e.conts[i]!));
        a.stub = true;
        a.areaExp = false;
        delete a.qv;
        let v = 0;
        for (const c of a.kids) v += (c.out!.p / 100) * Wsum(c.r!, S);
        a.V = v;
        reverted++;
      }
      let bv = -Infinity;
      let bn: QNode | null = null;
      for (const a of n.kids)
        if (a.V > bv + 1e-9 || (Math.abs(a.V - bv) <= 1e-9 && a.kind === "keep" && bn?.kind !== "keep")) {
          bv = a.V;
          bn = a;
        }
      return (n.V = bv);
    };
    val(a0);
    return reverted;
  }

  countSub(a0: QNode): Omit<MoveStats, "kind" | "ms" | "passes" | "Bint" | "calib"> {
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
    let areaExp = 0;
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
        if (n.areaExp) areaExp++;
      }
      if (n.role === "e") {
        ends++;
        if (n.sumEnd) sumEnds++;
      }
      for (const k of n.kids) walk(k, depth + 1);
    };
    walk(a0, 1);
    return { forks, nodes, decisions, options, stubs, ends, sumEnds, splitDecisions, maxDepth, byStage, fe, fs, areaExp };
  }
}

/**
 * 粗い表を引き始める順（表の代表の状態は最初に通った状態なので、この順も結果の一部。見直し truth-2）。
 * order が無ければ試作の入口（proto.ts）と同じ: 今日の状態の 3 か月後のマスから引く（今日の手が無い世界では引かない）。
 * order があれば、その順に今日の手の 3 か月の結果の状態から引く（順を変えた時の値の幅を測るため）
 */
export function warmTable(w: WorldQ, dp: CoarseDP, order?: readonly string[]): void {
  const today = toQ(w, w.today);
  if (!order) {
    if (w.rootMenu.length > 0) dp.value(1, today);
    return;
  }
  for (const k of order) for (const o of quarterOutcomes(w, today, k, 0, "split", dp.S)) dp.value(1, o.st);
}

/**
 * 粗い表を引き始めてから作る（warmTable。既定は試作と同じ順）。
 * dp0: 前に作った粗い表を引き継ぐ（テスト用。引き継いだ表で作った木は、表を新しく作った木と同じとは限らない）
 */
export function generate(w: WorldQ, P: Params, only?: string[], dp0?: CoarseDP, warm?: readonly string[]): { root: QNode; stats: MoveStats[]; gen: Gen; dp: CoarseDP; msTable: number; msGen: number } {
  const S = w.annual / 12;
  const t0 = performance.now();
  const dp = dp0 ?? new CoarseDP(w, S, Object.keys(w.kinds));
  if (!dp0) warmTable(w, dp, warm);
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
