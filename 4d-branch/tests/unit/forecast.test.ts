import { describe, expect, it } from "vitest";
import { buildFutureDoc, countFuture, type FutureData } from "../../src/demo/future";
import { buildFuture, futureData, futureVersion } from "../../src/demo/futureBundle";
import { futureMaps, nearFutureRoot, staleFutureMaps, swapFutureDoc } from "../../src/demo/futureSwap";
import { buildDemoDoc, isDisposableDoc } from "../../src/demo/demo";
import { mergeDocs } from "../../src/persist/io";
import { NODE_H, NODE_W } from "../../src/model/constants";
import { computeForecast, edgeProb, formatPercent } from "../../src/model/forecast";
import { buildIndex } from "../../src/model/graph";
import { createEmptyDoc, makeEdge, makeNode, normalizeDoc } from "../../src/model/schema";
import type { DocData, GEdge, NodeType, Relation } from "../../src/model/types";

/** "R>F, F>A:30, F>B:70" の形でグラフを作る。R は予測の入口。分岐は名前が F で始まるノード */
function graph(spec: string, opts: { scen?: Record<string, string[]>; rel?: Record<string, Relation> } = {}): DocData {
  const doc = createEmptyDoc();
  const ensure = (name: string) => {
    if (!doc.nodes[name]) {
      const type: NodeType = name.startsWith("F") ? "branch" : "action";
      doc.nodes[name] = makeNode({ id: name, title: name, type, meta: name === "R" ? { forecastRoot: true } : {} });
    }
    return name;
  };
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [path, prob] = part.split(":");
    const ids = path!.split(">").map((s) => ensure(s.trim()));
    for (let i = 0; i + 1 < ids.length; i++) {
      const id = `${ids[i]}${ids[i + 1]}`;
      const e: GEdge = makeEdge({ id, source: ids[i]!, target: ids[i + 1]!, relation: opts.rel?.[id] ?? (prob ? "condition" : "leads"), scenarioIds: opts.scen?.[id] ?? [] });
      if (prob && i === ids.length - 2) e.meta = { prob: Number(prob) };
      doc.edges[id] = e;
    }
  }
  return doc;
}
const run = (doc: DocData, scenario: string | null = null) => computeForecast(doc, buildIndex(doc).out, scenario);

describe("見込みの計算", () => {
  it("予測の入口が無ければ出さない", () => {
    const doc = graph("A>B");
    delete doc.nodes.A!.meta.forecastRoot;
    const r = run(doc);
    expect(r.active).toBe(false);
    expect(r.reach.size).toBe(0);
  });

  it("分かれ道の見込みの割合で分け、行き先を見込みの高い順に並べる", () => {
    const r = run(graph("R>F1, F1>X:30, F1>Y:70"));
    expect(r.active).toBe(true);
    expect(r.reach.get("R")!.p).toBe(1);
    expect(r.reach.get("X")!.p).toBeCloseTo(0.3);
    expect(r.reach.get("Y")!.p).toBeCloseTo(0.7);
    expect(r.ends).toEqual(["Y", "X"]);
    expect(r.reach.get("Y")!.minSteps).toBe(2);
    expect(r.longest).toBe(2);
  });

  it("合流では足し合わせ、歩数はいちばん短い道と長い道の両方を持つ", () => {
    const r = run(graph("R>F1, F1>A:60, F1>B:40, A>M, B>C>M"));
    expect(r.reach.get("M")!.p).toBeCloseTo(1);
    expect(r.reach.get("M")!.minSteps).toBe(3);
    expect(r.reach.get("M")!.maxSteps).toBe(4);
    expect(r.longest).toBe(4);
    expect(r.ends).toEqual(["M"]);
  });

  it("分かれ道が続くと掛け合わせになる", () => {
    const r = run(graph("R>F1, F1>A:50, F1>B:50, A>F2, F2>C:20, F2>D:80"));
    expect(r.reach.get("C")!.p).toBeCloseTo(0.1);
    expect(r.reach.get("D")!.p).toBeCloseTo(0.4);
    expect(r.reach.get("B")!.p).toBeCloseTo(0.5);
    const total = r.ends.reduce((n, id) => n + r.reach.get(id)!.p, 0);
    expect(total).toBeCloseTo(1);
  });

  it("シナリオを選ぶと、そのシナリオの線だけで流し、分かれ道ごとに配り直す", () => {
    const doc = graph("R>F1, F1>A:60, F1>B:40, A>F2, F2>C:25, F2>D:75", { scen: { F1A: ["s1"], F1B: ["s2"], AF2: ["s1"], F2C: ["s1"], F2D: ["s1"] } });
    const all = run(doc);
    expect(all.reach.get("C")!.p).toBeCloseTo(0.15);
    const s1 = run(doc, "s1");
    expect(s1.reach.get("A")!.p).toBeCloseTo(1);
    expect(s1.reach.get("C")!.p).toBeCloseTo(0.25);
    expect(s1.reach.has("B")).toBe(false);
    const s2 = run(doc, "s2");
    expect(s2.reach.get("B")!.p).toBeCloseTo(1);
    expect(s2.reach.has("A")).toBe(false);
  });

  it("見込みの無い線には残りを等分する。合計が 100 を超えても割合で分ける", () => {
    const doc = graph("R>F1, F1>A:50, F1>B, F1>C");
    doc.edges.F1B!.relation = "condition";
    doc.edges.F1C!.relation = "condition";
    const r = run(doc);
    expect(r.reach.get("A")!.p).toBeCloseTo(0.5);
    expect(r.reach.get("B")!.p).toBeCloseTo(0.25);
    expect(r.reach.get("C")!.p).toBeCloseTo(0.25);
    const over = run(graph("R>F1, F1>A:90, F1>B:60"));
    expect(over.reach.get("A")!.p).toBeCloseTo(0.6);
    expect(over.reach.get("B")!.p).toBeCloseTo(0.4);
  });

  it("分岐でないノードの先は両方とも同じ見込み。合流しても 100% を超えない", () => {
    const r = run(graph("R>A, R>B, A>M, B>M"));
    expect(r.reach.get("A")!.p).toBe(1);
    expect(r.reach.get("B")!.p).toBe(1);
    expect(r.reach.get("M")!.p).toBe(1);
  });

  it("相乗効果・阻害・循環の線は見込みに入れず、循環に入ったノードには見込みを出さない", () => {
    const doc = graph("R>F1, F1>A:40, F1>B:60, A>B, B>C>D>C", { rel: { AB: "supports" } });
    const r = run(doc);
    expect(r.reach.get("B")!.p).toBeCloseTo(0.6);
    expect(r.reach.has("C")).toBe(false);
    expect(r.reach.has("D")).toBe(false);
  });

  it("線の見込みは 0〜100 に収め、数でなければ無いものとする", () => {
    const e = makeEdge({ source: "a", target: "b" });
    expect(edgeProb({ ...e, meta: { prob: 150 } })).toBe(100);
    expect(edgeProb({ ...e, meta: { prob: -5 } })).toBe(0);
    expect(edgeProb({ ...e, meta: { prob: "30" } })).toBeNull();
    expect(edgeProb({ ...e, meta: { prob: Number.NaN } })).toBeNull();
    expect(edgeProb(e)).toBeNull();
  });

  it("見込みの表し方", () => {
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(0.4249)).toBe("42%");
    expect(formatPercent(0.034)).toBe("3.4%");
    expect(formatPercent(0.03)).toBe("3%");
    expect(formatPercent(0.004)).toBe("0.4%");
    expect(formatPercent(0.0001)).toBe("0.1% 未満");
    expect(formatPercent(0)).toBe("0%");
  });
});

/** 小さな未来の道筋: 今日 → 歩み 2 つ → 分かれ道 → 6 か月目の 3 つの道 → 寄り道つきの歩み → 10 年後 */
function sample(): FutureData {
  return {
    v: 1,
    title: "未来の道筋（テスト）",
    states: [
      ["S0", 0, "start", "今日", "今の姿"],
      ["B6", 6, "base", "両立を続ける", "姿"],
      ["E6", 6, "early", "独立の準備", "姿"],
      ["F6", 6, "focus", "SpellDash に寄せる", "姿"],
      ["B120a", 120, "base", "10 年後: 会社員と副業", "姿"],
      ["E120a", 120, "early", "10 年後: 独立", "姿"],
      ["F120a", 120, "focus", "10 年後: SpellDash", "姿"],
    ],
    steps: [
      ["t1", "action", "歩み 1", "", 1, "spell", ["1時間"], [], "S0"],
      ["t2", "action", "歩み 2", "", 3, "fc", ["半日"], [], "S0"],
      ["t3", "branch", "半年の結果でどの道へ", "", 6, "ind", ["判断"], [], "S0"],
      ["b1", "branch", "両立の分かれ道", "", 8, "fc", [], [], "B6"],
      ["b2", "action", "本線", "", 9, "fc", [], [], "B6"],
      ["b3", "action", "本線 2", "", 10, "fc", [], [], "B6"],
      ["b4", "action", "本線 3", "", 11, "fc", [], [], "B6"],
      ["d1", "branch", "寄り道の分かれ道", "", 9, "fc", [], [], "B6"],
      ["d2", "action", "寄り道 A", "", 10, "fc", [], [], "B6"],
      ["d3", "action", "寄り道 B", "", 10, "fc", [], [], "B6"],
      ["e1", "action", "独立の歩み", "", 9, "ind", [], [], "E6"],
      ["f1", "action", "SpellDash の歩み", "", 9, "spell", [], [], "F6"],
    ],
    links: [
      ["S0", "t1", "", null, ""],
      ["t1", "t2", "", null, ""],
      ["t2", "t3", "", null, ""],
      ["t3", "B6", "どちらも届かない", 70, "両立"],
      ["t3", "E6", "副業の顧客 2 社", 20, "独立へ"],
      ["t3", "F6", "有料会員 30 人", 10, "SpellDash へ"],
      ["B6", "b1", "", null, ""],
      ["b1", "b2", "続ける", 60, ""],
      ["b1", "d1", "寄り道", 40, ""],
      ["b2", "b3", "", null, ""],
      ["b3", "b4", "", null, ""],
      ["d1", "d2", "A", 50, ""],
      ["d1", "d3", "B", 50, ""],
      ["d2", "b4", "", null, ""],
      ["d3", "b4", "", null, ""],
      ["b4", "B120a", "", null, ""],
      ["E6", "e1", "", null, ""],
      ["e1", "E120a", "", null, ""],
      ["F6", "f1", "", null, ""],
      ["f1", "F120a", "", null, ""],
    ],
  };
}

describe("未来の道筋の組み立て", () => {
  const TODAY = new Date(2026, 10, 10);

  it("入口・節目・行き先・歩みのノードと、分かれ道の見込みつきの線ができる", () => {
    const data = sample();
    const doc = buildFutureDoc(data, TODAY);
    expect(Object.keys(doc.nodes).length).toBe(data.states.length + data.steps.length);
    expect(Object.keys(doc.edges).length).toBe(data.links.length);
    const root = doc.nodes.n_f_S0!;
    expect(root.meta.forecastRoot).toBe(true);
    expect(root.type).toBe("goal");
    expect(root.time.due).toBe("2026-11-10");
    expect(doc.nodes.n_f_B6!.type).toBe("result");
    expect(doc.nodes.n_f_B120a!.type).toBe("goal");
    expect(doc.nodes.n_f_B120a!.tags).toContain("10年後");
    expect(doc.nodes.n_f_B120a!.time.due).toBe("2036-11-30");
    expect(doc.nodes.n_f_t1!.tags).toEqual(["1時間"]);
    const fork = Object.values(doc.edges).filter((e) => e.source === "n_f_t3");
    expect(fork.map((e) => [e.relation, e.condition, e.meta.prob])).toEqual([
      ["condition", "どちらも届かない", 70],
      ["condition", "副業の顧客 2 社", 20],
      ["condition", "有料会員 30 人", 10],
    ]);
    expect(countFuture(data)).toEqual({ steps: 12, forks: 3, ends: 3, states: 7 });
  });

  it("6 か月目までは全シナリオ共通、その先は 6 か月目の道ごとのシナリオに入る", () => {
    const doc = buildFutureDoc(sample(), TODAY);
    expect(doc.nodes.n_f_t2!.scenarioIds).toEqual([]);
    expect(doc.nodes.n_f_B6!.scenarioIds).toEqual(["s_balance"]);
    expect(doc.nodes.n_f_d2!.scenarioIds).toEqual(["s_balance"]);
    expect(doc.nodes.n_f_f1!.scenarioIds).toEqual(["s_focus"]);
    const toEarly = Object.values(doc.edges).find((e) => e.source === "n_f_t3" && e.target === "n_f_E6")!;
    expect(toEarly.scenarioIds).toEqual(["s_early"]);
    const inTrunk = Object.values(doc.edges).find((e) => e.source === "n_f_t1")!;
    expect(inTrunk.scenarioIds).toEqual([]);
  });

  it("ノードが重ならず、時間の順に左から右へ並ぶ（寄り道が 2 つに分かれても止まらない）", () => {
    const doc = buildFutureDoc(sample(), TODAY);
    const nodes = Object.values(doc.nodes);
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        const apart = Math.abs(a.x - b.x) >= NODE_W || Math.abs(a.y - b.y) >= NODE_H;
        expect(apart, `${a.title} / ${b.title}`).toBe(true);
      }
    for (const e of Object.values(doc.edges)) expect(doc.nodes[e.target]!.x, e.id).toBeGreaterThan(doc.nodes[e.source]!.x);
    // 寄り道の 2 つ（同じ層）は別の段
    expect(doc.nodes.n_f_d2!.y).not.toBe(doc.nodes.n_f_d3!.y);
  });

  it("検証で直されず、見込みは行き先で合計 100%", () => {
    const doc = buildFutureDoc(sample(), TODAY);
    const { report } = normalizeDoc(JSON.parse(JSON.stringify(doc)));
    expect(report.warnings).toEqual([]);
    const r = computeForecast(doc, buildIndex(doc).out);
    expect(r.ends.length).toBe(3);
    expect(r.ends.reduce((n, id) => n + r.reach.get(id)!.p, 0)).toBeCloseTo(1);
    expect(r.reach.get("n_f_B120a")!.p).toBeCloseTo(0.7);
    expect(r.reach.get("n_f_d2")!.p).toBeCloseTo(0.7 * 0.4 * 0.5);
  });
});

describe("同梱の未来の道筋", () => {
  const data = futureData();
  const TODAY = new Date(2026, 10, 10);

  it("key が重ならず、線の両端があり、分かれ道は 2 本以上で見込みの合計が 100、ほかの歩みは先が 1 本", () => {
    const keys = [...data.states.map((s) => s[0]), ...data.steps.map((s) => s[0])];
    expect(new Set(keys).size).toBe(keys.length);
    const known = new Set(keys);
    const out = new Map<string, FutureData["links"]>();
    for (const l of data.links) {
      expect(known.has(l[0]) && known.has(l[1]), `${l[0]} → ${l[1]}`).toBe(true);
      out.set(l[0], [...(out.get(l[0]) ?? []), l]);
    }
    for (const s of data.steps) {
      const o = out.get(s[0]) ?? [];
      if (s[1] === "branch") {
        expect(o.length, s[0]).toBeGreaterThanOrEqual(2);
        expect(o.every((l) => typeof l[3] === "number" && l[3] >= 1 && l[2].trim().length > 0), s[0]).toBe(true);
        expect(o.reduce((n, l) => n + (l[3] ?? 0), 0), s[0]).toBe(100);
      } else expect(o.length, s[0]).toBe(1);
    }
  });

  it("判断の線はほかの線を並び順で指さず、名前で指す線はその分かれ道に名前がある", () => {
    // 地図の上では線の上下が決まらない（縮小や寄り道で並びが変わる）ので、「上の 2 つ」のようには書かない。
    // ほかの線は「ほかの 2 本の線」か、線の終わりに付けた名前「（利益の線）」で指す
    const positional = /(?<![以売向最頂地途格つ段])(上|下)(の|に|と)(?!限)|すぐ(上|下)|いちばん(上|下)/;
    expect(data.links.filter((l) => positional.test(l[2])).map((l) => `${l[0]} → ${l[1]}: ${l[2]}`)).toEqual([]);
    const tag = /（([^（）]+?)の線）/g;
    const ref = /の線に(?:も)?(?:届か|当たら|当たる)|の線にも/g;
    const byFork = new Map<string, FutureData["links"]>();
    for (const l of data.links) byFork.set(l[0], [...(byFork.get(l[0]) ?? []), l]);
    const unnamed: string[] = [];
    for (const [k, ls] of byFork) {
      const names = ls.flatMap((l) => [...l[2].matchAll(tag)].map((m) => m[1]!));
      for (const l of ls) {
        const w = l[2].replace(tag, "");
        for (const m of w.matchAll(ref)) if (!names.some((n) => w.slice(0, m.index).endsWith(n))) unnamed.push(`${k} → ${l[1]}: ${l[2]}`);
      }
    }
    expect(unnamed).toEqual([]);
  });

  it("節目は 0〜120 か月目、線に沿って時間が戻らない", () => {
    const month = new Map<string, number>([...data.states.map((s) => [s[0], s[1]] as const), ...data.steps.map((s) => [s[0], s[4]] as const)]);
    for (const s of data.states) expect([0, 6, 12, 24, 36, 60, 84, 120]).toContain(s[1]);
    for (const l of data.links) expect(month.get(l[1])!, `${l[0]} → ${l[1]}`).toBeGreaterThanOrEqual(month.get(l[0])!);
  });

  it("組み立てて検証しても直されず、すべてのノードに今日から届き、行き先の見込みは合計 100%", () => {
    const { pv, stats } = buildFuture(TODAY);
    expect(pv.report.warnings).toEqual([]);
    const doc = pv.doc;
    const r = computeForecast(doc, buildIndex(doc).out);
    expect(r.active).toBe(true);
    expect(r.reach.size).toBe(Object.keys(doc.nodes).length);
    expect(r.ends.length).toBe(stats.ends);
    expect(r.ends.every((id) => doc.nodes[id]!.tags.includes("10年後"))).toBe(true);
    expect(r.ends.reduce((n, id) => n + r.reach.get(id)!.p, 0)).toBeCloseTo(1, 9);
    // シナリオを選んだ場合も、行き先は 10 年後のノードだけ（途中で行き止まりにならない）で、見込みは合計 100%
    for (const sid of doc.scenarioOrder) {
      const s = computeForecast(doc, buildIndex(doc).out, sid);
      expect(s.ends.filter((id) => !doc.nodes[id]!.tags.includes("10年後")).map((id) => doc.nodes[id]!.title), sid).toEqual([]);
      expect(s.ends.reduce((n, id) => n + s.reach.get(id)!.p, 0), sid).toBeCloseTo(1, 9);
    }
  });

  it("どの道も、今日から 10 年後の行き先まで 200〜300 歩続く", () => {
    const { stats } = buildFuture(TODAY);
    expect(stats.shortest).toBeGreaterThanOrEqual(200);
    expect(stats.longest).toBeLessThanOrEqual(300);
    expect(stats.forks).toBeGreaterThanOrEqual(100);
  });

  it("ノードが重ならず、線はどれも左から右へ進む", () => {
    const doc = buildFuture(TODAY).pv.doc;
    const nodes = Object.values(doc.nodes).sort((a, b) => a.x - b.x);
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length && nodes[j]!.x - nodes[i]!.x < NODE_W; j++) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        expect(Math.abs(a.y - b.y) >= NODE_H, `${a.title} / ${b.title}`).toBe(true);
      }
    for (const e of Object.values(doc.edges)) expect(doc.nodes[e.target]!.x, e.id).toBeGreaterThan(doc.nodes[e.source]!.x);
  });
});

describe("未来の道筋の差し替え", () => {
  const TODAY = new Date(2026, 10, 10);

  it("入口からたどれるノードを未来の道筋として見つけ、版を読む（古い版で読み込んだものは版が無い）", () => {
    const doc = buildFutureDoc(sample(), TODAY, "v1");
    const maps = futureMaps(doc);
    expect(maps.length).toBe(1);
    expect(maps[0]!.version).toBe("v1");
    expect(maps[0]!.nodes.size).toBe(Object.keys(doc.nodes).length);
    expect(staleFutureMaps(doc, "v1")).toEqual([]);
    expect(staleFutureMaps(doc, "v2").length).toBe(1);
    expect(futureMaps(buildFutureDoc(sample(), TODAY))[0]!.version).toBeNull();
    // 同梱の版は入口に残る
    const { pv } = buildFuture(TODAY);
    expect(futureMaps(pv.doc)[0]!.version).toBe(futureVersion());
  });

  it("未来の道筋だけを消して新しい版を同じ場所に入れ、ほかのノードとプロジェクト・シナリオはそのまま", () => {
    const base = buildDemoDoc();
    const own = makeNode({ title: "自分で足したメモ", x: -5000, y: -5000 });
    base.nodes[own.id] = own;
    const merged = mergeDocs(base, buildFutureDoc(sample(), TODAY, "old")).doc;
    const oldRoot = Object.values(merged.nodes).find((n) => n.meta.forecastRoot === true)!;
    const before = Object.keys(merged.nodes).length;
    const projects = merged.projectOrder.length;
    const scenarios = merged.scenarioOrder.length;
    // 新しい版: 歩みを 1 つ足したもの
    const next = sample();
    next.steps.push(["t2b", "action", "足した歩み", "", 2, "fc", ["1時間"], [], "S0"]);
    next.links = next.links.filter((l) => !(l[0] === "t1" && l[1] === "t2"));
    next.links.push(["t1", "t2b", "", null, ""], ["t2b", "t2", "", null, ""]);
    const res = swapFutureDoc(merged, buildFutureDoc(next, TODAY, "new"));
    const doc = res.doc;
    expect(res.removed).toBe(sample().states.length + sample().steps.length);
    expect(res.added).toBe(next.states.length + next.steps.length);
    expect(Object.keys(doc.nodes).length).toBe(before + 1);
    expect(doc.nodes[own.id]?.title).toBe("自分で足したメモ");
    for (const id of Object.keys(base.nodes)) expect(doc.nodes[id], id).toBeDefined();
    expect(Object.values(doc.nodes).some((n) => n.title === "足した歩み")).toBe(true);
    const roots = Object.values(doc.nodes).filter((n) => n.meta.forecastRoot === true);
    expect(roots.length).toBe(1);
    expect(roots[0]!.meta.futureVersion).toBe("new");
    expect([roots[0]!.x, roots[0]!.y]).toEqual([oldRoot.x, oldRoot.y]);
    expect(doc.projectOrder.length).toBe(projects);
    expect(doc.scenarioOrder.length).toBe(scenarios);
    // 消した道筋の線は残らない
    for (const e of Object.values(doc.edges)) expect(doc.nodes[e.source] && doc.nodes[e.target], e.id).toBeTruthy();
    // 見込みは新しい版で計算できる
    const r = computeForecast(doc, buildIndex(doc).out);
    expect(r.ends.reduce((n, id) => n + r.reach.get(id)!.p, 0)).toBeCloseTo(1);
  });

  it("開いたときに寄る所: 入口（今日）から右へ 5 列・上下 600 まで。入口が無ければそのまま。開いた後はデモ扱いにならない", () => {
    const { pv } = buildFuture(TODAY);
    const doc = pv.doc;
    const root = Object.values(doc.nodes).find((n) => n.meta.forecastRoot === true)!;
    const near = nearFutureRoot(doc);
    expect(near).toContain(root.id);
    expect(near.length).toBeGreaterThanOrEqual(5);
    expect(near.length).toBeLessThan(Object.keys(doc.nodes).length / 5);
    for (const id of near) {
      const n = doc.nodes[id]!;
      expect(n.x >= root.x && n.x <= root.x + 1500 && Math.abs(n.y - root.y) <= 600, n.title).toBe(true);
    }
    // ids を渡すとその中から選ぶ。入口の無い文書・入口を含まない ids はそのまま返す
    const some = near.slice(0, 3);
    expect(nearFutureRoot(doc, some).every((id) => some.includes(id))).toBe(true);
    const demo = buildDemoDoc();
    expect(nearFutureRoot(demo)).toEqual(Object.keys(demo.nodes));
    // 何もしていないデモ・空は自動で開いてよいが、開いた後の未来の道筋は「捨ててよい」ではない（二度と勝手に入れ替えない）
    expect(isDisposableDoc(demo)).toBe(true);
    expect(isDisposableDoc(createEmptyDoc())).toBe(true);
    expect(isDisposableDoc(doc)).toBe(false);
  });

  it("未来の道筋が無い文書では、ふつうの追加と同じく右側に足す", () => {
    const base = buildDemoDoc();
    const res = swapFutureDoc(base, buildFutureDoc(sample(), TODAY, "v1"));
    expect(res.removed).toBe(0);
    expect(Object.keys(res.doc.nodes).length).toBe(Object.keys(base.nodes).length + res.added);
    const maxX = Math.max(...Object.values(base.nodes).map((n) => n.x));
    expect(res.doc.nodes[res.root!]!.x).toBeGreaterThan(maxX);
  });
});
