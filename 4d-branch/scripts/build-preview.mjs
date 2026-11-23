// 3 年の分かれ道（試し版）の 1 枚のページを作る（claude.ai の Artifact として公開する別のページ。読むだけ）
//   node scripts/build-preview.mjs [地図のファイル] [出力の .html]
//     地図のファイル（環境変数 DEEPMAP_TREE でも渡せる）は 2 つの形のどちらか:
//       .b64       同梱データ（W-gen の生成の --bundle の出力。決まった並びの列と文字列の表を gzip して base64 にした物。題・短い名前・
//                  やることを焼き込んである）。ページの読み手と同じ src/demo/impactBundle.ts で読んで確かめる。同じ置き場に
//                  impact-release.json があれば、版の順番と指紋が同じことも確かめる
//       .json(.gz) 開発用の入れ子の木（DevTree。開発中の木を確かめる用。.json なら、ここで gzip する）
//       渡さなければ、版 7 の候補の同梱データ（作業メモ gen/r7d/impact-q.b64。無ければ前の候補 gen/r7c・gen/r7b の impact-q.b64）。どちらも無ければ dev/q-tree.json.gz、dev/r1-tree.json.gz
//     出力: 環境変数 DEEPMAP_PREVIEW_OUT でも渡せる。既定は作業メモ view/preview-v2.html。ビルドの途中の物は出力の隣の
//       .preview-build/ に置く（リポジトリには置かない）
//     文の型の版: 地図の題・短い名前・やることは焼き込み、本文はページの中の組み立て（src/demo/compose）が書く。焼き込んだ版（header.textVersion）が
//       組み立ての版（BANKS.version）と違う地図は止める（題とやることが古い言い方のまま、本文だけ新しくなる。作業メモ code-1）。同梱データは、
//       焼き込んだ題・短い名前・やることがこの組み立てでその場で作る物と同じことも確かめる（生成の TB1 と同じ。版を上げ忘れた直しも見つける）
// アプリのビルド（vite.config.ts・dist/）には触らない: 入口 src/preview/index.html を、ここだけの設定で Vite に渡す。
// ページの形は scripts/build-artifact.mjs と同じ（公開のときに <!doctype html>…<body> で包まれるので中身だけ）:
//   <title> → <meta> → <style>（CSS を埋め込む）→ 本体 → 地図のデータ（gzip を base64 で。data-format が形）→ <script type="module">（JS を埋め込む）
// 外のファイルは何も読まない（フォント・CDN・fetch なし）。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { build, createServer } from "vite";
import { assertPageSize } from "./pageSize.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = "/tmp/claude-0/-home-user-spelldash/342dd9ca-ed44-551f-af59-60da8aff2834/scratchpad/deepmap";
const DEFAULT_TREE =
  [
    path.join(SCRATCH, "gen", "r7d", "impact-q.b64"),
    path.join(SCRATCH, "gen", "r7c", "impact-q.b64"),
    path.join(SCRATCH, "gen", "r7b", "impact-q.b64"),
    path.join(SCRATCH, "dev", "q-tree.json.gz"),
    path.join(SCRATCH, "dev", "r1-tree.json.gz"),
  ].find((p) => fs.existsSync(p)) ?? path.join(SCRATCH, "gen", "r7d", "impact-q.b64");
const TREE = path.resolve(process.argv[2] || process.env.DEEPMAP_TREE || DEFAULT_TREE);
const OUT = path.resolve(process.argv[3] || process.env.DEEPMAP_PREVIEW_OUT || path.join(SCRATCH, "view", "preview-v2.html"));
const BUILD_DIR = path.join(path.dirname(OUT), ".preview-build");
const TITLE = "3 年の分かれ道（試し版）";
/** 埋め込むデータの形（src/preview/load.ts の読み手の名前） */
const BUNDLE_GZIP = "impact-bundle-gzip";
const DEV_TREE_GZIP = "devtree-json-gzip";

const t0 = Date.now();

// ---- 地図を読む・形の確かめ。鍵は全部並べる（道の名前が重ならないことを下で確かめる）
if (!fs.existsSync(TREE)) throw new Error(`地図のファイルがありません: ${TREE}`);
const isBundle = TREE.endsWith(".b64");
const FORMAT = isBundle ? BUNDLE_GZIP : DEV_TREE_GZIP;
/** 埋め込む gzip */
let gz;
/** 見出し（MapHeader） */
let header;
/** カードの鍵（深さ優先の順） */
const keys = [];
let withQ = 0;
/** ページの中の組み立ての文の型の版（BANKS.version） */
let banksVersion = "";
/** 焼き込んだ文章と、その場の組み立ての違い */
let bakedDiff = null;
/** 文の型の版の違いの訳（src/preview/composeText.ts の textSkew。ページの知らせと同じ決まり） */
let skewOf = () => null;
// ページと同じ読み手と組み立て（TypeScript のまま。Vite の SSR で読む）
const server = await createServer({ root: ROOT, configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", logLevel: "error", optimizeDeps: { noDiscovery: true, include: [] } });
try {
  banksVersion = (await server.ssrLoadModule("/src/demo/compose/index.ts")).BANKS.version;
  const { textSkew } = await server.ssrLoadModule("/src/preview/composeText.ts");
  skewOf = textSkew;
  if (isBundle) {
    gz = Buffer.from(fs.readFileSync(TREE, "utf8").replace(/\s+/g, ""), "base64");
    if (!(gz[0] === 0x1f && gz[1] === 0x8b)) throw new Error(`同梱データ（gzip の base64）ではありません: ${TREE}`);
    const raw = new Uint8Array(zlib.gunzipSync(gz));
    // 読めることを確かめる。読めなければ止める
    const { decodeBundleBytes } = await server.ssrLoadModule("/src/demo/impactBundle.ts");
    const map = decodeBundleBytes(raw);
    header = map.header;
    for (let i = 0; i < map.n; i++) {
      keys.push(map.key(i));
      if (map.q(i)) withQ++;
    }
    // 文の型の版が同じなら、焼き込んだ題・短い名前・やることがこの組み立てでその場で作る物と同じか（生成の TB1。5 秒ほど）
    if (header.textVersion && header.textVersion !== "dev" && header.textVersion === banksVersion) {
      const { checkBaked } = await server.ssrLoadModule("/scripts/impact/q/text.ts");
      bakedDiff = checkBaked(map);
    }
  } else {
    gz = fs.readFileSync(TREE);
    if (!(gz[0] === 0x1f && gz[1] === 0x8b)) gz = zlib.gzipSync(gz, { level: 9 });
    const tree = JSON.parse(zlib.gunzipSync(gz).toString("utf8"));
    header = tree?.header;
    if (!header || header.v !== 3 || header.kind !== "impact3y" || !tree.root) throw new Error("開発用の入れ子の木（v3・impact3y）ではありません");
    const stack = [tree.root];
    while (stack.length) {
      const n = stack.pop();
      keys.push(n.k);
      if (n.q) withQ++;
      if (n.kids) for (const k of n.kids) stack.push(k);
    }
    if (header.textVersion && header.textVersion !== "dev" && header.textVersion === banksVersion) {
      const { checkBaked } = await server.ssrLoadModule("/scripts/impact/q/text.ts");
      const { fromDevTree } = await server.ssrLoadModule("/src/deepmap/dev/fromTree.ts");
      bakedDiff = checkBaked(fromDevTree(tree));
    }
  }
} finally {
  await server.close();
}
if (isBundle) {
  // 同じ置き場の版の記録（生成が書く impact-release.json）と同じ同梱データか
  const relFile = path.join(path.dirname(TREE), "impact-release.json");
  if (fs.existsSync(relFile)) {
    const rel = JSON.parse(fs.readFileSync(relFile, "utf8"));
    if (rel.release !== header.release || rel.hash !== header.hash || (rel.anchor && rel.anchor !== header.anchor))
      throw new Error(`同梱データが同じ置き場の版の記録と違う: 記録 版 ${rel.release}・${rel.hash}・${rel.anchor} / 同梱データ 版 ${header.release}・${header.hash}・${header.anchor}`);
  }
}
if (header?.v !== 3 || header.kind !== "impact3y") throw new Error("3 か月ごとの地図（v3・impact3y）ではありません");
// 文の型の版（作業メモ code-1）: 焼き込んだ版のある地図（dev でない）は、ページの中の組み立てと同じ版でなければ止める
const skew = skewOf(header.textVersion ?? "", banksVersion);
if (skew) throw new Error(`${skew}。地図を作り直してから作る`);
if (bakedDiff && bakedDiff.length) throw new Error(`焼き込んだ題・短い名前・やることが、この組み立てでその場で作る物と違う（文の型を直したら版を上げて地図を作り直す）:\n${bakedDiff.join("\n")}`);
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
const nodes = keys.length;
const tokens = new Map();
for (const k of keys) {
  const t = keyToken(k);
  if (tokens.has(t)) throw new Error(`道の名前が重なる鍵があります: ${tokens.get(t)} と ${k}`);
  tokens.set(t, k);
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
    `  ${isBundle ? "同梱データ" : "開発用の木"}: ${TREE}（形 ${FORMAT}・カード ${nodes.toLocaleString("en-US")} 枚・0 か月目 ${header.anchor}・版の順番 ${header.release}・指紋 ${header.hash}・文の型 ${header.textVersion}（組み立て ${banksVersion}${bakedDiff ? "・焼き込みはその場の組み立てと同じ" : ""}）・q のある手 ${withQ.toLocaleString("en-US")}）`,
  ].join("\n"),
);
