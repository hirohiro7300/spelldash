import { describe, expect, it } from "vitest";
import { buildDemoDoc } from "../../src/demo/demo";
import { buildWishlistDoc, countWishes, type WishData, type WishItem } from "../../src/demo/wishlist";
import { buildWishlist, wishlistData } from "../../src/demo/wishlistBundle";
import { normalizeDoc } from "../../src/model/schema";
import { mergeDocs } from "../../src/persist/io";
import type { DocData, ID } from "../../src/model/types";

const TODAY = new Date(2026, 10, 10); // 2026-11-10

/** 小さな見本: 事業 1 領域（デモと同じ名前）と旅 1 領域、それぞれテーマ 2 個 */
function sample(): WishData {
  const items = (key: string, n: number): WishItem[] =>
    Array.from({ length: n }, (_, i) => {
      const id = `${key}-${String(i + 1).padStart(2, "0")}`;
      const horizon = (["now", "y1", "y1", "y3", "y5", "y10"] as const)[i % 6]!;
      // 2 件おきに 1 つ前を先にやる（道筋）。最後は循環を混ぜる
      const after = i % 2 === 1 ? [`${key}-${String(i).padStart(2, "0")}`] : [];
      return [id, i % 3 === 0 ? "goal" : "action", `${key} のやりたいこと ${i + 1}`, `本文 ${i + 1}`, horizon, ["タグ"], after, i % 3 === 0 ? ["3 か月続ける"] : []];
    });
  const theme = (key: string, n: number) => {
    const its = items(key, n);
    // 01 → 02 → 03 → 01 の輪（入口の無い輪）。深さの計算が止まり、見出しから入れること
    if (n >= 3) {
      its[0]![6] = [`${key}-03`];
      its[2]![6] = [`${key}-02`];
    }
    return {
      key,
      name: `テーマ ${key}`,
      hubTitle: `${key} を進める`,
      hubBody: `${key} の見出し。`,
      items: its,
      branches: [[`${key}-b1`, "A か、B か", "観点。", "y1", [`${key}-01`], ["材料"], [[`${key}-02`, "A のとき", "base"], [`${key}-04`, "B のとき", ""]]]] as WishData["areas"][number]["themes"][number]["branches"],
    };
  };
  return {
    v: 1,
    areas: [
      { key: "spell", name: "SpellDash事業", color: "#FF7A59", description: "SpellDash を事業にする。", themes: [theme("spell-product", 8), theme("spell-growth", 5)] },
      { key: "travel", name: "旅・体験", color: "#FB923C", description: "旅に出る。", themes: [theme("travel-japan", 14), theme("travel-asia", 3)] },
    ],
    links: [
      ["spell-product-02", "travel-japan-05", "supports", "相乗効果"],
      ["travel-japan-06", "spell-growth-03", "condition", "旅費が貯まったら"],
      ["missing-01", "spell-growth-03", "blocks", "無い id は飛ばす"],
      ["spell-product-02", "travel-japan-05", "supports", "重複は 1 本"],
    ],
  };
}

function reachable(doc: DocData, roots: ID[]): Set<ID> {
  const out = new Map<ID, ID[]>();
  for (const e of Object.values(doc.edges)) out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
  const seen = new Set<ID>(roots);
  const stack = [...roots];
  while (stack.length) for (const t of out.get(stack.pop()!) ?? []) if (!seen.has(t)) (seen.add(t), stack.push(t));
  return seen;
}

describe("やりたいことリストの組み立て", () => {
  const data = sample();
  const doc = buildWishlistDoc(data, TODAY);
  const nodes = Object.values(doc.nodes);
  const wishCount = countWishes(data);

  it("やりたいこと・分岐・テーマの見出し・領域の入口が、すべてノードになる", () => {
    expect(wishCount).toBe(8 + 5 + 14 + 3);
    const themes = data.areas.flatMap((a) => a.themes);
    expect(nodes.length).toBe(wishCount + themes.length /* 分岐 */ + themes.length /* 見出し */ + data.areas.length);
    expect(nodes.filter((n) => n.type === "branch").length).toBe(themes.length);
  });

  it("検証を通しても何も直されない（取り込みと同じ検証）", () => {
    const { report, doc: normalized } = normalizeDoc(JSON.parse(JSON.stringify(doc)));
    expect(report.warnings).toEqual([]);
    expect(Object.keys(normalized.nodes).length).toBe(nodes.length);
    expect(Object.keys(normalized.edges).length).toBe(Object.keys(doc.edges).length);
  });

  it("すべてのノードが、領域の入口からたどれる", () => {
    const roots = nodes.filter((n) => n.id.startsWith("n_w_root_")).map((n) => n.id);
    expect(roots.length).toBe(2);
    expect(reachable(doc, roots).size).toBe(nodes.length);
  });

  it("同じ位置に重なるノードが無い", () => {
    const at = new Set(nodes.map((n) => `${n.x},${n.y}`));
    expect(at.size).toBe(nodes.length);
  });

  it("横は時間の見通しの順（今すぐ → いつか）、縦は領域ごとの帯", () => {
    const x = (local: string) => doc.nodes[`n_w_${local.replace(/[^A-Za-z0-9]/g, "_")}`]!.x;
    const y = (local: string) => doc.nodes[`n_w_${local.replace(/[^A-Za-z0-9]/g, "_")}`]!.y;
    // travel-japan: 01 now, 02 y1, 04 y3, 05 y5, 06 y10
    expect(x("travel-japan-01")).toBeLessThan(x("travel-japan-02"));
    expect(x("travel-japan-02")).toBeLessThan(x("travel-japan-04"));
    expect(x("travel-japan-04")).toBeLessThan(x("travel-japan-05"));
    expect(x("travel-japan-05")).toBeLessThan(x("travel-japan-06"));
    const spellMaxY = Math.max(...nodes.filter((n) => n.projectIds.includes("p_spelldash")).map((n) => n.y));
    expect(y("travel-japan-01")).toBeGreaterThan(spellMaxY);
  });

  it("期限は読み込む日から数え、今すぐ = 1〜3 か月先、いつか = 5〜10 年先", () => {
    const due = (local: string) => doc.nodes[`n_w_${local.replace(/[^A-Za-z0-9]/g, "_")}`]!.time.due!;
    for (const id of ["travel-japan-01", "travel-japan-07", "travel-japan-13"]) {
      expect(due(id) >= "2026-12-31" && due(id) <= "2027-02-28").toBe(true);
    }
    for (const id of ["travel-japan-06", "travel-japan-12"]) expect(due(id) >= "2032-01-31" && due(id) <= "2036-12-31").toBe(true);
    // 月の末日にそろう
    expect(due("travel-japan-01")).toMatch(/-(28|29|30|31)$/);
    // 1 年後に読み込めば 1 年後ろへずれる
    const later = buildWishlistDoc(data, new Date(2027, 10, 1));
    expect(later.nodes["n_w_travel_japan_01"]!.time.due! > "2027-11-30").toBe(true);
  });

  it("分岐から選択肢へは条件付きの接続、仕事の道筋の選択肢はシナリオに結ぶ", () => {
    const b = "n_w_spell_product_b1";
    const out = Object.values(doc.edges).filter((e) => e.source === b);
    expect(out.map((e) => e.relation)).toEqual(["condition", "condition"]);
    const toA = out.find((e) => e.target === "n_w_spell_product_02")!;
    expect(toA.condition).toBe("A のとき");
    expect(toA.scenarioIds).toEqual(["s_balance"]);
    expect(out.find((e) => e.target === "n_w_spell_product_04")!.scenarioIds).toEqual([]);
    // 分岐の前にやること → 分岐
    expect(Object.values(doc.edges).some((e) => e.source === "n_w_spell_product_01" && e.target === b && e.relation === "leads")).toBe(true);
  });

  it("領域をまたぐつながり: 無い id は飛ばし、同じ向きの重複は 1 本、条件はラベルではなく条件に入る", () => {
    const cross = Object.values(doc.edges).filter((e) => e.relation === "supports" || (e.relation === "condition" && e.source === "n_w_travel_japan_06"));
    expect(cross.length).toBe(2);
    const cond = cross.find((e) => e.relation === "condition")!;
    expect(cond.condition).toBe("旅費が貯まったら");
    expect(cond.label).toBe("");
    expect(Object.values(doc.edges).some((e) => e.relation === "blocks")).toBe(false);
  });

  it("デモに追加すると、同じ名前の事業のプロジェクトと 3 つのシナリオがまとまる", () => {
    const res = mergeDocs(buildDemoDoc(), doc);
    expect(res.reusedProjects).toBe(1);
    expect(res.reusedScenarios).toBe(3);
    expect(res.added.nodes).toBe(nodes.length);
  });

  it("先にやることの循環があっても、組み立ては止まらない", () => {
    expect(doc.nodes["n_w_spell_growth_01"]).toBeDefined();
  });

  it("英数字と _ にそろえると同じになる id（a-01 と a_01）も、別のノードとして残り、つながりも別々に付く", () => {
    const item = (id: string, title: string): WishItem => [id, "action", title, "本文", "now", ["タグ"], [], []];
    const d: WishData = {
      v: 1,
      areas: [
        {
          key: "x",
          name: "X",
          color: "#888888",
          description: "x を進める。",
          themes: [
            { key: "t-1", name: "T1", hubTitle: "t1", hubBody: "見出し。", items: [item("a-01", "一"), item("a-02", "三")], branches: [] },
            { key: "t_1", name: "T2", hubTitle: "t2", hubBody: "見出し。", items: [item("a_01", "二")], branches: [] },
          ],
        },
      ],
      links: [["a-02", "a_01", "supports", "相乗"]],
    };
    const built = buildWishlistDoc(d, TODAY);
    const byTitle = new Map(Object.values(built.nodes).map((n) => [n.title, n.id]));
    expect(byTitle.get("一")).toBeDefined();
    expect(byTitle.get("二")).toBeDefined();
    expect(byTitle.get("一")).not.toBe(byTitle.get("二"));
    // 見出し（t-1 と t_1）も 2 つ
    expect(Object.values(built.nodes).filter((n) => n.title === "t1" || n.title === "t2").length).toBe(2);
    const link = Object.values(built.edges).find((e) => e.relation === "supports")!;
    expect(link.source).toBe(byTitle.get("三"));
    expect(link.target).toBe(byTitle.get("二"));
    expect(normalizeDoc(JSON.parse(JSON.stringify(built))).report.warnings).toEqual([]);
  });
});

describe("同梱のやりたいことリスト", () => {
  const data = wishlistData();

  it("やりたいことはちょうど 2,000 件、12 の領域・100 を超えるテーマ", () => {
    expect(countWishes(data)).toBe(2000);
    expect(data.areas.length).toBe(12);
    expect(data.areas.reduce((n, a) => n + a.themes.length, 0)).toBeGreaterThanOrEqual(100);
  });

  it("id は重ならず、先にやること・選択肢・つながりは、すべてあるやりたいことを指す", () => {
    const ids = new Set<string>();
    for (const a of data.areas)
      for (const t of a.themes) {
        for (const it of t.items) {
          expect(ids.has(it[0])).toBe(false);
          ids.add(it[0]);
        }
        for (const b of t.branches) {
          expect(ids.has(b[0])).toBe(false);
          ids.add(b[0]);
        }
      }
    for (const a of data.areas)
      for (const t of a.themes) {
        const local = new Set([...t.items.map((i) => i[0]), ...t.branches.map((b) => b[0])]);
        for (const it of t.items) for (const p of it[6]) expect(local.has(p)).toBe(true);
        for (const b of t.branches) {
          expect(b[6].length).toBeGreaterThanOrEqual(2);
          for (const [to] of b[6]) expect(local.has(to)).toBe(true);
        }
      }
    for (const [from, to] of data.links) {
      expect(ids.has(from)).toBe(true);
      expect(ids.has(to)).toBe(true);
    }
  });

  it("タイトルは空でなく短く、同じタイトルが二度出ない。本文・タグがあり、テーマごとに分岐が 1〜3 個", () => {
    const items = data.areas.flatMap((a) => a.themes.flatMap((t) => t.items));
    for (const it of items) {
      expect(it[2].trim().length, it[0]).toBeGreaterThan(0);
      expect([...it[2]].length, `${it[0]} ${it[2]}`).toBeLessThanOrEqual(40);
      expect(it[3].trim().length, it[0]).toBeGreaterThan(0);
      expect(it[5].length, it[0]).toBeGreaterThanOrEqual(1);
    }
    const titles = items.map((i) => i[2]);
    expect(new Set(titles).size).toBe(titles.length);
    for (const a of data.areas)
      for (const t of a.themes) {
        expect(t.branches.length, t.key).toBeGreaterThanOrEqual(1);
        expect(t.branches.length, t.key).toBeLessThanOrEqual(3);
      }
  });

  it("組み立てて検証しても直すところが無く、すべてのノードが入口からたどれる", () => {
    const { pv, stats } = buildWishlist(TODAY);
    expect(pv.report.warnings).toEqual([]);
    expect(stats.wishes).toBe(2000);
    const all = Object.values(pv.doc.nodes);
    const roots = all.filter((n) => n.id.startsWith("n_w_root_")).map((n) => n.id);
    expect(reachable(pv.doc, roots).size).toBe(all.length);
    expect(new Set(all.map((n) => `${n.x},${n.y}`)).size).toBe(all.length);
  });
});
