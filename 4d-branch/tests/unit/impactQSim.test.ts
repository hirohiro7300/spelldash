// 3 か月ごとの地図の計算（scripts/impact/q）: 世界の作り替え・暦・3 か月の手の決まり（P2 の前提）・結果のまとめ方・入口の引数。粗い表は作らない（速い）
import { describe, expect, it } from "vitest";
import worldJson from "../../scripts/impact/world.json";
import { simulate, type St, type World } from "../../scripts/impact/sim";
import { calendarCheck, calendarOf, DEFAULT_ANCHOR, ymOf } from "../../scripts/impact/q/calendar";
import { parseArgs } from "../../scripts/impact/q/cli";
import { coarseKey, collapsed, OutcomeCache, quarterOutcomes, repState, type Roll } from "../../scripts/impact/q/core";
import { calibrate, CODE, DEFAULTS, Heap, planBudget, qOf, R1_ALTS_BY, type PassStats, type SinkCfg } from "../../scripts/impact/q/gen";
import { bandOf, clientDist, clientMode, distQuantiles, groupOutcomesQ } from "../../scripts/impact/q/group";
import { CONT_EVENTS, contEvent, contOf, leavesOf, mixOf, paidSal } from "../../scripts/impact/q/outputs";
import { feasibleQ, LIMITS, uses } from "../../scripts/impact/q/quarter";
import { binomP, bookStats, offerScale, runRateQ, setBook, simQ, toQ, type Comp, type QSample, type QSt } from "../../scripts/impact/q/sim";
import { CHANGES, NSTAGE, quarterWorld, type WorldQ } from "../../scripts/impact/q/world";

const base = worldJson as unknown as World;
const w: WorldQ = quarterWorld(base);
const S = w.annual / 12;
const q = w.q.churnQ;
/** 状態（顧客は n = [3 万円, 5 万円, 7 万円の社数]） */
const st = (over: Partial<St> = {}, n: [number, number, number] = [0, 0, 0], f5: 0 | 1 = 0): QSt => setBook(w, { ...w.today, fl: [], ...over, cl: 0, fee: 0, cb: [] }, [{ n, f5, w: 1 }]);
const withFlags = (s: QSt, ...f: string[]): QSt => ({ ...s, fl: [...new Set([...s.fl, ...f])].sort() });
const total = (xs: QSample[], f: (x: QSample) => boolean = () => true) => xs.filter(f).reduce((a, x) => a + x.w, 0);
const moved = (x: QSample) => x.x.fl.includes("switched");
const mean = (xs: QSample[], f: (x: QSample) => number) => xs.reduce((a, x) => a + f(x) * x.w, 0) / total(xs);

describe("3 か月ごとの世界", () => {
  it("12 段（0・3・…・33 か月目）で、どの手も 3 か月", () => {
    expect(w.stages.map((s) => s.month)).toEqual(Array.from({ length: NSTAGE }, (_, i) => 3 * i));
    expect(w.stages.every((s) => s.len === 3 && s.maxOuts === 3)).toBe(true);
    expect(w.stages[0]!.maxAlts).toBe(10);
  });

  it("2 年の進め方は無く、転職活動を続ける手が最後に足される。sd_pro は出さない", () => {
    expect(Object.keys(w.kinds).filter((k) => k.startsWith("plan_"))).toEqual([]);
    expect(Object.keys(w.kinds).at(-1)).toBe("fc_switch2");
    const sw = w.kinds.fc_switch!;
    const sw2 = w.kinds.fc_switch2!;
    expect(sw2.label).toBe("転職活動を続ける");
    expect([sw2.area, sw2.family, sw2.hours, sw2.scen, sw2.p]).toEqual([sw.area, sw.family, sw.hours, sw.scen, sw.p]);
    for (const [k, d] of Object.entries(w.kinds)) expect(d.stages).toEqual(k === "sd_pro" ? [] : w.stages.map((s) => s.month));
    expect(CHANGES.length).toBe(11);
  });

  it("続けた 3 期で、前の 9 か月の手の見込み（移る 45%: 1.18 倍 20%・1.08 倍 25%）になる", () => {
    const p = w.kinds.fc_switch!.p;
    const first = p.pHigh3! + p.pMid3!;
    const cont = w.qSwitch2.pHigh + w.qSwitch2.pMid;
    expect(1 - (1 - first) * (1 - cont) ** 2).toBeCloseTo(0.45, 2);
    expect(p.pHigh3! + (1 - first) * w.qSwitch2.pHigh * (1 + (1 - cont))).toBeCloseTo(0.2, 2);
    expect(p.pMid3! + (1 - first) * w.qSwitch2.pMid * (1 + (1 - cont))).toBeCloseTo(0.25, 2);
  });

  it("P2 の数: 顧客が 3 か月で離れる 1 − 0.96³・副業の月額 3 万円→4 社から 5 万円・転職活動は 4 期まで続けて 2 期まで", () => {
    expect(q).toBeCloseTo(1 - 0.96 ** 3, 12);
    expect(w.q).toMatchObject({ feeFirst: 3, feeRaised: 5, raiseAt: 4, searchMax: 4, searchRun: 2 });
    expect(w.constants.indFee).toBe(7);
    expect(w.constants.sideFee).toBe(3);
  });

  it("元の世界（同梱の版 6 の元）は変えない", () => {
    const before = JSON.stringify(base);
    quarterWorld(base, "2027-04");
    expect(JSON.stringify(base)).toBe(before);
    expect(Object.keys(base.kinds)).toContain("plan_ind");
    expect([base.constants.sideFee, base.constants.aprilMonths]).toEqual([5, [5, 17, 29]]);
  });

  it("前提の文（見方）: 3 か月ごとの手・転職活動の上限と週の時間・引き継ぎ・月額・離れ方・Pro の無料の月・3 か月ごとの見込み・地図の年月", () => {
    const text = w.premises.join("\n");
    expect(w.premises).toContain("3 か月ごとに選ぶ手は 1 つ（12 回）。会社への届け出は届け出を含む手でだけ行い、転職活動と同じ 3 か月にはしない");
    for (const s of [
      "28%（給与 1.18 倍 10%・1.08 倍 18%）",
      "12.6%（7.4%・5.2%）",
      "1 つの会社で 4 期（12 か月）まで、続けるのは 2 期まで",
      "給与の半月分",
      "週 5 時間は稼ぎに数えていない",
      "全部可の会社（20%）",
      "SpellDash を認める会社（65%）",
      "届け出なしで『SpellDash だけ可』",
      "月 3 万円",
      "月 5 万円（今の顧客は据え置く）",
      "月 7 万円",
      "11.5%",
      "初回 1 か月無料",
      "3 か月ごとに 60%",
      "3 か月ごとに 10%（試用があれば 15%）",
      "4 月を含む 3 か月だけ",
      "3 か月ごとに引き直す",
      "2026 年 11 月時点",
      "2029 年 11 月",
      "2027 年 4 月から毎年",
    ])
      expect(text).toContain(s);
    // 英数字の名前（手の id など）を書かない
    expect(text).not.toMatch(/fc_|sd_|ad_|ind_|keep|plan_/);
  });
});

describe("暦は地図の年月から（truth-12）", () => {
  it("4 月・昇格を狙える段・賞与の月・確定申告の月", () => {
    expect(DEFAULT_ANCHOR).toBe("2026-11");
    const c = calendarOf("2026-11");
    expect(c.aprilMonths).toEqual([5, 17, 29]);
    expect(c.promoStages).toEqual([1, 5, 9]);
    expect(c.schoolYearStarts).toEqual([5, 17, 29]);
    expect(c.bonusMonths).toEqual([1, 7, 13, 19, 25, 31]);
    expect(c.taxMonths).toEqual([3, 4, 15, 16, 27, 28]);
    expect(calendarOf("2026-12").aprilMonths).toEqual([4, 16, 28]);
    expect(calendarOf("2027-04").aprilMonths).toEqual([12, 24, 36]);
    expect(calendarOf("2027-03").aprilMonths).toEqual([1, 13, 25]);
    expect(ymOf({ y: 2026, m: 11 }, 36)).toEqual({ y: 2029, m: 11 });
    expect(ymOf({ y: 2026, m: 11 }, 2)).toEqual({ y: 2027, m: 1 });
  });

  it("点検: (anchorMonth + a) mod 12 = 4 で漏れが無い", () => {
    for (let m = 1; m <= 12; m++) {
      const a = `2026-${String(m).padStart(2, "0")}`;
      const months = calendarOf(a).aprilMonths;
      expect(calendarCheck(a, months)).toEqual([]);
      for (const x of months) expect((m + x) % 12).toBe(4);
    }
    expect(calendarCheck("2026-11", [5, 17, 30]).length).toBe(2);
    expect(calendarCheck("2026-11", [5, 17]).length).toBe(1);
  });

  it("世界の 4 月と昇格を狙える 3 か月は年月で変わる", () => {
    const d = quarterWorld(base, "2026-12");
    expect(d.anchor).toBe("2026-12");
    expect(d.constants.aprilMonths).toEqual([4, 16, 28]);
    const today = toQ(d, d.today);
    expect(feasibleQ(d, today, "fc_push", 3)).toBe(true);
    expect(feasibleQ(d, today, "fc_push", 6)).toBe(false);
    expect(feasibleQ(w, toQ(w, w.today), "fc_push", 6)).toBe(false);
    expect(feasibleQ(w, toQ(w, w.today), "fc_push", 3)).toBe(true);
    // 4 月の昇給は 4 月の月に入る
    const sal = (ww: WorldQ, m0: number) => simQ(ww, toQ(ww, ww.today), "keep", m0)[0]!.x.sal;
    expect(sal(d, 3)).toBeCloseTo(1.03, 12);
    expect(sal(d, 0)).toBe(1);
    expect(d.premises.join("")).toContain("2026 年 12 月時点");
  });
});

describe("元の計算と同じところ（前提が変わらない手）", () => {
  it("顧客も Pro も無い今日の状態では、元の 3 か月の計算（../sim.ts）と同じ数え上げ", () => {
    const today = toQ(w, w.today);
    const old = { ...base, constants: { ...base.constants, aprilMonths: [5, 17, 29] } };
    for (const [kind, m0] of [["keep", 0], ["sd_grow", 0], ["sd_pilot", 0], ["fc_scope", 0], ["part", 0], ["fc_push", 3], ["ad_portfolio", 0]] as const) {
      const a = simQ(w, today, kind, m0);
      const b = simulate(old, w.today, kind, m0, 3);
      expect(a.length, kind).toBe(b.length);
      a.forEach((x, i) => {
        const y = b[i]!;
        expect(x.w, kind).toBeCloseTo(y.w, 12);
        expect(x.r, kind).toEqual(y.r);
        expect(x.tag).toBe(y.tag);
        const { cb: _cb, fl: _fl, ...xs } = x.x;
        const { fl: _f2, ...ys } = y.x;
        expect(xs, kind).toEqual(ys);
      });
    }
  });

  it("Pro は初回 1 か月無料: その月に有料になった人は翌月から払う（元の計算より、最後の月の有料の人の 1 か月分少ない）", () => {
    // 『SpellDash だけ可』で Pro がまだ: 2 か月目に出す
    const s0 = st({ pm: "s", mau: 400 });
    const a = simQ(w, s0, "keep", 0);
    const b = simulate({ ...base, constants: { ...base.constants, aprilMonths: [5, 17, 29] } }, s0, "keep", 0, 3);
    expect(a.length).toBe(b.length);
    a.forEach((x, i) => {
      const y = b[i]!;
      expect(x.x.pu).toBeCloseTo(y.x.pu, 9);
      expect(x.x.pro).toBe(1);
      // 有料の人は 2 か月目の終わり（pu2）から払う: 元は 2・3 か月目に pu2 + pu3、今は 3 か月目に pu2 だけ
      expect(x.r[2]).toBeCloseTo(y.r[2] - w.constants.net * y.x.pu, 1);
      expect(x.r[2]).toBeGreaterThan(-3 * w.constants.infra + 1e-6);
    });
    // 月の稼ぎの見込みは、今の有料の人が来月払う分
    const x = a[0]!.x;
    expect(runRateQ(w, x)[2]).toBeCloseTo(x.pu * w.constants.net - w.constants.infra, 2);
  });
});

describe("顧客は整数の社数で、3 か月ごとに 1 社ずつ離れる（truth-9）", () => {
  it("会社員・『全部可』・顧客 2 社で今のまま: 社数は 2 項分布、売上は 1 か月目は全員・2〜3 か月目は残った顧客", () => {
    const s0 = st({ pm: "a", pro: 1, pu: 3, mau: 80 }, [2, 0, 0]);
    const xs = simQ(w, s0, "keep", 0);
    expect(xs.every((x) => Number.isInteger(x.x.cl) && x.x.cb.length === 1)).toBe(true);
    for (const k of [0, 1, 2]) expect(total(xs, (x) => x.x.cl === 2 - k)).toBeCloseTo(binomP(2, k, q), 12);
    expect(mean(xs, (x) => x.r[1])).toBeCloseTo(2 * 3 + 2 * 3 * 2 * (1 - q), 1);
    // 毎月 4% で減らした平均（元の計算の考え方）とほとんど同じ: 3 − 2q か月分 ≒ 0.96 + 0.96² + 0.96³ か月分
    expect(Math.abs(3 - 2 * q - (0.96 + 0.96 ** 2 + 0.96 ** 3))).toBeLessThan(0.004);
    expect(xs.every((x) => x.x.fee === (x.x.cl ? 3 : 0))).toBe(true);
  });

  it("その 3 か月に増えた顧客はその 3 か月には離れない（『全部可』で 1 社目が決まれば 1 社ちょうど）", () => {
    const s0 = st({ pm: "a", pro: 1, pu: 3, mau: 80 });
    const xs = simQ(w, s0, "ad_side", 0);
    expect(total(xs, (x) => x.tag === "yes")).toBeCloseTo(0.55, 12);
    expect(xs.filter((x) => x.tag === "yes").every((x) => x.x.cl === 1 && x.x.fee === 3)).toBe(true);
    expect(xs.filter((x) => x.tag === "no").every((x) => x.x.cl === 0)).toBe(true);
  });

  it("まとめた状態は社数の場合の混ざり（帳簿）を持ち、次の 3 か月はその場合ごとに数える（どの場合も整数）", () => {
    const a = st({ pm: "a", pro: 1, pu: 3, mau: 80 }, [1, 0, 0]);
    const b = st({ pm: "a", pro: 1, pu: 3, mau: 80 }, [2, 0, 0]);
    const m = repState(w, [
      { x: a, w: 0.3 },
      { x: b, w: 0.7 },
    ]);
    expect(m.cb.map((c) => [c.n[0], c.w])).toEqual([
      [1, 0.3],
      [2, 0.7],
    ]);
    expect(m.cl).toBeCloseTo(1.7, 12);
    expect(m.fee).toBe(3);
    expect(bandOf(w, m)).toEqual({ cl: [1, 2] });
    expect(bandOf(w, a)).toBeUndefined();
    // 幅はまとめた分布の 10%〜90%（まれな端は入れない。2 社が 9 割を超えれば [2, 2]）
    const rare = (p0: number, p1: number) =>
      repState(w, [
        { x: st({ pm: "a" }), w: p0 },
        { x: a, w: p1 },
        { x: b, w: 1 - p0 - p1 },
      ]);
    expect(bandOf(w, rare(0.013, 0.204))).toEqual({ cl: [1, 2] });
    expect(bandOf(w, rare(0.02, 0.05))).toEqual({ cl: [2, 2] });
    expect(bandOf(w, rare(0.3, 0.1))).toEqual({ cl: [0, 2] });
    const xs = simQ(w, m, "keep", 3);
    expect(xs.every((x) => Number.isInteger(x.x.cl))).toBe(true);
    const pa = simQ(w, a, "keep", 3);
    const pb = simQ(w, b, "keep", 3);
    for (const k of [0, 1, 2]) expect(total(xs, (x) => x.x.cl === k)).toBeCloseTo(0.3 * total(pa, (x) => x.x.cl === k) + 0.7 * total(pb, (x) => x.x.cl === k), 12);
    // 売上は見本ごとに 0.01 万円に丸めるので、その分だけ違ってよい
    expect(mean(xs, (x) => x.r[1])).toBeCloseTo(0.3 * mean(pa, (x) => x.r[1]) + 0.7 * mean(pb, (x) => x.r[1]), 2);
    // 紹介は顧客のいる場合だけ（0 社の場合には来ない）
    const z = repState(w, [
      { x: st({ pm: "a", pro: 1 }), w: 0.4 },
      { x: b, w: 0.6 },
    ]);
    expect(Math.round(z.cl)).toBe(1);
    const zz = simQ(w, { ...z, cb: [z.cb[0]!] } as QSt, "ad_more", 3);
    expect(zz.every((x) => x.x.cl === 0)).toBe(true);
  });
});

describe("副業の月額（truth-8）と独立", () => {
  it("新しい顧客は月 3 万円。顧客が 4 社に届いた後に増えた顧客は月 5 万円、今の顧客は据え置く", () => {
    // 週 4 日・3 社（3 万円）に 1 社増える → 4 社に届く（料金を上げる）
    const s0 = st({ j: "p", pm: "a", pro: 1, pu: 3, mau: 80 }, [3, 0, 0]);
    const xs = simQ(w, s0, "ad_side", 0).filter((x) => x.tag === "yes");
    expect(xs.every((x) => x.x.cb[0]!.n[1] === 0 && x.x.cb[0]!.f5 === 1)).toBe(true);
    // 4 社に届いた後（離れて 3 社）に増えた顧客は 5 万円
    const s1 = st({ j: "p", pm: "a", pro: 1, pu: 3, mau: 80 }, [3, 0, 0], 1);
    const ys = simQ(w, s1, "ad_side", 0).filter((x) => x.tag === "yes");
    expect(ys.every((x) => x.x.cb[0]!.n[1] === 1)).toBe(true);
    const y = ys.find((x) => x.x.cl === 4)!.x;
    expect(y.fee).toBe(3.5);
    expect(runRateQ(w, y)[1]).toBe(14);
  });

  it("独立: 副業からの顧客は同じ月額のまま、独立してから増やした顧客は月 7 万円。経費は独立した月から", () => {
    const s0 = st({ pm: "a", pro: 1, pu: 3, mau: 80 }, [2, 0, 0]);
    const xs = simQ(w, s0, "ind_quit", 0);
    expect(xs.every((x) => x.x.j === "i")).toBe(true);
    const got = xs.filter((x) => x.x.cb[0]!.n[2] > 0);
    expect(got.length).toBeGreaterThan(0);
    for (const x of xs) expect(x.x.cl * x.x.fee).toBeCloseTo(3 * x.x.cb[0]!.n[0] + 7 * x.x.cb[0]!.n[2], 9);
    // 顧客がいなければ、売上は −3 万円 × 2 か月（2・3 か月目は独立）
    const none = simQ(w, st({ pm: "a", pro: 1, pu: 3, mau: 80 }), "ind_quit", 0).filter((x) => x.x.cl === 0);
    expect(none.every((x) => x.r[1] === -2 * w.constants.indOverhead)).toBe(true);
  });
});

describe("転職活動（truth-6・user-2）", () => {
  it("1 期目 28% は 1 つの会社で 1 回だけ。続けると 12.6%。1 つの会社で 4 期まで・続けて決まらないのは 2 期まで", () => {
    let s: QSt = toQ(w, w.today);
    expect(feasibleQ(w, s, "fc_switch", 0)).toBe(true);
    expect(feasibleQ(w, s, "fc_switch2", 0)).toBe(false);
    const step = (kind: string, m0: number, pMove: number) => {
      expect(feasibleQ(w, s, kind, m0), `${kind} ${m0}`).toBe(true);
      const xs = simQ(w, s, kind, m0);
      expect(total(xs, moved)).toBeCloseTo(pMove, 9);
      s = xs.find((x) => !moved(x))!.x;
    };
    step("fc_switch", 0, 0.28);
    expect([uses(s, "q"), uses(s, "r"), s.fl.includes("js"), s.fl.includes("jx")]).toEqual([1, 1, true, true]);
    expect(feasibleQ(w, s, "fc_switch", 3)).toBe(false);
    step("fc_switch2", 3, 0.126);
    expect([uses(s, "q"), uses(s, "r")]).toEqual([2, 2]);
    // 2 期続けて決まらなかった: 次の 3 か月はほかの手
    expect(feasibleQ(w, s, "fc_switch2", 6)).toBe(false);
    s = simQ(w, s, "keep", 6)[0]!.x;
    expect([uses(s, "q"), uses(s, "r"), s.fl.includes("js"), s.fl.includes("jx")]).toEqual([2, 0, false, true]);
    expect(feasibleQ(w, s, "fc_switch", 9)).toBe(false);
    step("fc_switch2", 9, 0.126);
    step("fc_switch2", 12, 0.126);
    expect([uses(s, "q"), uses(s, "r")]).toEqual([4, 2]);
    s = simQ(w, s, "keep", 15)[0]!.x;
    // 1 つの会社で 4 期まで
    expect(feasibleQ(w, s, "fc_switch2", 18)).toBe(false);
    expect(feasibleQ(w, s, "fc_switch", 18)).toBe(false);
  });

  it("移ると新しい会社: 週 4 日も聞き直せ、転職活動の数え方も初めから。転職は 1 回だけ。移る月に給与の半月分を引く", () => {
    const s0 = withFlags(st(), "jx", "pq", "js", "q3", "r1");
    // 4 月を含まない 3 か月（7〜9 か月目）
    const xs = simQ(w, s0, "fc_switch2", 6);
    const m = xs.find(moved)!.x;
    for (const f of ["js", "jx", "pq", "q3", "r1"]) expect(m.fl.includes(f)).toBe(false);
    expect(feasibleQ(w, m, "part", 6)).toBe(true);
    expect(feasibleQ(w, m, "fc_switch", 6)).toBe(false);
    expect(feasibleQ(w, m, "fc_switch2", 6)).toBe(false);
    // 移る月（3 か月目）の初めに、移る前の給与の半月分
    const hi = xs.find((x) => x.tag === "high")!;
    expect(hi.r[0]).toBeCloseTo(1 + 1 + 1.18 - 0.5, 9);
  });

  it("週 4 日は 1 つの会社で 1 回だけ（断られたら pq）", () => {
    const xs = simQ(w, st(), "part", 0);
    const refused = xs.filter((x) => x.x.j === "e");
    const ok = xs.filter((x) => x.x.j === "p");
    expect(refused.length).toBeGreaterThan(0);
    expect(ok.length).toBeGreaterThan(0);
    expect(refused.every((x) => x.x.fl.includes("pq"))).toBe(true);
    expect(ok.every((x) => !x.x.fl.includes("pq"))).toBe(true);
    expect(feasibleQ(w, refused[0]!.x, "part", 3)).toBe(false);
  });

  it("遊ぶ人を増やす・広告で集めるは 4 期まで、続ける人を増やすは 1 回だけ、sd_pro は選べない", () => {
    let s = st();
    for (let k = 1; k <= LIMITS.sd_grow; k++) {
      expect(feasibleQ(w, s, "sd_grow", 3 * k)).toBe(true);
      s = simQ(w, s, "sd_grow", 3 * k)[0]!.x;
      expect(uses(s, "g")).toBe(k);
      expect(s.fl.filter((f) => /^g\d$/.test(f))).toEqual([`g${k}`]);
    }
    expect(feasibleQ(w, s, "sd_grow", 15)).toBe(false);
    const pro = st({ pro: 1, pm: "s", pu: 20, mau: 400 });
    expect(feasibleQ(w, st(), "sd_ads", 3)).toBe(false);
    let a = pro;
    for (let k = 1; k <= LIMITS.sd_ads; k++) a = simQ(w, a, "sd_ads", 3 * k)[0]!.x;
    expect(uses(a, "a")).toBe(4);
    expect(feasibleQ(w, a, "sd_ads", 15)).toBe(false);
    const r = simQ(w, pro, "sd_retain", 3)[0]!.x;
    expect(r.fl.includes("rt")).toBe(true);
    expect(feasibleQ(w, pro, "sd_retain", 3)).toBe(true);
    expect(feasibleQ(w, r, "sd_retain", 6)).toBe(false);
    expect(feasibleQ(w, pro, "sd_pro", 3)).toBe(false);
  });
});

describe("届け出の答えの引き継ぎ（truth-7）", () => {
  it("移れる見込みは答えの範囲を認める割合を掛けた分（全部可 × 20%・SpellDash だけ可 × 65%・まだ／不可 × 1）", () => {
    expect([offerScale(w, "a"), offerScale(w, "s"), offerScale(w, "?"), offerScale(w, "n")]).toEqual([0.2, 0.2 + 0.45, 1, 1]);
    const cases: Array<[St["pm"], number]> = [
      ["a", 0.2],
      ["s", 0.65],
      ["?", 1],
      ["n", 1],
    ];
    for (const [pm, f] of cases) {
      const s0 = st({ pm, pro: pm === "a" || pm === "s" ? 1 : 0, pu: 5, mau: 120 }, pm === "a" ? [1, 0, 0] : [0, 0, 0]);
      const first = simQ(w, s0, "fc_switch", 0);
      expect(total(first, (x) => x.tag === "high")).toBeCloseTo(0.1 * f, 12);
      expect(total(first, (x) => x.tag === "mid")).toBeCloseTo(0.18 * f, 12);
      const cont = simQ(w, withFlags(s0, "jx"), "fc_switch2", 3);
      expect(total(cont, moved)).toBeCloseTo(0.126 * f, 12);
      // 移った会社の答え: 全部可・SpellDash だけ可は引き継ぎ、まだ・不可は『まだ』（また届け出られる）
      for (const x of first.filter(moved)) {
        expect(x.x.pm).toBe(pm === "a" || pm === "s" ? pm : "?");
        if (x.x.pro === 1) expect(["a", "s"]).toContain(x.x.pm);
      }
      if (pm === "n") expect(feasibleQ(w, first.find(moved)!.x, "sd_permpro", 3)).toBe(true);
    }
    // 『全部可』の顧客は移っても続く
    const a = simQ(w, st({ pm: "a", pro: 1, pu: 5, mau: 120 }, [1, 0, 0]), "fc_switch", 0).filter(moved);
    expect(total(a, (x) => x.x.cl === 1) / total(a)).toBeCloseTo(1 - q, 12);
  });

  it("会社員に戻ると、届け出なしで『SpellDash だけ可』。顧客は手放し、新しい会社として数え直す", () => {
    const s0 = withFlags(st({ j: "i", pm: "n", pro: 1, pu: 10, mau: 300, sal: 1.2 }, [1, 0, 3], 1), "switched", "jx", "q2", "pq");
    const xs = simQ(w, s0, "back_emp", 6);
    const back = xs.filter((x) => x.x.j === "e");
    expect(total(back)).toBeCloseTo(0.6, 12);
    for (const x of back) {
      expect([x.x.pm, x.x.pro, x.x.cl, x.x.fee, x.x.sal]).toEqual(["s", 1, 0, 0, 1]);
      expect(x.x.cb).toEqual([{ n: [0, 0, 0], f5: 0, w: 1 }]);
      for (const f of ["switched", "jx", "q2", "pq"]) expect(x.x.fl.includes(f)).toBe(false);
    }
    expect(xs.filter((x) => x.x.j === "i").every((x) => x.x.pm === "n")).toBe(true);
    expect(feasibleQ(w, back[0]!.x, "fc_switch", 9)).toBe(true);
  });
});

describe("結果のまとめ方", () => {
  const sumP = (os: Array<{ p: number }>) => os.reduce((a, o) => a + o.p, 0);

  it("事実（会社の答え）はどのまとめ方でも分ける", () => {
    for (const mode of ["split", "fact", "lean"] as const) {
      const os = quarterOutcomes(w, st(), "sd_permpro", 0, mode, S);
      expect(os.map((o) => o.id).sort()).toEqual(["a", "n", "s"]);
      expect(sumP(os)).toBe(100);
      expect(os.every((o) => o.ln.metric === "perm")).toBe(true);
    }
  });

  it("転職したかは事実: 10% 未満でも『転職せず』とまとめない（全部可なら 6%、続けると 3%）", () => {
    for (const mode of ["split", "fact", "lean"] as const) {
      const s0 = st({ pm: "a", pro: 1, pu: 5, mau: 120 });
      expect(quarterOutcomes(w, s0, "fc_switch", 0, mode, S).map((o) => [o.id, o.p])).toEqual([
        ["none", 94],
        ["high_mid", 6],
      ]);
      expect(quarterOutcomes(w, withFlags(s0, "jx"), "fc_switch2", 3, mode, S).map((o) => [o.id, o.p])).toEqual([
        ["none", 97],
        ["high_mid", 3],
      ]);
    }
    expect(quarterOutcomes(w, st(), "fc_switch", 0, "split", S).map((o) => [o.id, o.p])).toEqual([
      ["none", 72],
      ["mid", 18],
      ["high", 10],
    ]);
  });

  it("『全部可』の 1 社目（8%）は『全部可・まだ』とまとめ、社数の幅（0〜1 社）を持つ", () => {
    const os = quarterOutcomes(w, st(), "ad_permside", 0, "split", S);
    expect(os.map((o) => [o.id, o.p, o.lab])).toEqual([
      ["a0_a1", 20, "全部可"],
      ["s", 45, "SpellDash だけ"],
      ["n", 35, "どちらも不可"],
    ]);
    expect(bandOf(w, os[0]!.st)).toEqual({ cl: [0, 1] });
    expect(os[0]!.st.cl).toBeCloseTo(0.4, 12);
    expect(bandOf(w, os[1]!.st)).toBeUndefined();
  });

  it("顧客で分けた結果の名前は、その組に本当にある社数（状態・幅と合う）", () => {
    const os = quarterOutcomes(w, st({ pm: "a", pro: 1, pu: 3, mau: 80 }), "ind_quit", 0, "split", S);
    expect(sumP(os)).toBe(100);
    for (const o of os) {
      const b = bookStats(w, o.st.cb);
      expect(o.lab).toBe(b.lo === b.hi ? `顧客 ${b.lo} 社` : `顧客 ${b.lo}〜${b.hi} 社`);
      expect(o.st.cb.every((c: Comp) => c.n.every(Number.isInteger))).toBe(true);
      expect(Number.isInteger(o.st.cl)).toBe(b.lo === b.hi);
    }
    // 線は全体を覆う区間（下は「以下」・上は「以上」）
    expect(os[0]!.ln.lo).toBeNull();
    expect(os.at(-1)!.ln.hi).toBeNull();
  });

  it("数の結果は fact・lean で 1 つにまとめ、昇格の結果は lean だけでまとめる", () => {
    const s3 = st({ mau: 2000, pro: 1, pm: "s", pu: 60 });
    const split = quarterOutcomes(w, s3, "sd_grow", 3, "split", S);
    expect(split.length).toBeGreaterThan(1);
    expect(sumP(split)).toBe(100);
    for (const mode of ["fact", "lean"] as const) {
      const [o, ...rest] = quarterOutcomes(w, s3, "sd_grow", 3, mode, S);
      expect(rest).toEqual([]);
      expect(o).toMatchObject({ id: "all", p: 100, line: "（どの場合もこの道）", ln: { metric: "none", at: 6, cat: "all" } });
    }
    // 4 月の評価（5 か月目）を含む 3 か月
    expect(quarterOutcomes(w, st(), "fc_push", 3, "fact", S).map((o) => o.id)).toEqual(["same", "up"]);
    expect(quarterOutcomes(w, st(), "fc_push", 3, "lean", S).map((o) => o.id)).toEqual(["all"]);
  });

  it("事実の小さい組も 0% にしない（一番大きい組から 1% 回す）", () => {
    const s0 = st({ pro: 1, pm: "s", pu: 10, mau: 300 });
    const xs: QSample[] = simQ(w, s0, "sd_pilot", 0).map((x) => ({ ...x, w: x.tag === "yes" ? x.w * (0.003 / 0.3) : x.w * (0.997 / 0.7) }));
    const os = groupOutcomesQ(w, "sd_pilot", { t: "cat", metric: "flag", flag: "pilot" }, s0, 0, xs, 3, S);
    expect(os.map((o) => [o.id, o.p])).toEqual([
      ["yes", 1],
      ["no", 99],
    ]);
  });

  it("代表の状態: 分類は一番重い物・数は重みの平均・印は半分以上が持つ物", () => {
    const a = st({ j: "e", mau: 100, fl: ["js", "scope"] }, [1, 0, 0]);
    const b = st({ j: "p", mau: 200, fl: ["scope"] });
    const r = repState(w, [
      { x: a, w: 0.3 },
      { x: b, w: 0.7 },
    ]);
    expect(r.j).toBe("p");
    expect(r.mau).toBeCloseTo(170, 9);
    expect(r.cl).toBeCloseTo(0.3, 9);
    expect(r.fee).toBe(3);
    expect(r.fl).toEqual(["scope"]);
    const c = collapsed(w, simQ(w, st(), "sd_grow", 0), 3);
    expect(c.p).toBe(100);
    expect(c.st.fl).toEqual(["g1"]);
  });

  it("粗い表のマス: SpellDash の数は見ず、給与は 0.05 刻み。転職活動の期の数は見る", () => {
    const g = { sal: 0.05, sd: false, corr: true };
    expect(coarseKey(1, st({ mau: 40 }), g)).toBe(coarseKey(1, st({ mau: 900, pu: 30 }), g));
    expect(coarseKey(1, st({ sal: 1.02 }), g)).toBe(coarseKey(1, st(), g));
    expect(coarseKey(1, st({ sal: 1.03 }), g)).not.toBe(coarseKey(1, st(), g));
    expect(coarseKey(1, withFlags(st(), "jx"), g)).not.toBe(coarseKey(1, st(), g));
    expect(coarseKey(1, withFlags(st(), "jx", "q1"), g)).not.toBe(coarseKey(1, withFlags(st(), "jx", "q2"), g));
    expect(coarseKey(1, withFlags(st(), "jx", "q2", "r1"), g)).not.toBe(coarseKey(1, withFlags(st(), "jx", "q2", "r2"), g));
    expect(coarseKey(2, st(), g)).not.toBe(coarseKey(1, st(), g));
  });
});

describe("生成の部品", () => {
  it("山は大きい順に取り出す（同じ大きさの順も決まっている）", () => {
    const run = () => {
      const h = new Heap<string>();
      [0.2, 0.5, 0.2, 0.9, 0.5, 0.1, 0.2].forEach((p, i) => h.push(p, `${p}#${i}`));
      const out: string[] = [];
      while (h.size) out.push(h.pop()!);
      return out;
    };
    const out = run();
    expect(out.map((x) => Number(x.split("#")[0]))).toEqual([0.9, 0.5, 0.5, 0.2, 0.2, 0.2, 0.1]);
    expect(run()).toEqual(out);
    expect(new Heap<number>().pop()).toBeUndefined();
  });

  it("鍵の短い名前は手ごとに違い、どの手にもある", () => {
    const codes = Object.keys(w.kinds).map((k) => CODE[k]);
    expect(codes.every((c) => typeof c === "string" && c.length > 0)).toBe(true);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("入口の引数", () => {
  it("既定は R1 が選んだ形", () => {
    const o = parseArgs(["--out", "x.json"], w.rootMenu);
    expect(o).toEqual({ out: "x.json", params: { ...DEFAULTS, altsBy: [...R1_ALTS_BY] }, anchor: "2026-11", never: true, release: 0, appendHistory: false, runs: 2 });
    expect(o.params).toMatchObject({ B: 2000, maxAlts: 4, stubMode: "split", factCl: false, altsBy: [0, 4, 4, 4, 4, 3, 3, 3, 3, 2, 2, 2], tol: 0.02, fineDepth: 3, areaDiscount: 0.3 });
  });

  it("形を変える引数", () => {
    const o = parseArgs(["--budget", "300", "--alts", "3", "--alts-by", "off", "--stub", "lean", "--fact-cl", "--only", "keep,part", "--anchor", "2027-02", "--never", "off", "--out", "t.json"], w.rootMenu);
    expect(o.params).toMatchObject({ B: 300, maxAlts: 3, stubMode: "lean", factCl: true });
    expect(o.params.altsBy).toBeUndefined();
    expect([o.only, o.anchor, o.out, o.never]).toEqual([["keep", "part"], "2027-02", "t.json", false]);
    const r = parseArgs(["--out", "t.json", "--bundle", "b.b64", "--release", "7", "--record", "rec.json", "--history", "h.json", "--append-history", "--runs", "1", "--tol", "2"], w.rootMenu);
    expect([r.bundle, r.release, r.record, r.history, r.appendHistory, r.runs, r.params.tol]).toEqual(["b.b64", 7, "rec.json", "h.json", true, 1, 2]);
    expect(parseArgs(["--out", "t", "--never", "on"], w.rootMenu).never).toBe(true);
    expect(parseArgs(["--out", "t", "--alts-by", "0,3,3,3,3,3,3,3,3,2,2,2"], w.rootMenu).params.altsBy).toEqual([0, 3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 2]);
  });

  it("読めない引数は投げる", () => {
    const bad = [
      [],
      ["--out"],
      ["--out", "x", "--budget", "0"],
      ["--out", "x", "--only", "plan_ind"],
      ["--out", "x", "--anchor", "2026-13"],
      ["--out", "x", "--alts-by", "0,4,4"],
      ["--out", "x", "--stub", "all"],
      ["--out", "x", "--never", "yes"],
      ["--out", "x", "--nope"],
      ["--out", "x", "--hash", "dev-port"],
      ["--out", "x", "--runs", "3"],
      ["--out", "x", "--release", "-1"],
      ["--out", "x", "--record", "r.json"],
      ["--out", "x", "--append-history"],
      ["--out", "x", "--tol", "0"],
    ];
    for (const args of bad) expect(() => parseArgs(args, w.rootMenu), args.join(" ")).toThrow();
  });
});

describe("予算の使い道 1: 事実の小さい組も分ける（fine。SPEC v1 D1・§2.2・truth-1）", () => {
  it("『全部可』で 1 社目が決まる 8% を『全部可・まだ』にまとめない（社数は整数で、幅は無い）", () => {
    const os = quarterOutcomes(w, st(), "ad_permside", 0, "split", S, true);
    expect(os.map((o) => [o.id, o.p, o.lab])).toEqual([
      ["a1", 8, "全部可・1 社目"],
      ["a0", 12, "全部可・まだ"],
      ["s", 45, "SpellDash だけ"],
      ["n", 35, "どちらも不可"],
    ]);
    expect(os.map((o) => o.st.cl)).toEqual([1, 0, 0, 0]);
    expect(os.every((o) => bandOf(w, o.st) === undefined)).toBe(true);
    // 合わせると fine でない時の『全部可』と同じ見込み・同じ稼ぎ
    const merged = quarterOutcomes(w, st(), "ad_permside", 0, "split", S)[0]!;
    expect(merged.id).toBe("a0_a1");
    expect(os[0]!.w + os[1]!.w).toBeCloseTo(merged.w, 12);
  });

  it("移れる見込みが小さい時（答えを引き継ぐ転職）は 1.18 倍と 1.08 倍を分ける。どのまとめ方でも", () => {
    const sa = st({ pm: "a", pro: 1, pu: 5, mau: 120 });
    const ss = st({ pm: "s", pro: 1, pu: 5, mau: 120 });
    for (const mode of ["split", "fact", "lean"] as const) {
      expect(quarterOutcomes(w, sa, "fc_switch", 0, mode, S, true).map((o) => [o.id, o.p])).toEqual([
        ["none", 94],
        ["mid", 4],
        ["high", 2],
      ]);
      expect(quarterOutcomes(w, ss, "fc_switch", 0, mode, S, true).map((o) => [o.id, o.p])).toEqual([
        ["none", 82],
        ["mid", 12],
        ["high", 6],
      ]);
    }
    expect(quarterOutcomes(w, ss, "fc_switch", 0, "split", S).map((o) => [o.id, o.p])).toEqual([
      ["none", 82],
      ["high_mid", 18],
    ]);
  });

  it("事実でない分け方（数・昇格）と、もともと分ける事実（会社の答え）は変わらない", () => {
    const s3 = st({ mau: 2000, pro: 1, pm: "s", pu: 60 });
    expect(quarterOutcomes(w, s3, "sd_grow", 3, "split", S, true)).toEqual(quarterOutcomes(w, s3, "sd_grow", 3, "split", S));
    expect(quarterOutcomes(w, st(), "sd_permpro", 0, "split", S, true)).toEqual(quarterOutcomes(w, st(), "sd_permpro", 0, "split", S));
    expect(quarterOutcomes(w, st(), "fc_push", 3, "fact", S, true)).toEqual(quarterOutcomes(w, st(), "fc_push", 3, "fact", S));
  });

  it("3 か月の結果の入れ物（「3 年やらない」の表どうしで分け合う）は、毎回数えた結果と同じ物を返す", () => {
    const oc = new OutcomeCache();
    const x = st({ pm: "a", pro: 1, pu: 5, mau: 120 }, [1, 0, 0]);
    for (const [kind, mode] of [["keep", "lean"], ["ad_side", "fact"], ["fc_switch", "lean"]] as const) {
      const a = oc.get(w, 1, x, kind, mode, S);
      expect(a).toEqual(quarterOutcomes(w, x, kind, 3, mode, S));
      expect(oc.get(w, 1, x, kind, mode, S)).toBe(a);
    }
    expect(oc.hits).toBe(3);
    expect(oc.m.size).toBe(3);
  });
});

describe("まとめた行き先の中身（mix）と標準の続き（cont）の部品", () => {
  /** 続きの見積もりの形を手で作る（s 段・初めの状態 x・手 k・結果） */
  const leaf = (x: QSt): Roll => ({ v: [0, 0, 0], rr: runRateQ(w, x), st: x, s: NSTAGE, x, k: "", kids: [] });
  const node = (s: number, x: QSt, k: string, kids: Array<[number, string, Roll]>): Roll => ({ v: [0, 0, 0], rr: [0, 0, 0], st: x, s, x, k, kids: kids.map(([p, id, next]) => ({ p, id, next })) });

  it("分布の幅は累積が 10%・50%・90% に届く一番小さい値（顧客の幅 band と同じ取り方）。一番ありそうな社数は重みの一番大きい社数", () => {
    expect(distQuantiles([[0, 0.1], [1, 0.5], [2, 0.4]], [0.1, 0.5, 0.9])).toEqual([0, 1, 2]);
    expect(distQuantiles([[0, 0.05], [3, 0.95]], [0.1, 0.5, 0.9])).toEqual([3, 3, 3]);
    const x = setBook(w, { ...st(), cb: [] }, [
      { n: [1, 0, 0], f5: 0, w: 0.3 },
      { n: [2, 0, 0], f5: 0, w: 0.45 },
      { n: [0, 0, 0], f5: 0, w: 0.25 },
    ]);
    expect(clientDist(x)).toEqual([
      [0, 0.25],
      [1, 0.3],
      [2, 0.45],
    ]);
    expect(clientMode(x)).toBe(2);
    expect(bandOf(w, x)).toEqual({ cl: distQuantiles(clientDist(x), [0.1, 0.9]) });
    // 同じ重みなら少ない方
    expect(clientMode(setBook(w, { ...st(), cb: [] }, [{ n: [1, 0, 0], f5: 0, w: 0.5 }, { n: [3, 0, 0], f5: 0, w: 0.5 }]))).toBe(1);
  });

  it("出来事の名前: 届け出の答え・独立・会社員に戻る・転職・昇格・Pro・顧客・導入・節目。無ければ null、名前はどれも決まった語彙", () => {
    const a = st();
    expect(contEvent("sd_permpro", a, { ...a, pm: "s", pro: 1 }, "s", 0)).toBe("PERM_S");
    // 届け出る手でなければ答えの出来事ではない（会社員に戻った・移った会社の答え）。Pro の受付になる
    expect(contEvent("keep", a, { ...a, pm: "s", pro: 1 }, "all", 0)).toBe("PRO_START");
    expect(contEvent("ind_quit", a, { ...a, j: "i" }, "cl0", 0)).toBe("IND_START");
    const ind = st({ j: "i", pm: "a" }, [0, 0, 2]);
    expect(contEvent("back_emp", ind, st({ pm: "s" }), "e", 2)).toBe("BACK_EMP");
    expect(contEvent("fc_switch", a, { ...a, sal: a.sal * 1.18, fl: ["switched"] }, "high", 0)).toBe("SWITCH_HIGH");
    expect(contEvent("fc_switch2", a, { ...a, sal: a.sal * 1.08, fl: ["switched"] }, "mid", 0)).toBe("SWITCH_MID");
    expect(contEvent("fc_switch", a, a, "none", 0)).toBeNull();
    expect(contEvent("fc_push", a, { ...a, sal: a.sal + 0.06 }, "up", 0)).toBe("PROMO");
    expect(contEvent("fc_push", a, a, "all", 0)).toBeNull();
    // 顧客: 道で初めて・それまでの一番多い数まで・それを超える・減る（一番ありそうな社数で）
    const e0 = st({ pm: "a" });
    const e1 = st({ pm: "a" }, [1, 0, 0]);
    const e2 = st({ pm: "a" }, [2, 0, 0]);
    expect(contEvent("ad_side", e0, e1, "all", 0)).toBe("FIRST_CLIENT");
    expect(contEvent("ad_side", e0, e1, "all", 2)).toBe("CLIENT_REGAIN");
    expect(contEvent("ad_more", e1, e2, "all", 1)).toBe("CLIENT_UP");
    expect(contEvent("keep", e2, e1, "all", 2)).toBe("CLIENT_LOST");
    // 半分に届かない営業（一番ありそうな社数は変わらない）は出来事にならない
    const half = setBook(w, { ...e0, cb: [] }, [{ n: [0, 0, 0], f5: 0, w: 0.6 }, { n: [1, 0, 0], f5: 0, w: 0.4 }]);
    expect(contEvent("ad_side", e0, half, "all", 0)).toBeNull();
    const pro = st({ pm: "s", pro: 1, pu: 25 });
    expect(contEvent("sd_school", pro, { ...pro, pu: 65, seats: 40, fl: ["school"] }, "yes", 0)).toBe("SCHOOL_ON");
    expect(contEvent("sd_pilot", pro, { ...pro, fl: ["pilot"] }, "yes", 0)).toBe("PILOT_ON");
    expect(contEvent("ad_portfolio", a, { ...a, fl: ["portfolio"] }, "yes", 0)).toBe("PORTFOLIO_ON");
    expect(contEvent("sd_grow", pro, { ...pro, pu: 31 }, "all", 0)).toBe("PU_MILE");
    expect(contEvent("sd_grow", { ...pro, pro: 0 }, { ...pro, pro: 0, pu: 31 }, "all", 0)).toBeNull();
    // 1 つの 3 か月に複数あれば大事な方（独立 > 顧客）
    expect(contEvent("ind_quit", e0, st({ j: "i", pm: "a" }, [0, 0, 1]), "cl1", 0)).toBe("IND_START");
    expect(new Set(CONT_EVENTS).size).toBe(CONT_EVENTS.length);
  });

  it("行き先の見込み: 合流した所は足し合わせ、途中で転職した見込みを数える。mix の割合と幅、cont は一番ありそうな結果をたどる", () => {
    const x0 = st({ pm: "a" });
    const moved = { ...x0, sal: x0.sal * 1.18, fl: ["switched"] };
    const stay = st({ pm: "a" }, [1, 0, 0]);
    const school = st({ pm: "s", pro: 1, pu: 60, seats: 40, mau: 500 });
    const lMoved = leaf(moved);
    const lStay = leaf(stay);
    const lSchool = leaf(school);
    // 33 か月目: 合流する 2 つの状態から同じ行き先へ
    const m33a = node(11, stay, "keep", [[100, "all", lStay]]);
    const m33b = node(11, school, "keep", [[100, "all", lSchool]]);
    const m30 = node(10, x0, "fc_switch", [
      [70, "none", node(11, x0, "ad_side", [[100, "all", lStay]])],
      [30, "high", node(11, moved, "keep", [[100, "all", lMoved]])],
    ]);
    const leaves = leavesOf(m30, false);
    expect(leaves.map((l) => [l.x.fl.includes("switched"), l.m, l.sw])).toEqual([
      [false, 0.7, 0],
      [true, 0.3, 0.3],
    ]);
    // すでに転職していれば、どの行き先も「転職した」
    expect(leavesOf(m30, true).every((l) => l.sw === l.m)).toBe(true);
    // 合流: 2 つの道が同じ続きを指すと、見込みは足される
    const join = node(10, x0, "sd_pilot", [
      [40, "yes", m33a],
      [60, "no", m33a],
    ]);
    expect(leavesOf(join, false).map((l) => l.m)).toEqual([1]);
    const mixLeaves = [...leavesOf(m30, false), ...leavesOf(m33b, false).map((l) => ({ ...l, m: 0 }))];
    const mix = mixOf(w, stay, mixLeaves);
    expect(mix.j).toEqual({ e: 1, p: 0, i: 0 });
    expect(mix.pm).toEqual({ "?": 0, a: 1, s: 0, n: 0 });
    expect([mix.pro, mix.switched, mix.school]).toEqual([0, 0.3, 0]);
    expect(mix.sal).toEqual([paidSal(w, stay), paidSal(w, stay), paidSal(w, moved)]);
    expect(mix.cl).toEqual([1, 1, 1]);
    // 学校の席・Pro・独立の給与 0
    const mix2 = mixOf(w, school, [
      { x: school, m: 0.5, sw: 0 },
      { x: st({ j: "i", pm: "a" }), m: 0.5, sw: 0 },
    ]);
    expect([mix2.pro, mix2.school, mix2.j.i, mix2.sal[0]]).toEqual([0.5, 0.5, 0.5, 0]);
    // cont: 一番ありそうな結果（同じなら先）をたどり、月は 3 か月ごと
    expect(contOf(m30, 0)).toEqual([
      { m: 30, kind: "fc_switch" },
      { m: 33, kind: "ad_side", ev: "FIRST_CLIENT" },
    ]);
    // 道でそれまでに顧客がいたなら、取り戻し
    expect(contOf(m30, 1)[1]!.ev).toBe("CLIENT_REGAIN");
    const tie = node(10, x0, "sd_pilot", [
      [50, "yes", node(11, { ...x0, fl: ["pilot"] }, "keep", [[100, "all", lStay]])],
      [50, "no", m33a],
    ]);
    expect(contOf(tie, 0).map((c) => c.kind)).toEqual(["sd_pilot", "keep"]);
    expect(contOf(tie, 0)[0]!.ev).toBe("PILOT_ON");
    // 見積もりの稼ぎ（R3）は Σ 見込み × (その 3 か月 + 続き)
    const outs = quarterOutcomes(w, st(), "sd_permpro", 0, "split", S);
    const conts = outs.map((o) => ({ ...leaf(o.st), v: [1, 2, 3] as [number, number, number] }));
    const v = qOf(outs, conts);
    const want = outs.reduce<[number, number, number]>((acc, o) => [acc[0] + (o.p / 100) * (o.r[0] + 1), acc[1] + (o.p / 100) * (o.r[1] + 2), acc[2] + (o.p / 100) * (o.r[2] + 3)], [0, 0, 0]);
    v.forEach((x, i) => expect(x).toBeCloseTo(want[i]!, 9));
  });
});

describe("予算の合わせ込み（D1・truth-1）", () => {
  /** 作り物の木: 分かれ道の数は内側の予算の単調な関数（上限 cap）。予算が足りずに分けなかった判断は上限まで届かない間だけ */
  const fake = (f: (B: number) => number, cap: number) => {
    const calls: number[] = [];
    const run = (B: number) => {
      calls.push(B);
      const forks = Math.min(cap, Math.round(f(B === Infinity ? 1e12 : B)));
      return { forks, limited: forks < cap ? 1 : 0 };
    };
    return { run, calls };
  };

  it("目標 ±2% に入る内側の予算を探す（下からも上からも）", () => {
    for (const [f, B0] of [
      [(B: number) => 0.8 * B, 2000],
      [(B: number) => 1.3 * B + 50, 2000],
      [(B: number) => 400 + 0.5 * B, 600],
    ] as const) {
      const { run, calls } = fake(f, 1e9);
      const r = calibrate(run, B0, 0.02, B0, 14);
      expect(r.hit).toBe(true);
      expect(r.saturated).toBe(false);
      expect(Math.abs(r.forks - B0)).toBeLessThanOrEqual(B0 * 0.02);
      expect(r.passes).toBe(calls.length);
      expect(r.passes).toBeLessThanOrEqual(8);
    }
  });

  it("飽和: 予算が足りずに分けなかった判断が 0 なら 1 回で、そうでなければ予算 ∞ を 1 回試して止まる", () => {
    const sat = calibrate(() => ({ forks: 1545, limited: 0 }), 2000, 0.02, 2000, 14);
    expect(sat).toEqual({ B: Infinity, forks: 1545, hit: false, saturated: true, passes: 1 });
    const { run, calls } = fake((B) => 0.7 * B, 1700);
    const r = calibrate(run, 2000, 0.02, 2000, 14);
    expect([r.saturated, r.forks, r.B]).toEqual([true, 1700, Infinity]);
    expect(calls).toEqual([2000, Infinity]);
    // 予算 ∞ なら届く時は、∞ が上側になり、有限の予算に戻って詰める
    const g = fake((B) => 0.7 * B, 5000);
    const r2 = calibrate(g.run, 2000, 0.02, 2000, 14);
    expect(r2.hit).toBe(true);
    expect(g.calls[1]).toBe(Infinity);
    expect(g.calls.slice(2).every((B) => Number.isFinite(B))).toBe(true);
    // 上限を超えた予算が一度でもあれば、谷（予算が足りずに分けなかった判断が 0 でも）を飽和とはみない。届かなければ一番近い予算
    const jump = (B: number) => ({ forks: B === Infinity || B >= 2500 ? 2500 : 1400, limited: B > 2100 && B < 2500 ? 0 : 1 });
    const r3 = calibrate(jump, 2000, 0.02, 2000, 10);
    expect([r3.saturated, r3.hit, r3.passes]).toEqual([false, false, 10]);
    expect(r3.forks).toBe(2500);
  });

  it("手順: 飽和しなければ分ける予算だけ。飽和したら事実の小さい組を分け、まだ足りなければ別の領域の手を一番少ない数だけ広げる", () => {
    /** 作り物: 分ける予算だけで base まで、fine で +fineAdd、別の領域の手 1 つごとに +per（広げられる判断は elig）。予算 B は上限まで比例 */
    const world = (base: number, fineAdd: number, per: number, elig: number) => {
      const calls: Array<[number, SinkCfg]> = [];
      const run = (B: number, cfg: SinkCfg): PassStats => {
        calls.push([B, cfg]);
        const used = Math.min(cfg.areaN, elig);
        const cap = base + (cfg.fine ? fineAdd : 0) + per * used;
        const forks = Math.min(cap, Math.round(B === Infinity ? cap : 0.9 * B));
        return { forks, limited: forks < cap ? 1 : 0, areaEligible: elig, areaUsed: used, areaReverted: 0 };
      };
      return { run, calls };
    };
    const a = world(3000, 0, 0, 10);
    const pa = planBudget(a.run, 2000, 0.02);
    expect([pa.calib.saturated, pa.calib.fine, pa.chosen.cfg]).toEqual([false, false, { fine: false, areaN: 0 }]);
    const b = world(1700, 400, 100, 10);
    const pb = planBudget(b.run, 2000, 0.02);
    expect([pb.calib.saturated, pb.calib.splitMax, pb.calib.fine, pb.calib.fineMax, pb.chosen.cfg.areaN]).toEqual([true, 1700, true, 2100, 0]);
    const c = world(1500, 100, 120, 20);
    const pc = planBudget(c.run, 2000, 0.02);
    // 1600 + 120 n ≥ 1960 → n = 3（1・2・4 と倍々の後に 3 に詰める）
    expect([pc.calib.saturated, pc.calib.fineMax, pc.chosen.cfg]).toEqual([true, 1600, { fine: true, areaN: 3 }]);
    expect(pc.calib.reachMax).toBeNull();
    const d = world(1000, 50, 30, 5);
    const pd = planBudget(d.run, 2000, 0.02);
    expect([pd.calib.reachMax, pd.calib.target, pd.chosen.B, pd.chosen.cfg]).toEqual([1200, 1200, Infinity, { fine: true, areaN: 5 }]);
  });
});
