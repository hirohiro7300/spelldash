// 全部の入れ替え（取り込み・読み込み・入れ替えの元に戻す）を、見え方（src/app/viewModel.ts）が変わった物だけの変更として受ける
// （見直し perf-4）。索引・3 年の影響・見込みは、いちから数えた答え（buildIndex・computeImpact）と同じで、形と数が同梱の地図のままなら
// 地図の列から作った形をそのまま使い続け（作り直さない）、新しい文書も地図の文書として覚える
import { describe, expect, it } from "vitest";
import { mapDocOf, rememberMapDoc } from "../../src/app/futureCache";
import { DEFAULT_PREFS, UiState } from "../../src/app/uiState";
import { ViewModel } from "../../src/app/viewModel";
import { buildImpactDoc } from "../../src/demo/impact";
import { buildQuarterDoc } from "../../src/demo/quarterDoc";
import type { MapData } from "../../src/deepmap/mapData";
import { buildIndex } from "../../src/model/graph";
import type { DocData, GNode, ID } from "../../src/model/types";
import { Store } from "../../src/store/store";
import { refRun, sameImpact } from "./helpers/impactEquiv";
import { loadQSmall } from "./helpers/qSmall";
import { r6Bundle } from "./helpers/r6";

function setup(doc: DocData) {
  const store = new Store(doc);
  const ui = new UiState(structuredClone(DEFAULT_PREFS));
  ui.persistPrefs = false;
  const vm = new ViewModel(store, ui);
  vm.narrow = () => false;
  return { store, ui, vm };
}

/** 見え方の答えが、いちから数えた物と同じか（3 年の影響・索引の出る線と入る線） */
function check(vm: ViewModel, store: Store, what: string): void {
  const doc = store.doc;
  const ref = refRun(doc).ref;
  try {
    sameImpact(vm.impact, ref, { details: true }, doc);
  } catch (e) {
    throw new Error(`${what}: ${(e as Error).message}`);
  }
  const idx = buildIndex(doc);
  for (const id of Object.keys(doc.nodes)) {
    expect([what, id, vm.index.out.get(id) ?? []]).toEqual([what, id, idx.out.get(id) ?? []]);
    expect([what, id, vm.index.inc.get(id) ?? []]).toEqual([what, id, idx.inc.get(id) ?? []]);
  }
  expect(vm.index.source).toBe(doc);
}

/** 手のカード（選んだ・見送ったを付ける物） */
const options = (doc: DocData): GNode[] => Object.values(doc.nodes).filter((n) => typeof n.meta.ak === "string" && n.meta.base !== true);

describe("全部の入れ替えを変わった物だけで受ける", () => {
  it("3 か月ごとの小さい地図: 写し・状態を変えた写し・元に戻すでは形を作り直さず地図の文書のまま。数を変えた写しは文書から作り直す", async () => {
    const map: MapData = await loadQSmall();
    const doc = buildQuarterDoc(map, { version: map.header.hash, release: map.header.release, at: Date.UTC(2026, 10, 1), layout: "columns" });
    rememberMapDoc(doc, map);
    const { store, vm } = setup(doc);
    vm.ensure();
    check(vm, store, "最初");
    expect(vm.engine.lastCompile).toBe("map");
    const topo0 = vm.engine.version.topology;
    const res0 = vm.impact;

    // 1) 物だけ新しい写し（取り込みの写し）: 同じ結果の物・形も作り直さない・新しい文書も地図の文書
    store.replaceDoc(structuredClone(store.doc), "取り込み");
    vm.ensure();
    check(vm, store, "写し");
    expect(vm.engine.version.topology).toBe(topo0);
    expect(vm.impact).toBe(res0);
    expect(mapDocOf(store.doc)).toBe(map);
    expect(vm.engine.mapTopo(store.doc)).not.toBeNull();

    // 2) 手を選んだ・見送った写し: 形はそのまま、計算だけやり直す
    const next = structuredClone(store.doc);
    const ops = options(next);
    next.nodes[ops[0]!.id]!.status = "active";
    next.nodes[ops[1]!.id]!.status = "dropped";
    next.nodes[ops[2]!.id]!.title = "届いた題名";
    store.replaceDoc(next, "取り込み");
    vm.ensure();
    check(vm, store, "状態を変えた写し");
    expect(vm.engine.version.topology).toBe(topo0);
    expect(vm.impact).not.toBe(res0);
    expect(vm.impact.alt.get(ops[0]!.id)!.picked).toBe(true);
    expect(mapDocOf(store.doc)).toBe(map);

    // 3) 元に戻す・やり直す（覚えた写しを戻す。物の多くは同じ）
    store.undo();
    vm.ensure();
    check(vm, store, "元に戻す");
    expect(vm.engine.version.topology).toBe(topo0);
    store.redo();
    vm.ensure();
    check(vm, store, "やり直す");
    expect(vm.engine.version.topology).toBe(topo0);

    // 4) 見込み（%）を変えた写し: 数が地図と違うので、文書から作り直す（答えは同じ）
    const num = structuredClone(store.doc);
    const e = Object.values(num.edges).find((x) => typeof x.meta.prob === "number" && x.meta.prob > 10 && x.meta.prob < 90)!;
    const sib = Object.values(num.edges).find((x) => x.source === e.source && x.id !== e.id && typeof x.meta.prob === "number")!;
    e.meta = { ...e.meta, prob: (e.meta.prob as number) - 5 };
    sib.meta = { ...sib.meta, prob: (sib.meta.prob as number) + 5 };
    store.replaceDoc(num, "取り込み");
    vm.ensure();
    check(vm, store, "見込みを変えた写し");
    expect(mapDocOf(store.doc)).toBeNull();
  });

  it("版 6 の地図: 写し・状態と題名を変えた写し・ノードを足した写し・元に戻すでも、いちから数えた答えと同じ", () => {
    const doc = buildImpactDoc(r6Bundle(), new Date(2026, 10, 19), "test");
    const { store, vm } = setup(doc);
    vm.ensure();
    check(vm, store, "最初");
    store.replaceDoc(structuredClone(store.doc), "取り込み");
    check(vm, store, "写し");
    const next = structuredClone(store.doc);
    const ops = options(next);
    next.nodes[ops[4]!.id]!.status = "done";
    next.nodes[ops[5]!.id]!.title = "届いた";
    const extra: ID = "u_new";
    next.nodes[extra] = { ...structuredClone(next.nodes[ops[6]!.id]!), id: extra, title: "自分の手" };
    store.replaceDoc(next, "取り込み");
    check(vm, store, "変えた写し");
    expect(vm.index.nodeCount).toBe(Object.keys(store.doc.nodes).length);
    store.undo();
    check(vm, store, "元に戻す");
    store.redo();
    check(vm, store, "やり直す");
  });

  it("見込みの計画は前の文書（取り込みの写し）を持ち続けない: 写しの間に作った計画は元に戻すと今の文書に替え、見込みに使う物が変わったら捨てる（見直し perf-4）", async () => {
    const map: MapData = await loadQSmall();
    const doc = buildQuarterDoc(map, { version: map.header.hash, release: map.header.release, at: Date.UTC(2026, 10, 1), layout: "columns" });
    rememberMapDoc(doc, map);
    const { store, vm } = setup(doc);
    const internal = vm as unknown as { forecastPlan: { doc: DocData; plan: { doc: DocData } } | null };
    void vm.forecast;
    expect(internal.forecastPlan!.doc).toBe(store.doc);
    // 形の編集（子を足して元に戻す）: 見込みに使う物が変わったので、計画はすぐ捨てる（読まれるまで前の文書を持たない）
    const anyAlt = options(store.doc)[0]!;
    store.transact("子", (tx) => {
      tx.addNode({ ...structuredClone(store.doc.nodes[anyAlt.id]!), id: "u_child", title: "子", meta: {} });
      tx.addEdge({ ...structuredClone(Object.values(store.doc.edges)[0]!), id: "u_edge", source: anyAlt.id, target: "u_child", meta: {} });
    });
    expect(internal.forecastPlan).toBeNull();
    store.undo();
    expect(internal.forecastPlan).toBeNull();
    // 写しを取り込み、写しの間に見込みを読む（計画は写しから作る）→ 元に戻す: 計画は今の文書に替わる
    store.replaceDoc(structuredClone(store.doc), "取り込み");
    const fc1 = vm.forecast;
    const copyDoc = store.doc;
    expect(internal.forecastPlan!.doc).toBe(copyDoc);
    store.undo();
    expect(store.doc).not.toBe(copyDoc);
    expect(internal.forecastPlan!.doc).toBe(store.doc);
    expect(internal.forecastPlan!.plan.doc).toBe(store.doc);
    // 答えの行き先の並べ替えも、計画の今の文書の題名で（写しを読まない）
    expect(fc1.ends.length).toBeGreaterThan(0);
    const ref = refRun(store.doc).fc;
    expect(vm.forecast.ends).toEqual(ref.ends);
  });
});
