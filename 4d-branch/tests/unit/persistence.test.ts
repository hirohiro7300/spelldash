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

  it("緊急コピー: 本体がその元の版のままなら、時刻が古く見えても写しの方を採る（時計のずれ・古い時刻の取り込み）", async () => {
    const kv = memoryKV();
    const name = `test-${++dbSeq}`;
    const p = makeP(kv, name);
    await p.open();
    await p.acquireWriter();
    await p.loadInitial();
    const doc = createEmptyDoc("最初");
    doc.updatedAt = new Date(Date.now() + 3_600_000).toISOString(); // 時計が進んでいた端末で保存された
    p.attach(() => doc);
    p.markDirty();
    await p.flush();
    const later = { ...doc, nodes: { ...doc.nodes }, updatedAt: new Date(Date.now()).toISOString() };
    const n = makeNode({ title: "閉じる直前" });
    later.nodes[n.id] = n;
    p.attach(() => later);
    p.markDirty();
    p.writeEmergency();
    p.close();
    const next = makeP(kv, name);
    await next.open();
    await next.acquireWriter();
    const { doc: back, notices } = await next.loadInitial();
    expect(back!.nodes[n.id]?.title).toBe("閉じる直前");
    expect(notices.join()).toContain("復元しました");
  });

  it("緊急コピー: 重なった写しの退避に失敗したら、写しは消さずに残す", async () => {
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
    const other = makeP(kv, name);
    await other.open();
    await other.acquireWriter();
    (other as unknown as { rev: number }).rev = 1;
    const otherDoc = createEmptyDoc("別のタブ");
    other.attach(() => otherDoc);
    other.markDirty();
    await other.flush();
    const next = makeP(kv, name);
    await next.open();
    await next.acquireWriter();
    (next as unknown as { createBackup: () => Promise<never> }).createBackup = () => Promise.reject(new DOMException("full", "QuotaExceededError"));
    const { notices } = await next.loadInitial();
    expect(notices.join()).toContain("消さずに残しています");
    expect(hasEmergency(kv)).toBe(true);
  });

  it("保存に失敗している間は、入力のたびに保存し直したり緊急コピーを書いたりしない", async () => {
    const kv = memoryKV();
    const p = makeP(kv);
    await p.open();
    await p.acquireWriter();
    await p.loadInitial();
    const doc = createEmptyDoc("最初");
    p.attach(() => doc);
    let attempts = 0;
    (p as unknown as { writeStored: () => Promise<number> }).writeStored = async () => {
      attempts++;
      throw new DOMException("full", "QuotaExceededError");
    };
    let emergencyWrites = 0;
    const set = kv.set;
    kv.set = (k, v) => {
      if (k.includes(":emergency:")) emergencyWrites++;
      set(k, v);
    };
    p.markDirty();
    await p.flush();
    expect(p.status).toBe("error");
    for (let i = 0; i < 10; i++) {
      edit(doc, `入力 ${i}`);
      p.markDirty();
      await wait(5);
    }
    await wait(30);
    expect(attempts).toBe(1);
    expect(emergencyWrites).toBe(1);
    expect(p.status).toBe("error");
    p.close();
  });

  it("保存できた内容の印は、保存し終えてから進み、失敗では進まない（同期の基準を手元より先に書かない）", async () => {
    const kv = memoryKV();
    const name = `test-${++dbSeq}`;
    const p = makeP(kv, name);
    await p.open();
    await p.acquireWriter();
    await p.loadInitial();
    expect(p.lastStored).toBeNull();
    const doc = createEmptyDoc("最初");
    p.attach(() => doc);
    p.markDirty();
    await p.flush();
    const first = { id: doc.id, updatedAt: doc.updatedAt };
    expect(p.lastStored).toEqual(first);
    type W = { writeStored: (d: DocData, r: number) => Promise<number> };
    const real = (p as unknown as W).writeStored.bind(p);
    let fail = true;
    (p as unknown as W).writeStored = async (d, r) => {
      if (fail) throw new DOMException("full", "QuotaExceededError");
      return real(d, r);
    };
    const seen: Array<{ status: string; stored: unknown }> = [];
    p.on("status", (st) => seen.push({ status: st.status, stored: p.lastStored && { ...p.lastStored } }));
    edit(doc, "保存できない変更");
    p.markDirty();
    await p.flush();
    expect(p.status).toBe("error");
    expect(p.lastStored).toEqual(first);
    // 「保存中」の知らせの時点では、まだ前の印（ここで基準を書くと、保存に失敗したときに先へ進んでしまう）
    expect(seen.find((x) => x.status === "saving")?.stored).toEqual(first);
    fail = false;
    await p.flush();
    expect(p.status).toBe("saved");
    expect(p.lastStored).toEqual({ id: doc.id, updatedAt: doc.updatedAt });
    p.close();
    // 開き直すと、保存してあった内容の印から始まる
    const again = makeP(kv, name);
    await again.open();
    await again.acquireWriter();
    const loaded = await again.loadInitial();
    expect(loaded.recovered).toBe(false);
    expect(again.lastStored).toEqual({ id: doc.id, updatedAt: doc.updatedAt });
    again.close();
  });

  it("保存してあった内容を読めないとき、「退避」「選ばなかった内容」のバックアップでは始めない（ほかの端末の内容を手元として送らない）", async () => {
    const kv = memoryKV();
    const name = `test-${++dbSeq}`;
    const p = makeP(kv, name);
    await p.open();
    await p.acquireWriter();
    await p.loadInitial();
    const doc = edit(createEmptyDoc("本体"), "このブラウザの内容");
    p.attach(() => doc);
    p.markDirty();
    await p.flush();
    await p.createBackup("auto", "自動のバックアップ", doc);
    await wait(5);
    const other = edit(structuredClone(doc), "別の端末の内容");
    await p.createBackup("conflict", "別の端末で保存されていた内容", other);
    await wait(5);
    await p.createBackup("kept", "選ばなかった内容", other);
    p.close();
    // 保存してあった本体が読めなくなる
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open(name);
      r.onerror = () => reject(r.error);
      r.onsuccess = () => {
        const t = r.result.transaction("kv", "readwrite");
        t.objectStore("kv").put("壊れた内容", "doc");
        t.oncomplete = () => {
          r.result.close();
          resolve();
        };
        t.onerror = () => reject(t.error);
      };
    });
    const again = makeP(kv, name);
    await again.open();
    await again.acquireWriter();
    const loaded = await again.loadInitial();
    expect(loaded.recovered).toBe(true);
    const titles = Object.values(loaded.doc!.nodes).map((n) => n.title);
    expect(titles).toContain("このブラウザの内容");
    expect(titles).not.toContain("別の端末の内容");
    expect(again.lastStored).toBeNull();
    again.close();
  });

  it("本体が読めなくても、その版の続きの緊急コピー（入れ替えた直後に閉じた）で始めたなら、代わりの内容とは見なさない", async () => {
    const kv = memoryKV();
    const name = `test-${++dbSeq}`;
    const p = makeP(kv, name);
    await p.open();
    await p.acquireWriter();
    await p.loadInitial();
    let current = edit(createEmptyDoc("本体"), "保存した内容");
    p.attach(() => current);
    p.markDirty();
    await p.flush();
    await p.createBackup("safety", "入れ替える前", current);
    // 取り込み（置き換え）の直後、保存される前に閉じた: 緊急コピーだけが新しい内容を持つ
    const replaced = edit(createEmptyDoc("取り込んだ内容"), "取り込んだノード");
    // ストアの入れ替えと同じく、時刻は前の内容より必ず進める（同じミリ秒に並ぶと新しい方と分からない）
    replaced.updatedAt = nextStamp(current.updatedAt);
    current = replaced;
    p.markDirty();
    p.writeEmergency();
    p.close();
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open(name);
      r.onerror = () => reject(r.error);
      r.onsuccess = () => {
        const t = r.result.transaction("kv", "readwrite");
        t.objectStore("kv").put("壊れた内容", "doc");
        t.oncomplete = () => {
          r.result.close();
          resolve();
        };
        t.onerror = () => reject(t.error);
      };
    });
    const again = makeP(kv, name);
    await again.open();
    await again.acquireWriter();
    const loaded = await again.loadInitial();
    expect(loaded.doc!.id).toBe(replaced.id);
    expect(loaded.recovered).toBe(false);
    again.close();
  });

  it("写せない中身のバックアップは失敗として返し、見出しだけの行を残さない", async () => {
    const p = makeP(memoryKV());
    await p.open();
    await p.acquireWriter();
    const bad = { ...createEmptyDoc("x"), meta: { f: () => 1 } } as unknown as DocData;
    await expect(p.createBackup("manual", "写せない", bad)).rejects.toBeTruthy();
    expect(await p.listBackups()).toEqual([]);
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

/**
 * 1 つのロックだけを扱う小さな Web Locks。ctl.deny: 要求をすべて断る（保存を禁じた枠の中などの SecurityError）。
 * ctl.hold: 答えを止めておき、release() でまとめて出す
 */
function fakeLocks(init: { deny?: boolean; hold?: boolean } = {}) {
  const ctl = { deny: false, hold: false, ...init };
  let holder: ((err: unknown) => void) | null = null;
  const waiting: Array<() => void> = [];
  const request = (name: string, options: LockOptions, cb: (lock: Lock | null) => unknown): Promise<unknown> => {
    if (ctl.deny) return Promise.reject(new DOMException("The request was denied.", "SecurityError"));
    return new Promise((resolve, reject) => {
      const answer = () => {
        if (holder && !options.steal) {
          // ifAvailable だけを扱う（このアプリは待つ要求を出さない）
          void Promise.resolve(cb(null)).then(resolve, reject);
          return;
        }
        holder?.(new DOMException("The lock request is aborted.", "AbortError"));
        holder = reject;
        void Promise.resolve(cb({ name, mode: "exclusive" } as Lock)).then(resolve, reject);
      };
      if (ctl.hold) waiting.push(answer);
      else setTimeout(answer);
    });
  };
  return { ctl, locks: { request } as unknown as LockManager, release: () => waiting.splice(0).forEach((f) => f()) };
}

describe("Persistence（タブのロック）", () => {
  const makeL = (kv: SyncKV, name: string, locks: LockManager, lockTimeoutMs?: number) => new Persistence({ dbName: name, kv, locks, channel: false, debounceMs: 1, lockTimeoutMs });

  /** 固まらないことを確かめる（ms 待っても終わらなければ失敗） */
  const settles = <T>(p: Promise<T>, ms = 1000): Promise<T> => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${ms}ms 待っても終わらない`)), ms))]);

  /** 編集できるタブとして保存まで通る */
  async function canSave(p: Persistence): Promise<void> {
    const doc = createEmptyDoc("保存できるか");
    p.attach(() => doc);
    p.markDirty();
    await p.flush();
    expect(p.status).toBe("saved");
    expect((await p.readStored())!.doc.title).toBe("保存できるか");
  }

  it("ロックの要求が断られても（保存を禁じた枠の中など）起動は止まらず、ロック無しで編集できるタブになる", async () => {
    const p = makeL(memoryKV(), `test-${++dbSeq}`, fakeLocks({ deny: true }).locks);
    await p.open();
    expect(await settles(p.acquireWriter())).toBe(true);
    expect(p.writer).toBe(true);
    await p.loadInitial();
    await canSave(p);
  });

  it("引き継ぎでロックの要求が断られても止まらず、編集できるタブになる", async () => {
    const p = makeL(memoryKV(), `test-${++dbSeq}`, fakeLocks({ deny: true }).locks);
    await p.open();
    await p.loadInitial();
    expect(p.writer).toBe(false);
    await settles(p.takeOver());
    expect(p.writer).toBe(true);
    await canSave(p);
  });

  it("ロックの答えが来ないときは上限まで待ってロック無しで続け、遅れて取れたロックは持つ（引き継がれたら閲覧のみ）", async () => {
    const { ctl, locks, release } = fakeLocks({ hold: true });
    const kv = memoryKV();
    const name = `test-${++dbSeq}`;
    const a = makeL(kv, name, locks, 30);
    await a.open();
    expect(await settles(a.acquireWriter())).toBe(true);
    expect(a.writer).toBe(true);
    // 遅れてロックが取れた → 持ち続けるので、別のタブが引き継ぐとこのタブは閲覧のみになる
    ctl.hold = false;
    release();
    await wait();
    const b = makeL(kv, name, locks);
    await b.open();
    await settles(b.takeOver());
    await wait();
    expect(b.writer).toBe(true);
    expect(a.writer).toBe(false);
    expect(a.status).toBe("readonly");
  });

  it("答えが遅れて、別のタブが持っていると分かったら閲覧のみに戻す", async () => {
    const { ctl, locks, release } = fakeLocks();
    const kv = memoryKV();
    const name = `test-${++dbSeq}`;
    const b = makeL(kv, name, locks);
    await b.open();
    expect(await b.acquireWriter()).toBe(true);
    ctl.hold = true;
    const a = makeL(kv, name, locks, 30);
    await a.open();
    expect(await settles(a.acquireWriter())).toBe(true);
    release();
    await wait();
    expect(a.writer).toBe(false);
    expect(a.status).toBe("readonly");
    expect(b.writer).toBe(true);
  });
});

describe("インポート", () => {
  it("書き出したものを確認画面用に読める", () => {
    const doc = buildDemoDoc();
    const pv = previewImport(serializeDoc(doc, "0.1.0"));
    expect(pv.counts.nodes).toBe(Object.keys(doc.nodes).length);
    expect(pv.report.warnings).toEqual([]);
  });

  it("追加: 数千件のプロジェクトでも、名前の照らし合わせで固まらない", () => {
    const base = createEmptyDoc("base");
    const incoming = createEmptyDoc("in");
    for (let i = 0; i < 3000; i++) {
      const a = makeProject({ name: `プロジェクト ${i}` });
      base.projects[a.id] = a;
      base.projectOrder.push(a.id);
      const b = makeProject({ name: `ﾌﾟﾛｼﾞｪｸﾄ ${i + 1500}` }); // 半角でも同じ名前ならまとめる
      incoming.projects[b.id] = b;
      incoming.projectOrder.push(b.id);
    }
    const t0 = performance.now();
    const res = mergeDocs(base, incoming);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(res.reusedProjects).toBe(1500);
    expect(res.doc.projectOrder).toHaveLength(4500);
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
