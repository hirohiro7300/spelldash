// ===== 記憶の保持率の記録（語ごと） =====
// js/stats.js の記録関数の末尾から呼ばれる。word_stats には書かず、別のキーに固定長のレコードを持つ。
// 計測は装飾: 失敗してもゲームには一切影響させない（js/activity.js と同じ作法。全体を try/catch）。
// 集計は js/retentionCalc.js、定義は docs/SPEC_RETENTION.md。
//
// spelldash_retention = { [wordId]: { f, d, n, w7?, w30? } }
//   f   初めて自力で思い出せた日時（ISO）。「知ってた」語（初見でノーミス・一度もつまずいていない）と、
//       測定の開始前（または別の端末）にすでに自力正解のある語には立てない（過去分は遡って測れないので分母に入れない）
//   d   最後に復習として数えた回答日 "YYYY-MM-DD"（同日の反復を数えないため）
//   n   復習した日数（f の翌日以降に o/x の回答があった日の数）
//   w7  覚えた日から +6〜+8 日の窓で最初の回答 { t: 日, r: "o"|"x", rv: その前の復習日数 }。1 回だけ書く
//   w30 同じく +27〜+33 日

import { localDay, dayDiff, WINDOW_7, WINDOW_30 } from "./retentionCalc.js";

const KEY = "spelldash_retention";

export function getRetentionRecords() {
  try {
    const data = JSON.parse(localStorage.getItem(KEY) || "{}");
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function save(map) {
  localStorage.setItem(KEY, JSON.stringify(map));
}

// 「知ってた」状態の語（js/categoryProgress.js classifyWord と同じ条件）。学習ではないので t0 を立てない
function isKnownOnSight(stat) {
  return !!(stat?.knownOnSight && (stat.recallFail ?? 0) === 0);
}

// 知ってた語がつまずいたあとの、最初の自力正解か。以前の自力正解は「知ってた」ときのものなので、ここが t0。
// history（直近 8 件。いま押した o が末尾）で、最後の x のあとに o が無ければ最初。
// x が流れている／history が無いときは、すでに学び直し済みとみなして立てない（過大に数える側に倒さない）
function isFirstRecallAfterKnown(stat) {
  if (!stat.knownOnSight || (stat.recallFail ?? 0) < 1) return false;
  const h = Array.isArray(stat.history) ? stat.history.slice(0, -1) : [];
  const lastX = h.map((e) => e?.r).lastIndexOf("x");
  return lastX >= 0 && !h.slice(lastX + 1).some((e) => e?.r === "o");
}

// 自力正解のたびに呼ぶ。初めての自力正解のときだけ f を書く（write-once）。
// prevSuccessAt = この正解より前の lastRecallSuccessAt（呼び元が上書きの前に読んだ値）。
// これがある語は以前に覚えている（測定の開始前に覚えた語・別の端末で覚えた語）ので t0 を立てない。
// 「知ってた」語が後でつまずき、そのあと初めて思い出せたときだけは t0（以前の正解は知ってた時のもの）。now は検証用
export function noteFirstRecall(id, stat, prevSuccessAt = null, now = new Date()) {
  try {
    if (!id || !stat || isKnownOnSight(stat)) return;
    if (prevSuccessAt && !isFirstRecallAfterKnown(stat)) return;
    const map = getRetentionRecords();
    if (map[id]?.f) return;
    const day = localDay(now);
    if (!day) return;
    map[id] = { f: now.toISOString(), d: day, n: 0 };
    save(map);
  } catch {
    // 計測はゲームを止めない
  }
}

// o/x の回答のたびに呼ぶ（recordRecallSuccess は noteFirstRecall の後に）。f の無い語は何もしない。
// 窓に入って最初の回答を 1 回だけ書き、そのあと「別の日の回答」を復習日数に足す。stat はいまは使わない（呼び元の形を揃えるため）
export function noteAnswer(id, r, stat = null, now = new Date()) {
  try {
    if (!id || (r !== "o" && r !== "x")) return;
    const map = getRetentionRecords();
    const rec = map[id];
    if (!rec || !rec.f) return;
    const t0 = localDay(rec.f);
    const day = localDay(now);
    if (!t0 || !day) return;
    const dd = dayDiff(t0, day);
    if (!(dd >= 1)) return; // 覚えた日と同じ日の反復は数えない（窓にも入らない）

    const rv = Number.isFinite(rec.n) ? rec.n : 0;
    let changed = false;
    if (!rec.w7 && dd >= WINDOW_7[0] && dd <= WINDOW_7[1]) {
      rec.w7 = { t: day, r, rv };
      changed = true;
    }
    if (!rec.w30 && dd >= WINDOW_30[0] && dd <= WINDOW_30[1]) {
      rec.w30 = { t: day, r, rv };
      changed = true;
    }
    if (!rec.d || day > rec.d) {
      rec.d = day;
      rec.n = rv + 1;
      changed = true;
    }
    if (changed) save(map);
  } catch {
    // 同上
  }
}
