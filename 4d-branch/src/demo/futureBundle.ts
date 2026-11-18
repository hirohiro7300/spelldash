// アプリに同梱する「未来の道筋（仕事・3 年の分かれ道）」。データは文字列のまま持ち、読み込むときに初めて解釈する。
// データは scripts/impact/（決まった計算と点検）で作る: node scripts/impact/run.mjs

import { docCounts, normalizeDoc } from "../model/schema";
import type { ImportPreview } from "../persist/io";
import { buildImpactDoc, countImpact, type ImpactBundle, type ImpactCounts } from "./impact";
import raw from "./impact-data.json?raw";

/** 判断・選択肢・分かれ道・3 年後の行き先・ノードの数 */
export type FutureStats = ImpactCounts;

export function futureData(): ImpactBundle {
  return JSON.parse(raw) as ImpactBundle;
}

let version: string | null = null;
/** 同梱データの版（中身の指紋。中身が変わると変わる）。読み込んだ未来の道筋の入口に残し、新しい版があるかを見分ける（初めて使うときに 1 度だけ数える） */
export function futureVersion(): string {
  if (version === null) {
    let h = 0x811c9dc5;
    for (let i = 0; i < raw.length; i++) {
      h ^= raw.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    version = `${raw.length.toString(36)}-${h.toString(36)}`;
  }
  return version;
}

/** 読み込む前の確認に出す文書と数（取り込みと同じ検証を通す） */
export function buildFuture(today = new Date()): { pv: ImportPreview; stats: FutureStats } {
  const data = futureData();
  const { doc, report } = normalizeDoc(buildImpactDoc(data, today, futureVersion()));
  return { pv: { doc, report, counts: docCounts(doc) }, stats: countImpact(data) };
}
