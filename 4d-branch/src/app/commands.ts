// 操作（作成・接続・分岐・合流・削除…）。キャンバス・詳細・キーボード・右クリックはすべてここを呼ぶ

import { NODE_TYPES, PROJECT_COLORS, RELATIONS, SCENARIO_COLORS, STATUSES } from "../model/constants";
import { newId } from "../model/ids";
import { childSpot, findFreeSpot, mergeSpot } from "../model/layout";
import { makeCondition, makeEdge, makeNode, makeProject, makeScenario, normalizeTag } from "../model/schema";
import type { GEdge, GNode, ID, NodeStatus, NodeType, Relation } from "../model/types";
import type { Store } from "../store/store";
import type { UiState } from "./uiState";
import type { ViewModel } from "./viewModel";

export interface CommandHooks {
  toast(text: string, opts?: { action?: { label: string; run: () => void }; tone?: "info" | "warn" | "error"; ms?: number }): void;
  viewCenter(): { x: number; y: number };
  startEdit(id: ID): void;
  reveal(id: ID): void;
  confirm(opts: { title: string; body: string; ok: string; danger?: boolean }): Promise<boolean>;
}

const CHILD_TYPE: Record<NodeType, NodeType> = { goal: "action", action: "result", branch: "action", result: "action" };

export class Commands {
  constructor(
    private readonly store: Store,
    private readonly ui: UiState,
    private readonly vm: ViewModel,
    private readonly hooks: CommandHooks,
  ) {}

  private get doc() {
    return this.store.doc;
  }

  /** 新しいノードの所属: 絞り込み中のプロジェクト → 親の所属 → なし */
  private defaultProjects(parents: GNode[]): ID[] {
    const f = this.ui.prefs.projectFilter.filter((p) => this.doc.projects[p]);
    if (f.length) return f;
    const out: ID[] = [];
    for (const p of parents) for (const id of p.projectIds) if (!out.includes(id)) out.push(id);
    return out;
  }

  private relationFrom(src: GNode | undefined): Relation {
    return src?.type === "branch" ? "condition" : "leads";
  }

  // ------------------------------------------------------------ ノード

  createNode(type: NodeType, at?: { x: number; y: number }, opts: { from?: ID[]; to?: ID[]; title?: string; edit?: boolean; exact?: boolean; projectIds?: ID[] } = {}): ID | null {
    const base = at ?? this.hooks.viewCenter();
    const spot = opts.exact ? base : findFreeSpot(this.doc, Math.round(base.x), Math.round(base.y));
    const parents = (opts.from ?? []).map((id) => this.doc.nodes[id]).filter((n): n is GNode => !!n);
    const node = makeNode({ type, title: opts.title ?? "", x: Math.round(spot.x), y: Math.round(spot.y), projectIds: opts.projectIds ?? this.defaultProjects(parents) });
    const ok = this.store.transact(`${NODE_TYPES[type].label}を作成`, (tx) => {
      tx.addNode(node);
      for (const p of parents) {
        if (p.collapsed) tx.updateNode(p.id, { collapsed: false });
        tx.addEdge(makeEdge({ source: p.id, target: node.id, relation: this.relationFrom(p) }));
      }
      for (const t of opts.to ?? []) if (tx.doc.nodes[t]) tx.addEdge(makeEdge({ source: node.id, target: t, relation: "leads" }));
    });
    if (!ok) return null;
    this.ui.select([node.id]);
    if (this.ui.prefs.lastType !== type) this.ui.setPrefs({ lastType: type });
    this.hooks.reveal(node.id);
    if (opts.edit) this.hooks.startEdit(node.id);
    return node.id;
  }

  /** 子ノード（分岐の先）を足す */
  addChild(parentId: ID, type?: NodeType): ID | null {
    const p = this.doc.nodes[parentId];
    if (!p) return null;
    this.vm.ensure();
    const spot = childSpot(this.doc, this.vm.index, parentId);
    return this.createNode(type ?? CHILD_TYPE[p.type], spot, { from: [parentId], edit: true, exact: true });
  }

  /** 1 つのノードから分岐を 2 つまとめて作る（分岐ノードの「分岐を作る」） */
  addBranches(parentId: ID, count = 2): ID[] {
    const p = this.doc.nodes[parentId];
    if (!p) return [];
    this.vm.ensure();
    const created: GNode[] = [];
    const extra: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < count; i++) {
      const spot = childSpot(this.doc, this.vm.index, parentId, extra);
      extra.push(spot);
      created.push(makeNode({ type: "action", title: "", x: Math.round(spot.x), y: Math.round(spot.y), projectIds: this.defaultProjects([p]) }));
    }
    const ok = this.store.transact("分岐を作成", (tx) => {
      if (p.collapsed) tx.updateNode(p.id, { collapsed: false });
      created.forEach((n, i) => {
        tx.addNode(n);
        tx.addEdge(makeEdge({ source: p.id, target: n.id, relation: "condition", condition: i === 0 ? "条件を満たしたら" : "満たさなければ" }));
      });
    });
    if (!ok) return [];
    this.ui.select(created.map((n) => n.id));
    this.hooks.reveal(created[0]!.id);
    return created.map((n) => n.id);
  }

  /** 選んだ複数のノードを 1 つへ合流させる（新しいノードを作る） */
  mergeInto(ids: ID[], type: NodeType = "result"): ID | null {
    const nodes = ids.map((id) => this.doc.nodes[id]).filter((n): n is GNode => !!n);
    if (nodes.length < 2) return null;
    const spot = mergeSpot(this.doc, ids);
    const f = this.ui.prefs.projectFilter.filter((p) => this.doc.projects[p]);
    const projectIds = f.length ? f : [...new Set(nodes.flatMap((n) => n.projectIds))];
    return this.createNode(type, spot, { from: ids, edit: true, exact: true, projectIds });
  }

  updateNode(id: ID, patch: Partial<GNode>, opts: { label?: string; coalesce?: string } = {}): void {
    this.store.transact(opts.label ?? "ノードを編集", (tx) => tx.updateNode(id, patch), { coalesce: opts.coalesce });
  }

  moveNodes(ids: Iterable<ID>, dx: number, dy: number, label = "移動"): void {
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    this.store.transact(label, (tx) => {
      for (const id of ids) {
        const n = tx.doc.nodes[id];
        if (n) tx.updateNode(id, { x: Math.round(n.x + dx), y: Math.round(n.y + dy) });
      }
    });
  }

  setType(ids: ID[], type: NodeType): void {
    if (!ids.length) return;
    this.store.transact(`種類を「${NODE_TYPES[type].label}」に`, (tx) => ids.forEach((id) => tx.updateNode(id, { type })));
  }

  setStatus(ids: ID[], status: NodeStatus): void {
    if (!ids.length) return;
    this.store.transact(`状態を「${STATUSES[status].label}」に`, (tx) => ids.forEach((id) => tx.updateNode(id, { status })));
  }

  toggleCollapse(ids: ID[]): void {
    const nodes = ids.map((id) => this.doc.nodes[id]).filter((n): n is GNode => !!n);
    if (!nodes.length) return;
    const collapse = nodes.some((n) => !n.collapsed);
    this.store.transact(collapse ? "折りたたむ" : "展開する", (tx) => nodes.forEach((n) => tx.updateNode(n.id, { collapsed: collapse })));
    if (collapse) this.ui.select(nodes.map((n) => n.id));
  }

  /**
   * 隠れているノードを出す（検索で選んだときなど）。
   * プロジェクトに絞る・シナリオで隠すで隠れていれば「薄くする」表示に切り替え、折りたたみの中なら上流を開く（元に戻せる）
   */
  revealNode(id: ID): void {
    if (!this.doc.nodes[id] || !this.vm.node(id).hidden) return;
    const why = this.vm.hiddenBy(id);
    const patch: { projectMode?: "dim"; scenarioMode?: "dim" } = {};
    if (why.focus) patch.projectMode = "dim";
    if (why.scenario) patch.scenarioMode = "dim";
    if (patch.projectMode || patch.scenarioMode) {
      this.ui.setPrefs(patch);
      const what = [patch.projectMode ? "プロジェクトの絞り込み" : "", patch.scenarioMode ? "シナリオ" : ""].filter(Boolean).join("と");
      this.hooks.toast(`隠れていたノードを出すため、${what}の表示を「薄くする」にしました`, { tone: "info" });
    }
    if (!this.vm.node(id).hidden) return;
    const open = this.vm.collapseBlockers(id);
    if (!open.nodes.length && !open.edges.length) return;
    this.store.transact("隠れていたノードを表示", (tx) => {
      for (const n of open.nodes) tx.updateNode(n, { collapsed: false });
      for (const e of open.edges) tx.updateEdge(e, { collapsed: false });
    });
  }

  /** すべての折りたたみを開く */
  expandAll(): void {
    const ns = Object.values(this.doc.nodes).filter((n) => n.collapsed);
    const es = Object.values(this.doc.edges).filter((e) => e.collapsed);
    if (!ns.length && !es.length) return;
    this.store.transact("すべて展開", (tx) => {
      ns.forEach((n) => tx.updateNode(n.id, { collapsed: false }));
      es.forEach((e) => tx.updateEdge(e.id, { collapsed: false }));
    });
  }

  deleteNodes(ids: ID[], edges: ID[] = []): void {
    const ns = ids.filter((id) => this.doc.nodes[id]);
    const es = edges.filter((id) => this.doc.edges[id]);
    if (!ns.length && !es.length) return;
    const label = ns.length ? (ns.length === 1 ? `「${this.doc.nodes[ns[0]!]!.title || "無題"}」を削除` : `${ns.length} 件のノードを削除`) : es.length === 1 ? "接続を削除" : `${es.length} 本の接続を削除`;
    const ok = this.store.transact(label, (tx) => {
      es.forEach((id) => tx.deleteEdge(id));
      ns.forEach((id) => tx.deleteNode(id));
    });
    if (!ok) return;
    this.ui.clearSelection();
    this.hooks.toast(`${label}しました`, { action: { label: "元に戻す", run: () => this.undo() } });
  }

  deleteSelection(): void {
    this.deleteNodes([...this.ui.selection.nodes], [...this.ui.selection.edges]);
  }

  /** 選んだノード（とその間の接続）を複製 */
  duplicate(ids: ID[]): ID[] {
    const nodes = ids.map((id) => this.doc.nodes[id]).filter((n): n is GNode => !!n);
    if (!nodes.length) return [];
    const map = new Map<ID, ID>();
    const copies = nodes.map((n) => {
      const id = newId("n");
      map.set(n.id, id);
      return makeNode({ ...n, id, x: n.x + 40, y: n.y + 40, conditions: n.conditions.map((c) => ({ ...c, id: newId("c") })), createdAt: undefined, updatedAt: undefined, collapsed: false, meta: { ...n.meta } });
    });
    const inner = Object.values(this.doc.edges).filter((e) => map.has(e.source) && map.has(e.target));
    const ok = this.store.transact(nodes.length === 1 ? "複製" : `${nodes.length} 件を複製`, (tx) => {
      copies.forEach((c) => tx.addNode(c));
      inner.forEach((e) => tx.addEdge(makeEdge({ ...e, id: newId("e"), source: map.get(e.source)!, target: map.get(e.target)!, createdAt: undefined, updatedAt: undefined })));
    });
    if (!ok) return [];
    this.ui.select(copies.map((c) => c.id));
    return copies.map((c) => c.id);
  }

  /** 横（同じ高さ）・縦（同じ横位置）にそろえる */
  align(ids: ID[], axis: "h" | "v"): void {
    const nodes = ids.map((id) => this.doc.nodes[id]).filter((n): n is GNode => !!n);
    if (nodes.length < 2) return;
    if (axis === "h") {
      const y = Math.round(nodes.reduce((s, n) => s + n.y, 0) / nodes.length);
      const sorted = [...nodes].sort((a, b) => a.x - b.x);
      this.store.transact("横にそろえる", (tx) => {
        let x = sorted[0]!.x;
        sorted.forEach((n, i) => {
          if (i > 0) x = Math.max(n.x, x + 280);
          tx.updateNode(n.id, { x: Math.round(x), y });
        });
      });
    } else {
      const x = Math.round(nodes.reduce((s, n) => s + n.x, 0) / nodes.length);
      const sorted = [...nodes].sort((a, b) => a.y - b.y);
      this.store.transact("縦にそろえる", (tx) => {
        let y = sorted[0]!.y;
        sorted.forEach((n, i) => {
          if (i > 0) y = Math.max(n.y, y + 128);
          tx.updateNode(n.id, { x, y: Math.round(y) });
        });
      });
    }
  }

  // ------------------------------------------------------------ 接続

  /** sources のそれぞれから target へつなぐ（同じ向きがすでにあれば飛ばす） */
  connect(sources: ID[], target: ID, relation?: Relation): ID[] {
    const created: ID[] = [];
    this.store.transact(sources.length > 1 ? `${sources.length} 本を接続` : "接続", (tx) => {
      for (const s of sources) {
        if (s === target) continue;
        const e = tx.addEdge(makeEdge({ source: s, target, relation: relation ?? this.relationFrom(tx.doc.nodes[s]) }));
        if (e) created.push(e.id);
      }
    });
    if (created.length === 0) this.hooks.toast("すでにつながっています");
    else if (created.length === 1) this.ui.select([], created);
    return created;
  }

  updateEdge(id: ID, patch: Partial<GEdge>, opts: { label?: string; coalesce?: string } = {}): void {
    this.store.transact(opts.label ?? "接続を編集", (tx) => tx.updateEdge(id, patch), { coalesce: opts.coalesce });
  }

  setRelation(ids: ID[], relation: Relation): void {
    this.store.transact(`関係を「${RELATIONS[relation].label}」に`, (tx) => ids.forEach((id) => tx.updateEdge(id, { relation })));
  }

  reverseEdge(id: ID): void {
    const e = this.doc.edges[id];
    if (!e) return;
    const reversed = Object.values(this.doc.edges).some((x) => x.source === e.target && x.target === e.source);
    if (reversed) {
      this.hooks.toast("逆向きの接続がすでにあるため、向きを反転できません");
      return;
    }
    this.updateEdge(id, { source: e.target, target: e.source }, { label: "向きを反転" });
  }

  toggleEdgeCollapse(id: ID): void {
    const e = this.doc.edges[id];
    if (!e) return;
    this.updateEdge(id, { collapsed: !e.collapsed }, { label: e.collapsed ? "接続の先を展開" : "接続の先を折りたたむ" });
  }

  // ------------------------------------------------------------ プロジェクト

  addProject(name = "新しいプロジェクト"): ID | null {
    const used = new Set(Object.values(this.doc.projects).map((p) => p.color));
    const color = PROJECT_COLORS.find((c) => !used.has(c)) ?? PROJECT_COLORS[Object.keys(this.doc.projects).length % PROJECT_COLORS.length]!;
    const p = makeProject({ name, color });
    const ok = this.store.transact("プロジェクトを追加", (tx) => tx.addProject(p));
    return ok ? p.id : null;
  }

  updateProject(id: ID, patch: { name?: string; color?: string; description?: string }, coalesce?: string): void {
    this.store.transact("プロジェクトを編集", (tx) => tx.updateProject(id, patch), { coalesce });
  }

  async deleteProject(id: ID): Promise<void> {
    const p = this.doc.projects[id];
    if (!p) return;
    const count = Object.values(this.doc.nodes).filter((n) => n.projectIds.includes(id)).length;
    const ok = await this.hooks.confirm({
      title: `プロジェクト「${p.name}」を削除`,
      body: `ノード ${count} 件は削除されず、このプロジェクトへの所属だけが外れます。あとから「元に戻す」で戻せます。`,
      ok: "削除する",
      danger: true,
    });
    if (!ok) return;
    if (this.store.transact(`プロジェクト「${p.name}」を削除`, (tx) => tx.deleteProject(id))) {
      if (this.ui.prefs.projectFilter.includes(id)) this.ui.setPrefs({ projectFilter: this.ui.prefs.projectFilter.filter((x) => x !== id) });
      this.hooks.toast(`プロジェクト「${p.name}」を削除しました`, { action: { label: "元に戻す", run: () => this.undo() } });
    }
  }

  moveProject(id: ID, delta: number): void {
    const order = [...this.doc.projectOrder];
    const i = order.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= order.length) return;
    order.splice(i, 1);
    order.splice(j, 0, id);
    this.store.transact("並べ替え", (tx) => tx.setOrder("projectOrder", order));
  }

  /** ノードの所属をつけ外し（全部ついていれば外す） */
  toggleProjectOf(ids: ID[], pid: ID): void {
    const nodes = ids.map((id) => this.doc.nodes[id]).filter((n): n is GNode => !!n);
    if (!nodes.length) return;
    const all = nodes.every((n) => n.projectIds.includes(pid));
    const name = this.doc.projects[pid]?.name ?? "";
    this.store.transact(all ? `「${name}」から外す` : `「${name}」に追加`, (tx) => {
      for (const n of nodes) {
        const next = all ? n.projectIds.filter((p) => p !== pid) : n.projectIds.includes(pid) ? n.projectIds : [...n.projectIds, pid];
        tx.updateNode(n.id, { projectIds: next });
      }
    });
  }

  // ------------------------------------------------------------ シナリオ

  addScenario(name = "新しいシナリオ"): ID | null {
    const used = new Set(Object.values(this.doc.scenarios).map((s) => s.color));
    const color = SCENARIO_COLORS.find((c) => !used.has(c)) ?? SCENARIO_COLORS[0]!;
    const s = makeScenario({ name, color });
    const ok = this.store.transact("シナリオを追加", (tx) => tx.addScenario(s));
    return ok ? s.id : null;
  }

  updateScenario(id: ID, patch: { name?: string; color?: string; description?: string }, coalesce?: string): void {
    this.store.transact("シナリオを編集", (tx) => tx.updateScenario(id, patch), { coalesce });
  }

  async deleteScenario(id: ID): Promise<void> {
    const s = this.doc.scenarios[id];
    if (!s) return;
    const ok = await this.hooks.confirm({
      title: `シナリオ「${s.name}」を削除`,
      body: "ノードと接続は削除されません。このシナリオだけに入っていた要素は「全シナリオ共通」になります。あとから「元に戻す」で戻せます。",
      ok: "削除する",
      danger: true,
    });
    if (!ok) return;
    if (this.store.transact(`シナリオ「${s.name}」を削除`, (tx) => tx.deleteScenario(id))) {
      if (this.ui.prefs.scenarioId === id) this.ui.setPrefs({ scenarioId: null });
      this.hooks.toast(`シナリオ「${s.name}」を削除しました`, { action: { label: "元に戻す", run: () => this.undo() } });
    }
  }

  moveScenario(id: ID, delta: number): void {
    const order = [...this.doc.scenarioOrder];
    const i = order.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= order.length) return;
    order.splice(i, 1);
    order.splice(j, 0, id);
    this.store.transact("並べ替え", (tx) => tx.setOrder("scenarioOrder", order));
  }

  /** ノード・接続のシナリオ: sid を付け外し。null なら「全シナリオ共通」に戻す */
  setScenarioOf(target: { nodes?: ID[]; edges?: ID[] }, sid: ID | null): void {
    this.store.transact(sid ? "シナリオを変更" : "全シナリオ共通に", (tx) => {
      for (const id of target.nodes ?? []) {
        const n = tx.doc.nodes[id];
        if (!n) continue;
        const next = sid === null ? [] : n.scenarioIds.includes(sid) ? n.scenarioIds.filter((s) => s !== sid) : [...n.scenarioIds, sid];
        tx.updateNode(id, { scenarioIds: next });
      }
      for (const id of target.edges ?? []) {
        const e = tx.doc.edges[id];
        if (!e) continue;
        const next = sid === null ? [] : e.scenarioIds.includes(sid) ? e.scenarioIds.filter((s) => s !== sid) : [...e.scenarioIds, sid];
        tx.updateEdge(id, { scenarioIds: next });
      }
    });
  }

  // ------------------------------------------------------------ タグ・条件

  addTag(ids: ID[], raw: string): void {
    const tag = normalizeTag(raw);
    if (!tag) return;
    this.store.transact(`タグ「${tag}」を追加`, (tx) => {
      for (const id of ids) {
        const n = tx.doc.nodes[id];
        if (n && !n.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) tx.updateNode(id, { tags: [...n.tags, tag] });
      }
    });
  }

  removeTag(id: ID, tag: string): void {
    const n = this.doc.nodes[id];
    if (!n) return;
    this.updateNode(id, { tags: n.tags.filter((t) => t !== tag) }, { label: `タグ「${tag}」を外す` });
  }

  addCondition(id: ID, text: string): void {
    const n = this.doc.nodes[id];
    if (!n || !text.trim()) return;
    this.updateNode(id, { conditions: [...n.conditions, makeCondition(text.trim())] }, { label: "条件を追加" });
  }

  updateCondition(id: ID, cid: ID, patch: { text?: string; met?: boolean }, coalesce?: string): void {
    const n = this.doc.nodes[id];
    if (!n) return;
    this.updateNode(id, { conditions: n.conditions.map((c) => (c.id === cid ? { ...c, ...patch } : c)) }, { label: patch.met !== undefined ? "条件を切り替え" : "条件を編集", coalesce });
  }

  removeCondition(id: ID, cid: ID): void {
    const n = this.doc.nodes[id];
    if (!n) return;
    this.updateNode(id, { conditions: n.conditions.filter((c) => c.id !== cid) }, { label: "条件を削除" });
  }

  // ------------------------------------------------------------ その他

  selectAll(): void {
    this.vm.ensure();
    this.ui.select(this.vm.drawNodes);
  }

  undo(): void {
    if (!this.store.history.canUndo) return;
    this.store.undo();
    this.afterHistory();
  }

  redo(): void {
    if (!this.store.history.canRedo) return;
    this.store.redo();
    this.afterHistory();
  }

  private afterHistory(): void {
    this.ui.pruneSelection((kind, id) => (kind === "node" ? !!this.doc.nodes[id] : !!this.doc.edges[id]));
  }
}
