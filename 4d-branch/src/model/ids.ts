import type { ID } from "./types";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * 端末ごとに衝突しない乱数の ID（12 文字・約 62 ビット）。
 * 接頭辞で種類がわかる: n ノード / e 接続 / p プロジェクト / s シナリオ / c 条件 / d ドキュメント / b バックアップ / t タブ
 */
export function newId(prefix: "n" | "e" | "p" | "s" | "c" | "d" | "b" | "t"): ID {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += ALPHABET[b % 36];
  return `${prefix}_${s}`;
}

export function nowISO(): string {
  return new Date().toISOString();
}

/**
 * ドキュメントの更新時刻を進める。前の時刻より必ず後になる
 * （同じミリ秒に続いた変更・時計が戻ったとき・古い時刻を持つファイルやバックアップを読み込んだときでも、
 * 「新しい方」の比べ方が崩れない。緊急コピーと同期が頼る）
 */
export function nextStamp(prev: string | undefined): string {
  const now = Date.now();
  const p = prev ? Date.parse(prev) : Number.NaN;
  return new Date(Number.isFinite(p) && p >= now ? p + 1 : now).toISOString();
}
