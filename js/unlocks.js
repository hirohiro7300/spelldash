import { getWordStats } from "./storage.js";

// ===== 遊び方の解放 =====
//
// 1画面目は「いまの道＋スタート」だけにして、Daily Dash と Battle は数セットこなしてから見せる。
// 最初から全部見せると選ぶことが増えて、初回の人が迷う。既存ユーザー（学習データがある人）は最初から解放。

const TOTAL_KEY = "spelldash_sets_total";

export const UNLOCK_AT = { challenge: 0, daily: 2, battle: 5 };

export function getTotalSets() {
  return Number(localStorage.getItem(TOTAL_KEY)) || 0;
}

export function bumpTotalSets() {
  const next = getTotalSets() + 1;
  localStorage.setItem(TOTAL_KEY, String(next));
  return next;
}

// 学習データが30語以上ある人は「以前から使っている人」として全部解放
function isVeteran() {
  return Object.keys(getWordStats()).length >= 30;
}

export function isUnlocked(mode) {
  const need = UNLOCK_AT[mode] ?? 0;
  if (need === 0) return true;
  if (isVeteran()) return true;
  return getTotalSets() >= need;
}

// 解放まであと何セットか（解放済みなら 0）
export function setsUntil(mode) {
  if (isUnlocked(mode)) return 0;
  return Math.max(0, (UNLOCK_AT[mode] ?? 0) - getTotalSets());
}
