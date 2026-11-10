import { describe, expect, it, vi } from "vitest";
import { buildDemoDoc, isDisposableDoc } from "../../src/demo/demo";
import { buildStressDoc } from "../../src/demo/stress";
import { buildWishlist } from "../../src/demo/wishlistBundle";
import { SCHEMA_VERSION, createEmptyDoc, makeNode } from "../../src/model/schema";
import type { DocData } from "../../src/model/types";
import { CloudRepo, CloudSync, baseCovered, decodeDoc, encodeDoc, type BootDoc, type CloudBackend, type CloudDoc, type Manifest, type SyncBase } from "../../src/persist/cloud";
import { mergeDocs } from "../../src/persist/io";
import { Store } from "../../src/store/store";

const LIMIT = 256 * 1024;
const bytesOf = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** db の代わり（256 KiB の上限は UTF-8 のバイトで数える・購読・貸し出し・一覧を真似る） */
function memoryBackend() {
  const docs = new Map<string, Record<string, unknown>>();
  const watchers = new Map<string, Set<(d: CloudDoc) => void>>();
  const leases = new Map<string, { holder: string; until: number }>();
  const state = { failNext: "" as string, writes: 0, manifestWrites: 0 };
  const snap = (path: string): CloudDoc => {
    const d = docs.get(path);
    return d ? { exists: true, data: structuredClone(d) } : { exists: false };
  };
  const notify = (path: string) => {
    for (const fn of watchers.get(path) ?? []) queueMicrotask(() => fn(snap(path)));
  };
  const be: CloudBackend = {
    async get(path) {
      return snap(path);
    },
    async set(path, data) {
      if (state.failNext) {
        const code = state.failNext;
        state.failNext = "";
        throw { code, message: code };
      }
      if (bytesOf(data) > LIMIT) throw { code: "invalid_argument", message: "too big" };
      state.writes++;
      if (!path.includes("/parts/")) state.manifestWrites++;
      docs.set(path, structuredClone(data));
      notify(path);
    },
    async delete(path) {
      docs.delete(path);
      notify(path);
    },
    watch(path, next) {
      let set = watchers.get(path);
      if (!set) watchers.set(path, (set = new Set()));
      set.add(next);
      queueMicrotask(() => next(snap(path)));
      return () => set!.delete(next);
    },
    async lease(path, holder, ttlMs) {
      const cur = leases.get(path);
      if (cur && cur.holder !== holder && cur.until > Date.now()) return false;
      leases.set(path, { holder, until: Date.now() + ttlMs });
      return true;
    },
    async list(path) {
      return [...docs.keys()]
        .filter((k) => k.startsWith(`${path}/`) && !k.slice(path.length + 1).includes("/"))
        .map((k) => ({ id: k.slice(path.length + 1), data: structuredClone(docs.get(k)) }));
    },
  };
  const partGens = () => new Set([...docs.keys()].filter((k) => k.includes("/parts/")).map((k) => k.split("/parts/")[1]!.replace(/-\d+$/, "")));
  return { be, docs, state, leases, partGens };
}

/** 端末ごとの遅い回線（分割の読み書きだけ遅くする） */
function slow(be: CloudBackend, flags: { getMs: number; setMs: number }): CloudBackend {
  return {
    ...be,
    async get(path) {
      if (flags.getMs && path.includes("/parts/")) await tick(flags.getMs);
      return be.get(path);
    },
    async set(path, data) {
      if (flags.setMs && path.includes("/parts/")) await tick(flags.setMs);
      return be.set(path, data);
    },
  };
}

/** 1 つのブラウザの IndexedDB（同期の基準・起動したときの手元の記録）。同じブラウザのタブ・開き直しで共有する */
interface Browser {
  base: SyncBase | null;
  boot: BootDoc | null;
}
const browser = (base: SyncBase | null = null): Browser => ({ base, boot: null });

interface DeviceOpts {
  uid?: string;
  base?: SyncBase | null;
  /** このブラウザ（同じブラウザで開き直す・別のタブ）。無ければ新しいブラウザ */
  idb?: Browser;
  writer?: boolean;
  debounceMs?: number;
  leaseMs?: number;
  retryMs?: number;
  /** 初めての同期で聞かれたときの答え */
  choice?: "remote" | "local" | "later";
  /** バックアップを作れない保存先（localStorage だけのブラウザ） */
  canBackup?: boolean;
  foreign?: boolean;
  /** バックアップを作れないとき、書き出して続けると答えるか */
  confirmNoBackup?: boolean;
  /** 入れ替えの後、手元へ保存するのにかかる時間（その間の編集を見る） */
  adoptFlushMs?: number;
  /** 保存してあった内容を読めず、代わりの内容（デモ・バックアップ）で始めた */
  fallback?: boolean;
  /** App と同じく、手元に保存できないと基準を書かずに持っておく（local.saveFails の間） */
  deferBase?: boolean;
}

const onOf = (b: SyncBase | null): BootDoc["on"] => (b ? { gen: b.gen, docId: b.docId, docUpdatedAt: b.docUpdatedAt } : null);
const sameOn = (a: BootDoc["on"], b: BootDoc["on"]) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null) && (a === undefined) === (b === undefined);

/** 1 つの端末（App と同じつなぎ方: 本物の Store。取り込み中は markDirty しない。初回・選択の取り込みは Undo の対象外） */
function device(be: CloudBackend, name: string, doc: DocData, opts: DeviceOpts = {}) {
  const store = new Store(doc);
  const idb = opts.idb ?? browser();
  if (opts.base !== undefined) idb.base = opts.base;
  const local = {
    get base(): SyncBase | null {
      return idb.base;
    },
    set base(b: SyncBase | null) {
      idb.base = b;
    },
    idb,
    backups: [] as Array<{ doc: DocData; label: string; kind?: string }>,
    notices: [] as string[],
    adopted: [] as string[],
    asked: 0,
    confirms: [] as string[],
    writer: opts.writer ?? true,
    adopting: false,
    editing: false,
    /** 聞かれている間に呼ぶ（書き手でなくなる など） */
    onAsk: null as null | (() => void),
    /** 入れ替えの途中（手元を残している間）に呼ぶ（入力が始まる など） */
    onAdopt: null as null | (() => void),
    /** 手元に保存できない（基準を書かずに持っておく） */
    saveFails: false,
    pendingBase: null as SyncBase | null,
  };
  // 起動したときの手元を記録する（App と同じ: 編集できるタブだけ。前の記録が同じ基準のままならそれを残し、
  // 基準が書き換わっていた・代わりの内容で始めたなら書き換える）
  const on = onOf(idb.base);
  if (local.writer && (!idb.boot || opts.fallback || !sameOn(idb.boot.on, on))) idb.boot = { id: doc.id, updatedAt: doc.updatedAt, fallback: !!opts.fallback, on };
  const repo = new CloudRepo(be, opts.uid ?? "user1", name);
  const sync = new CloudSync(
    repo,
    {
      getDoc: () => store.doc,
      bootDoc: async () => (local.pendingBase ? null : idb.boot),
      isWriter: () => local.writer,
      isDisposable: (d) => isDisposableDoc(d),
      isEditing: () => local.editing,
      isForeign: () => !!opts.foreign,
      adopt: async (d, how, stillOk) => {
        if (!local.writer || !stillOk()) return null;
        if (how === "choice") {
          if (opts.canBackup === false) {
            local.confirms.push("browser");
            if (!opts.confirmNoBackup) return null;
          } else local.backups.push({ doc: store.doc, label: "切り替える前のこのブラウザの内容", kind: "kept" });
        }
        local.onAdopt?.();
        await tick(1);
        if (!local.writer || !stillOk()) return null;
        if (how === "remote") {
          local.adopting = true;
          try {
            store.replaceDoc(d, "別の端末の内容を読み込む");
          } finally {
            local.adopting = false;
          }
        } else store.load(d, "load");
        // 入れ替えた瞬間の印（App と同じ: この後の手元への保存の間の編集は、次の送信へ）
        const ident = { id: store.doc.id, updatedAt: store.doc.updatedAt };
        if (opts.adoptFlushMs) await tick(opts.adoptFlushMs);
        local.adopted.push(how);
        return ident;
      },
      backup: async (d, label, kind) => {
        if (opts.canBackup === false) return false;
        local.backups.push({ doc: d, label, kind });
        return true;
      },
      confirmWithoutBackup: async (_d, what) => {
        local.confirms.push(what);
        return !!opts.confirmNoBackup;
      },
      chooseFirst: async () => {
        local.asked++;
        local.onAsk?.();
        return opts.choice ?? "later";
      },
      readBase: async () => local.pendingBase ?? idb.base,
      // 基準を書いたら、起動したときの手元の記録は済んだ（App と同じく、手元に保存できないうちは持っておく）
      writeBase: async (b) => {
        if (opts.deferBase && local.saveFails) {
          local.pendingBase = local.writer ? b : null;
          return;
        }
        local.pendingBase = null;
        idb.base = b;
        idb.boot = null;
      },
      notice: (t, tone) => void local.notices.push(`${tone}:${t}`),
    },
    { debounceMs: opts.debounceMs ?? 5, leaseMs: opts.leaseMs ?? 20, retryMs: opts.retryMs ?? 10, resubscribeMs: 30 },
  );
  store.on("change", (info) => {
    if (info.source === "tx" || info.source === "undo" || info.source === "redo" || (info.source === "replace" && !local.adopting)) sync.markDirty();
  });
  const edit = (title: string) => store.transact("add", (tx) => void tx.addNode(makeNode({ title })));
  const has = (title: string) => Object.values(store.doc.nodes).some((n) => n.title === title);
  return { store, local, repo, sync, edit, has };
}

const remoteHas = async (repo: CloudRepo, title: string) => Object.values((await repo.read())!.doc.nodes).some((n) => n.title === title);

/** 何もしていないデモではない中身（このブラウザで書いた物） */
function realDoc(title: string): DocData {
  const d = createEmptyDoc("わたしの計画");
  const n = makeNode({ title });
  d.nodes[n.id] = n;
  return d;
}

describe("符号化と保存先", () => {
  it("gzip + base64 で往復でき、2,000 ノードでも分割の 1 つずつが 256 KiB（バイト）に収まる", async () => {
    const demo = buildDemoDoc();
    const e = await encodeDoc(demo);
    expect(e.enc).toBe("gzip-b64");
    expect(await decodeDoc(e.enc, e.payload)).toEqual(demo);

    const { be, docs } = memoryBackend();
    const repo = new CloudRepo(be, "u", "dev");
    const big = buildStressDoc(2000);
    const m = await repo.write(big, null);
    for (const [, d] of docs) expect(bytesOf(d)).toBeLessThan(LIMIT);
    expect(m.bytes).toBeGreaterThan(LIMIT); // そのままでは入らない大きさ
    const back = await repo.read();
    expect(back!.doc).toEqual(big);
    expect(back!.manifest.nodes).toBe(2000);
  });

  it("やりたいことリスト（2,000 件・日本語の本文つき）も、分割して往復できる", async () => {
    const { be, docs } = memoryBackend();
    const repo = new CloudRepo(be, "u", "dev");
    const wish = buildWishlist(new Date(2026, 10, 10)).pv.doc;
    const m = await repo.write(wish, null);
    for (const [, d] of docs) expect(bytesOf(d)).toBeLessThan(LIMIT);
    const back = await repo.read();
    expect(back!.doc).toEqual(wish);
    expect(back!.manifest.nodes).toBe(Object.keys(wish.nodes).length);
    expect(m.nodes).toBeGreaterThan(2000);
  });

  it("圧縮の無いブラウザでも、日本語の多い内容の分割が 256 KiB を超えない（UTF-8 を base64 に）", async () => {
    const saved = globalThis.CompressionStream;
    (globalThis as { CompressionStream?: unknown }).CompressionStream = undefined;
    try {
      const doc = buildDemoDoc();
      for (let i = 0; i < 300; i++) {
        const n = makeNode({ title: `日本語のノード ${i}`, body: "広告運用を学び、実績を積み上げて独立する。".repeat(12) });
        doc.nodes[n.id] = n;
      }
      const { be, docs } = memoryBackend();
      const a = device(be, "A", doc);
      await a.sync.start();
      expect(a.sync.state).toBe("synced");
      for (const [, d] of docs) expect(bytesOf(d)).toBeLessThan(LIMIT);
      const m = await a.repo.readManifest();
      expect(m!.enc).toBe("utf8-b64");
      expect(m!.parts).toBeGreaterThan(1);
      expect((await a.repo.read())!.doc).toEqual(a.store.doc);
      a.sync.stop();
    } finally {
      (globalThis as { CompressionStream?: unknown }).CompressionStream = saved;
    }
  });

  it("古い世代は 2 分たってから片付け、覚えておく数を超えた世代はすぐ消す（どこからも指されない分割を残さない）", async () => {
    const { be, docs, partGens } = memoryBackend();
    let now = 1_000_000;
    const repo = new CloudRepo(be, "u", "dev", () => now);
    const doc = buildDemoDoc();
    const m1 = await repo.write(doc, null);
    const m2 = await repo.write(doc, m1);
    expect(m2.stale.map((s) => s.gen)).toEqual([m1.gen]);
    expect([...docs.keys()].filter((k) => k.includes(m1.gen))).toHaveLength(m1.parts); // まだ残す
    now = Date.parse(m1.savedAt) + 3 * 60_000;
    const m3 = await repo.write(doc, m2);
    expect([...docs.keys()].filter((k) => k.includes(m1.gen))).toHaveLength(0);
    expect(m3.stale.map((s) => s.gen)).toEqual([m2.gen]);
    // 2 分以内に何十回も書いても、溢れた世代は消える
    now = Date.parse(m3.savedAt);
    let m = m3;
    for (let i = 0; i < 30; i++) m = await repo.write(doc, m);
    expect(m.stale.length).toBeLessThanOrEqual(20);
    const live = new Set([m.gen, ...m.stale.map((s) => s.gen)]);
    expect([...partGens()].filter((g) => !live.has(g))).toEqual([]);
  });

  it("分割が消えていたら読み直し、壊れていたら壊れた世代を添えて知らせる", async () => {
    const { be, docs } = memoryBackend();
    const repo = new CloudRepo(be, "u", "dev");
    const m = await repo.write(buildDemoDoc(), null);
    // 同じ世代を指したまま何度読んでも無い: その世代が壊れている（書き直せるように世代を添える）
    docs.delete(`data/users/u/fourd/parts/${m.gen}-0`);
    await expect(repo.read()).rejects.toMatchObject({ code: "corrupt", gen: m.gen });
    await repo.write(buildDemoDoc(), m);
    const m2 = await repo.readManifest();
    docs.set(`data/users/u/fourd/parts/${m2!.gen}-0`, { gen: m2!.gen, i: 0, savedAt: "", data: "AAAA" });
    await expect(repo.read()).rejects.toMatchObject({ code: "corrupt", gen: m2!.gen });
  });

  it("掃除: マニフェストから指されない古い分割を消し、新しい物（書き込み途中かもしれない）と使っている物は残す", async () => {
    const { be, docs } = memoryBackend();
    const now = 5_000_000;
    const repo = new CloudRepo(be, "u", "dev", () => now);
    const m = await repo.write(buildDemoDoc(), null);
    docs.set("data/users/u/fourd/parts/gOLD-0", { gen: "gOLD", i: 0, savedAt: new Date(now - 60 * 60_000).toISOString(), data: "x" });
    docs.set("data/users/u/fourd/parts/gYOUNG-0", { gen: "gYOUNG", i: 0, savedAt: new Date(now - 60_000).toISOString(), data: "x" });
    expect(await repo.sweep(m)).toBe(1);
    expect(docs.has("data/users/u/fourd/parts/gOLD-0")).toBe(false);
    expect(docs.has("data/users/u/fourd/parts/gYOUNG-0")).toBe(true);
    expect(docs.has(`data/users/u/fourd/parts/${m.gen}-0`)).toBe(true);
  });

  it("分割の書き込みが途中で失敗したら、書けた分を消す", async () => {
    const { be, partGens } = memoryBackend();
    let n = 0;
    const flaky: CloudBackend = {
      ...be,
      async set(path, data) {
        if (path.includes("/parts/") && ++n === 2) throw { code: "unavailable", message: "x" };
        return be.set(path, data);
      },
    };
    const repo = new CloudRepo(flaky, "u", "dev");
    const p = await repo.prepare(buildStressDoc(2000));
    expect(p.parts.length).toBeGreaterThan(1);
    await expect(repo.writeParts(p)).rejects.toMatchObject({ code: "unavailable" });
    expect([...partGens()]).toEqual([]);
  });
});

describe("同期の決まり: 初めての同期", () => {
  it("初めての端末: クラウドが空なら手元を送る", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", buildDemoDoc());
    await a.sync.start();
    expect(a.sync.state).toBe("synced");
    expect((await a.repo.read())!.doc.id).toBe(a.store.doc.id);
    a.sync.stop();
  });

  it("新しい端末（何もしていないデモ）はアカウントの内容を読み込み、その読み込みは「元に戻す」で戻らない（R14）", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", buildDemoDoc());
    await a.sync.start();
    a.edit("本物の内容");
    await a.sync.flush();
    const b = device(be, "B", buildDemoDoc());
    await b.sync.start();
    expect(b.local.adopted).toEqual(["first"]);
    expect(b.has("本物の内容")).toBe(true);
    expect(b.local.notices.join()).toContain("info:アカウントに保存されていた内容を読み込みました");
    expect(b.local.backups).toHaveLength(0);
    // 1 つ編集して、元に戻すを 2 回押しても、デモには戻らない
    b.edit("B での編集");
    b.store.undo();
    b.store.undo();
    expect(b.has("本物の内容")).toBe(true);
    await b.sync.flush();
    await tick(80);
    expect(await remoteHas(b.repo, "本物の内容")).toBe(true);
    expect(a.has("本物の内容")).toBe(true);
    a.sync.stop();
    b.sync.stop();
  });

  it("前にクラウドなしで開いて保存されたデモ（基準なし）は、次にアカウントの内容を読み込む（R15）", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", buildDemoDoc());
    await a.sync.start();
    a.edit("本物の内容");
    await a.sync.flush();
    const b = device(be, "B", buildDemoDoc());
    await b.sync.start();
    await tick(60);
    expect(b.has("本物の内容")).toBe(true);
    expect(await remoteHas(b.repo, "本物の内容")).toBe(true);
    expect(a.has("本物の内容")).toBe(true);
    expect(b.local.notices.some((x) => x.startsWith("warn:"))).toBe(false);
    a.sync.stop();
    b.sync.stop();
  });

  it("デモのノードを動かしただけ・畳んだだけなら、まだ捨ててよい手元として読み込む（R8）", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", buildDemoDoc());
    await a.sync.start();
    a.edit("本物の内容");
    await a.sync.flush();
    const b = device(be, "B", buildDemoDoc());
    const first = Object.keys(b.store.doc.nodes)[0]!;
    b.store.transact("移動", (tx) => void tx.updateNode(first, { x: b.store.doc.nodes[first]!.x + 10, collapsed: true }));
    await b.sync.start();
    await tick(60);
    expect(b.has("本物の内容")).toBe(true);
    expect(await remoteHas(b.repo, "本物の内容")).toBe(true);
    a.sync.stop();
    b.sync.stop();
  });

  it("同期したことの無いブラウザに中身があり、アカウントにはデモしか無ければ、聞かずに手元を送る", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", buildDemoDoc());
    await a.sync.start(); // アカウントにはデモ
    const b = device(be, "B", realDoc("このブラウザで 1 週間書いた内容"));
    await b.sync.start();
    await tick(60); // A の貸し出しが切れてから送る
    expect(b.local.asked).toBe(0);
    expect(await remoteHas(b.repo, "このブラウザで 1 週間書いた内容")).toBe(true);
    await tick(80);
    expect(a.has("このブラウザで 1 週間書いた内容")).toBe(true); // A は何もしていないので取り込む
    a.sync.stop();
    b.sync.stop();
  });

  it("両方に中身があれば聞き、決めるまで何も送らない。編集しても送らず、「同期をやり直す」でまた聞く", async () => {
    const { be, state } = memoryBackend();
    const a = device(be, "A", realDoc("アカウントの内容"));
    await a.sync.start();
    const writes = state.writes;
    const b = device(be, "B", realDoc("このブラウザの内容"), { choice: "later" });
    await b.sync.start();
    expect(b.local.asked).toBe(1);
    expect(b.sync.state).toBe("paused");
    b.edit("決める前の編集");
    await b.sync.flush();
    await tick(60);
    expect(state.writes).toBe(writes);
    expect(await remoteHas(a.repo, "アカウントの内容")).toBe(true);
    b.sync.resync();
    await tick(60);
    expect(b.local.asked).toBe(2);
    a.sync.stop();
    b.sync.stop();
  });

  it("「アカウントの内容を使う」: このブラウザの内容はバックアップに残して読み込む（元に戻すの対象外）", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", realDoc("アカウントの内容"));
    await a.sync.start();
    const b = device(be, "B", realDoc("このブラウザの内容"), { choice: "remote" });
    await b.sync.start();
    expect(b.local.adopted).toEqual(["choice"]);
    expect(b.has("アカウントの内容")).toBe(true);
    expect(b.local.backups.some((x) => Object.values(x.doc.nodes).some((n) => n.title === "このブラウザの内容"))).toBe(true);
    expect(b.store.history.canUndo).toBe(false);
    expect(b.sync.state).toBe("synced");
    a.sync.stop();
    b.sync.stop();
  });

  it("「このブラウザの内容を使う」: アカウントの内容をバックアップに残してから送る", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", realDoc("アカウントの内容"));
    await a.sync.start();
    const b = device(be, "B", realDoc("このブラウザの内容"), { choice: "local" });
    await b.sync.start();
    await tick(60); // A の貸し出しが切れてから送る
    expect(b.local.backups.some((x) => Object.values(x.doc.nodes).some((n) => n.title === "アカウントの内容"))).toBe(true);
    expect(await remoteHas(b.repo, "このブラウザの内容")).toBe(true);
    a.sync.stop();
    b.sync.stop();
  });

  it("別のアカウントで同期していた中身は、聞かずに今のアカウントへ送らない（R7）", async () => {
    const { be, state } = memoryBackend();
    // アカウント Y にはまだ何も無い
    const shared = device(be, "shared", realDoc("X の個人的な内容"), { uid: "Y", foreign: true, choice: "later" });
    await shared.sync.start();
    expect(shared.local.asked).toBe(1);
    expect(state.writes).toBe(0);
    expect(shared.sync.state).toBe("paused");
    shared.sync.stop();
    // Y の内容がある場合も、聞かずに置き換えない
    const yPhone = device(be, "Yphone", realDoc("Y の大事な内容"), { uid: "Y" });
    await yPhone.sync.start();
    const again = device(be, "shared2", realDoc("X の個人的な内容"), { uid: "Y", foreign: true, choice: "later" });
    await again.sync.start();
    await tick(60);
    expect(again.local.asked).toBe(1);
    expect(await remoteHas(yPhone.repo, "Y の大事な内容")).toBe(true);
    expect(yPhone.has("Y の大事な内容")).toBe(true);
    yPhone.sync.stop();
    again.sync.stop();
  });
});

describe("同期の決まり: ふだんの同期", () => {
  it("手元が変わらない間に別の端末が書いたら、見張りで取り込む", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", buildDemoDoc());
    await a.sync.start();
    const b = device(be, "B", buildDemoDoc());
    await b.sync.start();
    b.edit("B の変更");
    await b.sync.flush();
    await tick(120);
    expect(a.has("B の変更")).toBe(true);
    expect(a.local.backups).toHaveLength(0);
    a.sync.stop();
    b.sync.stop();
  });

  it("取り込み（追加）も送り、送る物が無ければ「同期済み」に戻る（R1・R12）", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", buildDemoDoc());
    await a.sync.start();
    const incoming = createEmptyDoc("取り込むファイル");
    const n = makeNode({ title: "取り込んだノード" });
    incoming.nodes[n.id] = n;
    a.store.replaceDoc(mergeDocs(a.store.doc, incoming).doc, "インポート（追加）");
    await a.sync.flush();
    expect(await remoteHas(a.repo, "取り込んだノード")).toBe(true);
    expect(a.sync.state).toBe("synced");
    // 送る物が無いときの flush も「同期済み」
    a.sync.markDirty();
    await a.sync.flush();
    expect(a.sync.state).toBe("synced");
    a.sync.stop();
  });

  it("両方が変わったら、手元で送り、相手の内容はバックアップに残す（どちらも消えない）", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", buildDemoDoc());
    await a.sync.start();
    const b = device(be, "B", buildDemoDoc());
    await b.sync.start();
    a.sync.stop(); // A はオフラインのつもり
    const a2 = device(be, "A", a.store.doc, { base: a.local.base });
    b.edit("B の変更");
    await b.sync.flush();
    // A の貸し出しが残っていると B は少し待ってから送る: 届くまで待つ
    for (let i = 0; i < 50 && !(await remoteHas(b.repo, "B の変更")); i++) await tick(10);
    a2.edit("A の変更");
    await a2.sync.start();
    await tick(120);
    expect(a2.local.backups).toHaveLength(1);
    expect(Object.values(a2.local.backups[0]!.doc.nodes).some((n) => n.title === "B の変更")).toBe(true);
    expect(await remoteHas(a2.repo, "A の変更")).toBe(true);
    expect(a2.local.notices.join()).toContain("warn:");
    a2.sync.stop();
    b.sync.stop();
  });

  it("基準を失っても、中身が同じなら重なりとして扱わない", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", buildDemoDoc());
    await a.sync.start();
    a.sync.stop();
    const again = device(be, "A", a.store.doc);
    await again.sync.start();
    expect(again.local.backups).toHaveLength(0);
    expect(again.local.adopted).toEqual([]);
    expect(again.sync.state).toBe("synced");
    again.sync.stop();
  });

  it("連続した入力はまとめて送り、20 秒（ここでは 200ms）を超えて打ち続けても編集のたびには送らない（R5）", async () => {
    const { be, state, partGens } = memoryBackend();
    const a = device(slow(be, { getMs: 5, setMs: 15 }), "A", buildDemoDoc(), { debounceMs: 50 });
    await a.sync.start();
    const start = state.manifestWrites;
    for (let i = 0; i < 100; i++) {
      a.edit(`入力 ${i}`);
      await tick(10);
    }
    await a.sync.flush();
    await tick(100);
    const pushes = state.manifestWrites - start;
    expect(pushes).toBeLessThanOrEqual(8); // 1 秒あまりの連続入力: 200ms ごと（約 5〜6 回）+ 最後
    expect(await remoteHas(a.repo, "入力 99")).toBe(true);
    const m = await a.repo.readManifest();
    const live = new Set([m!.gen, ...m!.stale.map((s) => s.gen)]);
    expect([...partGens()].filter((g) => !live.has(g))).toEqual([]);
    a.sync.stop();
  });

  it("閲覧のみのタブが引き継ぐと、保存してある基準から突き合わせ、別の端末の新しい内容を取り込む（R2）", async () => {
    const { be } = memoryBackend();
    // 同じ端末の 2 つのタブが共有する IndexedDB（基準）
    const idb = browser();
    const tab1 = device(be, "T1", buildDemoDoc(), { idb });
    await tab1.sync.start();
    const tab2 = device(be, "T2", tab1.store.doc, { writer: false, idb });
    await tab2.sync.start(); // 閲覧のみ
    tab1.edit("タブ1の変更");
    await tab1.sync.flush();
    tab1.sync.stop(); // タブ 1 を閉じる
    const phone = device(be, "P", buildDemoDoc());
    await phone.sync.start();
    expect(phone.has("タブ1の変更")).toBe(true);
    phone.edit("スマホの変更");
    await phone.sync.flush();
    // タブ 2 で「このタブで編集する」: 保存されていたタブ 1 の内容を読み、突き合わせをやり直す
    tab2.store.load(tab1.store.doc, "load");
    tab2.local.writer = true;
    tab2.sync.resync();
    await tick(150);
    expect(tab2.has("スマホの変更")).toBe(true);
    expect(tab2.local.backups).toHaveLength(0);
    expect(tab2.local.notices.some((x) => x.startsWith("warn:"))).toBe(false);
    expect(await remoteHas(phone.repo, "スマホの変更")).toBe(true);
    tab2.sync.stop();
    phone.sync.stop();
  });

  it("別の端末の内容を読んでいる最中の手元の編集は消さず、重なりとして扱う（R3）", async () => {
    const { be } = memoryBackend();
    const flags = { getMs: 0, setMs: 0 };
    const a = device(slow(be, flags), "A", buildDemoDoc());
    await a.sync.start();
    const b = device(be, "B", buildDemoDoc());
    await b.sync.start();
    await tick(30);
    flags.getMs = 80; // A の回線が遅い
    b.edit("B の変更");
    await b.sync.flush();
    await tick(30); // A は分割を読んでいる途中
    a.edit("A で今打った内容");
    await tick(400);
    flags.getMs = 0;
    await a.sync.flush();
    expect(a.has("A で今打った内容")).toBe(true);
    expect(await remoteHas(a.repo, "A で今打った内容")).toBe(true);
    expect(a.local.backups.some((x) => Object.values(x.doc.nodes).some((n) => n.title === "B の変更"))).toBe(true);
    expect(a.local.notices.some((x) => x.startsWith("warn:"))).toBe(true);
    a.sync.stop();
    b.sync.stop();
  });

  it("書いている途中に別の端末が先に確定していたら、確定せずに決め直す（片方の変更を黙って消さない）（R4）", async () => {
    const { be } = memoryBackend();
    // 貸し出しが効かない（期限が切れた）状態を作る: いつでも取れる
    const noLease: CloudBackend = { ...be, lease: async () => true };
    const flags = { getMs: 0, setMs: 0 };
    const a = device(slow(noLease, flags), "A", buildDemoDoc());
    await a.sync.start();
    const b = device(noLease, "B", buildDemoDoc());
    await b.sync.start();
    await tick(30);
    flags.setMs = 80; // A の分割の書き込みが遅い
    a.edit("A の変更");
    const pa = a.sync.flush();
    await tick(40);
    b.edit("B の変更");
    await b.sync.flush(); // B が先に確定する
    await pa;
    flags.setMs = 0;
    await tick(200);
    const titles = Object.values((await a.repo.read())!.doc.nodes).map((n) => n.title);
    expect(titles).toContain("A の変更");
    // B の変更は A のバックアップに残り、警告も出る
    expect(a.local.backups.some((x) => Object.values(x.doc.nodes).some((n) => n.title === "B の変更"))).toBe(true);
    expect(a.local.notices.some((x) => x.startsWith("warn:"))).toBe(true);
    a.sync.stop();
    b.sync.stop();
  });

  it("見張りが何度切れても、間をあけて張り直す（R6）", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { be } = memoryBackend();
      const errs: Array<(c: string) => void> = [];
      let watches = 0;
      const be2: CloudBackend = {
        ...be,
        watch(path, next, error) {
          watches++;
          errs.push(error);
          return be.watch(path, next, error);
        },
      };
      const a = device(be2, "A", buildDemoDoc());
      const started = a.sync.start();
      await vi.advanceTimersByTimeAsync(100);
      await started;
      expect(watches).toBe(1);
      for (let i = 0; i < 4; i++) {
        errs[watches - 1]!("unavailable");
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(watches).toBe(i + 2);
      }
      errs[watches - 1]!("revoked"); // 取り上げられたら終わり
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(watches).toBe(5);
      expect(a.sync.state).toBe("off");
    } finally {
      vi.useRealTimers();
    }
  });

  it("バックアップを作れないブラウザで重なったら、上書きせずに止める（R9）", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", buildDemoDoc());
    await a.sync.start();
    const b = device(be, "B", buildDemoDoc());
    await b.sync.start();
    a.sync.stop();
    b.edit("B の変更");
    await b.sync.flush();
    // A の貸し出しが残っていると B は少し待ってから送る: 届くまで待つ
    for (let i = 0; i < 50 && !(await remoteHas(b.repo, "B の変更")); i++) await tick(10);
    const a2 = device(be, "A2", a.store.doc, { base: a.local.base, canBackup: false });
    a2.edit("A の変更");
    await a2.sync.start();
    await tick(80);
    expect(a2.sync.state).toBe("paused");
    expect(a2.local.notices.join()).not.toContain("バックアップに残しました");
    expect(await remoteHas(b.repo, "B の変更")).toBe(true);
    expect(await remoteHas(b.repo, "A の変更")).toBe(false);
    a2.sync.stop();
    b.sync.stop();
  });

  it("混み合い（resource_exhausted）の待ちは、入力が続いても縮めない（R11）", async () => {
    const { be } = memoryBackend();
    let attempts = 0;
    let busy = false;
    const be2: CloudBackend = {
      ...be,
      async lease(path, holder, ttl) {
        if (busy) {
          attempts++;
          throw { code: "resource_exhausted", message: "rate" };
        }
        return be.lease(path, holder, ttl);
      },
    };
    const a = device(be2, "A", buildDemoDoc());
    await a.sync.start();
    busy = true;
    for (let i = 0; i < 40; i++) {
      a.edit(`入力 ${i}`);
      await tick(25);
    }
    expect(attempts).toBeLessThanOrEqual(2);
    expect(a.sync.message).toContain("混み合って");
    a.sync.stop();
  });

  it("別の端末が書き続けていて待つ間も、同じ相手の内容は 1 回だけ退避し、警告も 1 回（R13）", async () => {
    const { be, leases } = memoryBackend();
    const a = device(be, "A", buildDemoDoc());
    await a.sync.start();
    const b = device(be, "B", buildDemoDoc());
    await b.sync.start();
    a.sync.stop();
    b.edit("B の変更");
    await b.sync.flush();
    for (let i = 0; i < 50 && !(await remoteHas(b.repo, "B の変更")); i++) await tick(10);
    b.sync.stop();
    // 別の端末が書き続けている（貸し出しを持ち続けている）
    leases.set("data/users/user1/fourd-lock", { holder: "other", until: Number.MAX_SAFE_INTEGER });
    const a2 = device(be, "A2", a.store.doc, { base: a.local.base });
    a2.edit("A の変更");
    await a2.sync.start();
    await tick(150);
    expect(a2.local.backups).toHaveLength(1);
    expect(a2.local.notices.filter((x) => x.startsWith("warn:"))).toHaveLength(1);
    // 待ちとやり直しをくり返している（その間は書かない）
    expect(["pending", "syncing"]).toContain(a2.sync.state);
    expect(await remoteHas(a2.repo, "B の変更")).toBe(true);
    expect(await remoteHas(a2.repo, "A の変更")).toBe(false);
    a2.sync.stop();
    b.sync.stop();
  });

  it("題名をその場で入力している間は、別の端末の変更を取り込まず、終わってから取り込む", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", buildDemoDoc());
    await a.sync.start();
    const b = device(be, "B", buildDemoDoc());
    await b.sync.start();
    a.local.editing = true;
    b.edit("B の変更");
    await b.sync.flush();
    await tick(80);
    expect(a.has("B の変更")).toBe(false);
    expect(a.local.adopted).toEqual([]);
    a.local.editing = false;
    await tick(80);
    expect(a.has("B の変更")).toBe(true);
    a.sync.stop();
    b.sync.stop();
  });

  it("手元の変更はまとめて送る（入力のたびには送らない）", async () => {
    const { be, state } = memoryBackend();
    const a = device(be, "A", buildDemoDoc());
    await a.sync.start();
    const before = state.writes;
    for (let i = 0; i < 5; i++) a.edit(`入力 ${i}`);
    await tick(80);
    expect(state.writes - before).toBeLessThanOrEqual(3); // 分割 1 + マニフェスト 1（遅れて 1 回まで）
    expect(a.sync.state).toBe("synced");
    a.sync.stop();
  });

  it("書けない共有（invalid_argument）では止め、このブラウザだけに保存する", async () => {
    const { be, state } = memoryBackend();
    state.failNext = "invalid_argument";
    const a = device(be, "A", buildDemoDoc());
    await a.sync.start();
    expect(a.sync.state).toBe("denied");
    a.edit("その後");
    await tick(30);
    expect(state.writes).toBe(0);
  });

  it("別のタブが編集中なら、このタブからは送らない", async () => {
    const { be, state } = memoryBackend();
    const a = device(be, "A", buildDemoDoc(), { writer: false });
    await a.sync.start();
    expect(a.sync.state).toBe("pending");
    a.edit("x");
    await tick(30);
    expect(state.writes).toBe(0);
    a.sync.stop();
  });

  it("壊れた写しは手元の内容で書き直す（壊れた世代だけ）", async () => {
    const { be, docs } = memoryBackend();
    const a = device(be, "A", realDoc("A の内容"));
    await a.sync.start();
    a.sync.stop();
    const m = await a.repo.readManifest();
    docs.set(`data/users/user1/fourd/parts/${m!.gen}-0`, { gen: m!.gen, i: 0, savedAt: "", data: "AAAA" });
    const b = device(be, "B", realDoc("B の内容"), { base: { gen: "g-old", docId: "x", docUpdatedAt: "" } });
    b.edit("B の変更");
    await b.sync.start();
    for (let i = 0; i < 100 && b.sync.state !== "synced"; i++) await tick(50);
    expect(b.sync.state).toBe("synced");
    expect(await remoteHas(b.repo, "B の変更")).toBe(true);
    b.sync.stop();
  });

  it("新しい版のアプリで保存された写しは、上書きせずに止める", async () => {
    const { be } = memoryBackend();
    const repo = new CloudRepo(be, "user1", "newer");
    const newer = { ...realDoc("新しい版の内容"), version: SCHEMA_VERSION + 1 } as DocData;
    await repo.write(newer, null);
    const before = (await repo.readManifest())!.gen;
    const a = device(be, "A", realDoc("手元"));
    await a.sync.start();
    expect(a.sync.state).toBe("paused");
    expect(a.sync.message).toContain("開き直して");
    expect((await repo.readManifest())!.gen).toBe(before);
    a.sync.stop();
  });
});

describe("同期の決まり: 再レビューの指摘", () => {
  it("別のアカウントの中身は、アカウントに何もしていないデモしか無くても、聞かずに送らない（C0）", async () => {
    const { be, state } = memoryBackend();
    const yPhone = device(be, "Yphone", buildDemoDoc(), { uid: "Y" });
    await yPhone.sync.start(); // Y のアカウントにはデモ
    const writes = state.writes;
    const shared = device(be, "shared", realDoc("X の個人的な内容"), { uid: "Y", foreign: true, choice: "later" });
    await shared.sync.start();
    await tick(80);
    expect(shared.local.asked).toBe(1);
    expect(state.writes).toBe(writes);
    expect(await remoteHas(yPhone.repo, "X の個人的な内容")).toBe(false);
    expect(yPhone.has("X の個人的な内容")).toBe(false);
    // やり直してもまた聞くだけで、送らない
    shared.sync.resync();
    await tick(80);
    expect(shared.local.asked).toBe(2);
    expect(state.writes).toBe(writes);
    yPhone.sync.stop();
    shared.sync.stop();
  });

  it("別のアカウントに切り替わった後の古い基準では、黙って送らない（X→Y→X）（C1）", async () => {
    const { be } = memoryBackend();
    // X がこのブラウザで同期していた（X の基準が残っている）
    const x1 = device(be, "x1", realDoc("X の内容"), { uid: "X" });
    await x1.sync.start();
    const staleXBase = x1.local.base;
    x1.sync.stop();
    // その後 Y の内容に変わった（owner = Y）。X が戻ってくる
    const back = device(be, "x2", realDoc("Y の個人的な内容"), { uid: "X", foreign: true, base: staleXBase, choice: "later" });
    await back.sync.start();
    await tick(80);
    expect(back.local.asked).toBe(1);
    expect(await remoteHas(back.repo, "Y の個人的な内容")).toBe(false);
    expect(await remoteHas(back.repo, "X の内容")).toBe(true);
    back.sync.stop();
  });

  it("自分の確定が別の端末に上書きされたら、黙って取り込まず、重なりとして扱う（C2）", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", buildDemoDoc());
    await a.sync.start();
    const b = device(be, "B", buildDemoDoc());
    await b.sync.start();
    a.sync.stop();
    // B が確定する
    b.edit("B の変更");
    await b.sync.flush();
    for (let i = 0; i < 50 && !(b.local.base?.own && (await remoteHas(b.repo, "B の変更"))); i++) await tick(10);
    const mB = (await b.repo.readManifest())!;
    expect(b.local.base!.own).toBe(true);
    // A の遅れた書き込み: B の世代を知らないまま（B の前の世代を元に）確定する
    const prev = { ...mB, gen: mB.lineage[mB.lineage.length - 1]!, seq: (mB.seq ?? 1) - 1, lineage: mB.lineage.slice(0, -1) };
    const late = { ...a.store.doc, nodes: { ...a.store.doc.nodes } };
    const n = makeNode({ title: "A の遅れた変更" });
    late.nodes[n.id] = n;
    await a.repo.write(late, prev);
    await tick(150);
    // B は自分の変更を失わない（手元で送り、A の内容はバックアップへ・警告）
    expect(b.has("B の変更")).toBe(true);
    expect(await remoteHas(b.repo, "B の変更")).toBe(true);
    expect(b.local.backups.some((x) => Object.values(x.doc.nodes).some((m) => m.title === "A の遅れた変更"))).toBe(true);
    expect(b.local.notices.some((x) => x.startsWith("warn:"))).toBe(true);
    b.sync.stop();
  });

  it("取り込みの後で手元へ保存している間の編集は、基準に入れずに送る（C3）", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", buildDemoDoc(), { adoptFlushMs: 60 });
    await a.sync.start();
    const b = device(be, "B", buildDemoDoc());
    await b.sync.start();
    await tick(30);
    b.edit("B の変更");
    await b.sync.flush();
    // A が取り込んで、手元へ保存している間に編集する
    for (let i = 0; i < 40 && !a.has("B の変更"); i++) await tick(5);
    expect(a.has("B の変更")).toBe(true);
    a.edit("取り込み中の編集");
    await tick(200);
    expect(await remoteHas(a.repo, "取り込み中の編集")).toBe(true);
    expect(a.sync.state).toBe("synced");
    a.sync.stop();
    b.sync.stop();
  });

  it("手元が基準より古い（手元の保存が失われた）なら、送らずにアカウントの内容を読み込む（C4）", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", buildDemoDoc());
    await a.sync.start();
    const old = structuredClone(a.store.doc);
    a.edit("消えてはいけない変更");
    await a.sync.flush();
    const base = a.local.base;
    a.sync.stop();
    // 開き直すと、手元は古い内容（保存に失敗していた）。基準は新しい
    const again = device(be, "A2", old, { base });
    await again.sync.start();
    await tick(60);
    expect(await remoteHas(again.repo, "消えてはいけない変更")).toBe(true);
    expect(again.has("消えてはいけない変更")).toBe(true);
    again.sync.stop();
  });

  it("新しい版の形のマニフェスト・知らない符号化は、空と見なして上書きせずに止める（C5）", async () => {
    for (const patch of [{ format: 2 }, { enc: "brotli-b64" }]) {
      const { be, docs } = memoryBackend();
      const repo = new CloudRepo(be, "user1", "newer");
      await repo.write(realDoc("新しい版の内容"), null);
      const key = "data/users/user1/fourd";
      docs.set(key, { ...docs.get(key)!, ...patch });
      const before = JSON.stringify(docs.get(key));
      const a = device(be, "A", realDoc("手元"));
      await a.sync.start();
      await tick(30);
      expect(a.sync.state).toBe("paused");
      expect(JSON.stringify(docs.get(key))).toBe(before);
      a.sync.stop();
    }
  });

  it("バックアップを作れないブラウザでも、書き出して続けると答えれば先へ進める（C6）", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", buildDemoDoc());
    await a.sync.start();
    const b = device(be, "B", buildDemoDoc());
    await b.sync.start();
    a.sync.stop();
    b.edit("B の変更");
    await b.sync.flush();
    // A の貸し出しが残っていると B は少し待ってから送る: 届くまで待つ
    for (let i = 0; i < 50 && !(await remoteHas(b.repo, "B の変更")); i++) await tick(10);
    const a2 = device(be, "A2", a.store.doc, { base: a.local.base, canBackup: false, confirmNoBackup: true });
    a2.edit("A の変更");
    await a2.sync.start();
    for (let i = 0; i < 40 && a2.sync.state !== "synced"; i++) await tick(10);
    expect(a2.local.confirms).toEqual(["account"]);
    expect(a2.sync.state).toBe("synced");
    expect(await remoteHas(a2.repo, "A の変更")).toBe(true);
    a2.sync.stop();
    b.sync.stop();
  });

  it("題名の入力中は、別の端末の写しを何度も読み直さない（C7）", async () => {
    const { be } = memoryBackend();
    let partReads = 0;
    const counting: CloudBackend = {
      ...be,
      async get(path) {
        if (path.includes("/parts/")) partReads++;
        return be.get(path);
      },
    };
    const a = device(counting, "A", buildDemoDoc(), { retryMs: 10 });
    await a.sync.start();
    const b = device(be, "B", buildDemoDoc());
    await b.sync.start();
    a.local.editing = true;
    b.edit("B の変更");
    await b.sync.flush();
    await tick(60);
    const reads = partReads;
    await tick(300); // 入力が続く
    expect(partReads - reads).toBe(0);
    a.local.editing = false;
    await tick(100);
    expect(a.has("B の変更")).toBe(true);
    a.sync.stop();
    b.sync.stop();
  });

  it("とても長い題名でも、マニフェストは大きくならず同期できる（C8）", async () => {
    const { be, docs } = memoryBackend();
    const d = realDoc("中身");
    d.title = "長".repeat(200_000);
    const a = device(be, "A", d);
    await a.sync.start();
    expect(a.sync.state).toBe("synced");
    const m = await a.repo.readManifest();
    expect([...m!.title].length).toBeLessThanOrEqual(200);
    expect(bytesOf(docs.get("data/users/user1/fourd"))).toBeLessThan(LIMIT);
    expect((await a.repo.read())!.doc.title.length).toBe(200_000);
    a.sync.stop();
  });

  it("置き換えられた古い世代は、次の送信を待たずに 2 分後に片付く（C9）", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const { be, partGens } = memoryBackend();
      const a = device(be, "A", buildDemoDoc());
      const run = async (p: Promise<unknown>) => {
        const done = p.then(() => true);
        for (let i = 0; i < 200; i++) {
          await vi.advanceTimersByTimeAsync(10);
          if (await Promise.race([done, Promise.resolve(false)])) return;
        }
      };
      await run(a.sync.start());
      for (let i = 0; i < 3; i++) {
        a.edit(`変更 ${i}`);
        await run(a.sync.flush());
      }
      expect(partGens().size).toBeGreaterThan(1);
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      const m = await a.repo.readManifest();
      // 置き換えられてから 2 分たった世代はすべて片付き、今の世代だけが残る
      expect([...partGens()]).toEqual([m!.gen]);
      a.sync.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ノードが無くても、プロジェクト・シナリオ・名前のあるドキュメントは捨ててよい物と見なさない（C10）", () => {
    const empty = createEmptyDoc();
    expect(isDisposableDoc(empty)).toBe(true);
    const named = createEmptyDoc("新しい計画");
    expect(isDisposableDoc(named)).toBe(false);
    const withProject = createEmptyDoc();
    const p = { ...buildDemoDoc().projects.p_spelldash! };
    withProject.projects[p.id] = p;
    withProject.projectOrder.push(p.id);
    expect(isDisposableDoc(withProject)).toBe(false);
    expect(isDisposableDoc(buildDemoDoc())).toBe(true);
  });

  it("選ばなかった内容は「選ばなかった内容」として残し、ふだんの同期のバックアップに押し出されない（C17）", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", realDoc("アカウントの内容"));
    await a.sync.start();
    const b = device(be, "B", realDoc("このブラウザの内容"), { choice: "local" });
    await b.sync.start();
    await tick(60);
    expect(b.local.backups.some((x) => x.kind === "kept" && Object.values(x.doc.nodes).some((n) => n.title === "アカウントの内容"))).toBe(true);
    a.sync.stop();
    b.sync.stop();
  });

  it("聞いている間に書き手でなくなったら、答えても送らない（C18）", async () => {
    const { be, state } = memoryBackend();
    const a = device(be, "A", realDoc("アカウントの内容"));
    await a.sync.start();
    const writes = state.writes;
    const b = device(be, "B", realDoc("このブラウザの内容"), { choice: "local" });
    b.local.onAsk = () => {
      b.local.writer = false; // 別のタブが引き継いだ
    };
    await b.sync.start();
    await tick(60);
    expect(state.writes).toBe(writes);
    expect(b.sync.state).toBe("pending");
    expect(b.sync.message).toContain("別のタブ");
    a.sync.stop();
    b.sync.stop();
  });
});

describe("同期の決まり: 最終レビューの指摘", () => {
  /** A が本物の内容を送ってから、手元に保存しきれなかった古い内容（old）と新しい基準（base）を返す */
  async function lostSave(be: CloudBackend) {
    const a = device(be, "A", buildDemoDoc());
    await a.sync.start();
    const old = structuredClone(a.store.doc);
    a.edit("消えてはいけない変更");
    await a.sync.flush();
    const base = a.local.base;
    a.sync.stop();
    return { a, old, base };
  }
  const backedUp = (d: ReturnType<typeof device>, title: string, kind = "conflict") => d.local.backups.some((x) => x.kind === kind && Object.values(x.doc.nodes).some((n) => n.title === title));
  const warned = (d: ReturnType<typeof device>) => d.local.notices.some((x) => x.startsWith("warn:"));

  it("同期した後の「空のドキュメントにする」「デモを読み込む」と、その「元に戻す」は、取り消さずに送る（D0）", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", realDoc("本物の内容"));
    await a.sync.start();
    const empty = createEmptyDoc();
    a.store.replaceDoc(empty, "空のドキュメントにする");
    await a.sync.flush();
    expect(a.store.doc.id).toBe(empty.id);
    expect((await a.repo.read())!.doc.id).toBe(empty.id);
    const demo = buildDemoDoc();
    a.store.replaceDoc(demo, "デモを読み込む");
    await a.sync.flush();
    expect(a.store.doc.id).toBe(demo.id);
    expect((await a.repo.read())!.doc.id).toBe(demo.id);
    a.store.undo();
    await a.sync.flush();
    expect(a.store.doc.id).toBe(empty.id);
    expect((await a.repo.read())!.doc.id).toBe(empty.id);
    expect(a.local.adopted).toEqual([]);
    a.sync.stop();
  });

  it("保存が失われて代わりのデモで始めたら、送らずにアカウントの内容を読み込む（元に戻すの対象にしない）（D1）", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", realDoc("本物の内容"));
    await a.sync.start();
    const base = a.local.base;
    a.sync.stop();
    const lost = device(be, "A2", buildDemoDoc(), { base, fallback: true });
    await lost.sync.start();
    await tick(30);
    expect(lost.has("本物の内容")).toBe(true);
    expect(lost.local.adopted).toEqual(["first"]);
    expect(lost.store.history.canUndo).toBe(false);
    expect(lost.local.notices.some((x) => x.includes("読めなかった"))).toBe(true);
    expect(await remoteHas(lost.repo, "本物の内容")).toBe(true);
    lost.sync.stop();
  });

  it("空にして送る前に閉じても、開き直したときに取り消さずに送る（代わりの内容ではない）（D2）", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", realDoc("本物の内容"));
    await a.sync.start();
    const base = a.local.base;
    a.sync.stop();
    const empty = createEmptyDoc();
    const again = device(be, "A2", empty, { base });
    await again.sync.start();
    await tick(30);
    expect(again.store.doc.id).toBe(empty.id);
    expect((await again.repo.read())!.doc.id).toBe(empty.id);
    expect(again.local.adopted).toEqual([]);
    again.sync.stop();
  });

  it("代わりのデモで始めて、同期の前に入れ替えたら、アカウントの内容を残してから送る（D3）", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", realDoc("本物の内容"));
    await a.sync.start();
    const base = a.local.base;
    a.sync.stop();
    const lost = device(be, "A2", buildDemoDoc(), { base, fallback: true });
    const empty = createEmptyDoc();
    lost.store.replaceDoc(empty, "空のドキュメントにする");
    await lost.sync.start();
    await tick(60);
    expect(lost.store.doc.id).toBe(empty.id);
    expect(backedUp(lost, "本物の内容")).toBe(true);
    expect(warned(lost)).toBe(true);
    expect((await lost.repo.read())!.doc.id).toBe(empty.id);
    lost.sync.stop();
  });

  it("古い手元のまま同期の前に編集しても、アカウントの新しい内容を黙って上書きしない（D4）", async () => {
    const { be } = memoryBackend();
    const { old, base } = await lostSave(be);
    const again = device(be, "A2", old, { base });
    again.edit("同期の前の編集");
    await again.sync.start();
    await tick(60);
    expect(backedUp(again, "消えてはいけない変更")).toBe(true);
    expect(warned(again)).toBe(true);
    expect(await remoteHas(again.repo, "同期の前の編集")).toBe(true);
    again.sync.stop();
  });

  it("古い手元で入力中なら送らずに待ち、入力が終わってからアカウントの内容を読み込む（D5）", async () => {
    const { be, state } = memoryBackend();
    const { old, base } = await lostSave(be);
    let partReads = 0;
    const counting: CloudBackend = {
      ...be,
      async get(path) {
        if (path.includes("/parts/")) partReads++;
        return be.get(path);
      },
    };
    const again = device(counting, "A2", old, { base, retryMs: 10 });
    again.local.editing = true;
    const writes = state.manifestWrites;
    await again.sync.start();
    await tick(80);
    expect(state.manifestWrites).toBe(writes);
    // 入力の間は、アカウントの写しを読みにも行かない
    expect(partReads).toBe(0);
    expect(again.has("消えてはいけない変更")).toBe(false);
    again.local.editing = false;
    for (let i = 0; i < 40 && !again.has("消えてはいけない変更"); i++) await tick(10);
    expect(again.has("消えてはいけない変更")).toBe(true);
    expect(await remoteHas(again.repo, "消えてはいけない変更")).toBe(true);
    again.sync.stop();
  });

  it("古い手元を読み込む途中で入力が始まっても、送らずに待ち、終わってから読み込む（D5b）", async () => {
    const { be, state } = memoryBackend();
    const { old, base } = await lostSave(be);
    const again = device(be, "A2", old, { base, retryMs: 10 });
    let started = false;
    again.local.onAdopt = () => {
      if (started) return;
      started = true;
      again.local.editing = true;
    };
    const writes = state.manifestWrites;
    await again.sync.start();
    await tick(60);
    expect(started).toBe(true);
    expect(state.manifestWrites).toBe(writes);
    expect(again.local.backups).toEqual([]);
    again.local.editing = false;
    for (let i = 0; i < 40 && !again.has("消えてはいけない変更"); i++) await tick(10);
    expect(again.has("消えてはいけない変更")).toBe(true);
    expect(warned(again)).toBe(false);
    again.sync.stop();
  });

  it("古い手元で待っている間に入力を確定したら、アカウントの内容を残してから送る（D6）", async () => {
    const { be } = memoryBackend();
    const { old, base } = await lostSave(be);
    const again = device(be, "A2", old, { base, retryMs: 10 });
    again.local.editing = true;
    await again.sync.start();
    await tick(40);
    again.edit("入力の確定");
    again.local.editing = false;
    for (let i = 0; i < 40 && !(await remoteHas(again.repo, "入力の確定")); i++) await tick(10);
    expect(backedUp(again, "消えてはいけない変更")).toBe(true);
    expect(warned(again)).toBe(true);
    expect(await remoteHas(again.repo, "入力の確定")).toBe(true);
    again.sync.stop();
  });

  it("古い手元のとき、アカウントが基準より先へ進んでいても、古い手元で上書きせずに読み込む（D7）", async () => {
    const { be } = memoryBackend();
    const { a, old, base } = await lostSave(be);
    const b = device(be, "B", buildDemoDoc());
    await b.sync.start();
    expect(b.has("消えてはいけない変更")).toBe(true);
    b.edit("B の変更");
    await b.sync.flush();
    for (let i = 0; i < 50 && !(await remoteHas(b.repo, "B の変更")); i++) await tick(10);
    expect(a.local.base!.gen).not.toBe((await b.repo.readManifest())!.gen);
    const again = device(be, "A2", old, { base });
    await again.sync.start();
    await tick(60);
    expect(again.has("消えてはいけない変更")).toBe(true);
    expect(again.has("B の変更")).toBe(true);
    expect(warned(again)).toBe(false);
    expect(await remoteHas(again.repo, "B の変更")).toBe(true);
    again.sync.stop();
    b.sync.stop();
  });

  it("取り込みの途中で入力が始まっても、重なりにせず、入力が終わってから取り込む（D8）", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", buildDemoDoc(), { retryMs: 10 });
    await a.sync.start();
    const b = device(be, "B", buildDemoDoc());
    await b.sync.start();
    let started = false;
    a.local.onAdopt = () => {
      if (started) return;
      started = true;
      a.local.editing = true;
    };
    b.edit("B の変更");
    await b.sync.flush();
    for (let i = 0; i < 60 && !started; i++) await tick(5);
    expect(started).toBe(true);
    await tick(40);
    expect(a.has("B の変更")).toBe(false);
    a.local.editing = false;
    for (let i = 0; i < 60 && !a.has("B の変更"); i++) await tick(10);
    expect(a.has("B の変更")).toBe(true);
    expect(a.local.backups).toEqual([]);
    expect(warned(a)).toBe(false);
    expect(await remoteHas(b.repo, "B の変更")).toBe(true);
    a.sync.stop();
    b.sync.stop();
  });

  it("前の版のアプリが書いた写しを挟んでも、ふつうの続きを重なりと取り違えない（D9）", async () => {
    const { be, docs } = memoryBackend();
    const a = device(be, "A", buildDemoDoc());
    await a.sync.start();
    a.edit("A の変更");
    await a.sync.flush();
    expect(a.local.base!.own).toBe(true);
    a.sync.stop();
    // 前の版のタブが、A の写しの上に書く（通し番号・系譜・数え方を持たない）
    const oldTab = new CloudRepo(be, "user1", "old-tab");
    const legacyDoc = structuredClone(a.store.doc);
    const n = makeNode({ title: "前の版で書いた変更" });
    legacyDoc.nodes[n.id] = n;
    await oldTab.write(legacyDoc, await oldTab.readManifest());
    const key = "data/users/user1/fourd";
    const legacy = { ...docs.get(key)! };
    delete legacy.seq;
    delete legacy.lineage;
    delete legacy.chain;
    docs.set(key, legacy);
    // 新しい版の端末 C が読み込んでから書く（通し番号は数え直し）
    const c = device(be, "C", buildDemoDoc());
    await c.sync.start();
    expect(c.has("前の版で書いた変更")).toBe(true);
    c.edit("C の変更");
    await c.sync.flush();
    // 貸し出しが残っていると C は少し待ってから送る: 届くまで待つ（C の確定は通し番号 1 から数え直し）
    for (let i = 0; i < 50 && !(await remoteHas(c.repo, "C の変更")); i++) await tick(10);
    const mC = (await c.repo.readManifest())!;
    expect(mC.seq).toBe(1);
    expect(mC.seq!).toBeLessThan(a.local.base!.seq!);
    // 変更の無い A が開き直す: 重なりにせず、C の内容を読み込む
    const a2 = device(be, "A2", a.store.doc, { base: a.local.base });
    await a2.sync.start();
    await tick(30);
    expect(a2.has("C の変更")).toBe(true);
    expect(a2.local.backups).toEqual([]);
    expect(warned(a2)).toBe(false);
    expect(await remoteHas(a2.repo, "C の変更")).toBe(true);
    c.sync.stop();
    a2.sync.stop();
  });

  it("マニフェストの書き込みが断られたように見えて書けていたら、確定として扱い、分割を消さない（D10）", async () => {
    const { be } = memoryBackend();
    let lose = false;
    const lossy: CloudBackend = {
      ...be,
      async set(path, data) {
        await be.set(path, data);
        if (lose && !path.includes("/parts/")) {
          lose = false;
          throw { code: "unavailable", message: "応答が届かなかった" };
        }
      },
    };
    const a = device(lossy, "A", realDoc("最初"));
    await a.sync.start();
    lose = true;
    a.edit("届いていた変更");
    await a.sync.flush();
    const m = (await a.repo.readManifest())!;
    expect(a.local.base?.gen).toBe(m.gen);
    expect(a.local.base?.own).toBe(true);
    expect(await remoteHas(a.repo, "届いていた変更")).toBe(true);
    expect(a.sync.state).toBe("synced");
    a.sync.stop();
  });

  it("断られた確定が後から届いても、分割を消さず、自分の確定として扱う（重なりにしない）（D11）", async () => {
    const { be, docs } = memoryBackend();
    const held: { data?: Record<string, unknown> } = {};
    let reject = false;
    const flaky: CloudBackend = {
      ...be,
      async set(path, data) {
        if (reject && !path.includes("/parts/")) {
          reject = false;
          held.data = structuredClone(data);
          throw { code: "unavailable", message: "x" };
        }
        return be.set(path, data);
      },
    };
    const a = device(flaky, "A", realDoc("最初"));
    await a.sync.start();
    reject = true;
    a.edit("遅れて届く変更");
    await a.sync.flush();
    expect(a.sync.state).toBe("offline");
    const gen = String(held.data!.gen);
    expect(docs.has(`data/users/user1/fourd/parts/${gen}-0`)).toBe(true);
    // やり直しが後から届く
    await be.set("data/users/user1/fourd", held.data!);
    a.edit("その後の変更");
    a.sync.resync();
    for (let i = 0; i < 60 && !(await remoteHas(a.repo, "その後の変更")); i++) await tick(10);
    expect(await remoteHas(a.repo, "遅れて届く変更")).toBe(true);
    expect(await remoteHas(a.repo, "その後の変更")).toBe(true);
    expect(a.local.backups).toEqual([]);
    expect(warned(a)).toBe(false);
    a.sync.stop();
  });

  it("分割の無いマニフェストが残っていても、止まり続けずに手元の内容で書き直す（D12）", async () => {
    const { be, docs } = memoryBackend();
    const a = device(be, "A", realDoc("A の内容"));
    await a.sync.start();
    a.sync.stop();
    const m = (await a.repo.readManifest())!;
    for (let i = 0; i < m.parts; i++) docs.delete(`data/users/user1/fourd/parts/${m.gen}-${i}`);
    const b = device(be, "B", realDoc("B の内容"), { base: { gen: "g-old", docId: "x", docUpdatedAt: "" } });
    b.edit("B の変更");
    await b.sync.start();
    for (let i = 0; i < 120 && b.sync.state !== "synced"; i++) await tick(50);
    expect(b.sync.state).toBe("synced");
    expect(await remoteHas(b.repo, "B の変更")).toBe(true);
    b.sync.stop();
  });

  it("確定している間に止まったら（共有の取り消しなど）、終わっても「同期済み」に戻さない（D13）", async () => {
    const { be } = memoryBackend();
    const hooks: { gate?: Promise<void>; open?: () => void; fail?: (code: string) => void } = {};
    const gated: CloudBackend = {
      ...be,
      watch(path, next, error) {
        hooks.fail = error;
        return be.watch(path, next, error);
      },
      async set(path, data) {
        if (hooks.gate && !path.includes("/parts/")) await hooks.gate;
        return be.set(path, data);
      },
    };
    const a = device(gated, "A", realDoc("最初"));
    await a.sync.start();
    hooks.gate = new Promise<void>((r) => (hooks.open = r));
    a.edit("確定中の変更");
    const pushing = a.sync.flush();
    for (let i = 0; i < 50 && a.sync.state !== "syncing"; i++) await tick(5);
    await tick(30);
    hooks.fail!("revoked");
    expect(a.sync.state).toBe("off");
    hooks.open!();
    await pushing;
    await tick(20);
    expect(a.sync.state).toBe("off");
  });

  it("初めての同期で、捨ててよい手元を読み込む途中で入力が始まったら、聞かずに待つ（D14）", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", realDoc("アカウントの内容"));
    await a.sync.start();
    const b = device(be, "B", buildDemoDoc(), { retryMs: 10, choice: "local" });
    let started = false;
    b.local.onAdopt = () => {
      if (started) return;
      started = true;
      b.local.editing = true;
    };
    await b.sync.start();
    await tick(40);
    expect(started).toBe(true);
    expect(b.local.asked).toBe(0);
    b.local.editing = false;
    for (let i = 0; i < 40 && !b.has("アカウントの内容"); i++) await tick(10);
    expect(b.has("アカウントの内容")).toBe(true);
    expect(b.local.asked).toBe(0);
    expect(await remoteHas(a.repo, "アカウントの内容")).toBe(true);
    a.sync.stop();
    b.sync.stop();
  });

  it("基準は、手元に保存できた内容を超えるときは書かない（baseCovered）", () => {
    const b = { gen: "g", docId: "d1", docUpdatedAt: "2026-01-01T00:00:01.000Z" };
    expect(baseCovered(null, b)).toBe(false);
    expect(baseCovered({ id: "d1", updatedAt: "2026-01-01T00:00:00.000Z" }, b)).toBe(false);
    expect(baseCovered({ id: "d2", updatedAt: "2026-01-01T00:00:02.000Z" }, b)).toBe(false);
    expect(baseCovered({ id: "d1", updatedAt: "2026-01-01T00:00:01.000Z" }, b)).toBe(true);
    expect(baseCovered({ id: "d1", updatedAt: "2026-01-01T00:00:02.000Z" }, b)).toBe(true);
    // この端末が送った基準で、手元がその後に（新しい時刻で）別のドキュメントに入れ替わっていれば書いてよい
    const own = { ...b, own: true };
    expect(baseCovered({ id: "d2", updatedAt: "2026-01-01T00:00:02.000Z" }, own)).toBe(true);
    expect(baseCovered({ id: "d2", updatedAt: "2026-01-01T00:00:00.500Z" }, own)).toBe(false);
  });
});

describe("同期の決まり: 修正の再レビューの指摘", () => {
  async function lostSave(be: CloudBackend) {
    const a = device(be, "A", buildDemoDoc());
    await a.sync.start();
    const old = structuredClone(a.store.doc);
    a.edit("消えてはいけない変更");
    await a.sync.flush();
    for (let i = 0; i < 50 && !(await remoteHas(a.repo, "消えてはいけない変更")); i++) await tick(10);
    const base = a.local.base;
    a.sync.stop();
    return { a, old, base };
  }
  const backedUp = (d: ReturnType<typeof device>, title: string, kind = "conflict") => d.local.backups.some((x) => x.kind === kind && Object.values(x.doc.nodes).some((n) => n.title === title));
  const warned = (d: ReturnType<typeof device>) => d.local.notices.some((x) => x.startsWith("warn:"));
  /** つながらない回線（何も読み書きできない。見張りは何も届けない） */
  const offline = (be: CloudBackend): CloudBackend => ({
    ...be,
    get: async () => Promise.reject({ code: "unavailable", message: "offline" }),
    set: async () => Promise.reject({ code: "unavailable", message: "offline" }),
    lease: async () => Promise.reject({ code: "unavailable", message: "offline" }),
    watch: () => () => undefined,
  });
  const withNode = (d: DocData, title: string): DocData => {
    const c = structuredClone(d);
    const n = makeNode({ title });
    c.nodes[n.id] = n;
    return c;
  };

  it("古いバックアップで始めて同期の前に編集し、開き直しても、アカウントの新しい内容を黙って上書きしない（E0）", async () => {
    const { be } = memoryBackend();
    const { old, base } = await lostSave(be);
    const idb = browser(base);
    // 1 回目: 保存してあった内容を読めず、古いバックアップで始めた。同期は始まらないまま編集して閉じる
    const s1 = device(be, "S1", old, { idb, fallback: true });
    s1.edit("同期の前の編集");
    // 2 回目: 開き直す（手元はふつうに読める、編集した内容）
    const s2 = device(be, "S2", structuredClone(s1.store.doc), { idb });
    await s2.sync.start();
    await tick(60);
    expect(backedUp(s2, "消えてはいけない変更")).toBe(true);
    expect(warned(s2)).toBe(true);
    expect(await remoteHas(s2.repo, "同期の前の編集")).toBe(true);
    s2.sync.stop();
  });

  it("代わりのデモで始めてインポートで入れ替え、開き直しても、アカウントの内容を残してから送る（E1）", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", realDoc("本物の内容"));
    await a.sync.start();
    a.sync.stop();
    const idb = browser(a.local.base);
    const s1 = device(be, "S1", buildDemoDoc(), { idb, fallback: true });
    s1.store.replaceDoc(realDoc("取り込んだ内容"), "インポート（置き換え）");
    const s2 = device(be, "S2", structuredClone(s1.store.doc), { idb });
    await s2.sync.start();
    await tick(60);
    expect(backedUp(s2, "本物の内容")).toBe(true);
    expect(warned(s2)).toBe(true);
    expect(await remoteHas(s2.repo, "取り込んだ内容")).toBe(true);
    s2.sync.stop();
  });

  it("閲覧のみで開いたタブが引き継いでも、古かった手元を黙って送らない（E2）", async () => {
    const { be } = memoryBackend();
    const { old, base } = await lostSave(be);
    const idb = browser(base);
    // タブ 1: 古いバックアップで始めたが、つながらないまま編集する
    const t1 = device(offline(be), "T1", old, { idb, fallback: true });
    await t1.sync.start();
    const t2 = device(be, "T2", old, { idb, writer: false });
    await t2.sync.start();
    t1.edit("タブ1の編集");
    // タブ 2 で「このタブで編集する」: 保存されていたタブ 1 の内容を読み、突き合わせをやり直す
    t1.local.writer = false;
    t1.sync.writerLost();
    t1.sync.stop();
    t2.store.load(structuredClone(t1.store.doc), "load");
    t2.local.writer = true;
    t2.sync.resync();
    for (let i = 0; i < 40 && t2.sync.state !== "synced"; i++) await tick(10);
    expect(backedUp(t2, "消えてはいけない変更")).toBe(true);
    expect(warned(t2)).toBe(true);
    expect(await remoteHas(t2.repo, "タブ1の編集")).toBe(true);
    t2.sync.stop();
  });

  it("別のタブが古い手元を解決した後に引き継いでも、重なりと取り違えない（E3）", async () => {
    const { be } = memoryBackend();
    const { old, base } = await lostSave(be);
    const idb = browser(base);
    const t1 = device(be, "T1", old, { idb });
    const t2 = device(be, "T2", old, { idb, writer: false });
    await t2.sync.start();
    await t1.sync.start();
    await tick(40);
    expect(t1.has("消えてはいけない変更")).toBe(true);
    t1.sync.stop();
    t1.edit("タブ1の編集");
    t1.local.writer = false;
    t2.store.load(structuredClone(t1.store.doc), "load");
    t2.local.writer = true;
    t2.sync.resync();
    for (let i = 0; i < 50 && !(await remoteHas(t2.repo, "タブ1の編集")); i++) await tick(10);
    expect(await remoteHas(t2.repo, "タブ1の編集")).toBe(true);
    expect(warned(t2)).toBe(false);
    expect(t2.local.backups).toEqual([]);
    t2.sync.stop();
  });

  it("保存が読めず、別のドキュメントのバックアップで始めたら、手を付ける前ならアカウントの内容を読み込む（E4）", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", realDoc("本物の内容"));
    await a.sync.start();
    a.sync.stop();
    const s = device(be, "S", realDoc("前のバックアップの内容"), { idb: browser(a.local.base), fallback: true });
    await s.sync.start();
    await tick(60);
    expect(s.has("本物の内容")).toBe(true);
    expect(s.local.adopted).toEqual(["remote"]);
    expect(warned(s)).toBe(false);
    expect(await remoteHas(s.repo, "本物の内容")).toBe(true);
    s.sync.stop();
  });

  it("読めない写しを、新しい端末のデモでは書き直さず、内容のある端末が直すのを待って読み込む（E5）", async () => {
    const { be, docs, state } = memoryBackend();
    const a = device(be, "A", realDoc("A の内容"));
    await a.sync.start();
    a.sync.stop();
    const m = (await a.repo.readManifest())!;
    const saved = new Map([...docs].filter(([k]) => k.includes(`/parts/${m.gen}-`)));
    for (const k of saved.keys()) docs.delete(k);
    const writes = state.manifestWrites;
    const fresh = device(be, "F", buildDemoDoc());
    await fresh.sync.start();
    for (let i = 0; i < 120 && !fresh.sync.message.includes("最新の内容がある端末"); i++) await tick(50);
    expect(fresh.sync.state).toBe("error");
    expect(state.manifestWrites).toBe(writes);
    // 内容のある端末（A）が編集して送ると直り、新しい端末はそれを読み込む
    const a2 = device(be, "A2", structuredClone(a.store.doc), { idb: a.local.idb });
    a2.edit("A の次の変更");
    await a2.sync.start();
    for (let i = 0; i < 80 && !fresh.has("A の次の変更"); i++) await tick(25);
    expect(fresh.has("A の次の変更")).toBe(true);
    expect(fresh.local.adopted).toEqual(["first"]);
    fresh.sync.stop();
    a2.sync.stop();
  });

  it("読めない世代のすぐ前の内容で書き直したら、その世代を持つ端末が自分の内容で戻す（E6）", async () => {
    const { be, docs } = memoryBackend();
    const a = device(be, "A", realDoc("最初の内容"));
    await a.sync.start();
    const b = device(be, "B", buildDemoDoc());
    await b.sync.start();
    expect(b.has("最初の内容")).toBe(true);
    b.sync.stop();
    a.edit("A の変更");
    await a.sync.flush();
    for (let i = 0; i < 50 && !(await remoteHas(a.repo, "A の変更")); i++) await tick(10);
    a.sync.stop();
    const m = (await a.repo.readManifest())!;
    for (let i = 0; i < m.parts; i++) docs.delete(`data/users/user1/fourd/parts/${m.gen}-${i}`);
    // B（読めない世代のすぐ前の内容）が開く: 書き直し、読めなかった世代を書き残す
    const b2 = device(be, "B2", structuredClone(b.store.doc), { idb: b.local.idb });
    await b2.sync.start();
    for (let i = 0; i < 120 && !b2.local.notices.some((x) => x.includes("書き直しました")); i++) await tick(50);
    const rewritten = (await b2.repo.readManifest())!;
    expect(rewritten.lost).toContain(m.gen);
    b2.sync.stop();
    // A（読めなくなった世代を確定した端末）が開く: 書き直された内容を取り込まずに、自分の内容で戻す
    const a2 = device(be, "A2", structuredClone(a.store.doc), { idb: a.local.idb });
    await a2.sync.start();
    for (let i = 0; i < 50 && !(await remoteHas(a2.repo, "A の変更")); i++) await tick(10);
    expect(await remoteHas(a2.repo, "A の変更")).toBe(true);
    expect(a2.has("A の変更")).toBe(true);
    expect(a2.local.notices.some((x) => x.includes("書き直されていた"))).toBe(true);
    expect((await a2.repo.readManifest())!.lost ?? []).not.toContain(m.gen);
    a2.sync.stop();
  });

  it("読めない写しを、変更の無い古い端末は書き直さない。「同期をやり直す」を押したら書き直す（E7）", async () => {
    const { be, docs, state } = memoryBackend();
    const a = device(be, "A", realDoc("最初の内容"));
    await a.sync.start();
    const b = device(be, "B", buildDemoDoc());
    await b.sync.start();
    b.sync.stop();
    for (const t of ["A の変更 1", "A の変更 2"]) {
      a.edit(t);
      await a.sync.flush();
      for (let i = 0; i < 50 && !(await remoteHas(a.repo, t)); i++) await tick(10);
    }
    a.sync.stop();
    const m = (await a.repo.readManifest())!;
    for (let i = 0; i < m.parts; i++) docs.delete(`data/users/user1/fourd/parts/${m.gen}-${i}`);
    const writes = state.manifestWrites;
    const b2 = device(be, "B2", structuredClone(b.store.doc), { idb: b.local.idb });
    await b2.sync.start();
    for (let i = 0; i < 120 && !b2.sync.message.includes("最新の内容がある端末"); i++) await tick(50);
    expect(b2.sync.state).toBe("error");
    expect(state.manifestWrites).toBe(writes);
    b2.sync.resync({ userAsked: true });
    for (let i = 0; i < 120 && b2.sync.state !== "synced"; i++) await tick(50);
    expect(b2.sync.state).toBe("synced");
    expect((await b2.repo.readManifest())!.lost).toContain(m.gen);
    b2.sync.stop();
  });

  /** A の確定が 1 回「返事が届かない」で失敗し、次の確定の後で届く。B はその間に新しい内容を読み込んでいる */
  async function lateLanding() {
    const { be } = memoryBackend();
    const held: { data?: Record<string, unknown> } = {};
    let reject = false;
    const flaky: CloudBackend = {
      ...be,
      async set(path, data) {
        if (reject && !path.includes("/parts/")) {
          reject = false;
          held.data = structuredClone(data);
          throw { code: "unavailable", message: "x" };
        }
        return be.set(path, data);
      },
    };
    const a = device(flaky, "A", realDoc("最初"));
    await a.sync.start();
    const b = device(be, "B", buildDemoDoc());
    await b.sync.start();
    reject = true;
    a.edit("変更 1");
    await a.sync.flush();
    expect(a.sync.state).toBe("offline");
    a.edit("変更 2");
    a.sync.resync();
    for (let i = 0; i < 60 && !(await remoteHas(a.repo, "変更 2")); i++) await tick(10);
    for (let i = 0; i < 60 && !b.has("変更 2"); i++) await tick(10);
    expect(b.has("変更 2")).toBe(true);
    const land = () => be.set("data/users/user1/fourd", held.data!);
    return { a, b, land };
  }

  it("断られたように見えた確定が次の確定より後に届いたら、書いた端末が取り込まずに新しい内容で戻す（E8）", async () => {
    const { a, b, land } = await lateLanding();
    b.sync.stop();
    await land();
    for (let i = 0; i < 60 && !(await remoteHas(a.repo, "変更 2")); i++) await tick(10);
    expect(await remoteHas(a.repo, "変更 2")).toBe(true);
    expect(a.has("変更 2")).toBe(true);
    expect(a.local.backups).toEqual([]);
    expect(warned(a)).toBe(false);
    a.sync.stop();
  });

  it("書いた端末がいなくても、ほかの端末が古い確定を取り込まずに新しい内容で戻す（E8b）", async () => {
    const { a, b, land } = await lateLanding();
    a.sync.stop();
    await land();
    for (let i = 0; i < 60 && !(await remoteHas(b.repo, "変更 2")); i++) await tick(10);
    expect(await remoteHas(b.repo, "変更 2")).toBe(true);
    expect(b.has("変更 2")).toBe(true);
    expect(b.local.backups).toEqual([]);
    expect(warned(b)).toBe(false);
    b.sync.stop();
  });

  it("今公開中の版（数え方を持たない）のタブに上書きされても、黙って取り込まず重なりとして扱う（E9）", async () => {
    const { be, docs } = memoryBackend();
    const a = device(be, "A", realDoc("最初"));
    await a.sync.start();
    const m0 = (await a.repo.readManifest())!;
    const d0 = structuredClone(a.store.doc);
    a.edit("A の変更");
    await a.sync.flush();
    for (let i = 0; i < 50 && !(await remoteHas(a.repo, "A の変更")); i++) await tick(10);
    expect(a.local.base!.own).toBe(true);
    // 前の版のタブが、A の確定を知らないまま m0 の上に書く（通し番号・系譜はあるが、数え方を持たない。一度で書く）
    const v3be: CloudBackend = {
      ...be,
      async set(path, data) {
        if (path.endsWith("/fourd")) {
          const legacy = { ...data };
          delete legacy.chain;
          delete legacy.lost;
          return be.set(path, legacy);
        }
        return be.set(path, data);
      },
    };
    await new CloudRepo(v3be, "user1", "v3-tab").write(withNode(d0, "前の版のタブの変更"), m0);
    expect(docs.get("data/users/user1/fourd")!.chain).toBeUndefined();
    for (let i = 0; i < 60 && !warned(a); i++) await tick(10);
    for (let i = 0; i < 60 && !(await remoteHas(a.repo, "A の変更")); i++) await tick(10);
    expect(warned(a)).toBe(true);
    expect(backedUp(a, "前の版のタブの変更")).toBe(true);
    expect(a.has("A の変更")).toBe(true);
    expect(await remoteHas(a.repo, "A の変更")).toBe(true);
    a.sync.stop();
  });

  it("はっきり断られた確定（混み合い）の分割はすぐ片付け、返事が届かなかっただけの分割は残す（E10）", async () => {
    const { be, partGens } = memoryBackend();
    let reject = "";
    const flaky: CloudBackend = {
      ...be,
      async set(path, data) {
        if (reject && !path.includes("/parts/")) {
          const code = reject;
          reject = "";
          throw { code, message: code };
        }
        return be.set(path, data);
      },
    };
    const a = device(flaky, "A", realDoc("最初"));
    await a.sync.start();
    const live = () => a.repo.readManifest().then((m) => new Set([m!.gen, ...m!.stale.map((x) => x.gen)]));
    reject = "resource_exhausted";
    a.edit("混み合いで断られた変更");
    await a.sync.flush();
    const l1 = await live();
    expect([...partGens()].filter((g) => !l1.has(g))).toEqual([]);
    a.sync.resync();
    for (let i = 0; i < 60 && !(await remoteHas(a.repo, "混み合いで断られた変更")); i++) await tick(10);
    reject = "unavailable";
    a.edit("返事が届かなかった変更");
    await a.sync.flush();
    const l2 = await live();
    expect([...partGens()].filter((g) => !l2.has(g))).toHaveLength(1);
    a.sync.stop();
  });

  it("返事が届かなかった確定の分割は、届かないまま 10 分たったら片付ける（E12）", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const { be, partGens } = memoryBackend();
      let reject = false;
      const flaky: CloudBackend = {
        ...be,
        async set(path, data) {
          if (reject && !path.includes("/parts/")) {
            reject = false;
            throw { code: "unavailable", message: "x" };
          }
          return be.set(path, data);
        },
      };
      const a = device(flaky, "A", realDoc("最初"));
      const run = async (p: Promise<unknown>) => {
        const done = p.then(() => true);
        for (let i = 0; i < 200; i++) {
          await vi.advanceTimersByTimeAsync(10);
          if (await Promise.race([done, Promise.resolve(false)])) return;
        }
      };
      await run(a.sync.start());
      reject = true;
      a.edit("届かなかった変更");
      await run(a.sync.flush());
      const live = async () => {
        const m = (await a.repo.readManifest())!;
        return new Set([m.gen, ...m.stale.map((x) => x.gen)]);
      };
      const l1 = await live();
      expect([...partGens()].filter((g) => !l1.has(g))).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      const l2 = await live();
      expect([...partGens()].filter((g) => !l2.has(g))).toEqual([]);
      a.sync.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("確かめられなかった送信は、別のタブが基準を進めた後には当てはめない（E11）", async () => {
    const { be } = memoryBackend();
    const held: { data?: Record<string, unknown> } = {};
    let reject = false;
    const flaky: CloudBackend = {
      ...be,
      async set(path, data) {
        if (reject && !path.includes("/parts/")) {
          reject = false;
          held.data = structuredClone(data);
          throw { code: "unavailable", message: "x" };
        }
        return be.set(path, data);
      },
    };
    const idb = browser();
    const t1 = device(flaky, "T1", realDoc("最初"), { idb });
    await t1.sync.start();
    reject = true;
    t1.edit("タブ1の変更");
    await t1.sync.flush();
    expect(t1.sync.state).toBe("offline");
    // タブ 2 に引き継がれてから、送ったつもりの内容が後から届き、タブ 2 がその上に書く
    t1.local.writer = false;
    t1.sync.writerLost();
    await be.set("data/users/user1/fourd", held.data!);
    const t2 = device(be, "T2", structuredClone(t1.store.doc), { idb, writer: false });
    await t2.sync.start();
    t2.local.writer = true;
    t2.sync.resync();
    t2.edit("タブ2の変更");
    await t2.sync.flush();
    for (let i = 0; i < 60 && !(await remoteHas(t2.repo, "タブ2の変更")); i++) await tick(10);
    t2.local.writer = false;
    t2.sync.stop();
    // 別の端末がさらに書く
    const p = device(be, "P", buildDemoDoc());
    await p.sync.start();
    p.edit("別の端末の変更");
    await p.sync.flush();
    for (let i = 0; i < 60 && !(await remoteHas(p.repo, "別の端末の変更")); i++) await tick(10);
    p.sync.stop();
    // タブ 1 が引き継ぎ直す（手元は保存されていたタブ 2 の内容）
    t1.store.load(structuredClone(t2.store.doc), "load");
    t1.local.writer = true;
    t1.sync.resync();
    for (let i = 0; i < 60 && !t1.has("別の端末の変更"); i++) await tick(10);
    expect(t1.has("別の端末の変更")).toBe(true);
    expect(t1.local.backups).toEqual([]);
    expect(warned(t1)).toBe(false);
    t1.sync.stop();
  });
});

describe("同期の決まり: 第 3 回の再レビューの指摘", () => {
  const MANIFEST = "data/users/user1/fourd";
  const backedUp = (d: ReturnType<typeof device>, title: string, kind = "conflict") => d.local.backups.some((x) => x.kind === kind && Object.values(x.doc.nodes).some((n) => n.title === title));
  const warned = (d: ReturnType<typeof device>) => d.local.notices.some((x) => x.startsWith("warn:"));
  const withNode = (d: DocData, title: string): DocData => {
    const c = structuredClone(d);
    const n = makeNode({ title });
    c.nodes[n.id] = n;
    c.updatedAt = new Date(Math.max(Date.parse(c.updatedAt), Date.now()) + 1000).toISOString();
    return c;
  };
  /** つながる・つながらないを切り替えられる回線 */
  const switchable = (be: CloudBackend, net: { up: boolean }): CloudBackend => {
    const down = () => Promise.reject({ code: "unavailable", message: "offline" });
    return {
      ...be,
      get: (p) => (net.up ? be.get(p) : down()),
      set: (p, d) => (net.up ? be.set(p, d) : down()),
      lease: (p, h, t) => (net.up ? be.lease(p, h, t) : down()),
      watch: (p, next, err) => be.watch(p, (d) => net.up && next(d), err),
    };
  };
  /** マニフェストの書き込みを覚える回線（後で同じ書き込みをもう一度届けるため） */
  const recording = (be: CloudBackend, writes: Array<Record<string, unknown>>): CloudBackend => ({
    ...be,
    async set(path, data) {
      await be.set(path, data);
      if (path === MANIFEST) writes.push(structuredClone(data));
    },
  });
  const until = async (cond: () => boolean | Promise<boolean>, n = 80, ms = 25) => {
    for (let i = 0; i < n && !(await cond()); i++) await tick(ms);
  };

  it("前の版のタブが基準を書き換えた後に引き継いでも、古い記録で「古かった」と取り違えない（F0）", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", realDoc("最初"));
    await a.sync.start();
    a.sync.stop();
    const idb = a.local.idb;
    // 新しい版のタブ N: 送る物は無く、基準は書かない（起動したときの記録が残る）
    const n = device(be, "N", structuredClone(a.store.doc), { idb });
    await n.sync.start();
    expect(idb.boot).not.toBeNull();
    // 前の版のタブが引き継いで編集し、送る: 基準は書くが、起動したときの記録は知らない
    n.local.writer = false;
    n.sync.writerLost();
    const v3doc = withNode(a.store.doc, "前の版のタブの変更");
    const v3repo = new CloudRepo(be, "user1", "v3-tab");
    const mV = await v3repo.write(v3doc, await v3repo.readManifest());
    idb.base = { gen: mV.gen, docId: v3doc.id, docUpdatedAt: v3doc.updatedAt, seq: mV.seq, own: true };
    // N が引き継ぎ直して編集する
    n.store.load(structuredClone(v3doc), "load");
    n.edit("N の編集");
    n.local.writer = true;
    n.sync.resync();
    await until(() => remoteHas(n.repo, "N の編集"));
    expect(await remoteHas(n.repo, "N の編集")).toBe(true);
    expect(warned(n)).toBe(false);
    expect(n.local.backups).toEqual([]);
    n.sync.stop();
  });

  it("前の版のタブが基準を書き換えた後に開き直しても、別の端末の変更を取り込む（F0b）", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", realDoc("最初"));
    await a.sync.start();
    const idb = a.local.idb;
    const n = device(be, "N", structuredClone(a.store.doc), { idb });
    await n.sync.start();
    n.sync.stop();
    const v3doc = withNode(a.store.doc, "前の版のタブの変更");
    const v3repo = new CloudRepo(be, "user1", "v3-tab");
    const mV = await v3repo.write(v3doc, await v3repo.readManifest());
    idb.base = { gen: mV.gen, docId: v3doc.id, docUpdatedAt: v3doc.updatedAt, seq: mV.seq, own: true };
    const n2 = device(be, "N2", structuredClone(v3doc), { idb });
    await n2.sync.start();
    for (let i = 0; i < 60 && !a.has("前の版のタブの変更"); i++) await tick(10);
    a.edit("P の変更");
    await a.sync.flush();
    await until(() => n2.has("P の変更"));
    expect(n2.has("P の変更")).toBe(true);
    expect(warned(n2)).toBe(false);
    expect(n2.local.backups).toEqual([]);
    expect(await remoteHas(a.repo, "P の変更")).toBe(true);
    a.sync.stop();
    n2.sync.stop();
  });

  it("古い手元を別のタブが直した後（同じ基準を書き直した）に引き継いでも、「古かった」と取り違えない（F1）", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", realDoc("本物の内容"));
    await a.sync.start();
    // X はアカウントの内容を初めての同期で読み込んだ（基準の時刻は、アカウントの内容のまま）
    const x = device(be, "X", buildDemoDoc());
    await x.sync.start();
    expect(x.local.adopted).toEqual(["first"]);
    x.sync.stop();
    const idb = x.local.idb;
    // X のブラウザで保存が失われた: タブ 1 が代わりのデモで、つながらないまま始める
    const net = { up: false };
    const t1 = device(switchable(be, net), "T1", buildDemoDoc(), { idb, fallback: true });
    await t1.sync.start();
    const t2 = device(be, "T2", structuredClone(t1.store.doc), { idb, writer: false });
    await t2.sync.start();
    // タブ 2 が引き継いで直し（同じ基準を書き直す）、手元を編集したが、送る前にタブ 1 へ戻る
    t1.local.writer = false;
    t1.sync.writerLost();
    t2.local.writer = true;
    t2.sync.resync();
    await until(() => t2.has("本物の内容"));
    expect(t2.local.adopted).toEqual(["first"]);
    t2.sync.stop();
    t2.edit("タブ2の編集");
    t2.local.writer = false;
    net.up = true;
    t1.store.load(structuredClone(t2.store.doc), "load");
    t1.local.writer = true;
    t1.sync.resync();
    await until(() => remoteHas(t1.repo, "タブ2の編集"));
    expect(await remoteHas(t1.repo, "タブ2の編集")).toBe(true);
    expect(warned(t1)).toBe(false);
    expect(t1.local.backups).toEqual([]);
    // 別の端末の変更も、そのまま取り込む
    await until(() => a.has("タブ2の編集"));
    a.edit("P の変更");
    await a.sync.flush();
    await until(() => t1.has("P の変更"));
    expect(t1.has("P の変更")).toBe(true);
    expect(warned(t1)).toBe(false);
    a.sync.stop();
    t1.sync.stop();
  });

  it("手元に保存できず基準を書けずにいる間に「同期をやり直す」を押しても、自分の送った内容を重なりと取り違えない（F2）", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", realDoc("最初"), { deferBase: true });
    await a.sync.start();
    a.local.saveFails = true;
    a.edit("送った変更");
    await a.sync.flush();
    await until(() => remoteHas(a.repo, "送った変更"));
    expect(a.local.pendingBase).not.toBeNull();
    a.edit("まだ送っていない変更");
    a.sync.resync({ userAsked: true });
    await until(() => remoteHas(a.repo, "まだ送っていない変更"));
    expect(await remoteHas(a.repo, "まだ送っていない変更")).toBe(true);
    expect(warned(a)).toBe(false);
    expect(a.local.backups).toEqual([]);
    expect(a.local.confirms).toEqual([]);
    a.sync.stop();
  });

  it("古い世代が戻ってきて送り直すときも、たどってきた世代を系譜に残す（ほかの端末が上書きと取り違えない）（F3）", async () => {
    const { be } = memoryBackend();
    const writesA: Array<Record<string, unknown>> = [];
    const a = device(recording(be, writesA), "A", realDoc("最初"));
    await a.sync.start();
    a.edit("A の変更 1");
    await a.sync.flush();
    await until(() => remoteHas(a.repo, "A の変更 1"));
    const F = writesA[writesA.length - 1]!;
    const b = device(be, "B", buildDemoDoc());
    await b.sync.start();
    expect(b.has("A の変更 1")).toBe(true);
    b.edit("B の変更");
    await b.sync.flush();
    await until(() => remoteHas(b.repo, "B の変更"));
    b.sync.stop();
    await until(() => a.has("B の変更"));
    a.edit("A の変更 2");
    await a.sync.flush();
    await until(() => remoteHas(a.repo, "A の変更 2"));
    // A の前の書き込み F が、もう一度届く
    await be.set(MANIFEST, F);
    await tick(50);
    await until(() => remoteHas(a.repo, "A の変更 2"));
    expect(await remoteHas(a.repo, "A の変更 2")).toBe(true);
    // B が戻ってくる: 送り直された内容を上書きと取り違えずに取り込む
    const b2 = device(be, "B2", structuredClone(b.store.doc), { idb: b.local.idb });
    await b2.sync.start();
    await until(() => b2.has("A の変更 2"));
    expect(b2.has("A の変更 2")).toBe(true);
    expect(warned(b2)).toBe(false);
    expect(await remoteHas(b2.repo, "A の変更 2")).toBe(true);
    a.sync.stop();
    b2.sync.stop();
  });

  it("読めない世代の中身をすでに持っている端末が送れば、その世代の印を外す（古い端末が後の作業を戻さない）（F5）", async () => {
    const { be, docs } = memoryBackend();
    const c = device(be, "C", realDoc("最初の内容"));
    await c.sync.start();
    c.sync.stop();
    const writesA: Array<Record<string, unknown>> = [];
    const a = device(recording(be, writesA), "A", buildDemoDoc());
    await a.sync.start();
    a.edit("A の変更");
    await a.sync.flush();
    await until(() => remoteHas(a.repo, "A の変更"));
    const D1 = writesA[writesA.length - 1]!;
    a.sync.stop();
    const b = device(be, "B", buildDemoDoc());
    await b.sync.start();
    for (const t of ["B の変更 1", "B の変更 2", "B の変更 3"]) {
      b.edit(t);
      await b.sync.flush();
      await until(() => remoteHas(b.repo, t));
    }
    b.sync.stop();
    // D1 の分割は片付けられ、その後 D1 の書き込みがもう一度届く
    for (const k of [...docs.keys()]) if (k.includes(`/parts/${String(D1.gen)}-`)) docs.delete(k);
    await be.set(MANIFEST, D1);
    // C（D1 のすぐ前の内容）が開いて書き直す
    const c2 = device(be, "C2", structuredClone(c.store.doc), { idb: c.local.idb });
    await c2.sync.start();
    await until(() => c2.local.notices.some((x) => x.includes("書き直しました")), 160, 50);
    expect((await c2.repo.readManifest())!.lost).toContain(String(D1.gen));
    c2.sync.stop();
    // B（D1 の中身を持つ）が開く: 自分の内容で戻し、D1 の印を外す
    const b2 = device(be, "B2", structuredClone(b.store.doc), { idb: b.local.idb });
    await b2.sync.start();
    await until(() => remoteHas(b2.repo, "B の変更 3"));
    expect((await b2.repo.readManifest())!.lost ?? []).not.toContain(String(D1.gen));
    b2.sync.stop();
    // A（D1 を確定した端末）が後から開く: B の作業を戻さずに取り込む
    const a2 = device(be, "A2", structuredClone(a.store.doc), { idb: a.local.idb });
    await a2.sync.start();
    await until(() => a2.has("B の変更 3"));
    expect(a2.has("B の変更 3")).toBe(true);
    expect(warned(a2)).toBe(false);
    expect(await remoteHas(a2.repo, "B の変更 3")).toBe(true);
    a2.sync.stop();
  });

  it("古い手元の端末が送っても、読めない世代の印を外さない（その世代を持つ端末が戻せる）（F6）", async () => {
    const { be, docs } = memoryBackend();
    const a = device(be, "A", realDoc("最初"));
    await a.sync.start();
    const oldA = structuredClone(a.store.doc);
    const b = device(be, "B", buildDemoDoc());
    await b.sync.start();
    b.sync.stop();
    a.edit("G にだけある変更");
    await a.sync.flush();
    await until(() => remoteHas(a.repo, "G にだけある変更"));
    const c = device(be, "C", buildDemoDoc());
    await c.sync.start();
    expect(c.has("G にだけある変更")).toBe(true);
    c.sync.stop();
    a.sync.stop();
    const G = (await a.repo.readManifest())!.gen;
    for (const k of [...docs.keys()]) if (k.includes(`/parts/${G}-`)) docs.delete(k);
    // B（G のすぐ前の内容）が編集して開き、書き直す
    const b2 = device(be, "B2", structuredClone(b.store.doc), { idb: b.local.idb });
    b2.edit("B の編集");
    await b2.sync.start();
    await until(() => b2.local.notices.some((x) => x.includes("書き直しました")), 160, 50);
    b2.sync.stop();
    // A が古いバックアップで開き、編集して送る（G の中身は持っていない）
    const a2 = device(be, "A2", oldA, { idb: a.local.idb, fallback: true });
    a2.edit("A の古い手元の編集");
    await a2.sync.start();
    await until(() => remoteHas(a2.repo, "A の古い手元の編集"));
    expect((await a2.repo.readManifest())!.lost).toContain(G);
    a2.sync.stop();
    // C（G の中身を持つ）が戻ってくる: 自分の内容で戻す
    const c2 = device(be, "C2", structuredClone(c.store.doc), { idb: c.local.idb });
    await c2.sync.start();
    await until(() => remoteHas(c2.repo, "G にだけある変更"));
    expect(await remoteHas(c2.repo, "G にだけある変更")).toBe(true);
    expect(c2.local.notices.some((x) => x.includes("書き直されていた"))).toBe(true);
    c2.sync.stop();
  });

  it("古い手元のときに古い世代が戻ってきたら止まって待ち、「同期をやり直す」でふつうの新しい写しと同じに扱う（F8）", async () => {
    const { be } = memoryBackend();
    const held: { data?: Record<string, unknown> } = {};
    let reject = false;
    const flaky: CloudBackend = {
      ...be,
      async set(path, data) {
        if (reject && path === MANIFEST) {
          reject = false;
          held.data = structuredClone(data);
          throw { code: "unavailable", message: "x" };
        }
        return be.set(path, data);
      },
    };
    const a = device(flaky, "A", realDoc("最初"));
    await a.sync.start();
    const g1doc = structuredClone(a.store.doc);
    reject = true;
    a.edit("変更 1");
    await a.sync.flush();
    a.edit("変更 2");
    a.sync.resync();
    await until(() => remoteHas(a.repo, "変更 2"));
    a.sync.stop();
    // 失敗したように見えた書き込みが、閉じている間に届く。A は古いバックアップで開く
    await be.set(MANIFEST, held.data!);
    const a2 = device(be, "A2", g1doc, { idb: a.local.idb, fallback: true });
    await a2.sync.start();
    await tick(60);
    expect(a2.sync.state).toBe("error");
    expect(a2.sync.message).toContain("同期をやり直す");
    a2.sync.resync({ userAsked: true });
    await until(() => a2.sync.state === "synced");
    expect(a2.sync.state).toBe("synced");
    expect(a2.has("変更 1")).toBe(true);
    a2.edit("その後の変更");
    await a2.sync.flush();
    await until(() => remoteHas(a2.repo, "その後の変更"));
    expect(await remoteHas(a2.repo, "その後の変更")).toBe(true);
    a2.sync.stop();
  });

  it("読めない写しで古い手元のときも、「同期をやり直す」を押せばこの端末の内容で書き直す（F9）", async () => {
    const { be, docs } = memoryBackend();
    const a = device(be, "A", realDoc("最初"));
    await a.sync.start();
    const old = structuredClone(a.store.doc);
    a.edit("A の変更");
    await a.sync.flush();
    await until(() => remoteHas(a.repo, "A の変更"));
    a.sync.stop();
    const G = (await a.repo.readManifest())!.gen;
    for (const k of [...docs.keys()]) if (k.includes(`/parts/${G}-`)) docs.delete(k);
    const a2 = device(be, "A2", old, { idb: a.local.idb, fallback: true });
    await a2.sync.start();
    await until(() => a2.sync.message.includes("最新の内容がある端末"), 160, 50);
    expect(a2.sync.state).toBe("error");
    expect(a2.sync.message).toContain("同期をやり直す");
    a2.sync.resync({ userAsked: true });
    await until(() => a2.sync.state === "synced", 160, 50);
    expect(a2.sync.state).toBe("synced");
    expect((await a2.repo.readManifest())!.lost).toContain(G);
    a2.sync.stop();
  });

  it("自分の前の確定が、別の端末の内容を読み込んだ後にもう一度届いても、取り込まれた古い内容のままにしない（F10）", async () => {
    const { be } = memoryBackend();
    const writesA: Array<Record<string, unknown>> = [];
    const a = device(recording(be, writesA), "A", realDoc("最初"));
    await a.sync.start();
    a.edit("A の変更");
    await a.sync.flush();
    await until(() => remoteHas(a.repo, "A の変更"));
    const G1 = writesA[writesA.length - 1]!;
    const b = device(be, "B", buildDemoDoc());
    await b.sync.start();
    b.edit("B の変更");
    await b.sync.flush();
    await until(() => remoteHas(b.repo, "B の変更"));
    await until(() => a.has("B の変更"));
    expect(a.has("B の変更")).toBe(true);
    b.sync.stop();
    await be.set(MANIFEST, G1);
    await tick(50);
    await until(() => remoteHas(a.repo, "B の変更"));
    expect(await remoteHas(a.repo, "B の変更")).toBe(true);
    expect(warned(a)).toBe(false);
    a.sync.stop();
  });

  it("今公開中の版で保存した基準でも、その版のタブの上書きを見分ける（F11）", async () => {
    const { be, docs } = memoryBackend();
    const a = device(be, "A", realDoc("最初"));
    await a.sync.start();
    const m0 = (await a.repo.readManifest())!;
    const d0 = structuredClone(a.store.doc);
    a.edit("A の変更");
    await a.sync.flush();
    await until(() => remoteHas(a.repo, "A の変更"));
    a.sync.stop();
    // A の基準を、今公開中の版が保存した形にする（通し番号と自分の確定の印はあるが、数え方・親・系譜は無い）
    const b0 = a.local.base!;
    a.local.idb.base = { gen: b0.gen, docId: b0.docId, docUpdatedAt: b0.docUpdatedAt, seq: b0.seq, own: true };
    // 今公開中の版のタブが、A の確定を知らないまま m0 の上に書く
    const v3be: CloudBackend = {
      ...be,
      async set(path, data) {
        if (path === MANIFEST) {
          const legacy = { ...data };
          delete legacy.chain;
          delete legacy.lost;
          return be.set(path, legacy);
        }
        return be.set(path, data);
      },
    };
    await new CloudRepo(v3be, "user1", "v3-tab").write(withNode(d0, "前の版のタブの変更"), m0);
    expect(docs.get(MANIFEST)!.chain).toBeUndefined();
    const a2 = device(be, "A2", structuredClone(a.store.doc), { idb: a.local.idb });
    await a2.sync.start();
    await until(() => warned(a2));
    expect(warned(a2)).toBe(true);
    expect(backedUp(a2, "前の版のタブの変更")).toBe(true);
    await until(() => remoteHas(a2.repo, "A の変更"));
    expect(await remoteHas(a2.repo, "A の変更")).toBe(true);
    a2.sync.stop();
  });

  it("初めての同期で「このブラウザの内容を使う」と答えた後、別の端末が保存中で待っても、もう一度は聞かない（F12）", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", realDoc("アカウントの内容"), { leaseMs: 250 });
    await a.sync.start();
    const b = device(be, "B", realDoc("このブラウザの内容"), { choice: "local", retryMs: 20 });
    await b.sync.start();
    await until(() => remoteHas(b.repo, "このブラウザの内容"), 120, 25);
    expect(await remoteHas(b.repo, "このブラウザの内容")).toBe(true);
    expect(b.local.asked).toBe(1);
    expect(backedUp(b, "アカウントの内容", "kept")).toBe(true);
    a.sync.stop();
    b.sync.stop();
  });
});

describe("同期の決まり: 第 4 回の再レビューの指摘", () => {
  const MANIFEST = "data/users/user1/fourd";
  const backedUp = (d: ReturnType<typeof device>, title: string, kind = "conflict") => d.local.backups.some((x) => x.kind === kind && Object.values(x.doc.nodes).some((n) => n.title === title));
  const warned = (d: ReturnType<typeof device>) => d.local.notices.some((x) => x.startsWith("warn:"));
  const recording = (be: CloudBackend, writes: Array<Record<string, unknown>>): CloudBackend => ({
    ...be,
    async set(path, data) {
      await be.set(path, data);
      if (path === MANIFEST) writes.push(structuredClone(data));
    },
  });
  const until = async (cond: () => boolean | Promise<boolean>, n = 80, ms = 25) => {
    for (let i = 0; i < n && !(await cond()); i++) await tick(ms);
  };
  /** 別の端末がまとめて書く（中身は問わない。世代と系譜だけを進める） */
  async function writeMany(repo: CloudRepo, doc: DocData, n: number): Promise<DocData> {
    let d = doc;
    for (let i = 0; i < n; i++) {
      d = structuredClone(d);
      const node = makeNode({ title: `P の変更 ${i}` });
      d.nodes[node.id] = node;
      d.updatedAt = new Date(Date.parse(d.updatedAt) + 1000).toISOString();
      await repo.write(d, await repo.readManifest());
    }
    return d;
  }

  it("ふつうの重なりで送るとき、系譜の窓から新しい世代を押し出さない（戻ってきた端末が上書きと取り違えない）（G1）", async () => {
    const { be } = memoryBackend();
    const p = new CloudRepo(be, "user1", "P");
    let pd = await writeMany(p, realDoc("P の内容"), 3);
    // A がその上に確定して閉じる（seq 4）
    const a = device(be, "A", buildDemoDoc());
    await a.sync.start();
    a.edit("A の変更");
    await a.sync.flush();
    await until(() => remoteHas(a.repo, "A の変更"));
    a.sync.stop();
    const aGen = a.local.base!.gen;
    expect(a.local.base!.own).toBe(true);
    // P が 62 回書く。D はその最新（R-1）を読み込んで閉じる。P がもう 1 回書く（R）
    pd = await writeMany(p, pd, 62);
    const d = device(be, "D", buildDemoDoc());
    await d.sync.start();
    d.sync.stop();
    await writeMany(p, pd, 1);
    // D が編集して開き直す: ふつうの重なり（P の内容を退避して、D の内容を送る）
    const d2 = device(be, "D2", structuredClone(d.store.doc), { idb: d.local.idb });
    d2.edit("D の編集");
    await d2.sync.start();
    await until(() => remoteHas(d2.repo, "D の編集"));
    const n = (await d2.repo.readManifest())!;
    expect(n.lineage).toContain(aGen);
    d2.sync.stop();
    // A が変更なしで開き直す: 上書きと取り違えずに取り込む
    const a2 = device(be, "A2", structuredClone(a.store.doc), { idb: a.local.idb });
    await a2.sync.start();
    await until(() => a2.has("D の編集"));
    expect(a2.has("D の編集")).toBe(true);
    expect(warned(a2)).toBe(false);
    expect(await remoteHas(a2.repo, "D の編集")).toBe(true);
    a2.sync.stop();
  });

  it("古い世代が戻ってきて「同期をやり直す」で読み込んだ後に送っても、持っていなかった新しい基準を書き残す（G2）", async () => {
    const { be } = memoryBackend();
    const writesA: Array<Record<string, unknown>> = [];
    const a = device(recording(be, writesA), "A", realDoc("最初"));
    await a.sync.start();
    const g1doc = structuredClone(a.store.doc);
    a.edit("変更 1");
    await a.sync.flush();
    await until(() => remoteHas(a.repo, "変更 1"));
    const g2 = writesA[writesA.length - 1]!;
    a.edit("変更 2");
    await a.sync.flush();
    await until(() => remoteHas(a.repo, "変更 2"));
    // H が新しい内容（g3）を読み込んで眠る。A は閉じる
    const h = device(be, "H", buildDemoDoc());
    await h.sync.start();
    expect(h.has("変更 2")).toBe(true);
    h.sync.stop();
    a.sync.stop();
    // g2 の書き込みがもう一度届く。A は古いバックアップで開き、「同期をやり直す」で g2 を読み込んで編集する
    await be.set(MANIFEST, g2);
    const a2 = device(be, "A2", g1doc, { idb: a.local.idb, fallback: true });
    await a2.sync.start();
    await tick(60);
    expect(a2.sync.state).toBe("error");
    a2.sync.resync({ userAsked: true });
    await until(() => a2.sync.state === "synced");
    expect(a2.local.notices.some((x) => x.includes("古い内容に戻っていた物"))).toBe(true);
    a2.edit("A の続きの編集");
    await a2.sync.flush();
    await until(() => remoteHas(a2.repo, "A の続きの編集"));
    a2.sync.stop();
    // H が起きる: 新しい内容（変更 2）を黙って失わず、自分の内容で戻す（A の編集は退避に残る）
    const h2 = device(be, "H2", structuredClone(h.store.doc), { idb: h.local.idb });
    await h2.sync.start();
    await until(() => remoteHas(h2.repo, "変更 2"));
    expect(await remoteHas(h2.repo, "変更 2")).toBe(true);
    expect(warned(h2)).toBe(true);
    expect(backedUp(h2, "A の続きの編集")).toBe(true);
    h2.sync.stop();
  });

  it("古い世代の上に送り直しても、読めずに置き換えた世代の印を落とさない（その世代を持つ端末が戻せる）（G3）", async () => {
    const { be, docs } = memoryBackend();
    const writesC: Array<Record<string, unknown>> = [];
    const c = device(recording(be, writesC), "C", realDoc("最初の内容"));
    await c.sync.start();
    const g0 = writesC[writesC.length - 1]!;
    c.sync.stop();
    // X が G を確定して閉じる（G にしか無い変更）
    const x = device(be, "X", buildDemoDoc());
    await x.sync.start();
    x.edit("G の変更");
    await x.sync.flush();
    await until(() => remoteHas(x.repo, "G の変更"));
    x.sync.stop();
    const G = x.local.base!.gen;
    // G の分割が無くなり、C（G のすぐ前の内容）が書き直す
    for (const k of [...docs.keys()]) if (k.includes(`/parts/${G}-`)) docs.delete(k);
    const c2 = device(be, "C2", structuredClone(c.store.doc), { idb: c.local.idb });
    await c2.sync.start();
    await until(() => c2.local.notices.some((n) => n.includes("書き直しました")), 160, 50);
    c2.sync.stop();
    // D が書き直された内容を読み込んで確定する
    const d = device(be, "D", buildDemoDoc());
    await d.sync.start();
    d.edit("D の変更");
    await d.sync.flush();
    await until(() => remoteHas(d.repo, "D の変更"));
    expect((await d.repo.readManifest())!.lost).toContain(G);
    // C の最初の書き込み（g0）がもう一度届く: D が送り直す
    await be.set(MANIFEST, g0);
    await tick(50);
    await until(() => remoteHas(d.repo, "D の変更"));
    expect((await d.repo.readManifest())!.lost).toContain(G);
    d.sync.stop();
    // X が変更なしで開き直す: G の変更を黙って失わず、戻す
    const x2 = device(be, "X2", structuredClone(x.store.doc), { idb: x.local.idb });
    await x2.sync.start();
    await until(() => remoteHas(x2.repo, "G の変更"));
    expect(await remoteHas(x2.repo, "G の変更")).toBe(true);
    expect(warned(x2)).toBe(true);
    x2.sync.stop();
  });
});

describe("同期の決まり: 第 5 回の再レビューの指摘", () => {
  const MANIFEST = "data/users/user1/fourd";
  const warned = (d: ReturnType<typeof device>) => d.local.notices.some((x) => x.startsWith("warn:"));
  const until = async (cond: () => boolean | Promise<boolean>, n = 160, ms = 25) => {
    for (let i = 0; i < n && !(await cond()); i++) await tick(ms);
  };
  const bump = (doc: DocData, title: string): DocData => {
    const d = structuredClone(doc);
    const node = makeNode({ title });
    d.nodes[node.id] = node;
    d.updatedAt = new Date(Date.parse(d.updatedAt) + 1000).toISOString();
    return d;
  };
  /** 返事が届かず、後から届く確定（分割は書き、マニフェストは持っておく） */
  async function lateCommit(be: CloudBackend, holder: string, doc: DocData, prev: Manifest | null): Promise<Record<string, unknown>> {
    let held: Record<string, unknown> | null = null;
    const cap: CloudBackend = {
      ...be,
      async set(path, data) {
        if (path === MANIFEST) {
          held = structuredClone(data);
          throw { code: "unavailable", message: "timeout" };
        }
        return be.set(path, data);
      },
    };
    const r = new CloudRepo(cap, "user1", holder);
    const p = await r.prepare(doc);
    await r.writeParts(p);
    await r.commit(p, prev).catch(() => undefined);
    return held!;
  }

  it("同じ古い書き込みが 2 回届いて 2 回送り直しても、たどってきた世代を系譜から落とさない（H1）", async () => {
    const { be } = memoryBackend();
    const p = new CloudRepo(be, "user1", "P");
    let pd = realDoc("P の内容");
    for (let i = 0; i < 3; i++) {
      pd = bump(pd, `P の変更 ${i}`);
      await p.write(pd, await p.readManifest());
    }
    const y = structuredClone((await be.get(MANIFEST)).data!);
    const e = device(be, "E", buildDemoDoc());
    await e.sync.start();
    e.edit("E の変更");
    await e.sync.flush();
    await until(() => remoteHas(e.repo, "E の変更"));
    const X = e.local.base!.gen;
    e.sync.stop();
    const d = device(be, "D", buildDemoDoc());
    await d.sync.start();
    d.edit("D の変更");
    await d.sync.flush();
    await until(() => remoteHas(d.repo, "D の変更"));
    for (let k = 0; k < 2; k++) {
      await be.set(MANIFEST, y);
      await until(async () => (await d.repo.readManifest())!.gen !== y.gen && d.sync.state === "synced");
      expect((await d.repo.readManifest())!.lineage).toContain(X);
    }
    d.sync.stop();
    const e2 = device(be, "E2", structuredClone(e.store.doc), { idb: e.local.idb });
    await e2.sync.start();
    await until(() => e2.has("D の変更") || warned(e2));
    expect(warned(e2)).toBe(false);
    expect(e2.has("D の変更")).toBe(true);
    expect(await remoteHas(e2.repo, "D の変更")).toBe(true);
    e2.sync.stop();
  });

  it("64 世代より後に古い書き込みが届いて送り直しても、基準の系譜を落とさない（H2）", async () => {
    const { be } = memoryBackend();
    const p = new CloudRepo(be, "user1", "P");
    let pd = realDoc("P の内容");
    for (let i = 0; i < 30; i++) {
      pd = bump(pd, `P の変更 ${i}`);
      await p.write(pd, await p.readManifest());
    }
    const f = await lateCommit(be, "F", bump(pd, "遅れて届く変更"), await p.readManifest());
    for (let i = 0; i < 40; i++) {
      pd = bump(pd, `P の続き ${i}`);
      await p.write(pd, await p.readManifest());
    }
    const e = device(be, "E", buildDemoDoc());
    await e.sync.start();
    e.edit("E の変更");
    await e.sync.flush();
    await until(() => remoteHas(e.repo, "E の変更"));
    const X = e.local.base!.gen;
    e.sync.stop();
    const d = device(be, "D", buildDemoDoc());
    await d.sync.start();
    for (let i = 0; i < 25; i++) {
      d.edit(`D の変更 ${i}`);
      await d.sync.flush();
      await until(() => remoteHas(d.repo, `D の変更 ${i}`));
    }
    await be.set(MANIFEST, f);
    await until(async () => (await d.repo.readManifest())!.gen !== f.gen && d.sync.state === "synced");
    expect((await d.repo.readManifest())!.lineage).toContain(X);
    d.sync.stop();
    const e2 = device(be, "E2", structuredClone(e.store.doc), { idb: e.local.idb });
    await e2.sync.start();
    await until(() => e2.has("D の変更 24") || warned(e2));
    expect(warned(e2)).toBe(false);
    expect(e2.has("D の変更 24")).toBe(true);
    expect(await remoteHas(e2.repo, "D の変更 24")).toBe(true);
    e2.sync.stop();
  });

  it("ふつうの重なりで送るとき、戻された世代の印を生き返らせない（2 台目の持ち主が古い内容で戻さない）（H3）", async () => {
    const { be, docs } = memoryBackend();
    const c = device(be, "C", realDoc("最初の内容"));
    await c.sync.start();
    c.sync.stop();
    const x = device(be, "X", buildDemoDoc());
    await x.sync.start();
    x.edit("G の変更");
    await x.sync.flush();
    await until(() => remoteHas(x.repo, "G の変更"));
    const G = x.local.base!.gen;
    x.sync.stop();
    const k = device(be, "K", buildDemoDoc());
    await k.sync.start();
    expect(k.local.base!.gen).toBe(G);
    k.sync.stop();
    // G の分割が無くなり、C が書き直す（G に印）
    for (const key of [...docs.keys()]) if (key.includes(`/parts/${G}-`)) docs.delete(key);
    const c2 = device(be, "C2", structuredClone(c.store.doc), { idb: c.local.idb });
    await c2.sync.start();
    await until(() => c2.local.notices.some((n) => n.includes("書き直しました")), 160, 50);
    c2.sync.stop();
    // D が書き直された内容を読み込み、編集中（まだ送らない）
    const d = device(be, "D", buildDemoDoc(), { debounceMs: 60_000 });
    await d.sync.start();
    d.edit("D の編集");
    // X が開いて G を戻す（印が外れる）
    const x2 = device(be, "X2", structuredClone(x.store.doc), { idb: x.local.idb });
    await x2.sync.start();
    await until(async () => (await x2.repo.readManifest())!.lost?.includes(G) === false);
    // D は重なりとして送る: 戻された G の印を生き返らせない
    await until(() => remoteHas(d.repo, "D の編集").catch(() => false));
    expect((await d.repo.readManifest())!.lost ?? []).not.toContain(G);
    x2.sync.stop();
    d.sync.stop();
    // K（G を持つ 2 台目、変更なし）が開く: D の編集を古い内容で戻さない
    const k2 = device(be, "K2", structuredClone(k.store.doc), { idb: k.local.idb });
    await k2.sync.start();
    await until(() => k2.has("D の編集"));
    expect(await remoteHas(k2.repo, "D の編集")).toBe(true);
    expect(k2.has("D の編集")).toBe(true);
    k2.sync.stop();
  });
});
