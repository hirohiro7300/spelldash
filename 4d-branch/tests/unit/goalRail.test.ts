// 地図のいちばん右の資産のゴール（src/canvas/goalRail.ts）の確かめ: ゴールのカード・札の文字、行き先からゴールへの線の数と描き方
// （まとめて描く・実線はゴールの何割かまで・縮めたら芽だけ 400 本まで・選んだ道の上は濃く・選んだ行き先に札）。
// 数はどれも丸めた仮の数（目標 10 億円・期限 2056 年・行き先の期限の資産 5,000 万円など）

import { describe, expect, it } from "vitest";
import { spacingIssues } from "../../scripts/impact/textChecks";
import { GOAL_RAIL_DEPTH, GOAL_RAIL_DX, GOAL_STUB_LABEL_CAP, GOAL_STUB_LOW_CAP, GoalRail, goalRailText, goalStubLabel, pushCardBox, type CardBoxes, type GoalMoveTag, type GoalRailHost, type GoalScene } from "../../src/canvas/goalRail";
import type { ImpactCard } from "../../src/canvas/impactCards";
import { spaceJa } from "../../src/demo/compose/text";
import { NODE_W } from "../../src/model/constants";
import { goalAnchor, goalConfigOf, tablesFor } from "../../src/model/goal";
import { impactColX } from "../../src/model/impactLayout";

function spaced(s: string): void {
  expect(spaceJa(s), s).toBe(s);
  expect(spacingIssues(s), s).toEqual([]);
}

interface Call {
  op: string;
  args: unknown[];
  stroke: string;
  dash: number;
}

function recorder(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const state: Record<string, unknown> = { font: "10px sans-serif", fillStyle: "", strokeStyle: "", lineWidth: 1, lineCap: "butt" };
  let dash: number[] = [];
  const ctx = new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key];
      if (key === "measureText") return (t: string) => ({ width: Array.from(t).length * 7 });
      if (key === "setLineDash") return (d: number[]) => void (dash = d);
      return (...args: unknown[]) => void calls.push({ op: key, args, stroke: String(target.strokeStyle), dash: dash.length });
    },
    set(target, key: string, v) {
      target[key] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const T = tablesFor(goalConfigOf(null).cfg, goalAnchor("2026-11"));

function card(seed: boolean, frac = 0.05): ImpactCard {
  return { role: "end", goal: { text: "10 億: 事業が年 +28%・目安", seed, frac, reached: frac >= 1, atBy: frac * 100_000 } } as ImpactCard;
}

/** 行き先 n 枚（36 か月目の列・行ごとに 128 下）。seedEvery 枚ごとに芽 */
function scene(n: number, opts: Partial<GoalScene> & { seedEvery?: number; z?: number } = {}): GoalScene {
  const z = opts.z ?? 0.5;
  const ends = Array.from({ length: n }, (_, k) => `e${k}`);
  const cards = new Map(ends.map((id, k) => [id, card(k % (opts.seedEvery ?? 3) === 0)] as const));
  return {
    ctx: recorder().ctx,
    width: 1000,
    height: 800,
    top: 26,
    z,
    cx: 1000 - 80 - GOAL_RAIL_DX * z,
    cy: 40,
    lod: z >= 0.8 ? "full" : z >= 0.3 ? "compact" : z >= 0.1 ? "low" : "dot",
    railX: GOAL_RAIL_DX,
    ends,
    pos: (id) => ({ x: impactColX(24), y: Number(id.slice(1)) * 128 }),
    card: (id) => cards.get(id) ?? null,
    pathActive: false,
    onPath: () => false,
    selected: null,
    t: T,
    ...opts,
  };
}

describe("ゴールのカードと札の文字", () => {
  it("カード: ゴール・資産 10 億円・期限（仮）・おすすめの道の期限の資産（何割・目安）。札はだれの数かと目安を並べ、机とスマホで短さが違う", () => {
    const x = goalRailText({ key: "k", T: 100_000, by: 2056, byKari: true, mid: 4600, path: "pi" });
    expect(x.name).toBe("資産 10 億円");
    expect(x.by).toBe("2056 年まで（仮）");
    expect(x.now).toBe("おすすめの道 0.46 億（5%）目安");
    expect(x.chipWide).toBe("→ ゴール 10 億円（おすすめの道 5%・目安）");
    expect(x.chipNarrow).toBe("10億 · おすすめ 5%目安 ›");
    expect(x.aria).toContain("おすすめの選び方では約 0.46 億円（ゴールの 5%）の目安");
    // 読み上げは見えている文字から始まる（声で押すときに見えている文字で呼べる: 見直し reader-2）
    expect(x.aria.startsWith("ゴール、資産 10 億円、2056 年まで（仮）")).toBe(true);
    expect(x.chipAria.startsWith("ゴール 10 億円（おすすめの道 5%・目安）")).toBe(true);
    expect(x.chipAriaNarrow.startsWith("10億 · おすすめ 5%目安")).toBe(true);
    for (const a of [x.chipAria, x.chipAriaNarrow]) {
      expect(a).toContain("2056 年にゴールの 5% の資産（目安）");
      expect(a).toContain("地図の 3 年後の列の右です");
    }
    // 札（「10億 · おすすめ 5%目安 ›」: 設計どおりの詰めた形）のほかは、地図の文と同じ言葉の間
    for (const s of [x.name, x.by, x.now!, x.aria, x.chipAria]) spaced(s);
  });

  it("おすすめの選び方が無い地図（ずっと今のままの数）は「今のまま」と書く（見直し reader-3）", () => {
    const x = goalRailText({ key: "k", T: 100_000, by: 2056, byKari: false, mid: 4600, path: "keep" });
    expect(x.now).toBe("今のまま 0.46 億（5%）目安");
    expect(x.chipWide).toBe("→ ゴール 10 億円（今のまま 5%・目安）");
    expect(x.chipNarrow).toBe("10億 · 今のまま 5%目安 ›");
    expect(x.aria).toContain("ずっと今のままなら約 0.46 億円");
    expect(x.aria).not.toContain("おすすめ");
  });

  it("0% は出さない（期限の資産が 0）。目標を変えればその目標（3 億円）。1 億より下の目標は万円", () => {
    const zero = goalRailText({ key: "k", T: 100_000, by: 2056, byKari: false, mid: 0, path: "pi" });
    expect(zero.chipWide).toBe("→ ゴール 10 億円");
    expect(zero.chipNarrow).toBe("10億 ›");
    expect(zero.now).toBe("おすすめの道 0 万円・目安");
    expect(goalRailText({ key: "k", T: 30_000, by: 2050, byKari: false, mid: 3000, path: "pi" }).chipWide).toBe("→ ゴール 3 億円（おすすめの道 10%・目安）");
    expect(goalRailText({ key: "k", T: 5000, by: 2050, byKari: false, mid: 500, path: "pi" }).chipNarrow).toBe("5,000万 · おすすめ 10%目安 ›");
    expect(goalRailText({ key: "k", T: 100_000, by: 2056, byKari: false, mid: null, path: null }).now).toBeNull();
  });

  it("選んだ行き先の線の札: 「2056 年 0.45 億円（5%）目安」", () => {
    expect(goalStubLabel(T, 4500)).toBe("2056 年 0.45 億円（5%）目安");
    expect(goalStubLabel(T, 0)).toBe("2056 年 0 万円・目安");
    spaced(goalStubLabel(T, 4500));
  });
});

describe("行き先からゴールへの線", () => {
  it("見えている行き先の数だけ線を引き、4 本（金と灰の実線・点線）にまとめて描く。実線はゴールの何割かの所まで、その先は点線", () => {
    const { ctx, calls } = recorder();
    const g = new GoalRail(
      () => {},
      () => {},
    );
    g.draw(scene(40, { ctx }));
    // 縦 800px・拡大 0.5 → 行 128 の 12 行ほどが見える
    expect(g.stubs).toBeGreaterThan(5);
    expect(g.stubs).toBeLessThan(15);
    const strokes = calls.filter((c) => c.op === "stroke");
    // ゴールの列 1 本 + 線の組 4 本
    expect(strokes.length).toBe(5);
    expect(g.strokes).toBe(5);
    const solid = calls.filter((c) => c.op === "lineTo").slice(1);
    expect(solid.length).toBe(g.stubs * 2);
    // 実線の長さ: 列までの 5%（短くても 6px）
    const moves = calls.filter((c) => c.op === "moveTo").slice(1);
    const x0 = (impactColX(24) + NODE_W / 2) * 0.5 + (1000 - 80 - GOAL_RAIL_DX * 0.5);
    const rx = 1000 - 80;
    expect(moves[0]!.args[0]).toBeCloseTo(x0, 6);
    expect(solid[0]!.args[0]).toBeCloseTo(x0 + Math.max(6, 0.05 * (rx - x0)), 6);
  });

  it("ゴールの列が画面の左の外・行き先が画面の上下の外なら線は無い", () => {
    const g = new GoalRail(
      () => {},
      () => {},
    );
    g.draw(scene(40, { cx: -GOAL_RAIL_DX * 0.5 - 50 }));
    expect(g.stubs).toBe(0);
    g.draw(scene(40, { cy: -100_000 }));
    expect(g.stubs).toBe(0);
  });

  it("縮めたとき（low・dot）は芽の線だけ、400 本まで", () => {
    const g = new GoalRail(
      () => {},
      () => {},
    );
    g.draw(scene(3000, { z: 0.15, seedEvery: 3 }));
    const near = new GoalRail(
      () => {},
      () => {},
    );
    near.draw(scene(3000, { z: 0.31, seedEvery: 3 }));
    expect(g.stubs).toBeGreaterThan(0);
    // 0.15 で見える行（約 40 行）の 1/3 が芽
    expect(g.stubs).toBeLessThanOrEqual(Math.ceil(800 / 0.15 / 128 / 3) + 1);
    const many = new GoalRail(
      () => {},
      () => {},
    );
    many.draw(scene(20_000, { z: 0.05, seedEvery: 1, height: 100_000 }));
    expect(many.stubs).toBe(GOAL_STUB_LOW_CAP);
  });

  it("選んだ道の上の行き先の線は濃く（ほかは薄く）、選んだ行き先には期限の資産の札。描くのは濃い 4 本と薄い 4 本まで", () => {
    const { ctx, calls } = recorder();
    const g = new GoalRail(
      () => {},
      () => {},
    );
    g.draw(scene(40, { ctx, pathActive: true, onPath: (id) => id === "e3" || id === "e4", selected: "e3" }));
    expect(g.emph).toBe(2);
    expect(g.labeled).toBe(true);
    expect(g.strokes).toBeLessThanOrEqual(9);
    const text = calls.find((c) => c.op === "fillText" && String(c.args[0]).startsWith("2056 年 "))!;
    // 札は選んだ行き先の期限の資産（5,000 万円 = ゴールの 5%）
    expect(text.args[0]).toBe("2056 年 0.5 億円（5%）目安");
  });

  it("ゴールの列が画面の外のときは、ゴールのカード（DOM）が無くても描ける。off() で数を 0 に", () => {
    const g = new GoalRail(
      () => {},
      () => {},
    );
    g.draw(scene(40, { cx: -10 }));
    expect(g.railSx).not.toBeNull();
    g.off();
    expect(g.stubs).toBe(0);
    expect(g.railSx).toBeNull();
    expect(g.state).toBe("");
  });

  it("線の札「10億の 5%」: 近いときだけ、行の間を空けて 12 本まで。いちばん上に「2056 年・目安」。0% は出さない（見直し reader-4）", () => {
    const { ctx, calls } = recorder();
    const g = new GoalRail(
      () => {},
      () => {},
    );
    // 行 128 × 拡大 0.5 = 64px ごと: 見えている線の数だけ札（12 本まで）
    g.draw(scene(40, { ctx }));
    expect(g.stubLabels).toBeGreaterThan(5);
    expect(g.stubLabels).toBeLessThanOrEqual(Math.min(g.stubs, GOAL_STUB_LABEL_CAP));
    const texts = calls.filter((c) => c.op === "fillText").map((c) => String(c.args[0]));
    expect(texts.filter((t) => t === "10億の 5%").length).toBe(g.stubLabels);
    expect(texts).toContain("2056 年・目安");
    // 札はゴールの列の手前（右の端は列の 6px 左）
    const labels = calls.filter((c) => c.op === "fillText" && c.args[0] === "10億の 5%");
    for (const c of labels) expect((c.args[1] as number) + 7 * 7).toBeCloseTo(1000 - 80 - 6, 6);
    // 行が詰まると（拡大 0.1 より上でも 1 行 13px）間を空ける: 12 本まで・行の間 15px 以上
    const dense = new GoalRail(
      () => {},
      () => {},
    );
    const r2 = recorder();
    dense.draw(scene(400, { ctx: r2.ctx, z: 0.3, cx: 1000 - 80 - GOAL_RAIL_DX * 0.3, pos: (id) => ({ x: impactColX(24), y: Number(id.slice(1)) * 40 }) }));
    expect(dense.stubLabels).toBe(GOAL_STUB_LABEL_CAP);
    const ys = r2.calls.filter((c) => c.op === "fillText" && c.args[0] === "10億の 5%").map((c) => c.args[2] as number);
    for (let k = 1; k < ys.length; k++) expect(ys[k]! - ys[k - 1]!).toBeGreaterThanOrEqual(15);
    // 縮めたとき（low）は出さない・0% の行き先には出さない
    const low = new GoalRail(
      () => {},
      () => {},
    );
    low.draw(scene(40, { z: 0.2, cx: 1000 - 80 - GOAL_RAIL_DX * 0.2 }));
    expect(low.stubLabels).toBe(0);
    const zero = new GoalRail(
      () => {},
      () => {},
    );
    zero.draw(scene(40, { card: () => card(false, 0.001) }));
    expect(zero.stubs).toBeGreaterThan(0);
    expect(zero.stubLabels).toBe(0);
  });

  it("選んだ行き先の札は画面の右で切れない（「目安」が残る）。入らなければカードの上へ（見直し reader-5）", () => {
    const { ctx, calls } = recorder();
    const g = new GoalRail(
      () => {},
      () => {},
    );
    // 狭い画面（390）で、カードの右の端が 300px: 札（約 20 文字 × 7px）は右に入らない
    const z = 0.42;
    const x0 = 300;
    const cx = x0 - (impactColX(24) + NODE_W / 2) * z;
    g.draw(scene(10, { ctx, width: 390, height: 844, z, cx, cy: 200, selected: "e3" }));
    expect(g.labeled).toBe(true);
    expect(g.labelRight!).toBeLessThanOrEqual(390 - 4);
    const text = calls.find((c) => c.op === "fillText" && String(c.args[0]).startsWith("2056 年 "))!;
    expect(String(text.args[0]).endsWith("目安")).toBe(true);
    // カードの上の縁の上（線の高さ 3 × 128 × 0.42 + 200 から、カードの半分の高さより上）
    expect(text.args[2] as number).toBeLessThan(3 * 128 * z + 200 - (96 / 2) * z);
  });

  it("今日の手のカードの上の縁に芽の札（近いときだけ・カードに入らなければ出さない）。数だけ数える（見直し reader-4）", () => {
    const { ctx, calls } = recorder();
    const g = new GoalRail(
      () => {},
      () => {},
    );
    const moves = new Map([
      ["m0", { text: "芽 14%", share: 0.14 }],
      ["m1", { text: "芽: 選び方", share: 0 }],
    ]);
    (g as unknown as { host: GoalRailHost }).host = { info: () => ({ key: "k", T: 100_000, by: 2056, byKari: false, mid: 4600, path: "pi", moves }), open() {} };
    const pos = (id: string) => (id.startsWith("m") ? { x: 300, y: Number(id.slice(1)) * 128 } : { x: impactColX(24), y: Number(id.slice(1)) * 128 });
    g.draw(scene(5, { ctx, z: 0.62, cx: 100, cy: 100, pos, shown: (id: string) => ["m0", "m1", "m2"].includes(id) }));
    expect(g.moveTags).toBe(2);
    const texts = calls.filter((c) => c.op === "fillText").map((c) => String(c.args[0]));
    expect(texts).toContain("芽 14%");
    expect(texts).toContain("芽: 選び方");
    // キャンバスに出ていない手には出さない・縮めたとき（low）は出さない
    g.draw(scene(5, { z: 0.62, cx: 100, cy: 100, pos, shown: (id: string) => ["m1"].includes(id) }));
    expect(g.moveTags).toBe(1);
    g.draw(scene(5, { z: 0.2, cx: 100, cy: 100, pos, shown: (id: string) => ["m0", "m1"].includes(id) }));
    expect(g.moveTags).toBe(0);
  });

  it("詰まった行き先の線の札は、ゴールに近い（割合の大きい）線から置く（上から順に置いて大きい線の札を消さない: 見直し reader-2）", () => {
    const { ctx, calls } = recorder();
    const g = new GoalRail(
      () => {},
      () => {},
    );
    const fr = [0.02, 0.3, 0.02];
    // 行き先 3 枚が 20 × 0.5 = 10px おき（札は 15px おき: 1 つしか置けない）
    g.draw(scene(3, { ctx, pos: (id) => ({ x: impactColX(24), y: 600 + Number(id.slice(1)) * 20 }), card: (id) => card(true, fr[Number(id.slice(1))]) }));
    expect(g.stubLabels).toBe(1);
    const texts = calls.filter((c) => c.op === "fillText").map((c) => String(c.args[0]));
    expect(texts).toContain("10億の 30%");
    expect(texts).not.toContain("10億の 2%");
  });

  describe("今日の手からゴールへの道しるべ（机のふだんの 20%・スマホのふだんの 44%）", () => {
    const tags: Array<[string, GoalMoveTag]> = [
      ["m0", { text: "芽 14%", share: 0.14 }],
      ["m1", { text: "芽: 選び方", share: 0 }],
      ["m2", { text: "芽 2%", share: 0.02 }],
    ];
    const withHost = (g: GoalRail, moves: ReadonlyMap<string, GoalMoveTag>) => {
      (g as unknown as { host: GoalRailHost }).host = { info: () => ({ key: "k", T: 100_000, by: 2056, byKari: false, mid: 4600, path: "pi", moves }), open() {} };
      return g;
    };
    const newRail = (moves: ReadonlyMap<string, GoalMoveTag> = new Map(tags)) =>
      withHost(
        new GoalRail(
          () => {},
          () => {},
        ),
        moves,
      );
    // 今日の手は入口の 1 つ右の列（行ごとに 400 下）。それぞれの最初の 3 か月後のカードが同じ行の次の列。ゴールの列は画面の右の外
    const z = 0.2;
    const rowY = (id: string) => Number(id.slice(1)) * 400;
    const pos = (id: string) => ({ x: impactColX(1), y: rowY(id) });
    /** 世界の座標のカード（列・行の y）を画面の箱にする */
    const boxesOf = (cards: Array<[number, number]>, zz: number, cx: number, cy: number): CardBoxes => {
      const b: CardBoxes = { buf: new Float64Array(4), n: 0 };
      for (const [x, y] of cards) pushCardBox(b, (x - NODE_W / 2) * zz + cx, (y - 48) * zz + cy, (x + NODE_W / 2) * zz + cx, (y + 48) * zz + cy);
      return b;
    };
    const rows = [0, 400, 800];
    const moveCards = rows.map((y) => [impactColX(1), y] as [number, number]);
    const childCards = rows.map((y) => [impactColX(2), y] as [number, number]);
    const base = (o: Partial<GoalScene> = {}, cards: Array<[number, number]> = [...moveCards, ...childCards]): GoalScene => {
      const zz = o.z ?? z;
      const cx = o.cx ?? 40;
      const cy = o.cy ?? 120;
      return scene(0, { z: zz, cx, cy, pos, shown: (id: string) => id.startsWith("m"), boxes: boxesOf(cards, zz, cx, cy), ...o });
    };
    const port = (impactColX(1) + NODE_W / 2) * z + 40;
    const childL = (impactColX(2) - NODE_W / 2) * z + 40;
    const childR = (impactColX(2) + NODE_W / 2) * z + 40;
    const segsAt = (calls: Call[], y: number) => {
      const out: Array<[number, number]> = [];
      for (let i = 0; i < calls.length - 1; i++) {
        const a = calls[i]!;
        const b = calls[i + 1]!;
        if (a.op === "moveTo" && b.op === "lineTo" && a.args[1] === y && b.args[1] === y && a.dash > 0) out.push([a.args[0] as number, b.args[0] as number]);
      }
      return out;
    };

    it("芽の札のある手ごとに、点から出る点線（同じ行のカードの所は空ける）と札 1 つ。金と灰の 2 本・点は 1 回の塗り", () => {
      const { ctx, calls } = recorder();
      const g = newRail();
      g.draw(base({ ctx, width: 390, height: 844 }));
      expect(GOAL_RAIL_DX * z + 40).toBeGreaterThan(390);
      expect(g.stubs).toBe(0);
      expect(g.leadRows).toBe(3);
      expect(g.leads).toBe(3);
      expect(g.leadLabels).toBe(3);
      // 点の塗りと縁 1 回ずつ + 金の点線 1 本 + 灰の点線 1 本
      expect(g.strokes).toBe(4);
      expect(calls.filter((c) => c.op === "fill").length).toBe(1);
      expect(calls.filter((c) => c.op === "arc").length).toBe(2);
      const texts = calls.filter((c) => c.op === "fillText").map((c) => String(c.args[0]));
      expect(texts).toEqual(["芽 14%", "芽: 選び方", "芽 2%", "→ ゴール 10 億円"]);
      // 線は点のすぐ右から次のカードの手前まで（点から出る: 見直し reader-3）と、そのカードの右の 12px 先から画面の右の端まで
      const y0 = 120;
      const s0 = segsAt(calls, y0);
      expect(s0.length).toBe(2);
      expect(s0[0]![0]).toBeCloseTo(port + 5, 6);
      expect(s0[0]![1]).toBeCloseTo(childL - 4, 6);
      expect(s0[1]![0]).toBeCloseTo(childR + 12, 6);
      expect(s0[1]![1]).toBe(390);
      // 札の右の端は端の札と同じ（画面の右から 12px）・線の高さ
      const lab = calls.find((c) => c.op === "fillText" && c.args[0] === "芽 14%")!;
      expect((lab.args[1] as number) + Array.from("芽 14%").length * 7).toBeCloseTo(390 - 12, 6);
      expect(lab.args[2]).toBeCloseTo(y0, 6);
      for (const t of texts) spaced(t.replace(/^→ /, ""));
    });

    it("1 つの手の枝が右の端まで開いていても、ほかの手の線と札は消えない。その手は点と薄い線だけ（見直し reader-1）", () => {
      const { ctx, calls } = recorder();
      const g = newRail();
      // m0 の行に 6・9・12 か月後…のカード（画面の右の端の手前まで）
      const branch = [3, 4, 5, 6, 7, 8, 9, 10].map((d) => [impactColX(d), 0] as [number, number]);
      g.draw(base({ ctx, width: 765, height: 900 }, [...moveCards, ...childCards, ...branch]));
      expect((impactColX(10) + NODE_W / 2) * z + 40).toBeGreaterThan(765 - 64 - 12);
      expect(g.leadRows).toBe(3);
      expect(g.leads).toBe(2);
      expect(g.leadLabels).toBe(2);
      const texts = calls.filter((c) => c.op === "fillText").map((c) => String(c.args[0]));
      expect(texts).toEqual(["芽: 選び方", "芽 2%", "→ ゴール 10 億円"]);
      // 札の付かない線は薄い色の 1 本（濃い線にはいつも札がある）
      expect(g.strokes).toBe(5);
      const strokes = calls.filter((c) => c.op === "stroke" && c.dash > 0).map((c) => c.stroke);
      expect(strokes).toContain("rgba(150,160,178,0.3)");
      // ほかの行の線の左の端は、その行のカードだけで決まる（開いた枝のある行が画面に出ても入っても動かない）
      const other = newRail();
      other.draw(base({ width: 765, height: 900 }));
      const t1 = g.leadTails().slice(1);
      const t2 = other.leadTails().slice(1);
      expect(t1).toEqual(t2);
      expect(t1[0]!.tail).toBeCloseTo(childR + 12, 6);
    });

    it("縦に動かしても、線の左の端は動かない（画面に出ているカードのいちばん右で決めない）", () => {
      const g = newRail();
      // 手の無い行（1200）に長い枝。上に動かすと画面の外へ出る
      const far = [3, 4, 5, 6].map((d) => [impactColX(d), 1200] as [number, number]);
      g.draw(base({ height: 900 }, [...moveCards, ...childCards, ...far]));
      const a = g.leadTails();
      // 1 行（400 × 0.2 = 80px）上へ: 1200 の行は画面の外（カードの箱にも入らない）
      g.draw(base({ height: 900, cy: 40 }, [...moveCards, ...childCards]));
      const b = g.leadTails();
      expect(a.map((r) => r.tail)).toEqual(b.map((r) => r.tail));
      expect(a.every((r) => r.label)).toBe(true);
    });

    it("詰まった行では札はゴールに近い手から置き、少し上下にずらす。置けない手の線は薄い色（見直し reader-2）", () => {
      // 行ごとに 65 × 0.2 = 13px（芽 1%・芽 6%・芽 1%）
      const dense = new Map<string, GoalMoveTag>([
        ["m0", { text: "芽 1%", share: 0.01 }],
        ["m1", { text: "芽 6%", share: 0.06 }],
        ["m2", { text: "芽 1%", share: 0.012 }],
      ]);
      const p13 = (id: string) => ({ x: impactColX(1), y: Number(id.slice(1)) * 65 });
      const r = recorder();
      const g = newRail(dense);
      g.draw(base({ ctx: r.ctx, pos: p13 }, []));
      expect(g.leadLabels).toBe(3);
      const ys = r.calls.filter((c) => c.op === "fillText" && String(c.args[0]).startsWith("芽")).map((c) => c.args[2] as number);
      for (let k = 1; k < ys.length; k++) expect(ys[k]! - ys[k - 1]!).toBeGreaterThanOrEqual(15);
      // 札はそれぞれの線から 6px まで
      for (const [k, y] of ys.entries()) expect(Math.abs(y - (k * 13 + 120))).toBeLessThanOrEqual(6);
      // 6px おきなら札は芽 6% の 1 つだけ（上から順なら芽 1% が残っていた）。ほかの 2 本は薄い線
      const r6 = recorder();
      const g6 = newRail(dense);
      g6.draw(base({ ctx: r6.ctx, pos: (id: string) => ({ x: impactColX(1), y: Number(id.slice(1)) * 30 }) }, []));
      expect(g6.leadLabels).toBe(1);
      expect(r6.calls.filter((c) => c.op === "fillText").map((c) => String(c.args[0]))[0]).toBe("芽 6%");
      const dashed = r6.calls.filter((c) => c.op === "stroke" && c.dash > 0).map((c) => c.stroke);
      expect(dashed).toEqual(["rgba(255,181,71,0.75)", "rgba(150,160,178,0.3)"]);
    });

    it("スマホのふだんの倍率（44%: compact）でも、行き先の線が無ければ道しるべを出す。机の compact は芽の札だけ（見直し reader-4）", () => {
      const zz = 0.44;
      // 手のカードの右の端が 305px（スマホのふだんの見え方）。3 か月後のカードはたたんである
      const cx = 305 - (impactColX(1) + NODE_W / 2) * zz;
      const { ctx, calls } = recorder();
      const phone = newRail();
      phone.draw(base({ ctx, z: zz, cx, width: 390, height: 844 }, moveCards));
      expect(phone.moveTags).toBeGreaterThanOrEqual(1);
      expect(phone.leadRows).toBe(3);
      expect(phone.leads).toBe(3);
      expect(phone.leadLabels).toBe(3);
      const texts = calls.filter((c) => c.op === "fillText").map((c) => String(c.args[0]));
      expect(texts).toContain("→ ゴール 10 億円");
      expect(phone.leadBus).toBe(false);
      // 札が目盛りの帯の右にあれば、線の右の端からその札まで縦に 1 本（金の線と同じ 1 回で描く）
      const r2 = recorder();
      const bus = newRail();
      bus.state = "right";
      bus.draw(base({ ctx: r2.ctx, z: zz, cx, width: 390, height: 844 }, moveCards));
      expect(bus.leadBus).toBe(true);
      expect(bus.strokes).toBe(4);
      const up = r2.calls.findIndex((c) => c.op === "lineTo" && c.args[0] === 385 && c.args[1] === 26);
      expect(up).toBeGreaterThan(0);
      expect(r2.calls[up - 1]!.args).toEqual([385, 800 * zz + 120]);
      // 3 か月後のカードが開いていて右の端まで来ていれば、点だけ（カードの間には線の確からしさの札と矢印があるので、線も札も置かない）
      const r3 = recorder();
      const open = newRail();
      open.draw(base({ ctx: r3.ctx, z: zz, cx, width: 390, height: 844 }));
      expect(open.leadRows).toBe(3);
      expect(open.leads).toBe(0);
      expect(open.leadLabels).toBe(0);
      expect(r3.calls.filter((c) => c.op === "lineTo" && c.dash > 0).length).toBe(0);
      expect(r3.calls.filter((c) => c.op === "arc").length).toBe(2);
      // 縮めたとき（low）は、同じ空きに札を置く（芽の札がカードの上に無い）
      const lowGap = newRail();
      // 3 か月後のカードの右の端が画面の右の端から 10px: 「芽 2%」（4 文字）は点と次のカードの間に入る
      const zl = 0.2;
      const lr = recorder();
      lowGap.draw(base({ ctx: lr.ctx, width: 390, height: 844, cx: 390 - (impactColX(2) + NODE_W / 2) * zl - 10 }));
      expect(lowGap.leads).toBe(0);
      expect(lowGap.leadLabels).toBe(1);
      const gl = lr.calls.find((c) => c.op === "fillText" && c.args[0] === "芽 2%")!;
      expect(gl.args[1]).toBeCloseTo((impactColX(1) + NODE_W / 2) * zl + 390 - (impactColX(2) + NODE_W / 2) * zl - 10 + 5, 6);
      // 机の compact
      const desk = newRail();
      desk.draw(base({ z: 0.4 }));
      expect(desk.leadRows).toBe(0);
      expect(desk.moveTags).toBeGreaterThan(0);
    });

    it("行き先の線があるとき・列が左の外のときは出さない。ゴールの列が画面の中なら列まで。キャンバスに出ていない手は出さない", () => {
      const { ctx, calls } = recorder();
      const g = newRail();
      const zz = 0.06;
      g.draw(base({ ctx, z: zz }));
      const rx = GOAL_RAIL_DX * zz + 40;
      expect(rx).toBeLessThan(1000);
      expect(impactColX(GOAL_RAIL_DEPTH)).toBe(GOAL_RAIL_DX);
      expect(g.leads).toBe(3);
      const ends = calls.filter((c) => c.op === "lineTo" && c.dash > 0 && c.args[0] !== Math.round(rx) + 0.5).map((c) => c.args[0] as number);
      expect(ends.filter((x) => Math.abs(x - rx) < 1e-6).length).toBe(3);
      expect(Math.max(...ends)).toBeLessThanOrEqual(rx + 1e-6);
      const withEnds = newRail();
      withEnds.draw({ ...scene(40, { z: 0.15, seedEvery: 1 }), shown: () => true });
      expect(withEnds.stubs).toBeGreaterThan(0);
      expect(withEnds.leadRows).toBe(0);
      const left = newRail();
      left.draw(base({ cx: -GOAL_RAIL_DX * z - 50 }));
      expect(left.leadRows).toBe(0);
      const hidden = newRail();
      hidden.draw(base({ shown: (id: string) => id === "m2" }));
      expect(hidden.leads).toBe(1);
      hidden.off();
      expect(hidden.leads).toBe(0);
      expect(hidden.leadRows).toBe(0);
    });
  });
});
