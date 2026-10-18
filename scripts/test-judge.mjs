// 判定器（js/judge.js）の単体テスト。ブラウザなしで数秒で終わる:
//   node scripts/test-judge.mjs
// 盤面（js/game.js）と同じ作り方でカードと候補を作り（js/wordData.js toCard → js/answers.js buildAlternativeIndex・acceptedAnswers。
// 全パックを有効にした形）、代表の語を判定器だけで再現する。失敗が 1 つでもあれば終了コード 1。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isDeepStrictEqual } from "util";
import { toCard, answerLabel } from "../js/wordData.js";
import { normalizeReading, isReading, hasKana } from "../js/romaji.js";
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

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
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
  judged("聖徳太子: 答えを見た後は主な読みだけ（別の読みは 1 打目で ×）", type(shotoku, "umayadonoouji", { revealed: true }), { how: "miss", at: 1 });
  judged("聖徳太子: 答えを見た後も主な読みは正解", type(shotoku, "shoutokutaishi", { revealed: true }), { how: "auto", at: 14 });
  // 盤面と typeAnswer が使う 1 打の関数（PR #175 の 6）: 読みの判定・1 打・状態を変えない見通し
  const { entries } = answerModeOf(shotoku);
  const m = romajiMatcherFor(entries);
  // 読みの数は教材から数える（別表記に読みを結ぶと増える。今は しょうとくたいし・うまやどのおうじ・うまやどのおう・うまやとおう の 4 つ）
  const dataReadings = [...new Set([shotoku.answer, ...(shotoku.accept ?? [])].map(normalizeReading).filter((r) => isReading(r) && hasKana(r)))];
  eq("romajiMatcherFor: 答えを見る前はすべての読み（教材の読みの数）", m.entries.map((e) => e.reading), dataReadings);
  ok("romajiMatcherFor: 教材の読みは主な読みと 厩戸皇子 の読みを含む（2 つより多い）", dataReadings.length > 2 && dataReadings[0] === "しょうとくたいし" && dataReadings.includes("うまやどのおうじ"));
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
  // 札が確かでない組は結ぶ: jhs-english2 の different は「ちがう・異なる」（訳 2 つ）なので、「異なる」の札が形かは確かでない
  ok("different（形「ちがう・異なる」・訳 2 つ）と differ（動「異なる」）は結ぶ（札が確かでない）", linked("different", "differ"));
  const different = card("jhs-english2", "english-different");
  judged("different の問いで differ: 伸びる候補（different）があるので止めず、Enter で別解（Batch 69 の前と同じ）", type(different, "differ"), { how: "enter", kind: "alt", at: 6 });
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

if (failures.length) {
  console.error(`test-judge: ${failures.length} 件失敗（${passed} 件通過）\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log(`test-judge: ${passed} 件すべて通過`);
