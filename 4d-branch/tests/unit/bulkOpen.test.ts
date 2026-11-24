// まとめて開く（段数・見込みの高い道・複数のカード・同じ時期まで: 作業メモ bulk/design.md）の数え方・開く形・元に戻す・保存。
// 地図は小さい試験の木（tests/fixtures/q-small。合成した物で、本物の利用者のデータではない）
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { rememberMapDoc } from "../../src/app/futureCache";
import { DEFAULT_PREFS, UiState } from "../../src/app/uiState";
import { ViewModel } from "../../src/app/viewModel";
import { analyze, compileMap, endsFrom, type CompiledMap } from "../../src/deepmap/core";
import type { MapData } from "../../src/deepmap/mapData";
import { buildQuarterDoc } from "../../src/demo/quarterDoc";
import { DEEP_OPEN_CAP, DEPTH_STEPS, OPEN_LIST_BOUND, deepDepths, foldPlan, likelyPaths, openUntil, quarterOpens, shapePlan, topsOf, visibleUnder, visibleUnderEach } from "../../src/model/deepOpen";
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
