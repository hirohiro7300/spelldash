// タイピング練習の長文（/typing.html の 3 つ目の種類「長文」。docs/SPEC_TYPING.md「長文」）の教材 data/typing-long.json を、
// 元データ scripts/typing-long/ja.jsonl・en.jsonl から作る。
//   node scripts/build-typing-long.mjs                  書き直す（検査に落ちたら書かずに exit 1）
//   node scripts/build-typing-long.mjs --check          生成物と一致・違反 0 か（CI と E2E）。違えば一覧を出して exit 1
//   node scripts/build-typing-long.mjs --lint <file.jsonl> [--lang ja|en]
//                                                       木の外の 1 ファイル（下書き）だけを同じ検査にかけ、違反を 1 行ずつ「行番号: 検査名: 理由」で出す
//                                                       （書かない。違反があれば exit 1）。--lang を省くとファイル名の ja／en から読む。
//                                                       同じ言語の木のファイルの代わりとして見る（重複の相手は もう一方の言語の木のファイルとゲームの文）
//   node scripts/build-typing-long.mjs --blind ja       読みを伏せた jsonl（題の行と {"id","n","t"}。n は文章の中の行番号、0 から）を標準出力に書く
//   node scripts/build-typing-long.mjs --compare <file> 2 人目が r（と alt）を埋めたファイルを (id, n) で突き合わせ、違いを 1 行ずつ出す（違いがあれば exit 1）
//   node scripts/build-typing-long.mjs --report         文章ごとの行数・打鍵、漢字の一覧、kanji.txt と今のパック・ゲームの字の差、読みの区間、英語の語、allow-en.txt
//   node scripts/build-typing-long.mjs --write-kanji    scripts/typing-long/kanji.txt を書き出す（初めの 1 度と、人が直すとき）
//   import { buildTypingLongData, validateTypingLongData, … } from "./build-typing-long.mjs"
//
// 元データ: 1 行 1 つの JSON。題の行 {"id":"ja-s01","title":"北風と太陽","len":"short"} の後に、その文章の行
// （日本語 {"t":"見出し","r":"よみ"}・英語 {"t":"A lion was sleeping under a tree.","ja":"訳"}）。空行と # で始まる行は読み飛ばす。lang は書かない（L1）。
// 補助: scripts/typing-long/kanji.txt（許す漢字）・ambiguous.txt（読みの揺れる 2 字以上の表現）・deny-en.txt（英語の避ける語）・allow-en.txt（語の一覧の外で許す語）、
// scripts/typing-game/deny.txt（日本語の避ける語。ゲームと同じ）。
// 検査の番号 V1〜V14・L1〜L12 は仕様のもの。関数になっている検査（typeable・unitsDrift・kanaOrderMiss）はタイピングゲームの生成器から import し、
// 式を 2 か所に書かない。ゲームの V1・V5・V14 の式は関数でなく、長文は句読点を許すので式も違う: この生成器が自分の表で 1 か所に持つ。
// 英語の語の照合の元（NGSL・CEFR-J の CSV）は照合にだけ使い、生成物に語の一覧を写さない。
//
// 仕様に書いていない所は、いちばん控えめな形で決めた:
// - L3「行の中の「、」は 2 つまで」は行末の 1 つを数えない。「行末に 1 つ」から、句読点で始まる行・句読点が続く行も落とす
// - V5 に「ー はカタカナの後ろだけ」（ー はカタカナ語だけ）。L2 の行の数は §5.2 の表の値（かな・語の数は目安なので見ない）
// - 英語: . ? は行末だけ（1 行 1 文）、行の中の , の後ろは空白 1 つ、1 行目と . ? の次の行は大文字で始まる、, の次の行は小文字で始まる
//   （I・I'm などは例外）、' は語の中に 1 つで n't・'m・'s・'re・'ve・'ll・'d だけ（複数の所有 s' は通さない）、1 語 10 字は英字だけ数える
// - 規則の活用は 4 型どおり（子音を重ねるのは -ing だけ。stopped は NGSL の語形か allow-en.txt）
// - V8 の英語は語ごとの完全一致に加え、規則の活用を外した語幹も見る（killed → kill。部分一致ではないので skill・warm は当たらない）
// - --compare は読みを句読点と空白を除いて比べる（句読点の並びは見出しから決まり、L3 が見る）
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.join(ROOT, "scripts", "typing-long");
const OUT = path.join(ROOT, "data", "typing-long.json");
const KANJI_FILE = path.join(SRC_DIR, "kanji.txt");
const AMBIGUOUS_FILE = path.join(SRC_DIR, "ambiguous.txt");
const DENY_EN_FILE = path.join(SRC_DIR, "deny-en.txt");
const ALLOW_EN_FILE = path.join(SRC_DIR, "allow-en.txt");
const NGSL_FILE = path.join(ROOT, "data", "sources", "ngsl", "NGSL_1.2_lemmatized_for_research.csv");
const CEFRJ_FILE = path.join(ROOT, "data", "sources", "cefrj", "cefrj-vocabulary-profile-1.5.csv");
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

const R = await import(pathToFileURL(path.join(ROOT, "js", "romaji.js")).href);
const T = await import(pathToFileURL(path.join(ROOT, "js", "typingDrill.js")).href);
const BG = await import(pathToFileURL(path.join(ROOT, "scripts", "build-typing-game.mjs")).href);
const PUNCT = { punct: true };

// ---- 数（仕様 §5.2・§5.4。そのまま） ----
export const LANGS = ["ja", "en"];
export const LENS = ["short", "long"];
export const GROUPS = [["ja", "short"], ["ja", "long"], ["en", "short"], ["en", "long"]]; // L11 の並び
export const COUNTS = { "ja:short": 8, "ja:long": 4, "en:short": 5, "en:long": 3 }; // L2 本数
export const FIRST_ID = "ja-s01"; // L11 先頭・既定の 1 編
// L2 手本の打鍵（日本語は句読点を含む手本の長さ、英語は空白と記号を含む字数）と行の数
export const KEY_BANDS = { "ja:short": [320, 480], "ja:long": [750, 1000], "en:short": [320, 480], "en:long": [750, 1000], [FIRST_ID]: [240, 280] };
export const LINE_BANDS = { "ja:short": [6, 14], "ja:long": [18, 30], "en:short": [7, 12], "en:long": [16, 26], [FIRST_ID]: [6, 7] };
export const TITLE_MAX = 12; // L1 題の字数
export const JA = { headMax: 30, kanaMin: 8, kanaMax: 27, unitsMax: 28, commasMax: 2, overKana: 2 }; // §5.4 日本語の 1 行
export const EN = { min: 20, max: 52, wordMax: 10, glossMax: 32, apostrophesMax: 5, allowMax: 3, wrapNarrow: [21, 3], wrapWide: [41, 2] }; // §5.4・L9
export const KANSUJI = "一二三四五六七八九十百千万億〇";
export const KANSUJI_WORDS = ["一つ", "二つ", "三つ", "一人", "二人", "一緒", "一番", "一度"]; // 漢数字はこの 8 語の中だけ（L4）
export const ID_RE = /^(ja|en)-([sl])\d{2}$/;

const READING_RE = /^[ぁ-んー、。]+$/; // V1（ゲームの V1 に句読点を足した形）
const READING_NG_RE = /[ゐゑゎ]/;
const HEAD_RE = /^[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}ー々、。]+$/u; // V5 見出し
const TITLE_RE = /^[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}ー々]+$/u; // L1 題（V5 の字種から句読点を除いたもの）
const GLOSS_RE = /^[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}ー々、。]+$/u; // L8 訳
const KANA_RE = /[\p{sc=Hiragana}\p{sc=Katakana}]/u;
const KATAKANA_RE = /\p{sc=Katakana}/u;
const HAN_RE = /\p{sc=Han}/u;
const PUNCT_RE = /[、。]/g;
const EN_RE = /^[A-Za-z .,'?]+$/; // L6 字種
const I_WORDS = new Set(["i", "i'm", "i'll", "i've", "i'd"]);
const NT_TABLE = { "can't": "can", "won't": "will", "shan't": "shall" }; // ca・wo・sha は語ではない
const VERB_POS = new Set(["verb", "be-verb", "do-verb", "have-verb"]);
const NOUN_POS = new Set(["noun"]);

const stripPunct = (s) => String(s ?? "").replace(PUNCT_RE, "");
const len = (s) => [...String(s ?? "")].length;
const groupOf = (text) => `${text.lang}:${text.len}`;
const bandKey = (text) => (text.id === FIRST_ID ? FIRST_ID : groupOf(text));
const toHiragana = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

// ---- 読み込み ----

function readLines(file) {
  return fs.readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/);
}

// JSONL → { texts: [{ id, title, len, lang, file, line, lines: [{ t, r | ja, line }] }], problems }
export function parseLongJsonl(text, file, lang) {
  const texts = [];
  const problems = [];
  const lineKeys = lang === "en" ? ["t", "ja"] : ["t", "r"];
  let cur = null;
  String(text ?? "")
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = i + 1;
      const s = raw.trim();
      if (s === "" || s.startsWith("#")) return;
      const bad = (reason, id = cur?.id ?? null) => problems.push({ file, line, id, check: "L1 形", reason });
      let obj;
      try {
        obj = JSON.parse(s);
      } catch (e) {
        bad(`JSON として読めない（${e.message}）`);
        return;
      }
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        bad("1 行 1 つのオブジェクトではない");
        return;
      }
      const isTitle = "id" in obj || "title" in obj || "len" in obj;
      const keys = isTitle ? ["id", "title", "len"] : lineKeys;
      const form = isTitle ? '{"id","title","len"}' : `{"${lineKeys.join('","')}"}`;
      const before = problems.length;
      const missing = keys.filter((k) => !(k in obj));
      const extra = Object.keys(obj).filter((k) => !keys.includes(k));
      if (missing.length) bad(`${missing.join("・")} が無い（${isTitle ? "題の行" : "行"}は ${form}）`, isTitle ? obj.id ?? null : undefined);
      if (extra.length) bad(`余分なキー ${extra.join("・")}（${isTitle ? "題の行" : "行"}は ${form}。lang は書かない）`, isTitle ? obj.id ?? null : undefined);
      for (const k of keys) {
        if (!(k in obj)) continue;
        const v = obj[k];
        if (typeof v !== "string") bad(`${k} が文字列ではない`);
        else if (v === "") bad(`${k} が空`);
        else if (v !== v.trim()) bad(`${k} の前後に空白`);
      }
      if (problems.length !== before) {
        if (isTitle) cur = null; // 壊れた題の行の後ろの行は、前の文章に混ぜない
        return;
      }
      if (isTitle) {
        cur = { id: obj.id, title: obj.title, len: obj.len, lang, file, line, lines: [] };
        texts.push(cur);
        return;
      }
      if (!cur) {
        problems.push({ file, line, id: null, check: "L1 形", reason: "題の行（{\"id\",\"title\",\"len\"}）より前に行がある" });
        return;
      }
      cur.lines.push(lang === "en" ? { t: obj.t, ja: obj.ja, line } : { t: obj.t, r: obj.r, line });
    });
  for (const t of texts) if (t.lines.length === 0) problems.push({ file, line: t.line, id: t.id, check: "L1 形", reason: `${t.id} に行が無い` });
  return { texts, problems };
}

// 木の 2 ファイル → { texts（ja → en の順）, problems }
export function loadSources(dir = SRC_DIR) {
  const texts = [];
  const problems = [];
  for (const lang of LANGS) {
    const file = path.join(dir, `${lang}.jsonl`);
    if (!fs.existsSync(file)) {
      problems.push({ file, line: 0, id: null, check: "L1 形", reason: "ファイルが無い" });
      continue;
    }
    const parsed = parseLongJsonl(fs.readFileSync(file, "utf8"), file, lang);
    texts.push(...parsed.texts);
    problems.push(...parsed.problems);
  }
  return { texts, problems };
}

// 1 行 1 語（# の行は注釈）の読み込み → { entries: [{ word, line, rest }], problems }
function loadList(file, check, { required = true } = {}) {
  if (!fs.existsSync(file)) return { entries: [], problems: required ? [{ file, line: 0, id: null, check, reason: `${path.basename(file)} が無い` }] : [] };
  const entries = [];
  readLines(file).forEach((raw, i) => {
    const s = raw.trim();
    if (s === "" || s.startsWith("#")) return;
    const [word, ...rest] = s.split(/\s+/);
    entries.push({ word, line: i + 1, rest });
  });
  return { entries, problems: [] };
}

// kanji.txt → { set | null, problems }。# の行は注釈、ほかの行の漢字をすべて読む（空白は区切り）
export function loadKanji(file = KANJI_FILE) {
  if (!fs.existsSync(file)) return { set: null, problems: [{ file, line: 0, id: null, check: "L4 漢字", reason: "kanji.txt が無い（node scripts/build-typing-long.mjs --write-kanji）" }] };
  const set = new Set();
  const problems = [];
  readLines(file).forEach((raw, i) => {
    const s = raw.trim();
    if (s === "" || s.startsWith("#")) return;
    for (const ch of s.replace(/\s+/g, "")) {
      if (HAN_RE.test(ch)) set.add(ch);
      else problems.push({ file, line: i + 1, id: null, check: "L4 漢字", reason: `漢字でない字「${ch}」` });
    }
  });
  return { set, problems };
}

// ambiguous.txt → { words: [{ word, line }], problems }。2 字以上の表現だけ。deny.txt にある語は重ねない（L5 は ambiguous.txt だけ、V8 は deny.txt だけを見る）
export function loadAmbiguous(file = AMBIGUOUS_FILE, deny = []) {
  const { entries, problems } = loadList(file, "L5 揺れる語");
  const denySet = new Set(deny.map((d) => d.word));
  const words = [];
  for (const e of entries) {
    if (e.rest.length) problems.push({ file, line: e.line, id: null, check: "L5 揺れる語", reason: "1 行に 1 つ" });
    else if (len(e.word) < 2) problems.push({ file, line: e.line, id: null, check: "L5 揺れる語", reason: `「${e.word}」は 1 字（1 字の語は独立の読みで拾う。部分一致で 時間・午後 まで落ちる）` });
    else if (denySet.has(e.word)) problems.push({ file, line: e.line, id: null, check: "L5 揺れる語", reason: `「${e.word}」は scripts/typing-game/deny.txt にある（重ねない）` });
    else words.push({ word: e.word, line: e.line });
  }
  return { words, problems };
}

// deny-en.txt → { words: Map(語 → 行), problems }。英小文字の語を 1 行に 1 つ（loadDeny は漢字もカタカナも含まない語を形の違反にするので使えない）
export function loadDenyEn(file = DENY_EN_FILE) {
  const { entries, problems } = loadList(file, "V8 避ける語");
  const words = new Map();
  for (const e of entries) {
    if (e.rest.length || !/^[a-z]+$/.test(e.word)) problems.push({ file, line: e.line, id: null, check: "V8 避ける語", reason: `「${[e.word, ...e.rest].join(" ")}」は英小文字の語 1 つではない` });
    else if (!words.has(e.word)) words.set(e.word, e.line);
  }
  return { words, problems };
}

// allow-en.txt → { entries: [{ word, id, reason, line }], problems }。1 行に「語 文章のid 理由」
export function loadAllowEn(file = ALLOW_EN_FILE) {
  const { entries, problems } = loadList(file, "L7 英語の語");
  const out = [];
  const seen = new Set();
  for (const e of entries) {
    const [id, ...reason] = e.rest;
    const bad = (reason) => problems.push({ file, line: e.line, id: null, check: "L7 英語の語", reason });
    if (!/^[a-z]+$/.test(e.word) || !id || !ID_RE.test(id) || !id.startsWith("en-") || reason.length === 0) bad(`「語 文章のid 理由」の形ではない（語は英小文字、id は en-s01 の形）`);
    else if (seen.has(`${e.word} ${id}`)) bad(`「${e.word} ${id}」が 2 度ある`);
    else {
      seen.add(`${e.word} ${id}`);
      out.push({ word: e.word, id, reason: reason.join(" "), line: e.line });
    }
  }
  return { entries: out, problems };
}

// CSV の 1 行（引用符の中の , と "" を正しく読む）
function csvRow(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

// 照らす元 → { words: Set（NGSL の語形 ∪ CEFR-J の A1〜B1 の見出し語）, pos: Map（CEFR-J の A1〜B1 の語 → 品詞の Set）, ngsl, cefrj, problems }
let vocabCache = null;
export function loadVocab() {
  if (vocabCache) return vocabCache;
  const problems = [];
  const ngsl = new Set();
  const cefrj = new Set();
  const pos = new Map();
  if (fs.existsSync(NGSL_FILE)) {
    for (const raw of readLines(NGSL_FILE)) {
      const s = raw.trim();
      if (s === "" || s.startsWith("##")) continue;
      for (const w of s.split(",")) if (w.trim()) ngsl.add(w.trim().toLowerCase());
    }
  } else problems.push({ file: NGSL_FILE, line: 0, id: null, check: "L7 英語の語", reason: "NGSL の CSV が無い" });
  if (fs.existsSync(CEFRJ_FILE)) {
    readLines(CEFRJ_FILE).forEach((raw, i) => {
      if (i === 0 || raw.trim() === "") return;
      const [head, p, level] = csvRow(raw);
      if (!["A1", "A2", "B1"].includes(String(level).trim())) return;
      for (const alt of String(head).split("/")) {
        for (const w of alt.trim().toLowerCase().split(/\s+/)) {
          if (!w) continue;
          cefrj.add(w);
          if (!pos.has(w)) pos.set(w, new Set());
          pos.get(w).add(String(p).trim());
        }
      }
    });
  } else problems.push({ file: CEFRJ_FILE, line: 0, id: null, check: "L7 英語の語", reason: "CEFR-J の CSV が無い" });
  vocabCache = { words: new Set([...ngsl, ...cefrj]), pos, ngsl, cefrj, problems };
  return vocabCache;
}

// ゲームの 654 文（L10 の相手）と、ゲームの見出しの漢字（--write-kanji・--report）
export function loadGameRows() {
  return BG.loadSources().rows.map(({ t, r, file, line }) => ({ t, r, file, line }));
}

// 検査に要る物をまとめて読む
export function loadAux() {
  const deny = BG.loadDeny();
  const kanji = loadKanji();
  const ambiguous = loadAmbiguous(AMBIGUOUS_FILE, deny.words);
  const denyEn = loadDenyEn();
  const allowEn = loadAllowEn();
  const vocab = loadVocab();
  return {
    deny: deny.words,
    kanji: kanji.set,
    ambiguous: ambiguous.words,
    denyEn: denyEn.words,
    allowEn: allowEn.entries,
    vocab,
    gameRows: loadGameRows(),
    problems: [...deny.problems.map((p) => ({ ...p, id: null, check: "V8 避ける語" })), ...kanji.problems, ...ambiguous.problems, ...denyEn.problems, ...allowEn.problems, ...vocab.problems]
  };
}

// ---- 1 行の性質 ----

// 手本（句読点を含む。語末の ん は n 1 つだが、長文の行は句読点で終わるので行末の ん は無い）
export const canonOf = (r) => R.canonicalRomaji(r, { finalN: true, punct: true });

// 1 編の打鍵（日本語: 手本の長さの和、英語: 字数の和。行の間の改行は打たない）。打てない行があれば null
export function keysOfText(text) {
  let sum = 0;
  for (const row of text.lines) {
    if (text.lang === "en") sum += len(row.t);
    else {
      const canon = READING_RE.test(row.r ?? "") ? canonOf(row.r) : null;
      if (!canon) return null;
      sum += canon.length;
    }
  }
  return sum;
}

// V7 の (b)(c): 手本どおりに 1 打ずつ打って、毎回 単位のキーの行（済みの typed・今の typed と rest・まだの rest）をつなぐと手本と同じで、かなが空の単位が無い
// （かなだけの比べ（V7 の (a)。ゲームの unitsDrift）ではキーの行のずれを見逃す）
export function unitKeysDrift(r, canon) {
  let typed = "";
  for (let i = 0; ; i++) {
    const { units } = T.japaneseUnits(r, typed, PUNCT);
    const at = typed === "" ? "0 打" : typed;
    const keys = units.map((u) => (u.state === "done" ? u.typed : u.state === "now" ? u.typed + u.rest : u.rest)).join("");
    if (keys !== canon) return `${at} まで打ったときのキーの行が「${keys}」（手本 ${canon}）`;
    const empty = units.findIndex((u) => u.kana === "");
    if (empty >= 0) return `${at} まで打ったとき ${empty + 1} 番目の単位のかなが空`;
    if (i >= canon.length) return null;
    typed += canon[i];
  }
}

// L4: kanji.txt に無い漢字（々 は字種の側で許す）と、8 語の外の漢数字
export function kanjiProblems(s, kanji) {
  const out = [];
  const outside = [...new Set([...s].filter((ch) => HAN_RE.test(ch) && ch !== "々" && kanji && !kanji.has(ch)))];
  if (outside.length) out.push(`kanji.txt に無い漢字 ${outside.join(" ")}（かなで書くか言い換える）`);
  let rest = s;
  for (const w of KANSUJI_WORDS) rest = rest.split(w).join("＿");
  const nums = [...new Set([...rest].filter((ch) => KANSUJI.includes(ch)))];
  if (nums.length) out.push(`漢数字 ${nums.join(" ")} は ${KANSUJI_WORDS.join("・")} の中だけ（ほかは かなで書く）`);
  return out;
}

// L5: ambiguous.txt の語（部分一致）。当たった語と位置（何字目）
export function ambiguousHits(s, ambiguous) {
  const out = [];
  for (const a of ambiguous) {
    let from = 0;
    let at;
    while ((at = s.indexOf(a.word, from)) >= 0) {
      out.push({ word: a.word, at: len(s.slice(0, at)) + 1, line: a.line });
      from = at + a.word.length;
    }
  }
  return out;
}

// V6 の錨（見出しのかなの連なり）で見出しを切り、漢字の並びごとに読みの区間を当てる → [{ kanji, reading }] | null（錨が読みに順に出ない）。
// まず 1 字あたり 1〜4 かなに収まる当て方を探し（錨のかなが漢字の読みの中にも出る「通勤電車で」の で を取り違えない）、無ければ短い方から当てる
export function readingSegments(t, r) {
  const parts = toHiragana(stripPunct(t)).match(/[ぁ-ゖー]+|[^ぁ-ゖー]+/gu) ?? [];
  const reading = stripPunct(r);
  const isKana = (p) => /^[ぁ-ゖー]+$/.test(p);
  const solve = (i, pos, strict) => {
    if (i === parts.length) return pos === reading.length ? [] : null;
    const part = parts[i];
    if (isKana(part)) return reading.startsWith(part, pos) ? solve(i + 1, pos + part.length, strict) : null;
    const k = len(part);
    const next = parts[i + 1];
    const hi = Math.min(reading.length, strict ? pos + 4 * k : reading.length);
    for (let end = pos + (strict ? k : 0); end <= hi; end++) {
      if (next === undefined ? end !== reading.length : !reading.startsWith(next, end)) continue;
      const rest = solve(i + 1, end, strict);
      if (rest) return [{ kanji: part, reading: reading.slice(pos, end) }, ...rest];
    }
    return null;
  };
  return solve(0, 0, true) ?? solve(0, 0, false);
}

// 英語の 1 行の語 → [{ raw（記号を除いた語）, word（小文字）, stem（照らす語） }]。空白と . , ? で分け、' を含む語は n't・'m・'s・'re・'ve・'ll・'d を外す
export function englishWords(t) {
  return String(t ?? "")
    .split(/[ .,?]+/)
    .filter(Boolean)
    .map((raw) => {
      const word = raw.toLowerCase();
      let stem = word;
      if (Object.hasOwn(NT_TABLE, word)) stem = NT_TABLE[word];
      else if (/^[a-z]+n't$/.test(word)) stem = word.slice(0, -3); // don't → do、doesn't → does、couldn't → could
      else if (/^[a-z]+'(?:m|s|re|ve|ll|d)$/.test(word)) stem = word.slice(0, word.indexOf("'")); // I'm → i、it's → it、the mouse's → mouse
      return { raw, word, stem };
    });
}

// 規則の活用 4 型で外した語幹の候補 → [{ base, verbOnly }]（-ed・-d・-ing・-ied は動詞、-s・-es・-ies は動詞か名詞）
export function inflectionBases(w) {
  const out = [];
  const add = (base, verbOnly) => base.length >= 2 && out.push({ base, verbOnly });
  if (/[^s]s$/.test(w)) add(w.slice(0, -1), false); // -s
  if (/es$/.test(w)) add(w.slice(0, -2), false); // -es
  if (/ies$/.test(w)) add(`${w.slice(0, -3)}y`, false); // -ies（y を i に）
  if (/ed$/.test(w)) {
    add(w.slice(0, -2), true); // -ed
    add(w.slice(0, -1), true); // -d（e で終わる語: sparkled → sparkle）
  }
  if (/ied$/.test(w)) add(`${w.slice(0, -3)}y`, true); // -ied
  if (/ing$/.test(w)) {
    const b = w.slice(0, -3);
    add(b, true); // -ing
    add(`${b}e`, true); // e を落とす: making → make
    if (/([b-df-hj-np-tv-z])\1$/.test(b)) add(b.slice(0, -1), true); // 子音を重ねる: running → run
  }
  return out;
}

// L7: 語が照らす元・規則の活用・allow-en.txt のどれかにある → "ngsl" | "cefrj" | "活用" | "allow" | null
export function wordSource(stem, id, vocab, allow) {
  if (vocab.ngsl.has(stem)) return "ngsl";
  if (vocab.cefrj.has(stem)) return "cefrj";
  const allowed = (w) => allow.some((a) => a.word === w && a.id === id);
  if (allowed(stem)) return "allow";
  for (const { base, verbOnly } of inflectionBases(stem)) {
    const p = vocab.pos.get(base);
    if (p && [...p].some((x) => VERB_POS.has(x) || (!verbOnly && NOUN_POS.has(x)))) return "活用";
    if (allowed(base)) return "allow";
  }
  return null;
}

// V8（英語）: 小文字の語ごとの完全一致（部分一致にすると kill⊂skill・war⊂warm が誤って当たる）。規則の活用を外した語幹も同じ語として見る（killed・betting）
export function denyEnHits(t, denyEn) {
  const out = [];
  for (const { stem } of englishWords(t)) {
    const hit = [stem, ...inflectionBases(stem).map((b) => b.base)].find((w) => denyEn.has(w));
    if (hit) out.push({ word: stem, deny: hit, line: denyEn.get(hit) });
  }
  return out;
}

// L9: 語の境目で width 字ごとに折った行の数（空白は行末にぶら下がる。width より長い語は語の途中で折る: overflow-wrap: break-word）
export function wrapCount(t, width) {
  let lines = 0;
  let cur = 0;
  for (const word of String(t ?? "").split(" ")) {
    const w = len(word);
    if (cur > 0 && cur + 1 + w <= width) {
      cur += 1 + w;
      continue;
    }
    lines += cur > 0 ? 1 : 0;
    if (w > width) {
      lines += Math.ceil(w / width) - 1;
      cur = w % width || width;
    } else cur = w;
  }
  return lines + (cur > 0 ? 1 : 0);
}

// ---- 検査 ----
// texts: [{ id, title, len, lang, file, line, lines: [{ t, r | ja, line }], keys?, own? }]。own === false（lint のときの木の文章）は重複と id の相手になるが違反には出さない。
// full: 本数（L2）・先頭の ja-s01（L11）も見る（build と --check。lint では見ない）。generated: 生成物の keys を計算し直して比べる（L12）
export function validateTexts(texts, { full = false, generated = false, aux = loadAux() } = {}) {
  const out = [];
  const push = (text, row, check, reason) => {
    if (text.own !== false) out.push({ file: text.file, line: row ? row.line : text.line, id: text.id, check, reason });
  };
  const { deny, kanji, ambiguous, denyEn, allowEn, vocab, gameRows } = aux;

  // ---- 文章ごと ----
  const ids = new Map();
  for (const text of texts) {
    // L1 形
    const m = ID_RE.exec(String(text.id));
    if (!m) push(text, null, "L1 形", `id「${text.id}」は ja-s01・en-l02 の形ではない`);
    else {
      if (m[1] !== text.lang) push(text, null, "L1 形", `id「${text.id}」の頭が ${m[1]} だが ${text.lang} のファイル（${path.basename(text.file)}）にある`);
      if ((m[2] === "s" ? "short" : "long") !== text.len) push(text, null, "L1 形", `id「${text.id}」の ${m[2]} と len「${text.len}」が合わない（s は short、l は long）`);
    }
    if (!LENS.includes(text.len)) push(text, null, "L1 形", `len「${text.len}」は short か long`);
    const prev = ids.get(text.id);
    if (prev) push(text, null, "L1 形", `id「${text.id}」が ${path.basename(prev.file)}:${prev.line} にもある`);
    else ids.set(text.id, text);
    // L1 題（12 字まで・見出しと同じ検査: V5 の字種から句読点を除いたもの・L4・V8・L5）
    const title = String(text.title);
    if (len(title) > TITLE_MAX) push(text, null, "L1 題", `題「${title}」は ${len(title)} 字（${TITLE_MAX} 字まで）`);
    if (title.normalize("NFKC") !== title || !TITLE_RE.test(title)) push(text, null, "L1 題", `題に使えない字 ${[...title].filter((ch) => !TITLE_RE.test(ch) || ch.normalize("NFKC") !== ch).join(" ")}（漢字・ひらがな・カタカナ・ー・々 だけ。V5）`);
    for (const p of kanjiProblems(title, kanji)) push(text, null, "L1 題", `題: ${p}（L4）`);
    for (const d of deny) if (title.includes(d.word)) push(text, null, "L1 題", `題に「${d.word}」（deny.txt:${d.line}。V8）`);
    for (const h of ambiguousHits(title, ambiguous)) push(text, null, "L1 題", `題の ${h.at} 字目に読みの揺れる「${h.word}」（ambiguous.txt:${h.line}。L5）`);

    if (text.lang === "ja") checkJapanese(text, push, { deny, kanji, ambiguous });
    else checkEnglish(text, push, { deny, kanji, ambiguous, denyEn, allowEn, vocab });

    // L2 長さ（1 編の打鍵・行の数）
    const keys = keysOfText(text);
    const kb = KEY_BANDS[bandKey(text)];
    const lb = LINE_BANDS[bandKey(text)];
    if (keys !== null && kb && (keys < kb[0] || keys > kb[1])) push(text, null, "L2 長さ", `${text.id} の手本は ${keys} 打（${text.id === FIRST_ID ? FIRST_ID : groupOf(text)} は ${kb[0]}〜${kb[1]} 打）`);
    if (lb && (text.lines.length < lb[0] || text.lines.length > lb[1])) push(text, null, "L2 長さ", `${text.id} は ${text.lines.length} 行（${text.id === FIRST_ID ? FIRST_ID : groupOf(text)} は ${lb[0]}〜${lb[1]} 行）`);
    // L12 計算（生成物の keys）
    if (generated && keys !== null && text.keys !== keys) push(text, null, "L12 計算", `keys ${text.keys} が計算し直した ${keys} と違う`);
  }

  // allow-en.txt（L7: 1 編に 3 語まで・知らない id）
  const textIds = new Set(texts.map((t) => t.id));
  const ownEn = texts.some((t) => t.lang === "en" && t.own !== false);
  const perId = new Map();
  for (const a of allowEn) perId.set(a.id, [...(perId.get(a.id) ?? []), a]);
  if (ownEn) {
    for (const [id, list] of perId) {
      if (!textIds.has(id)) out.push({ file: ALLOW_EN_FILE, line: list[0].line, id, check: "L7 英語の語", reason: `id「${id}」の文章が無い` });
      else if (list.length > EN.allowMax) out.push({ file: ALLOW_EN_FILE, line: list[EN.allowMax].line, id, check: "L7 英語の語", reason: `${id} に ${list.length} 語（1 編に ${EN.allowMax} 語まで）: ${list.map((a) => a.word).join(" ")}` });
    }
  }

  // L10 重複（全編とゲームの文をまたぐ。日本語は見出しと読みから「、」「。」を除いて、英語は小文字にし記号を除いて、長文どうしで）
  const seen = new Map();
  const where = (x) => (x.game ? `ゲームの ${path.basename(x.file)}:${x.line}` : `${x.id} の ${path.basename(x.file)}:${x.line}`);
  const mark = (key, entry, text, row, what) => {
    const prev = seen.get(key);
    if (prev) push(text, row, "L10 重複", `${what}が ${where(prev)} と同じ`);
    else seen.set(key, entry);
  };
  for (const g of gameRows) {
    const e = { game: true, file: g.file, line: g.line };
    if (!seen.has(`jt:${stripPunct(g.t)}`)) seen.set(`jt:${stripPunct(g.t)}`, e);
    if (!seen.has(`jr:${stripPunct(g.r)}`)) seen.set(`jr:${stripPunct(g.r)}`, e);
  }
  for (const text of texts) {
    for (const row of text.lines) {
      const e = { id: text.id, file: text.file, line: row.line };
      if (text.lang === "ja") {
        mark(`jt:${stripPunct(row.t)}`, e, text, row, `見出し「${row.t}」（句読点を除いて）`);
        mark(`jr:${stripPunct(row.r)}`, e, text, row, `読み「${row.r}」（句読点を除いて）`);
      } else mark(`en:${String(row.t).toLowerCase().replace(/[.,'?]/g, "").replace(/\s+/g, " ").trim()}`, e, text, row, `文「${row.t}」（小文字・記号を除いて）`);
    }
  }

  // L11 並びと既定（並びは 日本語・短め → 日本語・長め → 英語・短め → 英語・長め、群の中は打鍵の少ない順。ja-s01 が先頭）
  const own = texts.filter((t) => t.own !== false);
  const groupName = (g) => `${GROUPS[g][0] === "ja" ? "日本語" : "英語"}・${GROUPS[g][1] === "short" ? "短め" : "長め"}`;
  let prevGroup = -1;
  let prevKeys = null;
  for (const text of own) {
    const g = GROUPS.findIndex(([lang, l]) => lang === text.lang && l === text.len);
    if (g < 0) continue;
    const keys = keysOfText(text);
    if (g < prevGroup) {
      push(text, null, "L11 並び", `${text.id}（${groupName(g)}）が ${groupName(prevGroup)} の後にある（日本語・短め → 日本語・長め → 英語・短め → 英語・長め）`);
      continue;
    }
    if (g === prevGroup && keys !== null && prevKeys !== null && keys < prevKeys) push(text, null, "L11 並び", `${text.id} の ${keys} 打が前の文章の ${prevKeys} 打より少ない（群の中は打鍵の少ない順）`);
    if (g > prevGroup) {
      prevGroup = g;
      prevKeys = keys;
    } else if (keys !== null) prevKeys = Math.max(prevKeys ?? keys, keys);
  }
  const ownJa = own.filter((t) => t.lang === "ja");
  if (ownJa.length && ownJa[0].id !== FIRST_ID) push(ownJa[0], null, "L11 並び", `日本語の先頭が ${ownJa[0].id}（${FIRST_ID} を先頭に）`);

  if (full) {
    // L2 本数
    for (const [lang, l] of GROUPS) {
      const n = texts.filter((t) => t.lang === lang && t.len === l).length;
      const want = COUNTS[`${lang}:${l}`];
      if (n !== want) out.push({ file: generated ? OUT : path.join(SRC_DIR, `${lang}.jsonl`), line: 0, id: null, check: "L2 長さ", reason: `${lang === "ja" ? "日本語" : "英語"}・${l === "short" ? "短め" : "長め"} が ${n} 編（${want} 編）` });
    }
    if (!texts.some((t) => t.id === FIRST_ID)) out.push({ file: generated ? OUT : path.join(SRC_DIR, "ja.jsonl"), line: 0, id: null, check: "L11 並び", reason: `${FIRST_ID} が無い` });
  }
  return sortProblems(out);
}

function checkJapanese(text, push, { deny, kanji, ambiguous }) {
  text.lines.forEach((row, n) => {
    const { t, r } = row;
    const kana = len(stripPunct(r));
    // V1 読みの字種
    const readingOk = READING_RE.test(r) && !READING_NG_RE.test(r) && r.normalize("NFKC") === r;
    if (!readingOk) {
      const badChars = [...new Set([...r].filter((ch) => !READING_RE.test(ch) || READING_NG_RE.test(ch)))];
      push(text, row, "V1 読みの字種", `読みは ひらがな・ー・「、」「。」だけ（ゐゑゎ も不可）: ${badChars.length ? badChars.map((ch) => (/\s/.test(ch) ? "(空白)" : ch)).join(" ") : "NFKC で変わる字"}`);
    } else {
      const canon = canonOf(r);
      // V2 打ち切れる（句読点も matcher で判定する）
      const ok = BG.typeable(r, canon, PUNCT);
      if (!ok) push(text, row, "V2 打ち切れる", `読み「${r}」を手本 ${canon ?? "(作れない)"} で打ち終えられない`);
      // V14 手本に x・l が無い
      if (canon && /[xl]/.test(canon)) push(text, row, "V14 手本の x・l", `手本 ${canon} に「${/[xl][a-z]*/.exec(canon)[0]}」（句読点の前の っ・単独の小書きかな）`);
      // V7 かなの行・キーの行
      if (ok && canon && !/[xl]/.test(canon)) {
        const drift = BG.unitsDrift(r, canon, PUNCT) ?? unitKeysDrift(r, canon);
        if (drift) push(text, row, "V7 かなの行", drift);
      }
      // V6 見出しのかなの順（句読点は除く）
      const miss = BG.kanaOrderMiss(t, stripPunct(r));
      if (miss) push(text, row, "V6 かなの順", miss);
    }
    // V5 見出しの字種と長さ
    if (t.normalize("NFKC") !== t) push(text, row, "V5 見出し", "NFKC で変わる字がある");
    else if (!HEAD_RE.test(t)) push(text, row, "V5 見出し", `使えない字 ${[...new Set([...t].filter((ch) => !HEAD_RE.test(ch)))].map((ch) => (/\s/.test(ch) ? "(空白)" : ch)).join(" ")}（漢字・ひらがな・カタカナ・ー・々・「、」「。」だけ）`);
    if (len(stripPunct(t)) > kana + JA.overKana) push(text, row, "V5 見出し", `見出し（句読点を除いて）${len(stripPunct(t))} 字 > 読み ${kana} かな＋${JA.overKana}`);
    const chars = [...t];
    chars.forEach((ch, i) => {
      if (ch === "ー" && !(i > 0 && (KATAKANA_RE.test(chars[i - 1]) || chars[i - 1] === "ー"))) push(text, row, "V5 見出し", `${i + 1} 字目の ー がカタカナの後ろにない（ー はカタカナ語だけ）`);
    });
    // V8 避ける語（見出し）
    for (const d of deny) if (t.includes(d.word)) push(text, row, "V8 避ける語", `見出しに「${d.word}」（deny.txt:${d.line}）`);
    // L2 1 行の帯
    if (len(t) > JA.headMax) push(text, row, "L2 長さ", `見出し ${len(t)} 字（${JA.headMax} 字まで）`);
    if (kana < JA.kanaMin || kana > JA.kanaMax) push(text, row, "L2 長さ", `読み ${kana} かな（${JA.kanaMin}〜${JA.kanaMax}）`);
    if (len(r) > JA.unitsMax) push(text, row, "L2 長さ", `かなの字数＋句読点 ${len(r)}（${JA.unitsMax} まで。390・360・320 で単位が 4 行になる）`);
    // L3 句読点
    const tp = t.match(PUNCT_RE) ?? [];
    const rp = r.match(PUNCT_RE) ?? [];
    if (!/[、。]$/.test(t) || !/[、。]$/.test(r)) push(text, row, "L3 句読点", "行末は「。」か「、」（見出しも読みも）");
    if (tp.join("") !== rp.join("")) push(text, row, "L3 句読点", `見出しの句読点「${tp.join("")}」と読みの句読点「${rp.join("")}」の並びが違う`);
    const inner = chars.slice(0, -1);
    const commas = inner.filter((ch) => ch === "、").length;
    if (commas > JA.commasMax) push(text, row, "L3 句読点", `行の中の「、」が ${commas}（行末を除いて ${JA.commasMax} つまで）`);
    if (inner.includes("。") || [...r].slice(0, -1).includes("。")) push(text, row, "L3 句読点", "「。」は行末だけ");
    if (/^[、。]/.test(t) || /^[、。]/.test(r) || /[、。]{2}/.test(t) || /[、。]{2}/.test(r)) push(text, row, "L3 句読点", "句読点で始まる・句読点が続く");
    if (n === text.lines.length - 1 && (!t.endsWith("。") || !r.endsWith("。"))) push(text, row, "L3 句読点", "文章の最後の行は「。」で終わる");
    // L4 漢字・L5 揺れる語
    for (const p of kanjiProblems(t, kanji)) push(text, row, "L4 漢字", p);
    for (const h of ambiguousHits(t, ambiguous)) push(text, row, "L5 揺れる語", `見出しの ${h.at} 字目に「${h.word}」（ambiguous.txt:${h.line}。かなで書くか言い換える）`);
  });
}

function checkEnglish(text, push, { deny, kanji, ambiguous, denyEn, allowEn, vocab }) {
  let apostrophes = 0;
  text.lines.forEach((row, n) => {
    const t = String(row.t);
    const gloss = String(row.ja ?? "");
    const prevEnd = n > 0 ? String(text.lines[n - 1].t).slice(-1) : null;
    const words = englishWords(t);
    // L6 英語の形
    if (!EN_RE.test(t)) push(text, row, "L6 英語の形", `使えない字 ${[...new Set([...t].filter((ch) => !EN_RE.test(ch)))].join(" ")}（英字・空白・. , ' ? だけ。数字は語で書く）`);
    if (/^ | $/.test(t) || / {2}/.test(t)) push(text, row, "L6 英語の形", "空白は語の間に 1 つ（行頭・行末に置かない）");
    if (/ [.,?']/.test(t)) push(text, row, "L6 英語の形", "記号の前に空白");
    if (/,(?! )./.test(t)) push(text, row, "L6 英語の形", "行の中の , の後ろは空白 1 つ");
    if (/[.?]./.test(t)) push(text, row, "L6 英語の形", ". と ? は行末だけ（1 行は 1 文か、長い文を , で切った句）");
    if (!/[.,?]$/.test(t)) push(text, row, "L6 英語の形", "行末は . か ? か ,");
    if (len(t) < EN.min || len(t) > EN.max) push(text, row, "L6 英語の形", `${len(t)} 字（${EN.min}〜${EN.max} 字。空白・記号を含む）`);
    words.forEach(({ raw, word }, i) => {
      if (!/^[A-Za-z]+(?:'[A-Za-z]+)?$/.test(raw)) push(text, row, "L6 英語の形", `語「${raw}」の ' の位置（語の中に 1 つだけ）`);
      else if (raw.includes("'") && !/^[a-z]+n't$/.test(word) && !/^[a-z]+'(?:m|s|re|ve|ll|d)$/.test(word)) push(text, row, "L6 英語の形", `語「${raw}」の '（縮約 n't・'m・'re・'ve・'ll・'d と所有 's だけ）`);
      const letters = raw.replace(/[^A-Za-z]/g, "").length;
      if (letters > EN.wordMax) push(text, row, "L6 英語の形", `語「${raw}」は ${letters} 字（1 語 ${EN.wordMax} 字まで）`);
      // 大文字は行頭（1 行目と、前の行が . ? で終わったとき）と I だけ
      const isI = I_WORDS.has(word);
      const upper = [...raw].map((ch, k) => (/[A-Z]/.test(ch) ? k : -1)).filter((k) => k >= 0);
      const allowedUpper = isI ? [0] : i === 0 ? [0] : [];
      if (upper.some((k) => !allowedUpper.includes(k))) push(text, row, "L6 英語の形", `語「${raw}」の大文字（大文字は文頭と I だけ。固有名詞は出さない）`);
      if (isI && raw[0] === "i") push(text, row, "L6 英語の形", `「${raw}」の i は大文字で書く`);
    });
    apostrophes += (t.match(/'/g) ?? []).length;
    // L3 句読点（文頭の大文字・, の次の行は小文字）
    const first = words[0];
    if (first) {
      const startsSentence = n === 0 || prevEnd === "." || prevEnd === "?";
      const cap = /^[A-Z]/.test(first.raw);
      if (startsSentence && !cap) push(text, row, "L3 句読点", n === 0 ? "1 行目は大文字で始まる" : "前の行が . か ? で終わったので、大文字で始まる");
      if (!startsSentence && cap && !I_WORDS.has(first.word)) push(text, row, "L3 句読点", "前の行が , で終わったので、小文字で始まる");
    }
    if (n === text.lines.length - 1 && !/[.?]$/.test(t)) push(text, row, "L3 句読点", "文章の最後の行は . か ? で終わる");
    // L7 英語の語
    for (const { raw, stem } of words) if (/^[a-z]+$/.test(stem) && !wordSource(stem, text.id, vocab, allowEn)) push(text, row, "L7 英語の語", `語「${raw}」（${stem}）が NGSL・CEFR-J の A1〜B1（＋規則の活用）・allow-en.txt に無い（綴りを確かめるか、言い換えるか、allow-en.txt に「語 ${text.id} 理由」）`);
    // V8 避ける語（英語は語ごとの完全一致）
    for (const h of denyEnHits(t, denyEn)) push(text, row, "V8 避ける語", `文に「${h.word}」（deny-en.txt:${h.line} の ${h.deny}）`);
    // L8 訳
    if (!gloss) push(text, row, "L8 訳", "訳が無い");
    else {
      if (!KANA_RE.test(gloss)) push(text, row, "L8 訳", "訳にかなが無い");
      if (len(gloss) > EN.glossMax) push(text, row, "L8 訳", `訳 ${len(gloss)} 字（${EN.glossMax} 字まで）`);
      if (gloss.normalize("NFKC") !== gloss || !GLOSS_RE.test(gloss)) push(text, row, "L8 訳", `訳に使えない字 ${[...new Set([...gloss].filter((ch) => !GLOSS_RE.test(ch) || ch.normalize("NFKC") !== ch))].join(" ")}（漢字・かな・ー・「、」「。」だけ）`);
      const outside = kanjiProblems(gloss, kanji).filter((p) => p.startsWith("kanji.txt"));
      for (const p of outside) push(text, row, "L8 訳", p);
      for (const d of deny) if (gloss.includes(d.word)) push(text, row, "L8 訳", `訳に「${d.word}」（deny.txt:${d.line}）`);
      for (const h of ambiguousHits(gloss, ambiguous)) push(text, row, "L8 訳", `訳の ${h.at} 字目に読みの揺れる「${h.word}」（ambiguous.txt:${h.line}）`);
    }
    // L9 折り返し（字間 0。21 字で 3 行以内＝320・360・390、41 字で 2 行以内＝720 以上）
    for (const [width, max] of [EN.wrapNarrow, EN.wrapWide]) {
      const lines = wrapCount(t, width);
      if (lines > max) push(text, row, "L9 折り返し", `${width} 字で語の境目で折ると ${lines} 行（${max} 行まで）`);
    }
  });
  if (apostrophes > EN.apostrophesMax) push(text, null, "L6 英語の形", `${text.id} の ' が ${apostrophes}（1 編に ${EN.apostrophesMax} つまで）`);
}

// ファイルの順 → 行 → 検査の番号（L1 → V1 → … → V14 → L2 → … → L12）
function sortProblems(list) {
  const rank = new Map();
  for (const p of list) if (!rank.has(p.file)) rank.set(p.file, rank.size);
  const num = (check) => {
    const m = /^([VL])(\d+)/.exec(check);
    if (!m) return 0;
    return m[1] === "L" && m[2] === "1" ? 0 : m[1] === "V" ? 100 + Number(m[2]) : 200 + Number(m[2]);
  };
  return [...list].sort((a, b) => rank.get(a.file) - rank.get(b.file) || a.line - b.line || num(a.check) - num(b.check) || (a.check < b.check ? -1 : a.check > b.check ? 1 : 0));
}

export const formatProblem = (p) => `${rel(p.file)}${p.line ? `:${p.line}` : ""}: ${p.check}: ${p.reason}`;

// ---- 生成物 ----

const J = (v) => JSON.stringify(v);
function format(texts) {
  if (!texts.length) return `{\n  "v": 1,\n  "texts": []\n}\n`;
  const block = (t) => `    {"id":${J(t.id)},"lang":${J(t.lang)},"len":${J(t.len)},"title":${J(t.title)},"keys":${t.keys},"lines":[\n${t.lines.map((p) => `      ${J(p)}`).join(",\n")}\n    ]}`;
  return `{\n  "v": 1,\n  "texts": [\n${texts.map(block).join(",\n")}\n  ]\n}\n`;
}

// → { text（data/typing-long.json の中身）, data, texts（検査用）, problems（読み込みの違反） }（書かない）
export function buildTypingLongData(dir = SRC_DIR) {
  const { texts, problems } = loadSources(dir);
  const out = texts.map((t) => ({
    id: t.id,
    lang: t.lang,
    len: t.len,
    title: t.title,
    keys: keysOfText(t) ?? 0,
    lines: t.lines.map((row) => [row.t, t.lang === "en" ? row.ja : row.r])
  }));
  return { text: format(out), data: { v: 1, texts: out }, texts, problems };
}

// 生成物（JSON.parse した data/typing-long.json）→ texts（検査用）
function textsFromGenerated(data) {
  const texts = [];
  const problems = [];
  const bad = (reason) => problems.push({ file: OUT, line: 0, id: null, check: "L1 形", reason });
  if (!data || typeof data !== "object" || data.v !== 1 || !Array.isArray(data.texts)) {
    bad("v が 1 でないか texts が配列でない");
    return { texts, problems };
  }
  data.texts.forEach((t, i) => {
    if (!t || typeof t !== "object" || !T.validPairs(t.lines) || !LANGS.includes(t.lang)) {
      bad(`texts[${i}] の形が違う（lang・lines）`);
      return;
    }
    texts.push({ id: t.id, title: t.title, len: t.len, lang: t.lang, keys: t.keys, file: OUT, line: i + 1, lines: t.lines.map(([a, b]) => (t.lang === "en" ? { t: a, ja: b, line: i + 1 } : { t: a, r: b, line: i + 1 })) });
  });
  return { texts, problems };
}

// 違反の一覧（文字列。空なら合格）。build の戻り値でも、生成物（JSON.parse した data/typing-long.json）でもよい
export function validateTypingLongData(data, aux = loadAux()) {
  const built = data && Array.isArray(data.texts) && Array.isArray(data.problems) && typeof data.text === "string";
  const src = built ? { texts: data.texts, problems: data.problems } : textsFromGenerated(data);
  return sortProblems([...src.problems, ...aux.problems, ...validateTexts(src.texts, { full: true, generated: !built, aux })]).map(formatProblem);
}

// 1 ファイルだけ（lint）。同じ言語の木のファイルの代わりとして見る。→ { texts, problems（行ごと） }
export function lintFile(file, lang, dir = SRC_DIR) {
  const abs = path.resolve(file);
  const aux = loadAux();
  const parsed = parseLongJsonl(fs.readFileSync(abs, "utf8"), abs, lang);
  const others = loadSources(dir).texts.filter((t) => t.lang !== lang).map((t) => ({ ...t, own: false }));
  const problems = sortProblems([...parsed.problems, ...aux.problems, ...validateTexts([...others, ...parsed.texts], { aux })]);
  return { texts: parsed.texts, problems };
}

// ---- --blind・--compare ----

// 読みを伏せた jsonl（題の行と {"id","n","t"}）
export function blindText(texts) {
  const lines = [];
  for (const t of texts.filter((x) => x.lang === "ja")) {
    lines.push(J({ id: t.id, title: t.title, len: t.len }));
    t.lines.forEach((row, n) => lines.push(J({ id: t.id, n, t: row.t })));
  }
  return lines.join("\n") + (lines.length ? "\n" : "");
}

// 2 人目のファイル → 違い [{ id, n, check, reason }]。読みは「、」「。」と空白を除いて比べる（句読点の並びは見出しから機械で決まる: L3）
export function compareBlind(texts, text) {
  const out = [];
  const src = new Map();
  for (const t of texts.filter((x) => x.lang === "ja")) t.lines.forEach((row, n) => src.set(`${t.id}|${n}`, { id: t.id, n, t: row.t, r: row.r }));
  const got = new Set();
  String(text ?? "")
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const s = raw.trim();
      if (s === "" || s.startsWith("#")) return;
      let obj;
      try {
        obj = JSON.parse(s);
      } catch {
        out.push({ id: null, n: null, line: i + 1, check: "形", reason: "JSON として読めない" });
        return;
      }
      if (!obj || typeof obj !== "object" || "title" in obj) return; // 題の行
      const key = `${obj.id}|${obj.n}`;
      const at = { id: obj.id ?? null, n: obj.n ?? null, line: i + 1 };
      const mine = src.get(key);
      if (!mine) {
        out.push({ ...at, check: "行", reason: "教材に無い行（id・n を確かめる）" });
        return;
      }
      got.add(key);
      if (obj.t !== mine.t) out.push({ ...at, check: "見出し", reason: `見出しが変わった（教材「${mine.t}」・照合「${obj.t}」。--blind から作り直す）` });
      const norm = (r) => stripPunct(String(r ?? "")).replace(/\s+/g, "");
      if (typeof obj.r !== "string" || obj.r.trim() === "") out.push({ ...at, check: "読み", reason: "r が無い" });
      else if (norm(obj.r) !== norm(mine.r)) {
        const a = readingSegments(mine.t, norm(mine.r));
        const b = readingSegments(mine.t, norm(obj.r));
        const diff = a && b && a.length === b.length ? a.map((x, k) => (x.reading !== b[k].reading ? `${x.kanji}＝${x.reading}／${b[k].reading}` : null)).filter(Boolean) : [];
        out.push({ ...at, check: "読み", reason: `書き手「${mine.r}」・照合「${obj.r}」${diff.length ? `。違う区間: ${diff.join("、")}` : ""}（どちらも選ばず、見出しを書き換えて揺れを消す）` });
      }
      const alt = Array.isArray(obj.alt) ? obj.alt.filter((x) => typeof x === "string" && x.trim()) : [];
      if (alt.length) out.push({ ...at, check: "揺れ", reason: `ほかに読める語 ${alt.join("・")}（読みが一致していても、見出しを書き換えて揺れを消す。2 字以上は ambiguous.txt に足す）` });
    });
  for (const [key, v] of src) if (!got.has(key)) out.push({ id: v.id, n: v.n, line: 0, check: "行", reason: `照合に無い行（${v.t}）` });
  return out;
}

// ---- --report・--write-kanji ----

const hanOf = (s) => [...String(s ?? "")].filter((ch) => HAN_RE.test(ch));

// 今のパック（小・中学校）とゲームの見出しの漢字。パックが読めなければ null（黙って「制限なし」にしない）
export function currentKanji() {
  const school = BG.schoolKanji();
  if (!school) return null;
  const game = new Set(loadGameRows().flatMap((row) => hanOf(row.t)));
  return { school, game, all: new Set([...school, ...game]) };
}

function kanjiFileText(set) {
  const chars = [...set].sort((a, b) => a.codePointAt(0) - b.codePointAt(0));
  const rows = [];
  for (let i = 0; i < chars.length; i += 40) rows.push(chars.slice(i, i + 40).join(""));
  return [
    "# 長文の見出し・題・訳に使ってよい漢字（scripts/build-typing-long.mjs の L4・L1・L8）。",
    "# 初めに 1 度だけ --write-kanji で、小・中学校のパックの用語・問題文に出る字（build-typing-game.mjs の schoolKanji）と",
    "# タイピングゲームの見出しに出る字から書き出した。パックやゲームの教材を直しても、この集合は動かない（関係の無い PR で長文の --check が落ちない）。",
    "# 今のパック・ゲームとの差は --report に出る。直すのは人（足す・消す）。# で始まる行は注釈。",
    `# ${chars.length} 字`,
    ...rows
  ].join("\n") + "\n";
}

export function report(built, aux = loadAux()) {
  const cur = currentKanji();
  if (!cur) return null;
  const lines = [];
  const { texts } = built;
  lines.push(`文章 ${texts.length} 編:`);
  for (const t of texts) {
    const keys = keysOfText(t);
    const extra = t.lang === "ja" ? `かな ${t.lines.reduce((n, row) => n + len(stripPunct(row.r)), 0)}` : `語 ${t.lines.reduce((n, row) => n + englishWords(row.t).length, 0)}`;
    lines.push(`  ${t.id} ${t.len} ${t.title}: ${t.lines.length} 行・${keys ?? "-"} 打・${extra}`);
  }
  const freq = new Map();
  for (const t of texts) for (const s of [t.title, ...t.lines.flatMap((row) => (t.lang === "ja" ? [row.t] : [row.ja]))]) for (const ch of hanOf(s)) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  lines.push(`漢字 ${sorted.length} 種（見出し・題・訳。頻度順。* は kanji.txt に無い字）:`);
  for (let i = 0; i < sorted.length; i += 20) lines.push("  " + sorted.slice(i, i + 20).map(([ch, n]) => `${aux.kanji && !aux.kanji.has(ch) ? "*" : ""}${ch}${n}`).join(" "));
  const kanji = aux.kanji ?? new Set();
  const gone = [...kanji].filter((ch) => !cur.all.has(ch)).sort();
  const added = [...cur.all].filter((ch) => !kanji.has(ch)).sort();
  lines.push(`kanji.txt ${kanji.size} 字・今のパック ${cur.school.size} 字とゲーム ${cur.game.size} 字の和 ${cur.all.size} 字`);
  lines.push(`  パック・ゲームから消えた字（kanji.txt にだけある） ${gone.length}: ${gone.join(" ") || "なし"}`);
  lines.push(`  新しく増えた字（kanji.txt に無い） ${added.length}: ${added.join(" ") || "なし"}`);
  lines.push("見出しの漢字の並びごとの読みの区間（V6 の錨で切る。!0 は 0 かな、!5 は 1 字あたり 5 かな以上。判断は人）:");
  for (const t of texts.filter((x) => x.lang === "ja")) {
    t.lines.forEach((row, n) => {
      const seg = readingSegments(row.t, row.r);
      if (!seg) {
        lines.push(`  ${t.id} ${n}: 錨が読みに順に出ない（${row.t}／${row.r}）`);
        return;
      }
      const parts = seg.map((s) => {
        const k = len(s.kanji);
        const m = len(s.reading);
        return `${m === 0 ? "!0 " : m / k >= 5 ? "!5 " : ""}${s.kanji}＝${s.reading}`;
      });
      if (parts.length) lines.push(`  ${t.id} ${n}: ${parts.join("・")}`);
    });
  }
  const words = new Map();
  for (const t of texts.filter((x) => x.lang === "en")) for (const row of t.lines) for (const { stem } of englishWords(row.t)) {
    const w = words.get(stem) ?? { n: 0, src: wordSource(stem, t.id, aux.vocab, aux.allowEn) ?? "無い" };
    w.n++;
    words.set(stem, w);
  }
  const ws = [...words.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  lines.push(`英語の語 ${ws.length} 種（語 回数 出どころ）:`);
  for (let i = 0; i < ws.length; i += 8) lines.push("  " + ws.slice(i, i + 8).map(([w, x]) => `${w} ${x.n} ${x.src}`).join("・"));
  lines.push(`allow-en.txt ${aux.allowEn.length} 語:`);
  for (const a of aux.allowEn) lines.push(`  ${a.word} ${a.id} ${a.reason}`);
  return lines.join("\n");
}

// ---- CLI ----

function usage() {
  console.error(
    [
      "使い方:",
      "  node scripts/build-typing-long.mjs                        data/typing-long.json を書く（検査に落ちたら書かない）",
      "  node scripts/build-typing-long.mjs --check                生成物が最新で違反 0 か（CI）",
      "  node scripts/build-typing-long.mjs --lint <file> [--lang ja|en]  1 ファイルだけ検査（書かない）。行番号: 検査名: 理由",
      "  node scripts/build-typing-long.mjs --blind ja             読みを伏せた jsonl を標準出力に",
      "  node scripts/build-typing-long.mjs --compare <file>       2 人目の読みと突き合わせる",
      "  node scripts/build-typing-long.mjs --report               行数・打鍵・漢字・読みの区間・英語の語・allow-en.txt",
      "  node scripts/build-typing-long.mjs --write-kanji          scripts/typing-long/kanji.txt を書き出す"
    ].join("\n")
  );
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const valued = new Set(["--lint", "--lang", "--blind", "--compare"]);
  const known = new Set([...valued, "--check", "--report", "--write-kanji"]);
  const valueOf = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] ?? null : null;
  };
  const stray = argv.filter((a, i) => (a.startsWith("--") ? !known.has(a) : !valued.has(argv[i - 1])));
  const modes = ["--check", "--lint", "--blind", "--compare", "--report", "--write-kanji"].filter((f) => argv.includes(f));
  if (stray.length || modes.length > 1) usage();

  if (argv.includes("--write-kanji")) {
    const cur = currentKanji();
    if (!cur) {
      console.error("小・中学校のパックが読めない（data/manifest.json）。kanji.txt を書かない（黙って「制限なし」にしない）");
      process.exit(1);
    }
    const textOut = kanjiFileText(cur.all);
    const before = fs.existsSync(KANJI_FILE) ? fs.readFileSync(KANJI_FILE, "utf8") : null;
    if (before !== textOut) fs.writeFileSync(KANJI_FILE, textOut);
    console.log(`${before === textOut ? "変更なし" : "書いた"}: ${rel(KANJI_FILE)}（${cur.all.size} 字: パック ${cur.school.size} 字・ゲーム ${cur.game.size} 字の和）`);
    process.exit(0);
  }

  if (argv.includes("--lint")) {
    const file = valueOf("--lint");
    if (!file || file.startsWith("--")) usage();
    if (!fs.existsSync(file)) {
      console.error(`ファイルが無い: ${file}`);
      process.exit(2);
    }
    let lang = valueOf("--lang");
    if (lang && !LANGS.includes(lang)) {
      console.error(`--lang は ja|en（${lang}）`);
      process.exit(2);
    }
    if (!lang) {
      const m = /(?:^|[^a-z])(ja|en)(?:[^a-z]|$)/i.exec(path.basename(file));
      if (!m) {
        console.error("言語が分からない: --lang ja|en を付ける（ファイル名に ja・en があれば省ける）");
        process.exit(2);
      }
      lang = m[1].toLowerCase();
    }
    const result = lintFile(file, lang);
    // そのファイルの違反は「行番号: 検査名: 理由」、補助ファイル（kanji.txt など）の違反はパスつき
    for (const p of result.problems) console.log(path.resolve(p.file) === path.resolve(file) ? `${p.line}: ${p.check}: ${p.reason}` : formatProblem(p));
    const lines = result.texts.reduce((n, t) => n + t.lines.length, 0);
    if (result.problems.length) {
      console.log(`NG ${result.problems.length} 件（${file}・${lang}・${result.texts.length} 編・${lines} 行）`);
      process.exit(1);
    }
    console.log(`OK: ${file}（${lang}・${result.texts.length} 編・${lines} 行）`);
    for (const t of result.texts) console.log(`  ${t.id} ${t.title}: ${t.lines.length} 行・${keysOfText(t)} 打`);
    process.exit(0);
  }

  const built = buildTypingLongData();

  if (argv.includes("--blind")) {
    if (valueOf("--blind") !== "ja") usage();
    process.stdout.write(blindText(built.texts));
    process.exit(0);
  }

  if (argv.includes("--compare")) {
    const file = valueOf("--compare");
    if (!file || file.startsWith("--")) usage();
    if (!fs.existsSync(file)) {
      console.error(`ファイルが無い: ${file}`);
      process.exit(2);
    }
    const diffs = compareBlind(built.texts, fs.readFileSync(file, "utf8"));
    for (const d of diffs) console.log(`${d.id ?? "-"} ${d.n ?? "-"}${d.line ? `（${path.basename(file)}:${d.line}）` : ""}: ${d.check}: ${d.reason}`);
    if (diffs.length) {
      console.log(`違い ${diffs.length} 件`);
      process.exit(1);
    }
    console.log("OK: 読みは一致し、ほかに読める語も無い");
    process.exit(0);
  }

  if (argv.includes("--report")) {
    const text = report(built);
    if (text === null) {
      console.error("小・中学校のパックが読めない（data/manifest.json）。--report を出さない");
      process.exit(1);
    }
    console.log(text);
    process.exit(0);
  }

  const bad = validateTypingLongData(built);
  if (bad.length) {
    console.error(`長文の教材の検査に落ちた（${bad.length} 件）:\n  ${bad.slice(0, 60).join("\n  ")}${bad.length > 60 ? `\n  …ほか ${bad.length - 60} 件` : ""}`);
    process.exit(1);
  }
  const counts = GROUPS.map(([lang, l]) => `${lang === "ja" ? "日本語" : "英語"}・${l === "short" ? "短め" : "長め"} ${built.data.texts.filter((t) => t.lang === lang && t.len === l).length}`).join("・");
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : null;
  if (argv.includes("--check")) {
    if (current !== built.text) {
      const have = new Set((current ?? "").split("\n"));
      const want = new Set(built.text.split("\n"));
      const added = built.text.split("\n").filter((l) => !have.has(l)).slice(0, 10);
      const removed = (current ?? "").split("\n").filter((l) => !want.has(l)).slice(0, 10);
      console.error(`data/typing-long.json がずれている（教材を直したら node scripts/build-typing-long.mjs）\n  足りない行: ${added.map((l) => l.trim()).join(" ") || "なし"}\n  余分な行: ${removed.map((l) => l.trim()).join(" ") || "なし"}`);
      process.exit(1);
    }
    console.log(`OK: data/typing-long.json は最新（${counts}）`);
  } else {
    if (current !== built.text) fs.writeFileSync(OUT, built.text);
    console.log(`${current === built.text ? "変更なし" : "書いた"}: data/typing-long.json（${counts}・${(Buffer.byteLength(built.text) / 1024).toFixed(1)}KB）`);
  }
}
