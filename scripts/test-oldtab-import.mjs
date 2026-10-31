// 旧タブの学習の取り込み（純関数）。ブラウザを使う本物の旧版検査 tests/oldtab の前に、
// 増分・持ち主・3 状態・二重取り込みの境を数秒で固定する。
import { isDeepStrictEqual } from "util";
import { mergeOldTabOrphans, OLD_TAB_IMPORTED_KEY } from "../js/oldTabImport.js";

let passed = 0;
const failures = [];
function eq(name, actual, expected) {
  if (isDeepStrictEqual(actual, expected)) passed++;
  else failures.push(`${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
}
const parse = (keys, name) => JSON.parse(keys[name] ?? "null");
const at = "2026-10-30T12:00:00.000Z";
const base = {
  spelldash_word_stats: JSON.stringify({ public: { playCount: 5, correctCount: 3, recallFail: 1, ls: 0 }, private: { playCount: 2, correctCount: 1, recallFail: 0 } }),
  spelldash_dirty_words: JSON.stringify(["before"])
};
const rows = [
  { id: "o1", savedAt: at, keys: { spelldash_word_stats: JSON.stringify({ public: { playCount: 1, correctCount: 1, recallFail: 0, lastPlayed: at, lastRecallSuccessAt: at }, private: { playCount: 1, correctCount: 1 } }) } },
  { id: "o2", savedAt: "2026-10-31T12:00:00.000Z", keys: { spelldash_word_stats: JSON.stringify({ public: { playCount: 1, correctCount: 0, recallFail: 1, lastPlayed: "2026-10-31T12:00:00.000Z", lastRecallFailAt: "2026-10-31T12:00:00.000Z" } }) } },
  { id: "other-area", area: "u:B", savedAt: at, keys: { spelldash_word_stats: JSON.stringify({ public: { playCount: 99, correctCount: 99 } }) } }
];

const first = mergeOldTabOrphans(base, rows, new Set(["public"]));
const stats = parse(first.keys, "spelldash_word_stats");
eq("area の無い 2 行だけを取り込む", [first.records, first.words], [2, 2]);
eq("回数は置き換えず増分を足す", [stats.public.playCount, stats.public.correctCount, stats.public.recallFail], [7, 4, 2]);
eq("非公開語も回答履歴は失わない", [stats.private.playCount, stats.private.correctCount, stats.private.ls ?? null], [3, 2, null]);
eq("公開語の最後の誤答はあやふや", stats.public.ls, 1);
eq("送信待ちへ重複なく足す", new Set(parse(first.keys, "spelldash_dirty_words")), new Set(["before", "public", "private"]));
eq("取り込んだ id を持ち主の領域に残す", parse(first.keys, OLD_TAB_IMPORTED_KEY), { v: 1, ids: ["o1", "o2"] });

const second = mergeOldTabOrphans(first.keys, rows, new Set(["public"]));
eq("同じ orphan を 2 回取り込まない", second, { keys: first.keys, records: 0, words: 0, ids: [] });

const unknown = mergeOldTabOrphans({}, [{ id: "u1", savedAt: at, keys: { spelldash_word_stats: JSON.stringify({ public: { correctCount: 1, playCount: 1 } }) } }], new Set(["public"]));
eq("自力正解と証明できない正解は覚えたにしない", parse(unknown.keys, "spelldash_word_stats").public.ls, 1);

if (failures.length) {
  console.error(`old-tab import: ${failures.length} failed, ${passed} passed`);
  for (const failure of failures) console.error(`\n${failure}`);
  process.exitCode = 1;
} else console.log(`old-tab import: ${passed} passed`);
