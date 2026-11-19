// 確かめ用の作り物の地図（3,000〜5,000 枚の 3 年の分かれ道 + 自分のノードと、あらゆる関係の線）。種から決まる。
// 見え方・索引・検索の速い作りが、基準の作り（全部をなめる作り）と同じ答えかを、いろいろな形で確かめるのに使う

import { createEmptyDoc, makeEdge, makeNode, makeProject, makeScenario } from "../../../src/model/schema";
import type { DocData, GEdge, GNode, ID, NodeType, Relation } from "../../../src/model/types";

/** 種から決まる乱数（mulberry32） */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

const RELS: Relation[] = ["leads", "condition", "supports", "blocks", "feedback"];
const WORDS = ["転職", "副業", "昇格", "広告", "顧客", "独立", "学校", "評価", "給与", "ポートフォリオ", "テスト", "ｶﾀｶﾅ", "ＡＢＣ", "spell", "Dash"];
const TAGS = ["3か月後", "仕事", "SpellDash", "spelldash", "副業", "#x"];

export interface SynthOpts {
  /** 3 年の分かれ道のカードのおよその数 */
  cards: number;
  /** 自分のノードの数 */
  users: number;
  /** 自分の線の数 */
  links: number;
  /** 入口をもう 1 つ（別の小さな地図と、ほかの入口からたどれる入口） */
  twoRoots?: boolean;
}

export interface Synth {
  doc: DocData;
  /** 3 年の分かれ道のカード（作った順） */
  cards: ID[];
  /** 自分のノード */
  users: ID[];
  roots: ID[];
  projects: ID[];
  scenarios: ID[];
}

const dateOf = (rand: () => number): string | null => (rand() < 0.3 ? null : `20${26 + Math.floor(rand() * 4)}-${String(1 + Math.floor(rand() * 12)).padStart(2, "0")}-${String(1 + Math.floor(rand() * 28)).padStart(2, "0")}`);

/** 作り物の地図を作る（3 年の分かれ道の木 + 自分のノード + あらゆる関係の線） */
export function synthMap(seed: number, o: SynthOpts): Synth {
  const rand = rng(seed);
  const doc = createEmptyDoc("作り物");
  const projects = ["p1", "p2", "p3"].map((id, i) => makeProject({ id, name: ["仕事", "SpellDash", "副業"][i]! }));
  for (const p of projects) {
    doc.projects[p.id] = p;
    doc.projectOrder.push(p.id);
  }
  const scenarios = ["s1", "s2"].map((id, i) => makeScenario({ id, name: ["早期独立", "会社に残る"][i]! }));
  for (const s of scenarios) {
    doc.scenarios[s.id] = s;
    doc.scenarioOrder.push(s.id);
  }
  const P = projects.map((p) => p.id);
  const S = scenarios.map((s) => s.id);
  let eseq = 0;
  const addEdge = (source: ID, target: ID, relation: Relation, extra: Partial<GEdge> = {}): GEdge => {
    const e = makeEdge({ id: `e${eseq++}`, source, target, relation, ...extra });
    doc.edges[e.id] = e;
    return e;
  };
  const projOf = (): ID[] => {
    const u = rand();
    return u < 0.15 ? [] : u < 0.5 ? [pick(rand, P)] : u < 0.8 ? [...P] : [P[0]!, P[2]!];
  };
  const scenOf = (): ID[] => (rand() < 0.85 ? [] : rand() < 0.5 ? [S[0]!] : [...S]);
  const title = (base: string) => `${base} ${pick(rand, WORDS)}${rand() < 0.3 ? ` ${pick(rand, WORDS)}` : ""}`;
  const mkNode = (id: ID, type: NodeType, extra: Partial<GNode> = {}): GNode => {
    const n = makeNode({
      id,
      type,
      title: title(type === "branch" ? "判断" : type === "action" ? "手" : "結果"),
      tags: rand() < 0.5 ? [pick(rand, TAGS)] : rand() < 0.2 ? [pick(rand, TAGS), pick(rand, TAGS)] : [],
      projectIds: projOf(),
      scenarioIds: scenOf(),
      time: { due: dateOf(rand), start: null },
      ...extra,
    });
    doc.nodes[n.id] = n;
    return n;
  };

  // 3 年の分かれ道: 判断（今日・状態）→ 手 2〜5 → 結果 1〜3（状態か行き先）
  const cards: ID[] = [];
  const roots: ID[] = [];
  const grow = (rootId: ID, budget: number) => {
    const root = mkNode(rootId, "goal", { title: "今日", meta: { forecastRoot: true, impact: { v: 2, horizon: 36 }, fork: "decision", rank: 0, short: "今日の地図" } });
    roots.push(root.id);
    cards.push(root.id);
    const queue: ID[] = [root.id];
    let made = 1;
    let k = 0;
    while (queue.length && made < budget) {
      const d = queue.shift()!;
      const opts = 2 + Math.floor(rand() * 4);
      for (let i = 0; i < opts && made < budget; i++) {
        const a = mkNode(`${rootId}a${k++}`, "action", { meta: { fork: "chance", rank: i, short: rand() < 0.5 ? `ひとこと ${pick(rand, WORDS)}` : "" } });
        cards.push(a.id);
        made++;
        addEdge(d, a.id, "leads", { scenarioIds: rand() < 0.2 ? [pick(rand, S)] : [], label: "", condition: rand() < 0.3 ? `判断の線 ${pick(rand, WORDS)}` : "" });
        const outs = 1 + Math.floor(rand() * 3);
        for (let j = 0; j < outs && made < budget; j++) {
          const s = mkNode(`${rootId}s${k++}`, rand() < 0.15 ? "result" : "branch", { meta: { fork: "decision", rank: j } });
          cards.push(s.id);
          made++;
          addEdge(a.id, s.id, "condition", { label: rand() < 0.6 ? `結果 ${pick(rand, WORDS)}` : "", condition: rand() < 0.4 ? `条件 ${pick(rand, WORDS)}` : "", meta: { prob: Math.round(100 / outs) } });
          if (s.type === "branch") queue.push(s.id);
        }
      }
    }
  };
  grow("r", o.cards);
  if (o.twoRoots) {
    grow("q", Math.max(30, Math.floor(o.cards / 20)));
    // 入口 r の深いカードから、入口 z（別の地図）へ道の線: z は r がたどる入口になる
    grow("z", 20);
    addEdge(pick(rand, cards.slice(5, 200)), "z", "leads");
  }

  // 自分のノード
  const users: ID[] = [];
  for (let i = 0; i < o.users; i++) {
    const u = mkNode(`u${i}`, pick(rand, ["goal", "action", "branch", "result"] as NodeType[]), { collapsed: rand() < 0.12, body: rand() < 0.3 ? `本文 ${pick(rand, WORDS)}` : "", conditions: rand() < 0.2 ? [{ id: `c${i}`, text: `条件 ${pick(rand, WORDS)}`, met: false }] : [] });
    users.push(u.id);
  }
  // 自分の線: あらゆる関係で、自分のノード同士・地図の中へ・地図の外へ・地図のカード同士（合流・循環・遠い線）
  const deep = () => pick(rand, cards);
  for (let i = 0; i < o.links; i++) {
    const kind = rand();
    let s: ID;
    let t: ID;
    if (kind < 0.3) {
      s = pick(rand, users);
      t = pick(rand, users);
    } else if (kind < 0.55) {
      s = pick(rand, users);
      t = deep();
    } else if (kind < 0.8) {
      s = deep();
      t = pick(rand, users);
    } else {
      s = deep();
      t = deep();
    }
    if (s === t && rand() < 0.8) continue;
    addEdge(s, t, pick(rand, RELS), { collapsed: rand() < 0.08, scenarioIds: rand() < 0.15 ? [pick(rand, S)] : [], label: rand() < 0.2 ? `線 ${pick(rand, WORDS)}` : "" });
  }
  // 地図の中の線を少し折りたたむ（線の折りたたみの印と件数）
  const edgeIds = Object.keys(doc.edges);
  for (let i = 0; i < Math.max(1, Math.floor(edgeIds.length / 400)); i++) {
    const id = pick(rand, edgeIds);
    doc.edges[id] = { ...doc.edges[id]!, collapsed: true };
  }
  return { doc, cards, users, roots, projects: P, scenarios: S };
}

/**
 * 入口ごとの「開いているノード」を乱数で作る（入口から乱数の道を開いていく。深い所を散らして開いたり、閉じた所の中を開いたりもする）
 */
export function randomOpens(rand: () => number, doc: DocData, roots: ID[], kidsOf: (id: ID) => ID[], cards: ID[]): Record<ID, ID[]> {
  const out: Record<ID, ID[]> = {};
  for (const r of roots) {
    const set = new Set<ID>([r]);
    const walks = Math.floor(rand() * 8);
    for (let w = 0; w < walks; w++) {
      let cur = r;
      for (let d = 0; d < 30; d++) {
        set.add(cur);
        const kids = kidsOf(cur);
        if (!kids.length || rand() < 0.08) break;
        cur = pick(rand, kids);
      }
    }
    // 散らして開く（閉じた所の中も）
    const scatter = Math.floor(rand() * 40);
    for (let i = 0; i < scatter; i++) set.add(pick(rand, cards));
    if (rand() < 0.15) for (const k of kidsOf(r)) set.add(k);
    if (rand() < 0.1) set.delete(r);
    out[r] = [...set].filter((id) => !!doc.nodes[id]);
  }
  return out;
}
