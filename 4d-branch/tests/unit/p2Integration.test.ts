// P2 の合わせ（W-int）: 保存した形から読んだ文書を地図の列で計算するか（I1）・全部の入れ替えは入れ物を写さず元に戻せる（I4）・
// 新しい地図の知らせの前の版で選んだ・見送ったカードの表（I5）・前の版で書き換えた本文の印（I9）・地図の数え方（I7）。
// ページの地図には小さい木（tests/fixtures/q-small）を版 7 として入れる
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { carryMapDoc, mapDocOf, mapForDoc } from "../../src/app/futureCache";
import { mapStats } from "../../src/app/pageFuture";
import type { MapData } from "../../src/deepmap/mapData";
import { countImpact } from "../../src/demo/impact";
import { decidedTable } from "../../src/model/releaseNotes";
import type { DocData, GNode } from "../../src/model/types";
import { decodeStored, setThinBaseline, storedMapShaped, thinBaselineDoc, toStored } from "../../src/persist/codec";
import { PREV_BODY_META } from "../../src/persist/legacyMap";
import { Store } from "../../src/store/store";
import { ACCOUNT_R6_RAW } from "./helpers/legacyCheck";
import { loadQSmall } from "./helpers/qSmall";
import { r6Bundle } from "./helpers/r6";

let page: MapData;
const AT = "2026-11-19T03:00:00.000Z";

beforeAll(async () => {
  const q = await loadQSmall();
  page = { ...q, header: { ...q.header, release: 7 } } as MapData;
});

afterEach(() => setThinBaseline(null));

/** 保存した形に書いて読み直す */
const roundTrip = (doc: DocData): DocData => decodeStored(JSON.parse(JSON.stringify(toStored(doc)))).doc;

/** 地図の手（今日の次の判断の手）の 1 枚 */
const firstMove = (doc: DocData): GNode => Object.values(doc.nodes).find((n) => n.meta?.key && String(n.meta.key).split(".").length === 2)!;

describe("保存した形から読んだ文書を、地図を組み立てたままの文書として覚える（W-app の I1）", () => {
  it("状態・題名・本文だけを変えた文書は組み立てたまま。見込みを直した・カードを消した・地図のカードに線をつないだ文書は違う", () => {
    setThinBaseline(page);
    const base = thinBaselineDoc({ at: AT });
    expect(storedMapShaped(roundTrip(base))).toBe(true);
    const mv = firstMove(base);
    // 状態と題名と本文
    const picked: DocData = { ...base, nodes: { ...base.nodes, [mv.id]: { ...mv, status: "active", title: `${mv.title}（自分の言葉）`, body: "メモ" } } };
    const d1 = roundTrip(picked);
    expect(storedMapShaped(d1)).toBe(true);
    expect(mapForDoc(d1)).toBe(page);
    // 見込みを直した（線の meta）
    const e = Object.values(base.edges).find((x) => x.target === mv.id)!;
    const prob: DocData = { ...base, edges: { ...base.edges, [e.id]: { ...e, meta: { ...e.meta, prob: 77 } } } };
    expect(storedMapShaped(roundTrip(prob))).toBe(false);
    // カードを消した
    const nodes = { ...base.nodes };
    delete nodes[mv.id];
    const edges = { ...base.edges };
    for (const id of Object.keys(edges)) if (edges[id]!.target === mv.id || edges[id]!.source === mv.id) delete edges[id];
    expect(storedMapShaped(roundTrip({ ...base, nodes, edges }))).toBe(false);
    // 前の版の文書から引き上げた文書（当て直した物）は、覚えない
    const up = decodeStored(JSON.parse(ACCOUNT_R6_RAW));
    expect(up.upgrade).toBeDefined();
    expect(storedMapShaped(up.doc)).toBe(false);
  });

  it("ストアに入れた後の文書（ストアが写した物）も同じ地図の文書として覚える", () => {
    setThinBaseline(page);
    const d = roundTrip(thinBaselineDoc({ at: AT }));
    const store = new Store({ ...d, nodes: {}, edges: {} } as DocData);
    expect(store.replaceDoc(d, "読み込む", carryMapDoc(d))).toBe(true);
    expect(store.doc).not.toBe(d);
    expect(mapDocOf(store.doc)).toBe(page);
  });
});

describe("全部の入れ替えは入れ物を 1 回だけ写し、元に戻す・やり直すは写さずに同じ中身に戻る（W-app の I4）", () => {
  it("入れ替え → 編集 → 元に戻す ×2 → やり直す ×2", () => {
    setThinBaseline(page);
    const a = thinBaselineDoc({ at: AT });
    const b = roundTrip(a);
    const mv = firstMove(b);
    const store = new Store(a);
    const nodesA = a.nodes;
    expect(store.replaceDoc(b, "別の端末の内容を読み込む")).toBe(true);
    // 渡した文書は変えない（入れ物も更新時刻も）
    expect(store.doc.nodes).not.toBe(b.nodes);
    expect(b.updatedAt).toBe(a.updatedAt);
    store.transact("これにする", (tx) => tx.updateNode(mv.id, { status: "active" }));
    expect(store.doc.nodes[mv.id]!.status).toBe("active");
    store.undo();
    expect(store.doc.nodes[mv.id]!.status).toBe("open");
    store.undo();
    expect(store.doc.nodes).toBe(nodesA);
    expect(Object.keys(store.doc.nodes).length).toBe(Object.keys(a.nodes).length);
    store.redo();
    expect(store.doc.nodes[mv.id]!.status).toBe("open");
    store.redo();
    expect(store.doc.nodes[mv.id]!.status).toBe("active");
    // 渡した文書・前の文書（元に戻した先）は、その後の編集で書き換わっていない
    expect(b.nodes[mv.id]!.status).toBe("open");
    expect(nodesA[mv.id]!.status).toBe("open");
  });
});

describe("新しい地図の知らせ: 前の版で選んだ・見送ったカード（W-app の I5）と、前の版で書き換えた本文（I9）", () => {
  it("引き上げの数に、選んだ・見送ったカードの鍵の読み替えがあり、書き換えた本文には印がある", () => {
    setThinBaseline(page);
    const up = decodeStored(JSON.parse(ACCOUNT_R6_RAW));
    const decided = up.upgrade!.legacy!.decided ?? [];
    expect(decided.length).toBe(up.upgrade!.legacy!.kept.picks + up.upgrade!.legacy!.kept.drops + up.upgrade!.legacy!.moved.picks + up.upgrade!.legacy!.moved.drops);
    for (const c of decided) {
      expect(["active", "done", "dropped"]).toContain(c.status);
      expect(page.indexOfKey(c.to)).toBeGreaterThan(0);
    }
    const marked = Object.values(up.doc.nodes).filter((n) => n.meta?.[PREV_BODY_META] === true);
    expect(marked.length).toBeGreaterThan(0);
    for (const n of marked) expect(n.body.trim().length).toBeGreaterThan(0);
    // 薄い形に書いて読み直しても印は残る
    expect(Object.values(roundTrip(up.doc).nodes).filter((n) => n.meta?.[PREV_BODY_META] === true).length).toBe(marked.length);
  });

  it("差の表は、向きか同じ判断の手の中の順位が変わった物だけ", () => {
    const before = new Map([
      ["r.a.x", 5],
      ["r.a.y", 3],
      ["r.a.z", -2],
      ["r.b.p", 4],
    ]);
    const now: Record<string, { delta: number | null; siblings: Array<{ key: string; delta: number | null }> }> = {
      "r.a.x": { delta: 6, siblings: [{ key: "r.a.x", delta: 6 }, { key: "r.a.y", delta: 2 }, { key: "r.a.z", delta: 0 }] },
      "r.a.y": { delta: -1, siblings: [{ key: "r.a.x", delta: 6 }, { key: "r.a.y", delta: -1 }, { key: "r.a.z", delta: 0 }] },
      "r.q.p": { delta: 4, siblings: [{ key: "r.q.p", delta: 4 }, { key: "r.q.o", delta: 9 }] },
    };
    const rows = decidedTable(
      [
        { from: "r.a.x", to: "r.a.x", status: "active" },
        { from: "r.a.y", to: "r.a.y", status: "dropped" },
        { from: "r.b.p", to: "r.q.p", status: "active" },
      ],
      before,
      (k) => now[k] ?? null,
    );
    expect(rows.map((r) => [r.key, r.signChanged, r.rankChanged, r.rankBefore, r.rankAfter])).toEqual([
      ["r.a.y", true, true, 2, 3],
      ["r.q.p", false, true, 1, 2],
    ]);
  });
});

describe("地図の数え方（未来の道筋を開く前の確認: W-app の I7）", () => {
  it("版 6 の数え方（countImpact）と同じ決まり: 小さい木で判断・手・行き先の数がそろう", () => {
    const s = mapStats(page);
    expect(s.nodes).toBe(page.n);
    let a = 0;
    let e = 0;
    for (let i = 0; i < page.n; i++) {
      if (page.role(i) === "a") a++;
      if (page.role(i) === "e") e++;
    }
    expect([s.options, s.ends]).toEqual([a, e]);
    expect(s.decisions).toBeGreaterThan(0);
    expect(s.forks).toBeGreaterThanOrEqual(s.decisions);
    // 版 6 の束でも、同じ数え方の関数が動く（比べ物）
    expect(countImpact(r6Bundle()).decisions).toBeGreaterThan(0);
  });
});
