// 3 か月ごと 12 段の「3 年の地図」の木と同梱データを作る: node scripts/impact/q/run.mjs --out <木.json> [--bundle <同梱.b64>] [引数は main.ts の先頭に書いてある]
// src と scripts/impact の TypeScript をそのまま使うため、Vite の SSR で読み込む（scripts/impact/run.mjs と同じ作り）
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const server = await createServer({ root, configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", logLevel: "error", optimizeDeps: { noDiscovery: true, include: [] } });
let code = 1;
try {
  const mod = await server.ssrLoadModule("/scripts/impact/q/main.ts");
  code = await mod.main(root, process.argv.slice(2));
} finally {
  await server.close();
}
process.exit(code);
