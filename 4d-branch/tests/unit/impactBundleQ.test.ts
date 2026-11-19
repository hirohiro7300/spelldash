// 3 か月ごとの地図の同梱データ（作業メモ SPEC v1 §3.1・§3.2・§2.5・§2.6）: 書き手 scripts/impact/q/bundle.ts・読み手 src/demo/impactBundle.ts・
// 小さな伸長 src/demo/inflate.ts・点検 scripts/impact/q/check.ts・64 ビットの ID・版の記録 scripts/impact/releases.json。
// 本物の生成で作った小さい木（tests/fixtures/q-small.*。8,306 枚・題・短い名前・やることを焼き込んだ物）で、読み手がどのノードのどの問いにも
// fromDevTree() と同じ答えを返すことを確かめる。木の形の点検 S1〜S5（生成の点検。前はこの単体テストだけで見ていた）も、1 か所壊すと通らないことを確かめる。
// 8 万枚の木は impactBundleQFull.test.ts（環境変数があるときだけ）
import { beforeAll, describe, expect, it } from "vitest";
import { bundleHash, bytesToBase64, canonicalizeDevTree, encodeMap, headerForStream } from "../../scripts/impact/q/bundle";
import {
  ACCESSORS,
  appParity,
  checkCalendar,
  checkClients,
  checkDeterminism,
  checkForks,
  checkIds,
  checkN10,
  checkNodes,
  checkReleaseAppend,
  checkReleaseHistory,
  checkSizes,
  checkStructure,
  compareMaps,
  consistencyOfMap,
  forksByFirstMove,
  formatHistory,
  mapValues,
  MAX_GZIP,
  MAX_RAW,
  type ReleaseHistory,
} from "../../scripts/impact/q/check";
import { fnv36, fnv64x36, fnv64x36Bytes, impactEdgeId64, impactNodeId, impactNodeId64, type ImpactSt, type ImpactRelease } from "../../src/demo/impact";
import { base64ToBytes, decodeBundle, decodeBundleBytes, gunzipBytes, ImpactBundleError, SCALE } from "../../src/demo/impactBundle";
import { impactBaselineDigest } from "../../src/demo/impactDigest";
import { BANKS, composeCard } from "../../src/demo/compose";
import { checkBaked } from "../../scripts/impact/q/text";
import { gunzipSync, InflateError } from "../../src/demo/inflate";
import releaseRec from "../../src/demo/impact-release.json";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";
import type { DevTree, DevTreeNode, MapData, MapHeader } from "../../src/deepmap/mapData";
import releasesJson from "../../scripts/impact/releases.json";
import releasesText from "../../scripts/impact/releases.json?raw";
import { gunzipStream, gzipStream, loadQSmall, loadQSmallDevTree, Q_SMALL_B64 } from "./helpers/qSmall";

let dev: DevTree;
let map: MapData;
let ref: MapData;
let stream: Uint8Array;
beforeAll(async () => {
  dev = await loadQSmallDevTree();
  map = await loadQSmall();
  ref = fromDevTree(dev);
  stream = await gunzipStream(base64ToBytes(Q_SMALL_B64));
});

/** バイト列が同じか（大きいバイト列の toEqual は遅いので） */
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** 番号 1 つで答える問いを全部、i で呼ぶ（投げたら投げた物の種類） */
const answers = (m: MapData, i: number): unknown[] =>
  ACCESSORS.map((f) => {
    try {
      return (m[f] as (i: number) => unknown)(i);
    } catch (e) {
      return `投げた: ${(e as Error).name}`;
    }
  });

describe("小さい木（tests/fixtures/q-small）: 本物の生成で作った 2 千〜1 万枚の木", () => {
  it("新しい項目がどれもある（q・mix・cont・幅・事実・訳 4 つ・まとめた手と行き先・入口の never）", () => {
    expect(map.n).toBeGreaterThanOrEqual(2000);
    expect(map.n).toBeLessThanOrEqual(10_000);
    const seen = new Set<string>();
    for (let i = 0; i < map.n; i++) {
      if (map.q(i)) seen.add("q");
      if (map.mix(i)) seen.add("mix");
      if (map.cont(i)) seen.add("cont");
      if (map.band(i)) seen.add("band");
      if (map.rv(i)) seen.add("rv");
      if (map.stub(i)) seen.add("stub");
      if (map.sum(i)) seen.add("sum");
      if (map.isBase(i)) seen.add("base");
      const w = map.why(i);
      if (w) seen.add(`why:${w}`);
      if (map.st(i).j === "i") seen.add("独立");
      if (map.cont(i)?.some((s) => s.ev)) seen.add("ev");
    }
    expect([...seen].sort()).toEqual(["band", "base", "cont", "ev", "mix", "q", "rv", "stub", "sum", "why:area", "why:avoid", "why:best", "why:keep", "独立"].sort());
    expect(Object.keys(map.header.never)).toContain("_all");
    expect(Object.keys(map.header.never).length).toBeGreaterThan(10);
    expect(map.header.counts.nodes).toBe(map.n);
    expect(map.header.release).toBe(0);
  });

  it("題・短い名前・やること（元の番号つき）は焼き込んだ本物の文（仮の文でない）。読み手も fromDevTree() も同じで、その場の組み立てと同じ", () => {
    expect(map.header.textVersion).toBe(BANKS.version);
    let moves = 0;
    for (let i = 0; i < map.n; i++) {
      expect(map.title(i).length).toBeGreaterThan(0);
      if (map.role(i) === "a") {
        moves++;
        const todo = map.todo(i);
        expect(todo.length).toBeGreaterThanOrEqual(1);
        expect(todo.every((t) => t.text.length > 0 && /^[a-z]+(-[a-z0-9]+)+$/.test(t.cite))).toBe(true);
      } else expect(map.todo(i)).toEqual([]);
    }
    expect(moves).toBe(map.header.counts.options);
    // 開発用の木にも同じ文がある（fromDevTree が仮の文を作らない）
    for (const i of [0, 1, 2, map.n - 1]) expect([ref.title(i), ref.short(i), ref.todo(i)]).toEqual([map.title(i), map.short(i), map.todo(i)]);
    expect(map.title(0)).toBe(composeCard(map, 0, { annual: 360 }).title);
    expect(map.title(0)).not.toBe("今日");
    expect(checkBaked(map)).toEqual([]);
  });

  it("読み手は、どのノードのどの問いにも fromDevTree() と同じ答え（子の並び・鍵からの番号・入口も）", () => {
    expect(map.n).toBe(ref.n);
    expect(map.header).toEqual(ref.header);
    expect(compareMaps(ref, map)).toEqual([]);
    // 比べ方に頼らない確かめ: 全ノードの答えを toEqual で
    const bad: number[] = [];
    for (let i = 0; i < map.n; i++) {
      try {
        expect(answers(map, i)).toEqual(answers(ref, i));
      } catch {
        bad.push(i);
      }
    }
    expect(bad).toEqual([]);
  });

  it("範囲の外の番号・無い鍵は fromDevTree() と同じように扱う", () => {
    for (const i of [-1, map.n, 1.5, Number.NaN]) {
      for (const f of ACCESSORS) {
        expect(() => (map[f] as (i: number) => unknown)(i), `${f}(${i})`).toThrow(RangeError);
        expect(() => (ref[f] as (i: number) => unknown)(i), `${f}(${i})`).toThrow(RangeError);
      }
    }
    expect(() => map.child(0, map.childCount(0))).toThrow(RangeError);
    expect(() => map.child(0, -1)).toThrow(RangeError);
    for (const k of ["", "x", "r.", "r.nope", "r..keep", `${map.key(map.n - 1)}.more`, "r.keep.all.x"]) expect(map.indexOfKey(k), k).toBe(ref.indexOfKey(k));
    expect(map.indexOfKey("r")).toBe(0);
  });

  it("返す物は毎回新しい（書き換えても読み手は変わらない）", () => {
    const i = map.n - 1;
    const st = map.st(i);
    st.fl.push("x");
    st.mau = -1;
    expect(map.st(i)).toEqual(ref.st(i));
    const e = map.e(i);
    e[0] = 99;
    expect(map.e(i)).toEqual(ref.e(i));
    const j = [...Array(map.n).keys()].find((k) => map.mix(k))!;
    const mx = map.mix(j)!;
    mx.cl[0] = 99;
    mx.j.e = 2;
    expect(map.mix(j)).toEqual(ref.mix(j));
  });

  it("中身の指紋は決まった並び全体の 64 ビットの指紋（36 進 14 文字）で、開発用の木の入口と同じ", () => {
    expect(map.header.hash).toMatch(/^[0-9a-z]{14}$/);
    expect(map.header.hash).toBe(fnv64x36Bytes(stream));
    expect(map.header.hash).toBe(bundleHash(stream));
    expect(dev.header.hash).toBe(map.header.hash);
    // 入口に hash は入れない（指紋は入口を含む並びから取る）
    expect(JSON.stringify(headerForStream(map.header))).not.toContain(map.header.hash);
  });

  it("決まった並び: 開発用の木からも読んだ地図からも同じバイト列（丸めた木は丸めても変わらない）", () => {
    expect(sameBytes(encodeMap(fromDevTree(dev)), stream)).toBe(true);
    expect(sameBytes(encodeMap(map), stream)).toBe(true);
    const again = canonicalizeDevTree(dev);
    expect(again).toEqual(dev);
    expect(again).not.toBe(dev);
  });

  it("読み手は DecompressionStream が無くても同じ地図を作る（小さな伸長）", async () => {
    const gz = base64ToBytes(Q_SMALL_B64);
    expect(sameBytes(gunzipSync(gz), stream)).toBe(true);
    const g = globalThis as { DecompressionStream?: unknown };
    const saved = g.DecompressionStream;
    try {
      delete g.DecompressionStream;
      expect(typeof DecompressionStream).toBe("undefined");
      expect(sameBytes(await gunzipBytes(gz), stream)).toBe(true);
      const m2 = await decodeBundle(Q_SMALL_B64);
      expect(m2.header).toEqual(map.header);
      expect(compareMaps(map, m2)).toEqual([]);
    } finally {
      g.DecompressionStream = saved;
    }
    // 空白・改行の入った base64 も読む
    expect((await decodeBundle(`${Q_SMALL_B64.slice(0, 100)}\n ${Q_SMALL_B64.slice(100)}\n`)).header.hash).toBe(map.header.hash);
  });

  it("壊れた gzip・base64 は、どちらの伸長でも ImpactBundleError（黙って読まない）", async () => {
    const gz = base64ToBytes(Q_SMALL_B64);
    const broken = gz.slice();
    broken[broken.length - 6]! ^= 1;
    const g = globalThis as { DecompressionStream?: unknown };
    const saved = g.DecompressionStream;
    for (const without of [false, true]) {
      try {
        if (without) delete g.DecompressionStream;
        await expect(decodeBundle(bytesToBase64(broken))).rejects.toThrow(ImpactBundleError);
        await expect(decodeBundle(bytesToBase64(gz.subarray(0, 1000)))).rejects.toThrow(ImpactBundleError);
        await expect(decodeBundle("これは base64 ではない")).rejects.toThrow(ImpactBundleError);
      } finally {
        g.DecompressionStream = saved;
      }
    }
  });
});

describe("§2.6 の点検（scripts/impact/q/check.ts）を小さい木で", () => {
  it("ノードの数・分かれ道・N10・顧客・暦・ID", () => {
    expect(checkNodes(map)).toEqual([]);
    expect(checkNodes(map, map.n - 1)).toHaveLength(1);
    const byMove = forksByFirstMove(map);
    expect(byMove.map((x) => x.kind).sort()).toEqual(["ad_permside", "ind_quit", "keep"]);
    const rep = byMove.map((x) => ({ kind: x.kind, forks: x.forks, target: x.forks }));
    expect(checkForks(map, rep, 0.02)).toEqual([]);
    expect(checkForks(map, rep.map((r) => ({ ...r, target: 2000 })), 0.02)).toHaveLength(3);
    expect(checkForks(map, rep.map((r) => ({ ...r, forks: r.forks + 1 })), 1)).toHaveLength(3);
    expect(checkForks(map, rep.slice(1), 0.02)).toHaveLength(1);
    expect(checkN10(map).fails).toEqual([]);
    expect(checkClients(map)).toEqual([]);
    expect(checkCalendar(map, "2026-11", [5, 17, 29])).toEqual([]);
    expect(checkCalendar(map, "2026-12", [4, 16, 28]).length).toBeGreaterThan(0);
    expect(checkCalendar(map, "2026-11", [5, 17])).toHaveLength(1);
    const ids = checkIds(map);
    expect(ids).toEqual({ fails: [], nodes: map.n, edges: map.n - 1 });
  });

  it("一貫性（年収 360・540 のどちらでも。SPEC v1 §2.8）とアプリと同じ値（年収 360・540 で |差| ≤ 1e-9・一番の手も同じ）", () => {
    for (const annual of [360, 540]) {
      const con = consistencyOfMap(map, annual);
      expect(con.intoStub).toBe(0);
      expect(con.decisions).toBeGreaterThan(500);
    }
    const { parities, fails } = appParity(map, [360, 540]);
    expect(fails).toEqual([]);
    for (const p of parities) {
      expect(p.alts).toBe(map.header.counts.options);
      expect(p.maxDelta).toBeLessThanOrEqual(1e-9);
      expect(p.bestMismatch).toBe(0);
      expect(Math.abs(p.vRoot[0] - p.vRoot[1])).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(p.vSQ[0] - p.vSQ[1])).toBeLessThanOrEqual(1e-9);
    }
    // 値は開発用の木から直接出した値と同じ（読み手の値 = 丸めた木の値）
    expect(mapValues(map, 360).V).toEqual(mapValues(ref, 360).V);
  });

  it("N10・C1・一貫性・読み手の点検は、1 か所壊した地図で通らない（見直し code-1）", () => {
    /** 開発用の木を写して 1 か所変え、読むだけの地図にする（変えるノードは find で選ぶ） */
    const broken = (find: (n: DevTreeNode, parent: DevTreeNode | null) => boolean, change: (n: DevTreeNode) => void): MapData => {
      const t = structuredClone(dev);
      const walk = (n: DevTreeNode, parent: DevTreeNode | null): boolean => {
        if (find(n, parent)) {
          change(n);
          return true;
        }
        return (n.kids ?? []).some((c) => walk(c, n));
      };
      expect(walk(t.root, null)).toBe(true);
      return fromDevTree(t);
    };
    // N10: Pro を出しているのに届け出の答えがまだ（まとめた行き先でない状態）
    const n10 = broken((n) => n.r === "s" && n.st.pm === "?" && n.st.j === "e", (n) => (n.st = { ...n.st, pro: 1 }));
    expect(checkN10(n10).fails.map((f) => f.slice(0, 3))).toEqual(["N10"]);
    // まとめた行き先の代表の状態なら数えるだけ
    const n10sum = broken((n) => !!n.sum && !(n.st.pro === 1 && n.st.pm === "?" && n.st.j === "e"), (n) => (n.st = { ...n.st, pro: 1, pm: "?", j: "e" }));
    expect(checkN10(n10sum).fails).toEqual([]);
    expect(checkN10(n10sum).sumCount).toBe(checkN10(map).sumCount + 1);
    // C1: 幅の無い状態の社数が整数でない・幅が逆・mix の顧客の幅が band と違う
    expect(checkClients(broken((n) => n.r === "s" && !n.band, (n) => (n.st = { ...n.st, cl: 1.5 }))).map((f) => f.slice(0, 2))).toEqual(["C1"]);
    expect(checkClients(broken((n) => n.r === "s" && !!n.band, (n) => (n.band = { cl: [2, 1] }))).map((f) => f.slice(0, 2))).toEqual(["C1"]);
    expect(checkClients(broken((n) => !!n.mix && !!n.band, (n) => (n.mix = { ...n.mix!, cl: [n.band!.cl![0], n.mix!.cl[1], n.band!.cl![1] + 1] }))).length).toBe(1);
    // R1 一貫性: おすすめの道の一番良い手をまとめた手にすると、おすすめの道がまとめた手に入る
    const v = mapValues(map, 360);
    let target = "";
    for (let i = 0; i < map.n && !target; i++) if (map.role(i) === "s" && v.best[i]! >= 0 && !map.stub(v.best[i]!)) target = map.key(v.best[i]!);
    const con = consistencyOfMap(broken((n) => n.k === target, (n) => (n.stub = true)), 360);
    expect(con.intoStub).toBeGreaterThan(0);
    expect(con.fails[0]).toContain("R1");
    // B2 読み手: 1 つの問いの答えが 1 か所だけ違う地図
    const wrapped = Object.create(map) as MapData;
    const k = 7;
    Object.defineProperty(wrapped, "e", { value: (i: number) => (i === k ? [9, 9, 9] : map.e(i)) });
    const diff = compareMaps(map, wrapped);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toContain(`${map.key(k)} の e`);
    const wrongKid = Object.create(map) as MapData;
    Object.defineProperty(wrongKid, "child", { value: (i: number, j: number) => (i === 0 && j === 0 ? map.child(0, 1) : map.child(i, j)) });
    expect(compareMaps(map, wrongKid).some((f) => f.includes("番目の子が違います"))).toBe(true);
  });

  it("S1〜S5 木の形: 小さい木は通り、1 か所壊すとその点検の名前で通らない", () => {
    const menu = ["keep", "ad_permside", "ind_quit"];
    expect(checkStructure(map, menu)).toEqual([]);
    expect(checkStructure(ref, menu)).toEqual([]);
    const codes = (xs: readonly string[]) => [...new Set(xs.map((x) => x.split(" ")[0]))];
    /** 開発用の木を写して 1 か所変え、読むだけの地図にする */
    const broken = (change: (t: DevTree) => void): MapData => {
      const t = structuredClone(dev);
      change(t);
      return fromDevTree(t);
    };
    const firstState = (t: DevTree) => t.root.kids![0]!.kids![0]!;
    // S1: 鍵が親の鍵 + . + 区切りでない
    expect(codes(checkStructure(broken((t) => (firstState(t).k = "r.x.y")), menu))).toEqual(["S1"]);
    // S2: 今日の手の並びが違う・判断の子が手でない（月が違う）
    expect(codes(checkStructure(map, ["keep", "ad_permside", "fc_switch"]))).toEqual(["S2"]);
    expect(codes(checkStructure(broken((t) => (firstState(t).kids![0]!.m += 3)), menu))).toContain("S2");
    // S3: 今のままが最後でない・2 つある
    expect(codes(checkStructure(broken((t) => firstState(t).kids!.reverse()), menu))).toEqual(["S3"]);
    expect(codes(checkStructure(broken((t) => (firstState(t).kids![0]!.base = true)), menu))).toEqual(["S3"]);
    // S4: 見込みの合計が 100 でない・0%
    expect(codes(checkStructure(broken((t) => (t.root.kids![0]!.kids![0]!.p! += 1)), menu))).toEqual(["S4"]);
    const twoOuts = (t: DevTree) => t.root.kids!.find((a) => (a.kids ?? []).length >= 2)!;
    expect(codes(checkStructure(broken((t) => {
      const a = twoOuts(t);
      a.kids![0]!.p! += a.kids![1]!.p!;
      a.kids![1]!.p = 0;
    }), menu))).toEqual(["S4"]);
    // S5: 行き先が 36 か月目でない・まとめた行き先の印がまとめた手と合わない・33 か月目にまとめた手・3 年の前で終わる道
    const findNode = (t: DevTree, f: (n: DevTreeNode) => boolean): DevTreeNode => {
      const st = [t.root];
      while (st.length) {
        const n = st.pop()!;
        if (f(n)) return n;
        st.push(...(n.kids ?? []));
      }
      throw new Error("見つからない");
    };
    expect(codes(checkStructure(broken((t) => (findNode(t, (n) => n.r === "e" && !n.sum).m = 33)), menu))).toEqual(["S5"]);
    expect(codes(checkStructure(broken((t) => (findNode(t, (n) => !!n.sum).sum = false)), menu))).toEqual(["S5"]);
    expect(codes(checkStructure(broken((t) => (findNode(t, (n) => n.r === "a" && n.m === 33).stub = true)), menu))).toEqual(["S5"]);
    expect(codes(checkStructure(broken((t) => (findNode(t, (n) => n.r === "s" && n.m === 33).kids = [])), menu))).toContain("S5");
  });

  it("決まり・大きさの点検は違いを見つける", () => {
    const a = { bytes: stream, hash: map.header.hash, what: "a" };
    expect(checkDeterminism([a, { ...a, what: "b" }])).toEqual([]);
    const flipped = stream.slice();
    flipped[100]! ^= 1;
    expect(checkDeterminism([a, { bytes: flipped, hash: fnv64x36Bytes(flipped), what: "b" }])).toHaveLength(2);
    expect(checkDeterminism([a, { bytes: stream.slice(0, -1), hash: map.header.hash, what: "c" }])).toHaveLength(1);
    expect(checkSizes({ raw: MAX_RAW, gzip: MAX_GZIP, base64: 0 })).toEqual([]);
    expect(checkSizes({ raw: MAX_RAW + 1, gzip: MAX_GZIP + 1, base64: 0 })).toHaveLength(2);
  });
});

/** 小さな作り物の木（生成が書かない項目も: やること・題名・短い名前・名前の無い結果・区切りと違う結果の名前・線の無い結果・種類の無い手・端数の週の時間） */
function synthetic(): DevTree {
  const st = (over: Partial<ImpactSt> = {}): ImpactSt => ({ j: "e", pm: "?", pro: 0, mau: 40, pu: 0, seats: 0, cl: 0, fee: 0, sal: 1, cv: 1, fl: [], ...over });
  const header: MapHeader = {
    v: 3,
    kind: "impact3y",
    title: "作り物",
    anchor: "2027-02",
    horizon: 36,
    annual: 400,
    release: 0,
    hash: "",
    textVersion: "t1",
    kinds: { keep: ["今のまま", "base", "keep", []], ad_permside: ["届け出て副業", "ind", "side", ["s_balance"]] },
    fams: { side: "副業" },
    premises: ["前提 1", "前提 2 😀"],
    never: { _all: [40.123456789, 20.5, 10.25], side: [39.9, 19, 9] },
    counts: { nodes: 9, decisions: 2, options: 4, forks: 3, ends: 4, sumEnds: 2 },
  };
  const root: DevTreeNode = {
    k: "r",
    r: "r",
    m: 0,
    st: st(),
    rr: [1, 0, -0.3],
    title: "今日（😀 2026 年 11 月）",
    short: "今日",
    kids: [
      {
        k: "r.ad_permside",
        r: "a",
        m: 0,
        st: st(),
        kind: "ad_permside",
        h: 5.5,
        why: "best",
        q: [35.123456789, 20.123456, -1.00004],
        todo: [
          { text: "就業規則を読む", cite: "ind-side-01" },
          { text: "届け出の書き方を𠮷田さんに聞く", cite: "ind-side-02" },
        ],
        short: "届け出",
        kids: [
          {
            k: "r.ad_permside.a",
            r: "s",
            m: 3,
            st: st({ pm: "a", cl: 1.5, fee: 3.33333333, fl: ["rt"] }),
            id: "a",
            p: 30,
            lab: "全部可",
            line: "会社の答えが『全部可』",
            ln: ["perm", 3, null, null, "a"],
            e: [3.0000000001, 4.123, -0.004],
            rr: [1.0000004, 1.236, 3.0049],
            rv: ["pm:0", "a"],
            band: { cl: [1, 2], pu: [0, 3] },
            kids: [
              {
                k: "r.ad_permside.a.1k",
                r: "a",
                m: 3,
                st: st({ pm: "a", cl: 1.5, fee: 3.33333333, fl: ["rt"] }),
                kind: "keep",
                base: true,
                why: "keep",
                q: [33, 10, 1],
                kids: [{ k: "r.ad_permside.a.1k.all", r: "e", m: 36, st: st({ pm: "a" }), id: "all", p: 100, lab: "—", line: "（どの場合もこの道）", ln: null, e: [30, 1, 2], rr: [1.2, 3, 4] }],
              },
              {
                k: "r.ad_permside.a.1as",
                r: "a",
                m: 3,
                st: st({ pm: "a", cl: 1.5, fee: 3.33333333, fl: ["rt"] }),
                stub: true,
                why: "area",
                kids: [
                  {
                    k: "r.ad_permside.a.1as.x",
                    r: "e",
                    m: 36,
                    st: st({ pm: "a", cl: 2 }),
                    id: "x_other",
                    p: 100,
                    line: "",
                    e: [33.1234567891, 12.345678, -0.00005],
                    rr: [1.11111111, 2.22222, 3.33333],
                    sum: true,
                    mix: { j: { e: 0.95, p: 0, i: 0.05 }, pm: { "?": 0, a: 1, s: 0, n: 0 }, pro: 0.3333, switched: 0, school: 0.1, cl: [1, 2, 2], pu: [0, 1.5, 3.25], mau: [100, 200.5, 300.25], sal: [1, 1.1, 1.2] },
                    cont: [{ m: 6, kind: "ad_side", ev: "FIRST_CLIENT" }, { m: 9, kind: "keep" }],
                    band: { cl: [1, 2] },
                  },
                ],
              },
            ],
          },
          { k: "r.ad_permside.n", r: "e", m: 36, st: st({ pm: "n" }), id: "n", p: 70, lab: "どちらも不可", line: "会社の答えが『どちらも不可』", ln: ["perm", 3, null, null, "n"], e: [37, 16, 3], rr: [1.2, 1, 1], sum: true, cont: [] },
        ],
      },
      { k: "r.keep", r: "a", m: 0, st: st(), kind: "keep", why: "keep", base: false, kids: [] },
    ],
  };
  return { header, root };
}

describe("書き手と読み手（作り物の木: 生成が書かない項目・端数・文字）", () => {
  // 子の無い手（r.keep）は数を合わせるために 1 枚の行き先を付ける
  const tree = synthetic();
  tree.root.kids![1]!.kids = [{ k: "r.keep.all", r: "e", m: 36, st: tree.root.st, id: "all", p: 100, lab: "—", line: "", ln: ["none", 3, null, null, "all"], e: [36, 0, 0], rr: [1, 0, 0] }];
  tree.header.counts.nodes = 10;

  it("丸めた木の fromDevTree() と、書いて読んだ地図はどの問いにも同じ答え", () => {
    const canon = canonicalizeDevTree(tree);
    const bytes = encodeMap(fromDevTree(tree));
    const m = decodeBundleBytes(bytes);
    canon.header.hash = m.header.hash;
    const r = fromDevTree(canon);
    expect(compareMaps(r, m)).toEqual([]);
    for (let i = 0; i < m.n; i++) expect(answers(m, i), m.key(i)).toEqual(answers(r, i));
    expect(m.todo(1)).toEqual([
      { text: "就業規則を読む", cite: "ind-side-01" },
      { text: "届け出の書き方を𠮷田さんに聞く", cite: "ind-side-02" },
    ]);
    expect(m.title(0)).toBe("今日（😀 2026 年 11 月）");
    expect(m.short(1)).toBe("届け出");
    const x = m.indexOfKey("r.ad_permside.a.1as.x");
    expect([m.outId(x), m.label(x), m.ln(x)]).toEqual(["x_other", "x_other", null]);
    expect(m.isBase(m.indexOfKey("r.keep"))).toBe(false);
    expect(m.hours(1)).toBe(5.5);
    expect(m.header.never._all).toEqual([40.123456789, 20.5, 10.25]);
    expect(m.cont(m.indexOfKey("r.ad_permside.n"))).toEqual([]);
    expect(sameBytes(encodeMap(m), bytes)).toBe(true);
  });

  it("丸めの精度: 結果の e は 0.0001 か月・0.01 万円、まとめた行き先の e と q は 0.000001 か月・0.0001 万円、−0 は 0", () => {
    const canon = canonicalizeDevTree(tree);
    const a = canon.root.kids![0]!;
    expect(a.q).toEqual([35.123457, 20.1235, -1]);
    expect(Object.is(a.q![2], -1)).toBe(true);
    const s = a.kids![0]!;
    expect(s.e).toEqual([3, 4.12, 0]);
    expect(Object.is(s.e![2], 0)).toBe(true);
    expect(s.rr).toEqual([1, 1.24, 3]);
    expect(s.st.fee).toBe(3.3333);
    const sum = s.kids![1]!.kids![0]!;
    expect(sum.e).toEqual([33.123457, 12.3457, 0]);
    expect(Object.is(sum.e![2], 0)).toBe(true);
    expect(sum.rr).toEqual([1.1111, 2.22, 3.33]);
    // 丸めの差は倍率の半分まで
    const half = (x: number, y: number, s: number) => Math.abs(x - y) <= 0.5 / s + 1e-12;
    expect(half(33.1234567891, sum.e![0]!, SCALE.eSum[0])).toBe(true);
    expect(half(3.0000000001, s.e![0]!, SCALE.e[0])).toBe(true);
    // 元の木は変えない
    expect(tree.root.kids![0]!.q).toEqual([35.123456789, 20.123456, -1.00004]);
  });

  it("書けない木は投げる（鍵が親の鍵 + 区切りでない・区切りに . ・見込みが整数でない・数でない値・入口の数が違う・月が負）", () => {
    const bad = (f: (t: DevTree) => void) => {
      const t = structuredClone(tree);
      f(t);
      return () => encodeMap(fromDevTree(t));
    };
    expect(bad(() => {})).not.toThrow();
    expect(bad((t) => (t.root.kids![1]!.k = "x.keep"))).toThrow(/親の鍵/);
    expect(bad((t) => (t.root.kids![1]!.kids![0]!.k = "r.keep.a.b"))).toThrow(/親の鍵|区切り/);
    expect(bad((t) => (t.root.kids![1]!.kids![0]!.p = 99.5))).toThrow(/整数/);
    expect(bad((t) => (t.root.kids![1]!.kids![0]!.e = [Number.NaN, 0, 0]))).toThrow(/数/);
    expect(bad((t) => (t.header.counts.nodes = 11))).toThrow(/ノードの数/);
    expect(bad((t) => (t.root.kids![1]!.m = -3))).toThrow(/月/);
    expect(bad((t) => (t.root.kids![1]!.st = { ...t.root.st, j: "x" as "e" }))).toThrow(/状態/);
  });

  it("読み手は壊れた並びを黙って読まない（形・版・途中で切れた・後ろの余り。1 バイトを変えても ImpactBundleError か別の指紋）", () => {
    const bytes = encodeMap(fromDevTree(tree));
    const throwsBundle = (b: Uint8Array) => {
      try {
        decodeBundleBytes(b);
      } catch (e) {
        return e instanceof ImpactBundleError;
      }
      return false;
    };
    const wrongMagic = bytes.slice();
    wrongMagic[0] = 0x35;
    expect(throwsBundle(wrongMagic)).toBe(true);
    const wrongFormat = bytes.slice();
    wrongFormat[4] = 2;
    expect(throwsBundle(wrongFormat)).toBe(true);
    for (let cut = 0; cut < bytes.length; cut++) expect(throwsBundle(bytes.subarray(0, cut)), `長さ ${cut}`).toBe(true);
    expect(throwsBundle(new Uint8Array([...bytes, 0]))).toBe(true);
    // 1 バイトを変える: 投げるなら ImpactBundleError だけ。読めたら指紋が違い、どの問いも投げない
    let thrown = 0;
    let read = 0;
    let seed = 12345;
    const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
    for (let k = 0; k < 400; k++) {
      const b = bytes.slice();
      const at = Math.floor(rnd() * b.length);
      b[at] = (b[at]! + 1 + Math.floor(rnd() * 255)) & 255;
      let m: MapData | null = null;
      try {
        m = decodeBundleBytes(b);
      } catch (e) {
        expect(e, `位置 ${at}`).toBeInstanceOf(ImpactBundleError);
        thrown++;
        continue;
      }
      read++;
      expect(m.header.hash).not.toBe(fnv64x36Bytes(bytes));
      for (let i = 0; i < m.n; i++) expect(() => answers(m!, i)).not.toThrow();
      for (let i = 0; i < m.n; i++) expect(answers(m, i).some((x) => typeof x === "string" && x.startsWith("投げた")), `位置 ${at}・${i}`).toBe(false);
    }
    expect(thrown + read).toBe(400);
    expect(thrown).toBeGreaterThan(100);
  });
});

describe("小さな伸長（DecompressionStream の無い環境の代わり）", () => {
  const rand = (n: number, seed: number) => {
    const out = new Uint8Array(n);
    let s = seed;
    for (let i = 0; i < n; i++) out[i] = (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) >>> 24;
    return out;
  };
  it("CompressionStream の gzip を同じバイト列に戻す（空・短い・繰り返し・ばらばら・長い距離）", async () => {
    const text = new TextEncoder().encode("3 年の分かれ道 ".repeat(5000));
    const runs = new Uint8Array(200_000).map((_, i) => (i % 70_000 < 40_000 ? 7 : i % 251));
    const mixed = new Uint8Array(150_000);
    mixed.set(rand(40_000, 1), 0);
    mixed.set(rand(40_000, 1), 70_000);
    const cases = [new Uint8Array(0), new TextEncoder().encode("a"), new TextEncoder().encode("hello, 世界"), text, runs, rand(100_000, 7), mixed];
    for (const raw of cases) expect(sameBytes(gunzipSync(await gzipStream(raw)), raw), `長さ ${raw.length}`).toBe(true);
  });

  it("そのまま入れた塊（type 0）と、名前・注釈・余分の付いた gzip の枠を読む", () => {
    const payload = new TextEncoder().encode("stored block の中身");
    const crc = crc32(payload);
    const le32 = (x: number) => [x & 255, (x >>> 8) & 255, (x >>> 16) & 255, (x >>> 24) & 255];
    const len = payload.length;
    const deflate = [1, len & 255, len >> 8, ~len & 255, (~len >> 8) & 255, ...payload];
    // FEXTRA（4）・FNAME（8）・FCOMMENT（16）・FHCRC（2）
    const head = [0x1f, 0x8b, 8, 4 | 8 | 16 | 2, 0, 0, 0, 0, 0, 3, 2, 0, 0xaa, 0xbb, ...new TextEncoder().encode("x.bin"), 0, ...new TextEncoder().encode("c"), 0, 0, 0];
    const gz = new Uint8Array([...head, ...deflate, ...le32(crc), ...le32(len)]);
    expect(gunzipSync(gz)).toEqual(payload);
  });

  it("壊れた gzip は投げる（印・CRC・長さ・途中で切れた・後ろの余り）", async () => {
    const raw = new TextEncoder().encode("壊れたデータの確かめ ".repeat(200));
    const gz = await gzipStream(raw);
    const bad = (f: (b: Uint8Array) => Uint8Array) => () => gunzipSync(f(gz.slice()));
    expect(bad((b) => b)).not.toThrow();
    expect(bad((b) => ((b[0] = 0), b))).toThrow(InflateError);
    expect(bad((b) => ((b[2] = 7), b))).toThrow(InflateError);
    expect(bad((b) => ((b[b.length - 6]! ^= 1), b))).toThrow(InflateError);
    expect(bad((b) => ((b[b.length - 2]! ^= 1), b))).toThrow(InflateError);
    expect(bad((b) => b.subarray(0, b.length - 20))).toThrow(InflateError);
    expect(bad((b) => new Uint8Array([...b.subarray(0, b.length - 8), 0, ...b.subarray(b.length - 8)]))).toThrow(InflateError);
    let same = 0;
    for (let k = 0; k < 400; k++) {
      const b = gz.slice();
      const at = 10 + ((k * 7919) % (b.length - 18));
      b[at]! ^= 1 << (k % 8);
      // 中の 1 ビットを変えると、読めないか CRC が合わない（どちらでも InflateError）。最後の塊の後の詰め物のビットなら同じ中身。違う中身は返さない
      let out: Uint8Array | null = null;
      try {
        out = gunzipSync(b);
      } catch (e) {
        expect(e, `位置 ${at}`).toBeInstanceOf(InflateError);
        continue;
      }
      expect(sameBytes(out, raw), `位置 ${at}`).toBe(true);
      same++;
    }
    expect(same).toBeLessThan(10);
  });
});

/** CRC-32（テストの gzip を手で作る用） */
function crc32(b: Uint8Array): number {
  let c = -1;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ -1) >>> 0;
}

describe("64 ビットの ID（作業メモ SPEC v1 §2.5・D9。版 6 の 32 ビットの ID はそのまま）", () => {
  it("n_i_ / e_i_ + 36 進 14 文字。1 つ目の 7 桁は版 6 の FNV-1a と同じで、決まった値", () => {
    for (const k of ["r", "r.keep", "r.ad_permside.s.1fp.same.2fw.none.3fw2.none.4fw2.none", "日本語の鍵"]) {
      const id = impactNodeId64(k);
      expect(id).toMatch(/^n_i_[0-9a-z]{14}$/);
      expect(impactEdgeId64(k)).toBe(`e_i_${id.slice(4)}`);
      expect(id.slice(0, 11)).toBe(impactNodeId(k));
      expect(fnv64x36(k).slice(0, 7)).toBe(fnv36(k).padStart(7, "0"));
    }
    expect(impactNodeId64("r")).toBe("n_i_1wjoydx1p4tor5");
    expect(impactNodeId64("r.keep")).toBe("n_i_1v9ej4k0pz4b7k");
    expect(impactNodeId("r")).toBe("n_i_1wjoydx");
    // バイト列の指紋は、ASCII の文字列の指紋と同じ作り
    expect(fnv64x36Bytes(new TextEncoder().encode("r.keep.all"))).toBe(fnv64x36("r.keep.all"));
    expect(fnv64x36("")).toBe(fnv64x36Bytes(new Uint8Array(0)));
  });

  it("小さい木のどの鍵でも重ならない（ノード・線）", () => {
    const ids = new Set<string>();
    for (let i = 0; i < map.n; i++) ids.add(impactNodeId64(map.key(i)));
    expect(ids.size).toBe(map.n);
  });
});

describe("版の記録（scripts/impact/releases.json。足すだけ）", () => {
  const h = releasesJson as unknown as ReleaseHistory;
  /** 本番の形で作った記録の作った形（2,000・±2%・今日の 10 手・never・2 回） */
  const prodBuild = { B: 2000, tol: 0.02, moves: 10, never: true, runs: 2, nodes: 71_619 };
  it("記録は点検に通り、決まった書き方のままで、最後はアプリが同梱している版 6 と同じ", () => {
    expect(checkReleaseHistory(h)).toEqual([]);
    expect(formatHistory(h)).toBe(releasesText);
    const last = h.releases.at(-1)!;
    const rec = releaseRec as ImpactRelease;
    expect([last.release, last.hash]).toEqual([rec.release, rec.version]);
  });

  it("同じ（版の順番・指紋）は足さずに済み、戻る順番・使い直す順番・使った指紋は断る", () => {
    expect(checkReleaseAppend(h, { release: 7, hash: "0123456789abcd" }).verdict).toBe("append");
    expect(checkReleaseAppend(h, { release: 6, hash: "bvpn-apwrrf" }).verdict).toBe("same");
    expect(checkReleaseAppend(h, { release: 6, hash: "0123456789abcd" }).verdict).toBe("refuse");
    expect(checkReleaseAppend(h, { release: 5, hash: "0123456789abcd" }).verdict).toBe("refuse");
    expect(checkReleaseAppend(h, { release: 8, hash: "bvpn-apwrrf" }).verdict).toBe("refuse");
    expect(checkReleaseAppend(h, { release: 8, hash: "bl06-12wmu46" }).verdict).toBe("refuse");
    const withR7: ReleaseHistory = { ...h, releases: [...h.releases, { release: 7, hash: "0123456789abcd", scheme: "q1", anchor: "2026-11", build: prodBuild }] };
    expect(checkReleaseHistory(withR7)).toEqual([]);
    expect(checkReleaseAppend(withR7, { release: 7, hash: "0123456789abce" }).verdict).toBe("refuse");
    expect(formatHistory(withR7).split("\n").length).toBe(releasesText.split("\n").length + 1);
  });

  it("記録の点検は、戻る・同じ順番が 2 つ・同じ指紋が 2 つ・形の違う指紋を見つける", () => {
    const base = h.releases;
    const q = (release: number, hash: string) => ({ release, hash, scheme: "q1" as const, build: prodBuild });
    expect(checkReleaseHistory({ releases: [...base, q(7, "0123456789abcd"), q(7, "0123456789abce")] })).toHaveLength(1);
    expect(checkReleaseHistory({ releases: [...base, q(5, "0123456789abcd")] })).toHaveLength(1);
    expect(checkReleaseHistory({ releases: [...base, q(7, "0123456789abcd"), q(8, "0123456789abcd")] })).toHaveLength(1);
    expect(checkReleaseHistory({ releases: [...base, q(7, "bvpn-apwrrf")] }).length).toBeGreaterThanOrEqual(1);
    expect(checkReleaseHistory({ releases: [...base, q(7, "short")] })).toHaveLength(1);
  });

  it("3 か月ごとの地図の記録（q1）は本番の形で作った物だけ（試しの木で版の番号を使い切らない。format-1）", () => {
    const rec = (build: Partial<typeof prodBuild> | null) => ({ releases: [...h.releases, { release: 7, hash: "0123456789abcd", scheme: "q1" as const, ...(build ? { build: { ...prodBuild, ...build } } : {}) }] });
    expect(checkReleaseHistory(rec({}))).toEqual([]);
    expect(checkReleaseHistory(rec({ moves: 11 }))).toEqual([]);
    for (const bad of [{ B: 40 }, { tol: 12 }, { moves: 1 }, { never: false }, { runs: 1 }, { nodes: 0 }, { nodes: 90_001 }]) {
      const f = checkReleaseHistory(rec(bad));
      expect(f, JSON.stringify(bad)).toHaveLength(1);
      expect(f[0]).toContain("本番の形");
    }
    expect(checkReleaseHistory(rec(null))[0]).toContain("作った形 build がありません");
    // 足せるかの判断も、本番の形でない記録の上には足さない
    expect(checkReleaseAppend(rec({ B: 40 }), { release: 8, hash: "0123456789abce" }).verdict).toBe("refuse");
    // 実際の記録（版 6 まで）の q1 はどれも本番の形
    for (const r of h.releases) if (r.scheme === "q1") expect(r.build).toMatchObject({ B: 2000, never: true, runs: 2 });
  });

  it("基準の文書の指紋はまだ作っていない（W-store が作る。入口の形だけ決めてある）", () => {
    expect(() => impactBaselineDigest({} as never, "n_i_x")).toThrow(/W-store/);
  });
});

describe("base64", () => {
  it("書き手の base64 は読み手の base64 と往復する", () => {
    const b = new Uint8Array(70_000).map((_, i) => (i * 31) & 255);
    expect(sameBytes(base64ToBytes(bytesToBase64(b)), b)).toBe(true);
    expect(() => base64ToBytes("@@@")).toThrow(ImpactBundleError);
  });
});
