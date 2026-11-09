import { describe, expect, it } from "vitest";
import { buildDemoDoc } from "../../src/demo/demo";
import { buildStressDoc } from "../../src/demo/stress";
import { CloudRepo, CloudSync, decodeDoc, encodeDoc, type CloudBackend, type CloudDoc, type SyncBase } from "../../src/persist/cloud";
import { nextStamp } from "../../src/model/ids";
import { makeNode } from "../../src/model/schema";
import type { DocData } from "../../src/model/types";

const LIMIT = 256 * 1024;

/** db の代わり（256 KiB の上限・購読・貸し出しを真似る） */
function memoryBackend() {
  const docs = new Map<string, Record<string, unknown>>();
  const watchers = new Map<string, Set<(d: CloudDoc) => void>>();
  const leases = new Map<string, { holder: string; until: number }>();
  const state = { failNext: "" as string, writes: 0, now: 0 };
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
      if (JSON.stringify(data).length > LIMIT) throw { code: "invalid_argument", message: "too big" };
      state.writes++;
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
  };
  return { be, docs, state, leases };
}

/** 1 つの端末（手元のドキュメントとバックアップと基準） */
function device(be: CloudBackend, name: string, doc: DocData, opts: { fresh?: boolean; writer?: boolean; stampOnAdopt?: boolean } = {}) {
  const local = { doc, base: null as SyncBase | null, backups: [] as Array<{ doc: DocData; label: string }>, notices: [] as string[], adopted: 0, writer: opts.writer ?? true };
  const repo = new CloudRepo(be, "user1", name);
  const sync = new CloudSync(
    repo,
    {
      getDoc: () => local.doc,
      isWriter: () => local.writer,
      adopt: (d) => {
        // 実際のストアは入れ替えでも更新時刻を進める（stampOnAdopt で真似る）
        local.doc = opts.stampOnAdopt ? { ...d, updatedAt: nextStamp(local.doc.updatedAt > d.updatedAt ? local.doc.updatedAt : d.updatedAt) } : d;
        local.adopted++;
      },
      backup: async (d, label) => void local.backups.push({ doc: d, label }),
      readBase: async () => local.base,
      writeBase: async (b) => void (local.base = b),
      notice: (t) => void local.notices.push(t),
    },
    { localFresh: opts.fresh ?? false, debounceMs: 5, leaseMs: 20, retryMs: 10 },
  );
  const edit = (title: string) => {
    const n = makeNode({ title });
    local.doc = { ...local.doc, nodes: { ...local.doc.nodes, [n.id]: n }, updatedAt: new Date(Date.parse(local.doc.updatedAt) + 1000 + Math.random() * 1000).toISOString() };
    sync.markDirty();
  };
  return { local, repo, sync, edit };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("符号化", () => {
  it("gzip + base64 で往復でき、2,000 ノードでも分割の 1 つずつが 256 KiB に収まる", async () => {
    const demo = buildDemoDoc();
    const e = await encodeDoc(demo);
    expect(e.enc).toBe("gzip-b64");
    expect(await decodeDoc(e.enc, e.payload)).toEqual(demo);

    const { be, docs } = memoryBackend();
    const repo = new CloudRepo(be, "u", "dev");
    const big = buildStressDoc(2000);
    const m = await repo.write(big, null);
    for (const [, d] of docs) expect(JSON.stringify(d).length).toBeLessThan(LIMIT);
    expect(m.bytes).toBeGreaterThan(LIMIT); // そのままでは入らない大きさ
    const back = await repo.read();
    expect(back!.doc).toEqual(big);
    expect(back!.manifest.nodes).toBe(2000);
  });

  it("古い世代の分割は 2 分たってから次の送信で片付ける", async () => {
    const { be, docs } = memoryBackend();
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
  });

  it("分割が消えていたら読み直し、壊れていたら壊れていると言う", async () => {
    const { be, docs } = memoryBackend();
    const repo = new CloudRepo(be, "u", "dev");
    const m = await repo.write(buildDemoDoc(), null);
    docs.delete(`data/users/u/fourd/parts/${m.gen}-0`);
    await expect(repo.read()).rejects.toMatchObject({ code: "unavailable" });
    await repo.write(buildDemoDoc(), m);
    const m2 = await repo.readManifest();
    docs.set(`data/users/u/fourd/parts/${m2!.gen}-0`, { gen: m2!.gen, i: 0, savedAt: "", data: "AAAA" });
    await expect(repo.read()).rejects.toMatchObject({ code: "corrupt" });
  });
});

describe("同期の決まり", () => {
  it("初めての端末: クラウドが空なら手元を送る", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", buildDemoDoc(), { fresh: true });
    await a.sync.start();
    expect(a.sync.state).toBe("synced");
    const remote = await a.repo.read();
    expect(remote!.doc.id).toBe(a.local.doc.id);
  });

  it("新しい端末（まだ何も変えていないデモ）はアカウントの内容を読み込む", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", buildDemoDoc(), { fresh: true });
    await a.sync.start();
    a.edit("A で書いた");
    await a.sync.flush();
    const b = device(be, "B", buildDemoDoc(), { fresh: true });
    await b.sync.start();
    expect(b.local.adopted).toBe(1);
    expect(Object.values(b.local.doc.nodes).some((n) => n.title === "A で書いた")).toBe(true);
    expect(b.local.notices.join()).toContain("読み込みました");
    expect(b.local.backups).toHaveLength(0);
  });

  it("手元が変わらない間に別の端末が書いたら、見張りで取り込む", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", buildDemoDoc(), { fresh: true });
    await a.sync.start();
    const b = device(be, "B", buildDemoDoc(), { fresh: true });
    await b.sync.start();
    b.edit("B の変更");
    await b.sync.flush();
    await tick(120);
    expect(Object.values(a.local.doc.nodes).some((n) => n.title === "B の変更")).toBe(true);
    expect(a.local.backups).toHaveLength(0);
  });

  it("読み込みで手元の更新時刻が進んでも、送り返さない（端末どうしで行ったり来たりしない）", async () => {
    const { be, state } = memoryBackend();
    const a = device(be, "A", buildDemoDoc(), { fresh: true, stampOnAdopt: true });
    await a.sync.start();
    const b = device(be, "B", buildDemoDoc(), { fresh: true, stampOnAdopt: true });
    await b.sync.start();
    expect(b.local.adopted).toBe(1);
    b.edit("B の変更");
    await b.sync.flush();
    await tick(120);
    expect(Object.values(a.local.doc.nodes).some((n) => n.title === "B の変更")).toBe(true);
    const settled = state.writes;
    const gen = (await a.repo.readManifest())!.gen;
    await a.sync.flush();
    await b.sync.flush();
    await tick(150);
    expect(state.writes).toBe(settled);
    expect((await a.repo.readManifest())!.gen).toBe(gen);
    expect(a.local.adopted).toBe(1);
    expect(b.local.adopted).toBe(1);
    expect([a.sync.state, b.sync.state]).toEqual(["synced", "synced"]);
  });

  it("両方が変わったら、手元で送り、相手の内容はバックアップに残す（どちらも消えない）", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", buildDemoDoc(), { fresh: true });
    await a.sync.start();
    const b = device(be, "B", buildDemoDoc(), { fresh: true });
    await b.sync.start();
    // A は見張りを止めて（オフラインのつもり）、両方で書く
    a.sync.stop();
    const a2 = device(be, "A", a.local.doc);
    a2.local.base = a.local.base;
    b.edit("B の変更");
    await b.sync.flush();
    await tick(60);
    a2.edit("A の変更");
    await a2.sync.start();
    await tick(120);
    expect(a2.local.backups).toHaveLength(1);
    expect(Object.values(a2.local.backups[0]!.doc.nodes).some((n) => n.title === "B の変更")).toBe(true);
    const remote = await a2.repo.read();
    expect(Object.values(remote!.doc.nodes).some((n) => n.title === "A の変更")).toBe(true);
    expect(a2.local.notices.join()).toContain("バックアップ");
  });

  it("基準を失っても、中身が同じなら重なりとして扱わない", async () => {
    const { be } = memoryBackend();
    const a = device(be, "A", buildDemoDoc(), { fresh: true });
    await a.sync.start();
    const again = device(be, "A", a.local.doc); // 基準なし・未変更ではない扱い
    await again.sync.start();
    expect(again.local.backups).toHaveLength(0);
    expect(again.local.adopted).toBe(0);
    expect(again.sync.state).toBe("synced");
  });

  it("手元の変更はまとめて送る（入力のたびには送らない）", async () => {
    const { be, state } = memoryBackend();
    const a = device(be, "A", buildDemoDoc(), { fresh: true });
    await a.sync.start();
    const before = state.writes;
    for (let i = 0; i < 5; i++) a.edit(`入力 ${i}`);
    await tick(80);
    expect(state.writes - before).toBeLessThanOrEqual(3); // 分割 1 + マニフェスト 1（遅れて 1 回まで）
    expect(a.sync.state).toBe("synced");
  });

  it("書けない権限（閲覧のみの共有）なら、このブラウザだけに保存する状態になる", async () => {
    const { be, state } = memoryBackend();
    state.failNext = "invalid_argument";
    const a = device(be, "A", buildDemoDoc(), { fresh: true });
    await a.sync.start();
    expect(a.sync.state).toBe("denied");
    a.edit("x");
    await tick();
    expect(a.sync.state).toBe("denied");
  });

  it("編集できないタブは送らない", async () => {
    const { be, state } = memoryBackend();
    const a = device(be, "A", buildDemoDoc(), { fresh: true, writer: false });
    await a.sync.start();
    expect(state.writes).toBe(0);
  });

  it("別の端末が送信中（貸し出し中）なら待ってから送る", async () => {
    const { be, leases } = memoryBackend();
    leases.set("data/users/user1/fourd-lock", { holder: "other", until: Number.MAX_SAFE_INTEGER });
    const a = device(be, "A", buildDemoDoc(), { fresh: true });
    await a.sync.start();
    expect(a.sync.state).toBe("pending");
    expect(await a.repo.readManifest()).toBeNull();
    a.sync.stop();
  });

  it("アカウントの写しが壊れていたら、手元の内容で書き直す", async () => {
    const { be, docs } = memoryBackend();
    const a = device(be, "A", buildDemoDoc(), { fresh: true });
    await a.sync.start();
    const m = await a.repo.readManifest();
    docs.set(`data/users/user1/fourd/parts/${m!.gen}-0`, { gen: m!.gen, i: 0, savedAt: "", data: "AAAA" });
    await tick(40);
    const b = device(be, "B", buildDemoDoc());
    const seen: string[] = [];
    b.sync.on((s) => seen.push(s));
    b.edit("B の手元");
    await b.sync.start();
    await tick(2300);
    expect(seen).toContain("error"); // 壊れていたことは知らせる
    const remote = await b.repo.read();
    expect(Object.values(remote!.doc.nodes).some((n) => n.title === "B の手元")).toBe(true);
    expect(b.sync.state).toBe("synced");
    b.sync.stop();
  });
});
