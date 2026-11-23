// 3 か月ごとの地図（MapData）の番号ごとのカードと親からの線の ID を、地図ごとに 1 度だけ作って使い回す所。
// 設計: 作業メモ SPEC v1 §7.1 の 1・8（見直し perf-1・perf-6・perf-7）。
//
// ID は buildQuarterDoc（./quarterDoc.ts）と同じ: n_i_ / e_i_ + 鍵の 64 ビットの指紋 14 文字（./impact.ts の fnv64x36 と同じ文字）。
// 前は組み立て・見え方の地図の画面（src/app/deepState.ts）・エンジン（src/model/impactGraph.ts）がそれぞれ 7.7 万の鍵の指紋を数え直し、
// ID の文字列と ID → 番号の表をそれぞれ持っていた（起動で 3 回・スマホで 1 回 0.5 秒ほど。表 1 つで約 2 MB）。
//
// 指紋は鍵の 1 文字ずつの FNV-1a（2 つの初めの値）で、区切りまでの途中の値は親の鍵の値そのもの。同梱データの読み手の鍵は「親の鍵 + . + 区切り」
// なので、親の値から区切りの文字だけを足して数える（鍵の長さは平均 80 文字。区切りは数文字）。鍵がその形でないカード（開発用の木など）は、
// 鍵を初めから数える（どちらでも fnv64x36(鍵) と同じ値）。
//
// 返す物は書き換えない約束（凍らせはしない: 7.7 万の要素の配列を凍らせると、それだけで遅い）。

import type { MapData } from "../deepmap/mapData";
import type { BundleMapData } from "./impactBundle";
import type { ID } from "../model/types";

const OFF1 = 0x811c9dc5;
const OFF2 = 0x9e3779b9;
const PRIME = 0x01000193;

/** 36 進の数字（0〜9・a〜z）の文字の番号 */
const D36 = new Uint8Array(36);
for (let d = 0; d < 36; d++) D36[d] = (d < 10 ? 48 : 87) + d;

/** 32 ビットの指紋を、36 進 7 桁（(h >>> 0).toString(36).padStart(7, "0") と同じ文字）の文字の番号で out[at..at+6] に書く */
export function lane36(h: number, out: Uint8Array, at: number): void {
  const x = h >>> 0;
  let y = Math.floor(x / 36);
  out[at + 6] = D36[x - y * 36]!;
  for (let k = 5; k >= 0; k--) {
    const z = (y / 36) | 0;
    out[at + k] = D36[y - z * 36]!;
    y = z;
  }
}

/** 地図の番号ごとの ID と鍵の指紋 */
export interface QuarterIdTable {
  /** カードの ID（n_i_ + 指紋 14 文字） */
  readonly node: readonly ID[];
  /** 親からの線の ID（e_i_ + 子の指紋 14 文字。今日の物も作るが、今日の線は無い） */
  readonly edge: readonly ID[];
  /** 鍵の指紋の 2 つの 32 ビット（重なりを確かめる所が使う） */
  readonly h1: Int32Array;
  readonly h2: Int32Array;
  /** 鍵（map.key(i) と同じ文字列） */
  readonly keys: readonly string[];
}

const memo = new WeakMap<MapData, QuarterIdTable>();

/** 地図の番号ごとの ID（地図ごとに 1 度だけ数える。同じ地図なら同じ物） */
export function quarterIdTable(map: MapData): QuarterIdTable {
  const hit = memo.get(map);
  if (hit) return hit;
  const n = map.n;
  const node = new Array<ID>(n);
  const edge = new Array<ID>(n);
  const keys = new Array<string>(n);
  const H1 = new Int32Array(n);
  const H2 = new Int32Array(n);
  const L = new Uint8Array(14);
  // 同梱データの読み手は鍵の区切りを答える（鍵 = 親の鍵 + . + 区切り）: 鍵の文字を読まずに数える（鍵の文字列は、つないだままの軽い形で
  // 持つ。読むと 1 つにし直すので、7.7 万の鍵で時間とメモリを食う）
  const seg = (map as Partial<BundleMapData>).seg;
  for (let i = 0; i < n; i++) {
    const key = map.key(i);
    keys[i] = key;
    const p = i > 0 ? map.parent(i) : -1;
    let h1 = OFF1;
    let h2 = OFF2;
    if (seg && (i === 0 ? p === -1 : p >= 0 && p < i)) {
      const t = seg.call(map, i);
      if (i > 0) {
        h1 = Math.imul(H1[p]! ^ 46, PRIME);
        h2 = Math.imul(H2[p]! ^ 46, PRIME);
      }
      for (let c = 0; c < t.length; c++) {
        const ch = t.charCodeAt(c);
        h1 = Math.imul(h1 ^ ch, PRIME);
        h2 = Math.imul(h2 ^ ch, PRIME);
      }
    } else {
      let from = 0;
      // 親の鍵 + "." + 区切り: 親の値から続けて数える（親は前の番号: 深さ優先の並び。違えば初めから）
      if (p >= 0 && p < i) {
        const pk = keys[p]!;
        if (key.length > pk.length + 1 && key.charCodeAt(pk.length) === 46 && key.startsWith(pk)) {
          h1 = H1[p]!;
          h2 = H2[p]!;
          from = pk.length;
        }
      }
      for (let c = from; c < key.length; c++) {
        const ch = key.charCodeAt(c);
        h1 = Math.imul(h1 ^ ch, PRIME);
        h2 = Math.imul(h2 ^ ch, PRIME);
      }
    }
    H1[i] = h1;
    H2[i] = h2;
    lane36(h1, L, 0);
    lane36(h2, L, 7);
    node[i] = String.fromCharCode(110, 95, 105, 95, L[0]!, L[1]!, L[2]!, L[3]!, L[4]!, L[5]!, L[6]!, L[7]!, L[8]!, L[9]!, L[10]!, L[11]!, L[12]!, L[13]!);
    edge[i] = String.fromCharCode(101, 95, 105, 95, L[0]!, L[1]!, L[2]!, L[3]!, L[4]!, L[5]!, L[6]!, L[7]!, L[8]!, L[9]!, L[10]!, L[11]!, L[12]!, L[13]!);
  }
  const t: QuarterIdTable = { node, edge, h1: H1, h2: H2, keys };
  memo.set(map, t);
  return t;
}

const revMemo = new WeakMap<MapData, Map<ID, number>>();

/**
 * カードの ID → 地図の番号（地図ごとに 1 つ。保存の基準・地図の画面が同じ表を使う）。同じ ID が 2 つあれば後の番号
 * （組み立ては同じ ID を止めるので、組み立てられた地図では起きない）
 */
export function quarterIdIndex(map: MapData): ReadonlyMap<ID, number> {
  let m = revMemo.get(map);
  if (!m) {
    const ids = quarterIdTable(map).node;
    m = new Map<ID, number>();
    for (let i = 0; i < ids.length; i++) m.set(ids[i]!, i);
    revMemo.set(map, m);
  }
  return m;
}

/** 表を外から覚えさせる（エンジンが地図の列から作った同じ表があれば、それを使う。数が合わなければ覚えない） */
export function adoptQuarterIdIndex(map: MapData, idx: Map<ID, number>): void {
  if (!revMemo.has(map) && idx.size === map.n) revMemo.set(map, idx);
}
