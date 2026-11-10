import { localDateString } from "./stats.js";
import { touchItem } from "./userItemsSync.js";
import { getWordStats, learnStateSource } from "./storage.js";
import { countLearnStates, learnStateOf, LEARN_LEARNED, LEARN_NEW } from "./learnState.js";
import { dayNoOf, ymdOfDayNo } from "./retentionCalc.js";

// ===== 成長ログ =====
// 1日1行 {date, learned, mastered, active} を端末に残し、
// 「今週 +N語」「30日の推移」「学習日数 x/7」の材料にする（最大120日）。
// 学習記録そのものではなく派生値のスナップショット。失っても学習には影響しない。
// ログイン中は 1 日分を user_items の day 項目として端末間で合わせる（js/userItemsSync.js。変わった日だけ touchItem）。
//
// 覚えた の増え（Batch 90。docs/SPEC_LEARN_STATE.md §12）: 行に端末だけの欄を足した。送らない（日の行の中身は learned・mastered・active・set・sets のまま）。
//   core   その日の終わり（その日の最後に書いたとき）の 覚えた。学習状況の最初の画面と同じ数（3 状態。公開の語だけ: js/learnState.js countLearnStates）。
//          数・null（見たが分からない日: ほかの端末から来た語を持つ端末の、この端末の始まりより前の日。もう見ない）・無い（まだ見ていない）
//   core0  この端末で数え始めた最初の行だけ。その日の始まりの 覚えた（前の日の終わり）。一度入れたら替えない
//   cb     core を測ったときの 前からの 覚えた（tallyCore の base）。書いた後は替えない。読み手が「今の base − 行の cb」を正でも負でも足して読む
//   nf     書いたときの「その日に初めて覚えた語の数」（印 lsf がその日で、今 覚えた）。回の途中で閉じた日の後の分を、次の書き込みでその日に戻す
// 週間レポート・今月の行・推移・カレンダーは core を読む（getCore*）。learned・mastered は前の数え方のまま書き続ける（古いタブとほかの端末の古い版が読む）。
// 前の読み手（getLearnedDelta7・getMonthLearnedDelta・getLearnedSeries）は旗を外したときのホームのカードと単体のために残す

const KEY = "spelldash_growth_log";
const MAX_DAYS = 120;

export function getGrowthLog() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function save(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX_DAYS)));
  } catch {
    // 端末容量等で失敗しても学習は止めない
  }
}

// 今日の行を最新値で上書き（無ければ追加）。active は一度trueになったら保持
// v2（2026-10）: learned は「覚えた語の数」（パックの語も含む、js/learnedWords.js getLearnedCount）。
// それ以前の行は基本カテゴリだけの数だったので、最初の v2 を書くときに legacyLearned（同じ日の旧式の数）との差で
// 古い行を底上げし、推移が段差にならないようにする（近似。失っても学習には影響しない）
// legacyLearned は数でも関数でもよい（旧式の数は v1 の行を直す初回だけ要るので、関数なら必要なときだけ呼ぶ）
export function recordGrowthSnapshot({ learned, mastered, active = false, legacyLearned = null }) {
  const list = getGrowthLog();
  const today = localDateString();
  const legacy = list.length > 0 && !list.some((e) => e.v === 2) ? (typeof legacyLearned === "function" ? legacyLearned() : legacyLearned) : null;
  if (legacy != null) {
    const offset = learned - legacy;
    if (offset !== 0) for (const e of list) e.learned = Math.max(0, (e.learned ?? 0) + offset);
  }
  const idx = list.findIndex((e) => e.date === today);
  const prev = idx >= 0 ? list[idx] : null;
  const row = { date: today, learned, mastered, active: !!(prev?.active || active), v: 2 };
  // core: 公開の語の表が読めていれば（learnStateSource）今の数と 前からの 覚えた を書く。読めていなければ前の値を写すだけ（0 を書かない・下げない）
  const src = learnStateSource();
  const table = src ? getWordStats() : null;
  const t = src ? tallyCore(table, src) : null;
  if (t) {
    row.core = t.learned;
    row.cb = t.base;
    if (Number.isInteger(prev?.core0)) row.core0 = prev.core0;
  } else {
    for (const key of ["core", "core0", "cb", "nf"]) if (Number.isInteger(prev?.[key])) row[key] = prev[key];
  }
  if (idx >= 0) list[idx] = row;
  else list.push(row);
  list.sort((a, b) => (a.date < b.date ? -1 : 1));
  if (t) {
    fillCoreRows(list, today, t.learned, src, table);
    noteFirstLearned(list, today, row, src, table);
    for (const e of list) if (Number.isInteger(e?.core) && !Number.isInteger(e.cb)) e.cb = t.base; // 数え直した行も今の値で測った扱い
  }
  save(list);
  // 描画のたびに呼ばれるので、同期の印は「クラウドの値（大きい方で合わせる）を上げうる」ときだけ付ける。
  // 語数が減った（覚えた語が苦手に戻った）だけなら送らない（送っても合わせると元の値に戻り、送り直しを繰り返すため）。
  // core・core0・cb・nf は送らない欄なので、それだけが変わっても付けない
  if (legacy != null || !prev || row.learned > (prev.learned ?? 0) || row.mastered > (prev.mastered ?? 0) || (row.active && !prev.active)) touchItem("day", today);
  return row;
}

// 1 回の走査で 覚えた（learned）と 前からの 覚えた（base）を数える。前からの 覚えた = 覚えた で印 lsf の無い語（移行・同期の初めの埋め・版 6 の式で
// 覚えた になり、まだ中心の学習で答えていない語）＋ 印が 0 の語で あやふや か 覚えた の語（前から覚えていた語に中心の学習で答えた。あやふや に戻っても数えたまま）。
// 前からの語が外れても覚え直しても base は変わらない（増えるのは埋めと移行のときだけ）。外れは learned の減りとして学習状況と同じに見える
function tallyCore(table, src) {
  let learned = 0;
  let base = 0;
  for (const id of src.vocab.order) {
    const s = table?.[id];
    const st = learnStateOf(s, src.pending?.get(id));
    if (st === LEARN_LEARNED) learned++;
    if ((st === LEARN_LEARNED && s?.lsf === undefined) || (s?.lsf === 0 && st !== LEARN_NEW)) base++;
  }
  return { learned, base };
}

// core の無い前の日の行（切り替えの前の行・旧いタブが作り直した行・ほかの端末から届いた行）に、語ごとの「初めて覚えた日」lsf から数え直した値を入れる（一度だけ）。
// 値 = 今の 覚えた − （今 覚えた で lsf がその日より後の語）。lsf の無い 覚えた の語（移行・埋め）は初めから覚えていた扱い。
// ほかの端末から来た語（答えの記録 history の無い あやふや・覚えた の公開の語。同期の初めの埋めの形）を持つ端末だけ、この端末の始まり
// （history の最も古い日と lsf の最も古い日の早い方）より前の行を null にする（数えない日。週と今月は「–」）。1 台だけの人の行は null にしない。
// 数え始めた最初の行（core が数の最初の行。その前は null だけ）には、その日の始まりの値 core0 も同じ式で一度だけ入れる
function fillCoreRows(list, today, coreNow, src, table) {
  let missing = false;
  for (const e of list) if (e && e.date < today && e.core === undefined) { missing = true; break; }
  const first = list.find((e) => Number.isInteger(e?.core));
  if (!missing && !(first && first.core0 === undefined)) return;
  let histStart = null;
  let lsfStart = null;
  const dated = [];
  for (const id in table) {
    const s = table[id];
    if (!s || typeof s !== "object") continue;
    const h = Array.isArray(s.history) ? s.history[0]?.d : null;
    if (typeof h === "string" && (histStart === null || h < histStart)) histStart = h;
    const f = Number.isInteger(s.lsf) && s.lsf > 0 ? s.lsf : null;
    if (f === null) continue;
    if (lsfStart === null || f < lsfStart) lsfStart = f;
    if (src.vocab.isPublic(id) && learnStateOf(s, src.pending?.get(id)) === LEARN_LEARNED) dated.push(f);
  }
  let foreign = false;
  for (const id of src.vocab.order) {
    const s = table?.[id];
    if (s && learnStateOf(s, src.pending?.get(id)) !== LEARN_NEW && !(Array.isArray(s.history) && s.history.length > 0)) {
      foreign = true;
      break;
    }
  }
  const lsfYmd = lsfStart === null ? null : ymdOfDayNo(lsfStart);
  const start = histStart === null ? lsfYmd : lsfYmd === null || histStart < lsfYmd ? histStart : lsfYmd;
  dated.sort((a, b) => a - b);
  const at = (dayNo) => {
    let lo = 0;
    let hi = dated.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dated[mid] <= dayNo) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(0, coreNow - (dated.length - lo));
  };
  if (missing) {
    for (const e of list) {
      if (!e || !(e.date < today) || e.core !== undefined) continue;
      const d = !foreign || (start !== null && e.date >= start) ? dayNoOf(e.date) : null;
      e.core = Number.isInteger(d) ? at(d) : null;
    }
  }
  const head = list.find((e) => Number.isInteger(e?.core));
  if (head && head.core0 === undefined && list.every((e) => e === head || !e || e.date > head.date || e.core === null)) {
    const d = dayNoOf(head.date);
    head.core0 = Number.isInteger(d) ? Math.min(head.core, at(d - 1)) : head.core;
  }
}

// 回の途中で閉じた日（あやふや の回の区切り・アプリを閉じた: 回の終わりの書き手が走らない）の後に覚えた語を、次の書き込みでその日に戻す。
// 今日の nf = lsf が今日で今 覚えた の語。前の行（今日より前で core のある最後の行）に nf があり、その日の lsf の 覚えた の語がそれより多ければ、
// 差だけ前の行の core を上げ、nf をその数にする（下げない。core0・cb は替えない）。lsf の日で数えるので、覚え直し（lsf 0）は前の日へ持ち込まない
function noteFirstLearned(list, today, row, src, table) {
  const tdn = dayNoOf(today);
  let last = null;
  for (const e of list) if (e && e.date < today && Number.isInteger(e.core)) last = e;
  const ldn = last ? dayNoOf(last.date) : null;
  let nToday = 0;
  let nLast = 0;
  for (const id of src.vocab.order) {
    const s = table?.[id];
    const f = s?.lsf;
    if (!Number.isInteger(f) || f <= 0 || (f !== tdn && f !== ldn)) continue;
    if (learnStateOf(s, src.pending?.get(id)) !== LEARN_LEARNED) continue;
    if (f === tdn) nToday++;
    else nLast++;
  }
  row.nf = nToday;
  if (last && Number.isInteger(last.nf) && nLast > last.nf) {
    last.core += nLast - last.nf;
    last.nf = nLast;
  }
}

export function markActiveToday() {
  const list = getGrowthLog();
  const today = localDateString();
  const idx = list.findIndex((e) => e.date === today);
  if (idx >= 0) {
    if (!list[idx].active) {
      list[idx].active = true;
      save(list);
      touchItem("day", today);
    }
    return;
  }
  const last = list[list.length - 1];
  list.push({ date: today, learned: last?.learned ?? 0, mastered: last?.mastered ?? 0, active: true, v: last?.v });
  save(list);
  touchItem("day", today);
}

function dateKeyDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return localDateString(d);
}

// ===== 週の学習日目標（月曜始まり） =====
// 「毎日」ではなく「週○日」を目標にする（罪悪感なしで続く設計）。既定4日
const WEEK_GOAL_KEY = "spelldash_week_goal";
export const WEEK_GOAL_OPTIONS = [3, 4, 5, 7];

export function getWeekGoal() {
  const v = Number(localStorage.getItem(WEEK_GOAL_KEY));
  return WEEK_GOAL_OPTIONS.includes(v) ? v : 4;
}

export function setWeekGoal(v) {
  if (WEEK_GOAL_OPTIONS.includes(Number(v))) localStorage.setItem(WEEK_GOAL_KEY, String(v));
}

// 今週（月〜日）の各日 {date, active, isToday, isFuture}
export function getThisWeekDays() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = (today.getDay() + 6) % 7; // 月曜=0
  const active = new Set(getGrowthLog().filter((e) => e.active).map((e) => e.date));
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - dow + i);
    const key = localDateString(d);
    days.push({ date: key, active: active.has(key), isToday: i === dow, isFuture: i > dow });
  }
  return days;
}

export function getActiveDaysThisWeek() {
  return getThisWeekDays().filter((d) => d.active).length;
}

// 直近7日で「学習した日」の数
export function getActiveDaysLast7(endOffset = 0) {
  // endOffset=1 なら「昨日までの 7 日」
  const since = dateKeyDaysAgo(6 + endOffset);
  const until = dateKeyDaysAgo(endOffset);
  return getGrowthLog().filter((e) => e.active && e.date >= since && e.date <= until).length;
}

// 直近7日の「覚えた」増分（7日前時点の値との差。基準が無ければ最古の行）
// endOffset=1 なら「昨日までの 7 日」（週間レポートの窓と合わせる）
export function getLearnedDelta7(currentLearned, endOffset = 0) {
  const log = getGrowthLog();
  if (log.length === 0) return 0;
  const latestOnOrBefore = (key) => [...log].reverse().find((e) => e.date <= key);
  const baseline = latestOnOrBefore(dateKeyDaysAgo(7 + endOffset)) ?? log[0];
  // 窓の終わりが昨日なら「昨日時点の値」から引く（今日の分は窓の外）。記録が無ければ今の値
  const current = endOffset > 0 ? (latestOnOrBefore(dateKeyDaysAgo(endOffset))?.learned ?? currentLearned) : currentLearned;
  return Math.max(0, current - (baseline.learned ?? 0));
}

// 日付の順に並べた行（learned のある行だけ。同期で合わせた行の並びに頼らない）
function measuredRows(log) {
  return log.filter((e) => e && typeof e.date === "string" && e.learned != null).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// 今月（ym = "YYYY-MM"）に思い出せるようになった語の増え（学習状況の詳しい記録の月の行。Batch 89）。起点は今月より前で最後の行
// （無ければ今月の最初の行）で、月の初日の増えも数える。終わりは今月の最後の行。減っていれば 0（負にしない）。描画だけで、保存は変えない
export function getMonthLearnedDelta(ym, log = getGrowthLog()) {
  const rows = measuredRows(log);
  const inMonth = rows.filter((e) => e.date.startsWith(ym));
  const last = inMonth.at(-1);
  if (!last) return 0;
  const base = rows.filter((e) => e.date < `${ym}-01`).at(-1) ?? inMonth[0];
  return Math.max(0, (last.learned ?? 0) - (base.learned ?? 0));
}

// 直近N日の系列（欠損日は直前の値で埋める）
export function getLearnedSeries(days = 30) {
  const log = getGrowthLog();
  const byDate = new Map(log.map((e) => [e.date, e]));
  const series = [];
  // 窓より前で最後の行の値から埋める（Batch 89。30 日以上空いた人も窓の頭から横の線になり、「明日から」の案内にしない）
  const start = dateKeyDaysAgo(days - 1);
  let lastLearned = measuredRows(log).filter((e) => e.date < start).at(-1)?.learned ?? null;
  for (let i = days - 1; i >= 0; i--) {
    const key = dateKeyDaysAgo(i);
    const row = byDate.get(key);
    if (row) lastLearned = row.learned;
    series.push({ date: key, learned: lastLearned, active: !!row?.active });
  }
  // 先頭の欠損は、窓より前に実測が無い限り null のまま（最初の実測値より前）
  return series;
}

// ===== 覚えた の増え（Batch 90。学習状況の詳しい記録の週間レポート・今月の行・推移・カレンダー） =====
// 数は core（学習状況の最初の画面と同じ 覚えた）。数え始める前の行（core の無い行）は読まない。端末ごとの数（3 状態は端末ごと）。
// 増えは差（正味）で、0 より小さければ 0。null は「分からない」（画面は「–」か語数を出さない）

const hasCore = (e) => Number.isInteger(e?.core);

// 読み手の行: 日付の順（同期で足した行・端末の時刻帯が西へ戻った日の行の並びに頼らない）。core と cb のある行に「今の 前からの 覚えた − 行の cb」を
// 正でも負でも足して読む（core0 にも。保存は変えない）。埋め・移行で増えた 覚えた は前からの 覚えた にも同じだけ入るので、どの 2 つの日の差にも入らない。
// 今の 前からの 覚えた は、表が読めていれば数え、読めていなければ cb のある最後の行の値（その行の差は 0）
function coreLog() {
  const log = getGrowthLog()
    .filter((e) => e && typeof e === "object" && typeof e.date === "string")
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (!log.some((e) => Number.isInteger(e.cb))) return log;
  const src = learnStateSource();
  let base = src ? tallyCore(getWordStats(), src).base : null;
  for (let i = log.length - 1; i >= 0 && base === null; i--) if (Number.isInteger(log[i].cb)) base = log[i].cb;
  return log.map((e) => {
    const lift = hasCore(e) && Number.isInteger(e.cb) ? base - e.cb : 0;
    return lift !== 0 ? { ...e, core: e.core + lift, ...(Number.isInteger(e.core0) ? { core0: e.core0 + lift } : {}) } : e;
  });
}

// 今の 覚えた（学習状況と同じ）。表が読めていなければ今日までで最後の core。どちらも無ければ null
export function getCoreNow() {
  const src = learnStateSource();
  if (src) return countLearnStates(getWordStats(), src.vocab, src.pending).learned;
  const today = localDateString();
  const log = coreLog();
  for (let i = log.length - 1; i >= 0; i--) if (log[i].date <= today && hasCore(log[i])) return log[i].core;
  return null;
}

// key の日の終わりの 覚えた: key 以前で最後の core の行。無ければ、この端末で数え始めた行の core0（その日の始まり）。
// 窓の中で数え始めた日より前に core の無い学習した日がある（ほかの端末から届いた日・数えない日）なら null
function coreAt(log, key) {
  let base = null;
  for (const e of log) {
    if (e.date > key) break;
    if (hasCore(e)) base = e;
  }
  if (base) return base.core;
  const first = log.find(hasCore);
  if (!first) return null;
  if (log.some((e) => e.active && !hasCore(e) && e.date > key && e.date < first.date)) return null;
  if (Number.isInteger(first.core0)) return first.core0;
  return log.some((e) => e.date < first.date) ? null : first.core;
}

// 7 日の増え（null = 分からない「–」）。endOffset = 1 なら昨日までの 7 日（今日まだ学んでいない朝の週間レポート）。
// 窓の中に数えない学習した日（active で core が null の行）が 1 日でもあれば null
export function getCoreDelta7(endOffset = 0) {
  const log = coreLog();
  if (log.length === 0) return 0;
  const key7 = dateKeyDaysAgo(7 + endOffset);
  const end7 = dateKeyDaysAgo(endOffset);
  if (log.some((e) => e.active && e.core === null && e.date > key7 && e.date <= end7)) return null;
  const base = coreAt(log, key7);
  if (base === null) return null;
  let current = null;
  if (endOffset > 0) {
    for (const e of log) {
      if (e.date > end7) break;
      if (hasCore(e)) current = e.core;
    }
  }
  current ??= getCoreNow();
  if (current === null) return null;
  return Math.max(0, current - base);
}

// 今月の増え（null = 分からない: 項目を出さない）。起点は今月より前で最後の core の行（月の初日の増えも数える。Batch 89 の今月の行と同じ）。
// 無ければこの端末で数え始めた行の core0。今月に数えない学習した日があれば null
export function getCoreMonthDelta(now = new Date()) {
  const first = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const ym = first.slice(0, 7);
  const log = coreLog();
  const inMonth = log.filter((e) => e.date.startsWith(ym));
  if (inMonth.length === 0) return 0;
  if (inMonth.some((e) => e.active && e.core === null)) return null;
  let base = null;
  for (const e of log) if (e.date < first && hasCore(e)) base = e.core;
  if (base === null) {
    const head = log.find(hasCore);
    if (!head) return null;
    if (log.some((e) => e.active && !hasCore(e) && e.date >= first && e.date < head.date)) return null;
    if (Number.isInteger(head.core0)) base = head.core0;
    else if (log.some((e) => e.date < head.date)) return null;
    else base = head.core;
  }
  const current = getCoreNow();
  return current === null ? null : Math.max(0, current - base);
}

// N 日の系列（推移。窓より前で最後の core から埋める〔Batch 89 と同じ起点〕・core の無い日は前の値・最初の core より前は null）。
// 今日の点は今の 覚えた（学習状況と同じ数で終わる）
export function getCoreSeries(days = 30) {
  const log = coreLog();
  const byDate = new Map(log.map((e) => [e.date, e]));
  const startKey = dateKeyDaysAgo(days - 1);
  let last = null;
  for (const e of log) if (e.date < startKey && hasCore(e)) last = e.core;
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = dateKeyDaysAgo(i);
    const row = byDate.get(key);
    if (hasCore(row)) last = row.core;
    series.push({ date: key, learned: last, active: !!row?.active });
  }
  const end = series.at(-1);
  if (end && end.learned !== null) end.learned = getCoreNow() ?? end.learned;
  return series;
}

// カレンダー: 学習した日 → その日に増えた 覚えた（前の core の行との差。数え始めた行は core0 から。分からない日は null。0 未満は 0）
export function getCoreDayGains() {
  const out = new Map();
  let prev = null;
  for (const e of coreLog()) {
    const has = hasCore(e);
    if (has && prev === null && Number.isInteger(e.core0)) prev = e.core0;
    if (e.active) out.set(e.date, { gained: has && prev !== null ? Math.max(0, e.core - prev) : null });
    if (has) prev = e.core;
  }
  return out;
}
