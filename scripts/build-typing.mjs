// タイピング練習（/typing.html）の教材 data/typing.json を、パック（data/english・data/packs）から作る。
//   node scripts/build-typing.mjs          書き直す
//   node scripts/build-typing.mjs --check  生成物とファイルが違う・条件を満たさない語があれば一覧を出して exit 1（CI と E2E）
//   import { buildTypingData } from "./build-typing.mjs"  → { text, en, ja }（書かない。E2E が数を確かめる）
//
// 選び方（docs/SPEC_TYPING.md「教材」）:
//   英単語: manifest の english の並び順に、自作の単語帳（source の無いファイル）の語で、a〜z の 3〜8 字・level が easy か normal・
//           訳が 12 字以下で「略」を含まないもの。同じ綴りは先に出た方。群 EXCLUDE_EN は外す（下の注釈）
//   日本語: concept の群のうち group が「小学校」「中学校」で始まるものの用語で、主な読みが 3〜10 かな・標準の綴りで打ち終えられ、
//           答えが かな・ー・・・＝ だけではない（用語の行とかなの行が同じ字になる）もの。同じ答えは先に出た方
// パックの語・訳・読みを直したら作り直す（ずれると --check と E2E が落ちる）。
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "data", "typing.json");

// 外す英単語の群（カテゴリ id）。level はパックの中の相対の難しさなので、群で外さないと難しい語・専門の訳が残る
//   ads      … 広告・マーケ。ここにしか無い語は広告の専門の訳のまま出る（exact=完全一致（マッチタイプ）・rank=広告ランク など）
//   eikenp1・eiken1 … 英検準1級・1級（haughty・obstinate・banal が normal／easy に入っている）
//   toeic860・toeic990 … TOEIC 上級（latency=（通信の）遅延 など）
export const EXCLUDE_EN = ["ads", "eikenp1", "eiken1", "toeic860", "toeic990"];
export const MIN_EN = 900;
export const MIN_JA = 600;
const EN_RE = /^[a-z]{3,8}$/;
const KANA_ONLY_RE = /^[ぁ-ゖァ-ヶー・＝]+$/;

const R = await import(pathToFileURL(path.join(ROOT, "js", "romaji.js")).href);
const { readingEntries, primaryReading, hasJapaneseScript, canonicalRomaji, createRomajiMatcher, normalizeReading } = R;

function loadJson(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "data", file), "utf8"));
}

function categories() {
  const manifest = loadJson("manifest.json");
  return (manifest.subjects ?? []).flatMap((s) => s.categories ?? []);
}

const glossOk = (ja) => ja !== "" && [...ja].length <= 12 && !ja.includes("略");

// 英単語の候補になる群（EXCLUDE_EN の外の、自作の単語帳）
function enSources(cats) {
  const out = [];
  for (const c of cats) {
    if (!c.file || c.kind === "concept" || EXCLUDE_EN.includes(c.id)) continue;
    const data = loadJson(c.file);
    if ((data.cardType && data.cardType !== "word") || data.source) continue;
    out.push({ id: c.id, words: data.words ?? [] });
  }
  return out;
}

function pickEnglish(cats) {
  const en = new Map();
  for (const { words } of enSources(cats)) {
    for (const w of words) {
      if (w.kind === "concept" || !EN_RE.test(String(w.en ?? ""))) continue;
      if (w.level !== "easy" && w.level !== "normal") continue;
      const ja = String(w.ja ?? "").trim();
      if (!glossOk(ja) || en.has(w.en)) continue;
      en.set(w.en, [w.en, ja]);
    }
  }
  return [...en.values()];
}

function jaGroup(c) {
  const group = String(c.group ?? "");
  return c.file && c.kind === "concept" && (group.startsWith("小学校") || group.startsWith("中学校"));
}

// 標準の綴り（語末の ん は n 1 つ）で打ち終えられるか
function typeable(entry) {
  const canon = canonicalRomaji(entry.reading ?? entry, { finalN: true });
  if (!canon) return false;
  const m = createRomajiMatcher([entry]);
  return m.type(canon).missAt === -1 && m.state().done;
}

function pickJapanese(cats) {
  const ja = new Map();
  for (const c of cats) {
    if (!jaGroup(c)) continue;
    for (const w of loadJson(c.file).words ?? []) {
      if (w.kind !== "concept" || w.kanjiOnly || w.calc || !hasJapaneseScript(w.answer)) continue;
      const p = primaryReading(readingEntries(w));
      if (!p || !/^[ぁ-ゖー]+$/.test(p.reading)) continue;
      const len = [...p.reading].length;
      if (len < 3 || len > 10) continue;
      const answer = String(w.answer);
      if ([...answer].length > 12 || KANA_ONLY_RE.test(answer)) continue;
      if (!typeable(p) || ja.has(answer)) continue;
      ja.set(answer, [answer, p.display]);
    }
  }
  return [...ja.values()];
}

// 1 語 1 行（差分を読みやすくする）
function format(en, ja) {
  const rows = (list) => list.map((x) => `    ${JSON.stringify(x)}`).join(",\n");
  return `{\n  "v": 1,\n  "en": [\n${rows(en)}\n  ],\n  "ja": [\n${rows(ja)}\n  ]\n}\n`;
}

export function buildTypingData() {
  const cats = categories();
  const en = pickEnglish(cats);
  const ja = pickJapanese(cats);
  return { text: format(en, ja), en, ja };
}

// 条件を満たさない語の一覧（空なら合格）。E2E と --check が使う
export function validateTypingData({ en, ja }) {
  const bad = [];
  const cats = categories();
  // EXCLUDE_EN の群にしか無い語が入っていない（入れてよい語 = 外していない自作の単語帳にある語）
  const allowed = new Set(enSources(cats).flatMap(({ words }) => words.map((w) => String(w.en ?? ""))));
  const seenEn = new Set();
  for (const pair of en) {
    const [word, gloss] = Array.isArray(pair) ? pair : [];
    if (typeof word !== "string" || !EN_RE.test(word)) bad.push(`en: 綴り ${word}`);
    else if (seenEn.has(word)) bad.push(`en: 重複 ${word}`);
    else if (!allowed.has(word)) bad.push(`en: 外す群にしか無い ${word}`);
    seenEn.add(word);
    if (typeof gloss !== "string" || !glossOk(gloss.trim()) || gloss !== gloss.trim()) bad.push(`en: 訳 ${word}=${gloss}`);
  }
  if (en.length < MIN_EN) bad.push(`en: ${en.length} 語（${MIN_EN} 語以上）`);
  const seenJa = new Set();
  for (const pair of ja) {
    const [answer, reading] = Array.isArray(pair) ? pair : [];
    const norm = normalizeReading(reading ?? "");
    if (typeof answer !== "string" || answer === "" || KANA_ONLY_RE.test(answer) || [...answer].length > 12) bad.push(`ja: 答え ${answer}`);
    else if (seenJa.has(answer)) bad.push(`ja: 重複 ${answer}`);
    seenJa.add(answer);
    if (typeof reading !== "string" || !/^[ぁ-ゖァ-ヶー]+$/.test(reading)) bad.push(`ja: 読み ${answer}=${reading}`);
    else if ([...norm].length < 3 || [...norm].length > 10) bad.push(`ja: 読みの長さ ${answer}=${reading}`);
    else if (!typeable({ reading, display: reading })) bad.push(`ja: 打ち終えられない ${answer}=${reading}`);
  }
  if (ja.length < MIN_JA) bad.push(`ja: ${ja.length} 語（${MIN_JA} 語以上）`);
  return bad;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const data = buildTypingData();
  const bad = validateTypingData(data);
  if (bad.length) {
    console.error(`教材の条件を満たさない語がある:\n  ${bad.slice(0, 20).join("\n  ")}`);
    process.exit(1);
  }
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : null;
  if (check) {
    if (current !== data.text) {
      const have = new Set((current ?? "").split("\n"));
      const want = new Set(data.text.split("\n"));
      const added = data.text.split("\n").filter((l) => !have.has(l)).slice(0, 10);
      const removed = (current ?? "").split("\n").filter((l) => !want.has(l)).slice(0, 10);
      console.error(`data/typing.json がずれている（教材を直したら node scripts/build-typing.mjs）\n  足りない行: ${added.join(" ") || "なし"}\n  余分な行: ${removed.join(" ") || "なし"}`);
      process.exit(1);
    }
    console.log(`OK: data/typing.json は最新（英 ${data.en.length} 語・日 ${data.ja.length} 語）`);
  } else {
    if (current !== data.text) fs.writeFileSync(OUT, data.text);
    console.log(`${current === data.text ? "変更なし" : "書いた"}: data/typing.json（英 ${data.en.length} 語・日 ${data.ja.length} 語・${(Buffer.byteLength(data.text) / 1024).toFixed(1)}KB）`);
  }
}
