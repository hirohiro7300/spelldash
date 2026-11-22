// 8 万枚の木（3 か月ごとの地図の本番の形）での保存の道（作業メモ SPEC v1 §6・§7.2、R0 §10.3 の 5・6・7）:
//   保存先（IndexedDB）に薄い形で書いて開き直すと同じ・地図は要るときだけ読む・アカウントの写しは 1 分割・書き出しは小さい・
//   「追加する」でページの地図を足しても小さいまま・版 6 の地図を新しい版にしても小さい。時間は書き出しておく（目標は thinMapFull.test.ts が見る）。
// 動くのは、ページに版 7 の候補を入れたテスト（VITE_IMPACT_Q=1 IMPACT_Q_BUNDLE=<impact-q.b64> npx vitest run …）か、
// IMPACT_Q_FULL=<impact-q.b64 のある場所> のときだけ。ふだんのテストは小さい木（thinPaths.test.ts）
import "fake-indexeddb/auto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MapData } from "../../src/deepmap/mapData";
import { swapFutureDoc } from "../../src/demo/futureSwap";
import { decodeBundle } from "../../src/demo/impactBundle";
import { loadPageMap, PAGE_Q } from "../../src/demo/pageBundle";
import { mapBaselineDigest } from "../../src/demo/impactDigest";
import qB64 from "@impact-q-bundle?raw";
import { createEmptyDoc, makeEdge, makeNode, THIN_VERSION } from "../../src/model/schema";
import type { DocData } from "../../src/model/types";
import { CloudRepo, type CloudBackend, type CloudDoc } from "../../src/persist/cloud";
import { enableThinPage, encodeStored, setThinBaseline, thinBaselineDoc, toStored, type StoredDoc } from "../../src/persist/codec";
import { exportText, mergeDocs, previewImport } from "../../src/persist/io";
import { memoryKV, Persistence } from "../../src/persist/persistence";
import { Store } from "../../src/store/store";
import { rawGet } from "./helpers/idbRaw";
import { envVar, nodeFs } from "./helpers/qSmall";
import { buildR6Future } from "./helpers/r6";
import { expectDecoded } from "./helpers/thinCheck";
import { accountShape, EDIT_KINDS, randomEdits, seeded } from "./helpers/thinEdits";

const DIR = envVar("IMPACT_Q_FULL");
const RUN = PAGE_Q || !!DIR;
const SLOW = 600_000;
const AT = "2026-11-19T03:00:00.000Z";

async function pageMap(): Promise<MapData> {
  if (PAGE_Q) return (await loadPageMap())!;
  return decodeBundle(await bundleText());
}

/** 同梱データの文字（冷えた開き直しを測るために、新しく伸ばす） */
async function bundleText(): Promise<string> {
  if (PAGE_Q) return qB64;
  const fs = await nodeFs();
  return new TextDecoder().decode(fs.readFileSync(`${DIR}/impact-q.b64`));
}

/** 本物のストアを通した編集（アカウントの形・選ぶ・チェック・書き換え・自分のカード） */
function edited(seed: number): DocData {
  const R = seeded(seed);
  const acct = accountShape(thinBaselineDoc({ at: AT }), R, { rate: 0.0005, rootReId: true, dx: 872, dy: -420, at: "2026-11-12T09:30:00.000Z" });
  const store = new Store(acct);
  randomEdits(store, R, 60, EDIT_KINDS.filter((k) => k !== "undo" && k !== "redo"));
  return store.doc;
}

describe.skipIf(!RUN)("8 万枚の木の保存の道（版 7 の候補をページに入れたとき・IMPACT_Q_FULL があるとき）", () => {
  let map: MapData;
  beforeAll(async () => {
    map = await pageMap();
    setThinBaseline(map);
  }, SLOW);
  afterAll(() => {
    enableThinPage(null);
    setThinBaseline(null);
  });

  it(
    "保存先に薄い形で書き、開き直すと同じ。版の記録に docVersion 2。地図は保存してあった物に地図があるときだけ読む",
    async () => {
      const doc = edited(7);
      const kv = memoryKV();
      const name = `full-${Date.now()}`;
      const p = new Persistence({ dbName: name, kv, locks: null, channel: false, debounceMs: 1 });
      await p.open();
      await p.acquireWriter();
      await p.loadInitial();
      p.attach(() => doc);
      p.markDirty();
      const t0 = performance.now();
      await p.flush();
      const saveMs = performance.now() - t0;
      expect(p.status).toBe("saved");
      const rec = (await rawGet(name, "kv", "doc")) as StoredDoc;
      expect(rec.version).toBe(THIN_VERSION);
      expect((await rawGet(name, "kv", "meta")) as object).toMatchObject({ docVersion: THIN_VERSION, mapRelease: map.header.release, mapHash: map.header.hash });
      const chars = JSON.stringify(rec).length;
      p.writeEmergency(true);
      const em = [...kv.data].find(([k]) => k.includes(":emergency:"))![1];
      // 開き直す（地図はまだ読んでいないページ: 読み込み方だけ決めてある）
      setThinBaseline(null);
      const load = vi.fn(async () => map);
      enableThinPage(load);
      const q = new Persistence({ dbName: name, kv, locks: null, channel: false, debounceMs: 1 });
      await q.open();
      await q.acquireWriter();
      const t1 = performance.now();
      const loaded = await q.loadInitial();
      const loadMs = performance.now() - t1;
      expect(load).toHaveBeenCalledTimes(1);
      expect(loaded.blocked).toBe(false);
      expectDecoded(loaded.doc!, doc, rec.maps![0]!);
      q.close();
      // 冷えた開き直し（起動と同じ: 同梱データを新しく伸ばし、基準を組み立てる）。版の記録の基準の文書の指紋があるとき・無いとき（見直し code-2）
      const digest = mapBaselineDigest(map);
      const cold: Record<string, number> = {};
      for (const how of ["指紋なし", "指紋あり"] as const) {
        const b64 = await bundleText();
        setThinBaseline(null);
        enableThinPage(() => decodeBundle(b64), how === "指紋あり" ? { digest } : {});
        const c = new Persistence({ dbName: name, kv, locks: null, channel: false, debounceMs: 1 });
        await c.open();
        await c.acquireWriter();
        const tc = performance.now();
        const again = await c.loadInitial();
        cold[how] = performance.now() - tc;
        expect(again.blocked).toBe(false);
        c.close();
      }
      setThinBaseline(map);
      console.log(
        `保存先: 本体 ${chars.toLocaleString()} 文字・緊急コピー ${em.length.toLocaleString()} 文字・保存 ${saveMs.toFixed(0)} ms・開き直し（地図は組み立て済み）${loadMs.toFixed(0)} ms・` +
          `冷えた開き直し（同梱データの伸長・基準の組み立てを含む）: 指紋なし ${cold["指紋なし"]!.toFixed(0)} ms・指紋あり ${cold["指紋あり"]!.toFixed(0)} ms`,
      );
      expect(chars).toBeLessThan(200_000);
      expect(em.length).toBeLessThan(1_000_000);
    },
    SLOW,
  );

  it(
    "アカウントの写しは同じ入れ物の 1 分割（docVersion 2）。書き出しも小さく、読むと同じ",
    async () => {
      const doc = edited(9);
      const docs = new Map<string, Record<string, unknown>>();
      const be: CloudBackend = {
        get: async (path): Promise<CloudDoc> => (docs.has(path) ? { exists: true, data: structuredClone(docs.get(path)!) } : { exists: false }),
        set: async (path, data) => void docs.set(path, structuredClone(data)),
        delete: async (path) => void docs.delete(path),
        watch: () => () => undefined,
        lease: async () => true,
      };
      const repo = new CloudRepo(be, "u", "dev");
      const m = await repo.write(doc, null);
      expect(m).toMatchObject({ format: 1, docVersion: THIN_VERSION, parts: 1 });
      const back = await repo.read();
      const stored = toStored(doc);
      expectDecoded(back!.doc, doc, stored.maps![0]!);
      const text = exportText(doc, "test");
      expectDecoded(previewImport(text).doc, doc, stored.maps![0]!);
      console.log(`アカウント: ${m.bytes.toLocaleString()} 文字（gzip の base64 で ${String(docs.get(`data/users/u/fourd/parts/${m.gen}-0`)!.data).length.toLocaleString()} 文字）・書き出し ${text.length.toLocaleString()} 文字`);
      expect(text.length).toBeLessThan(250_000);
    },
    SLOW,
  );

  it(
    "「追加する」でページの地図を足しても、版 6 の地図を新しい版にしても、薄い形は小さいまま（カードごとの読み替えにならない: gaps-1・R0 §11.4）",
    () => {
      const base = createEmptyDoc("自分の地図");
      let prev: string | null = null;
      for (let i = 0; i < 15; i++) {
        const n = makeNode({ title: `自分のカード ${i}`, x: i * 40.5, y: i * 3.25 });
        base.nodes[n.id] = n;
        if (prev) {
          const e = makeEdge({ source: prev, target: n.id });
          base.edges[e.id] = e;
        }
        prev = n.id;
      }
      const merged = mergeDocs(base, thinBaselineDoc({ at: AT }), { keepIds: true });
      const a = encodeStored(merged.doc);
      expect(a.stats!.nid + a.stats!.eid).toBe(0);
      const aChars = JSON.stringify(a.stored).length;
      const up = swapFutureDoc(buildR6Future().pv.doc, thinBaselineDoc({ at: AT }));
      const b = encodeStored(up.doc);
      const bChars = JSON.stringify(b.stored).length;
      console.log(`追加する: ${aChars.toLocaleString()} 文字・版 6 から新しい版に: ${bChars.toLocaleString()} 文字（線の読み替え ${b.stats!.eid}・カードの読み替え ${b.stats!.nid}）`);
      expect(aChars).toBeLessThan(20_000);
      expect(bChars).toBeLessThan(400_000);
    },
    SLOW,
  );
});
