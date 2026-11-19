// 鍵（meta.key）のある地図のカードの決まり。薄い形の保存（./thinMap.ts）と、地図を新しい版にする差し替え（src/demo/futureSwap.ts）が同じ物を使う

import type { GNode, ID } from "../model/types";

/**
 * 同じ鍵のカードのうち、a を b より先の物（地図のカード）とみるか: 入口からたどれる物（たどれる物が無いときだけ外れた物。作った時刻より先に見る）、
 * その中で先に作った物、同じ時刻なら入口に近い物、それも同じなら ID の順。depth は入口から道の線でたどった深さ（たどれない物は無い）
 */
export function madeFirst(a: GNode, b: GNode, depth: ReadonlyMap<ID, number>): boolean {
  const da = depth.get(a.id) ?? Infinity;
  const db = depth.get(b.id) ?? Infinity;
  if ((da === Infinity) !== (db === Infinity)) return da !== Infinity;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt;
  return da !== db ? da < db : a.id < b.id;
}
