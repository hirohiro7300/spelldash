// 3 か月ごとの地図（版 7）を、時間で区切って開く（「全部ひらく」の代わり）。設計: 作業メモ SPEC v1 §5.8（見直し user-12・gaps-17）
//
// あるカードから「1 年先まで」開く = そのカードの先で、月が（そのカードの月 + 12）より前の判断・手をすべて開く。
// 月は今日から先へ減らないので、見えるのは「親の月が区切りより前」のカード（区切りの月の状態・行き先までが見える）。
// まとめた手（区切りより前）の行き先は 36 か月目でも見える（キャンバスでは 2029 年 11 月の列に置く）。
// 開いた後に見えるカードの数は、地図の番号の深さ優先の順（先は [i, i + size)）を 1 回なめて数える（O(先の数)。8 万枚でも 1 ms 前後）。
// 開いた後のキャンバス全体（すでに見えているカードを含む）が上限（3,000 枚）を超える区切りは開かず、見取り図で見るよう勧める（user-12）。

import type { CompiledMap } from "../deepmap/core/compile";

/** 開いた後にキャンバスに見えるカードの上限（全体で） */
export const DEEP_OPEN_CAP = 3000;

/**
 * 1 つの区切りで開いた後の、並びの行の数の上限（行 = 開いた先で、先を開いていないカード。キャンバスの行の高さ 128 px で約 4 万 px:
 * 一番引いた 4% で 2 画面ほど）。これより縦に長い区切りは、キャンバスでは読めない（今日の「1 年先まで」は 1,400 行・18 万 px）ので
 * 見取り図で見る（見直し user-8）。今日の手ごとの「1 年先まで」（80〜180 行）は開ける
 */
export const DEEP_OPEN_ROWS = 320;

export interface DeepHorizon {
  /** 何か月先まで（12・24・36。地図の終わりまでなら、その手前で 1 つにまとめる） */
  months: number;
  /** 区切りの月（今日から。この月より前の判断・手を開く） */
  limit: number;
  /** 地図の終わり（2029 年 11 月）まで届く */
  toEnd: boolean;
  /** 開いた後に見える、そのカードの先のカードの数（そのカードは含まない） */
  count: number;
  /** 開いた後の並びの行の数（見える先のカードのうち、その先を開いていない物。キャンバスの高さ = 行 × 128 px） */
  rows: number;
}

/** カード i の先を、月 limit より前の判断・手まで開いたときに見えるカードの数と、開くカード */
export function openUntil(cm: CompiledMap, i: number, limit: number): { count: number; open: number[] } {
  const { size, parent, month, kidOff } = cm;
  const end = i + size[i]!;
  const open: number[] = [];
  let count = 0;
  for (let j = i; j < end; j++) {
    if (j > i) {
      const p = parent[j]!;
      // 親が開く（親の月が区切りより前）と見える。月は先へ減らないので、親の親も開いている
      if (!(month[p]! < limit)) continue;
      count++;
    }
    if (month[j]! < limit && kidOff[j + 1]! > kidOff[j]!) open.push(j);
  }
  return { count, open };
}

/** 区切り h で開くカード（地図の番号。押したときに数える） */
export function horizonOpen(cm: CompiledMap, i: number, h: DeepHorizon): number[] {
  return openUntil(cm, i, h.toEnd ? Infinity : h.limit).open;
}

/**
 * カード i から 1 年先・2 年先・地図の終わりまで（地図の終わりを超える区切りは 1 つにまとめる）。
 * 数は先を 1 回なめて、区切りごとにまとめて数える（カードを選ぶたびに作るので、開くカードの並びは作らない: horizonOpen）
 */
export function deepHorizons(cm: CompiledMap, i: number): DeepHorizon[] {
  const m0 = cm.month[i]!;
  const H = cm.H;
  const cands: Array<{ months: number; limit: number; toEnd: boolean; lim: number }> = [];
  for (const months of [12, 24, 36]) {
    const limit = Math.min(H, m0 + months);
    const toEnd = m0 + months >= H;
    if (cands.some((c) => c.limit === limit)) continue;
    cands.push({ months: toEnd ? H - m0 : months, limit, toEnd, lim: toEnd ? Infinity : limit });
    if (toEnd) break;
  }
  // 区切りは小さい順。親の月が入る一番小さい区切りに 1 つ数え、後で足し上げる（大きい区切りは小さい区切りの物を含む）。
  // 行（見えて、先を開いていないカード）は、見え始める区切りで 1 つ足し、そのカード自身が開く区切りで 1 つ引く
  const { size, parent, month, kidOff } = cm;
  const end = i + size[i]!;
  const first = new Array<number>(cands.length).fill(0);
  const rowsD = new Array<number>(cands.length + 1).fill(0);
  const firstIn = (m: number): number => {
    for (let c = 0; c < cands.length; c++) if (m < cands[c]!.lim) return c;
    return cands.length;
  };
  for (let j = i + 1; j < end; j++) {
    const c1 = firstIn(month[parent[j]!]!);
    if (c1 >= cands.length) continue;
    first[c1]!++;
    rowsD[c1]!++;
    if (kidOff[j + 1]! > kidOff[j]!) rowsD[firstIn(month[j]!)]!--;
  }
  const out: DeepHorizon[] = [];
  let count = 0;
  let rows = 0;
  for (let c = 0; c < cands.length; c++) {
    count += first[c]!;
    rows += rowsD[c]!;
    const x = cands[c]!;
    // 先が無い（行き先）・開いても何も増えない区切りは出さない
    if (!count) continue;
    out.push({ months: x.months, limit: x.limit, toEnd: x.toEnd, count, rows });
  }
  return out;
}
