import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { buildDemoDoc } from "../../src/demo/demo";
import { buildStressDoc } from "../../src/demo/stress";
import { nextStamp } from "../../src/model/ids";
import { DocFormatError, NewerDocError, SCHEMA_VERSION, createEmptyDoc, makeNode, makeProject, serializeDoc } from "../../src/model/schema";
import { mergeDocs, previewImport } from "../../src/persist/io";
import { KEEP, Persistence, isNewerBackup, memoryKV, type SyncKV } from "../../src/persist/persistence";
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
    // 壊れた本体は、新しい版とは見なさない（今までどおりバックアップで始める）
    expect(loaded.blocked).toBe(false);
    expect(again.blocked).toBe(false);
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
        const mine = reject;
        holder = mine;
        // コールバックが返した約束が終わったら、ロックは空く（手放した）
        const free = () => {
          if (holder === mine) holder = null;
        };
        void Promise.resolve(cb({ name, mode: "exclusive" } as Lock)).then(
          (v) => (free(), resolve(v)),
          (e) => (free(), reject(e)),
        );
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

// ------------------------------------------------------------ このページより新しい版のデータ

/** 緊急コピーの包みの、次の版の形（このページの形は 1） */
const EMERGENCY_NEXT = 2;

/** 新しい版のページが保存した本体（版 2 の薄い形: ノードを持たず、変えた所だけ）。このページでは読めない */
function newerDoc(title = "新しい版で保存した内容", updatedAt = new Date(Date.now() + 60_000).toISOString()): Record<string, unknown> {
  return { schema: "4d-branch", version: SCHEMA_VERSION + 1, id: "d_newer", title, createdAt: updatedAt, updatedAt, meta: {}, thin: { v: 1, release: 7, patches: { k1: { title: "書き換えたカード" } } } };
}

/** 保存先をそのまま開く（Persistence が作った後に。版は今のまま） */
function rawOpen(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name);
    r.onerror = () => reject(r.error);
    r.onsuccess = () => resolve(r.result);
  });
}

type RawStore = "kv" | "backupMeta" | "backupData";

/** 新しい版のページが書いた物を、そのまま置く（key が無ければ keyPath の物） */
async function rawPut(name: string, store: RawStore, value: unknown, key?: string): Promise<void> {
  const db = await rawOpen(name);
  try {
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(store, "readwrite");
      if (key === undefined) t.objectStore(store).put(value);
      else t.objectStore(store).put(value, key);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

/** 保存先の中身をまるごと文字にする（何も書き換えていないことを、そのままの値で確かめる） */
async function rawDump(name: string, stores: RawStore[] = ["kv", "backupMeta", "backupData"]): Promise<string> {
  const db = await rawOpen(name);
  const out: Record<string, unknown> = {};
  try {
    for (const store of stores) {
      out[store] = await new Promise((resolve, reject) => {
        const t = db.transaction(store, "readonly");
        const keys = t.objectStore(store).getAllKeys();
        const vals = t.objectStore(store).getAll();
        t.oncomplete = () => resolve(keys.result.map((k, i) => [k, vals.result[i]]));
        t.onerror = () => reject(t.error);
      });
    }
  } finally {
    db.close();
  }
  return JSON.stringify(out);
}

const kvDump = (kv: ReturnType<typeof memoryKV>) => JSON.stringify([...kv.data].sort(([a], [b]) => a.localeCompare(b)));

/** 保存先の 1 つの値をそのまま読む */
async function rawGet(name: string, store: RawStore, key: string): Promise<unknown> {
  const db = await rawOpen(name);
  try {
    return await new Promise((resolve, reject) => {
      const r = db.transaction(store, "readonly").objectStore(store).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}

describe("このページより新しい版のデータ（壊れたデータと分け、読まずに止める）", () => {
  it("（再現）新しい版の本体を読めない古いページが、最初の保存で古いバックアップの内容を書き戻さない", async () => {
    // 前の版で確かめた手順のまま: 古い内容のバックアップがある → 新しい版のページが新しい版の本体を保存 → このページが開いて保存する
    const kv = memoryKV();
    const name = `test-${++dbSeq}`;
    const mk = () => new Persistence({ dbName: name, kv, locks: null, channel: false, debounceMs: 5, autoBackupMs: 0 });
    const p = mk();
    await p.open();
    await p.acquireWriter();
    await p.loadInitial();
    const old = createEmptyDoc("古い内容");
    old.nodes["n_old"] = makeNode({ id: "n_old", title: "古いバックアップのカード" });
    p.attach(() => old);
    await p.createBackup("auto", "", old);
    const newer = { ...createEmptyDoc("新しい版で保存した内容"), version: SCHEMA_VERSION + 1, thin: { v: 1 } } as unknown as DocData;
    p.markDirty();
    p.attach(() => newer);
    await p.flush();
    p.close();
    const q = mk();
    await q.open();
    await q.acquireWriter();
    const loaded = await q.loadInitial();
    q.attach(() => loaded.doc ?? old);
    q.markDirty();
    await q.flush();
    // 前は「読めなかったため、いちばん新しいバックアップから復元しました」で始め、ここで「古い内容」（版 1）を書いていた
    const stored = (await rawGet(name, "kv", "doc")) as { title: string; version: number };
    expect({ title: stored.title, version: stored.version }).toEqual({ title: "新しい版で保存した内容", version: SCHEMA_VERSION + 1 });
    expect(loaded.blocked).toBe(true);
    expect(loaded.notices).toEqual([]);
  });

  it("保存してある本体が新しい版なら、古いバックアップで始めず、本体・版の記録・緊急コピー・バックアップのどれにも書かない（前は最初の保存で上書きしていた）", async () => {
    const kv = memoryKV();
    const name = `test-${++dbSeq}`;
    // 前にこのページで使っていた: 本体と自動のバックアップ
    const p = makeP(kv, name);
    await p.open();
    await p.acquireWriter();
    await p.loadInitial();
    const old = edit(createEmptyDoc("古い内容"), "古いバックアップのカード");
    p.attach(() => old);
    p.markDirty();
    await p.flush();
    const auto = (await p.createBackup("auto", "", old))!;
    p.close();
    // 新しい版のページが、新しい版の形で本体を保存した（版の記録に docVersion が無くても、本体の版で分かる）。閉じる直前の写しも残した
    await rawPut(name, "kv", newerDoc(), "doc");
    await rawPut(name, "kv", { rev: 9, savedAt: new Date().toISOString(), writer: "t_newer" }, "meta");
    kv.set(`${name}:emergency:t_newer`, JSON.stringify({ v: 1, baseRev: 9, at: new Date().toISOString(), tabId: "t_newer", doc: newerDoc("閉じる直前") }));
    const before = await rawDump(name);
    const kvBefore = kvDump(kv);
    // このページ（古い版）が開く
    const q = makeP(kv, name);
    const blocked: number[] = [];
    q.on("blocked", () => blocked.push(1));
    await q.open();
    expect(await q.acquireWriter()).toBe(true);
    const loaded = await q.loadInitial();
    expect(loaded).toEqual({ doc: null, notices: [], recovered: false, blocked: true });
    expect(q.blocked).toBe(true);
    expect(q.writer).toBe(false);
    expect(blocked).toHaveLength(1);
    // 何を頼まれても書かない（保存・緊急コピー・バックアップ・日次・同期の基準・引き継ぎ・競合の解決）
    q.attach(() => old);
    q.markDirty();
    await q.flush();
    q.writeEmergency(true);
    expect(await q.createBackup("manual", "手動", old)).toBeNull();
    await q.ensureDailyBackup(old);
    await q.writeKv("cloud:owner", "u1");
    await q.deleteBackup(auto.id);
    expect(await q.takeOver()).toBeNull();
    expect(await q.resolveConflict("overwrite")).toBeNull();
    expect(await q.resolveConflict("reload")).toBeNull();
    await wait(30);
    expect(q.hasUnsaved).toBe(false);
    expect(await rawDump(name)).toBe(before);
    expect(kvDump(kv)).toBe(kvBefore);
    // 開き直しても同じ（何度開いても止まり、書かない）
    const r = makeP(kv, name);
    await r.open();
    await r.acquireWriter();
    expect((await r.loadInitial()).blocked).toBe(true);
    expect(await rawDump(name)).toBe(before);
    expect(kvDump(kv)).toBe(kvBefore);
  });

  it("版の記録の docVersion が新しい版を指していれば、本体の形を読めなくても・無くても止める", async () => {
    for (const body of [undefined, "読めない形", { schema: "4d-branch", version: SCHEMA_VERSION, nodes: {} }]) {
      const kv = memoryKV();
      const name = `test-${++dbSeq}`;
      const p = makeP(kv, name);
      await p.open();
      p.close();
      if (body !== undefined) await rawPut(name, "kv", body, "doc");
      await rawPut(name, "kv", { rev: 3, savedAt: new Date().toISOString(), writer: "t_newer", docVersion: SCHEMA_VERSION + 1 }, "meta");
      const before = await rawDump(name);
      const q = makeP(kv, name);
      await q.open();
      await q.acquireWriter();
      await expect(q.readStored()).rejects.toBeInstanceOf(NewerDocError);
      expect((await q.loadInitial()).blocked).toBe(true);
      q.attach(() => createEmptyDoc());
      q.markDirty();
      await q.flush();
      expect(await rawDump(name)).toBe(before);
      expect(kv.data.size).toBe(0);
    }
  });

  it("保存先がこのページより新しい版の形に作り直されていたら（開けない版）、小さな保存先に切り替えて始めずに止める", async () => {
    const kv = memoryKV();
    const name = `test-${++dbSeq}`;
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open(name, 2);
      r.onupgradeneeded = () => void r.result.createObjectStore("kv");
      r.onsuccess = () => (r.result.close(), resolve());
      r.onerror = () => reject(r.error);
    });
    const p = makeP(kv, name);
    await p.open();
    expect(p.blocked).toBe(true);
    expect(p.mode).toBe("idb");
    expect(await p.acquireWriter()).toBe(false);
    expect(await p.loadInitial()).toEqual({ doc: null, notices: [], recovered: false, blocked: true });
    p.attach(() => createEmptyDoc());
    p.markDirty();
    await p.flush();
    p.writeEmergency(true);
    await p.writeKv("x", 1);
    expect(kv.data.size).toBe(0);
  });

  it("localStorage に保存するブラウザでも、本体が新しい版なら止めて何も書かない", async () => {
    vi.stubGlobal("indexedDB", undefined);
    try {
      const kv = memoryKV();
      const name = `test-${++dbSeq}`;
      kv.set(`${name}:doc`, JSON.stringify(newerDoc()));
      kv.set(`${name}:meta`, JSON.stringify({ rev: 4, savedAt: new Date().toISOString(), writer: "t_newer" }));
      const before = kvDump(kv);
      const p = makeP(kv, name);
      await p.open();
      expect(p.mode).toBe("local");
      await p.acquireWriter();
      expect((await p.loadInitial()).blocked).toBe(true);
      p.attach(() => createEmptyDoc());
      p.markDirty();
      await p.flush();
      p.writeEmergency(true);
      await p.writeKv("cloud:owner", "u1");
      expect(kvDump(kv)).toBe(before);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("このページより新しい版の緊急コピー（本体より後の変更ではない物）は採らず、消さずに残して始める。壊れた写しは今までどおり消す", async () => {
    const kv = memoryKV();
    const name = `test-${++dbSeq}`;
    const p = makeP(kv, name);
    await p.open();
    await p.acquireWriter();
    await p.loadInitial();
    const doc = edit(createEmptyDoc("本体"), "この版で保存した内容");
    p.attach(() => doc);
    p.markDirty();
    await p.flush();
    p.close();
    // 新しい版のページのタブが残した写し（中身が新しい版・包みが新しい版）。どちらも本体より前の時刻で、本体の版からではない
    // （本体より後の変更なら止める。別のテスト）。壊れた写しも 2 つ
    const at = new Date(Date.now() - 60_000).toISOString();
    const newerCopy = JSON.stringify({ v: 1, baseRev: 0, at, tabId: "t_newer", doc: newerDoc("新しい版の未保存の変更", at) });
    const newerWrap = JSON.stringify({ v: EMERGENCY_NEXT, baseRev: 0, at, tabId: "t_newer2", doc: { updatedAt: at }, thin: { v: 1 } });
    kv.set(`${name}:emergency:t_newer`, newerCopy);
    kv.set(`${name}:emergency:t_newer2`, newerWrap);
    kv.set(`${name}:emergency:t_broken`, "{壊れた");
    kv.set(`${name}:emergency:t_notdoc`, JSON.stringify({ v: 1, baseRev: 1, at, tabId: "t_notdoc", doc: "ドキュメントではない" }));
    const next = makeP(kv, name);
    await next.open();
    await next.acquireWriter();
    const loaded = await next.loadInitial();
    expect(loaded.blocked).toBe(false);
    expect(loaded.recovered).toBe(false);
    expect(loaded.doc).toEqual(doc);
    expect(loaded.notices).toEqual([]);
    expect(kv.get(`${name}:emergency:t_newer`)).toBe(newerCopy);
    expect(kv.get(`${name}:emergency:t_newer2`)).toBe(newerWrap);
    expect(kv.get(`${name}:emergency:t_broken`)).toBeNull();
    expect(kv.get(`${name}:emergency:t_notdoc`)).toBeNull();
    // この版で続けて保存しても残る（自分の緊急コピーだけを消す）
    const cur = loaded.doc!;
    next.attach(() => cur);
    edit(cur, "続きの編集");
    next.markDirty();
    next.writeEmergency();
    await next.flush();
    expect(kv.get(`${name}:emergency:${next.tabId}`)).toBeNull();
    expect(kv.get(`${name}:emergency:t_newer`)).toBe(newerCopy);
    expect(kv.get(`${name}:emergency:t_newer2`)).toBe(newerWrap);
    next.close();
    // 閲覧のみのタブが引き継いでも、採らず消さない
    const reader = makeP(kv, name);
    await reader.open();
    await reader.loadInitial();
    const taken = await reader.takeOver();
    expect(Object.values(taken!.nodes).some((n) => n.title === "続きの編集")).toBe(true);
    expect(reader.blocked).toBe(false);
    expect(kv.get(`${name}:emergency:t_newer`)).toBe(newerCopy);
    expect(kv.get(`${name}:emergency:t_newer2`)).toBe(newerWrap);
  });

  it("このページより新しい版のバックアップは一覧に出して見分けられ、読まず・復元せず・起動の代わりにせず・間引きでも消さない", async () => {
    const kv = memoryKV();
    const name = `test-${++dbSeq}`;
    const p = makeP(kv, name);
    await p.open();
    await p.acquireWriter();
    await p.loadInitial();
    const doc = edit(createEmptyDoc("本体"), "この版のバックアップのカード");
    p.attach(() => doc);
    p.markDirty();
    await p.flush();
    const mine = (await p.createBackup("auto", "", doc))!;
    expect(mine.docVersion).toBe(SCHEMA_VERSION);
    expect(isNewerBackup(mine)).toBe(false);
    // 新しい版のページが作ったバックアップ: 見出しに版がある物と無い物（中身を読んで初めて分かる）。どちらもこの版の物より新しい
    const counts = { nodes: 0, edges: 0, projects: 0, scenarios: 0 };
    const marked = { id: "b_newer_marked", kind: "auto", label: "", createdAt: new Date(Date.now() + 60_000).toISOString(), docTitle: "新しい版", counts, docVersion: SCHEMA_VERSION + 1 };
    const unmarked = { id: "b_newer_unmarked", kind: "auto", label: "", createdAt: new Date(Date.now() + 120_000).toISOString(), docTitle: "新しい版", counts };
    for (const m of [marked, unmarked]) {
      await rawPut(name, "backupMeta", m);
      await rawPut(name, "backupData", { id: m.id, doc: newerDoc() });
    }
    const list = await p.listBackups();
    expect(list.map((b) => b.id)).toEqual(["b_newer_unmarked", "b_newer_marked", mine.id]);
    expect(list.map((b) => isNewerBackup(b))).toEqual([false, true, false]);
    expect(await p.readBackupChecked("b_newer_marked")).toEqual({ doc: null, newer: true });
    expect(await p.readBackupChecked("b_newer_unmarked")).toEqual({ doc: null, newer: true });
    expect(await p.readBackup("b_newer_unmarked")).toBeNull();
    expect(await p.readBackupChecked(mine.id)).toEqual({ doc, newer: false });
    expect(await p.readBackupChecked("b_none")).toEqual({ doc: null, newer: false });
    // 間引き: この版のバックアップが上限を超えても、見出しで新しい版と分かる物は数えず消さない
    // （見出しに版の無い物は数えに入る。ここではいちばん新しいので残る）
    for (let i = 0; i < KEEP.auto + 2; i++) await p.createBackup("auto", `#${i}`, doc);
    const after = await p.listBackups();
    expect(after.filter((b) => b.kind === "auto" && !isNewerBackup(b))).toHaveLength(KEEP.auto);
    expect(after.some((b) => b.id === "b_newer_marked")).toBe(true);
    expect(after.some((b) => b.id === "b_newer_unmarked")).toBe(true);
    expect(after.some((b) => b.id === mine.id)).toBe(false);
    p.close();
    // 本体が壊れた: 新しい版のバックアップ（いちばん新しい 2 つ）を飛ばし、この版のいちばん新しいバックアップから始める
    await rawPut(name, "kv", "壊れた内容", "doc");
    const again = makeP(kv, name);
    await again.open();
    await again.acquireWriter();
    const loaded = await again.loadInitial();
    expect(loaded.blocked).toBe(false);
    expect(loaded.recovered).toBe(true);
    expect(loaded.doc!.title).toBe("本体");
    expect(Object.values(loaded.doc!.nodes).map((n) => n.title)).toContain("この版のバックアップのカード");
  });

  it("閲覧のみのタブは、保存されているのが新しい版なら引き継がない（新しい版のタブのロックを奪わない・何も書かない）", async () => {
    const { locks } = fakeLocks();
    const kv = memoryKV();
    const name = `test-${++dbSeq}`;
    const mk = () => new Persistence({ dbName: name, kv, locks, channel: false, debounceMs: 1 });
    // 新しい版のページのタブ（ここでは書き手のロックを持つだけ）
    const newerTab = mk();
    await newerTab.open();
    expect(await newerTab.acquireWriter()).toBe(true);
    // このページのタブ: 閲覧のみで開いた後、新しい版のタブが保存した
    const old = mk();
    await old.open();
    expect(await old.acquireWriter()).toBe(false);
    await old.loadInitial();
    await rawPut(name, "kv", newerDoc(), "doc");
    await rawPut(name, "kv", { rev: 3, savedAt: new Date().toISOString(), writer: newerTab.tabId }, "meta");
    kv.set(`${name}:emergency:t_newer`, JSON.stringify({ v: 1, baseRev: 3, at: new Date().toISOString(), tabId: "t_newer", doc: newerDoc("閉じる直前") }));
    const before = await rawDump(name);
    const kvBefore = kvDump(kv);
    expect(await old.takeOver()).toBeNull();
    expect(old.blocked).toBe(true);
    expect(old.writer).toBe(false);
    await wait();
    expect(newerTab.writer).toBe(true);
    expect(await rawDump(name)).toBe(before);
    expect(kvDump(kv)).toBe(kvBefore);
  });

  it("起動で止めたタブは書き手のロックを手放す（新しい版のページのタブが、引き継がずに編集を始められる）", async () => {
    const { locks } = fakeLocks();
    const kv = memoryKV();
    const name = `test-${++dbSeq}`;
    const mk = () => new Persistence({ dbName: name, kv, locks, channel: false, debounceMs: 1 });
    const seed = makeP(kv, name);
    await seed.open();
    seed.close();
    await rawPut(name, "kv", newerDoc(), "doc");
    const old = mk();
    await old.open();
    expect(await old.acquireWriter()).toBe(true);
    expect((await old.loadInitial()).blocked).toBe(true);
    await wait();
    const newerTab = mk();
    await newerTab.open();
    expect(await newerTab.acquireWriter()).toBe(true);
    expect(old.writer).toBe(false);
  });

  it("開いている間に別のタブの新しい版のページが保存したら、保存の競合で気づいて止める（手元は退避・新しい版は上書きしない・上書きも選ばせない）", async () => {
    const kv = memoryKV();
    const name = `test-${++dbSeq}`;
    const p = makeP(kv, name);
    await p.open();
    await p.acquireWriter();
    await p.loadInitial();
    const doc = edit(createEmptyDoc("この版の内容"), "保存できた変更");
    p.attach(() => doc);
    p.markDirty();
    await p.flush();
    const events: unknown[] = [];
    p.on("blocked", (e) => events.push(e));
    // ロックの効かない環境の別のタブで、新しい版のページが保存した（版番号が進む）
    await rawPut(name, "kv", newerDoc(), "doc");
    await rawPut(name, "kv", { rev: 2, savedAt: new Date().toISOString(), writer: "t_newer" }, "meta");
    const before = await rawDump(name, ["kv"]);
    edit(doc, "気づく前の変更");
    p.markDirty();
    await p.flush();
    expect(p.blocked).toBe(true);
    // 退避に今の内容がそのまま入っているので、緊急コピーには書かない（画面で「退避」に残したと伝える）
    expect(events).toEqual([{ kept: "backup" }]);
    expect(p.status).toBe("readonly");
    expect(p.hasUnsaved).toBe(false);
    expect(await rawDump(name, ["kv"])).toBe(before);
    // 手元の変更は「退避」に残した
    const look = makeP(kv, name);
    await look.open();
    const conflict = (await look.listBackups()).find((b) => b.kind === "conflict");
    expect(conflict?.docTitle).toBe("この版の内容");
    expect(Object.values((await look.readBackup(conflict!.id))!.nodes).some((n) => n.title === "気づく前の変更")).toBe(true);
    // 止めた後は、上書きを選んでも・閉じるときも書かない
    expect(await p.resolveConflict("overwrite")).toBeNull();
    edit(doc, "止めた後の変更");
    p.markDirty();
    p.writeEmergency(true);
    await p.flush();
    expect(await rawDump(name, ["kv"])).toBe(before);
    expect([...kv.data.keys()].some((k) => k.includes(":emergency:"))).toBe(false);
  });

  it("競合で止めた後に新しい版のページが保存したら、「上書き」でも「最新を開く」でも上書き・読み込みせずに止める（このタブの内容は退避）", async () => {
    const kv = memoryKV();
    const name = `test-${++dbSeq}`;
    const tabs = [makeP(kv, name), makeP(kv, name), makeP(kv, name)];
    for (const t of tabs) {
      await t.open();
      await t.acquireWriter();
      await t.loadInitial();
    }
    const [a, b, c] = tabs as [Persistence, Persistence, Persistence];
    const docs = ["A", "B", "C"].map((t) => edit(createEmptyDoc(t), `${t} の変更`));
    tabs.forEach((t, i) => t.attach(() => docs[i]!));
    for (const t of tabs) {
      t.markDirty();
      await t.flush();
    }
    expect([a.status, b.status, c.status]).toEqual(["saved", "conflict", "conflict"]);
    expect(b.blocked || c.blocked).toBe(false);
    // その後、新しい版のページが保存した
    await rawPut(name, "kv", newerDoc(), "doc");
    await rawPut(name, "kv", { rev: 2, savedAt: new Date().toISOString(), writer: "t_newer" }, "meta");
    const before = await rawDump(name, ["kv"]);
    edit(docs[1]!, "競合の後の B の変更");
    b.markDirty();
    expect(await b.resolveConflict("overwrite")).toBeNull();
    expect(b.blocked).toBe(true);
    expect(await c.resolveConflict("reload")).toBeNull();
    expect(c.blocked).toBe(true);
    await wait(20);
    expect(await rawDump(name, ["kv"])).toBe(before);
    const kept = (await a.listBackups()).find((x) => x.label === "新しい版で保存された内容に気づいたときのこのタブの内容");
    expect(Object.values((await a.readBackup(kept!.id))!.nodes).some((n) => n.title === "競合の後の B の変更")).toBe(true);
  });

  it("版の記録が新しい版を指していれば、版番号が合っていても上書きしない（最後の守り）", async () => {
    const kv = memoryKV();
    const name = `test-${++dbSeq}`;
    const p = makeP(kv, name);
    await p.open();
    await p.acquireWriter();
    await p.loadInitial();
    const doc = edit(createEmptyDoc("この版の内容"), "保存できた変更");
    p.attach(() => doc);
    p.markDirty();
    await p.flush();
    expect(p.rev).toBe(1);
    // 版番号はそのまま、版の記録だけ新しい版を指す（このページが読んだ版番号のまま、新しい版の印が付いた）
    await rawPut(name, "kv", { rev: 1, savedAt: new Date().toISOString(), writer: "t_newer", docVersion: SCHEMA_VERSION + 1 }, "meta");
    const before = await rawDump(name, ["kv"]);
    edit(doc, "書いてはいけない変更");
    p.markDirty();
    await p.flush();
    expect(p.blocked).toBe(true);
    expect(await rawDump(name, ["kv"])).toBe(before);
  });

  it("この版が書く版の記録・バックアップの見出しには、本体の版（docVersion）を書く（次の版がこのページを見分けられる）", async () => {
    const kv = memoryKV();
    const name = `test-${++dbSeq}`;
    const p = makeP(kv, name);
    await p.open();
    await p.acquireWriter();
    await p.loadInitial();
    const doc = createEmptyDoc("版の記録");
    p.attach(() => doc);
    p.markDirty();
    await p.flush();
    const dump = JSON.parse(await rawDump(name, ["kv"])) as { kv: Array<[string, { docVersion?: number }]> };
    expect(dump.kv.find(([k]) => k === "meta")?.[1].docVersion).toBe(SCHEMA_VERSION);
    expect((await p.createBackup("manual", "", doc))!.docVersion).toBe(SCHEMA_VERSION);
  });
});

// ------------------------------------------------------------ 見直しで見つかった穴（このページより新しい版のデータ）

/** 緊急コピーの中身の題名（このタブの緊急コピーに残した物を確かめる） */
function emergencyTitles(kv: SyncKV, key: string): string[] {
  const text = kv.get(key);
  if (!text) return [];
  const copy = JSON.parse(text) as { v: number; doc: DocData };
  expect(copy.v).toBe(1);
  return Object.values(copy.doc.nodes).map((n) => n.title);
}

/** 保存先の版を上げる（新しい版のページが開いた。開いている古い版のタブには versionchange が届く）。upgrade で新しい版の本体を書く */
async function upgradeDb(name: string): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(name, 2);
    r.onupgradeneeded = () => {
      const s = r.transaction!.objectStore("kv");
      s.put(newerDoc(), "doc");
      s.put({ rev: 9, savedAt: new Date().toISOString(), writer: "t_newer", docVersion: SCHEMA_VERSION + 1 }, "meta");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  db.close();
}

describe("このページより新しい版のデータ（見直しで見つかった穴）", () => {
  it("開いている間に新しい版のページが保存先の版を上げたら（versionchange）、止めて書き手のロックを手放す。まだ保存していない変更はこのタブの緊急コピーに残し、以後は何も書かない", async () => {
    const { locks } = fakeLocks();
    const kv = memoryKV();
    const name = `test-${++dbSeq}`;
    // 保存の待ちを長くして、まだ保存していない変更を持ったまま気づく
    const p = new Persistence({ dbName: name, kv, locks, channel: false, debounceMs: 60_000 });
    await p.open();
    expect(await p.acquireWriter()).toBe(true);
    await p.loadInitial();
    const doc = edit(createEmptyDoc("この版の内容"), "保存できた変更");
    p.attach(() => doc);
    p.markDirty();
    await p.flush();
    expect(p.status).toBe("saved");
    edit(doc, "まだ保存していない変更");
    p.markDirty();
    const events: unknown[] = [];
    p.on("blocked", (e) => events.push(e));
    await upgradeDb(name);
    expect(p.blocked).toBe(true);
    expect(p.writer).toBe(false);
    expect(events).toEqual([{ kept: "copy" }]);
    expect(emergencyTitles(kv, `${name}:emergency:${p.tabId}`)).toContain("まだ保存していない変更");
    // 新しい版のページのタブが、引き継がずに書き手のロックを取れる
    await wait();
    const got = await new Promise<boolean>((resolve) => void locks.request(`${name}:writer`, { ifAvailable: true }, (lock) => void resolve(!!lock)));
    expect(got).toBe(true);
    // 以後は何も書かない（引き継ぎ・保存・閉じるときの緊急コピー）
    const kvBefore = kvDump(kv);
    expect(await p.takeOver()).toBeNull();
    edit(doc, "止めた後の変更");
    p.markDirty();
    await p.flush();
    p.writeEmergency(true);
    expect(kvDump(kv)).toBe(kvBefore);
  });

  it("保存先が消されたとき（版を上げたのではない）は今までどおり: 止めずに知らせだけ出す（このタブの内容は緊急コピーで守れる）", async () => {
    const kv = memoryKV();
    const name = `test-${++dbSeq}`;
    const p = makeP(kv, name);
    await p.open();
    await p.acquireWriter();
    await p.loadInitial();
    const notices: string[] = [];
    p.on("notice", (n) => notices.push(n.text));
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.deleteDatabase(name);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
    expect(p.blocked).toBe(false);
    expect(notices.join()).toContain("このタブを再読み込みしてください");
  });

  it("新しい版のページの緊急コピーが本体より後の変更なら（本体が無いときも）、古い本体やデモで始めずに止める（その上に保存して追い越さない）。何も書かず、壊れた写しも消さない", async () => {
    for (const stored of [true, false]) {
      const kv = memoryKV();
      const name = `test-${++dbSeq}`;
      const p = makeP(kv, name);
      await p.open();
      await p.acquireWriter();
      await p.loadInitial();
      if (stored) {
        const doc = edit(createEmptyDoc("この版で保存した本体"), "この版で保存した内容");
        p.attach(() => doc);
        p.markDirty();
        await p.flush();
      }
      p.close();
      // 新しい版のページがその本体を開いて編集し、保存しきれずに閉じた（本体より後の時刻）
      const at = new Date(Date.now() + 5_000).toISOString();
      kv.set(`${name}:emergency:t_newer`, JSON.stringify({ v: 1, baseRev: stored ? 1 : 0, at, tabId: "t_newer", doc: newerDoc("新しい版の未保存の変更", at) }));
      kv.set(`${name}:emergency:t_broken`, "{壊れた");
      const before = await rawDump(name);
      const kvBefore = kvDump(kv);
      const q = makeP(kv, name);
      await q.open();
      await q.acquireWriter();
      expect(await q.loadInitial()).toEqual({ doc: null, notices: [], recovered: false, blocked: true });
      expect(q.blocked).toBe(true);
      // 起動の続き（デモで始めたときの保存・日次バックアップ）を頼まれても書かない
      q.attach(() => createEmptyDoc());
      q.markDirty();
      await q.flush();
      await q.ensureDailyBackup(createEmptyDoc());
      expect(await rawDump(name)).toBe(before);
      expect(kvDump(kv)).toBe(kvBefore);
    }
  });

  it("閲覧のみのタブは、新しい版のページの緊急コピーが本体より後の変更なら引き継がない（ロックを奪わず・何も書かない）", async () => {
    const { locks } = fakeLocks();
    const kv = memoryKV();
    const name = `test-${++dbSeq}`;
    const mk = () => new Persistence({ dbName: name, kv, locks, channel: false, debounceMs: 1 });
    // 書き手のロックを持つタブ（新しい版のページのタブの代わり）がこの版の本体を保存した
    const holder = mk();
    await holder.open();
    expect(await holder.acquireWriter()).toBe(true);
    await holder.loadInitial();
    const doc = edit(createEmptyDoc("この版で保存した本体"), "x");
    holder.attach(() => doc);
    holder.markDirty();
    await holder.flush();
    const old = mk();
    await old.open();
    expect(await old.acquireWriter()).toBe(false);
    await old.loadInitial();
    const at = new Date(Date.now() + 5_000).toISOString();
    kv.set(`${name}:emergency:t_newer`, JSON.stringify({ v: EMERGENCY_NEXT, baseRev: 1, at, tabId: "t_newer", thin: { v: 1 } }));
    const before = await rawDump(name);
    const kvBefore = kvDump(kv);
    expect(await old.takeOver()).toBeNull();
    expect(old.blocked).toBe(true);
    expect(old.writer).toBe(false);
    await wait();
    expect(holder.writer).toBe(true);
    expect(await rawDump(name)).toBe(before);
    expect(kvDump(kv)).toBe(kvBefore);
  });

  it("開いている間に気づいて止めるとき、「退避」に残せない変更（localStorage の保存先）は、このタブの緊急コピーに残す（新しい版の本体・版の記録には触れない）", async () => {
    vi.stubGlobal("indexedDB", undefined);
    try {
      const kv = memoryKV();
      const name = `test-${++dbSeq}`;
      const p = makeP(kv, name);
      await p.open();
      expect(p.mode).toBe("local");
      await p.acquireWriter();
      await p.loadInitial();
      const doc = edit(createEmptyDoc("この版の内容"), "保存できた変更");
      p.attach(() => doc);
      p.markDirty();
      await p.flush();
      const events: unknown[] = [];
      p.on("blocked", (e) => events.push(e));
      // ロックの効かない別のタブで、新しい版のページが保存した
      const docText = JSON.stringify(newerDoc());
      const metaText = JSON.stringify({ rev: 2, savedAt: new Date().toISOString(), writer: "t_newer", docVersion: SCHEMA_VERSION + 1 });
      kv.set(`${name}:doc`, docText);
      kv.set(`${name}:meta`, metaText);
      edit(doc, "まだどこにも無い変更");
      p.markDirty();
      await p.flush();
      expect(p.blocked).toBe(true);
      expect(events).toEqual([{ kept: "copy" }]);
      expect(kv.get(`${name}:doc`)).toBe(docText);
      expect(kv.get(`${name}:meta`)).toBe(metaText);
      expect(emergencyTitles(kv, `${name}:emergency:${p.tabId}`)).toContain("まだどこにも無い変更");
      // 残した後は何も書かない
      const after = kvDump(kv);
      p.writeEmergency(true);
      edit(doc, "止めた後の変更");
      p.markDirty();
      await p.flush();
      expect(kvDump(kv)).toBe(after);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("開いている間に気づいて止めるとき、「退避」を作れなかった（容量不足など）・退避した後に入力があったなら、今の内容をこのタブの緊急コピーに残す", async () => {
    for (const how of ["failed", "typed"] as const) {
      const kv = memoryKV();
      const name = `test-${++dbSeq}`;
      const p = makeP(kv, name);
      await p.open();
      await p.acquireWriter();
      await p.loadInitial();
      const doc = edit(createEmptyDoc("この版の内容"), "保存できた変更");
      p.attach(() => doc);
      p.markDirty();
      await p.flush();
      const events: unknown[] = [];
      p.on("blocked", (e) => events.push(e));
      await rawPut(name, "kv", newerDoc(), "doc");
      await rawPut(name, "kv", { rev: 2, savedAt: new Date().toISOString(), writer: "t_newer" }, "meta");
      const before = await rawDump(name, ["kv"]);
      const createBackup = p.createBackup.bind(p);
      (p as unknown as { createBackup: Persistence["createBackup"] }).createBackup = async (kind, label, d) => {
        if (how === "failed") throw new DOMException("quota", "QuotaExceededError");
        const made = await createBackup(kind, label, d);
        // 退避を書く間に打った（止めるまでの間の入力）
        edit(doc, "退避した後の入力");
        return made;
      };
      edit(doc, "気づく前の変更");
      p.markDirty();
      await p.flush();
      expect(p.blocked).toBe(true);
      expect(events).toEqual([{ kept: "copy" }]);
      const titles = emergencyTitles(kv, `${name}:emergency:${p.tabId}`);
      expect(titles).toContain("気づく前の変更");
      if (how === "typed") expect(titles).toContain("退避した後の入力");
      expect(await rawDump(name, ["kv"])).toBe(before);
    }
  });

  it("localStorage の保存先でも、版の記録が新しい版を指していれば、本体を JSON として読めなくても止める（壊れた本体と取り違えない・緊急コピーにも小さな鍵と値にも触れない）", async () => {
    vi.stubGlobal("indexedDB", undefined);
    try {
      const kv = memoryKV();
      const name = `test-${++dbSeq}`;
      kv.set(`${name}:doc`, "\u001f\u008b 新しい版の縮めた本体");
      kv.set(`${name}:meta`, JSON.stringify({ rev: 4, savedAt: new Date().toISOString(), writer: "t_newer", docVersion: SCHEMA_VERSION + 1 }));
      kv.set(`${name}:emergency:t_old`, JSON.stringify({ v: 1, baseRev: 3, at: new Date().toISOString(), tabId: "t_old", doc: edit(createEmptyDoc("前の版の緊急コピー"), "x") }));
      const before = kvDump(kv);
      const p = makeP(kv, name);
      await p.open();
      expect(p.mode).toBe("local");
      await p.acquireWriter();
      await expect(p.readStored()).rejects.toBeInstanceOf(NewerDocError);
      expect(await p.loadInitial()).toEqual({ doc: null, notices: [], recovered: false, blocked: true });
      await p.writeKv("cloud:bootDoc", { id: "x" });
      p.attach(() => createEmptyDoc());
      p.markDirty();
      await p.flush();
      p.writeEmergency(true);
      expect(kvDump(kv)).toBe(before);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("localStorage の保存先でも、版の記録が新しい版を指していれば、版番号が合っていても上書きしない（最後の守り）", async () => {
    vi.stubGlobal("indexedDB", undefined);
    try {
      const kv = memoryKV();
      const name = `test-${++dbSeq}`;
      const p = makeP(kv, name);
      await p.open();
      expect(p.mode).toBe("local");
      await p.acquireWriter();
      await p.loadInitial();
      const doc = edit(createEmptyDoc("この版の内容"), "保存できた変更");
      p.attach(() => doc);
      p.markDirty();
      await p.flush();
      expect(p.rev).toBe(1);
      // 版番号はそのまま、版の記録だけ新しい版を指す
      const docText = kv.get(`${name}:doc`);
      const metaText = JSON.stringify({ rev: 1, savedAt: new Date().toISOString(), writer: "t_newer", docVersion: SCHEMA_VERSION + 1 });
      kv.set(`${name}:meta`, metaText);
      edit(doc, "書いてはいけない変更");
      p.markDirty();
      await p.flush();
      expect(p.blocked).toBe(true);
      expect(kv.get(`${name}:doc`)).toBe(docText);
      expect(kv.get(`${name}:meta`)).toBe(metaText);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("引き継ぎで保存してある本体を読んで整えるのは 1 回だけ。保存の競合で新しい版かを見るときは整えない（大きな地図で待たせない）", async () => {
    const { locks } = fakeLocks();
    const kv = memoryKV();
    const name = `test-${++dbSeq}`;
    const mk = () => new Persistence({ dbName: name, kv, locks, channel: false, debounceMs: 1 });
    const a = mk();
    await a.open();
    expect(await a.acquireWriter()).toBe(true);
    await a.loadInitial();
    const doc = edit(createEmptyDoc("この版の内容"), "保存できた変更");
    a.attach(() => doc);
    a.markDirty();
    await a.flush();
    const b = mk();
    await b.open();
    expect(await b.acquireWriter()).toBe(false);
    await b.loadInitial();
    const reads = vi.spyOn(b, "readStored");
    const taken = await b.takeOver();
    expect(taken!.title).toBe("この版の内容");
    expect(b.writer).toBe(true);
    expect(reads).toHaveBeenCalledTimes(1);
    // ロックの効かない別のタブがこの版で保存した（ふつうの競合）: 新しい版かは整えずに見る
    await rawPut(name, "kv", { ...doc, title: "別のタブ" }, "doc");
    await rawPut(name, "kv", { rev: 9, savedAt: new Date().toISOString(), writer: "t_other", docVersion: SCHEMA_VERSION }, "meta");
    reads.mockClear();
    const mine = createEmptyDoc("このタブ");
    b.attach(() => mine);
    b.markDirty();
    await b.flush();
    expect(b.status).toBe("conflict");
    expect(b.blocked).toBe(false);
    expect(reads).not.toHaveBeenCalled();
  });

  it("引き継ぐ間に前のタブが保存していたら、引き継いだ後に読み直す（ロックを取る前に読んだ内容で始めない）", async () => {
    const { locks } = fakeLocks();
    const kv = memoryKV();
    const name = `test-${++dbSeq}`;
    const mk = () => new Persistence({ dbName: name, kv, locks, channel: false, debounceMs: 1 });
    const a = mk();
    await a.open();
    expect(await a.acquireWriter()).toBe(true);
    await a.loadInitial();
    const doc = edit(createEmptyDoc("前の内容"), "前の変更");
    a.attach(() => doc);
    a.markDirty();
    await a.flush();
    const b = mk();
    await b.open();
    expect(await b.acquireWriter()).toBe(false);
    await b.loadInitial();
    // ロックを取る直前に、前のタブが保存した
    const readStored = b.readStored.bind(b);
    let first = true;
    (b as unknown as { readStored: Persistence["readStored"] }).readStored = async () => {
      const s = await readStored();
      if (first) {
        first = false;
        doc.title = "引き継ぐ間に保存した内容";
        edit(doc, "引き継ぐ間の変更");
        a.markDirty();
        await a.flush();
      }
      return s;
    };
    const taken = await b.takeOver();
    expect(taken!.title).toBe("引き継ぐ間に保存した内容");
    expect(b.rev).toBe(2);
  });
});

describe("インポート", () => {
  it("このページより新しい版のファイルは、今までと同じ文で読み込まない（NewerDocError は DocFormatError の一種）", () => {
    const msg = `このファイルは新しい版（スキーマ ${SCHEMA_VERSION + 1}）の 4D Branch で作られています。アプリを新しくしてから読み込んでください。`;
    const files = [
      // 薄い形（ノードを持たない）
      JSON.stringify({ ...newerDoc(), exportedAt: new Date().toISOString(), app: { name: "4D Branch", version: "9.9.9" } }, null, 2),
      // 今の形のままでも、版が新しければ同じ
      serializeDoc({ ...buildDemoDoc(), version: SCHEMA_VERSION + 1 }, "9.9.9"),
    ];
    for (const text of files) {
      let err: unknown = null;
      try {
        previewImport(text);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(NewerDocError);
      expect(err).toBeInstanceOf(DocFormatError);
      expect((err as Error).message).toBe(msg);
    }
  });

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
