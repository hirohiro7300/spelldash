import { describe, expect, it } from "vitest";
import { Commands } from "../../src/app/commands";
import { DEFAULT_PREFS, UiState } from "../../src/app/uiState";
import { ViewModel } from "../../src/app/viewModel";
import { ImpactCards } from "../../src/canvas/impactCards";
import { buildImpactDoc } from "../../src/demo/impact";
import { r6Bundle } from "./helpers/r6";
import { createEmptyDoc, makeEdge, makeNode, makeProject, makeScenario } from "../../src/model/schema";
import type { DocData } from "../../src/model/types";
import { Store } from "../../src/store/store";

/** "a>b, b>c" の形でグラフを作る。collapsed にするノードは名前の後ろに * */
function graph(spec: string): DocData {
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
      doc.edges[id] = makeEdge({ id, source: ids[i]!, target: ids[i + 1]! });
    }
  }
  return doc;
}

function setup(doc: DocData) {
  const store = new Store(doc);
  const ui = new UiState(structuredClone(DEFAULT_PREFS));
  ui.persistPrefs = false;
  const vm = new ViewModel(store, ui);
  const toasts: string[] = [];
  const cmd = new Commands(store, ui, vm, {
    toast: (t) => void toasts.push(t),
    viewCenter: () => ({ x: 0, y: 0 }),
    startEdit: () => undefined,
    reveal: () => undefined,
    confirm: async () => true,
  });
  return { store, ui, vm, cmd, toasts };
}

describe("隠れたノードを出す（検索で選んだとき）", () => {
  it("折りたたみの中なら上流の折りたたみを開き、元に戻せる", () => {
    const { store, vm, cmd } = setup(graph("r>a*>b*>c, r>x"));
    expect(vm.node("c").hidden).toBe(true);
    cmd.revealNode("c");
    expect(vm.node("c").hidden).toBe(false);
    expect(store.doc.nodes.a!.collapsed).toBe(false);
    expect(store.doc.nodes.b!.collapsed).toBe(false);
    expect(store.doc.nodes.x!.collapsed).toBe(false);
    store.undo();
    expect(vm.node("c").hidden).toBe(true);
  });

  it("開くと入口が変わる循環でも、見えるまで開く", () => {
    const { vm, cmd } = setup(graph("a*>b>c*>d>a"));
    expect(vm.node("b").hidden).toBe(true);
    cmd.revealNode("b");
    expect(vm.node("b").hidden).toBe(false);
  });

  it("接続線の折りたたみも開く", () => {
    const doc = graph("r>a>b");
    doc.edges.ab = { ...doc.edges.ab!, collapsed: true };
    const { store, vm, cmd } = setup(doc);
    expect(vm.node("b").hidden).toBe(true);
    cmd.revealNode("b");
    expect(vm.node("b").hidden).toBe(false);
    expect(store.doc.edges.ab!.collapsed).toBe(false);
  });

  it("プロジェクトに絞る・シナリオで隠すで隠れていれば「薄くする」表示に切り替える（データは変えない）", () => {
    const doc = graph("r>a>b, r>c>d");
    const p = makeProject({ name: "P" });
    const s1 = makeScenario({ name: "S1" });
    const s2 = makeScenario({ name: "S2" });
    doc.projects[p.id] = p;
    doc.projectOrder.push(p.id);
    doc.scenarios[s1.id] = s1;
    doc.scenarios[s2.id] = s2;
    doc.scenarioOrder.push(s1.id, s2.id);
    for (const id of ["r", "a", "b"]) doc.nodes[id] = { ...doc.nodes[id]!, projectIds: [p.id] };
    doc.edges.ab = { ...doc.edges.ab!, scenarioIds: [s2.id] };
    const { store, ui, vm, cmd, toasts } = setup(doc);
    const before = store.doc.updatedAt;
    // シナリオ S1 を「隠す」で見ると、S2 の線の先の b は隠れる
    ui.setPrefs({ scenarioId: s1.id, scenarioMode: "hide" });
    expect(vm.node("b").hidden).toBe(true);
    expect(vm.hiddenBy("b").scenario).toBe(true);
    cmd.revealNode("b");
    expect(vm.node("b").hidden).toBe(false);
    expect(ui.prefs.scenarioMode).toBe("dim");
    // プロジェクト P に絞ると、P の隣（c）は薄く残り、その先の d は隠れる
    ui.setPrefs({ projectFilter: [p.id], projectMode: "focus" });
    expect(vm.node("c").hidden).toBe(false);
    expect(vm.node("d").hidden).toBe(true);
    cmd.revealNode("d");
    expect(vm.node("d").hidden).toBe(false);
    expect(ui.prefs.projectMode).toBe("dim");
    expect(toasts.join()).toContain("薄くする");
    expect(store.doc.updatedAt).toBe(before);
  });
});

describe("経路の強調", () => {
  it("シナリオで隠したノードを選んだままでも、地図全体を薄くしない", () => {
    const doc = graph("br>a, br>b");
    const s1 = makeScenario({ name: "S1" });
    const s2 = makeScenario({ name: "S2" });
    doc.scenarios[s1.id] = s1;
    doc.scenarios[s2.id] = s2;
    doc.scenarioOrder.push(s1.id, s2.id);
    doc.edges.bra = { ...doc.edges.bra!, scenarioIds: [s1.id] };
    doc.edges.brb = { ...doc.edges.brb!, scenarioIds: [s2.id] };
    const { ui, vm } = setup(doc);
    ui.setPrefs({ scenarioId: s1.id, scenarioMode: "hide", pathHighlight: true });
    ui.select(["a"]);
    vm.ensure();
    expect(vm.pathActive).toBe(true);
    ui.setPrefs({ scenarioId: s2.id });
    expect(vm.node("a").hidden).toBe(true);
    expect(vm.pathActive).toBe(false);
    expect(vm.node("br").alpha).toBe(1);
  });
});

describe("検索", () => {
  it("検索の言葉が変わったと聞いた時点で、当たりはもう新しい言葉のもの（検索欄が 1 つ前の当たりを出さない）", () => {
    const doc = graph("a>b, b>c");
    doc.nodes.a = { ...doc.nodes.a!, title: "広告の計測", tags: ["1時間"] };
    doc.nodes.b = { ...doc.nodes.b!, title: "英単語", tags: ["1日"] };
    const { ui, vm } = setup(doc);
    vm.ensure();
    // 地図は「見え方が変わった」たびに描き直す（そのたびに計算し直しが済む）。アプリでは打つたびにこうなる
    ui.on("visual", () => vm.ensure());
    const seen: string[][] = [];
    ui.on("search", () => {
      vm.ensure();
      seen.push(vm.searchHits.map((h) => h.id));
    });
    ui.setSearch("#1時間");
    ui.setSearch("英単語");
    ui.setSearch("");
    expect(seen).toEqual([["a"], ["b"], []]);
  });
});

describe("お知らせの「元に戻す」", () => {
  it("そのお知らせの操作がまだいちばん上にあるときだけ戻す（あとの別の操作を代わりに戻さない）", () => {
    const { store, cmd, toasts } = setup(graph("a>b, c>d"));
    cmd.deleteNodes(["a"]);
    const del = cmd.undoAction(); // 「削除しました」のお知らせが持つ
    store.transact("c の題名", (tx) => tx.updateNode("c", { title: "あとで変えた" }));
    del.run();
    expect(store.doc.nodes.c!.title).toBe("あとで変えた"); // 別の操作は戻さない
    expect(store.doc.nodes.a).toBeUndefined();
    expect(toasts.join()).toContain("ここからは戻せません");
    // すぐ押したときは戻る
    cmd.deleteNodes(["d"]);
    const del2 = cmd.undoAction();
    del2.run();
    expect(store.doc.nodes.d).toBeDefined();
  });

  it("上部の「元に戻す」・⌘Z でもう戻した後に押すと、もう戻してあると知らせる（読み込んだ・別の操作をした、とは言わない）", () => {
    const { store, cmd, toasts } = setup(graph("a>b"));
    cmd.deleteNodes(["a"]);
    const del = cmd.undoAction();
    store.undo();
    expect(store.doc.nodes.a).toBeDefined();
    del.run();
    expect(store.doc.nodes.a).toBeDefined();
    expect(store.history.canRedo).toBe(true);
    expect(toasts[toasts.length - 1]).toContain("もう元に戻してあります");
  });

  it("履歴ごと入れ替わった（読み込んだ）後に押すと、読み込んだので戻せないと知らせる", () => {
    const { store, cmd, toasts } = setup(graph("a>b"));
    cmd.deleteNodes(["a"]);
    const del = cmd.undoAction();
    store.load(graph("x>y"));
    del.run();
    expect(toasts[toasts.length - 1]).toContain("別の内容を読み込んだ");
  });
});

describe("3 年の分かれ道: 開く・閉じるは見え方だけ（文書・履歴・保存は変えない）", () => {
  const TODAY = new Date(2026, 10, 18);
  const base = buildImpactDoc(r6Bundle(), TODAY, "t");
  const rootId = Object.values(base.nodes).find((n) => n.meta.forecastRoot === true)!.id;

  function openImpact(narrow = true) {
    const s = setup(structuredClone(base));
    s.vm.narrow = () => narrow;
    let changes = 0;
    s.store.on("change", () => void changes++);
    const alts = () => s.vm.impact.decision.get(rootId)!.alts;
    return { ...s, alts, changes: () => changes };
  }

  it("印・C・メニューの開閉、すべて開く、最初の形に戻す、検索で隠れたノードを出す: 文書の版・元に戻す・変更の知らせはそのまま", () => {
    const { store, ui, vm, cmd, alts, changes } = openImpact();
    vm.ensure();
    const rev = store.revision;
    const undo = store.history.undoStack.length;
    const alt = alts()[2]!;
    const kid = vm.index.out.get(alt)!.map((e) => store.doc.edges[e]!.target)[0]!;
    expect(vm.node(kid).hidden).toBe(true);
    expect(vm.node(alt).collapsedCount).toBeGreaterThan(0);
    expect(vm.isCollapsed(alt)).toBe(true);
    cmd.toggleCollapse([alt]);
    expect(vm.node(kid).hidden).toBe(false);
    expect(vm.isCollapsed(alt)).toBe(false);
    expect(ui.prefs.impactOpen[rootId]).toContain(alt);
    cmd.toggleCollapse([alt]);
    expect(vm.node(kid).hidden).toBe(true);
    // 深い行き先を検索で選ぶ: 上流を見え方だけで開く
    const end = vm.impact.ends[vm.impact.ends.length - 1]!.id;
    expect(vm.node(end).hidden).toBe(true);
    cmd.revealNode(end);
    expect(vm.node(end).hidden).toBe(false);
    cmd.expandAll();
    vm.ensure();
    expect(vm.drawNodes.length).toBe(Object.keys(store.doc.nodes).length);
    cmd.resetImpactOpen();
    expect(ui.prefs.impactOpen[rootId]).toBeUndefined();
    vm.ensure();
    expect(vm.drawNodes.length).toBe(11);
    expect(store.revision).toBe(rev);
    expect(store.history.undoStack.length).toBe(undo);
    expect(changes()).toBe(0);
    expect(Object.values(store.doc.nodes).some((n) => n.collapsed)).toBe(false);
  });

  it("3 年の影響の計算は、開閉・選択では作り直さず、% ・状態・年収（入口の meta）・シナリオで作り直す", () => {
    const { store, ui, vm, cmd, alts } = openImpact(false);
    const a0 = vm.impact;
    const alt = alts()[0]!;
    cmd.toggleCollapse([alt]);
    ui.select([alt]);
    cmd.expandAll();
    expect(vm.impact).toBe(a0);
    // 結果の % を直す: その選択肢の 3 年の影響が変わり、元に戻すと戻る
    const e = vm.index.out.get(alt)!.map((id) => store.doc.edges[id]!).find((x) => typeof x.meta.prob === "number")!;
    const d0 = a0.alt.get(alt)!.delta!;
    cmd.updateEdge(e.id, { meta: { ...e.meta, prob: (e.meta.prob as number) + 20 } });
    const a1 = vm.impact;
    expect(a1).not.toBe(a0);
    expect(Math.abs(a1.alt.get(alt)!.delta! - d0)).toBeGreaterThan(0.01);
    store.undo();
    expect(vm.impact.alt.get(alt)!.delta).toBeCloseTo(d0, 6);
    // 状態（これにする）
    const a2 = vm.impact;
    cmd.setStatus([alts()[3]!], "active");
    expect(vm.impact).not.toBe(a2);
    expect(vm.impact.alt.get(alts()[3]!)!.picked).toBe(true);
    // 年収（入口の meta.impact.annual）
    const a3 = vm.impact;
    const r = store.doc.nodes[rootId]!;
    cmd.updateNode(rootId, { meta: { ...r.meta, impact: { v: 2, horizon: 36, annual: 540 } } });
    expect(vm.impact).not.toBe(a3);
    expect(vm.impact.annual).toBe(540);
    // シナリオ
    const a4 = vm.impact;
    ui.setPrefs({ scenarioId: "s_early" });
    expect(vm.impact).not.toBe(a4);
    const a5 = vm.impact;
    cmd.toggleCollapse([alts()[1]!]);
    expect(vm.impact).toBe(a5);
  });

  it("題名・本文・タグ・条件・線の説明と条件・位置だけの編集では計算し直さず（カードの文字は書き直す）、計算に使う物の編集では計算し直す", () => {
    const { store, vm, cmd, alts } = openImpact(false);
    const cards = new ImpactCards();
    const alt = alts()[0]!;
    const out = vm.index.out.get(alt)!.map((id) => store.doc.edges[id]!).find((x) => typeof x.meta.prob === "number")!;
    const own = cmd.createNode("goal", { x: -3000, y: 0 }, { exact: true, title: "自分のメモ" })!;
    const a0 = vm.impact;
    expect(cards.card(a0, store.doc, alt)!.label).toContain(store.doc.nodes[alt]!.title.slice(0, 4));
    // 文字だけ（元に戻す・やり直すも）・位置だけ: 同じ計算の結果のまま
    cmd.updateNode(alt, { title: "新しい題名" }, { label: "タイトルを編集", coalesce: `title:${alt}` });
    expect(vm.impact).toBe(a0);
    const c1 = cards.card(vm.impact, store.doc, alt)!;
    expect(c1.label).toBe(`${c1.pill}｜新しい題名`);
    cmd.updateNode(alt, { body: "本文を書いた" }, { label: "文章を編集" });
    cmd.addTag([alt], "タグ");
    cmd.addCondition(alt, "やることを足した");
    cmd.updateCondition(alt, store.doc.nodes[alt]!.conditions.at(-1)!.id, { met: true });
    cmd.updateEdge(out.id, { label: "説明を書いた" });
    cmd.updateEdge(out.id, { condition: "条件を書いた" });
    expect(cards.edge(vm.impact, store.doc, out.id)!.long).toContain("条件を書いた");
    cmd.updateNode(rootId, { title: "今日（書き直した）" });
    cmd.moveNodes([own], 40, 0);
    store.undo();
    store.undo();
    store.redo();
    expect(vm.impact).toBe(a0);
    // 計算に使う物: そのたびに計算し直す
    const changes = (what: string, fn: () => void) => {
      const before = vm.impact;
      fn();
      expect(vm.impact, what).not.toBe(before);
    };
    changes("状態", () => cmd.setStatus([alt], "active"));
    changes("状態を戻す", () => store.undo());
    changes("見込み（線の meta）", () => cmd.updateEdge(out.id, { meta: { ...store.doc.edges[out.id]!.meta, prob: 5 } }));
    changes("ノードの meta", () => cmd.updateNode(alt, { meta: { ...store.doc.nodes[alt]!.meta, h: 9 } }));
    changes("期限", () => cmd.updateNode(alt, { time: { ...store.doc.nodes[alt]!.time, due: "2027-03-31" } }));
    changes("種類", () => cmd.setType([alt], "result"));
    changes("入口の meta（年収）", () => cmd.updateNode(rootId, { meta: { ...store.doc.nodes[rootId]!.meta, impact: { v: 2, horizon: 36, annual: 480 } } }));
    changes("線の関係", () => cmd.setRelation([out.id], "supports"));
    changes("線のシナリオ", () => cmd.setScenarioOf({ edges: [vm.index.inc.get(alt)![0]!] }, "s_early"));
    let kid: string | null = null;
    changes("ノードを足す", () => void (kid = cmd.addChild(alt)));
    changes("ノードを消す", () => cmd.deleteNodes([kid!]));
    changes("シナリオを足す", () => void cmd.addScenario("別の方針"));
    changes("全部を入れ替える", () => store.load(structuredClone(store.doc)));
  });

  it("カードは動かせない（動かす・そろえる）。範囲の外のノードは今までどおり動き、お知らせは一度だけ", () => {
    const { store, vm, cmd, toasts, alts } = openImpact();
    vm.ensure();
    const rev = store.revision;
    const alt = alts()[0]!;
    const at = { x: store.doc.nodes[alt]!.x, y: store.doc.nodes[alt]!.y };
    cmd.moveNodes([alt], 40, 40);
    cmd.align([alt, alts()[1]!], "h");
    expect(store.revision).toBe(rev);
    expect(store.doc.nodes[alt]).toMatchObject(at);
    expect(toasts.filter((t) => t.includes("カードは動かせません")).length).toBe(1);
    const own = cmd.createNode("goal", { x: -2000, y: 0 }, { exact: true, title: "自分のメモ" })!;
    cmd.moveNodes([own, alt], 10, 0);
    expect(store.doc.nodes[own]!.x).toBe(-1990);
    expect(store.doc.nodes[alt]).toMatchObject(at);
  });

  it("右クリックの「展開する／この先を折りたたむ」の向きは見え方の開閉で決まる（行き先には開く物が無い）", () => {
    const { vm, alts, store } = openImpact(false);
    vm.ensure();
    expect(vm.isCollapsed(rootId)).toBe(false);
    expect(vm.isCollapsed(alts()[0]!)).toBe(false);
    const state = vm.index.out.get(alts()[0]!)!.map((e) => store.doc.edges[e]!.target)[0]!;
    expect(vm.isCollapsed(state)).toBe(true);
    const end = vm.impact.ends[0]!.id;
    expect(vm.isCollapsed(end)).toBe(false);
  });
});

describe("見え方の計算: 範囲と折りたたみは材料が同じなら使い回す", () => {
  it("選択・検索・時点・題名だけでは見えるノードを作り直さず、開閉・シナリオで隠す・絞り込みが変わったら作り直す（どちらも作り直したときと同じ結果）", () => {
    const { store, ui, vm, cmd } = setup(buildImpactDoc(r6Bundle(), new Date(2026, 10, 18), "t"));
    vm.narrow = () => false;
    /** 見えるノードの計算の結果（絞り込みが無いときは速い道、あるときは範囲を作る道） */
    const vis = () => {
      const l = (vm as unknown as { last: { fast: unknown; full: unknown } }).last;
      return l.fast ?? l.full;
    };
    /** 同じ文書・設定・選択で、いちから作った見え方と同じか */
    const sameAsFresh = () => {
      vm.ensure();
      const f = new ViewModel(store, ui);
      f.narrow = () => false;
      f.ensure();
      expect(vm.drawNodes).toEqual(f.drawNodes);
      expect(vm.drawEdges).toEqual(f.drawEdges);
      expect(vm.nodes).toEqual(f.nodes);
      expect(vm.edges).toEqual(f.edges);
    };
    vm.ensure();
    const root = vm.impactRoots()[0]!;
    const alt = vm.index.out.get(root)!.map((e) => store.doc.edges[e]!.target)[0]!;
    const c0 = vis();
    ui.select([alt]);
    vm.ensure();
    expect(vm.pathActive).toBe(true);
    ui.setSearch("広告");
    vm.ensure();
    ui.setPrefs({ timeCursor: "2027-06-30" });
    vm.ensure();
    expect(vis()).toBe(c0);
    sameAsFresh();
    // 題名の 1 文字（見えるノードは変わらない）
    cmd.updateNode(alt, { title: "変えた" });
    vm.ensure();
    expect(vis()).toBe(c0);
    sameAsFresh();
    // 開く・閉じる（見え方）
    cmd.toggleCollapse([alt]);
    vm.ensure();
    const c1 = vis();
    expect(c1).not.toBe(c0);
    sameAsFresh();
    // シナリオ（隠す → 薄くする）
    ui.setPrefs({ scenarioId: "s_early", scenarioMode: "hide" });
    vm.ensure();
    const c3 = vis();
    expect(c3).not.toBe(c1);
    sameAsFresh();
    ui.setPrefs({ scenarioMode: "dim" });
    vm.ensure();
    const c4 = vis();
    expect(c4).not.toBe(c3);
    sameAsFresh();
    // プロジェクトに絞る（絞る → 薄くする）
    ui.setPrefs({ projectFilter: ["p_spelldash"], projectMode: "focus" });
    vm.ensure();
    const c5 = vis();
    expect(c5).not.toBe(c4);
    sameAsFresh();
    ui.setPrefs({ projectMode: "dim" });
    vm.ensure();
    expect(vis()).not.toBe(c5);
    sameAsFresh();
  });
});

describe("表示の設定: 3 年の分かれ道で開いているノード", () => {
  it("入口ごとに覚え、壊れた値（配列でない・文字でない ID）は捨てて読み込む", () => {
    const saved = (globalThis as { localStorage?: unknown }).localStorage;
    const mem = new Map<string, string>();
    mem.set("4d-branch:prefs", JSON.stringify({ impactOpen: { r1: ["a", 3, null, "b", "a"], r2: "壊れた", r3: { x: 1 }, "": ["z"] } }));
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    try {
      const ui = new UiState();
      expect(ui.prefs.impactOpen).toEqual({ r1: ["a", "b"] });
      ui.setImpactOpen("r2", ["c"]);
      ui.flushPrefs();
      expect(JSON.parse(mem.get("4d-branch:prefs")!).impactOpen).toEqual({ r1: ["a", "b"], r2: ["c"] });
      expect(new UiState().prefs.impactOpen).toEqual({ r1: ["a", "b"], r2: ["c"] });
      mem.set("4d-branch:prefs", JSON.stringify({ impactOpen: ["x"] }));
      expect(new UiState().prefs.impactOpen).toEqual({});
      mem.set("4d-branch:prefs", "{壊れた");
      expect(new UiState().prefs.impactOpen).toEqual({});
    } finally {
      (globalThis as { localStorage?: unknown }).localStorage = saved;
    }
  });
});

describe("表示の設定の読み込み", () => {
  it("壊れた時点（NaN）は外して読み込む", async () => {
    const saved = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => JSON.stringify({ timeCursor: "NaN-NaN-NaN", view: "list" }), setItem: () => undefined };
    try {
      const ui = new UiState();
      expect(ui.prefs.timeCursor).toBeNull();
      expect(ui.prefs.view).toBe("list");
    } finally {
      (globalThis as { localStorage?: unknown }).localStorage = saved;
    }
  });
});
