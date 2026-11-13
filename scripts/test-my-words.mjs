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

// 偽の雲の読みの答えを本物の表の形にする（Batch 95 の直し）: updated_at は表の時刻の文字（UTC「+00:00」・秒の端数の末尾の 0 を落とす。端末の送った「…Z」の文字と違う）、
// payload（jsonb）の物の鍵は短い順・同じ長さはバイト順（端末の書いた並びと違う）
const dbTime = (iso) => {
  const ms = Date.parse(iso ?? "");
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  const frac = String(d.getUTCMilliseconds()).padStart(3, "0").replace(/0+$/, "");
  return `${d.toISOString().slice(0, 19)}${frac ? `.${frac}` : ""}+00:00`;
};
const jsonbOrder = (v) => (Array.isArray(v) ? v.map(jsonbOrder) : v && typeof v === "object"
  ? Object.fromEntries(Object.keys(v).sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b))).map((k) => [k, jsonbOrder(v[k])]))
  : v);
const dbRow = (r) => ({ ...r, updated_at: dbTime(r.updated_at), payload: jsonbOrder(r.payload) });

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
// Batch 82: カードに鍵（key = 保存の en）を足した。前からの語の id・en（答えの英語）・ja は前と同じ
eq("前からの語（英小文字）: id・en・ja は前と同じ・1 字ずつ判定・key は保存の鍵", C.wordCardOf({ en: "invoice", ja: "請求書" }), { id: "my-invoice", en: "invoice", ja: "請求書", key: "invoice", level: "easy", tags: ["my"], subject: "english", category: "my", addedAt: null });
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

// Batch 86: マイ単語帳の回は、回を始めるたびに これから を混ぜる（buildMyQueue の 3 つ目 { shuffle: rng }）。
// 答えの同じ行がまとまった単語帳（up・down の場面の行）で、位置から答えが分からないように。あやふや・覚えたの並びは前のまま。rng が無ければ前と同じ
{
  // 決まった種の rng（同じ種なら同じ並び）
  const seeded = (seed) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const updown = [
    ...Array.from({ length: 35 }, (_, i) => ({ en: "up", ja: `〈場面〉${i + 1}。上がる？下がる？` })),
    ...Array.from({ length: 35 }, (_, i) => ({ en: "down", ja: `〈場面〉${i + 36}。上がる？下がる？` }))
  ];
  const idOf = (w) => `${w.en}|${w.ja}`;
  const answersOf = (ids) => ids.map((id) => id.split("|")[0]);
  const head = answersOf(C.buildMyQueue(updown, idOf, { shuffle: seeded(86) }).slice(0, 10));
  ok("混ぜる: 35 up・35 down の単語帳（決まった種）の最初の 10 語に up と down の両方", head.includes("up") && head.includes("down"), JSON.stringify(head));
  let mixed = 0;
  for (let seed = 1; seed <= 50; seed++) {
    const h = answersOf(C.buildMyQueue(updown, idOf, { shuffle: seeded(seed) }).slice(0, 10));
    if (h.includes("up") && h.includes("down")) mixed++;
  }
  eq("混ぜる: 種 1〜50 のどれでも、最初の 10 語に up と down の両方", mixed, 50);
  const plain = C.buildMyQueue(updown, idOf);
  eq("rng が無ければ前と同じ（足した順）", answersOf(plain.slice(0, 10)), Array(10).fill("up"));
  eq("rng が無い形（undefined・{}・shuffle が関数でない）はどれも前と同じ", [C.buildMyQueue(list, undefined, undefined), C.buildMyQueue(list, undefined, {}), C.buildMyQueue(list, undefined, { shuffle: 1 })], [C.buildMyQueue(list), C.buildMyQueue(list), C.buildMyQueue(list)]);
  const sh = C.buildMyQueue(updown, idOf, { shuffle: seeded(7) });
  eq("混ぜても語は同じ（足りない・重なる語が無い）", [...sh].sort(), [...plain].sort());
  ok("混ぜた並びは足した順と違う", JSON.stringify(sh) !== JSON.stringify(plain));
  eq("同じ種なら同じ並び", C.buildMyQueue(updown, idOf, { shuffle: seeded(7) }), sh);
  // あやふや・覚えたは前のまま（最後に答えた時刻の古い順）。混ぜるのは これから の部分だけ
  const mq = C.buildMyQueue(list, undefined, { shuffle: seeded(3) });
  eq("混ぜるのは これから だけ: あやふや・覚えたの並びは前のまま", mq.slice(2), ["my-d1", "my-c1", "my-f1", "my-a1"]);
  eq("混ぜるのは これから だけ: これからの 2 語は先頭の 2 つ", [...mq.slice(0, 2)].sort(), ["my-b1", "my-e1"]);
  const mixedStates = [
    ...Array.from({ length: 12 }, (_, i) => ({ en: `n${i}`, ja: "x" })),
    { en: "u1", ja: "x", ls: 1, lsAt: 30 },
    { en: "u2", ja: "x", ls: 1, lsAt: 10 },
    { en: "l1", ja: "x", ls: 2, lsAt: 20 }
  ];
  const ms = C.buildMyQueue(mixedStates, undefined, { shuffle: seeded(11) });
  eq("これから 12 語を混ぜても、あやふや（古い順）→ 覚えたは後ろのまま", ms.slice(12), ["my-u2", "my-u1", "my-l1"]);
  ok("これから 12 語は混ざる（足した順と違う）", JSON.stringify(ms.slice(0, 12)) !== JSON.stringify(Array.from({ length: 12 }, (_, i) => `my-n${i}`)), JSON.stringify(ms.slice(0, 12)));
  // 偏らない（並べ替えに乱数の比べを使う形ではなく、どの位置にも同じ割合で来る）。2,000 回で先頭が up になる割合は 0.5 の近く
  const rnd = seeded(2026);
  let upFirst = 0;
  for (let i = 0; i < 2000; i++) if (C.buildMyQueue(updown, idOf, { shuffle: rnd })[0].startsWith("up|")) upFirst++;
  ok("偏らない: 2,000 回で先頭が up になる割合が 0.45〜0.55", upFirst >= 900 && upFirst <= 1100, String(upFirst));
  // 壊れた rng（1 を返す・数でない・範囲の外）でも、語が欠けたり重なったりしない
  for (const [name, bad] of [["1 を返す", () => 1], ["NaN を返す", () => NaN], ["負の数を返す", () => -0.5], ["2 を返す", () => 2]]) {
    const q = C.buildMyQueue(updown, idOf, { shuffle: bad });
    eq(`壊れた rng（${name}）でも語は同じ`, [...q].sort(), [...plain].sort());
  }
}
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
  // Batch 86: ?book の無い /mywords.html で開く単語帳。最初の単語帳に語が無く、ほかの単語帳に語があれば、語のある最初の単語帳（新しい保存の鍵は作らない）
  const dfb = typeof C.defaultBookId === "function" ? C.defaultBookId : () => "（defaultBookId が無い）";
  const three = [...books, { id: "w2", name: "家" }];
  eq("開く単語帳: 最初の単語帳に語があれば最初の単語帳", dfb(list, books), "main");
  eq("開く単語帳: 最初の単語帳が空で、ほかの単語帳に語があれば、語のある最初の単語帳（渡された単語帳だけを足した人）", dfb([{ en: "b", ja: "x", book: "w1" }], books), "w1");
  eq("開く単語帳: 空の単語帳を飛ばして、語のある最初の単語帳", dfb([{ en: "b", ja: "x", book: "w2" }], three), "w2");
  eq("開く単語帳: 語のある単語帳が 2 つなら前の方", dfb([{ en: "b", ja: "x", book: "w2" }, { en: "c", ja: "x", book: "w1" }], three), "w1");
  eq("開く単語帳: どこにも語が無ければ最初の単語帳", [dfb([], three), dfb(null, three)], ["main", "main"]);
  eq("開く単語帳: 一覧に無い単語帳の語（ほかの端末の単語帳）は、その単語帳を足した一覧（withWordBooks）で選べる",
    dfb([{ en: "b", ja: "x", book: "bx", bookName: "旅" }], C.withWordBooks(books, [{ en: "b", ja: "x", book: "bx", bookName: "旅" }])), "bx");
  eq("開く単語帳: 単語帳の一覧が空でも最初の単語帳の id", dfb([], []), "main");
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
  ok("名前を変える（前からの語は変えない）", M.renameMyBook(W, "仕事の英語").ok && books()?.[1]?.name === "仕事の英語" && store.get("spelldash_my_words") === OLD && !M.renameMyBook("nope", "x").ok);
  M.renameMyBook(W, "仕事");
  // 足す: 今の単語帳の id を語に付ける。同じ英語と同じ訳は全部の単語帳で 1 つ（ほかの単語帳にあれば、どの単語帳かを言う。Batch 82: 訳が違えば足せる。下の Batch 82 の節）
  const a1 = M.addMyWord("due diligence", "適正評価", W);
  const dup = M.addMyWord("KPI", "重要業績評価指標", W);
  ok("仕事に足す: 語に book（仕事の id）・ほかの欄は前と同じ形", a1.ok && words().at(-1).book === W && words().at(-1).en === "due diligence");
  ok("同じ英語と同じ訳はほかの単語帳にあれば足さない（「マイ単語帳」にあると言う）", !dup.ok && /「マイ単語帳」/.test(dup.error) && /すでに/.test(dup.error), JSON.stringify(dup));
  const dup2 = M.addMyWord("Due Diligence", "適正評価");
  ok("最初の単語帳に足すときも、仕事にある語（同じ英語と同じ訳）は「仕事」にあると言う", !dup2.ok && /「仕事」/.test(dup2.error), JSON.stringify(dup2));
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

  // ---- 2 台の端末（Batch 81 の反証）: 単語帳の一覧は端末の中だけ。語の book と bookName（単語帳の名前）は同期の my_word の payload で届く ----
  // 端末 Y: 一覧は マイ単語帳・旅行。端末 X で作った「仕事」（bx）の語と、名前の届いていない単語帳（bz）の語が同期で届いている
  const FOREIGN = [{ en: "invoice", ja: "請求書" }, { en: "deadline", ja: "締め切り", book: "bx", bookName: "仕事", ls: 2, lsAt: 7 }, { en: "memo", ja: "メモ", book: "bz" }, { en: "ticket", ja: "切符", book: "y1", bookName: "旅行" }];
  reset({ spelldash_my_books: JSON.stringify([{ id: "main", name: "マイ単語帳" }, { id: "y1", name: "旅行" }]), spelldash_my_words: JSON.stringify(FOREIGN) });
  eq("2 台目: ほかの端末の単語帳が名前つきで出る（名前が届いていなければ「ほかの端末の単語帳」）・読むだけでは書かない", [M.getMyBooks().map((b) => b.name), writes.length], [["マイ単語帳", "旅行", "仕事", "ほかの端末の単語帳"], 0]);
  const firstAll = C.entriesOfBook(M.getMyWords(), "main", M.getMyBooks()).map(C.entryRefOf);
  eq("2 台目: 最初の単語帳の「すべて選ぶ」はその単語帳の語だけ（ほかの端末の単語帳の語は入らない）", firstAll, ["word:invoice"]);
  const delMain = M.deleteMyBook("main");
  const dl = words().find((w) => w.en === "deadline");
  ok("2 台目: 最初の単語帳を消しても、ほかの端末の単語帳の語は残る（状態もそのまま・墓標を付けない）", delMain.ok && delMain.removed === 1 && dl?.ls === 2 && dl?.lsAt === 7 && words().some((w) => w.en === "memo") && meta()["my_word:deadline"] === undefined && meta()["my_word:memo"] === undefined && meta()["my_word:invoice"]?.deleted === true, JSON.stringify({ delMain, meta: meta() }));
  const home = M.createMyBook("家");
  const mvY = M.moveMyWords(["word:deadline"], home.book.id);
  const moved = words().find((w) => w.en === "deadline");
  ok("移すと語に移す先の単語帳の名前（bookName）も乗る（3 状態はそのまま）", mvY.ok && moved?.book === home.book.id && moved?.bookName === "家" && moved?.ls === 2, JSON.stringify(moved));
  ok("足すと語に単語帳の名前も乗る", M.addMyWord("receipt", "領収書", home.book.id).ok && words().at(-1).bookName === "家" && words().at(-1).book === home.book.id);
  ok("ほかの端末の単語帳へも移せる（名前つき）", M.moveMyWords(["word:receipt"], "bz").ok && words().find((w) => w.en === "receipt")?.bookName === "ほかの端末の単語帳");
  // 端末 X に同期で届いた形: X の一覧に「家」は無いが「家」として出る（X の最初の単語帳にも「仕事」にも混ざらない）
  reset({ spelldash_my_books: JSON.stringify([{ id: "main", name: "マイ単語帳" }, { id: "bx", name: "仕事" }]), spelldash_my_words: JSON.stringify([moved, { en: "budget", ja: "予算", book: "bx", bookName: "仕事" }].filter(Boolean)) });
  ok("1 台目: ほかの端末で移した語は、その端末の単語帳の名前で出る（最初の単語帳・仕事には入らない）", JSON.stringify(M.getMyBooks().map((b) => b.name)) === '["マイ単語帳","仕事","家"]' && C.entriesOfBook(M.getMyWords(), "main", M.getMyBooks()).length === 0 && C.entriesOfBook(M.getMyWords(), "bx", M.getMyBooks()).length === 1, JSON.stringify(M.getMyBooks()));
  // 名前を変える: その単語帳の語の bookName も替える（同期の印も）。ほかの端末の単語帳の名前を変えると、この端末の一覧に入る
  writes.length = 0;
  const rnX = M.renameMyBook("bx", "仕事の英語");
  ok("名前を変えると、その単語帳の語の bookName も替わる（語の保存 1 回・同期の印）", rnX.ok && words().find((w) => w.en === "budget")?.bookName === "仕事の英語" && writesOf("spelldash_my_words") === 1 && meta()["my_word:budget"]?.deleted === false && books()?.[1]?.name === "仕事の英語", JSON.stringify({ rnX, w: words() }));
  const rnH = M.renameMyBook(moved?.book, "家族");
  ok("ほかの端末の単語帳の名前を変えると、この端末の一覧に入る（語の bookName も）", rnH.ok && JSON.stringify(books()?.map((b) => b.name)) === '["マイ単語帳","仕事の英語","家族"]' && words().find((w) => w.en === "deadline")?.bookName === "家族", JSON.stringify(books()));
  // 一覧が 1 冊だけでも、ほかの端末の単語帳があれば最初の単語帳を消せる（ほかの端末の単語帳が一覧に入る。一覧を空にしない）
  reset({ spelldash_my_books: JSON.stringify([{ id: "main", name: "マイ単語帳" }]), spelldash_my_words: JSON.stringify([{ en: "invoice", ja: "請求書" }, { en: "deadline", ja: "締め切り", book: "bx", bookName: "仕事" }]) });
  const delOnly = M.deleteMyBook("main");
  ok("一覧が最初の単語帳だけ + ほかの端末の単語帳: 最初の単語帳を消すと一覧はほかの端末の単語帳になる（語は残る）", delOnly.ok && delOnly.removed === 1 && JSON.stringify(books()) === '[{"id":"bx","name":"仕事"}]' && words().length === 1 && words()[0].en === "deadline", JSON.stringify({ delOnly, b: books() }));
  // 最初の単語帳（main）が一覧に無い端末: book の無い語（前の版の端末から届いた語）は「マイ単語帳」に出る。今の先頭の単語帳を消しても消えない
  reset({ spelldash_my_books: JSON.stringify([{ id: "y1", name: "旅行" }, { id: "y2", name: "家" }]), spelldash_my_words: JSON.stringify([{ en: "invoice", ja: "請求書" }, { en: "ticket", ja: "切符", book: "y1" }]) });
  ok("main の無い端末: book の無い語は「マイ単語帳」に出る・先頭の単語帳を消しても残る", JSON.stringify(M.getMyBooks().map((b) => b.name)) === '["旅行","家","マイ単語帳"]' && M.deleteMyBook("y1").removed === 1 && words().some((w) => w.en === "invoice") && meta()["my_word:invoice"] === undefined, JSON.stringify(M.getMyBooks()));
}

// ---- 単語帳の並び（純）: 端末の一覧 + 語が持つ単語帳（ほかの端末で作った単語帳） ----
{
  const local = [{ id: "main", name: "マイ単語帳" }, { id: "y1", name: "旅行" }];
  const list = [{ en: "a", ja: "x" }, { en: "b", ja: "x", book: "bx", bookName: "仕事" }, { en: "c", ja: "x", book: "bx" }, { en: "d", ja: "x", book: "bz" }, { en: "e", ja: "x", book: "bq", bookName: "旅行" }, { en: "f", ja: "x", book: "y1", bookName: "別名" }, { en: "g", ja: "x", book: "bad id!" }];
  const wb = typeof C.withWordBooks === "function" ? C.withWordBooks : () => null;
  eq("一覧に無い id は語の名前で後ろに足す（初めて出た順）・名前が無ければ「ほかの端末の単語帳」・一覧と同じ名前には数を付ける・一覧にある id は一覧の名前",
    wb(local, list), [...local, { id: "bx", name: "仕事" }, { id: "bz", name: "ほかの端末の単語帳" }, { id: "bq", name: "旅行 2" }]);
  const books = wb(local, list) ?? local;
  eq("ほかの端末の単語帳の語はその単語帳（最初の単語帳は book の無い語と形の違う id の語だけ）", [C.entriesOfBook(list, "main", books).map((w) => w.en), C.entriesOfBook(list, "bx", books).map((w) => w.en)], [["a", "g"], ["b", "c"]]);
  eq("main が一覧に無い: book の無い語のために「マイ単語帳」を足す", wb([{ id: "y1", name: "旅行" }], [{ en: "a", ja: "x" }]), [{ id: "y1", name: "旅行" }, { id: "main", name: "マイ単語帳" }]);
  eq("語が無ければ一覧のまま", wb(local, []), local);
  eq("名前は 20 字まで・空白は 1 つに", wb(local, [{ en: "a", ja: "x", book: "bl", bookName: `  ${"長".repeat(25)}  ` }])?.[2]?.name, "長".repeat(20));
}

// ===== Batch 82: 同じ英語を何度も（訳が違えば足せる）・鍵と答えの英語・まとめて足すの矢印（docs/SPEC_MY_WORDS.md §11） =====
// 鍵（保存の en）は語の名前（同期の my_word:<鍵>・墓標・選んだ印 word:<鍵>・カードの id my-<鍵>・答えの書き手）。前からの語は 1 字も変えない。
// 同じ英語の 2 つ目からの語の鍵は <英語の鍵>~<訳の印 8 桁>（「~」は英語に使えない字）。答えの英語は answerKeyOf（鍵の「~」より前）
{
  const fn = (name) => (typeof C[name] === "function" ? C[name] : () => undefined); // 土台（8c38c7a）には無い: 投げずに落ちた数を数える
  const answerKeyOf = fn("answerKeyOf");
  const normJa = fn("normJa");
  const jaHash = fn("jaHash");
  const identityFor = fn("myIdentityFor");
  const parseLine = fn("parseBulkLine");
  const RAIN = "雨の日が続いた。傘の売れ行きは上がる？下がる？";
  // 見本と同じ形（英語は up と down・訳は場面の問い・1 行は訳に「→」）の、ほかの名前を含まない行
  const FIX = [
    `up, ${RAIN}`,
    "up, 品質が下がった→ 同じ席に高く払う。費用は上がる？下がる？",
    "up, 人気の歌手が来る。入場の料金は上がる？下がる？",
    "down, 晴れの日が続いた。傘の売れ行きは上がる？下がる？",
    "down, 材料の値が下がった。作る費用は上がる？下がる？",
    "down, 近くに安い店ができた。客の数は上がる？下がる？"
  ];
  const jaOf = (line) => line.slice(line.indexOf(",") + 1).trim();

  // ---- 純な決まり ----
  eq("答えの英語: 前からの語は鍵そのもの・2 つ目からの語は「~」より前", [answerKeyOf({ en: "up" }), answerKeyOf({ en: "due diligence" }), answerKeyOf({ en: "up~78d1e2c6" }), answerKeyOf({ en: "kpi~0123abcd", text: "KPI" })], ["up", "due diligence", "up", "kpi"]);
  eq("訳を比べる形: NFKC・前後の空白を落とす・空白の並びは 1 つ", normJa("  ＣＰＣ は　上がる "), "CPC は 上がる");
  eq("訳の印: FNV-1a 32 ビット（正規化した訳の UTF-8）の 16 進 8 桁（公開の値: 空 811c9dc5・a e40c292c・foobar bf9cf968）", [jaHash(""), jaHash("a"), jaHash("foobar")], ["811c9dc5", "e40c292c", "bf9cf968"]);
  eq("訳の印は正規化した訳で決まる（端末をまたいで同じ）・長くしても頭の 8 桁は同じ（16・32 桁は「<番号>\\0<訳>」の印を後ろに）",
    [jaHash(RAIN), jaHash(`  ${RAIN.replace(/？/g, "?")} `), jaHash(RAIN, 16), jaHash(RAIN, 32)], ["78d1e2c6", "78d1e2c6", "78d1e2c60abc0b01", "78d1e2c60abc0b015c335524c0e73d4f"]);
  const up = { en: "up", ja: RAIN };
  eq("鍵: 同じ英語が無ければ英語の鍵のまま（前と同じ）", identityFor([], "up", RAIN), "up");
  eq("鍵: 同じ英語があれば <英語>~<訳の印 8 桁>", identityFor([up], "up", "別の訳"), `up~${jaHash("別の訳")}`);
  eq("鍵: 同じ組なら端末をまたいで同じ鍵（ほかの語や並びに依らない・訳の空白は正規化）",
    [identityFor([up, { en: "down", ja: "x" }], "up", " 別の訳 "), identityFor([{ en: "zz", ja: "y" }, up], "up", "別の訳")], [`up~${jaHash("別の訳")}`, `up~${jaHash("別の訳")}`]);
  eq("鍵: 8 桁の鍵がもう使われていれば（印の重なり・訳を直した語）16 桁に", identityFor([up, { en: `up~${jaHash("別の訳")}`, ja: "直した訳" }], "up", "別の訳"), `up~${jaHash("別の訳", 16)}`);
  eq("鍵: 場面カードの鍵とも重ねない（同期の項目 my_word:<鍵> を分ける）", identityFor([{ kind: "concept", en: "ssl", q: "q", answer: "SSL" }], "ssl", "暗号化"), `ssl~${jaHash("暗号化")}`);
  {
    const long = "a".repeat(150);
    const taken = [{ en: long, ja: "x" }, ...[8, 16, 24].map((n) => ({ en: `${long}~${jaHash("y", n)}`, ja: "z" }))];
    const id = identityFor(taken, long, "y");
    ok("鍵は 200 字まで（同期の key の上限 char_length(key) <= 200。メモの鍵 my-<鍵> も）・32 桁まで長くできる", typeof id === "string" && id === `${long}~${jaHash("y", 32)}` && `my-${id}`.length <= 200, String(id));
  }
  const dupUp = { en: `up~${jaHash("別の訳")}`, text: "up", ja: "別の訳" };
  const c1 = C.wordCardOf(dupUp);
  ok("2 つ目からの語のカード: id は my-<鍵>・en は答えの英語 up・key は鍵・1 字ずつ判定・up と打つと正解", c1.id === `my-${dupUp.en}` && c1.en === "up" && c1.key === dupUp.en && !c1.free && !("answer" in c1) && answerModeOf(c1).mode === "spell" && typeAnswer(c1, acceptedAnswers(c1, null), "up").how === "auto", JSON.stringify(c1));
  const c2 = C.wordCardOf({ en: `kpi~${jaHash("別の訳")}`, text: "KPI", ja: "別の訳" });
  ok("大文字の語の 2 つ目: en は kpi・画面は KPI（answer）・kpi と打って正解", c2.en === "kpi" && c2.answer === "KPI" && String(c2.key).startsWith("kpi~") && typeAnswer(c2, acceptedAnswers(c2, null), "kpi").how === "auto", JSON.stringify(c2));
  const c3 = C.wordCardOf({ en: `due diligence~${jaHash("別の訳")}`, text: "due diligence", ja: "別の訳" });
  ok("熟語の 2 つ目: 全文入力（答えの英語で判定）", c3.free === true && c3.en === "due diligence" && typeAnswer(c3, acceptedAnswers(c3, null), "Due Diligence").how === "enter", JSON.stringify(c3));
  eq("画面の形: 2 つ目からの語は text（無ければ答えの英語。鍵の印は見せない）", [C.displayOf(dupUp), C.displayOf({ en: "up~0000abcd", ja: "x" }), C.displayOf({ en: "kpi~0000abcd", text: "KPI", ja: "x" })], ["up", "up", "KPI"]);
  eq("列・回の結果・選んだ印は鍵ごと（同じ英語の語も別々）",
    [C.buildMyQueue([up, dupUp]), C.mySummary([`my-${dupUp.en}`], [{ ...up, ls: 2 }, { ...dupUp, ls: 1 }], 0), C.entryRefOf(dupUp)], [["my-up", `my-${dupUp.en}`], { learned: 0, unsure: 1, dayOne: 0 }, `word:${dupUp.en}`]);

  // ---- まとめて足すの 1 行（区切り・矢印） ----
  eq("まとめての行: 区切りの前が英語なら英語の語（訳の中の「→」は字のまま）", parseLine(FIX[1]), { en: "up", ja: "品質が下がった→ 同じ席に高く払う。費用は上がる？下がる？" });
  eq("まとめての行: 訳の中の読点・カンマも字のまま（区切りは最初の 1 つ）", parseLine("up, 雨、風、雪, 外の作業は増える？減る？"), { en: "up", ja: "雨、風、雪, 外の作業は増える？減る？" });
  eq("まとめての行: 区切りの無い矢印の行は、英語の側と訳の側に分ける（→ ⇒ => ->）",
    [parseLine("e-mail -> 電子メール"), parseLine("電子メール → e-mail"), parseLine("follow up ⇒ 追って連絡する"), parseLine("agenda => 議題")],
    [{ en: "e-mail", ja: "電子メール" }, { en: "e-mail", ja: "電子メール" }, { en: "follow up", ja: "追って連絡する" }, { en: "agenda", ja: "議題" }]);
  const noEn = parseLine("品質が下がった → 同じ席に高く払う");
  ok("まとめての行: 英語の無い矢印の行は断る（「english, 訳」の形を言う）・場面カードにしない", !!noEn?.error && /「english, 訳」/.test(noEn.error) && noEn.kind !== "concept", JSON.stringify(noEn));
  const oldScene = parseLine("Cost ÷ Click → CPC | クリック単価");
  ok("まとめての行: 前の場面カードの形（場面 → 用語 | 解説）も場面カードにしない（断る）", !!oldScene?.error && oldScene.kind !== "concept", JSON.stringify(oldScene));
  eq("まとめての行: 矢印の無い行は前のまま（英語と日本語の境・タブ・使えない字は確かめへ回す）",
    [parseLine("due diligence 適正評価"), parseLine("invoice\t請求書"), parseLine("bad/entry, だめ")], [{ en: "due diligence", ja: "適正評価" }, { en: "invoice", ja: "請求書" }, { en: "bad/entry", ja: "だめ" }]);

  // ---- 保存（js/myWords.js）と 2 台の同期（js/userItemsSync.js）。localStorage の写しを端末ごとに替える ----
  const devices = { X: new Map(), Y: new Map() };
  let cur = devices.X;
  globalThis.localStorage = { getItem: (k) => (cur.has(k) ? cur.get(k) : null), setItem: (k, v) => { cur.set(k, String(v)); }, removeItem: (k) => cur.delete(k), clear: () => cur.clear(), key: (i) => [...cur.keys()][i] ?? null, get length() { return cur.size; } };
  const use = (name) => { cur = devices[name]; };
  const M = await import("../js/myWords.js");
  const S = await import("../js/userItemsSync.js");
  const words = () => JSON.parse(cur.get("spelldash_my_words") || "[]");
  const meta = () => JSON.parse(cur.get("spelldash_user_items_meta") || "{}");
  const tick = () => new Promise((r) => setTimeout(r, 5)); // 同期の印の時刻を進める（新しい方が勝つ）
  const seed = (entries) => { cur.clear(); cur.set("spelldash_my_words", JSON.stringify(entries)); };
  const T = "2026-11-07T00:00:00.000Z";

  // 創業者の 1 回目の試しの後の形（前の版）: up（1 行目）・down（4 行目）・「→」の行から場面カードが 1 枚（前の版のまとめて足すが作った形）
  const sceneAnswer = "同じ席に高く払う。費用は上がる？下がる？";
  const OLD3 = [
    { en: "up", ja: jaOf(FIX[0]), book: "main", bookName: "マイ単語帳", addedAt: T },
    { kind: "concept", en: M.conceptKey(sceneAnswer), answer: sceneAnswer, q: "up, 品質が下がった", explain: "", accept: [], ja: "", book: "main", bookName: "マイ単語帳", addedAt: T },
    { en: "down", ja: jaOf(FIX[3]), book: "main", bookName: "マイ単語帳", addedAt: T }
  ];
  seed(OLD3);
  const r1 = M.addMyWordsBulk(FIX.join("\n"), "main");
  const w1 = words();
  ok("まとめて足す: 同じ英語でも訳が違う 4 行は入り、前からある同じ組（up・down の 2 行）は「同じ訳で「マイ単語帳」にすでに登録」で飛ばす",
    r1.added.length === 4 && r1.skipped.length === 2 && r1.skipped.every((s) => /同じ訳/.test(s) && /「マイ単語帳」/.test(s) && /すでに登録/.test(s)), JSON.stringify(r1));
  ok("前からの語と場面カードは 1 字も変えない（並びも同じ）・場面カードは増えない", JSON.stringify(w1.slice(0, 3)) === JSON.stringify(OLD3) && w1.filter((w) => w.kind === "concept").length === 1, JSON.stringify(w1.slice(0, 4)));
  const added = w1.slice(3);
  ok("足した 4 語: 鍵は <英語>~<訳の印 8 桁>・text は英語・訳は 1 行の全部（「→」も）・今の単語帳",
    added.length === 4 && added.every((w) => w.kind !== "concept" && /^(up|down)~[0-9a-f]{8}$/.test(w.en) && w.en === `${w.text}~${jaHash(w.ja)}` && w.book === "main") && added[0].ja === jaOf(FIX[1]) && added[0].ja.includes("→"),
    JSON.stringify(added));
  const inPaste = M.addMyWordsBulk(`${FIX[2]}\nup, 新しい場面。何かは上がる？下がる？\nup, 新しい場面。何かは上がる？下がる？`, "main");
  ok("1 回の貼り付けの中でも同じ組の 2 つ目は飛ばす（前からある組も）", inPaste.added.length === 1 && inPaste.skipped.length === 2 && words().filter((w) => w.ja === "新しい場面。何かは上がる？下がる？").length === 1, JSON.stringify(inPaste));
  const noEnBulk = M.addMyWordsBulk("品質が下がった → 同じ席に高く払う", "main");
  ok("まとめて足す: 英語の無い矢印の行は足さない（理由に「english, 訳」）・場面カードも作らない", noEnBulk.added.length === 0 && noEnBulk.skipped.length === 1 && /「english, 訳」/.test(noEnBulk.skipped[0]) && words().filter((w) => w.kind === "concept").length === 1, JSON.stringify(noEnBulk));
  const caseDup = M.addMyWord("UP", `  ${jaOf(FIX[2]).replace(/？/g, "?")} `, "main");
  ok("1 語ずつ: 大文字小文字・訳の空白と全角半角が違うだけの同じ組は断る（同じ訳で「マイ単語帳」にすでに登録）", !caseDup.ok && /同じ訳/.test(caseDup.error ?? "") && /「マイ単語帳」/.test(caseDup.error ?? ""), JSON.stringify(caseDup));
  const other = M.addMyWord("Up", "違う訳の場面。何かは上がる？下がる？", "main");
  ok("1 語ずつ: 違う訳なら同じ英語も足せる（画面の形は打ったとおり Up・答えは up）", other.ok && words().at(-1).text === "Up" && words().at(-1).en === `up~${jaHash("違う訳の場面。何かは上がる？下がる？")}` && C.wordCardOf(words().at(-1)).en === "up", JSON.stringify(words().at(-1)));
  const cards = M.toWordObjects();
  ok("出題のカード: 同じ英語の語はカードの id が別々・答えの英語は up／down・場面カードはそのまま", new Set(cards.map((c) => c.id)).size === cards.length && cards.filter((c) => c.kind !== "concept").every((c) => c.en === "up" || c.en === "down") && cards.filter((c) => c.kind === "concept").length === 1, JSON.stringify(cards.map((c) => c.id)));

  // 学ぶ回の答えは鍵で当てる（同じ英語のほかの語・前からの語は変えない）
  const idA = added[0]?.en ?? "(none)"; // 「→」の行（土台では足せないので無い）
  const idB = added[1]?.en ?? "(none)";
  ok("答えはその鍵の語にだけ当たる（同じ英語のほかの語・前からの語は変えない）・同期の印もその鍵だけ",
    M.recordMyAnswer(idA, ANSWER_KINDS.exact, T0) === true && words().find((w) => w.en === idA)?.ls === 2 && words().filter((w) => w.en !== idA).every((w) => !("ls" in w)) && meta()[`my_word:${idA}`]?.deleted === false && meta()["my_word:up"] === undefined,
    JSON.stringify(words().map((w) => [w.en, w.ls ?? 0])));
  M.recordMyAnswer(idB, ANSWER_KINDS.miss, T0);
  ok("1 打ミスもその鍵の語だけ（あやふや）", words().find((w) => w.en === idB)?.ls === 1 && words().find((w) => w.en === "up")?.ls === undefined && words().find((w) => w.en === idA)?.ls === 2);
  // 1 つ消す（行の「消す」）・移す・訳を直す
  M.removeMyWord(idB, "word");
  ok("1 つ消す（行の「消す」）: その鍵の語だけが消え、墓標もその鍵だけ（同じ英語のほかの語・前からの語は残る）",
    !words().some((w) => w.en === idB) && words().some((w) => w.en === idA) && JSON.stringify(words().slice(0, 3)) === JSON.stringify(OLD3) && meta()[`my_word:${idB}`]?.deleted === true && meta()["my_word:up"] === undefined, JSON.stringify(meta()));
  const bk = M.createMyBook("場面");
  const mv = M.moveMyWords([`word:${idA}`], bk.book?.id);
  ok("移す: 選んだ鍵の語だけが移る（同じ英語のほかの語は今の単語帳のまま）", mv.ok && mv.moved === 1 && words().find((w) => w.en === idA)?.book === bk.book.id && words().find((w) => w.en === "up")?.book === "main" && words().find((w) => w.en === idA)?.ls === 2, JSON.stringify(mv));
  const beforeEdit = cur.get("spelldash_my_words");
  const ed = M.setMyWordJa(idA, jaOf(FIX[0]));
  ok("訳を直して同じ英語と同じ訳の組になるときは断る（どの単語帳にあるかを言う・保存は変えない）", !ed.ok && /同じ訳/.test(ed.error ?? "") && /「マイ単語帳」/.test(ed.error ?? "") && cur.get("spelldash_my_words") === beforeEdit, JSON.stringify(ed));
  const ed2 = M.setMyWordJa(idA, "直した訳。何かは上がる？下がる？");
  ok("訳を直す: ほかの組と重ならなければ直る・鍵（en）は変えない（同期の項目は同じ）・状態と単語帳もそのまま", ed2.ok && words().find((w) => w.en === idA)?.ja === "直した訳。何かは上がる？下がる？" && words().find((w) => w.en === idA)?.ls === 2 && words().find((w) => w.en === idA)?.book === bk.book.id, JSON.stringify(ed2));
  ok("同じ訳のまま保存しても断らない（自分とは重ならない）", M.setMyWordJa(idA, "直した訳。何かは上がる？下がる？").ok === true);
  const again = M.addMyWord("up", jaOf(FIX[1]), "main");
  ok("直した語の前の訳でもう一度足すと入る（その 8 桁の鍵は直した語が使っているので 16 桁）", again.ok && idA === `up~${jaHash(jaOf(FIX[1]))}` && words().at(-1).en === `up~${jaHash(jaOf(FIX[1]), 16)}`, JSON.stringify(words().at(-1)));
  const sameNew = M.addMyWord("up", "直した訳。何かは上がる？下がる？", "main");
  ok("訳を直した語の新しい訳と同じ組は足さない（直した語と重なる。どの単語帳かを言う）", !sameNew.ok && /同じ訳/.test(sameNew.error ?? "") && /「場面」/.test(sameNew.error ?? ""), JSON.stringify(sameNew));
  // 上限は語の数（前のまま）
  seed(Array.from({ length: 100 }, (_, i) => ({ en: i ? `w${"abcdefghij"[i % 10]}${"abcdefghij"[Math.floor(i / 10)]}` : "up", ja: `訳${i}` })));
  const full = M.addMyWord("up", "まだ無い訳", "main");
  ok("上限（無料 100 語）は語の数のまま: 同じ英語の違う訳も 101 語目は足さない", !full.ok && /100語/.test(full.error ?? ""), JSON.stringify(full));
  // Batch 87（docs/SPEC_MY_WORDS.md §16.5）: まとめて足すで上限に当たった行は数えるだけ（limited）。決まりに合わない行の理由（skipped）に上限の文を混ぜない。
  // 98 語の人が 7 行（同じ組・使えない字・訳なし・新しい 4 行）を貼る → 2 語を足し、上限で 2 行・理由のある 3 行。欄に残す 5 行は貼った形と順のまま
  seed(Array.from({ length: 98 }, (_, i) => ({ en: i ? `w${"abcdefghij"[i % 10]}${"abcdefghij"[Math.floor(i / 10)]}` : "up", ja: `訳${i}` })));
  const lim = M.addMyWordsBulk(["up, 訳0", "bad/entry, だめ", "invoice", "alpha, アルファ", "bravo, ブラボー", "charlie, チャーリー", "delta, デルタ"].join("\n"), "main");
  ok("まとめて足すで上限: 98 語の人に 7 行 → added 2・limited 2・skipped 3（同じ組・使えない字・訳なし。上限の文を含まない）・rest 5（貼った形と順のまま）・保存は 100 語",
    lim.added?.length === 2 && lim.limited === 2 && lim.skipped?.length === 3 && !lim.skipped.some((s) => /100語/.test(s))
      && /同じ訳/.test(lim.skipped[0] ?? "") && /^bad\/entry（だめ）: /.test(lim.skipped[1] ?? "") && /^invoice: 日本語訳を入力/.test(lim.skipped[2] ?? "")
      && JSON.stringify(lim.rest) === JSON.stringify(["up, 訳0", "bad/entry, だめ", "invoice", "charlie, チャーリー", "delta, デルタ"]) && words().length === 100,
    JSON.stringify(lim));

  // ---- 2 台の端末: 項目は鍵ごと（my_word:<鍵>）。同じ英語の語は別々の項目として行き来し、消すとその鍵だけ墓標 ----
  devices.X.clear();
  devices.Y.clear();
  use("X");
  M.addMyWord("up", "訳A", "main"); await tick();
  M.addMyWord("up", "訳B", "main"); await tick();
  M.addMyWord("up", "訳C", "main"); await tick();
  const idsX = words().map((w) => w.en);
  const rowsX = S.buildDirtyRows("u1");
  S.clearDirtyItems();
  ok("X: 同じ英語の 3 語は別々の項目（鍵 up・up~<訳B の印>・up~<訳C の印>。payload は語の全体）",
    JSON.stringify(idsX) === JSON.stringify(["up", `up~${jaHash("訳B")}`, `up~${jaHash("訳C")}`]) && JSON.stringify(rowsX.map((r) => r.key).sort()) === JSON.stringify([...idsX].sort()) && rowsX.every((r) => r.kind === "my_word" && !r.deleted && r.payload.en === r.key),
    JSON.stringify(rowsX.map((r) => [r.key, r.deleted])));
  use("Y");
  S.mergeCloudItems(rowsX, "u1");
  ok("Y: X の 3 語がそのまま届く（payload は 1 字も同じ）", cur.get("spelldash_my_words") === devices.X.get("spelldash_my_words"), String(cur.get("spelldash_my_words")).slice(0, 200));
  await tick();
  M.addMyWord("up", "訳D", "main"); await tick();
  M.removeMyWords([`word:${idsX[1]}`]); await tick();
  const rowsY = S.buildDirtyRows("u1");
  S.clearDirtyItems();
  ok("Y: 足した語と消した語だけを送る（墓標は消した鍵だけ）", rowsY.length === 2 && rowsY.some((r) => r.key === idsX[1] && r.deleted) && rowsY.some((r) => r.key === `up~${jaHash("訳D")}` && !r.deleted), JSON.stringify(rowsY.map((r) => [r.key, r.deleted])));
  use("X");
  const plainX = JSON.stringify(words()[0]);
  S.mergeCloudItems(rowsY, "u1");
  ok("X: Y で消した 1 語だけが消え、Y で足した語が入る・前からの語（up）は 1 字も同じ", JSON.stringify(words().map((w) => w.en)) === JSON.stringify([idsX[0], idsX[2], `up~${jaHash("訳D")}`]) && JSON.stringify(words()[0]) === plainX, JSON.stringify(words().map((w) => w.en)));
  // 決まった鍵: 2 台が同じ前からの up を持っていて、同じ組（up・訳E）をそれぞれ足すと同じ鍵（同期で 1 語にまとまる）
  await tick();
  M.addMyWord("up", "訳E", "main");
  const eX = words().at(-1).en;
  const rowsX2 = S.buildDirtyRows("u1");
  S.clearDirtyItems();
  await tick();
  use("Y");
  M.addMyWord("up", "訳E", "main");
  const eY = words().at(-1).en;
  S.mergeCloudItems(rowsX2, "u1");
  ok("決まった鍵: 2 台で同じ組を足すと同じ鍵 up~<訳E の印>・同期で 1 語にまとまる", eX === eY && eX === `up~${jaHash("訳E")}` && words().filter((w) => w.ja === "訳E").length === 1, JSON.stringify({ eX, eY, n: words().filter((w) => w.ja === "訳E").length }));
  // 前からの語（up）を消すと墓標は my_word:up だけ。同じ英語の 2 つ目からの語は残る
  use("X");
  await tick();
  M.removeMyWord("up", "word");
  const rowsX3 = S.buildDirtyRows("u1");
  S.clearDirtyItems();
  use("Y");
  S.mergeCloudItems(rowsX3, "u1");
  ok("前からの語を消すと、墓標は my_word:up だけ・ほかの端末でも up だけが消え、同じ英語のほかの語は残る", rowsX3.length === 1 && rowsX3[0].key === "up" && rowsX3[0].deleted && !words().some((w) => w.en === "up") && words().filter((w) => w.en.startsWith("up~")).length >= 2, JSON.stringify(words().map((w) => w.en)));

  // ---- 反証の直し: まとめて足すで断った行。英語は up と down だけの行が並ぶので、理由は英語と訳の頭でどの行かを言う（英語だけでは分からない）。
  //      断った行（貼った形のまま）を rest に返す: 画面は足した後の欄にその行だけを残す（もう一度押しても、足した行をまた断らない） ----
  devices.X.clear();
  use("X");
  seed([{ en: "up", ja: RAIN, book: "main", bookName: "マイ単語帳", addedAt: T }]);
  const NEW_A = "up, 夕方に雨がやんだ。夜の客の数は上がる？下がる？";
  const NEW_B = "up, 祭りが近づいた。駅の人の数は上がる？下がる？";
  const LONG_JA = `${"長い場面の説明が続く。".repeat(4)}何かは上がる？下がる？`;
  const pasted = [NEW_A, `up, ${RAIN}`, NEW_B, NEW_A, `up, ${LONG_JA}`, `UP, ${LONG_JA}`];
  const r5 = M.addMyWordsBulk(pasted.join("\n"), "main");
  const sk = r5.skipped ?? [];
  ok("まとめて足す: 訳が違う up の 3 行は入り、前からある組・貼り付けの中の 2 度目（大文字小文字だけ違う行も）の 3 行は断る",
    r5.added?.length === 3 && sk.length === 3 && words().length === 4 && sk.every((s) => /同じ訳で「マイ単語帳」にすでに登録されています/.test(s)), JSON.stringify(r5));
  ok("断った理由は英語と訳の頭（24 字まで）でどの行かを言う（「up（雨の日が続いた。…）: 同じ訳で…」。長い訳は頭だけ）",
    sk[0]?.startsWith(`up（${RAIN.slice(0, 12)}`) && sk[1]?.startsWith(`up（${jaOf(NEW_A).slice(0, 12)}`) && sk[2]?.startsWith(`UP（${LONG_JA.slice(0, 24)}…）`) && !sk[2]?.includes(LONG_JA),
    JSON.stringify(sk));
  eq("断った行は貼った形のまま返す（画面は欄にその行だけを残す）", r5.rest ?? null, [`up, ${RAIN}`, NEW_A, `UP, ${LONG_JA}`]);
  const r6 = M.addMyWordsBulk((r5.rest ?? pasted).join("\n"), "main");
  ok("残した行をもう一度足すと、断るのはその行だけ（前に足した行をまた断らない）・保存は変えない", r6.added?.length === 0 && r6.skipped?.length === 3 && words().length === 4, JSON.stringify(r6));
  const r7 = M.addMyWordsBulk("invoice\nbad/entry, だめ\n品質が下がった → 同じ席に高く払う", "main");
  ok("ほかの理由の行も残す（訳なし・使えない字・英語の無い行）・訳のある行は訳の頭も添える", JSON.stringify(r7.rest ?? null) === JSON.stringify(["invoice", "bad/entry, だめ", "品質が下がった → 同じ席に高く払う"]) && /^invoice: 日本語訳を入力/.test(r7.skipped?.[0] ?? "") && /^bad\/entry（だめ）: /.test(r7.skipped?.[1] ?? "") && /「english, 訳」/.test(r7.skipped?.[2] ?? ""), JSON.stringify(r7));

  // ---- 反証の直し: 片側が空の矢印（行の頭か終わり）と英語の無い行。矢印を訳にも英語にもしない・英語の無い行は「english, 訳」の形を言う ----
  eq("片側が空の矢印: 英語の側だけなら訳なしの語（足すときの確かめが「日本語訳を入力してください」）・矢印を訳にしない",
    [parseLine("up ->"), parseLine("-> up"), parseLine("e-mail →"), parseLine("follow up =>")], [{ en: "up", ja: "" }, { en: "up", ja: "" }, { en: "e-mail", ja: "" }, { en: "follow up", ja: "" }]);
  for (const line of ["-> 訳だけ", "→ 何か", "何か →", "->", "ただの日本語の行", "123 数字", "、訳だけ"]) {
    const p = parseLine(line);
    ok(`英語の無い行は断る（「english, 訳」の形を言う）: 「${line}」`, !!p?.error && /^英語が無い。/.test(p.error) && /「english, 訳」/.test(p.error) && p.line === line, JSON.stringify(p));
  }
  eq("英字のある行は前のまま（全角の英字は NFKC で英語・使えない字と訳なしは足すときの確かめが言う）",
    [parseLine("ＫＰＩ 指標"), parseLine("café 喫茶店"), parseLine("invoice"), parseLine("bad/entry, だめ")], [{ en: "ＫＰＩ", ja: "指標" }, { en: "café", ja: "喫茶店" }, { en: "invoice", ja: "" }, { en: "bad/entry", ja: "だめ" }]);
  devices.X.clear();
  const edge = M.addMyWordsBulk("up ->\n-> 訳だけ\nup, 上がる", "main");
  ok("まとめて足す: 「up ->」は訳が「->」の語にしない（訳なしで断る）・英語の無い矢印の行も断る・ふつうの行は入る",
    edge.added?.length === 1 && edge.skipped?.length === 2 && /^up: 日本語訳を入力/.test(edge.skipped[0] ?? "") && /「english, 訳」/.test(edge.skipped[1] ?? "") && !words().some((w) => w.ja === "->") && words().length === 1,
    JSON.stringify({ edge, words: words().map((w) => [w.en, w.ja]) }));
}

// ===== Batch 82 部分 B: 選択式（js/myWordsChoice.js。docs/SPEC_MY_WORDS.md §12） =====
// 向きは 2 つ（訳を見て英語を選ぶ＝既定・英語を見て訳を選ぶ。URL の ?choice= だけに持つ）。選択肢は正解 1 つと同じ範囲（単語帳）の違う答え 3 つまで（2〜4 個）。
// 正規化して重ねない・2 つ目の正解を出さない（同じ英語の語・同じ訳の語）・範囲に違う答えが 1 つも無いときだけほかの単語帳 → 組み込みの短い一覧・決まった乱数で並ぶ。
// 数え方は打つ回と同じ: 選んだ答えは全文入力の答えとして判定の道（js/judge.js answerMatches）を通る（正解 → 自力正解・違う → 1 打ミス・分からない → 答えを見る）。
// 1 問に 1 回だけ記録する守り（2 度押し・キーの押しっぱなし・前の問い・開き直したページの古い問い）
{
  let X = {};
  try {
    X = await import("../js/myWordsChoice.js");
  } catch (e) {
    ok("選択式: js/myWordsChoice.js を読める", false, e.message);
  }
  const fn = (name) => (typeof X[name] === "function" ? X[name] : () => undefined); // 土台（8c38c7a・部分 A の 23102f0）には無い: 投げずに落ちた数を数える
  const build = fn("buildChoice");
  const dirOf = fn("choiceDirOf");
  const urlOf = fn("choiceUrl");
  const typedUrlOf = fn("typedUrl");
  const typedAs = fn("typedAsOf");
  const seeded = fn("seededRandom");
  const guardOf = fn("createChoiceGuard");
  const J = await import("../js/judge.js");
  const jaHash = typeof C.jaHash === "function" ? C.jaHash : (s) => String(s.length).padStart(8, "0");
  const answerKeyOf = typeof C.answerKeyOf === "function" ? C.answerKeyOf : (w) => String(w?.en ?? "").split("~")[0];
  const T = "2026-11-07T00:00:00.000Z";
  const e = (en, ja, more = {}) => ({ en, ja, addedAt: T, ...more });
  const dup = (en, ja, more = {}) => e(`${en}~${jaHash(ja)}`, ja, { text: en, ...more });
  const texts = (r) => (r?.options ?? []).map((o) => o.text);
  const right = (r) => (r?.options ?? []).filter((o) => o.correct);
  // 見本と同じ形の、ほかの名前を含まない up／down の単語帳（前の試しで 1 枚できた場面カードも入れる。出題にも選択肢にも出ない）
  const UPDOWN = [
    e("up", "雨の日が続いた。傘の売れ行きは上がる？下がる？", { book: "main" }),
    { kind: "concept", en: "scene", answer: "同じ席に高く払う。費用は上がる？下がる？", q: "up, 品質が下がった", explain: "", accept: [], ja: "", book: "main", addedAt: T },
    dup("up", "品質が下がった→ 同じ席に高く払う。費用は上がる？下がる？", { book: "main" }),
    dup("up", "人気の歌手が来る。入場の料金は上がる？下がる？", { book: "main" }),
    e("down", "晴れの日が続いた。傘の売れ行きは上がる？下がる？", { book: "main" }),
    dup("down", "材料の値が下がった。作る費用は上がる？下がる？", { book: "main" }),
    dup("down", "近くに安い店ができた。客の数は上がる？下がる？", { book: "main" })
  ];
  const UD = UPDOWN.filter(C.isWordEntry);

  // ---- 入口と向き（URL だけに持つ。新しい保存の鍵は無い） ----
  eq("選択式の向き: ?choice=en（既定）・?choice=ja（英語を見て訳を選ぶ）・空や知らない値は既定・?choice が無ければ打つ回（null）",
    [dirOf("?learn=my&choice=en"), dirOf("?learn=my&book=main&choice=ja"), dirOf("?learn=my"), dirOf("?learn=my&book=main"), dirOf("?learn=my&choice="), dirOf("?learn=my&choice=xx"), dirOf(new URLSearchParams("learn=my&choice=ja"))],
    ["en", "ja", null, null, "en", "en", "ja"]);
  eq("選択式の URL（単語帳ごと・全部の単語帳）と打つ回の URL（前のまま /?learn=my[&book=]）",
    [urlOf("main", "en"), urlOf("b1x", "ja"), urlOf(null, "en"), urlOf("main"), typedUrlOf("main"), typedUrlOf(null), urlOf("a b", "ja")],
    ["/?learn=my&book=main&choice=en", "/?learn=my&book=b1x&choice=ja", "/?learn=my&choice=en", "/?learn=my&book=main&choice=en", "/?learn=my&book=main", "/?learn=my", "/?learn=my&book=a%20b&choice=ja"]);
  eq("向きの名前", X.CHOICE_DIRS ?? null, { en: "訳を見て英語を選ぶ", ja: "英語を見て訳を選ぶ" });

  // ---- 訳を見て英語を選ぶ（既定）: 創業者の up／down の単語帳はちょうど 2 択 ----
  {
    const bad = [];
    for (const [i, w] of UD.entries()) {
      for (let s = 1; s <= 8; s++) {
        const r = build({ entry: w, scope: UPDOWN, others: [], dir: "en", rand: seeded(i * 100 + s) });
        const t = texts(r);
        if (!(r?.ok && t.length === 2 && JSON.stringify([...t].sort()) === '["down","up"]' && right(r).length === 1 && right(r)[0].text === answerKeyOf(w) && r.prompt === w.ja && r.from === "scope")) bad.push({ w: w.en, r });
      }
    }
    ok("訳を見て英語を選ぶ（up／down の単語帳・6 語 × 8 通りの乱数）: 選択肢はちょうど up と down の 2 つ・正解は 1 つでその語の英語・問いはその語の訳（「→」の行も 1 行の全部）・範囲の中だけ（埋めない）", UD.length === 6 && bad.length === 0, JSON.stringify(bad.slice(0, 2)));
    ok("場面カードは出題にならない（選択肢を作らない）・選択肢にも出ない", build({ entry: UPDOWN[1], scope: UPDOWN, others: [], dir: "en", rand: seeded(1) })?.ok === false
      && UD.every((w) => { const t = texts(build({ entry: w, scope: UPDOWN, others: [], dir: "en", rand: seeded(3) })); return t.length === 2 && !t.some((x) => /同じ席|scene/.test(x)); }));
  }

  // ---- 正規化して重ねない（英語: 大文字小文字・NFKC・空白・ハイフン・アポストロフィ。打つ回の全文入力の判定と同じ形） ----
  {
    const NORM = [e("e-mail", "電子メール"), e("email", "メールを送る"), e("follow up", "追って連絡する"), e("follow-up", "追加の連絡"), e("kpi", "重要業績評価指標", { text: "KPI" }), e("agenda", "議題"), e("invoice", "請求書"), e("don't", "しない"), e("dont", "しないこと")];
    const bad = [];
    for (let s = 1; s <= 30; s++) {
      for (const [q, ban] of [[0, "email"], [1, "e-mail"], [2, "follow-up"], [3, "follow up"], [7, "dont"], [8, "don't"]]) {
        const r = build({ entry: NORM[q], scope: NORM, others: [], dir: "en", rand: seeded(s) });
        const keys = texts(r).map((t) => J.normalizeAnswer(t));
        if (!r?.ok || texts(r).includes(ban) || new Set(keys).size !== keys.length || r.options.length !== 4) bad.push({ q, s, t: texts(r) });
      }
    }
    ok("正規化して重ねない: e-mail の問いに email・follow up の問いに follow-up・don't の問いに dont を違う答えとして出さない（打つ回でも正解になる綴り）・選択肢どうしも重ならない・4 つ", bad.length === 0, JSON.stringify(bad.slice(0, 3)));
    const kpi = build({ entry: NORM[4], scope: NORM, others: [], dir: "en", rand: seeded(5) });
    ok("大文字の語は画面の形で出す（正解の選択肢は KPI。答えの英語は kpi）", right(kpi)[0]?.text === "KPI" && right(kpi)[0]?.en === "kpi", JSON.stringify(kpi));
  }

  // ---- 2 つ目の正解を出さない: 同じ訳のほかの英語・同じ英語の語 ----
  {
    const SAME = [e("cost", "費用"), e("expense", "費用"), e("charge", " 費用 "), e("price", "値段"), e("fee", "料金"), e("tax", "税")];
    const bad = [];
    for (let s = 1; s <= 30; s++) {
      for (const [q, bans] of [[0, ["expense", "charge"]], [1, ["cost", "charge"]], [2, ["cost", "expense"]]]) {
        const r = build({ entry: SAME[q], scope: SAME, others: [], dir: "en", rand: seeded(s) });
        if (!r?.ok || bans.some((b) => texts(r).includes(b)) || right(r).length !== 1 || r.options.length !== 4) bad.push({ q, s, t: texts(r) });
      }
    }
    ok("訳を見て英語を選ぶ: 問いの訳と同じ訳（空白・全角半角を見ない）のほかの英語（費用 → cost・expense・charge）は違う答えに出さない（打つ回でも当たりになる）", bad.length === 0, JSON.stringify(bad.slice(0, 3)));
    const r = build({ entry: UD[1], scope: UPDOWN, others: [], dir: "en", rand: seeded(9) });
    ok("同じ英語の語（up が 3 つ）: up は 1 つだけ出る（重なる英語を 2 度出さない）", texts(r).filter((t) => t === "up").length === 1 && texts(r).length === 2, JSON.stringify(texts(r)));
    const WIDTH = [e("up", "CPCは上がる？"), e("down", "CPCは上がる?"), e("left", "左へ")];
    const w1 = build({ entry: WIDTH[0], scope: WIDTH, others: [], dir: "en", rand: seeded(2) });
    ok("訳の全角半角（？と ?）の違いだけの語は同じ訳: その英語（down）は違う答えに出さない", w1?.ok && !texts(w1).includes("down") && texts(w1).includes("left"), JSON.stringify(texts(w1)));
  }

  // ---- 数: 正解 1 と違う答え 3 つまで（2〜4 個）。並びは決まった乱数 ----
  {
    const TEN = ["apple", "bread", "chair", "door", "egg", "fish", "glass", "hat", "ink", "jam"].map((w, i) => e(w, `訳${i}`));
    const n = (list) => build({ entry: list[0], scope: list, others: [], dir: "en", rand: seeded(4) })?.options?.length ?? 0;
    eq("選択肢の数: 10 語の範囲は 4 つ・3 語は 3 つ・2 語は 2 つ", [n(TEN), n(TEN.slice(0, 3)), n(TEN.slice(0, 2))], [4, 3, 2]);
    const orders = new Set();
    let same = true;
    for (let s = 1; s <= 20; s++) {
      const a = build({ entry: TEN[0], scope: TEN, others: [], dir: "en", rand: seeded(s) });
      const b = build({ entry: TEN[0], scope: TEN, others: [], dir: "en", rand: seeded(s) });
      if (!a?.options || JSON.stringify(a.options) !== JSON.stringify(b?.options)) same = false;
      orders.add(a?.options?.findIndex((o) => o.correct));
    }
    ok("並びは乱数で決まる: 同じ種なら同じ並び・種を替えると正解の位置が替わる（20 通りで 3 か所以上）", same && orders.size >= 3 && !orders.has(-1) && !orders.has(undefined), JSON.stringify([...orders]));
  }

  // ---- 足りないときだけ埋める: 範囲（単語帳）→ ほかの単語帳 → 組み込みの短い一覧（通信なし）→ 作れない ----
  {
    const ONE = [e("memo", "覚え書き", { book: "one" })];
    const OTHERS = [e("invoice", "請求書"), e("agenda", "議題"), e("deadline", "締め切り"), e("budget", "予算")];
    const o = build({ entry: ONE[0], scope: ONE, others: OTHERS, dir: "en", rand: seeded(7) });
    ok("1 語の単語帳: ほかの単語帳の英語で埋める（違う答えは全部ほかの単語帳から・正解は memo だけ）", o?.ok && o.from === "other" && o.options.length >= 2 && right(o).length === 1 && right(o)[0].text === "memo" && o.options.filter((x) => !x.correct).every((x) => OTHERS.some((w) => w.en === x.text)), JSON.stringify(o));
    const b = build({ entry: ONE[0], scope: ONE, others: [], dir: "en", rand: seeded(7) });
    const fill = X.CHOICE_FILL ?? [];
    ok("1 語だけの端末: 組み込みの短い一覧で埋める（js/myWordsChoice.js の定数。通信しない）", b?.ok && b.from === "builtin" && b.options.length >= 2 && right(b).length === 1 && b.options.filter((x) => !x.correct).every((x) => fill.some((f) => f.en === x.text)), JSON.stringify(b));
    const twoUp = [UD[0], UD[1]]; // 同じ英語（up）だけの単語帳: 範囲に違う答えが 1 つも無い
    const tu = build({ entry: twoUp[0], scope: twoUp, others: [], dir: "en", rand: seeded(3) });
    ok("同じ英語の語だけの単語帳（up が 2 つ）: 範囲に違う答えが無いので組み込みで埋める・up は正解の 1 つだけ", tu?.ok && tu.from === "builtin" && texts(tu).filter((t) => t === "up").length === 1, JSON.stringify(texts(tu)));
    const never = build({ entry: UD[0], scope: UPDOWN, others: OTHERS, dir: "en", rand: seeded(3) });
    ok("範囲に違う答えがあれば埋めない（up／down の単語帳はほかの単語帳があっても 2 択のまま）", never?.from === "scope" && JSON.stringify(texts(never).sort()) === '["down","up"]', JSON.stringify(texts(never)));
    const none = build({ entry: ONE[0], scope: ONE, others: [], dir: "en", rand: seeded(3), fill: [] });
    ok("どこからも違う答えが作れないときは作らない（ok: false。画面は短い文と打つ回への道）", none?.ok === false && typeof none?.prompt === "string", JSON.stringify(none));
    const aqua = build({ entry: e("aqua", "水"), scope: [e("aqua", "水")], others: [], dir: "en", rand: seeded(3), fill: [{ en: "water", ja: "水" }, { en: "book", ja: "本" }] });
    ok("組み込みで埋めるときも 2 つ目の正解を出さない（問いの訳と同じ訳の water は出さない）", aqua?.ok && !texts(aqua).includes("water") && texts(aqua).includes("book"), JSON.stringify(texts(aqua)));
    ok("組み込みの一覧: 8 組以上・どれも入れられる英語（小文字）と訳・英語も訳も重ならない", fill.length >= 8 && fill.every((f) => C.checkEnText(f.en).ok && C.checkEnText(f.en).key === f.en && C.checkJaText(f.ja).ok) && new Set(fill.map((f) => f.en)).size === fill.length && new Set(fill.map((f) => f.ja)).size === fill.length, JSON.stringify(fill));
  }

  // ---- 英語を見て訳を選ぶ ----
  {
    const bad = [];
    for (const [i, w] of UD.entries()) {
      for (let s = 1; s <= 8; s++) {
        const r = build({ entry: w, scope: UPDOWN, others: [], dir: "ja", rand: seeded(i * 50 + s) });
        const sameEn = UD.filter((x) => answerKeyOf(x) === answerKeyOf(w));
        const wrongs = (r?.options ?? []).filter((o) => !o.correct);
        if (!(r?.ok && r.prompt === answerKeyOf(w) && right(r).length === 1 && right(r)[0].text === w.ja && r.options.length === 4 && wrongs.every((o) => !sameEn.some((x) => x.ja === o.text) && UD.some((x) => x.ja === o.text && answerKeyOf(x) !== answerKeyOf(w))))) bad.push({ w: w.en, s, r });
      }
    }
    ok("英語を見て訳を選ぶ（up／down の単語帳）: 問いは英語（up）・正解はその語の訳・違う答えはほかの英語（down）の語の訳だけ（同じ英語のほかの訳は出さない）・4 つ", bad.length === 0, JSON.stringify(bad.slice(0, 1)));
    const RISE = [e("up", "上がる"), e("rise", "上がる"), e("down", "下がる"), e("fall", "落ちる")];
    const bad2 = [];
    for (let s = 1; s <= 20; s++) {
      const r = build({ entry: RISE[0], scope: RISE, others: [], dir: "ja", rand: seeded(s) });
      if (!r?.ok || texts(r).filter((t) => t === "上がる").length !== 1 || right(r)[0]?.text !== "上がる" || r.options.length !== 3) bad2.push(texts(r));
    }
    ok("英語を見て訳を選ぶ: 違う英語（rise）の訳でも、問いの英語の訳と同じ訳（上がる）は違う答えに出さない・訳どうしも重ならない", bad2.length === 0, JSON.stringify(bad2.slice(0, 2)));
    // 反証の直し（検査の穴）: 同じ英語のほかの語の訳（up の 2 つ目の訳B）も 2 つ目の正解。違う英語（rise）が同じ訳B を持っていても違う答えに出さない
    const SAMEEN = [e("up", "訳A"), dup("up", "訳B"), e("rise", "訳B"), e("fall", "訳C")];
    const bad3 = [];
    for (let s = 1; s <= 30; s++) {
      const r = build({ entry: SAMEEN[0], scope: SAMEEN, others: [], dir: "ja", rand: seeded(s) });
      if (!r?.ok || texts(r).includes("訳B") || right(r)[0]?.text !== "訳A" || JSON.stringify([...texts(r)].sort()) !== '["訳A","訳C"]') bad3.push(texts(r));
    }
    ok("英語を見て訳を選ぶ: 同じ英語のほかの語の訳（up の 2 つ目の訳B）は、違う英語（rise）がその訳を持っていても違う答えに出さない（30 通りの乱数）", bad3.length === 0, JSON.stringify(bad3.slice(0, 2)));
    const W2 = [e("up", "CPCは上がる？"), e("down", "CPCは 上がる?"), e("left", "左へ")];
    const w2 = build({ entry: W2[0], scope: W2, others: [], dir: "ja", rand: seeded(1) });
    ok("訳の正規化（NFKC・空白・全角半角）: 「CPCは 上がる?」は「CPCは上がる？」と同じ訳なので出さない", w2?.ok && texts(w2).length === 2 && texts(w2).includes("左へ"), JSON.stringify(texts(w2)));
    const k = build({ entry: e("kpi", "重要業績評価指標", { text: "KPI" }), scope: [e("kpi", "重要業績評価指標", { text: "KPI" }), e("agenda", "議題")], others: [], dir: "ja", rand: seeded(1) });
    ok("英語を見て訳を選ぶ: 問いは画面の形の英語（KPI）", k?.prompt === "KPI", JSON.stringify(k));
    const one = build({ entry: e("memo", "覚え書き"), scope: [e("memo", "覚え書き")], others: [e("invoice", "請求書")], dir: "ja", rand: seeded(1) });
    ok("英語を見て訳を選ぶ・1 語の単語帳: ほかの単語帳の訳で埋める", one?.ok && one.from === "other" && JSON.stringify(texts(one).sort()) === JSON.stringify(["覚え書き", "請求書"].sort()), JSON.stringify(one));
  }

  // ---- 150 字の英語と訳（折り返しは画面の CSS。選択肢の字は削らない） ----
  {
    const LONGEN = `${"keep moving ".repeat(12)}keep moving on`.slice(0, 150);
    const L2 = [e(LONGEN, "長い訳".repeat(50)), e(`${"abcdefghij".repeat(15)}`, "とても長い".repeat(30))];
    const a = build({ entry: L2[0], scope: L2, others: [], dir: "en", rand: seeded(1) });
    const b = build({ entry: L2[0], scope: L2, others: [], dir: "ja", rand: seeded(1) });
    ok("150 字の英語・150 字の訳: 選択肢と問いに全部の字が出る", a?.ok && b?.ok && texts(a).includes(LONGEN) && texts(a).some((t) => t.length === 150) && b.prompt === LONGEN && texts(b).includes("長い訳".repeat(50)), JSON.stringify([texts(a).map((t) => t.length), texts(b).map((t) => t.length)]));
  }

  // ---- 数え方は打つ回と同じ（創業者の決定「打つ回と同じに数える」）: 選んだ答えは全文入力の答えとして判定の道を通る ----
  // js/game.js の選ぶ回: 正解・違う答えは submitFreeAnswer(typedAsOf(選んだ選択肢, カード))（正解 → finishFreeWord → completeWord: 打つ回の自力正解と同じ書き手・XP・連続日数・
  // 学んだ日・学習時間）、分からない → revealAnswer()（打つ回の Enter で答えを見るのと同じ）。種類は js/learnQueue.js cleanKindOf・failKindOf がその道で決める（下はその道を同じ順に写したもの）
  {
    const freeCard = (w) => ({ ...C.wordCardOf(w), free: true }); // 選ぶ回のカード（打鍵を 1 字ずつ見ない全文入力の形）
    const choiceKind = (opt, card) => (J.answerMatches(card, typedAs(opt, card) ?? "") ? Q.cleanKindOf(card.en, card) : Q.failKindOf("m"));
    const typedKind = { correct: (card) => Q.cleanKindOf(card.en, card), wrong: () => Q.failKindOf("m"), unknown: () => Q.failKindOf("e") }; // 打つ回: 打ち終えた綴り・1 打ミス・Enter で答えを見る
    const bad = [];
    for (const dir of ["en", "ja"]) {
      for (const [i, w] of UD.entries()) {
        const card = freeCard(w);
        const r = build({ entry: w, scope: UPDOWN, others: [], dir, rand: seeded(i + 11) });
        for (const opt of r?.options ?? []) {
          const matched = J.answerMatches(card, typedAs(opt, card) ?? "");
          const want = opt.correct ? typedKind.correct(C.wordCardOf(w)) : typedKind.wrong();
          if (matched !== opt.correct || choiceKind(opt, card) !== want) bad.push({ dir, w: w.en, opt, matched });
        }
        if (!r?.options?.length) bad.push({ dir, w: w.en, none: true });
      }
    }
    ok("選んだ答えの判定（2 つの向き・6 語の全部の選択肢）: 正解の選択肢だけが打つ回の判定で正解（answerMatches）・種類は打つ回と同じ（正解 = 打ち終えた exact・違う = 1 打ミス miss）", bad.length === 0, JSON.stringify(bad.slice(0, 2)));
    eq("種類の名前: 正解 exact・違う miss・分からない reveal（打つ回の答えを見ると同じ）", [typedKind.correct(C.wordCardOf(UD[0])), typedKind.wrong(), typedKind.unknown()], [ANSWER_KINDS.exact, ANSWER_KINDS.miss, ANSWER_KINDS.reveal]);

    // 書き手は打つ回と同じ js/myWords.js recordMyAnswer（語の鍵で引く）。同じ並びの答えを打つ回と選ぶ回で当てると、保存は 1 字も同じ（別の日に 2 回の決まりも）
    const store = new Map();
    globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => store.delete(k), clear: () => store.clear(), key: (i) => [...store.keys()][i] ?? null, get length() { return store.size; } };
    const M = await import("../js/myWords.js");
    const D0 = new Date(2026, 10, 7, 10, 0).getTime();
    const D1 = new Date(2026, 10, 8, 10, 0).getTime();
    // up: 違う → 正解 → 正解（同じ日）→ 次の日に正解。「→」の行（同じ英語の 2 つ目）: 違う → 次の日に正解 2 回。3 つ目の up: 分からない。down: 正解
    const plan = [[UD[0], "wrong", D0], [UD[0], "correct", D0 + 60000], [UD[0], "correct", D0 + 120000], [UD[1], "wrong", D0 + 180000], [UD[2], "unknown", D0 + 240000], [UD[3], "correct", D0 + 300000], [UD[0], "correct", D1], [UD[1], "correct", D1 + 60000], [UD[1], "correct", D1 + 120000]];
    const run = (how) => {
      store.clear();
      store.set("spelldash_my_words", JSON.stringify(UPDOWN));
      const after = [];
      for (const [w, outcome, at] of plan) {
        let kind;
        if (how === "typed") kind = typedKind[outcome](C.wordCardOf(w));
        else if (outcome === "unknown") kind = Q.failKindOf("e");
        else {
          const card = freeCard(w);
          const r = build({ entry: w, scope: UPDOWN, others: [], dir: "en", rand: seeded(at % 97) });
          const opt = r?.options?.find((o) => o.correct === (outcome === "correct"));
          kind = opt ? choiceKind(opt, card) : null;
        }
        if (!M.recordMyAnswer(w.en, kind, at)) after.push(`not recorded ${w.en}`);
        after.push(JSON.parse(store.get("spelldash_my_words")).map((x) => [x.en, x.ls ?? null, x.lsd ?? null, x.lsAt ?? null]));
      }
      return { final: store.get("spelldash_my_words"), after };
    };
    const typed = run("typed");
    const choice = run("choice");
    ok("打つ回と選ぶ回で同じ並びの答え（違う・正解・正解・別の日に正解・分からない）を当てると、保存は 1 字も同じ（どの答えの後も）", typed.final === choice.final && JSON.stringify(typed.after) === JSON.stringify(choice.after) && !choice.after.some((a) => typeof a === "string"), JSON.stringify({ typed: typed.after.at(-1), choice: choice.after.at(-1) }));
    const fin = Object.fromEntries(JSON.parse(choice.final ?? "[]").map((x) => [x.en, x]));
    ok("別の日に 2 回の決まり（選ぶ回でも同じ）: 違う → あやふや、同じ日の正解 2 回は 1 日目のまま、次の日の正解で覚えた。違うを選んだ同じ英語の語（「→」の行）は、その語だけが あやふや のまま次の日に 1 日目",
      fin.up?.ls === 2 && fin[UD[1].en]?.ls === 1 && Number.isInteger(fin[UD[1].en]?.lsd) && fin[UD[2].en]?.ls === 1 && fin[UD[2].en]?.lsd === undefined && fin.down?.ls === 2 && fin[UD[4].en]?.ls === undefined && fin[UD[5].en]?.ls === undefined,
      JSON.stringify(fin));
    ok("場面カード（鍵 scene）と答えていない語（down の 2 つ目・3 つ目）は 1 字も変えない", JSON.stringify(JSON.parse(choice.final ?? "[]").filter((x) => x.kind === "concept" || x.en === UD[4].en || x.en === UD[5].en)) === JSON.stringify(UPDOWN.filter((x) => x.kind === "concept" || x.en === UD[4].en || x.en === UD[5].en)));
  }

  // ---- 二重に記録しない守り（1 問に 1 回。2 度押し・キーの押しっぱなし・前の問いの押し・開き直したページの古い問い） ----
  {
    const g = guardOf();
    g?.open?.("my-up#1");
    const first = g?.claim?.("my-up#1");
    const second = g?.claim?.("my-up#1");
    ok("守り: 1 問に 1 回だけ受ける（2 度押しの 2 度目は受けない）", first === true && second === false);
    const g2 = guardOf();
    g2?.open?.("a#1");
    const rep = g2?.claim?.("a#1", { repeat: true });
    const after = g2?.claim?.("a#1");
    ok("守り: キーの押しっぱなし（repeat）・2 度目のクリック（detail 2）は答えにしない・その後の普通の押しは受ける", rep === false && after === true);
    g2?.open?.("b#2");
    const stale = g2?.claim?.("a#1");
    const early = g2?.next?.("b#2");
    const pick = g2?.claim?.("b#2");
    const next1 = g2?.next?.("b#2");
    const next2 = g2?.next?.("b#2");
    ok("守り: 次の問いを出した後に前の問いの押しは受けない・「次へ」は答えた後に 1 回だけ", stale === false && early === false && pick === true && next1 === true && next2 === false);
    g2?.close?.();
    ok("守り: 回を終えた後（閉じた）は受けない", g2?.claim?.("b#2") === false && g2?.next?.("b#2") === false);
    const reopened = guardOf();
    ok("開き直したページの守りは、前のページの問いを受けない（開いただけでは記録しない）", reopened?.claim?.("b#2") === false && reopened?.next?.("b#2") === false && typeof reopened?.open === "function");
    // ダブルクリックの 2 度目（click の detail が 2 以上）を受けないのは、画面が変わって（新しい問い・答えの印・向きの切り替え）から CHOICE_CARRY_MS の間だけ。
    // 遅いダブルクリックの設定（OS）や指の連続のタップでも、変わった画面を読んでから同じ所を押す答え・「次へ」は受ける。ふつうの 1 度押しはいつも受ける
    const carry = fn("isCarryClick");
    ok("ダブルクリックの 2 度目は画面が変わってから 0.5 秒の間だけ受けない（遅いダブルクリックの設定でも、読んでから同じ所を押すのは受ける・1 度押しはいつも受ける）",
      X.CHOICE_CARRY_MS === 500 && carry(2, 0) === true && carry(2, 120) === true && carry(3, 499) === true && carry(2, 500) === false && carry(2, 1200) === false && carry(1, 10) === false && carry(0, 10) === false && carry(2, NaN) === false,
      JSON.stringify({ ms: X.CHOICE_CARRY_MS, a: carry(2, 120), b: carry(2, 1200), c: carry(1, 10) }));
  }
}

// ===== Batch 91 T12: 選択式の組の答え（js/myWordsChoice.js sharedAnswersOf・buildChoice の shared。docs/SPEC_MY_WORDS.md §12.2） =====
// 答えが同じ行（場面の問い）と別の語句が混ざった単語帳では、組のもう一方の答えがほとんど選択肢に出ず、答えが選択肢の形から分かった
// （Batch 90 の頭で、訳を見て英語を選ぶ向き 600 問中 534 問・英語を見て訳を選ぶ向き 147 問）。回の始めに 1 回、範囲で 2 語以上にある答えの集まりを作り、
// 問いの答えが集まりにあれば、違う答えをまず集まりのほかの答え（訳を選ぶ向きはその行の訳）から選ぶ。語と訳はここで作る（見本の行は使わない）
{
  const X = await import("../js/myWordsChoice.js");
  const sharedOf = typeof X.sharedAnswersOf === "function" ? X.sharedAnswersOf : () => undefined; // 直す前の木には無い（渡さないのと同じ）
  const { createHash } = await import("crypto");
  const at = "2026-11-11T00:00:00.000Z";
  const sceneJa = (side, i) => `試しの場面 ${side}の${i}。数は上か下か`;
  const sceneWord = (answer, side, i) => (i === 1 ? { en: answer, ja: sceneJa(side, i), addedAt: at } : { en: `${answer}~${C.jaHash(sceneJa(side, i))}`, ja: sceneJa(side, i), text: answer, addedAt: at });
  const MIX = [];
  for (let i = 1; i <= 15; i++) MIX.push(sceneWord("rise", "上", i));
  for (let i = 1; i <= 15; i++) MIX.push(sceneWord("fall", "下", i));
  for (let i = 1; i <= 25; i++) MIX.push({ en: `phrase number ${String.fromCharCode(96 + ((i - 1) % 26) + 1)}${i}`, ja: `ふつうの語句 ${i}`, addedAt: at });
  const SCENE = MIX.filter((w) => /上か下か$/.test(w.ja));
  const partnerOf = (w) => (C.answerKeyOf(w) === "rise" ? "fall" : "rise");
  const shared = sharedOf(MIX);
  ok("T12 sharedAnswersOf: 範囲で 2 語以上にある答え（rise・fall）の集まり。1 語だけの答え・場面カードは入れない",
    shared instanceof Set && shared.size === 2 && shared.has("rise") && shared.has("fall") && sharedOf([...MIX, { kind: "concept", en: "scene", answer: "x", q: "q", ja: "" }, { kind: "concept", en: "scene", answer: "x", q: "q2", ja: "" }])?.size === 2,
    JSON.stringify(shared instanceof Set ? [...shared] : shared));
  ok("T12 sharedAnswersOf: 答えは打つ回の判定と同じ形で比べる（follow-up と follow up は同じ答え）",
    sharedOf([{ en: "follow-up", ja: "追加の連絡" }, { en: "follow up", ja: "追って連絡する" }, { en: "agenda", ja: "議題" }])?.has?.(X.enKey("follow up")) === true, "");
  // 600 問 × 2 つの向き（決まった乱数。1 つの乱数を 2 つの向きで続けて使う）
  const rand = X.seededRandom(7);
  const miss = { en: 0, ja: 0 };
  const seen = { en: 0, ja: 0 };
  for (const dir of ["en", "ja"]) {
    for (let rep = 0; rep < 20; rep++) {
      for (const w of SCENE) {
        const r = X.buildChoice({ entry: w, scope: MIX, others: [], dir, rand, shared });
        seen[dir]++;
        if (dir === "en") {
          if (!(r?.options ?? []).some((o) => o.en === partnerOf(w))) miss.en++;
        } else if (!(r?.options ?? []).some((o) => !o.correct && SCENE.some((x) => C.answerKeyOf(x) === partnerOf(w) && x.ja === o.text))) miss.ja++;
      }
    }
  }
  ok(`T12 訳を見て英語を選ぶ（答えが同じ行 15 と 15・ほかの語句 25 の単語帳・600 問）: 組のもう一方の答えがいつも選択肢にある（無かった問い ${miss.en}）`, seen.en === 600 && miss.en === 0, JSON.stringify({ seen: seen.en, miss: miss.en }));
  ok(`T12 英語を見て訳を選ぶ（同じ単語帳・600 問）: 違う答えの少なくとも 1 つは組のもう一方の行の訳（無かった問い ${miss.ja}）`, seen.ja === 600 && miss.ja === 0, JSON.stringify({ seen: seen.ja, miss: miss.ja }));
  // 守り（直す前の木でも通る）: 集まりの無い単語帳は同じ乱数で今と同じ選択肢と並び（2,000 問。直す前の木の出力の指紋と、集まりを渡した出力の両方）
  const PLAIN = Array.from({ length: 40 }, (_, i) => ({ en: `phrase ${String.fromCharCode(97 + (i % 26))}${i}`, ja: `ふつうの語句 ${i}`, addedAt: at }));
  const outs = { none: [], with: [] };
  for (const dir of ["en", "ja"]) {
    const ra = X.seededRandom(11);
    const rb = X.seededRandom(11);
    const s = sharedOf(PLAIN);
    for (let rep = 0; rep < 25; rep++) {
      for (const w of PLAIN) {
        outs.none.push(X.buildChoice({ entry: w, scope: PLAIN, dir, rand: ra }));
        outs.with.push(X.buildChoice({ entry: w, scope: PLAIN, dir, rand: rb, shared: s }));
      }
    }
  }
  const digest = createHash("sha256").update(JSON.stringify(outs.none)).digest("hex");
  ok("T12 守り: 集まりの無い単語帳（2,000 問）は、集まりを渡しても渡さなくても同じ選択肢と並び・直す前の木（Batch 90 の頭）の出力と 1 字も同じ",
    outs.none.length === 2000 && JSON.stringify(outs.none) === JSON.stringify(outs.with) && digest === "74ba892e4c73fcfe381465126c2136891e1960627c52bc8e3440b5a22fe4a4cf" && (sharedOf(PLAIN) === undefined || sharedOf(PLAIN).size === 0),
    digest);
  // 守り（直す前の木でも通る）: 答えが 2 つだけの単語帳（場面の問いだけ）は 600 問とも 2 択
  const onlyShared = sharedOf(SCENE);
  const r2 = X.seededRandom(7);
  let two = 0;
  for (let rep = 0; rep < 20; rep++) for (const w of SCENE) if (X.buildChoice({ entry: w, scope: SCENE, others: [], dir: "en", rand: r2, shared: onlyShared })?.options?.length === 2) two++;
  ok("T12 守り: 答えが 2 つだけの単語帳は 600 問とも 2 択", two === 600, String(two));
}

// ===== Batch 91 T1〜T11・T10b: マイ単語帳の「初めて 覚えた になった日」lf（docs/SPEC_MY_WORDS.md §17） =====
// 書き手は js/myWordsCore.js applyMyAnswer だけ（公開の語の lsf と同じ決まり: js/learnState.js firstLearnedMark の返りを語に写す。新しい呼び出し・読み書き・輪は無い）。
// 読み手（純）: myFirstLearnedDay・countMyGain・myGainByDay・myStudiedSince。取り込み: js/userItemsSync.js keepFirstLearned と mergeCloudItems の 2 つの向き。
// 端末の偽物（localStorage・時計）はこの節の中だけ（終わりで本物の時計に戻す）。語と訳はここで作る
{
  const U = await import("../js/userItemsSync.js");
  const M = await import("../js/myWords.js");
  const SL = await import("../js/slang.js");
  const fs = await import("fs");
  const missing = (name) => () => `${name} が無い`; // 直す前の木には無い: 呼ぶと字を返して検査が落ちる
  const coreFn = (name) => (typeof C[name] === "function" ? C[name] : missing(name));
  const countMyGain = coreFn("countMyGain");
  const myGainByDay = coreFn("myGainByDay");
  const myStudiedSince = coreFn("myStudiedSince");
  const myFirstLearnedDay = coreFn("myFirstLearnedDay");
  const keep = typeof U.keepFirstLearned === "function" ? U.keepFirstLearned : missing("keepFirstLearned");
  const RealDate = Date;
  const HOUR = 3600000;
  const DAY = 24 * HOUR;
  const D0 = new RealDate(2026, 10, 12, 9, 0).getTime(); // 1 日目の 9 時（端末の時刻）
  let NOW = D0;
  globalThis.Date = class extends RealDate {
    constructor(...a) {
      super(...(a.length ? a : [NOW]));
    }
    static now() {
      return NOW;
    }
  };
  const at = (n, h = 9) => (NOW = D0 + (n - 1) * DAY + (h - 9) * HOUR);
  const dayNo = (n) => learnDayOf(D0 + (n - 1) * DAY);
  class Store {
    constructor() {
      this.map = new Map();
      this.sets = 0;
    }
    getItem(k) {
      return this.map.has(k) ? this.map.get(k) : null;
    }
    setItem(k, v) {
      this.sets++;
      this.map.set(k, String(v));
    }
    removeItem(k) {
      this.map.delete(k);
    }
    clear() {
      this.map.clear();
    }
    key(i) {
      return [...this.map.keys()][i] ?? null;
    }
    get length() {
      return this.map.size;
    }
  }
  const devices = {};
  const use = (name) => (globalThis.localStorage = devices[name] ??= new Store());
  const wordsOf = () => JSON.parse(localStorage.getItem("spelldash_my_words") || "[]");
  const wordOf = (en) => wordsOf().find((w) => w.en === en);
  try {
    // ---- T1〜T4: 書き手（applyMyAnswer） ----
    const T = D0;
    const d1 = dayNo(1);
    const a = C.applyMyAnswer({ en: "x", ja: "y" }, ANSWER_KINDS.exact, T);
    ok("T1 これから + 自力正解 → lf は今日の日番号", a.lf === d1 && C.myStateOf(a) === LEARN_LEARNED, JSON.stringify(a));
    const b = C.applyMyAnswer({ en: "x", ja: "y", ls: 2, lsAt: T - 3 * DAY }, ANSWER_KINDS.miss, T);
    const b2 = C.applyMyAnswer(C.applyMyAnswer(b, ANSWER_KINDS.exact, T + DAY), ANSWER_KINDS.exact, T + 2 * DAY);
    const b3 = C.applyMyAnswer({ en: "x", ja: "y", ls: 2, lsAt: T - 3 * DAY }, ANSWER_KINDS.exact, T);
    ok("T2 lf の無い 覚えた の語に答える → lf 0（前から 覚えた。数えない）・外して覚え直しても 0 のまま",
      b.lf === 0 && b3.lf === 0 && b2.lf === 0 && C.myStateOf(b2) === LEARN_LEARNED, JSON.stringify({ b: b.lf, b2: b2.lf, b3: b3.lf, ls: b2.ls }));
    const c1 = C.applyMyAnswer({ en: "x", ja: "y" }, ANSWER_KINDS.miss, T);
    const c2 = C.applyMyAnswer(c1, ANSWER_KINDS.exact, T + HOUR);
    const c3 = C.applyMyAnswer(c2, ANSWER_KINDS.exact, T + DAY);
    const c4 = C.applyMyAnswer(C.applyMyAnswer(c3, ANSWER_KINDS.reveal, T + 3 * DAY), ANSWER_KINDS.exact, T + 4 * DAY);
    const c5 = C.applyMyAnswer(c4, ANSWER_KINDS.exact, T + 5 * DAY);
    ok("T3 これから → ×（あやふや）→ 同じ日の正解（lf なし）→ 次の日の正解で 覚えた（lf は次の日）→ 外して覚え直しても次の日のまま（一度付けたら替えない）",
      !("lf" in c1) && !("lf" in c2) && c3.lf === dayNo(2) && C.myStateOf(c3) === LEARN_LEARNED && c4.lf === dayNo(2) && c5.lf === dayNo(2) && C.myStateOf(c5) === LEARN_LEARNED,
      JSON.stringify([c1.lf, c2.lf, c3.lf, c4.lf, c5.lf, c5.ls]));
    const e = C.applyMyAnswer({ en: "x~1234abcd", ja: "y", text: "X", book: "b1", bookName: "仕事", addedAt: "2026-11-01T00:00:00.000Z", zz: 1 }, ANSWER_KINDS.exact, T);
    ok("T4（守り）ほかの欄（en・ja・text・book・bookName・addedAt・知らない欄）はそのまま", e.en === "x~1234abcd" && e.ja === "y" && e.text === "X" && e.book === "b1" && e.bookName === "仕事" && e.addedAt === "2026-11-01T00:00:00.000Z" && e.zz === 1, JSON.stringify(e));
    const odd = [C.applyMyAnswer({ en: "x", ja: "y", lf: "3" }, ANSWER_KINDS.exact, T), C.applyMyAnswer({ en: "x", ja: "y", lf: dayNo(-5) }, ANSWER_KINDS.exact, T)];
    ok("T4 lf がある語は、字の lf でも前の日の lf でも書き換えない（一度付けたら替えない）", odd[0].lf === "3" && odd[1].lf === dayNo(-5), JSON.stringify(odd.map((w) => w.lf)));

    // ---- T5: countMyGain（窓の中で初めて 覚えた になり、今も 覚えた の語。英語の語だけ） ----
    const list = [
      { en: "a", ja: "1", ls: 2, lf: d1 }, { en: "b", ja: "2", ls: 2, lf: d1 - 6 }, { en: "c", ja: "3", ls: 2, lf: d1 - 7 },
      { en: "d", ja: "4", ls: 2, lf: 0 }, { en: "e", ja: "5", ls: 1, lf: d1 }, { en: "f", ja: "6", ls: 2 }, { en: "g", ja: "7", ls: 2, lf: "x" },
      { kind: "concept", en: "h", q: "q", answer: "h", ja: "", ls: 2, lf: d1 }
    ];
    ok("T5 countMyGain（窓 6 日前〜今日）= 2: lf 0・窓の外・あやふや に戻った語・lf の無い語・字の lf・場面カードは数えない", countMyGain(list, d1 - 6, d1) === 2, String(countMyGain(list, d1 - 6, d1)));
    ok("T5 myFirstLearnedDay: 1 以上の整数の lf だけ（0・無い・字・場面カードは null）",
      myFirstLearnedDay(list[0]) === d1 && myFirstLearnedDay(list[3]) === null && myFirstLearnedDay(list[5]) === null && myFirstLearnedDay(list[6]) === null, "");

    // ---- T6: keepFirstLearned（取り込みで端末の早い lf を残す。純） ----
    const base = { en: "a", ja: "1", addedAt: "2026-11-01T00:00:00.000Z" };
    const same = (x) => x;
    const k1 = keep({ ...base, ls: 1 }, { ...base, lf: d1 });
    const k2 = keep({ ...base, lf: d1 + 1 }, { ...base, lf: d1 });
    const inc3 = { ...base, lf: d1 };
    const k3 = keep(inc3, { ...base, lf: d1 + 1 });
    const k4 = keep({ ...base, lf: d1 }, { ...base, lf: 0 });
    const inc5 = { ...base, ls: 2 };
    const k5 = keep(inc5, { ...base, addedAt: "2026-11-05T00:00:00.000Z", lf: d1 });
    const inc6 = { ...base, ls: 2 };
    const k6 = keep(inc6, { ...base, lf: "x" });
    const inc7 = { ...base, lf: 0 };
    const k7 = keep(inc7, { ...base, lf: 0 });
    ok("T6 keepFirstLearned: 勝った行に lf が無い・遅い → 端末の lf を写す・行が早い（同じ）→ 行のまま（同じ物）・0 はどの日より早い・足し直した語（addedAt が違う）と字の lf には写さない",
      k1?.lf === d1 && k1?.ls === 1 && k2?.lf === d1 && same(k3) === inc3 && k4?.lf === 0 && same(k5) === inc5 && same(k6) === inc6 && same(k7) === inc7,
      JSON.stringify({ k1, k2: k2?.lf, k3: k3 === inc3, k4: k4?.lf, k5: k5 === inc5, k6: k6 === inc6, k7: k7 === inc7 }));

    // ---- T7: mergeCloudItems（本物）: 雲の後の行（lf なし）に負けても端末の lf が残り、送り返す行に入る。もう一度取り込むと送り返さない ----
    use("T7");
    localStorage.setItem("spelldash_my_words", JSON.stringify([{ ...base, ls: 2, lf: d1, lsAt: T }]));
    localStorage.setItem("spelldash_user_items_meta", JSON.stringify({ "my_word:a": { updatedAt: new RealDate(T).toISOString(), deleted: false } }));
    at(1, 12);
    const cloudRow = { kind: "my_word", key: "a", payload: { ...base, ls: 1, lsd: d1, lsAt: T + 2 * HOUR }, deleted: false, updated_at: new RealDate(T + 2 * HOUR).toISOString() };
    const r7 = U.mergeCloudItems([cloudRow], "u1");
    const after7 = wordOf("a");
    const up7 = r7.toUpload.find((r) => r.kind === "my_word" && r.key === "a");
    const again7 = up7 ? U.mergeCloudItems([{ ...up7, payload: JSON.parse(JSON.stringify(up7.payload)) }], "u1") : { toUpload: ["送る行が無い"] };
    ok("T7 取り込み（雲の行が新しくて勝つ）: 語の状態は雲の行（あやふや）・lf は端末の早い日のまま・その行を送り返す（lf 入り）・もう一度取り込むと送り返さない（収まる）",
      after7?.ls === 1 && after7?.lf === d1 && up7?.payload?.lf === d1 && up7?.payload?.ls === 1 && again7.toUpload.filter((r) => r.kind === "my_word").length === 0,
      JSON.stringify({ after7, up: up7?.payload ?? null, again: again7.toUpload }));

    // ---- T8: 答えの書き手 recordMyAnswer（本物）は lf を付け、保存は今と同じ回数（語 1 回・印 2 回）。答えの道は新しい読み手を呼ばない ----
    use("T8");
    localStorage.setItem("spelldash_my_words", JSON.stringify([{ ...base }]));
    at(1, 10);
    localStorage.sets = 0;
    const rec8 = M.recordMyAnswer("a", ANSWER_KINDS.exact);
    const sets8 = localStorage.sets;
    ok("T8 recordMyAnswer: lf が付き（今日）、setItem は今と同じ 3 回（語 1 回・送る印 2 回）", rec8 === true && wordOf("a")?.lf === d1 && sets8 === 3, JSON.stringify({ rec8, lf: wordOf("a")?.lf, sets8 }));
    const bodyOf = (src, name) => {
      const m = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
      if (!m) return null;
      let depth = 0;
      let j = m.index + m[0].length - 1;
      for (; j < src.length; j++) {
        if (src[j] === "(") depth++;
        else if (src[j] === ")" && --depth === 0) break;
      }
      const open = src.indexOf("{", j);
      depth = 0;
      for (let k = open; k < src.length; k++) {
        if (src[k] === "{") depth++;
        else if (src[k] === "}" && --depth === 0) return src.slice(open, k + 1);
      }
      return null;
    };
    const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
    const NEW_READERS = /countMyGain|myGainByDay|myStudiedSince|keepFirstLearned|myFirstLearnedDay|sharedAnswersOf/;
    const watched = [
      ["js/game.js", "completeWord"], ["js/game.js", "acceptChar"], ["js/game.js", "advanceNow"], ["js/game.js", "applyLearnXp"],
      ["js/myWords.js", "recordMyAnswer"], ["js/myWordsCore.js", "applyMyAnswer"]
    ].map(([file, name]) => ({ file, name, body: bodyOf(read(file), name) }));
    ok("T8 答えの道（js/game.js completeWord・acceptChar・advanceNow・applyLearnXp・recordMyAnswer・applyMyAnswer）の本文に新しい読み手・取り込み・組の集まりの呼び出しが無い",
      watched.every((w) => w.body !== null && !NEW_READERS.test(w.body)), JSON.stringify(watched.map((w) => [w.name, w.body === null ? "関数が無い" : NEW_READERS.exec(w.body)?.[0] ?? "ok"])));
    const calls = [...(watched.find((w) => w.name === "applyMyAnswer")?.body ?? "").matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]).filter((n) => !["if", "for", "while", "switch", "return", "function"].includes(n));
    ok("T8 applyMyAnswer が呼ぶ関数は今と同じ applyLearnAnswer だけ（新しい関数の呼び出し・輪が無い）", JSON.stringify([...new Set(calls)]) === '["applyLearnAnswer"]' && !/\bfor\b|\bwhile\b|\.forEach\(|\.map\(|\.filter\(/.test(watched.find((w) => w.name === "applyMyAnswer")?.body ?? ""), JSON.stringify(calls));

    // ---- T9（反証 R1 の形）: 回の途中で閉じた日に 覚えた になった語に、次の日にもう一度正解 → lf は最初の日。その 2 日の間から始まる窓では数えない ----
    use("T9");
    localStorage.setItem("spelldash_my_words", JSON.stringify([{ en: "r1", ja: "試しの訳 一", addedAt: "2026-11-01T00:00:00.000Z" }, { en: "r2", ja: "試しの訳 二", addedAt: "2026-11-01T00:00:00.000Z" }]));
    at(2, 21);
    M.recordMyAnswer("r1", ANSWER_KINDS.exact); // 2 日目: 回の途中で閉じた（回の終わりの書き手は走らない）
    at(3, 20);
    M.recordMyAnswer("r1", ANSWER_KINDS.exact); // 3 日目: もう一度正解
    const w9 = wordsOf();
    ok("T9 回の途中で閉じた日に 覚えた になった語に次の日にもう一度正解 → lf は 2 日目のまま・窓 3〜9 日目は +0・窓 2〜8 日目は +1",
      wordOf("r1")?.lf === dayNo(2) && countMyGain(w9, dayNo(3), dayNo(9)) === 0 && countMyGain(w9, dayNo(2), dayNo(8)) === 1,
      JSON.stringify({ lf: wordOf("r1")?.lf, d2: dayNo(2), w39: countMyGain(w9, dayNo(3), dayNo(9)), w28: countMyGain(w9, dayNo(2), dayNo(8)) }));

    // ---- T10（反証 R2 の形。本物の buildDirtyRows・mergeCloudItems）: B が 2 日目に覚え、3 日目にもう一度正解して送る → A の lf は 2 日目 ----
    const cloud = new Map();
    const upsert = (r) => cloud.set(`${r.kind}:${r.key}`, JSON.parse(JSON.stringify(r))); // 送り方は比べない上書き（upsertRows）
    const push = () => {
      for (const r of U.buildDirtyRows("u1")) upsert(r);
      U.clearDirtyItems();
    };
    const pull = () => {
      const res = U.mergeCloudItems([...cloud.values()], "u1");
      for (const r of res.toUpload) upsert(r);
      return res;
    };
    use("A10");
    at(1, 8);
    M.addMyWordsBulk("shared phrase, 試しの訳 共有\nside phrase, 試しの訳 横");
    push();
    use("B10");
    at(1, 9);
    pull();
    push();
    at(2, 21);
    M.recordMyAnswer("shared phrase", ANSWER_KINDS.exact);
    at(3, 8);
    M.recordMyAnswer("shared phrase", ANSWER_KINDS.exact); // 送る前にもう一度正解
    push();
    use("A10");
    at(3, 9);
    pull();
    ok("T10 B が 2 日目に覚えて 3 日目にもう一度正解してから送る → A の語の lf は 2 日目・A の窓 3〜9 日目は +0",
      wordOf("shared phrase")?.lf === dayNo(2) && countMyGain(wordsOf(), dayNo(3), dayNo(9)) === 0, JSON.stringify({ lf: wordOf("shared phrase")?.lf, d2: dayNo(2) }));

    // ---- T10b（反証 X1 の形）: A が 2 日目に覚えて送る。B はつながらないまま 4 日目に同じ語を初めて覚える。5 日目に B が取り込む（B の行が新しくて勝つ）
    //      → B の語の lf と送る行の lf は 2 日目。もう一度取り込んでも送り返さない。ほかの端末 C も窓 3〜9 日目は +0 ----
    cloud.clear();
    use("A11");
    at(1, 7);
    M.addMyWordsBulk("target word, 試しの訳 対象\nother word, 試しの訳 ほか\nthird word, 試しの訳 三");
    push();
    use("B11");
    at(1, 8);
    pull();
    push();
    use("A11");
    at(2, 8);
    M.recordMyAnswer("target word", ANSWER_KINDS.exact);
    M.recordMyAnswer("other word", ANSWER_KINDS.miss);
    push();
    const cloudLf2 = cloud.get("my_word:target word")?.payload?.lf;
    use("B11");
    at(4, 20);
    M.recordMyAnswer("target word", ANSWER_KINDS.exact); // つながらない（送れない）
    M.recordMyAnswer("third word", ANSWER_KINDS.miss);
    const bBefore = wordOf("target word")?.lf;
    at(5, 8);
    const r11 = pull();
    const sent11 = r11.toUpload.find((r) => r.kind === "my_word" && r.key === "target word");
    push();
    const bAfter = wordOf("target word")?.lf;
    const cloudAfter = cloud.get("my_word:target word")?.payload?.lf;
    const r11b = pull();
    use("C11");
    at(5, 9);
    pull();
    const cLf = wordOf("target word")?.lf;
    at(9, 22);
    const cGain = countMyGain(wordsOf(), dayNo(3), dayNo(9));
    use("B11");
    const bGain = countMyGain(wordsOf(), dayNo(3), dayNo(9));
    ok("T10b 端末の行が新しくて勝つ取り込み: 雲の早い lf（2 日目）を端末の語に写して送る（B の lf・送る行・雲の lf は 2 日目）・もう一度取り込んでも送り返さない・B と新しい端末 C の窓 3〜9 日目は +0（真実と同じ）",
      cloudLf2 === dayNo(2) && bBefore === dayNo(4) && bAfter === dayNo(2) && sent11?.payload?.lf === dayNo(2) && cloudAfter === dayNo(2) && r11b.toUpload.filter((r) => r.kind === "my_word").length === 0 && cLf === dayNo(2) && cGain === 0 && bGain === 0,
      JSON.stringify({ d2: dayNo(2), d4: dayNo(4), cloudLf2, bBefore, bAfter, sent: sent11?.payload?.lf ?? null, cloudAfter, resend: r11b.toUpload.map((r) => r.key), cLf, cGain, bGain }));

    // ---- T10c（反証の形。本物の pullUserItems・buildDirtyRows と偽の送り先）: 勝った雲の行に端末の早い lf を残して送り返す行は、その雲の行の時刻 + 1 ms で送る。
    //      今の時刻で送ると、雲の行より後にほかの端末がした、まだ送っていない変更（訳の直し・消す・答え）が、その端末の次の取り込みで負けて消える。
    //      A が 2 日目に覚えて送る → 取り込んでいない B が外して送る（行に lf が無い）→ つながらない C が変える → A が取り込む（B の行が勝ち、lf を残して送り返す）
    //      → C がつながって取り込み、送る → A・B が取り込む。C の変更が 3 台と雲に残る。訳を直した語の lf は 2 日目のまま ----
    {
      const sky = new Map();
      const put = (r) => sky.set(`${r.kind}:${r.key}`, JSON.parse(JSON.stringify(r))); // 送り方は比べない上書き（upsertRows）
      const client = {
        from() {
          const q = {
            select: () => q,
            order: () => q,
            range: (a, b) => {
              const all = [...sky.values()].map((r) => JSON.parse(JSON.stringify(r)));
              return Promise.resolve({ data: all.slice(a, b + 1), count: all.length, error: null, status: 200 });
            },
            upsert: (rows) => {
              rows.forEach(put);
              return Promise.resolve({ error: null, status: 201 });
            }
          };
          return q;
        }
      };
      const pullOn = (name) => {
        use(name);
        return U.pullUserItems(client, "u1", { now: NOW });
      };
      const pushOn = (name) => {
        use(name);
        U.buildDirtyRows("u1").forEach(put);
        U.clearDirtyItems();
      };
      const KEY = "deal word";
      const MIN = 60000;
      const runCase = async (tag, change) => {
        sky.clear();
        const [A, B, C] = ["A", "B", "C"].map((n) => `${n}12${tag}`);
        at(1, 9);
        use(A);
        M.addMyWord(KEY, "試しの訳 取引");
        pushOn(A);
        NOW += MIN;
        await pullOn(B);
        await pullOn(C);
        at(2, 9);
        use(A);
        M.recordMyAnswer(KEY, ANSWER_KINDS.exact); // A: 2 日目に初めて覚えた（lf は 2 日目）
        pushOn(A);
        NOW += 10 * MIN; // 9:10: B（取り込んでいないタブ）が外して送る（行に lf が無い）
        use(B);
        M.recordMyAnswer(KEY, ANSWER_KINDS.miss);
        pushOn(B);
        const bAt = sky.get(`my_word:${KEY}`)?.updated_at;
        NOW += 10 * MIN; // 9:20: C はつながらないまま変える（まだ送らない）
        use(C);
        change();
        const cAt = NOW;
        NOW += 10 * MIN; // 9:30: A が取り込む（B の行が勝つ・A の lf を残して送り返す）
        await pullOn(A);
        const back = sky.get(`my_word:${KEY}`);
        NOW += 10 * MIN; // 9:40: C がつながって取り込み、送る
        await pullOn(C);
        pushOn(C);
        NOW += 10 * MIN; // 9:50: A・B が取り込む
        await pullOn(A);
        await pullOn(B);
        const words = {};
        for (const n of [A, B, C]) {
          use(n);
          words[n.slice(0, 1)] = wordOf(KEY) ?? null;
        }
        return { bAt, cAt, back: { at: back?.updated_at ?? null, lf: back?.payload?.lf ?? null }, row: sky.get(`my_word:${KEY}`) ?? null, words };
      };
      const plusOne = (iso) => new RealDate(RealDate.parse(iso) + 1).toISOString();
      const ja = await runCase("j", () => M.setMyWordJa(KEY, "試しの訳 取引・契約"));
      ok("T10c 送り返す行（A が lf を残した B の行）の時刻は、勝った雲の行の時刻 + 1 ms（今の時刻でない）・lf は 2 日目",
        ja.back.at === plusOne(ja.bAt) && ja.back.lf === dayNo(2), JSON.stringify({ bAt: ja.bAt, back: ja.back, want: plusOne(ja.bAt) }));
      const jaOf = (w) => w?.ja ?? null;
      ok("T10c まだ送っていない C の訳の直しは、A の送り返しに負けない: 雲と 3 台の訳は直した訳・lf は 2 日目のまま",
        ja.row?.payload?.ja === "試しの訳 取引・契約" && ja.row?.payload?.lf === dayNo(2) && ["A", "B", "C"].every((n) => jaOf(ja.words[n]) === "試しの訳 取引・契約" && ja.words[n]?.lf === dayNo(2)),
        JSON.stringify({ row: ja.row?.payload ?? null, ja: Object.fromEntries(Object.entries(ja.words).map(([n, w]) => [n, [jaOf(w), w?.lf ?? null]])) }));
      const del = await runCase("d", () => M.removeMyWord(KEY, "word"));
      ok("T10c まだ送っていない C の消す（墓標）は、A の送り返しに負けない: 雲は消した印・3 台とも語が無い（戻ってこない）",
        del.row?.deleted === true && ["A", "B", "C"].every((n) => del.words[n] === null),
        JSON.stringify({ deleted: del.row?.deleted ?? null, at: del.row?.updated_at ?? null, words: Object.fromEntries(Object.entries(del.words).map(([n, w]) => [n, w ? jaOf(w) : null])) }));
      const ans = await runCase("a", () => M.recordMyAnswer(KEY, ANSWER_KINDS.exact));
      const lsOf = (w) => (w ? [w.ls ?? null, w.lsAt ?? null] : null);
      ok("T10c まだ送っていない C の答え（9:20 の正解で 覚えた）は、A の送り返しに負けない: 雲と 3 台の 3 状態は C の答え",
        JSON.stringify(lsOf(ans.row?.payload)) === JSON.stringify([2, ans.cAt]) && ["A", "B", "C"].every((n) => JSON.stringify(lsOf(ans.words[n])) === JSON.stringify([2, ans.cAt])),
        JSON.stringify({ want: [2, ans.cAt], row: lsOf(ans.row?.payload), words: Object.fromEntries(Object.entries(ans.words).map(([n, w]) => [n, lsOf(w)])) }));
    }

    // ---- T11: myGainByDay の窓の日の和 = countMyGain・myStudiedSince は窓の始めより前の答えだけなら偽 ----
    const days11 = [0, 1, 2, 2, 5, 6, 8, 9].map((k) => dayNo(1) + k);
    const list11 = days11.map((d, i) => ({ en: `w${i}`, ja: `訳 ${i}`, ls: i === 3 ? 1 : 2, lf: d, lsAt: D0 + (d - dayNo(1)) * DAY }));
    const byDay = myGainByDay(list11);
    const sum = byDay instanceof Map ? [...byDay].filter(([d]) => d >= dayNo(3) && d <= dayNo(9)).reduce((s, [, n]) => s + n, 0) : byDay;
    ok("T11 myGainByDay の窓 3〜9 日目の日の和 = countMyGain（あやふや に戻った語は数えない）", byDay instanceof Map && sum === countMyGain(list11, dayNo(3), dayNo(9)) && sum === 4, JSON.stringify({ sum, count: countMyGain(list11, dayNo(3), dayNo(9)) }));
    const before = [{ en: "p", ja: "訳", ls: 2, lf: 0, lsAt: D0 }];
    ok("T11 myStudiedSince: 窓の始めより前の答えだけなら偽・窓の中に答えがあれば真（ほかの端末から届いた語の lsAt も）",
      myStudiedSince(before, D0 + DAY) === false && myStudiedSince(before, D0 - DAY) === true && myStudiedSince([], D0) === false && myStudiedSince([{ kind: "concept", en: "s", q: "q", answer: "s", ja: "", lsAt: D0 + 2 * DAY }], D0) === false,
      JSON.stringify([myStudiedSince(before, D0 + DAY), myStudiedSince(before, D0 - DAY)]));

    // ---- 守り: スラング（js/slang.js）は ls・lsAt・lsd だけを写すので保存の形は変わらない ----
    const slangStore = new Store();
    const firstSlang = SL.SLANG[0]?.id;
    SL.recordSlangAnswer(firstSlang, ANSWER_KINDS.exact, D0, slangStore);
    const slangRec = JSON.parse(slangStore.getItem(SL.SLANG_KEY) || "{}")[firstSlang] ?? {};
    ok("守り（スラング）: 答えの記録は ls・lsAt だけ（lf を持たない）", JSON.stringify(Object.keys(slangRec).sort()) === '["ls","lsAt"]', JSON.stringify(slangRec));

    // ---- 大きさ: いちばん大きい語の payload（表の上限 4,096 バイト。docs/SQL_USER_ITEMS.md §4 の数え方: 鍵は短い順 → 字の順、": " と ", "） ----
    const jsonbText = (o) => "{" + Object.keys(o).sort((x, y) => x.length - y.length || (x < y ? -1 : x > y ? 1 : 0)).map((k) => JSON.stringify(k) + ": " + JSON.stringify(o[k])).join(", ") + "}";
    const bytes = (o) => Buffer.byteLength(jsonbText(o), "utf8");
    const bigJa = "訳".repeat(150);
    const big = { en: `${"a".repeat(150)}~${C.jaHash(bigJa, 32)}`, ja: bigJa, text: "A".repeat(150), book: "b".repeat(24), bookName: "単".repeat(20), addedAt: "2026-11-11T00:00:00.000Z" };
    const bigAnswered = C.applyMyAnswer(C.applyMyAnswer(big, ANSWER_KINDS.miss, D0), ANSWER_KINDS.exact, D0 + DAY);
    const bigLearned = C.applyMyAnswer(bigAnswered, ANSWER_KINDS.exact, D0 + 2 * DAY);
    const noLf = { ...bigLearned };
    delete noLf.lf;
    ok(`大きさ: いちばん大きい語の payload は ${bytes(bigLearned)} バイト（lf で +${bytes(bigLearned) - bytes(noLf)}）・上限 4,096 以下`, bytes(bigLearned) <= 4096 && (bigLearned.lf === undefined || bytes(bigLearned) - bytes(noLf) <= 13), JSON.stringify({ with: bytes(bigLearned), without: bytes(noLf) }));
  } finally {
    globalThis.Date = RealDate;
  }
}

// ===== Batch 94 T14〜T17: 2 台の取り込み（docs/SPEC_MY_WORDS.md §18。js/userItemsSync.js mergeCloudItems・js/myWordsCore.js myIdentityFor・js/myWords.js の足す道） =====
// 試しの端末（偽の時計・端末ごとの保存）と、雲（user_items の表のつもりの Map）。取り込み（pullUserItems）と送り（pushUserItems）は本物で、雲の読み書きだけ偽物。
// 表が無い間（table が false）は読みも送りも「表が無い」で断る（送る待ちは消えない）。ゲストで足して「はい」は、足した記録のまま初めて同期すること。
// 同じカード（足した時刻が同じか同じ訳）の間だけ 3 状態（答えの新しい方）と lf（早い方）を合わせる（A1）。同じ鍵で違うカードは、送る待ちにある端末の語を
// 新しい鍵へ移して両方残す（A2）。送っていない墓標の鍵は新しい語に使わない（A2b）。知らない単語帳の id でも名前が同じなら、この端末の単語帳に入れる（A3）。語と訳は試しの物だけ
{
  const U = await import("../js/userItemsSync.js");
  const M = await import("../js/myWords.js");
  const RealDate = Date;
  const HOUR = 3600000;
  const DAY = 24 * HOUR;
  const D0 = new RealDate(2026, 10, 16, 9, 0).getTime(); // 1 日目の 9 時（端末の時刻）
  let NOW = D0;
  globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
  const at = (n, h = 9) => (NOW = D0 + (n - 1) * DAY + (h - 9) * HOUR);
  const iso = (n, h = 9) => new RealDate(D0 + (n - 1) * DAY + (h - 9) * HOUR).toISOString();
  const dayNo = (n) => learnDayOf(D0 + (n - 1) * DAY);
  const devices = {};
  const storeOf = (map = new Map()) => ({ getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), clear: () => map.clear(), key: (i) => [...map.keys()][i] ?? null, get length() { return map.size; } });
  const use = (name) => (globalThis.localStorage = devices[name] ??= storeOf());
  const sky = new Map(); // 雲の行（鍵は kind:key）
  const sent = []; // 雲が受け取った行（送りと、取り込みの後の送り返し）
  let table = true;
  let failReads = 0; // 表はあるが、読みが通信の失敗で落ちる回数（T19b）
  const copy = (v) => JSON.parse(JSON.stringify(v));
  const answer = (make) => Promise.resolve(table ? make() : { data: null, error: { code: "42P01", message: 'relation "public.user_items" does not exist' }, status: 404 });
  const failed = () => (failReads > 0 && table ? (failReads--, true) : false);
  // 雲は本物の表と同じく、消した印（墓標）の中身を空にして入れる（docs/SQL_USER_ITEMS.md §4 の見張り）。
  // 本物の表の窓口と同じ形にも答える（Batch 95）: 鍵の並びの読み（.eq("kind", …).in("key", […])）は、その種類と鍵の行。
  // upsert(行, { ignoreDuplicates: true }) は同じ主キーの行があれば書かない。後に .select(列) が続けば書いた行だけを data に返す（続かなければ null）。
  // オプションの無い upsert は前のまま（上書き）。sent は雲が受け取った行（書かなかった行も入る）。読みの答えは本物の表の形（dbRow: 時刻の文字と payload の鍵の並び）
  const client = { from() { const f = {}; const q = { select: () => q, order: () => q, eq: (c, v) => ((f[c] = v), q), in: (c, vs) => ((f[`in:${c}`] = vs), q),
    then: (ok, bad) => (failed() ? Promise.resolve({ data: null, error: { message: "fetch failed" }, status: 503 }) : answer(() => { const want = new Set(f["in:key"] ?? []); return { data: [...sky.values()].filter((r) => r.kind === f.kind && want.has(r.key)).map((r) => dbRow(copy(r))), error: null, status: 200 }; })).then(ok, bad),
    range: (a, b) => (failed() ? Promise.resolve({ data: null, error: { message: "fetch failed" }, status: 503 }) : answer(() => { const all = [...sky.values()].map((r) => dbRow(copy(r))); return { data: all.slice(a, b + 1), count: all.length, error: null, status: 200 }; })),
    upsert: (rows, opts) => { let cols = null; const w = { select: (c) => ((cols = c ?? "*"), w), then: (ok, bad) => answer(() => { const wrote = []; for (const r of rows) { const id = `${r.kind}:${r.key}`; sent.push(copy(r)); if (opts?.ignoreDuplicates && sky.has(id)) continue; sky.set(id, r.deleted ? { ...copy(r), payload: {} } : copy(r)); wrote.push({ kind: r.kind, key: r.key }); } return { data: cols ? wrote : null, error: null, status: 201 }; }).then(ok, bad) }; return w; } }; return q; } };
  const pull = (name) => (use(name), U.pullUserItems(client, "u1", { now: NOW }));
  const push = (name) => (use(name), U.pushUserItems(client, "u1", { now: NOW }));
  const sync = async (...names) => { for (const name of names) { await pull(name); await push(name); } }; // ページを開いた同期と同じ順（取り込み → 送る）
  const reset = (hasTable) => { for (const k of Object.keys(devices)) delete devices[k]; sky.clear(); sent.length = 0; table = hasTable; failReads = 0; };
  // 表が後: 電話 p<tag>（1 日目）と PC c<tag>（2 日目の 20 時）がそれぞれ足す → day 日目に表ができ、PC → 電話 → PC（fresh なら → 新しい端末 n<tag>）の順に同期
  const lateTable = async (tag, phone, pc, { day = 3, fresh = false } = {}) => {
    reset(false);
    at(1, 8); use(`p${tag}`); await phone();
    at(2, 20); use(`c${tag}`); await pc();
    at(day, 9); table = true;
    await sync(`c${tag}`); at(day, 10); await sync(`p${tag}`); at(day, 11); await sync(`c${tag}`);
    if (fresh) { at(day, 12); await sync(`n${tag}`); }
  };
  const wordsOn = (name) => (use(name), JSON.parse(localStorage.getItem("spelldash_my_words") || "[]"));
  const cardsOf = (name, en) => wordsOn(name).filter((w) => C.isWordEntry(w) && C.answerKeyOf(w) === en);
  const states = (name) => { const s = C.countMyStates(wordsOn(name)); return `${s.learned}/${s.unsure}/${s.new}`; }; // 覚えた/あやふや/これから
  const lfs = (name) => wordsOn(name).filter((w) => Number.isInteger(w.lf)).map((w) => `${w.en}:${w.lf}`).sort().join(",");
  const booksOn = (name) => { const list = wordsOn(name); const books = M.getMyBooks(list); return books.map((b) => `${b.name}:${list.filter((w) => C.bookIdOf(w, books) === b.id).length}`).join("|"); };
  const pairsOn = (name) => wordsOn(name).filter(C.isWordEntry).map((w) => `${C.answerKeyOf(w)}=${C.normJa(w.ja)}`);
  const show = (w) => (w ? `${w.en}|${w.ja}|s${C.myStateOf(w)}|lf${w.lf ?? "-"}` : "なし");
  const BOOK = "試しの単語帳";
  const SIX = ["harbor", "lantern", "meadow", "pebble", "quiver", "saddle"].map((en, i) => ({ en, ja: `試しの訳 ${"一二三四五六"[i]}` }));
  const addSix = () => M.addSharedWords(SIX, { name: BOOK });
  const answer3 = () => { M.recordMyAnswer("harbor", ANSWER_KINDS.exact); M.recordMyAnswer("lantern", ANSWER_KINDS.exact); M.recordMyAnswer("meadow", ANSWER_KINDS.miss); };
  const both = (tag, n) => states(`p${tag}`) === "2/1/3" && states(`c${tag}`) === "2/1/3" && [`p${tag}`, `c${tag}`].every((d) => lfs(d) === `harbor:${dayNo(n)},lantern:${dayNo(n)}`);
  const seen = (tag) => JSON.stringify({ phone: [states(`p${tag}`), lfs(`p${tag}`)], pc: [states(`c${tag}`), lfs(`c${tag}`)] });
  try {
    // ---- T14a: 表が無い間に 2 台で同じ渡された単語帳を足し、電話で 覚えた 2・あやふや 1。表ができて PC が先に同期 → 電話の 3 状態と lf はそのまま・PC も同じ ----
    await lateTable("14a", async () => { addSix(); at(1, 9); answer3(); await sync("p14a"); }, async () => { addSix(); await sync("c14a"); }); // 表が無い間の同期は読めず送れない
    ok("T14a 表が無い間に 2 台で同じ単語帳を足し、電話で 覚えた 2・あやふや 1。表ができて PC が先に同期 → 電話の 3 状態と lf はそのまま・PC も同じ", both("14a", 1), seen("14a"));
    // ---- T14d（守り）: その後の取り込みと送りで送る行は 0（行ったり来たりしない） ----
    const from14d = sent.length;
    for (const h of [12, 13]) { at(3, h); await sync("c14a", "p14a"); }
    const again = sent.slice(from14d).filter((r) => r.kind === "my_word").map((r) => r.key);
    ok("T14d 2 回目からの取り込みと送りで送る行は 0", again.length === 0, JSON.stringify(again));

    // ---- T14b: 表はある。電話（ログイン）が足して答えて送る。PC はゲストで同じ単語帳を足し（取り込みの前）、「はい」の後に同期 → T14a と同じ ----
    reset(true);
    at(1, 8); await sync("p14b"); use("p14b"); addSix(); await push("p14b");
    at(1, 9); use("p14b"); answer3(); await push("p14b");
    at(2, 20); use("c14b"); addSix(); // ゲストで足した
    at(2, 21); await sync("c14b"); // ログインして「はい」: この端末の初めての同期
    at(3, 9); await sync("p14b"); at(3, 10); await sync("c14b");
    ok("T14b 表がある・PC はゲストで同じ単語帳を足して「はい」→ 電話の 3 状態と lf はそのまま・PC も同じ", both("14b", 1), seen("14b"));

    // ---- T14c（守り）: 電話の答えが PC の足しより後（表は後）→ 3 状態と lf はどちらの端末にも残る ----
    await lateTable("14c", addSix, async () => { addSix(); at(3, 9); use("p14c"); answer3(); }, { day: 4 });
    ok("T14c 電話の答えが PC の足しより後 → 電話と PC の 3 状態と lf は電話の答え", both("14c", 3), seen("14c"));

    // ---- T14e（守り）: 2 台で同じ語に答えた（後から送った電話の行は古い答え）→ どちらも答えの時刻 lsAt の新しい方（PC の × で あやふや） ----
    reset(true);
    at(1, 8); use("p14e"); M.addMyWord("ledger", "試しの訳 帳"); await push("p14e");
    at(1, 9); await sync("c14e");
    at(2, 9); use("p14e"); M.recordMyAnswer("ledger", ANSWER_KINDS.exact);
    const ans14e = at(2, 10); use("c14e"); M.recordMyAnswer("ledger", ANSWER_KINDS.miss); await push("c14e");
    at(2, 11); await push("p14e"); at(2, 12); await sync("c14e", "p14e");
    const e14 = ["p14e", "c14e"].map((n) => cardsOf(n, "ledger").map((w) => `${w.ls}@${w.lsAt}`).join(","));
    ok("T14e 2 台で同じ語に答えた → 両方の端末で lsAt の新しい答えの 3 状態（あやふや）", e14.every((s) => s === `1@${ans14e}`), JSON.stringify({ e14, want: `1@${ans14e}` }));

    // ---- T14f: 同じ語（同じ addedAt）。X が古い 3 状態のまま訳を直し、送る前に取り込む。雲には Y の新しい答え → X の語は直した訳と Y の 3 状態。送った行も両方 ----
    reset(true);
    at(1, 8); use("x14f"); M.addMyWord("ledger", "試しの訳 前"); await push("x14f");
    at(1, 9); await sync("y14f");
    at(2, 9); use("y14f"); M.recordMyAnswer("ledger", ANSWER_KINDS.exact); await push("y14f");
    at(2, 10); use("x14f"); M.setMyWordJa("ledger", "試しの訳 後"); await sync("x14f");
    const f14 = [...cardsOf("x14f", "ledger").map(show), show(sky.get("my_word:ledger")?.payload)];
    ok("T14f 訳を直して送る前に取り込む → X の語は直した訳で 覚えた（lf は Y の日）・雲の行も直した訳で 覚えた",
      JSON.stringify(f14) === JSON.stringify(Array(2).fill(`ledger|試しの訳 後|s2|lf${dayNo(2)}`)), JSON.stringify(f14));

    // ---- T14g（守り）: 同じ英語・違う訳・違う addedAt の語には 3 状態と lf を写さない（答えていない語が 覚えた にならない） ----
    // (1) それぞれの端末の最初の語（表が後）。3 台目も
    await lateTable("14g", () => { M.addMyWord("lead", "試しの訳 甲"); at(1, 9); M.recordMyAnswer("lead", ANSWER_KINDS.exact); }, () => M.addMyWord("lead", "試しの訳 乙"), { fresh: true });
    const g1 = ["p14g", "c14g", "n14g"].map((n) => cardsOf(n, "lead").filter((w) => w.ja === "試しの訳 乙").map(show).join(","));
    // (2) 送ってある語をほかの端末で消し（墓標を送った後）、違う訳で足し直す。古い語のままの端末が取り込む
    reset(true);
    at(1, 8); use("x14g"); M.addMyWord("venue", "試しの訳 丙"); at(1, 9); M.recordMyAnswer("venue", ANSWER_KINDS.exact); await push("x14g");
    at(1, 10); await sync("y14g");
    at(2, 9); use("x14g"); M.removeMyWord("venue", "word"); await push("x14g");
    at(2, 10); use("x14g"); M.addMyWord("venue", "試しの訳 丁"); await push("x14g");
    at(2, 11); await sync("y14g"); at(2, 12); await sync("x14g");
    // Batch 95 の設計（K1）: 雲の英語の鍵は墓標なので、足し直した 丁 は送る前に待ち、次の取り込みで新しい鍵へ移って送る。y は次の同期で受け取る
    at(2, 13); await sync("y14g");
    const g2 = ["x14g", "y14g"].map((n) => cardsOf(n, "venue").map(show).join(","));
    // (3) 端末の語（新しい・送ってある）が勝ち、雲の行は古い別のカード（覚えた）: 送る行に雲の 3 状態と lf を写さない
    reset(true);
    use("z14g");
    localStorage.setItem("spelldash_my_words", JSON.stringify([{ en: "venue", ja: "試しの訳 丁", addedAt: iso(2, 10) }]));
    localStorage.setItem("spelldash_user_items_meta", JSON.stringify({ "my_word:venue": { updatedAt: iso(2, 10), deleted: false } }));
    sky.set("my_word:venue", { user_id: "u1", kind: "my_word", key: "venue", payload: { en: "venue", ja: "試しの訳 丙", addedAt: iso(1, 8), ls: 2, lsAt: D0, lf: dayNo(1) }, deleted: false, updated_at: iso(1, 9) });
    at(2, 11); await pull("z14g");
    // Batch 95 の設計: 雲の違うカード（丙・覚えた）は上書きしない（端末の 丁 は新しい鍵へ移り、両方残る）。丁 は端末でも雲でも これから・丙 は 覚えた のまま
    const skyJa = (ja) => [...sky.values()].filter((r) => r.kind === "my_word" && !r.deleted && r.payload?.ja === ja).map((r) => show(r.payload));
    const g3 = [...cardsOf("z14g", "venue").filter((w) => w.ja === "試しの訳 丁").map(show), ...skyJa("試しの訳 丁")];
    const g3old = [...cardsOf("z14g", "venue").filter((w) => w.ja === "試しの訳 丙").map(show), ...skyJa("試しの訳 丙")];
    const fresh = (s) => s !== "" && s.split(",").every((x) => /\|s0\|lf-$/.test(x));
    ok("T14g 違うカード（違う訳・違う足した時刻）には 3 状態と lf を写さない: (1) 表が後の最初の語どうし（3 台とも 乙 は これから）(2) 消して違う訳で足し直した語（両方の端末で これから）(3) 端末の新しい語（丁）と雲の古い別のカード（丙）: 両方残り、丁 は これから・丙 は 覚えた",
      g1.every(fresh) && g2.every(fresh) && g3.length === 2 && g3.every(fresh) && g3old.length === 2 && g3old.every((x) => /\|s2\|lf/.test(x)), JSON.stringify({ g1, g2, g3, g3old }));

    // ---- T14h: 1 台で消して同じ訳で足し直し（墓標を送った後）、ほかの端末は古い語のまま → 取り込みで前の 3 状態が戻る（同じ訳は同じカード。決めた形） ----
    reset(true);
    at(1, 8); use("x14h"); M.addMyWord("venue", "試しの訳 場"); at(1, 9); M.recordMyAnswer("venue", ANSWER_KINDS.exact); await push("x14h");
    at(1, 10); await sync("y14h");
    at(2, 9); use("x14h"); M.removeMyWord("venue", "word"); await push("x14h");
    at(2, 10); use("x14h"); M.addMyWord("venue", "試しの訳 場"); await push("x14h");
    at(2, 11); await sync("y14h"); at(2, 12); await sync("x14h"); at(2, 13); await sync("y14h");
    const h14 = ["y14h", "x14h"].map((n) => cardsOf(n, "venue").map(show).join(","));
    // Batch 95 の設計（K1・1 つの鍵に 1 つのカード）: 雲の英語の鍵は墓標なので、足し直した語（新しいカード）は新しい鍵へ移り、これから で両方の端末に 1 語。
    // 古い端末の語は墓標で消える（前は古い端末の語と同じ組でまとまり、消した語の 3 状態が戻ることがあった: §18.6）
    const keyH = `venue~${C.jaHash("試しの訳 場", 8)}`;
    ok("T14h 消して同じ訳で足し直した語を、古い語のままの端末が取り込む → 両方の端末で足し直した 1 語（新しい鍵・これから）。消した語の 3 状態は戻らない", h14.every((s) => s === `${keyH}|試しの訳 場|s0|lf-`), JSON.stringify(h14));

    // ---- T15a: 1 語。電話 lead（訳 A・覚えた）、PC lead（訳 B）、表が後 → 3 台とも 2 語。訳 A の語は鍵 lead~<印>・覚えた・lf のまま・text あり。電話のメモ my-lead は動かない ----
    const keyA = `lead~${C.jaHash("試しの訳 A", 8)}`;
    const phoneA = () => { M.addMyWord("lead", "試しの訳 A"); localStorage.setItem("spelldash_word_notes", JSON.stringify({ "my-lead": "試しのメモ" })); U.touchItem("note", "my-lead"); at(1, 9); M.recordMyAnswer("lead", ANSWER_KINDS.exact); };
    await lateTable("15a", phoneA, () => M.addMyWord("lead", "試しの訳 B"), { fresh: true });
    const a15 = ["p15a", "c15a", "n15a"].map((n) => cardsOf(n, "lead").map((w) => `${show(w)}|${w.text ?? "-"}`).sort().join(","));
    const want15a = [`${keyA}|試しの訳 A|s2|lf${dayNo(1)}|lead`, "lead|試しの訳 B|s0|lf-|-"].sort().join(",");
    use("p15a");
    const notes15 = localStorage.getItem("spelldash_word_notes");
    ok("T15a 同じ英語・違う訳を 2 台で足して表が後 → 3 台とも 2 語（訳 A は lead~<印> で 覚えた・lf・text のまま）・電話のメモは my-lead のまま",
      a15.every((s) => s === want15a) && notes15 === '{"my-lead":"試しのメモ"}', JSON.stringify({ a15, want15a, notes15 }));

    // ---- T15b: 表がある。電話（送ってある）で単語帳 1、PC はゲストで単語帳 2（同じ英語・違う訳の語を 2 つ含む）を足して「はい」→ どの組も消えない・電話の 覚えた はそのまま ----
    reset(true);
    const B1 = [["alpha", "試しの訳 甲"], ["bravo", "試しの訳 乙"], ["charlie", "試しの訳 丙"]].map(([en, ja]) => ({ en, ja }));
    const B2 = [["alpha", "試しの訳 丁"], ["bravo", "試しの訳 戊"], ["delta", "試しの訳 己"]].map(([en, ja]) => ({ en, ja }));
    at(1, 8); await sync("p15b"); use("p15b"); M.addSharedWords(B1, { name: "試しの一冊目" }); await push("p15b");
    at(1, 9); use("p15b"); M.recordMyAnswer("alpha", ANSWER_KINDS.exact); await push("p15b");
    at(2, 20); use("c15b"); M.addSharedWords(B2, { name: "試しの二冊目" });
    at(2, 21); await sync("c15b"); at(3, 9); await sync("p15b"); at(3, 10); await sync("c15b");
    const all15b = JSON.stringify([...B1, ...B2].map((w) => `${w.en}=${w.ja}`).sort());
    const b15 = ["p15b", "c15b"].map((n) => ({ pairs: JSON.stringify(pairsOn(n).sort()), alpha: cardsOf(n, "alpha").filter((w) => w.ja === "試しの訳 甲").map(show).join(",") }));
    ok("T15b PC がゲストで同じ英語・違う訳の単語帳を足して「はい」→ 両方の端末に 6 組（どの組も消えない）・電話の 覚えた（alpha=甲）はどちらでも 覚えた",
      b15.every((b) => b.pairs === all15b && b.alpha === `alpha|試しの訳 甲|s2|lf${dayNo(1)}`), JSON.stringify(b15));

    // ---- T15c: 同じ 2 冊を 2 台で逆の順に足す（電話は 1 冊目に答えた・表は後）→ 答えた組の 3 状態はどの端末でも残る（同じ組が 2 つ並ぶのは残る物: 数だけ見る） ----
    const U1 = [{ en: "rise", ja: "試しの訳 上" }, { en: "fall", ja: "試しの訳 下" }];
    const U2 = [{ en: "rise", ja: "試しの訳 横" }, { en: "fall", ja: "試しの訳 縦" }];
    const phoneC = () => { M.addSharedWords(U1, { name: "試しの一冊目" }); M.addSharedWords(U2, { name: "試しの二冊目" }); at(1, 9); M.recordMyAnswer("rise", ANSWER_KINDS.exact); M.recordMyAnswer("fall", ANSWER_KINDS.exact); };
    await lateTable("15c", phoneC, () => { M.addSharedWords(U2, { name: "試しの二冊目" }); M.addSharedWords(U1, { name: "試しの一冊目" }); }, { fresh: true });
    const c15 = ["p15c", "c15c", "n15c"].map((n) => ({ kinds: new Set(pairsOn(n)).size, dup: pairsOn(n).length - new Set(pairsOn(n)).size, answered: wordsOn(n).filter((w) => C.isWordEntry(w) && ["試しの訳 上", "試しの訳 下"].includes(w.ja)).map(show) }));
    ok("T15c 同じ 2 冊を逆の順に足す → どの端末も 4 組あり、答えた 2 組はどれも 覚えた（同じ組が 2 つ並ぶ数は残る物として見るだけ）",
      c15.every((c) => c.kinds === 4 && c.answered.length >= 2 && c.answered.every((s) => s.endsWith(`|s2|lf${dayNo(1)}`))), JSON.stringify(c15));

    // ---- T15d（守り）: 送ってある語をほかの端末で消して違う訳で足し直す → 取り込みで新しい語だけ（消した語は戻らない） ----
    const d15 = [];
    for (const sentFirst of [false, true]) {
      reset(true);
      at(1, 8); use("x15d"); M.addMyWord("bank", "試しの訳 旧"); await push("x15d");
      at(1, 9); await sync("y15d");
      at(2, 9); use("x15d"); M.removeMyWord("bank", "word");
      if (sentFirst) await push("x15d"); // 墓標を送ってから足し直す（英語の鍵に新しい語）
      use("x15d"); M.addMyWord("bank", "試しの訳 新"); await push("x15d");
      at(2, 10); await sync("y15d"); at(2, 11); await sync("x15d"); at(2, 12); await sync("y15d"); // Batch 95（K1）: 墓標の鍵の足し直しは次の取り込みで新しい鍵へ移るので、y は 1 回後に受け取る
      d15.push(["x15d", "y15d"].map((n) => cardsOf(n, "bank").map((w) => w.ja).join(",")));
    }
    ok("T15d 送ってある語をほかの端末で消して違う訳で足し直す（送る前に足す・墓標を送ってから足す）→ どちらの端末も新しい語だけ", d15.flat().every((s) => s === "試しの訳 新"), JSON.stringify(d15));

    // ---- T15e: 鍵を移した語は 1 回だけ送る（2 回目の取り込みでは 0）・前の鍵の印は雲の行の時刻で、送る待ちに無い ----
    reset(false);
    at(1, 8); use("p15e"); M.addMyWord("lead", "試しの訳 A"); at(1, 9); M.recordMyAnswer("lead", ANSWER_KINDS.exact);
    at(2, 20); use("c15e"); M.addMyWord("lead", "試しの訳 B");
    at(3, 9); table = true; await sync("c15e");
    at(3, 10); const from15e = sent.length; await sync("p15e");
    const once = sent.slice(from15e).filter((r) => r.key === keyA).length;
    use("p15e");
    const meta15 = U.getItemMeta()["my_word:lead"] ?? null;
    const dirty15 = [...U.getDirtyItems()].filter((id) => id.startsWith("my_word:"));
    at(3, 11); const from15e2 = sent.length; await sync("c15e", "p15e", "c15e");
    const twice = sent.slice(from15e2).filter((r) => r.kind === "my_word").length;
    ok("T15e 鍵を移した語は 1 回だけ送る・2 回目からは 0・前の鍵の印は雲の行（PC の語）の時刻・送る待ちは空",
      once === 1 && twice === 0 && Date.parse(meta15?.updatedAt) === Date.parse(sky.get("my_word:lead")?.updated_at) && meta15?.deleted === false && dirty15.length === 0, JSON.stringify({ once, twice, meta15, cloud: sky.get("my_word:lead")?.updated_at, dirty15 }));

    // ---- T15f（守り）: 場面カードと同じ鍵の雲の英語の語は今のまま（鍵を移さない。新しい方が勝つ）・雲の墓標より新しい語は今のまま。
    // 雲の墓標より古い語（3 つ目）: この端末は一度も取り込んでいない（送ったことが無い）ので、ほかの端末が消したのは別のカード → 鍵を移して残す（Batch 94 の直し。§18.10・T21） ----
    const f15 = [];
    for (const [entry, row, localNewer] of [
      [{ kind: "concept", en: "cpc", answer: "CPC", q: "試しの場面の文", explain: "", accept: [], ja: "" }, { en: "cpc", ja: "試しの訳 費", addedAt: iso(1, 9) }, false],
      [{ kind: "concept", en: "cpc", answer: "CPC", q: "試しの場面の文", explain: "", accept: [], ja: "" }, { en: "cpc", ja: "試しの訳 費", addedAt: iso(1, 9) }, true],
      [{ en: "cpc", ja: "試しの訳 新" }, null, false],
      [{ en: "cpc", ja: "試しの訳 新" }, null, true]
    ]) {
      reset(true);
      const t = localNewer ? iso(1, 10) : iso(1, 8);
      use("y15f"); localStorage.setItem("spelldash_my_words", JSON.stringify([{ ...entry, addedAt: t }])); U.touchItem("my_word", "cpc", false, t);
      sky.set("my_word:cpc", { user_id: "u1", kind: "my_word", key: "cpc", payload: row ?? {}, deleted: !row, updated_at: iso(1, 9) });
      at(1, 11); await sync("y15f");
      const r = sky.get("my_word:cpc");
      f15.push(`${wordsOn("y15f").map((w) => `${w.kind ?? "word"}:${w.en}=${w.ja}`).join(",")}/${r.deleted ? "墓標" : `${r.payload.kind ?? "word"}=${r.payload.ja}`}`);
    }
    // Batch 95 の設計（K1）: 一度も雲と合わせていない端末の語は、墓標より新しくても墓標の鍵を使わない（新しい鍵へ移して残す。墓標はその鍵に残る）
    ok("T15f 場面カードと同じ鍵の英語の語は今のまま（新しい方が勝つ・~ の鍵を作らない）・一度も取り込んでいない端末の語は墓標で消さない（墓標より古くても新しくても鍵を移す）",
      JSON.stringify(f15) === JSON.stringify(["word:cpc=試しの訳 費/word=試しの訳 費", "concept:cpc=/concept=", `word:cpc~${C.jaHash("試しの訳 新", 8)}=試しの訳 新/墓標`, `word:cpc~${C.jaHash("試しの訳 新", 8)}=試しの訳 新/墓標`]), JSON.stringify(f15));

    // ---- T15g: 雲に同じ組（答えの英語と訳）が別の鍵であれば、その鍵へ移す（同じカードとしてまとまり、3 状態は新しい答え） ----
    const upKey = `rise~${C.jaHash("試しの訳 上", 8)}`;
    await lateTable("15g", () => { M.addMyWordsBulk("rise, 試しの訳 上\nrise, 試しの訳 横"); at(1, 9); M.recordMyAnswer("rise", ANSWER_KINDS.exact); }, () => M.addMyWordsBulk("rise, 試しの訳 横\nrise, 試しの訳 上"));
    const g15 = ["p15g", "c15g"].map((n) => cardsOf(n, "rise").filter((w) => w.ja === "試しの訳 上").map(show).join(","));
    ok("T15g 雲に同じ組が別の鍵（PC の rise~<上の印>）であれば、電話の語はその鍵へ移る: 両方の端末で 上 の語は 1 つ・その鍵・覚えた・lf", g15.every((s) => s === `${upKey}|試しの訳 上|s2|lf${dayNo(1)}`), JSON.stringify({ g15, upKey }));

    // ---- T16a: 消した語の墓標をまだ送っていない間に同じ英語を足す（同じ訳でも違う訳でも・まとめて足す・渡された単語帳を足す）→ 新しい語の鍵は <英語>~<印>・墓標は送る待ちに残る ----
    const a16 = [];
    for (const [ja, add] of [
      ["試しの訳 別", () => M.addMyWord("quota", "試しの訳 別")],
      ["試しの訳 割", () => M.addMyWord("quota", "試しの訳 割")],
      ["試しの訳 別", () => M.addMyWordsBulk("quota, 試しの訳 別")],
      ["試しの訳 別", () => M.addSharedWords([{ en: "quota", ja: "試しの訳 別" }], { name: "試しの帳" })]
    ]) {
      reset(true);
      at(1, 8); use("x16"); M.addMyWord("quota", "試しの訳 割"); await push("x16");
      at(2, 9); use("x16"); M.removeMyWord("quota", "word"); add();
      const tomb = U.getDirtyItems().has("my_word:quota") && U.getItemMeta()["my_word:quota"]?.deleted === true;
      a16.push(`${cardsOf("x16", "quota").map((w) => (w.en === `quota~${C.jaHash(ja, 8)}` ? "印" : w.en)).join(",")}/${tomb ? "墓標" : "なし"}`);
    }
    // 同じ訳で足し直した後に送る → 古い語を持つほかの端末は 1 語（新しい鍵）
    reset(true);
    at(1, 8); use("x16"); M.addMyWord("quota", "試しの訳 割"); await push("x16");
    at(1, 9); await sync("y16");
    at(2, 9); use("x16"); M.removeMyWord("quota", "word"); M.addMyWord("quota", "試しの訳 割"); await push("x16");
    at(2, 10); await sync("y16");
    const y16 = cardsOf("y16", "quota").map((w) => w.en).join(",");
    ok("T16a 送っていない墓標の鍵を新しい語に使わない（1 語・まとめて・渡された単語帳。同じ訳でも違う訳でも）: 鍵は <英語>~<印>・墓標は送る待ちに残る・ほかの端末は 1 語",
      a16.every((a) => a === "印/墓標") && y16 === `quota~${C.jaHash("試しの訳 割", 8)}`, JSON.stringify({ a16, y16 }));

    // ---- T16b（守り）: その後、送る前に取り込んでも、消した語は戻らない ----
    reset(true);
    at(1, 8); use("x16b"); M.addMyWord("bank", "試しの訳 旧"); await push("x16b");
    at(1, 9); await sync("y16b");
    at(2, 9); use("x16b"); M.removeMyWord("bank", "word"); M.addMyWord("bank", "試しの訳 新");
    at(2, 10); await sync("x16b"); at(2, 11); await sync("y16b");
    const b16 = ["x16b", "y16b"].map((n) => cardsOf(n, "bank").map((w) => w.ja).join(","));
    ok("T16b 消して違う訳で足し直し、送る前に取り込む → 消した語は戻らない（両方の端末で新しい語だけ）", b16.every((s) => s === "試しの訳 新"), JSON.stringify(b16));

    // ---- T16c（守り）: 墓標を送った後は今どおり英語の鍵 ----
    reset(true);
    at(1, 8); use("x16c"); M.addMyWord("quota", "試しの訳 割"); await push("x16c");
    at(2, 9); use("x16c"); M.removeMyWord("quota", "word"); await push("x16c");
    use("x16c"); M.addMyWord("quota", "試しの訳 別");
    const c16 = cardsOf("x16c", "quota").map((w) => w.en).join(",");
    ok("T16c 墓標を送った後に足すと英語の鍵（今どおり）", c16 === "quota", c16);

    // ---- T17a: 表が後で 2 台が同じ単語帳（同じ名前・違う id）を足す → 両方の端末で 1 冊（「 2」が無い）・語の数は全部 ----
    await lateTable("17", () => { addSix(); at(1, 9); M.recordMyAnswer("harbor", ANSWER_KINDS.exact); }, addSix);
    const one = `マイ単語帳:0|${BOOK}:6`;
    ok("T17a 2 台が同じ単語帳（同じ名前・違う id）を足して表が後 → 両方の端末で 1 冊・6 語", booksOn("p17") === one && booksOn("c17") === one, JSON.stringify({ phone: booksOn("p17"), pc: booksOn("c17") }));
    // ---- T17b（守り）: その後 2 台がそれぞれ答えて送る（雲の行は 2 つの id）→ 新しい端末（3 台目）も 1 冊 ----
    at(4, 9); use("p17"); M.recordMyAnswer("lantern", ANSWER_KINDS.exact); await push("p17");
    at(4, 10); use("c17"); M.recordMyAnswer("pebble", ANSWER_KINDS.exact); await push("c17");
    at(4, 11); await sync("n17", "p17", "c17");
    const ids17 = new Set([...sky.values()].filter((r) => r.kind === "my_word" && !r.deleted).map((r) => r.payload.book)).size;
    const b17 = ["n17", "p17", "c17"].map((n) => `${booksOn(n)}/${states(n)}`);
    ok("T17b 2 台が答えて送った後（雲の行に id が 2 つ）→ 新しい端末も 1 冊・電話と PC も 1 冊・3 状態は 3 台で同じ", ids17 === 2 && b17.every((s) => s === `${one}/3/0/3`), JSON.stringify({ ids17, b17 }));
    // ---- T17c（守り）: 名前の違う単語帳への移動は届く・訳の直しと消す印は今どおり ----
    at(5, 9); use("c17");
    M.moveMyWords(["word:quiver"], M.createMyBook("試しの別帳").book?.id); M.setMyWordJa("saddle", "試しの訳 六・直し"); M.removeMyWord("pebble", "word"); await push("c17");
    at(5, 10); await sync("p17");
    const c17 = [booksOn("p17"), ...cardsOf("p17", "saddle").map((w) => w.ja), cardsOf("p17", "pebble").length];
    ok("T17c ほかの端末で名前の違う単語帳へ移す・訳を直す・消す → 電話に届く（移した語はその名前の単語帳・直した訳・消した語は無い）",
      JSON.stringify(c17) === JSON.stringify([`マイ単語帳:0|${BOOK}:4|試しの別帳:1`, "試しの訳 六・直し", 0]), JSON.stringify(c17));
    // ---- T17d（守り）: ほかの端末で名前を変えると、語は新しい名前の単語帳へ（この端末の前の名前の単語帳は空で残る: 決めた形） ----
    at(6, 9); use("p17");
    M.renameMyBook(M.getMyBooks().find((b) => b.name === BOOK)?.id, "試しの新しい名前"); await push("p17");
    at(6, 10); await sync("c17");
    ok("T17d 電話で名前を変える → PC の語は新しい名前の単語帳へ（前の名前の単語帳は空で残る）", booksOn("c17") === `マイ単語帳:0|${BOOK}:0|試しの別帳:1|試しの新しい名前:4`, booksOn("c17"));
    // ---- T17e（守り）: 単語帳だけの違いは送り返さない（3 状態も lf も同じ語） ----
    reset(false);
    at(1, 8); use("p17e"); addSix(); at(2, 20); use("c17e"); addSix();
    at(3, 9); table = true; await sync("c17e");
    at(3, 10); const from17e = sent.length; await sync("p17e");
    const back17 = sent.slice(from17e).filter((r) => r.kind === "my_word").map((r) => r.key);
    ok("T17e 単語帳の id だけが違う語は送り返さない（電話の取り込みと送りで 0 行）", back17.length === 0, JSON.stringify(back17));

    // ===== Batch 94 の直し: T14i・T18〜T20（消した語の墓標・読めなかったページの送り・送ってある語の鍵の移し） =====
    // ---- T14i（守り）: 足した時刻の無い 2 つの違うカード（訳が違う）は同じカードにしない（足した時刻は両方にあるときだけ比べる） ----
    reset(true);
    use("x14i");
    localStorage.setItem("spelldash_my_words", JSON.stringify([C.applyMyAnswer({ en: "lead", ja: "試しの訳 甲" }, ANSWER_KINDS.exact, D0)]));
    localStorage.setItem("spelldash_user_items_meta", JSON.stringify({ "my_word:lead": { updatedAt: iso(1, 9), deleted: false } }));
    sky.set("my_word:lead", { user_id: "u1", kind: "my_word", key: "lead", payload: { en: "lead", ja: "試しの訳 乙" }, deleted: false, updated_at: iso(1, 10) });
    at(1, 11); await sync("x14i");
    const i14 = [...cardsOf("x14i", "lead").map(show), show(sky.get("my_word:lead")?.payload)];
    // Batch 95 の設計: 雲の違うカードに足した時刻が無い（前の版の端末が読まずに送った行）ので、その行を書いた端末はこの端末の 甲 を見て消したのではない:
    // 甲 は新しい鍵へ移して残す（覚えた のまま）。雲の 乙 には 3 状態と lf を写さない
    const i14moved = `lead~${C.jaHash("試しの訳 甲", 8)}|試しの訳 甲|s2|lf${dayNo(1)}`;
    ok("T14i 足した時刻の無い違うカード（訳が違う）には 3 状態と lf を写さない（雲の新しい語は これから のまま）・端末の 甲 は新しい鍵で残る",
      JSON.stringify(i14) === JSON.stringify([i14moved, "lead|試しの訳 乙|s0|lf-", "lead|試しの訳 乙|s0|lf-"]), JSON.stringify(i14));

    // 電話が単語帳 1（alpha=甲・bravo=乙・charlie=丙）を足して alpha と bravo を 覚えた にして送る（表はある）
    const tomb18 = (key) => sky.get(`my_word:${key}`)?.deleted === true;
    const learnedOn = (name) => wordsOn(name).filter((w) => C.isWordEntry(w) && C.myStateOf(w) === 2).map((w) => `${C.answerKeyOf(w)}=${w.ja}`).sort().join(",");
    const want18 = "alpha=試しの訳 甲,bravo=試しの訳 乙";
    const phoneLearnsB1 = async (tag) => {
      at(1, 8); await sync(`p${tag}`); use(`p${tag}`); M.addSharedWords(B1, { name: "試しの一冊目" }); await push(`p${tag}`);
      at(1, 9); use(`p${tag}`); M.recordMyAnswer("alpha", ANSWER_KINDS.exact); M.recordMyAnswer("bravo", ANSWER_KINDS.exact); await push(`p${tag}`);
    };
    // ---- T18a: PC はゲストで単語帳 2（alpha=丁・bravo=戊・delta=己）を足し、自分の alpha（丁）を消してから「はい」→ 電話の alpha=甲 の 覚えた は消えない（違うカードを消した墓標は送らない） ----
    reset(true);
    await phoneLearnsB1("18a");
    at(2, 20); use("c18a"); M.addSharedWords(B2, { name: "試しの二冊目" });
    at(2, 21); use("c18a"); M.removeMyWord("alpha", "word"); // ゲストのまま、自分の alpha（丁）を消す
    at(2, 22); await sync("c18a"); // ログインして「はい」: この端末の初めての同期
    at(3, 9); await sync("p18a"); at(3, 10); await sync("c18a");
    ok("T18a PC がゲストで自分の違うカード（alpha=丁）を消してから「はい」→ 電話と PC に alpha=甲・bravo=乙 の 覚えた が残る・雲の alpha は墓標にならない",
      learnedOn("p18a") === want18 && learnedOn("c18a") === want18 && !tomb18("alpha"), JSON.stringify({ phone: learnedOn("p18a"), pc: learnedOn("c18a"), alpha: sky.get("my_word:alpha") }));
    // ---- T18b: PC はゲストで単語帳 2 を足して丸ごと消してから「はい」→ 電話の 覚えた は消えない・雲に墓標は入らない（delta は雲に無かった鍵） ----
    reset(true);
    await phoneLearnsB1("18b");
    at(2, 20); use("c18b"); const book18b = M.addSharedWords(B2, { name: "試しの二冊目" }).book?.id;
    at(2, 21); use("c18b"); M.deleteMyBook(book18b);
    at(2, 22); await sync("c18b"); at(3, 9); await sync("p18b"); at(3, 10); await sync("c18b");
    const tombs18b = [...sky.values()].filter((r) => r.kind === "my_word" && r.deleted).map((r) => r.key);
    ok("T18b PC がゲストで単語帳 2 を丸ごと消してから「はい」→ 電話と PC に alpha=甲・bravo=乙 の 覚えた が残る・雲に墓標は入らない",
      learnedOn("p18b") === want18 && learnedOn("c18b") === want18 && tombs18b.length === 0, JSON.stringify({ phone: learnedOn("p18b"), pc: learnedOn("c18b"), tombs18b }));
    // ---- T18c: 表が後。PC は表ができる前に自分の bravo（戊）を消した → 表ができて PC → 電話 → PC の順に同期 → 電話の bravo=乙 の 覚えた は消えない（雲に無かった鍵の墓標は送らない） ----
    const phoneB1 = () => { M.addSharedWords(B1, { name: "試しの一冊目" }); at(1, 9); M.recordMyAnswer("alpha", ANSWER_KINDS.exact); M.recordMyAnswer("bravo", ANSWER_KINDS.exact); };
    await lateTable("18c", phoneB1, () => { M.addSharedWords(B2, { name: "試しの二冊目" }); at(2, 21); M.removeMyWord("bravo", "word"); });
    ok("T18c 表が後・PC が表の前に自分の違うカード（bravo=戊）を消した → 電話と PC に alpha=甲・bravo=乙 の 覚えた が残る・雲の bravo は墓標にならない",
      learnedOn("p18c") === want18 && learnedOn("c18c") === want18 && !tomb18("bravo"), JSON.stringify({ phone: learnedOn("p18c"), pc: learnedOn("c18c"), bravo: sky.get("my_word:bravo") }));
    // ---- T18d（守り）: 同じカードを消した墓標は今どおり届く: (1) 送ってある語を消して、送る前に取り込む (2) 2 台が同じ渡された単語帳を表の前に足し、PC が 1 語を消した
    // （雲に無かった鍵）→ 電話がその語を送った後に届く (3) 消した語の印の無い前の版の墓標は今どおり（新しい方が勝つ） ----
    const d18 = [];
    reset(true);
    at(1, 8); use("x18d"); M.addMyWord("venue", "試しの訳 場"); await push("x18d");
    at(1, 9); await sync("y18d");
    at(2, 9); use("x18d"); M.removeMyWord("venue", "word");
    at(2, 10); await sync("x18d"); at(2, 11); await sync("y18d");
    d18.push(`${cardsOf("x18d", "venue").length}/${cardsOf("y18d", "venue").length}/${tomb18("venue") ? "墓標" : "生"}`);
    await lateTable("18e", addSix, () => { addSix(); at(2, 21); M.removeMyWord("harbor", "word"); });
    at(3, 12); await sync("p18e");
    d18.push(`${cardsOf("p18e", "harbor").length}/${cardsOf("c18e", "harbor").length}/${tomb18("harbor") ? "墓標" : "生"}`);
    reset(true);
    use("z18d");
    localStorage.setItem("spelldash_my_words", "[]");
    localStorage.setItem("spelldash_user_items_meta", JSON.stringify({ "my_word:venue": { updatedAt: iso(2, 9), deleted: true } }));
    localStorage.setItem("spelldash_user_items_dirty", JSON.stringify(["my_word:venue"]));
    sky.set("my_word:venue", { user_id: "u1", kind: "my_word", key: "venue", payload: { en: "venue", ja: "試しの訳 別", addedAt: iso(1, 8) }, deleted: false, updated_at: iso(1, 9) });
    at(2, 10); await sync("z18d");
    d18.push(`${cardsOf("z18d", "venue").length}/${tomb18("venue") ? "墓標" : "生"}`);
    // Batch 95 の設計: (2) 表の前（一度も雲を読めていない端末）の墓標は、ほかの端末の語を見ていないので、雲の生きた行に会えば取り込む（消すより戻す）。
    // (3) 消したカードの印の無い墓標（前の版）は、雲の生きた行がどのカードか分からないので取り込む（消すより戻す）
    ok("T18d 同じカードを消した墓標は届く（送る前に取り込む）・表の前の墓標と、消したカードの印の無い前の版の墓標は、雲の生きた行に会えば取り込む",
      JSON.stringify(d18) === JSON.stringify(["0/0/墓標", "1/1/生", "1/生"]), JSON.stringify(d18));

    // ---- T19a: 表が無い間に電話が単語帳 1 で 2 語 覚えた。PC のタブは表が無い間に開き（読めなかった）、そのまま単語帳 2 を足す。表ができて電話が新しいタブで送った後、
    // PC の開いたままのタブがセットの終わりに送る（取り込まずに送る）→ PC の語は送らない（読めるまで待つ）・電話の 覚えた は消えない ----
    reset(false);
    at(1, 8); use("p19a"); M.addSharedWords(B1, { name: "試しの一冊目" }); at(1, 9); M.recordMyAnswer("alpha", ANSWER_KINDS.exact); M.recordMyAnswer("bravo", ANSWER_KINDS.exact); await sync("p19a");
    at(2, 20); await sync("c19a"); use("c19a"); M.addSharedWords(B2, { name: "試しの二冊目" }); // PC のタブは表が無い間に開いた（読めなかった）。足したのはその後
    at(3, 8); table = true; // 表を作った
    at(3, 9); await sync("p19a"); // 電話の新しいタブ: 読んで（雲は空）送る
    at(3, 10); const from19a = sent.length; await push("c19a"); // PC の開いたままのタブがセットを終えて送る（取り込まない）
    const held19a = sent.slice(from19a).filter((r) => r.kind === "my_word").map((r) => r.key).join(",");
    at(3, 11); await sync("p19a"); at(3, 12); await sync("c19a"); at(3, 13); await sync("p19a");
    // Batch 95: 送る前に読むので、雲に行の無い語（delta）はそのまま送り、雲の違うカードと同じ鍵の語（alpha・bravo）は端末の鍵のまま雲の新しい鍵（~<訳の印>）へ送る（電話の行を上書きしない）
    const sent19a = held19a.split(",");
    ok("T19a 表を作ったときに開いていた PC のタブ（読めなかった）は、送る前に読み、雲の違うカードと同じ鍵の語は雲の新しい鍵へ送る（電話の alpha・bravo の行は書かない）→ 電話と PC に alpha=甲・bravo=乙 の 覚えた が残る",
      sent19a[0] === "delta" && !sent19a.includes("alpha") && !sent19a.includes("bravo") && sent19a.some((k) => k.startsWith("alpha~")) && sent19a.some((k) => k.startsWith("bravo~")) && learnedOn("p19a") === want18 && learnedOn("c19a") === want18, JSON.stringify({ held19a, phone: learnedOn("p19a"), pc: learnedOn("c19a") }));
    // ---- T19b: 表はある。PC はゲストで単語帳 2 を足して「はい」。最初の読みが通信の失敗で落ち、そのタブがセットの終わりに送る → 語は送らない（メモは今どおり送る）・
    // 次に読めたら取り込んでから送る → 電話の 覚えた は消えない ----
    reset(true);
    await phoneLearnsB1("19b");
    at(2, 20); use("c19b"); M.addSharedWords(B2, { name: "試しの二冊目" }); localStorage.setItem("spelldash_word_notes", JSON.stringify({ "my-delta": "試しのメモ" })); U.touchItem("note", "my-delta");
    at(2, 21); failReads = 1; await pull("c19b"); // ログインして「はい」: 最初の読みが落ちた（同期の取り込み済みの印はそれでも付く: js/sync.js）
    at(2, 22); const from19b = sent.length; await push("c19b"); // セットの終わりの送り（取り込まない）
    const kinds19b = sent.slice(from19b).map((r) => (r.kind === "my_word" ? `my_word:${r.key}` : r.kind)).join(",");
    at(3, 9); await sync("c19b"); at(3, 10); await sync("p19b"); at(3, 11); await sync("c19b");
    // Batch 95: セットの終わりの送りも先に読む: 雲に行の無い語（delta）とメモは送り、雲の違うカードと同じ鍵の語は雲の新しい鍵へ送る（電話の行は書かない）
    const sent19b = kinds19b.split(",");
    ok("T19b 最初の読みが落ちたタブの送りは先に読み、雲の違うカードと同じ鍵の語は電話の行を書かずに雲の新しい鍵へ送る（delta とメモも送る）・次に読めたら取り込む → 電話と PC に alpha=甲・bravo=乙 の 覚えた が残る",
      sent19b.includes("my_word:delta") && sent19b.includes("note") && !sent19b.includes("my_word:alpha") && !sent19b.includes("my_word:bravo") && sent19b.some((k) => k.startsWith("my_word:alpha~")) && learnedOn("p19b") === want18 && learnedOn("c19b") === want18, JSON.stringify({ kinds19b, phone: learnedOn("p19b"), pc: learnedOn("c19b") }));
    // ---- T19c（守り）: 読めた後は、取り込まないページ（同じタブの 2 つ目からのページ: 取り込みは最初のページだけ）の送りでも、足した語を送る ----
    reset(true);
    at(1, 8); await sync("x19c"); // 最初のページ: 読んで送る
    const nextPage = await import("../js/userItemsSync.js?page=2"); // 同じタブの次のページ（このページの中の値は新しい・取り込みはしない）
    at(1, 9); use("x19c"); M.addMyWord("quota", "試しの訳 割");
    const from19c = sent.length; await nextPage.pushUserItems(client, "u1", { now: NOW });
    const c19 = sent.slice(from19c).filter((r) => r.kind === "my_word").map((r) => r.key).join(",");
    ok("T19c 読めた後は、取り込まない次のページでも足した語を送る", c19 === "quota", c19);

    // ---- T20（決めた形を留める）: 送ってある語（甲）に答えて送る前に、ほかの端末がその語を消して同じ英語を違う訳（丁）で足し直した（墓標を送った後なので英語の鍵）
    // → 新しい語（丁）は両方の端末に残り、答えた前の語（甲）も別の鍵で戻る（消える語は無い。戻るのは残る物: docs/SPEC_MY_WORDS.md §18.6） ----
    const t20 = [];
    for (const answerFirst of [true, false]) {
      reset(true);
      at(1, 8); use("p20"); M.addMyWord("lead", "試しの訳 甲"); await push("p20");
      at(1, 9); await sync("c20");
      if (answerFirst) { at(2, 9); use("c20"); M.recordMyAnswer("lead", ANSWER_KINDS.exact); } // 消す前に答えた（送っていない）
      at(2, 10); use("p20"); M.removeMyWord("lead", "word"); await push("p20");
      at(2, 11); use("p20"); M.addMyWord("lead", "試しの訳 丁"); await push("p20");
      if (!answerFirst) { at(2, 12); use("c20"); M.recordMyAnswer("lead", ANSWER_KINDS.exact); } // 足し直した後に、前に開いたタブで答えた
      at(3, 9); await sync("c20"); at(3, 10); await sync("p20"); at(3, 11); await sync("c20");
      t20.push(["p20", "c20"].map((n) => cardsOf(n, "lead").map((w) => `${w.ja}|s${C.myStateOf(w)}`).sort().join(",")).join("/"));
    }
    // Batch 95 の設計: 前の語（甲）は雲に入った語（印 merged で見分ける）なので、消す前の答え（送れていない）は T21c と同じく新しい墓標が勝ち、甲 は消える。
    // 消した後の答えは新しい方が勝ち、甲 が戻る。足し直した 丁 はどちらでも両方の端末に残る（K1: 墓標の鍵を使わず、次の取り込みで新しい鍵へ移る）
    ok("T20 送ってある語に答えて送る前に、ほかの端末で消して違う訳で足し直した → 新しい語（丁）は両方の端末に残る。前の語（甲）は消した後に答えたときだけ戻る（消す前の答えは T21c と同じく墓標が勝つ）",
      JSON.stringify(t20) === JSON.stringify(["試しの訳 丁|s0/試しの訳 丁|s0", "試しの訳 丁|s0,試しの訳 甲|s2/試しの訳 丁|s0,試しの訳 甲|s2"]), JSON.stringify(t20));

    // ===== Batch 94 の直し: T21（雲の新しい墓標と、この端末の送っていない違うカード。docs/SPEC_MY_WORDS.md §18.10） =====
    // 雲の墓標の中身は空なので、どのカードを消したかは分からない。ほかの端末が見られなかった語（この端末が一度も取り込んでいない・最後の取り込みの後に足した語）は
    // 墓標が新しくても消さず、同じ鍵の違うカード（A2）と同じに別の鍵へ移して残す。最後の取り込みのときに端末にあった語（ほかの端末が見られた語）は今どおり新しい方が勝つ
    const keyDing = `lead~${C.jaHash("試しの訳 丁", 8)}`;
    const leadOn = (name) => cardsOf(name, "lead").map((w) => `${w.en}|${w.ja}|s${C.myStateOf(w)}`).sort().join(",");
    const want21 = `${keyDing}|試しの訳 丁|s2`;
    // ---- T21a: 電話（ログイン）が lead=甲 を足して送る。PC はゲストで lead=丁 を足して 覚えた。電話が自分の lead（甲）を消して墓標を送った後に、PC が「はい」→ PC の 丁 は消えない ----
    reset(true);
    at(1, 8); await sync("p21a"); use("p21a"); M.addMyWord("lead", "試しの訳 甲"); await push("p21a");
    at(1, 20); use("c21a"); M.addMyWord("lead", "試しの訳 丁"); at(1, 21); M.recordMyAnswer("lead", ANSWER_KINDS.exact); // ゲストで足して 覚えた
    at(2, 9); use("p21a"); M.removeMyWord("lead", "word"); await push("p21a"); // 電話は自分の 甲 を消した（墓標を送った）
    at(2, 20); await sync("c21a"); // ログインして「はい」: この端末の初めての同期
    at(3, 9); await sync("p21a"); at(3, 10); await sync("c21a");
    ok("T21a 電話が自分の違うカード（lead=甲）を消して墓標を送った後に、PC がゲストの 覚えた lead=丁 を持って「はい」→ 丁 は PC と電話に 覚えた で残る（別の鍵）・甲 は戻らない",
      leadOn("p21a") === want21 && leadOn("c21a") === want21 && tomb18("lead"), JSON.stringify({ phone: leadOn("p21a"), pc: leadOn("c21a"), lead: sky.get("my_word:lead") }));
    // ---- T21b: PC（ログイン）は取り込んだ後のタブで lead=丁 を足して 覚えた（送れていない）。そのあいだに電話が lead=甲 を足して送り、消して墓標を送った → PC の次のタブで 丁 は消えない ----
    reset(true);
    at(1, 9); await sync("c21b"); // PC のタブ: 取り込む（雲は空）
    at(1, 10); await sync("p21b"); use("p21b"); M.addMyWord("lead", "試しの訳 甲"); await push("p21b");
    at(1, 11); use("c21b"); M.addMyWord("lead", "試しの訳 丁"); at(1, 12); M.recordMyAnswer("lead", ANSWER_KINDS.exact); // 同じタブ（取り込まない）・送れなかった
    at(2, 9); use("p21b"); M.removeMyWord("lead", "word"); await push("p21b");
    at(2, 20); await sync("c21b"); at(3, 9); await sync("p21b"); at(3, 10); await sync("c21b");
    ok("T21b PC が最後の取り込みの後に足して 覚えた lead=丁（送れていない）は、電話が自分の lead=甲 を消した墓標で消えない（別の鍵で PC と電話に残る）",
      leadOn("p21b") === want21 && leadOn("c21b") === want21 && tomb18("lead"), JSON.stringify({ phone: leadOn("p21b"), pc: leadOn("c21b"), lead: sky.get("my_word:lead") }));
    // ---- T21c（守り）: (1) 取り込んだ語（ほかの端末が見られた語）に答えて送る前に、ほかの端末がその語を消した → 今どおり墓標が勝つ（PC からも消え、~ の鍵を作らない）
    // (2) 足した時刻の無い語（とても古い語）も、取り込んだことのある端末では今どおり墓標が勝つ ----
    const c21 = [];
    reset(true);
    at(1, 8); await sync("p21c"); use("p21c"); M.addMyWord("lead", "試しの訳 甲"); await push("p21c");
    at(1, 9); await sync("c21c"); // PC が 甲 を取り込んだ
    at(1, 10); use("c21c"); M.recordMyAnswer("lead", ANSWER_KINDS.exact); // 答えた（送れていない）
    at(2, 9); use("p21c"); M.removeMyWord("lead", "word"); await push("p21c");
    at(2, 20); await sync("c21c"); at(3, 9); await sync("p21c");
    const moved21 = () => [...sky.keys()].filter((k) => k.startsWith("my_word:lead~")).length;
    c21.push(`${leadOn("p21c") || "-"}/${leadOn("c21c") || "-"}/${tomb18("lead") ? "墓標" : "生"}/${moved21()}`);
    reset(true);
    at(1, 9); await sync("z21c"); // 取り込んだことのある端末（雲は空）
    use("z21c"); localStorage.setItem("spelldash_my_words", JSON.stringify([{ en: "lead", ja: "試しの訳 古" }])); U.touchItem("my_word", "lead", false, iso(1, 10)); // 足した時刻の無い語（送る待ち）
    sky.set("my_word:lead", { user_id: "u1", kind: "my_word", key: "lead", payload: {}, deleted: true, updated_at: iso(2, 9) });
    at(2, 20); await sync("z21c");
    c21.push(`${leadOn("z21c") || "-"}/${tomb18("lead") ? "墓標" : "生"}/${moved21()}`);
    ok("T21c 取り込んだ語・足した時刻の無い語は、答えて送る前にほかの端末が消すと今どおり消える（~ の鍵を作らない）",
      JSON.stringify(c21) === JSON.stringify(["-/-/墓標/0", "-/墓標/0"]), JSON.stringify(c21));
  } finally {
    globalThis.Date = RealDate;
  }
}

// ===== Batch 95 T22〜T46: 送る前に雲を読む（docs/SPEC_MY_WORDS.md §18.11。js/userItemsSync.js pullUserItems・pushUserItems・js/myWords.js の足す道と消す道） =====
// 本物の取り込み・送り・足す道・消す道・答えの書き手を、T14〜T21 と同じ形の道具で動かす: 偽の時計（端末ごとにずらせる。new Date() のたびに 1 ms 進む）・
// 端末ごとの保存・偽の雲（本物の表と同じく墓標の中身を空にし、鍵の並びの読みと「無いときだけ書く」送りに答える）。偽の雲には次の 2 つを足した:
//   hold(種類): その種類の次の要求をあとで返す（読みは要求の時の雲の答えを後で届ける。書きは後で書く）。ページが止まった形
//   lose(n): 次の n 回の書きは雲に書くが、答えを落とす（通信が切れた形）
//   noRows(n): 次の n 回の「無いときだけ書く」書きは、書いても答えに行を返さない（答えの data が配列でない形。T44）
// 種類: wordRead（語の鍵の並びの読み）・dayRead（日の行の読み）・range（全部の読み）・upsert（書き）。端末: P = 電話・C = パソコン・T = 3 台目。語と訳は試しの物だけ。
// 読みの答えは本物の表の形（dbRow: updated_at は表の時刻の文字・payload の鍵は jsonb の並び）
{
  const U = await import("../js/userItemsSync.js");
  const M = await import("../js/myWords.js");
  const RealDate = Date;
  const MIN = 60000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const D0 = new RealDate(2026, 10, 16, 9, 0).getTime(); // 1 日目の 9 時
  const clock = { now: D0, skew: {}, cur: null };
  const nowOf = () => clock.now + (clock.skew[clock.cur] ?? 0);
  globalThis.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else { super(nowOf()); clock.now += 1; } } static now() { return nowOf(); } };
  const at = (n, h = 9, m = 0) => (clock.now = D0 + (n - 1) * DAY + (h - 9) * HOUR + m * MIN);
  const iso = (n, h = 9, m = 0) => new RealDate(D0 + (n - 1) * DAY + (h - 9) * HOUR + m * MIN).toISOString();
  const dayNo = (n) => learnDayOf(D0 + (n - 1) * DAY);
  const storeOf = (map = new Map()) => ({ getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), clear: () => map.clear(), key: (i) => [...map.keys()][i] ?? null, get length() { return map.size; } });
  const devices = {};
  const use = (name) => { clock.cur = name; return (globalThis.localStorage = devices[name] ??= storeOf()); };
  const sky = new Map();
  const st = { hold: [], held: [], lose: 0, noRows: 0, failReads: 0, cap: 0, missing: false, reqs: { wordRead: 0, dayRead: 0, range: 0, upsert: 0 }, upserts: [] };
  const copy = (v) => JSON.parse(JSON.stringify(v));
  // failReads（Batch 95 の直し）: 次の n 回の読み（どの種類も）は通信の失敗で答える（圏外の形）
  const readFails = () => (st.failReads > 0 ? (st.failReads--, Promise.resolve({ data: null, error: { message: "fetch failed" }, status: 503 })) : missingAns());
  // missing（Batch 95 の直し）: 表がまだ無い（本番の今。読み・書きとも 404・42P01 で答える）
  const missingAns = () => (st.missing ? Promise.resolve({ data: null, error: { code: "42P01", message: "relation does not exist" }, status: 404 }) : null);
  // 要求をあとで返す（読みは今の雲の答えを後で届ける。書きは後で書く）
  const defer = (kind, fn) => {
    const i = st.hold.indexOf(kind);
    if (i < 0) return Promise.resolve(fn());
    st.hold.splice(i, 1);
    let resolve;
    const p = new Promise((r) => (resolve = r));
    const snap = kind === "upsert" ? null : fn();
    st.held.push({ kind, dev: clock.cur, release: () => resolve(kind === "upsert" ? fn() : snap) });
    return p;
  };
  const client = { from() {
    const f = {};
    const q = {
      select: () => q, order: () => q,
      eq: (c, v) => ((f[c] = v), q),
      in: (c, vs) => ((f[`in:${c}`] = vs), q),
      then: (ok, bad) => {
        const kind = f.kind === "day" ? "dayRead" : "wordRead";
        st.reqs[kind]++;
        const down = readFails();
        if (down) return down.then(ok, bad);
        return defer(kind, () => { const want = new Set(f["in:key"] ?? []); return { data: [...sky.values()].filter((r) => r.kind === f.kind && want.has(r.key)).map((r) => dbRow(copy(r))), error: null, status: 200 }; }).then(ok, bad);
      },
      range: (a, b) => {
        st.reqs.range++;
        const down = readFails();
        if (down) return down;
        return defer("range", () => { const all = [...sky.values()].sort((x, y) => (`${x.kind}\u0000${x.key}` < `${y.kind}\u0000${y.key}` ? -1 : 1)).map((r) => dbRow(copy(r))); return { data: all.slice(a, b + 1), count: all.length, error: null, status: 200 }; });
      },
      upsert: (rows, opts) => {
        st.reqs.upsert++;
        const sent = copy(rows);
        const ignore = !!opts?.ignoreDuplicates;
        let cols = null;
        let p = st.missing ? missingAns() : null;
        const run = () => (p ??= defer("upsert", () => {
          st.upserts.push({ ignore, rows: sent });
          // cap（Batch 95 の直し）: 表の守りの「消していない語の上限」（docs/SQL_USER_ITEMS.md §4。本物は 1,000 語）。行を順に見て、語が増える行で上限に
          // 届いていれば文ごと断る（400・23514。1 行も書かない）。同じ文の前の行（墓標）が減らした数は数える
          if (st.cap > 0) {
            const t = new Map(sky);
            for (const r of sent) {
              const id = `${r.kind}:${r.key}`;
              const old = t.get(id);
              if (ignore && old) continue;
              const more = r.kind === "my_word" && !r.deleted && !(old?.kind === "my_word" && !old.deleted);
              if (more && [...t.values()].filter((x) => x.kind === "my_word" && !x.deleted).length >= st.cap) return { data: null, error: { code: "23514", message: "user_items too many words" }, status: 400 };
              t.set(id, r);
            }
          }
          const wrote = [];
          for (const r of sent) {
            const id = `${r.kind}:${r.key}`;
            if (ignore && sky.has(id)) continue;
            sky.set(id, { ...r, payload: r.deleted ? {} : r.payload });
            wrote.push({ kind: r.kind, key: r.key });
          }
          if (st.lose > 0) { st.lose--; return null; } // 書いたが答えが届かない
          if (ignore && st.noRows > 0) { st.noRows--; return { data: null, error: null, status: 201 }; } // 書いたが答えに行が無い
          return { data: cols ? wrote : null, error: null, status: 201 };
        }).then((r) => r ?? Promise.reject(new Error("network connection lost"))));
        const w = { select: (c) => ((cols = c ?? "*"), w), then: (ok, bad) => run().then(ok, bad) };
        return w;
      }
    };
    return q;
  } };
  const tick = () => new Promise((r) => setImmediate(r));
  const settleTicks = async () => { for (let k = 0; k < 30; k++) await tick(); };
  // 止めた要求を 1 つ返し、そのページの処理を次の止まる所か終わりまで進める（止めた要求が無ければ止める印を外すだけ: 読みの無い木）
  const release = async (kind) => {
    const i = st.held.findIndex((h) => h.kind === kind);
    if (i < 0) { const j = st.hold.indexOf(kind); if (j >= 0) st.hold.splice(j, 1); return false; }
    const [h] = st.held.splice(i, 1);
    use(h.dev);
    h.release();
    await settleTicks();
    return true;
  };
  const pull = (name) => (use(name), U.pullUserItems(client, "u1", { now: nowOf() }));
  const push = (name) => (use(name), U.pushUserItems(client, "u1", { now: nowOf() }));
  // 送り・取り込みを始め、止めた要求か終わりまで進める（戻り値の done で終わりを待つ）
  const pushStart = async (name) => { use(name); const done = U.pushUserItems(client, "u1", { now: nowOf() }).catch((e) => e); await settleTicks(); return { done }; };
  const pullStart = async (name) => { use(name); const done = U.pullUserItems(client, "u1", { now: nowOf() }).catch((e) => e); await settleTicks(); return { done }; };
  const sync = async (name) => { await pull(name); await push(name); }; // 新しいタブ（取り込み → 送る）
  const settle = async (names, rounds = 2) => { for (let r = 0; r < rounds; r++) for (const n of names) { clock.now += MIN; await sync(n); } };
  const reset = () => { for (const k of Object.keys(devices)) delete devices[k]; sky.clear(); st.hold.length = 0; st.held.length = 0; st.lose = 0; st.noRows = 0; st.failReads = 0; st.cap = 0; st.missing = false; st.upserts.length = 0; for (const k of Object.keys(st.reqs)) st.reqs[k] = 0; clock.skew = {}; };
  const all = (name) => (use(name), JSON.parse(localStorage.getItem("spelldash_my_words") || "[]"));
  const wordsOf = (name) => all(name).filter((w) => C.isWordEntry(w));
  const metaOf = (name) => (use(name), JSON.parse(localStorage.getItem("spelldash_user_items_meta") || "{}"));
  const dirtyOf = (name) => (use(name), JSON.parse(localStorage.getItem("spelldash_user_items_dirty") || "[]")).filter((id) => id.startsWith("my_word:"));
  const short = (ja) => String(ja).replace("試しの訳 ", "");
  const show = (w) => `${w.en}=${short(w.ja)}[s${C.myStateOf(w)}${Number.isInteger(w.lf) ? `,lf${w.lf}` : ""}]`;
  const view = (name) => wordsOf(name).map(show).sort().join(" ");
  const cloudView = () => [...sky.values()].filter((r) => r.kind === "my_word").map((r) => (r.deleted ? `${r.key}=(del)` : show(r.payload))).sort().join(" ");
  // 答えの英語 en・訳 ja の語（どの鍵でも）の 3 状態。無ければ "-"
  const stateOf = (name, en, ja) => { const w = wordsOf(name).find((x) => C.answerKeyOf(x) === en && short(x.ja) === ja); return w ? `s${C.myStateOf(w)}` : "-"; };
  const keyOf = (name, en, ja) => wordsOf(name).find((x) => C.answerKeyOf(x) === en && short(x.ja) === ja)?.en ?? null;
  const liveJa = (en) => [...sky.values()].filter((r) => r.kind === "my_word" && !r.deleted && C.answerKeyOf(r.payload) === en).map((r) => short(r.payload.ja)).sort().join(",");
  // セットの終わり（js/dailySet.js と同じく今日の日の行を送る待ちに入れる: 送りは日の行を先に読む）
  const setEnd = (name) => {
    use(name);
    const d = new Date(nowOf());
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const s = JSON.parse(localStorage.getItem("spelldash_daily_set") || "{}");
    const history = Array.isArray(s.history) ? s.history : [];
    if (!history.includes(date)) history.push(date);
    localStorage.setItem("spelldash_daily_set", JSON.stringify({ ...s, history, setsToday: (s.setsTodayDate === date ? s.setsToday || 0 : 0) + 1, setsTodayDate: date }));
    U.touchItem("day", date);
  };
  const answer = (name, en, kind = ANSWER_KINDS.exact, times = 1) => { use(name); let done = true; for (let i = 0; i < times; i++) { done = M.recordMyAnswer(en, kind) && done; clock.now += 1000; } return done; };
  const hash = (ja, n = 8) => C.jaHash(ja, n);
  try {
    // ---- T22（S1）: 電話のセットの終わりの送りが日の行の読みで止まる（電話を閉じた）→ その間に PC が同じ英語の違う訳 乙 を足して 覚えた で送る →
    // 電話が 12 時に戻る → 電話が 甲 を消して送る → PC の新しいタブ。止まった電話の古い合わせを送らないので、両方の端末に 乙（覚えた）が残る ----
    reset(); at(1, 9); await sync("P"); await sync("C");
    at(1, 9, 10); use("P"); M.addMyWord("lead", "試しの訳 甲"); answer("P", "lead", ANSWER_KINDS.exact, 3); setEnd("P");
    st.hold.push("dayRead"); const p22 = await pushStart("P");
    at(1, 10); use("C"); M.addMyWord("lead", "試しの訳 乙"); answer("C", "lead", ANSWER_KINDS.exact, 3); setEnd("C"); await push("C");
    at(1, 12); await release("dayRead"); await p22.done;
    at(1, 13); use("P"); M.removeMyWord(keyOf("P", "lead", "甲") ?? "lead", "word"); setEnd("P"); await push("P");
    at(1, 14); await sync("C"); await settle(["P", "C"]);
    ok("T22 止まったページ: 電話の送りが日の行の読みで止まった間に PC が lead=乙 を 覚えた で送る → 電話が戻って 甲 を消す → 両方の端末に 乙（覚えた）が残り、甲 はどこにも無い",
      stateOf("P", "lead", "乙") === "s2" && stateOf("C", "lead", "乙") === "s2" && stateOf("P", "lead", "甲") === "-" && !liveJa("lead").includes("甲"), JSON.stringify({ P: view("P"), C: view("C"), cloud: cloudView() }));

    // ---- T23（S1r）: 電話が凧に答えてセットの終わりの送りが止まる → PC が凧を消して送る → 電話が戻る。止まった電話の古い合わせで凧を戻さない ----
    reset(); at(1, 9); await sync("P"); await sync("C");
    use("C"); M.addMyWord("kite", "試しの訳 凧"); setEnd("C"); await push("C");
    at(1, 9, 5); await sync("P");
    at(1, 9, 10); answer("P", "kite", ANSWER_KINDS.exact, 2); setEnd("P");
    st.hold.push("dayRead"); const p23 = await pushStart("P");
    at(1, 10); await sync("C"); use("C"); M.removeMyWord("kite", "word"); setEnd("C"); await push("C");
    at(1, 12); await release("dayRead"); await p23.done;
    await settle(["P", "C"]);
    ok("T23 止まったページで消しが戻らない: PC が消した凧は、止まっていた電話の送りの後も両方の端末に無く、雲は墓標",
      view("P") === "" && view("C") === "" && sky.get("my_word:kite")?.deleted === true, JSON.stringify({ P: view("P"), C: view("C"), cloud: cloudView() }));

    // ---- T24: 電話が lead=甲 を足して送る（書きの要求が遅れて届く）→ その間に PC が lead=乙 を足して 覚えた で送る → 電話の書きが届く。
    // 電話の書きは読んだときに行の無かった鍵への「無いときだけ書く」なので、PC の 乙 を上書きしない（次の送りで 甲 は lead~<印> へ）。
    // (a) その後に電話が 甲 を消す → 乙 が残る (b) 消さない → 両方残る ----
    const t24 = [];
    for (const del of [true, false]) {
      reset(); at(1, 9); await sync("P"); await sync("C");
      at(1, 9, 10); use("P"); M.addMyWord("lead", "試しの訳 甲"); setEnd("P");
      st.hold.push("upsert"); const p24 = await pushStart("P");
      at(1, 9, 11); use("C"); M.addMyWord("lead", "試しの訳 乙"); answer("C", "lead", ANSWER_KINDS.exact, 3); setEnd("C"); await push("C");
      at(1, 9, 12); await release("upsert"); await p24.done;
      const afterWrite = sky.get("my_word:lead")?.payload?.ja ?? null;
      at(1, 10); use("P");
      if (del) { M.removeMyWord(keyOf("P", "lead", "甲") ?? "lead", "word"); setEnd("P"); }
      await push("P");
      at(1, 11); await settle(["P", "C"]);
      t24.push({ del, afterWrite: afterWrite && short(afterWrite), P: view("P"), C: view("C"), cloud: cloudView() });
    }
    ok("T24 同時に新しい鍵: 電話の遅れた書きは PC の lead=乙 を上書きしない。(a) 電話が 甲 を消しても PC の 覚えた 乙 は両方に残る (b) 消さなければ 甲 と 乙 が両方に残る",
      t24[0].afterWrite === "乙" && t24[1].afterWrite === "乙" && t24[0].P === t24[0].C && /=乙\[s2/.test(t24[0].C) && !/=甲/.test(t24[0].C) &&
      t24[1].P === t24[1].C && /=乙\[s2/.test(t24[1].C) && /lead~[0-9a-f]+=甲/.test(t24[1].C), JSON.stringify(t24));

    // ---- T25（守り。S2）: 書けたが答えが落ちた送り → 次の送りで雲を 1 回読み、同じ版なので送る待ちから外す → PC が消す → 次の日に両方開く → 消しが届く ----
    reset(); at(1, 9); await sync("P"); await sync("C");
    at(1, 9, 10); use("P"); M.addMyWord("kite", "試しの訳 凧"); answer("P", "kite", ANSWER_KINDS.exact, 3); setEnd("P");
    st.lose = 1; await push("P").catch(() => {});
    for (let i = 0; i < 5; i++) { at(1, 10 + i); setEnd("P"); await push("P"); }
    const left25 = dirtyOf("P");
    at(1, 16); await sync("C"); use("C"); M.removeMyWord("kite", "word"); setEnd("C"); await push("C");
    at(2, 9); await sync("P"); at(2, 10); await sync("C"); await settle(["P", "C"]);
    ok("T25 答えが届かなかった送り: 次の送りで送る待ちから外れ、その後の PC の消しが両方の端末に届く（凧が別の鍵で戻らない）",
      left25.length === 0 && view("P") === "" && view("C") === "" && liveJa("kite") === "", JSON.stringify({ left25, P: view("P"), C: view("C"), cloud: cloudView() }));

    // ---- T26: 同じ時刻の違う中身。電話が 1 日目・PC が 2 日目に 覚えた（どちらも送らない）→ 3 台目が 3 日目に 覚えた で送る → 電話の取り込みの読みの答えを遅らせ、
    // その間に PC が読んで合わせて送る → 電話も同じ行と合わせて送る（どちらも「雲の時刻 + 1 ms」の同じ時刻で、lf が違う）→ 何巡かで全部の端末の lf が 1 日目に揃い、
    // 最後の巡りでは語の行を送らない（行ったり来たりしない） ----
    reset(); at(1, 9); await sync("P"); await sync("C"); await sync("T");
    use("P"); M.addMyWord("kite", "試しの訳 凧"); setEnd("P"); await push("P"); await sync("C"); await sync("T");
    at(1, 10); answer("P", "kite", ANSWER_KINDS.exact, 3);
    at(2, 10); answer("C", "kite", ANSWER_KINDS.exact, 3);
    at(3, 12); answer("T", "kite", ANSWER_KINDS.exact, 3); setEnd("T"); await push("T");
    at(3, 13); st.hold.push("range"); const p26 = await pullStart("P");
    await pull("C");
    await release("range"); await p26.done;
    const rounds26 = [];
    for (let r = 0; r < 4; r++) {
      const from = st.upserts.length;
      for (const d of ["C", "P", "T"]) { clock.now += MIN; await sync(d); }
      rounds26.push(st.upserts.slice(from).flatMap((u) => u.rows).filter((x) => x.kind === "my_word").length);
    }
    const lf26 = ["P", "C", "T"].map((d) => wordsOf(d).find((w) => w.en === "kite")?.lf ?? null);
    ok("T26 同じ時刻の違う中身: 電話・PC・3 台目の kite の lf が全部 1 日目に揃い、最後の巡りで語の行を送らない",
      lf26.every((x) => x === dayNo(1)) && rounds26[rounds26.length - 1] === 0, JSON.stringify({ lf26, want: dayNo(1), rounds26, P: view("P"), C: view("C"), T: view("T") }));

    // ---- T27（S3）: 電話が lead を消して送る → 同じタブで lead=乙 を足して答える → 最初のセットの終わりで lead~<印>=乙 が雲に入る（lead は墓標のまま）→
    // PC が取り込める。電話の鍵は次に開いたページで移る ----
    reset(); at(1, 9); await sync("P"); await sync("C");
    use("P"); M.addMyWord("lead", "試しの訳 甲"); setEnd("P"); await push("P");
    at(1, 9, 30); use("P"); M.removeMyWord("lead", "word"); setEnd("P"); await push("P");
    at(1, 10); use("P"); M.addMyWord("lead", "試しの訳 乙"); answer("P", "lead", ANSWER_KINDS.exact, 3);
    at(1, 11); answer("P", keyOf("P", "lead", "乙"), ANSWER_KINDS.exact, 1); setEnd("P"); await push("P");
    const k27 = `lead~${hash("試しの訳 乙")}`;
    const first27 = { lead: sky.get("my_word:lead")?.deleted === true, alias: sky.get(`my_word:${k27}`)?.payload ? show(sky.get(`my_word:${k27}`).payload) : null };
    at(1, 21); await sync("C");
    const pc27 = view("C");
    at(2, 9); await sync("P");
    ok("T27 足し直しが同じタブで届く: 最初のセットの終わりで lead~<印>=乙（覚えた）が雲に入り lead は墓標のまま・PC が取り込む・電話は次のページで同じ鍵へ移る",
      first27.lead && first27.alias === `${k27}=乙[s2,lf${dayNo(1)}]` && pc27 === `${k27}=乙[s2,lf${dayNo(1)}]` && view("P") === pc27, JSON.stringify({ first27, pc27, P: view("P"), cloud: cloudView() }));

    // ---- T28（守り。S4）: 1 台の 2 つのタブ。タブ 2 の送りの読みの答えが遅れて届く間に、タブ 1 が凧を消して送る → 凧は消えたまま（遅れた古い読みで戻さない） ----
    reset(); at(1, 9); await sync("P"); await sync("C");
    use("P"); M.addMyWord("kite", "試しの訳 凧"); answer("P", "kite", ANSWER_KINDS.exact, 3); setEnd("P"); await push("P"); await sync("C");
    at(1, 10); use("P"); M.removeMyWord("kite", "word");
    st.hold.push("wordRead"); const p28 = await pushStart("P"); // タブ 2
    await push("P"); // タブ 1
    await release("wordRead"); await p28.done;
    const race28 = view("P");
    at(1, 10, 5); const k28 = keyOf("P", "kite", "凧"); if (k28) answer("P", k28, ANSWER_KINDS.exact, 1); setEnd("P"); await push("P");
    await settle(["P", "C"]);
    ok("T28 2 つのタブ: ほかのタブの遅れた読みで、消した凧が戻らない（電話・PC とも無く、雲は墓標）",
      race28 === "" && view("P") === "" && view("C") === "" && sky.get("my_word:kite")?.deleted === true, JSON.stringify({ race28, P: view("P"), C: view("C"), cloud: cloudView() }));

    // ---- T29（S5）: 時計が 5 分遅い電話。PC が凧に答えて送る → 電話が取り込んで 2 分後に消す → 消しが届く（揃えても凧は戻らない） ----
    reset(); clock.skew.P = -5 * MIN; at(1, 9); await sync("P"); await sync("C");
    use("C"); M.addMyWord("kite", "試しの訳 凧"); setEnd("C"); await push("C");
    at(1, 9, 30); await sync("P");
    at(1, 10); answer("C", "kite", ANSWER_KINDS.exact, 1); setEnd("C"); await push("C");
    at(1, 10, 1); await sync("P");
    at(1, 10, 2); use("P"); M.removeMyWord("kite", "word"); setEnd("P"); await push("P");
    const after29 = view("P");
    await settle(["P", "C"]);
    ok("T29 時計が 5 分遅い端末の消し: 消した直後も揃えた後も凧は戻らない（電話・PC とも無く、雲は墓標）",
      after29 === "" && view("P") === "" && view("C") === "" && sky.get("my_word:kite")?.deleted === true, JSON.stringify({ after29, P: view("P"), C: view("C"), cloud: cloudView() }));

    // ---- T30（守り。S6）: 電話が自分の lead=甲 を消して送る → 時計が 10 分戻る → lead=乙 を足して 覚えた → 送っても 乙 は消えず、PC にも届く ----
    reset(); at(1, 9); await sync("P"); await sync("C");
    use("C"); M.addMyWord("lead", "試しの訳 甲"); setEnd("C"); await push("C");
    at(1, 10); await sync("P"); use("P"); M.removeMyWord("lead", "word"); setEnd("P"); await push("P");
    at(1, 10, 2); clock.skew.P = -10 * MIN; use("P"); M.addMyWord("lead", "試しの訳 乙"); answer("P", "lead", ANSWER_KINDS.exact, 3);
    at(1, 10, 4); setEnd("P"); await push("P");
    const after30 = stateOf("P", "lead", "乙");
    clock.skew.P = 0; await settle(["P", "C"]);
    ok("T30 時計が戻った後に足した語: 送っても 乙（覚えた）は消えず、電話と PC に残る",
      after30 === "s2" && stateOf("P", "lead", "乙") === "s2" && stateOf("C", "lead", "乙") === "s2", JSON.stringify({ after30, P: view("P"), C: view("C"), cloud: cloudView() }));

    // ---- T31: 送った墓標の印。1,000 語を足して送り、全部消して送る → (1) 送った直後は鍵ごとに { updatedAt, deleted, sentAt } だけが残る
    // (2) 送ってから READ_FRESH_MS + 5 秒の後の送り（1 語を足してすぐ消した）で、印は雲と合わせた印だけ（44 バイト）に戻る ----
    reset(); at(1, 9); use("P"); localStorage.setItem("spelldash_plan", JSON.stringify({ status: "active", interval: "month", periodEnd: null })); await sync("P");
    const lines31 = Array.from({ length: 1000 }, (_, i) => `term${String(i).padStart(4, "0")}x, 試しの訳 印${i}`).join("\n");
    at(1, 10); use("P"); const added31 = M.addMyWordsBulk(lines31).added?.length ?? 0; await push("P");
    at(1, 11); use("P"); M.removeMyWords(M.getMyWords().map(C.entryRefOf)); await push("P");
    const marks31 = Object.entries(metaOf("P")).filter(([k]) => k.startsWith("my_word:"));
    const shape31 = marks31.length === 1000 && marks31.every(([, m]) => JSON.stringify(Object.keys(m).sort()) === '["deleted","sentAt","updatedAt"]' && m.deleted === true);
    clock.now += (U.READ_FRESH_MS ?? 20000) + 6000;
    use("P"); M.addMyWord("term9999x", "試しの訳 印の後"); M.removeMyWord("term9999x", "word"); await push("P");
    const meta31 = localStorage.getItem("spelldash_user_items_meta") ?? "";
    ok("T31 (1) 1,000 語を送って消して送った直後は、鍵ごとに { updatedAt, deleted, sentAt } の印だけ（消したカードは持たない）",
      added31 === 1000 && shape31, JSON.stringify({ added31, n: marks31.length, sample: marks31[0] ?? null }));
    ok("T31 (2) READ_FRESH_MS + 5 秒の後の送りで、送った墓標の印は外れ、印は雲と合わせた印だけ（44 バイト）",
      meta31.length === 44 && Object.keys(JSON.parse(meta31 || "{}")).join() === "merged", JSON.stringify({ bytes: meta31.length, keys: Object.keys(JSON.parse(meta31 || "{}")).slice(0, 3) }));

    // ---- T32: 候補が尽きた語。雲で lead と lead=乙 の鍵の候補 6 つ（<印 8・16・24・32 桁>・-2・-3）が全部ふさがっている（ほかの端末が足して消した墓標）→
    // 電話が lead=乙 を足して送る → 送りでは雲の行を 1 つも書かずに待つ → 新しいタブの取り込みで空いた鍵へ移って送る（消えない）----
    reset(); at(1, 9); await sync("P"); await sync("C");
    const h32 = hash("試しの訳 乙", 32);
    const taken32 = ["lead", ...[8, 16, 24, 32].map((n) => `lead~${h32.slice(0, n)}`), `lead~${h32}-2`, `lead~${h32}-3`];
    for (const k of taken32) sky.set(`my_word:${k}`, { user_id: "u1", kind: "my_word", key: k, payload: {}, deleted: true, updated_at: iso(1, 9, 30) });
    at(1, 10); use("P"); M.addMyWord("lead", "試しの訳 乙"); answer("P", "lead", ANSWER_KINDS.exact, 3); setEnd("P"); await push("P");
    const kept32 = taken32.every((k) => sky.get(`my_word:${k}`)?.deleted === true) && stateOf("P", "lead", "乙") === "s2";
    at(1, 11); await sync("P"); at(1, 12); await sync("C");
    const k32 = keyOf("P", "lead", "乙");
    ok("T32 候補が尽きた語: 送りでは墓標の鍵を書かずに待ち、次のタブで空いた鍵へ移って送る（電話と PC に 乙 が 覚えた で残る）",
      kept32 && !!k32 && !taken32.includes(k32) && sky.get(`my_word:${k32}`)?.deleted === false && stateOf("P", "lead", "乙") === "s2" && stateOf("C", "lead", "乙") === "s2",
      JSON.stringify({ kept32, k32, P: view("P"), C: view("C"), cloud: cloudView() }));

    // ---- T33（S11 の 3 通り）: 2 つの開いたままのタブで同じ英語・違う訳。電話が lead=甲 を足して送る → PC（電話の行を読んでいない）が lead=乙 を足す
    // （V1 答えて送る・V2 答えて送らない・V3 答えずに送る）→ 電話が 甲 を消す → PC の 乙 はどの通りでも両方の端末に残る ----
    const t33 = [];
    for (const v of ["V1", "V2", "V3"]) {
      reset(); at(1, 9); await sync("P"); await sync("C");
      at(1, 9, 10); use("P"); M.addMyWord("lead", "試しの訳 甲"); setEnd("P"); await push("P");
      at(1, 9, 20); use("C"); M.addMyWord("lead", "試しの訳 乙"); if (v !== "V3") answer("C", "lead", ANSWER_KINDS.exact, 3);
      if (v !== "V2") { setEnd("C"); await push("C"); }
      at(1, 10); use("P"); M.removeMyWord(keyOf("P", "lead", "甲") ?? "lead", "word"); setEnd("P"); await push("P");
      at(1, 10, 30); setEnd("C"); await push("C");
      at(1, 11); await sync("C"); await settle(["P", "C"]);
      const want = v === "V3" ? "s0" : "s2";
      t33.push({ v, ok: stateOf("P", "lead", "乙") === want && stateOf("C", "lead", "乙") === want && stateOf("P", "lead", "甲") === "-", P: view("P"), C: view("C") });
    }
    ok("T33 2 つの開いたままのタブで同じ英語・違う訳（3 通り）: 電話が自分の 甲 を消しても、PC の 乙 は両方の端末に残る（答えた通りは 覚えた のまま）",
      t33.every((x) => x.ok), JSON.stringify(t33));

    // ---- T34（ページが止まる組の種 3758 の形）: 雲に PC の lead=甲。電話が lead=乙 を足して 覚えた にして送る（雲の別の鍵 lead~<印 8> へ。書きを遅らせる）→
    // その間に PC が同じ組 乙 を足して同じ鍵 lead~<印 8> へ送る → 電話の書きが届く（PC の行があるので書かれない）→ 電話の次の送りで同じカードとして合わさり、
    // 待たせた語の印の足した時刻が雲の足した時刻になる → 電話の新しいタブで lead~<印 8> に 1 つだけ（lead に 乙 の写しが残らない）・電話の答えの 3 状態は残る ----
    reset(); at(1, 9); await sync("P"); await sync("C");
    at(1, 9, 5); use("C"); M.addMyWord("lead", "試しの訳 甲"); setEnd("C"); await push("C");
    at(1, 9, 10); use("P"); M.addMyWord("lead", "試しの訳 乙"); answer("P", "lead", ANSWER_KINDS.exact, 3); setEnd("P");
    st.hold.push("upsert"); const p34 = await pushStart("P");
    at(1, 9, 20); use("C"); M.addMyWord("lead", "試しの訳 乙"); setEnd("C"); await push("C");
    at(1, 9, 30); await release("upsert"); await p34.done;
    const k34 = `lead~${hash("試しの訳 乙")}`;
    at(1, 10); use("P"); setEnd("P"); await push("P");
    const aliasAt34 = metaOf("P").alias?.lead?.at ?? null;
    const cloudAt34 = sky.get(`my_word:${k34}`)?.payload?.addedAt ?? null;
    at(1, 11); await sync("P"); at(1, 12); await sync("C");
    const pYi = wordsOf("P").filter((w) => short(w.ja) === "乙").map(show);
    ok("T34 待たせた語の書きが同じ組に断られる: 電話の次の送りで合わさり（印の足した時刻 = 雲の足した時刻）、新しいタブで 乙 は lead~<印 8> に 1 つだけ（覚えた）・雲の lead は PC の 甲 のまま・PC にも 覚えた で届く",
      !!aliasAt34 && aliasAt34 === cloudAt34 && pYi.length === 1 && pYi[0].startsWith(`${k34}=乙[s2`) && sky.get("my_word:lead")?.payload?.ja === "試しの訳 甲" && stateOf("C", "lead", "乙") === "s2" && keyOf("C", "lead", "乙") === k34,
      JSON.stringify({ aliasAt34, cloudAt34, pYi, P: view("P"), C: view("C"), cloud: cloudView() }));

    // ---- T35（答えが落ちる組の種 1598 の形）: 雲に PC の lead=甲。電話が lead=乙 を足して送る（雲の別の鍵へ。書けたが答えが落ちる）→ PC が取り込んで 乙 を消して送る →
    // 電話の新しいタブ: 鍵を移した 乙 は雲に入った語と見られ、新しい墓標が勝って消える（~ の別の鍵で戻らない）。PC の 甲 は両方に残る ----
    reset(); at(1, 9); await sync("P"); await sync("C");
    at(1, 9, 5); use("C"); M.addMyWord("lead", "試しの訳 甲"); setEnd("C"); await push("C");
    at(1, 9, 10); use("P"); M.addMyWord("lead", "試しの訳 乙"); setEnd("P"); st.lose = 1; await push("P").catch(() => {});
    at(1, 10); await sync("C"); use("C"); const k35 = keyOf("C", "lead", "乙"); if (k35) M.removeMyWord(k35, "word"); setEnd("C"); await push("C");
    at(1, 11); await sync("P"); at(1, 12); await settle(["C", "P"]);
    ok("T35 待たせた語の書きの答えが落ちた後にほかの端末が消す: 乙 は電話にも PC にも戻らず、PC の lead=甲 は両方に残る",
      stateOf("P", "lead", "乙") === "-" && stateOf("C", "lead", "乙") === "-" && stateOf("P", "lead", "甲") === "s0" && stateOf("C", "lead", "甲") === "s0" && liveJa("lead") === "甲",
      JSON.stringify({ k35, P: view("P"), C: view("C"), cloud: cloudView() }));

    // ===== T36〜T46（守り）: 設計の決まりを 1 つだけ外すと落ちる検査（ほかの検査が覆わない決まり。docs/SPEC_MY_WORDS.md §18.11） =====
    // ---- T36（送りの要求ごとの 20 秒）: 電話が kite に答え、新しい語 plum を足して送る → 1 つ目の書き（plum の「無いときだけ書く」）が止まる →
    // その間に PC が kite を消して送る → 2 分後に電話の書きが届く。2 つ目の書き（kite）は読み始めから 20 秒を過ぎたので送らない（消した kite を戻さない） ----
    reset(); at(1, 9); await sync("P"); await sync("C");
    use("C"); M.addMyWord("kite", "試しの訳 凧"); setEnd("C"); await push("C");
    at(1, 9, 5); await sync("P");
    at(1, 9, 10); answer("P", "kite", ANSWER_KINDS.exact, 2); use("P"); M.addMyWord("plum", "試しの訳 梅"); setEnd("P");
    st.hold.push("upsert"); const p36 = await pushStart("P");
    at(1, 9, 11); await sync("C"); use("C"); M.removeMyWord("kite", "word"); setEnd("C"); await push("C");
    at(1, 9, 12); await release("upsert"); await p36.done;
    const race36 = { kite: sky.get("my_word:kite")?.deleted === true, plum: sky.get("my_word:plum")?.deleted === false };
    at(1, 10); await settle(["P", "C"]);
    ok("T36 送りの 2 つ目の書きは読み始めから 20 秒を過ぎたら送らない: PC が消した kite は戻らず（雲は墓標）、電話の plum は両方の端末に届く",
      race36.kite && race36.plum && view("P") === "plum=梅[s0]" && view("C") === "plum=梅[s0]" && sky.get("my_word:kite")?.deleted === true, JSON.stringify({ race36, P: view("P"), C: view("C"), cloud: cloudView() }));

    // ---- T37（取り込みの 20 秒）: (a) 電話が kite に答えた後、新しいタブの取り込みの読みが止まる → その間に PC が kite を消して送る → 3 時間後に読みが届く:
    // 古い読みで合わせた kite は送らない (b) 電話が kite に答えて plum を足した後、新しいタブの取り込みの 1 つ目の書き（plum）が止まる → その間に PC が kite を消して送る →
    // 3 分後に届く: 2 つ目の書き（kite）は読み始めから 20 秒を過ぎたので送らない。どちらも消した kite は戻らない ----
    const t37 = [];
    for (const v of ["a", "b"]) {
      reset(); at(1, 9); await sync("P"); await sync("C");
      use("C"); M.addMyWord("kite", "試しの訳 凧"); setEnd("C"); await push("C");
      at(1, 9, 5); await sync("P");
      at(1, 9, 10); answer("P", "kite", ANSWER_KINDS.exact, 2);
      if (v === "b") { use("P"); M.addMyWord("plum", "試しの訳 梅"); }
      st.hold.push(v === "a" ? "range" : "upsert"); const p37 = await pullStart("P");
      at(1, 9, 11); await sync("C"); use("C"); M.removeMyWord("kite", "word"); setEnd("C"); await push("C");
      if (v === "a") at(1, 12); else at(1, 9, 13);
      await release(v === "a" ? "range" : "upsert"); await p37.done;
      const race = sky.get("my_word:kite")?.deleted === true;
      at(1, 13); await settle(["P", "C"]);
      const want = v === "b" ? "plum=梅[s0]" : "";
      t37.push({ v, ok: race && view("P") === want && view("C") === want && sky.get("my_word:kite")?.deleted === true, race, P: view("P"), C: view("C"), cloud: cloudView() });
    }
    ok("T37 取り込みの送りも読み始めから 20 秒の内だけ: (a) 止まった読み (b) 止まった 1 つ目の書きの後の 2 つ目の書き。どちらも PC が消した kite は戻らない",
      t37.every((x) => x.ok), JSON.stringify(t37));

    // ---- T38（雲の墓標と同じ時刻）: PC の kite を電話も持つ → 電話が kite に答えて 覚えた（送らない）→ PC がちょうど同じ時刻（ミリ秒まで）に kite を消して送った →
    // 電話の送りは墓標の時刻 + 1 ms で送り、覚えた kite が両方の端末に残る（同じ時刻は生きた語が勝つ） ----
    reset(); at(1, 9); await sync("P"); await sync("C");
    use("C"); M.addMyWord("kite", "試しの訳 凧"); setEnd("C"); await push("C");
    at(1, 9, 5); await sync("P");
    at(1, 9, 10); answer("P", "kite", ANSWER_KINDS.exact, 3);
    const t38 = metaOf("P")["my_word:kite"]?.updatedAt ?? null;
    sky.set("my_word:kite", { user_id: "u1", kind: "my_word", key: "kite", payload: {}, deleted: true, updated_at: t38 }); // PC の消し（電話の答えと同じ時刻）
    at(1, 9, 20); await sync("C"); // PC は墓標を取り込む（PC で消した形）
    at(1, 9, 30); use("P"); setEnd("P"); await push("P");
    const sent38 = sky.get("my_word:kite") ?? null;
    at(1, 10); await settle(["P", "C"]);
    ok("T38 雲の墓標と同じ時刻の語: 墓標の時刻 + 1 ms で送り、電話と PC に kite が 覚えた で残る",
      !!t38 && sent38?.deleted === false && Date.parse(sent38.updated_at) === Date.parse(t38) + 1 && stateOf("P", "kite", "凧") === "s2" && stateOf("C", "kite", "凧") === "s2",
      JSON.stringify({ t38, sent38: sent38 && { deleted: sent38.deleted, at: sent38.updated_at }, P: view("P"), C: view("C") }));

    // ---- T39（取り込みの読みの間に送った墓標）: 1 台の 2 つのタブ。タブ 2（新しいページ）の取り込みの読みの答えが遅れて届く間に、タブ 1 が凧を消して送る →
    // 凧は消えたまま（取り込みも、送ったばかりの墓標の鍵の古い生きた行を取り込まない） ----
    reset(); at(1, 9); await sync("P"); await sync("C");
    use("P"); M.addMyWord("kite", "試しの訳 凧"); answer("P", "kite", ANSWER_KINDS.exact, 3); setEnd("P"); await push("P"); await sync("C");
    at(1, 10); st.hold.push("range"); const p39 = await pullStart("P"); // タブ 2
    use("P"); M.removeMyWord("kite", "word"); setEnd("P"); await push("P"); // タブ 1
    await release("range"); await p39.done;
    const race39 = view("P");
    at(1, 10, 5); const k39 = keyOf("P", "kite", "凧"); if (k39) answer("P", k39, ANSWER_KINDS.exact, 1); setEnd("P"); await push("P");
    await settle(["P", "C"]);
    ok("T39 2 つのタブの取り込み: ほかのタブの遅れた読みで、消した凧が戻らない（電話・PC とも無く、雲は墓標）",
      race39 === "" && view("P") === "" && view("C") === "" && sky.get("my_word:kite")?.deleted === true, JSON.stringify({ race39, P: view("P"), C: view("C"), cloud: cloudView() }));

    // ---- T40（送る待ちでない印は持たない）: 電話が凧を消して送った 2 秒後に始めた取り込みで、その墓標の印が外れる。前の版が残した印（送る待ちでない・語の無い鍵）も外れる ----
    reset(); at(1, 9); await sync("P");
    use("P"); M.addMyWord("kite", "試しの訳 凧"); M.addMyWord("plum", "試しの訳 梅"); setEnd("P"); await push("P");
    at(1, 9, 30); use("P"); M.removeMyWord("kite", "word"); setEnd("P"); await push("P");
    const m40 = metaOf("P");
    m40["my_word:gone"] = { updatedAt: iso(1, 8), deleted: true, card: { addedAt: iso(1, 7), jaHash: hash("試しの訳 古") } };
    localStorage.setItem("spelldash_user_items_meta", JSON.stringify(m40));
    const before40 = Object.keys(metaOf("P")).filter((k) => k.startsWith("my_word:")).sort().join();
    clock.now += 2000; await pull("P");
    const after40 = Object.keys(metaOf("P")).filter((k) => k.startsWith("my_word:")).sort().join();
    ok("T40 送る待ちでない印: 送った墓標の鍵の印は次の取り込み（送った後に読み始めた）で外れ、前の版の残した印も外れる（語のある plum の印だけ）",
      before40 === "my_word:gone,my_word:kite,my_word:plum" && after40 === "my_word:plum", JSON.stringify({ before40, after40 }));

    // ---- T41（雲の新しい鍵の候補はふさがった鍵を飛ばす）: 雲の lead は PC の 甲、lead~<乙の印 8・16・24・32 桁> はほかの端末が足して消した墓標 →
    // 電話が lead=乙 を足して 覚えた にして送る → 同じ送りで 5 つ目の候補 lead~<印 32 桁>-2 に書く（新しいタブを待たない）。PC にも届く ----
    reset(); at(1, 9); await sync("P"); await sync("C");
    use("C"); M.addMyWord("lead", "試しの訳 甲"); setEnd("C"); await push("C");
    const h41 = hash("試しの訳 乙", 32);
    for (const n of [8, 16, 24, 32]) sky.set(`my_word:lead~${h41.slice(0, n)}`, { user_id: "u1", kind: "my_word", key: `lead~${h41.slice(0, n)}`, payload: {}, deleted: true, updated_at: iso(1, 9, 1) });
    at(1, 9, 10); use("P"); M.addMyWord("lead", "試しの訳 乙"); answer("P", "lead", ANSWER_KINDS.exact, 3); setEnd("P"); await push("P");
    const k41 = `lead~${h41}-2`;
    const first41 = sky.get(`my_word:${k41}`)?.payload?.en ? show(sky.get(`my_word:${k41}`).payload) : null;
    at(1, 10); await sync("C"); await settle(["P", "C"]);
    ok("T41 4 つの候補がふさがった語: 同じ送りで lead~<印 32 桁>-2=乙（覚えた）を書き、PC に届く（雲の lead は 甲 のまま）",
      first41 === `${k41}=乙[s2,lf${dayNo(1)}]` && stateOf("C", "lead", "乙") === "s2" && keyOf("C", "lead", "乙") === k41 && sky.get("my_word:lead")?.payload?.ja === "試しの訳 甲",
      JSON.stringify({ first41, P: view("P"), C: view("C"), cloud: cloudView() }));

    // ---- T42（雲の新しい鍵を新しい語に使わない）: 雲の lead は PC の 甲 → 電話が lead=乙 を足して送る（端末の鍵 lead のまま雲の lead~<乙の印> へ）→
    // 電話でその語の訳を 丙 に直し、lead=乙 をもう一度足す → 新しい 乙 はその雲の鍵を使わない（直した 丙 の行と混ざらない）。両方の端末に 甲・丙・乙 が 1 つずつ ----
    reset(); at(1, 9); await sync("P"); await sync("C");
    use("C"); M.addMyWord("lead", "試しの訳 甲"); setEnd("C"); await push("C");
    at(1, 9, 10); use("P"); M.addMyWord("lead", "試しの訳 乙"); setEnd("P"); await push("P");
    const to42 = metaOf("P").alias?.lead?.to ?? null;
    at(1, 9, 20); use("P"); const e42 = M.setMyWordJa("lead", "試しの訳 丙");
    at(1, 9, 21); use("P"); const a42 = M.addMyWord("lead", "試しの訳 乙");
    const k42 = keyOf("P", "lead", "乙");
    setEnd("P"); await push("P");
    at(1, 10); await sync("P"); at(1, 11); await sync("C"); await settle(["P", "C"]);
    const jas42 = (d) => wordsOf(d).filter((w) => C.answerKeyOf(w) === "lead").map((w) => short(w.ja)).sort().join(",");
    const want42 = ["甲", "乙", "丙"].sort().join(",");
    ok("T42 雲の新しい鍵へ送っている語の訳を直して同じ組を足し直す: 新しい 乙 はその雲の鍵を使わず、両方の端末に lead の 甲・丙・乙 が 1 つずつ",
      to42 === `lead~${hash("試しの訳 乙")}` && e42?.ok === true && a42?.ok === true && !!k42 && k42 !== to42 && jas42("P") === want42 && jas42("C") === want42 && view("P") === view("C"),
      JSON.stringify({ to42, k42, e42: e42?.ok ?? null, a42: a42?.ok ?? null, P: view("P"), C: view("C"), cloud: cloudView() }));

    // ---- T43（送っていない同じ組の足し直しはその鍵）: 電話が lead=甲 を足してすぐ消す（どちらも送らない）→ 同じ lead=甲 を足し直す → 鍵 lead を使う
    // （雲に lead~ の鍵を作らない）。PC にも lead=甲 の 1 語 ----
    reset(); at(1, 9); await sync("P"); await sync("C");
    at(1, 10); use("P"); M.addMyWord("lead", "試しの訳 甲"); M.removeMyWord("lead", "word");
    at(1, 10, 1); use("P"); M.addMyWord("lead", "試しの訳 甲");
    const k43 = keyOf("P", "lead", "甲");
    setEnd("P"); await push("P");
    at(1, 11); await settle(["P", "C"]);
    ok("T43 送っていない同じ組の足し直し: 鍵 lead を使い（雲に lead~ の行を作らない）、電話と PC に lead=甲 の 1 語",
      k43 === "lead" && view("P") === "lead=甲[s0]" && view("C") === "lead=甲[s0]" && ![...sky.keys()].some((id) => id.startsWith("my_word:lead~")), JSON.stringify({ k43, P: view("P"), C: view("C"), cloud: cloudView() }));

    // ---- T44（行を返さない書きの答え）: 電話が kite=凧 を足して 覚えた にして送る（雲に行の無い鍵へ「無いときだけ書く」。答えを遅らせる）→ その間に PC が kite=鳶 を足して送り、
    // 消して送る → 電話の書きが届く（PC の墓標があるので書かれない）が、答えに行が無い → 電話は書けたと見ず送る待ちに残す → 次のタブで 凧 は雲の新しい鍵へ移る（消えない） ----
    reset(); at(1, 9); await sync("P"); await sync("C");
    at(1, 9, 10); use("P"); M.addMyWord("kite", "試しの訳 凧"); answer("P", "kite", ANSWER_KINDS.exact, 3); setEnd("P");
    st.hold.push("upsert"); const p44 = await pushStart("P");
    at(1, 9, 11); use("C"); M.addMyWord("kite", "試しの訳 鳶"); setEnd("C"); await push("C");
    at(1, 9, 12); use("C"); M.removeMyWord("kite", "word"); setEnd("C"); await push("C");
    st.noRows = 1; await release("upsert"); await p44.done;
    const left44 = dirtyOf("P");
    at(1, 10); await sync("P"); at(1, 11); await sync("C"); await settle(["P", "C"]);
    ok("T44 書きの答えに行が無い: 電話は kite=凧 を送る待ちに残し、次のタブで雲の新しい鍵へ移して送る（電話と PC に 覚えた で残る）",
      left44.includes("my_word:kite") && stateOf("P", "kite", "凧") === "s2" && stateOf("C", "kite", "凧") === "s2", JSON.stringify({ left44, P: view("P"), C: view("C"), cloud: cloudView() }));

    // ---- T45（送る前の読みの範囲）: 送る待ちの語が 1 つなら、その鍵の並びで読む（全部の行は読まない） ----
    reset(); at(1, 9); await sync("P");
    use("P"); M.addMyWord("kite", "試しの訳 凧");
    const r45 = { ...st.reqs }; await push("P");
    const n45 = { wordRead: st.reqs.wordRead - r45.wordRead, range: st.reqs.range - r45.range };
    ok("T45 送る前の読み: 送る待ちの語 1 つは鍵の並びの読み 1 回（全部の行の読みは 0 回）", n45.wordRead === 1 && n45.range === 0, JSON.stringify(n45));

    // ---- T46（印 merged の時刻は 今 − 1 ms）: PC が kite=鳶 を足して送る（電話はまだ取り込まない）→ 電話のセットの終わりの送りが印を進めたのと同じミリ秒に、
    // 電話が kite=凧 を足して 覚えた → PC が自分の 鳶 を消して送る → 電話の新しいタブ: 凧 はまだ雲に入っていない語なので PC の墓標で消えない（新しい鍵へ） ----
    reset(); at(1, 9); await sync("P"); await sync("C");
    use("C"); M.addMyWord("kite", "試しの訳 鳶"); setEnd("C"); await push("C");
    at(1, 9, 10); use("P"); setEnd("P"); await push("P");
    use("P"); M.addMyWord("kite", "試しの訳 凧");
    const edge46 = Date.parse(wordsOf("P").find((w) => w.en === "kite")?.addedAt ?? "") - Date.parse(metaOf("P").merged?.at ?? "");
    answer("P", "kite", ANSWER_KINDS.exact, 3);
    at(1, 9, 20); await sync("C"); use("C"); M.removeMyWord("kite", "word"); setEnd("C"); await push("C");
    at(1, 9, 30); await sync("P"); at(1, 9, 40); await sync("C"); await settle(["P", "C"]);
    ok("T46 印を進めたのと同じミリ秒に足した語: まだ雲に入っていない語と見て、PC の墓標で消えない（電話と PC に 凧 が 覚えた で残る）",
      edge46 >= 0 && edge46 <= 1 && stateOf("P", "kite", "凧") === "s2" && stateOf("C", "kite", "凧") === "s2", JSON.stringify({ edge46, P: view("P"), C: view("C"), cloud: cloudView() }));

    // ===== Batch 95 の直し T47〜（反証で見つかった形。docs/SPEC_MY_WORDS.md §18.11） =====
    // ---- T47（答えが届かなかった場面カード）: 電話が場面カードを作って送る（書けたが答えが落ちる）→ 次の送りで雲の行を 1 回読み、同じ版なので送る待ちから外す
    // （雲は payload の鍵の並びを変え、時刻を表の形の文字で返す）→ その後の送りは読まない・印 merged の out に残らない。PC にも届く ----
    reset(); at(1, 9); await sync("P"); await sync("C");
    use("P"); const made47 = M.addMyConcept({ q: "試しの場面 甲", answer: "Kite flying", explain: "試しの解説 甲", accept: "" });
    setEnd("P"); st.lose = 1; await push("P").catch(() => {});
    const left47 = dirtyOf("P");
    const reads47 = [];
    for (let i = 1; i <= 3; i++) { at(1, 9, 10 * i); setEnd("P"); const r0 = st.reqs.wordRead + st.reqs.range; await push("P"); reads47.push(st.reqs.wordRead + st.reqs.range - r0); }
    at(1, 11); await sync("C");
    ok("T47 答えが届かなかった場面カード: 次の送りで送る待ちから外れ（雲の読みは 1 回だけ）・印 merged の out に残らない・PC にも届く",
      made47?.ok === true && left47.length === 1 && dirtyOf("P").length === 0 && JSON.stringify(reads47) === "[1,0,0]" && (metaOf("P").merged?.out ?? []).length === 0 && all("C").some((w) => w.kind === "concept"),
      JSON.stringify({ made: made47?.ok, left47, dirty: dirtyOf("P"), reads47, out: metaOf("P").merged?.out ?? null }));

    // ---- T48（古い読みの取り込み・2 つのタブ）: タブ 2（新しいページ）の取り込みの読みが止まる → タブ 1 が凧を消して送り、30 秒後の次のセットの終わりも送る
    // （送った墓標の印 sentAt は外れる）→ タブ 2 の読みが 15 分後に届く: 古い読みでは合わせない（読み直す）ので、凧は戻らない。凧が見えたら答える。電話・PC・雲とも凧は無い ----
    reset(); at(1, 9); await sync("P"); await sync("C");
    use("P"); M.addMyWord("kite", "試しの訳 凧"); M.addMyWord("plum", "試しの訳 梅"); answer("P", "kite", ANSWER_KINDS.exact, 3); setEnd("P"); await push("P");
    at(1, 9, 5); await sync("C");
    at(1, 10); st.hold.push("range"); const p48 = await pullStart("P"); // タブ 2
    use("P"); M.removeMyWord("kite", "word"); setEnd("P"); await push("P"); // タブ 1
    clock.now += 30000; answer("P", "plum", ANSWER_KINDS.exact, 1); setEnd("P"); await push("P"); // タブ 1 の次のセットの終わり
    const swept48 = !metaOf("P")["my_word:kite"];
    at(1, 10, 15); await release("range"); await p48.done;
    const race48 = view("P");
    at(1, 10, 16); const k48 = keyOf("P", "kite", "凧"); if (k48) answer("P", k48, ANSWER_KINDS.exact, 1); setEnd("P"); await push("P");
    await settle(["P", "C"], 3);
    ok("T48 古い読みの取り込み: ほかのタブが消して送った凧は、送った墓標の印が外れた後に届いた古い読みでも戻らない（電話・PC・雲とも無い）",
      swept48 && !race48.includes("kite") && stateOf("P", "kite", "凧") === "-" && stateOf("C", "kite", "凧") === "-" && liveJa("kite") === "", JSON.stringify({ swept48, race48, P: view("P"), C: view("C"), cloud: cloudView() }));

    // ---- T49（古い読みと同じ組の足し直し）: タブ 2 の取り込みの読みが止まる → タブ 1 が覚えた 凧 を消して送り、同じ組 凧 を足し直す → タブ 2 の読みが 3 分後に届く:
    // 足し直した凧は新しいカード（これから）のまま。消した凧の 覚えた を写さない（T14h と同じ決まり） ----
    reset(); at(1, 9); await sync("P"); await sync("C");
    use("P"); M.addMyWord("kite", "試しの訳 凧"); answer("P", "kite", ANSWER_KINDS.exact, 3); setEnd("P"); await push("P");
    at(1, 9, 5); await sync("C");
    at(1, 10); st.hold.push("range"); const p49 = await pullStart("P"); // タブ 2
    use("P"); M.removeMyWord("kite", "word"); setEnd("P"); await push("P"); // タブ 1
    at(1, 10, 2); use("P"); const re49 = M.addMyWord("kite", "試しの訳 凧");
    at(1, 10, 3); await release("range"); await p49.done;
    const race49 = stateOf("P", "kite", "凧");
    at(1, 10, 4); setEnd("P"); await push("P");
    await settle(["P", "C"], 3);
    const n49 = (d) => wordsOf(d).filter((w) => C.answerKeyOf(w) === "kite").length;
    ok("T49 古い読みと同じ組の足し直し: 足し直した凧は これから のまま（消した凧の 覚えた を写さない）・電話と PC に 1 語",
      re49?.ok === true && race49 === "s0" && stateOf("P", "kite", "凧") === "s0" && stateOf("C", "kite", "凧") === "s0" && n49("P") === 1 && n49("C") === 1,
      JSON.stringify({ re: re49?.ok, race49, P: view("P"), C: view("C"), cloud: cloudView() }));

    // ---- T50（古い読みで取り込んだ語）: PC が凧を足して送る → 電話の新しいタブの取り込みの読みが 5 分後に届く（裏に回した）→ 電話が凧に答える →
    // 電話のセットの終わりの送りは読めない（圏外）→ PC が凧を消して送る → 電話の次の送りと新しいタブ: 凧は消える（電話の別の鍵で戻らない） ----
    reset(); at(1, 9); await sync("P"); await sync("C");
    at(1, 10); use("C"); M.addMyWord("kite", "試しの訳 凧"); setEnd("C"); await push("C");
    at(1, 11); st.hold.push("range"); const p50 = await pullStart("P");
    at(1, 11, 5); await release("range"); await p50.done;
    at(1, 11, 6); answer("P", "kite", ANSWER_KINDS.exact, 1); setEnd("P"); st.failReads = 2; await push("P"); st.failReads = 0;
    at(1, 11, 20); await sync("C"); use("C"); M.removeMyWord("kite", "word"); setEnd("C"); await push("C");
    at(1, 11, 30); use("P"); setEnd("P"); await push("P");
    await settle(["P", "C"], 3);
    ok("T50 古い読みで取り込んだ語に答えた後、送りが読めず、PC が消す: 凧は電話・PC・雲のどこにも戻らない（~ の別の鍵でも）",
      stateOf("P", "kite", "凧") === "-" && stateOf("C", "kite", "凧") === "-" && liveJa("kite") === "", JSON.stringify({ P: view("P"), C: view("C"), cloud: cloudView() }));

    // ---- T51（古い読みは合わせない・印を進めない）: 電話の取り込みの読みが 2 回とも読み始めから 20 秒を過ぎて届く → 雲の凧は取り込まず、送らず、印 merged も進めない ----
    reset(); at(1, 9); await sync("P"); await sync("C");
    use("C"); M.addMyWord("kite", "試しの訳 凧"); setEnd("C"); await push("C");
    at(1, 10); const mark51 = metaOf("P").merged?.at ?? null; const up51 = st.reqs.upsert;
    st.hold.push("range", "range"); const p51 = await pullStart("P");
    clock.now += 25000; await release("range");
    clock.now += 25000; await release("range"); await p51.done;
    ok("T51 古い読み（2 回とも 20 秒を過ぎた）の取り込み: 雲の凧を取り込まず・送らず・印 merged を進めない",
      !!mark51 && metaOf("P").merged?.at === mark51 && stateOf("P", "kite", "凧") === "-" && st.reqs.upsert === up51 && st.held.length === 0,
      JSON.stringify({ mark51, mark: metaOf("P").merged?.at ?? null, P: view("P"), upserts: st.reqs.upsert - up51, held: st.held.length }));

    // ---- T52（2 つのタブ・墓標と読み）: タブ 1 が凧を足す → タブ 2 が開き、取り込みの読みは雲が答えたが処理は後（重いページ）→ タブ 1 のセットの終わりが凧を送り（雲に入る）、
    // 凧を消す → タブ 2 が読みを処理する（読み始めから 20 秒の内・読みに凧の行は無い）: 送る待ちの凧の墓標を外さない。凧は電話・PC・雲とも無い・書きの印も残らない ----
    const tried = (name) => metaOf(name).tried ?? null;
    reset(); at(1, 9); await sync("P"); await sync("C");
    at(1, 10); use("P"); M.addMyWord("kite", "試しの訳 凧");
    clock.now += 1000; st.hold.push("range"); const p52 = await pullStart("P"); // タブ 2
    clock.now += 300; setEnd("P"); await push("P"); // タブ 1: 凧を送る（雲に入る）
    clock.now += 500; use("P"); M.removeMyWord("kite", "word"); // タブ 1: 凧を消す
    clock.now += 2000; await release("range"); await p52.done; // タブ 2 が読みを処理する
    const kept52 = dirtyOf("P").includes("my_word:kite") && metaOf("P")["my_word:kite"]?.deleted === true;
    clock.now += 5000; setEnd("P"); await push("P"); // タブ 1 の次のセットの終わり
    await settle(["P", "C"], 2);
    ok("T52 2 つのタブ: 自分の書きが雲に入る前に始めた読みに凧の行が無くても、送る待ちの凧の墓標を外さない（凧は電話・PC・雲とも無い）",
      kept52 && stateOf("P", "kite", "凧") === "-" && stateOf("C", "kite", "凧") === "-" && liveJa("kite") === "" && !tried("P"),
      JSON.stringify({ kept52, P: view("P"), C: view("C"), cloud: cloudView(), tried: tried("P") }));

    // ---- T53（書きの答えを待つ間に消す）: タブ 1 のセットの終わりが凧を送る（雲の書きはまだ）→ 凧を消す → 新しいタブが取り込み・送り（読みに凧の行は無い）
    // → タブ 1 の書きが後から雲で行われる: 墓標を外さず「無いときだけ書く」で送るので、後から届いた生きた凧は書かれない ----
    reset(); at(1, 9); await sync("P"); await sync("C");
    at(1, 10); use("P"); M.addMyWord("kite", "試しの訳 凧"); setEnd("P");
    st.hold.push("upsert"); const p53 = await pushStart("P"); // タブ 1
    clock.now += 500; use("P"); M.removeMyWord("kite", "word");
    clock.now += 500; await sync("P"); // タブ 2
    clock.now += 500; await release("upsert"); await p53.done; // タブ 1 の書きが雲で行われる
    await settle(["P", "C"], 2);
    ok("T53 書きの答えを待つ間に消した凧: ほかのタブの読みに行が無くても墓標を送り、後から届いた書きで凧が戻らない（電話・PC・雲とも無い）",
      stateOf("P", "kite", "凧") === "-" && stateOf("C", "kite", "凧") === "-" && liveJa("kite") === "" && !tried("P"),
      JSON.stringify({ P: view("P"), C: view("C"), cloud: cloudView(), tried: tried("P") }));

    // ---- T54（書きの答えが読みの始めより後）: タブ 1 のセットの終わりが凧を送る（雲の書きはまだ）→ 凧を消す → タブ 2 が開き、取り込みの読みは雲が答えた（凧の行は無い）が処理は後
    // → タブ 1 の書きが雲で行われ答えも来る → タブ 2 が読みを処理する: 墓標を外さない。凧は電話・PC・雲とも無い ----
    reset(); at(1, 9); await sync("P"); await sync("C");
    at(1, 10); use("P"); M.addMyWord("kite", "試しの訳 凧"); setEnd("P");
    st.hold.push("upsert"); const p54b = await pushStart("P"); // タブ 1
    clock.now += 500; use("P"); M.removeMyWord("kite", "word");
    clock.now += 500; st.hold.push("range"); const p54a = await pullStart("P"); // タブ 2
    clock.now += 500; await release("upsert"); await p54b.done; // タブ 1 の書きが雲で行われ、答えが来る
    clock.now += 1000; await release("range"); await p54a.done; // タブ 2 が読みを処理する
    const kept54 = dirtyOf("P").includes("my_word:kite") && metaOf("P")["my_word:kite"]?.deleted === true;
    clock.now += 5000; setEnd("P"); await push("P");
    await settle(["P", "C"], 2);
    ok("T54 書きの答えが読みの始めより後に来た凧: 読みに行が無くても墓標を外さない（凧は電話・PC・雲とも無い・書きの印も残らない）",
      kept54 && stateOf("P", "kite", "凧") === "-" && stateOf("C", "kite", "凧") === "-" && liveJa("kite") === "" && !tried("P"),
      JSON.stringify({ kept54, P: view("P"), C: view("C"), cloud: cloudView(), tried: tried("P") }));

    // ---- T55（消していない語の上限）: 偽の雲の守りの上限を 5 語にする（本物は 1,000 語。決まりは同じ）。上限の 5 語のうち 3 語を消し、新しい 3 語を足して 1 回の送り:
    // 新しい語が先に断られても、墓標を送った後にもう一度送るので、新しい 3 語は雲に入る（1 日待たない）。
    // (b) 1 語を消して 3 語を足す: 上限まで（1 語）は入り、残りの 2 語は断られて待つ（前のとおり）----
    const capRun = async (drop, add) => {
      reset(); st.cap = 5; at(1, 9); await sync("P");
      const base = [["ant", "蟻"], ["bee", "蜂"], ["cat", "猫"], ["dog", "犬"], ["elk", "鹿"]];
      use("P"); for (const [en, ja] of base) M.addMyWord(en, `試しの訳 ${ja}`);
      setEnd("P"); await push("P");
      at(1, 10); use("P");
      for (const [en] of base.slice(0, drop)) M.removeMyWord(en, "word");
      for (const [en, ja] of [["fox", "狐"], ["gnu", "牛"], ["hen", "鶏"]].slice(0, add)) M.addMyWord(en, `試しの訳 ${ja}`);
      setEnd("P"); const up0 = st.reqs.upsert; await push("P");
      const live = [...sky.values()].filter((r) => r.kind === "my_word" && !r.deleted).map((r) => r.key).sort().join(",");
      const waits = Object.entries(metaOf("P")).filter(([, m]) => m?.failAt).map(([id]) => id.slice(8)).sort().join(",");
      return { live, waits, dirty: dirtyOf("P"), upserts: st.reqs.upsert - up0 };
    };
    const cap55 = await capRun(3, 3);
    const cap55b = await capRun(1, 3);
    ok("T55 消していない語の上限: 上限の 5 語から 3 語を消し 3 語を足した送りで、新しい 3 語も雲に入る（断られて 1 日待たない）・送る待ちが残らない",
      cap55.live === "dog,elk,fox,gnu,hen" && cap55.waits === "" && cap55.dirty.length === 0, JSON.stringify(cap55));
    ok("T55b 1 語を消して 3 語を足すと、上限までの 1 語だけ雲に入り、残りの 2 語は断られて待つ（上限は越えない）",
      cap55b.live.split(",").length === 5 && cap55b.live.startsWith("bee,cat,dog,elk,") && cap55b.waits.split(",").length === 2 && cap55b.dirty.length === 2, JSON.stringify(cap55b));

    // ---- T56（表がまだ無い・本番の今）: ページの取り込みで表が無いと分かったら、そのページの送りは語を読まない（読んでも表が無い）。日の行の読みだけ（e01d71f と同じ 1 つ）。
    // 印 merged は作らない・語は送る待ちに残る。(b) 取り込みの無いページ（同じタブの 2 つ目のページ）でも、最初の送りで表が無いと分かれば次の送りから語を読まない。
    // 表ができたら、次のページで全部送る ----
    reset(); at(1, 9); st.missing = true;
    use("P"); for (const [en, ja] of [["ant", "蟻"], ["bee", "蜂"], ["cat", "猫"]]) M.addMyWord(en, `試しの訳 ${ja}`);
    await pull("P");
    const r56 = { ...st.reqs };
    answer("P", "ant", ANSWER_KINDS.exact, 1); setEnd("P"); await push("P"); // セットの終わり
    setEnd("P"); await push("P"); // 10 語ごとの送り
    await push("P"); // ページを離れる
    const d56 = Object.fromEntries(Object.entries(st.reqs).map(([k, v]) => [k, v - r56[k]]));
    const mark56 = metaOf("P").merged ?? null;
    const U2 = await import("../js/userItemsSync.js?t56b"); // 取り込みの無いページ（表のことをまだ知らない）
    const r56b = { ...st.reqs };
    use("P"); setEnd("P"); await U2.pushUserItems(client, "u1", { now: nowOf() });
    setEnd("P"); await U2.pushUserItems(client, "u1", { now: nowOf() });
    const d56b = Object.fromEntries(Object.entries(st.reqs).map(([k, v]) => [k, v - r56b[k]]));
    const dirty56 = dirtyOf("P").length;
    st.missing = false; at(1, 10); await sync("P");
    ok("T56 表がまだ無い: 取り込みで表が無いと分かったページの送りは語を読まない（3 回の送りで日の読み 3・語の読み 0・書き 0）・印 merged を作らない・語は送る待ちに残り、表ができたら送る",
      d56.wordRead === 0 && d56.dayRead === 3 && d56.upsert === 0 && !mark56 && dirty56 === 3 && liveJa("ant") === "蟻" && liveJa("cat") === "猫" && dirtyOf("P").length === 0,
      JSON.stringify({ d56, mark56, dirty56, cloud: cloudView(), dirty: dirtyOf("P") }));
    ok("T56b 取り込みの無いページ: 最初の送りの日の読みで表が無いと分かれば、次の送りは語を読まない（語の読み 1・日の読み 2）",
      d56b.wordRead === 1 && d56b.dayRead === 2 && d56b.upsert === 0, JSON.stringify(d56b));
  } finally {
    globalThis.Date = RealDate;
  }
}

console.log(`test-my-words: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
