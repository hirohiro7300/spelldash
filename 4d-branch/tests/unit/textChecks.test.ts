import { describe, expect, it } from "vitest";
import { bankSpacing, cli, fixtureGolden, goldenMarkdown, goldenPaths, joinsRow, likeliest, mask, ownDateAgain, recommended, reportMarkdown, runTextChecks, sentencesOf, skeleton, spacingIssues, TEXT_CHECKS, TEXT_GATES } from "../../scripts/impact/textChecks";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";
import type { DevTree, DevTreeNode } from "../../src/deepmap/mapData";
import { BANKS, type Banks } from "../../src/demo/compose";
import { mergedIssues, moveClaims, pathContext, searchQuarters, sumClientIssues } from "../../src/demo/compose/checks";
import { calendarOf } from "../../src/demo/compose/path";
import golden from "./composeGolden.json";
import { header, move, out, RULES, st, TREE } from "./composeFixture";

// 文章の点検（SPEC v1 §4.6）と道の見本（§4.7）。8 万枚の木での測り方は scripts/impact/runTextChecks.mjs（ここでは手で作った小さな地図だけ）

/** 束を書き換えて使う（BANKS は凍らせてあるので写す） */
const editBanks = (f: (b: Banks) => void): Banks => {
  const b = structuredClone(BANKS) as Banks;
  f(b);
  return b;
};

describe("文章の点検（scripts/impact/textChecks.ts）", () => {
  it("手で作った 2 つの地図は、年収 360 と 540 で止める点検がどれも通る", () => {
    for (const tree of [TREE, RULES]) {
      const rep = runTextChecks(fromDevTree(tree));
      expect(rep.failures, rep.failures.join("\n")).toEqual([]);
      expect(rep.ok).toBe(true);
      expect(rep.runs.map((r) => r.annual)).toEqual([360, 540]);
      for (const r of rep.runs) {
        expect(Object.keys(r.lengths).sort()).toEqual(["a", "e", "first", "r", "s"]);
        expect(r.pathRepeats.paths).toBeGreaterThan(0);
        expect(r.pathRepeats.dist.max).toBeLessThanOrEqual(TEXT_GATES.pathRepeats);
        // 同じ手が続く期をまとめた数は、まとめない数より多くならない
        expect(r.pathRepeats.dist.max).toBeLessThanOrEqual(r.pathRepeats.raw.max);
        expect(r.siblings.moveSame + r.siblings.outSame + r.siblings.titleSame).toBe(0);
        expect(r.ms.perCardUs).toBeGreaterThan(0);
      }
    }
  });

  it("点検の名前は SPEC §4.6 の C1〜C10 と C4b・T4、見直しで足した C11（手が言う額と数）・C12（道の歩み）。D はデータの指摘で止めない", () => {
    expect(TEXT_CHECKS.map((c) => c.id)).toEqual(["C1", "C1b", "C2", "C3", "C4", "C4b", "C5", "C5b", "C6", "C7", "C8", "C9", "C10", "C11", "C12", "T4", "D1", "D2"]);
    expect(TEXT_CHECKS.filter((c) => !c.block).map((c) => c.id)).toEqual(["D1", "D2"]);
    expect(TEXT_GATES).toEqual({ pathRepeats: 4, siblingSame: 0, decisionRepeats: 1 });
  });

  it("束に混ぜた誤り（手書きの数字・%・英数字の名前・給与の月額の言い方・差し込みの隣の空白）を、点検の名前ごとに数えて止める", () => {
    const bad = editBanks((b) => {
      b.lead.keep = [{ v: ["{period}は keep_all のまま 15 % の余裕で続ける。給与は 月 30.9 万円。"] }];
      b.cal.APRIL = [{ v: ["4 月は {ym} の昇給の月。"] }];
    });
    const rep = runTextChecks(fromDevTree(TREE), { banks: bad, annuals: [360] });
    expect(rep.ok).toBe(false);
    const ids = new Set(rep.runs[0]!.checks.map((c) => c.id));
    for (const id of ["C1", "C4", "C4b", "C10"]) expect(ids.has(id as never), id).toBe(true);
    expect(rep.bank.map((c) => c.id)).toContain("C8");
    expect(rep.failures.some((x) => x.startsWith("C4b "))).toBe(true);
    // 例は説明ごとに 1 つ・決まった数まで
    for (const c of rep.runs[0]!.checks) expect(c.examples.length).toBeLessThanOrEqual(5);
  });

  it("C6・T4: 数だけ違う名前の兄弟が同じ状態なら、本文の骨組みが同じ（兄弟の題は言い分ける）", () => {
    // 届け出は SpellDash だけ可（3 年後の一言の言い換えが 1 つ）・2 つの結果は名前の数だけが違い、状態も月の稼ぎも同じ
    const s = st({ pm: "s", pro: 1, mau: 300, pu: 10 });
    const twin = (id: string, lab: string): DevTreeNode => out(`r.x.${id}`, 36, s, id, 50, lab, ["pu", 36, null, null], [3, 0, 3], [1, 0, 0.6]);
    const tree: DevTree = { header, root: { k: "r", r: "r", m: 0, st: st(), rr: [1, 0, -0.3], kids: [move("r.x", "sd_retain", 33, s, [twin("pu1", "有料 1 人"), twin("pu2", "有料 2 人")])] } };
    const rep = runTextChecks(fromDevTree(tree), { annuals: [360] });
    const c6 = rep.runs[0]!.checks.find((c) => c.id === "C6");
    expect(c6?.n).toBe(1);
    expect(rep.runs[0]!.siblings.outSame).toBe(1);
    expect(rep.runs[0]!.siblings.titleSame).toBe(0);
  });

  it("C6: 道の繰り返しの門は、道の画面と同じまとめ方で数える（門を 0 にすると、手で作った地図でも止まる。code-2）", () => {
    // TREE は今のままが 12 期続く道（結果が 1 つの同じ手が続く）で、まとめない数は多いが、まとめると 0
    const tree = runTextChecks(fromDevTree(TREE), { annuals: [360] }).runs[0]!.pathRepeats;
    expect(tree.raw.max).toBeGreaterThan(TEXT_GATES.pathRepeats);
    expect(tree.dist.max).toBe(0);
    const rep = runTextChecks(fromDevTree(RULES), { annuals: [360], gates: { pathRepeats: 0 } });
    const pr = rep.runs[0]!.pathRepeats;
    expect(pr.overGate).toBeGreaterThan(0);
    expect(rep.runs[0]!.checks.find((c) => c.id === "C6")?.by.path).toBe(pr.overGate);
    expect(pr.raw.mean).toBeGreaterThanOrEqual(pr.dist.mean);
    expect(Object.values(pr.hist).reduce((a, b) => a + b, 0)).toBe(pr.paths);
  });

  it("骨組み: 数字を # にし、書き出しの年月と来た結果を受ける言葉を落とす。構造の文（次の問い・見込み・分かれ目の書き出し）は数えない", () => {
    expect(mask("2028 年 5 月、顧客が 2 社離れた")).toBe("# 年 # 月、顧客が # 社離れた");
    expect(skeleton("2028 年 5 月、顧客が 2 社離れた")).toBe("顧客が # 社離れた");
    expect(skeleton("『顧客 1 社以上』を受けて、2028 年 2 月〜4 月も顧客探しを続ける")).toBe("# 年 # 月〜# 月も顧客探しを続ける");
    for (const x of ["次の 3 か月は、転職で給与を上げるか、今のままか", "2028 年 5 月の見込みは、月に遊ぶ人は 300 人から 400 人ほど", "分かれ目は 2028 年 4 月の給与", "前の 3 か月は集客", "『顧客 2 社以上』なら売上 月 10 万円ほど、『顧客 1 社以下』なら売上 月 5 万円ほど", "2028 年 5 月"])
      expect(skeleton(x), x).toBeNull();
    expect(sentencesOf("短い。これは九文字を超える文。")).toEqual(["これは九文字を超える文"]);
  });

  it("C8: 言葉の間（月額・数の行の平均・符号・検索の言葉は決まった書き方）とカードの年月の言い直し", () => {
    expect(spacingIssues("給与は 年収 360 万円から")).toEqual(["日本語の間に空白「は 年」"]);
    expect(spacingIssues("売上 月 6.2 万円・年収 平均 400 万円・今日より −2 時間・「英単語 スペル 覚え方」で書く")).toEqual([]);
    expect(spacingIssues("2 社  増えた")).toContain("空白が 2 つ続く");
    expect(spacingIssues("増えた 。")[0]).toMatch(/句読点か括弧の隣に空白/);
    const cal = calendarOf(header);
    expect(ownDateAgain("2027 年 8 月、7 月から独立した。8 月に Pro の受付を始めた。", cal, 9)).toBe("2027 年 8 月");
    expect(ownDateAgain("2027 年 8 月、7 月から独立した。この月に Pro の受付を始めた。8 月〜10 月は続ける。", cal, 9)).toBeNull();
    expect(bankSpacing(BANKS)).toEqual([]);
    const bad = editBanks((b) => {
      b.after = [{ v: ["給与は {salYen} から。"] }];
    });
    expect(bankSpacing(bad).map((x) => x.split("」")[0])).toEqual(["C8 差し込みの前に空白「は {salYen}", "C8 差し込みの後に空白「{salYen} か"]);
  });

  it("C2: まとめた行き先の顧客の数は、平均（0.15 社以内）か中身の幅に合う整数だけ。結果の名前は数えない", () => {
    expect(sumClientIssues(1.31, null, ["3 年後の平均: 副業 1〜2 社", "広告運用 平均 1〜2 社（売上 月 6.6 万円ほど）"])).toEqual([]);
    expect(sumClientIssues(1.31, null, ["3 年後の平均: 顧客 1 社と有料 36 人"])).toHaveLength(1);
    expect(sumClientIssues(0.41, null, ["3 年後の平均: 『顧客 2 社』の後", "『顧客 2 社』の後を、標準の選び方で続けた見積もり"])).toEqual([]);
    expect(sumClientIssues(0, { cl: [1, 1.6, 2.4] }, ["広告運用 1〜2 社"])).toEqual([]);
    expect(sumClientIssues(0, { cl: [1, 1.6, 2.4] }, ["広告運用 1〜4 社"])).toHaveLength(1);
  });

  it("道の見本: 一番ありそうな道はおすすめの手と一番ありそうな結果をたどる。決まった種の道は何度作っても同じ", () => {
    const map = fromDevTree(TREE);
    const a = goldenPaths(map, { annual: 360 });
    expect(goldenPaths(map, { annual: 360 })).toEqual(a);
    const likely = a.filter((p) => p.how === "likely");
    expect(likely.map((p) => p.first)).toEqual(Array.from({ length: map.childCount(0) }, (_, k) => map.kind(map.child(0, k))));
    for (const p of likely) {
      for (let k = 1; k + 1 < p.cards.length; k += 2) {
        const mv = map.indexOfKey(p.cards[k - 1]!.k);
        const o = map.indexOfKey(p.cards[k]!.k);
        expect(o).toBe(likeliest(map, mv));
        expect(map.indexOfKey(p.cards[k + 1]!.k)).toBe(recommended(map, o));
      }
      expect(p.prob).toBeGreaterThan(0);
      expect(p.prob).toBeLessThanOrEqual(100);
    }
    // 決まった種の道は今日の手ごとに 5 本まで、どの手も同じ重みの道は 3 本まで（同じ道は数えない）
    for (const f of new Set(a.map((p) => p.first))) {
      expect(a.filter((p) => p.first === f && p.how.startsWith("random-")).length).toBeLessThanOrEqual(5);
      expect(a.filter((p) => p.first === f && p.how.startsWith("any-")).length).toBeLessThanOrEqual(3);
    }
    // どの手も同じ重みの道は、まとめた手とまとめた行き先にも行き着く（読む人が一番よく見る所を見本に入れる。reader-1）
    const any = a.filter((p) => p.how.startsWith("any-"));
    expect(any.some((p) => p.cards.some((c) => c.stub))).toBe(true);
    expect(any.some((p) => p.cards.some((c) => c.sum))).toBe(true);
    const md = goldenMarkdown(map, a, 360);
    expect(md).toContain("# 道の見本（年収 360 万円・2026-11 時点の地図");
    expect(md).toContain("一番ありそうな道（見込み");
  });

  it("道の見本（tests/unit/composeGolden.json）は、組み立て直しても同じ（文を変えたら runTextChecks.mjs --fixture-golden で作り直し、差分を見直す）", () => {
    const now = JSON.parse(fixtureGolden({ TREE, RULES })) as typeof golden;
    expect(now.textVersion).toBe(BANKS.version);
    expect(now).toEqual(golden);
  });

  it("道の画面と同じまとめ方（W-view の groupRows）: 同じ手で、どちらもまとめた手でなく、結果が 1 つか同じ名前なら 1 行（code-2）", () => {
    const row = (kind: string, single: boolean, label: string, stub = false) => ({ kind, stub, single, label });
    // 学校への提案が「見送られる」→「導入が決まる」は 2 行、会社員に戻る仕事探しが「独立のまま」→「独立のまま」は 1 行
    expect(joinsRow(row("sd_school", false, "見送られる"), row("sd_school", false, "導入が決まる"))).toBe(false);
    expect(joinsRow(row("back_emp", false, "独立のまま"), row("back_emp", false, "独立のまま"))).toBe(true);
    expect(joinsRow(row("keep", true, "どの場合も"), row("keep", true, "どの場合も"))).toBe(true);
    expect(joinsRow(row("keep", true, "どの場合も"), row("keep", true, "どの場合も", true))).toBe(false);
    expect(joinsRow(row("keep", true, "どの場合も"), row("sd_grow", true, "どの場合も"))).toBe(false);
    expect(joinsRow(null, row("keep", true, "どの場合も"))).toBe(false);
  });

  it("C2・C11・C12: まとめた結果を事実と言う・手が言う額と結果の数が違う・道の歩みと合わない文を見つける", () => {
    const rules = fromDevTree(RULES);
    const tree = fromDevTree(TREE);
    const k = (m: typeof rules, key: string): number => m.indexOfKey(key);
    const s6 = rules.indexOfKey("r.merge.0keep.all.1fc_push.all");
    expect(mergedIssues(rules, s6, "4 月の評価では昇格しなかった。", BANKS.C)).toHaveLength(1);
    expect(mergedIssues(rules, s6, "4 月の評価は、昇格した場合（3 割）と据え置きの場合をまとめた見積もり。", BANKS.C)).toEqual([]);
    const s9 = rules.indexOfKey("r.merge.0keep.all.1fc_push.all.2ad_side.all");
    expect(mergedIssues(rules, s9, "この 3 か月では新しい顧客は決まらなかった。", BANKS.C)).toHaveLength(1);
    // 次の顧客の月額（道で 3 万円）・昇格の額（結果の給与の差 26 万円）
    const ad = k(tree, "r.ad_permside.a0_a1.1ad");
    expect(moveClaims(tree, ad, "副業の 2 社目（月 5 万円）を取りにいく。", BANKS.C, 360)).toHaveLength(1);
    expect(moveClaims(tree, ad, "副業の 2 社目（月 3 万円）を取りにいく。", BANKS.C, 360)).toEqual([]);
    const fp = rules.indexOfKey("r.merge.0keep.all.1fc_push");
    expect(moveClaims(rules, fp, "昇格すれば年収が 25 万円上がる。", BANKS.C, 360)).toHaveLength(1);
    expect(moveClaims(rules, fp, "昇格すれば年収が 26 万円上がる。", BANKS.C, 360)).toEqual([]);
    // 結果ごとの売上と席
    expect(moveClaims(tree, ad, "『顧客 2 社以上』なら売上 月 6 万円ほど。", BANKS.C, 360)).toHaveLength(1);
    const ss = rules.indexOfKey("r.fee.0part.p.1keep.all.2ad_side.cl4.3sd_school");
    expect(moveClaims(rules, ss, "『導入が決まる』なら 44 席分の売上が加わる。", BANKS.C, 360)).toHaveLength(1);
    // 道の歩み: 転職活動の期（転職活動と続けた期を合わせる）・前の 3 か月の手応え・月次報告
    const fw2 = rules.indexOfKey("r.search.0keep.all.1fc_switch.none.2fc_switch2.none.3fc_switch2");
    expect(searchQuarters(rules, fw2)).toBe(3);
    const card = { title: "", short: "", body: "", numbers: [], todo: [], trace: [] };
    expect(pathContext(rules, fw2, "転職活動の 2 期目。", card)).toEqual(["転職活動の期が 2（道では 3）"]);
    expect(pathContext(rules, fw2, "転職活動の 3 期目。前の 3 か月の応募の手応えを踏まえる。", card)).toEqual([]);
    const fs = rules.indexOfKey("r.quit.0fc_scope.all.1ind_quit");
    expect(pathContext(rules, fs, "前の 3 か月の面接の手応えを踏まえる。", card)).toHaveLength(1);
    const back = rules.indexOfKey("r.back.0sd_grow.all.1ind_quit.cl0.2back_emp");
    expect(pathContext(rules, back, "過去 6 か月の月次報告から拾う。", card)).toHaveLength(1);
    expect(pathContext(rules, back, "", { ...card, todo: [{ text: "区切る顧客に振り返りを 1 枚で渡す", cite: "ind-side-d14" }] })).toHaveLength(1);
    expect(pathContext(rules, back, "書類で落ちる先が多く、面接に進めなかった。面接の手応えを生かせる。", card)).toHaveLength(1);
  });

  it("C3: 題が年収で変わる束は止める（題は兄弟ごとに覚えるので、組み立ての順で題が変わる。code-1）", () => {
    const bad = editBanks((b) => {
      b.title.keep = [{ v: ["{salYen}で続ける"] }];
    });
    const rep = runTextChecks(fromDevTree(TREE), { banks: bad });
    expect(rep.ok).toBe(false);
    expect(rep.failures.some((x) => /題が年収で変わる/.test(x))).toBe(true);
  });

  it("CLI: 木を受け取り、まとめと書き出すファイルを返す（止める点検が落ちれば 1）", () => {
    const res = cli(TREE, ["--annual", "360", "--out", "out/report.md", "--json", "out/report.json", "--golden", "out"]);
    expect(res.code).toBe(0);
    expect(Object.keys(res.files).sort()).toEqual(["out/golden-360.md", "out/report.json", "out/report.md"]);
    expect(res.text).toContain("文章の点検（test・");
    expect(res.text).toContain("通る");
    expect(cli(TREE, ["--annual", "abc"]).code).toBe(2);
    const rep = runTextChecks(fromDevTree(TREE), { annuals: [540] });
    expect(reportMarkdown(rep)).toContain("## 年収 540");
  });
});
