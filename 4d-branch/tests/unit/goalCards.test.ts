// 資産のゴールをアプリの計算（ImpactResult）から出す所の確かめ: キャンバスの行き先のカードの札・芽の印（src/canvas/impactCards.ts・
// impactDraw.ts）、詳細の欄の 1 文、版 6 の地図の見出しの帯（src/model/goalImpact.ts）。
// 確かめること: 札は行き先だけ・地図の計算と同じ数・前提を変えると作り直す・芽の印は芽の行き先だけ・版 6 は今月から数える・
// 36 か月目より先の数は「目安」か「前提」と並ぶ・「0%」の見込みを出さない・地図のほかの文と同じ言葉の間。数はどれも丸めた仮の数

import { describe, expect, it } from "vitest";
import { spacingIssues } from "../../scripts/impact/textChecks";
import { ImpactCards, type ImpactCard } from "../../src/canvas/impactCards";
import { drawImpactNode } from "../../src/canvas/impactDraw";
import { analyze, compileMap, goalInputAt, goalLeafAt } from "../../src/deepmap/core";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";
import { goalStripVM, type GoalStripVM } from "../../src/deepmap/views";
import { buildImpactDoc, impactNodeId } from "../../src/demo/impact";
import { spaceJa } from "../../src/demo/compose/text";
import { NODE_H, NODE_W } from "../../src/model/constants";
import { computeForecast } from "../../src/model/forecast";
import { formatOku, goalAnchor, goalAnchorOfRoot, goalBadge, goalBand, goalConfigOf, goalInputOfImpact, goalLeaf, goalLeafLine, SEED_BIZ, tablesFor, type GoalStored } from "../../src/model/goal";
import { goalCardOf, goalCtxOf, goalFactOf, goalImpactStrip, goalImpactStripInput } from "../../src/model/goalImpact";
import { buildIndex } from "../../src/model/graph";
import { computeImpact, type ImpactResult } from "../../src/model/impact";
import { makeNode } from "../../src/model/schema";
import type { DocData } from "../../src/model/types";
import { randomTree, toBundle } from "./deepmapFixtures";
import { r6Bundle } from "./helpers/r6";

const CLOCK = (): Date => new Date(2026, 10, 1);

function spaced(s: string): void {
  expect(spaceJa(s), s).toBe(s);
  expect(spacingIssues(s), s).toEqual([]);
}

function impactOf(doc: DocData): ImpactResult {
  const idx = buildIndex(doc);
  return computeImpact(doc, idx.out, computeForecast(doc, idx.out, null), null);
}

/** 3 か月ごとの地図の形（入口に年月）の小さな地図と、同じ地図の計算 */
function quarterly(goal: GoalStored | null = null) {
  const map = fromDevTree(randomTree(9, 900));
  const cm = compileMap(map);
  const a = analyze(cm, 360);
  const b = toBundle(map);
  const doc = buildImpactDoc(b, new Date(2026, 10, 19), "test");
  const rootId = impactNodeId(b.nodes[0]![0]);
  const root = doc.nodes[rootId]!;
  root.meta = { ...root.meta, anchor: "2026-11", impact: { v: 2, horizon: 36, annual: 360, tail: 0 }, ...(goal ? { goal } : {}) };
  for (const n of Object.values(doc.nodes)) n.status = "open";
  return { map, cm, a, doc, rootId, imp: impactOf(doc) };
}

function withGoal(doc: DocData, rootId: string, goal: GoalStored): DocData {
  const next = structuredClone(doc);
  next.nodes[rootId]!.meta = { ...next.nodes[rootId]!.meta, goal };
  return next;
}

describe("キャンバスの行き先のカードの札（card.goal）", () => {
  it("行き先のカードだけに札があり、地図の計算と同じ数（札の文・芽・ゴールの何割か）。芽の行き先は一番小さくしたときの目印にも「芽」", () => {
    const { map, cm, a, doc, imp } = quarterly();
    const cards = new ImpactCards(CLOCK);
    const t = tablesFor(goalConfigOf(null).cfg, goalAnchor("2026-11"));
    let ends = 0;
    let seeds = 0;
    for (let i = 0; i < cm.n; i++) {
      if (!a.pi.def[i]) continue;
      const id = impactNodeId(map.key(i));
      const c = cards.card(imp, doc, id);
      if (!c) continue;
      if (c.role !== "end") {
        expect(c.goal, id).toBeNull();
        continue;
      }
      ends++;
      const leaf = goalLeafAt(a, i, t)!;
      expect(c.goal).not.toBeNull();
      expect(c.goal!.text).toBe(goalBadge(t, leaf));
      expect(c.goal!.seed).toBe(leaf.seed);
      expect(c.goal!.frac).toBeCloseTo(leaf.frac, 9);
      expect(c.goal!.seed).toBe(goalInputAt(a, i)!.Rbiz >= SEED_BIZ);
      expect(c.dotLabel.endsWith(" · 芽")).toBe(c.goal!.seed);
      if (c.goal!.seed) seeds++;
      spaced(c.goal!.text);
    }
    expect(ends).toBeGreaterThan(50);
    expect(seeds).toBeLessThan(ends);
  });

  it("前提（入口の meta.goal）を変えると札を作り直す（目標・届く年）。計算の結果は同じでも文書が変われば作り直す", () => {
    const { doc, rootId, imp } = quarterly();
    const cards = new ImpactCards(CLOCK);
    const leaf = imp.ends[0]!.id;
    const before = cards.card(imp, doc, leaf)!.goal!;
    expect(before.text).toMatch(/^10 億: /);
    expect(before.reached).toBe(false);
    // 目標を 3 億円に
    const d3 = withGoal(doc, rootId, { v: 1, target: 30_000 });
    expect(cards.card(imp, d3, leaf)!.goal!.text).toMatch(/^3 億: /);
    // 今の資産が目標より多い: 届く年（もう届いている: 0 か月目の年）。36 か月目より先の数なので「・目安」
    const rich = withGoal(doc, rootId, { v: 1, assets: 200_000 });
    const g = cards.card(imp, rich, leaf)!.goal!;
    expect(g.reached).toBe(true);
    expect(g.frac).toBe(1);
    expect(g.text).toBe("10 億: 2026 年・目安");
    // 元の文書に戻すと元の札
    expect(cards.card(imp, doc, leaf)!.goal!.text).toBe(before.text);
  });

  it("文書をその場で書き換えても（ストアは同じ文書の入口のカードを差し替える）、前提が変われば行き先の札を作り直す。ほかのカードはそのまま", () => {
    const { doc, rootId, imp } = quarterly();
    const cards = new ImpactCards(CLOCK);
    const leaf = imp.ends[0]!.id;
    const mid = [...imp.kind].find(([id, k]) => k !== "leaf" && id !== imp.root)![0];
    const before = cards.card(imp, doc, leaf)!.goal!;
    const midCard = cards.card(imp, doc, mid);
    const root = doc.nodes[rootId]!;
    doc.nodes[rootId] = { ...root, meta: { ...root.meta, goal: { v: 1, assets: 500, save: 30 } } };
    const after = cards.card(imp, doc, leaf)!.goal!;
    expect(after.atBy).toBeGreaterThan(before.atBy);
    expect(cards.card(imp, doc, mid)).toBe(midCard);
    // 元に戻す（前の入口のカード）: 元の数
    doc.nodes[rootId] = root;
    expect(cards.card(imp, doc, leaf)!.goal!.atBy).toBeCloseTo(before.atBy, 9);
    expect(cards.goal(imp, doc)!.cfg.assets).toBe(0);
  });
});

describe("詳細の欄の「10 億」の 1 文（goalFactOf）", () => {
  it("行き先は道の終わりと同じ文、途中のカードはこの後の平均（どちらも目安・言葉の間）", () => {
    const { doc, imp } = quarterly();
    const g = goalCtxOf(doc, imp, CLOCK)!;
    // 同じ年月を今月から数えた表（版 6）を先に作っていても、地図の年月の表は別（地図が数える範囲の文が違う）
    expect(g.t.anchor.clock).toBe(false);
    expect(g.t.by).toBe(2056);
    const leaf = imp.ends[0]!.id;
    const x = goalInputOfImpact(imp, leaf, doc.nodes[leaf]!.meta?.rr)!;
    const fact = goalFactOf(g.t, imp, doc, leaf)!;
    expect(fact).toBe(goalLeafLine(g.t, x, goalLeaf(g.t, x), goalBand(g.t, x)));
    expect(fact).toMatch(/目安/);
    spaced(fact);
    const mid = [...imp.kind].find(([id, k]) => k !== "leaf" && id !== imp.root && imp.rate.has(id))![0];
    const m = goalFactOf(g.t, imp, doc, mid)!;
    expect(m).toMatch(/^この後一番良く選ぶと（運は平均）、2056 年の資産は約 [\d.]+ 億円（ゴールの (\d+%|1% 未満)・目安）。$/);
    spaced(m);
    expect(goalCardOf(g.t, imp, doc, mid)).toBeNull();
  });

  it("途中のカードにも事業の伸びの前提が効く: 子が行き先 1 つだけのカードは、その行き先と同じ期限の資産", () => {
    // 給与 30・事業 10（月の稼ぎ）・事業が年 20% 伸びる前提
    const { doc, rootId } = quarterly({ v: 1, bizGrow: 20 });
    const imp = impactOf(doc);
    const g = goalCtxOf(doc, imp, CLOCK)!;
    expect(g.t.cfg.bizGrow).toBe(20);
    // 行き先 1 つだけを子に持つ途中のカード（結果・手）を探す
    const out = buildIndex(doc).out;
    let checked = 0;
    let biz = 0;
    for (const [id, k] of imp.kind) {
      if (k === "leaf" || id === rootId || !imp.rate.has(id)) continue;
      const kids = out.get(id) ?? [];
      if (kids.length !== 1) continue;
      const e = doc.edges[kids[0]!];
      const leaf = e?.target;
      if (!leaf || imp.kind.get(leaf) !== "leaf") continue;
      const xm = goalInputOfImpact(imp, id, doc.nodes[id]!.meta?.rr)!;
      const xl = goalInputOfImpact(imp, leaf, doc.nodes[leaf]!.meta?.rr)!;
      expect(xm.split).toBe(false);
      expect(xm.Rbiz).toBeCloseTo(xl.Rbiz, 9);
      expect(xm.Rsal).toBeCloseTo(xl.Rsal, 9);
      // 行き先の 1 文と途中のカードの 1 文で、期限の資産が同じ（事業の伸びを途中のカードでも数える）
      const atLeaf = formatOku(goalLeaf(g.t, xl).atBy, true);
      const atMid = /資産は約 (.+?)（/.exec(goalFactOf(g.t, imp, doc, id)!)![1];
      expect(atMid).toBe(atLeaf);
      if (xl.Rbiz > 1) biz++;
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    expect(biz).toBeGreaterThan(0);
  });

  it("途中のカードは、給与 30・事業 10 の行き先と同じ数（事業の伸び 20%: 事業を給与に入れると約 5 分の 1 になっていた）", () => {
    const t = tablesFor(goalConfigOf({ meta: { goal: { v: 1, bizGrow: 20 } } }).cfg, goalAnchor("2026-01"));
    const leafX = { T3: 1200, Rsal: 30, Rbiz: 10, split: true };
    const midX = { T3: 1200, Rsal: 30, Rbiz: 10, split: false };
    const lumped = { T3: 1200, Rsal: 40, Rbiz: 0, split: false };
    expect(goalLeaf(t, midX).atBy).toBeCloseTo(goalLeaf(t, leafX).atBy, 9);
    expect(goalLeaf(t, leafX).atBy / goalLeaf(t, lumped).atBy).toBeGreaterThan(4);
  });
});

describe("版 6 の地図（年月が無い）", () => {
  const doc = buildImpactDoc(r6Bundle(), new Date(2026, 10, 19), "test");
  const imp = impactOf(doc);
  const g = goalCtxOf(doc, imp, CLOCK)!;
  const strip = (): GoalStripVM => goalStripVM(goalImpactStripInput(imp, doc, g, "k")!);

  it("0 か月目は入口の期限（地図を作った月: 見出しの「… → …」と同じ）。2026 年 11 月 → 2056 年", () => {
    expect(typeof doc.nodes[imp.root!]!.meta.anchor).not.toBe("string");
    expect(doc.nodes[imp.root!]!.time.due).toMatch(/^2026-11-/);
    expect(g.t.anchor).toEqual({ y: 2026, mo: 11, clock: false });
    expect(g.t.by).toBe(2056);
    expect(strip().frame).toContain("地図が数えるのは 2029 年 11 月までの額面の稼ぎです");
    expect(strip().frame).not.toContain("今月から数えて");
  });

  it("作った月より後に見ても、数えるのは作った月から（今月の時計では数えない）", () => {
    const old = buildImpactDoc(r6Bundle(), new Date(2025, 5, 15), "test");
    const oi = impactOf(old);
    expect(old.nodes[oi.root!]!.time.due).toBe("2025-06-15");
    const go = goalCtxOf(old, oi, CLOCK)!;
    expect(go.t.anchor).toEqual({ y: 2025, mo: 6, clock: false });
    expect(go.t.by).toBe(2055);
    expect(go.read.cfg.by).toBeNull();
    // 入口に期限も年月も無ければ、今月から数える
    expect(goalAnchorOfRoot({ meta: {}, time: { due: null } }, CLOCK)).toEqual({ y: 2026, mo: 11, clock: true });
    expect(goalAnchorOfRoot({ meta: { anchor: "2024-03" }, time: { due: "2025-06-15" } }, CLOCK)).toEqual({ y: 2024, mo: 3, clock: false });
  });

  it("見出しの帯は、同じ計算の結果・同じ前提なら作り直さない（見出しを描き直すたびに行き先をなめない）", () => {
    let calls = 0;
    const toVM = (x: Parameters<typeof goalStripVM>[0]): GoalStripVM => (calls++, goalStripVM(x));
    const a1 = goalImpactStrip(imp, doc, g, "k-memo", toVM);
    const a2 = goalImpactStrip(imp, doc, g, "k-memo", toVM);
    expect(a1).not.toBeNull();
    expect(a2).toBe(a1);
    expect(calls).toBe(1);
    // 鍵（前提）が変われば作り直す
    const d2 = structuredClone(doc);
    d2.nodes[imp.root!]!.meta = { ...d2.nodes[imp.root!]!.meta, goal: { v: 1, assets: 1_000 } };
    const a3 = goalImpactStrip(imp, d2, goalCtxOf(d2, imp, CLOCK)!, "k-memo2", toVM);
    expect(calls).toBe(2);
    expect(a3).not.toBe(a1);
    // 別の計算の結果なら作り直す
    goalImpactStrip(impactOf(doc), doc, g, "k-memo", toVM);
    expect(calls).toBe(3);
  });

  it("行き先のカードに札（芽は給与の外の稼ぎの内訳から）。途中のカードには無い", () => {
    const cards = new ImpactCards(CLOCK);
    let ends = 0;
    let seeds = 0;
    for (const [id, kind] of imp.kind) {
      const c = cards.card(imp, doc, id);
      if (!c) continue;
      if (kind !== "leaf") expect(c.goal).toBeNull();
      else if (c.goal) {
        ends++;
        expect(c.goal.text).toMatch(/^10 億: /);
        expect(c.dotLabel.endsWith(" · 芽")).toBe(c.goal.seed);
        if (c.goal.seed) seeds++;
        spaced(c.goal.text);
      }
    }
    expect(ends).toBeGreaterThan(20);
    expect(seeds).toBeGreaterThan(0);
    expect(seeds).toBeLessThan(ends);
  });

  it("見出しの帯: 棒・3 つの数・前提は目安か前提と並び、仮の値で「0%」を出さない。言葉の間は地図のほかの文と同じ", () => {
    const s = strip();
    expect(s.barText).toMatch(/^2056 年に約 [\d.]+ (億|万)円（(\d+%|1% 未満)）・目安$/);
    expect(s.bar).not.toBeNull();
    expect(s.tiles).toHaveLength(3);
    for (const t of s.tiles) {
      expect(`${t.label}${t.value}${t.sub}`, t.value).toMatch(/目安|前提/);
      expect(t.value).not.toMatch(/^0%$/);
    }
    expect(s.premise).toMatch(/^前提: 今の資産 0 万円（仮）/);
    expect(s.nudge).not.toBeNull();
    expect(s.levers.length).toBeGreaterThan(0);
    for (const x of [s.head, s.barText, s.aria, ...s.tiles.flatMap((t) => [t.label, t.value, t.sub]), s.leversHead!, ...s.levers, s.frame, s.premise, ...s.notes]) spaced(x);
    expect([s.barText, s.aria, ...s.tiles.map((t) => t.value), ...s.notes].join("\n")).not.toMatch(/見込み 0%/);
  });

  it("前提を変えると帯の数も変わる（今の資産を入れると（仮）が消え、期限の資産が増える）", () => {
    const d2 = structuredClone(doc);
    d2.nodes[imp.root!]!.meta = { ...d2.nodes[imp.root!]!.meta, goal: { v: 1, assets: 1_000 } };
    const g2 = goalCtxOf(d2, imp, CLOCK)!;
    const s2 = goalStripVM(goalImpactStripInput(imp, d2, g2, "k2")!);
    expect(s2.premise).toMatch(/^前提: 今の資産 1,000 万円・/);
    expect(s2.nudge).toBeNull();
    expect(s2.bar!.mid).toBeGreaterThan(strip().bar!.mid);
  });
});

// ---------------------------------------------------------------- 描き方（記録するだけの描く物）

interface Call {
  op: string;
  args: unknown[];
  fill: string;
  stroke: string;
}

/** 描いた物を記録する描く物（文字の幅は、漢字・かなが 1 字分・空白と「·」は 0.3 字分・ほかは 0.55 字分） */
function recorder(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const state: Record<string, unknown> = { font: "10px sans-serif", fillStyle: "", strokeStyle: "", lineWidth: 1 };
  const px = (): number => Number(/([\d.]+)px/.exec(String(state.font))?.[1] ?? 10);
  const ctx = new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key];
      if (key === "measureText") return (t: string) => ({ width: Array.from(t).reduce((w, ch) => w + (/[\u3000-\u9fff]/.test(ch) ? 1 : ch === " " || ch === "·" ? 0.3 : 0.55), 0) * px() });
      if (key === "createLinearGradient") return () => ({ addColorStop() {} });
      return (...args: unknown[]) => void calls.push({ op: key, args, fill: String(target.fillStyle), stroke: String(target.strokeStyle) });
    },
    set(target, key: string, v) {
      target[key] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const GOLD = "rgba(255,181,71,";

function endCard(seed: boolean, text = "10 億: 事業が年 +28%"): ImpactCard {
  return {
    role: "end",
    bin: 1,
    pill: null,
    chip: "35%",
    marks: "",
    head: "2029 年 11 月",
    headColor: null,
    bottom: "3年 +210万 · 月 42万",
    bottomShort: "3年 +210万",
    risk: [],
    short: "行き先",
    low: "35%",
    base: false,
    dropped: false,
    label: "3年 +210万",
    labelTitle: "3年 +210万",
    dotLabel: "3年後 月 42万",
    heat: null,
    heatLow: "",
    goal: { text, seed, frac: 0.05, reached: false, atBy: 5000 },
  };
}

function draw(lod: "full" | "compact" | "low" | "dot", c: ImpactCard, zoom = lod === "full" ? 1 : lod === "compact" ? 0.5 : lod === "low" ? 0.2 : 0.05) {
  const { ctx, calls } = recorder();
  const n = makeNode({ id: "e", type: "result", title: "行き先" });
  drawImpactNode(ctx, n, 0, 0, { lod, zoom, alpha: 1, selected: false, hovered: false, match: false, ghost: false, offScenario: false, dropTarget: false, editing: false, projectColors: [], collapsedCount: 0, collapsed: false, showBadge: false, today: "2026-11-24" }, c);
  return calls;
}

describe("行き先のカードの描き方（impactDraw）", () => {
  it("full: 下の行の後ろに札（3 年後の月の稼ぎを落としてでも入れる）。芽は金色の文字、そうでなければ灰色", () => {
    const calls = draw("full", endCard(true));
    const texts = calls.filter((c) => c.op === "fillText").map((c) => c.args[0]);
    expect(texts).toContain("3年 +210万");
    expect(texts).not.toContain("3年 +210万 · 月 42万");
    const g = calls.find((c) => c.op === "fillText" && c.args[0] === "10 億: 事業が年 +28%")!;
    expect(g.fill.startsWith(GOLD)).toBe(true);
    const plain = draw("full", endCard(false)).find((c) => c.op === "fillText" && c.args[0] === "10 億: 事業が年 +28%")!;
    expect(plain.fill.startsWith(GOLD)).toBe(false);
  });

  it("full: 短い形でも入らない札は出さない（下の行はそのまま）", () => {
    const calls = draw("full", endCard(false, "10 億: 給与だけでは届かない、とても長い札の文"));
    const texts = calls.filter((c) => c.op === "fillText").map((c) => String(c.args[0]));
    expect(texts.some((t) => t.includes("給与だけ"))).toBe(false);
    expect(texts.some((t) => t.startsWith("3年 +210万"))).toBe(true);
  });

  it("compact: 芽の行き先は右の縁に金色の切り欠き（画面で 4px）。芽でなければ無い", () => {
    const s = 1 / 0.5;
    const notch = draw("compact", endCard(true)).filter((c) => c.op === "fillRect" && c.fill.startsWith(GOLD));
    expect(notch).toHaveLength(1);
    expect(notch[0]!.args).toEqual([NODE_W / 2 - 4 * s, -NODE_H / 2 + NODE_H * 0.3, 4 * s, NODE_H * 0.4]);
    expect(draw("compact", endCard(false)).some((c) => c.fill.startsWith(GOLD) && c.op === "fillRect")).toBe(false);
  });

  it("low・dot: 芽の行き先は金色の細い縁取り（画面で 1.5px）。芽でなければ無い", () => {
    for (const lod of ["low", "dot"] as const) {
      const calls = draw(lod, endCard(true));
      const ring = calls.filter((c) => (c.op === "stroke" || c.op === "strokeRect") && c.stroke.startsWith(GOLD));
      expect(ring.length, lod).toBe(1);
      expect(draw(lod, endCard(false)).some((c) => (c.op === "stroke" || c.op === "strokeRect") && c.stroke.startsWith(GOLD)), lod).toBe(false);
    }
  });
});
