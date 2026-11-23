// 未来の道筋の入口（P2。作業メモ SPEC v1 §10、W-store の §10.1・10.2、W-app の I7）。
// ページに 3 か月ごとの地図を入れたビルド（既定）はその地図（版 7）を開き・比べ、入れないビルド（VITE_IMPACT_Q=0）は同梱の版 6 の地図のまま。
//   pageFutureVersion(): このページの未来の道筋の版（中身の指紋と版の順番）。地図の版が古い・同じ・新しいの見分けに使う。
//                        版 7 は版の記録から分かるので、地図を読み込む前でも同期で答える（版 6 の口で比べると、引き上げた地図を
//                        「このページより新しい」と取り違える）
//   buildPageFuture(at): 開く・差し替える未来の道筋の文書と数。版 7 は保存の基準と同じ文書（ensurePageMap の後の thinBaselineDoc。
//                        組み立てたままとして覚える）。整える（normalizeDoc）のは版 6 だけ（基準のカードは基準と同じ物を使うので写さない）

import type { MapData } from "../deepmap/mapData";
import { buildFuture, futureRelease, futureVersion, type FutureStats } from "../demo/futureBundle";
import { loadPageMap, PAGE_Q, PAGE_Q_RELEASE } from "../demo/pageBundle";
import { docCounts } from "../model/schema";
import { ensurePageMap, pageHash, pageRelease } from "../persist/codec";
import type { ImportPreview } from "../persist/io";
import { buildMapDoc } from "./futureCache";

/** このページの未来の道筋の版（中身の指紋 version・版の順番 release） */
export function pageFutureVersion(): { version: string; release: number } {
  if (PAGE_Q) {
    const version = pageHash() ?? PAGE_Q_RELEASE?.hash ?? null;
    const release = pageRelease() ?? PAGE_Q_RELEASE?.release ?? null;
    if (version !== null && release !== null) return { version, release };
  }
  return { version: futureVersion(), release: futureRelease() };
}

/** このページの未来の道筋が 3 か月ごとの地図（版 7 から）か */
export function pageFutureIsQuarterly(): boolean {
  return PAGE_Q;
}

/** 地図の判断・手・分かれ道・3 年後の行き先・カードの数（版 6 の countImpact と同じ数え方） */
export function mapStats(map: MapData): FutureStats {
  const n = map.n;
  const kids = new Int32Array(n);
  for (let i = 1; i < n; i++) kids[map.parent(i)]!++;
  let decisions = 0;
  let options = 0;
  let forks = 0;
  let ends = 0;
  for (let i = 0; i < n; i++) {
    const r = map.role(i);
    if (kids[i]! >= 2) forks++;
    if ((r === "r" || r === "s") && kids[i]! >= 2) decisions++;
    if (r === "a") options++;
    if (r === "e") ends++;
  }
  return { nodes: n, decisions, options, forks, ends };
}

/** 開く・差し替える未来の道筋（読めなければ例外。呼ぶ側が知らせる） */
export async function buildPageFuture(at = Date.now()): Promise<{ pv: ImportPreview; stats: FutureStats }> {
  if (!PAGE_Q) return buildFuture(new Date(at));
  const map = await loadPageMap();
  if (!map || !(await ensurePageMap())) throw new Error("ページの地図を読めませんでした");
  const doc = buildMapDoc(map, at);
  return { pv: { doc, report: { warnings: [], dropped: { nodes: 0, edges: 0, projects: 0, scenarios: 0 } }, counts: docCounts(doc) }, stats: mapStats(map) };
}
