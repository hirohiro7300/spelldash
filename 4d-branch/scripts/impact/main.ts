// 生成の入口（Vite の SSR で読み込む。src の TypeScript をそのまま使う）
import fs from "node:fs";
import path from "node:path";
import { generate } from "./generate";
import type { WriterText } from "./bundle";
import type { World } from "./sim";

export function main(root: string, args: string[]): number {
  const dir = path.join(root, "scripts/impact");
  const world = JSON.parse(fs.readFileSync(path.join(dir, "world.json"), "utf8")) as World;
  const texts: Record<string, WriterText> = {};
  const tdir = path.join(dir, "text");
  if (fs.existsSync(tdir)) {
    for (const f of fs.readdirSync(tdir).filter((x) => x.endsWith(".json")).sort()) Object.assign(texts, JSON.parse(fs.readFileSync(path.join(tdir, f), "utf8")));
  }
  const ai = args.indexOf("--annual");
  const annual = ai >= 0 ? Number(args[ai + 1]) : undefined;
  const t0 = Date.now();
  const res = generate(world, texts, annual ? { annual } : {});
  const out = path.join(dir, "out");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "report.md"), res.report);
  console.log(res.report.split("\n## 失敗")[0]);
  console.log(`失敗 ${res.failures.length}・気になる所 ${res.warnings.length}（${Date.now() - t0} ms）`);
  for (const f of res.failures.slice(0, 30)) console.log("  ✗", f);
  for (const wn of res.warnings.slice(0, 30)) console.log("  !", wn);
  if (res.failures.length) return 1;
  if (!args.includes("--no-write")) {
    fs.writeFileSync(path.join(root, "src/demo/impact-data.json"), JSON.stringify(res.bundle));
    console.log(`書き出し: src/demo/impact-data.json（${(JSON.stringify(res.bundle).length / 1e3).toFixed(0)} KB）`);
  }
  return 0;
}
