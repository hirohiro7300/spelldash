// 3 か月ごとの地図の計算（scripts/impact/q）: 世界の作り替え・3 か月の手の決まり・結果のまとめ方・入口の引数。粗い表は作らない（速い）
import { describe, expect, it } from "vitest";
import worldJson from "../../scripts/impact/world.json";
import type { Sample, St, World } from "../../scripts/impact/sim";
import { parseArgs } from "../../scripts/impact/q/cli";
import { coarseKey, collapsed, quarterOutcomes, repState } from "../../scripts/impact/q/core";
import { CODE, DEFAULTS, Heap, R1_ALTS_BY } from "../../scripts/impact/q/gen";
import { feasibleQ, LIMITS, simQ, uses } from "../../scripts/impact/q/quarter";
import { CHANGES, NSTAGE, quarterWorld, type WorldQ } from "../../scripts/impact/q/world";

const base = worldJson as unknown as World;
const w: WorldQ = quarterWorld(base);
const S = w.annual / 12;
const st = (over: Partial<St> = {}): St => ({ ...w.today, fl: [], ...over });
const withFlags = (s: St, ...f: string[]): St => ({ ...s, fl: [...new Set([...s.fl, ...f])].sort() });
const total = (xs: Sample[], f: (x: Sample) => boolean = () => true) => xs.filter(f).reduce((a, x) => a + x.w, 0);

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
    expect(CHANGES.length).toBe(6);
  });

  it("続けた 3 期で、前の 9 か月の手の見込み（移る 45%: 1.18 倍 20%・1.08 倍 25%）になる", () => {
    const p = w.kinds.fc_switch!.p;
    const first = p.pHigh3! + p.pMid3!;
    const cont = w.qSwitch2.pHigh + w.qSwitch2.pMid;
    expect(1 - (1 - first) * (1 - cont) ** 2).toBeCloseTo(0.45, 2);
    expect(p.pHigh3! + (1 - first) * w.qSwitch2.pHigh * (1 + (1 - cont))).toBeCloseTo(0.2, 2);
    expect(p.pMid3! + (1 - first) * w.qSwitch2.pMid * (1 + (1 - cont))).toBeCloseTo(0.25, 2);
  });

  it("元の世界は変えない", () => {
    const before = JSON.stringify(base);
    quarterWorld(base);
    expect(JSON.stringify(base)).toBe(before);
    expect(Object.keys(base.kinds)).toContain("plan_ind");
  });
});

describe("3 か月の手の決まり", () => {
  it("転職活動の 1 期目は 1 つの会社で 1 回だけ。断られた後は続ける手（2 期目以降の見込み）", () => {
    const today = st();
    expect(feasibleQ(w, today, "fc_switch", 0)).toBe(true);
    expect(feasibleQ(w, today, "fc_switch2", 0)).toBe(false);
    const xs = simQ(w, today, "fc_switch", 0);
    expect(total(xs, (x) => x.x.fl.includes("switched"))).toBeCloseTo(0.28, 9);
    const stay = xs.find((x) => !x.x.fl.includes("switched"))!.x;
    expect(stay.fl).toEqual(expect.arrayContaining(["js", "jx"]));
    expect(feasibleQ(w, stay, "fc_switch", 3)).toBe(false);
    expect(feasibleQ(w, stay, "fc_switch2", 3)).toBe(true);
    // 続けると 1 期 12.6%（7.4%・5.2%）
    const ys = simQ(w, stay, "fc_switch2", 3);
    expect(total(ys, (x) => x.x.fl.includes("switched"))).toBeCloseTo(0.126, 9);
    // 休んでも、この会社では 1 期目に戻らない（js は外れ jx は残る）
    const rest = simQ(w, stay, "keep", 3)[0]!.x;
    expect(rest.fl.includes("js")).toBe(false);
    expect(rest.fl.includes("jx")).toBe(true);
    expect(feasibleQ(w, rest, "fc_switch", 6)).toBe(false);
    expect(feasibleQ(w, rest, "fc_switch2", 6)).toBe(true);
  });

  it("移った会社では、週 4 日も聞き直せる（転職活動の印は外れる）。転職は 1 回だけ", () => {
    const s0 = withFlags(st(), "jx", "pq");
    const moved = simQ(w, s0, "fc_switch2", 3).find((x) => x.x.fl.includes("switched"))!.x;
    for (const f of ["js", "jx", "pq"]) expect(moved.fl.includes(f)).toBe(false);
    expect(feasibleQ(w, moved, "part", 6)).toBe(true);
    expect(feasibleQ(w, moved, "fc_switch", 6)).toBe(false);
    expect(feasibleQ(w, moved, "fc_switch2", 6)).toBe(false);
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

  it("独立から会社員に戻ると、週 4 日も転職活動の 1 期目もまた聞ける", () => {
    const ind = withFlags(st({ j: "i" }), "jx", "pq");
    const back = simQ(w, ind, "back_emp", 6).filter((x) => x.x.j === "e");
    expect(back.length).toBeGreaterThan(0);
    for (const x of back) {
      expect(x.x.fl.includes("pq")).toBe(false);
      expect(x.x.fl.includes("jx")).toBe(false);
    }
  });

  it("遊ぶ人を増やす・広告で集めるは 4 期まで、続ける人を増やすは 1 回だけ、sd_pro は選べない", () => {
    let s = st();
    for (let q = 1; q <= LIMITS.sd_grow; q++) {
      expect(feasibleQ(w, s, "sd_grow", 3 * q)).toBe(true);
      s = simQ(w, s, "sd_grow", 3 * q)[0]!.x;
      expect(uses(s, "g")).toBe(q);
      expect(s.fl.filter((f) => /^g\d$/.test(f))).toEqual([`g${q}`]);
    }
    expect(feasibleQ(w, s, "sd_grow", 15)).toBe(false);
    const pro = st({ pro: 1, pm: "s", pu: 20, mau: 400 });
    expect(feasibleQ(w, st(), "sd_ads", 3)).toBe(false);
    let a = pro;
    for (let q = 1; q <= LIMITS.sd_ads; q++) a = simQ(w, a, "sd_ads", 3 * q)[0]!.x;
    expect(uses(a, "a")).toBe(4);
    expect(feasibleQ(w, a, "sd_ads", 15)).toBe(false);
    const r = simQ(w, pro, "sd_retain", 3)[0]!.x;
    expect(r.fl.includes("rt")).toBe(true);
    expect(feasibleQ(w, pro, "sd_retain", 3)).toBe(true);
    expect(feasibleQ(w, r, "sd_retain", 6)).toBe(false);
    expect(feasibleQ(w, pro, "sd_pro", 3)).toBe(false);
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

  it("代表の状態: 分類は一番重い物・数は重みの平均・印は半分以上が持つ物", () => {
    const a = st({ j: "e", mau: 100, cl: 1, fee: 5, fl: ["js", "scope"] });
    const b = st({ j: "p", mau: 200, cl: 0, fee: 0, fl: ["scope"] });
    const r = repState([
      { x: a, w: 0.3 },
      { x: b, w: 0.7 },
    ]);
    expect(r.j).toBe("p");
    expect(r.mau).toBeCloseTo(170, 9);
    expect(r.cl).toBeCloseTo(0.3, 9);
    expect(r.fee).toBe(5);
    expect(r.fl).toEqual(["scope"]);
    const c = collapsed(simQ(w, st(), "sd_grow", 0), 3);
    expect(c.p).toBe(100);
    expect(c.st.fl).toEqual(["g1"]);
  });

  it("粗い表のマス: SpellDash の数は見ず、給与は 0.05 刻み", () => {
    const g = { sal: 0.05, sd: false, corr: true };
    expect(coarseKey(1, st({ mau: 40 }), g)).toBe(coarseKey(1, st({ mau: 900, pu: 30 }), g));
    expect(coarseKey(1, st({ sal: 1.02 }), g)).toBe(coarseKey(1, st(), g));
    expect(coarseKey(1, st({ sal: 1.03 }), g)).not.toBe(coarseKey(1, st(), g));
    expect(coarseKey(1, withFlags(st(), "jx"), g)).not.toBe(coarseKey(1, st(), g));
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
    expect(o).toEqual({ out: "x.json", params: { ...DEFAULTS, altsBy: [...R1_ALTS_BY] }, anchor: "2026-11", hash: "dev-port" });
    expect(o.params).toMatchObject({ B: 2000, maxAlts: 4, stubMode: "split", factCl: false, altsBy: [0, 4, 4, 4, 4, 3, 3, 3, 3, 2, 2, 2] });
  });

  it("形を変える引数", () => {
    const o = parseArgs(["--budget", "300", "--alts", "3", "--alts-by", "off", "--stub", "lean", "--fact-cl", "--only", "keep,part", "--anchor", "2027-02", "--hash", "h", "--out", "t.json"], w.rootMenu);
    expect(o.params).toMatchObject({ B: 300, maxAlts: 3, stubMode: "lean", factCl: true });
    expect(o.params.altsBy).toBeUndefined();
    expect([o.only, o.anchor, o.hash, o.out]).toEqual([["keep", "part"], "2027-02", "h", "t.json"]);
    expect(parseArgs(["--out", "t", "--alts-by", "0,3,3,3,3,3,3,3,3,2,2,2"], w.rootMenu).params.altsBy).toEqual([0, 3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 2]);
  });

  it("読めない引数は投げる", () => {
    const bad = [[], ["--out"], ["--out", "x", "--budget", "0"], ["--out", "x", "--only", "plan_ind"], ["--out", "x", "--anchor", "2026-13"], ["--out", "x", "--alts-by", "0,4,4"], ["--out", "x", "--stub", "all"], ["--out", "x", "--nope"]];
    for (const args of bad) expect(() => parseArgs(args, w.rootMenu), args.join(" ")).toThrow();
  });
});
