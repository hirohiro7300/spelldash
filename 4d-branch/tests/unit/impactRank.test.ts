import { describe, expect, it } from "vitest";
import { buildImpactDoc } from "../../src/demo/impact";
import { futureData } from "../../src/demo/futureBundle";
import { computeForecast } from "../../src/model/forecast";
import { buildIndex } from "../../src/model/graph";
import { computeImpact } from "../../src/model/impact";
import { IMPACT_AVOID_MEAN, famOf, keyDecisions, worthRanking } from "../../src/model/impactRank";

function bundled() {
  const doc = buildImpactDoc(futureData(), new Date(2026, 10, 18), "test");
  const idx = buildIndex(doc);
  const fc = computeForecast(doc, idx.out);
  return { doc, fc, im: computeImpact(doc, idx.out, fc, null) };
}

describe("3 年の分かれ道の順位", () => {
  it("やる価値が大きい手: 種類ごとに、ずっと使わない場合との差の大きい順。出てくる所は見込みの高い順", () => {
    const { doc, fc, im } = bundled();
    const { worth } = worthRanking(doc, im, fc);
    expect(worth.length).toBeGreaterThan(3);
    for (let i = 1; i < worth.length; i++) expect(worth[i - 1]!.k).toBeGreaterThanOrEqual(worth[i]!.k);
    for (const w of worth) {
      expect(w.k).toBeCloseTo(im.never(w.fam).k!, 9);
      expect(w.instances.length).toBeGreaterThan(0);
      for (const id of w.instances) expect(famOf(doc.nodes[id])).toBe(w.fam);
      const ps = w.instances.map((id) => fc.reach.get(id)?.p ?? 0);
      for (let i = 1; i < ps.length; i++) expect(ps[i - 1]!).toBeGreaterThanOrEqual(ps[i]!);
      // 今のままは入れない
      expect(w.instances.some((id) => im.alt.get(id)!.isBase)).toBe(false);
    }
    // 一番上は差がある
    expect(worth[0]!.k).toBeGreaterThan(1);
  });

  it("避けたい手: 平均の差が −15 万円以下の種類を、悪い順に 3 つまで", () => {
    const { doc, fc, im } = bundled();
    const { avoid } = worthRanking(doc, im, fc);
    expect(avoid.length).toBeGreaterThan(0);
    expect(avoid.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < avoid.length; i++) expect(avoid[i - 1]!.mean).toBeLessThanOrEqual(avoid[i]!.mean);
    for (const a of avoid) {
      expect(a.mean).toBeLessThanOrEqual(IMPACT_AVOID_MEAN);
      let sw = 0;
      let sv = 0;
      for (const id of a.instances) {
        const p = fc.reach.get(id)?.p ?? 0;
        const d = im.alt.get(id)!.delta;
        if (d !== null && p > 0) (sw += p), (sv += p * d);
      }
      expect(a.mean).toBeCloseTo(sv / sw, 9);
    }
  });

  it("この先の大事な判断: 今日を除き、来る見込み × 差の大きい順に 8 つまで", () => {
    const { im } = bundled();
    const rows = keyDecisions(im);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(8);
    expect(rows.some((r) => r.id === im.root)).toBe(false);
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.p * rows[i - 1]!.stakes).toBeGreaterThanOrEqual(rows[i]!.p * rows[i]!.stakes);
    for (const r of rows) {
      expect(r.p).toBeCloseTo(im.pPi.get(r.id)!, 12);
      expect(r.stakes).toBeCloseTo(im.decision.get(r.id)!.stakes!, 12);
      expect(r.best).toBe(im.decision.get(r.id)!.best);
    }
    expect(keyDecisions(im, 3).length).toBe(3);
  });
});
