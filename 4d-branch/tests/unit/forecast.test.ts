import { describe, expect, it } from "vitest";
import { buildFuture, futureVersion } from "../../src/demo/futureBundle";
import { FRESH_FUTURE, NO_AUTO_FUTURE, futureMaps, hasFutureRoot, isFreshFuture, nearFutureRoot, staleFutureMaps, swapFutureDoc, withNoAutoFuture, yieldsToRemote } from "../../src/demo/futureSwap";
import { Store } from "../../src/store/store";
import { buildDemoDoc, isDisposableDoc } from "../../src/demo/demo";
import { mergeDocs } from "../../src/persist/io";
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

/** 古い版（v1）の形の小さな未来の道筋: 今日 → 歩み → 分かれ道（%）→ 行き先。差し替えの確かめに使う */
function oldFuture(version = "", extra = false): DocData {
  const doc = createEmptyDoc("未来の道筋（テスト）");
  const add = (id: string, type: NodeType, x: number, y: number, meta: Record<string, unknown> = {}) => {
    doc.nodes[id] = makeNode({ id, title: id, type, x, y, meta });
  };
  const link = (a: string, b: string, prob?: number) => {
    const e = makeEdge({ id: `e_${a}_${b}`, source: a, target: b, relation: prob === undefined ? "leads" : "condition" });
    if (prob !== undefined) e.meta = { prob };
    doc.edges[e.id] = e;
  };
  add("n_f_S0", "goal", 0, 0, { forecastRoot: true, ...(version ? { futureVersion: version } : {}) });
  add("n_f_t1", "action", 300, 0);
  add("n_f_F", "branch", 600, 0);
  add("n_f_A", "result", 900, -140);
  add("n_f_B", "result", 900, 140);
  link("n_f_S0", "n_f_t1");
  if (extra) {
    add("n_f_t2", "action", 450, 0);
    link("n_f_t1", "n_f_t2");
    link("n_f_t2", "n_f_F");
    doc.nodes.n_f_t2!.title = "足した歩み";
  } else link("n_f_t1", "n_f_F");
  link("n_f_F", "n_f_A", 60);
  link("n_f_F", "n_f_B", 40);
  return doc;
}

describe("未来の道筋の差し替え", () => {
  const TODAY = new Date(2026, 10, 10);

  it("入口からたどれるノードを未来の道筋として見つけ、版を読む（古い版で読み込んだものは版が無い）", () => {
    const doc = oldFuture("v1");
    const maps = futureMaps(doc);
    expect(maps.length).toBe(1);
    expect(maps[0]!.version).toBe("v1");
    expect(maps[0]!.nodes.size).toBe(Object.keys(doc.nodes).length);
    expect(staleFutureMaps(doc, "v1", 1)).toEqual([]);
    expect(staleFutureMaps(doc, "v2", 1).length).toBe(1);
    expect(futureMaps(oldFuture())[0]!.version).toBeNull();
    // 同梱の版は入口に残る
    const { pv } = buildFuture(TODAY);
    expect(futureMaps(pv.doc)[0]!.version).toBe(futureVersion());
  });

  it("未来の道筋だけを消して新しい版を同じ場所に入れ、ほかのノードとプロジェクト・シナリオはそのまま", () => {
    const base = buildDemoDoc();
    const own = makeNode({ title: "自分で足したメモ", x: -5000, y: -5000 });
    base.nodes[own.id] = own;
    const merged = mergeDocs(base, oldFuture("old")).doc;
    const oldRoot = Object.values(merged.nodes).find((n) => n.meta.forecastRoot === true)!;
    const before = Object.keys(merged.nodes).length;
    const projects = merged.projectOrder.length;
    const scenarios = merged.scenarioOrder.length;
    // 新しい版: 歩みを 1 つ足したもの
    const next = oldFuture("new", true);
    const res = swapFutureDoc(merged, next);
    const doc = res.doc;
    expect(res.removed).toBe(5);
    expect(res.added).toBe(6);
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

  it("開いたときに寄る所: 3 年の分かれ道は入口（今日）と選択肢、それより前の未来の道筋は入口から右へ 5 列・上下 600 まで。入口が無ければそのまま。開いた後はデモ扱いにならない", () => {
    const { pv } = buildFuture(TODAY);
    const doc = pv.doc;
    const root = Object.values(doc.nodes).find((n) => n.meta.forecastRoot === true)!;
    const kids = Object.values(doc.edges)
      .filter((e) => e.source === root.id)
      .map((e) => e.target);
    expect(kids.length).toBe(10);
    // 3 年の分かれ道: 今日と 10 の選択肢（見えている物だけで寄せ、左上にそろえるのは CanvasView.fit）
    expect(nearFutureRoot(doc)).toEqual([root.id, ...kids]);
    // ids を渡すとその中から選ぶ
    expect(nearFutureRoot(doc, [kids[3]!, root.id, "x", kids[1]!])).toEqual([root.id, kids[1]!, kids[3]!]);
    // それより前の未来の道筋（meta.impact の無い入口）: 右へ 5 列・上下 600 まで
    const v1 = createEmptyDoc();
    const at: Array<[string, number, number]> = [
      ["r", 0, 0],
      ["a", 300, 0],
      ["b", 1500, 600],
      ["far", 1800, 0],
      ["low", 600, 700],
    ];
    for (const [id, x, y] of at) v1.nodes[id] = makeNode({ id, title: id, x, y, meta: id === "r" ? { forecastRoot: true } : {} });
    for (const id of ["a", "b", "far", "low"]) v1.edges[`r${id}`] = makeEdge({ id: `r${id}`, source: "r", target: id });
    expect(nearFutureRoot(v1).sort()).toEqual(["a", "b", "r"]);
    // 入口の無い文書・入口を含まない ids はそのまま返す
    expect(nearFutureRoot(v1, ["a", "far"])).toEqual(["a", "far"]);
    const demo = buildDemoDoc();
    expect(nearFutureRoot(demo)).toEqual(Object.keys(demo.nodes));
    // 何もしていないデモ・空は自動で開いてよいが、開いた後の未来の道筋は「捨ててよい」ではない（二度と勝手に入れ替えない）
    expect(isDisposableDoc(demo)).toBe(true);
    expect(isDisposableDoc(createEmptyDoc())).toBe(true);
    expect(isDisposableDoc(doc)).toBe(false);
  });

  it("入れ替えない印: 写しに付き（元は変えない）、印があってもデモ・空は捨ててよいまま、保存・同期の形を通しても、「元に戻す」でも残る", () => {
    const demo = buildDemoDoc();
    const marked = withNoAutoFuture(demo);
    expect(marked.meta[NO_AUTO_FUTURE]).toBe(true);
    expect(demo.meta[NO_AUTO_FUTURE]).toBeUndefined();
    // 初めての同期の「聞かずにアカウントの内容を採る」は変わらない
    expect(isDisposableDoc(marked)).toBe(true);
    expect(isDisposableDoc(withNoAutoFuture(createEmptyDoc()))).toBe(true);
    // 保存・同期と同じく JSON を通して読み直しても残る
    expect(normalizeDoc(JSON.parse(JSON.stringify(marked))).doc.meta[NO_AUTO_FUTURE]).toBe(true);
    // 入れ替える直前に付けた印は、「元に戻す」で戻った地図にも残る（やり直すと未来の道筋）
    const { pv } = buildFuture(TODAY);
    const store = new Store(buildDemoDoc());
    store.doc.meta = { ...store.doc.meta, [NO_AUTO_FUTURE]: true };
    store.replaceDoc(pv.doc, "未来の道筋を開く");
    expect(hasFutureRoot(store.doc)).toBe(true);
    expect(store.doc.meta[NO_AUTO_FUTURE]).toBeUndefined();
    store.undo();
    expect(hasFutureRoot(store.doc)).toBe(false);
    expect(store.doc.meta[NO_AUTO_FUTURE]).toBe(true);
    expect(isDisposableDoc(store.doc)).toBe(true);
    store.redo();
    expect(hasFutureRoot(store.doc)).toBe(true);
    expect(hasFutureRoot(demo)).toBe(false);
  });

  it("開いたばかりの印: 入れ替えた直後に付けると、保存・同期の形を通しても残り、編集・元に戻す・やり直すで外れる", () => {
    const { pv } = buildFuture(TODAY);
    const store = new Store(buildDemoDoc());
    store.replaceDoc(pv.doc, "未来の道筋を開く");
    expect(isFreshFuture(store.doc)).toBe(false);
    store.doc.meta = { ...store.doc.meta, [FRESH_FUTURE]: store.doc.updatedAt };
    expect(isFreshFuture(store.doc)).toBe(true);
    // 閉じて開き直した（保存した形から読み直した）: まだ手を付けていない
    expect(isFreshFuture(normalizeDoc(JSON.parse(JSON.stringify(store.doc))).doc)).toBe(true);
    // 書き足すと外れる
    store.transact("add", (tx) => void tx.addNode(makeNode({ title: "足した歩み" })));
    expect(isFreshFuture(store.doc)).toBe(false);
    // 元に戻して入れ替えた直後の中身に戻っても、手を付けたことには変わりない（時刻は進む）
    store.undo();
    expect(Object.values(store.doc.nodes).some((n) => n.title === "足した歩み")).toBe(false);
    expect(isFreshFuture(store.doc)).toBe(false);
    // 入れ替え自体を元に戻す・やり直す: 履歴の写しは印を付ける前の物（付いていても時刻が合わない）
    store.undo();
    expect(hasFutureRoot(store.doc)).toBe(false);
    expect(isFreshFuture(store.doc)).toBe(false);
    store.redo();
    expect(hasFutureRoot(store.doc)).toBe(true);
    expect(isFreshFuture(store.doc)).toBe(false);
    // 印の無い文書・形の違う印
    expect(isFreshFuture(buildDemoDoc())).toBe(false);
    const odd = buildDemoDoc();
    odd.meta = { [FRESH_FUTURE]: 1 };
    expect(isFreshFuture(odd)).toBe(false);
  });

  it("重なったときに譲るか: 手を付けていない中身だけが譲り、開くのを断った（戻した）地図は、別の端末が開いたばかりの地図には譲らない", () => {
    const fresh = (d: DocData): DocData => ({ ...d, meta: { ...d.meta, [FRESH_FUTURE]: d.updatedAt } });
    const { pv } = buildFuture(TODAY);
    const map = fresh(pv.doc);
    const undone = fresh(withNoAutoFuture(buildDemoDoc()));
    const written = buildDemoDoc();
    written.nodes = { ...written.nodes };
    const own = makeNode({ title: "別の端末で書いた目標" });
    written.nodes[own.id] = own;
    // 開いたままの未来の道筋: 書かれた内容にも、別の端末が開いた・戻した地図にも譲る（どれでも 1 つにそろう）
    expect(yieldsToRemote(map, written)).toBe(true);
    expect(yieldsToRemote(map, fresh(pv.doc))).toBe(true);
    expect(yieldsToRemote(map, undone)).toBe(true);
    // 戻しただけの地図: 書かれた内容には譲る。別の端末が開いたばかりの未来の道筋には譲らない（断ったことが通る）
    expect(yieldsToRemote(undone, written)).toBe(true);
    expect(yieldsToRemote(undone, fresh(pv.doc))).toBe(false);
    expect(yieldsToRemote(undone, undone)).toBe(true);
    // 別の端末が開いた後に手を付けた（書いた）未来の道筋は、書かれた内容と同じく譲る（戻しただけの地図で押し流さない）
    expect(yieldsToRemote(undone, { ...map, updatedAt: "2099-01-01T00:00:00.000Z" })).toBe(true);
    expect(yieldsToRemote(undone, pv.doc)).toBe(true);
    // ノードを動かしただけのデモ（捨ててよい・断った印が無い）には譲らない（断った印を消して、その端末で自動で開かせない）
    const moved = buildDemoDoc();
    moved.nodes = { ...moved.nodes };
    const first = Object.keys(moved.nodes)[0]!;
    moved.nodes[first] = { ...moved.nodes[first]!, x: moved.nodes[first]!.x + 40 };
    expect(isDisposableDoc(moved)).toBe(true);
    expect(yieldsToRemote(undone, moved)).toBe(false);
    expect(yieldsToRemote(undone, withNoAutoFuture(moved))).toBe(true);
    expect(yieldsToRemote(map, moved)).toBe(true);
    // 手を付けた手元は譲らない（ふつうの重なり: 手元を送り、相手はバックアップへ）
    expect(yieldsToRemote(written, map)).toBe(false);
    expect(yieldsToRemote({ ...map, updatedAt: "2099-01-01T00:00:00.000Z" }, written)).toBe(false);
  });

  it("新しい版に差し替えても、同じカードの選んだ手・見送り・チェック・年収は引き継ぎ、古い版の題名は新しい題名にする", () => {
    const old = buildFuture(TODAY).pv.doc;
    old.title = "未来の道筋（仕事・10 年）";
    const root = Object.values(old.nodes).find((n) => n.meta.forecastRoot === true)!;
    root.meta = { ...root.meta, futureVersion: "old", impact: { ...(root.meta.impact as object), annual: 540 } };
    const alts = Object.values(old.nodes).filter((n) => n.meta.fork === "chance" && n.conditions.length);
    const picked = alts[0]!;
    const dropped = alts[1]!;
    picked.status = "active";
    picked.conditions = picked.conditions.map((c, i) => (i === 0 ? { ...c, met: true } : c));
    dropped.status = "dropped";
    const res = swapFutureDoc(old, buildFuture(TODAY).pv.doc);
    expect(res.kept).toBe(3);
    const d = res.doc;
    expect(d.title).toBe("未来の道筋（仕事・3 年の分かれ道）");
    const byKey = (k: unknown) => Object.values(d.nodes).find((n) => n.meta.key === k)!;
    expect(byKey(picked.meta.key).status).toBe("active");
    expect(byKey(picked.meta.key).conditions[0]?.met).toBe(true);
    expect(byKey(dropped.meta.key).status).toBe("dropped");
    expect(Object.values(d.nodes).filter((n) => n.status !== "open").length).toBe(2);
    const r2 = Object.values(d.nodes).find((n) => n.meta.forecastRoot === true)!;
    expect((r2.meta.impact as { annual?: number }).annual).toBe(540);
    expect(r2.meta.futureVersion).toBe(futureVersion());
    // 自分で付けた題名はそのまま
    const own = { ...old, title: "わたしの地図" };
    expect(swapFutureDoc(own, buildFuture(TODAY).pv.doc).doc.title).toBe("わたしの地図");
  });

  it("未来の道筋が無い文書では、ふつうの追加と同じく右側に足す", () => {
    const base = buildDemoDoc();
    const res = swapFutureDoc(base, oldFuture("v1"));
    expect(res.removed).toBe(0);
    expect(Object.keys(res.doc.nodes).length).toBe(Object.keys(base.nodes).length + res.added);
    const maxX = Math.max(...Object.values(base.nodes).map((n) => n.x));
    expect(res.doc.nodes[res.root!]!.x).toBeGreaterThan(maxX);
  });
});
