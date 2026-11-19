// 3 か月ごとの地図の生成（scripts/impact/q）を小さい予算で: 決まった木（作り直しても同じ指紋）・木の形・アプリと同じ値・一貫性・前提の点検・開発用の木の形。
// 本物の世界（P2 の前提）で、最初の手を 2 つ（今のまま・届け出て副業の 1 社目を探す）、分かれ道 600 に絞る（粗い表を 1 回作るので数秒かかる）。
// 新しい出力（stage 3）: 手の q・まとめた行き先の mix と cont・「3 年やらない」見積もり・予算の使い道（同じ表を引き継いで ind_quit を分かれ道 2,000 で）。
// 生成 v2（作業メモ SPEC v1 §2.8）: 一貫性を年収 360・540 のどちらでも守る（540 の一番良い手も広げ、要らなければ戻す）・事実の小さい組を先に分ける・
// 題・短い名前・やることの焼き込みと文章の点検（scripts/impact/q/text.ts）。
// 点検はどれも、通る木だけでなく、1 か所壊した木で通らないこと（その点検の名前の文を返すこと）も確かめる（見直し code-1）。
// 決まった木の数（指紋・数・値）はインラインのスナップショット。前提や作り方を変えて数が変わったら、確かめてから
//   npx vitest run tests/unit/impactQGen.test.ts -u
// で書き直す（見直し code-5。作業メモの道具は要らない）。8 万枚の木（既定の形）はここでは作らない
import { describe, expect, it } from "vitest";
import worldJson from "../../scripts/impact/world.json";
import type { World } from "../../scripts/impact/sim";
import { bestOf, checkOutputs, checkTree, filingDominance, searchStats } from "../../scripts/impact/q/checks";
import { bundleHash, canonicalizeDevTree, encodeMap } from "../../scripts/impact/q/bundle";
import { checkStructure, compareMaps, consistencyOfMap } from "../../scripts/impact/q/check";
import { bakeText, checkBaked, devNodes, textGate, type ComposeFn } from "../../scripts/impact/q/text";
import type { TextCheckReport } from "../../scripts/impact/textChecks";
import { BANKS, composeCard } from "../../src/demo/compose";
import { decodeBundleBytes } from "../../src/demo/impactBundle";
import { OutcomeCache, Wsum, type Roll } from "../../scripts/impact/q/core";
import { toDevTree } from "../../scripts/impact/q/devTree";
import { consistencyOf, DEFAULTS, generate, R1_ALTS_BY, rollbackApp, type MoveStats, type Params, type QNode } from "../../scripts/impact/q/gen";
import { bandOf } from "../../scripts/impact/q/group";
import { CONT_EVENTS, improvementGains, likeValue, neverOf, neverValues, orderRuns, rootTable, spreadOf, starCounts, summaryOutputs, type NeverResult } from "../../scripts/impact/q/outputs";
import { runRateQ, setBook, simQ, toQ, type QSt } from "../../scripts/impact/q/sim";
import { quarterWorld } from "../../scripts/impact/q/world";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";
import type { DevTree, DevTreeNode } from "../../src/deepmap/mapData";

const w = quarterWorld(worldJson as unknown as World);
const S = w.annual / 12;
const P: Params = { ...DEFAULTS, B: 600, altsBy: [...R1_ALTS_BY] };
const ONLY = ["keep", "ad_permside"];
const { root, stats, gen, dp } = generate(w, P, ONLY);
// まとめた行き先の中身と標準の続き（入口 main.ts はこの後に続きの見積もりの形を放すが、ここでは確かめるために残す）
const so = summaryOutputs(w, root);
const vRoot = rollbackApp(root, S);
const con = consistencyOf(root);
const chk = checkTree(w, root);
const tree = toDevTree(w, root, { anchor: "2026-11", release: 0, hash: "test", textVersion: "dev" });
/** 状態の印の付いた深い場所を探すための、鍵からの結果ノード */
const qByKey = new Map<string, QNode>();
{
  const visit = (n: QNode) => {
    qByKey.set(n.key, n);
    for (const c of n.kids) visit(c);
  };
  visit(root);
}
/** 生成の木のノード（深さ優先） */
const qAll = [...qByKey.values()];

/** 深さ優先（親は子より前・兄弟は並べる順）に、親と一緒に */
function nodesOf(r: DevTreeNode): Array<{ n: DevTreeNode; parent: DevTreeNode | null; path: DevTreeNode[] }> {
  const out: Array<{ n: DevTreeNode; parent: DevTreeNode | null; path: DevTreeNode[] }> = [];
  const visit = (n: DevTreeNode, path: DevTreeNode[]) => {
    out.push({ n, parent: path.at(-1) ?? null, path });
    for (const c of n.kids ?? []) visit(c, [...path, n]);
  };
  visit(r, []);
  return out;
}
const all = nodesOf(tree.root);

/** 小数を 9 桁に丸める（スナップショットの値が足す順の違いの端数で揺れないように） */
const r9 = (x: number) => Math.round(x * 1e9) / 1e9;

/** 並び（深さ優先）の 1 行（鍵・役割・月・状態・稼ぎ・手・q・結果・幅・mix・cont・子の数） */
function fingerprint(r: DevTreeNode): string {
  const rows = nodesOf(r).map(({ n }) => {
    const s = n.st;
    return [n.k, n.r, n.m, s.j, s.pm, s.pro, s.mau, s.pu, s.seats, s.cl, s.fee, s.sal, s.cv, s.fl.join("+"), n.rr ?? null, n.kind ?? null, n.h ?? null, !!n.base, n.why ?? null, !!n.stub, n.q ?? null, n.id ?? null, n.p ?? null, n.lab ?? null, n.line ?? null, n.ln ?? null, n.e ?? null, n.rv ?? null, !!n.sum, n.band ?? null, n.mix ?? null, n.cont ?? null, (n.kids ?? []).length];
  });
  const json = JSON.stringify(rows);
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193) >>> 0;
  }
  return a.toString(36).padStart(7, "0") + b.toString(36).padStart(7, "0");
}

describe("3 か月ごとの地図の生成（小さい予算）", () => {
  it("決まった木: 作り直しても同じ鍵・並び・見込み・稼ぎ・状態・結果の名前と線・幅・q・mix・cont（数はスナップショット）", () => {
    // 分ける予算だけで目標の ±2% に入る（飽和しない）。事実の小さい組は予算に収まる手だけ分ける（下の「事実の小さい組は段 3 までで先に分ける」）
    for (const s of stats) expect(s.calib).toMatchObject({ target: 600, saturated: false, areaN: 0, reachMax: null, hit: true });
    const vSQ = rollbackApp(root, S, true);
    rollbackApp(root, S);
    const sc = starCounts(root, S, 10);
    // P2 の前提（作業メモ SPEC v1 §2.2・§2.3）と §2.4 の出力でこの形を作った時の値。前提や作り方を変えたら -u で書き直す（上の注意）
    expect({
      stats: stats.map((s) => [s.kind, s.forks, s.nodes, s.passes, r9(s.Bint)]),
      guards: gen.guards,
      vRoot: r9(vRoot),
      vSQ: r9(vSQ),
      counts: tree.header.counts,
      fingerprint: fingerprint(tree.root),
      bands: all.filter(({ n }) => n.band).length,
      rv: all.filter(({ n }) => n.rv).length,
      stars: [sc.all.tree, sc.all.q],
      rootQ: tree.root.kids!.map((a) => a.q!.map(r9)),
    }).toMatchInlineSnapshot(`
      {
        "bands": 1238,
        "counts": {
          "decisions": 973,
          "ends": 1912,
          "forks": 1205,
          "nodes": 5421,
          "options": 2536,
          "sumEnds": 1530,
        },
        "fingerprint": "0s46wyq1oiqk3l",
        "guards": 80,
        "rootQ": [
          [
            39.930903139,
            29.933160864,
            15.053974913,
          ],
          [
            40.244530496,
            20.237136384,
            9.67787199,
          ],
        ],
        "rv": 224,
        "stars": [
          58,
          26,
        ],
        "stats": [
          [
            "keep",
            595,
            2553,
            18,
            726,
          ],
          [
            "ad_permside",
            609,
            2867,
            5,
            405.688753517,
          ],
        ],
        "vRoot": 1247.931381419,
        "vSQ": 1124.175,
      }
    `);
  });

  it("木の形: 今日 → 手 → 3 か月後の状態 → … → 36 か月目の行き先。鍵は親の鍵から作り、重ならない", () => {
    const keys = new Set<string>();
    for (const { n, parent } of all) {
      expect(keys.has(n.k)).toBe(false);
      keys.add(n.k);
      const kids = n.kids ?? [];
      if (parent) expect(n.k.startsWith(`${parent.k}.`)).toBe(true);
      if (n.r === "r" || n.r === "s") {
        expect(kids.length).toBeGreaterThanOrEqual(2);
        expect(kids.every((c) => c.r === "a" && c.m === n.m)).toBe(true);
        // 今のままは 1 つだけで、並びの最後
        expect(kids.filter((c) => c.base).length).toBe(1);
        expect(kids.at(-1)!.kind).toBe("keep");
      }
      if (n.r === "a") {
        expect(kids.length).toBeGreaterThanOrEqual(1);
        expect(kids.reduce((x, c) => x + c.p!, 0)).toBe(100);
        expect(kids.every((c) => Number.isInteger(c.p) && c.p! > 0)).toBe(true);
        if (n.stub) expect(kids.every((c) => c.r === "e" && c.sum === true && c.m === 36)).toBe(true);
        else if (n.m === 33) expect(kids.every((c) => c.r === "e" && !c.sum && c.m === 36)).toBe(true);
        else expect(kids.every((c) => c.r === "s" && c.m === n.m + 3)).toBe(true);
        expect(n.stub && n.m === 33).toBeFalsy();
      }
      if (n.r === "e") {
        expect(kids.length).toBe(0);
        expect(n.m).toBe(36);
      }
    }
    expect(tree.root.kids!.map((a) => a.kind)).toEqual(["ad_permside", "keep"]);
  });

  it("どのカードにも決まった欄: 今日・状態・行き先の月の稼ぎ、結果の見込み・名前・線・稼ぎ、手の種類・週の時間", () => {
    const isR3 = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(x));
    for (const { n, parent } of all) {
      if (n.r === "a") {
        expect(n.kind).toBeTypeOf("string");
        expect(n.h).toBe(w.kinds[n.kind!]!.hours);
        expect(!!n.base).toBe(n.kind === "keep");
        expect(n.rr).toBeUndefined();
        expect(n.id).toBeUndefined();
        // q はまとめた手でない手にだけ（今日の手・広げた手・33 か月目の手）
        expect(isR3(n.q)).toBe(!n.stub);
        expect(n.mix ?? n.cont).toBeUndefined();
      } else {
        expect(isR3(n.rr)).toBe(true);
        expect(n.kind).toBeUndefined();
      }
      if (n.r === "s" || n.r === "e") {
        expect(isR3(n.e)).toBe(true);
        expect(n.id).toBeTypeOf("string");
        expect(n.lab).toBeTypeOf("string");
        expect(n.line).toBeTypeOf("string");
        expect(n.ln!.length).toBeGreaterThanOrEqual(4);
        // 判断の線はその手の 3 か月の終わりに測る（まとめた行き先も 36 か月目ではなく、その 3 か月の終わり）
        expect(n.ln![1]).toBe(parent!.m + 3);
      }
      // まとめた行き先でなければ、月の稼ぎはその状態から出した物（まとめた行き先は 36 か月目の見込み）
      if (!n.sum && n.r !== "a") expect(n.rr).toEqual(runRateQ(w, qByKey.get(n.k)!.st));
      // 顧客は整数の社数。社数の違う場合をまとめた状態だけが幅（まとめた分布の 10%〜90%。整数）を持つ
      // まとめた行き先だけが mix・cont を持つ
      if (n.r !== "a") expect([!!n.mix, !!n.cont]).toEqual([!!n.sum, !!n.sum]);
      if (n.r === "a") expect(n.band).toBeUndefined();
      else if (n.band) {
        const [lo, hi] = n.band.cl!;
        expect(Number.isInteger(lo) && Number.isInteger(hi) && lo <= hi).toBe(true);
        const d = qByKey.get(n.k)!.st.cb.map((c) => c.n[0] + c.n[1] + c.n[2]);
        expect(new Set(d).size).toBeGreaterThan(1);
        expect(lo).toBeGreaterThanOrEqual(Math.min(...d));
        expect(hi).toBeLessThanOrEqual(Math.max(...d));
      } else expect(Number.isInteger(n.st.cl)).toBe(true);
    }
    expect(all.filter(({ n }) => n.band).length).toBeGreaterThan(100);
  });

  it("手がある訳: 今日の決まった手には付けず、その後は 一番良い・今のまま・別の領域・避けたい のどれか", () => {
    for (const { n, parent } of all) {
      if (n.r !== "a") continue;
      if (parent!.r === "r") expect(n.why ?? null).toBe(n.kind === "keep" ? "keep" : null);
      else expect(["best", "keep", "area", "avoid"]).toContain(n.why);
      expect(n.why === "keep").toBe(n.kind === "keep");
    }
    for (const { n } of all) {
      if (n.r !== "s") continue;
      const bests = n.kids!.filter((a) => a.why === "best");
      expect(bests.length).toBeLessThanOrEqual(1);
      // 広げた手（まとめていない手）は一番良い手か、今のままか、540 万円の一番良い手（訳は別の領域。予算の使い道 2 で広げた別の領域の手は下の ind_quit で確かめる）
      for (const a of n.kids!) if (!a.stub && a.m < 33) expect(a.why === "best" || a.kind === "keep" || (a.why === "area" && qByKey.get(a.k)!.forS2 === true)).toBe(true);
    }
  });

  it("確かめるだけの事実（会社の答え）: 届け出の結果にだけ付き、会社の番号は転職・独立から戻るたびに増える", () => {
    let seen = 0;
    let later = 0;
    for (const { n, path } of all) {
      const reveals = (n.r === "s" || n.r === "e") && (n.ln![0] === "perm" || n.ln![0] === "permside");
      expect(!!n.rv).toBe(reveals);
      if (!n.rv) continue;
      seen++;
      // その手を選んだ判断までの道で数える（試作 bundleq.ts と同じ数え方を、入れ子の木の上で別に数える）
      const decisions = path.slice(0, -1).filter((x) => x.r === "r" || x.r === "s");
      let k = 0;
      for (let i = 1; i < decisions.length; i++) {
        const a = decisions[i - 1]!.st;
        const b = decisions[i]!.st;
        if ((b.fl.includes("switched") && !a.fl.includes("switched")) || (a.j === "i" && b.j !== "i")) k++;
      }
      if (k > 0) later++;
      expect(n.rv![0]).toBe(`pm:${k}`);
      expect(["a", "s", "n"]).toContain(n.rv![1]);
      if (!n.sum) expect(n.rv![1]).toBe(n.st.pm);
    }
    expect(seen).toBeGreaterThan(50);
    expect(later).toBeGreaterThan(0);
  });

  it("アプリと同じ値: 読むだけの地図（fromDevTree）で後ろから出した値が、生成の値と同じ（360 万円・540 万円）。並びは値の順", () => {
    const m = fromDevTree(tree);
    expect(m.n).toBe(tree.header.counts.nodes);
    for (const annual of [360, 540]) {
      const s = annual / 12;
      const W = (r: readonly number[]) => r[0]! * s + r[1]! + r[2]!;
      const V = new Float64Array(m.n);
      for (let i = m.n - 1; i >= 0; i--) {
        const role = m.role(i);
        if (role === "e") V[i] = W(m.rr(i)) * Math.max(0, 36 - m.month(i));
        else if (role === "a") {
          let v = 0;
          for (let k = 0; k < m.childCount(i); k++) {
            const c = m.child(i, k);
            v += (m.p(c) / 100) * (W(m.e(c)) + V[c]!);
          }
          V[i] = v;
        } else {
          let b = -Infinity;
          for (let k = 0; k < m.childCount(i); k++) b = Math.max(b, V[m.child(i, k)]!);
          V[i] = b;
        }
      }
      const vGen = rollbackApp(root, s);
      expect(Math.abs(V[0]! - vGen)).toBeLessThan(1e-9);
      const keepA = root.kids.find((a) => a.kind === "keep")!;
      for (let k = 0; k < m.childCount(0); k++) {
        const c = m.child(0, k);
        const a = root.kids.find((x) => x.kind === m.kind(c))!;
        expect(Math.abs(V[c]! - V[m.child(0, m.childCount(0) - 1)]! - (a.V - keepA.V))).toBeLessThan(1e-9);
      }
      if (annual !== 360) continue;
      // 並び（生成の年収）: 判断の手は値の大きい順（今のままは最後）、結果は（線の稼ぎ + その先の値）の大きい順
      for (let i = 0; i < m.n; i++) {
        const role = m.role(i);
        const ks = Array.from({ length: m.childCount(i) }, (_, k) => m.child(i, k));
        const val = role === "a" ? (c: number) => W(m.e(c)) + V[c]! : (c: number) => V[c]!;
        const ordered = role === "a" ? ks : ks.slice(0, -1);
        for (let k = 1; k < ordered.length; k++) expect(val(ordered[k - 1]!)).toBeGreaterThanOrEqual(val(ordered[k]!) - 1e-9);
      }
    }
    rollbackApp(root, S);
  });

  it("一貫性（R1 の報告 §6.4）: おすすめの道ではまとめた手が勝たず、おすすめの道はまとめた手に入らない（年収 360・540 のどちらでも。SPEC v1 §2.8）", () => {
    expect(con.decisions).toBeGreaterThan(300);
    expect(con.violations).toBe(0);
    expect(con.piIntoStub).toBe(0);
    // おすすめの道の印（onPi）はどちらかの年収のおすすめの道の判断。アプリの年収 360 のおすすめの道はそのうち
    expect(con.piDecisions).toBeLessThanOrEqual(con.decisions);
    expect(con.piDecisions).toBeGreaterThan(300);
    rollbackApp(root, 45);
    const c540 = consistencyOf(root);
    expect([c540.violations, c540.piIntoStub]).toEqual([0, 0]);
    expect(c540.piDecisions).toBeGreaterThan(300);
    rollbackApp(root, S);
    // 読むだけの地図（アプリと同じ選び方）でも
    const m = fromDevTree(tree);
    for (const annual of [360, 540]) expect(consistencyOfMap(m, annual).intoStub).toBe(0);
  });

  it("決まり 2 を 540 万円でも: 540 の一番良い手（q）が違う判断ではその手も広げ（見せる手に無ければ足す）、要らなければまとめた手に戻す", () => {
    let both = 0;
    let reverted = 0;
    let added = 0;
    rollbackApp(root, 45);
    for (const d of qAll) {
      if (d.role !== "s" || d.kids.length < 2) continue;
      const s2 = d.kids.filter((a) => a.forS2);
      if (!s2.length) continue;
      const best = d.kids.find((a) => a.why === "best") ?? d.kids.find((a) => a.kind === "keep")!;
      for (const a of s2) {
        expect(a).not.toBe(best);
        // 540 では見せた手のどれより q（まとめた手は値）が大きい（同じなら今のまま）。訳 best の手は 360 で一番
        for (const b of d.kids) if (b !== a) expect(likeValue(a, 45)).toBeGreaterThanOrEqual(likeValue(b, 45) - 1e-6);
        if (a.stub) reverted++;
        else both++;
      }
    }
    for (const a of qAll) if (a.addedS2) added++;
    expect(both).toBeGreaterThan(0);
    expect(reverted).toBeGreaterThan(0);
    expect(added).toBeGreaterThan(0);
    expect(both).toBe(stats.reduce((x, st) => x + st.s2Exp, 0));
    expect(added).toBe(stats.reduce((x, st) => x + st.s2Added, 0));
    // 戻した判断でも、どちらの年収でもアプリの選ぶ手は広げた手（まとめた手に入らない）
    for (const S2 of [S, 45]) {
      rollbackApp(root, S2);
      for (const d of qAll) if (d.role === "s" && d.kids.some((a) => a.forS2 && a.stub) && d.onPi) expect(bestOf(d).stub).toBe(false);
    }
    rollbackApp(root, S);
  });

  it("事実の小さい組は段 3 までで先に分ける: 届け出て副業の『全部可』で 1 社目が決まる 8% は今日の手の結果として残る（SPEC v1 §2.2）", () => {
    // 使うのは予算に収まる時だけ（この小さい予算では、今のままは幅 ±12 に入る予算が見つからず分けない。8 万枚の木では今日の手すべてで分ける）
    expect(stats.map((st) => [st.kind, st.calib.fine, st.calib.fineDropped])).toEqual([
      ["keep", false, true],
      ["ad_permside", true, false],
    ]);
    const a1 = qByKey.get("r.ad_permside.a1")!;
    // 名前の中に「・」を使わない（並びの中で 2 つの結果に読める。作業メモ reader-5）
    expect([a1.out!.p, a1.out!.lab, a1.out!.fine]).toEqual([8, "全部可（1 社目あり）", true]);
    expect(qByKey.get("r.ad_permside.a0")!.out!.p).toBe(12);
    expect(qByKey.has("r.ad_permside.a0_a1")).toBe(false);
    const fine = qAll.filter((n) => n.out?.fine);
    expect(fine.length).toBe(stats.reduce((x, st) => x + st.fineOuts, 0));
    for (const n of fine) {
      expect(n.parent!.stage).toBeLessThanOrEqual(P.fineDepth);
      expect(n.out!.p).toBeLessThanOrEqual(w.minOutcomeP);
    }
  });

  it("前提の点検（N10・N7・顧客は整数・幅・名前・事実・暦・転職活動の上限）に通り、一番ありそうな道で続けて決まらない転職活動は 2 期まで", () => {
    expect(chk.fails).toEqual([]);
    expect(chk.counts.n10).toBe(0);
    expect(chk.counts.mixed).toBeGreaterThan(0);
    expect(chk.search.map((s) => s.kind)).toEqual(ONLY);
    for (const s of chk.search) {
      expect(s.chainMaxFailRun).toBeLessThanOrEqual(w.q.searchRun);
      expect(s.chain.length).toBe(12);
      for (const p of [s.pSearch, s.pSwitched, s.pEverSwitched]) expect(p).toBeGreaterThanOrEqual(0);
      expect(s.pSwitched).toBeLessThanOrEqual(s.pEverSwitched + 1e-12);
      expect(s.meanSearch).toBeLessThanOrEqual(w.q.searchMax * 2);
    }
    // おすすめの道の転職活動は、どの道でも 1 つの会社で 4 期まで・続けて決まらないのは 2 期まで
    const walk = (a: (typeof root)["kids"][number], n: number, run: number, here: number) => {
      for (const c of a.kids) {
        const movedNow = c.st.fl.includes("switched") && !a.st.fl.includes("switched");
        const search = a.kind === "fc_switch" || a.kind === "fc_switch2";
        const r2 = search && !movedNow ? run + 1 : 0;
        const h2 = movedNow || (a.kind === "back_emp" && c.st.j === "e" && a.st.j === "i") ? 0 : here + (search ? 1 : 0);
        expect(r2).toBeLessThanOrEqual(w.q.searchRun);
        expect(h2).toBeLessThanOrEqual(w.q.searchMax);
        if (c.role === "s") for (const b of c.kids) if (!b.stub) walk(b, n + 1, r2, h2);
      }
    };
    for (const a0 of root.kids) walk(a0, 0, 0, 0);
  });

  it("開発用の木の入口: 版 0・地図の年月・数は木を数え直した物・手の種類に転職活動を続ける・前提は P2 の文", () => {
    const h = tree.header;
    expect([h.v, h.kind, h.anchor, h.horizon, h.annual, h.release, h.hash, h.textVersion]).toEqual([3, "impact3y", "2026-11", 36, 360, 0, "test", "dev"]);
    expect(h.premises).toEqual(w.premises);
    expect(h.premises.some((p) => p.includes("2026 年 11 月時点"))).toBe(true);
    const kids = (n: DevTreeNode) => (n.kids ?? []).length;
    expect(h.counts).toEqual({
      nodes: all.length,
      decisions: all.filter(({ n }) => (n.r === "r" || n.r === "s") && kids(n) >= 2).length,
      options: all.filter(({ n }) => n.r === "a").length,
      forks: all.filter(({ n }) => kids(n) >= 2).length,
      ends: all.filter(({ n }) => n.r === "e").length,
      sumEnds: all.filter(({ n }) => n.sum).length,
    });
    expect(h.kinds.fc_switch2).toEqual(["転職活動を続ける", "fc", "switch", ["s_balance"]]);
    expect(Object.keys(h.kinds).some((k) => k.startsWith("plan_"))).toBe(false);
    expect(h.never).toEqual({});
    expect(h.fams.switch).toBe("転職");
    // 小さい予算でも、続ける転職活動・まとめた手・避けたい手・独立が出てくる
    const kinds = new Set(all.filter(({ n }) => n.r === "a").map(({ n }) => n.kind));
    for (const k of ["fc_switch", "fc_switch2", "ind_quit", "sd_permpro", "ad_permside"]) expect(kinds.has(k)).toBe(true);
    expect(all.some(({ n }) => n.why === "avoid")).toBe(true);
  });
});

/** 1 か所だけ変えて試し、終わったら必ず戻す（同じ木をほかのテストも使うので） */
function mutate<T extends object, K extends keyof T>(o: T, key: K, v: T[K], fn: () => void): void {
  const had = Object.prototype.hasOwnProperty.call(o, key);
  const old = o[key];
  o[key] = v;
  try {
    fn();
  } finally {
    if (had) o[key] = old;
    else delete o[key];
  }
}
const codes = (xs: readonly string[]) => [...new Set(xs.map((x) => x.split(" ")[0]!))];

describe("点検は 1 か所壊すと通らない（見直し code-1: 書き出しを止める点検の、通らない場合）", () => {
  const decisions = qAll.filter((n) => n.role === "s" && !n.sumEnd);
  const tree0 = () => checkTree(w, root).fails;

  it("壊す前は通る", () => {
    rollbackApp(root, S);
    expect(tree0()).toEqual([]);
  });

  it("N10: Pro を出しているのに届け出の答えがまだ", () => {
    const n = decisions.find((x) => x.st.pm === "?" && x.st.j === "e" && x.st.pro === 0)!;
    mutate(n, "st", { ...n.st, pro: 1 }, () => expect(codes(tree0())).toEqual(["N10"]));
  });

  it("N7: 『SpellDash だけ可』なのに広告運用の顧客", () => {
    const n = decisions.find((x) => x.st.pm === "s" && x.st.j === "e" && x.st.cl === 0)!;
    mutate(n, "st", setBook(w, { ...n.st, fl: [...n.st.fl], cb: [] }, [{ n: [1, 0, 0], f5: 0, w: 1 }]), () => expect(codes(tree0())).toEqual(["N7"]));
  });

  it("C1: 1 つの社数の状態なのに社数が整数でない・幅のある状態の平均が社数の外", () => {
    const n = decisions.find((x) => x.st.cb.length === 1)!;
    mutate(n, "st", { ...n.st, cl: 1.5 }, () => expect(codes(tree0())).toEqual(["C1"]));
    const m = decisions.find((x) => x.st.cb.length > 1 && !x.out!.lab.includes("顧客"))!;
    mutate(m, "st", { ...m.st, cl: 99 }, () => expect(codes(tree0())).toEqual(["C1"]));
  });

  it("C2: 結果の名前の社数が状態と合わない（本物の名前の書き方は impactQSim で）", () => {
    const n = decisions.find((x) => x.out && x.out.st.cl < 5)!;
    mutate(n, "out", { ...n.out!, lab: "顧客 5 社" }, () => expect(codes(tree0())).toEqual(["C2"]));
  });

  it("F1: 違う事実（会社の答え）をまとめた結果", () => {
    const n = decisions.find((x) => x.out && (x.out.ln.metric === "perm" || x.out.ln.metric === "permside"))!;
    mutate(n, "out", { ...n.out!, id: "a_n" }, () => expect(codes(tree0())).toEqual(["F1"]));
  });

  it("J1: 転職活動の期の数が上限を超える。J3・J4: 移った後の会社・週 4 日で転職活動の手", () => {
    const n = decisions.find((x) => x.st.j === "e" && !x.st.fl.includes("q1"))!;
    mutate(n, "st", { ...n.st, fl: [...n.st.fl, "q5"].sort() }, () => expect(codes(tree0())).toEqual(["J1"]));
    const d = decisions.find((x) => x.st.j === "e" && x.kids.some((a) => a.kind === "fc_switch" || a.kind === "fc_switch2"))!;
    mutate(d, "st", { ...d.st, fl: [...d.st.fl, "switched"].sort() }, () => expect(codes(tree0())).toEqual(["J3"]));
    mutate(d, "st", { ...d.st, j: "p" }, () => expect(codes(tree0())).toContain("J4"));
  });

  it("K1: 4 月の月の番号が地図の年月と合わない", () => {
    expect(codes(checkTree({ ...w, constants: { ...w.constants, aprilMonths: [4, 16, 28] } }, root).fails)).toEqual(["K1"]);
  });

  it("J2: 一番ありそうな道で、続けて決まらない転職活動が 3 期（手で作った道）", () => {
    const x0 = toQ(w, w.today);
    const x1 = simQ(w, x0, "fc_switch", 0).find((x) => !x.x.fl.includes("switched"))!.x;
    const out = (st: QSt, m: number) => ({ id: "none", p: 100, w: 1, st, r: [3, 0, 0] as [number, number, number], lab: "転職せず", short: "", line: "", ln: { metric: "sal", at: m, lo: null, hi: null }, sig: "", local: 0 });
    const r: QNode = { key: "r", role: "r", m: 0, st: x0, stage: 0, kids: [], parent: null, pPath: 1, V: 0 };
    let opt: QNode = { key: "r.fc_switch", role: "a", m: 0, st: x0, stage: 0, kind: "fc_switch", kids: [], parent: r, pPath: 1, V: 0, why: "menu" };
    r.kids.push(opt);
    for (let s = 1; s <= 3; s++) {
      const d: QNode = { key: `${opt.key}.none`, role: "s", m: 3 * s, st: x1, stage: s, out: out(x1, 3 * s), r: [3, 0, 0], kids: [], parent: opt, pPath: 1, V: 0 };
      opt.kids.push(d);
      opt = { key: `${d.key}.${s}fw2`, role: "a", m: 3 * s, st: x1, stage: s, kind: s < 3 ? "fc_switch2" : "keep", kids: [], parent: d, pPath: 1, V: 0, why: s < 3 ? "best" : "keep" };
      d.kids.push(opt);
    }
    opt.kids.push({ key: `${opt.key}.all`, role: "e", m: 36, st: x1, stage: 12, out: out(x1, 12), r: [3, 0, 0], rr: [1, 0, 0], kids: [], parent: opt, pPath: 1, V: 0 });
    rollbackApp(r, S);
    expect(searchStats(w, r.kids[0]!).chainMaxFailRun).toBe(3);
    expect(codes(checkTree(w, r).fails)).toEqual(["J2"]);
  });

  it("一貫性（consistencyOf）: まとめた手の値が一番良い手を超えると、勝った判断とまとめた手に入る道を数える", () => {
    rollbackApp(root, S);
    const d = decisions.find((x) => x.onPi && x.kids.some((a) => a.stub) && x.kids.some((a) => a.why === "best"))!;
    const best = d.kids.find((a) => a.why === "best")!;
    const stub = d.kids.find((a) => a.stub)!;
    mutate(stub, "V", best.V + 5, () => {
      const c = consistencyOf(root);
      expect(c.violations).toBeGreaterThan(0);
      expect(c.worst).toBeCloseTo(5, 6);
      expect(c.piIntoStub).toBeGreaterThan(0);
    });
    rollbackApp(root, S);
    const c = consistencyOf(root);
    expect([c.violations, c.piIntoStub]).toEqual([0, 0]);
  });

  it("新しい出力の点検: Q1（q の有無）・Q2（同じ見積もり方で一番良い手が一番）・M2（cont）・B1（分かれ道）・K0（入れ物の点検）", () => {
    rollbackApp(root, S);
    const opts = { stats, tol: P.tol, maxNodes: 90_000 };
    const out0 = () => checkOutputs(w, root, opts);
    expect(out0()).toEqual([]);
    // まとめた手（その判断の一番良い手は別にある）に q を付ける
    // （ずっと今のままの道では一番良い手もまとめた手のことがあるので、比べる元でない手を選ぶ）
    const stub = qAll.find((a) => a.role === "a" && a.stub && a.why !== "best" && a.parent!.kids.some((b) => b.why === "best"))!;
    mutate(stub, "qv", [1, 0, 0], () => expect(codes(out0())).toEqual(["Q1"]));
    const exp = qAll.find((a) => a.role === "a" && !a.stub && a.why === "best")!;
    mutate(exp, "qv", undefined, () => expect(codes(out0())).toEqual(["Q1"]));
    const d = qAll.find((x) => x.role === "s" && x.kids.some((a) => a.stub) && x.kids.some((a) => a.why === "best"))!;
    const st = d.kids.find((a) => a.stub)!;
    mutate(st, "V", likeValue(d.kids.find((a) => a.why === "best")!, S) + 1, () => expect(codes(out0())).toEqual(["Q2"]));
    const end = qAll.find((n) => n.sumEnd)!;
    mutate(end, "cont", undefined, () => expect(codes(out0())).toEqual(["M2"]));
    mutate(end, "cont", end.cont!.slice(1), () => expect(codes(out0())).toEqual(["M2"]));
    const bad: MoveStats[] = stats.map((x, i) => (i === 0 ? { ...x, calib: { ...x.calib, hit: false } } : x));
    expect(codes(checkOutputs(w, root, { ...opts, stats: bad }))).toEqual(["B1"]);
    // K0: 3 か月の結果の入れ物を使い回した計算が _all と違えば通らない。まとまりが無くても通らない
    const fams = ["switch", "side"];
    const one = { v: [40, 20, 10] as [number, number, number], k: "keep", qs: {}, cells: 0, rolls: 0, ms: 0 };
    const nv = (none: [number, number, number], fam = fams): NeverResult => ({ never: Object.fromEntries([["_all", one.v], ...fam.map((f) => [f, [39, 20, 10]])]), info: {}, none: { ...one, v: none } });
    expect(checkOutputs(w, root, { ...opts, never: nv([40, 20, 10]), fams })).toEqual([]);
    expect(codes(checkOutputs(w, root, { ...opts, never: nv([40, 20, 10.001]), fams }))).toEqual(["K0"]);
    expect(codes(checkOutputs(w, root, { ...opts, never: nv([40, 20, 10], ["switch"]), fams }))).toEqual(["K0"]);
  });
});

describe("今日の手の q の表・「3 年やらない」・順の幅・1 段改善した伸び・届け出の答えの順（truth-2・truth-4・truth-5）", () => {
  // 表を小さくするため、転職・昇格・担当拡大・今のままの手だけの世界で
  const keepFams = new Set(["keep", "switch", "fcpush", "fcscope"]);
  const w2: typeof w = { ...w, kinds: Object.fromEntries(Object.entries(w.kinds).filter(([, d]) => keepFams.has(d.family))), rootMenu: w.rootMenu.filter((k) => keepFams.has(w.kinds[k]!.family)) };
  const oc = new OutcomeCache(S);
  const root2 = rootTable(w2, S, () => false, oc);

  it("今日の手の q はどれも同じ表から。never._all はその一番大きい手で、まとまりの never は同じ作り方。入れ物を使い回した作り直しも同じ（K0）", () => {
    expect(Object.keys(root2.one.qs).sort()).toEqual([...w2.rootMenu].sort());
    expect(root2.one.qs[root2.one.k]).toEqual(root2.one.v);
    for (const k of w2.rootMenu) expect(Wsum(root2.one.qs[k]!, S)).toBeLessThanOrEqual(Wsum(root2.one.v, S) + 1e-9);
    const nv = neverValues(w2, S, () => false, ["switch", "fcpush"], root2, oc);
    expect(nv.never._all).toBe(root2.one.v);
    expect(nv.none.v).toEqual(root2.one.v);
    expect(Object.keys(nv.never).sort()).toEqual(["_all", "fcpush", "switch"]);
    // 転職を除くと、今日の転職の手は選ばない
    expect(nv.info.switch!.k).not.toBe("fc_switch");
    expect(checkOutputs(w, root, { tol: P.tol, maxNodes: 90_000, never: nv, fams: ["switch", "fcpush"] }).filter((f) => f.startsWith("K0"))).toEqual([]);
  });

  it("順の幅: 1 つ目は今日の手の q を出した表（今日の手の並びの順）、2 つ目は生成の木と同じ引き始め、残りは逆の順と決まった並べ替え。幅は一番小さい〜大きい", () => {
    const runs = orderRuns(w2, S, () => false, root2, null, [], 4, oc);
    expect(runs.map((r) => r.name)).toEqual(["menu", "gen", "reverse", "shuffle3"]);
    expect(runs[0]!.qs).toBe(root2.one.qs);
    expect(runs[2]!.order).toEqual([...w2.rootMenu].reverse());
    for (const r of runs) expect(Object.keys(r.qs).sort()).toEqual([...w2.rootMenu].sort());
    const sp = spreadOf(runs, (r) => Wsum(r.qs.keep!, S));
    expect(sp.lo).toBeLessThanOrEqual(sp.hi);
    for (const r of runs) expect(Wsum(r.qs.keep!, S)).toBeGreaterThanOrEqual(sp.lo);
    // 同じ順なら同じ値（作り直しても同じ）
    expect(orderRuns(w2, S, () => false, root2, null, [], 2, oc)[1]!.qs).toEqual(runs[1]!.qs);
  });

  it("標準の続きを 1 段改善した続きは、どの今日の手でも q を下げない（方策の改善）", () => {
    const g = improvementGains(w2, S, () => false, root2);
    expect(g.gains.map((x) => x.k)).toEqual(w2.rootMenu);
    for (const x of g.gains) {
      expect(x.q).toEqual(root2.one.qs[x.k]);
      for (const s2 of [S, 45]) expect(Wsum(x.qImproved, s2) - Wsum(x.q, s2)).toBeGreaterThanOrEqual(-1e-9);
    }
    expect(g.states).toBeGreaterThan(10);
  });

  it("届け出の答えの順: 答えで分かれた手ごとに V(全部可) ≥ V(SpellDash だけ可) ≥ V(どちらも不可) を数える。壊すと数える", () => {
    rollbackApp(root, S);
    const d = filingDominance(root, S);
    expect(d.options).toBeGreaterThan(10);
    const a = qAll.find((x) => x.role === "a" && x.kids.some((c) => c.out?.id === "s") && x.kids.some((c) => c.out?.id === "n"))!;
    const sKid = a.kids.find((c) => c.out!.id === "s")!;
    const nKid = a.kids.find((c) => c.out!.id === "n")!;
    mutate(sKid, "V", nKid.V + Wsum(nKid.r!, S) - Wsum(sKid.r!, S) - 3, () => {
      const e = filingDominance(root, S);
      expect(e.sn).toBe(d.sn + 1);
      expect(e.worstSn).toBeGreaterThanOrEqual(3 - 1e-9);
      expect(e.examples.some((x) => x.startsWith(a.key))).toBe(true);
    });
    rollbackApp(root, S);
  });
});

/** 続きの見積もりの 36 か月目の行き先を、道を 1 本ずつたどって数える（leavesOf の段ごとの足し合わせとは別のやり方） */
function pathLeaves(c: Roll, ever: boolean): Array<{ x: QSt; m: number; sw: number }> {
  const out: Array<{ x: QSt; m: number; sw: number }> = [];
  const go = (n: Roll, m: number, sw: boolean) => {
    const s2 = sw || n.x.fl.includes("switched");
    if (!n.k) {
      out.push({ x: n.x, m, sw: s2 ? m : 0 });
      return;
    }
    for (const k of n.kids) go(k.next, (m * k.p) / 100, s2);
  };
  go(c, 1, ever);
  return out;
}

describe("新しい出力（stage 3。SPEC v1 §2.4・D2）", () => {
  const W = (r: readonly number[], s = S) => r[0]! * s + r[1]! + r[2]!;

  it("q: その 3 か月 + 結果ごとの続きの見積もり（まとめた手と同じ見積もり方）。33 か月目の手は木の値と同じ。判断の一番良い手は q でも一番", () => {
    let expanded = 0;
    let last = 0;
    for (const a of qAll) {
      if (a.role !== "a" || a.stub) continue;
      expanded++;
      // 子の状態から続きの見積もりを引き直して足す（保存した q とは別に）
      const want = a.kids.reduce((v, c) => v + (c.out!.p / 100) * (Wsum(c.r!, S) + (c.role === "s" ? Wsum(gen.ro.roll(c.stage, c.st).v, S) : 0)), 0);
      expect(Wsum(a.qv!, S)).toBeCloseTo(want, 9);
      if (a.m === 33) {
        last++;
        for (const s of [S, 45]) expect(W(a.qv!, s)).toBeCloseTo(a.kids.reduce((v, c) => v + (c.out!.p / 100) * W(c.r!, s), 0), 9);
      }
    }
    expect(expanded).toBeGreaterThan(500);
    expect(last).toBeGreaterThan(50);
    // 一番良い手（今のままが一番なら今のまま）の q は、まとめた手の値・ほかの手の q 以上
    rollbackApp(root, S);
    for (const d of qAll) {
      if (d.role !== "s") continue;
      const best = d.kids.find((a) => a.why === "best") ?? d.kids.find((a) => a.kind === "keep")!;
      for (const a of d.kids) expect(likeValue(a, S)).toBeLessThanOrEqual(likeValue(best, S) + 1e-6);
    }
    // ★（2 位より 10 万円以上）: 同じ見積もり方では木の値より少ない（見直し truth-2）
    const sc = starCounts(root, S, 10);
    expect(sc.all.q).toBeLessThan(sc.all.tree);
    // 木の値と q で一番の手が違うのは、540 万円の一番良い手も広げた判断で、アプリ（木の値）がそちらを選ぶ所だけ（q ではほぼ同じ所）
    let toS2 = 0;
    for (const d of qAll) if (d.role === "s" && d.kids.length >= 2 && bestOf(d).forS2 && !bestOf(d).stub) toS2++;
    expect(sc.all.argmaxDiff).toBe(toS2);
  });

  it("まとめた行き先: mix は続きの見積もりの 36 か月目の行き先の割合と幅（道を 1 本ずつたどっても同じ）。顧客の幅は band と同じ、代表の状態は一番多い物", () => {
    const sums = qAll.filter((n) => n.sumEnd);
    expect(so.sums).toBe(sums.length);
    expect(sums.length).toBe(tree.header.counts.sumEnds);
    let checked = 0;
    for (const [i, n] of sums.entries()) {
      const mx = n.mix!;
      const band = bandOf(w, n.st);
      if (band) expect([mx.cl[0], mx.cl[2]]).toEqual(band.cl);
      else expect(mx.cl[0]).toBe(mx.cl[2]);
      const top = (Object.entries(mx.j) as Array<[string, number]>).sort((a, b) => b[1] - a[1]);
      if (top[0]![1] > top[1]![1] + 1e-3) expect(n.st.j).toBe(top[0]![0]);
      if (i % 7 !== 0) continue;
      // 道を 1 本ずつたどった見込み（合流は足さない）と同じ割合
      let ever = false;
      for (let x: QNode | null = n.parent; x; x = x.parent) if (x.role !== "a" && x.st.fl.includes("switched")) ever = true;
      const ls = pathLeaves(n.roll!, ever);
      const tot = ls.reduce((a, l) => a + l.m, 0);
      const share = (f: (x: QSt) => boolean) => ls.reduce((a, l) => a + (f(l.x) ? l.m : 0), 0) / tot;
      expect(mx.j.e).toBeCloseTo(share((x) => x.j === "e"), 4);
      expect(mx.pm.a).toBeCloseTo(share((x) => x.pm === "a"), 4);
      expect(mx.pro).toBeCloseTo(share((x) => x.pro === 1), 4);
      expect(mx.school).toBeCloseTo(share((x) => x.seats > 0), 4);
      expect(mx.switched).toBeCloseTo(ls.reduce((a, l) => a + l.sw, 0) / tot, 4);
      checked++;
    }
    expect(checked).toBeGreaterThan(150);
  });

  it("まとめた行き先: cont はまとめた手の 3 か月の後から 33 か月目まで 3 か月ごと。初めの手はその状態の粗い表の手で、出来事は決まった語彙", () => {
    const vocab = new Set(CONT_EVENTS);
    let withEv = 0;
    for (const n of qAll) {
      if (!n.sumEnd) continue;
      const a = n.parent!;
      const ct = n.cont!;
      expect(ct.map((c) => c.m)).toEqual(Array.from({ length: (36 - a.m - 3) / 3 }, (_, i) => a.m + 3 + 3 * i));
      expect(ct[0]!.kind).toBe(n.roll!.k);
      expect(ct[0]!.kind).toBe(dp.move(a.stage + 1, n.out!.st));
      for (const c of ct) {
        expect(w.kinds[c.kind]).toBeDefined();
        if (c.ev !== undefined) {
          expect(vocab.has(c.ev)).toBe(true);
          withEv++;
        }
      }
    }
    expect(withEv).toBeGreaterThan(100);
  });

  it("新しい出力の点検（q・mix・cont・分かれ道の数・ノードの数）に通る", () => {
    rollbackApp(root, S);
    expect(checkOutputs(w, root, { stats, tol: P.tol, maxNodes: 90_000 })).toEqual([]);
    // 点検が見落とさないこと: mix を 1 つ消すと通らない
    const n = qAll.find((x) => x.sumEnd)!;
    const keep = n.mix;
    delete n.mix;
    expect(checkOutputs(w, root, { stats, tol: P.tol, maxNodes: 90_000 }).some((f) => f.startsWith("M1"))).toBe(true);
    n.mix = keep;
    expect(checkOutputs(w, root, { stats, tol: P.tol, maxNodes: 4000 }).some((f) => f.startsWith("N1"))).toBe(true);
  });

  it("「3 年やらない」見積もり: 粗い表をその種類なしで作り直す。3 か月の結果の入れ物を使っても使わなくても同じ値で、除いた種類の手は今日に選ばない", () => {
    // 表を小さくするため、転職・昇格・担当拡大・今のまま以外のまとまりをすべて除く
    const keepFams = new Set(["keep", "switch", "fcpush", "fcscope"]);
    const ex = new Set(Object.keys(w.kinds).filter((k) => !keepFams.has(w.kinds[k]!.family)));
    const oc = new OutcomeCache(S);
    const a = neverOf(w, S, ex, () => false, oc);
    const b = neverOf(w, S, ex, () => false, null);
    expect(a.v).toEqual(b.v);
    expect(a.k).toBe(b.k);
    expect(ex.has(a.k)).toBe(false);
    expect(a.v.every((x) => Number.isFinite(x))).toBe(true);
    // 今日の手ごとの q も同じ表から（一番大きい手の q が never）
    expect(Object.keys(a.qs).every((k) => !ex.has(k))).toBe(true);
    expect(a.qs[a.k]).toEqual(a.v);
    for (const k of Object.keys(a.qs)) expect(Wsum(a.qs[k]!, S)).toBeLessThanOrEqual(Wsum(a.v, S) + 1e-9);
    const c = neverOf(w, S, ex, () => false, oc);
    expect(c.v).toEqual(a.v);
    expect(oc.hits).toBeGreaterThan(0);
    // 入口の never（まとまり + _all）として書き、読むだけの地図の入口からそのまま読める
    const dev = toDevTree(w, root, { anchor: "2026-11", release: 0, hash: "test", textVersion: "dev", never: { _all: b.v, side: a.v } });
    expect(fromDevTree(dev).header.never).toEqual({ _all: b.v, side: a.v });
  });
});

describe("文章の焼き込みと文章の点検（scripts/impact/q/text.ts。SPEC v1 §3.1・§4.3・§4.6）", () => {
  // 生成の入口（main.ts）と同じ順: 開発用の木 → 同梱データの精度に丸める → 焼き込む → 決まった並び → 読み手
  const dev = canonicalizeDevTree(toDevTree(w, root, { anchor: "2026-11", release: 0, hash: "", textVersion: "dev" }));
  const rep = bakeText(dev);
  const m1 = fromDevTree(dev);
  const bytes = encodeMap(m1);
  dev.header.hash = bundleHash(bytes);
  const m2 = decodeBundleBytes(bytes);
  /** 作り物の組み立て（本物は遅いので、通らない場合の確かめに使う） */
  const fake = (f: (map: Parameters<ComposeFn>[0], i: number, annual: number) => Partial<ReturnType<ComposeFn>>): ComposeFn => (map, i, annual) => ({ title: `題${i}`, short: "", body: "", numbers: [], todo: map.role(i) === "a" ? [{ text: "やる", cite: "spell-week-01" }] : [], trace: [], ...f(map, i, annual) });
  const copy = (): DevTree => structuredClone(dev);

  it("題・短い名前・やること（元の番号つき）を焼き込み、入口の textVersion は文の型の束の版。年収 540 でも同じ文", () => {
    expect(rep.fails).toEqual([]);
    expect([dev.header.textVersion, rep.textVersion]).toEqual([BANKS.version, BANKS.version]);
    expect(rep.cards).toBe(m1.n);
    expect(rep.ms).toHaveLength(2);
    const nodes = devNodes(dev);
    expect(nodes.map((n) => n.k)).toEqual(Array.from({ length: m1.n }, (_, i) => m1.key(i)));
    for (const n of nodes) {
      expect(n.title).toBeTruthy();
      if (n.r === "a") expect(n.todo!.length).toBeGreaterThanOrEqual(1);
      else expect(n.todo).toBeUndefined();
      // 子の並びは最後のまま（開発用の木の JSON が読みやすいように）
      if (n.kids) expect(Object.keys(n).at(-1)).toBe("kids");
    }
    expect(rep.movesWithTodo).toBe(nodes.filter((n) => n.r === "a").length);
    expect(rep.distinct.cite).toBeGreaterThan(10);
  });

  it("開発用の木（fromDevTree）も同梱データの読み手も、焼き込んだ題・短い名前・やることを返す（仮の文でない）。その場の組み立てと同じ", () => {
    expect(compareMaps(m1, m2)).toEqual([]);
    expect(m2.header.textVersion).toBe(BANKS.version);
    for (const i of [0, 1, 2, 3, m2.n - 1, Math.floor(m2.n / 2)]) {
      const c = composeCard(m2, i, { annual: 360 });
      expect([m2.title(i), m2.short(i), m2.todo(i)]).toEqual([c.title, c.short, m2.role(i) === "a" ? c.todo : []]);
      expect([m1.title(i), m1.short(i), m1.todo(i)]).toEqual([m2.title(i), m2.short(i), m2.todo(i)]);
    }
    // 仮の文（手の種類の名前・結果の名前）ではない
    const keep = m2.indexOfKey("r.keep");
    expect(m2.title(0)).not.toBe("今日");
    expect(m2.title(keep)).not.toBe(m2.header.kinds.keep![0]);
    expect(m2.todo(keep).every((t) => t.text.length > 0 && /^[a-z]+(-[a-z0-9]+)+$/.test(t.cite))).toBe(true);
    expect(checkBaked(m2)).toEqual([]);
    // 木の形の点検（S1〜S5）にも通る
    expect(checkStructure(m2, ONLY)).toEqual([]);
  });

  it("TB2: 年収で変わる題・空の題・手でないカードのやること・元の番号の無いやることは通らない", () => {
    const codesOf = (r: { fails: string[] }) => [...new Set(r.fails.map((f) => f.split(" ")[0]))];
    const ok = bakeText(copy(), { compose: fake(() => ({})) });
    expect(ok.fails).toEqual([]);
    const sal = bakeText(copy(), { compose: fake((_, i, annual) => (annual === 540 && i === 5 ? { title: "年収で変わる" } : {})) });
    expect(codesOf(sal)).toEqual(["TB2"]);
    expect(sal.fails[0]).toContain("年収で変わる");
    const sal2 = bakeText(copy(), { compose: fake((map, i, annual) => (annual === 540 && map.role(i) === "a" ? { todo: [{ text: "別", cite: "spell-week-02" }] } : {})) });
    expect(sal2.fails.some((f) => f.includes("やることが年収で変わる"))).toBe(true);
    expect(sal2.fails.at(-1)).toContain("全部で");
    expect(bakeText(copy(), { compose: fake((_, i) => (i === 2 ? { title: "" } : {})) }).fails).toEqual([expect.stringContaining("題が空")]);
    expect(bakeText(copy(), { compose: fake((map, i) => (map.role(i) === "s" && i < 10 ? { todo: [{ text: "x", cite: "spell-week-01" }] } : {})) }).fails[0]).toContain("手でないカードにやること");
    expect(bakeText(copy(), { compose: fake((map, i) => (map.role(i) === "a" ? { todo: [{ text: "x", cite: "" }] } : {})) }).fails[0]).toContain("元の番号が空");
  });

  it("TB1: 読んだ地図の題・短い名前・やることがその場の組み立てと違う・入口の版が違うと通らない", () => {
    const k = 7;
    const wrong = Object.create(m2) as typeof m2;
    Object.defineProperty(wrong, "title", { value: (i: number) => (i === k ? "違う題" : m2.title(i)) });
    expect(checkBaked(wrong)).toEqual([expect.stringContaining(`TB1 焼き込んだ文章がその場の組み立てと違う: ${m2.key(k)}`)]);
    const a = m2.indexOfKey("r.keep");
    const noTodo = Object.create(m2) as typeof m2;
    Object.defineProperty(noTodo, "todo", { value: (i: number) => (i === a ? [] : m2.todo(i)) });
    expect(checkBaked(noTodo)).toHaveLength(1);
    const old = Object.create(m2) as typeof m2;
    Object.defineProperty(old, "header", { value: { ...m2.header, textVersion: "0.1" } });
    expect(checkBaked(old)).toEqual([expect.stringContaining("TB1 入口の文の型の版 0.1")]);
  });

  it("TC: 文章の点検の止める物は生成を止め（TC を付ける。例の行はそのまま）、データの指摘は注意。本物の点検はこの木で通る", () => {
    const report = { failures: ["C6 似かた: 1 件（年収 360・path 1）", "  C6 道の繰り返し 5（門 4）"], warnings: ["D1 データ: 2 件（年収 540・e 2）"], runs: [] } as unknown as TextCheckReport;
    const seen: unknown[] = [];
    const g = textGate(m2, {}, (m, o) => (seen.push(m, o.annuals), report));
    expect(seen).toEqual([m2, [360, 540]]);
    expect(g.fails).toEqual(["TC C6 似かた: 1 件（年収 360・path 1）", "  C6 道の繰り返し 5（門 4）"]);
    expect(g.warns).toEqual(["D1 データ: 2 件（年収 540・e 2）"]);
    const real = textGate(m2);
    expect(real.fails).toEqual([]);
    expect(real.report.runs.map((r) => r.annual)).toEqual([360, 540]);
  }, 60_000);
});

describe("予算の使い道（D1・truth-1）: 同じ表を引き継いで ind_quit を分かれ道 2,000 で（一貫性を生成の年収だけで守る形。540 の一番良い手を広げると飽和しないので）", () => {
  const iq = generate(w, { ...P, B: 2000, annuals: [360] }, ["ind_quit"], dp);
  summaryOutputs(w, iq.root);
  rollbackApp(iq.root, S);
  const s = iq.stats[0]!;
  const nodes: QNode[] = [];
  const visit = (n: QNode) => {
    nodes.push(n);
    for (const c of n.kids) visit(c);
  };
  visit(iq.root);

  it("事実の小さい組も分けて飽和し、別の領域の手を広げて目標の ±2% に入る（数はスナップショット）", () => {
    expect(s.calib).toMatchObject({ target: 2000, saturated: true, fine: true, reachMax: null, hit: true });
    expect(s.calib.areaN).toBeGreaterThan(0);
    expect(s.calib.Bint).toBe(Infinity);
    expect(Math.abs(s.forks - 2000)).toBeLessThanOrEqual(40);
    expect({ calib: s.calib, forks: s.forks, nodes: s.nodes, areaExp: s.areaExp }).toMatchInlineSnapshot(`
      {
        "areaExp": 2,
        "calib": {
          "Bint": Infinity,
          "areaEligible": 285,
          "areaN": 2,
          "areaReverted": 0,
          "areaUsed": 2,
          "fine": true,
          "fineDropped": false,
          "fineMax": 1469,
          "hit": true,
          "passes": 6,
          "reachMax": null,
          "s2Reverted": 0,
          "saturated": true,
          "splitMax": 1469,
          "target": 2000,
        },
        "forks": 1981,
        "nodes": 6541,
      }
    `);
  });

  it("事実の小さい組は段 3 までだけ分け、広げた別の領域の手は一番良い手を超えず（アプリの選ぶ手は変わらない）、その先はおすすめの道に入らない", () => {
    const area = nodes.filter((n) => n.areaExp);
    expect(area.length).toBe(s.areaExp);
    for (const a of area) {
      const d = a.parent!;
      const best = d.kids.find((x) => x.why === "best") ?? d.kids.find((x) => x.kind === "keep")!;
      expect([a.why, a.stub, d.onPi]).toEqual(["area", false, true]);
      expect(a.qv).toBeDefined();
      expect(a.V).toBeLessThanOrEqual(best.V + 1e-9);
      expect(likeValue(a, S)).toBeLessThanOrEqual(likeValue(best, S) + 1e-9);
      for (const c of a.kids) expect(c.onPi).toBe(false);
    }
    // 1.18 倍と 1.08 倍を分けた転職（fine）は段 3 まで
    const fineSplit = nodes.filter((n) => n.role === "s" && (n.out!.id === "high" || n.out!.id === "mid") && n.parent!.kind !== "fc_switch");
    expect(fineSplit.length).toBeGreaterThan(0);
    for (const n of fineSplit) expect(n.parent!.stage).toBeLessThanOrEqual(DEFAULTS.fineDepth);
    const c = consistencyOf(iq.root);
    expect([c.violations, c.piIntoStub]).toEqual([0, 0]);
    expect(checkTree(w, iq.root).fails).toEqual([]);
    expect(checkOutputs(w, iq.root, { stats: iq.stats, tol: P.tol, maxNodes: 90_000 })).toEqual([]);
  });

  it("広げた別の領域の手の木の値が一番良い手を超えたら、まとめた手に戻す（revertExpansions。木を書き換えるので最後に）", () => {
    rollbackApp(iq.root, S);
    const a = nodes.find((n) => n.areaExp)!;
    const d = a.parent!;
    const best = d.kids.find((x) => x.why === "best") ?? d.kids.find((x) => x.kind === "keep")!;
    const ev = a.ev!;
    // a の先の 1 つの結果の稼ぎを大きくして、木の値を一番良い手より大きくする
    const c0 = a.kids[0]!;
    c0.r = [c0.r![0], c0.r![1] + 5000, c0.r![2]];
    rollbackApp(iq.root, S);
    expect(a.V).toBeGreaterThan(best.V);
    const a0 = iq.root.kids[0]!;
    expect(iq.gen.revertExpansions(a0)).toEqual({ area: 1, s2: 0 });
    expect([a.stub, a.areaExp, a.qv]).toEqual([true, false, undefined]);
    // 子は a の見積もり（その 3 か月 + 続きの見積もり）からのまとめた行き先
    expect(a.kids.map((k) => [k.key, k.out!.p, k.sumEnd, k.role])).toEqual(ev.outs.map((o) => [`${a.key}.${o.id}`, o.p, true, "e"]));
    a.kids.forEach((k, i) => expect(k.r).toEqual(ev.outs[i]!.r.map((x, j) => x + ev.conts[i]!.v[j]!)));
    expect(a.V).toBeCloseTo(a.kids.reduce((v, k) => v + (k.out!.p / 100) * Wsum(k.r!, S), 0), 9);
    expect(a.V).toBeCloseTo(ev.q, 6);
    // 判断の値は一番良い手の値（戻した手はそれを超えない: 余裕に別の領域の手も入れてある）
    expect(d.V).toBe(best.V);
    rollbackApp(iq.root, S);
    const con2 = consistencyOf(iq.root);
    expect([con2.violations, con2.piIntoStub]).toEqual([0, 0]);
    summaryOutputs(w, iq.root);
    expect(checkOutputs(w, iq.root, { tol: P.tol, maxNodes: 90_000 }).filter((f) => /^(Q1|Q2|M1|M2)/.test(f))).toEqual([]);
  });
});
