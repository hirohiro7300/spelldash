// 基準の文書の指紋（src/demo/impactDigest.ts。作業メモ SPEC v1 §6・§2.6、見直し safety-4・safety-14）。
// 3 か月ごとの地図から軽い組み立て（buildQuarterDoc）で作った文書の、カードごとの 鍵・ID・親・親からの線・やることの項目・プロジェクト・シナリオ・タグ・期限 の指紋。
// 決まった値（小さい木）・組み立ての時刻と位置に依らない・時差に依らない・入れる物のどれが変わっても変わる・入れない物では変わらない・版の記録
import { beforeAll, describe, expect, it } from "vitest";
import { fnv64x36, impactEdgeId64, impactNodeId64 } from "../../src/demo/impact";
import { DIGEST_AT, DIGEST_FORMAT, Fnv64Stream, impactBaselineDigest, mapBaselineDigest, quarterReleaseOf } from "../../src/demo/impactDigest";
import impactDigestSrc from "../../src/demo/impactDigest.ts?raw";
import { buildQuarterDoc, quarterRootId } from "../../src/demo/quarterDoc";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";
import type { MapData } from "../../src/deepmap/mapData";
import type { DocData, GNode } from "../../src/model/types";
import { handTree } from "./deepmapFixtures";
import { loadQSmall } from "./helpers/qSmall";

/**
 * 小さい木（tests/fixtures/q-small）の基準の文書の指紋。組み立ての鍵・ID・線・タグ・期限の作りを変えるとこの値が変わる:
 * 変わったら、その版の地図を使っている人の薄い形の文書が読めなくなる（同じ版のまま基準が変わる）ので、版の順番を進めてからこの値を直す
 */
const Q_SMALL_DIGEST = "1mz094e0w56p6q";

let map: MapData;
beforeAll(async () => {
  map = await loadQSmall();
});

const build = (m: MapData, at = DIGEST_AT, layout: "none" | "columns" = "none"): DocData => buildQuarterDoc(m, { version: m.header.hash, release: m.header.release, at, layout });
const digestOf = (doc: DocData, m: MapData): string => impactBaselineDigest(doc, quarterRootId(m));
/** JSON で写した文書（書き換えて試す。元の文書の共有の部品は凍っている） */
const copy = (doc: DocData): DocData => JSON.parse(JSON.stringify(doc)) as DocData;

describe("基準の文書の指紋", () => {
  it("36 進 14 文字・小さい木は決まった値・版の記録 {release, hash, digest, anchor}", () => {
    const d = mapBaselineDigest(map);
    expect(d).toMatch(/^[0-9a-z]{14}$/);
    expect(d).toBe(Q_SMALL_DIGEST);
    expect(digestOf(build(map), map)).toBe(d);
    expect(quarterReleaseOf(map)).toEqual({ release: 0, hash: map.header.hash, digest: Q_SMALL_DIGEST, anchor: "2026-11" });
    expect(DIGEST_FORMAT).toBe("4DQD1");
  });

  it("組み立ての時刻・位置の決め方・カードと線の入れた順に依らない（兄弟は作ったときの順位の順にたどる）", () => {
    const d = mapBaselineDigest(map);
    expect(digestOf(build(map, Date.UTC(2031, 5, 7, 8, 9), "columns"), map)).toBe(d);
    const doc = build(map);
    const reversed: DocData = { ...doc, nodes: Object.fromEntries(Object.entries(doc.nodes).reverse()), edges: Object.fromEntries(Object.entries(doc.edges).reverse()) };
    expect(digestOf(reversed, map)).toBe(d);
    // 地図が違えば違う
    expect(mapBaselineDigest(fromDevTree(handTree()))).not.toBe(d);
  });

  it("時差に依らない: America/Los_Angeles と Asia/Tokyo で同じ値（同じプロセスで時差を変え、変わったことも確かめる）", () => {
    const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
    const was = env.TZ;
    const out: Array<[number, string]> = [];
    try {
      for (const tz of ["America/Los_Angeles", "Asia/Tokyo"]) {
        env.TZ = tz;
        out.push([new Date(Date.UTC(2026, 10, 19, 3)).getDate(), mapBaselineDigest(map)]);
      }
    } finally {
      if (was === undefined) delete env.TZ;
      else env.TZ = was;
    }
    expect(out).toEqual([
      [18, Q_SMALL_DIGEST],
      [19, Q_SMALL_DIGEST],
    ]);
    expect(impactDigestSrc).not.toMatch(/\.(get|set)(FullYear|Month|Date|Day|Hours|Minutes|Seconds|TimezoneOffset)\(|toLocale|Date\.parse/);
  });

  it("Fnv64Stream は、足した文字をつないだ物の fnv64x36 と同じ（日本語・サロゲートペア・空も）", () => {
    const parts = ["r.fc_switch.high", "\u0001", "", "日本語の鍵", "😀", "n_i_0123456789abcd", "\u0002", "2029-11-30"];
    const s = new Fnv64Stream();
    for (const p of parts) s.add(p);
    expect(s.digest()).toBe(fnv64x36(parts.join("")));
    expect(new Fnv64Stream().digest()).toBe(fnv64x36(""));
    expect(new Fnv64Stream().addList(["a", "b", "c"]).digest()).toBe(fnv64x36("a\u0002b\u0002c"));
    expect(new Fnv64Stream().addList([]).digest()).toBe(fnv64x36(""));
  });

  it("入れる物（鍵・ID・親・線の ID・やることの項目の ID・プロジェクト・シナリオ・タグ・期限）のどれが変わっても変わる", () => {
    const m = fromDevTree(handTree());
    const base = build(m);
    const d0 = digestOf(base, m);
    // 手で作った地図には深い手がある: 今日の 1 つ目の手の 1 つ目の結果の 1 つ目の手（やることの項目を足して試す）
    const deep = m.child(m.child(m.child(0, 0), 0), 0);
    const deepId = impactNodeId64(m.key(deep));
    const deepEdge = impactEdgeId64(m.key(deep));
    const withTodo = (d: DocData): DocData => {
      const n = d.nodes[deepId]!;
      d.nodes[deepId] = { ...n, conditions: [{ id: "c_x_0", text: "やること", met: false }] };
      return d;
    };
    const t0 = digestOf(withTodo(copy(base)), m);
    expect(t0).not.toBe(d0);
    const node = (d: DocData): GNode => d.nodes[deepId]!;
    const cases: Array<[string, (d: DocData) => void]> = [
      ["鍵", (d) => void (node(d).meta.key = `${m.key(deep)}x`)],
      [
        "ID",
        (d) => {
          const n = node(d);
          delete d.nodes[deepId];
          d.nodes[`${deepId}x`] = { ...n, id: `${deepId}x` };
          for (const e of Object.values(d.edges)) {
            if (e.source === deepId) e.source = `${deepId}x`;
            if (e.target === deepId) e.target = `${deepId}x`;
          }
        },
      ],
      [
        "親",
        (d) => {
          // 同じ判断の別の結果の下へ付け替える（順位はそのまま）
          const parent = m.parent(deep);
          const other = m.child(m.parent(parent), 1);
          d.edges[deepEdge]!.source = impactNodeId64(m.key(other));
        },
      ],
      [
        "線の ID",
        (d) => {
          const e = d.edges[deepEdge]!;
          delete d.edges[deepEdge];
          d.edges[`${deepEdge}x`] = { ...e, id: `${deepEdge}x` };
        },
      ],
      ["やることの項目の ID", (d) => void (node(d).conditions[0]!.id = "c_x_9")],
      ["プロジェクト", (d) => void (node(d).projectIds = ["p_spelldash"])],
      ["カードのシナリオ", (d) => void (node(d).scenarioIds = ["s_balance"])],
      ["線のシナリオ", (d) => void (d.edges[deepEdge]!.scenarioIds = ["s_focus"])],
      ["タグ", (d) => void (node(d).tags = [...node(d).tags, "自分のタグ"])],
      ["期限", (d) => void (node(d).time = { ...node(d).time, due: "2030-01-31" })],
      ["始まり", (d) => void (node(d).time = { ...node(d).time, start: "2027-01-01" })],
    ];
    for (const [what, change] of cases) {
      const d = withTodo(copy(base));
      change(d);
      expect([what, digestOf(d, m) !== t0]).toEqual([what, true]);
    }
    // 入れない物（題名・本文・位置・時刻・状態・見込み・線の説明・meta の数）では変わらない
    const same: Array<[string, (d: DocData) => void]> = [
      ["題名", (d) => void (node(d).title = "書き換えた題名")],
      ["本文", (d) => void (node(d).body = "自分のメモ")],
      ["位置", (d) => void Object.assign(node(d), { x: 1234, y: -5678 })],
      ["時刻", (d) => void (node(d).updatedAt = "2030-01-01T00:00:00.000Z")],
      ["状態", (d) => void (node(d).status = "active")],
      ["見込み", (d) => void (d.edges[impactEdgeId64(m.key(m.child(deep, 0)))]!.meta.prob = 77)],
      ["線の説明", (d) => void (d.edges[deepEdge]!.label = "自分の説明")],
      ["項目のチェック", (d) => void (node(d).conditions[0]!.met = true)],
    ];
    for (const [what, change] of same) {
      const d = withTodo(copy(base));
      change(d);
      expect([what, digestOf(d, m)]).toEqual([what, t0]);
    }
  });

  it("今日から道の線で届く、鍵のあるカードだけを見る（自分で足したカードと線は入らない）。今日が無ければ投げる", () => {
    const doc = copy(build(map));
    const d0 = digestOf(doc, map);
    const root = quarterRootId(map);
    doc.nodes.n_own = { ...doc.nodes[root]!, id: "n_own", meta: {}, title: "自分のカード" };
    doc.edges.e_own = { ...doc.edges[impactEdgeId64(map.key(map.child(0, 0)))]!, id: "e_own", source: root, target: "n_own" };
    doc.edges.e_back = { ...doc.edges.e_own, id: "e_back", source: "n_own", target: root };
    expect(digestOf(doc, map)).toBe(d0);
    expect(() => impactBaselineDigest(doc, "n_none")).toThrow(/今日のカード/);
    expect(() => impactBaselineDigest(doc, "n_own")).toThrow(/今日のカード/);
  });
});
