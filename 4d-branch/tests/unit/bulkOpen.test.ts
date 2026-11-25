// まとめて開く（段数・見込みの高い道・複数のカード・同じ時期まで: 作業メモ bulk/design.md）の数え方・開く形・元に戻す・保存。
// 地図は小さい試験の木（tests/fixtures/q-small。合成した物で、本物の利用者のデータではない）
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { rememberMapDoc } from "../../src/app/futureCache";
import { DEFAULT_PREFS, UiState } from "../../src/app/uiState";
import { ViewModel } from "../../src/app/viewModel";
import { analyze, compileMap, endsFrom, type CompiledMap } from "../../src/deepmap/core";
import type { MapData } from "../../src/deepmap/mapData";
import { buildQuarterDoc } from "../../src/demo/quarterDoc";
import { Commands } from "../../src/app/commands";
import type { AppContext } from "../../src/app/context";
import type { DeepCtx } from "../../src/app/deepState";
import { DEEP_OPEN_CAP, DEPTH_STEPS, OPEN_LIST_BOUND, deepDepths, deepHorizons, foldPlan, likelyPaths, openUntil, quarterOpens, shapeDepths, shapePlan, shapeRule, topsOf, visibleUnder, visibleUnderEach } from "../../src/model/deepOpen";
import { makeEdge, makeNode } from "../../src/model/schema";
import { drawnSplit, isDrawn, liveCount, moveFit, moveRun, shapeCount, showOnCanvas, userOpensInside } from "../../src/ui/bulkOpen";
import type { DocData } from "../../src/model/types";
import { setThinBaseline, thinBaselineDoc, toStored } from "../../src/persist/codec";
import { Store } from "../../src/store/store";
import { loadQSmall } from "./helpers/qSmall";
import { refView } from "./helpers/refView";

let map: MapData;
let cm: CompiledMap;

beforeAll(async () => {
  map = await loadQSmall();
  cm = compileMap(map);
});
afterEach(() => {
  setThinBaseline(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function build(m: MapData): DocData {
  const doc = buildQuarterDoc(m, { version: m.header.hash, release: m.header.release, at: Date.UTC(2026, 10, 1), layout: "columns" });
  rememberMapDoc(doc, m);
  return doc;
}

function setup(doc: DocData, ui = new UiState(structuredClone(DEFAULT_PREFS))) {
  const store = new Store(doc);
  ui.persistPrefs = false;
  const vm = new ViewModel(store, ui);
  vm.narrow = () => false;
  return { store, ui, vm };
}

/** 決まった乱数（毎回同じ並び） */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 文書をたどらずに、開いている物（番号の集まり）からカード top の先の見えるカードを数える基準（深さ優先で親から子へ） */
function bruteVisible(top: number, open: Set<number>): { count: number; rows: number } {
  let count = 0;
  let rows = 0;
  const stack = [top];
  while (stack.length) {
    const j = stack.pop()!;
    if (!open.has(j)) continue;
    for (let k = 0; k < map.childCount(j); k++) {
      const c = map.child(j, k);
      count++;
      if (!(open.has(c) && map.childCount(c) > 0)) rows++;
      stack.push(c);
    }
  }
  return { count, rows };
}

const hasKids = (j: number) => cm.kidOff[j + 1]! > cm.kidOff[j]!;

describe("まとめて開く: 数え方（押す前に出す枚数）", () => {
  it("段数で開く（A）の 3 か月先・半年先・1 年先・2 年先・終わりまでの数は、区切りごとに openUntil で数えた物と同じ", () => {
    const starts = [0, ...Array.from(cm.firstMoves), ...Array.from({ length: 60 }, (_, k) => Math.floor((k * 7919 + 13) % cm.n))];
    let seen3 = 0;
    for (const i of starts) {
      const ds = deepDepths(cm, i);
      for (const x of ds) {
        const r = openUntil(cm, i, x.toEnd ? Infinity : x.limit);
        expect(x.count, `${i} から ${x.months} か月`).toBe(r.count);
        if (x.months === 3 && !x.toEnd) seen3++;
      }
      // 段数は小さい順で、どれも何かを足す（開いても増えない区切りは出さない）。終わりを超える区切りは 1 つにまとめる
      for (let k = 1; k < ds.length; k++) expect(ds[k]!.count).toBeGreaterThan(ds[k - 1]!.count);
      expect(ds.filter((x) => x.toEnd).length).toBeLessThanOrEqual(1);
      if (ds.length) expect(ds[ds.length - 1]!.count).toBeLessThanOrEqual(cm.size[i]! - 1);
    }
    expect(seen3).toBeGreaterThan(0);
    // 今日の段数: 3 か月・半年・1 年・2 年・終わり（2029 年 11 月）
    expect(deepDepths(cm, 0).map((x) => x.months)).toEqual(DEPTH_STEPS.filter((m) => m <= cm.H));
  });

  it("同じ時期まで（D）の 12 の時期は、今日から openUntil で数えた物と同じ（終わりまでは全部）", () => {
    const qs = quarterOpens(cm);
    expect(qs.length).toBeGreaterThan(4);
    for (const q of qs) expect(q.count, `${q.months} か月`).toBe(openUntil(cm, 0, q.toEnd ? Infinity : q.months).count);
    expect(qs[qs.length - 1]!.toEnd).toBe(true);
    expect(qs[qs.length - 1]!.count).toBe(cm.size[0]! - 1);
    expect(qs.map((q) => q.months)).toEqual([...qs.map((q) => q.months)].sort((a, b) => a - b));
  });
});

describe("まとめて開く: 開く形（shapePlan）", () => {
  it("1 枚: ちょうどその段数の形にする（区切りより後で開いていた物は閉じ、外は触らない）。数は形をたどって数えた物と同じ", () => {
    const r = rng(7);
    for (let t = 0; t < 40; t++) {
      const i = cm.firstMoves[t % cm.firstMoves.length]!;
      // 今開いている物: このカードの先の深い所・外の物を混ぜる
      const now = new Set<number>([0, i]);
      for (let k = 0; k < 60; k++) {
        const j = Math.floor(r() * cm.n);
        if (hasKids(j)) now.add(j);
      }
      const lim = cm.month[i]! + DEPTH_STEPS[t % DEPTH_STEPS.length]!;
      const plan = shapePlan(cm, [{ i, lim }], now);
      const end = i + cm.size[i]!;
      const after = new Set(now);
      for (const j of plan.close) after.delete(j);
      for (const j of plan.open) after.add(j);
      // 外は触らない
      for (const j of [...plan.open, ...plan.close]) expect(j >= i && j < end, `${j} は ${i} の先`).toBe(true);
      // 先の形はちょうどその段数（開く = 先があり、月が区切りより前）
      for (let j = i; j < end; j++) expect(after.has(j), `${j}`).toBe(hasKids(j) && cm.month[j]! < lim);
      // 数は形をたどって数えた物・openUntil と同じ
      const b = bruteVisible(i, after);
      expect(plan.count).toBe(b.count);
      expect(plan.rows).toBe(b.rows);
      expect(plan.count).toBe(openUntil(cm, i, lim).count);
    }
  });

  it("複数（C）: 重なるカードは深い方の区切り。内側の頭は見えたまま、数は形をたどって数えた物と同じ", () => {
    const r = rng(11);
    for (let t = 0; t < 30; t++) {
      // 今日の手 1 つと、その先の深いカード 2 枚・別の手 1 つ
      const f = cm.firstMoves[t % cm.firstMoves.length]!;
      const g = cm.firstMoves[(t + 1) % cm.firstMoves.length]!;
      const inner: number[] = [];
      for (let k = 0; k < 2; k++) {
        let j = f + 1 + Math.floor(r() * (cm.size[f]! - 1));
        while (!hasKids(j) && j > f) j = cm.parent[j]!;
        if (j > f) inner.push(j);
      }
      const d = DEPTH_STEPS[t % 3]!;
      const picks = [f, g, ...inner].map((i) => ({ i, lim: cm.month[i]! + d >= cm.H ? Infinity : cm.month[i]! + d }));
      const now = new Set<number>([0, f, g]);
      const plan = shapePlan(cm, picks, now);
      expect(plan.tops).toEqual(topsOf(cm, [f, g, ...inner]));
      expect(plan.tops).toEqual(f === g ? [f] : [f, g].sort((a, b) => a - b));
      const after = new Set(now);
      for (const j of plan.close) after.delete(j);
      for (const j of plan.open) after.add(j);
      // 内側の頭から覆う頭までの親は開いている（内側の頭が見える）。内側の頭の先は、深い方の区切りまで
      for (const x of inner) {
        for (let q = cm.parent[x]!; q >= f; q = cm.parent[q]!) expect(after.has(q), `${x} の親 ${q}`).toBe(true);
        const lim = Math.max(cm.month[f]! + d, cm.month[x]! + d);
        const lx = lim >= cm.H ? Infinity : lim;
        for (let j = x; j < x + cm.size[x]!; j++) if (hasKids(j) && cm.month[j]! < lx) expect(after.has(j), `${x} の先 ${j}`).toBe(true);
      }
      let count = 0;
      let rows = 0;
      for (const top of plan.tops) {
        const b = bruteVisible(top, after);
        count += b.count;
        rows += b.rows;
      }
      expect(plan.count).toBe(count);
      expect(plan.rows).toBe(rows);
    }
  });

  it("まとめてたたむ: 頭と、その先で開いている物を全部閉じる（外は残す）", () => {
    const f = cm.firstMoves[0]!;
    const g = cm.firstMoves[1]!;
    const now = new Set<number>([0, f, g, ...openUntil(cm, f, cm.month[f]! + 12).open, ...openUntil(cm, g, cm.month[g]! + 6).open]);
    const close = new Set(foldPlan(cm, [f], now));
    for (const j of now) {
      const inF = j >= f && j < f + cm.size[f]!;
      expect(close.has(j), `${j}`).toBe(inF);
    }
    // 入れ子に選んでも同じ
    const deep = openUntil(cm, f, cm.month[f]! + 12).open.at(-1)!;
    expect(new Set(foldPlan(cm, [deep, f], now))).toEqual(close);
  });
});

describe("まとめて開く: 見込みの高い道（B）", () => {
  it("行き先を見込みの大きい順（同じなら番号の順）に N 本。見込みの合計と、開くのは道の上のカードだけ", () => {
    const a = analyze(cm, 540);
    for (const x of [0, ...Array.from(cm.firstMoves)]) {
      const all = endsFrom(a, x);
      const order = all.ends.map((e, k) => ({ e, m: all.mass[k]! })).sort((p, q) => q.m - p.m || p.e - q.e);
      for (const n of [5, 10]) {
        const p = likelyPaths(a, x, n);
        expect(p.n).toBe(Math.min(n, order.length));
        expect(p.ends).toEqual(order.slice(0, p.n).map((o) => o.e));
        expect(p.mass).toBeCloseTo(order.slice(0, p.n).reduce((s, o) => s + o.m, 0), 12);
        // 開くのは x から行き先の親までの道の上
        const want = new Set<number>();
        for (const e of p.ends) for (let q = cm.parent[e]!; q >= x; q = q === x ? -1 : cm.parent[q]!) want.add(q);
        expect(new Set(p.open)).toEqual(want);
        expect(p.open).toEqual([...p.open].sort((u, v) => u - v));
        // 開いた後: 道の行き先はどれも見える（親の並びが開いている）
        const open = new Set(p.open);
        for (const e of p.ends) for (let q = cm.parent[e]!; q >= x; q = q === x ? -1 : cm.parent[q]!) expect(open.has(q)).toBe(true);
        const v = visibleUnder(cm, x, (j) => open.has(j));
        expect(v).toEqual(bruteVisible(x, open));
        // まとめて数える物（5 本・10 本を 1 回なめて）も同じ。今開いている印（base）を混ぜて
        const base = new Uint8Array(cm.size[x]!);
        base[0] = 1;
        const other = new Set(likelyPaths(a, x, 3).open);
        const each = visibleUnderEach(cm, x, base, [open, other]);
        expect(each[0]).toEqual(visibleUnder(cm, x, (j) => j === x || open.has(j)));
        expect(each[1]).toEqual(visibleUnder(cm, x, (j) => j === x || other.has(j)));
      }
      // 10 本の道は 5 本の道を含む
      expect(likelyPaths(a, x, 10).open).toEqual(expect.arrayContaining(likelyPaths(a, x, 5).open));
      // 行き先より多い N: 全部
      const many = likelyPaths(a, x, 1e9);
      expect(many.n).toBe(order.length);
      expect(many.mass).toBeCloseTo(order.reduce((s, o) => s + o.m, 0), 9);
    }
  });

  it("同じ見込みの行き先は番号の小さい物を先に（並びは決まっている）", () => {
    const a = analyze(cm, 540);
    const x = cm.firstMoves[0]!;
    const all = endsFrom(a, x);
    const p = likelyPaths(a, x, all.ends.length);
    for (let k = 1; k < p.ends.length; k++) {
      const m0 = all.mass[all.ends.indexOf(p.ends[k - 1]!)]!;
      const m1 = all.mass[all.ends.indexOf(p.ends[k]!)]!;
      expect(m0 > m1 || (m0 === m1 && p.ends[k - 1]! < p.ends[k]!)).toBe(true);
    }
  });
});

describe("まとめて開く: アプリの見え方（1 回の変更・元に戻す・保存）", () => {
  it("段数で開く: 開いた後のキャンバスの枚数は、押す前に出した数（外の見えているカード + 形の数）と同じ。1 回の描き直しの合図", () => {
    const doc = build(map);
    const { ui, vm } = setup(doc);
    const ctx = vm.deep.get()!;
    for (const f of Array.from(cm.firstMoves).slice(0, 3)) {
      for (const x of deepDepths(cm, f)) {
        vm.ensure();
        const before = vm.drawNodes.length;
        let inside = 0;
        for (const id of vm.drawNodes) {
          const j = ctx.indexOf(id);
          if (j > f && j < f + cm.size[f]!) inside++;
        }
        const now = [...vm.impactOpenSet(ctx.root)].map((id) => ctx.indexOf(id)).filter((j) => j >= 0);
        const plan = shapePlan(cm, [{ i: f, lim: x.toEnd ? Infinity : x.limit }], now);
        expect(plan.count).toBe(x.count);
        let visual = 0;
        const off = ui.on("visual", () => visual++);
        const snap = vm.bulkOpen(
          plan.open.map((j) => ctx.idOf(j)),
          plan.close.map((j) => ctx.idOf(j)),
          { reveal: true },
        );
        off();
        expect(visual).toBe(snap ? 1 : 0);
        vm.ensure();
        expect(vm.drawNodes.length, `${f} ${x.months}`).toBe(before - inside + x.count);
      }
    }
  });

  it("まとめて開いても、文書・履歴・保存する形（toStored）は変わらない。元に戻すで前の形へ、後に開閉があれば戻さない", () => {
    // 保存する形は地図の基準との差（薄い形）。基準を用意して、基準から組み立てた文書で
    const page = { ...map, header: { ...map.header, release: 7 } } as MapData;
    setThinBaseline(page);
    const doc = thinBaselineDoc({ at: "2026-11-19T03:04:05.006Z" });
    rememberMapDoc(doc, page);
    const { store, ui, vm } = setup(doc);
    const ctx = vm.deep.get()!;
    const stored0 = JSON.stringify(toStored(store.doc));
    const docRef = store.doc;
    const undo0 = store.history.undoStack.length;
    const prefs0 = ui.prefs.impactOpen;
    const plan = shapePlan(cm, [{ i: 0, lim: 6 }], [...vm.impactOpenSet(ctx.root)].map((id) => ctx.indexOf(id)));
    const snap = vm.bulkOpen(
      plan.open.map((j) => ctx.idOf(j)),
      plan.close.map((j) => ctx.idOf(j)),
    )!;
    expect(snap).not.toBeNull();
    expect(snap.before).toBe(prefs0);
    expect(snap.after).toBe(ui.prefs.impactOpen);
    expect(store.doc).toBe(docRef);
    expect(store.history.undoStack.length).toBe(undo0);
    expect(JSON.stringify(toStored(store.doc))).toBe(stored0);
    vm.ensure();
    const opened = vm.drawNodes.length;
    // 元に戻す: 前の形へ（描き直しの合図 1 回）
    let visual = 0;
    const off = ui.on("visual", () => visual++);
    expect(vm.restoreOpen(snap)).toBe(true);
    off();
    expect(visual).toBe(1);
    expect(ui.prefs.impactOpen).toBe(prefs0);
    vm.ensure();
    expect(vm.drawNodes.length).toBeLessThan(opened);
    // 2 度目は戻さない（もう前の形）
    expect(vm.restoreOpen(snap)).toBe(false);
    // 開いた後に別の開閉があれば戻さない
    const snap2 = vm.bulkOpen(plan.open.map((j) => ctx.idOf(j)), [])!;
    vm.setImpactOpen([], [ctx.idOf(cm.firstMoves[0]!)]);
    const now = ui.prefs.impactOpen;
    expect(vm.restoreOpen(snap2)).toBe(false);
    expect(ui.prefs.impactOpen).toBe(now);
    expect(JSON.stringify(toStored(store.doc))).toBe(stored0);
  });

  it("まとめて開いたまま選ぶ（選ぶだけの近道）: 見え方は基準の作り（refView）と同じ。複数・線・選ぶ線だけの表示・外すも", () => {
    const doc = build(map);
    const { store, ui, vm } = setup(doc);
    const ctx = vm.deep.get()!;
    const now = [...vm.impactOpenSet(ctx.root)].map((id) => ctx.indexOf(id)).filter((j) => j >= 0);
    const plan = shapePlan(cm, [{ i: 0, lim: 9 }], now);
    vm.bulkOpen(plan.open.map((j) => ctx.idOf(j)), plan.close.map((j) => ctx.idOf(j)));
    vm.ensure();
    const r = rng(5);
    const shown = vm.drawNodes.filter((id) => vm.inImpact(id));
    const same = (what: string) => {
      vm.ensure();
      const ref = refView(store.doc, ui, false);
      expect(vm.drawNodes, what).toEqual(ref.drawNodes);
      expect(vm.drawEdges, what).toEqual(ref.drawEdges);
      for (const id of vm.drawNodes) expect(vm.node(id), `${what} ${id}`).toEqual(ref.nodes.get(id));
      for (const id of vm.drawEdges) expect(vm.edges.get(id), `${what} ${id}`).toEqual(ref.edges.get(id));
      expect(vm.pathActive).toBe(ref.pathActive);
    };
    const fast0 = vm.patchCounts.selectionOnly;
    for (let k = 0; k < 6; k++) {
      ui.select([shown[Math.floor(r() * shown.length)]!]);
      same(`選ぶ ${k}`);
    }
    // 選ぶだけの変更は近道で作った
    expect(vm.patchCounts.selectionOnly - fast0).toBe(6);
    ui.select([shown[3]!, shown[40]!, shown[90]!]);
    same("3 枚");
    const anEdge = vm.drawEdges[17]!;
    ui.select([], [anEdge]);
    same("線");
    ui.setPrefs({ edgeMode: "selection" });
    ui.select([shown[50]!]);
    same("選んだ物の線だけ");
    ui.select([shown[60]!]);
    same("選んだ物の線だけ（選び直す）");
    ui.setPrefs({ edgeMode: "all", pathHighlight: false });
    ui.select([shown[70]!]);
    same("経路を強調しない");
    ui.clearSelection();
    same("外す");
    // 選んだ後に文書を変えても（近道を使わずに）同じ
    store.transact("題名", (tx) => tx.updateNode(shown[5]!, { title: "書き換えた" }));
    ui.select([shown[5]!]);
    same("書き換えた後");
  });

  it("まとめてたたむ: そのカードの先で開いている印を全部捨てる（1 回の変更）。開き直しても深い所は閉じたまま", () => {
    const doc = build(map);
    const { vm } = setup(doc);
    const ctx = vm.deep.get()!;
    const f = cm.firstMoves[0]!;
    vm.setImpactOpen(openUntil(cm, f, cm.month[f]! + 12).open.map((j) => ctx.idOf(j)));
    const now = [...vm.impactOpenSet(ctx.root)].map((id) => ctx.indexOf(id));
    const snap = vm.bulkOpen([], foldPlan(cm, [f], now).map((j) => ctx.idOf(j)))!;
    expect(snap).not.toBeNull();
    for (const id of vm.impactOpenSet(ctx.root)) {
      const j = ctx.indexOf(id);
      expect(j >= f && j < f + cm.size[f]!, `${j}`).toBe(false);
    }
    vm.setImpactOpen([ctx.idOf(f)]);
    vm.ensure();
    expect(vm.drawNodes.filter((id) => ctx.indexOf(id) > f && ctx.indexOf(id) < f + cm.size[f]!).length).toBe(cm.kidOff[f + 1]! - cm.kidOff[f]!);
  });

  it("開いた形は設定に 1 回だけ書き、開き直す（設定を読み直す）と同じ形。設定は膨らまない（20 回まとめて開いても 100K 字未満）", () => {
    vi.useFakeTimers();
    const mem = new Map<string, string>();
    let writes = 0;
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => {
        writes++;
        mem.set(k, String(v));
      },
      removeItem: (k: string) => void mem.delete(k),
    });
    const doc = build(map);
    const ui = new UiState();
    const store = new Store(doc);
    const vm = new ViewModel(store, ui);
    vm.narrow = () => false;
    const ctx = vm.deep.get()!;
    const r = rng(3);
    for (let t = 0; t < 20; t++) {
      const now = [...vm.impactOpenSet(ctx.root)].map((id) => ctx.indexOf(id)).filter((j) => j >= 0);
      const kind = t % 3;
      if (kind === 0) {
        const f = cm.firstMoves[Math.floor(r() * cm.firstMoves.length)]!;
        const plan = shapePlan(cm, [{ i: f, lim: cm.month[f]! + DEPTH_STEPS[Math.floor(r() * 4)]! }], now);
        vm.bulkOpen(plan.open.map((j) => ctx.idOf(j)), plan.close.map((j) => ctx.idOf(j)));
      } else if (kind === 1) {
        const p = likelyPaths(ctx.analysis(), cm.firstMoves[Math.floor(r() * cm.firstMoves.length)]!, 10);
        vm.bulkOpen(p.open.map((j) => ctx.idOf(j)), []);
      } else {
        const plan = shapePlan(cm, [{ i: 0, lim: 3 * (1 + Math.floor(r() * 3)) }], now);
        vm.bulkOpen(plan.open.map((j) => ctx.idOf(j)), plan.close.map((j) => ctx.idOf(j)));
      }
      // 1 回の操作 = 200 ms の後に 1 回の書き込み
      const w0 = writes;
      vi.advanceTimersByTime(250);
      expect(writes - w0).toBeLessThanOrEqual(1);
    }
    const raw = mem.get("4d-branch:prefs")!;
    expect(raw.length).toBeLessThan(100_000);
    // 開き直す: 同じ形が見える
    vm.ensure();
    const shown = new Set(vm.drawNodes);
    const ui2 = new UiState();
    expect(ui2.prefs.impactOpen).toEqual(ui.prefs.impactOpen);
    const vm2 = new ViewModel(new Store(doc), ui2);
    vm2.narrow = () => false;
    vm2.ensure();
    expect(new Set(vm2.drawNodes)).toEqual(shown);
    // ほかのカードも選ぶは保存しない
    ui.setMultiPick(true);
    ui.setPrefs({ leftOpen: false });
    vi.advanceTimersByTime(250);
    expect(mem.get("4d-branch:prefs")!).not.toContain("multiPick");
    expect(new UiState().multiPick).toBe(false);
  });

  it("開いた印が多すぎる（4,000 を超える）と、閉じたカードの中に隠れた物を捨てる（見えている形は変わらない）", () => {
    const doc = build(map);
    const { ui, vm } = setup(doc);
    const ctx = vm.deep.get()!;
    // 全部開いてから、今日の手を 2 つ閉じる（その先の開いた印は隠れたまま残る）
    const all = openUntil(cm, 0, Infinity).open;
    expect(all.length).toBeGreaterThan(OPEN_LIST_BOUND);
    vm.setImpactOpen(all.slice(0, OPEN_LIST_BOUND - 10).map((j) => ctx.idOf(j)));
    const f = cm.firstMoves[0]!;
    vm.setImpactOpen([], [ctx.idOf(f)]);
    vm.ensure();
    const shown = new Set(vm.drawNodes);
    // 印を足して上限を超える
    vm.setImpactOpen(all.slice(OPEN_LIST_BOUND - 10).map((j) => ctx.idOf(j)));
    vm.setImpactOpen([], [ctx.idOf(cm.firstMoves[1]!)]);
    const list = ui.prefs.impactOpen[ctx.root]!;
    // 手 f の先の印は捨てた（f は閉じている）
    expect(list.some((id) => {
      const j = ctx.indexOf(id);
      return j > f && j < f + cm.size[f]!;
    })).toBe(false);
    vm.ensure();
    // 見えているのは、f と手 1 を閉じた形（f の先は前と同じく隠れたまま）
    for (const id of vm.drawNodes) {
      const j = ctx.indexOf(id);
      if (j > f && j < f + cm.size[f]!) throw new Error("閉じた手の先が見える");
    }
    expect(shown.size).toBeGreaterThan(0);
    expect(DEEP_OPEN_CAP).toBe(3000);
  });
});

// ------------------------------------------------------------ 見直しの直し（data-*・speed-*）

/** パネルの数え方（src/ui/bulkOpen.ts）を、画面なしで呼ぶためのアプリ（使う物だけ） */
function appOf(store: Store, ui: UiState, vm: ViewModel): AppContext {
  return { store, ui, vm, view: { centerOn() {} } } as unknown as AppContext;
}

/** 開く・閉じる（地図の番号）を 1 回の bulkOpen で */
function applyRun(vm: ViewModel, ctx: DeepCtx, open: readonly number[], close: readonly number[]) {
  return vm.bulkOpen(
    open.map((j) => ctx.idOf(j)),
    close.map((j) => ctx.idOf(j)),
    { reveal: true },
  );
}

const nowOf = (vm: ViewModel, ctx: DeepCtx) => [...vm.impactOpenSet(ctx.root)].map((id) => ctx.indexOf(id)).filter((j) => j >= 0);

describe("まとめて開く: 見直しの直し", () => {
  it("手ごとに開く: 前に深く開いて C で閉じた手でも、ボタンの数 = 開いた後の数・全体は 3,000 枚まで（data-permove-count-cap-bypass）", () => {
    const doc = build(map);
    const { store, ui, vm } = setup(doc);
    const app = appOf(store, ui, vm);
    const ctx = vm.deep.get()!;
    const fs = Array.from(cm.firstMoves).slice(0, 3);
    // どの手も A で開ける一番深い段数まで開いてから、C（その手の印だけを消す）で閉じる: 深い所の開いた印は隠れたまま残る
    for (const f of fs) {
      vm.ensure();
      const outside = vm.drawNodes.length;
      const ds = deepDepths(cm, f).filter((x) => outside + x.count <= DEEP_OPEN_CAP);
      const x = ds[ds.length - 1]!;
      const plan = shapePlan(cm, [{ i: f, lim: x.toEnd ? Infinity : x.limit }], nowOf(vm, ctx));
      applyRun(vm, ctx, plan.open, plan.close);
      vm.setImpactOpen([], [ctx.idOf(f)]);
    }
    let pressed = 0;
    for (const f of fs) {
      const fit = moveFit(app, ctx, f);
      if (!fit) continue;
      const run = moveRun(app, ctx, f, fit, "1 年先まで", null);
      // 押す前に出した数のまま（形はちょうど 1 年先まで: 隠れていた深い所は閉じる）
      expect(run.count, `${f}`).toBe(fit.count);
      expect(run.count).toBe(deepHorizons(cm, f)[0]!.count);
      applyRun(vm, ctx, run.open, run.close);
      vm.ensure();
      expect(vm.drawNodes.length, `${f}`).toBe(run.total);
      expect(vm.drawNodes.length).toBeLessThanOrEqual(DEEP_OPEN_CAP);
      pressed++;
    }
    expect(pressed).toBeGreaterThan(0);
  });

  it("開いた印を捨てるとき、合流のカード（入る線が 2 本）はほかの親から見えていれば残す（data-prune-dag-hides-visible）", () => {
    const doc = build(map);
    const { store, ui, vm } = setup(doc);
    const ctx = vm.deep.get()!;
    const A = ctx.idOf(cm.firstMoves[0]!);
    const B = ctx.idOf(cm.firstMoves[1]!);
    const M = makeNode({ type: "result", title: "合流" });
    const K = makeNode({ type: "action", title: "その先" });
    store.transact("合流", (tx) => {
      tx.addNode(M);
      tx.addNode(K);
      tx.addEdge(makeEdge({ source: A, target: M.id }));
      tx.addEdge(makeEdge({ source: B, target: M.id }));
      tx.addEdge(makeEdge({ source: M.id, target: K.id }));
    });
    const all = openUntil(cm, 0, Infinity).open.map((j) => ctx.idOf(j));
    vm.setImpactOpen([...all.slice(0, OPEN_LIST_BOUND - 100), M.id, A, B]);
    // A を閉じても、M は B から見えている
    vm.setImpactOpen([], [A]);
    vm.ensure();
    expect(vm.drawNodes.includes(M.id)).toBe(true);
    expect(vm.drawNodes.includes(K.id)).toBe(true);
    // 関係の無い開くで印が 4,000 を超える（隠れた印を捨てる）: M と K は見えたまま
    vm.setImpactOpen(all.slice(OPEN_LIST_BOUND - 100, OPEN_LIST_BOUND + 200));
    expect(ui.prefs.impactOpen[ctx.root]!.length).toBeLessThan(OPEN_LIST_BOUND + 300);
    vm.ensure();
    expect(ui.prefs.impactOpen[ctx.root]!.includes(M.id)).toBe(true);
    expect(vm.drawNodes.includes(M.id)).toBe(true);
    expect(vm.drawNodes.includes(K.id)).toBe(true);
  });

  it("書き換えた地図（自分のカードを足した・地図のカードを消した）: 押す前の数 = 開いた後の数（data-counts-ignore-user-edits）", () => {
    for (const kind of ["add", "delete"] as const) {
      const doc = build(map);
      const { store, ui, vm } = setup(doc);
      const app = appOf(store, ui, vm);
      const ctx0 = vm.deep.get()!;
      const f = cm.firstMoves[0]!;
      const g = cm.kids[cm.kidOff[f]!]!;
      if (kind === "add") {
        for (let k = 0; k < 5; k++) {
          const c = makeNode({ type: "action", title: `自分のカード ${k}` });
          store.transact("足す", (tx) => {
            tx.addNode(c);
            tx.addEdge(makeEdge({ source: ctx0.idOf(g), target: c.id }));
          });
        }
      } else {
        const ids: string[] = [];
        for (let j = g; j < g + cm.size[g]!; j++) ids.push(ctx0.idOf(j));
        store.transact("消す", (tx) => {
          for (const id of ids) if (store.doc.nodes[id]) tx.deleteNode(id);
        });
      }
      const ctx = vm.deep.get()!;
      expect(ctx.edited).toBe(true);
      for (const x of deepDepths(cm, f).slice(0, 3)) {
        const pk = [{ i: f, lim: x.toEnd ? Infinity : x.limit }];
        const split = drawnSplit(app, ctx, [f]);
        const c = shapeCount(app, ctx, pk, x);
        const plan = shapePlan(cm, pk, nowOf(vm, ctx));
        applyRun(vm, ctx, plan.open, plan.close);
        vm.ensure();
        expect(vm.drawNodes.length, `${kind} ${x.months}`).toBe(split.drawn - split.inside + c.count);
        // 開いた後の内側の数も、たどって数えた物と同じ
        expect(drawnSplit(app, ctx, [f]).inside).toBe(c.count);
      }
      // 自分のカードの開いた印も、まとめてたたむで閉じる
      if (kind === "add") {
        const mine = Object.values(store.doc.nodes).find((n) => n.title === "自分のカード 0")!;
        const kid = makeNode({ type: "result", title: "その先" });
        store.transact("足す", (tx) => {
          tx.addNode(kid);
          tx.addEdge(makeEdge({ source: mine.id, target: kid.id }));
        });
        vm.setImpactOpen([mine.id]);
        const c2 = vm.deep.get()!;
        expect(userOpensInside(app, c2, [f])).toContain(mine.id);
      }
    }
  });

  it("書き換えた地図の段数の数は、選んだ手が変わって画面に渡す物が作り直されてもなめ直さない。開いた・形を変えたら数え直す（v36: スマホのこれにする +80 ms）", () => {
    const doc = build(map);
    const { store, ui, vm } = setup(doc);
    const app = appOf(store, ui, vm);
    const ctx0 = vm.deep.get()!;
    const f = cm.firstMoves[0]!;
    const g = cm.kids[cm.kidOff[f]!]!;
    const addMine = (k: number) => {
      const c = makeNode({ type: "action", title: `自分のカード ${k}` });
      store.transact("足す", (tx) => {
        tx.addNode(c);
        tx.addEdge(makeEdge({ source: ctx0.idOf(g), target: c.id }));
      });
    };
    addMine(0);
    const ctx1 = vm.deep.get()!;
    expect(ctx1.edited).toBe(true);
    const x = deepDepths(cm, f).find((d) => d.toEnd)!;
    const pk = [{ i: f, lim: Infinity }];
    const fresh = (ctx: DeepCtx) => {
      const rule = shapeRule(cm, pk);
      return liveCount(app, ctx, rule.tops, rule.want);
    };
    const c1 = shapeCount(app, ctx1, pk, x);
    expect(c1).toEqual(fresh(ctx1));
    const spy = vi.spyOn(vm, "countImpactUnder");
    // 選ぶ（これにする）: 計算と画面に渡す物は作り直されるが、数は同じ物（なめ直さない）
    store.transact("これにする", (tx) => tx.updateNode(ctx1.idOf(f), { status: "active" }));
    const ctx2 = vm.deep.get()!;
    expect(ctx2).not.toBe(ctx1);
    expect(ctx2.analysis()).not.toBe(ctx1.analysis());
    expect(shapeCount(app, ctx2, pk, x)).toEqual(c1);
    expect(spy).not.toHaveBeenCalled();
    expect(fresh(ctx2)).toEqual(c1);
    // 開いている物が変わった: 数え直す（このカードの先はちょうどその段数の形なので、数は同じ）
    spy.mockClear();
    vm.setImpactOpen([ctx2.idOf(cm.kids[cm.kidOff[g]!]!)]);
    expect(shapeCount(app, vm.deep.get()!, pk, x)).toEqual(c1);
    expect(spy).toHaveBeenCalled();
    // 自分のカードをもう 1 枚足した（形が変わった）: 数え直して 1 枚増える
    spy.mockClear();
    addMine(1);
    const ctx3 = vm.deep.get()!;
    const c3 = shapeCount(app, ctx3, pk, x);
    expect(spy).toHaveBeenCalled();
    expect(c3.count).toBe(c1.count + 1);
    expect(c3).toEqual(fresh(ctx3));
  });

  it("⌘Z: 直前のまとめて開くを戻す（文書の取り消しは使わない）。その後に文書を書き換えていれば文書の取り消し（data-undo-toast-only・reader-3）", () => {
    const doc = build(map);
    const { store, ui, vm } = setup(doc);
    let undone = 0;
    const cmd = new Commands(store, ui, vm, { toast() {}, viewCenter: () => ({ x: 0, y: 0 }), startEdit() {}, reveal() {}, confirm: async () => true, bulkUndone: () => undone++ });
    const ctx = vm.deep.get()!;
    const f = cm.firstMoves[0]!;
    // 文書の編集（題名）→ まとめて開く → ⌘Z: 開いた形だけ戻り、題名はそのまま
    cmd.updateNode(ctx.idOf(f), { title: "書き換えた題名" });
    const undo0 = store.history.undoStack.length;
    const prefs0 = ui.prefs.impactOpen;
    const plan = shapePlan(cm, [{ i: f, lim: cm.month[f]! + 12 }], nowOf(vm, ctx));
    applyRun(vm, ctx, plan.open, plan.close);
    expect(vm.canUndoBulkOpen).toBe(true);
    cmd.undo();
    expect(undone).toBe(1);
    expect(ui.prefs.impactOpen).toBe(prefs0);
    expect(store.doc.nodes[ctx.idOf(f)]!.title).toBe("書き換えた題名");
    expect(store.history.undoStack.length).toBe(undo0);
    // もう 1 度: 文書の取り消し
    cmd.undo();
    expect(store.doc.nodes[ctx.idOf(f)]!.title).not.toBe("書き換えた題名");
    // まとめて開いた後に文書を書き換えた: ⌘Z は文書の取り消し（開いた形はそのまま）
    applyRun(vm, ctx, plan.open, plan.close);
    const opened = ui.prefs.impactOpen;
    cmd.updateNode(ctx.idOf(f), { title: "もう一度" });
    expect(vm.canUndoBulkOpen).toBe(false);
    cmd.undo();
    expect(ui.prefs.impactOpen).toBe(opened);
    expect(store.doc.nodes[ctx.idOf(f)]!.title).not.toBe("もう一度");
    // 最初の形に戻すも ⌘Z で戻せる
    const snap = vm.bulkReset()!;
    expect(snap.before).toBe(opened);
    cmd.undo();
    expect(ui.prefs.impactOpen).toBe(opened);
  });

  it("お知らせの「元に戻す」: その後にまとめて開いていても、お知らせの操作（文書）を戻し、開いた形はそのまま（data-1）", () => {
    const doc = build(map);
    const { store, ui, vm } = setup(doc);
    let undone = 0;
    const cmd = new Commands(store, ui, vm, { toast() {}, viewCenter: () => ({ x: 0, y: 0 }), startEdit() {}, reveal() {}, confirm: async () => true, bulkUndone: () => undone++ });
    const ctx = vm.deep.get()!;
    const f = cm.firstMoves[0]!;
    // 前提を変えた・題名を変えた など、お知らせに「元に戻す」が付く操作 → そのお知らせが出ている間にまとめて開く
    cmd.updateNode(ctx.idOf(f), { title: "お知らせの操作" });
    const action = cmd.undoAction();
    const plan = shapePlan(cm, [{ i: f, lim: cm.month[f]! + 12 }], nowOf(vm, ctx));
    const snap = applyRun(vm, ctx, plan.open, plan.close)!;
    expect(snap).not.toBeNull();
    action.run();
    expect(undone).toBe(0);
    expect(store.doc.nodes[ctx.idOf(f)]!.title).not.toBe("お知らせの操作");
    expect(ui.prefs.impactOpen).toBe(snap.after);
    // 文書を戻した後の ⌘Z は、まとめて開くを戻さない（版が進んだ）。まとめて開くのお知らせの「元に戻す」は効く
    expect(vm.canUndoBulkOpen).toBe(false);
    expect(vm.restoreOpen(snap)).toBe(true);
    expect(ui.prefs.impactOpen).toBe(snap.before);
  });

  it("隠れているカード（上のカードが閉じている）からは開かない。「キャンバスに出す」で出すと開ける（data-hidden-head-false-toast）", () => {
    const doc = build(map);
    const { store, ui, vm } = setup(doc);
    const app = appOf(store, ui, vm);
    const ctx = vm.deep.get()!;
    const f = cm.firstMoves[0]!;
    const p0 = shapePlan(cm, [{ i: f, lim: cm.month[f]! + 6 }], nowOf(vm, ctx));
    applyRun(vm, ctx, p0.open, p0.close);
    let g = -1;
    for (let j = f + 1; j < f + cm.size[f]!; j++) if (cm.parent[j] !== f && hasKids(j)) {
      g = j;
      break;
    }
    expect(isDrawn(app, ctx, g)).toBe(true);
    vm.setImpactOpen([], [ctx.idOf(f)]);
    expect(isDrawn(app, ctx, g)).toBe(false);
    // 隠れた頭の先は見えていない（数えない）
    expect(drawnSplit(app, ctx, [g]).inside).toBe(0);
    showOnCanvas(app, ctx, [g]);
    expect(isDrawn(app, ctx, g)).toBe(true);
  });

  it("C の段数ごとの数は 1 回なめて数える（shapeDepths = 段数ごとの shapePlan。入れ子・離れたカード）（speed-multiselect-regression）", () => {
    const r = rng(23);
    for (let t = 0; t < 30; t++) {
      const picks = new Set<number>();
      const k = 1 + (t % 5);
      for (let s = 0; s < k; s++) {
        const f = cm.firstMoves[Math.floor(r() * cm.firstMoves.length)]!;
        // 手か、その先の深いカード
        picks.add(r() < 0.5 ? f : f + Math.floor(r() * cm.size[f]!));
      }
      if (t === 0) picks.add(0);
      const ps = [...picks];
      const ds = shapeDepths(cm, ps);
      expect(ds.map((x) => x.months)).toEqual([...DEPTH_STEPS]);
      for (const x of ds) {
        const pk = ps.map((i) => ({ i, lim: cm.month[i]! + x.months >= cm.H ? Infinity : cm.month[i]! + x.months }));
        const plan = shapePlan(cm, pk, []);
        expect(x.count, `${ps.join(",")} ${x.months}`).toBe(plan.count);
        expect(x.rows, `${ps.join(",")} ${x.months}`).toBe(plan.rows);
      }
    }
  });

  it("見え方の範囲でたどって数える（countImpactUnder）は、書き換えていない地図では番号で数えた物と同じ", () => {
    const doc = build(map);
    const { store, ui, vm } = setup(doc);
    const app = appOf(store, ui, vm);
    const ctx = vm.deep.get()!;
    for (const f of Array.from(cm.firstMoves).slice(0, 4)) {
      const x = deepDepths(cm, f)[2]!;
      const pk = [{ i: f, lim: x.limit }];
      const rule = shapeRule(cm, pk);
      expect(liveCount(app, ctx, rule.tops, rule.want)).toEqual({ count: x.count, rows: x.rows });
    }
  });
});
