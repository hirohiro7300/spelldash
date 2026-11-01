// ===== 分離の前のタブで続けた学習を、元の人へ 1 回だけ戻す =====
// DOM・localStorage・IndexedDB は読まない純関数。areaSwitch が、移行で決めた持ち主の
// 領域を展開する直前にだけ呼ぶ。仕様は docs/SPEC_ACCOUNT_AREAS.md §6・§11。
//
// orphans の area が無い行は、移行後に旧コードが旧い spelldash_* へ書いた値。
// 旧い場所は書くたびに空へ戻すため、word_stats にある回数はその書き込みで増えた分として
// 現在の記録へ加える。取り込んだ orphan id は持ち主の領域内に保存し、再訪しても足さない。

import { applyLearnAnswer, LEARN_NEW } from "./learnState.js";

export const OLD_TAB_IMPORTED_KEY = "spelldash_oldtab_imported";
const WORD_STATS_KEY = "spelldash_word_stats";
const DIRTY_KEY = "spelldash_dirty_words";

function json(text, fallback) {
  if (typeof text !== "string") return fallback;
  try {
    const value = JSON.parse(text);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

const count = (value) => Math.max(0, Number(value) || 0);
const time = (value) => {
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
};
const later = (a, b) => (time(b) > time(a) ? b : a);

function importedIds(keys) {
  const value = json(keys?.[OLD_TAB_IMPORTED_KEY], []);
  if (Array.isArray(value)) return new Set(value.filter((id) => typeof id === "string" && id));
  return new Set(Array.isArray(value?.ids) ? value.ids.filter((id) => typeof id === "string" && id) : []);
}

function wordTable(record) {
  const table = json(record?.keys?.[WORD_STATS_KEY], null);
  return table && typeof table === "object" && !Array.isArray(table) ? table : null;
}

function answerTime(stat, record) {
  return Math.max(time(stat?.lastPlayed), time(stat?.lastRecallSuccessAt), time(stat?.lastRecallFailAt), time(record?.savedAt), 1);
}

// 3 状態は、公開語で、答えの種類を記録から安全に判断できる時だけ動かす。
// × は recallFail で証明できる。正解は lastRecallSuccessAt があれば自力正解とみなす。
// correctCount だけでヒントの有無が分からない時は「覚えた」にせず、あやふやにする。
function applyImportedState(base, delta, record, isPublic) {
  if (!isPublic) return base;
  const misses = count(delta.recallFail);
  const correct = count(delta.correctCount);
  if (misses <= 0 && correct <= 0) return base;
  const at = answerTime(delta, record);
  if (misses > 0) return applyLearnAnswer(base, "miss", at, base?.ls ?? LEARN_NEW);
  if (time(delta.lastRecallSuccessAt) > 0) return applyLearnAnswer(base, "exact", at, base?.ls ?? LEARN_NEW);
  return applyLearnAnswer(base, "hint", at, base?.ls ?? LEARN_NEW);
}

// keys: 切り替え先（元の持ち主）の論理名 → 値。書き換えない。
// records: IndexedDB orphans の全行。area 付き（新しい領域の遅れた書き込み）は扱わない。
// publicIds: 公開語の Set。3 状態だけに使い、回数は非公開語も失わず戻す。
export function mergeOldTabOrphans(keys, records, publicIds = new Set()) {
  const done = importedIds(keys);
  const pending = (Array.isArray(records) ? records : [])
    .filter((record) => record && !record.area && typeof record.id === "string" && record.id && !done.has(record.id))
    .sort((a, b) => String(a.savedAt ?? "").localeCompare(String(b.savedAt ?? "")) || a.id.localeCompare(b.id));
  if (pending.length === 0) return { keys, records: 0, words: 0, ids: [] };

  const stats = { ...(json(keys?.[WORD_STATS_KEY], {}) || {}) };
  const dirty = new Set(json(keys?.[DIRTY_KEY], []));
  const changed = new Set();
  const ids = [];

  for (const record of pending) {
    const table = wordTable(record);
    if (table) {
      for (const [wordId, delta] of Object.entries(table)) {
        if (!delta || typeof delta !== "object" || Array.isArray(delta)) continue;
        const plays = count(delta.playCount);
        const correct = count(delta.correctCount);
        const fails = count(delta.recallFail);
        if (plays <= 0 && correct <= 0 && fails <= 0) continue;
        const before = stats[wordId] && typeof stats[wordId] === "object" ? stats[wordId] : {};
        let next = {
          ...before,
          playCount: count(before.playCount) + plays,
          correctCount: count(before.correctCount) + correct,
          recallFail: count(before.recallFail) + fails
        };
        for (const field of ["lastPlayed", "lastRecallSuccessAt", "lastRecallFailAt"]) {
          const value = later(before[field], delta[field]);
          if (value !== undefined && value !== null) next[field] = value;
        }
        next = applyImportedState(next, delta, record, publicIds.has(wordId));
        stats[wordId] = next;
        dirty.add(wordId);
        changed.add(wordId);
      }
    }
    done.add(record.id);
    ids.push(record.id);
  }

  return {
    keys: {
      ...keys,
      [WORD_STATS_KEY]: JSON.stringify(stats),
      [DIRTY_KEY]: JSON.stringify([...dirty]),
      [OLD_TAB_IMPORTED_KEY]: JSON.stringify({ v: 1, ids: [...done] })
    },
    records: ids.length,
    words: changed.size,
    ids
  };
}
