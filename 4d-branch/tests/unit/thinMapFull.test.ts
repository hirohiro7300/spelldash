// 8 万枚の木（3 か月ごとの地図の本番の形）の薄い形の保存（src/persist/thinMap.ts・codec.ts。作業メモ SPEC v1 §6・§7.2、R0 §10.2 I9・§10.3）:
//   書いて読むと同じ文書（新しい地図・ふつうの利用者・アカウントの形と多い編集）・大きさ（新しい地図 ≤ 8 KB・ふつうの利用者 ≤ 64 KB・
//   緊急コピー ≤ 100 万文字）・時間（書く ≤ 50 ms・読む ≤ 150 ms。どちらも先に 2 回動かしてから 3 回のうち一番良い値。CI の機械は 2 倍まで）・
//   基準の文書の指紋（知っている候補の版なら、版の記録の値と同じ）。
// 動くのは、遅いテスト（npm run test:slow。ページに入れた版 7 の地図）か、
// IMPACT_Q_FULL=<impact-q.b64 のある場所> のときだけ（npm run test:slow もこれを動かす）。ふだんのテストは小さい木（thinMap.test.ts）
import { beforeAll, describe, expect, it } from "vitest";
import type { MapData } from "../../src/deepmap/mapData";
import { decodeBundle } from "../../src/demo/impactBundle";
import { buildQuarterDoc } from "../../src/demo/quarterDoc";
import { loadPageMap, PAGE_Q } from "../../src/demo/pageBundle";
import { makeEdge, makeNode } from "../../src/model/schema";
import type { DocData } from "../../src/model/types";
import { encodeStored, fromStored, setThinBaseline, thinBaseline, thinBaselineDoc, toStored } from "../../src/persist/codec";
import { Store } from "../../src/store/store";
import { envVar, nodeFs } from "./helpers/qSmall";
import { checkRoundTrip } from "./helpers/thinCheck";
import { accountShape, EDIT_KINDS, randomEdits, seeded } from "./helpers/thinEdits";

const DIR = envVar("IMPACT_Q_FULL");
// ページの地図は P2 から既定で入るので、遅いテスト（npm run test:slow: DEEPMAP_SLOW=1）か IMPACT_Q_FULL のときだけ動かす
const RUN = (PAGE_Q && envVar("DEEPMAP_SLOW") === "1") || !!DIR;
const SLOW = 600_000;
const CI = !!envVar("CI");
/** 時間の目標（ms。SPEC §7.2 の autosave encode と R0 §10.3）。CI の機械は遅いので 2 倍まで（測った値はいつも書き出す） */
const ENCODE_MS = CI ? 100 : 50;
const DECODE_MS = CI ? 300 : 150;
/** 知っている候補の基準の文書の指紋（4DQD2。作業メモ reports/p2found.md §3.2） */
const KNOWN_DIGEST: Record<string, string> = { "0kzsauw0e8g9p0": "04xlb9e078co7i", "0s8mqik1oagovc": "0lb58571lwmw4n" };
const AT = "2026-11-19T03:00:00.000Z";

/** 先に warm 回動かしてから、reps 回のうち一番良い時間（ms）と全部の時間 */
function bestOf<T>(fn: () => T, reps = 3, warm = 2): { best: number; all: number[]; out: T } {
  let out!: T;
  for (let i = 0; i < warm; i++) out = fn();
  const all: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    out = fn();
    all.push(performance.now() - t0);
  }
  return { best: Math.min(...all), all, out };
}
const ms = (xs: number[]): string => xs.map((x) => x.toFixed(1)).join(" / ");

/** ふつうの利用者（R0 §3.2 の typical）: 選ぶ 25・見送る 10・題名 8・本文 4・タグ 5・見込み 6・自分のカード 15・手を消す 2・年収。本物のストアを通す */
function typicalUser(doc: DocData, seed: number): DocData {
  const R = seeded(seed);
  const store = new Store(doc);
  const ids = Object.keys(store.doc.nodes);
  const alts = ids.filter((id) => typeof store.doc.nodes[id]!.meta.ak === "string");
  const probEdges = Object.keys(store.doc.edges).filter((id) => typeof store.doc.edges[id]!.meta.prob === "number");
  const pick = <T>(a: readonly T[]): T => a[Math.floor(R() * a.length)]!;
  for (let i = 0; i < 25; i++) store.transact("選ぶ", (tx) => void tx.updateNode(pick(alts), { status: "active" }));
  for (let i = 0; i < 10; i++) store.transact("見送る", (tx) => void tx.updateNode(pick(alts), { status: "dropped" }));
  for (let i = 0; i < 8; i++) {
    const id = pick(ids);
    const n = store.doc.nodes[id];
    if (n) store.transact("題名", (tx) => void tx.updateNode(id, { title: `${n.title}（自分で直した）` }));
  }
  for (let i = 0; i < 4; i++) {
    const id = pick(ids);
    const n = store.doc.nodes[id];
    if (n) store.transact("本文", (tx) => void tx.updateNode(id, { body: `${n.body}\n自分のメモ: 2027 年 3 月に見直す。顧客 2 社・月 18 万円を下回ったら手を変える。` }));
  }
  for (let i = 0; i < 5; i++) {
    const id = pick(ids);
    const n = store.doc.nodes[id];
    if (n && !n.tags.includes("大事")) store.transact("タグ", (tx) => void tx.updateNode(id, { tags: [...n.tags, "大事"] }));
  }
  for (let i = 0; i < 6; i++) {
    const id = pick(probEdges);
    const e = store.doc.edges[id];
    if (e) store.transact("見込み", (tx) => void tx.updateEdge(id, { meta: { ...e.meta, prob: Math.max(1, (e.meta.prob as number) - 5) } }));
  }
  for (let i = 0; i < 15; i++) {
    const parent = pick(ids);
    if (!store.doc.nodes[parent]) continue;
    store.transact("自分のカード", (tx) => {
      const nn = makeNode({ type: "action", title: `自分のカード ${i}`, body: "会社の副業規定を総務に確認する。返事の期限は 12 月末。", x: 100 * i, y: 3000 });
      tx.addNode(nn);
      tx.addEdge(makeEdge({ source: parent, target: nn.id }));
    });
  }
  // 手を 2 つ消す（その先の地図のカードも。アプリの消し方と同じく、道の線でたどれる鍵のカード）
  for (let i = 0; i < 2; i++) {
    const id = pick(alts);
    if (!store.doc.nodes[id]) continue;
    const out = new Map<string, string[]>();
    for (const e of Object.values(store.doc.edges)) (out.get(e.source) ?? out.set(e.source, []).get(e.source)!).push(e.target);
    const sub = [id];
    for (let k = 0; k < sub.length; k++) for (const c of out.get(sub[k]!) ?? []) if (typeof store.doc.nodes[c]?.meta.key === "string" && !sub.includes(c)) sub.push(c);
    store.transact("消す", (tx) => sub.forEach((x) => tx.deleteNode(x)));
  }
  const root = ids.find((id) => store.doc.nodes[id]!.meta.forecastRoot === true)!;
  const r = store.doc.nodes[root]!;
  store.transact("年収", (tx) => void tx.updateNode(root, { meta: { ...r.meta, impact: { ...(r.meta.impact as object), annual: 420 } } }));
  return store.doc;
}

describe.skipIf(!RUN)("8 万枚の木の薄い形の保存（版 7 の候補をページに入れたとき・IMPACT_Q_FULL があるとき）", () => {
  let map: MapData;
  beforeAll(async () => {
    if (PAGE_Q) map = (await loadPageMap())!;
    else {
      const fs = await nodeFs();
      map = await decodeBundle(new TextDecoder().decode(fs.readFileSync(`${DIR}/impact-q.b64`)));
    }
    setThinBaseline(map);
  }, SLOW);

  it(
    "ページの地図と基準の文書の指紋（知っている候補なら版の記録と同じ値）",
    () => {
      expect(map.n).toBeGreaterThan(50_000);
      const rec = thinBaseline()!;
      expect(rec).toMatchObject({ release: map.header.release, hash: map.header.hash, anchor: map.header.anchor });
      if (KNOWN_DIGEST[map.header.hash]) expect(rec.digest).toBe(KNOWN_DIGEST[map.header.hash]);
      console.log(`ページの地図: ${map.n.toLocaleString()} 枚・版 ${rec.release}・中身の指紋 ${rec.hash}・基準の文書の指紋 ${rec.digest}`);
    },
    SLOW,
  );

  it(
    "新しい地図: 薄い形は 8 KB 以下。書いて読むと同じ文書",
    () => {
      const { json } = checkRoundTrip(thinBaselineDoc({ at: AT, dx: 872, dy: -420 }));
      console.log(`新しい地図: ${json.length.toLocaleString()} 文字`);
      expect(json.length).toBeLessThan(8_000);
    },
    SLOW,
  );

  it(
    "ふつうの利用者: 64 KB 以下・緊急コピー（同じ JSON）も 100 万文字以下・1 つの分割（18 万文字）に入る。書いて読むと同じ文書",
    () => {
      const doc = typicalUser(thinBaselineDoc({ at: AT }), 11);
      const { json } = checkRoundTrip(doc);
      console.log(`ふつうの利用者: ${json.length.toLocaleString()} 文字`, encodeStored(doc).stats);
      expect(json.length).toBeLessThan(64_000);
    },
    SLOW,
  );

  it(
    "アカウントの形（ID の振り直し・プロジェクトとシナリオの ID・ずれ・時刻）と、編集の種類ぜんぶ: 書いて読むと同じ文書",
    () => {
      const R = seeded(2026);
      const acct = accountShape(thinBaselineDoc({ at: AT }), R, { rate: 0.03, rootReId: true, project: "p_independence", scenario: "s_early", dx: 872, dy: -420, at: "2026-11-12T09:30:00.000Z" });
      const store = new Store(acct);
      randomEdits(store, R, 60, EDIT_KINDS.filter((k) => k !== "projDelete" && k !== "scenDelete"));
      const { json, sec } = checkRoundTrip(store.doc);
      console.log(`アカウントの形: ${json.length.toLocaleString()} 文字・ID の読み替え ${Object.keys(sec.nid ?? {}).length.toLocaleString()} 枚・線 ${Object.keys(sec.eid ?? {}).length.toLocaleString()} 本`);
    },
    SLOW,
  );

  it(
    `時間: 書く ≤ ${ENCODE_MS} ms・読む ≤ ${DECODE_MS} ms（先に 2 回動かしてから 3 回のうち一番良い値）`,
    () => {
      const stored = toStored(typicalUser(thinBaselineDoc({ at: AT, dx: 872, dy: -420 }), 12));
      const json = JSON.stringify(stored);
      // 読む（JSON から。保存先から読んだ形）
      const dec = bestOf(() => fromStored(JSON.parse(json)));
      // 書く（読み込んだ文書。ふだんの保存はこれ）
      const doc = dec.out;
      const enc = bestOf(() => toStored(doc));
      expect(JSON.stringify(enc.out)).toBe(json);
      // 1 つ編集した後（書き換えたカードは 1 枚ずつ比べ直す）
      const store = new Store(fromStored(JSON.parse(json)));
      const alt = Object.keys(store.doc.nodes).find((id) => typeof store.doc.nodes[id]!.meta.ak === "string")!;
      store.transact("選ぶ", (tx) => void tx.updateNode(alt, { status: "active" }));
      const enc1 = bestOf(() => toStored(store.doc));
      // 太い形で読み込んだ地図の初めの 1 回（基準の写しとは別の物を項目ごとに比べる。1 度だけの道）
      const fat: DocData = buildQuarterDoc(map, { version: map.header.hash, release: map.header.release, at: Date.parse(AT) });
      const t0 = performance.now();
      const r = encodeStored(fat);
      const fatMs = performance.now() - t0;
      expect(r.stats!.compared).toBe(r.stats!.cards);
      console.log(
        `時間（${map.n.toLocaleString()} 枚）: 読む ${dec.best.toFixed(1)} ms（${ms(dec.all)}）・書く ${enc.best.toFixed(1)} ms（${ms(enc.all)}）・` +
          `1 つ編集した後に書く ${enc1.best.toFixed(1)} ms（${ms(enc1.all)}）・太い形の初めの 1 回 ${fatMs.toFixed(1)} ms`,
      );
      expect(dec.best).toBeLessThanOrEqual(DECODE_MS);
      expect(enc.best).toBeLessThanOrEqual(ENCODE_MS);
      expect(enc1.best).toBeLessThanOrEqual(ENCODE_MS);
    },
    SLOW,
  );

  it(
    "読んだ文書のカードは基準の物（新しく作らない）。入れ物は読むたびに新しい",
    () => {
      const json = JSON.stringify(toStored(thinBaselineDoc({ at: AT })));
      const a = fromStored(JSON.parse(json));
      const b = fromStored(JSON.parse(json));
      expect(a.nodes).not.toBe(b.nodes);
      let shared = 0;
      for (const id of Object.keys(a.nodes)) if (a.nodes[id] === b.nodes[id]) shared++;
      expect(shared).toBe(map.n - 1);
    },
    SLOW,
  );
});
