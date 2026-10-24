// ===== 一冊を終えるまでの目安（学習データ「今週」タブの 1 枚。Batch 76） =====
// 冊（カテゴリ・「すべて」・マイ単語帳）ごとに、その冊を机にした Study の回で「初めて済みになった語」の数を日ごとに、この端末だけに残す
// （spelldash_book_pace。送らない・同期しない）。済み = 覚えた・習得・知ってた（js/pathView.js isRemembered と同じ。js/categoryProgress.js classifyWord が
// learning・mastered・known）。既存の記録（語ごとの最後の ○・× の日時・直近 8 件の history・保持率の f・成長ログ）からは冊ごとの日の進みを戻せないので、
// 新しく数える（創業者の決定 2026-10-24）。
//
// 鍵 spelldash_book_pace = { v: 1, at: 最後に写した日, b: { [冊 id]: { s: 記録を始めた日, p: [[日, その日に初めて済みになった語の数], ...] } } }
//   日はローカル暦日の日番号（js/retentionCalc.js dayNoOf。端末の時間帯の 0 時で区切る。ms で引かない）。p は 0 でない日だけ・直近 14 日（今日−13〜今日）だけ。
//   s は今日より後にしない。窓の中に s より前の行があれば、いちばん早い行の日にする（時計が進んでいた端末・壊れた値）。
// 数え方（創業者の決定 4・5、反証役のレビュー B1）:
//   - Study の回の始めに、机の本の語のうち一度も済みになったことの無い語（自力正解・知ってた・習得のどれも無い: neverDone）の id をメモリーに控える。
//   - 回の終わり（と回の途中で裏に回った・離れたとき・回を始め直したとき）に、そのうち今済みで、自力正解がこの回の始めより後の語の数を、
//     その本の今日の行に足す（数えた語は控えから外す。二重に足さない）。
//   - 外れて戻った語（一度済みになった語）・同期で届いた語・別の本の回・Challenge・Daily・Battle で済みになった語は数えない。× で引かない。
//   - 同期の取り込みの間（js/sync.js isPulling。読むだけ）は数えない（控えは残し、取り込みの後に数える）。時計が戻った（今日 < at）ときの写しは数えない。
// 書くのはホーム（js/main.js が語の読み込みの後に watchBookPace を動的 import で呼ぶ）だけ。答えの道（入力完了から次の問題まで）には足さない:
// 回の始めの控えは机の本の語だけ（id と 3 つの欄を見るだけ）、保存は手が空いたとき（requestIdleCallback。無ければ setTimeout）。
// 裏に回ったとき・離れるときだけ、その場で書く（裏のタブは pagehide なしで捨てられうる）。学習データのページは読むだけ。
//
// 目安（paceOf）: 残り R = 冊の語（id で重複を除く）− 済み。進み G = 直近 14 暦日の行の和。進んだ日 = 行が 1 以上の日。
//   1 日あたり = G ÷ D（D = 記録を始めてからの暦日数。今日を含む・上限 14。学習した日数で割らない）。
//   語が 0 → 出さない。R = 0 → 完了。進んだ日 ≥ 3・G > 0・日数 ≤ 365 → 「約 N 日」（N = R×D÷G の四捨五入を整数で。下限 1）。それ以外 → 待ちの文。
// 上の純な関数の import は js/retentionCalc.js（import なし）だけ。Node から直に読む（scripts/test-pace.mjs）。

import { localDay, dayNoOf } from "./retentionCalc.js";

export const PACE_KEY = "spelldash_book_pace";
export const PACE_DAYS = 14; // 窓（今日を含む暦日）・割る日数の上限
export const PACE_MIN_ACTIVE = 3; // 進んだ日がこれ以上
export const PACE_MAX_DAYS = 365; // これを超える日数は出さない
export const PACE_WAIT = "学習を続けると、完了までの目安が表示されます。";
export const PACE_DEVICE_NOTE = "この端末の記録から計算しています。";
export const PACE_COUNT_NOTE = "済み（覚えた・習得・知ってた）で数えています。";
const VERSION = 1;
const DONE_STATES = new Set(["learning", "mastered", "known"]); // js/pathView.js isRemembered と同じ

const isCount = (v) => Number.isInteger(v) && v >= 0;
const emptyBooks = () => Object.create(null); // 冊 id に "__proto__" などが来ても型を変えない

export function emptyPace() {
  return { v: VERSION, at: null, b: emptyBooks() };
}

// 今日（または date）のローカル暦日の日番号。読めない日時は null
export function todayNo(date = new Date()) {
  const ymd = localDay(date);
  return ymd ? dayNoOf(ymd) : null;
}

// 分類（js/categoryProgress.js classifyWord の値）が済みか
export function isDoneState(state) {
  return DONE_STATES.has(state);
}

// 一度も済みになったことが無い語か: 自力正解の日時が無く、知ってたでも習得でもない（済みの 3 つ〔覚えた・知ってた・習得〕は、どれもこれらの欄が無いとならない）
export function neverDone(stat) {
  return !stat || (!stat.lastRecallSuccessAt && !stat.knownOnSight && !stat.mastered);
}

// 回の始めの控え: 冊の語のうち一度も済みになったことの無い語の id
export function freshIds(ids, stats) {
  const out = new Set();
  for (const id of ids) if (neverDone(stats?.[id])) out.add(id);
  return out;
}

// 回で初めて済みになった語: 控えのうち今済み（isDone）で、自力正解の日時が回の始め（since。ms）より後の語。
// 日時で見るのは、同期で届いた別の端末の古い答えを、この回の答えと数えないため
export function gainedIds(fresh, stats, isDone, since = 0) {
  const out = [];
  for (const id of fresh) {
    const st = stats?.[id];
    if (!st || !isDone(id)) continue;
    if (Date.parse(st.lastRecallSuccessAt ?? "") >= since) out.push(id);
  }
  return out;
}

// p の行を整える: [日, 0 でない整数] だけ・同じ日は和・0 になった日は捨てる・日の昇順。lo〜hi の外は捨てる
function cleanRows(rows, lo = 0, hi = Infinity) {
  const days = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(row) || !isCount(row[0]) || !Number.isInteger(row[1]) || row[1] === 0) continue;
    if (row[0] < lo || row[0] > hi) continue;
    days.set(row[0], (days.get(row[0]) ?? 0) + row[1]);
  }
  return [...days].filter(([, n]) => n !== 0).sort((a, b) => a[0] - b[0]);
}

// 記録を始めた日: 今日より後にしない。今日までの行のいちばん早い日より後にしない。読めなければ null
export function clampStart(start, rows, today) {
  if (!isCount(start)) return null;
  let s = isCount(today) ? Math.min(start, today) : start;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (Array.isArray(row) && isCount(row[0]) && (!isCount(today) || row[0] <= today)) s = Math.min(s, row[0]);
  }
  return s;
}

// 保存の文字列（または読んだ値）→ 整えた記録。読めない・形が違う・版が違う → 空（次の写しで置き直す）。壊れた冊の行は 1 つずつ捨てる
export function readPace(raw) {
  let data = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return emptyPace();
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || data.v !== VERSION) return emptyPace();
  const out = emptyPace();
  if (isCount(data.at)) out.at = data.at;
  const books = data.b && typeof data.b === "object" && !Array.isArray(data.b) ? data.b : {};
  for (const id of Object.keys(books)) {
    const e = books[id];
    if (!id || !e || typeof e !== "object" || Array.isArray(e)) continue;
    out.b[id] = { s: isCount(e.s) ? e.s : null, p: cleanRows(e.p) };
  }
  return out;
}

// 冊ごとの済みの数。books = [{ id, ids }]（ids は語の id。冊の中の同じ id は 1 語）。isDone(id) は語ごとに 1 回だけ呼ぶ。
// { total: true } なら { [冊]: { done, total } }
export function countBooks(books, isDone, { total = false } = {}) {
  const cache = new Map();
  const done = (id) => {
    if (!cache.has(id)) cache.set(id, !!isDone(id));
    return cache.get(id);
  };
  const out = {};
  for (const book of books) {
    const ids = new Set(book.ids);
    let n = 0;
    for (const id of ids) if (done(id)) n++;
    out[book.id] = total ? { done: n, total: ids.size } : n;
  }
  return out;
}

// 1 回の写し。state = readPace の値（書き換えない）。books = 今読み込んでいる冊の id（無い冊は s = 今日で行を置く。null なら冊の一覧は見ない）。
// gains = [{ book, n }]（その回の本で初めて済みになった語の数。1 以上の整数だけ足す）。新しい記録を返す
export function observePace(state, { books = null, today, gains = [] } = {}) {
  if (!isCount(today)) return state;
  const prev = state && state.b ? state : emptyPace();
  const lo = today - (PACE_DAYS - 1);
  const loaded = Array.isArray(books) ? new Set(books.filter((id) => typeof id === "string" && id)) : null;
  // 時計が戻った（前に写した日より今日が前）: その写しの進みは足さない（at は今日に合わせるので、次の写しからは足す）
  const count = prev.at === null || today >= prev.at;
  const next = { v: VERSION, at: today, b: emptyBooks() };
  for (const id of Object.keys(prev.b)) {
    const e = prev.b[id];
    const p = cleanRows(e.p, lo, today);
    if (loaded && !loaded.has(id) && p.length === 0) continue; // 読み込んでいない冊（外したパック）は、窓の中に進みがあるときだけ残す
    next.b[id] = { s: clampStart(e.s, p, today) ?? today, p };
  }
  if (loaded) for (const id of loaded) if (!next.b[id]) next.b[id] = { s: today, p: [] }; // 初めて見た冊: 記録を始めた日 = 今日
  if (count) {
    for (const g of Array.isArray(gains) ? gains : []) {
      if (!g || typeof g.book !== "string" || !g.book || !Number.isInteger(g.n) || g.n <= 0) continue;
      const e = next.b[g.book] ?? (next.b[g.book] = { s: today, p: [] });
      e.p = cleanRows([...e.p, [today, g.n]], lo, today);
    }
  }
  return next;
}

// 割る日数: 記録を始めてからの暦日数（今日を含む）。上限 14・下限 1。始めた日は今日より後にせず、窓の中の行より後にしない。読めなければ 14（短く見せない側）
export function paceSpan(start, today, rows = []) {
  if (!isCount(today)) return PACE_DAYS;
  const s = clampStart(start, cleanRows(rows, today - (PACE_DAYS - 1), today), today);
  if (s === null) return PACE_DAYS;
  return Math.min(PACE_DAYS, Math.max(1, today - s + 1));
}

// 日数: R×D÷G の四捨五入（0.5 は上）を整数だけで。R÷(G÷D) は浮動小数で 1 日ずれる組がある。1 日未満は 1 日
export function roundDays(remaining, gain, span = PACE_DAYS) {
  return Math.max(1, Math.floor((2 * remaining * span + gain) / (2 * gain)));
}

// 1 日あたりの見せ方: 割り切れれば整数（6 語）、10 以上は四捨五入の整数、それ未満は小数 1 桁（0.2 語・1.4 語）
export function formatAvg(gain, span = PACE_DAYS) {
  if (gain % span === 0) return String(gain / span);
  const avg = gain / span;
  if (avg >= 10) return String(Math.round(avg));
  const t = Math.round(avg * 10) / 10;
  return Number.isInteger(t) ? String(t) : t.toFixed(1);
}

const line = (text) => ({ pre: text });
const num = (pre, n, post) => ({ pre, num: n, post });
const note = (text) => ({ pre: text, note: true });

// 目安。total・done = 冊の語の数と済みの数（id で重複を除く）、rows = その冊の p、start = 記録を始めた日、today = 今日の日番号、
// unit = 「語」か「枚」（概念カードの冊。道と同じ）
// 返り値 { kind: "none" | "done" | "wait" | "pace", remaining, gain, active, span, days, avg, unit, long?, parts }（parts は 1 行ずつ。num は太字にする数）
export function paceOf({ total, done, rows = [], start = null, today, unit = "語" } = {}) {
  const t = isCount(total) ? total : 0;
  if (t === 0) return { kind: "none", parts: [] };
  const remaining = Math.max(0, t - (isCount(done) ? done : 0));
  if (remaining === 0) return { kind: "done", remaining, unit, parts: [line("完了"), note(PACE_COUNT_NOTE)] };
  let gain = 0;
  let active = 0;
  if (isCount(today)) {
    for (const [, n] of cleanRows(rows, today - (PACE_DAYS - 1), today)) {
      gain += n;
      if (n > 0) active++;
    }
  }
  const span = paceSpan(start, today, rows);
  const days = gain > 0 ? roundDays(remaining, gain, span) : null;
  const base = { remaining, gain, active, span, days, unit };
  if (active < PACE_MIN_ACTIVE || gain <= 0 || days > PACE_MAX_DAYS) {
    return { kind: "wait", ...base, ...(days > PACE_MAX_DAYS && active >= PACE_MIN_ACTIVE ? { long: true } : {}), parts: [num("残り", remaining, unit), line(PACE_WAIT), note(PACE_COUNT_NOTE)] };
  }
  const avg = formatAvg(gain, span);
  return {
    kind: "pace",
    ...base,
    avg,
    parts: [
      num("残り", remaining, unit),
      num(`最近${span}日間は、1日平均`, avg, `${unit}進んでいます。`),
      num("今のペースなら、完了まであと約", days, "日が目安です。"),
      note(PACE_DEVICE_NOTE),
      note(PACE_COUNT_NOTE)
    ]
  };
}

// 行の文字（読み上げ・検査用）
export function paceText(result) {
  return (result?.parts ?? []).map((p) => `${p.pre}${p.num ?? ""}${p.post ?? ""}`);
}

// ===== ホームの書き手（ブラウザだけ） =====
// 語の表（js/wordStore.js）・語の記録（js/storage.js）・分類（js/categoryProgress.js）・同期（js/sync.js isPulling。読むだけ）はホームで読み込み済みなので
// 動的 import（同じ module を使う）
const DESK_KEY = "spelldash_category"; // 机の本（js/pathView.js と同じ鍵。無ければ「すべて」）
let watching = false;

// 手が空いたとき（無ければ次のタスク）
const idle = (fn) => (typeof requestIdleCallback === "function" ? requestIdleCallback(fn, { timeout: 1000 }) : setTimeout(fn, 0));

// ホームで 1 回だけ呼ぶ（js/main.js。語の読み込みの後）
export function watchBookPace() {
  if (watching || typeof window === "undefined") return Promise.resolve(false);
  watching = true;
  return Promise.all([import("./wordStore.js"), import("./storage.js"), import("./categoryProgress.js"), import("./sync.js")])
    .then(([ws, st, cp, sy]) => {
      let session = null; // Study の回の間: { book, fresh: 一度も済みになったことの無い語, since: 回の始めの時刻 }
      let pending = null; // 同期の取り込みの間に終わった回（取り込みの後に数える）
      const queue = []; // まだ書いていない進み [{ book, n }]
      const pulling = () => {
        try {
          return !!sy.isPulling?.();
        } catch {
          return false;
        }
      };
      const books = () => [...ws.getCategories().map((c) => c.id), "all"]; // 読み込んでいるカテゴリ（マイ単語帳を含む）と「すべて」
      // その回で初めて済みになった語を数えて控えから外す（メモリーだけ。書くのは write）
      const take = (s) => {
        const stats = st.getWordStats();
        const ids = gainedIds(s.fresh, stats, (id) => isDoneState(cp.classifyWord(stats[id])), s.since);
        for (const id of ids) s.fresh.delete(id);
        if (ids.length) queue.push({ book: s.book, n: ids.length });
      };
      const write = () => {
        try {
          const today = todayNo();
          if (today === null) return;
          const raw = localStorage.getItem(PACE_KEY);
          const next = observePace(readPace(raw), { books: books(), today, gains: queue.splice(0) });
          const text = JSON.stringify(next);
          if (text !== raw) localStorage.setItem(PACE_KEY, text);
        } catch {
          // 目安は装飾: 保存できなくても学習は止めない（画面は待ちの文になるだけ）。ほかの鍵は消さない
        }
      };
      // 終わった回（と始め直した回）を数える。取り込みの間は控えておく（force: 次の回を始める前なので待たずに数える）
      const settle = (s, force = false) => {
        if (!s) return;
        if (!force && pulling()) {
          pending = s;
          return;
        }
        if (pending === s) pending = null;
        take(s);
      };
      const flushPending = (force = false) => {
        if (pending) settle(pending, force);
      };
      write(); // 読み込んだ冊の行を置く
      window.addEventListener("spelldash:game-start", (event) => {
        flushPending(true);
        settle(session, true); // 終わりの知らせの無いまま始め直した回（苦手だけ・机の本の替え）: 先にその本を数える
        const book = localStorage.getItem(DESK_KEY) || "all";
        session = event.detail?.mode === "study" ? { book, fresh: freshIds(ws.getWordsByCategory(book).map((w) => w.id), st.getWordStats()), since: Date.now() } : null;
        idle(write);
      });
      window.addEventListener("spelldash:game-end", () => {
        settle(session);
        session = null;
        idle(write); // 完了の画面を描いた後に書く
      });
      for (const type of ["spelldash:synced", "spelldash:store-ready", "spelldash:mywords"]) {
        window.addEventListener(type, () => {
          flushPending();
          idle(write);
        });
      }
      // 裏に回った・離れる: その場で（裏のタブは pagehide なしで捨てられうる。js/masteryMeta.js と同じ作法）。回の途中ならその回の分を数える（取り込みの間は数えない）
      const now = () => {
        if (!pulling()) {
          flushPending();
          if (session) take(session);
        }
        write();
      };
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") now();
      });
      window.addEventListener("pagehide", now);
      return true;
    })
    .catch(() => {
      watching = false;
      return false;
    });
}
