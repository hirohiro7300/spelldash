// アプリに同梱する「やりたいことリスト」。データは文字列のまま持ち、読み込むときに初めて解釈する
// （起動のたびに 3,000 件ぶんのオブジェクトを作らない）

import { docCounts, normalizeDoc } from "../model/schema";
import type { ImportPreview } from "../persist/io";
import raw from "./wishlist-data.json?raw";
import { buildWishlistDoc, countWishes, type WishData } from "./wishlist";

export interface WishlistStats {
  areas: number;
  /** 最初の領域の名前（読み込んだ後に寄る所） */
  firstArea: string;
  themes: number;
  wishes: number;
  branches: number;
}

export function wishlistData(): WishData {
  return JSON.parse(raw) as WishData;
}

/** 読み込む前の確認に出す文書と数（取り込みと同じ検証を通す） */
export function buildWishlist(today = new Date()): { pv: ImportPreview; stats: WishlistStats } {
  const data = wishlistData();
  const { doc, report } = normalizeDoc(buildWishlistDoc(data, today));
  const stats: WishlistStats = {
    areas: data.areas.length,
    firstArea: data.areas[0]?.name ?? "",
    themes: data.areas.reduce((n, a) => n + a.themes.length, 0),
    wishes: countWishes(data),
    branches: data.areas.reduce((n, a) => n + a.themes.reduce((m, t) => m + t.branches.length, 0), 0),
  };
  return { pv: { doc, report, counts: docCounts(doc) }, stats };
}
