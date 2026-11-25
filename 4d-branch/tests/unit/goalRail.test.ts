// 地図のいちばん右の資産のゴール（src/canvas/goalRail.ts）の確かめ: ゴールのカード・札の文字、行き先からゴールへの線の数と描き方
// （まとめて描く・実線はゴールの何割かまで・縮めたら芽だけ 400 本まで・選んだ道の上は濃く・選んだ行き先に札）。
// 数はどれも丸めた仮の数（目標 10 億円・期限 2056 年・行き先の期限の資産 5,000 万円など）

import { describe, expect, it } from "vitest";
import { spacingIssues } from "../../scripts/impact/textChecks";
import { GOAL_RAIL_DEPTH, GOAL_RAIL_DX, GOAL_STUB_LABEL_CAP, GOAL_STUB_LOW_CAP, GoalRail, goalRailText, goalStubLabel, type GoalRailHost, type GoalScene } from "../../src/canvas/goalRail";
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
      ["m0", "芽 14%"],
      ["m1", "芽: 選び方"],
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

  describe("縮めたとき（机のふだんの 20%）の今日の手からゴールへの道しるべ", () => {
    const moves = new Map([
      ["m0", "芽 14%"],
      ["m1", "芽: 選び方"],
      ["m2", "芽 2%"],
    ]);
    const withHost = (g: GoalRail) => {
      (g as unknown as { host: GoalRailHost }).host = { info: () => ({ key: "k", T: 100_000, by: 2056, byKari: false, mid: 4600, path: "pi", moves }), open() {} };
      return g;
    };
    const newRail = () =>
      withHost(
        new GoalRail(
          () => {},
          () => {},
        ),
      );
    // 今日の手は入口の 1 つ右の列（行ごとに 400 下）。ゴールの列は画面の右の外（ふだんの 20% と同じ）
    const z = 0.2;
    const pos = (id: string) => ({ x: impactColX(1), y: Number(id.slice(1)) * 400 });
    const base = (o: Partial<GoalScene> = {}): GoalScene =>
      scene(0, { z, cx: 40, cy: 120, pos, shown: (id: string) => moves.has(id) || id === "m9", frontier: (impactColX(2) + NODE_W / 2) * z + 40, ...o });

    it("行き先の線が無いときは、芽の札のある手ごとに点線 1 本と札 1 つ（金と灰の 2 本・点は 1 回の塗り）。カードごとの文字は出さない", () => {
      const { ctx, calls } = recorder();
      const g = newRail();
      g.draw(base({ ctx, width: 390, height: 844 }));
      expect(GOAL_RAIL_DX * z + 40).toBeGreaterThan(390);
      expect(g.stubs).toBe(0);
      expect(g.leads).toBe(3);
      expect(g.leadLabels).toBe(3);
      // 点の塗りと縁 1 回ずつ + 金の点線 1 本 + 灰の点線 1 本
      expect(g.strokes).toBe(4);
      expect(calls.filter((c) => c.op === "fill").length).toBe(1);
      expect(calls.filter((c) => c.op === "arc").length).toBe(2);
      const texts = calls.filter((c) => c.op === "fillText").map((c) => String(c.args[0]));
      // 手ごとの札 3 つと、札の列の下に何へ向かう線か（スマホ: 端の札は目盛りの帯の中）
      expect(texts).toEqual(["芽 14%", "芽: 選び方", "芽 2%", "→ ゴール 10 億円"]);
      // 線は出ているカードの右の先（frontier）から 12px 右・画面の右の端まで、手の高さで
      const lines = calls.filter((c) => c.op === "lineTo");
      expect(lines.length).toBe(3);
      for (const l of lines) expect(l.args[0]).toBe(390);
      const starts = calls.filter((c) => c.op === "moveTo" && calls.indexOf(c) > calls.findIndex((x) => x.op === "setLineDash" || x.dash > 0));
      expect(starts.some((c) => Math.abs((c.args[0] as number) - ((impactColX(2) + NODE_W / 2) * z + 40 + 12)) < 1e-6)).toBe(true);
      // 札の右の端は端の札と同じ（画面の右から 12px）
      const lab = calls.find((c) => c.op === "fillText" && c.args[0] === "芽 14%")!;
      expect((lab.args[1] as number) + Array.from("芽 14%").length * 7).toBeCloseTo(390 - 12, 6);
      expect(lab.args[2]).toBeCloseTo(120, 6);
      for (const t of texts) spaced(t.replace(/^→ /, ""));
    });

    it("ゴールの列が画面の中なら列まで。行き先の線があるとき・近いとき・列が左の外のときは出さない", () => {
      const { ctx, calls } = recorder();
      const g = newRail();
      // 列が画面の中（入口から列まで 26 列 × 0.06）
      const zz = 0.06;
      const posz = (id: string) => ({ x: impactColX(1), y: Number(id.slice(1)) * 400 });
      g.draw(base({ ctx, z: zz, pos: posz, frontier: (impactColX(2) + NODE_W / 2) * zz + 40 }));
      const rx = GOAL_RAIL_DX * zz + 40;
      expect(rx).toBeLessThan(1000);
      expect(impactColX(GOAL_RAIL_DEPTH)).toBe(GOAL_RAIL_DX);
      expect(g.leads).toBe(3);
      for (const l of calls.filter((c) => c.op === "lineTo").slice(1)) expect(l.args[0]).toBeCloseTo(rx, 6);
      // 行き先の線がある（3 年後まで開いている）: 道しるべは出さない
      const withEnds = newRail();
      withEnds.draw({ ...scene(40, { z: 0.15, seedEvery: 1 }), shown: () => true, frontier: 0 });
      expect(withEnds.stubs).toBeGreaterThan(0);
      expect(withEnds.leads).toBe(0);
      // 近いとき（compact）は手の札（芽 14%）で足りる
      const near = newRail();
      near.draw(base({ z: 0.4 }));
      expect(near.leads).toBe(0);
      expect(near.moveTags).toBeGreaterThan(0);
      // 列が左の外
      const left = newRail();
      left.draw(base({ cx: -GOAL_RAIL_DX * z - 50 }));
      expect(left.leads).toBe(0);
    });

    it("出ているカードが右の端まで来ていれば線と札は出さない（点だけ）。行が詰まれば札は 15px おき・キャンバスに出ていない手は出さない", () => {
      const g = newRail();
      g.draw(base({ frontier: 1000 - 30 }));
      expect(g.leads).toBe(0);
      expect(g.leadLabels).toBe(0);
      expect(g.strokes).toBe(2);
      const dense = newRail();
      const r = recorder();
      // 行ごとに 50 × 0.2 = 10px
      dense.draw(base({ ctx: r.ctx, pos: (id: string) => ({ x: impactColX(1), y: Number(id.slice(1)) * 50 }) }));
      expect(dense.leads).toBe(3);
      expect(dense.leadLabels).toBe(2);
      const ys = r.calls.filter((c) => c.op === "fillText" && String(c.args[0]).startsWith("芽")).map((c) => c.args[2] as number);
      for (let k = 1; k < ys.length; k++) expect(ys[k]! - ys[k - 1]!).toBeGreaterThanOrEqual(15);
      const hidden = newRail();
      hidden.draw(base({ shown: (id: string) => id === "m2" }));
      expect(hidden.leads).toBe(1);
      hidden.off();
      expect(hidden.leads).toBe(0);
    });
  });
});
