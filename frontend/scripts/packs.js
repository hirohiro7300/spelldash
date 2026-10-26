// ===== 分野パック（教材ライブラリ） =====
//
// ニッチな業務領域の場面カード集（data/packs/*.json）。manifest で pack:true のカテゴリは
// ユーザーが「追加」するまで読み込まず、ホームのカテゴリにも出ない（増えてもごちゃつかない）。
// 追加したパックの id は端末ローカル（spelldash_packs）。バックアップに含まれる。

import { touchItem } from "./userItemsSync.js";

const KEY = "spelldash_packs";

export function getEnabledPackIds() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list) ? list.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function isPackEnabled(id) {
  return getEnabledPackIds().includes(id);
}

export function setPackEnabled(id, enabled) {
  const current = getEnabledPackIds().filter((x) => x !== id);
  const next = enabled ? [...current, id] : current;
  localStorage.setItem(KEY, JSON.stringify(next));
  touchItem("pack", id, !enabled);
  window.dispatchEvent(new CustomEvent("spelldash:packs", { detail: { id, enabled } }));
  return next;
}

// manifest のカテゴリ配列から、ライブラリに出す分野パックだけを取り出す
export function packsOf(categories) {
  return (categories ?? []).filter((c) => c.pack);
}

// 読み込み対象: 通常カテゴリ＋追加済みパック
export function isCategoryLoaded(category) {
  return !category.pack || isPackEnabled(category.id);
}
