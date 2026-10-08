// ローマ字入力の判定（js/romaji.js）の単体テスト。ブラウザなしで数秒で終わる:
//   node scripts/test-romaji.mjs
// 失敗が 1 つでもあれば終了コード 1。最後に、いま収録している全カードの読みが打てることも確かめる。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isDeepStrictEqual } from "util";
import {
  normalizeReading,
  displayReading,
  isReading,
  hasKana,
  isJapaneseAnswer,
  readingEntries,
  readingCandidates,
  primaryReading,
  createRomajiMatcher,
  matchRomaji,
  canonicalRomaji,
  normalizeRomajiKey,
  romajiKeyOf
} from "../js/romaji.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const failures = [];

function eq(name, actual, expected) {
  if (isDeepStrictEqual(actual, expected)) passed++;
  else failures.push(`${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}
const ok = (name, cond) => eq(name, !!cond, true);

// 打ち終わって即終了する（done）か
function types(readings, keys) {
  const r = matchRomaji(readings, keys);
  return r.alive && r.done;
}
function accepts(readings, ...variants) {
  for (const k of variants) ok(`${[].concat(readings).join("|")} ← ${k}`, types([].concat(readings), k));
}
// keys の何文字目でミスになるか（ミスなしは -1）
function missAt(readings, keys) {
  return matchRomaji([].concat(readings), keys).missAt;
}
function rejects(readings, keys, at) {
  eq(`${[].concat(readings).join("|")} ✕ ${keys}`, missAt(readings, keys), at);
}
const kanaOf = (state) => state.committed.map((s) => s.kana).join("");
const cells = (state) => state.committed.map((s) => `${s.kana}:${s.keys}`).join(" ");

// ── 1. 読みの正規化 ─────────────────────────────────────────
eq("normalize: 空白・中黒", normalizeReading("かまくら ばくふ"), "かまくらばくふ");
eq("normalize: カタカナ→ひらがな", normalizeReading("カマクラ・バクフ"), "かまくらばくふ");
eq("normalize: 半角カナ", normalizeReading("ｶﾏｸﾗﾊﾞｸﾌ"), "かまくらばくふ");
eq("normalize: 半角の長音", normalizeReading("ﾗｰﾒﾝ"), "らーめん");
eq("normalize: ヴ→ゔ", normalizeReading("ヴァイオリン"), "ゔぁいおりん");
eq("normalize: 全角英字は小文字", normalizeReading("ＰＤＣＡサイクル"), "pdcaさいくる");
eq("normalize: = と ・", normalizeReading("ジャン=ジャック・ルソー"), "じゃんじゃっくるそー");
eq("normalize: 数字とハイフン", normalizeReading("3-2-1ルール"), "321るーる");
eq("normalize: かっこは記号だけ落とす", normalizeReading("マガリャンイス(マゼラン)"), "まがりゃんいすまぜらん");
eq("normalize: 句読点", normalizeReading("いぬ、ねこ。"), "いぬねこ");
eq("display: カタカナと大文字を残す", displayReading("ＰＤＣＡ サイクル"), "PDCAサイクル");
ok("isReading: ひらがな", isReading("かまくらばくふ"));
ok("isReading: ー・英字・数字", isReading("pdcaさいくる") && isReading("f2") && isReading("らーめん"));
ok("isReading: 漢字は読みでない", !isReading(normalizeReading("鎌倉幕府")));
ok("isReading: 漢字まじりは読みでない", !isReading(normalizeReading("鎌倉ばくふ")));
ok("isReading: 々 は読みでない", !isReading(normalizeReading("ときどき々")));
ok("isReading: 空文字は読みでない", !isReading(""));
ok("hasKana", hasKana("dnaかんてい") && !hasKana("search"));
ok("isJapaneseAnswer: 漢字", isJapaneseAnswer({ en: "鎌倉幕府" }));
ok("isJapaneseAnswer: 概念カード（answer）", isJapaneseAnswer({ en: "kamakura-bakufu", answer: "鎌倉幕府", kind: "concept" }));
ok("isJapaneseAnswer: 英単語は対象外", !isJapaneseAnswer({ en: "apple" }));
ok("isJapaneseAnswer: 英語の答え（Quality Score）は対象外", !isJapaneseAnswer({ en: "Quality Score", answer: "Quality Score" }));

// ── 2. カードから候補を作る ──────────────────────────────────
const kamakura = { kind: "concept", en: "鎌倉幕府", answer: "鎌倉幕府", accept: ["かまくらばくふ", "鎌倉ばくふ", "カマクラバクフ", "かまくら ぼくふ"] };
eq("readingCandidates: 漢字の答えは落とし、重複を除き、データ順", readingCandidates(kamakura), ["かまくらばくふ", "かまくらぼくふ"]);
eq("readingEntries: 表示形", readingEntries({ answer: "ファシズム", accept: ["ふぁしずむ"] }), [{ reading: "ふぁしずむ", display: "ファシズム" }]);
eq("readingCandidates: 生データ（answer が答え・en は id）", readingCandidates({ kind: "concept", en: "x1", answer: "コンバージョン", accept: ["CV", "cv"] }), ["こんばーじょん", "cv"]);
eq("readingCandidates: 読みのない漢字カードは空（従来の入力に戻す）", readingCandidates({ en: "需要", accept: ["ニーズ/需要"] }), []); // ニーズ/需要 → ニーズ需要 は漢字入り
eq("readingCandidates: 漢字のみ", readingCandidates({ en: "需要", accept: [] }), []);
eq("primaryReading: ひらがなを含む最初", primaryReading(["imp", "いんぷれっしょん"]), "いんぷれっしょん");
eq("primaryReading: ラテン文字だけなら先頭", primaryReading(["search", "kensaku"]), "search");
eq("primaryReading: 空", primaryReading([]), null);

// ── 3. 清音（五十音）と訓令式・ヘボン式 ─────────────────────────
const SEION = {
  あ: ["a"], い: ["i", "yi"], う: ["u", "wu", "whu"], え: ["e"], お: ["o"],
  か: ["ka", "ca"], き: ["ki"], く: ["ku", "cu", "qu"], け: ["ke"], こ: ["ko", "co"],
  さ: ["sa"], し: ["shi", "si", "ci"], す: ["su"], せ: ["se", "ce"], そ: ["so"],
  た: ["ta"], ち: ["chi", "ti"], つ: ["tsu", "tu"], て: ["te"], と: ["to"],
  な: ["na"], に: ["ni"], ぬ: ["nu"], ね: ["ne"], の: ["no"],
  は: ["ha"], ひ: ["hi"], ふ: ["fu", "hu"], へ: ["he"], ほ: ["ho"],
  ま: ["ma"], み: ["mi"], む: ["mu"], め: ["me"], も: ["mo"],
  や: ["ya"], ゆ: ["yu"], よ: ["yo"],
  ら: ["ra"], り: ["ri"], る: ["ru"], れ: ["re"], ろ: ["ro"],
  わ: ["wa"], を: ["wo", "o"], ゐ: ["wi", "wyi"], ゑ: ["we", "wye"], ん: ["nn", "n'", "xn", "n"]
};
for (const [kana, list] of Object.entries(SEION)) accepts(kana, ...list);
// カタカナで書いた読みも同じ
accepts("カキクケコ", "kakikukeko");
accepts("シチツフ", "shichitsufu", "sitituhu");

// ── 4. 濁音・半濁音 ─────────────────────────────────────────
const DAKUON = {
  が: ["ga"], ぎ: ["gi"], ぐ: ["gu"], げ: ["ge"], ご: ["go"],
  ざ: ["za"], じ: ["ji", "zi"], ず: ["zu"], ぜ: ["ze"], ぞ: ["zo"],
  だ: ["da"], ぢ: ["di", "ji", "zi"], づ: ["du", "zu"], で: ["de"], ど: ["do"],
  ば: ["ba"], び: ["bi"], ぶ: ["bu"], べ: ["be"], ぼ: ["bo"],
  ぱ: ["pa"], ぴ: ["pi"], ぷ: ["pu"], ぺ: ["pe"], ぽ: ["po"],
  ゔ: ["vu"]
};
for (const [kana, list] of Object.entries(DAKUON)) accepts(kana, ...list);
// ぢ・づ は IME と違い ji・zu でも受ける（書院造 しょいんづくり を shoinzukuri と打った人は読みを思い出せている）。表示は読みの字のまま
accepts("しょいんづくり", "shoinzukuri", "shoinndukuri");
accepts("はなぢ", "hanaji", "hanadi", "hanazi");
accepts("かぶをまもる", "kabuwomamoru", "kabuomamoru");
{
  const m = createRomajiMatcher(["あづち"]);
  m.type("azuchi");
  eq("zu と打っても づ と見せる", cells(m.state()), "あ:a づ:zu ち:chi");
}
rejects("ず", "du", 0); // 逆（ず を du）は受けない
rejects("じ", "di", 0);

// ── 5. 拗音 ────────────────────────────────────────────────
for (const [head, c] of [["き", "k"], ["ぎ", "g"], ["に", "n"], ["ひ", "h"], ["び", "b"], ["ぴ", "p"], ["み", "m"], ["り", "r"]]) {
  accepts(`${head}ゃ${head}ゅ${head}ょ`, `${c}ya${c}yu${c}yo`);
}
accepts("しゃしゅしょ", "shashusho", "syasyusyo");
accepts("しぇ", "she", "sye");
accepts("ちゃちゅちょ", "chachucho", "tyatyutyo", "cyacyucyo");
accepts("ちぇ", "che", "tye", "cye");
accepts("じゃじゅじょ", "jajujo", "zyazyuzyo", "jyajyujyo");
accepts("じぇ", "je", "zye", "jye");
accepts("ぢゃ", "dya", "ja", "zya", "jya");
// 小さいかなを分けて打つ
accepts("きゃ", "kixya", "kilya");
accepts("しょう", "shixyou", "silyou");
rejects("きゃ", "kia", 2);

// ── 6. 外来音・小さいかな ────────────────────────────────────
accepts("ふぁ", "fa", "fwa", "huxa", "fula");
accepts("ふぃふぇふぉ", "fifefo", "fwifwefwo");
accepts("ふゅ", "fyu");
accepts("ゔぁゔぃゔぇゔぉ", "vavivevo");
accepts("ヴァイオリン", "vaiorinn", "vuxaiorin");
accepts("てぃ", "thi", "texi");
accepts("でぃ", "dhi", "dexi");
accepts("でゅ", "dhu");
accepts("とぅ", "twu", "toxu");
accepts("どぅ", "dwu", "doxu");
accepts("うぃ", "wi", "whi", "uxi");
accepts("うぇ", "we", "whe", "uxe");
accepts("うぉ", "who", "uxo");
accepts("いぇ", "ye", "ixe");
accepts("つぁ", "tsa", "tsuxa");
accepts("くぁ", "qa", "kwa", "kuxa");
accepts("ぐぁ", "gwa");
accepts("ぁぃぅぇぉ", "xaxixuxexo", "lalilulelo");
accepts("ゃゅょゎ", "xyaxyuxyoxwa", "lyalyulyolwa");
accepts("ゕゖ", "xkaxke", "lkalke");
accepts("らんでぃんぐぺーじ", "randhingupe-ji");
accepts("おくたゔぃあぬす", "okutavianusu");
accepts("ひんどぅーきょう", "hindwu-kyou", "hindoxu-kyou");
accepts("ゆゑ", "yuwe");
accepts("ゐる", "wiru");

// ── 7. 促音（っ）────────────────────────────────────────────
accepts("きって", "kitte", "kixtute", "kiltute", "kixtsute", "kiltsute");
accepts("まっちゃ", "maccha", "matcha", "mattya", "maccya");
accepts("ざっし", "zasshi", "zassi");
accepts("いっぱい", "ippai");
accepts("がっこう", "gakkou");
accepts("ばっぐ", "baggu");
accepts("べっど", "beddo");
accepts("こっふぁ", "koffa"); // 外来音の前も子音を重ねる
accepts("あっ", "axtu", "altsu"); // 語末は xtu 系だけ
accepts("っあ", "xtua"); // 母音の前も xtu 系
accepts("っっか", "kkka", "xtukka");
rejects("きって", "kite", 3);
rejects("きって", "kitsute", 3);
rejects("あっ", "att", 1);
rejects("まっちゃ", "mathcha", 3);

// ── 8. 撥音（ん）───────────────────────────────────────────
accepts("かんな", "kanna", "kannna", "kan'na", "kaxnna");
accepts("かんい", "kanni", "kan'i", "kaxni");
rejects("かんい", "kani", 3); // n 1 つの後に母音は ん にならない
accepts("かに", "kani");
rejects("かに", "kanni", 3);
accepts("かんや", "kannya", "kan'ya");
rejects("かんや", "kanya", 3); // y の前も n 1 つでは ん にならない
accepts("こんにちは", "konnichiha", "konnnichiha", "kon'nichiha");
rejects("こんにちは", "konichiha", 3);
accepts("こんにゃく", "konnyaku", "konnnyaku");
rejects("こんにゃく", "konyaku", 3);
accepts("しんぶん", "shinbun", "sinbun", "shinnbunn", "shin'bun");
rejects("しんぶん", "shimbun", 3); // ヘボン式の m は受け付けない（IME と同じ）
accepts("あんない", "annai", "annnai");
accepts("せんぱい", "senpai");
rejects("せんぱい", "sempai", 2);
accepts("ほんー", "hon-"); // ー の前の n 1 つは ん
{
  const r = matchRomaji(["にほん"], "nihon");
  ok("語末の ん は n 1 つで終わる", r.done);
  ok("endedWithSingleN（n 1 つで終わった）", r.endedWithSingleN);
  ok("n 1 つで終えた後は 2 つ目の n を続けられる（canContinue）。長い読みは無い（canGrow でない）", r.canContinue && !r.canGrow);
  const r2 = matchRomaji(["にほん"], "nihonn");
  ok("語末の ん は nn でも終わる", r2.done && !r2.endedWithSingleN && !r2.canContinue);
  const m = createRomajiMatcher(["にほん"]);
  m.type("nihon");
  ok("nihon の後の n は nihonn として受ける（呼ぶ側は done で止める）", m.feed("n").done);
  const after = m.feed("a");
  ok("終わった後の別のキーはミス", !after.ok && !after.ignored);
}

// ── 9. 長音（ー）────────────────────────────────────────────
accepts("ラーメン", "ra-menn", "ra-men");
rejects("ラーメン", "raamen", 2);
eq("ー キーは -", normalizeRomajiKey("ー"), "-");
eq("全角の － は -", normalizeRomajiKey("－"), "-");
eq("半角の ｰ は -", normalizeRomajiKey("ｰ"), "-");
{
  const m = createRomajiMatcher(["らーめん"]);
  ok("ー を打つ", m.type("raー").ok);
  eq("ー の表示", cells(m.state()), "ら:ra ー:-");
}

// ── 10. ラテン文字・数字 ─────────────────────────────────────
accepts("PDCAサイクル", "pdcasaikuru", "PDCASAIKURU");
accepts("DNA", "dna");
accepts("dnaかんてい", "dnakantei");
accepts("cvあくしょん", "cvakushon");
accepts("f2", "f2");
rejects("f2", "f3", 1);
accepts("3-2-1ルール", "321ru-ru");
eq("全角数字のキー", normalizeRomajiKey("２"), "2");
{
  const m = createRomajiMatcher(["PDCAサイクル"]);
  m.type("pdcasa");
  eq("ラテン文字は書いてあるとおりに見せる", kanaOf(m.state()), "PDCAサ");
}

// ── 11. 複数の読み ──────────────────────────────────────────
{
  const rs = readingCandidates(kamakura);
  const a = matchRomaji(rs, "kamakurabakufu");
  ok("かまくらばくふ で終わる", a.done && a.finished === 0);
  const b = matchRomaji(rs, "kamakurabokufu");
  ok("かまくらぼくふ でも終わる", b.done && b.finished === 1);
  eq("どちらでもない綴りはミス", matchRomaji(rs, "kamakurabe").missAt, 9);
  const m = createRomajiMatcher(rs);
  m.type("kamakurab");
  const s = m.state();
  ok("分かれる前は両方が残る", s.canGrow && !s.done && s.finished === null);
  ok("ミスにした読みは消える", m.feed("o").ok && m.state().candidate === 1);
  ok("ば の読みは消えた", !m.feed("a").ok);
}
{
  const rs = ["めいん", "めいんこんばーじょん"];
  const a = matchRomaji(rs, "mein");
  ok("短い読みを打ち終えたら done（長い読みが残っていても即終了。canGrow で分かる）", a.done && a.finished === 0 && a.canGrow && a.canContinue);
  const b = matchRomaji(rs, "meinn");
  ok("nn でも同じ", b.done && b.finished === 0 && b.canGrow);
  eq("終えた短い読みの表示", cells(a), "め:me い:i ん:n");
  const m = createRomajiMatcher(rs);
  m.type("mein");
  ok("終えた後も長い読みの続きは打てる（呼ぶ側が次の語に持ち越さない判断に使う）", m.type("konba-jonn").done && m.state().finished === 1 && !m.state().canContinue);
  ok("長い読みで終わる", types(rs, "meinkonba-jon") && matchRomaji(rs, "meinkonba-jon").finished === 1);
  ok("長い読み（nn）", types(rs, "meinnkonnba-jonn"));
}
{
  const rs = ["imp", "いんぷれっしょん"];
  ok("ラテン文字だけの読みでも終わる", types(rs, "imp"));
  ok("かなの読みでも終わる", types(rs, "innpuresshonn"));
  const m = createRomajiMatcher(rs);
  m.feed("i");
  eq("表示は主な読み（かな）を追う", kanaOf(m.state()), "い");
}
{
  const rs = ["ゐ", "うぃ"];
  const r = matchRomaji(rs, "wi");
  ok("同じ打鍵で 2 つの読みが終わったら先の読み", r.done && r.finished === 0);
}

// ── 12. 記号・空白は打たなくてよい ───────────────────────────
accepts(readingCandidates({ answer: "ジャン=ジャック・ルソー" }), "jannjakkuruso-");
accepts(readingCandidates({ answer: "インテント マッチ" }), "intentomatti");
{
  const m = createRomajiMatcher(["インテント マッチ"]);
  m.type("intento");
  const r = m.feed(" ");
  ok("空白キーは無視（ミスにしない）", !r.ok && r.ignored);
  eq("無視したキーは打鍵に入らない", m.keys, "intento");
  ok("Enter は無視", m.feed("Enter").ignored);
  ok("かなの文字は無視", m.feed("ち").ignored);
  ok("続きを打てる", m.type("matti").done);
}

// ── 13. ミスの判定と状態 ─────────────────────────────────────
{
  const m = createRomajiMatcher(["かまくら"]);
  const r = m.feed("x");
  ok("続かないキーはミス", !r.ok && !r.ignored && !r.done);
  eq("ミスのときの正しいキー", r.expected, "k");
  eq("ミスは打鍵に入らない", m.keys, "");
  ok("大文字は小文字として受ける", m.feed("K").ok);
  const r2 = m.feed("i");
  eq("途中のミス（k の後）", [r2.ok, r2.expected], [false, "a"]);
  m.reset();
  eq("reset", [m.keys, m.state().committed.length, m.state().pending], ["", 0, ""]);
}
eq("expected: かんい を kan まで打った後は n", matchRomaji(["かんい"], "kan").expected, "n");
eq("expected: まっちゃ を mat まで打った後", matchRomaji(["まっちゃ"], "mat").expected, "c");

// ── 14. 2 段表示（かな＋打鍵）─────────────────────────────────
{
  const m = createRomajiMatcher(["きゃく"]);
  m.feed("k");
  eq("k: まだかなにならない", [kanaOf(m.state()), m.state().pending], ["", "k"]);
  m.feed("y");
  eq("ky", [kanaOf(m.state()), m.state().pending], ["", "ky"]);
  m.feed("a");
  eq("kya: きゃ が 1 つにまとまる", [cells(m.state()), m.state().pending], ["きゃ:kya", ""]);
  m.feed("k");
  eq("kyak", [cells(m.state()), m.state().pending], ["きゃ:kya", "k"]);
  const r = m.feed("u");
  ok("kyaku で終わる", r.done);
  eq("終わった表示", cells(m.state()), "きゃ:kya く:ku");
}
{
  const m = createRomajiMatcher(["まっか"]);
  m.type("mak");
  eq("子音 1 つでは っ にしない", [cells(m.state()), m.state().pending], ["ま:ma", "k"]);
  m.feed("k");
  eq("kk で っ が出る", [cells(m.state()), m.state().pending], ["ま:ma っ:k", "k"]);
  m.feed("a");
  eq("makka", cells(m.state()), "ま:ma っ:k か:ka");
}
{
  const m = createRomajiMatcher(["まっちゃ"]);
  m.type("mat");
  eq("t だけでは っ にしない", [cells(m.state()), m.state().pending], ["ま:ma", "t"]);
  m.feed("c");
  eq("tc で っ", [cells(m.state()), m.state().pending], ["ま:ma っ:t", "c"]);
  m.type("ha");
  eq("matcha", cells(m.state()), "ま:ma っ:t ちゃ:cha");
}
{
  const m = createRomajiMatcher(["かんい"]);
  m.type("kan");
  eq("n 1 つの ん は次の打鍵まで n のまま", [cells(m.state()), m.state().pending], ["か:ka", "n"]);
  m.feed("n");
  eq("nn で ん", [cells(m.state()), m.state().pending], ["か:ka ん:nn", ""]);
}
{
  const m = createRomajiMatcher(["かんぶ"]);
  m.type("kanb");
  eq("子音が来たら n 1 つの ん が決まる", [cells(m.state()), m.state().pending], ["か:ka ん:n", "b"]);
}
{
  const m = createRomajiMatcher(["こんにちは"]);
  m.type("konn");
  eq("konn は ん（nn）", cells(m.state()), "こ:ko ん:nn");
  m.feed("i");
  eq("konni は ん（n）＋に に読み直す", cells(m.state()), "こ:ko ん:n に:ni");
}
{
  const m = createRomajiMatcher(["ファシズム"]);
  m.type("fashi");
  eq("カタカナの読みはカタカナで見せる", cells(m.state()), "ファ:fa シ:shi");
}
{
  const m = createRomajiMatcher(["しんぶん"]);
  m.type("sh");
  eq("sh は保留", [kanaOf(m.state()), m.state().pending], ["", "sh"]);
  m.type("i");
  eq("shi", cells(m.state()), "し:shi");
}
{
  // まだ打っていない読みは表示データに出ない（思い出す練習なので）
  const m = createRomajiMatcher(["かまくらばくふ"]);
  m.type("ka");
  const json = JSON.stringify(m.state());
  ok("打っていない かな は state に出ない", !/[まくらばふ]/.test(json));
  m.feed("m");
  ok("保留の打鍵も打った分だけ", !/[まくらばふ]/.test(JSON.stringify(m.state())) && m.state().pending === "m");
}
{
  // 表示のかなを並べると、打ち終えた読みの表記になる
  for (const r of ["きょうと", "がっこう", "ふぁしずむ", "ラーメン", "PDCAサイクル", "いっしょうけんめい", "ヴァイオリン"]) {
    const m = createRomajiMatcher([r]);
    m.type(canonicalRomaji(r));
    eq(`表示を並べると ${r}`, kanaOf(m.state()), displayReading(r));
  }
}

// ── 15. ヒント ──────────────────────────────────────────────
{
  const m = createRomajiMatcher(["きょうと"]);
  eq("firstKana: 拗音は 2 文字", m.firstKana(), "きょ");
  eq("hint: 最初", m.hint(), { kana: "きょ", keys: "kyo" });
  m.feed("k");
  eq("hint: 打ち途中なら残りのキー", m.hint(), { kana: "きょ", keys: "yo" });
  m.type(m.hint().keys);
  eq("hint を打つと 1 かな進む", kanaOf(m.state()), "きょ");
}
eq("firstKana: ファ", createRomajiMatcher(["ファシズム"]).firstKana(), "ファ");
eq("firstKana: 主な読み", createRomajiMatcher(["imp", "いんぷれっしょん"]).firstKana(), "い");
eq("firstKana: 1 文字", createRomajiMatcher(readingCandidates(kamakura)).firstKana(), "か");
{
  const m = createRomajiMatcher(["かんい"]);
  m.type("kan");
  eq("hint: n 1 つの後は nn に", m.hint(), { kana: "ん", keys: "n" });
}
for (const r of ["かまくらばくふ", "しんぶん", "まっちゃ", "こんにちは", "ひんどぅーきょう", "PDCAサイクル"]) {
  const m = createRomajiMatcher([r]);
  let steps = 0;
  let res = { done: false };
  while (!res.done && steps < 40) {
    const h = m.hint();
    if (!h) break;
    res = m.type(h.keys);
    if (res.missAt !== -1) break;
    steps++;
  }
  ok(`ヒントだけで ${r} を打ち終える`, res.done && m.hint() === null);
}

// ── 16. キーボードのイベント ─────────────────────────────────
eq("key a", romajiKeyOf({ key: "a", code: "KeyA" }), "a");
eq("Shift+A", romajiKeyOf({ key: "A", code: "KeyA", shiftKey: true }), "a");
eq("IME 処理中（Process）は code", romajiKeyOf({ key: "Process", code: "KeyK" }), "k");
eq("Unidentified は code", romajiKeyOf({ key: "Unidentified", code: "Digit3" }), "3");
eq("JIS かな配列（ち）は code", romajiKeyOf({ key: "ち", code: "KeyA" }), "a");
eq("ー キー", romajiKeyOf({ key: "ー", code: "IntlYen" }), "-");
eq("- キー", romajiKeyOf({ key: "-", code: "Minus" }), "-");
eq("Process の Minus", romajiKeyOf({ key: "Process", code: "Minus" }), "-");
eq("テンキー", romajiKeyOf({ key: "Process", code: "Numpad7" }), "7");
eq("アポストロフィ", romajiKeyOf({ key: "'", code: "Quote" }), "'");
eq("空白は null", romajiKeyOf({ key: " ", code: "Space" }), null);
eq("Process の空白は null", romajiKeyOf({ key: "Process", code: "Space" }), null);
eq("Enter は null", romajiKeyOf({ key: "Enter", code: "Enter" }), null);
eq("Backspace は null", romajiKeyOf({ key: "Backspace", code: "Backspace" }), null);
eq("Shift 単体は null", romajiKeyOf({ key: "Shift", code: "ShiftLeft" }), null);
eq("Ctrl+A は null", romajiKeyOf({ key: "a", code: "KeyA", ctrlKey: true }), null);
eq("Cmd+R は null", romajiKeyOf({ key: "r", code: "KeyR", metaKey: true }), null);
eq("Shift+- （_）は null", romajiKeyOf({ key: "_", code: "Minus", shiftKey: true }), null);
eq("画面キーボード（code なし）", romajiKeyOf({ key: "z" }), "z");
eq("normalizeRomajiKey: 複数文字は null", normalizeRomajiKey("ka"), null);
eq("normalizeRomajiKey: 全角英字", normalizeRomajiKey("Ｋ"), "k");

// ── 17. canonicalRomaji ─────────────────────────────────────
eq("canonical: かまくらばくふ", canonicalRomaji("かまくらばくふ"), "kamakurabakufu");
eq("canonical: ん は nn", canonicalRomaji("しんぶん"), "shinnbunn");
eq("canonical: finalN", canonicalRomaji("しんぶん", { finalN: true }), "shinnbun");
eq("canonical: っ", canonicalRomaji("きって"), "kitte");
eq("canonical: ー とカタカナ", canonicalRomaji("ラーメン"), "ra-menn");
eq("canonical: 読みでなければ null", canonicalRomaji("鎌倉"), null);
// ひらがなの全文字（U+3041〜U+3096）と ー が打てる
{
  const bad = [];
  for (let cp = 0x3041; cp <= 0x3096; cp++) {
    const ch = String.fromCharCode(cp);
    const k = canonicalRomaji(ch);
    if (!k || !types([ch], k)) bad.push(ch);
  }
  eq("ひらがな全文字に綴りがある", bad, []);
  ok("ー だけの読み", types(["ー"], "-"));
}

// ── 18. 空の候補 ────────────────────────────────────────────
{
  const m = createRomajiMatcher([]);
  ok("候補なし: どのキーもミス", !m.feed("a").ok);
  eq("候補なし: primary / firstKana / hint", [m.primary, m.firstKana(), m.hint()], [null, "", null]);
  ok("候補なし: matchRomaji は alive でない", !matchRomaji([], "").alive);
}

// ── 19. 収録データの読みがすべて打てる ─────────────────────────
{
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "manifest.json"), "utf8"));
  const files = new Set(manifest.subjects.flatMap((s) => s.categories.map((c) => c.file)));
  const bad = [];
  let readings = 0;
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data", file), "utf8"));
    for (const w of data.words) {
      if (w.calc || w.kanjiOnly || !isJapaneseAnswer(w)) continue;
      const entries = readingEntries(w);
      for (const e of entries) {
        readings++;
        for (const finalN of [false, true]) {
          const keys = canonicalRomaji(e.reading, { finalN });
          // その読みだけで: 打ち終わって、表示を並べると読みの表記になる
          const one = createRomajiMatcher([e]);
          const r1 = keys ? one.type(keys) : null;
          if (!r1 || r1.missAt !== -1 || !r1.done) bad.push(`${file}:${w.id} ${e.reading} (${keys})`);
          else if (kanaOf(one.state()) !== e.display) bad.push(`表示 ${file}:${w.id} ${kanaOf(one.state())} ≠ ${e.display}`);
          // カードの全候補と一緒でも、ミスにならず打ち終えた読みがある（でも／demo のように同じ打鍵で別の読みが終わることもある）
          const all = createRomajiMatcher(entries);
          const r2 = keys ? all.type(keys) : null;
          if (!r2 || r2.missAt !== -1 || r2.finished === null) bad.push(`全候補 ${file}:${w.id} ${e.reading} (${keys})`);
        }
      }
    }
  }
  eq(`収録データの読み ${readings} 件がすべて打てる`, bad.slice(0, 10), []);
}

if (failures.length) {
  console.error(`romaji: ${failures.length} 件失敗（成功 ${passed} 件）`);
  for (const f of failures) console.error(`  ✕ ${f}`);
  process.exit(1);
}
console.log(`romaji: OK（${passed} 件）`);
