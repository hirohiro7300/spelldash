// アカウントの突き合わせで、前の版の地図の上で書いた手元の変更を、新しい版の地図の写しの上へ黙って送らない（safety-2・見直し loss-2・skew-1・code-4）。
// 前は、まだ送っていない変更がどの版の地図の上の物かを、起動したときの記録（App.recordBootDoc。編集できるタブが起動したときだけ書く）の版でしか
// 分からなかった。閲覧のみで起動したタブ（前の版のページのタブがロックを持ったまま止まっている）で「このタブで編集する」を押すと記録が無く、
// 起動で引き上げた手元（版 7 の地図）と版 7 の写しを比べて、ふつうの重なり（手元で上書き）にしていた。
//   今: 手がかりを 4 つ見る（今の地図の版・版をまたいで読んだ手元の保存してあった形の版・基準を書いたときの地図の版（版の無い基準は前の版の
//   ページの物）・起動したときの記録の版）。記録は引き継いだとき・保存されている最新を開いたときにも書く（決まりは nextBootDoc の 1 か所）
import "fake-indexeddb/auto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MapData } from "../../src/deepmap/mapData";
import { isDisposableDoc } from "../../src/demo/demo";
import { createEmptyDoc, makeNode, normalizeDoc, SCHEMA_VERSION } from "../../src/model/schema";
import type { DocData, GNode } from "../../src/model/types";
import { decodeStored, enableThinPage, setThinBaseline, storedMapReleaseOf, thinBaselineDoc } from "../../src/persist/codec";
import { CloudRepo, CloudSync, mapReleaseOf, nextBootDoc, PRE_THIN_RELEASE, type BootDoc, type CloudBackend, type CloudCodec, type CloudDoc, type SyncBase } from "../../src/persist/cloud";
import { memoryKV, Persistence } from "../../src/persist/persistence";
import { Store } from "../../src/store/store";
import { fakeLocks } from "./helpers/idbRaw";
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

const AT = "2026-11-19T03:04:05.006Z";
const keyOf = (n: GNode | undefined): string | null => (typeof n?.meta?.key === "string" ? n.meta.key : null);
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
let seq = 0;

function memoryBackend() {
  const docs = new Map<string, Record<string, unknown>>();
  const leases = new Map<string, { holder: string; until: number }>();
  const snap = (path: string): CloudDoc => (docs.has(path) ? { exists: true, data: structuredClone(docs.get(path)!) } : { exists: false });
  const be: CloudBackend = {
    get: async (path) => snap(path),
    set: async (path, data) => void docs.set(path, structuredClone(data)),
    delete: async (path) => void docs.delete(path),
    watch: (path, next) => (queueMicrotask(() => next(snap(path))), () => undefined),
    async lease(path, holder, ttlMs) {
      const cur = leases.get(path);
      if (cur && cur.holder !== holder && cur.until > Date.now()) return false;
      leases.set(path, { holder, until: Date.now() + ttlMs });
      return true;
    },
    list: async (path) =>
      [...docs.keys()].filter((k) => k.startsWith(`${path}/`) && !k.slice(path.length + 1).includes("/")).map((k) => ({ id: k.slice(path.length + 1), data: structuredClone(docs.get(k)) })),
  };
  return { be };
}

/** 前の版のページ（v32・v33）の写しの読み書き（太い形・docVersion 1。版 2 は新しい版） */
const legacyCodec: CloudCodec = {
  encode: (doc) => ({ stored: doc, docVersion: doc.version }),
  decode: async (raw) => normalizeDoc(raw).doc,
  isNewer: (v) => typeof v === "number" && Number.isFinite(v) && Math.floor(v) > SCHEMA_VERSION,
};

/** 1 つの端末。old: 前の版のページ（写しは太い形・基準に地図の版を書かない） */
function device(be: CloudBackend, name: string, doc: DocData, opts: { old?: boolean; base?: SyncBase | null; boot?: () => BootDoc | null } = {}) {
  const store = new Store(doc);
  const local = { base: opts.base ?? null, backups: [] as Array<{ doc: DocData; kind: string }>, asked: 0 };
  const repo = new CloudRepo(be, "user1", name, undefined, opts.old ? legacyCodec : undefined);
  const sync = new CloudSync(
    repo,
    {
      getDoc: () => store.doc,
      bootDoc: async () => opts.boot?.() ?? null,
      isWriter: () => true,
      isDisposable: (d) => isDisposableDoc(d),
      isEditing: () => false,
      isForeign: () => false,
      adopt: async (d, how, stillOk) => {
        if (!stillOk()) return null;
        if (how === "remote") store.replaceDoc(d, "別の端末の内容を読み込む");
        else store.load(d, "load");
        return { id: store.doc.id, updatedAt: store.doc.updatedAt };
      },
      backup: async (d, _label, kind) => (local.backups.push({ doc: d, kind }), true),
      confirmWithoutBackup: async () => false,
      chooseFirst: async () => "later",
      chooseAcrossRelease: async () => (local.asked++, "later"),
      readBase: async () => local.base,
      writeBase: async (b) => {
        // 前の版のページは、基準に地図の版を書かない
        if (opts.old) {
          const { mapRelease: _drop, ...rest } = b;
          local.base = rest;
        } else local.base = b;
      },
      notice: () => undefined,
    },
    { debounceMs: 5, leaseMs: 20, retryMs: 10, resubscribeMs: 30 },
  );
  store.on("change", (info) => {
    if (info.source === "tx" || info.source === "undo" || info.source === "redo") sync.markDirty();
  });
  const edit = (title: string) => store.transact("add", (tx) => void tx.addNode(makeNode({ title })));
  const has = (d: DocData, title: string) => Object.values(d.nodes).some((n) => n.title === title);
  return { store, local, repo, sync, edit, has };
}

async function settled(sync: CloudSync, ms = 3000): Promise<void> {
  const t0 = Date.now();
  await tick(20);
  while (Date.now() - t0 < ms && (sync.state === "syncing" || sync.state === "pending" || sync.state === "connecting")) await tick(20);
}

const OLD_CARD = "前の版のページで止める前に書いたカード";
const NEW_CARD = "新しいページで足したカード";

/**
 * 前の版のページの端末 A（版 6 の地図・止める前に編集して送っていない）と、新しいページの端末 B（版 7 の地図にして編集し、薄い形で送った）。
 * 返す: A の保存してあった本体（太い形の版 6・止める前の編集つき）・A の基準（前の版のページが書いた: 地図の版が無い）・B
 */
async function twoDevices() {
  setThinBaseline(page);
  const { be } = memoryBackend();
  const r6 = buildR6Future().pv.doc;
  const old = device(be, "old", structuredClone(r6), { old: true });
  await old.sync.start();
  await settled(old.sync);
  const nw = device(be, "new", createEmptyDoc());
  await nw.sync.start();
  await settled(nw.sync);
  const migrated = thinBaselineDoc({ at: AT });
  migrated.id = r6.id;
  nw.store.replaceDoc(migrated, "地図を新しい版にする");
  nw.sync.markDirty();
  await settled(nw.sync);
  const opt = Object.values(nw.store.doc.nodes).find((n) => keyOf(n) === "r.keep")!;
  nw.store.transact("選ぶ", (tx) => tx.updateNode(opt.id, { status: "active" }));
  nw.edit(NEW_CARD);
  await settled(nw.sync);
  const after = (await nw.repo.readManifest())!;
  old.edit(OLD_CARD);
  await settled(old.sync);
  expect(old.sync.message).toContain("開き直して");
  old.sync.stop();
  expect(old.local.base!.mapRelease).toBeUndefined();
  return { be, leftover: old.store.doc, base: old.local.base!, nw, after };
}

/** A を新しいページで開き直した端末で同期し、アカウントの今の写しを返す */
async function reopen(env: Awaited<ReturnType<typeof twoDevices>>, local: DocData, base: SyncBase, boot: BootDoc | null) {
  const re = device(env.be, `p2-${++seq}`, local, { base, boot: () => boot });
  await re.sync.start();
  await settled(re.sync);
  const acct = (await new CloudRepo(env.be, "user1", "check").read())!;
  return { re, acct };
}

describe("起動したときの記録の決まり（nextBootDoc。App と同じ 1 か所: code-4）", () => {
  const base: SyncBase = { gen: "g1", docId: "d1", docUpdatedAt: "2026-11-01T00:00:00.000Z" };
  const on = { gen: "g1", docId: "d1", docUpdatedAt: "2026-11-01T00:00:00.000Z" };
  const edited = { id: "d1", updatedAt: "2026-11-02T00:00:00.000Z", fallback: false };

  it("まだ送っていない変更を持って起動した: 保存してあった形の地図の版を記録する（版をまたいで読んだなら前の版）", () => {
    expect(nextBootDoc(null, edited, 6, base, true)).toEqual({ ...edited, on, mapRelease: 6 });
  });

  it("手元が基準のまま（変更なし）なら版を書かない", () => {
    expect(nextBootDoc(null, { id: "d1", updatedAt: base.docUpdatedAt, fallback: false }, 7, base, true)).toEqual({ id: "d1", updatedAt: base.docUpdatedAt, fallback: false, on });
  });

  it("同じ基準の記録は残す: 後の起動（薄い形で保存し直した版 7 の本体）でも、前の版 6 のまま", () => {
    const cur: BootDoc = { ...edited, on, mapRelease: 6 };
    expect(nextBootDoc(cur, { ...edited, updatedAt: "2026-11-03T00:00:00.000Z" }, 7, base, true)).toBeNull();
  });

  it("前の版のページの記録（版が無い）に、引き継いだ手元の前の版を足す（id と更新時刻はそのまま: 古い手元の見分けに使う）", () => {
    const cur: BootDoc = { ...edited, on };
    expect(nextBootDoc(cur, { ...edited, updatedAt: "2026-11-04T00:00:00.000Z" }, 6, base, true)).toEqual({ ...edited, on, mapRelease: 6 });
  });

  it("送った・読み込んだ後（基準が変わった）の記録は使わず、この手元で記録し直す。代わりの内容で始めたときも", () => {
    const stale: BootDoc = { ...edited, on: { ...on, gen: "g0" }, mapRelease: 6 };
    expect(nextBootDoc(stale, edited, 7, base, true)).toEqual({ ...edited, on, mapRelease: 7 });
    const cur: BootDoc = { ...edited, on, mapRelease: 6 };
    expect(nextBootDoc(cur, { id: "d9", updatedAt: "2026-11-05T00:00:00.000Z", fallback: true }, null, base, true)).toEqual({ id: "d9", updatedAt: "2026-11-05T00:00:00.000Z", fallback: true, on });
  });

  it("どのアカウントとも同期していないブラウザ: 基準は分からない（on は undefined）", () => {
    expect(nextBootDoc(null, edited, 6, null, false)).toEqual({ ...edited, on: undefined, mapRelease: 6 });
  });
});

describe("引き継いだタブ・記録の無い開き直しでも聞く（loss-2・skew-1）", () => {
  it("記録が無い（前の版のページが基準を書いたときに消した）: 基準に地図の版が無い（前の版のページの基準）ので聞く。アカウントは新しいページの内容のまま", async () => {
    const env = await twoDevices();
    // 開き直したタブ: 保存してあった本体を起動で引き上げて読んだ物（同じ物を持ち続けていない形: 写しにする）
    const local = structuredClone(decodeStored(JSON.parse(JSON.stringify(env.leftover))).doc);
    expect(mapReleaseOf(local)).toBe(7);
    expect(storedMapReleaseOf(local)).toBeUndefined();
    const { re, acct } = await reopen(env, local, env.base, null);
    expect(re.local.asked).toBe(1);
    expect(re.sync.state).toBe("paused");
    expect(acct.manifest.gen).toBe(env.after.gen);
    expect(env.nw.has(acct.doc, NEW_CARD)).toBe(true);
    expect(Object.values(acct.doc.nodes).find((n) => keyOf(n) === "r.keep")!.status).toBe("active");
    // 手元の編集も残る（送らず・捨てず）
    expect(re.has(re.store.doc, OLD_CARD)).toBe(true);
    re.sync.stop();
    env.nw.sync.stop();
  });

  it("前の版のページの記録（地図の版が無い）でも同じく聞く", async () => {
    const env = await twoDevices();
    const local = structuredClone(decodeStored(JSON.parse(JSON.stringify(env.leftover))).doc);
    const b = env.base;
    const rec: BootDoc = { id: local.id, updatedAt: local.updatedAt, fallback: false, on: { gen: b.gen, docId: b.docId, docUpdatedAt: b.docUpdatedAt } };
    const { re, acct } = await reopen(env, local, b, rec);
    expect(re.local.asked).toBe(1);
    expect(env.nw.has(acct.doc, NEW_CARD)).toBe(true);
    re.sync.stop();
    env.nw.sync.stop();
  });

  it("手がかりは 1 つずつでも効く: 版をまたいで読んだ手元（保存してあった形は版 6）だけ・起動したときの記録だけ", async () => {
    // 基準を新しいページが書いた物にする（地図の版 7: 基準の手がかりは効かない）
    for (const how of ["stored", "record"] as const) {
      const env = await twoDevices();
      const decoded = decodeStored(JSON.parse(JSON.stringify(env.leftover))).doc;
      expect(storedMapReleaseOf(decoded)).toBe(6);
      const local = how === "stored" ? decoded : structuredClone(decoded);
      const base: SyncBase = { ...env.base, mapRelease: 7 };
      const rec: BootDoc | null = how === "record" ? { id: local.id, updatedAt: local.updatedAt, fallback: false, on: { gen: base.gen, docId: base.docId, docUpdatedAt: base.docUpdatedAt }, mapRelease: 6 } : null;
      const { re, acct } = await reopen(env, local, base, rec);
      expect(re.local.asked, how).toBe(1);
      expect(env.nw.has(acct.doc, NEW_CARD), how).toBe(true);
      re.sync.stop();
      env.nw.sync.stop();
    }
  });

  it("比べ: どの手がかりも版 7 なら、今までどおりの重なり（聞かずに手元で送り、アカウントの内容はバックアップに）", async () => {
    const env = await twoDevices();
    const local = structuredClone(decodeStored(JSON.parse(JSON.stringify(env.leftover))).doc);
    const base: SyncBase = { ...env.base, mapRelease: 7 };
    const { re, acct } = await reopen(env, local, base, null);
    expect(re.local.asked).toBe(0);
    expect(re.has(acct.doc, OLD_CARD)).toBe(true);
    expect(re.local.backups.some((b) => b.kind === "conflict" && env.nw.has(b.doc, NEW_CARD))).toBe(true);
    re.sync.stop();
    env.nw.sync.stop();
  });

  it("アカウントの写しも前の版（版 6）の地図なら聞かない: 写しの版は保存してあった形で比べる（読むと引き上げて版 7 になっても: code-5）", async () => {
    setThinBaseline(page);
    const { be } = memoryBackend();
    const r6 = buildR6Future().pv.doc;
    // 前の版のページの端末 2 つ: どちらも版 6 の地図。1 つが先に編集を送った
    const a = device(be, "a", structuredClone(r6), { old: true });
    await a.sync.start();
    await settled(a.sync);
    const base = a.local.base!;
    const b = device(be, "b", structuredClone(r6), { old: true, base });
    await b.sync.start();
    await settled(b.sync);
    b.edit("前の版のページの端末 B のカード");
    await settled(b.sync);
    b.sync.stop();
    a.edit(OLD_CARD);
    a.sync.stop();
    // A を新しいページで開き直す（起動で引き上げる。記録は版 6）
    const local = decodeStored(JSON.parse(JSON.stringify(a.store.doc))).doc;
    const rec: BootDoc = { id: local.id, updatedAt: local.updatedAt, fallback: false, on: { gen: base.gen, docId: base.docId, docUpdatedAt: base.docUpdatedAt }, mapRelease: 6 };
    const re = device(be, `p2-${++seq}`, local, { base, boot: () => rec });
    await re.sync.start();
    await settled(re.sync);
    // ふつうの重なり: 聞かずに手元で送り、相手（版 6 の写し）はバックアップに
    expect(re.local.asked).toBe(0);
    expect(re.local.backups.some((x) => x.kind === "conflict" && x.doc.nodes && Object.values(x.doc.nodes).some((n) => n.title === "前の版のページの端末 B のカード"))).toBe(true);
    re.sync.stop();
  });

  it("新しいページが書く基準には、そのときの手元の地図の版が入る（送った物・読み込んだ物）", async () => {
    const env = await twoDevices();
    expect(env.nw.local.base!.mapRelease).toBe(7);
    expect(PRE_THIN_RELEASE).toBe(6);
    env.nw.sync.stop();
  });

  it("本物の保存の道: 前の版のページのタブがロックを持ったまま、閲覧のみで開いたタブが引き継ぎ（takeOver）→ 記録 → 突き合わせで聞く", async () => {
    const env = await twoDevices();
    enableThinPage(async () => page);
    setThinBaseline(null);
    const kv = memoryKV();
    const name = `guard-${++seq}`;
    const lk = fakeLocks();
    // 前の版のページのタブ（ロックを持ち続ける）が、止める前の編集を保存した本体（太い形の版 6）
    const holder = new Persistence({ dbName: name, kv, locks: lk.locks, channel: false, debounceMs: 1 });
    await holder.open();
    expect(await holder.acquireWriter()).toBe(true);
    await holder.loadInitial();
    holder.attach(() => env.leftover);
    holder.markDirty();
    await holder.flush();
    // 新しいページのタブ: 閲覧のみで起動（起動したときの記録は書かない）
    const tab = new Persistence({ dbName: name, kv, locks: lk.locks, channel: false, debounceMs: 1 });
    await tab.open();
    expect(await tab.acquireWriter()).toBe(false);
    const boot = await tab.loadInitial();
    expect(boot.doc && mapReleaseOf(boot.doc)).toBe(7);
    // 「このタブで編集する」: 引き継いだ手元を記録してから突き合わせる（App.takeOver と同じ順）
    const doc = (await tab.takeOver())!;
    expect(tab.writer).toBe(true);
    const rec = nextBootDoc(null, { id: doc.id, updatedAt: doc.updatedAt, fallback: false }, storedMapReleaseOf(doc) ?? mapReleaseOf(doc), env.base, true);
    expect(rec?.mapRelease).toBe(6);
    const { re, acct } = await reopen(env, doc, env.base, rec);
    expect(re.local.asked).toBe(1);
    expect(acct.manifest.gen).toBe(env.after.gen);
    expect(env.nw.has(acct.doc, NEW_CARD)).toBe(true);
    re.sync.stop();
    env.nw.sync.stop();
    holder.close();
    tab.close();
  });

  it("本物の保存の道: 編集できるタブとして起動（loadInitial で版 6 の本体を引き上げる）→ 記録（版 6）→ 突き合わせで聞く（code-4）", async () => {
    const env = await twoDevices();
    enableThinPage(async () => page);
    setThinBaseline(null);
    const kv = memoryKV();
    const name = `guard-${++seq}`;
    const w = new Persistence({ dbName: name, kv, locks: null, channel: false, debounceMs: 1 });
    await w.open();
    await w.acquireWriter();
    await w.loadInitial();
    w.attach(() => env.leftover);
    w.markDirty();
    await w.flush();
    w.close();
    const p = new Persistence({ dbName: name, kv, locks: null, channel: false, debounceMs: 1 });
    await p.open();
    await p.acquireWriter();
    const boot = await p.loadInitial();
    const doc = boot.doc!;
    expect(boot.upgrade?.legacy).toBeDefined();
    const rec = nextBootDoc(null, { id: doc.id, updatedAt: doc.updatedAt, fallback: false }, storedMapReleaseOf(doc) ?? mapReleaseOf(doc), env.base, true);
    expect(rec?.mapRelease).toBe(6);
    // 起動の後に 1 度保存して（薄い形の版 7）、閉じて開き直しても、同じ基準の記録は版 6 のまま
    p.attach(() => doc);
    await p.flush();
    expect(nextBootDoc(rec, { id: doc.id, updatedAt: doc.updatedAt, fallback: false }, 7, env.base, true)).toBeNull();
    const { re, acct } = await reopen(env, structuredClone(doc), { ...env.base, mapRelease: 7 }, rec);
    expect(re.local.asked).toBe(1);
    expect(env.nw.has(acct.doc, NEW_CARD)).toBe(true);
    re.sync.stop();
    env.nw.sync.stop();
    p.close();
  });
});
