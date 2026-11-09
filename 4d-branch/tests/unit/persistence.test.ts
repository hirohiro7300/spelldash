import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { buildDemoDoc } from "../../src/demo/demo";
import { buildStressDoc } from "../../src/demo/stress";
import { nextStamp } from "../../src/model/ids";
import { createEmptyDoc, makeNode, makeProject, serializeDoc } from "../../src/model/schema";
import { mergeDocs, previewImport } from "../../src/persist/io";
import { KEEP, Persistence, memoryKV, type SyncKV } from "../../src/persist/persistence";
import type { DocData } from "../../src/model/types";

let dbSeq = 0;
function makeP(kv: SyncKV, dbName = `test-${++dbSeq}`) {
  return new Persistence({ dbName, kv, locks: null, channel: false, debounceMs: 1 });
}

async function wait(ms = 20) {
  await new Promise((r) => setTimeout(r, ms));
}

/** ストアと同じく、更新時刻は必ず進める（同じミリ秒に 2 回編集しても前より後になる） */
function edit(doc: DocData, title: string): DocData {
  const n = makeNode({ title });
  doc.nodes[n.id] = n;
  doc.updatedAt = nextStamp(new Date(Math.max(Date.parse(doc.updatedAt), Date.now() + 1000)).toISOString());
  return doc;
}

describe("Persistence（IndexedDB）", () => {
  it("保存して読み直せる（版番号が上がる）", async () => {
    const kv = memoryKV();
    const p = makeP(kv);
    await p.open();
    await p.acquireWriter();
    expect((await p.loadInitial()).doc).toBeNull();
    const doc = buildDemoDoc();
    p.attach(() => doc);
    p.markDirty();
    await p.flush();
    expect(p.rev).toBe(1);
    expect(p.status).toBe("saved");
    const again = makeP(kv, (p as unknown as { dbName: string }).dbName);
    await again.open();
    await again.acquireWriter();
    const { doc: back } = await again.loadInitial();
    expect(back).toEqual(doc);
  });

  it("知らない書き込みがあれば上書きせず、手元を退避して止まる", async () => {
    const kv = memoryKV();
    const name = `test-${++dbSeq}`;
    const a = makeP(kv, name);
    const b = makeP(kv, name);
    for (const p of [a, b]) {
      await p.open();
      await p.acquireWriter();
      await p.loadInitial();
    }
    const docA = createEmptyDoc("A");
    const docB = createEmptyDoc("B");
    a.attach(() => docA);
    b.attach(() => docB);
    a.markDirty();
    await a.flush();
    b.markDirty();
    await b.flush();
    expect(b.status).toBe("conflict");
    const stored = await a.readStored();
    expect(stored!.doc.title).toBe("A");
    const backups = await b.listBackups();
    expect(backups.some((x) => x.kind === "conflict" && x.docTitle === "B")).toBe(true);
    // 「最新を読み込む」で解決
    const latest = await b.resolveConflict("reload");
    expect(latest!.title).toBe("A");
    expect(b.status).toBe("saved");
  });

  const hasEmergency = (kv: ReturnType<typeof memoryKV>) => [...kv.data.keys()].some((k) => k.includes(":emergency:"));

  it("緊急コピー: 本体の保存が間に合わなかったら次の起動で採る", async () => {
    const kv = memoryKV();
    const name = `test-${++dbSeq}`;
    const p = makeP(kv, name);
    await p.open();
    await p.acquireWriter();
    await p.loadInitial();
    const doc = createEmptyDoc("最初");
    p.attach(() => doc);
    p.markDirty();
    await p.flush();
    // 保存の後に変更して、閉じる瞬間に緊急コピーだけ書けた
    edit(doc, "閉じる直前の変更");
    p.markDirty();
    p.writeEmergency();
    p.close();
    expect(hasEmergency(kv)).toBe(true);
    const next = makeP(kv, name);
    await next.open();
    await next.acquireWriter();
    const { doc: back, notices } = await next.loadInitial();
    expect(Object.values(back!.nodes).map((n) => n.title)).toEqual(["閉じる直前の変更"]);
    expect(notices.join()).toContain("復元しました");
    expect(hasEmergency(kv)).toBe(false);
  });

  it("緊急コピー: その間に別のタブが保存していたら、本体を採って緊急コピーは退避", async () => {
    const kv = memoryKV();
    const name = `test-${++dbSeq}`;
    const p = makeP(kv, name);
    await p.open();
    await p.acquireWriter();
    await p.loadInitial();
    const doc = createEmptyDoc("最初");
    p.attach(() => doc);
    p.markDirty();
    await p.flush();
    edit(doc, "このタブの未保存");
    p.markDirty();
    p.writeEmergency();
    p.close();
    // 別のタブが（緊急コピーを見ないまま）保存して版が進んだ
    const other = makeP(kv, name);
    await other.open();
    await other.acquireWriter();
    (other as unknown as { rev: number }).rev = 1;
    const otherDoc = createEmptyDoc("別のタブ");
    other.attach(() => otherDoc);
    other.markDirty();
    await other.flush();
    expect(other.rev).toBe(2);
    // 別のタブの保存は、閉じたタブの緊急コピーを消さない
    expect(hasEmergency(kv)).toBe(true);
    const next = makeP(kv, name);
    await next.open();
    await next.acquireWriter();
    const { doc: back, notices } = await next.loadInitial();
    expect(back!.title).toBe("別のタブ");
    expect(notices.join()).toContain("退避");
    const backups = await next.listBackups();
    expect(backups.some((b) => b.kind === "conflict" && Object.keys((b as { counts: { nodes: number } }).counts).length > 0)).toBe(true);
    expect(hasEmergency(kv)).toBe(false);
  });

  it("緊急コピー: 同じタブの保存が後から終わっていた（版は進んだが同じタブ）なら、続きとして採る", async () => {
    const kv = memoryKV();
    const name = `test-${++dbSeq}`;
    const p = makeP(kv, name);
    await p.open();
    await p.acquireWriter();
    await p.loadInitial();
    const doc = createEmptyDoc("最初");
    p.attach(() => doc);
    p.markDirty();
    await p.flush();
    edit(doc, "保存中に閉じた");
    p.markDirty();
    p.writeEmergency();
    const payload = kv.get(`${name}:emergency:${p.tabId}`)!;
    await p.flush(); // 閉じる途中で保存が終わった（版 2）
    // さらに後の変更が緊急コピーにだけ入った
    const em = JSON.parse(payload);
    em.doc.title = "さらに後の変更";
    em.doc.updatedAt = new Date(Date.now() + 5000).toISOString();
    kv.set(`${name}:emergency:${p.tabId}`, JSON.stringify(em));
    p.close();
    const next = makeP(kv, name);
    await next.open();
    await next.acquireWriter();
    const { doc: back, notices } = await next.loadInitial();
    expect(back!.title).toBe("さらに後の変更");
    expect(notices.join()).toContain("復元しました");
  });

  it("緊急コピー: 本体と同じなら黙って消す。閲覧のみのタブは触らず、引き継いだときに採る", async () => {
    const kv = memoryKV();
    const name = `test-${++dbSeq}`;
    const p = makeP(kv, name);
    await p.open();
    await p.acquireWriter();
    await p.loadInitial();
    const doc = createEmptyDoc("最初");
    p.attach(() => doc);
    edit(doc, "x");
    p.markDirty();
    p.writeEmergency();
    await p.flush();
    expect(hasEmergency(kv)).toBe(false); // 保存できたら自分の緊急コピーは消す
    edit(doc, "閉じる直前");
    p.markDirty();
    p.writeEmergency();
    p.close();
    // 閲覧のみのタブ（acquireWriter していない）は緊急コピーを残す
    const reader = makeP(kv, name);
    await reader.open();
    const r = await reader.loadInitial();
    expect(r.notices).toEqual([]);
    expect(hasEmergency(kv)).toBe(true);
    // 引き継ぐと採る
    const taken = await reader.takeOver();
    expect(Object.values(taken!.nodes).some((n) => n.title === "閉じる直前")).toBe(true);
    expect(hasEmergency(kv)).toBe(false);
    reader.attach(() => taken!);
    await reader.flush();
    expect(reader.rev).toBe(2);
    expect((await reader.readStored())!.doc).toEqual(taken);
  });

  it("バックアップは種類ごとに件数で間引き、復元できる", async () => {
    const p = makeP(memoryKV());
    await p.open();
    await p.acquireWriter();
    const doc = buildDemoDoc();
    for (let i = 0; i < KEEP.safety + 3; i++) await p.createBackup("safety", `#${i}`, doc);
    await p.createBackup("manual", "手動", doc);
    const list = await p.listBackups();
    expect(list.filter((b) => b.kind === "safety")).toHaveLength(KEEP.safety);
    expect(list.filter((b) => b.kind === "manual")).toHaveLength(1);
    const back = await p.readBackup(list[0]!.id);
    expect(back).toEqual(doc);
    await p.ensureDailyBackup(doc);
    await p.ensureDailyBackup(doc);
    expect((await p.listBackups()).filter((b) => b.kind === "daily")).toHaveLength(1);
  });

  it("一時表示（memory）は何も保存しない", async () => {
    const kv = memoryKV();
    const p = new Persistence({ mode: "memory", kv, locks: null, channel: false });
    await p.open();
    expect(p.status).toBe("ephemeral");
    p.attach(() => createEmptyDoc());
    p.markDirty();
    await p.flush();
    p.writeEmergency(true);
    expect(kv.data.size).toBe(0);
  });

  it("2,000 ノードの保存は速い", async () => {
    const p = makeP(memoryKV());
    await p.open();
    await p.acquireWriter();
    await p.loadInitial();
    const doc = buildStressDoc(2000);
    expect(Object.keys(doc.nodes).length).toBe(2000);
    p.attach(() => doc);
    const t0 = performance.now();
    p.markDirty();
    await p.flush();
    expect(p.status).toBe("saved");
    expect(performance.now() - t0).toBeLessThan(2000);
    await wait();
  });
});

describe("インポート", () => {
  it("書き出したものを確認画面用に読める", () => {
    const doc = buildDemoDoc();
    const pv = previewImport(serializeDoc(doc, "0.1.0"));
    expect(pv.counts.nodes).toBe(Object.keys(doc.nodes).length);
    expect(pv.report.warnings).toEqual([]);
  });

  it("追加: ID を振り直し、同じ名前のプロジェクトはまとめ、元のデータを壊さない", () => {
    const base = buildDemoDoc();
    const baseCopy = JSON.parse(JSON.stringify(base));
    const incoming = buildDemoDoc();
    const extra = makeProject({ name: "新しいプロジェクト" });
    incoming.projects[extra.id] = extra;
    incoming.projectOrder.push(extra.id);
    const { doc, added, reusedProjects } = mergeDocs(base, incoming);
    expect(reusedProjects).toBe(3);
    expect(added.projects).toBe(1);
    expect(Object.keys(doc.nodes)).toHaveLength(Object.keys(base.nodes).length * 2);
    expect(Object.keys(doc.edges)).toHaveLength(Object.keys(base.edges).length * 2);
    // 取り込んだ接続は取り込んだノード同士をつなぐ
    const ids = new Set(Object.keys(doc.nodes));
    for (const e of Object.values(doc.edges)) expect(ids.has(e.source) && ids.has(e.target)).toBe(true);
    expect(JSON.parse(JSON.stringify(base))).toEqual(baseCopy);
    // 位置は右にずらす（重ならない）
    const maxBase = Math.max(...Object.values(base.nodes).map((n) => n.x));
    const added2 = Object.values(doc.nodes).filter((n) => !(n.id in base.nodes));
    expect(Math.min(...added2.map((n) => n.x))).toBeGreaterThan(maxBase);
  });
});
