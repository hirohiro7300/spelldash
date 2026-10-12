// ===== 習熟度の速さの基準と、段の確かめの集計（端末だけ） =====
// spelldash_mastery_meta に 1 つの JSON を持つ。同期しない（入力の速さは端末と指に固有）。画面には出さない（秒数・分類の名前も）。
// 速さの分類は js/game.js が書き手の前に呼び、書き手（js/stats.js）は確かめの集計だけを足す。定義は docs/SPEC_MASTERY.md（§3.4・§3.8・§7）。
//
// spelldash_mastery_meta = {
//   v: 1,
//   speed: { "en.kbd.study": { t1: [ms…], pc: [ms…] }, … },          箱は 8 つ（boxKey）・各 40 件まで
//   check: {
//     since: "YYYY-MM-DD",                                           数え始めた日
//     rank: { "3": { "1": [o, x], "2-5": [o, x], … }, … },            その日の最初の答え: 答える前の段 × gap の帯 × 結果
//     firstFast: { prior: [o, x], own: [o, x] },                      初めての答えで「すぐ」だった語の、次のその日の最初の答え
//     pending: { "<id>": "p" | "o" },                                 その答えを待つ語（200 件まで。古い順に捨てる）
//     firstMedian: { "en.kbd.study": ms, … }                          各箱で初めて 20 件たまったときの中央値（1 回だけ書く）
//   }
// }
//
// 答えごとには書かない。メモリーに持ち、変わったとき（dirty）だけ、10 答えごと（tickMasteryMeta）・回の終わり・stopGame・pagehide で
// 1 回書く（flushMasteryMeta）。変わっていなければ書かない。読み書きはすべて try/catch（失敗しても学習は続く。js/retentionLog.js と同じ作法）。
// 2 つのタブで同時に学んでも互いに消さない: 書く直前に保存を読み直し、このタブで足した分（速さの見本・集計の増分。delta）だけを足して書く
// （見本は各箱の最新 40 件、集計は足し算）。書いた後のメモリーは保存と同じ中身（もう一方のタブの見本も基準に入る）。

import { localDay } from "./retentionCalc.js";

const KEY = "spelldash_mastery_meta";

export const FAST_RATIO = 0.75; // 本人の中央値の 0.75 倍以下で「すぐ」
export const SLOW_RATIO = 1.5; // 1.5 倍を超えると「遅い」
export const PC_FAST_MAX = 2; // 1 字あたりが基準の 2 倍を超える語は「すぐ」にしない（綴りで迷った語）
export const PC_SLOW = 2.5; // 1 字あたりが基準の 2.5 倍を超えると「遅い」
export const MIN_SAMPLES = 20; // 本人の基準を使うのは箱に 20 件たまってから
export const KEEP = 40; // 箱ごとに直近 40 件
export const T1_MIN = 200; // 出題から最初のキーまで 200ms 未満は先打ちの疑い（測らない）
export const T1_CAP = 7000; // 入れるとき 7,000ms で丸める
// 本人の基準が無い間（箱が 20 件未満）、初めての答え・英語の綴りに限って「すぐ」を決める既定の線（推定。§3.8 で見直す）。
// 控えめな既定の中央値（物理キーボード 2,000ms・画面キーボード 2,800ms）× 0.75
export const COLD_FAST_MS = { "en.kbd": 1500, "en.touch": 2100 };
const PENDING_MAX = 200;
const ANSWERS_PER_FLUSH = 10;

const LANGS = ["en", "ja"]; // en = 英語の綴り、ja = ローマ字の答え
const INPUTS = ["kbd", "touch"]; // その語の最初のキーが来た経路（物理キー／画面キーボード・ソフトウェアキーボード）
const CTXS = ["study", "play"]; // study = Study（語数・60 秒）、play = Challenge・Daily
export const BOX_KEYS = LANGS.flatMap((l) => INPUTS.flatMap((i) => CTXS.map((c) => `${l}.${i}.${c}`)));
const BOX_SET = new Set(BOX_KEYS);
const BANDS = ["1", "2-5", "6-13", "14-29", "30+"];

// 箱の名前 `${lang}.${input}.${ctx}`。どれかが外れていれば null
export function boxKey({ lang, input, ctx } = {}) {
  const key = `${lang}.${input}.${ctx}`;
  return BOX_SET.has(key) ? key : null;
}

// gap（整数日）の帯。1 未満・数でなければ null
export function gapBand(gap) {
  if (!Number.isFinite(gap) || gap < 1) return null;
  if (gap === 1) return "1";
  if (gap <= 5) return "2-5";
  if (gap <= 13) return "6-13";
  if (gap <= 29) return "14-29";
  return "30+";
}

export function median(list) {
  const a = (Array.isArray(list) ? list : []).filter(Number.isFinite).sort((x, y) => x - y);
  if (a.length === 0) return NaN;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// ===== メモリーの中身 =====

let meta = null; // 読んだ中身（無ければ空）＋このタブで足した分
let dirty = false; // 保存していない変化がある
let answersSinceFlush = 0;
// 前に書いてから（読んでから）このタブで足した分。flush で保存を読み直した中身に足す
let delta = emptyDelta();

function emptyDelta() {
  return { speed: {}, rank: {}, firstFast: { prior: [0, 0], own: [0, 0] }, pendingAdd: new Map(), pendingDel: new Set() };
}

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const nums = (v) => (Array.isArray(v) ? v.filter((n) => Number.isFinite(n) && n >= 0) : []);
const pair = (v) => (Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n) && n >= 0) ? [v[0], v[1]] : [0, 0]);

function emptyMeta() {
  return { v: 1, speed: {}, check: { rank: {}, firstFast: { prior: [0, 0], own: [0, 0] }, pending: {}, firstMedian: {} } };
}

// 壊れた・知らない形は空として読む（形の合う所だけ拾う）
function normalize(raw) {
  const m = emptyMeta();
  if (!isObj(raw) || raw.v !== 1) return m;
  if (isObj(raw.speed)) {
    for (const k of BOX_KEYS) {
      const b = raw.speed[k];
      if (isObj(b)) m.speed[k] = { t1: nums(b.t1).slice(-KEEP), pc: nums(b.pc).slice(-KEEP) };
    }
  }
  const c = raw.check;
  if (isObj(c)) {
    if (typeof c.since === "string") m.check.since = c.since;
    if (isObj(c.rank)) {
      for (const r of ["1", "2", "3", "4", "5"]) {
        if (!isObj(c.rank[r])) continue;
        m.check.rank[r] = {};
        for (const band of BANDS) if (c.rank[r][band] !== undefined) m.check.rank[r][band] = pair(c.rank[r][band]);
      }
    }
    if (isObj(c.firstFast)) m.check.firstFast = { prior: pair(c.firstFast.prior), own: pair(c.firstFast.own) };
    if (isObj(c.pending)) {
      for (const [id, v] of Object.entries(c.pending).slice(-PENDING_MAX)) if (v === "p" || v === "o") m.check.pending[id] = v;
    }
    if (isObj(c.firstMedian)) {
      for (const k of BOX_KEYS) if (Number.isFinite(c.firstMedian[k])) m.check.firstMedian[k] = c.firstMedian[k];
    }
  }
  return m;
}

function readStored() {
  try {
    return normalize(JSON.parse(localStorage.getItem(KEY) || "null"));
  } catch {
    return emptyMeta();
  }
}

function load() {
  if (!meta) meta = readStored();
  return meta;
}

// 保存を読み直した中身 base に、このタブで足した分 d を足す（base を書き換えて返す）。mem = このタブのメモリー（数え始めた日・最初の中央値の控え）
function mergeDelta(base, d, mem) {
  const m = base;
  for (const [box, add] of Object.entries(d.speed)) {
    const b = m.speed[box] ?? { t1: [], pc: [] };
    m.speed[box] = { t1: [...b.t1, ...add.t1].slice(-KEEP), pc: [...b.pc, ...add.pc].slice(-KEEP) };
  }
  for (const box of BOX_KEYS) {
    if (Number.isFinite(m.check.firstMedian[box])) continue; // 先に書いたタブの値のまま（1 回だけ書く）
    if (Number.isFinite(mem?.check.firstMedian[box])) m.check.firstMedian[box] = mem.check.firstMedian[box];
    else if ((m.speed[box]?.t1.length ?? 0) >= MIN_SAMPLES) m.check.firstMedian[box] = median(m.speed[box].t1); // 足して初めて 20 件
  }
  const since = mem?.check.since;
  if (since && (!m.check.since || since < m.check.since)) m.check.since = since;
  for (const [r, row] of Object.entries(d.rank)) {
    const mrow = m.check.rank[r] ?? (m.check.rank[r] = {});
    for (const [band, [o, x]] of Object.entries(row)) {
      const c = mrow[band] ?? [0, 0];
      mrow[band] = [c[0] + o, c[1] + x];
    }
  }
  for (const k of ["prior", "own"]) m.check.firstFast[k] = [m.check.firstFast[k][0] + d.firstFast[k][0], m.check.firstFast[k][1] + d.firstFast[k][1]];
  for (const id of d.pendingDel) delete m.check.pending[id];
  for (const [id, code] of d.pendingAdd) {
    delete m.check.pending[id];
    m.check.pending[id] = code;
  }
  const ids = Object.keys(m.check.pending);
  for (let i = 0; i < ids.length - PENDING_MAX; i++) delete m.check.pending[ids[i]];
  return m;
}

function touch() {
  dirty = true;
}

function startCheck(m, nowMs) {
  if (!m.check.since) m.check.since = localDay(new Date(nowMs)) ?? undefined;
}

// 読むだけの写し（検証・バックアップの確かめ用）
export function getMasteryMeta() {
  try {
    return JSON.parse(JSON.stringify(load()));
  } catch {
    return emptyMeta();
  }
}

// 箱の中身の写し { t1: [...], pc: [...] }
export function getSpeedBox(box) {
  const b = load().speed[box];
  return { t1: b ? [...b.t1] : [], pc: b ? [...b.pc] : [] };
}

// ===== 速さ =====

// 物理キーボードの印字キーの KeyboardEvent.code（US・JIS 配列の文字・数字・記号・空白・テンキー）
const PHYSICAL_CODE = /^(?:Key[A-Z]|Digit[0-9]|Numpad\w+|Minus|Equal|Space|Quote|Backquote|Comma|Period|Slash|Semicolon|Backslash|BracketLeft|BracketRight|IntlBackslash|IntlRo|IntlYen)$/;

// keydown が来た入力の経路（速さの箱の input）: 物理キーとみなすのは、信頼されたイベントで code が物理キーの名前のときだけ（"kbd"）。
// iPhone・Android の画面キーボードの keydown は信頼されたイベントでも code が空・"Unidentified"・keyCode 229 なので "touch"。
// 専用の画面キーボード（#osk のボタンが合成する keydown。isTrusted 偽）も "touch"
export function keyInputOf(event) {
  if (!event || event.isTrusted === false) return "touch";
  if (event.keyCode === 229) return "touch";
  return PHYSICAL_CODE.test(event.code ?? "") ? "kbd" : "touch";
}

// sample = { t1, pc }（ms）。t1 が数で 200ms 以上なら測れた答え。pc は字数 3 以上のときだけ数（ほかは null）
export function isMeasured(sample) {
  return !!sample && Number.isFinite(sample.t1) && sample.t1 >= T1_MIN;
}

const pcOf = (sample) => (Number.isFinite(sample?.pc) && sample.pc >= 0 ? sample.pc : null);

// 今の答えの速さを、入れる前の箱と比べて分類する（仮の値。§3.8 で見直す）。
//   box: boxKey の値。firstAnswer: 初めての答えか（answerContext の firstAnswer）。data: 箱の中身の差し替え（単体テスト用）
// 返り値 { speed: "fast" | "normal" | "slow" | "unknown", basis: "own" | "prior" | null }
//   箱の T1 が 20 件以上: 本人の中央値と比べる（pc は pc の箱が 20 件以上のときだけ見る）
//   20 件未満: 初めての答え・英語の綴りで、既定の線以下のときだけ fast（prior）。ほかは unknown（既定から遅い・ふつうは出さない）
export function classifySpeed(sample, box, { firstAnswer = false, data } = {}) {
  const unknown = { speed: "unknown", basis: null };
  if (!BOX_SET.has(box) || !isMeasured(sample)) return unknown;
  const b = data ?? getSpeedBox(box);
  const t1s = nums(b?.t1);
  const pcs = nums(b?.pc);
  const t1 = sample.t1;
  const pc = pcOf(sample);
  if (t1s.length >= MIN_SAMPLES) {
    const base = median(t1s);
    const usePc = pc !== null && pcs.length >= MIN_SAMPLES;
    const pcBase = usePc ? median(pcs) : NaN;
    if (t1 <= base * FAST_RATIO && (!usePc || pc <= pcBase * PC_FAST_MAX)) return { speed: "fast", basis: "own" };
    if (t1 > base * SLOW_RATIO || (usePc && pc > pcBase * PC_SLOW)) return { speed: "slow", basis: "own" };
    return { speed: "normal", basis: "own" };
  }
  const [lang, input] = box.split(".");
  const line = lang === "en" ? COLD_FAST_MS[`${lang}.${input}`] : undefined;
  if (firstAnswer && Number.isFinite(line) && t1 <= line) return { speed: "fast", basis: "prior" };
  return unknown;
}

// 測れた答えを箱に入れる（初めての答え、またはその日の最初の答えで、ノーミス正解のときだけ呼ぶ。分類はこの前に済ませる）。
// T1 は 7,000ms で丸める。各 40 件まで（古いものから捨てる）。箱が初めて 20 件になったとき、その中央値を firstMedian に 1 回だけ書く
export function noteSpeedSample(box, sample) {
  try {
    if (!BOX_SET.has(box) || !isMeasured(sample)) return false;
    const m = load();
    const b = m.speed[box] ?? { t1: [], pc: [] };
    const t1 = Math.min(sample.t1, T1_CAP);
    b.t1 = [...b.t1, t1].slice(-KEEP);
    const pc = pcOf(sample);
    if (pc !== null) b.pc = [...b.pc, pc].slice(-KEEP);
    m.speed[box] = b;
    if (b.t1.length >= MIN_SAMPLES && !Number.isFinite(m.check.firstMedian[box])) m.check.firstMedian[box] = median(b.t1);
    const db = delta.speed[box] ?? (delta.speed[box] = { t1: [], pc: [] });
    db.t1 = [...db.t1, t1].slice(-KEEP);
    if (pc !== null) db.pc = [...db.pc, pc].slice(-KEEP);
    touch();
    return true;
  } catch {
    return false;
  }
}

// ===== 段の確かめ（§3.8） =====

// その日の最初の答え（gap ≥ 1）ごとに、答える前の段 × gap の帯 × 結果を数える（js/stats.js の書き手から。Battle も入る）。
// 初めての答えで「すぐ」だった語（pending）なら、その結果を firstFast にも数えて pending から消す
export function noteRankCheck({ id, rankBefore, gap, ok }, nowMs = Date.now()) {
  try {
    const band = gapBand(gap);
    const r = Number(rankBefore);
    if (!band || !Number.isInteger(r) || r < 1 || r > 5) return;
    const m = load();
    startCheck(m, nowMs);
    const row = m.check.rank[String(r)] ?? (m.check.rank[String(r)] = {});
    const cell = row[band] ?? (row[band] = [0, 0]);
    cell[ok ? 0 : 1]++;
    const drow = delta.rank[String(r)] ?? (delta.rank[String(r)] = {});
    (drow[band] ?? (drow[band] = [0, 0]))[ok ? 0 : 1]++;
    const code = id ? m.check.pending[id] : undefined;
    if (code === "p" || code === "o") {
      const kind = code === "p" ? "prior" : "own";
      m.check.firstFast[kind][ok ? 0 : 1]++;
      delete m.check.pending[id];
      delta.firstFast[kind][ok ? 0 : 1]++;
      delta.pendingAdd.delete(id);
      delta.pendingDel.add(id);
    }
    touch();
  } catch {
    // 集計は学習を止めない
  }
}

// 初めての答えで「すぐ」と分類した語を控える（basis: "prior" | "own"）。200 件を超えたら古い順に捨てる
export function notePendingFirstFast(id, basis, nowMs = Date.now()) {
  try {
    const code = basis === "prior" ? "p" : basis === "own" ? "o" : null;
    if (!id || !code) return;
    const m = load();
    startCheck(m, nowMs);
    delete m.check.pending[id]; // 入れ直して末尾（新しい側）へ
    m.check.pending[id] = code;
    const ids = Object.keys(m.check.pending);
    for (let i = 0; i < ids.length - PENDING_MAX; i++) delete m.check.pending[ids[i]];
    delta.pendingDel.delete(id);
    delta.pendingAdd.delete(id);
    delta.pendingAdd.set(id, code);
    touch();
  } catch {
    // 集計は学習を止めない
  }
}

// ===== 保存 =====

// 変わっていれば 1 回書く。変わっていなければ何もしない（読むだけのページ・机に戻るたびの stopGame でも書かない）。
// 書く直前に保存を読み直し、このタブで足した分だけを足す（もう一方のタブが書いた見本・集計を消さない）。書いた中身をメモリーにする
export function flushMasteryMeta() {
  answersSinceFlush = 0;
  if (!dirty || !meta) return false;
  try {
    const merged = mergeDelta(readStored(), delta, meta);
    localStorage.setItem(KEY, JSON.stringify(merged));
    meta = merged;
    delta = emptyDelta();
    dirty = false;
    return true;
  } catch {
    return false; // 書けなかった（容量など）: 足した分は持ったまま、次の機会にもう一度
  }
}

// 答えごとに書き手（js/stats.js）が呼ぶ。10 答えごとに flushMasteryMeta
export function tickMasteryMeta() {
  answersSinceFlush++;
  if (answersSinceFlush >= ANSWERS_PER_FLUSH) flushMasteryMeta();
}

// 保存を直に書き換えた所（バックアップの復元・端末の記録を消す。js/backup.js）が呼ぶ。メモリーの中身と書きかけを捨てる
// （古い基準が後から復元・消去した中身を上書きしない）
export function forgetMasteryMeta() {
  meta = null;
  dirty = false;
  answersSinceFlush = 0;
  delta = emptyDelta();
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("pagehide", () => flushMasteryMeta());
}
