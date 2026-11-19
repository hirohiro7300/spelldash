// 生成 v2・試し版 v2 の見直し（読み手 reader-*・事実 truth-*・コード code-1）の直しの確かめ（小さい木 tests/fixtures/q-small.* と手で作った木）。
// どれも、見直しで見つかった食い違いが、組み立てた文章・画面の形・点検で起きないことを確かめる（点検は、わざと食い違えた文章で落ちることも）

import { describe, expect, it } from "vitest";
import { checkQuarterSal } from "../../scripts/impact/q/check";
import { DEFAULTS } from "../../scripts/impact/q/gen";
import { runTextChecks } from "../../scripts/impact/textChecks";
import { analyze, CHECKED_ANNUALS, compileMap, countsOf, mixLabel, textRuntime, type Analysis } from "../../src/deepmap/core";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";
import type { DevTree, DevTreeNode, MapData, MapMix } from "../../src/deepmap/mapData";
import { condText, moveDetailVM, notesVM, num, overviewVM, pathVM, SMALL_DELTA_TEXT } from "../../src/deepmap/views";
import { BANKS, composeCard, composeCont, quarterSal } from "../../src/demo/compose";
import { adviceKindIssues, exactIssues, listNameOf, ordinalIssues, recommendIssues } from "../../src/demo/compose/checks";
import { calendarOf, clBand } from "../../src/demo/compose/path";
import { f2, n0 } from "../../src/demo/compose/text";
import { bakedMatches, composedText, composeStats, textSkew } from "../../src/preview/composeText";
import { TREE } from "./composeFixture";
import { loadQSmall } from "./helpers/qSmall";

const memo = new Map<string, Analysis>();
async function qs(annual: number): Promise<{ map: MapData; a: Analysis }> {
  const map = await loadQSmall();
  const k = String(annual);
  let a = memo.get(k);
  if (!a) memo.set(k, (a = analyze(compileMap(map), annual)));
  return { map, a };
}
const all = (map: MapData): number[] => [...Array(map.n).keys()];

describe("生成 v2 の見直しの直し（文章）", () => {
  it("reader-1: まとめた手の結果の給与は、その 3 か月の給与（広げた同じ手の結果と同じ式）で言い、3 年後の平均を移る先の給与と言わない", async () => {
    const map = await loadQSmall();
    const cal = calendarOf(map.header);
    // 式は広げた手のどの結果の給与とも合う（生成の点検 Q1）
    const q1 = checkQuarterSal(map);
    expect(q1.fails).toEqual([]);
    expect(q1.checked).toBeGreaterThan(50);
    let said = 0;
    let differs = 0;
    for (const a of all(map)) {
      if (map.role(a) !== "a" || !map.stub(a) || !/^(fc_switch|fc_switch2|fc_push)$/.test(map.kind(a) ?? "") || map.childCount(a) < 2) continue;
      for (const annual of [360, 540]) {
        const body = composeCard(map, a, { annual }).body;
        for (let k = 0; k < map.childCount(a); k++) {
          const o = map.child(a, k);
          const id = map.outId(o);
          const want = (id === "high_mid" ? [quarterSal(map, BANKS.C, cal, a, "high"), quarterSal(map, BANKS.C, cal, a, "mid")] : [quarterSal(map, BANKS.C, cal, a, id)]).filter((x): x is number => x !== null);
          const at = body.indexOf(`『${map.label(o)}』なら`);
          if (at < 0) continue;
          const seg = body.slice(at).split("。")[0]!;
          for (const m of seg.matchAll(/今日の ([0-9.]+) 倍/g)) {
            said++;
            expect(want.map(f2), `${map.key(o)}: ${seg}`).toContain(m[1]);
            if (!want.some((x) => f2(x) === f2(map.rr(o)[0]))) {
              differs++;
              expect(m[1], `${map.key(o)}: 3 年後の平均を言う`).not.toBe(f2(map.rr(o)[0]));
            }
          }
          for (const m of seg.matchAll(/年収 ([0-9,]+) 万円/g)) expect(want.map((x) => n0(annual * x))).toContain(m[1]);
        }
      }
    }
    expect(said).toBeGreaterThan(10);
    expect(differs).toBeGreaterThan(0);
  });

  it("reader-3: 応募を続ける助言は、次の判断に転職活動の続きが並ぶときだけ（並ばなければ続ける手を勧めない）", async () => {
    const { map, a } = await qs(360);
    const rt = textRuntime(a);
    let tips = 0;
    for (const i of all(map)) {
      if (map.role(i) !== "s") continue;
      const body = composeCard(map, i, { annual: 360, rt }).body;
      expect(adviceKindIssues(map, i, body), `${map.key(i)}: ${body}`).toEqual([]);
      if (/応募を続ければ|決まらなかった応募先の返事は書き残しておく/.test(body)) tips++;
    }
    expect(tips).toBeGreaterThan(0);
    // わざと勧めた文は見つける
    const noNext = all(map).find((i) => map.role(i) === "s" && map.childCount(i) > 0 && ![...Array(map.childCount(i)).keys()].some((k) => /^fc_switch2?$/.test(map.kind(map.child(i, k)) ?? "")))!;
    expect(adviceKindIssues(map, noNext, "応募を続ければ、次の 3 か月にも決まる目がある。")).toHaveLength(1);
  });

  it("reader-4・truth-4: 今日の手の本文は、手の詳しい画面と同じ行き先の 2 つの数と 3 年の合計の平均を、名前と見積もり方を付けて言う", async () => {
    for (const annual of [360, 540]) {
      const { map, a } = await qs(annual);
      const rt = textRuntime(a);
      for (const f of a.cm.firstMoves) {
        if (map.isBase(f)) continue;
        const body = composeCard(map, f, { annual, rt }).body;
        const c = countsOf(a, f, a.pi.reachIn);
        expect(body).toContain(`地図にある行き先は ${n0(c.ends)}（うち標準の続きの見積もり ${n0(c.sumEnds)}）で、一番良い選び方で着くのは ${n0(c.reachEnds)}（そのうち見込み 1 分以上は ${n0(c.reachEnds1)}）`);
        const d = moveDetailVM(a, f);
        expect(d.facts).toContain(`2029 年 11 月の行き先: 地図にある ${num(c.ends)}（うち標準の続きの見積もり ${num(c.sumEnds)}）・一番良い選び方で着く ${num(c.reachEnds)}（見込み 1% 以上 ${num(c.reachEnds1)}）`);
        // 3 年の合計: 本文は見積もり方を言い、一番良い選び方の平均は手の詳しい画面と同じ数
        expect(body).toContain("その後を標準の選び方で続けた見積もりで");
        const mean = /その後を一番良い選び方で進めば、平均 ([0-9,.]+) 万円/.exec(body);
        expect(mean, body).not.toBeNull();
        expect(d.facts[0]).toContain(`平均 ${mean![1]} 万円`);
      }
    }
  });

  it("reader-5: 結果の名前に「・」を使わず、並びは「、」・同じ答えを分けた結果はまとめて言う。全部可を 1 社目で分けた結果の題と文はそれを言う", async () => {
    const { map, a } = await qs(360);
    for (const i of all(map)) if (map.role(i) !== "a" && map.role(i) !== "r") expect(map.label(i), map.key(i)).not.toContain("・");
    const a1 = map.indexOfKey("r.ad_permside.a1");
    const a0 = map.indexOfKey("r.ad_permside.a0");
    expect([map.label(a1), map.label(a0)]).toEqual(["全部可（1 社目あり）", "全部可（顧客まだ）"]);
    expect(map.title(a1)).toContain("1 社目");
    expect(map.title(a0)).toContain("顧客はまだ");
    expect(composeCard(map, a0, { annual: 360 }).body).toMatch(/副業の 1 社目は(?:この 3 か月では)?まだ決まっていない/);
    // 進め方の理由: 同じ答えを分けた 2 つの結果は答えの名前 1 つに、ほかの結果とは「か」で
    expect(condText(a, { m: 3, back: 0, byMove: false, cover: 1, items: [{ fromKind: "ad_permside", mFrom: 0, labels: ["全部可（顧客まだ）", "全部可（1 社目あり）"], all: false, share: 1 }] })).toBe("2027 年 2 月に全部可なら");
    expect(condText(a, { m: 3, back: 0, byMove: false, cover: 1, items: [{ fromKind: "ad_permside", mFrom: 0, labels: ["SpellDash だけ", "全部可（1 社目あり）"], all: false, share: 1 }] })).toBe("2027 年 2 月に SpellDash だけか全部可（1 社目あり）なら");
    // 道の行のほかの結果は「、」でつなぐ
    const pv = pathVM(a, a1, composedText(map, 360, a));
    expect(pv.steps[0]!.altOutcomesText).toMatch(/^[^・]+ [0-9]+%(?:、[^・]+ [0-9]+%)+$/);
    expect(pv.steps[0]!.altOutcomesText).toContain("全部可（顧客まだ）");
  });

  it("reader-7: まとめた行き先の後の期の文章は、決まった注を繰り返さず、手引きの文を 3 つまでと分かれ目を言う（点検にもかける）", async () => {
    const { map, a } = await qs(360);
    const rt = textRuntime(a);
    let rows = 0;
    let watch = 0;
    let acts = 0;
    for (const i of all(map)) {
      if (map.role(i) !== "e" || !map.sum(i)) continue;
      for (let k = 0; k < (map.cont(i)?.length ?? 0); k++) {
        const c = composeCont(map, i, k, { annual: 360, rt })!;
        rows++;
        expect(c.body).not.toContain("分かれ道は開いていない");
        if (/^(?:見る数は|分かれ目は|答えが出るのは|その先は)|。(?:見る数は|分かれ目は|答えが出るのは|その先は)|で道が分かれる。/.test(c.body)) watch++;
        acts += c.todo.length;
      }
    }
    expect(rows).toBeGreaterThan(100);
    expect(watch).toBeGreaterThan(rows / 4);
    expect(acts / rows).toBeGreaterThan(1.5);
    // 道の画面の見積もりの印の行が 1 回だけ言う
    const sumEnd = all(map).find((i) => map.role(i) === "e" && map.sum(i) && (map.cont(i)?.length ?? 0) > 2)!;
    const head = pathVM(a, sumEnd, composedText(map, 360, a)).items.find((x) => x.type === "light" && x.head);
    expect(head && head.type === "light" ? head.note : "").toContain("どの期も分かれ道は開いていない");
    // 文章の点検は、標準の続きの期も道の続きとして見る
    const rep = runTextChecks(map, { annuals: [360] });
    expect(rep.failures, rep.failures.join("\n")).toEqual([]);
    expect(rep.runs[0]!.contRows).toBe(rows);
  });

  it("truth-1・reader-8: 本文の「おすすめ」は画面のおすすめ（その年収の一番良い選び方の手）で、おすすめより多い手は訳を言う", async () => {
    let explained = 0;
    for (const annual of [360, 540]) {
      const { map, a } = await qs(annual);
      const rt = textRuntime(a);
      for (const i of all(map)) {
        if (map.role(i) !== "a" || map.role(map.parent(i)) === "r") continue;
        const body = composeCard(map, i, { annual, rt }).body;
        expect(recommendIssues(map, i, body, (d) => rt.recommended(d)), `${annual} ${map.key(i)}: ${body}`).toEqual([]);
        if (/見積もりではおすすめの『[^』]*』より [0-9.,]+ 万円多いが、その後の選び直しまで入れると/.test(body)) explained++;
      }
    }
    expect(explained).toBeGreaterThan(0);
    // わざと食い違えた文は見つける
    const { map, a } = await qs(540);
    const rt = textRuntime(a);
    const d = all(map).find((x) => map.role(x) === "s" && rt.recommended(x) >= 0 && map.childCount(x) >= 2)!;
    const pi = rt.recommended(d);
    const other = [...Array(map.childCount(d)).keys()].map((k) => map.child(d, k)).find((x) => x !== pi)!;
    expect(recommendIssues(map, other, `この手で進むと…（おすすめの『${listNameOf(map, pi)}』より 2.8 万円多い）。`, (x) => rt.recommended(x))).toHaveLength(1);
    expect(recommendIssues(map, other, `この手で進むと…（おすすめの『ほかの手』より 2.8 万円少ない）。`, (x) => rt.recommended(x))).toHaveLength(1);
    expect(recommendIssues(map, pi, "この手で進むと、ここから…（今のままより 3 万円多い）。", (x) => rt.recommended(x))).toHaveLength(1);
  });

  it("truth-2: 社数が 1 つに決まった結果を、まとめた結果や幅と言わない（点検 C2 が見つける）", async () => {
    const { map, a } = await qs(360);
    const rt = textRuntime(a);
    for (const i of all(map)) {
      if (map.role(i) !== "s" || map.sum(i)) continue;
      const c = composeCard(map, i, { annual: 360, rt });
      expect(exactIssues(map, i, c.body, c.title), `${map.key(i)}: ${c.title} / ${c.body}`).toEqual([]);
    }
    const exact = all(map).find((i) => map.role(i) === "s" && !map.sum(i) && clBand(map, i)[0] === clBand(map, i)[1])!;
    expect(exactIssues(map, exact, "決まる場合と決まらない場合を 1 つにまとめた見積もりで、顧客は 0 社の幅になる。", "顧客は今回も 0 社の幅")).toHaveLength(3);
    const banded = all(map).find((i) => map.role(i) === "s" && !map.sum(i) && clBand(map, i)[0] < clBand(map, i)[1] && !!map.band(i)?.cl);
    if (banded !== undefined) expect(exactIssues(map, banded, "決まる場合と決まらない場合を 1 つにまとめた見積もりで、顧客は 0〜2 社の幅になる。", "顧客は 0〜2 社の幅")).toEqual([]);
  });

  it("truth-3: 社数の違う場合をまとめた幅の判断では、手が「N 社目」と言わない（点検 C2 が見つける）", async () => {
    const { map, a } = await qs(360);
    const rt = textRuntime(a);
    let bandMoves = 0;
    for (const i of all(map)) {
      if (map.role(i) !== "a" || !/^ad_(side|more)$/.test(map.kind(i) ?? "")) continue;
      const c = composeCard(map, i, { annual: 360, rt });
      expect(ordinalIssues(map, map.parent(i), `${c.body}。${c.title}`), `${map.key(i)}: ${c.title} / ${c.body}`).toEqual([]);
      const [lo, hi] = clBand(map, map.parent(i));
      if (lo !== hi) bandMoves++;
    }
    expect(bandMoves).toBeGreaterThan(0);
    const banded = all(map).find((i) => map.role(i) === "s" && clBand(map, i)[0] < clBand(map, i)[1])!;
    expect(ordinalIssues(map, banded, "副業の 2 社目を探す。")).toHaveLength(1);
    // 『』の中（手や結果の名前）は数えない
    expect(ordinalIssues(map, banded, "『届け出て副業の 1 社目を探す』とほぼ同じ。")).toEqual([]);
  });

  it("truth-6: 次の判断は、並ぶ手の数を言い、おすすめの手とほかの手を全部言う（5 つの手の判断でも落とさない。0.8 からは差つき）", async () => {
    const { map, a } = await qs(360);
    const rt = textRuntime(a);
    let wide = 0;
    for (const i of all(map)) {
      if (map.role(i) !== "s" || !map.childCount(i)) continue;
      const kids = Array.from({ length: map.childCount(i) }, (_, k) => map.child(i, k));
      if (!kids.some((x) => map.kind(x) !== "keep")) continue;
      const body = composeCard(map, i, { annual: 360, rt }).body;
      const sents = body.split("。");
      const head = sents.findIndex((x) => /^(?:[0-9]+ 年 [0-9]+ 月までの手は [0-9]+ つで|次の 3 か月に選べる [0-9]+ つの手のうち|ここで選べる手は [0-9]+ つあり)/.test(x));
      expect(head, `${map.key(i)}: ${body}`).toBeGreaterThanOrEqual(0);
      expect(Number(/([0-9]+) つ/.exec(sents[head]!)![1]), sents[head]).toBe(kids.length);
      // おすすめは画面のおすすめと同じ手で、ほかの手は次の文が全部言う（名前は地図の名前か短い名前）
      const rec = rt.recommended(i);
      expect(sents[head], `${map.key(i)}`).toContain(`『${rec >= 0 && map.isBase(rec) ? "この 3 か月は今のまま" : (map.header.kinds[map.kind(rec)!]?.[0] ?? "")}』`);
      const rest = sents[head + 1] ?? "";
      for (const x of kids) {
        if (x === rec) continue;
        const names = map.isBase(x) ? ["今のまま"] : [map.header.kinds[map.kind(x)!]![0], BANKS.short[map.kind(x)!]!];
        expect(names.some((nm) => rest.includes(`『${nm}』`)), `${map.key(i)} ${map.kind(x)}: ${rest}`).toBe(true);
      }
      if (kids.length >= 4) wide++;
    }
    expect(wide).toBeGreaterThan(0);
  });

  it("truth-7: 幅が 1 点でも平均が整数でない結果は、数の行で社数の幅と平均の売上で言う", () => {
    const tree = structuredClone(TREE) as DevTree;
    let target: DevTreeNode | null = null;
    const walk = (n: DevTreeNode): void => {
      if (!target && n.r === "s" && (n.st.cl ?? 0) >= 0.5 && n.kids?.length) target = n;
      for (const k of n.kids ?? []) walk(k);
    };
    walk(tree.root);
    expect(target).not.toBeNull();
    const t = target! as DevTreeNode;
    t.st = { ...t.st, cl: 0.909, fee: 3 };
    t.band = { cl: [1, 1] };
    const map = fromDevTree(tree);
    const i = map.indexOfKey(t.k);
    const nums = composeCard(map, i, { annual: 360 }).numbers.join(" / ");
    expect(nums).toContain("広告運用 0 社か 1 社（平均 月 2.7 万円）");
    expect(nums).not.toMatch(/広告運用 1 社（売上/);
  });

  it("reader-11: 行き先の結びは、何も変えなかった結果（据え置き・決まらない）の 3 か月を一番の動きと言わない", async () => {
    const { map, a } = await qs(360);
    const rt = textRuntime(a);
    let levers = 0;
    for (const i of all(map)) {
      if (map.role(i) !== "e" || map.sum(i)) continue;
      const body = composeCard(map, i, { annual: 360, rt }).body;
      const lv = /一番大きく動かしたのは、([0-9]{4}) 年 ([0-9]{1,2}) 月までの『([^』]*)』(?:の 3 か月)?で/.exec(body);
      if (!lv) continue;
      levers++;
      const m = calendarOf(map.header).monthOf(Number(lv[1]), Number(lv[2]));
      for (let x = i; x > 0; x = map.parent(map.parent(x))) {
        if (map.month(x) !== m) continue;
        expect(["same", "none", "no", "n"].includes(map.outId(x)) && map.childCount(map.parent(x)) >= 2, `${map.key(x)}: ${lv[0]}`).toBe(false);
        break;
      }
    }
    expect(levers).toBeGreaterThan(0);
  });
});

describe("生成 v2 の見直しの直し（画面）", () => {
  it("reader-2: 手の詳しい画面の「この手の分」は「今やる vs 3 か月待つ」の札と同じ数。差 5 万円未満の注は、その数が 5 万円未満のときだけ", async () => {
    for (const annual of [360, 540]) {
      const { a } = await qs(annual);
      for (const r of overviewVM(a).rows) {
        if (r.isBase || !r.delta) continue;
        const d = moveDetailVM(a, r.node);
        const split = d.facts.find((x) => x.includes("＝ この手の分"))!;
        expect(split, r.kind).toContain(`この手の分 ${r.delta.text}`);
        expect(split).not.toMatch(/札|地図の値/);
        const note = r.decides.kind === "reveal" || r.decides.kind === "outcomes" || r.decides.kind === "plain" ? r.decides.note : null;
        if (note === SMALL_DELTA_TEXT) expect(Math.abs(Number(r.delta.text.replace(/[^0-9.]/g, "")))).toBeLessThan(5);
      }
    }
  });

  it("reader-6: まとめた行き先の見出しは中身の幅から（9 割がそろう事実だけを言い切る）", async () => {
    const mix: MapMix = { j: { e: 0.95, p: 0, i: 0.05 }, pm: { "?": 0.01, a: 0.4, s: 0.49, n: 0.1 }, pro: 0.6, switched: 0.3, school: 0, cl: [0, 1, 2], pu: [0, 36, 44], mau: [700, 900, 1100], sal: [1.1, 1.2, 1.3] };
    expect(mixLabel(mix)).toBe("会社員・届け出の答えは道で違う・顧客 0〜2 社・Pro ありの道が多い");
    expect(mixLabel({ ...mix, j: { e: 0.2, p: 0, i: 0.8 }, cl: [0, 0, 0], pro: 0.05 })).toBe("独立の道が多い・届け出の答えは道で違う・副業なし・Pro なし");
    expect(mixLabel({ ...mix, pm: { "?": 0, a: 0, s: 0.95, n: 0.05 }, pro: 0.95, pu: [31, 50, 80] })).toBe("会社員・SpellDash だけ可・顧客 0〜2 社・有料 31〜80 人");
    // 道の画面の着いた所も
    const { map, a } = await qs(360);
    const end = all(map).find((i) => map.role(i) === "e" && map.sum(i) && map.mix(i))!;
    const pv = pathVM(a, end, composedText(map, 360, a));
    expect(pv.end.cls).toBe(mixLabel(map.mix(end)!));
  });

  it("truth-8: 手の結果の見出しは、結果の状態の月を「の時点」と書く（答えが届く月は本文が言う）", async () => {
    const { map, a } = await qs(360);
    const f = a.cm.firstMoves.find((x) => map.kind(x) === "ad_permside")!;
    expect(moveDetailVM(a, f).outcomesHead).toBe("会社の答え（2027 年 2 月の時点）");
    const pv = pathVM(a, f, composedText(map, 360, a));
    expect(pv.steps[0]!.outcomesHead).toBe("この手の結果（2027 年 2 月の時点・この道との 3 年の合計の差）");
  });

  it("truth-5: 地図の深さを確かめた年収は生成の一貫性の年収と同じで、見方に書く", async () => {
    expect([...CHECKED_ANNUALS]).toEqual([...DEFAULTS.annuals]);
    const { a } = await qs(360);
    expect(notesVM(a, "q", true).howTo.join("\n")).toContain("地図の深さは年収 360〜540 万円で確かめた");
  });

  it("reader-12: 見方は、値打ちが一番良い選び方どうしで使える場合と使えない場合を比べた差だと言う", async () => {
    const { a } = await qs(360);
    const line = notesVM(a, "q", true).howTo.find((x) => x.startsWith("この種類が使えることの値打ち:"))!;
    expect(line).toContain("一番良い選び方どうしで");
    expect(line).toContain("使えないと減る分");
  });
});

describe("生成 v2 の見直しの直し（試し版の文章の版。code-1）", () => {
  it("焼き込んだ文の型の版が組み立てと同じ地図は、題・短い名前を焼き込みから。版が違えば知らせる", async () => {
    const map = await loadQSmall();
    expect(map.header.textVersion).toBe(BANKS.version);
    expect(bakedMatches(map)).toBe(true);
    expect(composeStats.banks).toBe(BANKS.version);
    const t = composedText(map, 360);
    const i = map.indexOfKey("r.ad_permside.a1");
    expect(t.title(i)).toBe(map.title(i));
    expect(textSkew(map.header.textVersion)).toBeNull();
    expect(textSkew("dev")).toBeNull();
    expect(textSkew("")).toBeNull();
    expect(textSkew("0.5")).toContain(`0.5 が、組み立ての版 ${BANKS.version} と違う`);
  });
});
