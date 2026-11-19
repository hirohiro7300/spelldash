// 薄い形の保存（src/persist/thinMap.ts・src/persist/codec.ts。作業メモ SPEC v1 §6・R0 §5・§6.1〜§6.5・§10.3、見直し safety-3〜11・14・15、gaps-6）。
// ページの地図には小さい木（tests/fixtures/q-small。4,333 枚）と、同じ木の手にやることを足した物（元の番号の重なりと空の番号も）を入れる。
//   往復: 書いて読むと同じ文書（決めた違いだけ: 手を付けていないカードの時刻は at・今日の futureVersion と futureRelease は基準の物）。
//     もう一度書くと同じ文字列。編集は本物のストアを通し、種類ぜんぶ（状態・チェック・文・見込み・タグ・利用者のカードと線・地図のカードを消す・
//     プロジェクトとシナリオの名前の変更と消し・元に戻す…）。アカウントの形（ID の振り直し・プロジェクトとシナリオの ID・ずれ・時刻）でも
//   閉じて失敗する: 同じ版で知らない鍵・指紋の違い・組み立ての版の違い・つながらない線は読まない。どんな壊し方でも止める側の失敗
//   凍らせた基準・新しい入れ物・基準の違う 2 つの文書・時差・大きさの見張り・基準が無いときに太い形で書かない・組み立ての版の上げ忘れ
// 8 万枚の木は thinMapFull.test.ts（環境変数があるときだけ）
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";
import type { DevTreeNode, MapData } from "../../src/deepmap/mapData";
import { Fnv64Stream } from "../../src/demo/impactDigest";
import { buildQuarterDoc } from "../../src/demo/quarterDoc";
import { createEmptyDoc, makeEdge, makeNode, NewerDocError, normalizeDoc, THIN_VERSION } from "../../src/model/schema";
import type { DocData, GNode } from "../../src/model/types";
import {
  checkStoredSize,
  decodeStored,
  encodeStored,
  fromStored,
  isBlockedError,
  LOCAL_MAX_CHARS,
  setCodecWarn,
  setThinBaseline,
  storedJson,
  storedVersion,
  StoredTooLargeError,
  thinBaseline,
  thinBaselineDoc,
  ThinBaselineMissingError,
  ThinMapError,
  ThinNewerError,
  ThinWriteError,
  toStored,
  type StoredDoc,
  type ThinSection,
} from "../../src/persist/codec";
import { THIN_BASELINE_VERSION, thinBaselineCore } from "../../src/persist/thinMap";
import thinMapSrc from "../../src/persist/thinMap.ts?raw";
import { Store } from "../../src/store/store";
import { loadQSmall, loadQSmallDevTree, nodeFs } from "./helpers/qSmall";
import { checkRoundTrip, expectDecoded } from "./helpers/thinCheck";
import { accountShape, EDIT_KINDS, randomEdits, seeded, type EditKind } from "./helpers/thinEdits";

let qMap: MapData;
let todoMap: MapData;

/** 小さい木の手にやることを足した地図（元の番号が同じ項目が 2 つ・元の番号の無い項目もある） */
async function withTodo(): Promise<MapData> {
  const tree = await loadQSmallDevTree();
  let k = 0;
  const walk = (n: DevTreeNode): void => {
    if (n.r === "a") {
      const c = `ind-side-d${String(k % 40).padStart(2, "0")}`;
      n.todo =
        k % 5 === 0
          ? [
              { text: `届け出の紙を出す ${k}`, cite: c },
              { text: `会社の決まりを読む ${k}`, cite: c },
              { text: `家族に相談する ${k % 9}`, cite: "" },
            ]
          : [
              { text: `副業の決まりを読む ${k % 13}`, cite: c },
              { text: `総務に聞く ${k % 7}`, cite: `sd-${k % 11}` },
            ];
      k++;
    }
    for (const c of n.kids ?? []) walk(c);
  };
  walk(tree.root);
  return fromDevTree(tree);
}

beforeAll(async () => {
  qMap = await loadQSmall();
  todoMap = await withTodo();
});

afterEach(() => {
  setThinBaseline(null);
  setCodecWarn(null);
});

const AT = "2026-11-19T03:04:05.006Z";
const keyOf = (n: GNode | undefined): string | null => (typeof n?.meta?.key === "string" ? n.meta.key : null);

/** ページの地図の新しい文書（基準の写しのカードのまま） */
function freshDoc(map: MapData, base: Parameters<typeof thinBaselineDoc>[0] = { at: AT }): DocData {
  setThinBaseline(map);
  return thinBaselineDoc(base);
}

/** 書いた形を JSON で写した物（壊して試す） */
const recordOf = (doc: DocData): StoredDoc & { maps: ThinSection[] } => JSON.parse(JSON.stringify(toStored(doc))) as StoredDoc & { maps: ThinSection[] };

/** 編集した文書（アカウントの形・やること・利用者の物・消したカード・書き換え・ID の読み替えのある物） */
function editedAccountDoc(seed = 7): DocData {
  const R = seeded(seed);
  const fresh = freshDoc(todoMap);
  const acct = accountShape(fresh, R, { rate: 0.12, rootReId: true, project: "p_independence", scenario: "s_early", dx: 872, dy: -420, at: "2026-11-12T09:30:00.000Z" });
  const store = new Store(acct);
  randomEdits(store, R, 120, EDIT_KINDS.filter((k) => k !== "undo" && k !== "redo"));
  return store.doc;
}

describe("地図の無い文書（今までと同じ）", () => {
  it("ページに地図があっても無くても、地図の無い文書はそのまま（同じ物・版 1）。読む側は今までどおり normalizeDoc", async () => {
    const doc = createEmptyDoc("自分の地図");
    doc.nodes.n_a = makeNode({ id: "n_a", title: "目標" });
    doc.nodes.n_b = makeNode({ id: "n_b", title: "行動" });
    doc.edges.e_a = makeEdge({ id: "e_a", source: "n_a", target: "n_b" });
    expect(toStored(doc)).toBe(doc);
    expect(encodeStored(doc).stats).toBeNull();
    expect(storedVersion(toStored(doc))).toBe(1);
    setThinBaseline(qMap);
    expect(toStored(doc)).toBe(doc);
    const back = decodeStored(JSON.parse(JSON.stringify(doc)));
    expect(back).toEqual(normalizeDoc(JSON.parse(JSON.stringify(doc))));
    // アカウントの形の版 6 の文書（太い形の版 6 の地図。3 か月ごとの地図ではない）もそのまま
    const fs = await nodeFs();
    const r6 = normalizeDoc(JSON.parse(new TextDecoder().decode(fs.readFileSync(new URL("../fixtures/account-r6.json", import.meta.url))))).doc;
    expect(toStored(r6)).toBe(r6);
    setThinBaseline(null);
    expect(toStored(r6)).toBe(r6);
  });

  it("版 2 でも maps の無い文書は、ふつうの文書として読む（書き手は書かない）。版 3 は新しい版", () => {
    const doc = createEmptyDoc();
    expect(fromStored({ ...JSON.parse(JSON.stringify(doc)), version: 2 })).toEqual({ ...normalizeDoc(JSON.parse(JSON.stringify(doc))).doc, updatedAt: doc.updatedAt, createdAt: doc.createdAt });
    expect(() => fromStored({ ...JSON.parse(JSON.stringify(doc)), version: 3 })).toThrow(NewerDocError);
    expect(() => fromStored({ ...JSON.parse(JSON.stringify(doc)), version: 3, maps: [] })).toThrow(NewerDocError);
  });
});

describe("書いて読むと同じ文書", () => {
  it("新しい地図: 薄い形は小さく（今日だけ丸ごと）、読むと同じ文書を新しい入れ物で返す。カードは基準の物を共有する", () => {
    const fresh = freshDoc(qMap);
    const { stored, json, decoded, sec } = checkRoundTrip(fresh);
    expect(Object.keys(stored.nodes)).toEqual([sec.root]);
    expect(Object.keys(stored.edges)).toEqual([]);
    expect(json.length).toBeLessThan(4000);
    const rec = thinBaseline()!;
    expect(sec).toMatchObject({ v: 1, key: "r", release: qMap.header.release, hash: qMap.header.hash, digest: rec.digest, bv: THIN_BASELINE_VERSION, anchor: "2026-11", at: AT, dx: 0, dy: 0 });
    expect(sec.n ?? sec.e ?? sec.nid ?? sec.eid ?? sec.pin ?? sec.pmap ?? sec.smap).toBeUndefined();
    expect(rec.digest).toMatch(/^[0-9a-z]{14}$/);
    // 新しい入れ物（読むたびに別の入れ物・凍っていない）。手を付けていないカードは基準の物
    const again = fromStored(JSON.parse(json));
    for (const k of ["nodes", "edges", "projects", "scenarios", "projectOrder", "scenarioOrder", "meta"] as const) {
      expect(decoded[k]).not.toBe(again[k]);
      expect(Object.isFrozen(decoded[k])).toBe(false);
    }
    const someCard = Object.keys(decoded.nodes).find((id) => id !== sec.root)!;
    expect(decoded.nodes[someCard]).toBe(again.nodes[someCard]);
    expect(decoded.nodes[someCard]).toBe(fresh.nodes[someCard]);
  });

  it("性質: 編集の種類ぜんぶを種から混ぜても、書いて読むと同じ文書（小さい木とやることのある木・新しい地図とアカウントの形）", () => {
    const seen = new Set<EditKind>();
    const sizes: number[] = [];
    for (let seed = 1; seed <= 16; seed++) {
      const R = seeded(seed * 7919);
      const map = seed % 2 ? todoMap : qMap;
      let doc = freshDoc(map, { at: seed % 3 ? AT : "2026-11-01T00:00:00.000Z" });
      if (seed % 4 === 0) doc = accountShape(doc, R, { rate: 0.1, rootReId: seed % 8 === 0, project: "p_spelldash", scenario: "s_balance", dx: 300 * (seed % 5), dy: -40, at: "2026-11-12T09:30:00.000Z" });
      const store = new Store(doc);
      for (const k of randomEdits(store, R, 80)) seen.add(k);
      const { json } = checkRoundTrip(store.doc);
      sizes.push(json.length);
      // 読んだ文書を、さらに編集してもう一度
      const again = new Store(fromStored(JSON.parse(json)));
      for (const k of randomEdits(again, R, 25)) seen.add(k);
      checkRoundTrip(again.doc);
    }
    expect([...EDIT_KINDS].filter((k) => !seen.has(k))).toEqual([]);
    // 編集が 120 回あっても、薄い形は小さい（4,333 枚の地図の太い形は 100 万文字を超える）
    expect(Math.max(...sizes)).toBeLessThan(250_000);
  });

  it("アカウントの形（今日・カード・線・やることの項目・プロジェクト・シナリオの ID が乱数の形、位置がずれ、時刻が違う）: ID の読み替え・pmap・smap・dx・dy・at", () => {
    const doc = editedAccountDoc();
    const { sec, stored } = checkRoundTrip(doc);
    expect(sec.nid && Object.keys(sec.nid).length).toBeGreaterThan(50);
    expect(sec.eid && Object.keys(sec.eid).length).toBeGreaterThan(50);
    expect(Object.values(sec.pmap ?? {})).toHaveLength(1);
    expect(Object.keys(sec.pmap ?? {})).toEqual(["p_independence"]);
    expect(Object.keys(sec.smap ?? {})).toEqual(["s_early"]);
    expect([sec.dx, sec.dy, sec.at]).toEqual([872, -420, "2026-11-12T09:30:00.000Z"]);
    // 今日は乱数の形の ID のまま丸ごと（読み替えに入れない）
    expect(sec.root).toMatch(/^n_[0-9a-z]{12}$/);
    expect(stored.nodes[sec.root]).toBeDefined();
    // 書き換えたカードは元の題名・短い名前・月を持つ（safety-7）。利用者の線が指すカードには印
    const n = Object.values(sec.n ?? {}).filter((p): p is Exclude<typeof p, 0 | -1> => p !== 0 && p !== -1);
    expect(n.length).toBeGreaterThan(10);
    for (const p of n) expect(p.was).toEqual(expect.objectContaining({ t: expect.any(String), s: expect.any(String), m: expect.any(Number) }));
    expect(Object.keys(sec.pin ?? {}).length).toBeGreaterThan(0);
  });

  it("手を付けていないカードの時刻は at にそろう（決めた違い）。書き換えたカードは自分の時刻を持つ", () => {
    setThinBaseline(qMap);
    const built = buildQuarterDoc(qMap, { version: qMap.header.hash, release: qMap.header.release, at: Date.parse(AT) });
    // 太い形で読み込んだ地図（基準の写しとは別の物）: 1 枚だけ時刻を変え、1 枚は題名も変える
    const ids = Object.keys(built.nodes);
    const a = ids[5]!;
    const b = ids[9]!;
    built.nodes[a] = { ...built.nodes[a]!, updatedAt: "2026-12-01T00:00:00.000Z" };
    built.nodes[b] = { ...built.nodes[b]!, title: "自分で直した題名", updatedAt: "2026-12-02T00:00:00.000Z" };
    const { decoded, sec } = checkRoundTrip(built);
    expect(sec.at).toBe(AT);
    expect(decoded.nodes[a]!.updatedAt).toBe(AT);
    expect(decoded.nodes[b]!.updatedAt).toBe("2026-12-02T00:00:00.000Z");
    expect(Object.keys(sec.n ?? {})).toHaveLength(1);
  });

  it("今日の futureVersion・futureRelease は、書くときも読むときも基準の物（入口の meta を書き換えても版は変わらない: gaps-6）", () => {
    const fresh = freshDoc(qMap);
    const rootId = Object.keys(fresh.nodes).find((id) => fresh.nodes[id]!.meta.forecastRoot === true)!;
    const r = fresh.nodes[rootId]!;
    fresh.nodes[rootId] = { ...r, meta: { ...r.meta, futureVersion: "old", futureRelease: 6 } };
    const stored = toStored(fresh);
    expect(stored.nodes[rootId]!.meta).toMatchObject({ futureVersion: qMap.header.hash, futureRelease: qMap.header.release });
    const back = fromStored(JSON.parse(JSON.stringify(stored)));
    expect(back.nodes[rootId]!.meta).toMatchObject({ futureVersion: qMap.header.hash, futureRelease: qMap.header.release });
    // 保存した今日の meta を書き換えても、読むと基準の物
    const rec = recordOf(fresh);
    rec.nodes[rootId]!.meta.futureRelease = 99;
    expect(fromStored(rec).nodes[rootId]!.meta.futureRelease).toBe(qMap.header.release);
  });

  it("シナリオ・プロジェクトを消しても名前を変えても、変えた所は増えない（線のシナリオも読み替える: safety-15）", () => {
    const fresh = freshDoc(qMap);
    const size0 = JSON.stringify(toStored(fresh)).length;
    const store = new Store(fresh);
    store.transact("名前", (tx) => void tx.updateProject("p_spelldash", { name: "SpellDash（改）" }));
    store.transact("名前", (tx) => void tx.updateScenario("s_focus", { name: "SpellDash に寄せる" }));
    store.transact("消す", (tx) => tx.deleteScenario("s_balance"));
    store.transact("消す", (tx) => tx.deleteProject("p_fcmarketing"));
    const { json, sec } = checkRoundTrip(store.doc);
    expect(sec.smap).toEqual({ s_balance: null });
    expect(sec.pmap).toEqual({ p_fcmarketing: null });
    expect(sec.n ?? sec.e).toBeUndefined();
    expect(json.length - size0).toBeLessThan(1500);
    // 元に戻すと、読み替えも消える
    store.undo();
    store.undo();
    expect(toStored(store.doc).maps![0]!.smap ?? toStored(store.doc).maps![0]!.pmap).toBeUndefined();
  });

  it("読み込んだ文書をストアで編集しても基準は変わらず、書き換えは次に書いた物に入る（safety-11）", () => {
    const fresh = freshDoc(qMap);
    const decoded = fromStored(JSON.parse(JSON.stringify(toStored(fresh))));
    const store = new Store(decoded);
    const id = Object.keys(decoded.nodes).find((x) => typeof decoded.nodes[x]!.meta.ak === "string")!;
    const before = decoded.nodes[id]!;
    store.transact("選ぶ", (tx) => void tx.updateNode(id, { status: "active" }));
    const stored = toStored(store.doc);
    const key = keyOf(before)!;
    expect(stored.maps![0]!.n![key]).toMatchObject({ f: { status: "active" } });
    // 基準のカードは変わっていない（次に読んだ文書・基準の文書）
    expect(before.status).toBe("open");
    expect(fromStored(JSON.parse(JSON.stringify(toStored(fresh)))).nodes[id]!.status).toBe("open");
    expect(thinBaselineDoc({ at: AT }).nodes[id]!.status).toBe("open");
  });

  it("基準（pmap・at・dx）の違う 2 つの文書を同じ時に読んでも、それぞれの文書になる（safety-11）", () => {
    const R = seeded(5);
    const a = freshDoc(qMap);
    const b = accountShape(thinBaselineDoc({ at: "2026-10-30T00:00:00.000Z" }), R, { rate: 0.05, project: "p_independence", dx: 120, dy: 80 });
    const sa = JSON.stringify(toStored(a));
    const sb = JSON.stringify(toStored(b));
    expect(JSON.parse(sb).maps[0].pmap).toBeDefined();
    for (let i = 0; i < 3; i++) {
      const da = fromStored(JSON.parse(sa));
      const db = fromStored(JSON.parse(sb));
      expectDecoded(da, a, JSON.parse(sa).maps[0]);
      expectDecoded(db, b, JSON.parse(sb).maps[0]);
      expect(JSON.stringify(toStored(db))).toBe(sb);
      expect(JSON.stringify(toStored(da))).toBe(sa);
    }
  });

  it("やることのチェックは元の番号と枠で覚える（同じ番号の 2 つ目は #2・番号の無い項目は空。safety-8）。文を変えると丸ごと書き、元の番号と指紋を持つ", () => {
    const fresh = freshDoc(todoMap);
    const store = new Store(fresh);
    const opt = Object.values(fresh.nodes).find((n) => n.conditions.length === 3)!;
    store.transact("チェック", (tx) => void tx.updateNode(opt.id, { conditions: opt.conditions.map((c) => ({ ...c, met: true })) }));
    const cites = opt.meta.cites as string[];
    expect(cites[0]).toBe(cites[1]);
    let p = toStored(store.doc).maps![0]!.n![keyOf(opt)!] as { k?: string[]; f?: Record<string, unknown> };
    expect(p.k).toEqual([cites[0], `${cites[0]}#2`, ""]);
    expect(p.f).toEqual({ updatedAt: store.doc.nodes[opt.id]!.updatedAt });
    checkRoundTrip(store.doc);
    // チェックを外すと書き換えは無くなる
    const cur = store.doc.nodes[opt.id]!;
    store.transact("外す", (tx) => void tx.updateNode(opt.id, { conditions: cur.conditions.map((c) => ({ ...c, met: false })) }));
    expect(toStored(store.doc).maps![0]!.n).toBeUndefined();
    // 文を変えたら丸ごと（元の番号と文の指紋も）
    const cur2 = store.doc.nodes[opt.id]!;
    store.transact("文", (tx) => void tx.updateNode(opt.id, { conditions: cur2.conditions.map((c, k) => (k === 1 ? { ...c, text: "自分の言葉で", met: true } : c)) }));
    p = toStored(store.doc).maps![0]!.n![keyOf(opt)!] as { k?: string[]; f?: Record<string, unknown>; was?: { c?: string[]; k0?: string[] } };
    expect(p.k).toBeUndefined();
    expect(p.f!.conditions).toHaveLength(3);
    expect((p as { was: { c: string[]; k0: string[] } }).was.c).toEqual(cites);
    expect((p as { was: { c: string[]; k0: string[] } }).was.k0).toEqual(opt.meta.k0);
    checkRoundTrip(store.doc);
  });

  it("印: 利用者の線（地図から・地図へ・カードどうし）が指す地図のカードに {t, s, m}（今日は丸ごとなので印にしない: safety-7）", () => {
    const fresh = freshDoc(qMap);
    const store = new Store(fresh);
    const cards = Object.values(fresh.nodes).filter((n) => keyOf(n) !== null && n.meta.forecastRoot !== true);
    const root = Object.values(fresh.nodes).find((n) => n.meta.forecastRoot === true)!;
    const [a, b, c] = [cards[3]!, cards[40]!, cards[900]!];
    const u = makeNode({ title: "自分のカード" });
    store.transact("足す", (tx) => {
      tx.addNode(u);
      tx.addEdge(makeEdge({ source: a.id, target: u.id }));
      tx.addEdge(makeEdge({ source: u.id, target: b.id, relation: "supports" }));
      tx.addEdge(makeEdge({ source: b.id, target: c.id, relation: "blocks" }));
      tx.addEdge(makeEdge({ source: root.id, target: u.id }));
    });
    const { sec } = checkRoundTrip(store.doc);
    expect(Object.keys(sec.pin!)).toEqual([keyOf(a), keyOf(b), keyOf(c)].sort((x, y) => qMap.indexOfKey(x!) - qMap.indexOfKey(y!)));
    expect(sec.pin![keyOf(b)!]).toEqual({ t: b.title, s: b.meta.short, m: b.meta.m });
  });

  it("同じ鍵のカードが 2 つ: 入口からたどれる物を地図のカードにし、もう 1 つは丸ごと書く（新しい版にするときと同じ決まり）", () => {
    const fresh = freshDoc(qMap);
    const card = Object.values(fresh.nodes).find((n) => typeof n.meta.ak === "string")!;
    const copy: GNode = { ...card, id: "n_dupdupdupdup", title: "前の版で足し直した", createdAt: "2026-01-01T00:00:00.000Z", x: 999 };
    fresh.nodes[copy.id] = copy;
    const stored = toStored(fresh);
    expect(Object.keys(stored.nodes)).toContain(copy.id);
    expect(stored.maps![0]!.n).toBeUndefined();
    expect(encodeStored(fresh).stats!.fatKeyed).toBe(1);
    const back = fromStored(JSON.parse(JSON.stringify(stored)));
    expect(back.nodes[copy.id]).toEqual(copy);
    expect(back.nodes[card.id]).toBe(card);
    expect(JSON.stringify(toStored(back))).toBe(JSON.stringify(stored));
  });

  it("太い形で読み込んだ地図（基準の写しとは別の物）も薄く書け、読むと同じ文書になる", () => {
    setThinBaseline(qMap);
    const built = buildQuarterDoc(qMap, { version: qMap.header.hash, release: qMap.header.release, at: Date.parse("2026-11-05T00:00:00.000Z") });
    const fat = normalizeDoc(JSON.parse(JSON.stringify(built))).doc;
    const r = encodeStored(fat);
    expect(r.stats).toMatchObject({ patched: 0, tombs: 0, nid: 0, eid: 0, storedNodes: 1, storedEdges: 0 });
    expect(r.stats!.compared).toBe(r.stats!.cards);
    checkRoundTrip(fat);
  });
});

describe("閉じて失敗する（同じ版で合わない物は読まない: safety-4）", () => {
  const blocked = (rec: unknown, code: string): void => {
    let err: unknown;
    try {
      fromStored(rec);
    } catch (e) {
      err = e;
    }
    expect(err, `読めてしまった（${code} のはず）`).toBeInstanceOf(ThinMapError);
    expect((err as ThinMapError).code).toBe(code);
    expect(isBlockedError(err)).toBe(true);
  };

  it("知らない鍵の変更・消し・ID の読み替え・線の変更・線の ID の読み替え・印・チェック", () => {
    const doc = editedAccountDoc(11);
    const base = recordOf(doc);
    expect(fromStored(base)).toBeDefined();
    const unknown = "r.zz_unknown.k";
    const s0 = base.maps[0]!;
    const somePatchKey = Object.keys(s0.n!).find((k) => typeof s0.n![k] === "object")!;
    const cases: Array<[string, (s: ThinSection) => void]> = [
      ["変更", (s) => (s.n = { ...s.n, [unknown]: { f: { title: "x" }, was: { t: "", s: "", m: 0 } } })],
      ["消し 0", (s) => (s.n = { ...s.n, [unknown]: 0 })],
      ["消し −1", (s) => (s.n = { ...s.n, [unknown]: -1 })],
      ["今日の変更", (s) => (s.n = { ...s.n, r: { f: { title: "x" }, was: { t: "", s: "", m: 0 } } })],
      ["ID の読み替え", (s) => (s.nid = { ...s.nid, [unknown]: "n_aaaaaaaaaaaa" })],
      ["線の変更", (s) => (s.e = { ...s.e, [unknown]: { f: { label: "x" } } })],
      ["線の消し", (s) => (s.e = { ...s.e, [unknown]: 0 })],
      ["線の ID の読み替え", (s) => (s.eid = { ...s.eid, [unknown]: "e_aaaaaaaaaaaa" })],
      ["印", (s) => (s.pin = { ...s.pin, [unknown]: { t: "", s: "", m: 0 } })],
      ["知らないチェック", (s) => ((s.n![somePatchKey] as { k?: string[] }).k = ["no-such-cite"])],
      ["元の題名が違う", (s) => ((s.n![somePatchKey] as { was: { t: string } }).was.t = "別の題名")],
      ["知らないプロジェクトの読み替え", (s) => (s.pmap = { ...s.pmap, p_unknown: null })],
    ];
    for (const [what, f] of cases) {
      const rec = structuredClone(base);
      f(rec.maps[0]!);
      if (what === "知らないチェック" && (rec.maps[0]!.n![somePatchKey] as { f?: Record<string, unknown> }).f?.conditions) delete (rec.maps[0]!.n![somePatchKey] as { f?: Record<string, unknown> }).f!.conditions;
      blocked(rec, "mismatch");
    }
  });

  it("中身の指紋・基準の文書の指紋・組み立ての版・地図の年月・今日の鍵が違う", () => {
    const base = recordOf(freshDoc(qMap));
    for (const [k, v] of [
      ["hash", "0000000000000x"],
      ["digest", "0000000000000x"],
      ["bv", THIN_BASELINE_VERSION + 1],
      ["anchor", "2027-02"],
      ["key", "r2"],
    ] as const) {
      const rec = structuredClone(base);
      (rec.maps[0] as unknown as Record<string, unknown>)[k] = v;
      blocked(rec, "mismatch");
    }
  });

  it("組み立てが変わった（同じ版の順番・同じ中身の指紋で、基準の文書の指紋が違う）: 書いた地図と違う基準では読まない", () => {
    const rec = recordOf(freshDoc(todoMap));
    expect(todoMap.header.hash).toBe(qMap.header.hash);
    setThinBaseline(qMap);
    blocked(rec, "mismatch");
    // ページの版の記録の指紋が違うときも
    setThinBaseline(todoMap, { digest: "0123456789abcd" });
    blocked(rec, "mismatch");
    setThinBaseline(todoMap);
    expect(fromStored(rec)).toBeDefined();
  });

  it("保存した今日のカードが入口の形でない（印・地図の年月・鍵が無い）: 読まない（読むと次に書くとき地図ごと太い形になる）", () => {
    const rec = recordOf(freshDoc(qMap));
    const rootId = rec.maps[0]!.root;
    for (const k of ["forecastRoot", "anchor", "impact"] as const) {
      const r = structuredClone(rec);
      delete r.nodes[rootId]!.meta[k];
      blocked(r, "mismatch");
    }
    const r2 = structuredClone(rec);
    delete r2.nodes[rootId];
    blocked(r2, "mismatch");
  });

  it("利用者の線の端のカードが無い（消したカード・知らない ID）: 線を黙って捨てずに読まない", () => {
    const fresh = freshDoc(qMap);
    const store = new Store(fresh);
    const card = Object.values(fresh.nodes).find((n) => typeof n.meta.ak === "string")!;
    const u = makeNode({ title: "自分" });
    store.transact("足す", (tx) => {
      tx.addNode(u);
      tx.addEdge(makeEdge({ id: "e_mine", source: u.id, target: card.id }));
    });
    const rec = recordOf(store.doc);
    // 線の先を、消したカードに（消しの印を足す）
    const r1 = structuredClone(rec);
    r1.maps[0]!.n = { ...r1.maps[0]!.n, [keyOf(card)!]: 0 };
    delete r1.maps[0]!.pin;
    blocked(r1, "mismatch");
    // 線の先を、知らない ID に
    const r2 = structuredClone(rec);
    r2.edges.e_mine!.target = "n_i_00000000000000";
    blocked(r2, "mismatch");
  });

  it("ページに地図が無い → unavailable、前の版 → older、新しい版 → ThinNewerError（NewerDocError の一種）", () => {
    const rec = recordOf(freshDoc(qMap));
    setThinBaseline(null);
    blocked(rec, "unavailable");
    setThinBaseline(qMap);
    const older = structuredClone(rec);
    older.maps[0]!.release = qMap.header.release - 1;
    if (older.maps[0]!.release >= 0) blocked(older, "older");
    const newer = structuredClone(rec);
    newer.maps[0]!.release = qMap.header.release + 1;
    expect(() => fromStored(newer)).toThrow(ThinNewerError);
    expect(() => fromStored(newer)).toThrow(NewerDocError);
    const newerForm = structuredClone(rec);
    newerForm.maps[0]!.v = 2;
    expect(() => fromStored(newerForm)).toThrow(NewerDocError);
    // 前の版の印は、小さい木の版の順番を上げたページで確かめる（小さい木の版は 0）
    const up = fromDevTreeWithRelease(qMap.header.release + 1);
    setThinBaseline(up);
    blocked(rec, "older");
  });

  it("形が読めない → corrupt（止める側。壊れたデータとは見なさない）", () => {
    const rec = recordOf(editedAccountDoc(3));
    const cases: Array<(r: Record<string, unknown>) => void> = [
      (r) => (r.maps = "x"),
      (r) => (r.maps = [{}, {}]),
      (r) => ((r.maps as ThinSection[])[0]!.at = "いつか"),
      (r) => ((r.maps as ThinSection[])[0]!.dx = Number.NaN),
      (r) => ((r.maps as ThinSection[])[0]!.root = "空白 入り"),
      (r) => ((r.maps as unknown as Array<Record<string, unknown>>)[0]!.n = []),
      (r) => ((r.maps as unknown as Array<Record<string, unknown>>)[0]!.n = { "r.x": "0" }),
      (r) => ((r.maps as unknown as Array<Record<string, unknown>>)[0]!.nid = { "r.x": 5 }),
      (r) => (r.schema = "other"),
    ];
    for (const f of cases) {
      const r = structuredClone(rec) as unknown as Record<string, unknown>;
      f(r);
      blocked(r, "corrupt");
    }
  });

  it("どんな壊し方でも、薄い形の失敗はいつも止める側（ThinMapError・NewerDocError）。ほかの例外を出さない（safety-3）", () => {
    const rec = recordOf(editedAccountDoc(5));
    const R = seeded(99);
    const paths: string[][] = [];
    const walk = (x: unknown, p: string[], depth: number): void => {
      if (depth > 5 || paths.length > 4000) return;
      paths.push(p);
      if (x && typeof x === "object") for (const k of Object.keys(x).slice(0, 12)) walk((x as Record<string, unknown>)[k], [...p, k], depth + 1);
    };
    walk(rec, [], 0);
    const junk = [null, 0, -1, 1.5, "", "x", [], {}, true, { f: null }, ["a"], Number.NaN];
    let ok = 0;
    let bad = 0;
    for (let t = 0; t < 250; t++) {
      const r = structuredClone(rec) as unknown as Record<string, unknown>;
      const p = paths[1 + Math.floor(R() * (paths.length - 1))]!;
      let o: Record<string, unknown> = r;
      for (let i = 0; i < p.length - 1; i++) o = o[p[i]!] as Record<string, unknown>;
      const last = p[p.length - 1]!;
      if (R() < 0.3) delete o[last];
      else o[last] = junk[Math.floor(R() * junk.length)];
      try {
        fromStored(r);
        ok++;
      } catch (e) {
        expect(isBlockedError(e), `${p.join(".")}: ${String(e)}`).toBe(true);
        bad++;
      }
    }
    // 多くの壊し方は、保存した利用者の物の中（normalizeDoc が整える）。地図の変更の形を壊した物は読まない
    expect(bad).toBeGreaterThan(12);
    expect(ok + bad).toBe(250);
  });
});

/** 小さい木の版の順番を変えた地図（前の版・新しい版のページの代わり） */
function fromDevTreeWithRelease(release: number): MapData {
  const m = qMap;
  return { ...m, header: { ...m.header, release } } as MapData;
}

describe("書くときの守り（safety-15）", () => {
  it("基準を入れる前に 3 か月ごとの地図のある文書を書こうとしたら止める（太い形で書かない）", () => {
    const fresh = freshDoc(qMap);
    setThinBaseline(null);
    expect(() => toStored(fresh)).toThrow(ThinBaselineMissingError);
    expect(() => toStored(fresh)).toThrow(ThinWriteError);
    // 地図の無い文書は今までどおり
    expect(toStored(createEmptyDoc())).toBeDefined();
  });

  it("ページの地図のカードがあるのに今日のカードが無い・入口の形でない（壊れた形）: 太い形で書かずに止める。少しなら今までどおり", () => {
    const fresh = freshDoc(qMap);
    const rootId = Object.keys(fresh.nodes).find((id) => fresh.nodes[id]!.meta.forecastRoot === true)!;
    const r = fresh.nodes[rootId]!;
    const noRoot: DocData = { ...fresh, nodes: { ...fresh.nodes } };
    delete noRoot.nodes[rootId];
    expect(() => toStored(noRoot)).toThrow(ThinWriteError);
    const notRoot: DocData = { ...fresh, nodes: { ...fresh.nodes, [rootId]: { ...r, meta: { ...r.meta, forecastRoot: false } } } };
    expect(() => toStored(notRoot)).toThrow(ThinWriteError);
    // 基準をまだ組み立てていないページでも
    setThinBaseline(fromDevTreeWithRelease(qMap.header.release));
    expect(() => toStored(noRoot)).toThrow(ThinWriteError);
    // 鍵のカードが少しだけ（前の版の地図の一部など）なら、今までどおりそのまま
    const few = createEmptyDoc();
    for (const id of Object.keys(fresh.nodes).slice(1, 50)) few.nodes[id] = fresh.nodes[id]!;
    expect(toStored(few)).toBe(few);
  });

  it("大きさの見張り: 1 MB を超えたら知らせ、localStorage に 400 万文字を超えて書かない", () => {
    const warned: string[] = [];
    setCodecWarn((m) => warned.push(m));
    checkStoredSize(900_000, "local");
    expect(warned).toEqual([]);
    checkStoredSize(1_200_000, "idb");
    expect(warned).toHaveLength(1);
    expect(() => checkStoredSize(LOCAL_MAX_CHARS + 1, "local")).toThrow(StoredTooLargeError);
    expect(warned).toHaveLength(1);
    expect(() => checkStoredSize(LOCAL_MAX_CHARS + 1, "idb")).not.toThrow();
    expect(warned).toHaveLength(2);
    // 地図の 1 枚に大きな本文を書いた文書
    const fresh = freshDoc(qMap);
    const id = Object.keys(fresh.nodes).find((x) => typeof fresh.nodes[x]!.meta.ak === "string")!;
    fresh.nodes[id] = { ...fresh.nodes[id]!, body: "あ".repeat(1_100_000) };
    const json = storedJson(fresh, "export");
    expect(json.length).toBeGreaterThan(1_100_000);
    expect(warned).toHaveLength(3);
    expect(storedVersion(JSON.parse(json))).toBe(THIN_VERSION);
  });
});

describe("凍らせた基準（safety-11）", () => {
  it("組み立てた基準の入れ物は凍っている（本番も）。テストではカード・線・meta も凍っていて、書き換えると止まる", () => {
    const fresh = freshDoc(qMap);
    toStored(fresh);
    const core = thinBaselineCore()!;
    for (const k of ["nodes", "edges", "projects", "scenarios", "projectOrder", "scenarioOrder", "meta"] as const) expect(Object.isFrozen(core[k])).toBe(true);
    const id = Object.keys(core.nodes)[3]!;
    const card = core.nodes[id]!;
    expect(Object.isFrozen(card)).toBe(true);
    expect(Object.isFrozen(card.meta)).toBe(true);
    expect(() => {
      (card as { status: string }).status = "active";
    }).toThrow(TypeError);
    expect(() => {
      (core.nodes as Record<string, GNode>).x = card;
    }).toThrow(TypeError);
    // 基準の写し（ずらした物）のカードも凍っている。読み込んだ文書の入れ物は凍っていない
    const shifted = thinBaselineDoc({ at: AT, dx: 50 });
    expect(Object.isFrozen(shifted.nodes[id])).toBe(true);
    expect(Object.isFrozen(shifted.nodes)).toBe(false);
  });

  it("組み立ての決まりの見張り: 本番のビルドでもカードの入れ物を凍らせる（コードで確かめる）", () => {
    expect(thinMapSrc).toMatch(/Object\.freeze\(doc\.nodes\);\s*Object\.freeze\(doc\.edges\);\s*Object\.freeze\(doc\.projects\);\s*Object\.freeze\(doc\.scenarios\);/);
    // 書き手は文書の nodes・edges を for…in で回さない（perf-10）
    expect(thinMapSrc).not.toMatch(/for \(const \w+ in (doc|docNodes|docEdges)/);
  });
});

describe("時差（safety-14）", () => {
  it("America/Los_Angeles で書いて Asia/Tokyo で読んでも同じ文書・同じ指紋・同じ文字列", () => {
    const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
    const was = env.TZ;
    try {
      env.TZ = "America/Los_Angeles";
      expect(new Date(Date.UTC(2026, 10, 19, 3)).getDate()).toBe(18);
      const doc = editedAccountDoc(21);
      const digestLA = thinBaseline()!.digest;
      const json = JSON.stringify(toStored(doc));
      env.TZ = "Asia/Tokyo";
      expect(new Date(Date.UTC(2026, 10, 19, 3)).getDate()).toBe(19);
      setThinBaseline(todoMap);
      expect(thinBaseline()!.digest).toBe(digestLA);
      const back = fromStored(JSON.parse(json));
      expectDecoded(back, doc, JSON.parse(json).maps[0]);
      expect(JSON.stringify(toStored(back))).toBe(json);
    } finally {
      if (was === undefined) delete env.TZ;
      else env.TZ = was;
    }
  });
});

/** 基準の全部の指紋（カードと線の、時刻のほかの全部の項目。組み立ての版の上げ忘れを見つける） */
function baselinePrint(map: MapData): string {
  setThinBaseline(map);
  const d = thinBaselineDoc({ at: AT });
  const h = new Fnv64Stream();
  const strip = (x: { createdAt?: string; updatedAt?: string }): string => JSON.stringify({ ...x, createdAt: undefined, updatedAt: undefined });
  for (const id of Object.keys(d.nodes)) h.add(strip(d.nodes[id]!)).add("\n");
  for (const id of Object.keys(d.edges)) h.add(strip(d.edges[id]!)).add("\n");
  return h.digest();
}

describe("組み立ての版（THIN_BASELINE_VERSION）の上げ忘れ", () => {
  it("小さい木とやることのある木の基準の全部の指紋が決まった値（変わったら THIN_BASELINE_VERSION を上げてから、この値を直す）", () => {
    // 基準の文書の指紋（4DQD2）に入らない所（カードの種類・線の関係・印・指紋・順位・位置・題名と文）も見る。
    // 組み立て（src/demo/quarterDoc.ts）を変えてこれが変わったら、同じ版の順番で保存した薄い形を読むと、黙って違う地図になる。
    // THIN_BASELINE_VERSION を上げれば、前の bv の文書は読まずに止まる（版をまたぐ道へ回す）
    expect({ bv: THIN_BASELINE_VERSION, q: baselinePrint(qMap), todo: baselinePrint(todoMap) }).toEqual({ bv: 1, q: "0kfl3bj1ad693n", todo: "134vakb0yf1dl3" });
  });

  it("鍵・ID・日付は乱数も時計も使わない（同じ地図なら、いつどこで組み立てても同じ基準）", () => {
    expect(thinMapSrc).not.toMatch(/Math\.random|newId\(|nowISO\(|Date\.now\(/);
    const a = baselinePrint(qMap);
    const b = baselinePrint(qMap);
    expect(a).toBe(b);
  });
});
