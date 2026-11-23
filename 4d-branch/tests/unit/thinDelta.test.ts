// 変わった所だけ書く自動保存（src/persist/thinMap.ts の watchThinWrites・encodeDelta。作業メモ SPEC v1 §7.1 の 10・見直し perf-10）:
// 本物のストアに乱数の編集（状態・題名・やること・見込み・利用者のカードと線・地図のカードを消す・付け替え・プロジェクトとシナリオ・
// 複製・元に戻す・やり直す…）を 1 つずつ当て、そのたびに、書いた所を知らせた文書の薄い形が、全部を見て書いた物（encodeThinFull）と
// 文字まで同じ（鍵の順も）。全部の入れ替え・元に戻す（入れ替え）・アカウントの形の文書・知らせを外した後も同じ。
// 変わった所だけで書けた回が実際にある（覚えを使っている）ことも確かめる
import { beforeAll, describe, expect, it } from "vitest";
import type { MapData } from "../../src/deepmap/mapData";
import type { DocData } from "../../src/model/types";
import { decodeStored, encodeStored, setThinBaseline, thinBaselineDoc, watchThinWrites } from "../../src/persist/codec";
import { encodeThinFull } from "../../src/persist/thinMap";
import { Store } from "../../src/store/store";
import { loadQSmall } from "./helpers/qSmall";
import { accountShape, applyEdit, EDIT_KINDS, seeded } from "./helpers/thinEdits";

const AT = "2026-11-19T03:04:05.006Z";
let qMap: MapData;

beforeAll(async () => {
  qMap = await loadQSmall();
});

/** 書いた所を知らせた文書と、全部を見て書いた物が同じか（compared: 比べたカードの数。少なければ変わった所だけで書けた） */
function same(store: Store): { compared: number } {
  const fast = encodeStored(store.doc);
  const full = encodeThinFull(store.doc);
  expect(full).not.toBeNull();
  const A = JSON.stringify(fast.stored);
  const B = JSON.stringify(full!.stored);
  if (A !== B) {
    let i = 0;
    while (i < A.length && A[i] === B[i]) i++;
    // 違う所を見せる（全部の文字列を比べた結果は長すぎて読めない）
    expect(A.slice(Math.max(0, i - 200), i + 200)).toBe(B.slice(Math.max(0, i - 200), i + 200));
  }
  expect(A).toBe(B);
  const { compared: _a, ...a } = fast.stats!;
  const { compared: _b, ...b } = full!.stats;
  expect(a).toEqual(b);
  return { compared: fast.stats!.compared };
}

function run(doc: DocData, seed: number, steps: number): { delta: number } {
  const store = new Store(doc);
  const off = watchThinWrites(store);
  const R = seeded(seed);
  const once = new Set<(typeof EDIT_KINDS)[number]>();
  let delta = 0;
  try {
    same(store);
    for (let k = 0; k < steps; k++) {
      const kind = EDIT_KINDS[Math.floor(R() * EDIT_KINDS.length)]!;
      applyEdit(store, R, kind, once);
      // ときどき 2 つ続けて当ててから書く（自動保存は少し待ってから書く）
      if (R() < 0.3) applyEdit(store, R, EDIT_KINDS[Math.floor(R() * EDIT_KINDS.length)]!, once);
      const r = same(store);
      if (r.compared <= 4) delta++;
    }
    // 全部の入れ替え（取り込み）と、その元に戻す・やり直す
    const copy = decodeStored(JSON.parse(JSON.stringify(encodeThinFull(store.doc)!.stored))).doc;
    store.replaceDoc(copy, "取り込み");
    same(store);
    store.undo();
    same(store);
    store.redo();
    same(store);
    for (let k = 0; k < 10; k++) {
      applyEdit(store, R, EDIT_KINDS[Math.floor(R() * EDIT_KINDS.length)]!, once);
      same(store);
    }
  } finally {
    off();
  }
  // 知らせを外した後は、いつも全部を見る（同じ答え）
  applyEdit(store, R, "status", once);
  same(store);
  return { delta };
}

describe("変わった所だけ書く自動保存", () => {
  it("新しい地図の文書: どの編集の後も、全部を見て書いた物と文字まで同じ（変わった所だけで書けた回がある）", () => {
    setThinBaseline(qMap);
    let delta = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) delta += run(thinBaselineDoc({ at: AT }), seed, 80).delta;
    expect(delta).toBeGreaterThan(200);
  });

  it("アカウントの形の文書（ID・プロジェクト・時刻・位置を振り直した物）: 同じ", () => {
    setThinBaseline(qMap);
    for (const seed of [11, 12, 13, 14]) {
      const R = seeded(seed);
      const doc = accountShape(thinBaselineDoc({ at: AT }), R, { rate: 0.05, rootReId: true, dx: 120, dy: -40 });
      expect(run(decodeStored(JSON.parse(JSON.stringify(encodeThinFull(doc)!.stored))).doc, seed, 50).delta).toBeGreaterThan(20);
    }
  });
});
