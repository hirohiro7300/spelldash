// 日本語の答えのカードに「読み（ひらがな）」を accept として書き足し、漢字の別表記に読みを結ぶ（2026-10 ローマ字入力。js/romaji.js。
// docs/PACK_FORMAT.md「読み」「別表記の読み」）。
//   node scripts/add-readings.mjs <proposed.json> <reviewed-0.json> [<reviewed-1.json> …]          書き換える
//   node scripts/add-readings.mjs --check <proposed.json> <reviewed-*.json>                         書き換えずに数だけ出す
//   node scripts/add-readings.mjs --root=<木> …                                                      その木の data/ を読み書きする（既定はこの木。
//                                                                                                      scripts/quality/test-check.mjs が一時の写しで流す）
//
// 入力（読みの台帳。リポジトリには入れない作業ファイル）:
//   proposed.json  [{ id, category, file, proposed, alsoAccept?, flags[] }]  機械で作った読みの案（別表記だけを直すときは空の配列 []）
//   reviewed-*.json [{ id, category, readings[], drop?[], alts?{}, note? }]  人の目で見直した読み（こちらが優先）
//     ・readings はカードの読み候補を「主な読みが先」の順に並べたもの（無い読みは足す。既存の読みより前にあれば、既存のかなの読みの前に入れる＝主な読みになる）
//     ・drop は accept から外す語（単位記号 N など、ローマ字では 1 打で終わってしまう候補・違う意味の別表記）。
//       外した別表記に結んでいた読み（acceptReadings）も外す。ただし、残る別表記に結んだ読み・主な読み・readings と alts にある読みは残す
//       （結んでいない別表記の読みは分からないので、外すなら drop に読みも書く。書き忘れは品質の規則 Q04w が見張る）
//     ・alts は漢字の別表記ごとの読み { "<accept の別表記>": "<読み>" | ["<読み>", …] }。読みが accept に無ければ accept の末尾に足し、
//       カードの acceptReadings（accept の直後の欄）にその別表記の読みとして書く（前の記録は置き換える）。
//       別表記が accept に無い・読みがひらがなの読みでない台帳は NG で、そのファイルは書かない
//   見直しの無い案は、flags が空のときだけ使う。flags のある案は「未解決」として一覧に出し、書き足さない。
//
// 書き方: 読みは accept の末尾に足す（義務教育パックで読みを accept に入れてきたのと同じ流儀）。同じ読み（正規化して同じ）は足さない。
// acceptReadings は accept に無いキー（外した別表記の記録）を消し、キーを accept の並びに並べ、空になれば欄ごと消す。
// ファイルの体裁は保つ: JSON.stringify(_, null, 2) と同じ形のファイルは整形し直し、そうでないファイルは
// そのカードの accept の配列だけを、元の配列の書き方（1 行／複数行・区切りの空白）で書き換え、acceptReadings はその直後に 1 行で書く。
// 書き換えた後に読み直して、意図した値と一致することを確かめる（ずれたら書かずに止まる）。カードに NG があればそのファイルは書かない。
// 何度実行しても同じ結果になる。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { normalizeReading, readingCandidates, primaryReading, hasKana, isReading } from "../js/romaji.js";

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const rootArg = args.find((a) => a.startsWith("--root="));
const ROOT = rootArg ? path.resolve(rootArg.slice("--root=".length)) : path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const unknownFlags = args.filter((a) => a.startsWith("--") && a !== "--check" && !a.startsWith("--root="));
const [proposedPath, ...reviewedPaths] = args.filter((a) => !a.startsWith("--"));
if (unknownFlags.length || !proposedPath || reviewedPaths.length === 0) {
  console.error("使い方: node scripts/add-readings.mjs [--check] [--root=<木>] <proposed.json> <reviewed-0.json> [...]");
  process.exit(2);
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const manifest = readJson(path.join(ROOT, "data", "manifest.json"));
const fileOfCategory = new Map(manifest.subjects.flatMap((s) => s.categories.map((c) => [c.id, c.file])));

// ── 台帳をまとめる ─────────────────────────────────────────
const reviewed = new Map();
for (const p of reviewedPaths) for (const row of readJson(p)) reviewed.set(row.id, row);
const plan = new Map(); // id → { file, readings[], drop[], alts{} }
const unresolved = [];
const fromReviewed = (rev, file) => ({ file, readings: rev.readings ?? [], drop: rev.drop ?? [], alts: rev.alts ?? {}, note: rev.note });
for (const row of readJson(proposedPath)) {
  const file = row.file ?? fileOfCategory.get(row.category);
  const rev = reviewed.get(row.id);
  if (rev) plan.set(row.id, fromReviewed(rev, file));
  else if (!row.flags?.length) plan.set(row.id, { file, readings: [row.proposed, ...(row.alsoAccept ?? [])], drop: [], alts: {} });
  else unresolved.push(`${row.id}（${row.answer} → ${row.proposed}: ${row.flags.join(",")}）`);
}
for (const [id, rev] of reviewed) {
  if (plan.has(id)) continue;
  plan.set(id, fromReviewed(rev, fileOfCategory.get(rev.category)));
}

// ── カードの新しい値 ────────────────────────────────────────
const readingsList = (v) => (typeof v === "string" ? [v] : Array.isArray(v) && v.length && v.every((x) => typeof x === "string") ? v : null);
const recordOf = (card) => (card.acceptReadings && typeof card.acceptReadings === "object" && !Array.isArray(card.acceptReadings) ? card.acceptReadings : {});

// → { accept, acceptReadings（無ければ null）, added, dropped, bound（書き換えた別表記の数）, unbound: [{ alt, reading }], problems: [] }
function nextCard(card, entry) {
  const problems = [];
  const before = Array.isArray(card.accept) ? card.accept : [];
  const drop = new Set(entry.drop);
  let accept = before.filter((a) => !drop.has(a));
  const record = recordOf(card);
  const alts = Object.entries(entry.alts ?? {});

  // 1. 外した別表記に結んでいた読みも外す（残る別表記の読み・主な読み・台帳の readings と alts の読みは残す）
  const keep = new Set();
  for (const [alt, v] of Object.entries(record)) if (accept.includes(alt)) for (const r of readingsList(v) ?? []) keep.add(normalizeReading(r));
  for (const [, v] of alts) for (const r of readingsList(v) ?? []) keep.add(normalizeReading(r));
  for (const r of entry.readings) keep.add(normalizeReading(r));
  const primaryBefore = primaryReading(readingCandidates({ answer: card.answer, accept: before }));
  if (primaryBefore) keep.add(primaryBefore);
  const unbound = [];
  for (const [alt, v] of Object.entries(record)) {
    if (accept.includes(alt)) continue;
    for (const r of readingsList(v) ?? []) {
      const n = normalizeReading(r);
      if (keep.has(n)) continue;
      const left = accept.filter((a) => !(isReading(normalizeReading(a)) && normalizeReading(a) === n));
      if (left.length === accept.length) continue;
      accept = left;
      unbound.push({ alt, reading: r });
    }
  }

  // 2. readings（主な読みが先）
  const have = new Set(readingCandidates({ answer: card.answer, accept }));
  const wanted = entry.readings.filter((r) => isReading(normalizeReading(r)));
  const firstExisting = wanted.findIndex((r) => have.has(normalizeReading(r)));
  const front = [];
  const back = [];
  const seen = new Set(have);
  wanted.forEach((r, i) => {
    const n = normalizeReading(r);
    if (seen.has(n)) return;
    seen.add(n);
    (firstExisting >= 0 && i < firstExisting ? front : back).push(r);
  });
  if (front.length) {
    // 既存の主な読みより前に置きたい読み: その読みを作っている accept の語の直前に入れる
    const anchor = normalizeReading(wanted[firstExisting]);
    const at = accept.findIndex((a) => normalizeReading(a) === anchor);
    if (at < 0) throw new Error(`${card.id}: 先頭に置く読みの位置が accept に無い（答えそのものが読み）`);
    accept.splice(at, 0, ...front);
  }
  accept.push(...back);

  // 3. alts（別表記ごとの読み。無い読みは末尾に足す）
  const next = {};
  for (const [alt, v] of Object.entries(record)) if (accept.includes(alt)) next[alt] = v;
  for (const [alt, v] of alts) {
    const list = readingsList(v);
    if (!list) {
      problems.push(`別表記「${alt}」の読みの形（読みか読みの配列）（alts）`);
      continue;
    }
    if (!accept.includes(alt)) problems.push(`別表記「${alt}」が accept に無い（alts）`);
    else if (isReading(normalizeReading(alt))) problems.push(`別表記「${alt}」が読み（読みに読みは要らない）（alts）`);
    const bad = list.filter((r) => !isReading(normalizeReading(r)) || !hasKana(normalizeReading(r)));
    for (const r of bad) problems.push(`「${alt}」の読み「${r}」がひらがなの読みでない（alts）`);
    if (bad.length || new Set(list.map(normalizeReading)).size !== list.length) {
      if (!bad.length) problems.push(`「${alt}」の読みが重複（alts）`);
      continue;
    }
    for (const r of list) {
      const n = normalizeReading(r);
      if (seen.has(n)) continue;
      seen.add(n);
      accept.push(r);
    }
    next[alt] = list.length === 1 ? list[0] : [...list];
  }
  // キーは accept の並び（差分を安定させる）
  const keys = Object.keys(next).sort((a, b) => accept.indexOf(a) - accept.indexOf(b));
  const acceptReadings = keys.length ? Object.fromEntries(keys.map((k) => [k, next[k]])) : null;
  const bound = alts.filter(([alt]) => JSON.stringify(next[alt] ?? null) !== JSON.stringify(record[alt] ?? null)).length;
  const added = accept.filter((a) => !before.includes(a)).length;
  const dropped = before.filter((a) => !accept.includes(a)).length;
  return { accept, acceptReadings, added, dropped, bound, unbound, problems, primaryBefore };
}

// カードの欄の並びを保ったまま、accept を置き換え、acceptReadings を accept の直後に置く（null なら消す）。accept が無かったカードは answer の直後に
function withAcceptReadings(card, accept, acceptReadings) {
  const out = {};
  const put = () => {
    out.accept = accept;
    if (acceptReadings) out.acceptReadings = acceptReadings;
  };
  const hasAccept = Object.prototype.hasOwnProperty.call(card, "accept");
  for (const [k, v] of Object.entries(card)) {
    if (k === "acceptReadings" || k === "accept") {
      if (k === "accept") put();
      continue;
    }
    out[k] = v;
    if (k === "answer" && !hasAccept) put();
  }
  return out;
}

// ── 体裁を保つ書き換え（値の位置を覚える小さな JSON パーサ）───────────────
function parseWithSpans(text) {
  let i = 0;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  function value() {
    ws();
    const start = i;
    const ch = text[i];
    if (ch === "{") {
      i++;
      const members = [];
      ws();
      if (text[i] === "}") {
        i++;
        return { type: "object", start, end: i, members };
      }
      for (;;) {
        ws();
        const keyStart = i;
        const key = value();
        ws();
        if (text[i] !== ":") throw new Error(`':' が無い @${i}`);
        i++;
        const v = value();
        members.push({ key: key.value, keyStart, value: v });
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return { type: "object", start, end: i, members };
        }
        throw new Error(`',' か '}' が無い @${i}`);
      }
    }
    if (ch === "[") {
      i++;
      const items = [];
      ws();
      if (text[i] === "]") {
        i++;
        return { type: "array", start, end: i, items };
      }
      for (;;) {
        items.push(value());
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return { type: "array", start, end: i, items };
        }
        throw new Error(`',' か ']' が無い @${i}`);
      }
    }
    if (ch === '"') {
      i++;
      while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      i++;
      return { type: "string", start, end: i, value: JSON.parse(text.slice(start, i)) };
    }
    const m = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 40));
    if (!m) throw new Error(`値が読めない @${i}`);
    i += m[0].length;
    return { type: "scalar", start, end: i };
  }
  const root = value();
  return root;
}

const lineIndentAt = (text, pos) => {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))[0];
};

// 元の配列の書き方に合わせて、新しい配列を文字列にする
function formatArrayLike(text, oldSpan, items, style) {
  if (style.multiline) {
    const closeIndent = oldSpan ? lineIndentAt(text, oldSpan.end - 1) : style.closeIndent;
    const itemIndent = style.itemIndent ?? `${closeIndent}  `;
    return `[\n${items.map((s) => itemIndent + JSON.stringify(s)).join(",\n")}\n${closeIndent}]`;
  }
  return `[${style.pad}${items.map((s) => JSON.stringify(s)).join(style.sep)}${style.pad}]`;
}

function styleOf(text, span) {
  const old = text.slice(span.start, span.end);
  if (old.includes("\n")) {
    const first = span.items[0];
    return { multiline: true, itemIndent: first ? lineIndentAt(text, first.start) : null };
  }
  const sep = span.items.length > 1 ? text.slice(span.items[0].end, span.items[1].start) : null;
  const pad = /^\[\s/.test(old) ? " " : "";
  return { multiline: false, sep: sep ?? null, pad };
}

// ファイルで多数派の accept の書き方（accept が空・無いカードに使う）
function fileStyle(text, cards) {
  const counts = new Map();
  for (const c of cards) {
    const acc = c.members.find((m) => m.key === "accept")?.value;
    if (!acc || acc.type !== "array" || acc.items.length < 2) continue;
    const s = styleOf(text, acc);
    const k = JSON.stringify(s.multiline ? { multiline: true } : s);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  const s = best ? JSON.parse(best) : { multiline: false, sep: ", ", pad: "" };
  return s.multiline ? s : { ...s, sep: s.sep ?? ", " };
}

// acceptReadings の値を 1 行で（accept の配列の区切りに合わせる: ", " なら {"岩宿": "いわじゅく"}、"," なら {"岩宿":"いわじゅく"}）
function formatReadingsLike(map, sep) {
  const colon = sep.endsWith(" ") ? ": " : ":";
  const val = (v) => (Array.isArray(v) ? `[${v.map((s) => JSON.stringify(s)).join(sep)}]` : JSON.stringify(v));
  return `{${Object.entries(map).map(([k, v]) => `${JSON.stringify(k)}${colon}${val(v)}`).join(sep)}}`;
}

function rewriteInPlace(text, changes) {
  const root = parseWithSpans(text);
  const words = root.members.find((m) => m.key === "words").value;
  const cards = words.items;
  const style = fileStyle(text, cards);
  const edits = [];
  for (const card of cards) {
    const id = card.members.find((m) => m.key === "id")?.value?.value;
    if (!changes.has(id)) continue;
    const { accept: next, acceptReadings } = changes.get(id);
    const members = card.members;
    const accIdx = members.findIndex((m) => m.key === "accept");
    const rdIdx = members.findIndex((m) => m.key === "acceptReadings");
    const sameLineCard = !text.slice(card.start, card.end).includes("\n");
    // accept の直後にない前の記録は消す（直後に書き直す）
    if (rdIdx >= 0 && (accIdx < 0 || rdIdx !== accIdx + 1)) edits.push({ start: members[rdIdx - 1].value.end, end: members[rdIdx].value.end, str: "" });
    const rdAfter = rdIdx >= 0 && accIdx >= 0 && rdIdx === accIdx + 1 ? members[rdIdx] : null;
    if (accIdx >= 0) {
      const acc = members[accIdx];
      const s = acc.value.items.length ? styleOf(text, acc.value) : null;
      const fmt = s && s.multiline === false && s.sep === null ? { ...s, sep: style.multiline ? ", " : style.sep } : s ?? style;
      const closeIndent = style.multiline ? lineIndentAt(text, acc.keyStart) : "";
      const arr = !next.length
        ? "[]"
        : acc.value.items.length
          ? formatArrayLike(text, acc.value, next, fmt)
          : formatArrayLike(text, null, next, { ...fmt, closeIndent, itemIndent: `${closeIndent}  ` });
      const rsep = fmt.multiline ? ", " : fmt.sep ?? ", ";
      const indent = lineIndentAt(text, acc.keyStart);
      const rd = acceptReadings ? formatReadingsLike(acceptReadings, rsep) : null;
      if (rdAfter) {
        // 前の記録を置き換える（無くなれば、前の区切りごと消す）
        const between = text.slice(acc.value.end, rdAfter.value.start);
        edits.push({ start: acc.value.start, end: rdAfter.value.end, str: arr + (rd ? between + rd : "") });
      } else {
        const add = rd ? (sameLineCard ? `, "acceptReadings": ${rd}` : `,\n${indent}"acceptReadings": ${rd}`) : "";
        edits.push({ start: acc.value.start, end: acc.value.end, str: arr + add });
      }
    } else {
      // accept が無い: answer の直後に足す
      const ans = members.find((m) => m.key === "answer");
      if (!ans) throw new Error(`${id}: answer が無い`);
      const indent = lineIndentAt(text, ans.keyStart);
      const arr = formatArrayLike(text, null, next, { ...style, closeIndent: indent, itemIndent: `${indent}  ` });
      const rsep = style.multiline ? ", " : style.sep ?? ", ";
      const rd = acceptReadings ? formatReadingsLike(acceptReadings, rsep) : null;
      const field = (k, v) => (sameLineCard ? `, "${k}": ${v}` : `,\n${indent}"${k}": ${v}`);
      edits.push({ start: ans.value.end, end: ans.value.end, str: field("accept", arr) + (rd ? field("acceptReadings", rd) : "") });
    }
  }
  edits.sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of edits) out = out.slice(0, e.start) + e.str + out.slice(e.end);
  return out;
}

// ── 実行 ─────────────────────────────────────────────────
const byFile = new Map();
for (const [id, entry] of plan) {
  if (!entry.file) {
    unresolved.push(`${id}（ファイル不明）`);
    continue;
  }
  if (!byFile.has(entry.file)) byFile.set(entry.file, new Map());
  byFile.get(entry.file).set(id, entry);
}

let added = 0;
let dropped = 0;
let boundAlts = 0;
let cardsChanged = 0;
let filesChanged = 0;
const missingCards = [];
const problems = [];
const notes = [];
for (const [file, entries] of [...byFile].sort()) {
  const full = path.join(ROOT, "data", file);
  const text = fs.readFileSync(full, "utf8");
  const data = JSON.parse(text);
  const changes = new Map();
  const ids = new Set(data.words.map((w) => w.id));
  for (const id of entries.keys()) if (!ids.has(id)) missingCards.push(`${file}:${id}`);
  const fileProblems = [];
  const fileNotes = [];
  let fileAdded = 0;
  let fileDropped = 0;
  let fileBound = 0;
  for (let at = 0; at < data.words.length; at++) {
    const card = data.words[at];
    const entry = entries.get(card.id);
    if (!entry) continue;
    const r = nextCard(card, entry);
    for (const p of r.problems) fileProblems.push(`${file}:${card.id} ${p}`);
    const same = JSON.stringify(r.accept) === JSON.stringify(card.accept ?? []) && JSON.stringify(r.acceptReadings) === JSON.stringify(card.acceptReadings ?? null);
    if (same) continue;
    fileAdded += r.added;
    fileDropped += r.dropped;
    fileBound += r.bound;
    for (const u of r.unbound) fileNotes.push(`${file}:${card.id} 「${u.alt}」に結んでいた読み「${u.reading}」も外した`);
    changes.set(card.id, { accept: r.accept, acceptReadings: r.acceptReadings });
    data.words[at] = withAcceptReadings(card, r.accept, r.acceptReadings);
    // 書き足した後の主な読みが、台帳の主な読み（無ければ前の主な読み）と一致すること
    const want = entry.readings.map(normalizeReading).find(hasKana) ?? r.primaryBefore;
    const got = primaryReading(readingCandidates(data.words[at]));
    if (want && got !== want) fileProblems.push(`${file}:${card.id} 主な読み ${got} ≠ ${entry.readings.length ? "台帳" : "前の主な読み"} ${want}`);
  }
  problems.push(...fileProblems);
  // NG のあるファイルは書かない（台帳を直して流し直す）
  if (fileProblems.length || changes.size === 0) continue;
  notes.push(...fileNotes);
  added += fileAdded;
  dropped += fileDropped;
  boundAlts += fileBound;
  cardsChanged += changes.size;
  filesChanged++;
  const pretty = JSON.stringify(JSON.parse(text), null, 2) + "\n" === text;
  const out = pretty ? JSON.stringify(data, null, 2) + "\n" : rewriteInPlace(text, changes);
  // 読み直して、意図した値と一致すること（体裁だけを変え、値は変えない）
  if (JSON.stringify(JSON.parse(out)) !== JSON.stringify(data)) throw new Error(`${file}: 書き換え後の値が一致しない`);
  if (!checkOnly) fs.writeFileSync(full, out);
}

console.log(`台帳: ${plan.size}枚（見直し ${reviewed.size}）`);
console.log(`${checkOnly ? "（--check）" : ""}読みを足した: ${added}件 / 外した語: ${dropped}件 / 結んだ別表記: ${boundAlts}件 / カード ${cardsChanged}枚 / ファイル ${filesChanged}本`);
if (notes.length) console.log(notes.join("\n"));
if (missingCards.length) console.log(`データに無いカード ${missingCards.length}枚:\n  ${missingCards.join("\n  ")}`);
if (unresolved.length) console.log(`未解決 ${unresolved.length}枚（書き足していない）:\n  ${unresolved.join("\n  ")}`);
if (problems.length) {
  console.log(`NG ${problems.length}件（そのファイルは書いていない）:\n  ${problems.join("\n  ")}`);
  process.exitCode = 1; // exit() は標準出力を書き切る前に終わることがある（パイプ）
}
