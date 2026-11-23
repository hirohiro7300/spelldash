import { describe, expect, it } from "vitest";
import { bankSpacing, cellFrames, cli, defaultWish, fixtureGolden, goldenMarkdown, goldenPaths, likeliest, mask, ownDateAgain, recommended, reportMarkdown, rowOf, runTextChecks, sentencesOf, skeleton, spacingIssues, STRUCTURAL, TEXT_CHECKS, TEXT_GATES } from "../../scripts/impact/textChecks";
import { analyze, compileMap, groupRows, joinsRow, rowJoinOf, walkPath, type RowJoin } from "../../src/deepmap/core";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";
import type { DevTree, DevTreeNode } from "../../src/deepmap/mapData";
import { BANKS, composeCard, composeMarkedConts, type Banks } from "../../src/demo/compose";
import { checkCard, kindHereBefore, mergedIssues, moveClaims, pathContext, searchQuarters, stillOutcome, sumClientIssues } from "../../src/demo/compose/checks";
import { calendarOf } from "../../src/demo/compose/path";
import { spaceJa, strip } from "../../src/demo/compose/text";
import { loadQSmall } from "./helpers/qSmall";
import golden from "./composeGolden.json";
import { F_BACK, F_ENDS, F_PORTFOLIO, F_PROMO2, F_SCOPE, F_STILL, header, move, out, RULES, st, TREE } from "./composeFixture";

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

  it("点検の名前は SPEC §4.6 の C1〜C10 と C4b・T4、見直しで足した C11（手が言う額と数）・C12（道の歩み）・C13（本文のおすすめ）。D はデータの指摘で止めない", () => {
    expect(TEXT_CHECKS.map((c) => c.id)).toEqual(["C1", "C1b", "C2", "C3", "C4", "C4b", "C5", "C5b", "C6", "C7", "C8", "C9", "C10", "C11", "C12", "C13", "C14", "T4", "D1", "D2"]);
    expect(TEXT_CHECKS.filter((c) => !c.block).map((c) => c.id)).toEqual(["D1", "D2"]);
    expect(TEXT_GATES).toEqual({ pathRepeats: 4, siblingSame: 0, decisionRepeats: 1, frameUses: 5 });
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

  it("C6・T4: 数だけ違う名前の兄弟が同じ状態・同じ稼ぎなら、行き先の言い方を兄弟の並びで回しても双子として止める（修正・code-6。兄弟の題は言い分ける）", () => {
    // 届け出は SpellDash だけ可（3 年後の一言の言い換えが 1 つ）・2 つの結果は名前の数だけが違い、状態も月の稼ぎも同じ
    const s = st({ pm: "s", pro: 1, mau: 300, pu: 10 });
    const twin = (id: string, lab: string): DevTreeNode => out(`r.x.${id}`, 36, s, id, 50, lab, ["pu", 36, null, null], [3, 0, 3], [1, 0, 0.6]);
    const tree: DevTree = { header, root: { k: "r", r: "r", m: 0, st: st(), rr: [1, 0, -0.3], kids: [move("r.x", "sd_retain", 33, s, [twin("pu1", "有料 1 人"), twin("pu2", "有料 2 人")])] } };
    const rep = runTextChecks(fromDevTree(tree), { annuals: [360] });
    const c6 = rep.runs[0]!.checks.find((c) => c.id === "C6");
    expect(c6?.n).toBe(1);
    expect(rep.runs[0]!.siblings.outPairs).toBe(1);
    expect(rep.runs[0]!.siblings.outSame).toBe(1);
    expect(rep.runs[0]!.siblings.titleSame).toBe(0);
  });

  it("C6: 道の繰り返しの門は、道の画面と同じまとめ方で数える（門を 0 にすると、手で作った地図でも止まる。code-2）", () => {
    // TREE は今のままが 12 期続く道（結果が 1 つの同じ手が続く）で、まとめない数はあるが、まとめると 0
    // （0.7 で今のままの書き出しを何期目かで分けたので、まとめない数も門の 4 までに減った。rep-5）
    const tree = runTextChecks(fromDevTree(TREE), { annuals: [360] }).runs[0]!.pathRepeats;
    expect(tree.raw.max).toBeGreaterThan(tree.dist.max);
    expect(tree.raw.max).toBeLessThanOrEqual(TEXT_GATES.pathRepeats);
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
    for (const x of ["2027 年 5 月までの手は 4 つで、おすすめは『4 月の評価で昇格を狙う』（昇格の見込み 3 割）", "今日からの 3 年の見込みは 1,228 万円（ここまで 89 万円＋この先 1,139 万円）で、今日『転職活動をする』を選んだ時の見込み 1,256 万円より 28 万円下がった", "3 年の見込みは、ここまでの 180 万円とこの先の 1,036 万円で 1,216 万円になり、3 か月前に選んだ『今のまま』の見込み 1,216 万円とほぼ同じ（おすすめの手なら 25 万円多かった）", "何も変えずに 3 年続ける（ずっと今のまま）と 1,124 万円", "今日からこの道の 3 年の稼ぎは 1,200 万円で、ずっと今のままより 76 万円多い", "ほかの手は、『今のまま』が 21.1 万円少ない", "2028 年 5 月の見込みは、月に遊ぶ人は 300 人から 400 人ほど", "分かれ目は 2028 年 4 月の給与", "『顧客 2 社以上』なら売上 月 10 万円ほど、『顧客 1 社以下』なら売上 月 5 万円ほど", "2028 年 5 月"])
      expect(skeleton(x), x).toBeNull();
    expect(sentencesOf("短い。これは九文字を超える文。")).toEqual(["これは九文字を超える文"]);
  });

  it("1b・W3（L2）: 道 1 本で 1 つの枠を使う数（構造の文も入れる）の門。手で作った地図は門の中で、門を 1 に下げると止まる", () => {
    const ok = runTextChecks(fromDevTree(RULES), { annuals: [360] });
    expect(ok.runs[0]!.pathRepeats.frames.dist.max).toBeLessThanOrEqual(TEXT_GATES.frameUses);
    expect(ok.runs[0]!.pathRepeats.frames.overGate).toBe(0);
    const rep = runTextChecks(fromDevTree(RULES), { annuals: [360], gates: { frameUses: 1 } });
    expect(rep.ok).toBe(false);
    const c6 = rep.runs[0]!.checks.find((c) => c.id === "C6")!;
    expect(c6.by.path).toBe(rep.runs[0]!.pathRepeats.frames.overGate);
    expect(c6.examples.some((e) => e.includes("道で 1 つの枠を"))).toBe(true);
  });

  it("修正（code-3・code-7）: 束から作る構造の文（進み具合・選べなくなる手・標準の続きの見込み）は、どの言い換えも差し込みを埋めると構造の文になり、手で書いた構造の文はどれも、小さい木と手で作った地図の文か書いた見本に当たる", async () => {
    // 束の言い換え: 差し込みを数の無い言葉で埋めても、数のある言葉で埋めても構造の文（{switchP1} のような数字入りの名前でも分けられる）
    for (const sec of ["progress", "rules", "contOdds"] as const)
      for (const vs of Object.values(BANKS[sec] ?? {}))
        for (const g of vs)
          for (const v of g.v)
            for (const fill of ["あ", "2 割 8 分"])
              for (const piece of v.replace(/\{\w+\}/g, fill).split("。")) if ([...mask(piece.trim())].length > 8) expect(skeleton(piece.trim()), `${sec}: ${v}`).toBeNull();
    // 手で書いた構造の文: 組み立てた文（小さい木・手で作った 2 つの地図、年収 360・540、標準の続きの期も）か、組み立てのまれな枝の見本に当たる
    const nHand = STRUCTURAL.length - cellFrames(BANKS, ["progress", "rules", "contOdds"]).length;
    const keys: string[] = [
      "この結果になる見込みは 3 割だった",
      "3 割の見込みで起きた結果",
      "見込み 3 割の結果",
      "『顧客 1 社』と比べても、この結果の 3 年の見込みはほぼ同じ",
      "次の手の並びは『全部可』の場合より少なく、副業の顧客探しが無い",
      // 本文の今日の手の名前をカードの題にした（P2 の確かめ F1。「独立する」→「今すぐ辞めて独立する」など題の方が長い）ので、小さい木では
      // この言い方の状態が長さの目安を超え、次の手の並びの違い（最初に落とす文）を落とすようになった。まれな枝として見本を置く
      "この結果では Pro の受付が選べる代わりに、『全部可』の場合にある副業の顧客探しは並ばない",
      "ここから 2029 年 11 月までの分かれ道は 12（判断 6・出来事の分かれ 6）",
      "会社員で持てる顧客は 2 社まで（あと 1 社）",
      "『転職活動をする』のカードの 1,100 万円は、その後を標準の選び方で続けた見積もりで、この先の見込みより 12 万円低い",
      "結果は 1 つで、残る分かれ道は 2029 年 8 月の判断の 1 つだけ",
      "2029 年 8 月の判断のほかに、この手の先の分かれ道は無い",
      "3 か月を終えて顧客が 2 社になっている見込みは 4 割 5 分で、増えれば広告運用の売上が月 3 万円上がる",
      "3 か月を終えて顧客は 2 社になる見込みで、会社員で持てる上限は 2 社",
      "この 3 か月で顧客は 2 社まで増える見込み（1 社増えるごとに売上は月 3 万円）",
      "顧客は 2 社で 3 か月を終える見込みで、会社員で持てる上限に届く",
      "その後を一番良い選び方で進めば、平均 1,250 万円",
    ].map((x) => mask(x));
    for (const m of [fromDevTree(TREE), fromDevTree(RULES), await loadQSmall()])
      for (const annual of [360, 540])
        for (let i = 0; i < m.n; i++) {
          const bodies = [composeCard(m, i, { annual }).body];
          if (m.role(i) === "e" && m.sum(i)) for (const x of composeMarkedConts(m, i, { annual })) bodies.push(spaceJa(strip(x.body)));
          for (const b of bodies) for (const x of sentencesOf(b)) keys.push(mask(x).replace(/^(?:# 年 # 月|今月)、/, "").replace(/^『[^』]*』を受けて、/, ""));
        }
    const dead = STRUCTURAL.slice(0, nHand).filter((re) => !keys.some((k) => re.test(k)));
    expect(dead.map((re) => re.source)).toEqual([]);
  }, 120_000);

  it("1b・W3: 手の数の枠（短い 3 年の見積もり・分かれ道・結果ごとの次のおすすめ・4 月の評価・顧客の見込み・今のままの伸び・数の結果の言い方）と標準の続きの行の枠は構造の文", () => {
    for (const x of [
      "2029 年 11 月までの稼ぎの見積もりは 923 万円（おすすめの手で、今のままより 8.9 万円多い）",
      "この手を選ぶと、2029 年 11 月までの稼ぎは 1,136 万円ほどの見積もり（おすすめの手で、今のままより 21.1 万円多い）",
      "見積もりでは、ここから 2029 年 11 月までに 1,024 万円を稼ぐ（おすすめの『転職活動を続ける』より 3 万円少ない）",
      "この手の先の分かれ道は 2029 年 11 月までに 108 で、この手の結果の分かれ 1 つのほかに、『大きく上げて転職』の後に 26、『少し上げて転職』の後に 22、『転職せず』の後に 59 が続く",
      "この手の先の分かれ道は 2029 年 11 月までに 108（判断 72・出来事の分かれ 36）で、この手の結果の分かれ 1 つのほかに、『昇格』の後に 26、『据え置き』の後に 81 が続く",
      "1,270 の分かれ道（判断 966・出来事の分かれ 304）のうち、1 つはこの手の結果の分かれで、『昇格』の後に続くのが 519、『据え置き』の後に続くのが 750",
      "結果ごとに数えると、この手の後ろの分かれ道は『昇格』の後が 13、『据え置き』の後が 30（この手の結果の分かれ 1 つを入れて 44）",
      "結果は 1 つで、その先の 29 の分かれ道は 2028 年 8 月の判断から始まり、一番多く続くのは『転職活動を続ける』の後の 28",
      "この手の後ろの分かれ道 13（判断 8・出来事の分かれ 5）は、2028 年 11 月に選べる 3 つの手に分かれ、『遊ぶ人を増やす』の後が 12 で一番多い",
      "2029 年 2 月の判断から先に 12 の分かれ道が続き、そのうち『4 月の評価で昇格を狙う』を選んだ後が 11",
      "次の判断（2027 年 11 月）のおすすめは、『大きく上げて転職』と『少し上げて転職』なら『続ける人を増やす』、『転職せず』なら『転職活動を続ける』",
      "2027 年 5 月に選ぶ手は、『昇格』の後は『転職活動を続ける』、『据え置き』の後は『届け出て副業の 1 社目を探す』がおすすめ",
      "結果によらず、次に選ぶおすすめの手は『転職活動を続ける』",
      "この手を選ぶと 2027 年 4 月の評価で昇格は狙わず、次に狙えるのは 2028 年 4 月の評価",
      "3 か月を終えて顧客が 2 社になっている見込みは 4 割 5 分で、増えれば広告運用の売上が月 3 万円上がる（SpellDash は月に遊ぶ人 159 人から 201 人）",
      "何も足さない 3 か月でも、続けている開発で月に遊ぶ人は 40 人から 51 人に増える見込み",
      "『有料 30 人以上』（7 割）の場合は有料 34 人ほどで、『有料 29 人以下』（3 割）の場合は有料 28 人ほど",
      "結果ごとの見込みは、『顧客 0 社』（4 割）では広告運用の売上はまだ無い、『顧客 1 社』（6 割）では売上 月 3 万円ほど",
      // 1.2（W5・con-10・rep-13）: 標準の続きの行の見出し・月の稼ぎ・3 年後と行き先の平均・その手の前提の見込み
      "2027 年 3 月〜5 月からは標準の選び方で続け、どの期も一番ありそうな結果で進めた見積もり",
      "続く 2027 年 6 月〜8 月は『今のまま』",
      "2027 年 9 月〜11 月の手は『集客』",
      "一番ありそうな出来事は『転職』とみる",
      "2027 年 2 月の月の稼ぎ 29.7 万円から始める",
      "この流れで 2027 年 5 月の月の稼ぎは 30.6 万円ほど（3 か月前より 0.9 万円多い）",
      "2028 年 8 月の月の稼ぎは、この流れでは 17.7 万円ほど（3 か月前とほぼ同じ）",
      "見積もりの流れでは、2028 年 11 月に月 24.7 万円ほどを稼ぐ（3 か月前より 7 万円多い）",
      "この流れで 2029 年 11 月（3 年後）の月の稼ぎは 50.9 万円ほど（3 か月前より 0.4 万円多い）で、ほかの結果の道も入れた 3 年後の平均は月 50.2 万円（行き先のカードの数はこの平均）",
      "この流れでは、この期に顧客は増えないとみる",
      "顧客は上限の 2 社に届いているので、この流れでは増えない",
      "探して決まる見込みは 3 か月ごとに 5 割 5 分で、事例を持っていれば 7 割とみる",
      "2029 年 4 月の評価で昇格する見込みは 3 割（先に担当を広げていれば 4 割）とみる",
    ])
      expect(skeleton(x), x).toBeNull();
    // 手の中身の文（この手を今選ぶ訳・書き出し）は数える
    expect(skeleton("前の期は決まらなかったので、声をかける相手を替えて探し直す")).not.toBeNull();
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

  it("道の画面と同じまとめ方（計算の芯の joinsRow。groupRows と同じ 1 つの決まり）: 同じ手で、どちらもまとめた手でなく、結果が 1 つか同じ名前なら 1 行（code-2）", () => {
    const row = (kind: string, single: boolean, label: string, stub = false): RowJoin => ({ kind, stub, single, label });
    // 学校への提案が「見送られる」→「導入が決まる」は 2 行、会社員に戻る仕事探しが「独立のまま」→「独立のまま」は 1 行
    expect(joinsRow(row("sd_school", false, "見送られる"), row("sd_school", false, "導入が決まる"))).toBe(false);
    expect(joinsRow(row("back_emp", false, "独立のまま"), row("back_emp", false, "独立のまま"))).toBe(true);
    expect(joinsRow(row("keep", true, "どの場合も"), row("keep", true, "どの場合も"))).toBe(true);
    expect(joinsRow(row("keep", true, "どの場合も"), row("keep", true, "どの場合も", true))).toBe(false);
    expect(joinsRow(row("keep", true, "どの場合も"), row("sd_grow", true, "どの場合も"))).toBe(false);
    expect(joinsRow(null, row("keep", true, "どの場合も"))).toBe(false);
    const map = fromDevTree(TREE);
    const o = map.indexOfKey("r.ad_permside.a0_a1.1ad.cl2");
    expect(rowJoinOf(map, map.parent(o), o)).toEqual({ kind: "ad_side", stub: false, single: false, label: "顧客 2 社以上" });
  });

  it("道の繰り返しの門の行（rowOf）は、道の画面の行のまとめ（walkPath の groups）とどの行き先でも同じ（決まりは計算の芯の 1 つだけ）", () => {
    let ends = 0;
    let joined = 0;
    for (const tree of [TREE, RULES, F_BACK, F_ENDS, F_PROMO2, F_STILL, F_SCOPE]) {
      const map = fromDevTree(tree);
      const a = analyze(compileMap(map), 360);
      for (let i = 0; i < map.n; i++) {
        if (map.role(i) !== "e" && !(map.role(i) === "s" && !map.childCount(i))) continue;
        ends++;
        // 点検の行: 今日からの結果ごとに rowOf で番号を付け、同じ番号が続く結果を 1 つの行にまとめる
        const outs: number[] = [];
        for (let x = i; x > 0; x = map.parent(map.parent(x))) outs.unshift(x);
        const groups: Array<[number, number]> = [];
        let prev: RowJoin | null = null;
        let run = -1;
        outs.forEach((x, k) => {
          const r = rowOf(map, prev, run, x);
          if (groups.length && r.run === run) groups[groups.length - 1]![1] = k;
          else groups.push([k, k]);
          prev = r.key;
          run = r.run;
        });
        const pv = walkPath(a, i);
        expect(pv.rows.map((r) => r.outcome), map.key(i)).toEqual(outs);
        expect(pv.groups.map((g) => [g.from, g.to]), map.key(i)).toEqual(groups);
        expect(groupRows(a, pv.rows)).toEqual(pv.groups);
        joined += groups.filter(([f, t]) => t > f).length;
      }
    }
    expect(ends).toBeGreaterThan(40);
    expect(joined).toBeGreaterThan(10);
  });

  it("判断ごとの門（F1）: 選ばずに次の判断へ進んだ道で、続く 2 つの判断に並ぶ『会社員に戻る』が同じ書き出しを言わない（0.4 の束なら 2 文が重なって止まる）", () => {
    const map = fromDevTree(F_BACK);
    for (const r of runTextChecks(map).runs) {
      expect(r.decisionRepeats.pairs).toBe(1);
      expect(r.decisionRepeats.hist).toEqual({ 0: 1 });
    }
    // 0.4 の束（初めての書き出しの言い換えが 1 つ）: 同じ 2 文を言い、門（1 文まで）で止まる（続けて探す期の組は 0.7 で何組かに分けた）
    const old = editBanks((b) => {
      const g = b.lead.back_emp!;
      const first = g.find((x) => x.if === "clr>=1")!;
      const plain = g.find((x) => !x.if)!;
      b.lead.back_emp = [...g.filter((x) => (x.if ?? "").startsWith("n>=1")), { if: "clr>=1", v: [first.v[0]!] }, { v: [plain.v[0]!] }];
    });
    const rep = runTextChecks(map, { banks: old, annuals: [360] });
    expect(rep.runs[0]!.decisionRepeats.overGate).toBe(1);
    expect(rep.failures.some((x) => /判断ごとの繰り返し 2（門 1）/.test(x))).toBe(true);
  });

  it("判断ごとの門（F1）: 続く判断に並ぶ手の組（書き出し・お金と見込み・避けたい訳）は、どれも言い換えが 2 つ以上で、どの 2 つも同じ文を持たない（続く判断では種が 1 つずれるので、どの種類の手も同じ文を並べない）", () => {
    const sk = (v: string): string[] => sentencesOf(v.replace(/\{\w+\}/g, "#"))
      .map(skeleton)
      .filter((x): x is string => x !== null);
    const bad: string[] = [];
    for (const sec of ["lead", "cost", "avoid"] as const)
      for (const [kind, groups] of Object.entries(BANKS[sec]))
        groups.forEach((g, gi) => {
          // 今日の手だけの組（first=1）は、続く判断に並ばない
          if ((g.if ?? "").includes("first=1")) return;
          if (g.v.length < 2) bad.push(`${sec}.${kind}#${gi} 言い換えが 1 つ`);
          const ss = g.v.map(sk);
          for (let x = 0; x < ss.length; x++) for (let y = x + 1; y < ss.length; y++) for (const t of ss[x]!) if (ss[y]!.includes(t)) bad.push(`${sec}.${kind}#${gi} v${x}・v${y}「${t}」`);
        });
    expect(bad).toEqual([]);
  });

  it("C2（F2）: 「2 社目が決まれば」は顧客が確かに 1 社、「2 社目が続くか」は確かに 2 社のときだけ（社数の幅でも、幅の無い状態でも止める）", () => {
    const rules = fromDevTree(RULES);
    const s9 = rules.indexOfKey("r.merge.0keep.all.1fc_push.all.2ad_side.all");
    expect(rules.band(s9)?.cl).toEqual([1, 2]);
    expect(mergedIssues(rules, s9, "副業と Pro が並ぶ。2 社目が埋まれば、会社員で持てる上限に届く。", BANKS.C)).toHaveLength(1);
    expect(mergedIssues(rules, s9, "2 社目が長続きするかで、この先の独立の判断が変わる。", BANKS.C)).toHaveLength(1);
    expect(mergedIssues(rules, s9, "顧客の数は道によって違うが、どの道でも副業の顧客と Pro の両方から売上が入る。", BANKS.C)).toEqual([]);
    const tree = fromDevTree(TREE);
    const c2 = (key: string, body: string): string[] =>
      checkCard(tree, tree.indexOfKey(key), { title: "顧客", short: "", body, numbers: [], todo: [], trace: [] }, BANKS, defaultWish()).filter((x) => x.startsWith("C2"));
    // 顧客 1 社: 2 社目が決まればは言えるが、2 社目が続くかは言えない。顧客 2 社: その逆
    expect(c2("r.ad_permside.a0_a1.1ad.cl1", "2 社目が決まれば、会社員で持てる上限に届く。")).toEqual([]);
    expect(c2("r.ad_permside.a0_a1.1ad.cl1", "2 社目の契約が長く続くかで、この先の独立の判断が変わる。")).toHaveLength(1);
    expect(c2("r.ad_permside.a0_a1.1ad.cl2", "2 社目の契約が長く続くかで、この先の独立の判断が変わる。")).toEqual([]);
    expect(c2("r.ad_permside.a0_a1.1ad.cl2", "副業と Pro が並ぶ。2 社目が埋まれば、会社員で持てる上限に届く。")).toHaveLength(1);
  });

  it("C12（F4・F5）: 何も変えなかった結果を月の稼ぎを一番動かした物と言う・前の会社で選んだ手の続きと言う文を見つける", () => {
    const still = fromDevTree(F_STILL);
    const end = [...Array(still.n).keys()].find((i) => still.role(i) === "e")!;
    const card = { title: "", short: "", body: "", numbers: [], todo: [], trace: [] };
    expect(pathContext(still, end, "この道で月の稼ぎを一番大きく動かしたのは、2029 年 5 月までの『据え置き』で、月 +3.7 万円。", card)).toHaveLength(1);
    // 据え置きだった 3 か月は、手の名前で言っても一番の動きと言わない（reader-11）。何かを変えた 3 か月なら言える
    expect(pathContext(still, end, "この道で月の稼ぎを一番大きく動かしたのは、2029 年 5 月までの『昇格を狙う』の 3 か月で、月 +3.7 万円。", card)).toHaveLength(1);
    expect(pathContext(still, end, "この道で月の稼ぎを一番大きく動かしたのは、2027 年 2 月までの『届け出て Pro を出す』の 3 か月で、月 +1.2 万円（主に SpellDash の稼ぎ）。", card)).toEqual([]);
    expect(stillOutcome(still, still.parent(still.parent(end)))).toBe(false);
    const scope = fromDevTree(F_SCOPE);
    const moved = scope.indexOfKey("r.0fc_scope.all.1fc_push.up.2fc_switch.high.3fc_scope");
    const same = scope.indexOfKey("r.0keep.all.1fc_scope.all.2keep.all.3fc_scope");
    const push = scope.indexOfKey("r.0fc_scope.all.1fc_push.up.2fc_switch.high.3fc_scope.all.4keep.all.5fc_push");
    expect([kindHereBefore(scope, moved, "fc_scope"), kindHereBefore(scope, same, "fc_scope"), kindHereBefore(scope, push, "fc_push")]).toEqual([0, 1, 0]);
    expect(pathContext(scope, moved, "2027 年 9 月〜11 月も担当を広げ続け、任された顧客・媒体を増やす。", card)).toHaveLength(1);
    expect(pathContext(scope, same, "2027 年 9 月〜11 月も担当を広げ続け、任された顧客・媒体を増やす。", card)).toEqual([]);
    expect(pathContext(scope, push, "2028 年 3 月〜5 月は、前の評価で足りなかった点を上司と確かめる。", card)).toHaveLength(1);
  });

  it("最後の点検の指摘を確かめる地図（F1〜F6）も、止める点検がどれも通る", () => {
    for (const tree of [F_BACK, F_ENDS, F_PROMO2, F_STILL, F_SCOPE, F_PORTFOLIO]) {
      const rep = runTextChecks(fromDevTree(tree));
      expect(rep.failures, rep.failures.join("\n")).toEqual([]);
    }
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
