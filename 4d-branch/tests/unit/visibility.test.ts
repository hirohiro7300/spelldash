import { describe, expect, it } from "vitest";
import { buildStressDoc } from "../../src/demo/stress";
import { NODE_H, NODE_W } from "../../src/model/constants";
import { buildIndex, isCross } from "../../src/model/graph";
import { findFreeSpot } from "../../src/model/layout";
import { createEmptyDoc, makeEdge, makeNode, makeProject } from "../../src/model/schema";
import { normalizeText, parseQuery, searchNodes } from "../../src/model/search";
import type { DocData, GEdge } from "../../src/model/types";
import { computeCollapse, computePaths, computeUnreached } from "../../src/model/visibility";

/** "a>b, b>c" の形でグラフを作る。collapsed にするノードは名前の後ろに * */
function graph(spec: string, opts: { collapsedEdges?: string[]; feedback?: string[] } = {}): DocData {
  const doc = createEmptyDoc();
  const ensure = (raw: string) => {
    const name = raw.replace("*", "");
    if (!doc.nodes[name]) doc.nodes[name] = makeNode({ id: name, title: name });
    if (raw.endsWith("*")) doc.nodes[name] = { ...doc.nodes[name]!, collapsed: true };
    return name;
  };
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const ids = part.split(">").map((s) => ensure(s.trim()));
    for (let i = 0; i + 1 < ids.length; i++) {
      const id = `${ids[i]}${ids[i + 1]}`;
      doc.edges[id] = makeEdge({ id, source: ids[i]!, target: ids[i + 1]!, collapsed: opts.collapsedEdges?.includes(id) ?? false, relation: opts.feedback?.includes(id) ? "feedback" : "leads" });
    }
  }
  return doc;
}

function hiddenOf(doc: DocData, edgeOk?: (e: GEdge) => boolean): string[] {
  const index = buildIndex(doc);
  return [...computeCollapse(doc, index, new Set(Object.keys(doc.nodes)), edgeOk).hidden].sort();
}

describe("折りたたみ", () => {
  it("木: 折りたたんだノードの下流が隠れ、件数が出る", () => {
    const doc = graph("r>a*>b>c, a>d");
    const index = buildIndex(doc);
    const res = computeCollapse(doc, index, new Set(Object.keys(doc.nodes)));
    expect([...res.hidden].sort()).toEqual(["b", "c", "d"]);
    expect(res.counts.get("a")).toBe(3);
  });

  it("合流: 別の親が見えていれば合流先は消えない（その先も）", () => {
    expect(hiddenOf(graph("r>p1*>m>x, r>p2>m, p1>only"))).toEqual(["only"]);
  });

  it("循環: 自分の下流から戻ってきても、折りたたんだノード自身は消えない", () => {
    expect(hiddenOf(graph("r>a*>b>a"))).toEqual(["b"]);
  });

  it("入口の無い循環だけのかたまりでも、折りたたんだノードは残る", () => {
    expect(hiddenOf(graph("a*>b>c>a"))).toEqual(["b", "c"]);
  });

  it("循環の中で 2 つ折りたたんでも、両方とも残る", () => {
    expect(hiddenOf(graph("a*>b>c*>d>a"))).toEqual(["b", "d"]);
  });

  it("フィードバックの線だけが入るノードは根: 循環の途中を折りたたんでも、根と横の枝は消えない", () => {
    // 記事を書く(a) → アクセス(b) → 読者の声(c) —フィードバック→ a、a → d → e、b → g
    const doc = graph("a>b*>c>a, a>d>e, b>g", { feedback: ["ca"] });
    const res = computeCollapse(doc, buildIndex(doc), new Set(Object.keys(doc.nodes)));
    expect([...res.hidden].sort()).toEqual(["c", "g"]);
    expect(res.counts.get("b")).toBe(2);
  });

  it("どのノードにもフィードバックが戻ってくる地図でも、1 つの目標を折りたたむとその下だけが隠れる", () => {
    const doc = graph("g1>a1>b1>g1, g2>a2>b2>g2, b1>a2", { feedback: ["b1g1", "b2g2"] });
    doc.nodes.g1 = { ...doc.nodes.g1!, collapsed: true };
    expect(hiddenOf(doc)).toEqual(["a1", "b1"]);
  });

  it("件数は、開くと出てくる物だけ（別の道で見えている物・隠れた起点は数えない）", () => {
    const merge = graph("r>p1*>m, r>p2>m, m>x*>y");
    const res = computeCollapse(merge, buildIndex(merge), new Set(Object.keys(merge.nodes)));
    expect([...res.hidden]).toEqual(["y"]);
    expect(res.counts.get("p1")).toBe(0);
    expect(res.counts.get("x")).toBe(1);
    const chain = graph("r>a*>b*>c");
    const res2 = computeCollapse(chain, buildIndex(chain), new Set(Object.keys(chain.nodes)));
    expect([...res2.hidden].sort()).toEqual(["b", "c"]);
    expect(res2.counts.get("a")).toBe(2);
    expect(res2.counts.has("b")).toBe(false);
  });

  it("全部を折りたたんでも速い（5,000 ノード）", () => {
    const doc = buildStressDoc(5000);
    for (const id of Object.keys(doc.nodes)) doc.nodes[id] = { ...doc.nodes[id]!, collapsed: true };
    const index = buildIndex(doc);
    const t0 = performance.now();
    computeCollapse(doc, index, new Set(Object.keys(doc.nodes)));
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it("接続線の折りたたみ: その線の先だけ隠れる", () => {
    expect(hiddenOf(graph("r>a>b>c, a>d", { collapsedEdges: ["ab"] }))).toEqual(["b", "c"]);
  });

  it("入る線の無いノードは、上流が折りたたまれていても消えない", () => {
    expect(hiddenOf(graph("r>a*>b, x>b"))).toEqual([]);
  });

  it("数に入れない接続（シナリオで隠すなど）は無いものとして計算する", () => {
    const doc = graph("r>a*>b, r>c>b");
    // c>b を外すと b は a からしか届かない
    expect(hiddenOf(doc, (e) => e.id !== "cb")).toEqual(["b"]);
  });

  it("2,000 ノード・3,000 接続でも速い", () => {
    const doc = createEmptyDoc();
    const N = 2000;
    for (let i = 0; i < N; i++) doc.nodes[`n${i}`] = makeNode({ id: `n${i}`, collapsed: i % 97 === 0 });
    let k = 0;
    for (let i = 1; i < N; i++) {
      const src = `n${Math.floor((i - 1) / 2)}`;
      doc.edges[`e${k}`] = makeEdge({ id: `e${k++}`, source: src, target: `n${i}` });
      if (i % 2 === 0 && i + 7 < N) doc.edges[`e${k}`] = makeEdge({ id: `e${k++}`, source: `n${i}`, target: `n${(i * 7) % N}` });
    }
    const index = buildIndex(doc);
    const t0 = performance.now();
    computeCollapse(doc, index, new Set(Object.keys(doc.nodes)));
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe("経路", () => {
  it("上流と下流をたどり、循環でも止まる", () => {
    const doc = graph("x>a>b>c>a, b>d, y>z");
    const index = buildIndex(doc);
    const p = computePaths(doc, index, ["b"]);
    expect([...p.nodes].sort()).toEqual(["a", "b", "c", "d", "x"]);
    expect(p.edges.has("yz")).toBe(false);
  });
});

describe("交差リンク・共有ノード", () => {
  it("共通のプロジェクトが無い接続だけが交差リンク", () => {
    const doc = createEmptyDoc();
    const p1 = makeProject({ name: "1" });
    const p2 = makeProject({ name: "2" });
    doc.projects[p1.id] = p1;
    doc.projects[p2.id] = p2;
    doc.projectOrder = [p1.id, p2.id];
    const a = makeNode({ projectIds: [p1.id] });
    const b = makeNode({ projectIds: [p2.id] });
    const s = makeNode({ projectIds: [p1.id, p2.id] });
    expect(isCross(a, b)).toBe(true);
    expect(isCross(a, s)).toBe(false);
    for (const n of [a, b, s]) doc.nodes[n.id] = n;
    const e1 = makeEdge({ source: a.id, target: b.id });
    const e2 = makeEdge({ source: s.id, target: b.id });
    doc.edges[e1.id] = e1;
    doc.edges[e2.id] = e2;
    const index = buildIndex(doc);
    expect([...index.cross]).toEqual([e1.id]);
    expect([...index.shared]).toEqual([s.id]);
    expect(index.projectNodes.get(p1.id)).toEqual([a.id, s.id]);
  });
});

describe("検索", () => {
  it("全角半角・カタカナひらがな・大文字小文字を無視し、#タグで絞る", () => {
    expect(normalizeText("ＳｐｅｌｌＤａｓｈ　コウコク")).toBe("spelldash こうこく");
    const doc = createEmptyDoc();
    const a = makeNode({ title: "広告運用を学ぶ", tags: ["スキル"] });
    const b = makeNode({ title: "SEO記事", body: "こうこくに頼らない" });
    doc.nodes[a.id] = a;
    doc.nodes[b.id] = b;
    expect(searchNodes(doc, parseQuery("広告")).map((r) => r.id)).toEqual([a.id]);
    expect(searchNodes(doc, parseQuery("コウコク")).map((r) => r.id)).toEqual([b.id]);
    expect(searchNodes(doc, parseQuery("seo")).map((r) => r.id)).toEqual([b.id]);
    expect(searchNodes(doc, parseQuery("#すき")).map((r) => r.id)).toEqual([a.id]);
    expect(searchNodes(doc, parseQuery("#スキル 広告")).map((r) => r.id)).toEqual([a.id]);
    expect(searchNodes(doc, parseQuery("#スキル SEO"))).toEqual([]);
  });
});

describe("新しいノードの置き場所", () => {
  it("縦に詰まった列でも、ほかのノードに重ねない", () => {
    const doc = createEmptyDoc();
    // 4 列 × 60 段のすき間の無い壁
    for (let c = 0; c < 4; c++) for (let r = 0; r < 60; r++) doc.nodes[`w${c}-${r}`] = makeNode({ id: `w${c}-${r}`, x: c * 240, y: r * 110 - 3300 });
    const spot = findFreeSpot(doc, 0, 0);
    const clash = Object.values(doc.nodes).filter((n) => Math.abs(n.x - spot.x) < NODE_W + 28 && Math.abs(n.y - spot.y) < NODE_H + 22);
    expect(clash).toEqual([]);
  });
});

describe("検索とプロジェクト名", () => {
  it("プロジェクトの名前を変えたら、新しい名前で見つかり、古い名前では見つからない", () => {
    const doc = createEmptyDoc();
    const p = makeProject({ name: "FCマーケ" });
    doc.projects[p.id] = p;
    doc.projectOrder.push(p.id);
    doc.nodes.a = makeNode({ id: "a", title: "週次レポート", projectIds: [p.id] });
    expect(searchNodes(doc, parseQuery("FCマーケ")).map((x) => x.id)).toEqual(["a"]);
    doc.projects[p.id] = { ...p, name: "広告支援" };
    expect(searchNodes(doc, parseQuery("広告支援")).map((x) => x.id)).toEqual(["a"]);
    expect(searchNodes(doc, parseQuery("FCマーケ"))).toEqual([]);
  });
});

describe("シナリオの推定（選ばれなかった分岐の先）", () => {
  it("そのシナリオに入らない線だけで届くノードとその先は対象外、合流先は残る", async () => {
    const doc = graph("r>b>x>y, b>z>m, r>m");
    const index = buildIndex(doc);
    // b>x と b>z がシナリオ外 → x, y, z は届かない。m は r から届く
    const res = computeUnreached(doc, index, new Set(Object.keys(doc.nodes)), (e) => e.id !== "bx" && e.id !== "bz");
    expect([...res].sort()).toEqual(["x", "y", "z"]);
  });

  it("フィードバックで戻る循環でも、根からの道はシナリオに残る", () => {
    const doc = graph("a>b>c>a, a>d>e, b>g", { feedback: ["ca"] });
    const res = computeUnreached(doc, buildIndex(doc), new Set(Object.keys(doc.nodes)), (e) => e.id !== "bc");
    expect([...res]).toEqual(["c"]);
  });
});
