// 文書の索引（./graph.ts の GraphIndex と同じ中身）を、変更のたびに作り直さず、変わったノード・線だけ直して持つ所。
// 設計: 作業メモ SPEC v1 §7.1 の 5・6（見直し perf-3・perf-4・gaps-8）
//
// 作り直すのは、全部が入れ替わったとき（読み込み・取り込み・入れ替えの元に戻す）だけ。それ以外は store の変更の知らせ
// （ChangeInfo の nodes・edges・projects・scenarios）に入っている物を、前に見た物（seen）と今の物で比べて直す（O(変わった物)）。
// 並び（出る線・入る線・プロジェクトのノード・未分類）は buildIndex と同じ「文書のキーの順」に保つ（キーの順 = 足した順。
// 消して足し直したキーは最後。書き換えは同じ所）。tests/unit/docIndex.test.ts が、乱数の編集の後に buildIndex と同じかを確かめる。
//
// 索引に足した物（数えるたびに文書をなめないため。perf-4・gaps-8）:
//   nodeCount・edgeCount・typeCounts・期限の幅（dueRange）・予測の入口（forecastRoots）・3 年の分かれ道の入口（impactRoots）・
//   文書で折りたたんだノードと線（collapsedNodes・collapsedEdges）・プロジェクトごとの共有ノードの数（sharedIn）
// 版（version）: 何が変わったかを読み手が比べる（形・道の線・所属・期限・入口・シナリオ・折りたたみ・中身）

import { dayNumber } from "./dates";
import { isFlowEdge, isImpactRoot } from "./forks";
import { isCross, type GraphIndex } from "./graph";
import type { DocData, GEdge, GNode, ID, NodeType } from "./types";

/** 変更の知らせ（store の ChangeInfo の、索引が読む所） */
export interface IndexChangeInfo {
  full: boolean;
  nodes: ReadonlySet<ID>;
  edges: ReadonlySet<ID>;
  projects: ReadonlySet<ID>;
  scenarios: ReadonlySet<ID>;
}

/** 索引の版。変わった物の版だけが進む */
export interface IndexVersions {
  /** 出る線・入る線（線の増減・付け替え、ノードの増減） */
  topo: number;
  /** 道の線（進む・条件付き）の形と 3 年の分かれ道の入口（3 年の分かれ道の範囲が変わりうる） */
  flow: number;
  /** 所属（プロジェクト・タグ・シナリオの数・種類の数・ノードと線の数・プロジェクト間の線） */
  members: number;
  /** 期限 */
  dates: number;
  /** 予測の入口のノード（増減・中身の変更） */
  roots: number;
  /** ノード・線のシナリオ、シナリオの増減 */
  scen: number;
  /** 文書の折りたたみ（ノード・線） */
  collapse: number;
  /** 中身（ノード・線・プロジェクトのどれかが変わった。検索の当たりが変わりうる） */
  content: number;
}

/** 変わったノード・線の前と後を受け取る（索引を直すのと同じ回で。見込みの材料・検索が使う） */
export interface IndexVisitor {
  node?(id: ID, before: GNode | undefined, after: GNode | undefined): void;
  edge?(id: ID, before: GEdge | undefined, after: GEdge | undefined): void;
}

const NODE_TYPES_ALL: readonly NodeType[] = ["goal", "action", "branch", "result"];

/** 並び（キーの順の番号 seq の小さい順）を保って入れる。最後に足すことが多いので、まず末尾を見る */
function insertBySeq(list: ID[], id: ID, seq: Map<ID, number>): void {
  const s = seq.get(id)!;
  const n = list.length;
  if (n === 0 || seq.get(list[n - 1]!)! <= s) {
    list.push(id);
    return;
  }
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (seq.get(list[mid]!)! < s) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, id);
}

/** 1 つだけ外す（無ければ何もしない） */
function removeOne(list: ID[] | undefined, id: ID): boolean {
  if (!list) return false;
  const i = list.lastIndexOf(id);
  if (i < 0) return false;
  list.splice(i, 1);
  return true;
}

/** 配列の中身が同じか（同じ物か、要素が順に同じ） */
function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const isRootNode = (n: GNode | undefined): boolean => !!n && n.meta?.forecastRoot === true;

export class DocIndex implements GraphIndex {
  out = new Map<ID, ID[]>();
  inc = new Map<ID, ID[]>();
  projectNodes = new Map<ID, ID[]>();
  unassigned: ID[] = [];
  cross = new Set<ID>();
  shared = new Set<ID>();
  scenarioCounts = new Map<ID, number>();

  nodeCount = 0;
  edgeCount = 0;
  readonly typeCounts: Record<NodeType, number> = { goal: 0, action: 0, branch: 0, result: 0 };
  /** プロジェクト → その中の共有ノード（2 つ以上のプロジェクトに属するノード）の数（左の一覧の 🔗） */
  readonly sharedIn = new Map<ID, number>();
  /** 予測の入口（meta.forecastRoot）のノード */
  readonly forecastRoots = new Set<ID>();
  /** 3 年の分かれ道の入口（isImpactRoot） */
  readonly impactRoots = new Set<ID>();
  /** 文書で折りたたんだノード・線 */
  readonly collapsedNodes = new Set<ID>();
  readonly collapsedEdges = new Set<ID>();

  readonly version: IndexVersions = { topo: 0, flow: 0, members: 0, dates: 0, roots: 0, scen: 0, collapse: 0, content: 0 };

  /**
   * キーの順の番号（文書の for…in の順。足したキーは大きい番号）と、前に見た物（変わったかを比べる元）。
   * 番号の表 1 つと、番号ごとの配列（Map を 1 つにして、作り直しを軽くする）
   */
  private readonly nodeSeq = new Map<ID, number>();
  private nodeAt: Array<GNode | undefined> = [];
  private readonly edgeSeq = new Map<ID, number>();
  private edgeAt: Array<GEdge | undefined> = [];
  /** 索引に入っている線（両端のノードがある線）。番号ごと */
  private edgeLinked: boolean[] = [];
  /** 期限の文字 → dayNumber（同じ文字は 1 度だけ読む） */
  private readonly dayOf = new Map<string, number>();
  /** タグ（小文字）→ 書き方ごとの数 */
  private readonly tagCount = new Map<string, Map<string, number>>();
  private tagList: Array<{ tag: string; count: number }> | null = [];
  /** 期限の日（dayNumber）→ その日が期限のノードの数 */
  private readonly dueCount = new Map<number, number>();
  private dueMinMax: { min: number; max: number } | null = null;
  private dueStale = false;
  private doc: DocData;

  constructor(doc: DocData) {
    this.doc = doc;
    this.rebuild(doc);
  }

  /** 線の数を数えた文書（読み手は store.doc と比べない。確かめ用） */
  get source(): DocData {
    return this.doc;
  }

  /** タグ → 件数（多い順。同じ数は名前の順。buildIndex と同じ） */
  get tags(): Array<{ tag: string; count: number }> {
    if (!this.tagList) {
      const list: Array<{ tag: string; count: number }> = [];
      for (const [key, by] of this.tagCount) {
        let count = 0;
        for (const c of by.values()) count += c;
        if (count > 0) list.push({ tag: this.tagFace(key, by), count });
      }
      list.sort((x, y) => y.count - x.count || x.tag.localeCompare(y.tag, "ja"));
      this.tagList = list;
    }
    return this.tagList;
  }

  /** タグの見せる書き方: 文書のキーの順で最初に出てくる書き方（書き方が 1 つなら、それ） */
  private tagFace(key: string, by: Map<string, number>): string {
    if (by.size === 1) return by.keys().next().value!;
    for (const id in this.doc.nodes) for (const t of this.doc.nodes[id]!.tags) if (t.toLowerCase() === key) return t;
    return by.keys().next().value!;
  }

  /** 期限の一番早い日と遅い日（dayNumber。期限のあるノードが無ければ null） */
  dueRange(): { min: number; max: number } | null {
    if (this.dueStale) {
      this.dueStale = false;
      let min = Infinity;
      let max = -Infinity;
      for (const [d, c] of this.dueCount) {
        if (c <= 0 || !Number.isFinite(d)) continue;
        if (d < min) min = d;
        if (d > max) max = d;
      }
      this.dueMinMax = min === Infinity ? null : { min, max };
    }
    return this.dueMinMax;
  }

  /** ノードのキーの順の番号（描く順を文書の順にそろえる）。無ければ −1 */
  nodeOrder(id: ID): number {
    return this.nodeSeq.get(id) ?? -1;
  }

  private seenN(id: ID): GNode | undefined {
    const i = this.nodeSeq.get(id);
    return i === undefined ? undefined : this.nodeAt[i];
  }

  private seenE(id: ID): GEdge | undefined {
    const i = this.edgeSeq.get(id);
    return i === undefined ? undefined : this.edgeAt[i];
  }

  private day(due: string): number {
    let d = this.dayOf.get(due);
    if (d === undefined) {
      d = dayNumber(due);
      if (this.dayOf.size > 4096) this.dayOf.clear();
      this.dayOf.set(due, d);
    }
    return d;
  }

  /** 線のキーの順の番号。無ければ −1 */
  edgeOrder(id: ID): number {
    return this.edgeSeq.get(id) ?? -1;
  }

  /** 全部を作り直す（buildIndex と同じ並び） */
  rebuild(doc: DocData): void {
    this.doc = doc;
    this.out = new Map();
    this.inc = new Map();
    this.projectNodes = new Map();
    this.unassigned = [];
    this.cross = new Set();
    this.shared = new Set();
    this.scenarioCounts = new Map();
    this.nodeCount = 0;
    this.edgeCount = 0;
    for (const t of NODE_TYPES_ALL) this.typeCounts[t] = 0;
    this.sharedIn.clear();
    this.forecastRoots.clear();
    this.impactRoots.clear();
    this.collapsedNodes.clear();
    this.collapsedEdges.clear();
    this.nodeSeq.clear();
    this.edgeSeq.clear();
    this.nodeAt = [];
    this.edgeAt = [];
    this.edgeLinked = [];
    this.tagCount.clear();
    this.tagList = null;
    this.dueCount.clear();
    this.dueStale = true;
    for (const pid of doc.projectOrder) this.projectNodes.set(pid, []);
    for (const sid of doc.scenarioOrder) this.scenarioCounts.set(sid, 0);
    // 共有の所属・タグ・期限は同じ配列・文字を使い回す文書が多い（組み立てた地図）: 配列ごとに数えてから足す
    const sharedBy = new Map<ID[], number>();
    const tagsBy = new Map<string[], number>();
    const nodeAt = this.nodeAt;
    // キーと値を同じ順の配列で読む（キーごとに文書を引き直さない）
    const nkeys = Object.keys(doc.nodes);
    const nvals = Object.values(doc.nodes);
    const outL: ID[][] = new Array(nkeys.length);
    const incL: ID[][] = new Array(nkeys.length);
    for (let i = 0; i < nkeys.length; i++) {
      const id = nkeys[i]!;
      const n = nvals[i]!;
      this.nodeSeq.set(id, i);
      nodeAt.push(n);
      const o: ID[] = (outL[i] = []);
      const c: ID[] = (incL[i] = []);
      this.out.set(id, o);
      this.inc.set(id, c);
      const pids = n.projectIds;
      if (pids.length === 0) this.unassigned.push(id);
      else {
        for (const p of pids) {
          let list = this.projectNodes.get(p);
          if (!list) this.projectNodes.set(p, (list = []));
          list.push(id);
        }
        if (pids.length > 1) {
          this.shared.add(id);
          sharedBy.set(pids, (sharedBy.get(pids) ?? 0) + 1);
        }
      }
      if (n.tags.length) tagsBy.set(n.tags, (tagsBy.get(n.tags) ?? 0) + 1);
      for (const s of n.scenarioIds) this.addScen(s, 1);
      this.typeCounts[n.type] = (this.typeCounts[n.type] ?? 0) + 1;
      const due = n.time.due;
      if (due) {
        const d = this.day(due);
        this.dueCount.set(d, (this.dueCount.get(d) ?? 0) + 1);
      }
      if (n.collapsed) this.collapsedNodes.add(id);
      if (n.meta?.forecastRoot === true) {
        this.forecastRoots.add(id);
        if (isImpactRoot(n)) this.impactRoots.add(id);
      }
    }
    this.nodeCount = nodeAt.length;
    for (const [pids, c] of sharedBy) for (const p of pids) this.sharedIn.set(p, (this.sharedIn.get(p) ?? 0) + c);
    for (const [tags, c] of tagsBy) this.countTagList(tags, c);
    const edgeAt = this.edgeAt;
    const linked = this.edgeLinked;
    /** プロジェクト間か（所属の配列の組ごとに覚える） */
    const crossMemo = new Map<ID[], Map<ID[], boolean>>();
    const ekeys = Object.keys(doc.edges);
    const evals = Object.values(doc.edges);
    for (let k = 0; k < ekeys.length; k++) {
      const id = ekeys[k]!;
      const e = evals[k]!;
      this.edgeSeq.set(id, k);
      edgeAt.push(e);
      if (e.collapsed) this.collapsedEdges.add(id);
      const a = this.nodeSeq.get(e.source);
      const b = this.nodeSeq.get(e.target);
      if (a === undefined || b === undefined) {
        linked.push(false);
        continue;
      }
      linked.push(true);
      outL[a]!.push(id);
      incL[b]!.push(id);
      const na = nodeAt[a]!;
      const nb = nodeAt[b]!;
      const pa = na.projectIds;
      const pb = nb.projectIds;
      let row = crossMemo.get(pa);
      if (!row) crossMemo.set(pa, (row = new Map()));
      let cr = row.get(pb);
      if (cr === undefined) {
        cr = isCross(na, nb);
        row.set(pb, cr);
      }
      if (cr) this.cross.add(id);
      for (const s of e.scenarioIds) this.addScen(s, 1);
    }
    this.edgeCount = edgeAt.length;
    const v = this.version;
    v.topo++;
    v.flow++;
    v.members++;
    v.dates++;
    v.roots++;
    v.scen++;
    v.collapse++;
    v.content++;
  }

  /**
   * 変更を受けて直す（O(変わった物)）。全部が入れ替わったら作り直す。
   * visit は、変わったノード・線の前と後を受け取る（直すのと同じ回。同じ物なら呼ばない）
   */
  apply(doc: DocData, info: IndexChangeInfo, visit?: IndexVisitor): void {
    if (info.full || doc !== this.doc) {
      // 全部が入れ替わったら作り直す（前と後の比べは読み手がする。visit は呼ばない）
      this.rebuild(doc);
      return;
    }
    const v = this.version;
    let topo = false;
    let flow = false;
    let members = false;
    let dates = false;
    let roots = false;
    let scen = false;
    let collapse = false;
    let content = false;

    if (info.projects.size) {
      content = true;
      members = true;
      for (const pid of info.projects) this.fixProjectKey(pid);
    }
    if (info.scenarios.size) {
      scen = true;
      members = true;
      for (const sid of info.scenarios) this.fixScenarioKey(sid);
    }

    /** プロジェクトの所属が変わったノード（線のプロジェクト間を見直す） */
    const projMoved: ID[] = [];
    for (const id of info.nodes) {
      const before = this.seenN(id);
      const after = doc.nodes[id];
      if (before === after) continue;
      content = true;
      visit?.node?.(id, before, after);
      if (isRootNode(before) || isRootNode(after)) roots = true;
      if (!before) {
        // 足した
        this.nodeSeq.set(id, this.nodeAt.length);
        this.nodeAt.push(after!);
        this.out.set(id, []);
        this.inc.set(id, []);
        this.nodeCount++;
        this.addNodeFields(after!, false);
        topo = flow = members = true;
        if (after!.time.due) dates = true;
        if (after!.scenarioIds.length) scen = true;
        if (after!.collapsed) collapse = true;
        continue;
      }
      if (!after) {
        // 消した: 残っている線を外してから（ふつうは同じ変更で線も消えている）
        for (const eid of [...(this.out.get(id) ?? []), ...(this.inc.get(id) ?? [])]) {
          const e = this.seenE(eid);
          if (e) this.unlink(e);
        }
        this.removeNodeFields(before);
        this.out.delete(id);
        this.inc.delete(id);
        this.nodeAt[this.nodeSeq.get(id)!] = undefined;
        this.nodeSeq.delete(id);
        this.nodeCount--;
        topo = flow = members = true;
        if (before.time.due) dates = true;
        if (before.scenarioIds.length) scen = true;
        if (before.collapsed) collapse = true;
        continue;
      }
      // 書き換えた
      this.nodeAt[this.nodeSeq.get(id)!] = after;
      if (!sameList(before.projectIds, after.projectIds)) {
        this.removeProjects(before);
        this.addProjects(after, false);
        projMoved.push(id);
        members = true;
      }
      if (!sameList(before.tags, after.tags)) {
        this.countTags(before, -1);
        this.countTags(after, 1);
        members = true;
      }
      if (!sameList(before.scenarioIds, after.scenarioIds)) {
        for (const s of before.scenarioIds) this.addScen(s, -1);
        for (const s of after.scenarioIds) this.addScen(s, 1);
        members = scen = true;
      }
      if (before.type !== after.type) {
        this.typeCounts[before.type]--;
        this.typeCounts[after.type]++;
        members = true;
      }
      if (before.time.due !== after.time.due) {
        this.countDue(before.time.due, -1);
        this.countDue(after.time.due, 1);
        dates = true;
      }
      if (before.collapsed !== after.collapsed) {
        if (after.collapsed) this.collapsedNodes.add(id);
        else this.collapsedNodes.delete(id);
        collapse = true;
      }
      if (before.meta !== after.meta || isRootNode(before) !== isRootNode(after)) {
        const fb = isRootNode(before);
        const fa = isRootNode(after);
        if (fa) this.forecastRoots.add(id);
        else this.forecastRoots.delete(id);
        const ib = isImpactRoot(before);
        const ia = isImpactRoot(after);
        if (ia) this.impactRoots.add(id);
        else this.impactRoots.delete(id);
        if (fb || fa) roots = true;
        if (ib !== ia) flow = true;
      }
    }

    for (const id of info.edges) {
      const before = this.seenE(id);
      const after = doc.edges[id];
      if (before === after) continue;
      content = true;
      visit?.edge?.(id, before, after);
      if (!!before?.collapsed !== !!after?.collapsed) {
        if (after?.collapsed) this.collapsedEdges.add(id);
        else this.collapsedEdges.delete(id);
        collapse = true;
      }
      if (before && after && before.source === after.source && before.target === after.target) {
        // 両端が同じ書き換え: 並びは変わらない（関係・シナリオだけを直す）
        const slot = this.edgeSeq.get(id)!;
        this.edgeAt[slot] = after;
        if (before.relation !== after.relation) {
          topo = true;
          if (isFlowEdge(before) !== isFlowEdge(after) && after.source !== after.target) flow = true;
        }
        if (!sameList(before.scenarioIds, after.scenarioIds)) {
          scen = members = true;
          if (this.edgeLinked[slot]) {
            for (const s of before.scenarioIds) this.addScen(s, -1);
            for (const s of after.scenarioIds) this.addScen(s, 1);
          }
        }
        continue;
      }
      if (before && this.unlink(before)) {
        topo = members = true;
        if (isFlowEdge(before) && before.source !== before.target) flow = true;
        if (before.scenarioIds.length) scen = true;
      }
      if (!before && after) {
        this.edgeSeq.set(id, this.edgeAt.length);
        this.edgeAt.push(after);
        this.edgeLinked.push(false);
        this.edgeCount++;
        members = true;
      } else if (before && !after) {
        const slot = this.edgeSeq.get(id)!;
        this.edgeAt[slot] = undefined;
        this.edgeLinked[slot] = false;
        this.edgeSeq.delete(id);
        this.edgeCount--;
        members = true;
      }
      if (after) {
        this.edgeAt[this.edgeSeq.get(id)!] = after;
        if (this.link(after, false)) {
          topo = members = true;
          if (isFlowEdge(after) && after.source !== after.target) flow = true;
          if (after.scenarioIds.length) scen = true;
        }
      }
    }

    // プロジェクトの所属が変わったノードの線: プロジェクト間かを見直す
    for (const id of projMoved) {
      for (const list of [this.out.get(id), this.inc.get(id)]) {
        for (const eid of list ?? []) {
          const e = this.seenE(eid);
          if (!e) continue;
          const a = doc.nodes[e.source];
          const b = doc.nodes[e.target];
          const was = this.cross.has(eid);
          const now = !!a && !!b && isCross(a, b);
          if (was !== now) {
            if (now) this.cross.add(eid);
            else this.cross.delete(eid);
            members = true;
          }
        }
      }
    }

    if (topo) v.topo++;
    if (flow) v.flow++;
    if (members) v.members++;
    if (dates) v.dates++;
    if (roots) v.roots++;
    if (scen) v.scen++;
    if (collapse) v.collapse++;
    if (content) v.content++;
  }

  /** 前に見たノード（変わったかを比べる元。索引を直した後は今の物） */
  seenNode(id: ID): GNode | undefined {
    return this.seenN(id);
  }

  seenEdge(id: ID): GEdge | undefined {
    return this.seenE(id);
  }

  // ------------------------------------------------------------ 中で使う

  private addNodeFields(n: GNode, building: boolean): void {
    this.addProjects(n, building);
    this.countTags(n, 1);
    for (const s of n.scenarioIds) this.addScen(s, 1);
    this.typeCounts[n.type] = (this.typeCounts[n.type] ?? 0) + 1;
    this.countDue(n.time.due, 1);
    if (n.collapsed) this.collapsedNodes.add(n.id);
    if (isRootNode(n)) this.forecastRoots.add(n.id);
    if (isImpactRoot(n)) this.impactRoots.add(n.id);
  }

  private removeNodeFields(n: GNode): void {
    this.removeProjects(n);
    this.countTags(n, -1);
    for (const s of n.scenarioIds) this.addScen(s, -1);
    this.typeCounts[n.type]--;
    this.countDue(n.time.due, -1);
    this.collapsedNodes.delete(n.id);
    this.forecastRoots.delete(n.id);
    this.impactRoots.delete(n.id);
  }

  private addProjects(n: GNode, building: boolean): void {
    const id = n.id;
    if (n.projectIds.length === 0) {
      if (building) this.unassigned.push(id);
      else insertBySeq(this.unassigned, id, this.nodeSeq);
      return;
    }
    for (const p of n.projectIds) {
      let list = this.projectNodes.get(p);
      if (!list) this.projectNodes.set(p, (list = []));
      if (building) list.push(id);
      else insertBySeq(list, id, this.nodeSeq);
    }
    if (n.projectIds.length > 1) {
      this.shared.add(id);
      for (const p of n.projectIds) this.sharedIn.set(p, (this.sharedIn.get(p) ?? 0) + 1);
    }
  }

  private removeProjects(n: GNode): void {
    const id = n.id;
    if (n.projectIds.length === 0) {
      removeOne(this.unassigned, id);
      return;
    }
    for (const p of n.projectIds) {
      removeOne(this.projectNodes.get(p), id);
      this.fixProjectKey(p);
    }
    if (n.projectIds.length > 1) {
      this.shared.delete(id);
      for (const p of n.projectIds) {
        const c = (this.sharedIn.get(p) ?? 0) - 1;
        if (c > 0) this.sharedIn.set(p, c);
        else this.sharedIn.delete(p);
      }
    }
  }

  /** プロジェクトの一覧のキー: 並びにあれば空でも持つ。並びに無く、どのノードも属さなければ外す（buildIndex と同じ） */
  private fixProjectKey(pid: ID): void {
    const listed = this.doc.projectOrder.includes(pid);
    const list = this.projectNodes.get(pid);
    if (listed && !list) this.projectNodes.set(pid, []);
    else if (!listed && list && list.length === 0) this.projectNodes.delete(pid);
  }

  private fixScenarioKey(sid: ID): void {
    const listed = this.doc.scenarioOrder.includes(sid);
    const c = this.scenarioCounts.get(sid);
    if (listed && c === undefined) this.scenarioCounts.set(sid, 0);
    else if (!listed && c === 0) this.scenarioCounts.delete(sid);
  }

  private addScen(sid: ID, d: number): void {
    const c = (this.scenarioCounts.get(sid) ?? 0) + d;
    this.scenarioCounts.set(sid, c);
    if (c === 0) this.fixScenarioKey(sid);
  }

  private countTags(n: GNode, d: number): void {
    this.countTagList(n.tags, d);
  }

  /** タグの並びを d 回分数える（同じ並びのノードがいくつもあるときはまとめて） */
  private countTagList(tags: readonly string[], d: number): void {
    if (!tags.length) return;
    for (const t of tags) {
      const key = t.toLowerCase();
      let by = this.tagCount.get(key);
      if (!by) this.tagCount.set(key, (by = new Map()));
      const c = (by.get(t) ?? 0) + d;
      if (c > 0) by.set(t, c);
      else by.delete(t);
      if (!by.size) this.tagCount.delete(key);
    }
    this.tagList = null;
  }

  private countDue(due: string | null, d: number): void {
    if (!due) return;
    const day = this.day(due);
    const c = (this.dueCount.get(day) ?? 0) + d;
    if (c > 0) this.dueCount.set(day, c);
    else this.dueCount.delete(day);
    const mm = this.dueMinMax;
    if (this.dueStale || !Number.isFinite(day)) return;
    if (d > 0) {
      if (!mm) this.dueMinMax = { min: day, max: day };
      else {
        if (day < mm.min) mm.min = day;
        if (day > mm.max) mm.max = day;
      }
    } else if (c <= 0 && mm && (day === mm.min || day === mm.max)) this.dueStale = true;
  }

  /** 線を索引に入れる（両端のノードがあるときだけ。buildIndex と同じ）。入れたら true */
  private link(e: GEdge, building: boolean): boolean {
    const os = this.out.get(e.source);
    const is = this.inc.get(e.target);
    if (!os || !is) return false;
    if (building) {
      os.push(e.id);
      is.push(e.id);
    } else {
      insertBySeq(os, e.id, this.edgeSeq);
      insertBySeq(is, e.id, this.edgeSeq);
    }
    this.edgeLinked[this.edgeSeq.get(e.id)!] = true;
    const a = this.doc.nodes[e.source]!;
    const b = this.doc.nodes[e.target]!;
    if (isCross(a, b)) this.cross.add(e.id);
    for (const s of e.scenarioIds) this.addScen(s, 1);
    return true;
  }

  /** 線を索引から外す（入っていなければ何もしない）。外したら true */
  private unlink(e: GEdge): boolean {
    const slot = this.edgeSeq.get(e.id);
    if (slot === undefined || !this.edgeLinked[slot]) return false;
    this.edgeLinked[slot] = false;
    removeOne(this.out.get(e.source), e.id);
    removeOne(this.inc.get(e.target), e.id);
    this.cross.delete(e.id);
    for (const s of e.scenarioIds) this.addScen(s, -1);
    return true;
  }
}
