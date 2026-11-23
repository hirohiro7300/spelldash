// 見取り図・手の詳しい画面・道の画面の「画面に出す形」（src/deepmap/views の model.ts・format.ts）の確かめ（DOM を使わない）
// 確かめること: 数の書き方（単位・符号・幅）・画面の切り替えの名前・行の並びと言葉・英字の鍵が画面の文字に出ないこと・
// 扇の目盛り・進め方の割合・道の行。8 万枚の木での数は deepmapViewsSlow.test.ts（DEEPMAP_SLOW=1 のときだけ）

import { describe, expect, it } from "vitest";
import { analyze, compileMap, destClassOf, destinations, destLabel, destParts, endsFrom, fallbackText, kindKey, medianEnd, overview, placeIn, planView, refillNumbers, type Analysis, type MoveCounts, type TextSource } from "../../src/deepmap/core";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";
import type { DevTree, DevTreeNode } from "../../src/deepmap/mapData";
import {
  condText,
  countsLine,
  fanDomain,
  findFirstMove,
  findPathToken,
  keyToken,
  kindSlug,
  looksLikeId,
  man,
  manDelta,
  manDeltaRange,
  manMonthly,
  manRange,
  moveDetailVM,
  moveHash,
  NEAR_KEEP_NOTE,
  NEAR_KEEP_TEXT,
  niceTicks,
  notesVM,
  num,
  overviewVM,
  parseRoute,
  pathHash,
  pathVM,
  pct,
  pct1,
  placeText,
  PLAN_MOVES,
  planVM,
  quietTitle,
  safeName,
  SMALL_DELTA_TEXT,
  WORTH_LABEL,
  worthText,

} from "../../src/deepmap/views";
import { handTree, randomTree } from "./deepmapFixtures";

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

/** 英字の鍵（手の種類・結果・事実・文章の語彙の名前。cont の語彙は大文字: PU_MILE・CLIENT_UP など）に見える部分 */
const ID_RE = /\b(?:ad|sd|fc|ind|back)_[a-z0-9_]+\b|\b[a-z]+_[a-z0-9]+(?:_[a-z0-9]+)*\b|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\bpm:\d+\b|\b(?:keep|stub|undefined|null|NaN|Infinity)\b/;

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

  it("この種類が使えることの値打ちは誤差（4 万円か、地図のマイナスの差の大きさ）未満とマイナスを「ほぼ無し」（作業メモ truth-4・reader-12）", () => {
    expect(worthText(3.9)).toBe("ほぼ無し");
    expect(worthText(-3.9)).toBe("ほぼ無し");
    // マイナスは誤差: 損のように書かない
    expect(worthText(-5.14)).toBe("ほぼ無し");
    expect(worthText(-250)).toBe("ほぼ無し");
    expect(worthText(44.3)).toBe("+44 万円");
    expect(worthText(5.1, 5.14)).toBe("ほぼ無し");
    expect(worthText(5.2, 5.14)).toBe("+5.2 万円");
    // 札の名前は、何の（この種類の手）・どちら向きの（使える分だけ多い）差かを言う（「3 年やらない場合との差」は「この手をやらない」と読める）
    expect(WORTH_LABEL).toBe("この種類が使えることの値打ち");
    expect(WORTH_LABEL).not.toMatch(/やらない場合/);
  });

  it("分かれ道と行き先の数の 1 行（作業メモ truth-18・user-13 の言い方）", () => {
    const c: MoveCounts = { nodes: 7853, decisions: 1452, splits: 586, forks: 2038, ends: 2844, sumEnds: 2131, reachEnds: 383, reachEnds1: 9, reachSum: 0 };
    // 行き先は 2 つの数に名前を付ける: 地図にある行き先（まとめた物を含む全部）と、一番良い選び方で着く本当の行き先（作業メモ reader-4）
    expect(countsLine(c, "2029 年 11 月")).toBe("判断 1,452 回・出来事の分かれ 586 → 2029 年 11 月の行き先: 地図にある 2,844（うち標準の続きの見積もり 2,131）・一番良い選び方で着く 383（見込み 1% 以上 9）");
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
    expect(parseRoute("#overview")).toEqual({ name: "overview" });
    expect(parseRoute("")).toEqual({ name: "overview" });
    // claude.ai の予約名・おかしな形は見取り図に
    for (const h of ["#settings", "#sidebar", "#customize", "#upgrade", "#downloads", "#comment-1", "#move-", "#path-x", "#move-A_B", "#path-t", "#path-tAB"]) expect(parseRoute(h)).toEqual({ name: "overview" });
  });

  it("道はカードの鍵から作る名前で指す: 兄弟の順番を変えた地図でも同じカード、前の版の番号の道は「無い道」（作業メモ code-2）", () => {
    // scripts/build-preview.mjs の同じ式と同じ値
    expect(keyToken("r.ad_permside")).toBe("1cdy81soor3");
    const t = handTree();
    const m1 = fromDevTree(t);
    // 今日の手の並びを逆にした地図（番号はずれる）
    const t2 = handTree();
    t2.root.kids!.reverse();
    const m2 = fromDevTree(t2);
    const key = "r.ad_permside.s.1fp.up";
    const i1 = m1.indexOfKey(key);
    const i2 = m2.indexOfKey(key);
    expect(i1).not.toBe(i2);
    const h1 = pathHash(m1, i1);
    expect(h1).toMatch(/^#path-t[0-9a-z]{1,12}$/);
    expect(pathHash(m2, i2)).toBe(h1);
    const r = parseRoute(h1);
    expect(r.name).toBe("path");
    if (r.name === "path") {
      expect(m2.key(findPathToken(m2, r.token!))).toBe(key);
      expect(m1.key(findPathToken(m1, r.token!))).toBe(key);
    }
    // 地図に無い名前・前の版の番号の道
    expect(findPathToken(m1, "zzzzzz")).toBe(-1);
    expect(parseRoute("#path-123")).toEqual({ name: "path", token: null });
    // どのカードの名前も地図の中で 1 つだけ
    const seen = new Set<string>();
    for (let i = 0; i < m1.n; i++) seen.add(keyToken(m1.key(i)));
    expect(seen.size).toBe(m1.n);
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
    // 手の木は q がそろっているので、差は同じ見積もり方。どの差も同じ出し方なので、札ごとには書かず 1 回だけ（作業メモ user-10）
    expect(vm.basis).toBe("q");
    expect(vm.basisLine).toContain("見積もりどうしで比べた");
    const ap = vm.rows.find((r) => r.kind === "ad_permside")!;
    expect(ap.delta?.basis).toBeNull();
    expect(ap.decides.kind).toBe("reveal");
    // 結果の並びは「、」でつなぐ（作業メモ reader-5）
    expect(ap.decides.text).toBe("会社の答え: 全部可 20%、SpellDash だけ 45%、どちらも不可 35%");
    // never がある木: 「この種類が使えることの値打ち」（4 万円未満はほぼ無し）
    expect(ap.worth?.label).toBe("この種類が使えることの値打ち");
    expect(vm.worthNote).toBeNull();
    expect(ap.countsText).toMatch(/^判断 [\d,]+ 回・出来事の分かれ [\d,]+ → 2029 年 11 月の行き先: 地図にある [\d,]+（うち標準の続きの見積もり [\d,]+）・一番良い選び方で着く [\d,]+（見込み 1% 以上 [\d,]+）$/);
    expect(ap.countsParts.join("")).toBe(ap.countsText);
    expect(ap.rangeText).toMatch(/^3 年の合計 [\d,]+(〜[\d,]+)? 万円（10〜90%・真ん中 [\d,]+ 万円）$/);
    expect(ap.vsKeepText).toMatch(/^ずっと今のままより [+−±][\d,.]+/);
    expect(ap.strip.map((c) => c.m)).toEqual([0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33]);
    expect(ap.strip.reduce((s, c) => s + c.dec + c.split, 0)).toBe(ap.forks);
    expect(vm.lead).toMatch(/^今日選べる 6 の手。どの手の先にも、2029 年 11 月まで [\d,]+(〜[\d,]+)? の分かれ道が続く$/);
    // 読み方は見取り図の最初に（作業メモ user-1）
    expect(vm.frame).toBe("3 年後の幅は、この手より、この先の分かれ道での選び方と運で決まる");
    // 比べる元（3 か月待つ）の幅をどの手の行にも並べる
    for (const r of vm.rows) {
      if (r.isBase) expect(r.waitText).toBeNull();
      else expect(r.waitText).toMatch(/^3 か月待っても [+−±][\d,.]+(〜[+−±][\d,.]+)? 万円$/);
      expect(r.distHead).toContain("この手の後、一番良い選び方で");
    }
    // 10 の手をひと目で: どの手も共通の軸に 10〜90% と真ん中（ずっと今のままの線も軸の中）
    expect(vm.glance.rows.map((r) => r.node)).toEqual(vm.rows.map((r) => r.node));
    expect(vm.glance.title).toBe("6 の手をひと目で");
    for (const r of vm.glance.rows) {
      expect(r.range).not.toBeNull();
      expect(r.range!.p10).toBeGreaterThanOrEqual(vm.glance.lo - 1e-9);
      expect(r.range!.p90).toBeLessThanOrEqual(vm.glance.hi + 1e-9);
      expect(r.href).toMatch(/^#move-/);
    }
    expect(vm.glance.keep).toBeGreaterThanOrEqual(vm.glance.lo);
    // 今日から一番ありそうな道と真ん中あたりの道（3 年の合計と行き先の中の位置）
    expect(vm.chain?.text).toMatch(/^今日から一番ありそうな道（見込み [\d.]+%）$/);
    expect(vm.chain?.sub).toMatch(/^3 年の合計 [\d,]+ 万円・今日からの道の中で(低い方から|高い方から|真ん中)/);
    expect(vm.median?.text).toMatch(/^今日から真ん中あたりの道（3 年の合計 [\d,]+ 万円）$/);
  });

  it("never の無い木は「3 年やらない場合との差」を出さず、注記する", () => {
    const t = handTree();
    t.header.never = {};
    const a = analyze(compileMap(fromDevTree(t)), 360);
    const vm = overviewVM(a);
    expect(vm.rows.every((r) => r.worth === null)).toBe(true);
    expect(vm.worthNote).toContain("計算の前提を直した地図");
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
    expect(vm.rows.filter((r) => !r.isBase).every((r) => r.delta?.basis === null)).toBe(true);
    expect(vm.basisLine).toBe("差はどれも、その後に一番良い選び方をした場合の 3 年の稼ぎで比べた");
    expect(vm.basisNote).toContain("一番良い選び方");
    // 見方の定義も地図の値の出し方（作業メモ truth-7）
    expect(notesVM(a, "tree", false).howTo[0]).toContain("どちらもその後は一番良い選び方");
  });

  it("差の出し方が混ざる見取り図は、札ごとに出し方を書く", () => {
    const t = handTree();
    // 1 つの手だけ q を消す（その手は地図の値の差）
    const sg = t.root.kids!.find((k) => k.kind === "sd_grow")!;
    delete sg.q;
    const a = analyze(compileMap(fromDevTree(t)), 360);
    const vm = overviewVM(a);
    expect(vm.basisLine).toBeNull();
    expect(vm.rows.find((r) => r.kind === "sd_grow")!.delta?.basis).toBe("その先の選び直しも入れた差");
    expect(vm.rows.find((r) => r.kind === "ad_permside")!.delta?.basis).toBe("見積もり同士の差");
  });

  it("q の見方は、差の定義を標準の選び方の見積もりで書く（作業メモ truth-7）", () => {
    const a = handAnalysis();
    const q = notesVM(a, "q", true);
    expect(q.howTo.join("\n")).not.toContain("どちらもその後は一番良い選び方");
    expect(q.howTo[0]).toContain("その後は標準の選び方で見積もった");
    const base = overviewVM(a).rows.find((r) => r.isBase)!;
    expect(base.decides.text).not.toContain("その後は一番良い選び方");
  });

  it("「今のままの先とほぼ同じ・近い」は、その後のおすすめの手の違いが小さいときだけ（作業メモ truth-2）", () => {
    for (const make of [handTree, () => randomTree(1), () => randomTree(2), () => randomTree(3, 1500)]) {
      const a = analyze(compileMap(fromDevTree(make())), 360);
      const ov = overview(a);
      const vm = overviewVM(a, ov);
      for (const r of vm.rows) {
        const mv = ov.moves.find((m) => m.node === r.node)!;
        const d = r.decides;
        const texts = [d.text, "note" in d ? d.note : null].filter((x): x is string => !!x).join("\n");
        if (texts.includes("の先とほぼ同じ") || texts.includes("の先と近い")) expect(mv.nearKeep).toBe(true);
        if (d.kind === "near") expect(d.text).toBe(NEAR_KEEP_TEXT);
        if (d.kind === "reveal" && d.note === NEAR_KEEP_NOTE) expect(mv.nearKeep).toBe(true);
        if (mv.smallDelta && !mv.nearKeep && !mv.isBase) expect(texts).toContain(SMALL_DELTA_TEXT);
        expect(texts).not.toContain("3 か月遅れで続く");
      }
    }
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
    expect(d.chain?.href).toBe(pathHash(a.cm.map, f));
    expect(d.chain?.sub).toMatch(/この手の後の道の中で/);
    expect(d.median?.href).toMatch(/^#path-t/);
    expect(d.frame).toBe("3 年後の幅は、この手より、この先の分かれ道での選び方と運で決まる");
    // 平均の内訳: この手の分（＋ その後の選び直しの分）+ 3 か月待っても出る分（作業メモ user-1・reader-2）
    expect(d.facts.some((t) => /^ずっと今のままより平均 [+−±][\d,.]+ 万円 ＝ この手の分 [+−±][\d,.]+ 万円(?: ＋ その後の選び直しの分 [+−±][\d,.]+ 万円)? ＋ 3 か月待っても出る分 [+−±][\d,.]+ 万円$/.test(t))).toBe(true);
    // 行き先の 2 つの数（今日の手の本文と同じ言い方。作業メモ reader-4）
    expect(d.facts.some((t) => /^2029 年 11 月の行き先: 地図にある [\d,]+（うち標準の続きの見積もり [\d,]+）・一番良い選び方で着く [\d,]+（見込み 1% 以上 [\d,]+）$/.test(t))).toBe(true);
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

  it("理由の言葉: 前の手は「〜の後」、結果は年月つきで「〜なら」、手が 2 つなら手の名前、覆えない残りは「主に」（作業メモ user-7・truth-5）", () => {
    const a = handAnalysis();
    expect(condText(a, null)).toBeNull();
    expect(condText(a, { m: 3, back: 1, byMove: false, cover: 1, items: [{ fromKind: "fc_switch", mFrom: 0, labels: ["転職せず"], all: false, share: 1 }] })).toBe("2027 年 2 月に転職せずなら");
    expect(condText(a, { m: 6, back: 0, byMove: true, cover: 1, items: [{ fromKind: "sd_retain", mFrom: 3, labels: [], all: true, share: 1 }] })).toBe("続ける人を増やすの後");
    expect(condText(a, { m: 9, back: 1, byMove: true, cover: 1, items: [{ fromKind: "sd_grow", mFrom: 3, labels: [], all: true, share: 1 }] })).toBe("2027 年 2 月の遊ぶ人を増やすの後");
    expect(
      condText(a, {
        m: 9,
        back: 0,
        byMove: false,
        cover: 0.9,
        items: [
          { fromKind: "ad_side", mFrom: 6, labels: ["顧客 1 社"], all: false, share: 0.6 },
          { fromKind: "ad_more", mFrom: 6, labels: ["顧客 2 社"], all: false, share: 0.3 },
        ],
      }),
    ).toBe("主に 2027 年 8 月に顧客 1 社（副業の顧客を 1 社増やす）、顧客 2 社（紹介で顧客を増やす）なら");
    expect(condText(a, { m: 3, back: 0, byMove: false, cover: 1, items: [{ fromKind: "ad_permside", mFrom: 0, labels: ["a0_a1"], all: false, share: 1 }] })).toBe("2027 年 2 月にその結果なら");
  });

  it("進め方: 1 つの月の手どうしは同じ理由を持たず、結果を全部並べた「〜なら」は書かない。残りの手は開いて見られる（作業メモ user-7・user-8・truth-5）", () => {
    for (const make of [handTree, () => randomTree(1), () => randomTree(2), () => randomTree(3, 1500)]) {
      const a = analyze(compileMap(fromDevTree(make())), 360);
      for (const f of a.cm.firstMoves) {
        const rows = planVM(a, f);
        const pv = planView(a, f);
        rows.forEach((r, k) => {
          const all = [...r.moves, ...r.rest];
          expect(all.length).toBe(pv[k]!.moves.length);
          expect(r.moves.length).toBeLessThanOrEqual(PLAN_MOVES);
          if (r.rest.length) expect(r.more).toMatch(/^ほか \d+ つの手 /);
          const conds = all.map((m) => m.cond).filter((c): c is string => !!c);
          expect(new Set(conds).size).toBe(conds.length);
          // 手が 1 つの月は理由を書かない
          if (all.length === 1 && r.m > 0) expect(all[0]!.cond).toBeNull();
        });
        for (const q of pv)
          for (const mv of q.moves) {
            if (!mv.when || mv.when.byMove) continue;
            for (const it of mv.when.items) if (!it.all) expect(it.labels.length).toBeGreaterThan(0);
          }
      }
    }
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
    expect(s0.altOutcomesText).toBe("全部可 20%、どちらも不可 35%");
    expect(s0.altOptionsText).toBe(`ほかの手 ${a.cm.firstMoves.length - 1}`);
    // この手の結果: 3 つ（この道の物は押せない）・この判断で選べる手: 今日の手の全部（この道の手との差の大きい順）
    expect(s0.outcomes.map((o) => o.name)).toEqual(["全部可", "SpellDash だけ", "どちらも不可"]);
    expect(s0.outcomes.filter((o) => o.current).map((o) => o.name)).toEqual(["SpellDash だけ"]);
    expect(s0.outcomes.every((o) => o.current || (o.href === pathHash(a.cm.map, o.node) && /^[+−±]/.test(o.diffText ?? "")))).toBe(true);
    // 札の差は、行に出した 3 年の合計どうしの差（本文の「N 万円少ない」と同じ丸め: 文章の波 1a の B1）
    const shownTotal = (t: string): number => Number(/3 年の合計の見込み ([\d,.]+) 万円/.exec(t)![1]!.replace(/,/g, ""));
    const cur = s0.outcomes.find((o) => o.current)!;
    for (const o of s0.outcomes.filter((x) => !x.current)) expect(o.diffText).toBe(manDelta(shownTotal(o.valueText!) - shownTotal(cur.valueText!)));
    // 結果の差は、この道の結果との差と書く（作業メモ user-9）・お金の行は結果の月（作業メモ user-12）
    // 結果の年月はその結果の状態の月（答えが届く月は本文が言う。作業メモ truth-8）
    expect(s0.outcomesHead).toBe("この手の結果（2027 年 2 月の時点・この道との 3 年の合計の差）");
    expect(s0.moneyAt).toBe("2027 年 2 月");
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
    // 3 年の合計が、この手の後の行き先の中のどこか（作業メモ user-2・truth-6）
    expect(vm.figures[1]!.note).toMatch(/^この手の後の道の中で(低い方から|高い方から|真ん中)/);
    // 仮の文章は、仮と出す（作業メモ user-4）
    expect(vm.provisional).toBe(true);
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
    expect(sw.resetHref).toBe(pathHash(a.cm.map, f));
    expect(sw.figures[1]!.note ?? "").toMatch(/^切り替えた所から先の道の中で/);
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
    // まとめた手（今のまま）の先: 見積もりの印の行の後に cont の手を年月と手の名前で（文章の組み立ての語彙の名前は出さない。作業メモ code-1）
    const stub = pathVM(a, map.indexOfKey("r.ad_permside.a.1as.cl1.2k"), text);
    const st = stub.steps[stub.steps.length - 1]!;
    expect(st.stub).toBe(true);
    expect(st.monthlyText).toBeNull();
    expect(st.detail().outcome).toBeNull();
    expect(st.detail().note).toContain("下の薄い行は、その代表の 1 本の手");
    expect(st.detail().note).not.toContain("分けていない");
    const light = stub.items.filter((x) => x.type === "light");
    expect(light.map((x) => (x.type === "light" ? `${x.ym} ${x.title}${x.head ? "（印）" : ""}` : ""))).toEqual([
      "2027 年 8 月〜2029 年 8 月 ここから先は標準の選び方で続けた見積もり（印）",
      "2027 年 8 月 紹介で顧客を増やす",
      "2027 年 11 月 今のまま",
    ]);
    expect(light.length).toBe(1 + 2);
    expect(stub.end.summary).toBe(true);
    expect(stub.end.head).toBe("2029 年 11 月に着く所（標準の続きの見積もり）");
    expect(stub.end.note).toContain("標準の続きの平均");
    expect(stub.figures[1]!.sub).toContain("標準の続きの平均");
    expect(stub.spark.path.some((p) => p.est)).toBe(true);
    // まとめた手を通る道は「この道の見込み」と書かない（標準の続きに入るまでの見込み。作業メモ truth-1・user-6）
    expect(stub.figures[0]!.label).toBe("標準の続きに入るまでの見込み");
    expect(stub.figures[0]!.sub).toContain("1 本の道の見込みではない");
    expect(stub.figures[2]!.sub).toContain("標準の続きの平均");
    const words = [...stub.figures.flatMap((x) => [x.label, x.sub ?? ""]), ...stub.end.facts, stub.intro];
    expect(words.some((t) => t.includes("この道の見込み") || t.includes("出来事の分かれが無い道"))).toBe(false);
    expect(stub.intro).toContain("標準の選び方で 2029 年 11 月まで続けた見積もり");
    // cont の無いまとめた手: 1 本の薄い行（同じ「標準の選び方で続けた見積もり」の言葉）
    const stub2 = pathVM(a, map.indexOfKey("r.ad_permside.a.1k"), text);
    const l2 = stub2.items.filter((x) => x.type === "light");
    expect(l2.map((x) => (x.type === "light" ? `${x.ym} ${x.title}` : ""))).toEqual(["2027 年 5 月〜2029 年 8 月 標準の選び方で続けた見積もり"]);
    expect(stub2.steps[stub2.steps.length - 1]!.detail().note).toContain("分けていない");
  });

  it("道の画面: 文章の作り手が標準の続きの文章を持てば、まとめた手の後の行は開ける（開くまで作らない・見積もりの印・やること・次の 3 か月へ）", () => {
    const a = handAnalysis();
    const map = a.cm.map;
    const base = fallbackText(map, { annual: 360 });
    const asked: Array<[number, number]> = [];
    const text: TextSource = {
      title: base.title,
      short: base.short,
      body: base.body,
      numbers: base.numbers,
      cont: (i, k) => {
        asked.push([i, k]);
        return k === 1 ? null : { title: `続きの題 ${k}`, body: `続きの本文 ${k}`, todo: [{ text: "やること A", cite: "w-1" }, { text: " ", cite: "w-2" }, { text: "sd_grow", cite: "w-3" }] };
      },
    };
    const key = "r.ad_permside.a.1as.cl1.2k";
    const stub = pathVM(a, map.indexOfKey(key), text);
    expect(stub.provisional).toBe(false);
    const light = stub.items.flatMap((x) => (x.type === "light" ? [x] : []));
    // 見積もりの印の行は開けない（開けると書く）。cont の行は開ける。開くまで文章は作らない
    expect(light.map((x) => [x.key, x.head, x.detail !== null])).toEqual([
      ["ch", true, false],
      ["c0", false, true],
      ["c1", false, true],
    ]);
    expect(light[0]!.note).toContain("行を押すと、その 3 か月の文章");
    expect(asked).toEqual([]);
    const c0 = light[1]!;
    const d0 = c0.detail!()!;
    expect(c0.detail!()).toBe(d0);
    expect(asked).toEqual([[stub.end.node, 0]]);
    // 見積もりの印・その期の 3 か月・題・本文・やること（空と英字の鍵は出さない）・数の行は無い（数は着いた所の平均）
    expect(d0).toEqual({ head: "この 3 か月（9 月〜11 月）・標準の続きの代表の 1 本", title: "続きの題 0", numbers: [], body: "続きの本文 0", todo: ["やること A"], facts: [], est: true });
    expect(c0.aria).toBe("2027 年 8 月・紹介で顧客を増やす（標準の続きの見積もり）。押すと、その 3 か月の文章とやること");
    // 文章の無い期は null（画面は短い注記）
    expect(light[2]!.detail!()).toBeNull();
    // 次の 3 か月へ: まとめた手の行 → 標準の続きの行を順に → 着いた所
    expect(stub.steps[stub.steps.length - 1]!.nextText).toBe("次の 3 か月へ（2027 年 8 月・見積もり）");
    expect(light.map((x) => x.nextText)).toEqual([null, "次の 3 か月へ（2027 年 11 月・見積もり）", "着いた所へ（2029 年 11 月）"]);
    // 標準の続きの文章を持たない作り手（仮の文章）は、今までどおり開けない行で、まとめた手の行の次は着いた所
    const plain = pathVM(a, map.indexOfKey(key), base);
    expect(plain.items.every((x) => x.type !== "light" || x.detail === null)).toBe(true);
    expect(plain.steps[plain.steps.length - 1]!.nextText).toBe("着いた所へ（2029 年 11 月）");
    const plainHead = plain.items.flatMap((x) => (x.type === "light" && x.head ? [x] : []))[0];
    expect(plainHead?.note).toBe("代表の 1 本（一番ありそうな出来事と標準の手）で、どの期も分かれ道は開いていない。数は着いた所の平均");
  });

  it("道の画面: ほかの手は、この先も読める手が先、先を広げていない手が後。閉じた行にも先が見積もりと書く（作業メモ user-5）", () => {
    const a = handAnalysis();
    const text = fallbackText(a.cm.map, { annual: 360 });
    const f = a.cm.firstMoves.find((x) => kindKey(a.cm, x) === "ad_permside")!;
    // 全部可 → 2027 年 2 月の判断: 副業の顧客を 1 社増やす（読める）と 今のまま（まとめた手）
    const vm = pathVM(a, a.cm.map.indexOfKey("r.ad_permside.a"), text);
    const s1 = vm.steps[1]!;
    expect(s1.options.map((o) => o.stub)).toEqual([false, true]);
    expect(s1.optionGroups.map((g) => g.head)).toEqual(["この先も 3 か月ごとに読める手", "この先は 2029 年 11 月まで標準の続きの見積もりの手"]);
    expect(s1.altOptionsText).toBe("ほかの手 1（どれも先は見積もり）");
    void f;
  });

  it("道の 3 年の合計の位置は、今日の手の分布と同じ重みで数える（真ん中あたりの道は本当の行き先）", () => {
    for (const make of [handTree, () => randomTree(2), () => randomTree(3, 1500)]) {
      const a = analyze(compileMap(fromDevTree(make())), 360);
      const ov = overview(a);
      for (const mv of ov.moves) {
        if (!mv.dist) continue;
        const e = endsFrom(a, mv.node);
        expect(e.mass.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 9);
        const pl = placeIn(e, mv.dist.p50)!;
        expect(pl.p10).toBeCloseTo(mv.dist.p10, 9);
        expect(pl.p50).toBeCloseTo(mv.dist.p50, 9);
        expect(pl.p90).toBeCloseTo(mv.dist.p90, 9);
        expect(pl.mean).toBeCloseTo(mv.dist.mean, 9);
        const m = medianEnd(a, mv.node);
        if (m) expect(a.cm.flags[m.node]! & 4).toBe(0);
      }
    }
    expect(placeText(0.04)).toBe("低い方から 1 割未満");
    expect(placeText(0.124)).toBe("低い方から約 1 割");
    expect(placeText(0.5)).toBe("真ん中あたり");
    expect(placeText(0.81)).toBe("高い方から約 2 割");
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

describe("仮の文章・まとめた場合の数・地図の数の入れ直し", () => {
  /** 手で作った地図の 1 つの状態を、いくつかの場合をまとめた結果（顧客 0〜1 社・平均 0.4 社）にする */
  function bandedTree(): DevTree {
    const t = handTree();
    const find = (n: DevTreeNode, k: string): DevTreeNode | null => (n.k === k ? n : (n.kids ?? []).reduce<DevTreeNode | null>((x, c) => x ?? find(c, k), null));
    const cl1 = find(t.root, "r.ad_permside.a.1as.cl1")!;
    cl1.st = { ...cl1.st, cl: 0.4 };
    cl1.band = { cl: [0, 1] };
    // 行き先の 1 つも（顧客 1〜2 社・平均 1.55 社）
    const end = find(t.root, "r.ad_permside.a.1as.cl1.2am.cl2")!;
    end.st = { ...end.st, cl: 1.55 };
    end.band = { cl: [1, 2] };
    return t;
  }

  it("いくつかの場合をまとめた結果は顧客の数を幅で書き、丸めた 1 つの数を出さない。行き先の種類も数字の行と食い違わない（作業メモ truth-3）", () => {
    const map = fromDevTree(bandedTree());
    const text = fallbackText(map, { annual: 360 });
    const cl1 = map.indexOfKey("r.ad_permside.a.1as.cl1");
    const nums = text.numbers(cl1).join("\n");
    expect(nums).toContain("広告運用 0〜1 社（いくつかの場合をまとめた道。月");
    expect(nums).not.toMatch(/広告運用 [01] 社/);
    const e = map.indexOfKey("r.ad_permside.a.1as.cl1.2am.cl2");
    expect(text.numbers(e).join("\n")).toContain("広告運用 1〜2 社");
    // 1 枚の行き先の名前は幅のまま・行き先の種類は多い方の見込み（平均 − 下の数）で 2 つに分ける
    expect(destLabel(destClassOf(map.st(e), null, map.band(e)))).toContain("顧客 1〜2 社");
    const parts = destParts(map.st(e), null, map.band(e));
    expect(parts.map((p) => [destLabel(p.cls), Math.round(p.w * 100)])).toEqual([
      [expect.stringContaining("顧客 1 社"), 45],
      [expect.stringContaining("顧客 2 社"), 55],
    ]);
    expect(parts.every((p) => p.merged)).toBe(true);
    // 行き先のまとめ: 分けた行き先は両方の種類に入り、merged に出る
    const a = analyze(compileMap(map), 360);
    const f = a.cm.firstMoves.find((x) => kindKey(a.cm, x) === "ad_permside")!;
    const g = destinations(a, f);
    expect(g.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 9);
    const two = g.find((x) => x.label.includes("顧客 2 社"))!;
    expect(two.ends).toContain(e);
    expect(two.merged).toBeGreaterThan(0);
    // 開発用の木の端数（幅の書いていない平均）は「平均 0.4 社」と書く
    const t2 = handTree();
    const n2 = t2.root.kids![0]!.kids![0]!.kids![0]!.kids![0]!;
    n2.st = { ...n2.st, cl: 0.4 };
    const m2 = fromDevTree(t2);
    expect(fallbackText(m2, { annual: 360 }).numbers(m2.indexOfKey(n2.k)).join("\n")).toContain("広告運用 平均 0.4 社");
  });

  it("仮の文章: 仮と印を付け、行の見出しを繰り返さず、0 か月目から数える判断の線の文と「結果は 1 つ」を出さない（作業メモ user-4）", () => {
    const a = handAnalysis();
    const map = a.cm.map;
    const text = fallbackText(map, { annual: 360 });
    expect(text.provisional).toBe(true);
    for (let i = 0; i < map.n; i++) {
      const b = text.body(i);
      expect(b).not.toContain("（この手の結果は 1 つ）");
      if (map.role(i) !== "a" && map.role(i) !== "r") expect(b).not.toContain(map.line(i));
      // まとめた行き先は年月を頭に付けない
      if (map.sum(i)) expect(b).toMatch(/^標準の選び方で 2029 年 11 月まで続けた多くの道の平均/);
      // まとめた行き先の数は丸めて「約」
      if (map.sum(i)) expect(text.numbers(i).join("\n")).not.toMatch(/\d,\d{3} 円/);
    }
    // 状態の本文は 3 か月前からの変わり
    const s = map.indexOfKey("r.ad_permside.a");
    expect(text.body(s)).toMatch(/^2026 年 11 月から(変わった所|大きな変わりは無い)/);
    // 手の本文は結果ごとの月の稼ぎ
    expect(text.body(map.indexOfKey("r.ad_permside"))).toMatch(/^結果ごとの 2027 年 2 月の月の稼ぎ（2026 年 11 月は [\d.]+ 万円）: 全部可 [\d.]+ 万円・SpellDash だけ [\d.]+ 万円・どちらも不可 [\d.]+ 万円。$/);
  });

  it("数を入れ直すと地図も新しい物に替わり、前の計算は使えない（作業メモ code-3）", () => {
    const t1 = handTree();
    const m1 = fromDevTree(t1);
    const cm = compileMap(m1);
    const before = analyze(cm, 360);
    // 別の物（深く写した木）: 名前・never・cont・稼ぎを変える
    const t2 = structuredClone(t1);
    const ap = t2.root.kids!.find((k) => k.k === "r.ad_permside")!;
    ap.kids![0]!.lab = "新しい名前";
    t2.header.never = { ...t2.header.never, side: [30, 2, 3] };
    const stub = ap.kids![0]!.kids![0]!.kids![0]!.kids![0]!.kids![0]!;
    stub.cont = [{ m: 9, kind: "ad_side" }];
    const leaf = t2.root.kids!.find((k) => k.k === "r.keep")!.kids![0]!.kids!.find((k) => k.k === "r.keep.all.1k")!.kids![0]!.kids![0]!.kids![0]!;
    leaf.e = [31.6, 0, -9];
    const m2 = fromDevTree(t2);
    refillNumbers(cm, m2);
    expect(cm.map).toBe(m2);
    // 前の計算は止まる
    expect(() => overview(before)).toThrow(/古い計算/);
    expect(() => overviewVM(before)).toThrow(/古い計算/);
    expect(() => pathVM(before, 0, fallbackText(m2, { annual: 360 }))).toThrow(/古い計算/);
    // 新しい計算は新しい地図の名前・never・cont・数
    const after = analyze(cm, 360);
    const ov = overview(after);
    const apMove = ov.moves.find((m) => m.kind === "ad_permside")!;
    expect(apMove.outcomes[0]!.label).toBe("新しい名前");
    expect(apMove.worth).toBeCloseTo(37 + 10 + 3 - (30 + 2 + 3) + (37 - 30) * (360 / 12 - 1), 6);
    expect(after.vSQ! - before.vSQ!).toBeCloseTo(30, 9);
    const sp = pathVM(after, m2.indexOfKey(stub.k), fallbackText(m2, { annual: 360 }));
    expect(sp.items.filter((x) => x.type === "light" && !x.head).map((x) => (x.type === "light" ? x.title : ""))).toEqual(["副業の顧客を 1 社増やす"]);
  });
});
