// 判定器（js/judge.js）の単体テスト。ブラウザなしで数秒で終わる:
//   node scripts/test-judge.mjs
// 盤面（js/game.js）と同じ作り方でカードと候補を作り（js/wordData.js toCard → js/answers.js buildAlternativeIndex・acceptedAnswers。
// 全パックを有効にした形）、代表の語を判定器だけで再現する。失敗が 1 つでもあれば終了コード 1。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isDeepStrictEqual } from "util";
import { toCard, answerLabel } from "../js/wordData.js";
import { buildAlternativeIndex, acceptedAnswers } from "../js/answers.js";
import {
  answerModeOf,
  candidatesNow,
  completesAs,
  enterAnswer,
  finishKind,
  fitsAnswer,
  isOwnAnswer,
  restsAfter,
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
  ok("gym で完成したときの続きは nasium", restsAfter(cands(gym), "gym").includes("nasium"));
  eq("gym を打った状態の Enter は gym で確定", enterAnswer(cands(gym), "gym"), "gym");

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
  eq("ad を打った途中では完成しない（advert・advertisement に伸びる）", completesAs(cands(adv), "ad"), null);
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
  eq("spellStep: 受けない字は ok=false で綴りを進めない", spellStep(cands(gym), "g", "i"), { ok: false, typed: "g", done: null });
  eq("spellStep: 大文字は小文字で比べる", spellStep(cands(gym), "gy", "M"), { ok: true, typed: "gym", done: "gym" });
  ok("fitsAnswer: 何も打っていなければ候補は残る", fitsAnswer(cands(gym), ""));
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
  const shotoku = card("elem-hist", "concept-eh-shotokutaishi"); // 聖徳太子（しょうとくたいし・うまやどのおうじ）
  judged("聖徳太子: 別の読み（厩戸皇子）を打ち切っても Enter なしで正解", type(shotoku, "umayadonoouji"), { how: "auto", at: 13 });
  judged("聖徳太子: 答えを見た後は主な読みだけ（別の読みは 1 打目で ×）", type(shotoku, "umayadonoouji", { revealed: true }), { how: "miss", at: 1 });
  judged("聖徳太子: 答えを見た後も主な読みは正解", type(shotoku, "shoutokutaishi", { revealed: true }), { how: "auto", at: 14 });
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

// ---- 品詞をまたぐ別解（T6）: 両方に品詞があって違えば結ばない。同じ品詞・品詞の無い語は今までどおり ----
{
  const linked = (a, b) => (index.get(a)?.has(b) ?? false) || (index.get(b)?.has(a) ?? false);
  ok("different（形）と differ（動）は「異なる」で結ばない", !linked("different", "differ"));
  ok("similar（形）と resemble（動）は「似ている」で結ばない", !linked("similar", "resemble"));
  ok("repeatedly（副）と repetition（名）は「繰り返し」で結ばない", !linked("repeatedly", "repetition"));
  ok("despite（前）と spite（名）は結ばない", !linked("despite", "spite"));
  ok("同じ品詞の別解は今までどおり結ぶ（ad・advertisement 名）", linked("ad", "advertisement"));
  ok("同じ品詞の別解は今までどおり結ぶ（begin・start 動）", linked("begin", "start"));
  const different = card("jhs-english2", "english-different");
  judged("different の問いで differ: 別解にならず途中で止まる（Enter で答えが開く）", type(different, "differ"), { how: "reveal", at: 6 });
  // 札は違っても同じ意味の組は、データの accept で別解のまま（索引では結ばない）:
  // only（副「～だけ・唯一の」）の「唯一の」は形容詞の意味で、sole・unique（形）と同じ。sole・unique の accept には前から only があり、
  // only の accept に sole・unique を足して対称にした（Batch 69）。till（前）と until（接）は互いの accept にある
  const only = card("ngsl02", "english-only");
  ok("only（副）と sole・unique（形）は索引では結ばない（札が違う）", !linked("only", "sole") && !linked("only", "unique"));
  judged("only の問いで sole: 別解（打ち直し。× にしない）", type(only, "sole"), { how: "auto", kind: "alt", done: "sole" });
  judged("only の問いで unique: 別解", type(only, "unique"), { how: "auto", kind: "alt", done: "unique" });
  judged("sole の問いで only: 別解（前からの accept）", type(card("bsl03", "english-sole"), "only"), { how: "auto", kind: "alt", done: "only" });
  const packIds = new Set(manifest.subjects.flatMap((s) => s.categories.filter((c) => c.pack).map((c) => c.id)));
  const ngsl02Board = buildAlternativeIndex(cards.filter((c) => !packIds.has(c.category) || c.category === "ngsl02"));
  judged("基本＋ngsl02 だけの盤面でも only の問いの sole は別解（accept なので盤面によらない）", typeAnswer(only, acceptedAnswers(only, ngsl02Board), "sole"), { how: "auto", kind: "alt", done: "sole" });
  ok("till（前）と until（接）は索引では結ばない", !linked("till", "until"));
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

if (failures.length) {
  console.error(`test-judge: ${failures.length} 件失敗（${passed} 件通過）\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log(`test-judge: ${passed} 件すべて通過`);
