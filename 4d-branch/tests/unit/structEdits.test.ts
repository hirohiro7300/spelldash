// 地図の中の形の編集（カードに子を足す: Tab・分岐を 2 つ・元に戻す・やり直す・葉を消す・葉への線だけ消す）を、見え方の計算が
// 8 万枚をたどり直さずに直したとき（src/app/scopeSplice.ts の範囲と木・src/model/forecast.ts の ForecastPlan.patch・
// src/model/impactSplice.ts のエンジンの形と数）、どれも最初から作った物と同じかを確かめる（作業メモ SPEC v1 §7.1 の 1・5・6、perf-4）:
//   範囲（幅優先の番号・入口・深さ・たどった親とその線）・先の木と大きさ・自分のノードの入口は、キャッシュを捨てて作り直した物と番号まで同じ
//   見込み（直した計画で流した物）は computeForecast と 1 ビットまで同じ（流した順・行き先の並びも）
//   エンジンの形・数・状態は compileDocTopo + fillNums と番号まで同じ
//   見え方（見えるカード・線・件数・重ねる位置）は基準の作り（helpers/refView.ts）と同じ
// 版 6 の地図（1,533 枚）と 3 か月ごとの小さい地図（8,306 枚）で。直せない変更（合流・葉でないカードを消す）は最初から作る。
import { describe, expect, it } from "vitest";
import { Commands } from "../../src/app/commands";
import { rememberMapDoc } from "../../src/app/futureCache";
import { DEFAULT_PREFS, UiState } from "../../src/app/uiState";
import { ViewModel } from "../../src/app/viewModel";
import { buildImpactDoc } from "../../src/demo/impact";
import { buildQuarterDoc } from "../../src/demo/quarterDoc";
import { computeForecast } from "../../src/model/forecast";
import { buildIndex } from "../../src/model/graph";
import { makeEdge } from "../../src/model/schema";
import type { DocData } from "../../src/model/types";
import { Store } from "../../src/store/store";
import { r6Bundle } from "./helpers/r6";
import { loadQSmall } from "./helpers/qSmall";
import { refView } from "./helpers/refView";
import { pick, rng } from "./helpers/synthMap";
import { forecastDiff, scopeDiff } from "./helpers/structCheck";
import { engineGraphDiff } from "./helpers/topoEquiv";

function setup(doc: DocData) {
  const store = new Store(doc);
  const ui = new UiState(structuredClone(DEFAULT_PREFS));
  ui.persistPrefs = false;
  const vm = new ViewModel(store, ui);
  vm.narrow = () => false;
  const cmd = new Commands(store, ui, vm, {
    toast: () => undefined,
    viewCenter: () => ({ x: 0, y: 0 }),
    startEdit: () => undefined,
    reveal: () => undefined,
    confirm: async () => true,
  });
  return { store, ui, vm, cmd };
}

/** 今の見え方の計算（範囲・見込み・エンジンの形。withRef なら見えるカードと線も）が、最初から作った物と違う所 */
function problemsOf(vm: ViewModel, store: Store, ui: UiState, withRef: boolean): string[] {
  const doc = store.doc;
  vm.ensure();
  void vm.impact.vRoot;
  const problems: string[] = [];
  problems.push(...scopeDiff(vm));
  const idx = buildIndex(doc);
  for (const sid of [null, "s_early"]) {
    const s = sid && doc.scenarios[sid] ? sid : null;
    ui.setPrefs({ scenarioId: s });
    problems.push(...forecastDiff(vm.forecast, computeForecast(doc, idx.out, s)).map((x) => `見込み（方針 ${s}）: ${x}`));
  }
  ui.setPrefs({ scenarioId: null });
  void vm.impact.vRoot;
  const roots = [...vm.index.impactRoots].sort((a, b) => vm.index.nodeOrder(a) - vm.index.nodeOrder(b));
  if (!vm.engine.graph.topo?.map) problems.push(...engineGraphDiff(vm.engine, doc, vm.index.out, roots).map((x) => `エンジン: ${x}`));
  if (withRef) {
    vm.ensure();
    const ref = refView(doc, ui, false);
    if (JSON.stringify(vm.drawNodes) !== JSON.stringify(ref.drawNodes)) problems.push("見えるカードが基準と違う");
    if (JSON.stringify(vm.drawEdges) !== JSON.stringify(ref.drawEdges)) problems.push("見える線が基準と違う");
    if (vm.hiddenCount !== ref.hiddenCount) problems.push(`隠れた数 ${vm.hiddenCount} ≠ ${ref.hiddenCount}`);
    for (const id of vm.drawNodes) {
      const a = vm.node(id);
      const b = ref.nodes.get(id)!;
      if (a.collapsedCount !== b.collapsedCount || a.collapsed !== b.collapsed) {
        problems.push(`件数 ${id}: ${a.collapsedCount}/${a.collapsed} ≠ ${b.collapsedCount}/${b.collapsed}`);
        break;
      }
      const r = ref.overlay.get(id);
      if (r && JSON.stringify(vm.posOf(id)) !== JSON.stringify(r)) {
        problems.push(`位置 ${id}`);
        break;
      }
    }
  }
  return problems;
}

/** 形の編集を乱数で続け、そのたびに比べる。直した回数を返す */
function drive(doc0: DocData, seed: number, steps: number, refEvery: number): { scope: number; forecast: number; spliced: number } {
  const { store, ui, vm, cmd } = setup(doc0);
  const rand = rng(seed);
  vm.ensure();
  // 深い所まで少し開いておく（重ねる位置・件数も比べる）
  const cards0 = Object.keys(store.doc.nodes);
  for (let k = 0; k < 6; k++) vm.openPathTo(pick(rand, cards0));
  const check = (what: string, k: number) => {
    const problems = problemsOf(vm, store, ui, k % refEvery === 0);
    if (problems.length) throw new Error(`${what} の後: ${problems.slice(0, 6).join(" / ")}`);
  };
  check("最初", 0);
  for (let step = 1; step <= steps; step++) {
    const u = rand();
    vm.ensure();
    const visible = vm.drawNodes.filter((id) => vm.inImpact(id));
    let what = "";
    if (u < 0.3) {
      const p = pick(rand, visible);
      what = `Tab ${p}`;
      cmd.addChild(p);
    } else if (u < 0.38) {
      const p = pick(rand, visible);
      what = `分岐を 2 つ ${p}`;
      cmd.addBranches(p);
    } else if (u < 0.58) {
      what = "元に戻す";
      store.undo();
    } else if (u < 0.66) {
      what = "やり直す";
      store.redo();
    } else if (u < 0.8) {
      // 見えている葉（地図の行き先か、足したカード）を消す
      const leaves = visible.filter((id) => !(vm.index.out.get(id) ?? []).length);
      if (!leaves.length) continue;
      const id = pick(rand, leaves);
      what = `葉を消す ${id}`;
      store.transact(what, (tx) => tx.deleteNode(id));
    } else if (u < 0.86) {
      const leaves = visible.filter((id) => !(vm.index.out.get(id) ?? []).length && (vm.index.inc.get(id) ?? []).length === 1);
      if (!leaves.length) continue;
      const id = pick(rand, leaves);
      const eid = vm.index.inc.get(id)![0]!;
      what = `葉への線だけ消す ${eid}`;
      store.transact(what, (tx) => tx.deleteEdge(eid));
    } else if (u < 0.9) {
      // 状態（見込みは変わらない・エンジンの状態だけ）と Tab を、読まずに続けて
      const alts = visible.filter((id) => typeof store.doc.nodes[id]!.meta.ak === "string");
      if (alts.length) cmd.setStatus([pick(rand, alts)], "active");
      const p = pick(rand, visible);
      cmd.addChild(p);
      what = `状態と Tab ${p}`;
    } else if (u < 0.95) {
      // 直せない形: 合流
      const a = pick(rand, visible);
      const b = pick(rand, visible);
      what = `合流 ${a} → ${b}`;
      if (a !== b) store.transact(what, (tx) => tx.addEdge(makeEdge({ id: `m${step}`, source: a, target: b, relation: "leads" })));
    } else if (u < 0.975) {
      // 枝ごと消す（詳細・キャンバスの削除と同じ: その先だけにあるカードも一緒に。まとめて直す: 見直し speed-del-subtree-quadratic）
      const inner = visible.filter((id) => (vm.index.out.get(id) ?? []).length > 0 && !vm.isImpactEntry([id]));
      if (!inner.length) continue;
      const id = pick(rand, inner);
      what = `枝ごと消す ${id}`;
      cmd.deleteNodes([id]);
    } else {
      // 直せない形: 先のあるカードだけを消す（先は残る）
      const inner = visible.filter((id) => (vm.index.out.get(id) ?? []).length > 0 && !vm.isImpactEntry([id]));
      if (!inner.length) continue;
      const id = pick(rand, inner);
      what = `先のあるカードを消す ${id}`;
      store.transact(what, (tx) => tx.deleteNode(id));
    }
    check(what, step);
  }
  return { ...vm.patchCounts, spliced: vm.engine.topoCounts.spliced };
}

describe("地図の中の形の編集（Tab・元に戻す・消す）を、たどり直さずに直した物が最初から作った物と同じ（perf-4）", () => {
  it("版 6 の地図（1,533 枚）", () => {
    const doc = buildImpactDoc(r6Bundle(), new Date(2026, 10, 19), "test");
    const r = drive(doc, 3, 80, 4);
    expect(r.scope).toBeGreaterThan(30);
    expect(r.forecast).toBeGreaterThan(30);
    expect(r.spliced).toBeGreaterThan(30);
  }, 120_000);

  it("3 か月ごとの小さい地図（8,306 枚。組み立てたままの地図の形は最初の形の変更で文書から作り、その後は直す）", async () => {
    const map = await loadQSmall();
    const doc = buildQuarterDoc(map, { version: map.header.hash, release: map.header.release, at: Date.UTC(2026, 10, 1) });
    rememberMapDoc(doc, map);
    const r = drive(doc, 9, 40, 10);
    expect(r.scope).toBeGreaterThan(15);
    expect(r.forecast).toBeGreaterThan(15);
    expect(r.spliced).toBeGreaterThan(15);
  }, 300_000);
});

describe("線の無い入口を消す（見直し data-1: 直したと言って消した入口を形に残さない）", () => {
  it("版 6 の地図に線の無い 2 つ目の入口を足して消すと、範囲・数・エンジンの形が最初から作った物と同じ", () => {
    const doc = buildImpactDoc(r6Bundle(), new Date(2026, 10, 19), "test");
    const { store, ui, vm } = setup(doc);
    vm.ensure();
    const r0 = [...vm.index.impactRoots][0]!;
    const R = store.doc.nodes[r0]!;
    store.transact("入口を足す", (tx) => tx.addNode({ ...R, id: "zzroot2", x: R.x + 5000 }));
    expect(problemsOf(vm, store, ui, true)).toEqual([]);
    store.transact("入口を消す", (tx) => tx.deleteNode("zzroot2"));
    expect(problemsOf(vm, store, ui, true)).toEqual([]);
    expect(vm.engine.graph.topo?.idx.has("zzroot2")).toBe(false);
    expect(vm.impact.scope.has("zzroot2")).toBe(false);
    const fresh = setup(store.doc);
    fresh.vm.ensure();
    expect(JSON.stringify(vm.impact.counts)).toBe(JSON.stringify(fresh.vm.impact.counts));
    // 元に戻す（入口がまた増える）・やり直す（また消える）も同じ
    store.undo();
    expect(problemsOf(vm, store, ui, false)).toEqual([]);
    expect(vm.impact.scope.has("zzroot2")).toBe(true);
    store.redo();
    expect(problemsOf(vm, store, ui, false)).toEqual([]);
    expect(vm.impact.scope.has("zzroot2")).toBe(false);
  }, 60_000);
});

describe("前に返した見込みの答えは、計画を直した後も自分と食い違わない（見直し data-2）", () => {
  it("届いた葉を消して計画を直しても、前の答えの keys・has・get・values が同じ物を言う。元に戻した後も", () => {
    const doc = buildImpactDoc(r6Bundle(), new Date(2026, 10, 19), "test");
    const { store, ui, vm } = setup(doc);
    vm.ensure();
    const fc = vm.forecast;
    const leaf = [...fc.reach.keys()].find((id) => vm.inImpact(id) && !(vm.index.out.get(id) ?? []).length && (vm.index.inc.get(id) ?? []).length === 1)!;
    expect(leaf).toBeTruthy();
    const size0 = fc.reach.size;
    const c0 = { ...vm.patchCounts };
    const agrees = (r: ReadonlyMap<string, unknown>) => {
      const keys = [...r.keys()];
      expect(keys.length).toBe(r.size);
      for (const id of keys) expect(r.has(id)).toBe(true);
      expect([...r.values()].every((v) => v !== undefined)).toBe(true);
      expect([...r.entries()].every(([k, v]) => v !== undefined && r.get(k) === v)).toBe(true);
    };
    store.transact("葉を消す", (tx) => tx.deleteNode(leaf));
    const fc2 = vm.forecast;
    expect(vm.patchCounts.forecast).toBe(c0.forecast + 1);
    expect(fc2.reach.size).toBe(size0 - 1);
    expect(fc2.reach.has(leaf)).toBe(false);
    // 前の答えは、消す前のままの自分と同じことを言う
    expect(fc.reach.size).toBe(size0);
    expect(fc.reach.has(leaf)).toBe(true);
    expect(fc.reach.get(leaf)).toBeDefined();
    agrees(fc.reach);
    agrees(fc2.reach);
    store.undo();
    const fc3 = vm.forecast;
    expect(vm.patchCounts.forecast).toBe(c0.forecast + 2);
    expect(fc3.reach.has(leaf)).toBe(true);
    expect(fc2.reach.has(leaf)).toBe(false);
    agrees(fc.reach);
    agrees(fc2.reach);
    agrees(fc3.reach);
    expect(problemsOf(vm, store, ui, false)).toEqual([]);
  }, 60_000);
});

describe("枝ごと消す・その元に戻すを、まとめて直した物が最初から作った物と同じ（見直し speed-del-subtree-quadratic・speed-del-mid-undo）", () => {
  it("版 6 の地図: 先の大きさの違う枝を消して戻す（範囲・木・見込み・エンジンの形と数・見え方）", () => {
    const doc = buildImpactDoc(r6Bundle(), new Date(2026, 10, 19), "test");
    const { store, ui, vm, cmd } = setup(doc);
    vm.ensure();
    const rand = rng(5);
    for (let k = 0; k < 4; k++) vm.openPathTo(pick(rand, Object.keys(store.doc.nodes)));
    const below = (id: string): number => {
      const seen = new Set([id]);
      const stack = [id];
      while (stack.length)
        for (const eid of vm.index.out.get(stack.pop()!) ?? []) {
          const e = store.doc.edges[eid]!;
          if ((e.relation === "leads" || e.relation === "condition") && !seen.has(e.target)) (seen.add(e.target), stack.push(e.target));
        }
      return seen.size;
    };
    const inner = [...vm.impact.scope].filter((id) => (vm.index.out.get(id) ?? []).length > 0 && !vm.isImpactEntry([id]));
    // 小さな枝・中くらい・百枚を超える枝（地図のほとんどを消す枝は、見込みの計画を作り直す: ForecastPlan.patch の使っていない行の上限）
    const sized = inner.map((id) => ({ id, n: below(id) })).filter((x) => x.n <= 300).sort((a, b) => a.n - b.n);
    const picks = [sized[0]!, sized[Math.floor(sized.length / 2)]!, sized[sized.length - 1]!];
    expect(picks[2]!.n).toBeGreaterThan(100);
    const n0 = vm.index.nodeCount;
    void vm.impact.vRoot;
    void vm.forecast;
    for (const x of picks) {
      const c0 = { ...vm.patchCounts, spliced: vm.engine.topoCounts.spliced };
      cmd.deleteNodes([x.id]);
      expect(vm.index.nodeCount).toBe(n0 - x.n);
      vm.ensure();
      void vm.impact.vRoot;
      void vm.forecast;
      // 消すほうは、作り直さずに直した（範囲・見込みの計画・3 年の影響の形）
      expect([vm.patchCounts.scope - c0.scope, vm.patchCounts.forecast - c0.forecast, vm.engine.topoCounts.spliced - c0.spliced]).toEqual([1, 1, 1]);
      expect(problemsOf(vm, store, ui, true)).toEqual([]);
      const c1 = { ...vm.patchCounts, spliced: vm.engine.topoCounts.spliced };
      store.undo();
      expect(vm.index.nodeCount).toBe(n0);
      vm.ensure();
      void vm.impact.vRoot;
      void vm.forecast;
      // 戻すほう（枝をまとめて足す）も、作り直さずに直した
      expect([vm.patchCounts.scope - c1.scope, vm.patchCounts.forecast - c1.forecast, vm.engine.topoCounts.spliced - c1.spliced]).toEqual([1, 1, 1]);
      expect(problemsOf(vm, store, ui, true)).toEqual([]);
      store.redo();
      expect(problemsOf(vm, store, ui, false)).toEqual([]);
      store.undo();
      expect(problemsOf(vm, store, ui, false)).toEqual([]);
    }
  }, 120_000);
});
