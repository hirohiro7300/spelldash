// ===== 一冊を終えるまでの目安（学習データ「今週」タブの 1 枚。Batch 76） =====
// 冊（カテゴリ・「すべて」・マイ単語帳）ごとに「済みの語の数」の日ごとの増減を、この端末だけに残す（spelldash_book_pace。送らない・同期しない）。
// 済み = 覚えた・習得・知ってた（js/pathView.js isRemembered と同じ。js/categoryProgress.js classifyWord が learning・mastered・known）。
// 既存の記録（語ごとの最後の ○・× の日時・直近 8 件の history・保持率の f・成長ログ）からは冊ごとの日の増減を戻せないので、新しく数える。
//
// 鍵 spelldash_book_pace = { v: 1, at: 最後に数えた日の日番号, b: { [冊 id]: { n: そのときの済みの数, p: [[日番号, その日の純増], ...], off?: 1 } } }
//   off = 前に写したとき読み込まれていなかった冊（外したパック）。次に見たときは数えずに基準を置き直す
//   日番号はローカル暦日（js/retentionCalc.js dayNoOf。0 時で区切る）。p は 0 でない日だけ・直近 14 日（今日−13〜今日）だけ持つ。
// 数え方（統合担当の決め・docs は統合担当が写す）:
//   - 数える（count）: 回の終わり・裏に回ったとき・ページを離れるとき。前に数えたときの n との差をその日の p に足す（純増。× で外れた語は引く）
//   - 置き直す（rebase）: ホームの読み込みの後・同期・語の読み直し。n を今の値にするだけで進みに入れない（届いた変化・パックの出し入れ・版の変化）
//   - 初めて見た冊は基準だけ（fill: 回の始めに、足したばかりの本に基準を置く）
//   - 時計が戻った（今日 < at）ときは数えずに置き直す。今日より後の日の行は読まない（書くとき捨てる）
// 書くのはホーム（js/main.js が語の読み込みの後に watchBookPace を動的 import で呼ぶ）だけ。答えの道（入力完了から次の問題まで）には足さない:
// 回の終わりの知らせ（spelldash:game-end・session-end）は setTimeout 0 で、完了の画面を描いた後のタスクで数える。学習データのページは読むだけ。
// Battle とホーム以外で済みになった語は、次の置き直しに吸われて進みに入らない（残りには入る）。
//
// 目安（paceOf）: 残り R = 冊の語（id で重複を除く）− 済み。進み G = 直近 14 暦日の p の和。進んだ日 = p > 0 の日。平均 = G ÷ 14（学習しない日も 14 に入る）。
//   語が 0 → 出さない。R = 0 → 完了。進んだ日 ≥ 3・G > 0・日数 ≤ 365 → 「約 N 日」（N = R×14÷G の四捨五入を整数で。下限 1）。それ以外 → 待ちの文。
// 上の純な関数は import が dayNoOf・localDay だけ（Node から直に読む: scripts/test-pace.mjs）。

import { localDay, dayNoOf } from "./retentionCalc.js";

export const PACE_KEY = "spelldash_book_pace";
export const PACE_DAYS = 14; // 窓（今日を含む暦日）
export const PACE_MIN_ACTIVE = 3; // 進んだ日がこれ以上
export const PACE_MAX_DAYS = 365; // これを超える日数は出さない（統合担当の決め 5）
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

// p の行を整える: [日番号, 0 でない整数] だけ・同じ日は和・0 になった日は捨てる・日の昇順。lo〜hi の外は捨てる
function cleanRows(rows, lo = 0, hi = Infinity) {
  const days = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(row) || !isCount(row[0]) || !Number.isInteger(row[1]) || row[1] === 0) continue;
    if (row[0] < lo || row[0] > hi) continue;
    days.set(row[0], (days.get(row[0]) ?? 0) + row[1]);
  }
  return [...days].filter(([, n]) => n !== 0).sort((a, b) => a[0] - b[0]);
}

// 保存の文字列（または読んだ値）→ 整えた記録。読めない・形が違う・版が違う → 空（次の置き直しで基準を置き直す）。壊れた冊の行は 1 つずつ捨てる
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
    if (!id || !e || typeof e !== "object" || !isCount(e.n)) continue;
    out.b[id] = { n: e.n, p: cleanRows(e.p), ...(e.off === 1 ? { off: 1 } : {}) };
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

// 1 回の写し。state = readPace の値（書き換えない）、doneById = { [冊]: 済みの数 }（今読み込んでいる冊）、mode = "count" | "rebase" | "fill"。新しい記録を返す
export function observePace(state, doneById, { today, mode = "rebase" } = {}) {
  if (!isCount(today)) return state;
  const prev = state && state.b ? state : emptyPace();
  const lo = today - (PACE_DAYS - 1);
  // 時計が戻った（前に数えた日より今日が前）: その日の進みには数えない（置き直す）
  const count = mode === "count" && prev.at !== null && today >= prev.at;
  const next = { v: VERSION, at: today, b: emptyBooks() };
  const seen = new Set();
  for (const id of Object.keys(doneById ?? {})) {
    const done = doneById[id];
    if (!isCount(done)) continue;
    seen.add(id);
    const e = prev.b[id];
    if (!e) {
      next.b[id] = { n: done, p: [] }; // 初めて見た冊: 基準だけ
      continue;
    }
    const p = cleanRows(e.p, lo, today);
    if (e.off) {
      next.b[id] = { n: done, p }; // 前に読み込まれていなかった冊（外して足し直した本）: 間の変化は数えず基準を置き直す
      continue;
    }
    if (mode === "fill") {
      next.b[id] = { n: e.n, p };
      continue;
    }
    const delta = count ? done - e.n : 0;
    next.b[id] = { n: done, p: delta ? cleanRows([...p, [today, delta]], lo, today) : p };
  }
  // 今読み込んでいない冊（外したパック）: 窓の中に進みがあれば off の印を付けて残す（次に見たときは基準を置き直す）。進みが無ければ捨てる。
  // 数が読めなかった冊（doneById にあるが数でない）は、そのまま残す
  for (const id of Object.keys(prev.b)) {
    if (seen.has(id)) continue;
    const e = prev.b[id];
    const p = cleanRows(e.p, lo, today);
    if (Object.prototype.hasOwnProperty.call(doneById ?? {}, id)) next.b[id] = { n: e.n, p, ...(e.off ? { off: 1 } : {}) };
    else if (p.length) next.b[id] = { n: e.n, p, off: 1 };
  }
  return next;
}

// 日数: R×14÷G の四捨五入（0.5 は上）を整数だけで。R÷(G÷14) は浮動小数で 1 日ずれる組がある。1 日未満は 1 日
export function roundDays(remaining, gain) {
  return Math.max(1, Math.floor((2 * remaining * PACE_DAYS + gain) / (2 * gain)));
}

// 1 日平均の見せ方: 14 で割り切れれば整数（6 語）、10 以上は四捨五入の整数、それ未満は小数 1 桁（0.2 語・1.4 語）
export function formatAvg(gain) {
  if (gain % PACE_DAYS === 0) return String(gain / PACE_DAYS);
  const avg = gain / PACE_DAYS;
  if (avg >= 10) return String(Math.round(avg));
  const t = Math.round(avg * 10) / 10;
  return Number.isInteger(t) ? String(t) : t.toFixed(1);
}

const line = (text) => ({ pre: text });
const num = (pre, n, post) => ({ pre, num: n, post });
const note = (text) => ({ pre: text, note: true });

// 目安。total・done = 冊の語の数と済みの数（id で重複を除く）、rows = その冊の p、today = 今日の日番号、unit = 「語」か「枚」（概念カードの冊。道と同じ）
// 返り値 { kind: "none" | "done" | "wait" | "pace", remaining, gain, active, days, avg, unit, long?, parts }（parts は 1 行ずつ。num は太字にする数）
export function paceOf({ total, done, rows = [], today, unit = "語" } = {}) {
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
  const days = gain > 0 ? roundDays(remaining, gain) : null;
  const base = { remaining, gain, active, days, unit };
  if (active < PACE_MIN_ACTIVE || gain <= 0 || days > PACE_MAX_DAYS) {
    return { kind: "wait", ...base, ...(days > PACE_MAX_DAYS && active >= PACE_MIN_ACTIVE ? { long: true } : {}), parts: [num("残り", remaining, unit), line(PACE_WAIT), note(PACE_COUNT_NOTE)] };
  }
  const avg = formatAvg(gain);
  return {
    kind: "pace",
    ...base,
    avg,
    parts: [
      num("残り", remaining, unit),
      num("最近14日間は、1日平均", avg, `${unit}進んでいます。`),
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
// 語の表（js/wordStore.js）・語の記録（js/storage.js）・分類（js/categoryProgress.js）はホームで読み込み済みなので動的 import（同じ module を使う）。
// 冊の語は js/wordStore.js getWordsByCategory と同じ条件（カテゴリが同じ・kanjiOnly を除く）で、全部の語を 1 回だけ走って分ける（冊ごとに全語を走らない）
let watching = false;

function currentDone({ ws, st, cp }) {
  const stats = st.getWordStats();
  const groups = new Map();
  for (const c of ws.getCategories()) if (c.id !== ws.MY_CATEGORY.id) groups.set(c.id, []);
  for (const w of ws.getAllWords()) {
    if (w.kanjiOnly) continue;
    groups.get(w.category)?.push(w.id);
  }
  const books = [...groups].map(([id, ids]) => ({ id, ids }));
  books.push({ id: "all", ids: ws.getWordsByCategory("all").map((w) => w.id) });
  books.push({ id: ws.MY_CATEGORY.id, ids: ws.getWordsByCategory(ws.MY_CATEGORY.id).map((w) => w.id) });
  return countBooks(books, (id) => isDoneState(cp.classifyWord(stats[id])));
}

function record(deps, mode) {
  try {
    const today = todayNo();
    if (today === null) return;
    const raw = localStorage.getItem(PACE_KEY);
    const next = observePace(readPace(raw), currentDone(deps), { today, mode });
    const text = JSON.stringify(next);
    if (text !== raw) localStorage.setItem(PACE_KEY, text);
  } catch {
    // 目安は装飾: 保存できなくても学習は止めない（画面は待ちの文になるだけ）。ほかの鍵は消さない
  }
}

// ホームで 1 回だけ呼ぶ（js/main.js。語の読み込みの後）。読み込んだ時点で置き直し、回の終わり・裏に回ったとき・離れるときに数える
export function watchBookPace() {
  if (watching || typeof window === "undefined") return Promise.resolve(false);
  watching = true;
  return Promise.all([import("./wordStore.js"), import("./storage.js"), import("./categoryProgress.js")])
    .then(([ws, st, cp]) => {
      const deps = { ws, st, cp };
      const later = (mode) => () => setTimeout(() => record(deps, mode), 0);
      record(deps, "rebase");
      window.addEventListener("spelldash:game-start", later("fill")); // 回の前に足した本に基準を置く（最初の答えより前）
      window.addEventListener("spelldash:game-end", later("count")); // 完了の画面を描いた後のタスクで
      window.addEventListener("spelldash:session-end", later("count"));
      for (const type of ["spelldash:synced", "spelldash:store-ready", "spelldash:mywords"]) window.addEventListener(type, later("rebase"));
      // 裏に回った・離れる: その場で（裏のタブは pagehide なしで捨てられうる。js/masteryMeta.js と同じ作法）
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") record(deps, "count");
      });
      window.addEventListener("pagehide", () => record(deps, "count"));
      return true;
    })
    .catch(() => {
      watching = false;
      return false;
    });
}
