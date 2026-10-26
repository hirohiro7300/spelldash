// ===== 学習時間（日別の秒数） =====
// Study には「終わり」のイベントが無い（タブを閉じる・道に戻る）ので開始／終了では測れない。
// 代わりに、記録イベント（出題・自力正解・思い出せず・完答。js/stats.js の 4 関数）ごとに
// 「前のイベントからの経過秒」をその日に足す。1 回の経過は 60 秒まで（離席・無操作を打ち切る）。
// ページを開いて最初のイベントは前が無いので足さない。モードは分けない（全モード合算。Phase 1）。
// 計測は装飾: 失敗してもゲームには一切影響させない。集計は js/retentionCalc.js（学習効率の分母）。
//
// spelldash_study_time = { "YYYY-MM-DD": 秒 }（120 日で切る。成長ログと同じ作法）

import { localDay } from "./retentionCalc.js";

const KEY = "spelldash_study_time";
const MAX_GAP_SECONDS = 60;
const MAX_DAYS = 120;
let lastEventAt = null; // このページ読み込みでの前のイベント（ms）

export function getStudySecondsByDay() {
  try {
    const data = JSON.parse(localStorage.getItem(KEY) || "{}");
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

// now は検証用（ms）
export function touchStudyTime(now = Date.now()) {
  try {
    const prev = lastEventAt;
    lastEventAt = now;
    if (prev == null) return;
    const gap = Math.min(MAX_GAP_SECONDS, (now - prev) / 1000);
    if (!(gap > 0)) return;
    const day = localDay(new Date(now));
    if (!day) return;
    const map = getStudySecondsByDay();
    map[day] = Math.round(((Number(map[day]) || 0) + gap) * 10) / 10;
    const days = Object.keys(map).sort();
    for (const old of days.slice(0, Math.max(0, days.length - MAX_DAYS))) delete map[old];
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // 計測はゲームを止めない
  }
}

// 検証用: ページを開いた直後の状態（前のイベントなし）に戻す
export function resetStudyTimeClock() {
  lastEventAt = null;
}
