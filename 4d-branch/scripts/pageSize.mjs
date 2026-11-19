// 1 枚のページ（claude.ai の Artifact として公開する）の大きさの上限。公開できるのは 16 MB まで（埋め込んだデータも数える）なので、
// 余裕を見て 15 MB を超えたらページを作らずに止める（scripts/build-artifact.mjs・scripts/build-preview.mjs。見直し gaps-17）。
// 大きさは UTF-8 のバイトで数える（日本語は 1 文字 3 バイト。文字数で数えると小さく見える）

/** 上限（バイト） */
export const PAGE_LIMIT_BYTES = 15 * 1024 * 1024;

/** ページの UTF-8 のバイト数。上限を超えていたら止める（name は知らせに出すページの名前） */
export function assertPageSize(page, name) {
  const bytes = Buffer.byteLength(page, "utf8");
  if (bytes > PAGE_LIMIT_BYTES) throw new Error(`${name} が大きすぎる（${(bytes / 1048576).toFixed(2)} MB。上限 ${PAGE_LIMIT_BYTES / 1048576} MB。公開できるのは 16 MB まで）`);
  return bytes;
}
