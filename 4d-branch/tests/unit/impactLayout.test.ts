import { describe, expect, it } from "vitest";
import { Commands } from "../../src/app/commands";
import { DEFAULT_PREFS, UiState } from "../../src/app/uiState";
import { ViewModel } from "../../src/app/viewModel";
import { buildImpactDoc } from "../../src/demo/impact";
import { futureData } from "../../src/demo/futureBundle";
import { IMPACT_GROUP_GAP, IMPACT_ROW, IMPACT_X, compareImpactKids, impactColX, outlineLayout } from "../../src/model/impactLayout";
import { NODE_H, NODE_W } from "../../src/model/constants";
import { makeNode } from "../../src/model/schema";
import type { DocData, ID } from "../../src/model/types";
import { Store } from "../../src/store/store";

const TODAY = new Date(2026, 10, 18);
const data = futureData();
const doc = buildImpactDoc(data, TODAY, "t");

// 同梱データの木（親 → 子。並びは作ったときの順位）
const ids = Object.keys(doc.nodes);
const kidsOf = new Map<ID, ID[]>();
for (const id of ids) kidsOf.set(id, []);
for (const e of Object.values(doc.edges)) kidsOf.get(e.source)!.push(e.target);
for (const list of kidsOf.values()) list.sort((a, b) => compareImpactKids(doc.nodes[a]!, doc.nodes[b]!));
const root = ids.find((id) => doc.nodes[id]!.meta.forecastRoot === true)!;
const branches = ids.filter((id) => kidsOf.get(id)!.length > 0);
const depthOf = new Map<ID, number>([[root, 0]]);
{
  const q = [root];
  for (let i = 0; i < q.length; i++) for (const k of kidsOf.get(q[i]!)!) (depthOf.set(k, depthOf.get(q[i]!)! + 1), q.push(k));
}

/** 開いているノードの組から、目次の形に並べる */
function layout(open: Set<ID>): Map<ID, { x: number; y: number }> {
  return outlineLayout(root, (id) => (open.has(id) ? kidsOf.get(id)! : []));
}

/** 重なり（中心の差が横 212 未満かつ縦 96 未満）を探す。縦の順に並べて、近い物だけ比べる */
function overlaps(pos: Map<ID, { x: number; y: number }>): Array<[ID, ID]> {
  const list = [...pos.entries()].sort((a, b) => a[1].y - b[1].y);
  const out: Array<[ID, ID]> = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length && list[j]![1].y - list[i]![1].y < NODE_H; j++) {
      if (Math.abs(list[j]![1].x - list[i]![1].x) < NODE_W) out.push([list[i]![0], list[j]![0]]);
    }
  }
  return out;
}

/** 決まった種から作る乱数（同じ種なら同じ並び） */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
    s ^= s + Math.imul(s ^ (s >>> 7), 0x297a4d3b);
    return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
  };
}

function randomOpen(seed: number): Set<ID> {
  const r = rng(seed);
  const p = 0.15 + r() * 0.8;
  const open = new Set<ID>([root]);
  for (const id of branches) if (r() < p) open.add(id);
  return open;
}

const phoneDefault = new Set<ID>([root]);
const wideDefault = new Set<ID>([root, ...kidsOf.get(root)!]);
const allOpen = new Set<ID>(branches);

describe("3 年の分かれ道の並べ方（目次の形）", () => {
  it("最初の形（狭い画面・広い画面）・全部開いた形・決まった種の 200 通りで、カードが重ならない", () => {
    for (const open of [phoneDefault, wideDefault, allOpen]) expect(overlaps(layout(open))).toEqual([]);
    for (let seed = 1; seed <= 200; seed++) {
      const pos = layout(randomOpen(seed));
      const bad = overlaps(pos);
      expect(bad, `種 ${seed}`).toEqual([]);
    }
  });

  it("狭い画面の最初の形は今日と 10 の選択肢で、10 行（約 512 × 1,248）に収まる", () => {
    const pos = layout(phoneDefault);
    expect(pos.size).toBe(11);
    const ys = [...pos.values()].map((p) => p.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBe(9 * IMPACT_ROW);
    expect([...pos.values()].every((p) => p.x === 0 || p.x === IMPACT_X[1])).toBe(true);
  });

  it("全部開くと 1,724 枚すべてに位置があり、行き先は 975 行", () => {
    const pos = layout(allOpen);
    expect(pos.size).toBe(ids.length);
    const leafRows = new Set([...pos.entries()].filter(([id]) => kidsOf.get(id)!.length === 0).map(([, p]) => p.y));
    expect(leafRows.size).toBe(975);
  });

  it("開く・閉じるで、そのノード自身と、それより上のカードは動かない", () => {
    const r = rng(7);
    for (let t = 0; t < 120; t++) {
      const open = randomOpen(1000 + t);
      const before = layout(open);
      // 見えている、先のあるノードを 1 つ選んで開閉する
      const cands = [...before.keys()].filter((id) => kidsOf.get(id)!.length > 0 && id !== root);
      const n = cands[Math.floor(r() * cands.length)]!;
      const next = new Set(open);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      const after = layout(next);
      const y0 = before.get(n)!.y;
      expect(after.get(n), `開閉したノード ${n}`).toEqual(before.get(n));
      for (const [id, p] of before) if (p.y < y0) expect(after.get(id), `上のカード ${id}`).toEqual(p);
    }
  });

  it("親は最初の子と同じ行・列は深さの位置（IMPACT_X）・子を持つ兄弟の間は少し空く", () => {
    for (const open of [wideDefault, allOpen, randomOpen(42)]) {
      const pos = layout(open);
      for (const [id, p] of pos) {
        expect(p.x).toBe(impactColX(depthOf.get(id)!));
        const kids = open.has(id) ? kidsOf.get(id)! : [];
        if (kids.length) expect(p.y).toBe(pos.get(kids[0]!)!.y);
      }
    }
    expect(IMPACT_X).toEqual([0, 300, 700, 1000, 1400, 1700, 2100]);
    expect(impactColX(8)).toBe(2700);
    // 今日の選択肢をすべて開くと、選択肢の間に少し空きができる（前の選択肢の結果の行のあと）
    const pos = layout(wideDefault);
    const alts = kidsOf.get(root)!;
    const firstKids = kidsOf.get(alts[0]!)!.length;
    expect(pos.get(alts[1]!)!.y - pos.get(alts[0]!)!.y).toBe(firstKids * IMPACT_ROW + IMPACT_GROUP_GAP);
  });

  it("同じ入力なら同じ位置（決まった並べ方）", () => {
    for (const open of [allOpen, randomOpen(3), randomOpen(4)]) {
      const a = layout(open);
      const b = layout(new Set(open));
      expect([...b.entries()]).toEqual([...a.entries()]);
    }
  });

  it("後から足した子は、作ったときの子の後ろ（作った時刻の順）", () => {
    const gen = makeNode({ id: "g", title: "g", meta: { rank: 5 }, createdAt: "2026-11-01T00:00:00.000Z" });
    const genFirst = makeNode({ id: "f", title: "f", meta: { rank: 0 }, createdAt: "2026-11-02T00:00:00.000Z" });
    const userOld = makeNode({ id: "u1", title: "u1", createdAt: "2026-11-03T00:00:00.000Z" });
    const userNew = makeNode({ id: "u2", title: "u2", createdAt: "2026-11-04T00:00:00.000Z" });
    const sorted = [userNew, gen, userOld, genFirst].sort(compareImpactKids).map((n) => n.id);
    expect(sorted).toEqual(["f", "g", "u1", "u2"]);
  });

  it("循環・合流があっても止まり、2 つ目の親の下には置かない（最初にたどった所）", () => {
    const kids: Record<string, string[]> = { r: ["a", "b"], a: ["m"], b: ["m", "r"], m: ["a"] };
    const pos = outlineLayout("r", (id) => kids[id] ?? []);
    expect([...pos.keys()].sort()).toEqual(["a", "b", "m", "r"]);
    expect(pos.get("m")!.x).toBe(impactColX(2));
    expect(overlaps(pos)).toEqual([]);
  });

  it("入口からたどれない見えているノードは、入口の木の下に、その深さの列で並べる", () => {
    const pos = outlineLayout("r", (id) => (id === "r" ? ["a"] : []), [
      ["x", 3],
      ["a", 1],
    ]);
    expect(pos.get("a")).toEqual({ x: impactColX(1), y: 0 });
    expect(pos.get("x")).toEqual({ x: impactColX(3), y: IMPACT_ROW + IMPACT_GROUP_GAP });
  });
});

/** 同梱の文書を、アプリと同じ部品（ストア・見え方・操作）で開く */
function open(d: DocData = structuredClone(doc), narrow = false) {
  const store = new Store(d);
  const ui = new UiState(structuredClone(DEFAULT_PREFS));
  ui.persistPrefs = false;
  const vm = new ViewModel(store, ui);
  vm.narrow = () => narrow;
  const toasts: string[] = [];
  const cmd = new Commands(store, ui, vm, { toast: (t) => void toasts.push(t), viewCenter: () => ({ x: 0, y: 0 }), startEdit: () => undefined, reveal: () => undefined, confirm: async () => true });
  return { store, ui, vm, cmd, toasts };
}

/** 見えているノードの重ねる位置 */
function shown(vm: ViewModel): Map<ID, { x: number; y: number }> {
  vm.ensure();
  const out = new Map<ID, { x: number; y: number }>();
  for (const id of vm.drawNodes) out.set(id, { ...vm.posOf(id)! });
  return out;
}

describe("重ねる位置（vm.posOf）", () => {
  it("最初の形: 狭い画面は今日と 10 の選択肢、広い画面は選択肢も開いて結果まで。今日の位置は文書の位置のまま", () => {
    const phone = open(undefined, true);
    expect(phone.vm.drawNodes.length).toBe(0); // まだ計算していない
    const p = shown(phone.vm);
    expect(p.size).toBe(11);
    expect(p.get(root)).toEqual({ x: doc.nodes[root]!.x, y: doc.nodes[root]!.y });
    for (const k of kidsOf.get(root)!) expect(phone.vm.node(k).collapsedCount).toBeGreaterThan(0);
    const wide = shown(open().vm);
    expect(wide.size).toBe(11 + kidsOf.get(root)!.reduce((s, k) => s + kidsOf.get(k)!.length, 0));
    expect(overlaps(wide)).toEqual([]);
  });

  it("全部開いても重ならず、入口が動けば一緒に動く（位置だけの変更でも）", () => {
    const { vm, cmd, store } = open();
    cmd.expandAll();
    const a = shown(vm);
    expect(a.size).toBe(ids.length);
    expect(overlaps(a)).toEqual([]);
    // 入口を動かす（古いタブ・書き出しの位置は文書のまま。重ねる位置は入口からの相対）
    store.transact("入口を動かす", (tx) => tx.updateNode(root, { x: doc.nodes[root]!.x + 500, y: doc.nodes[root]!.y - 300 }));
    const b = shown(vm);
    for (const [id, p] of a) expect(b.get(id)).toEqual({ x: p.x + 500, y: p.y - 300 });
  });

  it("開いて閉じると同じ位置に戻り、開いたノードと上のカードは動かない", () => {
    const { vm, cmd } = open(undefined, true);
    const before = shown(vm);
    const alt = kidsOf.get(root)![3]!;
    cmd.toggleCollapse([alt]);
    const mid = shown(vm);
    expect(mid.get(alt)).toEqual(before.get(alt));
    for (const [id, p] of before) if (p.y <= before.get(alt)!.y) expect(mid.get(id)).toEqual(p);
    for (const k of kidsOf.get(alt)!) expect(mid.has(k)).toBe(true);
    cmd.toggleCollapse([alt]);
    expect([...shown(vm).entries()].sort()).toEqual([...before.entries()].sort());
  });

  it("後から足した選択肢は、作った選択肢の後ろに並ぶ（親が閉じていれば見え方で開く）", () => {
    const { vm, cmd, store } = open(undefined, true);
    const alt = kidsOf.get(root)![0]!;
    const state = kidsOf.get(alt)![0]!;
    // 選択肢を開いて、閉じている結果（3 か月後の判断）を見える所に出してから、その下に足す
    cmd.toggleCollapse([alt]);
    expect(vm.node(state).hidden).toBe(false);
    expect(vm.isCollapsed(state)).toBe(true);
    const before = store.history.undoStack.length;
    const id = cmd.createNode("action", { x: 0, y: 0 }, { from: [state], exact: true, title: "自分で足した手" })!;
    expect(store.history.undoStack.length).toBe(before + 1); // 足したこと自体は文書の変更
    expect(store.doc.nodes[state]!.collapsed).toBe(false);
    const pos = shown(vm);
    const sibs = kidsOf.get(state)!;
    expect(pos.has(id)).toBe(true);
    for (const s of sibs) expect(pos.get(s)!.y).toBeLessThan(pos.get(id)!.y);
    expect(overlaps(pos)).toEqual([]);
  });
});
