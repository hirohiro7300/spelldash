// 3 年の影響のエンジン（src/model/impactEngine.ts）の、8 万枚の地図（版 7 の候補・72,402 枚）での確かめ。遅いので、環境変数 IMPACT_Q_FULL
// （生成の書き出しの場所。impact-q.b64 を置く）があるときだけ動く（npm run test:slow。見直し gaps-4）。
//   1) 基準の作り（computeImpact）と同じ答え: 年収 360・540、選んだ手・見送った手・方針をばらまいて、同梱の地図の列から作っても文書から作っても
//   2) Node での時間の目標（作業メモ SPEC v1 §7.2・perf-12。3 回のうち一番良い値）:
//      形を作る ≤ 150 ms・逆にたどる計算 1 回 ≤ 20 ms・これにする ≤ 40 ms・カードを選ぶ ≤ 10 ms・題名の 1 文字 ≤ 5 ms
//      測る前に、3 年の影響が active で、ノードの数が地図の数と同じことを確かめる（perf-13: 計算が止まっていて速く見えるのを防ぐ）。
//      CI の機械は遅いので目標の 2 倍まで（IMPACT_PERF_SLACK で変えられる）。測った値はいつも書き出す
import { beforeAll, describe, expect, it } from "vitest";
import { decodeBundle } from "../../src/demo/impactBundle";
import { buildQuarterDoc } from "../../src/demo/quarterDoc";
import type { MapData } from "../../src/deepmap/mapData";
import { buildIndex } from "../../src/model/graph";
import { backward } from "../../src/model/impact";
import { ImpactEngine } from "../../src/model/impactEngine";
import { assemble } from "../../src/model/impactGraph";
import type { DocData, NodeStatus } from "../../src/model/types";
import { Store } from "../../src/store/store";
import { engRun, refRun, sameImpact } from "./helpers/impactEquiv";
import { envVar, nodeFs } from "./helpers/qSmall";

const DIR = envVar("IMPACT_Q_FULL");
const SLOW = 600_000;
const SLACK = Number(envVar("IMPACT_PERF_SLACK") ?? (envVar("CI") ? 2 : 1));
const TARGET = { compile: 150, pass: 20, pick: 40, select: 10, keystroke: 5 };

/** 種から決まる乱数（mulberry32） */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function scatter(doc: DocData, seed: number): void {
  const rand = rng(seed);
  for (const n of Object.values(doc.nodes)) {
    if (typeof n.meta.ak !== "string") continue;
    const u = rand();
    const s: NodeStatus = u < 0.03 ? "active" : u < 0.04 ? "done" : u < 0.1 ? "dropped" : "open";
    if (s !== "open") doc.nodes[n.id] = { ...n, status: s };
  }
}

function withAnnual(doc: DocData, annual: number): void {
  for (const n of Object.values(doc.nodes)) if (n.meta.forecastRoot === true) n.meta = { ...n.meta, impact: { ...(n.meta.impact as object), annual } };
}

/** node の gc（--expose-gc を後から入れて取り出す） */
async function gcFn(): Promise<() => void> {
  const v8Name = "node:v8";
  const vmName = "node:vm";
  const v8 = (await import(/* @vite-ignore */ v8Name)) as { setFlagsFromString(s: string): void };
  const vm = (await import(/* @vite-ignore */ vmName)) as { runInNewContext(code: string): unknown };
  v8.setFlagsFromString("--expose-gc");
  return vm.runInNewContext("gc") as () => void;
}

const best = (xs: number[]): number => Math.min(...xs);
const fmt = (xs: number[]): string => xs.map((x) => x.toFixed(1)).join(" / ");

describe.skipIf(!DIR)("3 年の影響のエンジン: 8 万枚の地図（IMPACT_Q_FULL があるときだけ）", () => {
  let b64: string;
  let map: MapData;
  const build = (m: MapData): DocData => buildQuarterDoc(m, { version: m.header.hash, release: m.header.release, at: Date.UTC(2026, 10, 1) });
  beforeAll(async () => {
    const fs = await nodeFs();
    b64 = new TextDecoder().decode(fs.readFileSync(`${DIR}/impact-q.b64`));
    map = await decodeBundle(b64);
  }, SLOW);

  for (const [annual, sid, seed] of [
    [360, null, 0],
    [540, "s_early", 3],
  ] as const) {
    it(
      `基準の作りと同じ答え（年収 ${annual}・方針 ${sid ?? "なし"}・${seed ? `種 ${seed} の選んだ手と見送った手` : "選んだ手なし"}。地図の列から・文書から）`,
      () => {
        const doc = build(map);
        withAnnual(doc, annual);
        if (seed) scatter(doc, seed);
        const { ref } = refRun(doc, sid);
        expect(ref.active).toBe(true);
        expect(ref.counts.nodes).toBe(map.n);
        const fromMap = engRun(doc, sid, { map });
        expect(fromMap.engine.lastCompile).toBe("map");
        sameImpact(fromMap.eng, ref, { flips: seed === 0, fams: 3 }, doc);
        const fromDoc = engRun(doc, sid);
        expect(fromDoc.engine.lastCompile).toBe("doc");
        sameImpact(fromDoc.eng, ref, { flips: false, fams: 1, details: false });
      },
      SLOW,
    );
  }

  it(
    `時間（3 回のうち一番良い値）: 形 ≤ ${TARGET.compile}・計算 1 回 ≤ ${TARGET.pass}・これにする ≤ ${TARGET.pick}・選ぶ ≤ ${TARGET.select}・題名の 1 文字 ≤ ${TARGET.keystroke} ms（×${SLACK}）`,
    async () => {
      const gc = await gcFn();
      const t = { compile: [] as number[], pass: [] as number[], pick: [] as number[], select: [] as number[], keystroke: [] as number[] };
      for (let round = 0; round < 3; round++) {
        // 毎回読み直した地図から（計算の芯も作り直す）
        const m = await decodeBundle(b64);
        const store = new Store(build(m));
        const engine = new ImpactEngine();
        engine.useMap({ map: m, doc: store.doc });
        store.on("change", (info) => engine.note(store.doc, info));
        const inp = () => ({ doc: store.doc, sid: null, out: () => buildIndex(store.doc).out, reach: () => ({ version: 0, of: () => 0 }) });
        gc();
        let t0 = performance.now();
        let imp = engine.result(inp());
        t.compile.push(engine.timings.compile);
        // 測る前に: 計算が動いていて、地図のカードが全部入っている（perf-13）
        expect(imp.active).toBe(true);
        expect(imp.counts.nodes).toBe(m.n);
        expect(imp.counts.nodes).toBeGreaterThan(50_000);
        expect(engine.lastCompile).toBe("map");
        // 逆にたどる計算 1 回
        const g = engine.graph;
        const c = assemble(g.topo!, g.nums!, new Uint8Array(g.topo!.n), new Uint8Array(g.topo!.off[g.topo!.n]!).fill(1));
        for (let k = 0; k < 3; k++) {
          t0 = performance.now();
          backward(c, imp.S, 0, imp.horizon, 0, null);
          t.pass.push(performance.now() - t0);
        }
        // これにする: 状態を変える → 計算し直す → 見出しと選んだ手の詳細・同じ判断の手・今日の 10 の手とその結果を読む
        const alts = imp.decision.get(imp.root!)!.alts;
        const target = alts[(round * 3 + 1) % alts.length]!;
        gc();
        t0 = performance.now();
        store.transact("これにする", (tx) => tx.updateNode(target, { status: "active" }));
        imp = engine.result(inp());
        void imp.vRoot;
        void imp.vSQ;
        void imp.hasPicks;
        imp.recommended();
        const a = imp.alt.get(target)!;
        for (const x of imp.decision.get(a.decision)!.alts) imp.alt.get(x);
        for (const x of alts) for (const o of imp.alt.get(x)!.outcomes) imp.outcome.get(o.node);
        t.pick.push(performance.now() - t0);
        expect(imp.alt.get(target)!.picked).toBe(true);
        // カードを選ぶ: 深い所の手（新しい結果で初めて読む詳細・同じ判断の手・やらない場合・結果）
        store.transact("戻す", (tx) => tx.updateNode(target, { status: "open" }));
        imp = engine.result(inp());
        const deepAlt = imp.outcome.get(imp.ends[round * 5]!.id)!.alt;
        const fam = store.doc.nodes[deepAlt]!.meta.fam as string;
        gc();
        t0 = performance.now();
        const ai = imp.alt.get(deepAlt)!;
        for (const x of imp.decision.get(ai.decision)!.alts) imp.alt.get(x);
        imp.never(fam).card.get(deepAlt);
        for (const o of ai.outcomes) imp.outcome.get(o.node);
        void imp.acc.get(deepAlt);
        void imp.value.get(deepAlt);
        void imp.pPi.get(deepAlt);
        t.select.push(performance.now() - t0);
        // 題名の 1 文字: 同じ結果のまま
        t0 = performance.now();
        store.transact("題名", (tx) => tx.updateNode(deepAlt, { title: `${store.doc.nodes[deepAlt]!.title}あ` }), { coalesce: "title" });
        const same = engine.result(inp());
        t.keystroke.push(performance.now() - t0);
        expect(same).toBe(imp);
      }
      console.log(`エンジン（8 万枚・${map.n} 枚）: 形 ${fmt(t.compile)} · 計算 1 回 ${fmt(t.pass)} · これにする ${fmt(t.pick)} · 選ぶ ${fmt(t.select)} · 題名の 1 文字 ${fmt(t.keystroke)} ms`);
      expect(best(t.compile)).toBeLessThanOrEqual(TARGET.compile * SLACK);
      expect(best(t.pass)).toBeLessThanOrEqual(TARGET.pass * SLACK);
      expect(best(t.pick)).toBeLessThanOrEqual(TARGET.pick * SLACK);
      expect(best(t.select)).toBeLessThanOrEqual(TARGET.select * SLACK);
      expect(best(t.keystroke)).toBeLessThanOrEqual(TARGET.keystroke * SLACK);
    },
    SLOW,
  );
});
