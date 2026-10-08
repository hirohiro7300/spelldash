// ===== 記憶の保持率の集計（純関数） =====
// import なし・DOM なし・localStorage なし。Node から直接 import して検証する（scripts/test-retention.mjs）。
// 記録の書き手は js/retentionLog.js・js/studyTime.js、画面は js/retention.js、定義は docs/SPEC_RETENTION.md。
//
// 語ごとの記録: { f: 初回の自力正解の ISO, d: 最後に数えた回答日 "YYYY-MM-DD", n: 復習した日数,
//                w7?: { t, r: "o"|"x", rv }, w30?: { t, r, rv } }（w7／w30 は窓に入って最初の回答。rv はその前の復習日数）
// 日の計算はすべてローカル日（js/stats.js localDateString と同じ単位）の差（整数日）。

export const WINDOW_7 = [6, 8]; // 覚えた日から +6〜+8 日
export const WINDOW_30 = [27, 33]; // +27〜+33 日
const EFFICIENCY_LAG_DAYS = 7; // 学習時間は「7 日前まで」の日を分母にする（直近 7 日の語はまだ測れないため）

// ローカル日 "YYYY-MM-DD"。読めない日時は null
export function localDay(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parts(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof ymd === "string" ? ymd : "");
  return m ? [Number(m[1]), Number(m[2]) - 1, Number(m[3])] : null;
}

// 2 つのローカル日の差（整数日）。UTC の暦で引くので夏時間の切り替え日でも 1 日は 1 日
export function dayDiff(fromYmd, toYmd) {
  const a = parts(fromYmd);
  const b = parts(toYmd);
  if (!a || !b) return NaN;
  return Math.round((Date.UTC(b[0], b[1], b[2]) - Date.UTC(a[0], a[1], a[2])) / 86400000);
}

export function shiftDay(ymd, days) {
  const p = parts(ymd);
  if (!p) return null;
  const d = new Date(Date.UTC(p[0], p[1], p[2] + days));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function emptyWindow() {
  return { none: { ok: 0, n: 0 }, some: { ok: 0, n: 0 }, measured: 0, unmeasured: 0, pending: 0 };
}

// 1 語を 1 つの窓に数える。
//   回答あり → 復習なし（rv=0）／復習あり（rv≥1）に分けて数える（measured）
//   回答なし → 到達前（dd < 下限）は数えない／窓の中（測定中 pending）／窓を過ぎた（未測定 unmeasured）
function tally(win, answer, dd, [lo, hi]) {
  if (answer && (answer.r === "o" || answer.r === "x")) {
    const bucket = (Number(answer.rv) || 0) >= 1 ? win.some : win.none;
    bucket.n++;
    if (answer.r === "o") bucket.ok++;
    win.measured++;
    return;
  }
  if (!(dd >= lo)) return;
  if (dd <= hi) win.pending++;
  else win.unmeasured++;
}

// records: spelldash_retention の中身、secondsByDay: spelldash_study_time の中身、today: "YYYY-MM-DD"
// 返り値: { d7, d30, retained, hours, perHour, since }
//   d7／d30 = { none: {ok, n}, some: {ok, n}, measured, unmeasured, pending }
//   retained = 7 日後に思い出せた語の数（復習の有無を問わない）
//   hours    = today − 7 日 までの学習時間（時間）、perHour = retained ÷ hours（hours が 0 なら null）
//   since    = いちばん早い f のローカル日（記録が無ければ today）
export function computeRetention(records, secondsByDay, { today } = {}) {
  const todayKey = parts(today) ? today : localDay(new Date());
  const d7 = emptyWindow();
  const d30 = emptyWindow();
  let retained = 0;
  let since = null;

  const list = records && typeof records === "object" ? Object.values(records) : [];
  for (const rec of list) {
    if (!rec || typeof rec !== "object") continue;
    const t0 = localDay(rec.f);
    if (!t0) continue;
    if (!since || t0 < since) since = t0;
    const dd = dayDiff(t0, todayKey);
    tally(d7, rec.w7, dd, WINDOW_7);
    tally(d30, rec.w30, dd, WINDOW_30);
    if (rec.w7?.r === "o") retained++;
  }

  const cutoff = shiftDay(todayKey, -EFFICIENCY_LAG_DAYS);
  let seconds = 0;
  if (secondsByDay && typeof secondsByDay === "object") {
    for (const [day, sec] of Object.entries(secondsByDay)) {
      if (parts(day) && day <= cutoff && Number.isFinite(sec) && sec > 0) seconds += sec;
    }
  }
  const hours = seconds / 3600;
  const perHour = hours > 0 ? retained / hours : null;

  return { d7, d30, retained, hours, perHour, since: since ?? todayKey };
}
