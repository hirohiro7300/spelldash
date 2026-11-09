import { describe, expect, it, vi } from "vitest";
import { buildDemoDoc, isDisposableDoc } from "../../src/demo/demo";
import { buildStressDoc } from "../../src/demo/stress";
import { SCHEMA_VERSION, createEmptyDoc, makeNode } from "../../src/model/schema";
import type { DocData } from "../../src/model/types";
import { CloudRepo, CloudSync, decodeDoc, encodeDoc, type CloudBackend, type CloudDoc, type SyncBase } from "../../src/persist/cloud";
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

interface DeviceOpts {
  uid?: string;
  base?: SyncBase | null;
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
}

/** 1 つの端末（App と同じつなぎ方: 本物の Store。取り込み中は markDirty しない。初回・選択の取り込みは Undo の対象外） */
function device(be: CloudBackend, name: string, doc: DocData, opts: DeviceOpts = {}) {
  const store = new Store(doc);
  const local = {
    base: (opts.base ?? null) as SyncBase | null,
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
  };
  const repo = new CloudRepo(be, opts.uid ?? "user1", name);
  const sync = new CloudSync(
    repo,
    {
      getDoc: () => store.doc,
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
      readBase: async () => local.base,
      writeBase: async (b) => void (local.base = b),
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
    docs.delete(`data/users/u/fourd/parts/${m.gen}-0`);
    await expect(repo.read()).rejects.toMatchObject({ code: "unavailable" });
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
    await tick(60);
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
    const idb = { base: null as SyncBase | null };
    const share = (d: ReturnType<typeof device>) => Object.defineProperty(d.local, "base", { get: () => idb.base, set: (v: SyncBase | null) => void (idb.base = v), configurable: true });
    const tab1 = device(be, "T1", buildDemoDoc());
    share(tab1);
    await tab1.sync.start();
    const tab2 = device(be, "T2", tab1.store.doc, { writer: false });
    share(tab2);
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
