// 試し版のページに埋め込んだ地図のデータを読む（設計: 作業メモ SPEC v1 §3.1・§3.3・§10）
// ページの中の <script type="application/octet-stream" id="deepmap-data" data-format="…"> に base64 で入っている。
// 形（data-format）ごとに読み手がある（registerDecoder で足せる）:
//   impact-bundle-gzip  同梱データ（決まった並びの列と文字列の表を gzip した物。版 7 から。題・短い名前・やることを焼き込んである）。
//                       読み手は W-gen の src/demo/impactBundle.ts（decodeBundle と同じ: gzip を伸ばしてから decodeBundleBytes）。
//                       gzip は DecompressionStream、無いブラウザは小さな伸長（src/demo/inflate.ts）で伸ばす
//   devtree-json-gzip   開発用の入れ子の木（gzip した JSON。開発中の木を確かめる用）。DecompressionStream が要る

import { decodeBundleBytes, gunzipBytes, ImpactBundleError } from "../demo/impactBundle";
import { fromDevTree } from "../deepmap/dev/fromTree";
import type { DevTree, MapData } from "../deepmap/mapData";

export interface EmbeddedMap {
  /** データの形（"devtree-json-gzip" など。画面には出さない） */
  format: string;
  /** 元のファイルの名前（画面には出さない） */
  name: string;
  bytes: Uint8Array;
}

export type MapDecoder = (src: EmbeddedMap) => Promise<MapData>;

/** 読めなかった訳（画面に出す言葉） */
export class LoadError extends Error {
  constructor(
    message: string,
    readonly kind: "missing" | "unsupported" | "format" | "decode",
  ) {
    super(message);
    this.name = "LoadError";
  }
}

export const DATA_ELEMENT_ID = "deepmap-data";
export const DEV_TREE_GZIP = "devtree-json-gzip";
export const BUNDLE_GZIP = "impact-bundle-gzip";

const decoders = new Map<string, MapDecoder>();

/** データの形の読み手を足す（同じ形は置き換える） */
export function registerDecoder(format: string, fn: MapDecoder): void {
  decoders.set(format, fn);
}

export function hasDecompression(): boolean {
  return typeof DecompressionStream === "function";
}

export const NO_DECOMPRESSION =
  "このブラウザは圧縮したデータを開けないため、地図を出せない。新しい Safari（16.4 以降）・Chrome・Edge・Firefox で開いてほしい";

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, "");
  const fromB64 = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64;
  if (typeof fromB64 === "function") return fromB64(clean);
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** gzip をほどいて文字にする（ブラウザの DecompressionStream。無ければ読めない訳を返す） */
export async function gunzipText(bytes: Uint8Array): Promise<string> {
  if (!hasDecompression()) throw new LoadError(NO_DECOMPRESSION, "unsupported");
  try {
    const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).text();
  } catch {
    throw new LoadError("地図のデータが壊れていて開けない（圧縮をほどけなかった）", "decode");
  }
}

/** 開発用の入れ子の木の形か（見出しの版・種類と今日のカード） */
export function asDevTree(x: unknown): DevTree {
  const t = x as Partial<DevTree> | null;
  const hd = t?.header as Partial<DevTree["header"]> | undefined;
  if (!t || typeof t !== "object" || !hd || hd.v !== 3 || hd.kind !== "impact3y" || !t.root || typeof t.root !== "object") {
    throw new LoadError("地図のデータの形が、この試し版の読める形と違う", "format");
  }
  return t as DevTree;
}

registerDecoder(DEV_TREE_GZIP, async (src) => {
  const text = await gunzipText(src.bytes);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new LoadError("地図のデータが壊れていて開けない（中身を読めなかった）", "decode");
  }
  return fromDevTree(asDevTree(json));
});

/** 同梱データの読み手の食い違いの言葉（「同梱データ: 」を除いた物）が、形の違い（別の物・知らない形の版）か */
const OTHER_FORMAT = /同梱データではありません|知らない形の版/;

registerDecoder(BUNDLE_GZIP, async (src) => {
  let raw: Uint8Array;
  try {
    raw = await gunzipBytes(src.bytes);
  } catch {
    throw new LoadError("地図のデータが壊れていて開けない（圧縮をほどけなかった）", "decode");
  }
  try {
    return decodeBundleBytes(raw);
  } catch (e) {
    if (!(e instanceof ImpactBundleError)) throw e;
    const why = e.message.replace(/^同梱データ: /, "");
    if (OTHER_FORMAT.test(why)) throw new LoadError(`地図のデータの形が、この試し版の読める形と違う（${why}）`, "format");
    throw new LoadError(`地図のデータが壊れていて開けない（${why}）`, "decode");
  }
});

/** ページに埋め込んだデータを取り出す */
export function readEmbedded(doc: Document, id = DATA_ELEMENT_ID): EmbeddedMap {
  const el = doc.getElementById(id);
  const text = el?.textContent ?? "";
  if (!el || !text.trim()) throw new LoadError("このページには地図のデータが入っていない（scripts/build-preview.mjs で作ったページで開く）", "missing");
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(text);
  } catch {
    throw new LoadError("地図のデータが壊れていて開けない（文字の並びを読めなかった）", "decode");
  }
  return { format: el.getAttribute("data-format") ?? "", name: el.getAttribute("data-name") ?? "", bytes };
}

/** 形に合う読み手で地図にする */
export async function loadMap(src: EmbeddedMap): Promise<MapData> {
  const dec = decoders.get(src.format);
  if (!dec) throw new LoadError("この試し版が読めない形の地図のデータが入っている", "format");
  return dec(src);
}
