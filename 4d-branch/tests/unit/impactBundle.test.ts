import { describe, expect, it } from "vitest";
import { buildImpactDoc, countImpact, impactNodeId, type ImpactAltX, type ImpactOutX } from "../../src/demo/impact";
import { buildFuture, futureData, futureVersion } from "../../src/demo/futureBundle";
import { futureMaps } from "../../src/demo/futureSwap";
import { computeForecast } from "../../src/model/forecast";
import { buildIndex } from "../../src/model/graph";
import { computeImpact } from "../../src/model/impact";
import { normalizeDoc } from "../../src/model/schema";
import { encodeDoc } from "../../src/persist/cloud";
import type { DocData } from "../../src/model/types";

const TODAY = new Date(2026, 10, 18);
const data = futureData();

function impactOf(doc: DocData, annual?: number) {
  let d = doc;
  if (annual !== undefined) {
    const root = Object.values(doc.nodes).find((n) => n.meta.forecastRoot === true)!;
    d = { ...doc, nodes: { ...doc.nodes, [root.id]: { ...root, meta: { ...root.meta, impact: { v: 2, horizon: 36, annual } } } } };
  }
  const idx = buildIndex(d);
  return computeImpact(d, idx.out, computeForecast(d, idx.out), null);
}

describe("同梱の 3 年の分かれ道", () => {
  const doc = buildImpactDoc(data, TODAY, "t");

  it("木の形: 今日は 10 の手、判断には今のままが 1 つ、どの道も 36 か月目の行き先で終わる", () => {
    const kids = data.nodes.map(() => [] as number[]);
    data.nodes.forEach((n, i) => {
      if (i === 0) expect(n[1]).toBe(-1);
      else {
        expect(n[1]).toBeGreaterThanOrEqual(0);
        expect(n[1]).toBeLessThan(i);
        kids[n[1]]!.push(i);
      }
    });
    expect(kids[0]!.length).toBe(10);
    data.nodes.forEach((n, i) => {
      const ks = kids[i]!.map((k) => data.nodes[k]!);
      if (n[2] === "r" || n[2] === "s") {
        expect(ks.every((k) => k[2] === "a")).toBe(true);
        expect(ks.filter((k) => (k[7] as ImpactAltX).base).length).toBe(1);
        expect(ks.length).toBeGreaterThanOrEqual(2);
      }
      if (n[2] === "a") {
        expect(ks.length).toBeGreaterThanOrEqual(1);
        const ps = ks.map((k) => (k[7] as ImpactOutX).p);
        expect(ps.reduce((a, b) => a + b, 0)).toBe(100);
        for (const k of ks) expect(k[3]).toBe(n[3] + (n[7] as ImpactAltX).len);
      }
      if (n[2] === "e") {
        expect(n[3]).toBe(36);
        expect(kids[i]!.length).toBe(0);
      }
      if (n[2] === "s") expect(kids[i]!.length).toBeGreaterThan(0);
    });
    const c = countImpact(data);
    expect(c).toEqual(data.check.counts);
    expect(c.nodes).toBeLessThanOrEqual(1800);
    expect(c.ends).toBeGreaterThanOrEqual(600);
    expect(c.forks).toBeGreaterThanOrEqual(550);
  });

  it("ID が重ならず、同じデータ・同じ日なら同じ文書。検証で直されない", () => {
    const ids = data.nodes.map((n) => impactNodeId(n[0]));
    expect(new Set(ids).size).toBe(ids.length);
    const again = buildImpactDoc(data, TODAY, "t");
    const strip = (d: DocData) => JSON.stringify({ n: Object.values(d.nodes).map(({ createdAt: _c, updatedAt: _u, ...x }) => x), e: Object.values(d.edges).map(({ createdAt: _c, updatedAt: _u, ...x }) => x) });
    expect(strip(again)).toBe(strip(doc));
    const { report } = normalizeDoc(JSON.parse(JSON.stringify(doc)));
    expect(report.warnings).toEqual([]);
    expect(report.dropped).toEqual({ nodes: 0, edges: 0, projects: 0, scenarios: 0 });
  });

  it("アプリの計算が作った時の数と合う（年収 360・540）", () => {
    const im = impactOf(doc);
    expect(im.active).toBe(true);
    expect(im.vRoot!).toBeCloseTo(data.check.vRoot, 1);
    expect(im.vSQ!).toBeCloseTo(data.check.vSQ, 1);
    const root = data.nodes[0]!;
    const rootKids = data.nodes.filter((n) => n[1] === 0);
    for (const k of rootKids) {
      const d = im.alt.get(impactNodeId(k[0]))!.delta!;
      expect(d, k[4]).toBeCloseTo(data.check.rootDelta[(k[7] as ImpactAltX).k]!, 1);
    }
    expect(root[2]).toBe("r");
    // 年収を変えると本業の数が変わり、値は年収について一次（選び方が同じなら）
    const im540 = impactOf(doc, 540);
    expect(im540.vSQ!).toBeGreaterThan(im.vSQ!);
  });

  it("恒等式: 行き先の見込みの合計は 1、今日の値 = 行き先の合計の平均、結果の差の平均 = 手の差、今のままの差は 0", () => {
    const im = impactOf(doc);
    expect(im.ends.reduce((s, e) => s + e.p, 0)).toBeCloseTo(1, 9);
    expect(im.ends.reduce((s, e) => s + e.p * e.tot, 0)).toBeCloseTo(im.vRoot!, 1);
    for (const [, a] of im.alt) {
      if (a.isBase) expect(a.delta).toBe(0);
      if (a.delta === null || !a.outcomes.length) continue;
      expect(a.outcomes.reduce((s, o) => s + o.w * o.u!, 0)).toBeCloseTo(a.delta, 1);
    }
  });

  it("判断の線: 数の線は漏れも重なりも無く、結果の線には % と期間の稼ぎがある", () => {
    for (const e of Object.values(doc.edges)) {
      if (e.relation !== "condition") {
        expect(e.meta.prob).toBeUndefined();
        continue;
      }
      expect(Number.isInteger(e.meta.prob)).toBe(true);
      expect(Array.isArray(e.meta.r) && (e.meta.r as number[]).length === 3).toBe(true);
      expect(e.condition.length).toBeGreaterThan(0);
    }
    const byAlt = new Map<string, Array<[string, number, number | null, number | null, string?]>>();
    for (const e of Object.values(doc.edges)) if (e.relation === "condition") byAlt.set(e.source, [...(byAlt.get(e.source) ?? []), e.meta.ln as [string, number, number | null, number | null, string?]]);
    for (const [id, lines] of byAlt) {
      if (lines.length < 2 || lines.some((l) => l[4] !== undefined)) continue;
      const iv = lines.map((l) => [l[2] ?? -Infinity, l[3] ?? Infinity]).sort((a, b) => a[0]! - b[0]!);
      expect(iv[0]![0], id).toBe(-Infinity);
      expect(iv[iv.length - 1]![1], id).toBe(Infinity);
      for (let i = 0; i + 1 < iv.length; i++) expect(iv[i]![1], id).toBe(iv[i + 1]![0]);
    }
  });

  it("大きさ: 同梱 800 KB 以下、文書 2.15 MB 以下、同期は 3 分割に収まる", async () => {
    expect(JSON.stringify(data).length).toBeLessThanOrEqual(800_000);
    expect(JSON.stringify(doc).length).toBeLessThanOrEqual(2_150_000);
    const e = await encodeDoc(doc);
    expect(e.payload.length).toBeLessThanOrEqual(486_000);
  });

  it("読み込みの確認: 版が入口に残り、未来の道筋として見つかる", () => {
    const { pv, stats } = buildFuture(TODAY);
    expect(stats).toEqual(countImpact(data));
    const maps = futureMaps(pv.doc);
    expect(maps.length).toBe(1);
    expect(maps[0]!.version).toBe(futureVersion());
    expect(maps[0]!.nodes.size).toBe(data.nodes.length);
  });

  it("計算は速い（1,800 ノードで 40 ms 以内・遅延の計算も 80 ms 以内。テストの環境は遅いので余裕を見る）", () => {
    const idx = buildIndex(doc);
    const fc = computeForecast(doc, idx.out);
    for (let k = 0; k < 3; k++) computeImpact(doc, idx.out, fc, null);
    const t0 = performance.now();
    const im = computeImpact(doc, idx.out, fc, null);
    const t1 = performance.now();
    im.salaryFlips();
    for (const f of im.families()) im.never(f);
    const t2 = performance.now();
    expect(t1 - t0).toBeLessThan(40);
    expect(t2 - t1).toBeLessThan(80);
  });
});
