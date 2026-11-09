// 見え方の計算: プロジェクトの絞り込み・シナリオ・時点・検索・折りたたみ・経路の強調 → ノードと接続ごとの「隠す・薄さ」
// 変更のたびに作り直す（O(ノード + 接続)）。位置だけの変更では作り直さない

import { buildIndex, inScenario, type GraphIndex } from "../model/graph";
import { isEmptyQuery, parseQuery, searchNodes } from "../model/search";
import type { GEdge, ID } from "../model/types";
import { computeCollapse, computePaths, computeUnreached } from "../model/visibility";
import type { Store } from "../store/store";
import type { UiState } from "./uiState";

export interface NodeVis {
  hidden: boolean;
  alpha: number;
  /** 検索に当たった */
  match: boolean;
  /** 選択の経路の上 */
  path: boolean;
  /** 絞り込み中の隣（ほかのプロジェクト） */
  ghost: boolean;
  /** 時点より後の期限 */
  future: boolean;
  /** 選んだシナリオに入らない（推定を含む） */
  offScenario: boolean;
  /** 折りたたみで隠れた件数（折りたたんだノードだけ） */
  collapsedCount: number;
  inProject: boolean;
}

export interface EdgeVis {
  hidden: boolean;
  alpha: number;
  path: boolean;
  cross: boolean;
  offScenario: boolean;
}

const HIDDEN_NODE: NodeVis = { hidden: true, alpha: 0, match: false, path: false, ghost: false, future: false, offScenario: false, collapsedCount: 0, inProject: false };

export class ViewModel {
  index!: GraphIndex;
  readonly nodes = new Map<ID, NodeVis>();
  readonly edges = new Map<ID, EdgeVis>();
  /** 描く順（隠れていないもの。選択中は最後＝上） */
  drawNodes: ID[] = [];
  drawEdges: ID[] = [];
  /** 折りたたんだ接続（線の付け根だけ描く） */
  stubEdges: Array<{ id: ID; count: number }> = [];
  searchHits: Array<{ id: ID; score: number }> = [];
  searchActive = false;
  pathActive = false;
  hiddenCount = 0;
  version = 0;
  private dirtyIndex = true;
  private dirtyVis = true;

  constructor(
    private readonly store: Store,
    private readonly ui: UiState,
  ) {
    store.on("change", (info) => {
      if (!info.positionsOnly) {
        this.dirtyIndex = true;
        this.dirtyVis = true;
      }
    });
    ui.on("visual", () => {
      this.dirtyVis = true;
    });
  }

  invalidate(): void {
    this.dirtyIndex = true;
    this.dirtyVis = true;
  }

  ensure(): void {
    if (this.dirtyIndex) {
      this.index = buildIndex(this.store.doc);
      this.dirtyIndex = false;
      this.dirtyVis = true;
    }
    if (this.dirtyVis) {
      this.compute();
      this.dirtyVis = false;
      this.version++;
    }
  }

  node(id: ID): NodeVis {
    this.ensure();
    return this.nodes.get(id) ?? HIDDEN_NODE;
  }

  private compute(): void {
    const doc = this.store.doc;
    const prefs = this.ui.prefs;
    const idx = this.index;
    const filter = prefs.projectFilter.filter((p) => doc.projects[p]);
    const hasFilter = filter.length > 0;
    const fset = new Set(filter);
    const focus = hasFilter && prefs.projectMode === "focus";
    const sid = prefs.scenarioId && doc.scenarios[prefs.scenarioId] ? prefs.scenarioId : null;
    const hideScen = sid !== null && prefs.scenarioMode === "hide";
    const cursor = prefs.timeCursor;
    const sel = this.ui.selection;

    const inProj = (pids: ID[]) => !hasFilter || pids.some((p) => fset.has(p));
    const edgeInScen = (e: GEdge) => inScenario(e.scenarioIds, sid);

    // 1) 範囲（シナリオで隠す・プロジェクトに絞る）
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

    // 2) 折りたたみ・シナリオの推定
    const col = computeCollapse(doc, idx, scope, edgeOk);
    const unreached = sid ? computeUnreached(doc, idx, scope, edgeInScen) : new Set<ID>();

    // 3) 検索
    const q = parseQuery(this.ui.search);
    this.searchActive = !isEmptyQuery(q);
    this.searchHits = this.searchActive ? searchNodes(doc, q) : [];
    const hitSet = new Set(this.searchHits.map((h) => h.id));

    // 4) 経路
    const selected = [...sel.nodes].filter((id) => scope.has(id) && !col.hidden.has(id));
    this.pathActive = prefs.pathHighlight && selected.length > 0;
    const paths = this.pathActive ? computePaths(doc, idx, selected, (e) => edgeOk(e) && (!sid || edgeInScen(e)) && scope.has(e.source) && scope.has(e.target) && !col.hidden.has(e.source) && !col.hidden.has(e.target)) : null;

    // 5) ノード
    this.nodes.clear();
    const draw: ID[] = [];
    const drawTop: ID[] = [];
    let hiddenCount = 0;
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
      if (this.searchActive && !match) alpha = Math.min(alpha, 0.14);
      const path = !!paths?.nodes.has(id);
      if (this.pathActive && !path) alpha = Math.min(alpha, 0.3);
      if (hidden) hiddenCount++;
      const collapsedCount = n.collapsed ? (col.counts.get(id) ?? 0) : 0;
      this.nodes.set(id, { hidden, alpha, match, path, ghost: isGhost, future, offScenario, collapsedCount, inProject });
      if (!hidden) (sel.nodes.has(id) ? drawTop : draw).push(id);
    }
    this.drawNodes = draw.concat(drawTop);
    this.hiddenCount = hiddenCount;

    // 6) 接続
    this.edges.clear();
    const edgesNormal: ID[] = [];
    const edgesTop: ID[] = [];
    const stubs: Array<{ id: ID; count: number }> = [];
    for (const id in doc.edges) {
      const e = doc.edges[id]!;
      const a = this.nodes.get(e.source);
      const b = this.nodes.get(e.target);
      const src = doc.nodes[e.source];
      const offScenario = sid !== null && !edgeInScen(e);
      const cross = idx.cross.has(id);
      let hidden = !a || !b || a.hidden || b.hidden || (hideScen && offScenario) || !!src?.collapsed || e.collapsed;
      const incident = sel.nodes.has(e.source) || sel.nodes.has(e.target) || sel.edges.has(id);
      if (prefs.edgeMode === "selection" && !incident) hidden = true;
      if (prefs.edgeMode === "cross" && !cross && !incident) hidden = true;
      let alpha = Math.min(a?.alpha ?? 0, b?.alpha ?? 0);
      if (offScenario) alpha = Math.min(alpha, 0.16);
      const path = !!paths?.edges.has(id);
      if (this.pathActive && !path) alpha = Math.min(alpha, 0.2);
      this.edges.set(id, { hidden, alpha, path, cross, offScenario });
      if (!hidden) (path || sel.edges.has(id) ? edgesTop : edgesNormal).push(id);
      if (e.collapsed && a && !a.hidden && !src?.collapsed && !(hideScen && offScenario)) stubs.push({ id, count: col.counts.get(id) ?? 0 });
    }
    this.drawEdges = edgesNormal.concat(edgesTop);
    this.stubEdges = stubs;
  }

  /** 表示中のノードを囲む範囲（全体を表示に使う） */
  bounds(ids?: Iterable<ID>): { minX: number; minY: number; maxX: number; maxY: number } | null {
    this.ensure();
    const doc = this.store.doc;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const id of ids ?? this.drawNodes) {
      const n = doc.nodes[id];
      if (!n) continue;
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    }
    if (minX === Infinity) return null;
    return { minX, minY, maxX, maxY };
  }
}
