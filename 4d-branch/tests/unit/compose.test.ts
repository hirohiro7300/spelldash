import { describe, expect, it } from "vitest";
import world from "../../scripts/impact/world.json";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";
import type { MapData } from "../../src/deepmap/mapData";
import { SENTENCES } from "../../src/demo/compose/banks/sentences";
import { adviceIn, adviceMatchers, asciiIds, checkBanks, checkCard, checkPaths, digitsOutside, eventMonthIssues, LIMITS, listNameOf, numberWording, OVERCLAIMS, stateRecommendIssues, TWO_IF, TWO_LASTS, wishIndex } from "../../src/demo/compose/checks";
import { frameOf, FRAME_SOFT, sentencesOf } from "../../scripts/impact/textChecks";
import { analyze, compileMap, textRuntime, type Analysis } from "../../src/deepmap/core";
import { BANKS, composeCard, composeCont, composeMarkedCard, materializeBody, ripple, type Banks, type Card } from "../../src/demo/compose/index";
import { STATE_BUDGET } from "../../src/demo/compose/compose";
import { calendarOf, ctxOf, keepTotalOf, weekday } from "../../src/demo/compose/path";
import { strip, wari } from "../../src/demo/compose/text";
import type { WishData } from "../../src/demo/wishlist";
import wishData from "../../src/demo/wishlist-data.json";
import { F_ENDS, F_PORTFOLIO, F_PROMO2, F_SCOPE, F_STILL, header, MIX_SPLIT, MIX_SURE, RULES, TREE } from "./composeFixture";
import { loadQSmall } from "./helpers/qSmall";

// 手で作った小さな地図は ./composeFixture.ts（TREE: R2 の組み立てを移したときの地図・RULES: SPEC §4.2 の決まりごとの地図）

const wish = wishIndex(wishData as unknown as WishData);
const all = (m: MapData): number[] => Array.from({ length: m.n }, (_, i) => i);
const byKey = (m: MapData, k: string): number => {
  const i = m.indexOfKey(k);
  if (i < 0) throw new Error(`no key ${k}`);
  return i;
};
/** 鍵の頭がこれで、役割と月が合うカード（道の上で 1 枚） */
const find = (m: MapData, prefix: string, role: string, month: number): number => {
  const hit = all(m).filter((i) => m.key(i).startsWith(prefix) && m.role(i) === role && m.month(i) === month);
  if (hit.length !== 1) throw new Error(`${prefix} ${role} ${month}: ${hit.length} 枚`);
  return hit[0]!;
};
/** 今日からカード i までの道（今日を除く） */
const pathTo = (m: MapData, i: number): number[] => {
  const out: number[] = [];
  for (let x = i; m.parent(x) >= 0; x = m.parent(x)) out.unshift(x);
  return out;
};
/** その道の最後のカード（子の先頭を 36 か月目までたどる） */
const leafOf = (m: MapData, i: number): number => {
  let x = i;
  while (m.childCount(x)) x = m.child(x, 0);
  return x;
};
const text = (c: Card): string => [c.title, c.short, c.body, ...c.numbers, ...c.todo.map((t) => t.text)].join("\n");
const body = (m: MapData, i: number, annual = 360): string => composeCard(m, i, { annual }).body;

/** 手引きを使い切る長い道の「やることが 3 つ未満」・束のままの長いやること・計算の側へ返すデータ（D）は、ここでは見ない */
const ignorable = (x: string): boolean => /^C3 やることが [0-2] つ|^C3 やることが長い|^D[12] /.test(x);

describe("文章の組み立て（R2 の組み立てを MapData に移した物）", () => {
  const map = fromDevTree(TREE);

  it("どの役割のカードも組み立てられ、空・印・埋まっていない差し込みが残らない", () => {
    for (const tree of [TREE, RULES]) {
      const m = fromDevTree(tree);
      const roles = new Set<string>();
      for (const i of all(m)) {
        const c = composeCard(m, i, { annual: 360 });
        roles.add(m.role(i));
        expect(c.title, m.key(i)).not.toBe("");
        expect(c.body, m.key(i)).not.toBe("");
        expect(text(c), m.key(i)).not.toMatch(/[\u0001-\u0004]|\{\w+\}|undefined|NaN|null|Infinity/);
        if (m.role(i) === "a") {
          // 3 つまで（長い今のままの道では手引きを使い切って減る。R2 の束のまま。文の型の波で足す）
          expect(c.todo.length, m.key(i)).toBeLessThanOrEqual(3);
          expect(new Set(c.todo.map((t) => t.cite)).size, m.key(i)).toBe(c.todo.length);
          for (const t of c.todo) expect(wish.has(t.cite), `${m.key(i)} ${t.cite}`).toBe(true);
        } else expect(c.todo).toEqual([]);
        expect(c.numbers.length, m.key(i)).toBeGreaterThanOrEqual(4);
        expect(c.trace.length, m.key(i)).toBeGreaterThan(0);
      }
      expect([...roles].sort()).toEqual(["a", "e", "r", "s"]);
    }
  });

  it("決まった出力: 同じ地図で 2 回・別の地図の物で逆の順に・先に別の年収で組み立てても同じ文", () => {
    for (const tree of [TREE, RULES]) {
      const m = fromDevTree(tree);
      const first = all(m).map((i) => composeCard(m, i, { annual: 360 }));
      const again = all(m).map((i) => composeCard(m, i, { annual: 360 }));
      const other = fromDevTree(tree);
      const reversed: Card[] = [];
      for (const i of all(other).reverse()) reversed[i] = composeCard(other, i, { annual: 360 });
      // 道で 1 回だけの文の段取りと兄弟の題は年収で変わらない（先に 540 で組み立てた地図でも、360 の文は同じ）
      const mixed = fromDevTree(tree);
      for (const i of all(mixed).reverse()) composeCard(mixed, i, { annual: 540 });
      const after540 = all(mixed).map((i) => composeCard(mixed, i, { annual: 360 }));
      expect(again).toEqual(first);
      expect(reversed).toEqual(first);
      expect(after540).toEqual(first);
    }
  });

  it("差し込みをたどれる: 数字はどれも差し込みの印の中か手引きの文の中（C1）で、使った文の型は束にある", () => {
    for (const tree of [TREE, RULES])
      for (const annual of [360, 540]) {
        const m = fromDevTree(tree);
        for (const i of all(m)) {
          const c = composeMarkedCard(m, i, { annual });
          expect(digitsOutside(c.body), `${m.key(i)} 本文: ${c.body}`).toEqual([]);
          expect(digitsOutside(c.title), `${m.key(i)} 題`).toEqual([]);
          for (const x of c.numbers) expect(digitsOutside(x), `${m.key(i)} 数の行: ${x}`).toEqual([]);
          for (const tag of c.trace) expect(resolves(BANKS, tag), `${m.key(i)} ${tag}`).toBe(true);
        }
      }
  });

  it("手引きの数字は引いた項目にある（C1b・束の全部の歩み）。引いた項目はやりたいことリストにある", () => {
    const issues = checkBanks(BANKS, wish);
    expect(issues.filter((x) => x.startsWith("C1b"))).toEqual([]);
    // やることは 24 字まで（R2 の束の 2 つは 0.3 で縮めた）
    expect(issues.filter((x) => x.startsWith("C3"))).toEqual([]);
  });

  it("1 枚の点検（C1・C1b・C2・C3・C4・C4b・C5・C5b・C10）は、どちらの地図でも見つからない", () => {
    for (const tree of [TREE, RULES])
      for (const annual of [360, 540]) {
        const m = fromDevTree(tree);
        for (const i of all(m)) {
          const issues = checkCard(m, i, composeMarkedCard(m, i, { annual }), BANKS, wish).filter((x) => !ignorable(x));
          expect(issues, `${m.key(i)} ${annual}`).toEqual([]);
        }
      }
  });

  it("文が言う前提の数は scripts/impact/world.json と同じ。副業の月額の段は 3 か月ごとの世界（W-gen の quarterWorld）と同じ", () => {
    const c = world.constants;
    const k = world.kinds;
    // 3 か月ごとの世界（scripts/impact/q/world.ts）があればその値で、まだ無ければ SPEC §2.3 #6 の値で確かめる（W-gen と合わさると、違えばここで落ちる。facts-2）
    const qw = Object.values(import.meta.glob("../../scripts/impact/q/world.ts", { eager: true }))[0] as
      | { quarterWorld?: (w: unknown) => { q: { feeFirst: number; feeRaised: number; raiseAt: number; searchMax: number; searchRun: number; churnQ: number }; qSwitch2: { pHigh: number; pMid: number } } }
      | undefined;
    const qr = Object.values(import.meta.glob("../../scripts/impact/q/quarter.ts", { eager: true }))[0] as { LIMITS?: { sd_grow: number; sd_ads: number; sd_retain: number } } | undefined;
    const W = qw?.quarterWorld ? qw.quarterWorld(world) : null;
    const tier = W ? W.q : { feeFirst: 3, feeRaised: 5, raiseAt: 4, searchMax: 4, searchRun: 2, churnQ: 1 - Math.pow(1 - c.churn, 3) };
    const sw2 = W ? W.qSwitch2 : { pHigh: 0.074, pMid: 0.052 };
    const lim = qr?.LIMITS ?? { sd_grow: 4, sd_ads: 4, sd_retain: 1 };
    // 和や 3 か月分の割合は、文が言う桁（割・分）より細かい所で丸めて比べる
    const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;
    expect(BANKS.C).toEqual({
      feeFirst: tier.feeFirst,
      feeRaised: tier.feeRaised,
      raiseAt: tier.raiseAt,
      indFee: c.indFee,
      overhead: c.indOverhead,
      spend: k.sd_ads.p.spend,
      capEmp: c.capEmp,
      capPart: c.capPart,
      capInd: c.capInd,
      net: c.net,
      infra: c.infra,
      step: k.fc_push.p.step,
      aprilRaise: c.aprilRaise,
      promoP: k.fc_push.p.p,
      promoPScope: k.fc_push.p.pScope,
      schoolP: k.sd_school.p.perQuarter,
      pilotMult: k.sd_school.p.pilotMult,
      firstP: k.ad_permside.p.first,
      firstPortfolio: k.ad_permside.p.firstPortfolio,
      sideP: k.ad_side.p.p,
      sidePPortfolio: k.ad_side.p.pPortfolio,
      switchHigh: k.fc_switch.p.high,
      switchMid: k.fc_switch.p.mid,
      backSal: k.back_emp.p.sal,
      seatYen: Math.round(c.seatNet * 10000),
      partFactor: c.partFactor,
      schoolSeats: c.schoolSeats,
      baseHours: c.baseHours,
      // 0.7（fact-12）: 届け出の答え・転職・週 4 日・会社員に戻る・試用の見込み、転職活動の上限、移る月の賞与の取り逃し、Pro の円の額、
      //   顧客が離れる見込み、遊ぶ人の伸びと有料になる割合、集客の手の上限（3 か月ごとの世界と、その手の決まり q/quarter.ts の LIMITS）
      permA: c.perm.a,
      permS: c.perm.s,
      permN: c.perm.n,
      switchP1: r6(k.fc_switch.p.pHigh3 + k.fc_switch.p.pMid3),
      switchP2: r6(sw2.pHigh + sw2.pMid),
      searchMax: tier.searchMax,
      searchRun: tier.searchRun,
      switchCost: c.switchCost,
      partP: k.part.p.p,
      backP: k.back_emp.p.p,
      pilotP: k.sd_pilot.p.p,
      netYen: Math.round(c.net * 10000),
      infraYen: Math.round(c.infra * 10000),
      churnQ: r6(tier.churnQ),
      growth: c.g0,
      conv: c.conv,
      growMax: lim.sd_grow,
      adsMax: lim.sd_ads,
      retainMax: lim.sd_retain,
    });
    // 3 か月ごとの世界が無い環境でも上の値で確かめたことにならないよう、世界と手の決まりがあることも確かめる
    expect(W, "scripts/impact/q/world.ts の quarterWorld").not.toBeNull();
    expect(qr?.LIMITS, "scripts/impact/q/quarter.ts の LIMITS").toBeDefined();
    // 文の見込みの言い方（割・分）は、丸める前の世界の数と同じ（2 割・4 割 5 分・3 割 5 分・2 割 8 分・1 割 3 分・3 割 5 分・6 割・3 割・1 割 2 分）
    expect([BANKS.C.permA, BANKS.C.permS, BANKS.C.permN, BANKS.C.switchP1, BANKS.C.switchP2, BANKS.C.partP, BANKS.C.backP, BANKS.C.pilotP, BANKS.C.churnQ].map((p) => strip(wari(p)))).toEqual(["2 割", "4 割 5 分", "3 割 5 分", "2 割 8 分", "1 割 3 分", "3 割 5 分", "6 割", "3 割", "1 割 2 分"]);
  });

  it("今日の手は、この手の先の分かれ道（判断・出来事の分かれ・結果ごと）と行き先（まとめた見積もりを分けて）を書く", () => {
    const a = byKey(map, "r.ad_permside");
    const r = ripple(map, a);
    const c = composeCard(map, a, { annual: 360 });
    // 結果の並びは「、」でつなぐ（結果の名前と区切りが混ざらない。reader-5）
    expect(c.body).toContain(`この手の先、2029 年 11 月までの分かれ道は ${r.forks}（判断 ${r.decisions}・出来事の分かれ ${r.splits}）。全部可の後 ${ripple(map, byKey(map, "r.ad_permside.a0_a1")).forks}、SpellDash だけの後`);
    // 行き先は名前を付けて（地図にある行き先と、そのうちのまとめた行き先。計算の芯が無ければ着く行き先は言わない。reader-4）
    expect(c.body).toContain(`地図にある行き先は ${r.ends}（うち標準の続きの見積もり ${r.sumEnds}）。`);
    expect(c.body).not.toContain("一番良い選び方で着く");
    // 数え上げは木をたどった数と同じ
    for (const i of all(map)) expect(ripple(map, i), map.key(i)).toEqual(walkCounts(map, i));
  });

  it("年収で変わる文: 給与の額と避けたい手の訳（給与は年収と、月にならした額で言う）", () => {
    const a = byKey(map, "r.ind_quit");
    expect(composeCard(map, a, { annual: 360 }).numbers[0]).toBe("年収 360 万円（月にならして 30 万円）");
    expect(composeCard(map, a, { annual: 540 }).numbers[0]).toBe("年収 540 万円（月にならして 45 万円）");
    const quit = byKey(map, "r.ad_permside.a0_a1.1ad.cl2.2iq");
    // 年収 360 なら顧客をあと 4 社で給与に並ぶが、540 なら独立で抱えられる 6 社でも届かない（言い方が変わる）
    expect(body(map, quit, 360)).toContain("給与（年収 360 万円・月にならして 30 万円）が 7 月から止まり、経費が月 3 万円かかる。今の顧客 2 社から給与に並ぶには、1 社 月 7 万円の顧客があと 4 社要る。");
    expect(body(map, quit, 540)).toContain("給与（年収 540 万円・月にならして 45 万円）が 7 月から止まり、経費が月 3 万円かかる。独立で抱えられる 6 社まで顧客を増やしても、今の給与には届かない。");
  });

  it("写しの文は、数の行を 1 行にして本文の前に置く", () => {
    const i = byKey(map, "r.ad_permside.a0_a1");
    const c = composeCard(map, i, { annual: 360 });
    expect(materializeBody(map, i, 360)).toBe(`${c.numbers.join("・")}\n${c.body}`);
  });

  it("手引きは道を進むと進み、同じ道で同じ歩みを繰り返さない（使い切った長い道だけ、直前の 3 つの手より前の歩みをもう一度やる）", () => {
    let i = byKey(map, "r.keep");
    const seen = new Set<string>();
    const recent: string[][] = [];
    let again = 0;
    for (;;) {
      const c = composeCard(map, i, { annual: 360 });
      const cites = c.todo.map((t) => t.cite);
      expect(cites.length, map.key(i)).toBe(3);
      // 直前の 3 つの手と同じ歩みは使わない
      for (const x of cites) for (const r of recent.slice(-3)) expect(r.includes(x), `${map.key(i)} ${x}`).toBe(false);
      // もう一度やる歩みは、新しい歩みを使い切った後だけ（新しい歩みが先に並ぶ）。その文は本文に入れない
      const k = cites.findIndex((x) => seen.has(x));
      if (k >= 0) {
        again++;
        expect(cites.slice(k).every((x) => seen.has(x)), map.key(i)).toBe(true);
        for (const x of cites.slice(k)) {
          const act = [...Object.values(BANKS.playbook)].flat().find((st) => st.id === x)!.act;
          expect(c.body, x).not.toContain(act);
        }
      }
      cites.forEach((x) => seen.add(x));
      recent.push(cites);
      const o = map.child(i, 0);
      if (map.role(o) === "e") break;
      i = map.child(o, 0);
    }
    expect(seen.size).toBeGreaterThanOrEqual(20);
    expect(again).toBeLessThanOrEqual(5);
  });

  it("道の覚えは地図ごと: 深いカードの初めの 1 枚は道の上と、その状態の兄弟（3 年の見込みで比べる）だけを読み、近くのカードは覚えから引く", () => {
    const counted = counting(fromDevTree(TREE));
    const m = counted.map;
    const deep = m.indexOfKey("r.keep.all.1k.all.2k.all.3k.all.4k.all.5k.all.6k.all.7k.all.8k.all.9k.all.10k.all");
    // 地図ごとに 1 回だけ下から数える物（先の分かれ道の数）と、年収ごとに 1 回だけの物（ずっと今のままの 3 年）は先に済ませる（L7）
    ripple(m, 0);
    keepTotalOf(ctxOf(m, BANKS, 360));
    counted.touched.clear();
    composeCard(m, deep, { annual: 360 });
    // 読んだのは、今日からそのカードまでの道と、道の上の判断に並ぶ手とその結果（手の見積もり）、そのカードの兄弟とその手と結果
    // （3 年の見込みで比べる。0.8・W2）、そのカードの子と孫だけ（どこかの先を丸ごとたどらない）
    const allowed = new Set<number>([deep]);
    const withKids = (x: number, depth: number): void => {
      allowed.add(x);
      if (depth > 0) for (let k = 0; k < m.childCount(x); k++) withKids(m.child(x, k), depth - 1);
    };
    for (let x = deep; x >= 0; x = m.parent(x)) {
      allowed.add(x);
      if (m.role(x) !== "a") withKids(x, 2);
    }
    const mv = m.parent(deep);
    for (let k = 0; k < m.childCount(mv); k++) withKids(m.child(mv, k), 2);
    expect([...counted.touched].filter((x) => !allowed.has(x))).toEqual([]);
    expect(counted.touched.size).toBeLessThan(m.n / 3);
    // 同じ道の 1 つ先の手は、新しく読むカードがわずか（判断ごとの手の種類は覚えから引く。先の分かれ道の数は地図ごとに 1 回だけ下から数える）
    ripple(m, 0);
    counted.touched.clear();
    composeCard(m, m.child(deep, 0), { annual: 360 });
    expect(counted.touched.size).toBeLessThanOrEqual(8);
  });

  it("番号・年収・束の形がおかしければ投げる。別の束も使える", () => {
    expect(() => composeCard(map, -1, { annual: 360 })).toThrow(RangeError);
    expect(() => composeCard(map, map.n, { annual: 360 })).toThrow(RangeError);
    expect(() => composeCard(map, 0, { annual: Number.NaN })).toThrow(RangeError);
    const banks: Banks = { ...BANKS, title: { ...BANKS.title, keep: [{ v: ["何もしない 3 か月"] }] } };
    expect(composeCard(map, byKey(map, "r.keep"), { annual: 360, banks }).title).toBe("何もしない 3 か月");
    expect(composeCard(map, byKey(map, "r.keep"), { annual: 360 }).title).toBe("今のままにする");
    const bad: Banks = { ...BANKS, title: { ...BANKS.title, keep: [{ if: "j==e", v: ["x"] }] } };
    expect(() => composeCard(map, byKey(map, "r.keep"), { annual: 360, banks: bad })).toThrow(/条件の書き方/);
  });
});

describe("SPEC §4.2: 数の行と数の言い方", () => {
  const map = fromDevTree(TREE);
  const rules = fromDevTree(RULES);

  it("数の行: 年収・広告運用・有料・遊ぶ人・週の時間（今日・状態・行き先）。今日・状態・行き先の本文にはこれらの数を書かない", () => {
    // Pro の前もサーバー代はかかる（本文の月の稼ぎと合わせる。reader-4）
    expect(composeCard(map, 0, { annual: 360 }).numbers).toEqual(["年収 360 万円（月にならして 30 万円）", "広告運用の顧客なし", "Pro はまだ出していない（サーバー代 月 3,000 円の持ち出し）", "月に遊んだ人 40 人", "週 52 時間"]);
    const s = composeCard(map, byKey(map, "r.ad_permside.a0_a1.1ad.cl2"), { annual: 360 });
    // 有料の稼ぎは書いた人数から出せる（3 人 × 940 円 − 3,000 円 = 180 円の持ち出し。fact-4）
    expect(s.numbers).toEqual(["年収 360 万円（月にならして 30 万円）", "広告運用 2 社（売上 月 10 万円）", "有料 3 人（手数料とサーバー代を引いて月 180 円の持ち出し）", "月に遊んだ人 70 人（3 か月前より +19 人）", "週 57 時間（今日より +5 時間）"]);
    expect(composeCard(map, byKey(map, "r.ind_quit.cl0"), { annual: 360 }).numbers.slice(0, 2)).toEqual(["給与なし（独立）", "広告運用の顧客なし"]);
    // 学校の席は有料の人数に入っている（別に足さない。truth-5）
    // 稼ぎは席の額から（40 席 × 300 円 − サーバー代 3,000 円。fact-4）
    expect(composeCard(map, byKey(map, "r.sd_pilot.yes.1ss.yes"), { annual: 360 }).numbers[2]).toBe("有料 40 人（うち学校の席 40・手数料とサーバー代を引いて月 9,000 円）");
    // 本当の行き先は 5 つ（3 か月前との差と週の時間）
    const real = composeCard(map, byKey(map, "r.keep.all.1k.all.2k.all.3k.all.4k.all.5k.all.6k.all.7k.all.8k.all.9k.all.10k.all.11k.all"), { annual: 360 });
    expect(real.numbers).toHaveLength(5);
    expect(real.numbers[3]).toMatch(/^月に遊んだ人 [\d,]+ 人（3 か月前より \+[\d,]+ 人）$/);
    for (const m of [map, rules])
      for (const i of all(m)) {
        if (m.role(i) === "a") continue;
        const b = body(m, i);
        for (const re of [/年収 [\d,]+ 万円/, /月にならして/, /月に遊んだ人 [\d,]+ 人/, /有料 [\d,]+ 人（/, /週 \d+ 時間/, /広告運用 [\d〜]+ ?社（売上/]) expect(b, `${m.key(i)} ${re.source}`).not.toMatch(re);
      }
  });

  it("数の言い方（C10・truth-15）: 給与は月にならして、有料は手数料とサーバー代を引いて、月に遊んだ人は 3 か月前より、3 か月は 3 つの月", () => {
    expect(numberWording("給与（月 30 万円）が止まる")).toHaveLength(1);
    expect(numberWording("給与は今日の 1.03 倍（月 30.9 万円）")).toHaveLength(1);
    expect(numberWording("給与（年収 360 万円・月にならして 30 万円）が止まる")).toEqual([]);
    expect(numberWording("有料会員は 5 人（月 1,400 円）")).toHaveLength(1);
    expect(numberWording("有料 5 人（手数料とサーバー代を引いて月 1,400 円）")).toEqual([]);
    expect(numberWording("有料 81 人（うち学校の席 40・手数料とサーバー代を引いて月 2.1 万円）")).toEqual([]);
    expect(numberWording("遊ぶ人は月 105 人（+22 人）")).toHaveLength(1);
    expect(numberWording("月に遊んだ人 105 人（+22 人）")).toHaveLength(1);
    expect(numberWording("月に遊んだ人 105 人（3 か月前より +22 人）")).toEqual([]);
    expect(numberWording("2027 年 11 月〜2028 年 2 月は")).toHaveLength(1);
    expect(numberWording("2027 年 12 月〜2028 年 2 月は")).toEqual([]);
    expect(numberWording("確定申告は 2028 年 2 月 16 日〜3 月 15 日")).toEqual([]);
    for (const m of [map, rules])
      for (const annual of [360, 540])
        for (const i of all(m)) expect(numberWording(text(composeCard(m, i, { annual }))), m.key(i)).toEqual([]);
    // 手の 3 か月は翌月から 3 か月。今日の手は「この 3 か月」と今月から言う（user-17）
    expect(body(rules, find(rules, "r.tax", "a", 3))).toContain("2027 年 3 月〜5 月");
    expect(body(map, byKey(map, "r.keep"))).toMatch(/^この 3 か月（2026 年 12 月〜2027 年 2 月）は/);
    expect(body(map, byKey(map, "r.ad_permside"))).toMatch(/^今月のうちに、本業のまま/);
  });

  it("顧客と学校の席は整数（ならした値・中身の幅でも端数を書かない。C5b）", () => {
    for (const m of [map, rules])
      for (const i of all(m)) expect(text(composeCard(m, i, { annual: 360 })), m.key(i)).not.toMatch(/\d+\.\d+ ?(社|席)/);
  });
});

describe("SPEC §4.2: 繰り返し（道で 1 回だけ）", () => {
  const map = fromDevTree(TREE);
  const rules = fromDevTree(RULES);
  const along = (m: MapData, leaf: number): string[] => pathTo(m, leaf).map((i) => body(m, i));
  const count = (texts: string[], re: RegExp): number => texts.reduce((n, t) => n + (t.match(new RegExp(re.source, "g"))?.length ?? 0), 0);

  it("暦の文・辞める前の文・静かな期の一言・出来事の助言・避けたい訳は、どの道でも組ごとに 1 回だけ（C9）", () => {
    for (const tree of [TREE, RULES])
      for (const annual of [360, 540]) {
        const m = fromDevTree(tree);
        expect(checkPaths(m, (i) => composeMarkedCard(m, i, { annual }).body, BANKS), `${annual}`).toEqual([]);
      }
    // 点検は 2 回目を見つける（同じ辞める前の文を道の 2 枚に置く）
    const leave = BANKS.cal.LEAVE![0]!.v[0]!;
    const twice = checkPaths(rules, (i) => (rules.key(i).startsWith("r.search") && rules.role(i) === "s" ? leave : ""), BANKS);
    expect(twice[0]).toMatch(/^C9 道で 2 回: cal\.LEAVE ← r\.search/);
    expect(adviceIn(`${leave}${leave}`, adviceMatchers(BANKS))).toEqual(["cal.LEAVE", "cal.LEAVE"]);
  });

  it("転職活動が続く道: 辞める前の文は 1 回、決まらない出来事は言い方を替え、助言は組ごとに 1 回", () => {
    const texts = along(rules, leafOf(rules, byKey(rules, "r.search.0keep")));
    expect(count(texts, /辞める・移るを選ぶなら/)).toBe(1);
    expect(count(texts, /応募を続ければ、次の 3 か月にも決まる目がある/)).toBe(1);
    expect(count(texts, /返事の来た応募先と来なかった応募先を見比べれば/)).toBe(1);
    // 1 回目の「決まらない」は「も」と言わない
    const first = texts.find((t) => /転職先|条件に合う話|給与が上がる話/.test(t))!;
    expect(first).not.toMatch(/この 3 か月も|今回も/);
    expect(count(texts, /大きな節目はまだ無い/)).toBe(1);
  });

  it("4 月・住民税の通知は道で 1 回、確定申告はその年分ごとに 1 回（2 年目からは言い方を替える）", () => {
    const texts = along(rules, leafOf(rules, byKey(rules, "r.tax.0ad_permside")));
    expect(count(texts, /4 月(に|は)定期の昇給と評価/)).toBe(1);
    expect(count(texts, /6 月に届く住民税/)).toBe(1);
    expect(count(texts, /2027 年分/)).toBe(1);
    expect(count(texts, /2028 年分/)).toBe(1);
    expect(texts.join("")).toContain("2028 年分の確定申告も、2029 年 2 月 16 日〜3 月 15 日に同じように出す。");
  });

  it("節目からの月は、節目が変わったときだけ書く", () => {
    const texts = along(rules, leafOf(rules, byKey(rules, "r.tax.0ad_permside")));
    expect(count(texts, /顧客の 1 社目から \d+ か月/)).toBe(1);
    const keep = along(map, leafOf(map, byKey(map, "r.keep")));
    expect(count(keep, /今日から \d+ か月、大きな節目はまだ無い/)).toBe(1);
    // 節目の名前に合わせた言い方
    expect(along(rules, leafOf(rules, byKey(rules, "r.back.0sd_grow"))).join("")).toContain("会社員に戻ってから 3 か月。");
  });

  it("静かな期の一言は、組ごとに道で 1 回（12 期の今のままでも同じ一言を繰り返さない）", () => {
    const texts = along(map, leafOf(map, byKey(map, "r.keep")));
    for (const g of BANKS.hint) for (const v of g.v) expect(count(texts, new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))), v).toBeLessThanOrEqual(1);
  });
});

describe("SPEC §4.2: まとめた行き先（truth-5）", () => {
  const rules = fromDevTree(RULES);
  const sure = byKey(rules, "r.mix.all");
  const split = byKey(rules, "r.mixb.all");
  const avg = byKey(rules, "r.avg.all");

  it("中身の幅の 9 割がそろう事実だけを言い切り、数は整数の幅で書く", () => {
    const c = composeCard(rules, sure, { annual: 360 });
    // 幅が広い（上が下の 2 倍を超える）ときは真ん中の道の数を添える（reader-5）
    expect(c.numbers).toEqual(["年収 371〜403 万円", "広告運用 1〜2 社", "有料 22〜49 人（真ん中の道で 35 人）", "月に遊んだ人 610〜1,211 人"]);
    expect(c.body).toMatch(/^2029 年 11 月（3 年後）の見込み（この手の後を、標準の選び方で続けた見積もり）。仕事は会社員。届け出の答えは『全部可』。Pro を出している。/);
    expect(c.title).toBe("3 年後の見込み: 広告運用 1〜2 社");
    expect(MIX_SURE.j.e).toBeGreaterThanOrEqual(0.9);
  });

  it("9 割に満たない事実は言葉で（多い・含む）言い、幅に端数を出さない", () => {
    const c = composeCard(rules, split, { annual: 360 });
    // 独立した道は給与が 0 なので「会社員の道」とは言わない（facts-5）
    expect(c.numbers).toEqual(["年収 360〜450 万円（独立した道は給与なし）", "広告運用 0〜3 社", "有料 0〜40 人（真ん中の道で 12 人）", "月に遊んだ人 300〜1,500 人（真ん中の道で 700 人）"]);
    expect(c.body).toContain("仕事は会社員の道が多く、独立の道も含む。転職した道も含む。届け出の答えは道によって違う。Pro を出している道が多い。学校の導入がある道も含む。");
    expect(c.body).not.toMatch(/仕事は会社員。|Pro を出している。|届け出の答えは『/);
    expect(MIX_SPLIT.cl[2]).toBe(2.6);
  });

  it("中身の幅が無ければ（R1 の木）、標準の続きの平均だと書き、平均を事実として言わない", () => {
    const c = composeCard(rules, avg, { annual: 360 });
    expect(c.body).toMatch(/^2029 年 11 月（3 年後）の平均（この手の後を、標準の選び方で続けた見積もり）。多くの道を平均した物で、仕事は一番多い会社員の道の場合、数は平均（1 本の道の数ではない）。/);
    expect(c.numbers).toEqual(["年収 平均 392 万円（月にならして 32.7 万円）", "広告運用 平均 1〜2 社（売上 月 6.6 万円ほど）", "有料 平均 41 人（手数料とサーバー代を引いて月 3.6 万円）", "学校の導入がある道も含む", "月に遊んだ人 平均 900 人"]);
    expect(c.title).toBe("3 年後の平均: 広告運用 1〜2 社");
    // 3 年後の平均へ飛ぶ所に節目を作らない（2027 年の「1 社目」などを書かない）
    expect(c.body).not.toContain("ここまでの節目");
    const tree = fromDevTree(TREE);
    const sumEnd = composeCard(tree, byKey(tree, "r.ad_permside.a0_a1.1k.all"), { annual: 360 });
    expect(sumEnd.body).toContain("ここまでの節目は、2026 年 12 月に全部可の答え、2027 年 1 月に顧客の 1 社目。");
    expect(sumEnd.numbers[3]).toBe("月に遊んだ人 平均 700 人");
  });

  it("標準の続きがあれば「この後の目安」を書く（同じ手が続く期はまとめ、5 つを超える分は「ほか N 期」。仕事・届け出の期と出来事のある期を残す。名前の無い手と出来事は英数字を出さない）", () => {
    // 移る・昇格する期は、その出来事の月を添える（期の手の月とは違う。fact-1）
    expect(body(rules, sure)).toContain("この後の目安: 2027 年 2 月 今のまま（3 期） → 11 月 転職活動 → 2028 年 2 月 転職活動の続き（5 月に移る） → ほか 2 期 → 11 月 副業の 1 社目探し（決まる） → 2029 年 2 月 昇格狙い（4 月に昇格） → ほか 2 期 → 11 月（平均 月 43.1 万円）。");
    // 月の稼ぎは今の年収で決まる（給与 1.07 倍 × 月 45 万円 + 広告運用 8 + SpellDash 3）。中身の道の平均で、1 本の道の数ではない（facts-9）
    expect(body(rules, sure, 540)).toContain("→ 11 月（平均 月 59.2 万円）。");
    expect(body(rules, split)).toContain("この後の目安: 2027 年 2 月 集客 → 5 月 別の手 → 8 月 今のまま → 2029 年 11 月（平均 月 30 万円）。");
    expect(body(rules, avg)).toContain("この後の目安: 2027 年 2 月 今のまま（3 期）");
    // 短くしても会社員に戻る期は残す（facts-9）。同じことを 2 回言わない（「会社員に戻ること（会社員に戻る）」としない。reader-5）
    // 会社員に戻るのはその期の 3 か月目なので、期の月（5 月）と戻る月（8 月）を分けて言う（fact-1・点検 C11）
    const back = body(rules, byKey(rules, "r.contback.all"));
    expect(back).toContain("→ 2029 年 5 月 会社員に戻る仕事探し（8 月に戻る） →");
    expect(back).not.toMatch(/会社員に戻ること|（会社員に戻る）|5 月 会社員に戻る →/);
  });

  it("まとめた手とまとめた行き先は「標準の選び方で続けた見積もり」と書く", () => {
    for (const k of ["r.mix", "r.mixb", "r.avg"]) {
      expect(body(rules, byKey(rules, k)), k).toContain("標準の選び方で続けた見積もり");
      expect(body(rules, byKey(rules, `${k}.all`)), k).toContain("標準の選び方で続けた見積もり");
    }
    // まとめた手の見込みは、幅があれば幅で、無ければ平均と言う
    expect(body(rules, byKey(rules, "r.mix"))).toContain("2029 年 11 月の見積もり（標準の続き）は、月に遊ぶ人は 610〜1,211 人、有料会員は 22〜49 人、顧客は 1〜2 社。");
    expect(body(rules, byKey(rules, "r.avg"))).toContain("2029 年 11 月の見積もり（標準の続き）は、月に遊ぶ人は平均 900 人、有料会員は平均 41 人、顧客は平均 1〜2 社ほど。");
  });
});

describe("SPEC §4.2: 確定申告と住民税（truth-10）", () => {
  const rules = fromDevTree(RULES);

  it("20 万円の線は所得（売上 − 経費）で見る。超える見込み・近い・以下（住民税の申告は要る）で言い分ける", () => {
    expect(body(rules, find(rules, "r.tax", "s", 12))).toContain("2027 年分は、副業と SpellDash の所得（売上から経費を引いた額）が年 20 万円を超える見込み。年末調整とは別に、2028 年 2 月 16 日〜3 月 15 日に確定申告をする。");
    // 広告運用の稼ぎが無い年分は「SpellDash の所得」と言う（reader-6）
    expect(body(rules, find(rules, "r.near", "s", 12))).toContain("2027 年分の SpellDash の所得（売上から経費を引いた額）が年 20 万円を超えるなら、2028 年 2 月 16 日〜3 月 15 日に確定申告をする。超えなくても、住民税の申告は市区町村へ出す。");
    expect(body(rules, find(rules, "r.low", "s", 12))).toContain("2027 年分の SpellDash の所得（売上から経費を引いた額）は年 20 万円以下の見込みで、確定申告は要らない。それでも住民税の申告は要るので、2028 年 3 月 15 日までに市区町村へ出す。");
  });

  it("独立の申告は独立した年分だけ。辞めた年・戻った年は給与と独立していた間の売上と経費を一緒に", () => {
    // 2027 年 1 月に独立: 2026 年分は給与だけ（年末調整）なので書かない。2027 年分は独立の申告
    const ind = pathTo(rules, leafOf(rules, byKey(rules, "r.ind.0ind_quit"))).map((i) => body(rules, i)).join("");
    expect(ind).not.toContain("2026 年分");
    expect(body(rules, find(rules, "r.ind", "s", 12))).toContain("2027 年分の確定申告は 2028 年 2 月 16 日〜3 月 15 日。独立してからの売上と経費を申告する。");
    // 独立して最初の年の住民税は、会社員だった前の年の所得で決まる
    // 住民税は前の年の所得で決まり、独立した後は自分で納める（高くなるとは言わない。fact-6）
    expect(body(rules, find(rules, "r.ind", "s", 6))).toContain("6 月に届く住民税は、会社員だった前の年の所得で決まり、独立した後は給与から引かれずに自分で納める。");
    expect(body(rules, find(rules, "r.ind", "s", 6))).not.toContain("高くなりやすい");
    // 2027 年 4 月に独立: 辞めるまでの給与と、独立してからの売上と経費
    expect(body(rules, find(rules, "r.quit", "s", 12))).toContain("2027 年分は辞めた年で、確定申告は 2028 年 2 月 16 日〜3 月 15 日。辞めるまでの給与（会社の源泉徴収票）と、独立してからの売上と経費を一緒に申告する。");
    // 2027 年 8 月に会社員へ戻った: 会社員の間の給与と、独立していた間の売上と経費
    expect(body(rules, find(rules, "r.back", "s", 12))).toContain("2027 年分は会社員に戻った年で、確定申告は 2028 年 2 月 16 日〜3 月 15 日。会社員の間の給与（源泉徴収票）と、独立していた間の売上と経費を一緒に申告する。");
  });

  it("確定申告の期間は年ごと（2 月 16 日・3 月 15 日が土日なら次の月曜）。文も 0 か月目の年月から年ごとに出す", () => {
    expect(weekday(2026, 11, 19)).toBe(4);
    expect(weekday(2025, 2, 16)).toBe(0);
    const cal = calendarOf(header);
    const strip = (s: string): string => s.replace(/[\u0001-\u0004]/g, "");
    expect(strip(cal.taxPeriod(2024))).toBe("2025 年 2 月 17 日〜3 月 17 日");
    expect(strip(cal.taxPeriod(2025))).toBe("2026 年 2 月 16 日〜3 月 16 日");
    expect(strip(cal.taxPeriod(2026))).toBe("2027 年 2 月 16 日〜3 月 15 日");
    expect(strip(cal.taxPeriod(2029))).toBe("2030 年 2 月 18 日〜3 月 15 日");
    expect(strip(cal.taxDeadline(2025))).toBe("2026 年 3 月 16 日");
    // 0 か月目を 2023 年 11 月・2024 年 11 月にすると、同じ道の 12 か月目の申告の文は、その年分の期間（土日で後ろにずれる）を言う
    const y23 = fromDevTree({ header: { ...header, anchor: "2023-11" }, root: RULES.root });
    expect(body(y23, find(y23, "r.tax", "s", 12))).toContain("2024 年分は、副業と SpellDash の所得（売上から経費を引いた額）が年 20 万円を超える見込み。年末調整とは別に、2025 年 2 月 17 日〜3 月 17 日に確定申告をする。");
    const y24 = fromDevTree({ header: { ...header, anchor: "2024-11" }, root: RULES.root });
    expect(body(y24, find(y24, "r.tax", "s", 12))).toContain("2025 年分は、副業と SpellDash の所得（売上から経費を引いた額）が年 20 万円を超える見込み。年末調整とは別に、2026 年 2 月 16 日〜3 月 16 日に確定申告をする。");
    expect(body(y24, find(y24, "r.low", "s", 12))).toContain("それでも住民税の申告は要るので、2026 年 3 月 16 日までに市区町村へ出す。");
    expect(body(y24, find(y24, "r.low", "s", 12))).toContain("2025 年分の SpellDash の所得");
  });

  it("3 か月の稼ぎは、稼ぎが始まった月（独立・届け出の答えの翌月・Pro の受付）から数える（その前の月は給与だけ）", () => {
    // 2026 年 12 月に答えが出て 2027 年 1 月から稼ぐ道・2027 年 1 月に独立した道には、2026 年分の申告の文が無い
    for (const k of ["r.tax.0ad_permside", "r.ind.0ind_quit"]) {
      const texts = pathTo(rules, leafOf(rules, byKey(rules, k))).map((i) => body(rules, i)).join("");
      expect(texts, k).not.toContain("2026 年分");
    }
  });

  it("独立した翌月に Pro の受付を始める（独立の 3 か月では 2 か月目でなく 3 か月目）", () => {
    // その月はカードの書き出しの年月なので「この月」と書く（年月を文の頭で言い直さない。点検 C8）
    expect(body(rules, find(rules, "r.ind", "s", 3))).toMatch(/^2027 年 2 月、2026 年 12 月に辞めると伝え、1 月から独立した。給与は止まり、経費として月 3 万円がかかる。この月に Pro（月 980 円）の受付を始めた。/);
  });
});

describe("SPEC §4.2: 移った会社・戻った会社（truth-11）", () => {
  const rules = fromDevTree(RULES);
  const at = (prefix: string, month: number): string => body(rules, find(rules, prefix, "s", month));
  // 出し直す一言は言い換えが 3 つ（同じ道で何度も移るときに同じ骨組みを続けない。点検 C6）
  const REFILE = /副業の届け出は、新しい会社で出し直す。|移った会社では、副業の届け出をあらためて出す。|届け出の答えは前の会社の物なので、この会社でもう一度届け出る。/;

  it("届け出の範囲を持っていける・出し直す・初めて出す・SpellDash だけを認める会社に戻る。顧客は引き継ぎ先に渡す", () => {
    // 移った会社で届け出が要らないとは言わない。面接で確かめた会社を選んだ、この地図の見方として言う（fact-3）
    expect(at("r.carry", 6)).toContain("移る先は、広告運用の副業と SpellDash を続けてよいと面接で確かめた会社に絞り、この地図では答えを『全部可』のまま数える。");
    expect(at("r.carry", 6)).not.toContain("出し直す");
    expect(at("r.keeps", 6)).toContain("移る先は、SpellDash を続けてよいと面接で確かめた会社に絞り、この地図では答えを『SpellDash だけ可』のまま数える。");
    // 移った月の賞与は、この地図の数え方として言う（給与が減ると言い切らない。fact-2）
    expect(at("r.keeps", 6)).toContain("移った月は、前の会社の賞与の取り逃しとして給与の半月分を引いて数えている（実際は賞与の支給日と在籍の条件で変わる）。");
    expect(at("r.refile", 6)).toMatch(REFILE);
    expect(body(rules, byKey(rules, "r.first.0fc_switch.high_mid"))).toContain("副業の届け出はまだ出していない。出すなら新しい会社の就業規則を読んでから。");
    // 顧客は引き継ぎ先に渡した（離れた顧客とは言わない）
    expect(at("r.handover", 6)).toContain("広告運用の顧客 2 社は、引き継ぎ先に渡して手放した。");
    expect(at("r.handover", 6)).not.toMatch(/離れた|契約の終わった/);
    const sonly = at("r.sonly", 6);
    expect(sonly).toContain("独立をやめて会社員に戻った。");
    expect(sonly).toContain("広告運用の顧客 2 社は、引き継ぎ先に渡して手放した。");
    expect(sonly).toContain("戻る先は、SpellDash を続けてよいと面接で確かめた会社に絞った。この地図では新しく届け出る手は使わず、『SpellDash だけ可』として数える。");
    expect(at("r.backrefile", 6)).toMatch(REFILE);
  });

  it("届け出る手でなければ、届け出の答えの出来事は書かない（答えが変わっても）", () => {
    for (const k of ["r.sonly", "r.backrefile", "r.nofile"]) {
      const s = body(rules, find(rules, k, "s", k === "r.nofile" ? 3 : 6));
      expect(s, k).not.toMatch(/会社の答え|届け出のうち通った|届け出はどちらも|届け出は両方とも/);
    }
  });

  it("転職の手の届け出の言い方は、移った結果のデータで決める", () => {
    expect(body(rules, find(rules, "r.carry", "a", 3))).toContain("給与が上がり、今の届け出の範囲もそのまま認める会社だけに絞る。");
    expect(body(rules, find(rules, "r.refile", "a", 3))).toContain("副業の届け出は移った会社で出し直す。");
    expect(body(rules, byKey(rules, "r.first.0fc_switch"))).toContain("副業の届け出は移った会社で初めて出す。");
  });
});

describe("SPEC §4.2: 学校の年度・年月・題・英数字の名前", () => {
  const map = fromDevTree(TREE);
  const rules = fromDevTree(RULES);

  it("学校の年度の切り替わりの文は言わない（truth-16）", () => {
    expect(JSON.stringify(SENTENCES)).not.toMatch(/年度の切り替わり/);
    expect(Object.keys(BANKS.cal)).not.toContain("SCHOOLYEAR");
    for (const m of [map, rules]) for (const i of all(m)) expect(body(m, i), m.key(i)).not.toMatch(/年度の切り替わり/);
  });

  it("年月はどれも 0 か月目（header.anchor）から。地図の年月は今日のカードの頭に書き、今日の手は今月から言う", () => {
    expect(body(map, 0)).toMatch(/^2026 年 11 月時点の地図。今月を今日として、2029 年 11 月まで/);
    const s12 = body(map, byKey(map, "r.ad_permside.a0_a1.1ad.cl2.2k.all.3k.all"));
    expect(s12).toMatch(/^2027 年 11 月、/);
    expect(s12).toContain("2027 年分は、副業と SpellDash の所得（売上から経費を引いた額）が年 20 万円を超える見込み。年末調整とは別に、2028 年 2 月 16 日〜3 月 15 日に確定申告をする。");
    // 昇格は 2028 年 4 月の評価（2028 年 2 月に選ぶ 3 か月に 4 月が入る）
    const push = "r.ad_permside.a0_a1.1ad.cl2.2k.all.3k.all.4k.all.5fp";
    expect(composeCard(map, byKey(map, push), { annual: 360 }).title).toBe("2028 年 4 月の昇格を狙う");
    // 0 か月目をずらすと、どの年月もずれる
    const shifted = fromDevTree({ header: { ...header, anchor: "2027-02" }, root: TREE.root });
    expect(body(shifted, 0)).toMatch(/^2027 年 2 月時点の地図。今月を今日として、2030 年 2 月まで/);
    expect(body(shifted, byKey(shifted, "r.ad_permside.a0_a1.1ad.cl2.2k.all.3k.all"))).toMatch(/^2028 年 2 月、/);
    // 0 か月目が 2027 年 2 月なら、15 か月目に選ぶ 3 か月（2028 年 6〜8 月）に 4 月は無い
    expect(composeCard(shifted, byKey(shifted, push), { annual: 360 }).title).toBe("昇格を狙う");
    // 2030 年 1 月が 0 か月目なら、2026〜2029 年はどこにも出ない（決め打ちの年が無い）
    const later = fromDevTree({ header: { ...header, anchor: "2030-01" }, root: RULES.root });
    for (const i of all(later)) expect(text(composeCard(later, i, { annual: 360 })), later.key(i)).not.toMatch(/202[6-9] 年/);
    expect(() => composeCard(fromDevTree({ header: { ...header, anchor: "2026/11" }, root: TREE.root }), 0, { annual: 360 })).toThrow(/年月が読めません/);
  });

  it("兄弟の題はどれも違う（手・状態・行き先。結果の兄弟も）", () => {
    for (const m of [map, rules])
      for (const p of all(m)) {
        if (m.childCount(p) < 2) continue;
        const ts = Array.from({ length: m.childCount(p) }, (_, k) => composeCard(m, m.child(p, k), { annual: 360 }).title);
        expect(new Set(ts).size, `${m.key(p)}: ${ts.join(" / ")}`).toBe(ts.length);
      }
  });

  it("状態と行き先の題は、分かれた数（事例・有料会員の数）を言う。同じ数に丸まる兄弟は結果の名前で言い分ける", () => {
    const title = (k: string): string => composeCard(rules, byKey(rules, k), { annual: 360 }).title;
    expect(title("r.pf.0ad_permside.a0_a1.1ad_portfolio.yes")).toBe("数字つきの事例ができた");
    expect(title("r.pf.0ad_permside.a0_a1.1ad_portfolio.no")).toBe("事例になる成果は出ず");
    expect(title("r.pu.0ad_permside.a0_a1.1keep.pu30")).toBe("有料会員が 30 人を超えた");
    expect(title("r.pu.0ad_permside.a0_a1.1keep.pu0")).toBe("顧客が 1 社減り 1 社・有料 22 人");
    const ends = all(rules).filter((i) => rules.key(i).startsWith("r.ends") && rules.role(i) === "e").map((i) => composeCard(rules, i, { annual: 360 }).title);
    expect(ends).toEqual(["3 年後: 『有料 30 人以上』", "3 年後: 『有料 29 人以下』"]);
    // 名前の無い手が 2 つ並べば、番号で言い分ける
    const zz = all(rules).filter((i) => /\.1zz[ab]$/.test(rules.key(i))).map((i) => composeCard(rules, i, { annual: 360 }).title);
    expect(zz).toHaveLength(2);
    expect(zz[0]).not.toBe(zz[1]);
    for (const t of zz) expect(t).toMatch(/^別の手（\d+）$/);
  });

  it("英数字の名前（『high_mid』・手の種類・結果の番号）を文に出さない（C4b）", () => {
    expect(asciiIds("『high_mid』なら")).toEqual(["high_mid", "『high_mid』"]);
    expect(asciiIds("前の 3 か月は fc_switch。cl2 なら keep")).toEqual(["fc_switch", "cl2", "keep"]);
    expect(asciiIds("SpellDash の Pro・GA4・CPA・D7・A4 1 枚")).toEqual([]);
    for (const m of [map, rules]) for (const i of all(m)) expect(asciiIds(text(composeCard(m, i, { annual: 360 }))), m.key(i)).toEqual([]);
    const first = body(rules, byKey(rules, "r.first.0fc_switch"));
    expect(first).toContain("『少しか大きく上げて転職』なら");
    expect(first).toContain("『転職せず』なら");
    // 前の 3 か月の手は「〜した」で言う（reader-10）
    expect(body(rules, all(rules).find((i) => /\.1zza\.all\.2k$/.test(rules.key(i)))!)).toMatch(/^前の 3 か月は別の手を選んだ。/);
  });
});

describe("見直しの指摘（stage 4: reader-*・facts-*・code-*）", () => {
  const map = fromDevTree(TREE);
  const rules = fromDevTree(RULES);
  const state = (m: MapData, prefix: string, month: number): string => body(m, find(m, prefix, "s", month));

  it("題は年収で変わらない: 新しい地図の 360・540・1,200 で同じ。540 の後に 360 で組み立てても、新しい地図の 360 と同じ（code-1）", () => {
    for (const tree of [TREE, RULES]) {
      const fresh = (annual: number): string[] => {
        const m = fromDevTree(tree);
        return all(m).map((i) => composeCard(m, i, { annual }).title);
      };
      const t360 = fresh(360);
      expect(fresh(540)).toEqual(t360);
      expect(fresh(1200)).toEqual(t360);
      const m = fromDevTree(tree);
      for (const i of all(m)) composeCard(m, i, { annual: 540 });
      const after = all(m).map((i) => composeCard(m, i, { annual: 360 }));
      const m2 = fromDevTree(tree);
      expect(after).toEqual(all(m2).map((i) => composeCard(m2, i, { annual: 360 })));
    }
    // 大きな事実の無い中身の幅の行き先は、遊ぶ人で言う（年収の幅を題に入れない）。4 桁でも題に収まる
    const t = composeCard(rules, byKey(rules, "r.mau.all"), { annual: 3000 }).title;
    expect(t).toBe("3 年後の見込み: 遊ぶ人 1,279 人ほど");
    expect([...t].length).toBeLessThanOrEqual(24);
  });

  it("昇格と据え置きをまとめた結果は、昇格しなかったと言わず、見込みとまとめた平均で言う。数の行の年収は平均（facts-1・reader-3）", () => {
    const s6 = state(rules, "r.merge", 6);
    expect(s6).not.toMatch(/昇格しなかった|評価は据え置き|据え置きで、/);
    expect(s6).toMatch(/昇格[^。]*3 割/);
    const c6 = composeCard(rules, find(rules, "r.merge", "s", 6), { annual: 360 });
    expect(c6.title).toBe("昇格と据え置きの平均で進む");
    expect(c6.numbers[0]).toMatch(/^年収 平均 /);
    // 手の文: 見込みは分かれ目で 1 回だけ言う
    const push = body(rules, find(rules, "r.merge", "a", 3));
    expect(push).toContain("昇格する見込みは 3 割。この地図は、昇格した場合と据え置きの場合をまとめた平均");
    expect(push.match(/見込みは 3 割/g)).toHaveLength(1);
  });

  it("社数の違う場合をまとめた結果（幅）は、決まった・決まらなかったと言い切らず、まとめた見積もりと言う。数の行の売上は平均（facts-1・reader-9）", () => {
    const c = composeCard(rules, find(rules, "r.merge", "s", 9), { annual: 360 });
    expect(c.body).toMatch(/2 社目[^。]*5 割 5 分[^。]*1〜2 社/);
    expect(c.body).not.toMatch(/決まらなかった。|2 社目が決まった。|もう 1 社増えた/);
    expect(c.numbers[1]).toBe("広告運用 1 社か 2 社（平均 月 4.7 万円）");
    // 幅のまま進む今のままは、顧客の出来事を言わない
    expect(state(rules, "r.merge", 12)).not.toMatch(/顧客が|社目|離れた/);
    // 上げ幅の違う転職をまとめた結果は、2 つの倍率と平均で言う
    const hm = body(rules, byKey(rules, "r.first.0fc_switch.high_mid"));
    expect(hm).toContain("上げ幅は、大きい場合（今日の 1.18 倍）と小さい場合（1.08 倍）をまとめた見積もりで、平均で今日の 1.13 倍");
    expect(hm).not.toMatch(/給与が今日の [\d.]+ 倍の会社へ/);
    // 1 社目と言うのは、確かに 1 社目のときだけ（2 社に増えたなら社数で）
    const sA = byKey(map, "r.ad_permside.a0_a1.1ad.cl2");
    expect(body(map, sA)).not.toMatch(/1 社目（月/);
  });

  it("次の顧客の月額は道で決まる: 新しい顧客は月 3 万円、4 社に届いた後は月 5 万円（facts-2）。学校の席は加わった分（facts-3）", () => {
    expect(body(rules, find(rules, "r.merge", "a", 6))).toContain("（1 社 月 3 万円）");
    expect(body(map, byKey(map, "r.ad_permside.a0_a1.1ad"))).toContain("1 社 月 3 万円");
    expect(body(rules, find(rules, "r.fee", "a", 6))).toContain("（1 社 月 5 万円）");
    expect(body(rules, find(rules, "r.fee", "a", 9))).toContain("『導入が決まる』なら 40 席分の売上が加わる");
    expect(body(rules, byKey(rules, "r.fee.0part.p.1keep.all.2ad_side.cl4.3sd_school.yes"))).toContain("40 席が有料の席として加わった");
    // 昇格の額は、結果の給与の差（4 月の昇給がかかった後。facts-6・reader-4）
    expect(body(rules, find(rules, "r.merge", "a", 3))).toContain("昇格すれば年収が 26 万円上がる");
  });

  it("どの手も 3 年の見積もりとおすすめの手との差を言う。まとめた手は、決まった一文でなく自分の見積もりで（reader-1・reader-2）", () => {
    const stubA = body(map, byKey(map, "r.ad_permside.a0_a1.1ad.cl2.2iq"));
    expect(stubA).toMatch(/この手で進むと、ここから 2029 年 11 月までの稼ぎは合わせて [\d,.]+ 万円ほど/);
    expect(stubA).toContain("この手の先は分かれ道を開かず、標準の選び方で続けた見積もり。");
    expect(stubA).not.toContain("分かれ道を省き");
    // 数で分かれるまとめた手は、結果ごとの 3 年の稼ぎと標準の続きの中身で言う（「まだ無い」と言わない。reader-5）
    expect(stubA).toMatch(/3 年後の顧客は/);
    expect(stubA).not.toContain("まだ無い");
    // 結果の中身が同じなら、まとめて言う
    // 戻るのは標準の続きの会社員に戻る期（2029 年 5 月に選ぶ）の 3 か月目（fact-1）
    expect(body(rules, byKey(rules, "r.twins"))).toContain("『顧客 0 社』でも『顧客 1 社』でも、多くの道で 2029 年 8 月に会社員に戻り");
    // 中身の同じまとめた行き先は、同じだと言う
    expect(body(rules, byKey(rules, "r.twins.cl0"))).toContain("『顧客 1 社』の後と、標準の続きも 3 年後の姿も同じ。");
  });

  it("後の見込みを変える手は、その見込みを割で言う（reader-2）", () => {
    expect(body(rules, find(rules, "r.quit", "a", 0))).toContain("昇格する見込みが 3 割から 4 割に上がる");
    expect(body(map, byKey(map, "r.sd_pilot"))).toContain("3 か月ごとに 1 割から 1 割 5 分に上がる");
    expect(body(map, byKey(map, "r.ad_permside.a0_a1.1ad"))).toMatch(/見込み[^。]*5 割 5 分/);
  });

  it("確定申告: 11 月のカードは 12 月の稼ぎも足して決め、線に近ければ「要らない」と言い切らない（facts-4）", () => {
    expect(state(rules, "r.dec", 12)).toContain("2027 年分の SpellDash の所得（売上から経費を引いた額）が年 20 万円を超えるなら");
    expect(state(rules, "r.dec", 12)).not.toContain("確定申告は要らない");
  });

  it("その 3 か月の節目を言う状態は、節目からの月の文を書かない（「まだ無い」と食い違わない。facts-7）", () => {
    expect(state(rules, "r.since", 9)).not.toContain("まだ無い");
    expect(state(rules, "r.since", 12)).toContain("転職してから 3 か月。");
    // 学校の返事は 3 か月の 2 か月目（W-gen の sim と同じ）
    expect(body(rules, find(rules, "r.fee", "a", 9))).toContain("2027 年 10 月の学校の返事");
  });

  it("言い方: 届け出の答えを言い直さない・「見る数は」は数だけ・試用の見送りは次の 3 か月（reader-8・reader-10・facts-8）", () => {
    expect(body(map, byKey(map, "r.ad_permside.a0_a1"))).not.toContain("この場合は");
    for (const m of [map, rules]) for (const i of all(m)) expect(body(m, i), m.key(i)).not.toMatch(/見る数は [^。]*(返事|成果|答え)|今日の 1\.00 倍|前の 3 か月は[^。、]*こと。|同業の副業まで通る会社は少なく/);
    expect(body(map, byKey(map, "r.sd_pilot"))).toContain("次の 3 か月にもう一度声をかけるか");
  });

  it("標準の続きの 1 期（composeCont）: 期間・その期の手の書き出し・道で使っていない手引き・一番ありそうな出来事（reader-1）", () => {
    const i = byKey(rules, "r.mix.all");
    const rows = Array.from({ length: (rules.cont(i) ?? []).length }, (_, k) => composeCont(rules, i, k, { annual: 360 })!);
    expect(rows).toHaveLength(11);
    expect(rows[0]!.body).toMatch(/^2027 年 3 月〜5 月は、標準の選び方では『今のまま』の 3 か月。/);
    expect(rows[4]!.title).toBe("転職活動の続き（5 月に移る）");
    expect(rows[4]!.body).toContain("この期に一番ありそうな出来事は『転職』。");
    const cites = rows.flatMap((r) => r.todo.map((t) => t.cite));
    expect(new Set(cites).size).toBe(cites.length);
    for (const c of cites) expect(wish.has(c), c).toBe(true);
    for (const r of rows) expect(r.body).not.toMatch(/[\u0001-\u0004]|\{\w+\}/);
    expect(composeCont(rules, i, 99, { annual: 360 })).toBeNull();
    expect(composeCont(rules, byKey(rules, "r.mix"), 0, { annual: 360 })).toBeNull();
  });
});

/** 使った文の型の名前（節.種類#組.言い換え）が束にあるか。文の型を使わない節の名前も認める */
function resolves(banks: Banks, tag: string): boolean {
  if (["watch:single", "watch:num", "watch:sum", "watch:sums", "watch:mix", "watch:scope", "ripple", "root", "sum:avg", "sum:mix", "sum:same", "cont", "value", "value:stub"].includes(tag)) return true;
  // 0.8（W2）: 状態の数の枠（組み立て側の決まった枠。束の型は使わない）
  if (/^state:(?:quarter|total|contrast|menu|forks|next|thread|then|then:share|then:cap|then:keep|(?:short|drop):\w+)$/.test(tag)) return true;
  const m = /^(\w+)(?:\.([^#]+))?#(\d+)\.(\d+)$/.exec(tag);
  if (!m) return false;
  let cell: unknown = (banks as unknown as Record<string, unknown>)[m[1]!];
  for (const p of m[2] ? m[2].split(".") : []) cell = (cell as Record<string, unknown> | undefined)?.[p];
  if (!Array.isArray(cell)) return false;
  const g = cell[Number(m[3])] as { v?: string[] } | undefined;
  return typeof g?.v?.[Number(m[4])] === "string";
}

/** 木をたどって数える（ripple と比べる） */
function walkCounts(map: MapData, i: number): { decisions: number; splits: number; forks: number; ends: number; sumEnds: number } {
  const c = { decisions: 0, splits: 0, forks: 0, ends: 0, sumEnds: 0 };
  const stack = [i];
  while (stack.length) {
    const x = stack.pop()!;
    if (map.role(x) === "e") {
      c.ends++;
      if (map.sum(x)) c.sumEnds++;
    } else if (map.childCount(x) >= 2) {
      if (map.role(x) === "a") c.splits++;
      else c.decisions++;
    }
    for (let k = 0; k < map.childCount(x); k++) stack.push(map.child(x, k));
  }
  c.forks = c.decisions + c.splits;
  return c;
}

/** 番号を受け取る問い合わせで、読んだカードの番号を数える地図 */
function counting(inner: MapData): { map: MapData; touched: Set<number> } {
  const touched = new Set<number>();
  const map = new Proxy(inner, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv) as unknown;
      if (typeof v !== "function" || prop === "indexOfKey") return v;
      return (...args: unknown[]) => {
        if (typeof args[0] === "number") touched.add(args[0]);
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { map, touched };
}

describe("最後の点検の指摘（F2〜F6）", () => {
  /** 地図の行き先（36 か月目）の番号 */
  const endsOf = (m: MapData): number[] => all(m).filter((i) => m.role(i) === "e");
  /** そのカードが使った文の型（trace のうち、その束の組の番号まで） */
  const used = (c: Card, cell: string): string[] => c.trace.filter((t) => t.startsWith(`${cell}#`)).map((t) => t.replace(/\.\d+$/, ""));

  it("F2: 3 年後の見通しは顧客の数で言い分ける（確かに 1 社なら 2 社目が決まればと言い、社数の幅では 2 社目を決めて言わない）", () => {
    const m = fromDevTree(F_ENDS);
    const seen: Record<string, string> = {};
    for (const i of endsOf(m)) {
      const c = composeCard(m, i, { annual: 360 });
      const band = m.band(i)?.cl ?? null;
      seen[band ? band.join("-") : "1"] = c.trace.find((t) => t.startsWith("after#")) ?? "";
      if (band) {
        expect(c.body, m.key(i)).not.toMatch(TWO_IF);
        expect(c.body, m.key(i)).not.toMatch(TWO_LASTS);
      } else expect(c.body, m.key(i)).not.toMatch(TWO_LASTS);
      expect(checkCard(m, i, composeMarkedCard(m, i, { annual: 360 }), BANKS, wish, 360).filter((x) => x.startsWith("C2")), m.key(i)).toEqual([]);
    }
    // 組の番号: 確かに 1 社・下が 1 社の幅・顧客がいない道を含む幅（sentences.ts の after の並び）
    const at = (cond: string): number => BANKS.after.findIndex((g) => g.if === cond);
    expect(Object.fromEntries(Object.entries(seen).map(([k, t]) => [k, Number(/^after#(\d+)/.exec(t)?.[1])]))).toEqual({ "1": at("pm=a & clo=1 & chi=1"), "1-2": at("pm=a & clo>=1"), "0-2": at("pm=a & cl>=0.5") });
    // 2 社目が続くかは、2 社が確かなとき（上限に届いた組）だけ
    for (const g of BANKS.after) for (const v of g.v) if (TWO_LASTS.test(v)) expect(g.if).toMatch(/clo>=2/);
    for (const g of BANKS.after) for (const v of g.v) if (TWO_IF.test(v)) expect(g.if).toBe("pm=a & clo=1 & chi=1");
  });

  it("F3: 行き先の節目は、結びの文が言う結果を必ず並べる（同じ節目の 2 回目は「2 回目の昇格」）", () => {
    const m = fromDevTree(F_PROMO2);
    const [end] = endsOf(m);
    const b = body(m, end!);
    expect(b).toContain("ここまでの節目は、2026 年 12 月に全部可の答え、2027 年 4 月に昇格、2028 年 4 月に 2 回目の昇格。");
    expect(b).toContain("この道で月の稼ぎを一番大きく動かしたのは、2028 年 5 月までの『昇格』で、月 +12 万円。");
    expect(body(m, end!, 540)).toContain("2028 年 4 月に 2 回目の昇格");
  });

  it("F4: 何も変えなかった結果（据え置き）は、月の稼ぎを一番動かした物と言わず、その 3 か月の手で言う（題の年月と重ねない）", () => {
    const m = fromDevTree(F_STILL);
    for (const annual of [360, 540]) {
      const b = body(m, endsOf(m)[0]!, annual);
      // 据え置きだった 3 か月は、結果の名前でも手の名前でも一番の動きと言わない（reader-11）。言うなら別の 3 か月と、その主な中身
      expect(b).not.toMatch(/一番大きく動かしたのは、2029 年 5 月までの『/);
      expect(b).not.toContain("『据え置き』で、月");
      const lv = /一番大きく動かしたのは、[^。]*。/.exec(b);
      if (lv) expect(lv[0]).toMatch(/（主に(?:4 月の定期の昇給|給与|広告運用の売上|SpellDash の稼ぎ)）。$/);
    }
  });

  it("F5: 担当を広げ続ける・前の評価の続きと言うのは、今の会社で前にその手を選んだときだけ（転職した後は、今の会社では初めてと言う）", () => {
    const m = fromDevTree(F_SCOPE);
    const moved = byKey(m, "r.0fc_scope.all.1fc_push.up.2fc_switch.high.3fc_scope");
    const push = byKey(m, "r.0fc_scope.all.1fc_push.up.2fc_switch.high.3fc_scope.all.4keep.all.5fc_push");
    const same = byKey(m, "r.0keep.all.1fc_scope.all.2keep.all.3fc_scope");
    const group = (kind: string, cond: string): string => `lead.${kind}#${BANKS.lead[kind]!.findIndex((g) => g.if === cond)}`;
    for (const annual of [360, 540]) {
      const cm = composeCard(m, moved, { annual });
      expect(used(cm, "lead.fc_scope")).toEqual([group("fc_scope", "n>=1")]);
      expect(cm.body).not.toMatch(/担当を広げ続け|もう一段広げる/);
      expect(cm.body).toContain("今の会社で");
      const cp = composeCard(m, push, { annual });
      expect(used(cp, "lead.fc_push")).toEqual([group("fc_push", "joined=1")]);
      expect(cp.body).not.toMatch(/前の評価で足りなかった|評価の資料にまとめ直す/);
      // 入社して 1 年に満たない会社の評価は、対象になるかを先に人事に確かめる（移ったのは 2027 年 8 月、評価は 2028 年 4 月。fact-5）
      expect(cp.body).toMatch(/入社(?:して)? 8 か月で[^。]*。[^。]*人事に/);
      expect(used(composeCard(m, same, { annual }), "lead.fc_scope")).toEqual([group("fc_scope", "here>=1")]);
    }
  });

  it("F6: 言い方（今日の事例づくりは最初の事例を 1 つだけ言う・有料会員は後から増えると言う・次の機会は 1 枚に 1 回・状態の題に「回目のまとめ」と書かない）", () => {
    const m = fromDevTree(F_PORTFOLIO);
    const first = m.child(0, 0);
    for (const v of BANKS.lead.ad_portfolio!.at(-1)!.v) {
      // 今日の手の書き出し（言い換え 3 つ）のどれでも、手引きの文と合わせて「最初の」は 1 回まで
      const banks = structuredClone(BANKS) as Banks;
      banks.lead.ad_portfolio!.at(-1)!.v = [v];
      const b = composeCard(fromDevTree(F_PORTFOLIO), first, { annual: 360, banks }).body;
      expect(b.split("最初の").length - 1, b).toBeLessThanOrEqual(1);
      expect(b).not.toContain("最初の事例にする");
    }
    expect(body(m, first)).toContain("SpellDash の広告運用も、事例に加える");
    const texts = (vs: ReadonlyArray<{ v: readonly string[] }>): string[] => vs.flatMap((g) => g.v);
    expect(texts(BANKS.lead.sd_grow!).filter((v) => /付いてくる|有料会員 \{pu\} 人も/.test(v))).toEqual([]);
    // 昇格を狙う手の結果の意味: 昇格の方と据え置きの方のどの組み合わせでも、1 年後の機会を言うのは 1 回まで
    for (const up of texts(BANKS.branch.fc_push!.up!)) for (const same of texts(BANKS.branch.fc_push!.same!)) expect(`${up}。${same}`.split("1 年後").length - 1).toBeLessThanOrEqual(1);
    expect(texts(Object.values(BANKS.eventTitle).flat()).filter((v) => /回目のまとめ/.test(v))).toEqual([]);
  });
});

describe("文章の波 1 の W1（事実と余白: text-w1/audit の fact-*・rep-5・rep-7）", () => {
  const rules = fromDevTree(RULES);
  const map = fromDevTree(TREE);

  it("fact-1・C11: まとめた手が言う会社員に戻る月は、標準の続きの会社員に戻る期の 3 か月目（前は期の月で、1 期早かった）", () => {
    // 標準の続きの会社員に戻る期は 2029 年 5 月に選ぶ（CONT_BACK の m 30）。戻るのはその 3 か月目の 8 月（eventMonth・back_emp は +3）
    for (const k of ["r.twins", "r.contback"]) {
      const i = byKey(rules, k);
      for (const annual of [360, 540]) {
        const b = body(rules, i, annual);
        if (k === "r.twins") expect(b).toContain("2029 年 8 月に会社員に戻り");
        expect(b).not.toContain("5 月に会社員に戻り");
        expect(eventMonthIssues(rules, i, b), `${k} ${annual}`).toEqual([]);
      }
    }
    // 前の言い方（期の月で戻ると言う）は C11 で止まる
    const twins = byKey(rules, "r.twins");
    const old = body(rules, twins).replace("2029 年 8 月に会社員に戻り", "2029 年 5 月に会社員に戻り");
    expect(eventMonthIssues(rules, twins, old)).toHaveLength(1);
    expect(checkCard(rules, twins, { ...composeMarkedCard(rules, twins, { annual: 360 }), body: old }, BANKS, wish).filter((x) => x.startsWith("C11"))).toHaveLength(1);
    // この後の目安も、会社員に戻る期に戻る月を添える（期の月と戻る月を分けて言う）
    const end = byKey(rules, "r.contback.all");
    const eb = body(rules, end);
    expect(eb).toContain("2029 年 5 月 会社員に戻る仕事探し（8 月に戻る）");
    expect(eventMonthIssues(rules, end, eb)).toEqual([]);
    expect(eventMonthIssues(rules, end, eb.replace("（8 月に戻る）", "（5 月に戻る）"))).toHaveLength(1);
    // 標準の続きの 1 期の題も同じ月
    const rows = Array.from({ length: (rules.cont(end) ?? []).length }, (_, k) => composeCont(rules, end, k, { annual: 360 })!);
    expect(rows.find((r) => r.kind === "back_emp")!.title).toBe("会社員に戻る仕事探し（8 月に戻る）");
  });

  it("fact-4: 数の行の有料の稼ぎは、書いた人数から出せる（人数 × 940 円 − サーバー代 3,000 円、学校の席は 1 席 300 円）。端数が大きければ人数の幅と平均", () => {
    const yen = (t: string): number => {
      const m = /月 ([\d,.]+) ?(万円|円)(の持ち出し)?/.exec(t)!;
      const v = Number(m[1]!.replace(/,/g, "")) * (m[2] === "万円" ? 10000 : 1);
      return m[3] ? -v : v;
    };
    let exact = 0;
    let band = 0;
    for (const m of [map, rules])
      for (const i of all(m)) {
        if (m.role(i) === "a" || (m.role(i) === "e" && m.sum(i))) continue;
        const row = composeCard(m, i, { annual: 360 }).numbers.find((x) => x.startsWith("有料"));
        if (!row) continue;
        const one = /^有料 ([\d,]+) 人（(?:うち学校の席 ([\d,]+)・)?手数料とサーバー代を引いて月 /.exec(row);
        const two = /^有料 ([\d,]+) 人か ([\d,]+) 人（手数料とサーバー代を引いて平均 月 /.exec(row);
        if (one) {
          exact++;
          const n = Number(one[1]!.replace(/,/g, ""));
          const seats = Number((one[2] ?? "0").replace(/,/g, ""));
          const want = (n - seats) * BANKS.C.netYen + seats * BANKS.C.seatYen - BANKS.C.infraYen;
          // 1 万円より下は 10 円まで、上は万円の小数 1 桁（1,000 円）まで
          expect(Math.abs(yen(row) - want), `${m.key(i)} ${row}`).toBeLessThanOrEqual(Math.abs(want) >= 10000 ? 500 : 0);
        } else if (two) {
          band++;
          const lo = Number(two[1]) * BANKS.C.netYen - BANKS.C.infraYen;
          const hi = Number(two[2]) * BANKS.C.netYen - BANKS.C.infraYen;
          expect(yen(row), `${m.key(i)} ${row}`).toBeGreaterThanOrEqual(lo - 500);
          expect(yen(row), `${m.key(i)} ${row}`).toBeLessThanOrEqual(hi + 500);
        } else expect(row, m.key(i)).toMatch(/^有料 平均 /);
      }
    expect(exact).toBeGreaterThan(10);
    // 端数のある人数（見込みの平均）は「N 人か M 人」と書き、その数の言い方も点検する（C10）
    expect(numberWording("有料 3 人か 4 人（手数料とサーバー代を引いて平均 月 200 円）")).toEqual([]);
    expect(numberWording("有料 3 人か 4 人（平均 月 200 円）")).toHaveLength(1);
    expect(band + exact).toBeGreaterThan(10);
  });

  it("fact-2〜11・fact-23（C2）: 束の文は、この地図の前提を事実や会社の決まりとして言い過ぎない", () => {
    const strings: string[] = [];
    const walk = (x: unknown): void => {
      if (typeof x === "string") strings.push(x);
      else if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === "object") Object.values(x).forEach(walk);
    };
    walk(SENTENCES);
    for (const t of strings) for (const [re, why] of OVERCLAIMS) expect(re.test(t), `${why}: ${t}`).toBe(false);
    // 前の言い方は止まる
    for (const t of ["移る月は給与の半月分が減る。", "届け出をし直さずに SpellDash を続けられる。", "広告運用は競業として認められず", "独立して最初の年は高くなりやすいので", "書類で落ちる先が多く、面接に進めなかった。", "この会社でもう一度は聞けないので", "給与（年収 360 万円）が 2028 年 1 月で止まる。"]) expect(OVERCLAIMS.some(([re]) => re.test(t)), t).toBe(true);
    // 前提の言い方: 4 月の昇給と評価・届け出の答えの時期・聞き直さないは「この地図では」
    expect(SENTENCES.cal.APRIL!.flatMap((g) => g.v).every((v) => v.startsWith("この地図"))).toBe(true);
    expect(SENTENCES.hint.flatMap((g) => g.v).filter((v) => v.includes("1 か月ほど")).every((v) => v.includes("この地図では"))).toBe(true);
    // 独立の訳: 給与が止まる月は「…から入らなくなる」「…から止まり」で言う（fact-11）
    expect(SENTENCES.avoid.ind_quit!.flatMap((g) => g.v).filter((v) => /で止まる/.test(v))).toEqual([]);
    // 広告運用を足す道は転職だけと言わない（fact-10）
    expect(SENTENCES.after.flatMap((g) => g.v).filter((v) => /広告運用を足すには、副業を認める会社への転職が要る/.test(v))).toEqual([]);
  });

  it("fact-12: 文の型が差し込みなしで書ける数は、文の型が使う数だけ（前提に無い数は C1 で止まる）", () => {
    expect(digitsOutside("資金が 6 か月分を切る前に")).toEqual(["6"]);
    expect(digitsOutside("在籍 2 年を過ぎた")).toEqual(["2"]);
    expect(digitsOutside("面接は 5 日で終わる")).toEqual(["5"]);
    expect(digitsOutside("1 人 940 円")).toEqual(["940"]);
    // 使う数は通る
    expect(digitsOutside("Pro（月 980 円）。週 10 時間と週 4 日・週 5 日。1 校。4 月と 6 月。3 か月。1 か月ほど。1 年後と 3 年後。1 社目と 2 社目。1 回。1 つと 2 つ。1 件。1 本。1 期。1 日。1 人")).toEqual([]);
  });

  it("rep-7: 届け出の結果の意味は結果ごとに 1 文で、結果の名前を言い直さない。「転職か独立」は、どちらも不可の言い換えのうち 1 つだけで言う", () => {
    for (const kind of ["ad_permside", "sd_permpro", "ad_perm"]) {
      const cells = BANKS.branch[kind]!;
      for (const [cls, groups] of Object.entries(cells))
        for (const g of groups)
          for (const v of g.v) {
            expect(v, `${kind}.${cls}`).not.toContain("。");
            expect(v, `${kind}.${cls}`).not.toMatch(/^全部可で|^全部可だが/);
          }
      expect(cells.n!.flatMap((g) => g.v).filter((v) => v.includes("転職か独立")).length, kind).toBeLessThanOrEqual(1);
    }
    expect([...SENTENCES.event.PERM_N!, ...SENTENCES.hint].flatMap((g) => g.v).filter((v) => v.includes("転職か独立"))).toEqual([]);
  });
});


describe("文章の波 1 の W2（状態のカード: text-w1/audit の con-1・con-2・rep-3・rep-4・rep-8・rep-10・rep-12・rep-14・L1〜L5）", () => {
  type Rt = ReturnType<typeof textRuntime>;
  const memo = new Map<number, { map: MapData; a: Analysis; rt: Rt }>();
  /** 小さい木（tests/fixtures/q-small）と、その年収の計算の芯の答え（画面と同じおすすめと数） */
  const qs = async (annual: number): Promise<{ map: MapData; a: Analysis; rt: Rt }> => {
    let hit = memo.get(annual);
    if (!hit) {
      const map = await loadQSmall();
      const a = analyze(compileMap(map), annual);
      memo.set(annual, (hit = { map, a, rt: textRuntime(a) }));
    }
    return hit;
  };
  const num = (x: string): number => Number(x.replace(/,/g, "").replace("−", "-"));
  /** 道の最初の状態（今日の手の結果） */
  const stateAt3 = (m: MapData, i: number): number => {
    let x = i;
    while (m.month(x) > 3) x = m.parent(m.parent(x));
    return x;
  };

  it("どの状態も、今日からの 3 年の見込み（ここまで + この先）と次の判断のおすすめの手を言い、数は画面と同じ（L1・con-7・con-1 の S2・S5）", async () => {
    for (const annual of [360, 540]) {
      const { map, a, rt } = await qs(annual);
      // ずっと今のままの 3 年は、計算の芯の「ずっと今のまま」と同じ（L4）
      expect(keepTotalOf(ctxOf(map, BANKS, annual))).toBeCloseTo(a.vSQ!, 6);
      let firsts = 0;
      let totals = 0;
      for (const i of all(map)) {
        if (map.role(i) !== "s") continue;
        const b = composeCard(map, i, { annual, rt }).body;
        // おすすめは画面のおすすめと同じ手（C13）。どの状態も言う
        expect(stateRecommendIssues(map, i, b, rt.recommended), `${map.key(i)}: ${b}`).toEqual([]);
        expect(b, `${map.key(i)}: ${b}`).toContain(`『${listNameOf(map, rt.recommended(i))}』`);
        expect(b, map.key(i)).toMatch(/3 年の見込み/);
        expect([...b].length, map.key(i)).toBeLessThanOrEqual(LIMITS.s.max);
        // 合わせて = 道の画面の「ここから一番良い選び方で進んだ 3 年の合計の見込み」（ここまでの稼ぎ + その先の一番良い選び方の値）
        const m = /今日からの 3 年の見込みは ([0-9,]+) 万円（ここまで (−?[0-9,.]+) 万円＋この先 (−?[0-9,.]+) 万円）/.exec(b);
        if (m) {
          totals++;
          expect(num(m[1]!), map.key(i)).toBe(Math.round(a.money.acc[i]! + a.pi.V[i]!));
          if (Math.abs(a.money.acc[i]!) >= 10) expect(num(m[2]!), map.key(i)).toBe(Math.round(a.money.acc[i]!));
          // 見せる数で足し算が合う
          expect(Math.abs(num(m[2]!) + num(m[3]!) - num(m[1]!)), map.key(i)).toBeLessThanOrEqual(0.5);
        }
        if (map.month(i) === 3) {
          firsts++;
          const k = /この先は、毎回おすすめの手を選んだ場合で、ずっと今のままなら 3 年で ([0-9,]+) 万円/.exec(b);
          expect(k, `${map.key(i)}: ${b}`).not.toBeNull();
          expect(num(k![1]!)).toBe(Math.round(a.vSQ!));
        } else expect(b, map.key(i)).not.toMatch(/この先は、毎回おすすめの手を選んだ場合/);
      }
      expect(firsts).toBeGreaterThan(0);
      expect(totals).toBeGreaterThan(firsts);
    }
  });

  it("q-small の状態のカードは、計算の芯つきで 1 枚の点検（C1・C2・C3・C4・C10 など。数の行の数を本文に書かない L5）を通る", async () => {
    for (const annual of [360, 540]) {
      const { map, rt } = await qs(annual);
      for (const i of all(map)) {
        if (map.role(i) !== "s") continue;
        const issues = checkCard(map, i, composeMarkedCard(map, i, { annual, rt }), BANKS, wish, annual).filter((x) => !ignorable(x));
        expect(issues, `${map.key(i)} ${annual}`).toEqual([]);
      }
    }
    expect(STATE_BUDGET).toBeLessThan(LIMITS.s.max);
  });

  it("数の枠の言い方は道の上の位置で 3 つを回し（L2: 位置で。ハッシュでない）、道 1 本の状態で同じ枠は目安の 4 回まで", async () => {
    const { map, rt } = await qs(360);
    let leaf = -1;
    for (const i of all(map)) if (map.role(i) === "e" && !map.sum(i) && pathTo(map, i).filter((x) => map.role(x) === "s").length === 11) leaf = i;
    expect(leaf).toBeGreaterThanOrEqual(0);
    const states = pathTo(map, leaf).filter((i) => map.role(i) === "s");
    const uses = new Map<string, number>();
    const total = [/^今日からの 3 年の見込みは/, /^3 年の見込みは、ここまでの/, /^ここまでの .+ 万円にこの先の/];
    for (const i of states) {
      const sents = sentencesOf(composeCard(map, i, { annual: 360, rt }).body);
      for (const f of new Set(sents.map(frameOf).filter((x): x is string => !!x && x.startsWith("構造")))) uses.set(f, (uses.get(f) ?? 0) + 1);
      const p = map.month(i) / 3 - 1;
      expect(sents.some((x) => total[p % 3]!.test(x)), `${map.key(i)} p${p}: ${sents.join("。")}`).toBe(true);
    }
    expect(Math.max(...uses.values())).toBeLessThanOrEqual(FRAME_SOFT);
  });

  it("結果の兄弟は、3 年の見込みで比べる文の言い方を兄弟の並びでずらし、比べる相手を 3 年の見込みの隣にする（rep-4）", async () => {
    const { map, rt } = await qs(360);
    let groups = 0;
    for (const a of all(map)) {
      if (map.role(a) !== "a") continue;
      const kids = Array.from({ length: map.childCount(a) }, (_, k) => map.child(a, k)).filter((o) => map.role(o) === "s");
      if (kids.length < 3) continue;
      const cmp = kids.map((o) => sentencesOf(composeCard(map, o, { annual: 360, rt }).body).find((x) => /3 年の見込み/.test(x) && /『/.test(x) && !/^今日/.test(x)) ?? null);
      if (cmp.some((x) => x === null)) continue;
      groups++;
      expect(new Set(cmp.map((x) => frameOf(x!))).size, `${map.key(a)}: ${cmp.join(" / ")}`).toBe(kids.length);
      // 比べる相手は兄弟で同じ 1 つにならない
      expect(new Set(cmp.map((x) => /『([^』]*)』/.exec(x!)![1])).size, `${map.key(a)}: ${cmp.join(" / ")}`).toBeGreaterThan(1);
    }
    expect(groups).toBeGreaterThan(0);
  });

  it("今日の手とその答えが効いている間は、状態がそれを言う。勤め先が変わったり独立したりした後は言わない（L4・rep-14）", async () => {
    const { map, rt } = await qs(360);
    let said = 0;
    let governed = 0;
    for (const i of all(map)) {
      if (map.role(i) !== "s" || map.month(i) < 6) continue;
      const fo = stateAt3(map, i);
      if (map.kind(map.parent(fo)) !== "ad_permside" || map.outId(fo) !== "s") continue;
      // 3 か月目から、ずっと同じ会社の会社員で答えが『SpellDash だけ可』のまま
      let still = true;
      for (let x = i; x !== fo; x = map.parent(map.parent(x))) if (map.st(x).j !== "e" || map.st(x).pm !== "s" || map.st(x).fl.includes("switched")) still = false;
      const b = composeCard(map, i, { annual: 360, rt }).body;
      const thread = /の結果が『SpellDash だけ』だったから|が『SpellDash だけ』だったので|『SpellDash だけ』（今日の/.test(b);
      if (still) {
        governed++;
        if (thread) said++;
      } else expect(thread, `${map.key(i)}: ${b}`).toBe(false);
    }
    expect(governed).toBeGreaterThan(0);
    // 節目からの月の文と同じ状態では言わない・長さの目安で落とすことがある
    expect(said / governed).toBeGreaterThan(0.5);
  });

  it("出来事の後の一言（con-2・rep-3・rep-12）: 据え置きの後は残る評価、担当を広げた後は 4 月の昇格の見込みの動きを言う。今のままの 2 期目からは期の数と残る判断", async () => {
    const { map, rt } = await qs(360);
    let promoNo = 0;
    let keepRun = 0;
    for (const i of all(map)) {
      if (map.role(i) !== "s") continue;
      const mv = map.parent(i);
      const b = composeCard(map, i, { annual: 360, rt }).body;
      if (map.kind(mv) === "fc_push" && map.outId(i) === "same" && /残る評価|昇格する機会は残っていない|次に狙えるのは|次の機会は/.test(b)) promoNo++;
      if (map.kind(mv) === "keep" && /今のままを選んだのは [0-9]+ 回目|何も足さない期はこれで [0-9]+ 期目|今のままはこれが [0-9]+ 期目/.test(b)) keepRun++;
    }
    expect(promoNo).toBeGreaterThan(0);
    expect(keepRun).toBeGreaterThan(0);
    // 担当を広げた 3 か月の後（手で作った地図）: 昇格の見込みが上がったと言い、「大きな変化は無かった」と言わない
    const scope = fromDevTree(F_SCOPE);
    const st = all(scope).find((i) => scope.role(i) === "s" && scope.kind(scope.parent(i)) === "fc_scope")!;
    const sb = body(scope, st);
    expect(sb).toMatch(/昇格する見込みは 3 割から 4 割に上がった|昇格の見込みが 3 割から 4 割になった|広げた分はこの地図の数には出ない/);
    expect(sb).not.toMatch(/大きな変化は無かった/);
    // 据え置きの言い方は、3 年の終わりまでに残る評価の数で選ぶ（rep-12）
    expect(BANKS.branch.fc_push!.same!.map((g) => g.if ?? "")).toEqual(["al>=2", "al=1", ""]);
  });

  it("状態の本文は、ほとんどがほかのカードと違う（rep-3: 同じになるのは数も同じ状態だけを目安に。小さい木で 1 割未満）", async () => {
    const { map, rt } = await qs(360);
    const bodies = new Map<string, number>();
    const states: number[] = [];
    for (const i of all(map)) {
      if (i === 0) continue;
      const b = composeCard(map, i, { annual: 360, rt }).body;
      bodies.set(b, (bodies.get(b) ?? 0) + 1);
      if (map.role(i) === "s") states.push(i);
    }
    const same = states.filter((i) => bodies.get(composeCard(map, i, { annual: 360, rt }).body)! > 1).length;
    expect(same / states.length).toBeLessThan(0.1);
  });

  it("状態の点検 C13: おすすめの手を言わない・画面と違う手を言う本文を見つける", async () => {
    const { map: rules } = await qs(360);
    // 画面のおすすめが今のまま（名前は「この 3 か月は今のまま」）の判断
    const st = all(rules).find((i) => rules.role(i) === "s" && rules.childCount(i) >= 2 && Array.from({ length: rules.childCount(i) }, (_, k) => rules.child(i, k)).some((x) => rules.isBase(x)))!;
    const base = Array.from({ length: rules.childCount(st) }, (_, k) => rules.child(st, k)).find((x) => rules.isBase(x))!;
    const pi = (): number => base;
    expect(stateRecommendIssues(rules, st, "2027 年 5 月、変化は無かった。", pi)).toEqual(["状態の本文が次の判断のおすすめの手を言わない"]);
    expect(stateRecommendIssues(rules, st, `おすすめは『${listNameOf(rules, pi())}』。`, pi)).toEqual([]);
    expect(stateRecommendIssues(rules, st, "おすすめは『別の手』。", pi)[0]).toMatch(/画面のおすすめ/);
    expect(stateRecommendIssues(rules, st, "次の 3 か月に選べる手は今のままだけ（この地図では、ここから先の手を分けていない）。", pi)).toEqual([]);
  });
});
