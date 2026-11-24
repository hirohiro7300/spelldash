// 操作（作成・接続・分岐・合流・削除…）。キャンバス・詳細・キーボード・右クリックはすべてここを呼ぶ

import { NODE_TYPES, PROJECT_COLORS, RELATIONS, SCENARIO_COLORS, STATUSES } from "../model/constants";
import { DEEP_OPEN_CAP, deepHorizons, horizonOpen } from "../model/deepOpen";
import { flowOuts, isFlowEdge, isImpactRoot } from "../model/forks";
import { newId } from "../model/ids";
import { childSpot, findFreeSpot, mergeSpot } from "../model/layout";
import { makeCondition, makeEdge, makeNode, makeProject, makeScenario, normalizeTag } from "../model/schema";
import type { GEdge, GNode, ID, Meta, NodeStatus, NodeType, Relation } from "../model/types";
import type { Store } from "../store/store";
import type { UiState } from "./uiState";
import type { ViewModel } from "./viewModel";

export interface CommandHooks {
  toast(text: string, opts?: { action?: { label: string; run: () => void }; tone?: "info" | "warn" | "error"; ms?: number }): void;
  viewCenter(): { x: number; y: number };
  startEdit(id: ID): void;
  reveal(id: ID): void;
  confirm(opts: { title: string; body: string; ok: string; danger?: boolean }): Promise<boolean>;
  /** ⌘Z でまとめて開く・たたむを戻した（お知らせ） */
  bulkUndone?(): void;
}

const CHILD_TYPE: Record<NodeType, NodeType> = { goal: "action", action: "result", branch: "action", result: "action" };

/**
 * 複製の写しに持たせない meta: 未来の道筋の入口・版・鍵・今のまま（base）・作ったときの文（t0・b0）・入口の手の種類の名前（fams）と、
 * 3 か月ごとの地図の入口だけの印（地図の年月 anchor・文の型の版 textVersion・「3 年やらない」の見積もり never。src/demo/quarterDoc.ts）、
 * 線の作ったときの見込み・条件（p0・c0）。写しが 2 つ目の入口になったり、版の差し替えで元のカードと取り違えられたりしないように。
 * 入口の資産のゴールの前提（goal: 今の資産など）も写さない（入口だけが持つ。ふつうのカードに金額を散らさない）
 */
const COPY_DROP_NODE = ["forecastRoot", "impact", "futureVersion", "futureRelease", "key", "base", "t0", "b0", "k0", "fams", "anchor", "textVersion", "never", "goal"];
const COPY_DROP_EDGE = ["p0", "c0"];

function without(meta: Meta, keys: string[]): Meta {
  const out = { ...meta };
  for (const k of keys) delete out[k];
  return out;
}

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
    // 空いている所は、3 年の分かれ道の重ねる位置（見えているカード）も避けて探す
    const spot = opts.exact ? base : findFreeSpot(this.doc, Math.round(base.x), Math.round(base.y), { extra: this.vm.overlayPoints(), skip: (id) => this.vm.inImpact(id) });
    const parents = (opts.from ?? []).map((id) => this.doc.nodes[id]).filter((n): n is GNode => !!n);
    const node = makeNode({ type, title: opts.title ?? "", x: Math.round(spot.x), y: Math.round(spot.y), projectIds: opts.projectIds ?? this.defaultProjects(parents) });
    // 3 年の分かれ道の親は、見え方で開く（文書の collapsed は使わない）
    const viewParents = parents.filter((p) => this.vm.inImpact(p.id)).map((p) => p.id);
    const ok = this.store.transact(`${NODE_TYPES[type].label}を作成`, (tx) => {
      tx.addNode(node);
      for (const p of parents) {
        if (p.collapsed && !viewParents.includes(p.id)) tx.updateNode(p.id, { collapsed: false });
        tx.addEdge(makeEdge({ source: p.id, target: node.id, relation: this.relationFrom(p) }));
      }
      for (const t of opts.to ?? []) if (tx.doc.nodes[t]) tx.addEdge(makeEdge({ source: node.id, target: t, relation: "leads" }));
    });
    if (!ok) return null;
    if (viewParents.length) this.vm.setImpactOpen(viewParents);
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
    const viewParent = this.vm.inImpact(p.id);
    const ok = this.store.transact("分岐を作成", (tx) => {
      if (p.collapsed && !viewParent) tx.updateNode(p.id, { collapsed: false });
      created.forEach((n, i) => {
        tx.addNode(n);
        tx.addEdge(makeEdge({ source: p.id, target: n.id, relation: "condition", condition: i === 0 ? "条件を満たしたら" : "満たさなければ" }));
      });
    });
    if (!ok) return [];
    if (viewParent) this.vm.setImpactOpen([p.id]);
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

  /** 3 年の分かれ道のカードを除く（自動で並ぶので動かさない）。除いた物があれば一度だけ知らせる */
  private movable(ids: Iterable<ID>): ID[] {
    const all = [...ids];
    const ok = all.filter((id) => !this.vm.inImpact(id));
    if (ok.length < all.length) this.noticeFixedLayout();
    return ok;
  }

  moveNodes(ids: Iterable<ID>, dx: number, dy: number, label = "移動"): void {
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    const list = this.movable(ids);
    if (!list.length) return;
    this.store.transact(label, (tx) => {
      for (const id of list) {
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

  /**
   * 折りたたむ・展開する。3 年の分かれ道のノードは見え方だけを変える（文書・履歴・保存・同期は変えない。端末ごと）。
   * それ以外は今までどおり文書の collapsed（元に戻せる）
   */
  toggleCollapse(ids: ID[]): void {
    const nodes = ids.filter((id) => this.doc.nodes[id]);
    const { view, docNodes } = this.collapseTargets(nodes);
    if (!view.length && !docNodes.length) return;
    const collapse = !this.collapsedAll(nodes);
    if (view.length) {
      if (collapse) this.vm.setImpactOpen([], view);
      else this.vm.setImpactOpen(view, [], { reveal: true });
    }
    if (docNodes.length) this.store.transact(collapse ? "折りたたむ" : "展開する", (tx) => docNodes.forEach((id) => tx.updateNode(id, { collapsed: collapse })));
    if (collapse) this.ui.select(nodes);
  }

  /**
   * C・右クリックのメニューで開閉する物。3 年の分かれ道は開く・閉じる物（同じ範囲の子）のあるカードだけ（見え方）。
   * 先の無いカード（行き先）や、相乗効果などの線しか出ていないカードは数えない（混ぜて選んでも、閉じたカードの開閉の向きを変えない）。
   * それ以外のノードは今までどおりすべて（文書の collapsed）
   */
  private collapseTargets(ids: ID[]): { view: ID[]; docNodes: ID[] } {
    const view: ID[] = [];
    const docNodes: ID[] = [];
    for (const id of ids) {
      if (!this.doc.nodes[id]) continue;
      if (!this.vm.inImpact(id)) docNodes.push(id);
      else if (this.vm.canCollapse(id)) view.push(id);
    }
    return { view, docNodes };
  }

  /** C・メニューで開閉できる物があるか（無ければメニューの「この先を折りたたむ」は押せない） */
  canToggleCollapse(ids: ID[]): boolean {
    const { view, docNodes } = this.collapseTargets(ids);
    return view.length > 0 || docNodes.length > 0;
  }

  /**
   * 開閉する物がすべて折りたたんであるか（C とメニューの向き。true なら「展開する」）。3 年の分かれ道は見え方の開閉。
   * 開閉する物が無ければ false
   */
  collapsedAll(ids: ID[]): boolean {
    const { view, docNodes } = this.collapseTargets(ids);
    const all = [...view, ...docNodes];
    return all.length > 0 && all.every((id) => this.vm.isCollapsed(id));
  }

  /** 折りたたんでいるか（詳細の「折りたたむ／展開する」。3 年の分かれ道は見え方の開閉） */
  isCollapsed(id: ID): boolean {
    return this.vm.isCollapsed(id);
  }

  /**
   * 隠れているノードを出す（検索で選んだときなど）。
   * プロジェクトに絞る・シナリオで隠すで隠れていれば「薄くする」表示に切り替え、折りたたみの中なら上流を開く
   * （3 年の分かれ道の中は見え方だけを開く。それ以外の折りたたみは文書を変える・元に戻せる）
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
    if (open.open.length) this.vm.setImpactOpen(open.open);
    if (!open.nodes.length && !open.edges.length) return;
    this.store.transact("隠れていたノードを表示", (tx) => {
      for (const n of open.nodes) tx.updateNode(n, { collapsed: false });
      for (const e of open.edges) tx.updateEdge(e, { collapsed: false });
    });
  }

  /**
   * お知らせの「元に戻す」: そのお知らせの操作がまだいちばん上にあるときだけ戻す
   * （その後に別の操作をしていたら、そちらを代わりに戻さない）
   */
  undoAction(): { label: string; run: () => void } {
    const stack = this.store.history.undoStack;
    const entry = stack[stack.length - 1];
    return {
      label: "元に戻す",
      run: () => {
        const top = this.store.history.undoStack[this.store.history.undoStack.length - 1];
        if (entry && top === entry) this.undo();
        // 上部の「元に戻す」・⌘Z でもう戻してある（やり直しの側にある）: 読み込んだ・別の操作をした、とは言わない
        else if (entry && this.store.history.redoStack.includes(entry)) this.hooks.toast("この操作はもう元に戻してあります");
        // 履歴ごと入れ替わった（初めての同期・別の端末の内容に譲った など）: 上部の「元に戻す」でも戻せない
        else if (!top) this.hooks.toast("その後に別の内容を読み込んだため、ここからは戻せません", { tone: "warn" });
        else this.hooks.toast("そのあとに別の操作をしたため、ここからは戻せません（上部の「元に戻す」で順に戻せます）", { tone: "warn" });
      },
    };
  }

  /**
   * すべての折りたたみを開く。3 年の分かれ道は見え方だけを開く（先のあるノードをすべて）。
   * それ以外の折りたたんだノード・接続は文書を変える（元に戻せる）。
   * 閲覧のみのタブで 3 年の分かれ道があれば、見え方だけを開き、文書には触れない（閲覧のみのお知らせも出さない）
   */
  expandAll(): void {
    const deep = this.vm.deep.get();
    let view: ID[];
    if (deep) {
      // 3 か月ごとの地図（約 7 万枚）は全部は開かない: キャンバスの上限（全体で 3,000 枚）に入る区切りまで、今日から時間で区切って開く
      // （作業メモ SPEC v1 §5.8・user-12・gaps-17）。先は見取り図と道の画面で読む
      this.vm.ensure();
      const users = this.vm.userNodeIds().length;
      const hs = deepHorizons(deep.cm, 0);
      const fit = [...hs].reverse().find((x) => x.count + 1 + users <= DEEP_OPEN_CAP) ?? null;
      view = fit ? horizonOpen(deep.cm, 0, fit).map((i) => deep.idOf(i)) : [];
      const n = (v: number) => v.toLocaleString("ja-JP");
      this.hooks.toast(
        fit
          ? `3 年の分かれ道は全部（${n(deep.cm.n)} 枚）は開けないので、今日から${fit.toEnd ? "最後" : `${fit.months / 12} 年先`}まで開いた（${n(fit.count)} 枚）。その先は右の「3 年の見取り図」と道の画面で読める`
          : `3 年の分かれ道は全部（${n(deep.cm.n)} 枚）は開けない。右の「3 年の見取り図」と道の画面で読める`,
        { tone: "info", ms: 7000 },
      );
    } else view = this.vm.impactBranches();
    this.vm.setImpactOpen(view);
    if (this.store.readOnly && view.length) return;
    // 文書で折りたたんだノード・線は索引が覚えている（文書をなめない。文書の順に開く）
    const idx = this.vm.index;
    const ns = [...idx.collapsedNodes].filter((id) => this.doc.nodes[id]?.collapsed && !this.vm.inImpact(id)).sort((a, b) => idx.nodeOrder(a) - idx.nodeOrder(b));
    const es = [...idx.collapsedEdges].filter((id) => this.doc.edges[id]?.collapsed).sort((a, b) => idx.edgeOrder(a) - idx.edgeOrder(b));
    if (!ns.length && !es.length) return;
    this.store.transact("すべて展開", (tx) => {
      ns.forEach((id) => tx.updateNode(id, { collapsed: false }));
      es.forEach((id) => tx.updateEdge(id, { collapsed: false }));
    });
  }

  /** 3 年の分かれ道の開いている所を最初の形に戻す（見え方だけ。概要の「最初の形に戻す」） */
  resetImpactOpen(): void {
    this.vm.resetImpactOpen();
  }

  /** 3 年の分かれ道のカードを動かそうとしたときのお知らせ（この表示の間に 1 度だけ） */
  noticeFixedLayout(): void {
    if (this.fixedNoticeShown) return;
    this.fixedNoticeShown = true;
    this.hooks.toast("3 年の分かれ道は自動で並ぶので、カードは動かせません", { tone: "info" });
  }

  private fixedNoticeShown = false;

  /**
   * 消す。3 年の分かれ道のカードを消すときは、その先だけにあるカード（消した後はどの入口からも、消す所の外に残るノードからも
   * 届かない物）も一緒に消す（残すと全部開いた形の遠い位置にふつうのカードとして散らばる）。ほかの親（自分のノードなど）から
   * つながっている物とその先は残す。範囲の外のノードは今までどおり。元に戻すと全部戻る
   */
  deleteNodes(ids: ID[], edges: ID[] = []): void {
    const ns = ids.filter((id) => this.doc.nodes[id]);
    const es = edges.filter((id) => this.doc.edges[id]);
    if (!ns.length && !es.length) return;
    const extra = this.impactOrphans(ns, es);
    const what = ns.length ? (ns.length === 1 ? `「${this.doc.nodes[ns[0]!]!.title || "無題"}」を削除` : `${ns.length} 件のノードを削除`) : es.length === 1 ? "接続を削除" : `${es.length} 本の接続を削除`;
    const more = extra.length ? `（この先の ${extra.length.toLocaleString("ja-JP")} 件も）` : "";
    const ok = this.store.transact(what + more, (tx) => {
      es.forEach((id) => tx.deleteEdge(id));
      ns.forEach((id) => tx.deleteNode(id));
      extra.forEach((id) => tx.deleteNode(id));
    });
    if (!ok) return;
    this.ui.clearSelection();
    this.hooks.toast(`${what}しました${more}`, { action: this.undoAction() });
  }

  /**
   * 3 年の分かれ道のカード ns（と接続 es）を消すと、その先だけに残るカード（ns の先にあり、消した後はどの入口からも、
   * 消す所の外に残るノードからも届かない物。ns は含めない）。ns に範囲のカードが無ければ空
   */
  private impactOrphans(ns: ID[], es: ID[]): ID[] {
    const seeds = ns.filter((id) => this.vm.inImpact(id));
    if (!seeds.length) return [];
    const doc = this.doc;
    const out = this.vm.index.out;
    const gone = new Set(ns);
    // 消すカードの先（道の線でたどれる物）= 一緒に消す候補
    const below = new Set<ID>();
    const stack = [...seeds];
    while (stack.length) {
      for (const e of flowOuts(doc, out, stack.pop()!)) {
        if (gone.has(e.target) || below.has(e.target)) continue;
        below.add(e.target);
        stack.push(e.target);
      }
    }
    if (!below.size) return [];
    // 消した後も残るノードから道の線（消す線は通らない）で届く物は残す。たどり始めは入口と、消すノード・候補のどちらでもないノード
    // （別の選択肢からも合流する物、自分の親 P → W のある自分のノード W とその先 など）。候補の外のノードは全部たどり始めなので、
    // 候補に入ってくる道の線のうち、元が候補でも消すノードでもない物の先から、候補の中だけをたどればよい（文書をなめない）
    const goneE = new Set(es);
    const reach = new Set<ID>();
    const queue: ID[] = [];
    const inc = this.vm.index.inc;
    for (const id of below) {
      if (isImpactRoot(doc.nodes[id])) {
        reach.add(id);
        queue.push(id);
        continue;
      }
      for (const eid of inc.get(id) ?? []) {
        const e = doc.edges[eid];
        if (!e || !isFlowEdge(e) || e.source === e.target || goneE.has(e.id) || gone.has(e.source) || below.has(e.source) || !doc.nodes[e.source]) continue;
        reach.add(id);
        queue.push(id);
        break;
      }
    }
    while (queue.length) {
      for (const e of flowOuts(doc, out, queue.pop()!)) {
        if (goneE.has(e.id) || gone.has(e.target) || reach.has(e.target) || !below.has(e.target)) continue;
        reach.add(e.target);
        queue.push(e.target);
      }
    }
    return [...below].filter((id) => !reach.has(id));
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
      // 写しは見えている位置の近くに（3 年の分かれ道のカードは重ねる位置。文書の位置は全部開いた形の所で遠い）
      const at = this.vm.hasOverlay(n.id) ? this.vm.posOf(n.id)! : n;
      // 3 か月ごとの地図のカードの本文は見せるときに組み立てる物なので、写しには今の年収で組み立てた文章（数の行と本文）を入れ、
      // 自分のメモはその後に残す（写しは地図の外のカードになり、組み立て直されない。作業メモ SPEC v1 §4.4）
      const made = this.vm.deep.materialize(n.id);
      const body = made === null ? n.body : n.body.trim() ? `${made}\n\n${n.body}` : made;
      return makeNode({ ...n, id, x: at.x + 40, y: at.y + 40, body, conditions: n.conditions.map((c) => ({ ...c, id: newId("c") })), createdAt: undefined, updatedAt: undefined, collapsed: false, meta: without(n.meta, COPY_DROP_NODE) });
    });
    // 写すノードの間の線（写すノードの出る線だけを見る。文書の順）
    const idx = this.vm.index;
    const inner = nodes
      .flatMap((n) => idx.out.get(n.id) ?? [])
      .map((eid) => this.doc.edges[eid])
      .filter((e): e is GEdge => !!e && map.has(e.source) && map.has(e.target))
      .sort((a, b) => idx.edgeOrder(a.id) - idx.edgeOrder(b.id));
    const ok = this.store.transact(nodes.length === 1 ? "複製" : `${nodes.length} 件を複製`, (tx) => {
      copies.forEach((c) => tx.addNode(c));
      inner.forEach((e) => tx.addEdge(makeEdge({ ...e, id: newId("e"), source: map.get(e.source)!, target: map.get(e.target)!, createdAt: undefined, updatedAt: undefined, meta: without(e.meta, COPY_DROP_EDGE) })));
    });
    if (!ok) return [];
    this.ui.select(copies.map((c) => c.id));
    return copies.map((c) => c.id);
  }

  /** 横（同じ高さ）・縦（同じ横位置）にそろえる */
  align(ids: ID[], axis: "h" | "v"): void {
    const nodes = this.movable(ids)
      .map((id) => this.doc.nodes[id])
      .filter((n): n is GNode => !!n);
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
    // 3 年の分かれ道のカードから道の線でつなぐと範囲に入るかもしれないノード（線の先からたどれる、今は範囲の外の物）
    const outside = this.doc.nodes[target] && !this.vm.inImpact(target) && sources.some((s) => this.vm.inImpact(s)) ? this.flowReach(target).filter((id) => !this.vm.inImpact(id)) : [];
    const created: ID[] = [];
    this.store.transact(sources.length > 1 ? `${sources.length} 本を接続` : "接続", (tx) => {
      for (const s of sources) {
        if (s === target) continue;
        const e = tx.addEdge(makeEdge({ source: s, target, relation: relation ?? this.relationFrom(tx.doc.nodes[s]) }));
        if (e) created.push(e.id);
      }
    });
    if (created.length === 0) this.hooks.toast("すでにつながっています");
    else {
      // 3 年の分かれ道のカードから道の線を引いたら、そのカードを見え方で開く（閉じたままだと線とその先が隠れる。文書の collapsed は使わない）。
      // その線で範囲に入った自分のノードは、文書で開いていた物を見え方でも開く（つないだだけで、見えていた先が隠れないように）
      const open = created.map((id) => this.doc.edges[id]).filter((e): e is GEdge => !!e && isFlowEdge(e) && this.vm.inImpact(e.source)).map((e) => e.source);
      for (const id of outside) if (this.vm.inImpact(id) && !this.doc.nodes[id]?.collapsed) open.push(id);
      if (open.length) this.vm.setImpactOpen(open);
      if (created.length === 1) this.ui.select([], created);
    }
    return created;
  }

  /** id から道の線（進む・条件付き）でたどれるノード（id を含む） */
  private flowReach(id: ID): ID[] {
    const doc = this.doc;
    const out = this.vm.index.out;
    const seen = new Set<ID>([id]);
    const stack = [id];
    while (stack.length) {
      for (const e of flowOuts(doc, out, stack.pop()!)) {
        if (seen.has(e.target)) continue;
        seen.add(e.target);
        stack.push(e.target);
      }
    }
    return [...seen];
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
    const reversed = (this.vm.index.out.get(e.target) ?? []).some((x) => this.doc.edges[x]?.target === e.source);
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
    const count = new Set(this.vm.index.projectNodes.get(id) ?? []).size;
    const ok = await this.hooks.confirm({
      title: `プロジェクト「${p.name}」を削除`,
      body: `ノード ${count} 件は削除されず、このプロジェクトへの所属だけが外れます。あとから「元に戻す」で戻せます。`,
      ok: "削除する",
      danger: true,
    });
    if (!ok) return;
    if (this.store.transact(`プロジェクト「${p.name}」を削除`, (tx) => tx.deleteProject(id))) {
      if (this.ui.prefs.projectFilter.includes(id)) this.ui.setPrefs({ projectFilter: this.ui.prefs.projectFilter.filter((x) => x !== id) });
      this.hooks.toast(`プロジェクト「${p.name}」を削除しました`, { action: this.undoAction() });
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
      this.hooks.toast(`シナリオ「${s.name}」を削除しました`, { action: this.undoAction() });
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
    // 直前がまとめて開く・たたむなら、文書の取り消しより先にそれを戻す（開いた形は文書の履歴に入れないが、1 回の操作 = 1 回の
    // 元に戻す: 見直し data-undo-toast-only・reader-3）
    if (this.vm.undoBulkOpen()) {
      this.hooks.bulkUndone?.();
      return;
    }
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
