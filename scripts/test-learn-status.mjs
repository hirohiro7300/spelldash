// 学習状況（stats.html の最初の画面。Batch 78 段 4）の数・ランクの見せ方・全部覚えるまでの目安と、目安の「初めて覚えた」の印（js/learnState.js lsf）の単体テスト。
// ブラウザなし（1 秒ほど）:
//   node scripts/test-learn-status.mjs [<木の根>]
// 失敗が 1 つでもあれば終了コード 1。見ること:
//   - ランクの境の前後（9 段の境ごとに −1・ちょうど・+1。総数は data/public/english.json の total）・最高到達ランクより下げない・次のランクまでは今の数から
//   - 最初の画面の数（3 状態の和 = 総数・今日の分・今の語数の段）
//   - 印 lsf（中心の学習で初めて覚えた日。移行・同期の埋めで覚えただった語は 0。外れて戻っても数え直さない）と、書き手の保存が 1 回のまま
//   - 目安（js/learnPace.js。決まりは Batch 76 の js/bookPace.js paceOf: 直近 14 暦日・進んだ日 3 日以上・365 日まで・記録を始めてからの日数で割る）
process.env.TZ = "Asia/Tokyo";

import fs from "fs";
import path from "path";
import { isDeepStrictEqual } from "util";
import { fileURLToPath, pathToFileURL } from "url";

const ROOT = path.resolve(process.argv.slice(2).find((a) => !a.startsWith("--")) ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const modUrl = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

let passed = 0;
const failures = [];
function eq(name, actual, expected) {
  if (isDeepStrictEqual(actual, expected)) passed++;
  else failures.push(`${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}
const ok = (name, cond) => eq(name, !!cond, true);

// ===== 端末の偽物（書き手の保存を見る分だけ。scripts/test-learn-state.mjs と同じ形） =====
class FakeStorage {
  constructor(seed = {}) {
    this.map = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
    this.writes = [];
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
    this.writes.push(k);
  }
  removeItem(k) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
  key(i) {
    return [...this.map.keys()][i] ?? null;
  }
  get length() {
    return this.map.size;
  }
}
let LS = new FakeStorage({ spelldash_schema_version: "7" });
const SS = new FakeStorage();
Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => LS });
Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get: () => SS });
const listeners = new Map();
globalThis.window = globalThis;
globalThis.addEventListener = (type, fn) => {
  if (!listeners.has(type)) listeners.set(type, []);
  listeners.get(type).push(fn);
};
globalThis.removeEventListener = () => {};
globalThis.dispatchEvent = (event) => {
  for (const fn of [...(listeners.get(event.type) ?? [])]) fn(event);
  return true;
};
globalThis.document = {
  addEventListener() {},
  removeEventListener() {},
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  documentElement: { dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } },
  body: null,
  visibilityState: "visible",
  hidden: false
};
globalThis.location ??= { search: "", hostname: "localhost", pathname: "/", href: "http://localhost/", origin: "http://localhost" };
globalThis.reportError = () => {};
console.warn = () => {};
const VOCAB_TEXT = fs.readFileSync(path.join(ROOT, "data/public/english.json"), "utf8");
globalThis.fetch = async (u) => (String(u).endsWith("data/public/english.json") ? { ok: true, status: 200, json: async () => JSON.parse(VOCAB_TEXT) } : { ok: false, status: 404, json: async () => ({}) });
globalThis.__SUPABASE_MODULE_URL = `data:text/javascript,${encodeURIComponent("export const createClient = () => ({ auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) }, from: () => ({}) });")}`;

// 偽の時計（書き手の時刻。null なら本物）
const RealDate = Date;
let clock = null;
class FakeDate extends RealDate {
  constructor(...a) {
    if (a.length === 0) super(clock ?? RealDate.now());
    else super(...a);
  }
  static now() {
    return clock ?? RealDate.now();
  }
}
globalThis.Date = FakeDate;

const L = await import(modUrl("js/learnState.js"));
const R = await import(modUrl("js/rank.js"));
const PV = await import(modUrl("js/publicVocab.js"));
const LP = await import(modUrl("js/learnPace.js"));
const BP = await import(modUrl("js/bookPace.js"));
const ST = await import(modUrl("js/stats.js"));
const S = await import(modUrl("js/storage.js"));
const { localDay, dayNoOf } = await import(modUrl("js/retentionCalc.js"));
const VOCAB = PV.makePublicVocab(JSON.parse(VOCAB_TEXT));
const T = VOCAB.total;
const PUB = VOCAB.order;
const { LEARN_UNSURE: UNSURE, LEARN_LEARNED: LEARNED, ANSWER_KINDS: K } = L;
const at = (y, m, d, h = 12, mi = 0) => new RealDate(y, m - 1, d, h, mi).getTime();
const dayOf = (ms) => dayNoOf(localDay(new RealDate(ms)));
const D = (n, h = 12) => at(2026, 10, 1 + n, h); // 10/1 から n 日後
const TODAY = dayOf(D(20)); // 10/21

// ── 1. ランクの見せ方（rankView）: 境の前後・下げない・次のランクまで ─────────────
const NAMES = ["赤ちゃん", "よちよち", "単語キッズ", "小学生", "中学生", "高校生", "留学生", "バイリンガル", "アメリカ人"];
const AT = [0, 120, 350, 650, 1000, 1400, 1850, 2350, T];
eq("9 段の名前（決定 §5）", [...R.RANK_NAMES], NAMES);
eq("境は 0・120・350・650・1,000・1,400・1,850・2,350・総数（data/public/english.json の total）", R.rankThresholds(T), AT);
eq("総数は公開の表の total（2,857。5月の返事待ちで 1 か所だけ動く）", T, JSON.parse(VOCAB_TEXT).total);
for (let k = 1; k < AT.length; k++) {
  const before = R.rankView(AT[k] - 1, null, T);
  const exact = R.rankView(AT[k], null, T);
  const after = R.rankView(Math.min(AT[k] + 1, T), null, T);
  eq(`境 ${AT[k]} − 1 語: ${NAMES[k - 1]}・次（${NAMES[k]}）まであと 1 語`, [before.name, before.next?.name, before.next?.remaining], [NAMES[k - 1], NAMES[k], 1]);
  eq(
    `境 ${AT[k]} ちょうど: ${NAMES[k]}${k < 8 ? `・次（${NAMES[k + 1]}）まであと ${AT[k + 1] - AT[k]} 語` : "・次のランクの行なし"}`,
    [exact.name, exact.next?.name ?? null, exact.next?.remaining ?? null],
    [NAMES[k], k < 8 ? NAMES[k + 1] : null, k < 8 ? AT[k + 1] - AT[k] : null]
  );
  if (k < 8) eq(`境 ${AT[k]} + 1 語: ${NAMES[k]}・次まであと ${AT[k + 1] - AT[k] - 1} 語`, [after.name, after.next?.remaining], [NAMES[k], AT[k + 1] - AT[k] - 1]);
}
eq("0 語: 赤ちゃん・よちよちまであと 120 語", [R.rankView(0, null, T).name, R.rankView(0, null, T).next.remaining], ["赤ちゃん", 120]);
eq("最高到達ランクが今より上（中学生 = 4・今 900 語）: 中学生のまま・次（高校生）まであと 500 語（今の数から正直に）", R.rankView(900, 4, T), { rank: 4, name: "中学生", next: { rank: 5, name: "高校生", at: 1400, remaining: 500 } });
eq("最高到達ランクがアメリカ人で今 2,000 語: アメリカ人のまま・次の行なし（覚えた N は今の数）", R.rankView(2000, 8, T), { rank: 8, name: "アメリカ人", next: null });
eq("最高到達ランクが今より下: 今の語数の段（最高到達ランクは上げる側の値）", R.rankView(1000, 1, T).name, "中学生");
eq("最高到達ランクの壊れた値は無視（今の語数の段）", ["x", -1, 9, 3.5, ""].map((p) => R.rankView(130, p, T).name), Array(5).fill("よちよち"));
{
  // 下げない: 覚えたが減っていく並びでも、見せるランクは前の最高より下がらない（学習状況が最高到達ランクを上げてから見せる形）
  const store = new FakeStorage();
  const trail = [0, 130, 700, 1200, 640, 100, 0, 1500, 300].map((n) => {
    R.raiseRankPeak(R.rankFor(n, T), store);
    return R.rankView(n, R.readRankPeak(store), T).name;
  });
  eq("見せるランクは下がらない（130・700・1,200 → 640・100・0 でも中学生 → 1,500 で高校生 → 300 でも高校生）", trail, ["赤ちゃん", "よちよち", "小学生", "中学生", "中学生", "中学生", "中学生", "高校生", "高校生"]);
}
{
  const got = [];
  globalThis.addEventListener("spelldash:rank-peak", (e) => got.push(e.detail.peak));
  const store = new FakeStorage({ [R.RANK_PEAK_KEY]: "2" });
  R.raiseRankPeak(1, store);
  R.raiseRankPeak(2, store);
  R.raiseRankPeak(4, store);
  eq("最高到達ランクを上げたときだけ spelldash:rank-peak を知らせる（下げる・同じは知らせない）", got, [4]);
}
eq("段の名前と番号（rankName・rankOfName）", [R.rankName(4), R.rankName("8"), R.rankName(9), R.rankOfName("中学生"), R.rankOfName("銀 2")], ["中学生", "アメリカ人", null, 4, null]);

// ── 2. 最初の画面の数（learnStatusOf） ─────────────
const tableOf = (entries) => Object.fromEntries(entries);
{
  const table = tableOf([
    ...PUB.slice(0, 120).map((id) => [id, { ls: 2 }]), // 覚えた 120 = よちよち
    [PUB[120], { ls: 1 }], // あやふや・数えた日なし → 今日の分
    [PUB[121], { ls: 1, lsd: TODAY - 1 }], // 前の日に数えた → 今日の分
    [PUB[122], { ls: 1, lsd: TODAY }], // 今日数えた → 今日の分ではない
    [PUB[124], { ls: 1, lsd: TODAY + 2 }], // 時計が戻って先の日を数えている → 今日答えても数えないので今日の分ではない（js/learnQueue.js と同じ）
    ["concept-ad-cpc", { ls: 2 }], // 非公開の語は数えない
    [PUB[123], { playCount: 1 }] // 出題だけ → これから
  ]);
  const s = LP.learnStatusOf({ table, source: { vocab: VOCAB, pending: null }, peak: null, today: TODAY });
  eq("3 状態の数（覚えた 120・あやふや 4・これから 残り）と和 = 総数", [s.counts, s.counts.new + s.counts.unsure + s.counts.learned], [{ new: T - 124, unsure: 4, learned: 120, total: T }, T]);
  eq("ランク: 覚えた 120 = よちよち・次（単語キッズ）まであと 230 語・今の語数の段 1", [s.rank.name, s.rank.next.remaining, s.computed], ["よちよち", 230, 1]);
  eq("今日の分（あやふやのうち数えた日が無いか今日より前の語）= 2", s.due, 2);
  const done = LP.learnStatusOf({ table: tableOf([[PUB[0], { ls: 1, lsd: TODAY }], [PUB[1], { ls: 1, lsd: TODAY }]]), source: { vocab: VOCAB, pending: null }, peak: 6, today: TODAY });
  eq("あやふや 2 語がどちらも今日数えた → 今日の分 0（札は「今日の分は終わり」）・最高到達ランク 6（留学生）を見せる・今の語数の段 0", [done.counts.unsure, done.due, done.rank.name, done.computed, done.rank.next.remaining], [2, 0, "留学生", 0, 2350]);
  const pending = new Map([[PUB[5], UNSURE], [PUB[6], LEARNED]]);
  const v6 = LP.learnStatusOf({ table: tableOf([[PUB[5], { playCount: 2, recallFail: 1 }], [PUB[6], { playCount: 1 }]]), source: { vocab: VOCAB, pending }, peak: null, today: TODAY });
  eq("版 6 の間（pending）: 式の状態で数える（あやふや 1・覚えた 1・今日の分 1）", [v6.counts.unsure, v6.counts.learned, v6.due], [1, 1, 1]);
  eq("今日の分の文は「今日の分は終わり」", LP.UNSURE_DONE_TODAY, "今日の分は終わり");
}

// ── 3. 目安の印 lsf（js/learnState.js applyLearnAnswer） ─────────────
const ans = (stat, kind, ms, fallback) => L.applyLearnAnswer(stat, kind, ms, fallback);
{
  const a = ans(undefined, K.exact, D(3));
  eq("これから + 自力正解 → 覚えた・印は今日（10/4）", [a.ls, a.lsf], [LEARNED, dayOf(D(3))]);
  const b = ans(a, K.miss, D(4));
  const c = ans(b, K.exact, D(5));
  const d = ans(c, K.exact, D(6));
  eq("覚えた → × → 別の日に 2 回 → 覚えたに戻っても印は前の日のまま（もう一度は数えない）", [b.ls, b.lsf, c.ls, d.ls, d.lsf], [UNSURE, dayOf(D(3)), UNSURE, LEARNED, dayOf(D(3))]);
  const x = ans(undefined, K.reveal, D(3));
  eq("これから + × → あやふや・印なし（まだ決めていない）", [x.ls, "lsf" in x], [UNSURE, false]);
  const y = ans(ans(x, K.exact, D(4)), K.exact, D(5));
  eq("あやふや → 別の日に 2 回で覚えた → 印はその日（10/6。中心の学習で新しく覚えた）", [y.ls, y.lsf], [LEARNED, dayOf(D(5))]);
  const m = ans({ playCount: 3, ls: 2 }, K.exact, D(7));
  eq("移行で覚えた（ls 2・印なし）に中心の学習で答えた → 印 0（数えない）", [m.ls, m.lsf], [LEARNED, 0]);
  const m2 = ans(ans(ans({ ls: 2 }, K.hint, D(7)), K.exact, D(8)), K.exact, D(9));
  eq("移行で覚えた語が × で外れて別の日に 2 回で戻っても印 0 のまま（目安に数えない）", [m2.ls, m2.lsf], [LEARNED, 0]);
  const u = ans({ ls: 1 }, K.exact, D(7));
  const u2 = ans(u, K.exact, D(8));
  eq("移行であやふや（ls 1）だった語が中心の学習で覚えた → 印はその日（新しく覚えた）", [u.ls, "lsf" in u, u2.ls, u2.lsf], [UNSURE, false, LEARNED, dayOf(D(8))]);
  const p = ans({ playCount: 1 }, K.exact, D(7), LEARNED);
  eq("版 6 の間に式で覚えた（pending）の語に答えた → 印 0", [p.ls, p.lsf], [LEARNED, 0]);
  const keep = ans({ ls: 2, lsf: 0 }, K.miss, D(7));
  eq("印のある語は替えない（0 のまま）", keep.lsf, 0);
  const bad = ans(undefined, K.exact, NaN);
  eq("日が読めない時刻で覚えた → 印 0（数えない側）", [bad.ls, bad.lsf], [LEARNED, 0]);
  eq("印の欄は状態の欄の 1 つ（同期の取り込みで端末の値を残す: learnFieldsOf）", [L.LEARN_FIELDS.includes("lsf"), L.learnFieldsOf({ ls: 2, lsf: 5, playCount: 1 })], [true, { ls: 2, lsf: 5 }]);
  eq("firstLearnedDay: 1 以上の日だけ", [L.firstLearnedDay({ lsf: 20000 }), L.firstLearnedDay({ lsf: 0 }), L.firstLearnedDay({}), L.firstLearnedDay(null), L.firstLearnedDay({ lsf: "3" })], [20000, null, null, null, null]);
}
{
  // 書き手（js/stats.js recordLearnAnswer）: 印も同じ 1 回の保存に入る（setItem を増やさない）
  LS = new FakeStorage({ spelldash_schema_version: "7", spelldash_word_stats: "{}" });
  S.forgetWordStats();
  await S.loadLearnStates();
  const W = PUB[30];
  clock = D(10, 9);
  ST.recordPlay(W);
  S.flushWordStats();
  const before = LS.writes.filter((k) => k === "spelldash_word_stats").length;
  ST.recordCorrect(W, true);
  const saved = await ST.recordLearnAnswer(W, K.exact);
  const t = JSON.parse(LS.getItem("spelldash_word_stats"));
  eq("書き手: 初回の自力正解で 覚えた・印は今日・保存 1 回（ほかの書き手と同じ 1 回）", [saved, t[W].ls, t[W].lsf, LS.writes.filter((k) => k === "spelldash_word_stats").length - before], [true, LEARNED, dayOf(D(10)), 1]);
  eq("書き手: 目安のための鍵を足さない（古い鍵 spelldash_book_pace も書かない。書くのは語の記録と送信待ちの印だけ）", [...new Set(LS.writes)].sort(), ["spelldash_dirty_words", "spelldash_word_stats"]);
  clock = null;
}

// ── 4. 目安（js/learnPace.js learnPaceOf） ─────────────
const learnedOn = (n, dayNo, extra = {}) => PUB.slice(0, n).map((id) => [id, { ls: 2, lsf: dayNo, ...extra }]);
// days: [[今日からの差（0 = 今日・−3 = 3 日前）, その日に覚えた語の数], ...]。lsAt は覚えた日の正午
function seedPace(days, { fill = 0, extraTable = {} } = {}) {
  const table = {};
  let i = 0;
  for (const [delta, n] of days) {
    for (let k = 0; k < n; k++) {
      const day = TODAY + delta;
      table[PUB[i++]] = { ls: 2, lsf: day, lsAt: at(2026, 10, 21 + delta, 12) };
    }
  }
  for (let k = 0; k < fill; k++) table[PUB[i++]] = { ls: 2 }; // 移行で覚えた（印なし）: 覚えたの数には入るが進みには入らない
  return { ...table, ...extraTable };
}
const paceOfSeed = (table, today = TODAY) => {
  const learned = L.countLearnStates(table, VOCAB).learned;
  return LP.learnPaceOf({ table, vocab: VOCAB, learned, today });
};
{
  const p = paceOfSeed(seedPace([[0, 14], [-3, 7], [-9, 7]], { fill: 400 }));
  // 進み 28・始めた日 9 日前 → 10 日で割る: 残り 2,857 − 428 = 2,429・2429×10÷28 = 867.5 → 868 > 365 → 待ち
  eq("目安: 進んだ日 3・進み 28・始めて 10 日・残り 2,429 → 868 日 > 365 は出さない（待ちの文）", [p.kind, LP.paceLineText(p)], ["wait", "学習を続けると、完了までの目安が表示されます。"]);
  const big = seedPace([[0, 100], [-1, 100], [-5, 100], [-13, 100]], { fill: 1000 }); // 進み 400・14 日・残り 1,457 → 1457×14÷400 = 50.995 → 51
  const q = paceOfSeed(big);
  eq("目安: 進み 400・14 日で割る・残り 1,457 → 約 51 日", [q.kind, q.days, q.span, q.gain, LP.paceLineText(q), q.note], ["pace", 51, 14, 400, "今のペースなら、あと約51日です。", "覚えた で数えています。この端末の記録から計算しています。"]);
  const old = paceOfSeed(seedPace([[0, 100], [-1, 100], [-5, 100], [-14, 100]], { fill: 1000 })); // 14 日前の行は窓の外
  eq("目安: 窓は今日を含む 14 暦日（14 日前の 100 語は進みに入らない・始めた日はその日なので 14 日で割る）", [old.gain, old.active, old.span], [300, 3, 14]);
  const two = paceOfSeed(seedPace([[0, 300], [-2, 300]], { fill: 1000 }));
  eq("目安: 進んだ日が 2 日なら待ちの文（進み 600 でも）", [two.kind, two.active], ["wait", 2]);
  const fresh = paceOfSeed(seedPace([[0, 100], [-2, 100], [-4, 100]], { fill: 1000 })); // 始めて 5 日 → 5 日で割る: 残り 1557×5÷300 = 25.95 → 26
  eq("目安: 記録を始めて 5 日なら 5 日で割る（1 日あたり 60 語・約 26 日）", [fresh.kind, fresh.span, fresh.days], ["pace", 5, 26]);
  const early = seedPace([[0, 100], [-2, 100], [-4, 100]], { fill: 1000 });
  early[PUB[2000]] = { ls: 1, lsAt: at(2026, 10, 11, 12) }; // 10 日前に中心の学習で答えたあやふやの語 → 始めた日は 10 日前
  const e = paceOfSeed(early);
  eq("目安: 記録を始めた日は答えた跡（lsAt）のいちばん早い日（10 日前 → 11 日で割る: 1557×11÷300 = 57.09 → 57）", [e.span, e.days], [11, 57]);
  const migrated = paceOfSeed(tableOf([...learnedOn(1500, 0), ...PUB.slice(1500, 1503).map((id, i) => [id, { ls: 2, lsf: TODAY - i, lsAt: at(2026, 10, 21 - i) }])]));
  eq("目安: 移行で覚えた語（印 0）は進みに入らない（1,500 語あっても進み 3）", [migrated.gain, migrated.active], [3, 3]);
  const all = paceOfSeed(tableOf(PUB.map((id) => [id, { ls: 2 }])));
  eq("目安: 全部覚えた → 「完了」と注", [all.kind, LP.paceLineText(all), all.note], ["done", "完了", "覚えた で数えています。"]);
  const none = paceOfSeed({});
  eq("目安: 記録が無い → 待ちの文と注（残りは総数）", [none.kind, LP.paceLineText(none), none.note], ["wait", "学習を続けると、完了までの目安が表示されます。", "覚えた で数えています。"]);
  const future = paceOfSeed(seedPace([[0, 100], [-1, 100], [-2, 100], [3, 500]], { fill: 1000 })); // 時計が戻った（先の日の印）: 進みに入らない
  eq("目安: 今日より先の日の印（時計が戻った）は進みに入らない", future.gain, 300);
  const back = seedPace([[0, 100], [-1, 100], [-5, 100], [-13, 100]], { fill: 1000 });
  for (const id of PUB.slice(0, 100)) back[id] = { ...back[id], ls: 1 }; // 今日覚えた 100 語が外れた（あやふや）: 進みは引かない・残りは増える
  const fb = paceOfSeed(back);
  eq("目安: 外れた語は進みから引かない（進み 400 のまま）・残りは今の覚えたから（1,557）", [fb.gain, fb.days], [400, Math.max(1, Math.floor((2 * 1557 * 14 + 400) / (2 * 400)))]);
  eq("目安の見出し・注・待ちの文（Batch 76 と同じ待ちの文）", [LP.LEARN_PACE_TITLE, LP.LEARN_PACE_NOTE, BP.PACE_WAIT], ["全部覚えるまでの目安", "覚えた で数えています。", "学習を続けると、完了までの目安が表示されます。"]);
}

// ── 5. 画面の文に古い状態名を入れない（js/learnPace.js・js/rank.js の文） ─────────────
{
  const texts = [LP.LEARN_PACE_TITLE, LP.LEARN_PACE_NOTE, LP.UNSURE_DONE_TODAY, BP.PACE_WAIT, BP.PACE_DEVICE_NOTE, ...R.RANK_NAMES];
  ok("目安とランクの文に 未着手・苦手・習得・知ってた・済み が無い", texts.every((t) => !/未着手|苦手|習得|知ってた|済み/.test(t)));
}

if (failures.length) {
  console.error(failures.map((f) => `✗ ${f}`).join("\n"));
  console.error(`\n${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`OK: 学習状況とランクと目安 ${passed} 件`);
