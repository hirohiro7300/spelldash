// 検索の索引（src/model/searchIndex.ts）: 文字の表から探した上の 50 件と数が、全部のノードの点数を出して並べた物
// （helpers/refView.ts の refSearch）と同じか。題名が全部違う大きな地図（上に入る題名を山で選ぶ道）、タグ、プロジェクトの名前の変更、
// 線の結果の名前・判断の文の変更、ノードの増減でも
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, UiState } from "../../src/app/uiState";
import { ViewModel } from "../../src/app/viewModel";
import { buildIndex } from "../../src/model/graph";
import { createEmptyDoc, makeEdge, makeNode, makeProject } from "../../src/model/schema";
import { parseQuery } from "../../src/model/search";
import { SearchIndex } from "../../src/model/searchIndex";
import type { DocData, ID } from "../../src/model/types";
import { Store } from "../../src/store/store";
import { refSearch } from "./helpers/refView";
import { pick, rng } from "./helpers/synthMap";

const KANA = ["あ", "い", "う", "か", "き", "さ", "し", "た", "て", "な", "は", "ま", "や", "ら", "わ", "ア", "カ", "サ", "ガ", "パ", "ｶ", "Ａ", "b", "C"];

function bigDoc(seed: number, n: number): DocData {
  const rand = rng(seed);
  const doc = createEmptyDoc();
  for (const [id, name] of [
    ["p1", "仕事"],
    ["p2", "SpellDash"],
  ] as const) {
    doc.projects[id] = makeProject({ id, name });
    doc.projectOrder.push(id);
  }
  let prev: ID | null = null;
  for (let i = 0; i < n; i++) {
    let t = "";
    const len = 2 + Math.floor(rand() * 5);
    for (let k = 0; k < len; k++) t += pick(rand, KANA);
    const id = `n${i}`;
    doc.nodes[id] = makeNode({
      id,
      type: rand() < 0.1 ? "goal" : "action",
      // 題名はほとんど違う（同じ題名もいくつか）
      title: rand() < 0.05 ? "同じ題名" : `${t}${i}`,
      body: rand() < 0.1 ? `本文 ${pick(rand, KANA)}` : "",
      tags: rand() < 0.3 ? [pick(rand, ["仕事", "Shigoto", "副業"])] : [],
      projectIds: rand() < 0.5 ? [pick(rand, ["p1", "p2"])] : [],
      meta: rand() < 0.2 ? { short: `ひとこと${pick(rand, KANA)}` } : {},
    });
    if (prev && rand() < 0.7) {
      const e = makeEdge({ id: `e${i}`, source: prev, target: id, relation: "condition", label: rand() < 0.3 ? `結果${pick(rand, KANA)}` : "", condition: rand() < 0.2 ? `判断の文${pick(rand, KANA)}` : "" });
      doc.edges[e.id] = e;
    }
    prev = id;
  }
  return doc;
}

function check(si: SearchIndex, doc: DocData, raw: string): void {
  const q = parseQuery(raw);
  const res = si.query(q, doc);
  const ref = refSearch(doc, buildIndex(doc), q);
  expect(res.count, raw).toBe(ref.length);
  expect(res.hits, raw).toEqual(ref.slice(0, 50));
  const hit = new Set(ref.map((h) => h.id));
  for (const id of Object.keys(doc.nodes).slice(0, 400)) expect(res.has(id), `${raw} ${id}`).toBe(hit.has(id));
}

describe("検索の索引: 全部の点数を出して並べた物と同じ", () => {
  it("題名がほとんど違う 6,000 枚（上に入る題名を山で選ぶ）・1 文字の言葉・2 語・タグ・本文・ひとこと・線の文", () => {
    const doc = bigDoc(1, 6000);
    const si = new SearchIndex(doc, buildIndex(doc));
    for (const raw of ["あ", "か", "カ", "ｶ", "a", "Ａ", "b c", "同じ", "本文", "ひとこと", "結果", "判断の文", "#仕事", "#shigoto", "#仕 あ", "仕事", "spelldash", "行動", "未着手", "存在しない", "1", "12", "0"]) check(si, doc, raw);
  });

  it("ノード・線・プロジェクトの名前が変わったら、変わった物だけ直して同じ答え（同じ言葉と中身なら前の答えを使う）", () => {
    const doc = bigDoc(2, 1500);
    const idx = buildIndex(doc);
    const si = new SearchIndex(doc, idx);
    const q = parseQuery("か");
    const r1 = si.query(q, doc);
    expect(si.query(q, doc)).toBe(r1);
    // 題名を変える
    doc.nodes.n5 = { ...doc.nodes.n5!, title: "かかか" };
    si.update(doc, idx, ["n5"]);
    check(si, doc, "か");
    // 線の結果の名前（先のノードを直す）
    const e = doc.edges.e7!;
    doc.edges.e7 = { ...e, label: "まったく新しい結果" };
    si.update(doc, buildIndex(doc), [e.target]);
    check(si, doc, "まったく新しい");
    // ノードを消す・足す
    delete doc.nodes.n9;
    for (const [id, x] of Object.entries(doc.edges)) if (x.source === "n9" || x.target === "n9") delete doc.edges[id];
    doc.nodes.nz = makeNode({ id: "nz", title: "かきくけこ" });
    si.update(doc, buildIndex(doc), ["n9", "nz"]);
    check(si, doc, "か");
    // プロジェクトの名前
    doc.projects.p1 = { ...doc.projects.p1!, name: "新しい名前" };
    si.touch();
    check(si, doc, "新しい名前");
    check(si, doc, "仕事");
  });

  it("空いた時間に 2,000 枚ずつ作る（見直し perf-8）: 作っている途中の題名の変更・まだ入れていないカードの変更・カードを足す・途中で探すでも同じ答え", async () => {
    const doc = bigDoc(3, 7000);
    const store = new Store(doc);
    const ui = new UiState(structuredClone(DEFAULT_PREFS));
    ui.persistPrefs = false;
    const vm = new ViewModel(store, ui);
    const internal = vm as unknown as { search: SearchIndex | null; searchBuild: { pos: number; ids: ID[] } | null };
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const ref = (raw: string) => refSearch(store.doc, buildIndex(store.doc), parseQuery(raw));
    const same = (raw: string) => {
      ui.setSearch(raw);
      vm.ensure();
      const want = ref(raw);
      expect([raw, vm.searchCount]).toEqual([raw, want.length]);
      expect(vm.searchHits.map((h) => h.id)).toEqual(want.slice(0, 50).map((h) => h.id));
    };
    // 1) 作り始めて 1 歩進んだ所で、入れたカードの題名と、まだ入れていないカードの題名を変える
    vm.warmSearch();
    expect(internal.search).toBeNull();
    await tick();
    const b = internal.searchBuild!;
    expect(b.pos).toBe(2000);
    store.transact("題名", (tx) => tx.updateNode("n5", { title: "かかかかか" }));
    store.transact("題名", (tx) => tx.updateNode("n6500", { title: "かかかかき" }));
    expect(internal.searchBuild).toBe(b);
    for (let k = 0; k < 10 && internal.searchBuild; k++) await tick();
    expect(internal.search).not.toBeNull();
    same("かかかか");
    same("か");
    // 2) 作り直しの途中でカードを足す: 作り直す（足したカードも当たる）
    internal.search = null;
    vm.warmSearch();
    await tick();
    store.transact("足す", (tx) => tx.addNode(makeNode({ id: "nz", title: "かかかかく" })));
    expect(internal.searchBuild).toBeNull();
    for (let k = 0; k < 40 && !internal.search; k++) await new Promise((r) => setTimeout(r, 5));
    same("かかかか");
    // 3) 作っている途中で探す: 残りをその場で作って同じ答え
    internal.search = null;
    vm.warmSearch();
    await tick();
    expect(internal.searchBuild!.pos).toBeLessThan(7001);
    same("さ");
    expect(internal.searchBuild).toBeNull();
  });
});
