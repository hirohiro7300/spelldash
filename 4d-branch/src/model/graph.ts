// 派生データ（保存しない）: 隣接・プロジェクトの所属・タグ・共有ノード・交差リンク。設計: docs/DESIGN.md §3.7
// 変更のたびに O(ノード + 接続) で作り直す（5,000 要素でも 1 ms 程度）

import type { DocData, GEdge, GNode, ID } from "./types";

export interface GraphIndex {
  /** ノード → 出る接続の ID */
  out: Map<ID, ID[]>;
  /** ノード → 入る接続の ID */
  inc: Map<ID, ID[]>;
  /** プロジェクト → 所属ノードの ID */
  projectNodes: Map<ID, ID[]>;
  /** どのプロジェクトにも属さないノード */
  unassigned: ID[];
  /** タグ → 件数（多い順） */
  tags: Array<{ tag: string; count: number }>;
  /** プロジェクトをまたぐ接続（両端に共通のプロジェクトが無い） */
  cross: Set<ID>;
  /** 2 つ以上のプロジェクトに属するノード */
  shared: Set<ID>;
  /** シナリオ → 所属するノード・接続の数 */
  scenarioCounts: Map<ID, number>;
}

/** 両端のノードに共通のプロジェクトが 1 つも無ければ「プロジェクト間の接続」 */
export function isCross(a: GNode, b: GNode): boolean {
  if (a.projectIds.length === 0 || b.projectIds.length === 0) return false;
  for (const p of a.projectIds) if (b.projectIds.includes(p)) return false;
  return true;
}

export function buildIndex(doc: DocData): GraphIndex {
  const out = new Map<ID, ID[]>();
  const inc = new Map<ID, ID[]>();
  const projectNodes = new Map<ID, ID[]>();
  const unassigned: ID[] = [];
  const tagCounts = new Map<string, { tag: string; count: number }>();
  const shared = new Set<ID>();
  const cross = new Set<ID>();
  const scenarioCounts = new Map<ID, number>();

  for (const pid of doc.projectOrder) projectNodes.set(pid, []);
  for (const sid of doc.scenarioOrder) scenarioCounts.set(sid, 0);

  for (const id in doc.nodes) {
    const n = doc.nodes[id]!;
    out.set(id, []);
    inc.set(id, []);
    if (n.projectIds.length === 0) unassigned.push(id);
    else {
      for (const p of n.projectIds) {
        let list = projectNodes.get(p);
        if (!list) projectNodes.set(p, (list = []));
        list.push(id);
      }
      if (n.projectIds.length > 1) shared.add(id);
    }
    for (const t of n.tags) {
      const key = t.toLowerCase();
      const cur = tagCounts.get(key);
      if (cur) cur.count++;
      else tagCounts.set(key, { tag: t, count: 1 });
    }
    for (const s of n.scenarioIds) scenarioCounts.set(s, (scenarioCounts.get(s) ?? 0) + 1);
  }
  for (const id in doc.edges) {
    const e = doc.edges[id]!;
    // 端が自分の項目として無い接続は飛ばす（組み込みの名前を引いても落ちない）
    const os = out.get(e.source);
    const is = inc.get(e.target);
    if (!os || !is) continue;
    const a = doc.nodes[e.source]!;
    const b = doc.nodes[e.target]!;
    os.push(id);
    is.push(id);
    if (isCross(a, b)) cross.add(id);
    for (const s of e.scenarioIds) scenarioCounts.set(s, (scenarioCounts.get(s) ?? 0) + 1);
  }
  const tags = [...tagCounts.values()].sort((x, y) => y.count - x.count || x.tag.localeCompare(y.tag, "ja"));
  return { out, inc, projectNodes, unassigned, tags, cross, shared, scenarioCounts };
}

export function edgeBetween(doc: DocData, index: GraphIndex, source: ID, target: ID): GEdge | undefined {
  for (const eid of index.out.get(source) ?? []) {
    const e = doc.edges[eid];
    if (e && e.target === target) return e;
  }
  return undefined;
}

/** シナリオを選んでいるとき、その要素が該当するか（空 = 全シナリオ共通） */
export function inScenario(scenarioIds: ID[], scenarioId: ID | null): boolean {
  return scenarioId === null || scenarioIds.length === 0 || scenarioIds.includes(scenarioId);
}
