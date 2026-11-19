// 8 万枚の木（3 か月ごとの地図の本番の形）の同梱データ: 読み手がどのノードのどの問いにも fromDevTree() と同じ答え・64 ビットの ID が重ならない・
// アプリと同じ値（年収 360・540）・決まった並び・大きさ。遅いので、環境変数 IMPACT_Q_FULL があるときだけ動く（既定のテストは小さい木。見直し gaps-4）。
//   IMPACT_Q_FULL=<場所> npx vitest run tests/unit/impactBundleQFull.test.ts
//   <場所> には生成の書き出し（node scripts/impact/q/run.mjs --out <場所>/q-tree.json --bundle <場所>/impact-q.b64 …）の
//   impact-q.b64 と q-tree.json.gz を置く（--record <場所>/impact-release.json があれば、その版の記録とも比べる）
import { beforeAll, describe, expect, it } from "vitest";
import { encodeMap } from "../../scripts/impact/q/bundle";
import { appParity, checkIds, checkSizes, compareMaps, consistencyOfMap, forksByFirstMove } from "../../scripts/impact/q/check";
import { fnv64x36Bytes } from "../../src/demo/impact";
import { base64ToBytes, decodeBundle, decodeBundleBytes } from "../../src/demo/impactBundle";
import { gunzipSync } from "../../src/demo/inflate";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";
import type { DevTree, MapData } from "../../src/deepmap/mapData";
import { envVar, gunzipStream, nodeFs, readGzJson } from "./helpers/qSmall";

const DIR = envVar("IMPACT_Q_FULL");
const SLOW = 180_000;

describe.skipIf(!DIR)("8 万枚の木の同梱データ（IMPACT_Q_FULL があるときだけ）", () => {
  let b64: string;
  let gz: Uint8Array;
  let stream: Uint8Array;
  let dev: DevTree;
  let map: MapData;
  let msDecode: number;
  beforeAll(async () => {
    const fs = await nodeFs();
    b64 = new TextDecoder().decode(fs.readFileSync(`${DIR}/impact-q.b64`));
    gz = base64ToBytes(b64);
    stream = await gunzipStream(gz);
    dev = await readGzJson<DevTree>(`${DIR}/q-tree.json.gz`);
    const t0 = performance.now();
    map = await decodeBundle(b64);
    msDecode = performance.now() - t0;
  }, SLOW);

  it(
    "読み手は、どのノードのどの問いにも fromDevTree() と同じ答え（全ノード・全部の問い。小さな伸長でも同じ）",
    () => {
      expect(map.n).toBeGreaterThan(50_000);
      expect(map.n).toBeLessThanOrEqual(90_000);
      expect(compareMaps(fromDevTree(dev), map)).toEqual([]);
      const raw = gunzipSync(gz);
      expect(raw.length === stream.length && raw.every((x, i) => x === stream[i])).toBe(true);
      expect(compareMaps(map, decodeBundleBytes(raw))).toEqual([]);
      console.log(`8 万枚の木: ${map.n} 枚・decodeBundle ${msDecode.toFixed(0)} ms`);
    },
    SLOW,
  );

  it(
    "64 ビットの ID（ノード・線）は 1 つも重ならない",
    () => {
      expect(checkIds(map)).toEqual({ fails: [], nodes: map.n, edges: map.n - 1 });
    },
    SLOW,
  );

  it(
    "中身の指紋・決まった並び・大きさ・版の記録",
    async () => {
      expect(map.header.hash).toBe(fnv64x36Bytes(stream));
      expect(dev.header.hash).toBe(map.header.hash);
      const again = encodeMap(map);
      expect(again.length === stream.length && again.every((x, i) => x === stream[i])).toBe(true);
      expect(checkSizes({ raw: stream.length, gzip: gz.length, base64: b64.length })).toEqual([]);
      const fs = await nodeFs();
      if (fs.existsSync(`${DIR}/impact-release.json`)) {
        // 版の記録（基準の文書の指紋 digest は、指紋を書くようになった生成の記録だけにある。あれば同じ組み立ての指紋: quarterDocFull.test.ts）
        const rec = JSON.parse(new TextDecoder().decode(fs.readFileSync(`${DIR}/impact-release.json`))) as { release: number; hash: string; anchor: string; digest?: string };
        const { digest: _digest, ...rest } = rec;
        expect(rest).toEqual({ release: map.header.release, hash: map.header.hash, anchor: map.header.anchor });
      }
    },
    SLOW,
  );

  it(
    "アプリと同じ値（年収 360・540 で |差| ≤ 1e-9・一番の手も同じ）・一貫性（年収 360）・最初の手ごとの分かれ道",
    () => {
      const { parities, fails } = appParity(map, [360, 540]);
      expect(fails).toEqual([]);
      for (const p of parities) expect([p.alts, p.bestMismatch]).toEqual([map.header.counts.options, 0]);
      expect(consistencyOfMap(map, 360).intoStub).toBe(0);
      for (const m of forksByFirstMove(map)) expect(Math.abs(m.forks - 2000), m.kind).toBeLessThanOrEqual(40);
    },
    SLOW,
  );
});
