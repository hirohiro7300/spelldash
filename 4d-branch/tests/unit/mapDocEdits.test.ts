// 組み立てたままと覚えた文書を書き換えた後の数（見直し data-1・data-4・perf-2）。
// data-1: 未来の道筋を開く・保存した形から読んだ文書の見込みをその場で書き換え、全部の入れ替えをして元に戻す・やり直すと、
//         同じ文書の物に戻る（W-app の I4）。覚えたままだと、書き換えた見込みを無視して地図の列から数を作っていた
// data-4: 今日の期間（impact.horizon）を変えた保存の記録は、組み立てたままと見なさない
// perf-2: 前の版のメモの印（meta.prevBody）だけの変更は、組み立てたままと見なす
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildMapDoc, carryMapDoc, mapDocOf, mapForDoc, rememberMapDoc } from "../../src/app/futureCache";
import { DEFAULT_PREFS, UiState } from "../../src/app/uiState";
import { ViewModel } from "../../src/app/viewModel";
import type { MapData } from "../../src/deepmap/mapData";
import { createEmptyDoc } from "../../src/model/schema";
import type { DocData, GNode } from "../../src/model/types";
import { decodeStored, setThinBaseline, storedMapShaped, thinBaselineDoc, toStored } from "../../src/persist/codec";
import { Store } from "../../src/store/store";
import { refRun, sameImpact } from "./helpers/impactEquiv";
import { loadQSmall } from "./helpers/qSmall";

let page: MapData;
const AT = "2026-11-19T03:00:00.000Z";
beforeAll(async () => {
  const q = await loadQSmall();
  page = { ...q, header: { ...q.header, release: 7 } } as MapData;
});
afterEach(() => setThinBaseline(null));

const roundTrip = (doc: DocData): DocData => decodeStored(JSON.parse(JSON.stringify(toStored(doc)))).doc;

function setup(doc: DocData) {
  const store = new Store(doc);
  const ui = new UiState(structuredClone(DEFAULT_PREFS));
  ui.persistPrefs = false;
  const vm = new ViewModel(store, ui);
  vm.narrow = () => false;
  return { store, vm };
}

/** 見込みのある結果の線と、その兄弟の線の見込みを 30 動かす */
function editProb(store: Store): void {
  const doc = store.doc;
  const e = Object.values(doc.edges).find((x) => typeof x.meta.prob === "number" && (x.meta.prob as number) > 30 && (x.meta.prob as number) < 70)!;
  const sib = Object.values(doc.edges).find((x) => x.source === e.source && x.id !== e.id && typeof x.meta.prob === "number")!;
  store.transact("見込み", (tx) => {
    tx.updateEdge(e.id, { meta: { ...e.meta, prob: (e.meta.prob as number) - 30 } });
    tx.updateEdge(sib.id, { meta: { ...sib.meta, prob: (sib.meta.prob as number) + 30 } });
  });
}

/** 出している 3 年の影響が、文書から数えた物と同じ */
function matchesDoc(vm: ViewModel, store: Store): void {
  vm.ensure();
  sameImpact(vm.impact, refRun(store.doc).ref, { details: false }, store.doc);
}

/** 並びが違う文書（DocIndex.diffDoc が null を返す全部の入れ替え） */
function reordered(): DocData {
  const X = roundTrip(thinBaselineDoc({ at: AT }));
  const p = { id: "p_other", name: "別", color: "#888888", description: "", createdAt: AT, updatedAt: AT, meta: {} };
  return { ...X, projects: { ...X.projects, p_other: p }, projectOrder: ["p_other", ...X.projectOrder] };
}

describe("組み立てたままの文書を書き換えた後の全部の入れ替えと元に戻す（data-1）", () => {
  it("未来の道筋を開く → 見込みを書き換える → 空にする → 元に戻す", () => {
    setThinBaseline(page);
    const { store, vm } = setup(createEmptyDoc());
    const F = buildMapDoc(page, Date.parse(AT));
    store.replaceDoc(F, "未来の道筋を開く", carryMapDoc(F));
    vm.ensure();
    expect(vm.engine.lastCompile).toBe("map");
    editProb(store);
    matchesDoc(vm, store);
    const shown = vm.impact.vRoot;
    expect(mapDocOf(store.doc)).toBeNull();
    const E = createEmptyDoc();
    store.replaceDoc(E, "空にする", carryMapDoc(E));
    vm.ensure();
    store.undo();
    matchesDoc(vm, store);
    expect(vm.impact.vRoot!).toBeCloseTo(shown!, 9);
    expect(vm.engine.lastCompile).toBe("doc");
    store.redo();
    vm.ensure();
    store.undo();
    matchesDoc(vm, store);
  });

  it("保存した形から読んだ文書 → 見込みを書き換える → 並びの違う文書に入れ替える → 元に戻す・やり直す", () => {
    setThinBaseline(page);
    const D = roundTrip(thinBaselineDoc({ at: AT }));
    expect(storedMapShaped(D)).toBe(true);
    rememberMapDoc(D, mapForDoc(D)!);
    const { store, vm } = setup(D);
    vm.ensure();
    expect(vm.engine.lastCompile).toBe("map");
    editProb(store);
    matchesDoc(vm, store);
    expect(mapForDoc(D)).toBeNull();
    const X = reordered();
    store.replaceDoc(X, "取り込み", carryMapDoc(X));
    vm.ensure();
    store.undo();
    expect(store.doc).toBe(D);
    matchesDoc(vm, store);
  });

  it("入れ替えた文書の見込みを書き換え、元に戻してからやり直す", () => {
    setThinBaseline(page);
    const D = reordered();
    const { store, vm } = setup(D);
    vm.ensure();
    const X = roundTrip(thinBaselineDoc({ at: AT }));
    store.replaceDoc(X, "取り込み", carryMapDoc(X));
    vm.ensure();
    expect(vm.engine.lastCompile).toBe("map");
    editProb(store);
    matchesDoc(vm, store);
    store.undo();
    store.redo();
    store.undo();
    store.undo();
    vm.ensure();
    store.redo();
    store.redo();
    matchesDoc(vm, store);
  });

  it("書き換えていない文書は、入れ替えの元に戻すでも地図の列から作る", () => {
    setThinBaseline(page);
    const D = roundTrip(thinBaselineDoc({ at: AT }));
    rememberMapDoc(D, mapForDoc(D)!);
    const { store, vm } = setup(D);
    vm.ensure();
    // 状態だけの変更（数を変えない）では忘れない
    const a = Object.values(store.doc.nodes).find((n) => n.type === "action")!;
    store.transact("状態", (tx) => tx.updateNode(a.id, { status: "done" }));
    vm.ensure();
    expect(mapDocOf(store.doc)).toBe(page);
    const X = reordered();
    store.replaceDoc(X, "取り込み", carryMapDoc(X));
    vm.ensure();
    store.undo();
    matchesDoc(vm, store);
    expect(vm.engine.lastCompile).toBe("map");
  });
});

describe("保存した形の今日の変更（data-4）と前の版のメモの印（perf-2）", () => {
  const rootOf = (d: DocData): GNode => Object.values(d.nodes).find((n) => n.meta?.forecastRoot === true)!;
  const withRoot = (b: DocData, f: (r: GNode) => GNode): DocData => {
    const r = rootOf(b);
    return { ...b, nodes: { ...b.nodes, [r.id]: f(r) } };
  };

  it("今日の期間を変えた記録は組み立てたままと見なさず、文書から数える", () => {
    setThinBaseline(page);
    const b = thinBaselineDoc({ at: AT });
    const D = roundTrip(withRoot(b, (r) => ({ ...r, meta: { ...r.meta, impact: { ...(r.meta.impact as object), horizon: 24 } } })));
    expect(storedMapShaped(D)).toBe(false);
    expect(mapForDoc(D)).toBeNull();
    const { store, vm } = setup(D);
    matchesDoc(vm, store);
  });

  it("今日の題名・年収だけの変更は組み立てたまま", () => {
    setThinBaseline(page);
    const D = roundTrip(withRoot(thinBaselineDoc({ at: AT }), (r) => ({ ...r, title: "自分の今日", meta: { ...r.meta, impact: { ...(r.meta.impact as object), annual: 480 } } })));
    expect(storedMapShaped(D)).toBe(true);
    const { store, vm } = setup(D);
    rememberMapDoc(D, mapForDoc(D)!);
    matchesDoc(vm, store);
  });

  it("前の版のメモの印だけを付けたカードは組み立てたまま（地図の列から数える）", () => {
    setThinBaseline(page);
    const b = thinBaselineDoc({ at: AT });
    const card = Object.values(b.nodes).find((n) => n.type === "action" && !n.meta.forecastRoot)!;
    const ed: DocData = { ...b, nodes: { ...b.nodes, [card.id]: { ...card, body: "前の版で書いた本文", meta: { ...card.meta, prevBody: true } } } };
    const D = roundTrip(ed);
    expect(D.nodes[card.id]!.meta.prevBody).toBe(true);
    expect(storedMapShaped(D)).toBe(true);
    rememberMapDoc(D, mapForDoc(D)!);
    const { store, vm } = setup(D);
    matchesDoc(vm, store);
    expect(vm.engine.lastCompile).toBe("map");
  });
});
