// ===== タイピング練習（/typing.html）の判定・数え方・自己ベスト（docs/SPEC_TYPING.md） =====
//
// 見本を見てそのまま打つ（写し打ち）。DOM・localStorage に直接触らない（Node から import して E2E が確かめる）。
// 学習記録（spelldash_word_stats・SRS・XP・連続日数・spelldash_key_miss など）は一切読まない・書かない。
//
// - 英単語: 見本の次の字と同じキーなら正しい打鍵、違えばミス（語は止めない。正しいキーを打てば進む）
// - 日本語: 読みをローマ字で打つ（js/romaji.js の matcher。shi／si・tsu／tu・ん の nn／n' などを受ける）。候補は主な読み 1 つ
// - 語末の ん を手本どおり n 1 つで終えたあと、nn と打つ癖の 2 つ目の n は、次の語の 1 打目として通らなければ飲む（数えない）

import { createRomajiMatcher } from "./romaji.js";

export const SECONDS = 60;
export const RESULT_GUARD_MS = 600; // 結果が出てからこの間は Enter／Space を無視し、画面キーボードを出したまま・結果のボタンを inert にする
export const SPILL_GAP_MS = 600; // 語末の ん の 2 つ目の n を飲む間（js/game.js の ROMAJI_SPILL_GAP_MS と同じ値。game.js は import しない）
export const TOP_KEYS = 3;
export const BEST_KEY = "spelldash_typing_practice"; // 自己ベスト（Study の spelldash_typing_stats とは別物）
export const FIRST_WORD = ["apple", "りんご"]; // typing.html に直書きした最初の語

// "?t=3" → 3。1〜60 の整数以外・無し → 60（E2E が時間を縮める。js/game.js の ?t= と同じ流儀）
export function secondsFrom(search) {
  let raw = null;
  try {
    raw = new URLSearchParams(String(search ?? "")).get("t");
  } catch {
    raw = null;
  }
  if (raw == null || !/^\d{1,2}$/.test(raw)) return SECONDS;
  const n = Number(raw);
  return n >= 1 && n <= 60 ? n : SECONDS;
}

// 新しい配列（Fisher–Yates）
export function shuffle(list, random = Math.random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---- 1 語 ----

function englishWord(pair) {
  const text = String(pair[0]);
  const gloss = String(pair[1] ?? "");
  let pos = 0;
  return {
    kind: "en",
    text,
    gloss,
    get pos() {
      return pos;
    },
    feed(key) {
      if (!key || pos >= text.length) return { ok: false, ignored: true, done: pos >= text.length, expected: "" };
      if (key !== text[pos]) return { ok: false, ignored: false, done: false, expected: text[pos] };
      pos++;
      return { ok: true, ignored: false, done: pos === text.length, expected: text[pos] ?? "", canContinue: false };
    },
    startsWith(key) {
      return pos === 0 && key === text[0];
    },
    rest() {
      return text.slice(pos);
    },
    view() {
      return { done: text.slice(0, pos), now: text[pos] ?? "", rest: text.slice(pos + 1) };
    }
  };
}

// かなの単位（済み・今・まだ）と、まだの打鍵（data-rest）。
// 済みは matcher の state().committed、今とまだは写しの matcher で hint() の綴りを 1 打ずつ流して作る（打った人の綴りに合わせて替わる）
export function japaneseUnits(reading, keys) {
  const m = createRomajiMatcher([reading]);
  m.type(keys);
  const st = m.state();
  const units = st.committed.map(({ kana, keys: typed }) => ({ kana, typed, rest: "", state: "done" }));
  if (st.done) return { units, rest: "" };
  const copy = createRomajiMatcher([reading]);
  copy.type(keys);
  let rest = "";
  let first = true;
  const ahead = [];
  for (let guard = 0; guard < 64; guard++) {
    const h = copy.hint();
    if (!h) break;
    let fed = "";
    for (const k of h.keys) {
      copy.feed(k);
      fed += k;
      if (copy.state().done) break;
    }
    ahead.push({ kana: h.kana, typed: first ? st.pending : "", rest: fed, state: first ? "now" : "todo" });
    rest += fed;
    first = false;
    if (copy.state().done || fed === "") break;
  }
  // 打ち途中の っ（がっこう を gakk）: committed は kk の っ を済みに数えるが、hint() は matcher の位置（っ の手前）から「っこ」を返す。
  // 済み＋今＋まだのかなが読みより多い分だけ、今の単位のかなを頭から落とす（「が っ っこ う」→「が っ こ う」。キーと data-rest は変えない）
  const total = [...(m.entries[m.primary]?.display ?? reading)].length;
  const count = (list) => list.reduce((n, u) => n + [...u.kana].length, 0);
  const over = count(units) + count(ahead) - total;
  if (over > 0 && ahead[0]) ahead[0].kana = [...ahead[0].kana].slice(over).join("");
  return { units: [...units, ...ahead], rest };
}

function japaneseWord(pair) {
  const term = String(pair[0]);
  const reading = String(pair[1] ?? "");
  const matcher = createRomajiMatcher([reading]);
  let cache = null;
  const view = () => {
    if (!cache || cache.keys !== matcher.keys) cache = { keys: matcher.keys, ...japaneseUnits(reading, matcher.keys) };
    return { units: cache.units, rest: cache.rest };
  };
  return {
    kind: "ja",
    term,
    reading,
    matcher,
    feed(key) {
      const r = matcher.feed(key);
      if (r.ignored) return { ok: false, ignored: true, done: r.done, expected: "" };
      return { ok: r.ok, ignored: false, done: r.done, expected: r.expected ?? "", canContinue: r.ok && r.done ? matcher.state().canContinue : false };
    },
    startsWith(key) {
      return matcher.keys === "" && createRomajiMatcher([reading]).feed(key).ok;
    },
    rest() {
      return view().rest;
    },
    view
  };
}

// kind: "en" | "ja"、pair: [見本, 訳] | [用語, 読み]
export function createWord(kind, pair) {
  return kind === "ja" ? japaneseWord(pair) : englishWord(pair);
}

// ---- 1 回 ----

export function createRun(kind, pairs = []) {
  const list = [...pairs];
  let index = 0;
  let current = list.length ? createWord(kind, list[0]) : null;
  let spill = null; // 終えた語の続き（語末の ん の 2 つ目の n）{ matcher, at }
  let missPending = false;
  const stats = { correct: 0, miss: 0, missKeys: new Map(), words: 0 };

  function advance() {
    index++;
    current = index < list.length ? createWord(kind, list[index]) : null;
    missPending = false;
  }

  return {
    kind,
    stats,
    get current() {
      return current;
    },
    // 次の語の pair（予告）。今の語が無ければ null
    get next() {
      return current ? list[index + 1] ?? null : null;
    },
    get missPending() {
      return missPending;
    },
    get size() {
      return list.length;
    },
    // 列の後ろに足す（教材が届く前に始めた回）。今の語が無ければ作る
    add(more) {
      list.push(...more);
      if (!current && index < list.length) current = createWord(kind, list[index]);
    },
    press(key, now) {
      if (!key) return { type: "ignored" };
      if (spill) {
        if (current && current.startsWith(key)) spill = null; // 次の語の 1 打目として通るなら先に次の語へ
        else if (now - spill.at <= SPILL_GAP_MS && spill.matcher.feed(key).ok) {
          spill = spill.matcher.state().canContinue ? { matcher: spill.matcher, at: now } : null;
          return { type: "swallowed" };
        } else spill = null;
      }
      if (!current) return { type: "ignored" };
      const r = current.feed(key);
      if (r.ignored) return { type: "ignored" };
      if (!r.ok) {
        stats.miss++;
        missPending = true;
        if (r.expected) stats.missKeys.set(r.expected, (stats.missKeys.get(r.expected) ?? 0) + 1);
        return { type: "miss", expected: r.expected };
      }
      stats.correct++;
      missPending = false;
      if (r.done) {
        stats.words++;
        spill = kind === "ja" && r.canContinue ? { matcher: current.matcher, at: now } : null;
        advance();
        return { type: "correct", done: true };
      }
      return { type: "correct", done: false };
    }
  };
}

// ---- 数え方 ----

const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// → { kpm, accuracy (null 可), correct, miss, total, topKeys: [[key, count], …] }
export function summarize(stats, seconds = SECONDS) {
  const correct = Math.max(0, Number(stats?.correct) || 0);
  const miss = Math.max(0, Number(stats?.miss) || 0);
  const total = correct + miss;
  const secs = Number(seconds) > 0 ? Number(seconds) : SECONDS;
  const raw = stats?.missKeys instanceof Map ? [...stats.missKeys.entries()] : Object.entries(stats?.missKeys ?? {});
  const topKeys = raw
    .filter(([k, n]) => k && Number(n) > 0)
    .map(([k, n]) => [k, Number(n)])
    .sort((a, b) => b[1] - a[1] || byKey(a[0], b[0]))
    .slice(0, TOP_KEYS);
  return {
    kpm: Math.round((correct * 60) / secs),
    accuracy: total > 0 ? Math.floor((correct * 100) / total) : null,
    correct,
    miss,
    total,
    topKeys
  };
}

// ---- 自己ベスト（種類ごと・秒数ごと） ----
// 形: { v: 1, best: { en: { "60": { kpm, acc, day } }, ja: { … } } }。storage は localStorage と同じ形（getItem／setItem）

// 打/分は Math.round の整数で書く。整数でない・上限（2000 打/分 = 33 打/秒。人の打鍵では届かない）を超える値は壊れた値として無い扱い
// （1e300 などを受けると「あと 1e+300」と出て以後ずっと更新できない）。次の結果が「はじめての記録」として上書きする
export const BEST_KPM_MAX = 2000;

function validRecord(rec) {
  return rec && typeof rec === "object" && Number.isInteger(rec.kpm) && rec.kpm >= 0 && rec.kpm <= BEST_KPM_MAX ? { kpm: rec.kpm, acc: Number.isFinite(rec.acc) ? rec.acc : null, day: typeof rec.day === "string" ? rec.day : "" } : null;
}

function parseAll(raw) {
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === "object" && data.v === 1 && data.best && typeof data.best === "object") return data;
  } catch {
    // 壊れている → 無い扱い
  }
  return null;
}

// → { en: {kpm, acc, day} | null, ja: … }（その秒数の記録だけ）。読めない・壊れている → 両方 null
export function readBest(storage, seconds = SECONDS) {
  const out = { en: null, ja: null };
  let raw = null;
  try {
    raw = storage?.getItem(BEST_KEY) ?? null;
  } catch {
    return out;
  }
  const data = parseAll(raw);
  if (!data) return out;
  for (const k of ["en", "ja"]) out[k] = validRecord(data.best?.[k]?.[String(seconds)]);
  return out;
}

// → { status: "first" | "new" | "same" | "below" | "none", prev, diff }
export function compareBest(prev, kpm) {
  const now = Number(kpm) || 0;
  const before = prev && Number.isFinite(prev.kpm) ? prev.kpm : null;
  if (before === null) return now > 0 ? { status: "first", prev: null, diff: 0 } : { status: "none", prev: null, diff: 0 };
  if (now > before) return { status: "new", prev: before, diff: now - before };
  if (now === before) return { status: "same", prev: before, diff: 0 };
  return { status: "below", prev: before, diff: before - now };
}

// 保存の直前に読み直し、best[kind][秒数] だけ差し替えて書く（ほかの種類・秒数を消さない）。→ 書けたか
export function writeBest(storage, kind, seconds, rec) {
  if (!storage || (kind !== "en" && kind !== "ja")) return false;
  let raw = null;
  try {
    raw = storage.getItem(BEST_KEY);
  } catch {
    return false; // 読めない端末では書かない（読めないまま丸ごと上書きしない）
  }
  const data = parseAll(raw) ?? { v: 1, best: {} };
  const best = { ...data.best };
  const forKind = best[kind] && typeof best[kind] === "object" ? { ...best[kind] } : {};
  forKind[String(seconds)] = { kpm: Number(rec?.kpm) || 0, acc: Number.isFinite(rec?.acc) ? rec.acc : null, day: typeof rec?.day === "string" ? rec.day : "" };
  best[kind] = forKind;
  try {
    storage.setItem(BEST_KEY, JSON.stringify({ v: 1, best }));
    return true;
  } catch {
    return false;
  }
}
