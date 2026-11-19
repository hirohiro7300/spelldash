// アカウントの形をした版 6 の文書（合成）を作る: node scripts/fixtures/run.mjs [--check]
//   凍結した版 6 の同梱データ（tests/fixtures/impact-r6.json と版の記録 impact-r6-release.json）から、
//   scripts/fixtures/accountR6.ts（決まった種の乱数）で tests/fixtures/account-r6.json を書く。何度作っても同じバイト。
//   --check: 書かずに、今のファイルと同じかだけを確かめる（違えば 1 で終わる）
// src の TypeScript をそのまま使うため、Vite の SSR で読み込む（scripts/impact/run.mjs と同じ作り）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const check = process.argv.includes("--check");
const OUT = path.join(root, "tests/fixtures/account-r6.json");
const server = await createServer({ root, configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", logLevel: "error", optimizeDeps: { noDiscovery: true, include: [] } });
let code = 1;
try {
  const mod = await server.ssrLoadModule("/scripts/fixtures/accountR6.ts");
  const raw = fs.readFileSync(path.join(root, "tests/fixtures/impact-r6.json"), "utf8");
  const release = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/impact-r6-release.json"), "utf8"));
  const text = mod.accountR6Json(mod.buildAccountR6(raw, release));
  const rel = path.relative(root, OUT);
  if (check) {
    const now = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : null;
    code = now === text ? 0 : 1;
    console.log(code === 0 ? `${rel} は作り直した物と同じ` : `${rel} が作り直した物と違う（node scripts/fixtures/run.mjs で書き直す）`);
  } else {
    fs.writeFileSync(OUT, text);
    console.log(`書き出し: ${rel}（${(text.length / 1e3).toFixed(0)} KB）`);
    code = 0;
  }
} finally {
  await server.close();
}
process.exit(code);
