// アプリに同梱する「未来の道筋（仕事・3 年の分かれ道）」。データは文字列のまま持ち、読み込むときに初めて解釈する。
// データは scripts/impact/（決まった計算と点検）で作る: node scripts/impact/run.mjs
//
// 読み込みの入口（作業メモ SPEC v1 §3.3・見直し gaps-3）: 同期で読む口（futureData・futureVersion・futureRelease・buildFuture）は、
// 先に await loadImpactBundle() を済ませてから使う。済む前に呼ぶと ImpactBundleNotLoadedError で止まる（黙って空の地図を返さない）。
//   呼ぶ所: main.ts（保存してあった文書を読む前に 1 度）と、単体テストの準備（vitest.config.ts の setupFiles: tests/unit/setup.ts）。
//   アカウントの確かめの台本など、vitest の外でこれらの口を使う物は、使う前に自分で await loadImpactBundle() を呼ぶ。
// 今（版 6）は JSON の文字列がページに入っているので、読み込みは「読んだ」の印を立てるだけ（起動も画面も前と同じ）。
// 版 7（3 か月ごとの地図）からは、gzip + base64 の同梱データ（impact-data.b64）を DecompressionStream（無ければ小さな伸長）で伸ばして
// 読む（src/demo/impactBundle.ts の decodeBundle）ので、ここが待つ所になる。
// P2 では、必要な時だけ読む: 保存してあった文書に地図がある時か、利用者が地図を開く時（gaps-17。main.ts で毎回は読まない）。
// それまでは同期で読む口を呼ぶ前に impactBundleLoaded() で確かめるか、読み込みを待つ。

import { docCounts, normalizeDoc } from "../model/schema";
import type { ImportPreview } from "../persist/io";
import { buildImpactDoc, countImpact, impactDataVersion, type ImpactBundle, type ImpactCounts, type ImpactRelease } from "./impact";
import raw from "./impact-data.json?raw";
// 版の順番の記録（データを作るときに、中身が変わったら順番を 1 つ進めて書く）
import releaseRec from "./impact-release.json";

/** 判断・選択肢・分かれ道・3 年後の行き先・ノードの数 */
export type FutureStats = ImpactCounts;

/** 同梱の地図を読み込む前に、同期で読む口を呼んだ */
export class ImpactBundleNotLoadedError extends Error {
  override name = "ImpactBundleNotLoadedError";
  constructor(what: string) {
    super(`同梱の地図をまだ読み込んでいません（${what} の前に await loadImpactBundle() を呼ぶ。src/demo/futureBundle.ts）`);
  }
}

/** 読み込み（1 度だけ。2 度目からは同じ約束を返す） */
let loading: Promise<void> | null = null;
/** 読み込みが済んだ */
let loaded = false;

/**
 * 同梱の地図を読み込む（1 度だけ。何度呼んでも同じ約束を返し、2 度目からは何もしない）。済んだ後は、同期で読む口が使える。
 * 版 6 は文字列を持っているだけなので、すぐに済む（解釈は今までどおり、口を呼んだ時）
 */
export function loadImpactBundle(): Promise<void> {
  loading ??= Promise.resolve().then(() => {
    loaded = true;
  });
  return loading;
}

/** 同梱の地図を読み込んだか（loadImpactBundle が済んだか） */
export function impactBundleLoaded(): boolean {
  return loaded;
}

/** 読み込む前に呼ばれたら止める */
function need(what: string): void {
  if (!loaded) throw new ImpactBundleNotLoadedError(what);
}

export function futureData(): ImpactBundle {
  need("futureData");
  return JSON.parse(raw) as ImpactBundle;
}

let version: string | null = null;
/** 同梱データの版（中身の指紋。中身が変わると変わる）。読み込んだ未来の道筋の入口に残し、新しい版があるかを見分ける（初めて使うときに 1 度だけ数える） */
export function futureVersion(): string {
  need("futureVersion");
  if (version === null) version = impactDataVersion(raw);
  return version;
}

/**
 * 同梱データの版の順番（新しい版ほど大きい）。入口に futureVersion と並べて残し、地図の版がこのページより古いか新しいかを決める
 * （指紋だけでは前後が分からず、古いページが新しい地図を古い版に戻してしまう）。
 * 記録の版の指紋が今のデータと合うか（作り直したのに順番を進め忘れていないか）は、テストで確かめる
 */
export function futureRelease(): number {
  need("futureRelease");
  return (releaseRec as ImpactRelease).release;
}

/** 読み込む前の確認に出す文書と数（取り込みと同じ検証を通す） */
export function buildFuture(today = new Date()): { pv: ImportPreview; stats: FutureStats } {
  need("buildFuture");
  const data = futureData();
  const { doc, report } = normalizeDoc(buildImpactDoc(data, today, futureVersion(), futureRelease()));
  return { pv: { doc, report, counts: docCounts(doc) }, stats: countImpact(data) };
}
