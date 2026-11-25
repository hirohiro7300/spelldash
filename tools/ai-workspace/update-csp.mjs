// AI作業場（index.html）の CSP にある script-src の sha256 を、いまの <script> の中身に合わせて書き換える。
// index.html の <script> を 1 字でも直したら、これを実行しないとページが動かなくなる（ブラウザが script を止めるため）。
//   node tools/ai-workspace/update-csp.mjs          書き換える
//   node tools/ai-workspace/update-csp.mjs --check  ずれていたら 1 で終わる（書き換えない）
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.html");
const html = fs.readFileSync(file, "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (scripts.length !== 1) {
  console.error(`index.html の inline の <script> が ${scripts.length} 個あります（1 個のはず）。`);
  process.exit(2);
}
const hash = "sha256-" + crypto.createHash("sha256").update(scripts[0], "utf8").digest("base64");
const next = html.replace(/script-src 'sha256-[^']*'/, `script-src '${hash}'`);
if (!/script-src 'sha256-/.test(html)) {
  console.error("index.html に script-src 'sha256-…' が見つかりません。");
  process.exit(2);
}
if (process.argv.includes("--check")) {
  if (next !== html) {
    console.error("CSP の sha256 が古いです。node tools/ai-workspace/update-csp.mjs を実行してください。");
    process.exit(1);
  }
  console.log("CSP は最新です:", hash);
} else if (next === html) {
  console.log("変更なし:", hash);
} else {
  fs.writeFileSync(file, next);
  console.log("CSP を更新しました:", hash);
}
