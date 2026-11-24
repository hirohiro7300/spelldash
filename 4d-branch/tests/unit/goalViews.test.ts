// 資産のゴールを画面に出す形（src/deepmap/views/goal.ts と、見取り図・手の詳しい画面・道の終わりへのつなぎ）の確かめ（DOM を使わない）
// 確かめること: 36 か月目より先の数はどれも「目安」か「前提」と並ぶ・入れていない前提に（仮）・仮の値で「0%」を出さない・
// 「10 の手をひと目で」は 10 行のまま同じ行き先・芽の札・数の出どころ（渡した物・計算ごとの出どころ・作っていなければ出さない）・
// 地図のほかの文と同じ言葉の間。数はどれも丸めた仮の数

import { describe, expect, it } from "vitest";
import { spacingIssues } from "../../scripts/impact/textChecks";
import { analyze, compileMap, fallbackText, goalBase, goalOf, goalViewOf, kindKey, setGoalSource, type Analysis, type GoalView } from "../../src/deepmap/core";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";
import type { DevTree, DevTreeNode } from "../../src/deepmap/mapData";
import { goalEndText, goalMoveVM, goalOverviewVM, goalViewKey, moveDetailVM, okuRange, overviewVM, parseRoute, pathVM, type GoalOverviewVM } from "../../src/deepmap/views";
import { spaceJa } from "../../src/demo/compose/text";
import { DEFAULT_GOAL, goalAnchor, goalConfigOf, tablesFor, type GoalStored } from "../../src/model/goal";
import { handTree, header, randomTree, st } from "./deepmapFixtures";

const ANCHOR = goalAnchor("2026-11");

/** 文書の入口の meta.goal から、画面が読む数（アプリの ctx.goal() と同じ作り方） */
function viewOf(a: Analysis, goal: GoalStored | null = null): GoalView {
  const read = goalConfigOf(goal ? { meta: { goal } } : null);
  const base = goalBase(a);
  return { read, base, summary: goalOf(base, tablesFor(read.cfg, ANCHOR)) };
}

const handA = (annual = 360): Analysis => analyze(compileMap(fromDevTree(handTree())), annual);

/** 帯・注・今日の欄の文を全部 */
function texts(vm: GoalOverviewVM): string[] {
  const s = vm.strip;
  return [s.head, s.barText, s.aria, s.done, ...s.tiles.flatMap((t) => [t.label, t.value, t.sub]), s.leversHead, ...s.levers, s.frame, s.premise, s.basis, ...s.notes, s.nudge, vm.seedNote, vm.today, ...vm.seeds.flatMap((x) => [x.text, x.aria])].filter(
    (x): x is string => typeof x === "string",
  );
}

/** 地図のほかの文と同じ言葉の間か */
function spaced(s: string): void {
  expect(spaceJa(s), s).toBe(s);
  expect(spacingIssues(s), s).toEqual([]);
}

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
              { k: "r.iq.s.back", r: "a", m: 3, st: st(), kind: "fc_switch", h: 0, kids: [end("r.iq.s.back.x", 100, [36, 0, 0], [1.2, 2, 0])] },
              { k: "r.iq.s.stay", r: "a", m: 3, st: st(), kind: "ind_quit", h: 0, kids: [end("r.iq.s.stay.x", 100, [0, 400, 0], [0, 25, 0])] },
            ],
          },
        ],
      },
    ],
  };
  return { header: header(), root };
}

describe("見取り図の帯（仮の前提）", () => {
  const a = handA();
  const vm = goalOverviewVM(a, viewOf(a));
  const s = vm.strip;

  it("見出し・棒・棒の横の数は、期限の年と目安つき（ゴールは 10 億円・期限は 0 か月目の年 + 30）", () => {
    expect(s.head).toBe("資産 10 億円・2056 年まで");
    expect(s.barText).toMatch(/^2056 年に約 [\d.]+ (億|万)円（(\d+%|1% 未満)）・目安$/);
    expect(s.bar).not.toBeNull();
    expect(s.bar!.lo).toBeLessThanOrEqual(s.bar!.mid);
    expect(s.bar!.mid).toBeLessThanOrEqual(s.bar!.hi);
    expect(s.bar!.hi).toBeLessThanOrEqual(1);
    expect(s.aria).toContain("ゴールは資産 10 億円、2056 年まで");
    expect(s.aria).toContain("10〜90% で");
    expect(s.aria).toContain("地図が数えるのは 2029 年 11 月までの額面の稼ぎです");
  });

  it("仮の値ではどこにも届かないので、3 つの数に「0%」を出さない（届く年か、80 年後の資産を出す）", () => {
    expect(s.done).toBeNull();
    expect(s.tiles).toHaveLength(3);
    for (const t of s.tiles) {
      expect(t.value).not.toMatch(/(^|\D)0%/);
      expect(`${t.label}${t.value}${t.sub}`).not.toContain("見込み 0%");
    }
    expect(s.tiles[0]!.label).toBe("今の前提で届く年");
    expect(s.tiles[1]!.label).toBe("届くには毎月の積立");
    expect(s.tiles[1]!.value).toMatch(/^[\d,.]+ 万円$/);
    for (const x of texts(vm)) expect(x).not.toMatch(/見込み 0%/);
  });

  it("36 か月目より先の数はどれも「目安」か「前提」と並ぶ（3 つの数・手立て・地図が数える範囲・前提の行）", () => {
    for (const t of s.tiles) expect(`${t.label}${t.value}${t.sub}`, t.value).toMatch(/目安|前提/);
    expect(s.leversHead).toMatch(/目安/);
    expect(s.levers.length).toBeGreaterThan(0);
    expect(s.frame).toMatch(/目安/);
    expect(s.premise.startsWith("前提: ")).toBe(true);
    expect(s.barText).toMatch(/目安/);
    expect(vm.today).toMatch(/目安/);
    expect(vm.seedNote).toMatch(/目安/);
  });

  it("入れていない前提には（仮）。今の資産を入れていなければ「入れると、この数字があなたのものになります」", () => {
    expect(s.premise).toContain("今の資産 0 万円（仮）");
    expect(s.premise).toContain("額面の 20% を積立（仮）");
    expect(s.premise).toContain("期限は 2056 年（仮）");
    expect(s.premise).toContain("税は引いていません");
    expect(s.nudge).toBe("今の資産を入れると、この数字があなたのものになります");
  });

  it("どの文も、地図のほかの文と同じ言葉の間", () => {
    for (const x of texts(vm)) spaced(x);
  });

  it("どの手でも 3 年後の稼ぎのままならの期限の資産は、手ごとの真ん中の幅", () => {
    const p50 = viewOf(a).summary.moves.map((m) => m.atBy!.p50);
    expect(vm.today).toContain(`2056 年に約 ${okuRange(Math.min(...p50), Math.max(...p50), true)}です（手ごとの真ん中・目安）。`);
  });
});

describe("見取り図の帯（入れた前提）", () => {
  const a = handA();

  it("入れた前提は（仮）が消え、今の資産を入れれば「入れる」の 1 行も消える。前提を変えると数の鍵も変わる", () => {
    const v0 = viewOf(a);
    const v1 = viewOf(a, { v: 1, assets: 1000, save: 30, ret: 4 });
    const s1 = goalOverviewVM(a, v1).strip;
    expect(s1.premise).toContain("今の資産 1,000 万円・");
    expect(s1.premise).toContain("額面の 30% を積立・");
    expect(s1.premise).not.toContain("今の資産 1,000 万円（仮）");
    expect(s1.nudge).toBeNull();
    expect(goalViewKey(v1)).not.toBe(goalViewKey(v0));
    expect(goalViewKey(viewOf(a))).toBe(goalViewKey(v0));
    // 同じ中身でも、仮の印の付き方が違えば別の鍵（積立 20% を入れた）
    expect(goalViewKey(viewOf(a, { v: 1, save: 20 }))).not.toBe(goalViewKey(v0));
  });

  it("今の資産がゴール以上なら「もう届いています」だけ（3 つの数と手立ては出さない）", () => {
    const s = goalOverviewVM(a, viewOf(a, { v: 1, assets: 200_000 })).strip;
    expect(s.done).toBe("もう届いています（今の資産 20 億円 ≥ 10 億円）");
    expect(s.tiles).toEqual([]);
    expect(s.levers).toEqual([]);
  });

  it("積み立てない前提なら、積立と事業の伸びの数は「—」", () => {
    const s = goalOverviewVM(a, viewOf(a, { v: 1, save: 0 })).strip;
    expect(s.tiles[1]!.value).toBe("—");
    expect(s.tiles[1]!.sub).toBe("積み立てない前提なので、資産は利回りだけで増えます");
    expect(s.tiles[2]!.value).toBe("—");
  });

  it("期限までに届く前提なら、見込みと届く年（真ん中）を出す", () => {
    const s = goalOverviewVM(a, viewOf(a, { v: 1, target: 1000, save: 50, by: 2060 })).strip;
    expect(s.head).toBe("資産 1,000 万円・2060 年まで");
    expect(s.tiles[0]!.label).toBe("期限までに届く見込み");
    expect(s.tiles[0]!.value).toMatch(/^\d+%$/);
    expect(s.tiles[0]!.value).not.toBe("0%");
  });

  it("目標を変えると、どの「10 億円」も目標の額になる", () => {
    const vm = goalOverviewVM(a, viewOf(a, { v: 1, target: 30_000 }));
    for (const x of texts(vm)) expect(x).not.toContain("10 億");
    expect(vm.strip.head).toBe("資産 3 億円・2056 年まで");
  });
});

describe("芽の札と「10 の手をひと目で」", () => {
  it("芽の見込みのある手は「芽 n%」、部分木にだけある手は「芽は選び方しだい」、無い手には付けない", () => {
    const cm = compileMap(fromDevTree(indQuitTree()));
    const a = analyze(cm, 360);
    const vm = goalOverviewVM(a, viewOf(a));
    const iq = cm.firstMoves.find((f) => kindKey(cm, f) === "ind_quit")!;
    const keep = cm.firstMoves.find((f) => kindKey(cm, f) === "keep")!;
    expect(vm.seeds.find((x) => x.node === iq)).toMatchObject({ text: "芽は選び方しだい", kind: "choice" });
    expect(vm.seeds.find((x) => x.node === keep)).toBeUndefined();
    const low = analyze(cm, 60);
    const vl = goalOverviewVM(low, viewOf(low));
    expect(vl.seeds.find((x) => x.node === iq)).toMatchObject({ text: "芽 100%", kind: "seed" });
    expect(vl.today).toMatch(/^10 億への芽が一番多い手: 辞めて独立する（芽 100%）。/);
    for (const x of [...texts(vm), ...texts(vl)]) spaced(x);
  });

  for (const [name, mk] of [
    ["手で作った地図", handTree],
    ["種 3 の地図", () => randomTree(3)],
  ] as const)
    it(`${name}: 数を渡しても渡さなくても、ひと目の行の数・並び・行き先は同じ（芽の札だけ足す）`, () => {
      const a = analyze(compileMap(fromDevTree(mk())), 360);
      const plain = overviewVM(a, undefined, { goal: null });
      const withGoal = overviewVM(a, undefined, { goal: viewOf(a) });
      expect(plain.goal).toBeNull();
      expect(withGoal.goal).not.toBeNull();
      expect(withGoal.glance.rows.map((r) => r.href)).toEqual(plain.glance.rows.map((r) => r.href));
      expect(withGoal.glance.rows.length).toBe(plain.glance.rows.length);
      expect(withGoal.rows.map((r) => r.href)).toEqual(plain.rows.map((r) => r.href));
      for (const r of plain.glance.rows) expect(r.seed).toBeNull();
      const seeds = new Map(withGoal.goal!.seeds.map((x) => [x.node, x] as const));
      for (const r of withGoal.glance.rows) {
        expect(r.seed).toEqual(seeds.get(r.node) ?? null);
        if (r.seed) expect(r.aria).toContain(r.seed.aria);
      }
    });
});

describe("数の出どころ", () => {
  it("出どころの無い計算では出さない。置いた出どころは、作ってある物だけ（compute が false）を見取り図で使う", () => {
    const a = handA(400);
    expect(goalViewOf(a, true)).toBeNull();
    expect(overviewVM(a).goal).toBeNull();
    let made: GoalView | null = null;
    const calls: boolean[] = [];
    setGoalSource(a, (compute) => {
      calls.push(compute);
      if (compute && !made) made = viewOf(a);
      return made;
    });
    // 見取り図は作らない（作ってあれば使う）
    expect(overviewVM(a).goal).toBeNull();
    expect(calls).toEqual([false]);
    // 手の詳しい画面・道の終わりは、開いたときに作る
    const f = a.cm.firstMoves[0]!;
    expect(moveDetailVM(a, f).goal).not.toBeNull();
    expect(calls.at(-1)).toBe(true);
    expect(overviewVM(a).goal).not.toBeNull();
  });
});

describe("手の詳しい画面と道の終わり", () => {
  const a = handA();
  const view = viewOf(a);

  it("手ごとの「10 億」の 1 行: 期限の資産の幅（10〜90%・目安）と、一番近い行き先への道", () => {
    for (const f of a.cm.firstMoves) {
      const g = goalMoveVM(a, view, f);
      expect(g).not.toBeNull();
      expect(g!.name).toBe("10 億");
      expect(g!.text).toMatch(/^この手の行き先の 2056 年の資産は .+（10〜90%・目安）。/);
      spaced(g!.text);
      if (g!.href) {
        expect(parseRoute(g!.href).name).toBe("path");
        expect(g!.linkText).toBe("その道を見る");
      }
      // moveDetailVM に渡しても同じ
      expect(moveDetailVM(a, f, undefined, { goal: view }).goal).toEqual(g);
      expect(moveDetailVM(a, f, undefined, { goal: null }).goal).toBeNull();
    }
  });

  it("芽が部分木にだけある手は「おすすめの選び方では芽が残りません」と、芽のある行き先への道", () => {
    const cm = compileMap(fromDevTree(indQuitTree()));
    const ai = analyze(cm, 360);
    const iq = cm.firstMoves.find((f) => kindKey(cm, f) === "ind_quit")!;
    const g = goalMoveVM(ai, viewOf(ai), iq)!;
    expect(g.text).toContain("おすすめの選び方では芽が残りません。芽のある行き先は、別の答えを選んだときだけです。");
    expect(g.href).toBe(moveDetailVM(ai, iq, undefined, { goal: viewOf(ai) }).goal!.href);
    spaced(g.text);
  });

  it("道の終わり: 3 年後の月の稼ぎがそのまま続くと、期限の年の資産は…（ゴールの何%・目安）", () => {
    const text = fallbackText(a.cm.map, { annual: 360 });
    for (const f of a.cm.firstMoves) {
      const vm = pathVM(a, f, text, { goal: view });
      expect(vm.end.goal).toBe(goalEndText(a, view, vm.end.node));
      expect(vm.end.goal).toMatch(/^この行き先の 3 年後の月の稼ぎ .+がそのまま続くと、2056 年の資産は約 .+（ゴールの .+・目安。利回り 1〜5% なら .+）。/);
      spaced(vm.end.goal!);
      expect(pathVM(a, f, text, { goal: null }).end.goal).toBeNull();
    }
  });

  it("今日の欄の 1 行と帯は、年収が地図を確かめた幅の外なら、その注を足す", () => {
    const out = handA(900);
    const vm = goalOverviewVM(out, viewOf(out));
    expect(vm.strip.notes.some((n) => n.startsWith("地図の深さは年収 360〜540 万円で確かめた"))).toBe(true);
    expect(goalOverviewVM(a, view).strip.notes.some((n) => n.startsWith("地図の深さは"))).toBe(false);
  });
});

describe("仮の前提の値", () => {
  it("今の資産の仮は 0（本当の数は入れたときだけ文書に残る）", () => {
    expect(DEFAULT_GOAL.assets).toBe(0);
    expect(goalConfigOf(null).assumed.has("assets")).toBe(true);
  });
});
