// 道の画面（どのカードからでも 2029 年 11 月まで）の数（設計: 作業メモ SPEC v1 §5.4・§5.5。作業メモ user-2 (c)・user-3・user-7）
// 道 = 今日から「道を決めたカード」（pivot）までの親子 + そこから下の一番ありそうな道（判断はおすすめの手、結果は見込みの一番大きい物）。
// 行は 3 か月に 1 つ（判断・選んだ手・結果）。どの行にも、ほかの結果（見込み）とほかの手（選んだ手との差）を付ける。
// ほかの結果や手に切り替えるのは、そのカードを pivot にして walkPath をもう一度呼ぶだけ（約 2,000 のどの分かれ道もたどれる）。
// 続けて同じ手で結果が 1 つか同じ名前の静かな期は 1 つにまとめる（groups）。まとめた手の後は標準の続き（cont）を薄い行で出す。

import { F_BASE, F_STUB, F_SUM, isUnder, kindKey, ROLE_A, type CompiledMap } from "./compile";
import { deltaBetween, type Analysis, type Delta } from "./passes";

export interface PathAltOutcome {
  node: number;
  /** その手の中の割合（0〜1） */
  w: number;
  /** その結果の後、おすすめの選び方で続けた 3 年の合計の見込み */
  total: number;
}

export interface PathAltOption {
  node: number;
  /** 選んだ手との差（この手 − 選んだ手）。数が出せなければ null */
  delta: Delta | null;
  /** おすすめの手 */
  onPi: boolean;
  /** 今のまま */
  isBase: boolean;
  /** まとめた手 */
  stub: boolean;
}

export interface PathRow {
  /** 判断（今日・状態） */
  decision: number;
  /** 選んだ手 */
  option: number;
  /** 結果（次の状態・行き先）。手に結果が無ければ −1 */
  outcome: number;
  /** 判断の月 */
  m: number;
  /** 結果の月（まとめた行き先は 36） */
  mNext: number;
  /** 結果の割合（その手の中で 0〜1） */
  w: number;
  /** 道の始めからこの行の結果までの見込み */
  cum: number;
  /** 結果の時点の月の稼ぎ w(rr)（万円/月） */
  monthly: number;
  /** 今日から結果までの稼ぎ */
  acc: number;
  /** 結果の後、おすすめの選び方で続けた 3 年の合計の見込み */
  total: number;
  /** 選んだ手がおすすめの手 */
  onPi: boolean;
  /** その判断のおすすめの手（数が出せなければ −1） */
  piOption: number;
  /** 結果が、その手の中で一番ありそうな結果（mostLikelyChain が選ぶ物: 割合が一番大きく、同じなら並びの前）。結果が無ければ true */
  likely: boolean;
  /** 選んだ手がまとめた手（結果はまとめた行き先: この先は標準の続き） */
  stub: boolean;
  altOutcomes: PathAltOutcome[];
  altOptions: PathAltOption[];
}

export interface PathGroup {
  /** まとめた行（rows の添え字 from〜to） */
  from: number;
  to: number;
  count: number;
  /** 手の種類（鍵） */
  kind: string;
  /** 静かな期（同じ手で、結果が 1 つか同じ名前）を 2 つ以上まとめた */
  quiet: boolean;
  m: number;
  mNext: number;
  /** まとめた行の結果の割合の積 */
  w: number;
}

export interface PathContRow {
  /** その手を始める月 */
  m: number;
  /** 標準の選び方での手（鍵） */
  kind: string;
  /** 一番ありそうな出来事（文章の組み立ての語彙の名前。画面には文章にして出す） */
  ev: string | null;
}

export interface PathView {
  /** 道の画面を開いたカード */
  from: number;
  /** 道を決めたカード（そこから下は一番ありそうな道） */
  pivot: number;
  /** 道を決めたカードがある行（その行の手か結果。道の始めなら −1） */
  pivotRow: number;
  rows: PathRow[];
  groups: PathGroup[];
  /** 始めから着くまでの見込み（各行の結果の割合の積） */
  p: number;
  /** 着いたカード（ふつう 36 か月目の行き先） */
  end: number;
  /** 着いたのがまとめた行き先（この先は標準の続き） */
  summary: boolean;
  /** まとめた行き先の後の目安（cont）。本当の行き先・cont の無い版は空 */
  cont: PathContRow[];
}

/** 手 j の一番ありそうな結果（割合が一番大きく、同じなら並びの前）。結果が無ければ −1 */
export function likelyOutcome(cm: CompiledMap, j: number): number {
  const { kidOff, kids, w } = cm;
  let best = -1;
  let bw = -1;
  for (let s = kidOff[j]!; s < kidOff[j + 1]!; s++) {
    const c = kids[s]!;
    if (w[c]! > bw) (bw = w[c]!), (best = c);
  }
  return best;
}

/** x から下の一番ありそうな道（判断はおすすめの手、結果は見込みの一番大きい物・同じなら並びの前）。p は x からの見込み */
export function mostLikelyChain(a: Analysis, x: number): { nodes: number[]; p: number } {
  const { kidOff, role, w } = a.cm;
  const { pi } = a.pi;
  const nodes = [x];
  let p = 1;
  let i = x;
  for (;;) {
    const lo = kidOff[i]!;
    const hi = kidOff[i + 1]!;
    if (lo === hi) break;
    let next = -1;
    if (role[i] === ROLE_A) {
      next = likelyOutcome(a.cm, i);
      p *= w[next]!;
    } else next = pi[i]!;
    if (next < 0) break;
    nodes.push(next);
    i = next;
  }
  return { nodes, p };
}

/** 道の画面の数。from は道の画面を開いたカード（pivot の上か pivot 自身。違えば pivot から） */
export function walkPath(a: Analysis, pivot: number, from = 0): PathView {
  const cm = a.cm;
  const { parent, role, kidOff, kids, w, flags, month } = cm;
  const { acc, Wrr } = a.money;
  const { V, pi } = a.pi;
  if (!(pivot >= 0 && pivot < cm.n)) throw new RangeError(`番号が範囲の外です: ${pivot}`);
  const start = from >= 0 && from < cm.n && isUnder(cm, pivot, from) ? from : pivot;
  const prefix: number[] = [];
  for (let x = pivot; x !== start; x = parent[x]!) prefix.push(x);
  prefix.push(start);
  prefix.reverse();
  const chain = mostLikelyChain(a, pivot);
  const nodes = prefix.concat(chain.nodes.slice(1));
  const rows: PathRow[] = [];
  let cum = 1;
  for (let k = 0; k < nodes.length; k++) {
    const opt = nodes[k]!;
    if (role[opt] !== ROLE_A) continue;
    const d = parent[opt]!;
    const out = k + 1 < nodes.length ? nodes[k + 1]! : -1;
    const ww = out >= 0 ? w[out]! : 1;
    cum *= ww;
    const altOutcomes: PathAltOutcome[] = [];
    for (let s = kidOff[opt]!; s < kidOff[opt + 1]!; s++) {
      const c = kids[s]!;
      if (c !== out) altOutcomes.push({ node: c, w: w[c]!, total: acc[c]! + V[c]! });
    }
    const altOptions: PathAltOption[] = [];
    for (let s = kidOff[d]!; s < kidOff[d + 1]!; s++) {
      const j = kids[s]!;
      if (j === opt) continue;
      altOptions.push({ node: j, delta: deltaBetween(a.pi, j, opt), onPi: pi[d] === j, isBase: (flags[j]! & F_BASE) !== 0, stub: (flags[j]! & F_STUB) !== 0 });
    }
    rows.push({
      decision: d,
      option: opt,
      outcome: out,
      m: month[d]!,
      mNext: out >= 0 ? month[out]! : month[opt]!,
      w: ww,
      cum,
      monthly: out >= 0 ? Wrr[out]! : Wrr[opt]!,
      acc: out >= 0 ? acc[out]! : acc[opt]!,
      total: out >= 0 ? acc[out]! + V[out]! : acc[opt]! + V[opt]!,
      onPi: pi[d] === opt,
      piOption: pi[d]!,
      likely: out < 0 || likelyOutcome(cm, opt) === out,
      stub: (flags[opt]! & F_STUB) !== 0,
      altOutcomes,
      altOptions,
    });
  }
  const end = nodes[nodes.length - 1]!;
  const summary = (flags[end]! & F_SUM) !== 0;
  const cont: PathContRow[] = [];
  if (summary) for (const c of cm.map.cont(end) ?? []) cont.push({ m: c.m, kind: c.kind, ev: c.ev ?? null });
  const pivotRow = pivot === start ? -1 : rows.findIndex((r) => r.option === pivot || r.outcome === pivot);
  return { from: start, pivot, pivotRow, rows, groups: groupRows(a, rows), p: cum, end, summary, cont };
}

/** 続けて同じ手で、結果が 1 つか同じ名前の静かな期をまとめる（まとめた手の行はまとめない） */
export function groupRows(a: Analysis, rows: readonly PathRow[]): PathGroup[] {
  const cm = a.cm;
  const map = cm.map;
  const single = (r: PathRow) => cm.kidOff[r.option + 1]! - cm.kidOff[r.option]! === 1;
  const labelOf = (r: PathRow) => (r.outcome >= 0 ? map.label(r.outcome) : "");
  const groups: PathGroup[] = [];
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k]!;
    const g = groups[groups.length - 1];
    if (g && !r.stub) {
      const prev = rows[g.to]!;
      const sameKind = cm.kind[prev.option] === cm.kind[r.option];
      if (sameKind && !prev.stub && ((single(prev) && single(r)) || labelOf(prev) === labelOf(r))) {
        g.to = k;
        g.count++;
        g.quiet = true;
        g.mNext = r.mNext;
        g.w *= r.w;
        continue;
      }
    }
    groups.push({ from: k, to: k, count: 1, kind: kindKey(cm, r.option), quiet: false, m: r.m, mNext: r.mNext, w: r.w });
  }
  return groups;
}
