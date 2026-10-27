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

// ===== 中心の学習（これから・あやふや・覚えた。Batch 78）の回の続き =====
// 開き直しても（リロード・タブを閉じた・机に戻った）、回を始めた日のうちなら同じ回の続きから: 答えた語は二度出さず、回の数（今回 覚えた n 語）も二重に数えない。
// 日をまたいだ回（23:55 に始めて 0:10 に開き直した）は続きにしない: 前の日に数えた あやふや の語も今日の分に戻るので、新しい回で列を作り直す。
// 持つのは答えを保存できた語の id の並びと、セットの区切り（セットを終えたら次のセットの始め）と、学んだ日の印を付けたか。答えた語の今の状態から回の結果を数え直す（js/learnQueue.js learnSummary）。
// 別の人の表に替わった（復元・アカウントの切り替え）・その語の答えが保存に無い（中心の学習で最後に答えた時刻 lsAt が回の始めより前）なら続きにしない（js/game.js）。
// 回が終わったら（今日の分は終わり・ここで終える）消す
const LEARN_KEY = "spelldash_learn_session";

// point = { mode, startedAt, ids, setStart, ackBreak, setNo, dayMarked }。date は回を始めた日（読むときは startedAt から決め直す）
export function saveLearnPoint(point) {
  try {
    localStorage.setItem(LEARN_KEY, JSON.stringify({ ...point, date: localDateString(new Date(point.startedAt)) }));
  } catch {
    // 保存できなくても学習は続けられる（開き直すと新しい回になる）
  }
}

export function clearLearnPoint() {
  try {
    localStorage.removeItem(LEARN_KEY);
  } catch {
    // 無視
  }
}

// 今日始めた・同じモードの回の続き（無い・形が違う・前の日に始めた回なら null）
export function learnPointFor(mode) {
  try {
    const s = JSON.parse(localStorage.getItem(LEARN_KEY) || "null");
    if (!s || s.mode !== mode || !Number.isFinite(s.startedAt) || localDateString(new Date(s.startedAt)) !== localDateString()) return null;
    if (!Array.isArray(s.ids) || !s.ids.every((id) => typeof id === "string")) return null;
    const setStart = Number.isInteger(s.setStart) && s.setStart >= 0 && s.setStart <= s.ids.length ? s.setStart : 0;
    return { mode, startedAt: s.startedAt, ids: s.ids, setStart, ackBreak: Number.isInteger(s.ackBreak) ? s.ackBreak : -1, setNo: Number.isInteger(s.setNo) ? s.setNo : 1, dayMarked: s.dayMarked === true };
  } catch {
    return null;
  }
}
