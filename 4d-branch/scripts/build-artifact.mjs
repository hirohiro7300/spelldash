// claude.ai の Artifact として公開する 1 枚のページを作る（npm run build:artifact）。
// 公開のときに <!doctype html>…<head>…<body> の骨組みで包まれるので、ここでは中身だけを書く:
//   <title> と <meta> を先頭（題名は最初の 8KB で探される）→ <style>（CSS を埋め込む）→ 本体 → <script type="module">（JS を埋め込む）
// 外部のファイルは読まない（CSP で止められるため、すべて内包する）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const OUT_DIR = path.join(ROOT, "artifact");
const OUT = path.join(OUT_DIR, "4d-branch.html");

const html = fs.readFileSync(path.join(DIST, "index.html"), "utf8");
const js = /<script type="module"[^>]*src="\.\/(assets\/[^"]+\.js)"/.exec(html)?.[1];
const css = /<link rel="stylesheet"[^>]*href="\.\/(assets\/[^"]+\.css)"/.exec(html)?.[1];
if (!js || !css) throw new Error("dist/index.html に JS か CSS が見つかりません。先に npm run build を実行してください");

// 埋め込むときに要素を早く閉じてしまう並びを無害にする（JS の中では同じ意味）
const jsText = fs
  .readFileSync(path.join(DIST, js), "utf8")
  .replace(/\/\/# sourceMappingURL=.*$/m, "")
  .replace(/<\/script/gi, "<\\/script")
  .replace(/<!--/g, "<\\!--");
const cssText = fs
  .readFileSync(path.join(DIST, css), "utf8")
  .replace(/\/\*# sourceMappingURL=.*?\*\//g, "")
  .replace(/<\/style/gi, "<\\/style");

const page = `<title>4D Branch</title>
<meta name="claude:viewport-fit-sides" content="cover">
<meta name="description" content="目標・行動・分岐・結果をつないで、プロジェクトをまたぐ未来の分岐を見える化するメモ帳">
<style>
html,body{margin:0;height:100%;background:#07090d;color:#e7eaf1}
.boot{position:fixed;inset:0;display:grid;place-items:center;font:13px system-ui,sans-serif;color:#6f7889;letter-spacing:.04em}
${cssText}
</style>
<div id="app"><div class="boot">4D Branch を読み込んでいます…</div></div>
<script type="module">
${jsText}
</script>
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, page);
const head = page.slice(0, 8192);
if (!/<title>4D Branch<\/title>/.test(head)) throw new Error("題名が先頭 8KB に無い");
if (/<!doctype|<html|<head|<body/i.test(page.replace(jsText, "").replace(cssText, ""))) throw new Error("骨組みのタグが入っている");
console.log(`artifact/4d-branch.html を作りました（${(page.length / 1024).toFixed(1)} KB）`);
