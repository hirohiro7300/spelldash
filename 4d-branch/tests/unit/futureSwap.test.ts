import { describe, expect, it } from "vitest";
import { Commands } from "../../src/app/commands";
import { DEFAULT_PREFS, UiState } from "../../src/app/uiState";
import { ViewModel } from "../../src/app/viewModel";
import { buildDemoDoc } from "../../src/demo/demo";
import { buildFuture, futureData, futureRelease, futureVersion } from "../../src/demo/futureBundle";
import { futureAge, futureMaps, hasStaleFuture, inPlaceRoot, newerFutureMaps, staleFutureMaps, swapFutureDoc } from "../../src/demo/futureSwap";
import { buildImpactDoc, edgeTextPrint, fnv36, impactDataVersion, nextImpactRelease, type ImpactBundle, type ImpactOutX } from "../../src/demo/impact";
import raw from "../../src/demo/impact-data.json?raw";
import releaseFile from "../../src/demo/impact-release.json";
import { primaryImpactRoot } from "../../src/model/forks";
import { createEmptyDoc, makeEdge, makeNode, normalizeDoc } from "../../src/model/schema";
import type { DocData, GEdge, GNode, ID } from "../../src/model/types";
import { mergeDocs } from "../../src/persist/io";
import { Store } from "../../src/store/store";

const TODAY = new Date(2026, 10, 18);
const data = futureData();

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
const nextDoc = (): DocData => (nextMemo ??= mapOf(next, "next-version", futureRelease() + 1));
let editedMemo: ReturnType<typeof buildEdited> | null = null;
const edited = (): ReturnType<typeof buildEdited> => (editedMemo ??= buildEdited());

/** 今の版の地図に、利用者が手を入れた物（どれも新しい版にしても残るはずの物） */
function buildEdited() {
  const { store, cmd } = setup(buildFuture(TODAY).pv.doc);
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
    expect(root.meta.futureRelease).toBe(futureRelease() + 1);
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
    const again = swapFutureDoc(d, mapOf(next, "next-version", futureRelease() + 1));
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
    const d = swapFutureDoc(first, mapOf(third, "third", futureRelease() + 2)).doc;
    expect(byKey(d, "r.sd_grow")!.title).toBe("遊ぶ人を増やす（自分の言葉）");
    expect(edgeBetween(d, "r.fc_switch", "r.fc_switch.high")!.meta.prob).toBe(77);
    expect(edgeBetween(d, "r.fc_switch", "r.fc_switch.none")!.meta.prob).toBe(62);
  });

  it("地図のカードから自分のノードへつないでも、新しい版にしたときにそのノードと先のノードは消えない", () => {
    const demo = buildDemoDoc();
    const merged = mergeDocs(demo, buildFuture(TODAY).pv.doc).doc;
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
      const { t0: _t, b0: _b, futureRelease: _r, ...meta } = n.meta;
      legacy.nodes[id] = { ...n, meta: n.meta.forecastRoot ? { ...meta, futureVersion: "bdyw-18fku5" } : meta };
    }
    for (const [id, e] of Object.entries(legacy.edges)) {
      const { p0: _p, c0: _c, ...meta } = e.meta;
      legacy.edges[id] = { ...e, meta };
    }
    expect(staleFutureMaps(legacy, futureVersion(), futureRelease()).length).toBe(1);
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
      const a = buildFuture(TODAY).pv.doc;
      const b = buildFuture(TODAY).pv.doc;
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

  it("今日を複製した 2 つ目の入口は消し、年収は数字を出す入口の物（複製の物ではない）", () => {
    const { store, cmd } = setup(buildFuture(TODAY).pv.doc);
    const root = rootOf(store.doc);
    cmd.updateNode(root.id, { meta: { ...root.meta, impact: { ...(root.meta.impact as object), annual: 540 } } });
    const [dup] = cmd.duplicate([root.id]);
    const d0 = store.doc.nodes[dup!]!;
    cmd.updateNode(dup!, { meta: { ...d0.meta, impact: { ...(d0.meta.impact as object), annual: 300 } } });
    expect(primaryImpactRoot(store.doc)).toBe(root.id);
    const res = swapFutureDoc(store.doc, nextDoc());
    expect(res.doc.nodes[dup!]).toBeUndefined();
    expect(annualOf(res.doc.nodes[root.id]!)).toBe(540);
  });

  it("同じ版を当てても何も変わらない（ID も文章も見込みも）", () => {
    const u = edited();
    const res = swapFutureDoc(u.doc, buildFuture(TODAY).pv.doc);
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
    const doc = buildFuture(TODAY).pv.doc;
    for (const e of Object.values(doc.edges)) {
      expect(e.meta.c0).toBe(edgeTextPrint(e.label, e.condition));
      if (e.relation === "condition") expect(e.meta.p0).toBe(e.meta.prob);
      else expect(e.meta.p0).toBeUndefined();
    }
    for (const n of Object.values(doc.nodes)) expect([n.meta.t0, n.meta.b0]).toEqual([fnv36(n.title), fnv36(n.body)]);
    expect(rootOf(doc).meta.futureRelease).toBe(futureRelease());
    const fresh = makeEdge({ source: "a", target: "b" });
    expect(fresh.meta.c0).toBeUndefined();
  });

  it("自分で引いたカードどうしの線（指紋の無い線）は、新しい版にしても残る", () => {
    const { store, cmd } = setup(buildFuture(TODAY).pv.doc);
    const a = byKey(store.doc, "r.fc_switch.none")!;
    const b = byKey(store.doc, "r.sd_grow")!;
    const [own] = cmd.connect([a.id], b.id);
    const res = swapFutureDoc(store.doc, nextDoc());
    expect(res.doc.edges[own!]).toEqual(store.doc.edges[own!]);
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
