// 3 年の分かれ道のデータを作る: node scripts/impact/run.mjs [--annual 540] [--no-write]
// src の TypeScript（計算・文書の組み立て）をそのまま使うため、Vite の SSR で読み込む
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const server = await createServer({ root, configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", logLevel: "error", optimizeDeps: { noDiscovery: true, include: [] } });
let code = 1;
try {
  const mod = await server.ssrLoadModule("/scripts/impact/main.ts");
  code = mod.main(root, process.argv.slice(2));
} finally {
  await server.close();
}
process.exit(code);
