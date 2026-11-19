// 3 か月ごと 12 段の「3 年の地図」の木を作る入口（Vite の SSR で読み込む。R1 の試作の入口 model-tree/proto.ts を移した物）。
// 使い方（4d-branch で）:
//   node scripts/impact/q/run.mjs --out <木.json> [--budget 2000] [--alts 4] [--alts-by 0,4,4,4,4,3,3,3,3,2,2,2|off] [--stub split|fact|lean] [--fact-cl] [--only keep,ad_permside] [--anchor 2026-11] [--hash dev-port]
//   （npm run impact:q -- --out <木.json> も同じ。npm からは 4d-branch で動くので、場所は絶対パスで書く）
//   --budget 最初の手ごとの分かれ道の数・--alts 見せる手の数・--alts-by 段ごとの見せる手の数（off で --alts だけ）・--stub まとめた手の結果のまとめ方・
//   --fact-cl 顧客の数を事実として必ず分ける・--only 作る最初の手・--anchor 0 か月目の年月・--hash 入口の指紋の欄（開発用の木は仮の名前）
// 既定は R1 が選んだ形（最初の手ごとに 2,000 の分かれ道・見せる手は 1 年目 4・2 年目 3・3 年目 2・まとめた手の結果も元の地図と同じまとめ方）。
// 書き出す物: <木.json>（開発用の入れ子の木。src/deepmap/mapData.ts の DevTree）と、その隣の <木.json>.gz。
// 一貫性の点検（おすすめの道ではまとめた手が広げた手に勝たない・おすすめの道はまとめた手に入らない）に通らなければ書き出さない。
// 既定の形で 79,092 枚・1 つの CPU で 20〜30 秒・同じ引数なら同じ木（バイトまで同じ）。木は大きい（27 MB）のでリポジトリの外に書き出す

import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { World } from "../sim";
import { parseArgs, USAGE } from "./cli";
import { simCount } from "./core";
import { toDevTree } from "./devTree";
import { consistencyOf, generate, rollbackApp } from "./gen";
import { quarterWorld } from "./world";

export function main(root: string, args: string[]): number {
  const base = JSON.parse(fs.readFileSync(path.join(root, "scripts/impact/world.json"), "utf8")) as World;
  const w = quarterWorld(base);
  let opts;
  try {
    opts = parseArgs(args, w.rootMenu);
  } catch (e) {
    console.error((e as Error).message);
    console.error(USAGE);
    return 2;
  }
  const P = opts.params;
  const S = w.annual / 12;
  simCount.n = 0;
  const { root: tree, stats, gen, dp, msTable, msGen } = generate(w, P, opts.only);
  const vRoot = rollbackApp(tree, S);
  const con = consistencyOf(tree);
  const keepA = tree.kids.find((a) => a.kind === "keep");
  const delta = new Map(tree.kids.map((a) => [a.kind!, keepA ? a.V - keepA.V : NaN]));
  const vSQ = rollbackApp(tree, S, true);
  const lines: string[] = [];
  lines.push(`形: ${JSON.stringify(P)}・最初の手 ${opts.only?.join(",") ?? "今日の 10 手"}`);
  lines.push(
    `粗い表 ${dp.memo.size} マス（${msTable.toFixed(0)} ms）・生成 ${msGen.toFixed(0)} ms・3 か月の数え上げ ${simCount.n} 回・続きの見積もり ${gen.ro.memo.size} 状態・正確な見積もり ${gen.evals} 回・分け方を落とした判断 ${gen.guards}`,
  );
  {
    const sf = [...gen.shortfalls].sort((a, b) => a - b);
    const q = (p: number) => (sf[Math.floor(p * (sf.length - 1))] ?? 0).toFixed(2);
    lines.push(`分け方を落とした時の不足（続きの見積もり − 細かく分けた一番良い手、万円）: 10% ${q(0.1)}・50% ${q(0.5)}・90% ${q(0.9)}・最大 ${q(1)}`);
  }
  lines.push(`今日の値 ${vRoot.toFixed(2)}・ずっと今のまま ${vSQ.toFixed(2)}（年収 ${w.annual} 万円）`);
  lines.push("最初の手 | 分かれ道（判断/広げた手/まとめた手） | ノード | 判断 | 手（まとめた手） | 行き先（まとめた行き先） | 数も分けた判断 | 深さ | ms（作り直し） | 今のままとの差 | 3〜33 か月目の状態の数");
  const tot = { forks: 0, nodes: 1, decisions: 0, options: 0, stubs: 0, ends: 0, sumEnds: 0 };
  for (const s of stats) {
    tot.forks += s.forks;
    tot.nodes += s.nodes;
    tot.decisions += s.decisions;
    tot.options += s.options;
    tot.stubs += s.stubs;
    tot.ends += s.ends;
    tot.sumEnds += s.sumEnds;
    const d = delta.get(s.kind);
    lines.push(
      `${s.kind} | ${s.forks}（${s.decisions}/${s.fe}/${s.fs}） | ${s.nodes} | ${s.decisions} | ${s.options}（${s.stubs}） | ${s.ends}（${s.sumEnds}） | ${s.splitDecisions} | ${s.maxDepth} | ${s.ms.toFixed(0)}（${s.passes}） | ${d === undefined || Number.isNaN(d) ? "-" : d.toFixed(2)} | ${s.byStage.slice(1, 12).join(" ")}`,
    );
  }
  lines.push(`合計（今日を含む）: 分かれ道 ${tot.forks + 1}・ノード ${tot.nodes}・判断 ${tot.decisions + 1}・手 ${tot.options}（まとめた手 ${tot.stubs}）・行き先 ${tot.ends}（まとめた行き先 ${tot.sumEnds}）`);
  lines.push(`一貫性: おすすめの道の判断 ${con.decisions}・まとめた手が勝った判断 ${con.violations}（最大 ${con.worst.toFixed(2)} 万円）・最初の手ごとのおすすめの道 ${con.piDecisions} 判断・まとめた手に入った道 ${con.piIntoStub}`);
  {
    const im = con.improv;
    const q = (p: number) => (im[Math.min(im.length - 1, Math.floor(p * im.length))] ?? 0).toFixed(2);
    lines.push(`広げた一番良い手の木の値 − その手の見積もり（万円）: 10% ${q(0.1)}・50% ${q(0.5)}・90% ${q(0.9)}・最大 ${q(0.999)}`);
  }
  console.log(lines.join("\n"));
  if (con.violations > 0 || con.piIntoStub > 0) {
    console.error("一貫性の点検に通らないので書き出しません");
    return 1;
  }
  const dev = toDevTree(w, tree, { anchor: opts.anchor, release: 0, hash: opts.hash, textVersion: "dev" });
  const json = JSON.stringify(dev);
  const out = path.resolve(opts.out);
  if (!path.relative(root, out).startsWith("..")) console.warn(`リポジトリの中に書き出します（${path.relative(root, out)}）。大きいのでコミットしないこと`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, json);
  const gz = gzipSync(json, { level: 9 });
  fs.writeFileSync(`${out}.gz`, gz);
  console.log(`書き出し: ${out}（${(json.length / 1e6).toFixed(1)} MB）・${out}.gz（${(gz.length / 1e6).toFixed(2)} MB）・${JSON.stringify(dev.header.counts)}`);
  return 0;
}
