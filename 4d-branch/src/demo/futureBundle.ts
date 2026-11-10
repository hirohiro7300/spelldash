// アプリに同梱する「未来の道筋（仕事・10 年）」。データは文字列のまま持ち、読み込むときに初めて解釈する

import { computeForecast } from "../model/forecast";
import { buildIndex } from "../model/graph";
import { docCounts, normalizeDoc } from "../model/schema";
import type { ImportPreview } from "../persist/io";
import { buildFutureDoc, countFuture, type FutureData } from "./future";
import raw from "./future-data.json?raw";

export interface FutureStats {
  /** 歩み（節目の間の作業・出来事・分かれ道） */
  steps: number;
  /** 分かれ道 */
  forks: number;
  /** 10 年後の行き先 */
  ends: number;
  /** 今日から行き先までの歩数（いちばん短い道・長い道） */
  shortest: number;
  longest: number;
}

export function futureData(): FutureData {
  return JSON.parse(raw) as FutureData;
}

/** 読み込む前の確認に出す文書と数（取り込みと同じ検証を通す） */
export function buildFuture(today = new Date()): { pv: ImportPreview; stats: FutureStats } {
  const data = futureData();
  const { doc, report } = normalizeDoc(buildFutureDoc(data, today));
  const c = countFuture(data);
  const fc = computeForecast(doc, buildIndex(doc).out);
  const shortest = fc.ends.length ? Math.min(...fc.ends.map((id) => fc.reach.get(id)!.minSteps)) : 0;
  return { pv: { doc, report, counts: docCounts(doc) }, stats: { steps: c.steps, forks: c.forks, ends: c.ends, shortest, longest: fc.longest } };
}
