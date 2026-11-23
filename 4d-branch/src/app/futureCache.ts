// 同梱の地図（版 7 の候補・P2 の同梱データ）を、アプリの中で 1 度だけ読んで使い回す所。設計: 作業メモ SPEC v1 §3.3・§7.1 の 1・8（見直し perf-7）
//
//   rememberMapDoc(doc, map): その文書は、その地図を buildQuarterDoc で組み立てたままの物（見え方の計算は、3 年の影響の形を
//                             文書を読み直さずに地図の列から作る: src/model/impactEngine.ts）。組み立てた直後、ストアに渡す前に呼ぶ
//   mapDocOf(doc)           : 組み立てたままとして覚えた文書なら、その地図
//   buildMapDoc(map, at)    : 地図から文書を組み立てて覚える（ページの地図なら保存の基準の文書。一時表示 #demo-q・未来の道筋を開く）
// ストアの全部の入れ替え（読み込み・取り込み・元に戻す）は文書の物が替わるので、覚えた物とは別の文書になる（文書から作り直す）。

import { loadPageMap } from "../demo/pageBundle";
import { buildQuarterDoc } from "../demo/quarterDoc";
import { ensurePageMap, hasThinBaseline, pageHash, pageMapData, pageRelease, storedMapShaped, thinBaselineDoc, THIN_LAYOUT } from "../persist/codec";
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

/**
 * その文書を組み立てたままと見てよい地図: 覚えた文書ならその地図、保存した形から読んだ文書で、地図の形と数を変えていない物
 * （src/persist/codec.ts の storedMapShaped）ならページの地図。どちらでもなければ null
 */
export function mapForDoc(doc: DocData): MapData | null {
  return built.get(doc) ?? (storedMapShaped(doc) ? pageMapData() : null);
}

/**
 * 文書 doc をストアに入れた後の文書 into（ストアが入れる直前に写した物。中身は doc と同じ）を、doc と同じ地図の文書として覚える
 * （Store.replaceDoc の onDoc に渡す。変更を知らせる前に覚えるので、見え方とエンジンは地図の列から作る: W-app の I1・I4）
 */
export function carryMapDoc(doc: DocData): (into: DocData) => void {
  const map = mapForDoc(doc);
  return (into) => {
    if (map) rememberMapDoc(into, map);
  };
}

/**
 * 地図から文書を組み立てて覚える（作った時刻 at）。位置は保存の基準と同じ形（THIN_LAYOUT "none": カードの位置は持たず、
 * 画面の位置は見え方の重ねる位置から。カードに位置を書くと、保存でどのカードも変更になる: W-app の I2）。
 * ページの地図なら、保存の基準の文書（thinBaselineDoc。カードは基準と同じ物を使う）
 */
export function buildMapDoc(map: MapData, at = Date.now()): DocData {
  const page = hasThinBaseline() && pageHash() === map.header.hash && pageRelease() === map.header.release;
  const doc = page ? thinBaselineDoc({ at: new Date(at).toISOString() }) : buildQuarterDoc(map, { version: map.header.hash, release: map.header.release, at, layout: THIN_LAYOUT });
  rememberMapDoc(doc, map);
  return doc;
}

/**
 * ページに入れた 3 か月ごとの地図（PAGE_Q のビルドだけ）を組み立てた文書。入っていなければ null（一時表示 #demo-q）。
 * before: 文書を組み立てる前に呼ぶ（見取り図だけを先に描く: src/ui/deepSplash.ts。8 万枚の組み立てを待たせない: SPEC §7.2・user-18）
 */
export async function pageMapDoc(before?: (map: MapData) => Promise<void>): Promise<DocData | null> {
  const map = await loadPageMap();
  if (!map) return null;
  if (before) await before(map);
  // 保存の基準と同じ文書にする（地図を読み込み方に入れたページなら、ここで基準に入れる）
  await ensurePageMap();
  return buildMapDoc(map);
}
