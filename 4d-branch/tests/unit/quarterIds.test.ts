// 地図の番号ごとの ID の表（src/demo/quarterIds.ts。見直し perf-1・perf-6）: 同梱データの読み手の地図（鍵の区切りから数える）でも、
// 開発用の木の地図（鍵を読んで数える）でも、どの番号も impactNodeId64・impactEdgeId64(鍵) と同じ ID。表は地図ごとに 1 つ。
// ID → 番号の表は、どの ID も自分の番号を返す
import { describe, expect, it } from "vitest";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";
import type { MapData } from "../../src/deepmap/mapData";
import { fnv64x36, impactEdgeId64, impactNodeId64 } from "../../src/demo/impact";
import { quarterIdIndex, quarterIdTable } from "../../src/demo/quarterIds";
import { loadQSmall, loadQSmallDevTree } from "./helpers/qSmall";

function check(map: MapData): void {
  const t = quarterIdTable(map);
  expect(t).toBe(quarterIdTable(map));
  expect(t.node.length).toBe(map.n);
  for (let i = 0; i < map.n; i++) {
    const key = map.key(i);
    expect(t.keys[i]).toBe(key);
    expect(t.node[i]).toBe(impactNodeId64(key));
    expect(t.edge[i]).toBe(impactEdgeId64(key));
    expect(`${(t.h1[i]! >>> 0).toString(36).padStart(7, "0")}${(t.h2[i]! >>> 0).toString(36).padStart(7, "0")}`).toBe(fnv64x36(key));
  }
  const idx = quarterIdIndex(map);
  expect(idx.size).toBe(map.n);
  for (let i = 0; i < map.n; i += 7) expect(idx.get(t.node[i]!)).toBe(i);
}

describe("地図の番号ごとの ID の表", () => {
  it("同梱データの読み手の地図（鍵の区切りから数える）: どの番号も鍵の指紋の ID", async () => {
    const map = await loadQSmall();
    expect(typeof (map as { seg?: unknown }).seg).toBe("function");
    check(map);
  });

  it("開発用の木の地図（区切りを答えない: 鍵を読んで数える）: 同じ ID", async () => {
    const map = fromDevTree(await loadQSmallDevTree());
    expect((map as { seg?: unknown }).seg).toBeUndefined();
    check(map);
  });
});
