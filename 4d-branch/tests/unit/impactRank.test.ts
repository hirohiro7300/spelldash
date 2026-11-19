import { describe, expect, it } from "vitest";
import { buildImpactDoc } from "../../src/demo/impact";
import { r6Bundle } from "./helpers/r6";
import { computeForecast } from "../../src/model/forecast";
import { buildIndex } from "../../src/model/graph";
import { computeImpact } from "../../src/model/impact";
import { IMPACT_AVOID_MEAN, cachedWorthRanking, famLabel, famOf, hasFamLabel, keyDecisions, worthRanking } from "../../src/model/impactRank";
import { projectArea } from "../../src/model/impactText";
import type { DocData } from "../../src/model/types";

function bundled() {
  const doc = buildImpactDoc(r6Bundle(), new Date(2026, 10, 18), "test");
  const idx = buildIndex(doc);
  const fc = computeForecast(doc, idx.out);
  return { doc, fc, im: computeImpact(doc, idx.out, fc, null) };
}

/** 入口の meta.fams を変えた写し（null なら外す） */
function withFams(doc: DocData, rootId: string, fams: Record<string, unknown> | null): DocData {
  const r = doc.nodes[rootId]!;
  const meta = { ...r.meta };
  if (fams === null) delete meta.fams;
  else meta.fams = fams;
  return { ...doc, nodes: { ...doc.nodes, [rootId]: { ...r, meta } } };
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

  it("やる価値の順位は 3 年の影響の結果ごとに覚え、同じ結果なら計算し直さない（結果が新しくなれば計算し直す）", () => {
    const { doc, fc, im } = bundled();
    const a = cachedWorthRanking(doc, im, fc);
    expect(a).toEqual(worthRanking(doc, im, fc));
    // 同じ結果: 同じ物（題名だけの変更で文書・見込みが新しくなっていても）
    const renamed = { ...doc, nodes: { ...doc.nodes, [im.root!]: { ...doc.nodes[im.root!]!, title: "題名だけ変えた" } } };
    expect(cachedWorthRanking(renamed, im, computeForecast(renamed, buildIndex(renamed).out))).toBe(a);
    // 計算し直した結果は別に覚える
    const idx = buildIndex(doc);
    const im2 = computeImpact(doc, idx.out, fc, null);
    const b = cachedWorthRanking(doc, im2, fc);
    expect(b).not.toBe(a);
    expect(b).toEqual(a);
    expect(cachedWorthRanking(doc, im2, fc)).toBe(b);
  });
});

describe("手の種類の名前", () => {
  it("同梱の地図: 入口の meta.fams に、カードが使う手の種類の名前が全部ある（12 文字まで）", () => {
    const { doc, im } = bundled();
    const fams = doc.nodes[im.root!]!.meta.fams as Record<string, string>;
    expect(fams).toEqual(r6Bundle().fams);
    const used = new Set(Object.values(doc.nodes).map((n) => (typeof n.meta.fam === "string" ? n.meta.fam : "")).filter(Boolean));
    expect(used.size).toBeGreaterThan(5);
    for (const f of used) {
      expect(typeof fams[f], f).toBe("string");
      expect([...fams[f]!].length, fams[f]).toBeLessThanOrEqual(12);
      expect(hasFamLabel(doc, im.root, f)).toBe(true);
    }
    const { worth } = worthRanking(doc, im, null);
    const side = worth.find((w) => w.fam === "side")!;
    expect(famLabel(doc, im.root, "side", side.instances)).toBe(fams.side);
  });

  it("名前が無ければ出てくる所の最初のカードの題名、それも無ければ種類の ID", () => {
    const { doc, fc, im } = bundled();
    const root = im.root!;
    const side = worthRanking(doc, im, fc).worth.find((w) => w.fam === "side")!;
    const first = doc.nodes[side.instances[0]!]!.title;
    // 名前の無い古い版の地図
    const old = withFams(doc, root, null);
    expect(hasFamLabel(old, root, "side")).toBe(false);
    expect(famLabel(old, root, "side", side.instances)).toBe(first);
    // 空の名前・文字でない名前は無いのと同じ。ほかの種類の名前があっても、この種類は題名
    for (const fams of [{ side: "  " }, { side: 3 }, { pro: "Pro" }]) expect(famLabel(withFams(doc, root, fams), root, "side", side.instances)).toBe(first);
    // 入口が分からない・出てくる所が無い・題名が空
    expect(famLabel(doc, null, "side", side.instances)).toBe(first);
    expect(famLabel(old, root, "side", [])).toBe("side");
    const blank = { ...old, nodes: { ...old.nodes, [side.instances[0]!]: { ...old.nodes[side.instances[0]!]!, title: " " } } };
    expect(famLabel(blank, root, "side", side.instances)).toBe("side");
    expect(famLabel(old, root, "side", ["n_無い"])).toBe("side");
    // 名前があれば、出てくる所に関わらず名前
    expect(famLabel(doc, root, "side", ["n_無い"])).toBe(r6Bundle().fams!.side);
  });

  it("手の種類の行の領域の札は、選択肢の行と同じ名前と色（分からないプロジェクトは札なし）", () => {
    const { doc } = bundled();
    expect(projectArea("p_spelldash", doc)).toEqual({ key: "sd", label: "SpellDash", color: doc.projects.p_spelldash!.color });
    expect(projectArea("p_fcmarketing", doc)?.label).toBe("本業");
    expect(projectArea("p_independence", doc)?.label).toBe("独立");
    expect(projectArea(null, doc)).toBeNull();
    expect(projectArea("p_無い", doc)).toBeNull();
    const own = { ...doc, projects: { ...doc.projects, p_mine: { ...doc.projects.p_spelldash!, id: "p_mine", name: "自分の領域", color: "#123456" } } };
    expect(projectArea("p_mine", own)).toEqual({ key: "p_mine", label: "自分の領域", color: "#123456" });
  });
});
