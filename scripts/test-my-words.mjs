// マイ単語帳（Batch 79。docs/SPEC_MY_WORDS.md）の決まりの単体: 入れられる英語・まとめて追加の行・出題のカード（前からの語の id は同じ）・
// 打ち方（英小文字だけの語は 1 字ずつ、ほかは全文入力で大文字小文字・空白・ハイフン・アポストロフィを見ない）・マイ単語帳だけの 3 状態（js/learnState.js と同じ決まり）・
// 学ぶ回の列（これから → あやふや → 覚えた・10 語）・入口 ?learn=my。
// Batch 81: 複数の単語帳（前からの語は最初の単語帳）・英語は全部の単語帳で 1 つ・単語帳を消すと語も・まとめて消す／移す（1 回の書き込み）・訳の書き直し・150 字
// 使い方: node scripts/test-my-words.mjs
import * as C from "../js/myWordsCore.js";
import { typeAnswer, answerModeOf } from "../js/judge.js";
import { acceptedAnswers } from "../js/answers.js";
import { LEARN_NEW, LEARN_UNSURE, LEARN_LEARNED, ANSWER_KINDS, applyLearnAnswer, learnDayOf } from "../js/learnState.js";
import * as Q from "../js/learnQueue.js";

let passed = 0;
let failed = 0;
function ok(name, cond, detail = "") {
  if (cond) passed++;
  else {
    failed++;
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);

// ===== 入れられる英語 =====
for (const [raw, text, key] of [
  ["due diligence", "due diligence", "due diligence"],
  ["KPI", "KPI", "kpi"],
  ["  follow   up ", "follow up", "follow up"],
  ["e-mail", "e-mail", "e-mail"],
  ["don’t", "don't", "don't"],
  ["B2B", "B2B", "b2b"],
  ["ＫＰＩ", "KPI", "kpi"],
  ["Due Diligence", "Due Diligence", "due diligence"],
  ["negotiate", "negotiate", "negotiate"]
]) {
  const r = C.checkEnText(raw);
  ok(`入れられる: 「${raw}」→ 画面「${text}」・鍵「${key}」`, r.ok && r.text === text && r.key === key, JSON.stringify(r));
}
for (const raw of ["", "   ", "123", "café", "a/b", "U.S.", "日本語", "-mail", "x".repeat(151), `${"ab ".repeat(50)}c`, "a, b", "what?"]) {
  ok(`入れられない: 「${raw}」`, C.checkEnText(raw).ok === false, JSON.stringify(C.checkEnText(raw)));
}
ok("40 字ちょうどは入る", C.checkEnText("a".repeat(40)).ok);
// Batch 81: 英語も訳も 150 字まで（1 語ずつ・まとめて とも同じ確かめ）
ok("150 字ちょうどは入る（英語）", C.checkEnText("a".repeat(150)).ok && C.checkEnText(`${"ab ".repeat(49)}abc`).ok && C.MY_EN_MAX === 150);
ok("151 字は入れない（英語）・理由に 150文字まで", !C.checkEnText("a".repeat(151)).ok && /150文字まで/.test(C.checkEnText("a".repeat(151)).error));
ok("訳: 空は入れない・150 字まで", !C.checkJaText(" ").ok && C.checkJaText("あ".repeat(150)).ok && !C.checkJaText("あ".repeat(151)).ok && /150文字まで/.test(C.checkJaText("あ".repeat(151)).error) && C.MY_JA_MAX === 150);

// ===== まとめて追加の 1 行 =====
eq("行: カンマ", C.parseWordLine("due diligence, 適正評価"), { en: "due diligence", ja: "適正評価" });
eq("行: タブ", C.parseWordLine("KPI\t重要業績評価指標"), { en: "KPI", ja: "重要業績評価指標" });
eq("行: 全角の読点", C.parseWordLine("follow up、追って連絡する"), { en: "follow up", ja: "追って連絡する" });
eq("行: 区切りなし（英語と日本語の境）", C.parseWordLine("due diligence 適正評価"), { en: "due diligence", ja: "適正評価" });
eq("行: 区切りなし（英語 1 語）", C.parseWordLine("invoice 請求書"), { en: "invoice", ja: "請求書" });
eq("行: 引用符を外す", C.parseWordLine('"e-mail","電子メール"'), { en: "e-mail", ja: "電子メール" });

// ===== 出題のカード =====
eq("前からの語（英小文字）: id・en・ja は前と同じ・1 字ずつ判定", C.wordCardOf({ en: "invoice", ja: "請求書" }), { id: "my-invoice", en: "invoice", ja: "請求書", level: "easy", tags: ["my"], subject: "english", category: "my", addedAt: null });
const kpi = C.wordCardOf({ en: "kpi", text: "KPI", ja: "重要業績評価指標" });
ok("大文字の語: 鍵は小文字・画面は KPI（answer）・1 字ずつ判定", kpi.id === "my-kpi" && kpi.en === "kpi" && kpi.answer === "KPI" && !kpi.free && answerModeOf(kpi).mode === "spell", JSON.stringify(kpi));
const dd = C.wordCardOf({ en: "due diligence", ja: "適正評価" });
ok("熟語: 全文入力", dd.free === true && answerModeOf(dd).mode === "free", JSON.stringify(dd));
const em = C.wordCardOf({ en: "e-mail", ja: "電子メール" });
ok("ハイフンの語: 全文入力（画面キーボードと端末のかな入力の道にハイフンが無い）", em.free === true && answerModeOf(em).mode === "free");
ok("text が鍵と違う綴りなら使わない", C.displayOf({ en: "kpi", text: "KPIs" }) === "kpi");

// ===== 打ち方（js/judge.js typeAnswer。盤面と同じ 1 打の関数） =====
const kpiCands = acceptedAnswers(kpi, null);
eq("KPI を kpi と打つと Enter なしで正解", typeAnswer(kpi, kpiCands, "kpi").how, "auto");
eq("KPI を KPI と打っても正解（大文字は小文字で比べる）", typeAnswer(kpi, kpiCands, "KPI").how, "auto");
for (const typed of ["due diligence", "Due Diligence", "duediligence", "DUE  DILIGENCE"]) eq(`due diligence を「${typed}」+ Enter で正解`, typeAnswer(dd, acceptedAnswers(dd, null), typed).how, "enter");
eq("due diligence を due dilligence は ×", typeAnswer(dd, acceptedAnswers(dd, null), "due dilligence").how, "wrong");
eq("e-mail を email + Enter で正解", typeAnswer(em, acceptedAnswers(em, null), "email").how, "enter");
const dont = C.wordCardOf({ en: "don't", ja: "しない" });
eq("don't を dont + Enter で正解", typeAnswer(dont, acceptedAnswers(dont, null), "dont").how, "enter");
const b2b = C.wordCardOf({ en: "b2b", text: "B2B", ja: "企業間取引" });
eq("B2B を b2b + Enter で正解", typeAnswer(b2b, acceptedAnswers(b2b, null), "b2b").how, "enter");

// ===== 3 状態（公開の語と同じ決まり。語の記録の欄の名前と同じ ls・lsd・lsAt。目安の印 lsf は付けない） =====
const T0 = new Date(2026, 10, 3, 10, 0).getTime();
const T1 = new Date(2026, 10, 4, 10, 0).getTime();
const d0 = learnDayOf(T0);
const w0 = { en: "invoice", ja: "請求書", addedAt: "x" };
const a1 = C.applyMyAnswer(w0, ANSWER_KINDS.exact, T0);
ok("これから + 自力正解 → 覚えた（ほかの欄はそのまま・lsf なし）", C.myStateOf(a1) === LEARN_LEARNED && a1.ja === "請求書" && a1.addedAt === "x" && a1.lsAt === T0 && !("lsf" in a1) && !("lsd" in a1), JSON.stringify(a1));
const a2 = C.applyMyAnswer(w0, ANSWER_KINDS.miss, T0);
ok("これから + 1 打ミス → あやふや", C.myStateOf(a2) === LEARN_UNSURE && !("lsd" in a2));
const a3 = C.applyMyAnswer(w0, ANSWER_KINDS.hint, T0);
ok("これから + ヒント → あやふや", C.myStateOf(a3) === LEARN_UNSURE);
const a4 = C.applyMyAnswer(a2, ANSWER_KINDS.exact, T0);
ok("あやふや + 自力正解（今日 1 日目）→ あやふやのまま・数えた日", C.myStateOf(a4) === LEARN_UNSURE && a4.lsd === d0);
const a5 = C.applyMyAnswer(a4, ANSWER_KINDS.exact, T1);
ok("あやふや + 別の日の自力正解 → 覚えた", C.myStateOf(a5) === LEARN_LEARNED && !("lsd" in a5));
const a6 = C.applyMyAnswer(a1, ANSWER_KINDS.reveal, T1);
ok("覚えた + 答え表示 → あやふや", C.myStateOf(a6) === LEARN_UNSURE);
// 公開の語の書き手と同じ答え（状態・数えた日）になる
for (const kind of Object.values(ANSWER_KINDS)) {
  for (const prev of [w0, a2, a4, a1]) {
    const mine = C.applyMyAnswer(prev, kind, T1);
    const core = applyLearnAnswer({ ...(prev.ls !== undefined ? { ls: prev.ls } : {}), ...(prev.lsd !== undefined ? { lsd: prev.lsd } : {}) }, kind, T1);
    ok(`公開の語と同じ動き（${kind}・前 ${prev.ls ?? 0}）`, mine.ls === core.ls && mine.lsd === core.lsd);
  }
}
eq("数: これから・あやふや・覚えた（場面カードは数えない）", C.countMyStates([w0, a2, a1, { kind: "concept", en: "ssl", q: "q", answer: "SSL" }]), { new: 1, unsure: 1, learned: 1, total: 3 });

// ===== 学ぶ回の列・区切り =====
const list = [
  { en: "a1", ja: "x", ls: 2, lsAt: 5 },
  { en: "b1", ja: "x" },
  { en: "c1", ja: "x", ls: 1, lsAt: 9 },
  { en: "d1", ja: "x", ls: 1, lsAt: 3 },
  { kind: "concept", en: "q1", q: "q", answer: "Q" },
  { en: "e1", ja: "x" },
  { en: "f1", ja: "x", ls: 2, lsAt: 1 }
];
eq("列: これから（足した順）→ あやふや（古い順）→ 覚えた（古い順）・場面カードは出さない", C.buildMyQueue(list), ["my-b1", "my-e1", "my-d1", "my-c1", "my-f1", "my-a1"]);
eq("1 回 10 語", C.MY_SET_SIZE, 10);
eq("区切り: 0 語 → play・10 語 → set・出せる語なし → done", [C.myLearnStep({ setAnswered: 0, more: true }), C.myLearnStep({ setAnswered: 10, more: true }), C.myLearnStep({ setAnswered: 3, more: false })], ["play", "set", "done"]);
eq("回の結果", C.mySummary(["my-a1", "my-c1", "my-c1", "my-zz"], list, 99), { learned: 1, unsure: 1, dayOne: 0 });
eq("上限: 無料 100・Pro 1,000", [C.MY_FREE_LIMIT, C.MY_PRO_LIMIT], [100, 1000]);

// ===== 入口 ?learn=my（js/learnQueue.js） =====
eq("入口: ?learn=my はマイ単語帳の回", Q.parseLearnEntry("my"), Q.LEARN_MY);
eq("入口: 3 つのモードと next は前のまま", ["new", "unsure", "learned", "next", "foo"].map((v) => Q.parseLearnEntry(v)), ["new", "unsure", "learned", "next", null]);
eq("入口: my はモードではない（3 つの学習の列は作らない）", Q.parseLearnMode("my"), null);

// ===== Batch 81: 複数の単語帳・まとめて消す／移す・訳の書き直し・150 字 =====
// 長い英字だけの語（41 字以上）は全文入力（Enter で判定）。40 字までの英字だけの語は前のまま 1 字ずつ（前からの語の打ち方は変わらない）
ok("英字だけでも 41 字以上は全文入力・40 字までは 1 字ずつ（前のまま）", C.wordCardOf({ en: "a".repeat(41), ja: "x" }).free === true && !C.wordCardOf({ en: "a".repeat(40), ja: "x" }).free && C.isSpellKey("a".repeat(40)) && !C.isSpellKey("a".repeat(41)));
{
  const long = `${"word ".repeat(29)}words`; // 150 字
  const card = C.wordCardOf({ en: long, ja: "長い" });
  ok("150 字の熟語: 全文入力で、打ったとおり + Enter で正解・1 字違いは ×", long.length === 150 && card.free === true && typeAnswer(card, acceptedAnswers(card, null), long).how === "enter" && typeAnswer(card, acceptedAnswers(card, null), long.toUpperCase()).how === "enter" && typeAnswer(card, acceptedAnswers(card, null), long.slice(0, -1) + "x").how === "wrong");
}

// ---- 単語帳の形（純） ----
eq("最初の単語帳: id main・名前「マイ単語帳」", C.MY_FIRST_BOOK, { id: "main", name: "マイ単語帳" });
eq("保存が無いときは最初の単語帳だけ（読めた）", C.parseBooks(null), { ok: true, books: [{ id: "main", name: "マイ単語帳" }] });
eq("保存の並びを読む", C.parseBooks(JSON.stringify([{ id: "main", name: "マイ単語帳" }, { id: "b1", name: "仕事" }])).books.map((b) => b.name), ["マイ単語帳", "仕事"]);
for (const raw of ["{not json", "{}", "[]", "[1,2]", '[{"id":"","name":"x"}]']) ok(`読めない保存（${raw}）は最初の単語帳で見せ、ok: false（上書きしない）`, C.parseBooks(raw).ok === false && C.parseBooks(raw).books[0].id === "main");
eq("同じ id の 2 つ目と形の違う要素は読まない", C.parseBooks(JSON.stringify([{ id: "a1", name: "A" }, { id: "a1", name: "B" }, { id: "b 2", name: "C" }, null])).books, [{ id: "a1", name: "A" }]);
{
  const books = [{ id: "main", name: "マイ単語帳" }, { id: "w1", name: "仕事" }];
  eq("語の単語帳: book の無い前からの語は最初の単語帳・知らない id も最初の単語帳・ある id はその単語帳", [C.bookIdOf({ en: "a" }, books), C.bookIdOf({ en: "a", book: "zz" }, books), C.bookIdOf({ en: "a", book: "w1" }, books)], ["main", "main", "w1"]);
  eq("最初の単語帳を消した後は、book の無い語は今の最初の単語帳", C.bookIdOf({ en: "a" }, [{ id: "w1", name: "仕事" }]), "w1");
  const list = [{ en: "a", ja: "x" }, { en: "b", ja: "x", book: "w1", ls: 2 }, { en: "c", ja: "x", book: "w1" }, { kind: "concept", en: "q", q: "qq", answer: "Q" }];
  eq("単語帳ごとの語（場面カードは最初の単語帳の一覧に出る）", [C.entriesOfBook(list, "main", books).map((w) => w.en), C.entriesOfBook(list, "w1", books).map((w) => w.en)], [["a", "q"], ["b", "c"]]);
  eq("単語帳ごとの数（3 状態は英語の語だけ）", C.bookCounts(list, books), { main: { new: 1, unsure: 0, learned: 0, total: 1 }, w1: { new: 1, unsure: 0, learned: 1, total: 2 } });
  ok("名前: 空は入れない・20 字まで・同じ名前は入れない（自分の名前へは変えられる）・空白は 1 つに",
    !C.checkBookName(" ", books).ok && C.checkBookName("あ".repeat(20), books).ok && !C.checkBookName("あ".repeat(21), books).ok && /すでにあります/.test(C.checkBookName("仕事", books).error ?? "") && C.checkBookName("仕事", books, "w1").ok && C.checkBookName("  旅行   英語 ", books).name === "旅行 英語");
  const id = C.newBookId(books, () => 0.5, 1000);
  ok("新しい単語帳の id: 英小文字と数字・URL に使える・ほかと重ならない", /^[a-z0-9]{2,24}$/.test(id) && !books.some((b) => b.id === id) && C.newBookId([...books, { id, name: "x" }], () => 0.5, 1000) !== id, id);
  eq("選んだ語の印（英語の語と場面カードの鍵は重なりうるので種類も）", [C.entryRefOf({ en: "a" }), C.entryRefOf({ kind: "concept", en: "q" })], ["word:a", "concept:q"]);
}

// ---- 保存（js/myWords.js。localStorage の写しで） ----
{
  const store = new Map();
  const writes = [];
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { writes.push(k); store.set(k, String(v)); }, removeItem: (k) => store.delete(k), clear: () => store.clear(), key: (i) => [...store.keys()][i] ?? null, get length() { return store.size; } };
  globalThis.sessionStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.window ??= globalThis;
  globalThis.dispatchEvent ??= () => true;
  globalThis.addEventListener ??= () => {};
  globalThis.window.__SUPABASE_MODULE_URL = "data:text/javascript,export const createClient = () => ({});";
  const M = await import("../js/myWords.js");
  const words = () => JSON.parse(store.get("spelldash_my_words") || "[]");
  const books = () => JSON.parse(store.get("spelldash_my_books") || "null");
  const meta = () => JSON.parse(store.get("spelldash_user_items_meta") || "{}");
  const reset = (seed = {}) => { store.clear(); writes.length = 0; for (const [k, v] of Object.entries(seed)) store.set(k, v); };
  const writesOf = (k) => writes.filter((w) => w === k).length;

  eq("鍵の名前（人ごとの領域・バックアップに入る）", M.MY_BOOKS_KEY, "spelldash_my_books");
  // 前からの語（book の欄なし）は、そのまま最初の単語帳「マイ単語帳」に入っている。読むだけでは何も書かない
  const OLD = JSON.stringify([{ en: "invoice", ja: "請求書", addedAt: "2026-11-01T00:00:00.000Z", ls: 2, lsAt: 5 }, { en: "kpi", text: "KPI", ja: "重要業績評価指標", addedAt: "2026-11-02T00:00:00.000Z" }, { kind: "concept", en: "ssl", q: "通信を暗号化する", answer: "SSL", explain: "", accept: [], ja: "" }]);
  reset({ spelldash_my_words: OLD });
  const b0 = M.getMyBooks();
  ok("前からの語: 単語帳の保存が無くても最初の単語帳「マイ単語帳」に全部入る・読むだけでは書かない", JSON.stringify(b0) === '[{"id":"main","name":"マイ単語帳"}]' && C.entriesOfBook(M.getMyWords(), "main", b0).length === 3 && writes.length === 0);
  const made = M.createMyBook("仕事");
  ok("単語帳を作る: 最初の単語帳を先頭に残して足す・前からの語は 1 字も変えない", made.ok && books().length === 2 && books()[0].id === "main" && books()[1].name === "仕事" && store.get("spelldash_my_words") === OLD, JSON.stringify(made));
  const W = made.book.id;
  ok("同じ名前の単語帳は作らない", !M.createMyBook("仕事").ok && books().length === 2);
  ok("名前を変える（前からの語は変えない）", M.renameMyBook(W, "仕事の英語").ok && books()[1].name === "仕事の英語" && store.get("spelldash_my_words") === OLD && !M.renameMyBook("nope", "x").ok);
  M.renameMyBook(W, "仕事");
  // 足す: 今の単語帳の id を語に付ける。英語は全部の単語帳で 1 つ（ほかの単語帳にあれば、どの単語帳かを言う）
  const a1 = M.addMyWord("due diligence", "適正評価", W);
  const dup = M.addMyWord("KPI", "別の訳", W);
  ok("仕事に足す: 語に book（仕事の id）・ほかの欄は前と同じ形", a1.ok && words().at(-1).book === W && words().at(-1).en === "due diligence");
  ok("同じ英語はほかの単語帳にあれば足さない（「マイ単語帳」にあると言う）", !dup.ok && /「マイ単語帳」/.test(dup.error) && /すでに/.test(dup.error), JSON.stringify(dup));
  const dup2 = M.addMyWord("Due Diligence", "x");
  ok("最初の単語帳に足すときも、仕事にある語は「仕事」にあると言う", !dup2.ok && /「仕事」/.test(dup2.error), JSON.stringify(dup2));
  const bulk = M.addMyWordsBulk(`follow up, 追って連絡する\ninvoice, 請求書\n${"a ".repeat(74)}bc, ${"長".repeat(150)}`, W);
  ok("まとめて足す: 今の単語帳へ・150 字の英語と 150 字の訳も入る・ほかの単語帳にある語は飛ばす", bulk.added.length === 2 && bulk.skipped.length === 1 && /「マイ単語帳」/.test(bulk.skipped[0]) && words().filter((w) => w.book === W).length === 3 && words().some((w) => w.en.length === 150 && w.ja.length === 150), JSON.stringify(bulk));
  ok("1 語ずつも 151 字は足さない", !M.addMyWord("a".repeat(151), "x", W).ok && !M.addMyWord("abc", "あ".repeat(151), W).ok);
  ok("知らない単語帳の id で足すと最初の単語帳へ", M.addMyWord("agenda", "議題", "nope").ok && C.bookIdOf(words().at(-1), M.getMyBooks()) === "main");

  // 訳の書き直し（英語はそのまま。3 状態・足した時刻も残す）
  const before = words().find((w) => w.en === "invoice");
  const ed = M.setMyWordJa("invoice", "  請求書（インボイス） ");
  const afterEd = words().find((w) => w.en === "invoice");
  ok("訳を直す: 訳だけを替える（英語・3 状態・足した時刻・単語帳はそのまま）・同期の印", ed.ok && afterEd.ja === "請求書（インボイス）" && afterEd.ls === before.ls && afterEd.lsAt === before.lsAt && afterEd.addedAt === before.addedAt && afterEd.en === "invoice" && meta()["my_word:invoice"]?.deleted === false, JSON.stringify(afterEd));
  ok("訳を直す: 空・151 字・無い語は断る（保存は変えない）", !M.setMyWordJa("invoice", " ").ok && !M.setMyWordJa("invoice", "あ".repeat(151)).ok && !M.setMyWordJa("nope", "x").ok && words().find((w) => w.en === "invoice").ja === "請求書（インボイス）");

  // まとめて移す・消す: 1 回の書き込み
  writes.length = 0;
  const mv = M.moveMyWords(["word:kpi", "word:agenda"], W);
  ok("まとめて移す: 2 語を仕事へ・語の保存は 1 回・同期の印も 1 回ずつ（状態は残す）", mv.ok && mv.moved === 2 && writesOf("spelldash_my_words") === 1 && writesOf("spelldash_user_items_meta") === 1 && writesOf("spelldash_user_items_dirty") === 1 && words().find((w) => w.en === "kpi").book === W && words().find((w) => w.en === "kpi").text === "KPI" && meta()["my_word:agenda"]?.deleted === false, JSON.stringify({ mv, writes }));
  ok("知らない単語帳へは移さない", !M.moveMyWords(["word:kpi"], "nope").ok);
  writes.length = 0;
  const rm = M.removeMyWords(["word:kpi", "word:agenda", "word:nope"]);
  ok("まとめて消す: 2 語を消す（無い語は数えない）・語の保存は 1 回・墓標（ほかの端末からも消える）・ほかの語はそのまま", rm.ok && rm.removed === 2 && writesOf("spelldash_my_words") === 1 && writesOf("spelldash_user_items_meta") === 1 && !words().some((w) => w.en === "kpi" || w.en === "agenda") && meta()["my_word:kpi"]?.deleted === true && words().some((w) => w.en === "invoice"), JSON.stringify({ rm, writes }));
  ok("場面カードもまとめて消せる（種類で分ける）", M.removeMyWords(["concept:ssl"]).removed === 1 && !words().some((w) => w.kind === "concept"));

  // 単語帳を消す: その単語帳の語も消す（数を返す）。最後の 1 つは消さない
  const inWork = C.entriesOfBook(M.getMyWords(), W, M.getMyBooks()).length;
  writes.length = 0;
  const del = M.deleteMyBook(W);
  ok("単語帳を消す: その単語帳の語もまとめて消す（語の保存は 1 回）・ほかの単語帳の語は残る・単語帳の一覧から外れる", del.ok && del.removed === inWork && inWork === 3 && writesOf("spelldash_my_words") === 1 && !words().some((w) => w.book === W) && words().some((w) => w.en === "invoice") && books().length === 1 && books()[0].id === "main", JSON.stringify({ del, inWork }));
  ok("最後の 1 つの単語帳は消さない（語も消さない）", !M.deleteMyBook("main").ok && words().length > 0 && M.getMyBooks().length === 1);
  // 最初の単語帳を消すと、残った単語帳が最初になる（book の無い語は消した単語帳の語として一緒に消える）
  const t = M.createMyBook("旅行");
  M.addMyWord("passport", "旅券", t.book.id);
  const del2 = M.deleteMyBook("main");
  ok("最初の単語帳も、ほかがあれば消せる（book の無い前からの語も一緒に）・残った単語帳が最初", del2.ok && M.getMyBooks()[0].id === t.book.id && words().length === 1 && words()[0].en === "passport", JSON.stringify({ del2, w: words() }));
  // 読めない単語帳の保存は上書きしない
  reset({ spelldash_my_words: OLD, spelldash_my_books: "{broken" });
  ok("単語帳の保存が読めないときは作る・名前を変える・消すを断る（壊れた値を上書きしない）・語は最初の単語帳で見える", !M.createMyBook("仕事").ok && !M.deleteMyBook("main").ok && store.get("spelldash_my_books") === "{broken" && M.getMyBooks()[0].id === "main");
  // 単語帳の数の上限
  reset({ spelldash_my_books: JSON.stringify(Array.from({ length: C.MY_BOOKS_MAX }, (_, i) => ({ id: i ? `b${i}` : "main", name: i ? `帳${i}` : "マイ単語帳" }))) });
  ok(`単語帳は ${C.MY_BOOKS_MAX} 冊まで`, C.MY_BOOKS_MAX === 20 && !M.createMyBook("もう1つ").ok && /20/.test(M.createMyBook("もう1つ").error ?? ""));
}

console.log(`test-my-words: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
