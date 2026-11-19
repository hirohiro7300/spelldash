// 文章の組み立て: 地図（MapData）の 1 枚のカードの題・短い名前・本文・数の行・やることを、文の型の束（Banks）と道の数から作る
// 設計: 作業メモ SPEC v1 §4.1〜§4.3。元: 試作（R2）の compose.ts。節の並びと文の選び方は試作のまま。変えた所はその所に書く
// 決まった関数: 同じ地図・番号・年収・束なら、いつ・どの順で組み立てても同じ文になる。数はどれもデータから取り、差し込みの印で包む
// 手: 来た訳 → 書き出し → 手引きの文 → 時間とお金 → 避けたい訳 → 分かれ目 → この手の先の数（今日の手）→ まとめた手の注
// 状態: 年月と出来事 → 節目からの月 → 3 か月の変わり方 → 静かな期の一言 → 同じ手の別の結果との違い → 次の問い → 暦
// 行き先: 年月と仕事 → まとめた行き先の注 → 3 年後の数 → 節目 → 月の稼ぎ → この先の見通し
import type { MapData } from "../../deepmap/mapData";
import type { R3 } from "../impact";
import { capOf, countKind, endLink, eventsList, linkOf, ripple, sideIn, stepsFor, usedSet, type Ctx, type Ev, type Link } from "./path";
import { clPhrase, clr, cond, f2, hash, man, MS, n0, pbText, slot, strip, yenTxt, type Env } from "./text";
import type { Card, Variant } from "./types";

type Slots = Record<string, string>;

const MINUS = "−";
const sgn = (x: number): string => (x >= 0 ? "+" : MINUS);

function kidsOf(map: MapData, i: number): number[] {
  const n = map.childCount(i);
  const out = new Array<number>(n);
  for (let k = 0; k < n; k++) out[k] = map.child(i, k);
  return out;
}

/** その時点の月の稼ぎ。手は、その手を選ぶ判断の状態の値（手のカードには持たない） */
const rrOf = (c: Ctx, i: number): R3 => (c.map.role(i) === "a" ? c.map.rr(c.map.parent(i)) : c.map.rr(i));
/** 給与の倍率を、今の年収で月の万円にする */
const salMan = (c: Ctx, rr0: number): number => (c.annual / 12) * rr0;

/** カードの道の覚え: 今日・状態は自分の物、手は選ぶ判断の物、行き先はその場で作る物 */
function linkFor(c: Ctx, i: number): Link {
  const role = c.map.role(i);
  if (role === "a") return linkOf(c, c.map.parent(i));
  if (role === "e") return endLink(c, i);
  return linkOf(c, i);
}

// ---- 差し込む値と、条件に使う値

function baseEnv(c: Ctx, n: number): { env: Env; slots: Slots } {
  const { map, C, B, cal } = c;
  const s = map.st(n);
  const rr = rrOf(c, n);
  const cap = capOf(C, s.j);
  const m = map.month(n);
  const kind = map.kind(n);
  const env: Env = { j: s.j, pm: s.pm, pro: s.pro, cl: s.cl, clr: clr(s.cl), pu: s.pu, mau: s.mau, sal: s.sal, seats: s.seats, cap, m, mon: cal.parts(m)[1], n: kind ? countKind(linkFor(c, n), kind) : 0, first: m === 0 ? 1 : 0, h: 0 };
  const slots: Slots = {
    ym: cal.ym(m),
    period: cal.period(m),
    ymNext: cal.ym(m + 3),
    ym1: cal.ym(m + 1),
    ym2: cal.ymRel(m + 2, m + 1),
    job: s.j === "e" ? "会社員" : s.j === "p" ? "週 4 日勤務" : "独立",
    salx: `${slot(f2(rr[0]))} 倍`,
    salYen: `月 ${slot(man(salMan(c, rr[0])))} 万円`,
    clp: clPhrase(s.cl),
    clrNext: slot(clr(s.cl) + 1),
    ads: slot(man(s.cl * s.fee)),
    fee: slot(man(s.fee || C.sideFee)),
    sideFee: slot(man(C.sideFee)),
    indFee: slot(man(C.indFee)),
    overhead: slot(man(C.overhead)),
    spend: slot(man(C.spend)),
    cap: slot(cap),
    capInd: slot(C.capInd),
    pu: slot(n0(s.pu)),
    mau: slot(n0(s.mau)),
    sdRev: slot(man(rr[2])),
    stepYen: `月 ${slot(man(salMan(c, C.step)))} 万円`,
    seats: slot(s.seats),
    seatYen: slot(C.seatYen),
    schoolSeats: slot(C.schoolSeats),
    partx: slot(`${C.partFactor}`),
  };
  // 決まった言葉の数も差し込みの印で包む（無い束では、使う言い換えが飛ばされる）
  if (B.facts.taxPeriod !== undefined) slots.taxPeriod = B.facts.taxPeriod.replace(/(\d+)/g, (d) => slot(d));
  if (B.facts.taxLine !== undefined) slots.taxLine = slot(B.facts.taxLine);
  return { env, slots };
}

/** 型の {名前} を埋める。埋められない名前があれば null */
function fill(t: string, slots: Slots): string | null {
  let missing = false;
  const out = t.replace(/\{(\w+)\}/g, (_m, k: string) => {
    const v = slots[k];
    if (v === undefined) {
      missing = true;
      return "";
    }
    return v;
  });
  return missing ? null : out;
}

/** 条件が合う最初の組から、種で言い換えを選ぶ（埋められない言い換えは飛ばす）。使った型を trace に残す */
function choose(vs: Variant[] | undefined, env: Env, flags: readonly string[], slots: Slots, seed: number, trace: string[], tag: string): string | null {
  if (!vs) return null;
  for (let gi = 0; gi < vs.length; gi++) {
    const g = vs[gi]!;
    if (!cond(g.if, env, flags)) continue;
    for (let t = 0; t < g.v.length; t++) {
      const vi = (seed + t) % g.v.length;
      const s = fill(g.v[vi]!, slots);
      if (s !== null) {
        trace.push(`${tag}#${gi}.${vi}`);
        return s;
      }
    }
  }
  return null;
}

const join = (parts: Array<string | null | undefined>): string => parts.filter((x): x is string => !!x && !!x.trim()).join("");

// ---- 数の行（カードの上に決まった並びで出す。SPEC §4.2: 年収・広告運用・有料・遊ぶ人・週の時間）

function numbersRow(c: Ctx, i: number): string[] {
  const { map, C } = c;
  const role = map.role(i);
  // 手はその判断の状態の数（週の時間だけはその手の 3 か月）
  const at = role === "a" ? map.parent(i) : i;
  const s = map.st(at);
  const rr = map.rr(at);
  const out: string[] = [];
  if (s.j === "i") out.push("給与なし（独立）");
  else {
    const y = c.annual * rr[0];
    out.push(`年収 ${slot(n0(y))} 万円（月にならして ${slot(man(y / 12))} 万円）`);
  }
  out.push(s.cl >= 0.05 ? `広告運用 ${clPhrase(s.cl, map.ln(at))}（売上 月 ${slot(man(s.cl * s.fee))} 万円）` : "広告運用の顧客なし");
  out.push(s.pro ? `有料 ${slot(n0(s.pu))} 人（手数料とサーバー代を引いて月 ${yenTxt(rr[2])}${rr[2] < 0 ? "の持ち出し" : ""}）` : "Pro はまだ出していない");
  let mau = `月に遊んだ人 ${slot(n0(s.mau))} 人`;
  // 3 か月前（その前の判断）との差。まとめた行き先は 3 か月前の状態が無いので書かない
  if ((role === "s" || role === "e") && !map.sum(i)) {
    const dm = Math.round(s.mau) - Math.round(map.st(map.parent(map.parent(i))).mau);
    if (dm) mau += `（3 か月前より ${sgn(dm)}${slot(n0(Math.abs(dm)))} 人）`;
  }
  out.push(mau);
  // 週の時間: 今日は今のまま、手はその手の 3 か月、状態と行き先はそこへ来た 3 か月（まとめた行き先は決まらないので書かない）
  const h = role === "r" ? 0 : role === "a" ? map.hours(i) : map.sum(i) ? null : map.hours(map.parent(i));
  if (h !== null) out.push(`週 ${slot(C.baseHours + h)} 時間${h ? `（今日より ${sgn(h)}${slot(Math.abs(h))} 時間）` : ""}`);
  return out;
}

// ---- 手

const METRIC_NAME: Record<string, string> = { perm: "会社の答え", permside: "会社の答え", sal: "給与", cl: "広告運用の顧客の数", pu: "有料会員の数", mau: "遊ぶ人の数", job: "会社の返事", pilot: "試用の返事", school: "学校の返事", portfolio: "手伝った店の成果", ind: "顧客の数" };
const CAT_IDS = /^(a|a0_a1|a1|a0|s|n|high|mid|none|up|same|yes|no|p|e|i|u0|u1|u2)$/;

/** 結果の分類（分かれ目の文の型を引く鍵） */
function outcomeClass(map: MapData, o: number, sibs: readonly number[]): string {
  const id = map.outId(o) || "all";
  if (id === "all") return "all";
  if (id === "a0_a1" || id === "a1" || id === "a0") return "a";
  // 上げて転職をまとめた結果（大きく・少し）。どちらも移っている
  if (id === "high_mid") return "high";
  if (CAT_IDS.test(id)) return id;
  // 数で分けた結果: 兄弟の中で一番上の区切りなら hi、ほかは lo（試作は並びの先頭を hi としていた。並びに頼らない）
  const num = (x: number): number => {
    const mm = /(\d+)$/.exec(map.outId(x));
    return mm ? Number(mm[1]) : NaN;
  };
  const vs = sibs.map(num);
  if (vs.every((v) => Number.isFinite(v))) return num(o) === Math.max(...vs) ? "hi" : "lo";
  return sibs.indexOf(o) === 0 ? "hi" : "lo";
}

function moveShortPhrase(c: Ctx, a: number): string {
  const kind = c.map.kind(a) ?? "";
  const v = c.B.nextPhrase[kind] ?? [c.B.short[kind] ?? kind];
  return v[hash(c.map.key(a)) % v.length]!;
}

/** 分かれ目: 次の分かれ道がいつ・何で分かれ、それぞれ何を意味するか */
function watchSentence(c: Ctx, a: number, slots: Slots, trace: string[]): string {
  const { map, B, cal } = c;
  const ks = kidsOf(map, a);
  if (!ks.length) return "";
  const m = map.month(a);
  const kind = map.kind(a) ?? "";
  if (ks.length === 1) {
    const o = ks[0]!;
    const b = map.st(o);
    const s0 = map.st(a);
    const parts: string[] = [];
    if (Math.abs(b.mau - s0.mau) >= 1) parts.push(`遊ぶ人は月 ${slot(n0(s0.mau))} 人から ${slot(n0(b.mau))} 人`);
    if (b.pro && Math.round(b.pu) !== Math.round(s0.pu)) parts.push(`有料会員は ${slot(n0(s0.pu))} 人から ${slot(n0(b.pu))} 人`);
    if (clr(b.cl) !== clr(s0.cl)) parts.push(`顧客は ${clPhrase(b.cl)}`);
    if (Math.abs(b.sal - s0.sal) >= 0.005 && b.j !== "i") parts.push(`給与は今日の ${slot(f2(b.sal))} 倍`);
    // 見込みの月は結果の月（まとめた行き先は 3 年後。試作は手の 3 か月後と書いていた）。まとめた行き先は「どの場合も」と言えない
    const at = cal.ym(map.month(o));
    if (!parts.length) return `${at}まで、数字はほぼ今のまま。`;
    trace.push("watch:single");
    return `${at}の見込みは、${parts.join("、")}ほど${map.sum(o) ? "" : "（どの場合もこの道）"}。`;
  }
  const metric = map.ln(ks[0]!)?.[0] ?? "";
  const factAt = metric === "perm" || metric === "permside" ? m + 1 : m + 3;
  const nth = countKind(linkOf(c, map.parent(a)), kind);
  const mName = METRIC_NAME[metric] ?? "結果";
  const heads = [`分かれ目は ${cal.ym(factAt)}の${mName}。`, `${cal.ym(factAt)}の${mName}で道が分かれる。`, `見る数は ${cal.ym(factAt)}の${mName}。`];
  const head = heads[(hash(kind) + nth) % heads.length]!;
  if (metric === "cl" || metric === "pu" || metric === "mau") {
    // 数で分かれる: 結果の名前と、その数を 1 行で（まとめた行き先の数は 3 年後の見積もりなので、その年月を付ける）
    const num = (o: number): string => {
      const s = map.st(o);
      const t = metric === "cl" ? `月 ${slot(man(s.cl * s.fee))} 万円ほど` : metric === "pu" ? `有料 ${slot(n0(s.pu))} 人ほど` : `遊ぶ人 月 ${slot(n0(s.mau))} 人ほど`;
      return map.sum(o) ? `${cal.ym(map.month(o))}に${t}` : t;
    };
    trace.push("watch:num");
    return `${head}${ks.map((o) => `『${slot(map.label(o))}』なら${num(o)}`).join("、")}。`;
  }
  const bankKind = B.branch[kind] ? kind : "_generic";
  const bank = B.branch[bankKind] ?? {};
  const pieces: string[] = [];
  for (const o of ks) {
    const cls = outcomeClass(map, o, ks);
    const { env, slots: s2 } = baseEnv(c, o);
    const next = kidsOf(map, o).find((x) => map.kind(x) !== "keep");
    const nextKind = next === undefined ? null : (map.kind(next) ?? "");
    // 結果の数で埋め、年月だけは手の物を使う
    const s3: Slots = { ...slots, ...s2, lab: map.label(o), next1: nextKind === null ? "今のまま" : (B.nextNoun[nextKind] ?? nextKind) };
    for (const k of DATE_SLOTS) {
      const v = slots[k];
      if (v === undefined) delete s3[k];
      else s3[k] = v;
    }
    const fl = map.st(o).fl;
    const seed = hash(map.key(o));
    const cell = bank[cls] ? cls : "_any";
    const meaning = choose(bank[cell], env, fl, s3, seed, trace, `branch.${bankKind}.${cell}`) ?? choose(B.branch._generic?._any, env, fl, s3, seed, trace, "branch._generic._any");
    pieces.push(`『${slot(map.label(o))}』なら${meaning ?? ""}`);
  }
  return head + pieces.join("。") + "。";
}
const DATE_SLOTS = ["ym", "period", "ymNext", "ym1", "ym2"] as const;

/** この手の先の数（今日の手）。SPEC §5.1・truth-18: 判断と出来事の分かれを分け、まとめた行き先は見積もりと書く */
function rippleSentence(c: Ctx, a: number): string {
  const { map, cal } = c;
  const r = ripple(map, a);
  const ks = kidsOf(map, a);
  const per = ks.length >= 2 ? `${ks.map((o) => `${slot(map.label(o))}の後 ${slot(n0(ripple(map, o).forks))}`).join("・")}。` : "";
  const sums = r.sumEnds ? `で、うち ${slot(n0(r.sumEnds))} は標準の続きの見積もり` : "";
  return `この手の先、${cal.ym(cal.horizon)}までの分かれ道は ${slot(n0(r.forks))}（判断 ${slot(n0(r.decisions))}・出来事の分かれ ${slot(n0(r.splits))}）。${per}行き先は ${slot(n0(r.ends))}${sums}。`;
}

/** 避けたい手の訳に差し込む値（今の年収で決まる） */
function avoidSlots(c: Ctx, a: number): Slots {
  const { map, C } = c;
  const s = map.st(a);
  const rr0 = s.j === "p" ? s.sal * C.partFactor : s.sal;
  const sal = salMan(c, rr0);
  const ads = s.cl * s.fee;
  const capLeft = C.capInd - clr(s.cl);
  const need = Math.max(0, Math.ceil((sal + C.overhead - ads) / C.indFee - 1e-9));
  const partLoss = salMan(c, s.sal) * (1 - C.partFactor);
  const needPu = Math.ceil(partLoss / C.net);
  return { need: slot(need), needOk: need <= capLeft ? "1" : "", capLeft: slot(capLeft), salNow: `月 ${slot(man(sal))} 万円`, partLoss: `月 ${slot(man(partLoss))} 万円`, needPu: slot(n0(needPu)) };
}

function composeMove(c: Ctx, a: number): Card {
  const { map, B, C, cal } = c;
  const trace: string[] = [];
  const d = map.parent(a);
  const link = linkOf(c, d);
  const kind = map.kind(a) ?? "";
  const nth = countKind(link, kind);
  const { env, slots } = baseEnv(c, a);
  const h = map.hours(a);
  env.n = nth;
  env.h = h;
  const steps = stepsFor(c, a, nth, usedSet(link));
  const fl = map.st(a).fl;
  // 種: 道の最初の手と種類（同じ種類が続く 3 か月ごとに、書き出しが回る）
  const firstKey = map.key(link.first >= 0 ? link.first : a);
  const seed = hash(`${firstKey}|${kind}`) + nth;
  const m = map.month(a);
  const s2: Slots = { ...slots, nth: slot(nth + 1), act1: pbText(steps[0]?.act ?? ""), act2: pbText(steps[1]?.act ?? ""), stepTitle: pbText(steps[0]?.title ?? ""), hSigned: `${h >= 0 ? "+" : MINUS}${slot(Math.abs(h))}`, H: slot(C.baseHours + h) };
  const april = cal.aprils.find((q) => q > m && q <= m + 3);
  if (april !== undefined) s2.ymApril = cal.ym(april);
  s2.ymTell = cal.ym(m + 1);
  s2.ymInd = cal.ymRel(m + 2, m + 1);
  const title = choose(B.title[kind], env, fl, s2, seed, trace, `title.${kind}`) || (B.short[kind] ?? kind);
  const lead = choose(B.lead[kind], env, fl, s2, seed, trace, `lead.${kind}`) ?? "";
  // 長い節がある手（今日の手の先の数・避けたい訳）は、手引きの文を 1 つだけにする
  const oneAct = map.role(d) === "r" || map.why(a) === "avoid";
  const acts = !oneAct && steps.length >= 2 ? pbText(steps[0]!.act) + pbText(steps[1]!.act) : pbText(steps[0]?.act ?? "");
  // 時間とお金は、その種類の初めてのときと、お金や仕事が変わる手のときだけ
  const costly = nth === 0 || kind === "sd_ads" || kind === "ind_quit" || kind === "part";
  // 前の 3 か月の手（判断の 1 つ前の手）。試作は 1 つ上を見すぎていて、前と同じ手の言い方（cost._same）が使われなかった
  const pm = map.parent(d);
  const prevKind = pm >= 0 && map.role(pm) === "a" ? map.kind(pm) : null;
  const cost = !costly ? "" : ((prevKind === kind ? choose(B.cost._same, env, fl, s2, seed, trace, "cost._same") : null) ?? choose(B.cost[kind] ?? B.cost._generic, env, fl, s2, seed, trace, `cost.${B.cost[kind] ? kind : "_generic"}`) ?? "");
  const watch = watchSentence(c, a, s2, trace);
  const ripple1 = map.role(d) === "r" ? rippleSentence(c, a) : "";
  if (ripple1) trace.push("ripple");
  let avoid = "";
  if (map.why(a) === "avoid") {
    const av = avoidSlots(c, a);
    avoid = choose(B.avoid[kind], { ...env, needOk: av.needOk ? 1 : 0 }, fl, { ...s2, ...av }, seed, trace, `avoid.${kind}`) ?? "";
  }
  // まとめた手の注（truth-2: 先は一番良い選び方ではなく、標準の選び方で続けた見積もり）
  const stub = map.stub(a) ? "この手の先は分かれ道を省き、その後は標準の選び方で続けた場合の 3 年後の見積もりだけを出す。" : "";
  // ここへ来た訳: 名前の付いた結果（「どの場合も」でない）なら『結果』を受けて、そうでなければ前の 3 か月の手（状態の節目の文とは重ねない）
  const came =
    map.role(d) === "s" && map.outId(d) !== "all"
      ? `『${slot(map.label(d))}』を受けて、`
      : prevKind && prevKind !== kind
        ? `前の 3 か月は${B.nextNoun[prevKind] ?? prevKind}。`
        : "";
  const body = join([came, lead, acts, cost, avoid, watch, ripple1, stub]);
  return { title, short: B.short[kind] ?? "", body, numbers: numbersRow(c, a), todo: steps.map((st) => ({ text: st.todo, cite: st.id })), trace };
}

// ---- 状態

/** 3 か月の数の変わり方（その前の判断から。全部の状態の 1 行は右のパネルが出す） */
function changesSentence(c: Ctx, n: number, slots: Slots): string {
  const { map } = c;
  if (map.role(n) === "e") return numbersSentence(c, n, slots);
  const a = map.st(map.parent(map.parent(n)));
  const s = map.st(n);
  const parts: string[] = [];
  if (Math.abs(s.sal - a.sal) >= 0.005 || s.j !== a.j) parts.push(s.j === "i" ? "給与は無くなった" : `給与は今日の ${slots.salx}（${slots.salYen}）`);
  const da = s.cl * s.fee - a.cl * a.fee;
  if (Math.abs(da) >= 0.5) parts.push(`広告運用は月 ${slots.ads} 万円ほど（${sgn(da)}${slot(man(Math.abs(da)))} 万円）`);
  if (s.pro) {
    const dp = Math.round(s.pu) - Math.round(a.pu);
    const sd = map.rr(n)[2];
    parts.push(`有料会員は${dp ? ` 3 か月で ${sgn(dp)}${slot(Math.abs(dp))} 人の` : ""} ${slots.pu} 人（${sd >= 0 ? `月 ${yenTxt(sd)}` : `月 ${yenTxt(sd)}の持ち出し`}）`);
  }
  const dm = Math.round(s.mau) - Math.round(a.mau);
  parts.push(`遊ぶ人は月 ${slots.mau} 人${dm ? `（${sgn(dm)}${slot(n0(Math.abs(dm)))} 人）` : ""}`);
  return parts.join("、") + "。";
}

/** 節目からの月（同じ数に着いたいとこどうしでも、道ごとに違う） */
const SINCE_CODES = new Set(["IND_START", "SWITCH_HIGH", "SWITCH_MID", "PERM_A", "PERM_S", "PERM_N", "PART_ON", "PROMO", "FIRST_CLIENT", "SCHOOL_ON", "CLIENT_UP", "PILOT_ON", "PORTFOLIO_ON", "BACK_EMP"]);

function sinceClause(c: Ctx, n: number, link: Link): string {
  const m = c.map.month(n);
  const evs = eventsList(link).filter((e) => SINCE_CODES.has(e.code) && m - e.m >= 3);
  if (!evs.length) return m >= 9 ? `今日から ${slot(m)} か月、大きな節目はまだ無い。` : "";
  const last = evs[evs.length - 1]!;
  const name = fill(c.B.eventShort[last.code] ?? last.code, last.x) ?? "";
  return `${name}から ${slot(m - last.m)} か月。`;
}

/** その時点の数（行き先の 3 年後の数） */
function numbersSentence(c: Ctx, n: number, slots: Slots): string {
  const { map } = c;
  const s = map.st(n);
  const parts: string[] = [];
  if (s.j === "e") parts.push(`給与は今日の ${slots.salx}（${slots.salYen}）`);
  else if (s.j === "p") parts.push(`週 4 日勤務で給与は今日の ${slots.salx}（${slots.salYen}）`);
  else {
    const from = linkFor(c, n).indFrom;
    if (from !== null) parts.push(`独立して ${slot(map.month(n) - from + 1)} か月目`);
  }
  if (s.cl >= 0.05) parts.push(`広告運用の顧客は ${clPhrase(s.cl, map.ln(n))}（月 ${slots.ads} 万円ほど）`);
  else if (s.j === "i") parts.push("顧客はまだ無い");
  else if (s.pm === "a") parts.push("副業の顧客はまだ無い");
  const sd = map.rr(n)[2];
  if (s.pro) parts.push(`Pro は有料 ${slots.pu} 人（手数料とサーバー代を引いて${sd >= 0 ? `月 ${yenTxt(sd)}` : `月 ${yenTxt(sd)}の持ち出し`}）・遊ぶ人 月 ${slots.mau} 人`);
  else parts.push(`SpellDash は無料のまま遊ぶ人 月 ${slots.mau} 人`);
  if (s.seats >= 0.5) parts.push(`学校の席 ${slots.seats}`);
  return parts.join("、") + "。";
}

/** 同じ手の別の結果（一番違う物）との違い */
function contrastSentence(c: Ctx, o: number): string {
  const { map } = c;
  const move = map.parent(o);
  const sibs = kidsOf(map, move).filter((x) => x !== o);
  if (!sibs.length) return "";
  const so = map.st(o);
  const score = (x: number): number => {
    const sx = map.st(x);
    return Math.abs(sx.cl * sx.fee - so.cl * so.fee) + Math.abs(sx.pu - so.pu) * 0.1 + Math.abs(sx.sal - so.sal) * 30 + (sx.pm !== so.pm ? 5 : 0) + (sx.j !== so.j ? 10 : 0);
  };
  // 並べ替えは安定なので、同点なら並びの先の兄弟
  const sib = sibs.slice().sort((x, y) => score(y) - score(x))[0]!;
  const ss = map.st(sib);
  const d: string[] = [];
  const dAds = so.cl * so.fee - ss.cl * ss.fee;
  if (Math.abs(dAds) >= 0.5) d.push(`広告運用の売上が月 ${slot(man(Math.abs(dAds)))} 万円${dAds > 0 ? "多い" : "少ない"}`);
  const dPu = Math.round(so.pu) - Math.round(ss.pu);
  if (Math.abs(dPu) >= 1) d.push(`有料会員が ${slot(Math.abs(dPu))} 人${dPu > 0 ? "多い" : "少ない"}`);
  const dSal = salMan(c, map.rr(o)[0]) - salMan(c, map.rr(sib)[0]);
  if (Math.abs(dSal) >= 0.5) d.push(`給与が月 ${slot(man(Math.abs(dSal)))} 万円${dSal > 0 ? "高い" : "低い"}`);
  if (so.pm !== ss.pm && so.pm !== "?" && ss.pm !== "?") d.push(so.pm === "a" ? "広告運用の副業もできる" : so.pm === "s" ? "Pro は出せるが広告運用はできない" : "Pro も副業も出せない");
  if (!d.length) return `同じ手で『${slot(map.label(sib))}』だった場合と、数字はほとんど変わらない。`;
  return `同じ手で『${slot(map.label(sib))}』だった場合より、${d.slice(0, 2).join("、")}。`;
}

/** 次の 3 か月の問い（言い方は 3 通りを回す） */
function nextSentence(c: Ctx, n: number): string {
  const { map, cal } = c;
  const alts = kidsOf(map, n).filter((x) => map.kind(x) !== "keep");
  if (!alts.length) return "次の 3 か月も今のまま続ける。";
  const ph = alts.slice(0, 3).map((a) => moveShortPhrase(c, a));
  const frames = [`次の 3 か月は、${ph.join("、")}、今のままか。`, `${cal.ym(map.month(n) + 3)}までの手は、${ph.join("、")}、今のままか。`, `ここからは、${ph.join("、")}、何も足さないか。`];
  return frames[hash(map.key(n) + "next") % frames.length]!;
}

/** 次の 3 か月の暦（確定申告・住民税・4 月・辞める前）。1 つだけ */
function calSentence(c: Ctx, n: number, link: Link, env: Env, slots: Slots, trace: string[]): string {
  const { map, B, cal } = c;
  const m = map.month(n);
  const s = map.st(n);
  const months = [1, 2, 3].map((k) => cal.parts(m + k));
  const kinds = new Set(kidsOf(map, n).map((x) => map.kind(x)));
  const codes: string[] = [];
  const febMar = months.find(([, mo]) => mo === 2 || mo === 3);
  if (febMar) {
    const inc = sideIn(c, link, febMar[0] - 1);
    if (s.j === "i" || inc > 20) codes.push("TAX");
  }
  if (months.some(([, mo]) => mo === 6) && sideIn(c, link, cal.parts(m)[0] - 1) > 0 && s.j !== "i") codes.push("JUMIN");
  if (months.some(([, mo]) => mo === 4) && s.j !== "i") codes.push(kinds.has("sd_school") || s.fl.includes("pilot") ? "SCHOOLYEAR" : "APRIL");
  if (kinds.has("ind_quit") || kinds.has("fc_switch") || kinds.has("fc_switch2")) codes.push("LEAVE");
  for (const code of codes) {
    const y = febMar ? febMar[0] - 1 : cal.parts(m)[0];
    const t = choose(B.cal[code], env, s.fl, { ...slots, taxYear: `${slot(y)} 年分` }, hash(map.key(n) + code), trace, `cal.${code}`);
    if (t) return t;
  }
  return "";
}

function composeState(c: Ctx, n: number): Card {
  const { map, B } = c;
  const trace: string[] = [];
  const { env, slots } = baseEnv(c, n);
  const link = linkOf(c, n);
  const evs = link.evs;
  const s = map.st(n);
  const before = map.st(map.parent(n));
  const evText = evs
    .filter((e) => !e.quiet)
    .slice(0, 2)
    .map((e) => {
      // その出来事の型が無ければ、種類を落とした名前（QUIET_fc_push → QUIET）の型
      const bare = e.code.replace(/_[a-z_0-9]+$/, "");
      const cell = B.event[e.code] ? e.code : B.event[bare] ? bare : "QUIET";
      return choose(B.event[cell], env, s.fl, { ...slots, ...e.x, pu0: slot(n0(before.pu)), mau0: slot(n0(before.mau)) }, hash(map.key(n) + e.code), trace, `event.${cell}`);
    })
    .filter((x): x is string => !!x)
    .join("");
  // 出来事の文が年月から始まるなら、状態の年月とは文を分ける
  const head = evText.startsWith(MS) || !evText ? `${slots.ym}。${evText}` : `${slots.ym}、${evText}`;
  const quiet = evs.every((e) => e.code.startsWith("QUIET") || e.quiet);
  const hint = quiet ? choose(B.hint, env, s.fl, slots, hash(map.key(n) + "hint"), trace, "hint") : "";
  const body = join([head, sinceClause(c, n, link), changesSentence(c, n, slots), hint, contrastSentence(c, n), nextSentence(c, n), calSentence(c, n, link, env, slots, trace)]);
  const top = evs[0];
  const title = top ? stateTitle(c, n, top, env, slots, trace) : "";
  // 短い名前: 一番の出来事の短い名前（試作は {nth} などを埋めずに返していた）
  const short = top ? (fill(B.eventShort[top.code] ?? "", { ...slots, ...top.x }) ?? "") : "";
  return { title, short, body, numbers: numbersRow(c, n), todo: [], trace };
}

function stateTitle(c: Ctx, n: number, top: Ev, env: Env, slots: Slots, trace: string[]): string {
  const { map, B } = c;
  const cell = B.eventTitle[top.code] ? top.code : "_default";
  return choose(B.eventTitle[cell], env, map.st(n).fl, { ...slots, ...top.x }, hash(map.key(n)), trace, `eventTitle.${cell}`) ?? "";
}

// ---- 3 年後の行き先

/** 行き先の節目に並べる出来事（大事な順） */
const MILESTONE_RANK = ["IND_START", "BACK_EMP", "SWITCH_HIGH", "SWITCH_MID", "PERM_A", "PERM_S", "PERM_N", "PART_ON", "PROMO", "FIRST_CLIENT", "SCHOOL_ON", "CLIENT_UP", "PILOT_ON", "PU_MILE", "PORTFOLIO_ON", "CLIENT_LOST", "PRO_START"];

function composeEnd(c: Ctx, n: number): Card {
  const { map, B } = c;
  const trace: string[] = [];
  const { env, slots } = baseEnv(c, n);
  const link = endLink(c, n);
  // 節目: 大事な物から 4 つまで（同じ出来事は道で最初の 1 回）、それを月の順に
  const rank = (e: Ev): number => MILESTONE_RANK.indexOf(e.code);
  const ms = eventsList(link)
    .filter((e) => rank(e) >= 0)
    .sort((x, y) => rank(x) - rank(y))
    .filter((e, i, arr) => arr.findIndex((x) => x.code === e.code && (e.code !== "CLIENT_UP" || x.x.nth === e.x.nth) && (e.code !== "PU_MILE" || x.x.mile === e.x.mile)) === i)
    .slice(0, 4)
    .sort((x, y) => x.m - y.m);
  let prev: number | null = null;
  const msText = ms
    .map((e) => {
      const t = `${c.cal.ymRel(e.m, prev)}に${fill(B.eventShort[e.code] ?? e.code, { ...slots, ...e.x }) ?? ""}`;
      prev = e.m;
      return t;
    })
    .join("、");
  const s = map.st(n);
  const rr = map.rr(n);
  const total = salMan(c, rr[0]) + rr[1] + rr[2];
  const head = `${slots.ym}（3 年後）、${slots.job}。`;
  const nums = numbersSentence(c, n, slots);
  const path = msText ? `ここまでの節目は、${msText}。` : "";
  const sm = (x: number): string => `${x <= -0.05 ? MINUS : ""}${slot(man(Math.abs(x)))}`;
  const monthly = `この時の月の稼ぎは ${slot(man(total))} 万円（給与 ${sm(salMan(c, rr[0]))}・広告運用 ${sm(rr[1])}・SpellDash ${sm(rr[2])}）。`;
  const after = choose(B.after, env, s.fl, slots, hash(map.key(n)), trace, "after") ?? "";
  // まとめた行き先の注（truth-2: 標準の選び方で続けた見積もり）
  const sum = map.sum(n) ? "この行き先は、手の後に標準の選び方で続けた場合の見積もり。" : "";
  const body = join([head, sum, nums, path, monthly, after]);
  // 題: 一番大きい事実を 2 つまで
  const facts: string[] = [];
  if (s.j === "i") facts.push(`独立・顧客 ${clPhrase(s.cl)}`);
  else if (s.fl.includes("switched")) facts.push(`転職で給与 ${slot(f2(s.sal))} 倍`);
  else if (s.j === "p") facts.push("週 4 日勤務");
  if (s.j !== "i" && s.cl >= 0.5) facts.push(`副業 ${clPhrase(s.cl)}`);
  if (s.pro && s.pu >= 1) facts.push(`有料 ${slot(n0(s.pu))} 人`);
  if (!facts.length) facts.push(s.pm === "n" ? "副業は不可のまま" : `給与 ${slot(f2(s.sal))} 倍`);
  let title = `3 年後: ${facts.slice(0, 2).join("と")}`;
  if ([...strip(title)].length > 24) title = `3 年後: ${facts[0]}`;
  return { title, short: "", body, numbers: numbersRow(c, n), todo: [], trace };
}

// ---- 今日

function composeRoot(c: Ctx, i: number): Card {
  const { map, cal } = c;
  const r = ripple(map, i);
  // 今日の手の「この手の先」の文と同じ骨組みにしない（道の画面で今日と今日の手は並ぶ）
  const sums = r.sumEnds ? `（うち ${slot(n0(r.sumEnds))} は標準の続きの見積もり）` : "";
  const body = `${cal.ym(map.month(i))}時点の地図。ここから ${cal.ym(cal.horizon)}まで、3 か月ごとに手を 1 つずつ選ぶ（${slot(Math.round((cal.horizon - map.month(i)) / 3))} 回）。今日選べる手は ${slot(map.childCount(i))} 通りで、その先の分かれ道は合わせて ${slot(n0(r.forks))}（判断 ${slot(n0(r.decisions))}・出来事の分かれ ${slot(n0(r.splits))}）、3 年後の行き先は ${slot(n0(r.ends))}${sums}。`;
  return { title: "今日: 会社員と SpellDash 週 10 時間", short: "今日", body, numbers: numbersRow(c, i), todo: [], trace: ["root"] };
}

/** 1 枚のカードを組み立てる（差し込みの印つき。仕上げは ./index.ts） */
export function composeMarked(c: Ctx, i: number): Card {
  switch (c.map.role(i)) {
    case "a":
      return composeMove(c, i);
    case "s":
      return composeState(c, i);
    case "e":
      return composeEnd(c, i);
    default:
      return composeRoot(c, i);
  }
}
