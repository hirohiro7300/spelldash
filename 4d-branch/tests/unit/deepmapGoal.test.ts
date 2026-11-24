// 地図の行き先を資産のゴールにつなぐ数（src/deepmap/core/goal.ts）: 範囲ごとの行き先・境界・芽・覚え方・アプリの計算との一致
// 数はどれも丸めた仮の数

import { afterEach, describe, expect, it } from "vitest";
import { analyze, chanceOnly, compileMap, endsFrom, FRONTIER_CAP, goalBase, goalFrom, goalInputAt, goalLeafAt, goalOf, kindKey, type Analysis, type GoalBucket } from "../../src/deepmap/core";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";
import type { DevTree, DevTreeNode } from "../../src/deepmap/mapData";
import { buildImpactDoc, impactNodeId } from "../../src/demo/impact";
import { computeForecast } from "../../src/model/forecast";
import { assetsAtBy, DEFAULT_GOAL, goalAnchor, goalInputOfImpact, goalLeaf, growthNeeded, SEED_BIZ, tablesFor, type GoalConfig } from "../../src/model/goal";
import { buildIndex } from "../../src/model/graph";
import { computeImpact } from "../../src/model/impact";
import { handTree, header, randomTree, st, toBundle } from "./deepmapFixtures";

const ANCHOR = goalAnchor("2026-11");
const cfg = (over: Partial<GoalConfig> = {}): GoalConfig => ({ ...DEFAULT_GOAL, ...over });

const isLeaf = (a: Analysis, i: number): boolean => a.cm.kidOff[i] === a.cm.kidOff[i + 1] && a.pi.def[i] === 1;

/** 範囲の行き先を重みで束ねた物（[T3, Rsal, Rbiz] の鍵 → 見込み） */
function itemsOf(b: GoalBucket): Map<string, number> {
  const out = new Map<string, number>();
  for (let k = 0; k < b.count; k++) {
    const key = [b.items[k * 4]!, b.items[k * 4 + 1]!, b.items[k * 4 + 2]!].map((x) => Math.fround(x)).join("|");
    out.set(key, (out.get(key) ?? 0) + b.items[k * 4 + 3]!);
  }
  return out;
}

function bruteItems(a: Analysis, weight: Float64Array, lo: number, hi: number): Map<string, number> {
  const out = new Map<string, number>();
  const { cm } = a;
  for (let i = lo; i < hi; i++) {
    if (!isLeaf(a, i) || !(weight[i]! > 0)) continue;
    const x = goalInputAt(a, i)!;
    const key = [x.T3, x.Rsal, x.Rbiz].map((v) => Math.fround(v)).join("|");
    out.set(key, (out.get(key) ?? 0) + Math.fround(weight[i]!));
    expect(x.Rsal + x.Rbiz).toBeCloseTo(a.pi.R[i]!, 9);
    expect(x.Rsal + x.Rbiz).toBeCloseTo(a.money.Wrr[i]!, 9);
    expect(cm.kidOff[i]).toBe(cm.kidOff[i + 1]);
  }
  return out;
}

function sameItems(got: Map<string, number>, want: Map<string, number>): void {
  expect([...got.keys()].sort()).toEqual([...want.keys()].sort());
  for (const [k, w] of want) expect(got.get(k)!).toBeCloseTo(w, 5);
}

const TREES: [string, () => DevTree][] = [
  ["手で作った地図", handTree],
  ["種 3 の地図", () => randomTree(3)],
  ["種 11 の地図", () => randomTree(11, 1500)],
];

describe("範囲ごとの行き先", () => {
  for (const [name, mk] of TREES)
    for (const annual of [360, 540])
      it(`${name}・年収 ${annual}: 今日の手ごと・おすすめ・ずっと今のままの行き先が、見込みから数えた物と同じ（見込みの合計 1）`, () => {
        const cm = compileMap(fromDevTree(mk()));
        const a = analyze(cm, annual);
        const base = goalBase(a);
        expect(base.moves.length).toBe(cm.firstMoves.length);
        for (const b of base.moves) {
          const f = b.node;
          sameItems(itemsOf(b), bruteItems(a, a.pi.reachIn, f, f + cm.size[f]!));
          if (b.count) expect(b.mass).toBeCloseTo(1, 6);
          // 部分木のどの行き先の事業の稼ぎより小さくない
          let mx = -Infinity;
          for (let i = f; i < f + cm.size[f]!; i++) if (isLeaf(a, i)) mx = Math.max(mx, goalInputAt(a, i)!.Rbiz);
          expect(b.treeMaxBiz).toBe(mx);
        }
        sameItems(itemsOf(base.pi!), bruteItems(a, a.pi.reach, 0, cm.n));
        sameItems(itemsOf(base.keep!), bruteItems(a, a.keep.reach, 0, cm.n));
        expect(base.pi!.mass).toBeCloseTo(1, 6);
        expect(base.keep!.mass).toBeCloseTo(1, 6);
        expect(base.pi!.node).toBe(a.pi.pi[0]);
        expect(base.keep!.node).toBe(a.keep.pi[0]);
      });
});

describe("一番良い行き先（パレート境界）", () => {
  for (const [name, mk] of TREES)
    it(`${name}: どんな 0 以上の係数でも、境界の一番は全部の行き先の一番と同じ。要る伸びの一番小さい物も同じ`, () => {
      const cm = compileMap(fromDevTree(mk()));
      const a = analyze(cm, 360);
      const base = goalBase(a);
      let seed = 7;
      const rand = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      for (const b of base.moves) {
        const f = b.frontier;
        expect(f.capped).toBe(false);
        expect(f.n).toBeLessThanOrEqual(FRONTIER_CAP);
        for (let r = 0; r < 20; r++) {
          const [c1, c2, c3] = [rand(), rand() * 400, rand() * 400];
          let brute = -Infinity;
          for (let i = b.node; i < b.node + cm.size[b.node]!; i++) {
            if (!isLeaf(a, i)) continue;
            const x = goalInputAt(a, i)!;
            brute = Math.max(brute, c1 * x.T3 + c2 * x.Rsal + c3 * x.Rbiz);
          }
          let fr = -Infinity;
          for (let k = 0; k < f.n; k++) fr = Math.max(fr, c1 * f.T3[k]! + c2 * f.Rsal[k]! + c3 * f.Rbiz[k]!);
          expect(fr).toBeCloseTo(brute, 6);
        }
      }
      for (const c of [cfg(), cfg({ assets: 30_000, ret: 5, by: 2046 }), cfg({ target: 5_000 })]) {
        const t = tablesFor(c, ANCHOR);
        const sum = goalOf(base, t);
        sum.moves.forEach((sc, k) => {
          const b = base.moves[k]!;
          let bestAt = -Infinity;
          let bestG = Infinity;
          for (let i = b.node; i < b.node + cm.size[b.node]!; i++) {
            if (!isLeaf(a, i)) continue;
            const x = goalInputAt(a, i)!;
            bestAt = Math.max(bestAt, assetsAtBy(t, x.T3, x.Rsal, x.Rbiz));
            bestG = Math.min(bestG, growthNeeded(t, x.T3, x.Rsal, x.Rbiz));
          }
          expect(sc.best!.atBy).toBeCloseTo(bestAt, 6);
          if (Number.isFinite(bestG)) expect(sc.bestGrow!.gReq).toBeCloseTo(bestG, 9);
          else expect(sc.bestGrow).toBeNull();
          // 結果の見込みだけを掛けた見込み
          const p = chanceOnly(cm, sc.best!.node);
          expect(sc.best!.prob).toBe(p);
          expect(p).toBeGreaterThanOrEqual(0);
          expect(p).toBeLessThanOrEqual(1);
        });
      }
    });
});

/** 辞めて独立する手の先: おすすめの選び方は会社員に戻る（事業の稼ぎが小さい）が、独立を続ける行き先は事業の稼ぎが大きい */
function indQuitTree(): DevTree {
  const end = (k: string, p: number, e: [number, number, number], rr: [number, number, number]): DevTreeNode => ({ k, r: "e", m: 36, st: st(), id: k, p, lab: k, line: `${k}の場合`, e, rr });
  const root: DevTreeNode = {
    k: "r",
    r: "r",
    m: 0,
    st: st(),
    rr: [1, 0, 0],
    kids: [
      { k: "r.keep", r: "a", m: 0, st: st(), kind: "keep", base: true, h: 0, kids: [end("r.keep.x", 100, [36, 0, 2], [1, 0, 0.5])] },
      {
        k: "r.iq",
        r: "a",
        m: 0,
        st: st(),
        kind: "ind_quit",
        h: 2,
        kids: [
          {
            k: "r.iq.s",
            r: "s",
            m: 3,
            st: st(),
            id: "s",
            p: 100,
            lab: "独立",
            line: "独立の場合",
            e: [0, 30, 0],
            rr: [0, 10, 0],
            kids: [
              // 会社員に戻る: 3 年の合計は大きいが、事業の稼ぎは小さい
              { k: "r.iq.s.back", r: "a", m: 3, st: st(), kind: "fc_switch", h: 0, kids: [end("r.iq.s.back.x", 100, [36, 0, 0], [1.2, 2, 0])] },
              // 独立を続ける: 合計は小さいが、事業の稼ぎは月 25 万円
              { k: "r.iq.s.stay", r: "a", m: 3, st: st(), kind: "ind_quit", h: 0, kids: [end("r.iq.s.stay.x", 100, [0, 400, 0], [0, 25, 0])] },
            ],
          },
        ],
      },
    ],
  };
  return { header: header(), root };
}

describe("芽", () => {
  it("芽の見込みは 0 だが部分木にはある →「芽は選び方しだい」。芽のある行き先が選ばれれば芽の見込み", () => {
    const cm = compileMap(fromDevTree(indQuitTree()));
    const a = analyze(cm, 360);
    const sum = goalOf(goalBase(a), tablesFor(cfg(), ANCHOR));
    const iq = sum.moves.find((s) => kindKey(cm, s.node) === "ind_quit")!;
    expect(iq.seed).toBe(0);
    expect(iq.seedExists).toBe(true);
    expect(iq.choiceOnly).toBe(true);
    expect(iq.bestGrow!.Rbiz).toBe(25);
    const keep = sum.moves.find((s) => kindKey(cm, s.node) === "keep")!;
    expect(keep.seedExists).toBe(false);
    expect(keep.choiceOnly).toBe(false);
    // 年収が小さく独立を続ける方が良くなると、芽の見込みは 1
    const low = analyze(cm, 60);
    const iq2 = goalOf(goalBase(low), tablesFor(cfg(), ANCHOR)).moves.find((s) => kindKey(cm, s.node) === "ind_quit")!;
    expect(iq2.seed).toBe(1);
    expect(iq2.choiceOnly).toBe(false);
    expect(goalLeafAt(low, cm.map.indexOfKey("r.iq.s.stay.x"), tablesFor(cfg(), ANCHOR))!.seed).toBe(true);
    expect(SEED_BIZ).toBe(10);
  });

  it("仮の値では、どの手も期限までに届かない（届く見込み 0 は数として持つが、画面には出さない）", () => {
    const cm = compileMap(fromDevTree(handTree()));
    const sum = goalOf(goalBase(analyze(cm, 360)), tablesFor(cfg(), ANCHOR));
    expect(sum.noneReach).toBe(true);
    for (const s of sum.moves) {
      expect(s.pBy).toBe(0);
      expect(s.reach.unreached).toBeCloseTo(1, 6);
      expect(s.atBy!.p10).toBeLessThanOrEqual(s.atBy!.p50);
      expect(s.atBy!.p50).toBeLessThanOrEqual(s.atBy!.p90);
    }
    // 今の資産が大きければ届く
    const rich = goalOf(goalBase(analyze(cm, 360)), tablesFor(cfg({ assets: 90_000, ret: 4 }), ANCHOR));
    expect(rich.noneReach).toBe(false);
    expect(rich.pi!.pBy).toBe(1);
    expect(rich.pi!.reach.p50).not.toBeNull();
  });
});

describe("覚え方と重さ", () => {
  const RealF64 = globalThis.Float64Array;
  afterEach(() => {
    globalThis.Float64Array = RealF64;
  });

  it("goalBase はカードの数の長さの配列を作らない。同じ計算・同じ設定なら同じ物。設定を変えても goalBase は使い回す", () => {
    const cm = compileMap(fromDevTree(randomTree(5, 2000)));
    const a = analyze(cm, 360);
    const big: number[] = [];
    globalThis.Float64Array = new Proxy(RealF64, {
      construct(target, args: unknown[]) {
        const n = typeof args[0] === "number" ? args[0] : 0;
        if (n >= cm.n) big.push(n);
        return Reflect.construct(target, args) as object;
      },
    });
    const base = goalBase(a);
    globalThis.Float64Array = RealF64;
    expect(big).toEqual([]);
    expect(goalBase(a)).toBe(base);
    const t1 = tablesFor(cfg(), ANCHOR);
    const s1 = goalOf(base, t1);
    expect(goalOf(base, tablesFor(cfg(), ANCHOR))).toBe(s1);
    const s2 = goalOf(base, tablesFor(cfg({ assets: 500 }), ANCHOR));
    expect(s2).not.toBe(s1);
    expect(goalBase(a)).toBe(base);
    for (let k = 0; k < 4; k++) goalOf(base, tablesFor(cfg({ save: 30 + k }), ANCHOR));
    expect(base.memo.size).toBe(4);
    expect(goalOf(base, t1)).not.toBe(s1);
    // 年収を変えた計算は別の物
    expect(goalBase(analyze(cm, 540))).not.toBe(base);
  });

  it("途中のカードの先（endsFrom の答え）: 今日の手なら、その手の範囲の数と同じ", () => {
    const cm = compileMap(fromDevTree(handTree()));
    const a = analyze(cm, 360);
    const t = tablesFor(cfg({ assets: 500 }), ANCHOR);
    const sum = goalOf(goalBase(a), t);
    for (const s of sum.moves) {
      const g = goalFrom(a, s.node, endsFrom(a, s.node), t);
      expect(g.node).toBe(s.node);
      expect(g.atBy!.p50).toBeCloseTo(s.atBy!.p50, 3);
      expect(g.seed).toBeCloseTo(s.seed, 6);
      expect(g.est).toBeCloseTo(s.est, 6);
      expect(g.best).toBeNull();
    }
    // 途中のカードは内訳なしの平均（芽・伸びは出さない）
    const mid = cm.firstMoves[0]! + 1;
    const x = goalInputAt(a, mid)!;
    expect(x.split).toBe(false);
    expect(x.T3).toBeCloseTo(a.money.acc[mid]! + a.pi.V[mid]!, 9);
    expect(Number.isNaN(goalLeaf(t, x).gReq)).toBe(true);
  });
});

describe("アプリの計算（ImpactResult）と同じ 3 つの数", () => {
  for (const tail of [0, 12])
    it(`36 か月の後に ${tail} か月を足した計算でも、行き先の 3 年の合計と月の稼ぎが地図の計算と 1e-9 まで同じ${tail ? "（途中のカードは足した月で選ぶ手が変わりうるので行き先だけ）" : "（どのカードも）"}`, () => {
      const map = fromDevTree(randomTree(9, 900));
      const cm = compileMap(map);
      const a = analyze(cm, 360);
      const b = toBundle(map);
      const doc = buildImpactDoc(b, new Date(2026, 10, 19), "test");
      const root = doc.nodes[impactNodeId(b.nodes[0]![0])]!;
      root.meta = { ...root.meta, impact: { v: 2, horizon: 36, annual: 360, tail } };
      for (const n of Object.values(doc.nodes)) n.status = "open";
      const idx = buildIndex(doc);
      const res = computeImpact(doc, idx.out, computeForecast(doc, idx.out, null), null);
      expect(res.tail).toBe(tail);
      let leaves = 0;
      for (let i = 0; i < cm.n; i++) {
        if (!a.pi.def[i] || (tail > 0 && !isLeaf(a, i))) continue;
        const id = impactNodeId(map.key(i));
        const want = goalInputAt(a, i)!;
        const got = goalInputOfImpact(res, id, doc.nodes[id]!.meta?.rr)!;
        expect(got.split).toBe(want.split);
        expect(Math.abs(got.T3 - want.T3)).toBeLessThan(1e-9 * Math.max(1, Math.abs(want.T3)));
        expect(Math.abs(got.Rsal + got.Rbiz - (want.Rsal + want.Rbiz))).toBeLessThan(1e-9);
        if (want.split) {
          leaves++;
          expect(Math.abs(got.Rbiz - want.Rbiz)).toBeLessThan(1e-9);
        }
      }
      expect(leaves).toBeGreaterThan(50);
    });
});
