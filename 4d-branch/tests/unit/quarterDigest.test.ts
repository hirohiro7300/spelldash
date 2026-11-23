// 基準の文書の指紋（src/demo/impactDigest.ts。作業メモ SPEC v1 §6・§2.6、見直し safety-4・safety-14・compat-2）。
// 3 か月ごとの地図から軽い組み立て（buildQuarterDoc）で作った文書の、カードごとの 鍵・ID・親・親からの線・やることの項目・やることの元の番号・
// プロジェクト・シナリオ・タグ・期限 の指紋。決まった値（小さい木）・組み立ての時刻と位置に依らない・時差に依らない・入れる物のどれが変わっても変わる・
// 入れない物では変わらない・利用者が足した線（地図のカードどうしでも）では変わらない・版の記録
import { beforeAll, describe, expect, it } from "vitest";
import { fnv64x36, impactEdgeId64, impactNodeId64 } from "../../src/demo/impact";
import { DIGEST_AT, DIGEST_FORMAT, Fnv64Stream, impactBaselineDigest, mapBaselineDigest, quarterReleaseOf } from "../../src/demo/impactDigest";
import impactDigestSrc from "../../src/demo/impactDigest.ts?raw";
import { buildQuarterDoc, quarterRootId } from "../../src/demo/quarterDoc";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";
import type { MapData } from "../../src/deepmap/mapData";
import type { DevTree, DevTreeNode } from "../../src/deepmap/mapData";
import type { DocData, GEdge, GNode, Relation } from "../../src/model/types";
import { handTree } from "./deepmapFixtures";
import { loadQSmall } from "./helpers/qSmall";

/**
 * 小さい木（tests/fixtures/q-small）の基準の文書の指紋。組み立ての鍵・ID・線・タグ・期限の作りを変えるとこの値が変わる:
 * 変わったら、その版の地図を使っている人の薄い形の文書が読めなくなる（同じ版のまま基準が変わる）ので、版の順番を進めてからこの値を直す。
 * 小さい木そのものを作り直したとき（生成 v2 で焼き込んだやることが入った等。版の順番 0 の試験用で、配っていない）も値は変わる。
 * 組み立てが変わっていないことは、前の小さい木で前の値（08ywb3s0oh106s）が出ることで確かめてから直す。
 * 文の型 1.1（W4・rep-14: 手引きの歩みをその期の状況で先に取る）で焼き込んだやることの項目が変わり 178pivj0gb2qln → 0q6mgtw00zqla8
 * （前の小さい木では今の組み立てでも前の値 178pivj0gb2qln が出ることを確かめた）
 */
const Q_SMALL_DIGEST = "0q6mgtw00zqla8";

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
    expect(DIGEST_FORMAT).toBe("4DQD2");
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
      d.nodes[deepId] = {
        ...n,
        conditions: [
          { id: "c_x_0", text: "やること", met: false },
          { id: "c_x_1", text: "もう 1 つ", met: false },
        ],
        meta: { ...n.meta, cites: ["ind-side-d05", "ind-side-d22"] },
      };
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
      ["やることの元の番号", (d) => void (node(d).meta.cites = ["ind-side-d05", "ind-side-d23"])],
      ["やることの元の番号の枠（入れ替え）", (d) => void (node(d).meta.cites = ["ind-side-d22", "ind-side-d05"])],
      ["やることの元の番号が無い", (d) => void delete node(d).meta.cites],
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
      ["項目の文", (d) => void (node(d).conditions[0]!.text = "書き換えた項目")],
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

  /** 利用者が引いた線（作ったときの ID の形ではない） */
  const userEdge = (id: string, source: string, target: string, relation: Relation): GEdge => ({
    id,
    source,
    target,
    relation,
    label: "",
    condition: "",
    scenarioIds: [],
    collapsed: false,
    createdAt: "2026-12-01T00:00:00.000Z",
    updatedAt: "2026-12-01T00:00:00.000Z",
    meta: {},
  });
  const idOf = (i: number) => impactNodeId64(map.key(i));

  it("利用者が地図のカードどうしに引いた線（先へ・後ろへ・祖先から子孫へ・同じ親子の 2 本目。進む・条件付き・相乗効果）では変わらない（見直し compat-2）", () => {
    const base = build(map);
    const d0 = digestOf(base, map);
    // 深さ優先の番号: 前のカードから後のカードへ・後から前へ・今日から深いカードへ・手からその孫へ・親から子へ（組み立ての線と同じ両端）
    const first = map.child(0, 0);
    const last = map.child(0, map.childCount(0) - 1);
    let deep = last;
    while (map.childCount(deep) > 0) deep = map.child(deep, map.childCount(deep) - 1);
    const grand = map.child(map.child(first, 0), 0);
    const pairs: Array<[number, number]> = [
      [first, deep],
      [deep, first],
      [0, deep],
      [first, grand],
      [first, map.child(first, 0)],
      [map.child(first, 0), map.child(last, 0)],
    ];
    let k = 0;
    for (const [a, b] of pairs)
      for (const rel of ["leads", "condition", "supports"] as const) {
        const d = copy(base);
        const e = userEdge(`e_user${++k}`, idOf(a), idOf(b), rel);
        d.edges[e.id] = e;
        expect([map.key(a), map.key(b), rel, digestOf(d, map)]).toEqual([map.key(a), map.key(b), rel, d0]);
      }
    // 決まった種の乱数で 150 本（1 つの文書に全部引いても同じ）
    let x = 0x5eed;
    const rnd = (m: number) => ((x = (Math.imul(x, 1103515245) + 12345) >>> 0) % m);
    const many = copy(base);
    for (let j = 0; j < 150; j++) {
      const a = rnd(map.n);
      const b = 1 + rnd(map.n - 1);
      if (a === b) continue;
      const e = userEdge(`e_rand${j}`, idOf(a), idOf(b), (["leads", "condition", "supports"] as const)[j % 3]!);
      many.edges[e.id] = e;
    }
    expect(digestOf(many, map)).toBe(d0);
  });

  it("組み立ての線が無い鍵のカード: 親の鍵がちょうど合う線だけを親からの線にする（祖先からの線は選ばない）。組み立ての線と違うので指紋は変わる", () => {
    const base = build(map);
    const d0 = digestOf(base, map);
    // 今日の 1 つ目の手の 1 つ目の結果の 1 つ目の手（親の鍵 = 鍵の最後の "." より前）
    const c = map.child(map.child(map.child(0, 0), 0), 0);
    const p = map.parent(c);
    const eid = impactEdgeId64(map.key(c));
    expect(map.key(p)).toBe(map.key(c).slice(0, map.key(c).lastIndexOf(".")));
    // 組み立ての線を消し、利用者が同じ親から引き直した: たどれる（指紋は線の ID の分だけ変わる）。2 本あれば ID の小さい方
    const relinked = (ids: string[]) => {
      const d = copy(base);
      const e = d.edges[eid]!;
      delete d.edges[eid];
      for (const id of ids) d.edges[id] = userEdge(id, idOf(p), idOf(c), e.relation);
      return digestOf(d, map);
    };
    const one = relinked(["e_user_a"]);
    expect(one).not.toBe(d0);
    expect(relinked(["e_user_b", "e_user_a"])).toBe(one);
    expect(relinked(["e_user_a", "e_user_b"])).toBe(one);
    // 祖先（今日）からの線だけでは、そのカードの下はたどらない（親の鍵が違う）。どの線も無いのと同じ
    const fromRoot = copy(base);
    delete fromRoot.edges[eid];
    const cut = digestOf(fromRoot, map);
    fromRoot.edges.e_user_root = userEdge("e_user_root", idOf(0), idOf(c), "leads");
    expect(digestOf(fromRoot, map)).toBe(cut);
    expect(cut).not.toBe(d0);
    expect(cut).not.toBe(one);
  });
});

describe("基準の文書の指紋とやることの元の番号（見直し compat-2・SPEC §6 safety-8）", () => {
  /** 今日の 1 つ目の手にやることを入れた手の木 */
  const treeWith = (todo: Array<{ text: string; cite: string }>): DevTree => {
    const t = handTree();
    (t.root.kids![0] as DevTreeNode).todo = todo;
    return t;
  };
  const a = { text: "会社の副業の決まりを読む", cite: "ind-side-d05" };
  const b = { text: "届け出を出す", cite: "ind-side-d22" };
  const digestTree = (t: DevTree): { d: string; conds: string[]; cites: unknown } => {
    const m = fromDevTree(t);
    const doc = build(m);
    const n = doc.nodes[impactNodeId64(m.key(1))]!;
    return { d: digestOf(doc, m), conds: n.conditions.map((c) => c.id), cites: n.meta.cites };
  };

  it("項目の枠（c_…_0・_1）は同じでも、元の番号を別の枠に入れる組み立ては別の指紋（文と元を一緒に入れ替える・元だけずれる）", () => {
    const x = digestTree(treeWith([a, b]));
    const swapped = digestTree(treeWith([b, a]));
    const shifted = digestTree(treeWith([{ ...a, cite: b.cite }, { ...b, cite: a.cite }]));
    expect(swapped.conds).toEqual(x.conds);
    expect(shifted.conds).toEqual(x.conds);
    expect([x.cites, swapped.cites, shifted.cites]).toEqual([
      [a.cite, b.cite],
      [b.cite, a.cite],
      [b.cite, a.cite],
    ]);
    expect(swapped.d).not.toBe(x.d);
    expect(shifted.d).not.toBe(x.d);
    // 文だけ変えても同じ（文は中身の指紋 header.hash が持つ）
    expect(digestTree(treeWith([{ ...a, text: "別の文" }, b])).d).toBe(x.d);
  });
});
