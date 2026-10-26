// 判定器（js/judge.js）の単体テスト。ブラウザなしで数秒で終わる:
//   node scripts/test-judge.mjs
// 盤面（js/game.js）と同じ作り方でカードと候補を作り（js/wordData.js toCard → js/answers.js buildAlternativeIndex・acceptedAnswers。
// 全パックを有効にした形）、代表の語を判定器だけで再現する。失敗が 1 つでもあれば終了コード 1。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isDeepStrictEqual } from "util";
import { toCard, answerLabel } from "../js/wordData.js";
import { buildAlternativeIndex, acceptedAnswers, completedAnswer } from "../js/answers.js";
import {
  answerModeOf,
  candidatesNow,
  finishKind,
  isOwnAnswer,
  romajiFromStart,
  romajiMatcherFor,
  romajiStep,
  spellFitsFromStart,
  spellStep,
  typeAnswer,
  answerMatches
} from "../js/judge.js";
import * as JUDGE from "../js/judge.js"; // Batch 72 のヒントの 1 字（hintStep）。名前で読むので、無い版でも読み込みは落ちず検査が落ちる
import * as ANSWERS from "../js/answers.js"; // 綴り入力の別解の決まり（isSpellAlt。PR #191 のレビュー 2）。同じく名前で読む

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let passed = 0;
const failures = [];
function eq(name, actual, expected) {
  if (isDeepStrictEqual(actual, expected)) passed++;
  else failures.push(`${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}
const ok = (name, cond) => eq(name, !!cond, true);
// typeAnswer の結果のうち、見たい欄だけを比べる
function judged(name, result, expected) {
  const picked = Object.fromEntries(Object.keys(expected).map((k) => [k, result[k]]));
  eq(name, picked, expected);
}

// ---- カード（全パックを有効にした形。js/wordStore.js initWordStore と同じ: 全カードから別解の索引） ----
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "data/manifest.json"), "utf8"));
const cards = [];
for (const subject of manifest.subjects) {
  for (const category of subject.categories) {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data", category.file), "utf8"));
    for (const word of data.words) cards.push(toCard(word, data, category));
  }
}
const index = buildAlternativeIndex(cards);
const card = (category, id) => {
  const w = cards.find((c) => c.category === category && c.id === id);
  if (!w) throw new Error(`カードが無い: ${category}:${id}`);
  return w;
};
const cands = (w) => acceptedAnswers(w, index);
const type = (w, text, opts) => typeAnswer(w, cands(w), text, opts);

// ---- 出題語が別の候補の先頭部分（K0-1。gym／gymnasium・a／an・sport／sports） ----
{
  const gym = card("jhs-english1", "english-gym");
  eq("gym: 答え方は綴り", answerModeOf(gym).mode, "spell");
  ok("gym: 候補に gymnasium がある（出題語が先頭）", cands(gym)[0] === "gym" && cands(gym).includes("gymnasium"));
  judged("gym を打ち切るとその場で正解（3 打目・Enter なし）", type(gym, "gym"), { how: "auto", kind: "exact", at: 3 });
  judged("gym の問いで gymnasium と打つ: gym で正解、続き nasium は残り", type(gym, "gymnasium"), { how: "auto", kind: "exact", at: 3, rest: "nasium" });
  ok("gym で完成した 1 打（spellStep）の続きは nasium", spellStep(cands(gym), "gy", "m").rests.includes("nasium"));
  eq("gym を打った状態の Enter は gym で確定（js/answers.js completedAnswer の force）", completedAnswer(cands(gym), "gym", { force: true }), "gym");

  const gymnasium = card("tsl11", "english-gymnasium");
  judged("gymnasium の問いで gym（別解）: 伸びる候補があるので止めず、Enter で別解", type(gymnasium, "gym"), { how: "enter", kind: "alt", at: 3 });
  judged("gymnasium を打ち切ると正解", type(gymnasium, "gymnasium"), { how: "auto", kind: "exact", at: 9 });

  const a = card("ngsl01", "english-a");
  judged("a: 1 打目で正解", type(a, "a"), { how: "auto", kind: "exact", at: 1 });
  judged("a の問いで an: a で正解、続き n は残り", type(a, "an"), { how: "auto", kind: "exact", at: 1, rest: "n" });

  const sport = card("highschool", "english-sport");
  judged("sport: 5 打目で正解", type(sport, "sport"), { how: "auto", kind: "exact", at: 5 });
  judged("sport の問いで sports: sport で正解、続き s は残り", type(sport, "sports"), { how: "auto", kind: "exact", at: 5, rest: "s" });
}

// ---- 綴り違い（favourite／favorite）は同じ語: その場で正解（別解の案内にしない） ----
{
  const fav = card("junior", "english-favorite");
  judged("favorite の問いで favourite: 綴り違いとして Enter なしで正解", type(fav, "favourite"), { how: "auto", kind: "variant", at: 9 });
  eq("finishKind: favourite は favorite の綴り違い", finishKind("favourite", "favorite"), "variant");
  ok("isOwnAnswer: 綴り違いは出題語の正解", isOwnAnswer("favourite", "favorite"));
  eq("finishKind: 出題語そのもの", finishKind("favorite", "favorite"), "exact");
  const color = card("ngsl04", "english-color");
  judged("color の問いで colour: 綴り違い", type(color, "colour"), { how: "auto", kind: "variant", at: 6 });
}

// ---- 別解（同じ訳の別の語・データの accept）: 減点せず出題語を見せる（自力の正解にはしない） ----
{
  const adv = card("toeic600", "english-advertisement");
  ok("advertisement の候補に ad・advert・advertising", ["ad", "advert", "advertising"].every((c) => cands(adv).includes(c)));
  judged("advertisement の問いで ad: 止めずに Enter で別解", type(adv, "ad"), { how: "enter", kind: "alt", at: 2 });
  eq("ad を打った途中では完成しない（advert・advertisement に伸びる）", spellStep(cands(adv), "a", "d").done, null);
  judged("advertisement の問いで advertising: 打ち切ると Enter なしで別解", type(adv, "advertising"), { how: "auto", kind: "alt", at: 11 });
  ok("isOwnAnswer: 別解は出題語の正解ではない", !isOwnAnswer("ad", "advertisement"));
  const ad = card("ngsl13", "english-ad");
  judged("ad の問いで advertisement: ad で正解（出題語が先頭）", type(ad, "advertisement"), { how: "auto", kind: "exact", at: 2, rest: "vertisement" });
  judged("ad の問いで commercial（データの別解）: Enter なしで別解", type(ad, "commercial"), { how: "auto", kind: "alt", at: 10 });
}

// ---- 1 打ミス（1 ミス＝×）と、答えを見た後（出題語だけ） ----
{
  const gym = card("jhs-english1", "english-gym");
  judged("gym の問いで gim: 2 打目で ×（期待した字は y）", type(gym, "gim"), { how: "miss", at: 2, expected: "y" });
  eq("spellStep: 受けない字は ok=false で綴りを進めない", spellStep(cands(gym), "g", "i"), { ok: false, typed: "g", done: null, rests: [] });
  eq("spellStep: 大文字は小文字で比べる・完成したら長い候補の続き", spellStep(cands(gym), "gy", "M"), { ok: true, typed: "gym", done: "gym", rests: ["nasium"] });
  eq("spellStep: まだ完成しない 1 打は続きを持たない", spellStep(cands(gym), "g", "y"), { ok: true, typed: "gy", done: null, rests: [] });
  ok("spellFitsFromStart: 何も打っていなければ通る", spellFitsFromStart(cands(gym), ""));
  ok("spellFitsFromStart: gymn は頭から通る（gymnasium）", spellFitsFromStart(cands(gym), "gymn"));
  ok("spellFitsFromStart: gix は通らない", !spellFitsFromStart(cands(gym), "gix"));
  const gymnasium = card("tsl11", "english-gymnasium");
  eq("答えを見た後の候補は出題語だけ", candidatesNow(cands(gymnasium), "gymnasium", true), ["gymnasium"]);
  judged("答えを見た後の gymnasium の問いで gym: 完成せず（別解でごまかせない）", type(gymnasium, "gym", { revealed: true }), { how: "reveal", at: 3 });
  const ad = card("ngsl13", "english-ad");
  judged("答えを見た後の ad の問いで commercial: 1 打目で ×", type(ad, "commercial", { revealed: true }), { how: "miss", at: 1, expected: "a" });
  judged("答えを見た後でも出題語は正解", type(ad, "ad", { revealed: true }), { how: "auto", kind: "exact", at: 2 });
}

// ---- 日本語の答え（ローマ字）: 語末の ん・読みの別解・答えを見た後は主な読みだけ ----
{
  const manor = card("hs-worldhist1", "concept-wh1-manor"); // 荘園（しょうえん・しょうえんせい）
  eq("荘園: 答え方はローマ字", answerModeOf(manor).mode, "romaji");
  judged("荘園: 語末の ん を n 1 つで打ち切っても正解（6 打目）", type(manor, "shouen"), { how: "auto", at: 6 });
  judged("荘園: 語末の ん を nn で打つと n 1 つの時点で正解し、2 つ目の n は残り", type(manor, "shouenn"), { how: "auto", at: 6, rest: "n" });
  judged("荘園: 長い読み（荘園制）を打つと短い読みで正解し、残りは続き", type(manor, "shouensei"), { how: "auto", at: 6, rest: "sei" });
  judged("荘園: しょうえ で止めると Enter で答えが開く（×）", type(manor, "shoue"), { how: "reveal", at: 5 });
  judged("荘園: 別の字で 1 打ミス", type(manor, "shoz"), { how: "miss", at: 4 });
  const kangen = card("jsci1", "concept-js1-kangen"); // 還元（かんげん）
  judged("還元: 途中の ん を nn で打っても正解", type(kangen, "kanngen"), { how: "auto", at: 7 });
  judged("還元: 途中の ん を n 1 つ（kange…）でも正解", type(kangen, "kangen"), { how: "auto", at: 6 });
  const shotoku = card("elem-hist", "concept-eh-shotokutaishi"); // 聖徳太子（しょうとくたいし・厩戸皇子 うまやどのおうじ・厩戸王 うまやどのおう／うまやとおう）
  // 厩戸皇子 の読みの頭が 厩戸王 の読み（うまやどのおう）なので、うまやどのおうじ と打つと 11 打目（うまやどのおう）で正解し、ji は残り（Batch 71）
  judged("聖徳太子: 別の読み（厩戸皇子）を打つと、頭の 厩戸王 の読み（うまやどのおう）で Enter なしで正解", type(shotoku, "umayadonoouji"), { how: "auto", at: 11, rest: "ji" });
  // 答えでない別の読みで、ほかの読みの頭の形でない物（厩戸王 の うまやとおう）は、打ち切ると Enter なしで正解（Batch 71 の前からの検査。PR #187 のレビュー 5）
  judged("聖徳太子: 頭の形でない別の読み（厩戸王 の うまやとおう）を打ち切ると Enter なしで正解（9 打目・残り無し）", type(shotoku, "umayatoou"), { how: "auto", at: 9, rest: "" });
  judged("聖徳太子: 答えを見た後は主な読みだけ（別の読みは 1 打目で ×）", type(shotoku, "umayadonoouji", { revealed: true }), { how: "miss", at: 1 });
  judged("聖徳太子: 答えを見た後も主な読みは正解", type(shotoku, "shoutokutaishi", { revealed: true }), { how: "auto", at: 14 });
  // 盤面と typeAnswer が使う 1 打の関数（PR #175 の 6）: 読みの判定・1 打・状態を変えない見通し
  const { entries } = answerModeOf(shotoku);
  const m = romajiMatcherFor(entries);
  // 期待する読みの並びは固定の値で書く（教材から同じ正規化と絞り込みで作ると、readingEntries の退行〔抜け・並びの入れ替わり〕を捕まえられない。
  // PR #187 のレビュー 5）。教材の読みを直したら、ここも直す
  eq("romajiMatcherFor: 答えを見る前はすべての読み（しょうとくたいし・うまやどのおうじ・うまやどのおう・うまやとおう の順）", m.entries.map((e) => e.reading), ["しょうとくたいし", "うまやどのおうじ", "うまやどのおう", "うまやとおう"]);
  eq("romajiMatcherFor: 答えを見た後は主な読みだけ（しょうとくたいし）", romajiMatcherFor(entries, { revealed: true }).entries.map((e) => e.reading), ["しょうとくたいし"]);
  eq("romajiStep: 空白はローマ字のキーでない（判定しない）", romajiStep(m, " ").ignored, true);
  const s1 = romajiStep(m, "s");
  ok("romajiStep: s は受ける（まだ打ち終えない）", s1.ok && !s1.done && m.keys === "s");
  const sx = romajiStep(m, "x");
  ok("romajiStep: 外れた字はミス（matcher は進めない）", !sx.ok && !sx.ignored && m.keys === "s");
  ok("romajiFromStart: 打った字 ＋ 残りで打ち終える（状態は変えない）", romajiFromStart(m, "shoutokutaishi").done && m.keys === "s");
  ok("romajiFromStart: 別の読み（うまやどのおうじ）の頭も通る", romajiFromStart(m, "u").fits);
  ok("romajiFromStart: 答えを見た後の読み（主な読みだけ）では、別の読みの頭は通らない", !romajiFromStart(romajiMatcherFor(entries, { revealed: true }), "u").fits);
  const m2 = romajiMatcherFor(answerModeOf(manor).entries);
  for (const ch of "shouen") romajiStep(m2, ch);
  ok("romajiStep: 荘園は n 1 つの ん で打ち終えている（続けて打てる: 2 つ目の n・荘園制）", m2.state().done && m2.state().canContinue);
}

// ---- 全文入力（英語の用語）: Enter で答え全体を、表記ゆれを吸収して比べる ----
{
  const aimax = card("listing", "concept-ai-max");
  eq("AI Max: 答え方は全文入力", answerModeOf(aimax).mode, "free");
  judged("AI Max: 大文字・空白の違いは吸収（ai max）", type(aimax, "ai max"), { how: "enter", kind: "exact" });
  judged("AI Max: 違う答えは ×", type(aimax, "ai mix"), { how: "wrong" });
  ok("answerMatches: 全角・ハイフンも吸収", answerMatches(aimax, "ＡＩ-Max"));
}

// ---- 英字の答えの大小文字（T4）: 判定は小文字で比べ、表示は元の綴り ----
{
  const cu = card("jsci1", "concept-js1-cu");
  eq("Cu: 判定の形（en）は小文字", cu.en, "cu");
  eq("Cu: 表示は元の綴り（answerLabel）", answerLabel(cu), "Cu");
  judged("Cu: cu と打っても正解（2 打目）", type(cu, "cu"), { how: "auto", kind: "exact", at: 2 });
  judged("Cu: Cu（大文字）と打っても正解", type(cu, "Cu"), { how: "auto", kind: "exact", at: 2 });
  eq("NaCl: 表示は元の綴り", answerLabel(card("jsci1", "concept-js1-nacl")), "NaCl");
  eq("英単語（小文字）の表示は en のまま", answerLabel(card("jhs-english1", "english-gym")), "gym");
  eq("日本語の答えの表示は en のまま", answerLabel(card("hs-worldhist1", "concept-wh1-manor")), "荘園");
  eq("計算の答え（answer と en が同じ）は en", answerLabel({ kind: "concept", en: "12", answer: "12" }), "12");
  eq("大小だけでなく字が違う answer は使わない", answerLabel({ kind: "concept", en: "cpc", answer: "CPM" }), "cpc");
}

// ---- 品詞をまたぐ別解（T6。PR #175 で札の確かな組だけに）: その訳の札が両方で確か（訳が 1 つのカードの札）で違えば結ばない。
// 札が確かでない組（訳が 2 つ以上のカードの札）・同じ品詞・品詞の無い語は今までどおり結ぶ ----
{
  const linked = (a, b) => (index.get(a)?.has(b) ?? false) || (index.get(b)?.has(a) ?? false);
  ok("similar（形「似ている」）と resemble（動「似ている」）は結ばない（どちらも訳 1 つ）", !linked("similar", "resemble"));
  ok("repeatedly（副「繰り返し」）と repetition（名「繰り返し」）は結ばない", !linked("repeatedly", "repetition"));
  ok("despite（前）と spite（名）は結ばない", !linked("despite", "spite"));
  ok("同じ品詞の別解は今までどおり結ぶ（ad・advertisement 名）", linked("ad", "advertisement"));
  ok("同じ品詞の別解は今までどおり結ぶ（begin・start 動）", linked("begin", "start"));
  judged("repeatedly の問いで repetition: 別解にならず 5 打目で ×（repe までは repeatedly と同じ）", type(card("tsl07", "english-repeatedly"), "repetition"), { how: "miss", at: 5 });
  // 札が確かでない組は結ぶ（模擬）: different が「ちがう・異なる」（訳 2 つ）なら、「異なる」の札が形かは確かでない。
  // 教材の jhs-english2 の different は Batch 73 で「違った」（訳 1 つ）にしたので、教材では differ と結ばない
  const pair = (en, ja, pos) => ({ en, ja, pos });
  const unsure = buildAlternativeIndex([pair("different", "ちがう・異なる", "形"), pair("differ", "異なる", "動")]);
  ok("模擬: different（形「ちがう・異なる」・訳 2 つ）と differ（動「異なる」）は結ぶ（札が確かでない）", unsure.get("different")?.has("differ") && unsure.get("differ")?.has("different"));
  const different = card("jhs-english2", "english-different");
  judged("模擬: different の問いで differ: 伸びる候補（different）があるので止めず、Enter で別解（Batch 69 の前と同じ）", typeAnswer(different, acceptedAnswers(different, unsure), "differ"), { how: "enter", kind: "alt", at: 6 });
  ok("教材: different（形「違った」）と differ（動「異なる」）は結ばない（Batch 73。訳が重ならない）", !linked("different", "differ"));
  judged("differ の問いで different: differ で正解し、続き ent は残り（次の語の打鍵にしない）", type(card("ngsl17", "english-differ"), "different"), { how: "auto", kind: "exact", at: 6, rest: "ent" });
  // only（副「～だけ・唯一の」）の「唯一の」は形容詞の意味で、sole・unique（形）と同じ。only は訳が 2 つなので札が確かでなく、索引で結ぶ。
  // accept（only に sole・unique、sole・unique に only。Batch 69）も残す（盤面によらず別解）。till（前）と until（接）は訳 1 つどうしで札が違うので索引では結ばないが、互いの accept にある
  const only = card("ngsl02", "english-only");
  ok("only（副・訳 2 つ）と sole・unique（形）は索引でも結ぶ（札が確かでない）", linked("only", "sole") && linked("only", "unique"));
  judged("only の問いで sole: 別解（打ち直し。× にしない）", type(only, "sole"), { how: "auto", kind: "alt", done: "sole" });
  judged("only の問いで unique: 別解", type(only, "unique"), { how: "auto", kind: "alt", done: "unique" });
  judged("sole の問いで only: 別解（前からの accept）", type(card("bsl03", "english-sole"), "only"), { how: "auto", kind: "alt", done: "only" });
  const packIds = new Set(manifest.subjects.flatMap((s) => s.categories.filter((c) => c.pack).map((c) => c.id)));
  const ngsl02Board = buildAlternativeIndex(cards.filter((c) => !packIds.has(c.category) || c.category === "ngsl02"));
  judged("基本＋ngsl02 だけの盤面でも only の問いの sole は別解（accept なので盤面によらない）", typeAnswer(only, acceptedAnswers(only, ngsl02Board), "sole"), { how: "auto", kind: "alt", done: "sole" });
  ok("till（前）と until（接）は索引では結ばない（どちらも訳 1 つ）", !linked("till", "until"));
  judged("till の問いで until: 別解のまま（互いの accept にある）", type(card("ngsl14", "english-till"), "until"), { how: "auto", kind: "alt", done: "until" });
  judged("until の問いで till: 別解のまま", type(card("ngsl03", "english-until"), "till"), { how: "auto", kind: "alt", done: "till" });
  const word = (en, ja, pos) => ({ en, ja, ...(pos ? { pos } : {}) });
  const idx = buildAlternativeIndex([word("alpha", "見本", "名"), word("beta", "見本", "動"), word("gamma", "見本"), word("delta", "見本", "名")]);
  ok("模擬: 品詞が違う 2 語は結ばない", !idx.get("alpha")?.has("beta"));
  ok("模擬: 同じ品詞の 2 語は結ぶ", idx.get("alpha")?.has("delta") && idx.get("delta")?.has("alpha"));
  ok("模擬: 片方に品詞が無ければ結ぶ（基本カテゴリには品詞が無い）", idx.get("gamma")?.has("alpha") && idx.get("gamma")?.has("beta") && idx.get("beta")?.has("gamma"));
  const multi = buildAlternativeIndex([word("ship", "送る", "動"), word("ship", "船舶", "名"), word("send", "送る", "動"), word("vessel", "船舶", "名"), word("boat", "送る", "名")]);
  ok("模擬: 同じ語でもその訳の札（送る＝動）で比べる: ship と send は結ぶ", multi.get("ship")?.has("send"));
  ok("模擬: 訳ごとの札で比べる: 「送る」の ship（動）と boat（名）は結ばない", !multi.get("ship")?.has("boat") && !multi.get("boat")?.has("ship"));
  ok("模擬: 「船舶」の ship（名）と vessel（名）は結ぶ", multi.get("ship")?.has("vessel"));
}

// ---- 品詞の札の確かさ（PR #175 の 2）: 札はカードに 1 つ（docs/PACK_FORMAT.md「2品詞なら主な方」）なので、どの訳の札かが確かなのは
// 訳が 1 つのカードだけ。訳が 2 つ以上のカードの札では結ぶのを止めない（誤った × を出さない側） ----
{
  const packIds = new Set(manifest.subjects.flatMap((s) => s.categories.filter((c) => c.pack).map((c) => c.id)));
  const board = (...packs) => buildAlternativeIndex(cards.filter((c) => !packIds.has(c.category) || packs.includes(c.category)));
  const b = board("eiken2", "nawl02");
  const approx = card("eiken2", "english-approximately");
  const circa = card("nawl02", "english-circa");
  judged("eiken2＋nawl02: approximately（副「およそ」）の問いで circa（前「およそ・〜ごろ」。訳が 2 つ）: 別解", typeAnswer(approx, acceptedAnswers(approx, b), "circa"), { how: "auto", kind: "alt", done: "circa" });
  judged("eiken2＋nawl02: circa の問いで approximately: 別解", typeAnswer(circa, acceptedAnswers(circa, b), "approximately"), { how: "auto", kind: "alt", done: "approximately" });
  const word = (en, ja, pos) => ({ en, ja, ...(pos ? { pos } : {}) });
  const idx = buildAlternativeIndex([
    word("solo", "唯一の・単独の", "形"),
    word("merely", "〜だけ・唯一の", "副"),
    word("pattern", "手本・模範", "名"),
    word("imitate", "手本・見習う", "動"),
    word("alpha", "見本", "名"),
    word("beta", "見本", "動")
  ]);
  ok("模擬: 札が違っても、片方が訳 2 つのカードなら結ぶ（merely〔副・訳 2 つ〕と solo〔形〕の「唯一の」）", idx.get("merely")?.has("solo") && idx.get("solo")?.has("merely"));
  ok("模擬: 両方が訳 2 つのカードなら札が違っても結ぶ（pattern〔名〕と imitate〔動〕の「手本」）", idx.get("pattern")?.has("imitate") && idx.get("imitate")?.has("pattern"));
  ok("模擬: 両方が訳 1 つのカードで札が違えば結ばない（alpha〔名〕と beta〔動〕）", !idx.get("alpha")?.has("beta") && !idx.get("beta")?.has("alpha"));
  const mixed = buildAlternativeIndex([word("gamma", "見本", "副"), word("gamma", "見本・試供品", "形"), word("delta", "見本", "形")]);
  ok("模擬: 同じ語の訳 1 つのカード〔副〕と訳 2 つのカード〔形〕: 相手〔形〕と札が重なるので結ぶ", mixed.get("gamma")?.has("delta") && mixed.get("delta")?.has("gamma"));
}

// ---- ヒントの 1 字（Batch 72 項目 3。js/judge.js hintStep・盤面の js/game.js useHint）: いま打っている候補の次の字。出題語の頭を打っている間は出題語の
// 次の字（前と同じ）、別解の頭を打っている間はその別解の次の字。前は出題語の次の字を足していたので、別解の頭が出題語の長さを越えると「undefined」、
// 越えなくても違う字が入って次の打鍵が ×（highschool の picture で ph → phc）。判定（spellStep・typeAnswer）は 1 打も変えない。名前で読む ----
{
  const hint = typeof JUDGE.hintStep === "function" ? JUDGE.hintStep : () => "hintStep が無い";
  const start = ["start", "begin", "commence"];
  eq("hintStep: start の問いで comme（別解 commence の頭。出題語の 5 字を越える）→ n（commence）", hint(start, "comme"), { ch: "n", target: "commence" });
  eq("hintStep: 何も打っていない・sta → 出題語の次の字（s・r。前と同じ）・b → 別解 begin の e・候補に無い頭 → null", [hint(start, ""), hint(start, "sta"), hint(start, "b"), hint(start, "x")], [{ ch: "s", target: "start" }, { ch: "r", target: "start" }, { ch: "e", target: "begin" }, null]);
  const pic = card("highschool", "english-picture");
  eq("hintStep: highschool の picture（別解 photo・photograph）で ph → o（photo）・photo → g（photograph。打ち切った別解はまだ伸びる）・pi → c（出題語）",
    [hint(cands(pic), "ph"), hint(cands(pic), "photo"), hint(cands(pic), "pi")], [{ ch: "o", target: "photo" }, { ch: "g", target: "photograph" }, { ch: "c", target: "picture" }]);
  // 全カード（綴り入力）× 候補ごとの頭: ヒントの字は 1 字で、判定器が受ける字（spellStep の ok）。出題語の頭なら出題語の次の字（前の useHint と同じ字）
  let n = 0;
  const bad = [];
  for (const w of cards) {
    if (answerModeOf(w).mode !== "spell") continue;
    const cs = cands(w);
    for (const c of cs) {
      for (let k = 0; k < c.length; k++) {
        const typed = c.slice(0, k);
        const h = hint(cs, typed);
        n++;
        const okStep = h && typeof h.ch === "string" && h.ch.length === 1 && spellStep(cs, typed, h.ch).ok && h.target.startsWith(typed + h.ch);
        const same = !w.en.startsWith(typed) || w.en.length <= k || (h && h.ch === w.en[k] && h.target === w.en);
        if (!okStep || !same) bad.push(`${w.category}:${w.id} ${JSON.stringify(typed)} → ${JSON.stringify(h)}`);
      }
    }
  }
  eq(`hintStep: 全カードの候補の頭 ${n} 通りで、1 字・判定器が受ける字・出題語の頭なら出題語の次の字（前と同じ）`, bad.slice(0, 5), []);
  ok("hintStep: 確かめた頭の数が 1 万通り以上", n > 10000);
}

// ---- 盤面の 1 字の受け方（PR #189 のレビュー 7。js/game.js acceptChar）: 受ける字は 1 つの引数だけで受け、ヒントの字は { fromHint: true } で言う。
// 前は打った字 typedChar とヒントの字 hintCh の 2 つの引数を持ち、`typedChar !== undefined` を「本当の打鍵」の印にしていた（呼び手が取り違えると、
// ヒントを打鍵に数えるか `typedSoFar += ch` に undefined を足す。ヒントの直しで消した不具合そのもの）。盤面は Node で動かないので、定義と呼び手の形を読む
{
  const src = fs.readFileSync(path.join(ROOT, "js/game.js"), "utf8");
  const def = src.match(/function acceptChar\(([^)]*\{[^}]*\}[^)]*|[^)]*)\)\s*\{/);
  const params = def ? def[1].replace(/\s+/g, " ").trim() : "";
  const body = def ? src.slice(def.index, src.indexOf("\n}\n", def.index)) : "";
  const calls = [...src.matchAll(/(?<!function )acceptChar\(([^;\n]*)\);?/g)].map((m) => m[1].trim());
  eq("acceptChar（PR #189 のレビュー 7）: 引数は 字・1 打・{ fromHint }（字の引数は 1 つ）",
    params, "ch, step = null, { fromHint = false } = {}");
  ok("acceptChar（PR #189 のレビュー 7）: 打鍵に数えるかは fromHint で決める（`!== undefined` を打鍵の印にしない）・字は ch だけを足す",
    /if \(!fromHint\) markKey\(\);/.test(body) && !/!== undefined/.test(body) && /typedSoFar \+= ch;/.test(body) && !/const ch\s*=/.test(body));
  eq("acceptChar（PR #189 のレビュー 7）: 呼び手は 3 つ（ヒントは { fromHint: true }・ほかは打った字）。undefined を字の引数に渡す呼び手は無い",
    calls.map((c) => c.replace(/\s+/g, " ")).sort(),
    ["ch, step", "step.ch, null, { fromHint: true }", "typedChar, step"]);
}

// ---- 綴り入力の候補は、綴りで打てる語だけ（PR #191 のレビュー 2。js/answers.js isSpellAlt・acceptedAnswers）。決まりは物理キーで打てる半角の字
// （0x20〜0x7e: 英字・数字・記号・空白。前の scripts/lib/spell-typeable.mjs と同じ）。利用者が作る場面カード（js/myWords.js toWordObjects の形）の日本語の別解も、
// 教材と同じく候補に入れない。空白・数字・記号の入った別解（cost per click・can't）は物理キーで打てる正しい別解なので候補に残す
// （画面キーボードは a〜z だけなのでスマホでは打てないが、答えは打てる。docs/BACKLOG） ----
{
  const hint = typeof JUDGE.hintStep === "function" ? JUDGE.hintStep : () => "hintStep が無い";
  const isSpellAlt = typeof ANSWERS.isSpellAlt === "function" ? ANSWERS.isSpellAlt : null;
  ok("isSpellAlt がある（js/answers.js。validate-words・sim-judge・マイ単語帳と同じ 1 か所）", !!isSpellAlt);
  const spell = isSpellAlt ?? (() => null);
  eq("isSpellAlt: 半角の英字・数字・記号・空白（大文字・前後の空白は落として見る）は打てる。日本語・全角・半角の外の字・空は打てない",
    ["cpc", " Copper ", "co-worker", "cost per click", "rel=canonical", "ISO27001", "can't", "B/S", "icd-10", "a large", "https化", "NISA口座", "ＣＵ", "copper（cu）", "café", " "].map((t) => spell(t)),
    [true, true, true, true, true, true, true, true, true, true, false, false, false, false, false, false]);
  const aNum = card("grammar-hs2", "concept-gh2-art-a-number-of");
  ok("教材: grammar-hs2 の a の別解 a large は候補に残す（E2E 16.5 の (13)）", acceptedAnswers(aNum, index).includes("a large"));
  // 教材: 空白・数字・記号の入った別解は候補にあり、物理キーで打つと別解として通る（× にしない。PR #191 のレビュー 4 の見直し。B/S は BS の綴り違いでそのまま正解）
  for (const [category, id, text, kind] of [
    ["startupfinance", "concept-sfin-vc", "venture capital", "alt"],
    ["webdev", "concept-web-canonical", "rel=canonical", "alt"],
    ["security", "concept-sec-isms", "iso27001", "alt"],
    ["accounting", "concept-acc-bs", "b/s", "variant"],
    ["grammar-jhs1", "concept-g1-can-cannot", "can't", "alt"],
    ["grammar-jhs1", "concept-g1-be-am", "'m", "alt"],
    ["grammar-jhs2", "concept-g2-modal-must", "have to", "alt"]
  ]) {
    const w = card(category, id);
    judged(`教材: ${category} の ${w.answer ?? w.en} の問いで ${text} は物理キーで${kind === "alt" ? "別解" : "綴り違い"}（× にしない）`, type(w, text), { kind, done: text });
  }
  // 利用者の場面カード（js/myWords.js toWordObjects の形。accept は入れたまま）
  const mine = (answer, accept) => ({ id: `my-q-${answer.toLowerCase()}`, key: answer.toLowerCase(), kind: "concept", en: answer.toLowerCase(), answer, accept, ja: "", q: `${answer} の場面`, explain: "", level: "easy", tags: ["my-concept"], subject: "english", category: "my" });
  const ssl = mine("SSL", ["https化"]);
  eq("利用者の場面カード SSL（別解 https化）: 綴り入力の候補は ssl だけ", acceptedAnswers(ssl, index), ["ssl"]);
  judged("利用者の場面カード SSL: h と打つと 1 打目で ×（日本語の別解の頭 https で止まらない）", typeAnswer(ssl, acceptedAnswers(ssl, index), "h"), { how: "miss", at: 1 });
  eq("利用者の場面カード SSL: h の後のヒントは無い（日本語の別解の字〔化〕を出さない）", hint(acceptedAnswers(ssl, index), "h"), null);
  const nisa = mine("NISA", ["NISA口座"]);
  eq("利用者の場面カード NISA（別解 NISA口座）: nisa で完成したとき、続き（口座）を残さない（次の語の速さを測らない持ち越し止めにしない）", spellStep(acceptedAnswers(nisa, index), "nis", "a"), { ok: true, typed: "nisa", done: "nisa", rests: [] });
  const cpcJa = mine("CPC", ["クリック単価"]);
  eq("利用者の場面カード CPC（別解 クリック単価）: 候補は cpc だけ・c の後のヒントは p（答えの次の字）", [acceptedAnswers(cpcJa, index), hint(acceptedAnswers(cpcJa, index), "c")], [["cpc"], { ch: "p", target: "cpc" }]);
  const cpc = mine("CPC", ["クリック単価", "cost per click", "c-p-c"]);
  const cpcC = acceptedAnswers(cpc, index);
  eq("利用者の場面カード CPC（別解 クリック単価・cost per click・c-p-c）: 候補は cpc・cost per click・c-p-c（日本語は入れない）", cpcC, ["cpc", "cost per click", "c-p-c"]);
  judged("利用者の場面カード CPC: cost per click は物理キーで別解（14 打目で完成）", typeAnswer(cpc, cpcC, "cost per click"), { how: "auto", kind: "alt", done: "cost per click", at: 14 });
  eq("利用者の場面カード CPC: cpc で完成したとき、続きは残らない・c の後のヒントは p（答え）・co の後のヒントは s（打っている別解 cost per click の次の字）",
    [spellStep(cpcC, "cp", "c"), hint(cpcC, "c"), hint(cpcC, "co")], [{ ok: true, typed: "cpc", done: "cpc", rests: [] }, { ch: "p", target: "cpc" }, { ch: "s", target: "cost per click" }]);
  // 教材: 綴り入力のカード（概念・英単語）の accept は、どれも綴りで打てる語（validate-words が NG にする。今の教材 0 件）
  // （決まりの式は検査の側にも書く: js/answers.js が無い・違う版でも、教材そのものを決まりで見る）
  const RULE = (t) => /^[\x20-\x7e]+$/.test(t);
  const offRule = cards.filter((w) => !w.calc && answerModeOf(w).mode === "spell").flatMap((w) => (Array.isArray(w.accept) ? w.accept : []).filter((a) => !RULE(String(a).toLowerCase().trim())).map((a) => `${w.category}:${w.id} ${a}`));
  eq(`教材: 綴り入力のカードの accept に、綴りで打てない別解（日本語・全角）は 0 件（今 ${offRule.length} 件）`, offRule.slice(0, 5), []);
  // 教材: 表示と検索だけの欄（aka）の名前は、綴り入力の候補・ヒントに入らない（PR #191 のレビュー 3）
  const crm = card("listing", "concept-crm");
  ok("教材: listing の CRM の aka に 顧客管理システム（Batch 73 で accept から外した日本語の名前を、表示と検索だけの欄に戻した）", Array.isArray(crm.aka) && crm.aka.includes("顧客管理システム"));
  const withAka = cards.filter((w) => Array.isArray(w.aka) && w.aka.length);
  ok(`教材: aka のあるカード（${withAka.length} 枚）はどれも綴り入力の概念カード`, withAka.length > 0 && withAka.every((w) => w.kind === "concept" && answerModeOf(w).mode === "spell"));
  ok("教材: aka の名前はどれも accept に無い（同じ語を 2 つの欄に置かない）", withAka.every((w) => w.aka.every((a) => !(w.accept ?? []).includes(a))));
  const leak = withAka.filter((w) => {
    const c = acceptedAnswers(w, index);
    const akas = w.aka.map((a) => String(a).toLowerCase().trim());
    return c.some((x) => akas.includes(x)) || akas.some((a) => typeAnswer(w, c, a).done === a) || akas.some((a) => [...a].some((_, i) => { const h = hint(c, a.slice(0, i)); return h && h.target === a; }));
  });
  eq(`教材: aka の名前（${withAka.reduce((n, w) => n + w.aka.length, 0)} 語）は綴り入力の候補に無く、打ってもその名前では完成せず、ヒントの的にもならない`, leak.map((w) => `${w.category}:${w.id}`).slice(0, 5), []);
}

// ---- few の別解（PR #191 のレビュー 5）: ngsl03 の few は訳を数えられる意味（「少数の・（数が）ほとんどない」）に絞ったので、
// 数えられない側の little を accept に置かず、訳でも結ばない（ngsl02 の little「小さい・少しの」と訳を共有すると、両方のパックを足した盤面で
// 別解の索引が結ぶ。altKey はかっこを落とすので、書き分けはかっこの外の字で）。NGSL を 01〜03 と順に足す盤面と全パックの索引でも見る ----
{
  const few = card("ngsl03", "english-few");
  const little = card("ngsl02", "english-little");
  ok("教材: ngsl03 の few の accept に little が無い", !(few.accept ?? []).includes("little"));
  const packIds = new Set(manifest.subjects.flatMap((s) => s.categories.filter((c) => c.pack).map((c) => c.id)));
  const boardOf = (packs) => buildAlternativeIndex(cards.filter((c) => !packIds.has(c.category) || packs.includes(c.category)));
  const boards = [
    ["基本＋ngsl03 の盤面", boardOf(["ngsl03"])],
    ["基本＋ngsl02＋ngsl03 の盤面", boardOf(["ngsl02", "ngsl03"])],
    ["基本＋ngsl01〜03 の盤面", boardOf(["ngsl01", "ngsl02", "ngsl03"])],
    ["全パックの索引", index]
  ];
  for (const [name, b] of boards) {
    judged(`${name}: few の問いで little は 1 打目で ×`, typeAnswer(few, acceptedAnswers(few, b), "little"), { how: "miss", at: 1 });
    judged(`${name}: few は 3 打目で正解`, typeAnswer(few, acceptedAnswers(few, b), "few"), { how: "auto", kind: "exact", at: 3 });
  }
  // 逆向き: little の問いの few（little は ngsl02 なので、ngsl02 を足した盤面）
  for (const [name, b] of boards.slice(1)) {
    judged(`${name}: little の問いで few は 1 打目で ×`, typeAnswer(little, acceptedAnswers(little, b), "few"), { how: "miss", at: 1 });
    judged(`${name}: little は 6 打目で正解`, typeAnswer(little, acceptedAnswers(little, b), "little"), { how: "auto", kind: "exact", at: 6 });
  }
  ok("全パックの索引: few と little は結ばれない（訳を共有しない）", !index.get("few")?.has("little") && !index.get("little")?.has("few"));
  // 文法の空所（few と little を分ける問題）も答えの綴りで別解の索引を引く（js/wordStore.js answersFor）ので、結ばれると相手の語が別解で通っていた
  for (const [category, id, other] of [["grammar-hs2", "concept-gh2-art-few", "little"], ["grammar-hs2", "concept-gh2-art-little", "few"], ["grammar-toeic", "concept-gt-quant-little", "few"]]) {
    const w = card(category, id);
    judged(`全パックの索引: ${category} の空所（答え ${w.en}）で ${other} は 1 打目で ×`, type(w, other), { how: "miss", at: 1 });
  }
}

if (failures.length) {
  console.error(`test-judge: ${failures.length} 件失敗（${passed} 件通過）\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log(`test-judge: ${passed} 件すべて通過`);
