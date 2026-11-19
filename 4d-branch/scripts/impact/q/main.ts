// 3 か月ごと 12 段の「3 年の地図」の木を作る入口（Vite の SSR で読み込む。R1 の試作の入口 model-tree/proto.ts を移した物）。
// 使い方（4d-branch で）:
//   node scripts/impact/q/run.mjs --out <木.json> [--budget 2000] [--alts 4] [--alts-by 0,4,4,4,4,3,3,3,3,2,2,2|off] [--stub split|fact|lean] [--fact-cl] [--only keep,ad_permside] [--anchor 2026-11] [--hash dev-port] [--never on|off]
//   （npm run impact:q -- --out <木.json> も同じ。npm からは 4d-branch で動くので、場所は絶対パスで書く）
//   --budget 最初の手ごとの分かれ道の数・--alts 見せる手の数・--alts-by 段ごとの見せる手の数（off で --alts だけ）・--stub まとめた手の結果のまとめ方・
//   --fact-cl 顧客の数を事実として必ず分ける・--only 作る最初の手・--anchor 0 か月目の年月・--hash 入口の指紋の欄（開発用の木は仮の名前）・
//   --never 「3 年やらない」見積もりを作るか（off は試すとき用。粗い表を 16 回作り直すので 1 分ほどかかる）
// 既定は R1 が選んだ形（最初の手ごとに 2,000 の分かれ道・見せる手は 1 年目 4・2 年目 3・3 年目 2・まとめた手の結果も元の地図と同じまとめ方）。
// 前提は P2 の物（作業メモ SPEC v1 §2.2・§2.3。world.ts の CHANGES）。4 月などの暦は --anchor の年月から出す。
// 分かれ道の数は最初の手ごとに min(目標, 届く上限) の ±2%（D1）。分ける予算が飽和した手は、事実の小さい組を分け・別の領域の手を広げる。
// 書き出す物: <木.json>（開発用の入れ子の木。src/deepmap/mapData.ts の DevTree。手の q・まとめた行き先の mix と cont・入口の never つき）と、その隣の <木.json>.gz。
// 一貫性の点検（おすすめの道ではまとめた手が広げた手に勝たない・おすすめの道はまとめた手に入らない）と、前提の点検（checks.ts: N10・N7・
// 顧客は整数・幅・名前・事実・暦・転職活動の上限）、新しい出力の点検（q・mix・cont・分かれ道の数・ノードの数・k(none)）に通らなければ書き出さない。
// 同じ引数なら同じ木（バイトまで同じ）。木は大きい（20 MB 台）のでリポジトリの外に書き出す

import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { IMPACT_STAR_LEAD } from "../../../src/model/impact";
import type { World } from "../sim";
import { checkOutputs, checkTree } from "./checks";
import { parseArgs, USAGE } from "./cli";
import { simCount, Wsum } from "./core";
import { toDevTree } from "./devTree";
import { consistencyOf, generate, rollbackApp } from "./gen";
import { neverValues, releaseRolls, starCounts, summaryOutputs } from "./outputs";
import { quarterWorld } from "./world";

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
/** ノードの上限（SPEC v1 §2.6） */
export const MAX_NODES = 90_000;

export function main(root: string, args: string[]): number {
  const base = JSON.parse(fs.readFileSync(path.join(root, "scripts/impact/world.json"), "utf8")) as World;
  let opts;
  try {
    opts = parseArgs(args, base.rootMenu);
  } catch (e) {
    console.error((e as Error).message);
    console.error(USAGE);
    return 2;
  }
  const w = quarterWorld(base, opts.anchor);
  const P = opts.params;
  const S = w.annual / 12;
  simCount.n = 0;
  const { root: tree, stats, gen, dp, msTable, msGen } = generate(w, P, opts.only);
  const vRoot = rollbackApp(tree, S);
  const con = consistencyOf(tree);
  const keepA = tree.kids.find((a) => a.kind === "keep");
  const delta = new Map(tree.kids.map((a) => [a.kind!, keepA ? a.V - keepA.V : NaN]));
  const deltaQ = new Map(tree.kids.map((a) => [a.kind!, keepA ? Wsum(a.qv!, S) - Wsum(keepA.qv!, S) : NaN]));
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
  lines.push(`今日の値 ${vRoot.toFixed(2)}・ずっと今のまま ${vSQ.toFixed(2)}（年収 ${w.annual} 万円・地図の年月 ${w.anchor}・4 月 ${w.constants.aprilMonths.join(",")} か月目）`);
  lines.push("最初の手 | 分かれ道（判断/広げた手/まとめた手） | ノード | 判断 | 手（まとめた手） | 行き先（まとめた行き先） | 数も分けた判断 | 深さ | ms（作り直し） | 今のままとの差（木の値・q） | 3〜33 か月目の状態の数");
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
    const dq = deltaQ.get(s.kind);
    const f = (x: number | undefined) => (x === undefined || Number.isNaN(x) ? "-" : x.toFixed(2));
    lines.push(
      `${s.kind} | ${s.forks}（${s.decisions}/${s.fe}/${s.fs}） | ${s.nodes} | ${s.decisions} | ${s.options}（${s.stubs}） | ${s.ends}（${s.sumEnds}） | ${s.splitDecisions} | ${s.maxDepth} | ${s.ms.toFixed(0)}（${s.passes}） | ${f(d)}・${f(dq)} | ${s.byStage.slice(1, 12).join(" ")}`,
    );
  }
  lines.push(`合計（今日を含む）: 分かれ道 ${tot.forks + 1}・ノード ${tot.nodes}・判断 ${tot.decisions + 1}・手 ${tot.options}（まとめた手 ${tot.stubs}）・行き先 ${tot.ends}（まとめた行き先 ${tot.sumEnds}）`);
  lines.push("予算の合わせ込み（D1）: 最初の手 | 分かれ道 / 目標 | 分ける予算だけで飽和（予算 ∞ の分かれ道） | 事実の小さい組も分ける（予算 ∞） | 別の領域の手を広げた判断（戻した・広げられる判断） | 届く上限 | 内側の予算 | 作り直し");
  for (const s of stats) {
    const c = s.calib;
    lines.push(
      `  ${s.kind} | ${s.forks} / ${c.target}${c.hit ? "" : "（外れ）"} | ${c.saturated ? `飽和（${c.splitMax}）` : "-"} | ${c.fine ? `あり（${c.fineMax}）` : "-"} | ${c.areaN ? `${c.areaUsed - c.areaReverted}（${c.areaReverted}・${c.areaEligible}）` : "-"} | ${c.reachMax ?? "-"} | ${c.Bint === Infinity ? "∞" : c.Bint.toFixed(0)} | ${c.passes}`,
    );
  }
  lines.push(`一貫性: おすすめの道の判断 ${con.decisions}・まとめた手が勝った判断 ${con.violations}（最大 ${con.worst.toFixed(2)} 万円）・最初の手ごとのおすすめの道 ${con.piDecisions} 判断・まとめた手に入った道 ${con.piIntoStub}`);
  {
    const im = con.improv;
    const q = (p: number) => (im[Math.min(im.length - 1, Math.floor(p * im.length))] ?? 0).toFixed(2);
    lines.push(`広げた一番良い手の木の値 − その手の見積もり（万円）: 10% ${q(0.1)}・50% ${q(0.5)}・90% ${q(0.9)}・最大 ${q(0.999)}`);
  }
  // 新しい出力: まとめた行き先の中身と標準の続き
  const tOut = performance.now();
  const so = summaryOutputs(w, tree);
  lines.push(`まとめた行き先の中身と標準の続き: ${so.sums} 枚（続きの見積もりの 36 か月目の行き先 ${so.leaves}・${(performance.now() - tOut).toFixed(0)} ms）`);
  // 続きの見積もりの形と生成の粗い表はもう使わないので放す（「3 年やらない」見積もりの表を作り直す前に。node の既定のヒープ 2 GB に収める）
  releaseRolls(tree);
  gen.ro.memo.clear();
  dp.memo.clear();
  // 「3 年やらない」見積もり（今のまま以外のまとまりすべて）
  const fams = [...new Set(Object.values(w.kinds).map((k) => k.family))].filter((f) => f !== "keep");
  const fineAt = (k: string) => !!stats.find((s) => s.kind === k)?.calib.fine;
  const nv = opts.never ? neverValues(w, S, (k, x) => gen.modeFor(k, x, "lean"), fineAt, fams) : null;
  if (nv) {
    const all = nv.never._all!;
    lines.push("「3 年やらない」見積もり（never。粗い表をその種類なしで作り直す）: まとまり | 今日の手 | 360 万円 | 540 万円 | k = _all − never（360・540） | 表のマス | ms");
    for (const k of ["_all", ...fams]) {
      const v = nv.never[k]!;
      const i = nv.info[k]!;
      lines.push(
        `  ${k} | ${i.k} | ${Wsum(v, 30).toFixed(2)} | ${Wsum(v, 45).toFixed(2)} | ${k === "_all" ? "-" : `${(Wsum(all, 30) - Wsum(v, 30)).toFixed(2)}・${(Wsum(all, 45) - Wsum(v, 45)).toFixed(2)}`} | ${i.cells} | ${i.ms.toFixed(0)}`,
      );
    }
    const kn = (s: number) => (Wsum(all, s) - Wsum(nv.none.v, s)).toFixed(3);
    lines.push(`  k(none)（入れ物なしで作り直した同じ計算との差）: 360 万円 ${kn(30)}・540 万円 ${kn(45)}（${nv.none.ms.toFixed(0)} ms）`);
    const bestRoot = tree.kids.reduce((b, a) => (Wsum(a.qv!, S) > Wsum(b.qv!, S) ? a : b));
    lines.push(
      `  参考: 生成の粗い表での今日の q の一番（${bestRoot.kind} ${Wsum(bestRoot.qv!, S).toFixed(2)}）− _all（${nv.info._all!.k} ${Wsum(all, S).toFixed(2)}）= ${(Wsum(bestRoot.qv!, S) - Wsum(all, S)).toFixed(2)}（粗い表は引く順で代表の状態が変わる）`,
    );
  }
  // ★ の数（見直し truth-2）: 木の値で比べた場合と、同じ見積もり方で比べた場合
  rollbackApp(tree, S);
  {
    const sc = starCounts(tree, S, IMPACT_STAR_LEAD);
    const row = (name: string, c: (typeof sc)["all"]) => `  ${name}: 判断 ${c.decisions}・★ 木の値 ${c.tree}・同じ見積もり方 ${c.q}・両方 ${c.both}・木の値だけ ${c.tree - c.both}・同じ見積もり方だけ ${c.q - c.both}・一番の手が違う ${c.argmaxDiff}`;
    lines.push(`★（2 位より ${IMPACT_STAR_LEAD} 万円以上良い。年収 ${w.annual} 万円）`);
    lines.push(row("すべての判断", sc.all));
    lines.push(row("一番の手を広げ、まとめた手も並ぶ判断", sc.mixed));
    lines.push(row("おすすめの道の上", sc.pi));
  }
  // 前提の点検と転職活動の数（値は生成の年収で後ろから出し直してから）
  const chk = checkTree(w, tree);
  const outFails = checkOutputs(w, tree, { stats, tol: P.tol, ...(nv ? { never: nv, fams } : {}), maxNodes: MAX_NODES });
  lines.push(`メモリ: ヒープ ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)} MB（「3 年やらない」見積もりの後）`);
  lines.push(`前提の点検: 状態 ${chk.counts.states}（顧客の社数の違う場合をまとめた状態 ${chk.counts.mixed}）・通らない ${chk.fails.length}${chk.warns.length ? `・注意 ${chk.warns.join(" / ")}` : ""}・新しい出力の点検で通らない ${outFails.length}`);
  lines.push("最初の手 | 転職活動を 1 期以上 | 36 か月目に転職している | 一度でも転職 | 転職活動の期の数の平均 | 一番ありそうな道（見込み・続けて決まらなかった転職活動の一番長い期の数）");
  for (const s of chk.search) lines.push(`${s.kind} | ${pct(s.pSearch)} | ${pct(s.pSwitched)} | ${pct(s.pEverSwitched)} | ${s.meanSearch.toFixed(2)} | ${pct(s.chainP)}・${s.chainMaxFailRun}`);
  for (const s of chk.search) lines.push(`  ${s.kind}: ${s.chain.join(" ")}`);
  console.log(lines.join("\n"));
  if (con.violations > 0 || con.piIntoStub > 0) {
    console.error("一貫性の点検に通らないので書き出しません");
    return 1;
  }
  if (chk.fails.length || outFails.length) {
    console.error(`点検に通らないので書き出しません:\n${[...chk.fails, ...outFails].join("\n")}`);
    return 1;
  }
  const dev = toDevTree(w, tree, { anchor: opts.anchor, release: 0, hash: opts.hash, textVersion: "dev", ...(nv ? { never: nv.never } : {}) });
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
