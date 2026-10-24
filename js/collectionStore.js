// ===== 書斎コレクションの保存と台帳（端末だけ。DOM を読まない・描かない・送らない） =====
// 表（品・確率・数・文言）は js/collectionData.js、単体の検査は scripts/test-collection.mjs、契約は Batch 77 の API 文書。
// 保存は spelldash_collection の 1 つの JSON（v1）。1 回の操作は 1 回の setItem で全部を書く（片方だけ書けることが無い）。
//
// spelldash_collection = {
//   v: 1, since: 最初に書いた ISO, dev: 端末の印（8 字の乱数。抽選の id を端末をまたいで一意にする。送らない）,
//   claims: { "<claim id>": { n: 受け取った数, at: ISO, pre?: true } },     受け取りの台帳（pre = 導入前・同期で済みの本の印。配っていない）
//   carry: { n, cost, refund, draws, upTo },                                 畳んだ分の合計（upTo = 畳んだ最後の日。その日以前の日次は受け付けない）
//   draws: [{ id, at, t: 抽選表の版, r: 乱数, rarity, item, cost, dup, refund }],   抽選の台帳（追記だけ。古い物は carry に畳む）
//   owned: { "<item id>": { at, via?: 抽選の id } },                          所持の集合
//   equipped: { bg, desk, binding, fx },                                     スロットごとに 0 か 1 つ
//   today: { day, recalled, reviewSeen }                                     日次の数え（day が今日でなければ 0 から）
// }
// claim id: daily:<日>（今日の贈り物）・study10:<日>（その日最初の 10 語）・review:<日>（今日の復習）・book:<本の id>（一冊。永続）。
// 日はローカル暦日（js/retentionCalc.js localDay。js/stats.js localDateString と同じ 0 時の境）。将来サーバーの台帳へ移すときは claim id を一意制約にする。
//
// 守ること:
//   - 残高（記憶のインク）は保存しない。台帳から毎回出す（memoryInkOf）。このコードの書き込みで負にしない（抽選は残高 ≥ 費用のときだけ）
//   - 同じ claim id は 2 回配らない。本の受け取りは畳まない・消さない
//   - メモリーに中身を持たない。どの関数も毎回 localStorage を読む（リロード・別のタブ・復元・消去の後も古い中身を書き戻さない）
//   - 書く関数は 読む → 確かめる → 書く を 1 回の同期の実行で行う（await しない）
//   - 読むだけの関数は書かない。書けなかったら何も変わらず、配らない
//   - 知らない新しい版（v > 1）は書かない。知らない欄・受け取り・所持・スロットは消さない（新しい版のタブが足した物を古いタブが消さない）
//   - 壊れた値は書き直す前に写す（spelldash_collection_corrupt。js/storageGuard.js の包み）
// 報酬を配る判定の材料（10 語の数・復習の残り・本の済み）は呼び手が渡す。ここは答えの道（入力完了 → 次の問題）から呼ばれない前提。

import { COLLECTION_KEY, COLLECTION_CORRUPT_KEY, COLLECTION_VERSION, REWARDS, STUDY10_WORDS, DRAW_COST, DUPLICATE_REFUND, FOLD_DAYS, RECENT_DRAWS, SLOTS, DRAW_TABLE, getItem, pickDraw } from "./collectionData.js";
import { localDay, dayDiff, shiftDay } from "./retentionCalc.js";
import { keepCorrupt, expireCorrupt } from "./storageGuard.js";

export const COLLECTION_EVENT = "spelldash:collection"; // 同じタブで書いたとき（detail: { kind }）

// 版を上げる段（v → v + 1）。v1 には段が無い。形が変わるときだけ足す（欄を足すだけなら版を上げない: 知らない欄は残る）
export const MIGRATIONS = Object.freeze({});

const DAILY_KINDS = new Set(["daily", "study10", "review"]);
const SLOT_IDS = SLOTS.map((s) => s.id);
const CLAIM_RE = /^[a-z0-9]+:[A-Za-z0-9_.:-]{1,80}$/; // 読むとき残す受け取りの形（知らない種類も）
const BOOK_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/; // 所持・装着の品の id（目録に無い id も残す。頭は英数字: __proto__ などを鍵にしない）
const SLOT_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const DEV_RE = /^[a-z0-9]{4,16}$/;
const NOT_BOOKS = new Set(["all", "my"]); // すべて・マイ単語帳は一冊ではない

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isCount = (v) => Number.isInteger(v) && v >= 0;
const isDay = (v) => typeof v === "string" && shiftDay(v, 0) === v;
const shown = (n) => Math.max(0, n); // 画面の残高（生の値が負でも 0）

function toDate(now) {
  const d = now === undefined ? new Date() : now instanceof Date ? now : new Date(now);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ===== claim id と日（純） =====

export function dayKeyOf(now) {
  const d = toDate(now);
  return d ? localDay(d) : null;
}

export const dailyClaimId = (day) => (isDay(day) ? `daily:${day}` : null);
export const study10ClaimId = (day) => (isDay(day) ? `study10:${day}` : null);
export const reviewClaimId = (day) => (isDay(day) ? `review:${day}` : null);
export const bookClaimId = (categoryId) => (typeof categoryId === "string" && BOOK_RE.test(categoryId) && !NOT_BOOKS.has(categoryId) ? `book:${categoryId}` : null);

export function parseClaimId(id) {
  if (typeof id !== "string" || !CLAIM_RE.test(id)) return null;
  const i = id.indexOf(":");
  const kind = id.slice(0, i);
  const rest = id.slice(i + 1);
  if (DAILY_KINDS.has(kind)) return isDay(rest) ? { kind, day: rest } : null;
  if (kind === "book") return bookClaimId(rest) ? { kind, categoryId: rest } : null;
  return { kind, value: rest };
}

// ===== 保存の形（純） =====

const emptyCarry = () => ({ n: 0, cost: 0, refund: 0, draws: 0, upTo: null });
const emptyToday = () => ({ day: null, recalled: 0, reviewSeen: false });
const emptyEquipped = () => Object.fromEntries(SLOT_IDS.map((id) => [id, null]));

export function emptyCollection({ now, dev } = {}) {
  const d = now === undefined ? null : toDate(now);
  return { v: COLLECTION_VERSION, since: d ? d.toISOString() : null, dev: typeof dev === "string" && DEV_RE.test(dev) ? dev : null, claims: {}, carry: emptyCarry(), draws: [], owned: {}, equipped: emptyEquipped(), today: emptyToday() };
}

const KNOWN = new Set(["v", "since", "dev", "claims", "carry", "draws", "owned", "equipped", "today"]);

function validDraw(d) {
  return (
    isObj(d) && typeof d.id === "string" && d.id.length <= 80 && typeof d.at === "string" && localDay(d.at) !== null && typeof d.t === "string" &&
    typeof d.r === "number" && d.r >= 0 && d.r < 1 && typeof d.rarity === "string" && typeof d.item === "string" && typeof d.dup === "boolean" && isCount(d.cost) && isCount(d.refund)
  );
}

// v1 の値 → { state, dropped }。形の合う所だけ拾う（落とした数を dropped に）。欠けた欄は既定値。知らない上の欄はそのまま残す
function normalize(raw) {
  const state = emptyCollection();
  let dropped = 0;
  for (const [k, v] of Object.entries(raw)) if (!KNOWN.has(k) && k !== "__proto__") state[k] = v;
  if (raw.since !== undefined && raw.since !== null) typeof raw.since === "string" ? (state.since = raw.since) : dropped++;
  if (raw.dev !== undefined && raw.dev !== null) typeof raw.dev === "string" && DEV_RE.test(raw.dev) ? (state.dev = raw.dev) : dropped++;
  if (isObj(raw.claims)) {
    for (const [id, c] of Object.entries(raw.claims)) {
      if (!CLAIM_RE.test(id) || !isObj(c) || !isCount(c.n) || typeof c.at !== "string") {
        dropped++;
        continue;
      }
      const entry = { ...c };
      if ("pre" in entry && entry.pre !== true) delete entry.pre;
      state.claims[id] = entry;
    }
  } else if (raw.claims !== undefined) dropped++;
  if (isObj(raw.carry)) {
    for (const k of ["n", "cost", "refund", "draws"]) {
      if (raw.carry[k] === undefined) continue;
      isCount(raw.carry[k]) ? (state.carry[k] = raw.carry[k]) : dropped++;
    }
    if (raw.carry.upTo !== undefined && raw.carry.upTo !== null) isDay(raw.carry.upTo) ? (state.carry.upTo = raw.carry.upTo) : dropped++;
  } else if (raw.carry !== undefined) dropped++;
  if (Array.isArray(raw.draws)) {
    for (const d of raw.draws) validDraw(d) ? state.draws.push({ ...d }) : dropped++;
  } else if (raw.draws !== undefined) dropped++;
  if (isObj(raw.owned)) {
    for (const [id, o] of Object.entries(raw.owned)) REF_RE.test(id) && isObj(o) ? (state.owned[id] = { ...o }) : dropped++;
  } else if (raw.owned !== undefined) dropped++;
  if (isObj(raw.equipped)) {
    for (const [slot, id] of Object.entries(raw.equipped)) SLOT_RE.test(slot) && (id === null || (typeof id === "string" && REF_RE.test(id))) ? (state.equipped[slot] = id) : dropped++;
  } else if (raw.equipped !== undefined) dropped++;
  if (isObj(raw.today)) {
    const t = raw.today;
    if (t.day !== undefined && t.day !== null) isDay(t.day) ? (state.today.day = t.day) : dropped++;
    if (t.recalled !== undefined) isCount(t.recalled) ? (state.today.recalled = t.recalled) : dropped++;
    if (t.reviewSeen !== undefined) typeof t.reviewSeen === "boolean" ? (state.today.reviewSeen = t.reviewSeen) : dropped++;
  } else if (raw.today !== undefined) dropped++;
  return { state, dropped };
}

// 版を順に上げる（obj.v → target）。段が無い・段が版を上げない・形が違えば null
export function migrateCollection(obj, migrations = MIGRATIONS, target = COLLECTION_VERSION) {
  let cur = obj;
  while (isObj(cur) && Number.isInteger(cur.v) && cur.v < target) {
    const step = migrations[cur.v];
    if (typeof step !== "function") return null;
    const next = step(cur);
    if (!isObj(next) || !(Number.isInteger(next.v) && next.v > cur.v)) return null;
    cur = next;
  }
  return isObj(cur) && cur.v === target ? cur : null;
}

// 保存の文字列 → { status, state, dropped }。
// status: none（鍵が無い）・ok・repaired（v1 の形の違う所を落とした）・corrupt（読めない・既定値）・future（知らない新しい版・既定値・書かない）
export function parseCollection(raw) {
  if (raw === null || raw === undefined || raw === "") return { status: "none", state: emptyCollection(), dropped: 0 };
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: "corrupt", state: emptyCollection(), dropped: 0 };
  }
  if (!isObj(value) || !Number.isInteger(value.v)) return { status: "corrupt", state: emptyCollection(), dropped: 0 };
  if (value.v > COLLECTION_VERSION) return { status: "future", state: emptyCollection(), dropped: 0 };
  const current = value.v === COLLECTION_VERSION ? value : migrateCollection(value);
  if (!current) return { status: "corrupt", state: emptyCollection(), dropped: 0 };
  const { state, dropped } = normalize(current);
  return { status: dropped > 0 ? "repaired" : "ok", state, dropped };
}

export function serializeCollection(state) {
  return JSON.stringify({ v: COLLECTION_VERSION, ...state });
}

// 生の残高: 畳んだ分 + 受け取り + 戻し − 消費
export function memoryInkOf(state) {
  let n = (state?.carry?.n ?? 0) + (state?.carry?.refund ?? 0) - (state?.carry?.cost ?? 0);
  for (const c of Object.values(state?.claims ?? {})) n += Number(c?.n) || 0;
  for (const d of state?.draws ?? []) n += (Number(d?.refund) || 0) - (Number(d?.cost) || 0);
  return n;
}

// 今日から FOLD_DAYS 日より前の日次の受け取りと抽選を carry に畳む（新しい state を返す。残高は同じ）。
// upTo は畳んだ受け取りの最後の日（抽選の日は入れない: 時計を進めて戻した端末で、その日の受け取りまで閉じない）
export function foldCollection(state, today) {
  const next = { ...state, claims: { ...state.claims }, carry: { ...state.carry }, draws: [...state.draws] };
  if (!isDay(today)) return next;
  const old = (day) => isDay(day) && dayDiff(day, today) > FOLD_DAYS;
  for (const [id, c] of Object.entries(next.claims)) {
    const p = parseClaimId(id);
    if (!p || !DAILY_KINDS.has(p.kind) || !old(p.day)) continue;
    next.carry.n += Number(c.n) || 0;
    if (!next.carry.upTo || p.day > next.carry.upTo) next.carry.upTo = p.day;
    delete next.claims[id];
  }
  next.draws = next.draws.filter((d) => {
    if (!old(localDay(d.at))) return true;
    next.carry.cost += d.cost;
    next.carry.refund += d.refund;
    next.carry.draws += 1;
    return false;
  });
  return next;
}

// 使っている品（所持・目録にある・有効・装着可・スロットが合う物だけ。他は null）
export function equippedView(state, lookup = getItem) {
  const out = {};
  for (const slot of SLOT_IDS) {
    const id = state?.equipped?.[slot];
    const it = typeof id === "string" ? lookup(id) : null;
    out[slot] = it && it.slot === slot && it.enabled && it.equippable && state.owned?.[id] ? id : null;
  }
  return out;
}

// 受け取り済みか（pre の印・畳んだ日を含む）
function claimed(state, id) {
  if (Object.prototype.hasOwnProperty.call(state.claims, id)) return true;
  const p = parseClaimId(id);
  return !!(p && DAILY_KINDS.has(p.kind) && state.carry.upTo && p.day <= state.carry.upTo);
}

const todayOf = (state, day) => (state.today.day === day ? state.today : { day, recalled: 0, reviewSeen: false });

// ===== 読む =====

function readRaw() {
  try {
    if (typeof localStorage === "undefined" || !localStorage) return { ok: false, raw: null };
    return { ok: true, raw: localStorage.getItem(COLLECTION_KEY) };
  } catch {
    return { ok: false, raw: null };
  }
}

// 今の保存（読むだけ・書かない）。writable: 書く関数が使えるか
export function readCollection() {
  const r = readRaw();
  if (!r.ok) return { status: "unavailable", writable: false, state: emptyCollection(), dropped: 0 };
  const parsed = parseCollection(r.raw);
  return { ...parsed, writable: parsed.status !== "future" };
}

export function getMemoryInk() {
  return shown(memoryInkOf(readCollection().state));
}

export function getEquipped() {
  return equippedView(readCollection().state);
}

export function hasClaim(claimId) {
  const r = readCollection();
  return r.status === "unavailable" ? false : claimed(r.state, claimId);
}

// 画面の材料（読むだけ）
export function getCollectionView(now) {
  const r = readCollection();
  const st = r.state;
  const day = dayKeyOf(now);
  const t = todayOf(st, day);
  return {
    available: r.status !== "unavailable",
    writable: r.writable,
    status: r.status,
    memoryInk: shown(memoryInkOf(st)),
    owned: Object.keys(st.owned).filter((id) => getItem(id)),
    equipped: equippedView(st),
    recent: st.draws.slice(-RECENT_DRAWS).reverse().map((d) => ({ ...d, def: getItem(d.item) })),
    today: { day: t.day, recalled: t.recalled, reviewSeen: t.reviewSeen },
    claimedToday: { daily: !!day && claimed(st, dailyClaimId(day)), study10: !!day && claimed(st, study10ClaimId(day)), review: !!day && claimed(st, reviewClaimId(day)) }
  };
}

// ===== 書く（読む → 確かめる → 書く を 1 回で） =====

function makeDev() {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  let bytes;
  try {
    bytes = globalThis.crypto?.getRandomValues?.(new Uint8Array(8));
  } catch {
    bytes = null;
  }
  let out = "";
  for (let i = 0; i < 8; i++) out += abc[(bytes ? bytes[i] : Math.floor(Math.random() * 256)) % abc.length];
  return out;
}

function notify(kind) {
  try {
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
      window.dispatchEvent(new CustomEvent(COLLECTION_EVENT, { detail: { kind } }));
    }
  } catch {
    // 知らせは装飾。失敗しても保存は済んでいる
  }
}

// 別のタブ（storage）と同じタブ（spelldash:collection）の変化を聞く。返り値は解除の関数
export function onCollectionChange(callback) {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function" || typeof callback !== "function") return () => {};
  const local = (e) => callback({ kind: e?.detail?.kind ?? null, source: "local" });
  const other = (e) => {
    if (e?.key === null || e?.key === COLLECTION_KEY) callback({ kind: null, source: "storage" });
  };
  window.addEventListener(COLLECTION_EVENT, local);
  window.addEventListener("storage", other);
  return () => {
    window.removeEventListener(COLLECTION_EVENT, local);
    window.removeEventListener("storage", other);
  };
}

const fail = (kind, reason, memoryInk = 0, extra = {}) => ({ ok: false, kind, reason, granted: 0, memoryInk, ...extra });

// 1 回の操作。fn(state, ctx) は state を書き換えて { write: bool, result } を返す（write が false なら書かない）。
// 書く前に: 端末の印と始めの日時を置き、古い日次を畳み、壊れていた値を写す。1 回の setItem。書けなければ write（何も変わらない）
function transact(kind, now, fn) {
  const date = toDate(now);
  if (!date) return fail(kind, "invalid");
  const r = readRaw();
  if (!r.ok) return fail(kind, "storage");
  const parsed = parseCollection(r.raw);
  if (parsed.status === "future") return fail(kind, "version");
  const state = parsed.state;
  const before = shown(memoryInkOf(state));
  const day = localDay(date);
  let out;
  try {
    out = fn(state, { date, day, at: date.toISOString(), before });
  } catch {
    return fail(kind, "invalid", before);
  }
  if (!out.write) return { ok: false, kind, granted: 0, memoryInk: before, ...out.result };
  if (!state.since) state.since = date.toISOString();
  if (!state.dev) state.dev = makeDev();
  const next = foldCollection(state, day);
  try {
    if (parsed.status === "corrupt" || parsed.status === "repaired") keepCorrupt(COLLECTION_KEY, COLLECTION_CORRUPT_KEY, r.raw);
    expireCorrupt(COLLECTION_CORRUPT_KEY);
    localStorage.setItem(COLLECTION_KEY, serializeCollection(next));
  } catch {
    return fail(kind, "write", before);
  }
  notify(kind);
  return { ok: true, kind, granted: 0, ...out.result, memoryInk: shown(memoryInkOf(next)) };
}

// 受け取りを 1 件足す（state を書き換える）。dup・folded なら理由を返す
function grant(state, id, n, at, pre = false) {
  if (Object.prototype.hasOwnProperty.call(state.claims, id)) return "dup";
  if (claimed(state, id)) return "folded";
  state.claims[id] = pre ? { n, at, pre: true } : { n, at };
  return null;
}

function claimDay(kind, idOf, n, now) {
  return transact(kind, now, (state, { day, at }) => {
    const id = idOf(day);
    const why = grant(state, id, n, at);
    return why ? { write: false, result: { reason: why, claimId: id } } : { write: true, result: { claimId: id, granted: n } };
  });
}

// 今日の贈り物（その日最初に開いたとき。呼び手は起動の後と表に戻ったときに呼ぶ）
export function claimDaily(now) {
  return claimDay("daily", dailyClaimId, REWARDS.daily, now);
}

// Study の回の終わり（spelldash:session-end の detail をそのまま）。もう一度の回は数えない。
// 今日の自力正解の語の合計が STUDY10_WORDS に届いたら、その日 1 回だけ配る
export function recordStudySession({ recalled, retry = false } = {}, now) {
  if (!isCount(recalled)) return fail("study10", "invalid");
  return transact("study10", now, (state, { day, at }) => {
    if (retry || recalled === 0) return { write: false, result: { reason: "condition", recalled: todayOf(state, day).recalled } };
    const t = todayOf(state, day);
    state.today = { ...t, recalled: t.recalled + recalled };
    const id = study10ClaimId(day);
    if (state.today.recalled < STUDY10_WORDS) return { write: true, result: { ok: false, reason: "condition", recalled: state.today.recalled } };
    const why = grant(state, id, REWARDS.study10, at);
    return why ? { write: true, result: { ok: false, reason: why, claimId: id, recalled: state.today.recalled } } : { write: true, result: { claimId: id, granted: REWARDS.study10, recalled: state.today.recalled } };
  });
}

// Study の回の始め: いまの本（コースはいまの巻まで）に、前日以前から期日の来た語があった（呼び手が決める）
export function noteReviewDue(now) {
  return transact("review-due", now, (state, { day }) => {
    const t = todayOf(state, day);
    if (t.reviewSeen && state.today.day === day) return { write: false, result: { ok: true } };
    state.today = { ...t, reviewSeen: true };
    return { write: true, result: {} };
  });
}

// Study の回の終わり: いまの本の期日の来た語の残り（getDueReviewCount）が 0 で、今日 noteReviewDue があれば 1 回
export function claimReview({ dueRemaining } = {}, now) {
  if (!isCount(dueRemaining)) return fail("review", "invalid");
  return transact("review", now, (state, { day, at }) => {
    const id = reviewClaimId(day);
    if (!todayOf(state, day).reviewSeen || dueRemaining > 0) return { write: false, result: { reason: "condition", claimId: id } };
    const why = grant(state, id, REWARDS.review, at);
    return why ? { write: false, result: { reason: why, claimId: id } } : { write: true, result: { claimId: id, granted: REWARDS.review } };
  });
}

// 一冊: before = 回の始めに済み、after = 今済み、synced = 回の途中に同期で記録が届いた。
// 済みでない → 済みで 5。始めから済み・同期で済みは pre の印だけ（0）。どちらも 1 冊に 1 回で、後で済みが外れて戻っても配らない
export function settleBook(categoryId, { before, after, synced = false } = {}, now) {
  const id = bookClaimId(categoryId);
  if (!id || typeof before !== "boolean" || typeof after !== "boolean" || typeof synced !== "boolean") return fail("book", "invalid");
  return transact("book", now, (state, { at }) => {
    if (!after) return { write: false, result: { reason: "condition", claimId: id } };
    const pre = before || synced;
    const n = pre ? 0 : REWARDS.book;
    const why = grant(state, id, n, at, pre);
    if (why) return { write: false, result: { reason: why, claimId: id } };
    return { write: true, result: { claimId: id, granted: n, ...(pre ? { pre: true } : {}) } };
  });
}

// 書斎くじを 1 回。rand は [0, 1) の数を返す関数（既定は Math.random。検査は固定の乱数を渡す）。
// 残高が足りなければ乱数を使わず short。重複は所持を増やさず DUPLICATE_REFUND を戻す
export function drawOnce({ rand = Math.random, now } = {}) {
  return transact("draw", now, (state, { at }) => {
    const raw = memoryInkOf(state);
    if (raw < DRAW_COST) return { write: false, result: { reason: "short", need: DRAW_COST - Math.max(0, raw) } };
    const r = rand();
    const pick = pickDraw(r, DRAW_TABLE);
    if (!pick) return { write: false, result: { reason: "invalid" } };
    if (!state.dev) state.dev = makeDev();
    const ids = new Set(state.draws.map((d) => d.id));
    let seq = state.carry.draws + state.draws.length + 1;
    while (ids.has(`draw:${state.dev}-${seq}`)) seq++;
    const dup = Object.prototype.hasOwnProperty.call(state.owned, pick.item);
    const refund = dup ? DUPLICATE_REFUND : 0;
    const draw = { id: `draw:${state.dev}-${seq}`, at, t: DRAW_TABLE.version, r, rarity: pick.rarity, item: pick.item, cost: DRAW_COST, dup, refund };
    state.draws.push(draw);
    if (!dup) state.owned[pick.item] = { at, via: draw.id };
    return { write: true, result: { draw: { ...draw }, item: getItem(pick.item), rarity: pick.rarity, dup, refund, granted: refund } };
  });
}

// 持っている品を使う（同じスロットの前の品は外れる）
export function equipItem(itemId, now) {
  const it = getItem(itemId);
  if (!it) return fail("equip", "invalid");
  return transact("equip", now, (state) => {
    if (!it.enabled || !it.equippable) return { write: false, result: { reason: "not-equippable", item: it.id, slot: it.slot } };
    if (!Object.prototype.hasOwnProperty.call(state.owned, it.id)) return { write: false, result: { reason: "not-owned", item: it.id, slot: it.slot } };
    const prev = state.equipped[it.slot] ?? null;
    if (prev === it.id) return { write: false, result: { ok: true, item: it.id, slot: it.slot, replaced: null } };
    state.equipped = { ...state.equipped, [it.slot]: it.id };
    return { write: true, result: { item: it.id, slot: it.slot, replaced: prev } };
  });
}

// スロットを外す
export function unequipSlot(slotId, now) {
  if (!SLOT_IDS.includes(slotId)) return fail("unequip", "invalid");
  return transact("unequip", now, (state) => {
    const prev = state.equipped[slotId] ?? null;
    if (prev === null) return { write: false, result: { ok: true, slot: slotId, removed: null } };
    state.equipped = { ...state.equipped, [slotId]: null };
    return { write: true, result: { slot: slotId, removed: prev } };
  });
}
