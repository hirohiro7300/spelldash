// 見取り図・手の詳しい画面・道の画面の「画面に出す形」（src/deepmap/views の model.ts・format.ts）の確かめ（DOM を使わない）
// 確かめること: 数の書き方（単位・符号・幅）・画面の切り替えの名前・行の並びと言葉・英字の鍵が画面の文字に出ないこと・
// 扇の目盛り・進め方の割合・道の行。8 万枚の木での数は deepmapViewsSlow.test.ts（DEEPMAP_SLOW=1 のときだけ）

import { describe, expect, it } from "vitest";
import { analyze, compileMap, fallbackText, kindKey, type Analysis, type MoveCounts } from "../../src/deepmap/core";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";
import {
  condText,
  countsLine,
  fanDomain,
  findFirstMove,
  kindSlug,
  looksLikeId,
  man,
  manDelta,
  manDeltaRange,
  manMonthly,
  manRange,
  moveDetailVM,
  moveHash,
  niceTicks,
  notesVM,
  num,
  overviewVM,
  parseRoute,
  pathHash,
  pathVM,
  pct,
  pct1,
  safeName,
  worthText,
} from "../../src/deepmap/views";
import { handTree } from "./deepmapFixtures";

function handAnalysis(annual = 360): Analysis {
  return analyze(compileMap(fromDevTree(handTree())), annual);
}

/** 画面の文字になる値を全部集める（鍵・色・リンクの欄は除く） */
const KEY_FIELDS = new Set(["kind", "href", "backHref", "key", "id", "color", "slug", "answer", "fact"]);
function strings(x: unknown, out: string[] = [], key = ""): string[] {
  if (KEY_FIELDS.has(key)) return out;
  if (typeof x === "string") out.push(x);
  else if (Array.isArray(x)) for (const v of x) strings(v, out, key);
  else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) strings(v, out, k);
  return out;
}

/** 英字の鍵（手の種類・結果・事実・文章の語彙の名前）に見える部分 */
const ID_RE = /\b(?:ad|sd|fc|ind|back)_[a-z0-9_]+\b|\b[a-z]+_[a-z0-9]+(?:_[a-z0-9]+)*\b|\bpm:\d+\b|\b(?:keep|stub|undefined|null|NaN|Infinity)\b/;

describe("数の書き方", () => {
  it("万円・差・幅・見込みに単位と符号を付ける", () => {
    expect(num(79092)).toBe("79,092");
    expect(num(-1240.4)).toBe("−1,240");
    expect(man(1269.011)).toBe("1,269 万円");
    expect(man(4.06)).toBe("4.1 万円");
    expect(man(9.96)).toBe("10 万円");
    expect(manDelta(21.97)).toBe("+22 万円");
    expect(manDelta(4.93)).toBe("+4.9 万円");
    expect(manDelta(-76.59)).toBe("−77 万円");
    expect(manDelta(-218.62)).toBe("−219 万円");
    expect(manDelta(0.01)).toBe("±0 万円");
    expect(manRange(1158.805, 1452.079)).toBe("1,159〜1,452 万円");
    expect(manRange(1124.2, 1124.2)).toBe("1,124 万円");
    expect(manDeltaRange(34.6, 327.9)).toBe("+35〜+328 万円");
    expect(manDeltaRange(-143, 255.5)).toBe("−143〜+256 万円");
    expect(manMonthly(42.64)).toBe("42.6 万円");
    expect(pct(0.2)).toBe("20%");
    expect(pct(0.004)).toBe("1% 未満");
    expect(pct(0)).toBe("0%");
    expect(pct(0.9961)).toBe("99%");
    expect(pct(1)).toBe("100%");
    expect(pct1(0.0637)).toBe("6.4%");
    expect(pct1(0.5)).toBe("50%");
  });

  it("この種類を 3 年やらない場合との差は 4 万円未満を「ほぼ差なし」", () => {
    expect(worthText(3.9)).toBe("ほぼ差なし");
    expect(worthText(-3.9)).toBe("ほぼ差なし");
    expect(worthText(44.3)).toBe("+44 万円");
  });

  it("分かれ道と行き先の数の 1 行（作業メモ truth-18・user-13 の言い方）", () => {
    const c: MoveCounts = { nodes: 7853, decisions: 1452, splits: 586, forks: 2038, ends: 2844, sumEnds: 2131, reachEnds: 383, reachEnds1: 9, reachSum: 0 };
    expect(countsLine(c, "2029 年 11 月")).toBe("判断 1,452 回・出来事の分かれ 586 → 2029 年 11 月の行き先 383（見込み 1% 以上 9）・標準の続きの見積もり 2,131");
  });

  it("鍵に見える名前は画面に出さない", () => {
    expect(looksLikeId("a0_a1")).toBe(true);
    expect(looksLikeId("high_mid")).toBe(true);
    expect(looksLikeId("SpellDash だけ")).toBe(false);
    expect(safeName("a0_a1", "その結果")).toBe("その結果");
    expect(safeName("全部可", "その結果")).toBe("全部可");
    expect(safeName("", "その結果")).toBe("その結果");
  });

  it("軸の目盛りはきりの良い数で、範囲を覆う", () => {
    const t = niceTicks(28.3, 49.6, 5);
    expect(t[0]).toBeGreaterThanOrEqual(28.3);
    expect(t[t.length - 1]).toBeLessThanOrEqual(49.6);
    for (let k = 1; k < t.length; k++) expect(t[k]! - t[k - 1]!).toBeCloseTo(t[1]! - t[0]!, 9);
    expect([1, 2, 2.5, 5, 10].map((x) => x * 10 ** Math.floor(Math.log10(t[1]! - t[0]!)))).toContainEqual(expect.closeTo(t[1]! - t[0]!, 9));
    const d = fanDomain([{ id: "x", label: "x", color: "#000", share: null, band: true, pts: [{ m: 0, lo: 29.7, mid: 30, hi: 31 }, { m: 36, lo: 33, mid: 43, hi: 49.6 }] }]);
    expect(d.lo).toBeLessThanOrEqual(29.7);
    expect(d.hi).toBeGreaterThanOrEqual(49.6);
  });
});

describe("画面の切り替え（ハッシュ）", () => {
  it("手の種類の鍵から英字・数字・ハイフンだけの名前を作り、読み戻せる", () => {
    expect(moveHash("ad_permside")).toBe("#move-ad-permside");
    expect(kindSlug("fc_switch2")).toBe("fc-switch2");
    expect(parseRoute("#move-ad-permside")).toEqual({ name: "move", slug: "ad-permside" });
    expect(parseRoute(pathHash(123))).toEqual({ name: "path", node: 123 });
    expect(parseRoute("#overview")).toEqual({ name: "overview" });
    expect(parseRoute("")).toEqual({ name: "overview" });
    // claude.ai の予約名・おかしな形は見取り図に
    for (const h of ["#settings", "#sidebar", "#customize", "#upgrade", "#downloads", "#comment-1", "#move-", "#path-x", "#move-A_B"]) expect(parseRoute(h)).toEqual({ name: "overview" });
  });

  it("見取り図の行のリンクは予約名でなく、今日の手に戻せる", () => {
    const a = handAnalysis();
    const vm = overviewVM(a);
    for (const r of vm.rows) {
      expect(r.href).toMatch(/^#(move-[a-z0-9-]+)$/);
      const route = parseRoute(r.href);
      expect(route.name).toBe("move");
      if (route.name === "move") expect(findFirstMove(a, kindSlug, route.slug)).toBe(r.node);
    }
  });
});

describe("見取り図", () => {
  it("今日の手ごとに 1 行・表示した差の大きい順・比べる元は「この 3 か月は今のまま」", () => {
    const a = handAnalysis();
    const vm = overviewVM(a);
    expect(vm.rows).toHaveLength(a.cm.firstMoves.length);
    for (let k = 1; k < vm.rows.length; k++) expect(vm.rows[k - 1]!.sortKey).toBeGreaterThanOrEqual(vm.rows[k]!.sortKey);
    const base = vm.rows.find((r) => r.isBase)!;
    expect(base.name).toBe("この 3 か月は今のまま");
    expect(base.delta?.text).toBe("比べる元");
    expect(base.decides.kind).toBe("base");
    // 手の木は q がそろっているので、差は同じ見積もり方
    expect(vm.basis).toBe("q");
    const ap = vm.rows.find((r) => r.kind === "ad_permside")!;
    expect(ap.delta?.basis).toBe("同じ見積もり方");
    expect(ap.decides.kind).toBe("reveal");
    expect(ap.decides.text).toBe("会社の答え: 全部可 20%・SpellDash だけ 45%・どちらも不可 35%");
    // never がある木: 「この種類を 3 年やらない場合との差」（4 万円未満はほぼ差なし）
    expect(ap.worth?.label).toBe("3 年やらない場合との差");
    expect(vm.worthNote).toBeNull();
    expect(ap.countsText).toMatch(/^判断 [\d,]+ 回・出来事の分かれ [\d,]+ → 2029 年 11 月の行き先 [\d,]+（見込み 1% 以上 [\d,]+）・標準の続きの見積もり [\d,]+$/);
    expect(ap.countsParts.join("")).toBe(ap.countsText);
    expect(ap.rangeText).toMatch(/^3 年の合計 [\d,]+(〜[\d,]+)? 万円（10〜90%・真ん中 [\d,]+ 万円）$/);
    expect(ap.vsKeepText).toMatch(/^ずっと今のままより [+−±][\d,.]+/);
    expect(ap.strip.map((c) => c.m)).toEqual([0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33]);
    expect(ap.strip.reduce((s, c) => s + c.dec + c.split, 0)).toBe(ap.forks);
    expect(vm.lead).toMatch(/^今日選べる 6 の手。どの手の先にも、2029 年 11 月まで [\d,]+(〜[\d,]+)? の分かれ道が続く$/);
    expect(vm.footer).toBe("3 年後の幅は、この手より、この先の分かれ道での選び方と運で決まる");
  });

  it("never の無い木は「3 年やらない場合との差」を出さず、注記する", () => {
    const t = handTree();
    t.header.never = {};
    const a = analyze(compileMap(fromDevTree(t)), 360);
    const vm = overviewVM(a);
    expect(vm.rows.every((r) => r.worth === null)).toBe(true);
    expect(vm.worthNote).toContain("計算の前提を直した木");
  });

  it("q の無い木は差を地図の値で出し、そう書く", () => {
    const t = handTree();
    const strip = (n: { q?: unknown; kids?: unknown[] }) => {
      delete n.q;
      for (const k of (n.kids ?? []) as Array<{ q?: unknown; kids?: unknown[] }>) strip(k);
    };
    strip(t.root as never);
    const a = analyze(compileMap(fromDevTree(t)), 360);
    const vm = overviewVM(a);
    expect(vm.basis).toBe("tree");
    expect(vm.rows.filter((r) => !r.isBase).every((r) => r.delta?.basis === "地図の値")).toBe(true);
    expect(vm.basisNote).toContain("地図の値");
  });
});

describe("手の詳しい画面・道の画面", () => {
  it("扇は 0〜36 か月目の 13 点・答えごとの帯は 3 本・年月は 0 か月目から", () => {
    const a = handAnalysis();
    const f = a.cm.firstMoves.find((x) => kindKey(a.cm, x) === "ad_permside")!;
    const d = moveDetailVM(a, f);
    expect(d.fan.months).toEqual([0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36]);
    expect(d.fan.yms[0]).toBe("2026 年 11 月");
    expect(d.fan.yms[12]).toBe("2029 年 11 月");
    expect(d.fan.answers.map((s) => s.label)).toEqual(["全部可", "SpellDash だけ", "どちらも不可"]);
    expect(d.fan.answers.reduce((s, x) => s + (x.share ?? 0), 0)).toBeCloseTo(1, 9);
    expect(d.fan.formula).toContain("年収 360 万円");
    expect(d.endYm).toBe("2029 年 11 月");
    expect(d.chain?.text).toMatch(/^一番ありそうな道（見込み [\d.]+%）$/);
    expect(d.chain?.href).toBe(pathHash(f));
    expect(d.outcomes.map((o) => o.label)).toEqual(["全部可", "SpellDash だけ", "どちらも不可"]);
  });

  it("進め方: 今日の行は今日の手 100%、どの時点も出した手と「ほか」で 100% を超えない", () => {
    const a = handAnalysis();
    for (const f of a.cm.firstMoves) {
      const d = moveDetailVM(a, f);
      expect(d.plan[0]!.ym).toBe("今日");
      expect(d.plan[0]!.moves[0]!.shareText).toBe("100%");
      for (const q of d.plan) {
        const shown = q.moves.reduce((s, m) => s + m.share, 0);
        expect(shown).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it("直前の結果の言葉: 結果が 1 つの手は「〜の後」、それ以外は「〜なら」（同じ言葉は 1 つ）", () => {
    const a = handAnalysis();
    expect(condText(a, [{ label: "据え置き", fromKind: "fc_push", single: false, share: 0.6 }, { label: "据え置き", fromKind: "sd_grow", single: false, share: 0.2 }, { label: "昇格", fromKind: "fc_push", single: false, share: 0.2 }], false)).toBe("据え置き・昇格なら");
    expect(condText(a, [{ label: "どの場合も", fromKind: "sd_retain", single: true, share: 1 }], false)).toBe("続ける人を増やすの後");
    expect(condText(a, [{ label: "全部可", fromKind: "ad_permside", single: false, share: 0.5 }, { label: "どの場合も", fromKind: "sd_grow", single: true, share: 0.5 }], true)).toBe("全部可なら／遊ぶ人を増やすの後など");
    expect(condText(a, [{ label: "a0_a1", fromKind: "ad_permside", single: false, share: 1 }], false)).toBe("その結果なら");
  });

  it("道の画面（仮の形）: 今日から始まり、戻り先はその道の今日の手（今日からの道は見取り図）", () => {
    const a = handAnalysis();
    const text = fallbackText(a.cm.map, { annual: 360 });
    const root = pathVM(a, 0, text);
    expect(root.title).toMatch(/^一番ありそうな道（見込み [\d.]+%）$/);
    expect(root.rows.length).toBeGreaterThanOrEqual(1);
    expect(root.rows[0]!.ym).toBe("2026 年 11 月");
    // 今日からの道は見取り図へ戻る（見取り図にその道のボタンがある）
    expect(root.backHref).toBe("#overview");
    const f = a.cm.firstMoves.find((x) => kindKey(a.cm, x) === "ad_permside")!;
    const deep = a.cm.kids[a.cm.kidOff[f]!]!;
    const p = pathVM(a, deep, text);
    expect(p.title).toMatch(/^この道（ここから先の見込み [\d.]+%）$/);
    expect(p.backHref).toBe(moveHash("ad_permside"));
  });

  it("どの画面の文字にも英字の鍵・数でない値が出ない（年収 360 と 540）", () => {
    for (const annual of [360, 540]) {
      const a = handAnalysis(annual);
      const text = fallbackText(a.cm.map, { annual });
      const all: string[] = [];
      strings(overviewVM(a), all);
      for (const f of a.cm.firstMoves) strings(moveDetailVM(a, f), all);
      for (let i = 0; i < a.cm.n; i += 3) strings(pathVM(a, i, text), all);
      strings(notesVM(a, "q", true), all);
      strings(notesVM(a, "tree", false), all);
      const bad = all.filter((s) => ID_RE.test(s) || /NaN|Infinity|undefined/.test(s));
      expect(bad).toEqual([]);
      // 文章の組み立ての語彙の名前（cont の ev）も出さない
      expect(all.some((s) => s.includes("client_up"))).toBe(false);
    }
  });
});
