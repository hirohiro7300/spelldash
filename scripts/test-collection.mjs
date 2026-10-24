// 書斎コレクションのコア（js/collectionData.js・js/collectionStore.js と js/backup.js の残す処理）の単体テスト。ブラウザなしで 1 秒で終わる:
//   node scripts/test-collection.mjs
// 失敗が 1 つでもあれば終了コード 1。
// 時刻は now を、乱数は rand を渡す（端末の時計と Math.random に頼らない）。localStorage は Map の模擬（鍵ごとの setItem の回数を数え、
// 読む・書くが投げる端末も作れる）。バックアップの復元と「この端末の記録を消す」は js/backup.js をそのまま読む。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isDeepStrictEqual } from "util";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
const failures = [];
function eq(name, actual, expected) {
  if (isDeepStrictEqual(actual, expected)) passed++;
  else failures.push(`${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}
const ok = (name, cond, detail = "") => eq(`${name}${detail ? ` (${detail})` : ""}`, !!cond, true);

// ---- 殻: localStorage・window・document ----
const store = new Map();
const writes = new Map();
const mode = { getThrows: false, setThrows: false };
const quotaError = () => Object.assign(new Error("quota"), { name: "QuotaExceededError" });
const fakeStorage = {
  getItem(k) {
    if (mode.getThrows) throw new Error("denied");
    return store.has(k) ? store.get(k) : null;
  },
  setItem(k, v) {
    if (mode.setThrows) throw quotaError();
    writes.set(k, (writes.get(k) ?? 0) + 1);
    store.set(k, String(v));
  },
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  }
};
Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: fakeStorage });
const session = new Map();
Object.defineProperty(globalThis, "sessionStorage", {
  configurable: true,
  writable: true,
  value: { getItem: (k) => (session.has(k) ? session.get(k) : null), setItem: (k, v) => session.set(k, String(v)), removeItem: (k) => session.delete(k), clear: () => session.clear() }
});
const events = new EventTarget();
const noop = () => {};
globalThis.window = globalThis;
globalThis.addEventListener = events.addEventListener.bind(events);
globalThis.removeEventListener = events.removeEventListener.bind(events);
globalThis.dispatchEvent = events.dispatchEvent.bind(events);
globalThis.location ??= { search: "", hostname: "localhost", pathname: "/", href: "http://localhost/", origin: "http://localhost" };
globalThis.document ??= {
  addEventListener: noop,
  removeEventListener: noop,
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  documentElement: { dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false } },
  body: null,
  visibilityState: "visible",
  hidden: false
};

const D = await import("../js/collectionData.js");
const S = await import("../js/collectionStore.js");
const KEY = D.COLLECTION_KEY;
const CORRUPT = D.COLLECTION_CORRUPT_KEY;

const at = (y, m, d, h = 12, mi = 0) => new Date(y, m - 1, d, h, mi);
const iso = (date) => date.toISOString();
const writesOf = (k) => writes.get(k) ?? 0;
const allWrites = () => [...writes.values()].reduce((a, b) => a + b, 0);
const saved = () => JSON.parse(store.get(KEY));
function reset(raw) {
  store.clear();
  writes.clear();
  session.clear();
  mode.getThrows = false;
  mode.setThrows = false;
  if (raw !== undefined) store.set(KEY, typeof raw === "string" ? raw : JSON.stringify(raw));
}
// 残高 n の v1 の保存（受け取り 1 件）
const withInk = (n, extra = {}) => ({ v: 1, claims: { "daily:2026-10-01": { n, at: iso(at(2026, 10, 1)) } }, ...extra });
// 種つきの乱数（mulberry32）
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = at(2026, 11, 2, 8);
const NEXT = at(2026, 11, 3, 0, 0);

// ── 1. 今日の贈り物は 1 日 1 回 ──
{
  reset();
  const r1 = S.claimDaily(DAY);
  eq("日次: 初めての日に 1 つ（claim id は daily:<ローカルの日>）", [r1.ok, r1.granted, r1.claimId, r1.memoryInk], [true, 1, "daily:2026-11-02", 1]);
  eq("日次: 書いたのは 1 回だけ（1 つの鍵）", [writesOf(KEY), allWrites()], [1, 1]);
  const r2 = S.claimDaily(at(2026, 11, 2, 23, 59));
  eq("日次: 同じ日の 2 回目（23:59・リロードの後と同じ）は dup・配らない・書かない", [r2.ok, r2.reason, r2.granted, r2.memoryInk, writesOf(KEY)], [false, "dup", 0, 1, 1]);
  eq("日次: hasClaim は受け取り済み", S.hasClaim("daily:2026-11-02"), true);
}

// ── 2. 日付が変わった後 ──
{
  const r3 = S.claimDaily(NEXT);
  eq("日付変更: 翌日の 0:00 はもう 1 つ", [r3.ok, r3.granted, r3.claimId, r3.memoryInk], [true, 1, "daily:2026-11-03", 2]);
  const ST = await import("../js/stats.js");
  const days = [at(2026, 11, 2, 23, 59), at(2026, 11, 3, 0, 0), at(2026, 3, 29, 1, 30), at(2026, 12, 31, 23, 59), at(2027, 1, 1, 0, 0)];
  eq("日付変更: 日の境は js/stats.js localDateString と同じ（ローカルの 0 時）", days.map((d) => S.dayKeyOf(d)), days.map((d) => ST.localDateString(d)));
  eq("日付変更: 時刻の ms・ISO も読む／読めない値は null", [S.dayKeyOf(DAY.getTime()), S.dayKeyOf(DAY.toISOString()), S.dayKeyOf("no"), S.dailyClaimId("2026-02-30"), S.dailyClaimId("2026-11-02")], ["2026-11-02", "2026-11-02", null, null, "daily:2026-11-02"]);
  reset();
  S.recordStudySession({ recalled: 7 }, DAY);
  eq("日付変更: 今日の数え（today）は次の日に 0 から", [S.getCollectionView(DAY).today.recalled, S.getCollectionView(NEXT).today], [7, { day: "2026-11-03", recalled: 0, reviewSeen: false }]);
}

// ── 3. その日最初の 10 語（重複しない） ──
{
  reset();
  const s1 = S.recordStudySession({ recalled: 6 }, DAY);
  eq("10 語: 6 語では配らない（数えは書く）", [s1.ok, s1.reason, s1.granted, s1.recalled, writesOf(KEY)], [false, "condition", 0, 6, 1]);
  const s2 = S.recordStudySession({ recalled: 5 }, at(2026, 11, 2, 20));
  eq("10 語: 合わせて 11 語で 2 つ（study10:<日>）", [s2.ok, s2.granted, s2.claimId, s2.recalled, s2.memoryInk], [true, 2, "study10:2026-11-02", 11, 2]);
  const s3 = S.recordStudySession({ recalled: 10 }, at(2026, 11, 2, 21));
  eq("10 語: 同じ日にもう 10 語でも dup（繰り返しで取れない）", [s3.ok, s3.reason, s3.granted, s3.recalled, s3.memoryInk], [false, "dup", 0, 21, 2]);
  const before = writesOf(KEY);
  const s4 = S.recordStudySession({ recalled: 20, retry: true }, NEXT);
  const s5 = S.recordStudySession({ recalled: 0 }, NEXT);
  eq("10 語: もう一度の回（retry）と 0 語は数えない・書かない", [s4.reason, s4.granted, s5.reason, writesOf(KEY) - before, S.getCollectionView(NEXT).today.recalled], ["condition", 0, "condition", 0, 0]);
  eq("10 語: 数でない・負の語数は invalid", [S.recordStudySession({ recalled: -1 }, NEXT).reason, S.recordStudySession({ recalled: "3" }, NEXT).reason, S.recordStudySession(undefined, NEXT).reason], ["invalid", "invalid", "invalid"]);
  const s6 = S.recordStudySession({ recalled: 10 }, NEXT);
  eq("10 語: 翌日はまた 0 から数えて 10 語で 2 つ", [s6.granted, s6.claimId, s6.memoryInk], [2, "study10:2026-11-03", 4]);
}

// ── 4. 今日の復習（判定の材料は呼び手が渡す） ──
{
  reset();
  const r0 = S.claimReview({ dueRemaining: 0 }, DAY);
  eq("復習: 期日の来た語が無かった日（noteReviewDue なし）は 0 語でも配らない・書かない", [r0.ok, r0.reason, writesOf(KEY)], [false, "condition", 0]);
  const n1 = S.noteReviewDue(DAY);
  const n2 = S.noteReviewDue(at(2026, 11, 2, 9));
  eq("復習: noteReviewDue は今日の印を 1 回だけ書く", [n1.ok, n2.ok, writesOf(KEY)], [true, true, 1]);
  const r1 = S.claimReview({ dueRemaining: 2 }, DAY);
  eq("復習: まだ 2 語残る間は配らない", [r1.ok, r1.reason, r1.granted], [false, "condition", 0]);
  const r2 = S.claimReview({ dueRemaining: 0 }, DAY);
  eq("復習: 全部片付いたら 1 つ（review:<日>）", [r2.ok, r2.granted, r2.claimId, r2.memoryInk], [true, 1, "review:2026-11-02", 1]);
  const r3 = S.claimReview({ dueRemaining: 0 }, DAY);
  eq("復習: 同じ日の 2 回目は dup", [r3.ok, r3.reason, r3.granted], [false, "dup", 0]);
  eq("復習: 翌日は印が消える（その日の材料が要る）", S.claimReview({ dueRemaining: 0 }, NEXT).reason, "condition");
  eq("復習: 残りの数が無い・負は invalid", [S.claimReview({}, DAY).reason, S.claimReview({ dueRemaining: -1 }, DAY).reason], ["invalid", "invalid"]);
}

// ── 5. 一冊（永続で 1 回） ──
{
  reset();
  const b1 = S.settleBook("jhs-english1", { before: false, after: true }, DAY);
  eq("一冊: 済みでない → 済みで 5 つ（book:<本の id>）", [b1.ok, b1.granted, b1.claimId, b1.memoryInk], [true, 5, "book:jhs-english1", 5]);
  const b2 = S.settleBook("jhs-english1", { before: false, after: true }, NEXT);
  eq("一冊: 済みが外れて戻っても・外して足し直しても dup", [b2.ok, b2.reason, b2.granted], [false, "dup", 0]);
  const pre = S.settleBook("junior", { before: true, after: true }, DAY);
  const pre2 = S.settleBook("junior", { before: false, after: true }, NEXT);
  eq("一冊: 回の始めに既に済み（導入前の完了）は印だけで 0・後で済みに戻っても配らない", [pre.ok, pre.granted, pre.pre, saved().claims["book:junior"].n, saved().claims["book:junior"].pre, pre2.reason], [true, 0, true, 0, true, "dup"]);
  const syn = S.settleBook("toeic", { before: false, after: true, synced: true }, DAY);
  eq("一冊: 回の途中に同期で済みになった本は印だけで 0", [syn.ok, syn.granted, syn.pre], [true, 0, true]);
  const w = writesOf(KEY);
  const not = S.settleBook("highschool", { before: false, after: false }, DAY);
  eq("一冊: 済みでなければ何もしない", [not.reason, writesOf(KEY) - w], ["condition", 0]);
  eq("一冊: すべて・マイ単語帳・形の違う id・真偽値でない材料は invalid",
    [S.settleBook("all", { before: false, after: true }, DAY).reason, S.settleBook("my", { before: false, after: true }, DAY).reason, S.settleBook("Bad Id", { before: false, after: true }, DAY).reason, S.settleBook("", { before: false, after: true }, DAY).reason, S.settleBook("toeic500", { before: "no", after: true }, DAY).reason],
    ["invalid", "invalid", "invalid", "invalid", "invalid"]);
  eq("一冊: claim id の形（本の id に daily があっても日次と重ならない）", [S.bookClaimId("daily"), S.bookClaimId("all"), S.parseClaimId("book:daily"), S.parseClaimId("daily:2026-11-02")], ["book:daily", null, { kind: "book", categoryId: "daily" }, { kind: "daily", day: "2026-11-02" }]);
  // 61 日後に書いても（日次は畳まれる）本の受け取りは残る
  const later = at(2027, 1, 15);
  S.claimDaily(later);
  eq("一冊: 61 日より後に書いても畳まない・消さない", [saved().claims["book:jhs-english1"]?.n, S.settleBook("jhs-english1", { before: false, after: true }, later).reason], [5, "dup"]);
  eq("一冊: 残高は 5 と日次 1 だけ", S.getMemoryInk(), 6);
}

// ── 6. 残高の加算と消費（保存しない。台帳から出す） ──
{
  reset();
  S.claimDaily(DAY);
  S.recordStudySession({ recalled: 10 }, DAY);
  S.settleBook("jhs-english1", { before: false, after: true }, DAY);
  eq("残高: 受け取りの和（1 + 2 + 5）", S.getMemoryInk(), 8);
  const d1 = S.drawOnce({ rand: () => 0.1, now: DAY });
  eq("残高: 1 回引くと 3 減る", [d1.ok, d1.memoryInk, S.getMemoryInk()], [true, 5, 5]);
  ok("残高: 保存に残高の欄は無い", !("memoryInk" in saved()) && !("balance" in saved()));
  eq("残高: memoryInkOf は 受け取り − 消費 + 戻し", S.memoryInkOf(saved()), 5);
  reset({ v: 1, claims: { "daily:2026-11-01": { n: 1, at: iso(DAY) } }, draws: [{ id: "draw:aaaa1111-1", at: iso(DAY), t: "t1", r: 0.5, rarity: "N", item: "window-rain", cost: 3, dup: false, refund: 0 }] });
  eq("残高: 生の値が負（改変・競合）でも画面の値は 0", [S.memoryInkOf(saved()), S.getMemoryInk(), S.getCollectionView(DAY).memoryInk], [-2, 0, 0]);
  eq("残高: 生の値が負なら引けない", S.drawOnce({ rand: () => 0.5, now: DAY }).reason, "short");
}

// ── 7. 残高不足 ──
{
  reset(withInk(2));
  let calls = 0;
  const r = S.drawOnce({ rand: () => (calls++, 0.5), now: DAY });
  eq("残高不足: 2 では引けない（short・あと 1）・乱数を使わない・書かない", [r.ok, r.reason, r.need, r.memoryInk, calls, allWrites(), saved().draws ?? []], [false, "short", 1, 2, 0, 0, []]);
  reset(withInk(3));
  eq("残高不足: ちょうど 3 なら引ける", [S.drawOnce({ rand: () => 0.5, now: DAY }).ok, S.getMemoryInk()], [true, 0]);
}

// ── 8. 固定乱数での抽選率（表示順・配列順に依存しない） ──
{
  const T = D.DRAW_TABLE;
  eq("抽選表: 版は t1・重みの和 100", [T.version, T.total, D.DRAW_TABLE_VERSION], ["t1", 100, "t1"]);
  eq("抽選表: t1 の指紋（品・重み・有効を変えたら版を上げる）", D.drawTableFingerprint(T),
    "N:70:binding-brown,desk-notebook,fx-gold-edge,window-rain|R:25:binding-redleather,desk-hourglass,fx-layered-paper,window-morning|SR:5:binding-memory-tree,desk-grimoire,fx-ink-star,window-moon");
  const N = 10000;
  const byRarity = {};
  const byItem = {};
  for (let i = 0; i < N; i++) {
    const p = D.pickDraw((i + 0.5) / N);
    byRarity[p.rarity] = (byRarity[p.rarity] ?? 0) + 1;
    byItem[p.item] = (byItem[p.item] ?? 0) + 1;
  }
  eq("抽選率: 均等な掃引で N 70%・R 25%・SR 5%", byRarity, { N: 7000, R: 2500, SR: 500 });
  eq("抽選率: 帯の中の品は等分（N 1750・R 625・SR 125）", D.ITEMS.map((it) => byItem[it.id]), D.ITEMS.map((it) => ({ N: 1750, R: 625, SR: 125 })[it.rarity]));
  const rand = seeded(77);
  const counts = { N: 0, R: 0, SR: 0 };
  const M = 100000;
  for (let i = 0; i < M; i++) counts[D.pickDraw(rand()).rarity]++;
  ok("抽選率: 種つきの乱数 10 万回で ±1% の内", Math.abs(counts.N / M - 0.7) < 0.01 && Math.abs(counts.R / M - 0.25) < 0.01 && Math.abs(counts.SR / M - 0.05) < 0.01, JSON.stringify(counts));
  const shuffled = D.buildDrawTable([...D.ITEMS].reverse().map((it) => ({ ...it, order: 100 - it.order })));
  let same = true;
  for (let i = 0; i < N; i++) {
    const r = (i + 0.5) / N;
    if (!isDeepStrictEqual(D.pickDraw(r, shuffled), D.pickDraw(r, T))) same = false;
  }
  ok("抽選: 品の並びと表示順を逆にしても、全部の r で同じ品", same && D.drawTableFingerprint(shuffled) === D.drawTableFingerprint(T));
  eq("抽選: 端の r（0 は最初の帯の最初・1 の手前は最後の帯の最後）", [D.pickDraw(0), D.pickDraw(1 - 1e-12)], [{ rarity: "N", item: "binding-brown" }, { rarity: "SR", item: "window-moon" }]);
  eq("抽選: 範囲外・数でない r は null", [D.pickDraw(1), D.pickDraw(-0.1), D.pickDraw(NaN), D.pickDraw("0.5"), D.pickDraw(undefined)], [null, null, null, null, null]);
  const partial = D.buildDrawTable(D.ITEMS.map((it) => (it.id === "window-rain" ? { ...it, enabled: false } : it.id === "window-morning" ? { ...it, sale: "pro" } : it.rarity === "SR" ? { ...it, enabled: false } : it)));
  eq("抽選表: 無効の品・販売区分のある品は入れない・品の無いレアリティは帯を作らない", [partial.total, partial.bands.map((b) => b.rarity), partial.bands[0].items.includes("window-rain"), partial.bands[1].items.includes("window-morning")], [95, ["N", "R"], false, false]);
  eq("抽選表: 品が 1 つも無ければ total 0 で pickDraw は null", D.pickDraw(0.5, D.buildDrawTable([])), null);
  const rates = D.rateTable();
  eq("提供の割合: N 70・R 25・SR 5、品ごとに 17.5・6.25・1.25", rates.map((r) => [r.rarity, r.percent, r.items.map((i) => i.percent)]), [["N", 70, [17.5, 17.5, 17.5, 17.5]], ["R", 25, [6.25, 6.25, 6.25, 6.25]], ["SR", 5, [1.25, 1.25, 1.25, 1.25]]]);
  // 保存の抽選は pickDraw のとおりで、乱数と表の版を残す
  reset(withInk(9));
  const g = S.drawOnce({ rand: () => 0.93, now: DAY });
  eq("抽選: drawOnce は pickDraw(r) の品を、r と版 t1 と一緒に残す", [g.item.id, g.rarity, saved().draws[0].r, saved().draws[0].t, saved().draws[0].cost], [D.pickDraw(0.93).item, D.pickDraw(0.93).rarity, 0.93, "t1", 3]);
  eq("抽選: 範囲外の乱数・投げる乱数は invalid で書かない", [S.drawOnce({ rand: () => 1, now: DAY }).reason, S.drawOnce({ rand: () => { throw new Error("x"); }, now: DAY }).reason, saved().draws.length], ["invalid", "invalid", 1]);
}

// ── 9. 重複の変換 ──
{
  reset(withInk(6));
  const a = S.drawOnce({ rand: () => 0.01, now: DAY });
  const b = S.drawOnce({ rand: () => 0.01, now: at(2026, 11, 2, 9) });
  eq("重複: 1 回目は新しい品", [a.ok, a.dup, a.refund, a.granted], [true, false, 0, 0]);
  eq("重複: 同じ品は所持を増やさず 1 つ戻す（6 − 3 − 3 + 1 = 1）", [b.ok, b.dup, b.refund, b.granted, b.memoryInk, Object.keys(saved().owned).length, saved().draws[1].dup, saved().draws[1].refund], [true, true, 1, 1, 1, 1, true, 1]);
}

// ── 10. 所持の保存 ──
{
  reset(withInk(6));
  const a = S.drawOnce({ rand: () => 0.01, now: DAY });
  const b = S.drawOnce({ rand: () => 0.5, now: DAY });
  const s = saved();
  ok("所持: 抽選の id は draw:<端末の印>-<連番>", /^draw:[a-z0-9]{8}-1$/.test(a.draw.id) && b.draw.id === a.draw.id.replace(/-1$/, "-2"), `${a.draw.id} ${b.draw.id}`);
  eq("所持: 新しい品は owned に入り、via が抽選の id", [s.owned[a.item.id]?.via, s.owned[b.item.id]?.via, typeof s.owned[a.item.id]?.at], [a.draw.id, b.draw.id, "string"]);
  eq("所持: 一覧（getCollectionView）に入る", S.getCollectionView(DAY).owned.sort(), [a.item.id, b.item.id].sort());
  reset(withInk(1, { owned: { "future-item": { at: iso(DAY) } }, equipped: { window: null, desk: null, binding: null, fx: null, hat: "future-item" } }));
  S.claimDaily(DAY);
  eq("所持: 目録に無い所持・知らないスロットは書いた後も消さない（一覧には出さない）", [!!saved().owned["future-item"], saved().equipped.hat, S.getCollectionView(DAY).owned], [true, "future-item", []]);
}

// ── 11. 装着と解除 ──
{
  reset(withInk(3));
  const a = S.drawOnce({ rand: () => 0.01, now: DAY });
  const slot = a.item.slot;
  const e1 = S.equipItem(a.item.id);
  eq("装着: 持っている品を使う（equipped[スロット]）", [e1.ok, e1.slot, saved().equipped[slot], S.getEquipped()[slot]], [true, slot, a.item.id, a.item.id]);
  const w = writesOf(KEY);
  eq("装着: 同じ品をもう一度は書かない", [S.equipItem(a.item.id).ok, writesOf(KEY) - w], [true, 0]);
  const u1 = S.unequipSlot(slot);
  eq("解除: 外すと null", [u1.ok, saved().equipped[slot], S.getEquipped()[slot]], [true, null, null]);
  const w2 = writesOf(KEY);
  eq("解除: 既に外れていれば書かない・知らないスロットは invalid", [S.unequipSlot(slot).ok, writesOf(KEY) - w2, S.unequipSlot("hat").reason], [true, 0, "invalid"]);
  const other = D.ITEMS.find((it) => it.id !== a.item.id);
  eq("装着: 持っていない品は not-owned・知らない id は invalid", [S.equipItem(other.id).reason, S.equipItem("nope").reason, S.equipItem(undefined).reason], ["not-owned", "invalid", "invalid"]);
  const lookup = (id) => (id === a.item.id ? { ...D.getItem(id), enabled: false } : D.getItem(id));
  eq("装着: 無効にした品は持っていても使っていないと読む", S.equippedView({ ...saved(), equipped: { ...saved().equipped, [slot]: a.item.id } }, lookup)[slot], null);
}

// ── 12. 同じスロットは 1 つだけ ──
{
  const own = (ids) => Object.fromEntries(ids.map((id) => [id, { at: iso(DAY) }]));
  reset(withInk(0, { owned: own(["window-rain", "window-morning", "desk-grimoire"]) }));
  S.equipItem("desk-grimoire");
  S.equipItem("window-rain");
  const e = S.equipItem("window-morning");
  eq("排他: 同じスロットの 2 品目を使うと 1 品目が外れる・ほかのスロットは変わらない", [e.ok, e.replaced, saved().equipped, S.getEquipped()], [true, "window-rain", { window: "window-morning", desk: "desk-grimoire", binding: null, fx: null }, { window: "window-morning", desk: "desk-grimoire", binding: null, fx: null }]);
  reset(withInk(0, { owned: own(["desk-notebook"]), equipped: { window: "desk-notebook", desk: "desk-grimoire", binding: 5, fx: "nope" } }));
  eq("排他: 違うスロットの品・持っていない品・知らない品を書き換えた保存は、読むと使っていない", S.getEquipped(), { window: null, desk: null, binding: null, fx: null });
}

// ── 13. 旧データからの移行 ──
{
  reset();
  const r = S.readCollection();
  eq("移行: 鍵が無い（導入前の端末）は既定値で読み、書かない", [r.status, r.writable, S.getMemoryInk(), allWrites()], ["none", true, 0, 0]);
  eq("移行: 導入前に済みの本は遡って配らない（回の始めに既に済み → 印だけ）", S.settleBook("junior", { before: true, after: true }, DAY).granted, 0);
  reset({ v: 1, claims: { "daily:2026-11-01": { n: 1, at: iso(DAY) } } });
  const p = S.readCollection();
  eq("移行: 欄の欠けた v1 は既定値で埋める（ok）", [p.status, p.state.carry, p.state.draws, p.state.owned, p.state.equipped, p.state.today, S.getMemoryInk()],
    ["ok", { n: 0, cost: 0, refund: 0, draws: 0, upTo: null }, [], {}, { window: null, desk: null, binding: null, fx: null }, { day: null, recalled: 0, reviewSeen: false }, 1]);
  const future = JSON.stringify({ v: 2, claims: { "daily:2026-11-01": { n: 1, at: iso(DAY) } }, wallet: { x: 1 } });
  reset(future);
  const f = S.readCollection();
  eq("移行: 知らない新しい版（v2）は読むだけ・書かない", [f.status, f.writable, S.claimDaily(DAY).reason, S.drawOnce({ rand: () => 0.5, now: DAY }).reason, S.equipItem("window-rain").reason, S.noteReviewDue(DAY).reason, store.get(KEY) === future, allWrites()], ["future", false, "version", "version", "version", "version", true, 0]);
  const steps = { 0: (s) => ({ ...s, v: 1, claims: s.old ?? {} }) };
  eq("移行: 段を順に当てる（仮の 0 → 1）", S.migrateCollection({ v: 0, old: { "daily:2026-11-01": { n: 1, at: "x" } } }, steps), { v: 1, old: { "daily:2026-11-01": { n: 1, at: "x" } }, claims: { "daily:2026-11-01": { n: 1, at: "x" } } });
  eq("移行: 段の無い古い版は null（壊れた扱い）", [S.migrateCollection({ v: 0 }, {}), S.parseCollection(JSON.stringify({ v: 0 })).status], [null, "corrupt"]);
  reset({ v: 1, claims: { "event:2026-12": { n: 3, at: iso(DAY) } }, extra: { a: 1 } });
  S.claimDaily(DAY);
  eq("移行: 知らない上の欄・知らない種類の受け取りは書いた後も残り、残高に入る", [saved().extra, saved().claims["event:2026-12"]?.n, S.getMemoryInk(), Object.keys(saved())[0]], [{ a: 1 }, 3, 4, "v"]);
}

// ── 14. リロード後の復元 ──
{
  reset(withInk(6));
  S.claimDaily(DAY);
  const d = S.drawOnce({ rand: () => 0.01, now: DAY });
  S.equipItem(d.item.id);
  const S2 = await import("../js/collectionStore.js?reload=2");
  eq("復元: モジュールを読み直しても（リロード）残高・所持・装着・受け取りが同じ", S2.getCollectionView(DAY), S.getCollectionView(DAY));
  eq("復元: 中身", [S2.getMemoryInk(), S2.getEquipped()[d.item.slot], S2.hasClaim("daily:2026-11-02")], [4, d.item.id, true]);
}

// ── 15. 壊れた保存 ──
{
  reset("{broken");
  const r = S.readCollection();
  eq("壊れた: JSON でない値は corrupt・既定値で読む・読むだけでは写さない", [r.status, r.writable, S.getMemoryInk(), allWrites()], ["corrupt", true, 0, 0]);
  const c = S.claimDaily(DAY);
  const kept = JSON.parse(store.get(CORRUPT) ?? "null");
  eq("壊れた: 次に書く前に元の値を写し（包み）、v1 で書き直す", [c.ok, c.granted, kept?.head, typeof kept?.at, saved().v, S.getMemoryInk()], [true, 1, "{broken", "string", 1, 1]);
  store.set(KEY, "{broken");
  const before = writesOf(CORRUPT);
  S.claimDaily(DAY);
  eq("壊れた: 同じ壊れた値は 2 回写さない", writesOf(CORRUPT) - before, 0);
  eq("壊れた: null・配列・数・v の無い値も corrupt", ["null", "[]", "5", JSON.stringify({ claims: {} }), JSON.stringify({ v: "1" })].map((raw) => S.parseCollection(raw).status), ["corrupt", "corrupt", "corrupt", "corrupt", "corrupt"]);
  reset({ v: 1, claims: { "daily:2026-11-01": { n: 1, at: iso(DAY) }, "bad id!": { n: 1, at: iso(DAY) }, "daily:2026-10-31": { n: -1, at: iso(DAY) } }, draws: [{ id: "x" }] });
  const rp = S.readCollection();
  eq("壊れた: 形の違う所だけ落とす（repaired）", [rp.status, rp.dropped, S.getMemoryInk()], ["repaired", 3, 1]);
  S.claimDaily(DAY);
  ok("壊れた: repaired も書く前に写す", (JSON.parse(store.get(CORRUPT) ?? "{}").head ?? "").includes("bad id!"));
  reset('{"v":1,"__proto__":{"claims":{"daily:2026-01-01":{"n":99,"at":"x"}}},"claims":{"daily:2026-11-01":{"n":1,"at":"x"}},"owned":{"__proto__":{"at":"x"}},"equipped":{"__proto__":"window-rain"}}');
  const proto = S.readCollection();
  S.claimDaily(DAY);
  eq("壊れた: __proto__ の鍵は拾わない（形を変えない・残高を足さない）", [proto.status, Object.getPrototypeOf(proto.state) === Object.prototype, Object.getPrototypeOf(proto.state.owned) === Object.prototype, S.getMemoryInk(), Object.keys(saved().owned)], ["repaired", true, true, 2, []]);
  reset(withInk(5));
  mode.getThrows = true;
  const u = S.readCollection();
  eq("壊れた: 読めない端末は unavailable・書く関数は storage・投げない", [u.status, u.writable, S.getMemoryInk(), S.getCollectionView(DAY).available, S.claimDaily(DAY).reason, S.drawOnce({ rand: () => 0.5, now: DAY }).reason, S.equipItem("window-rain").reason, S.hasClaim("daily:2026-10-01")], ["unavailable", false, 0, false, "storage", "storage", "storage", false]);
  mode.getThrows = false;
  const raw = store.get(KEY);
  mode.setThrows = true;
  const w1 = S.claimDaily(DAY);
  const w2 = S.drawOnce({ rand: () => 0.5, now: DAY });
  mode.setThrows = false;
  eq("壊れた: 書けない（容量）ときは write・配らない・保存も残高も前のまま", [w1.ok, w1.reason, w1.granted, w1.memoryInk, w2.reason, w2.memoryInk, store.get(KEY) === raw, S.getMemoryInk(), S.hasClaim("daily:2026-11-02")], [false, "write", 0, 5, "write", 5, true, 5, false]);
  const desc = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: undefined });
  const none = S.readCollection();
  const cl = S.claimDaily(DAY);
  Object.defineProperty(globalThis, "localStorage", desc);
  eq("壊れた: localStorage が無い端末も unavailable・storage", [none.status, cl.reason], ["unavailable", "storage"]);
}

// ── 16・17. バックアップの復元・別のアカウントでのログイン（js/backup.js） ──
const BK = await import("../js/backup.js");
{
  reset();
  S.claimDaily(DAY);
  store.set(CORRUPT, '{"at":"2026-11-01T00:00:00.000Z","size":3,"head":"{x["}');
  store.set("spelldash_xp", "10");
  const mine = store.get(KEY);
  const mineCorrupt = store.get(CORRUPT);
  const bk = BK.buildBackup();
  eq("バックアップ: 書斎コレクションと写しはバックアップに入る", [bk.data[KEY] === mine, bk.data[CORRUPT] === mineCorrupt], [true, true]);
  BK.applyBackup({ app: "SpellDash", version: 1, data: { spelldash_xp: "99" } });
  eq("復元: 導入より前のバックアップ（鍵が無い）を戻しても、今の書斎コレクションと写しを残す・ほかは上書き", [store.get(KEY) === mine, store.get(CORRUPT) === mineCorrupt, store.get("spelldash_xp")], [true, true, "99"]);
  const theirs = JSON.stringify({ v: 1, claims: { "book:toeic": { n: 5, at: iso(DAY) } } });
  BK.applyBackup({ app: "SpellDash", version: 1, data: { [KEY]: theirs } });
  eq("復元: 鍵のあるバックアップはその値に替わる（写しは無ければ残る）", [store.get(KEY) === theirs, store.get(CORRUPT) === mineCorrupt, S.getMemoryInk()], [true, true, 5]);
  BK.applyBackup({ app: "SpellDash", version: 1, data: { [KEY]: null, [CORRUPT]: 5 } });
  eq("復元: 値が文字列でなければ今の値を残す", [store.get(KEY) === theirs, store.get(CORRUPT) === mineCorrupt], [true, true]);
}
{
  reset();
  S.claimDaily(DAY);
  store.set(CORRUPT, '{"at":"2026-11-01T00:00:00.000Z","size":3,"head":"{x["}');
  store.set("spelldash_word_stats", JSON.stringify({ "english-apple": {} }));
  store.set("spelldash_xp", "10");
  const mine = store.get(KEY);
  BK.clearLocalRecords();
  eq("別のアカウント: この端末の記録を消しても書斎コレクションと写しは残る（記録は消える）", [store.get(KEY) === mine, store.has(CORRUPT), store.has("spelldash_word_stats"), store.has("spelldash_xp")], [true, true, false, false]);
}

// ── 18. 持ち主の確認（js/sync.js hasPersonalRecords）に数えない ──
{
  const code = fs.readFileSync(path.join(ROOT, "js/sync.js"), "utf8").replace(/\/\/.*$/gm, "");
  ok("持ち主の確認: js/sync.js は書斎コレクションの鍵も collectionStore も読まない", !code.includes("spelldash_collection") && !/collection(Store|Data)/.test(code));
  const backup = fs.readFileSync(path.join(ROOT, "js/backup.js"), "utf8");
  eq("持ち主の確認: js/backup.js の import は今の 4 本のまま（collectionStore を読まない）", [...backup.matchAll(/^import .* from "(\.\/[^"]+)";$/gm)].map((m) => m[1]), ["./storage.js", "./masteryMeta.js", "./memoryCheck.js", "./memoryWords.js"]);
}

// ── 19. 読むだけは書かない ──
{
  reset(withInk(6, { owned: { "window-rain": { at: iso(DAY) } }, equipped: { window: "window-rain", desk: null, binding: null, fx: null } }));
  S.readCollection();
  S.getCollectionView(DAY);
  S.getMemoryInk();
  S.getEquipped();
  S.hasClaim("daily:2026-10-01");
  eq("読むだけ: setItem 0 回", allWrites(), 0);
  const v = S.getCollectionView(DAY);
  eq("読むだけ: 今日の受け取りの印", v.claimedToday, { daily: false, study10: false, review: false });
}

// ── 20. 畳み（60 日より前の日次と抽選は carry へ。残高は同じ） ──
{
  const old = at(2026, 8, 1);
  const kept = at(2026, 9, 3); // 2026-11-02 から 60 日前（残す）
  reset({
    v: 1,
    dev: "abcd1234",
    claims: {
      "daily:2026-08-01": { n: 1, at: iso(old) },
      "study10:2026-08-01": { n: 2, at: iso(old) },
      "daily:2026-09-02": { n: 1, at: iso(at(2026, 9, 2)) },
      "daily:2026-09-03": { n: 1, at: iso(kept) },
      "book:junior": { n: 5, at: iso(old) }
    },
    draws: [
      { id: "draw:abcd1234-1", at: iso(old), t: "t1", r: 0.01, rarity: "N", item: "binding-brown", cost: 3, dup: false, refund: 0 },
      { id: "draw:abcd1234-2", at: iso(old), t: "t1", r: 0.01, rarity: "N", item: "binding-brown", cost: 3, dup: true, refund: 1 },
      { id: "draw:abcd1234-3", at: iso(kept), t: "t1", r: 0.5, rarity: "N", item: "fx-gold-edge", cost: 3, dup: false, refund: 0 }
    ],
    owned: { "binding-brown": { at: iso(old) }, "fx-gold-edge": { at: iso(kept) } }
  });
  const before = S.getMemoryInk();
  S.claimDaily(DAY);
  const s = saved();
  eq("畳み: 61 日以上前の日次と抽選は carry に移る・60 日前は残す・本は残す", [Object.keys(s.claims).sort(), s.draws.map((d) => d.id), s.carry],
    [["book:junior", "daily:2026-09-03", "daily:2026-11-02"], ["draw:abcd1234-3"], { n: 4, cost: 6, refund: 1, draws: 2, upTo: "2026-09-02" }]);
  eq("畳み: 残高・所持は同じ（+ 今日の 1）", [before, S.getMemoryInk(), Object.keys(s.owned).sort()], [1 + 2 + 1 + 1 + 5 - 9 + 1, before + 1, ["binding-brown", "fx-gold-edge"]]);
  eq("畳み: 畳んだ日以前の日次は受け取り済みと読み、時計を戻しても folded", [S.hasClaim("daily:2026-08-01"), S.hasClaim("review:2026-07-30"), S.claimDaily(at(2026, 8, 20)).reason, S.claimDaily(at(2026, 9, 3)).reason], [true, true, "folded", "dup"]);
  const d = S.drawOnce({ rand: () => 0.99, now: DAY });
  eq("畳み: 抽選の連番は畳んだ分の後から（重ならない）", d.draw.id, "draw:abcd1234-4");
}

// ── 21. 文言と名前 ──
{
  const texts = [];
  for (const v of Object.values(D.TEXT)) texts.push(typeof v === "function" ? v("中学英語 1年") : v);
  const all = [...texts, ...D.ITEMS.flatMap((it) => [it.name, it.desc]), ...D.SLOTS.map((s) => s.label), D.MEMORY_INK.name, D.MEMORY_INK.short].join("\n");
  ok("文言: しおり・ログインボーナス・読破を使わない", !/しおり|ログインボーナス|読破/.test(all));
  ok("文言: 絵文字が無い", !/\p{Extended_Pictographic}/u.test(all));
  ok("文言: 品の名前に「インク」「光」を入れない（通貨と部屋の光と紛れない）", D.ITEMS.every((it) => !/インク|光/.test(it.name + it.desc)));
  eq("文言: 名前（記憶のインク・インク・今日の贈り物・書斎くじ）", [D.MEMORY_INK.id, D.MEMORY_INK.name, D.MEMORY_INK.short, D.TEXT.dailyName, D.TEXT.drawName], ["memoryInk", "記憶のインク", "インク", "今日の贈り物", "書斎くじ"]);
  eq("文言: 数は設定の値から（1・2・1・5・3・1）", [D.TEXT.daily, D.TEXT.study10, D.TEXT.review, D.TEXT.book("中学英語 1年"), D.TEXT.drawCost, D.TEXT.duplicate, D.TEXT.short(2)],
    ["今日の贈り物。記憶のインクを1つ受け取った。", "10語思い出した。記憶のインクを2つ受け取った。", "今日の復習を終えた。記憶のインクを1つ受け取った。", "「中学英語 1年」を終えた。記憶のインクを5つ受け取った。", "無料。記憶のインク3つで1回引ける。", "もう持っている。記憶のインク1つに変わった。", "インクが足りない。あと2つ。"]);
  eq("文言: 窓の UI の文（G の設計 §1）と端末保存の文", [D.TEXT.deviceOnly, D.TEXT.howToEarn, D.TEXT.draw, D.TEXT.recent, D.TEXT.got("雨の町"), D.TEXT.wasEquipped("雨の町"), D.TEXT.openLabel, D.TEXT.tabList, D.TEXT.tabDraw, D.TEXT.drawAgain, D.TEXT.filterAll, D.TEXT.previewTitle],
    ["この端末に保存。ほかの端末には移らない。", "10語思い出すと2つ、今日の復習を終えると1つ受け取れる。", "引く（インク3つ）", "最近の5回", "雨の町を手に入れた。", "雨の町は外した。", "コレクション", "一覧", "書斎くじ", "もう1回引く", "すべて", "書斎の見本"]);
  eq("設定の値", [D.REWARDS, D.STUDY10_WORDS, D.DRAW_COST, D.DUPLICATE_REFUND, D.RARITIES.map((r) => [r.id, r.weight])], [{ daily: 1, study10: 2, review: 1, book: 5 }, 10, 3, 1, [["N", 70], ["R", 25], ["SR", 5]]]);
  const names = [...Object.keys(D), ...Object.keys(S)];
  eq("名前: export に ink だけの名前が無い（memoryInk・MEMORY_INK は可）", names.filter((n) => /ink/i.test(n) && !/memoryInk|MEMORY_INK/i.test(n)), []);
  const src = ["js/collectionData.js", "js/collectionStore.js"].map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");
  ok("名前: CSS の --ink を使わない・しおりの語が無い", !src.includes("--ink") && !/しおり|ログインボーナス|読破/.test(src));
}

// ── 22. データの形 ──
{
  const ids = D.ITEMS.map((it) => it.id);
  eq("品: 12 品・id は一意", [D.ITEMS.length, new Set(ids).size], [12, 12]);
  eq("品: 各スロットに N・R・SR が 1 つずつ", D.SLOTS.map((s) => [s.id, D.listItems({ slot: s.id }).map((it) => it.rarity)]), [["window", ["N", "R", "SR"]], ["desk", ["N", "R", "SR"]], ["binding", ["N", "R", "SR"]], ["fx", ["N", "R", "SR"]]]);
  ok("品: id は <スロット>-<名>（G の形 ^(window|desk|binding|fx)-[a-z0-9-]{1,40}$）・販売区分 null・入手は書斎くじ・有効・装着可", D.ITEMS.every((it) => /^(window|desk|binding|fx)-[a-z0-9-]{1,40}$/.test(it.id) && it.id.startsWith(`${it.slot}-`) && it.sale === null && it.source === "draw" && it.enabled === true && it.equippable === true));
  const assetOk = (it) => it.asset.kind === "image"
    ? Object.entries(it.asset.files).length > 0 && Object.entries(it.asset.files).every(([v, f]) => D.ASSET_VARIANTS.includes(v) && f === `assets/images/collection/${it.id}-${v}.webp` && f === D.assetPath(it.id, v)) && it.placeholder === true
    : it.asset.kind === "css" && it.asset.ref === it.id && it.placeholder === false;
  ok("品: 絵の参照は assets/images/collection/<id>-<variant>.webp（絵が入るまで placeholder）・CSS だけの品は fx-gold-edge だけ", D.ITEMS.every(assetOk) && D.ITEMS.filter((it) => it.asset.kind === "css").map((it) => it.id).join() === "fx-gold-edge");
  eq("品: 配る絵の名前（G のアセット仕様 §1）", D.ITEMS.flatMap((it) => Object.values(it.asset.files ?? {})).map((f) => f.replace("assets/images/collection/", "").replace(".webp", "")),
    ["window-rain-day", "window-rain-night", "window-morning-day", "window-morning-night", "window-moon-day", "window-moon-night", "desk-notebook-prop", "desk-hourglass-prop", "desk-grimoire-prop", "binding-brown-cover", "binding-brown-thumb", "binding-redleather-cover", "binding-redleather-thumb", "binding-memory-tree-cover", "binding-memory-tree-thumb", "fx-layered-paper-frame", "fx-layered-paper-thumb", "fx-ink-star-sprite"]);
  eq("品: スロットの名前", D.SLOTS.map((s) => [s.id, s.label]), [["window", "窓の景色"], ["desk", "机の小物"], ["binding", "本の装丁"], ["fx", "正解の演出"]]);
  ok("品: スロットとレアリティは表のもの・表示順は一意の整数", D.ITEMS.every((it) => D.SLOTS.some((s) => s.id === it.slot) && D.RARITIES.some((r) => r.id === it.rarity) && Number.isInteger(it.order)) && new Set(D.ITEMS.map((it) => it.order)).size === 12);
  ok("品: 凍っている（呼び手が書き換えない）", Object.isFrozen(D.ITEMS) && Object.isFrozen(D.ITEMS[0]) && Object.isFrozen(D.ITEMS[0].asset) && Object.isFrozen(D.ITEMS[0].asset.files) && Object.isFrozen(D.DRAW_TABLE) && Object.isFrozen(D.TEXT));
  eq("品: getItem・listItems", [D.getItem("window-rain")?.name, D.getItem("nope"), D.listItems({ rarity: "SR" }).map((it) => it.id)], ["雨の町", null, ["window-moon", "desk-grimoire", "binding-memory-tree", "fx-ink-star"]]);
  eq("保存: 鍵と版", [D.COLLECTION_KEY, D.COLLECTION_CORRUPT_KEY, D.COLLECTION_VERSION], ["spelldash_collection", "spelldash_collection_corrupt", 1]);
}

// ── 23. 依存（新しい静的 import を足さない） ──
{
  const importsOf = (f) => [...fs.readFileSync(path.join(ROOT, f), "utf8").matchAll(/^\s*(?:import|export)\s(?:[^;"']*?\sfrom\s+)?["'](\.{1,2}\/[^"']+)["']/gm)].map((m) => m[1]);
  eq("依存: collectionData.js は import なし", importsOf("js/collectionData.js"), []);
  eq("依存: collectionStore.js は collectionData・retentionCalc・storageGuard だけ", importsOf("js/collectionStore.js").sort(), ["./collectionData.js", "./retentionCalc.js", "./storageGuard.js"]);
  eq("依存: retentionCalc.js・storageGuard.js は import なし", [importsOf("js/retentionCalc.js"), importsOf("js/storageGuard.js")], [[], []]);
}

// ── 24. 知らせ（同じタブ spelldash:collection・別のタブ storage） ──
{
  reset();
  const seen = [];
  const listener = (e) => seen.push(e.detail?.kind);
  addEventListener(S.COLLECTION_EVENT, listener);
  S.claimDaily(DAY);
  S.claimDaily(DAY);
  mode.setThrows = true;
  S.claimDaily(NEXT);
  mode.setThrows = false;
  removeEventListener(S.COLLECTION_EVENT, listener);
  eq("知らせ: 書いたときだけ 1 回（dup・書けないときは投げない）", [S.COLLECTION_EVENT, seen], ["spelldash:collection", ["daily"]]);
  const calls = [];
  const off = S.onCollectionChange((info) => calls.push(info.source));
  S.claimDaily(NEXT);
  dispatchEvent(Object.assign(new Event("storage"), { key: KEY }));
  dispatchEvent(Object.assign(new Event("storage"), { key: "spelldash_xp" }));
  dispatchEvent(Object.assign(new Event("storage"), { key: null }));
  off();
  S.claimDaily(at(2026, 11, 4));
  dispatchEvent(Object.assign(new Event("storage"), { key: KEY }));
  eq("知らせ: onCollectionChange は同じタブの書き込みと別のタブの storage（鍵か null）で呼ぶ・解除の後は呼ばない", calls, ["local", "storage", "storage"]);
}

if (failures.length) {
  console.error(`${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`test-collection: ${passed} passed`);
