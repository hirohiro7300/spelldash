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

/** オブジェクトの鍵として数の順に並ぶ ID（配列の番号の形: 0〜2^32−2 の数の文字） */
export function isIndexKey(id: string): boolean {
  return /^(0|[1-9]\d{0,9})$/.test(id) && Number(id) < 4294967295;
}

/** 全部の入れ替えを、変わった物の一覧にした物（DocIndex.diffDoc） */
export interface DocDiff {
  /** 中身が違う・足した・消したノードと線、中身が違うプロジェクト・シナリオ */
  nodes: Set<ID>;
  edges: Set<ID>;
  projects: Set<ID>;
  scenarios: Set<ID>;
  /** 物だけ新しく中身が同じノード・線（新しい物）と、その索引の番号（rebase が覚えた物を替える） */
  sameNodes: GNode[];
  sameNodeSlots: number[];
  sameEdges: GEdge[];
  sameEdgeSlots: number[];
}

/** 文字の並びが同じ */
function sameStrs(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * ノードの中身が同じ（決まった所は 1 つずつ、time・conditions・meta は中まで。全部の入れ替えの比べ: 型の決まった所を順に読むので、
 * 何でも比べる sameContent の半分ほどの時間）
 */
export function sameNode(a: GNode, b: GNode): boolean {
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.type === b.type &&
    a.status === b.status &&
    a.title === b.title &&
    a.body === b.body &&
    Object.is(a.x, b.x) &&
    Object.is(a.y, b.y) &&
    a.collapsed === b.collapsed &&
    a.updatedAt === b.updatedAt &&
    a.createdAt === b.createdAt &&
    sameStrs(a.tags, b.tags) &&
    sameStrs(a.projectIds, b.projectIds) &&
    sameStrs(a.scenarioIds, b.scenarioIds) &&
    sameContent(a.time, b.time) &&
    sameContent(a.conditions, b.conditions) &&
    sameContent(a.meta, b.meta)
  );
}

/** 線の中身が同じ（sameNode と同じ考え） */
export function sameEdge(a: GEdge, b: GEdge): boolean {
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.source === b.source &&
    a.target === b.target &&
    a.relation === b.relation &&
    a.label === b.label &&
    a.condition === b.condition &&
    a.collapsed === b.collapsed &&
    a.updatedAt === b.updatedAt &&
    a.createdAt === b.createdAt &&
    sameStrs(a.scenarioIds, b.scenarioIds) &&
    sameContent(a.meta, b.meta)
  );
}

/**
 * 中身が同じ（値は Object.is、配列とオブジェクトは中まで・深さ 8 段まで）。物を作らない（7 万枚の取り込みで 1 枚ずつ呼ぶ）
 */
export function sameContent(a: unknown, b: unknown, depth = 8): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return Object.is(a, b);
  if (depth <= 0) return false;
  const arr = Array.isArray(a);
  if (arr !== Array.isArray(b)) return false;
  if (arr) {
    const x = a as unknown[];
    const y = b as unknown[];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!sameContent(x[i], y[i], depth - 1)) return false;
    return true;
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  let n = 0;
  for (const k in ra) {
    if (!(k in rb) || !sameContent(ra[k], rb[k], depth - 1)) return false;
    n++;
  }
  for (const _ in rb) n--;
  return n === 0;
}

/**
 * 2 つの表で、中身が違う・片方にしか無い鍵（プロジェクト・シナリオ。数は小さいので中身を 1 段比べる。取り込みの写しは物がどれも
 * 新しいが、中身が同じなら変わっていない: シナリオが変わったと見ると 3 年の影響を計算し直す）
 */
function diffKeys<T>(a: Record<ID, T>, b: Record<ID, T>): Set<ID> {
  const out = new Set<ID>();
  for (const id in a) if (a[id] !== b[id] && !sameContent(a[id], b[id])) out.add(id);
  for (const id in b) if (!(id in a)) out.add(id);
  return out;
}


/**
 * ノード → 線の ID の並び（出る線・入る線）。Map と同じ読み口で、ノードのキーの順の番号の表（DocIndex の nodeSeq）で番号を引き、
 * 番号ごとの配列に持つ（7.7 万枚で、同じ鍵の Map を 2 つ持たない: 3.5 MB。作り直しでも 15 万回の Map への書き込みをしない: P4）。
 * 鍵の順は番号の表に入れた順（DocIndex は番号の表と並びを同じ所で足し・消すので、Map に入れた順と同じ）。
 * 番号の表に無いノードには入れない（DocIndex は先に番号を振る）。DocIndex は作り直しで番号の表を新しくする（前の表を振り直さない）ので、
 * 作り直しの前に受け取った物は前の文書の並びを引き続ける
 */
export class SeqLists implements Map<ID, ID[]> {
  private count = 0;
  constructor(
    private readonly seq: Map<ID, number>,
    private lists: Array<ID[] | undefined> = [],
    count = 0,
  ) {
    this.count = count;
  }

  get size(): number {
    return this.count;
  }

  get(id: ID): ID[] | undefined {
    const i = this.seq.get(id);
    return i === undefined ? undefined : this.lists[i];
  }

  has(id: ID): boolean {
    return this.get(id) !== undefined;
  }

  set(id: ID, list: ID[]): this {
    const i = this.seq.get(id);
    if (i === undefined) throw new Error(`索引の番号が無いノードです: ${id}`);
    if (this.lists[i] === undefined) this.count++;
    this.lists[i] = list;
    return this;
  }

  delete(id: ID): boolean {
    const i = this.seq.get(id);
    if (i === undefined || this.lists[i] === undefined) return false;
    this.lists[i] = undefined;
    this.count--;
    return true;
  }

  clear(): void {
    this.lists = [];
    this.count = 0;
  }

  *entries(): MapIterator<[ID, ID[]]> {
    for (const [id, i] of this.seq) {
      const l = this.lists[i];
      if (l !== undefined) yield [id, l];
    }
  }

  *keys(): MapIterator<ID> {
    for (const [id, i] of this.seq) if (this.lists[i] !== undefined) yield id;
  }

  *values(): MapIterator<ID[]> {
    for (const i of this.seq.values()) {
      const l = this.lists[i];
      if (l !== undefined) yield l;
    }
  }

  [Symbol.iterator](): MapIterator<[ID, ID[]]> {
    return this.entries();
  }

  forEach(cb: (value: ID[], key: ID, map: Map<ID, ID[]>) => void, thisArg?: unknown): void {
    for (const [k, v] of this.entries()) cb.call(thisArg, v, k, this);
  }

  get [Symbol.toStringTag](): string {
    return "SeqLists";
  }
}

export class DocIndex implements GraphIndex {
  /** ノード → 出る線・入る線（両端のノードがある線だけ。キーの順の番号の表 nodeSeq で引く: SeqLists） */
  out: Map<ID, ID[]>;
  inc: Map<ID, ID[]>;
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
  private nodeSeq = new Map<ID, number>();
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
    this.out = new SeqLists(this.nodeSeq);
    this.inc = new SeqLists(this.nodeSeq);
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

  /** ノードの ID（文書の順。キーの順の番号の順と同じ） */
  nodeIds(): IterableIterator<ID> {
    return this.nodeSeq.keys();
  }

  /** 線のキーの順の番号。無ければ −1 */
  edgeOrder(id: ID): number {
    return this.edgeSeq.get(id) ?? -1;
  }

  /** 全部を作り直す（buildIndex と同じ並び） */
  rebuild(doc: DocData): void {
    this.doc = doc;
    this.projectNodes = new Map();
    this.unassigned = [];
    this.drops.clear();
    this.dropKeys.clear();
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
    // 番号の表は入れ替える（中で振り直さない）: 作り直しの前に受け取った出る線・入る線（SeqLists）は前の表と前の並びを持ち続け、
    // 前の文書を正しく引く（Map だった時と同じ。予測の組み立てが止まりながら持つ: 見直し data-1）
    this.nodeSeq = new Map();
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
    // キーを 1 回だけ数え、値はキーで引く（Object.values は 7 万の鍵の入れ物では Object.keys の 2〜3 倍遅い: 見直し perf-1）
    const nodesRec = doc.nodes;
    const nkeys = Object.keys(nodesRec);
    for (let i = 0; i < nkeys.length; i++) {
      const id = nkeys[i]!;
      const n = nodesRec[id]!;
      this.nodeSeq.set(id, i);
      nodeAt.push(n);
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
    // 出る線・入る線の並びは、先に数えてちょうどの長さで作る（空の配列に 1 つ足すと 16 個分の場所を取る: 7.7 万枚で 2 つの並びが 17 MB。
    // ちょうどの長さなら 5 MB ほど: 見直し perf-6）。並びの中は今までどおり線のキーの順
    const edgesRec = doc.edges;
    const ekeys = Object.keys(edgesRec);
    const N = nkeys.length;
    const ea = new Int32Array(ekeys.length);
    const eb = new Int32Array(ekeys.length);
    const outN = new Int32Array(N);
    const incN = new Int32Array(N);
    for (let k = 0; k < ekeys.length; k++) {
      const e = edgesRec[ekeys[k]!]!;
      const a = this.nodeSeq.get(e.source);
      const b = this.nodeSeq.get(e.target);
      if (a === undefined || b === undefined) {
        ea[k] = -1;
        continue;
      }
      ea[k] = a;
      eb[k] = b;
      outN[a]!++;
      incN[b]!++;
    }
    // 番号 i のノードの並び（番号の表 nodeSeq は上で i を振った: そのまま SeqLists の番号ごとの配列にする）
    const outL: ID[][] = new Array(N);
    const incL: ID[][] = new Array(N);
    for (let i = 0; i < N; i++) {
      outL[i] = outN[i] ? new Array<ID>(outN[i]!) : [];
      incL[i] = incN[i] ? new Array<ID>(incN[i]!) : [];
    }
    this.out = new SeqLists(this.nodeSeq, outL, N);
    this.inc = new SeqLists(this.nodeSeq, incL, N);
    outN.fill(0);
    incN.fill(0);
    const edgeAt = this.edgeAt;
    const linked = this.edgeLinked;
    /** プロジェクト間か（所属の配列の組ごとに覚える） */
    const crossMemo = new Map<ID[], Map<ID[], boolean>>();
    for (let k = 0; k < ekeys.length; k++) {
      const id = ekeys[k]!;
      const e = edgesRec[id]!;
      this.edgeSeq.set(id, k);
      edgeAt.push(e);
      if (e.collapsed) this.collapsedEdges.add(id);
      const a = ea[k]!;
      if (a < 0) {
        linked.push(false);
        continue;
      }
      const b = eb[k]!;
      linked.push(true);
      outL[a]![outN[a]!++] = id;
      incL[b]![incN[b]!++] = id;
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
   * 全部の入れ替え（取り込み・読み込み・入れ替えの元に戻す）を、変わった物の一覧にする（見直し perf-4）。新しい文書の鍵を順に見て、
   * 索引が覚えた物と物が違うノード・線は中身を 1 度だけ比べ、中身が違う・足した・消した物（nodes・edges）と、物だけ新しく中身が同じ物
   * （sameNodes・sameEdges: 覚えた物を替えるだけ）に分ける。プロジェクト・シナリオは中身が違う物。O(ノード + 線)。
   * 変わった物だけ直しても作り直した並びと同じにならない（鍵の順が替わった・足した鍵の後に前からの鍵がある・数の形の鍵を足した・
   * プロジェクトかシナリオの並びが替わった）か、足した・消した物が半分より多いときは null（作り直す）
   */
  diffDoc(doc: DocData): DocDiff | null {
    const prev = this.doc;
    if (prev === doc) return null;
    // プロジェクト・シナリオの並びが替わった: 一覧の鍵の並びが作り直した物と違うので作り直す（小さいので比べてもすぐ）
    if (!sameList(prev.projectOrder, doc.projectOrder) || !sameList(prev.scenarioOrder, doc.scenarioOrder)) return null;
    const nodes = this.diffColl(doc.nodes, this.nodeAt, this.nodeSeq, this.nodeCount, sameNode);
    if (!nodes) return null;
    const edges = this.diffColl(doc.edges, this.edgeAt, this.edgeSeq, this.edgeCount, sameEdge);
    if (!edges) return null;
    return {
      nodes: nodes.changed,
      edges: edges.changed,
      projects: diffKeys(prev.projects, doc.projects),
      scenarios: diffKeys(prev.scenarios, doc.scenarios),
      sameNodes: nodes.same,
      sameNodeSlots: nodes.slots,
      sameEdges: edges.same,
      sameEdgeSlots: edges.slots,
    };
  }

  /** ノードか線の一覧の差（diffDoc。並びが合わなければ null） */
  private diffColl<T>(next: Record<ID, T>, at: ReadonlyArray<T | undefined>, seq: ReadonlyMap<ID, number>, count: number, same1: (a: T, b: T) => boolean): { changed: Set<ID>; same: T[]; slots: number[] } | null {
    const changed = new Set<ID>();
    const same: T[] = [];
    const slots: number[] = [];
    let last = -1;
    let added = false;
    let kept = 0;
    let total = 0;
    // 全体を見てよい: 全部の入れ替えのときに 1 回（変わった物の一覧を作る。作り直しより軽い）
    for (const id in next) {
      total++;
      const slot = seq.get(id);
      if (slot === undefined) {
        // 足した鍵（並びの後ろに入る）。数の形の鍵は、オブジェクトの順の前の方に入るので作り直す
        if (isIndexKey(id)) return null;
        added = true;
        changed.add(id);
        continue;
      }
      // 前からの鍵が、足した鍵の後・前の並びより前にある: 作り直した並びと違う
      if (added || slot < last) return null;
      last = slot;
      kept++;
      const now = next[id]!;
      const old = at[slot];
      if (old === now) continue;
      if (old !== undefined && same1(old, now)) {
        same.push(now);
        slots.push(slot);
      } else changed.add(id);
    }
    const removed = count - kept;
    if (removed > 0) for (const id of seq.keys()) if (!(id in next)) changed.add(id);
    // 大きく入れ替わった（別の文書を読み込んだ など）: 作り直す方が軽く、確か
    if ((total - kept + removed) * 2 > Math.max(total, count, 1)) return null;
    return { changed, same, slots };
  }

  /**
   * 全部の入れ替えを、diffDoc の一覧で直す（前の文書と同じ並び・同じ数えになる。visit は apply と同じで、中身の違う物だけに呼ぶ）。
   * 中身が同じで物だけ違うノード・線は、覚えた物を新しい物に替えるだけ（前の文書の物を持ち続けない）
   */
  rebase(doc: DocData, diff: DocDiff, visit?: IndexVisitor): void {
    this.doc = doc;
    for (let k = 0; k < diff.sameNodes.length; k++) this.nodeAt[diff.sameNodeSlots[k]!] = diff.sameNodes[k];
    for (let k = 0; k < diff.sameEdges.length; k++) this.edgeAt[diff.sameEdgeSlots[k]!] = diff.sameEdges[k];
    this.apply(doc, { full: false, nodes: diff.nodes, edges: diff.edges, projects: diff.projects, scenarios: diff.scenarios }, visit);
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
    // 数の形の ID（"1"・"2"。読み込みが受ける）は、足すとオブジェクトの順の前の方（数の順）に入る。後ろに足す並びとは違うので、
    // 変わった所を直した後（visit は呼ぶ）、並びを作り直す（見直し equiv-7）
    let reorder = false;
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
        if (isIndexKey(id)) reorder = true;
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

    // まとめた一覧から外す物を外す（線の所はプロジェクトの一覧を読む）
    this.flushDrops();
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
        if (isIndexKey(id)) reorder = true;
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
    if (reorder) this.rebuild(doc);
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
    // 外す物が残っていれば先に外す（並びの番号で入れる所を探す: 外したノードの番号はもう無い）
    this.flushDrops();
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

  /**
   * 一覧（未分類・プロジェクトごと。8 万の ID になる）から外すのは、1 回の変更の中でまとめる（dropLater → flushDrops）。1 つずつ
   * lastIndexOf と splice で外すと O(消す数 × 一覧) になり、8 千枚の枝を消すと机で 7 秒ほど止まった（見直し speed-docindex-removeone）
   */
  private readonly drops = new Map<ID[], Set<ID>>();
  private readonly dropKeys = new Set<ID>();

  private dropLater(list: ID[] | undefined, id: ID): void {
    if (!list) return;
    // 一番後ろ（足したばかりのカードを消す: Tab の元に戻す）はすぐ外す
    if (list[list.length - 1] === id && !this.drops.has(list)) {
      list.pop();
      return;
    }
    let set = this.drops.get(list);
    if (!set) this.drops.set(list, (set = new Set()));
    set.add(id);
  }

  /** まとめた外す物を、一覧ごとに 1 回で外す（一覧に足す前・変更の終わりに） */
  private flushDrops(): void {
    if (this.drops.size) {
      for (const [list, set] of this.drops) {
        if (set.size === 1) {
          for (const id of set) removeOne(list, id);
          continue;
        }
        let w = 0;
        for (let r = 0; r < list.length; r++) {
          const x = list[r]!;
          if (!set.has(x)) list[w++] = x;
        }
        list.length = w;
      }
      this.drops.clear();
    }
    if (this.dropKeys.size) {
      for (const p of this.dropKeys) this.fixProjectKey(p);
      this.dropKeys.clear();
    }
  }

  private removeProjects(n: GNode): void {
    const id = n.id;
    if (n.projectIds.length === 0) {
      this.dropLater(this.unassigned, id);
      return;
    }
    for (const p of n.projectIds) {
      this.dropLater(this.projectNodes.get(p), id);
      this.dropKeys.add(p);
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
