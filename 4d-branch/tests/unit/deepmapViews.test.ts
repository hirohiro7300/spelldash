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
  quietTitle,
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

  it("道の画面: 今日の手の一番ありそうな道（行・見込み・月の稼ぎ・ここまでの稼ぎ・着いた所・戻り先）", () => {
    const a = handAnalysis();
    const text = fallbackText(a.cm.map, { annual: 360 });
    const f = a.cm.firstMoves.find((x) => kindKey(a.cm, x) === "ad_permside")!;
    const vm = pathVM(a, f, text);
    expect(vm.title).toBe("一番ありそうな道");
    expect(vm.offs).toEqual([]);
    expect(vm.resetHref).toBeNull();
    expect(vm.backHref).toBe(moveHash("ad_permside"));
    expect(vm.backText).toBe("届け出て副業の 1 社目を探すへ");
    expect(vm.eyebrow).toBe("届け出て副業の 1 社目を探す・2026 年 11 月〜2029 年 11 月");
    expect(vm.start.ym).toBe("2026 年 11 月");
    expect(vm.start.title).toBe("今日");
    expect(vm.defaultOpen).toEqual([]);
    const s0 = vm.steps[0]!;
    expect(s0.ym).toBe("2026 年 11 月");
    expect(s0.span).toBe("12 月〜2 月の手");
    expect(s0.move).toBe("届け出て副業の 1 社目を探す");
    expect(s0.outcomeText).toBe("SpellDash だけ 45%");
    expect(s0.monthlyText).toMatch(/^月の稼ぎ \d+\.\d 万円$/);
    expect(s0.runningText).toMatch(/^ここまでの稼ぎ [\d,.]+ 万円$/);
    expect(s0.nextText).toBe("次の 3 か月へ（2027 年 2 月）");
    expect(s0.altOutcomesText).toBe("全部可 20%・どちらも不可 35%");
    expect(s0.altOptionsText).toBe(`ほかの手 ${a.cm.firstMoves.length - 1}`);
    // この手の結果: 3 つ（この道の物は押せない）・この判断で選べる手: 今日の手の全部（この道の手との差の大きい順）
    expect(s0.outcomes.map((o) => o.name)).toEqual(["全部可", "SpellDash だけ", "どちらも不可"]);
    expect(s0.outcomes.filter((o) => o.current).map((o) => o.name)).toEqual(["SpellDash だけ"]);
    expect(s0.outcomes.every((o) => o.current || (o.href === pathHash(o.node) && /^[+−±]/.test(o.diffText ?? "")))).toBe(true);
    expect(s0.options.length).toBe(a.cm.firstMoves.length);
    expect(s0.options.find((o) => o.current)!.tags).toContain("この道の手");
    expect(s0.options.filter((o) => o.tags.includes("おすすめ")).length).toBe(1);
    const ds = s0.options.filter((o) => !o.current).map((o) => o.diffText);
    expect(ds.every((d) => d !== null && /^[+−±]/.test(d))).toBe(true);
    // 最後の行の次は着いた所・着いた所は 2029 年 11 月
    const last = vm.steps[vm.steps.length - 1]!;
    expect(last.nextText).toBe("着いた所へ（2029 年 11 月）");
    expect(vm.end.head).toBe("2029 年 11 月に着く所");
    expect(vm.end.facts[0]).toMatch(/^3 年の合計 [\d,]+ 万円（ずっと今のままより [+−±][\d,.]+ 万円）$/);
    expect(vm.figures.map((x) => x.label)).toEqual(["この道の見込み", "3 年の合計", "2029 年 11 月の月の稼ぎ"]);
    expect(vm.figures[0]!.value).toBe("32%");
    // 文章は開いたときに作る（同じ物を返す）
    const d0 = s0.detail();
    expect(d0).toBe(s0.detail());
    expect(d0.move.head).toBe("この 3 か月（12 月〜2 月）");
    expect(d0.outcome!.head).toBe("2027 年 2 月の結果（見込み 45%）");
    expect(d0.outcome!.facts[0]).toBe("今日からここまでの見込み 45%");
    // 今日から（見取り図の「今日から一番ありそうな道」）は見取り図へ戻る
    const root = pathVM(a, 0, text);
    expect(root.backHref).toBe("#overview");
    expect(root.eyebrow).toBe("今日から・2026 年 11 月〜2029 年 11 月");
    expect(root.steps[0]!.option).toBe(a.pi.pi[0]);
  });

  it("道の画面: ほかの結果・手に切り替えると、上の行はそのまま、切り替えた所から先が変わる", () => {
    const a = handAnalysis();
    const text = fallbackText(a.cm.map, { annual: 360 });
    const f = a.cm.firstMoves.find((x) => kindKey(a.cm, x) === "ad_permside")!;
    const base = pathVM(a, f, text);
    const alt = base.steps[0]!.outcomes.find((o) => o.name === "全部可")!;
    const sw = pathVM(a, alt.node, text);
    expect(sw.title).toBe("切り替えた道");
    expect(sw.offs).toEqual(["2027 年 2 月の結果: 全部可 20%"]);
    expect(sw.resetHref).toBe(pathHash(f));
    expect(sw.steps[0]!.key).toBe(base.steps[0]!.key);
    expect(sw.steps[0]!.outcome).toBe(alt.node);
    expect(sw.steps[0]!.pivot).toBe(true);
    expect(sw.steps[0]!.off).toBe(true);
    expect(sw.steps[0]!.outcomes.find((o) => o.current)!.name).toBe("全部可");
    expect(sw.defaultOpen).toEqual([sw.steps[0]!.key]);
    expect(sw.figures[0]!.value).not.toBe(base.figures[0]!.value);
    // ほかの手（おすすめでない手）に切り替える: その行に「おすすめの手ではない」・違う所に書く
    const s1 = sw.steps[1]!;
    const other = s1.options.find((o) => !o.current)!;
    const sw2 = pathVM(a, other.node, text);
    expect(sw2.steps[1]!.option).toBe(other.node);
    expect(sw2.steps[1]!.key).toBe(s1.key);
    expect(sw2.offs.some((t) => t.startsWith("2027 年 2 月の手: "))).toBe(other.tags.includes("おすすめ") ? false : true);
  });

  it("道の画面: 続けて同じ手の静かな期は 1 行（「今のまま（3 期続けて）」）、まとめた手の後は標準の続きの薄い行", () => {
    const a = handAnalysis();
    const text = fallbackText(a.cm.map, { annual: 360 });
    const map = a.cm.map;
    const keep = pathVM(a, map.indexOfKey("r.keep.all.1k.all.2k"), text);
    const g = keep.items[0]!;
    expect(g.type).toBe("group");
    if (g.type !== "group") return;
    expect(g.ym).toBe("2026 年 11 月〜2027 年 5 月");
    expect(g.title).toBe("今のまま（3 期続けて）");
    expect(g.outcomeText).toBeNull();
    expect(g.steps.length).toBe(3);
    expect(quietTitle("転職活動を続ける", 3, "決まらず")).toBe("転職活動を続ける（3 期・決まらず）");
    // まとめた手（今のまま）の先: cont の手を年月と手の名前で（文章の組み立ての語彙の名前は出さない）
    const stub = pathVM(a, map.indexOfKey("r.ad_permside.a.1as.cl1.2k"), text);
    const st = stub.steps[stub.steps.length - 1]!;
    expect(st.stub).toBe(true);
    expect(st.monthlyText).toBeNull();
    expect(st.detail().outcome).toBeNull();
    expect(st.detail().note).toContain("標準の選び方で");
    const light = stub.items.filter((x) => x.type === "light");
    expect(light.map((x) => (x.type === "light" ? `${x.ym} ${x.title}` : ""))).toEqual(["2027 年 8 月 紹介で顧客を増やす", "2027 年 11 月 今のまま"]);
    expect(stub.end.summary).toBe(true);
    expect(stub.end.head).toBe("2029 年 11 月に着く所（標準の続きの見積もり）");
    expect(stub.end.note).toContain("標準の続きの平均");
    expect(stub.figures[1]!.sub).toContain("標準の続きの平均");
    expect(stub.spark.path.some((p) => p.est)).toBe(true);
    // cont の無いまとめた手: 1 本の薄い行
    const stub2 = pathVM(a, map.indexOfKey("r.ad_permside.a.1k"), text);
    const l2 = stub2.items.filter((x) => x.type === "light");
    expect(l2.map((x) => (x.type === "light" ? x.ym : ""))).toEqual(["2027 年 5 月〜2029 年 8 月"]);
  });

  it("道の画面: 行き先から開いた道は「この行き先までの道」で、行き先の種類の名前を出す", () => {
    const a = handAnalysis();
    const text = fallbackText(a.cm.map, { annual: 360 });
    const e = a.cm.map.indexOfKey("r.ad_permside.s.1fp.up");
    const vm = pathVM(a, e, text);
    expect(vm.title).toBe("この行き先までの道");
    expect(vm.end.node).toBe(e);
    expect(vm.end.cls).toBe("会社員・届け出はまだ・副業なし・Pro なし");
    expect(vm.defaultOpen).toEqual([]);
    expect(vm.spark.path[0]!.m).toBe(0);
    expect(vm.spark.path[vm.spark.path.length - 1]!.m).toBe(36);
    expect(vm.spark.keep.length).toBeGreaterThanOrEqual(2);
    expect(vm.spark.keep.every((p) => p.m % 3 === 0 && p.m >= 0 && p.m <= 36)).toBe(true);
    expect(vm.spark.months).toEqual([0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36]);
  });

  it("どの画面の文字にも英字の鍵・数でない値が出ない（年収 360 と 540）", () => {
    for (const annual of [360, 540]) {
      const a = handAnalysis(annual);
      const text = fallbackText(a.cm.map, { annual });
      const all: string[] = [];
      strings(overviewVM(a), all);
      for (const f of a.cm.firstMoves) strings(moveDetailVM(a, f), all);
      for (let i = 0; i < a.cm.n; i += 3) {
        const p = pathVM(a, i, text);
        strings(p, all);
        for (const st of p.steps) strings(st.detail(), all);
        all.push(p.end.body(), p.start.body());
      }
      strings(notesVM(a, "q", true), all);
      strings(notesVM(a, "tree", false), all);
      const bad = all.filter((s) => ID_RE.test(s) || /NaN|Infinity|undefined/.test(s));
      expect(bad).toEqual([]);
      // 文章の組み立ての語彙の名前（cont の ev）も出さない
      expect(all.some((s) => s.includes("client_up"))).toBe(false);
    }
  });
});
