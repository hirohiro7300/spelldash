// 見え方の計算（./viewModel.ts）の「3 年の分かれ道の範囲」（幅優先の順の番号）と「先が木か・その大きさ」を、葉のカードを足す・消すだけの
// 変更で、8 万枚をたどり直さずに直す（作業メモ SPEC v1 §7.1 の 5・6、perf-4: 地図の中の形の編集 = Tab・その元に戻す・行き先を消す）。
//
// 答えは最初から作った物と番号まで同じ（tests/unit/viewModel.test.ts・viewModelSlow.test.ts が比べる）:
//   幅優先の順では、入口ごとのかたまりの中で、ノードは「たどった親の番号・親の出る線の中の、たどった線の場所」の順に並ぶ。
//   葉 v を親 u の線 e で足すと、v は u の子のうち e より前の線でたどった子の後ろに入り、ほかの並びは変わらない。消すときはその逆。
//   先の大きさ・木か（treeAt）は、変わったノードと、そのたどった親を上へ、値が変わらなくなるまで入れ直す（値はたどった子だけで決まる）。
// 入口・合流・葉でないカード・ほかの線の付け替えなどに関わる変更はここでは扱わない（null を返し、呼び手が最初から作る）。

import { isFlowEdge, isImpactRoot } from "../model/forks";
import type { DocData, GEdge, GNode, ID } from "../model/types";

/**
 * 3 年の分かれ道の範囲（道の線の版ごとに作り直す）。入口（ID の順）から道の線で幅優先にたどった順に番号（pos）を振る。
 * 範囲のノード → それをたどった入口・入口から何歩目か・たどった親とその線
 */
export interface ImpactScopeInfo {
  flow: number;
  /** 入口（ID の順） */
  roots: ID[];
  /** 範囲のノード → 幅優先の順の番号 */
  pos: Map<ID, number>;
  /** 番号 → ノード */
  order: ID[];
  /** 番号 → それをたどった入口（roots の添え字） */
  rootOf: Int32Array;
  /** 番号 → 入口から何歩目か（いちばん短い道） */
  depth: Int32Array;
  /** 番号 → たどった親の番号（入口は −1） */
  parent: Int32Array;
  /** 番号 → たどった親からの線（入口は ""） */
  parentEdge: ID[];
  /** 組み立てたままの地図の形から作った（番号は地図の深さ優先の順。幅優先の順ではないので、ここでは直さない） */
  fromMap?: boolean;
}

/** 範囲のカードの先が木かと、その大きさ（形の版ごと。閉じたカードの件数を、たどらずに出す） */
export interface TreeInfo {
  key: string;
  /** 自分を含む先の数（たどった親子の木で） */
  size: Int32Array;
  /** 先が木: 止める線の先がどれも、自分がたどった子で、入る線が 1 本・出る線が木の線だけ、その先も木 */
  clean: Uint8Array;
  /** 入る線が 1 本で、出る線がどれも木の線 */
  regular: Uint8Array;
}

/** 文書の索引の線（ノード → 出る線・入る線の ID。両端のノードがある線だけ） */
export interface IndexLinks {
  readonly out: Map<ID, ID[]>;
  readonly inc: Map<ID, ID[]>;
}

/**
 * 範囲の番号 p のノードの先の大きさ・木か（treeInfo の 1 つ分。子（p より後ろの番号）の値は入っていること）。
 * 範囲のノードの、たどった親子の木での値を、size・clean・regular の p に書く
 */
export function treeAt(doc: DocData, idx: IndexLinks, info: ImpactScopeInfo, t: { size: Int32Array; clean: Uint8Array; regular: Uint8Array }, p: number): void {
  const u = info.order[p]!;
  // 入る線の数（自分への線を除く。自分への線は出る線でも数えるので、そこで引く）
  let inDeg = idx.inc.get(u)?.length ?? 0;
  let reg = true;
  let cl = true;
  let sz = 1;
  for (const eid of idx.out.get(u) ?? []) {
    const e = doc.edges[eid];
    if (!e) continue;
    if (e.target === u) {
      inDeg--;
      continue;
    }
    const q = info.pos.get(e.target);
    const isTree = q !== undefined && info.parent[q] === p;
    if (!isTree) reg = false;
    const stop = isFlowEdge(e) && q !== undefined && info.rootOf[q] === info.rootOf[p];
    if (stop) {
      if (!isTree || !t.regular[q!] || !t.clean[q!]) cl = false;
      else sz += t.size[q!]!;
    }
  }
  t.size[p] = sz;
  t.clean[p] = cl ? 1 : 0;
  t.regular[p] = reg && inDeg === 1 ? 1 : 0;
}

/** 1 回の変更の、足した・消した物（索引が受けた変更の前と後） */
export interface StructDelta {
  addN: GNode[];
  delN: GNode[];
  addE: GEdge[];
  delE: GEdge[];
  /** ほかの形の変更（線の付け替え・道の線かが変わった・入口の印が変わった）があった */
  other: boolean;
}

export const emptyDelta = (): StructDelta => ({ addN: [], delN: [], addE: [], delE: [], other: false });

/** 範囲・木の直した物と、自分のノード（範囲の外）が変わらないか */
export interface ScopePatch {
  info: ImpactScopeInfo;
  tree: TreeInfo | null;
  /** 範囲の外のノードとその線が変わらない（自分のノードの入口をそのまま使える） */
  usersSame: boolean;
}

/** 番号 lo 以上 hi 未満で、pred が初めて true になる所（pred は単調: false… true…）。無ければ hi */
function firstTrue(lo: number, hi: number, pred: (i: number) => boolean): number {
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (pred(m)) hi = m;
    else lo = m + 1;
  }
  return lo;
}

/** 番号 p の入口のかたまりの終わり（次のかたまりの最初の番号） */
function segEnd(rootOf: Int32Array, p: number): number {
  const r = rootOf[p]!;
  return firstTrue(p + 1, rootOf.length, (i) => rootOf[i]! > r);
}

/** 道の線か（範囲の幅優先と同じ選び方: 道の線で、自分への線でない） */
const flowTo = (e: GEdge | undefined, from: ID): e is GEdge => !!e && isFlowEdge(e) && e.target !== from;

interface Work {
  order: ID[];
  rootOf: Int32Array;
  depth: Int32Array;
  parent: Int32Array;
  parentEdge: ID[];
  size: Int32Array | null;
  clean: Uint8Array | null;
  regular: Uint8Array | null;
}

function splice<A extends Int32Array | Uint8Array>(make: (n: number) => A, a: A, at: number, add: boolean, v = 0): A {
  const out = make(a.length + (add ? 1 : -1));
  out.set(a.subarray(0, at), 0);
  if (add) {
    out[at] = v;
    out.set(a.subarray(at), at + 1);
  } else out.set(a.subarray(at + 1), at);
  return out;
}

/** 葉を番号 q に足す（親 pu・線 eid）。親の番号のずれも直す */
function insertAt(w: Work, q: number, id: ID, pu: number, eid: ID): void {
  w.order.splice(q, 0, id);
  w.parentEdge.splice(q, 0, eid);
  const I32 = (n: number) => new Int32Array(n);
  const U8 = (n: number) => new Uint8Array(n);
  w.rootOf = splice(I32, w.rootOf, q, true, w.rootOf[pu]!);
  w.depth = splice(I32, w.depth, q, true, w.depth[pu]! + 1);
  const parent = splice(I32, w.parent, q, true, pu);
  for (let i = q + 1; i < parent.length; i++) if (parent[i]! >= q) parent[i]!++;
  w.parent = parent;
  if (w.size) {
    w.size = splice(I32, w.size, q, true, 1);
    w.clean = splice(U8, w.clean!, q, true, 1);
    w.regular = splice(U8, w.regular!, q, true, 0);
  }
}

/** 番号 j（子の無い葉）を除く */
function removeAt(w: Work, j: number): void {
  w.order.splice(j, 1);
  w.parentEdge.splice(j, 1);
  const I32 = (n: number) => new Int32Array(n);
  const U8 = (n: number) => new Uint8Array(n);
  w.rootOf = splice(I32, w.rootOf, j, false);
  w.depth = splice(I32, w.depth, j, false);
  const parent = splice(I32, w.parent, j, false);
  for (let i = j; i < parent.length; i++) if (parent[i]! > j) parent[i]!--;
  w.parent = parent;
  if (w.size) {
    w.size = splice(I32, w.size, j, false);
    w.clean = splice(U8, w.clean!, j, false);
    w.regular = splice(U8, w.regular!, j, false);
  }
}

/** 今の並びの info（pos は並びから作り直す） */
function infoOf(w: Work, roots: ID[], flow: number): ImpactScopeInfo {
  const pos = new Map<ID, number>();
  for (let i = 0; i < w.order.length; i++) pos.set(w.order[i]!, i);
  return { flow, roots, pos, order: w.order, rootOf: w.rootOf, depth: w.depth, parent: w.parent, parentEdge: w.parentEdge };
}

/**
 * 葉を足しただけ・消しただけの変更（delta）の後の範囲と木を、前の物（info・tree）から作る。直せない変更なら null。
 * doc と idx は変更の後の物（索引は直した後）。flow・treeKey は新しい版
 */
export function patchScope(doc: DocData, idx: IndexLinks, info: ImpactScopeInfo, tree: TreeInfo | null, d: StructDelta, flow: number, treeKey: string): ScopePatch | null {
  const adding = d.addE.length > 0 || d.addN.length > 0;
  const removing = d.delE.length > 0 || d.delN.length > 0;
  if (d.other || (adding && removing) || (!adding && !removing)) return null;
  const w: Work = {
    order: info.order.slice(),
    rootOf: info.rootOf,
    depth: info.depth,
    parent: info.parent,
    parentEdge: info.parentEdge.slice(),
    size: tree ? tree.size : null,
    clean: tree ? tree.clean : null,
    regular: tree ? tree.regular : null,
  };
  /** 入れ直すノード（ID。番号はずれていくので） */
  const dirty = new Set<ID>();
  let usersSame = true;
  if (adding) {
    const newIds = new Set(d.addN.map((n) => n.id));
    // 足した線は、範囲のノードから足したノードへの道の線だけ（足したノードには、その線 1 本だけが入る）
    for (const e of d.addE) if (!flowTo(e, e.source) || !newIds.has(e.target) || newIds.has(e.source) || info.pos.has(e.target)) return null;
    for (const n of d.addN) {
      if (isImpactRoot(n)) return null;
      const inc = idx.inc.get(n.id) ?? [];
      const ins = d.addE.filter((e) => e.target === n.id).length;
      // 範囲の外に足したノード（線の無い自分のノード）: 範囲は変わらないが、自分のノードは変わる
      if (!ins) {
        if (inc.length || (idx.out.get(n.id) ?? []).length) return null;
        usersSame = false;
        continue;
      }
      // 葉: 入る線はその 1 本、出る線は無い（足したノードから先へ線を出すのは、最初から作る）
      if (ins !== 1 || inc.length !== 1 || (idx.out.get(n.id) ?? []).length) return null;
    }
    /** 足した番号（足した順）。前からあるノードの今の番号 = 前の番号 + その前に足した数 */
    const at: number[] = [];
    const posNow = (p0: number): number => {
      let p = p0;
      for (const q of at) if (p >= q) p++;
      return p;
    };
    for (const e of d.addE) {
      const p0 = info.pos.get(e.source);
      if (p0 === undefined) return null;
      const pu = posNow(p0);
      // u の子（u がたどった子）のうち、e より前の線でたどった物の後ろ
      const outs = idx.out.get(e.source) ?? [];
      const k = outs.indexOf(e.id);
      if (k < 0) return null;
      const end = segEnd(w.rootOf, pu);
      const c0 = firstTrue(pu + 1, end, (i) => w.parent[i]! >= pu);
      const c1 = firstTrue(c0, end, (i) => w.parent[i]! > pu);
      let q = c0;
      for (let i = c0; i < c1; i++) {
        const ki = outs.indexOf(w.parentEdge[i]!);
        if (ki < 0) return null;
        if (ki < k) q = i + 1;
        else break;
      }
      insertAt(w, q, e.target, pu, e.id);
      at.push(q);
      dirty.add(e.source);
      dirty.add(e.target);
    }
  } else {
    const gone = new Set<ID>();
    for (const n of d.delN) {
      // 範囲の外のノード（自分のノード）を消した: 範囲は変わらないが、自分のノードは変わる
      if (!info.pos.has(n.id)) usersSame = false;
      else gone.add(n.id);
    }
    for (const e of d.delE) {
      const sIn = info.pos.has(e.source);
      const tIn = info.pos.has(e.target);
      // 範囲の外どうしの線
      if (!sIn && !tIn) {
        usersSame = false;
        continue;
      }
      // 消すノードへの・からの線: 残る側のノードを入れ直す
      if (gone.has(e.source) || gone.has(e.target)) {
        if (sIn && !gone.has(e.source)) dirty.add(e.source);
        if (tIn && !gone.has(e.target)) dirty.add(e.target);
        if (!sIn || !tIn) usersSame = false;
        continue;
      }
      // 線だけを消した: 範囲の葉へのたどった線なら、その葉が範囲を出る（ほかに範囲から入る道の線が無いこと）
      const q = info.pos.get(e.target);
      if (!sIn || q === undefined || info.parentEdge[q] !== e.id || !flowTo(e, e.source)) return null;
      for (const eid of idx.inc.get(e.target) ?? []) {
        const x = doc.edges[eid];
        if (x && flowTo(x, x.source) && x.source !== e.target && info.pos.has(x.source)) return null;
      }
      gone.add(e.target);
      dirty.add(e.source);
      usersSame = false;
    }
    // 範囲を出るノードは、入口でない・たどった子の無い葉。後ろの番号から除く（前の番号はずれない）
    const list = [...gone].map((id) => info.pos.get(id)!).sort((a, b) => b - a);
    for (const j of list) {
      if (w.parent[j]! < 0) return null;
      const end = segEnd(w.rootOf, j);
      const c = firstTrue(j + 1, end, (i) => w.parent[i]! >= j);
      if (c < end && w.parent[c] === j) return null;
      dirty.add(w.order[w.parent[j]!]!);
      removeAt(w, j);
    }
    for (const id of gone) dirty.delete(id);
  }
  // 範囲の並びが変わらない（範囲の外のノードだけを足した・消した）: 前の物を新しい版で使う（表を作り直さない）
  const same = w.order.length === info.order.length && w.parent === info.parent;
  const cur = same ? { ...info, flow } : infoOf(w, info.roots, flow);
  if (same && tree && !dirty.size) return { info: cur, tree: { ...tree, key: treeKey }, usersSame };
  let tree2: TreeInfo | null = null;
  if (w.size && tree) {
    // 写しに書く（前の木の配列は前の版の物のまま。足した・消したときはもう新しい配列）
    const t = {
      size: w.size === tree.size ? w.size.slice() : w.size,
      clean: w.clean === tree.clean ? w.clean!.slice() : w.clean!,
      regular: w.regular === tree.regular ? w.regular!.slice() : w.regular!,
    };
    // 変わったノードと、値が変わったノードのたどった親を、後ろの番号から（子が先: たどった親は前の番号）
    const first = new Set<number>();
    for (const id of dirty) {
      const p = cur.pos.get(id);
      if (p !== undefined) first.add(p);
    }
    const pending = new Set(first);
    while (pending.size) {
      let p = -1;
      for (const x of pending) if (x > p) p = x;
      pending.delete(p);
      const s = t.size[p];
      const c = t.clean[p];
      const r = t.regular[p];
      treeAt(doc, idx, cur, t, p);
      const up = cur.parent[p]!;
      if (up >= 0 && (first.has(p) || s !== t.size[p] || c !== t.clean[p] || r !== t.regular[p])) pending.add(up);
    }
    tree2 = { key: treeKey, ...t };
  }
  return { info: cur, tree: tree2, usersSame };
}

/**
 * 範囲の集合の読み口（範囲の作りの物をそのまま読む。8 万の ID の集合をもう 1 つ作らない）。並びは幅優先の順（new Set(info.order) と同じ）
 */
export class ScopeSet implements ReadonlySet<ID> {
  constructor(private readonly info: ImpactScopeInfo) {}
  get size(): number {
    return this.info.order.length;
  }
  has(id: ID): boolean {
    return this.info.pos.has(id);
  }
  keys(): SetIterator<ID> {
    return this.info.order[Symbol.iterator]() as SetIterator<ID>;
  }
  values(): SetIterator<ID> {
    return this.keys();
  }
  *entries(): SetIterator<[ID, ID]> {
    for (const id of this.info.order) yield [id, id];
  }
  forEach(fn: (value: ID, key: ID, set: ReadonlySet<ID>) => void, thisArg?: unknown): void {
    for (const id of this.info.order) fn.call(thisArg, id, id, this);
  }
  [Symbol.iterator](): SetIterator<ID> {
    return this.keys();
  }
}
