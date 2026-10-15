// ===== 記録の質の集計（spelldash_memory_check。端末だけ・画面には出さない） =====
// 影の計算（js/memoryModel.js）の当たりと、速さ・× の種類・字数・入力の経路の見本を数える。同期しない（入力の速さは端末と指に固有）。
// 書き手は js/stats.js（recordRecallSuccess・recordRecallFail）だけ。定義は docs/SPEC_MASTERY.md「記録の質」。
//
// spelldash_memory_check = {
//   v: 1, schedV: 1,                                       出し方の版（1 = 今の規則。版をまたいだ集計は混ぜない）
//   since: "YYYY-MM-DD",                                   数え始めた日
//   cal: {                                                 影の 7 通り（memoryModel VARIANTS の順）の当たり。その日の最初の答えで、覚えた語（S > 0）だけ
//     n: [7], ll: [7], lm: [7],                            見込みを出した数・対数損失の和（○ と × すべて／1 打ミスの × を除く）
//     b: [7][5][4],                                        通り × 見込みの帯（0.95 以上／0.9／0.85／0.8／0.8 未満）× [○, ×（記憶）, ×（1 打ミス）, 見込みの和]
//     w: [64][7]                                           語の束（id の hash で 64）ごとの、各通り − 1.5 の損失の差の和 6 つと件数（語ごとに束ねたブートストラップ用）
//   },
//   speedNext: { "<物差し>.<材料>.<分類>.<段>.<帯>": [○, ×記憶, ×1 打ミス] }
//                                                          速さの材料の答え（材料 a・b）の分類（m 中央値比〔今の分類〕・p 下から 2 割 × 1.3 比・
//                                                          t「T1 ＋ 語の中で最も長い止まり」の中央値比）× 段（答えた後）× 次の間隔の帯 × 次のその日の最初の答え
//   xNext: { "<種類>.<帯>": [○, ×記憶, ×1 打ミス] }         × の種類（e 答え表示・h ヒント・m2 1 打ミス 2 字目まで・m3a 3 字目以降で隣のキー・
//                                                          m3 同・その他・p パス・u 不明〔Battle〕）× 次の間隔の帯 × 次のその日の最初の答え
//   len: { kbd: { q: [[T1…] × 4], a: [[T1…] × 4] }, osk, ime }  問いの字数の帯（2 以下／3〜4／5〜7／8 以上）・答えの字数の帯（4 以下／5〜7／8〜10／11 以上）ごとの T1（直近 40）
//   input: { kbd: { t1: [], tp: [], n, multi }, osk, ime } 経路ごとの T1・T1 ＋ 最も長い止まり（直近 40）と、測った正解の数・一度に 2 字以上入った正解の数
//   capHit: { "<帯>": [○, ×記憶, ×1 打ミス] }               上限が効いている語（間隔が表の上限 30 日に届いた語・習得）のその日の最初の答え
//   first: { f: [T1…], r: [T1…] }                          初めての答えと、その日の最初の（復習の）答えの T1（直近 40 ずつ）
// }
//
// 書き方は js/masteryMeta.js と同じ: メモリーに持ち、変わったときだけ、10 答えごと（tickMemoryCheck）・回の終わり（flushMasteryMeta から）・
// pagehide・裏に回ったとき（visibilitychange で hidden。PR #172 のレビュー 2）で 1 回書く。10 答えごとと回の終わりは答えのタスクの中では書かず、
// 手が空いたときに書く（scheduleMemoryCheckFlush。入力完了から次の問題までに読み直し・JSON 化を入れない。pagehide と裏に回ったときはその場で）。
// 書く直前に保存を読み直し、このタブで足した分（delta）だけを足す。読み書きはすべて try/catch（失敗しても学習は続く）。
// 20 KB を超えるときは数の少ない集計の枡から捨てる（見本は本人の基準の 20 件を残す。fitSize）。復元と端末の記録を消した後は js/backup.js が
// forgetMemoryCheck でメモリーを捨てる。学習の記録が上限で書けないときは js/storage.js がこの鍵を消す（影のデータ。js/storageGuard.js）。
// 見込みの帯・損失・影の通りは js/memoryModel.js、日の帯・中央値・ローカルの日付は js/retentionCalc.js（js/masteryMeta.js と同じもの）を使う

import { VARIANTS, BASE_VARIANT, predBand, logLoss } from "./memoryModel.js";
import { gapBand, median, localDay } from "./retentionCalc.js";
import { MEMORY_CHECK_KEY as KEY } from "./storageGuard.js";

export const SCHED_V = 1;
export const MAX_BYTES = 20000; // 20 KB 以下
export const KEEP = 40; // 見本は直近 40 件
export const MIN_BASIS = 20; // 本人の基準を使うのは 20 件たまってから
export const T1_MIN = 200; // 先打ちの疑い（測らない。js/masteryMeta.js と同じ）
export const T1_MAX = 30000; // 30 秒を超える答えは語ごとの記録・見本に入れない
export const T1_CAP = 7000; // 見本に入れるとき 7,000ms で丸める（js/masteryMeta.js の箱と同じ）
const ANSWERS_PER_FLUSH = 10;
const NV = VARIANTS.length; // 影の通りの数（7）
const BANDS_PRED = 5;
const BUCKETS = 64;
export const PATHS = ["kbd", "osk", "ime"];
const GAP_BANDS = ["1", "2-5", "6-13", "14-29", "30+"];
export const OUTCOMES = ["o", "xm", "xt"]; // ○・×（記憶: 答え表示・ヒント・パス・不明）・×（1 打ミス）
const X_KINDS = ["e", "h", "m2", "m3a", "m3", "p", "u"];
const CLFS = ["m", "p", "t"];
const CLS = ["u", "f", "n", "s"]; // 不明・すぐ・ふつう・時間がかかる（0〜3。sp の分類は文字、spP の符号は数）

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const nums = (v) => (Array.isArray(v) ? v.filter((n) => Number.isFinite(n) && n >= 0) : []);
const cnt = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
const num = (v) => (Number.isFinite(v) ? v : 0);
const r3 = (x) => Math.round(x * 1000) / 1000;
const triple = (v) => (Array.isArray(v) && v.length === 3 && v.every((n) => Number.isInteger(n) && n >= 0) ? [v[0], v[1], v[2]] : null);

// 下から q の値（最も近い順位）
export function quantile(list, q) {
  const a = nums(list).sort((x, y) => x - y);
  if (a.length === 0) return NaN;
  return a[Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1))];
}

// 問いの字数の帯（品詞の札を除いた字数）: 0 = 2 以下・1 = 3〜4・2 = 5〜7・3 = 8 以上。数でなければ null
export function qBandOf(n) {
  if (!Number.isFinite(n) || n < 0) return null;
  return n <= 2 ? 0 : n <= 4 ? 1 : n <= 7 ? 2 : 3;
}

// 答えの字数の帯: 0 = 4 以下・1 = 5〜7・2 = 8〜10・3 = 11 以上
export function aBandOf(n) {
  if (!Number.isFinite(n) || n < 0) return null;
  return n <= 4 ? 0 : n <= 7 ? 1 : n <= 10 ? 2 : 3;
}

const pathOf = (input) => (PATHS.includes(input) ? input : null);

// 語の束（FNV-1a の 32 ビット hash を 64 で割った余り）
export function bucketOf(id) {
  let h = 0x811c9dc5;
  const s = String(id ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % BUCKETS;
}

// ===== 空の形・読み込み =====

const zeros = (n) => Array(n).fill(0);
const emptyCal = () => ({
  n: zeros(NV),
  ll: zeros(NV),
  lm: zeros(NV),
  b: Array.from({ length: NV }, () => Array.from({ length: BANDS_PRED }, () => zeros(4))),
  w: Array.from({ length: BUCKETS }, () => zeros(NV))
});
const emptyLen = () => ({ q: [[], [], [], []], a: [[], [], [], []] });
const emptyInput = () => ({ t1: [], tp: [], n: 0, multi: 0 });

function emptyCheck() {
  return { v: 1, schedV: SCHED_V, cal: emptyCal(), speedNext: {}, xNext: {}, len: {}, input: {}, capHit: {}, first: { f: [], r: [] } };
}

// 壊れた・知らない形は空として読む（形の合う所だけ拾う）。版の違う集計（schedV）は混ぜない（空から）
function normalize(raw) {
  const m = emptyCheck();
  if (!isObj(raw) || raw.v !== 1 || (raw.schedV ?? SCHED_V) !== SCHED_V) return m;
  if (typeof raw.since === "string") m.since = raw.since;
  const c = raw.cal;
  if (isObj(c)) {
    for (let i = 0; i < NV; i++) {
      m.cal.n[i] = cnt(c.n?.[i]);
      m.cal.ll[i] = num(c.ll?.[i]);
      m.cal.lm[i] = num(c.lm?.[i]);
      for (let b = 0; b < BANDS_PRED; b++) for (let k = 0; k < 4; k++) m.cal.b[i][b][k] = k < 3 ? cnt(c.b?.[i]?.[b]?.[k]) : num(c.b?.[i]?.[b]?.[k]);
    }
    for (let j = 0; j < BUCKETS; j++) for (let k = 0; k < NV; k++) m.cal.w[j][k] = k < NV - 1 ? num(c.w?.[j]?.[k]) : cnt(c.w?.[j]?.[k]);
  }
  for (const key of ["speedNext", "xNext", "capHit"]) {
    if (!isObj(raw[key])) continue;
    for (const [k, v] of Object.entries(raw[key])) {
      const t = triple(v);
      if (t && /^[\w.+-]{1,24}$/.test(k)) m[key][k] = t;
    }
  }
  for (const p of PATHS) {
    const l = raw.len?.[p];
    if (isObj(l)) m.len[p] = { q: [0, 1, 2, 3].map((b) => nums(l.q?.[b]).slice(-KEEP)), a: [0, 1, 2, 3].map((b) => nums(l.a?.[b]).slice(-KEEP)) };
    const n = raw.input?.[p];
    if (isObj(n)) m.input[p] = { t1: nums(n.t1).slice(-KEEP), tp: nums(n.tp).slice(-KEEP), n: cnt(n.n), multi: cnt(n.multi) };
  }
  if (isObj(raw.first)) m.first = { f: nums(raw.first.f).slice(-KEEP), r: nums(raw.first.r).slice(-KEEP) };
  return m;
}

function readStored() {
  try {
    return normalize(JSON.parse(localStorage.getItem(KEY) || "null"));
  } catch {
    return emptyCheck();
  }
}

let mem = null; // 読んだ中身＋このタブで足した分
let dirty = false;
let answersSinceFlush = 0;
let flushQueued = false;
let delta = emptyDelta();

// このタブで前に読み書きしてから足した分（flush で読み直した中身に足す）
function emptyDelta() {
  return { since: undefined, cal: emptyCal(), speedNext: {}, xNext: {}, capHit: {}, len: {}, input: {}, first: { f: [], r: [] } };
}

function load() {
  if (!mem) mem = readStored();
  return mem;
}

function startCheck(m, nowMs) {
  const day = localDay(new Date(nowMs)) ?? undefined;
  if (!m.since) m.since = day;
  if (!delta.since) delta.since = day;
}

// 読むだけの写し（検証・バックアップの確かめ用）
export function getMemoryCheck() {
  try {
    return JSON.parse(JSON.stringify(load()));
  } catch {
    return emptyCheck();
  }
}

// ===== 足し算（メモリーと delta の両方に） =====

function bumpCell(table, key, outcome) {
  const i = OUTCOMES.indexOf(outcome);
  if (i < 0) return;
  const cell = table[key] ?? (table[key] = [0, 0, 0]);
  cell[i]++;
}

// 見込みの帯と対数損失は js/memoryModel.js（predBand・logLoss）。損失の差の基準は BASE_VARIANT（G0 1.5・速さなし）
function addCal(cal, preds, outcome, bucket) {
  const ok = outcome === "o";
  const oi = OUTCOMES.indexOf(outcome);
  const loss = preds.map((r) => (r === null ? null : logLoss(r, ok)));
  for (let i = 0; i < NV; i++) {
    const r = preds[i];
    if (r === null) continue;
    cal.n[i]++;
    cal.ll[i] = r3(cal.ll[i] + loss[i]);
    if (outcome !== "xt") cal.lm[i] = r3(cal.lm[i] + loss[i]);
    const band = predBand(r);
    cal.b[i][band][oi]++;
    cal.b[i][band][3] = r3(cal.b[i][band][3] + r);
  }
  if (loss.every((l) => l !== null)) {
    const row = cal.w[bucket];
    let k = 0;
    for (let i = 0; i < NV; i++) {
      if (i === BASE_VARIANT) continue;
      row[k] = r3(row[k] + loss[i] - loss[BASE_VARIANT]);
      k++;
    }
    row[NV - 1]++;
  }
}

const pushList = (list, v) => {
  list.push(v);
  if (list.length > KEEP) list.splice(0, list.length - KEEP);
};

// 影の 7 通りの見込み（答える前）と結果。preds: 7 つの見込み（覚えていない通りは null）。outcome: "o" | "xm" | "xt"
export function noteCalibration(id, preds, outcome, nowMs = Date.now()) {
  try {
    if (!Array.isArray(preds) || preds.length !== NV || !OUTCOMES.includes(outcome)) return;
    if (preds.every((r) => r === null)) return;
    const clean = preds.map((r) => (Number.isFinite(r) ? r : null));
    const m = load();
    startCheck(m, nowMs);
    const b = bucketOf(id);
    addCal(m.cal, clean, outcome, b);
    addCal(delta.cal, clean, outcome, b);
    dirty = true;
  } catch {
    // 集計は学習を止めない
  }
}

function noteCell(name, key, outcome, nowMs) {
  try {
    if (!OUTCOMES.includes(outcome) || !key) return;
    const m = load();
    startCheck(m, nowMs);
    bumpCell(m[name], key, outcome);
    bumpCell(delta[name], key, outcome);
    dirty = true;
  } catch {
    // 同上
  }
}

// 速さの材料の答えの、次のその日の最初の答え。pend = decodePend の値、gap = 材料の答えからの日数
export function noteSpeedNext(pend, gap, outcome, nowMs = Date.now()) {
  const band = gapBand(gap);
  if (!pend || !band) return;
  const rank = Number.isInteger(pend.rank) && pend.rank >= 1 && pend.rank <= 5 ? pend.rank : 0;
  for (const mat of ["a", "b"]) {
    if (!pend[mat]) continue;
    for (const [clf, cls] of [["m", pend.m], ["p", pend.p], ["t", pend.t]]) noteCell("speedNext", `${clf}.${mat}.${CLS[cls] ?? "u"}.${rank}.${band}`, outcome, nowMs);
  }
}

// × の種類の、次のその日の最初の答え。kind: X_KINDS のどれか
export function noteXNext(kind, gap, outcome, nowMs = Date.now()) {
  const band = gapBand(gap);
  if (!X_KINDS.includes(kind) || !band) return;
  noteCell("xNext", `${kind}.${band}`, outcome, nowMs);
}

// 上限が効いている語の、その日の最初の答え
export function noteCapHit(gap, outcome, nowMs = Date.now()) {
  const band = gapBand(gap);
  if (!band) return;
  noteCell("capHit", band, outcome, nowMs);
}

function addSamples(target, { path, t1, tp, qb, ab, first }) {
  const len = target.len[path] ?? (target.len[path] = emptyLen());
  if (qb !== null) pushList(len.q[qb], t1);
  if (ab !== null) pushList(len.a[ab], t1);
  const inp = target.input[path] ?? (target.input[path] = emptyInput());
  pushList(inp.t1, t1);
  if (tp !== null) pushList(inp.tp, tp);
  pushList(first ? target.first.f : target.first.r, t1);
}

// 測れた答えの見本（初めての答え、またはその日の最初の答えで、ノーミス正解。一度に 2 字以上入った答え・盤面の外へ焦点が移った答えは呼ばない）。
// T1 は 7,000ms で丸める。tp（T1 ＋ 最も長い止まり）は止まった答え（stalled）には無い（null）
export function noteSamples({ t1, tp = null, qLen, aLen, input, first = false }, nowMs = Date.now()) {
  try {
    const path = pathOf(input);
    if (!path || !Number.isFinite(t1) || t1 < T1_MIN || t1 > T1_MAX) return;
    const v = Math.round(Math.min(t1, T1_CAP));
    const tv = Number.isFinite(tp) && tp >= v ? Math.round(Math.min(tp, T1_CAP * 2)) : null;
    const s = { path, t1: v, tp: tv, qb: qBandOf(qLen), ab: aBandOf(aLen), first: !!first };
    const m = load();
    startCheck(m, nowMs);
    addSamples(m, s);
    addSamples(delta, s);
    dirty = true;
  } catch {
    // 同上
  }
}

// 測りの札のある正解を経路ごとに数える（同じ日の答えも）。multi: 1 回の input で 2 字以上入った・置き換えの入力があった
export function noteInputCount(input, multi, nowMs = Date.now()) {
  try {
    const path = pathOf(input);
    if (!path) return;
    const m = load();
    startCheck(m, nowMs);
    for (const t of [m, delta]) {
      const inp = t.input[path] ?? (t.input[path] = emptyInput());
      inp.n++;
      if (multi) inp.multi++;
    }
    dirty = true;
  } catch {
    // 同上
  }
}

// ===== 本人の基準（入れる前の見本と比べる） =====
// 経路 input の見本から: band = 同じ問いの字数帯の T1 の中央値（20 件以上）、all = 経路の T1 の中央値（20 件以上）、
// p20 = 経路の T1 の下から 2 割の値（20 件以上）、tp = 経路の「T1 ＋ 最も長い止まり」の中央値（20 件以上）。足りなければ null
export function speedBasis({ qLen, input } = {}) {
  const none = { all: null, band: null, p20: null, tp: null };
  try {
    const path = pathOf(input);
    if (!path) return none;
    const m = load();
    const inp = m.input[path];
    const qb = qBandOf(qLen);
    const bandList = qb === null ? [] : m.len[path]?.q[qb] ?? [];
    const ok = (list) => nums(list).length >= MIN_BASIS;
    return {
      all: inp && ok(inp.t1) ? median(inp.t1) : null,
      band: ok(bandList) ? median(bandList) : null,
      p20: inp && ok(inp.t1) ? quantile(inp.t1, 0.2) : null,
      tp: inp && ok(inp.tp) ? median(inp.tp) : null
    };
  } catch {
    return none;
  }
}

// 速さの物差し 2 つ（集計 speedNext 用。今の分類 classifySpeed は変えない）。0 不明・1 すぐ・2 ふつう・3 時間がかかる
//   p: 下から 2 割の値 × 1.3 以下ですぐ、その 2 倍を超えると時間がかかる
//   t: 「T1 ＋ 最も長い止まり」が中央値の 0.75 倍以下ですぐ、1.5 倍を超えると時間がかかる
export function classP20(t1, p20) {
  if (!Number.isFinite(t1) || !(p20 > 0)) return 0;
  const line = p20 * 1.3;
  return t1 <= line ? 1 : t1 > line * 2 ? 3 : 2;
}
export function classTp(tp, base) {
  if (!Number.isFinite(tp) || !(base > 0)) return 0;
  return tp <= base * 0.75 ? 1 : tp > base * 1.5 ? 3 : 2;
}

// 語ごとの記録 spP（速さの材料の答えの控え）の符号: 材料 a・b（各 1 ビット）、物差し m・p・t の分類（各 2 ビット）、段（3 ビット）
export function encodePend({ a = false, b = false, m = 0, p = 0, t = 0, rank = 0 }) {
  return (a ? 1 : 0) | (b ? 2 : 0) | ((m & 3) << 2) | ((p & 3) << 4) | ((t & 3) << 6) | ((rank & 7) << 8);
}
export function decodePend(code) {
  if (!Number.isInteger(code) || code < 0) return null;
  return { a: !!(code & 1), b: !!(code & 2), m: (code >> 2) & 3, p: (code >> 4) & 3, t: (code >> 6) & 3, rank: (code >> 8) & 7 };
}

// sp の 1 件の印: 材料 a（1）・b（2）、問いの字数帯（2 ビット、<<2）、答えの字数帯（2 ビット、<<4）、初めての答え（<<6）、経路（kbd 0・osk 1・ime 2、<<7）
export function encodeMark({ a = false, b = false, qb = 0, ab = 0, first = false, input = "kbd" }) {
  const pi = Math.max(0, PATHS.indexOf(input));
  return (a ? 1 : 0) | (b ? 2 : 0) | (((qb ?? 0) & 3) << 2) | (((ab ?? 0) & 3) << 4) | (first ? 64 : 0) | ((pi & 3) << 7);
}
export function decodeMark(mark) {
  if (!Number.isInteger(mark) || mark < 0) return null;
  return { a: !!(mark & 1), b: !!(mark & 2), qb: (mark >> 2) & 3, ab: (mark >> 4) & 3, first: !!(mark & 64), input: PATHS[(mark >> 7) & 3] ?? null };
}

export const CLS_CODE = Object.freeze({ unknown: 0, fast: 1, normal: 2, slow: 3 });
export const CLS_CHAR = Object.freeze({ unknown: "u", fast: "f", normal: "n", slow: "s" });

// ===== 保存 =====

function mergeCal(base, d) {
  for (let i = 0; i < NV; i++) {
    base.n[i] += d.n[i];
    base.ll[i] = r3(base.ll[i] + d.ll[i]);
    base.lm[i] = r3(base.lm[i] + d.lm[i]);
    for (let b = 0; b < BANDS_PRED; b++) for (let k = 0; k < 4; k++) base.b[i][b][k] = k < 3 ? base.b[i][b][k] + d.b[i][b][k] : r3(base.b[i][b][k] + d.b[i][b][k]);
  }
  for (let j = 0; j < BUCKETS; j++) for (let k = 0; k < NV; k++) base.w[j][k] = k < NV - 1 ? r3(base.w[j][k] + d.w[j][k]) : base.w[j][k] + d.w[j][k];
}

// 保存を読み直した中身 base に、このタブで足した分 d を足す（base を書き換えて返す）
function mergeDelta(base, d) {
  const m = base;
  if (d.since && (!m.since || d.since < m.since)) m.since = d.since;
  mergeCal(m.cal, d.cal);
  for (const key of ["speedNext", "xNext", "capHit"]) {
    for (const [k, [o, x, t]] of Object.entries(d[key])) {
      const c = m[key][k] ?? [0, 0, 0];
      m[key][k] = [c[0] + o, c[1] + x, c[2] + t];
    }
  }
  for (const [p, l] of Object.entries(d.len)) {
    const ml = m.len[p] ?? (m.len[p] = emptyLen());
    for (const k of ["q", "a"]) for (let b = 0; b < 4; b++) ml[k][b] = [...ml[k][b], ...l[k][b]].slice(-KEEP);
  }
  for (const [p, n] of Object.entries(d.input)) {
    const mi = m.input[p] ?? (m.input[p] = emptyInput());
    mi.t1 = [...mi.t1, ...n.t1].slice(-KEEP);
    mi.tp = [...mi.tp, ...n.tp].slice(-KEEP);
    mi.n += n.n;
    mi.multi += n.multi;
  }
  m.first = { f: [...m.first.f, ...d.first.f].slice(-KEEP), r: [...m.first.r, ...d.first.r].slice(-KEEP) };
  return m;
}

// 20 KB を超えるときの捨て方（PR #172 のレビュー 3。見本が本人の基準の 20 件〔MIN_BASIS〕を割ると speedBasis が null を返し続け、
// sp の q・speedNext の p／t の分類がずっと「不明」になるので、見本は最後に削る）:
//   1. 集計の枡（speedNext・xNext・capHit）を、答えの数（○・×記憶・×1 打ミスの和）の少ない順に、初めの枡の数の 1 割ずつ捨てる
//      （同じ数なら先にできた枡から。数の少ない枡ほど読める差が小さい。次に数えるときは 0 から足し直す）
//   2. 枡が尽きても超えるなら、見本（直近 40 件の T1）を古い方から 10 件ずつ捨てる。20 件（MIN_BASIS）で収まればそこで止める
//   3. それでも超えるなら 20 件より下へ（10・0）。見込みの集計 cal と since は捨てない（大きさが決まっている: 1 年で約 4,000 字）
// 1 年の模擬は 300 語で 16,451 字（枡 255）、2,000 語で 17,792 字（枡 288）で、どちらも何も捨てない。枡が 600 近くになる（2 年を超える）と効く
export function fitSize(m, max = MAX_BYTES) {
  let json = JSON.stringify(m);
  if (json.length <= max) return json;
  const cells = [];
  for (const key of ["speedNext", "xNext", "capHit"]) for (const [k, v] of Object.entries(m[key])) cells.push([key, k, v[0] + v[1] + v[2]]);
  cells.sort((x, y) => x[2] - y[2]); // 安定な並べ替え（同じ数なら先にできた順）
  const step = Math.max(1, Math.ceil(cells.length / 10));
  for (let i = 0; json.length > max && i < cells.length; i += step) {
    for (const [key, k] of cells.slice(i, i + step)) delete m[key][k];
    json = JSON.stringify(m);
  }
  const lists = () => {
    const out = [];
    for (const l of Object.values(m.len)) for (const k of ["q", "a"]) out.push(...l[k]);
    for (const n of Object.values(m.input)) out.push(n.t1, n.tp);
    out.push(m.first.f, m.first.r);
    return out;
  };
  for (let keep = KEEP - 10; json.length > max && keep >= 0; keep -= 10) {
    for (const list of lists()) if (list.length > keep) list.splice(0, list.length - keep);
    json = JSON.stringify(m);
  }
  return json;
}

// 変わっていれば 1 回書く（読み直して delta を足し、20 KB に収める）。書いた中身をメモリーにする
export function flushMemoryCheck() {
  answersSinceFlush = 0;
  flushQueued = false;
  if (!dirty || !mem) return false;
  try {
    const merged = mergeDelta(readStored(), delta);
    const json = fitSize(merged);
    localStorage.setItem(KEY, json);
    mem = merged;
    delta = emptyDelta();
    dirty = false;
    return true;
  } catch {
    return false; // 書けなかった（容量など）: 足した分は持ったまま、次の機会にもう一度
  }
}

// 手が空いたとき（答えのタスクの外）に 1 回書く。無ければ次のタスクに。変わっていなければ書かない
export function scheduleMemoryCheckFlush() {
  if (flushQueued || !dirty) return;
  flushQueued = true;
  const run = () => {
    if (flushQueued) flushMemoryCheck();
  };
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 2000 });
  else setTimeout(run, 0);
}

// 答えごとに書き手（js/stats.js）が呼ぶ。10 答えごとに、答えのタスクの外で書く
export function tickMemoryCheck() {
  answersSinceFlush++;
  if (answersSinceFlush >= ANSWERS_PER_FLUSH) {
    answersSinceFlush = 0;
    scheduleMemoryCheckFlush();
  }
}

// 保存を直に書き換えた所（バックアップの復元・端末の記録を消す。js/backup.js）が呼ぶ。メモリーの中身と書きかけを捨てる
export function forgetMemoryCheck() {
  mem = null;
  dirty = false;
  answersSinceFlush = 0;
  flushQueued = false;
  delta = emptyDelta();
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("pagehide", () => flushMemoryCheck());
  // 裏に回った: その場で書く（裏のタブは pagehide なしで捨てられうる。PR #172 のレビュー 2）
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushMemoryCheck();
    });
  }
}
