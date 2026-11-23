// 文書の索引（src/model/docIndex.ts）: 変わった物だけ直した索引が、いちから作った buildIndex と同じか（並びまで）。
// 足した数（ノード・線・種類・期限の幅・入口・折りたたみ・プロジェクトごとの共有）も、文書を数え直した物と同じか。
// ストアの乱数の編集（足す・消す・付け替え・関係・所属・タグ・シナリオ・期限・入口の印・プロジェクトとシナリオの増減・元に戻す・やり直す・入れ替え）で確かめる
import { describe, expect, it } from "vitest";
import { dayNumber } from "../../src/model/dates";
import { DocIndex } from "../../src/model/docIndex";
import { isImpactRoot } from "../../src/model/forks";
import { buildIndex } from "../../src/model/graph";
import { computeForecast } from "../../src/model/forecast";
import { DEFAULT_PREFS, UiState } from "../../src/app/uiState";
import { ViewModel } from "../../src/app/viewModel";
import { createEmptyDoc, makeEdge, makeNode, makeProject, makeScenario } from "../../src/model/schema";
import type { DocData, GEdge, GNode, ID, NodeType, Relation } from "../../src/model/types";
import { Store } from "../../src/store/store";
import { pick, rng, synthMap } from "./helpers/synthMap";

/** 索引と、文書を数え直した物の食い違い */
function indexDiff(ix: DocIndex, doc: DocData): string[] {
  const out: string[] = [];
  const ref = buildIndex(doc);
  const eq = (name: string, a: unknown, b: unknown) => {
    const sa = JSON.stringify(a);
    const sb = JSON.stringify(b);
    if (sa !== sb && out.length < 10) out.push(`${name}: ${sa.slice(0, 200)} ≠ ${sb.slice(0, 200)}`);
  };
  const mapEntries = (m: Map<ID, unknown>) => [...m.entries()].sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0));
  eq("out", mapEntries(ix.out), mapEntries(ref.out));
  eq("inc", mapEntries(ix.inc), mapEntries(ref.inc));
  eq("projectNodes", mapEntries(ix.projectNodes), mapEntries(ref.projectNodes));
  eq("unassigned", ix.unassigned, ref.unassigned);
  eq("tags", ix.tags, ref.tags);
  eq("cross", [...ix.cross].sort(), [...ref.cross].sort());
  eq("shared", [...ix.shared].sort(), [...ref.shared].sort());
  eq("scenarioCounts", mapEntries(ix.scenarioCounts), mapEntries(ref.scenarioCounts));
  const nodes = Object.values(doc.nodes);
  eq("nodeCount", ix.nodeCount, nodes.length);
  eq("edgeCount", ix.edgeCount, Object.keys(doc.edges).length);
  const types: Record<NodeType, number> = { goal: 0, action: 0, branch: 0, result: 0 };
  for (const n of nodes) types[n.type]++;
  eq("typeCounts", ix.typeCounts, types);
  const days = nodes.map((n) => (n.time.due ? dayNumber(n.time.due) : NaN)).filter((d) => Number.isFinite(d));
  eq("dueRange", ix.dueRange(), days.length ? { min: Math.min(...days), max: Math.max(...days) } : null);
  eq("forecastRoots", [...ix.forecastRoots].sort(), nodes.filter((n) => n.meta?.forecastRoot === true).map((n) => n.id).sort());
  eq("impactRoots", [...ix.impactRoots].sort(), nodes.filter((n) => isImpactRoot(n)).map((n) => n.id).sort());
  eq("collapsedNodes", [...ix.collapsedNodes].sort(), nodes.filter((n) => n.collapsed).map((n) => n.id).sort());
  eq("collapsedEdges", [...ix.collapsedEdges].sort(), Object.values(doc.edges).filter((e) => e.collapsed).map((e) => e.id).sort());
  const sharedIn = new Map<ID, number>();
  for (const [p, list] of ref.projectNodes) {
    const c = list.filter((id) => ref.shared.has(id)).length;
    if (c) sharedIn.set(p, c);
  }
  eq("sharedIn", mapEntries(ix.sharedIn), mapEntries(sharedIn));
  // 描く順に使うキーの順
  const keys = Object.keys(doc.nodes);
  for (let i = 1; i < keys.length; i++) if (!(ix.nodeOrder(keys[i - 1]!) < ix.nodeOrder(keys[i]!))) eq(`nodeOrder ${keys[i]}`, ix.nodeOrder(keys[i]!), ">" + ix.nodeOrder(keys[i - 1]!));
  const ekeys = Object.keys(doc.edges);
  for (let i = 1; i < ekeys.length; i++) if (!(ix.edgeOrder(ekeys[i - 1]!) < ix.edgeOrder(ekeys[i]!))) eq(`edgeOrder ${ekeys[i]}`, ix.edgeOrder(ekeys[i]!), ">" + ix.edgeOrder(ekeys[i - 1]!));
  return out;
}

const RELS: Relation[] = ["leads", "condition", "supports", "blocks", "feedback"];

function randomEdit(rand: () => number, store: Store, k: number): string {
  const doc = store.doc;
  const ids = Object.keys(doc.nodes);
  const eids = Object.keys(doc.edges);
  const pids = Object.keys(doc.projects);
  const sids = Object.keys(doc.scenarios);
  if (!sids.length) sids.push("s_missing");
  if (!pids.length) pids.push("p_missing");
  const u = rand();
  if (u < 0.1) {
    // ID は数の形（"12"。読み込みが受ける形で、オブジェクトの順の前に入る: 見直し equiv-7）のときもある
    const numeric = rand() < 0.35;
    store.transact("足す", (tx) => {
      const n = tx.addNode(makeNode({ id: numeric ? String(k) : `x${k}`, title: `足した ${k}`, tags: rand() < 0.5 ? ["仕事", "Shigoto"] : ["shigoto"], projectIds: rand() < 0.5 ? [pick(rand, pids)] : [], time: { due: rand() < 0.5 ? "2031-01-01" : null, start: null } }));
      if (ids.length) tx.addEdge(makeEdge({ id: numeric ? String(5000 + k) : `xe${k}`, source: pick(rand, ids), target: n.id, relation: pick(rand, RELS), scenarioIds: rand() < 0.3 ? [pick(rand, sids)] : [] }));
    });
    return "足す";
  }
  if (u < 0.18 && ids.length) {
    store.transact("消す", (tx) => tx.deleteNode(pick(rand, ids)));
    return "消す";
  }
  if (u < 0.28 && ids.length) {
    store.transact("つなぐ", (tx) => tx.addEdge(makeEdge({ id: `y${k}`, source: pick(rand, ids), target: pick(rand, ids), relation: pick(rand, RELS), collapsed: rand() < 0.2, scenarioIds: rand() < 0.3 ? [pick(rand, sids)] : [] })));
    return "つなぐ";
  }
  if (u < 0.36 && eids.length) {
    store.transact("線を消す", (tx) => tx.deleteEdge(pick(rand, eids)));
    return "線を消す";
  }
  if (u < 0.46 && eids.length) {
    const id = pick(rand, eids);
    const e = doc.edges[id]!;
    const patch: Partial<GEdge> = rand() < 0.3 ? { source: pick(rand, ids) } : rand() < 0.3 ? { target: pick(rand, ids) } : rand() < 0.5 ? { relation: pick(rand, RELS), collapsed: !e.collapsed } : { scenarioIds: rand() < 0.5 ? [] : [pick(rand, sids)], label: `l${k}` };
    store.transact("線を変える", (tx) => tx.updateEdge(id, patch));
    return "線を変える";
  }
  if (u < 0.66 && ids.length) {
    const id = pick(rand, ids);
    const n = doc.nodes[id]!;
    const v = rand();
    const patch: Partial<GNode> =
      v < 0.2
        ? { projectIds: rand() < 0.3 ? [] : rand() < 0.5 ? [pick(rand, pids)] : pids.slice(0, 2) }
        : v < 0.35
          ? { tags: rand() < 0.3 ? [] : [pick(rand, ["仕事", "SHIGOTO", "shigoto", "副業"]), "仕事"] }
          : v < 0.5
            ? { scenarioIds: rand() < 0.5 ? [] : [pick(rand, sids)] }
            : v < 0.6
              ? { type: pick(rand, ["goal", "action", "branch", "result"] as NodeType[]) }
              : v < 0.72
                ? { time: { due: rand() < 0.3 ? null : rand() < 0.5 ? "2020-02-02" : "2040-12-31", start: null } }
                : v < 0.82
                  ? { collapsed: !n.collapsed }
                  : v < 0.9
                    ? { meta: rand() < 0.5 ? { ...n.meta, forecastRoot: true, impact: { v: 2, horizon: 36 } } : { ...n.meta, forecastRoot: false } }
                    : { title: `${n.title}x`, x: n.x + 10 };
    store.transact("ノードを変える", (tx) => tx.updateNode(id, patch));
    return "ノードを変える";
  }
  if (u < 0.72) {
    if (rand() < 0.5) store.transact("プロジェクトを足す", (tx) => tx.addProject(makeProject({ id: `p${k}`, name: `P${k}` })));
    else if (pids.length) store.transact("プロジェクトを消す", (tx) => tx.deleteProject(pick(rand, pids)));
    return "プロジェクト";
  }
  if (u < 0.78) {
    if (rand() < 0.5) store.transact("シナリオを足す", (tx) => tx.addScenario(makeScenario({ id: `s${k}`, name: `S${k}` })));
    else if (sids.length) store.transact("シナリオを消す", (tx) => tx.deleteScenario(pick(rand, sids)));
    return "シナリオ";
  }
  if (u < 0.88) {
    store.undo();
    return "元に戻す";
  }
  if (u < 0.97) {
    store.redo();
    return "やり直す";
  }
  // 入れ替え（全部が変わる。物はどれも新しい）: ノードを 1 つ消す・題名と状態を書き換えて後ろに 1 つ足す・鍵の順を並べ替える
  const next = structuredClone(doc);
  const w = rand();
  if (w < 0.4) {
    delete next.nodes[pick(rand, Object.keys(next.nodes))];
    for (const [id, e] of Object.entries(next.edges)) if (!next.nodes[e.source] || !next.nodes[e.target]) delete next.edges[id];
  } else if (w < 0.8) {
    const ks = Object.keys(next.nodes);
    for (let j = 0; j < 3 && ks.length; j++) {
      const n = next.nodes[pick(rand, ks)]!;
      n.title += "（取り込み）";
      n.status = pick(rand, ["open", "active", "done", "dropped"] as const);
      if (rand() < 0.5) n.tags = [...n.tags, "取り込み"];
    }
    next.nodes[`r${k}`] = makeNode({ id: `r${k}`, title: `届いた ${k}`, time: { due: "2030-02-01", start: null } });
    if (ks.length) next.edges[`re${k}`] = makeEdge({ id: `re${k}`, source: pick(rand, ks), target: `r${k}`, relation: pick(rand, RELS) });
  } else {
    // 鍵の順が替わった（作り直した並びと違うので、変わった物だけでは直さない）
    const ks = Object.keys(next.nodes).reverse();
    const nodes: Record<ID, GNode> = {};
    for (const id of ks) nodes[id] = next.nodes[id]!;
    next.nodes = nodes;
  }
  store.replaceDoc(next, "入れ替え");
  return w < 0.8 ? "入れ替え" : "並べ替えた入れ替え";
}

describe("文書の索引: 変わった物だけ直しても、いちから作った物と同じ", () => {
  for (const seed of [1, 2, 3]) {
    it(`種 ${seed}: 乱数の編集 400 回の後でも buildIndex と同じ（並び・数・期限の幅・入口・折りたたみ）`, () => {
      const syn = synthMap(seed, { cards: 600, users: 40, links: 80, twoRoots: seed === 2 });
      const store = new Store(syn.doc);
      const ix = new DocIndex(store.doc);
      // 全部の入れ替え（取り込み・元に戻す）は、並びが合えば変わった物だけで直す（ViewModel と同じ: 見直し perf-4）
      let diffs = 0;
      let rebuilt = 0;
      store.on("change", (info) => {
        if (info.full) {
          const d = ix.diffDoc(store.doc);
          if (d) {
            diffs++;
            ix.rebase(store.doc, d);
            return;
          }
          rebuilt++;
        }
        ix.apply(store.doc, info);
      });
      expect(indexDiff(ix, store.doc)).toEqual([]);
      const rand = rng(seed * 104729);
      const log: string[] = [];
      for (let k = 0; k < 400; k++) {
        log.push(randomEdit(rand, store, k));
        const d = indexDiff(ix, store.doc);
        if (d.length) throw new Error(`${k} 回目（${log.slice(-4).join("・")}）の後:\n${d.join("\n")}`);
      }
      // 入れ替えと、その元に戻す・やり直すの多くは変わった物だけで直した（並べ替えた入れ替えは作り直す）
      expect(diffs).toBeGreaterThan(3);
      expect(rebuilt).toBeGreaterThanOrEqual(log.filter((x) => x === "並べ替えた入れ替え").length);
    });
  }

  it("全部の入れ替えの変わった物の一覧（diffDoc）: 物が替わった・足した・消した物だけ。並びが合わない・大きく替わったときは作り直す（見直し perf-4）", () => {
    const syn = synthMap(9, { cards: 400, users: 20, links: 30 });
    const store = new Store(syn.doc);
    const ix = new DocIndex(store.doc);
    const nodeIds = Object.keys(store.doc.nodes);
    // 中身も物も同じ（元に戻した物など）: 一覧は空
    const same = { ...store.doc, nodes: { ...store.doc.nodes }, edges: { ...store.doc.edges } };
    const d0 = ix.diffDoc(same)!;
    expect([d0.nodes.size, d0.edges.size]).toEqual([0, 0]);
    // 物を全部作り直した写し（取り込み）: 中身はどれも同じなので、変わった物は無く、どのノード・線も「物だけ新しい」
    const copy = structuredClone(store.doc);
    const dc = ix.diffDoc(copy)!;
    expect([dc.nodes.size, dc.edges.size, dc.projects.size, dc.scenarios.size]).toEqual([0, 0, 0, 0]);
    expect(dc.sameNodes.length).toBe(nodeIds.length);
    expect(dc.sameEdges.length).toBe(Object.keys(store.doc.edges).length);
    // 中身の違いは 1 つずつ見分ける（題名・タグ・meta の中の配列・位置）
    const c2 = structuredClone(store.doc);
    const [a, b, c, d] = nodeIds;
    c2.nodes[a!]!.title += "あ";
    c2.nodes[b!]!.tags = [...c2.nodes[b!]!.tags, "新しい"];
    c2.nodes[c!]!.meta = { ...c2.nodes[c!]!.meta, rr: [1, 2, 3] };
    c2.nodes[d!]!.x += 1;
    expect([...ix.diffDoc(c2)!.nodes].sort()).toEqual([a!, b!, c!, d!].sort());
    // 1 つ書き換え・1 つ消し・後ろに 1 つ足す
    const mod = { ...store.doc, nodes: { ...store.doc.nodes }, edges: { ...store.doc.edges } };
    mod.nodes[nodeIds[3]!] = { ...mod.nodes[nodeIds[3]!]!, title: "書き換え" };
    delete mod.nodes[nodeIds[5]!];
    for (const [id, e] of Object.entries(mod.edges)) if (!mod.nodes[e.source] || !mod.nodes[e.target]) delete mod.edges[id];
    mod.nodes.zz = makeNode({ id: "zz", title: "届いた" });
    const d1 = ix.diffDoc(mod)!;
    expect([...d1.nodes].sort()).toEqual([nodeIds[3]!, nodeIds[5]!, "zz"].sort());
    ix.rebase(mod, d1);
    expect(indexDiff(ix, mod)).toEqual([]);
    // 鍵の順が替わった・前からの鍵が足した鍵の後にある・数の形の鍵を足した・プロジェクトの並びが替わった・半分より多く入れ替わった
    const ix2 = () => new DocIndex(store.doc);
    const rev: DocData = { ...store.doc, nodes: Object.fromEntries(Object.entries(store.doc.nodes).reverse()) };
    expect(ix2().diffDoc(rev)).toBeNull();
    const front: DocData = { ...store.doc, nodes: { aa: makeNode({ id: "aa" }), ...store.doc.nodes } };
    expect(ix2().diffDoc(front)).toBeNull();
    const num: DocData = { ...store.doc, nodes: { ...store.doc.nodes, "77": makeNode({ id: "77" }) } };
    expect(ix2().diffDoc(num)).toBeNull();
    const porder: DocData = { ...store.doc, projectOrder: [...store.doc.projectOrder].reverse() };
    if (store.doc.projectOrder.length > 1) expect(ix2().diffDoc(porder)).toBeNull();
    const other: DocData = { ...store.doc, nodes: Object.fromEntries(nodeIds.slice(0, 150).map((id) => [id, store.doc.nodes[id]!])) };
    expect(ix2().diffDoc(other)).toBeNull();
  });

  it("数の形の ID（1・2・3）のノードを消して元に戻しても、並び（出る線・描く順）は文書の順と同じ（見直し equiv-7）", () => {
    const doc = createEmptyDoc();
    for (const id of ["1", "2", "3", "4"]) doc.nodes[id] = makeNode({ id, title: `n${id}` });
    for (const [id, a, b] of [["1", "1", "2"], ["2", "1", "3"], ["3", "3", "4"]] as const) doc.edges[id] = makeEdge({ id, source: a, target: b, relation: "leads" });
    doc.edges["10"] = makeEdge({ id: "10", source: "1", target: "4", relation: "leads" });
    const store = new Store(doc);
    const ui = new UiState(structuredClone(DEFAULT_PREFS));
    ui.persistPrefs = false;
    const vm = new ViewModel(store, ui);
    store.transact("消す", (tx) => tx.deleteNode("2"));
    store.undo();
    expect(indexDiff(vm.index, store.doc)).toEqual([]);
    expect(vm.index.out.get("1")).toEqual(buildIndex(store.doc).out.get("1"));
    vm.ensure();
    expect(vm.drawNodes).toEqual(["1", "2", "3", "4"]);
    // 線だけを消して戻す
    store.transact("線を消す", (tx) => tx.deleteEdge("1"));
    store.undo();
    expect(indexDiff(vm.index, store.doc)).toEqual([]);
    vm.ensure();
    expect(vm.drawEdges).toEqual(Object.keys(store.doc.edges).filter((e) => vm.drawEdges.includes(e)));
  });

  it("題名・本文・位置だけの編集では、形・道の線・所属の版は進まない（中身の版だけ）", () => {
    const syn = synthMap(5, { cards: 300, users: 10, links: 20 });
    const store = new Store(syn.doc);
    const ix = new DocIndex(store.doc);
    store.on("change", (info) => ix.apply(store.doc, info));
    const v0 = { ...ix.version };
    const id = syn.cards[3]!;
    store.transact("題名", (tx) => tx.updateNode(id, { title: "新しい題名", body: "本文" }));
    store.transact("位置", (tx) => tx.updateNode(syn.users[0]!, { x: 999 }));
    store.transact("状態", (tx) => tx.updateNode(id, { status: "active" }));
    const eid = Object.keys(store.doc.edges)[2]!;
    store.transact("線の文", (tx) => tx.updateEdge(eid, { label: "新しい名前", condition: "新しい条件" }));
    expect(ix.version.topo).toBe(v0.topo);
    expect(ix.version.flow).toBe(v0.flow);
    expect(ix.version.members).toBe(v0.members);
    expect(ix.version.scen).toBe(v0.scen);
    expect(ix.version.collapse).toBe(v0.collapse);
    expect(ix.version.content).toBeGreaterThan(v0.content);
    // 相乗効果の線を足すと形は進むが、道の線は進まない。道の線を足すと両方
    const v1 = { ...ix.version };
    store.transact("相乗効果", (tx) => tx.addEdge(makeEdge({ id: "sup", source: syn.users[1]!, target: id, relation: "supports" })));
    expect(ix.version.topo).toBeGreaterThan(v1.topo);
    expect(ix.version.flow).toBe(v1.flow);
    store.transact("道", (tx) => tx.addEdge(makeEdge({ id: "fl", source: id, target: syn.users[1]!, relation: "leads" })));
    expect(ix.version.flow).toBeGreaterThan(v1.flow);
    expect(indexDiff(ix, store.doc)).toEqual([]);
  });
});

// 見直し data-1: 作り直し（数の形の鍵を足した）の前に受け取った出る線・入る線は、前の文書の並びを正しく引き続ける（Map だった時と同じ）。
// 番号の表をその場で振り直すと、消したノードの穴の後ろが 1 つずつずれて、隣のノードの並びを返していた
describe("文書の索引: 作り直しの前に受け取った出る線・入る線", () => {
  it("消したノードの穴の後で作り直しても、受け取った out・inc は前と同じ並びを返す", () => {
    const doc = createEmptyDoc();
    for (const id of ["a", "b", "c", "d"]) doc.nodes[id] = makeNode({ id, title: id });
    doc.edges["ab"] = makeEdge({ id: "ab", source: "a", target: "b" });
    doc.edges["bc"] = makeEdge({ id: "bc", source: "b", target: "c" });
    doc.edges["cd"] = makeEdge({ id: "cd", source: "c", target: "d" });
    const store = new Store(doc);
    const ix = new DocIndex(store.doc);
    store.on("change", (info) => ix.apply(store.doc, info));
    store.transact("del", (tx) => tx.deleteNode("a"));
    const out = ix.out;
    const inc = ix.inc;
    const keysBefore = [...out.keys()];
    // 流れでない数の形の鍵の線を足す: apply → reorder → 同じ文書で作り直す（線は作り直しの前に今の並びへつなぐので、
    // 受け取った並びにも入る。Map だった時と同じ）
    store.transact("sup", (tx) => tx.addEdge(makeEdge({ id: "7", source: "d", target: "b", relation: "supports" })));
    expect(ix.out).not.toBe(out);
    const ref = buildIndex(store.doc);
    for (const id of ["b", "c", "d"]) {
      // 穴の後ろのノードも、隣のノードの並びでなく自分の並びを返す
      expect(out.get(id), `held out ${id}`).toEqual(ref.out.get(id));
      expect(inc.get(id), `held inc ${id}`).toEqual(ref.inc.get(id));
      expect(ix.out.get(id)).toEqual(ref.out.get(id));
      expect(ix.inc.get(id)).toEqual(ref.inc.get(id));
    }
    expect(out.get("a")).toBeUndefined();
    expect([...out.keys()]).toEqual(keysBefore);
    expect(out.size).toBe(3);
    expect(ix.out.get("a")).toBeUndefined();
  });

  it("予測を少しずつ作っている途中で数の形の鍵の支える線を足しても、予測は computeForecast と同じ", async () => {
    const doc = createEmptyDoc();
    const N = 7000;
    doc.nodes.r = makeNode({ id: "r", title: "today", meta: { forecastRoot: true } as never });
    doc.nodes.x = makeNode({ id: "x", title: "x" });
    let prev = "r";
    for (let i = 0; i < N; i++) {
      const id = `n${i}`;
      doc.nodes[id] = makeNode({ id, title: id, type: i === N - 1 ? "result" : "action" });
      doc.edges[`e${i}`] = makeEdge({ id: `e${i}`, source: prev, target: id, relation: "leads" });
      if (i % 3 === 0) {
        doc.nodes[`s${i}`] = makeNode({ id: `s${i}`, title: `s${i}`, type: "result" });
        doc.edges[`se${i}`] = makeEdge({ id: `se${i}`, source: id, target: `s${i}`, relation: "leads", meta: { prob: 0.3 } as never });
      }
      prev = id;
    }
    const store = new Store(doc);
    const ui = new UiState(structuredClone(DEFAULT_PREFS));
    ui.persistPrefs = false;
    const vm = new ViewModel(store, ui);
    store.transact("del", (tx) => tx.deleteNode("x")); // 前の方に穴
    expect(vm.forecastIfReady()).toBeNull();
    let done = false;
    vm.warmForecast(() => (done = true));
    await new Promise((r) => setTimeout(r, 5));
    store.transact("sup", (tx) => tx.addEdge(makeEdge({ id: "7", source: "n5", target: "n9", relation: "supports" })));
    for (let k = 0; k < 400 && !done; k++) await new Promise((r) => setTimeout(r, 2));
    expect(done).toBe(true);
    const ref = computeForecast(store.doc, buildIndex(store.doc).out, null);
    const pickR = (f: { reach: ReadonlyMap<ID, { p: number }> }) => [...f.reach.entries()].map(([k, v]) => [k, Math.round(v.p * 1e9)] as const).sort();
    expect(pickR(vm.forecast)).toEqual(pickR(ref));
  });
});
