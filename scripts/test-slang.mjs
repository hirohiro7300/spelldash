// スラング（Batch 80。docs/SPEC_SLANG.md）の単体: 組み込みの一覧（js/slangData.js）の中身の確かめ（id・必須の欄・長さ・打てる英語・
// 1 字ずつ／全文入力の打ち方・入れてはいけない語）と、人ごとの 3 状態の保存 spelldash_slang（js/slang.js。決まりは js/learnState.js と同じ）・
// 学ぶ回の列（これから → あやふや → 覚えた・グループで絞る）・入口 ?learn=slang
// 使い方: node scripts/test-slang.mjs
import { createHash } from "node:crypto";
import * as L from "../js/slang.js";
import { SLANG, SLANG_GROUPS } from "../js/slangData.js";
import { checkEnText, buildMyQueue, mySummary, myLearnStep, MY_JA_MAX, MY_SET_SIZE } from "../js/myWordsCore.js";
import { typeAnswer, answerModeOf, normalizeAnswer } from "../js/judge.js";
import { acceptedAnswers } from "../js/answers.js";
import { ANSWER_KINDS, applyLearnAnswer, learnDayOf, LEARN_NEW, LEARN_UNSURE, LEARN_LEARNED } from "../js/learnState.js";
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

// ===== 一覧の形 =====
const FIELDS = new Set(["id", "g", "en", "ja", "note", "ex", "exJa", "exForm", "abbr"]);
const NOTE_MAX = 50;
const EX_MAX = 80;
const EX_JA_MAX = 60;
const groups = SLANG_GROUPS.map((g) => g.id);
eq("グループは 3 つ（日常会話・仕事のチャット・略語・ネット）・絞り込みの短い名前（日常会話・仕事・ネット）", SLANG_GROUPS.map((g) => [g.id, g.label, g.short]), [["daily", "日常会話", "日常会話"], ["work", "仕事のチャット・略語", "仕事"], ["net", "ネット", "ネット"]]);
const perGroup = Object.fromEntries(groups.map((g) => [g, SLANG.filter((e) => e.g === g).length]));
ok(`項目は 140〜160（いま ${SLANG.length}）・どのグループも 40 以上（${JSON.stringify(perGroup)}）`, SLANG.length >= 140 && SLANG.length <= 160 && groups.every((g) => perGroup[g] >= 40), JSON.stringify(perGroup));
ok("グループは 3 つのどれか", SLANG.every((e) => groups.includes(e.g)), JSON.stringify(SLANG.filter((e) => !groups.includes(e.g)).map((e) => e.id)));
ok("一覧と項目は書き換えられない（凍結）", Object.isFrozen(SLANG) && SLANG.every((e) => Object.isFrozen(e)));

const seen = { id: new Set(), key: new Set(), norm: new Set(), ja: new Set() };
for (const e of SLANG) {
  const tag = e.id ?? JSON.stringify(e).slice(0, 40);
  const extra = Object.keys(e).filter((k) => !FIELDS.has(k));
  ok(`${tag}: 欄は決まった物だけ`, extra.length === 0, extra.join(","));
  ok(`${tag}: 必須の欄（id・g・en・ja・note・ex・exJa）が空でない文字列`, ["id", "g", "en", "ja", "note", "ex", "exJa"].every((k) => typeof e[k] === "string" && e[k].trim() === e[k] && e[k].length > 0));
  ok(`${tag}: id は slang-<英小文字・数字・ハイフン>`, /^slang-[a-z0-9]+(-[a-z0-9]+)*$/.test(e.id));
  ok(`${tag}: id は重ならない`, !seen.id.has(e.id));
  seen.id.add(e.id);
  const c = checkEnText(e.en);
  ok(`${tag}: 英語はマイ単語帳と同じ字（英字・数字・ハイフン・アポストロフィ・語の間の空白 1 つ・40 字まで）で、整えた形のまま`, c.ok && c.text === e.en, JSON.stringify(c));
  ok(`${tag}: 英語（大文字小文字を見ない）は重ならない`, !seen.key.has(e.en.toLowerCase()));
  seen.key.add(e.en.toLowerCase());
  ok(`${tag}: 全文入力の比べ方（空白・ハイフン・アポストロフィを見ない）でも重ならない`, !seen.norm.has(normalizeAnswer(e.en)));
  seen.norm.add(normalizeAnswer(e.en));
  ok(`${tag}: 意味は ${MY_JA_MAX} 字まで・重ならない`, e.ja.length <= MY_JA_MAX && !seen.ja.has(e.ja), `${e.ja.length}`);
  seen.ja.add(e.ja);
  ok(`${tag}: 使い方は 1 行・${NOTE_MAX} 字まで`, !/[\r\n]/.test(e.note) && e.note.length <= NOTE_MAX, `${e.note.length}`);
  ok(`${tag}: 例文は ${EX_MAX} 字まで・訳は ${EX_JA_MAX} 字まで・1 行`, e.ex.length <= EX_MAX && e.exJa.length <= EX_JA_MAX && !/[\r\n]/.test(e.ex + e.exJa), `${e.ex.length}/${e.exJa.length}`);
  ok(`${tag}: 例文は英語（ASCII）・訳は日本語を含む`, /^[\x20-\x7e]+$/.test(e.ex) && /[぀-ヿ一-鿿]/.test(e.exJa) && /[぀-ヿ一-鿿]/.test(e.ja));
  const form = e.exForm ?? e.en;
  const re = new RegExp(`(^|[^A-Za-z])${form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[^A-Za-z]|$)`, "i");
  ok(`${tag}: 例文にその語（か exForm）が入っている（答えの後に太字で見せる: js/wordExample.js）`, re.test(e.ex), `${form} / ${e.ex}`);
  if (e.exForm !== undefined) ok(`${tag}: exForm は en と違う形`, typeof e.exForm === "string" && e.exForm.toLowerCase() !== e.en.toLowerCase());
  if (e.abbr !== undefined) ok(`${tag}: abbr は true だけ`, e.abbr === true);
}

// ===== 打ち方（js/judge.js typeAnswer。盤面と同じ 1 打の関数）: 英小文字だけの語は 1 字ずつ、熟語・ハイフン・アポストロフィ・略語は全文入力 + Enter =====
const modes = { spell: 0, free: 0 };
for (const e of SLANG) {
  const card = L.slangCard(e.id);
  const key = e.en.toLowerCase();
  const wantFree = e.abbr === true || !/^[a-z]+$/.test(key);
  const { mode } = answerModeOf(card);
  modes[mode] = (modes[mode] ?? 0) + 1;
  ok(`${e.id}: 打ち方は ${wantFree ? "全文入力" : "1 字ずつ"}（ローマ字の答えにならない）`, mode === (wantFree ? "free" : "spell"), mode);
  ok(`${e.id}: カードは id・鍵（小文字）・意味・使い方・例文を持つ・画面の形は en のまま`, card.id === e.id && card.en === key && card.ja === e.ja && card.explain === e.note && card.ex === e.ex && card.exJa === e.exJa && (card.answer ?? card.en) === e.en && card.category === "slang");
  const cands = acceptedAnswers(card, null);
  const want = wantFree ? "enter" : "auto";
  for (const typed of [key, e.en, e.en.toUpperCase()]) eq(`${e.id}: 「${typed}」と打つと正解（${want === "auto" ? "Enter なし" : "Enter"}）`, typeAnswer(card, cands, typed).how, want);
}
ok(`1 字ずつの語と全文入力の語がどちらもある（${JSON.stringify(modes)}）`, modes.spell >= 20 && modes.free >= 60, JSON.stringify(modes));
const fyi = L.slangCard("slang-fyi");
for (const typed of ["fyi", "FYI", "Fyi", "f y i"]) eq(`略語 FYI を「${typed}」+ Enter で正解（大文字小文字・空白を見ない）`, typeAnswer(fyi, acceptedAnswers(fyi, null), typed).how, "enter");
const cb = L.slangCard("slang-circle-back");
for (const typed of ["circle back", "Circle Back", "circleback"]) eq(`熟語 circle back を「${typed}」+ Enter で正解`, typeAnswer(cb, acceptedAnswers(cb, null), typed).how, "enter");
eq("違う語は × （全文入力）", typeAnswer(cb, acceptedAnswers(cb, null), "circle around").how, "wrong");
const gonna = L.slangCard("slang-gonna");
eq("gonna は 1 字ずつ: 1 打ミスは ×", typeAnswer(gonna, acceptedAnswers(gonna, null), "gona").how, "miss");

// ===== 入れてはいけない語（失礼・性的・差別・薬物・暴力・商品やサービスの名前・言語やモデルの名前）: 語の一覧はハッシュで持つ（公開のリポジトリに語を書かない） =====
const DENY_TOKENS = new Set([
  "0190fadf8819c72a", "04686315786657f0", "05b88763a3ae74d5", "0a28e00567fbec54", "0abca410b29f94aa", "0e63aac7ff1851ba", "0e86439396e1060d", "0f36406745150434", "107fa0d5a51625e4",
  "128395e95ee99168", "12dbf0064641575c", "12eb45ab3b13666c", "15c2ae1df0fa202f", "18d9fd3eb003dca2", "1b27a0fefbb810b5", "1d32dd779c2baced", "1f1be5cbf55cc870", "1f86bccf35fe9647",
  "21c541bcbbc2008a", "23bdccc5b592b73a", "24e5f1ded59c14a9", "257fa33184d883ae", "27e0743080130929", "2982f13ca71a90ec", "299313f3c7b10f57", "2b70cc10d662e321", "2b783e791096008f",
  "2c356b3f14203b86", "2ccf923e6a3a5249", "2e31c641c2ccf410", "2e33e9a7fc3106de", "306a8f278fd91a76", "30ec4b622d28b8ab", "315b6dd55cb479aa", "34741dc9df2d0932", "34c0eef264270eb7",
  "36b27af21b35ed49", "36ef65abea238e46", "37e9feb81575395e", "388b60c4ac74029e", "3a1b78154d6834f5", "3ab0ee6a5c008f43", "3d6ac9b1804a3fef", "3f37d6b467ac00f0", "3f9cd25b152eba3c",
  "43e21c3e1e469666", "43e41c1756a7fa31", "43fcb5bfa8ef1281", "4614939fed00bf11", "463da604084bbfd4", "476ad342caf73693", "476e7f1ac59560db", "478e0d8e41de0240", "4a1f95fd416dfb37",
  "4a8f66ae44d2bf41", "4b06aed86785e34a", "4b97aa39e64ff901", "4da341838447f9e2", "4da9c56aa79a23a7", "4e1c815e1deb1bcc", "4e8157e90698b81e", "4eb3412fa2234b0d", "4f56498ecb68127c",
  "5010d44a7e57236e", "5040a1746fb51764", "5042a6463ba36e1f", "513fa1fa84452c40", "526a91ee20180e48", "53447ed968eed2be", "53e6ac457c3e3be0", "545ca528f774d42d", "548a8f4f79d73063",
  "5779786ba804eb7c", "5c1d2ebc54e6e5ae", "5e50b0b5cc960f51", "5efb78ab0ac8b8ce", "5fa691d1e649eace", "6041bab85cb8ac18", "637113e0b9d0a4e5", "652c983b7508228a", "68eca847a6ac5817",
  "6d4dc074a1a85e82", "6d7f01064e355946", "6e663e40ae92a34d", "6f5d99d236d348fd", "7195b682b5465478", "71f83078e5960ce6", "720da35e626ca32a", "728c1b2fb88e330f", "728f8dad22b2fcca",
  "72c09265c8f0ff05", "7471b117b166f750", "74e551d34c083998", "7527452b6ef67cec", "76648c0ce556a94e", "76b644313ac5a39e", "76f938270b63a769", "78b33aec3a2e2a0e", "78fe0efc477a32ad",
  "7a8319096ced1ed2", "7b5ecc900f09f7c2", "7c7b459da9c91ac0", "7dff0f49bef4583f", "8159fc27dda07cec", "81aa5a5783993337", "873865b52716fecd", "877a56b967fbbb38", "87980d2a7f4d087e",
  "89a609c528ec1b01", "8a15f1c29fcff8df", "8a87a1391c844541", "8a938c6647e6187c", "8bd852dc3473de65", "8bdb5b66719e9fb7", "8d5b8c0b745a5dbe", "8d898ed40ab4010f", "8fff4ad4dff7cc29",
  "90c2e447da35f4df", "90d4b551cf84573a", "912ac50ac754d71e", "9376262904eb0491", "939bf29810721b2a", "94597f6a139622ac", "96cff90cdd944415", "96d73446a3c6c899", "96df3cf152339448",
  "9794f8687ccac506", "98e31378e6116471", "99a2651b6f1eb019", "9bbad2a2e5179c56", "9c5d23b40b5d8c92", "9ddde96b8b16853e", "9f5b8d2082e85f43", "a0224e70126612b8", "a0524c7e503cc798",
  "a23e9c198bc46f5d", "a35998e3630439f6", "a3fc176e13a20928", "a53bec1d777e34a0", "a651be03160d1386", "a681e092dd3ed572", "a6e502ceb1e3d20c", "a8f64911eccb8f7d", "a93b87132db0a400",
  "ade747a7d5ac5cba", "adfb751463da315c", "ae08240c53953c82", "aee4f580ad50d3bf", "af220e8819c3831e", "b051bbc8b0e3d4c4", "b0e2b14529115e97", "b12d8c4f7c47c2ed", "b24425527f66846c",
  "b2e4b1a441254d59", "b376724443c5492a", "b5d2d3b686e5c4c9", "b6c3350437510cae", "b7957eff246c4590", "b7e2cde3f494bb8a", "bb5bf984ab095c08", "bb695d5d62853eef", "bef630c5f5ad6cff",
  "bf36599ac449db47", "c06c2efa7379d8ed", "c0a493f5b02fbc43", "c2fd9881b9da9f9b", "c44ff933cdaa7dae", "c565a12ec198c578", "c9b50ecbdee3385f", "ca6b686a3732050c", "ccd804a9c815841c",
  "cd17e0dc7b6d656d", "cd50b10973648750", "cf4b94c774be2620", "d2d34b3249d55054", "d3553d557e49d793", "d38454c9ae3a916d", "d466b647e75754c3", "d6089d5a16d1bb4a", "d63d88778d18ba60",
  "d7a180253cb26f2c", "d7f88c6f25b5809f", "d961f57de4a03d41", "d97af1bfcb43e056", "da5f95e8dab7523d", "db2d7c9d7873b073", "dc8128cbb49d35d3", "ddc4a0aa7096add1", "df10e9479ed61a4d",
  "df1808de4454d3af", "e00ceec2c07e6dc9", "e1be1874cca4cb99", "e1cebe8c0bbcb1c5", "e23caac87ab4d57f", "e5139326d3457681", "e58b36f24f6accec", "e620caa1c1b40ca6", "e63419c76df3474f",
  "e7a0f9ffa73fcc5f", "e7eafaa766c6f29b", "e88e0fa45d32628c", "e88ee956e3621fea", "e973beb4a01d5c51", "ea4c978da2b3c765", "ebbc4a04fc9d422e", "ebc387ad9fc1386d", "ec148d848c1ca2c0",
  "ec400c81c357ac0c", "ec705a59360da967", "ee4c3ba18011be1b", "eefdacc788463acd", "f12595a06c304a31", "f205333cee927064", "f41ca96f6fde81b1", "f509be30893d219b", "f522e2ac72a3bca0",
  "f8e10ef56b1818eb", "fbe25d3c3d405f3b", "fd54bb414b209e6c", "fe203d408506f99b", "ff23080078cf4d56"
]);
const DENY_ROOTS = new Set([
  "18d9fd3eb003dca2", "1b27a0fefbb810b5", "1d32dd779c2baced", "3d6ac9b1804a3fef", "5010d44a7e57236e", "8a15f1c29fcff8df", "8f88aefe460b68a4", "b10333f807bb1a4f", "da5f95e8dab7523d",
  "ec705a59360da967", "ee4c3ba18011be1b"
]);
const DENY_JA = new Set([
  "00e8569804d10f48", "133e52ca26299896", "14715e756c9dfc91", "1b0c1754a7e9e931", "22133873afb82fc4", "2713b2eee22ae7a8", "3f6029332c3a23ac", "48cb89c6f108e66b", "4ff61c5c29ff90b0",
  "56e81f447c44a008", "5c665acb8c43b687", "60c5e30218829b07", "6d8857239052a082", "8394fec7114af796", "878bf72d52997ed2", "89f19bca21b99e75", "95a8c2cdf4b9669f", "aa9484c412172ee3",
  "adcfc7389b5bc3ed", "be91405ce8ac3f48", "bef01f68c1e0571d", "cf457ea88045c944", "cfd28b76db861c3b", "e96e1913148fe994", "ead439e6fab48c28", "f9a353ae40ad8fd6"
]);
const hashOf = (s) => createHash("sha256").update("spelldash-slang:" + s).digest("hex").slice(0, 16);
const denied = [];
for (const e of SLANG) {
  const english = [e.en, e.ex, e.exForm ?? "", e.note, e.ja].join(" ").toLowerCase();
  for (const token of english.match(/[a-z0-9]+/g) ?? []) {
    if (DENY_TOKENS.has(hashOf(token))) denied.push(`${e.id}: 語 ${token}`);
    for (let i = 0; i < token.length; i++) for (let j = i + 4; j <= token.length; j++) if (DENY_ROOTS.has(hashOf(token.slice(i, j)))) denied.push(`${e.id}: 語の一部 ${token}`);
  }
  for (const text of [e.ja, e.note, e.exJa]) {
    const chars = [...text];
    for (let i = 0; i < chars.length; i++) for (let n = 1; n <= 4 && i + n <= chars.length; n++) if (DENY_JA.has(hashOf(chars.slice(i, i + n).join("")))) denied.push(`${e.id}: ${chars.slice(i, i + n).join("")}`);
  }
}
ok(`入れてはいけない語が無い（語 ${DENY_TOKENS.size}・語の一部 ${DENY_ROOTS.size}・日本語 ${DENY_JA.size} をハッシュで照合）`, denied.length === 0, denied.slice(0, 5).join(" ／ "));
// 照合そのものが効くこと（一覧の外の語で確かめる）
ok("照合の確かめ: 一覧に無い語（hello）は当たらず、一覧の語の形（ハッシュ）は当たる", !DENY_TOKENS.has(hashOf("hello")) && DENY_TOKENS.size > 150 && DENY_ROOTS.size >= 10 && DENY_JA.size >= 20);

// ===== 保存（spelldash_slang。項目ごとの状態だけ） =====
function memoryStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), keys: () => [...m.keys()], map: m };
}
eq("鍵の名前", L.SLANG_KEY, "spelldash_slang");
{
  const s = memoryStorage({ spelldash_my_words: "[]", spelldash_word_stats: "{}" });
  const t0 = Date.UTC(2026, 10, 4, 3, 0, 0);
  ok("知らない id・知らない答えの種類は書かない", !L.recordSlangAnswer("slang-nope", ANSWER_KINDS.exact, t0, s) && !L.recordSlangAnswer("slang-fyi", "maybe", t0, s) && !s.map.has("spelldash_slang"));
  ok("これから → 自力正解（exact）で書ける", L.recordSlangAnswer("slang-fyi", ANSWER_KINDS.exact, t0, s));
  ok("1 打ミスで書ける", L.recordSlangAnswer("slang-gonna", ANSWER_KINDS.miss, t0, s));
  ok("ヒントで書ける", L.recordSlangAnswer("slang-no-cap", ANSWER_KINDS.hint, t0, s));
  const map = JSON.parse(s.map.get("spelldash_slang"));
  const want = (kind) => { const r = applyLearnAnswer({ lsf: 0 }, kind, t0); const o = { ls: r.ls, lsAt: r.lsAt }; if (r.lsd !== undefined) o.lsd = r.lsd; return o; };
  eq("状態は js/learnState.js applyLearnAnswer と同じ（これから → 自力正解は 覚えた・1 打ミスとヒントは あやふや）・持つのは ls・lsd・lsAt だけ", map, { "slang-fyi": want(ANSWER_KINDS.exact), "slang-gonna": want(ANSWER_KINDS.miss), "slang-no-cap": want(ANSWER_KINDS.hint) });
  eq("状態の値", [map["slang-fyi"].ls, map["slang-gonna"].ls, map["slang-no-cap"].ls], [LEARN_LEARNED, LEARN_UNSURE, LEARN_UNSURE]);
  eq("ほかの鍵（語の記録・マイ単語帳）には書かない", [s.map.get("spelldash_my_words"), s.map.get("spelldash_word_stats"), s.keys().sort()], ["[]", "{}", ["spelldash_my_words", "spelldash_slang", "spelldash_word_stats"]]);
  // あやふや → 同じ日の自力正解は あやふやのまま、別の日の自力正解で 覚えた（中心の学習と同じ: 別の日に 2 回）
  const t1 = t0 + 60 * 1000;
  L.recordSlangAnswer("slang-gonna", ANSWER_KINDS.exact, t1, s);
  const sameDay = JSON.parse(s.map.get("spelldash_slang"))["slang-gonna"];
  const t2 = t0 + 2 * 86400000;
  L.recordSlangAnswer("slang-gonna", ANSWER_KINDS.exact, t2, s);
  const nextDay = JSON.parse(s.map.get("spelldash_slang"))["slang-gonna"];
  ok("あやふや: 同じ日の自力正解は あやふやのまま（今日を 1 日目に数える）・別の日の自力正解で 覚えた", sameDay.ls === LEARN_UNSURE && sameDay.lsd === learnDayOf(t1) && nextDay.ls === LEARN_LEARNED && !("lsd" in nextDay), JSON.stringify({ sameDay, nextDay }));
  // 覚えた → 答えを見る（reveal）で あやふや
  L.recordSlangAnswer("slang-fyi", ANSWER_KINDS.reveal, t2, s);
  eq("覚えた → 答えを見ると あやふや", JSON.parse(s.map.get("spelldash_slang"))["slang-fyi"].ls, LEARN_UNSURE);
  // 壊れた値は上書きしない
  const bad = memoryStorage({ spelldash_slang: "{not json" });
  ok("読めない保存の値（壊れた JSON）は上書きしない", !L.recordSlangAnswer("slang-fyi", ANSWER_KINDS.exact, t0, bad) && bad.map.get("spelldash_slang") === "{not json");
  const arr = memoryStorage({ spelldash_slang: "[1,2]" });
  ok("形の違う値（配列）も上書きしない", !L.recordSlangAnswer("slang-fyi", ANSWER_KINDS.exact, t0, arr) && arr.map.get("spelldash_slang") === "[1,2]");
  ok("読み: 無ければ空・壊れていれば ok: false", L.readSlangProgress(memoryStorage()).ok && JSON.stringify(L.readSlangProgress(memoryStorage()).map) === "{}" && L.readSlangProgress(bad).ok === false);
  // 一覧から外れた id の状態は残す（消さない）が数えない
  const keep = memoryStorage({ spelldash_slang: JSON.stringify({ "slang-old-gone": { ls: 2, lsAt: 1 } }) });
  L.recordSlangAnswer("slang-fyi", ANSWER_KINDS.exact, t0, keep);
  ok("一覧に無い id の状態は消さない（数えない）", JSON.parse(keep.map.get("spelldash_slang"))["slang-old-gone"]?.ls === 2 && L.countSlang("", JSON.parse(keep.map.get("spelldash_slang"))).learned === 1);
}

// ===== 数・列・グループ =====
{
  const map = { "slang-fyi": { ls: 2, lsAt: 50 }, "slang-asap": { ls: 1, lsd: 1, lsAt: 30 }, "slang-gonna": { ls: 1, lsd: 1, lsAt: 10 }, "slang-wanna": { ls: 2, lsAt: 20 } };
  const all = L.countSlang("", map);
  eq("数（すべて）: これから + あやふや + 覚えた = 項目の数", [all.total, all.new + all.unsure + all.learned, all.unsure, all.learned], [SLANG.length, SLANG.length, 2, 2]);
  const work = L.countSlang("work", map);
  eq("数（仕事）: 仕事のグループだけ", [work.total, work.unsure, work.learned], [perGroup.work, 1, 1]);
  eq("グループの値: 読めない値は すべて", ["daily", "work", "net", "", "foo", null, " work "].map((v) => L.parseGroup(v)), ["daily", "work", "net", "", "", "", "work"]);
  const idOf = (w) => w.id;
  const queue = buildMyQueue(L.slangEntries("", map), idOf);
  const newIds = SLANG.map((e) => e.id).filter((id) => !(id in map));
  eq("列（すべて）: これから（一覧の順）→ あやふや（古い順）→ 覚えた（古い順）", queue, [...newIds, "slang-gonna", "slang-asap", "slang-wanna", "slang-fyi"]);
  const wq = buildMyQueue(L.slangEntries("work", map), idOf);
  ok("列（仕事）: 仕事の項目だけ・あやふや → 覚えた が最後", wq.length === perGroup.work && wq.every((id) => SLANG.find((e) => e.id === id).g === "work") && JSON.stringify(wq.slice(-2)) === JSON.stringify(["slang-asap", "slang-fyi"]), JSON.stringify(wq.slice(-3)));
  eq("マイ単語帳の列の作り方は前のまま（id は my-<鍵>）", buildMyQueue([{ en: "kpi", ja: "x" }]), ["my-kpi"]);
  eq("回の結果（同じ語は 1 回・知らない id は数えない）", mySummary(["slang-fyi", "slang-asap", "slang-asap", "slang-nope"], L.slangEntries("", map), 1, idOf), { learned: 1, unsure: 1, dayOne: 1 });
  eq("1 回 10 語（マイ単語帳と同じ区切り）", [MY_SET_SIZE, myLearnStep({ setAnswered: 10, more: true })], [10, "set"]);
}

// ===== 学ぶ回の材料（js/game.js beginMyLearn に渡す） =====
{
  const src = L.slangLearnSource("work");
  eq("材料: 名前・戻り先（グループ付き）・語の記録に書かない印", [src.kind, src.label, src.countLabel, src.url, src.linkId, src.noStats], ["slang", "スラング", "スラング（仕事）", "/slang.html?group=work", "learnSlang", true]);
  ok("材料: グループの外のカードは出さない・中のカードは出す", src.find("slang-gonna") === null && src.find("slang-fyi")?.id === "slang-fyi");
  const all = L.slangLearnSource("bad");
  eq("材料: 読めないグループは すべて", [all.url, all.countLabel, all.list().length], ["/slang.html", "スラング", SLANG.length]);
}

// ===== 入口 ?learn=slang（js/learnQueue.js） =====
eq("入口: ?learn=slang はスラングの回", Q.parseLearnEntry("slang"), Q.LEARN_SLANG);
eq("入口: slang はモードではない（公開の語の 3 つの学習の列は作らない）", Q.parseLearnMode("slang"), null);
eq("入口: 前の値は前のまま", ["new", "unsure", "learned", "next", "my", "foo"].map((v) => Q.parseLearnEntry(v)), ["new", "unsure", "learned", "next", "my", null]);

console.log(`test-slang: ${passed} passed, ${failed} failed（項目 ${SLANG.length}: ${JSON.stringify(perGroup)}・打ち方 ${JSON.stringify(modes)}）`);
process.exit(failed ? 1 : 0);
