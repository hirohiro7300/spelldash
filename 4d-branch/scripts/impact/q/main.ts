// 3 か月ごと 12 段の「3 年の地図」の木と同梱データを作る入口（Vite の SSR で読み込む。R1 の試作の入口 model-tree/proto.ts を移した物）。
// 使い方（4d-branch で）:
//   node scripts/impact/q/run.mjs --out <木.json> [--force] [--bundle <同梱.b64>] [--release 0] [--record <版の記録.json>] [--history <releases.json>] [--append-history] [--runs 2] [--spread 5] [--spread-never]
//                                 [--budget 2000] [--tol 0.02] [--alts 4] [--alts-by 0,4,4,4,4,3,3,3,3,2,2,2|off] [--only keep,ad_permside] [--anchor 2026-11] [--never on|off]
//   （npm run impact:q -- --out <木.json> も同じ。npm からは 4d-branch で動くので、場所は絶対パスで書く）
//   --budget 最初の手ごとの分かれ道の数・--tol その目標の幅（±。小さい予算のテストの木は分かれ道の数が飛ぶので広げる）・--alts 見せる手の数・--alts-by 段ごとの見せる手の数（off で --alts だけ）・
//   --only 作る最初の手・--anchor 0 か月目の年月（1〜3 月なら今日の手に昇格を狙う手が足される）・
//   --never 「3 年やらない」見積もりを作るか（off は試すとき用。粗い表を 16 回作り直すので 1 分ほどかかる）・
//   --spread 粗い表を引き始める順を変えて今日の手の差の幅を測る順の数（報告だけ。1 で測らない）・--spread-never その順ごとに k の幅も測る（遅い）・
//   --force 書き出す場所にファイルがあっても書き直す・
//   --bundle 同梱データ（決まった並びの gzip の base64。src/demo/impactBundle.ts が読む）を書く場所・--release 入口の版の順番（開発用の木は 0）・
//   --record 提案する版の記録 {release, hash, anchor} を書く場所・--history 版の記録（足すだけ。既定は scripts/impact/releases.json）・
//   --append-history 版の記録に足す（既定は足せるかだけを点検する）・--runs 2 なら最初から作り直して、決まった並びと指紋が同じかを点検する（既定 2）
// 版の順番を付ける（--release 1 以上）のは本番の形の時だけ（今日の手すべて・2,000・±2%・never・2 回。cli.ts の productionProblems）。
// 版の木は版ごとの場所（例 作業メモ deepmap/gen/r7/）に書き、開発用の木（deepmap/dev/*.json）は --release 0 で作る（試し版の画面が版の番号を出すので）。
// 既定は R1 が選んだ形（最初の手ごとに 2,000 の分かれ道・見せる手は 1 年目 4・2 年目 3・3 年目 2・まとめた手の結果も元の地図と同じまとめ方）。
// 前提は P2 の物（作業メモ SPEC v1 §2.2・§2.3。world.ts の CHANGES）。4 月などの暦は --anchor の年月から出す。
// 分かれ道の数は最初の手ごとに min(目標, 届く上限) の ±2%（D1）。分ける予算が飽和した手は、事実の小さい組を分け・別の領域の手を広げる。
// 今日の手の q は「3 年やらない」見積もりの _all と同じ表（何も除かない作り直しの表）から出す（k(fam) と比べられるように。見直し truth-2）。
// 書き出す物: <木.json>（開発用の入れ子の木。src/deepmap/mapData.ts の DevTree。同梱データの精度に丸めた木で、入口の hash は同梱データの中身の指紋）と、
// その隣の <木.json>.gz、--bundle の同梱データ、--record の版の記録。
// 一貫性（おすすめの道がまとめた手に入らない）は年収 360・540 のどちらでも守る（判断ごとに年収ごとの一番良い手を広げる。gen.ts。SPEC v1 §2.8）。
// 文章（--text on。既定）: 題・短い名前・やること（元の番号つき）を文章の組み立て（src/demo/compose の composeCard）で焼き込み、入口の textVersion を
// 文の型の束の版にする（./text.ts。年収で変わらないことも確かめる）。文章の点検（scripts/impact/textChecks.ts の runTextChecks。40 秒ほど）も生成の点検に入れる。
// 前提の文と手の決まりの点検（./checks.ts の premiseRuleChecks: J3・J4・K2）、生成の木の点検（./checks.ts: 一貫性（年収ごと）・N10・N7・顧客は整数・幅・名前・事実・暦・
// 転職活動の上限・q・mix・cont・分かれ道の数・ノードの数・3 か月の結果の入れ物）・文章の焼き込み（TB2）と、同梱データを読み手で読んだ地図の点検（./check.ts: 読み手・
// 木の形 S1〜S5・ノードの数・分かれ道・N10・顧客・暦・一貫性（年収 360・540）・アプリと同じ値・ID・決まり・大きさ・版の記録。./text.ts: 焼き込んだ文章 = その場の
// 組み立て（TB1）・文章の点検（TC））にどれか通らなければ、何も書き出さない。
// 報告だけの数（通らなくても書き出す）: 表を引く順を変えた時の今日の手の差と k の幅（truth-2）・標準の続きを 1 段改善した時の伸び（truth-5）・
// 届け出の答えの順（truth-4）・k(fam) < −1 の注意・標準の続きと一番良い手の手の割合（truth-1）。
// 同じ引数なら同じ木と同じ同梱データ（バイトまで同じ）。木は大きい（30 MB 台）のでリポジトリの外に書き出す

import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { BUNDLE_FORMAT, decodeBundle, decodeBundleBytes } from "../../../src/demo/impactBundle";
import { gunzipSync as gunzipJs } from "../../../src/demo/inflate";
import { fromDevTree } from "../../../src/deepmap/dev/fromTree";
import type { DevTree } from "../../../src/deepmap/mapData";
import { IMPACT_STAR_LEAD } from "../../../src/model/impact";
import type { World } from "../sim";
import { goldenMarkdown, goldenPaths, reportMarkdown } from "../textChecks";
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
  checkStructure,
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
import { bestOf, checkOutputs, checkTree, filingDominance, premiseRuleChecks } from "./checks";
import { parseArgs, USAGE, type CliOpts } from "./cli";
import { OutcomeCache, simCount, Wsum } from "./core";
import { toDevTree } from "./devTree";
import { consistencyOf, generate, rollbackApp, type Consistency, type MoveStats, type QNode } from "./gen";
import { improvementGains, neverValues, orderRuns, releaseRolls, rootTable, spreadOf, starCounts, summaryOutputs, type NeverResult } from "./outputs";
import { bakeText, checkBaked, textGate, textSummary } from "./text";
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

/** 年収 360・540 万円の 2 つの数を「a・b」で */
const two = (v: (s: number) => number, d = 2) => `${v(30).toFixed(d)}・${v(45).toFixed(d)}`;

/** 報告: 標準の続き（cont）の手の割合と、判断の一番良い手の割合（見直し truth-1: 標準の続きがある手に偏っていないか） */
function contShares(root: QNode): string {
  const cont = new Map<string, number>();
  const best = new Map<string, number>();
  let nc = 0;
  let nb = 0;
  const walk = (n: QNode) => {
    if (n.cont) for (const c of n.cont) (cont.set(c.kind, (cont.get(c.kind) ?? 0) + 1), nc++);
    if (n.role === "s" && n.kids.length >= 2) {
      // その判断の一番良い手（訳が best の手。無ければ今のままが一番）
      const b = n.kids.find((x) => x.why === "best") ?? n.kids.find((x) => x.kind === "keep");
      if (b) (best.set(b.kind!, (best.get(b.kind!) ?? 0) + 1), nb++);
    }
    for (const k of n.kids) walk(k);
  };
  walk(root);
  const kinds = [...new Set([...cont.keys(), ...best.keys()])].sort((a, b) => (cont.get(b) ?? 0) - (cont.get(a) ?? 0) || a.localeCompare(b));
  return kinds.map((k) => `${k} ${pct((cont.get(k) ?? 0) / Math.max(1, nc))}・${pct((best.get(k) ?? 0) / Math.max(1, nb))}`).join(" / ");
}

/**
 * 報告: アプリのおすすめの道（最初の手ごとに、どの判断でも後ろからの木の値で一番の手。rollbackApp の後に呼ぶ）の判断のうち、アプリの選ぶ手が
 * 訳 best の手（無ければ今のまま。生成の年収の q で一番の手）と違う判断。2 つの年収の一番良い手を両方広げた判断では、木の値で選ぶアプリが、
 * もう一方の年収の一番良い手を選ぶことがある。dq はその判断の（アプリの選ぶ手 − 訳 best の手）の q（この年収の万円）
 */
function recommendedGap(root: QNode, S: number): { decisions: number; both: number; differ: number; toS2: number; dqLo: number; dqHi: number; examples: string[] } {
  let decisions = 0;
  let both = 0;
  let differ = 0;
  let toS2 = 0;
  let dqLo = Infinity;
  let dqHi = -Infinity;
  const examples: string[] = [];
  const walk = (a: QNode) => {
    for (const n of a.kids) {
      if (n.role !== "s") continue;
      decisions++;
      const b = bestOf(n);
      const rec = n.kids.find((x) => x.why === "best") ?? n.kids.find((x) => x.kind === "keep")!;
      if (n.kids.some((x) => x.forS2 && !x.stub)) both++;
      if (b !== rec) {
        differ++;
        if (b.forS2) toS2++;
        const dq = Wsum(b.qv ?? [0, 0, 0], S) - Wsum(rec.qv ?? [0, 0, 0], S);
        dqLo = Math.min(dqLo, dq);
        dqHi = Math.max(dqHi, dq);
        if (examples.length < 3) examples.push(`${n.key}（${b.kind}${b.forS2 ? "・540 万円の一番良い手" : ""}・木の値 ${(b.V - rec.V).toFixed(2)}・q ${dq.toFixed(2)}）`);
      }
      if (!b.stub) walk(b);
    }
  };
  for (const a0 of root.kids) walk(a0);
  return { decisions, both, differ, toS2, dqLo, dqHi, examples };
}

/** 報告: 事実の小さい組を分けたまま残した結果（予算の使い道 1。段 fineDepth まで）を、手と結果の名前ごとに数える（見込みの幅と例の鍵） */
function fineReport(root: QNode): Array<{ what: string; n: number; pLo: number; pHi: number; example: string }> {
  const m = new Map<string, { what: string; n: number; pLo: number; pHi: number; example: string }>();
  const walk = (n: QNode) => {
    if (n.out?.fine && n.parent) {
      const what = `${n.parent.kind}→${n.out.id}（${n.out.lab}）`;
      const g = m.get(what) ?? { what, n: 0, pLo: Infinity, pHi: -Infinity, example: n.key };
      g.n++;
      g.pLo = Math.min(g.pLo, n.out.p);
      g.pHi = Math.max(g.pHi, n.out.p);
      m.set(what, g);
    }
    for (const k of n.kids) walk(k);
  };
  walk(root);
  return [...m.values()].sort((a, b) => b.n - a.n || a.what.localeCompare(b.what));
}

/** 木を作り、生成の木を点検し、丸めて同梱データの並びにする。report が true なら報告を出し、報告だけの数（順の幅・改善の伸び）も測る */
function runOnce(base: World, opts: CliOpts, report: boolean): Run {
  const w = quarterWorld(base, opts.anchor);
  const P = opts.params;
  const S = w.annual / 12;
  const fails: string[] = [];
  // 長い段の進み具合（報告する回だけ。標準エラーに、始めからの秒とヒープ）
  const t00 = performance.now();
  const progress = (what: string) => {
    if (report) console.error(`[${((performance.now() - t00) / 1000).toFixed(0)} 秒・ヒープ ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)} MB] ${what}`);
  };
  // 前提の文と手の決まり（木を作る前に。見直し truth-3・truth-6・truth-7）
  const prem = premiseRuleChecks(w);
  fails.push(...prem);
  simCount.n = 0;
  progress("木を作る");
  const { root: tree, stats, gen, dp, msTable, msGen } = generate(w, P, opts.only);
  progress("木ができた");
  const genSizes = { cells: dp.memo.size, rolls: gen.ro.memo.size };
  const vRoot = rollbackApp(tree, S);
  const con = consistencyOf(tree);
  const keepA = tree.kids.find((a) => a.kind === "keep");
  const delta = new Map(tree.kids.map((a) => [a.kind!, keepA ? a.V - keepA.V : NaN]));
  // 一貫性と、アプリの選ぶ手が訳 best と違う判断を、一貫性を守る年収ごとに（SPEC v1 §2.8: 360・540 のどちらでも、おすすめの道はまとめた手に入らない）
  const annuals = [w.annual, ...P.annuals.filter((a) => a !== w.annual)];
  const conAt = new Map<number, Consistency>();
  const gapAt = new Map<number, ReturnType<typeof recommendedGap>>();
  for (const annual of annuals) {
    rollbackApp(tree, annual / 12);
    conAt.set(annual, annual === w.annual ? con : consistencyOf(tree));
    gapAt.set(annual, recommendedGap(tree, annual / 12));
  }
  const vSQ = rollbackApp(tree, S, true);
  // 新しい出力: まとめた行き先の中身と標準の続き（続きの見積もりの形がある間に）
  const tOut = performance.now();
  const so = summaryOutputs(w, tree);
  const msOut = performance.now() - tOut;
  // 続きの見積もりの形と生成の粗い表はもう使わないので放す（「3 年やらない」見積もりの表を作り直す前に。node の既定のヒープ 2 GB に収める）
  releaseRolls(tree);
  gen.ro.memo.clear();
  dp.memo.clear();
  // 今日の手の q: 何も除かない作り直しの表（never._all と同じ表）から（見直し truth-2）。生成の表の q との差は報告する
  const fineAt = (k: string) => !!stats.find((s) => s.kind === k)?.calib.fine;
  const oc = new OutcomeCache(S);
  progress("今日の手の q の表");
  const root = rootTable(w, S, fineAt, oc);
  let qMoved = 0;
  for (const a0 of tree.kids) {
    const v = root.one.qs[a0.kind!];
    if (!v) throw new Error(`今日の手 ${a0.kind} の q が表にありません`);
    qMoved = Math.max(qMoved, Math.abs(Wsum(v, S) - Wsum(a0.qv!, S)));
    a0.qv = v;
  }
  const deltaQ = new Map(tree.kids.map((a) => [a.kind!, keepA ? Wsum(a.qv!, S) - Wsum(keepA.qv!, S) : NaN]));
  // 標準の続きを 1 段改善した時の伸び（報告だけ。今日の手の q を出した表で測ってから、その表の形を放す）
  if (report) progress("標準の続きを 1 段改善した時の伸び");
  const gains = report ? improvementGains(w, S, fineAt, root) : null;
  root.dp.memo.clear();
  root.ro.memo.clear();
  const lines: string[] = [];
  lines.push(`形: ${JSON.stringify(P)}・最初の手 ${opts.only?.join(",") ?? `今日の ${w.rootMenu.length} 手`}`);
  lines.push(
    `粗い表 ${genSizes.cells} マス（${msTable.toFixed(0)} ms）・生成 ${msGen.toFixed(0)} ms・3 か月の数え上げ ${simCount.n} 回・続きの見積もり ${genSizes.rolls} 状態・正確な見積もり ${gen.evals} 回・分け方を落とした判断 ${gen.guards}（そのうち 540 万円の余裕だけで ${gen.guardsS2}）`,
  );
  {
    const sf = [...gen.shortfalls].sort((a, b) => a - b);
    const q = (p: number) => (sf[Math.floor(p * (sf.length - 1))] ?? 0).toFixed(2);
    lines.push(`分け方を落とした時の不足（続きの見積もり − 細かく分けた一番良い手、万円）: 10% ${q(0.1)}・50% ${q(0.5)}・90% ${q(0.9)}・最大 ${q(1)}`);
  }
  lines.push(`今日の値 ${vRoot.toFixed(2)}・ずっと今のまま ${vSQ.toFixed(2)}（年収 ${w.annual} 万円・地図の年月 ${w.anchor}・4 月 ${w.constants.aprilMonths.join(",")} か月目）`);
  lines.push(`今日の手の q は作り直しの表（never._all と同じ表: ${root.one.cells} マス・${root.one.ms.toFixed(0)} ms）から。生成の表の q との差は最大 ${qMoved.toFixed(2)} 万円`);
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
  // 今日の手の今のままとの差を、確かめる年収ごとに（木の値・q。q は never._all と同じ表）
  for (const annual of annuals) {
    const s2 = annual / 12;
    rollbackApp(tree, s2);
    const k = tree.kids.find((a) => a.kind === "keep");
    const row = [...tree.kids]
      .sort((a, b) => Wsum(b.qv!, s2) - Wsum(a.qv!, s2))
      .map((a) => `${a.kind} ${k ? (a.V - k.V).toFixed(2) : "-"}・${k ? (Wsum(a.qv!, s2) - Wsum(k.qv!, s2)).toFixed(2) : "-"}`);
    lines.push(`今日の手の今のままとの差（年収 ${annual}・木の値・q。q の大きい順）: ${row.join(" / ")}`);
  }
  lines.push("予算の合わせ込み（D1）: 最初の手 | 分かれ道 / 目標 | 事実の小さい組も分ける（分けた結果の数） | 分ける予算だけで飽和（予算 ∞ の分かれ道） | 別の領域の手を広げた判断（戻した・広げられる判断） | 届く上限 | 内側の予算 | 作り直し");
  for (const s of stats) {
    const c = s.calib;
    lines.push(
      `  ${s.kind} | ${s.forks} / ${c.target}${c.hit ? "" : "（外れ）"} | ${c.fine ? `あり（${s.fineOuts}）` : c.fineDropped ? "予算に収まらない" : "-"} | ${c.saturated ? `飽和（${c.splitMax}）` : "-"} | ${c.areaN ? `${c.areaUsed - c.areaReverted}（${c.areaReverted}・${c.areaEligible}）` : "-"} | ${c.reachMax ?? "-"} | ${c.Bint === Infinity ? "∞" : c.Bint.toFixed(0)} | ${c.passes}`,
    );
  }
  {
    // 事実の小さい組を分けたまま残した結果（予算の使い道 1。SPEC v1 §2.2 の例: 届け出て副業の『全部可』で 1 社目が決まる 8%）
    const fr = fineReport(tree);
    lines.push(`事実の小さい組を分けた結果（段 ${P.fineDepth} まで・${fr.reduce((a, g) => a + g.n, 0)} 枚・${fr.length} 種類）: ${fr.map((g) => `${g.what} ${g.n} 枚（${g.pLo === g.pHi ? `${g.pLo}%` : `${g.pLo}〜${g.pHi}%`}・例 ${g.example}）`).join(" / ")}`);
  }
  // 2 つ目の年収の一番良い手（決まり 2 を 540 万円でも。広げた・見せる手に足した・要らなかったので戻した）
  lines.push(
    `540 万円の一番良い手（生成の年収と違う判断で広げる）: ${stats.map((s) => `${s.kind} ${s.s2Exp}（足した ${s.s2Added}・戻した ${s.calib.s2Reverted}）`).join("・")}。合わせて広げたまま ${stats.reduce((a, s) => a + s.s2Exp, 0)}・見せる手に足した ${stats.reduce((a, s) => a + s.s2Added, 0)}・戻した ${stats.reduce((a, s) => a + s.calib.s2Reverted, 0)}`,
  );
  for (const annual of annuals) {
    const c = conAt.get(annual)!;
    const g = gapAt.get(annual)!;
    lines.push(
      `一貫性（年収 ${annual}）: おすすめの道の判断 ${c.decisions}・まとめた手が勝った判断 ${c.violations}（最大 ${c.worst.toFixed(2)} 万円）・最初の手ごとのおすすめの道 ${c.piDecisions} 判断・まとめた手に入った道 ${c.piIntoStub}。` +
        `おすすめの道の判断 ${g.decisions} のうち、2 つの年収の一番良い手を両方広げた判断 ${g.both}・アプリの選ぶ手が訳 best（生成の年収の q で一番）と違う判断 ${g.differ}` +
        (g.differ ? `（540 万円の一番良い手を選ぶ ${g.toS2}・q の差（アプリの選ぶ手 − 訳 best）${g.dqLo.toFixed(2)}〜${g.dqHi.toFixed(2)} 万円・例 ${g.examples.join(" / ")}）` : ""),
    );
  }
  {
    const im = con.improv;
    const q = (p: number) => (im[Math.min(im.length - 1, Math.floor(p * im.length))] ?? 0).toFixed(2);
    lines.push(`広げた一番良い手の木の値 − その手の見積もり（万円）: 10% ${q(0.1)}・50% ${q(0.5)}・90% ${q(0.9)}・99.9% ${q(0.999)}・最大 ${(im.at(-1) ?? 0).toFixed(2)}`);
  }
  lines.push(`まとめた行き先の中身と標準の続き: ${so.sums} 枚（続きの見積もりの 36 か月目の行き先 ${so.leaves}・${msOut.toFixed(0)} ms）`);
  lines.push(`標準の続きの手の割合・判断の一番良い手の割合（見直し truth-1）: ${contShares(tree)}`);
  // 「3 年やらない」見積もり（今のまま以外のまとまりすべて。_all は今日の手の q を出した表）
  const fams = [...new Set(Object.values(w.kinds).map((k) => k.family))].filter((f) => f !== "keep");
  if (opts.never) progress("「3 年やらない」見積もり");
  const nv: NeverResult | null = opts.never ? neverValues(w, S, fineAt, fams, root, oc) : null;
  if (nv) {
    const all = nv.never._all!;
    lines.push("「3 年やらない」見積もり（never。粗い表をその種類なしで作り直す）: まとまり | 今日の手 | 360 万円 | 540 万円 | k = _all − never（360・540） | 表のマス | ms");
    for (const k of ["_all", ...fams]) {
      const v = nv.never[k]!;
      const i = nv.info[k]!;
      lines.push(`  ${k} | ${i.k} | ${Wsum(v, 30).toFixed(2)} | ${Wsum(v, 45).toFixed(2)} | ${k === "_all" ? "-" : two((s) => Wsum(all, s) - Wsum(v, s))} | ${i.cells} | ${i.ms.toFixed(0)}`);
    }
    lines.push(`  K0 3 か月の結果の入れ物を使い回して作り直した _all との差 k(none): ${two((s) => Wsum(all, s) - Wsum(nv.none.v, s), 3)}（${nv.none.ms.toFixed(0)} ms・入れ物 ${oc.m.size} 件・使い回し ${oc.hits} 回）`);
    const neg = fams.filter((f) => [30, 45].some((s) => Wsum(all, s) - Wsum(nv.never[f]!, s) < -1));
    if (neg.length) lines.push(`  注意: k(fam) < −1 のまとまり ${neg.map((f) => `${f}（${two((s) => Wsum(all, s) - Wsum(nv.never[f]!, s))}）`).join("・")}。手を除いて良くなるのは、標準の続きがその手を損な所で選ぶ印（見直し truth-1・truth-5）`);
  }
  if (report && gains) {
    // 標準の続きを 1 段改善した時の伸び（見直し truth-5）: 最初の手で違えば q の差はその分だけ偏る
    const g = gains;
    const keepG = g.gains.find((x) => x.k === "keep");
    const gl = (s: number) => g.gains.map((x) => `${x.k} ${(Wsum(x.qImproved, s) - Wsum(x.q, s)).toFixed(2)}`).join("・");
    lines.push(`標準の続きを 1 段改善した時の今日の手の q の伸び（万円。続きの状態 ${g.states}・${g.ms.toFixed(0)} ms。見直し truth-5）:`);
    lines.push(`  360: ${gl(30)}`);
    lines.push(`  540: ${gl(45)}`);
    if (keepG) {
      const dl = (s: number) => g.gains.filter((x) => x.k !== "keep").map((x) => `${x.k} ${(Wsum(x.q, s) - Wsum(keepG.q, s)).toFixed(2)}→${(Wsum(x.qImproved, s) - Wsum(keepG.qImproved, s)).toFixed(2)}`).join("・");
      lines.push(`  今のままとの差 q → 改善した続きの q: 360 ${dl(30)}`);
      lines.push(`  540 ${dl(45)}`);
    }
    // q の順位で隣どうしの差が、伸びの差（続きの偏り）より小さい所は、順位を言い切れない（★ や順位の変化は、差が伸びの差を超える時だけ数える）
    for (const sal of [30, 45]) {
      const byQ = [...g.gains].sort((a, b) => Wsum(b.q, sal) - Wsum(a.q, sal));
      const weak: string[] = [];
      for (let i = 0; i + 1 < byQ.length; i++) {
        const [a, b] = [byQ[i]!, byQ[i + 1]!];
        const lead = Wsum(a.q, sal) - Wsum(b.q, sal);
        const bias = Math.abs(Wsum(a.qImproved, sal) - Wsum(a.q, sal) - (Wsum(b.qImproved, sal) - Wsum(b.q, sal)));
        if (lead <= bias) weak.push(`${a.k} > ${b.k}（差 ${lead.toFixed(2)} ≤ 伸びの差 ${bias.toFixed(2)}）`);
      }
      lines.push(`  ${12 * sal}: q の順位 ${byQ.map((x) => x.k).join(" > ")}${weak.length ? `。言い切れない隣どうし: ${weak.join("・")}` : "（どの隣どうしも、差が伸びの差より大きい）"}`);
    }
    // 表を引き始める順を変えた時の幅（見直し truth-2）: 今日の手の差（q）と k
    if (opts.spread > 1) {
      progress("表を引き始める順を変えた時の幅");
      const t = performance.now();
      const runs = orderRuns(w, S, fineAt, root, opts.spreadNever ? nv : null, fams, opts.spread, oc);
      const keys = w.rootMenu.filter((k) => k !== "keep" && (!opts.only || opts.only.includes(k)));
      lines.push(`表を引き始める順を変えた時の幅（${runs.length} 通り: ${runs.map((r) => r.name).join("・")}。${((performance.now() - t) / 1000).toFixed(0)} 秒。見直し truth-2）:`);
      for (const s of [30, 45]) {
        const sp = (f: (r: (typeof runs)[number]) => number) => {
          const x = spreadOf(runs, f);
          return `${x.lo.toFixed(2)}〜${x.hi.toFixed(2)}（幅 ${(x.hi - x.lo).toFixed(2)}）`;
        };
        const bestOf = (r: (typeof runs)[number]) => w.rootMenu.filter((k) => r.qs[k]).reduce((b, k) => (Wsum(r.qs[k]!, s) > Wsum(r.qs[b]!, s) + 1e-9 ? k : b));
        lines.push(`  ${12 * s}: 今のままの q ${sp((r) => Wsum(r.qs.keep!, s))}・今日の一番の手 ${[...new Set(runs.map(bestOf))].join("・")}`);
        lines.push(`    今のままとの差（q）: ${keys.map((k) => `${k} ${sp((r) => Wsum(r.qs[k]!, s) - Wsum(r.qs.keep!, s))}`).join("・")}`);
        if (nv && opts.spreadNever) lines.push(`    k: ${fams.map((f) => `${f} ${sp((r) => Wsum(r.never._all!, s) - Wsum(r.never[f]!, s))}`).join("・")}`);
        if (new Set(runs.map(bestOf)).size > 1) lines.push(`    注意: 今日の一番の手が順で変わる（年収 ${12 * s} 万円）`);
      }
    }
  }
  // 3 か月の結果の入れ物（大きい）は、ここから先は使わない
  oc.m.clear();
  progress("★ の数と点検");
  // ★ の数（見直し truth-2）: 木の値で比べた場合と、同じ見積もり方で比べた場合
  for (const annual of annuals) {
    rollbackApp(tree, annual / 12);
    const sc = starCounts(tree, annual / 12, IMPACT_STAR_LEAD);
    const row = (name: string, c: (typeof sc)["all"]) => `  ${name}: 判断 ${c.decisions}・★ 木の値 ${c.tree}・同じ見積もり方 ${c.q}・両方 ${c.both}・木の値だけ ${c.tree - c.both}・同じ見積もり方だけ ${c.q - c.both}・一番の手が違う ${c.argmaxDiff}`;
    lines.push(`★（2 位より ${IMPACT_STAR_LEAD} 万円以上良い。年収 ${annual} 万円）`);
    lines.push(row("すべての判断", sc.all));
    lines.push(row("一番の手を広げ、まとめた手も並ぶ判断", sc.mixed));
    lines.push(row("おすすめの道の上（どちらかの年収で）", sc.pi));
  }
  rollbackApp(tree, S);
  // 届け出の答えの順（見直し truth-4。数えるだけ）
  for (const annual of [360, 540]) {
    rollbackApp(tree, annual / 12);
    const d = filingDominance(tree, annual / 12);
    lines.push(`届け出の答えの順（年収 ${annual}）: 答えで分かれた手 ${d.options}・SpellDash だけ可 < どちらも不可 ${d.sn}（最大 ${d.worstSn.toFixed(2)}）・全部可 < SpellDash だけ可 ${d.as}（最大 ${d.worstAs.toFixed(2)}）${d.examples.length ? `・例 ${d.examples.join(" / ")}` : ""}`);
  }
  // 前提の点検と転職活動の数（値は生成の年収で後ろから出し直してから）
  rollbackApp(tree, S);
  const chk = checkTree(w, tree);
  const outFails = checkOutputs(w, tree, { stats, tol: P.tol, ...(nv ? { never: nv, fams } : {}), maxNodes: MAX_NODES });
  lines.push(`メモリ: ヒープ ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)} MB（「3 年やらない」見積もりの後）`);
  lines.push(`前提の文と手の決まり（J3・J4・K2）: 通らない ${prem.length}${prem.length ? `（${prem.join(" / ")}）` : ""}`);
  lines.push(`前提の点検: 状態 ${chk.counts.states}（顧客の社数の違う場合をまとめた状態 ${chk.counts.mixed}）・通らない ${chk.fails.length}${chk.warns.length ? `・注意 ${chk.warns.join(" / ")}` : ""}・新しい出力の点検で通らない ${outFails.length}`);
  lines.push("最初の手 | 転職活動を 1 期以上 | 36 か月目に転職している | 一度でも転職 | 転職活動の期の数の平均 | 一番ありそうな道（見込み・続けて決まらなかった転職活動の一番長い期の数）");
  for (const s of chk.search) lines.push(`${s.kind} | ${pct(s.pSearch)} | ${pct(s.pSwitched)} | ${pct(s.pEverSwitched)} | ${s.meanSearch.toFixed(2)} | ${pct(s.chainP)}・${s.chainMaxFailRun}`);
  for (const s of chk.search) lines.push(`  ${s.kind}: ${s.chain.join(" ")}`);
  if (report) console.log(lines.join("\n"));
  for (const [annual, c] of conAt) if (c.violations > 0 || c.piIntoStub > 0) fails.push(`一貫性（年収 ${annual}）: まとめた手が勝った判断 ${c.violations}・まとめた手に入った道 ${c.piIntoStub}`);
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
  // 開発用の木 → 同梱データの精度に丸めた木 → 文章の焼き込み → 決まった並び（入口の hash は中身の指紋）
  const raw = toDevTree(w, tree, { anchor: opts.anchor, release: opts.release, hash: "", textVersion: "dev", ...(nv ? { never: nv.never } : {}) });
  const rounding = roundingReport(raw);
  const dev = canonicalizeDevTree(raw);
  if (opts.text) {
    // 題・短い名前・やることは丸めた木（同梱データと同じ数）から組み立てる（SPEC v1 §4.3）。年収 540 万円でも同じことを確かめる
    progress("文章の焼き込み");
    const bake = bakeText(dev, { annuals: P.annuals });
    if (report)
      console.log(
        `文章の焼き込み（文の型 ${bake.textVersion}）: ${bake.cards} 枚・違う題 ${bake.distinct.title}・短い名前 ${bake.distinct.short}・やることのある手 ${bake.movesWithTodo}（${bake.todoItems} 件・文 ${bake.distinct.todo}・元の番号 ${bake.distinct.cite}）・組み立て ${bake.ms.map((x) => `${(x / 1000).toFixed(1)} 秒`).join("・")}・通らない ${bake.fails.length}${bake.fails.length ? `（${bake.fails.join(" / ")}）` : ""}`,
      );
    if (bake.fails.length) return { fails: bake.fails, w, stats, dev: null, bytes: empty, hash: "", vRoot: vR, rootDelta: rd, rounding };
  }
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
  // 書き出す場所にもう物があれば、--force が無い限り作る前に断る（測った木・試し版の木を黙って書き換えない。見直し format-4）
  const targets = [path.resolve(opts.out), `${path.resolve(opts.out)}.gz`, ...(opts.bundle ? [path.resolve(opts.bundle)] : []), ...(opts.record ? [path.resolve(opts.record)] : [])];
  const existing = targets.filter((p) => fs.existsSync(p));
  if (existing.length && !opts.force) {
    console.error(`書き出す場所にもうファイルがあります（書き直すなら --force）: ${existing.join("・")}`);
    return 2;
  }

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
  // 木の形（v0 の S1〜S5 を 3 か月ごとの地図に合わせた物。前は小さい木の単体テストだけ。SPEC v1 §2.8）
  const menu = opts.only ? w.rootMenu.filter((k) => opts.only!.includes(k)) : w.rootMenu;
  add("S1〜S5 木の形（親と鍵・判断と手と結果・今のまま・見込み・月と行き先）", checkStructure(map, menu), `今日の手 ${menu.length}`);
  add("N1 ノードの数", checkNodes(map), `${map.n} 枚（上限 ${MAX_NODES}）`);
  const forkRep = stats.map((s) => ({ kind: s.kind, forks: s.forks, target: s.calib.target }));
  const byMove = forksByFirstMove(map);
  add(`B1 最初の手ごとの分かれ道（合わせ込みの報告と同じ・目標の ±${+(100 * opts.params.tol).toFixed(1)}%）`, checkForks(map, forkRep, opts.params.tol), byMove.map((x) => `${x.kind} ${x.forks}`).join("・"));
  const n10 = checkN10(map);
  add("N10 Pro と届け出の答え", n10.fails, `まとめた行き先の代表の状態（数えるだけ）${n10.sumCount} 枚`);
  add("C1 顧客は整数の社数（幅は整数）", checkClients(map));
  add("K1 暦", checkCalendar(map, w.anchor, w.constants.aprilMonths), `${map.header.anchor}・4 月 ${w.constants.aprilMonths.join(",")} か月目`);
  // 一貫性はアプリが確かめる年収のどれでも（SPEC v1 §2.8: 360 と 540）
  for (const annual of [w.annual, ...opts.params.annuals.filter((a) => a !== w.annual)]) {
    const con = consistencyOfMap(map, annual);
    add(`R1 一貫性（年収 ${annual}: おすすめの道がまとめた手に入らない）`, con.fails, `判断 ${con.decisions}・入った ${con.intoStub}`);
  }
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
  // 文章: 焼き込んだ題・短い名前・やること = 読んだ地図でその場で組み立てた物（TB1）、文章の点検（TC。止める点検は通らない物、データの指摘は注意）
  if (opts.text) {
    const tb = performance.now();
    const baked = checkBaked(map);
    add("TB1 焼き込んだ題・短い名前・やること = 読んだ地図でその場で組み立てた物", baked, `文の型 ${map.header.textVersion}・${((performance.now() - tb) / 1000).toFixed(1)} 秒`);
    const tg = textGate(map);
    add("TC 文章の点検（runTextChecks・年収 360・540）", tg.fails, `${textSummary(tg.report)}・全部で ${(tg.ms / 1000).toFixed(0)} 秒`);
    if (tg.warns.length) lines.push(`    注意（データの指摘。止めない）: ${tg.warns.join(" / ")}`);
    else lines.push("    注意（データの指摘。止めない）: なし");
    if (opts.textReport) {
      const tp = path.resolve(opts.textReport);
      fs.mkdirSync(path.dirname(tp), { recursive: true });
      fs.writeFileSync(tp, reportMarkdown(tg.report));
      lines.push(`    文章の点検の報告: ${tp}`);
    }
  }
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
  if (opts.golden) {
    // 道の見本（今日の手ごとに一番ありそうな道・決まった種の道・どの手も同じ重みの道。年収 360・540。SPEC v1 §4.7）
    const gd = path.resolve(opts.golden);
    fs.mkdirSync(gd, { recursive: true });
    for (const annual of [360, 540]) fs.writeFileSync(path.join(gd, `golden-${annual}.md`), goldenMarkdown(map, goldenPaths(map, { annual }), annual));
    console.log(`道の見本: ${gd}/golden-{360,540}.md`);
  }
  if (opts.record) {
    const rp = path.resolve(opts.record);
    fs.mkdirSync(path.dirname(rp), { recursive: true });
    fs.writeFileSync(rp, `${JSON.stringify({ release: opts.release, hash: r1.hash, anchor: map.header.anchor }, null, 2)}\n`);
    console.log(`版の記録（提案）: ${rp}`);
  }
  if (opts.appendHistory && verdict === "append") {
    const rec: ReleaseEntry = {
      release: opts.release,
      hash: r1.hash,
      scheme: "q1",
      anchor: map.header.anchor,
      build: { B: opts.params.B, tol: opts.params.tol, moves: stats.length, never: opts.never, runs: opts.runs, nodes: map.n },
    };
    fs.writeFileSync(historyPath, formatHistory({ ...history, releases: [...history.releases, rec] }));
    console.log(`版の記録に足しました: ${historyPath}（版 ${opts.release}）`);
  }
  return 0;
}
