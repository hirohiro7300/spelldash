// 「3 年の見取り図」の数（設計: 作業メモ SPEC v1 §5.1。作業メモ user-1・user-4・user-13・truth-2・truth-3・truth-18）
// 今日の手ごとに 1 行: その手を選んだ後おすすめの選び方で進んだ 3 年の分布・今やる vs 3 か月待つ・この種類を 3 年やらない場合との差・
// その手で分かること・今のままの先との違い・分かれ道と行き先の数。どれもその手の部分木を 1 回なめるだけ（O(N)）。

import { baseOf, F_BASE, F_STUB, F_SUM, famKey, kindKey, quarterOf, ROLE_A, ROLE_E, ROLE_R, ROLE_S } from "./compile";
import { assertFresh, deltaBetween, likeValue, optionValue, type Analysis, type Delta, type DeltaBasis } from "./passes";
import { distOf, Weighted, type Dist } from "./stats";

/** 今のままの先と「ほぼ同じ」とする違い（3〜33 か月目のおすすめの手の分布の全変動距離の平均） */
export const NEAR_KEEP_TV = 0.1;
/** 今日の差が小さいとする差（万円） */
export const SMALL_DELTA = 5;
/** 「この種類を 3 年やらない場合との差」をほぼ差なしとする差の下限（万円。表の誤差の大きさ。作業メモ truth-3） */
export const WORTH_NOISE = 4;
/** 行き先を「見込みのある物」と数える見込み */
export const END_P_MIN = 0.01;
/**
 * 地図の深さを確かめた年収（万円。生成の一貫性の点検 R1 の 2 つの年収: scripts/impact/q/gen.ts の DEFAULTS.annuals）。この間の年収なら、
 * どの今日の手の一番良い道も 3 か月ごとに 36 か月目まで広げてある（標準の続きの見積もりに入らない）。外の年収では入ることがある（作業メモ truth-5）
 */
export const CHECKED_ANNUALS: readonly [number, number] = [360, 540];

export interface MoveCounts {
  /** 部分木のカードの数 */
  nodes: number;
  /** 判断（手が 2 つ以上の今日・状態） */
  decisions: number;
  /** 出来事の分かれ（結果が 2 つ以上の手） */
  splits: number;
  /** 分かれ道（判断 + 出来事の分かれ） */
  forks: number;
  /** 行き先（まとめた物を含む） */
  ends: number;
  /** まとめた行き先（標準の続きの見積もり） */
  sumEnds: number;
  /** おすすめの選び方で着く本当の行き先（まとめた物を除く・見込みのある物） */
  reachEnds: number;
  /** そのうち見込み 1% 以上 */
  reachEnds1: number;
  /** おすすめの選び方でまとめた行き先に入る見込み（0〜1。ふつう 0） */
  reachSum: number;
}

export interface MoveOutcome {
  node: number;
  /** 結果の名前（生成が書いた名前） */
  label: string;
  /** この手の中の割合（0〜1） */
  w: number;
  /** 書いてある見込み %（整数） */
  p: number;
  /** 確かめるだけの事実と答え（生成が書いた鍵。画面には出さない）。無ければ null */
  rv: [string, string] | null;
  /** この結果になった後、おすすめの選び方で続けた 3 年の合計の見込み */
  total: number;
}

export interface RevealAnswer {
  /** 答えの鍵（画面には出さない） */
  answer: string;
  /** 画面に出す名前（結果の名前から） */
  label: string;
  /** その答えになる見込み（0〜1） */
  share: number;
  outcomes: number[];
  /** その答えの場合の 3 年の合計の見込み */
  total: number;
}

/** その手で分かる事実（会社の答えなど）と、答えごとの分かれ方 */
export interface Reveal {
  /** 事実の鍵（画面には出さない） */
  fact: string;
  /** 画面に出す事実の名前（会社の答え など） */
  label: string;
  answers: RevealAnswer[];
}

/** 事実の鍵（生成が書いた "pm:勤め先の番号" など）から画面に出す名前 */
export function factLabel(fact: string): string {
  return fact.startsWith("pm:") ? "会社の答え" : "分かること";
}

export interface MoveSummary {
  /** 今日の手のノード番号 */
  node: number;
  /** 今日の何番目の手か（並べる順） */
  k: number;
  /** 手の種類（鍵） */
  kind: string;
  /** 手のまとまり（鍵） */
  fam: string;
  isBase: boolean;
  /** 今日のおすすめの手 */
  isPi: boolean;
  /** この手を選んだ後、おすすめの選び方で進んだ今日から 3 年の稼ぎ（地図の値） */
  value: number;
  /** 「今やる vs 3 か月待つ」: この手 − 今日の「この 3 か月は今のまま」。基準が無ければ null */
  delta: Delta | null;
  /** 地図の値での差（差の出し方の違いを見せる用） */
  deltaTree: number | null;
  /** 「この種類を 3 年やらない場合との差」k(fam) = never._all − never[fam]（万円）。無い版・今のままは null */
  worth: number | null;
  /** 3 年の合計の分布（ずっと今のままとの差の段） */
  dist: Dist | null;
  /** この手の結果（並べる順） */
  outcomes: MoveOutcome[];
  /** この手で分かる事実。無ければ null */
  reveals: Reveal | null;
  /** 今のままの先との違い（0 = 同じ・1 = まったく違う）。今のまま自身・比べられなければ null */
  tv: number | null;
  /** 今のままの先とほぼ同じ（tv < 0.1） */
  nearKeep: boolean;
  /** 今日の差が小さい（|Δ| < 5 万円） */
  smallDelta: boolean;
  counts: MoveCounts;
}

export interface Basis {
  /** 今日の差の出し方（今日の手と今のままが全部 q で比べられたら "q"） */
  delta: DeltaBasis;
  /** 「この種類を 3 年やらない場合との差」を出せた（見出しに never._all がある） */
  worth: boolean;
  /** q のある手の数 */
  q: number;
  /** mix のある行き先の数 */
  mix: number;
  /** cont のある行き先の数 */
  cont: number;
  /** 開発用の木（版の順番 0） */
  dev: boolean;
}

export interface Overview {
  annual: number;
  vRoot: number | null;
  vSQ: number | null;
  /** 今日のおすすめの手（無ければ −1） */
  best: number;
  /** 今日の「この 3 か月は今のまま」（無ければ −1） */
  base: number;
  /** 今日から（おすすめの選び方）の 3 年の分布 */
  today: Dist | null;
  /** ずっと今のまま の 3 年の分布（比べる帯） */
  keep: Dist | null;
  moves: MoveSummary[];
  /** 地図全体の数（今日の部分木） */
  counts: MoveCounts;
  basis: Basis;
  /** 「この種類を 3 年やらない場合との差」をほぼ差なしとする大きさ（万円。worthNoise） */
  worthNoise: number;
}

/** k(fam) = w(never._all) − w(never[fam])。無ければ null */
export function worthOf(a: Analysis, fam: string): number | null {
  const nv = a.cm.map.header.never;
  if (!nv || fam === "" || fam === "keep") return null;
  const all = nv._all;
  const f = nv[fam];
  if (!all || !f || fam === "_all") return null;
  const S = a.money.S;
  return S * all[0] + all[1] + all[2] - (S * f[0] + f[1] + f[2]);
}

/**
 * 「この種類を 3 年やらない場合との差」の誤差の大きさ（万円）: 4 と、まとまりの差の一番小さい物（マイナス）の大きさの大きい方。
 * ある種類の手を除いて 3 年の値が上がることは無いので、マイナスの差は見積もりの誤差（作業メモ truth-4。q の木の学校・塾は −5.1〜−6.1）
 */
export function worthNoise(a: Analysis): number {
  const nv = a.cm.map.header.never;
  let noise = WORTH_NOISE;
  if (!nv || !Array.isArray(nv._all)) return noise;
  for (const fam of Object.keys(nv)) {
    const k = worthOf(a, fam);
    if (k !== null && Number.isFinite(k) && -k > noise) noise = -k;
  }
  return noise;
}

/** 今日の手 f の先の、おすすめの道の判断で選べるほかの手（おすすめでない手）の数と、そのうち先を広げていない（まとめた）手の数（作業メモ user-5） */
export function altStubCounts(a: Analysis, f: number): { options: number; stubs: number } {
  const { size, kidOff, kids, role, flags } = a.cm;
  const { reachIn, pi } = a.pi;
  const hi = f + size[f]!;
  let options = 0;
  let stubs = 0;
  for (let d = f + 1; d < hi; d++) {
    const r = role[d]!;
    if ((r !== ROLE_S && r !== ROLE_R) || !(reachIn[d]! > 0) || kidOff[d + 1]! - kidOff[d]! < 2) continue;
    for (let s = kidOff[d]!; s < kidOff[d + 1]!; s++) {
      const j = kids[s]!;
      if (j === pi[d]) continue;
      options++;
      if (flags[j]! & F_STUB) stubs++;
    }
  }
  return { options, stubs };
}

/** 部分木 [lo, hi) の数（形の数は下からの数え上げ、見込みの数は wt から） */
export function countsOf(a: Analysis, lo: number, wt: Float64Array): MoveCounts {
  const { cm } = a;
  const { role, flags, size, nDec, nSplit, nEnd, nSumEnd, kidOff } = cm;
  const hi = lo + size[lo]!;
  let reachEnds = 0;
  let reachEnds1 = 0;
  let reachSum = 0;
  let mass = 0;
  for (let i = lo; i < hi; i++) {
    if (kidOff[i] !== kidOff[i + 1]) continue;
    const m = wt[i]!;
    if (!(m > 0)) continue;
    mass += m;
    if (flags[i]! & F_SUM) {
      reachSum += m;
      continue;
    }
    if (role[i] !== ROLE_E) continue;
    reachEnds++;
    if (m >= END_P_MIN - 1e-12) reachEnds1++;
  }
  return {
    nodes: size[lo]!,
    decisions: nDec[lo]!,
    splits: nSplit[lo]!,
    forks: nDec[lo]! + nSplit[lo]!,
    ends: nEnd[lo]!,
    sumEnds: nSumEnd[lo]!,
    reachEnds,
    reachEnds1,
    reachSum: mass > 0 ? reachSum / mass : 0,
  };
}

/** 部分木 [lo, lo + size) の行き先の 3 年の合計の分布（wt の見込みで） */
export function distIn(a: Analysis, lo: number, wt: Float64Array): Dist | null {
  if (a.vSQ === null) return null;
  const { size, kidOff, flags } = a.cm;
  const { acc } = a.money;
  const { V, def } = a.pi;
  const hi = lo + size[lo]!;
  const items = new Weighted();
  let sum = 0;
  for (let i = lo; i < hi; i++) {
    if (kidOff[i] !== kidOff[i + 1] || !def[i]) continue;
    const m = wt[i]!;
    if (!(m > 0)) continue;
    items.add(acc[i]! + V[i]!, m);
    if (flags[i]! & F_SUM) sum += m;
  }
  return distOf(items, a.vSQ, sum);
}

/** 判断ごとのおすすめの手の分布（3 か月の段 × 手の種類の見込み）。今のままの先との違いに使う */
interface Profile {
  mass: Float64Array;
  alive: Float64Array;
}

function profileOf(a: Analysis, f: number): Profile {
  const { cm } = a;
  const K = Math.max(1, cm.kindNames.length);
  const Q = quarterOf(cm.H) + 1;
  const mass = new Float64Array(Q * K);
  const alive = new Float64Array(Q);
  const { role, month, kind, size } = cm;
  const { reachIn, pi } = a.pi;
  const hi = f + size[f]!;
  for (let i = f + 1; i < hi; i++) {
    if (role[i] !== ROLE_S) continue;
    const m = reachIn[i]!;
    const c = pi[i]!;
    if (!(m > 0) || c < 0) continue;
    const q = Math.min(Q - 1, quarterOf(month[i]!));
    mass[q * K + kind[c]!] = mass[q * K + kind[c]!]! + m;
    alive[q] = alive[q]! + m;
  }
  return { mass, alive };
}

/** 全変動距離の平均（判断のある段だけ。片方にしか判断が無い段は 1） */
function tvBetween(x: Profile, y: Profile, K: number): number | null {
  const Q = x.alive.length;
  let sum = 0;
  let cnt = 0;
  for (let q = 1; q < Q; q++) {
    const ax = x.alive[q]!;
    const ay = y.alive[q]!;
    if (!(ax > 0) && !(ay > 0)) continue;
    cnt++;
    if (!(ax > 0) || !(ay > 0)) {
      sum += 1;
      continue;
    }
    let d = 0;
    for (let k = 0; k < K; k++) d += Math.abs(x.mass[q * K + k]! / ax - y.mass[q * K + k]! / ay);
    sum += d / 2;
  }
  return cnt ? sum / cnt : null;
}

/** 結果の名前の束ね方（「全部可（1 社目あり）」「全部可（顧客まだ）」→「全部可」。頭（かっこと「・」の前）がそろわなければ「／」でつなぐ） */
export function groupLabel(labels: readonly string[]): string {
  const uniq = [...new Set(labels.filter((x) => x))];
  if (uniq.length <= 1) return uniq[0] ?? "";
  const heads = uniq.map((l) => l.split(/[・（]/)[0]!.trim());
  if (heads[0] && heads.every((h) => h === heads[0])) return heads[0];
  return uniq.join("／");
}

/** 手の結果と、その手で分かる事実 */
export function outcomesOf(a: Analysis, f: number): { outcomes: MoveOutcome[]; reveals: Reveal | null } {
  const { cm } = a;
  const { kidOff, kids, w, p, rvFact, rvAns, facts, answers } = cm;
  const { acc } = a.money;
  const { V } = a.pi;
  const map = cm.map;
  const outcomes: MoveOutcome[] = [];
  let fact = -2;
  for (let s = kidOff[f]!; s < kidOff[f + 1]!; s++) {
    const o = kids[s]!;
    const rf = rvFact[o]!;
    outcomes.push({ node: o, label: map.label(o), w: w[o]!, p: p[o]!, rv: rf >= 0 ? [facts[rf]!, answers[rvAns[o]!]!] : null, total: acc[o]! + V[o]! });
    fact = fact === -2 ? rf : fact === rf ? fact : -1;
  }
  if (fact < 0 || outcomes.length < 2) return { outcomes, reveals: null };
  const byAns = new Map<number, RevealAnswer & { labels: string[]; tw: number }>();
  for (const o of outcomes) {
    const ans = rvAns[o.node]!;
    let g = byAns.get(ans);
    if (!g) byAns.set(ans, (g = { answer: answers[ans]!, label: "", share: 0, outcomes: [], total: 0, labels: [], tw: 0 }));
    g.share += o.w;
    g.outcomes.push(o.node);
    g.labels.push(o.label);
    g.tw += o.w * o.total;
  }
  const list: RevealAnswer[] = [];
  for (const g of byAns.values()) list.push({ answer: g.answer, label: groupLabel(g.labels), share: g.share, outcomes: g.outcomes, total: g.share > 0 ? g.tw / g.share : 0 });
  if (list.length < 2) return { outcomes, reveals: null };
  return { outcomes, reveals: { fact: facts[fact]!, label: factLabel(facts[fact]!), answers: list } };
}

/** 見取り図の全部の数（今日の手ごと） */
export function overview(a: Analysis): Overview {
  assertFresh(a);
  const { cm } = a;
  const root = 0;
  const base = baseOf(cm, root);
  const K = Math.max(1, cm.kindNames.length);
  const best = a.pi.def[root] ? a.pi.pi[root]! : -1;
  const keepProfile = base >= 0 ? profileOf(a, base) : null;
  const moves: MoveSummary[] = [];
  let allQ = true;
  cm.firstMoves.forEach((f, k) => {
    const isBase = (cm.flags[f]! & F_BASE) !== 0;
    let delta: Delta | null = null;
    if (base >= 0) delta = f === base ? { d: 0, basis: Number.isFinite(likeValue(a.pi, base)) ? "q" : "tree" } : deltaBetween(a.pi, f, base);
    if (!delta || delta.basis !== "q") allQ = false;
    const vb = base >= 0 ? optionValue(a.pi, base) : NaN;
    const vf = optionValue(a.pi, f);
    const fam = famKey(cm, f);
    const { outcomes, reveals } = outcomesOf(a, f);
    const tv = keepProfile && f !== base ? tvBetween(profileOf(a, f), keepProfile, K) : null;
    moves.push({
      node: f,
      k,
      kind: kindKey(cm, f),
      fam,
      isBase,
      isPi: f === best,
      value: vf,
      delta,
      deltaTree: Number.isFinite(vf) && Number.isFinite(vb) ? vf - vb : null,
      worth: isBase ? null : worthOf(a, fam),
      dist: distIn(a, f, a.pi.reachIn),
      outcomes,
      reveals,
      tv,
      nearKeep: tv !== null && tv < NEAR_KEEP_TV,
      smallDelta: delta !== null && Math.abs(delta.d) < SMALL_DELTA,
      counts: countsOf(a, f, a.pi.reachIn),
    });
  });
  const header = cm.map.header;
  return {
    annual: a.annual,
    vRoot: a.vRoot,
    vSQ: a.vSQ,
    best,
    base,
    today: distIn(a, root, a.pi.reach),
    keep: a.keep.def[root] ? distInKeep(a) : null,
    moves,
    counts: countsOf(a, root, a.pi.reach),
    basis: { delta: allQ && base >= 0 ? "q" : "tree", worth: cm.has.never, q: cm.has.q, mix: cm.has.mix, cont: cm.has.cont, dev: header.release === 0 },
    worthNoise: worthNoise(a),
  };
}

/** ずっと今のまま の 3 年の分布（今日から） */
function distInKeep(a: Analysis): Dist | null {
  if (a.vSQ === null) return null;
  const { n, kidOff, flags } = a.cm;
  const { acc } = a.money;
  const { V, reach } = a.keep;
  const items = new Weighted();
  let sum = 0;
  for (let i = 0; i < n; i++) {
    if (kidOff[i] !== kidOff[i + 1]) continue;
    const m = reach[i]!;
    if (!(m > 0)) continue;
    items.add(acc[i]! + V[i]!, m);
    if (flags[i]! & F_SUM) sum += m;
  }
  return distOf(items, a.vSQ, sum);
}

/**
 * 文章の組み立て（src/demo/compose の composeCard の rt）に渡す、今の年収の計算の芯の答え。画面と本文で同じ「おすすめ」と同じ数を
 * 書くため（作業メモ truth-1・reader-4・reader-8・truth-4）。どれも番号は MapData と同じ
 *   recommended(d)  判断 d で一番良い選び方が選ぶ手（画面の「おすすめ」の印。決まらなければ −1）
 *   treeValue(a)    手 a を選んで、その後を一番良い選び方で進んだ、その判断から 36 か月目までの稼ぎ（数が出せなければ null）
 *   reach(f)        今日の手 f の先で、一番良い選び方で着く本当の行き先の数（見込みのある物）と、そのうち見込み 1% 以上（見取り図と同じ数）
 */
export interface TextRuntime {
  recommended(d: number): number;
  treeValue(a: number): number | null;
  reach(f: number): { ends: number; ends1: number } | null;
}

export function textRuntime(a: Analysis): TextRuntime {
  assertFresh(a);
  const { cm } = a;
  const memo = new Map<number, { ends: number; ends1: number }>();
  return {
    recommended: (d) => (d >= 0 && d < cm.n && a.pi.def[d] ? a.pi.pi[d]! : -1),
    treeValue: (j) => {
      if (j < 0 || j >= cm.n || cm.role[j] !== ROLE_A) return null;
      const v = optionValue(a.pi, j);
      return Number.isFinite(v) ? v : null;
    },
    reach: (f) => {
      if (f < 0 || f >= cm.n || cm.parent[f] !== 0 || cm.role[f] !== ROLE_A) return null;
      let r = memo.get(f);
      if (!r) {
        const c = countsOf(a, f, a.pi.reachIn);
        memo.set(f, (r = { ends: c.reachEnds, ends1: c.reachEnds1 }));
      }
      return r;
    },
  };
}
