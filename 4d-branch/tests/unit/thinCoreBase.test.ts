// 保存の基準を、初めて読んだ記録の基準（ずらし・プロジェクトとシナリオの読み替え）を当てて組み立てる（src/persist/thinMap.ts の coreOf。
// 見直し perf-6: その記録を読むたびに 7.7 万枚を写さない）。組み立て方が違っても答えは同じ: 同じ地図の 2 つの読み手で、片方は
// アカウントの形の記録を初めに読み（基準を当てて組み立てる）、片方は新しい文書を初めに書く（何も当てない）。どちらでも、
// 読んだ文書・書いた形・別の基準の写し（thinBaselineDoc）・基準の文書の指紋・版 6 からの引き上げの口（pageMapAccess）が同じ
import { beforeAll, describe, expect, it } from "vitest";
import type { MapData } from "../../src/deepmap/mapData";
import { decodeBundle } from "../../src/demo/impactBundle";
import type { DocData } from "../../src/model/types";
import { decodeStored, setThinBaseline, thinBaseline, thinBaselineDoc, toStored, type StoredDoc } from "../../src/persist/codec";
import { pageMapAccess } from "../../src/persist/thinMap";
import { Store } from "../../src/store/store";
import { Q_SMALL_B64 } from "./helpers/qSmall";
import { accountShape, randomEdits, seeded } from "./helpers/thinEdits";

const AT = "2026-11-19T03:04:05.006Z";
let record: StoredDoc;

/** アカウントの形の記録（ずらし・読み替え・編集のある物）を、別の地図の読み手で作る */
beforeAll(async () => {
  const map = await decodeBundle(Q_SMALL_B64);
  setThinBaseline(map);
  const R = seeded(31);
  const doc = accountShape(thinBaselineDoc({ at: AT }), R, { rate: 0.05, rootReId: true, dx: 340, dy: -120 });
  const store = new Store(doc);
  randomEdits(store, R, 40);
  record = JSON.parse(JSON.stringify(toStored(store.doc))) as StoredDoc;
  const s = record.maps![0]!;
  expect(s.dx !== 0 || s.dy !== 0).toBe(true);
});

/** 新しい地図の読み手で、first を初めにしてから、同じ確かめをして結果を返す */
async function observe(first: "record" | "fresh"): Promise<Record<string, string>> {
  const map: MapData = await decodeBundle(Q_SMALL_B64);
  setThinBaseline(map);
  const out: Record<string, string> = {};
  if (first === "record") out.decoded = JSON.stringify(decodeStored(JSON.parse(JSON.stringify(record))).doc);
  else toStored(thinBaselineDoc({ at: AT }));
  const doc: DocData = decodeStored(JSON.parse(JSON.stringify(record))).doc;
  out.decoded2 = JSON.stringify(doc);
  out.encoded = JSON.stringify(toStored(doc));
  out.fresh = JSON.stringify(thinBaselineDoc({ at: AT }));
  out.shifted = JSON.stringify(thinBaselineDoc({ at: AT, dx: 50, dy: 7 }));
  out.digest = thinBaseline()!.digest;
  const pa = pageMapAccess(null)!;
  out.access = JSON.stringify({ rootX: pa.rootX, rootY: pa.rootY, p: [1, 2, 3, pa.n - 1].map((i) => pa.projectIdsOf(i)), v: pa.view({ at: AT, dx: 0, dy: 0, pmap: {}, smap: {} }).nodes.slice(0, 40) });
  return out;
}

describe("初めて読んだ記録の基準を当てて組み立てた保存の基準", () => {
  it("読んだ文書・書いた形・別の基準の写し・指紋・引き上げの口が、何も当てずに組み立てたときと同じ", async () => {
    const a = await observe("record");
    const b = await observe("fresh");
    expect(a.decoded).toBe(b.decoded2);
    for (const k of ["decoded2", "encoded", "fresh", "shifted", "digest", "access"]) expect(a[k], k).toBe(b[k]);
  });
});
