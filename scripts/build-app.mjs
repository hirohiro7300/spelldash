// アプリ（Capacitor）用に、静的ファイルを dist/ にまとめる。
//   node scripts/build-app.mjs   → dist/ を作り直す（その後 npx cap sync）
// ビルド工程は無い（素の HTML/JS/CSS）。アプリに要らないもの（api/ 入口ページ packs/ sitemap 等）は入れない。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

const PAGES = ["index.html", "list.html", "stats.html", "profile.html", "battle.html", "news.html", "privacy.html"];
const DIRS = ["css", "js", "data", "assets"];

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
for (const p of PAGES) fs.copyFileSync(path.join(ROOT, p), path.join(DIST, p));
for (const d of DIRS) fs.cpSync(path.join(ROOT, d), path.join(DIST, d), { recursive: true });
// PWA の manifest はアプリでは不要だが、リンク切れ（404ログ）を避けるために置いておく
fs.copyFileSync(path.join(ROOT, "manifest.webmanifest"), path.join(DIST, "manifest.webmanifest"));

// 絶対パスのリンク（/assets, /manifest…）は WebView でもルートから解決されるのでそのままでよい
let files = 0;
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : files++));
walk(DIST);
console.log(`dist: ${files} files`);
