// ページに入れる 3 か月ごとの地図の切り替え。作業メモ SPEC v1 §10（P2 への切り替え）
//
// P2 からは、既定のビルドが版 7 の地図（src/demo/impact-q.b64 と版の記録 src/demo/impact-q-release.json）を入れる（PAGE_Q は true）。
// 版 6 の地図（src/demo/futureBundle.ts）はページに残す: 保存してあった版 6 の地図を読むときの引き上げと、新しい地図の知らせの「前の版」の差に使う。
// 切り替え（vite.config.ts の impactQAlias。vitest も同じ変数を見る）:
//   VITE_IMPACT_Q=0: 地図を入れない（版 6 だけのページ。前の版のページを確かめるテストのため）
//   VITE_IMPACT_Q=1 IMPACT_Q_BUNDLE=<impact-q.b64 の絶対パス> [IMPACT_Q_RELEASE=<版の記録>]: 生成の候補を入れる
// 保存（W-store）とアプリ（W-app）は、PAGE_Q と loadPageMap() だけを見て、版 7 の道を足す。

import type { MapData } from "../deepmap/mapData";
import { decodeBundle } from "./impactBundle";
// vite.config.ts と vitest.config.ts の別名で、ページに入れる地図のファイル（入れないビルドは空のファイル）を文字列のまま読む
import qB64 from "@impact-q-bundle?raw";
// 同じくその地図の版の記録（入れないビルド・記録を渡さない候補は空の記録 {}）
import qRelease from "@impact-q-release?raw";

/** このビルドが 3 か月ごとの地図をページに入れているか（既定は入れる。VITE_IMPACT_Q=0 のビルドだけ入れない） */
export const PAGE_Q: boolean = import.meta.env.VITE_IMPACT_Q !== "0" && qB64.trim().length > 0;

/** ページに入れた地図の版の記録（src/demo/impact-release.json と同じ形。digest は基準の文書の指紋: 作業メモ SPEC §3.1・§6） */
export interface PageMapRelease {
  release: number;
  hash: string;
  digest?: string;
  anchor: string;
}

/** 版の記録の文字を読む（形が違えば null） */
function parseRelease(text: string): PageMapRelease | null {
  try {
    const o = JSON.parse(text) as Partial<PageMapRelease>;
    if (typeof o.release !== "number" || typeof o.hash !== "string" || typeof o.anchor !== "string") return null;
    return { release: o.release, hash: o.hash, anchor: o.anchor, ...(typeof o.digest === "string" && o.digest ? { digest: o.digest } : {}) };
  } catch {
    return null;
  }
}

/**
 * ページに入れた地図の版の記録（無ければ null）。基準の文書の指紋 digest があれば、起動で数え直さずに使い（見直し code-2）、
 * 地図と合うかは tests/unit/pageRelease.test.ts が確かめる
 */
export const PAGE_Q_RELEASE: PageMapRelease | null = PAGE_Q ? parseRelease(qRelease) : null;

let loading: Promise<MapData> | null = null;
/** 読み終えた地図（読み終えるまで null） */
let loadedMap: MapData | null = null;

/**
 * ページに入れた 3 か月ごとの地図を読む（1 度だけ伸ばして読み、2 度目からは同じ約束を返す）。
 * このビルドに入っていなければ null（版 6 のまま）
 */
export function loadPageMap(): Promise<MapData | null> {
  if (!PAGE_Q) return Promise.resolve(null);
  loading ??= decodeBundle(qB64).then((m) => (loadedMap = m));
  return loading;
}

/**
 * もう読み終えたページの地図（まだなら null。読み始めない）。保存してあった物を読むときに読み終えていれば、画面は起動の最初から地図を使う
 * （読み終えた知らせを待って画面を 2 度作らない: 見直し perf-1）
 */
export function pageMapIfLoaded(): MapData | null {
  return loadedMap;
}
