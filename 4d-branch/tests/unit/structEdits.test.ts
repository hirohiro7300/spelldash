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

/** 形の編集を乱数で続け、そのたびに比べる。直した回数を返す */
function drive(doc0: DocData, seed: number, steps: number, refEvery: number): { scope: number; forecast: number; spliced: number } {
  const { store, ui, vm, cmd } = setup(doc0);
  const rand = rng(seed);
  vm.ensure();
  // 深い所まで少し開いておく（重ねる位置・件数も比べる）
  const cards0 = Object.keys(store.doc.nodes);
  for (let k = 0; k < 6; k++) vm.openPathTo(pick(rand, cards0));
  const check = (what: string, k: number) => {
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
    if (k % refEvery === 0) {
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
    } else {
      // 直せない形: 先のあるカードを消す
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
