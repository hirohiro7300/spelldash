// P3（画面の速さの組）で直した P2 の確かめの小さな指摘: F1（同じ今日の手に 2 つの名前）・R6（書き換えた見込みを本文が言わない）
import { beforeAll, describe, expect, it } from "vitest";
import { cardWithDocOdds } from "../../src/app/deepState";
import { rememberMapDoc } from "../../src/app/futureCache";
import { DEFAULT_PREFS, UiState } from "../../src/app/uiState";
import { ViewModel } from "../../src/app/viewModel";
import { hiddenCountText } from "../../src/canvas/draw";
import { compileMap, type CompiledMap } from "../../src/deepmap/core";
import { ROLE_A } from "../../src/deepmap/core/compile";
import type { MapData } from "../../src/deepmap/mapData";
import { buildQuarterDoc } from "../../src/demo/quarterDoc";
import { edgeProb } from "../../src/model/forecast";
import type { DocData } from "../../src/model/types";
import { Store } from "../../src/store/store";
import { loadQSmall } from "./helpers/qSmall";

let map: MapData;
let cm: CompiledMap;

beforeAll(async () => {
  map = await loadQSmall();
  cm = compileMap(map);
});

function setup() {
  const doc: DocData = buildQuarterDoc(map, { version: map.header.hash, release: map.header.release, at: Date.UTC(2026, 10, 1), layout: "columns" });
  rememberMapDoc(doc, map);
  const store = new Store(doc);
  const ui = new UiState(structuredClone(DEFAULT_PREFS));
  ui.persistPrefs = false;
  const vm = new ViewModel(store, ui);
  vm.narrow = () => false;
  return { store, vm };
}

/** 割の言い方（src/demo/compose/text.ts の wari と同じ。差し込みの印は外した形） */
function wari(p: number): string {
  const t = Math.round(p * 100);
  const w = Math.floor(t / 10);
  const b = t % 10;
  if (!w) return b >= 7 ? "1 割弱" : "1 割未満";
  return b ? `${w} 割 ${b} 分` : `${w} 割`;
}

describe("本文の今日の手の名前は、見取り図と同じカードの題（F1）", () => {
  it("「今日の『…』」で言う手の名前は、どれかの今日の手のカードの題", () => {
    const { vm } = setup();
    const ctx = vm.deep.get()!;
    const t = ctx.text();
    const titles = new Set(Array.from(cm.firstMoves, (f) => t.title(f)));
    titles.add("今のまま");
    let seen = 0;
    for (let i = 0; i < Math.min(cm.n, 4000); i++) {
      for (const m of t.body(i).matchAll(/今日の『([^』]+)』/g)) {
        seen++;
        expect(titles.has(m[1]!), `カード ${i}: 『${m[1]}』は今日の手の題でない（${[...titles].join("・")}）`).toBe(true);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe("書き換えた見込みで本文を組み立てる（R6）", () => {
  it("書き換えていなければ地図の本文のまま（null）。結果の線の見込みを書き換えると、本文はつながりの数えている見込みで言う", () => {
    const { store, vm } = setup();
    // 結果が 2 つ以上あり、本文が結果の見込みを割で言う手
    const ctx0 = vm.deep.get()!;
    let a = -1;
    for (let i = 1; i < cm.n && a < 0; i++) {
      if (cm.role[i] !== ROLE_A || map.childCount(i) < 2) continue;
      const o = map.child(i, 0);
      const p = map.p(o);
      if (p <= 5 || p >= 95) continue;
      if (ctx0.text().body(i).includes(`（${wari(p / 100)}）`)) a = i;
    }
    expect(a).toBeGreaterThan(0);
    expect(cardWithDocOdds(ctx0, store.doc, vm.index.out, a)).toBeNull();

    const o = map.child(a, 0);
    const pid = ctx0.idOf(a);
    const oid = ctx0.idOf(o);
    const eid = vm.index.out.get(pid)!.find((x) => store.doc.edges[x]!.target === oid)!;
    const e0 = store.doc.edges[eid]!;
    expect(edgeProb(e0)).toBe(map.p(o));
    // つながりで見込みを書き換える（兄弟の合計は 100% でなくなる: 数えている見込みは割った物）
    const next = map.p(o) >= 50 ? map.p(o) - 30 : map.p(o) + 30;
    store.transact("見込み", (tx) => tx.updateEdge(eid, { meta: { ...e0.meta, prob: next } }));
    const ctx = vm.deep.get()!;
    expect(ctx.edited).toBe(true);
    let sum = 0;
    for (let k = 0; k < map.childCount(a); k++) sum += map.child(a, k) === o ? next : map.p(map.child(a, k));
    const counted = Math.round((next / sum) * 100);
    const card = cardWithDocOdds(ctx, store.doc, vm.index.out, a);
    expect(card).not.toBeNull();
    expect(card!.body).toContain(`（${wari(counted / 100)}）`);
    expect(card!.body).not.toContain(`『${ctx.text().title(o)}』（${wari(map.p(o) / 100)}）`);
  });
});

describe("たたんだ先の数の札は書式を使い回しても同じ（perf-8）", () => {
  it("3 桁ごとに区切る", () => {
    expect(hiddenCountText(1231)).toBe("+1,231");
    expect(hiddenCountText(77735)).toBe("+77,735");
    expect(hiddenCountText(5)).toBe("+5");
  });
});
