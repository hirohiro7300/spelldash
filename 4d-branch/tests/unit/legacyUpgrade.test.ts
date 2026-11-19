// 版 6 までの地図（太い形）を、読むときにページの 3 か月ごとの地図へ引き上げる（作業メモ SPEC v1 §8・D11、見直し safety-1・safety-2・safety-13・
// user-6・gaps-5・gaps-14）。ページの地図には小さい木（tests/fixtures/q-small。4,333 枚）を版 7 として入れる（既定のテストでも、版 7 の候補を
// 入れたテストでも同じ）。版 7 の候補での確かめは legacyUpgradeFull.test.ts。
//   - 合成のアカウントの形の版 6 の文書（tests/fixtures/account-r6.json）: 利用者が入れた物は、どの深さの物も、鍵の同じカード・読み替えた手・
//     「前の版で決めたこと」のどれかにある（凍結した版 6 の地図と比べて数え上げ、比べる）。利用者のノードと線はそのまま
//   - いつも同じ結果（2 回・2 つの時差）。id と更新時刻はそのまま。次に保存すると薄い形で、小さい
//   - 保存先・アカウント・取り込み・バックアップのどの道でも同じ。アカウントには書かない（同じ id と更新時刻なので、送る変更にならない）
//   - 前の版のページで止める前の編集を引き上げて開いても、アカウントの新しい版の内容と重なれば聞いてから（safety-2）
//   - 知らせと確認の文は、移した数・残した数をそのまま言う（user-6）
//   - 既定のビルド（ページの地図なし）は何も変わらない: 版 6 の地図のまま読み、概要と順位も出る
import "fake-indexeddb/auto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import legacySrc from "../../src/persist/legacyMap.ts?raw";
import type { MapData } from "../../src/deepmap/mapData";
import { isDisposableDoc } from "../../src/demo/demo";
import { swapFutureDoc } from "../../src/demo/futureSwap";
import { computeForecast } from "../../src/model/forecast";
import { buildIndex } from "../../src/model/graph";
import { computeImpact } from "../../src/model/impact";
import { keyDecisions, worthRanking } from "../../src/model/impactRank";
import { createEmptyDoc, makeNode, makeProject, normalizeDoc, THIN_VERSION } from "../../src/model/schema";
import type { DocData, GNode } from "../../src/model/types";
import {
  decodeStored,
  enableThinPage,
  holdsPageMap,
  needsPageMap,
  setCodecWarn,
  setThinBaseline,
  storedMapReleaseOf,
  storedUpgradeOf,
  thinBaselineDoc,
  toStored,
  upgradeNotice,
  type StoredDoc,
  type ThinUpgradeInfo,
} from "../../src/persist/codec";
import { CloudRepo, CloudSync, mapReleaseOf, type BootDoc, type CloudBackend, type CloudCodec, type CloudDoc, type SyncBase } from "../../src/persist/cloud";
import { exportText, previewImportAsync } from "../../src/persist/io";
import { movedIndex } from "../../src/persist/legacyMap";
import { pageMapAccess } from "../../src/persist/thinMap";
import { memoryKV, Persistence } from "../../src/persist/persistence";
import { Store } from "../../src/store/store";
import { rawAll, rawGet, rawPut } from "./helpers/idbRaw";
import { ACCOUNT_R6_RAW, accountR6Doc, checkUpgrade, inventory } from "./helpers/legacyCheck";
import { loadQSmall } from "./helpers/qSmall";
import { buildR6Future } from "./helpers/r6";
import { expectDecoded } from "./helpers/thinCheck";

/** ページの地図: 小さい木を版 7 として（版 6 の地図より新しい版） */
let page: MapData;

beforeAll(async () => {
  const q = await loadQSmall();
  page = { ...q, header: { ...q.header, release: 7 } } as MapData;
});

afterEach(() => {
  enableThinPage(null);
  setThinBaseline(null);
  setCodecWarn(null);
});

const keyOf = (n: GNode | undefined): string | null => (typeof n?.meta?.key === "string" ? n.meta.key : null);
const rootOf = (d: DocData): GNode => Object.values(d.nodes).find((n) => n.meta.forecastRoot === true)!;

/** 引き上げた結果（読む口を通して: 保存してあった形の JSON から） */
function upgraded(raw = ACCOUNT_R6_RAW): { doc: DocData; info: ThinUpgradeInfo } {
  setThinBaseline(page);
  const d = decodeStored(JSON.parse(raw));
  expect(d.upgrade).toBeDefined();
  return { doc: d.doc, info: d.upgrade! };
}

describe("版 6 の地図の引き上げ: 利用者が入れた物は、どの深さの物も、移すか別のカードに残す（無くさない）", () => {
  it("アカウントの形の文書: 選んだ手・見送り・チェック・書き換え・見込み・タグ・自分のカードと線を、数え上げて比べる", () => {
    const input = accountR6Doc();
    const { doc, info } = upgraded();
    const r = checkUpgrade(input, doc, page);
    // 深さ 1〜6 の利用者の物（凍結した版 6 の地図と比べた数え上げ）の、どれにも行き先がある
    const inv = inventory(input);
    const withState = [...inv.kinds.keys()].filter((k) => k !== "r").length;
    expect(r.kept + r.moved + r.detached).toBe(withState);
    const L = info.legacy!;
    expect(L).toBeDefined();
    expect([L.kept.cards, L.moved.cards, L.detached.cards]).toEqual([r.kept, r.moved, r.detached]);
    expect(info.detached).toBe(r.detached);
    expect(info.applied).toBe(r.kept + r.moved);
    expect(info.lostTicks).toBe(0);
    // 小さい木には最初の手が 3 つ（今のまま・届け出て副業・今すぐ独立）しか無い: ほかの手の下の物は別のカードに、届け出て副業の 3 か月後の手は読み替えて移す
    expect(r.moved).toBeGreaterThanOrEqual(1);
    expect(r.detached).toBeGreaterThanOrEqual(8);
    for (const kind of ["active", "dropped", "tick", "own-todo", "title", "body", "tag", "prob", "edge-text", "own-edge", "own-child", "due", "start", "type", "project", "scenario"]) expect([kind, (r.kinds[kind] ?? 0) > 0]).toEqual([kind, true]);
    // 読み替えた手: 届け出て副業 → 1 社目が見つかった 3 か月後の副業の手のチェックは、新しい地図の同じ状態の 3 か月目の同じ種類の手へ（項目は文ごと）
    const side = inv.card.get("r.ad_permside.a0_a1.ad_side")!;
    const moved = doc.nodes[side.id]!;
    expect(keyOf(moved)).toBe("r.ad_permside.a0_a1.1ad");
    expect(moved.conditions.filter((c) => c.met).map((c) => c.text)).toEqual(side.conditions.filter((c) => c.met).map((c) => c.text));
    // 線の説明と条件の書き換え（3 か月後の状態への線）は、鍵の同じ線に
    const s = inv.card.get("r.ad_permside.s")!;
    const into = Object.values(doc.edges).find((e) => e.target === s.id)!;
    expect([into.label, into.condition]).toEqual(["自分の説明", "自分の条件"]);
    // 77% に直した見込み（小さい木に無い手の下）は、別のカードの meta に
    const high = doc.nodes[inv.card.get("r.fc_switch.high")!.id]!;
    expect(high.meta.prevEdge).toEqual({ p0: 10, prob: 77 });
    // 「前の版で決めたこと」の見出し: 今日の左、地図の外の自分のカードと重ならない
    const g = r.prevGroup!;
    expect(g.title).toBe("前の版で決めたこと");
    expect(g.meta.prevGroup).toBe(6);
    expect(g.x).toBeLessThan(rootOf(doc).x);
    for (const o of inv.ownNodes) if (o.y > g.y - 200 && o.y < g.y + 140 * (r.detached + 1) + 200) expect(Math.abs(o.x - g.x), o.title).toBeGreaterThanOrEqual(212);
  });

  it("文書の id と更新時刻はそのまま（どの端末も送る変更にならない）。今日は新しい版の入口（年収・位置・ID はそのまま）", () => {
    const input = accountR6Doc();
    const { doc } = upgraded();
    expect([doc.id, doc.updatedAt, doc.createdAt, doc.title]).toEqual([input.id, input.updatedAt, input.createdAt, input.title]);
    expect(doc.projects).toEqual(input.projects);
    expect(doc.scenarios).toEqual(input.scenarios);
    const r0 = rootOf(input);
    const r1 = rootOf(doc);
    expect(r1.id).toBe(r0.id);
    expect([r1.x, r1.y]).toEqual([r0.x, r0.y]);
    expect(r1.meta).toMatchObject({ key: "r", anchor: page.header.anchor, futureRelease: 7, futureVersion: page.header.hash, impact: { v: 2, annual: 480 } });
    expect(holdsPageMap(doc)).toBe(true);
    expect(mapReleaseOf(doc)).toBe(7);
    expect(storedMapReleaseOf(doc)).toBe(6);
    // 地図のカードのプロジェクトは、アカウントのプロジェクト（名前で合わせる。1 つは同梱と別の ID）
    const ind = input.projectOrder.find((p) => input.projects[p]!.name === "広告運用事業での独立")!;
    expect(Object.values(doc.nodes).some((n) => keyOf(n) !== null && n.projectIds.includes(ind))).toBe(true);
  });

  it("いつも同じ結果（2 回読む・America/Los_Angeles と Asia/Tokyo）。乱数も時計も使わない", () => {
    const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
    const was = env.TZ;
    try {
      env.TZ = "America/Los_Angeles";
      expect(new Date(Date.UTC(2026, 10, 19, 3)).getDate()).toBe(18);
      const a = JSON.stringify(upgraded().doc);
      expect(JSON.stringify(upgraded().doc)).toBe(a);
      const sa = JSON.stringify(toStored(JSON.parse(a) as DocData));
      setThinBaseline(null);
      env.TZ = "Asia/Tokyo";
      expect(new Date(Date.UTC(2026, 10, 19, 3)).getDate()).toBe(19);
      const b = JSON.stringify(upgraded().doc);
      expect(b).toBe(a);
      expect(JSON.stringify(toStored(JSON.parse(b) as DocData))).toBe(sa);
    } finally {
      if (was === undefined) delete env.TZ;
      else env.TZ = was;
    }
    expect(legacySrc).not.toMatch(/Math\.random|newId\(|nowISO\(|Date\.now\(|new Date\(/);
  });

  it("引き上げた文書は、ページの地図を持つ文書として薄い形で書け（小さい）、読むとそのまま。もう一度読んでも引き上げない", () => {
    const { doc } = upgraded();
    const stored = toStored(doc);
    expect(stored.version).toBe(THIN_VERSION);
    const json = JSON.stringify(stored);
    // 版 6 の文書（約 200 万文字）が、地図の本体を省いた形に
    expect(ACCOUNT_R6_RAW.length).toBeGreaterThan(1_500_000);
    expect(json.length).toBeLessThan(40_000);
    const sec = stored.maps![0]!;
    expect(sec.release).toBe(7);
    const back = decodeStored(JSON.parse(json));
    expect(back.upgrade).toBeUndefined();
    expectDecoded(back.doc, doc, sec);
    expect(JSON.stringify(toStored(back.doc))).toBe(json);
  });

  it("手を入れていない版 6 の地図: 「前の版で決めたこと」を作らず、ページの地図のまま（薄い形はほぼ入口だけ）", () => {
    setThinBaseline(page);
    const fresh = buildR6Future().pv.doc;
    const d = decodeStored(JSON.parse(JSON.stringify(fresh)));
    expect(d.upgrade).toMatchObject({ applied: 0, detached: 0, legacy: { kept: { cards: 0 }, moved: { cards: 0 }, detached: { cards: 0 } } });
    expect(Object.values(d.doc.nodes).some((n) => n.meta.prevGroup !== undefined)).toBe(false);
    expect(Object.keys(d.doc.nodes)).toHaveLength(page.n);
    expect(Object.keys(d.doc.edges)).toHaveLength(page.n - 1);
    expect(JSON.stringify(toStored(d.doc)).length).toBeLessThan(8_000);
  });

  it("地図を新しい版にする差し替え（ページの地図にするとき）も、読むときの引き上げと同じ文書", () => {
    setThinBaseline(page);
    const res = swapFutureDoc(accountR6Doc(), thinBaselineDoc());
    const viaDecode = decodeStored(JSON.parse(ACCOUNT_R6_RAW));
    expect(res.inPlace).toBe(true);
    expect(res.legacy).toEqual(viaDecode.upgrade);
    expect(JSON.stringify(res.doc)).toBe(JSON.stringify(viaDecode.doc));
    expect(res.detached).toBe(viaDecode.upgrade!.detached);
  });

  it("名前を変えたプロジェクト（同梱と別の ID・別の名前）も、地図のカードの版 6 のプロジェクトの多数決で合わせる（カードがプロジェクトから外れない）", () => {
    const raw = JSON.parse(ACCOUNT_R6_RAW) as DocData;
    const ind = raw.projectOrder.find((p) => raw.projects[p]!.name === "広告運用事業での独立")!;
    expect(ind).not.toBe("p_independence");
    raw.projects[ind] = { ...raw.projects[ind]!, name: "独立の準備（自分の名前）" };
    setThinBaseline(page);
    const d = decodeStored(raw);
    expect(d.upgrade?.legacy).toBeDefined();
    // 同梱の「広告運用事業での独立」のカード（今すぐ独立の手など）は、名前を変えたアカウントのプロジェクトに
    const quit = Object.values(d.doc.nodes).find((n) => keyOf(n) === "r.ind_quit")!;
    expect(quit.projectIds).toEqual([ind]);
    const stored = toStored(d.doc);
    expect(stored.maps![0]!.pmap).toEqual({ p_independence: ind });
    // ほかの 2 つ（同じ ID）はそのまま
    expect(Object.values(d.doc.nodes).find((n) => keyOf(n) === "r.keep")!.projectIds).toEqual(expect.arrayContaining(["p_spelldash", "p_fcmarketing", ind]));
  });

  it("引き上げない文書: ページの地図をもう持つ・3 か月ごとの地図・地図の無い文書・新しい版にしない読み方（upgrade: none）", () => {
    setThinBaseline(page);
    const mine = createEmptyDoc("地図の無い文書");
    const n = makeNode({ title: "メモ" });
    mine.nodes[n.id] = n;
    expect(decodeStored(JSON.parse(JSON.stringify(mine))).upgrade).toBeUndefined();
    const fresh = thinBaselineDoc();
    expect(decodeStored(JSON.parse(JSON.stringify(fresh))).upgrade).toBeUndefined();
    expect(decodeStored(JSON.parse(ACCOUNT_R6_RAW), { upgrade: "none" }).upgrade).toBeUndefined();
  });
});

describe("期限・開始・種類・プロジェクト・シナリオの書き換えも引き継ぐ（loss-3）", () => {
  it("鍵の同じカード・読み替えた手は直した値のまま。それだけを直した、無くなったカードは「前の版で決めたこと」に残す。知らせの数にも入る", () => {
    setThinBaseline(page);
    const pa = pageMapAccess(null)!;
    const store = new Store(buildR6Future().pv.doc);
    const cards = Object.values(store.doc.nodes).filter((n) => keyOf(n) !== null && n.meta.forecastRoot !== true);
    const kept = cards.filter((n) => pa.keyIndex.has(keyOf(n)!));
    const moved = cards.filter((n) => !pa.keyIndex.has(keyOf(n)!) && movedIndex(pa, keyOf(n)!, n) > 0);
    const vanished = cards.filter((n) => !pa.keyIndex.has(keyOf(n)!) && movedIndex(pa, keyOf(n)!, n) < 0);
    const k1 = kept[1]!; // 選んだ手・期限・種類・自分のプロジェクト
    const k2 = kept[2]!; // 期限だけ
    const m1 = moved[0]!; // 選んだ手・開始・種類
    const v1 = vanished[5]!; // 期限だけ
    const v2 = vanished[9]!; // 種類だけ
    const v3 = vanished[13]!; // 自分のプロジェクトだけ
    const v4 = vanished[17]!; // シナリオだけ
    const proj = makeProject({ name: "家計の見直し" });
    const scen = store.doc.scenarioOrder[0]!;
    store.transact("edits", (tx) => {
      tx.addProject(proj);
      tx.updateNode(k1.id, { status: "active", time: { ...k1.time, due: "2027-06-30" }, type: "goal", projectIds: [...k1.projectIds, proj.id] });
      tx.updateNode(k2.id, { time: { ...k2.time, due: "2027-01-15" } });
      tx.updateNode(m1.id, { status: "active", time: { ...m1.time, start: "2027-04-10" }, type: "goal" });
      tx.updateNode(v1.id, { time: { ...v1.time, due: "2028-04-30" } });
      tx.updateNode(v2.id, { type: v2.type === "result" ? "goal" : "result" });
      tx.updateNode(v3.id, { projectIds: [...v3.projectIds, proj.id] });
      tx.updateNode(v4.id, { scenarioIds: [scen] });
    });
    const before = structuredClone(store.doc) as DocData;
    const d = decodeStored(JSON.parse(JSON.stringify(before)));
    const doc = d.doc;
    expect(doc.nodes[k1.id]).toMatchObject({ status: "active", type: "goal", time: { due: "2027-06-30" } });
    expect(doc.nodes[k1.id]!.projectIds).toContain(proj.id);
    // 同じ鍵のページの地図のカードの組（領域）はそのまま、足したプロジェクトを足す
    const v7 = thinBaselineDoc({ at: "2026-11-19T03:04:05.006Z" });
    const k1v7 = Object.values(v7.nodes).find((n) => keyOf(n) === keyOf(k1))!;
    for (const p of k1v7.projectIds) if (Object.hasOwn(before.projects, p)) expect(doc.nodes[k1.id]!.projectIds).toContain(p);
    expect(doc.nodes[k2.id]!.time.due).toBe("2027-01-15");
    // 手を入れていない値（開始）は新しい地図の物
    expect(doc.nodes[k2.id]!.time.start).toBe(Object.values(v7.nodes).find((n) => keyOf(n) === keyOf(k2))!.time.start);
    expect(doc.nodes[m1.id]).toMatchObject({ status: "active", type: "goal", time: { start: "2027-04-10" } });
    for (const v of [v1, v2, v3, v4]) {
      const n = doc.nodes[v.id]!;
      expect(n, keyOf(v)!).toBeDefined();
      expect(n.meta.prevKey).toBe(keyOf(v));
    }
    expect(doc.nodes[v1.id]!.time.due).toBe("2028-04-30");
    expect(doc.nodes[v2.id]!.type).toBe(v2.type === "result" ? "goal" : "result");
    expect(doc.nodes[v3.id]!.projectIds).toContain(proj.id);
    expect(doc.nodes[v4.id]!.scenarioIds).toEqual([scen]);
    const L = d.upgrade!.legacy!;
    expect(L.detached.cards).toBe(4);
    expect(L.detached.edits).toBe(4);
    const text = upgradeNotice(d.upgrade!, "boot");
    expect(text).toContain("書き換えたカード 4 件");
    // 薄い形で書いて読み直しても同じ（直した値は書き換えとして残る）
    const back = decodeStored(JSON.parse(JSON.stringify(toStored(doc)))).doc;
    expect(back.nodes[k1.id]!.time.due).toBe("2027-06-30");
    expect(back.nodes[v1.id]!.time.due).toBe("2028-04-30");
  });

  it("関係を変えた地図の線: 残るカードの線は新しい地図の関係に戻して数を言い、無くなるカードは関係を prevEdge に残す（loss-6）", () => {
    setThinBaseline(page);
    const pa = pageMapAccess(null)!;
    const store = new Store(buildR6Future().pv.doc);
    const cards = Object.values(store.doc.nodes).filter((n) => keyOf(n) !== null && n.meta.forecastRoot !== true);
    const keptCard = cards.find((n) => keyOf(n) === "r.keep")!;
    const gone = cards.filter((n) => !pa.keyIndex.has(keyOf(n)!) && movedIndex(pa, keyOf(n)!, n) < 0)[3]!;
    const into = (id: string) => Object.values(store.doc.edges).find((e) => e.target === id && typeof e.meta.c0 === "string")!;
    store.transact("関係", (tx) => {
      tx.updateEdge(into(keptCard.id).id, { relation: "supports" });
      tx.updateEdge(into(gone.id).id, { relation: "blocks" });
    });
    const d = decodeStored(JSON.parse(JSON.stringify(store.doc)));
    expect(d.upgrade!.legacy!.relations).toBe(1);
    expect(upgradeNotice(d.upgrade!, "boot")).toContain("関係を変えた地図の線 1 本は、新しい地図の関係に戻しました");
    const left = d.doc.nodes[gone.id]!;
    expect(left.meta.prevKey).toBe(keyOf(gone));
    expect(left.meta.prevEdge).toMatchObject({ relation: "blocks" });
  });

  it("手を入れていない版 6 の地図では、どのカードも直したと見なさない（どの時差で読み込んだ地図でも）", () => {
    setThinBaseline(page);
    for (const day of [new Date(2026, 10, 12, 9), new Date(2026, 0, 31, 23, 30), new Date(2028, 1, 29, 1)]) {
      const fresh = buildR6Future(day).pv.doc;
      const d = decodeStored(JSON.parse(JSON.stringify(fresh)));
      expect(d.upgrade!.legacy!.detached.cards, String(day)).toBe(0);
      expect(d.upgrade!.applied, String(day)).toBe(0);
    }
  });
});

describe("知らせと確認の文（user-6）: 移した数・残した数をそのまま", () => {
  it("起動の知らせ: 3 か月後の手は何年何月の同じ手へ移し、無いカードは別のカードとして残したと、数で言う（「そのまま残ります」と言わない）", () => {
    const { info } = upgraded();
    const L = info.legacy!;
    const text = upgradeNotice(info, "boot");
    expect(text).toContain("地図を、3 か月ごとの新しい地図（版 7）で開きました。");
    expect(L.movedAt).toBe("2027 年 2 月");
    expect(text).toContain("は 2027 年 2 月の同じ手へ移しました");
    expect(text).toContain(`は、別のカードとして「前の版で決めたこと」（今日の左）に残しました`);
    if (L.detached.picks) expect(text).toContain(`選んだ手 ${L.detached.picks} 件`);
    if (L.detached.drops) expect(text).toContain(`見送った手 ${L.detached.drops} 件`);
    // 当て直す前の記録は、そのままの形でダウンロードできる（loss-6）
    expect(text).toContain("前の内容は、そのままの形でバックアップに残しています（メニュー →「バックアップと復元」からダウンロードできます）。");
    expect(text).not.toContain("そのまま残ります");
    // 数の合計は、移した・引き継いだ・残したカードの数
    const nums = [...text.matchAll(/(\d+) 件/g)].map((m) => Number(m[1]));
    expect(nums.reduce((a, b) => a + b, 0)).toBe(L.kept.cards + L.moved.cards + L.detached.cards);
    // 取り込み・バックアップ・確認は、これからすること（「移します」「残します」）
    expect(upgradeNotice(info, "import")).toContain("（ファイルは版 6 の地図）");
    expect(upgradeNotice(info, "import")).toContain("同じ手へ移します");
    expect(upgradeNotice(info, "backup")).toContain("このバックアップの地図は前の版（版 6）の物です");
    expect(upgradeNotice(info, "confirm")).toContain("に残します");
    expect(upgradeNotice(info, "swap")).toContain("にしました");
    expect(upgradeNotice(info, "adopt")).toContain("アカウントの内容は前の版の地図だったため、3 か月ごとの新しい地図（版 7）にして読み込みました。");
    expect(upgradeNotice(info, "adopt")).toContain("同じ手へ移しました");
  });
});

// ------------------------------------------------------------ 保存の道

let dbSeq = 0;
function makeP(kv = memoryKV(), name = `legacy-${++dbSeq}`): Persistence {
  return new Persistence({ dbName: name, kv, locks: null, channel: false, debounceMs: 1 });
}

describe("保存先・取り込み・バックアップ: どの道でも同じ引き上げ。次に保存すると薄い形", () => {
  it("起動: 版 6 の本体を引き上げて開き（id・更新時刻はそのまま・記録は安全用バックアップに・知らせ）、保存すると薄い形（版の記録に docVersion 2）。開き直すとそのまま読む", async () => {
    const name = `legacy-boot-${++dbSeq}`;
    const kv = memoryKV();
    // 版 6 のページが書いた本体（版 1・地図ごと）
    const p0 = makeP(kv, name);
    await p0.open();
    p0.close();
    await rawPut(name, "kv", JSON.parse(ACCOUNT_R6_RAW), "doc");
    await rawPut(name, "kv", { rev: 3, savedAt: "2026-11-15T00:00:00.000Z", writer: "old", docVersion: 1 }, "meta");
    // このページ: 地図は要るときに読む（版 6 の地図の今日がある本体なので読む）
    let loads = 0;
    enableThinPage(async () => {
      loads++;
      return page;
    });
    expect(needsPageMap(JSON.parse(ACCOUNT_R6_RAW))).toBe(true);
    const p = makeP(kv, name);
    await p.open();
    await p.acquireWriter();
    const loaded = await p.loadInitial();
    expect(loads).toBe(1);
    expect(loaded.blocked).toBe(false);
    const input = accountR6Doc();
    expect([loaded.doc!.id, loaded.doc!.updatedAt]).toEqual([input.id, input.updatedAt]);
    expect(loaded.upgrade?.legacy).toBeDefined();
    expect(loaded.notices.join("")).toContain("地図を、3 か月ごとの新しい地図（版 7）で開きました。");
    checkUpgrade(input, loaded.doc!, page);
    // 引き上げる前の記録は、そのまま安全用バックアップに
    const metas = (await rawAll(name, "backupMeta")) as Array<{ kind: string; id: string; docVersion?: number }>;
    const safety = metas.filter((b) => b.kind === "safety");
    expect(safety.length).toBe(1);
    const raw = (await rawGet(name, "backupData", safety[0]!.id)) as { doc: unknown };
    expect(JSON.parse(typeof raw.doc === "string" ? raw.doc : JSON.stringify(raw.doc))).toEqual(JSON.parse(ACCOUNT_R6_RAW));
    // 保存すると薄い形
    p.attach(() => loaded.doc!);
    await p.flush();
    const rec = (await rawGet(name, "kv", "doc")) as StoredDoc;
    expect(rec.version).toBe(THIN_VERSION);
    expect(rec.maps![0]!.release).toBe(7);
    expect(JSON.stringify(rec).length).toBeLessThan(40_000);
    expect((await rawGet(name, "kv", "meta")) as object).toMatchObject({ docVersion: THIN_VERSION, mapRelease: 7 });
    p.close();
    // 開き直す: 薄い形をそのまま読む（もう引き上げない・知らせない）
    const q = makeP(kv, name);
    await q.open();
    await q.acquireWriter();
    const again = await q.loadInitial();
    expect(again.upgrade).toBeUndefined();
    expect(JSON.stringify(again.doc)).toBe(JSON.stringify(loaded.doc));
    q.close();
  });

  it("書き出したファイル（版 6）の取り込み・版 6 のバックアップの復元も同じ引き上げ（数は警告と確認に）", async () => {
    setThinBaseline(page);
    const viaDecode = decodeStored(JSON.parse(ACCOUNT_R6_RAW));
    // 取り込み（ファイルの文字のまま）
    const pv = await previewImportAsync(ACCOUNT_R6_RAW);
    expect(pv.upgrade).toEqual(viaDecode.upgrade);
    expect(JSON.stringify(pv.doc)).toBe(JSON.stringify(viaDecode.doc));
    expect(pv.report.warnings[0]).toBe(upgradeNotice(pv.upgrade!, "import"));
    // 引き上げた文書の書き出しは薄い形で、そのまま取り込める（もう引き上げない）
    const text = exportText(pv.doc, "test");
    expect(text.length).toBeLessThan(60_000);
    const back = await previewImportAsync(text);
    expect(back.upgrade).toBeUndefined();
    // バックアップ（版 6 のページが作った、地図ごとの物）
    const p = makeP();
    await p.open();
    await p.acquireWriter();
    await p.loadInitial();
    const meta = await p.createBackup("manual", "版 6 のときのバックアップ", accountR6Doc());
    const r = await p.readBackupChecked(meta!.id);
    expect(r.upgrade).toEqual(viaDecode.upgrade);
    expect(JSON.stringify(r.doc)).toBe(JSON.stringify(viaDecode.doc));
    p.close();
  });
});

// ------------------------------------------------------------ アカウント

/** db の代わり（読み書き・見張り・貸し出し） */
function memoryBackend() {
  const docs = new Map<string, Record<string, unknown>>();
  const watchers = new Map<string, Set<(d: CloudDoc) => void>>();
  const leases = new Map<string, { holder: string; until: number }>();
  const snap = (path: string): CloudDoc => {
    const d = docs.get(path);
    return d ? { exists: true, data: structuredClone(d) } : { exists: false };
  };
  const be: CloudBackend = {
    async get(path) {
      return snap(path);
    },
    async set(path, data) {
      docs.set(path, structuredClone(data));
      for (const fn of watchers.get(path) ?? []) queueMicrotask(() => fn(snap(path)));
    },
    async delete(path) {
      docs.delete(path);
    },
    watch(path, next) {
      let set = watchers.get(path);
      if (!set) watchers.set(path, (set = new Set()));
      set.add(next);
      queueMicrotask(() => next(snap(path)));
      return () => set!.delete(next);
    },
    async lease(path, holder, ttlMs) {
      const cur = leases.get(path);
      if (cur && cur.holder !== holder && cur.until > Date.now()) return false;
      leases.set(path, { holder, until: Date.now() + ttlMs });
      return true;
    },
    async list(path) {
      return [...docs.keys()].filter((k) => k.startsWith(`${path}/`) && !k.slice(path.length + 1).includes("/")).map((k) => ({ id: k.slice(path.length + 1), data: structuredClone(docs.get(k)) }));
    },
  };
  return { be, docs };
}

/** 前の版のページ（v32・v33）の写しの読み書き: 文書をそのまま（版 1）書き、版 2 は新しい版 */
const legacyCodec: CloudCodec = {
  encode: (doc) => ({ stored: doc, docVersion: doc.version }),
  decode: async (raw) => normalizeDoc(raw).doc,
  isNewer: (v) => typeof v === "number" && Number.isFinite(v) && Math.floor(v) > 1,
};

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** 1 つの端末（本物の Store・このページか前の版のページの読み書き）。boot は起動したときの手元の記録 */
function device(be: CloudBackend, name: string, doc: DocData, opts: { codec?: CloudCodec; base?: SyncBase | null; boot?: BootDoc | null; release?: "remote" | "local" | "later" } = {}) {
  const store = new Store(doc);
  const local = { base: opts.base ?? null, backups: [] as Array<{ doc: DocData; label: string; kind: string }>, asked: 0, adopted: [] as string[] };
  const repo = new CloudRepo(be, "user1", name, undefined, opts.codec);
  const sync = new CloudSync(
    repo,
    {
      getDoc: () => store.doc,
      bootDoc: async () => opts.boot ?? null,
      isWriter: () => true,
      isDisposable: (d) => isDisposableDoc(d),
      isEditing: () => false,
      isForeign: () => false,
      adopt: async (d, how, stillOk) => {
        if (!stillOk()) return null;
        if (how === "remote") store.replaceDoc(d, "別の端末の内容を読み込む");
        else store.load(d, "load");
        local.adopted.push(how);
        return { id: store.doc.id, updatedAt: store.doc.updatedAt };
      },
      backup: async (d, label, kind) => {
        local.backups.push({ doc: d, label, kind });
        return true;
      },
      confirmWithoutBackup: async () => false,
      chooseFirst: async () => "later",
      chooseAcrossRelease: async () => {
        local.asked++;
        return opts.release ?? "later";
      },
      readBase: async () => local.base,
      writeBase: async (b) => {
        local.base = b;
      },
      notice: () => undefined,
    },
    { debounceMs: 5, leaseMs: 20, retryMs: 10, resubscribeMs: 30 },
  );
  store.on("change", (info) => {
    if (info.source === "tx" || info.source === "undo" || info.source === "redo") sync.markDirty();
  });
  const edit = (title: string) => store.transact("add", (tx) => void tx.addNode(makeNode({ title })));
  const has = (d: DocData, title: string) => Object.values(d.nodes).some((n) => n.title === title);
  return { store, local, repo, sync, edit, has };
}

async function settled(sync: CloudSync, ms = 3000): Promise<void> {
  const t0 = Date.now();
  await tick(20);
  while (Date.now() - t0 < ms && (sync.state === "syncing" || sync.state === "pending" || sync.state === "connecting")) await tick(20);
}

describe("アカウント: 引き上げは読むときだけ（アカウントには書かない: safety-13）。前の版の上の編集は聞いてから（safety-2）", () => {
  it("前の版のページが送った版 6 の写しを、このページは引き上げて読む。同じ id と更新時刻なので送らない（アカウントは版 6 の写しのまま）", async () => {
    setThinBaseline(page);
    const { be } = memoryBackend();
    const old = device(be, "old", accountR6Doc(), { codec: legacyCodec });
    await old.sync.start();
    await settled(old.sync);
    const g1 = (await old.repo.readManifest())!;
    expect(g1.docVersion).toBe(1);
    old.sync.stop();
    // 新しいページの端末（同じ文書を、保存先から引き上げて読んだ物。基準は g1）
    const mine = decodeStored(JSON.parse(ACCOUNT_R6_RAW)).doc;
    const nw = device(be, "new", mine, { base: { gen: g1.gen, docId: mine.id, docUpdatedAt: mine.updatedAt } });
    await nw.sync.start();
    await settled(nw.sync);
    expect(nw.sync.state).toBe("synced");
    expect((await nw.repo.readManifest())!.gen).toBe(g1.gen);
    // 写しを読むと引き上げた文書（保存してあった形は版 6。読み込んだときの知らせの数もある）
    const remote = (await new CloudRepo(be, "user1", "x").read())!;
    expect(storedMapReleaseOf(remote.doc)).toBe(6);
    expect(storedUpgradeOf(remote.doc)?.legacy?.detached.cards).toBeGreaterThan(0);
    expect(JSON.stringify(remote.doc)).toBe(JSON.stringify(mine));
    // 新しいページで編集すると、薄い形で送る（docVersion 2）
    nw.edit("新しいページで足したカード");
    await settled(nw.sync);
    expect((await nw.repo.readManifest())!.docVersion).toBe(THIN_VERSION);
    nw.sync.stop();
  });

  /**
   * 前の版のページの端末 OLD（版 6・止める前に編集して送っていない）と、新しいページの端末 NEW（引き上げて読み、編集して送った）。
   * OLD を新しいページで開き直すと、手元は起動で引き上げた文書（版 7 の地図）だが、まだ送っていない編集は版 6 の地図の上の物
   * （起動したときの記録に、保存してあった形の版 6）。アカウントの写し（版 7 の地図の上の編集）と重なれば、黙って手元で上書きせずに聞く
   */
  async function reopened(release: "remote" | "local" | "later", withRecord = true) {
    setThinBaseline(page);
    const { be } = memoryBackend();
    const old = device(be, "old", accountR6Doc(), { codec: legacyCodec });
    await old.sync.start();
    await settled(old.sync);
    const base = old.local.base!;
    // NEW: 同じ写しを読んで（引き上げて）合わせ、編集して送る
    const nw = device(be, "new", createEmptyDoc());
    await nw.sync.start();
    await settled(nw.sync);
    expect(nw.local.base!.gen).toBe(base.gen);
    expect(holdsPageMap(nw.store.doc)).toBe(true);
    nw.edit("新しいページで足したカード");
    await settled(nw.sync);
    expect((await nw.repo.readManifest())!.docVersion).toBe(THIN_VERSION);
    // OLD: 止める前の編集（送る前に、新しい版の写しに気づいて止まる）
    old.edit("前の版のページで止める前に書いたカード");
    await settled(old.sync);
    const leftover = old.store.doc;
    old.sync.stop();
    // OLD を新しいページで開き直す: 保存先の版 6 の本体を、起動で引き上げて読む
    const local = decodeStored(JSON.parse(JSON.stringify(leftover))).doc;
    expect(mapReleaseOf(local)).toBe(7);
    const boot: BootDoc = { id: local.id, updatedAt: local.updatedAt, fallback: false, on: { gen: base.gen, docId: base.docId, docUpdatedAt: base.docUpdatedAt }, mapRelease: storedMapReleaseOf(local) ?? mapReleaseOf(local) };
    expect(boot.mapRelease).toBe(6);
    const re = device(be, "old2", local, { base, boot: withRecord ? boot : null, release });
    await re.sync.start();
    await settled(re.sync);
    const acct = (await new CloudRepo(be, "user1", "check").read())!;
    nw.sync.stop();
    re.sync.stop();
    return { nw, re, acct };
  }

  it("黙って手元で上書きしない: 聞いて「あとで決める」なら止めて待つ（アカウントは新しいページの内容のまま・手元の編集も残る）", async () => {
    const { re, acct } = await reopened("later");
    expect(re.local.asked).toBe(1);
    expect(re.sync.state).toBe("paused");
    expect(re.has(acct.doc, "新しいページで足したカード")).toBe(true);
    expect(re.has(acct.doc, "前の版のページで止める前に書いたカード")).toBe(false);
    expect(re.has(re.store.doc, "前の版のページで止める前に書いたカード")).toBe(true);
  });

  it("「このブラウザの内容を使う」なら、引き上げた手元（版 7 の地図・薄い形）を送り、アカウントの内容はバックアップに", async () => {
    const { re, acct } = await reopened("local");
    expect(re.local.asked).toBe(1);
    expect(re.has(acct.doc, "前の版のページで止める前に書いたカード")).toBe(true);
    expect(holdsPageMap(acct.doc)).toBe(true);
    const kept = re.local.backups.find((b) => b.kind === "kept")!;
    expect(re.has(kept.doc, "新しいページで足したカード")).toBe(true);
  });

  it("起動したときの記録が無くても（閲覧のみで起動して引き継いだ・前の版のページが消した）聞く: 基準の地図の版と、読んだ手元の保存してあった形の版で分かる（loss-2・skew-1）", async () => {
    const { re, acct } = await reopened("later", false);
    expect(re.local.asked).toBe(1);
    expect(re.has(acct.doc, "新しいページで足したカード")).toBe(true);
    expect(re.has(acct.doc, "前の版のページで止める前に書いたカード")).toBe(false);
  });
});

// ------------------------------------------------------------ 既定のビルド

describe("既定のビルド（ページに地図が無い）は何も変わらない", () => {
  it("版 6 の文書はそのまま読む（引き上げない・地図を読まない）。概要（3 年の影響）と順位も今までどおり出る", () => {
    expect(needsPageMap(JSON.parse(ACCOUNT_R6_RAW))).toBe(false);
    const d = decodeStored(JSON.parse(ACCOUNT_R6_RAW));
    expect(d.upgrade).toBeUndefined();
    const input = accountR6Doc();
    expect(d.doc).toEqual(input);
    expect(storedMapReleaseOf(d.doc)).toBeUndefined();
    // 書く形も今までどおり（版 1・地図ごと）
    expect(toStored(d.doc)).toBe(d.doc);
    // 概要と順位（右の概要の「3 年でやる価値が大きい手」「避けたい手」「この先の大事な判断」）
    const overview = (doc: DocData) => {
      const idx = buildIndex(doc);
      const fc = computeForecast(doc, idx.out);
      const im = computeImpact(doc, idx.out, fc, null);
      return { im, fc, rank: worthRanking(doc, im, fc), key: keyDecisions(im) };
    };
    const a = overview(d.doc);
    expect(a.im.active).toBe(true);
    expect(a.im.annual).toBe(480);
    expect(a.im.ends.length).toBeGreaterThan(0);
    expect(a.rank.worth.length).toBeGreaterThan(3);
    expect(a.rank.avoid.length).toBeGreaterThan(0);
    expect(a.key.length).toBeGreaterThan(0);
    // 読む口を通さずに整えた物と同じ数（順位・大事な判断・行き先）
    const b = overview(input);
    expect(JSON.stringify(a.rank)).toBe(JSON.stringify(b.rank));
    expect(JSON.stringify(a.key)).toBe(JSON.stringify(b.key));
    expect(a.im.ends.map((e) => e.id)).toEqual(b.im.ends.map((e) => e.id));
  });

  it("ページの地図を読み込めないページ（読み込み方はあるが読めない）: 版 6 の地図のまま読む（止めない・壊れたと見なさない）", async () => {
    enableThinPage(async () => null);
    const d = await (await import("../../src/persist/codec")).decodeStoredAsync(JSON.parse(ACCOUNT_R6_RAW));
    expect(d.upgrade).toBeUndefined();
    expect(d.doc).toEqual(accountR6Doc());
  });
});
