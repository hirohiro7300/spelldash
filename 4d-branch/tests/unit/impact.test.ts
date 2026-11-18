import { describe, expect, it } from "vitest";
import { computeForecast } from "../../src/model/forecast";
import { chanceWeights, forkKindOf, impactScope, primaryImpactRoot } from "../../src/model/forks";
import { buildIndex } from "../../src/model/graph";
import { computeImpact, type ImpactResult } from "../../src/model/impact";
import { formatMan, formatMonthlyDelta, impactBin } from "../../src/model/impactFormat";
import { createEmptyDoc, makeEdge, makeNode } from "../../src/model/schema";
import type { DocData, GEdge, GNode, NodeType } from "../../src/model/types";

type R3 = [number, number, number];

/** 判断 → 選択肢 → 結果 の小さな木を作る */
function tree(opts: { annual?: number; tail?: number } = {}) {
  const doc = createEmptyDoc();
  const node = (id: string, type: NodeType, meta: Record<string, unknown> = {}, extra: Partial<GNode> = {}) => {
    doc.nodes[id] = makeNode({ id, title: id, type, meta, ...extra });
    return id;
  };
  const edge = (source: string, target: string, opt: { prob?: number; r?: R3; scen?: string[] } = {}): GEdge => {
    const e = makeEdge({ id: `${source}-${target}`, source, target, relation: opt.prob !== undefined ? "condition" : "leads", scenarioIds: opt.scen ?? [] });
    e.meta = { ...(opt.prob !== undefined ? { prob: opt.prob } : {}), ...(opt.r ? { r: opt.r } : {}) };
    doc.edges[e.id] = e;
    return e;
  };
  const impact: Record<string, unknown> = { v: 2, horizon: 36 };
  if (opts.annual !== undefined) impact.annual = opts.annual;
  if (opts.tail !== undefined) impact.tail = opts.tail;
  node("R", "goal", { forecastRoot: true, impact, fork: "decision", m: 0, rr: [1, 0, 0] });
  // 今のまま: 36 か月ずっと給与
  node("K", "action", { fork: "chance", m: 0, base: true, ak: "keep", fam: "keep", rank: 3 });
  node("K1", "result", { m: 36, rr: [1, 0, 0] });
  edge("R", "K");
  edge("K", "K1", { prob: 100, r: [36, 0, 0] });
  // 副業: 60% で +50、40% で −30
  node("A", "action", { fork: "chance", m: 0, ak: "side", fam: "side", rank: 1 });
  node("A1", "result", { m: 36, rr: [1, 2, 0] });
  node("A2", "result", { m: 36, rr: [1, -1, 0] });
  edge("R", "A", { scen: ["s1"] });
  edge("A", "A1", { prob: 60, r: [36, 50, 0] });
  edge("A", "A2", { prob: 40, r: [36, -30, 0] });
  // 週 4 日: 給与 30 か月分 + 事業 120
  node("B", "action", { fork: "chance", m: 0, ak: "part", fam: "part", rank: 2 });
  node("B1", "result", { m: 36, rr: [0.8, 3, 0] });
  edge("R", "B", { scen: ["s2"] });
  edge("B", "B1", { prob: 100, r: [30, 120, 0] });
  doc.scenarios.s1 = { id: "s1", name: "s1", color: "#fff", description: "", createdAt: "", updatedAt: "", meta: {} };
  doc.scenarios.s2 = { id: "s2", name: "s2", color: "#fff", description: "", createdAt: "", updatedAt: "", meta: {} };
  doc.scenarioOrder = ["s1", "s2"];
  return { doc, node, edge };
}

function run(doc: DocData, scen: string | null = null): ImpactResult {
  const idx = buildIndex(doc);
  return computeImpact(doc, idx.out, computeForecast(doc, idx.out, scen), scen);
}

describe("分かれ道の種類", () => {
  it("meta.fork が無ければ形で決める", () => {
    const e = (prob?: number) => {
      const x = makeEdge({ source: "a", target: "b" });
      if (prob !== undefined) x.meta = { prob };
      return x;
    };
    expect(forkKindOf(makeNode({ type: "goal" }), [])).toBe("leaf");
    expect(forkKindOf(makeNode({ type: "goal" }), [e(), e()])).toBe("decision");
    expect(forkKindOf(makeNode({ type: "branch" }), [e(), e()])).toBe("decision");
    expect(forkKindOf(makeNode({ type: "action" }), [e(), e()])).toBe("chance");
    expect(forkKindOf(makeNode({ type: "branch" }), [e(30), e()])).toBe("chance");
    expect(forkKindOf(makeNode({ type: "action" }), [e()])).toBe("pass");
    expect(forkKindOf(makeNode({ type: "action", meta: { fork: "decision" } }), [e(30), e(70)])).toBe("decision");
    expect(forkKindOf(makeNode({ type: "goal", meta: { fork: "chance" } }), [e(), e()])).toBe("chance");
  });

  it("結果の割合は % の無い線に残りを等分し、どれにも無ければ等分", () => {
    const e = (prob?: number) => {
      const x = makeEdge({ source: "a", target: "b" });
      if (prob !== undefined) x.meta = { prob };
      return x;
    };
    expect(chanceWeights([e(30), e(), e()])).toEqual([0.3, 0.35, 0.35]);
    expect(chanceWeights([e(), e()])).toEqual([0.5, 0.5]);
    const w = chanceWeights([e(50), e(100)]);
    expect(w[0]).toBeCloseTo(1 / 3);
  });

  it("範囲は v2 の入口からたどれるノードだけ", () => {
    const { doc, node, edge } = tree();
    node("Z", "action");
    node("Y", "action");
    edge("Z", "Y");
    const s = impactScope(doc, buildIndex(doc).out);
    expect(s.has("R") && s.has("A1") && s.has("B1")).toBe(true);
    expect(s.has("Z")).toBe(false);
  });
});

describe("見込み（範囲の中の流し方）", () => {
  it("行動の結果は % で分け、判断はそのまま渡す", () => {
    const { doc } = tree();
    const fc = computeForecast(doc, buildIndex(doc).out);
    expect(fc.reach.get("A")!.p).toBe(1);
    expect(fc.reach.get("B")!.p).toBe(1);
    expect(fc.reach.get("A1")!.p).toBeCloseTo(0.6);
    expect(fc.reach.get("A2")!.p).toBeCloseTo(0.4);
    expect(fc.order[0]).toBe("R");
    expect(fc.impactScope.size).toBe(8);
  });

  it("v1 の入口（impact なし）では今までどおり行動は分けない", () => {
    const { doc } = tree();
    delete doc.nodes.R!.meta.impact;
    const fc = computeForecast(doc, buildIndex(doc).out);
    expect(fc.impactScope.size).toBe(0);
    expect(fc.reach.get("A1")!.p).toBe(1);
  });

  it("シナリオで絞るのは判断から出る線だけ", () => {
    const { doc } = tree();
    doc.edges["A-A1"]!.scenarioIds = ["s2"];
    const fc = computeForecast(doc, buildIndex(doc).out, "s1");
    expect(fc.reach.has("B")).toBe(false);
    expect(fc.reach.get("A1")!.p).toBeCloseTo(0.6);
  });
});

describe("3 年の影響", () => {
  it("今のままとの差・おすすめ・悪くなる見込み", () => {
    const { doc } = tree({ annual: 360 });
    const r = run(doc);
    expect(r.active).toBe(true);
    expect(r.S).toBe(30);
    expect(r.annualSet).toBe(true);
    // K: 36×30 = 1080、A: 1080 + 0.6×50 − 0.4×30 = 1098、B: 900 + 120 = 1020
    expect(r.value.get("K")).toBeCloseTo(1080);
    expect(r.value.get("A")).toBeCloseTo(1098);
    expect(r.value.get("B")).toBeCloseTo(1020);
    expect(r.vRoot).toBeCloseTo(1098);
    expect(r.vSQ).toBeCloseTo(1080);
    const a = r.alt.get("A")!;
    expect(a.delta).toBeCloseTo(18);
    expect(a.deltaV![0]).toBeCloseTo(0);
    expect(a.deltaV![1]).toBeCloseTo(18);
    expect(a.mark).toBe("star");
    expect(a.pBad).toBeCloseTo(0.4);
    expect(a.worst).toBeCloseTo(-30);
    expect(a.outcomes.map((o) => [o.node, Math.round(o.w * 100), o.u])).toEqual([
      ["A1", 60, 50],
      ["A2", 40, -30],
    ]);
    // 結果の差の重み付き平均 = 手の差
    expect(a.outcomes.reduce((s, o) => s + o.w * o.u!, 0)).toBeCloseTo(a.delta!);
    expect(r.alt.get("K")!.delta).toBe(0);
    expect(r.alt.get("K")!.isBase).toBe(true);
    expect(r.alt.get("K")!.pBad).toBeNull();
    expect(r.alt.get("B")!.delta).toBeCloseTo(-60);
    expect(r.alt.get("B")!.dR).toBeCloseTo(0.8 * 30 + 3 - 30);
    const d = r.decision.get("R")!;
    expect(d.alts).toEqual(["A", "B", "K"]);
    expect(d.best).toBe("A");
    expect(d.chosen).toBe("A");
    expect(d.base).toBe("K");
    expect(d.stakes).toBeCloseTo(18);
    expect(d.spread![0]).toBeCloseTo(-60);
    expect(d.spread![1]).toBeCloseTo(18);
    expect(r.outcome.get("A2")!.alt).toBe("A");
    expect(r.counts).toEqual({ nodes: 8, decisions: 1, options: 3, forks: 2, ends: 4 });
  });

  it("行き先の見込みの合計は 1、入口の値は行き先の合計の平均と同じ", () => {
    const { doc } = tree({ annual: 360 });
    const r = run(doc);
    const total = r.ends.reduce((s, e) => s + e.p, 0);
    expect(total).toBeCloseTo(1);
    expect(r.ends.reduce((s, e) => s + e.p * e.tot, 0)).toBeCloseTo(r.vRoot!);
    expect(r.ends[0]!.id).toBe("A1");
    expect(r.dist!.mean).toBeCloseTo(1098);
    expect(r.dist!.pWorse).toBeCloseTo(0.4);
    expect(r.dist!.bins.reduce((s, x) => s + x, 0)).toBeCloseTo(1);
    expect(r.dist!.sqBins[4]).toBeCloseTo(1);
    expect(r.piEdges.has("R-A") && r.piEdges.has("A-A1") && !r.piEdges.has("R-B")).toBe(true);
  });

  it("自分で選んだ手で計算し、★ は一番良い手のまま", () => {
    const { doc } = tree({ annual: 360 });
    doc.nodes.B!.status = "active";
    const r = run(doc);
    expect(r.hasPicks).toBe(true);
    expect(r.decision.get("R")!.chosen).toBe("B");
    expect(r.vRoot).toBeCloseTo(1020);
    expect(r.alt.get("A")!.mark).toBe("star");
    expect(r.pPi.get("B1")).toBeCloseTo(1);
  });

  it("見送った手は選ばない（全部見送ったら全部から選ぶ）", () => {
    const { doc } = tree({ annual: 360 });
    doc.nodes.A!.status = "dropped";
    let r = run(doc);
    expect(r.decision.get("R")!.chosen).toBe("K");
    expect(r.alt.get("K")!.mark).toBe("star");
    expect(r.alt.get("A")!.dropped).toBe(true);
    doc.nodes.B!.status = "dropped";
    doc.nodes.K!.status = "dropped";
    r = run(doc);
    expect(r.decision.get("R")!.chosen).toBe("A");
  });

  it("シナリオ（方針）は選べる手を絞るが、外れた手の差も出す", () => {
    const { doc } = tree({ annual: 360 });
    const r = run(doc, "s2");
    expect(r.decision.get("R")!.chosen).toBe("K");
    expect(r.vRoot).toBeCloseTo(1080);
    expect(r.alt.get("A")!.allowed).toBe(false);
    expect(r.alt.get("A")!.delta).toBeCloseTo(18);
    expect(r.alt.get("K")!.mark).toBe("star");
  });

  it("年収が無ければ仮の 360 万円。年収で値が線形に変わる", () => {
    const { doc } = tree();
    const r = run(doc);
    expect(r.annualSet).toBe(false);
    expect(r.annual).toBe(360);
    const r2 = run(tree({ annual: 480 }).doc);
    expect(r2.value.get("K")).toBeCloseTo(36 * 40);
  });

  it("年収で今日の一番が入れ替わる所を見つける", () => {
    const { doc } = tree({ annual: 360 });
    const f = run(doc).salaryFlips();
    // A − B = 6S − 102 → S = 17（年収 204 万円）より下なら B
    expect(f.above).toBeNull();
    expect(f.below!.alt).toBe("B");
    expect(f.below!.annual).toBe(200);
  });

  it("その種類の手をずっとやらない場合との差", () => {
    const { doc } = tree({ annual: 360 });
    const r = run(doc);
    const nv = r.never("side");
    expect(nv.k).toBeCloseTo(18);
    expect(nv.card.get("A")).toBeCloseTo(18);
    expect(r.never("part").k).toBeCloseTo(0);
    expect(r.families().sort()).toEqual(["part", "side"]);
  });

  it("自分で足した、先も月の稼ぎも無い手は「数字なし」。一番良い手・★ にしない（選んだときだけ数える）", () => {
    const { doc, node, edge } = tree({ annual: 360, tail: 12 });
    node("X", "action", { rank: 9 });
    edge("R", "X");
    let r = run(doc);
    expect(r.alt.get("X")!.delta).toBeNull();
    expect(r.alt.get("X")!.mark).toBeNull();
    expect(r.decision.get("R")!.best).toBe("A");
    doc.nodes.X!.status = "active";
    r = run(doc);
    expect(r.decision.get("R")!.chosen).toBe("X");
    expect(r.alt.get("X")!.delta).toBeNull();
  });

  it("36 か月より前に終わる行き先は、その月の稼ぎで 36 か月目まで埋める。その後の月も足せる", () => {
    const { doc, node, edge } = tree({ annual: 360, tail: 12 });
    node("X", "action", { rank: 9, rr: [1, 0, 0] });
    edge("R", "X");
    const r = run(doc);
    // X は入口の月の稼ぎ（月給 1 倍）を受け継ぎ、36 + 12 か月分
    expect(r.value.get("X")).toBeCloseTo(30 * 48);
    // 生成した行き先（36 か月目）は 12 か月分だけ足す
    expect(r.value.get("K1")).toBeCloseTo(30 * 12);
    expect(r.alt.get("X")!.delta).toBeCloseTo(30 * 48 - (1080 + 360));
  });

  it("基準が無い判断では差を出さない。循環があっても止まらない", () => {
    const { doc, node, edge } = tree({ annual: 360 });
    delete doc.nodes.K!.meta.base;
    node("C1", "action");
    node("C2", "action");
    edge("A2", "C1");
    edge("C1", "C2");
    edge("C2", "C1");
    const r = run(doc);
    expect(r.alt.get("A")!.delta).toBeNull();
    expect(r.alt.get("A")!.bin).toBe(0);
    expect(r.value.has("C1")).toBe(false);
    expect(r.partial.has("A")).toBe(true);
  });

  it("判断の線の % は使わない", () => {
    const { doc } = tree({ annual: 360 });
    doc.edges["R-B"]!.meta = { prob: 90 };
    const r = run(doc);
    expect(r.decision.get("R")!.chosen).toBe("A");
    expect(r.alt.get("B")!.delta).toBeCloseTo(-60);
  });

  it("確かめるだけの手（会社の答えを聞く）は、聞かなかった場合の同じ答えの世界と比べる（悪くなる見込みを大きく出さない）", () => {
    const doc = createEmptyDoc();
    const node = (id: string, type: NodeType, meta: Record<string, unknown> = {}) => (doc.nodes[id] = makeNode({ id, title: id, type, meta }));
    const edge = (a: string, b: string, opt: { prob?: number; r?: R3; rv?: [string, string] } = {}) => {
      const e = makeEdge({ id: `${a}-${b}`, source: a, target: b, relation: opt.prob !== undefined ? "condition" : "leads" });
      e.meta = { ...(opt.prob !== undefined ? { prob: opt.prob } : {}), ...(opt.r ? { r: opt.r } : {}), ...(opt.rv ? { rv: opt.rv } : {}) };
      doc.edges[e.id] = e;
    };
    node("R", "goal", { forecastRoot: true, impact: { v: 2, horizon: 36, annual: 360 }, fork: "decision", m: 0, rr: [0, 0, 0] });
    // 今のまま → 3 か月後に聞く（全部可なら +70、不可なら 0）
    node("K", "action", { fork: "chance", m: 0, base: true });
    node("K1", "branch", { fork: "decision", m: 3, rr: [0, 0, 0] });
    edge("R", "K");
    edge("K", "K1", { prob: 100, r: [0, 0, 0] });
    node("K1k", "action", { fork: "chance", m: 3, base: true });
    node("K1kE", "result", { m: 36, rr: [0, 0, 0] });
    edge("K1", "K1k");
    edge("K1k", "K1kE", { prob: 100, r: [0, 0, 0] });
    node("K1a", "action", { fork: "chance", m: 3 });
    node("K1aY", "result", { m: 36, rr: [0, 0, 0] });
    node("K1aN", "result", { m: 36, rr: [0, 0, 0] });
    edge("K1", "K1a");
    edge("K1a", "K1aY", { prob: 50, r: [0, 70, 0], rv: ["pm:0", "a"] });
    edge("K1a", "K1aN", { prob: 50, r: [0, 0, 0], rv: ["pm:0", "n"] });
    // 今すぐ聞く（全部可なら +100、不可なら 0）
    node("A", "action", { fork: "chance", m: 0 });
    node("AY", "result", { m: 36, rr: [0, 0, 0] });
    node("AN", "result", { m: 36, rr: [0, 0, 0] });
    edge("R", "A");
    edge("A", "AY", { prob: 50, r: [0, 100, 0], rv: ["pm:0", "a"] });
    edge("A", "AN", { prob: 50, r: [0, 0, 0], rv: ["pm:0", "n"] });
    const r = run(doc);
    const a = r.alt.get("A")!;
    expect(a.delta).toBeCloseTo(15);
    // 同じ答えの世界の今のまま: 全部可なら 70、不可なら 0 → 差は +30 と 0（悪くならない）
    expect(a.outcomes.map((o) => o.u)).toEqual([30, 0]);
    expect(a.pBad).toBe(0);
    expect(a.outcomes.reduce((s, o) => s + o.w * o.u!, 0)).toBeCloseTo(a.delta!);
    // 同じ答えの線が 2 本（全部可・1 社目 / 全部可・まだ）あっても、それぞれの見込みの割合で数える
    {
      const d2 = JSON.parse(JSON.stringify(doc));
      // 今のままの道の「後で聞く」を、全部可を 2 つ（1 社目 30% で +90・まだ 20% で +40）に分ける
      d2.nodes.K1aY2 = { ...d2.nodes.K1aY, id: "K1aY2" };
      d2.edges["K1a-K1aY"].meta = { prob: 30, r: [0, 90, 0], rv: ["pm:0", "a"] };
      d2.edges["K1a-K1aY2"] = { ...d2.edges["K1a-K1aY"], id: "K1a-K1aY2", target: "K1aY2", meta: { prob: 20, r: [0, 40, 0], rv: ["pm:0", "a"] } };
      const r3 = run(d2);
      const a3 = r3.alt.get("A")!;
      // 今のまま: 全部可の世界の値は (30×90 + 20×40) / 50 = 70、不可なら 0。Δ は 50 − 35 = 15 のまま
      expect(a3.delta).toBeCloseTo(15);
      expect(a3.outcomes.map((o) => o.u)).toEqual([30, 0]);
      expect(a3.outcomes.reduce((s, o) => s + o.w * o.u!, 0)).toBeCloseTo(a3.delta!);
    }
    // 印が無ければ、今のままの平均（35）と比べる
    for (const e of Object.values(doc.edges)) delete e.meta.rv;
    const r2 = run(doc);
    expect(r2.alt.get("A")!.outcomes.map((o) => o.u)).toEqual([65, -35]);
    expect(r2.alt.get("A")!.pBad).toBeCloseTo(0.5);
  });

  it("入口が v2 でなければ出さない", () => {
    const { doc } = tree();
    delete doc.nodes.R!.meta.impact;
    expect(run(doc).active).toBe(false);
  });
});

describe("数の書き方と段", () => {
  it("万円の書き方", () => {
    expect(formatMan(0.04)).toBe("±0");
    expect(formatMan(3.14)).toBe("+3.1万");
    expect(formatMan(-0.44)).toBe("−0.4万");
    expect(formatMan(3)).toBe("+3万");
    expect(formatMan(65.4)).toBe("+65万");
    expect(formatMan(-1240)).toBe("−1,240万");
    expect(formatMan(12345)).toBe("+1.2億");
    expect(formatMan(1423, false)).toBe("1,423万");
    expect(formatMonthlyDelta(2.1)).toBe("月+2.1万");
  });

  it("段の境目", () => {
    expect(impactBin(2.99)).toBe(0);
    expect(impactBin(3)).toBe(1);
    expect(impactBin(29.9)).toBe(1);
    expect(impactBin(30)).toBe(2);
    expect(impactBin(-100)).toBe(-3);
    expect(impactBin(300)).toBe(4);
    expect(impactBin(null)).toBe(0);
  });
});

describe("入口が 2 つ以上あるとき", () => {
  it("先へ進む線のある入口 → 早く作った物 → ID の順で 1 つに決める", () => {
    const { doc } = tree();
    // 今日の複製（線なし・ID が先に来る）
    doc.nodes["0copy"] = { ...doc.nodes.R!, id: "0copy", meta: { ...doc.nodes.R!.meta } };
    expect(primaryImpactRoot(doc)).toBe("R");
    expect(primaryImpactRoot(doc, buildIndex(doc).out)).toBe("R");
    // 線のある入口がもう 1 つ（後から作った）
    doc.nodes["0map"] = { ...doc.nodes.R!, id: "0map", createdAt: "2999-01-01T00:00:00.000Z", meta: { ...doc.nodes.R!.meta } };
    const e = makeEdge({ id: "0map-K", source: "0map", target: "K", relation: "leads" });
    doc.edges[e.id] = e;
    expect(primaryImpactRoot(doc)).toBe("R");
    expect(primaryImpactRoot(doc, buildIndex(doc).out)).toBe("R");
    // 同じ時刻なら ID の順
    doc.nodes["0map"]!.createdAt = doc.nodes.R!.createdAt;
    expect(primaryImpactRoot(doc)).toBe("0map");
    expect(primaryImpactRoot(createEmptyDoc())).toBeNull();
  });
});

describe("見直しで直した所", () => {
  it("今日を複製しても（入口が 2 つ）、数字・行き先・分布は元の入口から", () => {
    for (const copyId of ["0copy", "zcopy"]) {
      const { doc } = tree();
      const before = run(doc);
      doc.nodes[copyId] = { ...doc.nodes.R!, id: copyId, meta: { ...doc.nodes.R!.meta } };
      const r = run(doc);
      expect(r.root).toBe("R");
      expect(r.vRoot).toBeCloseTo(before.vRoot!);
      expect(r.vSQ).toBeCloseTo(before.vSQ!);
      expect(r.ends.reduce((s, e) => s + e.p, 0)).toBeCloseTo(1);
      expect(r.ends.some((e) => e.id === copyId)).toBe(false);
      expect(r.dist!.mean).toBeCloseTo(before.dist!.mean);
      expect(r.dist!.pWorse).toBeCloseTo(before.dist!.pWorse);
      expect(r.decision.get("R")!.alts).toEqual(before.decision.get("R")!.alts);
      expect(r.salaryFlips()).toEqual(before.salaryFlips());
    }
  });

  it("子の日付が親より前でも、同じ月を 2 度数えない（月は親の月より前にしない）", () => {
    const { doc, node, edge } = tree();
    doc.nodes.R!.time = { due: "2026-11-18", start: null };
    node("U", "action", {}, { time: { due: "2027-11-18", start: null } });
    node("X", "result", {}, { time: { due: "2027-05-18", start: null } });
    edge("R", "U");
    edge("U", "X");
    const r = run(doc);
    // U は 12 か月で X へ。X の日付（6 か月後）は U より前だが、X は 12 か月から 36 か月まで数える（合わせて 36 か月 = 今のままと同じ）
    expect(r.alt.get("U")!.delta).toBeCloseTo(0, 6);
  });

  it("起こらない結果（0%）は「悪くて」に入れない", () => {
    const { doc, node, edge } = tree();
    node("A3", "result", { m: 36, rr: [1, -5, 0] });
    // A1 60%・A2 40% で 100% なので、見込みの無い線は 0%
    edge("A", "A3", { r: [36, -500, 0] });
    doc.edges["A-A3"]!.relation = "condition";
    const a = run(doc).alt.get("A")!;
    expect(a.outcomes.find((o) => o.node === "A3")!.w).toBe(0);
    expect(a.worst).toBeCloseTo(-30);
    expect(a.pBad).toBeCloseTo(0.4);
  });

  it("数字の無い選択肢には 3 年後の月の差も出さない", () => {
    const { doc, node, edge } = tree();
    node("N", "action");
    edge("R", "N");
    const a = run(doc).alt.get("N")!;
    expect(a.delta).toBeNull();
    expect(a.dR).toBeNull();
  });

  it("同じ答えの世界で、その答えの線がどれも 0% なら、ふつうの割合で比べる（結果の差が平均と合う）", () => {
    const doc = createEmptyDoc();
    const node = (id: string, type: NodeType, meta: Record<string, unknown> = {}) => (doc.nodes[id] = makeNode({ id, title: id, type, meta }));
    const edge = (a: string, b: string, opt: { prob?: number; r?: R3; rv?: [string, string] } = {}) => {
      const e = makeEdge({ id: `${a}-${b}`, source: a, target: b, relation: opt.prob !== undefined ? "condition" : "leads" });
      e.meta = { ...(opt.prob !== undefined ? { prob: opt.prob } : {}), ...(opt.r ? { r: opt.r } : {}), ...(opt.rv ? { rv: opt.rv } : {}) };
      doc.edges[e.id] = e;
    };
    node("R", "goal", { forecastRoot: true, impact: { v: 2, horizon: 36, annual: 360 }, fork: "decision", m: 0, rr: [0, 0, 0] });
    node("K", "action", { fork: "chance", m: 0, base: true });
    node("K1", "branch", { fork: "decision", m: 3, rr: [0, 0, 0] });
    edge("R", "K");
    edge("K", "K1", { prob: 100, r: [0, 0, 0] });
    node("K1k", "action", { fork: "chance", m: 3, base: true });
    node("K1kE", "result", { m: 36, rr: [0, 0, 0] });
    edge("K1", "K1k");
    edge("K1k", "K1kE", { prob: 100, r: [0, -10, 0] });
    // 今のままの道で後で聞く: 全部可は 0%（この道では出ない）、不可 100% で +20
    node("K1a", "action", { fork: "chance", m: 3 });
    node("K1aY", "result", { m: 36, rr: [0, 0, 0] });
    node("K1aN", "result", { m: 36, rr: [0, 0, 0] });
    edge("K1", "K1a");
    edge("K1a", "K1aY", { prob: 0, r: [0, 70, 0], rv: ["pm:0", "a"] });
    edge("K1a", "K1aN", { prob: 100, r: [0, 20, 0], rv: ["pm:0", "n"] });
    node("A", "action", { fork: "chance", m: 0 });
    node("AY", "result", { m: 36, rr: [0, 0, 0] });
    node("AN", "result", { m: 36, rr: [0, 0, 0] });
    edge("R", "A");
    edge("A", "AY", { prob: 50, r: [0, 100, 0], rv: ["pm:0", "a"] });
    edge("A", "AN", { prob: 50, r: [0, 0, 0], rv: ["pm:0", "n"] });
    const a = run(doc).alt.get("A")!;
    expect(a.delta).toBeCloseTo(30);
    // 全部可の世界は今のままの道では起こらないので、今のままの平均（+20）と比べる: +80 と −20
    expect(a.outcomes.map((o) => o.u)).toEqual([80, -20]);
    expect(a.outcomes.reduce((s, o) => s + o.w * o.u!, 0)).toBeCloseTo(a.delta!);
  });

  it("年収の境目は今の年収から遠い側に丸める（境目のすぐ上・すぐ下でも食い違わない）", () => {
    // 副業 A は 36S + 18、週 4 日 B は 30S + 307.2。入れ替わるのは S = 48.2（年収 578.4）
    const at = (annual: number) => {
      const { doc } = tree({ annual });
      doc.edges["B-B1"]!.meta = { prob: 100, r: [30, 307.2, 0] };
      return run(doc);
    };
    const hi = at(579);
    expect(hi.decision.get("R")!.best).toBe("A");
    expect(hi.salaryFlips().below!.alt).toBe("B");
    expect(hi.salaryFlips().below!.annual).toBeLessThanOrEqual(578.4);
    const lo = at(575);
    expect(lo.decision.get("R")!.best).toBe("B");
    expect(lo.salaryFlips().above!.alt).toBe("A");
    expect(lo.salaryFlips().above!.annual).toBeGreaterThanOrEqual(578.4);
    // 1,000 万円より上から下へ見ても（100 万円ごと）、同じ境目に行き着く
    const top = at(3000);
    expect(top.salaryFlips().below).toEqual(hi.salaryFlips().below);
  });
});
