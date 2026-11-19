// 文章の点検を、開発用の木（DevTree の JSON。.gz でもよい）に走らせる: node scripts/impact/runTextChecks.mjs <木.json> [--annual 360,540] [--examples 5] [--out 報告.md] [--json 結果.json] [--golden 置き場]
// 点検の中身は scripts/impact/textChecks.ts（src の TypeScript をそのまま使うため、Vite の SSR で読み込む）。止める点検が落ちたら終了コード 1
// 手で作った小さな地図の道の見本（tests/unit/composeGolden.json）を作り直す: node scripts/impact/runTextChecks.mjs --fixture-golden
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { createServer } from "vite";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const server = await createServer({ root, configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", logLevel: "error", optimizeDeps: { noDiscovery: true, include: [] } });
let code = 1;
try {
  const mod = await server.ssrLoadModule("/scripts/impact/textChecks.ts");
  if (args[0] === "--fixture-golden") {
    const fx = await server.ssrLoadModule("/tests/unit/composeFixture.ts");
    const file = path.join(root, "tests/unit/composeGolden.json");
    fs.writeFileSync(file, mod.fixtureGolden({ TREE: fx.TREE, RULES: fx.RULES }) + "\n");
    console.log(`書き出し: ${path.relative(root, file)}`);
    code = 0;
  } else {
    const file = args[0];
    if (!file || file.startsWith("--")) throw new Error("木のファイル（DevTree の JSON）を最初に渡してください");
    const raw = fs.readFileSync(file);
    const tree = JSON.parse((file.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8"));
    const res = mod.cli(tree, args.slice(1));
    for (const [p, text] of Object.entries(res.files)) {
      fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
      fs.writeFileSync(p, text);
    }
    console.log(res.text);
    if (Object.keys(res.files).length) console.log(`書き出し: ${Object.keys(res.files).join("・")}`);
    code = res.code;
  }
} catch (e) {
  console.error(e);
} finally {
  await server.close();
}
process.exit(code);
