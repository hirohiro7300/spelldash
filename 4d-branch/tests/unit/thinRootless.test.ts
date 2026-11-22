// 今日を消した地図の保存（見直し loss-1）。利用者のカードが地図の最初の手へ「進む」でつながったまま今日を消すと、その手の先の地図のカードは
// 残る（Commands.impactOrphans）。残ったカードが多い（1,000 枚以上）と、前は薄い形で書けず（ThinWriteError）、本体・緊急コピー・アカウント・
// 書き出し・安全用バックアップのどれにも書けなかった（開き直すと、消す前の内容に戻った）。
//   今: 今日の鍵に −1 の印（今日だけ消した）を付けた薄い形で書き、読むと今日の無い同じ文書。前の版の記録なら、版をまたぐと今日が戻る。
//   薄い形にできないとき（地図の基準を用意できない など）も、本体・緊急コピー・バックアップ・書き出しはそのままの形で書く（アカウントへは送らず、止めて知らせる）
import "fake-indexeddb/auto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Commands } from "../../src/app/commands";
import { DEFAULT_PREFS, UiState } from "../../src/app/uiState";
import { ViewModel } from "../../src/app/viewModel";
import type { MapData } from "../../src/deepmap/mapData";
import { isDisposableDoc } from "../../src/demo/demo";
import { isFlowEdge } from "../../src/model/forks";
import { createEmptyDoc, makeNode, THIN_VERSION } from "../../src/model/schema";
import type { DocData, GNode } from "../../src/model/types";
import {
  decodeStored,
  encodeStored,
  fromStored,
  setCodecWarn,
  setThinBaseline,
  thinBaselineDoc,
  ThinMapError,
  ThinWriteError,
  toStored,
  toStoredOrFull,
  type StoredDoc,
  type ThinSection,
} from "../../src/persist/codec";
import { CloudRepo, CloudSync, encodeDoc, type CloudBackend, type CloudDoc } from "../../src/persist/cloud";
import { exportText, previewImportAsync } from "../../src/persist/io";
import { memoryKV, Persistence } from "../../src/persist/persistence";
import { Store } from "../../src/store/store";
import { rawGet } from "./helpers/idbRaw";
import { loadQSmall, loadQSmallDevTree } from "./helpers/qSmall";
import { checkRoundTrip } from "./helpers/thinCheck";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";

let qMap: MapData;
let page7: MapData;
beforeAll(async () => {
  qMap = await loadQSmall();
  page7 = { ...qMap, header: { ...qMap.header, release: 7 } } as MapData;
});
afterEach(() => {
  setThinBaseline(null);
  setCodecWarn(null);
});

const AT = "2026-11-19T03:04:05.006Z";
const keyOf = (n: GNode | undefined): string | null => (typeof n?.meta?.key === "string" ? n.meta.key : null);
let dbSeq = 0;

/** アプリと同じ道具（ストア・ビューモデル・コマンド） */
function app(doc: DocData) {
  const store = new Store(doc);
  const ui = new UiState(structuredClone(DEFAULT_PREFS));
  ui.persistPrefs = false;
  const vm = new ViewModel(store, ui);
  vm.narrow = () => false;
  const cmd = new Commands(store, ui, vm, {
    toast: () => undefined,
    viewCenter: () => ({ x: 0, y: 0 }),
    startEdit: () => undefined,
    reveal: () => undefined,
    confirm: async () => true,
  });
  return { store, ui, vm, cmd };
}

/** 自分のカードを最初の手 move へ「進む」でつなぎ、今日を消した地図（消した後に、もう 1 枚書いた） */
function rootlessDoc(move = "r.keep"): { doc: DocData; rootId: string; own: string; later: string; line: string } {
  setThinBaseline(page7);
  const s = app(thinBaselineDoc({ at: AT }));
  const root = Object.values(s.store.doc.nodes).find((n) => n.meta.forecastRoot === true)!;
  const first = Object.values(s.store.doc.nodes).find((n) => keyOf(n) === move)!;
  const own = s.cmd.createNode("action", { x: -3000, y: 500 }, { exact: true, title: "自分の計画" })!;
  const [line] = s.cmd.connect([own], first.id);
  expect(isFlowEdge(s.store.doc.edges[line!]!)).toBe(true);
  s.vm.ensure();
  s.cmd.deleteNodes([root.id]);
  const later = s.cmd.createNode("goal", { x: -3000, y: 900 }, { exact: true, title: "消した後に書いたカード" })!;
  expect(s.store.doc.nodes[root.id]).toBeUndefined();
  return { doc: s.store.doc, rootId: root.id, own, later, line: line! };
}

const keyedCount = (d: DocData): number => Object.values(d.nodes).filter((n) => keyOf(n) !== null).length;

describe("今日を消した地図を薄い形で書く（loss-1）", () => {
  it("今日の鍵に −1 の印を付けて書き、読むと今日の無い同じ文書（もう一度書くと同じ文字列）", () => {
    const { doc, rootId, own, later, line } = rootlessDoc();
    expect(keyedCount(doc)).toBeGreaterThanOrEqual(1000);
    const { stored, sec, decoded } = checkRoundTrip(doc);
    expect(stored.version).toBe(THIN_VERSION);
    expect(sec.n?.[page7.key(0)]).toBe(-1);
    // 今日は書かない（root は基準の今日の ID）。残ったカードは書かない（基準のまま）・消した手は 0 の印
    expect(Object.keys(stored.nodes)).not.toContain(rootId);
    const baseRoot = Object.values(thinBaselineDoc({ at: AT }).nodes).find((n) => n.meta.forecastRoot === true)!;
    expect(sec.root).toBe(baseRoot.id);
    expect(Object.values(sec.n ?? {}).filter((p) => p === 0).length).toBe(2);
    expect(JSON.stringify(stored).length).toBeLessThan(8_000);
    // 読んだ文書: 今日は無く、自分のカード・その線・消した後のカードはそのまま
    expect(decoded.nodes[rootId]).toBeUndefined();
    expect(decoded.nodes[own]?.title).toBe("自分の計画");
    expect(decoded.nodes[later]?.title).toBe("消した後に書いたカード");
    expect(decoded.edges[line]).toEqual(doc.edges[line]);
    expect(keyedCount(decoded)).toBe(keyedCount(doc));
  });

  it("どの手の先が残っても（今日の右の 3 つの手それぞれ）書けて、読むと同じ", () => {
    for (const move of ["r.keep", "r.ad_permside", "r.ind_quit"]) {
      const { doc } = rootlessDoc(move);
      const n = keyedCount(doc);
      if (n < 1000) {
        // 少なければ今までどおりそのままの形（版 1）
        expect(toStored(doc)).toBe(doc);
        continue;
      }
      checkRoundTrip(doc);
    }
  });

  it("保存の道のどれも書ける: 本体・緊急コピー・アカウントの写し・書き出し・安全用バックアップ。開き直すと、消した後の内容", async () => {
    const { doc, rootId, later, line } = rootlessDoc();
    const kv = memoryKV();
    const name = `rootless-${++dbSeq}`;
    const p = new Persistence({ dbName: name, kv, locks: null, channel: false, debounceMs: 1 });
    await p.open();
    await p.acquireWriter();
    await p.loadInitial();
    const store = new Store(doc);
    p.attach(() => store.doc);
    p.markDirty();
    await p.flush();
    expect(p.status).toBe("saved");
    const body = (await rawGet(name, "kv", "doc")) as StoredDoc;
    expect(body.version).toBe(THIN_VERSION);
    expect(body.maps![0]!.n?.[page7.key(0)]).toBe(-1);
    expect((await rawGet(name, "kv", "meta")) as { docVersion: number }).toMatchObject({ docVersion: THIN_VERSION, mapRelease: 7 });
    // 緊急コピー（閉じるとき）
    p.writeEmergency(true);
    const em = [...kv.data.keys()].filter((k) => k.includes(":emergency:"));
    expect(em).toHaveLength(1);
    expect(JSON.parse(kv.data.get(em[0]!)!).doc.maps[0].n[page7.key(0)]).toBe(-1);
    // アカウントの写し
    const enc = await encodeDoc(doc);
    expect(enc.docVersion).toBe(THIN_VERSION);
    // 書き出し（取り込むと同じ）
    const text = exportText(doc, "test");
    const pv = await previewImportAsync(text);
    expect(pv.doc.nodes[later]?.title).toBe("消した後に書いたカード");
    expect(pv.doc.nodes[rootId]).toBeUndefined();
    // 安全用バックアップ（復元・読み込み・追加するの前に作る）
    const b = await p.createBackup("safety", "「復元」の前", doc);
    expect(b?.docVersion).toBe(THIN_VERSION);
    expect((await p.readBackup(b!.id))?.nodes[later]?.title).toBe("消した後に書いたカード");
    p.close();
    // 開き直す: 消した後の内容（今日は無い・消した後のカードはある・自分の線もある）
    kv.data.delete(em[0]!);
    const p2 = new Persistence({ dbName: name, kv, locks: null, channel: false, debounceMs: 1 });
    await p2.open();
    await p2.acquireWriter();
    const back = await p2.loadInitial();
    expect(back.blocked).toBe(false);
    expect(back.doc!.nodes[rootId]).toBeUndefined();
    expect(back.doc!.nodes[later]?.title).toBe("消した後に書いたカード");
    expect(back.doc!.edges[line]).toBeDefined();
    p2.close();
  });

  it("残ったカードは書き換えとして数えない（印は今日の −1 と、消えた手の 0 だけ）", () => {
    const { doc } = rootlessDoc("r.ind_quit");
    expect(keyedCount(doc)).toBeGreaterThanOrEqual(1000);
    const st = encodeStored(doc);
    expect(st.stats!.patched).toBe(0);
    expect(st.stats!.tombs).toBe(3);
    expect(st.stats!.storedNodes).toBe(2);
  });

  it("読み手は閉じて失敗する: 印があるのに今日のカードがある・root が基準の今日の ID でない・今日の鍵に 0", () => {
    const { doc } = rootlessDoc();
    const rec = JSON.parse(JSON.stringify(toStored(doc))) as StoredDoc & { maps: ThinSection[] };
    const fresh = thinBaselineDoc({ at: AT });
    const root = Object.values(fresh.nodes).find((n) => n.meta.forecastRoot === true)!;
    const withRoot = structuredClone(rec);
    withRoot.nodes[root.id] = root;
    expect(() => decodeStored(withRoot)).toThrow(ThinMapError);
    const otherRoot = structuredClone(rec);
    otherRoot.maps[0]!.root = "n_someone_else";
    expect(() => decodeStored(otherRoot)).toThrow(ThinMapError);
    const zero = structuredClone(rec);
    zero.maps[0]!.n![page7.key(0)] = 0;
    expect(() => decodeStored(zero)).toThrow(ThinMapError);
  });

  it("前の版の記録（版 7）を新しい版（版 8）のページで読む: 今日は戻り（消したカードは版をまたぐと戻る）、自分のカードと線はそのまま", async () => {
    const { doc, own, later, line } = rootlessDoc();
    const raw = JSON.parse(JSON.stringify(toStored(doc))) as StoredDoc;
    const tree = await loadQSmallDevTree();
    tree.header = { ...tree.header, release: 8, hash: `${tree.header.hash.slice(0, 12)}zz` };
    setThinBaseline(fromDevTree(tree));
    const d = decodeStored(raw);
    expect(d.upgrade).toBeDefined();
    const roots = Object.values(d.doc.nodes).filter((n) => n.meta.forecastRoot === true);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.meta.futureRelease).toBe(8);
    expect(d.upgrade!.restored).toBeGreaterThanOrEqual(1);
    expect(d.doc.nodes[own]?.title).toBe("自分の計画");
    expect(d.doc.nodes[later]?.title).toBe("消した後に書いたカード");
    expect(d.doc.edges[line]).toBeDefined();
    // 地図は全部戻る（どのカードも鍵ごとに 1 枚）
    expect(keyedCount(d.doc)).toBe(fromDevTree(tree).n);
    // 当て直した文書は、新しい版のページで薄い形に書ける
    expect(toStored(d.doc).version).toBe(THIN_VERSION);
  });
});

describe("薄い形にできないときも、利用者の物をどこにも残せなくしない（loss-1 の守り）", () => {
  /** 地図の基準が無いページで、3 か月ごとの地図を持つ文書（ThinBaselineMissingError になる） */
  function noBaselineDoc(): DocData {
    setThinBaseline(page7);
    const d = thinBaselineDoc({ at: AT });
    d.nodes.n_mine = makeNode({ id: "n_mine", title: "自分のカード" });
    setThinBaseline(null);
    return d;
  }

  it("toStoredOrFull は、そのままの形（版 1）で返して知らせる。toStored は今までどおり投げる", () => {
    const warned: string[] = [];
    setCodecWarn((m) => warned.push(m));
    const d = noBaselineDoc();
    expect(() => toStored(d)).toThrow(ThinWriteError);
    const r = toStoredOrFull(d);
    expect(r.full).toBe(true);
    expect(r.stored).toBe(d);
    expect(warned.some((w) => w.includes("そのままの形で保存しました"))).toBe(true);
  });

  it("本体・緊急コピー・バックアップ・書き出しはそのままの形で書け、読み直せる", async () => {
    const d = noBaselineDoc();
    const kv = memoryKV();
    const name = `nobase-${++dbSeq}`;
    const p = new Persistence({ dbName: name, kv, locks: null, channel: false, debounceMs: 1 });
    await p.open();
    await p.acquireWriter();
    await p.loadInitial();
    p.attach(() => d);
    p.markDirty();
    await p.flush();
    expect(p.status).toBe("saved");
    expect(((await rawGet(name, "kv", "doc")) as DocData).nodes.n_mine?.title).toBe("自分のカード");
    expect(((await rawGet(name, "kv", "meta")) as { docVersion: number }).docVersion).toBe(1);
    p.writeEmergency(true);
    expect([...kv.data.keys()].some((k) => k.includes(":emergency:"))).toBe(true);
    const b = await p.createBackup("safety", "前", d);
    expect(b?.docVersion).toBe(1);
    const exported = JSON.parse(exportText(d, "t")) as DocData;
    expect(exported.version).toBe(1);
    expect(fromStored(exported).nodes.n_mine?.title).toBe("自分のカード");
    p.close();
  });

  it("アカウントへは送らない: 送る形にできなければ同期を止めて知らせる（つながらないのと取り違えて繰り返さない）", async () => {
    const d = noBaselineDoc();
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
    await expect(encodeDoc(d)).rejects.toBeInstanceOf(ThinWriteError);
    const store = new Store(d);
    const sync = new CloudSync(
      new CloudRepo(be, "u1", "t1"),
      {
        getDoc: () => store.doc,
        bootDoc: async () => null,
        isWriter: () => true,
        isDisposable: (x) => isDisposableDoc(x),
        isEditing: () => false,
        isForeign: () => false,
        adopt: async () => null,
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
    for (let i = 0; i < 50 && sync.state !== "paused"; i++) await new Promise((r) => setTimeout(r, 10));
    expect(sync.state).toBe("paused");
    expect(sync.message).toContain("アカウントへ送る形にできません");
    expect(docs.size).toBe(0);
    sync.stop();
  });

  it("地図の無い文書・少しだけ鍵のカードがある文書は、今までどおり（そのままの形・知らせない）", () => {
    const warned: string[] = [];
    setCodecWarn((m) => warned.push(m));
    const e = createEmptyDoc();
    expect(toStoredOrFull(e)).toEqual({ stored: e, full: false });
    expect(warned).toEqual([]);
  });
});
