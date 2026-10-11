// ===== タイピングゲーム（/typing-game.html）の進行・持ち時間・数え方・自己ベスト（docs/SPEC_TYPING_GAME.md） =====
//
// 日本語の文（見出し＋読み）を 1 つずつローマ字で打つ。文ごとに持ち時間があり、打ち切れば「取れた」、尽きると「流れた」。
// DOM・localStorage に直接触らない（Node から import して E2E と scripts/build-typing-game.mjs が使う）。
// 判定・かなの単位・語末の ん の持ち越し・数え方は js/typingDrill.js（typing.html と同じ部品）を借りる。
// 学習記録（単語の記録・SRS・XP・連続日数・苦手なキーなど）は一切読まない・書かない。
// ?t=・?s= の読み取りと自己ベストの保存の読み書きも typingDrill.js の共通の関数（intParam・readBestRecord・writeBestRecord）。
// RESULT_GUARD_MS はここで定義も再 export もしない（2 枚のページの配線 js/typingKeys.js が typingDrill.js から import する）。

import { createRomajiMatcher, canonicalRomaji } from "./romaji.js";
import { createRun, shuffle, summarize, intParam, readBestRecord, writeBestRecord, BEST_KPM_MAX } from "./typingDrill.js";

export const SECONDS = 90;
export const FLOW_GRACE_MS = 600; // 流れてからこの間は、新しい文として通らないキーを数えない（SPILL_GAP_MS と同じ長さ。別の意味なので別の定数）
export const SETTLE_SLACK_MS = 50; // 時計（rAF・timer）が締切に気づいてから流すまでの余白。keydown は押した瞬間（event.timeStamp）で厳密に比べる
export const LIMIT_MIN_MS = 4000;
export const LIMIT_MAX_MS = 30000;
export const GOAL_REF_KEYS_PER_SEC = 2.5; // 目標の参照の速さ（打/秒）。持ち時間の係数とは別の数（docs/SPEC_TYPING_GAME.md「目標」）
export const GOAL_GAP_SEC = 0.4; // 文の切り替えと読み始めの間
export const DEFAULT_COURSE = "normal";
export const FIRST_SENTENCE = ["今日はいい天気だ", "きょうはいいてんきだ"]; // typing-game.html に直書きした最初の文
export const BEST_KEY = "spelldash_typing_game"; // 自己ベスト（タイピング練習 typing.html の自己ベストとは別の鍵）
export const BEST_GOT_MAX = 200; // 90 秒に 200 文は人の手では届かない（超えた値は壊れた記録）

// goal は scripts/build-typing-game.mjs --check が本番の教材の平均打鍵から goalFromAverage で計算し直し、差が 0 でなければ落ちる
export const COURSES = {
  short: { name: "短い語句", unit: "語句", band: [3, 7], note: "かな3〜7字の語句", baseMs: 1500, perKeyMs: 600, goal: 20 },
  normal: { name: "ふつうの文", unit: "文", band: [8, 16], note: "かな8〜16字の文", baseMs: 1500, perKeyMs: 500, goal: 8 },
  long: { name: "長い文", unit: "文", band: [17, 30], note: "かな17〜30字の文", baseMs: 1500, perKeyMs: 420, goal: 4 }
};
export const COURSE_IDS = Object.keys(COURSES);

// "?t=6" → 6。1〜90 の整数以外・無し → 90（E2E が時間を縮める。typing.html の ?t= と同じ流儀）
export function secondsFrom(search) {
  return intParam(search, "t", 1, SECONDS) ?? SECONDS;
}

// "?s=2" → 2。1〜9 の整数以外・無し → null（文ごとの持ち時間を一律 N 秒に。E2E 用。その回は自己ベストに書かない）
export function limitSecondsFrom(search) {
  return intParam(search, "s", 1, 9);
}

// 手本（画面に出す綴り。語末の ん だけ n）の打鍵数
export function keysOf(reading) {
  return (canonicalRomaji(String(reading ?? ""), { finalN: true }) ?? "").length;
}

// 文の持ち時間（ms）: 1.5 秒＋係数×打鍵を 4〜30 秒に丸める。overrideSec があればそれ（?s=）
export function limitMs(course, reading, overrideSec = null) {
  if (overrideSec != null) return overrideSec * 1000;
  const c = COURSES[course] ?? COURSES[DEFAULT_COURSE];
  return Math.min(LIMIT_MAX_MS, Math.max(LIMIT_MIN_MS, c.baseMs + c.perKeyMs * keysOf(reading)));
}

// 目標（取れた文の数）。?t= の回は秒数に比例（1 以上）
export function goalFor(course, seconds = SECONDS) {
  const goal = (COURSES[course] ?? COURSES[DEFAULT_COURSE]).goal;
  return seconds === SECONDS ? goal : Math.max(1, Math.round((goal * seconds) / SECONDS));
}

// 参照の速さの人が、コースの平均の文を 90 秒で取り切れる数。取れる文は整数で、時間切れの打ちかけは数えないので切り捨て
// （四捨五入だと 4.6 → 5 のように、90 秒の中で取り切れない端数の文を目標に入れてしまう）。式はここ 1 か所（生成スクリプトも使う）
export function goalFromAverage(avgKeys, seconds = SECONDS) {
  return Math.floor(seconds / (avgKeys / GOAL_REF_KEYS_PER_SEC + GOAL_GAP_SEC));
}

// 先頭 3 文のうち手本の打鍵数が最小のものを先頭に（新しい配列。1 文目で流さない）
export function pickFirst(list) {
  const out = [...list];
  let best = 0;
  for (let i = 1; i < Math.min(3, out.length); i++) if (keysOf(out[i][1]) < keysOf(out[best][1])) best = i;
  if (best > 0) out.unshift(...out.splice(best, 1));
  return out;
}

// 混ぜて pickFirst（ページを開いた最初の回の内蔵の文 FIRST_SENTENCE は js/typingGamePage.js が列の頭に置く）
export function shuffleCourse(list, random = Math.random) {
  return pickFirst(shuffle(list, random));
}

// 今の文が、このキーを正しい打鍵として受けるか（状態は変えない。打った分を写した matcher に 1 打だけ流す）
function accepts(word, key) {
  if (!word) return false;
  const m = createRomajiMatcher([word.reading]);
  m.type(word.matcher.keys);
  return m.feed(key).ok;
}

// ---- 1 回 ----
// sentences: [見出し, 読み] の列。limit(reading) → ms。時刻は performance.now() と同じ時計（keydown は event.timeStamp）
export function createGameRun({ sentences = [], seconds = SECONDS, limit = () => LIMIT_MIN_MS } = {}) {
  const inner = createRun("ja", sentences);
  let started = false;
  let ended = false;
  let endAt = Infinity;
  let deadline = Infinity;
  let sentenceStartedAt = 0;
  let flowedAt = null;
  let lastSettledAt = -Infinity; // 状態を変えた（流した・終えた）最後の時刻。これより前の時刻は切り上げる（巻き戻さない）
  let got = 0;
  let lost = 0;

  function open(at) {
    sentenceStartedAt = at;
    deadline = inner.current ? Math.min(at + limit(inner.current.reading), endAt) : Infinity;
  }

  // 今の文の締切（90 秒の中）を過ぎていれば流して次へ（次の文の締切も過ぎていれば繰り返す）→ 90 秒が切れていれば終える。
  // 締切が endAt と同じ文（打ちかけのまま時間切れ）は流さない。slack: 時計（rAF・timer）の余白（keydown は 0）。冪等
  function settle(now, slack = 0) {
    if (!started || ended) return { flowed: 0, ended };
    const t = Math.max(now, lastSettledAt);
    let flowed = 0;
    while (inner.current && deadline < endAt && t >= deadline + slack) {
      lost++;
      flowed++;
      const at = deadline; // 次の文は締切の瞬間から（時計が遅れても、時刻の基準は締切）
      inner.skip();
      open(at);
    }
    if (flowed) {
      flowedAt = t;
      lastSettledAt = t;
    }
    if (t >= endAt + slack) {
      ended = true;
      lastSettledAt = t;
      return { flowed, ended: true };
    }
    return { flowed, ended: false };
  }

  return {
    get current() {
      return inner.current;
    },
    get got() {
      return got;
    },
    get lost() {
      return lost;
    },
    get stats() {
      return inner.stats;
    },
    get missPending() {
      return inner.missPending;
    },
    get started() {
      return started;
    },
    get ended() {
      return ended;
    },
    get endAt() {
      return endAt;
    },
    get deadline() {
      return deadline;
    },
    get sentenceStartedAt() {
      return sentenceStartedAt;
    },
    get flowedAt() {
      return flowedAt;
    },
    get lastSettledAt() {
      return lastSettledAt;
    },
    get size() {
      return inner.size;
    },
    start(now) {
      if (started) return;
      started = true;
      endAt = now + seconds * 1000;
      open(now);
    },
    settle,
    // 線の残り比 0〜1（始まる前・文が無いときは 1。分母が 0 以下なら 0: 教材が届いた瞬間が endAt と同じとき）
    remainingRatio(now) {
      if (!started || !inner.current) return 1;
      const span = deadline - sentenceStartedAt;
      if (!(span > 0)) return 0;
      return Math.min(1, Math.max(0, (deadline - now) / span));
    },
    // → { type: "correct"|"miss"|"ignored"|"swallowed"|"dropped"|"ended", done, flowed }
    press(key, now) {
      const s = settle(now, 0);
      if (s.ended) return { type: "ended", done: false, flowed: 0 };
      if (s.flowed) return { type: "dropped", done: false, flowed: s.flowed }; // 締切のあとに届いたキーは数えない
      const t = Math.max(now, lastSettledAt);
      // 流れてから FLOW_GRACE_MS の間は、新しい文として通らないキーを数えない（時間だけで切る。通るキーはそのまま進む）
      if (flowedAt != null && t - flowedAt <= FLOW_GRACE_MS && inner.current && key && !accepts(inner.current, key)) return { type: "dropped", done: false, flowed: 0 };
      const r = inner.press(key, t);
      if (r.type === "correct" && r.done) {
        got++;
        flowedAt = null;
        open(t);
      }
      return { type: r.type, done: Boolean(r.done), flowed: 0 };
    },
    // 列の後ろに足す（教材が届く前に始めた回・列が尽きた回）。今の文が無かったのに出来たら、その瞬間から持ち時間を張る
    add(more, now) {
      const had = Boolean(inner.current);
      inner.add(more);
      if (!had && inner.current && started && !ended) open(Math.min(now, endAt));
    }
  };
}

// → { kpm, accuracy, correct, miss, total, topKeys, got, lost, goal, reached, unit }
export function summarizeGame(run, course, seconds = SECONDS) {
  const goal = goalFor(course, seconds);
  const got = Number(run?.got) || 0;
  return { ...summarize(run?.stats, seconds), got, lost: Number(run?.lost) || 0, goal, reached: got >= goal, unit: (COURSES[course] ?? COURSES[DEFAULT_COURSE]).unit };
}

// ---- 自己ベスト（コースごと・秒数ごと） ----
// 形: { v: 1, best: { normal: { "90": { got, lost, kpm, acc, day } }, short: {}, long: {} } }。storage は localStorage と同じ形

const validCount = (n) => Number.isInteger(n) && n >= 0 && n <= BEST_GOT_MAX;

function validRecord(rec) {
  if (!rec || typeof rec !== "object") return null;
  if (!validCount(rec.got) || !validCount(rec.lost) || !Number.isInteger(rec.kpm) || rec.kpm < 0 || rec.kpm > BEST_KPM_MAX) return null;
  return { got: rec.got, lost: rec.lost, kpm: rec.kpm, acc: Number.isFinite(rec.acc) ? rec.acc : null, day: typeof rec.day === "string" ? rec.day : "" };
}

// → { got, lost, kpm, acc, day } | null（読めない・壊れている・範囲の外 → null）
export function readGameBest(storage, course, seconds = SECONDS) {
  return COURSES[course] ? readBestRecord(storage, BEST_KEY, course, seconds, validRecord) : null;
}

// 取れた文の数で比べ、同数のときだけ打/分で比べる → { status: "first"|"new"|"faster"|"same"|"below"|"none", prev, diff }
export function compareGameBest(prev, got, kpm) {
  const g = Number(got) || 0;
  const k = Number(kpm) || 0;
  if (!prev) return g > 0 ? { status: "first", prev: null, diff: 0 } : { status: "none", prev: null, diff: 0 };
  if (g > prev.got) return { status: "new", prev, diff: g - prev.got };
  if (g < prev.got) return { status: "below", prev, diff: prev.got - g };
  if (k > prev.kpm) return { status: "faster", prev, diff: k - prev.kpm };
  return { status: "same", prev, diff: 0 };
}

// 保存の直前に読み直し、best[course][秒数] だけ差し替えて書く（ほかのコース・秒数を消さない）→ 書けたか
export function writeGameBest(storage, course, seconds, rec) {
  if (!COURSES[course]) return false;
  return writeBestRecord(storage, BEST_KEY, course, seconds, {
    got: Number(rec?.got) || 0,
    lost: Number(rec?.lost) || 0,
    kpm: Number(rec?.kpm) || 0,
    acc: Number.isFinite(rec?.acc) ? rec.acc : null,
    day: typeof rec?.day === "string" ? rec.day : ""
  });
}
