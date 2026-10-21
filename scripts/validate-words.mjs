// 単語データの機械検証。データ編集後に実行する:
//   node scripts/validate-words.mjs                 この木の data/ を検証する（学校のパックと基本カテゴリは、読みでない別表記をすべて
//                                                   acceptReadings に結んでいるかも見る。docs/PACK_FORMAT.md「別表記の読み」）
//   node scripts/validate-words.mjs --root=<木>     その木の data/ を検証する（検査は js/ と scripts/quality/b71-readings.json をこの木から読む。
//                                                   scripts/quality/test-check.mjs が写しで流す）
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { readingEntries, primaryReading, normalizeReading, displayReading, hasKana, isReading, hasJapaneseScript, canonicalRomaji, createRomajiMatcher } from "../js/romaji.js";
import { shelfIdOf } from "../js/shelves.js";
import { isReadingsRecord, readingsList } from "./lib/accept-readings.mjs";
import { SPELL_ALT, isSpellAlt } from "../js/answers.js";
import { answerModeOf } from "../js/judge.js";
import { toCard } from "../js/wordData.js";

const argv = process.argv.slice(2);
const unknownArgs = argv.filter((a) => !a.startsWith("--root="));
if (unknownArgs.length) {
  console.error(`知らない引数: ${unknownArgs.join(" ")}（使い方は scripts/validate-words.mjs の先頭）`);
  process.exit(2);
}
const rootArg = argv.find((a) => a.startsWith("--root="));
const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = rootArg ? path.resolve(rootArg.slice("--root=".length)) : path.join(SCRIPTS, "..");
const DATA_DIR = path.join(ROOT, "data", "english");
const PACK_DIR = path.join(ROOT, "data", "packs");
const files = [
  ...fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json")).map((f) => path.join(DATA_DIR, f)),
  ...(fs.existsSync(PACK_DIR) ? fs.readdirSync(PACK_DIR).filter((f) => f.endsWith(".json")).map((f) => path.join(PACK_DIR, f)) : [])
];
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "manifest.json"), "utf8"));
const manifestCategories = manifest.subjects.flatMap((s) => s.categories);

const problems = [];

// 本棚: manifest の全カテゴリに棚があること（棚の無い本は本棚にも「本をさがす」にも出ない。js/shelves.js の ID_SHELF か GROUP_SHELF に足す）
for (const c of manifestCategories) {
  if (!shelfIdOf(c.id, c)) problems.push(`本棚の棚が無い ${c.id}（group=${c.group ?? ""}）: js/shelves.js の ID_SHELF か GROUP_SHELF に足す`);
}

// 日本語の答え（かな・漢字を含む）のカードは、答えか accept のどれかが「読み」になっていること（js/romaji.js readingCandidates）。
//  ・読みが 1 つもない → ゲームはローマ字で打てず、IME の全文入力に戻ってしまう
//  ・ひらがなを含む読みがない（search のような英字だけ）→ 「読みをローマ字で」の案内と合わない。答えを見せるときの読みも無い
//  ・a-z と ー だけで打てる読みがない（f2 など数字が要る）→ スマホの画面キーボードには数字が無い
//  ・各読みの標準の綴り（canonicalRomaji）で打ち終えられること（綴りの表の抜けを見つける）
//  ・主な読み（答えの下に出す読み。かなを含む最初の候補）が答えそのものの読みであること。
//    答えより短い（略語・言い換えが先頭: 浸潤麻酔 → しんま）、答えにカタカナが無いのにカタカナ（領収書 → レシート）は NG。
//    答えの読みが無いと、答えを思い出した人が打てない（りょうしゅうしょ の r で 1 ミス）
//  ・読み（3 字以上）が問題文に出ていないこと（カタカナとひらがなを同じに見る。q を写すだけで正解できる）
// kanjiOnly（漢字の書き分けが目的のカード）は学習に出さないので対象外（docs/PACK_FORMAT.md）
let readingCards = 0;
let readingCount = 0;
function checkReadings(w, where) {
  readingCards++;
  const entries = readingEntries(w);
  const cands = entries.map((e) => e.reading);
  readingCount += cands.length;
  if (cands.length === 0) {
    problems.push(`読みがない（ローマ字で打てない） ${where} (${w.answer})`);
    return;
  }
  if (!cands.some(hasKana)) problems.push(`ひらがなの読みがない ${where} (${w.answer}: ${cands.join("/")})`);
  const primary = primaryReading(entries);
  const answerChars = [...displayReading(w.answer)];
  if (primary && [...primary.reading].length < answerChars.length) problems.push(`主な読みが答えより短い（答えの読みを先頭に） ${where} (${w.answer}: ${primary.display})`);
  if (primary && !/[ァ-ヺ]/.test(w.answer) && /[ァ-ヺ]/.test(primary.display)) problems.push(`主な読みがカタカナの別の語（答えの読みを先頭に） ${where} (${w.answer}: ${primary.display})`);
  const q = normalizeReading(w.q ?? "");
  const leaked = cands.find((r) => hasKana(r) && [...r].length >= 3 && q.includes(r));
  if (leaked) problems.push(`読みが問題文に含まれる ${where} (${leaked})`);
  if (!cands.some((r) => /^[ぁ-ゖーa-z]+$/.test(r))) problems.push(`数字なしで打てる読みがない ${where} (${cands.join("/")})`);
  for (const r of cands) {
    const keys = canonicalRomaji(r, { finalN: true });
    const m = createRomajiMatcher(cands);
    const res = keys ? m.type(keys) : null;
    if (!res || res.missAt !== -1 || res.finished === null) problems.push(`読みを打ち終えられない ${where} (${r} / ${keys})`);
  }
}
// 漢字の別表記の読み（acceptReadings。docs/PACK_FORMAT.md「別表記の読み」）: { "<accept の別表記>": "<読み>" | ["<読み>", …] }。
//  ・形: オブジェクト。値は読み 1 つの文字列か、読みの文字列の空でない配列。日本語の答えのカード（kanjiOnly・計算・英作文・穴埋めを除く）だけ
//  ・別表記は accept にそのままある（書き違い・外した後の古い記録を止める）・読みでない（読みに読みは要らない）・かなか漢字を含む（英字の別解は結ばない）
//  ・読みはひらがなを含む読みで、重複せず、カードの読みの候補（[answer, ...accept] の読み）にある（読みの足し忘れ。判定は accept の読みだけで打つ）
//  ・どの読みも打ち終えられるかは上の checkReadings が、別表記の形に合うか・判定器で × にならないかは品質の規則 Q04・Q05 が見る
// 学校のパック（cardType: "school"）と基本カテゴリ（data/english）では、読みでない別表記（かなか漢字を含む）をすべて結ぶ（Batch 71 から既定。
// 規則 Q04 が数えない「漢字の並びが同じ」型〔取り締まり役／取締役〕も、ここでふさぐ。分野パックは F10 の後に広げる）
let boundAlts = 0;
let unboundStrict = 0;
const isJapaneseCard = (w, cardType) => w.kind === "concept" && !w.calc && !w.kanjiOnly && cardType !== "writing" && cardType !== "grammar" && hasJapaneseScript(w.answer);
function checkAcceptReadings(w, where, { cardType, strict }) {
  const m = w.acceptReadings;
  const accept = Array.isArray(w.accept) ? w.accept : [];
  if (m != null) {
    if (!isReadingsRecord(m)) problems.push(`acceptReadings の形（オブジェクト） ${where}`);
    else if (!isJapaneseCard(w, cardType)) problems.push(`acceptReadings は日本語の答えのカードだけ ${where}`);
    else {
      const cands = readingEntries(w).map((e) => e.reading);
      for (const [alt, v] of Object.entries(m)) {
        const list = readingsList(v);
        if (!list) {
          problems.push(`acceptReadings の値（読みか読みの配列） ${where} (${alt})`);
          continue;
        }
        boundAlts++;
        if (!accept.includes(alt)) problems.push(`acceptReadings の別表記が accept に無い ${where} (${alt})`);
        if (isReading(normalizeReading(alt))) problems.push(`acceptReadings の別表記が読み（読みに読みは要らない） ${where} (${alt})`);
        else if (!hasJapaneseScript(alt)) problems.push(`acceptReadings の別表記にかなも漢字も無い ${where} (${alt})`);
        if (new Set(list.map(normalizeReading)).size !== list.length) problems.push(`acceptReadings の読みが重複 ${where} (${alt})`);
        for (const r of list) {
          const n = normalizeReading(r);
          if (!isReading(n) || !hasKana(n)) problems.push(`acceptReadings の読みがひらがなの読みでない ${where} (${alt}: ${r})`);
          else if (!cands.includes(n)) problems.push(`acceptReadings の読みが accept に無い ${where} (${alt}: ${r})`);
        }
      }
    }
  }
  if (!strict || !isJapaneseCard(w, cardType)) return;
  const bound = isReadingsRecord(m) ? m : {};
  for (const a of accept) {
    if (typeof a !== "string" || !hasJapaneseScript(a) || isReading(normalizeReading(a)) || Object.prototype.hasOwnProperty.call(bound, a)) continue;
    unboundStrict++;
    problems.push(`学校・基本の別表記に読みを結んでいない ${where} (${a})`);
  }
}

// 綴り入力のカード（答えが英字とハイフンだけの概念カード: Cu・CPC・EU。盤面と同じ js/wordData.js toCard → js/judge.js answerModeOf が spell。
// 計算カードを除く）の accept は、画面キーボードで打てる綴りだけ（英小文字で始まり英小文字とハイフンの語〔英単語のカードの accept と同じ〕か、
// 答えに続ける語句〔a → a large〕。js/answers.js isSpellAlt の 1 か所。判定の候補も同じ決まりで絞る）。日本語の名前・読み（Cu の 銅・どう、CPC の クリック単価）と、空白・数字・記号の
// 入った英字（cost per click・rel=canonical・ISO27001）は綴り入力では打てない（画面キーボードは a〜z だけ。Batch 73・PR #191 のレビュー 4）。
// 日本語の名前・正式名を見せたい・検索で引きたいなら、表示と検索だけの欄 aka に書く（判定・ヒント・タイピング練習には使わない。PR #191 のレビュー 3）
let spellCards = 0;
let spellWithAccept = 0;
let akaCards = 0;
let akaNames = 0;
function checkSpellAccept(w, where, data, isPack) {
  const card = w.kind === "concept" && !w.calc ? toCard(w, data, isPack ? { pack: true } : null) : null;
  const spell = !!card && answerModeOf(card).mode === "spell";
  if (w.aka !== undefined) checkAka(w, where, spell, card?.en);
  if (!spell) return;
  spellCards++;
  const accept = Array.isArray(w.accept) ? w.accept : [];
  if (accept.length) spellWithAccept++;
  for (const a of accept) if (!isSpellAlt(a, card.en)) problems.push(`綴り入力のカードの accept に綴りで打てない字（英字の答えの別解は a〜z とハイフンの綴りか、答えに続ける語句だけ。日本語の名前・正式名は aka に） ${where} (${a})`);
}
// aka（表示と検索だけの名前）: 綴り入力の概念カードだけ。空でない文字列の配列で、重複しない・答えと同じでない・綴りで打てない語（打てる語は別解なら accept に）
function checkAka(w, where, spell, en) {
  if (!spell) {
    problems.push(`aka は綴り入力の概念カードだけ（英字の答えの日本語の名前・正式名。表示と検索だけ） ${where}`);
    return;
  }
  if (!Array.isArray(w.aka) || w.aka.length === 0 || w.aka.some((a) => typeof a !== "string" || !a.trim())) {
    problems.push(`aka の形（空でない文字列の配列） ${where}`);
    return;
  }
  akaCards++;
  const answer = String(w.answer ?? w.en).normalize("NFKC").toLowerCase().trim();
  const seen = new Set();
  for (const a of w.aka) {
    const k = a.normalize("NFKC").toLowerCase().trim();
    if (seen.has(k)) problems.push(`aka の語が重複 ${where} (${a})`);
    seen.add(k);
    if (k === answer) problems.push(`aka の語が答えと同じ ${where} (${a})`);
    else if (isSpellAlt(a, en)) problems.push(`aka の語が綴りで打てる（別解なら accept に。表示と検索だけの名前は綴りで打てない語） ${where} (${a})`);
    akaNames++;
  }
}

const allIds = new Set();
const entries = [];
let total = 0;

for (const fullPath of files) {
  const file = path.relative(path.join(ROOT, "data"), fullPath);
  const data = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  const seen = new Set();
  const isPack = fullPath.startsWith(PACK_DIR);

  // 分野パック: genres が tags[0] を網羅し、manifest の count と一致すること（docs/PACK_FORMAT.md）
  if (isPack) {
    if (!data.genres || typeof data.genres !== "object") problems.push(`genresなし ${file}`);
    if (!data.label || !data.blurb || !data.audience) problems.push(`label/blurb/audienceなし ${file}`);
    if (String(data.blurb ?? "").length > 40) problems.push(`blurbが長い ${file}`);
    const entry = manifestCategories.find((c) => c.id === data.category);
    if (!entry) problems.push(`manifest未登録 ${file} (category=${data.category})`);
    else if (entry.count !== data.words.length) problems.push(`manifestのcount不一致 ${file}: manifest=${entry.count} 実際=${data.words.length}`);
    const answers = new Set();
    const isWordPack = data.cardType === "word"; // レベル別パック（英検・TOEIC）: 英単語 en/ja 形式
    const isGrammar = data.cardType === "grammar"; // 文法パック: 穴埋め（q に ____ を1か所、say に完成文）
    const isSchool = data.cardType === "school"; // 義務教育パック: 日本語で答える。漢字の答えには読み（ひらがな）を accept に
    const isWriting = data.cardType === "writing"; // 英作文パック: 日本語文 → 英文を丸ごと打つ（say 必須、2〜12語）
    for (const w of data.words) {
      if (isSchool) {
        const a = String(w.answer ?? "");
        const hasKanji = /[一-龯]/.test(a);
        const hasKana = (w.accept ?? []).some((s) => /^[ぁ-ゖー・\s]+$/.test(String(s).trim()));
        // kanjiOnly: 問題文に読みが書いてある（同音異義語の書き分け・漢文の句法など）ので漢字で答えさせる。読みは accept に入れない
        if (hasKanji && !hasKana && !w.kanjiOnly) problems.push(`読み（ひらがな）が accept にない ${file}:${w.id} (${a})`);
        if (w.kanjiOnly && hasKana) problems.push(`kanjiOnly なのに accept に読みがある ${file}:${w.id}`);
        const q = String(w.q ?? "");
        const leaked = (w.accept ?? []).find((s) => String(s).length >= 2 && q.includes(String(s)));
        if (leaked) problems.push(`別解が問題文に含まれる ${file}:${w.id} (${leaked})`);
        if (String(w.explain ?? "").length > 100) problems.push(`explainが長い ${file}:${w.id}`);
      }
      if (isWriting) {
        const a = String(w.answer ?? "").trim();
        const n = a.split(/\s+/).filter(Boolean).length;
        if (!/^[A-Za-z]/.test(a) || /[ぁ-んァ-ン一-龯]/.test(a)) problems.push(`英文でない answer ${file}:${w.id}`);
        if (n < 2 || n > 14) problems.push(`answerの語数が範囲外(2〜14) ${file}:${w.id} (${n})`);
        if (data.wordBank && n > 10) problems.push(`並べ替えの文が長い(>10語) ${file}:${w.id} (${n})`);
        if (!/[ぁ-んァ-ン一-龯]/.test(String(w.q ?? ""))) problems.push(`qが日本語でない ${file}:${w.id}`);
        if (!w.say || !/^[A-Za-z]/.test(w.say)) problems.push(`sayなし/英文でない ${file}:${w.id}`);
        if (String(w.ja ?? "").length > 20) problems.push(`jaが長い ${file}:${w.id}`);
        for (const alt of w.accept ?? []) if (/[ぁ-んァ-ン一-龯]/.test(String(alt))) problems.push(`acceptが英文でない ${file}:${w.id} (${alt})`);
        if (String(w.explain ?? "").length > 100) problems.push(`explainが長い ${file}:${w.id}`);
      }
      if (isGrammar) {
        const blanks = (String(w.q ?? "").match(/____/g) || []).length;
        if (blanks !== 1) problems.push(`空欄が1か所でない ${file}:${w.id} (${blanks})`);
        if (!/（.+）/.test(String(w.q ?? ""))) problems.push(`日本語訳（全角カッコ）なし ${file}:${w.id}`);
        if (!w.say || !/^[A-Za-z]/.test(w.say)) problems.push(`sayなし/英文でない ${file}:${w.id}`);
        if (String(w.ja ?? "").length > 20) problems.push(`jaが長い ${file}:${w.id}`);
        if (String(w.answer ?? "").split(/\s+/).length > 4) problems.push(`answerが長い ${file}:${w.id}`);
      }
      if (isWordPack) {
        if (w.kind === "concept") problems.push(`英単語パックにconcept ${file}:${w.id}`);
        if (!w.pos) problems.push(`posなし ${file}:${w.id}`);
        if (String(w.ja ?? "").length > 24) problems.push(`jaが長い ${file}:${w.id} (${w.ja})`);
      } else if (w.kind !== "concept") {
        problems.push(`パックはconceptのみ ${file}:${w.id}`);
      }
      if (data.genres && !(w.tags?.[0] in data.genres)) problems.push(`genres未登録タグ ${file}:${w.id} tag=${w.tags?.[0]}`);
      if (w.answer && w.q && (isGrammar ? new RegExp(`(^|[^A-Za-z])${String(w.answer).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z]|$)`, "i").test(w.q) : w.q.includes(w.answer))) problems.push(`qに答えが含まれる ${file}:${w.id}`);
      const key = String(isWordPack ? w.en : w.answer ?? "").normalize("NFKC").toLowerCase();
      if (answers.has(key)) problems.push(`${isWordPack ? "en" : "answer"}重複 ${file}:${w.id} (${isWordPack ? w.en : w.answer})`);
      answers.add(key);
    }
  }

  for (const w of data.words) {
    total++;
    const where = `${file}:${w.id}`;

    if (!w.id || !w.en || !w.ja) problems.push(`空フィールド ${where}`);
    if (w.kind === "concept") {
      // 概念カード: id は concept-<key>、answer（打つ答え）と q（場面）が必須
      if (w.id !== `concept-${w.en}`) problems.push(`ID不整合(concept) ${where} (en=${w.en})`);
      if (!/^[a-z][a-z0-9-]*$/.test(w.en ?? "")) problems.push(`キー形式 ${where} en="${w.en}"`);
      if (typeof w.answer !== "string" || !w.answer.trim()) problems.push(`answerなし ${where}`);
      if (typeof w.q !== "string" || w.q.length < 8) problems.push(`qなし/短い ${where}`);
      if (w.accept != null && !Array.isArray(w.accept)) problems.push(`accept形式 ${where}`);
    } else {
      if (w.id !== `english-${w.en}`) problems.push(`ID不整合 ${where} (en=${w.en})`);
      if (!/^[a-z][a-z-]*$/.test(w.en ?? "")) problems.push(`スペル形式 ${where} en="${w.en}"`);
      // 別解（accept）: 同じ訳で打たれても正解として受け入れる綴り
      if (w.accept != null) {
        if (!Array.isArray(w.accept)) problems.push(`accept形式 ${where}`);
        else {
          for (const a of w.accept) {
            if (!SPELL_ALT.test(String(a))) problems.push(`accept のつづり ${where} "${a}"`); // 綴り入力の別解の決まり（js/answers.js。概念カードと同じ）
            if (String(a) === w.en) problems.push(`accept に出題語そのもの ${where}`);
          }
          if (new Set(w.accept.map(String)).size !== w.accept.length) problems.push(`accept重複 ${where}`);
        }
      }
    }
    if (!["easy", "normal", "hard"].includes(w.level)) problems.push(`level不正 ${where}`);
    // 日本語の答え: 漢字に変換せず、読みをローマ字で打つ（js/romaji.js）。読み（ひらがな）が accept に必要
    if (w.kind === "concept" && !w.calc && !w.kanjiOnly && hasJapaneseScript(w.answer)) checkReadings(w, where);
    checkSpellAccept(w, where, data, isPack);
    checkAcceptReadings(w, where, { cardType: data.cardType, strict: !isPack || data.cardType === "school" });
    // 訳に見出し語そのものを書かない（出題文に答えが出てしまい、思い出す練習にならない）。
    // 連語を示したいときは「〜に代わって（on ___ of）」のように見出し語を伏せる。
    if (w.en && String(w.ja ?? "").toLowerCase().includes(String(w.en).toLowerCase())) {
      problems.push(`訳に答えが入っている ${where} ja="${w.ja}"`);
    }
    // 例文（任意）: ex は英文で 70字以内、見出し語（または exForm の語形）を含む。exJa は 40字以内で必須
    if (w.ex != null || w.exJa != null || w.exForm != null) {
      const ex = String(w.ex ?? "");
      const form = String(w.exForm ?? w.en ?? "");
      if (!ex || !/^[A-Za-z"'(]/.test(ex)) problems.push(`exが英文でない ${where}`);
      if (ex.length > 70) problems.push(`exが長い(>70) ${where}`);
      if (!w.exJa || String(w.exJa).length > 40) problems.push(`exJaなし/長い(>40) ${where}`);
      const re = new RegExp(`(^|[^A-Za-z])${form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z]|$)`, "i");
      if (form && !re.test(ex)) problems.push(`exに見出し語が無い ${where} (${form})`);
      if (w.exForm && String(w.exForm).toLowerCase() === String(w.en).toLowerCase()) problems.push(`exFormが見出し語と同じ（不要） ${where}`);
    }
    if (!Array.isArray(w.tags) || w.tags.length === 0) problems.push(`タグなし ${where}`);
    if (seen.has(w.id)) problems.push(`ファイル内重複 ${where}`);
    seen.add(w.id);

    allIds.add(w.id);
    entries.push([file, w]);
  }
}

// Batch 71 で足した読み（scripts/quality/b71-readings.json。学校のパックと基本カテゴリの 187 枚・230 読み）: accept に残っている読みは、
// どれかの別表記の結び（acceptReadings）か主な読み（答えの読み）に属すること。結び直し・外しの残りを止める
// （台帳で 岩宿 を いわしゅく → いわじゅく に結び直して いわしゅく が残る・厩戸王 の読みの並びから うまやとおう を外して accept に残る）。
// 読みを accept から外すのはよい（記録は書き足さない）
let b71Checked = 0;
{
  const B71 = JSON.parse(fs.readFileSync(path.join(SCRIPTS, "quality", "b71-readings.json"), "utf8"));
  const fileOfCat = new Map(manifestCategories.map((c) => [c.id, c.file]));
  const byWhere = new Map(entries.map(([file, w]) => [`${file}:${w.id}`, w]));
  for (const [ref, list] of Object.entries(B71.readings ?? {})) {
    const at = ref.indexOf(":");
    const where = `${fileOfCat.get(ref.slice(0, at))}:${ref.slice(at + 1)}`;
    const w = byWhere.get(where);
    if (!w) {
      problems.push(`Batch 71 の読みの記録のカードが無い ${ref}`);
      continue;
    }
    const ents = readingEntries(w);
    const have = new Set(ents.map((e) => e.reading));
    const primary = primaryReading(ents.filter((e) => hasKana(e.reading)))?.reading;
    const bound = new Set(Object.values(isReadingsRecord(w.acceptReadings) ? w.acceptReadings : {}).flatMap((v) => readingsList(v) ?? []).map(normalizeReading));
    for (const r of list) {
      if (!have.has(r)) continue;
      b71Checked++;
      if (r !== primary && !bound.has(r)) problems.push(`Batch 71 で足した読みが、別表記の結びにも主な読みにも無い ${where} (${r})`);
    }
  }
}

// Knowledge Map拡張フィールドの整合性
const familyById = new Map();
for (const [file, w] of entries) {
  if (w.family || w.root) {
    const where = `${file}:${w.id}`;
    if (!w.root) problems.push(`familyありrootなし ${where}`);
    if (!Array.isArray(w.family)) {
      problems.push(`family形式 ${where}`);
      continue;
    }
    for (const fid of w.family) {
      if (!allIds.has(fid)) problems.push(`family先が存在しない ${where} -> ${fid}`);
      if (fid === w.id) problems.push(`family自己参照 ${where}`);
    }
    if (new Set(w.family).size !== w.family.length) problems.push(`family重複 ${where}`);

    // 同一IDの全コピーで root/family が一致すること
    const key = w.id;
    const sig = `${w.root}|${[...w.family].sort().join(",")}`;
    if (familyById.has(key) && familyById.get(key) !== sig) {
      problems.push(`コピー間不一致 ${where}`);
    }
    familyById.set(key, sig);
  }
}

// 相互参照: AのfamilyにBがいるなら、BのfamilyにもAがいること
for (const [file, w] of entries) {
  if (!Array.isArray(w.family)) continue;
  for (const fid of w.family) {
    const sig = familyById.get(fid);
    if (sig != null && !sig.includes(w.id)) {
      problems.push(`相互参照欠け ${file}:${w.id} <- ${fid} 側にない`);
    }
  }
}

// 同じ id が別ファイルにあるのは「同一単語の重複掲載」（統計を共有）としてカテゴリ間では許容するが、
// 概念カードは意味が異なりうるので id の衝突を禁止する
{
  const conceptSeen = new Map();
  for (const [file, w] of entries) {
    if (w.kind !== "concept") continue;
    if (conceptSeen.has(w.id) && conceptSeen.get(w.id) !== file) problems.push(`概念カードのid衝突 ${w.id}: ${conceptSeen.get(w.id)} と ${file}`);
    conceptSeen.set(w.id, file);
  }
}

console.log(`words: ${total} / unique ids: ${allIds.size} / family付き: ${familyById.size} / 日本語の答え: ${readingCards}枚（読み ${readingCount}・読みを結んだ別表記 ${boundAlts}）`);
console.log(`学校・基本で読みを結んでいない別表記: ${unboundStrict}件・Batch 71 で足した読みのうち accept に残る ${b71Checked}（結びか主な読みに属するかを見た）`);
console.log(`綴り入力のカード（英字の答えの概念カード）: ${spellCards}枚（accept が 1 語以上 ${spellWithAccept}枚。accept は a〜z とハイフンの綴りか答えに続ける語句だけか見た）`);
console.log(`aka（表示と検索だけの名前）: ${akaNames}語・${akaCards}枚（綴り入力の概念カードだけ・綴りで打てない語だけか見た）`);
if (problems.length === 0) {
  console.log("OK: 問題なし");
} else {
  console.log(`NG: ${problems.length}件`);
  problems.forEach((p) => console.log("  " + p));
  process.exitCode = 1; // exit() は標準出力を書き切る前に終わることがある（パイプ）
}
