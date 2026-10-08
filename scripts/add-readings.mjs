// 日本語の答えのカードに「読み（ひらがな）」を accept として書き足す（2026-10 ローマ字入力。js/romaji.js）。
//   node scripts/add-readings.mjs <proposed.json> <reviewed-0.json> [<reviewed-1.json> …]          書き換える
//   node scripts/add-readings.mjs --check <proposed.json> <reviewed-*.json>                         書き換えずに数だけ出す
//
// 入力（読みの台帳。リポジトリには入れない作業ファイル）:
//   proposed.json  [{ id, category, file, proposed, alsoAccept?, flags[] }]  機械で作った読みの案
//   reviewed-*.json [{ id, category, readings[], add?[], drop?[], note? }]    人の目で見直した読み（こちらが優先）
//     ・readings はカードの読み候補を「主な読みが先」の順に並べたもの
//     ・add は新しく足す読み（readings の中で既存の読みより前にあれば、既存のかなの読みの前に入れる＝主な読みになる）
//     ・drop は accept から外す語（単位記号 N など、ローマ字では 1 打で終わってしまう候補）
//   見直しの無い案は、flags が空のときだけ使う。flags のある案は「未解決」として一覧に出し、書き足さない。
//
// 書き方: 読みは accept の末尾に足す（義務教育パックで読みを accept に入れてきたのと同じ流儀）。同じ読み（正規化して同じ）は足さない。
// ファイルの体裁は保つ: JSON.stringify(_, null, 2) と同じ形のファイルは整形し直し、そうでないファイルは
// そのカードの accept の配列だけを、元の配列の書き方（1 行／複数行・区切りの空白）で書き換える。
// 書き換えた後に読み直して、意図した値と一致することを確かめる（ずれたら書かずに止まる）。何度実行しても同じ結果になる。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { normalizeReading, readingCandidates, primaryReading, hasKana, isReading } from "../js/romaji.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const [proposedPath, ...reviewedPaths] = args.filter((a) => a !== "--check");
if (!proposedPath || reviewedPaths.length === 0) {
  console.error("使い方: node scripts/add-readings.mjs [--check] <proposed.json> <reviewed-0.json> [...]");
  process.exit(2);
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const manifest = readJson(path.join(ROOT, "data", "manifest.json"));
const fileOfCategory = new Map(manifest.subjects.flatMap((s) => s.categories.map((c) => [c.id, c.file])));

// ── 台帳をまとめる ─────────────────────────────────────────
const reviewed = new Map();
for (const p of reviewedPaths) for (const row of readJson(p)) reviewed.set(row.id, row);
const plan = new Map(); // id → { file, readings[], drop[] }
const unresolved = [];
for (const row of readJson(proposedPath)) {
  const file = row.file ?? fileOfCategory.get(row.category);
  const rev = reviewed.get(row.id);
  if (rev) plan.set(row.id, { file, readings: rev.readings ?? [], drop: rev.drop ?? [], note: rev.note });
  else if (!row.flags?.length) plan.set(row.id, { file, readings: [row.proposed, ...(row.alsoAccept ?? [])], drop: [] });
  else unresolved.push(`${row.id}（${row.answer} → ${row.proposed}: ${row.flags.join(",")}）`);
}
for (const [id, rev] of reviewed) {
  if (plan.has(id)) continue;
  plan.set(id, { file: fileOfCategory.get(rev.category), readings: rev.readings ?? [], drop: rev.drop ?? [], note: rev.note });
}

// ── accept の新しい値 ────────────────────────────────────────
function nextAccept(card, entry) {
  const drop = new Set(entry.drop);
  const accept = (Array.isArray(card.accept) ? card.accept : []).filter((a) => !drop.has(a));
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
  return { accept, added: front.length + back.length, dropped: (card.accept ?? []).length - (accept.length - front.length - back.length) };
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

function rewriteInPlace(text, changes) {
  const root = parseWithSpans(text);
  const words = root.members.find((m) => m.key === "words").value;
  const cards = words.items;
  const style = fileStyle(text, cards);
  const edits = [];
  for (const card of cards) {
    const id = card.members.find((m) => m.key === "id")?.value?.value;
    if (!changes.has(id)) continue;
    const next = changes.get(id);
    const acc = card.members.find((m) => m.key === "accept");
    if (acc) {
      const s = acc.value.items.length ? styleOf(text, acc.value) : null;
      const fmt = s && s.multiline === false && s.sep === null ? { ...s, sep: style.multiline ? ", " : style.sep } : s ?? style;
      const closeIndent = style.multiline ? lineIndentAt(text, acc.keyStart) : "";
      const str = acc.value.items.length
        ? formatArrayLike(text, acc.value, next, fmt)
        : formatArrayLike(text, null, next, { ...fmt, closeIndent, itemIndent: `${closeIndent}  ` });
      edits.push({ start: acc.value.start, end: acc.value.end, str });
    } else {
      // accept が無い: answer の直後に足す
      const ans = card.members.find((m) => m.key === "answer");
      if (!ans) throw new Error(`${id}: answer が無い`);
      const indent = lineIndentAt(text, ans.keyStart);
      const sameLine = !text.slice(card.start, card.end).includes("\n");
      const arr = formatArrayLike(text, null, next, { ...style, closeIndent: indent, itemIndent: `${indent}  ` });
      edits.push({ start: ans.value.end, end: ans.value.end, str: sameLine ? `, "accept": ${arr}` : `,\n${indent}"accept": ${arr}` });
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
let cardsChanged = 0;
let filesChanged = 0;
const missingCards = [];
const problems = [];
for (const [file, entries] of [...byFile].sort()) {
  const full = path.join(ROOT, "data", file);
  const text = fs.readFileSync(full, "utf8");
  const data = JSON.parse(text);
  const changes = new Map();
  const ids = new Set(data.words.map((w) => w.id));
  for (const id of entries.keys()) if (!ids.has(id)) missingCards.push(`${file}:${id}`);
  for (const card of data.words) {
    const entry = entries.get(card.id);
    if (!entry) continue;
    const r = nextAccept(card, entry);
    if (JSON.stringify(r.accept) === JSON.stringify(card.accept ?? [])) continue;
    added += r.added;
    dropped += r.dropped;
    cardsChanged++;
    changes.set(card.id, r.accept);
    card.accept = r.accept;
    // 書き足した後の主な読みが、台帳の主な読みと一致すること
    const want = entry.readings.map(normalizeReading).find(hasKana);
    const got = primaryReading(readingCandidates(card));
    if (want && got !== want) problems.push(`${file}:${card.id} 主な読み ${got} ≠ 台帳 ${want}`);
  }
  if (changes.size === 0) continue;
  filesChanged++;
  const pretty = JSON.stringify(JSON.parse(text), null, 2) + "\n" === text;
  const out = pretty ? JSON.stringify(data, null, 2) + "\n" : rewriteInPlace(text, changes);
  // 読み直して、意図した値と一致すること（体裁だけを変え、値は変えない）
  if (JSON.stringify(JSON.parse(out)) !== JSON.stringify(data)) throw new Error(`${file}: 書き換え後の値が一致しない`);
  if (!checkOnly) fs.writeFileSync(full, out);
}

console.log(`台帳: ${plan.size}枚（見直し ${reviewed.size}）`);
console.log(`${checkOnly ? "（--check）" : ""}読みを足した: ${added}件 / 外した語: ${dropped}件 / カード ${cardsChanged}枚 / ファイル ${filesChanged}本`);
if (missingCards.length) console.log(`データに無いカード ${missingCards.length}枚:\n  ${missingCards.join("\n  ")}`);
if (unresolved.length) console.log(`未解決 ${unresolved.length}枚（書き足していない）:\n  ${unresolved.join("\n  ")}`);
if (problems.length) {
  console.log(`NG ${problems.length}件:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
