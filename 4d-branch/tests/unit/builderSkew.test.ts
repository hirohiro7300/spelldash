// 組み立ての版（THIN_BASELINE_VERSION・薄い形の bv）の違い（見直し skew-2）。前は、同じ版の順番で bv が違う記録は、どちら向きでも
// 「合わない」として止めた: 組み立てを直した最初の公開で、どの端末も起動で止まり、アカウントの同期も止まったままになった。
//   今: 前の組み立て（bv が小さい）の記録は、前の版の地図と同じく鍵で当て直して読む（本体・緊急コピー・バックアップ・アカウント・取り込み。
//   同じ木なので、消したカードと線は消したまま）。新しい組み立て（bv が大きい）の記録は新しい版のデータとして止める（「この版で開き直す」は出さない）
import "fake-indexeddb/auto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MapData } from "../../src/deepmap/mapData";
import { isDisposableDoc } from "../../src/demo/demo";
import { makeNode, NewerDocError, THIN_VERSION } from "../../src/model/schema";
import type { DocData, GNode } from "../../src/model/types";
import {
  decodeStored,
  headerBlock,
  isBlockedError,
  isNewerRecord,
  setThinBaseline,
  storedMapReleaseOf,
  thinBaselineDoc,
  ThinNewerError,
  toStored,
  upgradeNotice,
  THIN_BASELINE_VERSION,
  type StoredDoc,
  type ThinSection,
} from "../../src/persist/codec";
import { CloudRepo, CloudSync, pageCodec, type CloudBackend, type CloudCodec, type CloudDoc } from "../../src/persist/cloud";
import { previewImport } from "../../src/persist/io";
import { memoryKV, Persistence } from "../../src/persist/persistence";
import { Store } from "../../src/store/store";
import { rawAll, rawGet, rawPut } from "./helpers/idbRaw";
import { loadQSmall } from "./helpers/qSmall";

let page: MapData;
beforeAll(async () => {
  const q = await loadQSmall();
  page = { ...q, header: { ...q.header, release: 7 } } as MapData;
});
afterEach(() => setThinBaseline(null));

const AT = "2026-11-19T03:04:05.006Z";
const keyOf = (n: GNode | undefined): string | null => (typeof n?.meta?.key === "string" ? n.meta.key : null);
let seq = 0;

/** 編集した文書（選んだ手・書き換え・消した手・自分のカード）と、その記録の bv を変えた物 */
function edited(): { doc: DocData; pick: string; title: string; gone: string; mine: string } {
  setThinBaseline(page);
  const store = new Store(thinBaselineDoc({ at: AT }));
  const cards = Object.values(store.doc.nodes).filter((n) => keyOf(n) !== null && n.meta.forecastRoot !== true);
  const pick = cards.find((n) => keyOf(n) === "r.keep")!;
  const title = cards.filter((n) => keyOf(n)!.startsWith("r.keep."))[40]!;
  const gone = cards.find((n) => keyOf(n) === "r.ad_permside")!;
  const mine = makeNode({ title: "自分のカード", x: -2000, y: 0 });
  store.transact("編集", (tx) => {
    tx.updateNode(pick.id, { status: "active" });
    tx.updateNode(title.id, { title: `${title.title}（自分の言葉）` });
    tx.addNode(mine);
  });
  // 手を 1 つ消す（その先も）
  const out = new Map<string, string[]>();
  for (const e of Object.values(store.doc.edges)) (out.get(e.source) ?? out.set(e.source, []).get(e.source)!).push(e.target);
  const sub: string[] = [];
  const stack = [gone.id];
  while (stack.length) {
    const id = stack.pop()!;
    sub.push(id);
    stack.push(...(out.get(id) ?? []));
  }
  store.transact("消す", (tx) => sub.forEach((id) => tx.deleteNode(id)));
  return { doc: store.doc, pick: pick.id, title: title.id, gone: gone.id, mine: mine.id };
}

const withBv = (doc: DocData, bv: number): StoredDoc & { maps: ThinSection[] } => {
  const rec = JSON.parse(JSON.stringify(toStored(doc))) as StoredDoc & { maps: ThinSection[] };
  rec.maps[0]!.bv = bv;
  return rec;
};

describe("前の組み立て（bv が小さい）の記録は、鍵で当て直して読む", () => {
  it("読める: 書き換え・選んだ手・自分のカードはそのまま、消した手は消したまま（同じ木）。id と更新時刻は変えない", () => {
    const e = edited();
    const rec = withBv(e.doc, THIN_BASELINE_VERSION - 1);
    const d = decodeStored(rec);
    expect(d.upgrade).toBeDefined();
    expect(d.upgrade!.from).toMatchObject({ release: 7, bv: THIN_BASELINE_VERSION - 1 });
    expect(d.upgrade!.to).toMatchObject({ release: 7, bv: THIN_BASELINE_VERSION });
    expect(d.upgrade!.restored).toBe(0);
    expect(d.doc.id).toBe(e.doc.id);
    expect(d.doc.updatedAt).toBe(e.doc.updatedAt);
    expect(d.doc.nodes[e.pick]?.status).toBe("active");
    expect(d.doc.nodes[e.title]?.title).toContain("（自分の言葉）");
    expect(d.doc.nodes[e.mine]?.title).toBe("自分のカード");
    expect(d.doc.nodes[e.gone]).toBeUndefined();
    expect(Object.values(d.doc.nodes).some((n) => keyOf(n)?.startsWith("r.ad_permside"))).toBe(false);
    expect(Object.keys(d.doc.nodes).sort()).toEqual(Object.keys(e.doc.nodes).sort());
    expect(Object.keys(d.doc.edges).sort()).toEqual(Object.keys(e.doc.edges).sort());
    // 次に書くと、このページの組み立ての形（同じ中身）
    expect(JSON.stringify(toStored(d.doc))).toBe(JSON.stringify(toStored(e.doc)));
    // 知らせは「新しい版」「前の版」と言わない
    const text = upgradeNotice(d.upgrade!, "boot");
    expect(text).toContain("地図の組み立てが新しくなった");
    expect(text).not.toContain("新しい版（版");
    expect(storedMapReleaseOf(d.doc)).toBe(7);
  });

  it("見出し・印: 前の組み立ては読める物（止めない・新しい版でもない）", () => {
    const e = edited();
    const rec = withBv(e.doc, THIN_BASELINE_VERSION - 1);
    expect(headerBlock({ docVersion: THIN_VERSION, mapRelease: 7, mapHash: page.header.hash, mapBv: THIN_BASELINE_VERSION - 1 })).toBeNull();
    // 前の組み立てなら、中身の指紋が違っても中身を読んで当て直せる
    expect(headerBlock({ docVersion: THIN_VERSION, mapRelease: 7, mapHash: "x", mapBv: THIN_BASELINE_VERSION - 1 })).toBeNull();
    expect(isNewerRecord(rec)).toBe(false);
    // 取り込み
    expect(previewImport(JSON.stringify(rec)).doc.nodes[e.mine]?.title).toBe("自分のカード");
  });

  it("本体（起動）: 止めずに開き、記録をそのまま安全用バックアップに残して、次の保存はこのページの組み立て", async () => {
    const e = edited();
    const kv = memoryKV();
    const name = `bv-${++seq}`;
    const p0 = new Persistence({ dbName: name, kv, locks: null, channel: false, debounceMs: 1 });
    await p0.open();
    await p0.acquireWriter();
    await p0.loadInitial();
    p0.attach(() => e.doc);
    p0.markDirty();
    await p0.flush();
    p0.close();
    const body = (await rawGet(name, "kv", "doc")) as StoredDoc & { maps: ThinSection[] };
    body.maps[0]!.bv = THIN_BASELINE_VERSION - 1;
    await rawPut(name, "kv", body, "doc");
    const meta = (await rawGet(name, "kv", "meta")) as Record<string, unknown>;
    await rawPut(name, "kv", { ...meta, mapBv: THIN_BASELINE_VERSION - 1 }, "meta");
    const p = new Persistence({ dbName: name, kv, locks: null, channel: false, debounceMs: 1 });
    await p.open();
    await p.acquireWriter();
    const boot = await p.loadInitial();
    expect(boot.blocked).toBe(false);
    expect(boot.doc!.nodes[e.mine]?.title).toBe("自分のカード");
    expect(boot.notices.join("")).toContain("地図の組み立てが新しくなった");
    const raws = (await rawAll(name, "backupMeta")) as Array<{ kind: string; mapBv?: number }>;
    expect(raws.some((b) => b.kind === "safety" && b.mapBv === THIN_BASELINE_VERSION - 1)).toBe(true);
    p.attach(() => boot.doc!);
    await p.flush();
    expect(((await rawGet(name, "kv", "meta")) as { mapBv: number }).mapBv).toBe(THIN_BASELINE_VERSION);
    p.close();
  });

  it("アカウントの写し: 前の組み立ての写しを読んで同期する（止めない・同期をやり直す必要も無い）", async () => {
    const e = edited();
    const docs = new Map<string, Record<string, unknown>>();
    const snap = (path: string): CloudDoc => (docs.has(path) ? { exists: true, data: structuredClone(docs.get(path)!) } : { exists: false });
    const be: CloudBackend = {
      get: async (path) => snap(path),
      set: async (path, data) => void docs.set(path, structuredClone(data)),
      delete: async (path) => void docs.delete(path),
      watch: (path, next) => (queueMicrotask(() => next(snap(path))), () => undefined),
      lease: async () => true,
      list: async () => [],
    };
    // 前の組み立てのページが送った写し
    const olderCodec: CloudCodec = { ...pageCodec, encode: (doc) => ({ stored: withBv(doc, THIN_BASELINE_VERSION - 1), docVersion: THIN_VERSION }) };
    await new CloudRepo(be, "u1", "old", undefined, olderCodec).write(e.doc, null);
    const remote = (await new CloudRepo(be, "u1", "chk").read())!;
    expect(remote.doc.nodes[e.mine]?.title).toBe("自分のカード");
    // 新しい端末（捨ててよい手元）: 聞かずに読み込んで「同期済み」
    const store = new Store(thinBaselineDoc({ at: AT }));
    let adopted = 0;
    const sync = new CloudSync(
      new CloudRepo(be, "u1", "new"),
      {
        getDoc: () => store.doc,
        bootDoc: async () => null,
        isWriter: () => true,
        isDisposable: () => true,
        isEditing: () => false,
        isForeign: () => false,
        adopt: async (d) => (store.load(d, "load"), adopted++, { id: store.doc.id, updatedAt: store.doc.updatedAt }),
        backup: async () => true,
        confirmWithoutBackup: async () => false,
        chooseFirst: async () => "later",
        readBase: async () => null,
        writeBase: async () => undefined,
        notice: () => undefined,
      },
      { debounceMs: 5, leaseMs: 20, retryMs: 10, resubscribeMs: 30 },
    );
    await sync.start();
    for (let i = 0; i < 50 && sync.state !== "synced"; i++) await new Promise((r) => setTimeout(r, 10));
    expect(sync.state).toBe("synced");
    expect(adopted).toBe(1);
    expect(store.doc.nodes[e.mine]?.title).toBe("自分のカード");
    expect(isDisposableDoc).toBeDefined();
    sync.stop();
  });
});

describe("新しい組み立て（bv が大きい）の記録は、新しい版のデータとして止める", () => {
  it("読まない（ThinNewerError: NewerDocError の一種）。見出しは newer、印も新しい版", () => {
    const e = edited();
    const rec = withBv(e.doc, THIN_BASELINE_VERSION + 1);
    let err: unknown;
    try {
      decodeStored(rec);
    } catch (x) {
      err = x;
    }
    expect(err).toBeInstanceOf(ThinNewerError);
    expect(err).toBeInstanceOf(NewerDocError);
    expect(isBlockedError(err)).toBe(true);
    expect(headerBlock({ docVersion: THIN_VERSION, mapRelease: 7, mapHash: page.header.hash, mapBv: THIN_BASELINE_VERSION + 1 })).toBe("newer");
    expect(isNewerRecord(rec)).toBe(true);
    expect(() => previewImport(JSON.stringify(rec))).toThrow(NewerDocError);
  });

  it("本体: 起動で止める（新しい版として。「この版で開き直す」は出さない）。版の記録が新しい組み立てを指していれば上書きしない", async () => {
    const e = edited();
    const kv = memoryKV();
    const name = `bvn-${++seq}`;
    const p0 = new Persistence({ dbName: name, kv, locks: null, channel: false, debounceMs: 1 });
    await p0.open();
    await p0.acquireWriter();
    await p0.loadInitial();
    p0.attach(() => e.doc);
    p0.markDirty();
    await p0.flush();
    // 別のタブ（新しい組み立てのページ）が保存した: 版の記録の組み立ての版が新しい
    const meta = (await rawGet(name, "kv", "meta")) as Record<string, unknown>;
    await rawPut(name, "kv", { ...meta, mapBv: THIN_BASELINE_VERSION + 1 }, "meta");
    const before = JSON.stringify(await rawGet(name, "kv", "doc"));
    p0.markDirty();
    await p0.flush();
    expect(JSON.stringify(await rawGet(name, "kv", "doc"))).toBe(before);
    p0.close();
    const body = (await rawGet(name, "kv", "doc")) as StoredDoc & { maps: ThinSection[] };
    body.maps[0]!.bv = THIN_BASELINE_VERSION + 1;
    await rawPut(name, "kv", body, "doc");
    const p = new Persistence({ dbName: name, kv, locks: null, channel: false, debounceMs: 1 });
    await p.open();
    await p.acquireWriter();
    const boot = await p.loadInitial();
    expect(boot.blocked).toBe(true);
    expect(p.blockedWhy?.kind).toBe("newer");
    expect(p.blockedWhy?.reopen).toBeFalsy();
    p.close();
  });

  it("アカウントの写し: 新しい版の写しとして止める（開き直すまで同期も編集も止める）", async () => {
    const e = edited();
    const docs = new Map<string, Record<string, unknown>>();
    const snap = (path: string): CloudDoc => (docs.has(path) ? { exists: true, data: structuredClone(docs.get(path)!) } : { exists: false });
    const be: CloudBackend = {
      get: async (path) => snap(path),
      set: async (path, data) => void docs.set(path, structuredClone(data)),
      delete: async (path) => void docs.delete(path),
      watch: (path, next) => (queueMicrotask(() => next(snap(path))), () => undefined),
      lease: async () => true,
      list: async () => [],
    };
    const newerCodec: CloudCodec = { ...pageCodec, encode: (doc) => ({ stored: withBv(doc, THIN_BASELINE_VERSION + 1), docVersion: THIN_VERSION }) };
    await new CloudRepo(be, "u1", "newer", undefined, newerCodec).write(e.doc, null);
    const store = new Store(e.doc);
    const sync = new CloudSync(
      new CloudRepo(be, "u1", "me"),
      {
        getDoc: () => store.doc,
        bootDoc: async () => null,
        isWriter: () => true,
        isDisposable: () => false,
        isEditing: () => false,
        isForeign: () => false,
        adopt: async () => null,
        backup: async () => true,
        confirmWithoutBackup: async () => false,
        chooseFirst: async () => "later",
        readBase: async () => ({ gen: "g0", docId: e.doc.id, docUpdatedAt: e.doc.updatedAt, mapRelease: 7 }),
        writeBase: async () => undefined,
        notice: () => undefined,
      },
      { debounceMs: 5, leaseMs: 20, retryMs: 10, resubscribeMs: 30 },
    );
    await sync.start();
    for (let i = 0; i < 50 && !sync.accountNewer; i++) await new Promise((r) => setTimeout(r, 10));
    expect(sync.accountNewer).toBe(true);
    sync.stop();
  });
});
