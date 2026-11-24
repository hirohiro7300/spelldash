// アプリの計算（ImpactResult）から出す「資産 10 億円」の数（設計: 作業メモ goal/design.md §4.3・§4.5・§4.6・§4.8）
//   goalCtxOf(doc, imp)            入口の meta.goal と地図の 0 か月目から、前提と年ごとの係数（版 6 の地図は入口の期限 = 作った月から。
//                                  それも無ければ今月から数える）
//   goalCardOf(t, imp, doc, id)    行き先のカードの札（「10 億: 事業が年 +28%・目安」）・芽・ゴールの何割か（カードごとに O(log)）
//   goalFactOf(t, imp, doc, id)    詳細の欄の 1 文（行き先は道の終わりと同じ文、途中のカードはこの後の平均で O(1)）
//   goalImpactStripInput(…)        版 6 の地図の見出しの帯の材料（行き先を見込みの重みで束ねる。版 6 は小さいので行き先をなめてよい）
//   goalImpactStrip(…)             その帯（計算の結果ごと・鍵ごとに覚える: 見出しを描き直すたびに行き先をなめない）
// どの数も 36 か月目より先は前提から出した目安。3 か月ごとの地図（版 7）の帯は src/deepmap/core/goal.ts から出す（行き先をなめない）。

import { goalScopeOf, type GoalBest } from "../deepmap/core/goal";
import type { GoalStripInput } from "../deepmap/views/goal";
import {
  assetsAtBy,
  BIZ_MIN,
  formatOku,
  goalAnchorOfRoot,
  goalBadge,
  goalBand,
  goalConfigOf,
  goalInputOfImpact,
  goalLeaf,
  goalLeafLine,
  goalShareClause,
  growthNeeded,
  SEED_BIZ,
  tablesFor,
  type GoalRead,
  type GoalTables,
} from "./goal";
import type { ImpactResult } from "./impact";
import type { DocData, ID } from "./types";

/** 前提と年ごとの係数 */
export interface GoalCtx {
  read: GoalRead;
  t: GoalTables;
}

/**
 * 入口のカードの meta.goal と 0 か月目（meta.anchor。無ければ入口の期限 time.due = 版 6 の地図を作った月で、見出しの「… → …」と同じ。
 * それも無ければ now() の月から数える）から。入口が無ければ null
 */
export function goalCtxOf(doc: DocData, imp: ImpactResult, now: () => Date = () => new Date()): GoalCtx | null {
  const root = imp.root ? doc.nodes[imp.root] : undefined;
  if (!root) return null;
  const read = goalConfigOf(root);
  return { read, t: tablesFor(read.cfg, goalAnchorOfRoot(root, now)) };
}

/** 行き先のカードに書く物 */
export interface GoalCard {
  /** 札（「10 億: 事業が年 +28%・目安」「10 億: 給与だけでは届かない」「10 億: 2051 年・目安」） */
  text: string;
  /** 芽（3 年後の事業の稼ぎが SEED_BIZ 以上） */
  seed: boolean;
  /** 期限の年の資産がゴールの何割か（0〜1・目安） */
  frac: number;
  /** 期限までに届く（今の前提で） */
  reached: boolean;
  /** 期限の年の資産（万円・目安。地図のゴールへの線の札「2056 年 0.45 億円（5%）目安」） */
  atBy: number;
}

/** 行き先のカード（3 年の分かれ道の行き先だけ）の札。行き先でない・数が出せなければ null */
export function goalCardOf(t: GoalTables, imp: ImpactResult, doc: DocData, id: ID): GoalCard | null {
  if (imp.kind.get(id) !== "leaf") return null;
  const x = goalInputOfImpact(imp, id, doc.nodes[id]?.meta?.rr);
  if (!x) return null;
  const leaf = goalLeaf(t, x);
  return { text: goalBadge(t, leaf), seed: leaf.seed, frac: leaf.frac, reached: leaf.reached, atBy: leaf.atBy };
}

/**
 * 詳細の欄の 1 文。行き先は道の終わりと同じ文（3 年後の月の稼ぎがそのまま続くと…）。途中のカードは、この後一番良く選んで
 * 運は平均のときの 3 年の稼ぎと 3 年後の月の稼ぎ（給与と事業に分けた平均: 事業の伸びの前提も効く）から。数が出せなければ null
 */
export function goalFactOf(t: GoalTables, imp: ImpactResult, doc: DocData, id: ID): string | null {
  const x = goalInputOfImpact(imp, id, doc.nodes[id]?.meta?.rr);
  if (!x) return null;
  if (imp.kind.get(id) === "leaf") {
    const leaf = goalLeaf(t, x);
    return goalLeafLine(t, x, leaf, goalBand(t, x));
  }
  const A = assetsAtBy(t, x.T3, x.Rsal, x.Rbiz);
  const frac = t.T > 0 ? Math.max(0, Math.min(1, A / t.T)) : 1;
  const share = goalShareClause(frac);
  return `この後一番良く選ぶと（運は平均）、${t.by} 年の資産は約 ${formatOku(A, t.T >= 10_000)}（${share ? `${share}・` : ""}目安）。`;
}

/**
 * 版 6 の地図（年月が無く、地図の計算の見取り図も無い）の見出しの帯の材料。行き先をおすすめの選び方の見込みで束ね、
 * 一番近い行き先は範囲のどの行き先（見込みの無い物も）からも探す。行き先が無ければ null
 */
export function goalImpactStripInput(imp: ImpactResult, doc: DocData, g: GoalCtx, key: string): GoalStripInput | null {
  const { t, read } = g;
  const items: number[] = [];
  let count = 0;
  let mass = 0;
  let seed = 0;
  let maxBiz = -Infinity;
  let best: GoalBest | null = null;
  let bestGrow: GoalBest | null = null;
  for (const [id, kind] of imp.kind) {
    if (kind !== "leaf") continue;
    const x = goalInputOfImpact(imp, id, doc.nodes[id]?.meta?.rr);
    if (!x) continue;
    const m = imp.pPi.get(id) ?? 0;
    if (m > 0) {
      items.push(x.T3, x.Rsal, x.Rbiz, m);
      count++;
      mass += m;
      if (x.split && x.Rbiz >= SEED_BIZ) seed += m;
    }
    if (!x.split) continue;
    if (x.Rbiz > maxBiz) maxBiz = x.Rbiz;
    const atBy = assetsAtBy(t, x.T3, x.Rsal, x.Rbiz);
    const gReq = growthNeeded(t, x.T3, x.Rsal, x.Rbiz);
    // カードの番号は地図の計算のためのもの（版 6 には無い）。見込みは出さない
    const b: GoalBest = { node: -1, T3: x.T3, Rsal: x.Rsal, Rbiz: x.Rbiz, atBy, gReq, prob: NaN };
    if (!best || atBy > best.atBy) best = b;
    if (Number.isFinite(gReq) && (!bestGrow || gReq < bestGrow.gReq)) bestGrow = b;
  }
  if (!count) return null;
  const scope = goalScopeOf(t, -1, items, count, { mass, est: 0, seed, seedExists: maxBiz >= SEED_BIZ, best, bestGrow });
  const noneReach = !(scope.pBy > 0) && !(best && best.atBy >= t.T);
  return { key, tables: t, read, scope, items, count, scopes: [scope], anyBiz: maxBiz >= BIZ_MIN, noneReach, moves: 0, spread: NaN, annualNote: null };
}

const stripMemo = new WeakMap<ImpactResult, { key: string; vm: unknown }>();

/**
 * 版 6 の地図の見出しの帯（toVM で画面の形にした物）。計算の結果と鍵（結果の番号・前提の鍵・仮の印）が同じなら前の物を返す
 * （見出しは概要を描き直すたびに呼ばれる。行き先をなめる・利回りを探すのは、結果か前提が変わったときだけ）
 */
export function goalImpactStrip<V>(imp: ImpactResult, doc: DocData, g: GoalCtx, key: string, toVM: (x: GoalStripInput) => V): V | null {
  const hit = stripMemo.get(imp);
  if (hit && hit.key === key) return hit.vm as V | null;
  const x = goalImpactStripInput(imp, doc, g, key);
  const vm = x ? toVM(x) : null;
  stripMemo.set(imp, { key, vm });
  return vm;
}
