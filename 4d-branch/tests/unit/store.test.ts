import { describe, expect, it } from "vitest";
import { createEmptyDoc, makeEdge, makeNode, makeProject, makeScenario } from "../../src/model/schema";
import { Store } from "../../src/store/store";

function setup() {
  const store = new Store(createEmptyDoc());
  const a = makeNode({ title: "A" });
  const b = makeNode({ title: "B" });
  store.transact("作成", (tx) => {
    tx.addNode(a);
    tx.addNode(b);
    tx.addEdge(makeEdge({ source: a.id, target: b.id }));
  });
  return { store, a, b };
}

describe("Store と履歴", () => {
  it("Undo/Redo で作成・削除が戻る（削除はつながる接続も戻る）", () => {
    const { store, a } = setup();
    expect(Object.keys(store.doc.edges)).toHaveLength(1);
    store.transact("削除", (tx) => tx.deleteNode(a.id));
    expect(store.doc.nodes[a.id]).toBeUndefined();
    expect(Object.keys(store.doc.edges)).toHaveLength(0);
    store.undo();
    expect(store.doc.nodes[a.id]).toBeDefined();
    expect(Object.keys(store.doc.edges)).toHaveLength(1);
    store.redo();
    expect(store.doc.nodes[a.id]).toBeUndefined();
    store.undo();
    store.undo();
    expect(Object.keys(store.doc.nodes)).toHaveLength(0);
    expect(store.history.canUndo).toBe(false);
  });

  it("同じ鍵の続けての入力は 1 回の Undo で戻る", () => {
    const { store, a } = setup();
    for (const t of ["広", "広告", "広告運用"]) store.transact("タイトル", (tx) => tx.updateNode(a.id, { title: t }), { coalesce: `title:${a.id}` });
    expect(store.doc.nodes[a.id]!.title).toBe("広告運用");
    store.undo();
    expect(store.doc.nodes[a.id]!.title).toBe("A");
    store.redo();
    expect(store.doc.nodes[a.id]!.title).toBe("広告運用");
  });

  it("seal の後はまとめない", () => {
    const { store, a } = setup();
    store.transact("t", (tx) => tx.updateNode(a.id, { title: "1" }), { coalesce: "k" });
    store.history.seal();
    store.transact("t", (tx) => tx.updateNode(a.id, { title: "2" }), { coalesce: "k" });
    store.undo();
    expect(store.doc.nodes[a.id]!.title).toBe("1");
  });

  it("同じ値の書き込みは履歴に残さない", () => {
    const { store, a } = setup();
    const n = store.history.undoStack.length;
    store.transact("t", (tx) => tx.updateNode(a.id, { title: "A", tags: [] }));
    expect(store.history.undoStack.length).toBe(n);
  });

  it("自己ループ・同じ向きの重複は作らない。逆向き（循環）は作れる", () => {
    const { store, a, b } = setup();
    store.transact("t", (tx) => {
      expect(tx.addEdge(makeEdge({ source: a.id, target: a.id }))).toBeNull();
      expect(tx.addEdge(makeEdge({ source: a.id, target: b.id }))).toBeNull();
      expect(tx.addEdge(makeEdge({ source: b.id, target: a.id }))).not.toBeNull();
    });
    expect(Object.keys(store.doc.edges)).toHaveLength(2);
  });

  it("途中で例外が出たら変更を戻す", () => {
    const { store, a } = setup();
    expect(() =>
      store.transact("t", (tx) => {
        tx.updateNode(a.id, { title: "X" });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.doc.nodes[a.id]!.title).toBe("A");
  });

  it("プロジェクト・シナリオを消してもノードは残り、所属だけ外れる（Undo で戻る）", () => {
    const { store, a } = setup();
    const p = makeProject({ name: "P" });
    const s = makeScenario({ name: "S" });
    store.transact("t", (tx) => {
      tx.addProject(p);
      tx.addScenario(s);
      tx.updateNode(a.id, { projectIds: [p.id], scenarioIds: [s.id] });
    });
    store.transact("del", (tx) => {
      tx.deleteProject(p.id);
      tx.deleteScenario(s.id);
    });
    expect(store.doc.nodes[a.id]!.projectIds).toEqual([]);
    expect(store.doc.projectOrder).toEqual([]);
    store.undo();
    expect(store.doc.nodes[a.id]!.projectIds).toEqual([p.id]);
    expect(store.doc.projectOrder).toEqual([p.id]);
    expect(store.doc.scenarios[s.id]).toBeDefined();
  });

  it("ドキュメントの入れ替えも Undo で戻る（入れ替えの後の編集とも混ざらない）", () => {
    const { store, a } = setup();
    const other = createEmptyDoc("別");
    const x = makeNode({ title: "X" });
    other.nodes[x.id] = x;
    store.replaceDoc(other, "取り込み");
    expect(store.doc.title).toBe("別");
    store.transact("t", (tx) => tx.updateNode(x.id, { title: "X2" }));
    store.undo();
    store.undo();
    expect(store.doc.nodes[a.id]).toBeDefined();
    expect(store.doc.nodes[x.id]).toBeUndefined();
    store.redo();
    expect(store.doc.nodes[x.id]!.title).toBe("X");
    store.redo();
    expect(store.doc.nodes[x.id]!.title).toBe("X2");
    // 履歴に持っている入れ替え前の写しは、その後の編集で変わらない
    expect(other.nodes[x.id]!.title).toBe("X");
  });

  it("ドキュメントの更新時刻は変更のたびに必ず進む（同じミリ秒・時計が戻った・古い物との入れ替え・その Undo/Redo でも）", () => {
    const { store, a } = setup();
    const seen: string[] = [store.doc.updatedAt];
    const push = () => {
      const t = store.doc.updatedAt;
      expect(t > seen[seen.length - 1]!).toBe(true);
      seen.push(t);
    };
    // 同じミリ秒に続けて変える
    for (const t of ["1", "2", "3"]) {
      store.transact("t", (tx) => tx.updateNode(a.id, { title: t }));
      push();
    }
    // 時計が 1 時間戻った
    const realNow = Date.now;
    try {
      Date.now = () => realNow() - 3_600_000;
      store.transact("t", (tx) => tx.updateNode(a.id, { title: "戻った" }));
      push();
    } finally {
      Date.now = realNow;
    }
    // 古い時刻を持つ物（1 年前のバックアップなど）と入れ替える
    const old = createEmptyDoc("古い");
    old.updatedAt = new Date(Date.now() - 365 * 86_400_000).toISOString();
    store.replaceDoc(old, "復元");
    push();
    expect(old.updatedAt < seen[1]!).toBe(true); // 渡した物は変えない
    store.undo();
    push();
    store.redo();
    push();
    store.undo();
    push();
  });

  it("受け手の 1 つが失敗しても、ほかの受け手（自動保存など）には届く", () => {
    const { store, a } = setup();
    const got: string[] = [];
    const errs: unknown[] = [];
    const orig = console.error;
    console.error = (e: unknown) => void errs.push(e);
    try {
      store.on("change", () => {
        throw new Error("描画の失敗");
      });
      store.on("change", () => void got.push("保存"));
      store.transact("t", (tx) => tx.updateNode(a.id, { title: "Z" }));
    } finally {
      console.error = orig;
    }
    expect(got).toEqual(["保存"]);
    expect(errs).toHaveLength(1);
  });

  it("閲覧専用では変更を受けない", () => {
    const { store, a } = setup();
    store.readOnly = true;
    let blocked = "";
    store.on("blocked", (l) => (blocked = l));
    expect(store.transact("編集", (tx) => tx.updateNode(a.id, { title: "Z" }))).toBe(false);
    expect(blocked).toBe("編集");
    expect(store.doc.nodes[a.id]!.title).toBe("A");
  });

  it("位置だけの変更は positionsOnly として知らせる", () => {
    const { store, a } = setup();
    const infos: boolean[] = [];
    store.on("change", (i) => infos.push(i.positionsOnly));
    store.transact("移動", (tx) => tx.updateNode(a.id, { x: 100, y: 50 }));
    store.transact("題名", (tx) => tx.updateNode(a.id, { title: "Q" }));
    store.undo();
    store.undo();
    expect(infos).toEqual([true, false, false, true]);
  });
});
