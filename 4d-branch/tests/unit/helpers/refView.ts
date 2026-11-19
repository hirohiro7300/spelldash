// 見え方の計算の「基準の作り」: 速くする前の view model（src/app/viewModel.ts の 89136c1 の版）の見え方の部分を、そのまま写した物。
// 文書全部をなめて、索引（buildIndex）・範囲・computeCollapse・computeUnreached・検索（全部のノードの点数）から作る。
// 速くした view model が、どの設定・どの文書でもこれと同じ答えになるかを確かめる（tests/unit/visibleSet*.test.ts）。
// 検索だけは、P2 で探す所を足した（ひとこと・入ってくる線の結果の名前と判断の文: 作業メモ SPEC §4.4）ので、その所も入れて点数を出す

import type { EdgeVis, NodeVis } from "../../../src/app/viewModel";
import type { UiState } from "../../../src/app/uiState";
import { NODE_TYPES, STATUSES } from "../../../src/model/constants";
import { flowOuts, forkKindOf, isFlowEdge, isImpactRoot } from "../../../src/model/forks";
import { buildIndex, inScenario, type GraphIndex } from "../../../src/model/graph";
import { compareImpactKids, outlineLayout } from "../../../src/model/impactLayout";
import { isEmptyQuery, normalizeText, parseQuery, type SearchQuery } from "../../../src/model/search";
import type { DocData, GEdge, GNode, ID } from "../../../src/model/types";
import { computeCollapse, computePaths, computeUnreached, type CollapseResult } from "../../../src/model/visibility";

type Pt = { x: number; y: number };

export interface RefView {
  index: GraphIndex;
  nodes: Map<ID, NodeVis>;
  edges: Map<ID, EdgeVis>;
  drawNodes: ID[];
  drawEdges: ID[];
  stubEdges: Array<{ id: ID; count: number }>;
  hiddenCount: number;
  pathActive: boolean;
  searchActive: boolean;
  /** 当たり全部（点数の高い順・同じ点数は題名の順） */
  searchAll: Array<{ id: ID; score: number }>;
  /** 重ねる位置（入口の位置を足した物） */
  overlay: Map<ID, Pt>;
  roots: ID[];
  owner: Map<ID, ID>;
  hiddenBy(id: ID): { focus: boolean; scenario: boolean; collapse: boolean };
  collapseBlockers(id: ID): { nodes: ID[]; edges: ID[]; open: ID[] };
  /** 開いているノード（入口ごと） */
  opens: Set<ID>[];
}

/** 検索の点数（P2 で探す所を足した物。./search.ts の scoreNode と同じ点の付け方） */
export function refScore(doc: DocData, index: GraphIndex, n: GNode, q: SearchQuery): number {
  const title = normalizeText(n.title);
  const tags = n.tags.map(normalizeText);
  const names = n.projectIds.map((p) => doc.projects[p]?.name ?? "").join(" ");
  const ins: string[] = [];
  for (const eid of index.inc.get(n.id) ?? []) {
    const e = doc.edges[eid];
    if (e) ins.push(e.label, e.condition);
  }
  const short = typeof n.meta?.short === "string" ? n.meta.short : "";
  const parts = [n.title, n.body, n.tags.join(" "), ...n.conditions.map((c) => c.text), NODE_TYPES[n.type].label, STATUSES[n.status].label, n.time.due ?? "", short, ...ins].filter(Boolean).map(normalizeText);
  const nameNorm = names ? normalizeText(names) : "";
  let score = 0;
  for (const t of q.tags) {
    if (!tags.some((x) => x.startsWith(t))) return -1;
    score += tags.includes(t) ? 30 : 20;
  }
  for (const t of q.terms) {
    const i = title.indexOf(t);
    if (i >= 0) score += i === 0 ? 40 : 25;
    else if (parts.some((p) => p.includes(t)) || (nameNorm && nameNorm.includes(t))) score += 8;
    else return -1;
  }
  if (n.type === "goal") score += 2;
  return score;
}

/** 検索の当たり全部（点数の高い順・同じ点数は題名の順。localeCompare("ja") の安定な並べ替え） */
export function refSearch(doc: DocData, index: GraphIndex, q: SearchQuery): Array<{ id: ID; score: number }> {
  if (isEmptyQuery(q)) return [];
  const out: Array<{ id: ID; score: number }> = [];
  for (const id in doc.nodes) {
    const s = refScore(doc, index, doc.nodes[id]!, q);
    if (s >= 0) out.push({ id, score: s });
  }
  out.sort((a, b) => b.score - a.score || (doc.nodes[a.id]!.title || "").localeCompare(doc.nodes[b.id]!.title || "", "ja"));
  return out;
}

/** 速くする前の見え方（ui の設定・選択・検索で）。narrow は最初の形（保存した開いている所が無い入口の） */
export function refView(doc: DocData, ui: UiState, narrow = false): RefView {
  const idx = buildIndex(doc);
  const prefs = ui.prefs;
  const filter = prefs.projectFilter.filter((p) => doc.projects[p]);
  const hasFilter = filter.length > 0;
  const fset = new Set(filter);
  const focus = hasFilter && prefs.projectMode === "focus";
  const sid = prefs.scenarioId && doc.scenarios[prefs.scenarioId] ? prefs.scenarioId : null;
  const hideScen = sid !== null && prefs.scenarioMode === "hide";
  const cursor = prefs.timeCursor;
  const sel = ui.selection;
  const inProj = (pids: ID[]) => !hasFilter || pids.some((p) => fset.has(p));
  const edgeInScen = (e: GEdge) => inScenario(e.scenarioIds, sid);

  // 範囲（入口から幅優先）
  const roots = Object.keys(doc.nodes)
    .filter((id) => isImpactRoot(doc.nodes[id]))
    .sort();
  const owner = new Map<ID, ID>();
  const depth = new Map<ID, number>();
  for (const r of roots) {
    if (owner.has(r)) continue;
    owner.set(r, r);
    depth.set(r, 0);
    const queue = [r];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]!;
      for (const e of flowOuts(doc, idx.out, id)) {
        if (owner.has(e.target)) continue;
        owner.set(e.target, r);
        depth.set(e.target, depth.get(id)! + 1);
        queue.push(e.target);
      }
    }
  }
  const impactKids = (id: ID): ID[] => {
    const r = owner.get(id);
    const list: ID[] = [];
    for (const eid of idx.out.get(id) ?? []) {
      const e = doc.edges[eid];
      if (!e || e.source === e.target || !isFlowEdge(e) || owner.get(e.target) !== r || list.includes(e.target)) continue;
      list.push(e.target);
    }
    return list;
  };
  const opens = roots.map((r) => {
    const src = prefs.impactOpen[r];
    if (src) return new Set(src);
    const set = new Set([r]);
    if (!narrow) for (const k of impactKids(r)) set.add(k);
    return set;
  });

  // 範囲（シナリオで隠す・プロジェクトに絞る）と折りたたみ・シナリオの推定
  const scope = new Set<ID>();
  for (const id in doc.nodes) {
    const n = doc.nodes[id]!;
    if (hideScen && !inScenario(n.scenarioIds, sid)) continue;
    if (focus && !inProj(n.projectIds)) continue;
    scope.add(id);
  }
  const ghost = new Set<ID>();
  if (focus) {
    for (const id of [...scope]) {
      for (const list of [idx.out.get(id), idx.inc.get(id)]) {
        for (const eid of list ?? []) {
          const e = doc.edges[eid]!;
          const other = e.source === id ? e.target : e.source;
          if (scope.has(other) || ghost.has(other)) continue;
          const on = doc.nodes[other];
          if (!on) continue;
          if (hideScen && (!inScenario(on.scenarioIds, sid) || !edgeInScen(e))) continue;
          ghost.add(other);
        }
      }
    }
    for (const g of ghost) scope.add(g);
  }
  const edgeOk = (e: GEdge) => !hideScen || edgeInScen(e);
  const openOf = new Map(roots.map((r, i) => [r, opens[i]!]));
  const collapsedOf = roots.length
    ? (id: ID): boolean => {
        const r = owner.get(id);
        return r !== undefined ? !openOf.get(r)!.has(id) : !!doc.nodes[id]?.collapsed;
      }
    : (id: ID): boolean => !!doc.nodes[id]?.collapsed;
  const stops = (e: GEdge): boolean => {
    const r = owner.get(e.source);
    return r === undefined || (isFlowEdge(e) && owner.get(e.target) === r);
  };
  const forced = new Set(roots.filter((r) => owner.get(r) === r));
  const branches = new Set<ID>();
  for (const id of owner.keys()) {
    for (const eid of idx.out.get(id) ?? []) {
      const e = doc.edges[eid];
      if (e && e.source !== e.target && stops(e)) {
        branches.add(id);
        break;
      }
    }
  }
  const col: CollapseResult = computeCollapse(doc, idx, scope, edgeOk, collapsedOf, { stops, roots: forced });
  const unreached = sid ? computeUnreached(doc, idx, scope, edgeInScen, forced) : new Set<ID>();

  // 検索
  const q = parseQuery(ui.search);
  const searchActive = !isEmptyQuery(q);
  const searchAll = searchActive ? refSearch(doc, idx, q) : [];
  const hitSet = new Set(searchAll.map((h) => h.id));

  // 経路
  const shown = (id: ID) => scope.has(id) && !col.hidden.has(id) && !(hideScen && unreached.has(id));
  const selected = [...sel.nodes].filter(shown);
  const pathActive = prefs.pathHighlight && selected.length > 0;
  const paths = pathActive ? computePaths(doc, idx, selected, (e) => edgeOk(e) && (!sid || edgeInScen(e)) && shown(e.source) && shown(e.target)) : null;
  const siblings = new Set<ID>();
  if (paths && roots.length) {
    for (const id of selected) {
      if (!owner.has(id)) continue;
      for (const eid of idx.inc.get(id) ?? []) {
        const e = doc.edges[eid];
        const d = e && doc.nodes[e.source];
        if (!e || !d || !isFlowEdge(e) || !owner.has(d.id)) continue;
        const outs = flowOuts(doc, idx.out, d.id);
        if (forkKindOf(d, outs) !== "decision") continue;
        for (const o of outs) {
          if (!shown(o.target)) continue;
          siblings.add(o.target);
          siblings.add(o.id);
        }
      }
    }
  }

  // ノード
  const nodes = new Map<ID, NodeVis>();
  const draw: ID[] = [];
  const drawTop: ID[] = [];
  let hiddenCount = 0;
  const visibleScope: ID[] = [];
  for (const id in doc.nodes) {
    const n = doc.nodes[id]!;
    const offScenario = sid !== null && (!inScenario(n.scenarioIds, sid) || unreached.has(id));
    const hidden = !scope.has(id) || col.hidden.has(id) || (hideScen && offScenario);
    const inProject = inProj(n.projectIds);
    const isGhost = ghost.has(id);
    let alpha = 1;
    if (hasFilter && !inProject) alpha = Math.min(alpha, isGhost ? 0.55 : 0.13);
    if (offScenario) alpha = Math.min(alpha, 0.22);
    const future = !!(cursor && n.time.due && n.time.due > cursor);
    if (future) alpha = Math.min(alpha, 0.18);
    const match = hitSet.has(id);
    if (searchActive && !match) alpha = Math.min(alpha, 0.14);
    const path = !!paths?.nodes.has(id);
    if (pathActive && !path && !siblings.has(id)) alpha = Math.min(alpha, 0.3);
    if (hidden) hiddenCount++;
    const inImpact = owner.has(id);
    const closed = inImpact ? collapsedOf(id) : n.collapsed;
    const collapsedCount = closed ? (col.counts.get(id) ?? 0) : 0;
    const collapsed = inImpact ? closed && branches.has(id) : n.collapsed;
    nodes.set(id, { hidden, alpha, match, path, ghost: isGhost, future, offScenario, collapsedCount, collapsed, inProject });
    if (!hidden) {
      (sel.nodes.has(id) ? drawTop : draw).push(id);
      if (inImpact) visibleScope.push(id);
    }
  }

  // 接続
  const edges = new Map<ID, EdgeVis>();
  const edgesNormal: ID[] = [];
  const edgesTop: ID[] = [];
  const stubs: Array<{ id: ID; count: number }> = [];
  for (const id in doc.edges) {
    const e = doc.edges[id]!;
    const a = nodes.get(e.source);
    const b = nodes.get(e.target);
    const src = doc.nodes[e.source];
    const offScenario = sid !== null && !edgeInScen(e);
    const cross = idx.cross.has(id);
    const srcClosed = !!src && collapsedOf(src.id) && stops(e);
    let hidden = !a || !b || a.hidden || b.hidden || (hideScen && offScenario) || srcClosed || e.collapsed;
    const incident = sel.nodes.has(e.source) || sel.nodes.has(e.target) || sel.edges.has(id);
    if (prefs.edgeMode === "selection" && !incident) hidden = true;
    if (prefs.edgeMode === "cross" && !cross && !incident) hidden = true;
    let alpha = Math.min(a?.alpha ?? 0, b?.alpha ?? 0);
    if (offScenario) alpha = Math.min(alpha, 0.16);
    const path = !!paths?.edges.has(id);
    if (pathActive && !path && !siblings.has(id)) alpha = Math.min(alpha, 0.2);
    edges.set(id, { hidden, alpha, path, cross, offScenario });
    if (!hidden) (path || sel.edges.has(id) ? edgesTop : edgesNormal).push(id);
    if (e.collapsed && a && !a.hidden && !srcClosed && !(hideScen && offScenario)) stubs.push({ id, count: col.counts.get(id) ?? 0 });
  }

  // 重ねる位置
  const overlay = new Map<ID, Pt>();
  if (roots.length) {
    const shownSet = new Set(visibleScope);
    roots.forEach((r, i) => {
      const open = opens[i]!;
      const kids = (id: ID): ID[] => {
        if (!open.has(id)) return [];
        const list = impactKids(id).filter((c) => shownSet.has(c));
        if (list.length > 1) list.sort((a, b) => compareImpactKids(doc.nodes[a]!, doc.nodes[b]!));
        return list;
      };
      const mine = visibleScope.filter((id) => owner.get(id) === r);
      if (!mine.length) return;
      const rootKids = shownSet.has(r) ? kids : () => [];
      let pos = outlineLayout(r, rootKids);
      const rest = mine.filter((id) => !pos.has(id));
      if (rest.length) {
        rest.sort((a, b) => depth.get(a)! - depth.get(b)! || compareImpactKids(doc.nodes[a]!, doc.nodes[b]!));
        pos = outlineLayout(
          r,
          rootKids,
          rest.map((id) => [id, depth.get(id)!] as const),
        );
      }
      const rn = doc.nodes[r];
      for (const [id, p] of pos) if (shownSet.has(id) && rn) overlay.set(id, { x: rn.x + p.x, y: rn.y + p.y });
    });
  }

  const hiddenBy = (id: ID) => {
    const n = doc.nodes[id];
    if (!n) return { focus: false, scenario: false, collapse: false };
    const scenario = hideScen && (!inScenario(n.scenarioIds, sid) || unreached.has(id));
    const fc = focus && !scope.has(id) && !inProj(n.projectIds);
    return { focus: fc, scenario, collapse: scope.has(id) && col.hidden.has(id) };
  };

  const collapseBlockers = (id: ID) => {
    const openN = new Set<ID>();
    const openE = new Set<ID>();
    const openV = new Set<ID>();
    if (!scope.has(id) || !col.hidden.has(id)) return { nodes: [], edges: [], open: [] };
    const closed = (u: ID): boolean => collapsedOf(u) && !(owner.has(u) ? openV : openN).has(u);
    let sim: DocData = doc;
    let c = col;
    for (let round = 0; round < 8 && c.hidden.has(id); round++) {
      const region = new Set<ID>([id]);
      const stack: ID[] = [id];
      while (stack.length) {
        const v = stack.pop()!;
        for (const eid of idx.inc.get(v) ?? []) {
          const e = sim.edges[eid];
          if (!e || e.source === e.target || !scope.has(e.source) || !edgeOk(e)) continue;
          if (closed(e.source) && stops(e)) (owner.has(e.source) ? openV : openN).add(e.source);
          if (e.collapsed) openE.add(eid);
          if (c.hidden.has(e.source) && !region.has(e.source)) {
            region.add(e.source);
            stack.push(e.source);
          }
        }
      }
      if (openE.size) {
        sim = { ...sim, edges: { ...sim.edges } };
        for (const e of openE) sim.edges[e] = { ...sim.edges[e]!, collapsed: false };
      }
      c = computeCollapse(sim, idx, scope, edgeOk, closed, { stops, roots: forced });
    }
    return { nodes: [...openN], edges: [...openE], open: [...openV] };
  };

  return {
    index: idx,
    nodes,
    edges,
    drawNodes: draw.concat(drawTop),
    drawEdges: edgesNormal.concat(edgesTop),
    stubEdges: stubs,
    hiddenCount,
    pathActive,
    searchActive,
    searchAll,
    overlay,
    roots,
    owner,
    hiddenBy,
    collapseBlockers,
    opens,
  };
}
