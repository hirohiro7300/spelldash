// ===== 語ごとの記録の質（spelldash_memory_words。端末だけ・画面には出さない） =====
// 速さの記録 sp・その控え spP・影の計算の S と難しさ（memSv・memD・memD0）を、語の記録（spelldash_word_stats）とは別のキーに持つ。
// 語の記録は正解のたびに表を丸ごと JSON にして書く（js/storage.js）ので、そこに欄を足すと入力完了から次の問題までが重くなる（Batch 58）。
// こちらは masteryMeta・memoryCheck と同じく、メモリーに持って 10 答えごと・回の終わり・pagehide にまとめて書く。
// 書き手は js/stats.js（recordRecallSuccess・recordRecallFail の noteMemory）だけ。定義は docs/SPEC_MASTERY.md §12。同期しない。
//
// spelldash_memory_words = {
//   v: 1,
//   w: { "<語の id>": {
//     t: ms,                 この端末の書き手が最後にこの語の答えを書いた時刻（= その答えの lastRecall*At）。見ていない答え（2 台目・古い版）を見分ける
//     memSv: [7], memD, memD0,  影の 7 通りの S・難しさ・その初めの値（0.1 刻みの整数: 値 × 10。js/memoryModel.js readShadow・writeShadow）
//     sp: [[日番号, T1, q, 分類, 印] × 3まで],  速さの記録（材料 (a) の答え）
//     spP: [日番号, 符号]     速さの材料 (a)・(b) の答えの控え（次のその日の最初の答えで数えて消す）
//   } }
// }
//
// 書く機会: 10 答えごと（tickMemoryWords）と回の終わり（js/masteryMeta.js flushMasteryMeta）は、答えのタスクの外（手が空いたとき）に 1 回。
// pagehide と、裏に回ったとき（visibilitychange で hidden。スマホは裏のタブを pagehide なしで捨てることが多い。PR #172 のレビュー 2）はその場で 1 回。
// 変えた語が無ければ書かない。書く直前に保存を読み直し（前に読んだ・書いた文字列と同じなら JSON から戻さず
// メモリーの中身を使う）、このタブで変えた語だけを足す。ただし
//   ・保存の方が新しい（もう一方のタブが後から答えた: t が大きい）語は保存のまま
//   ・語の記録に無い・語の記録の最後の答えがこのタブの答えより古い語（別のタブで復元・端末の記録を消した・書けなかった）は足さない
// 上限は MAX_CHARS 字と「学習の記録と合わせて SHARED_BUDGET 字（js/storageGuard.js）」の小さい方。超えたら、最後に答えた時刻の古い語から、
// 語ごとの欄をまるごと捨てて 9 割まで減らす（次に答えたとき今の記録から作り直す。学習の記録の書き込みの余地を残す。PR #172 のレビュー 1）。
// 学習の記録（js/storage.js）が上限で書けないときは、こちらの鍵の方を先に消す（その後はこのタブで変えた語だけを書き直す）。
// 壊れた保存（JSON でない・形が違う）は止めずに空として読み、上書きする前に 1 つだけ spelldash_memory_words_corrupt に写す（js/storage.js の
// 退避と同じ包み・512K 字まで・30 日で消す。js/storageGuard.js）。
// 復元と端末の記録を消した後は js/backup.js が forgetMemoryWords でメモリーを捨てる。読み書きはすべて try/catch（失敗しても学習は続く）。

import { MEMORY_WORDS_KEY as KEY, MEMORY_WORDS_CORRUPT_KEY as CORRUPT_KEY, SHARED_BUDGET, keepCorrupt as keepCorruptCopy, expireCorrupt } from "./storageGuard.js";

// 語の記録の読み手と、その保存の字数は書き手（js/stats.js）が渡す（useWordStatsReader）。ここで js/storage.js を読まないのは、js/masteryMeta.js
// （回の終わりの書き込み）からも読まれ、保存の移行（js/storage.js の読み込みで走る）を連れてこないため
let readWordStats = null;
let readWordStatsChars = null;
export function useWordStatsReader(fn, charsFn = null) {
  readWordStats = typeof fn === "function" ? fn : null;
  readWordStatsChars = typeof charsFn === "function" ? charsFn : null;
}

// 50 万字: 2,000 語を 1 年使った記録で約 37 万字（1 語 約 185 字）。約 2,700 語までは捨てない（学習の記録との合計の上限が先に効くことがある: 下の roomLeft）。
// 端末の保存の枠は端末で違う（Chromium は鍵と値の合計 5,242,880 字、iPhone の Safari は約 250 万字）。後者では 2 割になるので、合計でも抑える
export const MAX_CHARS = 500000;
const TRIM_RATIO = 0.9;
const ANSWERS_PER_FLUSH = 10;

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

let mem = null; // 読んだ中身（{ id: entry }）＋このタブで変えた語
let memRaw = null; // mem の元の保存の文字列（読んだ・書いた文字列。保存がこれと同じなら、ほかのタブは書いていない）
let changed = new Map(); // 前に書いて（読んで）から、このタブで変えた語 → entry
let orig = new Map(); // changed の語の、変える前の保存の値（無ければ undefined。書き戻さない語を元に戻す）
let answers = 0;
let stale = false; // 別のタブが書いた（storage イベント）: 次に使うときに読み直す
let flushQueued = false;
let prefetchQueued = false;

// 壊れた保存の写し（包み・512K 字まで。容量で写せなければ元の鍵を写しへ移す。それも書けなければ元に戻す: 記録の質は学習を止めない）
function keepCorrupt(raw) {
  keepCorruptCopy(KEY, CORRUPT_KEY, raw);
}

// 読み込みのとき: 30 日たった写しを消す（読む所が無い。Batch 68 の形〔元の値そのまま・上限なし〕は今の日時で包み直す）
expireCorrupt(CORRUPT_KEY);

function readRaw() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

// 保存の文字列を語ごとの表にする。無い・null は空。壊れた JSON・形の違う値は写しを残して空として読む
function parseStored(raw) {
  if (!raw) return {};
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    value = undefined;
  }
  if (value === null) return {};
  if (isObj(value) && value.v === 1 && isObj(value.w)) return value.w;
  keepCorrupt(raw);
  return {};
}

function load() {
  if (!mem || stale) {
    const raw = readRaw();
    const base = parseStored(raw);
    for (const [id, e] of changed) {
      orig.set(id, base[id]); // 読み直した保存の値（書き戻さないときに戻す）
      base[id] = e; // まだ書いていないこのタブの変化は持ったまま
    }
    mem = base;
    memRaw = raw;
    stale = false;
  }
  return mem;
}

// 語の記録の最後の答えの時刻（ms）
function lastAnswerMs(st) {
  return Math.max(Date.parse(st?.lastRecallSuccessAt ?? "") || 0, Date.parse(st?.lastRecallFailAt ?? "") || 0);
}

// 語の記録の質（無ければ null）。返り値は書き換えない（書き手は新しい entry を putMemoryWord で置く）
export function getMemoryWord(id) {
  try {
    const e = load()[id];
    return isObj(e) ? e : null;
  } catch {
    return null;
  }
}

// 書き手（js/stats.js）が答えごとに置く。保存は 10 答えごと・回の終わり・pagehide
export function putMemoryWord(id, entry) {
  try {
    if (!id || !isObj(entry)) return;
    const table = load();
    if (!orig.has(id)) orig.set(id, table[id]);
    table[id] = entry;
    changed.set(id, entry);
  } catch {
    // 記録の質は学習を止めない
  }
}

// 上限を超えたとき: 最後に答えた時刻（t）の古い語から捨てて、上限の 9 割に収める（table を書き換える）
function trim(table, max) {
  const target = Math.floor(max * TRIM_RATIO);
  const rows = Object.entries(table).map(([id, e]) => [id, Number(e?.t) || 0, JSON.stringify(id).length + JSON.stringify(e ?? null).length + 2]);
  let total = rows.reduce((n, r) => n + r[2], 12);
  rows.sort((a, b) => a[1] - b[1]);
  for (const [id, , size] of rows) {
    if (total <= target) break;
    delete table[id];
    total -= size;
  }
}

// この鍵に使ってよい字数: 学習の記録と合わせて SHARED_BUDGET 字まで（学習の記録の字数が分からなければ上限なし）
function roomLeft() {
  try {
    const used = readWordStatsChars ? Number(readWordStatsChars()) : NaN;
    return Number.isFinite(used) ? Math.max(0, SHARED_BUDGET - used) : Infinity;
  } catch {
    return Infinity;
  }
}

function serialize(table, max) {
  let json = JSON.stringify({ v: 1, w: table });
  if (json.length > max) {
    trim(table, max);
    json = JSON.stringify({ v: 1, w: table });
  }
  return json;
}

// 変えた語があれば 1 回書く（読み直してこのタブの変化だけを足し、上限〔max と、学習の記録と合わせた枠の小さい方〕に収める）。書いた中身をメモリーにする
export function flushMemoryWords({ max = MAX_CHARS } = {}) {
  flushQueued = false;
  answers = 0;
  if (changed.size === 0) return false;
  try {
    // 保存が前に読んだ・書いた文字列のままなら（ほかのタブが書いていない）、JSON から戻さずメモリーの中身を使う（このタブの変化はもう入っている）
    const raw = readRaw();
    const same = !!mem && raw !== null && raw === memRaw;
    const base = same ? mem : parseStored(raw);
    let stats = null;
    try {
      stats = readWordStats ? readWordStats() : null;
    } catch {
      stats = null; // 語の記録が読めない: 照らし合わせずに足す
    }
    for (const [id, e] of changed) {
      const cur = same ? orig.get(id) : base[id];
      const drop =
        (isObj(cur) && (Number(cur.t) || 0) > (Number(e.t) || 0)) || // もう一方のタブが後から答えた
        (stats && (!isObj(stats[id]) || lastAnswerMs(stats[id]) < (Number(e.t) || 0))); // その答えの記録が無い（復元・消去・書けなかった）
      if (!drop) base[id] = e;
      else if (same) {
        if (cur === undefined) delete base[id];
        else base[id] = cur; // メモリーに置いた変化を、保存の値に戻す
      }
    }
    let json = serialize(base, Math.min(max, roomLeft())); // 語の記録の字数は読んだ（照らし合わせた）後に見る
    try {
      localStorage.setItem(KEY, json);
    } catch {
      // 容量: 半分まで減らしてもう一度（語の記録の書き込みの余地を残す）。それも書けなければ次の機会に
      trim(base, Math.floor(json.length / 2));
      json = JSON.stringify({ v: 1, w: base });
      localStorage.setItem(KEY, json);
    }
    mem = base;
    memRaw = json;
    changed = new Map();
    orig = new Map();
    stale = false;
    return true;
  } catch {
    return false; // 書けなかった: 変えた語は持ったまま、次の機会にもう一度
  }
}

// 手が空いたとき（答えのタスクの外）に 1 回。無ければ次のタスクに
function whenIdle(fn) {
  if (typeof requestIdleCallback === "function") requestIdleCallback(fn, { timeout: 2000 });
  else setTimeout(fn, 0);
}

// 回の終わり・10 答えごと: 答えのタスクの外で書く（入力完了から次の問題までに保存の JSON 化を入れない）
export function scheduleMemoryWordsFlush() {
  if (flushQueued || changed.size === 0) return;
  flushQueued = true;
  whenIdle(() => {
    if (flushQueued) flushMemoryWords();
  });
}

// 答えごとに書き手（js/stats.js）が呼ぶ。10 答えごとに書く
export function tickMemoryWords() {
  answers++;
  if (answers >= ANSWERS_PER_FLUSH) {
    answers = 0;
    scheduleMemoryWordsFlush();
  }
}

// 出題のとき（js/stats.js recordPlay）: まだ読んでいなければ、手が空いたときに読んでおく（最初の答えのタスクで保存を JSON から戻さない）
export function prefetchMemoryWords() {
  if ((mem && !stale) || prefetchQueued) return;
  prefetchQueued = true;
  whenIdle(() => {
    prefetchQueued = false;
    try {
      load();
    } catch {
      // 読めなければ答えのときにもう一度
    }
  });
}

// 保存を直に書き換えた所（バックアップの復元・端末の記録を消す。js/backup.js）が呼ぶ。メモリーの中身と書きかけを捨てる
export function forgetMemoryWords() {
  mem = null;
  memRaw = null;
  changed = new Map();
  orig = new Map();
  answers = 0;
  stale = false;
  flushQueued = false;
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("pagehide", () => flushMemoryWords());
  // 裏に回った: その場で書く（手が空くのを待たない。裏のタブは pagehide なしで捨てられうる。PR #172 のレビュー 2）
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushMemoryWords();
    });
  }
  // 別のタブが書いた・消した（復元・端末の記録を消す）: 次に使うときに読み直す（このタブの書きかけは上に重ねる）
  window.addEventListener("storage", (e) => {
    if (e.key === null || e.key === KEY) stale = true;
  });
}
