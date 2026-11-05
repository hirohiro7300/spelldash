// ===== マイ単語帳の決まり（Batch 79。純関数: DOM・localStorage・時刻を持たない。scripts/test-my-words.mjs が Node から直に読む） =====
// 仕様は docs/SPEC_MY_WORDS.md。保存（spelldash_my_words の読み書き・同期の印）は js/myWords.js、画面は js/myWordsPage.js、学ぶ回は js/game.js。
//
// 1 語の形（spelldash_my_words の配列の要素。前からの形はそのまま読める）:
//   en     鍵。英語を小文字にした形（語の間の空白は 1 つ）。カードの id は my-<en>（前からの語の id は変わらない）
//   ja     日本語訳
//   text   画面に出す形（大文字を含むときだけ。KPI・Due Diligence）。小文字にすると en と同じ
//   addedAt 足した時刻
//   ls・lsd・lsAt  マイ単語帳だけの 3 状態（これから・あやふや・覚えた）。js/learnState.js の語の記録と同じ欄の名前と同じ決まり（applyLearnAnswer）。
//          語の記録（spelldash_word_stats）には書かない: 公開の語の 3 状態・6 つの数・ランク・最高到達ランクに入らない。
//          語と一緒に同期の項目（user_items の my_word。表があるときだけ）に乗る
//   book   入っている単語帳の id（Batch 81）。無い（前からの語）・知らない id（ほかの端末で作った単語帳）は最初の単語帳の語として読む（書き直さない）。
//          語と一緒に同期の項目 my_word の payload に乗る（新しい種類・SQL は足さない）。単語帳の一覧（名前）は端末の中だけ（spelldash_my_books）
// 場面カード（kind: "concept"。前の単語帳で作ったもの）はそのまま残す。学ぶ回と 3 状態の数には入れない。
//
// 入れられる英語: 英字・数字・ハイフン・アポストロフィ・空白（語の間に 1 つ）。英字を 1 つ以上。150 字まで（Batch 81。前は 40 字）。訳も 150 字まで。
//   英小文字だけの 40 字までの語は 1 字ずつ判定（画面キーボードの a〜z で打てる。大文字は小文字で打てばよい: KPI → kpi）。41 字以上は全文入力。
//   空白・ハイフン・アポストロフィ・数字を含む語は全文入力（Enter で判定。js/judge.js normalizeAnswer: 大文字小文字・空白・ハイフン・アポストロフィを見ない）。
//   全文入力の語は端末のキーボードで打つ（画面キーボードは a〜z と空白だけで、ハイフン・数字・アポストロフィが無い）

import { LEARN_NEW, LEARN_UNSURE, LEARN_LEARNED, storedState, applyLearnAnswer } from "./learnState.js";

export const MY_EN_MAX = 150; // Batch 81（前は 40）
export const MY_JA_MAX = 150; // Batch 81（前は 40）
export const MY_SPELL_MAX = 40; // 英字だけの語を 1 字ずつ判定する長さの上限（前の上限と同じ: 前からの語の打ち方は変わらない）。長い語は全文入力
export const MY_SET_SIZE = 10; // 1 回 10 語
export const MY_FREE_LIMIT = 100;
export const MY_PRO_LIMIT = 1000;
export const MY_ID_PREFIX = "my-";

// 使える字（NFKC と ’ → ' の後）。頭は英字か数字
const EN_CHARS = /^[a-z0-9][a-z0-9' -]*$/i;

// 打った英語を保存の形へ: 全角の英数字は半角に（NFKC）、’ ‘ は '、空白の並びは 1 つ、前後の空白は落とす
export function cleanEnText(raw) {
  return String(raw ?? "")
    .normalize("NFKC")
    .replace(/[’‘`]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// 英語の形を確かめる。{ ok, text（画面の形）, key（鍵 = 小文字） } か { ok: false, error }
export function checkEnText(raw) {
  const text = cleanEnText(raw);
  if (!text) return { ok: false, error: "英語を入力してください" };
  if (text.length > MY_EN_MAX) return { ok: false, error: `英語が長すぎます（${MY_EN_MAX}文字まで）` };
  if (!EN_CHARS.test(text) || !/[a-z]/i.test(text)) return { ok: false, error: `「${text}」は使えない字を含みます（英字・数字・ハイフン・アポストロフィ・空白だけ）` };
  return { ok: true, text, key: text.toLowerCase() };
}

// 日本語訳の形を確かめる
export function checkJaText(raw) {
  const ja = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!ja) return { ok: false, error: "日本語訳を入力してください" };
  if (ja.length > MY_JA_MAX) return { ok: false, error: `日本語訳が長すぎます（${MY_JA_MAX}文字まで）` };
  return { ok: true, ja };
}

// 英語と訳の 1 語（場面カードでない）か
export function isWordEntry(w) {
  return !!w && typeof w.en === "string" && !!w.en && w.kind !== "concept" && !!w.ja;
}

// 画面に出す形（text が鍵と同じ綴りのときだけ。違えば鍵）
export function displayOf(w) {
  const text = typeof w?.text === "string" ? w.text : "";
  return text && text.toLowerCase() === w.en ? text : String(w?.en ?? "");
}

// 1 字ずつ判定できる鍵か（英小文字だけで 40 字まで）。それ以外（長い語も）は全文入力
export function isSpellKey(key) {
  const k = String(key ?? "");
  return k.length <= MY_SPELL_MAX && /^[a-z]+$/.test(k);
}

// 出題のカード（js/myWords.js toWordObjects の英語の語）。前からの語（英小文字とハイフン）の id・en・ja は前と同じ
export function wordCardOf(w) {
  const text = displayOf(w);
  return {
    id: `${MY_ID_PREFIX}${w.en}`,
    en: w.en,
    ja: w.ja,
    ...(text !== w.en ? { answer: text } : {}),
    ...(isSpellKey(w.en) ? {} : { free: true }),
    level: "easy",
    tags: ["my"],
    subject: "english",
    category: "my",
    addedAt: w.addedAt ?? null
  };
}

// まとめて追加の 1 行。「english, 訳」「english<TAB>訳」（全角の読点も可）。区切りが無ければ、英語の部分と日本語の部分の境で分ける
// （due diligence 適正評価）。それも無ければ最初の空白で分ける。場面カードの行（→）は呼ぶ側（js/myWords.js parseBulk）
export function parseWordLine(line) {
  const unquote = (s) => s.trim().replace(/^"(.*)"$/, "$1");
  const sep = line.search(/[,、\t]/);
  if (sep > 0) return { en: unquote(line.slice(0, sep)), ja: unquote(line.slice(sep + 1)) };
  const mixed = line.match(/^([\x20-\x7e]*[a-z0-9'])\s+([^\x00-\x7f].*)$/i);
  if (mixed) return { en: mixed[1].trim(), ja: mixed[2].trim() };
  const m = line.match(/^(\S+)\s+(.+)$/);
  return m ? { en: m[1], ja: m[2].trim() } : { en: line, ja: "" };
}

// ===== 3 状態（マイ単語帳だけ。公開の語と同じ決まり: js/learnState.js applyLearnAnswer） =====

export function myStateOf(w) {
  return storedState(w) ?? LEARN_NEW;
}

// 1 問の答えを語に当てる（純）。kind = js/learnState.js ANSWER_KINDS の値。返り値は写した語（ls・lsd・lsAt だけを替える）。
// 目安の印 lsf は付けない（公開の語の目安だけの欄）
export function applyMyAnswer(w, kind, nowMs) {
  const stat = { lsf: 0 };
  if (w?.ls !== undefined) stat.ls = w.ls;
  if (w?.lsd !== undefined) stat.lsd = w.lsd;
  const out = applyLearnAnswer(stat, kind, nowMs);
  const next = { ...w, ls: out.ls, lsAt: out.lsAt };
  if (out.lsd === undefined) delete next.lsd;
  else next.lsd = out.lsd;
  return next;
}

// 3 状態の数（英語の語だけ。場面カードは数えない）。new + unsure + learned = total
export function countMyStates(list) {
  const out = { new: 0, unsure: 0, learned: 0, total: 0 };
  for (const w of Array.isArray(list) ? list : []) {
    if (!isWordEntry(w)) continue;
    out.total++;
    const s = myStateOf(w);
    if (s === LEARN_LEARNED) out.learned++;
    else if (s === LEARN_UNSURE) out.unsure++;
    else out.new++;
  }
  return out;
}

const ORDER = [LEARN_NEW, LEARN_UNSURE, LEARN_LEARNED];

// 語 → カードの id（マイ単語帳は my-<鍵>。スラング〔Batch 80。js/slang.js〕は項目の id を渡す）
const myIdOf = (w) => `${MY_ID_PREFIX}${w.en}`;

// 学ぶ回の列（カードの id）: これから → あやふや → 覚えた。これからは足した順、あやふや・覚えたは最後に答えた時刻（lsAt）の古い順、同じなら足した順
export function buildMyQueue(list, idOf = myIdOf) {
  return (Array.isArray(list) ? list : [])
    .map((w, pos) => ({ w, pos }))
    .filter(({ w }) => isWordEntry(w))
    .map(({ w, pos }) => {
      const st = myStateOf(w);
      return { id: idOf(w), rank: ORDER.indexOf(st), at: st === LEARN_NEW ? 0 : Number.isFinite(w.lsAt) ? w.lsAt : 0, pos };
    })
    .sort((a, b) => a.rank - b.rank || a.at - b.at || a.pos - b.pos)
    .map((x) => x.id);
}

// 次の一手（js/learnQueue.js learnStep と同じ名前の値）: done（出せる語が無い）・set（10 語の終わり）・play
export function myLearnStep({ setAnswered, more }) {
  if (!more) return "done";
  if (setAnswered >= MY_SET_SIZE) return "set";
  return "play";
}

// 回の結果（答えた語の今の状態から。同じ語は 1 回）。ids = カードの id、list = 今の語の並び、today = 今日の日番号、idOf = 語 → カードの id
export function mySummary(ids, list, today, idOf = myIdOf) {
  const byId = new Map();
  for (const w of Array.isArray(list) ? list : []) if (isWordEntry(w)) byId.set(idOf(w), w);
  let learned = 0;
  let unsure = 0;
  let dayOne = 0;
  for (const id of new Set(ids)) {
    const w = byId.get(id);
    if (!w) continue;
    const s = myStateOf(w);
    if (s === LEARN_LEARNED) learned++;
    else if (s === LEARN_UNSURE) {
      unsure++;
      if (w.lsd === today) dayOne++;
    }
  }
  return { learned, unsure, dayOne };
}

// 鍵（en）→ カードの id
export const myCardId = (key) => `${MY_ID_PREFIX}${key}`;

// ===== 複数の単語帳（Batch 81。docs/SPEC_MY_WORDS.md §7） =====
// 一覧の保存（spelldash_my_books。js/myWords.js）は [{ id, name }] の並び。先頭が最初の単語帳（book の無い前からの語が入る）。
// 保存が無い人は最初の単語帳「マイ単語帳」だけ（読むだけでは書かない: 前からの語も一覧も書き直さない）

export const MY_FIRST_BOOK = Object.freeze({ id: "main", name: "マイ単語帳" });
export const MY_BOOK_NAME_MAX = 20;
export const MY_BOOKS_MAX = 20;
const BOOK_ID = /^[a-z0-9_-]{1,24}$/;

// 保存の値（文字列か null）→ { ok, books }。ok: false は読めない値（壊れた JSON・配列でない・使える単語帳が 0）: 最初の単語帳で見せ、書く側は上書きしない
export function parseBooks(raw) {
  const first = () => [{ ...MY_FIRST_BOOK }];
  if (raw === null || raw === undefined) return { ok: true, books: first() };
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, books: first() };
  }
  if (!Array.isArray(value)) return { ok: false, books: first() };
  const seen = new Set();
  const books = [];
  for (const b of value) {
    if (!b || typeof b.id !== "string" || !BOOK_ID.test(b.id) || typeof b.name !== "string" || !b.name.trim() || seen.has(b.id)) continue;
    seen.add(b.id);
    books.push({ id: b.id, name: b.name });
  }
  return books.length ? { ok: true, books } : { ok: false, books: first() };
}

// 語の単語帳の id（無い・知らない id は最初の単語帳）
export function bookIdOf(w, books) {
  const id = w?.book;
  return typeof id === "string" && books.some((b) => b.id === id) ? id : books[0]?.id ?? MY_FIRST_BOOK.id;
}

// その単語帳の語（保存の並びの順。場面カードは最初の単語帳に出る）
export function entriesOfBook(list, bookId, books) {
  return (Array.isArray(list) ? list : []).filter((w) => w && bookIdOf(w, books) === bookId);
}

// 単語帳ごとの 3 状態の数（英語の語だけ）。{ <id>: { new, unsure, learned, total } }
export function bookCounts(list, books) {
  const out = {};
  for (const b of books) out[b.id] = countMyStates(entriesOfBook(list, b.id, books));
  return out;
}

// 単語帳の名前を確かめる（空白は 1 つに。同じ名前は 2 つ作らない。selfId は名前を変える単語帳）
export function checkBookName(raw, books, selfId = null) {
  const name = String(raw ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!name) return { ok: false, error: "単語帳の名前を入力してください" };
  if (name.length > MY_BOOK_NAME_MAX) return { ok: false, error: `名前が長すぎます（${MY_BOOK_NAME_MAX}文字まで）` };
  if (books.some((b) => b.id !== selfId && b.name === name)) return { ok: false, error: `「${name}」という単語帳はすでにあります` };
  return { ok: true, name };
}

// 新しい単語帳の id（英小文字と数字。URL の ?book= にそのまま使える。ほかと重ならない）
export function newBookId(books, rand = Math.random, now = Date.now()) {
  for (let i = 0; ; i++) {
    const id = `b${(Number(now) + i).toString(36)}${Math.floor(rand() * 1296).toString(36).padStart(2, "0")}`.slice(0, 24);
    if (!books.some((b) => b.id === id)) return id;
  }
}

// 選んだ語の印（英語の語と場面カードは鍵が重なりうるので種類も付ける）: "word:<鍵>" / "concept:<鍵>"
export function entryRefOf(w) {
  return `${w?.kind === "concept" ? "concept" : "word"}:${w?.en ?? ""}`;
}
