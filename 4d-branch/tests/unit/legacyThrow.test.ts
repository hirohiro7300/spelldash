// 版 6 の地図の引き上げ（legacyMap.ts の upgradeLegacyMap）が途中で失敗しても、版 1 の本体を壊れたデータと取り違えない（見直し code-1・code-6）。
// 取り違えると、起動は「いちばん新しいバックアップから復元しました」になり、最初の保存で版 6 の本体を古いバックアップで上書きする（R0 §11.1）。
// 守り: 引き上げの失敗は前の版の地図のまま読む（codec.ts の legacyUpgrade）。それが外れても、本体の読み直し（persistence.ts の readStored）が
// 引き上げずにもう一度読む。どちらの道でも、知らせは画面に出す（コンソールだけにしない）
import "fake-indexeddb/auto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MapData } from "../../src/deepmap/mapData";
import type { DocData } from "../../src/model/types";
import { decodeStored, decodeStoredAsync, enableThinPage, setCodecWarn, setThinBaseline } from "../../src/persist/codec";
import { CloudRepo, type CloudBackend, type CloudDoc } from "../../src/persist/cloud";
import { previewImportAsync } from "../../src/persist/io";
import { legacyRootOf } from "../../src/persist/legacyMap";
import { memoryKV, Persistence } from "../../src/persist/persistence";
import { createEmptyDoc, makeNode } from "../../src/model/schema";
import { kvDump, rawDump, rawPut } from "./helpers/idbRaw";
import { ACCOUNT_R6_RAW, accountR6Doc } from "./helpers/legacyCheck";
import { loadQSmall } from "./helpers/qSmall";

// 引き上げを、版 6 の地図を持つ文書でだけ失敗させる（ページの地図の読み口が壊れた などの代わり）
const fail = vi.hoisted(() => ({ on: true }));
vi.mock("../../src/persist/legacyMap", async (orig) => {
  const actual = await orig<typeof import("../../src/persist/legacyMap")>();
  return {
    ...actual,
    upgradeLegacyMap: (doc: DocData) => {
      if (fail.on && actual.legacyRootOf(doc)) throw new TypeError("テストで引き上げを失敗させた");
      return actual.upgradeLegacyMap(doc);
    },
  };
});

let page: MapData;
beforeAll(async () => {
  const q = await loadQSmall();
  page = { ...q, header: { ...q.header, release: 7 } } as MapData;
});
afterEach(() => {
  enableThinPage(null);
  setThinBaseline(null);
  setCodecWarn(null);
  fail.on = true;
});

let seq = 0;
const nodes = (d: DocData | null | undefined) => Object.keys(d?.nodes ?? {}).length;

describe("版 6 の地図の引き上げが失敗しても、壊れたデータと取り違えない（code-1）", () => {
  it("起動: 版 6 の本体のまま開く（復元しない・書かない・消さない）。知らせは起動の知らせに出る", async () => {
    setCodecWarn(() => undefined);
    enableThinPage(async () => page);
    const kv = memoryKV();
    const name = `lt-${++seq}`;
    // 前の版のページが書いた本体（版 6 の地図）・版の記録・地図を入れる前の日次バックアップ
    const w = new Persistence({ dbName: name, kv, locks: null, channel: false, debounceMs: 1 });
    await w.open();
    await w.acquireWriter();
    await w.loadInitial();
    const before = createEmptyDoc("地図を入れる前");
    before.nodes.n_old = makeNode({ id: "n_old", title: "地図を入れる前のカード" });
    await w.createBackup("daily", "", before);
    w.close();
    await rawPut(name, "kv", JSON.parse(ACCOUNT_R6_RAW), "doc");
    await rawPut(name, "kv", { rev: 3, savedAt: "2026-11-15T00:00:00.000Z", writer: "t_old", docVersion: 1 }, "meta");
    const dump0 = await rawDump(name);
    const kv0 = kvDump(kv);
    const p = new Persistence({ dbName: name, kv, locks: null, channel: false, debounceMs: 1 });
    await p.open();
    await p.acquireWriter();
    const boot = await p.loadInitial();
    expect(boot.blocked).toBe(false);
    expect(boot.recovered).toBe(false);
    expect(nodes(boot.doc)).toBe(nodes(accountR6Doc()));
    expect(legacyRootOf(boot.doc!)).not.toBeNull();
    expect(boot.notices.join("")).toContain("版 6 の地図を新しい版にできなかったため、前の版の地図のまま開きます");
    expect(boot.notices.join("")).not.toContain("バックアップから復元");
    p.attach(() => boot.doc!);
    await p.flush();
    expect(await rawDump(name)).toBe(dump0);
    expect(kvDump(kv)).toBe(kv0);
    p.close();
  });

  it("ほかの読み口も同じ: そのまま読む・バックアップ（戻せる。確認に知らせ）・取り込み（警告に知らせ）・アカウントの写し", async () => {
    const warned: string[] = [];
    setCodecWarn((m) => warned.push(m));
    enableThinPage(async () => page);
    const raw = JSON.parse(ACCOUNT_R6_RAW) as unknown;
    expect(nodes((await decodeStoredAsync(structuredClone(raw))).doc)).toBe(nodes(accountR6Doc()));
    expect(decodeStored(structuredClone(raw)).upgrade).toBeUndefined();
    expect(warned.length).toBeGreaterThan(0);
    // バックアップ
    const kv = memoryKV();
    const p = new Persistence({ dbName: `ltb-${++seq}`, kv, locks: null, channel: false, debounceMs: 1 });
    await p.open();
    await p.acquireWriter();
    await p.loadInitial();
    const b = await p.createBackup("manual", "版 6", accountR6Doc());
    const read = await p.readBackupChecked(b!.id);
    expect(read.doc).not.toBeNull();
    expect(read.warning).toContain("版 6 の地図を新しい版にできなかった");
    p.close();
    // 取り込み
    const pv = await previewImportAsync(ACCOUNT_R6_RAW);
    expect(nodes(pv.doc)).toBe(nodes(accountR6Doc()));
    expect(pv.report.warnings.join("")).toContain("版 6 の地図を新しい版にできなかった");
    // アカウントの写し
    const docs = new Map<string, Record<string, unknown>>();
    const be: CloudBackend = {
      get: async (path): Promise<CloudDoc> => (docs.has(path) ? { exists: true, data: structuredClone(docs.get(path)!) } : { exists: false }),
      set: async (path, data) => void docs.set(path, structuredClone(data)),
      delete: async (path) => void docs.delete(path),
      watch: () => () => undefined,
      lease: async () => true,
      list: async () => [],
    };
    fail.on = false;
    setThinBaseline(null);
    enableThinPage(null);
    await new CloudRepo(be, "u", "old").write(accountR6Doc(), null);
    fail.on = true;
    enableThinPage(async () => page);
    const remote = await new CloudRepo(be, "u", "new").read();
    expect(nodes(remote!.doc)).toBe(nodes(accountR6Doc()));
  });

  it("読み直しの守り: 保存の口が失敗を投げても（版 1 の記録）、引き上げずにもう一度読んで開く", async () => {
    enableThinPage(async () => page);
    const kv = memoryKV();
    const name = `ltr-${++seq}`;
    const w = new Persistence({ dbName: name, kv, locks: null, channel: false, debounceMs: 1 });
    await w.open();
    await w.acquireWriter();
    await w.loadInitial();
    w.close();
    await rawPut(name, "kv", JSON.parse(ACCOUNT_R6_RAW), "doc");
    await rawPut(name, "kv", { rev: 3, savedAt: "2026-11-15T00:00:00.000Z", writer: "t_old", docVersion: 1 }, "meta");
    const codec = await import("../../src/persist/codec");
    const spy = vi.spyOn(codec, "decodeStoredAsync").mockImplementation(async (raw, opts) => {
      if (opts?.upgrade !== "none") throw new TypeError("保存の口の守りが外れた");
      return codec.decodeStored(raw, opts);
    });
    try {
      const p = new Persistence({ dbName: name, kv, locks: null, channel: false, debounceMs: 1 });
      await p.open();
      await p.acquireWriter();
      const boot = await p.loadInitial();
      // 壊れたデータと見なさない（バックアップで始めない）。知らせは起動の知らせに
      expect(boot.recovered).toBe(false);
      expect(boot.notices.join("")).toContain("前の版の地図のまま開きます");
      expect(nodes(boot.doc)).toBe(nodes(accountR6Doc()));
      p.close();
    } finally {
      spy.mockRestore();
    }
  });
});
