// 3 か月ごとの地図の画面に渡す物の資産のゴール（src/app/deepState.ts の ctx.goal()）: 入口の meta.goal を読むたびに見て、前提だけを
// 変えたときは計算（analyze・overview）をやり直さない。空いた時間の先回り（prewarmSoon）は見取り図の後にゴールの数も作る
// 数はどれも丸めた仮の数

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { rememberMapDoc } from "../../src/app/futureCache";
import { DEFAULT_PREFS, UiState } from "../../src/app/uiState";
import { ViewModel } from "../../src/app/viewModel";
import { goalBase, goalOf, goalViewOf, hasGoalBase } from "../../src/deepmap/core";
import type { MapData } from "../../src/deepmap/mapData";
import { buildQuarterDoc } from "../../src/demo/quarterDoc";
import { DEFAULT_GOAL, goalAnchor, tablesFor } from "../../src/model/goal";
import type { DocData, GNode } from "../../src/model/types";
import { Store } from "../../src/store/store";
import { loadQSmall } from "./helpers/qSmall";

let map: MapData;

beforeAll(async () => {
  map = await loadQSmall();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup() {
  const doc: DocData = buildQuarterDoc(map, { version: map.header.hash, release: map.header.release, at: Date.UTC(2026, 10, 1), layout: "columns" });
  rememberMapDoc(doc, map);
  const store = new Store(doc);
  const ui = new UiState(structuredClone(DEFAULT_PREFS));
  ui.persistPrefs = false;
  const vm = new ViewModel(store, ui);
  vm.narrow = () => false;
  return { store, vm };
}

const rootOf = (store: Store, id: string): GNode => store.doc.nodes[id]!;

describe("ctx.goal()（資産のゴールの数）", () => {
  it("前提を入れていなければ仮の値で、計算ごとの goalBase と設定ごとの goalOf と同じ物。何度読んでも同じ物", () => {
    const { vm } = setup();
    const ctx = vm.deep.get()!;
    const g = ctx.goal();
    expect(g.read.cfg).toEqual(DEFAULT_GOAL);
    expect(g.read.assumed.size).toBe(6);
    expect(g.base).toBe(goalBase(ctx.analysis()));
    expect(g.tables).toBe(tablesFor(DEFAULT_GOAL, goalAnchor(map.header.anchor)));
    expect(g.summary).toBe(goalOf(g.base, g.tables));
    expect(g.tables.anchor.clock).toBe(false);
    expect(g.summary.moves.length).toBe(ctx.cm.firstMoves.length);
    expect(ctx.goal()).toBe(g);
  });

  it("前提を変えると、同じ計算のまま（analyze・overview をやり直さない）新しい数。題名だけの変更では同じ物", () => {
    const { store, vm } = setup();
    const ctx = vm.deep.get()!;
    const a = ctx.analysis();
    const ov = ctx.overview();
    const g0 = ctx.goal();
    const root = ctx.root;
    store.transact("題名", (tx) => tx.updateNode(root, { title: "今日（自分の言葉）" }));
    expect(vm.deep.get()!.goal()).toBe(g0);
    const r = rootOf(store, root);
    store.transact("10 億円の前提を変える", (tx) => tx.updateNode(root, { meta: { ...r.meta, goal: { v: 1, assets: 1000, save: 30, ret: 4 } } }));
    const c1 = vm.deep.get()!;
    // 計算の鍵に前提は入らない: 同じ画面に渡す物・同じ計算・同じ見取り図の数
    expect(c1).toBe(ctx);
    expect(c1.analysis()).toBe(a);
    expect(c1.overview()).toBe(ov);
    const g1 = c1.goal();
    expect(g1).not.toBe(g0);
    expect(g1.base).toBe(g0.base);
    expect(g1.read.cfg).toMatchObject({ assets: 1000, save: 30, ret: 4 });
    expect([...g1.read.assumed].sort()).toEqual(["bizGrow", "by", "target"]);
    // 今の資産と積立を増やしたので、期限の資産の真ん中は大きくなる
    expect(g1.summary.pi!.atBy!.p50).toBeGreaterThan(g0.summary.pi!.atBy!.p50);
    // 元に戻すと、前の設定の数（設定ごとに覚えた物）
    store.undo();
    expect(vm.deep.get()!.goal().summary).toBe(g0.summary);
  });

  it("画面の形が読む出どころ: 計算ごとに置き、作っていなければ（compute が false）行き先をなめずに null。作ってあれば今の前提の数", () => {
    const { store, vm } = setup();
    // ほかのテストで作っていない計算（年収を変える）
    const r0 = rootOf(store, vm.deep.get()!.root);
    store.transact("年収", (tx) => tx.updateNode(r0.id, { meta: { ...r0.meta, impact: { ...(r0.meta.impact as object), annual: 400 } } }));
    const ctx = vm.deep.get()!;
    expect(ctx.annual).toBe(400);
    const a = ctx.analysis();
    expect(hasGoalBase(a)).toBe(false);
    expect(goalViewOf(a, false)).toBeNull();
    expect(hasGoalBase(a)).toBe(false);
    // 開いた画面（手の詳しい画面・道の終わり）は作る: ctx.goal() と同じ物
    const g = goalViewOf(a, true);
    expect(g).toBe(ctx.goal());
    expect(goalViewOf(a, false)).toBe(g);
    // 前提を変えると、同じ計算のまま、作ってある物から今の前提の数（見取り図の帯を埋め直す数）
    const r = rootOf(store, ctx.root);
    store.transact("10 億円の前提を変える", (tx) => tx.updateNode(ctx.root, { meta: { ...r.meta, goal: { v: 1, assets: 5000 } } }));
    expect(vm.deep.get()!.analysis()).toBe(a);
    const g1 = goalViewOf(a, false)!;
    expect(g1).not.toBe(g);
    expect(g1.read.cfg.assets).toBe(5000);
    expect(g1.base).toBe(g!.base);
  });

  it("空いた時間の先回り: 計算・見取り図の数の後に、goalBase と今の設定の数を 1 歩ずつ作る", () => {
    const { vm } = setup();
    // 空いた時間の呼び出しを、そのまま 1 歩ずつ呼ぶ物にする（残りの時間は 0: 1 回に 1 歩）
    const queue: Array<() => void> = [];
    vi.stubGlobal("requestIdleCallback", (cb: (dl: { timeRemaining(): number }) => void) => {
      queue.push(() => cb({ timeRemaining: () => 0 }));
      return queue.length;
    });
    vm.deep.prewarmSoon();
    const ctx = vm.deep.get()!;
    const run = (): void => queue.shift()!();
    // 1 歩目: 計算、2 歩目: 見取り図の数（まだゴールの数は作らない）
    run();
    run();
    expect(vm.deep.timings.overview).toBeGreaterThanOrEqual(0);
    expect(vm.deep.timings.goal).toBeUndefined();
    // 3 歩目: goalBase、4 歩目: 今の設定の数
    run();
    expect(vm.deep.timings.goal).toBeUndefined();
    run();
    expect(vm.deep.timings.goal).toBeGreaterThanOrEqual(0);
    expect(ctx.goal().summary).toBe(goalOf(goalBase(ctx.analysis()), tablesFor(DEFAULT_GOAL, goalAnchor(map.header.anchor))));
    while (queue.length) run();
  });
});
