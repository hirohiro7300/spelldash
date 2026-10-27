// アカウントのアイコン（Batch 75。ログイン中の人のアカウントのアイコンとメニューの行に学習のランクを出す。js/accountEmblem.js）の単体テスト。
// Batch 78 段 4 で材料を XP の 21 段から 9 段のランク（js/rank.js。覚えた語数・下がらない最高到達ランク）に替えた。ブラウザなしで 1 秒で終わる:
//   node scripts/test-account-emblem.mjs
// 失敗が 1 つでもあれば終了コード 1。
// 見ること: ランクが決まる・決まらない（持ち主の印・このタブの同期・最高到達ランクと今の語数の材料）、見せるランク（最高到達ランクより下げない・
// 9 段の境）、ボタンの名前とメニューの行の文（名前だけ・Lv なし）、絵が無い間は頭文字（URL は ""）、替える時機の決まり（幕の間・プレイ中・幕を閉じた知らせ）、
// 保存のキーの名前が js/sync.js・js/rank.js と同じこと、js/auth.js が紋章を静的に読まないこと（modulepreload を変えない）、
// js/game.js の幕を閉じた知らせは 1 か所で、答えの道の外にあること。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isDeepStrictEqual } from "util";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear(), key: (i) => [...store.keys()][i] ?? null, get length() { return store.size; } };
globalThis.sessionStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window ??= globalThis;
// js/storage.js → sync.js → supabase.js は SDK を動的に読みに行く。テストでは読めない URL の代わりに空の殻を渡す（test-level.mjs と同じ）
globalThis.window.__SUPABASE_MODULE_URL = "data:text/javascript,export const createClient = () => ({});";

// import しただけでは document に触らない（7 ページの読み込みの後に動的 import で読む。Node でも読める）
const hadDocument = "document" in globalThis;
const A = await import("../js/accountEmblem.js");
const R = await import("../js/rank.js");
const E = await import("../js/emblem.js");

let passed = 0;
const failures = [];
function eq(name, actual, expected) {
  if (isDeepStrictEqual(actual, expected)) passed++;
  else failures.push(`${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}
const ok = (name, cond, detail = "") => eq(`${name}${detail ? ` (${detail})` : ""}`, !!cond, true);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const TOTAL = JSON.parse(read("data/public/english.json")).total;
const brief = (s) => (s ? s.name : null);

ok("import しただけでは document を作らない・触らない", !hadDocument && !("document" in globalThis));

// ---- ランクが決まる・決まらない（材料は最高到達ランクと今の覚えた語数。XP は使わない） ----
const U = "user-a";
const state = (o) => brief(A.accountRankState({ userId: U, owner: U, syncedUser: null, peak: 4, ...o }));
eq("持ち主の印が本人・最高到達ランク 4 → 中学生", state({}), "中学生");
eq("このタブで本人の同期を終えた → 決まる（持ち主の印が無くても）", state({ owner: null, syncedUser: U }), "中学生");
eq("未ログイン → 決まらない", state({ userId: null }), null);
eq("持ち主が別のアカウント・同期がまだ → 決まらない（前の人のランクを出さない）", state({ owner: "user-b" }), null);
eq("持ち主の印が無く・同期がまだ → 決まらない", state({ owner: null }), null);
eq("同期を終えたのが別のアカウント → 決まらない", state({ owner: null, syncedUser: "user-b" }), null);
eq("最高到達ランクも今の語数も無い → 決まらない（材料を待つ。頭文字のまま）", state({ peak: null }), null);
eq("最高到達ランクが無く、今の語数 0 → 赤ちゃん", state({ peak: null, learned: 0, total: TOTAL }), "赤ちゃん");
eq("最高到達ランクの壊れた値（9・-1・\"x\"・3.5）は無いのと同じ", [9, -1, "x", 3.5].map((peak) => state({ peak })), [null, null, null, null]);
eq("材料は最高到達ランク（\"6\" の文字列も読む）", state({ peak: "6" }), "留学生");
eq("最高到達ランクより今の語数の段が上（1,400 語）→ 高校生（学習状況と同じ max）", state({ learned: 1400, total: TOTAL }), "高校生");
eq("今の語数が減っても最高到達ランクより下げない（4 のまま 300 語 → 中学生）", state({ learned: 300, total: TOTAL }), "中学生");
eq("XP を渡しても使わない（材料に無い）", brief(A.accountRankState({ userId: U, owner: U, syncedUser: null, peak: 2, xp: 1e6 })), "単語キッズ");
{
  // 9 段の境の前後（最高到達ランクが無く、今の語数だけ）: 学習状況と同じ js/rank.js rankFor
  const at = R.rankThresholds(TOTAL);
  const rows = [];
  for (let k = 1; k < at.length; k++) rows.push([at[k] - 1, at[k]].map((n) => brief(A.accountRankState({ userId: U, owner: U, peak: null, learned: n, total: TOTAL }))));
  eq("9 段の境の −1 とちょうど（最高到達ランクが無いとき）", rows, R.RANK_NAMES.slice(1).map((name, i) => [R.RANK_NAMES[i], name]));
}

// ---- 文（9 段。名前だけ・Lv なし） ----
const all = R.RANK_NAMES.map((name, rank) => ({ rank, name }));
eq("決まらないときのボタンの名前は今のまま「アカウントメニュー」", A.menuLabel(null), "アカウントメニュー");
eq("ボタンの名前は「アカウントメニュー（中学生）」（全角の括弧）", A.menuLabel({ rank: 4, name: "中学生" }), "アカウントメニュー（中学生）");
eq("メニューの行はランクの名前だけ（「中学生」。Lv は出さない）", A.rankRowText({ rank: 4, name: "中学生" }), "中学生");
eq("メニューの行の読み上げは「ランク 中学生」", A.rankRowSpeech({ rank: 4, name: "中学生" }), "ランク 中学生");
eq("9 段のボタンの名前", all.map(A.menuLabel), R.RANK_NAMES.map((n) => `アカウントメニュー（${n}）`));
eq("9 段のメニューの行", all.map(A.rankRowText), [...R.RANK_NAMES]);
ok("文に undefined・NaN・Lv・レベル・Pro・Battle の段の名前・前の 21 段の名前が入らない", all.flatMap((s) => [A.menuLabel(s), A.rankRowText(s), A.rankRowSpeech(s)]).every((t) => !/undefined|NaN|Lv|レベル|Pro|Bronze|Silver|Gold|Diamond|Master|[木銅銀金神] \d|ダイヤ|レジェンド/.test(t)));

// ---- 絵（9 段の絵はまだ無い: 頭文字のまま） ----
eq("9 段どれも絵の URL は空（js/emblem.js learnRankEmblemSrc。新しい絵は作らない）", all.map(A.emblemUrl), Array(9).fill(""));
eq("決まらないときも空の URL", A.emblemUrl(null), "");
eq("learnRankEmblemSrc は小さい絵でも空", [E.learnRankEmblemSrc(0), E.learnRankEmblemSrc(8, { small: true })], ["", ""]);

// ---- 替える時機（nextShown） ----
const S = (rank) => ({ rank, name: R.RANK_NAMES[rank] });
const n = (o) => brief(A.nextShown(o));
eq("ふだん: 今の材料のランク", n({ current: S(4), shown: null }), "中学生");
eq("ふだん: 上がる（同期・別のタブ・学習状況で上げた）", n({ current: S(5), shown: S(4) }), "高校生");
eq("ふだん: 別のアカウント・置き換えの後は新しい人のランク", n({ current: S(1), shown: S(4) }), "よちよち");
eq("決まらない → 頭文字（前の状態を残さない）", n({ current: null, shown: S(4) }), null);
eq("幕が出ている間は替えない", n({ current: S(5), shown: S(4), curtainOpen: true }), "中学生");
eq("幕が出ている間・まだ何も出していない → 頭文字のまま", n({ current: S(5), shown: null, curtainOpen: true }), null);
eq("プレイ中に段が違う → 替えない", n({ current: S(5), shown: S(4), running: true }), "中学生");
eq("プレイ中でも同じ段ならそのまま", n({ current: S(4), shown: S(4), running: true }), "中学生");
eq("プレイ中・まだ何も出していない → 頭文字のまま（回の後か幕の後に出す）", n({ current: S(4), shown: null, running: true }), null);
eq("幕を閉じた知らせ・プレイ中でない → 今のランク", n({ current: S(5), shown: S(4), announced: S(5) }), "高校生");
eq("幕を閉じた知らせ・プレイ中に次の段へもう進んでいた → 幕で見せたランクまで", n({ current: S(6), shown: S(4), announced: S(5), running: true }), "高校生");
eq("幕を閉じた知らせでも決まらないときは頭文字", n({ current: null, shown: S(4), announced: S(5) }), null);
eq("幕を閉じた知らせの detail（ランクの名前か段の番号）→ ランク", [A.announcedFrom({ rank: "中学生" }), A.announcedFrom({ rank: 5 }), A.announcedFrom({ rank: "8" })], [S(4), S(5), S(8)]);
eq("幕を閉じた知らせ（壊れた detail・前の 21 段の名前）→ null", [A.announcedFrom(null), A.announcedFrom({}), A.announcedFrom({ rank: "銀 2", level: 15 }), A.announcedFrom({ rank: 9 })], [null, null, null, null]);

// ---- 保存のキーの名前（js/sync.js は export しないので本文と突き合わせる） ----
const syncSrc = read("js/sync.js");
const emblemSrcText = read("js/accountEmblem.js").replace(/\/\/[^\n]*/g, ""); // 注を除いたコード
eq("持ち主の印のキーは js/sync.js の OWNER_KEY と同じ", syncSrc.match(/const OWNER_KEY = "([^"]+)"/)?.[1], A.OWNER_KEY);
eq("このタブの同期を終えた印のキーは js/sync.js の DONE_FLAG と同じ", syncSrc.match(/const DONE_FLAG = "([^"]+)"/)?.[1], A.SYNC_DONE_KEY);
ok("最高到達ランクのキーは js/rank.js の RANK_PEAK_KEY を使う（写さない）・XP を読まない", /RANK_PEAK_KEY/.test(emblemSrcText) && !/spelldash_rank_peak|spelldash_xp|getTotalXp|getLevelState|LEARNING_RANKS/.test(emblemSrcText));
ok("js/accountEmblem.js は最高到達ランクを書かない（raiseRankPeak を呼ばない。書くのは学習状況と回の終わり）", !/raiseRankPeak|setItem/.test(emblemSrcText));

// ---- js/auth.js: 紋章は動的 import（静的に読むと battle・list・pro・profile・stats の head〔modulepreload〕が変わる） ----
const authSrc = read("js/auth.js");
const IMPORT_RE = /^\s*(?:import|export)\s(?:[^;"']*?\sfrom\s+)?["'](\.{1,2}\/[^"']+)["']/gm; // scripts/modulepreload.mjs と同じ
const staticDeps = [...authSrc.matchAll(IMPORT_RE)].map((m) => m[1]);
eq("js/auth.js は accountEmblem・emblem・level を静的に import しない", staticDeps.filter((d) => /accountEmblem|emblem\.js|level\.js/.test(d)), []);
ok("js/auth.js は accountEmblem.js を動的に import する", /import\(\s*["']\.\/accountEmblem\.js["']\s*\)/.test(authSrc));
ok("js/auth.js は #headerAvatar の中身を textContent で丸ごと替えない（紋章の img を消さない）", !/headerAvatarElement\.textContent\s*=/.test(authSrc));

// ---- js/game.js: 幕を閉じた知らせは 1 か所。幕を外すタイマーの中（答えの道の外） ----
const gameSrc = read("js/game.js");
function bodyOf(src, name) {
  const at = src.search(new RegExp(`\\bfunction ${name}\\(`));
  if (at < 0) return null;
  let i = src.indexOf("{", src.indexOf(")", at));
  const start = i;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}
const closedAt = [...gameSrc.matchAll(/spelldash:rank-up-closed/g)];
eq("js/game.js の spelldash:rank-up-closed は 1 か所", closedAt.length, 1);
const celebrate = bodyOf(gameSrc, "celebrateRankUp") ?? "";
ok("その 1 か所は celebrateRankUp の中で、overlay.remove() の後", /overlay\.remove\(\);\s*\n?[^]*?spelldash:rank-up-closed/.test(celebrate) && celebrate.indexOf("overlay.remove()") < celebrate.indexOf("spelldash:rank-up-closed"));
ok("幕を外すのと同じ setTimeout の中（Enter の keydown のタスクの外）", /setTimeout\(\(\) => \{[^}]*overlay\.remove\(\);[^}]*spelldash:rank-up-closed[^]*?\}, 220\)/.test(celebrate));
for (const name of ["completeWord", "acceptChar", "advanceNow", "applyStudyXp", "deferRankUp", "celebrateDeferredRankUp"]) {
  const body = bodyOf(gameSrc, name);
  ok(`答えの道・控えの ${name} に紋章の処理が無い`, body !== null && !/rank-up-closed|accountEmblem|headerAvatar/.test(body));
}

if (failures.length) {
  console.error(failures.map((f) => `✗ ${f}`).join("\n"));
  console.error(`\n${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`OK: アカウントの紋章 ${passed} 件`);
