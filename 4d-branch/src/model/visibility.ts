// 折りたたみと経路の計算。循環・合流があっても破綻しないようにする。設計: docs/DESIGN.md §3.8
//
// 折りたたみ:
//   1. 折りたたんだノードの出る線・折りたたんだ線を「止める線」にする
//   2. 入口から、止める線を通らずにたどれるノードだけを表示する
//      入口 = 入る線の無いノード（「フィードバック」の線は数えない。循環を閉じる線なので、戻られる側は根のまま）
//           ＋ フィードバック以外の線で外から入る線の無い「強連結成分」（循環のかたまり）の中の折りたたみの起点
//      （起点が無い循環は全員を入口にする）→ 循環だけのかたまりでも、折りたたんだノード自身は消えない
//   3. 別の親が見えていれば合流先は消えない（入口からたどれるため）
//   4. 件数 = その起点の先で、隠れているノードだけをたどって届く数（見えている所で止める＝開くと出てくる物）

import type { GraphIndex } from "./graph";
import type { DocData, GEdge, ID } from "./types";

export interface CollapseResult {
  hidden: Set<ID>;
  /** 折りたたみの起点（ノード ID または接続 ID）→ それで隠れた件数 */
  counts: Map<ID, number>;
}

const EMPTY: CollapseResult = { hidden: new Set(), counts: new Map() };

/** 有向グラフの強連結成分（Tarjan・再帰なし）。ノード → 成分番号 */
export function stronglyConnected(nodes: ID[], succ: (id: ID) => ID[]): Map<ID, number> {
  let counter = 0;
  let compCount = 0;
  const index = new Map<ID, number>();
  const low = new Map<ID, number>();
  const onStack = new Set<ID>();
  const stack: ID[] = [];
  const comp = new Map<ID, number>();
  for (const root of nodes) {
    if (index.has(root)) continue;
    const work: Array<{ v: ID; i: number; ns: ID[] }> = [];
    const open = (v: ID) => {
      index.set(v, counter);
      low.set(v, counter);
      counter++;
      stack.push(v);
      onStack.add(v);
      work.push({ v, i: 0, ns: succ(v) });
    };
    open(root);
    while (work.length) {
      const top = work[work.length - 1]!;
      if (top.i < top.ns.length) {
        const w = top.ns[top.i++]!;
        if (!index.has(w)) open(w);
        else if (onStack.has(w)) low.set(top.v, Math.min(low.get(top.v)!, index.get(w)!));
      } else {
        work.pop();
        const parent = work[work.length - 1];
        if (parent) low.set(parent.v, Math.min(low.get(parent.v)!, low.get(top.v)!));
        if (low.get(top.v) === index.get(top.v)) {
          let w: ID;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            comp.set(w, compCount);
          } while (w !== top.v);
          compCount++;
        }
      }
    }
  }
  return comp;
}

interface Block {
  /** 起点の鍵（ノード ID か接続 ID） */
  key: ID;
  /** 起点のノード（循環のかたまりの入口の決まりに使う） */
  node: ID;
}

function adjacency(doc: DocData, index: GraphIndex, scope: Set<ID>, edgeOk: (e: GEdge) => boolean) {
  const outE = new Map<ID, GEdge[]>();
  for (const id of scope) {
    const list: GEdge[] = [];
    for (const eid of index.out.get(id) ?? []) {
      const e = doc.edges[eid];
      if (!e || e.source === e.target || !scope.has(e.target) || !edgeOk(e)) continue;
      list.push(e);
    }
    outE.set(id, list);
  }
  return outE;
}

/** 入口を決めるときに数える線（フィードバック＝循環を閉じる線は数えない。たどるときは通る） */
const countsForEntry = (e: GEdge) => e.relation !== "feedback";

/** 入口から、止める線を通らずにたどれないノードを求める（折りたたみ・シナリオの推定で共通） */
function unreachedCore(scope: Set<ID>, outE: Map<ID, GEdge[]>, blocked: Set<ID>, blocks: Array<Block & { starts: ID[] }>, withCounts: boolean): CollapseResult {
  const indeg = new Map<ID, number>();
  for (const id of scope) indeg.set(id, 0);
  for (const list of outE.values()) for (const e of list) if (countsForEntry(e)) indeg.set(e.target, indeg.get(e.target)! + 1);
  const entries: ID[] = [];
  for (const id of scope) if (indeg.get(id) === 0) entries.push(id);
  const ids = [...scope];
  const comp = stronglyConnected(ids, (v) => outE.get(v)!.filter(countsForEntry).map((e) => e.target));
  const hasOuterIn = new Set<number>();
  for (const [v, list] of outE) {
    const a = comp.get(v)!;
    for (const e of list) {
      if (!countsForEntry(e)) continue;
      const b = comp.get(e.target)!;
      if (a !== b) hasOuterIn.add(b);
    }
  }
  const members = new Map<number, ID[]>();
  for (const id of ids) {
    const c = comp.get(id)!;
    if (hasOuterIn.has(c)) continue;
    let m = members.get(c);
    if (!m) members.set(c, (m = []));
    m.push(id);
  }
  const originNodes = new Set(blocks.map((o) => o.node));
  for (const m of members.values()) {
    if (m.length < 2) continue; // 1 つだけの成分は入る線が無い＝すでに入口
    const os = m.filter((id) => originNodes.has(id));
    entries.push(...(os.length ? os : m));
  }

  const visible = new Set<ID>(entries);
  const stack = [...entries];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of outE.get(cur)!) {
      if (blocked.has(e.id) || visible.has(e.target)) continue;
      visible.add(e.target);
      stack.push(e.target);
    }
  }
  const hidden = new Set<ID>();
  for (const id of scope) if (!visible.has(id)) hidden.add(id);

  const counts = new Map<ID, number>();
  if (withCounts) {
    for (const o of blocks) {
      // 起点が隠れていれば印は描かないので数えない。たどるのは隠れているノードだけ（見えている所で止める）
      if (hidden.has(o.node)) continue;
      const seen = new Set<ID>();
      const q: ID[] = [];
      for (const s of o.starts) if (hidden.has(s) && !seen.has(s)) (seen.add(s), q.push(s));
      let k = 0;
      while (q.length) {
        const cur = q.pop()!;
        k++;
        for (const e of outE.get(cur)!) if (hidden.has(e.target) && !seen.has(e.target)) (seen.add(e.target), q.push(e.target));
      }
      counts.set(o.key, k);
    }
  }
  return { hidden, counts };
}

/**
 * scope の中で、折りたたみで隠れるノードを求める。
 * edgeOk で数に入れる接続を絞れる（シナリオで「隠す」ときなど）。
 */
export function computeCollapse(doc: DocData, index: GraphIndex, scope: Set<ID>, edgeOk: (e: GEdge) => boolean = () => true): CollapseResult {
  const outE = adjacency(doc, index, scope, edgeOk);
  const blocked = new Set<ID>();
  const blocks: Array<Block & { starts: ID[] }> = [];
  for (const id of scope) {
    const list = outE.get(id)!;
    if (doc.nodes[id]?.collapsed && list.length) {
      for (const e of list) blocked.add(e.id);
      blocks.push({ key: id, node: id, starts: list.map((e) => e.target) });
    }
    for (const e of list) {
      if (e.collapsed && !blocked.has(e.id)) {
        blocked.add(e.id);
        blocks.push({ key: e.id, node: id, starts: [e.target] });
      }
    }
  }
  if (blocks.length === 0) return EMPTY;
  return unreachedCore(scope, outE, blocked, blocks, true);
}

/**
 * シナリオの推定: そのシナリオに入らない接続だけを通って届くノード（選ばれなかった分岐の先）を求める。
 * 入る線の無いノードと、どれか 1 本でもシナリオの道で届くノードは対象外
 */
export function computeUnreached(doc: DocData, index: GraphIndex, scope: Set<ID>, isActive: (e: GEdge) => boolean): Set<ID> {
  const outE = adjacency(doc, index, scope, () => true);
  const blocked = new Set<ID>();
  const blocks: Array<Block & { starts: ID[] }> = [];
  for (const [id, list] of outE) {
    for (const e of list) {
      if (!isActive(e)) {
        blocked.add(e.id);
        blocks.push({ key: e.id, node: id, starts: [e.target] });
      }
    }
  }
  if (blocks.length === 0) return new Set();
  return unreachedCore(scope, outE, blocked, blocks, false).hidden;
}

/** 選んだノードの上流（そこへ至る道）と下流（そこから広がる未来）。循環しても止まる */
export function computePaths(doc: DocData, index: GraphIndex, starts: Iterable<ID>, edgeOk: (e: GEdge) => boolean = () => true): { nodes: Set<ID>; edges: Set<ID> } {
  const nodes = new Set<ID>();
  const edges = new Set<ID>();
  const walk = (dir: "out" | "inc") => {
    const seen = new Set<ID>();
    const q: ID[] = [];
    for (const s of starts) if (doc.nodes[s]) (seen.add(s), q.push(s), nodes.add(s));
    while (q.length) {
      const cur = q.pop()!;
      for (const eid of (dir === "out" ? index.out : index.inc).get(cur) ?? []) {
        const e = doc.edges[eid];
        if (!e || !edgeOk(e)) continue;
        edges.add(eid);
        const next = dir === "out" ? e.target : e.source;
        nodes.add(next);
        if (!seen.has(next)) (seen.add(next), q.push(next));
      }
    }
  };
  walk("out");
  walk("inc");
  return { nodes, edges };
}
