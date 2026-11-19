// 3 か月ごとの地図の生成（scripts/impact/q）を小さい予算で: 決まった木（作り直しても同じ指紋）・木の形・アプリと同じ値・一貫性・前提の点検・開発用の木の形。
// 本物の世界（P2 の前提）で、最初の手を 2 つ（今のまま・届け出て副業の 1 社目を探す）、分かれ道 600 に絞る（粗い表を 1 回作るので数秒かかる）。
// 8 万枚の木（既定の形）はここでは作らない
import { describe, expect, it } from "vitest";
import worldJson from "../../scripts/impact/world.json";
import type { World } from "../../scripts/impact/sim";
import { checkTree } from "../../scripts/impact/q/checks";
import { toDevTree } from "../../scripts/impact/q/devTree";
import { consistencyOf, DEFAULTS, generate, R1_ALTS_BY, rollbackApp, type Params } from "../../scripts/impact/q/gen";
import { runRateQ } from "../../scripts/impact/q/sim";
import { quarterWorld } from "../../scripts/impact/q/world";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";
import type { DevTreeNode } from "../../src/deepmap/mapData";

const w = quarterWorld(worldJson as unknown as World);
const S = w.annual / 12;
const P: Params = { ...DEFAULTS, B: 600, altsBy: [...R1_ALTS_BY] };
const ONLY = ["keep", "ad_permside"];
const { root, stats, gen } = generate(w, P, ONLY);
const vRoot = rollbackApp(root, S);
const con = consistencyOf(root);
const chk = checkTree(w, root);
const tree = toDevTree(w, root, { anchor: "2026-11", release: 0, hash: "test", textVersion: "dev" });
/** 状態の印の付いた深い場所を探すための、鍵からの結果ノード */
const qByKey = new Map<string, (typeof root)["kids"][number]>();
{
  const visit = (n: typeof root) => {
    qByKey.set(n.key, n);
    for (const c of n.kids) visit(c);
  };
  visit(root);
}

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

/** P2 の前提でこの形（最初の手 2 つ・分かれ道 600）を作った時の値（作業メモ deepmap/gen/tools/golden.ts で、生成そのものから出した） */
const GOLDEN = {
  stats: [
    ["keep", 609, 2437, 3, 751],
    ["ad_permside", 595, 2498, 3, 517],
  ] as Array<[string, number, number, number, number]>,
  guards: 14,
  vRoot: 1249.5321375408766,
  vSQ: 1124.1749999999997,
  counts: { nodes: 4936, decisions: 860, options: 2224, forks: 1205, ends: 1852, sumEnds: 1514 },
  fingerprint: "14l0bgv1kf8sv6",
  bands: 1227,
  rv: 231,
};

/** 並び（深さ優先）の 1 行（鍵・役割・月・状態・稼ぎ・手・結果・幅・子の数） */
function fingerprint(r: DevTreeNode): string {
  const rows = nodesOf(r).map(({ n }) => {
    const s = n.st;
    return [n.k, n.r, n.m, s.j, s.pm, s.pro, s.mau, s.pu, s.seats, s.cl, s.fee, s.sal, s.cv, s.fl.join("+"), n.rr ?? null, n.kind ?? null, n.h ?? null, !!n.base, n.why ?? null, !!n.stub, n.id ?? null, n.p ?? null, n.lab ?? null, n.line ?? null, n.ln ?? null, n.e ?? null, n.rv ?? null, !!n.sum, n.band ?? null, (n.kids ?? []).length];
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
  it("決まった木: 作り直しても同じ鍵・並び・見込み・稼ぎ・状態・結果の名前と線・幅（P2 の前提で作った時の値）", () => {
    // P2 の前提（作業メモ SPEC v1 §2.2・§2.3）でこの形を作った時の値。前提や作り方を変えたら、ここも作り直す
    expect(stats.map((s) => [s.kind, s.forks, s.nodes, s.passes, s.Bint])).toEqual(GOLDEN.stats);
    expect(gen.guards).toBe(GOLDEN.guards);
    expect(vRoot).toBeCloseTo(GOLDEN.vRoot, 9);
    expect(rollbackApp(root, S, true)).toBeCloseTo(GOLDEN.vSQ, 9);
    rollbackApp(root, S);
    expect(tree.header.counts).toEqual(GOLDEN.counts);
    expect(fingerprint(tree.root)).toBe(GOLDEN.fingerprint);
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
      // 広げた手（まとめていない手）は一番良い手か、今のまま
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
