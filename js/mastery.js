// ===== 単語ごとの習熟度（段）の規則（純関数） =====
// DOM なし・localStorage なし。import は js/retentionCalc.js だけ（Node から直に import して確かめる: scripts/test-mastery.mjs）。
// 段を書くのは js/stats.js の書き手（recordRecallSuccess・recordRecallFail）だけ。画面はここの rankOf・rankHtml・rankBasis・rankNext で読むだけ
// （stat を書き換えない）。速さの基準と確かめの集計は js/masteryMeta.js。定義は docs/SPEC_MASTERY.md（§3）。
//
// 段: 0 = 答えの記録が無い（出さない）、1 まだ・2 あやふや・3 思い出せる・4 身についた・5 即答。
// 記録: word_stats[id].masteryRank（1〜5）と masteryAt（段を決めた答えの時刻。書いた lastRecall*At と同じ文字列）。
// どちらも端末だけの欄（js/sync.js statToRow は送らない）。欄が無い語は initialRank で読む（書かない）。

import { localDay, dayDiff, shiftDay } from "./retentionCalc.js";

export const RANK_MAX = 5;
export const SOLID_GAP_DAYS = 6; // 身についた: 前の答えから 6 日以上あけたノーミス正解
export const TOP_GAP_DAYS = 20; // 即答: 前の答えから 20 日以上あけて、本人の基準よりすぐ打てたノーミス正解
export const KNOWN_CHECK_DAYS = 14; // 知ってた語の最初の確認（初見の 2 週間後）
export const MIN_GAP_MS = 6 * 60 * 60 * 1000; // 前の答えから 6 時間未満は、日付をまたいでも同じ日の扱い

export const RANK_NAMES = ["", "まだ", "あやふや", "思い出せる", "身についた", "即答"];

// 段ごとの短い説明（学習データの行にだけ出す）。どの入り方を通っても真になる文だけ
export const RANK_GLOSS = [
  "",
  "思い出せなかったまま",
  "思い出せたが、確かではない",
  "間違えずに思い出せた",
  "6日以上あけて思い出せた（初めてで、すぐ打てた語も）",
  "2週間以上あけて、すぐ打てた"
];

// 規則の文（学習データの注記と、語の詳細の畳んだ「習熟度の決まり」）
export const RANK_RULE =
  "日をあけて間違えずに思い出せると 1 段上がる（1 日に 1 段まで）。身についた には前の答えから 6日、即答 には 20日あけて すぐ打てることが要る。初めて答えて間違えずに打てた語は 思い出せる（すぐなら 身についた）から始まり、2週間後の確認で すぐ打てると 即答。思い出せなかった日は 1 段下がる。時間がたつだけでは下がらない。";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ms = (iso) => Date.parse(iso ?? "") || 0;

// ===== 語の状態 =====

// 答えの記録がある（自力正解・思い出せず・習得・知ってたのどれか）。出題だけの語は false
export function answered(s) {
  return !!(s && (s.lastRecallSuccessAt || s.lastRecallFailAt || s.mastered || s.knownOnSight));
}

// 未解決（最後の × が最後の自力正解より新しい）。js/studyQueue.js isUnresolved と同じ 4 行（ここは retentionCalc 以外を import しない）
export function isUnresolved(stat) {
  if (!stat?.lastRecallFailAt) return false;
  if (!stat.lastRecallSuccessAt) return true;
  return Date.parse(stat.lastRecallFailAt) > Date.parse(stat.lastRecallSuccessAt);
}

// 初見の判定（知ってたを立てる条件）: まだ一度も答えていない。出題の回数（playCount）は見ない
// （出題だけされて答えなかった語 — Challenge・60 秒の時間切れ・途中で離れた — も、次の最初の答えで知ってたになれる）。
// 仕様の 3 条件（自力正解・思い出せずの日時が無く、recallFail 0）に、段 0（answered が偽）と同じ意味にそろえる守りを足す:
// 習得・知ってた・ノーミス連続のある語は初見と読まない（日時の欄ができる前 — schema 5 より前 — の記録で、
// 日時が無いまま習得・連続正解を持つ語の streak を 1 に戻さない。今の書き手は、この 3 つを立てる答えで日時も同じタスクの中で書く）
export function isFirstAnswer(stat) {
  return (
    !!stat &&
    !stat.lastRecallSuccessAt &&
    !stat.lastRecallFailAt &&
    (stat.recallFail ?? 0) === 0 &&
    !stat.mastered &&
    !stat.knownOnSight &&
    (stat.cleanCorrectStreak ?? 0) === 0
  );
}

// 知ってた語（初見でノーミス正解し、そのあと一度も思い出せなかったことが無い）。題箋の「知ってた」（js/categoryProgress.js）は習得の語を除くが、ここは問わない
export function isKnownWord(stat) {
  return !!stat && stat.knownOnSight === true && (stat.recallFail ?? 0) === 0;
}

// 確認待ちの知ってた語（初見の日のあと、別の日の答えがまだ無い）。
// streak 1 だけでは、打ち間違いありの正解（Battle）で streak 0 になり、別の日のノーミスで 1 に戻った語と見分けられない（§3.3 の
// knownCheck は streak 0 の正解が一度でもあれば偽）。初見の知ってたは期日を 14 日後に置き、同じ日の答えは期日を動かさない。
// 別の日の答えがあると期日は streak の間隔（1〜2 日）に戻る。そこで、期日と最後の自力正解の両方があり、期日が最後の自力正解から
// 13 日未満なら確認待ちでない（期日は同期する欄なので 2 台目でも同じに読める）。期日・自力正解の日時が無い古い行は streak だけで読む
export function isKnownWaiting(stat) {
  if (!isKnownWord(stat) || (stat.cleanCorrectStreak ?? 0) !== 1) return false;
  const due = ms(stat.nextReviewAt);
  const okAt = ms(stat.lastRecallSuccessAt);
  return !(due > 0 && okAt > 0 && due - okAt < (KNOWN_CHECK_DAYS - 1) * 86400000);
}

function hasRankField(s) {
  return Number.isInteger(s?.masteryRank) && s.masteryRank >= 1 && s.masteryRank <= RANK_MAX;
}

// ===== 1 回の答えの文脈 =====
// stat は答える前の記録（○ は recordCorrect の前、× は recordRecallFail の書く前）。nowMs は Date.now() の値。
// 返り値:
//   today       今のローカル日 "YYYY-MM-DD"
//   prevAt      前の答えの時刻（ms。max(lastRecallSuccessAt, lastRecallFailAt)）。無ければ null
//   prevDay     そのローカル日。無ければ null
//   sameDay     同じ日の扱い（同じローカル日・6 時間未満・日の差が 1 未満や数でない＝時計の戻り）
//   gap         sameDay でないときだけ日の差（整数日）。ほかは null
//   firstOfDay  その日の最初の答え（prevDay があり sameDay でない）。段が上がる・速さを基準に入れる・確かめに数えるのはこの答えだけ
//   firstAnswer 初めての答え（prevDay が無く段 0）
//   unknownDays 日数が分からない答え（prevDay が無いのに段がある古い行）
//   failedToday 今日もう × がある（答える前の lastRecallFailAt が同じ日の扱い）
//   rank        答える前の段（rankOf）
//   known       知ってた語か
//   knownCheck  知ってた語の最初の確認か（isKnownWaiting: 知ってた語で streak 1、期日が最後の自力正解から 13 日以上先）
export function answerContext(stat, nowMs = Date.now()) {
  const s = stat ?? {};
  const okAt = ms(s.lastRecallSuccessAt);
  const failAt = ms(s.lastRecallFailAt);
  const last = Math.max(okAt, failAt);
  const prevAt = last > 0 ? last : null;
  const today = localDay(new Date(nowMs));
  const prevDay = prevAt === null ? null : localDay(new Date(prevAt));
  let sameDay = false;
  let gap = null;
  if (prevDay !== null) {
    const d = dayDiff(prevDay, today);
    sameDay = prevDay === today || nowMs - prevAt < MIN_GAP_MS || !(d >= 1);
    if (!sameDay) gap = d;
  }
  const failedToday = failAt > 0 && (localDay(new Date(failAt)) === today || nowMs - failAt < MIN_GAP_MS);
  const rank = rankOf(s);
  const known = isKnownWord(s);
  return {
    today,
    prevAt,
    prevDay,
    sameDay,
    gap,
    firstOfDay: prevDay !== null && !sameDay,
    firstAnswer: prevDay === null && rank === 0,
    unknownDays: prevDay === null && rank >= 1,
    failedToday,
    rank,
    known,
    knownCheck: isKnownWaiting(s)
  };
}

// ===== 段の動き =====
// r = 答える前の段（○ は recordCorrect が控えた rankBefore、× は書く前の rankOf）
// a = { ok, clean, speed }（speed: "fast" | "normal" | "slow" | "unknown"）
// c = answerContext の値（prevDay・sameDay・gap・failedToday）＋ knownCheck
export function nextRank(r, a, c) {
  const rank = clampRank(r);
  if (c.prevDay === null && rank === 0) {
    // 初めての答え
    if (!a.ok) return 1;
    if (!a.clean) return 2;
    return a.speed === "fast" ? 4 : 3; // 遅くても 3（遅さは 2 週間後の確認で見る）
  }
  const from = Math.max(1, rank); // 記録のある語の段は 1 以上（rankOf がそう返す。崩れた引数でも 0 を書かない）
  if (!a.ok) return c.failedToday ? from : Math.max(1, from - 1); // × はその日の最初の 1 回だけ 1 段（○ との順は問わない）
  if (c.prevDay === null || c.sameDay) return from <= 1 ? 2 : from; // 日数が分からない・同じ日の ○: まだ → あやふや だけ
  if (!a.clean) return Math.max(from, 2); // 打ち間違いあり（Battle）は 2 より上げない。正解で下げない
  if (c.knownCheck && (from === 3 || from === 4) && c.gap >= KNOWN_CHECK_DAYS) return a.speed === "fast" ? 5 : 4;
  if (from === 5) return a.speed === "slow" ? 4 : 5; // 遅い答えのまま「即答」と言わない
  const e = c.gap >= TOP_GAP_DAYS && a.speed === "fast" ? 5 : c.gap >= SOLID_GAP_DAYS ? 4 : 3;
  return e > from ? from + 1 : from; // 1 日 1 段
}

function clampRank(r) {
  const n = Math.trunc(Number(r));
  return Number.isFinite(n) ? Math.min(RANK_MAX, Math.max(0, n)) : 0;
}

// ===== 読み方 =====

// 端末の history（直近 8 件の { d, r }）に「6 日以上あいた ○」（○ とその前の項目の日の差が 6 以上）があるか
function hasSolidGap(h) {
  return h.some((e, i) => i > 0 && e?.r === "o" && dayDiff(h[i - 1]?.d, e?.d) >= SOLID_GAP_DAYS);
}

// 段の欄が無い語の初期値（読むたびに計算し、書かない。次に答えたとき書き手がこの値を起点に更新して保存する）。控えめに読む:
// 即答にしない。6 日あけた証拠が無ければ身についたにしない（history が 2 件未満で判断できない語は 4 のまま）
export function initialRank(s) {
  if (!answered(s)) return 0;
  const streak = s.cleanCorrectStreak ?? 0;
  const h = Array.isArray(s.history) ? s.history : [];
  const solidOr4 = () => (h.length < 2 || hasSolidGap(h) ? 4 : 3);
  if (isKnownWord(s)) {
    if (streak >= 2) return solidOr4();
    // streak 1（確認待ち）。knownOnSight だけの種（streak が無い・0）も「まだ」にしない。
    // streak 0 は初見のあとの打ち間違いありの正解（Battle）だが、書き手でも 3 から下げない（nextRank の非 clean の枝）ので同じ 3
    return 3;
  }
  if (isUnresolved(s)) {
    if (s.masteredAt) return 3;
    const lastX = h.map((e) => e?.r).lastIndexOf("x");
    const okDays = new Set(h.slice(0, Math.max(lastX, 0)).filter((e) => e?.r === "o").map((e) => e.d));
    return okDays.size >= 2 ? 2 : 1;
  }
  if (!s.lastRecallSuccessAt && !s.mastered) return 1;
  if (s.mastered || streak >= 6) return solidOr4();
  if (streak >= 2) return 3;
  return 2;
}

// 今の段。欄があればそれ（この端末の段が見ていない × がある — 古い版・2 台目で答えた — ときは、読むときだけ 1 段下げる。書かない）
export function rankOf(s) {
  if (!answered(s)) return 0;
  if (hasRankField(s)) {
    const unseenFail = ms(s.lastRecallFailAt) > ms(s.masteryAt);
    return unseenFail && isUnresolved(s) ? Math.max(1, s.masteryRank - 1) : s.masteryRank;
  }
  return initialRank(s);
}

// ===== 見た目 =====
// 目盛り 5 つ＋名前。段 0 は空文字。見出しに「習熟度」がある所は label: ""（読み上げで重ねない）。
// title は単語帳のカードの根拠の文（rankBasis）。CSS は css/brand.css の .rank（全ページが読む）
export function rankHtml(rank, { name = true, label = "習熟度 ", title = "" } = {}) {
  const r = clampRank(rank);
  if (r === 0) return "";
  const n = RANK_NAMES[r];
  const titleAttr = title ? ` title="${esc(title)}"` : "";
  return `<span class="rank" data-rank="${r}" role="img" aria-label="${esc(`${label}${n}（5段のうち${r}）`)}"${titleAttr}><i></i><i></i><i></i><i></i><i></i>${name ? `<span class="rank__name">${n}</span>` : ""}</span>`;
}

// ===== 語ごとの根拠と次の条件の文（語の詳細・単語帳の title） =====

// "YYYY-MM-DD" → "M月D日"
function mdOf(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd ?? "");
  return m ? `${Number(m[2])}月${Number(m[3])}日` : "";
}

function dayOfIso(iso) {
  return ms(iso) > 0 ? localDay(new Date(ms(iso))) : null;
}

function prevDayOf(s) {
  const last = Math.max(ms(s?.lastRecallSuccessAt), ms(s?.lastRecallFailAt));
  return last > 0 ? localDay(new Date(last)) : null;
}

// その語の事実だけを返す（段ごとの決まり文句で経緯を言わない）。上から最初に当たる枝。段 0 は空文字。
// today は今のローカル日（"YYYY-MM-DD"。今は使わない。rankNext と呼び方をそろえる）
export function rankBasis(stat, today = localDay(new Date())) {
  const s = stat;
  const r = rankOf(s);
  if (r === 0) return "";
  if (!hasRankField(s)) {
    const last = mdOf(prevDayOf(s));
    return `これまでの記録から決めた仮の段${last ? `（最後の答え ${last}）` : ""}`;
  }
  if (isUnresolved(s)) {
    const d = mdOf(dayOfIso(s.lastRecallFailAt));
    return `${d ? `${d}は` : ""}思い出せなかった`;
  }
  const okDay = dayOfIso(s.lastRecallSuccessAt);
  const okMd = mdOf(okDay);
  if (isKnownWaiting(s) && (r === 3 || r === 4)) {
    return `${okMd ? `${okMd}に` : ""}初めて答えて、${r === 4 ? "すぐ打てた" : "間違えずに打てた"}`;
  }
  // N 日あけて: history の最後の o（日が lastRecallSuccessAt の日と同じ）とその前の項目の日の差。0・足りないときは括弧ごと省く
  const h = Array.isArray(s.history) ? s.history : [];
  const lastO = h.map((e) => e?.r).lastIndexOf("o");
  let gapText = "";
  if (okDay && lastO >= 1 && h[lastO]?.d === okDay) {
    const n = dayDiff(h[lastO - 1]?.d, okDay);
    if (n >= 1) gapText = `（${n}日あけて）`;
  }
  return `${okMd ? `${okMd}に` : ""}思い出せた${gapText}`;
}

// 次の段の条件。段 5・段 0 は空文字。日付は前の答えの日から数え、今日以前なら「次に」と言う。
// 前の答えの日が分からない古い行は日付を言わず「N日以上あけて」と言う（次の答えでは上がらず、その答えから数え直すため）
export function rankNext(stat, today = localDay(new Date())) {
  const s = stat;
  const r = rankOf(s);
  if (r === 0 || r >= RANK_MAX) return "";
  if (r === 1) return "自力で思い出せると あやふや";
  const prevDay = prevDayOf(s);
  const after = (days, unknown) => {
    if (!prevDay) return unknown;
    const d = shiftDay(prevDay, days);
    return d && d > today ? `${mdOf(d)}以降に` : "次に";
  };
  if (isKnownWaiting(s) && (r === 3 || r === 4)) {
    const checkDay = dayOfIso(s.nextReviewAt) ?? (prevDay ? shiftDay(prevDay, KNOWN_CHECK_DAYS) : null);
    // 確認の日が過ぎている（まだ答えていない）ときは「次の確認で」（過ぎた日付を約束の形で言わない）
    const when = checkDay && checkDay > today ? `${mdOf(checkDay)}の確認で` : "次の確認で";
    return `${when} すぐ打てると 即答`;
  }
  if (r === 2) return `${after(1, "日をあけて")} 間違えずに思い出せると 思い出せる`;
  if (r === 3) return `${after(SOLID_GAP_DAYS, `${SOLID_GAP_DAYS}日以上あけて`)} 間違えずに思い出せると 身についた`;
  return `${after(TOP_GAP_DAYS, `${TOP_GAP_DAYS}日以上あけて`)} すぐ打てると 即答`;
}

// ===== 期日前に出さない（S6） =====
// 補充の既習（js/studyQueue.js pickFillers）・息抜き（insertBreather）・ミッションの復習（js/mission.js pickReviewWords）から外す語:
//   (a) 段 4 以上で nextReviewAt が未来、(b) 確認待ちの知ってた語（知ってた語で streak 1、nextReviewAt が未来。段に関係なく）。
//   includeRank3（ミッションだけ）: 段 3 で nextReviewAt が未来の語も外す（missCount > 0 の語は期日を見ずに毎日出るので、
//   段 3 のまま gap 1 が続いて習得に届き、6 日休む機会が無い）。
//   苦手（未解決。最後が ×）は外さない: Study の × は答えを見た打ち直し（recordCorrect の非 clean の枝）で期日が翌日になるので、
//   期日では判断しない（§6 S4「× の後、期日は今」・L5 の苦手の語を毎日見直すミッションの役目を変えない）
export function holdBeforeDue(stat, nowMs = Date.now(), { includeRank3 = false } = {}) {
  if (!stat || isUnresolved(stat)) return false; // 苦手（最後が ×）は出す。Study の × は打ち直しで期日が翌日になるので、期日では判断しない
  const due = ms(stat.nextReviewAt);
  if (!(due > nowMs)) return false;
  if (isKnownWaiting(stat)) return true;
  const r = rankOf(stat);
  return r >= 4 || (includeRank3 && r === 3);
}
