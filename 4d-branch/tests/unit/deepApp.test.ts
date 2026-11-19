// 3 か月ごとの地図（版 7）のアプリの画面の材料を、小さい木（q-small）と版 6 の凍結した写しで確かめる（作業メモ SPEC v1 §5・§4.4）:
//   時間で区切って開く（src/model/deepOpen.ts）: 開いた後に見える枚数と開くカードが、文書をたどった数と同じ。区切りは地図の終わりで 1 つ
//   線の札（src/canvas/geometry.ts）: 深さ 23 → 24（2029 年 11 月の列）の結果の線の札が、どの拡大率でも両端のカードに重ならない（user-16）
//   月から決める列（src/app/viewModel.ts）: まとめた行き先は 2029 年 11 月の列。版 6 の地図は深さの列のまま
//   画面に渡す物（src/app/deepState.ts）: 地図とカードの番号の行き来・選んだ手（エンジンの物と文書から読んだ物が同じ）・計算の芯の答え・
//     形を変えた後・方針（数は絞らない）・選んだまとめた手・写しの文章
//   新しい地図の知らせの表（src/model/releaseNotes.ts）: 版 6 の今日の手の差（R1 §5 の値）・向きの逆転
import { beforeAll, describe, expect, it } from "vitest";
import { plainAnalysis } from "../../src/app/deepState";
import { rememberMapDoc } from "../../src/app/futureCache";
import { DEFAULT_PREFS, UiState } from "../../src/app/uiState";
import { ViewModel } from "../../src/app/viewModel";
import { edgeLabelBox, edgeGeom, HALF_W, labelMaxW, labelScale, LABEL_PAD } from "../../src/canvas/geometry";
import { analyze, compileMap, type CompiledMap } from "../../src/deepmap/core";
import { F_STUB, ROLE_A } from "../../src/deepmap/core/compile";
import type { MapData } from "../../src/deepmap/mapData";
import { materializeBody } from "../../src/demo/compose";
import { buildQuarterDoc } from "../../src/demo/quarterDoc";
import { NODE_W } from "../../src/model/constants";
import { deepHorizons, horizonOpen, openUntil } from "../../src/model/deepOpen";
import { buildIndex } from "../../src/model/graph";
import { computeImpact } from "../../src/model/impact";
import { compiledMapOf } from "../../src/model/impactGraph";
import { impactColX } from "../../src/model/impactLayout";
import { deltaTable, todayDeltasOf } from "../../src/model/releaseNotes";
import { makeNode } from "../../src/model/schema";
import type { DocData } from "../../src/model/types";
import { Store } from "../../src/store/store";
import { buildR6Future } from "./helpers/r6";
import { loadQSmall } from "./helpers/qSmall";

let map: MapData;
let cm: CompiledMap;

beforeAll(async () => {
  map = await loadQSmall();
  cm = compileMap(map);
});

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

describe("時間で区切って開く（全部ひらくの代わり）", () => {
  /** 文書をたどって数える基準: カード i の先で、親の月が limit より前のカード */
  function brute(i: number, limit: number): { count: number; open: number[] } {
    const out: number[] = [];
    let count = 0;
    const stack = [i];
    while (stack.length) {
      const j = stack.pop()!;
      const kids = Array.from({ length: map.childCount(j) }, (_, k) => map.child(j, k));
      if (cm.month[j]! < limit && kids.length) out.push(j);
      if (!(cm.month[j]! < limit)) continue;
      for (const c of kids) {
        count++;
        stack.push(c);
      }
    }
    return { count, open: out.sort((a, b) => a - b) };
  }

  it("開いた後に見える枚数と開くカードが、文書をたどって数えた物と同じ（今日・今日の手・深いカード）", () => {
    const starts = [0, ...Array.from(cm.firstMoves), ...[100, 500, 1500, 3000].filter((i) => i < cm.n)];
    for (const i of starts) {
      for (const add of [3, 12, 24, 36, 99]) {
        const limit = cm.month[i]! + add;
        const r = openUntil(cm, i, limit);
        const b = brute(i, limit);
        expect(r.count, `${i} から ${add} か月`).toBe(b.count);
        expect([...r.open].sort((a, c) => a - c), `${i} から ${add} か月`).toEqual(b.open);
      }
    }
  });

  it("区切りの数は 1 回なめてまとめて数えても、区切りごとに数えた物と同じ（開くカードは押したときに数える）", () => {
    const starts = [0, ...Array.from(cm.firstMoves), ...Array.from({ length: 40 }, (_, k) => Math.floor((k * 7919) % cm.n))];
    for (const i of starts) {
      for (const x of deepHorizons(cm, i)) {
        const r = openUntil(cm, i, x.toEnd ? Infinity : x.limit);
        expect(x.count, `${i} から ${x.months} か月`).toBe(r.count);
        expect(horizonOpen(cm, i, x)).toEqual(r.open);
      }
    }
  });

  it("区切りは 1 年先・2 年先・地図の終わりで、終わりを超える区切りは 1 つにまとめる。先の無いカードには無い", () => {
    const hs = deepHorizons(cm, 0);
    expect(hs.map((h) => h.months)).toEqual([12, 24, 36]);
    expect(hs.map((h) => h.toEnd)).toEqual([false, false, true]);
    // 地図の終わりまでは、その先の全部
    expect(hs[2]!.count).toBe(cm.size[0]! - 1);
    expect(hs[0]!.count).toBeLessThan(hs[1]!.count);
    // 18 か月目の状態からは 1 年先と終わりまで（2 年先は終わりを超えるので、終わりまでの 18 か月に 1 つ）
    const deep = Array.from({ length: cm.n }, (_, i) => i).find((i) => cm.month[i] === 18 && cm.role[i] === 2 && cm.size[i]! > 1)!;
    const hd = deepHorizons(cm, deep);
    expect(hd.map((h) => h.toEnd)).toEqual([false, true]);
    expect(hd.map((h) => h.months)).toEqual([12, 18]);
    // 24 か月目からは 1 年先がもう終わり
    const late = Array.from({ length: cm.n }, (_, i) => i).find((i) => cm.month[i] === 24 && cm.role[i] === 2 && cm.size[i]! > 1)!;
    expect(deepHorizons(cm, late).map((h) => [h.months, h.toEnd])).toEqual([[12, true]]);
    // 行き先（先が無い）
    const end = Array.from({ length: cm.n }, (_, i) => i).find((i) => cm.size[i] === 1)!;
    expect(deepHorizons(cm, end)).toEqual([]);
  });
});

describe("線の札は列の間に収まる（作業メモ user-16）", () => {
  it("深さ 23 → 24（2029 年 11 月の列）の結果の線: どの拡大率・どの高さでも、札が両端のカードに重ならない", () => {
    const xa = impactColX(23);
    const xb = impactColX(24);
    for (const zoom of [0.3, 0.35, 0.45, 0.6, 0.8, 1, 1.5, 2.5]) {
      for (const dy of [0, 128, 128 * 3, 128 * 12]) {
        const g = edgeGeom(xa, 0, xb, dy);
        const k = labelScale(zoom);
        // いちばん長い文（省略される幅いっぱい）の札
        const w = labelMaxW(g, zoom) * k + LABEL_PAD * k;
        const box = edgeLabelBox(g, w, 22 * k);
        const leftCard = { x0: xa - HALF_W, x1: xa + HALF_W };
        const rightCard = { x0: xb - HALF_W, x1: xb + HALF_W };
        expect(box.x, `拡大率 ${zoom}・高さ ${dy}`).toBeGreaterThanOrEqual(leftCard.x1);
        expect(box.x + box.w, `拡大率 ${zoom}・高さ ${dy}`).toBeLessThanOrEqual(rightCard.x0);
      }
    }
    // 列の間（400 − カードの幅）は、等倍で文字 140px 以上を書ける
    expect(labelMaxW(edgeGeom(xa, 0, xb, 0), 1)).toBeGreaterThanOrEqual((400 - NODE_W - 12) / labelScale(1) - LABEL_PAD - 0.001);
  });

  it("標準の続きの長い線の札は、元のカードのすぐ右（線の始まり）に置く", () => {
    const g = edgeGeom(impactColX(5), 0, impactColX(24), 128 * 4);
    const box = edgeLabelBox(g, 120, 22, true);
    expect(box.x).toBeGreaterThanOrEqual(impactColX(5) + HALF_W);
    expect(box.x).toBeLessThan(impactColX(5) + HALF_W + 40);
  });
});

describe("3 か月ごとの地図の画面に渡す物（deepState）と月から決める列", () => {
  it("地図のカードと文書のカードの行き来・選んだ手・計算の芯の答え", () => {
    const doc = build(map);
    const { store, vm } = setup(doc);
    const ctx = vm.deep.get()!;
    expect(ctx).not.toBeNull();
    expect(ctx.map).toBe(map);
    expect(ctx.edited).toBe(false);
    // 選んだ手が無い間は、起動の前に先に描いた見取り図と同じ計算（地図と年収ごとに 1 つ）を使う
    expect(ctx.analysis()).toBe(plainAnalysis(ctx.cm, ctx.annual));
    expect(ctx.cm).toBe(compiledMapOf(map));
    for (const i of [0, 1, 50, 1000, map.n - 1]) {
      const id = ctx.idOf(i);
      expect(doc.nodes[id]).toBeDefined();
      expect(ctx.indexOf(id)).toBe(i);
    }
    // 選んだ手（今日の手の 2 つ目）・見送った手: エンジンが地図の列から読んだ物と同じ
    const pickI = cm.firstMoves[1]!;
    const dropI = cm.firstMoves[2]!;
    store.transact("選ぶ", (tx) => {
      tx.updateNode(ctx.idOf(pickI), { status: "active" });
      tx.updateNode(ctx.idOf(dropI), { status: "dropped" });
    });
    const c2 = vm.deep.get()!;
    expect(c2).not.toBe(ctx);
    const a = c2.analysis();
    const status = new Uint8Array(cm.n);
    status[pickI] = 1;
    status[dropI] = 2;
    const ref = analyze(c2.cm, c2.annual, { status });
    expect(a.vRoot).toBeCloseTo(ref.vRoot!, 9);
    expect(Array.from(a.pi.pi)).toEqual(Array.from(ref.pi.pi));
    // 地図の値と、アプリの 3 年の影響（エンジン）の今日の値が同じ
    expect(a.vRoot!).toBeCloseTo(vm.impact.vRoot!, 6);
  });

  it("形を変えた後（自分のカードを足す）も、地図の元の数で出し、選んだ手は文書から読む", () => {
    const doc = build(map);
    const { store, vm } = setup(doc);
    const c0 = vm.deep.get()!;
    const pickI = cm.firstMoves[1]!;
    store.transact("選ぶ", (tx) => tx.updateNode(c0.idOf(pickI), { status: "active" }));
    const before = vm.deep.get()!.analysis().vRoot;
    const parent = c0.idOf(pickI);
    const child = makeNode({ type: "action", title: "自分のカード" });
    store.transact("足す", (tx) => {
      tx.addNode(child);
      tx.addEdge({ id: "e_user_1", source: parent, target: child.id, relation: "leads", label: "", condition: "", scenarioIds: [], collapsed: false, meta: {}, createdAt: child.createdAt, updatedAt: child.updatedAt });
    });
    const c1 = vm.deep.get()!;
    expect(c1.edited).toBe(true);
    expect(c1.indexOf(child.id)).toBe(-1);
    expect(c1.analysis().vRoot).toBeCloseTo(before!, 9);
  });

  it("方針を選んでも数は絞らない（3 か月ごとの地図）。方針の外の手は印だけ", () => {
    const doc = build(map);
    const { ui, vm } = setup(doc);
    const v0 = vm.impact.vRoot;
    const sid = doc.scenarioOrder[0]!;
    ui.setPrefs({ scenarioId: sid });
    const imp = vm.impact;
    expect(imp.scenarioFree).toBe(true);
    expect(imp.vRoot).toBeCloseTo(v0!, 9);
    const ctx = vm.deep.get()!;
    expect(ctx.scenario).toBe(sid);
    expect(ctx.analysis().vRoot).toBeCloseTo(v0!, 6);
    // 方針の外の手がある（印だけ）
    const off = imp.decision.get(imp.root!)!.alts.filter((id) => imp.alt.get(id)!.allowed === false);
    expect(off.length).toBeGreaterThan(0);
  });

  it("選び方の道の上のまとめた手を選ぶと「この先は標準の続きの平均」", () => {
    const doc = build(map);
    const { store, vm } = setup(doc);
    const ctx = vm.deep.get()!;
    expect(ctx.pickedSummary()).toBe(false);
    // 今日のおすすめの手の先で、選び方の道の上にある判断のまとめた手（最初の物）
    const a = ctx.analysis();
    let stub = -1;
    for (let i = 0; i < cm.n && stub < 0; i++) {
      if (cm.role[i] !== ROLE_A || !(cm.flags[i]! & F_STUB)) continue;
      const d = cm.parent[i]!;
      if (a.pi.reach[d]! > 0) stub = i;
    }
    expect(stub).toBeGreaterThan(0);
    // そのまとめた手だけを選ぶと、その判断の値が下がって、上の判断はそこへ行かない（道の上ではない）
    store.transact("選ぶ", (tx) => tx.updateNode(ctx.idOf(stub), { status: "active" }));
    expect(vm.deep.get()!.pickedSummary()).toBe(false);
    // 今日からそのまとめた手までの手を全部選ぶ（その道を進むと決めた）: 道の上なので「この先は標準の続きの平均」
    store.transact("道を選ぶ", (tx) => {
      for (let j = cm.parent[stub]!; j > 0; j = cm.parent[j]!) if (cm.role[j] === ROLE_A) tx.updateNode(ctx.idOf(j), { status: "active" });
    });
    expect(vm.deep.get()!.pickedSummary()).toBe(true);
  });

  it("写しの文章は、その時の年収で組み立てた数の行と本文（地図のカードでなければ null）", () => {
    const doc = build(map);
    const { vm } = setup(doc);
    const ctx = vm.deep.get()!;
    const i = cm.firstMoves[1]!;
    expect(vm.deep.materialize(ctx.idOf(i))).toBe(materializeBody(map, i, ctx.annual));
    expect(vm.deep.materialize("n_none")).toBeNull();
    // 組み立てた本文は、カードごと・年収ごとに 1 回だけ
    const t = ctx.text();
    expect(t.body(i)).toBe(t.body(i));
    expect(t.card(i)).toBe(t.card(i));
  });

  it("月から決める列: まとめた行き先は 2029 年 11 月の列（入口から 8,400）。ほかのカードは深さの列と同じ", () => {
    const doc = build(map);
    const { vm } = setup(doc);
    const ctx = vm.deep.get()!;
    // 3 か月後のまとめた手を 1 つ開く
    let stub = -1;
    for (let i = 0; i < cm.n && stub < 0; i++) if (cm.role[i] === ROLE_A && cm.flags[i]! & F_STUB && cm.month[i] === 3) stub = i;
    expect(stub).toBeGreaterThan(0);
    vm.setImpactOpen([...vm.impactChain(ctx.idOf(stub)), ctx.idOf(stub)]);
    vm.ensure();
    const root = vm.posOf(ctx.idOf(0))!;
    for (const id of vm.drawNodes) {
      const i = ctx.indexOf(id);
      const p = vm.posOf(id)!;
      const want = map.sum(i) ? impactColX(24) : impactColX(cm.depth[i]!);
      expect(p.x - root.x, `カード ${i}（深さ ${cm.depth[i]}）`).toBe(want);
    }
    const ends = vm.drawNodes.filter((id) => map.sum(ctx.indexOf(id)));
    expect(ends.length).toBeGreaterThan(0);
  });

  it("版 6 の地図は深さの列のまま（3 か月ごとの地図の画面も出さない）", () => {
    const { pv } = buildR6Future(new Date(2026, 10, 12));
    const { vm } = setup(pv.doc);
    expect(vm.deep.get()).toBeNull();
    const root = vm.impactRoots()[0]!;
    vm.setImpactOpen(vm.impactBranches());
    vm.ensure();
    const rp = vm.posOf(root)!;
    const depth = new Map<string, number>([[root, 0]]);
    const queue = [root];
    while (queue.length) {
      const id = queue.shift()!;
      for (const eid of vm.index.out.get(id) ?? []) {
        const e = pv.doc.edges[eid]!;
        if (e.relation !== "leads" && e.relation !== "condition") continue;
        if (!depth.has(e.target)) {
          depth.set(e.target, depth.get(id)! + 1);
          queue.push(e.target);
        }
      }
    }
    for (const id of vm.drawNodes) if (vm.hasOverlay(id) && depth.has(id)) expect(vm.posOf(id)!.x - rp.x).toBe(impactColX(depth.get(id)!));
  });
});

describe("新しい地図の知らせの表（前の版 → 今の版）", () => {
  it("版 6 の今日の 10 の手の差は、凍結した写しを同じ年収で数えた値（R1 §5 の表と同じ）", () => {
    const { pv } = buildR6Future(new Date(2026, 10, 12));
    const d = todayDeltasOf(pv.doc, 360);
    // 10 の手（今のままは 0）
    expect(d.size).toBe(10);
    expect(d.get("keep")).toBe(0);
    expect(d.get("ad_permside")!).toBeCloseTo(28.3, 0);
    expect(d.get("fc_switch")!).toBeCloseTo(24.9, 0);
    expect(d.get("sd_permpro")!).toBeCloseTo(23.6, 0);
    expect(d.get("fc_scope")!).toBeCloseTo(-0.3, 0);
    expect(d.get("ind_quit")!).toBeCloseTo(-288, -1);
    // 同じ文書・同じ年収の computeImpact の差と同じ
    const root = Object.values(pv.doc.nodes).find((n) => n.meta?.forecastRoot === true)!;
    const doc: DocData = { ...pv.doc, nodes: { ...pv.doc.nodes, [root.id]: { ...root, meta: { ...root.meta, impact: { ...(root.meta.impact as object), annual: 540 } } } } };
    const imp = computeImpact(doc, buildIndex(doc).out, null);
    const d540 = todayDeltasOf(pv.doc, 540);
    for (const id of imp.decision.get(imp.root!)!.alts) {
      const ak = doc.nodes[id]!.meta.ak as string;
      const delta = imp.alt.get(id)!.delta;
      if (delta !== null && ak !== "keep") expect(d540.get(ak)!).toBeCloseTo(delta, 9);
    }
  });

  it("並びは今の版の差の順・向きが逆になった手に印（比べる元は数えない）", () => {
    const before = new Map([
      ["fc_scope", -0.3],
      ["ad_permside", 28.3],
      ["ind_quit", -288],
    ]);
    const rows = deltaTable(before, [
      { kind: "ad_permside", delta: 7.3, isBase: false },
      { kind: "fc_scope", delta: 9.7, isBase: false },
      { kind: "keep", delta: 0, isBase: true },
      { kind: "ind_quit", delta: -242, isBase: false },
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["fc_scope", "ad_permside", "keep", "ind_quit"]);
    expect(rows.find((r) => r.kind === "fc_scope")!.signChanged).toBe(true);
    expect(rows.find((r) => r.kind === "ad_permside")!.signChanged).toBe(false);
    expect(rows.find((r) => r.kind === "keep")!).toMatchObject({ before: 0, after: 0, signChanged: false, rankChanged: false });
    expect(rows.find((r) => r.kind === "fc_scope")!.rankChanged).toBe(true);
  });
});
