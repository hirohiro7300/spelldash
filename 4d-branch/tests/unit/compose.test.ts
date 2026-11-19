import { describe, expect, it } from "vitest";
import world from "../../scripts/impact/world.json";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";
import type { MapData } from "../../src/deepmap/mapData";
import { SENTENCES } from "../../src/demo/compose/banks/sentences";
import { adviceIn, adviceMatchers, asciiIds, checkBanks, checkCard, checkPaths, digitsOutside, numberWording, wishIndex } from "../../src/demo/compose/checks";
import { BANKS, composeCard, composeCont, composeMarkedCard, materializeBody, ripple, type Banks, type Card } from "../../src/demo/compose/index";
import { calendarOf, weekday } from "../../src/demo/compose/path";
import type { WishData } from "../../src/demo/wishlist";
import wishData from "../../src/demo/wishlist-data.json";
import { header, MIX_SPLIT, MIX_SURE, RULES, TREE } from "./composeFixture";

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
    const qw = Object.values(import.meta.glob("../../scripts/impact/q/world.ts", { eager: true }))[0] as { quarterWorld?: (w: unknown) => { q: { feeFirst: number; feeRaised: number; raiseAt: number } } } | undefined;
    const tier = qw?.quarterWorld ? qw.quarterWorld(world).q : { feeFirst: 3, feeRaised: 5, raiseAt: 4 };
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
      seatYen: Math.round(c.seatNet * 10000),
      partFactor: c.partFactor,
      schoolSeats: c.schoolSeats,
      baseHours: c.baseHours,
    });
  });

  it("今日の手は、この手の先の分かれ道（判断・出来事の分かれ・結果ごと）と行き先（まとめた見積もりを分けて）を書く", () => {
    const a = byKey(map, "r.ad_permside");
    const r = ripple(map, a);
    const c = composeCard(map, a, { annual: 360 });
    expect(c.body).toContain(`この手の先、2029 年 11 月までの分かれ道は ${r.forks}（判断 ${r.decisions}・出来事の分かれ ${r.splits}）。全部可の後 ${ripple(map, byKey(map, "r.ad_permside.a0_a1")).forks}・SpellDash だけの後`);
    expect(c.body).toContain(`行き先は ${r.ends} で、うち ${r.sumEnds} は標準の続きの見積もり。`);
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

  it("道の覚えは地図ごと: 深いカードの初めの 1 枚は道の上だけを読み、近くのカードは覚えから引く", () => {
    const counted = counting(fromDevTree(TREE));
    const deep = counted.map.indexOfKey("r.keep.all.1k.all.2k.all.3k.all.4k.all.5k.all.6k.all.7k.all.8k.all.9k.all.10k.all");
    counted.touched.clear();
    composeCard(counted.map, deep, { annual: 360 });
    // 読んだのは、今日からそのカードまでの道と、道の上の判断に並ぶ手、そのカードの子と孫だけ
    const m = counted.map;
    const allowed = new Set<number>([deep]);
    for (let x = deep; x >= 0; x = m.parent(x)) {
      allowed.add(x);
      if (m.role(x) !== "a") for (let k = 0; k < m.childCount(x); k++) allowed.add(m.child(x, k));
    }
    for (let k = 0; k < m.childCount(deep); k++) {
      const a = m.child(deep, k);
      allowed.add(a);
      for (let j = 0; j < m.childCount(a); j++) allowed.add(m.child(a, j));
    }
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
    expect(s.numbers).toEqual(["年収 360 万円（月にならして 30 万円）", "広告運用 2 社（売上 月 10 万円）", "有料 3 人（手数料とサーバー代を引いて月 200 円の持ち出し）", "月に遊んだ人 70 人（3 か月前より +19 人）", "週 57 時間（今日より +5 時間）"]);
    expect(composeCard(map, byKey(map, "r.ind_quit.cl0"), { annual: 360 }).numbers.slice(0, 2)).toEqual(["給与なし（独立）", "広告運用の顧客なし"]);
    // 学校の席は有料の人数に入っている（別に足さない。truth-5）
    expect(composeCard(map, byKey(map, "r.sd_pilot.yes.1ss.yes"), { annual: 360 }).numbers[2]).toBe("有料 40 人（うち学校の席 40・手数料とサーバー代を引いて月 1.2 万円）");
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
    expect(body(rules, sure)).toContain("この後の目安: 2027 年 2 月 今のまま（3 期） → 11 月 転職活動 → 2028 年 2 月 転職活動の続き（移る） → 5 月 昇格狙い（昇格） → ほか 1 期 → 11 月 副業の 1 社目探し（決まる） → ほか 3 期 → 2029 年 11 月（平均 月 43.1 万円）。");
    // 月の稼ぎは今の年収で決まる（給与 1.07 倍 × 月 45 万円 + 広告運用 8 + SpellDash 3）。中身の道の平均で、1 本の道の数ではない（facts-9）
    expect(body(rules, sure, 540)).toContain("→ 2029 年 11 月（平均 月 59.2 万円）。");
    expect(body(rules, split)).toContain("この後の目安: 2027 年 2 月 集客 → 5 月 別の手 → 8 月 今のまま → 2029 年 11 月（平均 月 30 万円）。");
    expect(body(rules, avg)).toContain("この後の目安: 2027 年 2 月 今のまま（3 期）");
    // 短くしても会社員に戻る期は残す（facts-9）。同じことを 2 回言わない（「会社員に戻ること（会社員に戻る）」としない。reader-5）
    const back = body(rules, byKey(rules, "r.contback.all"));
    expect(back).toContain("→ 2029 年 5 月 会社員に戻る →");
    expect(back).not.toMatch(/会社員に戻ること|（会社員に戻る）/);
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
    expect(body(rules, find(rules, "r.ind", "s", 6))).toContain("6 月に届く住民税は、会社員だった前の年の所得で決まる。");
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
    expect(at("r.carry", 6)).toContain("移る先は今の届け出の範囲を認める会社に絞ったので、広告運用の副業も SpellDash もそのまま続けられる。");
    expect(at("r.carry", 6)).not.toContain("出し直す");
    expect(at("r.keeps", 6)).toContain("移る先は SpellDash を認める会社に絞ったので、SpellDash はそのまま続けられる。");
    expect(at("r.refile", 6)).toMatch(REFILE);
    expect(body(rules, byKey(rules, "r.first.0fc_switch.high_mid"))).toContain("副業の届け出はまだ出していない。出すなら新しい会社の就業規則を読んでから。");
    // 顧客は引き継ぎ先に渡した（離れた顧客とは言わない）
    expect(at("r.handover", 6)).toContain("広告運用の顧客 2 社は、引き継ぎ先に渡して手放した。");
    expect(at("r.handover", 6)).not.toMatch(/離れた|契約の終わった/);
    const sonly = at("r.sonly", 6);
    expect(sonly).toContain("独立をやめて会社員に戻った。");
    expect(sonly).toContain("広告運用の顧客 2 社は、引き継ぎ先に渡して手放した。");
    expect(sonly).toContain("戻る先は SpellDash を認める会社に絞ったので、届け出をし直さずに SpellDash を続けられる。");
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
    expect(first).toContain("『上げて転職』なら");
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
    expect(body(rules, byKey(rules, "r.twins"))).toContain("『顧客 0 社』でも『顧客 1 社』でも、多くの道で 2029 年 5 月に会社員に戻り");
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
    expect(rows[4]!.title).toBe("転職活動の続き（移る）");
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
