// 性能確認用の大きなグラフ（?stress=2000 などで開く。保存しない一時表示）。
// 決まった乱数で毎回同じ形にする（計測を比べられるように）

import { CHILD_DX, NODE_TYPE_ORDER, PROJECT_COLORS, SCENARIO_COLORS } from "../model/constants";
import { addDays } from "../model/dates";
import { createEmptyDoc, makeCondition, makeEdge, makeNode, makeProject, makeScenario } from "../model/schema";
import type { DocData, ID, NodeType, Relation } from "../model/types";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["集客", "広告", "SEO", "採用", "資金", "学習", "営業", "改善", "計測", "提携", "発信", "品質", "契約", "検証", "準備"];
const VERBS = ["を始める", "を見直す", "を試す", "を広げる", "を仕組みにする", "を外に任せる", "を数字で測る"];

export function buildStressDoc(total: number, seed = 42): DocData {
  const rand = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const doc = createEmptyDoc(`性能確認（${total} ノード）`);
  const projectCount = Math.max(3, Math.min(10, Math.round(total / 250)));
  const projects: ID[] = [];
  for (let i = 0; i < projectCount; i++) {
    const p = makeProject({ name: `プロジェクト ${i + 1}`, color: PROJECT_COLORS[i % PROJECT_COLORS.length]! });
    doc.projects[p.id] = p;
    doc.projectOrder.push(p.id);
    projects.push(p.id);
  }
  const scenarios: ID[] = [];
  for (let i = 0; i < 3; i++) {
    const s = makeScenario({ name: ["基本", "攻め", "守り"][i]!, color: SCENARIO_COLORS[i]! });
    doc.scenarios[s.id] = s;
    doc.scenarioOrder.push(s.id);
    scenarios.push(s.id);
  }

  const per = Math.ceil(total / projectCount);
  const startDate = "2026-11-01";
  const clusters: ID[][][] = [];
  const clusterOf = new Map<ID, number>();
  const depthOf = new Map<ID, number>();
  let made = 0;
  for (let pi = 0; pi < projectCount && made < total; pi++) {
    const count = Math.min(per, total - made);
    // 層ごとに並べる木（深さ = 横、層の中の順 = 縦）。枝分かれは平均 1.5 くらい（深く、縦に長すぎない）
    const layers: ID[][] = [];
    const root = makeNode({ type: "goal", title: `プロジェクト ${pi + 1} の目標`, projectIds: [projects[pi]!] });
    doc.nodes[root.id] = root;
    layers.push([root.id]);
    let layer = [root.id];
    let inCluster = 1;
    while (inCluster < count) {
      const next: ID[] = [];
      for (const parent of layer) {
        const kids = 1 + (rand() < 0.42 ? 1 : 0) + (rand() < 0.07 ? 1 : 0);
        for (let k = 0; k < kids && inCluster < count; k++) {
          const depth = layers.length;
          const type: NodeType = depth % 4 === 1 ? "branch" : pick(NODE_TYPE_ORDER);
          const n = makeNode({
            type,
            title: `${pick(WORDS)}${pick(VERBS)} ${pi + 1}-${inCluster}`,
            projectIds: rand() < 0.06 ? [projects[pi]!, projects[(pi + 1) % projectCount]!] : [projects[pi]!],
            tags: [pick(WORDS)],
            time: { due: addDays(startDate, depth * 40 + Math.floor(rand() * 35)), start: null },
            conditions: type === "branch" ? [makeCondition("条件を満たす", rand() < 0.5)] : [],
            scenarioIds: rand() < 0.08 ? [pick(scenarios)] : [],
            status: rand() < 0.15 ? "done" : rand() < 0.3 ? "active" : "open",
          });
          doc.nodes[n.id] = n;
          const rel: Relation = doc.nodes[parent]!.type === "branch" ? "condition" : "leads";
          const e = makeEdge({ source: parent, target: n.id, relation: rel, condition: rel === "condition" ? "条件しだい" : "" });
          doc.edges[e.id] = e;
          next.push(n.id);
          clusterOf.set(n.id, pi);
          depthOf.set(n.id, depth);
          inCluster++;
        }
        if (inCluster >= count) break;
      }
      if (next.length === 0) break;
      layers.push(next);
      layer = next;
    }
    clusterOf.set(root.id, pi);
    depthOf.set(root.id, 0);
    clusters.push(layers);
    made += inCluster;
  }

  // 並べる: クラスタを格子に（列の幅・行の高さはそこに入るクラスタの最大）
  const ROW = 128;
  const cols = Math.max(1, Math.round(Math.sqrt(clusters.length * 1.4)));
  const colW: number[] = [];
  const rowH: number[] = [];
  clusters.forEach((layers, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    colW[c] = Math.max(colW[c] ?? 0, layers.length * CHILD_DX);
    rowH[r] = Math.max(rowH[r] ?? 0, Math.max(...layers.map((l) => l.length)) * ROW);
  });
  clusters.forEach((layers, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const ox = colW.slice(0, c).reduce((s2, w) => s2 + w + 500, 0);
    const oy = rowH.slice(0, r).reduce((s2, hh) => s2 + hh + 500, 0);
    const tallest = Math.max(...layers.map((l) => l.length));
    layers.forEach((l, depth) => {
      const offset = ((tallest - l.length) * ROW) / 2;
      l.forEach((id, k) => {
        const n = doc.nodes[id]!;
        doc.nodes[id] = { ...n, x: ox + depth * CHILD_DX, y: oy + offset + k * ROW };
      });
    });
  });

  // 合流・循環・プロジェクトをまたぐ線を足す（ほとんどは同じクラスタの近い層、ときどき別のクラスタ）
  const all = Object.keys(doc.nodes);
  const byCluster = clusters.map((layers) => layers.flat());
  const pairs = new Set(Object.values(doc.edges).map((e) => `${e.source}>${e.target}`));
  const extra = Math.floor(all.length * 0.5);
  for (let i = 0; i < extra; i++) {
    const a = pick(all);
    const ca = clusterOf.get(a)!;
    let b: ID;
    if (rand() < 0.85) {
      const da = depthOf.get(a)!;
      const layers = clusters[ca]!;
      const d = Math.max(0, Math.min(layers.length - 1, da + (rand() < 0.15 ? -1 : 1 + Math.floor(rand() * 2))));
      b = pick(layers[d]!);
    } else b = pick(byCluster[Math.floor(rand() * byCluster.length)]!);
    if (a === b || pairs.has(`${a}>${b}`)) continue;
    pairs.add(`${a}>${b}`);
    const na = doc.nodes[a]!;
    const nb = doc.nodes[b]!;
    const relation: Relation = nb.x < na.x ? "feedback" : clusterOf.get(b) !== ca ? "supports" : rand() < 0.7 ? "leads" : "blocks";
    const e = makeEdge({ source: a, target: b, relation, label: relation === "supports" ? "相乗効果" : "" });
    doc.edges[e.id] = e;
  }
  return doc;
}
