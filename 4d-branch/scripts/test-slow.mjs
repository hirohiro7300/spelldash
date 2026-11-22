// 遅いテスト（8 万枚の木）だけを動かす: npm run test:slow [-- vitest の引数]（見直し gaps-4・gaps-16）
//   DEEPMAP_SLOW=1 と、全部の木の場所の環境変数を決めて、tests/unit の *Slow.test.ts・*Full.test.ts だけを動かす（ふだんの npm test では飛ぶ物）:
//   IMPACT_Q_FULL: 3 か月ごとの地図の生成の書き出し（q-tree.json.gz と impact-q.b64。impactBundleQFull.test.ts が読む）の場所。作り方（4d-branch で）:
//       node scripts/impact/q/run.mjs --out <場所>/q-tree.json --bundle <場所>/impact-q.b64 --runs 1 --spread 1
//     渡さなければ、作業メモの書き出し（版 7 の候補 deepmap/gen/r7c、前の候補 deepmap/gen/r7b・deepmap/gen/r7、deepmap/gen/verify の順）のうち、
//     最初にあるもの。どれも無ければ止める
//     （遅いテストが、木が無いせいで何も確かめずに通らないように）
//   DEEPMAP_QTREE: 前提を直した木（.json か .json.gz）。渡さなければ <IMPACT_Q_FULL>/q-tree.json
//   DEEPMAP_TREE: R1 の木。渡さなければテストの既定（作業メモ deepmap/dev/r1-tree.json）。無ければ R1 の木の確かめは飛ぶ
//   ほかの引数は vitest に渡す（既定は --maxWorkers=2。8 万枚の文書を 1 つずつ持つので、並べすぎるとメモリが足りない）
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = "/tmp/claude-0/-home-user-spelldash/342dd9ca-ed44-551f-af59-60da8aff2834/scratchpad/deepmap";
const hasFull = (dir) => fs.existsSync(path.join(dir, "impact-q.b64")) && fs.existsSync(path.join(dir, "q-tree.json.gz"));

const env = { ...process.env, DEEPMAP_SLOW: "1" };
if (!env.IMPACT_Q_FULL) {
  const found = ["r7c", "r7b", "r7", "verify"].map((d) => path.join(SCRATCH, "gen", d)).find(hasFull);
  if (!found) {
    console.error("全部の木の書き出しがありません。IMPACT_Q_FULL に場所を渡してください（作り方は scripts/test-slow.mjs の先頭）");
    process.exit(1);
  }
  env.IMPACT_Q_FULL = found;
} else if (!hasFull(env.IMPACT_Q_FULL)) {
  console.error(`IMPACT_Q_FULL（${env.IMPACT_Q_FULL}）に impact-q.b64 と q-tree.json.gz がありません`);
  process.exit(1);
}
env.DEEPMAP_QTREE ??= path.join(env.IMPACT_Q_FULL, "q-tree.json");
console.log(`遅いテスト: IMPACT_Q_FULL=${env.IMPACT_Q_FULL} DEEPMAP_QTREE=${env.DEEPMAP_QTREE}${env.DEEPMAP_TREE ? ` DEEPMAP_TREE=${env.DEEPMAP_TREE}` : ""}`);

const extra = process.argv.slice(2);
const workers = extra.some((a) => a.startsWith("--maxWorkers")) ? [] : ["--maxWorkers=2"];
// ファイルの名前の一部で絞る（*Slow.test.ts・*Full.test.ts。増えてもここは変えなくてよい）
const r = spawnSync(process.execPath, [path.join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "Slow.test.ts", "Full.test.ts", ...workers, ...extra], { cwd: ROOT, env, stdio: "inherit" });
process.exit(r.status ?? 1);
