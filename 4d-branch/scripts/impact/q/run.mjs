// 3 か月ごと 12 段の「3 年の地図」の木と同梱データを作る: node scripts/impact/q/run.mjs --out <木.json> [--bundle <同梱.b64>] [引数は main.ts の先頭に書いてある]
// src と scripts/impact の TypeScript をそのまま使うため、Vite の SSR で読み込む（scripts/impact/run.mjs と同じ作り）。
// 「3 年やらない」見積もりと順の幅の粗い表は大きい（node の既定のヒープ 2 GB を超える）ので、ヒープの上限を指定していなければ 6 GB で起動し直す
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HEAP_MB = 6144;
const hasHeap = process.execArgv.some((a) => a.startsWith("--max-old-space-size")) || /--max-old-space-size/.test(process.env.NODE_OPTIONS ?? "");
if (!hasHeap) {
  const r = spawnSync(process.execPath, [`--max-old-space-size=${HEAP_MB}`, ...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const { createServer } = await import("vite");
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
