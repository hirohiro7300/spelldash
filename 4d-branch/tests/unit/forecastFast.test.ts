// 見込みの速い作り（computeForecastFast: 型付きの配列・見込みは読まれたときに作る・行き先は読まれたときに並べる）が、
// computeForecast と同じ答え（見込みの数は 1 ビットまで、歩数・流した順・行き先の並び・範囲も）かを確かめる。
// 版 6 の地図と、作り物の地図（合流・循環・自分への線・入口が 2 つ・ほかの入口からたどれる入口・v1 の入口・シナリオ）で
import { describe, expect, it } from "vitest";
import { buildImpactDoc } from "../../src/demo/impact";
import { ForecastPlan, computeForecast, computeForecastFast, type ForecastResult } from "../../src/model/forecast";
import { impactScope, isFlowEdge } from "../../src/model/forks";
import { buildIndex } from "../../src/model/graph";
import { makeEdge, makeNode } from "../../src/model/schema";
import type { DocData, ID } from "../../src/model/types";
import { r6Bundle } from "./helpers/r6";
import { pick, rng, synthMap } from "./helpers/synthMap";

function fast(doc: DocData, sid: ID | null): ForecastResult {
  const out = buildIndex(doc).out;
  const roots = Object.keys(doc.nodes).filter((id) => doc.nodes[id]!.meta?.forecastRoot === true);
  return computeForecastFast(doc, out, { roots, impactScope: impactScope(doc, out) }, sid);
}

/** 同じ文書の計画を使い回す（方針を変えて流し直す） */
const plans = new WeakMap<DocData, ForecastPlan>();
function planOf(doc: DocData): ForecastPlan {
  let p = plans.get(doc);
  if (!p) {
    const out = buildIndex(doc).out;
    const roots = Object.keys(doc.nodes).filter((id) => doc.nodes[id]!.meta?.forecastRoot === true);
    plans.set(doc, (p = new ForecastPlan(doc, out, { roots, impactScope: impactScope(doc, out) })));
  }
  return p;
}

function same(doc: DocData, sid: ID | null): void {
  const out = buildIndex(doc).out;
  // 1 回だけの速い作りと、計画を使い回した物の両方
  for (const a of [fast(doc, sid), planOf(doc).run(sid)]) sameAs(a, computeForecast(doc, out, sid));
}

function sameAs(a: ForecastResult, b: ForecastResult): void {
  expect(a.active).toBe(b.active);
  expect(a.longest).toBe(b.longest);
  expect(a.order).toEqual(b.order);
  expect([...a.reach.keys()]).toEqual([...b.reach.keys()]);
  for (const [id, r] of b.reach) {
    const x = a.reach.get(id)!;
    expect(Object.is(x.p, r.p), `${id} p ${x.p} ≠ ${r.p}`).toBe(true);
    expect(x.minSteps).toBe(r.minSteps);
    expect(x.maxSteps).toBe(r.maxSteps);
  }
  expect(a.reach.size).toBe(b.reach.size);
  expect(a.ends).toEqual(b.ends);
  expect([...a.impactScope].sort()).toEqual([...b.impactScope].sort());
}

describe("見込みの速い作り: computeForecast と同じ答え", () => {
  it("版 6 の地図（方針なし・3 つの方針）", () => {
    const doc = buildImpactDoc(r6Bundle(), new Date(2026, 10, 18), "t");
    for (const sid of [null, "s_balance", "s_early", "s_focus"]) same(doc, sid);
  });

  for (const seed of [1, 2, 3, 4, 5]) {
    it(`作り物の地図 種 ${seed}（合流・循環・自分への線・入口 3 つ・v1 の入口・%・方針）`, () => {
      const syn = synthMap(seed, { cards: 1500, users: 60, links: 160, twoRoots: seed % 2 === 0 });
      const doc = syn.doc;
      const rand = rng(seed * 31);
      // 結果の線に乱数の %（分かれの重み）と、道の線で合流・循環・自分への線
      for (const e of Object.values(doc.edges)) if (isFlowEdge(e) && rand() < 0.5) doc.edges[e.id] = { ...e, meta: { ...e.meta, prob: rand() < 0.1 ? null : Math.round(rand() * 100) } };
      for (let k = 0; k < 30; k++) {
        const s = pick(rand, syn.cards);
        const t = rand() < 0.2 ? s : pick(rand, syn.cards);
        const e = makeEdge({ id: `m${k}`, source: s, target: t, relation: rand() < 0.5 ? "leads" : "condition", scenarioIds: rand() < 0.3 ? [pick(rand, syn.scenarios)] : [] });
        doc.edges[e.id] = e;
      }
      // v1 の入口（3 年の分かれ道ではない予測の入口）と、その先の分岐
      doc.nodes.v1 = makeNode({ id: "v1", type: "goal", title: "v1 の今日", meta: { forecastRoot: true } });
      doc.nodes.v1b = makeNode({ id: "v1b", type: "branch", title: "v1 の分岐" });
      for (const [id, s, t, prob] of [
        ["v1e1", "v1", "v1b", null],
        ["v1e2", "v1b", syn.users[0]!, 30],
        ["v1e3", "v1b", syn.users[1]!, null],
        ["v1e4", "v1b", syn.cards[7]!, 50],
      ] as const)
        doc.edges[id] = makeEdge({ id, source: s, target: t, relation: "leads", meta: { prob } });
      for (const sid of [null, ...syn.scenarios]) same(doc, sid);
    });
  }

  it("入口が無ければ active でない（範囲はそのまま返す）", () => {
    const syn = synthMap(9, { cards: 100, users: 5, links: 5 });
    delete syn.doc.nodes.r!.meta.forecastRoot;
    const a = fast(syn.doc, null);
    expect(a.active).toBe(false);
    expect(a.reach.size).toBe(0);
  });
});
