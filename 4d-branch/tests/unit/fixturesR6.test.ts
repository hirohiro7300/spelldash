import { describe, expect, it } from "vitest";
import { ACCOUNT_R6_LOAD_DAY, accountR6Json, buildAccountR6 } from "../../scripts/fixtures/accountR6";
import accountR6Src from "../../scripts/fixtures/accountR6.ts?raw";
import { R6_NODE_W, R6_SCHEMA_VERSION, buildR6MapDoc, type R6Bundle } from "../../scripts/fixtures/frozenR6";
import frozenR6Src from "../../scripts/fixtures/frozenR6.ts?raw";
import history from "../../scripts/impact/releases.json";
import { countImpact, fnv36, impactDataVersion, impactNodeId, impactTagsOf } from "../../src/demo/impact";
import { normalizeDoc } from "../../src/model/schema";
import type { DocData, GEdge, GNode, ID } from "../../src/model/types";
import accountRaw from "../fixtures/account-r6.json?raw";
import { R6_RAW, R6_RELEASE, r6Bundle } from "./helpers/r6";

describe("凍結した版 6 の同梱データ（tests/fixtures/impact-r6.json・impact-r6-release.json）", () => {
  it("版 6 のまま: 中身の指紋が版の記録と、版の歴史（scripts/impact/releases.json）の版 6 に合う", () => {
    expect(R6_RELEASE.release).toBe(6);
    expect(impactDataVersion(R6_RAW)).toBe(R6_RELEASE.version);
    const rec = history.releases.find((r) => r.release === 6)!;
    expect([rec.hash, rec.scheme]).toEqual([R6_RELEASE.version, "v2-json"]);
    const b = r6Bundle();
    expect([b.v, b.kind, b.nodes.length]).toEqual([2, "impact3y", 1533]);
    expect(countImpact(b)).toEqual(b.check.counts);
  });
});

/** 鍵の深さ（今日 r が 0。今日の手 1・3 か月後 2・その手 3・1 年後 4・2 年の進め方 5・3 年後 6） */
const depthOf = (key: string) => key.split(".").length - 1;
const keyOf = (n: GNode | undefined): string | null => (n && typeof n.meta.key === "string" ? n.meta.key : null);
const RANDOM_ID = (prefix: string) => new RegExp(`^${prefix}_[0-9a-z]{12}$`);

describe("アカウントの形をした版 6 の文書（tests/fixtures/account-r6.json。合成）", () => {
  const input = JSON.parse(accountRaw) as DocData;
  const { doc, report } = normalizeDoc(JSON.parse(accountRaw));
  // 比べる元: 同じ版 6 の同梱データを、版 6 のページの組み立ての写し（scripts/fixtures/frozenR6.ts）で作った地図（同梱の ID・プロジェクト）。
  // アプリの今の組み立ては読まない（P2 で変わっても、この文書の確かめは版 6 のまま）
  const ref = buildR6MapDoc(JSON.parse(R6_RAW) as R6Bundle, ACCOUNT_R6_LOAD_DAY, R6_RELEASE, "2026-11-12T10:30:00.000Z") as unknown as DocData;
  const refByKey = new Map<string, GNode>(Object.values(ref.nodes).map((n) => [keyOf(n)!, n]));
  const refEdge = new Map<string, GEdge>(Object.values(ref.edges).map((e) => [`${keyOf(ref.nodes[e.source])}>${keyOf(ref.nodes[e.target])}`, e]));
  const nodes = Object.values(doc.nodes);
  const edges = Object.values(doc.edges);
  const keyed = nodes.filter((n) => keyOf(n) !== null);
  const own = nodes.filter((n) => keyOf(n) === null);
  /** 同梱の線（版 6 の親 → 子の組で、両端が鍵のカード） */
  const isMapEdge = (e: GEdge) => refEdge.has(`${keyOf(doc.nodes[e.source])}>${keyOf(doc.nodes[e.target])}`);
  const mapEdges = edges.filter(isMapEdge);
  const userEdges = edges.filter((e) => !isMapEdge(e));

  it("今のアプリの検証（normalizeDoc）を通しても、何も直されず何も変わらない（読み手が版 1 の文書を移行するようになったら、文書ではなくこの答えを直す）", () => {
    expect(report.warnings).toEqual([]);
    expect(report.dropped).toEqual({ nodes: 0, edges: 0, projects: 0, scenarios: 0 });
    expect(doc).toEqual(input);
  });

  it("凍結の印: 版 6 のページが書いた形のまま（文書の版 1・入口は版 6・地図は版 6 のカードの幅 212 で右へ、メモの高さへずらした位置。見直し found-1）", () => {
    // 作り直しで今のアプリの決まり（SCHEMA_VERSION・NODE_W・並べ方）が入り込んでいれば、ここで止まる
    expect([input.schema, input.version, input.title]).toEqual(["4d-branch", 1, "マイ・ブランチ"]);
    expect([R6_SCHEMA_VERSION, R6_NODE_W]).toEqual([1, 212]);
    const root = Object.values(input.nodes).find((n) => n.meta.forecastRoot === true)!;
    expect(root.meta).toMatchObject({ key: "r", futureRelease: 6, futureVersion: "bvpn-apwrrf" });
    // 前からあったメモの右端（x 60）+ カードの幅 212 + 600、上端（y −420）にそろえる（版 6 の地図の今日は (0, 0)）
    expect([root.x, root.y]).toEqual([60 + 212 + 600, -420]);
    expect([refByKey.get("r")!.x, refByKey.get("r")!.y]).toEqual([0, 0]);
    // 作り方はアプリの今のコードを読まない（型も。凍結した写し ./frozenR6.ts だけ）
    for (const [name, src] of [
      ["accountR6.ts", accountR6Src],
      ["frozenR6.ts", frozenR6Src],
    ] as const)
      expect([name, src.match(/^import .*$/gm) ?? []]).toEqual([name, name === "accountR6.ts" ? [expect.stringMatching(/from "\.\/frozenR6";$/)] : []]);
  });

  it("地図は版 6 のまま全部ある: 1,533 枚のカードと 1,532 本の線。入口は版 6 の版と版の順番を持つ", () => {
    expect(keyed.length).toBe(1533);
    expect(new Set(keyed.map(keyOf))).toEqual(new Set(refByKey.keys()));
    expect(mapEdges.length).toBe(Object.keys(ref.edges).length);
    expect(new Set(mapEdges.map((e) => `${keyOf(doc.nodes[e.source])}>${keyOf(doc.nodes[e.target])}`)).size).toBe(1532);
    for (const e of mapEdges) expect(e.relation).toBe(refEdge.get(`${keyOf(doc.nodes[e.source])}>${keyOf(doc.nodes[e.target])}`)!.relation);
    const roots = nodes.filter((n) => n.meta.forecastRoot === true);
    expect(roots.length).toBe(1);
    expect(roots[0]!.meta).toMatchObject({ key: "r", futureVersion: R6_RELEASE.version, futureRelease: 6, impact: { v: 2, horizon: 36 } });
    // 地図の位置は「追加する」で右へずらしてある（版 6 の組み立ての位置そのままではない）
    expect(roots[0]!.x).not.toBe(refByKey.get("r")!.x);
    expect(r6Bundle().nodes.length).toBe(keyed.length);
  });

  it("ID はどれも「追加する」で振り直した乱数（同梱の鍵の ID ではない）。プロジェクトは名前で合わせ、1 つは同梱と別の ID", () => {
    for (const n of nodes) expect(n.id).toMatch(RANDOM_ID("n"));
    for (const n of keyed) expect(n.id).not.toBe(impactNodeId(keyOf(n)!));
    for (const e of edges) expect(e.id).toMatch(RANDOM_ID("e"));
    const conds = nodes.flatMap((n) => n.conditions);
    expect(conds.length).toBeGreaterThanOrEqual(Object.values(ref.nodes).flatMap((n) => n.conditions).length);
    for (const c of conds) expect(c.id).toMatch(RANDOM_ID("c"));
    expect(new Set(conds.map((c) => c.id)).size).toBe(conds.length);
    expect(doc.id).toMatch(RANDOM_ID("d"));
    // 地図のカードのプロジェクトは、同梱の地図と同じ名前の物（ID はアカウントの物）
    const names = (d: DocData, ids: ID[]) => ids.map((p) => d.projects[p]!.name);
    for (const n of keyed) expect(names(doc, n.projectIds), keyOf(n)!).toEqual(names(ref, refByKey.get(keyOf(n)!)!.projectIds));
    const idOfName = (d: DocData) => new Map(Object.values(d.projects).map((p) => [p.name, p.id]));
    const mine = idOfName(doc);
    const theirs = idOfName(ref);
    const reIded = [...theirs].filter(([name, id]) => mine.get(name) !== id);
    expect(reIded.map(([name]) => name)).toEqual(["広告運用事業での独立"]);
    expect(mine.get("広告運用事業での独立")).toMatch(RANDOM_ID("p"));
    expect(keyed.some((n) => n.projectIds.includes(mine.get("広告運用事業での独立")!))).toBe(true);
    // シナリオも名前で合わせる（同じ ID）
    for (const e of mapEdges) expect(e.scenarioIds.map((s) => doc.scenarios[s]!.name)).toEqual(refEdge.get(`${keyOf(doc.nodes[e.source])}>${keyOf(doc.nodes[e.target])}`)!.scenarioIds.map((s) => ref.scenarios[s]!.name));
  });

  /** 鍵のカードごとの、利用者が手を入れた所の種類 */
  const stateOf = new Map<string, Set<string>>();
  const mark = (key: string | null, kind: string) => {
    if (key === null) return;
    if (!stateOf.has(key)) stateOf.set(key, new Set());
    stateOf.get(key)!.add(kind);
  };
  for (const n of keyed) {
    const key = keyOf(n)!;
    const r = refByKey.get(key)!;
    if (n.status !== "open") mark(key, n.status);
    if (n.conditions.some((c) => c.met && r.conditions.some((x) => x.text === c.text))) mark(key, "tick");
    if (n.conditions.some((c) => !r.conditions.some((x) => x.text === c.text))) mark(key, "own-todo");
    if (n.title !== r.title) mark(key, "title");
    if (n.body !== r.body) mark(key, "body");
    if (n.tags.some((t) => !impactTagsOf(n.meta).includes(t))) mark(key, "tag");
    if (key === "r" && (n.meta.impact as { annual?: number }).annual !== undefined) mark(key, "annual");
  }
  for (const e of mapEdges) {
    const r = refEdge.get(`${keyOf(doc.nodes[e.source])}>${keyOf(doc.nodes[e.target])}`)!;
    if (e.meta.prob !== r.meta.prob) mark(keyOf(doc.nodes[e.target]), "prob");
    if (e.label !== r.label || e.condition !== r.condition) mark(keyOf(doc.nodes[e.target]), "edge-text");
  }
  for (const e of userEdges) {
    const s = doc.nodes[e.source]!;
    const t = doc.nodes[e.target]!;
    mark(keyOf(s), keyOf(t) === null && e.relation !== "supports" ? "own-child" : "own-edge");
    mark(keyOf(t), "own-edge");
  }

  it("深さ 1〜6 のどこにも、利用者が手を入れたカードがある", () => {
    const byDepth = new Map<number, Set<string>>();
    for (const [key, kinds] of stateOf) {
      const d = depthOf(key);
      if (!byDepth.has(d)) byDepth.set(d, new Set());
      for (const k of kinds) byDepth.get(d)!.add(k);
    }
    for (let d = 1; d <= 6; d++) expect([d, (byDepth.get(d)?.size ?? 0) >= 2]).toEqual([d, true]);
    // 選んだ手・見送りは今日の手（1）・3 か月後の手（3）・2 年の進め方（5）のどれにも
    for (const d of [1, 3, 5]) {
      expect([d, byDepth.get(d)!.has("active")]).toEqual([d, true]);
      expect([d, byDepth.get(d)!.has("dropped")]).toEqual([d, true]);
    }
  });

  it("選んだ手と見送り・やることのチェック・題名と本文の書き換え（元の指紋は残る）・77% の見込み・自分のタグ・自分で足したやること・年収", () => {
    const all = new Set([...stateOf.values()].flatMap((s) => [...s]));
    for (const kind of ["active", "dropped", "tick", "own-todo", "title", "body", "tag", "prob", "edge-text", "own-edge", "own-child", "annual"]) expect([kind, all.has(kind)]).toEqual([kind, true]);
    // 書き換えた題名・本文には元の文の指紋が残る（アプリはこれで書き換えたと分かる）
    for (const n of keyed) {
      const r = refByKey.get(keyOf(n)!)!;
      expect([n.meta.t0, n.meta.b0]).toEqual([fnv36(r.title), fnv36(r.body)]);
    }
    // 見込みの書き換えは 77%（元の見込み p0 は版 6 の物）
    const edited = mapEdges.filter((e) => e.meta.prob !== e.meta.p0);
    expect(edited.map((e) => [keyOf(doc.nodes[e.target]), e.meta.prob, e.meta.p0])).toEqual([["r.fc_switch.high", 77, 10]]);
  });

  it("自分のカードは、相乗効果・進む・条件付きの線で地図につながり、自分のプロジェクトがある", () => {
    expect(own.length).toBeGreaterThanOrEqual(4);
    const into = userEdges.filter((e) => (keyOf(doc.nodes[e.source]) === null) !== (keyOf(doc.nodes[e.target]) === null));
    expect(new Set(into.map((e) => e.relation))).toEqual(new Set(["supports", "leads", "condition"]));
    for (const e of userEdges) expect(e.meta.c0).toBeUndefined();
    const bundleNames = new Set(Object.values(ref.projects).map((p) => p.name));
    const mine = Object.values(doc.projects).filter((p) => !bundleNames.has(p.name));
    expect(mine.length).toBe(1);
    expect(own.some((n) => n.projectIds.includes(mine[0]!.id))).toBe(true);
    // 地図のカードどうしの自分の線もある（同梱の線ではない）
    expect(userEdges.some((e) => keyOf(doc.nodes[e.source]) !== null && keyOf(doc.nodes[e.target]) !== null)).toBe(true);
  });

  it("決まった種の台本（scripts/fixtures/accountR6.ts。版 6 の時の作り方の写しだけを使う）で作り直すと、バイトまで同じ（node scripts/fixtures/run.mjs --check と同じ）", () => {
    expect(accountR6Json(buildAccountR6(R6_RAW, R6_RELEASE))).toBe(accountRaw);
  });
});
