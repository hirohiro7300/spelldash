// ===== タイピング練習の長文（/typing.html の 3 つ目の種類。docs/SPEC_TYPING.md「長文」）: キーの読み方・時計・スコア・自己ベスト・教材の形 =====
// 文章を 1 本選び、最後の行まで打つ（制限時間なし）。判定（かなの単位・英語の 1 行）は js/typingDrill.js の createRun（kind "ja_text"／"en_text"）。
// DOM・localStorage に直接触らない（Node から import して E2E が確かめる）。学習記録は読まない・書かない。書くのは自己ベストの best.long だけ。
//
// - キー: 日本語は punctKeyOf（ローマ字のキー＋句読点 `,` `.`。句読点の字の表は js/romaji.js の PUNCT_KEYS・punctKeyOfChar の 1 か所）、
//   英語は textKeyOf（印字できる ASCII。大小はそのまま）。修飾キーは Ctrl・Cmd・Alt（Shift は含めない）
// - 時計: 最初に判定したキーから最後に判定したキーまで、止めていた間を除く（createLongClock）。時間 = lastAt − firstAt − pausedAtLast
// - スコア: 打/分×正確さの 2 乗（丸める前の値どうし）。速さと正確さを 1 つの数で言うため、正確さを重く見る。押したキー全部の速さに正確さの 3 乗を
//   掛けた値と同じで、この打/分は正しいキーだけを数えるので「打/分×正確さの 2 乗」になる。ミスが無ければ打/分と同じ。ミスが 1% 増えるとおよそ 3% 下がる
// - 自己ベスト: spelldash_typing_practice の best.long[文章の id]（鍵は増やさない）。比べるのはスコア、同じなら打/分。最後まで打った回だけ書く
//   （止めていた間を除いた経過の ms が 1 時間を超えた回は書かない・比べない）

import { romajiKeyOf, PUNCT_KEYS, punctKeyOfChar } from "./romaji.js";
import { BEST_KEY, BEST_KPM_MAX, SECONDS, intParam, summarize, readBestRecord, readBestGroup, writeBestRecord, validPairs } from "./typingDrill.js";

export const LONG_GROUP = "long"; // best.long
export const DEFAULT_LONG_ID = "ja-s01"; // 初めての端末の既定（日本語・短めでいちばん打鍵が少ない 1 編）
export const LONG_PARTIAL_MIN_MS = 5000; // Esc・やめる: 出す時間がこれ未満（または判定したキーが無い）なら始まる前へ戻すだけ
export const LONG_SEC_MAX = 3600; // 記録の sec の上限（秒の切り捨て）
export const LONG_MS_MAX = LONG_SEC_MAX * 1000; // 止めていた間を除いた経過の ms がこれを超えた完走は結果を出すが、自己ベストに書かない・比べない（秒の切り捨てで見ない）
export const LONG_LINES_PARAM_MAX = 99; // E2E 用の ?l=N（1〜99）
export const LONG_ID_RE = /^(ja|en)-[sl]\d{2}$/;
export const LONG_LANGS = ["ja", "en"];
export const LONG_LENS = ["short", "long"];
// select の群（並びも select の並び。教材の並びは scripts/build-typing-long.mjs の L11 が守る）
export const LONG_GROUPS = [
  { lang: "ja", len: "short", label: "日本語・短め" },
  { lang: "ja", len: "long", label: "日本語・長め" },
  { lang: "en", len: "short", label: "英語・短め" },
  { lang: "en", len: "long", label: "英語・長め" }
];

// ---- キーの読み方 ----

const modified = (event) => Boolean(event.ctrlKey || event.metaKey || event.altKey);
// 1 字で、NFKC にしても ASCII にならない字（JIS かな配列のかな: Comma のキーは「ね」、Period のキーは「る」）
const nonAsciiChar = (key) => [...key].length === 1 && !/^[\x00-\x7f]+$/.test(key.normalize("NFKC"));

// 日本語の長文: ローマ字のキー（romajiKeyOf のまま）＋読点 `,`・句点 `.`（字の表は romaji.js の punctKeyOfChar。{ punct: true } の matcher と同じ）。
// romajiKeyOf・normalizeRomajiKey の既定は広げない（Study の答えの判定が同じ関数を使い、`,` `.` がミスに変わるため）
export function punctKeyOf(event) {
  if (!event || modified(event)) return null;
  const romaji = romajiKeyOf(event);
  if (romaji) return romaji;
  const key = typeof event.key === "string" ? event.key : "";
  const punct = punctKeyOfChar(key);
  if (punct) return punct;
  if (key === "Process" || key === "Unidentified" || nonAsciiChar(key)) {
    const code = String(event.code ?? "");
    if (code === "Comma") return ",";
    if (code === "Period") return ".";
  }
  return null;
}

// IME オン（key が Process／Unidentified／Dead）の Shift つきの記号: 位置だけで読むと打ち間違いが正しい字になるので、US 配列の Shift の字で読む
// （どれも教材に無い字なので必ずミス）。Shift＋Slash（?）・Shift＋Digit7（JIS の位置の '）は表に入れず textKeyOf が読む
const SHIFTED_US = Object.freeze({ Comma: "<", Period: ">", Quote: '"', Minus: "_", Semicolon: ":", Digit1: "!", Digit2: "@", Digit3: "#", Digit4: "$", Digit5: "%", Digit6: "^", Digit8: "*", Digit9: "(", Digit0: ")" });

// 英語の長文: 1 字の key は NFKC（全角 → 半角。全角の空白も " "）、’ ‘ → '、印字できる ASCII（空白〜~）ならその字（大小はそのまま）。
// key が Process／Unidentified／Dead、または 1 字で NFKC でも ASCII にならない字（JIS かな配列のかな）なら code で読む。名前のキーは null
export function textKeyOf(event) {
  if (!event || modified(event)) return null;
  const key = typeof event.key === "string" ? event.key : "";
  if ([...key].length === 1) {
    let c = key.normalize("NFKC");
    if (c === "’" || c === "‘") c = "'";
    if (/^[\x20-\x7e]$/.test(c)) return c;
    if (!nonAsciiChar(key)) return null; // 制御文字・NFKC で 2 字以上の ASCII になる字
  } else if (key !== "Process" && key !== "Unidentified" && key !== "Dead") {
    return null; // Enter・Backspace・Shift・矢印など
  }
  const code = String(event.code ?? "");
  const shift = Boolean(event.shiftKey);
  const ime = key === "Process" || key === "Unidentified" || key === "Dead"; // かな配列のかな（1 字）は今どおり位置で読む
  if (shift && ime && Object.hasOwn(SHIFTED_US, code)) return SHIFTED_US[code];
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1].toLowerCase();
  if (code === "Space") return event.isComposing ? null : " ";
  if (code === "Comma") return ",";
  if (code === "Period") return ".";
  if (code === "Slash") return shift ? "?" : null;
  if (code === "Quote") return "'"; // US の位置（Shift なし。IME オンの Shift つきは " で読む）
  if (code === "Digit7" && shift) return "'"; // JIS の位置
  if ((m = /^Digit(\d)$/.exec(code))) return m[1];
  if (code === "Minus") return "-";
  if (code === "Semicolon") return ";";
  return null;
}

// 間違えたキーの表示: 日本語の句読点はキーの `,` `.` でなく「、」「。」（romaji.js の PUNCT_KEYS を逆に引く）、英語の空白は「空白」
// （英字は englishLine が小文字にそろえて数える）
const PUNCT_LABELS = Object.freeze(Object.fromEntries(Object.entries(PUNCT_KEYS).map(([ch, k]) => [k, ch])));
export function longKeyLabel(key, lang) {
  if (lang === "ja") return Object.hasOwn(PUNCT_LABELS, key) ? PUNCT_LABELS[key] : key;
  return key === " " ? "空白" : key;
}

// ---- 時計（止めていた間の合計で持つ） ----
// count(now) は判定したキー（正しい・ミス）ごと。飲んだキー・数えないキーでは呼ばない。pause(now) は止めた時刻、resume(now) は続きのキー
// （Space・Enter も）の時刻。firstAt の前に止めていた間は数えない（時計は最初に判定したキーから）。
// 時間 = lastAt − firstAt − pausedAtLast（lastAt より前に閉じた止めた間だけを引く。止める → Space で続き → 判定せずに Esc でも負にならない）
export function createLongClock() {
  let firstAt = null;
  let lastAt = null;
  let pausedMs = 0;
  let pausedAtLast = 0;
  let pausedSince = null;
  const clock = {
    get started() {
      return firstAt !== null;
    },
    get paused() {
      return pausedSince !== null;
    },
    get firstAt() {
      return firstAt;
    },
    get lastAt() {
      return lastAt;
    },
    get pausedMs() {
      return pausedMs;
    },
    get pausedAtLast() {
      return pausedAtLast;
    },
    count(now) {
      if (pausedSince !== null) clock.resume(now);
      if (firstAt === null) firstAt = now;
      lastAt = now;
      pausedAtLast = pausedMs;
    },
    pause(now) {
      if (firstAt !== null && pausedSince === null) pausedSince = now;
    },
    resume(now) {
      if (pausedSince === null) return;
      pausedMs += Math.max(0, now - pausedSince);
      pausedSince = null;
    },
    elapsedMs() {
      return firstAt === null ? 0 : Math.max(0, lastAt - firstAt - pausedAtLast);
    },
    reset() {
      firstAt = null;
      lastAt = null;
      pausedMs = 0;
      pausedAtLast = 0;
      pausedSince = null;
    }
  };
  return clock;
}

// Esc・やめる: "result"（途中までの結果）か "ready"（出す時間が 5 秒未満、または判定したキーが無い）。5 秒は押した時刻でなく出す時間で見る
export function stopOutcome(clock) {
  return clock && clock.started && clock.elapsedMs() >= LONG_PARTIAL_MIN_MS ? "result" : "ready";
}

// ---- 数え方 ----

// → summarize の形 + { kpm (null 可), score (null 可), ms, sec（秒の切り捨て） }。
// 秒が 1 未満なら打/分・スコアは null（「―」）。summarize は 0 以下の秒を 60 秒に替えるので、1 未満の秒は渡さない（その回の打/分は捨てる）
export function summarizeLong(stats, ms) {
  const msOk = Math.max(0, Number(ms) || 0);
  const secs = msOk / 1000;
  const short = secs < 1;
  const s = summarize(stats, short ? SECONDS : secs);
  const total = s.correct + s.miss;
  const score = short || total === 0 ? null : Math.round(((s.correct * 60) / secs) * (s.correct / total) ** 2);
  return { ...s, kpm: short ? null : s.kpm, score, ms: msOk, sec: Math.floor(secs) };
}

// 時間の書き方（秒の切り捨て）: 48秒・1分48秒・1分02秒・2分
export function formatLongTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return `${r}秒`;
  if (r === 0) return `${m}分`;
  return `${m}分${String(r).padStart(2, "0")}秒`;
}

// ---- 自己ベスト（best.long[id] = { score, kpm, acc, sec, keys, day }） ----

const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

// 検証（外れは壊れた記録として無い扱い）: score・kpm は整数 0〜2000、acc は整数 0〜100 か null、sec は整数 1〜3600、
// keys は正の整数で今の教材のその文章の keys と同じ（読みを直して打鍵数が変わった文章の古い記録と比べない）、day は文字列
export function validLongRecord(rec, keys) {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return null;
  const { score, kpm, acc, sec, day } = rec;
  if (!intIn(score, 0, BEST_KPM_MAX) || !intIn(kpm, 0, BEST_KPM_MAX)) return null;
  if (!(acc === null || intIn(acc, 0, 100))) return null;
  if (!intIn(sec, 1, LONG_SEC_MAX)) return null;
  if (!Number.isInteger(keys) || keys <= 0 || rec.keys !== keys) return null;
  if (typeof day !== "string") return null;
  return { score, kpm, acc, sec, keys, day };
}

// → 検証に通る記録 | null（無い・壊れている・keys が違う・読めない）
export function readLongBest(storage, id, keys) {
  return readBestRecord(storage, BEST_KEY, LONG_GROUP, id, (rec) => validLongRecord(rec, keys));
}

// 書く直前に読み直し、best.long[id] だけ差し替える（en・ja・ほかの文章を消さない）。書く前に検証と同じ範囲か見て、外れたら書かない → 書けたか
export function writeLongBest(storage, id, rec) {
  const ok = validLongRecord(rec, rec?.keys);
  if (!ok || typeof id !== "string" || !LONG_ID_RE.test(id)) return false;
  return writeBestRecord(storage, BEST_KEY, LONG_GROUP, id, ok);
}

// → { status: "first" | "new" | "faster" | "same" | "below" | "none", prev（句に出す前の数）, diff, write（書くか） }。
// prev は readLongBest の結果（壊れた記録は null → first）。now のスコア・打/分が整数でなければ none（比べない・書かない）
export function compareLongBest(prev, now) {
  if (!now || !Number.isInteger(now.score) || !Number.isInteger(now.kpm)) return { status: "none", prev: null, diff: 0, write: false };
  if (!prev) return { status: "first", prev: null, diff: 0, write: true };
  if (now.score > prev.score) return { status: "new", prev: prev.score, diff: now.score - prev.score, write: true };
  if (now.score === prev.score) {
    if (now.kpm > prev.kpm) return { status: "faster", prev: prev.kpm, diff: now.kpm - prev.kpm, write: true };
    return { status: "same", prev: prev.score, diff: 0, write: false };
  }
  return { status: "below", prev: prev.score, diff: prev.score - now.score, write: false };
}

// 自己ベストの句（付録 A の文。数はスコア、faster だけ前の打/分）。出さないときは null
export function longBestPhrase(cmp) {
  switch (cmp?.status) {
    case "first":
      return "自己ベスト（はじめての記録）";
    case "new":
      return `自己ベストを更新（前 ${cmp.prev}）`;
    case "faster":
      return `自己ベストと同じスコア・打/分を更新（前 ${cmp.prev}）`;
    case "same":
      return "自己ベストと同じ";
    case "below":
      return `自己ベスト ${cmp.prev}（あと ${cmp.diff}）`;
    default:
      return null;
  }
}

// 最後まで打った回の自己ベストを決めて書く（呼ぶのは完走で ?l= の無い回だけ。途中までの結果は呼ばない）。
// rec = { score, kpm, acc, sec, ms, day }（ms は止めていた間を除いた経過。書かない）。書く keys はその回の打鍵数でなく教材の text.keys
// （shi を si、nn を n で打った回も検証に通り「済み」が付く）。範囲の外（1 秒未満の完走・打/分 2001 以上・経過の ms が 1 時間を超えた回。
// 秒の切り捨てで 3600 秒に見える 1 時間 0.7 秒も）は書かず句も出さない（none）。書くはずが書けなかった端末も none
export function recordLongBest(storage, text, rec) {
  const full = { score: rec?.score, kpm: rec?.kpm, acc: rec?.acc ?? null, sec: rec?.sec, keys: text?.keys, day: rec?.day };
  if (!storage || !text || Number(rec?.ms) > LONG_MS_MAX || !validLongRecord(full, text.keys)) return { status: "none", prev: null, diff: 0, write: false };
  const cmp = compareLongBest(readLongBest(storage, text.id, text.keys), full);
  if (cmp.write && !writeLongBest(storage, text.id, full)) return { status: "none", prev: null, diff: 0, write: false };
  return cmp;
}

// 最後まで打った文章の id（検証に通る記録だけ。select の「済み」と既定の文章に使う）。読めない端末は空。
// 保存は 1 回だけ読み、best.long の各 id を validLongRecord で確かめる（文章ごとに readLongBest で読んだのと同じ結果）
export function doneLongIds(storage, texts) {
  const out = new Set();
  const group = readBestGroup(storage, BEST_KEY, LONG_GROUP);
  if (!group) return out;
  for (const t of Array.isArray(texts) ? texts : []) if (validLongRecord(group[t.id], t.keys)) out.add(t.id);
  return out;
}

// 既定の文章: select の並びでまだ最後まで打っていない最初の 1 編。全部済みなら ja-s01（教材に無ければ先頭）
export function defaultLongId(texts, done = new Set()) {
  const list = Array.isArray(texts) ? texts : [];
  const open = list.find((t) => !done.has(t.id));
  if (open) return open.id;
  return list.some((t) => t.id === DEFAULT_LONG_ID) ? DEFAULT_LONG_ID : list[0]?.id ?? null;
}

// 「次の文」: select の次の文章（最後なら先頭）
export function nextLongId(texts, id) {
  const list = Array.isArray(texts) ? texts : [];
  if (!list.length) return null;
  const i = list.findIndex((t) => t.id === id);
  return list[(i + 1) % list.length].id;
}

// select の項目: 「北風と太陽 12行」／「済み 北風と太陽 12行」（行の数は教材の行の数。?l= でも替えない）
export function longOptionLabel(text, done = false) {
  return `${done ? "済み " : ""}${text.title} ${text.lines.length}行`;
}

// ---- 教材の形（data/typing-long.json = { v: 1, texts: [{ id, lang, len, title, keys, lines: [[見出し, 読み] | [文, 訳], …] }] }） ----

// → texts（そのまま）| null（形が違う）。長文のタブを初めて押したときに 1 回だけ取ったものを確かめる
export function parseLongData(json) {
  if (!json || typeof json !== "object" || json.v !== 1 || !Array.isArray(json.texts) || json.texts.length === 0) return null;
  const ids = new Set();
  for (const t of json.texts) {
    if (!t || typeof t !== "object") return null;
    if (typeof t.id !== "string" || !LONG_ID_RE.test(t.id) || ids.has(t.id)) return null;
    if (!LONG_LANGS.includes(t.lang) || t.id.slice(0, 2) !== t.lang || !LONG_LENS.includes(t.len)) return null;
    if (typeof t.title !== "string" || t.title === "" || !Number.isInteger(t.keys) || t.keys <= 0 || !validPairs(t.lines)) return null;
    ids.add(t.id);
  }
  return json.texts;
}

// E2E 用の ?l=N（1〜99）→ N | null。どの文章も先頭の N 行に切る（その回は自己ベストに書かず、比べない。計測は送る）
export function linesFrom(search) {
  return intParam(search, "l", 1, LONG_LINES_PARAM_MAX);
}

export function trimLongLines(lines, n) {
  return Number.isInteger(n) && n > 0 ? lines.slice(0, n) : lines;
}
