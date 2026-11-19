import { describe, expect, it } from "vitest";
import type { ImpactSt } from "../../src/demo/impact";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";
import type { DevTree, MapHeader } from "../../src/deepmap/mapData";

const st = (over: Partial<ImpactSt> = {}): ImpactSt => ({ j: "e", pm: "?", pro: 0, mau: 40, pu: 0, seats: 0, cl: 0, fee: 0, sal: 1, cv: 1, fl: [], ...over });
const header: MapHeader = {
  v: 3,
  kind: "impact3y",
  title: "t",
  anchor: "2026-11",
  horizon: 36,
  annual: 360,
  release: 0,
  hash: "dev",
  textVersion: "dev",
  kinds: { keep: ["今のまま", "base", "base", []], ad_permside: ["届け出て副業", "ind", "side", ["s_balance"]] },
  fams: { side: "副業" },
  premises: [],
  never: {},
  counts: { nodes: 6, decisions: 1, options: 2, forks: 2, ends: 3, sumEnds: 2 },
};
const tree: DevTree = {
  header,
  root: {
    k: "r",
    r: "r",
    m: 0,
    st: st(),
    rr: [1, 0, 0],
    kids: [
      {
        k: "r.ad_permside",
        r: "a",
        m: 0,
        st: st(),
        kind: "ad_permside",
        h: 5,
        why: "best",
        stub: true,
        q: [35, 20, 1],
        todo: [{ text: "就業規則を読む", cite: "ind-side-01" }],
        kids: [
          { k: "r.ad_permside.a", r: "e", m: 36, st: st({ pm: "a" }), id: "a", p: 20, lab: "全部可", line: "会社の答えが『全部可』", ln: ["perm", 3, null, null, "a"], e: [35, 200, 20], rr: [1.1, 7, 3], sum: true, rv: ["pm:0", "a"] },
          { k: "r.ad_permside.n", r: "e", m: 36, st: st({ pm: "n" }), id: "n", p: 80, lab: "どちらも不可", line: "会社の答えが『どちらも不可』", ln: ["perm", 3, null, null, "n"], e: [37, 16, 3], rr: [1.2, 1, 1], sum: true },
        ],
      },
      { k: "r.keep", r: "a", m: 0, st: st(), kind: "keep", why: "keep", kids: [{ k: "r.keep.all", r: "e", m: 36, st: st(), id: "all", p: 100, line: "（どの場合もこの道）", e: [36, 0, 0], rr: [1, 0, 0] }] },
    ],
  },
};

describe("fromDevTree", () => {
  const m = fromDevTree(tree);
  it("numbers the cards depth-first with parents before children and keeps sibling order", () => {
    expect(m.n).toBe(6);
    expect([0, 1, 2, 3, 4, 5].map((i) => m.key(i))).toEqual(["r", "r.ad_permside", "r.ad_permside.a", "r.ad_permside.n", "r.keep", "r.keep.all"]);
    expect([0, 1, 2, 3, 4, 5].map((i) => m.parent(i))).toEqual([-1, 0, 1, 1, 0, 4]);
    expect(m.childCount(0)).toBe(2);
    expect(m.child(0, 1)).toBe(4);
    expect(m.indexOfKey("r.keep.all")).toBe(5);
    expect(m.indexOfKey("nope")).toBe(-1);
  });
  it("answers per role and returns empty values for questions that do not fit the role", () => {
    expect(m.role(1)).toBe("a");
    expect(m.kind(1)).toBe("ad_permside");
    expect(m.kind(2)).toBeNull();
    expect(m.isBase(4)).toBe(true);
    expect(m.isBase(1)).toBe(false);
    expect(m.stub(1)).toBe(true);
    expect(m.q(1)).toEqual([35, 20, 1]);
    expect(m.q(4)).toBeNull();
    expect(m.todo(1)).toEqual([{ text: "就業規則を読む", cite: "ind-side-01" }]);
    expect(m.todo(2)).toEqual([]);
    expect(m.p(2)).toBe(20);
    expect(m.p(1)).toBe(0);
    expect(m.e(2)).toEqual([35, 200, 20]);
    expect(m.rv(2)).toEqual(["pm:0", "a"]);
    expect(m.rv(3)).toBeNull();
    expect(m.sum(2)).toBe(true);
    expect(m.sum(5)).toBe(false);
    expect(m.ln(2)).toEqual(["perm", 3, null, null, "a"]);
    expect(m.rr(0)).toEqual([1, 0, 0]);
  });
  it("gives provisional titles when the tree has none", () => {
    expect(m.title(0)).toBe("今日");
    expect(m.title(1)).toBe("届け出て副業");
    expect(m.title(2)).toBe("全部可");
    expect(m.title(5)).toBe("all");
  });
  it("rejects duplicate keys and out-of-range numbers", () => {
    const dup: DevTree = { header, root: { k: "r", r: "r", m: 0, st: st(), kids: [{ k: "r", r: "a", m: 0, st: st(), kind: "keep" }] } };
    expect(() => fromDevTree(dup)).toThrow(/同じ鍵/);
    expect(() => m.role(99)).toThrow(RangeError);
    expect(() => m.child(0, 5)).toThrow(RangeError);
  });
});
