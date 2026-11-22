// ページに入れる 3 か月ごとの地図（版 7 の候補）の切り替え。作業メモ SPEC v1 §10（P2 への切り替え）
//
// 既定のビルド（今の公開版）は版 6 の地図のまま（src/demo/futureBundle.ts）。ここは何も読まず、PAGE_Q は false。
// 開発と確かめのビルドだけ、環境変数で 3 か月ごとの地図の候補をページに入れる:
//   VITE_IMPACT_Q=1 IMPACT_Q_BUNDLE=<impact-q.b64 の絶対パス> npx vite build（vitest も同じ変数を見る）
// 切り替えの後（P2）は、候補の代わりに src/demo/ に置いた同梱データを既定にし、版 6 の読み方を外す。
// 保存（W-store）とアプリ（W-app）は、PAGE_Q と loadPageMap() だけを見て、版 7 の道を足す。

import type { MapData } from "../deepmap/mapData";
import { decodeBundle } from "./impactBundle";
// vite.config.ts と vitest.config.ts の別名で、IMPACT_Q_BUNDLE のファイル（無ければ空のファイル）を文字列のまま読む
import qB64 from "@impact-q-bundle?raw";
// 同じく IMPACT_Q_RELEASE の版の記録（無ければ空の記録 {}）
import qRelease from "@impact-q-release?raw";

/** このビルドが 3 か月ごとの地図（版 7 の候補）をページに入れているか */
export const PAGE_Q: boolean = import.meta.env.VITE_IMPACT_Q === "1" && qB64.trim().length > 0;

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

/**
 * ページに入れた 3 か月ごとの地図を読む（1 度だけ伸ばして読み、2 度目からは同じ約束を返す）。
 * このビルドに入っていなければ null（版 6 のまま）
 */
export function loadPageMap(): Promise<MapData | null> {
  if (!PAGE_Q) return Promise.resolve(null);
  loading ??= decodeBundle(qB64);
  return loading;
}
