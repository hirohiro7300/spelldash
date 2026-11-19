// 版 6 の地図（1,533 枚・v2 の JSON）を凍結した写しを読む（見直し gaps-5）:
//   tests/fixtures/impact-r6.json: 版 6 の同梱データ（src/demo/impact-data.json の版 6 をそのまま写した物。バイトまで同じ）
//   tests/fixtures/impact-r6-release.json: その版の記録 {release: 6, version}（version は impactDataVersion の指紋）
// 「前の版」の意味のテスト（版 6 の鍵・形・2 年の進め方・版 6 の組み立て buildImpactDoc）は、今の同梱データではなく、これを使う。
// 今の同梱データは版 7 から 3 か月ごとの地図に替わる（同期で読む口 futureData なども版 7 を返す）。
// 版 6 のまま凍結した写しの指紋が記録と版の歴史（scripts/impact/releases.json）に合うことは fixturesR6.test.ts で確かめる

import { buildImpactDoc, countImpact, type ImpactBundle, type ImpactCounts, type ImpactRelease } from "../../../src/demo/impact";
import { docCounts, normalizeDoc } from "../../../src/model/schema";
import type { ImportPreview } from "../../../src/persist/io";
import r6Raw from "../../fixtures/impact-r6.json?raw";
import r6Release from "../../fixtures/impact-r6-release.json";

/** 版 6 の同梱データの文字列（指紋 impactDataVersion はこの文字列から） */
export const R6_RAW: string = r6Raw;

/** 版 6 の記録（版の順番 6 と中身の指紋） */
export const R6_RELEASE: Readonly<ImpactRelease> = Object.freeze({ ...(r6Release as ImpactRelease) });

/** 版 6 の同梱データ（読むたびに新しい物。変えてよい） */
export function r6Bundle(): ImpactBundle {
  return JSON.parse(R6_RAW) as ImpactBundle;
}

/**
 * 版 6 の地図を、アプリが読み込むのと同じ検証を通して組み立てる（版 6 のページの buildFuture と同じ。
 * 入口の版と版の順番は凍結した記録の物）
 */
export function buildR6Future(today = new Date()): { pv: ImportPreview; stats: ImpactCounts } {
  const data = r6Bundle();
  const { doc, report } = normalizeDoc(buildImpactDoc(data, today, R6_RELEASE.version, R6_RELEASE.release));
  return { pv: { doc, report, counts: docCounts(doc) }, stats: countImpact(data) };
}
