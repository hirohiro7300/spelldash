// 見直しの直し（user-2・user-3・user-8・user-9・perf-8・equiv-4）のうち、画面の外で確かめられる物を、小さい木（q-small）で:
//   時間で区切って開いた後の並びの行の数（deepHorizons の rows）が、たどって数えた物と同じ・縦に長すぎる区切りの上限（user-8）
//   写した地図の文章の見分けと外し方（copiedPrefix・withoutCopy: user-3）
//   目印の文を幅に収める（clipToWidth: user-9）
//   空いた時間の 1 歩ずつの仕事が、空いた時間の内に収まる（idleSteps: perf-8）
//   道の画面・行き先の名前はカードの題名（書き換えればその名前。「—」・空だけ組み立てた名前: equiv-4）
//   3 か月ごとの地図の「3 年でやる価値が大きい手」は見取り図と同じ k(fam)（user-2）
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { rememberMapDoc } from "../../src/app/futureCache";
import { idleSteps } from "../../src/app/idle";
import { DEFAULT_PREFS, UiState } from "../../src/app/uiState";
import { ViewModel } from "../../src/app/viewModel";
import { clipToWidth } from "../../src/canvas/CanvasView";
import { compileMap, worthOf, type CompiledMap } from "../../src/deepmap/core";
import type { MapData } from "../../src/deepmap/mapData";
import { buildQuarterDoc } from "../../src/demo/quarterDoc";
import { DEEP_OPEN_ROWS, deepHorizons, openUntil } from "../../src/model/deepOpen";
import { cachedWorthRanking } from "../../src/model/impactRank";
import type { DocData } from "../../src/model/types";
import { Store } from "../../src/store/store";
import { copiedPrefix, withoutCopy } from "../../src/ui/deepPanel";
import { loadQSmall } from "./helpers/qSmall";

let map: MapData;
let cm: CompiledMap;

beforeAll(async () => {
  map = await loadQSmall();
  cm = compileMap(map);
});

function setup(): { store: Store; vm: ViewModel; doc: DocData } {
  const doc = buildQuarterDoc(map, { version: map.header.hash, release: map.header.release, at: Date.UTC(2026, 10, 1), layout: "columns" });
  rememberMapDoc(doc, map);
  const store = new Store(doc);
  const ui = new UiState(structuredClone(DEFAULT_PREFS));
  ui.persistPrefs = false;
  const vm = new ViewModel(store, ui);
  vm.narrow = () => false;
  vm.ensure();
  return { store, vm, doc };
}

describe("時間で区切って開いた後の並びの行（見直し user-8）", () => {
  it("rows は、開いた先で先を開いていないカードの数（たどって数えた物と同じ）。今日・今日の手・深いカード", () => {
    const cards = [0, ...Array.from({ length: cm.kidOff[1]! - cm.kidOff[0]! }, (_, k) => cm.kids[cm.kidOff[0]! + k]!), Math.floor(cm.n / 3), Math.floor(cm.n / 2)];
    for (const i of cards) {
      for (const h of deepHorizons(cm, i)) {
        const { open } = openUntil(cm, i, h.toEnd ? Infinity : h.limit);
        const opened = new Set(open);
        let rows = 0;
        for (let j = i + 1; j < i + cm.size[i]!; j++) if (opened.has(cm.parent[j]!) && !opened.has(j)) rows++;
        expect([i, h.months, h.rows]).toEqual([i, h.months, rows]);
      }
    }
    // 行は枚数より少なく、上限は手ごとの 1 年先（版 7 で 80〜180 行）を開ける大きさ
    for (const h of deepHorizons(cm, 0)) expect(h.rows).toBeLessThanOrEqual(h.count);
    expect(DEEP_OPEN_ROWS).toBeGreaterThanOrEqual(200);
  });
});

describe("写した地図の文章（見直し user-3）", () => {
  it("メモの頭に写しが書き換えずにあるときだけ写しと見て、その写しだけを外す（自分で書いた所は残す）", () => {
    const composed = "数の行\n組み立てた本文。";
    expect(copiedPrefix("自分で書いたメモ", "n1", composed)).toBeNull();
    expect(copiedPrefix("", "n1", composed)).toBeNull();
    const note = `${composed}\n\n上司に聞く。\n  字下げした行`;
    expect(copiedPrefix(note, "n1", composed)).toBe(composed);
    expect(withoutCopy(note, composed)).toBe("上司に聞く。\n  字下げした行");
    expect(withoutCopy(composed, composed)).toBe("");
    // 写しの中を書き換えた: もう写しではない（自分の文章として残す）
    expect(copiedPrefix(`数の行\n書き換えた本文。\n\n上司に聞く。`, "n1", composed)).toBeNull();
  });
});

describe("目印の文を幅に収める（見直し user-9）", () => {
  // 1 文字 10 px の測り方
  const ctx = { measureText: (t: string) => ({ width: Array.from(t).length * 10 }) } as unknown as CanvasRenderingContext2D;
  it("入れば元のまま、入らなければ後ろを「…」に。1 文字も入らなければ空", () => {
    expect(clipToWidth(ctx, "社内で担当を広げる", 200)).toBe("社内で担当を広げる");
    expect(clipToWidth(ctx, "社内で担当を広げる", 50)).toBe("社内で担…");
    expect(clipToWidth(ctx, "社内で担当を広げる", 15)).toBe("");
    for (let w = 20; w < 100; w += 7) expect(Array.from(clipToWidth(ctx, "社内で担当を広げる", w)).length * 10).toBeLessThanOrEqual(w);
  });
});

describe("空いた時間の 1 歩ずつの仕事（見直し perf-8）", () => {
  const g = globalThis as { requestIdleCallback?: unknown };
  afterEach(() => {
    delete g.requestIdleCallback;
    vi.useRealTimers();
  });
  it("空いた時間の残りが直前の 1 歩（と 5 ms）より短ければ次の空いた時間へ。1 回に少なくとも 1 歩。やめる印でやめる", () => {
    const calls: Array<() => void> = [];
    let remaining = 0;
    g.requestIdleCallback = (cb: (d: { timeRemaining(): number }) => void) => {
      calls.push(() => cb({ timeRemaining: () => remaining }));
      return calls.length;
    };
    let n = 0;
    let stop = false;
    idleSteps(
      () => {
        n++;
        remaining -= 4;
        return n >= 20;
      },
      () => !stop,
    );
    // 空いた時間が 16 ms: 4 ms の歩を 3 つ（残り 12 → 8 → 4 で止める）
    remaining = 16;
    calls.shift()!();
    expect(n).toBe(3);
    // 空いた時間が無い（時間切れ）: 1 歩だけ
    remaining = 0;
    calls.shift()!();
    expect(n).toBe(4);
    // やめる
    stop = true;
    remaining = 50;
    calls.shift()!();
    expect(n).toBe(4);
    expect(calls.length).toBe(0);
  });
});

describe("道の画面の名前はカードの題名（見直し equiv-4）", () => {
  it("組み立てたままの文書・題名を書き換えた後で、道の行の名前がカードの題名と同じ。「—」・空だけ組み立てた名前", () => {
    const { store, vm } = setup();
    const ctx = vm.deep.get()!;
    const text = ctx.text();
    let checked = 0;
    let placeholder = 0;
    for (let i = 0; i < cm.n; i += 7) {
      const n = store.doc.nodes[ctx.idOf(i)]!;
      const t = n.title.trim();
      if (!t || /^[—―\-－]+$/.test(t)) {
        placeholder++;
        expect(text.title(i).length).toBeGreaterThan(1);
        continue;
      }
      expect([i, text.title(i)]).toEqual([i, t]);
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
    // 書き換えた題名がそのまま出る（計算は変わらないので、同じ画面の材料でも新しい題名）
    const i = cm.kids[cm.kidOff[0]!]!;
    const id = ctx.idOf(i);
    store.transact("題名", (tx) => tx.updateNode(id, { title: "書き換えた題名" }));
    expect(vm.deep.get()!.text().title(i)).toBe("書き換えた題名");
    expect(placeholder).toBeGreaterThanOrEqual(0);
  });
});

describe("3 か月ごとの地図のやる価値の順位は見取り図と同じ k（見直し user-2）", () => {
  it("種類ごとの差は生成の見積もり（never._all − never[fam]）。逆にたどる計算はしない", () => {
    const { store, vm } = setup();
    const ctx = vm.deep.get()!;
    const a = ctx.analysis();
    const imp = vm.impact;
    const rank = cachedWorthRanking(store.doc, imp, vm.forecast, (fam) => worthOf(a, fam));
    expect(rank.worth.length).toBeGreaterThan(0);
    for (const w of rank.worth) expect(w.k).toBeCloseTo(worthOf(a, w.fam)!, 9);
    // 並びは大きい順
    for (let k = 1; k < rank.worth.length; k++) expect(rank.worth[k - 1]!.k).toBeGreaterThanOrEqual(rank.worth[k]!.k);
  });
});

describe("選び直した後の見取り図の計算を空いた時間に先に済ませる（見直し perf-6）", () => {
  const g = globalThis as { requestIdleCallback?: unknown };
  afterEach(() => {
    delete g.requestIdleCallback;
  });
  it("手を選んだ後、空いた時間に見取り図の計算と数を作り、概要に戻ったときはそれを使う（題名の 1 文字では作り直さない）", () => {
    const calls: Array<() => void> = [];
    g.requestIdleCallback = (cb: (d: { timeRemaining(): number }) => void) => {
      calls.push(() => cb({ timeRemaining: () => 50 }));
      return calls.length;
    };
    const { store, vm } = setup();
    const imp = vm.impact;
    const alt = imp.decision.get(imp.root!)!.alts.find((x) => !imp.alt.get(x)!.isBase)!;
    store.transact("これにする", (tx) => tx.updateNode(alt, { status: "active" }));
    vm.deep.prewarmSoon();
    const internal = vm.deep as unknown as { calc: { a: unknown; ov: unknown } | null };
    // まだ空いた時間が来ていない: 作っていない
    expect(internal.calc?.a ?? null).toBeNull();
    while (calls.length) calls.shift()!();
    const ctx = vm.deep.get()!;
    expect(internal.calc!.a).not.toBeNull();
    expect(internal.calc!.ov).not.toBeNull();
    const a = ctx.analysis();
    const ov = ctx.overview();
    // 概要に戻る（同じ材料）: 同じ物
    expect(vm.deep.get()!.analysis()).toBe(a);
    expect(vm.deep.get()!.overview()).toBe(ov);
    // 題名の 1 文字: 先に済ませる仕事を頼んでも、同じ物のまま
    store.transact("題名", (tx) => tx.updateNode(alt, { title: "あ" }));
    vm.deep.prewarmSoon();
    while (calls.length) calls.shift()!();
    expect(vm.deep.get()!.analysis()).toBe(a);
  });
});
