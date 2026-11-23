// P2 の見直しの直し（data-2・R3・R4・R5・R8）
import { beforeAll, describe, expect, it } from "vitest";
import { deepText } from "../../src/app/deepState";
import { hiddenCountText } from "../../src/canvas/draw";
import { analyze, compileMap, overview } from "../../src/deepmap/core";
import type { MapData } from "../../src/deepmap/mapData";
import { manVs, manVsRange } from "../../src/deepmap/views/format";
import { moveDetailVM, overviewVM } from "../../src/deepmap/views/model";
import { decidedTable, signFlipped } from "../../src/model/releaseNotes";
import { headlineOf, shownManOf } from "../../src/model/impactText";
import { loadQSmall } from "./helpers/qSmall";

let map: MapData;
beforeAll(async () => {
  map = await loadQSmall();
});

describe("差の向きの入れ替わり（data-2）", () => {
  it("0 になった・0 から動いたは、向きの入れ替わりに数えない", () => {
    expect(signFlipped(-3, 0)).toBe(false);
    expect(signFlipped(0, -2)).toBe(false);
    expect(signFlipped(4, 0)).toBe(false);
    expect(signFlipped(-3, 2)).toBe(true);
    expect(signFlipped(3, -2)).toBe(true);
    expect(signFlipped(0.2, -0.3)).toBe(false);
    const before = new Map([
      ["r.a.x", -3],
      ["r.a.b", 0],
      ["r.a.y", 0],
    ]);
    const sib = [
      { key: "r.a.x", delta: 0 },
      { key: "r.a.y", delta: -2 },
      { key: "r.a.b", delta: 1 },
    ];
    const rows = decidedTable(
      [
        { from: "r.a.x", to: "r.a.x", status: "active" },
        { from: "r.a.y", to: "r.a.y", status: "dropped" },
      ],
      before,
      (k) => ({ delta: sib.find((s) => s.key === k)!.delta, siblings: sib }),
    );
    expect(rows.every((r) => !r.signChanged)).toBe(true);
  });
});

describe("差は出した数どうしの差（R5）", () => {
  it("横に出す合計どうしの差と同じ数", () => {
    expect(manVs(1537.4, 1502.5)).toBe("+34 万円");
    expect(manVsRange(1534.6, 1809.4, 1502.5)).toBe("+32〜+306 万円");
    expect(manVs(4.14, 2.36)).toBe("+1.7 万円");
    const h = headlineOf({ value: 1737.4, statusQuo: 1502.5, best: null, horizon: 36, picks: true, scenario: null });
    expect(h?.sub).toBe("ずっと今のままなら 1,503 万円（差 +234 万円）");
    expect(shownManOf(-4.06)).toBe(-4.1);
    expect(shownManOf(12_345.6)).toBe(12_000);
  });
});

describe("アプリの文章は画面と同じ計算で書く（R4）", () => {
  it("年収 480 では「年収 360 万円の見積もり」とぼかさない", () => {
    expect(map.header.annual).not.toBe(480);
    const a = analyze(compileMap(map), 480, {});
    const t = deepText(map, 480, a);
    const plain = deepText(map, 480);
    const hedge = /年収 [0-9,]+ 万円の見積もりで一番の手|地図を作った年収の見積もり/;
    let hedged = 0;
    let plainHedged = 0;
    for (let i = 0; i < Math.min(map.n, 600); i++) {
      if (hedge.test(t.body(i))) hedged++;
      if (hedge.test(plain.body(i))) plainHedged++;
    }
    expect(plainHedged).toBeGreaterThan(0);
    expect(hedged).toBe(0);
    expect(deepText(map, 480, a)).toBe(t);
  });
});

describe("手の名前は見取り図と手の画面で同じ（R3）", () => {
  it("名前の元を渡すと、手の画面の見出しも同じ名前", () => {
    const a = analyze(compileMap(map), 360, {});
    const ov = overview(a);
    const name = (f: number) => `カード ${f}`;
    const rows = overviewVM(a, ov, { name }).rows;
    const mv = ov.moves.find((m) => !m.isBase)!;
    const d = moveDetailVM(a, mv.node, ov, { name });
    expect(d.row.name).toBe(`カード ${mv.node}`);
    expect(rows.find((r) => r.name === d.row.name)).toBeTruthy();
  });
});

describe("たたんだ先の数の札（R8）", () => {
  it("3 桁ごとに区切る", () => {
    expect(hiddenCountText(1231)).toBe("+1,231");
    expect(hiddenCountText(56987)).toBe("+56,987");
    expect(hiddenCountText(7)).toBe("+7");
  });
});
