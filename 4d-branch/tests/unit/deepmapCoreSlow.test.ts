// 8 万枚の開発用の木での計算の芯の確かめ（遅いので DEEPMAP_SLOW=1 のときだけ。ふだんの npm test では飛ばす）
//   DEEPMAP_SLOW=1 npx vitest run tests/unit/deepmapCoreSlow.test.ts --maxWorkers=2
// 木の置き場は DEEPMAP_TREE（R1 の木。無ければ R1 の木の確かめは飛ばす）・DEEPMAP_QTREE（前提を直した木。あれば）で変えられる。.json.gz でもよい。
// 確かめること: 年収 360 の確かめの数（作業メモ dev/check-values.ts）・8 万枚の文書でアプリの計算（computeImpact）と同じ答え・
// 時間の上限（組み直し ≤ 150 ms・逆にたどる + 前へ流す 1 回 ≤ 20 ms・今日の手ごとの見取り図の数を全部 ≤ 100 ms。3 回の一番速い物）

import { describe, expect, it } from "vitest";
import { analyze, compileMap, destinations, fanData, forkStrip, kindKey, moneyAt, overview, planView, runPass, walkPath, type Analysis, type CompiledMap } from "../../src/deepmap/core";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";
import type { DevTree, MapData } from "../../src/deepmap/mapData";
import { appImpact, compare, toBundle } from "./deepmapFixtures";

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const SLOW = env.DEEPMAP_SLOW === "1";
const DEV = "/tmp/claude-0/-home-user-spelldash/342dd9ca-ed44-551f-af59-60da8aff2834/scratchpad/deepmap/dev";
const TREE = env.DEEPMAP_TREE ?? `${DEV}/r1-tree.json`;
const QTREE = env.DEEPMAP_QTREE ?? `${DEV}/q-tree.json`;

interface NodeFs {
  existsSync(p: string): boolean;
  readFileSync(p: string): Uint8Array;
}
interface NodeZlib {
  gunzipSync(b: Uint8Array): Uint8Array;
}

/** 木のファイル（.json か .json.gz）があるか */
async function treeExists(path: string): Promise<boolean> {
  const fsName = "node:fs";
  const fs = (await import(/* @vite-ignore */ fsName)) as NodeFs;
  return fs.existsSync(path) || fs.existsSync(`${path}.gz`);
}

/** R1 の木（作業メモの試作の木。リポジトリには無く、CI でも作れない）があるか。無ければ R1 の木の確かめは飛ばす（前提を直した木の確かめは動く） */
const HAS_R1 = SLOW && (await treeExists(TREE));
if (SLOW && !HAS_R1) console.log(`R1 の木がありません: ${TREE}。R1 の木の確かめは飛ばします（DEEPMAP_TREE で場所を渡せる）`);

/** 木を読む（.json か .json.gz。無ければ null） */
async function loadTree(path: string): Promise<DevTree | null> {
  // node の組み込みは名前を変数にして読む（型の確かめにはブラウザの型だけを使うため）
  const fsName = "node:fs";
  const zName = "node:zlib";
  const fs = (await import(/* @vite-ignore */ fsName)) as NodeFs;
  const z = (await import(/* @vite-ignore */ zName)) as NodeZlib;
  for (const p of [path, `${path}.gz`]) {
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p);
    const bytes = p.endsWith(".gz") ? z.gunzipSync(raw) : raw;
    return JSON.parse(new TextDecoder().decode(bytes)) as DevTree;
  }
  return null;
}

/** 3 回のうち一番速い時間（ms）と最後の答え */
function best3<T>(f: () => T): { ms: number; value: T } {
  let ms = Infinity;
  let value: T | undefined;
  for (let k = 0; k < 3; k++) {
    const t = performance.now();
    value = f();
    ms = Math.min(ms, performance.now() - t);
  }
  return { ms, value: value! };
}

/** 今日の手ごとの見取り図・扇・帯・進め方・行き先・一番ありそうな道を全部 */
function allViews(a: Analysis): number {
  const ov = overview(a);
  let k = ov.moves.length;
  for (const m of ov.moves) {
    k += fanData(a, m.node).all.points.length;
    k += forkStrip(a, m.node).total.forks;
    k += planView(a, m.node).length;
    k += destinations(a, m.node).length;
    k += walkPath(a, m.node, 0).rows.length;
  }
  k += destinations(a, null).length + walkPath(a, 0).rows.length;
  return k;
}

const REF: Record<string, number> = { ad_permside: 21.97, sd_permpro: 16.12, fc_switch: 15.04, fc_scope: 10.15, sd_grow: 5.1, sd_pilot: 4.93, ad_portfolio: 4.06, part: -76.59, ind_quit: -218.62, keep: 0 };

describe.runIf(HAS_R1)("計算の芯: 8 万枚の開発用の木（R1）", () => {
  let tree: DevTree | null = null;
  let map: MapData;
  let cm: CompiledMap;

  it("木を読んで組み直す", async () => {
    tree = await loadTree(TREE);
    expect(tree, `木がありません: ${TREE}`).not.toBeNull();
    map = fromDevTree(tree!);
    cm = compileMap(map);
    expect(cm.n).toBeGreaterThan(70_000);
  });

  it("年収 360 の確かめの数: 今日の値 1,290.66 と今日の 10 の手の差", () => {
    const a = analyze(cm, 360);
    expect(Math.round(a.vRoot! * 100) / 100).toBe(1290.66);
    const ov = overview(a);
    for (const m of ov.moves) expect([m.kind, Math.round(m.delta!.d * 100) / 100]).toEqual([m.kind, REF[m.kind]]);
    expect(ov.basis.delta).toBe(cm.has.q ? "q" : "tree");
    // 届け出て副業の先: 判断 1,452・出来事の分かれ 586・行き先 2,844（まとめた物 2,131）・おすすめの選び方で着く本当の行き先 383（1% 以上 9）
    const ap = ov.moves.find((m) => m.kind === "ad_permside")!;
    expect(ap.counts).toEqual({ nodes: 7853, decisions: 1452, splits: 586, forks: 2038, ends: 2844, sumEnds: 2131, reachEnds: 383, reachEnds1: 9, reachSum: 0 });
    expect(forkStrip(a, ap.node).decisions.slice(1, 12)).toEqual([3, 6, 16, 41, 62, 107, 157, 194, 240, 304, 322]);
    expect(ap.reveals!.answers.map((x) => [x.label, Math.round(x.share * 100)])).toEqual([
      ["全部可", 20],
      ["SpellDash だけ", 45],
      ["どちらも不可", 35],
    ]);
    // 見取り図の数の決まり: 合計 2,000 前後の分かれ道・どの手も 2029 年 11 月まで
    for (const m of ov.moves) expect(m.counts.forks).toBeGreaterThan(1900);
    expect(walkPath(a, 0).rows.at(-1)!.mNext).toBe(36);
  });

  for (const annual of [360, 540]) {
    it(`年収 ${annual}: 8 万枚の文書でアプリの計算（computeImpact）と値・差・選ぶ手・見込み・分布が 1e-9 まで同じ`, () => {
      const app = appImpact(toBundle(map), annual);
      const n = compare(map, analyze(cm, annual), app);
      expect(n.options).toBeGreaterThan(30_000);
      expect(n.decisions).toBeGreaterThan(15_000);
    }, 120_000);
  }

  it("時間の上限（3 回の一番速い物）: 組み直し ≤ 150 ms・1 回の計算 ≤ 20 ms・見取り図の数を全部 ≤ 100 ms", () => {
    const compile = best3(() => compileMap(map));
    const money = moneyAt(cm, 360);
    const pass = best3(() => runPass(cm, money));
    const both = best3(() => analyze(cm, 360));
    const views = best3(() => allViews(both.value));
    const timings = { compileMs: round1(compile.ms), passMs: round1(pass.ms), analyzeMs: round1(both.ms), viewsMs: round1(views.ms), moves: cm.firstMoves.length, nodes: cm.n };
    console.log(`計算の芯の時間: ${JSON.stringify(timings)}`);
    expect(compile.ms).toBeLessThanOrEqual(150);
    expect(pass.ms).toBeLessThanOrEqual(20);
    expect(views.ms).toBeLessThanOrEqual(100);
    expect(kindKey(cm, cm.firstMoves[0]!)).not.toBe("");
  });
});

describe.runIf(SLOW)("計算の芯: 前提を直した木（あれば）", () => {
  it("q・mix・cont・never があれば使い、どの数で比べたかを出す", async () => {
    const tree = await loadTree(QTREE);
    if (!tree) {
      console.log(`前提を直した木はまだありません: ${QTREE}`);
      return;
    }
    const cm = compileMap(fromDevTree(tree));
    for (const annual of [360, 540]) {
      const a = analyze(cm, annual);
      const ov = overview(a);
      const allQ = ov.moves.every((m) => m.delta?.basis === "q");
      expect(ov.basis.delta).toBe(allQ ? "q" : "tree");
      expect(ov.basis.worth).toBe(cm.has.never);
      for (const m of ov.moves) {
        expect(Number.isFinite(m.value)).toBe(true);
        if (cm.has.never && !m.isBase && tree.header.never[m.fam]) expect(m.worth).not.toBeNull();
      }
      console.log(`前提を直した木 ${annual}: ${JSON.stringify({ vRoot: a.vRoot, basis: ov.basis, deltas: Object.fromEntries(ov.moves.map((m) => [m.kind, m.delta && Math.round(m.delta.d * 100) / 100])) })}`);
    }
  }, 120_000);
});

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
