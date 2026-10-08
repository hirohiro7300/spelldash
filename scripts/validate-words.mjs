// 単語データの機械検証。データ編集後に実行する:
//   node scripts/validate-words.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { readingEntries, primaryReading, normalizeReading, displayReading, hasKana, hasJapaneseScript, canonicalRomaji, createRomajiMatcher } from "../js/romaji.js";
import { shelfIdOf } from "../js/shelves.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
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
            if (!/^[a-z][a-z-]*$/.test(String(a))) problems.push(`accept のつづり ${where} "${a}"`);
            if (String(a) === w.en) problems.push(`accept に出題語そのもの ${where}`);
          }
          if (new Set(w.accept.map(String)).size !== w.accept.length) problems.push(`accept重複 ${where}`);
        }
      }
    }
    if (!["easy", "normal", "hard"].includes(w.level)) problems.push(`level不正 ${where}`);
    // 日本語の答え: 漢字に変換せず、読みをローマ字で打つ（js/romaji.js）。読み（ひらがな）が accept に必要
    if (w.kind === "concept" && !w.calc && !w.kanjiOnly && hasJapaneseScript(w.answer)) checkReadings(w, where);
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

console.log(`words: ${total} / unique ids: ${allIds.size} / family付き: ${familyById.size} / 日本語の答え: ${readingCards}枚（読み ${readingCount}）`);
if (problems.length === 0) {
  console.log("OK: 問題なし");
} else {
  console.log(`NG: ${problems.length}件`);
  problems.forEach((p) => console.log("  " + p));
  process.exit(1);
}
