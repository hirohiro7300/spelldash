// 同梱の地図（版 7 の候補・P2 の同梱データ）を、アプリの中で 1 度だけ読んで使い回す所。設計: 作業メモ SPEC v1 §3.3・§7.1 の 1・8（見直し perf-7）
//
//   rememberMapDoc(doc, map): その文書は、その地図を buildQuarterDoc で組み立てたままの物（見え方の計算は、3 年の影響の形を
//                             文書を読み直さずに地図の列から作る: src/model/impactEngine.ts）。組み立てた直後、ストアに渡す前に呼ぶ
//   mapDocOf(doc)           : 組み立てたままとして覚えた文書なら、その地図
//   buildMapDoc(map, at)    : 地図から文書を組み立てて覚える（ページの地図なら保存の基準の文書。一時表示 #demo-q・未来の道筋を開く）
//   forgetMapDoc(doc)       : 形か数を書き換えた文書を忘れる（見え方が、変更を受けたときに呼ぶ）
// 全部の入れ替えの元に戻す・やり直すは、前の文書の物そのものに戻る（W-app の I4）。覚えた文書を書き換えたら忘れる（見直し data-1）。

import { loadPageMap } from "../demo/pageBundle";
import { buildQuarterDoc } from "../demo/quarterDoc";
import { ensurePageMap, forgetStoredShape, hasThinBaseline, pageHash, pageMapData, pageRelease, storedMapShaped, thinBaselineDoc, THIN_LAYOUT } from "../persist/codec";
import type { MapData } from "../deepmap/mapData";
import type { DocData } from "../model/types";

const built = new WeakMap<DocData, MapData>();
/** 組み立てた後に形か数を書き換えた文書（地図はそのままだが、組み立てたままとは見なさない） */
const edited = new WeakSet<DocData>();

/** その文書は、その地図を組み立てたままの物（形と数を変えると、エンジンが自分で組み立てたままと見なさなくなる） */
export function rememberMapDoc(doc: DocData, map: MapData): void {
  built.set(doc, map);
  edited.delete(doc);
}

/**
 * その文書はもう組み立てたままではない（形か数を書き換えた: 見え方が、エンジンが組み立てたままと見なさなくなったときに呼ぶ）。
 * 覚えた物も、保存した形から読んだときの印も忘れる。ストアは文書をその場で書き換え、元に戻す・やり直すは同じ文書の物に戻るので、
 * 忘れないと、全部の入れ替えの元に戻すで書き換えた見込みを無視して地図の列から数を作ってしまう（見直し data-1）
 */
export function forgetMapDoc(doc: DocData): void {
  if (built.has(doc)) edited.add(doc);
  forgetStoredShape(doc);
}

/** 組み立てたままとして覚えた文書の地図（無い・書き換えた後なら null） */
export function mapDocOf(doc: DocData): MapData | null {
  return edited.has(doc) ? null : (built.get(doc) ?? null);
}

/** その文書を組み立てた地図（書き換えた後でも。地図の画面の入口を見分ける所だけ: src/app/deepState.ts） */
export function mapOfBuiltDoc(doc: DocData): MapData | null {
  return built.get(doc) ?? null;
}

/**
 * その文書を組み立てたままと見てよい地図: 覚えた文書ならその地図、保存した形から読んだ文書で、地図の形と数を変えていない物
 * （src/persist/codec.ts の storedMapShaped）ならページの地図。どちらでもなければ null
 */
export function mapForDoc(doc: DocData): MapData | null {
  return mapDocOf(doc) ?? (!edited.has(doc) && storedMapShaped(doc) ? pageMapData() : null);
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
