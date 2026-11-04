// マイ単語帳（Batch 79。docs/SPEC_MY_WORDS.md）の決まりの単体: 入れられる英語・まとめて追加の行・出題のカード（前からの語の id は同じ）・
// 打ち方（英小文字だけの語は 1 字ずつ、ほかは全文入力で大文字小文字・空白・ハイフン・アポストロフィを見ない）・マイ単語帳だけの 3 状態（js/learnState.js と同じ決まり）・
// 学ぶ回の列（これから → あやふや → 覚えた・10 語）・入口 ?learn=my
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
for (const raw of ["", "   ", "123", "café", "a/b", "U.S.", "日本語", "-mail", "x".repeat(41), "a, b", "what?"]) {
  ok(`入れられない: 「${raw}」`, C.checkEnText(raw).ok === false, JSON.stringify(C.checkEnText(raw)));
}
ok("40 字ちょうどは入る", C.checkEnText("a".repeat(40)).ok);
ok("訳: 空は入れない・40 字まで", !C.checkJaText(" ").ok && C.checkJaText("あ".repeat(40)).ok && !C.checkJaText("あ".repeat(41)).ok);

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

console.log(`test-my-words: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
