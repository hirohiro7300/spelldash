// アプリ（Capacitor）用に、静的ファイルを dist/ にまとめる。
//   node scripts/build-app.mjs   → dist/ を作り直す（その後 npx cap sync）
// ビルド工程は無い（素の HTML/JS/CSS）。アプリに要らないもの（api/ 入口ページ packs/ sitemap 等）は入れない。
// PAGES はアプリの中から辿れるページを全部（フッターの特商法・利用規約、設定・規約・特商法からの加入画面）。
// アプリの中のページ・js が指す「./X.html」「/X.html」はどれも PAGES にあること（tests/e2e.mjs の節 15 が守る）。
// 加入画面はアプリでは価格と加入のボタンを出さず、Web 版の案内だけ（js/proView.js の isNativeApp）。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

export const PAGES = ["index.html", "list.html", "stats.html", "profile.html", "battle.html", "news.html", "privacy.html", "terms.html", "tokushoho.html", "pro.html", "typing.html", "typing-game.html"];
export const DIRS = ["css", "js", "data", "assets"];

function build() {
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
}

// 直接呼ばれたときだけ組み立てる（tests/e2e.mjs が PAGES を読むために import しても dist/ を消さない）
const realOf = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
if (process.argv[1] && realOf(path.resolve(process.argv[1])) === realOf(fileURLToPath(import.meta.url))) build();
