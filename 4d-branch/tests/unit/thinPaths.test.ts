// 薄い形の保存の道（作業メモ SPEC v1 §6・D7・D9〜D11、見直し safety-2・3・5・9・13・15、gaps-1・6・9・17、perf-6）。
// ページの地図には小さい木（tests/fixtures/q-small。4,333 枚）か、その手にやることを足した木を入れる（既定のテストでも、版 7 の候補を入れたテストでも同じ）。
//   保存: 本体・版の記録・緊急コピー・バックアップは薄い形（版 2）。見出しに docVersion 2 と地図の版の順番・指紋。localStorage は 400 万文字まで
//   止める側（safety-3）: 版 2 以上か地図の変更がある記録は、どの訳で読めなくても止める（消さない・代わりで始めない・上書きしない・書かない）。
//     版 1 の壊れた本体だけが今までどおり。前の形・前の版のバックアップは自分では戻さない。止めていても、そのまま書き出せる
//   緊急コピー: 薄い形の写しを採る・開けない写しは残す（本体より後なら止める）・版の違う写しは黙って消さない（退避）
//   競合・引き継ぎ: 開けない本体の上には書かない・ロックを奪わない
//   「この版で開き直す」（safety-5）: 記録をそのまま安全用バックアップに残してから、鍵で当て直して開く
//   前の版の地図: 起動で当て直して開く（記録はバックアップに。id と更新時刻は変えない）
//   地図は要るときだけ読む（gaps-17）
//   版をまたいで読む: 残った鍵のカードに選んだ手・チェック・書き換え・見込み、無くなったカードは「前の版で決めたこと」、消したカードは戻る、いつも同じ結果
//   アカウント: 同じ入れ物（形 1・分割・ハッシュ）で docVersion 2。前の版のページは新しい版と見分けて止まる。開けない写しは書き直さない。
//     前の版のページで止める前の編集（2 つの端末で確かめる）は、黙って手元で上書きしない（safety-2）
//   書き出し・取り込み: 薄い形で書き出し、同じ版・前の版は読める（前の版は当て直す）・新しい版は断る。同じ地図は足さない（safety-9）
//   ID をそのまま足す（gaps-1）・引数に広げない（gaps-9）・履歴の大きな入れ替えは 2 件まで（perf-6）
import "fake-indexeddb/auto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";
import type { DevTreeNode, MapData } from "../../src/deepmap/mapData";
import { isDisposableDoc } from "../../src/demo/demo";
import { swapFutureDoc } from "../../src/demo/futureSwap";
import { primaryImpactRoot } from "../../src/model/forks";
import { nextStamp } from "../../src/model/ids";
import { createEmptyDoc, docCounts, DocFormatError, makeCondition, makeEdge, makeNode, NewerDocError, normalizeDoc, readableVersion, SCHEMA_VERSION, THIN_VERSION } from "../../src/model/schema";
import type { DocData, GEdge, GNode } from "../../src/model/types";
import {
  classifyReadFailure,
  decodeStored,
  enableThinPage,
  encodeStored,
  fromStored,
  headerBlock,
  holdsPageMap,
  isNewerRecord,
  needsPageMap,
  recordInfo,
  setCodecWarn,
  setThinBaseline,
  thinBaselineDoc,
  thinReadable,
  ThinMapError,
  toStored,
  type StoredDoc,
  type ThinSection,
  THIN_BASELINE_VERSION,
} from "../../src/persist/codec";
import { CloudError, CloudNewerError, CloudRepo, CloudSync, decodeDoc, encodeDoc, mapReleaseOf, sha256Hex, type CloudBackend, type CloudCodec, type CloudDoc, type SyncBase } from "../../src/persist/cloud";
import ioSrc from "../../src/persist/io.ts?raw";
import { exportText, mergeDocs, previewImport, previewImportAsync } from "../../src/persist/io";
import { memoryKV, Persistence, type SyncKV } from "../../src/persist/persistence";
import { HEAVY_REPLACE_KEEP, HEAVY_REPLACE_NODES } from "../../src/store/history";
import { Store } from "../../src/store/store";
import { fakeLocks, kvDump, rawAll, rawDump, rawGet, rawPut } from "./helpers/idbRaw";
import { loadQSmall, loadQSmallDevTree } from "./helpers/qSmall";
import { buildR6Future } from "./helpers/r6";
import { expectDecoded } from "./helpers/thinCheck";
import { accountShape, EDIT_KINDS, randomEdits, seeded } from "./helpers/thinEdits";

let qMap: MapData;
let todoMap: MapData;

/** 小さい木の手にやることを足した木（元の番号つき。版をまたいだチェックの引き継ぎを確かめる） */
function addTodo(tree: { root: DevTreeNode }): void {
  let k = 0;
  const walk = (n: DevTreeNode): void => {
    if (n.r === "a") {
      n.todo = [
        { text: `届け出の紙を出す ${k % 17}`, cite: `ind-side-d${String(k % 40).padStart(2, "0")}` },
        { text: `総務に聞く ${k % 7}`, cite: `sd-${k % 11}` },
      ];
      k++;
    }
    for (const c of n.kids ?? []) walk(c);
  };
  walk(tree.root);
}

beforeAll(async () => {
  qMap = await loadQSmall();
  const tree = await loadQSmallDevTree();
  addTodo(tree);
  todoMap = fromDevTree(tree);
});

afterEach(() => {
  enableThinPage(null);
  setThinBaseline(null);
  setCodecWarn(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const AT = "2026-11-19T03:04:05.006Z";
let dbSeq = 0;
const keyOf = (n: GNode | undefined): string | null => (typeof n?.meta?.key === "string" ? n.meta.key : null);

/** 地図の版の順番・中身の指紋だけを変えた地図（同じカード。版の順番の違う地図・同じ版で合わない地図） */
function withHeader(map: MapData, h: { release?: number; hash?: string }): MapData {
  return { ...map, header: { ...map.header, ...h } } as MapData;
}

/** 地図の手を 1 つ外した木（その手の下の鍵は無くなる）。版の順番と中身の指紋も変える */
async function withoutMove(move: string, release: number): Promise<{ map: MapData; gone: string }> {
  const tree = await loadQSmallDevTree();
  addTodo(tree);
  const kids = tree.root.kids!;
  const i = kids.findIndex((k) => k.k === `r.${move}`);
  if (i < 0) throw new Error(`手 ${move} が小さい木にありません`);
  kids.splice(i, 1);
  tree.header = { ...tree.header, release, hash: `${tree.header.hash.slice(0, 12)}zz` };
  return { map: fromDevTree(tree), gone: `r.${move}` };
}

/** ページの地図の新しい文書（基準の写しのまま） */
function freshDoc(map: MapData): DocData {
  setThinBaseline(map);
  return thinBaselineDoc({ at: AT });
}

/** 編集した文書（アカウントの形・やること・利用者の物・消したカード・書き換え） */
function editedDoc(map: MapData, seed = 7, count = 60): DocData {
  const R = seeded(seed);
  const acct = accountShape(freshDoc(map), R, { rate: 0.08, rootReId: true, project: "p_independence", scenario: "s_early", dx: 872, dy: -420, at: "2026-11-12T09:30:00.000Z" });
  const store = new Store(acct);
  randomEdits(store, R, count, EDIT_KINDS.filter((k) => k !== "undo" && k !== "redo"));
  return store.doc;
}

function makeP(kv: SyncKV, name = `thin-${++dbSeq}`, extra: Partial<ConstructorParameters<typeof Persistence>[0]> = {}): Persistence {
  return new Persistence({ dbName: name, kv, locks: null, channel: false, debounceMs: 1, ...extra });
}

const nameOf = (p: Persistence): string => (p as unknown as { dbName: string }).dbName;

/** 保存できるところまで開く（起動と同じ順） */
async function opened(kv: SyncKV, name?: string, extra: Partial<ConstructorParameters<typeof Persistence>[0]> = {}): Promise<Persistence> {
  const p = makeP(kv, name, extra);
  await p.open();
  await p.acquireWriter();
  return p;
}

/** 文書を保存する（新しい保存先に。保存先の名前を返す） */
async function saved(kv: SyncKV, doc: DocData, name?: string): Promise<{ p: Persistence; name: string }> {
  const p = await opened(kv, name);
  await p.loadInitial();
  p.attach(() => doc);
  p.markDirty();
  await p.flush();
  expect(p.status).toBe("saved");
  return { p, name: nameOf(p) };
}

/** ストアと同じく、更新時刻は必ず進める */
function touch(doc: DocData, title: string): DocData {
  const n = makeNode({ title });
  doc.nodes[n.id] = n;
  doc.updatedAt = nextStamp(new Date(Math.max(Date.parse(doc.updatedAt), Date.now() + 1000)).toISOString());
  return doc;
}

const emergencyKeys = (kv: ReturnType<typeof memoryKV>): string[] => [...kv.data.keys()].filter((k) => k.includes(":emergency:"));

// ------------------------------------------------------------ 保存先

describe("保存先（IndexedDB・localStorage・緊急コピー・バックアップ）は薄い形", () => {
  it("ページの地図を持つ文書は、本体・緊急コピー・バックアップに薄い形で書き、読み直すと同じ。版の記録とバックアップの見出しに docVersion 2・地図の版の順番と指紋", async () => {
    const doc = editedDoc(todoMap, 11);
    const kv = memoryKV();
    const { p, name } = await saved(kv, doc);
    const rec = (await rawGet(name, "kv", "doc")) as StoredDoc;
    const meta = (await rawGet(name, "kv", "meta")) as Record<string, unknown>;
    expect(rec.version).toBe(THIN_VERSION);
    expect(rec.maps).toHaveLength(1);
    expect(Object.keys(rec.nodes).length).toBeLessThan(Object.keys(doc.nodes).length / 10);
    // アカウントの形（カードの 8% の ID を振り直した物）でも、地図ごとの形の 1 割に収まる
    expect(JSON.stringify(rec).length).toBeLessThan(JSON.stringify(doc).length / 10);
    expect(meta).toMatchObject({ rev: 1, docVersion: THIN_VERSION, mapRelease: todoMap.header.release, mapHash: todoMap.header.hash });
    const sec = rec.maps![0]!;
    // 開き直すと同じ文書
    const q = await opened(kv, name);
    const loaded = await q.loadInitial();
    expect(loaded.blocked).toBe(false);
    expectDecoded(loaded.doc!, doc, sec);
    // 緊急コピー（包みは今までの形 v1、中身は薄い形）
    p.writeEmergency(true);
    const em = JSON.parse(kv.get(emergencyKeys(kv)[0]!)!) as { v: number; doc: StoredDoc };
    expect(em.v).toBe(1);
    expect(em.doc.version).toBe(THIN_VERSION);
    expect(JSON.stringify(em).length).toBeLessThan(JSON.stringify(doc).length / 10);
    // バックアップ（件数は手元の文書で数える）
    const b = (await p.createBackup("manual", "手動のバックアップ"))!;
    expect(b).toMatchObject({ docVersion: THIN_VERSION, mapRelease: todoMap.header.release, mapHash: todoMap.header.hash, counts: docCounts(doc) });
    const data = (await rawGet(name, "backupData", b.id)) as { doc: StoredDoc };
    expect(data.doc.version).toBe(THIN_VERSION);
    const back = await p.readBackupChecked(b.id);
    expect(back.newer).toBe(false);
    expectDecoded(back.doc!, doc, data.doc.maps![0]!);
  });

  it("地図の無い文書は、薄い形を読み書きするページでも今までと同じ形（版 1・見出しに地図の印なし）", async () => {
    setThinBaseline(qMap);
    const doc = touch(createEmptyDoc("自分の地図"), "目標");
    const kv = memoryKV();
    const { p, name } = await saved(kv, doc);
    expect(await rawGet(name, "kv", "doc")).toEqual(doc);
    expect(await rawGet(name, "kv", "meta")).toEqual(expect.not.objectContaining({ mapRelease: expect.anything() }));
    expect(((await rawGet(name, "kv", "meta")) as { docVersion: number }).docVersion).toBe(SCHEMA_VERSION);
    const b = (await p.createBackup("manual", "手動"))!;
    expect(b.docVersion).toBe(SCHEMA_VERSION);
    expect(b.mapRelease).toBeUndefined();
  });

  it("localStorage の保存先も薄い形。400 万文字を超える本体は書かず（前の本体のまま・保存の失敗として知らせる）、緊急コピーは前の物を残す", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const doc = editedDoc(qMap, 3, 30);
    const kv = memoryKV();
    const p = await opened(kv);
    expect(p.mode).toBe("local");
    await p.loadInitial();
    let cur = doc;
    p.attach(() => cur);
    p.markDirty();
    await p.flush();
    const name = nameOf(p);
    const text = kv.get(`${name}:doc`)!;
    expect((JSON.parse(text) as StoredDoc).version).toBe(THIN_VERSION);
    expect((JSON.parse(kv.get(`${name}:meta`)!) as { docVersion: number }).docVersion).toBe(THIN_VERSION);
    p.writeEmergency(true);
    const copy = kv.get(emergencyKeys(kv)[0]!);
    // 大きすぎる中身（利用者のカードの本文が 410 万文字）
    const big = structuredClone(doc);
    const n = makeNode({ title: "長い本文", body: "あ".repeat(4_100_000) });
    big.nodes[n.id] = n;
    big.updatedAt = nextStamp(big.updatedAt);
    cur = big;
    p.markDirty();
    await p.flush();
    expect(p.status).toBe("error");
    expect(p.statusMessage).toContain("大きすぎます");
    expect(kv.get(`${name}:doc`)).toBe(text);
    p.writeEmergency(true);
    expect(kv.get(emergencyKeys(kv)[0]!)).toBe(copy);
  });

  it("地図は要るときだけ読む: 地図の無い本体では読まない。薄い形の本体・地図を持つ文書の保存では 1 度だけ読む（gaps-17）", async () => {
    const page = qMap;
    const load = vi.fn(async () => page);
    // 地図の無い本体
    const kv = memoryKV();
    const { name } = await saved(kv, touch(createEmptyDoc("自分の地図"), "目標"));
    enableThinPage(load);
    expect(thinReadable()).toBe(true);
    expect(readableVersion()).toBe(THIN_VERSION);
    const a = await opened(kv, name);
    expect((await a.loadInitial()).doc!.title).toBe("自分の地図");
    expect(load).not.toHaveBeenCalled();
    // 薄い形の本体: 読むときに 1 度だけ読む
    enableThinPage(null);
    const doc = editedDoc(qMap, 5, 20);
    const kv2 = memoryKV();
    const { name: name2 } = await saved(kv2, doc);
    const sec = ((await rawGet(name2, "kv", "doc")) as StoredDoc).maps![0]!;
    setThinBaseline(null);
    enableThinPage(load);
    const b = await opened(kv2, name2);
    const loaded = await b.loadInitial();
    expect(load).toHaveBeenCalledTimes(1);
    expectDecoded(loaded.doc!, doc, sec);
    // 地図を持つ文書を、地図を読む前に保存する（入れ替えた直後など）: 保存の前に読む（地図ごと書かない）
    setThinBaseline(null);
    enableThinPage(null);
    const load2 = vi.fn(async () => page);
    const fresh = freshDoc(qMap);
    setThinBaseline(null);
    enableThinPage(load2);
    const kv3 = memoryKV();
    const c = await opened(kv3);
    await c.loadInitial();
    c.attach(() => fresh);
    c.markDirty();
    await c.flush();
    expect(c.status).toBe("saved");
    expect(load2).toHaveBeenCalledTimes(1);
    expect(((await rawGet(nameOf(c), "kv", "doc")) as StoredDoc).version).toBe(THIN_VERSION);
    expect(needsPageMap(fresh)).toBe(true);
    expect(needsPageMap(createEmptyDoc())).toBe(false);
  });
});

// ------------------------------------------------------------ 止める側（safety-3）

/** 同じ版の順番で中身の指紋だけが違う地図（同じ版で合わない: 違う組み立て） */
const otherBuild = (map: MapData): MapData => withHeader(map, { hash: `${map.header.hash.slice(0, 12)}qq` });

describe("記録の形で止める（safety-3）: 版 2 以上か地図の変更がある記録は、どの訳で読めなくても止める", () => {
  /** 薄い形の本体を保存し、古い版 1 のバックアップも置いた保存先（止めたら、そのバックアップで始めてはいけない） */
  async function storedThin(map: MapData): Promise<{ kv: ReturnType<typeof memoryKV>; name: string; doc: DocData; rec: StoredDoc }> {
    const doc = editedDoc(map, 21, 25);
    const kv = memoryKV();
    const { p, name } = await saved(kv, doc);
    await p.createBackup("auto", "", touch(createEmptyDoc("前の版 1 の内容"), "前のカード"));
    p.writeEmergency(true);
    p.close();
    return { kv, name, doc, rec: (await rawGet(name, "kv", "doc")) as StoredDoc };
  }

  /** 止めた起動の後に、書く道を全部試しても、保存先が変わらないこと */
  async function expectBlockedNoWrites(kv: ReturnType<typeof memoryKV>, name: string, code?: string): Promise<Persistence> {
    const before = await rawDump(name);
    const kvBefore = kvDump(kv);
    const q = await opened(kv, name);
    const loaded = await q.loadInitial();
    expect(loaded.blocked).toBe(true);
    expect(loaded.doc).toBeNull();
    expect(loaded.why?.kind).toBe("stored");
    if (code) expect(loaded.why?.code).toBe(code);
    expect(q.writer).toBe(false);
    const other = touch(createEmptyDoc("このページで作った内容"), "x");
    q.attach(() => other);
    q.markDirty();
    await q.flush();
    q.writeEmergency(true);
    await q.ensureDailyBackup(other);
    expect(await q.createBackup("manual", "x", other)).toBeNull();
    await q.writeKv("cloud:owner", "u1");
    expect(await rawDump(name)).toBe(before);
    expect(kvDump(kv)).toBe(kvBefore);
    return q;
  }

  it("同じ版で地図が合わない（違う組み立て）: 止める。消さない・古いバックアップで始めない・書かない。止めていてもそのまま書き出せ、「この版で開き直す」を出せる", async () => {
    const { kv, name, rec } = await storedThin(qMap);
    setThinBaseline(otherBuild(qMap));
    const q = await expectBlockedNoWrites(kv, name, "mismatch");
    expect(q.blockedWhy).toMatchObject({ kind: "stored", code: "mismatch", reopen: true });
    // 接続を閉じていても、記録をそのまま書き出せる
    const raw = await q.rawRecord();
    expect(raw!.source).toBe("body");
    expect(JSON.parse(raw!.text)).toEqual(rec);
  });

  it("どんな失敗でも止める側: 形の読めない地図の変更・地図を組み立てられない（読み込めない）・schema の違う版 2・本体の消えた版 2 の記録", async () => {
    // 形の読めない地図の変更
    {
      const { kv, name, rec } = await storedThin(qMap);
      await rawPut(name, "kv", { ...rec, maps: [{ ...rec.maps![0]!, n: [] }] }, "doc");
      await expectBlockedNoWrites(kv, name, "corrupt");
    }
    // 地図を組み立てられない（ページの地図を読めない）
    {
      const { kv, name } = await storedThin(qMap);
      setThinBaseline(null);
      enableThinPage(async () => null);
      await expectBlockedNoWrites(kv, name, "unavailable");
      enableThinPage(null);
      setThinBaseline(qMap);
    }
    // 地図を読み込む途中で失敗した（例外）
    {
      const { kv, name } = await storedThin(qMap);
      setThinBaseline(null);
      enableThinPage(async () => {
        throw new TypeError("伸ばせない");
      });
      await expectBlockedNoWrites(kv, name, "unavailable");
      enableThinPage(null);
      setThinBaseline(qMap);
    }
    // schema の違う版 2（読み手の中で何が投げられても）
    {
      const { kv, name, rec } = await storedThin(qMap);
      await rawPut(name, "kv", { ...rec, schema: "別の形式" }, "doc");
      await expectBlockedNoWrites(kv, name);
    }
    // 版の記録は版 2 なのに本体が無い
    {
      const { kv, name } = await storedThin(qMap);
      const db = await new Promise<IDBDatabase>((resolve) => {
        const r = indexedDB.open(name);
        r.onsuccess = () => resolve(r.result);
      });
      await new Promise<void>((resolve) => {
        const t = db.transaction("kv", "readwrite");
        t.objectStore("kv").delete("doc");
        t.oncomplete = () => resolve();
      });
      db.close();
      await expectBlockedNoWrites(kv, name);
    }
  });

  it("版 1 の壊れた本体だけは今までどおり: いちばん新しいこの版のバックアップで始める", async () => {
    setThinBaseline(qMap);
    const kv = memoryKV();
    const { p, name } = await saved(kv, touch(createEmptyDoc("版 1 の内容"), "a"));
    await p.createBackup("auto", "", touch(createEmptyDoc("バックアップの内容"), "b"));
    p.close();
    await rawPut(name, "kv", { schema: "別の形式", version: 1 }, "doc");
    const q = await opened(kv, name);
    const loaded = await q.loadInitial();
    expect(loaded.blocked).toBe(false);
    expect(loaded.recovered).toBe(true);
    expect(loaded.doc!.title).toBe("バックアップの内容");
    expect(classifyReadFailure({ schema: "別の形式", version: 1 }, new DocFormatError("x"))).toBe("corrupt");
    expect(classifyReadFailure({ version: 2 }, new TypeError("x"))).toBe("blocked");
    expect(classifyReadFailure({ version: 1, maps: [] }, new TypeError("x"))).toBe("blocked");
    expect(classifyReadFailure(undefined, new SyntaxError("x"), 2)).toBe("blocked");
    expect(classifyReadFailure(undefined, new SyntaxError("x"), 1)).toBe("corrupt");
    expect(classifyReadFailure({}, new NewerDocError(3))).toBe("newer");
  });

  it("localStorage の保存先: 版の記録が版 2 で本体が JSON でなければ、壊れた本体と見なさずに止める（版 1 なら今までどおり壊れた本体）", async () => {
    vi.stubGlobal("indexedDB", undefined);
    setThinBaseline(qMap);
    const kv = memoryKV();
    const name = `thin-${++dbSeq}`;
    kv.set(`${name}:doc`, "{壊れた");
    kv.set(`${name}:meta`, JSON.stringify({ rev: 3, savedAt: AT, writer: "t_x", docVersion: THIN_VERSION, mapRelease: qMap.header.release }));
    const before = kvDump(kv);
    const p = await opened(kv, name);
    const loaded = await p.loadInitial();
    expect(loaded.blocked).toBe(true);
    expect(loaded.why?.kind).toBe("stored");
    p.attach(() => createEmptyDoc());
    p.markDirty();
    await p.flush();
    p.writeEmergency(true);
    expect(kvDump(kv)).toBe(before);
    // 読めない本体も、そのままの文字で書き出せる
    expect((await p.rawRecord())!.text).toBe("{壊れた");
    // 版 1 の記録なら、今までどおり壊れた本体（代わりの内容で始める）
    const kv2 = memoryKV();
    kv2.set(`${name}x:doc`, "{壊れた");
    kv2.set(`${name}x:meta`, JSON.stringify({ rev: 3, savedAt: AT, writer: "t_x", docVersion: 1 }));
    const q = await opened(kv2, `${name}x`);
    const l2 = await q.loadInitial();
    expect(l2.blocked).toBe(false);
    expect(l2.recovered).toBe(true);
  });

  it("保存してあった物より前の版の地図のバックアップは、自分では戻さない（選んでもらう: 知らせだけ）", async () => {
    const up = withHeader(qMap, { release: qMap.header.release + 1 });
    const kv = memoryKV();
    setThinBaseline(qMap);
    const { p, name } = await saved(kv, touch(createEmptyDoc("版 1 の内容"), "a"));
    // 前の版の地図（版の順番 0）のバックアップ
    await p.createBackup("auto", "前の版", editedDoc(qMap, 2, 5));
    p.close();
    // 本体は版 1 で壊れていて、版の記録は版の順番 1 の地図を指す（このページは版の順番 1）
    await rawPut(name, "kv", { schema: "別の形式" }, "doc");
    await rawPut(name, "kv", { rev: 9, savedAt: AT, writer: "t_x", docVersion: 1, mapRelease: up.header.release }, "meta");
    setThinBaseline(up);
    const q = await opened(kv, name);
    const loaded = await q.loadInitial();
    expect(loaded.doc).toBeNull();
    expect(loaded.notices.join("")).toContain("前の版のバックアップ（1 件）は自動では戻しませんでした");
    // この版の地図のバックアップがあれば、それで始める
    const r = await opened(kv, name);
    await r.createBackup("auto", "この版", editedDoc(up, 4, 5));
    const s2 = await opened(kv, name);
    const l2 = await s2.loadInitial();
    expect(l2.doc).not.toBeNull();
    expect(l2.recovered).toBe(true);
  });
});

// ------------------------------------------------------------ 緊急コピー

describe("緊急コピー（薄い形の写し・開けない写し・版の違う写し）", () => {
  it("薄い形の写しは、本体より後なら採る", async () => {
    const doc = editedDoc(todoMap, 31, 20);
    const kv = memoryKV();
    const { p, name } = await saved(kv, doc);
    // 保存が間に合わずに閉じた
    const store = new Store(doc);
    store.transact("x", (tx) => void tx.addNode(makeNode({ title: "閉じる直前のカード" })));
    p.attach(() => store.doc);
    p.markDirty();
    p.writeEmergency();
    p.close();
    const q = await opened(kv, name);
    const loaded = await q.loadInitial();
    expect(loaded.notices).toContain("前回、保存しきれなかった変更を復元しました。");
    expect(Object.values(loaded.doc!.nodes).some((n) => n.title === "閉じる直前のカード")).toBe(true);
    expect(emergencyKeys(kv)).toHaveLength(0);
  });

  it("このページでは開けない写し: 本体より後なら起動で止める（写しも本体も残す）。本体より後でなければ、残したまま始める", async () => {
    const doc = editedDoc(qMap, 33, 10);
    const kv = memoryKV();
    const { p, name } = await saved(kv, doc);
    // 別の組み立てのページが、本体より後の写しを残した
    setThinBaseline(otherBuild(qMap));
    const later = touch(structuredClone(doc), "別の組み立てで足したカード");
    const ahead = JSON.stringify({ v: 1, baseRev: 1, at: AT, tabId: "t_other", doc: toStored(later) });
    setThinBaseline(qMap);
    kv.set(`${name}:emergency:t_other`, ahead);
    p.close();
    const before = await rawDump(name);
    const q = await opened(kv, name);
    const loaded = await q.loadInitial();
    expect(loaded.blocked).toBe(true);
    expect(loaded.why).toMatchObject({ kind: "stored", code: "mismatch", reopen: true });
    expect(kv.get(`${name}:emergency:t_other`)).toBe(ahead);
    expect(await rawDump(name)).toBe(before);
    // 止めたときに書き出すのは、その写しの中身
    const raw = await q.rawRecord();
    expect(raw!.source).toBe("emergency");
    // 本体より前の写しは、残したまま始める
    const old = JSON.parse(ahead) as { doc: StoredDoc; baseRev: number };
    old.baseRev = 0;
    old.doc.updatedAt = "2020-01-01T00:00:00.000Z";
    kv.set(`${name}:emergency:t_other`, JSON.stringify(old));
    const r = await opened(kv, name);
    const l2 = await r.loadInitial();
    expect(l2.blocked).toBe(false);
    expect(kv.get(`${name}:emergency:t_other`)).toBe(JSON.stringify(old));
  });

  it("本体と版の違う写し（別の版のページの写し）は、古く見えても黙って消さない: 退避のバックアップに残してから消す（残せなければ消さない）", async () => {
    const doc = editedDoc(qMap, 35, 10);
    const kv = memoryKV();
    const { p, name } = await saved(kv, doc);
    // 前の版のページ（版 1 の形）が残した、本体より古い写し
    const oldCopy = touch(createEmptyDoc("前の版のページの内容"), "前の版のカード");
    oldCopy.updatedAt = "2020-01-01T00:00:00.000Z";
    kv.set(`${name}:emergency:t_old`, JSON.stringify({ v: 1, baseRev: 0, at: AT, tabId: "t_old", doc: oldCopy }));
    p.close();
    const q = await opened(kv, name);
    const loaded = await q.loadInitial();
    expect(loaded.blocked).toBe(false);
    expect(loaded.notices.join("")).toContain("別の版のページの未保存の変更を、バックアップに退避しました");
    expect(kv.get(`${name}:emergency:t_old`)).toBeNull();
    const list = await q.listBackups();
    expect(list.some((b) => b.kind === "conflict" && b.docTitle === "前の版のページの内容")).toBe(true);
    // 同じ版の古い写しは、今までどおり黙って消す
    q.attach(() => doc);
    const same = { ...structuredClone(toStored(doc)), updatedAt: "2020-01-01T00:00:00.000Z" };
    kv.set(`${name}:emergency:t_same`, JSON.stringify({ v: 1, baseRev: 0, at: AT, tabId: "t_same", doc: same }));
    const r = await opened(kv, name);
    const l2 = await r.loadInitial();
    expect(l2.notices.join("")).not.toContain("退避");
    expect(kv.get(`${name}:emergency:t_same`)).toBeNull();
  });
});

// ------------------------------------------------------------ 競合・引き継ぎ・別のタブの保存

describe("開いている間に、このページでは開けない本体に気づく", () => {
  it("保存の競合で、別のタブが開けない地図を保存していたら、上書きせずに止める（このタブの内容は退避）。「上書き」でも上書きしない", async () => {
    const doc = editedDoc(qMap, 41, 10);
    const kv = memoryKV();
    const { p, name } = await saved(kv, doc);
    // 別の組み立てのページのタブが保存した
    setThinBaseline(otherBuild(qMap));
    const theirs = toStored(touch(structuredClone(doc), "別の組み立てのカード"));
    setThinBaseline(qMap);
    await rawPut(name, "kv", theirs, "doc");
    await rawPut(name, "kv", { rev: 2, savedAt: AT, writer: "t_other", docVersion: THIN_VERSION, mapRelease: qMap.header.release, mapHash: theirs.maps![0]!.hash }, "meta");
    const events: unknown[] = [];
    p.on("blocked", (e) => events.push(e));
    const mine = touch(doc, "このタブのカード");
    p.attach(() => mine);
    p.markDirty();
    await p.flush();
    expect(p.blocked).toBe(true);
    expect(events).toEqual([{ kept: "backup", why: expect.objectContaining({ kind: "stored", code: "mismatch" }) }]);
    expect(await rawGet(name, "kv", "doc")).toEqual(theirs);
    const conflicts = (await rawAll(name, "backupMeta")) as Array<{ kind: string; docTitle: string }>;
    expect(conflicts.some((b) => b.kind === "conflict")).toBe(true);
    // 競合の後に開けない本体に替わっていた: 「上書き」を選んでも上書きしない
    const kv2 = memoryKV();
    const { p: a, name: n2 } = await saved(kv2, editedDoc(qMap, 42, 5));
    await rawPut(n2, "kv", toStored(editedDoc(qMap, 43, 5)), "doc");
    await rawPut(n2, "kv", { rev: 5, savedAt: AT, writer: "t_other", docVersion: THIN_VERSION, mapRelease: qMap.header.release }, "meta");
    const mine2 = touch(editedDoc(qMap, 44, 5), "こちら");
    a.attach(() => mine2);
    a.markDirty();
    await a.flush();
    expect(a.status).toBe("conflict");
    setThinBaseline(otherBuild(qMap));
    const theirs2 = toStored(editedDoc(otherBuild(qMap), 45, 5));
    setThinBaseline(qMap);
    await rawPut(n2, "kv", theirs2, "doc");
    expect(await a.resolveConflict("overwrite")).toBeNull();
    expect(a.blocked).toBe(true);
    expect(await rawGet(n2, "kv", "doc")).toEqual(theirs2);
  });

  it("引き継ぎ: 保存してある本体を開けなければ、引き継がずに止める（ロックを奪わない・何も書かない）", async () => {
    const { locks, held } = fakeLocks();
    const kv = memoryKV();
    const name = `thin-${++dbSeq}`;
    const mk = () => makeP(kv, name, { locks });
    const a = mk();
    await a.open();
    expect(await a.acquireWriter()).toBe(true);
    await a.loadInitial();
    const doc = editedDoc(qMap, 51, 10);
    a.attach(() => doc);
    a.markDirty();
    await a.flush();
    const b = mk();
    await b.open();
    expect(await b.acquireWriter()).toBe(false);
    await b.loadInitial();
    setThinBaseline(otherBuild(qMap));
    await rawPut(name, "kv", toStored(editedDoc(otherBuild(qMap), 52, 5)), "doc");
    setThinBaseline(qMap);
    const before = await rawDump(name);
    expect(await b.takeOver()).toBeNull();
    expect(b.blocked).toBe(true);
    expect(b.writer).toBe(false);
    expect(a.writer).toBe(true);
    expect(held()).toBe(true);
    expect(await rawDump(name)).toBe(before);
  });

  it("別のタブの保存を読み直したら開けない本体だった（閲覧のみのタブ）: 止める（壊れた本体と見なさない）", async () => {
    const doc = editedDoc(qMap, 53, 5);
    const kv = memoryKV();
    const { p, name } = await saved(kv, doc);
    setThinBaseline(otherBuild(qMap));
    await rawPut(name, "kv", toStored(editedDoc(otherBuild(qMap), 54, 5)), "doc");
    setThinBaseline(qMap);
    let err: unknown;
    try {
      await p.readStored();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ThinMapError);
    expect(await p.blocksOnRead(err)).toBe(true);
    expect(p.blocked).toBe(true);
    expect(p.blockedWhy?.kind).toBe("stored");
  });
});

// ------------------------------------------------------------ 「この版で開き直す」・前の版の地図の起動

describe("「この版で開き直す」（safety-5）と前の版の地図の起動", () => {
  it("同じ版で地図が合わない本体を、記録のまま安全用バックアップに残してから、この版の地図に鍵で合わせて開く（保存するとこの版の形）", async () => {
    const doc = editedDoc(todoMap, 61, 40);
    const kv = memoryKV();
    const { p, name } = await saved(kv, doc);
    p.close();
    const rec = (await rawGet(name, "kv", "doc")) as StoredDoc;
    const page = otherBuild(todoMap);
    setThinBaseline(page);
    const blocked = await opened(kv, name);
    expect((await blocked.loadInitial()).why).toMatchObject({ code: "mismatch", reopen: true });
    // 開き直す（新しい保存先の口で、起動をやり直す）
    const q = await opened(kv, name);
    const loaded = await q.loadInitial({ reopen: true });
    expect(loaded.blocked).toBe(false);
    expect(loaded.upgrade).toMatchObject({ from: { release: todoMap.header.release, hash: todoMap.header.hash }, to: { hash: page.header.hash }, detached: 0 });
    // 記録のまま残したバックアップ
    const metas = (await rawAll(name, "backupMeta")) as Array<{ id: string; kind: string; label: string; mapHash?: string }>;
    const safety = metas.find((b) => b.kind === "safety" && b.label.includes("この版で開き直す"))!;
    expect(safety.mapHash).toBe(todoMap.header.hash);
    expect(((await rawGet(name, "backupData", safety.id)) as { doc: unknown }).doc).toEqual(rec);
    // 利用者の物は同じ（同じ鍵の地図なので、全部当たる）
    const d = loaded.doc!;
    expect(d.id).toBe(doc.id);
    expect(d.updatedAt).toBe(doc.updatedAt);
    for (const n of Object.values(doc.nodes)) {
      if (keyOf(n) === null) continue;
      const m = d.nodes[n.id];
      expect(m, `カード ${keyOf(n)}`).toBeDefined();
      expect(m!.status).toBe(n.status);
      expect(m!.conditions.map((c) => c.met)).toEqual(n.conditions.map((c) => c.met));
    }
    for (const n of Object.values(doc.nodes)) if (keyOf(n) === null) expect(d.nodes[n.id]?.title).toBe(n.title);
    // 保存すると、この版の地図の形
    q.attach(() => d);
    await q.flush();
    expect(((await rawGet(name, "kv", "doc")) as StoredDoc).maps![0]!.hash).toBe(page.header.hash);
    const r = await opened(kv, name);
    expect((await r.loadInitial()).blocked).toBe(false);
  });

  it("前の版の地図の本体は、起動で鍵で当て直して開く（記録はバックアップに・id と更新時刻はそのまま・保存すると新しい版）", async () => {
    const doc = editedDoc(qMap, 71, 30);
    const kv = memoryKV();
    const { p, name } = await saved(kv, doc);
    p.close();
    const up = withHeader(qMap, { release: qMap.header.release + 1, hash: `${qMap.header.hash.slice(0, 12)}up` });
    setThinBaseline(up);
    const q = await opened(kv, name);
    const loaded = await q.loadInitial();
    expect(loaded.blocked).toBe(false);
    expect(loaded.upgrade?.to.release).toBe(up.header.release);
    expect(loaded.notices.join("")).toContain(`地図を新しい版（版 ${up.header.release}）で開きました`);
    expect(loaded.doc!.id).toBe(doc.id);
    expect(loaded.doc!.updatedAt).toBe(doc.updatedAt);
    const metas = (await rawAll(name, "backupMeta")) as Array<{ kind: string; mapRelease?: number }>;
    expect(metas.some((b) => b.kind === "safety" && b.mapRelease === qMap.header.release)).toBe(true);
    q.attach(() => loaded.doc!);
    await q.flush();
    expect(((await rawGet(name, "kv", "doc")) as StoredDoc).maps![0]!.release).toBe(up.header.release);
  });
});

// ------------------------------------------------------------ アカウント

/** db の代わり（cloud.test.ts と同じ作りの小さい物: 読み書き・見張り・貸し出し・一覧） */
function memoryBackend() {
  const docs = new Map<string, Record<string, unknown>>();
  const watchers = new Map<string, Set<(d: CloudDoc) => void>>();
  const leases = new Map<string, { holder: string; until: number }>();
  const snap = (path: string): CloudDoc => {
    const d = docs.get(path);
    return d ? { exists: true, data: structuredClone(d) } : { exists: false };
  };
  const be: CloudBackend = {
    async get(path) {
      return snap(path);
    },
    async set(path, data) {
      docs.set(path, structuredClone(data));
      for (const fn of watchers.get(path) ?? []) queueMicrotask(() => fn(snap(path)));
    },
    async delete(path) {
      docs.delete(path);
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
      return [...docs.keys()].filter((k) => k.startsWith(`${path}/`) && !k.slice(path.length + 1).includes("/")).map((k) => ({ id: k.slice(path.length + 1), data: structuredClone(docs.get(k)) }));
    },
  };
  return { be, docs };
}

/** 前の版のページ（v32・v33）の写しの読み書き: 文書をそのまま（版 1）書き、docVersion が 1 より大きければ新しい版、中身は normalizeDoc（版 2 は読まない） */
const legacyCodec: CloudCodec = {
  encode: (doc) => ({ stored: doc, docVersion: doc.version }),
  decode: async (raw) => normalizeDoc(raw).doc,
  isNewer: (v) => typeof v === "number" && Number.isFinite(v) && Math.floor(v) > SCHEMA_VERSION,
};

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** 1 つの端末（cloud.test.ts の device を小さくした物。本物の Store・取り込みの決まり・このページか前の版のページの読み書き） */
function device(be: CloudBackend, name: string, doc: DocData, opts: { codec?: CloudCodec; base?: SyncBase | null; release?: "remote" | "local" | "later" | null } = {}) {
  const store = new Store(doc);
  const local = { base: opts.base ?? null, backups: [] as Array<{ doc: DocData; label: string; kind: string }>, notices: [] as string[], asked: 0, adopted: [] as string[] };
  const repo = new CloudRepo(be, "user1", name, undefined, opts.codec);
  const sync = new CloudSync(
    repo,
    {
      getDoc: () => store.doc,
      bootDoc: async () => null,
      isWriter: () => true,
      isDisposable: (d) => isDisposableDoc(d),
      isEditing: () => false,
      isForeign: () => false,
      adopt: async (d, how, stillOk) => {
        if (!stillOk()) return null;
        if (how === "choice") local.backups.push({ doc: store.doc, label: "切り替える前のこのブラウザの内容", kind: "kept" });
        if (how === "remote") store.replaceDoc(d, "別の端末の内容を読み込む");
        else store.load(d, "load");
        local.adopted.push(how);
        return { id: store.doc.id, updatedAt: store.doc.updatedAt };
      },
      backup: async (d, label, kind) => {
        local.backups.push({ doc: d, label, kind });
        return true;
      },
      confirmWithoutBackup: async () => false,
      chooseFirst: async () => "later",
      ...(opts.release !== null
        ? {
            chooseAcrossRelease: async () => {
              local.asked++;
              return opts.release ?? "later";
            },
          }
        : {}),
      readBase: async () => local.base,
      writeBase: async (b) => {
        local.base = b;
      },
      notice: (t, tone) => void local.notices.push(`${tone}:${t}`),
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

/** 同期が落ち着くまで待つ（本当の時計で。小さい木なので速い） */
async function settled(sync: CloudSync, ms = 3000): Promise<void> {
  const t0 = Date.now();
  await tick(20);
  while (Date.now() - t0 < ms && (sync.state === "syncing" || sync.state === "pending" || sync.state === "connecting")) await tick(20);
}

describe("アカウントの写し: 同じ入れ物で docVersion 2", () => {
  it("ページの地図を持つ文書は薄い形で送る: マニフェストは形 1・分割・SHA-256 のまま、docVersion 2。読むと同じ文書", async () => {
    const doc = editedDoc(todoMap, 81, 30);
    const { be, docs } = memoryBackend();
    const repo = new CloudRepo(be, "u", "dev");
    const m = await repo.write(doc, null);
    expect(m).toMatchObject({ format: 1, docVersion: THIN_VERSION, parts: 1, docId: doc.id, docUpdatedAt: doc.updatedAt, nodes: Object.keys(doc.nodes).length });
    expect(Object.keys(m).sort()).toEqual(["bytes", "chain", "docId", "docUpdatedAt", "docVersion", "edges", "enc", "format", "gen", "hash", "lineage", "lost", "nodes", "parts", "savedAt", "seq", "stale", "title", "writer"]);
    const part = docs.get(`data/users/u/fourd/parts/${m.gen}-0`)!;
    expect(typeof part.data).toBe("string");
    expect(await sha256Hex(part.data as string)).toBe(m.hash);
    const e = await encodeDoc(doc);
    expect(e.docVersion).toBe(THIN_VERSION);
    const back = await repo.read();
    const stored = toStored(doc);
    expectDecoded(back!.doc, doc, stored.maps![0]!);
  });

  it("前の版のページ（v32・v33 の読み方）は、docVersion 2 の写しを新しい版と見分けて止まる（入れ物を確かめる前に。上書きしない）", async () => {
    const doc = editedDoc(qMap, 82, 10);
    const { be } = memoryBackend();
    const m = await new CloudRepo(be, "user1", "new").write(doc, null);
    const old = new CloudRepo(be, "user1", "old", undefined, legacyCodec);
    await expect(old.readManifest()).rejects.toBeInstanceOf(CloudNewerError);
    // 中身だけ見ても新しい版（マニフェストの docVersion を見ない、もっと前の版のページ）
    const payload = (await be.get(`data/users/user1/fourd/parts/${m.gen}-0`)).data!.data as string;
    await expect(decodeDoc(m.enc, payload, legacyCodec)).rejects.toBeInstanceOf(CloudNewerError);
    // 前の版のページの同期は、開き直すまで止まって書かない
    const o = device(be, "old", buildR6Future().pv.doc, { codec: legacyCodec });
    await o.sync.start();
    await settled(o.sync);
    expect(o.sync.message).toContain("開き直して");
    expect((await new CloudRepo(be, "user1", "x").readManifest())!.gen).toBe(m.gen);
    o.sync.stop();
  });

  it("このページで開けない薄い形の写し（違う組み立ての地図）は、形の違う写しとして止める（壊れた写しと見なして書き直さない）", async () => {
    const page = qMap;
    setThinBaseline(otherBuild(page));
    const theirs = editedDoc(otherBuild(page), 83, 10);
    const { be } = memoryBackend();
    const m = await new CloudRepo(be, "user1", "other").write(theirs, null);
    setThinBaseline(page);
    const e = await encodeDoc(theirs).catch(() => null);
    expect(e).not.toBeNull();
    const payload = (await be.get(`data/users/user1/fourd/parts/${m.gen}-0`)).data!.data as string;
    const err = await decodeDoc(m.enc, payload).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(CloudError);
    expect((err as CloudError).code).toBe("format");
    // 変更のある端末でも書き直さない（止めて待つ）
    const mine = editedDoc(page, 84, 10);
    const d = device(be, "mine", mine, { base: { gen: "g_old", docId: mine.id, docUpdatedAt: "2020-01-01T00:00:00.000Z" } });
    await d.sync.start();
    await settled(d.sync);
    expect(d.sync.state).toBe("paused");
    expect((await new CloudRepo(be, "user1", "x").readManifest())!.gen).toBe(m.gen);
    d.sync.stop();
  });
});

describe("アカウントの写しの地図が手元より新しい版（2 つの端末: 前の版のページと新しいページ。safety-2）", () => {
  /**
   * 前の版のページ（版 6 の地図・前の版の読み書き）の端末 OLD と、新しいページ（版 7 にした小さい木・このページの読み書き）の端末 NEW。
   *   1. OLD が版 6 の地図を送る（世代 g1）。NEW も読み込んで合わせる
   *   2. NEW が新しい版の地図にして送り、手を選ぶ（新しい版の写し）
   *   3. OLD は止める前に編集した（まだ送っていない）。送ろうとして新しい版の写しに気づき、止まる（編集は手元に残る）
   *   4. OLD を新しいページで開き直す（同じブラウザ: 基準は g1・手元は前の版の地図と止める前の編集）
   */
  async function scenario(release: "remote" | "local" | "later" | null) {
    const page = withHeader(qMap, { release: 7 });
    setThinBaseline(page);
    const { be } = memoryBackend();
    const r6 = buildR6Future().pv.doc;
    expect(mapReleaseOf(r6)).toBe(6);
    const old = device(be, "old", structuredClone(r6), { codec: legacyCodec });
    await old.sync.start();
    await settled(old.sync);
    const g1 = old.local.base!.gen;
    const nw = device(be, "new", createEmptyDoc());
    await nw.sync.start();
    await settled(nw.sync);
    expect(nw.local.base!.gen).toBe(g1);
    // NEW: 新しい版の地図にして（同じ文書の続き）、手を選ぶ
    const migrated = thinBaselineDoc({ at: AT });
    migrated.id = r6.id;
    nw.store.replaceDoc(migrated, "地図を新しい版にする");
    nw.sync.markDirty();
    await settled(nw.sync);
    const opt = Object.values(nw.store.doc.nodes).find((n) => keyOf(n) === "r.keep")!;
    nw.store.transact("選ぶ", (tx) => tx.updateNode(opt.id, { status: "active" }));
    nw.edit("新しいページで足したカード");
    await settled(nw.sync);
    const after = (await nw.repo.readManifest())!;
    expect(after.docVersion).toBe(THIN_VERSION);
    expect(mapReleaseOf(nw.store.doc)).toBe(7);
    // OLD: 止める前の編集（送る前に、新しい版の写しに気づいて止まる）
    old.edit("前の版のページで止める前に書いたカード");
    await settled(old.sync);
    expect(old.sync.message).toContain("開き直して");
    expect((await nw.repo.readManifest())!.gen).toBe(after.gen);
    const leftover = old.store.doc;
    old.sync.stop();
    // OLD を新しいページで開き直す
    const re = device(be, "old2", leftover, { base: old.local.base, release });
    await re.sync.start();
    await settled(re.sync);
    const acct = (await new CloudRepo(be, "user1", "check").read())!;
    return { nw, re, acct, after, leftover };
  }

  it("黙って手元で上書きしない: 聞いて「アカウントの内容を使う」なら新しい版の内容を読み込み、手元（止める前の編集）はバックアップに残す", async () => {
    const { nw, re, acct, after } = await scenario("remote");
    expect(re.local.asked).toBe(1);
    expect(acct.manifest.gen).toBe(after.gen);
    expect(nw.has(acct.doc, "新しいページで足したカード")).toBe(true);
    expect(re.has(re.store.doc, "新しいページで足したカード")).toBe(true);
    const kept = re.local.backups.find((b) => b.kind === "kept")!;
    expect(re.has(kept.doc, "前の版のページで止める前に書いたカード")).toBe(true);
    nw.sync.stop();
    re.sync.stop();
  });

  it("「あとで決める」・聞けない（ダイアログの無い）ときは、止めて待つ（アカウントは新しいページの内容のまま・手元の編集も残る）", async () => {
    for (const choice of ["later", null] as const) {
      const { nw, re, acct, after } = await scenario(choice);
      expect(acct.manifest.gen).toBe(after.gen);
      expect(nw.has(acct.doc, "新しいページで足したカード")).toBe(true);
      expect(re.sync.state).toBe("paused");
      expect(re.has(re.store.doc, "前の版のページで止める前に書いたカード")).toBe(true);
      nw.sync.stop();
      re.sync.stop();
    }
  });

  it("「このブラウザの内容を使う」と答えたときだけ、アカウントの内容をバックアップに残してから送る", async () => {
    const { nw, re, acct } = await scenario("local");
    expect(re.has(acct.doc, "前の版のページで止める前に書いたカード")).toBe(true);
    const kept = re.local.backups.find((b) => b.kind === "kept")!;
    expect(nw.has(kept.doc, "新しいページで足したカード")).toBe(true);
    nw.sync.stop();
    re.sync.stop();
  });
});

// ------------------------------------------------------------ 書き出し・取り込み

describe("書き出しと取り込み", () => {
  it("ページの地図を持つ文書は薄い形で書き出し、同じ版はそのまま読める。前の版は当て直して読み（知らせに数）、新しい版は今までと同じ文で断る", async () => {
    const doc = editedDoc(todoMap, 91, 30);
    const text = exportText(doc, "test");
    const raw = JSON.parse(text) as StoredDoc & { exportedAt: string; app: unknown };
    expect(raw.version).toBe(THIN_VERSION);
    expect(raw.maps).toHaveLength(1);
    expect(text.length).toBeLessThan(JSON.stringify(doc).length / 5);
    const pv = previewImport(text);
    expectDecoded(pv.doc, doc, raw.maps![0]!);
    expect(pv.upgrade).toBeUndefined();
    // 前の版のファイル（このページは版の順番を 1 つ上げた地図）
    const up = withHeader(todoMap, { release: todoMap.header.release + 1, hash: `${todoMap.header.hash.slice(0, 12)}up` });
    setThinBaseline(up);
    const older = await previewImportAsync(text);
    expect(older.upgrade).toMatchObject({ from: { release: todoMap.header.release }, to: { release: up.header.release } });
    expect(older.report.warnings[0]).toContain(`このページの版（版 ${up.header.release}）`);
    expect(older.doc.id).toBe(doc.id);
    // 新しい版のファイル
    setThinBaseline(todoMap);
    const newer = exportText(editedDoc(up, 92, 5), "test");
    setThinBaseline(todoMap);
    let err: unknown;
    try {
      previewImport(newer);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NewerDocError);
    expect(err).toBeInstanceOf(DocFormatError);
    // 薄い形を読めないページ（今の公開版）は、版 2 のファイルを今までと同じ文で断る
    setThinBaseline(null);
    expect(() => previewImport(text)).toThrow("このファイルは新しい版（スキーマ 2）の 4D Branch で作られています。アプリを新しくしてから読み込んでください。");
    // 地図の無い文書の書き出しは今までと同じ形
    const plain = touch(createEmptyDoc("自分の地図"), "a");
    expect((JSON.parse(exportText(plain, "test")) as { version: number; maps?: unknown }).maps).toBeUndefined();
  });

  it("地図を読む前でも、薄い形のファイルは地図を読み込んでから読む（previewImportAsync）", async () => {
    const doc = editedDoc(qMap, 93, 10);
    const text = exportText(doc, "test");
    setThinBaseline(null);
    const load = vi.fn(async () => qMap);
    enableThinPage(load);
    const pv = await previewImportAsync(text);
    expect(load).toHaveBeenCalledTimes(1);
    expect(pv.doc.id).toBe(doc.id);
  });

  it("追加の取り込みで、今の地図と同じ鍵の今日を持つ地図は版によらず足さない。足したカードと線だけを、同じ鍵のカードにつなぎ直す（safety-9）", () => {
    const base = editedDoc(qMap, 94, 10);
    const card = Object.values(base.nodes).find((n) => keyOf(n) === "r.keep")!;
    // 取り込むファイル: 同じ地図（前の版の印）に、利用者のカードと線
    const up = withHeader(qMap, { release: qMap.header.release + 1 });
    const incoming = freshDoc(up);
    setThinBaseline(qMap);
    const inCard = Object.values(incoming.nodes).find((n) => keyOf(n) === "r.keep")!;
    const gone = Object.values(incoming.nodes).find((n) => keyOf(n) !== null && keyOf(n)!.startsWith("r.ind_quit."))!;
    const u1 = makeNode({ title: "ファイルの自分のカード" });
    const u2 = makeNode({ title: "ファイルの自分のカード 2" });
    incoming.nodes[u1.id] = u1;
    incoming.nodes[u2.id] = u2;
    const e1 = makeEdge({ source: inCard.id, target: u1.id, relation: "supports" });
    const e2 = makeEdge({ source: u1.id, target: u2.id });
    const e3 = makeEdge({ source: u2.id, target: gone.id, relation: "blocks" });
    incoming.edges[e1.id] = e1;
    incoming.edges[e2.id] = e2;
    incoming.edges[e3.id] = e3;
    const roots = (d: DocData) => Object.values(d.nodes).filter((n) => n.meta.forecastRoot === true).length;
    // 今の公開版と同じ（飛ばさない）なら、地図が 2 つになる
    expect(roots(mergeDocs(base, incoming).doc)).toBe(2);
    const res = mergeDocs(base, incoming, { skipSameMaps: true });
    expect(roots(res.doc)).toBe(1);
    expect(res.skippedMaps).toBe(1);
    expect(res.skippedCards).toBe(Object.keys(incoming.nodes).length - 2);
    expect(res.added.nodes).toBe(2);
    const n1 = Object.values(res.doc.nodes).find((n) => n.title === "ファイルの自分のカード")!;
    const n2 = Object.values(res.doc.nodes).find((n) => n.title === "ファイルの自分のカード 2")!;
    const lines = Object.values(res.doc.edges);
    expect(lines.some((e) => e.source === card.id && e.target === n1.id && e.relation === "supports")).toBe(true);
    expect(lines.some((e) => e.source === n1.id && e.target === n2.id)).toBe(true);
    // つなぎ先の同じ鍵のカードがある（今の地図にもある手）: つなぎ直す
    const goneHere = Object.values(base.nodes).find((n) => keyOf(n) === keyOf(gone));
    expect(lines.some((e) => e.source === n2.id && e.relation === "blocks")).toBe(!!goneHere);
    expect(res.retargeted! + res.droppedEdges!).toBe(2);
    // 取り込んだ後も、薄い形で書ける（地図は 1 つ）
    expect(encodeStored(res.doc).stats!.fatKeyed).toBe(0);
  });

  it("入口が 2 つあるときは、ページの地図の版の入口を先に選ぶ。ページの地図が無ければ今までどおり", () => {
    // ページの地図の方を後に作った（今までの決まりなら、先に作った版 6 の入口を選ぶ）
    setThinBaseline(qMap);
    const page = thinBaselineDoc({ at: "2030-01-01T00:00:00.000Z" });
    const r6 = buildR6Future().pv.doc;
    const merged = mergeDocs(r6, page).doc;
    const roots = Object.values(merged.nodes).filter((n) => n.meta.forecastRoot === true && n.meta.impact);
    expect(roots).toHaveLength(2);
    const pageRoot = roots.find((n) => n.meta.anchor !== undefined)!;
    expect(primaryImpactRoot(merged)).toBe(pageRoot.id);
    setThinBaseline(null);
    expect(primaryImpactRoot(merged)).not.toBe(pageRoot.id);
  });
});

// ------------------------------------------------------------ ID をそのまま足す（gaps-1）・引数に広げない（gaps-9）

describe("ページの地図を足すときは ID をそのまま（薄い形が小さいまま）", () => {
  const userDoc = (): DocData => {
    const d = createEmptyDoc("自分の地図");
    let prev: GNode | null = null;
    for (let i = 0; i < 15; i++) {
      const n = makeNode({ title: `自分のカード ${i}`, x: i * 37.5, y: i * 11.25 });
      d.nodes[n.id] = n;
      if (prev) {
        const e = makeEdge({ source: prev.id, target: n.id });
        d.edges[e.id] = e;
      }
      prev = n;
    }
    return d;
  };

  it("「追加する」: 自分のカードがある文書にページの地図を足して書くと、地図はカードごとの読み替え無しで小さい（ID を振り直すと地図ごとの大きさ）", () => {
    const base = userDoc();
    const map = freshDoc(qMap);
    expect(holdsPageMap(map)).toBe(true);
    const kept = mergeDocs(base, map, { keepIds: true });
    const s = encodeStored(kept.doc);
    expect(s.stats!.nid).toBe(0);
    expect(s.stats!.eid).toBe(0);
    expect(s.stats!.patched).toBe(0);
    const ownChars = JSON.stringify(Object.values(base.nodes)).length + JSON.stringify(Object.values(base.edges)).length;
    expect(JSON.stringify(s.stored).length).toBeLessThan(8_000 + ownChars);
    // 振り直すと、カードごとの読み替えで大きくなる
    const reIded = encodeStored(mergeDocs(base, map).doc);
    expect(reIded.stats!.nid).toBeGreaterThan(4000);
    expect(JSON.stringify(reIded.stored).length).toBeGreaterThan(20 * JSON.stringify(s.stored).length);
  });

  it("新しい版に差し替える（前の地図を消して入れる・同じ鍵の地図を新しい版にする）も、ページの地図の ID をそのまま使う", () => {
    // 前の形の未来の道筋（数字を出さない入口）: 消して入れる
    const base = userDoc();
    const v1 = makeNode({ title: "未来の道筋（仕事・10 年）", meta: { forecastRoot: true } });
    base.nodes[v1.id] = v1;
    const res = swapFutureDoc(base, freshDoc(qMap));
    expect(res.inPlace).toBe(false);
    const s = encodeStored(res.doc);
    expect(s.stats!.nid).toBe(0);
    expect(s.stats!.eid).toBe(0);
    // 版 6 の地図（同じ鍵の今日）: 同じ地図を新しい版にする（増えた線も同梱の ID のまま）
    const r6 = buildR6Future().pv.doc;
    const up = swapFutureDoc(r6, freshDoc(qMap));
    expect(up.inPlace).toBe(true);
    const s2 = encodeStored(up.doc);
    expect(s2.stats!.eid).toBeLessThan(100);
    expect(JSON.stringify(s2.stored).length).toBeLessThan(200_000);
  });

  it("io.ts は並びを Math.max・Math.min の引数に広げない（7 万件で iPhone の引数の上限を超えない）。7 万件の文書にも足せる", () => {
    expect(ioSrc).not.toMatch(/Math\.(max|min)\(\s*\.\.\./);
    const big = createEmptyDoc("大きな文書");
    for (let i = 0; i < 70_000; i++) {
      const n = makeNode({ title: `カード ${i}`, x: i, y: -i });
      big.nodes[n.id] = n;
    }
    const res = mergeDocs(big, touch(createEmptyDoc("足す物"), "足すカード"));
    expect(Object.keys(res.doc.nodes)).toHaveLength(70_001);
    const added = Object.values(res.doc.nodes).find((n) => n.title === "足すカード")!;
    expect(added.x).toBeGreaterThan(69_999);
  });
});

// ------------------------------------------------------------ 履歴（perf-6）

describe("履歴: 大きな文書の入れ替えは 2 件まで（perf-6）", () => {
  const big = (title: string): DocData => {
    const d = createEmptyDoc(title);
    for (let i = 0; i < HEAVY_REPLACE_NODES; i++) {
      const n = makeNode({ title: `${title} ${i}` });
      d.nodes[n.id] = n;
    }
    return d;
  };

  it("大きな文書の入れ替えは新しい 2 件だけ持ち、元に戻すはその手前で止まる。小さな文書の入れ替えは今までどおり全部持つ", () => {
    const store = new Store(createEmptyDoc("始め"));
    store.transact("足す", (tx) => void tx.addNode(makeNode({ title: "最初のカード" })));
    for (const t of ["一", "二", "三", "四"]) store.replaceDoc(big(t), `入れ替え ${t}`);
    const heavy = store.history.undoStack.filter((e) => e.replace);
    expect(heavy).toHaveLength(HEAVY_REPLACE_KEEP);
    expect(store.history.undoStack.map((e) => e.label)).toEqual(["入れ替え 三", "入れ替え 四"]);
    expect(store.undo()).toBe(true);
    expect(store.doc.title).toBe("三");
    expect(store.undo()).toBe(true);
    expect(store.doc.title).toBe("二");
    expect(store.undo()).toBe(false);
    expect(store.redo()).toBe(true);
    expect(store.doc.title).toBe("三");
    // 小さな文書（今の地図・やりたいことリストなど）は今までどおり
    const small = new Store(createEmptyDoc("始め"));
    for (let i = 0; i < 6; i++) small.replaceDoc(touch(createEmptyDoc(`小 ${i}`), "a"), `小さな入れ替え ${i}`);
    expect(small.history.undoStack).toHaveLength(6);
  });
});

// ------------------------------------------------------------ 版をまたいで読む

describe("版をまたいで読む（前の版の地図の変更を、ページの地図に鍵で当て直す: D10・D11・safety-7・safety-8）", () => {
  it("残った鍵のカードには選んだ手・チェック（元の番号で）・書き換え・見込み・ID を、無くなったカードは「前の版で決めたこと」に、消したカードは戻す。いつも同じ結果", async () => {
    const { map: next, gone } = await withoutMove("ind_quit", todoMap.header.release + 1);
    const doc = freshDoc(todoMap);
    const store = new Store(doc);
    const byKey = (k: string): GNode => Object.values(store.doc.nodes).find((n) => keyOf(n) === k)!;
    const keepOpt = Object.values(store.doc.nodes).find((n) => keyOf(n)?.startsWith("r.keep.") && n.conditions.length > 1)!;
    const goneOpts = Object.values(store.doc.nodes).filter((n) => keyOf(n)?.startsWith(`${gone}.`) && n.conditions.length > 1).slice(0, 3);
    expect(goneOpts).toHaveLength(3);
    const [g1, g2, g3] = goneOpts as [GNode, GNode, GNode];
    const gonePin = Object.values(store.doc.nodes).find((n) => keyOf(n)?.startsWith(`${gone}.`) && n.id !== g1.id && n.id !== g2.id && n.id !== g3.id)!;
    const keepEdge = Object.values(store.doc.edges).find((e) => e.target === byKey(keyOf(keepOpt)!.split(".").slice(0, 3).join(".")).id && typeof e.meta.prob === "number");
    const toDelete = Object.values(store.doc.nodes).find((n) => keyOf(n)?.startsWith("r.ad_permside.") && keyOf(n)!.split(".").length === 4)!;
    const user = makeNode({ title: "自分のメモ" });
    store.transact("編集", (tx) => {
      tx.updateNode(keepOpt.id, { status: "active", title: "自分で書き換えた題名", conditions: keepOpt.conditions.map((c, i) => (i === 1 ? { ...c, met: true } : c)) });
      tx.updateNode(g1.id, { title: "無くなる手で書き換えた題名" });
      tx.updateNode(g2.id, { status: "done" });
      tx.updateNode(g3.id, { conditions: g3.conditions.map((c, i) => (i === 0 ? { ...c, met: true } : c)) });
      tx.addNode(user);
      tx.addEdge(makeEdge({ source: user.id, target: gonePin.id, relation: "supports" }));
      tx.addEdge(makeEdge({ source: keepOpt.id, target: user.id, relation: "supports" }));
      if (keepEdge) tx.updateEdge(keepEdge.id, { meta: { ...keepEdge.meta, prob: 77 } });
    });
    store.transact("消す", (tx) => tx.deleteNode(toDelete.id));
    const edited = store.doc;
    const record = JSON.parse(JSON.stringify(toStored(edited))) as StoredDoc;
    expect(record.maps![0]!.n![keyOf(g3)!]).toMatchObject({ k: [expect.any(String)], was: { kt: [g3.conditions[0]!.text] } });
    // 次の版のページで読む
    setThinBaseline(next);
    const a = decodeStored(record);
    const b = decodeStored(JSON.parse(JSON.stringify(record)));
    expect(JSON.stringify(a.doc)).toBe(JSON.stringify(b.doc));
    const d = a.doc;
    expect(a.upgrade).toMatchObject({ from: { release: todoMap.header.release }, to: { release: next.header.release }, detached: 4, restored: 1 });
    expect(d.id).toBe(edited.id);
    expect(d.updatedAt).toBe(edited.updatedAt);
    // 残った鍵のカード
    const k1 = d.nodes[keepOpt.id]!;
    expect(k1.status).toBe("active");
    expect(k1.title).toBe("自分で書き換えた題名");
    expect(k1.conditions.map((c) => c.met)).toEqual([false, true]);
    if (keepEdge) expect(d.edges[keepEdge.id]!.meta.prob).toBe(77);
    // 消したカードは戻る（その先ごと）
    expect(d.nodes[toDelete.id]).toBeDefined();
    // 無くなった鍵のカード: 鍵の無い利用者のカードとして、前の ID のまま「前の版で決めたこと」に
    const group = Object.values(d.nodes).find((n) => n.title === "前の版で決めたこと")!;
    expect(group.meta.prevGroup).toBe(todoMap.header.release);
    expect(group.x).toBeLessThan(d.nodes[record.maps![0]!.root]!.x);
    const det = (id: string) => d.nodes[id]!;
    expect(det(g1.id)).toMatchObject({ title: "無くなる手で書き換えた題名", meta: { prevKey: keyOf(g1), prevRelease: todoMap.header.release } });
    expect(keyOf(det(g1.id))).toBeNull();
    expect(det(g2.id)).toMatchObject({ title: g2.title, status: "done" });
    expect(det(g3.id).conditions).toEqual([expect.objectContaining({ text: g3.conditions[0]!.text, met: true })]);
    // 線でつないだだけのカード（印）も、題名つきで残り、利用者の線はつながったまま
    expect(det(gonePin.id).title).toBe(gonePin.title);
    expect(Object.values(d.edges).some((e) => e.source === user.id && e.target === gonePin.id)).toBe(true);
    expect(Object.values(d.edges).some((e) => e.source === keepOpt.id && e.target === user.id)).toBe(true);
    // 無くなった手の、利用者の物を持たないカードは残らない
    expect(Object.values(d.nodes).filter((n) => keyOf(n)?.startsWith(`${gone}.`))).toHaveLength(0);
    // 当て直した文書は、次の版の地図でそのまま書いて読める
    const again = toStored(d);
    expect(again.maps![0]!.release).toBe(next.header.release);
    expectDecoded(fromStored(JSON.parse(JSON.stringify(again))), d, again.maps![0]!);
  });

  it("アカウントの形（ID の読み替え・プロジェクトとシナリオの読み替え・ずれ）のまま、前の版から当て直せる", async () => {
    const doc = editedDoc(todoMap, 101, 80);
    const record = JSON.parse(JSON.stringify(toStored(doc))) as StoredDoc;
    const { map: next } = await withoutMove("ind_quit", todoMap.header.release + 1);
    setThinBaseline(next);
    const d = decodeStored(record).doc;
    // 利用者のカードは全部残り、利用者の線は残ったカードか「前の版で決めたこと」につながる
    for (const n of Object.values(doc.nodes)) if (keyOf(n) === null) expect(d.nodes[n.id]?.title, n.title).toBe(n.title);
    for (const e of Object.values(d.edges)) {
      expect(d.nodes[e.source], `線 ${e.id} の元`).toBeDefined();
      expect(d.nodes[e.target], `線 ${e.id} の先`).toBeDefined();
    }
    // 残った鍵のカードの状態は同じ
    for (const n of Object.values(doc.nodes)) {
      const k = keyOf(n);
      if (k === null || k.startsWith("r.ind_quit") || n.meta.forecastRoot === true) continue;
      const m = Object.values(d.nodes).find((x) => keyOf(x) === k);
      if (m) expect(m.status, k).toBe(n.status);
    }
    expect(d.projectOrder).toEqual(doc.projectOrder);
  });
});

// ------------------------------------------------------------ 細かい決まり

describe("見出しの印・読める版・捨ててよい中身", () => {
  it("見出しの印: 形の版・地図の版の順番・中身の指紋。このページより新しい版・開けない地図を、中身を読まずに見分ける", () => {
    setThinBaseline(qMap);
    const rec = toStored(freshDoc(qMap));
    expect(recordInfo(rec)).toEqual({ format: THIN_VERSION, mapRelease: qMap.header.release, mapHash: qMap.header.hash, mapBv: THIN_BASELINE_VERSION });
    expect(headerBlock({ docVersion: THIN_VERSION, mapRelease: qMap.header.release, mapHash: qMap.header.hash, mapBv: THIN_BASELINE_VERSION + 1 })).toBe("blocked");
    expect(recordInfo(createEmptyDoc())).toEqual({ format: SCHEMA_VERSION });
    expect(headerBlock({ docVersion: THIN_VERSION, mapRelease: qMap.header.release, mapHash: qMap.header.hash })).toBeNull();
    expect(headerBlock({ docVersion: THIN_VERSION, mapRelease: qMap.header.release + 1 })).toBe("newer");
    expect(headerBlock({ docVersion: THIN_VERSION, mapRelease: qMap.header.release, mapHash: "x" })).toBe("blocked");
    expect(headerBlock({ docVersion: THIN_VERSION + 1 })).toBe("newer");
    expect(isNewerRecord({ ...rec, maps: [{ ...rec.maps![0]!, release: qMap.header.release + 1 }] })).toBe(true);
    expect(isNewerRecord(rec)).toBe(false);
    // 薄い形を読めないページ（今の公開版）: 版 2 はどれも新しい版
    setThinBaseline(null);
    expect(thinReadable()).toBe(false);
    expect(readableVersion()).toBe(SCHEMA_VERSION);
    expect(headerBlock({ docVersion: THIN_VERSION })).toBe("newer");
    expect(isNewerRecord(rec)).toBe(true);
  });

  it("捨ててよい中身か: 大きな地図はノードの数だけで違うと分かる（指紋を作らない）。何もしていないデモは今までどおり", async () => {
    const { buildDemoDoc } = await import("../../src/demo/demo");
    expect(isDisposableDoc(buildDemoDoc())).toBe(true);
    const map = freshDoc(qMap);
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) expect(isDisposableDoc(map)).toBe(false);
    expect((performance.now() - t0) / 20).toBeLessThan(5);
    const moved = buildDemoDoc();
    const first = Object.values(moved.nodes)[0]!;
    moved.nodes[first.id] = { ...first, x: first.x + 50 };
    expect(isDisposableDoc(moved)).toBe(true);
    const added = buildDemoDoc();
    const n = makeNode({ title: "足した" });
    added.nodes[n.id] = n;
    expect(isDisposableDoc(added)).toBe(false);
    void makeCondition;
  });
});

/** 型だけ使う物（読み手の型の確かめ） */
export type _Unused = GEdge | ThinSection;
