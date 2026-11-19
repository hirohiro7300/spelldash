// 3 か月ごとの地図の生成（scripts/impact/q）を小さい予算で: 決まった木（作り直しても同じ指紋）・木の形・アプリと同じ値・一貫性・前提の点検・開発用の木の形。
// 本物の世界（P2 の前提）で、最初の手を 2 つ（今のまま・届け出て副業の 1 社目を探す）、分かれ道 600 に絞る（粗い表を 1 回作るので数秒かかる）。
// 新しい出力（stage 3）: 手の q・まとめた行き先の mix と cont・「3 年やらない」見積もり・予算の使い道（同じ表を引き継いで ind_quit を分かれ道 2,000 で）。
// 8 万枚の木（既定の形）はここでは作らない
import { describe, expect, it } from "vitest";
import worldJson from "../../scripts/impact/world.json";
import type { World } from "../../scripts/impact/sim";
import { checkOutputs, checkTree } from "../../scripts/impact/q/checks";
import { OutcomeCache, Wsum, type Roll } from "../../scripts/impact/q/core";
import { toDevTree } from "../../scripts/impact/q/devTree";
import { consistencyOf, DEFAULTS, generate, R1_ALTS_BY, rollbackApp, type Params, type QNode } from "../../scripts/impact/q/gen";
import { bandOf } from "../../scripts/impact/q/group";
import { CONT_EVENTS, likeValue, neverOf, starCounts, summaryOutputs } from "../../scripts/impact/q/outputs";
import { runRateQ, type QSt } from "../../scripts/impact/q/sim";
import { quarterWorld } from "../../scripts/impact/q/world";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";
import type { DevTreeNode } from "../../src/deepmap/mapData";

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

/** P2 の前提と stage 3 の出力でこの形（最初の手 2 つ・分かれ道 600）を作った時の値（作業メモ deepmap/gen/tools/golden3.ts で、生成そのものから出した） */
const GOLDEN = {
  stats: [
    ["keep", 597, 2394, 5, 736.16680032077],
    ["ad_permside", 595, 2498, 4, 517.0588235294117],
  ] as Array<[string, number, number, number, number]>,
  guards: 56,
  vRoot: 1249.5321375408766,
  vSQ: 1124.1749999999997,
  counts: { nodes: 4893, decisions: 852, options: 2205, forks: 1193, ends: 1836, sumEnds: 1503 },
  fingerprint: "08g0f5b1x03s22",
  bands: 1223,
  rv: 231,
  /** ★ の数（木の値・同じ見積もり方） */
  stars: [79, 22],
  /** 今日の手の q（ad_permside・keep） */
  rootQ: [
    [39.92117028152647, 30.000360863512004, 14.205587886966006],
    [40.22129079890847, 20.237136383512, 8.275590324219998],
  ],
};

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
  it("決まった木: 作り直しても同じ鍵・並び・見込み・稼ぎ・状態・結果の名前と線・幅・q・mix・cont（P2 の前提と stage 3 の出力で作った時の値）", () => {
    // P2 の前提（作業メモ SPEC v1 §2.2・§2.3）と §2.4 の出力でこの形を作った時の値。前提や作り方を変えたら、ここも作り直す
    expect(stats.map((s) => [s.kind, s.forks, s.nodes, s.passes, s.Bint])).toEqual(GOLDEN.stats);
    // 分ける予算だけで目標の ±2% に入る（飽和しない）
    for (const s of stats) expect(s.calib).toMatchObject({ target: 600, saturated: false, fine: false, areaN: 0, reachMax: null, hit: true });
    expect(gen.guards).toBe(GOLDEN.guards);
    expect(vRoot).toBeCloseTo(GOLDEN.vRoot, 9);
    expect(rollbackApp(root, S, true)).toBeCloseTo(GOLDEN.vSQ, 9);
    rollbackApp(root, S);
    expect(tree.header.counts).toEqual(GOLDEN.counts);
    expect(fingerprint(tree.root)).toBe(GOLDEN.fingerprint);
    expect(tree.root.kids!.map((a) => a.q)).toEqual(GOLDEN.rootQ);
    const sc = starCounts(root, S, 10);
    expect([sc.all.tree, sc.all.q]).toEqual(GOLDEN.stars);
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
    expect(all.filter(({ n }) => n.band).length).toBe(GOLDEN.bands);
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
      // 広げた手（まとめていない手）は一番良い手か、今のまま（予算の使い道 2 で広げた別の領域の手は下の ind_quit で確かめる）
      for (const a of n.kids!) if (!a.stub && a.m < 33) expect(a.why === "best" || a.kind === "keep").toBe(true);
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
    expect(seen).toBe(GOLDEN.rv);
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

  it("一貫性（R1 の報告 §6.4）: おすすめの道ではまとめた手が勝たず、おすすめの道はまとめた手に入らない", () => {
    expect(con.decisions).toBeGreaterThan(300);
    expect(con.violations).toBe(0);
    expect(con.piIntoStub).toBe(0);
    expect(con.piDecisions).toBe(con.decisions);
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
    expect(sc.mixed.argmaxDiff).toBe(0);
  });

  it("まとめた行き先: mix は続きの見積もりの 36 か月目の行き先の割合と幅（道を 1 本ずつたどっても同じ）。顧客の幅は band と同じ、代表の状態は一番多い物", () => {
    const sums = qAll.filter((n) => n.sumEnd);
    expect(so.sums).toBe(sums.length);
    expect(sums.length).toBe(GOLDEN.counts.sumEnds);
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
    const mode = (k: string, x: QSt) => gen.modeFor(k, x, "lean");
    const oc = new OutcomeCache();
    const a = neverOf(w, S, ex, mode, () => false, oc);
    const b = neverOf(w, S, ex, mode, () => false, null);
    expect(a.v).toEqual(b.v);
    expect(a.k).toBe(b.k);
    expect(ex.has(a.k)).toBe(false);
    expect(a.v.every((x) => Number.isFinite(x))).toBe(true);
    const c = neverOf(w, S, ex, mode, () => false, oc);
    expect(c.v).toEqual(a.v);
    expect(oc.hits).toBeGreaterThan(0);
    // 入口の never（まとまり + _all）として書き、読むだけの地図の入口からそのまま読める
    const dev = toDevTree(w, root, { anchor: "2026-11", release: 0, hash: "test", textVersion: "dev", never: { _all: b.v, side: a.v } });
    expect(fromDevTree(dev).header.never).toEqual({ _all: b.v, side: a.v });
  });
});

describe("予算の使い道（D1・truth-1）: 同じ表を引き継いで ind_quit を分かれ道 2,000 で", () => {
  const iq = generate(w, { ...P, B: 2000 }, ["ind_quit"], dp);
  summaryOutputs(w, iq.root);
  rollbackApp(iq.root, S);
  const s = iq.stats[0]!;
  const nodes: QNode[] = [];
  const visit = (n: QNode) => {
    nodes.push(n);
    for (const c of n.kids) visit(c);
  };
  visit(iq.root);

  it("分ける予算だけでは飽和（1,545）し、事実の小さい組を分け、別の領域の手を 1 つ広げて目標の ±2% に入る", () => {
    expect(s.calib).toMatchObject({ target: 2000, saturated: true, splitMax: 1545, fine: true, fineMax: 1656, areaN: 1, areaUsed: 1, areaReverted: 0, reachMax: null, hit: true });
    expect(s.calib.Bint).toBe(Infinity);
    expect(Math.abs(s.forks - 2000)).toBeLessThanOrEqual(40);
    expect([s.forks, s.nodes, s.areaExp]).toEqual([1994, 6539, 1]);
  });

  it("事実の小さい組は段 3 までだけ分け、広げた別の領域の手は一番良い手を超えず（アプリの選ぶ手は変わらない）、その先はおすすめの道に入らない", () => {
    const area = nodes.filter((n) => n.areaExp);
    expect(area.length).toBe(1);
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
});
