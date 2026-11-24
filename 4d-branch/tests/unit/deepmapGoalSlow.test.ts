// 8 万枚の木での資産のゴールの数の確かめ（遅いので DEEPMAP_SLOW=1 のときだけ。ふだんの npm test では飛ばす）
//   DEEPMAP_SLOW=1 DEEPMAP_QTREE=<q-tree.json> npx vitest run tests/unit/deepmapGoalSlow.test.ts --maxWorkers=1
// 確かめること: 時間の上限（goalBase ≤ 15 ms・goalOf ≤ 5 ms。一番速い物）・行き先の数 < 8,000・境界が上限に届かない・
// 仮の値ではどの手も期限までに届かない・年収 360 の期限の資産の真ん中が 0.3〜0.8 億円。
// 芽の見込みを 5・10・15 万円で数えて出す（芽の線を決める材料。作業メモ goal/build/seed.md）

import { describe, expect, it } from "vitest";
import { analyze, compileMap, goalBase, goalOf, kindKey, type CompiledMap, type GoalBucket } from "../../src/deepmap/core";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";
import type { DevTree } from "../../src/deepmap/mapData";
import { DEFAULT_GOAL, goalAnchor, SEED_BIZ, tablesFor } from "../../src/model/goal";

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const SLOW = env.DEEPMAP_SLOW === "1";
const QTREE = env.DEEPMAP_QTREE ?? "/tmp/claude-0/-home-user-spelldash/342dd9ca-ed44-551f-af59-60da8aff2834/scratchpad/deepmap/dev/q-tree.json";

interface NodeFs {
  existsSync(p: string): boolean;
  readFileSync(p: string): Uint8Array;
}
interface NodeZlib {
  gunzipSync(b: Uint8Array): Uint8Array;
}

/** 木を読む（.json か .json.gz。無ければ null） */
async function loadTree(path: string): Promise<DevTree | null> {
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

/** 芽の見込み（3 年後の事業の稼ぎが th 万円以上の行き先の見込みの割合） */
function seedShare(b: GoalBucket, th: number): number {
  let s = 0;
  let m = 0;
  for (let k = 0; k < b.count; k++) {
    const w = b.items[k * 4 + 3]!;
    m += w;
    if (b.items[k * 4 + 2]! >= th) s += w;
  }
  return m > 0 ? s / m : 0;
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

describe.runIf(SLOW)("資産のゴール: 8 万枚の木", () => {
  let cm: CompiledMap;
  let anchor = "2026-11";

  it("木を読んで組み直す", async () => {
    const tree = await loadTree(QTREE);
    expect(tree, `木がありません: ${QTREE}`).not.toBeNull();
    anchor = tree!.header.anchor;
    cm = compileMap(fromDevTree(tree!));
    expect(cm.n).toBeGreaterThan(70_000);
  }, 120_000);

  it("時間の上限（一番速い物）: goalBase ≤ 15 ms・goalOf ≤ 5 ms。行き先の数 < 8,000・境界は上限に届かない", () => {
    const A = goalAnchor(anchor);
    let baseMs = Infinity;
    let ofMs = Infinity;
    let items = 0;
    for (let r = 0; r < 4; r++) {
      const a = analyze(cm, 360 + r);
      let t0 = performance.now();
      const base = goalBase(a);
      baseMs = Math.min(baseMs, performance.now() - t0);
      for (let k = 0; k < 4; k++) {
        const t = tablesFor({ ...DEFAULT_GOAL, save: 20 + k + r * 4 }, A);
        t0 = performance.now();
        goalOf(base, t);
        ofMs = Math.min(ofMs, performance.now() - t0);
      }
      items = base.moves.reduce((s, b) => s + b.count, 0) + (base.pi?.count ?? 0) + (base.keep?.count ?? 0);
      for (const b of base.moves) expect(b.frontier.capped, kindKey(cm, b.node)).toBe(false);
    }
    console.log(`資産のゴールの時間: ${JSON.stringify({ goalBaseMs: Math.round(baseMs * 10) / 10, goalOfMs: Math.round(ofMs * 10) / 10, items })}`);
    expect(items).toBeLessThan(8_000);
    expect(baseMs).toBeLessThanOrEqual(15);
    expect(ofMs).toBeLessThanOrEqual(5);
  }, 120_000);

  for (const annual of [360, 540])
    it(`年収 ${annual}: 仮の値ではどの手も期限までに届かない。期限の資産の真ん中・芽の見込み（5・10・15 万円）を出す`, () => {
      const a = analyze(cm, annual);
      const base = goalBase(a);
      const sum = goalOf(base, tablesFor({ ...DEFAULT_GOAL }, goalAnchor(anchor)));
      expect(sum.noneReach).toBe(true);
      const rows = sum.moves.map((s, k) => {
        const b = base.moves[k]!;
        expect(s.pBy).toBe(0);
        if (annual === 360) {
          expect(s.atBy!.p50).toBeGreaterThan(3_000);
          expect(s.atBy!.p50).toBeLessThan(8_000);
        }
        return {
          kind: kindKey(cm, s.node),
          p50Oku: round3(s.atBy!.p50 / 10_000),
          seed5: round3(seedShare(b, 5)),
          seed10: round3(seedShare(b, 10)),
          seed15: round3(seedShare(b, 15)),
          choiceOnly: s.choiceOnly,
          treeMaxBiz: Math.round(b.treeMaxBiz * 10) / 10,
          bestGrow: s.bestGrow && { g: Math.round(s.bestGrow.gReq * 10) / 10, biz: Math.round(s.bestGrow.Rbiz * 10) / 10, prob: round3(s.bestGrow.prob) },
          cReq: Math.round(s.cReq),
          ratioEarn: Math.round(s.ratioEarn * 10) / 10,
          frontier: b.frontier.n,
        };
      });
      console.log(`資産のゴール ${annual}（芽の線 ${SEED_BIZ} 万円）: ${JSON.stringify({ pi: sum.pi && { p50Oku: round3(sum.pi.atBy!.p50 / 10_000), seed: round3(sum.pi.seed) }, keep: sum.keep && { p50Oku: round3(sum.keep.atBy!.p50 / 10_000) }, rows })}`);
    }, 120_000);
});
