// まとめて開く（作業メモ bulk/design.md §5・§9）を 8 万枚の地図で確かめる。遅いので、環境変数 IMPACT_Q_FULL（impact-q.b64 を置いた場所）が
// あるときだけ動く（npm run test:slow）。
//   1) 同じ時期まで（D）の 12 の時期の数が、時期ごとに openUntil で数えた物と同じ。12 の時期を 1 回なめて数えるのは 5 ms まで
//   2) 今日から 2027 年 11 月まで（約 2,600 枚）まとめて開く: 見えるカードは基準の作り（refView）と同じ・押す前の数と同じ。
//      開いて見え方を作り直すまでが Node で 60 ms まで（測った 30 ms の 2 倍。CI では IMPACT_PERF_SLACK 倍）。
//      開いたままカードを選ぶ・1 つ開くは測って書き出す（ブラウザの予算は tests/e2e/budget.mjs の selectBig・openBig）
import { beforeAll, describe, expect, it } from "vitest";
import { rememberMapDoc } from "../../src/app/futureCache";
import { DEFAULT_PREFS, UiState } from "../../src/app/uiState";
import { ViewModel } from "../../src/app/viewModel";
import { compileMap } from "../../src/deepmap/core";
import type { MapData } from "../../src/deepmap/mapData";
import { decodeBundle } from "../../src/demo/impactBundle";
import { buildQuarterDoc } from "../../src/demo/quarterDoc";
import { openUntil, quarterOpens, shapePlan } from "../../src/model/deepOpen";
import type { DocData } from "../../src/model/types";
import { Store } from "../../src/store/store";
import { envVar, nodeFs } from "./helpers/qSmall";
import { refView } from "./helpers/refView";

const DIR = envVar("IMPACT_Q_FULL");
const SLOW = 900_000;
const SLACK = Number(envVar("IMPACT_PERF_SLACK") ?? (envVar("CI") ? 2 : 1));
const best = (xs: number[]): number => Math.min(...xs);
const fmt = (xs: number[]): string => xs.map((x) => x.toFixed(1)).join(" / ");

function build(m: MapData): DocData {
  const doc = buildQuarterDoc(m, { version: m.header.hash, release: m.header.release, at: Date.UTC(2026, 10, 1), layout: "columns" });
  rememberMapDoc(doc, m);
  return doc;
}

describe.skipIf(!DIR)("まとめて開く: 8 万枚の地図（IMPACT_Q_FULL があるときだけ）", () => {
  let map: MapData;
  beforeAll(async () => {
    const fs = await nodeFs();
    map = await decodeBundle(new TextDecoder().decode(fs.readFileSync(`${DIR}/impact-q.b64`)));
  }, SLOW);

  it(
    "同じ時期まで（D）の 12 の時期の数は openUntil と同じで、1 回なめて 5 ms まで",
    () => {
      const times: number[] = [];
      let qs = quarterOpens(compileMap(map));
      for (let k = 0; k < 3; k++) {
        // 覚えた数を使わない（新しく組み直した物で数える。組み直しは測らない）
        const cm = compileMap(map);
        const t0 = performance.now();
        qs = quarterOpens(cm);
        times.push(performance.now() - t0);
        for (const q of qs) expect(q.count, `${q.months} か月`).toBe(openUntil(cm, 0, q.toEnd ? Infinity : q.months).count);
      }
      expect(qs.length).toBe(12);
      console.log(`同じ時期まで（12 の時期）の数え: ${fmt(times)} ms・${qs.map((q) => `${q.months}:${q.count}`).join(" ")}`);
      expect(best(times)).toBeLessThanOrEqual(5 * SLACK);
    },
    SLOW,
  );

  it(
    "今日から 2027 年 11 月までまとめて開く: 見えるカードは基準と同じ・押す前の数と同じ・Node で 60 ms まで",
    () => {
      const doc = build(map);
      const store = new Store(doc);
      const ui = new UiState(structuredClone(DEFAULT_PREFS));
      ui.persistPrefs = false;
      const vm = new ViewModel(store, ui);
      vm.narrow = () => false;
      vm.ensure();
      expect(vm.impact.active).toBe(true);
      expect(vm.index.nodeCount).toBe(map.n);
      const ctx = vm.deep.get()!;
      const cm = ctx.cm;
      const q12 = quarterOpens(cm).find((q) => q.months === 12)!;
      const t = { open: [] as number[], select: [] as number[], one: [] as number[], cards: [] as number[] };
      for (let round = 0; round < 3; round++) {
        vm.resetImpactOpen();
        ui.clearSelection();
        vm.ensure();
        const now = [...vm.impactOpenSet(ctx.root)].map((id) => ctx.indexOf(id)).filter((j) => j >= 0);
        const plan = shapePlan(cm, [{ i: 0, lim: 12 }], now);
        expect(plan.count).toBe(q12.count);
        const open = plan.open.map((j) => ctx.idOf(j));
        const close = plan.close.map((j) => ctx.idOf(j));
        let t0 = performance.now();
        const snap = vm.bulkOpen(open, close, { reveal: true });
        vm.ensure();
        t.open.push(performance.now() - t0);
        expect(snap).not.toBeNull();
        t.cards.push(vm.drawNodes.length);
        // 今日 + 時期までのカード（地図の外のカードは無い）
        expect(vm.drawNodes.length).toBe(1 + plan.count);
        if (round === 0) {
          const ref = refView(store.doc, ui, false);
          expect(vm.drawNodes).toEqual(ref.drawNodes);
        }
        // 開いたまま選ぶ・1 つ開く（測って書き出す）
        const cards = vm.drawNodes.filter((id) => vm.inImpact(id));
        const pickId = cards[(round * 97 + 31) % cards.length]!;
        t0 = performance.now();
        ui.select([pickId]);
        vm.ensure();
        t.select.push(performance.now() - t0);
        const closed = cards.filter((id) => vm.isCollapsed(id));
        const c = closed[(round * 13 + 7) % closed.length]!;
        t0 = performance.now();
        vm.setImpactOpen([c], [], { reveal: true });
        vm.ensure();
        t.one.push(performance.now() - t0);
        // 元に戻す（開いた 1 つの後なので戻さない）
        expect(vm.restoreOpen(snap!)).toBe(false);
      }
      console.log(`まとめて開く（2027 年 11 月まで・${t.cards.join(" / ")} 枚）: 開く ${fmt(t.open)} ms・開いたまま選ぶ ${fmt(t.select)} ms・開いたまま 1 つ開く ${fmt(t.one)} ms`);
      expect(best(t.open)).toBeLessThanOrEqual(60 * SLACK);
    },
    SLOW,
  );
});
