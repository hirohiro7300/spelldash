// 見え方の計算の「3 年の分かれ道の範囲」と「先が木か・その大きさ」を、3 年の影響のエンジンが文書から作った形から作る道
// （src/app/viewModel.ts の scopeFromTopo・src/app/scopeSplice.ts の treeFromTopo）が、文書を幅優先にたどる今までの作り
// （下の refScope・refTree。速くする前の viewModel.ts の scopeInfo・treeInfo と同じ）と、番号・並び・値まで同じかを確かめる。
// 保存してあった地図に前の版で決めたカード（利用者のカード・線）がある起動の道（作業メモ SPEC §7.2 の起動・P4）。

import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, UiState } from "../../src/app/uiState";
import { ViewModel } from "../../src/app/viewModel";
import { treeAt, type ImpactScopeInfo, type TreeInfo } from "../../src/app/scopeSplice";
import { isFlowEdge } from "../../src/model/forks";
import { makeEdge, makeNode } from "../../src/model/schema";
import type { DocData, ID, Relation } from "../../src/model/types";
import { Store } from "../../src/store/store";
import { pick, rng, synthMap } from "./helpers/synthMap";

interface Priv {
  scopeInfo(): ImpactScopeInfo;
  treeInfo(info: ImpactScopeInfo): TreeInfo;
  scopeTopo: unknown;
  index: { out: Map<ID, ID[]>; inc: Map<ID, ID[]>; impactRoots: Set<ID> };
}

/** 速くする前の範囲の作り（入口から道の線で幅優先） */
function refScope(doc: DocData, out: Map<ID, ID[]>, impactRoots: Set<ID>): ImpactScopeInfo {
  const roots = [...impactRoots].sort();
  const pos = new Map<ID, number>();
  const order: ID[] = [];
  const rootOfL: number[] = [];
  const depthL: number[] = [];
  const parentL: number[] = [];
  const parentEdge: ID[] = [];
  roots.forEach((r, ri) => {
    if (pos.has(r)) return;
    const start = order.length;
    pos.set(r, start);
    order.push(r);
    rootOfL.push(ri);
    depthL.push(0);
    parentL.push(-1);
    parentEdge.push("");
    for (let i = start; i < order.length; i++) {
      const id = order[i]!;
      for (const eid of out.get(id) ?? []) {
        const e = doc.edges[eid];
        if (!e || !isFlowEdge(e) || e.target === id || pos.has(e.target)) continue;
        pos.set(e.target, order.length);
        order.push(e.target);
        rootOfL.push(ri);
        depthL.push(depthL[i]! + 1);
        parentL.push(i);
        parentEdge.push(e.id);
      }
    }
  });
  return { flow: 0, roots, pos, order, rootOf: Int32Array.from(rootOfL), depth: Int32Array.from(depthL), parent: Int32Array.from(parentL), parentEdge };
}

function refTree(doc: DocData, idx: { out: Map<ID, ID[]>; inc: Map<ID, ID[]> }, info: ImpactScopeInfo) {
  const n = info.order.length;
  const t = { size: new Int32Array(n), clean: new Uint8Array(n), regular: new Uint8Array(n) };
  for (let p = n - 1; p >= 0; p--) treeAt(doc, idx, info, t, p);
  return t;
}

function compare(vm: ViewModel, doc: DocData): { problems: string[]; fast: boolean } {
  const pv = vm as unknown as Priv;
  vm.ensure();
  const info = pv.scopeInfo();
  const fast = pv.scopeTopo !== null && (pv.scopeTopo as { info: unknown }).info === info;
  const tree = pv.treeInfo(info);
  const ref = refScope(doc, pv.index.out, pv.index.impactRoots);
  const rt = refTree(doc, pv.index, ref);
  const problems: string[] = [];
  const arr = (name: string, a: ArrayLike<unknown>, b: ArrayLike<unknown>) => {
    if (a.length !== b.length) return problems.push(`${name}: 長さ ${a.length} と ${b.length}`);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return problems.push(`${name}[${i}]: ${String(a[i])} と ${String(b[i])}`);
    return 0;
  };
  arr("roots", info.roots, ref.roots);
  arr("order", info.order, ref.order);
  arr("rootOf", info.rootOf, ref.rootOf);
  arr("depth", info.depth, ref.depth);
  arr("parent", info.parent, ref.parent);
  arr("parentEdge", info.parentEdge, ref.parentEdge);
  if (info.pos.size !== ref.pos.size) problems.push(`pos の数 ${info.pos.size} と ${ref.pos.size}`);
  for (const [id, p] of ref.pos) if (info.pos.get(id) !== p) problems.push(`pos(${id}) ${info.pos.get(id)} と ${p}`);
  arr("size", tree.size, rt.size);
  arr("clean", tree.clean, rt.clean);
  arr("regular", tree.regular, rt.regular);
  return { problems: problems.slice(0, 6), fast };
}

function setup(doc: DocData) {
  const store = new Store(doc);
  const ui = new UiState(structuredClone(DEFAULT_PREFS));
  ui.persistPrefs = false;
  const vm = new ViewModel(store, ui);
  vm.narrow = () => false;
  return { store, ui, vm };
}

describe("範囲と先の数をエンジンの形から作る（scopeFromTopo・treeFromTopo）", () => {
  it("保存してあった地図と同じ形（前の版で決めたカード: 地図のカードの子・道でない線・範囲の外の線）に、自分への線と入口へ戻る線: 形から作り、同じ", () => {
    const syn = synthMap(21, { cards: 2400, users: 20, links: 0 });
    const doc = syn.doc;
    const rand = rng(77);
    const card = () => pick(rand, syn.cards.filter((id) => !syn.roots.includes(id)));
    const add = (e: Parameters<typeof makeEdge>[0]) => {
      const x = makeEdge(e);
      doc.edges[x.id] = x;
    };
    // 地図のカードの子（範囲に入る自分のカード）と、その子の子
    for (const [id, rel] of [["nu1", "condition"], ["nu2", "leads"]] as const) {
      doc.nodes[id] = makeNode({ id, title: id });
      add({ id: `e_${id}`, source: card(), target: id, relation: rel });
    }
    doc.nodes.nu3 = makeNode({ id: "nu3", title: "nu3" });
    add({ id: "e_nu3", source: "nu1", target: "nu3", relation: "leads" });
    // 道でない線（範囲の中どうし・範囲の外から）・範囲の外どうしの道の線・自分への線・入口へ戻る線
    add({ id: "e_s1", source: card(), target: card(), relation: "supports" });
    add({ id: "e_s2", source: syn.users[0]!, target: card(), relation: "supports" });
    add({ id: "e_s3", source: card(), target: syn.users[1]!, relation: "blocks" });
    add({ id: "e_u1", source: syn.users[2]!, target: syn.users[3]!, relation: "leads" });
    add({ id: "e_self", source: card(), target: "", relation: "feedback" });
    doc.edges.e_self!.target = doc.edges.e_self!.source;
    add({ id: "e_back", source: card(), target: syn.roots[0]!, relation: "leads" });
    const { vm } = setup(doc);
    const r = compare(vm, doc);
    expect(r.problems.join("\n")).toBe("");
    expect(r.fast).toBe(true);
  });


  for (const seed of [11, 12, 13, 14, 15, 16]) {
    it(`種 ${seed}: 自分のカード・道でない線・自分への線・入口へ戻る線・合流・消す・元に戻すの後も、文書をたどる作りと同じ`, () => {
      // 自分の線は少なめ（合流の無い形が多く、速い道を通る回が多い）
      const syn = synthMap(seed, { cards: 1600, users: 40, links: seed % 2 ? 0 : 6 });
      const { store, vm } = setup(syn.doc);
      const rand = rng(seed * 104729);
      const rels: Relation[] = ["leads", "condition", "supports", "blocks", "feedback"];
      let fastRounds = 0;
      const problems: string[] = [];
      for (let round = 0; round < 40; round++) {
        if (round > 0) {
          const doc = store.doc;
          const ids = Object.keys(doc.nodes);
          const eids = Object.keys(doc.edges);
          const u = rand();
          const k = round;
          if (u < 0.25) {
            // 地図のカードに自分のカードを道の線で足す（範囲に入る葉）
            const id = `nu${k}`;
            const parent = pick(rand, syn.cards);
            if (doc.nodes[parent])
              store.transact("足す", (tx) => {
                tx.addNode(makeNode({ id, title: `足した ${k}` }));
                tx.addEdge(makeEdge({ id: `eu${k}`, source: parent, target: id, relation: rand() < 0.5 ? "leads" : "condition" }));
              });
          } else if (u < 0.45) {
            // 道でない線（範囲の中どうし・範囲の外から）
            const s = rand() < 0.5 ? pick(rand, syn.cards) : pick(rand, syn.users);
            const t = pick(rand, syn.cards);
            store.transact("つなぐ", (tx) => tx.addEdge(makeEdge({ id: `es${k}`, source: s, target: t, relation: pick(rand, ["supports", "blocks", "feedback"] as Relation[]) })));
          } else if (u < 0.5) {
            const s = pick(rand, syn.cards);
            store.transact("自分へ", (tx) => tx.addEdge(makeEdge({ id: `ex${k}`, source: s, target: s, relation: pick(rand, rels) })));
          } else if (u < 0.55) {
            // 入口へ戻る道の線
            const s = pick(rand, syn.cards);
            store.transact("入口へ", (tx) => tx.addEdge(makeEdge({ id: `er${k}`, source: s, target: syn.roots[0]!, relation: "leads" })));
          } else if (u < 0.57) {
            // 合流（エンジンの形は合流ありになり、文書をたどる道へ）
            const s = pick(rand, syn.cards);
            const t = pick(rand, syn.cards);
            store.transact("合流", (tx) => tx.addEdge(makeEdge({ id: `em${k}`, source: s, target: t, relation: "leads" })));
          } else if (u < 0.67 && eids.length) {
            store.transact("線を消す", (tx) => tx.deleteEdge(pick(rand, eids)));
          } else if (u < 0.75) {
            const id = pick(rand, ids);
            if (!syn.roots.includes(id)) store.transact("消す", (tx) => tx.deleteNode(id));
          } else if (u < 0.88) store.undo();
          else store.redo();
        }
        // 変更を受けた後の物（直した範囲・前の物）と、覚えた範囲を捨てて作り直した物の両方
        const r = compare(vm, store.doc);
        if (r.problems.length) problems.push(`回 ${round}${r.fast ? "（形から）" : ""}: ${r.problems.join(" / ")}`);
        const pv = vm as unknown as { scopeCache: unknown; treeCache: unknown };
        pv.scopeCache = null;
        pv.treeCache = null;
        const r2 = compare(vm, store.doc);
        if (r2.fast) fastRounds++;
        if (r2.problems.length) problems.push(`回 ${round}・作り直し${r2.fast ? "（形から）" : ""}: ${r2.problems.join(" / ")}`);
        if (problems.length > 4) break;
      }
      expect(problems.join("\n")).toBe("");
      // 速い道を通った回があること（通らなければ、この確かめは何も見ていない）
      expect(fastRounds).toBeGreaterThan(3);
    });
  }
});
