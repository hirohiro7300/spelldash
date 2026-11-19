import { describe, expect, it } from "vitest";
import world from "../../scripts/impact/world.json";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";
import type { DevTree, DevTreeNode, MapData, MapHeader } from "../../src/deepmap/mapData";
import { checkBanks, checkCard, digitsOutside, wishIndex } from "../../src/demo/compose/checks";
import { BANKS, composeCard, composeMarkedCard, materializeBody, ripple, type Banks, type Card } from "../../src/demo/compose/index";
import type { ImpactLine, ImpactSt, R3 } from "../../src/demo/impact";
import type { WishData } from "../../src/demo/wishlist";
import wishData from "../../src/demo/wishlist-data.json";

// ---- 手で作った小さな地図（今日の手 6 つ・分かれる事実・数で分かれる結果・避けたい手・まとめた手・12 段の今のまま・独立・週 4 日・学校）

const st = (o: Partial<ImpactSt> = {}): ImpactSt => ({ j: "e", pm: "?", pro: 0, mau: 40, pu: 0, seats: 0, cl: 0, fee: 0, sal: 1, cv: 1, fl: [], ...o });
const HOURS: Record<string, number> = { keep: 0, ad_permside: 4, ad_side: 5, ad_more: 6, fc_switch: 5, fc_switch2: 5, fc_push: 4, ind_quit: -2, back_emp: 0, part: 0, sd_pilot: 3, sd_school: 3, sd_retain: 3 };

function move(k: string, kind: string, m: number, s: ImpactSt, kids: DevTreeNode[], o: Partial<DevTreeNode> = {}): DevTreeNode {
  const base: Partial<DevTreeNode> = kind === "keep" ? { base: true, why: "keep" } : { why: "best" };
  return { k, r: "a", m, st: s, kind, h: HOURS[kind] ?? 0, ...base, ...o, kids };
}
function out(k: string, m: number, s: ImpactSt, id: string, p: number, lab: string, ln: ImpactLine | null, e: R3, rr: R3, kids: DevTreeNode[] = [], o: Partial<DevTreeNode> = {}): DevTreeNode {
  const r = m >= 36 ? "e" : "s";
  return { k, r, m, st: s, id, p, lab, line: ln ? `${lab}の線` : "（どの場合もこの道）", ln, e, rr, ...o, ...(kids.length ? { kids } : {}) };
}
/** まとめた手（今のまま）と、その先のまとめた行き先 */
function stub(k: string, m: number, s: ImpactSt, end: ImpactSt, rr: R3): DevTreeNode {
  return move(`${k}.${m / 3}k`, "keep", m, s, [out(`${k}.${m / 3}k.all`, 36, end, "all", 100, "どの場合も", null, [70, 30, 20], rr, [], { sum: true })], { stub: true });
}
/** 36 か月目まで今のままを続ける道（状態は 3 か月ごと。最後は本当の行き先） */
function keepChain(k: string, m: number, s: ImpactSt): DevTreeNode[] {
  const key = `${k}.${m / 3}k`;
  const s2 = st({ ...s, mau: Math.round(s.mau * 1.25), sal: m + 3 === 5 || m + 3 === 17 || m + 3 === 29 ? s.sal * 1.03 : s.sal });
  const rr: R3 = [s2.sal, 0, -0.3];
  const child = m + 3 >= 36 ? out(`${key}.all`, 36, s2, "all", 100, "どの場合も", null, [3 * s2.sal, 0, -0.9], rr) : out(`${key}.all`, m + 3, s2, "all", 100, "どの場合も", null, [3 * s2.sal, 0, -0.9], rr, keepChain(`${key}.all`, m + 3, s2));
  return [move(key, "keep", m, s, [child])];
}

const S0 = st();
const sA = st({ pm: "a", pro: 1, mau: 50.59, pu: 1.25, cl: 1, fee: 5 });
const sA2 = st({ pm: "a", pro: 1, mau: 70, pu: 3, cl: 2, fee: 5 });
const sA9 = st({ pm: "a", pro: 1, mau: 90, pu: 5, cl: 2, fee: 5 });
const sA12 = st({ pm: "a", pro: 1, mau: 110, pu: 7, cl: 2, fee: 5 });
const sA15 = st({ pm: "a", pro: 1, mau: 125, pu: 8, cl: 2, fee: 5, sal: 1.03 });
const sS = st({ pm: "s", pro: 1, mau: 50.59, pu: 1.25 });
const sN = st({ pm: "n", mau: 50.59 });
const sI1 = st({ j: "i", pro: 1, mau: 50.59, pu: 0.78, cl: 1, fee: 7 });
const sI0 = st({ j: "i", pro: 1, mau: 50.59, pu: 0.78 });

const root: DevTreeNode = {
  k: "r",
  r: "r",
  m: 0,
  st: S0,
  rr: [1, 0, -0.3],
  kids: [
    move("r.ad_permside", "ad_permside", 0, S0, [
      out("r.ad_permside.a0_a1", 3, sA, "a0_a1", 20, "全部可", ["permside", 3, null, null, "a0_a1"], [3, 3.76, -0.71], [1, 5, -0.18], [
        move("r.ad_permside.a0_a1.1ad", "ad_side", 3, sA, [
          out("r.ad_permside.a0_a1.1ad.cl2", 6, sA2, "cl2", 55, "顧客 2 社以上", ["cl", 6, 2, null], [3, 22, -0.4], [1, 10, -0.02], [
            move("r.ad_permside.a0_a1.1ad.cl2.2k", "keep", 6, sA2, [
              out("r.ad_permside.a0_a1.1ad.cl2.2k.all", 9, sA9, "all", 100, "どの場合も", null, [3, 29, 0.1], [1, 10, 0.17], [
                move("r.ad_permside.a0_a1.1ad.cl2.2k.all.3k", "keep", 9, sA9, [
                  out("r.ad_permside.a0_a1.1ad.cl2.2k.all.3k.all", 12, sA12, "all", 100, "どの場合も", null, [3, 29, 0.6], [1, 10, 0.36], [
                    move("r.ad_permside.a0_a1.1ad.cl2.2k.all.3k.all.4k", "keep", 12, sA12, [
                      out("r.ad_permside.a0_a1.1ad.cl2.2k.all.3k.all.4k.all", 15, sA15, "all", 100, "どの場合も", null, [3, 29, 0.9], [1, 10, 0.4], [
                        move("r.ad_permside.a0_a1.1ad.cl2.2k.all.3k.all.4k.all.5fp", "fc_push", 15, sA15, [
                          out("r.ad_permside.a0_a1.1ad.cl2.2k.all.3k.all.4k.all.5fp.up", 18, { ...sA15, sal: 1.1 }, "up", 30, "昇格", ["sal", 18, null, null, "up"], [3.2, 29, 0.9], [1.1, 10, 0.4], [stub("r.ad_permside.a0_a1.1ad.cl2.2k.all.3k.all.4k.all.5fp.up", 18, { ...sA15, sal: 1.1 }, st({ pm: "a", pro: 1, mau: 900, pu: 41, cl: 1.9, fee: 5, sal: 1.16 }), [1.16, 9.1, 3.6])]),
                          out("r.ad_permside.a0_a1.1ad.cl2.2k.all.3k.all.4k.all.5fp.same", 18, { ...sA15, sal: 1.03 }, "same", 70, "据え置き", ["sal", 18, null, null, "same"], [3.1, 29, 0.9], [1.03, 10, 0.4], [stub("r.ad_permside.a0_a1.1ad.cl2.2k.all.3k.all.4k.all.5fp.same", 18, { ...sA15, sal: 1.03 }, st({ pm: "a", pro: 1, mau: 880, pu: 38, cl: 1.8, fee: 5, sal: 1.09 }), [1.09, 8.9, 3.3])]),
                        ]),
                        stub("r.ad_permside.a0_a1.1ad.cl2.2k.all.3k.all.4k.all", 15, sA15, st({ pm: "a", pro: 1, mau: 860, pu: 37, cl: 1.8, fee: 5, sal: 1.07 }), [1.07, 9, 3.2]),
                      ]),
                    ]),
                    move("r.ad_permside.a0_a1.1ad.cl2.2k.all.3k.all.4sr", "sd_retain", 12, sA12, [out("r.ad_permside.a0_a1.1ad.cl2.2k.all.3k.all.4sr.all", 36, st({ pm: "a", pro: 1, mau: 870, pu: 45, cl: 1.8, fee: 5, sal: 1.07 }), "all", 100, "どの場合も", null, [70, 220, 45], [1.07, 9, 3.9], [], { sum: true })], { stub: true, why: "area" }),
                  ]),
                ]),
              ]),
            ]),
            move("r.ad_permside.a0_a1.1ad.cl2.2iq", "ind_quit", 6, sA2, [
              out("r.ad_permside.a0_a1.1ad.cl2.2iq.cl3", 36, st({ j: "i", pm: "a", pro: 1, mau: 700, pu: 24, cl: 3, fee: 7 }), "cl3", 40, "顧客 3 社以上", ["cl", 9, 3, null], [0, 600, 50], [0, 18, 1.9], [], { sum: true }),
              out("r.ad_permside.a0_a1.1ad.cl2.2iq.cl2", 36, st({ j: "i", pm: "a", pro: 1, mau: 690, pu: 22, cl: 1.6, fee: 7 }), "cl2", 60, "顧客 2 社以下", ["cl", 9, null, 3], [0, 300, 40], [0, 8.2, 1.7], [], { sum: true }),
            ], { why: "avoid", stub: true }),
          ]),
          out("r.ad_permside.a0_a1.1ad.cl1", 6, st({ ...sA, mau: 66, pu: 2.4 }), "cl1", 45, "顧客 1 社以下", ["cl", 6, null, 2], [3, 15, -0.5], [1, 5, -0.07], [stub("r.ad_permside.a0_a1.1ad.cl1", 6, st({ ...sA, mau: 66, pu: 2.4 }), st({ pm: "a", pro: 1, mau: 800, pu: 30, cl: 1.2, fee: 5, sal: 1.07 }), [1.07, 6, 2.5])]),
        ]),
        stub("r.ad_permside.a0_a1", 3, sA, st({ pm: "a", pro: 1, mau: 700, pu: 25, cl: 0.8, fee: 5, sal: 1.07 }), [1.07, 4, 2]),
      ], { rv: ["pm:0", "a"] }),
      out("r.ad_permside.s", 3, sS, "s", 45, "SpellDash だけ", ["permside", 3, null, null, "s"], [3, 0, -0.71], [1, 0, -0.18], [
        move("r.ad_permside.s.1sr", "sd_retain", 3, sS, [out("r.ad_permside.s.1sr.all", 6, st({ pm: "s", pro: 1, mau: 64, pu: 3 }), "all", 100, "どの場合も", null, [3, 0, -0.4], [1, 0, -0.02], [stub("r.ad_permside.s.1sr.all", 6, st({ pm: "s", pro: 1, mau: 64, pu: 3 }), st({ pm: "s", pro: 1, mau: 900, pu: 60, sal: 1.1 }), [1.1, 0, 5.3])])]),
        stub("r.ad_permside.s", 3, sS, st({ pm: "s", pro: 1, mau: 850, pu: 50, sal: 1.1 }), [1.1, 0, 4.4]),
      ], { rv: ["pm:0", "s"] }),
      out("r.ad_permside.n", 3, sN, "n", 35, "どちらも不可", ["permside", 3, null, null, "n"], [3, 0, -0.9], [1, 0, -0.3], [
        move("r.ad_permside.n.1fw", "fc_switch", 3, sN, [
          out("r.ad_permside.n.1fw.high", 6, st({ pm: "n", mau: 62, sal: 1.18, fl: ["switched"] }), "high", 10, "大きく上げて転職", ["sal", 6, null, null, "high"], [2.68, 0, -0.9], [1.18, 0, -0.3], [stub("r.ad_permside.n.1fw.high", 6, st({ pm: "n", mau: 62, sal: 1.18, fl: ["switched"] }), st({ pm: "n", mau: 700, sal: 1.25, fl: ["switched"] }), [1.25, 0, -0.3])]),
          out("r.ad_permside.n.1fw.none", 6, st({ pm: "n", mau: 62, fl: ["js"] }), "none", 72, "転職せず", ["sal", 6, null, null, "none"], [3, 0, -0.9], [1, 0, -0.3], [
            move("r.ad_permside.n.1fw.none.2fw2", "fc_switch2", 6, st({ pm: "n", mau: 62, fl: ["js"] }), [
              out("r.ad_permside.n.1fw.none.2fw2.high_mid", 9, st({ pm: "n", mau: 75, sal: 1.13, fl: ["switched"] }), "high_mid", 13, "上げて転職", ["sal", 9, null, null, "high_mid"], [2.9, 0, -0.9], [1.13, 0, -0.3], [stub("r.ad_permside.n.1fw.none.2fw2.high_mid", 9, st({ pm: "n", mau: 75, sal: 1.13, fl: ["switched"] }), st({ pm: "n", mau: 650, sal: 1.2, fl: ["switched"] }), [1.2, 0, -0.3])]),
              out("r.ad_permside.n.1fw.none.2fw2.none", 9, st({ pm: "n", mau: 75, fl: ["js"] }), "none", 87, "転職せず", ["sal", 9, null, null, "none"], [3, 0, -0.9], [1, 0, -0.3], [stub("r.ad_permside.n.1fw.none.2fw2.none", 9, st({ pm: "n", mau: 75, fl: ["js"] }), st({ pm: "n", mau: 600, sal: 1.06 }), [1.06, 0, -0.3])]),
            ]),
          ]),
        ]),
        stub("r.ad_permside.n", 3, sN, st({ pm: "n", mau: 600, sal: 1.06 }), [1.06, 0, -0.3]),
      ], { rv: ["pm:0", "n"] }),
    ]),
    move("r.ind_quit", "ind_quit", 0, S0, [
      out("r.ind_quit.cl1", 3, sI1, "cl1", 35, "顧客 1 社", ["cl", 3, 1, 2], [1, 1, -0.82], [0, 4, -0.23], [
        move("r.ind_quit.cl1.1am", "ad_more", 3, sI1, [
          out("r.ind_quit.cl1.1am.cl2", 6, st({ ...sI1, cl: 2, mau: 62, pu: 1.6 }), "cl2", 30, "顧客 2 社以上", ["cl", 6, 2, null], [0, 24, -0.5], [0, 11, -0.15], [stub("r.ind_quit.cl1.1am.cl2", 6, st({ ...sI1, cl: 2, mau: 62, pu: 1.6 }), st({ j: "i", pro: 1, mau: 600, pu: 20, cl: 2.2, fee: 7 }), [0, 12.4, 1.6])]),
          out("r.ind_quit.cl1.1am.cl1", 6, st({ ...sI1, mau: 62, pu: 1.6 }), "cl1", 70, "顧客 1 社以下", ["cl", 6, null, 2], [0, 12, -0.5], [0, 4, -0.15], [stub("r.ind_quit.cl1.1am.cl1", 6, st({ ...sI1, mau: 62, pu: 1.6 }), st({ j: "i", pro: 1, mau: 580, pu: 18, cl: 1, fee: 7 }), [0, 4, 1.4])]),
        ]),
      ]),
      out("r.ind_quit.cl0", 3, sI0, "cl0", 65, "顧客 0 社", ["cl", 3, 0, 1], [1, -6, -0.82], [0, -3, -0.23], [
        move("r.ind_quit.cl0.1be", "back_emp", 3, sI0, [
          out("r.ind_quit.cl0.1be.e", 6, st({ pro: 1, mau: 62, pu: 1.6 }), "e", 60, "会社員に戻る", ["job", 6, null, null, "e"], [2, -2, -0.5], [1, 0, -0.15], [stub("r.ind_quit.cl0.1be.e", 6, st({ pro: 1, mau: 62, pu: 1.6 }), st({ pro: 1, mau: 700, pu: 22, sal: 1.06 }), [1.06, 0, 1.8])]),
          out("r.ind_quit.cl0.1be.i", 6, st({ ...sI0, mau: 62, pu: 1.6 }), "i", 40, "独立のまま", ["job", 6, null, null, "i"], [0, -9, -0.5], [0, -3, -0.15], [stub("r.ind_quit.cl0.1be.i", 6, st({ ...sI0, mau: 62, pu: 1.6 }), st({ j: "i", pro: 1, mau: 560, pu: 17, cl: 0.4, fee: 7 }), [0, -0.2, 1.3])]),
        ]),
      ]),
    ], { why: "avoid" }),
    move("r.part", "part", 0, S0, [
      out("r.part.p", 3, st({ j: "p", mau: 52.48 }), "p", 35, "週 4 日に", ["job", 3, null, null, "p"], [2.6, 0, -0.9], [0.8, 0, -0.3], [stub("r.part.p", 3, st({ j: "p", mau: 52.48 }), st({ j: "p", pm: "s", pro: 1, mau: 650, pu: 25, sal: 1.06 }), [0.85, 0, 2.05])]),
      out("r.part.e", 3, st({ mau: 50.59, fl: ["pq"] }), "e", 65, "認められず", ["job", 3, null, null, "e"], [3, 0, -0.9], [1, 0, -0.3], [stub("r.part.e", 3, st({ mau: 50.59, fl: ["pq"] }), st({ mau: 600, sal: 1.06, fl: ["pq"] }), [1.06, 0, -0.3])]),
    ]),
    move("r.sd_pilot", "sd_pilot", 0, S0, [
      out("r.sd_pilot.yes", 3, st({ mau: 82.99, fl: ["pilot"] }), "yes", 30, "試用が決まる", ["pilot", 3, null, null, "yes"], [3, 0, -0.9], [1, 0, -0.3], [
        move("r.sd_pilot.yes.1ss", "sd_school", 3, st({ mau: 82.99, fl: ["pilot"] }), [
          out("r.sd_pilot.yes.1ss.yes", 6, st({ pm: "s", pro: 1, mau: 130, pu: 40, seats: 40, fl: ["pilot", "school"] }), "yes", 15, "導入が決まる", ["school", 6, null, null, "yes"], [3, 0, 2.4], [1, 0, 1.2], [stub("r.sd_pilot.yes.1ss.yes", 6, st({ pm: "s", pro: 1, mau: 130, pu: 40, seats: 40, fl: ["pilot", "school"] }), st({ pm: "s", pro: 1, mau: 900, pu: 70, seats: 40, sal: 1.06, fl: ["pilot", "school"] }), [1.06, 0, 4.9])]),
          out("r.sd_pilot.yes.1ss.no", 6, st({ mau: 104, fl: ["pilot"] }), "no", 85, "見送られる", ["school", 6, null, null, "no"], [3, 0, -0.9], [1, 0, -0.3], [stub("r.sd_pilot.yes.1ss.no", 6, st({ mau: 104, fl: ["pilot"] }), st({ mau: 700, sal: 1.06, fl: ["pilot"] }), [1.06, 0, -0.3])]),
        ]),
      ]),
      out("r.sd_pilot.no", 3, st({ mau: 50.59 }), "no", 70, "見つからず", ["pilot", 3, null, null, "no"], [3, 0, -0.9], [1, 0, -0.3], [stub("r.sd_pilot.no", 3, st({ mau: 50.59 }), st({ mau: 600, sal: 1.06 }), [1.06, 0, -0.3])]),
    ]),
    move("r.keep", "keep", 0, S0, [out("r.keep.all", 3, st({ mau: 50 }), "all", 100, "どの場合も", null, [3, 0, -0.9], [1, 0, -0.3], keepChain("r.keep.all", 3, st({ mau: 50 })))]),
  ],
};

// 組み立ては header の anchor と horizon だけを読む（手の種類の名前などは見ない）
const header: MapHeader = { v: 3, kind: "impact3y", title: "t", anchor: "2026-11", horizon: 36, annual: 360, release: 0, hash: "test", textVersion: "test", kinds: {}, fams: {}, premises: [], never: {}, counts: { nodes: 0, decisions: 0, options: 0, forks: 0, ends: 0, sumEnds: 0 } };
const TREE: DevTree = { header, root };

const wish = wishIndex(wishData as unknown as WishData);
const all = (m: MapData): number[] => Array.from({ length: m.n }, (_, i) => i);
const byKey = (m: MapData, k: string): number => {
  const i = m.indexOfKey(k);
  if (i < 0) throw new Error(`no key ${k}`);
  return i;
};

/** R2 の束にある手書きの数（文の型の波で直す。点検 C1 はこれを見つけ続ける） */
const KNOWN_C1 = [/1 社の売上/, /10 人を超えるまで/, /1 席 月/];

describe("文章の組み立て（R2 の組み立てを MapData に移した物）", () => {
  const map = fromDevTree(TREE);

  it("どの役割のカードも組み立てられ、空・印・埋まっていない差し込みが残らない", () => {
    const roles = new Set<string>();
    for (const i of all(map)) {
      const c = composeCard(map, i, { annual: 360 });
      roles.add(map.role(i));
      expect(c.title, map.key(i)).not.toBe("");
      expect(c.body, map.key(i)).not.toBe("");
      const text = [c.title, c.short, c.body, ...c.numbers, ...c.todo.map((t) => t.text)].join("\n");
      expect(text, map.key(i)).not.toMatch(/[\u0001-\u0004]|\{\w+\}|undefined|NaN|null|Infinity/);
      if (map.role(i) === "a") {
        // 3 つまで（長い今のままの道では手引きを使い切って減る。R2 の束のまま。文の型の波で足す）
        expect(c.todo.length, map.key(i)).toBeLessThanOrEqual(3);
        expect(new Set(c.todo.map((t) => t.cite)).size, map.key(i)).toBe(c.todo.length);
        for (const t of c.todo) expect(wish.has(t.cite), `${map.key(i)} ${t.cite}`).toBe(true);
      } else expect(c.todo).toEqual([]);
      expect(c.numbers.length, map.key(i)).toBeGreaterThanOrEqual(4);
      expect(c.trace.length, map.key(i)).toBeGreaterThan(0);
    }
    expect([...roles].sort()).toEqual(["a", "e", "r", "s"]);
  });

  it("決まった出力: 同じ地図で 2 回・別の地図の物で逆の順に組み立てても同じ文", () => {
    const first = all(map).map((i) => composeCard(map, i, { annual: 360 }));
    const again = all(map).map((i) => composeCard(map, i, { annual: 360 }));
    const other = fromDevTree(TREE);
    const reversed: Card[] = [];
    for (const i of all(other).reverse()) reversed[i] = composeCard(other, i, { annual: 360 });
    expect(again).toEqual(first);
    expect(reversed).toEqual(first);
  });

  it("差し込みをたどれる: 数字はどれも差し込みの印の中か手引きの文の中（C1）で、使った文の型は束にある", () => {
    for (const i of all(map)) {
      const c = composeMarkedCard(map, i, { annual: 360 });
      const known = (s: string): string => KNOWN_C1.reduce((x, re) => x.replace(re, ""), s);
      expect(digitsOutside(known(c.body)), `${map.key(i)} 本文: ${c.body}`).toEqual([]);
      expect(digitsOutside(c.title), `${map.key(i)} 題`).toEqual([]);
      for (const x of c.numbers) expect(digitsOutside(x), `${map.key(i)} 数の行: ${x}`).toEqual([]);
      for (const tag of c.trace) expect(resolves(BANKS, tag), `${map.key(i)} ${tag}`).toBe(true);
    }
  });

  it("手引きの数字は引いた項目にある（C1b・束の全部の歩み）。引いた項目はやりたいことリストにある", () => {
    const issues = checkBanks(BANKS, wish);
    expect(issues.filter((x) => x.startsWith("C1b"))).toEqual([]);
    // 24 字を超えるやること（R2 の束のまま。文の型の波で直す）
    expect(issues.filter((x) => x.startsWith("C3")).map((x) => x.split(": ")[1]?.split("「")[0])).toEqual(["sd_grow spell-growth-d03", "sd_pilot spell-b2b-03"]);
  });

  it("1 枚の点検（C1b・C2・C4・C4b・C5）は、この地図では手書きの数のほかに見つからない", () => {
    for (const i of all(map)) {
      const issues = checkCard(map, i, composeMarkedCard(map, i, { annual: 360 }), BANKS, wish).filter((x) => !x.startsWith("C3") && !x.startsWith("D2") && !x.startsWith("C1 データに無い数字"));
      expect(issues, map.key(i)).toEqual([]);
    }
  });

  it("文が言う前提の数は scripts/impact/world.json と同じ", () => {
    const c = world.constants;
    expect(BANKS.C).toEqual({
      sideFee: c.sideFee,
      indFee: c.indFee,
      overhead: c.indOverhead,
      spend: world.kinds.sd_ads.p.spend,
      capEmp: c.capEmp,
      capPart: c.capPart,
      capInd: c.capInd,
      net: c.net,
      infra: c.infra,
      step: world.kinds.fc_push.p.step,
      seatYen: Math.round(c.seatNet * 10000),
      partFactor: c.partFactor,
      schoolSeats: c.schoolSeats,
      baseHours: c.baseHours,
    });
  });

  it("年月は地図の 0 か月目（header.anchor）から。4 月・確定申告の年も", () => {
    const c0 = composeCard(map, 0, { annual: 360 });
    expect(c0.body).toMatch(/^2026 年 11 月時点の地図。ここから 2029 年 11 月まで/);
    // 2027 年の副業の稼ぎが 20 万円を超えた道の 2027 年 11 月の状態は、次の 3 か月に 2027 年分の確定申告
    const s12 = composeCard(map, byKey(map, "r.ad_permside.a0_a1.1ad.cl2.2k.all.3k.all"), { annual: 360 });
    expect(s12.body).toMatch(/^2027 年 11 月[。、]/);
    expect(s12.body).toContain("2027 年分の確定申告は 2 月 16 日〜3 月 15 日。");
    // 昇格は 2028 年 4 月の評価（2028 年 2 月に選ぶ 3 か月に 4 月が入る）
    const push = "r.ad_permside.a0_a1.1ad.cl2.2k.all.3k.all.4k.all.5fp";
    expect(composeCard(map, byKey(map, push), { annual: 360 }).title).toBe("2028 年 4 月の昇格を狙う");
    // 0 か月目をずらすと、どの年月もずれる
    const shifted = fromDevTree({ header: { ...header, anchor: "2027-02" }, root });
    expect(composeCard(shifted, 0, { annual: 360 }).body).toMatch(/^2027 年 2 月時点の地図。ここから 2030 年 2 月まで/);
    expect(composeCard(shifted, byKey(shifted, "r.ad_permside.a0_a1.1ad.cl2.2k.all.3k.all"), { annual: 360 }).body).toMatch(/^2028 年 2 月[。、]/);
    // 0 か月目が 2027 年 2 月なら、15 か月目に選ぶ 3 か月（2028 年 6〜8 月）に 4 月は無い
    expect(composeCard(shifted, byKey(shifted, push), { annual: 360 }).title).toBe("昇格を狙う");
    expect(() => composeCard(fromDevTree({ header: { ...header, anchor: "2026/11" }, root }), 0, { annual: 360 })).toThrow(/年月が読めません/);
  });

  it("今日の手は、この手の先の分かれ道（判断・出来事の分かれ・結果ごと）と行き先（まとめた見積もりを分けて）を書く", () => {
    const a = byKey(map, "r.ad_permside");
    const r = ripple(map, a);
    const c = composeCard(map, a, { annual: 360 });
    expect(c.body).toContain(`この手の先、2029 年 11 月までの分かれ道は ${r.forks}（判断 ${r.decisions}・出来事の分かれ ${r.splits}）。全部可の後 ${ripple(map, byKey(map, "r.ad_permside.a0_a1")).forks}・SpellDash だけの後`);
    expect(c.body).toContain(`行き先は ${r.ends} で、うち ${r.sumEnds} は標準の続きの見積もり。`);
    // 数え上げは木をたどった数と同じ
    for (const i of all(map)) expect(ripple(map, i), map.key(i)).toEqual(walkCounts(map, i));
  });

  it("年収で変わる文: 給与の月額と避けたい手の訳", () => {
    const a = byKey(map, "r.ind_quit");
    const c360 = composeCard(map, a, { annual: 360 });
    const c540 = composeCard(map, a, { annual: 540 });
    expect(c360.numbers[0]).toBe("年収 360 万円（月にならして 30 万円）");
    expect(c540.numbers[0]).toBe("年収 540 万円（月にならして 45 万円）");
    const quit = byKey(map, "r.ad_permside.a0_a1.1ad.cl2.2iq");
    const b360 = composeCard(map, quit, { annual: 360 }).body;
    const b540 = composeCard(map, quit, { annual: 540 }).body;
    // 年収 360 なら顧客をあと 4 社で給与に並ぶが、540 なら独立で抱えられる 6 社でも届かない（言い方が変わる）
    expect(b360).toContain("給与（月 30 万円）が 7 月から止まり、経費が月 3 万円かかる。今の顧客 2 社から給与に並ぶには、1 社 月 7 万円の顧客があと 4 社要る。");
    expect(b540).toContain("給与（月 45 万円）が 7 月から止まり、経費が月 3 万円かかる。独立で抱えられる 6 社まで顧客を増やしても、今の給与には届かない。");
  });

  it("数の行: 年収・広告運用・有料・遊ぶ人・週の時間（SPEC §4.2 の言い方）", () => {
    const s = composeCard(map, byKey(map, "r.ad_permside.a0_a1.1ad.cl2"), { annual: 360 });
    expect(s.numbers).toEqual(["年収 360 万円（月にならして 30 万円）", "広告運用 2 社（売上 月 10 万円）", "有料 3 人（手数料とサーバー代を引いて月 200 円の持ち出し）", "月に遊んだ人 70 人（3 か月前より +19 人）", "週 57 時間（今日より +5 時間）"]);
    const ind = composeCard(map, byKey(map, "r.ind_quit.cl0"), { annual: 360 });
    expect(ind.numbers.slice(0, 2)).toEqual(["給与なし（独立）", "広告運用の顧客なし"]);
    // 本当の行き先は 5 つ。まとめた行き先は 3 か月前の状態も週の時間も無いので 4 つ
    const real = composeCard(map, byKey(map, "r.keep.all.1k.all.2k.all.3k.all.4k.all.5k.all.6k.all.7k.all.8k.all.9k.all.10k.all.11k.all"), { annual: 360 });
    expect(real.numbers).toHaveLength(5);
    expect(real.numbers[3]).toMatch(/^月に遊んだ人 [\d,]+ 人（3 か月前より \+[\d,]+ 人）$/);
    const sum = composeCard(map, byKey(map, "r.ad_permside.a0_a1.1k.all"), { annual: 360 });
    expect(sum.numbers).toHaveLength(4);
    expect(sum.numbers[3]).toBe("月に遊んだ人 700 人");
  });

  it("写しの文は、数の行を 1 行にして本文の前に置く", () => {
    const i = byKey(map, "r.ad_permside.a0_a1");
    const c = composeCard(map, i, { annual: 360 });
    expect(materializeBody(map, i, 360)).toBe(`${c.numbers.join("・")}\n${c.body}`);
  });

  it("手引きは道を進むと進み、同じ道で同じ歩みを繰り返さない", () => {
    let i = byKey(map, "r.keep");
    const seen = new Set<string>();
    for (;;) {
      for (const t of composeCard(map, i, { annual: 360 }).todo) {
        expect(seen.has(t.cite), t.cite).toBe(false);
        seen.add(t.cite);
      }
      const o = map.child(i, 0);
      if (map.role(o) === "e") break;
      i = map.child(o, 0);
    }
    expect(seen.size).toBeGreaterThanOrEqual(6);
  });

  it("道の覚えは地図ごと: 深いカードの初めの 1 枚は道の上だけを読み、近くのカードは覚えから引く", () => {
    const counted = counting(fromDevTree(TREE));
    const deep = counted.map.indexOfKey("r.keep.all.1k.all.2k.all.3k.all.4k.all.5k.all.6k.all.7k.all.8k.all.9k.all.10k.all");
    counted.touched.clear();
    composeCard(counted.map, deep, { annual: 360 });
    // 読んだのは、今日からそのカードまでの道と、そのカードの子だけ
    const allowed = new Set<number>([deep]);
    for (let x = deep; x >= 0; x = counted.map.parent(x)) allowed.add(x);
    for (let k = 0; k < counted.map.childCount(deep); k++) allowed.add(counted.map.child(deep, k));
    expect([...counted.touched].filter((x) => !allowed.has(x))).toEqual([]);
    expect(counted.touched.size).toBeLessThan(counted.map.n / 3);
    // 同じ道の 1 つ先の手は、新しく読むカードがわずか
    counted.touched.clear();
    composeCard(counted.map, counted.map.child(deep, 0), { annual: 360 });
    expect(counted.touched.size).toBeLessThanOrEqual(8);
  });

  it("番号・年収・束の形がおかしければ投げる。別の束も使える", () => {
    expect(() => composeCard(map, -1, { annual: 360 })).toThrow(RangeError);
    expect(() => composeCard(map, map.n, { annual: 360 })).toThrow(RangeError);
    expect(() => composeCard(map, 0, { annual: Number.NaN })).toThrow(RangeError);
    const banks: Banks = { ...BANKS, title: { ...BANKS.title, keep: [{ v: ["何もしない 3 か月"] }] } };
    expect(composeCard(map, byKey(map, "r.keep"), { annual: 360, banks }).title).toBe("何もしない 3 か月");
    expect(composeCard(map, byKey(map, "r.keep"), { annual: 360 }).title).toBe("今のままにする");
    const bad: Banks = { ...BANKS, title: { ...BANKS.title, keep: [{ if: "j==e", v: ["x"] }] } };
    expect(() => composeCard(map, byKey(map, "r.keep"), { annual: 360, banks: bad })).toThrow(/条件の書き方/);
  });
});

/** 使った文の型の名前（節.種類#組.言い換え）が束にあるか。文の型を使わない節の名前も認める */
function resolves(banks: Banks, tag: string): boolean {
  if (["watch:single", "watch:num", "ripple", "root"].includes(tag)) return true;
  const m = /^(\w+)(?:\.([^#]+))?#(\d+)\.(\d+)$/.exec(tag);
  if (!m) return false;
  let cell: unknown = (banks as unknown as Record<string, unknown>)[m[1]!];
  for (const p of m[2] ? m[2].split(".") : []) cell = (cell as Record<string, unknown> | undefined)?.[p];
  if (!Array.isArray(cell)) return false;
  const g = cell[Number(m[3])] as { v?: string[] } | undefined;
  return typeof g?.v?.[Number(m[4])] === "string";
}

/** 木をたどって数える（ripple と比べる） */
function walkCounts(map: MapData, i: number): { decisions: number; splits: number; forks: number; ends: number; sumEnds: number } {
  const c = { decisions: 0, splits: 0, forks: 0, ends: 0, sumEnds: 0 };
  const stack = [i];
  while (stack.length) {
    const x = stack.pop()!;
    if (map.role(x) === "e") {
      c.ends++;
      if (map.sum(x)) c.sumEnds++;
    } else if (map.childCount(x) >= 2) {
      if (map.role(x) === "a") c.splits++;
      else c.decisions++;
    }
    for (let k = 0; k < map.childCount(x); k++) stack.push(map.child(x, k));
  }
  c.forks = c.decisions + c.splits;
  return c;
}

/** 番号を受け取る問い合わせで、読んだカードの番号を数える地図 */
function counting(inner: MapData): { map: MapData; touched: Set<number> } {
  const touched = new Set<number>();
  const map = new Proxy(inner, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv) as unknown;
      if (typeof v !== "function" || prop === "indexOfKey") return v;
      return (...args: unknown[]) => {
        if (typeof args[0] === "number") touched.add(args[0]);
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { map, touched };
}
