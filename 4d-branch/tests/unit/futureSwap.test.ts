import { describe, expect, it } from "vitest";
import { Commands } from "../../src/app/commands";
import { DEFAULT_PREFS, UiState } from "../../src/app/uiState";
import { ViewModel } from "../../src/app/viewModel";
import { buildDemoDoc } from "../../src/demo/demo";
import { buildFuture, futureRelease, futureVersion } from "../../src/demo/futureBundle";
import { futureAge, futureMaps, hasEditPrints, hasStaleFuture, inPlaceRoot, newerFutureMaps, staleFutureMaps, swapFutureDoc } from "../../src/demo/futureSwap";
import { buildImpactDoc, edgeTextPrint, fnv36, impactDataVersion, impactTagsOf, nextImpactRelease, type ImpactBundle, type ImpactOutX } from "../../src/demo/impact";
import raw from "../../src/demo/impact-data.json?raw";
import releaseFile from "../../src/demo/impact-release.json";
import { primaryImpactRoot } from "../../src/model/forks";
import { createEmptyDoc, makeEdge, makeNode, normalizeDoc } from "../../src/model/schema";
import type { DocData, GEdge, GNode, ID } from "../../src/model/types";
import { mergeDocs } from "../../src/persist/io";
import { Store } from "../../src/store/store";
import { R6_RELEASE, buildR6Future, r6Bundle } from "./helpers/r6";

const TODAY = new Date(2026, 10, 18);
// 版 6 の地図（凍結した写し tests/fixtures/impact-r6.json）と、それを少し変えた次の版で確かめる（新しい版にする仕組みは、
// 版 6 のような鍵の地図のまま残る。今の同梱データが 3 か月ごとの地図に替わっても、ここは版 6 のまま）。版の順番の確かめだけは今の同梱データ
const data = r6Bundle();

/** 同梱データを少し変えた次の版（edit で変える） */
function nextBundle(edit: (b: ImpactBundle) => void): ImpactBundle {
  const b = structuredClone(data);
  edit(b);
  return b;
}
/** 同梱データから作る地図（アプリが読み込むのと同じ検証を通す） */
const mapOf = (b: ImpactBundle, version: string, release: number): DocData => normalizeDoc(buildImpactDoc(b, TODAY, version, release)).doc;

const at = (b: ImpactBundle, key: string) => {
  const i = b.nodes.findIndex((n) => n[0] === key);
  if (i < 0) throw new Error(key);
  return { i, n: b.nodes[i]! };
};
/** 葉（3 年後の行き先）を消す（後ろの親の番号を詰める） */
function dropLeaf(b: ImpactBundle, key: string): void {
  const { i } = at(b, key);
  if (b.nodes.some((n) => n[1] === i)) throw new Error(`葉ではない: ${key}`);
  b.nodes.splice(i, 1);
  for (const n of b.nodes) if (n[1] > i) n[1]--;
}
/** like を写して、親の下に葉を足す */
function addLeaf(b: ImpactBundle, parent: string, like: (typeof data.nodes)[number], key: string, title: string): void {
  const n = structuredClone(like);
  n[0] = key;
  n[1] = at(b, parent).i;
  n[4] = title;
  b.nodes.push(n);
}

const byKey = (d: DocData, key: string): GNode | undefined => Object.values(d.nodes).find((n) => n.meta.key === key);
const edgeBetween = (d: DocData, a: string, b: string): GEdge | undefined => {
  const s = byKey(d, a)?.id;
  const t = byKey(d, b)?.id;
  return Object.values(d.edges).find((e) => e.source === s && e.target === t);
};
const rootOf = (d: DocData) => Object.values(d.nodes).find((n) => n.meta.forecastRoot === true)!;
const annualOf = (n: GNode) => (n.meta.impact as { annual?: number }).annual;

function setup(doc: DocData) {
  const store = new Store(doc);
  const ui = new UiState(structuredClone(DEFAULT_PREFS));
  ui.persistPrefs = false;
  const vm = new ViewModel(store, ui);
  vm.narrow = () => false;
  const cmd = new Commands(store, ui, vm, { toast: () => undefined, viewCenter: () => ({ x: 0, y: 0 }), startEdit: () => undefined, reveal: () => undefined, confirm: async () => true });
  return { store, cmd };
}

// 次の版で変える所
const GONE = "r.ad_permside.a0_a1.ad_side.cl1.plan_side.cl2";
const GONE_PARENT = "r.ad_permside.a0_a1.ad_side.cl1.plan_side";
const NEW = `${GONE_PARENT}.cl9`;
const next = nextBundle((b) => {
  at(b, "r.sd_grow").n[4] = "遊ぶ人を増やす（次の版）";
  at(b, "r.ad_permside").n[4] = "届け出て副業の 1 社目を探す（次の版）";
  at(b, "r.ad_permside").n[6] = "次の版の本文";
  // 転職活動の結果の見込み: 大きく上げて 10 → 15、転職せず 72 → 67
  (at(b, "r.fc_switch.high").n[7] as ImpactOutX).p = 15;
  (at(b, "r.fc_switch.none").n[7] as ImpactOutX).p = 67;
  const like = at(b, GONE).n;
  dropLeaf(b, GONE);
  addLeaf(b, GONE_PARENT, like, NEW, "次の版で増えた行き先");
});
// 次の版の地図と、手を入れた今の地図は一度だけ作って使い回す（swapFutureDoc は渡した文書を変えない。並べて走る計算の速さのテストを邪魔しない）
let nextMemo: DocData | null = null;
const nextDoc = (): DocData => (nextMemo ??= mapOf(next, "next-version", R6_RELEASE.release + 1));
let editedMemo: ReturnType<typeof buildEdited> | null = null;
const edited = (): ReturnType<typeof buildEdited> => (editedMemo ??= buildEdited());

/** 今の版の地図に、利用者が手を入れた物（どれも新しい版にしても残るはずの物） */
function buildEdited() {
  const { store, cmd } = setup(buildR6Future(TODAY).pv.doc);
  const d = () => store.doc;
  const root = rootOf(d());
  // 自分で足した手（今日の下）とその先、外のメモからの「相乗効果」の線
  const mine = cmd.createNode("action", { x: root.x, y: root.y + 4000 }, { from: [root.id], title: "資格を取る（自分の手）", exact: true })!;
  const mineKid = cmd.createNode("result", { x: root.x + 300, y: root.y + 4000 }, { from: [mine], title: "資格が取れた", exact: true })!;
  const note = cmd.createNode("goal", { x: -9000, y: -9000 }, { title: "外のメモ", exact: true })!;
  const [sup] = cmd.connect([note], mine, "supports");
  // 3 年後の行き先から自分のノードへつなぐ（つなぐと「進む」になる）
  const end = byKey(d(), `${GONE_PARENT}.cl1`) ?? Object.values(d().nodes).find((n) => n.meta.end === true && n.meta.key !== GONE)!;
  const own = cmd.createNode("goal", { x: -8000, y: 8000 }, { title: "事務所を借りる（自分のノード）", exact: true })!;
  const own2 = cmd.createNode("result", { x: -7700, y: 8000 }, { title: "事務所で働く", exact: true })!;
  const [l1] = cmd.connect([end.id], own);
  const [l2] = cmd.connect([own], own2);
  // 新しい版で無くなるカードの下に足したノード
  const orphan = cmd.createNode("action", { x: -7000, y: -7000 }, { title: "消えるカードの下のメモ", exact: true })!;
  const [l3] = cmd.connect([byKey(d(), GONE)!.id], orphan);
  // 選んだ手・チェック・見送り・年収
  const sw = byKey(d(), "r.fc_switch")!;
  cmd.setStatus([sw.id], "active");
  cmd.updateNode(sw.id, { conditions: sw.conditions.map((c, i) => (i === 0 ? { ...c, met: true } : c)) });
  cmd.setStatus([byKey(d(), "r.sd_pilot")!.id], "dropped");
  const r = d().nodes[root.id]!;
  cmd.updateNode(root.id, { meta: { ...r.meta, impact: { ...(r.meta.impact as object), annual: 540 } } });
  // 書き換え: タイトル（次の版も変える）・本文（次の版は変えない）・タグ
  cmd.updateNode(byKey(d(), "r.sd_grow")!.id, { title: "遊ぶ人を増やす（自分の言葉）" });
  const sw2 = byKey(d(), "r.fc_switch")!;
  cmd.updateNode(sw2.id, { body: "自分で書いたメモ", tags: [...sw2.tags, "自分のタグ"] });
  // 見込みの書き換え（次の版も変える線）と、説明・条件の書き換え
  const high = edgeBetween(d(), "r.fc_switch", "r.fc_switch.high")!;
  cmd.updateEdge(high.id, { meta: { ...high.meta, prob: 77 } });
  const side = edgeBetween(d(), "r.ad_permside", "r.ad_permside.s")!;
  cmd.updateEdge(side.id, { label: "自分の説明", condition: "自分の条件" });
  return { doc: d(), root: root.id, mine, mineKid, note, sup: sup!, own, own2, l1: l1!, l2: l2!, orphan, l3: l3!, endKey: end.meta.key as string };
}

describe("3 年の分かれ道を新しい版にする（同じ地図のまま）", () => {
  it("同梱のカードだけを鍵で合わせて新しくし、ID・利用者が足したノードと線・決めたこと・書き換えた所は残す", () => {
    const u = edited();
    const old = u.doc;
    const incoming = nextDoc();
    expect(inPlaceRoot(old, incoming)).toBe(u.root);
    const res = swapFutureDoc(old, incoming);
    const d = res.doc;
    expect(res.inPlace).toBe(true);
    expect(res.root).toBe(u.root);
    expect(res.removed).toBe(1);
    expect(res.added).toBe(1);

    // 鍵の残るカードは ID と作った時刻がそのまま。カードどうしの線も ID がそのまま
    for (const n of Object.values(old.nodes)) {
      const k = n.meta.key;
      if (typeof k !== "string" || k === GONE) continue;
      expect(d.nodes[n.id]?.meta.key, k).toBe(k);
      expect(d.nodes[n.id]!.createdAt).toBe(n.createdAt);
    }
    for (const e of Object.values(old.edges)) {
      const s = old.nodes[e.source]!;
      const t = old.nodes[e.target]!;
      if (typeof s.meta.key !== "string" || typeof t.meta.key !== "string" || t.meta.key === GONE) continue;
      expect(d.edges[e.id], e.id).toBeDefined();
      expect([d.edges[e.id]!.source, d.edges[e.id]!.target]).toEqual([e.source, e.target]);
    }
    // 無くなった鍵のカードは線ごと消え、増えた鍵のカードが足される（同梱の決まった ID）
    expect(byKey(d, GONE)).toBeUndefined();
    const added = byKey(d, NEW)!;
    expect(added.title).toBe("次の版で増えた行き先");
    expect(edgeBetween(d, GONE_PARENT, NEW)).toBeDefined();
    expect(Object.keys(incoming.nodes)).toContain(added.id);

    // 利用者が足したノードと線は残る（消えたカードの下のノードは、つながりの無いノードとして残る）
    for (const id of [u.mine, u.mineKid, u.note, u.own, u.own2, u.orphan]) expect(d.nodes[id], old.nodes[id]!.title).toEqual(old.nodes[id]);
    for (const id of [u.sup, u.l1, u.l2]) expect(d.edges[id]).toEqual(old.edges[id]);
    expect(Object.values(d.edges).some((e) => e.source === u.root && e.target === u.mine)).toBe(true);
    expect(Object.values(d.edges).some((e) => e.source === u.mine && e.target === u.mineKid)).toBe(true);
    expect(d.edges[u.l3]).toBeUndefined();
    expect(Object.values(d.edges).some((e) => e.target === u.orphan)).toBe(false);
    // 地図につながったまま残ったのは、自分の手・その先・行き先の先の 2 つ（消えたカードの下の物は数えない）
    expect(res.userKept).toBe(4);
    // ほかのノードは 1 つも消えない（消えたのは無くなった鍵のカードだけ）
    for (const id of Object.keys(old.nodes)) if (old.nodes[id]!.meta.key !== GONE) expect(d.nodes[id], id).toBeDefined();
    expect(Object.keys(d.nodes).length).toBe(Object.keys(old.nodes).length);
    for (const e of Object.values(d.edges)) expect(!!d.nodes[e.source] && !!d.nodes[e.target], e.id).toBe(true);

    // 決めたこと: 選んだ手・チェック・見送り・年収
    const sw = byKey(d, "r.fc_switch")!;
    expect(sw.status).toBe("active");
    expect(sw.conditions[0]!.met).toBe(true);
    expect(byKey(d, "r.sd_pilot")!.status).toBe("dropped");
    const root = d.nodes[u.root]!;
    expect(annualOf(root)).toBe(540);
    expect(root.meta.futureVersion).toBe("next-version");
    expect(root.meta.futureRelease).toBe(R6_RELEASE.release + 1);
    expect(Object.values(d.nodes).filter((n) => n.meta.forecastRoot === true).length).toBe(1);

    // 書き換えたタイトル・本文・タグは残り、指紋は新しい版の物（次の版でも書き換えたと分かる）
    const grow = byKey(d, "r.sd_grow")!;
    expect(grow.title).toBe("遊ぶ人を増やす（自分の言葉）");
    expect(grow.meta.t0).toBe(fnv36("遊ぶ人を増やす（次の版）"));
    expect(sw.body).toBe("自分で書いたメモ");
    expect(sw.tags).toContain("自分のタグ");
    // 書き換えていない文は新しい版になる
    const perm = byKey(d, "r.ad_permside")!;
    expect(perm.title).toBe("届け出て副業の 1 社目を探す（次の版）");
    expect(perm.body).toBe("次の版の本文");

    // 見込み: 直した % は残り（元の見込みは新しい版の物）、直していない % は新しい版になる。書き換えた説明・条件は残る
    const high = edgeBetween(d, "r.fc_switch", "r.fc_switch.high")!;
    expect(high.meta.prob).toBe(77);
    expect(high.meta.p0).toBe(15);
    expect(edgeBetween(d, "r.fc_switch", "r.fc_switch.none")!.meta.prob).toBe(67);
    const side = edgeBetween(d, "r.ad_permside", "r.ad_permside.s")!;
    expect([side.label, side.condition]).toEqual(["自分の説明", "自分の条件"]);
    expect(edgeBetween(d, "r.ad_permside", "r.ad_permside.n")!.condition).toBe(edgeBetween(incoming, "r.ad_permside", "r.ad_permside.n")!.condition);

    // 数: 文章か数字の変わったカード（本文と題を変えたカード・見込みの変わった 2 枚・増えた行き先の親は数えない）
    expect(res.updated).toBeGreaterThanOrEqual(3);
    expect(res.kept).toBeGreaterThanOrEqual(6);
    // 同じ版を当て直しても何も変わらない（書き換えた所も残ったまま）
    const again = swapFutureDoc(d, mapOf(next, "next-version", R6_RELEASE.release + 1));
    expect([again.updated, again.added, again.removed]).toEqual([0, 0, 0]);
    expect(byKey(again.doc, "r.sd_grow")!.title).toBe("遊ぶ人を増やす（自分の言葉）");
    expect(edgeBetween(again.doc, "r.fc_switch", "r.fc_switch.high")!.meta.prob).toBe(77);
  });

  it("書き換えたタイトル・見込みは、その次の版でも書き換えた物として残る", () => {
    const first = swapFutureDoc(edited().doc, nextDoc()).doc;
    const third = nextBundle((b) => {
      at(b, "r.sd_grow").n[4] = "遊ぶ人を増やす（3 つ目の版）";
      (at(b, "r.fc_switch.high").n[7] as ImpactOutX).p = 20;
      (at(b, "r.fc_switch.none").n[7] as ImpactOutX).p = 62;
    });
    const d = swapFutureDoc(first, mapOf(third, "third", R6_RELEASE.release + 2)).doc;
    expect(byKey(d, "r.sd_grow")!.title).toBe("遊ぶ人を増やす（自分の言葉）");
    expect(edgeBetween(d, "r.fc_switch", "r.fc_switch.high")!.meta.prob).toBe(77);
    expect(edgeBetween(d, "r.fc_switch", "r.fc_switch.none")!.meta.prob).toBe(62);
  });

  it("地図のカードから自分のノードへつないでも、新しい版にしたときにそのノードと先のノードは消えない", () => {
    const demo = buildDemoDoc();
    const merged = mergeDocs(demo, buildR6Future(TODAY).pv.doc).doc;
    const { store, cmd } = setup(merged);
    const target = Object.values(store.doc.nodes).find((n) => n.title.startsWith("広告運用を学ぶ"))!;
    // 3 年後の行き先・選択肢・結果のカードから、それぞれ自分のノードへ（つなぐと「進む」「条件付き」になる）
    const end = Object.values(store.doc.nodes).find((n) => n.meta.end === true && n.meta.key !== GONE)!;
    const from = [end, byKey(store.doc, "r.ad_permside")!, byKey(store.doc, "r.fc_switch.none")!];
    const links = from.map((f) => cmd.connect([f.id], target.id)[0]!);
    for (const l of links) expect(["leads", "condition"]).toContain(store.doc.edges[l]!.relation);
    // 新しい版で無くなるカードからも
    const goneLink = cmd.connect([byKey(store.doc, GONE)!.id], target.id)[0]!;
    const map = futureMaps(store.doc)[0]!;
    const pulled = Object.keys(demo.nodes).filter((id) => map.nodes.has(id));
    expect(pulled.length).toBeGreaterThan(3);
    const res = swapFutureDoc(store.doc, nextDoc());
    for (const id of Object.keys(demo.nodes)) expect(res.doc.nodes[id], demo.nodes[id]!.title).toEqual(store.doc.nodes[id]);
    for (const e of Object.values(store.doc.edges)) if (demo.nodes[e.source] && demo.nodes[e.target]) expect(res.doc.edges[e.id]).toEqual(e);
    for (const l of links) expect(res.doc.edges[l]).toEqual(store.doc.edges[l]);
    // 無くなったカードからの線だけが消える（つないだ先のノードは残る）
    expect(res.doc.edges[goneLink]).toBeUndefined();
    expect(res.inPlace).toBe(true);
  });

  it("指紋の無い地図（前の版のアプリで読み込んだ物）: 文章と見込みは新しい版になり、利用者が足したノードと決めたことは残る", () => {
    const u = edited();
    // 指紋と版の順番を外す（前の版のアプリで読み込んだ地図と同じ形）
    const legacy: DocData = { ...u.doc, nodes: { ...u.doc.nodes }, edges: { ...u.doc.edges } };
    for (const [id, n] of Object.entries(legacy.nodes)) {
      const { t0: _t, b0: _b, k0: _k, futureRelease: _r, ...meta } = n.meta;
      legacy.nodes[id] = { ...n, meta: n.meta.forecastRoot ? { ...meta, futureVersion: "bdyw-18fku5" } : meta };
    }
    for (const [id, e] of Object.entries(legacy.edges)) {
      const { p0: _p, c0: _c, ...meta } = e.meta;
      legacy.edges[id] = { ...e, meta };
    }
    expect(staleFutureMaps(legacy, R6_RELEASE.version, R6_RELEASE.release).length).toBe(1);
    const res = swapFutureDoc(legacy, nextDoc());
    const d = res.doc;
    expect(res.inPlace).toBe(true);
    expect(byKey(d, "r.sd_grow")!.title).toBe("遊ぶ人を増やす（次の版）");
    expect(byKey(d, "r.fc_switch")!.body).toBe(byKey(nextDoc(), "r.fc_switch")!.body);
    expect(edgeBetween(d, "r.fc_switch", "r.fc_switch.high")!.meta.prob).toBe(15);
    expect(edgeBetween(d, "r.ad_permside", "r.ad_permside.s")!.label).toBe(edgeBetween(nextDoc(), "r.ad_permside", "r.ad_permside.s")!.label);
    // 新しい版の指紋が付く（この次からは書き換えを見分けられる）
    expect(byKey(d, "r.sd_grow")!.meta.t0).toBe(fnv36("遊ぶ人を増やす（次の版）"));
    for (const id of [u.mine, u.mineKid, u.note, u.own, u.own2, u.orphan]) expect(d.nodes[id]).toBeDefined();
    expect(byKey(d, "r.fc_switch")!.status).toBe("active");
    expect(byKey(d, "r.fc_switch")!.tags).toContain("自分のタグ");
    expect(annualOf(d.nodes[u.root]!)).toBe(540);
    for (const n of Object.values(legacy.nodes)) if (typeof n.meta.key === "string" && n.meta.key !== GONE) expect(d.nodes[n.id]?.meta.key).toBe(n.meta.key);
  });

  it("入口が 2 つ（別の地図を足した）: 数字と概要を出す入口の年収を引き継ぎ、もう 1 つの地図は消す", () => {
    for (const first of ["a", "b"] as const) {
      const a = buildR6Future(TODAY).pv.doc;
      const b = buildR6Future(TODAY).pv.doc;
      const ra = rootOf(a);
      const rb = rootOf(b);
      a.nodes[ra.id] = { ...ra, createdAt: first === "a" ? "2026-01-01T00:00:00.000Z" : "2026-03-01T00:00:00.000Z", meta: { ...ra.meta, impact: { ...(ra.meta.impact as object), annual: 540 } } };
      b.nodes[rb.id] = { ...rb, createdAt: first === "b" ? "2026-01-01T00:00:00.000Z" : "2026-03-01T00:00:00.000Z", meta: { ...rb.meta, impact: { ...(rb.meta.impact as object), annual: 300 } } };
      const doc = mergeDocs(a, b).doc;
      const roots = Object.values(doc.nodes).filter((n) => n.meta.forecastRoot === true);
      expect(roots.length).toBe(2);
      const primary = primaryImpactRoot(doc)!;
      const res = swapFutureDoc(doc, nextDoc());
      const after = Object.values(res.doc.nodes).filter((n) => n.meta.forecastRoot === true);
      expect(after.map((n) => n.id)).toEqual([primary]);
      expect(annualOf(after[0]!)).toBe(first === "a" ? 540 : 300);
      // もう 1 つの地図は消え、残った地図は新しい版のカードの数
      expect(Object.keys(res.doc.nodes).length).toBe(next.nodes.length);
    }
  });

  it("今日を複製したカードは入口にならない（印を外した自分のカード）。新しい版にしても自分のカードとして残り、年収は入口の物", () => {
    const { store, cmd } = setup(buildR6Future(TODAY).pv.doc);
    const root = rootOf(store.doc);
    cmd.updateNode(root.id, { meta: { ...root.meta, impact: { ...(root.meta.impact as object), annual: 540 } } });
    const [dup] = cmd.duplicate([root.id]);
    const d0 = store.doc.nodes[dup!]!;
    for (const k of ["forecastRoot", "impact", "key", "futureVersion", "futureRelease", "t0", "b0", "k0", "fams"]) expect(d0.meta[k]).toBeUndefined();
    expect(primaryImpactRoot(store.doc)).toBe(root.id);
    const res = swapFutureDoc(store.doc, nextDoc());
    expect(res.doc.nodes[dup!]?.title).toBe(d0.title);
    expect(res.doc.nodes[dup!]!.meta.forecastRoot).toBeUndefined();
    expect(Object.values(res.doc.nodes).filter((n) => n.meta.forecastRoot === true).map((n) => n.id)).toEqual([root.id]);
    expect(annualOf(res.doc.nodes[root.id]!)).toBe(540);
  });

  it("入口の手の種類の名前（meta.fams）は新しい版の物になる（名前の無い前の版の地図にも入る。年収は残る）", () => {
    const u = edited();
    // 名前を持つ前の版で読み込んだ地図（入口に meta.fams が無い）
    const root0 = u.doc.nodes[u.root]!;
    const { fams: _f, ...meta0 } = root0.meta;
    const old: DocData = { ...u.doc, nodes: { ...u.doc.nodes, [u.root]: { ...root0, meta: meta0 } } };
    const third = nextBundle((b) => {
      b.fams = { ...b.fams!, side: "広告運用の副業（次の版）" };
    });
    const res = swapFutureDoc(old, mapOf(third, "third", R6_RELEASE.release + 2));
    const root = res.doc.nodes[u.root]!;
    expect(res.inPlace).toBe(true);
    expect(root.meta.fams).toEqual(third.fams);
    expect(annualOf(root)).toBe(540);
    // 名前のある地図も、新しい版の名前に（入口は更新したカードに数える）
    const again = swapFutureDoc(res.doc, mapOf(next, "next-version", R6_RELEASE.release + 3));
    expect(again.doc.nodes[u.root]!.meta.fams).toEqual(next.fams);
    expect((again.doc.nodes[u.root]!.meta.fams as Record<string, string>).side).not.toBe(third.fams!.side);
    // 入れ替え（v1 の地図）でも、新しい版の入口の名前
    const v1 = createEmptyDoc();
    v1.nodes.n_f_S0 = makeNode({ id: "n_f_S0", title: "今日", x: 0, y: 0, meta: { forecastRoot: true, futureVersion: "v1" } });
    const swapped = swapFutureDoc(v1, mapOf(third, "third", R6_RELEASE.release + 2));
    expect(swapped.inPlace).toBe(false);
    expect(swapped.doc.nodes[swapped.root!]!.meta.fams).toEqual(third.fams);
  });

  it("同じ版を当てても何も変わらない（ID も文章も見込みも）", () => {
    const u = edited();
    const res = swapFutureDoc(u.doc, buildR6Future(TODAY).pv.doc);
    expect([res.inPlace, res.updated, res.added, res.removed]).toEqual([true, 0, 0, 0]);
    expect(Object.keys(res.doc.nodes).sort()).toEqual(Object.keys(u.doc.nodes).sort());
    expect(Object.keys(res.doc.edges).sort()).toEqual(Object.keys(u.doc.edges).sort());
    for (const [id, n] of Object.entries(u.doc.nodes)) {
      const m = res.doc.nodes[id]!;
      expect([m.title, m.body, m.status, m.conditions, m.tags], id).toEqual([n.title, n.body, n.status, n.conditions, n.tags]);
    }
    for (const [id, e] of Object.entries(u.doc.edges)) expect([res.doc.edges[id]!.label, res.doc.edges[id]!.condition, res.doc.edges[id]!.meta.prob]).toEqual([e.label, e.condition, e.meta.prob]);
  });

  it("速い: 1,600 ノードの地図を 50 ms 未満で新しい版にする（ほかの処理と重なってもよいように、5 回のうち一番速い物が 100 ms まで）", () => {
    const old = edited().doc;
    const incoming = nextDoc();
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      swapFutureDoc(old, incoming);
      best = Math.min(best, performance.now() - t0);
    }
    expect(Object.keys(old.nodes).length).toBeGreaterThan(1500);
    expect(best).toBeLessThan(100);
  });

  it("線の指紋と元の見込みは、同梱の線にだけ付く（自分で引いた線には付かない）", () => {
    const doc = buildR6Future(TODAY).pv.doc;
    for (const e of Object.values(doc.edges)) {
      expect(e.meta.c0).toBe(edgeTextPrint(e.label, e.condition));
      if (e.relation === "condition") expect(e.meta.p0).toBe(e.meta.prob);
      else expect(e.meta.p0).toBeUndefined();
    }
    for (const n of Object.values(doc.nodes)) expect([n.meta.t0, n.meta.b0]).toEqual([fnv36(n.title), fnv36(n.body)]);
    expect(rootOf(doc).meta.futureRelease).toBe(R6_RELEASE.release);
    const fresh = makeEdge({ source: "a", target: "b" });
    expect(fresh.meta.c0).toBeUndefined();
  });

  it("自分で引いたカードどうしの線（指紋の無い線）は、新しい版にしても残る", () => {
    const { store, cmd } = setup(buildR6Future(TODAY).pv.doc);
    const a = byKey(store.doc, "r.fc_switch.none")!;
    const b = byKey(store.doc, "r.sd_grow")!;
    const [own] = cmd.connect([a.id], b.id);
    const res = swapFutureDoc(store.doc, nextDoc());
    expect(res.doc.edges[own!]).toEqual(store.doc.edges[own!]);
  });

  it("同じ鍵のカードが 2 つ（複製を今日の下につないだ）: 先に作った方を同梱のカードとして新しくし、複製は利用者のノードのまま残す", () => {
    // 地図を作った時刻を前にずらす（複製は押した時刻で作られ、必ず後になる）
    const base = buildR6Future(TODAY).pv.doc;
    for (const [id, n] of Object.entries(base.nodes)) base.nodes[id] = { ...n, createdAt: "2026-01-01T00:00:00.000Z" };
    const { store, cmd } = setup(base);
    const root = rootOf(store.doc);
    const orig = byKey(store.doc, "r.fc_scope.all")!;
    const kids = Object.values(store.doc.edges).filter((e) => e.source === orig.id).map((e) => e.id);
    expect(kids.length).toBeGreaterThan(0);
    const [dup] = cmd.duplicate([orig.id]);
    const [link] = cmd.connect([root.id], dup!);
    const res = swapFutureDoc(store.doc, nextDoc());
    const d = res.doc;
    const parents = (id: ID) => Object.values(d.edges).filter((e) => e.target === id).map((e) => d.nodes[e.source]!.meta.key);
    expect(parents(orig.id)).toEqual(["r.fc_scope"]);
    for (const id of kids) expect(d.edges[id]?.source, id).toBe(orig.id);
    // 複製は今日からの自分の線だけを持ったまま（同梱の線は付け替えない）
    expect(parents(dup!)).toEqual(["r"]);
    expect(d.edges[link!]).toEqual(store.doc.edges[link!]);
    expect(Object.values(d.edges).some((e) => e.source === dup)).toBe(false);
    expect(d.nodes[dup!]).toEqual(store.doc.nodes[dup!]);
    expect(Object.keys(d.nodes).length).toBe(Object.keys(store.doc.nodes).length);
  });
});

/** 2 つ以上のノードが持つ鍵 */
const dupKeys = (d: DocData): string[] => {
  const seen = new Map<string, number>();
  for (const n of Object.values(d.nodes)) if (typeof n.meta.key === "string") seen.set(n.meta.key, (seen.get(n.meta.key) ?? 0) + 1);
  return [...seen].filter(([, c]) => c > 1).map(([k]) => k);
};
/** 地図（入口から道の線でたどれるノード）に入っているか */
const inMap = (d: DocData, id: ID) => futureMaps(d).some((m) => m.nodes.has(id));
/** 数字と概要を出す入口の地図の大きさ（入口から道の線でたどれるノードの数） */
const mapSize = (d: DocData) => futureMaps(d).find((m) => m.root === primaryImpactRoot(d))!.nodes.size;
/** 選択肢（鍵）から道の線で出る先の鍵（鍵の無いノードは題名） */
const flowKids = (d: DocData, key: string) => {
  const id = byKey(d, key)!.id;
  return Object.values(d.edges)
    .filter((e) => e.source === id && (e.relation === "leads" || e.relation === "condition"))
    .map((e) => (d.nodes[e.target]!.meta.key as string | undefined) ?? `（鍵なし）${d.nodes[e.target]!.title}`)
    .sort();
};

/**
 * 前の版のアプリ（入口からたどれるカードだけを鍵で合わせた）で新しい版にした地図をまねる（doc は変えない）: 地図から外れた鍵のノードは
 * そのまま残り、入口からたどれるカードに無い鍵のカードは、新しい版（fresh）の物を新しい ID・後の作った時刻（at）で足し、同梱の線でつなぐ
 */
function oldAppUpgrade(doc: DocData, fresh: DocData, at: string): DocData {
  const out = structuredClone(doc);
  const reach = futureMaps(doc).find((m) => m.root === primaryImpactRoot(doc))!.nodes;
  const card = new Map<string, ID>();
  for (const id of reach) {
    const k = doc.nodes[id]!.meta.key;
    if (typeof k === "string") card.set(k, id);
  }
  const added = new Map<string, ID>();
  for (const n of Object.values(fresh.nodes)) {
    const k = n.meta.key as string;
    if (card.has(k)) continue;
    const id = `${n.id}_readded`;
    out.nodes[id] = { ...structuredClone(n), id, createdAt: at, updatedAt: at };
    added.set(k, id);
  }
  const idOf = (k: string) => added.get(k) ?? card.get(k)!;
  for (const e of Object.values(fresh.edges)) {
    const tk = fresh.nodes[e.target]!.meta.key as string;
    if (!added.has(tk)) continue;
    const id = `${e.id}_readded`;
    out.edges[id] = { ...structuredClone(e), id, source: idOf(fresh.nodes[e.source]!.meta.key as string), target: idOf(tk), createdAt: at, updatedAt: at };
  }
  return out;
}

describe("地図から外れたカード・同じ鍵のノードも新しい版にする（新しい版にした後、同じ鍵は 1 つだけ）", () => {
  it("道の線を相乗効果に変えて地図から外れたカード: 足し直さずに、もとのカード（ID・決めたこと・書き換え）を新しい版にし、線は道の線に戻す（2 枚の間は 1 本）", () => {
    const { store, cmd } = setup(buildR6Future(TODAY).pv.doc);
    const opt = byKey(store.doc, "r.sd_pilot")!;
    const yes = byKey(store.doc, "r.sd_pilot.yes")!;
    const e = edgeBetween(store.doc, "r.sd_pilot", "r.sd_pilot.yes")!;
    cmd.setRelation([e.id], "supports");
    expect(inMap(store.doc, yes.id)).toBe(false);
    // 外れたカードに手を入れる: 題名を書き換え、その先の手を選ぶ
    cmd.updateNode(yes.id, { title: "うまくいった（自分の言葉）" });
    const kid = Object.values(store.doc.edges).find((x) => x.source === yes.id && x.relation === "leads")!.target;
    cmd.setStatus([kid], "active");
    const nodes0 = Object.keys(store.doc.nodes).length;
    const res = swapFutureDoc(store.doc, nextDoc());
    const d = res.doc;
    expect(dupKeys(d)).toEqual([]);
    // 足したのは新しい版で増えたカードだけ（外れたカードは足し直さない）
    expect([res.added, res.removed]).toEqual([1, 1]);
    expect(Object.keys(d.nodes).length).toBe(nodes0);
    expect(byKey(d, "r.sd_pilot.yes")!.id).toBe(yes.id);
    expect(d.nodes[yes.id]!.title).toBe("うまくいった（自分の言葉）");
    expect(d.nodes[kid]!.status).toBe("active");
    const between = Object.values(d.edges).filter((x) => x.source === opt.id && x.target === yes.id);
    expect(between.map((x) => [x.id, x.relation])).toEqual([[e.id, "condition"]]);
    expect(inMap(d, yes.id) && inMap(d, kid)).toBe(true);
    // 同じ版を当て直しても変わらない
    const again = swapFutureDoc(d, mapOf(next, "next-version", R6_RELEASE.release + 1));
    expect([again.updated, again.added, again.removed]).toEqual([0, 0, 0]);
  });

  it("前の版のアプリで選択肢だけを消した（その先は地図から外れたまま）: その先のカードは足し直さずに新しい版にし、消した選択肢は足し直してつなぐ", () => {
    const { store, cmd } = setup(buildR6Future(TODAY).pv.doc);
    const opt = byKey(store.doc, "r.sd_pilot")!;
    const kids = Object.values(store.doc.edges).filter((x) => x.source === opt.id).map((x) => x.target);
    expect(kids.length).toBeGreaterThan(1);
    const nodes0 = Object.keys(store.doc.nodes).length;
    // 前の版のアプリの削除: 選択肢だけを消す（その先は残る）
    store.transact("削除", (tx) => tx.deleteNode(opt.id));
    cmd.setStatus([kids[0]!], "active");
    expect(kids.some((k) => inMap(store.doc, k))).toBe(false);
    const keys = kids.map((k) => store.doc.nodes[k]!.meta.key);
    const res = swapFutureDoc(store.doc, nextDoc());
    const d = res.doc;
    expect(dupKeys(d)).toEqual([]);
    // 足し直したのは消した選択肢と、新しい版で増えたカード
    expect(res.added).toBe(2);
    expect(Object.keys(d.nodes).length).toBe(nodes0);
    const back = byKey(d, "r.sd_pilot")!;
    kids.forEach((k, i) => {
      expect(d.nodes[k]?.meta.key).toBe(keys[i]);
      expect(Object.values(d.edges).filter((x) => x.source === back.id && x.target === k).length).toBe(1);
      expect(inMap(d, k)).toBe(true);
    });
    expect(d.nodes[kids[0]!]!.status).toBe("active");
  });

  it("同梱の線を消して同じ向きに相乗効果の線を引き直した 2 枚: 自分の線を残し、同梱の線は足さない（同じ向きの線は 1 本）。外れたままのカードは足し直さず、位置も動かさない", () => {
    const { store, cmd } = setup(buildR6Future(TODAY).pv.doc);
    const e = edgeBetween(store.doc, "r.sd_pilot", "r.sd_pilot.no")!;
    cmd.deleteNodes([], [e.id]);
    const [own] = cmd.connect([e.source], e.target, "supports");
    const at = { x: store.doc.nodes[e.target]!.x, y: store.doc.nodes[e.target]!.y };
    const res = swapFutureDoc(store.doc, nextDoc());
    const d = res.doc;
    expect(dupKeys(d)).toEqual([]);
    expect(res.added).toBe(1);
    expect(Object.values(d.edges).filter((x) => x.source === e.source && x.target === e.target)).toEqual([store.doc.edges[own!]]);
    expect([d.nodes[e.target]!.x, d.nodes[e.target]!.y]).toEqual([at.x, at.y]);
  });

  it("同じ鍵のノードが 2 つ（別の地図を足して、そのカードへ自分でつないだ）: 先に作った方だけをカードにし、もう 1 つは鍵を外した自分のノードとして残す", () => {
    const a = buildR6Future(TODAY).pv.doc;
    for (const [id, n] of Object.entries(a.nodes)) a.nodes[id] = { ...n, createdAt: "2026-01-01T00:00:00.000Z" };
    const { store, cmd } = setup(mergeDocs(a, buildR6Future(TODAY).pv.doc).doc);
    const p = primaryImpactRoot(store.doc)!;
    const other = futureMaps(store.doc).find((m) => m.root !== p)!;
    const from = Object.values(store.doc.nodes).find((n) => n.meta.key === "r.fc_switch" && !other.nodes.has(n.id))!;
    const to = Object.values(store.doc.nodes).find((n) => n.meta.key === "r.part.p" && other.nodes.has(n.id))!;
    cmd.connect([from.id], to.id);
    expect(dupKeys(store.doc).length).toBeGreaterThan(100);
    const res = swapFutureDoc(store.doc, nextDoc());
    const d = res.doc;
    expect(dupKeys(d)).toEqual([]);
    expect(Object.values(d.nodes).filter((n) => n.meta.forecastRoot === true).map((n) => n.id)).toEqual([p]);
    // つないだ先は残り、鍵だけが外れる（文章・つながりはそのまま）
    const kept = d.nodes[to.id]!;
    expect(kept.meta.key).toBeUndefined();
    expect([kept.title, kept.body]).toEqual([to.title, to.body]);
    expect(Object.values(d.edges).some((x) => x.source === from.id && x.target === to.id)).toBe(true);
    expect(inMap(d, to.id)).toBe(true);
    expect(res.userKept).toBeGreaterThan(0);
  });

  // 前の版のアプリは、外れたカードをそのまま残して同じ鍵のカードを後から足し直し、地図につないだ（同じ鍵が 2 つ）。
  // 先に作った外れた方をカードに選ぶと、つないだ方も利用者の線で地図に残り、同じカードが 2 度出る
  const cutEdge = (store: Store, cmd: Commands) => cmd.deleteNodes([], [edgeBetween(store.doc, "r.sd_pilot", "r.sd_pilot.yes")!.id]);
  const cutOption = (store: Store) => store.transact("削除", (tx) => tx.deleteNode(byKey(store.doc, "r.sd_pilot")!.id));
  it.each([
    ["同梱の線を 1 本消した（「接続を削除」）", "edge"],
    ["前の版のアプリで選択肢だけを消した", "option"],
  ] as const)("前の版のアプリで新しい版にした地図（%s → 外れたカードと、足し直してつないだカードで同じ鍵が 2 つ）: つないだ方をカードにし、外れた方は鍵を外して外れたまま残す（同じカードを地図に 2 度出さない）", (_, cut) => {
    const T0 = "2026-11-01T00:00:00.000Z";
    const first = buildR6Future(TODAY).pv.doc;
    for (const [id, n] of Object.entries(first.nodes)) first.nodes[id] = { ...n, createdAt: T0 };
    const { store, cmd } = setup(first);
    const yes0 = byKey(store.doc, "r.sd_pilot.yes")!;
    if (cut === "edge") cutEdge(store, cmd);
    else cutOption(store);
    expect(inMap(store.doc, yes0.id)).toBe(false);
    const old = oldAppUpgrade(store.doc, buildR6Future(TODAY).pv.doc, "2026-12-01T00:00:00.000Z");
    const copy = Object.values(old.nodes).find((n) => n.meta.key === "r.sd_pilot.yes" && n.id !== yes0.id)!;
    expect(inMap(old, copy.id)).toBe(true);
    expect(dupKeys(old).length).toBeGreaterThan(10);
    const res = swapFutureDoc(old, nextDoc());
    const d = res.doc;
    expect(dupKeys(d)).toEqual([]);
    expect(byKey(d, "r.sd_pilot.yes")!.id).toBe(copy.id);
    expect(d.nodes[yes0.id]!.meta.key).toBeUndefined();
    expect(inMap(d, yes0.id)).toBe(false);
    // 地図は新しい版と同じ形（選択肢の先は 2 枚。鍵の無い写しはつながらない）。地図に残った利用者のノードは無い
    expect(flowKids(d, "r.sd_pilot")).toEqual(flowKids(nextDoc(), "r.sd_pilot"));
    expect(mapSize(d)).toBe(mapSize(nextDoc()));
    expect(res.userKept).toBe(0);
    // 同じ版を当て直しても変わらない
    const again = swapFutureDoc(d, mapOf(next, "next-version", R6_RELEASE.release + 1));
    expect([again.updated, again.added, again.removed, again.userKept]).toEqual([0, 0, 0, 0]);
  });
});

describe("タグを新しい版にする", () => {
  it("月が変わった版では、前の版で付いた役割のタグ（3か月後）を外して新しい版のタグにし、自分で付けたタグは残す（新しい版のほかのカードで使うタグでも）", () => {
    const { store, cmd } = setup(buildR6Future(TODAY).pv.doc);
    const states = Object.values(store.doc.nodes).filter((n) => n.tags.includes("3か月後"));
    expect(states.length).toBeGreaterThan(5);
    const card = states[0]!;
    cmd.updateNode(card.id, { tags: [...card.tags, "自分のタグ", "1年後"] });
    // 次の版: 3 か月後の状態をすべて 4 か月後にする
    const nb = nextBundle((b) => {
      for (const n of b.nodes) if (n[2] === "s" && n[3] === 3) n[3] = 4;
    });
    const fresh = mapOf(nb, "tags-next", R6_RELEASE.release + 1);
    const res = swapFutureDoc(store.doc, fresh);
    const d = res.doc;
    expect(Object.values(d.nodes).filter((n) => n.tags.includes("3か月後")).length).toBe(0);
    expect(d.nodes[card.id]!.tags).toEqual(["未来の道筋", "3年", "4か月後", "自分のタグ", "1年後"]);
    // ほかのカードは新しい版の地図と同じタグ（積み重ならない）
    for (const n of Object.values(d.nodes)) if (n.id !== card.id) expect(n.tags, n.title).toEqual(fresh.nodes[n.id]!.tags);
    expect(res.updated).toBeGreaterThanOrEqual(states.length);
    // 同じ版を当て直しても変わらない
    const again = swapFutureDoc(d, mapOf(nb, "tags-next", R6_RELEASE.release + 1));
    expect(again.updated).toBe(0);
    expect(again.doc.nodes[card.id]!.tags).toEqual(d.nodes[card.id]!.tags);
  });

  it("カードの役割と月から、同梱データで付くタグが分かる（地図を作るときと同じ）", () => {
    const doc = buildR6Future(TODAY).pv.doc;
    for (const n of Object.values(doc.nodes)) expect(impactTagsOf(n.meta), n.title).toEqual(n.tags);
    expect(impactTagsOf({ fork: "decision" })).toEqual(["未来の道筋", "3年"]);
  });
});

describe("やること（チェックリスト）を新しい版にする", () => {
  const CARD = "r.fc_switch";
  const todoOf = (b: ImpactBundle) => at(b, CARD).n[7] as { todo: string[] };
  const items = (d: DocData) => byKey(d, CARD)!.conditions;
  const uniqueIds = (d: DocData) => {
    for (const n of Object.values(d.nodes)) expect(new Set(n.conditions.map((c) => c.id)).size, n.title).toBe(n.conditions.length);
  };
  /** 書き換えを見分ける指紋を外した地図（前の版のアプリで読み込んだ物と同じ形） */
  const withoutPrints = (doc: DocData): DocData => {
    const out: DocData = { ...doc, nodes: { ...doc.nodes }, edges: { ...doc.edges } };
    for (const [id, n] of Object.entries(out.nodes)) {
      const { t0: _t, b0: _b, k0: _k, futureRelease: _r, ...meta } = n.meta;
      out.nodes[id] = { ...n, meta: n.meta.forecastRoot ? { ...meta, futureVersion: "bdyw-18fku5" } : meta };
    }
    for (const [id, e] of Object.entries(out.edges)) {
      const { p0: _p, c0: _c, ...meta } = e.meta;
      out.edges[id] = { ...e, meta };
    }
    return out;
  };

  it("同梱のカードには、やることの項目ごとの指紋（k0）が付く", () => {
    const doc = buildR6Future(TODAY).pv.doc;
    let withTodo = 0;
    for (const n of Object.values(doc.nodes)) {
      if (n.conditions.length) {
        withTodo++;
        expect(n.meta.k0, n.title).toEqual(n.conditions.map((c) => fnv36(c.text)));
      } else expect(n.meta.k0, n.title).toBeUndefined();
    }
    expect(withTodo).toBeGreaterThan(50);
    expect(hasEditPrints(doc, rootOf(doc).id)).toBe(true);
    expect(hasEditPrints(withoutPrints(doc), rootOf(doc).id)).toBe(false);
  });

  it("足した・書き換えた項目はチェックごと残り、消した項目は戻らない。新しい版で足された・書き換えられた項目は入る", () => {
    const { store, cmd } = setup(buildR6Future(TODAY).pv.doc);
    const card = () => byKey(store.doc, CARD)!;
    const [t0, t1, t2, t3, t4] = card().conditions.map((c) => c.text) as [string, string, string, string, string];
    cmd.updateCondition(card().id, card().conditions[0]!.id, { met: true });
    const second = card().conditions[1]!;
    cmd.updateCondition(card().id, second.id, { text: `${t1}（自分の言葉）` });
    cmd.updateCondition(card().id, second.id, { met: true });
    cmd.removeCondition(card().id, card().conditions[3]!.id);
    cmd.addCondition(card().id, "自分で足したやること");
    const mine = card().conditions.find((c) => c.text === "自分で足したやること")!;
    cmd.updateCondition(card().id, mine.id, { met: true });
    const before = card().conditions;
    // 次の版: 最後の項目を書き換え、1 つ足す（ほかの項目はそのまま）
    const nb = nextBundle((b) => {
      todoOf(b).todo = [t0, t1, t2, t3, `${t4}（次の版）`, "次の版で足したやること"];
    });
    const res = swapFutureDoc(store.doc, mapOf(nb, "todo-next", R6_RELEASE.release + 1));
    const after = items(res.doc);
    expect(after.map((c) => [c.text, c.met])).toEqual([
      [t0, true],
      [`${t1}（自分の言葉）`, true],
      [t2, false],
      [`${t4}（次の版）`, false],
      ["次の版で足したやること", false],
      ["自分で足したやること", true],
    ]);
    // 残した項目は ID もそのまま。ID はカードの中で重ならない
    expect(after[0]!.id).toBe(before[0]!.id);
    expect(after[1]!.id).toBe(second.id);
    expect(after[5]!.id).toBe(mine.id);
    uniqueIds(res.doc);
    // 指紋は新しい版の物（次の版でも、足した・書き換えた項目と分かる）
    expect(byKey(res.doc, CARD)!.meta.k0).toEqual(todoOf(nb).todo.map((t) => fnv36(t)));
    expect(res.kept).toBeGreaterThan(0);
    // 同じ版を当て直しても変わらない
    const again = swapFutureDoc(res.doc, mapOf(nb, "todo-next", R6_RELEASE.release + 1));
    expect(items(again.doc)).toEqual(after);
    expect(again.updated).toBe(0);
  });

  it("このカードを変えない版では、足した・書き換えた項目のあるカードを更新と数えず、項目も順番もそのまま", () => {
    const { store, cmd } = setup(buildR6Future(TODAY).pv.doc);
    const card = () => byKey(store.doc, CARD)!;
    cmd.addCondition(card().id, "自分で足したやること");
    const second = card().conditions[1]!;
    cmd.updateCondition(card().id, second.id, { text: `${second.text}（自分の言葉）`, met: true });
    const before = card().conditions;
    const nb = nextBundle((b) => {
      at(b, "r.keep").n[4] = "今のままにする（次の版）";
    });
    const res = swapFutureDoc(store.doc, mapOf(nb, "todo-same", R6_RELEASE.release + 1));
    expect(items(res.doc)).toEqual(before);
    expect(res.updated).toBe(1);
  });

  it("やることを全部消したカードは、新しい版でも消したまま（新しい版で足された項目だけが入る）", () => {
    const { store, cmd } = setup(buildR6Future(TODAY).pv.doc);
    const card = () => byKey(store.doc, CARD)!;
    const t = card().conditions.map((c) => c.text);
    for (const c of card().conditions) cmd.removeCondition(card().id, c.id);
    expect(card().conditions.length).toBe(0);
    expect(items(swapFutureDoc(store.doc, nextDoc()).doc)).toEqual([]);
    const nb = nextBundle((b) => {
      todoOf(b).todo = [...t, "次の版で足したやること"];
    });
    expect(items(swapFutureDoc(store.doc, mapOf(nb, "todo-add", R6_RELEASE.release + 1)).doc).map((c) => c.text)).toEqual(["次の版で足したやること"]);
  });

  it("項目の ID は、新しい版で項目が減った・並びが変わっても重ならない（新しい項目だけを消す・チェックできる）", () => {
    for (const legacy of [false, true]) {
      // 1) 2 つ目を消して最後に 1 つ足した版。利用者は最後の項目にチェック
      {
        const { store, cmd } = setup(legacy ? withoutPrints(buildR6Future(TODAY).pv.doc) : buildR6Future(TODAY).pv.doc);
        const card = () => byKey(store.doc, CARD)!;
        const t = card().conditions.map((c) => c.text);
        const ticked = card().conditions[4]!;
        cmd.updateCondition(card().id, ticked.id, { met: true });
        const nb = nextBundle((b) => {
          todoOf(b).todo = [t[0]!, t[2]!, t[3]!, t[4]!, "次の版で足したやること"];
        });
        const res = swapFutureDoc(store.doc, mapOf(nb, "drop-append", R6_RELEASE.release + 1));
        uniqueIds(res.doc);
        const s2 = setup(res.doc);
        const c2 = byKey(s2.store.doc, CARD)!;
        expect(c2.conditions.find((c) => c.text === t[4])!.id).toBe(ticked.id);
        s2.cmd.removeCondition(c2.id, c2.conditions.find((c) => c.text === "次の版で足したやること")!.id);
        expect(items(s2.store.doc).map((c) => [c.text, c.met]), String(legacy)).toEqual([
          [t[0], false],
          [t[2], false],
          [t[3], false],
          [t[4], true],
        ]);
      }
      // 2) 2 つ目を先頭に移し、その後ろに 1 つ足した版。利用者は 2 つ目にチェック
      {
        const { store, cmd } = setup(legacy ? withoutPrints(buildR6Future(TODAY).pv.doc) : buildR6Future(TODAY).pv.doc);
        const card = () => byKey(store.doc, CARD)!;
        const t = card().conditions.map((c) => c.text);
        cmd.updateCondition(card().id, card().conditions[1]!.id, { met: true });
        const nb = nextBundle((b) => {
          todoOf(b).todo = [t[1]!, "次の版で増えたやること", t[2]!, t[3]!, t[4]!];
        });
        const res = swapFutureDoc(store.doc, mapOf(nb, "move-insert", R6_RELEASE.release + 1));
        uniqueIds(res.doc);
        const s2 = setup(res.doc);
        const c2 = byKey(s2.store.doc, CARD)!;
        s2.cmd.updateCondition(c2.id, c2.conditions.find((c) => c.text === "次の版で増えたやること")!.id, { met: true });
        expect(items(s2.store.doc).map((c) => [c.text, c.met]), String(legacy)).toEqual([
          [t[1], true],
          ["次の版で増えたやること", true],
          [t[2], false],
          [t[3], false],
          [t[4], false],
        ]);
      }
    }
  });

  it("指紋の無い地図（前の版のアプリで読み込んだ物）: やることは新しい版の項目になり、同じ文の項目のチェックだけが残る", () => {
    const { store, cmd } = setup(withoutPrints(buildR6Future(TODAY).pv.doc));
    const card = () => byKey(store.doc, CARD)!;
    const t = card().conditions.map((c) => c.text);
    cmd.updateCondition(card().id, card().conditions[0]!.id, { met: true });
    cmd.addCondition(card().id, "自分で足したやること");
    expect(hasEditPrints(store.doc, rootOf(store.doc).id)).toBe(false);
    const res = swapFutureDoc(store.doc, nextDoc());
    expect(items(res.doc).map((c) => [c.text, c.met])).toEqual(t.map((x, i) => [x, i === 0]));
    uniqueIds(res.doc);
    // 新しい版の指紋が付く（この次からは、足した項目を見分けられる）
    expect(byKey(res.doc, CARD)!.meta.k0).toEqual(t.map((x) => fnv36(x)));
    expect(hasEditPrints(res.doc, rootOf(res.doc).id)).toBe(true);
  });
});

describe("版の順番", () => {
  const v = futureVersion();
  const r = futureRelease();

  it("版の記録（impact-release.json）は今の同梱データの版と合う（データを作り直したのに順番を進め忘れていない）", () => {
    expect(releaseFile.version).toBe(v);
    expect(impactDataVersion(raw)).toBe(v);
    expect(Number.isInteger(releaseFile.release) && releaseFile.release >= 1).toBe(true);
    expect(r).toBe(releaseFile.release);
    // データを作るとき: 中身が同じなら記録のまま、違えば順番を 1 つ進める
    expect(nextImpactRelease(releaseFile, raw)).toBe(releaseFile);
    const changed = `${raw.slice(0, -1)} }`;
    expect(nextImpactRelease(releaseFile, changed)).toEqual({ release: releaseFile.release + 1, version: impactDataVersion(changed) });
  });

  it("古い・同じ・新しい・順番の無い地図", () => {
    expect(futureAge({ version: "x", release: r - 1 }, v, r)).toBe("old");
    expect(futureAge({ version: v, release: r }, v, r)).toBe("same");
    // 順番が同じなら、指紋が違っても同じ版（順番で比べる）
    expect(futureAge({ version: "other", release: r }, v, r)).toBe("same");
    expect(futureAge({ version: "zz-from-a-newer-page", release: r + 1 }, v, r)).toBe("newer");
    // 順番を残す前の地図: 指紋が同じなら同じ、違えば古い（新しいとは決めない）
    expect(futureAge({ version: v, release: null }, v, r)).toBe("same");
    expect(futureAge({ version: "bdyw-18fku5", release: null }, v, r)).toBe("old");
    expect(futureAge({ version: null, release: null }, v, r)).toBe("old");
  });

  it("新しい版で作った地図は古いとしない（古いページが新しい地図を古い版に戻さない）", () => {
    const doc = buildFuture(TODAY).pv.doc;
    const root = rootOf(doc);
    const set = (meta: Record<string, unknown>): DocData => ({ ...doc, nodes: { ...doc.nodes, [root.id]: { ...root, meta: { ...root.meta, ...meta } } } });
    const cases: Array<[string, DocData, number, number]> = [
      ["同じ", doc, 0, 0],
      ["古い", set({ futureVersion: "older", futureRelease: r - 1 }), 1, 0],
      ["新しい", set({ futureVersion: "newer", futureRelease: r + 1 }), 0, 1],
    ];
    for (const [name, d, stale, newer] of cases) {
      expect(staleFutureMaps(d, v, r).length, name).toBe(stale);
      expect(newerFutureMaps(d, v, r).length, name).toBe(newer);
      expect(hasStaleFuture(d, v, r), name).toBe(stale > 0);
    }
    const { futureRelease: _r, ...legacyMeta } = root.meta;
    const legacy = (version: string): DocData => ({ ...doc, nodes: { ...doc.nodes, [root.id]: { ...root, meta: { ...legacyMeta, futureVersion: version } } } });
    expect(staleFutureMaps(legacy(v), v, r).length).toBe(0);
    expect(staleFutureMaps(legacy("bdyw-18fku5"), v, r).length).toBe(1);
    expect(newerFutureMaps(legacy("bdyw-18fku5"), v, r).length).toBe(0);
    expect(hasStaleFuture(createEmptyDoc(), v, r)).toBe(false);
  });
});

describe("それより前の未来の道筋（v1）は入れ替える", () => {
  it("v1 の地図は鍵が無いので入れ替え、入口の位置はそろえる", () => {
    const doc = createEmptyDoc();
    const add = (id: ID, x: number, meta: Record<string, unknown> = {}) => (doc.nodes[id] = makeNode({ id, title: id, x, y: 0, meta }));
    add("n_f_S0", 100, { forecastRoot: true, futureVersion: "v1" });
    add("n_f_t1", 400);
    doc.edges.e1 = makeEdge({ id: "e1", source: "n_f_S0", target: "n_f_t1" });
    expect(inPlaceRoot(doc)).toBeNull();
    const res = swapFutureDoc(doc, nextDoc());
    expect(res.inPlace).toBe(false);
    expect(res.removed).toBe(2);
    expect(res.doc.nodes.n_f_S0).toBeUndefined();
    expect(res.doc.nodes[res.root!]!.x).toBe(100);
  });
});
