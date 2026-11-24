// 資産のゴールの前提（入口の meta.goal）の保存: 薄い形の保存で小さいまま・組み立てたままと見なし続ける・版をまたいでも残る・
// 未来の道筋の差し替え（新しい版にする・入れ替える・版 6 からの引き上げ）でも残る・変えても計算はやり直さない（見せ方だけ）・
// 閲覧のみのタブでは書けない
// 数はどれも丸めた仮の数（利用者の数ではない）

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { rememberMapDoc } from "../../src/app/futureCache";
import { DEFAULT_PREFS, UiState } from "../../src/app/uiState";
import { ViewModel } from "../../src/app/viewModel";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";
import type { MapData } from "../../src/deepmap/mapData";
import { swapFutureDoc } from "../../src/demo/futureSwap";
import { buildQuarterDoc } from "../../src/demo/quarterDoc";
import { goalConfigOf } from "../../src/model/forks";
import { buildIndex } from "../../src/model/graph";
import { ImpactEngine } from "../../src/model/impactEngine";
import type { DocData, GNode, ID } from "../../src/model/types";
import { decodeStored, setThinBaseline, storedMapShaped, thinBaselineDoc, toStored, type StoredDoc } from "../../src/persist/codec";
import { carryRoot } from "../../src/persist/thinMap";
import { Store } from "../../src/store/store";
import { loadQSmall, loadQSmallDevTree } from "./helpers/qSmall";
import { buildR6Future } from "./helpers/r6";

/** 6 つ全部を入れた前提（どれも丸めた仮の数） */
const GOAL_FULL = { v: 1, target: 100000, assets: 5000, save: 25, ret: 4, bizGrow: 5, by: 2056 };
/** ふつうの入れ方（3 つだけ） */
const GOAL = { v: 1, assets: 500, save: 25, ret: 4 };
const AT = "2026-11-19T03:00:00.000Z";
const TODAY = new Date(2026, 10, 18);

let page: MapData;
beforeAll(async () => {
  const q = await loadQSmall();
  page = { ...q, header: { ...q.header, release: 7 } } as MapData;
});
afterEach(() => setThinBaseline(null));

const rootOf = (d: DocData): GNode => Object.values(d.nodes).find((n) => n.meta?.forecastRoot === true)!;
const withGoal = (d: DocData, goal: unknown): DocData => {
  const r = rootOf(d);
  return { ...d, nodes: { ...d.nodes, [r.id]: { ...r, meta: { ...r.meta, goal } } } };
};
const storedChars = (d: DocData): number => JSON.stringify(toStored(d)).length;
const roundTrip = (d: DocData): DocData => decodeStored(JSON.parse(JSON.stringify(toStored(d)))).doc;

describe("薄い形の保存", () => {
  it("前提を入れても保存は 120 文字未満しか増えず、読み直すと同じ前提。組み立てたままと見なし続ける", () => {
    setThinBaseline(page);
    const base = thinBaselineDoc({ at: AT });
    const s0 = storedChars(base);
    for (const g of [GOAL, GOAL_FULL]) {
      const d = withGoal(base, g);
      const grew = storedChars(d) - s0;
      expect(grew).toBeGreaterThan(0);
      expect(grew).toBeLessThan(120);
      const back = roundTrip(d);
      expect(rootOf(back).meta.goal).toEqual(g);
      // 前提は数の meta でも impact でもない: 地図の形と数は組み立てたまま（起動で文書を組み立て直さない）
      expect(storedMapShaped(back)).toBe(true);
      expect(goalConfigOf(rootOf(back)).cfg).toMatchObject({ assets: g.assets, save: g.save, ret: g.ret });
    }
  });

  it("前提を入れていなければ、保存にも読んだ文書にも goal は無い（仮の値は書かない）", () => {
    setThinBaseline(page);
    const back = roundTrip(thinBaselineDoc({ at: AT }));
    expect("goal" in rootOf(back).meta).toBe(false);
  });
});

describe("版をまたいでも残る", () => {
  it("carryRoot: 保存してあった今日の meta.goal を、ページの地図の今日に当てる", () => {
    setThinBaseline(page);
    const pr = rootOf(thinBaselineDoc({ at: AT }));
    const sr: GNode = { ...pr, meta: { ...pr.meta, goal: GOAL_FULL } };
    expect(carryRoot(pr, sr).meta.goal).toEqual(GOAL_FULL);
    expect("goal" in carryRoot(pr, pr).meta).toBe(false);
  });

  it("版 7 で保存して版 8 のページで読む（当て直し）: 前提はそのまま", async () => {
    setThinBaseline(page);
    const stored = JSON.parse(JSON.stringify(toStored(withGoal(thinBaselineDoc({ at: AT }), GOAL)))) as StoredDoc;
    const tree = await loadQSmallDevTree();
    tree.header = { ...tree.header, release: 8, hash: `${tree.header.hash.slice(0, 12)}gz` };
    setThinBaseline(fromDevTree(tree));
    const d = decodeStored(stored);
    expect(d.upgrade).toBeDefined();
    expect(rootOf(d.doc).meta.goal).toEqual(GOAL);
    expect(rootOf(d.doc).meta.futureRelease).toBe(8);
  });
});

describe("未来の道筋の差し替えでも残る（futureSwap の 4 か所と、版 6 からの引き上げ）", () => {
  it("同じ地図を新しい版にする（upgradeFuture → upgradeNode）: 入口の前提を引き継ぐ。前提が無ければ足さない", () => {
    const doc = withGoal(buildR6Future(TODAY).pv.doc, GOAL);
    const res = swapFutureDoc(doc, buildR6Future(TODAY).pv.doc);
    expect(res.inPlace).toBe(true);
    expect(res.doc.nodes[rootOf(doc).id]!.meta.goal).toEqual(GOAL);
    const plain = swapFutureDoc(buildR6Future(TODAY).pv.doc, buildR6Future(TODAY).pv.doc);
    expect("goal" in rootOf(plain.doc).meta).toBe(false);
  });

  it("鍵で合わせられない地図を入れ替える（replaceFuture）: 新しい入口に前提を引き継ぐ", () => {
    const d0 = withGoal(buildR6Future(TODAY).pv.doc, GOAL_FULL);
    const r = rootOf(d0);
    const { key: _k, ...meta } = r.meta;
    const doc: DocData = { ...d0, nodes: { ...d0.nodes, [r.id]: { ...r, meta } } };
    const res = swapFutureDoc(doc, buildR6Future(TODAY).pv.doc);
    expect(res.inPlace).toBe(false);
    expect(res.root).not.toBeNull();
    expect(res.doc.nodes[res.root!]!.meta.goal).toEqual(GOAL_FULL);
  });

  it("版 6 の地図をページの地図にする（引き上げ: carryRoot）: 前提はそのまま", () => {
    setThinBaseline(page);
    const doc = withGoal(buildR6Future(TODAY).pv.doc, GOAL);
    const res = swapFutureDoc(doc, thinBaselineDoc());
    expect(res.legacy).toBeDefined();
    expect(rootOf(res.doc).meta.goal).toEqual(GOAL);
  });
});

describe("前提を変えても計算はやり直さない", () => {
  function setup() {
    const doc = buildQuarterDoc(page, { version: page.header.hash, release: page.header.release, at: Date.UTC(2026, 10, 1), layout: "columns" });
    rememberMapDoc(doc, page);
    return doc;
  }

  it("エンジン: 前提だけの変更ではどの版も変わらず、同じ結果を返す（おすすめの値などを数え直さない）。計算（passes）も走らない", () => {
    const store = new Store(setup());
    const engine = new ImpactEngine();
    engine.useMap({ map: page, doc: store.doc });
    store.on("change", (info) => engine.note(store.doc, info));
    const res = () => engine.result({ doc: store.doc, sid: null, out: () => buildIndex(store.doc).out, reach: () => ({ version: 0, of: () => 0 }) });
    const a0 = res();
    const v0 = { ...engine.version };
    const root = store.doc.nodes[a0.root!]!;
    engine.timings.passes = -1;
    store.transact("10 億円の前提を変える", (tx) => tx.updateNode(root.id, { meta: { ...root.meta, goal: GOAL } }));
    const a1 = res();
    expect(a1).toBe(a0);
    expect(engine.version).toEqual(v0);
    expect(engine.timings.passes).toBe(-1);
    // 元に戻しても同じ
    store.undo();
    expect(res()).toBe(a0);
    expect(engine.version).toEqual(v0);
    // 題名など、ほかの見せ方の変更は今までどおり（版が進む）
    const r = store.doc.nodes[a0.root!]!;
    store.transact("印", (tx) => tx.updateNode(r.id, { meta: { ...r.meta, note: "x" } }));
    res();
    expect(engine.version.present).toBe(v0.present + 1);
  });

  it("前提だけを変えても、詳細の欄（Seen）は作り直す・キャンバスの札は文書ごとに作り直す（同じ計算の結果のまま）", async () => {
    const { Seen } = await import("../../src/ui/impactPanel");
    const store = new Store(setup());
    const root = rootOf(store.doc);
    const seen = new Seen();
    seen.title(store.doc, root.id);
    expect(seen.changed(store.doc)).toBe(false);
    // 前提を読んでいなければ、前提の変更では作り直さない
    store.transact("10 億円の前提を変える", (tx) => tx.updateNode(root.id, { meta: { ...root.meta, goal: GOAL } }));
    expect(seen.changed(store.doc)).toBe(false);
    // 前提を読んだ欄は、前提が変わったら作り直す
    seen.goal(store.doc, root.id);
    expect(seen.changed(store.doc)).toBe(false);
    const r1 = rootOf(store.doc);
    store.transact("10 億円の前提を変える", (tx) => tx.updateNode(r1.id, { meta: { ...r1.meta, goal: GOAL_FULL } }));
    expect(seen.changed(store.doc)).toBe(true);
    // 前提の外の変更（位置）では作り直さない
    const fresh = new Seen();
    fresh.goal(store.doc, root.id);
    store.transact("動かす", (tx) => tx.updateNode(root.id, { x: rootOf(store.doc).x + 10 }));
    expect(fresh.changed(store.doc)).toBe(false);
  });

  it("地図の画面に渡す物: 計算の鍵（calcKey）に前提は入らない（同じ画面に渡す物・同じ計算）", () => {
    const store = new Store(setup());
    const ui = new UiState(structuredClone(DEFAULT_PREFS));
    ui.persistPrefs = false;
    const vm = new ViewModel(store, ui);
    vm.narrow = () => false;
    const ctx = vm.deep.get()!;
    const a = ctx.analysis();
    const root: ID = ctx.root;
    store.transact("10 億円の前提を変える", (tx) => tx.updateNode(root, { meta: { ...store.doc.nodes[root]!.meta, goal: GOAL_FULL } }));
    expect(vm.deep.get()).toBe(ctx);
    expect(vm.deep.get()!.analysis()).toBe(a);
    expect(ctx.goal().read.cfg.assets).toBe(GOAL_FULL.assets);
  });
});

describe("閲覧のみのタブ", () => {
  it("前提は書けない（文書はそのまま・止めたことを知らせる）", () => {
    setThinBaseline(page);
    const store = new Store(thinBaselineDoc({ at: AT }));
    const blocked: string[] = [];
    store.on("blocked", (label) => blocked.push(label));
    store.readOnly = true;
    const before = store.doc;
    const r = rootOf(before);
    const ok = store.transact("10 億円の前提を変える", (tx) => tx.updateNode(r.id, { meta: { ...r.meta, goal: GOAL } }));
    expect(ok).toBe(false);
    expect(store.doc).toBe(before);
    expect("goal" in rootOf(store.doc).meta).toBe(false);
    expect(blocked).toEqual(["10 億円の前提を変える"]);
  });
});
