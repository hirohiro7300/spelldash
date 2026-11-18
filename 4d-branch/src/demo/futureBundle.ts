// アプリに同梱する「未来の道筋（仕事・3 年の分かれ道）」。データは文字列のまま持ち、読み込むときに初めて解釈する。
// データは scripts/impact/（決まった計算と点検）で作る: node scripts/impact/run.mjs

import { docCounts, normalizeDoc } from "../model/schema";
import type { ImportPreview } from "../persist/io";
import { buildImpactDoc, countImpact, impactDataVersion, type ImpactBundle, type ImpactCounts, type ImpactRelease } from "./impact";
import raw from "./impact-data.json?raw";
// 版の順番の記録（データを作るときに、中身が変わったら順番を 1 つ進めて書く）
import releaseRec from "./impact-release.json";

/** 判断・選択肢・分かれ道・3 年後の行き先・ノードの数 */
export type FutureStats = ImpactCounts;

export function futureData(): ImpactBundle {
  return JSON.parse(raw) as ImpactBundle;
}

let version: string | null = null;
/** 同梱データの版（中身の指紋。中身が変わると変わる）。読み込んだ未来の道筋の入口に残し、新しい版があるかを見分ける（初めて使うときに 1 度だけ数える） */
export function futureVersion(): string {
  if (version === null) version = impactDataVersion(raw);
  return version;
}

/**
 * 同梱データの版の順番（新しい版ほど大きい）。入口に futureVersion と並べて残し、地図の版がこのページより古いか新しいかを決める
 * （指紋だけでは前後が分からず、古いページが新しい地図を古い版に戻してしまう）。
 * 記録の版の指紋が今のデータと合うか（作り直したのに順番を進め忘れていないか）は、テストで確かめる
 */
export function futureRelease(): number {
  return (releaseRec as ImpactRelease).release;
}

/** 読み込む前の確認に出す文書と数（取り込みと同じ検証を通す） */
export function buildFuture(today = new Date()): { pv: ImportPreview; stats: FutureStats } {
  const data = futureData();
  const { doc, report } = normalizeDoc(buildImpactDoc(data, today, futureVersion(), futureRelease()));
  return { pv: { doc, report, counts: docCounts(doc) }, stats: countImpact(data) };
}
