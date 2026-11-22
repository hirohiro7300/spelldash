// 版 6 の地図の引き上げを、8 万枚の木（版 7 の候補）で確かめる（作業メモ SPEC v1 §8・D11、見直し safety-1・user-6・gaps-5・gaps-14）:
//   合成のアカウントの形の版 6 の文書（tests/fixtures/account-r6.json）の利用者の物は、どの深さの物も、鍵の同じカード（今日・最初の 10 の手・
//   3 か月後の状態）・読み替えた手（3 か月後の手 → 同じ状態の 3 か月目の同じ種類の手。84 枚のうち 55 枚）・「前の版で決めたこと」のどれかにある。
//   いつも同じ結果（2 回・2 つの時差）。次に保存すると薄い形で小さい。保存先から起動しても同じ。時間は書き出しておく。
// 動くのは、ページに版 7 の候補を入れたテスト（VITE_IMPACT_Q=1 IMPACT_Q_BUNDLE=<impact-q.b64> npx vitest run …）か、
// IMPACT_Q_FULL=<impact-q.b64 のある場所> のときだけ。ふだんのテストは小さい木（legacyUpgrade.test.ts）
import "fake-indexeddb/auto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MapData } from "../../src/deepmap/mapData";
import { decodeBundle } from "../../src/demo/impactBundle";
import { loadPageMap, PAGE_Q } from "../../src/demo/pageBundle";
import { THIN_VERSION } from "../../src/model/schema";
import type { DocData, GNode } from "../../src/model/types";
import { decodeStored, enableThinPage, setThinBaseline, toStored, upgradeNotice, type StoredDoc } from "../../src/persist/codec";
import { memoryKV, Persistence } from "../../src/persist/persistence";
import { rawGet, rawPut } from "./helpers/idbRaw";
import { ACCOUNT_R6_RAW, accountR6Doc, checkUpgrade, expectedFate, inventory } from "./helpers/legacyCheck";
import { envVar, nodeFs } from "./helpers/qSmall";
import { expectDecoded } from "./helpers/thinCheck";

const DIR = envVar("IMPACT_Q_FULL");
const RUN = PAGE_Q || !!DIR;
const SLOW = 600_000;

async function pageMap(): Promise<MapData> {
  if (PAGE_Q) return (await loadPageMap())!;
  const fs = await nodeFs();
  return decodeBundle(new TextDecoder().decode(fs.readFileSync(`${DIR}/impact-q.b64`)));
}

const keyOf = (n: GNode | undefined): string | null => (typeof n?.meta?.key === "string" ? n.meta.key : null);

/** 3 回のうち一番速い時間（ms）と、最後の結果 */
function best<T>(f: () => T, runs = 3): { ms: number; value: T } {
  let ms = Infinity;
  let value!: T;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    value = f();
    ms = Math.min(ms, performance.now() - t0);
  }
  return { ms, value };
}

describe.skipIf(!RUN)("版 6 の地図の引き上げ（8 万枚の木・版 7 の候補）", () => {
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
    "アカウントの形の文書: 利用者の物はどの深さの物も、鍵の同じカード・読み替えた手（55 枚の読み替え）・前の版で決めたことのどれかに。知らせは数のまま",
    () => {
      const input = accountR6Doc();
      // 鍵の読み替え: 版 6 の 3 か月後の手 84 枚のうち、ページの地図に同じ状態・同じ種類の手がある物
      const inv = inventory(input);
      let m3 = 0;
      let mappable = 0;
      for (const [k, c] of inv.card) {
        if (k.split(".").length !== 4) continue;
        m3++;
        if (expectedFate(map, k, c).how === "moved") mappable++;
      }
      expect([m3, mappable]).toEqual([84, 55]);
      const raw = JSON.parse(ACCOUNT_R6_RAW) as unknown;
      // 1 回目（基準を組み立てる）と、その後の速さ
      const t0 = performance.now();
      const first = decodeStored(raw);
      const firstMs = performance.now() - t0;
      const { ms, value: d } = best(() => decodeStored(JSON.parse(ACCOUNT_R6_RAW)));
      const r = checkUpgrade(input, d.doc, map);
      expect([r.kept, r.moved, r.detached]).toEqual([d.upgrade!.legacy!.kept.cards, d.upgrade!.legacy!.moved.cards, d.upgrade!.legacy!.detached.cards]);
      // 版 7 の候補では、最初の手と 3 か月後の状態は全部残る: 深さ 1・2 の物は鍵の同じカードに、深さ 3 の手の 3 枚は読み替えて移し、
      // 読み替えの無い 3 か月後の手（転職活動を続ける）とその先（1 年後・2 年の進め方・3 年後）は別のカードに
      const byKey = (k: string): GNode => d.doc.nodes[inv.card.get(k)!.id]!;
      for (const k of ["r.fc_switch", "r.sd_pilot", "r.sd_grow", "r.ind_quit", "r.fc_switch.high", "r.fc_switch.none", "r.ad_permside.s", "r.sd_pilot.no"]) expect(keyOf(byKey(k)), k).toBe(k);
      expect(byKey("r.fc_switch.none.keep")).toMatchObject({ status: "dropped", meta: { key: "r.fc_switch.none.1k" } });
      expect(byKey("r.fc_switch.high.ad_permside")).toMatchObject({ title: "転職先でも届け出て副業を探す（自分の言葉）", meta: { key: "r.fc_switch.high.1as" } });
      expect(byKey("r.fc_switch.high.ad_permside").tags).toContain("自分のタグ");
      // 3 か月後の『広告運用も認められた』（版 6 の a0_a1）の手は、同じ状態があればそこへ。新しい地図が 1 社目の有無で分けていれば（生成 v2 の
      // 版 7 の候補 r7b から）、分けた先のうち見込みの高い『全部可（顧客まだ）』（a0。1 割 2 分。a1 は 8 分）の同じ種類の手へ
      const split = map.indexOfKey("r.ad_permside.a0_a1") < 0;
      expect(keyOf(byKey("r.ad_permside.a0_a1.ad_side"))).toBe(split ? "r.ad_permside.a0.1ad" : "r.ad_permside.a0_a1.1ad");
      const detached = Object.values(d.doc.nodes)
        .filter((n) => n.meta.prevKey !== undefined)
        .map((n) => n.meta.prevKey as string)
        .sort();
      expect(detached).toEqual([
        "r.fc_switch.none.fc_switch",
        "r.fc_switch.none.fc_switch.high",
        "r.fc_switch.none.fc_switch.high.keep",
        "r.fc_switch.none.fc_switch.high.plan_side",
        "r.fc_switch.none.fc_switch.high.plan_side.a",
        "r.fc_switch.none.fc_switch.none",
        "r.fc_switch.none.fc_switch.none.ind_quit",
        // 期限・種類・プロジェクト・シナリオだけを直したカード（新しい地図に無い: loss-3）
        "r.ind_quit.cl2.ad_more.cl5",
        "r.keep.all.fc_switch.high",
        "r.sd_grow.all.fc_switch.high.plan_side",
        "r.sd_grow.all.fc_switch.mid.keep",
      ]);
      // 鍵の同じカード・読み替えた手の、直した期限・種類・開始はそのまま（loss-3）
      expect(byKey("r.ad_permside").time.due).toBe("2027-05-31");
      expect(byKey("r.keep.all").type).toBe("goal");
      expect(byKey("r.ad_permside.a0_a1.ad_side").time.start).toBe("2027-03-10");
      // 77% に直した見込みは、ページの地図の同じ線に
      const high = byKey("r.fc_switch.high");
      expect(Object.values(d.doc.edges).find((e) => e.target === high.id)!.meta.prob).toBe(77);
      // 知らせ: 移した手は 2027 年 2 月の同じ手へ・残したカードは別のカードとして（数のまま）
      const text = upgradeNotice(d.upgrade!, "boot");
      expect(text).toContain("見送った手 1 件・書き換えた・チェックした手 2 件は 2027 年 2 月の同じ手へ移しました");
      if (split) {
        expect(d.upgrade!.legacy!.split).toEqual([{ to: "全部可（顧客まだ）", cards: 1 }]);
        expect(text).toContain("移しました（うち 1 件は新しい地図で分かれた結果のうち見込みの高い『全部可（顧客まだ）』の後へ）。");
      } else expect(d.upgrade!.legacy!.split).toBeUndefined();
      expect(text).toContain("最初の手と 3 か月後のカードで決めたこと 10 件はそのまま引き継ぎました");
      expect(text).toContain("新しい地図に無いカードの選んだ手 2 件・見送った手 1 件・書き換えた・線でつないだカード 8 件は、別のカードとして「前の版で決めたこと」（今日の左）に残しました");
      console.log(`版 6 → 版 7 の引き上げ: 最初の 1 回 ${firstMs.toFixed(0)} ms・その後 ${ms.toFixed(0)} ms（3 回のうち一番速い値）。引き継ぎ ${r.kept}・移した手 ${r.moved}・別のカード ${r.detached}`);
      console.log(`知らせ: ${text}`);
      expect(JSON.stringify(toStored(first.doc))).toBe(JSON.stringify(toStored(d.doc)));
      expect(ms).toBeLessThan(3000);
    },
    SLOW,
  );

  it(
    "いつも同じ結果（2 つの時差）。次に保存すると薄い形で小さく、読むとそのまま（もう引き上げない）",
    () => {
      const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
      const was = env.TZ;
      let la = "";
      let tokyo = "";
      let doc!: DocData;
      try {
        env.TZ = "America/Los_Angeles";
        doc = decodeStored(JSON.parse(ACCOUNT_R6_RAW)).doc;
        la = JSON.stringify(toStored(doc));
        env.TZ = "Asia/Tokyo";
        tokyo = JSON.stringify(toStored(decodeStored(JSON.parse(ACCOUNT_R6_RAW)).doc));
      } finally {
        if (was === undefined) delete env.TZ;
        else env.TZ = was;
      }
      expect(tokyo).toBe(la);
      const stored = JSON.parse(la) as StoredDoc;
      expect(stored.version).toBe(THIN_VERSION);
      expect(stored.maps![0]!.release).toBe(map.header.release);
      console.log(`引き上げた後の薄い形: ${la.length.toLocaleString()} 文字（版 6 の文書 ${ACCOUNT_R6_RAW.length.toLocaleString()} 文字）・カードの読み替え ${Object.keys(stored.maps![0]!.nid ?? {}).length}・書き換え ${Object.keys(stored.maps![0]!.n ?? {}).length}`);
      expect(la.length).toBeLessThan(64_000);
      const back = decodeStored(JSON.parse(la));
      expect(back.upgrade).toBeUndefined();
      expectDecoded(back.doc, doc, stored.maps![0]!);
    },
    SLOW,
  );

  it(
    "保存先から起動: 版 6 の本体を引き上げて開き、保存すると薄い形（docVersion 2）",
    async () => {
      const name = `legacy-full-${Date.now()}`;
      const kv = memoryKV();
      const p0 = new Persistence({ dbName: name, kv, locks: null, channel: false, debounceMs: 1 });
      await p0.open();
      p0.close();
      await rawPut(name, "kv", JSON.parse(ACCOUNT_R6_RAW), "doc");
      await rawPut(name, "kv", { rev: 3, savedAt: "2026-11-15T00:00:00.000Z", writer: "old", docVersion: 1 }, "meta");
      setThinBaseline(null);
      enableThinPage(async () => map);
      const p = new Persistence({ dbName: name, kv, locks: null, channel: false, debounceMs: 1 });
      await p.open();
      await p.acquireWriter();
      const t0 = performance.now();
      const loaded = await p.loadInitial();
      const loadMs = performance.now() - t0;
      expect(loaded.upgrade?.legacy).toBeDefined();
      checkUpgrade(accountR6Doc(), loaded.doc!, map);
      p.attach(() => loaded.doc!);
      const t1 = performance.now();
      await p.flush();
      const saveMs = performance.now() - t1;
      const rec = (await rawGet(name, "kv", "doc")) as StoredDoc;
      expect(rec.version).toBe(THIN_VERSION);
      expect((await rawGet(name, "kv", "meta")) as object).toMatchObject({ docVersion: THIN_VERSION, mapRelease: map.header.release, mapHash: map.header.hash });
      console.log(`起動（地図の読み込みと組み立て・引き上げ・安全用バックアップを含む）${loadMs.toFixed(0)} ms・最初の保存 ${saveMs.toFixed(0)} ms・本体 ${JSON.stringify(rec).length.toLocaleString()} 文字`);
      p.close();
    },
    SLOW,
  );
});
