// 版をまたいだ当て直し（薄い形: thinMap.ts の rebaseThin）で、利用者の物を黙って落とさない（見直し loss-4）。
// 前は、ページの地図に鍵が無くなったカードへの同梱の線の直した見込み・説明（数えるだけで、どの知らせにも出なかった）、
// そのカードの期限・種類・プロジェクトだけの書き換え、残ったカードで枠が無くなったチェック（文は was.kt にあるのに）を落としていた。
//   今: 線の先のカードを「前の版で決めたこと」に残して見込み・説明を meta.prevEdge に（書き手は直した線の先のカードに印を付けるので、
//   題名つきで残せる）、期限・種類・プロジェクト・シナリオも利用者の物、枠の無いチェックは文ごと足す。知らせは残した数・残せなかった数を言う
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";
import type { DevTreeNode, MapData } from "../../src/deepmap/mapData";
import { makeProject } from "../../src/model/schema";
import type { DocData, GNode } from "../../src/model/types";
import { decodeStored, setThinBaseline, thinBaselineDoc, toStored, upgradeNotice, type StoredDoc, type ThinSection } from "../../src/persist/codec";
import { Store } from "../../src/store/store";
import { loadQSmall, loadQSmallDevTree } from "./helpers/qSmall";

function addTodo(tree: { root: DevTreeNode }, dropCiteOn?: string): void {
  let k = 0;
  const walk = (n: DevTreeNode): void => {
    if (n.r === "a") {
      n.todo = [
        { text: `届け出の紙を出す ${k % 17}`, cite: `ind-side-d${String(k % 40).padStart(2, "0")}` },
        { text: `総務に聞く ${k % 7}`, cite: `sd-${k % 11}` },
      ];
      if (n.k === dropCiteOn) n.todo = n.todo.slice(0, 1);
      k++;
    }
    for (const c of n.kids ?? []) walk(c);
  };
  walk(tree.root);
}

let q7: MapData;
let q8: MapData;
beforeAll(async () => {
  const q = await loadQSmall();
  q7 = { ...q, header: { ...q.header, release: 7 } } as MapData;
  // 版 8: 同じ木から最初の手「今すぐ独立」（r.ind_quit）を外した物（その下の鍵が無くなる）
  const tree = await loadQSmallDevTree();
  tree.root.kids = tree.root.kids!.filter((k) => k.k !== "r.ind_quit");
  tree.header = { ...tree.header, release: 8, hash: `${tree.header.hash.slice(0, 12)}zz` };
  q8 = fromDevTree(tree);
});
afterEach(() => setThinBaseline(null));

const AT = "2026-11-19T03:04:05.006Z";
const keyOf = (n: GNode | undefined): string | null => (typeof n?.meta?.key === "string" ? n.meta.key : null);

describe("版をまたぐと鍵が無くなるカードの、利用者の物（loss-4）", () => {
  it("直した見込みと線の説明・期限・種類・プロジェクト・シナリオだけを変えたカードも「前の版で決めたこと」に残し、知らせで数を言う", () => {
    setThinBaseline(q7);
    const store = new Store(thinBaselineDoc({ at: AT }));
    const doc = store.doc;
    const under = (n: GNode) => (keyOf(n) ?? "").startsWith("r.ind_quit.");
    const gone = Object.values(doc.nodes).filter(under);
    const probEdge = Object.values(doc.edges).find((e) => typeof e.meta.prob === "number" && under(doc.nodes[e.target]!))!;
    const others = gone.filter((n) => n.id !== probEdge.target);
    const [c1, c2, c3, c4] = [others[0]!, others[1]!, others[2]!, others[3]!];
    const proj = makeProject({ name: "家計の見直し" });
    const scen = doc.scenarioOrder[0]!;
    store.transact("edits", (tx) => {
      tx.updateEdge(probEdge.id, { meta: { ...probEdge.meta, prob: 12 }, label: "自分の見立て: ほぼ無い" });
      tx.updateNode(c1.id, { time: { ...c1.time, due: "2028-04-30" } });
      tx.updateNode(c2.id, { type: c2.type === "result" ? "goal" : "result" });
      tx.addProject(proj);
      tx.updateNode(c3.id, { projectIds: [proj.id] });
      tx.updateNode(c4.id, { scenarioIds: [scen] });
    });
    const stored = JSON.parse(JSON.stringify(toStored(store.doc))) as StoredDoc & { maps: ThinSection[] };
    const sec = stored.maps[0]!;
    // 書き手は、直した線の先のカードに印（題名・短い名前・月）を付ける
    expect(sec.e?.[keyOf(doc.nodes[probEdge.target])!]).toBeDefined();
    expect(sec.pin?.[keyOf(doc.nodes[probEdge.target])!]?.t).toBe(doc.nodes[probEdge.target]!.title);
    // 版 8 のページで読む
    setThinBaseline(q8);
    const d = decodeStored(stored);
    const out = d.doc as DocData;
    expect(d.upgrade!.droppedEdges).toBe(0);
    expect(d.upgrade!.detached).toBe(5);
    const byPrev = (k: string | null) => Object.values(out.nodes).find((n) => n.meta.prevKey === k);
    const target = byPrev(keyOf(doc.nodes[probEdge.target]))!;
    expect(target.title).toBe(doc.nodes[probEdge.target]!.title);
    expect(target.meta.prevEdge).toMatchObject({ prob: 12, label: "自分の見立て: ほぼ無い" });
    expect(byPrev(keyOf(c1))!.time.due).toBe("2028-04-30");
    expect(byPrev(keyOf(c2))!.type).toBe(c2.type === "result" ? "goal" : "result");
    expect(byPrev(keyOf(c3))!.projectIds).toEqual([proj.id]);
    expect(byPrev(keyOf(c4))!.scenarioIds).toEqual([scen]);
    const text = upgradeNotice(d.upgrade!, "boot");
    expect(text).toContain("地図から無くなったカード 5 枚");
    expect(text).toContain("「前の版で決めたこと」に残しました");
    expect(text).not.toContain("0 枚");
    expect(upgradeNotice(d.upgrade!, "import")).toContain("地図から無くなったカード 5 枚");
  });

  it("印の無い古い書き方（直した線の先のカードの題名が分からない）は、残せなかった線の変更として数えて言う", () => {
    setThinBaseline(q7);
    const store = new Store(thinBaselineDoc({ at: AT }));
    const doc = store.doc;
    const probEdge = Object.values(doc.edges).find((e) => typeof e.meta.prob === "number" && (keyOf(doc.nodes[e.target]) ?? "").startsWith("r.ind_quit."))!;
    store.transact("見込み", (tx) => tx.updateEdge(probEdge.id, { meta: { ...probEdge.meta, prob: 12 } }));
    const stored = JSON.parse(JSON.stringify(toStored(store.doc))) as StoredDoc & { maps: ThinSection[] };
    delete stored.maps[0]!.pin;
    setThinBaseline(q8);
    const d = decodeStored(stored);
    expect(d.upgrade!.droppedEdges).toBe(1);
    expect(upgradeNotice(d.upgrade!, "boot")).toContain("残せなかった線の変更 1 本");
  });

  it("残ったカードで枠が無くなったチェックは、チェックした項目として文ごと足す（数えて落とさない）", async () => {
    const t7 = await loadQSmallDevTree();
    addTodo(t7);
    const m7 = fromDevTree(t7);
    setThinBaseline(m7);
    const store = new Store(thinBaselineDoc({ at: AT }));
    const card = Object.values(store.doc.nodes).find((n) => (keyOf(n) ?? "").startsWith("r.keep.") && n.conditions.length === 2)!;
    store.transact("チェック", (tx) => tx.updateNode(card.id, { conditions: card.conditions.map((c) => ({ ...c, met: true })) }));
    const stored = JSON.parse(JSON.stringify(toStored(store.doc))) as StoredDoc & { maps: ThinSection[] };
    expect(stored.maps[0]!.n![keyOf(card)!]).toMatchObject({ was: { kt: card.conditions.map((c) => c.text) } });
    const t8 = await loadQSmallDevTree();
    addTodo(t8, keyOf(card)!);
    t8.header = { ...t8.header, release: m7.header.release + 1, hash: `${t8.header.hash.slice(0, 12)}yy` };
    setThinBaseline(fromDevTree(t8));
    const d = decodeStored(stored);
    const after = Object.values(d.doc.nodes).find((n) => keyOf(n) === keyOf(card))!;
    expect(after.conditions).toHaveLength(2);
    expect(after.conditions.every((c) => c.met)).toBe(true);
    expect(after.conditions.map((c) => c.text)).toEqual(card.conditions.map((c) => c.text));
    expect(new Set(after.conditions.map((c) => c.id)).size).toBe(2);
    expect(d.upgrade!.lostTicks).toBe(0);
    // 当て直した文書は、新しい版のページで書けて読める（足した項目は書き換えとして残る）
    const back = decodeStored(JSON.parse(JSON.stringify(toStored(d.doc)))).doc;
    expect(Object.values(back.nodes).find((n) => keyOf(n) === keyOf(card))!.conditions.map((c) => c.text)).toEqual(card.conditions.map((c) => c.text));
  });
});
