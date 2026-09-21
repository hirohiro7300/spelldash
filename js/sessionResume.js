import { localDateString } from "./stats.js";

// ===== 前回の続きから =====
//
// Study のセットを途中でやめても（タブを閉じた・「道に戻る」を押した）、その日のうちなら
// 残りの語と進み具合（自力で思い出せた語数）から再開できる。中断が損にならないように。
// 保存するのは通常のセットだけ（もう一度・腕試しは対象外）。セットが終わったら消す。

const KEY = "spelldash_session";

export function saveSession(session) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...session, date: localDateString(), savedAt: new Date().toISOString() }));
  } catch {
    // 保存できなくても学習は続けられる
  }
}

export function clearSession() {
  localStorage.removeItem(KEY);
}

// 今日・同じカテゴリで、まだ残りがあるセッションだけ返す
export function resumableFor(categoryId) {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!s || s.date !== localDateString()) return null;
    if (s.category !== categoryId) return null;
    if (!Array.isArray(s.queue) || s.queue.length === 0) return null;
    const recalled = Array.isArray(s.recalled) ? s.recalled : [];
    if (recalled.length >= (s.setSize ?? Infinity)) return null;
    return { ...s, recalled, failed: Array.isArray(s.failed) ? s.failed : [] };
  } catch {
    return null;
  }
}
