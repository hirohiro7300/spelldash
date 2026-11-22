// 3 年の影響のエンジン（src/model/impactEngine.ts）が、基準の作り（src/model/impact.ts の computeImpact）と同じ答えを出すか。
// 手で作った文書（合流・循環・入口 2 つ・数字なし・会社の答え・期限だけの月）・版 6 の地図（1,533 枚）・3 か月ごとの小さい地図（q-small）で、
// 年収 360・540、選んだ手・見送った手・方針をばらばらに入れて、アプリが読む所すべてを比べる。
// 文書を変えたとき（状態・% ・方針・年収・形・元に戻す・全部の入れ替え）も、変わった所だけやり直した答えが、最初から数えた答えと同じか。
// ★ の決まり（q のある地図: max(10 万円, 判断の幅の 3 割)）とおすすめの印は、基準の作りにも入っていて、ここで両方を確かめる

import { beforeAll, describe, expect, it } from "vitest";
import { buildImpactDoc } from "../../src/demo/impact";
import { buildQuarterDoc } from "../../src/demo/quarterDoc";
import { analyze, compileMap, overview } from "../../src/deepmap/core";
import type { MapData } from "../../src/deepmap/mapData";
import { computeForecast } from "../../src/model/forecast";
import { buildIndex } from "../../src/model/graph";
import { computeImpact, IMPACT_STAR_LEAD, IMPACT_STAR_SHARE, type ImpactResult } from "../../src/model/impact";
import { ImpactEngine } from "../../src/model/impactEngine";
import { createEmptyDoc, makeEdge, makeNode } from "../../src/model/schema";
import type { DocData, GEdge, GNode, ID, NodeStatus, NodeType } from "../../src/model/types";
import { Store } from "../../src/store/store";
import { engRun, refRun, sameImpact } from "./helpers/impactEquiv";
import { loadQSmall } from "./helpers/qSmall";
import { r6Bundle } from "./helpers/r6";

type R3 = [number, number, number];

/** 種から決まる乱数（mulberry32） */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 判断 → 選択肢 → 結果 の小さな木（tests/unit/impact.test.ts と同じ形） */
function tree(opts: { annual?: number; tail?: number } = {}) {
  const doc = createEmptyDoc();
  const node = (id: string, type: NodeType, meta: Record<string, unknown> = {}, extra: Partial<GNode> = {}) => {
    doc.nodes[id] = makeNode({ id, title: id, type, meta, ...extra });
    return id;
  };
  const edge = (source: string, target: string, opt: { prob?: number; r?: R3; scen?: string[]; rv?: [string, string] } = {}): GEdge => {
    const e = makeEdge({ id: `${source}-${target}`, source, target, relation: opt.prob !== undefined ? "condition" : "leads", scenarioIds: opt.scen ?? [] });
    e.meta = { ...(opt.prob !== undefined ? { prob: opt.prob } : {}), ...(opt.r ? { r: opt.r } : {}), ...(opt.rv ? { rv: opt.rv } : {}) };
    doc.edges[e.id] = e;
    return e;
  };
  const impact: Record<string, unknown> = { v: 2, horizon: 36 };
  if (opts.annual !== undefined) impact.annual = opts.annual;
  if (opts.tail !== undefined) impact.tail = opts.tail;
  node("R", "goal", { forecastRoot: true, impact, fork: "decision", m: 0, rr: [1, 0, 0] }, { time: { due: "2026-11-18", start: null } });
  node("K", "action", { fork: "chance", m: 0, base: true, ak: "keep", fam: "keep", rank: 3 });
  node("K1", "result", { m: 36, rr: [1, 0, 0] });
  edge("R", "K");
  edge("K", "K1", { prob: 100, r: [36, 0, 0] });
  node("A", "action", { fork: "chance", m: 0, ak: "side", fam: "side", rank: 1 });
  node("A1", "result", { m: 36, rr: [1, 2, 0] });
  node("A2", "result", { m: 36, rr: [1, -1, 0] });
  edge("R", "A", { scen: ["s1"] });
  edge("A", "A1", { prob: 60, r: [36, 50, 0] });
  edge("A", "A2", { prob: 40, r: [36, -30, 0] });
  node("B", "action", { fork: "chance", m: 0, ak: "part", fam: "part", rank: 2 });
  node("B1", "result", { m: 36, rr: [0.8, 3, 0] });
  edge("R", "B", { scen: ["s2"] });
  edge("B", "B1", { prob: 100, r: [30, 120, 0] });
  doc.scenarios.s1 = { id: "s1", name: "s1", color: "#fff", description: "", createdAt: "", updatedAt: "", meta: {} };
  doc.scenarios.s2 = { id: "s2", name: "s2", color: "#fff", description: "", createdAt: "", updatedAt: "", meta: {} };
  doc.scenarioOrder = ["s1", "s2"];
  return { doc, node, edge };
}

/** 会社の答えを聞く手の文書（同じ答えの世界で比べる） */
function factDoc(): DocData {
  const { doc, node, edge } = tree({ annual: 360 });
  node("K2", "branch", { fork: "decision", m: 3, rr: [1, 0, 0] });
  edge("K", "K2", { prob: 0, r: [3, 0, 0] });
  node("K2k", "action", { fork: "chance", m: 3, base: true, ak: "keep", fam: "keep" });
  node("K2kE", "result", { m: 36, rr: [1, 0, 0] });
  edge("K2", "K2k");
  edge("K2k", "K2kE", { prob: 100, r: [33, -10, 0] });
  node("K2a", "action", { fork: "chance", m: 3, ak: "ask", fam: "ask" });
  node("K2aY", "result", { m: 36, rr: [1, 0, 0] });
  node("K2aN", "result", { m: 36, rr: [1, 0, 0] });
  edge("K2", "K2a");
  edge("K2a", "K2aY", { prob: 30, r: [33, 70, 0], rv: ["pm:0", "a"] });
  edge("K2a", "K2aN", { prob: 70, r: [33, 20, 0], rv: ["pm:0", "n"] });
  node("F", "action", { fork: "chance", m: 0, ak: "ask", fam: "ask", rank: 4 });
  node("FY", "result", { m: 36, rr: [1, 0, 0] });
  node("FN", "result", { m: 36, rr: [1, 0, 0] });
  edge("R", "F");
  edge("F", "FY", { prob: 50, r: [36, 100, 0], rv: ["pm:0", "a"] });
  edge("F", "FN", { prob: 50, r: [36, 0, 0], rv: ["pm:0", "n"] });
  return doc;
}

/** 手で作った、いろいろな形の文書 */
const HAND: Array<[string, () => DocData]> = [
  ["基本の木", () => tree({ annual: 360 }).doc],
  ["年収なし・その後に 12 か月", () => tree({ tail: 12 }).doc],
  [
    "選んだ手と見送った手",
    () => {
      const { doc } = tree({ annual: 360 });
      doc.nodes.B!.status = "active";
      doc.nodes.K!.status = "dropped";
      return doc;
    },
  ],
  [
    "全部見送り",
    () => {
      const { doc } = tree({ annual: 480 });
      for (const id of ["A", "B", "K"]) doc.nodes[id]!.status = "dropped";
      return doc;
    },
  ],
  [
    "数字なしの手（選んだとき）",
    () => {
      const { doc, node, edge } = tree({ annual: 360, tail: 12 });
      node("X", "action", { rank: 9 });
      edge("R", "X");
      node("N", "action");
      edge("R", "N");
      doc.nodes.X!.status = "active";
      return doc;
    },
  ],
  [
    "基準なし・循環",
    () => {
      const { doc, node, edge } = tree({ annual: 360 });
      delete doc.nodes.K!.meta.base;
      node("C1", "action");
      node("C2", "action");
      edge("A2", "C1");
      edge("C1", "C2");
      edge("C2", "C1");
      return doc;
    },
  ],
  [
    "判断の線の %",
    () => {
      const { doc } = tree({ annual: 360 });
      doc.edges["R-B"]!.meta = { prob: 90 };
      return doc;
    },
  ],
  ["会社の答え", factDoc],
  [
    "入口が 2 つ（今日の複製）",
    () => {
      const { doc } = tree();
      doc.nodes["0copy"] = { ...doc.nodes.R!, id: "0copy", meta: { ...doc.nodes.R!.meta } };
      return doc;
    },
  ],
  [
    "入口が 2 つ（線のある入口がもう 1 つ・合流）",
    () => {
      const { doc } = tree({ annual: 360 });
      doc.nodes["0map"] = { ...doc.nodes.R!, id: "0map", createdAt: doc.nodes.R!.createdAt, meta: { ...doc.nodes.R!.meta } };
      const e = makeEdge({ id: "0map-K", source: "0map", target: "K", relation: "leads" });
      doc.edges[e.id] = e;
      return doc;
    },
  ],
  [
    "期限だけの月・親より前の日付",
    () => {
      const { doc, node, edge } = tree();
      node("U", "action", {}, { time: { due: "2027-11-18", start: null } });
      node("X", "result", {}, { time: { due: "2027-05-18", start: null } });
      edge("R", "U");
      edge("U", "X");
      return doc;
    },
  ],
  [
    "0% の結果と % の無い線",
    () => {
      const { doc, node, edge } = tree();
      node("A3", "result", { m: 36, rr: [1, -5, 0] });
      edge("A", "A3", { r: [36, -500, 0] });
      doc.edges["A-A3"]!.relation = "condition";
      return doc;
    },
  ],
  [
    "合流（2 つの結果が同じ状態へ）と入口へ戻る線",
    () => {
      const { doc, node, edge } = tree({ annual: 360 });
      node("M", "branch", { fork: "decision", m: 12, rr: [1, 1, 0] });
      edge("A1", "M");
      edge("A2", "M");
      node("Mk", "action", { fork: "chance", m: 12, base: true, ak: "keep", fam: "keep" });
      node("MkE", "result", { m: 36, rr: [1, 1, 0] });
      edge("M", "Mk");
      edge("Mk", "MkE", { prob: 100, r: [24, 24, 0] });
      node("Ms", "action", { fork: "chance", m: 12, ak: "side", fam: "side" });
      node("MsE", "result", { m: 36, rr: [1, 3, 0] });
      edge("M", "Ms");
      edge("Ms", "MsE", { prob: 100, r: [24, 60, 0] });
      edge("MsE", "R");
      return doc;
    },
  ],
  [
    "q のある判断（★ は q の差と幅の 3 割）",
    () => {
      const { doc } = tree({ annual: 360 });
      // 木の値: A 1098・B 1020・K 1080。q: A は今のまま +6 だけ（★ にしない）・B は大きく下
      doc.nodes.A!.meta = { ...doc.nodes.A!.meta, q: [36, 6, 0] };
      doc.nodes.K!.meta = { ...doc.nodes.K!.meta, q: [36, 0, 0] };
      doc.nodes.B!.meta = { ...doc.nodes.B!.meta, q: [30, 60, 0] };
      return doc;
    },
  ],
  ["q のある判断（大きく悪い手・まとめた手・q の無い手）", () => wideQDoc()],
];

/**
 * 版 7 の今日に似た判断: 一番の手 A（q +16）・B（q +9.9。木の値では今のままより下）・大きく悪い手 W（q −242）・
 * まとめた手 St（q の代わりに木の値 +5）・自分で足した q の無い手 U（木の値 +3）。比べる元は K
 */
function wideQDoc(): DocData {
  const { doc, node, edge } = tree({ annual: 360 });
  doc.nodes.A!.meta = { ...doc.nodes.A!.meta, q: [36, 16, 0] };
  doc.nodes.K!.meta = { ...doc.nodes.K!.meta, q: [36, 0, 0] };
  doc.nodes.B!.meta = { ...doc.nodes.B!.meta, q: [36, 9.9, 0] };
  node("W", "action", { fork: "chance", m: 0, ak: "quit", fam: "quit", rank: 5, q: [36, -242, 0] });
  node("W1", "result", { m: 36, rr: [0, 1, 0] });
  edge("R", "W");
  edge("W", "W1", { prob: 100, r: [0, 300, 0] });
  node("St", "action", { fork: "chance", m: 0, ak: "grow", fam: "grow", rank: 6, stub: true });
  node("St1", "result", { m: 36, rr: [1, 0, 0] });
  edge("R", "St");
  edge("St", "St1", { prob: 100, r: [36, 5, 0] });
  node("U", "action", { fork: "chance", m: 0, ak: "mine", fam: "mine", rank: 7 });
  node("U1", "result", { m: 36, rr: [1, 0, 0] });
  edge("R", "U");
  edge("U", "U1", { prob: 100, r: [36, 3, 0] });
  return doc;
}

describe("エンジン: 手で作った文書で基準の作りと同じ答え", () => {
  for (const [name, make] of HAND) {
    for (const sid of [null, "s1", "s2"]) {
      it(`${name}（方針 ${sid ?? "なし"}）`, () => {
        const doc = make();
        const { ref } = refRun(doc, sid);
        const { eng, engine } = engRun(doc, sid);
        sameImpact(eng, ref, {}, doc);
        expect(engine.lastCompile === null || engine.lastCompile === "doc").toBe(true);
      });
    }
  }

  it("q のある地図の ★: 一番の手の q の差が max(10, 幅の 3 割) より小さければ ★ にしない。≒ は一番の手から 10 万円未満（一番の手には付けない）。どの判断も一番の手におすすめの印", () => {
    const doc = HAND.find((x) => x[0].startsWith("q のある"))![1]();
    const { ref } = refRun(doc);
    const { eng } = engRun(doc);
    expect(ref.likeBasis).toBe(true);
    // 一番の手は木の値で決める（A が今のままより 18 万円良い）。画面に出す差は q どうし（A 1086 − K 1080 = 6: 見直し user-1）
    expect(ref.decision.get("R")!.best).toBe("A");
    for (const r of [ref, eng]) {
      expect(r.alt.get("A")!.delta).toBeCloseTo(6);
      expect(r.alt.get("A")!.deltaBasis).toBe("q");
      expect(r.alt.get("A")!.deltaV).toEqual([0, 6, 0]);
      expect(r.alt.get("B")!.delta).toBeCloseTo(960 - 1080);
      expect(r.deltaOf("A")).toBeCloseTo(6);
      // 判断の差は、選べる手の画面に出す差の一番大きい物
      expect(r.decision.get("R")!.stakes).toBeCloseTo(6);
      expect(r.stakesOf("R")).toBeCloseTo(6);
    }
    // q: A 1086・K 1080・B 960。幅 126 の 3 割 = 37.8 > 10。A の差 6 < 37.8 なので ★ でない。≒ は A から 10 万円未満の K だけ
    for (const r of [ref, eng]) {
      expect(r.alt.get("A")!.mark).toBeNull();
      expect(r.alt.get("K")!.mark).toBe("tie");
      expect(r.alt.get("B")!.mark).toBeNull();
      expect(r.alt.get("A")!.rec).toBe(true);
      expect(r.alt.get("K")!.rec).toBe(false);
    }
    expect(IMPACT_STAR_SHARE).toBe(0.3);
    // q の差を大きくすると ★
    doc.nodes.A!.meta = { ...doc.nodes.A!.meta, q: [36, 60, 0] };
    const r2 = refRun(doc).ref;
    expect(r2.alt.get("A")!.mark).toBe("star");
    expect(r2.alt.get("K")!.mark).toBeNull();
    sameImpact(engRun(doc).eng, r2);
    // q の無い地図（版 6）は前の決まり（2 位より 10 万円以上で ★）・おすすめの印なし・差は木の値どうし
    const plain = tree({ annual: 360 }).doc;
    const r3 = refRun(plain).ref;
    expect(r3.likeBasis).toBe(false);
    expect(r3.alt.get("A")!.mark).toBe("star");
    expect(r3.alt.get("A")!.delta).toBeCloseTo(18);
    expect(r3.alt.get("A")!.deltaBasis).toBe("tree");
    expect([...r3.alt.values()].some((a) => a.rec)).toBe(false);
    expect(IMPACT_STAR_LEAD).toBe(10);
  });

  it("版 7 の今日のような判断: 大きく悪い手があっても ≒ は一番の手から 10 万円未満だけ。差は q どうし（まとめた手はその値・q の無い手は木の値どうし）", () => {
    const doc = wideQDoc();
    const { ref } = refRun(doc);
    const { eng } = engRun(doc);
    for (const r of [ref, eng]) {
      expect(r.decision.get("R")!.best).toBe("A");
      const d = (id: string) => r.alt.get(id)!;
      // 画面に出す差と出し方
      expect(d("A").delta).toBeCloseTo(16);
      expect(d("B").delta).toBeCloseTo(9.9);
      expect(d("W").delta).toBeCloseTo(-242);
      expect(d("St").delta).toBeCloseTo(5);
      expect(d("U").delta).toBeCloseTo(3);
      expect(d("K").delta).toBe(0);
      expect([d("A").deltaBasis, d("B").deltaBasis, d("W").deltaBasis, d("St").deltaBasis, d("U").deltaBasis, d("K").deltaBasis]).toEqual(["q", "q", "q", "q", "tree", "q"]);
      // 内訳は差に合う
      for (const id of ["A", "B", "W", "St", "U"]) {
        const v = d(id).deltaV!;
        expect(v[0] + v[1] + v[2]).toBeCloseTo(d(id).delta!);
      }
      // 木の値では B は今のままより下（−60）でも、画面には q の差 +9.9（見取り図と同じ数）
      expect(r.value.get("B")! - r.value.get("K")!).toBeLessThan(0);
      // ≒: 一番の手 A（q 1096）から 10 万円未満は B（6.1）だけ。幅 258 の 3 割（77）ではない。A そのものには付けない
      expect(d("A").mark).toBeNull();
      expect(d("A").rec).toBe(true);
      expect(d("B").mark).toBe("tie");
      for (const id of ["K", "W", "St", "U"]) expect([id, d(id).mark]).toEqual([id, null]);
      // 並べる順（画面に出す差の順）: A・B・St・U・K・W
      expect(r.decision.get("R")!.spread![0]).toBeCloseTo(-242);
      expect(r.decision.get("R")!.spread![1]).toBeCloseTo(16);
      expect(r.decision.get("R")!.stakes).toBeCloseTo(16);
    }
    sameImpact(eng, ref, {}, doc);
  });
});

/** 選んだ・見送ったを種からばらまく（手だけ） */
function scatter(doc: DocData, seed: number, rate = 1): void {
  const rand = rng(seed);
  for (const n of Object.values(doc.nodes)) {
    if (typeof n.meta.ak !== "string") continue;
    const u = rand() / rate;
    const s: NodeStatus = u < 0.06 ? "active" : u < 0.09 ? "done" : u < 0.18 ? "dropped" : "open";
    if (s !== "open") doc.nodes[n.id] = { ...n, status: s };
  }
}

function withAnnual(doc: DocData, annual: number): void {
  for (const n of Object.values(doc.nodes)) {
    if (n.meta.forecastRoot !== true) continue;
    n.meta = { ...n.meta, impact: { ...(n.meta.impact as object), annual } };
  }
}

describe("エンジン: 版 6 の地図（1,533 枚）で基準の作りと同じ答え", () => {
  const cases: Array<[number, string | null, number]> = [
    [360, null, 0],
    [540, null, 0],
    [360, null, 7],
    [540, "s_balance", 11],
    [360, "s_early", 13],
    [480, "s_focus", 17],
  ];
  for (const [annual, sid, seed] of cases) {
    it(`年収 ${annual}・方針 ${sid ?? "なし"}・${seed ? `種 ${seed} の選んだ手と見送った手` : "選んだ手なし"}`, () => {
      const doc = buildImpactDoc(r6Bundle(), new Date(2026, 10, 19), "test");
      withAnnual(doc, annual);
      if (seed) scatter(doc, seed);
      const { ref } = refRun(doc, sid);
      const { eng, engine } = engRun(doc, sid);
      expect(engine.lastCompile).toBe("doc");
      expect(ref.counts.nodes).toBe(1533);
      sameImpact(eng, ref);
    });
  }
});

describe("エンジン: 3 か月ごとの小さい地図（q-small）で基準の作りと同じ答え（同梱の地図の列から作っても・文書から作っても）", () => {
  let map: MapData;
  beforeAll(async () => {
    map = await loadQSmall();
  });
  const build = () => buildQuarterDoc(map, { version: map.header.hash, release: map.header.release, at: Date.UTC(2026, 10, 1) });
  const cases: Array<[number, string | null, number]> = [
    [360, null, 0],
    [540, null, 0],
    [360, null, 3],
    [540, "s_balance", 5],
    [360, "s_early", 8],
  ];
  for (const [annual, sid, seed] of cases) {
    it(`年収 ${annual}・方針 ${sid ?? "なし"}・${seed ? `種 ${seed}` : "選んだ手なし"}`, () => {
      const doc = build();
      withAnnual(doc, annual);
      if (seed) scatter(doc, seed);
      const { ref } = refRun(doc, sid);
      expect(ref.likeBasis).toBe(true);
      const fromMap = engRun(doc, sid, { map });
      expect(fromMap.engine.lastCompile).toBe("map");
      sameImpact(fromMap.eng, ref, {}, doc);
      const fromDoc = engRun(doc, sid);
      expect(fromDoc.engine.lastCompile).toBe("doc");
      sameImpact(fromDoc.eng, ref);
    });
  }

  it("今日の手の差（キャンバスの札・今決めること・カードの見出し）は、見取り図の「今やる vs 3 か月待つ」（計算の芯の overview）と同じ数（見直し user-1・equiv-1）", () => {
    const cm = compileMap(map);
    for (const annual of [360, 540]) {
      const doc = build();
      withAnnual(doc, annual);
      const ov = overview(analyze(cm, annual, {}));
      const { eng } = engRun(doc, null, { map });
      const { ref } = refRun(doc);
      expect(ov.moves.length).toBeGreaterThanOrEqual(3);
      const rootAlts = eng.decision.get(eng.root!)!.alts;
      expect(rootAlts.length).toBe(ov.moves.length);
      for (const mv of ov.moves) {
        const id = engRun(doc, null, { map }).engine.graph.topo!.ids[mv.node]!;
        expect(rootAlts).toContain(id);
        for (const r of [eng, ref]) {
          const a = r.alt.get(id)!;
          expect(mv.delta).not.toBeNull();
          expect([annual, id, a.deltaBasis]).toEqual([annual, id, mv.delta!.basis]);
          expect(Math.abs(a.delta! - mv.delta!.d)).toBeLessThan(1e-9 * Math.max(1, Math.abs(mv.delta!.d)));
          expect(Math.abs(r.deltaOf(id)! - mv.delta!.d)).toBeLessThan(1e-9 * Math.max(1, Math.abs(mv.delta!.d)));
        }
      }
    }
  });

  it("同梱の地図の列から作った形と数は、文書から作った物と同じ（並べる順だけ違う）", () => {
    const doc = build();
    const a = engRun(doc, null, { map }).engine.graph;
    const b = engRun(doc).engine.graph;
    const ta = a.topo!;
    const tb = b.topo!;
    const na = a.nums!;
    const nb = b.nums!;
    expect(ta.n).toBe(tb.n);
    expect(ta.ids.slice().sort()).toEqual(tb.ids.slice().sort());
    for (let i = 0; i < ta.n; i++) {
      const j = tb.idx.get(ta.ids[i]!)!;
      const what = ta.ids[i]!;
      expect([what, na.kind[i], na.t[i], na.rank[i], na.isBase[i], na.noData[i], na.fam[i], na.sum[i]]).toEqual([what, nb.kind[j], nb.t[j], nb.rank[j], nb.isBase[j], nb.noData[j], nb.fam[j], nb.sum[j]]);
      for (let c = 0; c < 3; c++) {
        expect([what, "rr", c, na.rr[i * 3 + c]]).toEqual([what, "rr", c, nb.rr[j * 3 + c]]);
        expect([what, "q", c, na.q[i * 3 + c]]).toEqual([what, "q", c, nb.q[j * 3 + c]]);
      }
      const deg = ta.off[i + 1]! - ta.off[i]!;
      expect(deg).toBe(tb.off[j + 1]! - tb.off[j]!);
      for (let k = 0; k < deg; k++) {
        const sa = ta.off[i]! + k;
        const sb = tb.off[j]! + k;
        expect([what, k, ta.eid[sa], na.w[sa], na.rvKey[sa], na.rvCat[sa], ta.ids[ta.tgt[sa]!]]).toEqual([what, k, tb.eid[sb], nb.w[sb], nb.rvKey[sb], nb.rvCat[sb], tb.ids[tb.tgt[sb]!]]);
        for (let c = 0; c < 3; c++) expect([what, k, "er", c, na.er[sa * 3 + c]]).toEqual([what, k, "er", c, nb.er[sb * 3 + c]]);
      }
      const bs = na.base[i]!;
      expect(bs < 0 ? null : ta.eid[bs]).toBe(nb.base[j]! < 0 ? null : tb.eid[nb.base[j]!]);
    }
    expect([na.H, na.likeBasis]).toEqual([nb.H, nb.likeBasis]);
  });
});

/** ストアで文書を変えながら、変わった所だけやり直したエンジンの答えが、最初から数えた基準の答えと同じか */
function driveStore(doc0: DocData, opts: { map?: MapData; seed: number; steps: number; sids?: Array<string | null> }): { results: number; same: number } {
  const store = new Store(doc0);
  const engine = new ImpactEngine();
  if (opts.map) engine.useMap({ map: opts.map, doc: store.doc });
  store.on("change", (info) => engine.note(store.doc, info));
  const rand = rng(opts.seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  let sid: string | null = null;
  let last: ImpactResult | null = null;
  let results = 0;
  let same = 0;
  const check = (what: string) => {
    const doc = store.doc;
    const idx = buildIndex(doc);
    const s = sid && doc.scenarios[sid] ? sid : null;
    const fc = computeForecast(doc, idx.out, s);
    const eng = engine.result({ doc, sid: s, out: () => idx.out, reach: () => ({ version: idx.out.size + Number(doc.updatedAt.length) + Math.random(), of: (id) => fc.reach.get(id)?.p ?? 0 }) });
    const { ref } = refRun(doc, s);
    try {
      sameImpact(eng, ref, { flips: rand() < 0.3, fams: 2, details: true }, doc);
    } catch (e) {
      throw new Error(`${what} の後で食い違い: ${(e as Error).message}`);
    }
    results++;
    if (eng === last) same++;
    last = eng;
  };
  check("最初");
  const options = () => Object.values(store.doc.nodes).filter((n) => typeof n.meta.ak === "string");
  const chances = () => Object.values(store.doc.edges).filter((e) => typeof e.meta.prob === "number");
  for (let step = 0; step < opts.steps; step++) {
    const u = rand();
    let what = "";
    if (u < 0.3) {
      const n = pick(options());
      const s = pick(["active", "done", "dropped", "open"] as const);
      what = `状態 ${n.id} → ${s}`;
      store.transact(what, (tx) => tx.updateNode(n.id, { status: s }));
    } else if (u < 0.4) {
      const e = pick(chances());
      const p = Math.round(rand() * 100);
      what = `見込み ${e.id} → ${p}`;
      store.transact(what, (tx) => tx.updateEdge(e.id, { meta: { ...e.meta, prob: p } }));
    } else if (u < 0.48) {
      sid = pick([null, "s_balance", "s_early", "s_focus", ...(opts.sids ?? [])]);
      what = `方針 ${sid}`;
    } else if (u < 0.55) {
      const root = Object.values(store.doc.nodes).find((n) => n.meta.forecastRoot === true)!;
      const annual = pick([360, 480, 540, 720]);
      what = `年収 ${annual}`;
      store.transact(what, (tx) => tx.updateNode(root.id, { meta: { ...root.meta, impact: { ...(root.meta.impact as object), annual } } }));
    } else if (u < 0.63) {
      const n = pick(Object.values(store.doc.nodes));
      what = `題名 ${n.id}`;
      store.transact(what, (tx) => tx.updateNode(n.id, { title: `${n.title}あ` }));
    } else if (u < 0.68) {
      const e = pick(Object.values(store.doc.edges).filter((x) => x.relation === "leads" && typeof store.doc.nodes[x.target]?.meta.ak === "string"));
      what = `線のシナリオ ${e.id}`;
      store.transact(what, (tx) => tx.updateEdge(e.id, { scenarioIds: e.scenarioIds.length ? [] : ["s_early"] }));
    } else if (u < 0.74) {
      const n = pick(options());
      const id = `u_${step}`;
      what = `子を足す ${n.id}`;
      store.transact(what, (tx) => {
        tx.addNode(makeNode({ id, title: "自分の手", type: "result", meta: { m: 36, rr: [1, 0, 0] } }));
        tx.addEdge(makeEdge({ id: `e_${id}`, source: n.id, target: id, relation: "condition", meta: { prob: 10 } }));
      });
    } else if (u < 0.78) {
      const n = pick(Object.values(store.doc.nodes).filter((x) => x.meta.end === true));
      what = `行き先を消す ${n.id}`;
      store.transact(what, (tx) => tx.deleteNode(n.id));
    } else if (u < 0.82) {
      const e = pick(chances());
      what = `線の関係 ${e.id}`;
      store.transact(what, (tx) => tx.updateEdge(e.id, { relation: "supports" }));
    } else if (u < 0.86) {
      const n = pick(options());
      what = `meta.h ${n.id}`;
      store.transact(what, (tx) => tx.updateNode(n.id, { meta: { ...n.meta, h: 9 } }));
    } else if (u < 0.93) {
      what = "元に戻す";
      store.undo();
    } else if (u < 0.97) {
      what = "やり直す";
      store.redo();
    } else {
      what = "全部の入れ替え";
      store.load(structuredClone(store.doc));
    }
    check(what);
  }
  return { results, same };
}

describe("エンジン: 文書を変えながら、変わった所だけやり直した答えが最初から数えた答えと同じ", () => {
  it("版 6 の地図（状態・% ・方針・年収・題名・線のシナリオ・子を足す・消す・線の関係・meta・元に戻す・入れ替え）", () => {
    const doc = buildImpactDoc(r6Bundle(), new Date(2026, 10, 19), "test");
    const r = driveStore(doc, { seed: 42, steps: 60 });
    expect(r.results).toBe(61);
    // 題名・方針を選ばない操作などで、同じ結果の物を返した所がある
    expect(r.same).toBeGreaterThan(0);
  });

  it("3 か月ごとの小さい地図（同梱の地図の列から作り、形を変えたら文書から作り直す）", async () => {
    const map = await loadQSmall();
    const doc = buildQuarterDoc(map, { version: map.header.hash, release: map.header.release, at: Date.UTC(2026, 10, 1) });
    const r = driveStore(doc, { map, seed: 7, steps: 50 });
    expect(r.results).toBe(51);
  });
});

describe("エンジン: 見分けにくい変更も、変わった所だけやり直した答えが最初から数えた答えと同じ", () => {
  /** 手で作った文書をストアに入れ、変更ごとにエンジン（変わった所だけ）と基準（最初から）を比べる */
  function steps(doc: DocData, list: Array<[string, (store: Store) => void]>, sid: ID | null = null): void {
    const store = new Store(doc);
    const engine = new ImpactEngine();
    store.on("change", (info) => engine.note(store.doc, info));
    const check = (what: string) => {
      const idx = buildIndex(store.doc);
      // 見え方（ViewModel）と同じく、文書に無い方針は null にして渡す
      const s = sid && store.doc.scenarios[sid] ? sid : null;
      const fc = computeForecast(store.doc, idx.out, s);
      const eng = engine.result({ doc: store.doc, sid: s, out: () => idx.out, reach: () => ({ version: Math.random(), of: (id) => fc.reach.get(id)?.p ?? 0 }) });
      try {
        sameImpact(eng, refRun(store.doc, sid).ref, {}, store.doc);
      } catch (e) {
        throw new Error(`${what} の後で食い違い: ${(e as Error).message}`);
      }
    };
    check("最初");
    for (const [what, fn] of list) {
      fn(store);
      check(what);
    }
  }
  const upd = (id: string, patch: Partial<GNode>) => (s: Store) => s.transact("ノード", (tx) => tx.updateNode(id, patch));
  const updE = (id: string, patch: Partial<GEdge>) => (s: Store) => s.transact("線", (tx) => tx.updateEdge(id, patch));

  it("種類（meta.fork の無いノード）・% の有る無し・期限だけの月・期間・数字なしの手の入口の印・方針を消す", () => {
    const { doc, node, edge } = tree({ annual: 360 });
    // meta.fork の無い分かれ（種類と % で分かれ道の種類が決まる）と、月の無い（期限だけの）ノード
    node("G", "goal", { rank: 7 }, { time: { due: "2027-05-18", start: null } });
    edge("R", "G");
    node("G1", "result", { rr: [1, 1, 0] }, { time: { due: "2027-11-18", start: null } });
    node("G2", "result", { rr: [1, 2, 0] }, { time: { due: "2028-05-18", start: null } });
    edge("G", "G1");
    edge("G", "G2");
    // 数字なしの手（入口の印を付けると数字なしでなくなる）
    node("N", "action", { rank: 8 });
    edge("R", "N");
    steps(doc, [
      ["種類を分岐に（判断になる）", upd("G", { type: "branch" })],
      ["種類を行動に（結果になる）", upd("G", { type: "action" })],
      ["% を書く（結果になる）", updE("G-G1", { meta: { prob: 30 } })],
      ["% を消す", updE("G-G1", { meta: {} })],
      ["期限だけの月を変える", upd("G1", { time: { due: "2028-11-18", start: null } })],
      ["入口の期限を変える", (s) => s.transact("入口", (tx) => tx.updateNode("R", { time: { due: "2026-12-18", start: null } }))],
      ["期間を 24 か月に", (s) => s.transact("期間", (tx) => tx.updateNode("R", { meta: { ...s.doc.nodes.R!.meta, impact: { v: 2, horizon: 24, annual: 360 } } }))],
      ["数字なしの手に入口の印", (s) => s.transact("印", (tx) => tx.updateNode("N", { meta: { ...s.doc.nodes.N!.meta, forecastRoot: true } }))],
      ["数字なしの手を選ぶ", upd("N", { status: "active" })],
      ["方針の線のシナリオを変える", updE("R-A", { scenarioIds: ["s2"] })],
      ["方針を消す", (s) => s.transact("方針", (tx) => tx.deleteScenario("s1"))],
      ["線を付け替える（合流）", updE("G-G2", { target: "A1" })],
      ["線を消す", (s) => s.transact("消す", (tx) => tx.deleteEdge("G-G1"))],
      ["入口を足す", (s) => s.transact("入口", (tx) => tx.addNode(makeNode({ id: "R2", title: "R2", type: "goal", meta: { forecastRoot: true, impact: { v: 2, horizon: 36 }, fork: "decision", m: 0, rr: [1, 0, 0] } })))],
      ["足した入口から線", (s) => s.transact("線", (tx) => tx.addEdge(makeEdge({ id: "R2-K", source: "R2", target: "K", relation: "leads" })))],
    ], "s1");
  });

  it("循環に入ったノードの線を消す・循環を作る", () => {
    const { doc, node, edge } = tree({ annual: 360 });
    node("C1", "action");
    node("C2", "action");
    edge("A2", "C1");
    edge("C1", "C2");
    edge("C2", "C1");
    steps(doc, [
      ["循環を切る", (s) => s.transact("消す", (tx) => tx.deleteEdge("C2-C1"))],
      ["循環を作り直す", (s) => s.transact("線", (tx) => tx.addEdge(makeEdge({ id: "C2-C1b", source: "C2", target: "C1", relation: "leads" })))],
      ["循環のノードの題名", upd("C1", { title: "循環" })],
    ]);
  });
});

describe("エンジン: 計算し直す時", () => {
  it("題名・本文・位置・線の説明だけの変更では同じ結果、状態・% ・年収・方針では新しい結果。状態だけなら形と数は作り直さない", async () => {
    const map = await loadQSmall();
    const doc = buildQuarterDoc(map, { version: map.header.hash, release: map.header.release, at: Date.UTC(2026, 10, 1) });
    const store = new Store(doc);
    const engine = new ImpactEngine();
    engine.useMap({ map, doc: store.doc });
    store.on("change", (info) => engine.note(store.doc, info));
    let sid: ID | null = null;
    const res = () => engine.result({ doc: store.doc, sid, out: () => buildIndex(store.doc).out, reach: () => ({ version: 0, of: () => 0 }) });
    const a0 = res();
    expect(engine.lastCompile).toBe("map");
    const v0 = { ...engine.version };
    const opt = Object.values(store.doc.nodes).find((n) => typeof n.meta.ak === "string" && n.meta.base !== true)!;
    const edge = Object.values(store.doc.edges).find((e) => typeof e.meta.prob === "number")!;
    store.transact("題名", (tx) => tx.updateNode(opt.id, { title: "新しい題名" }));
    store.transact("本文", (tx) => tx.updateNode(opt.id, { body: "本文" }));
    store.transact("位置", (tx) => tx.updateNode(opt.id, { x: 5, y: 7 }));
    store.transact("線の説明", (tx) => tx.updateEdge(edge.id, { label: "説明", condition: "条件" }));
    expect(res()).toBe(a0);
    store.transact("状態", (tx) => tx.updateNode(opt.id, { status: "active" }));
    const a1 = res();
    expect(a1).not.toBe(a0);
    expect(engine.version.topology).toBe(v0.topology);
    expect(engine.version.numbers).toBe(v0.numbers);
    expect(engine.version.statuses).toBe(v0.statuses + 1);
    expect(a1.alt.get(opt.id)!.picked).toBe(true);
    sid = "s_early";
    const a2 = res();
    expect(a2).not.toBe(a1);
    expect(engine.version.numbers).toBe(v0.numbers);
    store.transact("% ", (tx) => tx.updateEdge(edge.id, { meta: { ...edge.meta, prob: 3 } }));
    const a3 = res();
    expect(a3).not.toBe(a2);
    expect(engine.version.topology).toBe(v0.topology);
    expect(engine.version.numbers).toBe(v0.numbers + 1);
    const root = store.doc.nodes[a3.root!]!;
    store.transact("年収", (tx) => tx.updateNode(root.id, { meta: { ...root.meta, impact: { v: 2, horizon: 36, annual: 600 } } }));
    const a4 = res();
    expect(a4.annual).toBe(600);
    expect(engine.version.numbers).toBe(v0.numbers + 1);
    // 形を変えると文書から作り直す（もう組み立てたままではない）
    store.transact("消す", (tx) => tx.deleteEdge(edge.id));
    res();
    expect(engine.lastCompile).toBe("doc");
    expect(engine.version.topology).toBe(v0.topology + 1);
  });

  it("年収を仮から 360（仮と同じ値）に入れると「入れた」になり、入れた 360 を外すと仮に戻る（計算は同じ物を使う: 見直し equiv-2）", () => {
    const doc = buildImpactDoc(r6Bundle(), new Date(2026, 10, 19), "test");
    const store = new Store(doc);
    const engine = new ImpactEngine();
    store.on("change", (info) => engine.note(store.doc, info));
    const res = () => engine.result({ doc: store.doc, sid: null, out: () => buildIndex(store.doc).out, reach: () => ({ version: 0, of: () => 0 }) });
    const setAnnual = (a: number | null) => {
      const root = store.doc.nodes[res().root!]!;
      const impact = { ...(root.meta.impact as Record<string, unknown>) };
      if (a === null) delete impact.annual;
      else impact.annual = a;
      store.transact("年収", (tx) => tx.updateNode(root.id, { meta: { ...root.meta, impact } }));
    };
    const check = (want: boolean) => {
      const r = res();
      expect(r.annualSet).toBe(want);
      expect(r.annual).toBe(360);
      const out = buildIndex(store.doc).out;
      const base = computeImpact(store.doc, out, computeForecast(store.doc, out));
      expect(r.annualSet).toBe(base.annualSet);
      return r;
    };
    setAnnual(null);
    const a0 = check(false);
    const passes = engine.timings.passes;
    setAnnual(360);
    const a1 = check(true);
    expect(a1).not.toBe(a0);
    expect(a1.vRoot).toBe(a0.vRoot);
    setAnnual(null);
    check(false);
    setAnnual(360);
    check(true);
    // 新しいエンジンで入れた 360 から外す
    const engine2 = new ImpactEngine();
    const r2 = () => engine2.result({ doc: store.doc, sid: null, out: () => buildIndex(store.doc).out, reach: () => ({ version: 0, of: () => 0 }) });
    expect(r2().annualSet).toBe(true);
    store.on("change", (info) => engine2.note(store.doc, info));
    setAnnual(null);
    expect(r2().annualSet).toBe(false);
    expect(passes).toBeGreaterThanOrEqual(0);
  });

  it("やらない場合の差は数だけを覚え、計算の入れ物はエンジンに 1 つ（カードを開くたびに地図の大きさの配列を残さない: 見直し perf-2・perf-3）", async () => {
    const map = await loadQSmall();
    const doc = buildQuarterDoc(map, { version: map.header.hash, release: map.header.release, at: Date.UTC(2026, 10, 1) });
    withAnnual(doc, 360);
    const { ref } = refRun(doc);
    const fromMap = engRun(doc, null, { map });
    const eng = fromMap.eng;
    // 同じ答え（判断の先だけの計算・全部の計算とも）
    for (const f of ref.families()) {
      const a = eng.never(f);
      const b = ref.never(f);
      expect(Math.abs((a.k ?? NaN) - (b.k ?? NaN))).toBeLessThan(1e-9 * Math.max(1, Math.abs(b.k ?? 0)));
      for (const [id, v] of b.card) expect(Math.abs(a.card.get(id)! - v)).toBeLessThan(1e-9 * Math.max(1, Math.abs(v)));
    }
    // 結果は計算（Pass）を持たない: 覚えているのは数だけ
    const kept = (x: unknown, seen = new Set<unknown>(), depth = 0): number => {
      if (!x || typeof x !== "object" || seen.has(x) || depth > 4) return 0;
      seen.add(x);
      if (ArrayBuffer.isView(x)) return 0;
      let n = 0;
      for (const v of Object.values(x as Record<string, unknown>)) {
        if (v && typeof v === "object" && "V" in (v as object) && "pi" in (v as object) && "def" in (v as object)) n++;
        else n += kept(v, seen, depth + 1);
      }
      if (x instanceof Map) for (const v of x.values()) n += v && typeof v === "object" && "V" in (v as object) && "pi" in (v as object) ? 1 : kept(v, seen, depth + 1);
      return n;
    };
    const res = eng as unknown as { neverMemo: Map<string, unknown> };
    expect(kept(res.neverMemo)).toBe(0);
    // 同じ入れ物を使い回す（家族ごと・判断ごとに作らない）
    const engine = fromMap.engine as unknown as { scratchPass: { def: Uint8Array } | null };
    const sp = engine.scratchPass;
    expect(sp).not.toBeNull();
    expect(sp!.def.length).toBe(ref.counts.nodes);
    for (const f of ref.families()) for (const id of [...ref.never(f).card.keys()].slice(0, 5)) eng.never(f).card.get(id);
    expect(engine.scratchPass).toBe(sp);
  });

  it("年収の境目は 1 回の計算ずつ進められ、同じ版なら覚えた答えを使う", () => {
    const doc = buildImpactDoc(r6Bundle(), new Date(2026, 10, 19), "test");
    withAnnual(doc, 360);
    const { ref } = refRun(doc);
    const { eng } = engRun(doc);
    expect(eng.salaryFlipsReady()).toBeNull();
    let steps = 0;
    let f = eng.salaryFlipsStep();
    while (!f) {
      steps++;
      f = eng.salaryFlipsStep();
    }
    expect(steps).toBeGreaterThan(3);
    expect(f).toEqual(ref.salaryFlips());
    expect(eng.salaryFlipsReady()).toBe(f);
  });
});
