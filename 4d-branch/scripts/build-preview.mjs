// 3 年の分かれ道（試し版）の 1 枚のページを作る（claude.ai の Artifact として公開する別のページ。読むだけ）
//   node scripts/build-preview.mjs [木のファイル] [出力の .html]
//     木のファイル: 開発用の入れ子の木（DevTree）の .json.gz（.json なら、ここで gzip する）。環境変数 DEEPMAP_TREE でも渡せる。
//       渡さなければ、計算の前提を直した木（作業メモ dev/q-tree.json.gz）があればそれ、無ければ R1 の木（dev/r1-tree.json.gz）
//     出力: 環境変数 DEEPMAP_PREVIEW_OUT でも渡せる。ビルドの途中の物は出力の隣の .preview-build/ に置く（リポジトリには置かない）
// アプリのビルド（vite.config.ts・dist/）には触らない: 入口 src/preview/index.html を、ここだけの設定で Vite に渡す。
// ページの形は scripts/build-artifact.mjs と同じ（公開のときに <!doctype html>…<body> で包まれるので中身だけ）:
//   <title> → <meta> → <style>（CSS を埋め込む）→ 本体 → 地図のデータ（gzip を base64 で）→ <script type="module">（JS を埋め込む）
// 外のファイルは何も読まない（フォント・CDN・fetch なし）。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { assertPageSize } from "./pageSize.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = "/tmp/claude-0/-home-user-spelldash/342dd9ca-ed44-551f-af59-60da8aff2834/scratchpad/deepmap";
const DEFAULT_TREE = [path.join(SCRATCH, "dev", "q-tree.json.gz"), path.join(SCRATCH, "dev", "r1-tree.json.gz")].find((p) => fs.existsSync(p)) ?? path.join(SCRATCH, "dev", "r1-tree.json.gz");
const TREE = path.resolve(process.argv[2] || process.env.DEEPMAP_TREE || DEFAULT_TREE);
const OUT = path.resolve(process.argv[3] || process.env.DEEPMAP_PREVIEW_OUT || path.join(SCRATCH, "view", "preview.html"));
const BUILD_DIR = path.join(path.dirname(OUT), ".preview-build");
const TITLE = "3 年の分かれ道（試し版）";
const FORMAT = "devtree-json-gzip";

const t0 = Date.now();

// ---- 木を読む（gzip でなければ gzip する）と、形の確かめ
if (!fs.existsSync(TREE)) throw new Error(`木のファイルがありません: ${TREE}`);
let gz = fs.readFileSync(TREE);
if (!(gz[0] === 0x1f && gz[1] === 0x8b)) gz = zlib.gzipSync(gz, { level: 9 });
const tree = JSON.parse(zlib.gunzipSync(gz).toString("utf8"));
const header = tree?.header;
if (!header || header.v !== 3 || header.kind !== "impact3y" || !tree.root) throw new Error("開発用の入れ子の木（v3・impact3y）ではありません");
// 道のハッシュの短い名前（src/deepmap/views/format.ts の keyToken と同じ式。cyrb53 の 36 進）。地図の中で同じ名前が無いことを確かめる
function keyToken(key) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < key.length; i++) {
    const ch = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
// format.ts の単体テストと同じ値（式がずれていないこと）
if (keyToken("r.ad_permside") !== "1cdy81soor3") throw new Error(`道の名前の式が format.ts とずれている: ${keyToken("r.ad_permside")}`);
let nodes = 0;
let withQ = 0;
const tokens = new Map();
const stack = [tree.root];
while (stack.length) {
  const n = stack.pop();
  nodes++;
  if (n.q) withQ++;
  const t = keyToken(n.k);
  if (tokens.has(t)) throw new Error(`道の名前が重なる鍵があります: ${tokens.get(t)} と ${n.k}`);
  tokens.set(t, n.k);
  if (n.kids) for (const k of n.kids) stack.push(k);
}

// ---- JS と CSS を作る（ここだけの設定。アプリの vite.config.ts は読まない）
await build({
  configFile: false,
  root: path.join(ROOT, "src", "preview"),
  base: "./",
  publicDir: false,
  logLevel: "warn",
  build: {
    outDir: BUILD_DIR,
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    modulePreload: false,
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    rollupOptions: { input: path.join(ROOT, "src", "preview", "index.html") },
  },
});
const built = fs.readFileSync(path.join(BUILD_DIR, "index.html"), "utf8");
const jsFile = /<script type="module"[^>]*src="\.\/(assets\/[^"]+\.js)"/.exec(built)?.[1];
const cssFile = /<link rel="stylesheet"[^>]*href="\.\/(assets\/[^"]+\.css)"/.exec(built)?.[1];
if (!jsFile || !cssFile) throw new Error(".preview-build/index.html に JS か CSS が見つかりません");
const assets = fs.readdirSync(path.join(BUILD_DIR, "assets"));
if (assets.filter((f) => f.endsWith(".js")).length !== 1) throw new Error(`JS が 1 つにまとまっていません: ${assets.join(", ")}`);

// 埋め込むときに要素を早く閉じてしまう並びを無害にする（JS の中では同じ意味）
const jsText = fs
  .readFileSync(path.join(BUILD_DIR, jsFile), "utf8")
  .replace(/\/\/# sourceMappingURL=.*$/m, "")
  .replace(/<\/script/gi, "<\\/script")
  .replace(/<!--/g, "<\\!--");
const cssText = fs
  .readFileSync(path.join(BUILD_DIR, cssFile), "utf8")
  .replace(/\/\*# sourceMappingURL=.*?\*\//g, "")
  .replace(/<\/style/gi, "<\\/style");

// 外のものを読む書き方が無いこと（フォント・CDN・fetch・動的な import）
if (/@import|url\(\s*["']?(https?:)?\/\//i.test(cssText)) throw new Error("CSS が外のファイルを読んでいます");
if (/\bfetch\s*\(|\bimport\s*\(\s*["'`]|XMLHttpRequest|WebSocket/.test(jsText)) throw new Error("JS が外とやりとりする書き方を含んでいます");

const b64 = gz.toString("base64").replace(/.{1,4096}/g, "$&\n");
const desc = "今日の 10 の手それぞれが、この先 3 年・約 2,000 の分かれ道と 3 年の稼ぎの幅にどう効くかを見る、読むだけの試し版";
const page = `<title>${TITLE}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<meta name="description" content="${desc}">
<style>
${cssText}
</style>
<div id="app" class="pv"><p class="pv-loading">地図を読み込み中…（カード ${nodes.toLocaleString("en-US")} 枚）</p></div>
<script type="application/octet-stream" id="deepmap-data" data-format="${FORMAT}" data-name="${path.basename(TREE).replace(/[^\w.\-]/g, "_")}">
${b64}</script>
<script type="module">
${jsText}
</script>
`;

// ---- 確かめ: 題名は先頭 8KB・骨組みのタグなし・外のものを読まない
const head = page.slice(0, 8192);
if (!head.includes(`<title>${TITLE}</title>`)) throw new Error("題名が先頭 8KB に無い");
const outside = page.replace(jsText, "").replace(cssText, "").replace(b64, "");
if (/<!doctype|<html|<head|<body/i.test(outside)) throw new Error("骨組みのタグが入っている");
if (/<link\b|\ssrc=["']?https?:|<iframe|<object|<embed/i.test(outside)) throw new Error("外のものを読むタグが入っている");
const bytes = assertPageSize(page, path.basename(OUT));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, page);
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(
  [
    `${OUT} を作りました（${(bytes / 1048576).toFixed(2)} MB: 地図 ${kb(b64.length)}・JS ${kb(jsText.length)}・CSS ${kb(cssText.length)}・${((Date.now() - t0) / 1000).toFixed(1)} 秒）`,
    `  木: ${TREE}（カード ${nodes.toLocaleString("en-US")} 枚・0 か月目 ${header.anchor}・版の順番 ${header.release}・q のある手 ${withQ.toLocaleString("en-US")}）`,
  ].join("\n"),
);
