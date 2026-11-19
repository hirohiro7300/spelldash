// 同梱の地図（版 7 の候補・P2 の同梱データ）を、アプリの中で 1 度だけ読んで使い回す所。設計: 作業メモ SPEC v1 §3.3・§7.1 の 1・8（見直し perf-7）
//
//   rememberMapDoc(doc, map): その文書は、その地図を buildQuarterDoc で組み立てたままの物（見え方の計算は、3 年の影響の形を
//                             文書を読み直さずに地図の列から作る: src/model/impactEngine.ts）。組み立てた直後、ストアに渡す前に呼ぶ
//   mapDocOf(doc)           : 組み立てたままとして覚えた文書なら、その地図
//   buildMapDoc(map, at)    : 地図から文書を組み立てて覚える（一時表示 #demo-q。保存の形（W-store）ができるまでの道）
// ストアの全部の入れ替え（読み込み・取り込み・元に戻す）は文書の物が替わるので、覚えた物とは別の文書になる（文書から作り直す）。

import { loadPageMap } from "../demo/pageBundle";
import { buildQuarterDoc } from "../demo/quarterDoc";
import type { MapData } from "../deepmap/mapData";
import type { DocData } from "../model/types";

const built = new WeakMap<DocData, MapData>();

/** その文書は、その地図を組み立てたままの物（形と数を変えると、エンジンが自分で組み立てたままと見なさなくなる） */
export function rememberMapDoc(doc: DocData, map: MapData): void {
  built.set(doc, map);
}

/** 組み立てたままとして覚えた文書の地図（無ければ null） */
export function mapDocOf(doc: DocData): MapData | null {
  return built.get(doc) ?? null;
}

/** 地図から文書を組み立てて覚える（作った時刻 at。位置は列の形） */
export function buildMapDoc(map: MapData, at = Date.now()): DocData {
  const doc = buildQuarterDoc(map, { version: map.header.hash, release: map.header.release, at, layout: "columns" });
  rememberMapDoc(doc, map);
  return doc;
}

/** ページに入れた 3 か月ごとの地図（PAGE_Q のビルドだけ）を組み立てた文書。入っていなければ null（一時表示 #demo-q） */
export async function pageMapDoc(): Promise<DocData | null> {
  const map = await loadPageMap();
  return map ? buildMapDoc(map) : null;
}
