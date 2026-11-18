import { describe, expect, it } from "vitest";
import { buildImpactDoc } from "../../src/demo/impact";
import { futureData } from "../../src/demo/futureBundle";
import { computeForecast } from "../../src/model/forecast";
import { buildIndex } from "../../src/model/graph";
import { computeImpact } from "../../src/model/impact";
import { formatMan } from "../../src/model/impactFormat";
import {
  altMetaLine,
  altMetaParts,
  areaOf,
  binRangeText,
  breakdownAreas,
  divergingBar,
  divergingDomain,
  flipTexts,
  formatManStep,
  headlineOf,
  horizonText,
  hoursShort,
  hoursText,
  parseAnnual,
  riskShort,
  riskText,
  splitExact,
  stateLine,
  trailOf,
  yen,
  ymAfter,
  ymText,
} from "../../src/model/impactText";
import { createEmptyDoc, makeEdge, makeNode, makeProject } from "../../src/model/schema";

const parse = (s: string): number => (s === "±0" ? 0 : Number(s.replace("−", "-").replace(/[万,+]/g, "")));

describe("3 年の影響の言葉", () => {
  it("万円は文の中の形（符号・区切り・±0・億）", () => {
    expect(yen(1423.4, false)).toBe("1,423 万円");
    expect(yen(293.2)).toBe("+293 万円");
    expect(yen(-43)).toBe("−43 万円");
    expect(yen(2.06)).toBe("+2.1 万円");
    expect(yen(0.01)).toBe("±0");
    expect(yen(12_345)).toBe("+1.2 億円");
  });

  it("年月と期間", () => {
    expect(ymText("2026-11-18")).toBe("2026年11月");
    expect(ymText(null)).toBeNull();
    expect(ymText("2026-13-01")).toBeNull();
    expect(ymAfter("2026-11-18", 36)).toBe("2029年11月");
    expect(ymAfter("2026-11-18", 2)).toBe("2027年1月");
    expect(horizonText(36)).toBe("3 年");
    expect(horizonText(18)).toBe("18 か月");
  });

  it("状態の 1 行（仕事・届け出・顧客・SpellDash・学校）", () => {
    const st = { j: "e", pm: "a", pro: 1, mau: 946.15, pu: 12.4, seats: 0, cl: 0.7214, fee: 5, sal: 1.0512, cv: 1, fl: [] };
    expect(stateLine(st)).toBe("会社員（給与 1.05 倍）・副業 OK・顧客 1 社（月 3.6 万円）・SpellDash 有料 12 人（遊ぶ人 月 946 人）");
    // 週 4 日は今の稼ぎ（rr）の倍率を使う
    expect(stateLine({ ...st, j: "p", pm: "s", cl: 0, pro: 0, mau: 1520 }, [0.84, 0, 0])).toBe("週 4 日勤務（給与 0.84 倍）・SpellDash だけ可・SpellDash 無料（遊ぶ人 月 1,520 人）");
    expect(stateLine({ ...st, j: "p", pm: "s", cl: 0, pro: 0 })).toContain("週 4 日勤務（給与 0.84 倍）");
    // 独立なら届け出は出さず、顧客が無ければ「顧客なし」
    expect(stateLine({ ...st, j: "i", cl: 0, fee: 7, seats: 40 })).toBe("独立・顧客なし・SpellDash 有料 12 人（遊ぶ人 月 946 人）・学校 40 席");
    expect(stateLine({ ...st, j: "i", cl: 3.2, fee: 7 })).toContain("独立・顧客 3 社（月 22.4 万円）");
    expect(stateLine({ ...st, pm: "?" })).toContain("副業は届け出前");
    expect(stateLine({ ...st, pm: "n" })).toContain("副業は不可");
    expect(stateLine(null)).toBeNull();
    expect(stateLine({ j: "x" })).toBeNull();
    expect(stateLine("会社員")).toBeNull();
  });

  it("内訳は表示の桁で丸め、足すと合計の表示とちょうど合う（最大剰余）", () => {
    const cases: Array<[number, number[]]> = [
      [68.78, [50.5, 31.7, -13.42]],
      [62.28, [-9.1, 89.1, -17.72]],
      [5.08, [0.0, 43.6, -38.52]],
      [8.37, [-0.004, 0.003, 8.371]],
      [-316.77, [-622.3, 321.93, -16.4]],
      [1.9, [23.7, 0, -21.8]],
      [0.02, [5.11, -5.09, 0]],
      [9.97, [12.31, -2.34, 0]],
      [-89.54, [-139.3, 46.6, 3.16]],
    ];
    for (const [total, parts] of cases) {
      const { step, values } = splitExact(total, parts);
      expect(step).toBe(Math.abs(total) < 10 ? 0.1 : 1);
      const shown = parse(formatMan(total));
      const sum = values.map((v) => parse(formatManStep(v, step))).reduce((a, b) => a + b, 0);
      expect(Math.round(sum * 10) / 10).toBe(shown);
      // どの内訳も元の値から 1 刻み未満しか動かない
      values.forEach((v, i) => expect(Math.abs(v - parts[i]!)).toBeLessThan(step + 1e-9));
    }
    expect(formatManStep(-0.04, 0.1)).toBe("±0");
    expect(formatManStep(3, 0.1)).toBe("+3万");
    expect(formatManStep(-42.2, 0.1)).toBe("−42.2万");
    expect(formatManStep(1240, 1)).toBe("+1,240万");
  });

  it("領域の札（プロジェクトから。今のままは基準の札。文書に無い領域は既定の色）", () => {
    const doc = createEmptyDoc();
    const p = makeProject({ id: "p_spelldash", name: "SpellDash事業", color: "#FF7A59" });
    doc.projects[p.id] = p;
    expect(areaOf(makeNode({ projectIds: ["p_spelldash"] }), doc)).toEqual({ key: "sd", label: "SpellDash", color: "#FF7A59" });
    expect(areaOf(makeNode({ projectIds: ["p_fcmarketing"] }), doc)).toEqual({ key: "fc", label: "本業", color: "#22D3EE" });
    expect(areaOf(makeNode({ projectIds: ["p_spelldash", "p_fcmarketing"], meta: { base: true } }), doc)?.label).toBe("今のまま");
    expect(areaOf(makeNode({ projectIds: ["p_spelldash", "p_fcmarketing"] }), doc)).toBeNull();
    expect(areaOf(makeNode({ projectIds: ["p_unknown"] }), doc)).toBeNull();
    expect(breakdownAreas(doc).map((a) => a.label)).toEqual(["本業", "広告運用・独立", "SpellDash"]);
  });

  it("2 行目（悪くなる・3 年後の月・週の時間）", () => {
    expect(altMetaLine({ pBad: 0.25, worst: -20.4, dR: 2.06 }, 3)).toBe("悪くなる 25%（悪くて −20万）· 3年後 月+2.1万 · 週+3h");
    // いちばん悪くても今のまま以上なら括弧は付けない（行を短く）
    expect(altMetaLine({ pBad: 0, worst: 6.7, dR: 0.79 }, 3)).toBe("悪くなる 0% · 3年後 月+0.8万 · 週+3h");
    expect(altMetaLine({ pBad: null, worst: null, dR: null }, null)).toBe("");
    expect(altMetaParts({ pBad: 0.25, worst: -20.4, dR: 2.06 }, 3)).toEqual(["悪くなる 25%（悪くて −20万）", "3年後 月+2.1万", "週+3h"]);
    expect(riskShort(1, -380.7)).toBe("悪くなる 100%（悪くて −381万）");
    expect(riskShort(0, -0.01)).toBe("悪くなる 0%");
    expect(riskText(0.25, -20)).toBe("悪くなる見込み 25%（悪くて −20 万円）");
    expect(riskText(0, -0.01)).toBe("悪くなる見込み 0%（最悪でも ±0）");
    expect(hoursShort(-2)).toBe("週−2h");
    expect(hoursShort(0)).toBe("週±0h");
    expect(hoursText(3)).toBe("週の時間 +3 時間（今は 52 時間）");
  });

  it("見出しは 3 つの形（おすすめ・自分で選んだ手・方針）", () => {
    const base = { horizon: 36, value: 1423.2, statusQuo: 1130.4, best: 1423.2, picks: false, scenario: null };
    expect(headlineOf(base)).toEqual({ main: "おすすめの選び方で 3 年 1,423 万円", lead: "おすすめの選び方で 3 年", value: "1,423 万円", vsBest: "", sub: "ずっと今のままなら 1,130 万円（差 +293 万円）", label: "おすすめ" });
    expect(headlineOf({ ...base, value: 1380, picks: true })?.main).toBe("あなたの選び方で 3 年 1,380 万円（おすすめとの差 −43 万円）");
    expect(headlineOf({ ...base, value: 1277, scenario: "早期独立" })?.main).toBe("早期独立の方針だと 3 年 1,277 万円（おすすめとの差 −146 万円）");
    expect(headlineOf({ ...base, value: 1277, scenario: "早期独立", picks: true })?.label).toBe("早期独立の方針");
    expect(headlineOf({ ...base, value: null })).toBeNull();
  });

  it("年収の入れ替わり・年収の入力・段の言葉", () => {
    const t = (id: string) => ({ a: "転職活動をする", b: "届け出て副業の 1 社目を探す" })[id] ?? id;
    expect(flipTexts({ above: { annual: 540, alt: "a" }, below: { annual: 320, alt: "b" } }, t)).toEqual(["年収 540 万円より上なら『転職活動をする』がいちばん", "年収 320 万円より下なら『届け出て副業の 1 社目を探す』がいちばん"]);
    expect(flipTexts({ above: null, below: null }, t)).toEqual([]);
    expect(parseAnnual("540")).toBe(540);
    expect(parseAnnual("１，２００万円")).toBe(1200);
    expect(parseAnnual(" 480 万 ")).toBe(480);
    expect(parseAnnual("99")).toBeNull();
    expect(parseAnnual("3001")).toBeNull();
    expect(parseAnnual("abc")).toBeNull();
    expect(parseAnnual("")).toBeNull();
    expect(binRangeText(0)).toBe("±3万未満");
    expect(binRangeText(2)).toBe("+30〜100万");
    expect(binRangeText(-4)).toBe("−300万以下");
    expect(binRangeText(4)).toBe("+300万以上");
  });

  it("差の棒は 0 を含む範囲で、0 から値までを描く", () => {
    const d = divergingDomain([68.8, -316.8, 0, null]);
    expect(d).toEqual({ lo: -316.8, hi: 68.8 });
    const pos = divergingBar(68.8, d);
    expect(pos.zero).toBeCloseTo(316.8 / 385.6, 9);
    expect(pos.left).toBeCloseTo(pos.zero, 9);
    expect(pos.left + pos.width).toBeCloseTo(1, 9);
    const neg = divergingBar(-316.8, d);
    expect(neg.left).toBe(0);
    expect(neg.width).toBeCloseTo(pos.zero, 9);
    expect(divergingDomain([0, 0])).toEqual({ lo: 0, hi: 1 });
    expect(divergingDomain([5, 10])).toEqual({ lo: 0, hi: 10 });
  });

  it("目印は今日からの結果の線を順に（どの場合もこの道は文なし）", () => {
    const doc = createEmptyDoc();
    const add = (id: string, due: string) => (doc.nodes[id] = makeNode({ id, title: id, time: { due, start: null } }));
    add("R", "2026-11-18");
    add("A", "2027-02-28");
    add("S", "2027-02-28");
    add("B", "2027-11-30");
    add("E", "2029-11-30");
    const edge = (id: string, source: string, target: string, relation: "leads" | "condition", condition = "", label = "") => (doc.edges[id] = makeEdge({ id, source, target, relation, condition, label }));
    edge("e1", "R", "A", "leads");
    edge("e2", "A", "S", "condition", "会社の答えが『副業も SpellDash も可』", "全部可");
    edge("e3", "S", "B", "leads");
    edge("e4", "B", "E", "condition", "（どの場合もこの道）");
    const idx = buildIndex(doc);
    const chance = new Set(["A", "B"]);
    const steps = trailOf(doc, idx.inc, "E", (id) => chance.has(id));
    expect(steps).toEqual([
      { alt: "A", edge: "e2", node: "S", line: "会社の答えが『副業も SpellDash も可』", label: "全部可", when: "2027年2月" },
      { alt: "B", edge: "e4", node: "E", line: "", label: "", when: "2029年11月" },
    ]);
    expect(trailOf(doc, idx.inc, "R", (id) => chance.has(id))).toEqual([]);
    // 範囲の外へは出ない・循環で止まる
    edge("e5", "E", "R", "leads");
    expect(trailOf(doc, buildIndex(doc).inc, "E", (id) => chance.has(id), (id) => id !== "E").length).toBe(2);
  });

  it("同梱の地図: 今日の選択肢の 2 行目・内訳・目印が組み立てられる", () => {
    const doc = buildImpactDoc(futureData(), new Date(2026, 10, 18), "t");
    const idx = buildIndex(doc);
    const res = computeImpact(doc, idx.out, computeForecast(doc, idx.out), null);
    const root = res.decision.get(res.root!)!;
    expect(root.alts.length).toBe(10);
    for (const id of root.alts) {
      const a = res.alt.get(id)!;
      const n = doc.nodes[id]!;
      expect(areaOf(n, doc)).not.toBeNull();
      const meta = altMetaLine(a, typeof n.meta.h === "number" ? n.meta.h : null);
      expect(meta).toMatch(/^悪くなる \d+%(（悪くて −[^）]+）· | · )3年後 月[^ ]+ · 週[^ ]+h$/);
      if (a.delta !== null && a.deltaV) {
        const { step, values } = splitExact(a.delta, a.deltaV);
        const sum = values.map((v) => parse(formatManStep(v, step))).reduce((x, y) => x + y, 0);
        expect(Math.round(sum * 10) / 10).toBe(parse(formatMan(a.delta)));
      }
    }
    // いちばん多い行き先の目印は今日から 3 つ（3 か月後・1 年後・3 年後）
    const end = res.ends[0]!.id;
    const steps = trailOf(doc, idx.inc, end, (id) => res.kind.get(id) === "chance", (id) => res.scope.has(id));
    expect(steps.length).toBe(3);
    expect(steps.map((s) => s.when)).toEqual(["2027年2月", "2027年11月", "2029年11月"]);
    expect(steps[2]!.node).toBe(end);
    expect(stateLine(doc.nodes[end]!.meta.st, doc.nodes[end]!.meta.rr)).toMatch(/^(会社員|週 4 日勤務|独立)/);
  });
});
