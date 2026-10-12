// タイピングゲーム（/typing-game.html）の教材 data/typing-game.json を、元データ scripts/typing-game/*.jsonl から作る（docs/SPEC_TYPING_GAME.md「教材」）。
//   node scripts/build-typing-game.mjs            書き直す（検査に落ちたら書かずに exit 1）
//   node scripts/build-typing-game.mjs --check    生成物と一致・違反 0・目標の定数が合うか（CI と E2E）。違えば一覧を出して exit 1
//   node scripts/build-typing-game.mjs --lint <file.jsonl> [--course short|normal|long]
//                                                 木の外の 1 ファイルだけを同じ検査にかけ、行ごとの NG を「行番号: 検査名: 理由」で出す（書かない。NG があれば exit 1）。
//                                                 --course を省くとファイル名の short／normal／long から読む。木の .jsonl との重複・ことわざの重なりも見る
//   node scripts/build-typing-game.mjs --report   topic ごとの数・かな数の分布・打鍵の平均と目標の計算値・漢字の一覧（頻度順。小・中学校のパックに出ない字に *）
//   import { buildTypingGameData, validateTypingGameData } from "./build-typing-game.mjs"
//     buildTypingGameData()        → { text, courses: { short, normal, long }, stats: { avgKeys, goal, courses }, rows, problems, origin }（書かない）
//     validateTypingGameData(data) → 違反の一覧（文字列。空なら合格）。build の戻り値でも、生成物（JSON.parse した data/typing-game.json）でもよい
//
// 元データ: 1 文 1 行の JSON {"t":"見出し","r":"よみ","topic":"話題"}。空行と # で始まる行は読み飛ばす。
// 避ける語: scripts/typing-game/deny.txt（1 行 1 語。漢字・カタカナ語だけ。見出しに対する部分一致。読みには当てない）。
// 検査の番号 V1〜V14 は仕様のもの。読みの判定は js/romaji.js、かなの行は js/typingDrill.js、
// コースの定数・持ち時間・目標の式は js/typingGame.js を import して使う（式を 2 か所に書かない）。
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.join(ROOT, "scripts", "typing-game");
const OUT = path.join(ROOT, "data", "typing-game.json");
const DENY_FILE = path.join(SRC_DIR, "deny.txt");
const GAME_FILE = path.join(ROOT, "js", "typingGame.js");
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

export const COURSE_IDS = ["short", "normal", "long"];
export const MIN_COUNT = { short: 200, normal: 250, long: 150 }; // V10
export const TITLE_MAX = { short: 10, normal: 18, long: 30 }; // V5: 見出しの字数の上限
export const TOPICS = ["あいさつ", "暮らし", "学校", "仕事", "季節", "食", "旅", "ことわざ"]; // V10
export const BIAS_RATIO = 0.04; // V9: 同じ漢字 2 字を含む文がコースの 4% を超えない（下限 2。1 束 25 行なら 3 文目から NG）
export const PROVERB_HEAD = 6; // V13: 見出しの先頭 6 字が同じなら同じことわざ
const READING_RE = /^[ぁ-んー]+$/; // V1
const READING_NG_RE = /[ゐゑゎ]/;
const TITLE_RE = /^[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}ー々、]+$/u; // V5
const HAN_RE = /\p{sc=Han}/u;
const KANA_RUN_RE = /[ぁ-ゖー]+/gu; // V6: 見出しのかなの連なり
const KEYS = ["t", "r", "topic"];

const R = await import(pathToFileURL(path.join(ROOT, "js", "romaji.js")).href);
const T = await import(pathToFileURL(path.join(ROOT, "js", "typingDrill.js")).href);
const { canonicalRomaji, createRomajiMatcher } = R;

// コースの定数・持ち時間・目標の式は js/typingGame.js（式を 2 か所に書かない）
export const GAME = await import(pathToFileURL(GAME_FILE).href);

// ---- 読み込み ----

// JSONL → { rows: [{ t, r, topic, file, line }], problems: [{ file, line, check, reason }] }
export function parseJsonl(text, file) {
  const rows = [];
  const problems = [];
  String(text ?? "")
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = i + 1;
      const s = raw.trim();
      if (s === "" || s.startsWith("#")) return;
      const bad = (reason) => problems.push({ file, line, check: "形", reason });
      let obj;
      try {
        obj = JSON.parse(s);
      } catch (e) {
        bad(`JSON として読めない（${e.message}）`);
        return;
      }
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        bad('{"t":"見出し","r":"よみ","topic":"話題"} の形ではない');
        return;
      }
      const before = problems.length;
      const missing = KEYS.filter((k) => !(k in obj));
      const extra = Object.keys(obj).filter((k) => !KEYS.includes(k));
      if (missing.length) bad(`${missing.join("・")} が無い`);
      if (extra.length) bad(`余分なキー ${extra.join("・")}`);
      for (const k of KEYS) {
        if (!(k in obj)) continue;
        const v = obj[k];
        if (typeof v !== "string") bad(`${k} が文字列ではない`);
        else if (v === "") bad(`${k} が空`);
        else if (v !== v.trim()) bad(`${k} の前後に空白`);
      }
      if (problems.length === before) rows.push({ t: obj.t, r: obj.r, topic: obj.topic, file, line });
    });
  return { rows, problems };
}

// 木の 3 ファイル → { rows（course 付き）, problems }
export function loadSources(dir = SRC_DIR) {
  const rows = [];
  const problems = [];
  for (const course of COURSE_IDS) {
    const file = path.join(dir, `${course}.jsonl`);
    if (!fs.existsSync(file)) {
      problems.push({ file, line: 0, course, check: "形", reason: "ファイルが無い" });
      continue;
    }
    const parsed = parseJsonl(fs.readFileSync(file, "utf8"), file);
    rows.push(...parsed.rows.map((r) => ({ ...r, course })));
    problems.push(...parsed.problems.map((p) => ({ ...p, course })));
  }
  return { rows, problems };
}

// deny.txt → { words: [{ word, line }], problems }。漢字もカタカナも含まない語（かなの語）は置けない
export function loadDeny(file = DENY_FILE) {
  const words = [];
  const problems = [];
  if (!fs.existsSync(file)) return { words, problems: [{ file, line: 0, check: "形", reason: "deny.txt が無い" }] };
  fs.readFileSync(file, "utf8")
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const s = raw.trim();
      if (s === "" || s.startsWith("#")) return;
      for (const word of s.split(/\s+/)) {
        if (/[\p{sc=Han}\p{sc=Katakana}]/u.test(word)) words.push({ word, line: i + 1 });
        else problems.push({ file, line: i + 1, check: "形", reason: `「${word}」は漢字もカタカナも含まない（かなの語は置かない。読みには当てないため）` });
      }
    });
  return { words, problems };
}

// ---- 1 文の性質 ----

export const kanaCount = (r) => [...String(r ?? "")].length;
const toHiragana = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const where = (row) => `${path.basename(row.file)}:${row.line}`;

// V2: 手本（語末の ん は n 1 つ）で打ち終えられる。opts は createRomajiMatcher にそのまま渡す（既定は空。タイピング練習の長文の生成器
// scripts/build-typing-long.mjs が { punct: true } で使う。ゲームの呼び方は引数なしのまま）
export function typeable(r, canon, opts = {}) {
  if (!canon) return false;
  const m = createRomajiMatcher([{ reading: r, display: r }], opts);
  return m.type(canon).missAt === -1 && m.state().done;
}

// V7: 手本どおりに 1 打ずつ打ちながら、かなの単位をつないだものが常に読みと同じ（tests/e2e.mjs の drift と同じ）。
// opts は japaneseUnits にそのまま渡す（既定は空。長文の生成器が { punct: true } で使う）
export function unitsDrift(r, canon, opts = {}) {
  let typed = "";
  for (let i = 0; ; i++) {
    const kana = T.japaneseUnits(r, typed, opts).units.map((u) => u.kana).join("");
    if (kana !== r) return `${typed === "" ? "0 打" : typed} まで打ったときのかなの行が「${kana}」`;
    if (i >= canon.length) return null;
    typed += canon[i];
  }
}

// V6: 見出しのかなの連なり（カタカナはひらがなに）が、読みの中にこの順で重ならずに現れる
export function kanaOrderMiss(t, r) {
  const runs = toHiragana(t).match(KANA_RUN_RE) ?? [];
  let pos = 0;
  for (const run of runs) {
    const at = r.indexOf(run, pos);
    if (at < 0) return `見出しの「${run}」が読み「${r}」の ${pos + 1} 字目から後に無い（同じ順で・重ならずに現れること）`;
    pos = at + run.length;
  }
  return null;
}

// V9: 見出しに含まれる漢字 2 字の連なり
function hanBigrams(t) {
  const chars = [...t];
  const out = new Set();
  for (let i = 0; i + 1 < chars.length; i++) if (HAN_RE.test(chars[i]) && HAN_RE.test(chars[i + 1])) out.add(chars[i] + chars[i + 1]);
  return out;
}
export const biasLimit = (n) => Math.max(2, Math.floor(n * BIAS_RATIO));

// ---- 検査 ----
// rows: [{ t, r, topic, course, file, line, own }]。own === false の行（lint のときの木の行）は重複の相手にはなるが NG には出さない。
// full: 数（V10）・最初の文（V11）・目標の定数（V12）も見る（build と --check。lint では見ない）
export function validateRows(rows, { full = false, deny = [], origin = (course) => path.join(SRC_DIR, `${course}.jsonl`) } = {}) {
  const out = [];
  const push = (row, check, reason) => {
    if (row.own !== false) out.push({ file: row.file, line: row.line, course: row.course, check, reason });
  };
  const keysOfRow = new Map();

  for (const row of rows) {
    const { t, r, topic, course } = row;
    const C = GAME.COURSES[course];
    const kana = kanaCount(r);
    const titleLen = [...t].length;
    const readingOk = READING_RE.test(r) && !READING_NG_RE.test(r) && r.normalize("NFKC") === r;
    const canon = readingOk ? canonicalRomaji(r, { finalN: true }) : null;
    keysOfRow.set(row, canon ? canon.length : 0);

    // V1 読みの字種
    if (!readingOk) {
      const badChars = [...r].filter((ch) => !READING_RE.test(ch) || READING_NG_RE.test(ch));
      push(row, "V1 読みの字種", `読みは ひらがな＋ー だけ（ゐゑゎ も不可）: ${badChars.length ? badChars.join(" ") : "NFKC で変わる字"}`);
    } else {
      // V2 打ち切れる
      const ok = typeable(r, canon);
      if (!ok) push(row, "V2 打ち切れる", `読み「${r}」を手本 ${canon ?? "(作れない)"} で打ち終えられない`);
      // V14 手本に x・l が無い
      if (canon && /[xl]/.test(canon)) push(row, "V14 手本の x・l", `手本 ${canon} に「${/[xl][a-z]*/.exec(canon)[0]}」（文末や「、」の前の っ・単独の小書きかな）`);
      // V7 かなの行の一致
      if (ok && canon && !/[xl]/.test(canon)) {
        const drift = unitsDrift(r, canon);
        if (drift) push(row, "V7 かなの行", drift);
      }
    }
    // V3 帯
    if (kana < C.band[0] || kana > C.band[1]) push(row, "V3 帯", `読み ${kana} かな（${course} は ${C.band[0]}〜${C.band[1]}）`);
    // V5 見出しの字種と長さ
    if (t.normalize("NFKC") !== t) push(row, "V5 見出し", "NFKC で変わる字がある");
    else if (!TITLE_RE.test(t)) push(row, "V5 見出し", `使えない字 ${[...t].filter((ch) => !TITLE_RE.test(ch)).map((ch) => (/\s/.test(ch) ? "(空白)" : ch)).join(" ")}（漢字・ひらがな・カタカナ・ー・々・「、」だけ）`);
    const commas = [...t].filter((ch) => ch === "、").length;
    if (commas && course !== "long") push(row, "V5 見出し", "「、」は long だけ");
    else if (commas > 2) push(row, "V5 見出し", `「、」が ${commas}（2 つまで）`);
    if (titleLen > TITLE_MAX[course]) push(row, "V5 見出し", `見出し ${titleLen} 字（${course} は ${TITLE_MAX[course]} 字まで）`);
    else if (titleLen > kana + 2) push(row, "V5 見出し", `見出し ${titleLen} 字 > 読み ${kana} かな＋2`);
    // V6 見出しのかなの順
    if (readingOk) {
      const miss = kanaOrderMiss(t, r);
      if (miss) push(row, "V6 かなの順", miss);
    }
    // V8 避ける語（見出しだけ）
    for (const d of deny) if (t.includes(d.word)) push(row, "V8 避ける語", `見出しに「${d.word}」（deny.txt:${d.line}）`);
    // V10 topic
    if (topic !== null && !TOPICS.includes(topic)) push(row, "V10 topic", `topic「${topic}」は 8 種のどれでもない（${TOPICS.join("・")}）`);
    // V12 参照の速さの人が 1 文も流れない
    if (canon) {
      const need = (canon.length / GAME.GOAL_REF_KEYS_PER_SEC + GAME.GOAL_GAP_SEC) * 1000;
      const lim = GAME.limitMs(course, r);
      if (lim < need) push(row, "V12 目標", `持ち時間 ${lim}ms < 参照の速さ ${GAME.GOAL_REF_KEYS_PER_SEC} 打/秒で要る ${Math.ceil(need)}ms`);
    }
  }

  // V4 重複（読み・見出し。3 コースをまたぐ）
  const seenT = new Map();
  const seenR = new Map();
  for (const row of rows) {
    const pt = seenT.get(row.t);
    if (pt) push(row, "V4 重複", `見出し「${row.t}」が ${where(pt)} と同じ`);
    else seenT.set(row.t, row);
    const pr = seenR.get(row.r);
    if (pr) push(row, "V4 重複", `読み「${row.r}」が ${where(pr)} と同じ`);
    else seenR.set(row.r, row);
  }

  // V13 同じことわざは 1 つだけ（先頭 6 字が同じなら同じことわざ。短い方が 6 字に満たなければその字数で比べる: 急がば回れ ↔ 急がば回れ、…）
  const proverbs = [];
  for (const row of rows) {
    if (row.topic !== "ことわざ") continue;
    const chars = [...row.t];
    const same = proverbs.find((p) => {
      const n = Math.min(PROVERB_HEAD, chars.length, p.chars.length);
      return chars.slice(0, n).join("") === p.chars.slice(0, n).join("");
    });
    if (!same) proverbs.push({ row, chars });
    else push(row, "V13 ことわざ", `「${chars.slice(0, PROVERB_HEAD).join("")}…」が${same.row.course === row.course ? "同じコースの" : ` ${same.row.course} の`} ${where(same.row)} にもある（同じことわざは 1 コースに 1 つ）`);
  }

  // V9 偏り（コースごと。lint ではそのファイルの行だけで見る）
  for (const course of COURSE_IDS) {
    const list = rows.filter((row) => row.course === course && row.own !== false);
    const limit = biasLimit(list.length);
    const byBigram = new Map();
    for (const row of list) for (const bg of hanBigrams(row.t)) byBigram.set(bg, [...(byBigram.get(bg) ?? []), row]);
    for (const [bg, hits] of byBigram) {
      if (hits.length <= limit) continue;
      for (const row of hits.slice(limit)) push(row, "V9 偏り", `「${bg}」を含む文が ${hits.length}（上限 ${limit}。${hits.length - limit} 文を言い換える）`);
    }
  }

  if (full) {
    for (const course of COURSE_IDS) {
      const list = rows.filter((row) => row.course === course);
      const file = origin(course);
      // V10 数
      if (list.length < MIN_COUNT[course]) out.push({ file, line: 0, course, check: "V10 数", reason: `${list.length} 文（${MIN_COUNT[course]} 文以上）` });
      // V12 目標の定数（教材がそろってから。今は 3 コースとも差 0。切り捨てでも境目はある: 短い語句の平均 10.06 打は、19 に下がる境目 10.25 打まで 0.19 打。
      // 教材を足して境目をまたいだらここが落ちるので、js/typingGame.js の COURSES の定数と typing-game.html の補足「目標 N文」を直す）
      if (list.length >= MIN_COUNT[course]) {
        const avg = list.reduce((n, row) => n + keysOfRow.get(row), 0) / list.length;
        const calc = GAME.goalFromAverage(avg);
        if (calc !== GAME.COURSES[course].goal) {
          out.push({ file, line: 0, course, check: "V12 目標", reason: `平均 ${avg.toFixed(1)} 打からの計算値 ${calc} と COURSES.${course}.goal の ${GAME.COURSES[course].goal} が違う（js/typingGame.js の定数を直し、typing-game.html の補足「目標 N文」も揃える）` });
        }
      }
    }
    // V11 最初の 1 文
    const [ft, fr] = GAME.FIRST_SENTENCE;
    if (!rows.some((row) => row.course === "normal" && row.t === ft && row.r === fr)) {
      out.push({ file: origin("normal"), line: 0, course: "normal", check: "V11 最初の文", reason: `FIRST_SENTENCE「${ft}」（${fr}）が normal に無い` });
    }
  }
  return sortProblems(out);
}

// ファイルの順 → 行 → 検査の番号（形 → V1 → V2 …）
function sortProblems(list) {
  const rank = new Map();
  for (const p of list) if (!rank.has(p.file)) rank.set(p.file, rank.size);
  const num = (check) => Number(/^V(\d+)/.exec(check)?.[1] ?? 0);
  return [...list].sort((a, b) => rank.get(a.file) - rank.get(b.file) || a.line - b.line || num(a.check) - num(b.check) || (a.check < b.check ? -1 : a.check > b.check ? 1 : 0));
}

export const formatProblem = (p) => `${rel(p.file)}${p.line ? `:${p.line}` : ""}: ${p.check}: ${p.reason}`;

// ---- 集計 ----

export function courseStats(rows) {
  const out = {};
  for (const course of COURSE_IDS) {
    const list = rows.filter((row) => row.course === course);
    const keys = list.map((row) => GAME.keysOf(row.r));
    const limits = list.map((row) => GAME.limitMs(course, row.r));
    const sum = (l) => l.reduce((a, b) => a + b, 0);
    const avgKeys = list.length ? sum(keys) / list.length : 0;
    const avgLimitMs = list.length ? sum(limits) / list.length : 0;
    const topics = Object.fromEntries(TOPICS.map((t) => [t, 0]));
    const kanaHist = {};
    for (const row of list) {
      if (row.topic in topics) topics[row.topic]++;
      else if (row.topic != null) topics[row.topic] = (topics[row.topic] ?? 0) + 1;
      const n = kanaCount(row.r);
      kanaHist[n] = (kanaHist[n] ?? 0) + 1;
    }
    out[course] = {
      count: list.length,
      min: MIN_COUNT[course],
      avgKeys,
      goalCalc: list.length ? GAME.goalFromAverage(avgKeys) : null,
      goalConst: GAME.COURSES[course].goal,
      avgLimitMs,
      minLimitMs: list.length ? Math.min(...limits) : 0,
      maxLimitMs: list.length ? Math.max(...limits) : 0,
      needKeysPerSec: avgLimitMs ? avgKeys / (avgLimitMs / 1000) : 0,
      topics,
      kanaHist
    };
  }
  return out;
}

// 1 文 1 行（差分を読みやすくする。typing.json と同じ流儀）
function format(courses) {
  const block = (list) => (list.length ? `[\n${list.map((p) => `      ${JSON.stringify(p)}`).join(",\n")}\n    ]` : "[]");
  return `{\n  "v": 1,\n  "courses": {\n${COURSE_IDS.map((c) => `    ${JSON.stringify(c)}: ${block(courses[c] ?? [])}`).join(",\n")}\n  }\n}\n`;
}

export function buildTypingGameData(dir = SRC_DIR) {
  const { rows, problems } = loadSources(dir);
  const origin = (course) => path.join(dir, `${course}.jsonl`);
  const courses = Object.fromEntries(COURSE_IDS.map((c) => [c, rows.filter((row) => row.course === c).map((row) => [row.t, row.r])]));
  const perCourse = courseStats(rows);
  const stats = {
    avgKeys: Object.fromEntries(COURSE_IDS.map((c) => [c, perCourse[c].avgKeys])),
    goal: Object.fromEntries(COURSE_IDS.map((c) => [c, perCourse[c].goalCalc])),
    courses: perCourse
  };
  return { text: format(courses), courses, stats, rows, problems, origin };
}

// 生成物（{ v: 1, courses: { short: [[見出し, 読み], …] } }）→ rows（topic は無いので topic の検査は飛ばす）
function rowsFromGenerated(data) {
  const rows = [];
  const problems = [];
  const bad = (reason) => problems.push({ file: OUT, line: 0, check: "形", reason });
  if (!data || typeof data !== "object" || data.v !== 1 || !data.courses || typeof data.courses !== "object") {
    bad("v が 1 でないか courses が無い");
    return { rows, problems };
  }
  for (const key of Object.keys(data.courses)) if (!COURSE_IDS.includes(key)) bad(`知らないコース ${key}`);
  for (const course of COURSE_IDS) {
    const list = data.courses[course];
    if (!Array.isArray(list)) {
      bad(`courses.${course} が配列ではない`);
      continue;
    }
    list.forEach((pair, i) => {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string" || pair[0] === "" || pair[1] === "") {
        problems.push({ file: OUT, line: 0, course, check: "形", reason: `courses.${course}[${i}] が [見出し, 読み] ではない` });
        return;
      }
      rows.push({ t: pair[0], r: pair[1], topic: null, course, file: OUT, line: i + 1 });
    });
  }
  return { rows, problems };
}

// 違反の一覧（文字列。空なら合格）。E2E は生成物に対して呼ぶ
export function validateTypingGameData(data) {
  const deny = loadDeny();
  const built = data && Array.isArray(data.rows) && Array.isArray(data.problems);
  const src = built ? data : rowsFromGenerated(data);
  const origin = built && typeof data.origin === "function" ? data.origin : () => OUT;
  const problems = [...src.problems, ...deny.problems, ...validateRows(src.rows, { full: true, deny: deny.words, origin })];
  return sortProblems(problems).map(formatProblem);
}

// 1 ファイルだけ（lint）。木の .jsonl（自分自身は除く）を重複の相手に入れる。→ { rows, problems（行ごと）, stats }
export function lintFile(file, course, dir = SRC_DIR) {
  const abs = path.resolve(file);
  const deny = loadDeny();
  const parsed = parseJsonl(fs.readFileSync(abs, "utf8"), abs);
  const own = parsed.rows.map((row) => ({ ...row, course, own: true }));
  const tree = loadSources(dir).rows.filter((row) => path.resolve(row.file) !== abs).map((row) => ({ ...row, own: false }));
  const problems = [
    ...parsed.problems,
    ...deny.problems.map((p) => ({ ...p, file: abs, line: 0, reason: `deny.txt:${p.line} ${p.reason}` })),
    ...validateRows([...tree, ...own], { full: false, deny: deny.words })
  ];
  return { rows: own.length, problems: sortProblems(problems), stats: courseStats(own)[course] };
}

// ---- --report ----

// 小・中学校のパック（concept の群で group が 小学校／中学校 で始まる）の q・answer・ja に出る漢字（scripts/build-typing.mjs の jaGroup と同じ選び方）。
// 読めなければ null（長文の生成器の --write-kanji・--report は null で落ちる）
export function schoolKanji() {
  const set = new Set();
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "manifest.json"), "utf8"));
    const cats = (manifest.subjects ?? []).flatMap((s) => s.categories ?? []);
    for (const c of cats) {
      const group = String(c.group ?? "");
      if (!c.file || c.kind !== "concept" || !(group.startsWith("小学校") || group.startsWith("中学校"))) continue;
      const words = JSON.parse(fs.readFileSync(path.join(ROOT, "data", c.file), "utf8")).words ?? [];
      for (const w of words) for (const ch of `${w.q ?? ""}${w.answer ?? ""}${w.ja ?? ""}`) if (HAN_RE.test(ch)) set.add(ch);
    }
  } catch {
    return null;
  }
  return set;
}

const sec = (ms) => `${(ms / 1000).toFixed(1)}秒`;

function statsLines(stats, course) {
  const s = stats;
  const band = GAME.COURSES[course].band;
  const hist = [];
  for (let n = band[0]; n <= band[1]; n++) hist.push(`${n}:${s.kanaHist[n] ?? 0}`);
  const outside = Object.keys(s.kanaHist)
    .map(Number)
    .filter((n) => n < band[0] || n > band[1])
    .sort((a, b) => a - b)
    .map((n) => `${n}:${s.kanaHist[n]}`);
  return [
    `${course}: ${s.count} 文（下限 ${s.min}）・平均 ${s.avgKeys.toFixed(1)} 打・平均の持ち時間 ${sec(s.avgLimitMs)}（${sec(s.minLimitMs)}〜${sec(s.maxLimitMs)}）・取り切る速さ ${s.needKeysPerSec.toFixed(2)} 打/秒・目標 計算値 ${s.goalCalc ?? "-"}／定数 ${s.goalConst}`,
    `  topic: ${Object.entries(s.topics).map(([k, v]) => `${k} ${v}`).join("・")}`,
    `  かな数（${band[0]}〜${band[1]}）: ${hist.join(" ")}${outside.length ? `  帯の外: ${outside.join(" ")}` : ""}`
  ];
}

function report(data) {
  const lines = [];
  for (const course of COURSE_IDS) lines.push(...statsLines(data.stats.courses[course], course));
  const freq = new Map();
  for (const row of data.rows) for (const ch of row.t) if (HAN_RE.test(ch)) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  const school = schoolKanji();
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const marked = sorted.filter(([ch]) => school && !school.has(ch));
  lines.push(`漢字 ${sorted.length} 種（頻度順${school ? "。* は小・中学校のパックに 1 度も出ない字（常用の目安。落とす判断は人）" : ""}）:`);
  for (let i = 0; i < sorted.length; i += 20) lines.push("  " + sorted.slice(i, i + 20).map(([ch, n]) => `${school && !school.has(ch) ? "*" : ""}${ch}${n}`).join(" "));
  if (school) lines.push(`* の字 ${marked.length} 種: ${marked.map(([ch]) => ch).join(" ") || "なし"}`);
  return lines.join("\n");
}

// ---- CLI ----

function usage() {
  console.error(
    [
      "使い方:",
      "  node scripts/build-typing-game.mjs                                  data/typing-game.json を書く（検査に落ちたら書かない）",
      "  node scripts/build-typing-game.mjs --check                          生成物が最新で違反 0 か（CI）",
      "  node scripts/build-typing-game.mjs --lint <file.jsonl> [--course short|normal|long]",
      "                                                                      1 ファイルだけ検査（書かない）。行番号: 検査名: 理由",
      "  node scripts/build-typing-game.mjs --report                         数・分布・目標の計算値・漢字の一覧"
    ].join("\n")
  );
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const valueOf = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] ?? null : null;
  };
  const known = new Set(["--check", "--lint", "--course", "--report"]);
  const positional = argv.filter((a, i) => a.startsWith("--") && !known.has(a) || (!a.startsWith("--") && argv[i - 1] !== "--lint" && argv[i - 1] !== "--course"));
  if (positional.length) usage();

  if (argv.includes("--lint")) {
    const file = valueOf("--lint");
    if (!file || file.startsWith("--")) usage();
    if (!fs.existsSync(file)) {
      console.error(`ファイルが無い: ${file}`);
      process.exit(2);
    }
    let course = valueOf("--course");
    if (course && !COURSE_IDS.includes(course)) {
      console.error(`--course は short|normal|long（${course}）`);
      process.exit(2);
    }
    if (!course) {
      const m = /(short|normal|long)/.exec(path.basename(file));
      if (!m) {
        console.error("コースが分からない: --course short|normal|long を付ける（ファイル名に short・normal・long があれば省ける）");
        process.exit(2);
      }
      course = m[1];
    }
    const result = lintFile(file, course);
    for (const p of result.problems) console.log(`${p.line}: ${p.check}: ${p.reason}`);
    if (result.problems.length) {
      console.log(`NG ${result.problems.length} 件（${file}・${course}・${result.rows} 文）`);
      process.exit(1);
    }
    console.log(`OK: ${file}（${course}・${result.rows} 文）`);
    for (const line of statsLines(result.stats, course).slice(1)) console.log(line);
    process.exit(0);
  }

  const data = buildTypingGameData();
  if (argv.includes("--report")) {
    console.log(report(data));
    process.exit(0);
  }
  const bad = validateTypingGameData(data);
  if (bad.length) {
    console.error(`教材の検査に落ちた（${bad.length} 件）:\n  ${bad.slice(0, 40).join("\n  ")}${bad.length > 40 ? `\n  …ほか ${bad.length - 40} 件` : ""}`);
    process.exit(1);
  }
  const counts = COURSE_IDS.map((c) => `${GAME.COURSES[c].name} ${data.courses[c].length}`).join("・");
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : null;
  if (argv.includes("--check")) {
    if (current !== data.text) {
      const have = new Set((current ?? "").split("\n"));
      const want = new Set(data.text.split("\n"));
      const added = data.text.split("\n").filter((l) => !have.has(l)).slice(0, 10);
      const removed = (current ?? "").split("\n").filter((l) => !want.has(l)).slice(0, 10);
      console.error(`data/typing-game.json がずれている（教材を直したら node scripts/build-typing-game.mjs）\n  足りない行: ${added.map((l) => l.trim()).join(" ") || "なし"}\n  余分な行: ${removed.map((l) => l.trim()).join(" ") || "なし"}`);
      process.exit(1);
    }
    console.log(`OK: data/typing-game.json は最新（${counts}）`);
  } else {
    if (current !== data.text) fs.writeFileSync(OUT, data.text);
    console.log(`${current === data.text ? "変更なし" : "書いた"}: data/typing-game.json（${counts}・${(Buffer.byteLength(data.text) / 1024).toFixed(1)}KB）`);
  }
}
