import { describe, expect, it } from "vitest";
import type { ImpactBundle } from "../../src/demo/impact";
import {
  analyze,
  compileMap,
  deltaBetween,
  destinations,
  fallbackText,
  familyMask,
  fanData,
  forkStrip,
  heatValues,
  kindKey,
  mostLikelyChain,
  overview,
  planView,
  quarterSpanText,
  refillNumbers,
  ROLE_A,
  runPass,
  scenarioMask,
  walkPath,
  worthOf,
  ymSpanText,
  ymText,
} from "../../src/deepmap/core";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";
import type { DevTree, MapData } from "../../src/deepmap/mapData";
import { appImpact, bundleToDevTree, close, compare, handTree, randomStatus, randomTree, statusArray, toBundle, type AppRun } from "./deepmapFixtures";

/**
 * 今日の同梱データ（1,533 枚の地図・v2）。凍結した写し（tests/fixtures/impact-r6.json）を先に使い、無ければ今の同梱データ。
 * どちらも無いか v2 でなければ飛ばす（同梱が新しい形に替わっても止まらない）
 */
const r6Files = import.meta.glob(["../fixtures/impact-r6.json", "../../src/demo/impact-data.json"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const r6 = ((): ImpactBundle | null => {
  for (const path of ["../fixtures/impact-r6.json", "../../src/demo/impact-data.json"]) {
    const raw = r6Files[path];
    if (!raw) continue;
    const b = JSON.parse(raw) as Partial<ImpactBundle>;
    if (b.v === 2 && Array.isArray(b.nodes) && b.check) return b as ImpactBundle;
  }
  return null;
})();

describe("計算の芯: 地図を組み直す", () => {
  const map = fromDevTree(handTree());
  const cm = compileMap(map);

  it("部分木は続いた番号で、深さ・今日の手・兄弟の順番・下の数が出る", () => {
    expect(cm.n).toBe(map.n);
    expect(cm.size[0]).toBe(cm.n);
    for (let i = 1; i < cm.n; i++) {
      const p = cm.parent[i]!;
      expect(i > p && i < p + cm.size[p]!).toBe(true);
      expect(cm.depth[i]).toBe(cm.depth[p]! + 1);
    }
    expect(Array.from(cm.firstMoves).map((f) => map.key(f))).toEqual(["r.ad_permside", "r.sd_grow", "r.fc_switch", "r.part", "r.ind_quit", "r.keep"]);
    const ap = cm.firstMoves[0]!;
    expect(cm.first[ap + 3]).toBe(ap);
    expect(cm.first[0]).toBe(-1);
    // 届け出て副業の先: 判断（手が 2 つ以上）は 全部可・全部可の顧客 1 社・SpellDash だけ・どちらも不可 の 4 つ
    expect(cm.nDec[ap]).toBe(4);
    // 出来事の分かれ: 届け出・副業の顧客・紹介・昇格・転職 の 5 つ
    expect(cm.nSplit[ap]).toBe(5);
    expect(cm.nSumEnd[ap]).toBe(3);
    // 手が 1 つだけの判断は判断に数えない
    const only = map.indexOfKey("r.keep.all.1sr.only");
    expect(cm.nDec[only]).toBe(0);
    expect(cm.rank[map.indexOfKey("r.sd_grow.all.1k")]).toBe(2);
  });

  it("月はアプリと同じく親より前にせず 36 に収め、遅れて始まる手は判断からの線に稼ぎが付く", () => {
    const iq = map.indexOfKey("r.ind_quit");
    expect(cm.month[iq]).toBe(1);
    expect(Array.from(cm.e.subarray(iq * 3, iq * 3 + 3))).toEqual([1, 0, -0.3]);
    const ap = map.indexOfKey("r.ad_permside");
    expect(Array.from(cm.e.subarray(ap * 3, ap * 3 + 3))).toEqual([0, 0, 0]);
    // % の合計が 99 でも割合の合計は 1
    const fs = map.indexOfKey("r.fc_switch");
    let sw = 0;
    for (let s = cm.kidOff[fs]!; s < cm.kidOff[fs + 1]!; s++) sw += cm.w[cm.kids[s]!]!;
    expect(sw).toBeCloseTo(1, 12);
    expect(cm.has).toEqual({ q: 6, mix: 1, cont: 1, never: true });
  });

  it("深さ優先の順でない番号・親子のおかしい地図は止める", () => {
    // 幅優先の順に並べ替えた同じ地図
    const order: number[] = [0];
    for (let k = 0; k < order.length; k++) for (let c = 0; c < map.childCount(order[k]!); c++) order.push(map.child(order[k]!, c));
    const inv = new Array<number>(map.n);
    order.forEach((old, nw) => (inv[old] = nw));
    const bfs = new Proxy(map, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv) as unknown;
        if (typeof v !== "function") return v;
        const f = v as (...args: number[]) => unknown;
        if (prop === "parent") return (i: number) => {
          const p = target.parent(order[i]!);
          return p < 0 ? -1 : inv[p]!;
        };
        if (prop === "child") return (i: number, k: number) => inv[target.child(order[i]!, k)]!;
        if (prop === "indexOfKey") return (k: string) => inv[target.indexOfKey(k)] ?? -1;
        return (i: number, ...rest: number[]) => f.call(target, order[i]!, ...rest);
      },
    }) as MapData;
    expect(() => compileMap(bfs)).toThrow(/深さ優先/);
    const bad: DevTree = { header: handTree().header, root: { k: "r", r: "r", m: 0, st: handTree().root.st, kids: [{ k: "r.x", r: "s", m: 3, st: handTree().root.st }] } };
    expect(() => compileMap(fromDevTree(bad))).toThrow(/役割/);
  });

  it("数だけ入れ直すと数の版が進み、形は作り直さない", () => {
    const t = handTree();
    const m2 = fromDevTree(t);
    const c2 = compileMap(m2);
    const a1 = analyze(c2, 360);
    // 今のままの 3 年の稼ぎを変える
    const leaf = t.root.kids!.find((k) => k.k === "r.keep")!.kids![0]!.kids!.find((k) => k.k === "r.keep.all.1k")!.kids![0]!.kids![0]!.kids![0]!;
    leaf.e = [31.6, 0, -9];
    refillNumbers(c2, fromDevTree(t));
    expect(c2.version).toEqual({ topology: 1, numbers: 2 });
    const a2 = analyze(c2, 360);
    expect(a2.vSQ! - a1.vSQ!).toBeCloseTo(30, 9);
    expect(() => refillNumbers(c2, fromDevTree(randomTree(1)))).toThrow(/形の違う/);
  });
});

describe("計算の芯: アプリの計算（computeImpact）と同じ答え", () => {
  const cases: Array<[string, () => DevTree]> = [
    ["手で作った地図", handTree],
    ["種 1 の地図", () => randomTree(1)],
    ["種 2 の地図", () => randomTree(2)],
    ["種 3 の地図", () => randomTree(3, 1500)],
  ];
  for (const [name, make] of cases) {
    it(`${name}: 年収 360・540 で値・差・選ぶ手・見込み・分布が 1e-9 まで同じ`, () => {
      const map = fromDevTree(make());
      const cm = compileMap(map);
      const bundle = toBundle(map);
      let doc: AppRun["doc"] | undefined;
      for (const annual of [360, 540]) {
        const app = appImpact(bundle, annual, { doc });
        doc = app.doc;
        const n = compare(map, analyze(cm, annual), app);
        expect(n.options).toBe(map.n > 0 ? Array.from({ length: cm.n }, (_, i) => i).filter((i) => cm.role[i] === ROLE_A).length : 0);
        expect(n.decisions).toBeGreaterThan(0);
      }
    });
  }

  for (const seed of [11, 12, 13]) {
    it(`種 ${seed} の地図: 選んだ手・見送った手・シナリオがあっても同じ答え`, () => {
      const map = fromDevTree(randomTree(seed, 1200));
      const cm = compileMap(map);
      const bundle = toBundle(map);
      const status = randomStatus(map, seed * 7);
      let doc: AppRun["doc"] | undefined;
      for (const [annual, scenario] of [
        [360, null],
        [540, "s_balance"],
        [360, "s_early"],
      ] as const) {
        const app = appImpact(bundle, annual, { status, scenario, doc });
        doc = app.doc;
        const a = analyze(cm, annual, { status: statusArray(cm, map, status), allowed: scenario ? scenarioMask(cm, scenario) : null });
        compare(map, a, app);
      }
    });
  }

  it("その種類の手を除いた計算（exclude）は、アプリの never(まとまり) の木の版と同じ", () => {
    for (const make of [handTree, () => randomTree(21, 1200)]) {
      const map = fromDevTree(make());
      const cm = compileMap(map);
      const bundle = toBundle(map);
      const status = randomStatus(map, 5);
      for (const annual of [360, 540]) {
        const app = appImpact(bundle, annual, { status });
        const opts = { status: statusArray(cm, map, status) };
        const a = analyze(cm, annual, opts);
        for (const fam of app.res.families()) {
          const nv = runPass(cm, a.money, { ...opts, exclude: familyMask(cm, fam) });
          close(a.vRoot !== null && nv.def[0] ? a.vRoot - nv.V[0]! : null, app.res.never(fam).k, `never ${fam}`);
        }
      }
    }
  });

  it.skipIf(!r6)("今日の同梱の地図（1,533 枚）: 同梱の確かめの数と、アプリの計算と同じ答え", () => {
    const b = r6!;
    const map = fromDevTree(bundleToDevTree(b));
    const cm = compileMap(map);
    for (const annual of [360, 540]) {
      const a = analyze(cm, annual);
      compare(map, a, appImpact(b, annual));
      if (annual === b.check.annual) {
        expect(a.vRoot!).toBeCloseTo(b.check.vRoot, 1);
        expect(a.vSQ!).toBeCloseTo(b.check.vSQ, 1);
        const base = Array.from(cm.firstMoves).find((f) => map.isBase(f))!;
        for (const f of cm.firstMoves) expect([kindKey(cm, f), deltaBetween(a.pi, f, base)!.d]).toEqual([kindKey(cm, f), expect.closeTo(b.check.rootDelta[kindKey(cm, f)]!, 1)]);
      }
    }
  });

  it("試しの converter は今日の同梱データを同じ形に戻す（アプリの数が同じ）", () => {
    if (!r6) return;
    const map = fromDevTree(bundleToDevTree(r6));
    const back = toBundle(map);
    const x = appImpact(r6, 360).res;
    const y = appImpact(back, 360).res;
    expect(y.vRoot).toBeCloseTo(x.vRoot!, 9);
    for (const [nid, info] of x.alt) close(y.alt.get(nid)?.delta, info.delta, `差 ${nid}`);
  });
});

describe("計算の芯: 見取り図の数", () => {
  const map = fromDevTree(handTree());
  const cm = compileMap(map);
  const a = analyze(cm, 360);
  const ov = overview(a);
  const S = 30;
  const w = (x: [number, number, number]) => x[0] * S + x[1] + x[2];
  const move = (kind: string) => ov.moves.find((m) => m.kind === kind)!;

  it("今やる vs 3 か月待つ: 今日の手と今のままが全部 q を持てば q で比べ、地図の値の差も残す", () => {
    expect(ov.basis.delta).toBe("q");
    expect(move("ad_permside").delta).toEqual({ d: expect.closeTo(w([36, 6, -2]) - w([36, 0, -3]), 9), basis: "q" });
    expect(move("keep").delta).toEqual({ d: 0, basis: "q" });
    const ap = move("ad_permside");
    const base = ov.base;
    expect(ap.deltaTree).toBeCloseTo(a.pi.V[ap.node]! - a.pi.V[base]!, 9);
    // q の無い手を比べると地図の値になる
    const m = fromDevTree(randomTree(5));
    const c = compileMap(m);
    const a5 = analyze(c, 360);
    const ov5 = overview(a5);
    if (ov5.moves.some((x) => x.delta?.basis === "tree")) expect(ov5.basis.delta).toBe("tree");
  });

  it("この種類を 3 年やらない場合との差 k = never._all − never[まとまり]（無い種類・今のままは出さない）", () => {
    expect(move("ad_permside").worth).toBeCloseTo(w([37, 10, 3]) - w([36.5, 2, 3]), 9);
    expect(move("fc_switch").worth).toBeCloseTo(w([37, 10, 3]) - w([36.6, 10, 3]), 9);
    expect(move("sd_grow").worth).toBeNull();
    expect(move("keep").worth).toBeNull();
    expect(worthOf(a, "fcpush")).toBeCloseTo(0.1, 9);
    expect(ov.basis.worth).toBe(true);
  });

  it("その手で分かる事実と、答えごとの割合", () => {
    const ap = move("ad_permside");
    expect(ap.reveals?.label).toBe("会社の答え");
    expect(ap.reveals?.answers.map((x) => [x.label, x.share])).toEqual([
      ["全部可", 0.2],
      ["SpellDash だけ", 0.45],
      ["どちらも不可", 0.35],
    ]);
    expect(move("fc_switch").reveals).toBeNull();
    expect(ap.outcomes.map((o) => o.p)).toEqual([20, 45, 35]);
    // 答えごとの 3 年の合計の重み付き平均 = この手の値
    const tot = ap.reveals!.answers.reduce((s, x) => s + x.share * x.total, 0);
    expect(tot).toBeCloseTo(a.money.acc[ap.node]! + a.pi.V[ap.node]!, 9);
  });

  it("分布は今日の手の先だけを見込みで重み付けし、段の合計は 1。ずっと今のままは比べる帯", () => {
    for (const m of ov.moves) {
      expect(m.dist).not.toBeNull();
      expect(m.dist!.bins.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 12);
      expect(m.dist!.mass).toBeCloseTo(1, 12);
      expect(m.dist!.mean).toBeCloseTo(a.money.acc[m.node]! + a.pi.V[m.node]!, 9);
      expect(m.dist!.p10 <= m.dist!.p50 && m.dist!.p50 <= m.dist!.p90).toBe(true);
    }
    expect(ov.keep!.mean).toBeCloseTo(a.vSQ!, 9);
    expect(ov.today!.mean).toBeCloseTo(a.vRoot!, 9);
  });

  it("数: 判断・出来事の分かれ・おすすめの選び方で着く本当の行き先・見込み 1% 以上・まとめた行き先", () => {
    const ap = move("ad_permside");
    expect(ap.counts.decisions).toBe(4);
    expect(ap.counts.splits).toBe(5);
    expect(ap.counts.forks).toBe(9);
    expect(ap.counts.sumEnds).toBe(3);
    expect(ap.counts.ends).toBe(cm.nEnd[ap.node]);
    // 見込みのある本当の行き先は、子の無い状態（顧客 0 社）を除いた行き先
    let real = 0;
    for (let i = ap.node; i < ap.node + cm.size[ap.node]!; i++) if (cm.role[i] === 3 && !map.sum(i) && a.pi.reachIn[i]! > 0) real++;
    expect(ap.counts.reachEnds).toBe(real);
    expect(ap.counts.reachEnds1).toBeLessThanOrEqual(real);
  });

  it("今のままの先との違い: 同じ手が続く地図は 0、今のまま自身は出さない", () => {
    expect(move("keep").tv).toBeNull();
    for (const m of ov.moves) if (m.tv !== null) expect(m.tv >= 0 && m.tv <= 1).toBe(true);
    // 今のままと同じ中身の手を今日に足すと、違いは 0 で「ほぼ同じ」
    const t = handTree();
    const keep = t.root.kids!.find((k) => k.k === "r.keep")!;
    const twin = JSON.parse(JSON.stringify(keep).replaceAll("r.keep", "r.twin")) as typeof keep;
    twin.kind = "sd_retain";
    delete twin.base;
    delete twin.why;
    t.root.kids!.push(twin);
    const a2 = analyze(compileMap(fromDevTree(t)), 360);
    const tw = overview(a2).moves.find((m) => m.kind === "sd_retain")!;
    expect(tw.tv).toBe(0);
    expect(tw.nearKeep).toBe(true);
    expect(tw.smallDelta).toBe(true);
  });
});

describe("計算の芯: 扇・分かれ道の帯・進め方・道・行き先・塗り", () => {
  const map = fromDevTree(handTree());
  const cm = compileMap(map);
  const a = analyze(cm, 360);
  const S = 30;
  const f = (kind: string) => Array.from(cm.firstMoves).find((x) => kindKey(cm, x) === kind)!;

  it("扇: 0 か月目は今日の月の稼ぎ、どの段も 10% ≤ 50% ≤ 90%。事実を知る手は答えごとに 1 本", () => {
    const fan = fanData(a, f("ad_permside"));
    expect(fan.all.points.map((p) => p.m)).toEqual([0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36]);
    expect(fan.all.points[0]!.p50).toBeCloseTo(30 - 0.3, 12);
    for (const band of [fan.all, ...fan.answers]) {
      for (const p of band.points) {
        if (p.p50 === null) continue;
        expect(p.p10! <= p.p50 && p.p50 <= p.p90!).toBe(true);
        expect(p.mass + p.viaSummary).toBeLessThanOrEqual(1 + 1e-12);
      }
    }
    expect(fan.answers.map((b) => b.label)).toEqual(["全部可", "SpellDash だけ", "どちらも不可"]);
    // 36 か月目より前に止まった状態（顧客 0 社）は、その月の稼ぎのまま 36 か月目まで数える
    const cl0 = map.indexOfKey("r.ad_permside.a.1as.cl0");
    const all = fan.answers[0]!;
    if (a.pi.reachIn[cl0]! > 0) expect(all.points[12]!.mass).toBeCloseTo(1, 12);
    expect(fanData(a, f("fc_switch")).answers).toEqual([]);
    // まとめた手を選ぶと、その後の段は「標準の続きの見積もり」に入り、36 か月目の数は見積もりと分かる
    const st2 = new Uint8Array(cm.n);
    st2[map.indexOfKey("r.ad_permside.a.1k")] = 1;
    const a2 = analyze(cm, 360, { status: st2 });
    const ans = fanData(a2, f("ad_permside")).answers[0]!;
    expect(ans.points[2]!.viaSummary).toBeCloseTo(1, 12);
    expect(ans.points[2]!.p50).toBeNull();
    expect(ans.points[12]!.estimated).toBeCloseTo(1, 12);
    expect(fan.keep[12]!.p50).toBeCloseTo(1.03 * S - 0.3, 12);
  });

  it("分かれ道の帯: 3 か月ごとの判断の数の合計は部分木の判断の数", () => {
    const x = f("ad_permside");
    const strip = forkStrip(a, x);
    expect(strip.total.decisions).toBe(cm.nDec[x]);
    expect(strip.total.splits).toBe(cm.nSplit[x]);
    expect(strip.decisions[1]).toBe(3);
    expect(strip.decisions[2]).toBe(1);
  });

  it("進め方: どの月も割合の合計は 100%、理由は直前の結果", () => {
    const plan = planView(a, f("ad_permside"));
    expect(plan[0]!.moves).toEqual([{ kind: "ad_permside", share: 1, mass: 1, count: 1, stub: 0, conds: [], top: 0, topOption: f("ad_permside") }]);
    for (const q of plan) {
      if (!(q.alive > 0)) continue;
      expect(q.moves.reduce((s, m) => s + m.share, 0)).toBeCloseTo(1, 12);
      for (const m of q.moves) if (m.conds.length) expect(m.conds.reduce((s, c) => s + c.share, 0)).toBeLessThanOrEqual(1 + 1e-12);
    }
    const q3 = plan.find((q) => q.m === 3)!;
    expect(q3.alive).toBeCloseTo(1, 12);
    const labels = q3.moves.flatMap((m) => m.conds.map((c) => c.label));
    expect(labels.sort()).toEqual(["SpellDash だけ", "どちらも不可", "全部可"].sort());
    expect(q3.moves.every((m) => m.conds.every((c) => c.fromKind === "ad_permside"))).toBe(true);
  });

  it("道: 一番ありそうな道とその見込み、ほかの結果と手、切り替えると切り替えた所から先を作り直す", () => {
    const pv = walkPath(a, 0);
    const chain = mostLikelyChain(a, 0);
    expect(pv.p).toBeCloseTo(chain.p, 12);
    expect(pv.rows[0]!.decision).toBe(0);
    expect(pv.rows[0]!.option).toBe(a.pi.pi[0]);
    expect(pv.rows[pv.rows.length - 1]!.mNext).toBe(36);
    for (const r of pv.rows) {
      expect(r.altOutcomes.reduce((s, x) => s + x.w, r.w)).toBeCloseTo(1, 12);
      expect(r.altOptions.length).toBe(cm.kidOff[r.decision + 1]! - cm.kidOff[r.decision]! - 1);
      for (const o of r.altOptions) if (o.delta && r.onPi && o.delta.basis === "tree") expect(o.delta.d).toBeLessThanOrEqual(1e-9);
    }
    // ほかの結果に切り替える: その結果から先が新しい道、上の行はそのまま
    const row = pv.rows[0]!;
    const alt = row.altOutcomes[0];
    if (alt) {
      const sw = walkPath(a, alt.node, 0);
      expect(sw.rows[0]!.outcome).toBe(alt.node);
      expect(sw.rows[0]!.option).toBe(row.option);
      expect(sw.p).toBeCloseTo(alt.w * mostLikelyChain(a, alt.node).p, 12);
    }
    // ほかの手に切り替える
    const altOpt = row.altOptions[0]!;
    const sw2 = walkPath(a, altOpt.node, 0);
    expect(sw2.rows[0]!.option).toBe(altOpt.node);
    expect(sw2.rows[0]!.onPi).toBe(false);
    expect(sw2.rows[0]!.altOptions.some((o) => o.node === row.option && o.onPi)).toBe(true);
    // 開いたカードから下だけの道（見込みはそこから）
    const s = map.indexOfKey("r.ad_permside.s");
    const fromS = walkPath(a, s, s);
    expect(fromS.rows[0]!.decision).toBe(s);
    expect(fromS.p).toBeCloseTo(mostLikelyChain(a, s).p, 12);
  });

  it("道: 続けて同じ手の静かな期は 1 行にまとめ、まとめた手の後は標準の続き（cont）を持つ", () => {
    // ずっと今のまま（今のまま → 今のまま → 今のまま）の道
    const k2 = map.indexOfKey("r.keep.all.1k.all.2k");
    const pv = walkPath(a, k2, 0);
    expect(pv.rows.map((r) => kindKey(cm, r.option))).toEqual(["keep", "keep", "keep"]);
    expect(pv.groups).toEqual([{ from: 0, to: 2, count: 3, kind: "keep", quiet: true, m: 0, mNext: 36, w: 1 }]);
    // まとめた手（今のまま）の先
    const stub = map.indexOfKey("r.ad_permside.a.1as.cl1.2k");
    const sv = walkPath(a, stub, 0);
    expect(sv.summary).toBe(true);
    expect(sv.rows[sv.rows.length - 1]!.stub).toBe(true);
    expect(sv.cont).toEqual([
      { m: 9, kind: "ad_more", ev: "client_up" },
      { m: 12, kind: "keep", ev: null },
    ]);
  });

  it("行き先を種類ごとに: 割合の合計は 1、数の合計は着く行き先の数、名前は日本語", () => {
    for (const x of [null, ...Array.from(cm.firstMoves)]) {
      const groups = destinations(a, x);
      expect(groups.reduce((s, g) => s + g.share, 0)).toBeCloseTo(1, 12);
      for (const g of groups) {
        expect(g.label).not.toMatch(/(?<![A-Za-z])[a-z][a-z_]+/);
        expect(g.ends.length).toBe(g.count);
        expect(g.lo <= g.mean + 1e-9 && g.mean <= g.hi + 1e-9).toBe(true);
      }
    }
    // まとめた行き先は mix の多い方で分ける（SpellDash だけ可・顧客 1 社・有料 30〜99 人）
    const t = handTree();
    const m2 = fromDevTree(t);
    const c2 = compileMap(m2);
    const a2 = analyze(c2, 360, { status: (() => {
      const s = new Uint8Array(c2.n);
      s[m2.indexOfKey("r.ad_permside.a.1as.cl1.2k")] = 1;
      s[m2.indexOfKey("r.ad_permside.a.1as")] = 1;
      return s;
    })() });
    const g = destinations(a2, m2.indexOfKey("r.ad_permside")).find((x) => x.summary > 0)!;
    expect(g.label).toBe("会社員・SpellDash だけ可・顧客 1 社・有料 30〜99 人");
  });

  it("塗り: どのカードも 3 年の合計 − ずっと今のまま（今日は vRoot − vSQ）", () => {
    const h = heatValues(a);
    expect(h[0]).toBeCloseTo(a.vRoot! - a.vSQ!, 9);
    const e = map.indexOfKey("r.fc_switch.high");
    expect(h[e]).toBeCloseTo(a.money.acc[e]! - a.vSQ!, 9);
  });

  it("仮の文章: 英字の鍵を出さず、数字の行を持つ", () => {
    const text = fallbackText(map, { annual: 360 });
    for (let i = 0; i < map.n; i++) {
      expect(text.title(i)).not.toMatch(/^[\x20-\x7e]+$/);
      expect(text.body(i)).not.toMatch(/[a-z]{2,}_[a-z]/);
    }
    const s = map.indexOfKey("r.ad_permside.a");
    expect(text.numbers(s)[0]).toBe("年収 360 万円（月にならして 30 万円）");
    expect(text.body(map.indexOfKey("r.ad_permside"))).toMatch(/^11 月〜1 月: 届け出て副業の 1 社目を探す。週の時間は \+4 時間。/);
  });
});

describe("年月", () => {
  it("0 か月目の年月から月を足すだけ", () => {
    expect(ymText("2026-11", 0)).toBe("2026 年 11 月");
    expect(ymText("2026-11", 3)).toBe("2027 年 2 月");
    expect(ymText("2026-11", 36)).toBe("2029 年 11 月");
    expect(ymSpanText("2026-11", 9, 15)).toBe("2027 年 8 月〜2028 年 2 月");
    expect(ymSpanText("2026-11", 15, 21)).toBe("2028 年 2 月〜8 月");
    expect(quarterSpanText("2026-11", 0)).toBe("11 月〜1 月");
    expect(() => ymText("2026/11", 0)).toThrow(RangeError);
  });
});
