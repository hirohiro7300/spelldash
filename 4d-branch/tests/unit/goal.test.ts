// 資産のゴールの計算（src/model/goal.ts）: 設定の読み方・年ごとの係数と 1 か月ずつの足し算・届く年・要る積立と伸び・手立て・文の書き方
// 数はどれも丸めた仮の数（本当の資産や稼ぎは使わない）

import { describe, expect, it } from "vitest";
import {
  assetsAt,
  assetsAtBy,
  assetsAtRet,
  bandTables,
  BIZ_MIN,
  byYearOf,
  DEFAULT_GOAL,
  formatGrowth,
  formatManMonthly,
  formatOku,
  formatTimes,
  G_MAX,
  G_MIN,
  GOAL_BASIS_NOTE,
  GOAL_YEARS,
  goalAnchor,
  goalBadge,
  goalBand,
  goalConfigOf,
  goalFrameLine,
  goalLeaf,
  goalLeafLine,
  goalLeverLines,
  goalLevers,
  goalPremiseLine,
  goalSeedNote,
  goalStored,
  GOAL_KEYS,
  monthlyFromToday,
  okuRange,
  REACH_CAP_Y,
  reachYearOf,
  savingNeeded,
  SEED_BIZ,
  tablesFor,
  targetToday,
  type GoalConfig,
  type GoalInput,
  type GoalKey,
  type GoalTables,
} from "../../src/model/goal";
import { goalConfigOf as fromForks } from "../../src/model/forks";
import { spacingIssues } from "../../scripts/impact/textChecks";
import { spaceJa } from "../../src/demo/compose/text";

const ANCHOR = goalAnchor("2026-11");
const cfg = (over: Partial<GoalConfig> = {}): GoalConfig => ({ ...DEFAULT_GOAL, ...over });
const leafIn = (T3: number, Rsal: number, Rbiz: number): GoalInput => ({ T3, Rsal, Rbiz, split: true });

/** 1 か月ずつ足す（36 か月目までは真ん中の月にまとめる。そこから months か月） */
function sim(c: GoalConfig, x: GoalInput, months: number, over: { ret?: number; g?: number; save36?: number } = {}): number {
  const q = Math.pow(1 + (over.ret ?? c.ret) / 100, 1 / 12);
  const h = Math.pow(1 + (over.g ?? c.bizGrow) / 100, 1 / 12);
  const s = c.save / 100;
  let A = c.assets * Math.pow(q, 36) + s * x.T3 * Math.pow(q, 18);
  for (let k = 0; k < months; k++) A = A * q + (over.save36 ?? s * (x.Rsal + x.Rbiz * Math.pow(h, k)));
  return A;
}

const rel = (a: number, b: number): number => Math.abs(a - b) / Math.max(1, Math.abs(b));

describe("ゴールの設定を読む", () => {
  it("入れていなければ仮の値（今の資産は 0）。どの鍵も仮", () => {
    expect(DEFAULT_GOAL.assets).toBe(0);
    expect(DEFAULT_GOAL.target).toBe(100_000);
    const r = goalConfigOf(undefined);
    expect(r.cfg).toEqual(DEFAULT_GOAL);
    expect([...r.assumed].sort()).toEqual(["assets", "bizGrow", "by", "ret", "save", "target"]);
    expect(goalConfigOf({ meta: {} }).cfg).toEqual(DEFAULT_GOAL);
    // 版の違う物・配列は読まない
    expect(goalConfigOf({ meta: { goal: { v: 2, assets: 500 } } }).cfg.assets).toBe(0);
    expect(goalConfigOf({ meta: { goal: [1, 2] } }).cfg).toEqual(DEFAULT_GOAL);
    expect(fromForks).toBe(goalConfigOf);
  });

  it("知らない鍵は捨て、数でない物は仮のまま、範囲に収める。今の資産は目標より大きくてもよい", () => {
    const r = goalConfigOf({ meta: { goal: { v: 1, assets: 500_000, save: 150, ret: Number.NaN, bizGrow: -50, by: 2040.6, target: 10, extra: 5, name: "x" } } });
    expect(r.cfg).toEqual({ target: 1_000, assets: 500_000, save: 100, ret: 3, bizGrow: -10, by: 2041 });
    expect([...r.assumed]).toEqual(["ret"]);
    expect(goalConfigOf({ meta: { goal: { v: 1, assets: "500", ret: Infinity } } }).assumed.has("assets")).toBe(true);
    expect(goalStored({ assets: 500, save: 25, ret: null, by: undefined })).toEqual({ v: 1, assets: 500, save: 25 });
    expect(JSON.stringify(goalStored({ assets: 500, save: 25, ret: 4 })).length).toBeLessThan(60);
  });

  it("期限は 0 か月目の年 + 30。入れた年は + 4〜80 に収める", () => {
    expect(byYearOf(cfg(), 2026)).toBe(2056);
    expect(byYearOf(cfg({ by: 2027 }), 2026)).toBe(2030);
    expect(byYearOf(cfg({ by: 2200 }), 2026)).toBe(2106);
    expect(tablesFor(cfg({ by: 2028 }), ANCHOR).K).toBe(12);
  });

  it("地図に年月が無ければ今月から数える（時計は渡した物）", () => {
    expect(goalAnchor("2026-11")).toEqual({ y: 2026, mo: 11, clock: false });
    expect(goalAnchor(null, () => new Date(2027, 2, 15))).toEqual({ y: 2027, mo: 3, clock: true });
    expect(goalAnchor("2026-13", () => new Date(2027, 0, 1)).clock).toBe(true);
  });
});

describe("年ごとの係数", () => {
  const x = leafIn(1000, 30, 10);
  for (const ret of [0, 3, 7])
    for (const g of [-2, 0, 5])
      it(`利回り ${ret}%・事業の伸び ${g}%: 1 か月ずつ足した資産と 1e-9 まで同じ（どの年も）`, () => {
        const c = cfg({ assets: 500, ret, bizGrow: g, save: 25 });
        const t = tablesFor(c, ANCHOR);
        for (const j of [0, 1, 5, 30, GOAL_YEARS - 1]) expect(rel(assetsAt(t, j, x.T3, x.Rsal, x.Rbiz), sim(c, x, j * 12))).toBeLessThan(1e-9);
      });

  it("利回りと事業の伸びが同じでも同じ式", () => {
    const c = cfg({ assets: 1000, ret: 5, bizGrow: 5 });
    const t = tablesFor(c, ANCHOR);
    expect(rel(assetsAtBy(t, 5000, 40, 20), sim(c, leafIn(5000, 40, 20), t.K))).toBeLessThan(1e-9);
  });

  it("同じ設定なら同じ表（直近の 4 つまで）。利回りの幅の表は利回りだけが違う", () => {
    const c = cfg({ assets: 500 });
    const t = tablesFor(c, ANCHOR);
    expect(tablesFor({ ...c }, ANCHOR)).toBe(t);
    for (let k = 0; k < 4; k++) tablesFor(cfg({ save: 10 + k }), ANCHOR);
    expect(tablesFor(c, ANCHOR)).not.toBe(t);
    const [lo, hi] = bandTables(t);
    expect(lo.cfg.ret).toBe(1);
    expect(hi.cfg.ret).toBe(5);
    expect(lo.by).toBe(t.by);
    const x2 = leafIn(1000, 30, 10);
    const [a, b] = goalBand(t, x2);
    expect(a).toBeLessThan(assetsAtBy(t, 1000, 30, 10));
    expect(b).toBeGreaterThan(assetsAtBy(t, 1000, 30, 10));
    expect(rel(b, sim(cfg({ assets: 500, ret: 5 }), x2, t.K))).toBeLessThan(1e-9);
  });

  it("3 年の間の積立を真ん中の月にまとめた目安は、1 か月ずつ足した物と 1% の内（利回り 5% まで）", () => {
    for (const ret of [0, 1, 3, 5]) {
      const q = Math.pow(1 + ret / 100, 1 / 12);
      // 月の稼ぎが 25 から 45 へ直線で伸びる 36 か月
      let exact = 0;
      let T3 = 0;
      for (let m = 0; m < 36; m++) {
        const e = 25 + (20 * m) / 35;
        T3 += e;
        exact = exact * q + 0.2 * e;
      }
      const t = tablesFor(cfg({ ret }), ANCHOR);
      expect(rel(t.beta[0]! * T3, exact)).toBeLessThan(0.01);
    }
  });
});

describe("届く年・要る積立・要る伸び", () => {
  it("今日から毎月積み立てる額（10 億円・30 年）: 5% 123・4% 146・3% 173、40 年・7% 40", () => {
    expect(Math.round(monthlyFromToday(100_000, 30, 5))).toBe(123);
    expect(Math.round(monthlyFromToday(100_000, 30, 4))).toBe(146);
    expect(Math.round(monthlyFromToday(100_000, 30, 3))).toBe(173);
    expect(Math.round(monthlyFromToday(100_000, 40, 7))).toBe(40);
    expect(monthlyFromToday(1200, 10, 0)).toBe(10);
  });

  it("届く年は年ごとに前から探した物と同じ。届かなければ null と 80 年後の資産", () => {
    const c = cfg({ assets: 5000, ret: 5, save: 30 });
    const t = tablesFor(c, ANCHOR);
    for (const [T3, Rsal, Rbiz] of [
      [1000, 30, 10],
      [5000, 50, 60],
      [1000, 30, -2],
      [-100, 30, 10],
    ] as const) {
      let want: number | null = null;
      for (let j = 0; j < GOAL_YEARS; j++)
        if (assetsAt(t, j, T3, Rsal, Rbiz) >= t.T) {
          want = t.y36 + j;
          break;
        }
      expect(reachYearOf(t, T3, Rsal, Rbiz)).toBe(want);
    }
    const t0 = tablesFor(cfg(), ANCHOR);
    const leaf = goalLeaf(t0, leafIn(1000, 30, 10));
    expect(leaf.reachYear).toBeNull();
    expect(leaf.atCap).toBeCloseTo(assetsAt(t0, GOAL_YEARS - 1, 1000, 30, 10), 9);
    expect(t0.y36 + GOAL_YEARS - 1).toBe(2026 + REACH_CAP_Y);
    // 届く年は資産について増える（今の資産を増やすと早まる）
    let prev = Infinity;
    for (const assets of [0, 10_000, 30_000, 60_000, 100_000]) {
      const y = reachYearOf(tablesFor(cfg({ assets }), ANCHOR), 1000, 30, 10) ?? Infinity;
      expect(y).toBeLessThanOrEqual(prev);
      prev = y;
    }
    // 今の資産がもう目標以上なら 0 か月目の年
    expect(goalLeaf(tablesFor(cfg({ assets: 120_000 }), ANCHOR), leafIn(1000, 30, 10)).reachYear).toBe(2026);
  });

  it("36 か月目より前に届く人には、その年を言う（3 年後の年まで遅らせない）", () => {
    // 今の資産 9.8 億・利回り 3%・稼ぎ 0: 1 年後に 9.8 × 1.03 = 10.09 億で届く
    const t = tablesFor(cfg({ assets: 98_000, target: 100_000, ret: 3 }), goalAnchor("2026-11"));
    expect(reachYearOf(t, 0, 0, 0)).toBe(2027);
    const leaf = goalLeaf(t, leafIn(0, 0, 0));
    expect(goalBadge(t, leaf)).toBe("10 億: 2027 年・目安");
    expect(goalLeafLine(t, leafIn(0, 0, 0), leaf, null)).toContain("2027 年に届く目安です。");
    // 3 年の積立の分も数える（k 年後は 3 年の稼ぎの k/3 を真ん中の月に）: 今の資産 9.4 億・3 年で 9,000 万円の稼ぎの 20% を積立
    const t2 = tablesFor(cfg({ assets: 94_000, target: 100_000, ret: 3, save: 20 }), goalAnchor("2026-11"));
    const A1 = 94_000 * 1.03 + (0.2 * 9_000 * Math.pow(1.03, 0.5)) / 3;
    const A2 = 94_000 * Math.pow(1.03, 2) + (0.2 * 9_000 * 2 * Math.pow(1.03, 1)) / 3;
    expect(A1).toBeLessThan(100_000);
    expect(A2).toBeGreaterThan(100_000);
    expect(94_000 * Math.pow(1.03, 2)).toBeLessThan(100_000);
    expect(reachYearOf(t2, 9_000, 0, 0)).toBe(2028);
    expect(reachYearOf(t2, 0, 0, 0)).toBe(2029);
    // 3 年後の年より後なら、表のまま（前の年は見ない）
    const t3 = tablesFor(cfg({ assets: 50_000, target: 100_000, ret: 3 }), goalAnchor("2026-11"));
    expect(reachYearOf(t3, 0, 0, 0)).toBe(2026 + 3 + Math.ceil(Math.log(2) / Math.log(1.03) - 3));
  });

  it("要る積立を 3 年後から続けると期限にちょうど届く。0 以下なら積立なしでも届く", () => {
    for (const ret of [0, 3, 7]) {
      const c = cfg({ assets: 500, ret });
      const t = tablesFor(c, ANCHOR);
      const cReq = savingNeeded(t, 1000);
      expect(rel(sim(c, leafIn(1000, 0, 0), t.K, { save36: cReq }), t.T)).toBeLessThan(1e-9);
    }
    const rich = tablesFor(cfg({ assets: 50_000, ret: 5 }), ANCHOR);
    expect(savingNeeded(rich, 1000)).toBeLessThanOrEqual(0);
  });

  it("要る事業の伸びで伸ばすと期限にちょうど届く（刻みの間は直線で埋めるので 0.5% の内）。給与だけの道は Infinity", () => {
    const c = cfg({ assets: 500, ret: 3 });
    const t = tablesFor(c, ANCHOR);
    const x = leafIn(1000, 30, 10);
    const g = goalLeaf(t, x).gReq;
    expect(g).toBeGreaterThan(G_MIN);
    expect(g).toBeLessThan(G_MAX);
    expect(rel(sim(c, x, t.K, { g }), t.T)).toBeLessThan(0.005);
    expect(sim(c, x, t.K, { g: g - 0.5 })).toBeLessThan(t.T);
    expect(sim(c, x, t.K, { g: g + 0.5 })).toBeGreaterThan(t.T);
    const sal = goalLeaf(t, leafIn(1000, 40, BIZ_MIN / 2));
    expect(sal.gReq).toBe(Infinity);
    expect(sal.salaryOnly).toBe(true);
    expect(sal.seed).toBe(false);
    // 内訳の無い行き先は芽も伸びも出さない
    const tot = goalLeaf(t, { T3: 1000, Rsal: 40, Rbiz: 0, split: false });
    expect(Number.isNaN(tot.gReq)).toBe(true);
    expect(tot.salaryOnly).toBe(false);
    // 届いていれば伸びは G_MIN まで下がる。年 60% でも足りなければ Infinity
    expect(goalLeaf(tablesFor(cfg({ assets: 100_000 }), ANCHOR), x).gReq).toBe(G_MIN);
    expect(goalLeaf(tablesFor(cfg({ by: 2031 }), ANCHOR), x).gReq).toBe(Infinity);
    expect(goalLeaf(tablesFor(cfg({ save: 0 }), ANCHOR), x).gReq).toBe(Infinity);
  });

  it("芽は 3 年後の事業の稼ぎが SEED_BIZ 以上", () => {
    const t = tablesFor(cfg(), ANCHOR);
    expect(goalLeaf(t, leafIn(1000, 30, SEED_BIZ)).seed).toBe(true);
    expect(goalLeaf(t, leafIn(1000, 30, SEED_BIZ - 0.01)).seed).toBe(false);
  });

  it("手立て: 利回り・今すぐの資産・事業を売る、どれも期限にちょうど届く", () => {
    const c = cfg({ assets: 500 });
    const t = tablesFor(c, ANCHOR);
    const x = leafIn(1000, 30, 10);
    const leaf = goalLeaf(t, x);
    const lev = goalLevers(t, x, leaf);
    expect(lev.ret).not.toBeNull();
    expect(rel(assetsAtRet(t, x, lev.ret!), t.T)).toBeLessThan(1e-6);
    expect(rel(assetsAtRet(t, x, c.ret), leaf.atBy)).toBeLessThan(1e-9);
    // 今すぐの資産が lump なら届く
    const tl = tablesFor(cfg({ assets: lev.lump }), ANCHOR);
    expect(rel(assetsAtBy(tl, 1000, 30, 10), t.T)).toBeLessThan(1e-9);
    expect(lev.sale).toBeCloseTo((t.T - leaf.atBy) / 60, 9);
    expect(lev.growBiz).toBeCloseTo(10 * Math.pow(1 + lev.grow / 100, t.K / 12), 9);
    expect(lev.ratioEarn).toBeCloseTo(lev.save / 40, 9);
    expect(lev.ratioSave).toBeCloseTo(lev.save / (0.2 * 40), 9);
    // 届いていれば手立ては要らない
    const done = tablesFor(cfg({ assets: 200_000 }), ANCHOR);
    const dl = goalLevers(done, x);
    expect(dl.lump).toBeLessThan(200_000);
    expect(goalLeverLines(done, dl).some((l) => l.startsWith("今すぐ"))).toBe(false);
    expect(dl.sale).toBe(0);
    expect(dl.save).toBeLessThanOrEqual(0);
    // 物価が年 2% 上がると、30 年後の 10 億円は今の約 5.5 億円
    expect(formatOku(targetToday(t))).toBe("5.5 億円");
  });
});

describe("数と文の書き方", () => {
  it("億と万円", () => {
    expect(formatOku(100_000)).toBe("10 億円");
    expect(formatOku(4_500, true)).toBe("0.45 億円");
    expect(formatOku(4_500)).toBe("4,500 万円");
    expect(formatOku(3_000)).toBe("3,000 万円");
    expect(formatOku(31_000)).toBe("3.1 億円");
    expect(formatOku(120_000)).toBe("12 億円");
    expect(formatOku(12_345_678)).toBe("1,235 億円");
    expect(formatOku(50, true)).toBe("50 万円");
    expect(formatOku(-5)).toBe("0 万円");
    expect(formatManMonthly(201.4)).toBe("201 万円");
    expect(formatManMonthly(10.54)).toBe("10.5 万円");
    expect(formatManMonthly(1590.2)).toBe("1,590 万円");
    expect(formatManMonthly(-2)).toBe("−2 万円");
    expect(formatGrowth(20.3)).toBe("+20%");
    expect(formatGrowth(2.25)).toBe("+2.3%");
    expect(formatGrowth(-2)).toBe("−2%");
    expect(formatGrowth(0)).toBe("0%");
    expect(formatTimes(5)).toBe("5.0 倍");
    expect(formatTimes(25.4)).toBe("25 倍");
  });

  /** 地図のほかの文と同じ言葉の間か（spaceJa で変わらない・言葉の間の点検で指摘が無い） */
  const spaced = (s: string): void => {
    expect(spaceJa(s), s).toBe(s);
    expect(spacingIssues(s), s).toEqual([]);
  };

  const cases: [string, GoalConfig, GoalInput][] = [
    ["仮の値・芽のある行き先", cfg(), leafIn(1000, 30, 12)],
    ["給与だけの道", cfg({ assets: 500, save: 25 }), leafIn(1000, 40, 0)],
    ["届く", cfg({ assets: 60_000, ret: 5, bizGrow: 3, by: 2050 }), leafIn(5000, 50, 20)],
    ["年 60% でも足りない", cfg({ by: 2031 }), leafIn(1000, 30, 10)],
    ["目標 3,000 万円・事業が減る", cfg({ target: 3_000, bizGrow: -2 }), leafIn(1000, 30, 5)],
    ["内訳が無い", cfg(), { T3: 1000, Rsal: 40, Rbiz: 0, split: false }],
  ];
  for (const [name, c, x] of cases)
    it(`文の言葉の間と、3 年より先の数に目安か前提が付く: ${name}`, () => {
      const t = tablesFor(c, ANCHOR);
      const read = goalConfigOf({ meta: { goal: goalStored({ ...c, by: c.by ?? undefined }) } });
      const leaf = goalLeaf(t, x);
      const band = goalBand(t, x);
      const lines = [goalFrameLine(t), goalPremiseLine(t, read.assumed, band), goalPremiseLine(t, new Set(["assets", "ret"]), null), goalSeedNote(t), ...goalLeverLines(t, goalLevers(t, x, leaf)), goalLeafLine(t, x, leaf, band), goalLeafLine(t, x, leaf, null), goalBadge(t, leaf), GOAL_BASIS_NOTE];
      for (const s of lines) spaced(s);
      expect(goalLeafLine(t, x, leaf, band)).toContain("目安");
      expect(goalFrameLine(t)).toContain("目安");
      expect(goalPremiseLine(t, read.assumed, band)).toMatch(/^前提: /);
      for (const s of lines) expect(s).not.toMatch(/届く見込み 0%/);
    });

  it("前提の行: 入れていない物に（仮）。入れた物には付けない", () => {
    const t = tablesFor(cfg({ assets: 500, save: 25 }), ANCHOR);
    const read = goalConfigOf({ meta: { goal: { v: 1, assets: 500, save: 25 } } });
    const line = goalPremiseLine(t, read.assumed, goalBand(t, leafIn(1000, 30, 10)));
    expect(line).toContain("今の資産 500 万円・");
    expect(line).toContain("額面の 25% を積立・");
    expect(line).toContain("利回りは年 3%（仮、1〜5% なら ");
    expect(line).toContain("期限は 2056 年（仮）");
    expect(line).toContain("2056 年の 10 億円は今の約 5.5 億円");
  });

  it("地図が数える範囲の文（2029 年 11 月まで）。年月の無い地図は今月から数える", () => {
    expect(goalFrameLine(tablesFor(cfg(), ANCHOR))).toBe("地図が数えるのは 2029 年 11 月までの額面の稼ぎです。その先は「3 年後の月の稼ぎがそのまま続く」と置いた目安で、運・景気・税は入っていません。");
    const clock = goalAnchor(undefined, () => new Date(2027, 0, 10));
    expect(goalFrameLine(tablesFor(cfg({ bizGrow: 5 }), clock))).toContain("今月から数えて 2030 年 1 月まで");
  });

  it("札: 芽のある行き先は要る伸び、給与だけの道、届く年", () => {
    const t = tablesFor(cfg(), ANCHOR);
    // 36 か月目より先の数なので、数のある札には「・目安」
    expect(goalBadge(t, goalLeaf(t, leafIn(1000, 30, 12)))).toMatch(/^10 億: 事業が年 \+\d+%・目安$/);
    expect(goalBadge(t, goalLeaf(t, leafIn(1000, 40, 0)))).toBe("10 億: 給与だけでは届かない");
    const rich = tablesFor(cfg({ assets: 80_000, ret: 5 }), ANCHOR);
    expect(goalBadge(rich, goalLeaf(rich, leafIn(1000, 40, 0)))).toMatch(/^10 億: 20\d\d 年・目安$/);
    expect(goalBadge(t, goalLeaf(t, { T3: 1000, Rsal: 40, Rbiz: 0, split: false }))).toMatch(/^10 億: (\d+%|1% 未満)・目安$/);
  });

  it("前提の行と行き先の 1 文の利回りの幅: 両端の単位が違えば両方に付ける（「6,832〜1.3 億円」と読めないように）", () => {
    // 目標 5,000 万円（1 億より下）: 1 億から億で書く
    const t5 = tablesFor(cfg({ target: 5_000 }), ANCHOR);
    const all = new Set<GoalKey>(GOAL_KEYS);
    expect(goalPremiseLine(t5, all, [6832, 13000])).toContain("（仮、1〜5% なら 6,832 万円〜1.3 億円）");
    const x5 = leafIn(2500, 37, 46);
    expect(goalLeafLine(t5, x5, goalLeaf(t5, x5), [6832, 13000])).toContain("。利回り 1〜5% なら 6,832 万円〜1.3 億円）");
    // 目標 10 億: 100 万円から億で書く
    const t10 = tablesFor(cfg(), ANCHOR);
    expect(goalPremiseLine(t10, all, [67, 216])).toContain("1〜5% なら 67 万円〜0.02 億円）");
    // 同じ単位なら前の単位を落とす・同じ書き方なら 1 つ
    expect(goalPremiseLine(t10, all, [3300, 6400])).toContain("1〜5% なら 0.33〜0.64 億円）");
    expect(okuRange(5000, 5000, true)).toBe("0.5 億円");
    expect(okuRange(6832, 13000, false)).toBe("6,832 万円〜1.3 億円");
    // 億の幅は両端の小数の桁をそろえる（見直し reader-7）
    expect(okuRange(4000, 5200, true)).toBe("0.40〜0.52 億円");
    expect(okuRange(30000, 35000, true)).toBe("3.0〜3.5 億円");
    expect(okuRange(9500, 10400, true)).toBe("0.95〜1.04 億円");
    for (const s of [goalPremiseLine(t5, all, [6832, 13000]), goalPremiseLine(t10, all, [67, 216])]) spaced(s);
  });

  it("積立 0%・今の資産 0: 「0%」も「年 60% でも足りません」も出さない（事業の伸びは数えない）", () => {
    const t = tablesFor(cfg({ save: 0, assets: 0 }), ANCHOR);
    const x = leafIn(2000, 40, 30);
    const leaf = goalLeaf(t, x);
    expect(leaf.atBy).toBe(0);
    const lines = [goalBadge(t, leaf), goalLeafLine(t, x, leaf, goalBand(t, x)), goalLeafLine(t, x, leaf, null), ...goalLeverLines(t, goalLevers(t, x, leaf))];
    for (const s of lines) {
      expect(s).not.toMatch(/(^|[^\d.])0%/);
      expect(s).not.toContain("60% でも足りません");
      expect(s).not.toContain("60% 伸び続けても足りません");
      spaced(s);
    }
    expect(goalBadge(t, leaf)).toBe("10 億: 積立なしの前提");
    expect(goalLeafLine(t, x, leaf, goalBand(t, x))).toContain("積み立てない前提なので、資産は利回りだけで増えます。届くには、3 年後から毎月 ");
    expect(goalLeafLine(t, x, leaf, goalBand(t, x))).not.toContain("0〜0");
    // 伸びの行は出さない（積立の行は出す）
    const lev = goalLeverLines(t, goalLevers(t, x, leaf));
    expect(lev.some((s) => s.includes("事業の稼ぎが"))).toBe(false);
    expect(lev.some((s) => s.startsWith("毎月 "))).toBe(true);
  });
});

// 型の確かめ（表の鍵は設定と 0 か月目）
export type _T = GoalTables;
