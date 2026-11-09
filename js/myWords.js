// ===== マイ単語帳（自分専用の単語） =====
//
// 仕事・試験・読んでいる本の単語や熟語を自分で入れて、思い出して打って覚える。保存は spelldash_my_words（人ごとの領域の鍵: js/areaGuard.js。
// バックアップに入る）。語の定義と 3 状態は同期の項目 user_items の my_word に乗る（表があるときだけ: docs/SQL_USER_ITEMS.md・js/userItemsSync.js）。
// 決まり（入れられる英語・出題のカード・3 状態・学ぶ回の列）は js/myWordsCore.js（純）、画面は mywords.html（js/myWordsPage.js）、学ぶ回は js/game.js（/?learn=my）。
// 仕様は docs/SPEC_MY_WORDS.md（Batch 79）。
// 複数の単語帳（Batch 81）: 一覧は spelldash_my_books（[{ id, name }]。人ごとの領域の鍵・バックアップに入る・同期はしない＝端末の中だけ）。
// 語は入っている単語帳の id を book に、その名前を bookName に持つ（どちらも同期の my_word の payload に乗る）。book の無い前からの語は最初の単語帳「マイ単語帳」の語（書き直さない）。
// 一覧に無い単語帳（ほかの端末で作った単語帳）は語の bookName で出す（js/myWordsCore.js withWordBooks）: ほかの端末の単語帳の語を、この端末の最初の単語帳の語として消さない。
// 同じ英語と同じ訳の組は全部の単語帳で 1 つ。Batch 82: 訳が違えば同じ英語を何度も入れられる（語の鍵 en は js/myWordsCore.js myIdentityFor:
// その英語の最初の語は英語の鍵、2 つ目からは <英語の鍵>~<訳の印>。前からの語の鍵は変えない）。語は鍵で引く（同期の印・墓標・選んだ印・答えの書き手・消す・訳を直す）。
// まとめて消す・移すは語の保存を 1 回で書く

import { touchItem, touchItems } from "./userItemsSync.js";
import { isSpellAlt } from "./answers.js";
import { isPro } from "./plan.js";
import { canOfferPro } from "./proFunnel.js";
import { isAnswerKind } from "./learnState.js";
import {
  checkEnText, checkJaText, wordCardOf, parseBulkLine, applyMyAnswer, MY_FREE_LIMIT, MY_PRO_LIMIT,
  parseBooks, bookIdOf, entriesOfBook, checkBookName, newBookId, entryRefOf, withWordBooks, MY_BOOKS_MAX,
  myIdentityFor, findSamePair, answerKeyOf, displayOf, uniqueBookName, visibleText, cutText, isSafeText, UNSAFE_TEXT_ERROR
} from "./myWordsCore.js";

const KEY = "spelldash_my_words";
export const MY_BOOKS_KEY = "spelldash_my_books";

// 追加できる語数の上限（無料 100 語・Pro 1,000 語）。上限を超えて持っている人も閲覧・削除はできる（追加だけ止まる）
export function maxMyWords() {
  return isPro() ? MY_PRO_LIMIT : MY_FREE_LIMIT;
}

const fmtCount = (n) => Number(n).toLocaleString("ja-JP");

// 上限の文のうち、加入画面へのリンクにする部分（「Pro なら1,000語」）。受付中の Web で Pro でない人だけ。ほかは null
// （受付前・アプリでは Pro の話をしない: 買えないものを勧めない。js/proFunnel.js canOfferPro）
export function limitOfferText() {
  return !isPro() && canOfferPro() ? `Pro なら${fmtCount(MY_PRO_LIMIT)}語` : null;
}

// 上限の文（数は js/myWordsCore.js の MY_FREE_LIMIT・MY_PRO_LIMIT。加入画面の比較表と同じ値）。
// マイ単語帳の画面（js/myWordsPage.js）は limitOfferText の部分をリンクにし、前の単語帳の画面（js/myWordsView.js）は「Pro について」を続ける
export function limitMessage() {
  if (isPro()) return `追加できるのは${fmtCount(MY_PRO_LIMIT)}語まで`;
  const offer = limitOfferText();
  return offer ? `無料で追加できるのは${fmtCount(MY_FREE_LIMIT)}語まで（${offer}）。` : `無料で追加できるのは${fmtCount(MY_FREE_LIMIT)}語まで。`;
}

function limitError() {
  return limitMessage();
}

export function getMyWords() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list)
      ? list.filter((w) => w && w.en && (w.kind === "concept" ? w.q && w.answer : w.ja))
      : [];
  } catch {
    return [];
  }
}

// 場面カード用のキー（idに使う。日本語の答えもそのまま鍵にする）。40 字（UTF-16 の単位）で切るが、絵文字などの組は半分にしない
// （Batch 85: NFKC で長くなる答え〔㍿ → 株式会社〕で、切る所が絵文字の途中になると、鍵に組になっていないサロゲートが残って同期で送れなかった。
// 切る所が組の途中でなければ前と同じ鍵）
export function conceptKey(answer) {
  return cutText(String(answer ?? "").normalize("NFKC").toLowerCase().replace(/[\s・／/]/g, ""), 40);
}

function save(list) {
  localStorage.setItem(KEY, JSON.stringify(list));
  window.dispatchEvent(new CustomEvent("spelldash:mywords"));
}

// 出題用の単語オブジェクトへ（level は easy 固定: 自分で入れた語は難易度ゲートに関係なく即出題）
export function toWordObjects(list = getMyWords()) {
  return list.map((w) => {
    if (w.kind === "concept") {
      const answer = String(w.answer).trim();
      const spell = /^[a-z-]+$/i.test(answer);
      // 答えが英字（綴り入力: SSL・CPC）なら、別解は綴りで打てる語だけ（js/answers.js isSpellAlt: 半角の英字・数字・記号・空白。教材と同じ決まり）。
      // 打てない語（https化・クリック単価）は表示と検索だけの名前（aka。単語帳の「別名」）にする。保存した形は変えない（PR #191 のレビュー 2）
      const accept = Array.isArray(w.accept) ? w.accept : [];
      const aka = spell ? accept.filter((a) => !isSpellAlt(a)) : [];
      return {
        id: `my-q-${w.en}`,
        key: w.en,
        kind: "concept",
        en: spell ? answer.toLowerCase() : answer,
        answer,
        accept: spell ? accept.filter((a) => isSpellAlt(a)) : accept,
        ...(aka.length ? { aka } : {}),
        ja: w.ja || (w.explain ? w.explain.slice(0, 40) : "自分の場面カード"),
        q: w.q,
        explain: w.explain || "",
        level: "easy",
        tags: ["my-concept"],
        subject: "english",
        category: "my",
        addedAt: w.addedAt ?? null
      };
    }
    return wordCardOf(w); // 英語と訳の語（js/myWordsCore.js。前からの語の id・en・ja は前と同じ）
  });
}

// 場面カード: q（場面・意味）→ answer（用語。日本語OK）。explain（解説）・accept（別解）は任意
export function validateConcept({ q, answer, explain = "", accept = [] }, existing = getMyWords()) {
  const qq = String(q ?? "").trim();
  const a = String(answer ?? "").trim();
  const ex = String(explain ?? "").trim();
  const acc = (Array.isArray(accept) ? accept : String(accept ?? "").split(/[\/／,、]/))
    .map((s) => String(s).trim())
    .filter(Boolean)
    .slice(0, 6);
  if (!qq) return { ok: false, error: "場面（意味）を入力してください" };
  if (qq.length < 4) return { ok: false, error: "場面が短すぎます（4文字以上）" };
  if (qq.length > 160) return { ok: false, error: "場面が長すぎます（160文字まで）" };
  if (!a) return { ok: false, error: "答え（用語）を入力してください" };
  if (a.length > 40) return { ok: false, error: "答えが長すぎます（40文字まで）" };
  if (ex.length > 120) return { ok: false, error: "解説が長すぎます（120文字まで）" };
  // 名前と訳の字の決まり（js/myWordsCore.js。Batch 85）: 見えない字は断る。場面の欄は複数行なので、改行とタブ（空白の字）は前のまま通す
  const unsafe = [["場面", [qq]], ["答え", [a]], ["解説", [ex]], ["別解", acc]].find(([, texts]) => !texts.every((s) => isSafeText(s.replace(/\s/g, " "))));
  if (unsafe) return { ok: false, error: `${unsafe[0]}に${UNSAFE_TEXT_ERROR}` };
  const key = conceptKey(a);
  if (!key) return { ok: false, error: "答えに使える文字がありません" };
  if (!isSafeText(key)) return { ok: false, error: `答えに${UNSAFE_TEXT_ERROR}` }; // 鍵（同期の項目の鍵）も同じ決まりで確かめる（答えが決まりに合えば、切っても合う）
  if (existing.some((w) => w.kind === "concept" && w.en === key)) return { ok: false, error: `「${a}」の場面カードはすでにあります` };
  if (existing.length >= maxMyWords()) return { ok: false, error: limitError() };
  return { ok: true, entry: { kind: "concept", en: key, answer: a, q: qq, explain: ex, accept: acc, ja: ex ? cutText(ex, 40) : "" } }; // 訳は解説の頭 40 字（絵文字を半分にしない）
}

export function addMyConcept(fields) {
  const list = getMyWords();
  const v = validateConcept(fields, list);
  if (!v.ok) return v;
  list.push({ ...v.entry, addedAt: new Date().toISOString() });
  save(list);
  touchItem("my_word", v.entry.en);
  return { ok: true, en: v.entry.answer };
}

export function normalizeEn(raw) {
  return String(raw ?? "").trim().toLowerCase();
}

// 同じ組の語がある（どの単語帳にあるかを言う。Batch 81 の文に「同じ訳で」を足した）。samePairNote は英語を前に付けない形（まとめて足すは行の名前を前に付ける）
function samePairNote(same, books) {
  const name = books.find((b) => b.id === bookIdOf(same, books))?.name ?? "マイ単語帳";
  return `同じ訳で「${name}」にすでに登録されています`;
}
const samePairError = (text, same, books) => `「${text}」は${samePairNote(same, books)}`;

// 英語と訳の 1 語を確かめる（js/myWordsCore.js checkEnText・checkJaText）。返り値 { ok, en（鍵）, ja, text（画面の形） } か { ok: false, error }
// Batch 82: 断るのは同じ英語（大文字小文字は見ない）と同じ訳（js/myWordsCore.js normJa で比べる）の組が全部の単語帳のどこかにあるときだけ。
// 訳が違えば同じ英語も足せる。鍵は js/myWordsCore.js myIdentityFor（最初の語は英語の鍵、2 つ目からは <英語の鍵>~<訳の印>）。
// 同じ組で断るときは lineError（英語を前に付けない文。まとめて足すが「英語（訳の頭）: 」の後に続ける）も返す
export function validateEntry(en, ja, existing = getMyWords(), books = getMyBooks(existing)) {
  const e = checkEnText(en);
  if (!e.ok) return e;
  const j = checkJaText(ja);
  if (!j.ok) return j;
  const same = findSamePair(existing, e.key, j.ja);
  if (same) return { ok: false, error: samePairError(e.text, same, books), lineError: samePairNote(same, books) };
  if (existing.length >= maxMyWords()) return { ok: false, error: limitError(), limit: true }; // limit: 上限で断った（Batch 84: 渡された語を足すとき、上限で足せなかった数を数える）
  return { ok: true, en: myIdentityFor(existing, e.key, j.ja), ja: j.ja, text: e.text };
}

// 語の単語帳の欄（id と名前。名前は一覧を同期しないほかの端末でその単語帳を出すため）
const bookFields = (book) => ({ book: book.id, bookName: book.name });

// 保存する 1 語（画面の形 text は鍵と違うときだけ: 前からの形と同じ。2 つ目からの語は鍵に印が付くのでいつも text を持つ。book・bookName は入れる単語帳）
const entryOf = (v, book) => ({ en: v.en, ja: v.ja, ...(v.text !== v.en ? { text: v.text } : {}), ...bookFields(book), addedAt: new Date().toISOString() });

// 足す先の単語帳（知らない id・省略は最初の単語帳）
function targetBook(bookId, books) {
  return books.find((b) => b.id === bookId) ?? books[0];
}

export function addMyWord(en, ja, bookId) {
  const list = getMyWords();
  const books = getMyBooks(list);
  const v = validateEntry(en, ja, list, books);
  if (!v.ok) return v;
  list.push(entryOf(v, targetBook(bookId, books)));
  save(list);
  touchItem("my_word", v.en);
  return { ok: true, en: v.text, ja: v.ja };
}

// 学ぶ回の 1 問の答えを、その語の 3 状態に当てる（js/myWordsCore.js applyMyAnswer。js/game.js がマイ単語帳の回でだけ呼ぶ）。
// 保存の配列はそのまま読んで、その語だけを替える（形の読めない要素も消さない）。語の記録（spelldash_word_stats）には書かない。
// 同期の印（touchItem）を付ける: user_items の表があれば、ほかの端末にも 3 状態が届く。返り値: 保存できたら true（語が無い・保存に失敗したら false）
export function recordMyAnswer(key, kind, nowMs = Date.now()) {
  if (!isAnswerKind(kind)) return false;
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    if (!Array.isArray(list)) return false;
    const i = list.findIndex((w) => w && w.kind !== "concept" && w.en === key);
    if (i < 0) return false;
    list[i] = applyMyAnswer(list[i], kind, nowMs);
    localStorage.setItem(KEY, JSON.stringify(list)); // 答えのたびに一覧を描き直さない（spelldash:mywords は出さない）
    touchItem("my_word", key);
    return true;
  } catch {
    return false;
  }
}

// kind: "concept"（場面カード）／"word"（英単語）。省略時は鍵が同じものをすべて（英単語と場面カードの鍵は重なりうる）
export function removeMyWord(en, kind) {
  const same = (w) => w.en === en && (!kind || (w.kind === "concept") === (kind === "concept"));
  const list = getMyWords().filter((w) => !same(w));
  save(list);
  touchItem("my_word", en, true); // 墓標: 他の端末からも消える
}

// まとめて追加: 1 行に「english, 訳」（カンマ・タブ・全角読点。区切りが無ければ英語と日本語の境、それも無ければ最初の空白）。
// Batch 82: 訳の中の「→」は字のまま。区切りの無い矢印の行（→ ⇒ => ->）は英語の側と訳の側に分け、英語の無い行は断る。
// 場面カードは作らない（学ぶ回に出せない語を作らない。前からの場面カードはそのまま読める・消せる）。決まりは js/myWordsCore.js parseBulkLine
export function parseBulk(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(english|英単語|answer|q|場面)\s*[,\t]/i.test(line)) // CSVの見出し行は飛ばす
    .map((line) => ({ line, ...parseBulkLine(line) })); // line: 貼った行（前後の空白を落とした形。足せなかった行を欄に残す）
}

// 足せなかった行の頭（英語の無い行は行の初めを見せる）・訳の頭。画面に出す形（js/myWordsCore.js visibleText: タブは空白にして、見えない字は外す）
// （Batch 85: 断った理由の文の見え方を、行の中の向きを変える字が並べ替えない・タブで分けた語がつながらない。欄に残す行は貼った形のまま）
const lineHead = (line) => {
  const t = visibleText(line);
  return t.length > 24 ? `${cutText(t, 24)}…` : t; // 頭 24 字（絵文字を半分にしない）
};

// 足せなかった行の名前: 英語と訳の頭（同じ英語の行が並ぶ貼り付け〔up・down の場面の行〕でも、どの行かが分かる）。訳の無い行は英語だけ
const lineName = (entry) => {
  const ja = lineHead(entry.ja);
  return `${visibleText(entry.en) || "(空)"}${ja ? `（${ja}）` : ""}`;
};

// 同じ組（同じ英語と同じ訳）は 1 回の貼り付けの中でも 2 つ目を飛ばす（足した語は list に入れて確かめる）。語の保存と同期の印は最後に 1 回ずつ。
// 返り値 { added（足した語の画面の形）, skipped（足せなかった行の理由）, rest（足せなかった行。貼った形のまま。画面は足した後の欄にこれだけを残す） }
export function addMyWordsBulk(text, bookId) {
  const list = getMyWords();
  const books = getMyBooks(list);
  const book = targetBook(bookId, books);
  const added = [];
  const keys = [];
  const skipped = [];
  const rest = [];
  for (const entry of parseBulk(text)) {
    if (entry.error) {
      skipped.push(`${lineHead(entry.line)}: ${entry.error}`);
      rest.push(entry.line);
      continue;
    }
    const v = validateEntry(entry.en, entry.ja, list, books);
    if (!v.ok) {
      skipped.push(`${lineName(entry)}: ${v.lineError ?? v.error}`);
      rest.push(entry.line);
      continue;
    }
    list.push(entryOf(v, book));
    added.push(v.text);
    keys.push(v.en);
  }
  if (added.length > 0) {
    save(list);
    touchItems("my_word", keys); // 語を書いた後に（中身は touchItem を鍵の数だけ呼んだのと同じ）
  }
  return { added, skipped, rest };
}

// 渡された単語帳の語を足す（Batch 84。docs/SPEC_MY_WORDS.md §13。words は js/myWordsShare.js decodeShare が読んだ [{ en, ja }]）。
// 1 語ずつ足すと同じ確かめ（validateEntry: 同じ英語と同じ訳の組は断る・訳が違えば同じ英語も足せる・上限）。渡された中の 2 つ目の同じ組も断る。
// to: { book: <id> }（今の単語帳へ。知らない id は最初の単語帳）か { name: <名前> }（新しい単語帳として。名前は js/myWordsCore.js uniqueBookName で今の単語帳と重ねない・
//   単語帳の数の上限 MY_BOOKS_MAX）。新しい単語帳は 1 語でも足せるときだけ作る（足せる語が無ければ作らない: 空の単語帳を残さない）。
// 語の保存・単語帳の一覧の保存・同期の印は 1 回ずつ（語を先に書く。一覧の書き込みだけ失敗しても、語が持つ bookName でその単語帳に出る: withWordBooks）。
// 3 状態は付けない（どの語も これから）。返り値 { ok, added（足した語の画面の形）, skipped（上限のほかで足せなかった語の理由）, limited（上限で足せなかった語の数）,
//   book（足した先 { id, name }。新しい単語帳を作らなかったら null）, created（新しい単語帳を作った） } か { ok: false, error }
export function addSharedWords(words, to = {}) {
  const list = getMyWords();
  const books = getMyBooks(list);
  let book;
  let saved = null; // 新しい単語帳を作るときの、端末の一覧（readBooks）
  if (typeof to.name === "string") {
    saved = readBooks();
    if (!saved.ok) return { ok: false, error: UNREADABLE };
    if (books.length >= MY_BOOKS_MAX) return { ok: false, error: `単語帳は${MY_BOOKS_MAX}冊まで` };
    const name = uniqueBookName(to.name, books);
    if (!name) return { ok: false, error: "単語帳の名前が使えません" };
    book = { id: newBookId(books), name };
  } else {
    book = targetBook(to.book, books);
  }
  const named = saved ? [...books, book] : books; // 重なりの文が、作る単語帳の名前も言えるように
  const work = [...list];
  const added = [];
  const keys = [];
  const skipped = [];
  let limited = 0;
  for (const w of Array.isArray(words) ? words : []) {
    const entry = { en: String(w?.en ?? ""), ja: String(w?.ja ?? "") };
    const v = validateEntry(entry.en, entry.ja, work, named);
    if (!v.ok) {
      if (v.limit) limited++;
      else skipped.push(`${lineName(entry)}: ${v.lineError ?? v.error}`);
      continue;
    }
    work.push(entryOf(v, book));
    added.push(v.text);
    keys.push(v.en);
  }
  if (added.length === 0) return { ok: true, added, skipped, limited, book: saved ? null : book, created: false };
  try {
    save(work);
  } catch {
    return { ok: false, error: SAVE_FAILED };
  }
  if (saved) {
    try {
      saveBooks([...saved.books, book]);
    } catch {
      // 一覧に入らなくても、語は bookName でこの単語帳に出る（js/myWordsCore.js withWordBooks）
    }
  }
  touchItems("my_word", keys);
  return { ok: true, added, skipped, limited, book, created: Boolean(saved) };
}

// ===== 複数の単語帳（Batch 81。決まりは js/myWordsCore.js） =====

// 単語帳の一覧を読む（{ ok, books }。ok: false は読めない保存の値: 最初の単語帳で見せ、作る・名前を変える・消すは断る）
function readBooks() {
  try {
    return parseBooks(localStorage.getItem(MY_BOOKS_KEY));
  } catch {
    return parseBooks("{");
  }
}

// 画面と学ぶ回に出す単語帳の並び: 端末の一覧 + 語が持つ単語帳（ほかの端末で作った単語帳。js/myWordsCore.js withWordBooks）
export function getMyBooks(list = getMyWords()) {
  return withWordBooks(readBooks().books, list);
}

// id の単語帳（無ければ null）
export function findMyBook(id) {
  return id ? getMyBooks().find((b) => b.id === id) ?? null : null;
}

const UNREADABLE = "単語帳の保存が読めないため、変えられません";
const SAVE_FAILED = "保存できませんでした";

function saveBooks(books) {
  localStorage.setItem(MY_BOOKS_KEY, JSON.stringify(books));
  window.dispatchEvent(new CustomEvent("spelldash:mywords"));
}

export function createMyBook(name) {
  const r = readBooks();
  if (!r.ok) return { ok: false, error: UNREADABLE };
  const all = withWordBooks(r.books, getMyWords()); // 名前と id はほかの端末の単語帳とも重ねない
  if (all.length >= MY_BOOKS_MAX) return { ok: false, error: `単語帳は${MY_BOOKS_MAX}冊まで` };
  const v = checkBookName(name, all);
  if (!v.ok) return v;
  const book = { id: newBookId(all), name: v.name };
  try {
    saveBooks([...r.books, book]);
  } catch {
    return { ok: false, error: SAVE_FAILED };
  }
  return { ok: true, book };
}

// 名前を変える: 一覧と、その単語帳の語の bookName（book がその id の語だけ。book の無い前からの語は書き直さない）。
// ほかの端末の単語帳（一覧に無い）の名前を変えると、この端末の一覧の後ろに入る
export function renameMyBook(id, name) {
  const r = readBooks();
  if (!r.ok) return { ok: false, error: UNREADABLE };
  const list = getMyWords();
  const all = withWordBooks(r.books, list);
  if (!all.some((b) => b.id === id)) return { ok: false, error: "単語帳が見つかりません" };
  const v = checkBookName(name, all, id);
  if (!v.ok) return v;
  const book = { id, name: v.name };
  const books = r.books.some((b) => b.id === id) ? r.books.map((b) => (b.id === id ? { ...b, name: v.name } : b)) : [...r.books, book];
  const renamed = [];
  const next = list.map((w) => {
    if (w.book !== id || w.bookName === v.name) return w;
    renamed.push(w.en);
    return { ...w, bookName: v.name };
  });
  try {
    if (renamed.length) save(next); // 語を先に（一覧の書き込みが失敗しても、語の名前が先に替わるだけ）
    saveBooks(books);
  } catch {
    return { ok: false, error: SAVE_FAILED };
  }
  if (renamed.length) touchItems("my_word", [...new Set(renamed)]);
  return { ok: true, book };
}

// 語の印（"word:<鍵>" / "concept:<鍵>"。js/myWordsCore.js entryRefOf）の集まりに当たる語を除いた並びと、除いた語
function splitByRefs(list, refs) {
  const want = new Set(refs);
  const keep = [];
  const hit = [];
  for (const w of list) (want.has(entryRefOf(w)) ? hit : keep).push(w);
  return { keep, hit };
}

// 消した語の同期の印: 同じ鍵の語（英語の語と場面カード）が残っていれば墓標にしない（残った方を消さない）
function touchRemoved(hit, keep) {
  const left = new Set(keep.map((w) => w.en));
  const gone = [...new Set(hit.map((w) => w.en))];
  touchItems("my_word", gone.filter((k) => !left.has(k)), true);
  touchItems("my_word", gone.filter((k) => left.has(k)));
}

// まとめて消す（選んだ語。語の保存は 1 回で書く）。返り値 { ok, removed }
export function removeMyWords(refs) {
  const { keep, hit } = splitByRefs(getMyWords(), refs);
  if (hit.length === 0) return { ok: true, removed: 0 };
  try {
    save(keep);
  } catch {
    return { ok: false, error: SAVE_FAILED };
  }
  touchRemoved(hit, keep);
  return { ok: true, removed: hit.length };
}

// まとめて移す（選んだ語をほかの単語帳へ。3 状態・足した時刻は残す。語の保存は 1 回）。返り値 { ok, moved }
export function moveMyWords(refs, toBookId) {
  const all = getMyWords();
  const books = getMyBooks(all);
  const to = books.find((b) => b.id === toBookId);
  if (!to) return { ok: false, error: "移す先の単語帳が見つかりません" };
  const want = new Set(refs);
  const moved = [];
  const list = all.map((w) => {
    if (!want.has(entryRefOf(w)) || bookIdOf(w, books) === toBookId) return w;
    moved.push(w.en);
    return { ...w, ...bookFields(to) };
  });
  if (moved.length === 0) return { ok: true, moved: 0 };
  try {
    save(list);
  } catch {
    return { ok: false, error: SAVE_FAILED };
  }
  touchItems("my_word", [...new Set(moved)]);
  return { ok: true, moved: moved.length };
}

// 単語帳を消す（その単語帳の語も消す。最後の 1 冊は消さない）。返り値 { ok, removed }
// 単語帳の並びは語が持つ単語帳まで（withWordBooks）: ほかの端末の単語帳の語は、最初の単語帳を消しても消えない（墓標も付けない）。
// 一覧が空になるとき（一覧の最後の 1 冊を消して、ほかの端末の単語帳だけが残る）は、残った単語帳を一覧にする
export function deleteMyBook(id) {
  const r = readBooks();
  if (!r.ok) return { ok: false, error: UNREADABLE };
  const list = getMyWords();
  const all = withWordBooks(r.books, list);
  if (!all.some((b) => b.id === id)) return { ok: false, error: "単語帳が見つかりません" };
  if (all.length <= 1) return { ok: false, error: "最後の単語帳は消せません" };
  const inBook = new Set(entriesOfBook(list, id, all).map(entryRefOf));
  const { keep, hit } = splitByRefs(list, inBook);
  const inList = r.books.some((b) => b.id === id); // ほかの端末の単語帳は一覧に無い（語を消せば並びからも消える）
  const rest = r.books.filter((b) => b.id !== id);
  try {
    if (hit.length) save(keep); // 語を先に消す（一覧の書き込みが失敗しても、消した単語帳は空で残るだけ）
    if (inList) saveBooks(rest.length ? rest : all.filter((b) => b.id !== id));
  } catch {
    return { ok: false, error: SAVE_FAILED };
  }
  if (hit.length) touchRemoved(hit, keep);
  return { ok: true, removed: hit.length };
}

// 訳を直す（英語の語だけ。en = 語の鍵。英語・鍵・3 状態・足した時刻・単語帳はそのまま。英語を変えるのは消して足し直す）。
// Batch 82: 直した訳が同じ英語のほかの語の訳と同じ組になるときは断る（どの単語帳にあるかを言う）
export function setMyWordJa(en, ja) {
  const j = checkJaText(ja);
  if (!j.ok) return j;
  const list = getMyWords();
  const i = list.findIndex((w) => w.kind !== "concept" && w.en === en);
  if (i < 0) return { ok: false, error: "語が見つかりません" };
  const same = findSamePair(list, answerKeyOf(list[i]), j.ja, en);
  if (same) return { ok: false, error: samePairError(displayOf(list[i]), same, getMyBooks(list)) };
  list[i] = { ...list[i], ja: j.ja };
  try {
    save(list);
  } catch {
    return { ok: false, error: SAVE_FAILED };
  }
  touchItem("my_word", en);
  return { ok: true, ja: j.ja };
}
