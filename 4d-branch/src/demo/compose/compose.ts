// 文章の組み立て: 地図（MapData）の 1 枚のカードの題・短い名前・本文・数の行・やることを、文の型の束（Banks）と道の数から作る
// 設計: 作業メモ SPEC v1 §4.1〜§4.3。元: 試作（R2）の compose.ts。SPEC §4.2 と見直し（reader-*・facts-*・code-*）で変えた所は、その所に書く
// 決まった関数: 同じ地図・番号・年収・束なら、いつ・どの順で組み立てても同じ文になる。数はどれもデータから取り、差し込みの印で包む。
//   題は年収で変わらない（題は兄弟ごとに覚えるので、年収で変わる数を題に入れない。code-1）
// 数の行（SPEC §4.2・user-9b）: 年収・広告運用・有料・遊ぶ人・週の時間は数の行に出し、今日・状態・行き先の本文には書かない
// 道で 1 回だけ（SPEC §4.2・C9）: 暦の文（確定申告はその年分ごとに）・辞める前の文・静かな期の一言・出来事の助言・避けたい訳は、
//   道（今日からそのカードまで）の上で組ごとに 1 回だけ。どれを使ったかは判断の覚え（Link）ごとの「段取り」（Plan）に残し、道だけで決まる
// まとめた結果（facts-1・reader-3・reader-9）: 事実の場合（昇格と据え置きなど）や社数の違う場合をまとめた結果は、どちらか一方の事実として
//   言わず、まとめた見積もりだと書く（見込みが分かれば割で）
// 手: 来た訳 → 書き出し → 手引きの文 → お金と仕事の変わり方・見込みの変わり方 → 避けたい訳 → 分かれ目 → この手の 3 年の見積もり →
//   この手の先の分かれ道の数（まとめた手は、標準の選び方で続けた見積もりだと書く）
// 状態（0.8・W2）: 年月と出来事 → 出来事の助言 → 出来事の後の一言 → 節目からの月（節目が変わったときだけ）→ 静かな期の一言 →
//   この結果の見込みと月の稼ぎの動き → 今日の手の効き目 → 今日からの 3 年の見込み → 同じ手の別の結果との 3 年の見込みの差と次の手の並びの違い →
//   今日の手の先の分かれ道のうちここから残る数 → 次の手（おすすめとほかの手との差）→ 暦。長さの目安を超えるときは決まった順に短くする
// 行き先: 年月と仕事 → まとめた行き先の注 → 節目 → 月の稼ぎ → 今日からこの道の 3 年の稼ぎとずっと今のままとの差（0.9・R6）→ この先の見通し →
//   この道で月の稼ぎを一番動かした結果（まとめた行き先は、標準の続きの目安）
import type { MapContStep, MapData, MapMix } from "../../deepmap/mapData";
import type { ImpactSt, R3 } from "../impact";
import { accOf, capOf, clBand, landing, countEvent, countKind, countKindHere, endLink, eventMonth, eventsList, factShare, FAMILY, FILING_KINDS, indMonthsAt, jobMonths, joinedAt, keepTotalOf, linkFor, linkOf, mergedFact, newFeeOf, optionValue, pathEnv, quarterSal, recentSteps, recommended, ripple, searchCount, sideIn, stepsFor, usedSet, wOf, type Ctx, type Ev, type Link, type TitleEntry } from "./path";
import { clPhrase, clr, cond, f2, hash, man, n0, oneIn, pbText, renyo, slot, spaceJa, strip, wari, yenTxt, type Env } from "./text";
import type { Card, Consts, Step, Variant } from "./types";

type Slots = Record<string, string>;

const MINUS = "−";
const sgn = (x: number): string => (x >= 0 ? "+" : MINUS);
/** 字数（差し込みと手引きの印を除いた文字の数。[...strip(s)].length と同じで、配列を作らない。修正・code-4: 長さの目安で何度も数える） */
const len = (s: string): number => {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 1 && c <= 4) || (c >= 0xdc00 && c <= 0xdfff)) continue;
    n++;
  }
  return n;
};

function kidsOf(map: MapData, i: number): number[] {
  const n = map.childCount(i);
  const out = new Array<number>(n);
  for (let k = 0; k < n; k++) out[k] = map.child(i, k);
  return out;
}

/** その時点の月の稼ぎ。手は、その手を選ぶ判断の状態の値（手のカードには持たない） */
const rrOf = (c: Ctx, i: number): R3 => (c.map.role(i) === "a" ? c.map.rr(c.map.parent(i)) : c.map.rr(i));
/** 給与の倍率を、今の年収で月の万円にする（賞与込みの年収を 12 で割った額） */
const salMan = (c: Ctx, rr0: number): number => (c.annual / 12) * rr0;

// ---- 名前（英数字の名前を文に出さない。C4b・user-2）

/** 手の種類の名詞（この後の目安の並び）。束に無ければ地図の手の名前、それも無ければ言い換え */
const kindNoun = (c: Ctx, kind: string): string => c.B.nextNoun[kind] ?? c.map.header.kinds[kind]?.[0] ?? "別の手";
/** 手の種類の短い名前 */
const kindShort = (c: Ctx, kind: string): string => c.B.short[kind] ?? c.map.header.kinds[kind]?.[0] ?? "別の手";

/** 結果の名前の言い換え（地図の名前が無い・英数字のときだけ使う） */
// 名前の中に「・」を使わない（「・」でつないだ並びの中で、2 つの結果に読める。reader-5）
const OUT_NAMES: Record<string, string> = { all: "どの場合も", a: "全部可", a0_a1: "全部可", a1: "全部可（1 社目あり）", a0: "全部可（顧客まだ）", s: "SpellDash だけ", n: "どちらも不可", high: "大きく上げて転職", mid: "少し上げて転職", high_mid: "少しか大きく上げて転職", none: "転職せず", up: "昇格", same: "据え置き", yes: "決まった", no: "決まらず", p: "週 4 日に", e: "会社員に戻る", i: "独立のまま" };
const ASCII_ID = /[A-Za-z]+_[A-Za-z0-9_]*|^[\x00-\x7F]*$/;

/** 結果の名前（地図の名前。データなので差し込みの印で包む。英数字の名前なら言い換える） */
function labelOf(c: Ctx, o: number): string {
  const lab = c.map.label(o);
  if (lab && !ASCII_ID.test(lab) && lab !== c.map.outId(o)) return slot(lab);
  const id = c.map.outId(o);
  const named = OUT_NAMES[id];
  if (named) return slot(named);
  const m = /^(cl|pu|mau)(\d+)$/.exec(id);
  if (m) return m[1] === "cl" ? `顧客 ${slot(m[2]!)} 社` : m[1] === "pu" ? `有料 ${slot(m[2]!)} 人` : `月に遊んだ人 ${slot(m[2]!)} 人`;
  return "この結果";
}

// ---- 差し込む値と、条件に使う値

/**
 * 社数の違う場合をまとめた結果（幅 band.cl がある。整数の 10%〜90%）の顧客の数の言い方。無ければ null（ほかは clPhrase）。
 * 手はその判断の状態の幅。まとめた行き先は平均の言い方なので null（SPEC §2.2: 幅はまとめた結果だけ・整数の幅）
 */
function bandClients(c: Ctx, i: number): string | null {
  const { map } = c;
  const at = map.role(i) === "a" ? map.parent(i) : i;
  if (at < 0 || map.sum(at)) return null;
  const b = map.band(at)?.cl;
  if (!b) return null;
  // 幅（10%〜90%）が 1 点でも、平均が整数でなければ社数の違う場合をまとめた結果（「顧客 0〜1 社」の結果で、9 割が 1 社など）。結果の名前と同じ幅で言う（truth-7）
  const cl = map.st(at).cl;
  if (b[0] === b[1] && Math.abs(cl - b[0]) >= 0.05) return `${slot(Math.floor(cl))}〜${slot(Math.ceil(cl))} 社`;
  return b[0] === b[1] ? `${slot(b[0])} 社` : `${slot(b[0])}〜${slot(b[1])} 社`;
}

/** 顧客の数の幅（まとめた行き先は丸めた平均の 1 点） */
const clBandOf = (c: Ctx, at: number): [number, number] => (c.map.sum(at) ? [clr(c.map.st(at).cl), clr(c.map.st(at).cl)] : clBand(c.map, at));

/**
 * 束の前提の数（C）と決まった言葉から作る差し込み（どのカードでも同じ。束ごとに 1 回だけ作る）。見込みは割で（% を書かない。C4）。
 * 0.7: 前提の数はどれもここから差し込む（届け出の答え・転職・週 4 日・会社員に戻る・試用の見込み、転職活動の上限、Pro の円の額。fact-12）
 */
const CONST_SLOTS = new WeakMap<Consts, Readonly<Slots>>();
function constSlots(C: Consts): Readonly<Slots> {
  const hit = CONST_SLOTS.get(C);
  if (hit) return hit;
  const out: Slots = {
    feeRaised: slot(man(C.feeRaised)),
    raiseAt: slot(C.raiseAt),
    indFee: slot(man(C.indFee)),
    overhead: slot(man(C.overhead)),
    spend: slot(man(C.spend)),
    capInd: slot(C.capInd),
    seatYen: slot(C.seatYen),
    schoolSeats: slot(C.schoolSeats),
    partx: slot(`${C.partFactor}`),
    // 見込みは割で（% を書かない。C4）。世界の数（world.json）と同じ（reader-2）
    promoP: wari(C.promoP),
    promoPScope: wari(C.promoPScope),
    schoolP: wari(C.schoolP),
    schoolPPilot: wari(C.schoolP * C.pilotMult),
    firstP: wari(C.firstP),
    firstPPortfolio: wari(C.firstPortfolio),
    sideP: wari(C.sideP),
    sidePPortfolio: wari(C.sidePPortfolio),
    permA: wari(C.permA),
    permS: wari(C.permS),
    permN: wari(C.permN),
    switchP1: wari(C.switchP1),
    switchP2: wari(C.switchP2),
    partP: wari(C.partP),
    backP: wari(C.backP),
    pilotP: wari(C.pilotP),
    churnQ: wari(C.churnQ),
    searchMax: slot(C.searchMax),
    searchRun: slot(C.searchRun),
    netYen: slot(n0(C.netYen)),
    infraYen: slot(n0(C.infraYen)),
    // 0.8（W2）: 状態の出来事の後の一言が言う前提（週 4 日で持てる顧客・遊ぶ人の伸びと有料になる割合・集客の手の上限）
    capPart: slot(C.capPart),
    growth: wari(C.growth),
    conv: wari(C.conv),
    growMax: slot(C.growMax),
    adsMax: slot(C.adsMax),
    // 0.9（code-8）: 続ける人を増やす工夫が効く回数（q/quarter.ts の LIMITS と同じ。文に数を書かない）
    retainMax: slot(C.retainMax),
  };
  CONST_SLOTS.set(C, out);
  return out;
}

function baseEnv(c: Ctx, n: number): { env: Env; slots: Slots } {
  const { map, C, B, cal } = c;
  const s = map.st(n);
  const rr = rrOf(c, n);
  const cap = capOf(C, s.j);
  const m = map.month(n);
  const kind = map.kind(n);
  const link = linkFor(c, n);
  const at = map.role(n) === "a" ? map.parent(n) : n;
  const [clo, chi] = clBandOf(c, at);
  // 次に増える顧客の月額（副業は 3 万円、4 社に届いた後は 5 万円、独立は 7 万円。データの前提と同じ段。facts-2）
  const newFee = newFeeOf(C, s.j, link.f5);
  // cband: 顧客の数が社数の違う場合をまとめた幅（下と上が違う）。「N 社目」と社数を決めて言わない（truth-3）
  // im: 独立してからの月（手はその判断の月、状態と行き先はその月。会社員に戻る仕事探しと決まらない期の言い方を進める。rep-5）
  const im = indMonthsAt(link, m, s.j);
  // al: この月より後、3 年の終わりまでに残る 4 月の評価の数（据え置きの後の言い方・状態の出来事の後の一言。rep-12）
  const al = cal.aprils.filter((q) => q > m && q <= cal.horizon).length;
  const env: Env = { j: s.j, pm: s.pm, pro: s.pro, cl: s.cl, clr: clr(s.cl), clo, chi, cband: clo !== chi ? 1 : 0, pu: s.pu, mau: s.mau, sal: s.sal, seats: s.seats, cap, m, mon: cal.parts(m)[1], n: kind ? countKind(link, kind) : 0, first: m === 0 ? 1 : 0, h: 0, sal1: Math.abs(rr[0] - 1) < 0.005 ? 1 : 0, f5: link.f5 ? 1 : 0, im, al };
  const slots: Slots = {
    ...constSlots(C),
    // 0 か月目（今日）の手は今月から言う（user-17: 地図の年月は見出しにあり、今日の手は「今月のうちに」）
    ym: m === 0 ? "今月" : cal.ym(m),
    period: m === 0 ? `この 3 か月（${cal.period(0)}）` : cal.period(m),
    ymNext: cal.ym(m + 3),
    ym1: cal.ym(m + 1),
    ym2: cal.ymRel(m + 2, m + 1),
    job: s.j === "e" ? "会社員" : s.j === "p" ? "週 4 日勤務" : "独立",
    salx: `${slot(f2(rr[0]))} 倍`,
    // 給与は賞与込みの年収で言う（月の手取りと読み違えないように。truth-15）
    salYen: `年収 ${slot(n0(c.annual * rr[0]))} 万円`,
    clp: bandClients(c, n) ?? clPhrase(s.cl),
    clrNext: slot(clr(s.cl) + 1),
    ads: slot(man(s.cl * s.fee)),
    fee: slot(man(s.fee || newFee)),
    newFee: slot(man(newFee)),
    cap: slot(cap),
    pu: slot(n0(s.pu)),
    mau: slot(n0(s.mau)),
    sdRev: slot(man(rr[2])),
    seats: slot(n0(s.seats)),
    indMonths: slot(im),
    aprilsLeft: slot(al),
    hz: cal.ym(cal.horizon),
  };
  const april = cal.aprils.find((q) => q > m);
  if (april !== undefined) slots.nextApril = cal.ym(april);
  // 決まった言葉の数も差し込みの印で包む（無い束では、使う言い換えが飛ばされる）
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

/** 組 g の言い換えのうち、埋められる物（種で選ぶ）。無ければ null */
function pickIn(g: Variant, slots: Slots, seed: number): [number, string] | null {
  for (let t = 0; t < g.v.length; t++) {
    const vi = (((seed + t) % g.v.length) + g.v.length) % g.v.length;
    const s = fill(g.v[vi]!, slots);
    if (s !== null) return [vi, s];
  }
  return null;
}

/** 使った文の型の名前は種類が少ないので、同じ文字列を使い回す（題の覚えが 8 万枚ぶん溜まっても膨らまない） */
const TAGS = new Map<string, string>();
const tagOf = (tag: string, gi: number, vi: number): string => {
  const k = `${tag}#${gi}.${vi}`;
  let t = TAGS.get(k);
  if (t === undefined) {
    t = k;
    TAGS.set(k, t);
  }
  return t;
};

/** 条件が合う最初の組から、種で言い換えを選ぶ（埋められない言い換えは飛ばす）。使った型を trace に残す */
function choose(vs: Variant[] | undefined, env: Env, flags: readonly string[], slots: Slots, seed: number, trace: string[], tag: string): string | null {
  if (!vs) return null;
  for (let gi = 0; gi < vs.length; gi++) {
    const g = vs[gi]!;
    if (!cond(g.if, env, flags)) continue;
    const hit = pickIn(g, slots, seed);
    if (hit) {
      trace.push(tagOf(tag, gi, hit[0]));
      return hit[1];
    }
  }
  return null;
}

/** 組 gi の言い換えを、種で選んで使う（段取りで決めた組。trace に残す） */
function useGroup(vs: Variant[] | undefined, gi: number, slots: Slots, seed: number, trace: string[], tag: string): string {
  const g = vs?.[gi];
  const hit = g ? pickIn(g, slots, seed) : null;
  if (!hit) return "";
  trace.push(tagOf(tag, gi, hit[0]));
  return hit[1];
}

/** 条件が合い、使っていない（used が偽の）最初の組の番号 */
function freeGroup(vs: Variant[] | undefined, env: Env, flags: readonly string[], slots: Slots, key: (gi: number) => string, used: (k: string) => boolean): number | null {
  if (!vs) return null;
  for (let gi = 0; gi < vs.length; gi++) {
    const g = vs[gi]!;
    if (!cond(g.if, env, flags) || used(key(gi)) || !pickIn(g, slots, 0)) continue;
    return gi;
  }
  return null;
}

const join = (parts: Array<string | null | undefined>): string => parts.filter((x): x is string => !!x && !!x.trim()).join("");

/** 出来事の年月の差し込み（ref の月と同じ年なら月だけ。ref の月そのものは「この月」: カードの書き出しの年月を文の頭で言い直さない。点検 C8） */
function evSlots(c: Ctx, e: Ev, ref: number): Slots {
  const out: Slots = { ...e.x };
  for (const [k, m] of Object.entries(e.at ?? {})) out[k] = m === ref ? "この月" : c.cal.ymRel(m, ref);
  return out;
}

/** 出来事の文の型を選ぶ条件の値（状態の値・道でその出来事が何回目か・出来事の条件） */
const evEnv = (env: Env, e: Ev, evn: number): Env => ({ ...env, evn, ...(e.env ?? {}) });

// ---- 道で 1 回だけの文の段取り（判断の覚えごと。道だけで決まり、年収では変わらない）

interface CalPick {
  code: string;
  key: string;
  year: number;
  back: boolean;
  /** その年分に広告運用の稼ぎがあるか（無ければ SpellDash の所得とだけ言う。reader-6） */
  ad: boolean;
}

interface Plan {
  /** この状態（とそこへ来た手）が使った、道で 1 回だけの文の鍵 */
  readonly keys: readonly string[];
  readonly cal: CalPick | null;
  readonly hint: number | null;
  readonly tips: ReadonlyArray<readonly [string, number]>;
  /** 節目の鍵（節目からの月の文。親の状態と違うときだけ書く） */
  readonly sinceKey: string | null;
  /** 同じ手の別の結果との違いで、届け出の答えの範囲を言うか（答えごとに道で 1 回だけ。出来事の文が答えを言うなら言わない） */
  readonly perm: boolean;
}

const NO_PLAN: Plan = { keys: [], cal: null, hint: null, tips: [], sinceKey: null, perm: false };
const PLANS = new WeakMap<Link, Plan>();

/** 道（link から今日まで）で、その鍵の文を使ったか */
function usedOn(c: Ctx, link: Link | null, key: string): boolean {
  for (let l = link; l; l = l.up) if (planOf(c, l).keys.includes(key)) return true;
  return false;
}

function planOf(c: Ctx, link: Link): Plan {
  const hit = PLANS.get(link);
  if (hit) return hit;
  const p = link.up ? makePlan(c, link) : NO_PLAN;
  PLANS.set(link, p);
  return p;
}

/**
 * 避けたい訳を書くか（道で 1 回だけ）。手のカードと、その先の状態の段取りで同じ答えになる。
 * 組（足りる・届かない）は年収で変わるので、鍵は種類ごと（段取りは年収で変わらない）
 */
function avoidAllowed(c: Ctx, a: number, up: Link): boolean {
  const { map, B } = c;
  if (map.why(a) !== "avoid") return false;
  const kind = map.kind(a) ?? "";
  return !!B.avoid[kind]?.length && !usedOn(c, up, `avoid.${kind}`);
}

function makePlan(c: Ctx, link: Link): Plan {
  const { map, B } = c;
  const n = link.i;
  const up = link.up!;
  const keys: string[] = [];
  const used = (k: string): boolean => keys.includes(k) || usedOn(c, up, k);
  // その状態へ来た手の、避けたい訳
  if (avoidAllowed(c, link.move, up)) keys.push(`avoid.${map.kind(link.move) ?? ""}`);
  if (map.role(n) !== "s") return { keys, cal: null, hint: null, tips: [], sinceKey: null, perm: false };
  const { env, slots } = stateEnv(c, n, link);
  const fl = map.st(n).fl;
  // 出来事の助言（文に出す 2 つまでの出来事）
  const tips: Array<[string, number]> = [];
  for (const e of shownEvents(link)) {
    const g = freeGroup(B.tip[e.code], evEnv(env, e, 0), fl, { ...slots, ...evSlots(c, e, map.month(n)) }, (gi) => `tip.${e.code}#${gi}`, used);
    if (g === null) continue;
    tips.push([e.code, g]);
    keys.push(`tip.${e.code}#${g}`);
  }
  // 静かな期の一言
  let hint: number | null = null;
  if (isQuiet(link)) {
    hint = freeGroup(B.hint, env, fl, slots, (gi) => `hint#${gi}`, used);
    if (hint !== null) keys.push(`hint#${hint}`);
  }
  // 暦の文（1 つだけ）。確定申告は「同じ申告の 2 年目」を言い分けるので、申告の種類も覚える
  const cal = calPick(c, link, env, slots, used);
  if (cal) keys.push(cal.key, `calcode:${cal.code}`);
  // 届け出の答えの範囲の一言（「この場合は Pro は出せるが、広告運用はできない」）は、答えごとに道で 1 回だけ。
  // 出来事の文が答えを言う状態（届け出の答えが出た 3 か月）では言い直さない（reader-8）
  const pk = permKey(c, n);
  const perm = pk !== null && !used(pk) && !link.evs.some((e) => e.code.startsWith("PERM_"));
  if (perm) keys.push(pk!);
  return { keys, cal, hint, tips, sinceKey: sinceKeyOf(c, link), perm };
}

// ---- 数の行（カードの上に決まった並びで出す。SPEC §4.2: 年収・広告運用・有料・遊ぶ人・週の時間）

function numbersRow(c: Ctx, i: number): string[] {
  const { map, C } = c;
  const role = map.role(i);
  if (role === "e" && map.sum(i)) return sumNumbers(c, i);
  // 手はその判断の状態の数（週の時間だけはその手の 3 か月）
  const at = role === "a" ? map.parent(i) : i;
  const s = map.st(at);
  const rr = map.rr(at);
  const link = role === "e" ? endLink(c, i) : linkOf(c, at);
  const out: string[] = [];
  // 昇格と据え置きなどをまとめた後の給与は平均（facts-1）
  out.push(salaryItem(c, s, rr[0], link.salMix ? "平均 " : ""));
  out.push(clientItem(c, at));
  out.push(proItem(c, s, rr[2], ""));
  let mau = `月に遊んだ人 ${slot(n0(s.mau))} 人`;
  // 3 か月前（その前の判断）との差
  if (role === "s" || role === "e") {
    const dm = Math.round(s.mau) - Math.round(map.st(map.parent(map.parent(i))).mau);
    if (dm) mau += `（3 か月前より ${sgn(dm)}${slot(n0(Math.abs(dm)))} 人）`;
  }
  out.push(mau);
  // 週の時間: 今日は今のまま、手はその手の 3 か月、状態と行き先はそこへ来た 3 か月
  const h = role === "r" ? 0 : role === "a" ? map.hours(i) : map.hours(map.parent(i));
  out.push(`週 ${slot(C.baseHours + h)} 時間${h ? `（今日より ${sgn(h)}${slot(Math.abs(h))} 時間）` : ""}`);
  return out;
}

/** 年収の項目（独立は給与なし）。avg は「平均 」などの前置き */
function salaryItem(c: Ctx, s: ImpactSt, rr0: number, avg: string): string {
  if (s.j === "i" && rr0 < 0.005) return "給与なし（独立）";
  const y = c.annual * rr0;
  return `年収 ${avg}${slot(n0(y))} 万円（月にならして ${slot(man(y / 12))} 万円）`;
}

/**
 * 広告運用の項目。社数の違う場合をまとめた結果（幅）は、1 社違いなら「0 社か 1 社」、売上は「平均」と書く
 * （どの整数の社数でもない売上を 1 本の数として書かない。reader-9・facts-1）
 */
function clientItem(c: Ctx, at: number): string {
  const { map } = c;
  const s = map.st(at);
  if (s.cl < 0.05) return "広告運用の顧客なし";
  const rev = slot(man(s.cl * s.fee));
  let [lo, hi] = clBand(map, at);
  // 幅が 1 点でも平均が整数でなければ、社数の違う場合をまとめた結果（結果の名前と同じ幅で、売上は平均。truth-7）
  if (map.band(at)?.cl && lo === hi && Math.abs(s.cl - lo) >= 0.05) [lo, hi] = [Math.floor(s.cl), Math.ceil(s.cl)];
  if (map.band(at)?.cl && lo !== hi) return `広告運用 ${hi - lo === 1 ? `${slot(lo)} 社か ${slot(hi)} 社` : `${slot(lo)}〜${slot(hi)} 社`}（平均 月 ${rev} 万円）`;
  return `広告運用 ${bandClients(c, at) ?? clPhrase(s.cl, map.ln(at))}（売上 月 ${rev} 万円）`;
}

/**
 * 有料の項目（学校の席は有料の人数に入っている。truth-5）。Pro の前もサーバー代はかかる（本文の月の稼ぎと合わせる。reader-4）。
 * 0.7（fact-4）: 有料の人数は見込みの平均で端数があるので、顧客の数（clientItem）と同じく、整数に近ければその人数と、その人数から出した稼ぎ
 * （人数 × 手数料を引いた 1 人の額 − サーバー代。学校の席は席の額）、端数が大きければ「N 人か M 人」と平均の稼ぎを書く
 * （書いた人数から稼ぎを出し直せる・持ち出しの向きが人数と食い違わない）。学校の席が 1 校の席の倍数でない（導入をまとめた平均）なら平均と書く
 */
function proItem(c: Ctx, s: ImpactSt, rr2: number, avg: string): string {
  const { C } = c;
  if (!s.pro) return rr2 < -0.005 ? `Pro はまだ出していない（サーバー代 月 ${yenTxt(rr2)}の持ち出し）` : "Pro はまだ出していない";
  const clean = s.seats < 0.5 || s.seats % C.schoolSeats === 0;
  const seats = s.seats >= 0.5 && clean ? `うち学校の席 ${slot(n0(s.seats))}・` : "";
  const money = (x: number): string => `月 ${yenTxt(x)}${x < -0.00005 ? "の持ち出し" : ""}`;
  const r = Math.round(s.pu);
  if (!avg && clean && Math.abs(s.pu - r) < 0.15) {
    const seatsN = s.seats >= 0.5 ? s.seats : 0;
    const exact = ((r - seatsN) * C.netYen + seatsN * C.seatYen - C.infraYen) / 10000;
    return `有料 ${slot(n0(r))} 人（${seats}手数料とサーバー代を引いて${money(exact)}）`;
  }
  const lo = Math.floor(s.pu);
  const hi = Math.ceil(s.pu);
  if (avg || !clean || lo === hi) return `有料 平均 ${slot(n0(s.pu))} 人（${seats}手数料とサーバー代を引いて${money(rr2)}）`;
  return `有料 ${slot(n0(lo))} 人か ${slot(n0(hi))} 人（${seats}手数料とサーバー代を引いて平均 ${money(rr2)}）`;
}

/** まとめた行き先の数の行: 中身の幅（mix）があれば幅で、無ければ平均と書く（truth-5。顧客と席は整数だけ） */
function sumNumbers(c: Ctx, i: number): string[] {
  const { map } = c;
  const mix = map.mix(i);
  if (mix) return mixNumbers(c, mix);
  const s = map.st(i);
  const rr = map.rr(i);
  const out: string[] = [salaryItem(c, s, rr[0], "平均 ")];
  out.push(s.cl >= 0.05 ? `広告運用 平均 ${avgClientsRow(s.cl)}（売上 月 ${slot(man(s.cl * s.fee))} 万円ほど）` : "広告運用の顧客なし");
  // Pro: 一番多い場合が「まだ」でも、平均の有料会員がいれば書く（平均と書く）
  if (s.pro || s.pu >= 0.5) out.push(`有料 平均 ${slot(n0(s.pu))} 人（手数料とサーバー代を引いて月 ${yenTxt(rr[2])}${rr[2] < 0 ? "の持ち出し" : ""}）`);
  else out.push("Pro はまだ出していない");
  if (s.seats >= 0.5) out.push(s.seats % c.C.schoolSeats === 0 ? `学校の席 ${slot(n0(s.seats))}` : "学校の導入がある道も含む");
  out.push(`月に遊んだ人 平均 ${slot(n0(s.mau))} 人`);
  return out;
}

/** 数の行の平均の顧客の数（整数に近ければその整数、ほかは整数の幅。「平均ほぼ」と重ねない） */
function avgClientsRow(cl: number): string {
  const r = Math.round(cl);
  if (Math.abs(cl - r) < 0.15) return `${slot(r)} 社`;
  return `${slot(Math.floor(cl))}〜${slot(Math.ceil(cl))} 社`;
}

/** 平均の顧客の数（整数か、整数の幅。端数は書かない） */
function avgClients(cl: number): string {
  const r = Math.round(cl);
  if (Math.abs(cl - r) < 0.15) return `ほぼ ${slot(r)} 社`;
  return `${slot(Math.floor(cl))}〜${slot(Math.ceil(cl))} 社`;
}

/** 整数の幅（下と上が同じなら「N ほど」） */
function range(lo: number, hi: number, unit: string, fmt: (x: number) => string = (x) => n0(x)): string {
  const a = Math.round(lo);
  const b = Math.round(hi);
  if (a >= b) return `${slot(fmt(a))} ${unit}ほど`;
  return `${slot(fmt(a))}〜${slot(fmt(b))} ${unit}`;
}

/** 幅が広い（下が 0・上が下の 2 倍より大きい）なら、真ん中の道の数を添える（使える幅にする。reader-5） */
function wideNote(q: readonly [number, number, number], unit: string): string {
  const a = Math.round(q[0]);
  const b = Math.round(q[2]);
  const m = Math.round(q[1]);
  if (b <= a || (a > 0 && b <= 2 * a) || m <= a || m >= b) return "";
  return `（真ん中の道で ${slot(n0(m))} ${unit}）`;
}

const SURE = 0.9;
const RARE = 0.1;

function mixNumbers(c: Ctx, mix: MapMix): string[] {
  const out: string[] = [];
  const emp = mix.j.e + mix.j.p;
  // 独立した道は給与が 0 なので、幅の下に 0 が入る（「会社員の道」とは言わない。facts-5）
  if (mix.j.i >= SURE) out.push("給与なし（独立）");
  else out.push(`年収 ${range(c.annual * mix.sal[0], c.annual * mix.sal[2], "万円")}${emp >= SURE ? "" : "（独立した道は給与なし）"}`);
  const clLo = Math.round(mix.cl[0]);
  const clHi = Math.round(mix.cl[2]);
  out.push(clHi <= 0 ? "広告運用の顧客なし" : `広告運用 ${range(clLo, clHi, "社")}`);
  out.push(mix.pro <= RARE ? "Pro はまだ出していない" : `有料 ${range(mix.pu[0], mix.pu[2], "人")}${wideNote(mix.pu, "人")}`);
  out.push(`月に遊んだ人 ${range(mix.mau[0], mix.mau[2], "人")}${wideNote(mix.mau, "人")}`);
  return out;
}

// ---- 題（SPEC §4.2・gaps-11: 兄弟で違う。結果は分かれた数の名前を言う。年収で変わる数は入れない: code-1）

/** 結果の線の測る物ごとの、その分かれを言う出来事 */
const METRIC_EVENTS: Record<string, readonly string[]> = {
  perm: ["PERM_A", "PERM_S", "PERM_N"],
  permside: ["PERM_A", "PERM_S", "PERM_N"],
  sal: ["SWITCH_HIGH", "SWITCH_MID", "SWITCH_MIX", "SEARCH_NONE", "SEARCH_MIX", "PROMO", "PROMO_NO", "PROMO_MIX"],
  job: ["PART_ON", "PART_NO", "PART_MIX", "BACK_EMP", "BACK_NO", "BACK_MIX"],
  pilot: ["PILOT_ON", "PILOT_NO", "PILOT_MIX"],
  school: ["SCHOOL_ON", "SCHOOL_NO", "SCHOOL_MIX"],
  portfolio: ["PORTFOLIO_ON", "PORTFOLIO_NO", "PORTFOLIO_MIX"],
  cl: ["FIRST_CLIENT", "CLIENT_UP", "CLIENT_REGAIN", "CLIENT_LOST", "CLIENT_NOT_FOUND", "CLIENT_MIX", "CLIENT_EXACT", "BACK_NO"],
  pu: ["PU_MILE", "QUIET_sd_retain"],
  mau: ["MAU_MILE", "QUIET_sd_grow"],
};
/** 題がその数の名前を言っているか */
const METRIC_WORDS: Record<string, RegExp> = { perm: /可|届け出|Pro/, permside: /可|届け出|Pro/, sal: /給与|昇格|据え置き|転職/, job: /週 4 日|会社員|独立/, pilot: /試用|試して|学校|塾/, school: /学校|導入/, portfolio: /事例|成果/, cl: /顧客|社目|社/, pu: /有料/, mau: /遊ん|遊ぶ/ };

const TITLE_MAX = { a: 16, s: 22, e: 24 } as const;
const ROOT_TITLE = "今日: 会社員と SpellDash 週 10 時間";

/** 分かれた結果（兄弟が 2 つ以上）の測る物 */
function splitMetric(c: Ctx, o: number): string | null {
  const { map } = c;
  const p = map.parent(o);
  if (p < 0 || map.role(p) !== "a" || map.childCount(p) < 2) return null;
  return map.ln(o)?.[0] ?? null;
}

/** その数の短い言い方（題に入れる） */
function metricFact(c: Ctx, o: number, metric: string): string {
  const { map } = c;
  const s = map.st(o);
  switch (metric) {
    case "cl":
      return s.j === "i" ? `独立・顧客 ${bandClients(c, o) ?? clPhrase(s.cl, map.ln(o))}` : `顧客 ${bandClients(c, o) ?? clPhrase(s.cl, map.ln(o))}`;
    case "pu":
      return `有料 ${slot(n0(s.pu))} 人`;
    case "mau":
      return `月に遊んだ人 ${slot(n0(s.mau))} 人`;
    case "sal":
      return s.fl.includes("switched") ? `転職で給与 ${slot(f2(s.sal))} 倍` : `給与 ${slot(f2(s.sal))} 倍`;
    case "school":
      return s.seats >= 0.5 && s.seats % c.C.schoolSeats === 0 ? `学校 ${slot(n0(s.seats))} 席` : "学校は見送り";
    default:
      return labelOf(c, o);
  }
}

/** 兄弟の題（親 p の子の並び）。題は年収で変わらないので束ごとに覚える */
function titlesOf(c: Ctx, p: number): readonly TitleEntry[] {
  const hit = c.titles.get(p);
  if (hit) return hit;
  const { map } = c;
  const ks = kidsOf(map, p);
  const bases = ks.map((x) => baseTitle(c, x));
  // 重なりは仕上げた題で比べる（差し込みの印の位置が違うだけの同じ題を見逃さない）
  const fin = (t: string): string => spaceJa(strip(t));
  const dup = (arr: readonly TitleEntry[]): boolean => arr.some((t, k) => arr.findIndex((u) => fin(u[0]) === fin(t[0])) !== k);
  const many = (arr: readonly TitleEntry[], t: string): boolean => arr.filter((u) => fin(u[0]) === fin(t)).length > 1;
  let out: readonly TitleEntry[] = bases;
  if (dup(out)) {
    // 同じ題の兄弟だけ、結果の名前（手は短い名前）で言い分ける。それでも重なれば、重なった物に並びの番号を足す
    const prev = out;
    out = prev.map((t, k) => (many(prev, t[0]) ? fallbackTitle(c, ks[k]!) : t));
  }
  if (dup(out)) {
    const prev = out;
    out = prev.map((t, k) => (many(prev, t[0]) ? ([`${t[0]}（${slot(k + 1)}）`, t[1]] as const) : t));
  }
  if (c.titles.size > 60_000) c.titles.clear();
  c.titles.set(p, out);
  return out;
}

/** カード i の題（兄弟と違う物）を印つきのまま（点検が、本文の『』の中の名前をカードの題と比べる。P4・reader-1） */
export function markedTitle(c: Ctx, i: number): string {
  return titleOf(c, i, []);
}

/** カード i の題（兄弟と違う物）。使った文の型を trace に足す */
function titleOf(c: Ctx, i: number, trace: string[]): string {
  const { map } = c;
  if (map.role(i) === "r") return ROOT_TITLE;
  const p = map.parent(i);
  const ts = titlesOf(c, p);
  for (let k = 0; k < map.childCount(p); k++)
    if (map.child(p, k) === i) {
      trace.push(...ts[k]![1]);
      return ts[k]![0];
    }
  throw new Error(`親の子に無いカードです: ${map.key(i)}`);
}

function baseTitle(c: Ctx, x: number): TitleEntry {
  const tags: string[] = [];
  switch (c.map.role(x)) {
    case "a":
      return [moveTitle(c, x, tags), tags];
    case "s":
      return [stateTitle(c, x, tags), tags];
    default:
      return [endTitle(c, x), tags];
  }
}

function fallbackTitle(c: Ctx, x: number): TitleEntry {
  const { map } = c;
  const role = map.role(x);
  if (role === "a") return [kindShort(c, map.kind(x) ?? ""), []];
  if (role === "s") return [labelOf(c, x), []];
  return [`${endPrefix(c, x)}『${labelOf(c, x)}』`, []];
}

/** 手の題（種類と状態。同じ種類の 2 回目からは手引きの歩みの題） */
function moveTitle(c: Ctx, a: number, trace: string[]): string {
  const { map, B } = c;
  const kind = map.kind(a) ?? "";
  const m = moveCtx(c, a);
  return choose(B.title[kind], m.env, map.st(a).fl, m.slots, m.seed, trace, `title.${kind}`) || kindShort(c, kind);
}

/** 状態の題: 分かれた数の出来事を先に。題が分かれた数を言わなければ、その数を足す。同じ出来事の 2 回目からは何回目かを言う（reader-8） */
function stateTitle(c: Ctx, n: number, trace: string[]): string {
  const { map, B } = c;
  const link = linkOf(c, n);
  const metric = splitMetric(c, n);
  const want = metric ? (METRIC_EVENTS[metric] ?? []) : [];
  const top = link.evs.find((e) => want.includes(e.code)) ?? link.evs[0];
  const { env, slots } = stateEnv(c, n, link);
  let title = "";
  if (top) {
    const bare = top.code.replace(/_[a-z_0-9]+$/, "");
    const cell = B.eventTitle[top.code] ? top.code : B.eventTitle[bare] ? bare : "_default";
    const evn = countEvent(link.up, top.code);
    title = choose(B.eventTitle[cell], evEnv(env, top, evn), map.st(n).fl, { ...slots, ...evSlots(c, top, map.month(n)), evnth: slot(evn + 1) }, hash(map.key(n)), trace, `eventTitle.${cell}`) ?? "";
  }
  if (metric && METRIC_WORDS[metric] && !METRIC_WORDS[metric].test(strip(title))) {
    const f = metricFact(c, n, metric);
    title = title && len(`${title}・${f}`) <= TITLE_MAX.s ? `${title}・${f}` : f;
  }
  return title || labelOf(c, n);
}

/** 行き先の題の前置き（まとめた行き先は平均・見込みと書く。truth-5） */
function endPrefix(c: Ctx, n: number): string {
  if (!c.map.sum(n)) return "3 年後: ";
  return c.map.mix(n) ? "3 年後の見込み: " : "3 年後の平均: ";
}

/** 1.2（W5・con-14）: 本当の行き先の題の届け出の答え */
const END_PM: Record<string, string> = { "?": "届け出なし", a: "副業も可", s: "Pro だけ可", n: "副業は不可" };

/** 行き先の題: 分かれた数を先に、大きい事実を 2 つまで。年収で変わる数は入れない（code-1） */
function endTitle(c: Ctx, n: number): string {
  const { map } = c;
  const s = map.st(n);
  const facts: string[] = [];
  const metric = splitMetric(c, n);
  if (metric && map.sum(n)) {
    // まとめた行き先は、分かれた結果（その 3 か月の結果）の名前で言う。3 年後の数は平均なので、結果の幅に合わせた 1 本の道の数として題に書かない（truth-5）。
    // 兄弟の題の形をそろえる: どの兄弟も「『…』の後」に収まれば「の後」を付け、収まらない兄弟があればどれにも付けない（reader-5）
    const pre = endPrefix(c, n);
    const sibs = kidsOf(map, map.parent(n));
    const after = sibs.every((x) => len(`${endPrefix(c, x)}『${labelOf(c, x)}』の後`) <= TITLE_MAX.e);
    const lab = labelOf(c, n);
    const short = OUT_NAMES[map.outId(n)];
    const cands = after ? [`${pre}『${lab}』の後`] : [`${pre}『${lab}』`, ...(short ? [`${pre}『${slot(short)}』`] : [])];
    for (const t of cands) if (len(t) <= TITLE_MAX.e) return t;
    return cands[cands.length - 1]!;
  }
  if (metric) facts.push(metricFact(c, n, metric));
  const mix = map.mix(n);
  if (map.sum(n) && mix) {
    // 幅で言う（9 割がそろう事実だけを言い切る）。数の行と同じ「広告運用」と書く（reader-5）
    if (mix.j.i >= SURE) facts.push("独立");
    if (mix.switched >= SURE) facts.push("転職");
    const clHi = Math.round(mix.cl[2]);
    if (clHi >= 1 && mix.j.i < SURE) facts.push(`広告運用 ${range(mix.cl[0], mix.cl[2], "社")}`);
    if (mix.pro > RARE) facts.push(`有料 ${range(mix.pu[0], mix.pu[2], "人")}`);
    if (!facts.length) {
      // 大きな事実が無ければ遊ぶ人の幅。収まらなければ真ん中の数（どれも年収で変わらない。最後の言い方は 4 桁でも収まる）
      const pre = endPrefix(c, n);
      const cands = [`月に遊ぶ人 ${range(mix.mau[0], mix.mau[2], "人")}`, `月に遊ぶ人 ${slot(n0(mix.mau[1]))} 人ほど`, `遊ぶ人 ${slot(n0(mix.mau[1]))} 人ほど`];
      facts.push(cands.find((t) => len(`${pre}${t}`) <= TITLE_MAX.e) ?? cands[cands.length - 1]!);
    }
  } else if (!map.sum(n)) {
    // 1.2（W5・con-14）: 本当の行き先は、分かれた数の後に、仕事・届け出の答え・一番の稼ぎの元（顧客・有料会員）を「・」で並べる
    //   （「3 年後: 給与 1.09 倍」だけにしない。年収で変わる数は入れない: code-1）。収まる所まで
    const clp = bandClients(c, n) ?? clPhrase(s.cl);
    const job = s.j === "i" ? "独立" : s.j === "p" ? "週 4 日勤務" : s.fl.includes("switched") ? "転職先" : "会社員";
    //   顧客がいれば届け出の答え（全部可）は言わない（顧客の数で分かる）
    //   数（顧客・有料会員）を届け出の答えより先に置く（収まらなければ答えを落とす）
    const situation = [job, s.cl >= 0.5 ? `顧客 ${clp}` : "", s.pro && s.pu >= 0.5 ? `有料 ${slot(n0(s.pu))} 人` : "", s.j === "i" || s.cl >= 0.5 ? "" : END_PM[s.pm] ?? ""];
    const said = (f: string): boolean => facts.some((x) => strip(x).includes(strip(f)) || (f === "転職先" && strip(x).includes("転職")));
    for (const f of situation) if (f && !said(f)) facts.push(f);
    const pre = endPrefix(c, n);
    let t = `${pre}${facts[0]}`;
    for (const f of facts.slice(1)) if (len(`${t}・${f}`) <= TITLE_MAX.e) t = `${t}・${f}`;
    return t;
  } else {
    const avg = map.sum(n);
    if (s.j === "i") facts.push(`独立・顧客 ${avg ? avgClients(s.cl) : (bandClients(c, n) ?? clPhrase(s.cl))}`);
    else if (s.fl.includes("switched")) facts.push(`転職で給与 ${slot(f2(s.sal))} 倍`);
    else if (s.j === "p") facts.push("週 4 日勤務");
    if (s.j !== "i" && s.cl >= 0.5) facts.push(`広告運用 ${avg ? avgClients(s.cl) : (bandClients(c, n) ?? clPhrase(s.cl))}`);
    if ((s.pro || avg) && s.pu >= 1) facts.push(`有料 ${slot(n0(s.pu))} 人`);
    if (!facts.length) facts.push(s.pm === "n" && !avg ? "副業は不可のまま" : `給与 ${slot(f2(s.sal))} 倍`);
  }
  const uniq = facts.filter((f, k) => facts.indexOf(f) === k);
  const pre = endPrefix(c, n);
  const two = `${pre}${uniq.slice(0, 2).join("と")}`;
  return len(two) <= TITLE_MAX.e ? two : `${pre}${uniq[0]}`;
}

// ---- 手

// 1.0: 届け出の答えも「会社の返事」（「答えが出るのは…の会社の答え」と重ねない）
const METRIC_NAME: Record<string, string> = { perm: "会社の返事", permside: "会社の返事", sal: "給与", cl: "広告運用の顧客の数", pu: "有料会員の数", mau: "遊ぶ人の数", job: "会社の返事", pilot: "試用の返事", school: "学校の返事", portfolio: "手伝った店の成果", ind: "顧客の数" };
const CAT_IDS = /^(a|a0_a1|a1|a0|s|n|high|mid|none|up|same|yes|no|p|e|i|u0|u1|u2)$/;
/** 数で分かれる線（見る数の言い方。ほかは返事・答え。reader-10） */
const NUMERIC = new Set(["cl", "pu", "mau"]);

/** 結果の分類（分かれ目の文の型を引く鍵） */
function outcomeClass(map: MapData, o: number, sibs: readonly number[]): string {
  const id = map.outId(o) || "all";
  if (id === "all") return "all";
  // 全部可を 1 社目が決まったか（a1・a0）で分けた結果は、それぞれの意味で言う（同じ手の 2 つの結果を同じ文にしない）。まとめた a0_a1 は全部可
  if (id === "a1" || id === "a0") return id;
  if (id === "a0_a1") return "a";
  // 上げて転職をまとめた結果（大きく・少し）。移ったのは事実で、上げ幅は平均（facts-1）
  if (id === "high_mid") return "high_mid";
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

/** 手の年月の差し込み（独立を伝える月・独立する月・4 月の評価） */
function moveDates(c: Ctx, a: number): Slots {
  const { cal } = c;
  const m = c.map.month(a);
  const out: Slots = { ymTell: cal.ym(m + 1), ymInd: cal.ymRel(m + 2, m + 1) };
  const april = cal.aprils.find((q) => q > m && q <= m + 3);
  if (april !== undefined) out.ymApril = cal.ym(april);
  return out;
}

/**
 * 昇格 1 回で上がる年収（万円）。分かれた結果があれば、その 2 つの給与の差（状態の数と同じ）。無ければ前提から:
 * 昇格は今日の給与の 7% を足してから 4 月の昇給（1.03 倍）がかかり、週 4 日なら 0.8 倍（reader-4・facts-6）
 */
function promoGap(c: Ctx, a: number): number {
  const { map, C } = c;
  const ks = kidsOf(map, a).filter((o) => !map.sum(o));
  const up = ks.find((o) => map.outId(o) === "up");
  const same = ks.find((o) => map.outId(o) === "same");
  if (up !== undefined && same !== undefined) return c.annual * (map.rr(up)[0] - map.rr(same)[0]);
  return c.annual * C.step * (1 + C.aprilRaise) * (map.st(a).j === "p" ? C.partFactor : 1);
}

/**
 * 道の前の判断（今の判断は除く）のうち、その種類の手が並んでいた判断の数。言い換えの種に使う: 続く判断に同じ種類の手が並ぶと
 * （選んで続けた手でも、選ばなかったほかの手でも）、書き出しと結果の意味の言い換えが 1 つずつずれる（判断ごとの繰り返し。reader-8）
 */
function offeredBefore(link: Link, kind: string): number {
  let n = 0;
  for (let l = link.up; l; l = l.up) if (l.opts.has(kind)) n++;
  return n;
}

type MoveCtx = { env: Env; slots: Slots; seed: number; nth: number; offered: number; link: Link; steps: ReturnType<typeof stepsFor>; fresh: ReturnType<typeof stepsFor> };
/**
 * 手を組み立てる値（題と本文で同じ物）。修正（code-4）: 題と本文で 2 回作っていたので、地図と束ごとの道の覚え（c.links）に年収ごとに覚える
 * （計算の芯には依らない）。条件と差し込みは写しを返す（呼んだ側が書き足しても覚えは変わらない）
 */
const MOVE_CTX = new WeakMap<object, { annual: number; m: Map<number, MoveCtx> }>();
function moveCtx(c: Ctx, a: number): MoveCtx {
  let e = MOVE_CTX.get(c.links);
  if (!e || e.annual !== c.annual) MOVE_CTX.set(c.links, (e = { annual: c.annual, m: new Map() }));
  let v = e.m.get(a);
  if (!v) {
    v = moveCtxOf(c, a);
    if (e.m.size > 60_000) e.m.clear();
    e.m.set(a, v);
  }
  return { ...v, env: { ...v.env }, slots: { ...v.slots } };
}
function moveCtxOf(c: Ctx, a: number): MoveCtx {
  const { map, C } = c;
  const d = map.parent(a);
  const link = linkOf(c, d);
  const kind = map.kind(a) ?? "";
  const nth = countKind(link, kind);
  const pe = pathEnv(c, link);
  const { env, slots } = baseEnv(c, a);
  const h = map.hours(a);
  Object.assign(env, pe);
  env.n = nth;
  // 修正（reader-3）: 届け出は会社ごと（答えの出た会社には出し直せない。届け出の手は答えが『まだ』の時だけ並ぶ）。道で前に届け出たことがあれば
  //   それは前の会社の届け出なので、nf（道の上の前の届け出の数）で「移った会社で初めての届け出」と言い、「もう一度」「今度も」とは言わない
  if (FILING_KINDS.has(kind)) {
    let nf = 0;
    let here = 0;
    for (const fk of FILING_KINDS) {
      nf += countKind(link, fk);
      here += countKindHere(link, fk);
    }
    env.nf = nf;
    env.n = here;
  }
  env.h = h;
  // 今の会社で前にその種類の手を選んだ回数（前の会社の手の続きとは言わない。F5）
  env.here = countKindHere(link, kind);
  const used = usedSet(link);
  const steps = stepsFor(c, a, nth, used, recentSteps(link), pe);
  const fresh = steps.filter((st) => !used.has(st.id));
  // 種: 道の最初の手と種類に、前の判断でその種類の手が並んだ数を足す（同じ種類の手が続く判断ごとに、書き出しが 1 つずつ回る。reader-8）
  const firstKey = map.key(link.first >= 0 ? link.first : a);
  const offered = offeredBefore(link, kind);
  const seed = hash(`${firstKey}|${kind}`) + offered;
  // 転職の手: 移った結果のデータで、届け出の言い方を決める（今の範囲を持っていける carry・出し直す refile。truth-11）
  if (kind === "fc_switch" || kind === "fc_switch2") {
    const s0 = map.st(a);
    const moved = kidsOf(map, a).filter((o) => /^(high|mid|high_mid)$/.test(map.outId(o))).map((o) => map.st(o));
    env.carry = moved.length && moved.every((s) => s.pm === s0.pm && (s0.pm === "a" || s0.pm === "s")) ? 1 : 0;
    env.refile = moved.some((s) => s.pm === "?" && s0.pm !== "?") ? 1 : 0;
  }
  // 何期目: 転職活動は今の会社での転職活動の期（転職活動と続けた期を合わせて。reader-6）、ほかはその種類の手の回数
  const nthShown = kind === "fc_switch" || kind === "fc_switch2" ? (pe.search as number) + 1 : nth + 1;
  const s2: Slots = { ...slots, ...moveDates(c, a), nth: slot(nthShown), act1: pbText(fresh[0]?.act ?? ""), act2: pbText(fresh[1]?.act ?? ""), stepTitle: pbText(fresh[0]?.title ?? ""), hSigned: `${h >= 0 ? "+" : MINUS}${slot(Math.abs(h))}`, H: slot(C.baseHours + h) };
  if (kind === "fc_push") {
    s2.stepYen = `${slot(n0(promoGap(c, a)))} 万円`;
    // 入社して何か月で迎える評価か（道の上で勤め先が変わった月から、その 3 か月の 4 月まで）。地図の途中で入った会社だけ（fact-5）
    const join = joinedAt(c, link);
    const ap = eventMonth(c.cal, kind, map.month(a));
    env.joinM = join === null ? -1 : ap - join;
    if (join !== null) s2.joinM = slot(ap - join);
  }
  // 1b・W3（rep-2）: この手を選ぶ状態の一番の出来事（今日は ROOT・出来事の無い期は QUIET）と、そこへ来た手の種類（この手を今選ぶ訳の条件）
  const top = link.up ? (shownEvents(link).find((e) => !e.code.startsWith("NEW_EMP_")) ?? null) : null;
  env.pev = link.up ? (top?.code ?? "QUIET") : "ROOT";
  env.pk = link.kind ?? "";
  // その出来事が道でそれより前に起きた回数（同じ出来事の後の同じ種類の手が道で何回も来るとき、訳の言い方をずらす）
  env.pevn = top ? countEvent(link.up, top.code) : 0;
  if (top?.x.mile) s2.mile = top.x.mile;
  // 1b・W3（con-4）: 前提の上限（集客・広告で集める手は 3 年で 4 期・転職活動は 1 つの会社で 4 期まで）まであと何回か（この手を入れて数える）と、
  //   その種類を道で初めて選んだ判断からの動き（遊ぶ人・有料会員）。上限の数は C から（L3）
  const s0 = map.st(d);
  const cap0 = (used: number, max: number): void => {
    env.used = used;
    env.left = max - used - 1;
    s2.left = slot(Math.max(0, max - used - 1));
  };
  // 修正（reader-9）: 集客・広告の残りの期は、3 年の終わりまでに残る判断の数でも切る（最後の 3 か月で「残りは 2 期」と言わない）
  const quartersAfter = Math.max(0, Math.floor((c.cal.horizon - map.month(a) - 3) / 3));
  if (kind === "sd_grow" || kind === "sd_ads") {
    cap0(usesOf(s0.fl, kind === "sd_grow" ? "g" : "a"), kind === "sd_grow" ? C.growMax : C.adsMax);
    if ((env.left as number) > quartersAfter) {
      env.left = quartersAfter;
      s2.left = slot(quartersAfter);
    }
  }
  else if (kind === "fc_switch" || kind === "fc_switch2") {
    cap0(pe.search as number, C.searchMax);
    env.run = searchRunOf(link);
    env.lastSearch = (pe.search as number) + 1 >= C.searchMax ? 1 : 0;
    // 移れる見込みの動き（con-4）: 前の転職活動の期の移れる見込みと、この手の見込み（どちらも地図の結果の見込みの和）
    const movedP = (x: number): number => kidsOf(map, x).filter((o) => /^(high|mid|high_mid)$/.test(map.outId(o))).reduce((t, o) => t + map.p(o), 0);
    const pNow = movedP(a);
    s2.pNow = wari(pNow / 100);
    for (let l: Link | null = link; l && l.up; l = l.up)
      if (l.kind === "fc_switch" || l.kind === "fc_switch2") {
        const pPrev = movedP(l.move);
        s2.pPrev = wari(pPrev / 100);
        env.pTrend = pNow < pPrev ? -1 : pNow > pPrev ? 1 : 0;
        break;
      }
  }
  if (kind === "ad_side" || kind === "ad_more") {
    const [, chi] = clBandOf(c, d);
    env.capLeft = capOf(C, s0.j) - chi;
    s2.capLeft = slot(Math.max(0, capOf(C, s0.j) - chi));
  }
  let firstL: Link | null = null;
  for (let l: Link | null = link; l && l.up; l = l.up) if (l.kind === kind) firstL = l;
  if (firstL) {
    const f0 = map.st(firstL.up!.i);
    s2.ymFirst = c.cal.ym(map.month(firstL.move));
    s2.mauFirst = slot(n0(f0.mau));
    s2.puFirst = slot(n0(f0.pu));
    env.dMau = Math.round(s0.mau) - Math.round(f0.mau);
    env.dPu = Math.round(s0.pu) - Math.round(f0.pu);
    s2.dMau = slot(n0(Math.abs(env.dMau as number)));
    s2.dPu = slot(n0(Math.abs(env.dPu as number)));
  }
  return { env, slots: s2, seed, nth, offered, link, steps, fresh };
}

/** まとめた行き先の見込みの言い方（中身の幅があれば幅、無ければ平均） */
function sumForecast(c: Ctx, o: number, from: ImpactSt): string[] {
  const { map } = c;
  const mix = map.mix(o);
  const parts: string[] = [];
  if (mix) {
    parts.push(`月に遊ぶ人は ${range(mix.mau[0], mix.mau[2], "人")}`);
    if (mix.pro > RARE) parts.push(`有料会員は ${range(mix.pu[0], mix.pu[2], "人")}`);
    if (Math.round(mix.cl[2]) >= 1) parts.push(`顧客は ${range(mix.cl[0], mix.cl[2], "社")}`);
    return parts;
  }
  const b = map.st(o);
  if (Math.abs(b.mau - from.mau) >= 1) parts.push(`月に遊ぶ人は平均 ${slot(n0(b.mau))} 人`);
  if (b.pu >= 0.5 && Math.round(b.pu) !== Math.round(from.pu)) parts.push(`有料会員は平均 ${slot(n0(b.pu))} 人`);
  if (clr(b.cl) !== clr(from.cl)) parts.push(`顧客は平均 ${avgClients(b.cl)}`);
  return parts;
}

/** まとめた行き先の、この手から 3 年後までの稼ぎの合計（e は手の 3 か月から 36 か月目までの見込み。給与は月数 × 今の年収の月割り） */
const sumTotal = (c: Ctx, x: number): number => {
  const e = c.map.e(x);
  return e[0] * (c.annual / 12) + e[1] + e[2];
};
const amount = (x: number): string => slot(Math.abs(x) >= 100 ? n0(x) : man(x));

/** 結果の名前の順の鍵（「顧客 0 社」「顧客 2〜3 社」の数。無ければ並びのまま） */
function labelNum(c: Ctx, o: number): number {
  const m = /(\d+)/.exec(c.map.label(o)) ?? /(\d+)$/.exec(c.map.outId(o));
  return m ? Number(m[1]) : NaN;
}

/** 給与のある道の割合（会社員・週 4 日） */
const empShare = (mix: MapMix | null, s: ImpactSt): number => (mix ? mix.j.e + mix.j.p : s.j === "i" ? 0 : 1);

/**
 * 標準の続きで会社員に戻る期（続きの手が会社員に戻る仕事探しで、戻る出来事がある最初の期）の、その期の手を選ぶ月。無ければ null。
 * 戻るのはその期の 3 か月目（モデルの出来事の月。eventMonth・back_emp は +3）なので、戻る月として言うのは eventMonth で（fact-1）
 */
function contBackMonth(c: Ctx, o: number): number | null {
  for (const st of c.map.cont(o) ?? []) if (st.ev === "BACK_EMP") return st.m;
  return null;
}

/**
 * まとめた行き先の中身の一言（仕事の行き先と 3 年後の顧客。標準の続きの中身から。reader-5: 顧客がいた結果を「まだ無い」と言わない）。
 * j1 はその 3 か月の後の仕事（独立する手なら独立）
 */
function sumWhat(c: Ctx, o: number, j1: ImpactSt["j"]): string {
  const { map, cal } = c;
  const mix = map.mix(o);
  const s = map.st(o);
  const emp = empShare(mix, s);
  let job = "";
  if (j1 === "i") {
    // 戻る月は、会社員に戻る仕事探しの期の 3 か月目（標準の続きの見積もりの行の「答えが出る」月と同じ。fact-1・点検 C11）。
    // 仕事探しの 3 か月は見積もりの行が言う（結果が 3 つの手で 3 回並ぶので、ここでは月だけ）
    const back = contBackMonth(c, o);
    const when = back !== null ? `${cal.ym(eventMonth(cal, "back_emp", back))}に` : "";
    job = emp >= SURE ? `標準の続きでは${when}会社員に戻り` : emp >= 0.5 ? `多くの道で${when}会社員に戻り` : emp > RARE ? "独立のままの道が多く" : "独立のまま";
  } else if (mix && mix.j.i >= 0.5) job = mix.j.i >= SURE ? "標準の続きでは独立し" : "多くの道で独立し";
  let cl: string;
  if (mix) cl = Math.round(mix.cl[2]) <= 0 ? `3 年後の顧客は ${slot(0)} 社` : `3 年後の顧客は ${range(mix.cl[0], mix.cl[2], "社")}`;
  else cl = s.cl < 0.15 ? `3 年後の顧客は ${slot(0)} 社` : `3 年後の顧客は平均 ${avgClients(s.cl)}`;
  return job ? `${job}、${cl}` : cl;
}

/**
 * まとめた手の、数で分かれる結果ごとの言い方: 標準の続きの中身と、3 年後までの稼ぎの合計。名前の順に並べ、同じ中身の結果は
 * まとめて言う（「『顧客 0 社』でも『顧客 1 社』でも…」）。顧客の多い結果の方が合計が少なければ、その訳（給与のある道の違い）を添える（reader-5）
 */
function sumOutcomes(c: Ctx, a: number, ks: readonly number[], head: string, rot: number, trace: string[]): string {
  const { map, cal } = c;
  const j1: ImpactSt["j"] = map.kind(a) === "ind_quit" ? "i" : map.st(a).j;
  const order = ks.slice().sort((x, y) => {
    const dx = labelNum(c, x);
    const dy = labelNum(c, y);
    return Number.isFinite(dx) && Number.isFinite(dy) ? dx - dy : 0;
  });
  const items = order.map((o) => ({ o, t: sumTotal(c, o), what: sumWhat(c, o, j1) }));
  const groups: Array<typeof items> = [];
  for (const it of items) {
    const g = groups[groups.length - 1];
    if (g && g[0]!.what === it.what) g.push(it);
    else groups.push([it]);
  }
  const hz = cal.ym(cal.horizon);
  // 言い方は続く判断ごとに回す（同じ種類のまとめた手が続く判断に並ぶ。reader-8）
  const f = rot % 2;
  const parts = groups.map((g) => {
    // 1b・W3（con-3）: 結果の名前に、その結果の見込みを添える
    const labs = g.map((x) => `『${labelOf(c, x.o)}』${oddsOf(c, x.o)}`);
    const eq = g.length === 1 || g.every((x) => Math.abs(x.t - g[0]!.t) < 1);
    const sums = eq ? `${amount(g[0]!.t)} 万円ほど` : `${g.map((x) => `${amount(x.t)} 万円`).join("と")}`;
    if (g.length === 1) return f ? `${labs[0]}の場合、${hz}までの稼ぎは ${sums}で、${g[0]!.what}` : `${labs[0]}なら、${g[0]!.what}（${hz}までの稼ぎは ${sums}）`;
    return f ? `${labs.join("と")}は、${hz}までの稼ぎが${eq ? `どちらも ${sums}` : `それぞれ ${sums}`}で、どちらも${g[0]!.what}` : `${labs.join("でも")}でも、${g[0]!.what}（${hz}までの稼ぎは ${sums}）`;
  });
  trace.push("watch:sums");
  let why = "";
  // 顧客の多い結果の方が少ない: 給与のある道（会社員に戻る道）の違いなら、その訳を言う
  for (let x = items.length - 1; x >= 1 && !why; x--)
    for (let y = 0; y < x && !why; y++) {
      const hi = items[x]!;
      const lo = items[y]!;
      if (!(labelNum(c, hi.o) > labelNum(c, lo.o)) || hi.t >= lo.t - 1) continue;
      const eh = empShare(map.mix(hi.o), map.st(hi.o));
      const el = empShare(map.mix(lo.o), map.st(lo.o));
      if (el - eh >= 0.3) why = f ? `『${labelOf(c, lo.o)}』の方が稼ぎが多いのは、会社員に戻って給与が入る道が多いため（顧客の数は『${labelOf(c, hi.o)}』の方が多い）。` : `顧客の多い『${labelOf(c, hi.o)}』の方が稼ぎが少ないのは、『${labelOf(c, lo.o)}』では会社員に戻って給与が入る道が多いため。`;
    }
  return `${head}${parts.join("。")}。${why}`;
}

/**
 * 1b・W3（con-12・rep-11）: 顧客探しの手（副業の顧客をもう 1 社・紹介で増やす）の結果が 1 つのときの見込み（遊ぶ人の数より先に顧客を言う）:
 * 3 か月を終えて顧客が増えている見込み（社数の違う場合をまとめた幅の平均から。離れる顧客も入れたこの地図の見積もり）・増えた時の売上の上がり幅
 * （次の顧客の月額）・持てる顧客の上限まであと何社。言い方は位置 p で 3 つを回す（構造の文）。終わりの「。」は付けない。言えなければ null
 */
function clientForecast(c: Ctx, a: number, o: number, p: number): string | null {
  const { map, C } = c;
  const d = map.parent(a);
  const [, dh] = clBandOf(c, d);
  const [ol, oh] = clBand(map, o);
  const s0 = map.st(d);
  const b = map.st(o);
  const cap = capOf(C, b.j);
  const job = b.j === "i" ? "独立" : b.j === "p" ? "週 4 日勤務" : "会社員";
  const fee = `${slot(man(newFeeOf(C, s0.j, linkOf(c, d).f5)))} 万円`;
  if (oh === ol + 1 && oh > dh) {
    const share = b.cl - ol;
    if (!(share > 0.05 && share < 0.95)) return null;
    const sh = wari(share);
    const capNote = cap - oh > 0 ? `${job}で持てる ${slot(cap)} 社まであと ${slot(cap - oh)} 社` : `${job}で持てる ${slot(cap)} 社の上限に届く`;
    return [
      `3 か月を終えて顧客が ${slot(oh)} 社になっている見込みは ${sh}で、増えれば広告運用の売上が月 ${fee}上がる`,
      `この 3 か月で顧客が増える見込みは ${sh}（離れる顧客も入れたこの地図の見積もり）で、増えれば${capNote}`,
      `顧客は ${slot(ol)} 社か ${slot(oh)} 社で 3 か月を終え、${slot(oh)} 社になる見込みは ${sh}`,
    ][p]!;
  }
  // 幅が同じまま（顧客の数の幅は変わらず、上の社数の見込みが上がる）
  const [dl] = clBandOf(c, d);
  if (ol === dl && oh === dh && oh === ol + 1) {
    const s0n = s0.cl - ol;
    const s1n = b.cl - ol;
    if (!(s0n > 0.05 && s0n < 0.95 && s1n > 0.05 && s1n < 0.95) || s1n < s0n + 0.05) return null;
    return [`顧客は ${slot(ol)} 社か ${slot(oh)} 社の幅のままで、${slot(oh)} 社になっている見込みは ${wari(s0n)}から ${wari(s1n)}に上がる`, `この 3 か月で、顧客が ${slot(oh)} 社になっている見込みは ${wari(s0n)}から ${wari(s1n)}になる`, `${slot(oh)} 社になっている見込みが ${wari(s0n)}から ${wari(s1n)}に上がり、顧客は ${slot(ol)} 社か ${slot(oh)} 社のまま`][p]!;
  }
  if (ol === oh && ol > dh) {
    const capNote = cap - ol > 0 ? `${job}で持てる ${slot(cap)} 社まであと ${slot(cap - ol)} 社` : `${job}で持てる ${slot(cap)} 社の上限に届く`;
    return [`3 か月を終えて顧客は ${slot(ol)} 社になる見込みで、${capNote}`, `この 3 か月で顧客は ${slot(ol)} 社まで増える見込み（1 社増えるごとに売上は月 ${fee}）`, `顧客は ${slot(ol)} 社で 3 か月を終える見込みで、${capNote}`][p]!;
  }
  // 幅が 2 社以上に広がる（上の社数の見込みは平均から出せない）: 顧客の数の幅の動き。声をかける手は、探す 3 か月ごとの見込み（前提）を添える
  if (oh > dh || ol > dl) {
    const r0 = dl === dh ? `${slot(dl)} 社` : `${slot(dl)}〜${slot(dh)} 社`;
    const r1 = ol === oh ? `${slot(ol)} 社` : `${slot(ol)}〜${slot(oh)} 社`;
    const odds = map.kind(a) === "ad_side" ? `で、探す 3 か月ごとに決まる見込みは ${wari(s0.fl.includes("portfolio") ? C.sidePPortfolio : C.sideP)}` : "";
    return [`3 か月を終えて、顧客は ${r1}になる見込みで、${job}で持てる上限は ${slot(cap)} 社`, `この 3 か月で、顧客の数は ${r0}から ${r1}に広がる見込み`, `顧客は ${r1}で 3 か月を終える見込み${odds}`][p]!;
  }
  return null;
}

/**
 * 分かれ目: 次の分かれ道がいつ・何で分かれ、それぞれ何を意味するか。nth は道でその種類を選んだ回数、rot は言い換えを回す数、
 * mv は手の条件の値（結果の意味の言い方を、手を選ぶ時点の独立してからの月 im で選ぶ。rep-5）
 */
function watchSentence(c: Ctx, a: number, slots: Slots, nth: number, rot: number, trace: string[], mv: Env = {}): string {
  const { map, B, cal } = c;
  const ks = kidsOf(map, a);
  if (!ks.length) return "";
  const m = map.month(a);
  const kind = map.kind(a) ?? "";
  const d = map.parent(a);
  if (ks.length === 1) {
    const o = ks[0]!;
    const b = map.st(o);
    const s0 = map.st(a);
    const at = cal.ym(map.month(o));
    if (map.sum(o)) {
      // まとめた行き先は 3 年後の見積もり（標準の選び方で続けた平均か幅。どの場合もとは言えない）
      const parts = sumForecast(c, o, s0);
      trace.push("watch:sum");
      return parts.length ? `${at}の見積もり（標準の続き）は、${parts.join("、")}${map.mix(o) ? "" : "ほど"}。` : `${at}まで、数字はほぼ今のまま。`;
    }
    // 事実の場合をまとめた結果: どちらか一方として言わず、見込みとまとめた平均で先へ進むと書く（facts-1・reader-3）
    if (mergedFact(map, o)) {
      trace.push("watch:mix");
      const p = factShare(c.C, kind, s0.fl);
      const ap = cal.aprils.find((q) => q > m && q <= m + 3);
      const when = ap !== undefined ? `${cal.ym(ap)}の評価で` : "";
      if (kind === "fc_push" && p !== null)
        return [`${when}昇格する見込みは ${wari(p)}。この地図は、昇格した場合と据え置きの場合をまとめた平均（給与は今日の ${slot(f2(b.sal))} 倍）で先へ進む。`, `昇格の見込みは ${wari(p)}。この先は、${when}昇格する場合としない場合をならした給与（今日の ${slot(f2(b.sal))} 倍）で進む。`][rot % 2]!;
      if (kind === "sd_school" && p !== null) return [`学校が導入を決める見込みは 3 か月で ${wari(p)}。この地図は、導入した場合と見送った場合をまとめた平均で先へ進む。`, `導入の見込みは ${wari(p)}。この先は、導入と見送りをならした席の数で進む。`][rot % 2]!;
      return "この地図は、この手の結果の場合をまとめた平均で先へ進む。";
    }
    // 担当を広げる手: 変わるのは次の 4 月の評価の見込みで、遊ぶ人の数ではない（reader-2）。道で 2 回目からは別の言い方（転職した後の会社で
    // もう一度広げる道で、同じ文が並ばない。rep-6）
    if (kind === "fc_scope") {
      trace.push("watch:scope");
      const ap = cal.aprils.find((q) => q > m);
      if (ap === undefined) return `${cal.ym(cal.horizon)}までに 4 月の評価は来ないので、担当を広げた分はこの地図の数には出ない。`;
      if (nth >= 1) return [`この会社で広げた担当が効くのは ${cal.ym(ap)}の評価で、この 3 か月の数字はほぼ今のまま。`, `広げ直した担当の分は ${cal.ym(ap)}の評価に出て、それまで給与は動かない。`][rot % 2]!;
      return [`この 3 か月で給与は変わらず、担当を広げた分は ${cal.ym(ap)}の評価で効く。`, `給与が動くのは ${cal.ym(ap)}の評価から。この 3 か月の数字はほぼ今のまま。`][rot % 2]!;
    }
    // 1b・W3（con-12・rep-11）: 結果が 1 つの手の見込みは、その手の種類の数を先に言う（顧客探しは顧客、続ける工夫は有料会員、集客は遊ぶ人）。
    //   言い方は道の上の位置で 3 つを回す（構造の文。L2）
    const p3 = posA(c, a) % 3;
    const mauPart = Math.abs(b.mau - s0.mau) >= 1 ? `月に遊ぶ人は ${slot(n0(s0.mau))} 人から ${slot(n0(b.mau))} 人` : null;
    const puPart = b.pro && Math.round(b.pu) !== Math.round(s0.pu) ? `有料会員は ${slot(n0(s0.pu))} 人から ${slot(n0(b.pu))} 人` : null;
    // 給与は払われる倍率で（週 4 日は 0.8 倍が掛かった額。facts-6）
    const r0 = map.rr(d)[0];
    const r1 = map.rr(o)[0];
    const salPart = Math.abs(r1 - r0) >= 0.005 && b.j !== "i" ? (Math.abs(r1 - 1) < 0.005 ? "給与は今日と同じ" : `給与は今日の ${slot(f2(r1))} 倍`) : null;
    if (kind === "ad_side" || kind === "ad_more") {
      const said = clientForecast(c, a, o, p3);
      if (said) {
        trace.push("watch:client");
        // SpellDash の数は、この 3 か月で遊ぶ人が 1 割以上動くときだけ後ろに添える
        const sd = mauPart && Math.abs(b.mau - s0.mau) >= 0.1 * Math.max(1, s0.mau) ? `（SpellDash は${mauPart.replace(/^月に遊ぶ人は/, "月に遊ぶ人")}）` : "";
        return `${said}${sd}。`;
      }
    }
    if (kind === "keep" && mauPart) {
      trace.push("watch:keep");
      const tail = salPart ? `、${salPart}` : "";
      return [`何も足さない 3 か月でも、続けている開発で${mauPart}に増える見込み${tail}。`, `足さない間も、${at}には${mauPart}ほどになる見込み${tail}。`, `手を足さなくても、この 3 か月で${mauPart}まで増える見込み${tail}。`][p3]!;
    }
    const parts = (kind === "sd_retain" ? [puPart, mauPart] : [mauPart, puPart]).filter((x): x is string => !!x);
    if (clr(b.cl) !== clr(s0.cl)) parts.push(`顧客は ${bandClients(c, o) ?? clPhrase(b.cl)}`);
    if (salPart) parts.push(salPart);
    if (!parts.length) return `${at}まで、数字はほぼ今のまま。`;
    trace.push("watch:single");
    const frames = [`${at}の見込みは、${parts.join("、")}ほど。`, `${at}には、${parts.join("、")}ほどになる見込み。`, `この 3 か月で、${parts.join("、")}ほどまで動く見込み。`];
    return frames[p3]!;
  }
  const metric = map.ln(ks[0]!)?.[0] ?? "";
  // 答えが出る月: 数で分かれる線はその 3 か月の終わり、事実はその手の出来事の月（届け出は翌月・週 4 日と学校は 2 か月目・昇格は 4 月。facts-7）
  const factAt = NUMERIC.has(metric) ? m + 3 : eventMonth(cal, kind, m);
  const mName = METRIC_NAME[metric] ?? "結果";
  const at = cal.ym(factAt);
  // 「見る数は」は数で分かれる線だけ（返事・成果は数ではない。reader-10）
  const third = NUMERIC.has(metric) ? `見る数は ${at}の${mName}。` : `答えが出るのは ${at}の${mName}。`;
  const heads = [`分かれ目は ${at}の${mName}。`, `${at}の${mName}で道が分かれる。`, third, `その先は ${at}の${mName}しだい。`, `この手の答えは ${at}の${mName}で出る。`];
  // 1b・W3（L2）: 言い方は道の上の位置で 5 つを回す（ハッシュでなく位置で。道 1 本で 1 つの書き出しは 3 回まで）
  const pos = posA(c, a);
  const head = heads[pos % heads.length]!;
  if (NUMERIC.has(metric)) {
    // まとめた手: 結果ごとの 3 年後までの稼ぎと標準の続きの中身（平均の売上を、その結果の 1 本の道の数として言わない。reader-5）
    if (ks.some((o) => map.sum(o))) return sumOutcomes(c, a, ks, head, rot, trace);
    // 数で分かれる: 結果の名前と、その数を 1 行で
    const num = (o: number): string => {
      const s = map.st(o);
      return metric === "cl" ? (s.cl * s.fee < 0.05 ? "広告運用の売上はまだ無い" : `売上 月 ${slot(man(s.cl * s.fee))} 万円ほど`) : metric === "pu" ? `有料 ${slot(n0(s.pu))} 人ほど` : `月に遊ぶ人 ${slot(n0(s.mau))} 人ほど`;
    };
    trace.push("watch:num");
    // 1b・W3（L2）: 結果ごとの数の言い方も位置で 3 つを回す（顧客探しが何期も続く道で、同じ枠が並ばない）
    const lab = (o: number): string => `『${labelOf(c, o)}』${oddsOf(c, o)}`;
    if (pos % 3 === 1) return `${head}${ks.map((o) => `${lab(o)}の場合は${num(o)}`).join("で、")}。`;
    if (pos % 3 === 2) return `${head}結果ごとの見込みは、${ks.map((o) => `${lab(o)}では${num(o)}`).join("、")}。`;
    return `${head}${ks.map((o) => `${lab(o)}なら${num(o)}`).join("、")}。`;
  }
  const bankKind = B.branch[kind] ? kind : "_generic";
  const bank = B.branch[bankKind] ?? {};
  const s0 = map.st(a);
  const pieces: string[] = [];
  for (const o of ks) {
    const cls = outcomeClass(map, o, ks);
    const { env, slots: s2 } = baseEnv(c, o);
    // 道でその種類の手が何回目か（2 回目からの言い方）と、手を選ぶ時点の届け出の答えと顧客の数（移った・戻った後の言い方を分ける）
    env.n = nth;
    if (mv.nf !== undefined) env.nf = mv.nf;
    env.pm0 = s0.pm;
    env.clr0 = clr(s0.cl);
    env.pf0 = s0.fl.includes("portfolio") ? 1 : 0;
    // 独立してからの月は、手を選ぶ時点の物（会社員に戻った結果の状態では 0 になる。会社員に戻る手の結果の言い方を時点で選ぶ。rep-5）
    env.im = mv.im ?? 0;
    // まとめた行き先（3 年後の平均）か: その数をこの 3 か月の結果として言わない（学校の席など。facts-3）
    env.sumOut = map.sum(o) ? 1 : 0;
    if (map.sum(o)) {
      // まとめた手の結果の給与は 3 年後の平均なので、移る先・昇格の給与として言わない。給与で分かれる手は、その 3 か月の終わりの給与
      // （広げた同じ手の結果の状態と同じ数）で言い、上げ幅をまとめた結果は大きく上がる場合と小幅の場合の 2 つを言う（reader-1）
      const id = map.outId(o);
      const q = quarterSal(map, c.C, cal, a, id);
      delete s2.salx;
      delete s2.salYen;
      if (q !== null) {
        s2.salx = `${slot(f2(q))} 倍`;
        s2.salYen = `年収 ${slot(n0(c.annual * q))} 万円`;
        env.sal1 = Math.abs(q - 1) < 0.005 ? 1 : 0;
      } else if (id === "high_mid") {
        const hi = quarterSal(map, c.C, cal, a, "high");
        const mid = quarterSal(map, c.C, cal, a, "mid");
        if (hi !== null && mid !== null) {
          s2.hiX = `${slot(f2(hi))} 倍`;
          s2.midX = `${slot(f2(mid))} 倍`;
          s2.hiYen = `年収 ${slot(n0(c.annual * hi))} 万円`;
          s2.midYen = `年収 ${slot(n0(c.annual * mid))} 万円`;
        }
      }
    }
    const next = kidsOf(map, o).find((x) => map.kind(x) !== "keep");
    const nextKind = next === undefined ? null : (map.kind(next) ?? "");
    // 結果の数で埋め、年月と手の数（昇格の額・次の顧客の月額）は手の物を使う
    const s3: Slots = { ...slots, ...s2, lab: labelOf(c, o), next1: nextKind === null ? "今のまま" : kindNoun(c, nextKind) };
    for (const k of MOVE_SLOTS) {
      const v = slots[k];
      if (v === undefined) delete s3[k];
      else s3[k] = v;
    }
    if (!map.sum(o)) s3.seatsAdd = slot(n0(Math.max(0, map.st(o).seats - s0.seats)));
    // まとめた結果で、その 3 か月の給与が出せない物は、給与の倍率と年収を言わない（手の今の給与も、3 年後の平均も、結果の給与ではない）
    else for (const k of ["salx", "salYen"] as const) if (s2[k] === undefined) delete s3[k];
    // 会社員に戻った後の給与（今日と同じなら「今日と同じ年収 X 万円」、違えば「今日の N 倍（年収 X 万円）」。reader-10）
    if (kind === "back_emp" && s3.salYen !== undefined && s3.salx !== undefined) s3.salBack = env.sal1 ? `今日と同じ${s3.salYen}` : `今日の ${s3.salx}（${s3.salYen}）`;
    // 1b・W3（con-5）: 転職活動の『転職せず』は、次の判断に転職活動が並ぶか（nextSearch: 並ぶ 1・並ばない 0・まとめた結果で分からない −1）と、
    //   決まりの上限（この会社で searchMax 期・続けて searchRun 期）に届くかで言い分ける（並ばない判断で「続けるか」と言わない）
    if ((kind === "fc_switch" || kind === "fc_switch2") && map.outId(o) === "none") {
      const sd0 = map.st(d);
      env.capQ = usesOf(sd0.fl, "q") + 1 >= c.C.searchMax ? 1 : 0;
      env.capR = usesOf(sd0.fl, "r") + 1 >= c.C.searchRun ? 1 : 0;
      env.nextSearch = map.sum(o) ? -1 : kidsOf(map, o).some((x) => map.kind(x) === "fc_switch2" || map.kind(x) === "fc_switch") ? 1 : 0;
      s3.searchLeft = slot(Math.max(0, c.C.searchMax - usesOf(sd0.fl, "q") - 1));
    }
    // 修正（facts-11）: 学校への提案の『見送られる』は、次の判断に学校への提案が並ぶか（nextSchool: 並ぶ 1・並ばない 0・まとめた結果 −1）で言い分ける
    if (kind === "sd_school" && map.outId(o) === "no") env.nextSchool = map.sum(o) ? -1 : kidsOf(map, o).some((x) => map.kind(x) === "sd_school") ? 1 : 0;
    const fl = map.st(o).fl;
    // 同じ種類の手が続く判断では、言い換えを回す
    const seed = hash(`${kind}|${cls}`) + rot;
    const cell = bank[cls] ? cls : (cls === "a1" || cls === "a0") && bank.a ? "a" : "_any";
    const meaning = choose(bank[cell], env, fl, s3, seed, trace, `branch.${bankKind}.${cell}`) ?? choose(B.branch._generic?._any, env, fl, s3, seed, trace, "branch._generic._any");
    pieces.push(`『${labelOf(c, o)}』${oddsOf(c, o)}なら${meaning ?? ""}`);
  }
  return head + pieces.join("。") + "。";
}
/** 結果の意味の文でも、手の物を使う差し込み（年月・昇格の額・次の顧客の月額・独立してからの月） */
const MOVE_SLOTS = ["ym", "period", "ymNext", "ym1", "ym2", "stepYen", "newFee", "indMonths"] as const;

/**
 * この手の先の数（今日の手）。SPEC §5.1・truth-18: 判断と出来事の分かれを分け、まとめた行き先は見積もりと書く。
 * 行き先は 2 つの数を名前を付けて言う: 地図にある行き先（まとめた物を含む全部。下からの数え上げ）と、一番良い選び方で着く本当の行き先
 * （計算の芯の数。今の年収で決まるので、その場で渡されたときだけ）。手の詳しい画面と同じ数・同じ言い方（reader-4・truth-4・user-13）。
 * 結果の並びは「、」でつなぐ（結果の名前と区切りが混ざらない。reader-5）
 */
function rippleSentence(c: Ctx, a: number): string {
  const { map, cal } = c;
  const r = ripple(map, a);
  const ks = kidsOf(map, a);
  // 1b・W4（con-11）: 結果ごとの分かれ道は、結果の名前と見込み（割）で
  // 修正（reader-1・code-1）: この手の先の分かれ道は、この手の結果の分かれ 1 つと結果ごとの後の数（足すと合わせての数）
  const per = ks.length >= 2 ? `この手の結果の分かれ ${slot(1)} つのほか、${ks.map((o) => `『${labelOf(c, o)}』${oddsOf(c, o)}の後に ${slot(n0(ripple(map, o).forks))}`).join("、")}。` : "";
  // 修正（reader-8）: 今日の手の先がどれもほぼ同じ数の分かれ道まで開いてあることは、10 の手で同じ文なので今日のカードで 1 回だけ言う（evenSentence）
  const sums = r.sumEnds ? `（うち標準の続きの見積もり ${slot(n0(r.sumEnds))}）` : "";
  const reach = c.rt?.reach?.(a) ?? null;
  // % を書かない（C4）。見込み 1% 以上は「100 回に 1 回以上」（「1 分以上」は 1 分間とも読める。R7・点検 C10）
  const how = reach ? `で、一番良い選び方で着くのは ${slot(n0(reach.ends))}（そのうち見込みが ${slot(100)} 回に ${slot(1)} 回以上の物は ${slot(n0(reach.ends1))}）` : "";
  return `この手の先、${cal.ym(cal.horizon)}までの分かれ道は ${slot(n0(r.forks))}（判断 ${slot(n0(r.decisions))}・出来事の分かれ ${slot(n0(r.splits))}）。${per}地図にある行き先は ${slot(n0(r.ends))}${sums}${how}。`;
}

/**
 * 1b・W4（con-11）: 今日の手の先の本当の行き先（標準の続きの見積もりでない物）が着いた所: 仕事（独立の手は独立のままと会社員に戻った道）・
 * Pro を出している道・広告運用の顧客がいる道。数は下からの数え上げ（L7）
 */
function landSentence(c: Ctx, a: number): string {
  const { map } = c;
  const L = landing(map, a);
  if (!L.real) return "";
  const N = (x: number): string => slot(n0(x));
  const R = `標準の続きでない本当の行き先 ${N(L.real)}`;
  let job: string;
  if (map.kind(a) === "ind_quit") job = `${R} のうち、独立のままは ${N(L.ind)} で、${N(L.emp)} は会社員に戻った道${L.part ? `、${N(L.part)} は週 4 日勤務の道` : ""}。`;
  else if (L.emp === L.real) job = `${R} は、どれも会社員の道（移った会社にいるのが ${N(L.switched)}）。`;
  else job = `${R} のうち、会社員が ${N(L.emp)}${L.part ? `・週 4 日勤務が ${N(L.part)}` : ""}${L.ind ? `・独立が ${N(L.ind)}` : ""}（移った会社にいるのは ${N(L.switched)}）。`;
  return `${job}Pro を出している道は ${N(L.pro)}、広告運用の顧客がいる道は ${N(L.clients)}。`;
}

// ---- 手の数の文（1b・W3: rep-1・con-3・con-5・con-15・L1・L2）
// 3 年の見積もり・この手の先の分かれ道・結果ごとの次のおすすめ・暦で逃す評価は、どの手にもある数の枠（構造の文）。言い方は道の上の位置
// （手の月 ÷ 3。今日の手が 0）で 3 つを回す（L2: ハッシュでなく位置で。道 1 本で 1 つの枠は 4 回まで）

/** 手の道の上の位置（今日の手が 0。その手より上にある手の数） */
const posA = (c: Ctx, a: number): number => Math.round(c.map.month(a) / 3);

/** 結果の見込みの添え書き（結果が 2 つ以上の手の結果の名前の後。「（7 割 2 分）」。con-3）。見込みが 0 か 100 なら空 */
const oddsOf = (c: Ctx, o: number): string => {
  const p = c.map.p(o);
  return p > 0 && p < 100 ? `（${wari(p / 100)}）` : "";
};

/**
 * 1b・W3（rep-1・con-3・user-1）: 今日より後の広げた手の、この手の先の分かれ道。結果が 2 つ以上なら結果ごとの数、1 つなら次の判断の手のうち
 * 先が一番多く続く手。数は下からの数え上げ（L7。描くときに木をたどらない）。言い方は位置で 3 つを回す
 */
function moveForkSentence(c: Ctx, a: number, trace: string[]): string {
  const { map, cal } = c;
  const r = ripple(map, a);
  if (!r.forks) return "";
  const hz = cal.ym(cal.horizon);
  const ks = kidsOf(map, a);
  const p = posA(c, a) % 3;
  const F = slot(n0(r.forks));
  const split = `判断 ${slot(n0(r.decisions))}・出来事の分かれ ${slot(n0(r.splits))}`;
  trace.push("move:forks");
  if (ks.length >= 2) {
    const per = ks.map((o) => [o, ripple(map, o).forks] as const);
    // 結果の後に判断が無い（3 年の終わりの手）: 分かれるのはこの手の結果だけ（道で 1 回だけの手）
    if (per.every(([, x]) => x === 0)) return `ここで分かれるのは、この手の ${slot(ks.length)} つの結果だけ（その後は ${hz}の行き先）。`;
    const lab = (o: number): string => `『${labelOf(c, o)}』`;
    // 結果が 3 つ以上なら、判断と出来事の分かれの内訳は言わない（結果ごとの数を先に）
    const br = ks.length >= 3 ? "" : `（${split}）`;
    // 修正（reader-1・facts-5・code-1）: 合わせての数はこの手の結果の分かれ 1 つを含む（結果ごとの後の数を足すと 1 少ない）。どの言い方でも、その 1 つを言う
    const own = `この手の結果の分かれ ${slot(1)} つ`;
    if (p === 0) return `この手の先の分かれ道は ${hz}までに ${F}${br}で、${own}のほかに、${per.map(([o, x]) => `${lab(o)}の後に ${slot(n0(x))}`).join("、")}が続く。`;
    if (p === 1) return `${F} の分かれ道${br}のうち、${slot(1)} つはこの手の結果の分かれで、${per.map(([o, x]) => `${lab(o)}の後に続くのが ${slot(n0(x))}`).join("、")}。`;
    return `結果ごとに数えると、この手の後ろの分かれ道は${per.map(([o, x]) => `${lab(o)}の後が ${slot(n0(x))}`).join("、")}（${own}を入れて ${F}）。`;
  }
  const o = ks[0]!;
  if (map.role(o) !== "s" || !map.childCount(o)) return "";
  const opts = kidsOf(map, o)
    .map((x) => [x, ripple(map, x).forks] as const)
    .sort((x, y) => y[1] - x[1]);
  const yN = cal.ym(map.month(o));
  const [big, bf] = opts[0]!;
  // 次の判断の手の先がどれも見積もり（開いていない）: 残る分かれ道はその判断だけ
  if (!bf) return [`結果は ${slot(1)} つで、残る分かれ道は ${yN}の判断の ${slot(1)} つだけ。`, `この手の後に残る分かれ道は、${yN}に手を選ぶ ${slot(1)} 回だけ。`, `${yN}の判断のほかに、この手の先の分かれ道は無い。`][p]!;
  const nm = `『${optName(c, big)}』`;
  if (p === 0) return `結果は ${slot(1)} つで、その先の ${F} の分かれ道は ${yN}の判断から始まり、一番多く続くのは${nm}の後の ${slot(n0(bf))}。`;
  if (p === 1) return `この手の後ろの分かれ道 ${F}（${split}）は、${yN}に選べる ${slot(opts.length)} つの手に分かれ、${nm}の後が ${slot(n0(bf))} で一番多い。`;
  return `${yN}の判断から先に ${F} の分かれ道が続き、そのうち${nm}を選んだ後が ${slot(n0(bf))}。`;
}

/** 判断 d のおすすめの手（計算の芯があれば画面のおすすめ、無ければ地図の why=best） */
const recOf = (c: Ctx, d: number): number => {
  const x = c.rt?.recommended?.(d) ?? -1;
  return x >= 0 ? x : recommended(c.map, d);
};

/**
 * 1b・W3（con-3）: 結果が 2 つ以上の手の、結果ごとの次の判断のおすすめの手（画面のおすすめと同じ手。点検 C13）。どの結果でも同じなら 1 回だけ言う。
 * おすすめと言えるのは、計算の芯が渡されたときか、地図を作った年収で組み立てるとき（ほかの年収では言わない）。言い方は位置で 3 つを回す
 */
function nextRecSentence(c: Ctx, a: number, trace: string[]): string {
  const { map, cal } = c;
  const all = kidsOf(map, a);
  const ks = all.filter((o) => map.role(o) === "s" && map.childCount(o) > 0);
  if (all.length < 2 || ks.length < all.length) return "";
  if (!c.rt?.recommended && c.annual !== map.header.annual) return "";
  const pairs = ks.map((o) => [o, listName(c, recOf(c, o))] as const);
  const yN = cal.ym(map.month(ks[0]!));
  const p = posA(c, a) % 3;
  trace.push("move:next");
  if (pairs.every(([, x]) => strip(x) === strip(pairs[0]![1]))) {
    const nm = `『${pairs[0]![1]}』`;
    return [`どの結果でも、次の判断（${yN}）のおすすめは${nm}。`, `${yN}のおすすめの手は、どの結果の後も${nm}。`, `結果によらず、次に選ぶおすすめの手は${nm}。`][p]!;
  }
  // 同じおすすめの結果はまとめて言う（「『A』と『B』の後は『X』」）
  const groups: Array<{ rec: string; labs: string[] }> = [];
  for (const [o, x] of pairs) {
    const g = groups.find((y) => strip(y.rec) === strip(x));
    if (g) g.labs.push(`『${labelOf(c, o)}』`);
    else groups.push({ rec: x, labs: [`『${labelOf(c, o)}』`] });
  }
  if (p === 0) return `次の判断（${yN}）のおすすめは、${groups.map((g) => `${g.labs.join("と")}なら『${g.rec}』`).join("、")}。`;
  if (p === 1) return `${yN}に選ぶ手は、${groups.map((g) => `${g.labs.join("と")}の後は『${g.rec}』`).join("、")}がおすすめ。`;
  return `おすすめの次の手は結果で変わり、${groups.map((g) => `${g.labs.join("と")}の後は『${g.rec}』`).join("、")}。`;
}

/** 選べなくなる手の名詞の並び（「・」でつなぐ。届け出の手は「届け出」、転職活動とその続きは「転職活動」にまとめる） */
function closedNouns(c: Ctx, kinds: readonly string[]): string {
  const out: string[] = [];
  for (const k of kinds) {
    const n = FILING_RULE.has(k) ? "届け出" : k === "fc_switch" || k === "fc_switch2" ? "転職活動" : kindNoun(c, k);
    if (!out.includes(n)) out.push(n);
  }
  return out.join("・");
}

/** 決まりで選べなくなるかを見る手の種類（今のままは除く） */
const RULE_KINDS: readonly string[] = ["fc_push", "fc_scope", "fc_switch", "fc_switch2", "part", "ad_permside", "sd_permpro", "ad_perm", "ad_side", "ad_more", "ad_portfolio", "sd_grow", "sd_ads", "sd_retain", "sd_pilot", "ind_quit", "back_emp"];
/** 届け出の手（まとめて「届け出」と言う） */
const FILING_RULE = new Set(["ad_permside", "sd_permpro", "ad_perm"]);

/**
 * 1b・W3（con-5・con-4）: この手を選ぶと、次の判断から決まりで選べなくなる手の種類（今の判断では選べて、この手のどの結果の後でも選べない）。
 * 決まりは生成の feasibleQ と同じ allowedKind で、月は今の判断の月で見る（4 月の評価のような暦で変わる手を、この手のせいにしない）。
 * 広げた手は結果の状態で見る（次の判断の並びと食い違わない）。まとめた手（結果は 3 年後の平均）は、その手の種類で決まる物だけ:
 * 担当を広げる・続ける工夫・週 4 日の相談・届け出・独立・集客と広告の最後の期・転職活動の上限
 */
function closedKinds(c: Ctx, a: number): string[] {
  const { map, C } = c;
  const d = map.parent(a);
  const m = map.month(d);
  const s0 = map.st(d);
  const kind = map.kind(a) ?? "";
  // 転職活動の上限（この会社で 4 期・続けて 2 期）は、結果の意味の文（『転職せず』なら…）が言う
  if (kind === "fc_switch" || kind === "fc_switch2") return [];
  const ks = kidsOf(map, a);
  const open = RULE_KINDS.filter((k) => allowedKind(c, s0, k, m) === true);
  if (!map.stub(a) && ks.length && ks.every((o) => map.role(o) === "s")) return open.filter((k) => ks.every((o) => allowedKind(c, map.st(o), k, m) === false));
  const out: string[] = [];
  const emp = s0.j === "e" || s0.j === "p";
  if (kind === "fc_scope" || kind === "sd_retain" || kind === "part") out.push(kind);
  if (FILING_RULE.has(kind)) out.push(...open.filter((k) => FILING_RULE.has(k)));
  if (kind === "ind_quit" && emp) out.push(...open.filter((k) => ["fc_push", "fc_scope", "fc_switch", "fc_switch2", "part", "ad_portfolio", "ad_side", ...FILING_RULE].includes(k)));
  if (kind === "sd_grow" && usesOf(s0.fl, "g") + 1 >= C.growMax) out.push(kind);
  if (kind === "sd_ads" && usesOf(s0.fl, "a") + 1 >= C.adsMax) out.push(kind);
  return open.filter((k) => out.includes(k));
}

/**
 * 1b・W3（con-5）: 4 月を含む 3 か月の判断で、昇格を狙う手のほかを選ぶと、この地図では次の評価まで昇格しない（昇格は昇格を狙う手の 4 月だけ）。
 * 判断の並びに昇格を狙う手があるときだけ言う。言い方は位置で 3 つを回す（構造の文）
 */
function aprilSentence(c: Ctx, a: number, trace: string[]): string {
  const { map, cal } = c;
  const d = map.parent(a);
  const kind = map.kind(a) ?? "";
  if (kind === "fc_push" || !kidsOf(map, d).some((x) => map.kind(x) === "fc_push")) return "";
  const m = map.month(d);
  const ap = cal.aprils.find((q) => q > m && q <= m + 3);
  if (ap === undefined) return "";
  const next = cal.aprils.find((q) => q > ap && q <= cal.horizon);
  const p = posA(c, a) % 3;
  trace.push("move:april");
  const ya = cal.ym(ap);
  if (next === undefined) return [`この手を選ぶと ${ya}の評価で昇格は狙わず、この地図の 3 年で昇格する機会はもう来ない。`, `${ya}の評価は昇格を狙わずに過ぎ、${cal.ym(cal.horizon)}までに次の評価は無い。`, `昇格を狙わないまま ${ya}の評価が過ぎると、3 年のうちに昇格する道は残らない。`][p]!;
  const yn = cal.ym(next);
  return [`この手を選ぶと ${ya}の評価で昇格は狙わず、次に狙えるのは ${yn}の評価。`, `${ya}の評価は昇格を狙わずに過ぎ、次の機会は ${yn}。`, `昇格を狙わないまま ${ya}の評価が過ぎると、次は ${yn}の評価まで待つ。`][p]!;
}

/** 判断の比べる元（今のまま）。無ければ −1 */
function baseOf(map: MapData, d: number): number {
  for (let k = 0; k < map.childCount(d); k++) if (map.isBase(map.child(d, k))) return map.child(d, k);
  return -1;
}

/** 判断に why=best の手があるか（今日の判断は今のままと比べる） */
function hasBest(map: MapData, d: number): boolean {
  for (let k = 0; k < map.childCount(d); k++) if (map.why(map.child(d, k)) === "best") return true;
  return false;
}

/**
 * 手の名前: そのカードの題（見取り図の行・道の画面の「選べる手」・キャンバスのカードと同じ名前。P4・reader-1: 前は手の種類の名前で、
 * 見取り図が『給与の上がる転職先を探す』と出す手を本文は『転職活動をする』と言っていた）。比べる元は「この 3 か月は今のまま」（画面も同じ: reader-8）。
 * 題の数・手引きの印はそのまま（点検は、題の中の数をそのカードの題から来た物として確かめる: checks.ts の quotedTitleSpans）
 */
function listName(c: Ctx, x: number): string {
  const { map } = c;
  if (map.isBase(x)) return "この 3 か月は今のまま";
  return nameOf(c, x);
}

/**
 * カード x の名前: 組み立てた題（印つき）。文書で利用者が書き換えた題があれば、その題（画面のどこでもその名前で出る: P4 の見直し reader-1。
 * 書き換えた題は利用者の言葉なので印を付けない。点検は地図の題だけを見る）
 */
function nameOf(c: Ctx, x: number): string {
  const t = titleOf(c, x, []);
  const own = c.rt?.title?.(x);
  if (!own) return t;
  const plain = own.replace(/[\u0001-\u0004]/g, "").trim();
  return plain && plain !== spaceJa(strip(t)) ? plain : t;
}

/**
 * この手の 3 年の見積もり: その判断から 3 年後（36 か月目）までの稼ぎと、おすすめの手（おすすめの手なら今のまま、今日は今のまま）との差。
 * どれも同じ見積もり方（その 3 か月は正確に・その後は標準の選び方。SPEC §2.4 の q）で、その見積もり方だと書く（手の詳しい画面の 3 年の合計は
 * 一番良い選び方の平均なので、今日の手はそれも添える。truth-4）。まとめた手は、先の分かれ道を開かない見積もりだと書く
 * （reader-1: 決まった一文の代わりに、この手自身の見積もりと差。reader-2: どの手のカードも 3 年への影響を言う）。
 * おすすめは、計算の芯が渡されれば今の年収の一番良い選び方の手（画面の「おすすめ」の印と同じ。truth-1・reader-8）、無ければ地図の why=best
 * （生成の年収の見積もりで一番の手。ほかの年収ではそう書く）。名前は道の画面の並びと同じ手の名前。
 * おすすめの手より見積もりが多い手は、おすすめがその後の選び直しまで入れた値で一番だと訳を言う（「おすすめより多い」とだけ言わない）
 */
function valueSentence(c: Ctx, a: number, trace: string[]): string {
  const { map, cal } = c;
  const v = optionValue(map, a, c.annual);
  if (v === null) return "";
  const d = map.parent(a);
  const hz = cal.ym(cal.horizon);
  const root = map.role(d) === "r";
  const pi = !root && c.rt?.recommended ? c.rt.recommended(d) : -1;
  const best = !root && (pi >= 0 || hasBest(map, d));
  const ref = best ? (pi >= 0 ? pi : recommended(map, d)) : baseOf(map, d);
  // おすすめと言えるのは、今の年収で決めた手（計算の芯）か、生成の年収で組み立てるとき。ほかは、どの年収の見積もりで一番かを言う
  const sure = pi >= 0 || c.annual === map.header.annual;
  const recName = (x: number): string => (sure ? `おすすめの『${listName(c, x)}』` : `年収 ${slot(n0(map.header.annual))} 万円の見積もりで一番の『${listName(c, x)}』`);
  const diff = (x: number, name: string, rec: boolean): string => {
    const vr = optionValue(map, x, c.annual);
    if (vr === null) return "";
    const g = v - vr;
    if (Math.abs(g) < 1) return `${name}とほぼ同じ`;
    if (rec && pi >= 0 && g > 0) return `見積もりでは${name}より ${amount(g)} 万円多いが、その後の選び直しまで入れると『${listName(c, x)}』の方が上`;
    return `${name}より ${amount(Math.abs(g))} 万円${g > 0 ? "多い" : "少ない"}`;
  };
  let cmp: string;
  if (ref === a) {
    // おすすめの手（今日なら比べる元の今のまま）: 今のままと比べる
    const base = baseOf(map, d);
    const vs = base >= 0 && base !== a ? diff(base, "今のまま", false) : "";
    const me = sure ? "おすすめの手" : `年収 ${slot(n0(map.header.annual))} 万円の見積もりで一番の手`;
    cmp = best ? `${me}${vs ? `で、${vs}` : ""}` : "ほかの手はこの道と比べる";
  } else cmp = ref >= 0 ? diff(ref, best ? recName(ref) : "今のまま", best) : "";
  trace.push(map.stub(a) ? "value:stub" : "value");
  // 1b・W3（rep-1・con-15・L1）: 見積もり方の長い言い方は、道で最初に広げた手（今日の手）だけ。その後の広げた手は短い言い方を位置で 3 つ回す
  if (!root && !map.stub(a)) {
    const amt = `${amount(v)} 万円`;
    const tail = cmp ? `（${cmp}）` : "";
    return [`${hz}までの稼ぎの見積もりは ${amt}${tail}。`, `この手を選ぶと、${hz}までの稼ぎは ${amt}ほどの見積もり${tail}。`, `見積もりでは、ここから ${hz}までに ${amt}を稼ぐ${tail}。`][posA(c, a) % 3]!;
  }
  // 見積もり方を言う（まとめた手は下の注が言う）
  const basis = map.stub(a) ? "" : "、その後を標準の選び方で続けた見積もりで";
  const head = `この手で進むと、ここから ${hz}までの稼ぎは${basis}合わせて ${amount(v)} 万円ほど${cmp ? `（${cmp}）` : ""}。`;
  // 今日の手: 手の詳しい画面の 3 年の合計（一番良い選び方の平均）も添える（同じ手の 2 つの数の訳。truth-4）
  const tv = root && !map.stub(a) ? (c.rt?.treeValue?.(a) ?? null) : null;
  const tree = tv !== null && Number.isFinite(tv) ? `その後を一番良い選び方で進めば、平均 ${amount(tv)} 万円。` : "";
  // まとめた手の注（truth-2: 先は一番良い選び方ではなく、標準の選び方で続けた見積もり）
  return map.stub(a) ? `${head}この手の先は分かれ道を開かず、標準の選び方で続けた見積もり。` : head + tree;
}

/** 避けたい手の訳に差し込む値（今の年収で決まる。給与は年収と月にならした額で言う） */
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
  return { need: slot(need), needOk: need <= capLeft ? "1" : "", capLeft: slot(capLeft), salNow: `年収 ${slot(n0(c.annual * rr0))} 万円・月にならして ${slot(man(sal))} 万円`, partLoss: `月にならして ${slot(man(partLoss))} 万円`, needPu: slot(n0(needPu)) };
}

/** 今のままの手の本文に書く歩みの覚え（地図と束ごとの道の覚え links を鍵にする。年収では変わらない） */
const KEEP_ACTS = new WeakMap<Map<number, Link>, Map<number, readonly string[]>>();

/**
 * 今のままの手 a の本文に書く歩み（2 つまで。今日の手は 1 つ）の番号: 1 つ前の判断に並んだ今のまま（この道で選ばなかった方。その判断で選んだ手が
 * 今のままでないとき）が本文に書く歩みを除く（どの判断にも今のままが並ぶので、判断ごとに同じ歩みの文が続かないように。点検 C6 の判断ごとの繰り返し）。
 * 1 つ前の今のままも同じ決まりで選ぶので、判断をさかのぼって覚える
 */
function keepActIds(c: Ctx, a: number): readonly string[] {
  const { map } = c;
  let memo = KEEP_ACTS.get(c.links);
  if (!memo) {
    memo = new Map();
    KEEP_ACTS.set(c.links, memo);
  }
  const hit = memo.get(a);
  if (hit) return hit;
  const d = map.parent(a);
  const link = linkOf(c, d);
  const used = usedSet(link);
  const fresh = stepsFor(c, a, countKind(link, "keep"), used, recentSteps(link), pathEnv(c, link)).filter((st) => !used.has(st.id));
  let prev: readonly string[] = [];
  if (map.role(d) === "s") {
    const via = map.parent(d);
    const d2 = map.parent(via);
    const k2 = kidsOf(map, d2).find((x) => x !== via && map.kind(x) === "keep");
    if (k2 !== undefined) prev = keepActIds(c, k2);
  }
  const pick = fresh.filter((st) => !prev.includes(st.id));
  // 1.2（W5・con-8）: 文で書く歩みは 3 つまで（残りはやることの言葉で段取りに入る）
  //   1 つ前の今のままと同じ歩みしか無ければ、文では書かない（やることの言葉で言う）
  const out = pick.slice(0, 3).map((st) => st.id);
  if (memo.size > 60_000) memo.clear();
  memo.set(a, out);
  return out;
}

// ---- 1b・W4（L4）: 手で、今日の手の答えがこの手の前提になっているときの 1 文（道で 1 回だけ）

/** 手 a（判断の覚え L から選ぶ手）で、今日の手の答えがこの手の前提になっているときの文（束の moveThread）。無ければ空 */
function moveThreadText(c: Ctx, a: number, L: Link, trace: string[] | null): string {
  const { map, B } = c;
  if (L.first < 0) return "";
  const fl = firstStateLink(L);
  if (!fl) return "";
  const fk = map.kind(L.first) ?? "";
  const vs = B.moveThread?.[fk];
  if (!vs || !endGov(c, L, fl)) return "";
  const s = map.st(L.i);
  const env: Env = { mk: map.kind(a) ?? "", pm: s.pm, j: s.j, pro: s.pro, fo: map.outId(fl.i) };
  const slots: Slots = { ...constSlots(c.C), first: firstName(c, L.first), firstLab: labelOf(c, fl.i), indMonths: slot(indMonthsAt(L, map.month(L.i), s.j)) };
  return choose(vs, env, s.fl, slots, 0, trace ?? [], `moveThread.${fk}`) ?? "";
}

/** 判断の覚え L より上の道の手で、今日の手の答えの文を言ったか（道だけで決まる。覚えは道の覚えごと） */
const MOVE_THREAD = new WeakMap<Link, boolean>();
function moveThreadAbove(c: Ctx, L: Link): boolean {
  if (!L.up) return false;
  const hit = MOVE_THREAD.get(L);
  if (hit !== undefined) return hit;
  const v = moveThreadAbove(c, L.up) || moveThreadText(c, L.move, L.up, null) !== "";
  MOVE_THREAD.set(L, v);
  return v;
}

/** 手 a が今日の手の答えの文を言うか（道の上の手でまだ言っておらず、1 つ前の判断に並んだ同じ種類の手（この道で選ばなかった方）も言っていない） */
const MOVE_THREAD_SAYS = new WeakMap<Map<number, Link>, Map<number, boolean>>();
function moveThreadSays(c: Ctx, a: number): boolean {
  const { map } = c;
  let memo = MOVE_THREAD_SAYS.get(c.links);
  if (!memo) {
    memo = new Map();
    MOVE_THREAD_SAYS.set(c.links, memo);
  }
  const hit = memo.get(a);
  if (hit !== undefined) return hit;
  const d = map.parent(a);
  const L = linkOf(c, d);
  let v = !moveThreadAbove(c, L) && moveThreadText(c, a, L, null) !== "";
  // 続く 2 つの判断に並ぶ同じ種類の手が、同じ文を並べない（点検 C6 の判断ごとの繰り返し）
  if (v && map.role(d) === "s") {
    const via = map.parent(d);
    const k2 = kidsOf(map, map.parent(via)).find((x) => x !== via && map.kind(x) === map.kind(a));
    if (k2 !== undefined && moveThreadSays(c, k2)) v = false;
  }
  if (memo.size > 60_000) memo.clear();
  memo.set(a, v);
  return v;
}

/** 手 a の、今日の手の答えの文（言うときだけ） */
function moveThreadSentence(c: Ctx, a: number, trace: string[]): string {
  if (!moveThreadSays(c, a)) return "";
  const t = moveThreadText(c, a, linkOf(c, c.map.parent(a)), trace);
  if (t) trace.push("move:thread");
  return t;
}

/** 1b・W3: 手の本文の長さの目安（点検 C3 の上 LIMITS.a.max 740 より短く。超えるときは決まった順に文を落とす。1.2 は段取りの文を縮める） */
export const MOVE_BUDGET = 680;
/** 1b・W3: 今日の手の本文の長さの目安（点検 C3 の FIRST_MOVE_MAX より短く。今日の手は結果ごとの分かれ道と行き先を言うので長い。修正（reader-8）: 900 → 980。10 の手で同じ形の文を先に落とし、段取りは縮めない） */
export const FIRST_MOVE_BUDGET = 980;

/**
 * 1.2（W5・con-8）: 手の段取りの 1 文（その 3 か月の k 番目の月 mon にやること）。how: full は手引きの本文の文、short はやることの言葉、
 * again は道で前に使った歩みをもう一度やる言い方。月の数は差し込み、やることの言葉は手引きの印の中（数字は引いた項目の物。点検 C1b）
 */
function planSentence(st: Step, mon: number, same: boolean, k: number, how: "full" | "short" | "again", same2 = false): string {
  const m = `${slot(mon)} 月`;
  // 3 つとも同じ月なら、3 つ目は「同じ M 月に」を繰り返さない
  const at = same ? `同じ ${m}に、` : `${m}は、`;
  // 「さらに、」は手引きの印の中に入れる（月の言葉の外に出すと、印を落とした骨組みが長くなり、続く判断の同じ種類の手と重なる。点検 C6）
  const go = same2 ? "さらに、" : "";
  // 句点は手引きの印の外に置く（点検の骨組みは印の中を落とすので、月の言葉だけの切れ端にして次の文とつなげない）
  if (how === "full") return `${at}${pbText(go + st.act.replace(/。$/, ""))}。`;
  // やることの言葉で言う文も、月の言葉の後を手引きの印の中に入れる（続く判断の同じ種類の手と、印を落とした骨組みが同じにならない。点検 C6）
  const td = st.todo;
  if (how === "again") return `${at}${pbText(`${go}前にもやった「${td}」をもう一度やる`)}。`;
  if (same) return `${at}${pbText(`${go}「${td}」も済ませる`)}。`;
  return `${m}は、${pbText([`「${td}」から始める`, `「${td}」に取りかかる`, `「${td}」を済ませる`][k % 3]!)}。`;
}

/**
 * 1.2（W5・con-8）: 判断の月 m0 から選ぶ手 kind の段取りの 3 つの月（暦の月）。答えの前に済ませる手（4 月の評価・届け出・週 4 日の相談・学校への提案）は、
 * 答えの月より後に段取りを置かない（評価の後に実績を絞る、と言わない）
 */
//   届け出は答えが 1 か月目に出るので、3 つとも 1 か月目（修正・reader-2・code-2: 手引きは答えを受けた後の歩みを選ばないので、2 か月目に置くと
//   「答えを待つ間に」が答えの後になる。書き出しの届け出る月も 1 か月目）。週 4 日の相談と学校への提案は答えが 2 か月目
const PLAN_AT: Readonly<Record<string, readonly number[]>> = { ad_perm: [1, 1, 1], ad_permside: [1, 1, 1], sd_permpro: [1, 1, 1], part: [1, 2, 2], sd_school: [1, 2, 2] };
export function planMonths(c: Ctx, kind: string, m0: number): number[] {
  const at = PLAN_AT[kind];
  if (at) return at.map((k) => c.cal.parts(m0 + k)[1]);
  const last = kind === "fc_push" ? eventMonth(c.cal, kind, m0) : m0 + 3;
  return [1, 2, 3].map((k) => c.cal.parts(Math.min(m0 + k, last))[1]);
}

/** 手のカード。書き出し・分かれ目は、道でその種類の手が何回目か（nth）で言い換えを回す */
function composeMove(c: Ctx, a: number): Card {
  const { map, B } = c;
  const trace: string[] = [];
  const d = map.parent(a);
  const kind = map.kind(a) ?? "";
  const { env, slots: s2, seed, nth, offered, link, steps, fresh } = moveCtx(c, a);
  const fl = map.st(a).fl;
  const title = titleOf(c, a, trace);
  const lead = choose(B.lead[kind], env, fl, s2, seed, trace, `lead.${kind}`) ?? "";
  // 1.2（W5・con-8）: やること 3 つを、その 3 か月の月に 1 つずつ置いた段取りの文にする（「12 月は、…。1 月は、…。2 月は、…。」）。
  //   道で初めて使う歩みは本文の文（act）、前に使った歩みはやることの言葉で「もう一度やる」と言う（同じ文を道で 2 回書かない。点検 C6）。
  //   今のままは、1 つ前の判断に並んだ今のまま（この道で選ばなかった方）が文で書く歩みを、やることの言葉で言う（続く判断で同じ文を並べない）。
  //   長さの目安を超えるときは、2 つ目と 3 つ目をやることの言葉に縮める（move:drop:plan）
  const fullIds = new Set((kind === "keep" ? keepActIds(c, a) : fresh.map((st) => st.id)));
  const freshIds = new Set(fresh.map((st) => st.id));
  const mons = planMonths(c, kind, map.month(a));
  const planOf = (short: boolean): string => join(steps.map((st, k) => planSentence(st, mons[k]!, k > 0 && mons[k] === mons[k - 1], k, freshIds.has(st.id) ? (fullIds.has(st.id) && !(short && k > 0) ? "full" : "short") : "again", k > 1 && mons[k] === mons[k - 2])));
  const acts = planOf(false);
  // お金と仕事・この先の見込みが変わる手だけ、その中身（週の時間は数の行。SPEC §4.2）。結果が事実の場合をまとめた 1 つなら、
  // 見込みは分かれ目の文で言うので重ねない
  const mergedOnly = map.childCount(a) === 1 && mergedFact(map, map.child(a, 0));
  const cost = B.cost[kind] && !mergedOnly ? (choose(B.cost[kind], env, fl, s2, seed, trace, `cost.${kind}`) ?? "") : "";
  // 1b・W3（con-4）: 同じ種類の手の 2 回目からは、何回目か・前提の上限まであと何回か・ここまでに積んだ物（束の progress。数は差し込み）
  //   数の枠なので、組の言い換え 3 つを道の上の位置で回す（種を位置にする。L2）
  const pos = posA(c, a);
  const prog = choose(B.progress?.[kind], env, fl, s2, pos, trace, `progress.${kind}`) ?? "";
  const watch = watchSentence(c, a, s2, nth, offered, trace, env);
  // 1b・W3（con-5）: この手で次の判断から決まりで選べなくなる手（束の rules。無い種類は決まった言い方）と、4 月の評価を逃すこと
  const closed = closedKinds(c, a);
  let rules = "";
  if (closed.length) {
    const others = closed.filter((k) => k !== kind);
    // 修正（reader-6）: 顧客の数の違う場合をまとめた結果（幅のある結果）で上限に届くとみるときは、届いたと決めて言わない（cbandOut）
    const cbandOut = kidsOf(map, a).some((o) => {
      const [lo, hi] = clBand(map, o);
      return lo !== hi;
    });
    const re: Env = { ...env, closeSelf: closed.includes(kind) ? 1 : 0, closeOther: others.length ? 1 : 0, cbandOut: cbandOut ? 1 : 0 };
    const rs: Slots = { ...s2, closedList: closedNouns(c, others.length ? others : closed) };
    rules = choose(B.rules?.[kind], re, fl, rs, pos, trace, `rules.${kind}`) ?? choose(B.rules?._generic, re, fl, rs, pos, trace, "rules._generic") ?? "";
  } else if (kind === "keep") {
    // 今のまま: この判断に並ぶ手のうち、3 か月待つと遅れる・見送る物（届け出・顧客探し・転職活動）。判断の並びと状態で選ぶ（con-5）
    const menu = new Set(kidsOf(map, d).map((x) => map.kind(x) ?? ""));
    const sd = map.st(d);
    const ke: Env = { ...env, mFile: (menu.has("ad_permside") || menu.has("sd_permpro") || menu.has("ad_perm")) && sd.pm === "?" ? 1 : 0, mSide: menu.has("ad_side") ? 1 : 0, mSearch: menu.has("fc_switch") || menu.has("fc_switch2") ? 1 : 0 };
    rules = choose(B.rules?.keep, ke, fl, s2, pos, trace, "rules.keep") ?? "";
  }
  const april = aprilSentence(c, a, trace);
  const value = valueSentence(c, a, trace);
  // この手の先の分かれ道の数: 今日の手は結果ごと・行き先まで、ほかの広げた手は結果ごとか次の判断の手ごと（まとめた手は先の分かれ道を開かないので書かない）。
  //   結果が 2 つ以上の手は、結果ごとの次のおすすめの手も言う（con-3）
  const ripple1 = map.stub(a) ? "" : map.role(d) === "r" ? rippleSentence(c, a) : moveForkSentence(c, a, trace);
  if (ripple1) trace.push("ripple");
  // 今日の手の、本当の行き先が着いた所（修正・reader-8: 10 の手で同じ形の数の文なので、長さの目安では段取りを縮めるより先に落とす）
  const land = map.role(d) === "r" && !map.stub(a) ? landSentence(c, a) : "";
  const next = map.stub(a) ? "" : nextRecSentence(c, a, trace);
  // 避けたい訳（道で 1 回だけ。その先の状態の段取りと同じ答え）
  let avoid = "";
  if (avoidAllowed(c, a, link)) {
    const av = avoidSlots(c, a);
    avoid = choose(B.avoid[kind], { ...env, needOk: av.needOk ? 1 : 0 }, fl, { ...s2, ...av }, seed, trace, `avoid.${kind}`) ?? "";
  }
  // 1b・W3（rep-2・rep-9）: 来た訳（「『結果』を受けて、」「前の 3 か月は…た。」）は書かない（真上の状態のカードが、その 3 か月を言っている）。
  //   代わりに、この手を今選ぶ訳（束の why。1 つ前の判断の出来事と状態で選ぶ。今日の手は無し）を書き出しにする
  //   言い換えは、その出来事が道で何回目かで選ぶ（同じ出来事の後に同じ手が道で 2 回来ても、同じ訳を並べない）
  const why = map.role(d) === "r" ? "" : (choose(B.why?.[kind], env, fl, s2, (env.pevn as number) + nth, trace, `why.${kind}`) ?? "");
  // 1b・W3: 長さの目安（MOVE_BUDGET・今日の手は FIRST_MOVE_BUDGET）を超えるときは、決まった順に落とす: 4 月の評価を逃す文 → 選べなくなる手 →
  //   結果ごとの次のおすすめ → 手の時間とお金 → 進み具合 → この手を今選ぶ訳（結果が 3 つ以上の届け出と独立の手が長い）。書き出し・手引き・
  //   分かれ目・3 年の見積もり・分かれ道は落とさない
  // 1b・W4（L4）: 今日の手の答えがこの手の前提になっているときの 1 文（道で 1 回だけ。長さの目安では落とさない）
  const thread = map.role(d) === "r" ? "" : moveThreadSentence(c, a, trace);
  const parts = [why, lead, thread, acts, cost, prog, avoid, watch, rules, april, value, ripple1, land, next];
  const at = { why: 0, plan: 3, cost: 4, prog: 5, rules: 8, april: 9, land: 12, next: 13 } as const;
  const root = map.role(d) === "r";
  const budget = root ? FIRST_MOVE_BUDGET : MOVE_BUDGET;
  let size = parts.reduce((x, t) => x + len(t), 0);
  // 1b・W4（con-11）: 今日の手は、結果ごとの次のおすすめを落とさない（手の時間とお金を先に落とす）
  // 1.2（W5・con-8）: 段取りの文は落とさず、2 つ目と 3 つ目をやることの言葉に縮める（plan）。やること 3 つはどれも本文で月に置く
  const order = root ? (["april", "rules", "cost", "land", "plan", "prog", "why"] as const) : (["april", "rules", "next", "plan", "cost", "prog", "why"] as const);
  for (const k of order) {
    if (size <= budget) break;
    const was = parts[at[k]]!;
    if (!was) continue;
    parts[at[k]] = k === "plan" ? planOf(true) : "";
    size -= len(was) - len(parts[at[k]]!);
    trace.push(`move:drop:${k}`);
  }
  const body = join(parts);
  return { title, short: kindShort(c, kind), body, numbers: numbersRow(c, a), todo: steps.map((st) => ({ text: st.todo, cite: st.id })), trace };
}

// ---- 状態

/** 状態の文に出す出来事（大きな物 2 つまで。移った・戻った会社の出来事は、その移り変わりの一部なのでいつも出す） */
function shownEvents(link: Link): Ev[] {
  const out: Ev[] = [];
  let main = 0;
  for (const e of link.evs) {
    if (e.quiet) continue;
    const emp = e.code.startsWith("NEW_EMP_");
    if (!emp && main >= 2) continue;
    if (!emp) main++;
    out.push(e);
  }
  return out;
}

/** 静かな期（大きな出来事が無い） */
const isQuiet = (link: Link): boolean => link.evs.every((e) => e.code.startsWith("QUIET") || e.quiet);

/** 状態の値（3 か月の有料会員の増え dpu を足す） */
function stateEnv(c: Ctx, n: number, link: Link): { env: Env; slots: Slots } {
  const { map } = c;
  const r = baseEnv(c, n);
  const before = map.st(link.up ? link.up.i : n);
  const dpu = Math.max(0, Math.round(map.st(n).pu) - Math.round(before.pu));
  r.env.dpu = dpu;
  // 次の判断（この状態の子）に転職活動の続きが並ぶか（「応募を続ければ」は並ぶときだけ言う。reader-3）
  r.env.next2 = kidsOf(map, n).some((x) => map.kind(x) === "fc_switch2" || map.kind(x) === "fc_switch") ? 1 : 0;
  // 0.8: 1 つ前の判断の時点で、もう担当を広げていたか（2 回目の担当を広げる 3 か月は、昇格の見込みをもう上げない）
  r.env.scope0 = before.fl.includes("scope") ? 1 : 0;
  r.slots.dpu = slot(dpu);
  r.slots.pu0 = slot(n0(before.pu));
  return r;
}

/** 節目からの月の文に使う出来事 */
const SINCE_CODES = new Set(["IND_START", "SWITCH_HIGH", "SWITCH_MID", "SWITCH_MIX", "PERM_A", "PERM_S", "PERM_N", "PART_ON", "PROMO", "FIRST_CLIENT", "SCHOOL_ON", "CLIENT_UP", "PILOT_ON", "PORTFOLIO_ON", "BACK_EMP"]);

/** その状態の節目（3 か月以上前の一番新しい節目。同じ月なら大事な方。9 か月目からは「まだ無い」も 1 つの節目として数える） */
function sinceEvent(c: Ctx, link: Link): Ev | null {
  const m = c.map.month(link.i);
  let best: Ev | null = null;
  for (const e of eventsList(link)) {
    if (!SINCE_CODES.has(e.code) || m - e.m < 3) continue;
    if (!best || e.m > best.m || (e.m === best.m && MILESTONE_RANK.indexOf(e.code) < MILESTONE_RANK.indexOf(best.code))) best = e;
  }
  return best;
}
function sinceKeyOf(c: Ctx, link: Link): string | null {
  if (!link.up) return null;
  const e = sinceEvent(c, link);
  if (e) return `${e.code}@${e.m}`;
  return c.map.month(link.i) >= 9 ? "none" : null;
}

/** 節目の仲間（届け出の答え・転職は答えや上げ幅が違っても同じ種類の節目） */
const milestoneFamily = (code: string): string => (code.startsWith("PERM_") ? "PERM" : code.startsWith("SWITCH_") ? "SWITCH" : code);

/**
 * 節目からの月（user-9c: 節目が変わったときだけ書く。同じ種類の節目の 2 回目からは、その言い方で。点検 C6）。
 * この 3 か月に節目が起きた状態では書かない（その出来事の文が新しい節目を言う。「まだ無い」「独立してから」と食い違わない。facts-7・reader-10）
 */
function sinceClause(c: Ctx, link: Link, plan: Plan): string {
  if (!plan.sinceKey || !link.up || plan.sinceKey === planOf(c, link.up).sinceKey) return "";
  if (link.evs.some((e) => SINCE_CODES.has(e.code))) return "";
  const m = c.map.month(link.i);
  const e = sinceEvent(c, link);
  if (!e) return `今日から ${slot(m)} か月、大きな節目はまだ無い。`;
  const n = slot(m - e.m);
  const fam = milestoneFamily(e.code);
  const again = c.B.sinceAgain[fam];
  if (again) {
    const before = eventsList(link).filter((x) => x.m < e.m && SINCE_CODES.has(x.code) && milestoneFamily(x.code) === fam).length;
    if (before >= 1) return `${fill(again[Math.min(before, again.length) - 1]!, { ...e.x, n, nth: slot(before + 1) }) ?? ""}。`;
  }
  const own = c.B.since[e.code];
  if (own) return `${fill(own, { ...e.x, n }) ?? ""}。`;
  const name = fill(c.B.eventShort[e.code] ?? "", e.x);
  return name ? `${name}から ${n} か月。` : "";
}

/** 同じ手の別の結果のうち、比べる物（一番違う物。状態の数だけで決まり、年収では変わらない） */
function contrastSib(c: Ctx, o: number): number | null {
  const { map } = c;
  const sibs = kidsOf(map, map.parent(o)).filter((x) => x !== o);
  if (!sibs.length) return null;
  const so = map.st(o);
  const score = (x: number): number => {
    const sx = map.st(x);
    return Math.abs(sx.cl * sx.fee - so.cl * so.fee) + Math.abs(sx.pu - so.pu) * 0.1 + Math.abs(sx.sal - so.sal) * 30 + (sx.pm !== so.pm ? 5 : 0) + (sx.j !== so.j ? 10 : 0);
  };
  // 並べ替えは安定なので、同点なら並びの先の兄弟
  return sibs.slice().sort((x, y) => score(y) - score(x))[0]!;
}

/** 別の結果と届け出の答えが違うとき、この結果の答えの範囲を言う一言の鍵（答えごとに道で 1 回だけ） */
function permKey(c: Ctx, o: number): string | null {
  const sib = contrastSib(c, o);
  if (sib === null) return null;
  const so = c.map.st(o);
  const ss = c.map.st(sib);
  return so.pm !== ss.pm && so.pm !== "?" && ss.pm !== "?" ? `perm.${so.pm}` : null;
}

/** 別の結果との月の稼ぎの違い（数の行の項目ごと）。売上と給与の差は今の年収で（truth-15） */
interface MonthDiff {
  what: "ads" | "adsBand" | "pu" | "sal";
  /** 差の大きさ（売上 万円/月・有料会員の人数・年収 万円）。adsBand は向きだけ */
  x: number;
  more: boolean;
}

/**
 * 結果 o と別の結果 sib の月の稼ぎの違い。顧客の数が幅（社数の違う場合をまとめた結果）なら、平均の売上の差は言わず、
 * 社数の幅が重ならないときだけ社数で比べる（reader-9）
 */
function monthDiffs(c: Ctx, o: number, sib: number): MonthDiff[] {
  const { map } = c;
  const so = map.st(o);
  const ss = map.st(sib);
  const d: MonthDiff[] = [];
  const [ol, oh] = clBand(map, o);
  const [sl, sh] = clBand(map, sib);
  const banded = (ol !== oh && !!map.band(o)?.cl) || (sl !== sh && !!map.band(sib)?.cl);
  if (!banded) {
    const dAds = so.cl * so.fee - ss.cl * ss.fee;
    if (Math.abs(dAds) >= 0.5) d.push({ what: "ads", x: Math.abs(dAds), more: dAds > 0 });
  } else if (ol > sh || oh < sl) d.push({ what: "adsBand", x: 0, more: ol > sh });
  const dPu = Math.round(so.pu) - Math.round(ss.pu);
  if (Math.abs(dPu) >= 1) d.push({ what: "pu", x: Math.abs(dPu), more: dPu > 0 });
  const dSal = c.annual * (map.rr(o)[0] - map.rr(sib)[0]);
  if (Math.abs(dSal) >= 6) d.push({ what: "sal", x: Math.abs(dSal), more: dSal > 0 });
  return d;
}

/** 月の稼ぎの違いの言い方（「年収が 65 万円低い」） */
function diffText(x: MonthDiff): string {
  switch (x.what) {
    case "ads":
      return `広告運用の売上が月 ${slot(man(x.x))} 万円${x.more ? "多い" : "少ない"}`;
    case "adsBand":
      return `広告運用の顧客が${x.more ? "多い" : "少ない"}`;
    case "pu":
      return `有料会員が ${slot(x.x)} 人${x.more ? "多い" : "少ない"}`;
    default:
      return `年収が ${slot(n0(x.x))} 万円${x.more ? "高い" : "低い"}`;
  }
}

/** 3 年の見込みの差に添える、月の稼ぎの一番の違い（「（年収で 65 万円の差）」） */
function diffNote(x: MonthDiff | undefined): string {
  if (!x) return "";
  switch (x.what) {
    case "ads":
      return `（広告運用の売上で月 ${slot(man(x.x))} 万円の差）`;
    case "adsBand":
      return "（広告運用の顧客の数も違う）";
    case "pu":
      return `（有料会員で ${slot(x.x)} 人の差）`;
    default:
      return `（年収で ${slot(n0(x.x))} 万円の差）`;
  }
}

/** 届け出の答えの範囲の一言（答えが別の結果と違うとき。段取りで決めた、道で 1 回だけの文） */
function permLine(c: Ctx, o: number, permOk: boolean): string {
  const sib = contrastSib(c, o);
  if (!permOk || sib === null) return "";
  const so = c.map.st(o);
  const ss = c.map.st(sib);
  if (so.pm === ss.pm || so.pm === "?" || ss.pm === "?") return "";
  return so.pm === "a" ? "この場合は広告運用の副業もできる。" : so.pm === "s" ? "この場合は Pro は出せるが、広告運用はできない。" : "この場合は Pro も副業も出せない。";
}

/**
 * 同じ手の別の結果（一番違う物）との月の稼ぎの違い（3 年の見込みが出せないとき。計算の芯も手の見積もりも無い地図）。
 * 言い方は道の上の位置と兄弟の並びで 7 通りを回す（兄弟が同じ言い方にならない。rep-4・L2）
 */
function contrastSentence(c: Ctx, o: number, k: number): string {
  const sib = contrastSib(c, o);
  if (sib === null) return "";
  const d = monthDiffs(c, o, sib).map(diffText);
  const lab = labelOf(c, sib);
  if (!d.length) return [`同じ手で『${lab}』だった場合と、数字はほとんど変わらない。`, `『${lab}』だった場合とも、数字はほぼ同じ。`, `別の結果の『${lab}』とも、数字はほとんど変わらない。`, `『${lab}』の場合とも、数字に大きな違いは無い。`, `数字は、同じ手で『${lab}』だった場合とほとんど同じ。`, `この結果と『${lab}』の場合で、数字はほとんど変わらない。`, `『${lab}』と比べても、この結果の数字はほぼ同じ。`][k % 7]!;
  // 2 つの差は「〜多く、〜高い」とつなぐ（reader-10）
  const ds = d.length >= 2 ? `${renyo(d[0]!)}、${d[1]!}` : d[0]!;
  return [`同じ手で『${lab}』だった場合より、${ds}。`, `『${lab}』だった場合と比べると、${ds}。`, `別の結果の『${lab}』と比べて、${ds}。`, `『${lab}』の場合に比べ、${ds}。`, `${ds}（同じ手で『${lab}』だった場合と比べて）。`, `『${lab}』と比べると、この結果は${ds}。`, `この結果は、『${lab}』の場合より${ds}。`][k % 7]!;
}

/** まとめた行き先が、名前の付いた結果（兄弟がある）の後か */
const sumNamed = (c: Ctx, n: number): boolean => c.map.outId(n) !== "all" && c.map.childCount(c.map.parent(n)) >= 2;

/**
 * まとめた行き先の、この手から 3 年後までの稼ぎの合計と、兄弟との差。兄弟は合計の順に並べて隣の物と比べる
 * （一番多い物は 2 番目より多い・一番少ない物は 1 つ上より少ない・間の物は上と下の間）。結果の名前が数だけ違う兄弟でも、
 * 骨組みが同じ文にならない（点検 C6）。今の年収で決まる
 */
function sumSoFar(c: Ctx, n: number): string {
  const { map } = c;
  const t = sumTotal(c, n);
  const head = `この手の 3 か月から 3 年後までの稼ぎは、合わせて ${amount(t)} 万円ほど`;
  if (!sumNamed(c, n)) return `${head}。`;
  const sibs = kidsOf(map, map.parent(n))
    .map((x) => [x, sumTotal(c, x)] as const)
    .sort((a, b) => b[1] - a[1]);
  const k = sibs.findIndex(([x]) => x === n);
  const up = sibs[k - 1];
  const down = sibs[k + 1];
  const diff = (o: readonly [number, number]): string => `『${labelOf(c, o[0])}』だった場合より ${amount(Math.abs(t - o[1]))} 万円`;
  if (up && down && up[1] - t >= 1 && t - down[1] >= 1) return `${head}で、同じ手で${diff(up)}少なく、${diff(down)}多い。`;
  const other = up ?? down;
  if (!other) return `${head}。`;
  const d = t - other[1];
  if (Math.abs(d) < 1) return `${head}で、同じ手で『${labelOf(c, other[0])}』だった場合とほとんど変わらない。`;
  return `${head}で、同じ手で${diff(other)}${d > 0 ? "多い" : "少ない"}。`;
}

/** 行き先の、同じ手の別の結果（月の稼ぎが一番違う物）との月の稼ぎの差（兄弟の行き先を言い分ける。今の年収で決まる） */
function endContrast(c: Ctx, n: number): string {
  const { map } = c;
  if (map.childCount(map.parent(n)) < 2) return "";
  const total = (x: number): number => {
    const rr = map.rr(x);
    return salMan(c, rr[0]) + rr[1] + rr[2];
  };
  // 兄弟は月の稼ぎの順に並べて隣の物と比べる（一番多い物は 2 番目より多い・一番少ない物は 1 つ上より少ない・間の物は上と下の間）。
  // 名前が数だけ違う兄弟（「顧客 3〜4 社」「顧客 5〜6 社」）でも、骨組みが同じ文にならない（点検 C6）
  const sibs = kidsOf(map, map.parent(n))
    .map((x) => [x, total(x)] as const)
    .sort((a, b) => b[1] - a[1]);
  const k = sibs.findIndex(([x]) => x === n);
  const t = total(n);
  const up = sibs[k - 1];
  const down = sibs[k + 1];
  const diff = (o: readonly [number, number]): string => `『${labelOf(c, o[0])}』だった場合より ${slot(man(Math.abs(t - o[1])))} 万円`;
  if (up && down && up[1] - t >= 0.05 && t - down[1] >= 0.05) return `この時の月の稼ぎは、同じ手で${diff(up)}少なく、${diff(down)}多い。`;
  const sib = (up ?? down)!;
  const dt = t - sib[1];
  if (Math.abs(dt) < 0.05) return `同じ手で『${labelOf(c, sib[0])}』だった場合と、この時の月の稼ぎはほとんど変わらない。`;
  return `同じ手で『${labelOf(c, sib[0])}』だった場合より、この時の月の稼ぎが ${slot(man(Math.abs(dt)))} 万円${dt > 0 ? "多い" : "少ない"}。`;
}

// ---- 状態の数の文（0.8・W2: con-1 の S1〜S5・con-7・rep-3・rep-4・rep-8・rep-14・L1〜L5）
// 数の行の数（年収・売上・有料・遊ぶ人・週の時間）は書かず、差・合計・見込みだけを書く（L5・点検 C10）。
// 数の枠（その 3 か月の見込みと月の稼ぎの動き・3 年の見込み・別の結果との差・次の手の並びの違い・分かれ道・次の手・今日の手の効き目）は
// 構造の文（scripts/impact/textChecks.ts の STRUCTURAL）。言い方は道の上の位置（その状態より上にある状態の数）で 3 つ以上を回し、
// 結果の兄弟どうしはさらに兄弟の並びでずらす（L2・rep-4）

/** 道の上の位置: 3 か月目の状態が 0（その状態より上にある状態の数。言い方を回す数。L2: ハッシュでなく位置で） */
const posOf = (c: Ctx, n: number): number => Math.max(0, Math.round(c.map.month(n) / 3) - 1);

/** 万円の数の本体（画面と同じ: 10 未満は小数 1 桁、それ以上は整数。符号は付けない） */
const manAbs = (x: number): string => {
  const a = Math.abs(x);
  return a < 9.95 ? man(a) : n0(a);
};
/** 符号つきの万円の数（負なら −。差し込みの印つき） */
const manSigned = (x: number): string => (x < 0 && Math.abs(x) >= 0.05 ? `${MINUS}${slot(manAbs(x))}` : slot(manAbs(x)));

/** カード i の月の稼ぎ（万円/月。給与は今の年収の月割り。手はその判断の値） */
const monthlyOf = (c: Ctx, i: number): number => {
  const rr = rrOf(c, i);
  return salMan(c, rr[0]) + rr[1] + rr[2];
};

/**
 * 判断 d から 36 か月目までの稼ぎ（その判断から、おすすめの手で進んだ場合）: 計算の芯があれば一番良い選び方の値（画面の「ここから一番良い選び方で
 * 進んだ 3 年の合計の見込み」と同じ）、無ければ地図のおすすめの手の見積もり（その 3 か月は正確に・その後は標準の選び方。q）。出せなければ null
 */
function aheadOf(c: Ctx, d: number): number | null {
  const { map } = c;
  // 行き先（判断の無いカード）: その月の月の稼ぎ × 3 年の終わりまでの月（計算の芯の行き先の値と同じ。36 か月目は 0）
  if (!map.childCount(d)) return wOf(c.annual, map.rr(d)) * Math.max(0, c.cal.horizon - map.month(d));
  const pi = c.rt?.recommended?.(d) ?? -1;
  if (pi >= 0) {
    const v = c.rt?.treeValue?.(pi) ?? null;
    if (v !== null && Number.isFinite(v)) return v;
  }
  return optionValue(c.map, recommended(c.map, d), c.annual);
}

/**
 * 手 a を選んだ時の、その判断から 36 か月目までの見込み（計算の芯があれば、その手の後を一番良い選び方で進んだ値。手の詳しい画面と今日の手の
 * 「平均」と同じ数。無ければ地図の見積もり q。手のカードの「合わせて」と同じ数）。出せなければ null
 */
function moveValue(c: Ctx, a: number): number | null {
  const v = c.rt?.treeValue?.(a) ?? null;
  if (v !== null && Number.isFinite(v)) return v;
  return optionValue(c.map, a, c.annual);
}

/** 画面と本文に出す万円の数（10 以上は整数、それより下は小数 1 桁。manAbs と同じ丸め）。差は見せる数どうしで出す（R4: 足し引きが合う） */
const shownMan = (x: number): number => (Math.abs(x) >= 9.95 ? Math.round(x) : Math.round(x * 10) / 10);

/**
 * 状態の 3 年の見込み（今日から）: ここまで・この先・合わせて・1 つ前の判断の時点の合わせて（1 つ前の状態の「合わせて」）・
 * 比べる元（1 つ前の判断でこの道の手を選んだ時の見込み。R1・con-7: 結果がこの先をどう動かしたかを、選んだ手の見込みから測る。
 * 結果の見込みの重みで足すと 0 になる）・ずっと今のまま
 */
interface StateVals {
  acc: number;
  ahead: number;
  total: number;
  prev: number | null;
  base: number | null;
  keep: number | null;
}

function stateVals(c: Ctx, n: number, link: Link): StateVals | null {
  const ahead = aheadOf(c, n);
  if (ahead === null || !link.up) return null;
  const acc = accOf(c, link);
  const upAcc = accOf(c, link.up);
  const upAhead = aheadOf(c, link.up.i);
  const mv = moveValue(c, link.move);
  return { acc, ahead, total: acc + ahead, prev: upAhead === null ? null : upAcc + upAhead, base: mv === null ? null : upAcc + mv, keep: keepTotalOf(c) };
}

/** 同じ手の別の結果（状態）の 3 年の見込み（今日から: 1 つ前の判断までの稼ぎ + その結果の 3 か月 + その先）。出せなければ null */
function sibTotal(c: Ctx, up: Link, o: number): number | null {
  const a = aheadOf(c, o);
  return a === null ? null : accOf(c, up) + wOf(c.annual, c.map.e(o)) + a;
}

/** 万円の差の言い方（「28 万円上がった」「ほぼ同じ」。D は今 − 前） */
const moveWord = (d: number, up: string, down: string, same: string): string => (Math.abs(d) < 0.05 ? same : `より ${slot(manAbs(d))} 万円${d > 0 ? up : down}`);

/** 給与・勤め先が変わる出来事と据え置き（その 3 か月の給与の動きは、出来事の文が訳を言う） */
const SAL_EVENTS = /^(SWITCH_|PROMO|PART_ON|PART_MIX|BACK_EMP|BACK_MIX|IND_START)/;

/**
 * S1: この結果になる見込み（結果が 2 つ以上の手）と、この 3 か月の月の稼ぎの動き（差と、主に動いた物）。数の行の数は書かない（L5）。
 * 言い方は位置で 3 つを回す
 */
function quarterSentence(c: Ctx, n: number, link: Link, p: number, moneySaid: boolean, trace: string[]): string {
  const { map } = c;
  const d = monthlyOf(c, n) - monthlyOf(c, link.up!.i);
  const odds = map.childCount(map.parent(n)) >= 2 && map.p(n) > 0 && map.p(n) < 100 ? wari(map.p(n) / 100) : null;
  // 出来事の後の一言がこの 3 か月の稼ぎの動きを言うなら（有料会員の線）、見込みだけ
  if (moneySaid) {
    if (!odds) return "";
    trace.push("state:quarter");
    return [`この結果になる見込みは ${odds}だった。`, `${odds}の見込みで起きた結果。`, `見込み ${odds}の結果。`][p % 3]!;
  }
  // 0.3 万円より小さい動きは「ほぼ同じ」（Pro の数百円の動きを月の稼ぎの動きとして言わない）。見込みも無ければ書かない
  const flat = Math.abs(d) < 0.3;
  if (flat && !odds && !moneySaid) return "";
  const amt = `${slot(man(Math.abs(d)))} 万円`;
  const lever = flat || link.evs.some((e) => SAL_EVENTS.test(e.code)) ? null : leverName(c, link, d);
  const src = lever ? `（主に${lever}）` : "";
  trace.push("state:quarter");
  switch (p % 3) {
    case 0:
      return `${odds ? `見込み ${odds}の結果で、` : ""}月の稼ぎは 3 か月前${flat ? "とほぼ同じ" : `より ${amt}${d > 0 ? "増えた" : "減った"}${src}`}。`;
    case 1:
      if (!odds) return flat ? "この 3 か月で月の稼ぎはほぼ動いていない。" : `この 3 か月で月の稼ぎは ${amt}${d > 0 ? "増えた" : "減った"}${src}。`;
      return `この 3 か月で月の稼ぎは${flat ? "ほぼ動かず" : ` ${amt}${d > 0 ? "増え" : "減り"}${src}`}、この結果になる見込みは ${odds}だった。`;
    default:
      return `${odds ? `${odds}の見込みで起きた結果で、` : ""}${flat ? "月の稼ぎは 3 か月前と変わらない" : `3 か月前と比べた月の稼ぎは ${sgn(d)}${amt}${src}`}。`;
  }
}

/** 最初の状態の見積もり方の注（手のカードの数は標準の選び方で続けた見積もり。R5・F8）。長さの目安を超えるときは最後に落とす */
const BASIS_NOTE = "（手のカードの数と手の差は、その後を標準の選び方で続けた見積もり）";

/**
 * S2（L1・con-7）: 今日からの 3 年の見込み（ここまで + この先）と、1 つ前の判断でこの道の手を選んだ時の見込みからの動き。言い方は位置で
 * 3 つを回し、3 つ目はずっと今のままと比べる（L4）。最初の状態（道で 1 回）だけ、この先の見積もり方（手のカードの数と手の差は標準の選び方で
 * 続けた見積もり。R5・F8）とずっと今のままの 3 年を言う（R10: 1 つの文につながない）。
 * 0.9（R1・F1・code-2）: 比べる元は 1 つ前の判断の一番良い手ではなく、この道の手を選んだ時の見込み（最初の状態は今日の手のカードの「平均」、
 * その先はおすすめの手を選んだ道なら 3 か月前の見込みと同じ数）。おすすめでない手を選んだ道では、その手の見込みの数を言い、おすすめとの差を
 * 括弧で添える（選んだ手の差を、結果の動きに混ぜない）。差は見せる数どうしで出す（R4）
 */
function totalSentence(c: Ctx, link: Link, p: number, v: StateVals, trace: string[]): string {
  const X = v.total;
  const A = v.acc;
  // ここまで + この先 = 合わせて（見せる数で足し算が合うように、この先は見せる 2 つの数の差。どちらも整数で見せるとき）
  const B = Math.abs(X) >= 9.95 && Math.abs(A) >= 9.95 ? Math.round(X) - Math.round(A) : X - A;
  const tot = `${manSigned(X)} 万円`;
  const here = `${manSigned(A)} 万円`;
  const ahead = `${manSigned(B)} 万円`;
  const name = `『${firstName(c, link.move)}』`;
  // おすすめの手を選んだ道（3 か月前の見込みと、選んだ手の見込みが見せる数で同じ）
  const onRec = p > 0 && v.prev !== null && v.base !== null && shownMan(v.prev) === shownMan(v.base);
  const ref = onRec ? v.prev : v.base;
  const D = ref === null ? null : shownMan(X) - shownMan(ref);
  const word = (d: number): string => moveWord(d, "上がった", "下がった", "とほぼ同じ");
  trace.push("state:total");
  if (p === 0) {
    const how = c.rt?.recommended ? `毎回おすすめの手を選んだ場合の見込み${BASIS_NOTE}` : "おすすめの手の後を標準の選び方で続けた場合の見込み";
    const keep = v.keep === null ? "" : `何も変えずに 3 年続ける（ずっと今のまま）と ${manSigned(v.keep)} 万円。`;
    return `今日からの 3 年の見込みは ${tot}（ここまで ${here}＋この先 ${ahead}）${D === null ? "" : `で、今日${name}を選んだ時の見込み ${manSigned(ref!)} 万円${word(D)}`}。この先は、${how}。${keep}`;
  }
  // 比べる元の言い方: おすすめの手を選んだ道は 3 か月前の見込み、ほかはその手を選んだ時の見込みの数と、おすすめを選んだ場合との差
  const choice = !onRec && v.prev !== null && v.base !== null ? shownMan(v.prev) - shownMan(v.base) : null;
  const since = D === null ? null : onRec ? (lead: string): string => `${lead}3 か月前の見込み${word(D)}` : (lead: string): string => `${lead}3 か月前に選んだ${name}の見込み ${manSigned(ref!)} 万円${word(D)}${choice !== null && choice >= 1 ? `（おすすめの手なら ${slot(manAbs(choice))} 万円多かった）` : ""}`;
  switch (p % 3) {
    case 0:
      return `今日からの 3 年の見込みは ${tot}（ここまで ${here}＋この先 ${ahead}）${since ? since("で、") : ""}。`;
    case 1:
      return since ? `3 年の見込みは、ここまでの ${here}とこの先の ${ahead}で ${tot}になり、${since("")}。` : `3 年の見込みは、ここまでの ${here}とこの先の ${ahead}で ${tot}。`;
    default: {
      const H = v.keep === null ? null : shownMan(X) - shownMan(v.keep);
      const head = `ここまでの ${here}にこの先の ${ahead}を足した 3 年の見込みは ${tot}${since ? since("で、") : ""}。`;
      return H === null ? head : `${head}ずっと今のままの 3 年${moveWord(H, "多い", "少ない", "とほぼ同じ")}。`;
    }
  }
}

/** 次の手の種類の並び（今のままは除く） */
function nextKinds(c: Ctx, i: number): string[] {
  const out: string[] = [];
  for (const x of kidsOf(c.map, i)) {
    const k = c.map.kind(x) ?? "";
    if (k !== "keep" && !out.includes(k)) out.push(k);
  }
  return out;
}

/**
 * S3（rep-4）: 同じ手の別の結果と 3 年の見込みで比べる。比べる相手は 3 年の見込みで並べた隣（上と下。兄弟で同じ相手にしない）。
 * 言い方は位置と兄弟の並びで 7 通りを回す（兄弟で同じ枠にしない）。月の稼ぎの一番の違いは、その出来事が道で初めてのときだけ添える
 * （同じ差を期ごとに繰り返さない。続く同じ結果は出来事の後の一言が、何回目かと残る機会を言う）。3 年の見込みが出せなければ月の稼ぎで比べる
 */
function contrastMain(c: Ctx, n: number, link: Link, p: number, firstTime: boolean, trace: string[]): string {
  const { map } = c;
  const sibs = kidsOf(map, map.parent(n));
  if (sibs.length < 2) return "";
  const rank = sibs.indexOf(n);
  // 位置は 3 つ飛びで回す（兄弟は並びで 1 つずつずれ、道の上で同じ言い方が重なりにくい。L2・rep-4）
  const k = (3 * p + rank) % 7;
  const up = link.up!;
  const tots = sibs.map((x) => [x, sibTotal(c, up, x)] as const);
  trace.push("state:contrast");
  if (tots.some(([, t]) => t === null)) return contrastSentence(c, n, k);
  // 差は見せる数（兄弟のカードの 3 年の見込み）どうしで出す（R4）
  const order = tots.map(([x, t]) => [x, shownMan(t!)] as const).sort((a, b) => b[1] - a[1] || sibs.indexOf(a[0]) - sibs.indexOf(b[0]));
  const at = order.findIndex(([x]) => x === n);
  const t = order[at]![1];
  const hi = order[at - 1];
  const lo = order[at + 1];
  if (hi && lo && hi[1] - t >= 0.05 && t - lo[1] >= 0.05) {
    const a = `『${labelOf(c, hi[0])}』`;
    const b = `『${labelOf(c, lo[0])}』`;
    const d1 = `${slot(manAbs(hi[1] - t))} 万円`;
    const d2 = `${slot(manAbs(t - lo[1]))} 万円`;
    return [`3 年の見込みは、${a}の場合より ${d1}少なく、${b}の場合より ${d2}多い。`, `この結果の 3 年の見込みは、${a}だった場合に ${d1}届かず、${b}だった場合を ${d2}上回る。`, `同じ手の結果と比べると、3 年の見込みは${a}の場合の ${d1}下で、${b}の場合の ${d2}上。`][k % 3]!;
  }
  const ref = (hi ?? lo)!;
  const lab = `『${labelOf(c, ref[0])}』`;
  const d = t - ref[1];
  // 月の稼ぎの一番の違い（その出来事が道で初めてのときだけ）。0.9（R8）: 3 年の見込みの差と逆の向きなら添えない（有料会員が多い結果の方が
  //   3 年の見込みが少ないなど）。この結果が届け出の答えを持つ会社員で、比べる結果の答えがまだか不可なら、その訳（この地図の前提）を言う
  const nd = firstTime ? monthDiffs(c, n, ref[0])[0] : undefined;
  let note = "";
  if (nd && (Math.abs(d) < 0.05 || nd.more === d > 0)) note = diffNote(nd);
  else if (nd) {
    const so = map.st(n);
    const ss = map.st(ref[0]);
    if (so.j === "e" && (so.pm === "s" || so.pm === "a") && (ss.pm === "n" || ss.pm === "?")) {
      const why = choose(c.B.cmpWhy, { pm: so.pm }, so.fl, {}, 0, trace, "cmpWhy");
      if (why) note = `（${why}）`;
    }
  }
  if (Math.abs(d) < 0.05) return [`同じ手で${lab}だった場合と、3 年の見込みはほとんど変わらない${note}。`, `3 年の見込みは、${lab}の場合とほぼ同じ${note}。`, `${lab}と比べても、この結果の 3 年の見込みはほぼ同じ${note}。`][k % 3]!;
  const amt = `${slot(manAbs(d))} 万円`;
  const more = d > 0;
  return [
    `同じ手で${lab}だった場合より、3 年の見込みが ${amt}${more ? "多い" : "少ない"}${note}。`,
    `3 年の見込みを${lab}の場合と比べると、${amt}${more ? "多い" : "少ない"}${note}。`,
    `${lab}だった道と比べて、3 年の見込みは ${amt}${more ? "多い" : "少ない"}${note}。`,
    `この結果の 3 年の見込みは、${lab}の場合より ${amt}${more ? "多い" : "少ない"}${note}。`,
    `${lab}の場合なら、3 年の見込みは ${amt}${more ? "少なかった" : "多かった"}${note}。`,
    // 0.9（R10）: 「…と比べた 3 年の見込みは −56 万円」は 3 年の見込みが負の数に読めるので、多い・少ないで言う
    `${lab}の場合と比べると、この結果の 3 年の見込みは ${amt}${more ? "多い" : "少ない"}${note}。`,
    `3 年の見込みで見ると、この結果は${lab}の場合より ${amt}${more ? "多い" : "少ない"}${note}。`,
  ][k]!;
}

/** 数える印の数（g1・q2・r1 など。生成の q/quarter.ts の uses と同じ） */
function usesOf(fl: readonly string[], p: string): number {
  const f = fl.find((x) => x.length === 2 && x[0] === p && /[1-9]/.test(x[1]!));
  return f ? Number(f[1]) : 0;
}

/**
 * 0.9（R2）: 状態 s（m か月目の判断）で、その種類の手が決まりの上で選べるか。生成の q/quarter.ts の feasibleQ（と sim.ts の feasible）と
 * 同じ決まり（tests/unit/compose.test.ts で突き合わせる）。決まりが状態だけで言い切れない手（学校の席の上限・有料会員の数）は、選べないと
 * 言い切れる時だけ false、ほかは null（並びの違いの訳にしない）
 */
export function allowedKind(c: Ctx, s: ImpactSt, kind: string, m: number): boolean | null {
  const { C, cal } = c;
  const cl = Math.round(s.cl);
  const cap = capOf(C, s.j);
  const has = (f: string): boolean => s.fl.includes(f);
  const emp = s.j === "e" || s.j === "p";
  switch (kind) {
    case "keep":
      return true;
    case "sd_permpro":
      return s.pm === "?" && emp && s.pro === 0;
    case "ad_perm":
    case "ad_permside":
      return s.pm === "?" && emp;
    case "ad_side":
      return emp && s.pm === "a" && cl < cap;
    case "ad_more":
      return cl >= 1 && (s.pm === "a" || s.j === "i") && cl < cap;
    case "ad_portfolio":
      return emp && !has("portfolio") && s.pm !== "n";
    case "ind_quit":
      return emp;
    case "back_emp":
      return s.j === "i";
    case "part":
      return s.j === "e" && !has("pq");
    case "fc_switch":
      return s.j === "e" && !has("switched") && !has("js") && !has("jx");
    case "fc_switch2":
      return s.j === "e" && !has("switched") && (has("js") || has("jx")) && usesOf(s.fl, "q") < C.searchMax && usesOf(s.fl, "r") < C.searchRun;
    case "fc_scope":
      return s.j === "e" && !has("scope");
    case "fc_push":
      return emp && cal.aprils.some((q) => q > m && q <= m + 3);
    case "sd_grow":
      return usesOf(s.fl, "g") < C.growMax;
    case "sd_ads":
      return s.pro === 1 && usesOf(s.fl, "a") < C.adsMax;
    case "sd_retain":
      return s.pro === 1 && !has("rt");
    case "sd_pilot":
      return !has("pilot");
    case "sd_school":
      return s.pro === 1 ? null : false;
    default:
      return null;
  }
}

/** 届け出の手の名詞の中身（届け出の手が 2 つ並ぶときは「届け出（1 社目探しと Pro）」とまとめる。R2） */
const FILING_PART: Readonly<Record<string, string>> = { ad_perm: "副業", ad_permside: "1 社目探し", sd_permpro: "Pro" };

/** 手の種類の名詞の並び（「と」でつなぐ。届け出の手は 1 つにまとめる） */
function nounList(c: Ctx, kinds: readonly string[]): string {
  const filing = kinds.filter((k) => FILING_PART[k]);
  const head = filing.length >= 2 ? [`届け出（${filing.map((k) => FILING_PART[k]).join("と")}）`] : filing.map((k) => kindNoun(c, k));
  return [...head, ...kinds.filter((k) => !FILING_PART[k]).map((k) => kindNoun(c, k))].join("と");
}

/**
 * S3 の続き（con-1・rep-3）: この結果で次の手の並びがどう変わったか。別の結果（3 年の見込みの順で近い物から）の後に並ぶ手と比べ、
 * この結果では並ばない手と、代わりに並ぶ手を言う。どの結果の後も同じ並びなら言わない。言い方は位置で 3 つを回す。
 * 0.9（R2）: 言うのは、状態の決まりで並びが変わった手だけ（この結果では決まりの上で選べない手・別の結果では選べない手。顧客の上限・
 * 届け出の答え・転職・転職活動の上限・週 4 日の相談・集客と続ける工夫の回数・独立）。地図が並べなかっただけの手（どちらの結果でも選べる）は
 * 「選べず」「消えて」と言わない
 */
function menuSentence(c: Ctx, n: number, p: number, trace: string[]): string {
  const { map } = c;
  const sibs = kidsOf(map, map.parent(n)).filter((x) => x !== n && map.role(x) === "s");
  if (!sibs.length) return "";
  const mine = nextKinds(c, n);
  const m = map.month(n);
  const sn = map.st(n);
  for (const x of sibs) {
    const theirs = nextKinds(c, x);
    const sx = map.st(x);
    const closed = theirs.filter((k) => !mine.includes(k) && allowedKind(c, sn, k, m) === false);
    const opened = mine.filter((k) => !theirs.includes(k) && allowedKind(c, sx, k, m) === false);
    if (!closed.length && !opened.length) continue;
    const lab = `『${labelOf(c, x)}』`;
    const cl = nounList(c, closed);
    const op = nounList(c, opened);
    trace.push(`state:menu:${closed.join("+")}/${opened.join("+")}`);
    trace.push("state:menu");
    if (closed.length && opened.length) return [`${lab}の場合に次に並んだ${cl}は、この結果では選べず、代わりに${op}が並ぶ。`, `この結果では${op}が選べる代わりに、${lab}の場合にある${cl}は並ばない。`, `次の手の並びも${lab}の場合とは違い、${cl}が消えて${op}が入る。`][p % 3]!;
    if (closed.length) return [`${lab}の場合に次に並んだ${cl}は、この結果では選べない。`, `この結果の次の手には、${lab}の場合にある${cl}が無い。`, `次の手の並びは${lab}の場合より少なく、${cl}が無い。`][p % 3]!;
    return [`${lab}の場合には無い${op}が、この結果では選べる。`, `この結果の次の手には、${lab}の場合に無い${op}が加わる。`, `次の手の並びは${lab}の場合より多く、${op}も選べる。`][p % 3]!;
  }
  return "";
}

/**
 * S4（con-1・user-1）: 今日の手の先の分かれ道のうち、ここから 3 年後までに残る数（判断と出来事の分かれ）と、同じ手の別の結果の後の数との比べ。
 * 今日の手の名前と、その手の先の分かれ道の数を言う（一つの手がこの先の約 2,000 の分かれ道を決めていることを、どの状態でも見せる。user-1）。
 * 言い方は位置で 3 つを回す（数は地図ごとに 1 回だけ下から数えた物。L7）
 */
function forkSentence(c: Ctx, n: number, link: Link, p: number, trace: string[], bare = false, named = false, min = false): string {
  const { map, cal } = c;
  const r = ripple(map, n);
  const hz = cal.ym(cal.horizon);
  const sibs = kidsOf(map, map.parent(n)).filter((x) => x !== n);
  const f = slot(n0(r.forks));
  const split = `判断 ${slot(n0(r.decisions))}・出来事の分かれ ${slot(n0(r.splits))}`;
  if (!r.forks) return "";
  const first = link.first >= 0 ? link.first : -1;
  const all = first >= 0 ? slot(n0(ripple(map, first).forks)) : "";
  // 今日の手の名前は、同じ本文の今日の手の効き目の文が言っていれば「今日の手」とだけ言う
  const name = first < 0 ? "" : named ? "の手" : `の『${firstName(c, first)}』`;
  let cmp = "";
  let tail = "";
  // 別の結果の後の数がどれもこの結果と同じなら比べない
  const same = sibs.every((x) => ripple(map, x).forks === r.forks);
  if (bare || same) {
    // 比べない（長さの目安を超えるときの短い形）
  } else if (sibs.length === 1) {
    const sf = ripple(map, sibs[0]!).forks;
    const lab = `『${labelOf(c, sibs[0]!)}』`;
    cmp = `で、${lab}の場合の ${slot(n0(sf))}${r.forks === sf ? "と同じ" : r.forks > sf ? "より多い" : "より少ない"}`;
    tail = `（${lab}の場合は ${slot(n0(sf))}）`;
  } else if (sibs.length >= 2) {
    const list = sibs.map((x) => slot(n0(ripple(map, x).forks))).join("・");
    cmp = `で、ほかの結果の後は ${list}`;
    tail = `（ほかの結果の後は ${list}）`;
  }
  trace.push("state:forks");
  if (first < 0) return `ここから ${hz}までの分かれ道は ${f}（${split}）${cmp}。`;
  // 今日の手の先の分かれ道がどれもここから続く（結果が 1 つの今日の手の 3 か月目）
  if (r.forks === ripple(map, first).forks) return [`今日${name}の先の分かれ道 ${f}（${split}）は、どれもこの結果から続く。`, `今日${name}から数えた分かれ道 ${f}（${split}）が、そのままこの先に残る。`, `この先に続く分かれ道は、今日${name}の後の ${f}（${split}）の全部。`][p % 3]!;
  // 0.9（R11）: ここから選べるほかの手の先がどれも開いていない（今のままの手だけを広げた地図）なら、残る数が少ないのは地図がほかの手を
  //   見積もりでまとめたためだと言う（先の道が無くなったように読ませない）
  //   道で続く同じ状況（今のままの手が続く道）では、その始まりの状態で 1 回だけ言う
  const closed = (i: number): boolean => {
    const ks = kidsOf(map, i).filter((x) => map.kind(x) !== "keep");
    return ks.length > 0 && ks.every((x) => map.stub(x));
  };
  const closedOff = closed(n) && !(link.up && closed(link.up.i)) ? ["ここで選べるほかの手の先は、この地図では開かずに見積もりでまとめてある。", "今のまま以外の手の先は、この地図では開かずに見積もりにしてある。", "ほかの手を選んだ先は開いておらず、この地図では見積もりで数えている。"][p % 3]! : "";
  // 長さの目安を超えるときと、残る分かれ道が 2 つ以下のとき（3 年の終わり近く。内訳と別の結果との比べは中身が薄い。R11）の短い形
  if (min || r.forks <= 2) return [`今日${name}の先の ${all} の分かれ道のうち、ここから残るのは ${f}。`, `今日${name}から数えて ${all} ある分かれ道は、この結果の先に ${f} が残る。`, `この先に続く分かれ道は、今日${name}の後の ${all} のうち ${f}。`][p % 3]! + (min ? "" : closedOff);
  return [`今日${name}の先の ${all} の分かれ道のうち、ここから残るのは ${f}（${split}）${cmp}。`, `今日${name}から数えて ${all} ある分かれ道は、この結果の先に ${f}（${split}）が残る${tail}。`, `この先に続く分かれ道は、今日${name}の後の ${all} のうち ${f}（${split}）${cmp}。`][p % 3]! + closedOff;
}

/** 手 a の「うまくいく」結果の見込みの言い方（結果が 2 つ以上の手。割で）。無ければ null */
function oddsPhrase(c: Ctx, a: number, d: number): string | null {
  const { map } = c;
  const ks = kidsOf(map, a);
  if (ks.length < 2) return null;
  const kind = map.kind(a) ?? "";
  const share = (ok: (o: number) => boolean): number => ks.filter(ok).reduce((s, o) => s + map.p(o), 0) / 100;
  const id = (o: number): string => map.outId(o);
  const say = (what: string, q: number): string | null => (q > 0.005 && q < 0.995 ? `${what} ${wari(q)}` : null);
  switch (kind) {
    case "fc_push":
      return say("昇格の見込み", share((o) => id(o) === "up"));
    case "fc_switch":
    case "fc_switch2":
      return say("移れる見込み", share((o) => /^(high|mid|high_mid)$/.test(id(o))));
    case "ad_permside":
    case "ad_perm":
      return say("全部可の見込み", share((o) => /^(a|a0|a1|a0_a1)$/.test(id(o))));
    case "sd_permpro":
      return say("Pro が認められる見込み", share((o) => /^(a|s)$/.test(id(o))));
    case "part":
      return say("週 4 日が認められる見込み", share((o) => id(o) === "p"));
    case "back_emp":
      return say("3 か月で戻れる見込み", share((o) => id(o) === "e"));
    case "sd_school":
      return say("導入が決まる見込み", share((o) => id(o) === "yes"));
    case "sd_pilot":
      return say("試用が決まる見込み", share((o) => id(o) === "yes"));
    case "ad_portfolio":
      return say("事例ができる見込み", share((o) => id(o) === "yes"));
    default:
  }
  const metric = map.ln(ks[0]!)?.[0] ?? "";
  if (metric === "cl") {
    if (kind === "ind_quit") return say("顧客がつく見込み", share((o) => clBand(map, o)[0] >= 1));
    const top = clBand(map, d)[1];
    return say("顧客が増える見込み", share((o) => clBand(map, o)[0] > top));
  }
  if (metric === "pu" || metric === "mau") {
    const best = ks.slice().sort((x, y) => outcomeNum(c, y) - outcomeNum(c, x))[0]!;
    return say(`『${labelOf(c, best)}』の見込み`, map.p(best) / 100);
  }
  return null;
}

/** 数で分かれる結果の区切りの数（「pu30」の 30。無ければ 0） */
const outcomeNum = (c: Ctx, o: number): number => Number(/(\d+)$/.exec(c.map.outId(o))?.[1] ?? 0);

/** 結果が 1 つの手の、その 3 か月で動く物の見込み（差だけ。数の行の数は書かない。L5）。無ければ null */
function forecastPhrase(c: Ctx, a: number, d: number): string | null {
  const { map, C } = c;
  const ks = kidsOf(map, a);
  if (ks.length !== 1) return null;
  const o = ks[0]!;
  const kind = map.kind(a) ?? "";
  if (map.sum(o)) return "先は標準の選び方で続けた見積もり";
  const s0 = map.st(d);
  const s1 = map.st(o);
  if (mergedFact(map, o)) {
    const p = factShare(C, kind, s0.fl);
    if (p !== null && kind === "fc_push") return `昇格の見込み ${wari(p)}`;
    if (p !== null && kind === "sd_school") return `導入が決まる見込み ${wari(p)}`;
    return null;
  }
  if (kind === "fc_scope") return `次の 4 月の評価で昇格する見込みが ${wari(C.promoPScope)}に上がる`;
  if ((kind === "ad_side" || kind === "ad_more") && clBand(map, o)[1] > clBand(map, d)[1]) {
    const [bl, bh] = clBand(map, o);
    const share = bh - bl === 1 ? s1.cl - bl : -1;
    if (share > 0.05 && share < 0.95) return `顧客が増える見込み ${wari(share)}`;
  }
  const dPu = Math.round(s1.pu) - Math.round(s0.pu);
  if (s0.pro && s1.pro && (kind === "sd_retain" || kind === "sd_grow" || kind === "sd_ads") && dPu >= 1) return `有料会員が ${slot(n0(dPu))} 人ほど増える見込み`;
  const dMau = Math.round(s1.mau) - Math.round(s0.mau);
  if ((kind === "sd_grow" || kind === "sd_ads") && dMau >= 1) return `月に遊ぶ人が ${slot(n0(dMau))} 人ほど増える見込み`;
  return null;
}

/**
 * 次の手の名前（『』の中は道の画面の「選べる手」の並びと同じ名前。0.9（R9）: 短い名前（『継続を上げる』など）は画面に無いので『』に入れない。
 * 言い換えは名前の周りの言葉で回す。比べる元の今のままは「今のまま」）
 */
function optName(c: Ctx, x: number): string {
  return c.map.isBase(x) ? "今のまま" : listName(c, x);
}

/**
 * S5（con-1・rep-8）: 次の判断の手の数・おすすめの手（その見込みか、その 3 か月で動く物）と、ほかの手との差（どの手も同じ見積もり方: その 3 か月は
 * 正確に・その後は標準の選び方。手のカードの差と同じ数）。おすすめは計算の芯の一番良い選び方（画面のおすすめ）、無ければ地図のおすすめ。
 * 言い方は位置で 3 つを回す。選べる手が今のままだけなら、そう言う。
 * 0.9: おすすめより見積もりの多い手があるときは「3 年の稼ぎが一番多いのは」と言わない（R5）。3 つ目の言い方は「『X』がおすすめとほぼ同じで」
 * （「おすすめより…ほぼ同じ」と言わない。R10）。入社して 1 年に満たない会社の昇格狙いは、対象になるかの但し書きと見込みを言う（F7・fact-5）。
 * おすすめの手のカードの数（その後を標準の選び方で続けた見積もり）が、この先の見込み（一番良い選び方）より 10 万円以上低いときは、その訳を
 * 1 文で言う（F8: 隣のカードの 2 つの数をつなぐ）
 */
function nextParts(c: Ctx, n: number, p: number, trace: string[]): { head: string; basis: string; others: string } {
  const { map, cal } = c;
  const kids = kidsOf(map, n);
  trace.push("state:next");
  if (!kids.some((x) => map.kind(x) !== "keep")) return { head: "次の 3 か月に選べる手は今のままだけ（この地図では、ここから先の手を分けていない）。", basis: "", others: "" };
  const pi = c.rt?.recommended?.(n) ?? -1;
  const rec = pi >= 0 ? pi : recommended(map, n);
  const sure = pi >= 0 || c.annual === map.header.annual;
  let info = oddsPhrase(c, rec, n) ?? forecastPhrase(c, rec, n);
  // 入社して 1 年に満たない会社の 4 月の評価（手のカードの但し書きと同じ決まり。fact-5・fact-16）
  if (info && map.kind(rec) === "fc_push") {
    const join = joinedAt(c, linkOf(c, n));
    const joinM = join === null ? -1 : eventMonth(cal, "fc_push", map.month(n)) - join;
    if (join !== null && joinM < 12) info = `入社 ${slot(joinM)} か月で迎える評価で、対象なら${info}`;
  }
  const recName = `『${listName(c, rec)}』${info ? `（${info}）` : ""}`;
  const k = slot(kids.length);
  // ほかの手: おすすめとの差の小さい順（差が出せない手は名前だけ）
  const vr = optionValue(map, rec, c.annual);
  const rest = kids
    .filter((x) => x !== rec)
    .map((x) => {
      const v = optionValue(map, x, c.annual);
      return { x, g: v === null || vr === null ? null : v - vr };
    })
    .sort((a, b) => (b.g ?? -Infinity) - (a.g ?? -Infinity));
  // 並ぶ手は全部言う（選べる手が 5 つの判断でも落とさない。truth-6）
  const named = rest;
  const less = named.filter((r) => r.g !== null && r.g <= -1);
  const same = named.filter((r) => r.g !== null && Math.abs(r.g) < 1);
  const more = named.filter((r) => r.g !== null && r.g >= 1);
  const bare = named.filter((r) => r.g === null);
  const f = p % 3;
  // 3 つ目の書き出し「3 年の稼ぎが一番多いのは」は、見積もりでおすすめより多い手が無いときだけ（R5）
  const topHead = sure && f === 2 && more.length ? `ここで選べる手は ${k} つあり、おすすめは${recName}。` : null;
  const head =
    topHead ??
    (sure
      ? [`${cal.ym(map.month(n) + 3)}までの手は ${k} つで、おすすめは${recName}。`, `次の 3 か月に選べる ${k} つの手のうち、おすすめは${recName}。`, `ここで選べる手は ${k} つあり、3 年の稼ぎが一番多いのは${recName}。`][f]!
      : [`${cal.ym(map.month(n) + 3)}までの手は ${k} つで、地図を作った年収の見積もりで一番の手は${recName}。`, `次の 3 か月に選べる ${k} つの手のうち、地図を作った年収の見積もりで一番の手は${recName}。`, `ここで選べる手は ${k} つあり、地図を作った年収の見積もりで一番の手は${recName}。`][f]!);
  // F8: おすすめの手のカードの数と、この先の見込み（一番良い選び方）の差の訳（長さの目安を超えるときは、ほかの数の文の後に落とす）
  let basis = "";
  if (pi >= 0 && vr !== null) {
    const ahead = aheadOf(c, n);
    if (ahead !== null && shownMan(ahead) - shownMan(vr) >= 10) {
      trace.push("state:next:basis");
      basis = `『${listName(c, rec)}』のカードの ${amount(vr)} 万円は、その後を標準の選び方で続けた見積もりで、この先の見込みより ${slot(manAbs(shownMan(ahead) - shownMan(vr)))} 万円低い。`;
    }
  }
  const nm = (r: { x: number }): string => `『${optName(c, r.x)}』`;
  const items: string[] = [];
  // 差の大きい順ではなく、おすすめに近い順（多い・ほぼ同じ・少ない）
  for (const r of more) items.push(sure ? `${nm(r)}は見積もりでは ${amount(r.g!)} 万円多いが、その後の選び直しまで入れるとおすすめが上` : `${nm(r)}は ${amount(r.g!)} 万円多い`);
  for (const r of same) items.push(f === 1 ? `${nm(r)}がほぼ無し` : f === 2 ? `${nm(r)}がおすすめとほぼ同じ` : `${nm(r)}はほぼ同じ`);
  if (less.length) {
    if (f === 1) items.push(less.map((r) => `${nm(r)}が ${MINUS}${amount(-r.g!)} 万円`).join("、"));
    else items.push(`${less.map((r) => `${nm(r)}が ${amount(-r.g!)} 万円`).join("、")}少ない`);
  }
  // 差の出せない手（見積もりの無い手）は名前だけ
  if (bare.length) items.push(`${bare.map((r) => nm(r)).join("、")}${items.length ? "も選べる" : ""}`);
  if (!items.length) return { head, basis, others: "" };
  if (!more.length && !same.length && !less.length) return { head, basis, others: `ほかに選べるのは、${items[0]}。` };
  if (!more.length && !less.length && !bare.length) {
    const names = same.map((r) => nm(r)).join("、");
    return { head, basis, others: [`ほかの手は、${names}も見込みはほぼ同じ。`, `おすすめとの差は、${names}でもほぼ無い。`, `残りの手は、おすすめと${names}の見込みがほぼ同じ。`][f]! };
  }
  // 3 つ目は「残りの手は、『X』がおすすめとほぼ同じで、『Y』が N 万円少ない」（R10: 「おすすめより『X』はほぼ同じ」と言わない）
  const body = f === 2 ? items.map((t, j) => (j === items.length - 1 ? t : /い$/.test(t) ? renyo(t) : `${t}で`)).join("、") : items.join("、");
  return { head, basis, others: [`ほかの手は、${body}。`, `おすすめとの差は、${body}。`, `残りの手は、${body}。`][f]! };
}

/** 今日の手の名前（地図の手の名前。今のままは「今のまま」） */
/**
 * 今日の手の名前（「今日の『…』から数えて」）: 見取り図・道の画面の今日の手の行と同じ、そのカードの題。地図の手の種類の名前
 * （「転職活動をする」）にすると、題に言い換えのある手（fc_switch は「給与の上がる転職先を探す」とも）で、1 つの画面に同じ手の
 * 名前が 2 つ並ぶ（P2 の確かめ F1）
 */
const firstName = (c: Ctx, a: number): string => (c.map.isBase(a) ? "今のまま" : nameOf(c, a));

/** 道の最初の状態（今日の手の結果。3 か月目）の覚え */
function firstStateLink(link: Link): Link | null {
  let l: Link | null = link;
  while (l && l.up && l.up.up) l = l.up;
  return l && l.up ? l : null;
}

/**
 * 今日の手とその答えが、まだこの状態を決めているか（L4・rep-14。gov）。今日の手の種類ごとに道から決める: 届け出の答えは同じ会社にいて答えが
 * 変わらない間・転職して移った会社はその会社にいる間・週 4 日はその働き方の間（認められなかった答えは同じ会社の間）・試用と事例と担当は
 * その印がある間。道の最初の状態（今日の手の結果。出来事の文が答えを言う）では言わない
 */
function threadGov(c: Ctx, link: Link): boolean {
  const { map, B } = c;
  const fl = firstStateLink(link);
  if (!fl || fl === link || link.first < 0) return false;
  const kind = map.kind(link.first) ?? "";
  if (!B.thread[kind]) return false;
  const n = link.i;
  const s = map.st(n);
  const s0 = map.st(fl.i);
  // その後に勤め先が変わったか・独立したか・届け出の答えが出直したか
  let moved = false;
  let refiled = false;
  for (let l: Link | null = link; l && l !== fl; l = l.up) {
    if (l.newEmp) moved = true;
    if (l.evs.some((e) => e.code.startsWith("PERM_"))) refiled = true;
  }
  const kids = nextKinds(c, n);
  const id = map.outId(fl.i);
  if (FILING_KINDS.has(kind)) return !moved && !refiled && s.j !== "i" && s.pm === s0.pm && s0.pm !== "?";
  if (kind === "fc_switch") return /^(high|mid|high_mid)$/.test(id) && !moved && s.j !== "i";
  if (kind === "part") return id === "p" ? s.j === "p" : !moved && s.j === "e";
  if (kind === "sd_pilot") return kids.includes("sd_school") && (id !== "yes" || s.fl.includes("pilot"));
  if (kind === "ad_portfolio") return id === "yes" && s.fl.includes("portfolio") && (kids.includes("ad_side") || kids.includes("ad_more") || kids.includes("ad_permside"));
  if (kind === "fc_scope") return s.fl.includes("scope") && kids.includes("fc_push");
  return false;
}

/** 今日の手の効き目の一言の段取り（道だけで決まる。年収では変わらない）: この状態で言うか・道でそれまでに言った数・最後に言った月 */
interface ThreadMark {
  on: boolean;
  count: number;
  last: number | null;
}
const THREAD_MARKS = new WeakMap<Link, ThreadMark>();
/** 同じ今日の手の効き目を、道で言い直すまでの月（R3: 状態ごとに繰り返さない） */
const THREAD_GAP = 12;

/**
 * 0.9（R3・code-7）: 今日の手の効き目の一言は、効いている最初の状態で言い、その後は 12 か月ごとに 1 回だけ言い直す（節目からの月の文がある状態では
 * 言わない）。言い方（枠と中身）は道でそれまでに言った数で回すので、道の上で同じ文にならない
 */
function threadMark(c: Ctx, link: Link): ThreadMark {
  const hit = THREAD_MARKS.get(link);
  if (hit) return hit;
  const above: ThreadMark = link.up ? threadMark(c, link.up) : { on: false, count: 0, last: null };
  const m = c.map.month(link.i);
  const on = c.map.role(link.i) === "s" && threadGov(c, link) && (above.last === null || m - above.last >= THREAD_GAP) && sinceClause(c, link, planOf(c, link)) === "";
  const mark: ThreadMark = { on, count: above.count + (on ? 1 : 0), last: on ? m : above.last };
  THREAD_MARKS.set(link, mark);
  return mark;
}

/**
 * 今日の手とその答えが、まだこの状態を決めているときの一言（L4・rep-14）。中身（述語で終わる節）は束の thread、枠は 3 つを、道でそれまでに言った
 * 数で回す（構造の文。道の上で枠と中身の組が重ならない。code-7）。0.9（F3）: 中身の条件に、顧客の有無と次の判断の手の並びを渡す
 */
function threadSentence(c: Ctx, n: number, link: Link, env: Env, slots: Slots, trace: string[]): string {
  const { map, B, cal } = c;
  const mark = threadMark(c, link);
  if (!mark.on) return "";
  const fl = firstStateLink(link)!;
  const first = link.first;
  const kind = map.kind(first) ?? "";
  const s = map.st(n);
  const kids = nextKinds(c, n);
  const id = map.outId(fl.i);
  // 道でこの一言を言うのが何回目か（0 から）
  const j = mark.count - 1;
  const nextSide = kids.includes("ad_side") || kids.includes("ad_more") ? 1 : 0;
  const nextSd = kids.some((k) => k.startsWith("sd_")) ? 1 : 0;
  const eff = choose(B.thread[kind], { ...env, fo: id, gov: 1, nextSide, nextSd }, s.fl, slots, j, trace, `thread.${kind}`);
  if (!eff) return "";
  const name = `『${firstName(c, first)}』`;
  const single = map.childCount(first) < 2;
  const lab = `『${labelOf(c, fl.i)}』`;
  const ym = cal.ym(eventMonth(cal, kind, map.month(first)));
  trace.push("state:thread");
  if (single) return [`${eff}のは、今日の${name}があったから。`, `今日の${name}で、${eff}。`, `${ym}までの${name}（今日の手）がまだ効いていて、${eff}。`][j % 3]!;
  return [`${eff}のは、今日の${name}の結果が${lab}だったから。`, `今日の${name}が${lab}だったので、${eff}。`, `${ym}の${lab}（今日の${name}の結果）がまだ効いていて、${eff}。`][j % 3]!;
}

/** 状態の本文の長さの目安（点検 C3 の上より短く。超えるときは、決まった順に数の文を落とす） */
export const STATE_BUDGET = 460;
/**
 * 0.9: 道の最初の状態（今日の手の結果。3 か月目）の長さの目安。この状態だけが、3 年の見込みの見積もり方とずっと今のままの 3 年と、今日の手を
 * 選んだ時の見込みを言う（R1・R5・R10）ので、出来事の後の一言・別の結果との差・分かれ道を落とさないように長くする（今日の手のカードと同じ考え）
 */
export const FIRST_STATE_BUDGET = 600;

/** m か月目より後の、その暦の年の月の数（その年の残り） */
function restMonths(c: Ctx, m: number, year: number): number {
  let k = 0;
  for (let x = m + 1; c.cal.parts(x)[0] <= year; x++) if (c.cal.parts(x)[0] === year) k++;
  return k;
}

/**
 * 次の 3 か月の暦の文を 1 つ（道で 1 回だけ。確定申告はその年分ごとに 1 回）。truth-10:
 * - 確定申告の期間は年ごと。独立していた年は独立の申告（辞めた年・戻った年は給与と一緒に）
 * - 会社員の年は副業と SpellDash の所得（売上 − 経費）で決める。その年の残りの月（このカードより後）は今の月の稼ぎで足す（11 月のカードは
 *   12 月をまだ見ていない。facts-4）。線の上下 3 割（14〜26 万円）は「超えるなら確定申告・超えなくても住民税の申告」で、「要らない」と言わない。
 *   まとめた結果を通る道では、所得は平均の見積もり
 * - その年分に広告運用の稼ぎが無ければ、SpellDash の所得とだけ言う（reader-6）
 */
function calPick(c: Ctx, link: Link, env: Env, slots: Slots, used: (k: string) => boolean): CalPick | null {
  const { map, B, cal } = c;
  const n = link.i;
  const m = map.month(n);
  const s = map.st(n);
  const rr = map.rr(n);
  const months = [1, 2, 3].map((k) => cal.parts(m + k));
  const kinds = new Set(kidsOf(map, n).map((x) => map.kind(x)));
  const line = Number(B.facts.taxLine ?? NaN);
  const cands: CalPick[] = [];
  const season = months.find(([, mo]) => mo === 2 || mo === 3);
  if (season && Number.isFinite(line)) {
    const year = season[0] - 1;
    const jm = jobMonths(c, link, year);
    const rest = restMonths(c, m, year);
    const ad = sideIn(c, link, year, true) + rest * rr[1] >= 0.05;
    let code: string | null = null;
    if (jm.ind > 0 && jm.sal > 0) code = "TAX_MIX";
    else if (jm.ind > 0) code = "TAX_IND";
    else {
      const inc = sideIn(c, link, year) + rest * (rr[1] + rr[2]);
      code = inc > line * 1.3 ? "TAX_SIDE" : inc >= line * 0.7 ? "TAX_NEAR" : inc >= 0.5 ? "JUMIN_DECL" : null;
    }
    if (code) cands.push({ code, key: `TAX@${year}`, year, back: jm.back, ad });
  }
  const june = months.find(([, mo]) => mo === 6);
  if (june) {
    const prev = june[0] - 1;
    if (s.j !== "i" && sideIn(c, link, prev) >= 0.5) cands.push({ code: "JUMIN", key: "JUMIN", year: prev, back: false, ad: sideIn(c, link, prev, true) >= 0.05 });
    else if (s.j === "i" && jobMonths(c, link, prev).sal > 0) cands.push({ code: "JUMIN_IND", key: "JUMIN_IND", year: prev, back: false, ad: true });
  }
  if (months.some(([, mo]) => mo === 4) && s.j !== "i") cands.push({ code: "APRIL", key: "APRIL", year: 0, back: false, ad: true });
  if (kinds.has("ind_quit") || kinds.has("fc_switch") || kinds.has("fc_switch2")) cands.push({ code: "LEAVE", key: "LEAVE", year: 0, back: false, ad: true });
  for (const cd of cands) {
    if (used(cd.key)) continue;
    const e2 = calEnv(c, link, env, cd);
    if (B.cal[cd.code]?.some((g) => cond(g.if, e2, s.fl) && pickIn(g, calSlots(c, slots, cd), 0))) return cd;
  }
  return null;
}

/** 申告の文の仲間（独立の申告と、辞めた年・戻った年の申告は同じ仲間。副業の申告と住民税だけの申告も同じ仲間） */
const TAX_FAMILY: Record<string, readonly string[]> = { TAX_IND: ["TAX_IND", "TAX_MIX"], TAX_MIX: ["TAX_IND", "TAX_MIX"], TAX_SIDE: ["TAX_SIDE"], TAX_NEAR: ["TAX_NEAR"], JUMIN_DECL: ["JUMIN_DECL"] };

/** 暦の文の条件: again は、その道で同じ仲間の申告の文を前に使った（2 年目からの言い方）。back は会社員に戻った年。ad はその年分の広告運用の稼ぎ */
function calEnv(c: Ctx, link: Link, env: Env, cd: CalPick): Env {
  const again = cd.key.startsWith("TAX@") && (TAX_FAMILY[cd.code] ?? [cd.code]).some((code) => usedOn(c, link.up, `calcode:${code}`));
  return { ...env, again: again ? 1 : 0, back: cd.back ? 1 : 0, ad: cd.ad ? 1 : 0 };
}
function calSlots(c: Ctx, slots: Slots, cd: CalPick): Slots {
  if (!cd.key.startsWith("TAX@")) return slots;
  return { ...slots, taxYear: `${slot(cd.year)} 年分`, taxPeriod: c.cal.taxPeriod(cd.year), taxDeadline: c.cal.taxDeadline(cd.year) };
}

/** 道の上で今の会社に入ってから続けている転職活動の期の数（この期まで。続けて探した期。searchRun と比べる） */
function searchRunOf(link: Link): number {
  let n = 0;
  for (let l: Link | null = link; l && l.up; l = l.up) {
    if (l.kind !== "fc_switch" && l.kind !== "fc_switch2") break;
    n++;
  }
  return n;
}

/** 道の上で、この出来事の前に起きた同じ出来事（一番新しい物）。無ければ null */
function prevEvent(link: Link, code: string): Ev | null {
  for (let l: Link | null = link.up; l; l = l.up) for (const e of l.evs) if (e.code === code) return e;
  return null;
}

/**
 * 出来事の後の一言（0.8・con-2・rep-3・rep-4・rep-10・rep-12）: その出来事でこの先の何が変わったか（残る評価・探せる期・持てる顧客の数・
 * Pro の稼ぎの動き・見込みの動き）。数は状態・地図・C から差し込む（L3）。文に出す一番の出来事の束の型（無ければ種類を落とした名前）で、
 * 何回目か（evn）と進み具合の条件で選ぶ
 */
function thenSentence(c: Ctx, n: number, link: Link, env: Env, slots: Slots, trace: string[]): string {
  const { map, B, C, cal } = c;
  const top = shownEvents(link).find((e) => !e.code.startsWith("NEW_EMP_"));
  if (!top) return "";
  const bare = top.code.replace(/_[a-z_0-9]+$/, "");
  const cell = B.then[top.code] ? top.code : B.then[bare] ? bare : null;
  if (!cell && !CLIENT_CAP.has(top.code) && top.code !== "QUIET_keep") return "";
  const s = map.st(n);
  const m = map.month(n);
  const up = link.up!;
  const evn = countEvent(up, top.code);
  const sibs = kidsOf(map, map.parent(n)).filter((x) => x !== n && map.role(x) === "s");
  const r0 = map.rr(n)[0];
  const rs = sibs.map((x) => map.rr(x)[0]);
  const searchN = searchCount(link);
  const al = cal.aprils.filter((q) => q > m && q <= cal.horizon).length;
  const kids = nextKinds(c, n);
  const cap = capOf(C, s.j);
  const [bl, bh] = clBand(map, n);
  const dSd = map.rr(n)[2] - map.rr(up.i)[2];
  const prev = prevEvent(link, top.code);
  const nth = link.kind ? countKind(link, link.kind) : 0;
  const ev: Env = {
    ...evEnv(env, top, evn),
    al,
    searchN,
    searchLeft: C.searchMax - searchN,
    run: searchRunOf(link),
    capLeft: cap - bh,
    dsd0: Math.abs(dSd) < 0.05 ? 1 : 0,
    nthQ: nth,
    nextBack: kids.includes("back_emp") ? 1 : 0,
    nextSide: kids.includes("ad_side") || kids.includes("ad_more") ? 1 : 0,
    side1: link.kind === "ad_side" ? 1 : 0,
    nextSchool: kids.includes("sd_school") ? 1 : 0,
    sharep: prev?.x.share ? 1 : 0,
    pf: s.fl.includes("portfolio") ? 1 : 0,
    pil: s.fl.includes("pilot") ? 1 : 0,
    april: cal.aprils.some((q) => q > m && q <= cal.horizon) ? 1 : 0,
    exactNow: bl === bh ? 1 : 0,
    // 0.9（F2）: その 3 か月の遊ぶ人の伸びが、前提の伸び（続けている開発の分）のままか（今のままの 3 か月で、週 4 日でない）
    baseG: link.kind === "keep" && s.j !== "p" ? 1 : 0,
  };
  const es: Slots = {
    ...slots,
    ...evSlots(c, top, m),
    evnth: slot(evn + 1),
    searchN: slot(searchN),
    searchLeft: slot(Math.max(0, C.searchMax - searchN)),
    decLeft: slot(Math.max(1, Math.round((cal.horizon - m) / 3))),
    capLeft: slot(Math.max(0, cap - bh)),
    nthQ: slot(nth),
    dSd: slot(man(Math.abs(dSd))),
    beN: slot(Math.ceil(C.infraYen / C.netYen)),
    jobName: s.j === "i" ? "独立" : s.j === "p" ? "週 4 日勤務" : "会社員",
    // 0.9（F2・R7）: 有料になる割合は状態の数（地図の割合 × 続ける人を増やす工夫の倍率 cv）を「N 人に 1 人」で。工夫の分が入っていれば、そう添える
    convOne: oneIn(C.conv * (s.cv > 0 ? s.cv : 1)),
    convNote: Math.abs((s.cv || 1) - 1) > 0.005 ? "（続ける人を増やす工夫の分を入れて）" : "",
  };
  if (rs.length) {
    // 0.9（F4）: 上の結果が 2 つ以上（大きく上げて・少し上げて転職）なら、差を幅で言う（一番上の結果の差だけを言わない）
    const ups = [...new Set(rs.filter((x) => x > r0).map((x) => Math.round(c.annual * (x - r0))))].sort((a, b) => a - b);
    if (ups.length === 1) es.dSal = slot(n0(ups[0]!));
    else if (ups.length > 1) es.dSal = `${slot(n0(ups[0]!))}〜${slot(n0(ups[ups.length - 1]!))}`;
    const lo = Math.min(...rs);
    if (lo < r0) es.dSalD = slot(n0(c.annual * (r0 - lo)));
  }
  if (prev?.x.share) es.sharePrev = prev.x.share;
  // 顧客の出来事と、今のままが続く期は数の枠（持てる顧客の上限・次の顧客の見込みの動き・今のままの期と残る判断）。言い方は位置で回す（L2）
  const p = posOf(c, n);
  const job = es.jobName!;
  if (top.code === "CLIENT_MIX" && evn >= 1) {
    // 0.9（code-1）: 比べるのは 1 つ前の期（この状態の 1 つ前の判断に来た 3 か月）の、同じ何社目の見込みだけ（6〜15 か月前の別の何社目と比べない）
    const pq = up.evs.find((e) => e.code === "CLIENT_MIX");
    if (!top.x.share || !pq?.x.share || pq !== prev || strip(pq.x.hi ?? "") !== strip(top.x.hi ?? "") || strip(top.x.share) === strip(pq.x.share)) return "";
    trace.push("state:then:share");
    return [`${top.x.hi} 社目が決まる見込みは、前の期の ${prev.x.share}から ${top.x.share}に動いた。`, `前の期に ${prev.x.share}だった ${top.x.hi} 社目の見込みは、今回 ${top.x.share}。`, `${top.x.hi} 社目の見込みは ${prev.x.share}から ${top.x.share}へ。`][p % 3]!;
  }
  if (CLIENT_CAP.has(top.code) && !(top.code === "CLIENT_EXACT" && bh === 0)) {
    const left = cap - bh;
    if (left <= 0) return "";
    trace.push("state:then:cap");
    if (bl !== bh) return [`${job}で持てる顧客は ${slot(cap)} 社まで。`, `${job}のうちに持てる顧客の上限は ${slot(cap)} 社。`, `顧客の上限は、${job}で ${slot(cap)} 社。`][p % 3]!;
    return [`${job}で持てる顧客は ${slot(cap)} 社まで（あと ${slot(left)} 社）。`, `あと ${slot(left)} 社で、${job}で持てる ${slot(cap)} 社の上限に届く。`, `${job}のうちは ${slot(cap)} 社が上限で、残りは ${slot(left)} 社。`][p % 3]!;
  }
  if (top.code === "QUIET_keep" && nth >= 2) {
    trace.push("state:then:keep");
    return [`何も足さない期はこれで ${es.nthQ} 期目で、${es.hz}までに残る判断は ${es.decLeft} 回。`, `今のままを選んだのは ${es.nthQ} 回目で、残る判断はあと ${es.decLeft} 回。`, `${es.hz}までの判断はあと ${es.decLeft} 回で、今のままはこれが ${es.nthQ} 期目。`][p % 3]!;
  }
  if (!cell) return "";
  trace.push(`state:then`);
  return choose(B.then[cell], ev, s.fl, es, hash(map.key(link.first >= 0 ? link.first : n)) + hash(top.code) + evn, trace, `then.${cell}`) ?? "";
}

/** 持てる顧客の上限を言う顧客の出来事（数の枠。状態の出来事の後の一言） */
const CLIENT_CAP: ReadonlySet<string> = new Set(["FIRST_CLIENT", "CLIENT_UP", "CLIENT_REGAIN", "CLIENT_EXACT", "CLIENT_MIX"]);

function composeState(c: Ctx, n: number): Card {
  const { map, B } = c;
  const trace: string[] = [];
  const link = linkOf(c, n);
  const plan = planOf(c, link);
  const { env, slots } = stateEnv(c, n, link);
  const s = map.st(n);
  const m = map.month(n);
  const p = posOf(c, n);
  const seed0 = hash(map.key(link.first >= 0 ? link.first : n));
  const shown = shownEvents(link);
  const evText = shown
    .map((e) => {
      // その出来事の型が無ければ、種類を落とした名前（QUIET_fc_push → QUIET）の型。道で何回目か（evn）で言い換えを回す
      const bare = e.code.replace(/_[a-z_0-9]+$/, "");
      const cell = B.event[e.code] ? e.code : B.event[bare] ? bare : "QUIET";
      const evn = countEvent(link.up, e.code);
      // evnth: 道でその出来事が何回目か（何回も続く出来事の言い方。rep-5）
      const es = { ...slots, ...evSlots(c, e, m), evnth: slot(evn + 1) };
      const said = choose(B.event[cell], evEnv(env, e, evn), s.fl, es, seed0 + hash(e.code) + evn, trace, `event.${cell}`) ?? "";
      // その出来事の助言は、出来事の文のすぐ後（道で 1 回だけ。段取りで決めた組）
      const tip = plan.tips.find(([code]) => code === e.code);
      return said + (tip ? useGroup(B.tip[e.code], tip[1], es, hash(map.key(n) + e.code), trace, `tip.${e.code}`) : "");
    })
    .filter((x) => !!x)
    .join("");
  const head = evText ? `${slots.ym}、${evText}` : `${slots.ym}。`;
  const hint = plan.hint !== null ? useGroup(B.hint, plan.hint, slots, hash(map.key(n) + "hint"), trace, "hint") : "";
  let calText = "";
  if (plan.cal) {
    const cd = plan.cal;
    calText = choose(B.cal[cd.code], calEnv(c, link, env, cd), s.fl, calSlots(c, slots, cd), hash(map.key(n) + cd.code), trace, `cal.${cd.code}`) ?? "";
  }
  const since = sinceClause(c, link, plan);
  // 0.8（W2）: その出来事で変わったこと・この結果の見込みと月の稼ぎの動き・今日の手の効き目・3 年の見込み・別の結果との差・次の手の並びの違い・
  //   分かれ道・次の手（おすすめと差）。どれも数は差し込み（L3）で、数の行の数は書かない（L5）
  const then = thenSentence(c, n, link, env, slots, trace);
  const dq = quarterSentence(c, n, link, p, then !== "" && trace.some((t) => t.startsWith("then.PU_MILE#1")), trace);
  // 今日の手の効き目の一言は段取り（threadMark）で決める（節目からの月の文がある状態・12 か月以内に言った道では言わない。R3）
  const thread = threadSentence(c, n, link, env, slots, trace);
  const vals = stateVals(c, n, link);
  const total = vals ? totalSentence(c, link, p, vals, trace) : "";
  // 月の稼ぎの一番の違いは、その出来事が道で初めてで、出来事の後の一言が年収の差を言っていないときだけ添える
  const firstTime = shown.every((e) => countEvent(link.up, e.code) === 0) && !then.includes("年収");
  const cmp = contrastMain(c, n, link, p, firstTime, trace);
  const perm = permLine(c, n, plan.perm);
  const menu = menuSentence(c, n, p, trace);
  const forks = forkSentence(c, n, link, p, trace, false, thread !== "");
  const next = nextParts(c, n, p, trace);
  // 長さの目安（STATE_BUDGET）を超えるときは、決まった順に短くする: 次の手の並びの違いを落とす → 分かれ道の文の、別の結果との比べを落とす →
  //   この 3 か月の見込みと月の稼ぎ → 出来事の後の一言 → 別の結果との差 → 今日の手の効き目 → 分かれ道 → おすすめの手のカードの数の訳（F8）→
  //   最初の状態の見積もり方の注（R5）。出来事・節目・暦・助言・3 年の見込み・次の手（おすすめとほかの手との差）は落とさない
  const parts: string[] = [head, then, since, hint, dq, thread, total, cmp, perm, menu, forks, next.head, next.basis, next.others, calText];
  const at = { then: 1, dq: 4, thread: 5, total: 6, cmp: 7, menu: 9, forks: 10, basis: 12 } as const;
  // 中身の薄い出来事（静かな期・線を越えた・まとめた顧客の数）は、出来事の後の一言がその期の中身なので、別の結果との差より後に落とす
  const thin = /^(?:QUIET|PU_MILE|MAU_MILE|CLIENT_MIX)/.test(shown[0]?.code ?? "QUIET");
  const fk = (bare: boolean, min: boolean) => (): string => (forks ? forkSentence(c, n, link, p, [], bare, parts[at.thread] !== "", min) : "");
  // 0.9（R3）: 今日の手の効き目の一言は道で 12 か月ごとに 1 回だけなので、別の結果との差と出来事の後の一言より後に落とす
  const steps: Array<[keyof typeof at, () => string]> = [
    ["menu", () => ""],
    ["forks", fk(true, false)],
    ["dq", () => ""],
    ...(thin ? [] : ([["then", () => ""]] as Array<[keyof typeof at, () => string]>)),
    ["cmp", () => ""],
    ...(thin ? ([["then", () => ""]] as Array<[keyof typeof at, () => string]>) : []),
    ["thread", () => ""],
    ["forks", fk(true, true)],
    ["forks", () => ""],
    ["basis", () => ""],
    // 最後に、3 年の見込みの文の注（最初の状態の見積もり方・おすすめでない手を選んだ道のおすすめとの差）を落とし、選んだ手の名前を「手」と言う
    ["total", () => parts[at.total]!.replace(BASIS_NOTE, "").replace(/（おすすめの手なら[^）]*）/, "").replace(/3 か月前に選んだ『[^』]*』の見込み/, "3 か月前に選んだ手の見込み")],
  ];
  let size = parts.reduce((x, t) => x + len(t), 0);
  let forkForm: [boolean, boolean] = [false, false];
  const budget = p === 0 ? FIRST_STATE_BUDGET : STATE_BUDGET;
  for (const [k, short] of steps) {
    if (size <= budget) break;
    const was = parts[at[k]]!;
    if (!was) continue;
    parts[at[k]] = short();
    size += len(parts[at[k]]!) - len(was);
    trace.push(parts[at[k]] ? `state:short:${k}` : `state:drop:${k}`);
    if (k === "forks") forkForm = forkForm[0] ? [true, true] : [true, false];
  }
  // 今日の手の効き目の文を落としたら、分かれ道の文は今日の手の名前を言い直す（長さの目安を大きく超えないときだけ。超えるなら「今日の手」のまま）
  if (thread && !parts[at.thread] && parts[at.forks]) {
    const named = forkSentence(c, n, link, p, [], forkForm[0], false, forkForm[1]);
    if (size + len(named) - len(parts[at.forks]!) <= budget + 8) parts[at.forks] = named;
  }
  const body = join(parts);
  const top = link.evs[0];
  // 短い名前: 一番の出来事の短い名前（試作は {nth} などを埋めずに返していた）
  const short = top ? (fill(B.eventShort[top.code] ?? "", { ...slots, ...top.x }) ?? "") : "";
  return { title: titleOf(c, n, trace), short, body, numbers: numbersRow(c, n), todo: [], trace };
}

// ---- 3 年後の行き先

/** 行き先の節目に並べる出来事（大事な順） */
const MILESTONE_RANK = ["IND_START", "BACK_EMP", "SWITCH_HIGH", "SWITCH_MID", "SWITCH_MIX", "PERM_A", "PERM_S", "PERM_N", "PART_ON", "PROMO", "FIRST_CLIENT", "SCHOOL_ON", "CLIENT_UP", "PILOT_ON", "PU_MILE", "PORTFOLIO_ON", "CLIENT_LOST", "PRO_START"];

/** 同じ節目か（顧客の何社目・有料会員の人数の線は、数が違えば別の節目） */
const sameMilestone = (x: Ev, e: Ev): boolean => x.code === e.code && (e.code !== "CLIENT_UP" || x.x.nth === e.x.nth) && (e.code !== "PU_MILE" || x.x.mile === e.x.mile);

/**
 * 節目の短い名前。道で同じ節目の 2 回目からは、同じ仲間の節目の何回目かを言う（「2 回目の昇格」。F3）。
 * 差し込む値が空の出来事（社数の幅で離れた顧客の数など）は、その値を使う名前にしない
 */
function milestoneName(c: Ctx, e: Ev, evs: readonly Ev[], slots: Slots): string {
  const { B } = c;
  const x: Slots = {};
  for (const [k, v] of Object.entries(e.x)) if (v !== "") x[k] = v;
  const base = fill(B.eventShort[e.code] ?? "", { ...slots, ...x });
  const before = evs.slice(0, evs.indexOf(e));
  if (!before.some((y) => sameMilestone(y, e))) return base ?? "";
  const fam = milestoneFamily(e.code);
  const nth = slot(before.filter((y) => MILESTONE_RANK.includes(y.code) && milestoneFamily(y.code) === fam).length + 1);
  const again = B.eventShortAgain[e.code] ?? B.eventShortAgain[fam];
  return (again ? fill(again, { ...slots, ...x, nth }) : base ? `${nth} 回目の${base}` : null) ?? base ?? "";
}

const JOB_WORD: Record<string, string> = { e: "会社員", p: "週 4 日勤務", i: "独立" };
const PM_WORD: Record<string, string> = { a: "全部可", s: "SpellDash だけ可", n: "どちらも不可" };

/** 中身の幅の言葉（9 割がそろう事実だけを言い切り、ほかは「多い」「含む」で言う。truth-5）。独立した人に届け出は要らないので言わない（reader-5） */
function mixWords(mix: MapMix): string {
  const out: string[] = [];
  const jobs = (["e", "p", "i"] as const).map((k) => [k, mix.j[k]] as const).sort((x, y) => y[1] - x[1]);
  const [top, topP] = jobs[0]!;
  const second = jobs[1]!;
  if (topP >= SURE) out.push(`仕事は${JOB_WORD[top]}`);
  else out.push(`仕事は${JOB_WORD[top]}の道が多く、${JOB_WORD[second[0]]}の道も含む`);
  if (mix.switched >= SURE) out.push("転職している");
  else if (mix.switched > RARE) out.push("転職した道も含む");
  const pms = (["?", "a", "s", "n"] as const).map((k) => [k, mix.pm[k]] as const).sort((x, y) => y[1] - x[1]);
  if (mix.j.i >= SURE) {
    // 独立の道は会社への届け出が無い
  } else if (pms[0]![1] >= SURE) out.push(pms[0]![0] === "?" ? "届け出はしていない" : `届け出の答えは『${PM_WORD[pms[0]![0]]}』`);
  else out.push("届け出の答えは道によって違う");
  if (mix.pro >= SURE) out.push("Pro を出している");
  else if (mix.pro <= RARE) out.push("Pro はまだ出していない");
  else out.push(mix.pro >= 0.5 ? "Pro を出している道が多い" : "Pro を出している道は少ない");
  if (mix.school >= SURE) out.push("学校の導入がある");
  else if (mix.school > RARE) out.push("学校の導入がある道も含む");
  return out.join("。") + "。";
}

/** 標準の続きの出来事の名前（短い名前に差し込む数が要る物） */
const CONT_EV: Record<string, string> = { SWITCH_HIGH: "転職", SWITCH_MID: "転職", CLIENT_UP: "顧客が増える", CLIENT_REGAIN: "顧客を戻す", PU_MILE: "有料会員が増える", CLIENT_LOST: "顧客が離れる", FIRST_CLIENT: "1 社目が決まる" };

/** この後の目安で必ず見せる期（仕事と届け出が変わる。まとめて「ほか N 期」に入れない。facts-9） */
const KEY_EVS = new Set(["IND_START", "BACK_EMP", "SWITCH_HIGH", "SWITCH_MID", "PERM_A", "PERM_S", "PERM_N", "PART_ON"]);
const KEY_KINDS = new Set(["back_emp", "ind_quit", "fc_switch", "fc_switch2", "part", "ad_perm", "ad_permside", "sd_permpro"]);

/** この後の目安に並べる期の数（それより多ければ、大事でない期を「ほか N 期」とまとめる。道の画面は標準の続きを 1 期ずつ見せる） */
const CONT_MAX = 5;

/**
 * 標準の続きの 1 期の言い方（種類と出来事の決まった言い方があればそれ。無ければ種類の名詞と出来事の名前。同じことを 2 回言わない。reader-5）。
 * m はその期の手を選ぶ月。決まった言い方の {ymEv} は、その期の出来事が起きる月（会社員に戻る・独立・週 4 日・移る・昇格は、その期の手の月と
 * 違う月に起きる。モデルの出来事の月 eventMonth で言う。fact-1・点検 C11）。
 * cband: まとめた手を選んだ判断の顧客の数が社数の違う場合をまとめた幅（「1 社目」と社数を決めて言わない。truth-3）
 */
function contName(c: Ctx, kind: string, ev: string | undefined, m: number, cband = false): string {
  const { B, cal } = c;
  const anyCount = cband && ev === "FIRST_CLIENT";
  const own = ev && !anyCount ? B.contNoun[`${kind}.${ev}`] : undefined;
  if (own) return fill(own, { ymEv: cal.ymRel(eventMonth(cal, kind, m), m) }) ?? own;
  const noun = B.contNoun[kind] ?? kindNoun(c, kind);
  const evName = ev ? (anyCount ? "顧客が決まる" : (CONT_EV[ev] ?? fill(B.eventShort[ev] ?? "", {}))) : null;
  return evName && evName !== noun ? `${noun}（${evName}）` : noun;
}

/** まとめた行き先 i の、まとめた手を選んだ判断の顧客の数が社数の違う場合をまとめた幅か */
function contBand(c: Ctx, i: number): boolean {
  const d = c.map.parent(c.map.parent(i));
  if (d < 0) return false;
  const [lo, hi] = clBand(c.map, d);
  return lo !== hi;
}

/**
 * この後の目安（まとめた行き先の標準の続き。SPEC §4.2）。最後の月の稼ぎは中身の道の平均（その 1 本の道の数ではない。facts-9）。
 * 長ければ、仕事と届け出が変わる期を残して、その間の期を「ほか N 期」とまとめる（会社員に戻る・転職を隠さない）
 */
function contSentence(c: Ctx, cont: readonly MapContStep[], total: number, cband = false): string {
  const { cal } = c;
  const merged: Array<{ m: number; kind: string; ev?: string; n: number }> = [];
  for (const st of cont) {
    const last = merged[merged.length - 1];
    if (last && last.kind === st.kind && !last.ev && !st.ev) last.n++;
    else merged.push({ m: st.m, kind: st.kind, ...(st.ev ? { ev: st.ev } : {}), n: 1 });
  }
  const key = (st: (typeof merged)[number]): boolean => KEY_KINDS.has(st.kind) || (!!st.ev && KEY_EVS.has(st.ev));
  const keep = merged.map(key);
  let room = CONT_MAX - keep.filter((x) => x).length;
  // 残りの枠は、出来事のある期を先に、次に早い期から
  for (const withEv of [true, false])
    for (let k = 0; k < merged.length; k++)
      if (!keep[k] && room > 0 && !!merged[k]!.ev === withEv) {
        keep[k] = true;
        room--;
      }
  let prev: number | null = null;
  const parts: string[] = [];
  let hidden = 0;
  for (let k = 0; k < merged.length; k++) {
    const st = merged[k]!;
    if (!keep[k]) {
      hidden += st.n;
      continue;
    }
    if (hidden) parts.push(`ほか ${slot(hidden)} 期`);
    hidden = 0;
    parts.push(`${cal.ymRel(st.m, prev)} ${contName(c, st.kind, st.ev, st.m, cband)}${st.n > 1 ? `（${slot(st.n)} 期）` : ""}`);
    prev = st.m;
  }
  if (hidden) parts.push(`ほか ${slot(hidden)} 期`);
  return `この後の目安: ${[...parts, `${cal.ymRel(cal.horizon, prev)}（平均 月 ${slot(man(total))} 万円）`].join(" → ")}。`;
}

/** まとめた行き先の中身（幅と続き）が同じ兄弟（違うのはその 3 か月の結果と、そこからの稼ぎの合計だけ。reader-5） */
function sameSibs(c: Ctx, n: number): number[] {
  const { map } = c;
  const key = (x: number): string => JSON.stringify([map.mix(x), map.cont(x), map.mix(x) ? null : map.st(x)]);
  const k0 = key(n);
  return kidsOf(map, map.parent(n)).filter((x) => x !== n && map.role(x) === "e" && map.sum(x) && key(x) === k0);
}

/**
 * 何も変えなかった結果の出来事（据え置き・見送り・決まらない・断られた・どちらも不可）。その 3 か月に月の稼ぎが動いても、
 * 動かしたのは定期の昇給や Pro の伸びで、この結果ではない（F4）
 */
const NO_CHANGE: ReadonlySet<string> = new Set(["PROMO_NO", "SEARCH_NONE", "SCHOOL_NO", "PILOT_NO", "PORTFOLIO_NO", "PART_NO", "BACK_NO", "CLIENT_NOT_FOUND", "PERM_N"]);

/** この道で月の稼ぎを一番動かした 3 か月。named は結果の名前で言うか（言わなければ、その 3 か月の手で言う） */
interface Lever {
  link: Link;
  /** 月の稼ぎの動き（万円） */
  d: number;
  named: boolean;
}

/**
 * この道で月の稼ぎを一番動かした 3 か月（判断の状態から結果の状態へ月の稼ぎが一番動いた物）。行き先の結びを道から作る（reader-8）。
 * 結果の名前で言うのは、その結果が何かを変えたときだけ（どの場合も・結果が 1 つ・何も変えなかった結果は、3 か月の手で言う。F4）。今の年収で決まる
 */
function leverOf(c: Ctx, link: Link): Lever | null {
  const { map } = c;
  let best: Link | null = null;
  let bestD = 0;
  const w = (i: number): number => {
    const rr = map.rr(i);
    return salMan(c, rr[0]) + rr[1] + rr[2];
  };
  for (let l: Link | null = link; l && l.up; l = l.up) {
    // 何も変えなかった結果（据え置き・決まらない・見送り…）の 3 か月は数えない: その 3 か月に月の稼ぎが動いても、動かしたのは定期の昇給や
    // Pro の伸びで、選んだ手ではない（「昇格を狙う」の 3 か月を、据え置きだったのに一番の動きと言わない。reader-11・F4）
    if (map.sum(l.i) || l.evs.some((e) => NO_CHANGE.has(e.code))) continue;
    const dd = w(l.i) - w(l.up.i);
    if (Math.abs(dd) > Math.abs(bestD) + 1e-9) {
      best = l;
      bestD = dd;
    }
  }
  if (!best || Math.abs(bestD) < 1) return null;
  const named = map.outId(best.i) !== "all" && map.childCount(best.move) >= 2;
  return { link: best, d: bestD, named };
}

/** 3 か月の手の名前: 題（年月や「か月」を言う題は、結びの文の年月と重ねないように短い名前） */
function quarterName(c: Ctx, a: number): string {
  // 手引きの歩みの題（数字は引いた項目の物）は、行き先では差し込みとして言う（行き先はその項目を引かない。点検 C1b）
  const t = nameOf(c, a).replace(/\u0003([^\u0004]*)\u0004/g, (_, x: string) => slot(x));
  return /年|か月/.test(strip(t)) ? kindShort(c, c.map.kind(a) ?? "") : t;
}

/** 給与・勤め先が変わる出来事（その 3 か月の給与の動きは、この出来事による） */
const JOB_EVENTS = /^(SWITCH_|PROMO$|PROMO_MIX|PART_ON|PART_MIX|BACK_EMP|BACK_MIX|IND_START)/;

/**
 * 結果の名前で言わない 3 か月の、月の稼ぎの動きの主な中身（給与・広告運用・SpellDash のうち一番大きく動いた物）。給与の出来事の無い 3 か月の
 * 給与の動きは 4 月の定期の昇給（手の名前だけで言うと、手が動かしたように読める。reader-11）
 */
function leverSource(c: Ctx, link: Link, d: number): string {
  const name = leverName(c, link, d);
  return name ? `（主に${name}）` : "";
}

/**
 * その 3 か月の月の稼ぎの動き d の主な中身の名前（給与・4 月の定期の昇給・広告運用の売上・SpellDash の稼ぎ）。0.9（code-4）: d と同じ向きに
 * 動いた物のうち一番大きい物（逆に動いた物を「主に」と言わない）。同じ向きの物が無ければ null
 */
function leverName(c: Ctx, link: Link, d: number): string | null {
  const { map, cal } = c;
  const a = map.rr(link.up!.i);
  const b = map.rr(link.i);
  const parts: Array<[number, string]> = [
    [salMan(c, b[0]) - salMan(c, a[0]), link.evs.some((e) => JOB_EVENTS.test(e.code)) ? "給与" : cal.aprils.some((q) => q > map.month(link.move) && q <= map.month(link.i)) ? "4 月の定期の昇給" : "給与"],
    [b[1] - a[1], "広告運用の売上"],
    [b[2] - a[2], "SpellDash の稼ぎ"],
  ];
  const same = parts.filter(([x]) => (d > 0 ? x > 0 : x < 0)).sort((x, y) => Math.abs(y[0]) - Math.abs(x[0]));
  return same[0]?.[1] ?? null;
}

/** 1b・W4（rep-15）: 言い方は兄弟の並び（rot）で 3 つを回す（同じ手の別の結果の行き先と、同じ文を並べない） */
function leverSentence(c: Ctx, lv: Lever | null, rot = 0): string {
  if (!lv) return "";
  const { map, cal } = c;
  const what = lv.named ? `『${labelOf(c, lv.link.i)}』` : `『${quarterName(c, lv.link.move)}』の 3 か月`;
  const ym = cal.ym(map.month(lv.link.i));
  const amt = `月 ${sgn(lv.d)}${slot(man(Math.abs(lv.d)))} 万円`;
  const src = lv.named ? "" : leverSource(c, lv.link, lv.d);
  return [`この道で月の稼ぎを一番大きく動かしたのは、${ym}までの${what}で、${amt}${src}。`, `月の稼ぎが一番大きく動いたのは${ym}までの${what}で、${amt}${src}。`, `この道で一番大きい月の稼ぎの動きは、${ym}までの${what}の${amt}${src}。`][rot % 3]!;
}

/**
 * 0.9（R6・L1）: 行き先の、今日からこの道の 3 年の稼ぎ（ここまでの稼ぎ + 残りの月。状態の「今日からの 3 年の見込み」と同じ計算で、行き先は
 * 見込みでなく着いた道の数）と、ずっと今のままとの差（見せる数どうし。R4）。まとめた行き先は標準の続きの見積もりを入れた数だと言う
 */
function endTotalSentence(c: Ctx, n: number, link: Link): string {
  const ahead = aheadOf(c, n);
  if (ahead === null) return "";
  const X = accOf(c, link) + ahead;
  const keep = keepTotalOf(c);
  const tot = `${manSigned(X)} 万円`;
  const vs = keep === null ? "" : `で、ずっと今のまま${moveWord(shownMan(X) - shownMan(keep), "多い", "少ない", "とほぼ同じ")}`;
  return c.map.sum(n) ? `標準の続きを入れた今日からの 3 年の稼ぎは ${tot}${vs}。` : `今日からこの道の 3 年の稼ぎは ${tot}${vs}。`;
}

// ---- 行き先の 3 年のまとめ（1b・W4: con-6・rep-15・con-13・L4）
// 本当の行き先は、最後の 3 か月の結果 → 節目 → 今日の手とその答え → 3 年の稼ぎとその内訳 → 月の稼ぎの動き（今日・1 年後・2 年後・3 年後）→
//   同じ手の別の結果との差 → 3 年の稼ぎを一番分けた判断 → 月の稼ぎを一番動かした 3 か月 → 3 年の後の伸びしろ（状態の数と前提から）の順に書く。
//   どの文も道 1 本に 1 回（行き先は道の終わりに 1 枚）。数は道のカードと前提から差し込む（L3）

/** 道の 3 年の稼ぎの内訳（万円）: 給与・広告運用・SpellDash。道のカードの e を成分ごとに足し（accOf と同じ順）、3 年の終わりまで残る月は rr で足す */
interface Makeup {
  sal: number;
  ads: number;
  sd: number;
}

function makeupOf(c: Ctx, link: Link, n: number): Makeup {
  const { map, annual, cal } = c;
  const ls: Link[] = [];
  for (let l: Link | null = link; l && l.up; l = l.up) ls.push(l);
  let sal = 0;
  let ads = 0;
  let sd = 0;
  for (let k = ls.length - 1; k >= 0; k--) {
    const e = map.e(ls[k]!.i);
    sal += e[0] * (annual / 12);
    ads += e[1];
    sd += e[2];
  }
  const rest = map.childCount(n) ? 0 : Math.max(0, cal.horizon - map.month(n));
  if (rest) {
    const rr = map.rr(n);
    sal += rr[0] * (annual / 12) * rest;
    ads += rr[1] * rest;
    sd += rr[2] * rest;
  }
  return { sal, ads, sd };
}

/** 整数の万円に丸めて、足すと T になるように端数を配る（大きい端数から。見せる合計と内訳の足し算を合わせる。点検 C14） */
function splitShown(xs: readonly number[], T: number): number[] {
  const out = xs.map((x) => Math.floor(x));
  let rem = T - out.reduce((a, b) => a + b, 0);
  const order = xs.map((x, k) => [x - Math.floor(x), k] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; rem > 0 && k < 64; k++, rem--) out[order[k % xs.length]![1]]!++;
  for (let k = 0; rem < 0 && k < 64; k++, rem++) out[order[xs.length - 1 - (k % xs.length)]![1]]!--;
  return out;
}

/** 内訳の 1 つ（負なら −。差し込みの印つき） */
const partMan = (x: number): string => (x < 0 ? `${MINUS}${slot(n0(-x))}` : slot(n0(x)));

/**
 * con-6（a）: 3 年の稼ぎの内訳（給与・SpellDash・広告運用）。足すと見せる合計 X（endTotalSentence の数・道の画面の合計）になる。
 * 独立したことのある道の広告運用は、独立の経費を引いた額（モデルの e[1]）
 */
function makeupSentence(c: Ctx, link: Link, n: number, X: number): string {
  if (Math.abs(X) < 9.95) return "";
  const mk = makeupOf(c, link, n);
  const [sal, sd, ads] = splitShown([mk.sal, mk.sd, mk.ads], Math.round(X));
  // まとめた行き先は、中身の道に独立した道があれば（平均の広告運用が負になる物も）経費を引いた額と言う
  const mix = c.map.sum(n) ? c.map.mix(n) : null;
  const adName = link.indFrom !== null || (mix !== null && mix.j.i > 0) || mk.ads < 0 ? "広告運用（独立の経費を引いて）" : "広告運用";
  return `内訳は給与 ${partMan(sal!)} 万円・SpellDash ${partMan(sd!)} 万円・${adName} ${partMan(ads!)} 万円。`;
}

/** con-6（a）: 月の稼ぎの動き（今日・1 年後・2 年後・3 年後。道の判断の状態の月の稼ぎ）。独立なら 3 年後の数は経費を引いた後 */
function trajectorySentence(c: Ctx, link: Link, n: number): string {
  const { map, C } = c;
  const at = new Map<number, number>();
  const ind = new Map<number, boolean>();
  for (let l: Link | null = link.up; l; l = l.up) {
    at.set(map.month(l.i), monthlyOf(c, l.i));
    ind.set(map.month(l.i), map.st(l.i).j === "i");
  }
  const m0 = at.get(0);
  if (m0 === undefined) return "";
  const s = map.st(n);
  // 修正（facts-9）: 負の月の稼ぎは「−」で、独立している点は経費を引いた後の数だと、その最初の点で 1 回言う
  let noted = false;
  const note = (isInd: boolean): string => {
    if (!isInd || noted) return "";
    noted = true;
    return `（経費 月 ${slot(man(C.overhead))} 万円を引いた後）`;
  };
  const pts: string[] = [];
  for (const m of [12, 24]) {
    const v = at.get(m);
    if (v !== undefined) pts.push(`${slot(m / 12)} 年後 ${monMan(v)} 万円${note(ind.get(m) === true)}`);
  }
  const end = `${slot(3)} 年後は ${monMan(monthlyOf(c, n))} 万円${note(s.j === "i")}`;
  return `月の稼ぎは、今日の ${monMan(m0)} 万円から${pts.length ? `${pts.join("、")}、` : ""}${end}と動いた。`;
}

/** 道の上で、今日の手の結果の後に勤め先が変わったか・届け出の答えが出直したか（今日の手の効き目が続くかの元） */
function movedSince(link: Link, fl: Link): { moved: boolean; refiled: boolean } {
  let moved = false;
  let refiled = false;
  for (let l: Link | null = link; l && l !== fl; l = l.up) {
    if (l.newEmp) moved = true;
    if (l.evs.some((e) => e.code.startsWith("PERM_"))) refiled = true;
  }
  return { moved, refiled };
}

/**
 * L4（行き先）: 今日の手とその答えが 3 年の終わりまで効いているか（状態の threadGov と同じ決まりで、次の判断の手の並びを見ない物）。
 * 独立の手は、独立のままか会社員に戻ったかを言う（どちらも今日の手から続く道）
 */
function endGov(c: Ctx, link: Link, fl: Link): boolean {
  const { map } = c;
  const kind = map.kind(link.first) ?? "";
  const s = map.st(link.i);
  const s0 = map.st(fl.i);
  const id = map.outId(fl.i);
  const { moved, refiled } = movedSince(link, fl);
  if (FILING_KINDS.has(kind)) return !moved && !refiled && s.j !== "i" && s.pm === s0.pm && s0.pm !== "?";
  if (kind === "fc_switch") return /^(high|mid|high_mid)$/.test(id) && !moved && s.j !== "i";
  if (kind === "part") return id === "p" ? s.j === "p" : id === "e" && !moved && s.j === "e";
  if (kind === "ind_quit") return true;
  if (kind === "sd_pilot") return id === "yes" && s.fl.includes("pilot");
  if (kind === "ad_portfolio") return id === "yes" && s.fl.includes("portfolio");
  if (kind === "fc_scope") return s.fl.includes("scope") && !moved && s.j !== "i";
  return false;
}

/**
 * con-6（b）・L4: 今日の手と、この道でのその答え（見込みつき）。答えが 3 年の終わりまで効いていれば、その中身（束の endThread）を言う
 * （行き先は道の終わりに 1 枚なので、道で 1 回）
 */
function todaySentence(c: Ctx, link: Link, env: Env, slots: Slots, trace: string[], rot = 0): string {
  const { map, B } = c;
  const a = link.first;
  if (a < 0) return "";
  const fl = firstStateLink(link);
  if (!fl) return "";
  const name = `『${firstName(c, a)}』`;
  const kind = map.kind(a) ?? "";
  const gov = endGov(c, link, fl) ? (choose(B.endThread?.[kind], { ...env, fo: map.outId(fl.i) }, map.st(link.i).fl, slots, 0, trace, `endThread.${kind}`) ?? "") : "";
  trace.push("end:today");
  // 言い方は兄弟の並び（rot）で 3 つを回す（rep-15）
  const r = rot % 3;
  if (map.childCount(a) < 2) return gov ? [`今日の手は${name}で、${gov} 3 年を終える。`, `この道は今日${name}を選び、${gov} 3 年を終える。`, `今日選んだのは${name}で、${gov} 3 年を終える。`][r]! : [`今日の手は${name}だった。`, `この道は今日${name}を選んだ。`, `今日選んだのは${name}。`][r]!;
  const lab = `『${labelOf(c, fl.i)}』${oddsOf(c, fl.i)}`;
  return gov ? [`今日の${name}は${lab}で、${gov} 3 年を終える。`, `この道の今日の手は${name}で、答えは${lab}。${gov} 3 年を終える。`, `今日選んだ${name}の答えは${lab}で、${gov} 3 年を終える。`][r]! : [`今日の${name}は${lab}だった。`, `この道の今日の手は${name}で、答えは${lab}。`, `今日選んだ${name}の答えは${lab}だった。`][r]!;
}

/**
 * con-6（c）: この道の判断のうち、この道が選んだ手とほかの手で 3 年の見込みが一番開いていた判断（選んだ手と、ほかの手で見込みの一番多い手、
 * その差）。修正（reader-4・facts-3）: 見込みは状態のカードが手の差に使う物（その後を標準の選び方で続けた見積もり。optionValue）で、差は
 * 状態のカードと同じく値の差を丸める（同じ道の同じ判断に 1 つの差）。一番多い手と少ない手の開きでは、少ない手がいつも『辞めて独立する』に
 * なっていたので、選んだ手との差で言う
 */
/** 判断 d に並ぶ手の見込みの上から 2 つ（年収と計算の芯ごとに判断の覚えに覚える。行き先ごとに数え直さない。L7） */
interface Top2 {
  a1: number;
  v1: number;
  a2: number;
  v2: number;
}
const TOPS = new WeakMap<Link, { annual: number; v: Top2 | null }>();
function top2Of(c: Ctx, l: Link): Top2 | null {
  const hit = TOPS.get(l);
  if (hit && hit.annual === c.annual) return hit.v;
  const { map } = c;
  const d = l.i;
  let a1 = -1;
  let a2 = -1;
  let v1 = -Infinity;
  let v2 = -Infinity;
  for (let k = 0; k < map.childCount(d); k++) {
    const a = map.child(d, k);
    if (map.role(a) !== "a") continue;
    const v = optionValue(map, a, c.annual);
    if (v === null) continue;
    if (v > v1) [a2, v2, a1, v1] = [a1, v1, a, v];
    else if (v > v2) [a2, v2] = [a, v];
  }
  const v = a2 < 0 ? null : { a1, v1, a2, v2 };
  TOPS.set(l, { annual: c.annual, v });
  return v;
}

function decisionSentence(c: Ctx, link: Link, trace: string[], rot = 0): string {
  const { map, cal } = c;
  let best: { d: number; gap: number; chose: number; other: number } | null = null;
  let child: Link = link;
  for (let l: Link | null = link.up; l; child = l, l = l.up) {
    const t = top2Of(c, l);
    const ch = child.move;
    if (!t || ch < 0) continue;
    const vc = optionValue(map, ch, c.annual);
    if (vc === null) continue;
    const [other, vo] = ch === t.a1 ? [t.a2, t.v2] : [t.a1, t.v1];
    const gap = vc - vo;
    if (!best || Math.abs(gap) > Math.abs(best.gap)) best = { d: l.i, gap, chose: ch, other };
  }
  if (!best || Math.abs(shownMan(best.gap)) < 1) return "";
  trace.push("end:decision");
  const when = map.role(best.d) === "r" ? "今日の判断" : `${cal.ym(map.month(best.d))}の判断`;
  // 名前は状態のカードの手の差と同じ（今のままは「今のまま」）
  const ch = `『${optName(c, best.chose)}』`;
  const o = `『${optName(c, best.other)}』`;
  const g = `${amount(Math.abs(best.gap))} 万円`;
  // 言い方は兄弟の並び（rot）で 3 つを回す（rep-15）
  const r = rot % 3;
  if (best.gap > 0)
    return [`3 年の稼ぎを一番分けたのは${when}で、この道の${ch}は、ほかの手で見込みの一番多い${o}より ${g}多い見込みだった。`, `${when}が、3 年の稼ぎを一番大きく分けた。この道が選んだ${ch}の見込みは、次に多い${o}を ${g}上回っていた。`, `選んだ手とほかの手の見込みの差が一番大きかったのは${when}で、この道の${ch}は${o}より ${g}多い見込みだった。`][r]!;
  return [`3 年の稼ぎを一番分けたのは${when}で、この道の${ch}は、見込みの一番多い${o}より ${g}少ない見込みだった。`, `${when}が、3 年の稼ぎを一番大きく分けた。この道が選んだ${ch}の見込みは、${o}を選んだ場合より ${g}少なかった。`, `選んだ手とほかの手の見込みの差が一番大きかったのは${when}で、この道の${ch}は${o}より ${g}少ない見込みだった。`][r]!;
}

/** 3 年の終わりの次の 4 月（評価の月） */
function aprilAfter(c: Ctx): number | null {
  for (let m = c.cal.horizon + 1; m <= c.cal.horizon + 12; m++) if (c.cal.parts(m)[1] === 4) return m;
  return null;
}

/**
 * con-13: 3 年の後（3 年の終わりの次の 3 か月から）の伸びしろ。状態（仕事・届け出の答え・顧客・Pro・学校）と前提の数で選び、額と見込みと年月を
 * 差し込む（約束しない。見込みは「この地図では…とみる」）。束の after
 */
function outlookSentence(c: Ctx, n: number, link: Link, env: Env, slots: Slots, trace: string[]): string {
  const { map, B, C, cal, annual } = c;
  const s = map.st(n);
  const cap = capOf(C, s.j);
  const capLeft = Math.max(0, cap - clr(s.cl));
  const fee = newFeeOf(C, s.j, link.f5);
  const apr = s.j === "e" ? aprilAfter(c) : null;
  const promoPx = s.fl.includes("scope") ? C.promoPScope : C.promoP;
  const schoolPx = s.fl.includes("pilot") ? C.schoolP * C.pilotMult : C.schoolP;
  const e2: Env = { ...env, capLeft, apr: apr !== null ? 1 : 0 };
  const s2: Slots = {
    ...slots,
    np: cal.period(cal.horizon),
    capLeft: slot(capLeft),
    gainCl: slot(man(capLeft * fee)),
    newFee: slot(man(fee)),
    promoPx: wari(promoPx),
    schoolPx: wari(schoolPx),
    schoolGain: slot(man((C.schoolSeats * C.seatYen) / 10000)),
    // 修正（facts-4）: 昇格 1 回の額は昇格の手のカードと同じ（昇格の後に 4 月の昇給が掛かる）
    stepMan: slot(n0(annual * C.step * (1 + C.aprilRaise))),
    // 修正（facts-10）: 週 4 日で減る給与は、3 年の終わりの週 5 日の給与で数える
    partLossY: slot(n0(annual * s.sal * (1 - C.partFactor))),
    ...(apr !== null ? { nextApril: cal.ym(apr) } : {}),
  };
  return choose(B.after, e2, s.fl, s2, hash(map.key(n)), trace, "after") ?? "";
}

/** 1b・W4: 本当の行き先の本文の長さの目安（点検 C3 の LIMITS.e.max より短く。超えるときは決まった順に落とす） */
export const END_BUDGET = 640;

function composeEnd(c: Ctx, n: number): Card {
  const { map } = c;
  const trace: string[] = [];
  const { env, slots } = baseEnv(c, n);
  const link = endLink(c, n);
  const sum = map.sum(n);
  // 結びの文（この道で月の稼ぎを一番動かした 3 か月）。本当の行き先だけ。1b・W4（con-6）: 最後の 3 か月の物で動きが 2 万円に満たなければ言わない
  let lever = sum ? null : leverOf(c, link);
  if (lever && lever.link === link && Math.abs(lever.d) < 2) {
    lever = null;
    trace.push("end:drop:lever");
  }
  // 節目: 大事な物から 4 つまで（同じ出来事は道で最初の 1 回）、それを月の順に。結びの文が結果の名前で言う 3 か月の節目は、
  // 同じ出来事の 2 回目からでも必ず並べる（足りなければ一番大事でない物と入れ替える。節目と結びの文が食い違わない。F3）
  const rank = (e: Ev): number => MILESTONE_RANK.indexOf(e.code);
  const evs = eventsList(link);
  let ms = evs
    .filter((e) => rank(e) >= 0)
    .sort((x, y) => rank(x) - rank(y))
    .filter((e, i, arr) => arr.findIndex((x) => sameMilestone(x, e)) === i)
    .slice(0, 4);
  const credited = lever?.named
    ? lever.link.evs
        .filter((e) => rank(e) >= 0)
        .sort((x, y) => rank(x) - rank(y))[0]
    : undefined;
  if (credited && !ms.includes(credited)) ms = ms.length >= 4 ? [...ms.slice(0, 3), credited] : [...ms, credited];
  ms.sort((x, y) => x.m - y.m);
  let prev: number | null = null;
  const msText = ms
    .map((e) => {
      const name = milestoneName(c, e, evs, slots);
      if (!name) return "";
      const t = `${c.cal.ymRel(e.m, prev)}に${name}`;
      prev = e.m;
      return t;
    })
    .filter((x) => x)
    .join("、");
  const s = map.st(n);
  const rr = map.rr(n);
  const total = salMan(c, rr[0]) + rr[1] + rr[2];
  const mix = map.mix(n);
  const cont = map.cont(n);
  const path = msText ? `ここまでの節目は、${msText}。` : "";
  const ahead = aheadOf(c, n);
  const X = ahead === null ? null : accOf(c, link) + ahead;
  const makeup = X === null ? "" : makeupSentence(c, link, n, X);
  if (makeup) trace.push("end:makeup");
  // 兄弟の並び（rep-15: 同じ手の別の結果の行き先と同じ文を並べないよう、道で 1 回の文の言い方を回す）
  const rot = Math.max(0, kidsOf(map, map.parent(n)).indexOf(n));
  const today = todaySentence(c, link, env, slots, trace, rot);
  let body: string;
  if (!sum) {
    let job = JOB_WORD[s.j]!;
    if (s.j === "i" && link.indFrom !== null) job = `独立して ${slot(map.month(n) - link.indFrom + 1)} か月目`;
    else if (s.j !== "i" && s.fl.includes("switched")) job = `移った会社の${job}`;
    // rep-15: 書き出しは最後の 3 か月の手とその結果（見込みつき）。兄弟の行き先が同じ書き出しにならない
    const mv = map.parent(n);
    const qn = `『${quarterName(c, mv)}』`;
    const head = map.childCount(mv) >= 2 ? `${slots.ym}（3 年後）、最後の 3 か月の${qn}は『${labelOf(c, n)}』${oddsOf(c, n)}で、仕事は${job}。` : `${slots.ym}（3 年後）、最後の 3 か月は${qn}で、仕事は${job}。`;
    const traj = trajectorySentence(c, link, n);
    if (traj) trace.push("end:traj");
    const parts = [head, path, today, endTotalSentence(c, n, link), makeup, traj, endContrast(c, n), decisionSentence(c, link, trace, rot), leverSentence(c, lever, rot), outlookSentence(c, n, link, env, slots, trace)];
    // 長さの目安を超えるときは、決まった順に落とす: 月の稼ぎを一番動かした 3 か月 → 節目 → 同じ手の別の結果との差。3 年の稼ぎ・内訳・
    //   月の稼ぎの動き・今日の手・一番分けた判断・伸びしろは落とさない
    const at = { lever: 8, path: 1, contrast: 6 } as const;
    let size = parts.reduce((x, t) => x + len(t), 0);
    for (const k of ["lever", "path", "contrast"] as const) {
      if (size <= END_BUDGET) break;
      const was = parts[at[k]]!;
      if (!was) continue;
      parts[at[k]] = "";
      size -= len(was);
      trace.push(`end:drop:${k}`);
    }
    body = join(parts);
  } else {
    // まとめた行き先（truth-5・truth-2）: 中身の幅があれば 9 割がそろう事実だけを言い切り、無ければ平均だと書いて事実として言わない。
    // どの結果の後かを書き出しで言い、兄弟とはこの手からの稼ぎの合計で比べる（兄弟の行き先が同じ骨組みにならない。点検 C6）。
    // 中身と続きが同じ兄弟があれば、その名前を言い、違いの稼ぎの合計を先に置く（reader-5）。1b・W4: 今日の手とその答え・3 年の稼ぎの内訳を足す
    trace.push(mix ? "sum:mix" : "sum:avg");
    const from = sumNamed(c, n) ? `『${labelOf(c, n)}』の後を、` : "この手の後を、";
    const head = mix ? `${slots.ym}（3 年後）の見込み（${from}標準の選び方で続けた見積もり）。` : `${slots.ym}（3 年後）の平均（${from}標準の選び方で続けた見積もり）。多くの道を平均した物で、仕事は一番多い${JOB_WORD[s.j]}の道の場合、数は平均（1 本の道の数ではない）。`;
    const same = sameSibs(c, n);
    let shared = "";
    if (same.length) {
      trace.push("sum:same");
      shared = `『${same.map((x) => labelOf(c, x)).join("』・『")}』の後と、標準の続きも 3 年後の姿も同じ。違うのはこの手の 3 か月の結果と、そこからの稼ぎ。`;
    }
    const monthly = `この時の月の稼ぎは平均で ${slot(man(total))} 万円。`;
    const tail = cont && cont.length ? (trace.push("cont"), contSentence(c, cont, total, contBand(c, n))) : "この先の道は、この先の分かれ道での選び方と運で分かれる。";
    const total3 = endTotalSentence(c, n, link);
    body = shared ? join([head, shared, sumSoFar(c, n), total3, makeup, today, mix ? mixWords(mix) : "", path, monthly, tail]) : join([head, mix ? mixWords(mix) : "", path, monthly, sumSoFar(c, n), total3, makeup, today, tail]);
  }
  return { title: titleOf(c, n, trace), short: "", body, numbers: numbersRow(c, n), todo: [], trace };
}

// ---- 今日

/**
 * 1b・W4（con-11）: 今日の手の先の分かれ道は、どの手もほぼ同じ数まで開いてある（数で手の違いは見えない）。違いは行き先に出る。
 * 修正（reader-8）: 10 の手のカードで同じ文だったので、今日のカードで 1 回だけ言う
 */
function evenSentence(c: Ctx, d: number): string {
  const { map } = c;
  const fs = kidsOf(map, d)
    .filter((x) => map.role(x) === "a" && !map.stub(x))
    .map((x) => ripple(map, x).forks);
  if (fs.length < 3) return "";
  const lo = Math.min(...fs);
  const hi = Math.max(...fs);
  return hi > 0 && hi - lo <= hi * 0.1 ? `この地図は、今日の ${slot(fs.length)} の手の先をどれも ${slot(n0(lo))}〜${slot(n0(hi))} の分かれ道まで開いたので、手の違いは数より行き先に出る。` : "";
}

function composeRoot(c: Ctx, i: number): Card {
  const { map, cal } = c;
  const r = ripple(map, i);
  // 地図の年月は 0 か月目から（user-17・truth-12）。今日の手の「この手の先」の文と同じ骨組みにしない（道の画面で今日と今日の手は並ぶ）
  const sums = r.sumEnds ? `（うち ${slot(n0(r.sumEnds))} は標準の続きの見積もり）` : "";
  const body = `${cal.ym(map.month(i))}時点の地図。今月を今日として、${cal.ym(cal.horizon)}まで 3 か月ごとに手を 1 つずつ選ぶ（${slot(Math.round((cal.horizon - map.month(i)) / 3))} 回）。今日選べる手は ${slot(map.childCount(i))} 通りで、その先の分かれ道は合わせて ${slot(n0(r.forks))}（判断 ${slot(n0(r.decisions))}・出来事の分かれ ${slot(n0(r.splits))}）、3 年後の行き先は ${slot(n0(r.ends))}${sums}。${evenSentence(c, i)}`;
  return { title: ROOT_TITLE, short: "今日", body, numbers: numbersRow(c, i), todo: [], trace: ["root"] };
}

// ---- 標準の続きの 1 期（まとめた行き先の後の期を、道の画面で 1 行ずつ読めるように。reader-1・SPEC §5.4）

/** 標準の続きの 1 期の文章（題・本文・やること）。まとめた行き先の数は 3 年後の平均なので、この期の数としては言わない */
export interface ContCard {
  /** その期の手を始める月 */
  m: number;
  kind: string;
  title: string;
  body: string;
  todo: Array<{ text: string; cite: string }>;
}

/** 標準の続きの 1 期の手で分かれる物（分かれ目の文に使う。今のままと担当を広げる手は、その 3 か月には分かれない） */
const CONT_METRIC: Readonly<Record<string, string>> = {
  fc_switch: "sal",
  fc_switch2: "sal",
  fc_push: "sal",
  ad_side: "cl",
  ad_more: "cl",
  ind_quit: "ind",
  ad_permside: "permside",
  ad_perm: "perm",
  sd_permpro: "perm",
  sd_grow: "mau",
  sd_ads: "mau",
  sd_retain: "pu",
  sd_pilot: "pilot",
  sd_school: "school",
  ad_portfolio: "portfolio",
  part: "job",
  back_emp: "job",
};

/** 標準の続きの 1 期の分かれ目（その期の手の答えが出る月と、見る物。言い方は期ごとに回す。どれも手のカードの分かれ目と同じ決まった枠） */
function contWatch(c: Ctx, step: MapContStep, k: number): string {
  const metric = CONT_METRIC[step.kind];
  if (!metric) return "";
  const numeric = NUMERIC.has(metric) || metric === "ind";
  const at = c.cal.ym(numeric ? step.m + 3 : eventMonth(c.cal, step.kind, step.m));
  const name = METRIC_NAME[metric] ?? "結果";
  const frames = numeric ? [`見る数は ${at}の${name}。`, `分かれ目は ${at}の${name}。`, `${at}の${name}で道が分かれる。`] : [`答えが出るのは ${at}の${name}。`, `分かれ目は ${at}の${name}。`, `その先は ${at}の${name}しだい。`];
  return frames[k % frames.length]!;
}

/**
 * 1.2（W5・con-10）: まとめた行き先 i の標準の続きの、一番ありそうな流れの月の稼ぎ（万円/月）。地図の続き（cont）は期ごとの手と一番ありそうな出来事
 * だけを持つので、まとめた手を選んだ判断の状態から、その期の出来事を前提の数（C）で足して進める: 給与は 4 月の昇給・昇格・転職・週 4 日・会社員に
 * 戻る・独立、広告運用は顧客が増える・離れる（月額は道で決まる段）・独立の経費、SpellDash は有料会員を判断の時と 3 年後の平均の間で月ごとに
 * まっすぐ伸ばし（Pro を出してから）、学校の席を足す。start はまとめた手の 3 か月の後、at[k] は k 番目の期の終わり。env は k 番目の期の初めの状態
 * （手引きの条件に使う。顧客・届け出の答え・仕事・Pro）。地図に続きの期の数が無いので見積もりの見積もりで、3 年後は中身の平均（行き先の数）と違ってよい
 */
export interface ContMoney {
  start: number;
  at: number[];
  env: Array<{ j: ImpactSt["j"]; pm: ImpactSt["pm"]; pro: 0 | 1; cl: number }>;
}
// 修正（code-5）: 覚えは地図と束ごとに続く道の覚え（c.links）に年収ごとに持つ（ctxOf は呼ぶたびに新しい Ctx を返すので、Ctx では 1 回限りだった）
const CONT_MONEY = new WeakMap<object, Map<number, Map<number, ContMoney | null>>>();
export function contMoney(c: Ctx, i: number): ContMoney | null {
  let byAnnual = CONT_MONEY.get(c.links);
  if (!byAnnual) CONT_MONEY.set(c.links, (byAnnual = new Map()));
  let memo = byAnnual.get(c.annual);
  if (!memo) byAnnual.set(c.annual, (memo = new Map()));
  if (memo.has(i)) return memo.get(i)!;
  const v = contMoneyOf(c, i);
  if (memo.size > 30_000) memo.clear();
  memo.set(i, v);
  return v;
}
function contMoneyOf(c: Ctx, i: number): ContMoney | null {
  const { map, C, cal } = c;
  const cont = map.cont(i);
  if (!cont?.length) return null;
  const a = map.parent(i);
  const d = map.parent(a);
  if (d < 0) return null;
  const s0 = map.st(d);
  const sE = map.st(i);
  const m0 = map.month(a);
  const H = cal.horizon;
  let j = s0.j;
  let pm = s0.pm;
  let sal = s0.sal;
  let pro = s0.pro;
  let cl = s0.cl;
  let ad = map.rr(d)[1] + (j === "i" ? C.overhead : 0);
  let f5 = linkOf(c, d).f5;
  let seats = s0.seats;
  let proFrom = pro ? m0 : -1;
  const pay = (): number => (j === "e" ? sal : j === "p" ? C.partFactor * sal : 0);
  // 有料会員（学校の席を除く。地図の pu は席を含み、席は 1 席の月額で数える）を、判断の時と 3 年後の平均の間で月ごとにまっすぐ伸ばす
  const own0 = s0.pu - s0.seats;
  const ownE = sE.pu - sE.seats;
  const puAt = (m: number): number => Math.max(0, own0 + ((ownE - own0) * (m - m0)) / Math.max(1, H - m0));
  const addClient = (): void => {
    ad += newFeeOf(C, j, f5);
    cl += 1;
    if (Math.round(cl) >= C.raiseAt) f5 = true;
  };
  const apply = (kind: string, ev: string | undefined, m: number): void => {
    if (j !== "i" && cal.aprils.some((q) => q > m && q <= m + 3)) sal *= 1 + C.aprilRaise;
    switch (ev) {
      case "SWITCH_HIGH":
      case "SWITCH_MID":
        sal *= ev === "SWITCH_HIGH" ? C.switchHigh : C.switchMid;
        // 移った会社の届け出の答え: 全部可・SpellDash だけ可は引き継ぎ、まだ・不可は『まだ』（生成の carriedPm と同じ。facts-1）
        if (pm !== "a" && pm !== "s") pm = "?";
        break;
      case "PROMO":
        sal += C.step * (1 + C.aprilRaise);
        break;
      case "PART_ON":
        j = "p";
        break;
      case "BACK_EMP":
        j = "e";
        sal = C.backSal * (cal.aprils.includes(m + 3) ? 1 + C.aprilRaise : 1);
        // 会社員に戻る先は SpellDash だけ可の会社（生成の back_emp と同じ。facts-1）
        pm = "s";
        ad = 0;
        cl = 0;
        f5 = false;
        break;
      case "IND_START":
        j = "i";
        break;
      case "FIRST_CLIENT":
      case "CLIENT_UP":
      case "CLIENT_REGAIN":
        addClient();
        break;
      case "CLIENT_LOST":
        if (cl >= 0.5) {
          ad -= cl > 0 ? ad / cl : 0;
          cl -= 1;
        }
        break;
      case "PERM_A":
      case "PERM_S":
        pm = ev === "PERM_A" ? "a" : "s";
        if (!pro) (pro = 1), (proFrom = m + 1);
        break;
      case "PERM_N":
        pm = "n";
        break;
      case "PRO_START":
      case "PU_MILE":
        // 有料会員の節目は Pro を出している道（地図の続きが Pro の受付の期を言わないこともある）
        if (!pro) (pro = 1), (proFrom = m + 1);
        break;
      case "SCHOOL_ON":
        seats += C.schoolSeats;
        break;
    }
    void kind;
  };
  const monthly = (m: number): number => {
    // 計算の芯と同じ足し方: 有料会員の手取り − サーバー代（いつも）＋ 学校の席
    const sd = (pro && m >= proFrom ? puAt(m) * C.net : 0) + (seats * C.seatYen) / 10_000 - C.infra;
    return (c.annual / 12) * pay() + ad - (j === "i" ? C.overhead : 0) + sd;
  };
  // まとめた手の 3 か月: その結果の出来事（地図の続きに無い）
  const kind0 = map.kind(a) ?? "";
  const id = map.outId(i);
  const ln = map.ln(i);
  const stubEv = STUB_EV[`${kind0}.${id}`] ?? (kind0 === "ind_quit" ? "IND_START" : undefined);
  apply(kind0, stubEv, m0);
  if (stubEv === "PERM_A" && id === "a1") addClient();
  if (ln && ln[0] === "cl" && typeof ln[2] === "number") {
    const want = ln[3] === null || ln[3] === undefined ? ln[2] : (ln[2] + ln[3]) / 2;
    while (Math.round(cl) < Math.round(want)) addClient();
  }
  const env: ContMoney["env"] = [];
  const at: number[] = [];
  const start = monthly(m0 + 3);
  for (const st of cont) {
    env.push({ j, pm, pro, cl });
    apply(st.kind, st.ev, st.m);
    at.push(monthly(st.m + 3));
  }
  return { start, at, env };
}
/** まとめた手の 3 か月の結果の出来事（手の種類.結果の番号） */
const STUB_EV: Readonly<Record<string, string>> = {
  "fc_switch.high": "SWITCH_HIGH",
  "fc_switch.mid": "SWITCH_MID",
  "fc_switch2.high": "SWITCH_HIGH",
  "fc_switch2.mid": "SWITCH_MID",
  "fc_push.up": "PROMO",
  "part.p": "PART_ON",
  "back_emp.e": "BACK_EMP",
  "ad_permside.a1": "PERM_A",
  "ad_permside.a0": "PERM_A",
  "ad_permside.a": "PERM_A",
  "ad_permside.s": "PERM_S",
  "ad_permside.n": "PERM_N",
  "ad_perm.a": "PERM_A",
  "ad_perm.s": "PERM_S",
  "ad_perm.n": "PERM_N",
  "sd_permpro.a": "PERM_A",
  "sd_permpro.s": "PERM_S",
  "sd_permpro.n": "PERM_N",
  "sd_school.yes": "SCHOOL_ON",
};

/**
 * まとめた行き先 i の標準の続き（cont）の k 番目の期。その期の手の種類の書き出し・手引きの文 3 つまで（道とそれまでの期で使っていない歩み）・
 * その期の分かれ目（答えが出る月と見る物）・一番ありそうな出来事・やること 3 つを書く。手引きの条件は、まとめた手を選んだ判断の状態で見る
 * （続きの期の状態は地図に無い）。「この期の分かれ道は開いていない」は道の画面の見積もりの印の行に 1 回だけ出す（行ごとに繰り返さない。reader-7）
 */
export function composeContMarked(c: Ctx, i: number, k: number): ContCard | null {
  if (!Number.isInteger(k) || k < 0) return null;
  return contRowsOf(c, i)[k] ?? null;
}

/**
 * 修正（code-5）: まとめた行き先の標準の続きの期の文章を全部、地図と束ごとの道の覚え（c.links）に年収と計算の芯ごとに覚える（道の画面が期を
 * 1 行ずつ開いても、0 番目から作り直さない）
 */
const CONT_ROWS = new WeakMap<object, { annual: number; rt: Ctx["rt"]; m: Map<number, readonly ContCard[]> }>();
function contRowsOf(c: Ctx, i: number): readonly ContCard[] {
  let e = CONT_ROWS.get(c.links);
  if (!e || e.annual !== c.annual || e.rt !== c.rt) CONT_ROWS.set(c.links, (e = { annual: c.annual, rt: c.rt, m: new Map() }));
  const hit = e.m.get(i);
  if (hit) return hit;
  const rows = contCardsMarked(c, i);
  if (e.m.size > 20_000) e.m.clear();
  e.m.set(i, rows);
  return rows;
}

/** 顧客が増える出来事（標準の続きの期の一番ありそうな出来事） */
const CLIENT_GAIN: ReadonlySet<string> = new Set(["FIRST_CLIENT", "CLIENT_UP", "CLIENT_REGAIN"]);

/** 修正（facts-9）: 月の稼ぎの万円（負の数は「−」。差し込みの印の外に置く。点検の構造の文の −?# と同じ） */
const monMan = (x: number): string => (x <= -0.05 ? `${MINUS}${slot(man(-x))}` : slot(man(x)));

/** 1.2（W5・con-10）: 月の稼ぎの 3 か月前との違い（0.05 万円より小さければ「ほぼ同じ」） */
function monDiff(dv: number): string {
  if (Math.abs(dv) < 0.05) return "3 か月前とほぼ同じ";
  return `3 か月前より ${slot(man(Math.abs(dv)))} 万円${dv > 0 ? "多い" : "少ない"}`;
}

/** 手引きを使い切っても時間の使い方の歩み（_generic）で埋めてよい種類（今のままと、SpellDash の時間の中の手） */
const CONT_GENERIC = new Set(["keep", "sd_grow", "sd_ads", "sd_retain"]);

/**
 * まとめた行き先 i の標準の続きの期の文章を、0 番目から upto 番目まで（省けば全部）。まとめた行き先でなければ空。
 * 1.2（W5・con-10・rep-13）: 「標準の選び方」は最初の期で 1 回だけ言い、期ごとに、その期の手・手引きの文 2 つ・分かれ目・一番ありそうな出来事・
 * その手の前提の見込み（束の contOdds）・一番ありそうな流れでの期の終わりの月の稼ぎとその動き（contMoney）を言う。最後の期は、その流れの 3 年後の
 * 月の稼ぎと、行き先の平均（中身の道の平均。行き先のカードの数）を並べる。「大きな出来事の無い 3 か月」は言わない。手引きの条件は、その期の初めの
 * 状態（それまでの期の出来事で進めた顧客・届け出の答え・仕事・Pro）で見て、手引きを使い切ったら近い種類の手引きから取る（時間の使い方の歩みは
 * 今のままと SpellDash の手だけ）
 */
export function contCardsMarked(c: Ctx, i: number, upto = Infinity): ContCard[] {
  const { map, B, cal } = c;
  if (map.role(i) !== "e" || !map.sum(i)) return [];
  const cont = map.cont(i) ?? [];
  const last = Math.min(cont.length - 1, upto);
  if (last < 0) return [];
  const stub = map.parent(i);
  const d = map.parent(stub);
  const link = linkOf(c, d);
  const used = new Set(usedSet(link));
  for (const st of stepsFor(c, stub, countKind(link, map.kind(stub) ?? ""), used, recentSteps(link), pathEnv(c, link))) used.add(st.id);
  const s0 = map.st(d);
  const { env: env0, slots: slots0 } = baseEnv(c, d);
  const cband = env0.cband === 1;
  const money = contMoney(c, i);
  const out: ContCard[] = [];
  for (let x = 0; x <= last; x++) {
    const step = cont[x]!;
    const now = money?.env[x];
    const nOnPath = countKind(link, step.kind) + (map.kind(stub) === step.kind ? 1 : 0);
    const env: Env = { ...env0, n: nOnPath + cont.slice(0, x).filter((y) => y.kind === step.kind).length, m: step.m, mon: cal.parts(step.m)[1], first: 0 };
    if (now) Object.assign(env, { j: now.j, pm: now.pm, pro: now.pro, cl: now.cl, clr: clr(now.cl), cap: capOf(c.C, now.j) });
    const picked: Step[] = [];
    const take = (one: Step): void => {
      if (picked.length < 3 && !used.has(one.id) && !picked.some((y) => y.id === one.id) && cond(one.if, env, s0.fl)) picked.push(one);
    };
    for (const one of B.playbook[step.kind] ?? []) take(one);
    for (const fk of FAMILY[step.kind] ?? []) for (const one of B.playbook[fk] ?? []) take(one);
    if (CONT_GENERIC.has(step.kind) || !picked.length) for (const one of B.playbook._generic ?? []) take(one);
    for (const one of picked) used.add(one.id);
    const noun = B.contNoun[step.kind] ?? kindNoun(c, step.kind);
    const period = cal.period(step.m);
    const ev = step.ev ? (cband && step.ev === "FIRST_CLIENT" ? "顧客が決まる" : (CONT_EV[step.ev] ?? fill(B.eventShort[step.ev] ?? "", {}))) : null;
    // 1b・W3（L2）: 期ごとの決まった枠（見出し・出来事・月の稼ぎ）は、期の並び（x）で 3 つの言い方を回す（まとめた行き先の後に 10 期並ぶ道でも、
    //   1 つの枠が道で 4 回まで）
    const head =
      x === 0
        ? `${period}からは標準の選び方で続け、どの期も一番ありそうな結果で進めた見積もり。最初の 3 か月は『${noun}』。`
        : [`${period}は『${noun}』の 3 か月。`, `続く ${period}は『${noun}』。`, `${period}の手は『${noun}』。`][x % 3]!;
    const what = ev ? [`この期に一番ありそうな出来事は『${ev}』。`, `一番ありそうな出来事は『${ev}』とみる。`, `この期は『${ev}』が一番ありそうな出来事。`][x % 3]! : "";
    const slots: Slots = { ...slots0, ymApril: cal.ym(eventMonth(cal, step.kind, step.m)) };
    // 修正（facts-1・facts-2）: 前提の見込みは、その期の初めの状態（届け出の答え・仕事・顧客）で選び、差し込む（転職は今の答えを認める会社の割合を
    //   掛けた見込み、紹介は仕事ごとの来る数から 3 か月で 1 社以上の見込み）
    const pmNow = now?.pm ?? s0.pm;
    const jNow = now?.j ?? s0.j;
    const f = pmNow === "a" ? c.C.permA : pmNow === "s" ? c.C.permA + c.C.permS : 1;
    slots.swAx = wari(c.C.switchP1 * f);
    slots.swBx = wari(c.C.switchP2 * f);
    slots.moreP = wari(1 - Math.exp(-3 * (jNow === "i" ? c.C.lamInd : jNow === "p" ? c.C.lamPart : c.C.lamEmp)));
    slots.jobName = jNow === "i" ? "独立" : jNow === "p" ? "週 4 日勤務" : "会社員";
    let odds = B.contOdds?.[step.kind] ? (choose(B.contOdds[step.kind], env, s0.fl, slots, x, [], `contOdds.${step.kind}`) ?? "") : "";
    // 修正（reader-6）: 顧客探しの期で、この流れ（一番ありそうな結果）では顧客が増えないとき、その訳（上限・顧客がいない紹介・この期は決まらない）を言う
    if ((step.kind === "ad_side" || step.kind === "ad_more") && !(step.ev && CLIENT_GAIN.has(step.ev)) && !(step.kind === "ad_more" && env.clr === 0)) {
      const cap = capOf(c.C, jNow);
      const full = clr(now?.cl ?? s0.cl) >= cap;
      odds += full
        ? [`顧客は上限の ${slot(cap)} 社に届いているので、この流れでは増えない。`, `この流れでは顧客が持てる ${slot(cap)} 社に届いていて、この期には増えない。`, `持てる ${slot(cap)} 社に届いた後なので、この流れの顧客は増えない。`][x % 3]!
        : [`この流れでは、この期に顧客は増えないとみる。`, `一番ありそうな流れでは、この期の顧客探しは決まらない。`, `この流れの顧客は、この期には増えない見積もり。`][x % 3]!;
    }
    let mon = "";
    const last = x === cont.length - 1;
    if (money) {
      const v = money.at[x]!;
      const prev = x ? money.at[x - 1]! : money.start;
      const ym = cal.ym(step.m + 3);
      const mv = `${monMan(v)} 万円`;
      const df = monDiff(v - prev);
      if (last) {
        // 修正（reader-10）: 最後の期は、その期の終わりの月の稼ぎと行き先の平均を 1 文で（同じ数を 2 回言わない）
        const rr = map.rr(i);
        const avg = (c.annual / 12) * rr[0] + rr[1] + rr[2];
        const at3 = step.m + 3 === cal.horizon ? `${ym}（3 年後）` : ym;
        mon = `この流れで ${at3}の月の稼ぎは ${mv}ほど（${df}）で、ほかの結果の道も入れた 3 年後の平均は月 ${monMan(avg)} 万円（行き先のカードの数はこの平均）。`;
      } else mon = [`この流れで ${ym}の月の稼ぎは ${mv}ほど（${df}）。`, `${ym}の月の稼ぎは、この流れでは ${mv}ほど（${df}）。`, `見積もりの流れでは、${ym}に月 ${mv}ほどを稼ぐ（${df}）。`][x % 3]!;
      if (x === 0) mon = `${cal.ym(step.m)}の月の稼ぎ ${monMan(money.start)} 万円から始める。${mon}`;
    }
    const body = join([head, ...picked.slice(0, 2).map((st) => pbText(st.act)), contWatch(c, step, x), what, odds, mon]);
    out.push({ m: step.m, kind: step.kind, title: contName(c, step.kind, step.ev, step.m, cband), body, todo: picked.map((st) => ({ text: st.todo, cite: st.id })) });
  }
  return out;
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
