// ===== 思い出す速さ（語ごと。純関数） =====
// DOM なし・localStorage なし。import は js/retentionCalc.js だけ（DOM なし。Node から直に import して確かめる: scripts/test-recall.mjs）。
// 材料は書き手（js/stats.js noteSpeedRecord）が端末だけのキー spelldash_memory_words の語ごとの欄 sp に残した直近 3 件
//   [日番号, T1(ms), q(%) または null, 分類 "f"|"n"|"s"|"u", 印]
// （材料 (a): 初めての答えか、前の答え〔○ でも × でも〕から 3 暦日以上あいたその日の最初の答えで、ノーミス・測れた答え。一度に 2 字以上・置き換えの入力・
// 1 打目の前に盤面の外へ移った答え・T1 が 200ms 未満と 30 秒超は入っていない）。画面（語の詳細・単語帳・学習データ）はここで読むだけ（記録を書き換えない）。
// 速さは段にも間隔にも使わない（見せるだけ）。定義は docs/SPEC_MASTERY.md（Batch 70）・D1 §1.3・§3。
//
// 出す語: 段 2〜4（段 5 は名前の「即答」に速さが入る。段 1 は「思い出せなかった」が先）・材料 2 件以上・訳（品詞の札と括弧の中を除く）が 8 字未満。
// 語の値: q（T1 ÷ 本人の基準 × 100）の中央値。q ≤ 75 → すぐ、q > 150 → 時間がかかる、ほか → ふつう（js/masteryMeta.js classifySpeed の
// FAST_RATIO 0.75・SLOW_RATIO 1.5 と同じ境）。q が 1 件も無い（基準がまだ無かった）ときは、最後の材料の分類が「すぐ」（初めての答えの既定の線）ならすぐ、
// ほかは出さない。

import { dayDiff, shiftDay } from "./retentionCalc.js";

export const SPEED_FAST_Q = 75; // q がこれ以下で「すぐ」（FAST_RATIO 0.75 × 100）
export const SPEED_SLOW_Q = 150; // q がこれを超えると「時間がかかる」（SLOW_RATIO 1.5 × 100）
export const SPEED_MIN_RECORDS = 2; // 材料が 2 件から出す（1 件の間は出さない）
export const SPEED_MAX_PROMPT = 8; // 訳が 8 字以上の語は出さない（訳を読む時間の補正が決まるまで）
export const SPEED_OLD_DAYS = 90; // 最後の材料が 90 日より前なら「（M月D日まで）」を添える
export const SPEED_RANK_MIN = 2;
export const SPEED_RANK_MAX = 4;

// 画面の語（「遅い」とは書かない）
export const SPEED_LABEL = Object.freeze({ fast: "すぐ", normal: "ふつう", slow: "時間がかかる" });

// 秒の注記（語の詳細の畳んだ「速さの記録」の中だけ）
export const SPEED_LOG_NOTE = "出題から1打目まで。訳を読む時間を含む。この端末";

const DAY_ZERO = "1970-01-01"; // 日番号の 0（js/stats.js と同じ。1970-01-01 からのローカル暦日の数）

// 問いの字数（js/game.js promptLength と同じ数え方: 括弧〔「（略語）」など〕の中を除いた字数。コードポイント）。品詞の札はラベルにあるので入らない
export function promptChars(text) {
  return [...String(text ?? "").replace(/[（(][^）)]*[）)]/g, "").trim()].length;
}

// 日番号 ⇄ "YYYY-MM-DD"
export function dayNoOf(ymd) {
  const n = dayDiff(DAY_ZERO, ymd);
  return Number.isInteger(n) ? n : null;
}
export function ymdOfDayNo(n) {
  return Number.isInteger(n) ? shiftDay(DAY_ZERO, n) : null;
}

// "YYYY-MM-DD" → "M月D日"
function mdOf(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd ?? "");
  return m ? `${Number(m[2])}月${Number(m[3])}日` : "";
}

function medianOf(list) {
  const a = [...list].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// sp の 1 件が形の合う材料 (a) の件か（日番号は整数・T1 は 0 以上の数・q は数か null・分類は文字・印は材料 a のビットが立った整数）
function validEntry(e) {
  return (
    Array.isArray(e) &&
    Number.isInteger(e[0]) &&
    Number.isFinite(e[1]) &&
    e[1] >= 0 &&
    (e[2] === null || Number.isFinite(e[2])) &&
    typeof e[3] === "string" &&
    Number.isInteger(e[4]) &&
    (e[4] & 1) === 1
  );
}

// q の値（数の件だけ）から語の速さ。q が 1 件も無ければ、最後の材料の分類が「すぐ」ならすぐ、ほかは null
export function speedOfRecords(records) {
  const list = Array.isArray(records) ? records.filter(validEntry) : [];
  if (list.length === 0) return null;
  const qs = list.map((e) => e[2]).filter((q) => Number.isFinite(q));
  if (qs.length === 0) return list[list.length - 1][3] === "f" ? "fast" : null;
  const q = medianOf(qs);
  return q <= SPEED_FAST_Q ? "fast" : q > SPEED_SLOW_Q ? "slow" : "normal";
}

// 語の速さの分類だけ（"fast"|"normal"|"slow"、出さない語は null。単語帳・学習データの数え上げ用）。決まりは recallSpeedOf と同じで、
// 配列を並べ替えず・日付の文字を作らない（2,000 語の単語帳を描くたびに全部の語で呼ぶため。最後の材料 = 日番号のいちばん大きい件、同じ日なら後ろの件）。
// 安い条件から見る: 段 → 件数 → 形の合う件 2 件以上 → 訳の字数
export function recallSpeedClass({ sp, rank, prompt } = {}) {
  if (!Number.isInteger(rank) || rank < SPEED_RANK_MIN || rank > SPEED_RANK_MAX) return null;
  if (!Array.isArray(sp) || sp.length < SPEED_MIN_RECORDS) return null;
  let n = 0;
  let lastDay = -Infinity;
  let lastCls = null;
  const qs = [];
  for (const e of sp) {
    if (!validEntry(e)) continue;
    n++;
    if (e[0] >= lastDay) {
      lastDay = e[0];
      lastCls = e[3];
    }
    if (Number.isFinite(e[2])) qs.push(e[2]);
  }
  if (n < SPEED_MIN_RECORDS || promptChars(prompt) >= SPEED_MAX_PROMPT) return null;
  if (qs.length === 0) return lastCls === "f" ? "fast" : null;
  const q = medianOf(qs);
  return q <= SPEED_FAST_Q ? "fast" : q > SPEED_SLOW_Q ? "slow" : "normal";
}

// 語の思い出す速さ。出さない語は null。
//   sp     spelldash_memory_words の語ごとの欄 sp（無い・形の違う値は材料 0 件）
//   rank   今の段（js/mastery.js rankOf）
//   prompt 見せている問い（js/wordStore.js promptOf: 場面の文があればそれ、無ければ訳）
//   today  今日のローカル日 "YYYY-MM-DD"
// 返り値 { speed: "fast"|"normal"|"slow", label, n: 材料の件数, last: 最後の材料の日 "YYYY-MM-DD", old: 最後の材料が 90 日より前か,
//         records: [{ day: "YYYY-MM-DD", ms: T1 }]（新しい順。秒は語の詳細の畳んだ記録の中だけで出す） }
export function recallSpeedOf({ sp, rank, prompt, today } = {}) {
  if (!Number.isInteger(rank) || rank < SPEED_RANK_MIN || rank > SPEED_RANK_MAX) return null;
  if (promptChars(prompt) >= SPEED_MAX_PROMPT) return null;
  const list = (Array.isArray(sp) ? sp.filter(validEntry) : []).slice().sort((a, b) => a[0] - b[0]);
  if (list.length < SPEED_MIN_RECORDS) return null;
  const speed = speedOfRecords(list);
  if (!speed) return null;
  const lastNo = list[list.length - 1][0];
  const last = ymdOfDayNo(lastNo);
  const todayNo = dayNoOf(today);
  return {
    speed,
    label: SPEED_LABEL[speed],
    n: list.length,
    last,
    old: todayNo !== null && todayNo - lastNo > SPEED_OLD_DAYS,
    records: list
      .slice()
      .reverse()
      .map((e) => ({ day: ymdOfDayNo(e[0]), ms: Math.round(e[1]) }))
  };
}

// 語の詳細の行の文（見出し「思い出す速さ」の後ろ）: 「ふつう ・ 最近 3 回の答えから」。最後の材料が 90 日より前なら「（8月3日まで）」を添える
export function recallSpeedText(rs) {
  if (!rs) return "";
  return `${rs.label} ・ 最近 ${rs.n} 回の答えから${rs.old && rs.last ? `（${mdOf(rs.last)}まで）` : ""}`;
}

// 語の詳細の畳んだ「速さの記録」の 1 行: 「10月3日 1.4秒 ・ 9月26日 1.2秒（出題から1打目まで。訳を読む時間を含む。この端末）」（新しい順）
export function recallSpeedLog(rs) {
  if (!rs || !rs.records?.length) return "";
  const items = rs.records.map((r) => `${mdOf(r.day)} ${(Math.round(r.ms / 100) / 10).toFixed(1)}秒`); // 0.1 秒に四捨五入（1,450ms は 1.5 秒）
  return `${items.join(" ・ ")}（${SPEED_LOG_NOTE}）`;
}

// 単語帳の「詳しく」の足元・簡潔表示の title に添える語: 「すぐ」「時間がかかる」の 2 つだけ（「ふつう」は出さない）。ほかは空文字。
// 引数は recallSpeedOf の返り値か、recallSpeedClass の分類（文字）
export function recallSpeedTag(rs) {
  const speed = typeof rs === "string" ? rs : rs?.speed;
  return speed === "fast" || speed === "slow" ? SPEED_LABEL[speed] : "";
}
