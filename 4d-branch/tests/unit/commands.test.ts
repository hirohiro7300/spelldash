import { describe, expect, it } from "vitest";
import { Commands } from "../../src/app/commands";
import { DEFAULT_PREFS, UiState } from "../../src/app/uiState";
import { ViewModel } from "../../src/app/viewModel";
import { futureData } from "../../src/demo/futureBundle";
import { buildImpactDoc } from "../../src/demo/impact";
import { flowOuts, isFlowEdge } from "../../src/model/forks";
import { createEmptyDoc, makeEdge, makeNode } from "../../src/model/schema";
import type { DocData, ID, Relation } from "../../src/model/types";
import { Store } from "../../src/store/store";

function setup(doc: DocData, narrow = false) {
  const store = new Store(doc);
  const ui = new UiState(structuredClone(DEFAULT_PREFS));
  ui.persistPrefs = false;
  const vm = new ViewModel(store, ui);
  vm.narrow = () => narrow;
  const toasts: string[] = [];
  const cmd = new Commands(store, ui, vm, {
    toast: (t) => void toasts.push(t),
    viewCenter: () => ({ x: 0, y: 0 }),
    startEdit: () => undefined,
    reveal: () => undefined,
    confirm: async () => true,
  });
  const blocked: string[] = [];
  store.on("blocked", (l) => void blocked.push(l));
  return { store, ui, vm, cmd, toasts, blocked };
}

type S = ReturnType<typeof setup>;

const TODAY = new Date(2026, 10, 18);
const base = buildImpactDoc(futureData(), TODAY, "t");
const rootId = Object.values(base.nodes).find((n) => n.meta.forecastRoot === true)!.id;

/** 3 年の分かれ道（同梱の地図）。narrow: スマホの最初の形（今日だけ開く） */
const openMap = (narrow = false) => setup(structuredClone(base), narrow);

/** 道の線でつながる子（線の順） */
const kidsOf = (s: S, id: ID) => flowOuts(s.store.doc, s.vm.index.out, id).map((e) => e.target);

/** 自分のノード W → W2（地図から離れた所） */
function ownPair(s: S) {
  const W = s.cmd.createNode("goal", { x: -3000, y: 500 }, { exact: true, title: "W" })!;
  const W2 = s.cmd.createNode("action", { x: -2700, y: 500 }, { exact: true, title: "W2", from: [W] })!;
  s.ui.clearSelection();
  s.vm.ensure();
  return { W, W2 };
}

describe("3 年の分かれ道: カードから線を引く", () => {
  it("カードから今日へ戻る線（条件付き・相乗効果・阻害・循環）を引いても地図は消えず、引いた線も見える", () => {
    for (const rel of [undefined, "supports", "blocks", "feedback"] as Array<Relation | undefined>) {
      const s = openMap();
      s.vm.ensure();
      const before = s.vm.drawNodes.length;
      const alt = kidsOf(s, rootId)[0]!;
      const outcome = kidsOf(s, alt)[0]!;
      expect(s.vm.isOpen(outcome)).toBe(false);
      const [eid] = s.cmd.connect([outcome], rootId, rel);
      s.vm.ensure();
      const e = s.store.doc.edges[eid!]!;
      const label = `${e.relation}`;
      expect(s.vm.node(rootId).hidden, label).toBe(false);
      expect(s.vm.edges.get(eid!)!.hidden, label).toBe(false);
      // 道の線（条件付き）のときだけ元のカードを見え方で開く。ほかの関係では開かない
      expect(s.vm.isOpen(outcome), label).toBe(isFlowEdge(e));
      expect(s.vm.drawNodes.length, label).toBeGreaterThanOrEqual(before);
      // 元のカードを閉じ直しても、地図は消えない（線の先が今日なので隠れない）
      s.vm.setImpactOpen([], [outcome]);
      s.vm.ensure();
      expect(s.vm.node(rootId).hidden, label).toBe(false);
      expect(s.vm.drawNodes.length, label).toBe(before);
      expect(s.store.doc.nodes[outcome]!.collapsed).toBe(false);
    }
  });

  it("スマホの最初の形（選択肢は閉じている）でも、選択肢から今日へつないで地図が消えない", () => {
    const s = openMap(true);
    s.vm.ensure();
    const before = s.vm.drawNodes.length;
    const alt = kidsOf(s, rootId)[0]!;
    expect(s.vm.isOpen(alt)).toBe(false);
    s.cmd.connect([alt], rootId);
    s.vm.setImpactOpen([], [alt]);
    s.vm.ensure();
    expect(s.vm.node(rootId).hidden).toBe(false);
    expect(s.vm.drawNodes.length).toBe(before);
  });

  it("閉じたカードから自分のノードへつなぐと、カードを見え方で開き、自分のノードとその先は見えたまま（文書で折りたたんでいた所は閉じたまま）", () => {
    for (const docCollapsed of [false, true]) {
      const s = openMap();
      const { W, W2 } = ownPair(s);
      const W3 = s.cmd.createNode("result", { x: -2400, y: 500 }, { exact: true, title: "W3", from: [W2] })!;
      if (docCollapsed) s.cmd.toggleCollapse([W2]);
      s.vm.ensure();
      expect(s.vm.node(W3).hidden).toBe(docCollapsed);
      const alt = kidsOf(s, rootId)[0]!;
      const outcome = kidsOf(s, alt)[0]!;
      expect(s.vm.isOpen(outcome)).toBe(false);
      const rev = s.store.revision;
      const [eid] = s.cmd.connect([outcome], W);
      s.vm.ensure();
      expect(s.vm.isOpen(outcome)).toBe(true);
      // 道の線なので自分のノードは 3 年の分かれ道に入る（並べ方に従う）が、見えていた物は見えたまま
      expect(s.vm.inImpact(W) && s.vm.inImpact(W2) && s.vm.inImpact(W3)).toBe(true);
      expect(s.vm.node(W).hidden).toBe(false);
      expect(s.vm.node(W2).hidden).toBe(false);
      expect(s.vm.node(W3).hidden).toBe(docCollapsed);
      expect(s.vm.edges.get(eid!)!.hidden).toBe(false);
      // 開いたのは見え方だけ（文書の変更は線の 1 本だけ）
      expect(s.store.revision).toBe(rev + 1);
      expect(s.store.doc.nodes[outcome]!.collapsed).toBe(false);
    }
  });

  it("閉じたカードからの相乗効果・阻害の線は、先の自分のノードを隠さない（文書で折りたたんだ範囲の外のノードは今までどおり先を隠す）", () => {
    for (const rel of ["supports", "blocks"] as const) {
      // スマホの最初の形: 選択肢は閉じている
      const s = openMap(true);
      const { W, W2 } = ownPair(s);
      const alt = kidsOf(s, rootId)[0]!;
      const count = s.vm.node(alt).collapsedCount;
      expect(count).toBeGreaterThan(0);
      const [eid] = s.cmd.connect([alt], W, rel);
      s.vm.ensure();
      expect(s.vm.isOpen(alt), rel).toBe(false);
      expect(s.vm.inImpact(W), rel).toBe(false);
      expect(s.vm.node(W).hidden, rel).toBe(false);
      expect(s.vm.node(W2).hidden, rel).toBe(false);
      expect(s.vm.edges.get(eid!)!.hidden, rel).toBe(false);
      // 閉じたカードの「+N」は、閉じると隠れる物だけ（自分のノードは数えない）
      expect(s.vm.node(alt).collapsedCount, rel).toBe(count);
      // 範囲の外の自分のノードを文書で折りたたむと、今までどおりその先が隠れる
      s.cmd.toggleCollapse([W]);
      s.vm.ensure();
      expect(s.store.doc.nodes[W]!.collapsed, rel).toBe(true);
      expect(s.vm.node(W2).hidden, rel).toBe(true);
    }
  });

  it("閉じた行き先（子の無いカード）から別の関係の線だけが出ていても、折りたたみの印は出さない", () => {
    const s = openMap();
    const { W } = ownPair(s);
    const end = s.vm.impact.ends.map((e) => e.id).find((id) => !(s.vm.index.out.get(id)?.length ?? 0))!;
    s.cmd.revealNode(end);
    s.vm.ensure();
    expect(s.vm.node(end).hidden).toBe(false);
    s.cmd.connect([end], W, "supports");
    s.vm.ensure();
    expect(s.vm.isOpen(end)).toBe(false);
    expect(s.vm.node(end).collapsed).toBe(false);
    expect(s.vm.isCollapsed(end)).toBe(false);
    expect(s.vm.node(W).hidden).toBe(false);
  });

  it("相乗効果の線しか出ていないカードは開閉する物が無い: 閉じた選択肢と一緒に選んでも C・メニューは「展開する」で選択肢を開き、カードだけなら何もしない（印・詳細のボタンも同じ決まり）", () => {
    // スマホの最初の形: 選択肢は閉じている
    const s = openMap(true);
    const { W } = ownPair(s);
    const alt = kidsOf(s, rootId)[0]!;
    const end = s.vm.impact.ends.map((e) => e.id).find((id) => !(s.vm.index.out.get(id)?.length ?? 0))!;
    s.cmd.connect([end], W, "supports");
    s.vm.ensure();
    expect(s.vm.isOpen(alt)).toBe(false);
    // 閉じた選択肢と一緒に: 開く向き（メニューは「展開する」）で、C で選択肢が開く。もう一度で閉じる
    s.cmd.toggleCollapse([alt, end]);
    expect(s.vm.isOpen(alt)).toBe(true);
    s.cmd.toggleCollapse([alt, end]);
    expect(s.vm.isOpen(alt)).toBe(false);
    expect(s.cmd.collapsedAll([alt, end])).toBe(true);
    // カードだけ: 出る線はあるが、開く・閉じる物（同じ範囲の子）が無い。メニューは押せず、C でも見え方・文書を変えない
    expect(s.vm.index.out.get(end)!.length).toBe(1);
    expect(s.vm.canCollapse(end)).toBe(false);
    expect(s.cmd.canToggleCollapse([end])).toBe(false);
    expect(s.cmd.collapsedAll([end])).toBe(false);
    const open0 = s.ui.prefs.impactOpen[rootId];
    const rev = s.store.revision;
    s.cmd.toggleCollapse([end]);
    expect(s.ui.prefs.impactOpen[rootId]).toBe(open0);
    expect(s.store.revision).toBe(rev);
    expect(s.vm.impactBranches()).not.toContain(end);
    // 先のあるカードと範囲の外の自分のノード（出る線で決める）は今までどおり
    expect(s.vm.canCollapse(alt)).toBe(true);
    expect(s.vm.canCollapse(W)).toBe(true);
    expect(s.cmd.canToggleCollapse([end, W])).toBe(true);
  });
});

/** 小さな 3 年の分かれ道: R → A・B、A → X ← B（合流）、A → Y → Z。ほかに自分のノード P → Q */
function smallMap(): DocData {
  const doc = createEmptyDoc();
  const add = (id: ID, extra: Partial<Parameters<typeof makeNode>[0]> = {}) => (doc.nodes[id] = makeNode({ id, title: id, ...extra }));
  add("R", { type: "goal", meta: { forecastRoot: true, impact: { v: 2, horizon: 36 } } });
  for (const id of ["A", "B", "X", "Y", "Z", "P", "Q"]) add(id, { x: id.charCodeAt(0) * 300, y: 0 });
  for (const [a, b] of [["R", "A"], ["R", "B"], ["A", "X"], ["B", "X"], ["A", "Y"], ["Y", "Z"], ["P", "Q"]] as const) doc.edges[`${a}${b}`] = makeEdge({ id: `${a}${b}`, source: a, target: b });
  return doc;
}

describe("3 年の分かれ道: カードを消す", () => {
  it("選択肢を消すと、その先だけのカードも一緒に消し（お知らせと元に戻すの名前に数）、元に戻すと全部戻る", () => {
    const s = openMap();
    s.vm.ensure();
    const doc0 = s.store.doc;
    const before = { nodes: Object.keys(doc0.nodes).length, draw: s.vm.drawNodes.length, maxY: s.vm.bounds()!.maxY };
    const alt = kidsOf(s, rootId)[3]!;
    const title = doc0.nodes[alt]!.title;
    // 期待: alt の先のうち、alt を通らずに今日から届かない物
    const reach = new Set<ID>([rootId]);
    const q = [rootId];
    while (q.length) for (const e of flowOuts(doc0, s.vm.index.out, q.pop()!)) if (e.target !== alt && !reach.has(e.target)) (reach.add(e.target), q.push(e.target));
    const only = Object.keys(doc0.nodes).filter((id) => id !== alt && !reach.has(id));
    expect(only.length).toBeGreaterThan(10);
    s.cmd.deleteNodes([alt]);
    s.vm.ensure();
    const doc = s.store.doc;
    expect(Object.keys(doc.nodes).length).toBe(before.nodes - 1 - only.length);
    expect(only.some((id) => doc.nodes[id])).toBe(false);
    // 残りはすべて 3 年の分かれ道の中（全部開いた形の遠い位置に、ふつうのカードとして散らばらない）
    expect(Object.keys(doc.nodes).every((id) => s.vm.inImpact(id))).toBe(true);
    expect(s.vm.drawNodes.length).toBeLessThan(before.draw);
    expect(s.vm.bounds()!.maxY).toBeLessThanOrEqual(before.maxY);
    const n = only.length.toLocaleString("ja-JP");
    expect(s.toasts.at(-1)).toBe(`「${title}」を削除しました（この先の ${n} 件も）`);
    expect(s.store.history.undoStack.at(-1)!.label).toBe(`「${title}」を削除（この先の ${n} 件も）`);
    s.cmd.undo();
    s.vm.ensure();
    expect(Object.keys(s.store.doc.nodes).length).toBe(before.nodes);
    expect(Object.keys(s.store.doc.edges).length).toBe(Object.keys(doc0.edges).length);
    expect(s.vm.drawNodes.length).toBe(before.draw);
  });

  it("合流先（別の選択肢からも届く物）は残し、一緒に消した線の先は数に入れる。範囲の外のノードは今までどおり先を残す", () => {
    const s = setup(smallMap());
    s.cmd.deleteNodes(["A"]);
    expect(Object.keys(s.store.doc.nodes).sort()).toEqual(["B", "P", "Q", "R", "X"]);
    expect(s.toasts.at(-1)).toBe("「A」を削除しました（この先の 2 件も）");
    s.cmd.undo();
    // 合流の線（B → X）も一緒に消すと、X も A の先だけの物になる
    s.cmd.deleteNodes(["A"], ["BX"]);
    expect(Object.keys(s.store.doc.nodes).sort()).toEqual(["B", "P", "Q", "R"]);
    expect(s.toasts.at(-1)).toBe("「A」を削除しました（この先の 3 件も）");
    s.cmd.undo();
    expect(Object.keys(s.store.doc.nodes).length).toBe(8);
    expect(s.store.doc.edges.BX).toBeDefined();
    // 範囲の外: 先は残る（数も出さない）
    s.cmd.deleteNodes(["P"]);
    expect(s.store.doc.nodes.Q).toBeDefined();
    expect(s.toasts.at(-1)).toBe("「P」を削除しました");
    // 先の無いカード・接続だけを消すときも今までどおり
    s.cmd.deleteNodes(["Z"]);
    expect(s.toasts.at(-1)).toBe("「Z」を削除しました");
    s.cmd.deleteNodes([], ["RB"]);
    expect(s.store.doc.nodes.B).toBeDefined();
    expect(s.toasts.at(-1)).toBe("接続を削除しました");
  });
});

describe("3 年の分かれ道: 複製", () => {
  it("今日を複製しても 2 つ目の入口にならず、3 年の影響の数は変わらない", () => {
    const s = openMap();
    const imp0 = s.vm.impact;
    const [copy] = s.cmd.duplicate([rootId]);
    expect(s.vm.impactRoots()).toEqual([rootId]);
    expect(s.vm.inImpact(copy!)).toBe(false);
    expect(s.vm.impact.root).toBe(rootId);
    expect(s.vm.impact.vRoot).toBe(imp0.vRoot);
    expect(s.vm.impact.ends.length).toBe(imp0.ends.length);
    const m = s.store.doc.nodes[copy!]!.meta;
    for (const k of ["forecastRoot", "impact", "futureVersion", "key"]) expect(k in m, k).toBe(false);
    // 入口の写しは動かせるふつうのカード
    const y0 = s.store.doc.nodes[copy!]!.y;
    s.cmd.moveNodes([copy!], 0, 300);
    expect(s.store.doc.nodes[copy!]!.y).toBe(y0 + 300);
  });

  it("すべて選んで複製しても、写しは 3 年の分かれ道に入らず動かせる。写しは作ったときの印（鍵・今のまま・元の文・元の見込み）を持たない", () => {
    const s = openMap();
    s.vm.ensure();
    // 作ったときの文・見込み（版の差し替えで使う）を持たせておく
    const alt = kidsOf(s, rootId).find((id) => s.store.doc.nodes[id]!.meta.base === true)!;
    expect(alt).toBeDefined();
    const pe = flowOuts(s.store.doc, s.vm.index.out, kidsOf(s, rootId)[0]!).find((e) => typeof e.meta.prob === "number")!;
    s.store.transact("準備", (tx) => {
      tx.updateNode(alt, { meta: { ...s.store.doc.nodes[alt]!.meta, t0: "元の題名", b0: "元の本文", futureRelease: "r1" } });
      tx.updateEdge(pe.id, { meta: { ...pe.meta, p0: pe.meta.prob, c0: "元の条件" } });
    });
    s.cmd.selectAll();
    const ids = [...s.ui.selection.nodes];
    expect(ids.length).toBe(s.vm.drawNodes.length);
    const copies = s.cmd.duplicate(ids);
    expect(copies.length).toBe(ids.length);
    const copyOf = new Map(ids.map((id, i) => [id, copies[i]!]));
    expect(s.vm.impactRoots()).toEqual([rootId]);
    expect(copies.some((id) => s.vm.inImpact(id))).toBe(false);
    const ac = s.store.doc.nodes[copyOf.get(alt)!]!.meta;
    // 入口のカードは作ったときからやることの指紋（k0）を持つ。写しは持たない
    expect(Array.isArray(s.store.doc.nodes[alt]!.meta.k0)).toBe(true);
    for (const k of ["base", "key", "t0", "b0", "k0", "futureRelease"]) expect(k in ac, k).toBe(false);
    const ce = Object.values(s.store.doc.edges).find((e) => e.source === copyOf.get(pe.source) && e.target === copyOf.get(pe.target))!;
    expect(ce.meta.prob).toBe(pe.meta.prob);
    expect("p0" in ce.meta || "c0" in ce.meta).toBe(false);
    // 元の線の meta はそのまま
    expect(s.store.doc.edges[pe.id]!.meta.c0).toBe("元の条件");
    // 写しは動かせる（「カードは動かせません」と言わない）
    s.cmd.moveNodes(copies, 0, 3000);
    expect(s.store.doc.nodes[copies[0]!]!.y).toBe(s.vm.posOf(ids[0]!)!.y + 40 + 3000);
    expect(s.toasts.some((t) => t.includes("動かせません"))).toBe(false);
  });
});

describe("閲覧のみのタブ: 3 年の分かれ道の開く・閉じるは見え方だけ", () => {
  it("「折りたたみをすべて開く」は 3 年の分かれ道を見え方だけで開き、文書の折りたたみには触れず、閲覧のみのお知らせも出さない", () => {
    const s = openMap();
    const { W, W2 } = ownPair(s);
    s.cmd.toggleCollapse([W]);
    expect(s.store.doc.nodes[W]!.collapsed).toBe(true);
    s.store.readOnly = true;
    const rev = s.store.revision;
    s.cmd.expandAll();
    s.vm.ensure();
    expect(s.blocked).toEqual([]);
    expect(s.store.revision).toBe(rev);
    expect(s.store.doc.nodes[W]!.collapsed).toBe(true);
    expect(s.vm.node(W2).hidden).toBe(true);
    const scope = Object.keys(s.store.doc.nodes).filter((id) => s.vm.inImpact(id));
    expect(scope.length).toBeGreaterThan(1000);
    expect(scope.every((id) => !s.vm.node(id).hidden)).toBe(true);
    // C（展開する／この先を折りたたむ）も見え方だけ
    const alt = kidsOf(s, rootId)[0]!;
    s.cmd.toggleCollapse([alt]);
    expect(s.vm.isOpen(alt)).toBe(false);
    expect(s.blocked).toEqual([]);
    // 編集できるタブでは今までどおり文書の折りたたみも開く
    s.store.readOnly = false;
    s.cmd.expandAll();
    expect(s.store.doc.nodes[W]!.collapsed).toBe(false);
  });

  it("3 年の分かれ道の無い閲覧のみのタブでは、今までどおり閲覧のみと知らせる", () => {
    // 入口の無い地図（R をふつうのノードに）で、自分のノード P を折りたたんでいる
    const doc = smallMap();
    doc.nodes.R = { ...doc.nodes.R!, meta: {} };
    doc.nodes.P = { ...doc.nodes.P!, collapsed: true };
    const s = setup(doc);
    s.store.readOnly = true;
    s.cmd.expandAll();
    expect(s.blocked).toEqual(["すべて展開"]);
    expect(s.store.doc.nodes.P!.collapsed).toBe(true);
  });
});
