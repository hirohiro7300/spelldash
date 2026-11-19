// アカウントの形をした版 6 の文書（合成）を作る・確かめる: node scripts/fixtures/run.mjs [--check | --force]
//   凍結した版 6 の同梱データ（tests/fixtures/impact-r6.json と版の記録 impact-r6-release.json）から、
//   scripts/fixtures/accountR6.ts（決まった種の乱数・版 6 の時の作り方の写し ./frozenR6.ts だけを使う）で tests/fixtures/account-r6.json を作る。何度作っても同じバイト。
//   --check: 書かずに、今のファイルと同じかだけを確かめる（違えば 1 で終わる）
//   引数なし: ファイルが無い時だけ書く。あって中身が違えば、書かずに 1 で終わる（凍結した文書なので、黙って書き直さない。見直し found-1）
//   --force: 違っても書き直す（凍結した文書をわざと作り直す時だけ。版 6 のページが書いた形のままであることを確かめてから）
// src の TypeScript をそのまま使うため、Vite の SSR で読み込む（scripts/impact/run.mjs と同じ作り）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const check = process.argv.includes("--check");
const force = process.argv.includes("--force");
const OUT = path.join(root, "tests/fixtures/account-r6.json");
const FROZEN =
  "この文書は版 6 のページが書いた形のまま凍結してある（作り方はアプリの今のコードを読まず、scripts/fixtures/frozenR6.ts の写しと凍結した入力だけを使う）。" +
  "違うのは、作り方（accountR6.ts・frozenR6.ts）か凍結した入力（tests/fixtures/impact-r6*.json）が変わったから。文書は書き直さず、変えた所を戻す" +
  "（わざと作り直す時だけ --force）";
const server = await createServer({ root, configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", logLevel: "error", optimizeDeps: { noDiscovery: true, include: [] } });
let code = 1;
try {
  const mod = await server.ssrLoadModule("/scripts/fixtures/accountR6.ts");
  const raw = fs.readFileSync(path.join(root, "tests/fixtures/impact-r6.json"), "utf8");
  const release = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/impact-r6-release.json"), "utf8"));
  const text = mod.accountR6Json(mod.buildAccountR6(raw, release));
  const rel = path.relative(root, OUT);
  const now = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : null;
  if (now === text) {
    console.log(`${rel} は作り直した物と同じ${check ? "" : "（書き直さない）"}`);
    code = 0;
  } else if (check || (now !== null && !force)) {
    console.log(now === null ? `${rel} がありません` : `${rel} が作り直した物と違う。${FROZEN}`);
    code = 1;
  } else {
    fs.writeFileSync(OUT, text);
    console.log(`書き出し: ${rel}（${(Buffer.byteLength(text) / 1e3).toFixed(0)} KB）${now !== null ? "。凍結した文書を作り直した（版 6 のページが書いた形のままか確かめる）" : ""}`);
    code = 0;
  }
} finally {
  await server.close();
}
process.exit(code);
