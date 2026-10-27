// 公開する英単語（公開の教材「英単語」1 つ。Batch 78）の表 data/public/english.json を、NGSL の 24 巻（data/packs/ngsl01〜24.json）から作る。
//   node scripts/build-public-vocab.mjs              書き直す（決まりに外れたら書かずに exit 1）
//   node scripts/build-public-vocab.mjs --check      決まりに外れる・生成物とファイルが違うなら一覧を出して exit 1（CI）
//   node scripts/build-public-vocab.mjs --root=<木>  別の木（教材の写し）で流す（単体の検査が使う）
//   import { loadInputs, buildPublicVocab, checkPublicVocab } from "./build-public-vocab.mjs"
//                                                    → 書かない。単体が読んだ教材とファイルの写しを壊して流す
//
// 表は公開する id の唯一の一覧で、order の並びがそのまま学ぶ順。カードの中身（訳・例文・別解）はパックのまま持つ。
// 読むもの: data/manifest.json の ngsl01〜24・その巻のファイル・data/sources/ngsl/NGSL_1.2_stats.csv（順位）。
// 決まり（docs/PACK_FORMAT.md「公開する英単語」）:
//   1. manifest の ngsl01〜24 の count = 巻の語数（scripts/validate-words.mjs と同じ見方）
//   2. id は 24 巻で重ならない
//   3. NGSL 1.2 の CSV の語は、どれも english-<語> の id で表にある
//   4. 巻の順・巻の中の順で NGSL の順位が下がらない。CSV に無い語（補助の語: 数・曜日・月）は ngsl01 の頭にだけ置く
//   5. 語数 = EXPECTED_TOTAL、機能語（tags[0] が fn）の数 = EXPECTED_FN
//   6. 並び = 機能語でない語を巻の順のまま → 機能語を巻の順のまま最後に。rank は order と同じ並びの NGSL の順位（補助の語は 0）
//   7. ファイル = 生成物（作り直して同じ文字列）
// 順位は id で引く（english-<CSV の語>）。同じ綴りで別の項目にする語（5月を足すなら english-may-month）は補助の語になる。
// NGSL のパックの語を足す・消す・並べ替える・札（tags[0]）を変えたら作り直す。訳・例文だけの直しでは表は変わらない。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isMain } from "./lib/is-main.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OUT_REL = "data/public/english.json";
const CSV_REL = "data/sources/ngsl/NGSL_1.2_stats.csv";

// 公開する語数。創業者の決定（Batch 78 §1・§9-2）でだけ変える。5月を助動詞の may と別の項目にするなら 1 語増える（返事待ち）
export const EXPECTED_TOTAL = 2857;
// 最後に回す機能語の数（決定 §1）。札を fn に変える・外すと並びが黙って変わるので、数で止める（数が同じままのつけ替えは止めない。作り直した表の差分で見る）
export const EXPECTED_FN = 122;
export const PACKS = Array.from({ length: 24 }, (_, i) => `ngsl${String(i + 1).padStart(2, "0")}`);
// 出典（docs/LICENSES.md・data/sources/ngsl/LICENSE.md）。changes は数から作る（sourceOf）
export const SOURCE = {
  list: "NGSL 1.2",
  title: "New General Service List",
  authors: "Browne, C., Culligan, B. & Phillips, J. (2013)",
  license: "CC BY-SA 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  url: "https://www.newgeneralservicelist.com/"
};
const sourceOf = (extra, fn) => ({
  ...SOURCE,
  changes: `語の選定と順位は NGSL 1.2 による。数・曜日・月の ${extra} 語を足した。訳・品詞・例文・別解は SpellDash が作った。機能語 ${fn} 語は最後に回した。`
});
const num = (n) => n.toLocaleString("en-US");

function readText(root, rel) {
  try {
    return fs.readFileSync(path.join(root, rel), "utf8");
  } catch {
    return null;
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const englishCategories = (manifest) => (manifest?.subjects ?? []).find((s) => s.id === "english")?.categories ?? [];

// 教材を読む（書かない）。巻は manifest の file から。無い・JSON でない巻は null（buildPublicVocab が巻の名前つきで問題に数える）
export function loadInputs(root = ROOT) {
  const manifest = JSON.parse(readText(root, "data/manifest.json"));
  const cats = englishCategories(manifest);
  const packs = {};
  for (const id of PACKS) {
    const file = cats.find((c) => c.id === id)?.file;
    const text = file ? readText(root, path.join("data", file)) : null;
    packs[id] = text == null ? null : parseJson(text);
  }
  return { manifest, packs, csv: readText(root, CSV_REL) ?? "" };
}

// CSV（Lemma,SFI Rank,…）→ id → 順位。I・TRUE・FALSE は大文字で入っているので小文字に
function readRanks(csv, problems) {
  const ranks = new Map();
  for (const line of csv.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const [lemma, rank] = line.split(",");
    const n = Number(rank);
    if (!lemma?.trim() || !Number.isInteger(n) || n < 1) problems.push(`CSV の行が読めない: ${line}`);
    else ranks.set(`english-${lemma.trim().toLowerCase()}`, n);
  }
  if (!ranks.size) problems.push(`${CSV_REL} が無い・空`);
  return ranks;
}

// 頭の欄は 1 欄 1 行、order は 1 語 1 行（語を足す・消すと差分がその行だけになる）、rank は 1 行
function format(data) {
  const { order, rank, ...head } = data;
  const lines = Object.entries(head).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  return `{\n${lines.join(",\n")},\n  "order": [\n${order.map((id) => `    ${JSON.stringify(id)}`).join(",\n")}\n  ],\n  "rank": ${JSON.stringify(rank)}\n}\n`;
}

// 読んだ教材から表を作る（ファイルは読まない・書かない）。problems は決まり 1〜5 に外れた所
export function buildPublicVocab({ manifest, packs, csv }) {
  const problems = [];
  const ranks = readRanks(csv, problems);
  const cats = englishCategories(manifest);
  const cards = [];
  for (const id of PACKS) {
    const entry = cats.find((c) => c.id === id);
    if (!entry) {
      problems.push(`manifest に ${id} が無い`);
      continue;
    }
    const words = packs[id]?.words;
    if (!Array.isArray(words)) {
      problems.push(`${id}: data/${entry.file} が読めない`);
      continue;
    }
    if (entry.count !== words.length) problems.push(`${id}: manifest の count ${entry.count} と語数 ${words.length} が違う`);
    for (const w of words) cards.push({ id: w.id, pack: id, fn: w.tags?.[0] === "fn", rank: ranks.get(w.id) ?? 0 });
  }
  const seen = new Set();
  for (const c of cards) {
    if (seen.has(c.id)) problems.push(`id が重なる ${c.id}（${c.pack}）`);
    seen.add(c.id);
  }
  for (const [id, rank] of ranks) if (!seen.has(id)) problems.push(`NGSL の語が表に無い ${id}（${rank} 位）`);
  let prev = 0;
  for (const c of cards) {
    if (!c.rank) {
      if (prev || c.pack !== PACKS[0]) problems.push(`NGSL に無い語が ngsl01 の頭の外にある ${c.id}（${c.pack}）`);
    } else {
      if (c.rank < prev) problems.push(`NGSL の順位が逆 ${c.id}（${c.rank} 位が ${prev} 位の後。${c.pack}）`);
      prev = c.rank;
    }
  }
  const order = [...cards.filter((c) => !c.fn), ...cards.filter((c) => c.fn)];
  const fn = order.filter((c) => c.fn).length;
  if (order.length !== EXPECTED_TOTAL) problems.push(`語数 ${num(order.length)}（決定は ${num(EXPECTED_TOTAL)}）`);
  if (fn !== EXPECTED_FN) problems.push(`機能語 ${fn} 語（決定は ${EXPECTED_FN}）`);
  const data = {
    v: 1,
    id: "english",
    label: "英単語",
    total: order.length,
    fnLast: fn,
    packs: PACKS,
    source: sourceOf(cards.filter((c) => !c.rank).length, fn),
    order: order.map((c) => c.id),
    rank: order.map((c) => c.rank)
  };
  return { data, text: format(data), problems, cards };
}

// 置いてある表（読んだ JSON）を、作った表と決まり 6 で比べる。手で直した・古いファイルのどこが違うかを言う
function validateTable(table, { data, cards }) {
  const problems = [];
  for (const k of ["v", "id", "label", "total", "fnLast", "packs", "source"]) {
    if (JSON.stringify(table[k]) !== JSON.stringify(data[k])) problems.push(`欄 ${k} が生成物と違う: ${JSON.stringify(table[k])?.slice(0, 80)}`);
  }
  const order = Array.isArray(table.order) ? table.order : [];
  const rank = Array.isArray(table.rank) ? table.rank : [];
  if (!Array.isArray(table.order)) problems.push("order が配列でない");
  if (order.length !== EXPECTED_TOTAL) problems.push(`order が ${num(order.length)} 語（決定は ${num(EXPECTED_TOTAL)}）`);
  if (table.total !== order.length) problems.push(`total ${table.total} と order の ${num(order.length)} 語が違う`);
  if (rank.length !== order.length) problems.push(`rank が ${rank.length} 個（order は ${order.length} 語）`);
  const byId = new Map(cards.map((c, i) => [c.id, { ...c, at: i }]));
  const seen = new Set();
  for (const id of order) {
    if (seen.has(id)) problems.push(`order で id が重なる ${id}`);
    else if (!byId.has(id)) problems.push(`order に 24 巻に無い id がある ${id}`);
    seen.add(id);
  }
  for (const id of byId.keys()) if (!seen.has(id)) problems.push(`order に無い id ${id}`);
  // 機能語の後ろに機能語でない語が来たら、その前の機能語は途中にある
  const firstFn = order.findIndex((id) => byId.get(id)?.fn);
  const lateWord = firstFn < 0 ? -1 : order.findIndex((id, i) => i > firstFn && byId.has(id) && !byId.get(id).fn);
  if (lateWord >= 0) problems.push(`機能語が途中にある ${order[firstFn]}（${firstFn} 番目。後ろに機能語でない ${order[lateWord]}）`);
  for (let i = 1; i < order.length; i++) {
    const a = byId.get(order[i - 1]);
    const b = byId.get(order[i]);
    if (a && b && a.fn === b.fn && b.at < a.at) problems.push(`巻の順と違う ${b.id}（${a.id} の後。${i} 番目）`);
  }
  // rank の数がずれていたら 1 つずつ比べない（後ろが全部ずれて読めなくなる）
  if (rank.length === order.length) {
    order.forEach((id, i) => {
      if (byId.has(id) && rank[i] !== byId.get(id).rank) problems.push(`順位が違う ${id}: ${rank[i]}（NGSL は ${byId.get(id).rank}）`);
    });
  }
  return problems;
}

// --check の中身: 決まり 1〜5（教材）・6（置いてある表）・7（生成物と同じ文字列）。current はファイルの文字列（無ければ null）
export function checkPublicVocab(inputs, current) {
  const built = buildPublicVocab(inputs);
  const problems = [...built.problems];
  if (current == null) {
    problems.push(`${OUT_REL} が無い（node scripts/build-public-vocab.mjs で作る）`);
    return { ...built, problems };
  }
  let table = null;
  try {
    table = JSON.parse(current);
  } catch {
    problems.push(`${OUT_REL} が JSON として読めない`);
  }
  // 直し方の 1 行を先に、どこが違うかを後に（--check は頭の 20 件だけ出す）
  if (current !== built.text) problems.push(`${OUT_REL} が生成物と違う（NGSL のパックを直したら node scripts/build-public-vocab.mjs で作り直す）`);
  if (table && typeof table === "object") problems.push(...validateTable(table, built));
  return { ...built, problems };
}

if (isMain(import.meta.url)) {
  const rootArg = process.argv.find((a) => a.startsWith("--root="));
  const root = rootArg ? path.resolve(rootArg.slice("--root=".length)) : ROOT;
  const out = path.join(root, OUT_REL);
  const current = readText(root, OUT_REL);
  const inputs = loadInputs(root);
  const check = process.argv.includes("--check");
  const { data, text, problems } = check ? checkPublicVocab(inputs, current) : buildPublicVocab(inputs);
  const what = `${num(data.total)} 語・機能語 ${data.fnLast} 語は最後`;
  if (problems.length) {
    console.error(`公開する英単語の表の決まりに外れる（${problems.length} 件${check ? "" : "。書かない"}）:\n  ${problems.slice(0, 20).join("\n  ")}`);
    process.exit(1);
  }
  if (check) {
    console.log(`OK: ${OUT_REL} は最新（${what}）`);
  } else {
    if (current !== text) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, text);
    }
    console.log(`${current === text ? "変更なし" : "書いた"}: ${OUT_REL}（${what}・${(Buffer.byteLength(text) / 1024).toFixed(1)}KB）`);
  }
}
