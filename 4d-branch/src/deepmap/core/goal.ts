// 地図の行き先を「資産 10 億円」のゴールにつなぐ数（設計: 作業メモ goal/design.md §1.4・§1.5・§2）
//   goalBase(a)            設定によらない物（今日の手ごと・おすすめ・ずっと今のままの行き先の 3 つの数と見込み・芽・
//                          事業の稼ぎの一番大きい行き先・一番良い行き先の候補）。計算（Analysis）ごとに 1 回（WeakMap）
//   goalOf(base, tables)   設定ごとの数（期限の資産の幅・期限までに届く見込み・届く年・要る積立と伸び・一番良い行き先）。
//                          設定ごとに覚える（4 つまで）。年収を変えたときだけ goalBase から作り直す
//   goalInputAt(a, i)      カード 1 枚の 3 つの数（行き先は給与と事業に分ける。途中のカードは平均で、内訳なし）
//   goalFrom(a, x, ends, t) 途中のカードの先の行き先（endsFrom の答えを使い回す）
//   setGoalSource / goalViewOf  計算ごとの数の出どころ（アプリが置き、画面の形 src/deepmap/views/goal.ts が読む）
//
// 行き先の 3 つの数: T3 = 今日からそこまで + そこから 36 か月目までの稼ぎ（acc + V）、Rsal = 月給 × 給与の倍率、
// Rbiz = 広告運用・独立 + SpellDash（3 年後の月の稼ぎ。Rsal + Rbiz = Wrr）。資産は 3 つの 1 次式で、係数はどれも 0 以上なので、
// 期限の資産が一番大きい行き先も、要る伸びが一番小さい行き先も、3 つの数のパレート境界の上にある（境界だけ持てば足りる）。

import { assetsAtBy, goalLeaf, growthNeeded, reachYearOf, savingNeeded, SEED_BIZ, type GoalInput, type GoalRead, type GoalTables } from "../../model/goal";
import { F_SUM, ROLE_A, type CompiledMap } from "./compile";
import type { Analysis } from "./passes";
import type { EndsFrom } from "./path";
import { Weighted } from "./stats";

/** パレート境界に持つ行き先の数の上限（今日の手ごと） */
export const FRONTIER_CAP = 64;

/** 3 つの数のパレート境界（大きい方が良い。node はカードの番号） */
export interface GoalFrontier {
  n: number;
  node: Int32Array;
  T3: Float64Array;
  Rsal: Float64Array;
  Rbiz: Float64Array;
  /** 上限を越えて、落とした候補がある */
  capped: boolean;
}

/** 範囲（今日の手 1 つ・おすすめ・ずっと今のまま）の行き先 */
export interface GoalBucket {
  /** 今日の手のノード番号（おすすめ・ずっと今のままは、その選び方の今日の手） */
  node: number;
  /** [T3, Rsal, Rbiz, 見込み] を 4 つずつ（見込みのある行き先だけ） */
  items: Float32Array;
  count: number;
  /** 見込みの合計（ふつう 1） */
  mass: number;
  /** まとめた行き先（標準の続きの見積もり）の見込み */
  est: number;
  /** 芽（Rbiz ≥ SEED_BIZ）の見込み */
  seed: number;
  /** 部分木のどの行き先（見込みの無い物も）の中で一番大きい事業の稼ぎ（万円/月） */
  treeMaxBiz: number;
  /** 部分木のどの行き先も入れた境界（同じ今日の手の範囲は同じ物） */
  frontier: GoalFrontier;
}

export interface GoalBase {
  readonly a: Analysis;
  /** 今日の手ごと（cm.firstMoves の順） */
  readonly moves: readonly GoalBucket[];
  /** おすすめの選び方（今日の選ぶ手が無ければ null） */
  readonly pi: GoalBucket | null;
  /** ずっと今のまま（無ければ null） */
  readonly keep: GoalBucket | null;
  /** 設定ごとの答え（goalOf が覚える） */
  readonly memo: Map<string, GoalSummary>;
}

const bases = new WeakMap<Analysis, GoalBase>();

function emptyFrontier(): GoalFrontier {
  return { n: 0, node: new Int32Array(FRONTIER_CAP), T3: new Float64Array(FRONTIER_CAP), Rsal: new Float64Array(FRONTIER_CAP), Rbiz: new Float64Array(FRONTIER_CAP), capped: false };
}

/** 上限を越えたときに落とす順（仮の設定の係数の比に近い重み。小さい物から落とす） */
const score = (T3: number, Rsal: number, Rbiz: number): number => T3 + 300 * (Rsal + Rbiz);

/** 境界に 1 つ入れる（どれかに負ける物は入れない・新しい物に負ける物は外す） */
function insert(f: GoalFrontier, node: number, T3: number, Rsal: number, Rbiz: number): void {
  const { T3: x, Rsal: y, Rbiz: z } = f;
  for (let k = 0; k < f.n; k++) if (x[k]! >= T3 && y[k]! >= Rsal && z[k]! >= Rbiz) return;
  let w = 0;
  for (let k = 0; k < f.n; k++) {
    if (T3 >= x[k]! && Rsal >= y[k]! && Rbiz >= z[k]!) continue;
    if (w !== k) {
      f.node[w] = f.node[k]!;
      x[w] = x[k]!;
      y[w] = y[k]!;
      z[w] = z[k]!;
    }
    w++;
  }
  f.n = w;
  if (w === FRONTIER_CAP) {
    // 一番小さい物と比べて、大きければ入れ替える
    let lo = 0;
    for (let k = 1; k < w; k++) if (score(x[k]!, y[k]!, z[k]!) < score(x[lo]!, y[lo]!, z[lo]!)) lo = k;
    f.capped = true;
    if (score(T3, Rsal, Rbiz) <= score(x[lo]!, y[lo]!, z[lo]!)) return;
    w = lo;
  } else f.n++;
  f.node[w] = node;
  x[w] = T3;
  y[w] = Rsal;
  z[w] = Rbiz;
}

/**
 * 設定によらない物（計算ごとに 1 回。行き先を 1 回なめるだけで、カードの数の長さの配列は作らない）
 */
export function goalBase(a: Analysis): GoalBase {
  const hit = bases.get(a);
  if (hit) return hit;
  const cm = a.cm;
  const { n, kidOff, first, rank, rr, flags, firstMoves } = cm;
  const { acc } = a.money;
  const S = a.money.S;
  const { V, def, reachIn } = a.pi;
  const reachPi = a.pi.reach;
  const reachKeep = a.keep.reach;
  const nm = firstMoves.length;
  const topPi = a.pi.def[0] ? a.pi.pi[0]! : -1;
  const topKeep = a.keep.def[0] ? a.keep.pi[0]! : -1;
  // 1 回目: 範囲ごとの見込みのある行き先の数
  const cnt = new Int32Array(nm + 2);
  for (let i = 1; i < n; i++) {
    if (kidOff[i] !== kidOff[i + 1] || !def[i]) continue;
    const b = rank[first[i]!]!;
    if (reachIn[i]! > 0) cnt[b] = cnt[b]! + 1;
    if (reachPi[i]! > 0) cnt[nm] = cnt[nm]! + 1;
    if (reachKeep[i]! > 0) cnt[nm + 1] = cnt[nm + 1]! + 1;
  }
  let total = 0;
  const off = new Int32Array(nm + 3);
  for (let b = 0; b < nm + 2; b++) {
    off[b] = total;
    total += cnt[b]!;
  }
  off[nm + 2] = total;
  const items = new Float32Array(total * 4);
  const fill = new Int32Array(nm + 2);
  const mass = new Float64Array(nm + 2);
  const est = new Float64Array(nm + 2);
  const seed = new Float64Array(nm + 2);
  const maxBiz = new Float64Array(nm).fill(-Infinity);
  const frontiers: GoalFrontier[] = [];
  for (let b = 0; b < nm; b++) frontiers.push(emptyFrontier());
  const put = (b: number, T3: number, Rsal: number, Rbiz: number, m: number, sum: boolean): void => {
    const k = (off[b]! + fill[b]!) * 4;
    fill[b] = fill[b]! + 1;
    items[k] = T3;
    items[k + 1] = Rsal;
    items[k + 2] = Rbiz;
    items[k + 3] = m;
    mass[b] = mass[b]! + m;
    if (sum) est[b] = est[b]! + m;
    if (Rbiz >= SEED_BIZ) seed[b] = seed[b]! + m;
  };
  // 2 回目: 3 つの数・芽・境界
  for (let i = 1; i < n; i++) {
    if (kidOff[i] !== kidOff[i + 1] || !def[i]) continue;
    const b = rank[first[i]!]!;
    const i3 = i * 3;
    const T3 = acc[i]! + V[i]!;
    const Rsal = S * rr[i3]!;
    const Rbiz = rr[i3 + 1]! + rr[i3 + 2]!;
    const sum = (flags[i]! & F_SUM) !== 0;
    if (Rbiz > maxBiz[b]!) maxBiz[b] = Rbiz;
    insert(frontiers[b]!, i, T3, Rsal, Rbiz);
    if (reachIn[i]! > 0) put(b, T3, Rsal, Rbiz, reachIn[i]!, sum);
    if (reachPi[i]! > 0) put(nm, T3, Rsal, Rbiz, reachPi[i]!, sum);
    if (reachKeep[i]! > 0) put(nm + 1, T3, Rsal, Rbiz, reachKeep[i]!, sum);
  }
  const bucket = (b: number, node: number, fb: number): GoalBucket => ({
    node,
    items: items.subarray(off[b]! * 4, off[b + 1]! * 4),
    count: cnt[b]!,
    mass: mass[b]!,
    est: est[b]!,
    seed: seed[b]!,
    treeMaxBiz: maxBiz[fb]!,
    frontier: frontiers[fb]!,
  });
  const moves: GoalBucket[] = [];
  for (let b = 0; b < nm; b++) moves.push(bucket(b, firstMoves[b]!, b));
  const out: GoalBase = {
    a,
    moves,
    pi: topPi >= 0 ? bucket(nm, topPi, rank[topPi]!) : null,
    keep: topKeep >= 0 ? bucket(nm + 1, topKeep, rank[topKeep]!) : null,
    memo: new Map(),
  };
  bases.set(a, out);
  return out;
}

/** 設定によらない物を、この計算でもう作ってある（作っていなければ、画面は行き先をなめずに「数えています」を出す） */
export function hasGoalBase(a: Analysis): boolean {
  return bases.has(a);
}

/** 画面が読む資産のゴールの数（設定と、設定によらない物・設定ごとの数） */
export interface GoalView {
  readonly read: GoalRead;
  readonly base: GoalBase;
  readonly summary: GoalSummary;
}

/**
 * 計算ごとの、資産のゴールの数の出どころ（アプリは文書の入口の meta.goal を読む。src/app/deepState.ts）。
 * compute が false なら、作ってある物だけを返す（無ければ null: 行き先をなめない。画面は空いた時間に埋める）
 */
export type GoalSource = (compute: boolean) => GoalView | null;

const sources = new WeakMap<Analysis, GoalSource>();

/** 計算 a の資産のゴールの数の出どころを置く（同じ計算に置き直せば、後の物が使われる） */
export function setGoalSource(a: Analysis, src: GoalSource): void {
  sources.set(a, src);
}

/** 計算 a の資産のゴールの数（出どころが無い・compute が false で作っていなければ null） */
export function goalViewOf(a: Analysis, compute: boolean): GoalView | null {
  return sources.get(a)?.(compute) ?? null;
}

/** 一番良い行き先（境界の中で） */
export interface GoalBest {
  node: number;
  T3: number;
  Rsal: number;
  Rbiz: number;
  /** 期限の年の資産（万円・目安） */
  atBy: number;
  /** 要る事業の伸び（%/年。給与だけ・年 60% でも足りなければ Infinity） */
  gReq: number;
  /** 結果の見込みだけを掛けた見込み（そこへ向かう手を選び続けたら） */
  prob: number;
}

/** 範囲 1 つの数（どれも目安。見込みは範囲の中の割合 0〜1） */
export interface GoalScope {
  /** 今日の手のノード番号（おすすめ・ずっと今のままは、その選び方の今日の手。途中のカードはそのカード） */
  node: number;
  /** 見込みのある行き先の数 */
  n: number;
  /** 期限の年の資産の 10%・50%・90% と平均（万円） */
  atBy: { p10: number; p50: number; p90: number; mean: number } | null;
  /** 期限までに届く見込み（0 なら画面には出さない） */
  pBy: number;
  /** 届く年の 10%・50%（届く行き先の中で。無ければ null）と、REACH_CAP_Y 年先までに届かない見込み */
  reach: { p10: number | null; p50: number | null; unreached: number };
  /** 36 か月目から要る毎月の積立の真ん中（万円/月）と、3 年後の稼ぎの何倍かの真ん中 */
  cReq: number;
  ratioEarn: number;
  /** 要る事業の伸びの真ん中（%/年。出せる行き先の中で。無ければ NaN）と、出せる行き先の見込み */
  gReq: number;
  gShare: number;
  /** 芽の見込み・部分木に芽の行き先があるか・「芽は選び方しだい」（芽の見込みは 0 だが、部分木にはある） */
  seed: number;
  seedExists: boolean;
  choiceOnly: boolean;
  /** 部分木で期限の資産が一番大きい行き先・要る伸びが一番小さい行き先（境界から。途中のカードは null） */
  best: GoalBest | null;
  bestGrow: GoalBest | null;
  /** まとめた行き先の続きの見積もりから出た見込み */
  est: number;
}

export interface GoalSummary {
  readonly key: string;
  readonly tables: GoalTables;
  /** 今日の手ごと（cm.firstMoves の順） */
  readonly moves: readonly GoalScope[];
  readonly pi: GoalScope | null;
  readonly keep: GoalScope | null;
  /** どの範囲・どの一番良い行き先も期限までに届かない（「この地図のどの行き先でも…届きません」） */
  readonly noneReach: boolean;
}

const MEMO = 4;

/** 結果の見込みだけを掛けた見込み（O(深さ)） */
export function chanceOnly(cm: CompiledMap, i: number): number {
  let p = 1;
  for (let c = i; cm.parent[c]! >= 0; c = cm.parent[c]!) if (cm.role[cm.parent[c]!] === ROLE_A) p *= cm.w[c]!;
  return p;
}

function bestOf(cm: CompiledMap, f: GoalFrontier, t: GoalTables): [GoalBest | null, GoalBest | null] {
  let at: GoalBest | null = null;
  let gr: GoalBest | null = null;
  for (let k = 0; k < f.n; k++) {
    const T3 = f.T3[k]!;
    const Rsal = f.Rsal[k]!;
    const Rbiz = f.Rbiz[k]!;
    const atBy = assetsAtBy(t, T3, Rsal, Rbiz);
    const gReq = growthNeeded(t, T3, Rsal, Rbiz);
    const node = f.node[k]!;
    if (!at || atBy > at.atBy || (atBy === at.atBy && gReq < at.gReq)) at = { node, T3, Rsal, Rbiz, atBy, gReq, prob: NaN };
    if (Number.isFinite(gReq) && (!gr || gReq < gr.gReq || (gReq === gr.gReq && atBy > gr.atBy))) gr = { node, T3, Rsal, Rbiz, atBy, gReq, prob: NaN };
  }
  if (at) at.prob = chanceOnly(cm, at.node);
  if (gr) gr.prob = chanceOnly(cm, gr.node);
  return [at, gr];
}

/** 重み付きの 3 つの数から範囲の数を作る */
function scopeOf(t: GoalTables, node: number, items: ArrayLike<number>, count: number, extra: { mass: number; est: number; seed: number; seedExists: boolean; best: GoalBest | null; bestGrow: GoalBest | null }): GoalScope {
  const at = new Weighted();
  const ry = new Weighted();
  const cr = new Weighted();
  const re = new Weighted();
  const gr = new Weighted();
  let reached = 0;
  let unreached = 0;
  let gMass = 0;
  let total = 0;
  for (let k = 0; k < count; k++) {
    const T3 = items[k * 4]!;
    const Rsal = items[k * 4 + 1]!;
    const Rbiz = items[k * 4 + 2]!;
    const m = items[k * 4 + 3]!;
    total += m;
    const A = assetsAtBy(t, T3, Rsal, Rbiz);
    at.add(A, m);
    if (A >= t.T) reached += m;
    const y = reachYearOf(t, T3, Rsal, Rbiz);
    if (y === null) unreached += m;
    else ry.add(y, m);
    const c = savingNeeded(t, T3);
    cr.add(c, m);
    const R = Rsal + Rbiz;
    if (R > 0) re.add(c / R, m);
    const g = growthNeeded(t, T3, Rsal, Rbiz);
    if (Number.isFinite(g)) {
      gr.add(g, m);
      gMass += m;
    }
  }
  const mass = total > 0 ? total : 1;
  const q3 = at.size ? at.quantiles([0.1, 0.5, 0.9]) : null;
  const r2 = ry.size ? ry.quantiles([0.1, 0.5]) : null;
  const seed = extra.mass > 0 ? extra.seed / extra.mass : 0;
  return {
    node,
    n: count,
    atBy: q3 ? { p10: q3[0]!, p50: q3[1]!, p90: q3[2]!, mean: at.mean() } : null,
    pBy: reached / mass,
    reach: { p10: r2 ? r2[0]! : null, p50: r2 ? r2[1]! : null, unreached: unreached / mass },
    cReq: cr.size ? cr.quantiles([0.5])[0]! : NaN,
    ratioEarn: re.size ? re.quantiles([0.5])[0]! : NaN,
    gReq: gr.size ? gr.quantiles([0.5])[0]! : NaN,
    gShare: gMass / mass,
    seed,
    seedExists: extra.seedExists,
    choiceOnly: !(seed > 0) && extra.seedExists,
    best: extra.best,
    bestGrow: extra.bestGrow,
    est: extra.mass > 0 ? extra.est / extra.mass : 0,
  };
}

function bucketScope(cm: CompiledMap, b: GoalBucket, t: GoalTables): GoalScope {
  const [best, bestGrow] = bestOf(cm, b.frontier, t);
  return scopeOf(t, b.node, b.items, b.count, { mass: b.mass, est: b.est, seed: b.seed, seedExists: b.treeMaxBiz >= SEED_BIZ, best, bestGrow });
}

/** 設定ごとの数（同じ計算・同じ設定なら同じ物を返す。4 つまで覚える） */
export function goalOf(base: GoalBase, t: GoalTables): GoalSummary {
  const hit = base.memo.get(t.key);
  if (hit) {
    base.memo.delete(t.key);
    base.memo.set(t.key, hit);
    return hit;
  }
  const cm = base.a.cm;
  const moves = base.moves.map((b) => bucketScope(cm, b, t));
  const pi = base.pi ? bucketScope(cm, base.pi, t) : null;
  const keep = base.keep ? bucketScope(cm, base.keep, t) : null;
  const all = [...moves, ...(pi ? [pi] : []), ...(keep ? [keep] : [])];
  const noneReach = all.every((s) => !(s.pBy > 0) && !(s.best && s.best.atBy >= t.T));
  const out: GoalSummary = { key: t.key, tables: t, moves, pi, keep, noneReach };
  base.memo.set(t.key, out);
  while (base.memo.size > MEMO) base.memo.delete(base.memo.keys().next().value!);
  return out;
}

/**
 * カード 1 枚の 3 つの数。行き先は給与と事業に分ける。途中のカード（O(1)）は今日からそこまで + その先の平均と、
 * 3 年後の月の稼ぎの平均を給与の側に入れる（内訳なし: 芽・事業の伸びは出さない）。数が出せなければ null
 */
export function goalInputAt(a: Analysis, i: number): GoalInput | null {
  const cm = a.cm;
  const { def, V, R } = a.pi;
  if (!def[i]) return null;
  const T3 = a.money.acc[i]! + V[i]!;
  if (cm.kidOff[i] === cm.kidOff[i + 1]) {
    const i3 = i * 3;
    return { T3, Rsal: a.money.S * cm.rr[i3]!, Rbiz: cm.rr[i3 + 1]! + cm.rr[i3 + 2]!, split: true };
  }
  return { T3, Rsal: R[i]!, Rbiz: 0, split: false };
}

/**
 * 途中のカード x の先の行き先の数（endsFrom(a, x) の答えを使い回す）。境界は持たないので一番良い行き先は出さない。
 * 芽があるか（seedExists）は、おすすめの選び方で着く行き先の中だけで見る
 */
export function goalFrom(a: Analysis, x: number, ends: EndsFrom, t: GoalTables): GoalScope {
  const cm = a.cm;
  const S = a.money.S;
  const k = ends.ends.length;
  const items = new Float64Array(k * 4);
  let mass = 0;
  let seed = 0;
  let est = 0;
  let maxBiz = -Infinity;
  for (let j = 0; j < k; j++) {
    const i = ends.ends[j]!;
    const m = ends.mass[j]!;
    const i3 = i * 3;
    const Rbiz = cm.rr[i3 + 1]! + cm.rr[i3 + 2]!;
    items[j * 4] = ends.total[j]!;
    items[j * 4 + 1] = S * cm.rr[i3]!;
    items[j * 4 + 2] = Rbiz;
    items[j * 4 + 3] = m;
    mass += m;
    if (Rbiz >= SEED_BIZ) seed += m;
    if (cm.flags[i]! & F_SUM) est += m;
    if (Rbiz > maxBiz) maxBiz = Rbiz;
  }
  return scopeOf(t, x, items, k, { mass, est, seed, seedExists: maxBiz >= SEED_BIZ, best: null, bestGrow: null });
}

/** 行き先 1 つの数（選んだカード・道の終わり。O(log)） */
export function goalLeafAt(a: Analysis, i: number, t: GoalTables): ReturnType<typeof goalLeaf> | null {
  const x = goalInputAt(a, i);
  return x ? goalLeaf(t, x) : null;
}
