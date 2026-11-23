// 3 年の影響のエンジン（src/model/impactEngine.ts）の、8 万枚の地図（版 7 の候補・72,402 枚）での確かめ。遅いので、環境変数 IMPACT_Q_FULL
// （生成の書き出しの場所。impact-q.b64 を置く）があるときだけ動く（npm run test:slow。見直し gaps-4）。
//   1) 基準の作り（computeImpact）と同じ答え: 年収 360・540、選んだ手・見送った手・方針をばらまいて、同梱の地図の列から作っても文書から作っても
//   2) Node での時間の目標（作業メモ SPEC v1 §7.2・perf-12。3 回のうち一番良い値）:
//      形を作る ≤ 150 ms・逆にたどる計算 1 回 ≤ 20 ms・これにする ≤ 40 ms・カードを選ぶ ≤ 10 ms・題名の 1 文字 ≤ 5 ms
//      測る前に、3 年の影響が active で、ノードの数が地図の数と同じことを確かめる（perf-13: 計算が止まっていて速く見えるのを防ぐ）。
//      CI の機械は遅いので目標の 2 倍まで（IMPACT_PERF_SLACK で変えられる）。測った値はいつも書き出す
import { beforeAll, describe, expect, it } from "vitest";
import { analyze, compileMap, overview } from "../../src/deepmap/core";
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
    "今日の 10 の手の差（キャンバスの札・今決めること・カードの見出し）は、見取り図の「今やる vs 3 か月待つ」（計算の芯の overview）と同じ数。≒ は一番の手（◎）から 10 万円未満だけ（年収 360・540: 見直し user-1・user-7・equiv-1・equiv-3）",
    () => {
      const cm = compileMap(map);
      for (const annual of [360, 540]) {
        const doc = build(map);
        withAnnual(doc, annual);
        const { eng, engine } = engRun(doc, null, { map });
        const { ref } = refRun(doc);
        const ov = overview(analyze(cm, annual, {}));
        const ids = engine.graph.topo!.ids;
        expect(ov.moves.length).toBe(10);
        for (const mv of ov.moves) {
          const id = ids[mv.node]!;
          for (const r of [eng, ref]) {
            const a = r.alt.get(id)!;
            expect([annual, id, a.deltaBasis]).toEqual([annual, id, mv.delta!.basis]);
            expect(Math.abs(a.delta! - mv.delta!.d)).toBeLessThan(1e-9 * Math.max(1, Math.abs(mv.delta!.d)));
          }
        }
        // ≒: どの判断でも、◎ の手から（画面の差で）10 万円未満。◎ そのものには付けない
        let ties = 0;
        let decisions = 0;
        for (const d of engine.graph.topo!.ids.keys()) {
          if (d % 7 !== 0 && d !== 0) continue;
          const dec = eng.decision.get(ids[d]!);
          if (!dec) continue;
          const alts = dec.alts.map((x) => eng.alt.get(x)!);
          const rec = alts.find((x) => x.rec);
          if (!rec) continue;
          decisions++;
          expect(rec.mark === "tie").toBe(false);
          for (const x of alts) {
            if (x.mark !== "tie") continue;
            ties++;
            expect(rec.delta! - x.delta!).toBeLessThan(10 + 1e-9);
          }
        }
        expect(decisions).toBeGreaterThan(500);
        expect(ties).toBeGreaterThan(0);
        // 今日: ≒ は 10 の手の半分より少ない（大きく悪い手で幅が広がっても、+1 万円の手まで「ほぼ同じ」にしない）
        const today = eng.decision.get(eng.root!)!.alts.map((x) => eng.alt.get(x)!);
        expect(today.filter((x) => x.mark === "tie").length).toBeLessThan(5);
      }
    },
    SLOW,
  );

  it(
    "やらない場合の差: カードを 100 枚開いても、地図の大きさの配列を残さない（ArrayBuffer の増え ≤ 10 MB）。種類ごとの k も同じ（見直し perf-2・perf-3）",
    async () => {
      const gc = await gcFn();
      const proc = (globalThis as unknown as { process: { memoryUsage(): { arrayBuffers: number } } }).process;
      const doc = build(map);
      withAnnual(doc, 360);
      const { eng } = engRun(doc, null, { map });
      expect(eng.active).toBe(true);
      expect(eng.counts.nodes).toBe(map.n);
      // 違う判断の手を 100 枚（カードを開くたびに読む never(fam).card）
      const picks: Array<{ id: string; fam: string }> = [];
      const seenDec = new Set<string>();
      for (const id of eng.altIds()) {
        const a = eng.alt.get(id)!;
        const fam = doc.nodes[id]!.meta.fam;
        if (a.isBase || seenDec.has(a.decision) || typeof fam !== "string") continue;
        seenDec.add(a.decision);
        picks.push({ id, fam });
        if (picks.length >= 100) break;
      }
      expect(picks.length).toBe(100);
      // 入れ物を先に作る（1 つだけ。地図の大きさで約 4.6 MB）
      eng.never(picks[0]!.fam).card.get(picks[0]!.id);
      gc();
      const ab0 = proc.memoryUsage().arrayBuffers;
      for (const p of picks) eng.never(p.fam).card.get(p.id);
      for (const f of eng.families()) void eng.never(f).k;
      gc();
      const grown = (proc.memoryUsage().arrayBuffers - ab0) / 1024 / 1024;
      console.log(`やらない場合の差: 手 100 枚と種類 ${eng.families().length} の k で ArrayBuffer +${grown.toFixed(2)} MB`);
      expect(grown).toBeLessThan(10);
    },
    SLOW,
  );

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
