// ストア: ドキュメントを持ち、すべての変更をトランザクションで受ける。
// 変更は 1 か所を通るので、Undo/Redo・自動保存・再描画が漏れなくつながる。設計: docs/DESIGN.md §2

import { nextStamp, nowISO } from "../model/ids";
import { cloneDocShallow } from "../model/schema";
import type { Collection, DocData, EntityOf, GEdge, GNode, ID, Project, Scenario } from "../model/types";
import { Emitter } from "./emitter";
import { History, isEmptyEntry, newEntry, type HistoryEntry, type OrderKey } from "./history";

export type ChangeSource = "tx" | "undo" | "redo" | "replace" | "load" | "remote";

export interface ChangeInfo {
  source: ChangeSource;
  label: string;
  nodes: Set<ID>;
  edges: Set<ID>;
  projects: Set<ID>;
  scenarios: Set<ID>;
  /** 位置だけが変わった（索引の作り直しが要らない） */
  positionsOnly: boolean;
  /** 全部が入れ替わった */
  full: boolean;
}

export interface StoreEvents {
  change: ChangeInfo;
  /** 閲覧専用のときに編集しようとした */
  blocked: string;
  history: void;
}

function newInfo(source: ChangeSource, label: string, full = false): ChangeInfo {
  return { source, label, nodes: new Set(), edges: new Set(), projects: new Set(), scenarios: new Set(), positionsOnly: !full, full };
}

/** 1 段だけの比較（配列は要素ごと、オブジェクトはキーごと）。同じ値の書き込みを変更として数えない */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

export class Tx {
  private incident: Map<ID, Set<ID>> | null = null;

  constructor(
    private readonly store: Store,
    private readonly entry: HistoryEntry,
    private readonly info: ChangeInfo,
  ) {}

  get doc(): DocData {
    return this.store.doc;
  }

  private rec<C extends Collection>(c: C, id: ID, before: EntityOf[C] | undefined, after: EntityOf[C] | undefined): void {
    const key = `${c}\u0000${id}`;
    const ex = this.entry.entities.get(key);
    if (ex) ex.after = after;
    else this.entry.entities.set(key, { c, id, before, after });
    this.info[c].add(id);
  }

  private structural(): void {
    this.info.positionsOnly = false;
  }

  /** ノード → 接続（ノードの削除で使う。このトランザクションの中だけ持つ） */
  private incidentOf(id: ID): Set<ID> {
    if (!this.incident) {
      this.incident = new Map();
      for (const eid in this.doc.edges) {
        const e = this.doc.edges[eid]!;
        this.link(e);
      }
    }
    return this.incident.get(id) ?? new Set();
  }

  private link(e: GEdge): void {
    if (!this.incident) return;
    for (const n of [e.source, e.target]) {
      let s = this.incident.get(n);
      if (!s) this.incident.set(n, (s = new Set()));
      s.add(e.id);
    }
  }

  private unlink(e: GEdge): void {
    if (!this.incident) return;
    this.incident.get(e.source)?.delete(e.id);
    this.incident.get(e.target)?.delete(e.id);
  }

  // ---- ノード

  addNode(n: GNode): GNode {
    if (this.doc.nodes[n.id]) throw new Error(`ノード ${n.id} はすでにあります`);
    this.doc.nodes[n.id] = n;
    this.rec("nodes", n.id, undefined, n);
    this.structural();
    return n;
  }

  updateNode(id: ID, patch: Partial<GNode>): GNode | undefined {
    const old = this.doc.nodes[id];
    if (!old) return undefined;
    let changed = false;
    let posOnly = true;
    for (const k of Object.keys(patch) as Array<keyof GNode>) {
      if (k === "id") continue;
      if (!sameValue(old[k], patch[k])) {
        changed = true;
        if (k !== "x" && k !== "y") posOnly = false;
      }
    }
    if (!changed) return old;
    const next: GNode = { ...old, ...patch, id: old.id };
    if (!posOnly) next.updatedAt = nowISO();
    this.doc.nodes[id] = next;
    this.rec("nodes", id, old, next);
    if (!posOnly) this.structural();
    return next;
  }

  /** ノードを消す（つながっている接続も消す） */
  deleteNode(id: ID): void {
    const old = this.doc.nodes[id];
    if (!old) return;
    for (const eid of [...this.incidentOf(id)]) this.deleteEdge(eid);
    delete this.doc.nodes[id];
    this.rec("nodes", id, old, undefined);
    this.structural();
  }

  // ---- 接続

  /** 両端が無い・自分自身・同じ向きの重複のときは作らずに null */
  addEdge(e: GEdge): GEdge | null {
    if (!this.doc.nodes[e.source] || !this.doc.nodes[e.target] || e.source === e.target || this.doc.edges[e.id]) return null;
    for (const eid of this.incidentOf(e.source)) {
      const x = this.doc.edges[eid];
      if (x && x.source === e.source && x.target === e.target) return null;
    }
    this.doc.edges[e.id] = e;
    this.link(e);
    this.rec("edges", e.id, undefined, e);
    this.structural();
    return e;
  }

  updateEdge(id: ID, patch: Partial<GEdge>): GEdge | undefined {
    const old = this.doc.edges[id];
    if (!old) return undefined;
    let changed = false;
    for (const k of Object.keys(patch) as Array<keyof GEdge>) if (k !== "id" && !sameValue(old[k], patch[k])) changed = true;
    if (!changed) return old;
    const next: GEdge = { ...old, ...patch, id: old.id, updatedAt: nowISO() };
    if (next.source !== old.source || next.target !== old.target) {
      if (!this.doc.nodes[next.source] || !this.doc.nodes[next.target] || next.source === next.target) return old;
      for (const eid of this.incidentOf(next.source)) {
        const x = this.doc.edges[eid];
        if (x && x.id !== id && x.source === next.source && x.target === next.target) return old;
      }
    }
    this.unlink(old);
    this.doc.edges[id] = next;
    this.link(next);
    this.rec("edges", id, old, next);
    this.structural();
    return next;
  }

  deleteEdge(id: ID): void {
    const old = this.doc.edges[id];
    if (!old) return;
    this.unlink(old);
    delete this.doc.edges[id];
    this.rec("edges", id, old, undefined);
    this.structural();
  }

  // ---- プロジェクト

  addProject(p: Project, index = this.doc.projectOrder.length): Project {
    this.doc.projects[p.id] = p;
    this.rec("projects", p.id, undefined, p);
    const order = [...this.doc.projectOrder.filter((x) => x !== p.id)];
    order.splice(Math.max(0, Math.min(index, order.length)), 0, p.id);
    this.setOrder("projectOrder", order);
    this.structural();
    return p;
  }

  updateProject(id: ID, patch: Partial<Project>): Project | undefined {
    const old = this.doc.projects[id];
    if (!old) return undefined;
    let changed = false;
    for (const k of Object.keys(patch) as Array<keyof Project>) if (k !== "id" && !sameValue(old[k], patch[k])) changed = true;
    if (!changed) return old;
    const next: Project = { ...old, ...patch, id, updatedAt: nowISO() };
    this.doc.projects[id] = next;
    this.rec("projects", id, old, next);
    this.structural();
    return next;
  }

  /** プロジェクトを消す。ノードは消さず、所属だけ外す */
  deleteProject(id: ID): void {
    const old = this.doc.projects[id];
    if (!old) return;
    for (const nid in this.doc.nodes) {
      const n = this.doc.nodes[nid]!;
      if (n.projectIds.includes(id)) this.updateNode(nid, { projectIds: n.projectIds.filter((p) => p !== id) });
    }
    this.setOrder(
      "projectOrder",
      this.doc.projectOrder.filter((p) => p !== id),
    );
    delete this.doc.projects[id];
    this.rec("projects", id, old, undefined);
    this.structural();
  }

  // ---- シナリオ

  addScenario(s: Scenario, index = this.doc.scenarioOrder.length): Scenario {
    this.doc.scenarios[s.id] = s;
    this.rec("scenarios", s.id, undefined, s);
    const order = [...this.doc.scenarioOrder.filter((x) => x !== s.id)];
    order.splice(Math.max(0, Math.min(index, order.length)), 0, s.id);
    this.setOrder("scenarioOrder", order);
    this.structural();
    return s;
  }

  updateScenario(id: ID, patch: Partial<Scenario>): Scenario | undefined {
    const old = this.doc.scenarios[id];
    if (!old) return undefined;
    let changed = false;
    for (const k of Object.keys(patch) as Array<keyof Scenario>) if (k !== "id" && !sameValue(old[k], patch[k])) changed = true;
    if (!changed) return old;
    const next: Scenario = { ...old, ...patch, id, updatedAt: nowISO() };
    this.doc.scenarios[id] = next;
    this.rec("scenarios", id, old, next);
    this.structural();
    return next;
  }

  /** シナリオを消す。ノード・接続は消さず、所属だけ外す（そのシナリオだけの要素は共通になる） */
  deleteScenario(id: ID): void {
    const old = this.doc.scenarios[id];
    if (!old) return;
    for (const nid in this.doc.nodes) {
      const n = this.doc.nodes[nid]!;
      if (n.scenarioIds.includes(id)) this.updateNode(nid, { scenarioIds: n.scenarioIds.filter((s) => s !== id) });
    }
    for (const eid in this.doc.edges) {
      const e = this.doc.edges[eid]!;
      if (e.scenarioIds.includes(id)) this.updateEdge(eid, { scenarioIds: e.scenarioIds.filter((s) => s !== id) });
    }
    this.setOrder(
      "scenarioOrder",
      this.doc.scenarioOrder.filter((s) => s !== id),
    );
    delete this.doc.scenarios[id];
    this.rec("scenarios", id, old, undefined);
    this.structural();
  }

  // ---- 並び・題名

  setOrder(key: OrderKey, ids: ID[]): void {
    const before = this.doc[key];
    if (sameValue(before, ids)) return;
    const ex = this.entry.orders.get(key);
    if (ex) ex.after = ids;
    else this.entry.orders.set(key, { before, after: ids });
    this.doc[key] = ids;
    this.structural();
  }

  setTitle(title: string): void {
    const before = this.doc.title;
    if (before === title) return;
    this.entry.title = this.entry.title ? { before: this.entry.title.before, after: title } : { before, after: title };
    this.doc.title = title;
    this.structural();
  }
}

export class Store {
  doc: DocData;
  readonly history = new History();
  /** 閲覧専用（別のタブが編集中・一時表示など） */
  readOnly = false;
  /** 変更のたびに増える（キャッシュの鍵に使う） */
  revision = 0;
  private readonly emitter = new Emitter<StoreEvents>();
  private current: Tx | null = null;

  constructor(doc: DocData) {
    this.doc = doc;
  }

  on<K extends keyof StoreEvents>(type: K, fn: (payload: StoreEvents[K]) => void): () => void {
    return this.emitter.on(type, fn);
  }

  /**
   * 変更はすべてここを通す。fn の中で例外が出たら途中の変更を戻す。
   * coalesce: 同じ鍵の続けての変更を履歴の 1 件にまとめる（文字入力など）
   */
  transact(label: string, fn: (tx: Tx) => void, opts: { coalesce?: string; record?: boolean } = {}): boolean {
    if (this.readOnly) {
      this.emitter.emit("blocked", label);
      return false;
    }
    if (this.current) {
      fn(this.current);
      return true;
    }
    const entry = newEntry(label, opts.coalesce);
    const info = newInfo("tx", label);
    const tx = new Tx(this, entry, info);
    this.current = tx;
    try {
      fn(tx);
    } catch (err) {
      this.current = null;
      this.apply(entry, "undo");
      throw err;
    } finally {
      this.current = null;
    }
    if (isEmptyEntry(entry)) return true;
    this.doc.updatedAt = nextStamp(this.doc.updatedAt);
    if (opts.record !== false) this.history.push(entry);
    this.revision++;
    this.emitter.emit("change", info);
    this.emitter.emit("history", undefined);
    return true;
  }

  undo(): boolean {
    if (this.readOnly) {
      this.emitter.emit("blocked", "元に戻す");
      return false;
    }
    const entry = this.history.undoStack.pop();
    if (!entry) return false;
    const info = this.apply(entry, "undo");
    this.history.redoStack.push(entry);
    this.finish(info);
    return true;
  }

  redo(): boolean {
    if (this.readOnly) {
      this.emitter.emit("blocked", "やり直す");
      return false;
    }
    const entry = this.history.redoStack.pop();
    if (!entry) return false;
    const info = this.apply(entry, "redo");
    this.history.undoStack.push(entry);
    this.finish(info);
    return true;
  }

  /** ドキュメントを入れ替える（取り込み・復元）。Undo で戻せる */
  replaceDoc(next: DocData, label: string): boolean {
    if (this.readOnly) {
      this.emitter.emit("blocked", label);
      return false;
    }
    const entry = newEntry(label);
    entry.replace = { before: cloneDocShallow(this.doc), after: cloneDocShallow(next) };
    const prev = this.doc.updatedAt;
    this.doc = cloneDocShallow(next);
    // 入れ替えも変更なので時刻を進める（読み込んだ物の時刻が古くても、保存や緊急コピーで「古い」と見なされない）
    this.doc.updatedAt = nextStamp(prev);
    this.history.push(entry);
    this.finish(newInfo("replace", label, true));
    return true;
  }

  /** 読み込み（履歴は消す。Undo の対象にしない） */
  load(doc: DocData, source: "load" | "remote" = "load"): void {
    this.doc = doc;
    this.history.clear();
    this.finish(newInfo(source, source === "load" ? "読み込み" : "別のタブの変更", true));
  }

  private finish(info: ChangeInfo): void {
    this.revision++;
    this.emitter.emit("change", info);
    this.emitter.emit("history", undefined);
  }

  private apply(entry: HistoryEntry, dir: "undo" | "redo"): ChangeInfo {
    const info = newInfo(dir, entry.label);
    if (entry.replace) {
      const prev = this.doc.updatedAt;
      this.doc = cloneDocShallow(dir === "undo" ? entry.replace.before : entry.replace.after);
      this.doc.updatedAt = nextStamp(prev);
      info.full = true;
      info.positionsOnly = false;
      return info;
    }
    const list = [...entry.entities.values()];
    if (dir === "undo") list.reverse();
    let posOnly = entry.orders.size === 0 && !entry.title;
    for (const ch of list) {
      const coll = this.doc[ch.c] as Record<ID, unknown>;
      const v = dir === "undo" ? ch.before : ch.after;
      if (v === undefined) delete coll[ch.id];
      else coll[ch.id] = v;
      info[ch.c].add(ch.id);
      if (ch.c !== "nodes" || ch.before === undefined || ch.after === undefined) posOnly = false;
      else {
        const a = ch.before as GNode;
        const b = ch.after as GNode;
        for (const k of Object.keys(b) as Array<keyof GNode>) {
          if (k !== "x" && k !== "y" && k !== "updatedAt" && !sameValue(a[k], b[k])) {
            posOnly = false;
            break;
          }
        }
      }
    }
    for (const [k, o] of entry.orders) this.doc[k] = dir === "undo" ? o.before : o.after;
    if (entry.title) this.doc.title = dir === "undo" ? entry.title.before : entry.title.after;
    info.positionsOnly = posOnly;
    this.doc.updatedAt = nextStamp(this.doc.updatedAt);
    return info;
  }
}
