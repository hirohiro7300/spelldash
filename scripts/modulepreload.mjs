// 各ページの <head> に、そのページの ES モジュールの依存（静的 import のぜんぶ）を <link rel="modulepreload"> で並べる。
//   node scripts/modulepreload.mjs          書き換える
//   node scripts/modulepreload.mjs --check  ずれていたら一覧を出して exit 1（CI と E2E）
//
// なぜ: ビルドしないので、ブラウザは import を 1 段読むごとに次のファイルを知る。ホームは 16 段・68 ファイルあり、
// 初めて開いた端末（キャッシュが無い）は往復 16 回ぶん待っていた。先読みを並べると 1〜2 往復で揃う。
// 実行はしない（読むだけ）ので、動きは変わらない。動的 import（import()）は対象外（必要になったときに読む）。
// 教材: 入口が読み込み時に initWordStore() を呼ぶページは、台帳（data/manifest.json）と、だれでも必ず読む基本カテゴリ
// （分野パック以外。js/packs.js isCategoryLoaded）の JSON も <link rel="preload" as="fetch"> で先に取り始める
// （main.js が動いてからでは、さらに 2 往復遅れる）。分野パックは人によって違うので並べない。
// 書く場所は <!-- modulepreload:start --> 〜 <!-- modulepreload:end -->（無ければ </head> の直前に作る）。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const START = "<!-- modulepreload:start -->";
const END = "<!-- modulepreload:end -->";
const IMPORT_RE = /^\s*(?:import|export)\s(?:[^;"']*?\sfrom\s+)?["'](\.{1,2}\/[^"']+)["']/gm;

// 入口から静的 import をたどり、読む順（深いものが先とは限らない。ブラウザは並べた順に並行で取る）に重複なく返す
function moduleGraph(entry) {
  const seen = new Set();
  const order = [];
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    order.push(file);
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(IMPORT_RE)) {
      const dep = path.resolve(path.dirname(file), m[1]);
      if (fs.existsSync(dep)) visit(dep);
    }
  };
  visit(entry);
  return order; // 入口も先頭に並べる（<script type="module"> は本文の末尾なので、head で先に取り始める）
}

// だれでも必ず読む教材（台帳と、分野パック以外のカテゴリ）。js/wordData.js の fetch と同じ URL・同じ CORS の扱いにする
function baseDataFiles() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "manifest.json"), "utf8"));
  const files = ["data/manifest.json"];
  for (const subject of manifest.subjects ?? []) {
    for (const category of subject.categories ?? []) if (!category.pack && category.file) files.push(`data/${category.file}`);
  }
  return files;
}

// 入口が読み込み時に教材を読む（行頭の initWordStore( 。関数の中で後から呼ぶものは数えない）
const LOADS_WORDS_RE = /^(?:const \w+ = )?initWordStore\(/m;

function pages() {
  return fs
    .readdirSync(ROOT)
    .filter((f) => f.endsWith(".html"))
    .map((f) => path.join(ROOT, f));
}

// ページの期待される中身（先読みの行）。モジュールの入口が無いページは null
function expectedBlock(html) {
  const entries = [...html.matchAll(/<script type="module" src="\.\/(js\/[^"]+)"><\/script>/g)].map((m) => path.join(ROOT, m[1]));
  if (entries.length === 0) return null;
  const files = [];
  for (const entry of entries) for (const f of moduleGraph(entry)) if (!files.includes(f)) files.push(f);
  const lines = files.map((f) => `  <link rel="modulepreload" href="./${path.relative(ROOT, f).split(path.sep).join("/")}" />`);
  if (entries.some((entry) => LOADS_WORDS_RE.test(fs.readFileSync(entry, "utf8")))) {
    for (const f of baseDataFiles()) lines.push(`  <link rel="preload" href="./${f}" as="fetch" crossorigin="anonymous" />`);
  }
  return `${START}\n${lines.join("\n")}\n  ${END}`;
}

function withBlock(html, block) {
  const s = html.indexOf(START);
  const e = html.indexOf(END);
  if (s >= 0 && e > s) return html.slice(0, s) + block + html.slice(e + END.length);
  return html.replace("</head>", `  ${block}\n</head>`);
}

// ずれているページの名前を返す（write: true なら書き直す）
export function syncModulePreload({ write = false } = {}) {
  const stale = [];
  for (const file of pages()) {
    const html = fs.readFileSync(file, "utf8");
    const block = expectedBlock(html);
    if (!block) continue;
    const next = withBlock(html, block);
    if (next === html) continue;
    stale.push(path.basename(file));
    if (write) fs.writeFileSync(file, next);
  }
  return stale;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const stale = syncModulePreload({ write: !check });
  if (check && stale.length) {
    console.error(`modulepreload がずれている: ${stale.join(", ")}（node scripts/modulepreload.mjs で直す）`);
    process.exit(1);
  }
  console.log(check ? "OK: modulepreload は最新" : stale.length ? `書き直した: ${stale.join(", ")}` : "変更なし");
}
