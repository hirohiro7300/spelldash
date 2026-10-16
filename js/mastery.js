// ===== 単語ごとの習熟度（段）の規則（純関数） =====
// DOM なし・localStorage なし。import は js/retentionCalc.js と js/html.js だけ（どちらも DOM なし。Node から直に import して確かめる: scripts/test-mastery.mjs）。
// 段を書くのは js/stats.js の書き手（recordRecallSuccess・recordRecallFail）だけ。画面はここの rankOf・rankHtml・rankBasis・rankNext で読むだけ
// （stat を書き換えない）。速さの基準と確かめの集計は js/masteryMeta.js。定義は docs/SPEC_MASTERY.md（§3。復習の間隔とのつなぎは §6）。
//
// 段: 0 = 答えの記録が無い（出さない）、1 まだ・2 あやふや・3 思い出せる・4 身についた・5 即答。
// 記録: word_stats[id].masteryRank（1〜5）と masteryAt（段を決めた答えの時刻。書いた lastRecall*At と同じ文字列）。
// どちらも端末だけの欄（js/sync.js statToRow は送らない）。欄が無い語は initialRank で読む（書かない）。
// 端末だけの欄はほかに 4 つ: masteryDownAt（その日の × で段を下げた答えの時刻。同じ日の ○ で戻さない。rankNext の段 1 の文も読む）・answerSeenAt（別解を打って
// 答えの綴りを見た時刻。初見と読まない）・masteryPeak（1 打ミスの × で下がる前の段。M1。Batch 70）と masteryPeakAt（その控えを置いた × の時刻。PR #180 のレビュー 1。
// どちらも masteryPeakOf で読む）。どれも js/stats.js の書き手だけが書く。

import { localDay, dayDiff, shiftDay, mdOf } from "./retentionCalc.js"; // mdOf（"YYYY-MM-DD" → "M月D日"）は js/recallSpeed.js と同じ関数（PR #180 のレビュー 6）
import { esc } from "./html.js";

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

// 規則の文（学習データの注記と、語の詳細の畳んだ「習熟度の決まり」）。打ち間違いで下がった段の戻り方（M1。Batch 70）は isSlipFail の × の言い直し
// （1 打ずつ打つ道の 3 字目から〔p ≥ 2〕か隣のキー〔a〕。遅い答えでは戻らない・Battle の × は入らないことは文に入れない。docs/SPEC_MASTERY.md §3.5）
export const RANK_RULE =
  "日をあけて間違えずに思い出せると 1 段上がる（1 日に 1 段まで）。身についた には前の答えから 6日、即答 には 20日あけて すぐ打てることが要る。初めて答えて間違えずに打てた語は 思い出せる（すぐなら 身についた）から始まり、2週間後の確認で すぐ打てると 即答。思い出せなかった日は 1 段下がる。3字目からの打ち間違いか 隣のキーの押し間違いで下がった段は、翌日から 間違えずに思い出せると 1 日 1 段ずつ戻る。時間がたつだけでは下がらない。";

const ms = (iso) => Date.parse(iso ?? "") || 0;
const DAY_MS = 86400000;

// ===== 語の状態 =====

// 答えの記録がある（自力正解・思い出せず・習得・知ってたのどれか）。出題だけの語は false
export function answered(s) {
  return !!(s && (s.lastRecallSuccessAt || s.lastRecallFailAt || s.mastered || s.knownOnSight));
}

// 未解決（最後の × が最後の自力正解より新しい）。定義はここ 1 か所（js/studyQueue.js はこれを import して export し直す）
export function isUnresolved(stat) {
  if (!stat?.lastRecallFailAt) return false;
  if (!stat.lastRecallSuccessAt) return true;
  return Date.parse(stat.lastRecallFailAt) > Date.parse(stat.lastRecallSuccessAt);
}

// 答えの綴りを見たことがある語: 答えを見た後の打ち直し（別解を打った後の打ち直しも。recordCorrect が correctCount を足す）があるか、
// 別解を打って答えを見た印（answerSeenAt。打ち直す前に時間切れ・離れた語）がある。答え表示・ヒントは × の日時が残るのでここでは見ない
function sawAnswer(stat) {
  return (stat?.correctCount ?? 0) >= 1 || ms(stat?.answerSeenAt) > 0;
}

// 初見の判定（知ってたを立てる条件）: まだ一度も答えておらず、答えの綴りも見ていない。出題の回数（playCount）は見ない
// （出題だけされて答えなかった語 — Challenge・60 秒の時間切れ・途中で離れた — も、次の最初の答えで知ってたになれる）。
// 仕様の 3 条件（自力正解・思い出せずの日時が無く、recallFail 0）に、段 0（answered が偽）と同じ意味にそろえる守りを足す:
// 習得・知ってた・ノーミス連続のある語は初見と読まない（日時の欄ができる前 — schema 5 より前 — の記録で、
// 日時が無いまま習得・連続正解を持つ語の streak を 1 に戻さない。今の書き手は、この 3 つを立てる答えで日時も同じタスクの中で書く）。
// 答えの綴りを見た語（sawAnswer）も初見と読まない（別解を打つと答えを見せ、× を記録せず、打ち直しは答えに数えないので、
// 日時の欄が空のまま残る。翌日のノーミスを「知ってた」にしない）
export function isFirstAnswer(stat) {
  return (
    !!stat &&
    !stat.lastRecallSuccessAt &&
    !stat.lastRecallFailAt &&
    (stat.recallFail ?? 0) === 0 &&
    !stat.mastered &&
    !stat.knownOnSight &&
    (stat.cleanCorrectStreak ?? 0) === 0 &&
    !sawAnswer(stat)
  );
}

// 期日が最後の自力正解から 13 日以上先か（知ってたの初見の答えが置く 14 日後の期日の形）。期日・自力正解の日時のどちらかが無ければ null（読めない）。
// knownWaitingShape（真のときだけ形）と isKnownWaiting（偽のときだけ確認待ちでない。読めない古い行は streak だけで読む）が使う
function dueFarFromLastOk(s) {
  const due = ms(s?.nextReviewAt);
  const okAt = ms(s?.lastRecallSuccessAt);
  if (!(due > 0 && okAt > 0)) return null;
  return due - okAt >= (KNOWN_CHECK_DAYS - 1) * DAY_MS;
}

// 確認待ちの形（同期する欄だけで読む）: streak 1・recallFail 0・最後の自力正解があり、期日が最後の自力正解から 13 日以上先。
// 書き手がこの形を作るのは知ってたの初見の答え（期日 14 日後）だけ（js/stats.js extendInterval は、答えの後が streak 1・recallFail 0 になる
// 答えの間隔を伸ばさない）。knownOnSight は端末だけの欄で 2 台目には届かない（js/sync.js rowToStat）ので、2 台目はこの形で知ってた語と読む
function knownWaitingShape(s) {
  if ((s?.cleanCorrectStreak ?? 0) !== 1 || (s.recallFail ?? 0) !== 0) return false;
  return dueFarFromLastOk(s) === true;
}

// 知ってた語（初見でノーミス正解し、そのあと一度も思い出せなかったことが無い）。印（knownOnSight）が無くても確認待ちの形なら知ってた語
// （2 台目）。題箋の「知ってた」（js/categoryProgress.js）は印だけで読み、習得の語を除くが、ここは問わない
export function isKnownWord(stat) {
  if (!stat || (stat.recallFail ?? 0) !== 0) return false;
  return stat.knownOnSight === true || knownWaitingShape(stat);
}

// 確認待ちの知ってた語（初見の日のあと、別の日の答えがまだ無い）。
// streak 1 だけでは、打ち間違いありの正解（Battle）で streak 0 になり、別の日のノーミスで 1 に戻った語と見分けられない（§3.3 の
// knownCheck は streak 0 の正解が一度でもあれば偽）。初見の知ってたは期日を 14 日後に置き、同じ日の答えは期日を動かさない。
// 別の日の答えがあると期日は streak の間隔（1〜2 日）に戻る。そこで、期日と最後の自力正解の両方があり、期日が最後の自力正解から
// 13 日未満なら確認待ちでない。期日・自力正解の日時が無い古い行は streak だけで読む。
// 2 台目（knownOnSight が届かない）では isKnownWord が確認待ちの形で読むので、同じ語が同じに読める（期日・自力正解・streak・recallFail は同期する欄）
export function isKnownWaiting(stat) {
  if (!isKnownWord(stat) || (stat.cleanCorrectStreak ?? 0) !== 1) return false;
  return dueFarFromLastOk(stat) !== false;
}

function hasRankField(s) {
  return Number.isInteger(s?.masteryRank) && s.masteryRank >= 1 && s.masteryRank <= RANK_MAX;
}

// ===== 1 打ミスで下がった段の控え（M1。Batch 70。docs/SPEC_MASTERY.md §3.5） =====
// 指の滑りと見る ×: history の 1 件（js/stats.js pushHistory。r "x" と × の細目 k・p・a・c）が 1 打ミス（k "m"）で、3 字目以降（打てていた字数 2 以上）か
// 隣のキー（a が真）。a は 1 打ずつ判定する道（綴り・ローマ字）だけが真偽で渡す。全文入力の違う答え（a なし）は綴りを丸ごと打った答えなので入れない
// （build と打った building も p 5 になる）。答え表示・ヒント・パス・不明（Battle・Batch 68 より前の記録）も入れない
export const SLIP_MIN_TYPED = 2;
export function isSlipFail(e) {
  if (!e || e.r !== "x" || e.k !== "m" || typeof e.a !== "boolean") return false;
  const n = typedCharsOf(e);
  return e.a || (n !== null && n >= SLIP_MIN_TYPED);
}

// × の前に打てていた字数（3 字目かどうかを見る数。PR #180 のレビュー 3）。ローマ字の答えの 1 打ミスは打ち終えたかなの字数 c（js/game.js が渡す。
// きゃ は 2 字。p は受理したキーの数で、しんぶん の s・h の後の誤りも p 2 になる）、綴りの答えは p（受理した字の数。c は渡さない）。読めなければ null。
// isSlipFail と記録の質の xNext の種類（js/stats.js prevDayFailKind の m2）が使う
export function typedCharsOf(e) {
  const n = Number.isInteger(e?.c) ? e.c : e?.p;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// 今使える控えの段（無ければ 0）。控えは書き手が置き直す・消すが、読むときも次を確かめる（古い版・2 台目が控えを知らずに書いた記録で戻しすぎない）:
//   段の欄があり、控えが今の段より上の整数（RANK_MAX まで）・この端末の段が最後の × を見ている（lastRecallFailAt ≤ masteryAt）・
//   控えを置いた × の時刻 masteryPeakAt が最後の × の時刻 lastRecallFailAt と同じ（控えの後に × が無い。2 台目・古い版の × は lastRecallFailAt を変える。
//   時刻は文字列でなく ms で比べる）。history は見ない（8 件までなので、控えの後に 8 回答えると × が押し出される。PR #180 のレビュー 1）。
//   masteryPeakAt の無い控え（PR #180 の版が書いた形）だけは、history の最後の × が指の滑りかで読む（次の答えで書き手が masteryPeakAt を書き足す）
export function masteryPeakOf(stat) {
  const s = stat;
  if (!hasRankField(s)) return 0;
  const peak = s.masteryPeak;
  if (!Number.isInteger(peak) || peak <= s.masteryRank || peak > RANK_MAX) return 0;
  const failAt = ms(s.lastRecallFailAt);
  if (failAt > ms(s.masteryAt)) return 0;
  if (s.masteryPeakAt != null) return failAt > 0 && ms(s.masteryPeakAt) === failAt ? peak : 0;
  const h = Array.isArray(s.history) ? s.history : [];
  for (let i = h.length - 1; i >= 0; i--) if (h[i]?.r === "x") return isSlipFail(h[i]) ? peak : 0;
  return 0;
}

// ===== 同じ日の扱い =====
// 時刻 t（ms）の出来事が、今（nowMs。そのローカル日 today）から見て同じ日の扱いか: ローカル日が今日か、6 時間未満（時計が戻って先に見える時刻も）。
// answerContext の failedToday・downToday と、語の詳細の次の条件（rankNext の段 1）が使う（答えの判定と文を食い違わせない）
function sameDayAs(t, nowMs, today = localDay(new Date(nowMs))) {
  return t > 0 && (localDay(new Date(t)) === today || nowMs - t < MIN_GAP_MS);
}

// 今日の × で段を下げた語か（masteryDownAt が同じ日の扱い）。同じ日の ○ では上げない（nextRank）
function downTodayOf(s, nowMs, today) {
  return sameDayAs(ms(s?.masteryDownAt), nowMs, today);
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
//   sawAnswer   答えの綴りを見たことがある（答えを見た後の打ち直し・別解の印。日時の欄は空のまま）
//   firstAnswer 初めての答え（prevDay が無く段 0 で、答えの綴りも見ていない）
//   unknownDays 日数が分からない答え（prevDay が無いのに段がある古い行）
//   failedToday 今日もう × がある（答える前の lastRecallFailAt が同じ日の扱い）
//   downToday   今日の × で段を下げた（答える前の masteryDownAt が同じ日の扱い）。同じ日の ○ で戻さない
//   rank        答える前の段（rankOf）
//   known       知ってた語か
//   knownCheck  知ってた語の最初の確認か（isKnownWaiting: 知ってた語で streak 1、期日が最後の自力正解から 13 日以上先）
//   peak        1 打ミスで下がる前の段の控え（masteryPeakOf。無ければ 0）。nextRank が戻す上限・書き手が置き直す起点
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
  const failedToday = sameDayAs(failAt, nowMs, today);
  const rank = rankOf(s);
  const known = isKnownWord(s);
  const saw = sawAnswer(s);
  return {
    today,
    prevAt,
    prevDay,
    sameDay,
    gap,
    firstOfDay: prevDay !== null && !sameDay,
    sawAnswer: saw,
    firstAnswer: prevDay === null && rank === 0 && !saw,
    unknownDays: prevDay === null && rank >= 1,
    failedToday,
    downToday: downTodayOf(s, nowMs, today),
    rank,
    known,
    knownCheck: isKnownWaiting(s),
    peak: masteryPeakOf(s)
  };
}

// ===== 段の動き =====
// r = 答える前の段（○ は recordCorrect が控えた rankBefore、× は書く前の rankOf）
// a = { ok, clean, speed }（speed: "fast" | "normal" | "slow" | "unknown"）
// c = answerContext の値（prevDay・sameDay・gap・failedToday・sawAnswer・downToday・peak）＋ knownCheck
export function nextRank(r, a, c) {
  const rank = clampRank(r);
  if (c.prevDay === null && rank === 0 && !c.sawAnswer) {
    // 初めての答え（答えの綴りを見た語は通らない: 別解の後の答えは下の「日数が分からない」枝で 1・2）
    if (!a.ok) return 1;
    if (!a.clean) return 2;
    return a.speed === "fast" ? 4 : 3; // 遅くても 3（遅さは 2 週間後の確認で見る）
  }
  const from = Math.max(1, rank); // 記録のある語の段は 1 以上（rankOf がそう返す。崩れた引数でも 0 を書かない）
  if (!a.ok) return c.failedToday ? from : Math.max(1, from - 1); // × はその日の最初の 1 回だけ 1 段（○ との順は問わない）
  // 日数が分からない・同じ日の ○: まだ → あやふや だけ。今日の × で下げた語（2 → 1）は戻さない（思い出せなかった日は 1 段下がる。翌日以降の規則で上がる）
  if (c.prevDay === null || c.sameDay) return from <= 1 && !c.downToday ? 2 : from;
  if (!a.clean) return Math.max(from, 2); // 打ち間違いあり（Battle）は 2 より上げない。正解で下げない
  const n = steadyRank(from, a, c);
  // M1（Batch 70）: 1 打ミスの × で下がった段（控え c.peak）は、翌日以降のノーミス・遅くない答えで控えまで 1 日 1 段（6 日・20 日・すぐの条件なし）
  const peak = Number.isInteger(c.peak) ? Math.min(RANK_MAX, c.peak) : 0;
  return peak > from && a.speed !== "slow" ? Math.max(n, from + 1) : n;
}

// 別の日のノーミス正解（今の規則）
function steadyRank(from, a, c) {
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

function dayOfIso(iso) {
  return ms(iso) > 0 ? localDay(new Date(ms(iso))) : null;
}

function prevDayOf(s) {
  const last = Math.max(ms(s?.lastRecallSuccessAt), ms(s?.lastRecallFailAt));
  return last > 0 ? localDay(new Date(last)) : null;
}

// ===== 日数の文（数え方は 1 つ。Batch 68 L1-6） =====
// 盤面の上「N日ぶりの復習」・正解の後の「N日ぶりでも思い出せた」（js/game.js）・語の詳細「（N日あけて）」（rankBasis）は、どれも
// 前の答え（○ でも × でも）のローカル日から今の答えのローカル日までの暦日の差。24 時間の切り捨て・UTC で読んだ日付・四捨五入は使わない
// （前日 23 時の答えを翌日 9 時に答えても 1 日）。前の答えが無い・同じ日・時計が戻って前の答えが先に見えるときは 0（文に日数を出さない）
export function daysBetween(prevDay, day) {
  const n = dayDiff(prevDay, day);
  return n >= 1 ? n : 0;
}

// 答える前の stat の、前の答えから today までの日数（盤面の上と正解の後の文）。前の答えは answerContext の prevAt と同じ
// （max(lastRecallSuccessAt, lastRecallFailAt)。同じ端末では history の最後の項目と同じ日）
export function daysSinceAnswer(stat, today = localDay(new Date())) {
  return daysBetween(prevDayOf(stat), today);
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
  // N 日あけて: history の最後の o（日が lastRecallSuccessAt の日と同じ）とその前の項目（前の答え）の日の差（daysBetween。盤面の上・正解の後の文と
  // 同じ数え方）。0・足りないときは括弧ごと省く
  const h = Array.isArray(s.history) ? s.history : [];
  const lastO = h.map((e) => e?.r).lastIndexOf("o");
  let gapText = "";
  if (okDay && lastO >= 1 && h[lastO]?.d === okDay) {
    const n = daysBetween(h[lastO - 1]?.d, okDay);
    if (n) gapText = `（${n}日あけて）`;
  }
  return `${okMd ? `${okMd}に` : ""}思い出せた${gapText}`;
}

// 次の段の条件。段 5・段 0 は空文字。日付は前の答えの日から数え、今日以前で、今が前の答えと同じ日の扱いでない（sameDayAs: ローカル日が同じか 6 時間未満。
// answerContext の sameDay と同じ判定）なら「次に」と言う。同じ日の扱いの間は日付のまま（23:30 の答えを翌 1:00 に見ると、今の答えでは上がらないので
// 「（前の答えの日＋1）以降に」。6 時間たてば「次に」。PR #180 のレビュー 2）。
// 前の答えの日が分からない古い行は日付を言わず「N日以上あけて」と言う（次の答えでは上がらず、その答えから数え直すため）
// 段 1 は同じ日の ○ でも上がるので日付なし。ただし今日の × で下げた語は、その扱いが続く間の ○ では上がらない（nextRank）ので、
// 下げた日＋1 日を言う（§11.6 の 5）。「今日下げた」は answerContext の downToday と同じ判定（downTodayOf: ローカル日が今日か 6 時間未満）で見る
// （23 時に下げた語を 1 時に見ても「下げた日＋1 日以降に」。§11.7 の 4）。nowMs は today と同じ時点（既定はどちらも今）
export function rankNext(stat, today = localDay(new Date()), nowMs = Date.now()) {
  const s = stat;
  const r = rankOf(s);
  if (r === 0 || r >= RANK_MAX) return "";
  const prevAt = Math.max(ms(s?.lastRecallSuccessAt), ms(s?.lastRecallFailAt));
  const prevDay = prevAt > 0 ? localDay(new Date(prevAt)) : null; // prevDayOf と同じ
  const after = (days, unknown) => {
    if (!prevDay) return unknown;
    const d = shiftDay(prevDay, days);
    return d && (d > today || sameDayAs(prevAt, nowMs, today)) ? `${mdOf(d)}以降に` : "次に";
  };
  if (r === 1) {
    if (!downTodayOf(s, nowMs, today)) return "自力で思い出せると あやふや";
    const d = shiftDay(dayOfIso(s.masteryDownAt), 1); // 時計が戻って下げた日が先に見えるときも、その日＋1 日
    return `${d ? `${mdOf(d)}以降に` : "日をあけて"} 自力で思い出せると あやふや`;
  }
  // 1 打ミスの × で下がった段（M1。控えが使える語: masteryPeakOf）は、前の答えの翌日以降のノーミス・遅くない答えで 1 段戻る（6 日・20 日・すぐの条件なし。
  // nextRank の M1 の枝と同じ）。段 2 の文は今の規則と同じになる
  if (r >= 2 && masteryPeakOf(s) > r) return `${after(1, "日をあけて")} 間違えずに思い出せると ${RANK_NAMES[r + 1]}`;
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

// ===== 題箋と段が食い違って見える組（語の詳細。Batch 64 M4。呼び名の表は docs/SPEC_MASTERY.md 付録 E） =====
// 題箋（js/categoryProgress.js classifyWord の 未着手／苦手／覚えた／習得／知ってた）は「何が起きたか」、段は「どれだけ強いか」で、別の物差し。
// 並べて矛盾に見える組（苦手＋思い出せる以上・覚えた＋あやふや以下・習得＋思い出せる以下・知ってた＋あやふや以下）にだけ、題箋の意味と
// 「習熟度とは別の物差し」を 1 文で添える。ほかの組・段 0 は空文字。status は classifyWord の値（weak・learning・mastered・known・untouched）
export const STATUS_SCALE_NOTE = {
  weak: "苦手 は最後の答えで思い出せなかった語の印で、習熟度とは別の物差し。",
  learning: "覚えた は最後の答えで自力で思い出せた語の印で、習熟度とは別の物差し。",
  mastered: "習得 は別の日に10回続けて間違えずに打てた語の印で、習熟度とは別の物差し。",
  known: "知ってた は初めて見て打てた語の印で、習熟度とは別の物差し。"
};

export function statusScaleNote(status, rank) {
  const r = clampRank(rank);
  if (r === 0) return "";
  const odd =
    (status === "weak" && r >= 3) ||
    ((status === "learning" || status === "known") && r <= 2) ||
    (status === "mastered" && r <= 3);
  return odd ? STATUS_SCALE_NOTE[status] : "";
}

// ===== 期日前に出さない（S6） =====
// 補充の既習（js/studyQueue.js pickFillers）・息抜き（insertBreather）・ミッションの復習（js/mission.js pickReviewWords）から外す語:
//   (a) 段 4 以上で nextReviewAt が未来、(b) 知ってた語（isKnownWord: 印 knownOnSight か 2 台目の確認待ちの形）で、まだ一度も × が無く、
//   nextReviewAt が未来（段・streak に関係なく）。確認待ち（streak 1）の語だけにすると、14 日の確認の前に Challenge などで正解した語が
//   streak 2 で外れ、S1 で期日は 14 日目のまま残るのに、6〜13 日目の補充に毎日出ていた（§11.7 の 2）。
//   includeRank3（ミッションだけ）: 段 3 で nextReviewAt が未来の語も外す（missCount > 0 の語は期日を見ずに毎日出るので、
//   段 3 のまま gap 1 が続いて習得に届き、6 日休む機会が無い）。
//   苦手（未解決。最後が ×）は外さない: Study の × は答えを見た打ち直し（recordCorrect の非 clean の枝）で期日が翌日になるので、
//   期日では判断しない（§6 S4「× の後、期日は今」・L5 の苦手の語を毎日見直すミッションの役目を変えない）
export function holdBeforeDue(stat, nowMs = Date.now(), { includeRank3 = false } = {}) {
  if (!stat || isUnresolved(stat)) return false; // 苦手（最後が ×）は出す。Study の × は打ち直しで期日が翌日になるので、期日では判断しない
  const due = ms(stat.nextReviewAt);
  if (!(due > nowMs)) return false;
  if (isKnownWord(stat) && !ms(stat.lastRecallFailAt)) return true; // 知ってた語で × が一度も無い（recallFail 0 は isKnownWord が見る）
  const r = rankOf(stat);
  return r >= 4 || (includeRank3 && r === 3);
}

// ===== 復習の間隔とのつなぎ（段階 2。§6 の S1〜S3） =====
// 書くのは js/stats.js（S1 は recordCorrect、S2・S3 は recordRecallSuccess）。REVIEW_INTERVAL_DAYS・streak・習得・isReviewDue は変えない。
// S2 の credit は gap 6 以上（SOLID_GAP_DAYS。日をあけたと言える答え）だけ。期日には前の答えの時刻が付き、Study の復習は回を始めた時点で
// 期日が来た語だけを積むので、毎日ほぼ同じ時刻に学ぶ人でも 1 日遅れ（gap ＝ 間隔 + 1）はふつうに起きる。間隔 1・2 の段は表の隣と
// 1 日しか違わず、gap 2 → 3・gap 3 → 5 と表を 1 段飛ばして戻らない（保持率の 7 日窓にも問われなくなる）。間隔 5 以上の段は
// 1 日遅れても表で gap より長い最初の値が streak の次の間隔と同じなので、予定どおり・1 日遅れの人の間隔は今と同じ（1→2→3→5→7→10→14→21→30）。

// 復習の間隔の表（連続ノーミス正解数 → 次の復習までの日数）。ここ 1 か所に置き、js/stats.js の REVIEW_INTERVAL_DAYS はこれを指す
export const SRS_STEPS = Object.freeze([1, 2, 3, 5, 7, 10, 14, 21, 30]);
export const MAX_INTERVAL_DAYS = 30; // S2・S3 で伸ばす上限（表の最後の値）
export const RANK_FLOOR_DAYS = { 4: 7, 5: 30 }; // S3: 段ごとの下限（身についた 7 日・即答 30 日）
// M1'（Batch 70）: 段の下限をかける前の答えからの日数。即答の 30 日は 14 日以上あけた答え（知ってた語の確認と同じ日数）だけ。短いときは 1 段下の下限
// （身についたの 7 日。M1 で戻った翌日・期日前の答え・打ち間違いありの正解の翌日に、× の翌日の正解 1 回から 30 日あけない）
export const RANK_FLOOR_GAP_DAYS = Object.freeze({ 5: KNOWN_CHECK_DAYS });

// S2・S3: 日をあけた正解の後の間隔（日）。伸ばすだけで、streakDays より短くしない。
//   streakDays = recordCorrect が streak から決めた日数（streak が進まなかった答えは 0。知ってた語の初見は 14）
//   gap        = 前の答えからの日数（answerContext の gap。同じ日の扱い・初めての答えは null）
//   rank       = 答えた後の段（S3 の下限）
//   speed      = "fast" | "normal" | "slow" | "unknown"
// gap が数でない・1 未満（初めての答え・同じ日の扱い。dayDiff(null, …) の NaN で 30 日にしない）と slow は credit も下限も無し（streakDays のまま）。
// それ以外は、gap 6 以上なら credit = 表で gap より長い最初の値（無ければ 30。gap 6 未満は credit なし: 1 日遅れで表を飛ばさない）、
// 段 4 は 7 日（gap 1 から）・段 5 は 30 日（gap 14 から。gap 13 までは段 4 の 7 日。M1'）を下限に、どちらも 30 日まで。
// ノーミスか・その日の最初の答えかは呼ぶ側（stats.js）が見る（打ち間違いありの正解は recordCorrect が期日を翌日にする。§6 S1 の例外）
export function intervalAfter({ streakDays = 0, gap = null, rank = 0, speed = "unknown" } = {}) {
  const base = Number.isFinite(streakDays) && streakDays > 0 ? streakDays : 0;
  if (typeof gap !== "number" || !Number.isFinite(gap) || gap < 1 || speed === "slow") return base;
  const credit = gap >= SOLID_GAP_DAYS ? SRS_STEPS.find((d) => d > gap) ?? MAX_INTERVAL_DAYS : 0;
  const r = clampRank(rank);
  const floor = (gap >= (RANK_FLOOR_GAP_DAYS[r] ?? 0) ? RANK_FLOOR_DAYS[r] : RANK_FLOOR_DAYS[r - 1]) ?? 0;
  return Math.max(base, Math.min(MAX_INTERVAL_DAYS, Math.max(credit, floor)));
}

// S3 の下限に使う段の上限: この端末の段が見ていない × がある語（lastRecallFailAt が masteryAt より後。2 台目・古い版で答えた）は 1 段下。
// rankOf が下げるのは未解決の間だけなので、2 台目で × → Recall Loop と進んだ語は段 5 のまま読め、翌日のノーミスが 30 日の下限に飛ぶ
// （同じ端末なら × で段 4 に下がり 7 日）。段の欄が無い語は null（initialRank が控えめに読むので下げない）。書く段・見える段は変えない
export function unseenFailCap(stat) {
  if (!hasRankField(stat)) return null;
  return ms(stat.lastRecallFailAt) > ms(stat.masteryAt) ? Math.max(1, stat.masteryRank - 1) : null;
}

// S1: 正解で期日を早めない。前の期日 prevIso が今より先で、新しい期日 nextIso より後ならそれを残す。
// 前の期日が過ぎている・無い・読めないときは新しい方（nextIso）。nextIso が読めないときは前の期日を残す（どちらも読めなければ nextIso）
export function keepLaterDue(prevIso, nextIso, nowMs = Date.now()) {
  const prev = ms(prevIso);
  const next = ms(nextIso);
  if (!next) return prev ? prevIso : nextIso;
  return prev > nowMs && prev > next ? prevIso : nextIso;
}
