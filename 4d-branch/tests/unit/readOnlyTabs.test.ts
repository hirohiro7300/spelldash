// 閲覧のみのタブは保存先に何も書かない・当て直す前の記録は 1 度だけ・間引かずに残す（見直し skew-3・loss-6）。
// 前は、前の版のページのタブがロックを持ったまま（太い形の版 6 の本体）だと、閲覧のみで開いた新しいページのタブが起動のたびに
// 当て直す前の記録を安全用バックアップに書き、隠れるたびに緊急コピーを書いた: 本物の安全用バックアップが押し出され、次に編集できるタブが
// 開くと、その写しが「別の版のページの写し」の退避バックアップになって、退避バックアップも押し出された。
// また、当て直す前の記録は安全用として間引かれ、一覧のダウンロード・復元はまた当て直した物になった（loss-6）。
//   今: 閲覧のみのタブは当て直した文書を見せるだけ。記録を残すのは編集できるタブ（起動・引き継ぎ）だけで、同じ記録は 1 度だけ・間引かない。
//   一覧のダウンロードは、そのまま残した記録・前の形のバックアップなら、そのままの形
import "fake-indexeddb/auto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MapData } from "../../src/deepmap/mapData";
import { createEmptyDoc, makeNode, THIN_VERSION } from "../../src/model/schema";
import type { DocData, GNode } from "../../src/model/types";
import { enableThinPage, setThinBaseline } from "../../src/persist/codec";
import { isRawDownloadBackup, KEEP, memoryKV, Persistence, type BackupMeta } from "../../src/persist/persistence";
import { Store } from "../../src/store/store";
import { fakeLocks, rawAll } from "./helpers/idbRaw";
import { loadQSmall } from "./helpers/qSmall";
import { buildR6Future } from "./helpers/r6";

let page: MapData;
beforeAll(async () => {
  const q = await loadQSmall();
  page = { ...q, header: { ...q.header, release: 7 } } as MapData;
});
afterEach(() => {
  enableThinPage(null);
  setThinBaseline(null);
});

let seq = 0;
const keyOf = (n: GNode | undefined): string | null => (typeof n?.meta?.key === "string" ? n.meta.key : null);
const emergencyKeys = (kv: ReturnType<typeof memoryKV>): string[] => [...kv.data.keys()].filter((k) => k.includes(":emergency:"));
const metas = async (name: string): Promise<BackupMeta[]> => (await rawAll(name, "backupMeta")) as BackupMeta[];

/** 版 6 の地図の文書（利用者の期限つき: 引き上げで変わる物）と、それを本体に持つ保存先。holder: その本体を書いた、ロックを持つタブ */
async function r6Browser(opts: { realSafety?: number } = {}) {
  const r6 = buildR6Future().pv.doc;
  const store = new Store(r6);
  const keep = Object.values(store.doc.nodes).find((n) => keyOf(n) === "r.keep")!;
  store.transact("期限", (tx) => tx.updateNode(keep.id, { status: "active", time: { ...keep.time, due: "2027-09-30" } }));
  const kv = memoryKV();
  const name = `ro-${++seq}`;
  const lk = fakeLocks();
  const holder = new Persistence({ dbName: name, kv, locks: lk.locks, channel: false, debounceMs: 1 });
  await holder.open();
  expect(await holder.acquireWriter()).toBe(true);
  await holder.loadInitial();
  holder.attach(() => store.doc);
  holder.markDirty();
  await holder.flush();
  for (let i = 0; i < (opts.realSafety ?? 0); i++) await holder.createBackup("safety", `本物の安全用 ${i}`, store.doc);
  return { doc: store.doc, keepId: keep.id, kv, name, lk, holder };
}

const openTab = async (b: { kv: ReturnType<typeof memoryKV>; name: string; lk: ReturnType<typeof fakeLocks> }): Promise<Persistence> => {
  const p = new Persistence({ dbName: b.name, kv: b.kv, locks: b.lk.locks, channel: false, debounceMs: 1 });
  await p.open();
  await p.acquireWriter();
  return p;
};

describe("閲覧のみのタブは、当て直しても保存先に何も書かない（skew-3）", () => {
  it("20 回開いて隠しても、バックアップも緊急コピーも増えない。本物の安全用バックアップは残る。次に編集できるタブが開いても退避は作らない", async () => {
    enableThinPage(async () => page);
    const b = await r6Browser({ realSafety: 5 });
    const before = (await metas(b.name)).map((m) => m.id).sort();
    expect(before).toHaveLength(5);
    for (let i = 0; i < 21; i++) {
      const p = await openTab(b);
      expect(p.writer).toBe(false);
      const boot = await p.loadInitial();
      expect(boot.upgrade?.legacy).toBeDefined();
      expect(boot.notices.join("")).toContain("閲覧のみ");
      expect(boot.notices.join("")).not.toContain("バックアップに残しています");
      p.attach(() => boot.doc!);
      p.writeEmergency();
      p.writeEmergency(true);
      expect(p.hasUnsaved).toBe(false);
      p.close();
    }
    expect((await metas(b.name)).map((m) => m.id).sort()).toEqual(before);
    expect(emergencyKeys(b.kv)).toEqual([]);
    // 前の版のページのタブが閉じた: 編集できるタブとして開く（記録を 1 度だけ残す。「別の版のページ」の退避は作らない）
    b.holder.close();
    b.lk.release();
    const w = await openTab({ ...b, lk: fakeLocks() });
    expect(w.writer).toBe(true);
    const boot = await w.loadInitial();
    expect(boot.notices.join("")).not.toContain("別の版のページ");
    expect(boot.notices.join("")).toContain("そのままの形でバックアップに残しています");
    const after = await metas(b.name);
    expect(after.filter((m) => m.kind === "conflict")).toEqual([]);
    expect(after.filter((m) => m.raw)).toHaveLength(1);
    for (const id of before) expect(after.some((m) => m.id === id)).toBe(true);
    w.close();
  });

  it("閲覧のみのタブが引き継ぐと（takeOver）、そこで記録を 1 度だけ残し、次の保存で薄い形にする", async () => {
    enableThinPage(async () => page);
    const b = await r6Browser();
    const p = await openTab(b);
    expect(p.writer).toBe(false);
    const boot = await p.loadInitial();
    p.attach(() => boot.doc!);
    expect((await metas(b.name)).filter((m) => m.raw)).toHaveLength(0);
    const doc = (await p.takeOver())!;
    expect(p.writer).toBe(true);
    expect(doc.nodes[b.keepId]?.status).toBe("active");
    p.attach(() => doc);
    await p.flush();
    const raws = (await metas(b.name)).filter((m) => m.raw);
    expect(raws).toHaveLength(1);
    expect(raws[0]!.docVersion).toBe(1);
    expect(((await rawAll(b.name, "kv")) as unknown[]).some((v) => !!v && typeof v === "object" && (v as { version?: number }).version === THIN_VERSION)).toBe(true);
    p.close();
    b.holder.close();
  });

  it("同じ記録は 1 度だけ残す（保存する前に何度開き直しても）", async () => {
    enableThinPage(async () => page);
    const b = await r6Browser();
    b.holder.close();
    b.lk.release();
    for (let i = 0; i < 4; i++) {
      const w = await openTab({ ...b, lk: fakeLocks() });
      await w.loadInitial();
      w.close();
    }
    expect((await metas(b.name)).filter((m) => m.raw)).toHaveLength(1);
  });
});

describe("当て直す前の記録は間引かず、そのままの形で取り出せる（loss-6）", () => {
  it("安全用バックアップを 25 件作っても残る。ダウンロード（readBackupRaw）は当て直す前の中身（利用者の期限もそのまま）", async () => {
    enableThinPage(async () => page);
    const b = await r6Browser();
    b.holder.close();
    b.lk.release();
    const w = await openTab({ ...b, lk: fakeLocks() });
    const boot = await w.loadInitial();
    w.attach(() => boot.doc!);
    await w.flush();
    const raw = (await w.listBackups()).find((m) => m.raw)!;
    expect(raw).toBeDefined();
    for (let i = 0; i < 25; i++) await w.createBackup("safety", `追加 ${i}`, createEmptyDoc(`空 ${i}`));
    const list = await w.listBackups();
    expect(list.filter((m) => m.kind === "safety" && !m.raw)).toHaveLength(KEEP.safety);
    expect(list.some((m) => m.id === raw.id)).toBe(true);
    // 一覧のダウンロードは、そのままの形（版 6 の記録。期限 2027-09-30 も）
    expect(isRawDownloadBackup(raw)).toBe(true);
    const text = (await w.readBackupRaw(raw.id))!.text;
    const old = JSON.parse(text) as DocData;
    expect(old.version).toBe(1);
    expect(old.nodes[b.keepId]?.time.due).toBe("2027-09-30");
    // 復元（読む）と当て直した物になる（そのまま読む物とは別）
    const read = await w.readBackupChecked(raw.id);
    expect(read.upgrade?.legacy).toBeDefined();
    w.close();
  });

  it("一覧の見分け: 前の形（版 1）・前の版の地図・前の組み立てのバックアップも、そのままの形でダウンロード。薄い形を読めないページは今までどおり", () => {
    enableThinPage(async () => page);
    setThinBaseline(page);
    expect(isRawDownloadBackup({ docVersion: 1 })).toBe(true);
    expect(isRawDownloadBackup({})).toBe(true);
    expect(isRawDownloadBackup({ docVersion: THIN_VERSION, mapRelease: 6 })).toBe(true);
    expect(isRawDownloadBackup({ docVersion: THIN_VERSION, mapRelease: 7, mapBv: 0 })).toBe(true);
    expect(isRawDownloadBackup({ docVersion: THIN_VERSION, mapRelease: 7, mapBv: 1 })).toBe(false);
    enableThinPage(null);
    setThinBaseline(null);
    expect(isRawDownloadBackup({ docVersion: 1 })).toBe(false);
    expect(isRawDownloadBackup({ raw: true })).toBe(true);
    expect(makeNode).toBeDefined();
  });
});
