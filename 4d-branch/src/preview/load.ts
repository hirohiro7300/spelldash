// 試し版のページに埋め込んだ地図のデータを読む（設計: 作業メモ SPEC v1 §3.3・§10）
// ページの中の <script type="application/octet-stream" id="deepmap-data" data-format="…"> に base64 で入っている。
// 形（data-format）ごとに読み手を差し替えられる: いまは開発用の入れ子の木（gzip した JSON）。
// 同梱データの詰めた形（W-gen の読み手 src/demo/impactBundle.ts）は registerDecoder で足す。

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
