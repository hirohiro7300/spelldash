// 見え方の計算（src/app/viewModel.ts）を 8 万枚の地図（版 7 の候補・72,402 枚）で確かめる。遅いので、環境変数 IMPACT_Q_FULL
// （生成の書き出しの場所。impact-q.b64 を置く）があるときだけ動く（npm run test:slow。見直し gaps-4）。
//   1) 基準の作り（速くする前の全部をなめる作り: helpers/refView.ts）と同じ答え: 開いた所（深い道・1 年先まで・散らして）・
//      自分のノードと地図の中への線・シナリオで薄くする／隠す・プロジェクトに絞る・検索
//   2) Node での時間の目標（作業メモ SPEC v1 §7.2・perf-12。3 回のうち一番良い値。ストア・見え方の計算・3 年の影響のエンジンを通す）:
//      これにする ≤ 40 ms・カードを選ぶ ≤ 10 ms・題名の 1 文字 ≤ 5 ms・1 つ開く ≤ 20 ms（perf-3 の Node の目安）。
//      ほか（寄る・1 年先まで開く・検索の 1 文字・シナリオ・元に戻す・起動）は測って書き出す。
//      測る前に、3 年の影響が active で、ノードの数が地図の数と同じことを確かめる（perf-13）。CI の機械は遅いので目標の 2 倍まで
import { beforeAll, describe, expect, it } from "vitest";
import { rememberMapDoc } from "../../src/app/futureCache";
import { DEFAULT_PREFS, UiState } from "../../src/app/uiState";
import { ViewModel } from "../../src/app/viewModel";
import { decodeBundle } from "../../src/demo/impactBundle";
import { buildQuarterDoc } from "../../src/demo/quarterDoc";
import type { MapData } from "../../src/deepmap/mapData";
import { makeEdge, makeNode } from "../../src/model/schema";
import type { DocData, ID } from "../../src/model/types";
import { Store } from "../../src/store/store";
import { refView } from "./helpers/refView";
import { envVar, nodeFs } from "./helpers/qSmall";
import { pick, rng } from "./helpers/synthMap";

const DIR = envVar("IMPACT_Q_FULL");
const SLOW = 900_000;
const SLACK = Number(envVar("IMPACT_PERF_SLACK") ?? (envVar("CI") ? 2 : 1));
const TARGET = { pick: 40, select: 10, keystroke: 5, open: 20 };

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

/** アプリの一時表示（#demo-q）と同じ: 列の形で組み立て、組み立てたままの文書として覚える */
function build(m: MapData): DocData {
  const doc = buildQuarterDoc(m, { version: m.header.hash, release: m.header.release, at: Date.UTC(2026, 10, 1), layout: "columns" });
  rememberMapDoc(doc, m);
  return doc;
}

function setup(doc: DocData) {
  const store = new Store(doc);
  const ui = new UiState(structuredClone(DEFAULT_PREFS));
  ui.persistPrefs = false;
  const vm = new ViewModel(store, ui);
  vm.narrow = () => false;
  return { store, ui, vm };
}

/** 入口から月 limit までの、先のあるカード（1 年先まで開く） */
function timeBounded(doc: DocData, vm: ViewModel, limit: number): ID[] {
  const root = vm.impactRoots()[0]!;
  const out: ID[] = [];
  const stack = [root];
  while (stack.length) {
    const id = stack.pop()!;
    const m = doc.nodes[id]!.meta.m;
    if (typeof m === "number" && m >= limit) continue;
    let kids = 0;
    for (const eid of vm.index.out.get(id) ?? []) {
      const e = doc.edges[eid]!;
      if (e.relation !== "leads" && e.relation !== "condition") continue;
      kids++;
      stack.push(e.target);
    }
    if (kids) out.push(id);
  }
  return out;
}

describe.skipIf(!DIR)("見え方の計算: 8 万枚の地図（IMPACT_Q_FULL があるときだけ）", () => {
  let map: MapData;
  let b64: string;
  beforeAll(async () => {
    const fs = await nodeFs();
    b64 = new TextDecoder().decode(fs.readFileSync(`${DIR}/impact-q.b64`));
    map = await decodeBundle(b64);
  }, SLOW);

  it(
    "基準の作りと同じ答え（深い道・1 年先まで・散らして開く、自分のノードと地図の中への線、シナリオ、プロジェクト、検索）",
    () => {
      const { store, ui, vm } = setup(build(map));
      vm.ensure();
      expect(vm.index.nodeCount).toBe(map.n);
      const rand = rng(7);
      const cards = Object.keys(store.doc.nodes);
      // 組み立てたままの地図（範囲と先の数は地図の形から）: 深い所まで開いて、基準と同じ
      expect(vm.engine.mapTopo(store.doc)).not.toBeNull();
      for (let k = 0; k < 30; k++) vm.openPathTo(pick(rand, cards));
      vm.setImpactOpen([], [vm.impactChain(cards[5000]!)[1]!]);
      vm.ensure();
      const pristine = refView(store.doc, ui, false);
      for (const id of cards) {
        const a = vm.node(id);
        const b = pristine.nodes.get(id)!;
        if (a.hidden !== b.hidden || (vm.nodes.has(id) && JSON.stringify(a) !== JSON.stringify(b))) throw new Error(`組み立てたままの地図 ${id}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
      }
      expect(vm.drawNodes).toEqual(pristine.drawNodes);
      expect(vm.hiddenCount).toBe(pristine.hiddenCount);
      // 自分のノードと、地図の深いカードへの線（相乗効果・進む・循環）、地図のカードから自分のノードへの線
      store.transact("自分のノード", (tx) => {
        for (let i = 0; i < 12; i++) tx.addNode(makeNode({ id: `mine${i}`, title: `自分のノード ${i} 転職`, collapsed: i % 5 === 0 }));
        for (let i = 0; i < 24; i++) tx.addEdge(makeEdge({ id: `me${i}`, source: i % 3 === 0 ? pick(rand, cards) : `mine${i % 12}`, target: i % 3 === 0 ? `mine${i % 12}` : pick(rand, cards), relation: pick(rand, ["leads", "condition", "supports", "blocks", "feedback"] as const) }));
      });
      const configs: Array<() => void> = [
        () => undefined,
        () => {
          // 一番ありそうな行き先まで開く（親をたどる）
          const deep = cards.filter((id) => store.doc.nodes[id]!.meta.end === true)[1234]!;
          vm.openPathTo(deep);
        },
        () => vm.setImpactOpen(timeBounded(store.doc, vm, 12)),
        () => {
          for (let k = 0; k < 40; k++) vm.openPathTo(pick(rand, cards));
          ui.setPrefs({ scenarioId: "s_early", scenarioMode: "dim" });
        },
        () => ui.setPrefs({ scenarioMode: "hide" }),
        () => {
          ui.setPrefs({ scenarioId: null, projectFilter: [Object.keys(store.doc.projects)[0]!], projectMode: "focus" });
          ui.setSearch("転職");
        },
        () => {
          ui.setPrefs({ projectMode: "dim" });
          ui.setSearch("全部可");
          ui.select([vm.drawNodes[5]!]);
        },
      ];
      const problems: string[] = [];
      configs.forEach((step, k) => {
        step();
        vm.ensure();
        const ref = refView(store.doc, ui, false);
        const bad: string[] = [];
        for (const id of cards) {
          const a = vm.node(id);
          const b = ref.nodes.get(id)!;
          if (a.hidden !== b.hidden || (vm.nodes.has(id) && JSON.stringify(a) !== JSON.stringify(b))) bad.push(`${id}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
          if (bad.length > 5) break;
        }
        for (const [name, x, y] of [
          ["drawNodes", vm.drawNodes, ref.drawNodes],
          ["drawEdges", vm.drawEdges, ref.drawEdges],
          ["stubEdges", vm.stubEdges, ref.stubEdges],
          ["hiddenCount", vm.hiddenCount, ref.hiddenCount],
          ["searchCount", vm.searchCount, ref.searchAll.length],
          ["searchHits", vm.searchHits, ref.searchAll.slice(0, 50)],
        ] as const) {
          if (JSON.stringify(x) !== JSON.stringify(y)) bad.push(`${name}: ${JSON.stringify(x).slice(0, 200)} ≠ ${JSON.stringify(y).slice(0, 200)}`);
        }
        for (const id of vm.drawNodes) if (ref.overlay.has(id) && JSON.stringify(vm.posOf(id)) !== JSON.stringify(ref.overlay.get(id))) bad.push(`位置 ${id}`);
        if (bad.length) problems.push(`設定 ${k}（見える ${vm.drawNodes.length} 枚）: ${bad.slice(0, 6).join("\n  ")}`);
      });
      expect(problems.join("\n")).toBe("");
    },
    SLOW,
  );

  it(
    `時間（3 回のうち一番良い値）: これにする ≤ ${TARGET.pick}・選ぶ ≤ ${TARGET.select}・題名の 1 文字 ≤ ${TARGET.keystroke}・1 つ開く ≤ ${TARGET.open} ms（×${SLACK}）`,
    async () => {
      const gc = await gcFn();
      const t = { boot: [] as number[], select: [] as number[], pick: [] as number[], keystroke: [] as number[], keySearch: [] as number[], open: [] as number[], jump: [] as number[], year: [] as number[], yearCards: [] as number[], search: [] as number[], scenario: [] as number[], undo: [] as number[], adopt: [] as number[] };
      for (let round = 0; round < 3; round++) {
        const m = await decodeBundle(b64);
        gc();
        let t0 = performance.now();
        const { store, ui, vm } = setup(build(m));
        vm.ensure();
        let imp = vm.impact;
        void vm.forecast;
        t.boot.push(performance.now() - t0);
        // 測る前に: 計算が動いていて、地図のカードが全部入っている（perf-13）
        expect(imp.active).toBe(true);
        expect(imp.counts.nodes).toBe(m.n);
        expect(vm.index.nodeCount).toBe(m.n);
        expect(m.n).toBeGreaterThan(50_000);
        const doc = store.doc;
        // 深い道を開いておく（一番ありそうな行き先まで）
        const ends = imp.ends;
        vm.openPathTo(ends[round * 7]!.id);
        vm.ensure();
        // 1 つ開く: 見えている閉じたカード
        const closed = vm.drawNodes.filter((id) => vm.inImpact(id) && vm.isCollapsed(id));
        gc();
        t0 = performance.now();
        vm.setImpactOpen([closed[closed.length - 1]!]);
        vm.ensure();
        t.open.push(performance.now() - t0);
        // カードへ寄る: 隠れた深いカードまで親をたどって開く
        const hiddenDeep = ends[50 + round * 13]!.id;
        expect(vm.node(hiddenDeep).hidden).toBe(true);
        gc();
        t0 = performance.now();
        vm.openPathTo(hiddenDeep);
        vm.ensure();
        void vm.posOf(hiddenDeep);
        t.jump.push(performance.now() - t0);
        expect(vm.node(hiddenDeep).hidden).toBe(false);
        // カードを選ぶ: 見えている深い手（詳細・同じ判断の手・やらない場合・結果・見込み）
        const alt = vm.impactChain(hiddenDeep).filter((id) => doc.nodes[id]!.meta.fork === "chance").pop()!;
        const fam = doc.nodes[alt]!.meta.fam as string;
        gc();
        t0 = performance.now();
        ui.select([alt]);
        vm.ensure();
        imp = vm.impact;
        const ai = imp.alt.get(alt)!;
        for (const x of imp.decision.get(ai.decision)!.alts) imp.alt.get(x);
        imp.never(fam).card.get(alt);
        for (const o of ai.outcomes) imp.outcome.get(o.node);
        void vm.forecast.reach.get(alt);
        t.select.push(performance.now() - t0);
        // これにする: 状態を変える → 見え方と計算 → 見出し・選んだ手・同じ判断の手・今日の 10 の手とその結果
        const alts = imp.decision.get(imp.root!)!.alts;
        const target = alts[(round * 3 + 1) % alts.length]!;
        gc();
        t0 = performance.now();
        store.transact("これにする", (tx) => tx.updateNode(target, { status: "active" }));
        vm.ensure();
        imp = vm.impact;
        void imp.vRoot;
        void imp.vSQ;
        void imp.hasPicks;
        imp.recommended();
        const a = imp.alt.get(target)!;
        for (const x of imp.decision.get(a.decision)!.alts) imp.alt.get(x);
        for (const x of alts) for (const o of imp.alt.get(x)!.outcomes) imp.outcome.get(o.node);
        t.pick.push(performance.now() - t0);
        expect(imp.alt.get(target)!.picked).toBe(true);
        // 元に戻す（これにするの取り消し）
        gc();
        t0 = performance.now();
        store.undo();
        vm.ensure();
        imp = vm.impact;
        void imp.vRoot;
        imp.recommended();
        for (const x of alts) imp.alt.get(x);
        t.undo.push(performance.now() - t0);
        // 題名の 1 文字（検索なし・検索あり）
        gc();
        t0 = performance.now();
        store.transact("題名", (tx) => tx.updateNode(alt, { title: `${doc.nodes[alt]!.title}あ` }), { coalesce: "title" });
        vm.ensure();
        const same = vm.impact;
        void vm.forecast;
        t.keystroke.push(performance.now() - t0);
        expect(same).toBe(imp);
        ui.setSearch("転職");
        vm.ensure();
        gc();
        t0 = performance.now();
        store.transact("題名", (tx) => tx.updateNode(alt, { title: `${doc.nodes[alt]!.title}い` }), { coalesce: "title" });
        vm.ensure();
        void vm.searchHits;
        t.keySearch.push(performance.now() - t0);
        // 検索の 1 文字（言葉が変わる）
        gc();
        t0 = performance.now();
        ui.setSearch(round % 2 ? "転職活" : "全部");
        vm.ensure();
        void vm.searchHits;
        t.search.push(performance.now() - t0);
        ui.setSearch("");
        // シナリオを変える（薄くする: 見え方・3 年の影響・見込み）
        gc();
        t0 = performance.now();
        ui.setPrefs({ scenarioId: round % 2 ? "s_focus" : "s_early" });
        vm.ensure();
        void vm.impact.vRoot;
        void vm.forecast;
        t.scenario.push(performance.now() - t0);
        ui.setPrefs({ scenarioId: null });
        vm.ensure();
        // 1 年先まで開く（3,000 枚まで）
        const year = timeBounded(doc, vm, 12);
        gc();
        t0 = performance.now();
        vm.setImpactOpen(year);
        vm.ensure();
        t.year.push(performance.now() - t0);
        t.yearCards.push(vm.drawNodes.length);
        // 取り込み（全部の入れ替え: 物はどれも新しい写しで、手を 1 つ選んだ物。ストアの写しも入れる）: 見え方・3 年の影響・見込み・見取り図の計算。
        // 形と数は地図のままなので、索引・形・見込みの組み立てを作り直さない（見直し perf-4）
        const copy = structuredClone(store.doc);
        copy.nodes[target]!.status = "done";
        const topo0 = vm.engine.version.topology;
        gc();
        t0 = performance.now();
        store.replaceDoc(copy, "取り込み");
        vm.ensure();
        imp = vm.impact;
        void imp.vRoot;
        void vm.forecast;
        vm.deep.get()?.overview();
        t.adopt.push(performance.now() - t0);
        expect(imp.alt.get(target)!.picked).toBe(true);
        expect(vm.engine.version.topology).toBe(topo0);
        expect(vm.engine.mapTopo(store.doc)).not.toBeNull();
      }
      console.log(
        `見え方（8 万枚・${map.n} 枚。ms）: 起動 ${fmt(t.boot)} · 1 つ開く ${fmt(t.open)} · 寄る ${fmt(t.jump)} · 選ぶ ${fmt(t.select)} · これにする ${fmt(t.pick)} · 元に戻す ${fmt(t.undo)} · 題名の 1 文字 ${fmt(t.keystroke)}（検索あり ${fmt(t.keySearch)}） · 検索の 1 文字 ${fmt(t.search)} · シナリオ ${fmt(t.scenario)} · 1 年先まで開く ${fmt(t.year)}（${t.yearCards.join(" / ")} 枚） · 取り込み ${fmt(t.adopt)}`,
      );
      expect(best(t.pick)).toBeLessThanOrEqual(TARGET.pick * SLACK);
      expect(best(t.select)).toBeLessThanOrEqual(TARGET.select * SLACK);
      expect(best(t.keystroke)).toBeLessThanOrEqual(TARGET.keystroke * SLACK);
      expect(best(t.open)).toBeLessThanOrEqual(TARGET.open * SLACK);
      expect(Math.max(...t.yearCards)).toBeLessThanOrEqual(3000);
    },
    SLOW,
  );
});
