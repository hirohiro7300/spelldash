// 見え方の速い作り（src/app/viewModel.ts: 見えるノードだけをたどる・索引を直すだけ・検索の表）が、基準の作り（速くする前の
// 全部をなめる作り: helpers/refView.ts。computeCollapse・computeUnreached・全部のノードの検索）と同じ答えになるかを、
// 作り物の 3,000〜5,000 枚の地図で、乱数の設定（開いている所・プロジェクトに絞る／薄くする・シナリオで隠す／薄くする・検索・選択・時点・
// 線の出し方）と乱数の編集（足す・消す・つなぐ・関係・折りたたみ・所属・題名・元に戻す・やり直す）を混ぜて確かめる（作業メモ SPEC §7.1 の 5・perf-3）
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, UiState } from "../../src/app/uiState";
import { ViewModel } from "../../src/app/viewModel";
import { flowOuts } from "../../src/model/forks";
import { buildIndex } from "../../src/model/graph";
import { makeEdge, makeNode } from "../../src/model/schema";
import type { DocData, GEdge, ID, NodeStatus, Relation } from "../../src/model/types";
import { Store } from "../../src/store/store";
import { rememberMapDoc } from "../../src/app/futureCache";
import { buildImpactDoc } from "../../src/demo/impact";
import { buildQuarterDoc } from "../../src/demo/quarterDoc";
import { r6Bundle } from "./helpers/r6";
import { refView, type RefView } from "./helpers/refView";
import { loadQSmall } from "./helpers/qSmall";
import { pick, randomOpens, rng, synthMap, type Synth } from "./helpers/synthMap";

function setup(doc: DocData) {
  const store = new Store(doc);
  const ui = new UiState(structuredClone(DEFAULT_PREFS));
  ui.persistPrefs = false;
  const vm = new ViewModel(store, ui);
  vm.narrow = () => false;
  return { store, ui, vm };
}

/** 速い作りと基準の作りの食い違い（最初の何件か） */
function diff(vm: ViewModel, ref: RefView, doc: DocData): string[] {
  vm.ensure();
  const out: string[] = [];
  const push = (s: string) => {
    if (out.length < 12) out.push(s);
  };
  const keys = ["hidden", "alpha", "match", "path", "ghost", "future", "offScenario", "collapsedCount", "collapsed", "inProject"] as const;
  for (const id in doc.nodes) {
    const b = ref.nodes.get(id)!;
    const a = vm.nodes.get(id);
    if (!a) {
      if (!b.hidden) push(`ノード ${id}: 速い作りに無いが見えている`);
      else if (!ref.owner.has(id)) push(`ノード ${id}: 自分のノードなのに速い作りに無い`);
      if (!vm.node(id).hidden) push(`ノード ${id}: node() が隠れていない`);
      continue;
    }
    for (const k of keys) if (a[k] !== b[k]) push(`ノード ${id}.${k}: ${String(a[k])} ≠ 基準 ${String(b[k])}`);
  }
  const eq = (name: string, x: unknown, y: unknown) => {
    const sx = JSON.stringify(x);
    const sy = JSON.stringify(y);
    if (sx !== sy) push(`${name}: ${sx.slice(0, 300)} ≠ 基準 ${sy.slice(0, 300)}`);
  };
  eq("drawNodes", vm.drawNodes, ref.drawNodes);
  eq("drawEdges", vm.drawEdges, ref.drawEdges);
  eq("stubEdges", vm.stubEdges, ref.stubEdges);
  eq("hiddenCount", vm.hiddenCount, ref.hiddenCount);
  eq("pathActive", vm.pathActive, ref.pathActive);
  eq("searchActive", vm.searchActive, ref.searchActive);
  eq("searchCount", vm.searchCount, ref.searchAll.length);
  eq("searchHits", vm.searchHits, ref.searchAll.slice(0, 50));
  // 隠れた線の薄さは誰も読まない（描くのは drawEdges だけ）。先が隠れた地図のカードの線は、速い作りでは先の NodeVis が無いので比べない
  for (const [id, ev] of vm.edges) {
    const r = ref.edges.get(id);
    if (!r) push(`線 ${id}: 基準に無い`);
    else if (ev.hidden && r.hidden) eq(`線 ${id}`, { ...ev, alpha: 0 }, { ...r, alpha: 0 });
    else eq(`線 ${id}`, ev, r);
  }
  for (const id of vm.drawNodes) {
    const r = ref.overlay.get(id);
    if (r) eq(`位置 ${id}`, vm.posOf(id), r);
    else if (vm.hasOverlay(id)) push(`位置 ${id}: 基準では重ねる位置が無い`);
  }
  eq("重ねる位置の数", vm.overlayPoints().length, ref.overlay.size);
  return out;
}

/** 乱数の見え方の設定 */
function randomUi(rand: () => number, ui: UiState, vm: ViewModel, syn: Synth, doc: DocData): void {
  const kidsOf = (id: ID) => flowOuts(doc, buildIndexCache(doc).out, id).map((e) => e.target);
  const open = randomOpens(rand, doc, syn.roots.filter((r) => doc.nodes[r]), kidsOf, syn.cards.filter((c) => doc.nodes[c]));
  for (const [r, ids] of Object.entries(open)) ui.setImpactOpen(r, ids);
  const u = rand();
  const projectFilter = u < 0.55 ? [] : u < 0.85 ? [pick(rand, syn.projects)] : [syn.projects[0]!, syn.projects[2]!];
  const scenarioId = rand() < 0.5 ? null : pick(rand, syn.scenarios);
  ui.setPrefs({
    projectFilter,
    projectMode: rand() < 0.5 ? "dim" : "focus",
    scenarioId,
    scenarioMode: rand() < 0.5 ? "dim" : "hide",
    timeCursor: rand() < 0.3 ? "2027-06-15" : null,
    pathHighlight: rand() < 0.8,
    edgeMode: rand() < 0.8 ? "all" : rand() < 0.5 ? "selection" : "cross",
  });
  const s = rand();
  ui.setSearch(s < 0.5 ? "" : s < 0.6 ? "#仕事" : s < 0.7 ? "#spell" : s < 0.8 ? "結果" : s < 0.9 ? pick(rand, ["転職", "ｶﾀｶﾅ", "かたかな", "abc", "の", "判断 副業"]) : "存在しない言葉");
  // 選択: 見えているノード・隠れたノード・線
  vm.ensure();
  const ids = Object.keys(doc.nodes);
  const sel: ID[] = [];
  if (rand() < 0.7) sel.push(rand() < 0.6 && vm.drawNodes.length ? pick(rand, vm.drawNodes) : pick(rand, ids));
  if (rand() < 0.2) sel.push(pick(rand, ids));
  ui.select(sel, rand() < 0.1 && vm.drawEdges.length ? [pick(rand, vm.drawEdges)] : []);
}

const indexCache = new WeakMap<object, { at: string; idx: ReturnType<typeof buildIndex> }>();
function buildIndexCache(doc: DocData) {
  const at = `${Object.keys(doc.edges).length}|${Object.keys(doc.nodes).length}`;
  const c = indexCache.get(doc);
  if (c && c.at === at) return c.idx;
  const idx = buildIndex(doc);
  indexCache.set(doc, { at, idx });
  return idx;
}

/** 乱数の編集（ストアを通す。元に戻す・やり直すも） */
function randomEdit(rand: () => number, store: Store, syn: Synth, k: number): void {
  const doc = store.doc;
  const ids = Object.keys(doc.nodes);
  const eids = Object.keys(doc.edges);
  const u = rand();
  const rels: Relation[] = ["leads", "condition", "supports", "blocks", "feedback"];
  if (u < 0.12) {
    // 自分のノードを足して、地図か自分のノードとつなぐ
    const id = `nu${k}`;
    store.transact("足す", (tx) => {
      tx.addNode(makeNode({ id, title: `足した ${k}`, projectIds: rand() < 0.5 ? [pick(rand, syn.projects)] : [], collapsed: rand() < 0.2 }));
      tx.addEdge(makeEdge({ id: `eu${k}`, source: rand() < 0.5 ? pick(rand, ids) : id, target: rand() < 0.5 ? id : pick(rand, ids), relation: pick(rand, rels) }));
    });
    syn.users.push(id);
  } else if (u < 0.24) {
    const s = pick(rand, ids);
    const t = pick(rand, ids);
    store.transact("つなぐ", (tx) => tx.addEdge(makeEdge({ id: `el${k}`, source: s, target: t, relation: pick(rand, rels), collapsed: rand() < 0.1 })));
  } else if (u < 0.32 && eids.length) {
    store.transact("線を消す", (tx) => tx.deleteEdge(pick(rand, eids)));
  } else if (u < 0.38) {
    // ノードを消す（地図のカードも。先は残る＝範囲の外へ出る）
    const id = rand() < 0.5 && syn.users.length ? pick(rand, syn.users) : pick(rand, ids);
    if (doc.nodes[id] && !syn.roots.includes(id)) store.transact("消す", (tx) => tx.deleteNode(id));
  } else if (u < 0.46 && eids.length) {
    const id = pick(rand, eids);
    const e = doc.edges[id]!;
    const patch: Partial<GEdge> = rand() < 0.4 ? { relation: pick(rand, rels) } : rand() < 0.5 ? { collapsed: !e.collapsed } : rand() < 0.5 ? { scenarioIds: rand() < 0.5 ? [] : [pick(rand, syn.scenarios)] } : { label: `ラベル ${k}`, condition: rand() < 0.5 ? `判断 転職 ${k}` : "" };
    store.transact("線を変える", (tx) => tx.updateEdge(id, patch));
  } else if (u < 0.52 && eids.length) {
    // 付け替え
    const id = pick(rand, eids);
    store.transact("付け替え", (tx) => tx.updateEdge(id, { target: pick(rand, ids) }));
  } else if (u < 0.7) {
    const id = pick(rand, ids);
    const n = doc.nodes[id]!;
    const v = rand();
    const statuses: NodeStatus[] = ["open", "active", "done", "dropped"];
    const patch =
      v < 0.25
        ? { title: `${n.title}あ` }
        : v < 0.4
          ? { status: pick(rand, statuses) }
          : v < 0.55
            ? { collapsed: !n.collapsed }
            : v < 0.7
              ? { projectIds: rand() < 0.3 ? [] : [pick(rand, syn.projects)] }
              : v < 0.8
                ? { scenarioIds: rand() < 0.5 ? [] : [pick(rand, syn.scenarios)] }
                : v < 0.9
                  ? { time: { due: rand() < 0.3 ? null : "2028-03-31", start: null }, tags: rand() < 0.5 ? [] : ["仕事", "副業"] }
                  : { meta: { ...n.meta, short: `ひとこと 転職 ${k}` } };
    store.transact("ノードを変える", (tx) => tx.updateNode(id, patch));
  } else if (u < 0.85) {
    store.undo();
  } else if (u < 0.95) {
    store.redo();
  } else {
    // 全部の入れ替え（取り込みの写し。物はどれも新しく、カードを 1 つ書き換える）: 見え方は変わった物だけで受ける（見直し perf-4）
    const next = structuredClone(doc);
    const id = pick(rand, ids);
    if (next.nodes[id]) next.nodes[id] = { ...next.nodes[id]!, title: `${next.nodes[id]!.title}（取り込み）`, collapsed: rand() < 0.5 ? !next.nodes[id]!.collapsed : next.nodes[id]!.collapsed };
    store.replaceDoc(next, "取り込み");
  }
}

/** 隠れたノードを出す計画: 見えるようになるか（3 年の分かれ道のカードは入口からの親をたどる）。木の道なら基準と同じ物を開くか */
function checkBlockers(rand: () => number, store: Store, ui: UiState, vm: ViewModel, ref: RefView, doc: DocData, problems: string[]): void {
  vm.ensure();
  const hidden = Object.keys(doc.nodes).filter((id) => vm.node(id).hidden && !vm.hiddenBy(id).focus && !vm.hiddenBy(id).scenario);
  for (let i = 0; i < 4 && hidden.length; i++) {
    const id = pick(rand, hidden);
    const a = vm.collapseBlockers(id);
    const b = ref.collapseBlockers(id);
    const hb = vm.hiddenBy(id);
    const rb = ref.hiddenBy(id);
    if (JSON.stringify(hb) !== JSON.stringify(rb)) problems.push(`hiddenBy ${id}: ${JSON.stringify(hb)} ≠ 基準 ${JSON.stringify(rb)}`);
    const sorted = (x: { nodes: ID[]; edges: ID[]; open: ID[] }) => JSON.stringify({ nodes: [...x.nodes].sort(), edges: [...x.edges].sort(), open: [...x.open].sort() });
    // 地図のカードで、隠れた親が木の線 1 本だけで入る道なら、基準と同じ
    const filtered = (ui.prefs.projectFilter.some((p) => doc.projects[p]) && ui.prefs.projectMode === "focus") || (!!ui.prefs.scenarioId && !!doc.scenarios[ui.prefs.scenarioId] && ui.prefs.scenarioMode === "hide");
    const fastImpact = vm.inImpact(id) && !filtered;
    let regular = true;
    if (fastImpact) {
      const idx = buildIndex(doc);
      for (const c of vm.impactChain(id).slice(1)) {
        if (!vm.node(c).hidden) continue;
        const ins = (idx.inc.get(c) ?? []).filter((eid) => doc.edges[eid] && doc.edges[eid]!.source !== c);
        if (ins.length !== 1) regular = false;
      }
    }
    if ((!fastImpact || regular) && sorted(a) !== sorted(b)) problems.push(`開く物 ${id}（${fastImpact ? "親をたどる" : "基準と同じ作り"}・親 ${vm.impactChain(id).join(">")}）: ${sorted(a)} ≠ 基準 ${sorted(b)}`);
    // 開くと見える（見え方を変えて確かめ、戻す）
    if (!a.open.length && !a.nodes.length && !a.edges.length) {
      problems.push(`開く物が無いのに隠れている ${id}`);
      continue;
    }
    const before = structuredClone(ui.prefs.impactOpen);
    if (a.open.length) vm.setImpactOpen(a.open);
    let changed = false;
    if (a.nodes.length || a.edges.length) {
      changed = store.transact("出す", (tx) => {
        for (const n of a.nodes) tx.updateNode(n, { collapsed: false });
        for (const e of a.edges) tx.updateEdge(e, { collapsed: false });
      });
    }
    if (vm.node(id).hidden) problems.push(`開いても見えない ${id}（${sorted(a)}）`);
    if (changed) store.undo();
    for (const r of Object.keys(ui.prefs.impactOpen)) ui.setImpactOpen(r, before[r] ?? null);
  }
}

describe("見え方の速い作り: 作り物の地図で基準の作りと同じ答え", () => {
  for (const [seed, cards, twoRoots] of [
    [1, 3200, false],
    [2, 4200, true],
    [3, 3600, false],
    [4, 4800, true],
  ] as const) {
    it(`種 ${seed}・${cards} 枚${twoRoots ? "・入口 3 つ" : ""}: 乱数の設定 24 通りと乱数の編集`, () => {
      const syn = synthMap(seed, { cards, users: 120, links: 260, twoRoots });
      const { store, ui, vm } = setup(syn.doc);
      const rand = rng(seed * 7919);
      const problems: string[] = [];
      for (let round = 0; round < 24; round++) {
        if (round > 0) {
          const edits = Math.floor(rand() * 4);
          for (let k = 0; k < edits; k++) randomEdit(rand, store, syn, round * 10 + k);
        }
        randomUi(rand, ui, vm, syn, store.doc);
        const ref = refView(store.doc, ui, false);
        const d = diff(vm, ref, store.doc);
        if (d.length) problems.push(`回 ${round}（${JSON.stringify({ f: ui.prefs.projectFilter, m: ui.prefs.projectMode, s: ui.prefs.scenarioId, sm: ui.prefs.scenarioMode, q: ui.search })}）:\n  ${d.join("\n  ")}`);
        if (round % 3 === 0) checkBlockers(rand, store, ui, vm, refView(store.doc, ui, false), store.doc, problems);
        if (problems.length > 6) break;
      }
      expect(problems.join("\n")).toBe("");
    });
  }

  it("開く・閉じる・選ぶ・時点・題名の 1 文字では、見えるノードを作り直さない（同じ答えのまま）", () => {
    const syn = synthMap(11, { cards: 3000, users: 40, links: 60 });
    const { store, ui, vm } = setup(syn.doc);
    vm.ensure();
    const fast = () => (vm as unknown as { last: { fast: { visible: Set<ID> } | null } }).last.fast;
    const v0 = fast();
    expect(v0).not.toBeNull();
    ui.select([vm.drawNodes[3]!]);
    vm.ensure();
    ui.setPrefs({ timeCursor: "2027-01-01" });
    vm.ensure();
    store.transact("題名", (tx) => tx.updateNode(vm.drawNodes[2]!, { title: "題名を変えた" }));
    vm.ensure();
    expect(fast()).toBe(v0);
    expect(diff(vm, refView(store.doc, ui, false), store.doc)).toEqual([]);
    // 開くと作り直す（閉じていて先のあるカード）
    const closed = vm.drawNodes.find((id) => vm.inImpact(id) && vm.isCollapsed(id))!;
    expect(vm.setImpactOpen([closed])).toBe(true);
    vm.ensure();
    expect(fast()).not.toBe(v0);
    expect(diff(vm, refView(store.doc, ui, false), store.doc)).toEqual([]);
  });

  it("閉じたカードの件数は、先が木なら先の数（たどらない）。先に別の線が入ると隠れた所をたどる", () => {
    const syn = synthMap(12, { cards: 3000, users: 0, links: 0 });
    const { store, ui, vm } = setup(syn.doc);
    vm.ensure();
    const root = vm.impactRoots()[0]!;
    const opts = vm.index.out.get(root)!.map((e) => store.doc.edges[e]!.target);
    // 選択肢は閉じている（広い画面の最初の形は今日と選択肢を開く）。1 つ目を閉じて数を見る
    vm.setImpactOpen([], [opts[0]!]);
    vm.ensure();
    const ref = refView(store.doc, ui, false);
    expect(vm.node(opts[0]!).collapsedCount).toBe(ref.nodes.get(opts[0]!)!.collapsedCount);
    expect(vm.node(opts[0]!).collapsedCount).toBeGreaterThan(0);
    // 先の深いカードへ自分のノードから相乗効果の線: そのカードは見え、件数は減る
    const below = vm.impactChain(syn.cards.find((c) => vm.impactChain(c)[1] === opts[0] && vm.impactChain(c).length > 4)!);
    const deepCard = below[below.length - 1]!;
    store.transact("足す", (tx) => {
      tx.addNode(makeNode({ id: "mine", title: "自分" }));
      tx.addEdge(makeEdge({ id: "mine-e", source: "mine", target: deepCard, relation: "supports" }));
    });
    vm.ensure();
    const ref2 = refView(store.doc, ui, false);
    expect(vm.node(deepCard).hidden).toBe(false);
    expect(vm.node(opts[0]!).collapsedCount).toBe(ref2.nodes.get(opts[0]!)!.collapsedCount);
    expect(vm.node(opts[0]!).collapsedCount).toBeLessThan(ref.nodes.get(opts[0]!)!.collapsedCount);
    expect(diff(vm, ref2, store.doc)).toEqual([]);
  });

  it("地図のカードから「進む」でつないだ自分のノードは範囲に入り、カードを閉じると一緒に隠れる。相乗効果の線の先は隠れない", () => {
    const syn = synthMap(13, { cards: 3000, users: 0, links: 0 });
    const { store, ui, vm } = setup(syn.doc);
    vm.ensure();
    const root = vm.impactRoots()[0]!;
    const opt = vm.index.out.get(root)!.map((e) => store.doc.edges[e]!.target)[0]!;
    store.transact("つなぐ", (tx) => {
      tx.addNode(makeNode({ id: "flow-user", title: "道でつないだ" }));
      tx.addNode(makeNode({ id: "sup-user", title: "相乗効果でつないだ" }));
      tx.addEdge(makeEdge({ id: "fu", source: opt, target: "flow-user", relation: "leads" }));
      tx.addEdge(makeEdge({ id: "su", source: opt, target: "sup-user", relation: "supports" }));
    });
    vm.setImpactOpen([opt]);
    vm.ensure();
    expect(vm.inImpact("flow-user")).toBe(true);
    expect(vm.inImpact("sup-user")).toBe(false);
    expect(vm.node("flow-user").hidden).toBe(false);
    vm.setImpactOpen([], [opt]);
    vm.ensure();
    expect(vm.node("flow-user").hidden).toBe(true);
    expect(vm.node("sup-user").hidden).toBe(false);
    expect(diff(vm, refView(store.doc, ui, false), store.doc)).toEqual([]);
    // 隠れたカードへ寄る: 入口からの親をたどって開く
    const deep = syn.cards.find((c) => vm.impactChain(c).length > 6 && vm.node(c).hidden)!;
    expect(vm.openPathTo(deep)).toBe(true);
    expect(vm.node(deep).hidden).toBe(false);
    expect(diff(vm, refView(store.doc, ui, false), store.doc)).toEqual([]);
  });

  it("版 6 の地図（1,533 枚）: 乱数の開き方・シナリオ・プロジェクト・検索・選択で、速くする前と同じ見え方", () => {
    const doc = buildImpactDoc(r6Bundle(), new Date(2026, 10, 18), "t");
    const { store, ui, vm } = setup(doc);
    vm.ensure();
    const rand = rng(1533);
    const cards = Object.keys(store.doc.nodes);
    const kidsOf = (id: ID) => flowOuts(store.doc, buildIndexCache(store.doc).out, id).map((e) => e.target);
    const problems: string[] = [];
    for (let round = 0; round < 16; round++) {
      for (const [r, ids] of Object.entries(randomOpens(rand, store.doc, vm.impactRoots(), kidsOf, cards))) ui.setImpactOpen(r, ids);
      ui.setPrefs({
        scenarioId: rand() < 0.5 ? null : pick(rand, store.doc.scenarioOrder),
        scenarioMode: rand() < 0.5 ? "dim" : "hide",
        projectFilter: rand() < 0.6 ? [] : [pick(rand, store.doc.projectOrder)],
        projectMode: rand() < 0.5 ? "dim" : "focus",
      });
      ui.setSearch(rand() < 0.5 ? "" : pick(rand, ["転職", "副業", "広告", "受かる", "#3か月後"]));
      vm.ensure();
      ui.select(rand() < 0.7 && vm.drawNodes.length ? [pick(rand, vm.drawNodes)] : []);
      if (round % 4 === 3) vm.openPathTo(pick(rand, cards));
      const d = diff(vm, refView(store.doc, ui, false), store.doc);
      if (d.length) problems.push(`回 ${round}: ${d.join("\n  ")}`);
    }
    expect(problems.join("\n")).toBe("");
  });

  it("組み立てたままの 3 か月ごとの地図（q-small・4,333 枚）は範囲と先の数を地図の形から作り、形を変えたら文書から作り直す（どちらも基準と同じ）", async () => {
    const map = await loadQSmall();
    const doc = buildQuarterDoc(map, { version: map.header.hash, release: map.header.release, at: Date.UTC(2026, 10, 1), layout: "columns" });
    rememberMapDoc(doc, map);
    const { store, ui, vm } = setup(doc);
    vm.ensure();
    const scopeOrder = () => (vm as unknown as { scopeInfo(): { order: ID[] } }).scopeInfo().order;
    // 地図の形から（番号は地図の深さ優先の順）
    expect(vm.engine.mapTopo(store.doc)).not.toBeNull();
    expect(scopeOrder()).toBe(vm.engine.mapTopo(store.doc)!.ids);
    const rand = rng(4333);
    const cards = Object.keys(store.doc.nodes);
    const kidsOf = (id: ID) => flowOuts(store.doc, buildIndexCache(store.doc).out, id).map((e) => e.target);
    for (let round = 0; round < 6; round++) {
      for (const [r, ids] of Object.entries(randomOpens(rand, store.doc, vm.impactRoots(), kidsOf, cards))) ui.setImpactOpen(r, ids);
      ui.setPrefs({ scenarioId: round % 3 === 1 ? "s_early" : null });
      if (round % 2) vm.openPathTo(pick(rand, cards));
      expect(diff(vm, refView(store.doc, ui, false), store.doc)).toEqual([]);
    }
    // 形を変えた（自分のノードを地図の中へつなぐ）: 文書から作り直す
    store.transact("つなぐ", (tx) => {
      tx.addNode(makeNode({ id: "mine", title: "自分" }));
      tx.addEdge(makeEdge({ id: "mine-e", source: "mine", target: cards[100]!, relation: "supports" }));
    });
    vm.ensure();
    // 3 年の影響の形は変わらない（相乗効果の線）が、自分のノードがあるので範囲は文書からたどる
    expect(scopeOrder()).not.toBe(vm.engine.mapTopo(store.doc)?.ids);
    expect(diff(vm, refView(store.doc, ui, false), store.doc)).toEqual([]);
    store.undo();
    vm.ensure();
    expect(diff(vm, refView(store.doc, ui, false), store.doc)).toEqual([]);
  });

  it("トランザクションの中のノードの線は索引から答え、全部の線から作った物と同じ（消す・つなぐの重なり・付け替え）", () => {
    const syn = synthMap(14, { cards: 3000, users: 60, links: 120 });
    const { store, vm } = setup(syn.doc);
    vm.ensure();
    const rand = rng(99);
    for (let k = 0; k < 60; k++) {
      const ids = Object.keys(store.doc.nodes);
      const eids = Object.keys(store.doc.edges);
      const id = pick(rand, ids);
      const u = rand();
      store.transact("混ぜた", (tx) => {
        if (u < 0.3 && eids.length) tx.updateEdge(pick(rand, eids), { source: id });
        if (u < 0.6) tx.addEdge(makeEdge({ source: id, target: pick(rand, ids) }));
        if (rand() < 0.5 && !syn.roots.includes(id)) tx.deleteNode(id);
        // 同じ向きの重なりは作らない（索引から答えても）
        const e0 = Object.values(store.doc.edges)[0];
        if (e0) expect(tx.addEdge(makeEdge({ source: e0.source, target: e0.target }))).toBeNull();
      });
      // 消したノードの線が残っていない
      for (const e of Object.values(store.doc.edges)) {
        expect(store.doc.nodes[e.source], `${e.id} の元`).toBeDefined();
        expect(store.doc.nodes[e.target], `${e.id} の先`).toBeDefined();
      }
      if (rand() < 0.2) store.undo();
    }
    // 索引も、作り直した物と同じ
    const fresh = buildIndex(store.doc);
    for (const id of Object.keys(store.doc.nodes)) {
      expect(vm.index.out.get(id)).toEqual(fresh.out.get(id));
      expect(vm.index.inc.get(id)).toEqual(fresh.inc.get(id));
    }
  });
});

