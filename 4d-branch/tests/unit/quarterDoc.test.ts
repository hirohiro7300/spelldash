// 3 か月ごとの地図の軽い組み立て（src/demo/quarterDoc.ts の buildQuarterDoc。作業メモ SPEC v1 §3.4・D9・§6、見直し perf-6・perf-7・safety-6・safety-14・gaps-2）。
// 本物の生成で作った小さい木（tests/fixtures/q-small。8,306 枚）と、手で作った地図・種から作る地図で確かめる:
//   形と meta（アプリの src/model/** が読む名前）・アプリの計算と計算の芯が同じ答え（年収 360・540）・normalizeDoc を通しても変わらない（整数のずらしも）・
//   時差に依らない・同じ入力なら同じ文書・ID の重なりと食い違いで止まる・共有する部品は凍っている（テストの組み立て）・やること。
// 基準の文書の指紋は quarterDigest.test.ts、8 万枚の木（時間とメモリ）は quarterDocFull.test.ts（環境変数があるときだけ）
import { beforeAll, describe, expect, it } from "vitest";
import { canonicalizeDevTree, encodeMap } from "../../scripts/impact/q/bundle";
import { edgeTextPrint, fnv36, fnv64x36, impactEdgeId64, impactNodeId64, impactTagsOf, IMPACT_AREAS, IMPACT_SCENARIOS } from "../../src/demo/impact";
import { decodeBundleBytes } from "../../src/demo/impactBundle";
import { anchorMonthEnd, anchorMonthStart, buildQuarterDoc, quarterColumnX, QuarterDocError, quarterRootId, type QuarterLayout } from "../../src/demo/quarterDoc";
import quarterDocSrc from "../../src/demo/quarterDoc.ts?raw";
import { analyze, compileMap, scenarioMask, ymAt } from "../../src/deepmap/core";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";
import type { DevTree, DevTreeNode, MapData } from "../../src/deepmap/mapData";
import { isDateStr } from "../../src/model/dates";
import { computeForecast } from "../../src/model/forecast";
import { flowOuts, forkKindOf, impactConfigOf, isImpactRoot } from "../../src/model/forks";
import { buildIndex } from "../../src/model/graph";
import { computeImpact } from "../../src/model/impact";
import { IMPACT_X, impactColX } from "../../src/model/impactLayout";
import { normalizeDoc } from "../../src/model/schema";
import type { DocData, GNode, NodeStatus } from "../../src/model/types";
import { compare, handTree, header, randomStatus, randomTree, st as stOf, statusArray, type AppRun } from "./deepmapFixtures";
import { loadQSmall } from "./helpers/qSmall";

let map: MapData;
beforeAll(async () => {
  map = await loadQSmall();
});

const AT = Date.UTC(2026, 10, 19, 3, 4, 5, 6);
const AT_ISO = "2026-11-19T03:04:05.006Z";
const build = (m: MapData, opts: { at?: number; layout?: QuarterLayout } = {}): DocData =>
  buildQuarterDoc(m, { version: m.header.hash, release: m.header.release, at: opts.at ?? AT, ...(opts.layout ? { layout: opts.layout } : {}) });

/** 地図の番号 i のカード */
const cardOf = (doc: DocData, m: MapData, i: number): GNode => doc.nodes[impactNodeId64(m.key(i))]!;

/** 組み立てた文書をアプリの計算で数える（年収・選んだ手・シナリオ。今日の meta.impact に年収を入れた写しで） */
function appRun(doc: DocData, m: MapData, annual: number, opts: { status?: ReadonlyMap<string, NodeStatus>; scenario?: string | null } = {}): AppRun {
  const root = quarterRootId(m);
  const r = doc.nodes[root]!;
  const nodes = { ...doc.nodes, [root]: { ...r, meta: { ...r.meta, impact: { v: 2, horizon: m.header.horizon, annual } } } };
  for (const [key, s] of opts.status ?? []) {
    const id = impactNodeId64(key);
    nodes[id] = { ...nodes[id]!, status: s };
  }
  const d2: DocData = { ...doc, nodes };
  const idx = buildIndex(d2);
  const scen = opts.scenario ?? null;
  return { doc: d2, res: computeImpact(d2, idx.out, computeForecast(d2, idx.out, scen), scen), id: impactNodeId64 };
}

/**
 * 64 ビットの指紋（fnv64x36）が本当に重なる 2 つの鍵（どちらも "r." + . を含まない区切り）。見つけ方（Joux の多重衝突。node で 1 秒かからない）:
 * "r." の後ろに、1 つ目の FNV-1a（32 ビット）だけが同じ値になる 6 文字の組を 18 回続けて探してつなぎ（どちらを選んでも 1 つ目は同じ値に戻る）、
 * その 2^18 通りの中から 2 つ目の FNV-1a も同じになる 2 つを選んだ。fnv64x36 の作りが同じ限り重なる
 */
const COLLIDING_KEYS = {
  a: "r.so44pcnna9rzgkhazcc3p59l01hsn40k7vysgiv64uovxkmhyin7amra64jkn1ki0dzq3ev1fqgqy8m3uzvgu0sajedjkpivy93of69o278o",
  b: "r.bqr4vz5wcob6gkhazcc3p59ln4fo6ie19hspgiv64uovxkmhyin7amiv7f28j9zbukkylpcqtkpuggknac69i4cmzywr4ycyy93of69o278o",
};

/** 手で作った、やることのある小さな地図（2 つの手が同じやることを持つ・やることの無い手・幅・事実・まとめた行き先） */
function todoTree(): DevTree {
  const todo = [
    { text: "会社の副業の決まりを読む", cite: "ind-side-d05" },
    { text: "届け出の紙を出す", cite: "ind-side-d22" },
  ];
  const out = (k: string, m: number, p: number, kids: DevTreeNode[] = [], x: Partial<DevTreeNode> = {}): DevTreeNode => ({
    k,
    r: kids.length ? "s" : "e",
    m,
    st: stOf(),
    rr: [1, 0, 0],
    id: k,
    p,
    lab: k.endsWith(".all") ? "—" : `結果 ${k}`,
    line: k.endsWith(".all") ? "（どの場合もこの道）" : `${k} の場合`,
    ln: ["none", m, null, null, "all"],
    e: [3, 0, 0],
    ...x,
    ...(kids.length ? { kids } : {}),
  });
  const root: DevTreeNode = {
    k: "r",
    r: "r",
    m: 0,
    st: stOf(),
    rr: [1, 0, -0.3],
    kids: [
      {
        k: "r.ad_permside",
        r: "a",
        m: 0,
        st: stOf(),
        kind: "ad_permside",
        h: 4,
        why: "best",
        todo,
        q: [36, 6, -2],
        kids: [
          out("r.ad_permside.a", 3, 20, [{ k: "r.ad_permside.a.1as", r: "a", m: 3, st: stOf(), kind: "ad_side", h: 5, todo: [todo[1]!], kids: [out("r.ad_permside.a.1as.all", 36, 100, [], { sum: true, band: { cl: [1, 2] } })] }], {
            rv: ["pm:0", "a"],
            st: stOf({ pm: "a", fl: ["x", "y"] }),
            band: { cl: [0, 1], pu: [10, 20] },
          }),
          out("r.ad_permside.n", 3, 80, [], { rv: ["pm:0", "n"] }),
        ],
      },
      { k: "r.sd_grow", r: "a", m: 0, st: stOf(), kind: "sd_grow", h: 2, todo, kids: [out("r.sd_grow.all", 3, 100)] },
      { k: "r.keep", r: "a", m: 0, st: stOf(), kind: "keep", h: 0, base: true, why: "keep", kids: [out("r.keep.all", 3, 100)] },
    ],
  };
  return { header: header({ never: { _all: [37, 10, 3], side: [36.5, 2, 3] } }), root };
}

describe("組み立てた文書の形（小さい木）", () => {
  it("カード・線・ID: どの鍵も 64 ビット（n_i_）、線は子の鍵から（e_i_）、入口は今日", () => {
    const doc = build(map);
    expect(Object.keys(doc.nodes)).toHaveLength(map.n);
    expect(Object.keys(doc.edges)).toHaveLength(map.n - 1);
    expect(doc.id).toMatch(/^d_i_[0-9a-z]{14}$/);
    expect(doc.title).toBe(map.header.title);
    expect([doc.schema, doc.version]).toEqual(["4d-branch", 1]);
    expect(quarterRootId(map)).toBe(impactNodeId64(map.key(0)));
    for (let i = 0; i < map.n; i++) {
      const key = map.key(i);
      const n = doc.nodes[impactNodeId64(key)];
      expect(n?.meta.key, key).toBe(key);
      if (i === 0) continue;
      const e = doc.edges[impactEdgeId64(key)];
      expect(e && [e.source, e.target], key).toEqual([impactNodeId64(map.key(map.parent(i))), impactNodeId64(key)]);
    }
    expect(Object.keys(doc.projects)).toEqual(Object.values(IMPACT_AREAS).map((a) => a.id));
    expect(doc.projectOrder).toEqual(Object.keys(doc.projects));
    expect(Object.keys(doc.scenarios)).toEqual(IMPACT_SCENARIOS.map((s) => s.id));
    expect(doc.scenarioOrder).toEqual(Object.keys(doc.scenarios));
  });

  it("どのカード・線も: 時刻は at・本文は空・状態は open・タグは impactTagsOf と同じ・projectIds は手の種類の領域", () => {
    const doc = build(map);
    for (const x of [doc, ...Object.values(doc.projects), ...Object.values(doc.scenarios), ...Object.values(doc.nodes), ...Object.values(doc.edges)]) {
      expect([x.createdAt, x.updatedAt]).toEqual([AT_ISO, AT_ISO]);
    }
    const all = Object.values(IMPACT_AREAS).map((a) => a.id);
    for (let i = 0; i < map.n; i++) {
      const n = cardOf(doc, map, i);
      expect([n.body, n.status, n.collapsed, n.scenarioIds], n.meta.key as string).toEqual(["", "open", false, []]);
      expect(n.tags).toEqual(impactTagsOf(n.meta));
      expect(n.title).toBe(map.title(i));
      if (map.role(i) === "a") {
        const area = map.header.kinds[map.kind(i)!]?.[1] ?? "base";
        expect(n.projectIds).toEqual(area === "base" ? all : [IMPACT_AREAS[area].id]);
      } else expect(n.projectIds).toEqual(all);
    }
  });

  it("役割ごとの種類・線の関係・meta の名前と値（アプリの src/model/** の読み方と同じ。mix と cont は写さず地図から引く）", () => {
    const doc = build(map);
    const idx = buildIndex(doc);
    const B0 = fnv36("");
    const keysOf = (o: object) => Object.keys(o).sort();
    const pick = (o: Record<string, unknown>, ks: string[]) => ks.filter((k) => k in o);
    let summaries = 0;
    for (let i = 0; i < map.n; i++) {
      const role = map.role(i);
      const key = map.key(i);
      const n = cardOf(doc, map, i);
      const meta = n.meta;
      const outs = flowOuts(doc, idx.out, n.id);
      const rank = i === 0 ? null : Array.from({ length: map.childCount(map.parent(i)) }, (_, k) => map.child(map.parent(i), k)).indexOf(i);
      expect([meta.m, meta.short, meta.key, meta.t0, meta.b0], key).toEqual([map.month(i), map.short(i), key, fnv36(map.title(i)), B0]);
      if (role === "r") {
        expect(n.type).toBe("goal");
        expect(keysOf(meta)).toEqual(["anchor", "b0", "fams", "forecastRoot", "fork", "futureRelease", "futureVersion", "impact", "key", "m", "never", "rr", "short", "st", "t0", "textVersion"]);
        expect(meta).toMatchObject({ forecastRoot: true, futureVersion: map.header.hash, futureRelease: map.header.release, impact: { v: 2, horizon: 36 }, anchor: "2026-11", textVersion: map.header.textVersion, fork: "decision" });
        expect(meta.never).toEqual(map.header.never);
        expect(meta.fams).toEqual(map.header.fams);
        expect(isImpactRoot(n)).toBe(true);
        expect(impactConfigOf(n)).toEqual({ v: 2, horizon: 36 });
        expect(forkKindOf(n, outs)).toBe("decision");
      } else if (role === "a") {
        expect(n.type).toBe("action");
        const kind = map.kind(i)!;
        const kd = map.header.kinds[kind]!;
        const optional = pick(meta, ["why", "stub", "base", "cites", "k0", "q"]);
        expect(keysOf(meta)).toEqual(["ak", "b0", "fam", "fork", "h", "key", "m", "rank", "short", "t0", ...optional].sort());
        expect([meta.fork, meta.ak, meta.fam, meta.h, meta.rank], key).toEqual(["chance", kind, kd[2], map.hours(i), rank]);
        expect([meta.why ?? null, meta.stub === true, meta.base === true, meta.q ?? null], key).toEqual([map.why(i), map.stub(i), map.isBase(i), map.q(i)]);
        expect([meta.stub, meta.base].filter((x) => x !== undefined && x !== true)).toEqual([]);
        expect(forkKindOf(n, outs)).toBe("chance");
        const e = doc.edges[impactEdgeId64(key)]!;
        expect([e.relation, e.label, e.condition, e.meta]).toEqual(["leads", "", "", { c0: edgeTextPrint("", "") }]);
        expect(e.scenarioIds).toEqual(map.isBase(i) ? [] : kd[3]);
      } else {
        expect(n.type).toBe(role === "s" ? "branch" : "result");
        const optional = pick(meta, ["band", "sum"]);
        expect(keysOf(meta)).toEqual([role === "s" ? "fork" : "end", "b0", "key", "m", "rank", "rr", "short", "st", "t0", ...optional].sort());
        expect(role === "s" ? meta.fork : meta.end).toBe(role === "s" ? "decision" : true);
        expect([meta.st, meta.rr, meta.band ?? null, meta.sum === true, meta.rank], key).toEqual([map.st(i), map.rr(i), map.band(i), map.sum(i), rank]);
        if (meta.sum !== undefined) expect(meta.sum).toBe(true);
        expect(forkKindOf(n, outs)).toBe(outs.length ? "decision" : "leaf");
        // まとめた行き先の中身は地図から（鍵で引く）
        if (map.sum(i)) {
          summaries++;
          const j = map.indexOfKey(meta.key as string);
          expect([j, map.mix(j) !== null || map.cont(j) !== null]).toEqual([i, map.mix(i) !== null || map.cont(i) !== null]);
        }
        const e = doc.edges[impactEdgeId64(key)]!;
        const label = map.label(i) === "—" ? "" : map.label(i);
        expect([e.relation, e.label, e.condition, e.scenarioIds]).toEqual(["condition", label, map.line(i), []]);
        const em = e.meta;
        expect(keysOf(em)).toEqual(["c0", "p0", "prob", "r", ...pick(em, ["ln", "rv"])].sort());
        expect([em.prob, em.p0, em.r, em.ln ?? null, em.rv ?? null, em.c0], key).toEqual([map.p(i), map.p(i), map.e(i), map.ln(i), map.rv(i), edgeTextPrint(label, map.line(i))]);
      }
    }
    expect(summaries).toBeGreaterThan(100);
  });

  it("期限は地図の年月から整数の月の計算で: 今日・状態・行き先はその月の末日、手は次の月の 1 日から 3 か月目の末日まで", () => {
    const doc = build(map);
    const root = doc.nodes[quarterRootId(map)]!;
    expect(root.time).toEqual({ due: "2026-11-30", start: null });
    for (let i = 0; i < map.n; i++) {
      const n = cardOf(doc, map, i);
      const m = map.month(i);
      expect(isDateStr(n.time.due)).toBe(true);
      if (map.role(i) === "a") expect(n.time).toEqual({ due: anchorMonthEnd("2026-11", m + 3), start: anchorMonthStart("2026-11", m + 1) });
      else expect(n.time).toEqual({ due: anchorMonthEnd("2026-11", m), start: null });
    }
    const first = cardOf(doc, map, map.child(0, 0));
    expect(first.time).toEqual({ due: "2027-02-28", start: "2026-12-01" });
    const ends = Object.values(doc.nodes).filter((n) => n.meta.end === true && n.meta.m === 36);
    expect(ends.length).toBeGreaterThan(0);
    for (const n of ends) expect(n.time.due).toBe("2029-11-30");
  });

  it("年月の計算: うるう年・年の境目・100 年と 400 年の決まり。計算の芯の年月（ymAt）と同じ月", () => {
    expect(anchorMonthEnd("2027-11", 3)).toBe("2028-02-29");
    expect(anchorMonthEnd("2026-11", 3)).toBe("2027-02-28");
    expect(anchorMonthEnd("2099-12", 2)).toBe("2100-02-28");
    expect(anchorMonthEnd("1999-12", 2)).toBe("2000-02-29");
    expect(anchorMonthEnd("2026-12", 0)).toBe("2026-12-31");
    expect(anchorMonthStart("2026-12", 1)).toBe("2027-01-01");
    expect(anchorMonthEnd("2026-11", 36)).toBe("2029-11-30");
    for (const anchor of ["2026-11", "2026-12", "2027-01", "2027-03"])
      for (let m = 0; m <= 40; m++) {
        const ym = ymAt(anchor, m);
        const want = `${ym.y}-${String(ym.mo).padStart(2, "0")}`;
        expect(anchorMonthEnd(anchor, m).slice(0, 7)).toBe(want);
        expect(anchorMonthStart(anchor, m)).toBe(`${want}-01`);
        expect(isDateStr(anchorMonthEnd(anchor, m))).toBe(true);
      }
    expect(() => anchorMonthEnd("2026-13", 0)).toThrow(QuarterDocError);
    expect(() => anchorMonthEnd("2026-1", 0)).toThrow(QuarterDocError);
  });

  it("位置: none は x = y = 0、columns は月から x（整数・3 か月で 700・手はその右 300・まとめた行き先は 36 か月目の列）", () => {
    for (const n of Object.values(build(map).nodes)) expect([n.x, n.y]).toEqual([0, 0]);
    const doc = build(map, { layout: "columns" });
    for (let i = 0; i < map.n; i++) {
      const n = cardOf(doc, map, i);
      expect([n.x, n.y]).toEqual([quarterColumnX(map.role(i), map.month(i)), 0]);
      expect(Number.isInteger(n.x)).toBe(true);
      if (map.sum(i)) expect(n.x).toBe(8400);
    }
    // 今の地図の深さごとの列（判断 → 手 300・手 → 結果 400）と同じ幅: 深さ d の判断（今日・状態）と手
    for (let d = 0; d < IMPACT_X.length; d++) {
      const role = d === 0 ? "r" : d % 2 === 1 ? "a" : "s";
      const month = role === "a" ? ((d - 1) / 2) * 3 : (d / 2) * 3;
      expect(quarterColumnX(role, month)).toBe(impactColX(d));
    }
  });
});

describe("やること（地図の todo）", () => {
  it("文 → 条件の項目（c_ + ノードの指紋 + _ + 番号・チェックなし）、元の番号 → meta.cites の同じ番号、文ごとの指紋 → meta.k0", () => {
    const m = fromDevTree(todoTree());
    const doc = build(m);
    const a = doc.nodes[impactNodeId64("r.ad_permside")]!;
    const h = impactNodeId64("r.ad_permside").slice(4);
    expect(a.conditions).toEqual([
      { id: `c_${h}_0`, text: "会社の副業の決まりを読む", met: false },
      { id: `c_${h}_1`, text: "届け出の紙を出す", met: false },
    ]);
    expect(a.meta.cites).toEqual(["ind-side-d05", "ind-side-d22"]);
    expect(a.meta.k0).toEqual([fnv36("会社の副業の決まりを読む"), fnv36("届け出の紙を出す")]);
    // 同じやることの手は元の番号と指紋の並びを共有し、項目（ID がカードごと）は共有しない
    const b = doc.nodes[impactNodeId64("r.sd_grow")]!;
    expect(b.meta.cites).toBe(a.meta.cites);
    expect(b.meta.k0).toBe(a.meta.k0);
    expect(b.conditions).not.toBe(a.conditions);
    expect(b.conditions.map((c) => c.id)).toEqual([0, 1].map((k) => `c_${impactNodeId64("r.sd_grow").slice(4)}_${k}`));
    const c = doc.nodes[impactNodeId64("r.ad_permside.a.1as")]!;
    expect([c.meta.cites, c.meta.k0, c.conditions.map((x) => x.text)]).toEqual([["ind-side-d22"], [fnv36("届け出の紙を出す")], ["届け出の紙を出す"]]);
    // やることの無い手は項目も cites も k0 も無い
    const keep = doc.nodes[impactNodeId64("r.keep")]!;
    expect([keep.conditions, "cites" in keep.meta, "k0" in keep.meta]).toEqual([[], false, false]);
    // 幅・事実・状態の印・まとめた行き先
    const s = doc.nodes[impactNodeId64("r.ad_permside.a")]!;
    expect([s.meta.band, s.meta.st]).toEqual([{ cl: [0, 1], pu: [10, 20] }, stOf({ pm: "a", fl: ["x", "y"] })]);
    expect(doc.edges[impactEdgeId64("r.ad_permside.a")]!.meta.rv).toEqual(["pm:0", "a"]);
    const sum = doc.nodes[impactNodeId64("r.ad_permside.a.1as.all")]!;
    expect([sum.meta.end, sum.meta.sum, sum.meta.band]).toEqual([true, true, { cl: [1, 2] }]);
    expect(doc.edges[impactEdgeId64("r.ad_permside.a.1as.all")]!.label).toBe("");
    expect(normalizeDoc(doc)).toEqual({ doc, report: { warnings: [], dropped: { nodes: 0, edges: 0, projects: 0, scenarios: 0 } } });
  });

  it("同梱データの読み手を通した地図: 同じ並びの手には同じ凍らせた配列・項目は (文, 元) ごとに 1 つ。組み立ては開発用の木と同じ文書で、元の番号と文の指紋の並びは共有（見直し perf-1・perf-3）", () => {
    // やることの多い手: 同じ並び（別の配列）の 2 つの手・1 項目の手・12 項目（番号 10・11 は 2 桁）の手。同じ文でも元が違えば別の項目
    const tree = todoTree();
    const opts = new Map<string, DevTreeNode>();
    const walk = (n: DevTreeNode): void => {
      if (n.r === "a") opts.set(n.k, n);
      for (const c of n.kids ?? []) walk(c);
    };
    walk(tree.root);
    const texts = ["会社の副業の決まりを読む", "届け出の紙を出す", "顧客に 1 社連絡する"];
    const twelve = Array.from({ length: 12 }, (_, k) => ({ text: texts[k % 3]!, cite: k === 0 ? "ind-side-d05" : `ind-side-x${k}` }));
    opts.get("r.sd_grow")!.todo = opts.get("r.ad_permside")!.todo!.map((t) => ({ ...t }));
    opts.get("r.keep")!.todo = twelve;
    tree.header.counts.nodes = fromDevTree(tree).n;
    const m = decodeBundleBytes(encodeMap(fromDevTree(tree)));
    const at = (k: string) => m.indexOfKey(k);
    // 読み手: 同じ並びは同じ配列（何度問うても）・凍っている・項目は (文, 元) ごとに 1 つ・違う並びは別の配列
    const a = m.todo(at("r.ad_permside"));
    expect(a).toEqual(opts.get("r.ad_permside")!.todo);
    expect(m.todo(at("r.sd_grow"))).toBe(a);
    expect(m.todo(at("r.ad_permside"))).toBe(a);
    expect([Object.isFrozen(a), a.every((x) => Object.isFrozen(x))]).toEqual([true, true]);
    const one = m.todo(at("r.ad_permside.a.1as"));
    expect(one).toEqual([{ text: "届け出の紙を出す", cite: "ind-side-d22" }]);
    expect(one[0]).toBe(a[1]);
    const t12 = m.todo(at("r.keep"));
    expect(t12).toEqual(twelve);
    expect(t12[0]).toBe(a[0]);
    expect(t12[3]).not.toBe(a[0]);
    expect(m.todo(at("r.sd_grow.all"))).toEqual([]);
    // 組み立て: 開発用の木（手ごとに別の配列。丸めは同梱データと同じにした写し）と JSON までまったく同じ文書
    const canon = canonicalizeDevTree(tree);
    canon.header.hash = m.header.hash;
    const viaBundle = build(m, { layout: "columns" });
    expect(JSON.stringify(viaBundle)).toBe(JSON.stringify(build(fromDevTree(canon), { layout: "columns" })));
    // 同じやることの手は、元の番号と文の指紋の並びを共有（テストの組み立てでは凍っている）。項目は手ごと
    const card = (k: string) => viaBundle.nodes[impactNodeId64(k)]!;
    expect(card("r.sd_grow").meta.cites).toBe(card("r.ad_permside").meta.cites);
    expect(card("r.sd_grow").meta.k0).toBe(card("r.ad_permside").meta.k0);
    expect([Object.isFrozen(card("r.ad_permside").meta.cites), Object.isFrozen(card("r.ad_permside").meta.k0)]).toEqual([true, true]);
    expect(card("r.sd_grow").conditions).not.toBe(card("r.ad_permside").conditions);
    // 項目の ID は c_ + 鍵の 64 ビットの指紋 + _ + 番号（2 桁の番号も）。文と文の指紋は枠の順
    const keep = card("r.keep");
    expect(keep.conditions.map((c) => c.id)).toEqual(twelve.map((_, k) => `c_${fnv64x36("r.keep")}_${k}`));
    expect(keep.conditions.map((c) => [c.text, c.met])).toEqual(twelve.map((t) => [t.text, false]));
    expect([keep.meta.cites, keep.meta.k0]).toEqual([twelve.map((t) => t.cite), twelve.map((t) => fnv36(t.text))]);
    expect(normalizeDoc(viaBundle).report).toEqual({ warnings: [], dropped: { nodes: 0, edges: 0, projects: 0, scenarios: 0 } });
  });
});

describe("アプリの計算（computeImpact）と計算の芯（src/deepmap/core）が同じ答え", () => {
  it("小さい木: 年収 360・540 で値・手ごとの差（Δ）・選ぶ手（π）・見込み・分布が 1e-9 まで同じ", () => {
    const doc = build(map);
    const cm = compileMap(map);
    for (const annual of [360, 540]) {
      const app = appRun(doc, map, annual);
      expect(app.res.active).toBe(true);
      expect(app.res.counts.nodes).toBe(map.n);
      const n = compare(map, analyze(cm, annual), app);
      expect(n.options).toBe(map.header.counts.options);
      expect(n.decisions).toBeGreaterThan(100);
    }
  });

  it("小さい木: 選んだ手・見送った手・シナリオがあっても同じ答え", () => {
    const doc = build(map);
    const cm = compileMap(map);
    const status = randomStatus(map, 7);
    for (const [annual, scenario] of [
      [360, "s_balance"],
      [540, null],
      [540, "s_early"],
    ] as const) {
      // q のある地図（版 7）では、アプリは方針（シナリオ）で数を絞らない（方針の外の手は印だけ: 作業メモ SPEC v1 §5.11・gaps-12）。
      // 計算の芯も方針で絞らずに比べる（q の無い地図だけ方針の選べる手で絞る）
      const allowed = scenario && !cm.has.q ? scenarioMask(cm, scenario) : null;
      const a = analyze(cm, annual, { status: statusArray(cm, map, status), allowed });
      compare(map, a, appRun(doc, map, annual, { status, scenario }));
    }
  });

  it("手で作った地図・種から作る地図（0% の結果・合計 99 の %・同じ値の手・遅れて始まる手・36 か月目より前の行き先）でも同じ答え", () => {
    for (const tree of [handTree(), randomTree(1), randomTree(2), randomTree(3, 1500)]) {
      const m = fromDevTree(tree);
      const doc = build(m, { layout: "columns" });
      const cm = compileMap(m);
      for (const annual of [360, 540]) compare(m, analyze(cm, annual), appRun(doc, m, annual));
    }
  });
});

describe("normalizeDoc を通しても何も変わらない（組み立てた文書は通さずに使える）", () => {
  const clean = { warnings: [], dropped: { nodes: 0, edges: 0, projects: 0, scenarios: 0 } };
  /** 全部のカードを整数でない数も含めて (dx, dy) ずらした写し */
  const moved = (doc: DocData, dx: number, dy: number): DocData => ({ ...doc, nodes: Object.fromEntries(Object.entries(doc.nodes).map(([id, n]) => [id, { ...n, x: n.x + dx, y: n.y + dy }])) });

  for (const layout of ["none", "columns"] as const) {
    it(`layout ${layout}: 警告も捨てる物も無く、中身も同じ`, () => {
      const doc = build(map, { layout });
      const out = normalizeDoc(doc);
      expect(out.report).toEqual(clean);
      expect(out.doc).toStrictEqual(doc);
    });
  }

  it("整数のずらし（dx・dy）を足しても同じ（0.01 の丸めで変わらない）。整数でないずらしは変わる（だから整数にする: safety-14）", () => {
    const doc = build(map, { layout: "columns" });
    for (const [dx, dy] of [
      [1234, -5678],
      [-987_654, 3],
      [6812, 1_000_000],
    ] as const) {
      const d = moved(doc, dx, dy);
      const out = normalizeDoc(d);
      expect(out.report).toEqual(clean);
      expect(out.doc).toStrictEqual(d);
    }
    const odd = moved(doc, 1234.567, 6812.371);
    const changed = Object.values(normalizeDoc(odd).doc.nodes).filter((n) => n.x !== odd.nodes[n.id]!.x || n.y !== odd.nodes[n.id]!.y).length;
    expect(changed).toBeGreaterThan(map.n / 2);
  });
});

describe("決まり（同じ地図と同じ opts なら同じ文書）", () => {
  it("2 回組み立てても同じ（中身も JSON の並びも）。共有の部品は文書ごと", () => {
    for (const layout of ["none", "columns"] as const) {
      const a = build(map, { layout });
      const b = build(map, { layout });
      expect(b).toStrictEqual(a);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      const ra = a.nodes[quarterRootId(map)]!;
      const rb = b.nodes[quarterRootId(map)]!;
      expect(rb.meta.st).not.toBe(ra.meta.st);
      expect(rb.tags).not.toBe(ra.tags);
    }
  });

  it("時刻だけ違えば、違うのは時刻と文書の ID だけ", () => {
    const a = build(map);
    const b = build(map, { at: AT + 86_400_000 });
    expect(b.id).not.toBe(a.id);
    const stamp = new Date(AT + 86_400_000).toISOString();
    const back = (x: string) => (x === stamp ? AT_ISO : x);
    const strip = (d: DocData) =>
      JSON.parse(JSON.stringify({ ...d, id: "" }), (k, v: unknown) => ((k === "createdAt" || k === "updatedAt") && typeof v === "string" ? back(v) : v)) as unknown;
    expect(strip(b)).toEqual(strip(a));
  });

  it("時差に依らない: America/Los_Angeles と Asia/Tokyo で同じ文書（同じプロセスで時差を変え、変わったことも確かめる）", () => {
    const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
    const was = env.TZ;
    const docs: DocData[] = [];
    const days: number[] = [];
    try {
      for (const tz of ["America/Los_Angeles", "Asia/Tokyo"]) {
        env.TZ = tz;
        // 2026-11-19 03:00 UTC は、ロサンゼルスでは 18 日、東京では 19 日
        days.push(new Date(Date.UTC(2026, 10, 19, 3)).getDate());
        docs.push(build(map, { layout: "columns" }));
      }
    } finally {
      if (was === undefined) delete env.TZ;
      else env.TZ = was;
    }
    expect(days).toEqual([18, 19]);
    expect(docs[1]).toStrictEqual(docs[0]);
  });

  it("組み立ては時差で変わる Date の読み方を使わない（ローカルの年月日・時刻・toLocale* が無い）", () => {
    expect(quarterDocSrc).not.toMatch(/\.(get|set)(FullYear|Month|Date|Day|Hours|Minutes|Seconds|TimezoneOffset)\(|toLocale|Date\.parse|new Date\((?!opts\.at\))/);
  });
});

describe("ID の重なり・食い違いは止める（黙って組み立てない）", () => {
  /** 地図の問いを一部だけ差し替えた写し */
  const patched = (m: MapData, over: Partial<MapData>): MapData => {
    const out = Object.create(null) as Record<string, unknown>;
    for (const k of ["header", "n", "parent", "childCount", "child", "role", "month", "key", "indexOfKey", "kind", "hours", "isBase", "why", "stub", "q", "todo", "outId", "p", "label", "line", "ln", "e", "rv", "st", "rr", "sum", "band", "mix", "cont", "title", "short"] as const) out[k] = (m as unknown as Record<string, unknown>)[k];
    return { ...(out as unknown as MapData), ...over };
  };

  it("違う鍵が同じ ID（64 ビットの指紋）になる地図・同じ鍵のカードが 2 枚ある地図は QuarterDocError", () => {
    // 本物の重なり: 初めの値だけが違う 2 つの FNV-1a（32 ビット）の両方で同じになる 2 つの鍵（多重衝突で探した。今日 "r" の下の区切りで、. を含まない）
    const [ka, kb] = [COLLIDING_KEYS.a, COLLIDING_KEYS.b];
    expect(ka).not.toBe(kb);
    expect(impactNodeId64(ka)).toBe(impactNodeId64(kb));
    const t = todoTree();
    const opt = (k: string): DevTreeNode => ({ k, r: "a", m: 0, st: stOf(), kind: "sd_grow", h: 2, kids: [{ k: `${k}.all`, r: "e", m: 3, st: stOf(), rr: [1, 0, 0], id: "all", p: 100, lab: "—", line: "", e: [3, 0, 0] }] });
    t.root.kids = [...t.root.kids!, opt(ka), opt(kb)];
    expect(() => build(fromDevTree(t))).toThrow(QuarterDocError);
    expect(() => build(fromDevTree(t))).toThrow(/ID が重なりました（64 ビットの指紋が同じ）/);
    // 同じ鍵が 2 回
    const j = map.child(map.child(0, 1), 0);
    const dup = patched(map, { key: (i) => (i === j ? map.key(map.child(map.child(0, 0), 0)) : map.key(i)) });
    expect(() => build(dup)).toThrow(/同じ鍵のカードが 2 枚/);
    // 64 ビットの ID は小さい木のどの鍵でも重ならない（線・やることの項目の ID はノードと同じ指紋なので、これで重ならない）
    const ids = new Set(Array.from({ length: map.n }, (_, i) => impactNodeId64(map.key(i))));
    expect(ids.size).toBe(map.n);
  });

  it("版・版の順番が地図と違う・時刻が数でない・地図の年月が読めない・期間が整数でない", () => {
    expect(() => buildQuarterDoc(map, { version: "x", release: map.header.release, at: AT })).toThrow(/中身の指紋/);
    expect(() => buildQuarterDoc(map, { version: map.header.hash, release: map.header.release + 1, at: AT })).toThrow(/版の順番/);
    expect(() => buildQuarterDoc(map, { version: map.header.hash, release: map.header.release, at: Number.NaN })).toThrow(QuarterDocError);
    expect(() => build(patched(map, { header: { ...map.header, anchor: "2026/11" } }))).toThrow(/YYYY-MM/);
    expect(() => build(patched(map, { header: { ...map.header, anchor: "1899-11" } }))).toThrow(/範囲の外/);
    expect(() => build(patched(map, { header: { ...map.header, horizon: 36.5 as 36 } }))).toThrow(/期間/);
  });

  it("知らない手の種類の領域・シナリオ・手の種類の無い手・知らない役割・木の形が違う", () => {
    const kinds = map.header.kinds;
    const kind = map.kind(map.child(0, 0))!;
    expect(() => build(patched(map, { header: { ...map.header, kinds: { ...kinds, [kind]: [kinds[kind]![0], "xx" as "sd", kinds[kind]![2], kinds[kind]![3]] } } }))).toThrow(/領域/);
    expect(() => build(patched(map, { header: { ...map.header, kinds: { ...kinds, [kind]: [kinds[kind]![0], kinds[kind]![1], kinds[kind]![2], ["s_nope"]] } } }))).toThrow(/シナリオ/);
    expect(() => build(patched(map, { kind: (i) => (i === map.child(0, 0) ? null : map.kind(i)) }))).toThrow(/手の種類がありません/);
    expect(() => build(patched(map, { role: (i) => (i === 3 ? ("x" as "s") : map.role(i)) }))).toThrow(/知らない役割/);
    expect(() => build(patched(map, { role: (i) => (i === map.child(0, 0) ? "s" : map.role(i)) }))).toThrow(/親の役割/);
    expect(() => build(patched(map, { childCount: (i) => (i === 0 ? map.childCount(0) + 1 : map.childCount(i)) }))).toThrow(/子の数/);
    expect(() => build(patched(map, { parent: (i) => (i === 5 ? 7 : map.parent(i)) }))).toThrow(QuarterDocError);
    // 兄弟の並び（作ったときの順位 rank）が番号の順と違う地図
    expect(() => build(patched(map, { child: (i, k) => (i === 0 && k < 2 ? map.child(0, 1 - k) : map.child(i, k)) }))).toThrow(/兄弟の並び/);
  });
});

describe("共有する部品（テストの組み立てでは凍っている）", () => {
  it("期限・タグ・プロジェクト・シナリオ・状態・月の稼ぎ・判断の線・事実・幅・空の配列・入口の never と fams は凍った共有の部品", () => {
    expect(import.meta.env.DEV).toBe(true);
    const doc = build(fromDevTree(todoTree()));
    const big = build(map);
    const frozenDeep = (x: unknown): boolean => x === null || typeof x !== "object" || (Object.isFrozen(x) && Object.values(x as object).every(frozenDeep));
    for (const d of [doc, big]) {
      for (const n of Object.values(d.nodes)) {
        for (const part of [n.time, n.tags, n.projectIds, n.scenarioIds, n.meta.st, n.meta.rr, n.meta.band, n.meta.cites, n.meta.k0, n.meta.never, n.meta.fams]) if (part !== undefined) expect(frozenDeep(part)).toBe(true);
        if (!n.conditions.length) expect(Object.isFrozen(n.conditions)).toBe(true);
        // カード・meta・項目・q はカードごとの物（凍っていない）
        expect([Object.isFrozen(n), Object.isFrozen(n.meta), n.conditions.length ? Object.isFrozen(n.conditions) : false, Array.isArray(n.meta.q) ? Object.isFrozen(n.meta.q) : false]).toEqual([false, false, false, false]);
      }
      for (const e of Object.values(d.edges)) {
        for (const part of [e.scenarioIds, e.meta.ln, e.meta.rv]) if (part !== undefined) expect(frozenDeep(part)).toBe(true);
        expect([Object.isFrozen(e), Object.isFrozen(e.meta), Array.isArray(e.meta.r) ? Object.isFrozen(e.meta.r) : false]).toEqual([false, false, false]);
      }
    }
    // 書き換えようとすると止まる
    const n = big.nodes[quarterRootId(map)]!;
    expect(() => (n.tags as string[]).push("x")).toThrow(TypeError);
    expect(() => {
      (n.meta.st as { mau: number }).mau = 1;
    }).toThrow(TypeError);
    expect(() => {
      n.time.due = "2030-01-01";
    }).toThrow(TypeError);
  });

  it("同じ中身は 1 つの物（状態・月の稼ぎ・判断の線・期限・タグの数は、中身の違う物の数と同じ）", () => {
    const doc = build(map);
    const nodes = Object.values(doc.nodes);
    const edges = Object.values(doc.edges);
    const count = (xs: unknown[]) => [new Set(xs).size, new Set(xs.map((x) => JSON.stringify(x))).size];
    for (const [what, xs] of [
      ["st", nodes.map((n) => n.meta.st).filter(Boolean)],
      ["rr", nodes.map((n) => n.meta.rr).filter(Boolean)],
      ["band", nodes.map((n) => n.meta.band).filter(Boolean)],
      ["time", nodes.map((n) => n.time)],
      ["tags", nodes.map((n) => n.tags)],
      ["ln", edges.map((e) => e.meta.ln).filter(Boolean)],
      ["rv", edges.map((e) => e.meta.rv).filter(Boolean)],
      ["scenarioIds", edges.map((e) => e.scenarioIds)],
    ] as const) {
      const [objects, values] = count(xs as unknown[]);
      expect([what, objects], `${what}: ${objects} 個の物・${values} 種類の中身`).toEqual([what, values]);
    }
    // 小さい木では 4,333 枚に対して状態は千数百種類
    expect(new Set(nodes.map((n) => n.meta.st).filter(Boolean)).size).toBeLessThan(map.n / 2);
  });
});
