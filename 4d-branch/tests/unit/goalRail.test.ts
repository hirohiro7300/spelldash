// 地図のいちばん右の資産のゴール（src/canvas/goalRail.ts）の確かめ: ゴールのカード・札の文字、行き先からゴールへの線の数と描き方
// （まとめて描く・実線はゴールの何割かまで・縮めたら芽だけ 400 本まで・選んだ道の上は濃く・選んだ行き先に札）。
// 数はどれも丸めた仮の数（目標 10 億円・期限 2056 年・行き先の期限の資産 5,000 万円など）

import { describe, expect, it } from "vitest";
import { spacingIssues } from "../../scripts/impact/textChecks";
import { GOAL_RAIL_DX, GOAL_STUB_LOW_CAP, GoalRail, goalRailText, goalStubLabel, type GoalScene } from "../../src/canvas/goalRail";
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
  it("カード: ゴール・資産 10 億円・期限（仮）・今の道の期限の資産（何割・目安）。札は机とスマホで短さが違う。どれも言葉の間がそろう", () => {
    const x = goalRailText({ key: "k", T: 100_000, by: 2056, byKari: true, mid: 4600 });
    expect(x.name).toBe("資産 10 億円");
    expect(x.by).toBe("2056 年まで（仮）");
    expect(x.now).toBe("今の道 0.46 億（5%）目安");
    expect(x.chipWide).toBe("→ ゴール 10 億円 5%");
    expect(x.chipNarrow).toBe("10億 5% ›");
    expect(x.aria).toContain("目安");
    // 札（「→ ゴール 10 億円 5%」「10億 5% ›」: 設計どおりの詰めた形）のほかは、地図の文と同じ言葉の間
    for (const s of [x.name, x.by, x.now!, x.aria, x.chipAria]) spaced(s);
  });

  it("0% は出さない（期限の資産が 0）。目標を変えればその目標（3 億円）。1 億より下の目標は万円", () => {
    const zero = goalRailText({ key: "k", T: 100_000, by: 2056, byKari: false, mid: 0 });
    expect(zero.chipWide).toBe("→ ゴール 10 億円");
    expect(zero.chipNarrow).toBe("10億 ›");
    expect(zero.now).toBe("今の道 0 万円・目安");
    expect(goalRailText({ key: "k", T: 30_000, by: 2050, byKari: false, mid: 3000 }).chipWide).toBe("→ ゴール 3 億円 10%");
    expect(goalRailText({ key: "k", T: 5000, by: 2050, byKari: false, mid: 500 }).chipNarrow).toBe("5,000万 10% ›");
    expect(goalRailText({ key: "k", T: 100_000, by: 2056, byKari: false, mid: null }).now).toBeNull();
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
    const text = calls.find((c) => c.op === "fillText")!;
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
});
