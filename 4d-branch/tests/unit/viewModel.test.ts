import { describe, expect, it } from "vitest";
import { Commands } from "../../src/app/commands";
import { DEFAULT_PREFS, UiState } from "../../src/app/uiState";
import { ViewModel } from "../../src/app/viewModel";
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
