// オープン教材（NGSL ファミリー）からパックの骨組みを作る
//   node scripts/build-openlist-packs.mjs ngsl            → scratchpad の out/ に ngsl01..ngsl24 の骨組み JSON と、書き足しが必要な語の一覧
//   node scripts/build-openlist-packs.mjs tsl             → TOEIC Service List（tsl01..）
//   node scripts/build-openlist-packs.mjs bsl             → Business Service List（bsl01..）
//   node scripts/build-openlist-packs.mjs ngsl --install  → 骨組みを data/packs/ に置く（ja が空の語が残っていると validate は通らない）
// 既存の語（data/english/*.json と cardType:"word" のパック）と同じ en があれば、ja / pos / level / ex / exJa / exForm を再利用する。
// 品詞と難易度の初期値は CEFR-J Vocabulary Profile から（A1→easy, A2→normal, B1以上→hard）。無ければ順位で3等分。
// ジャンル（道のユニット）は品詞で決める: n 名詞 / v 動詞 / adj 形容詞・副詞 / fn 機能語。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "data", "sources");
const OUT = process.env.OPENLIST_OUT || "/tmp/claude-0/-home-user-spelldash/b6899cbe-c918-58eb-ad69-858d255d3d35/scratchpad/openlists/out";
const which = process.argv[2] || "ngsl";
const install = process.argv.includes("--install");

const SUPPLEMENTARY = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
  "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety", "hundred", "thousand", "million", "billion",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"
];

// ---- 既存カードの索引（en → カード） ----
const existing = new Map();
const addExisting = (w) => {
  if (!w?.en || !w.ja || w.q) return;
  const key = String(w.en).toLowerCase();
  if (!existing.has(key) || (!existing.get(key).ex && w.ex)) existing.set(key, w);
};
for (const f of fs.readdirSync(path.join(ROOT, "data", "english"))) {
  try {
    JSON.parse(fs.readFileSync(path.join(ROOT, "data", "english", f), "utf8")).words?.forEach(addExisting);
  } catch {}
}
for (const f of fs.readdirSync(path.join(ROOT, "data", "packs"))) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "packs", f), "utf8"));
    if (d.cardType === "word" && !/^(ngsl|tsl|bsl)/.test(String(d.category))) d.words?.forEach(addExisting);
  } catch {}
}

// ---- CEFR-J: 品詞とレベル ----
const POS_MAP = { noun: "名", verb: "動", adjective: "形", adverb: "副", preposition: "前", conjunction: "接", pronoun: "代", determiner: "形", interjection: "間", modal: "助", "auxiliary verb": "助", number: "名" };
const cefr = new Map();
{
  const lines = fs.readFileSync(path.join(SRC, "cefrj", "cefrj-vocabulary-profile-1.5.csv"), "utf8").split(/\r?\n/).slice(1);
  for (const line of lines) {
    const [head, pos, level] = line.split(",");
    if (!head) continue;
    for (const h of head.split("/")) {
      const key = h.trim().toLowerCase();
      if (!/^[a-z][a-z-]*$/.test(key)) continue;
      const prev = cefr.get(key);
      const rank = { A1: 1, A2: 2, B1: 3, B2: 4 }[level] ?? 5;
      if (!prev || rank < prev.rank) cefr.set(key, { pos: POS_MAP[pos] ?? "", level, rank });
    }
  }
}

// ---- NGSL の語形（exForm の候補用） ----
const forms = new Map();
{
  const lines = fs.readFileSync(path.join(SRC, "ngsl", "NGSL_1.2_lemmatized_for_research.csv"), "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    const [head, ...rest] = line.split(",").map((s) => s.trim());
    if (head) forms.set(head.toLowerCase(), rest.filter(Boolean));
  }
}

function readNgsl() {
  const lines = fs.readFileSync(path.join(SRC, "ngsl", "NGSL_1.2_stats.csv"), "utf8").split(/\r?\n/).slice(1);
  const ranked = [];
  for (const line of lines) {
    const [lemma, rank] = line.split(",");
    if (!lemma) continue;
    const en = lemma.trim().toLowerCase();
    if (!/^[a-z][a-z-]*$/.test(en)) continue;
    ranked.push({ en, rank: Number(rank) });
  }
  ranked.sort((a, b) => a.rank - b.rank);
  return ranked;
}

const genreOf = (pos) => (pos === "名" ? "n" : pos === "動" ? "v" : pos === "形" || pos === "副" ? "adj" : "fn");
const GENRES = { n: "名詞", v: "動詞", adj: "形容詞・副詞", fn: "機能語（前置詞・接続詞・代名詞など）" };

function card(en, hint) {
  const ex = existing.get(en);
  const c = cefr.get(en);
  const pos = ex?.pos || c?.pos || "";
  const level = ex?.level || (c ? (c.rank <= 1 ? "easy" : c.rank === 2 ? "normal" : "hard") : hint.level);
  const w = { id: `english-${en}`, en, ja: ex?.ja ?? "", pos, level, tags: [genreOf(pos)] };
  if (ex?.ex && ex?.exJa) {
    w.ex = ex.ex;
    w.exJa = ex.exJa;
    if (ex.exForm) w.exForm = ex.exForm;
  }
  return w;
}

function writePack(id, label, blurb, audience, words, meta) {
  const used = new Set(words.map((w) => w.tags[0]));
  const genres = Object.fromEntries(Object.entries(GENRES).filter(([k]) => used.has(k)));
  const head = { subject: "english", category: id, cardType: "word", label, blurb, audience, source: meta, genres };
  const headText = JSON.stringify(head, null, 2).replace(/\n}$/, "");
  const body = words.map((w) => "    " + JSON.stringify(w).replace(/"([a-zA-Z]+)":/g, '"$1": ').replace(/,(?=")/g, ", ")).join(",\n");
  const text = `${headText},\n  "words": [\n${body}\n  ]\n}\n`;
  fs.mkdirSync(OUT, { recursive: true });
  const dest = install ? path.join(ROOT, "data", "packs", `${id}.json`) : path.join(OUT, `${id}.json`);
  fs.writeFileSync(dest, text);
  const todo = words.filter((w) => !w.ja || !w.pos || !w.ex).map((w) => ({ id: w.id, en: w.en, need: [!w.ja && "ja", !w.pos && "pos", !w.ex && "ex"].filter(Boolean), forms: (forms.get(w.en) || []).slice(0, 6), cefr: cefr.get(w.en)?.level ?? "" }));
  fs.writeFileSync(path.join(OUT, `${id}.todo.json`), JSON.stringify(todo, null, 1));
  return { id, total: words.length, todo: todo.length, ex: words.filter((w) => w.ex).length };
}

// ---- 頻度順 CSV（Word, Rank, ...）を読む ----
function readRanked(file, skip = new Set()) {
  const lines = fs.readFileSync(path.join(SRC, "ngsl", file), "utf8").split(/\r?\n/).slice(1);
  const ranked = [];
  for (const line of lines) {
    const [lemma, rank] = line.split(",");
    if (!lemma) continue;
    const en = lemma.trim().toLowerCase();
    if (!/^[a-z][a-z-]*$/.test(en) || skip.has(en)) continue;
    ranked.push({ en, rank: Number(rank) });
  }
  ranked.sort((a, b) => a.rank - b.rank);
  return ranked;
}

// ---- 頻度順リストを N 語ずつのパックに割る（共通） ----
function buildRankedPacks({ ranked, prefix, per, listLabel, shortLabel, blurbLead, audience, meta }) {
  const packs = [];
  for (let i = 0; i < ranked.length; i += per) packs.push(ranked.slice(i, i + per));
  const report = packs.map((list, n) => {
    const id = `${prefix}${String(n + 1).padStart(2, "0")}`;
    const lo = list[0].rank;
    const hi = list[list.length - 1].rank;
    const third = Math.ceil(list.length / 3);
    const words = list.map((x, k) => card(x.en, { level: k < third ? "easy" : k < third * 2 ? "normal" : "hard" }));
    const label = `${shortLabel} ${n + 1}（${lo}〜${hi}位）`;
    const blurb = n === 0 ? blurbLead : `${listLabel} の ${lo}〜${hi}位。頻度順。前のパックほどよく出会う語`;
    return writePack(id, label, blurb, audience, words, { ...meta, ranks: `${lo}-${hi}` });
  });
  console.table(report);
  console.log("total", report.reduce((a, r) => a + r.total, 0), "todo", report.reduce((a, r) => a + r.todo, 0), "with ex", report.reduce((a, r) => a + r.ex, 0));
}

if (which === "tsl") {
  buildRankedPacks({
    ranked: readRanked("TSL_1.2_stats.csv"),
    prefix: "tsl",
    per: 114,
    listLabel: "TSL",
    shortLabel: "TOEIC 英単語（TSL）",
    blurbLead: "TOEIC に出る語のうち基本2,800語の外側にある1,250語（TSL）を頻度順に",
    audience: "TOEIC のスコアを上げたい人（TSL: CC BY-SA 4.0）",
    meta: { list: "TSL 1.2", license: "CC BY-SA 4.0", url: "https://www.newgeneralservicelist.com/toeic-list" }
  });
} else if (which === "bsl") {
  buildRankedPacks({
    ranked: readRanked("BSL_1.01_SFI_freq_bands.csv"),
    prefix: "bsl",
    per: 117,
    listLabel: "BSL",
    shortLabel: "ビジネス英単語（BSL）",
    blurbLead: "仕事の英語でよく出る語のうち基本2,800語の外側にある1,750語（BSL）を頻度順に",
    audience: "仕事で英語を使う人（BSL: CC BY-SA 4.0）",
    meta: { list: "BSL 1.01", license: "CC BY-SA 4.0", url: "https://www.newgeneralservicelist.com/bsl-business-service-list" }
  });
} else if (which === "ngsl") {
  const ranked = readNgsl();
  const sup = SUPPLEMENTARY.filter((en) => !ranked.some((r) => r.en === en));
  const packs = [];
  // ngsl01 = 補助語（数・曜日・月）＋1位〜、以降は 119 語ずつ
  const first = [...sup.map((en) => ({ en, rank: 0 })), ...ranked.slice(0, 120 - sup.length)];
  packs.push(first);
  let i = 120 - sup.length;
  const per = Math.ceil((ranked.length - i) / 23);
  while (i < ranked.length) {
    packs.push(ranked.slice(i, i + per));
    i += per;
  }
  const report = packs.map((list, n) => {
    const id = `ngsl${String(n + 1).padStart(2, "0")}`;
    const lo = list.find((x) => x.rank > 0)?.rank ?? 1;
    const hi = list[list.length - 1].rank;
    const third = Math.ceil(list.length / 3);
    const words = list.map((x, k) => card(x.en, { level: k < third ? "easy" : k < third * 2 ? "normal" : "hard" }));
    const label = n === 0 ? `NGSL 基本英単語 1（数・曜日・月と 1〜${hi}位）` : `NGSL 基本英単語 ${n + 1}（${lo}〜${hi}位）`;
    const blurb = n === 0 ? "英文の約9割を作る基本2,800語（NGSL）を頻度順に。まず数・曜日・月から" : `NGSL の ${lo}〜${hi}位。頻度順。前のパックほどよく出会う語`;
    return writePack(id, label, blurb, "英語をゼロから体系的にやり直したい人（NGSL: CC BY-SA 4.0）", words, { list: "NGSL 1.2", license: "CC BY-SA 4.0", url: "https://www.newgeneralservicelist.com/", ranks: `${lo}-${hi}` });
  });
  console.table(report);
  console.log("total", report.reduce((a, r) => a + r.total, 0), "todo", report.reduce((a, r) => a + r.todo, 0), "with ex", report.reduce((a, r) => a + r.ex, 0));
}
