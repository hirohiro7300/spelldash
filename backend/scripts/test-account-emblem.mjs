// アカウントの紋章（Batch 75。ログイン中の人のアカウントのアイコンを今の学習のランクの紋章にする。js/accountEmblem.js）の単体テスト。ブラウザなしで 1 秒で終わる:
//   node scripts/test-account-emblem.mjs
// 失敗が 1 つでもあれば終了コード 1。
// 見ること: ランクが決まる・決まらない（持ち主の印・このタブの同期・壊れた XP）、ボタンの名前とメニューの行の文（21 段）、替える時機の決まり（幕の間・プレイ中・
// 幕を閉じた知らせ）、紋章の絵の URL とファイル、保存のキーの名前が js/sync.js・js/level.js と同じこと、js/auth.js が紋章を静的に読まないこと（modulepreload を変えない）、
// js/game.js の幕を閉じた知らせは 1 か所で、答えの道の外にあること。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isDeepStrictEqual } from "util";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
globalThis.window ??= globalThis;
// js/level.js → plan.js → supabase.js は SDK を動的に読みに行く。テストでは読めない URL の代わりに空の殻を渡す（test-level.mjs と同じ）
globalThis.window.__SUPABASE_MODULE_URL = "data:text/javascript,export const createClient = () => ({});";

// import しただけでは document に触らない（7 ページの読み込みの後に動的 import で読む。Node でも読める）
const hadDocument = "document" in globalThis;
const A = await import("../js/accountEmblem.js");
const L = await import("../js/level.js");
const E = await import("../js/emblem.js");

let passed = 0;
const failures = [];
function eq(name, actual, expected) {
  if (isDeepStrictEqual(actual, expected)) passed++;
  else failures.push(`${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}
const ok = (name, cond, detail = "") => eq(`${name}${detail ? ` (${detail})` : ""}`, !!cond, true);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const xpForLv = (lv) => { let x = 0; for (let l = 1; l < lv; l++) x += 100 + (l - 1) * 50; return x; };
const brief = (s) => (s ? { name: s.rank.name, level: s.level } : null);

ok("import しただけでは document を作らない・触らない", !hadDocument && !("document" in globalThis));

// ---- ランクが決まる・決まらない ----
const U = "user-a";
const state = (o) => brief(A.accountRankState({ userId: U, owner: U, syncedUser: null, xp: xpForLv(15), ...o }));
eq("持ち主の印が本人 → 決まる（Lv.15 = 銀 2）", state({}), { name: "銀 2", level: 15 });
eq("このタブで本人の同期を終えた → 決まる（持ち主の印が無くても）", state({ owner: null, syncedUser: U }), { name: "銀 2", level: 15 });
eq("未ログイン → 決まらない", state({ userId: null }), null);
eq("持ち主が別のアカウント・同期がまだ → 決まらない（前の人のランクを出さない）", state({ owner: "user-b" }), null);
eq("持ち主の印が無く・同期がまだ → 決まらない（足し合わせの後に決まる）", state({ owner: null }), null);
eq("同期を終えたのが別のアカウント → 決まらない", state({ owner: null, syncedUser: "user-b" }), null);
eq("XP 0 → 木 1・Lv.1", state({ xp: 0 }), { name: "木 1", level: 1 });
eq("XP が負 → 木 1（level.js と同じ）", state({ xp: -5 }), { name: "木 1", level: 1 });
eq("神 3 の上（Lv.150）→ 神 3", state({ xp: xpForLv(150) }), { name: "神 3", level: 150 });
eq("壊れた XP（Infinity・NaN）→ 決まらない（getLevelState の繰り返しを回さない）", [Infinity, -Infinity, NaN].map((xp) => state({ xp })), [null, null, null]);
eq(`大きすぎる XP（${A.MAX_XP} を超える）→ 決まらない`, [A.MAX_XP + 1, 1e300].map((xp) => state({ xp })), [null, null]);
eq(`上限ちょうどの XP（${A.MAX_XP}）は決まる`, state({ xp: A.MAX_XP }) !== null, true);
store.set("spelldash_xp", "1e309");
eq("readXp: 保存の \"1e309\" は Infinity（決まらない側へ）", A.readXp(), Infinity);
store.set("spelldash_xp", "abc");
eq("readXp: 字（\"abc\"）は 0（level.js の getTotalXp と同じ）", A.readXp(), 0);
store.set("spelldash_xp", String(xpForLv(22)));
eq("readXp: 数の字はそのまま", A.readXp(), xpForLv(22));
store.clear();

// ---- 文（21 段） ----
const all = L.LEARNING_RANKS.map((rank) => ({ rank, level: rank.level }));
eq("決まらないときのボタンの名前は今のまま「アカウントメニュー」", A.menuLabel(null), "アカウントメニュー");
eq("ボタンの名前は「アカウントメニュー（銀 2）」（全角の括弧）", A.menuLabel({ rank: L.learningRankOf(15), level: 15 }), "アカウントメニュー（銀 2）");
eq("メニューの行は「銀 2 ・ Lv.15」（学習データの行と同じ書き方）", A.rankRowText({ rank: L.learningRankOf(15), level: 15 }), "銀 2 ・ Lv.15");
eq("メニューの行の読み上げは「銀 2、レベル 15」（Lv. を読ませない）", A.rankRowSpeech({ rank: L.learningRankOf(15), level: 15 }), "銀 2、レベル 15");
eq("21 段のボタンの名前", all.map(A.menuLabel), L.LEARNING_RANKS.map((r) => `アカウントメニュー（${r.name}）`));
eq("21 段のメニューの行", all.map(A.rankRowText), L.LEARNING_RANKS.map((r) => `${r.name} ・ Lv.${r.level}`));
eq("21 段の読み上げ", all.map(A.rankRowSpeech), L.LEARNING_RANKS.map((r) => `${r.name}、レベル ${r.level}`));
ok("文に undefined・NaN・Pro・Battle の段の名前が入らない", all.flatMap((s) => [A.menuLabel(s), A.rankRowText(s), A.rankRowSpeech(s)]).every((t) => !/undefined|NaN|Pro|Bronze|Silver|Gold|Diamond|Master/.test(t)));

// ---- 紋章の絵（96px の小さい絵。21 段） ----
const dir = path.join(ROOT, "assets/images/emblems");
eq("21 段の絵の URL は emblemSrc(rank, { small: true }) と同じ", all.map(A.emblemUrl), L.LEARNING_RANKS.map((r) => E.emblemSrc(r, { small: true })));
ok("21 段の絵のファイルがある（-sm.webp）", all.every((s) => fs.existsSync(path.join(dir, path.basename(A.emblemUrl(s))))), all.map(A.emblemUrl).filter((u) => !fs.existsSync(path.join(dir, path.basename(u)))).join(","));
eq("決まらない・知らないランクは空の URL", [A.emblemUrl(null), A.emblemUrl({ rank: { tier: "x", step: 1, name: "x" }, level: 1 })], ["", ""]);

// ---- 替える時機（nextShown） ----
const S = (lv) => ({ rank: L.learningRankOf(lv), level: lv });
const n = (o) => brief(A.nextShown(o));
const w1 = S(1), w2 = S(2), s2 = S(15), s2b = S(16), s3 = S(18), g1 = S(22);
eq("ふだん: 今の XP のランク", n({ current: s2, shown: null }), brief(s2));
eq("ふだん: 上がる（同期で）", n({ current: g1, shown: s2 }), brief(g1));
eq("ふだん: 下がる（別のアカウント・置き換え）", n({ current: w1, shown: s2 }), brief(w1));
eq("決まらない → 頭文字（前の状態を残さない）", n({ current: null, shown: s2 }), null);
eq("幕が出ている間は替えない", n({ current: s3, shown: s2, curtainOpen: true }), brief(s2));
eq("幕が出ている間・まだ何も出していない → 頭文字のまま", n({ current: s3, shown: null, curtainOpen: true }), null);
eq("プレイ中に段が違う（控えた幕がある）→ 替えない", n({ current: w2, shown: w1, running: true }), brief(w1));
eq("プレイ中でも同じ段なら Lv だけ新しく（銀 2 Lv.15 → Lv.16）", n({ current: s2b, shown: s2, running: true }), brief(s2b));
eq("プレイ中・まだ何も出していない → 頭文字のまま（回の後か幕の後に出す）", n({ current: s2, shown: null, running: true }), null);
eq("幕を閉じた知らせ・プレイ中でない → 今のランク", n({ current: S(5), shown: S(4), announced: S(5) }), brief(S(5)));
eq("幕を閉じた知らせ・プレイ中（Study の回の途中）→ 幕で見せたランク", n({ current: S(5), shown: S(4), announced: S(5), running: true }), brief(S(5)));
eq("幕を閉じた知らせ・プレイ中に次の段へもう進んでいた → 幕で見せたランクまで", n({ current: S(7), shown: S(4), announced: S(5), running: true }), brief(S(5)));
eq("幕を閉じた知らせでも決まらないときは頭文字", n({ current: null, shown: S(4), announced: S(5) }), null);
eq("幕を閉じた知らせ（壊れた detail）→ announcedFrom は null", [A.announcedFrom(null), A.announcedFrom({}), A.announcedFrom({ rank: "x 9", level: 3 }), A.announcedFrom({ rank: "銅 1", level: "abc" })], [null, null, null, null]);
eq("幕を閉じた知らせの detail（{ rank: 名前, level }）→ ランクとレベル", brief(A.announcedFrom({ rank: "銅 1", level: 5 })), { name: "銅 1", level: 5 });

// ---- 保存のキーの名前（js/sync.js は export しないので本文と突き合わせる） ----
const syncSrc = read("js/sync.js");
const levelSrc = read("js/level.js");
eq("持ち主の印のキーは js/sync.js の OWNER_KEY と同じ", syncSrc.match(/const OWNER_KEY = "([^"]+)"/)?.[1], A.OWNER_KEY);
eq("このタブの同期を終えた印のキーは js/sync.js の DONE_FLAG と同じ", syncSrc.match(/const DONE_FLAG = "([^"]+)"/)?.[1], A.SYNC_DONE_KEY);
eq("XP のキーは js/level.js の XP_KEY と同じ", levelSrc.match(/const XP_KEY = "([^"]+)"/)?.[1], A.XP_KEY);

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
