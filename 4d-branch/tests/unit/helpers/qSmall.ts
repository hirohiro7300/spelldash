// 3 か月ごとの地図の小さい木（tests/fixtures/q-small.*）を読む。既定の単体テストはこれを使い、8 万枚の木は遅いテストだけで使う（見直し gaps-4）。
//   q-small.devtree.json.gz: 開発用の入れ子の木（同梱データの精度に丸めた木。入口の hash は同梱データの中身の指紋）
//   q-small.b64: 同じ木の同梱データ（決まった並びの gzip の base64。src/demo/impactBundle.ts の decodeBundle が読む）
// 作り方（4d-branch で。本物の生成・P2 の前提・「3 年やらない」見積もりつき。小さい予算は分かれ道の数が飛ぶので、目標の幅を広げる）:
//   node scripts/impact/q/run.mjs --out <作業場所>/q-small.devtree.json --bundle <作業場所>/q-small.b64 --budget 80 --tol 12 --only keep,ad_permside,ind_quit --spread 1
//   （作業場所にもう前の物があれば --force を足す）。書き出した q-small.devtree.json.gz と q-small.b64 をここ（tests/fixtures）へ写す。生成を変えたら作り直す
//   （予算 80: 年収 540 の一番良い手も広げる生成 v2 では、今すぐ独立の分かれ道が予算によらず 780 ほどあるので、幅 ±1200% の上限 1,040 に入る予算にした）
// 8,306 枚・最初の手 3 つ（今のまま・届け出て副業・今すぐ独立）。手の q・まとめた行き先の mix と cont・幅・事実・訳 4 つ・入口の never・
// 焼き込んだ題・短い名前・やること（文の型 1.3）がある。一貫性は年収 360・540 のどちらでも守る

import { decodeBundle } from "../../../src/demo/impactBundle";
import type { DevTree, MapData } from "../../../src/deepmap/mapData";
import qSmallB64 from "../../fixtures/q-small.b64?raw";

/** node の読み書き（型の無い環境なので、使う所だけ） */
interface NodeFs {
  readFileSync(p: string | URL): Uint8Array;
  existsSync(p: string | URL): boolean;
}

/** node の fs（テストは node で動く。型の宣言が無いので名前を変数にして読む） */
export async function nodeFs(): Promise<NodeFs> {
  const name = "node:fs";
  return (await import(/* @vite-ignore */ name)) as NodeFs;
}

/** 環境変数（node の process。無ければ undefined） */
export function envVar(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

/** gzip を伸ばす（DecompressionStream。読み手の小さな伸長とは別の道で読む） */
export async function gunzipStream(gz: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([gz as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** gzip に縮める（CompressionStream） */
export async function gzipStream(raw: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([raw as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** gzip した JSON のファイルを読む */
export async function readGzJson<T>(file: string | URL): Promise<T> {
  const fs = await nodeFs();
  return JSON.parse(new TextDecoder().decode(await gunzipStream(fs.readFileSync(file)))) as T;
}

export const Q_SMALL_B64: string = qSmallB64;
export const Q_SMALL_DEVTREE_URL = new URL("../../fixtures/q-small.devtree.json.gz", import.meta.url);

/** 小さい木の開発用の木（読むたびに新しい物） */
export function loadQSmallDevTree(): Promise<DevTree> {
  return readGzJson<DevTree>(Q_SMALL_DEVTREE_URL);
}

let cached: Promise<MapData> | null = null;
/** 小さい木の同梱データを読んだ地図（1 回だけ読む。読むだけなので共有してよい） */
export function loadQSmall(): Promise<MapData> {
  cached ??= decodeBundle(Q_SMALL_B64);
  return cached;
}
