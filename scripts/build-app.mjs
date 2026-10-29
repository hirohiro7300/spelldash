// アプリ（Capacitor）用に、静的ファイルを dist/ にまとめる。
//   node scripts/build-app.mjs   → dist/ を作り直す（その後 npx cap sync）
// ビルド工程は無い（素の HTML/JS/CSS）。アプリに要らないもの（api/ 入口ページ packs/ sitemap 等）は入れない。
// PAGES はアプリの中から辿れるページを全部（10 ページ。フッターのタイピング練習・お知らせ・プライバシー・利用規約も）。
// 加入画面（pro.html）と特商法（tokushoho.html）は Web だけのページで、アプリに入れない（アプリに Pro を出さない。ストアの決済の方針でも、
// アプリから外の決済へ誘わない）。アプリではそこへのリンクを出さない（css/layout.css の html.native-app・js/appEnv.js。利用規約の本文は文字だけ）。
// アプリの中で見えるリンクの行き先はどれも PAGES にあること（tests/e2e.mjs の節 15 がアプリの状態で全ページを開いて守る）。
// Battle とタイピングの 2 ページは英単語の学習に絞った間（html[data-focus="english"]）、ページの入口の門で英単語のホームへ移る（Batch 78 段 7。アプリでは配信の転送が
// 効かないので、門がアプリでも止める）。旗を外せば今のまま開くので PAGES に残す
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isMain } from "./lib/is-main.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

export const PAGES = ["index.html", "list.html", "stats.html", "profile.html", "battle.html", "news.html", "privacy.html", "terms.html", "typing.html", "typing-game.html"];
export const DIRS = ["css", "js", "data", "assets"];

// SNS に貼られたときの絵（assets/images/og-*.png。og-image.png とページごとの絵）は SNS の読み取りだけが使い、アプリの中のページは出さないので入れない
export const isOgImage = (file) => /[\\/]assets[\\/]images[\\/]og-[^\\/]*\.png$/.test(file);

function build() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  for (const p of PAGES) fs.copyFileSync(path.join(ROOT, p), path.join(DIST, p));
  for (const d of DIRS) fs.cpSync(path.join(ROOT, d), path.join(DIST, d), { recursive: true, filter: (src) => !isOgImage(src) });
  // PWA の manifest はアプリでは不要だが、リンク切れ（404ログ）を避けるために置いておく
  fs.copyFileSync(path.join(ROOT, "manifest.webmanifest"), path.join(DIST, "manifest.webmanifest"));

  // 絶対パスのリンク（/assets, /manifest…）は WebView でもルートから解決されるのでそのままでよい
  let files = 0;
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : files++));
  walk(DIST);
  console.log(`dist: ${files} files`);
}

// 直接呼ばれたときだけ組み立てる（tests/e2e.mjs が PAGES を読むために import しても dist/ を消さない）
if (isMain(import.meta.url)) build();
