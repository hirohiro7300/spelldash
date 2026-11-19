// 3 か月ごと 12 段の「3 年の地図」の木と同梱データを作る入口（Vite の SSR で読み込む。R1 の試作の入口 model-tree/proto.ts を移した物）。
// 使い方（4d-branch で）:
//   node scripts/impact/q/run.mjs --out <木.json> [--bundle <同梱.b64>] [--release 0] [--record <版の記録.json>] [--history <releases.json>] [--append-history] [--runs 2]
//                                 [--budget 2000] [--tol 0.02] [--alts 4] [--alts-by 0,4,4,4,4,3,3,3,3,2,2,2|off] [--stub split|fact|lean] [--fact-cl] [--only keep,ad_permside] [--anchor 2026-11] [--never on|off]
//   （npm run impact:q -- --out <木.json> も同じ。npm からは 4d-branch で動くので、場所は絶対パスで書く）
//   --budget 最初の手ごとの分かれ道の数・--tol その目標の幅（±。小さい予算のテストの木は分かれ道の数が飛ぶので広げる）・--alts 見せる手の数・--alts-by 段ごとの見せる手の数（off で --alts だけ）・--stub まとめた手の結果のまとめ方・
//   --fact-cl 顧客の数を事実として必ず分ける・--only 作る最初の手・--anchor 0 か月目の年月・
//   --never 「3 年やらない」見積もりを作るか（off は試すとき用。粗い表を 16 回作り直すので 1 分ほどかかる）・
//   --bundle 同梱データ（決まった並びの gzip の base64。src/demo/impactBundle.ts が読む）を書く場所・--release 入口の版の順番（開発用の木は 0）・
//   --record 提案する版の記録 {release, hash, anchor} を書く場所・--history 版の記録（足すだけ。既定は scripts/impact/releases.json）・
//   --append-history 版の記録に足す（既定は足せるかだけを点検する）・--runs 2 なら最初から作り直して、決まった並びと指紋が同じかを点検する（既定 2）
// 既定は R1 が選んだ形（最初の手ごとに 2,000 の分かれ道・見せる手は 1 年目 4・2 年目 3・3 年目 2・まとめた手の結果も元の地図と同じまとめ方）。
// 前提は P2 の物（作業メモ SPEC v1 §2.2・§2.3。world.ts の CHANGES）。4 月などの暦は --anchor の年月から出す。
// 分かれ道の数は最初の手ごとに min(目標, 届く上限) の ±2%（D1）。分ける予算が飽和した手は、事実の小さい組を分け・別の領域の手を広げる。
// 書き出す物: <木.json>（開発用の入れ子の木。src/deepmap/mapData.ts の DevTree。同梱データの精度に丸めた木で、入口の hash は同梱データの中身の指紋）と、
// その隣の <木.json>.gz、--bundle の同梱データ、--record の版の記録。
// 生成の木の点検（./checks.ts: 一貫性・N10・N7・顧客は整数・幅・名前・事実・暦・転職活動の上限・q・mix・cont・分かれ道の数・ノードの数・k(none)）と、
// 同梱データを読み手で読んだ地図の点検（./check.ts: 読み手・ノードの数・分かれ道・N10・顧客・暦・一貫性・アプリと同じ値・ID・決まり・大きさ・版の記録）に
// どれか通らなければ、何も書き出さない。同じ引数なら同じ木と同じ同梱データ（バイトまで同じ）。木は大きい（30 MB 台）のでリポジトリの外に書き出す

import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { BUNDLE_FORMAT, decodeBundle, decodeBundleBytes } from "../../../src/demo/impactBundle";
import { gunzipSync as gunzipJs } from "../../../src/demo/inflate";
import { fromDevTree } from "../../../src/deepmap/dev/fromTree";
import type { DevTree } from "../../../src/deepmap/mapData";
import { IMPACT_STAR_LEAD } from "../../../src/model/impact";
import type { World } from "../sim";
import { bundleHash, bytesToBase64, canonicalizeDevTree, encodeMap, roundingReport } from "./bundle";
import {
  appParity,
  checkCalendar,
  checkClients,
  checkDeterminism,
  checkForks,
  checkIds,
  checkN10,
  checkNodes,
  checkReleaseAppend,
  checkReleaseHistory,
  checkSizes,
  compareMaps,
  consistencyOfMap,
  forksByFirstMove,
  formatHistory,
  mapValues,
  MAX_GZIP,
  MAX_NODES,
  MAX_RAW,
  type ReleaseEntry,
  type ReleaseHistory,
} from "./check";
import { checkOutputs, checkTree } from "./checks";
import { parseArgs, USAGE, type CliOpts } from "./cli";
import { simCount, Wsum } from "./core";
import { toDevTree } from "./devTree";
import { consistencyOf, generate, rollbackApp, type MoveStats } from "./gen";
import { neverValues, releaseRolls, starCounts, summaryOutputs } from "./outputs";
import { quarterWorld, type WorldQ } from "./world";

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
export { MAX_NODES };

/** 1 回作った物: 丸めた開発用の木・決まった並びのバイト列と指紋（通らなければ fails） */
interface Run {
  fails: string[];
  w: WorldQ;
  stats: MoveStats[];
  /** 丸めた開発用の木（入口の hash は中身の指紋） */
  dev: DevTree | null;
  bytes: Uint8Array;
  hash: string;
  /** 生成の木の値（年収 360・540）と今日の手の差（木の値）。読んだ地図の値と比べる */
  vRoot: Record<number, number>;
  rootDelta: Record<number, Map<string, number>>;
  rounding: Record<string, number>;
}

/** 木を作り、生成の木を点検し、丸めて同梱データの並びにする。report が true なら報告を出す */
function runOnce(base: World, opts: CliOpts, report: boolean): Run {
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
  if (report) console.log(lines.join("\n"));
  const fails: string[] = [];
  if (con.violations > 0 || con.piIntoStub > 0) fails.push(`一貫性: まとめた手が勝った判断 ${con.violations}・まとめた手に入った道 ${con.piIntoStub}`);
  fails.push(...chk.fails, ...outFails);
  // 生成の木の値（読んだ地図の値と比べる）
  const vR: Record<number, number> = {};
  const rd: Record<number, Map<string, number>> = {};
  for (const annual of [360, 540]) {
    vR[annual] = rollbackApp(tree, annual / 12);
    const keep = tree.kids.find((a) => a.kind === "keep");
    rd[annual] = new Map(tree.kids.map((a) => [a.kind!, keep ? a.V - keep.V : NaN]));
  }
  const empty = new Uint8Array(0);
  if (fails.length) return { fails, w, stats, dev: null, bytes: empty, hash: "", vRoot: vR, rootDelta: rd, rounding: {} };
  // 開発用の木 → 同梱データの精度に丸めた木 → 決まった並び（入口の hash は中身の指紋）
  const raw = toDevTree(w, tree, { anchor: opts.anchor, release: opts.release, hash: "", textVersion: "dev", ...(nv ? { never: nv.never } : {}) });
  const rounding = roundingReport(raw);
  const dev = canonicalizeDevTree(raw);
  const bytes = encodeMap(fromDevTree(dev));
  const hash = bundleHash(bytes);
  dev.header.hash = hash;
  return { fails, w, stats, dev, bytes, hash, vRoot: vR, rootDelta: rd, rounding };
}

export async function main(root: string, args: string[]): Promise<number> {
  const base = JSON.parse(fs.readFileSync(path.join(root, "scripts/impact/world.json"), "utf8")) as World;
  let opts: CliOpts;
  try {
    opts = parseArgs(args, base.rootMenu);
  } catch (e) {
    console.error((e as Error).message);
    console.error(USAGE);
    return 2;
  }
  const historyPath = path.resolve(opts.history ?? path.join(root, "scripts/impact/releases.json"));
  const history = JSON.parse(fs.readFileSync(historyPath, "utf8")) as ReleaseHistory;

  const r1 = runOnce(base, opts, true);
  if (r1.fails.length || !r1.dev) {
    console.error(`点検に通らないので書き出しません:\n${r1.fails.join("\n")}`);
    return 1;
  }
  const { w, stats } = r1;
  const lines: string[] = [];
  const fails: string[] = [];
  const add = (name: string, f: readonly string[], info = "") => {
    lines.push(`  ${f.length ? "×" : "○"} ${name}${info ? `: ${info}` : ""}`);
    fails.push(...f);
  };
  lines.push(`同梱データ（形 4DQM 版 ${BUNDLE_FORMAT}・中身の指紋 ${r1.hash}・版の順番 ${opts.release}）の点検（書いたバイト列を読み手で読んだ地図で）:`);
  lines.push(`  丸めの差の最大（元の木 → 同梱データ）: ${Object.entries(r1.rounding).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v.toExponential(1)}`).join("・") || "なし"}`);
  // 読み手（読む時間も）
  const t0 = performance.now();
  const map = decodeBundleBytes(r1.bytes);
  const msDecodeBytes = performance.now() - t0;
  add("B2 読み手が丸めた木の fromDevTree と同じ答え（全ノード・全部の問い）", compareMaps(fromDevTree(r1.dev), map), `${map.n} 枚`);
  const devJson = JSON.stringify(r1.dev);
  r1.dev = null;
  add("N1 ノードの数", checkNodes(map), `${map.n} 枚（上限 ${MAX_NODES}）`);
  const forkRep = stats.map((s) => ({ kind: s.kind, forks: s.forks, target: s.calib.target }));
  const byMove = forksByFirstMove(map);
  add(`B1 最初の手ごとの分かれ道（合わせ込みの報告と同じ・目標の ±${+(100 * opts.params.tol).toFixed(1)}%）`, checkForks(map, forkRep, opts.params.tol), byMove.map((x) => `${x.kind} ${x.forks}`).join("・"));
  const n10 = checkN10(map);
  add("N10 Pro と届け出の答え", n10.fails, `まとめた行き先の代表の状態（数えるだけ）${n10.sumCount} 枚`);
  add("C1 顧客は整数の社数（幅は整数）", checkClients(map));
  add("K1 暦", checkCalendar(map, w.anchor, w.constants.aprilMonths), `${map.header.anchor}・4 月 ${w.constants.aprilMonths.join(",")} か月目`);
  const con = consistencyOfMap(map, w.annual);
  const con540 = consistencyOfMap(map, 540);
  add(`R1 一貫性（年収 ${w.annual}: おすすめの道がまとめた手に入らない）`, con.fails, `判断 ${con.decisions}・入った ${con.intoStub}（参考: 年収 540 では ${con540.intoStub} / ${con540.decisions}）`);
  const par = appParity(map, [360, 540]);
  add(
    "R2 アプリと同じ値（|差| ≤ 1e-9）",
    par.fails,
    par.parities.map((p) => `年収 ${p.annual}: 今日 ${p.vRoot[0].toFixed(4)}・ずっと今のまま ${p.vSQ[0].toFixed(4)}・手 ${p.alts} の差の最大 ${p.maxDelta.toExponential(1)}・一番の手の違い ${p.bestMismatch}（${p.ms.toFixed(0)} ms）`).join(" / "),
  );
  for (const annual of [360, 540]) {
    const v = mapValues(map, annual);
    const keep = (() => {
      for (let k = 0; k < map.childCount(0); k++) if (map.isBase(map.child(0, k))) return map.child(0, k);
      return -1;
    })();
    const deltas: string[] = [];
    let worst = Math.abs(v.V[0]! - r1.vRoot[annual]!);
    for (let k = 0; k < map.childCount(0); k++) {
      const a = map.child(0, k);
      const d = v.V[a]! - v.V[keep]!;
      const g = r1.rootDelta[annual]!.get(map.kind(a)!) ?? NaN;
      worst = Math.max(worst, Math.abs(d - g));
      deltas.push(`${map.kind(a)} ${d.toFixed(2)}`);
    }
    lines.push(`    年収 ${annual}: 今日の値 ${v.V[0]!.toFixed(2)}（生成の木 ${r1.vRoot[annual]!.toFixed(2)}・丸めの差の最大 ${worst.toExponential(1)}）・今日の手の差 ${deltas.join("・")}`);
  }
  const ids = checkIds(map);
  add("I1 64 ビットの ID が重ならない", ids.fails, `ノード ${ids.nodes}・線 ${ids.edges}`);
  // 大きさ
  const gz = gzipSync(r1.bytes, { level: 9 });
  const b64 = bytesToBase64(gz);
  const sizes = { raw: r1.bytes.length, gzip: gz.length, base64: b64.length };
  add("Z1・Z2 大きさ", checkSizes(sizes), `決まった並び ${(sizes.raw / 1e6).toFixed(2)} MB（上限 ${MAX_RAW / 1e6}）・gzip ${(sizes.gzip / 1e6).toFixed(3)} MB（上限 ${MAX_GZIP / 1e6}）・base64 ${(sizes.base64 / 1e6).toFixed(3)} MB`);
  // 読む時間（node）: base64 → gzip を伸ばす → 読み手
  {
    const times: string[] = [];
    for (let k = 0; k < 3; k++) {
      const a = performance.now();
      await decodeBundle(b64);
      const b = performance.now();
      const raw = gunzipJs(gz);
      const c = performance.now();
      decodeBundleBytes(raw);
      const d = performance.now();
      times.push(`decodeBundle ${(b - a).toFixed(0)} ms・小さな伸長 ${(c - b).toFixed(0)} ms + decodeBundleBytes ${(d - c).toFixed(0)} ms`);
    }
    lines.push(`  読む時間（node）: 1 回目の decodeBundleBytes ${msDecodeBytes.toFixed(0)} ms / ${times.join(" / ")}`);
  }
  // 版の記録
  add("H1 版の記録（足すだけ・順番は増えるだけ）", checkReleaseHistory(history), `${path.relative(root, historyPath)}・最後の版 ${Math.max(...history.releases.map((r) => r.release))}`);
  let verdict: "append" | "same" | "refuse" | null = null;
  if (opts.release >= 1) {
    const ap = checkReleaseAppend(history, { release: opts.release, hash: r1.hash });
    verdict = ap.verdict;
    add(`H1 版 ${opts.release}・指紋 ${r1.hash} を記録に足せる`, ap.why, ap.verdict === "same" ? "同じ記録がもうある" : ap.verdict);
  }
  // 決まり: 読んだ地図を書き直しても同じ並び・最初から作り直しても同じ並び
  const runs = [{ bytes: r1.bytes, hash: r1.hash, what: "1 回目" }];
  const again = encodeMap(map);
  runs.push({ bytes: again, hash: bundleHash(again), what: "読んだ地図を書き直した物" });
  if (opts.runs >= 2) {
    const t2 = performance.now();
    const r2 = runOnce(base, opts, false);
    if (r2.fails.length) fails.push(`D1 作り直しで点検に通らない: ${r2.fails.slice(0, 3).join(" / ")}`);
    else runs.push({ bytes: r2.bytes, hash: r2.hash, what: `作り直し（${((performance.now() - t2) / 1000).toFixed(0)} 秒）` });
  }
  add("D1 決まった並びと指紋が同じ", checkDeterminism(runs), runs.map((r) => r.what).join("・"));
  console.log(lines.join("\n"));
  if (fails.length) {
    console.error(`同梱データの点検に通らないので書き出しません:\n${fails.join("\n")}`);
    return 1;
  }
  // 書き出し
  const out = path.resolve(opts.out);
  const inRepo = (p: string) => !path.relative(root, p).startsWith("..");
  if (inRepo(out)) console.warn(`リポジトリの中に書き出します（${path.relative(root, out)}）。大きいのでコミットしないこと`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, devJson);
  const devGz = gzipSync(devJson, { level: 9 });
  fs.writeFileSync(`${out}.gz`, devGz);
  console.log(`書き出し: ${out}（${(devJson.length / 1e6).toFixed(1)} MB）・${out}.gz（${(devGz.length / 1e6).toFixed(2)} MB）・${JSON.stringify(map.header.counts)}`);
  if (opts.bundle) {
    const bp = path.resolve(opts.bundle);
    fs.mkdirSync(path.dirname(bp), { recursive: true });
    fs.writeFileSync(bp, b64);
    console.log(`同梱データ: ${bp}（base64 ${b64.length} 文字）`);
  }
  if (opts.record) {
    const rp = path.resolve(opts.record);
    fs.mkdirSync(path.dirname(rp), { recursive: true });
    fs.writeFileSync(rp, `${JSON.stringify({ release: opts.release, hash: r1.hash, anchor: map.header.anchor }, null, 2)}\n`);
    console.log(`版の記録（提案）: ${rp}`);
  }
  if (opts.appendHistory && verdict === "append") {
    const rec: ReleaseEntry = { release: opts.release, hash: r1.hash, scheme: "q1", anchor: map.header.anchor };
    fs.writeFileSync(historyPath, formatHistory({ ...history, releases: [...history.releases, rec] }));
    console.log(`版の記録に足しました: ${historyPath}（版 ${opts.release}）`);
  }
  return 0;
}
