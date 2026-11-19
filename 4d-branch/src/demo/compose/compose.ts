// 文章の組み立て: 地図（MapData）の 1 枚のカードの題・短い名前・本文・数の行・やることを、文の型の束（Banks）と道の数から作る
// 設計: 作業メモ SPEC v1 §4.1〜§4.3。元: 試作（R2）の compose.ts。SPEC §4.2 で変えた所は、その所に書く
// 決まった関数: 同じ地図・番号・年収・束なら、いつ・どの順で組み立てても同じ文になる。数はどれもデータから取り、差し込みの印で包む
// 数の行（SPEC §4.2・user-9b）: 年収・広告運用・有料・遊ぶ人・週の時間は数の行に出し、今日・状態・行き先の本文には書かない
// 道で 1 回だけ（SPEC §4.2・C9）: 暦の文（確定申告はその年分ごとに）・辞める前の文・静かな期の一言・出来事の助言・避けたい訳は、
//   道（今日からそのカードまで）の上で組ごとに 1 回だけ。どれを使ったかは判断の覚え（Link）ごとの「段取り」（Plan）に残し、道だけで決まる
// 手: 来た訳 → 書き出し → 手引きの文 → お金と仕事の変わり方 → 避けたい訳 → 分かれ目 → この手の先の数（今日の手）→ まとめた手の注
// 状態: 年月と出来事 → 出来事の助言 → 節目からの月（節目が変わったときだけ）→ 静かな期の一言 → 同じ手の別の結果との違い → 次の問い → 暦
// 行き先: 年月と仕事 → まとめた行き先の注 → 節目 → 月の稼ぎ → この先の見通し（まとめた行き先は、標準の続きの目安）
import type { MapContStep, MapData, MapMix } from "../../deepmap/mapData";
import type { ImpactSt, R3 } from "../impact";
import { capOf, countEvent, countKind, endLink, eventsList, jobMonths, linkFor, linkOf, recentSteps, ripple, sideIn, stepsFor, usedSet, type Ctx, type Ev, type Link, type TitleEntry } from "./path";
import { clPhrase, clr, cond, f2, hash, man, n0, pbText, slot, spaceJa, strip, yenTxt, type Env } from "./text";
import type { Card, Variant } from "./types";

type Slots = Record<string, string>;

const MINUS = "−";
const sgn = (x: number): string => (x >= 0 ? "+" : MINUS);
const len = (s: string): number => [...strip(s)].length;

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

/** 手の種類の名詞（「前の 3 か月は〜」）。束に無ければ地図の手の名前、それも無ければ言い換え */
const kindNoun = (c: Ctx, kind: string): string => c.B.nextNoun[kind] ?? c.map.header.kinds[kind]?.[0] ?? "別の手";
/** 手の種類の短い名前 */
const kindShort = (c: Ctx, kind: string): string => c.B.short[kind] ?? c.map.header.kinds[kind]?.[0] ?? "別の手";

/** 結果の名前の言い換え（地図の名前が無い・英数字のときだけ使う） */
const OUT_NAMES: Record<string, string> = { all: "どの場合も", a: "全部可", a0_a1: "全部可", a1: "全部可・1 社目", a0: "全部可・まだ", s: "SpellDash だけ", n: "どちらも不可", high: "大きく上げて転職", mid: "少し上げて転職", high_mid: "上げて転職", none: "転職せず", up: "昇格", same: "据え置き", yes: "決まった", no: "決まらず", p: "週 4 日に", e: "会社員に戻る", i: "独立のまま" };
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
  return b[0] === b[1] ? `${slot(b[0])} 社` : `${slot(b[0])}〜${slot(b[1])} 社`;
}

function baseEnv(c: Ctx, n: number): { env: Env; slots: Slots } {
  const { map, C, B, cal } = c;
  const s = map.st(n);
  const rr = rrOf(c, n);
  const cap = capOf(C, s.j);
  const m = map.month(n);
  const kind = map.kind(n);
  const env: Env = { j: s.j, pm: s.pm, pro: s.pro, cl: s.cl, clr: clr(s.cl), pu: s.pu, mau: s.mau, sal: s.sal, seats: s.seats, cap, m, mon: cal.parts(m)[1], n: kind ? countKind(linkFor(c, n), kind) : 0, first: m === 0 ? 1 : 0, h: 0 };
  const slots: Slots = {
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
    stepYen: `${slot(n0(c.annual * C.step))} 万円`,
    seats: slot(n0(s.seats)),
    seatYen: slot(C.seatYen),
    schoolSeats: slot(C.schoolSeats),
    partx: slot(`${C.partFactor}`),
  };
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

// ---- 道で 1 回だけの文の段取り（判断の覚えごと。道だけで決まり、年収では変わらない）

interface CalPick {
  code: string;
  key: string;
  year: number;
  back: boolean;
}

interface Plan {
  /** この状態（とそこへ来た手）が使った、道で 1 回だけの文の鍵 */
  readonly keys: readonly string[];
  readonly cal: CalPick | null;
  readonly hint: number | null;
  readonly tips: ReadonlyArray<readonly [string, number]>;
  /** 節目の鍵（節目からの月の文。親の状態と違うときだけ書く） */
  readonly sinceKey: string | null;
  /** 同じ手の別の結果との違いで、届け出の答えの範囲を言うか（答えごとに道で 1 回だけ） */
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
    const g = freeGroup(B.tip[e.code], env, fl, { ...slots, ...evSlots(c, e, map.month(n)) }, (gi) => `tip.${e.code}#${gi}`, used);
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
  // 届け出の答えの範囲の一言（「この場合は Pro は出せるが、広告運用はできない」）は、答えごとに道で 1 回だけ
  const pk = permKey(c, n);
  const perm = pk !== null && !used(pk);
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
  const out: string[] = [];
  out.push(salaryItem(c, s, rr[0], ""));
  out.push(s.cl >= 0.05 ? `広告運用 ${bandClients(c, at) ?? clPhrase(s.cl, map.ln(at))}（売上 月 ${slot(man(s.cl * s.fee))} 万円）` : "広告運用の顧客なし");
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

/** 有料の項目（学校の席は有料の人数に入っている。truth-5） */
function proItem(c: Ctx, s: ImpactSt, rr2: number, avg: string): string {
  if (!s.pro) return "Pro はまだ出していない";
  const seats = s.seats >= 0.5 && s.seats % c.C.schoolSeats === 0 ? `うち学校の席 ${slot(n0(s.seats))}・` : "";
  return `有料 ${avg}${slot(n0(s.pu))} 人（${seats}手数料とサーバー代を引いて月 ${yenTxt(rr2)}${rr2 < 0 ? "の持ち出し" : ""}）`;
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

const SURE = 0.9;
const RARE = 0.1;

function mixNumbers(c: Ctx, mix: MapMix): string[] {
  const out: string[] = [];
  const emp = mix.j.e + mix.j.p;
  if (mix.j.i >= SURE) out.push("給与なし（独立）");
  else out.push(`年収 ${range(c.annual * mix.sal[0], c.annual * mix.sal[2], "万円")}${emp >= SURE ? "" : "（会社員の道）"}`);
  const clLo = Math.round(mix.cl[0]);
  const clHi = Math.round(mix.cl[2]);
  out.push(clHi <= 0 ? "広告運用の顧客なし" : `広告運用 ${range(clLo, clHi, "社")}`);
  out.push(mix.pro <= RARE ? "Pro はまだ出していない" : `有料 ${range(mix.pu[0], mix.pu[2], "人")}`);
  out.push(`月に遊んだ人 ${range(mix.mau[0], mix.mau[2], "人")}`);
  return out;
}

// ---- 題（SPEC §4.2・gaps-11: 兄弟で違う。結果は分かれた数の名前を言う）

/** 結果の線の測る物ごとの、その分かれを言う出来事 */
const METRIC_EVENTS: Record<string, readonly string[]> = {
  perm: ["PERM_A", "PERM_S", "PERM_N"],
  permside: ["PERM_A", "PERM_S", "PERM_N"],
  sal: ["SWITCH_HIGH", "SWITCH_MID", "SEARCH_NONE", "PROMO", "PROMO_NO"],
  job: ["PART_ON", "PART_NO", "BACK_EMP", "BACK_NO"],
  pilot: ["PILOT_ON", "PILOT_NO"],
  school: ["SCHOOL_ON", "SCHOOL_NO"],
  portfolio: ["PORTFOLIO_ON", "PORTFOLIO_NO"],
  cl: ["FIRST_CLIENT", "CLIENT_UP", "CLIENT_REGAIN", "CLIENT_LOST", "CLIENT_NOT_FOUND", "BACK_NO"],
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
  return [`${endPrefix(c, x)}${labelOf(c, x)}`, []];
}

/** 手の題（種類と状態。同じ種類の 2 回目からは手引きの歩みの題） */
function moveTitle(c: Ctx, a: number, trace: string[]): string {
  const { map, B } = c;
  const kind = map.kind(a) ?? "";
  const m = moveCtx(c, a);
  return choose(B.title[kind], m.env, map.st(a).fl, m.slots, m.seed, trace, `title.${kind}`) || kindShort(c, kind);
}

/** 状態の題: 分かれた数の出来事を先に。題が分かれた数を言わなければ、その数を足す */
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
    title = choose(B.eventTitle[cell], env, map.st(n).fl, { ...slots, ...evSlots(c, top, map.month(n)) }, hash(map.key(n)), trace, `eventTitle.${cell}`) ?? "";
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

/** 行き先の題: 分かれた数を先に、大きい事実を 2 つまで */
function endTitle(c: Ctx, n: number): string {
  const { map } = c;
  const s = map.st(n);
  const facts: string[] = [];
  const metric = splitMetric(c, n);
  if (metric && map.sum(n)) {
    // まとめた行き先は、分かれた結果（その 3 か月の結果）の名前で言う。3 年後の数は平均なので、結果の幅に合わせた 1 本の道の数として題に書かない（truth-5）
    const pre = endPrefix(c, n);
    const lab = labelOf(c, n);
    // 長い名前（まとめた結果「少し上げて転職・大きく上げて転職」など）は、結果の短い名前で
    const short = OUT_NAMES[map.outId(n)];
    const cands = [`${pre}『${lab}』の後`, `${pre}${lab}の後`, ...(short ? [`${pre}${slot(short)}の後`] : [])];
    for (const t of cands) if (len(t) <= TITLE_MAX.e) return t;
    return `${pre}${lab}`;
  }
  if (metric) facts.push(metricFact(c, n, metric));
  const mix = map.mix(n);
  if (map.sum(n) && mix) {
    // 幅で言う（9 割がそろう事実だけを言い切る）
    if (mix.j.i >= SURE) facts.push("独立");
    if (mix.switched >= SURE) facts.push("転職");
    const clHi = Math.round(mix.cl[2]);
    if (clHi >= 1 && mix.j.i < SURE) facts.push(`副業 ${range(mix.cl[0], mix.cl[2], "社")}`);
    if (mix.pro > RARE) facts.push(`有料 ${range(mix.pu[0], mix.pu[2], "人")}`);
    if (!facts.length) {
      // 大きな事実が無ければ遊ぶ人の幅。題に収まらなければ年収の幅か、遊ぶ人の真ん中の数
      const pre = endPrefix(c, n);
      const cands = [`月に遊ぶ人 ${range(mix.mau[0], mix.mau[2], "人")}`, ...(mix.j.i < SURE ? [`年収 ${range(c.annual * mix.sal[0], c.annual * mix.sal[2], "万円")}`] : []), `月に遊ぶ人 ${slot(n0(mix.mau[1]))} 人ほど`];
      facts.push(cands.find((t) => len(`${pre}${t}`) <= TITLE_MAX.e) ?? cands[cands.length - 1]!);
    }
  } else {
    const avg = map.sum(n);
    if (s.j === "i") facts.push(`独立・顧客 ${avg ? avgClients(s.cl) : (bandClients(c, n) ?? clPhrase(s.cl))}`);
    else if (s.fl.includes("switched")) facts.push(`転職で給与 ${slot(f2(s.sal))} 倍`);
    else if (s.j === "p") facts.push("週 4 日勤務");
    if (s.j !== "i" && s.cl >= 0.5) facts.push(`副業 ${avg ? avgClients(s.cl) : (bandClients(c, n) ?? clPhrase(s.cl))}`);
    if ((s.pro || avg) && s.pu >= 1) facts.push(`有料 ${slot(n0(s.pu))} 人`);
    if (!facts.length) facts.push(s.pm === "n" && !avg ? "副業は不可のまま" : `給与 ${slot(f2(s.sal))} 倍`);
  }
  const uniq = facts.filter((f, k) => facts.indexOf(f) === k);
  const pre = endPrefix(c, n);
  const two = `${pre}${uniq.slice(0, 2).join("と")}`;
  return len(two) <= TITLE_MAX.e ? two : `${pre}${uniq[0]}`;
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
  const v = c.B.nextPhrase[kind] ?? [`${kindNoun(c, kind)}を選ぶか`];
  return v[hash(c.map.key(a)) % v.length]!;
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

/** 手を組み立てる値（題と本文で同じ物） */
function moveCtx(c: Ctx, a: number): { env: Env; slots: Slots; seed: number; nth: number; link: Link; steps: ReturnType<typeof stepsFor>; fresh: ReturnType<typeof stepsFor> } {
  const { map, C } = c;
  const d = map.parent(a);
  const link = linkOf(c, d);
  const kind = map.kind(a) ?? "";
  const nth = countKind(link, kind);
  const { env, slots } = baseEnv(c, a);
  const h = map.hours(a);
  env.n = nth;
  env.h = h;
  const used = usedSet(link);
  const steps = stepsFor(c, a, nth, used, recentSteps(link));
  const fresh = steps.filter((st) => !used.has(st.id));
  // 種: 道の最初の手と種類（同じ種類が続く 3 か月ごとに、書き出しが回る）
  const firstKey = map.key(link.first >= 0 ? link.first : a);
  const seed = hash(`${firstKey}|${kind}`) + nth;
  // 転職の手: 移った結果のデータで、届け出の言い方を決める（今の範囲を持っていける carry・出し直す refile。truth-11）
  if (kind === "fc_switch" || kind === "fc_switch2") {
    const s0 = map.st(a);
    const moved = kidsOf(map, a).filter((o) => /^(high|mid|high_mid)$/.test(map.outId(o))).map((o) => map.st(o));
    env.carry = moved.length && moved.every((s) => s.pm === s0.pm && (s0.pm === "a" || s0.pm === "s")) ? 1 : 0;
    env.refile = moved.some((s) => s.pm === "?" && s0.pm !== "?") ? 1 : 0;
  }
  const s2: Slots = { ...slots, ...moveDates(c, a), nth: slot(nth + 1), act1: pbText(fresh[0]?.act ?? ""), act2: pbText(fresh[1]?.act ?? ""), stepTitle: pbText(fresh[0]?.title ?? ""), hSigned: `${h >= 0 ? "+" : MINUS}${slot(Math.abs(h))}`, H: slot(C.baseHours + h) };
  return { env, slots: s2, seed, nth, link, steps, fresh };
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

/** 分かれ目: 次の分かれ道がいつ・何で分かれ、それぞれ何を意味するか */
function watchSentence(c: Ctx, a: number, slots: Slots, nth: number, trace: string[]): string {
  const { map, B, cal } = c;
  const ks = kidsOf(map, a);
  if (!ks.length) return "";
  const m = map.month(a);
  const kind = map.kind(a) ?? "";
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
    const parts: string[] = [];
    if (Math.abs(b.mau - s0.mau) >= 1) parts.push(`月に遊ぶ人は ${slot(n0(s0.mau))} 人から ${slot(n0(b.mau))} 人`);
    if (b.pro && Math.round(b.pu) !== Math.round(s0.pu)) parts.push(`有料会員は ${slot(n0(s0.pu))} 人から ${slot(n0(b.pu))} 人`);
    if (clr(b.cl) !== clr(s0.cl)) parts.push(`顧客は ${bandClients(c, o) ?? clPhrase(b.cl)}`);
    if (Math.abs(b.sal - s0.sal) >= 0.005 && b.j !== "i") parts.push(`給与は今日の ${slot(f2(b.sal))} 倍`);
    if (!parts.length) return `${at}まで、数字はほぼ今のまま。`;
    trace.push("watch:single");
    // 同じ手が続くときに同じ骨組みにしない（道で何回目かで回す）
    const frames = [`${at}の見込みは、${parts.join("、")}ほど。`, `${at}には、${parts.join("、")}ほどになる見込み。`, `この 3 か月で、${parts.join("、")}ほどまで動く見込み。`];
    return frames[(hash(kind) + nth) % frames.length]!;
  }
  const metric = map.ln(ks[0]!)?.[0] ?? "";
  const factAt = metric === "perm" || metric === "permside" ? m + 1 : m + 3;
  const mName = METRIC_NAME[metric] ?? "結果";
  const at = cal.ym(factAt);
  const heads = [`分かれ目は ${at}の${mName}。`, `${at}の${mName}で道が分かれる。`, `見る数は ${at}の${mName}。`, `その先は ${at}の${mName}しだい。`, `この手の答えは ${at}の${mName}で出る。`];
  // 道の上で同じ数で分かれたのが何回目かで言い方を回す（転職活動・昇格のように同じ数で何度も分かれる道で、同じ書き出しを続けない）
  let seen = 0;
  for (let l: Link | null = linkOf(c, map.parent(a)); l; l = l.up) if (map.role(l.i) === "s" && map.ln(l.i)?.[0] === metric) seen++;
  const head = heads[(hash(metric) + seen) % heads.length]!;
  if (metric === "cl" || metric === "pu" || metric === "mau") {
    // 数で分かれる: 結果の名前と、その数を 1 行で（まとめた行き先の数は 3 年後の見積もりなので、その年月を付ける）
    const num = (o: number): string => {
      const s = map.st(o);
      const t = metric === "cl" ? (s.cl * s.fee < 0.05 ? "広告運用の売上はまだ無い" : `売上 月 ${slot(man(s.cl * s.fee))} 万円ほど`) : metric === "pu" ? `有料 ${slot(n0(s.pu))} 人ほど` : `月に遊ぶ人 ${slot(n0(s.mau))} 人ほど`;
      return map.sum(o) ? `${cal.ym(map.month(o))}に平均で${t}` : t;
    };
    trace.push("watch:num");
    return `${head}${ks.map((o) => `『${labelOf(c, o)}』なら${num(o)}`).join("、")}。`;
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
    env.pm0 = s0.pm;
    env.clr0 = clr(s0.cl);
    const next = kidsOf(map, o).find((x) => map.kind(x) !== "keep");
    const nextKind = next === undefined ? null : (map.kind(next) ?? "");
    // 結果の数で埋め、年月だけは手の物を使う
    const s3: Slots = { ...slots, ...s2, lab: labelOf(c, o), next1: nextKind === null ? "今のまま" : kindNoun(c, nextKind) };
    for (const k of DATE_SLOTS) {
      const v = slots[k];
      if (v === undefined) delete s3[k];
      else s3[k] = v;
    }
    const fl = map.st(o).fl;
    // 同じ種類の手が道で続くときは、何回目かで言い換えを回す
    const seed = hash(`${kind}|${cls}`) + nth;
    const cell = bank[cls] ? cls : "_any";
    const meaning = choose(bank[cell], env, fl, s3, seed, trace, `branch.${bankKind}.${cell}`) ?? choose(B.branch._generic?._any, env, fl, s3, seed, trace, "branch._generic._any");
    pieces.push(`『${labelOf(c, o)}』なら${meaning ?? ""}`);
  }
  return head + pieces.join("。") + "。";
}
const DATE_SLOTS = ["ym", "period", "ymNext", "ym1", "ym2"] as const;

/** この手の先の数（今日の手）。SPEC §5.1・truth-18: 判断と出来事の分かれを分け、まとめた行き先は見積もりと書く */
function rippleSentence(c: Ctx, a: number): string {
  const { map, cal } = c;
  const r = ripple(map, a);
  const ks = kidsOf(map, a);
  const per = ks.length >= 2 ? `${ks.map((o) => `${labelOf(c, o)}の後 ${slot(n0(ripple(map, o).forks))}`).join("・")}。` : "";
  const sums = r.sumEnds ? `で、うち ${slot(n0(r.sumEnds))} は標準の続きの見積もり` : "";
  return `この手の先、${cal.ym(cal.horizon)}までの分かれ道は ${slot(n0(r.forks))}（判断 ${slot(n0(r.decisions))}・出来事の分かれ ${slot(n0(r.splits))}）。${per}行き先は ${slot(n0(r.ends))}${sums}。`;
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

/** 手のカード。書き出し・分かれ目は、道でその種類の手が何回目か（nth）で言い換えを回す */
function composeMove(c: Ctx, a: number): Card {
  const { map, B } = c;
  const trace: string[] = [];
  const d = map.parent(a);
  const kind = map.kind(a) ?? "";
  const { env, slots: s2, seed, nth, link, steps, fresh } = moveCtx(c, a);
  const fl = map.st(a).fl;
  const title = titleOf(c, a, trace);
  const lead = choose(B.lead[kind], env, fl, s2, seed, trace, `lead.${kind}`) ?? "";
  // 長い節がある手（今日の手の先の数・避けたい訳）は、手引きの文を 1 つだけにする。本文に入れるのは、道で初めて使う歩みの文だけ
  const oneAct = map.role(d) === "r" || map.why(a) === "avoid";
  const acts = !oneAct && fresh.length >= 2 ? pbText(fresh[0]!.act) + pbText(fresh[1]!.act) : pbText(fresh[0]?.act ?? "");
  // お金と仕事が変わる手だけ、その中身（週の時間は数の行。SPEC §4.2）
  const cost = B.cost[kind] ? (choose(B.cost[kind], env, fl, s2, seed, trace, `cost.${kind}`) ?? "") : "";
  const watch = watchSentence(c, a, s2, nth, trace);
  const ripple1 = map.role(d) === "r" ? rippleSentence(c, a) : "";
  if (ripple1) trace.push("ripple");
  // 避けたい訳（道で 1 回だけ。その先の状態の段取りと同じ答え）
  let avoid = "";
  if (avoidAllowed(c, a, link)) {
    const av = avoidSlots(c, a);
    avoid = choose(B.avoid[kind], { ...env, needOk: av.needOk ? 1 : 0 }, fl, { ...s2, ...av }, seed, trace, `avoid.${kind}`) ?? "";
  }
  // まとめた手の注（truth-2: 先は一番良い選び方ではなく、標準の選び方で続けた見積もり）
  const stub = map.stub(a) ? "この手の先は分かれ道を省き、その後は標準の選び方で続けた見積もりだけを出す。" : "";
  // ここへ来た訳: 名前の付いた結果（「どの場合も」でない）なら『結果』を受けて、そうでなければ前の 3 か月の手（状態の節目の文とは重ねない）
  const pm = map.parent(d);
  const prevKind = pm >= 0 && map.role(pm) === "a" ? map.kind(pm) : null;
  const came = map.role(d) === "s" && map.outId(d) !== "all" ? `『${labelOf(c, d)}』を受けて、` : prevKind && prevKind !== kind ? `前の 3 か月は${kindNoun(c, prevKind)}。` : "";
  const body = join([came, lead, acts, cost, avoid, watch, ripple1, stub]);
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
  r.slots.dpu = slot(dpu);
  r.slots.pu0 = slot(n0(before.pu));
  return r;
}

/** 節目からの月の文に使う出来事 */
const SINCE_CODES = new Set(["IND_START", "SWITCH_HIGH", "SWITCH_MID", "PERM_A", "PERM_S", "PERM_N", "PART_ON", "PROMO", "FIRST_CLIENT", "SCHOOL_ON", "CLIENT_UP", "PILOT_ON", "PORTFOLIO_ON", "BACK_EMP"]);

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

/** 節目からの月（user-9c: 節目が変わったときだけ書く。同じ種類の節目の 2 回目からは、その言い方で。点検 C6） */
function sinceClause(c: Ctx, link: Link, plan: Plan): string {
  if (!plan.sinceKey || !link.up || plan.sinceKey === planOf(c, link.up).sinceKey) return "";
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

/** 同じ手の別の結果（一番違う物）との違い。言い方は道の上の何期目かで回す。permOk: 答えの範囲の一言を書く（段取りで決めた） */
function contrastSentence(c: Ctx, o: number, permOk: boolean): string {
  const { map } = c;
  const sib = contrastSib(c, o);
  if (sib === null) return "";
  const so = map.st(o);
  const ss = map.st(sib);
  const d: string[] = [];
  let perm = "";
  const dAds = so.cl * so.fee - ss.cl * ss.fee;
  if (Math.abs(dAds) >= 0.5) d.push(`広告運用の売上が月 ${slot(man(Math.abs(dAds)))} 万円${dAds > 0 ? "多い" : "少ない"}`);
  const dPu = Math.round(so.pu) - Math.round(ss.pu);
  if (Math.abs(dPu) >= 1) d.push(`有料会員が ${slot(Math.abs(dPu))} 人${dPu > 0 ? "多い" : "少ない"}`);
  // 給与の差は年収で（truth-15）
  const dSal = c.annual * (map.rr(o)[0] - map.rr(sib)[0]);
  if (Math.abs(dSal) >= 6) d.push(`年収が ${slot(n0(Math.abs(dSal)))} 万円${dSal > 0 ? "高い" : "低い"}`);
  // 届け出の答えの違いは、この結果のことなので別の文にする
  if (permOk && so.pm !== ss.pm && so.pm !== "?" && ss.pm !== "?") perm = so.pm === "a" ? "この場合は広告運用の副業もできる。" : so.pm === "s" ? "この場合は Pro は出せるが、広告運用はできない。" : "この場合は Pro も副業も出せない。";
  const lab = labelOf(c, sib);
  // 言い方は、道でそれまでに別の結果と比べた状態の数で 7 通りを回す（同じ文は 7 回比べた後にしか戻らない。点検 C6）。始まりは今日の手で変える
  const link = linkOf(c, o);
  let before = 0;
  for (let l = link.up; l && l.up; l = l.up) if (map.childCount(map.parent(l.i)) >= 2) before++;
  const k = (before + (hash(map.key(link.first >= 0 ? link.first : o)) % 7)) % 7;
  if (!d.length && perm) return perm;
  if (!d.length) return [`同じ手で『${lab}』だった場合と、数字はほとんど変わらない。`, `『${lab}』だった場合とも、数字はほぼ同じ。`, `別の結果の『${lab}』とも、数字はほとんど変わらない。`, `『${lab}』の場合とも、数字に大きな違いは無い。`, `数字は、同じ手で『${lab}』だった場合とほとんど同じ。`, `この結果と『${lab}』の場合で、数字はほとんど変わらない。`, `『${lab}』と比べても、この結果の数字はほぼ同じ。`][k]!;
  const ds = d.slice(0, 2).join("、");
  return [`同じ手で『${lab}』だった場合より、${ds}。`, `『${lab}』だった場合と比べると、${ds}。`, `別の結果の『${lab}』と比べて、${ds}。`, `『${lab}』の場合に比べ、${ds}。`, `${ds}（同じ手で『${lab}』だった場合と比べて）。`, `『${lab}』と比べると、この結果は${ds}。`, `この結果は、『${lab}』の場合より${ds}。`][k]! + perm;
}

/** まとめた行き先が、名前の付いた結果（兄弟がある）の後か */
const sumNamed = (c: Ctx, n: number): boolean => c.map.outId(n) !== "all" && c.map.childCount(c.map.parent(n)) >= 2;

/** まとめた行き先の、この手から 3 年後までの稼ぎの合計（e は手の 3 か月から 36 か月目までの見込み。給与は月数 × 今の年収の月割り） */
const sumTotal = (c: Ctx, x: number): number => {
  const e = c.map.e(x);
  return e[0] * (c.annual / 12) + e[1] + e[2];
};
const amount = (x: number): string => slot(Math.abs(x) >= 100 ? n0(x) : man(x));

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

/** 次の 3 か月の問い（言い方は 3 通りを回す） */
function nextSentence(c: Ctx, n: number): string {
  const { map, cal } = c;
  const alts = kidsOf(map, n).filter((x) => map.kind(x) !== "keep");
  if (!alts.length) return "次の 3 か月も今のまま続ける。";
  const ph = alts.map((a) => moveShortPhrase(c, a)).filter((x, k, arr) => arr.indexOf(x) === k).slice(0, 3);
  const frames = [`次の 3 か月は、${ph.join("、")}、今のままか。`, `${cal.ym(map.month(n) + 3)}までの手は、${ph.join("、")}、今のままか。`, `ここからは、${ph.join("、")}、何も足さないか。`];
  return frames[hash(map.key(n) + "next") % frames.length]!;
}

/**
 * 次の 3 か月の暦の文を 1 つ（道で 1 回だけ。確定申告はその年分ごとに 1 回）。truth-10:
 * - 確定申告の期間は年ごと。独立していた年は独立の申告（辞めた年・戻った年は給与と一緒に）
 * - 会社員の年は副業と SpellDash の所得（売上 − 経費）で決める: 20 万円を超える見込みなら確定申告、近ければ「超えるなら」、
 *   以下でも住民税の申告は要る
 */
function calPick(c: Ctx, link: Link, env: Env, slots: Slots, used: (k: string) => boolean): CalPick | null {
  const { map, B, cal } = c;
  const n = link.i;
  const m = map.month(n);
  const s = map.st(n);
  const months = [1, 2, 3].map((k) => cal.parts(m + k));
  const kinds = new Set(kidsOf(map, n).map((x) => map.kind(x)));
  const line = Number(B.facts.taxLine ?? NaN);
  const cands: CalPick[] = [];
  const season = months.find(([, mo]) => mo === 2 || mo === 3);
  if (season && Number.isFinite(line)) {
    const year = season[0] - 1;
    const jm = jobMonths(c, link, year);
    let code: string | null = null;
    if (jm.ind > 0 && jm.sal > 0) code = "TAX_MIX";
    else if (jm.ind > 0) code = "TAX_IND";
    else {
      const inc = sideIn(c, link, year);
      code = inc > line * 1.3 ? "TAX_SIDE" : inc > line ? "TAX_NEAR" : inc >= 0.5 ? "JUMIN_DECL" : null;
    }
    if (code) cands.push({ code, key: `TAX@${year}`, year, back: jm.back });
  }
  const june = months.find(([, mo]) => mo === 6);
  if (june) {
    const prev = june[0] - 1;
    if (s.j !== "i" && sideIn(c, link, prev) >= 0.5) cands.push({ code: "JUMIN", key: "JUMIN", year: prev, back: false });
    else if (s.j === "i" && jobMonths(c, link, prev).sal > 0) cands.push({ code: "JUMIN_IND", key: "JUMIN_IND", year: prev, back: false });
  }
  if (months.some(([, mo]) => mo === 4) && s.j !== "i") cands.push({ code: "APRIL", key: "APRIL", year: 0, back: false });
  if (kinds.has("ind_quit") || kinds.has("fc_switch") || kinds.has("fc_switch2")) cands.push({ code: "LEAVE", key: "LEAVE", year: 0, back: false });
  for (const cd of cands) {
    if (used(cd.key)) continue;
    const e2 = calEnv(c, link, env, cd);
    if (B.cal[cd.code]?.some((g) => cond(g.if, e2, s.fl) && pickIn(g, calSlots(c, slots, cd), 0))) return cd;
  }
  return null;
}

/** 申告の文の仲間（独立の申告と、辞めた年・戻った年の申告は同じ仲間。副業の申告と住民税だけの申告も同じ仲間） */
const TAX_FAMILY: Record<string, readonly string[]> = { TAX_IND: ["TAX_IND", "TAX_MIX"], TAX_MIX: ["TAX_IND", "TAX_MIX"], TAX_SIDE: ["TAX_SIDE"], TAX_NEAR: ["TAX_NEAR"], JUMIN_DECL: ["JUMIN_DECL"] };

/** 暦の文の条件: again は、その道で同じ仲間の申告の文を前に使った（2 年目からの言い方）。back は会社員に戻った年 */
function calEnv(c: Ctx, link: Link, env: Env, cd: CalPick): Env {
  const again = cd.key.startsWith("TAX@") && (TAX_FAMILY[cd.code] ?? [cd.code]).some((code) => usedOn(c, link.up, `calcode:${code}`));
  return { ...env, again: again ? 1 : 0, back: cd.back ? 1 : 0 };
}
function calSlots(c: Ctx, slots: Slots, cd: CalPick): Slots {
  if (!cd.key.startsWith("TAX@")) return slots;
  return { ...slots, taxYear: `${slot(cd.year)} 年分`, taxPeriod: c.cal.taxPeriod(cd.year), taxDeadline: c.cal.taxDeadline(cd.year) };
}

function composeState(c: Ctx, n: number): Card {
  const { map, B } = c;
  const trace: string[] = [];
  const link = linkOf(c, n);
  const plan = planOf(c, link);
  const { env, slots } = stateEnv(c, n, link);
  const s = map.st(n);
  const m = map.month(n);
  const seed0 = hash(map.key(link.first >= 0 ? link.first : n));
  const evText = shownEvents(link)
    .map((e) => {
      // その出来事の型が無ければ、種類を落とした名前（QUIET_fc_push → QUIET）の型。道で何回目か（evn）で言い換えを回す
      const bare = e.code.replace(/_[a-z_0-9]+$/, "");
      const cell = B.event[e.code] ? e.code : B.event[bare] ? bare : "QUIET";
      const evn = countEvent(link.up, e.code);
      const es = { ...slots, ...evSlots(c, e, m) };
      const said = choose(B.event[cell], { ...env, evn }, s.fl, es, seed0 + hash(e.code) + evn, trace, `event.${cell}`) ?? "";
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
  const body = join([head, sinceClause(c, link, plan), hint, contrastSentence(c, n, plan.perm), nextSentence(c, n), calText]);
  const top = link.evs[0];
  // 短い名前: 一番の出来事の短い名前（試作は {nth} などを埋めずに返していた）
  const short = top ? (fill(B.eventShort[top.code] ?? "", { ...slots, ...top.x }) ?? "") : "";
  return { title: titleOf(c, n, trace), short, body, numbers: numbersRow(c, n), todo: [], trace };
}

// ---- 3 年後の行き先

/** 行き先の節目に並べる出来事（大事な順） */
const MILESTONE_RANK = ["IND_START", "BACK_EMP", "SWITCH_HIGH", "SWITCH_MID", "PERM_A", "PERM_S", "PERM_N", "PART_ON", "PROMO", "FIRST_CLIENT", "SCHOOL_ON", "CLIENT_UP", "PILOT_ON", "PU_MILE", "PORTFOLIO_ON", "CLIENT_LOST", "PRO_START"];

const JOB_WORD: Record<string, string> = { e: "会社員", p: "週 4 日勤務", i: "独立" };
const PM_WORD: Record<string, string> = { a: "全部可", s: "SpellDash だけ可", n: "どちらも不可" };

/** 中身の幅の言葉（9 割がそろう事実だけを言い切り、ほかは「多い」「含む」で言う。truth-5） */
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
  if (pms[0]![1] >= SURE) out.push(pms[0]![0] === "?" ? "届け出はしていない" : `届け出の答えは『${PM_WORD[pms[0]![0]]}』`);
  else out.push("届け出の答えは道によって違う");
  if (mix.pro >= SURE) out.push("Pro を出している");
  else if (mix.pro <= RARE) out.push("Pro はまだ出していない");
  else out.push(mix.pro >= 0.5 ? "Pro を出している道が多い" : "Pro を出している道は少ない");
  if (mix.school >= SURE) out.push("学校の導入がある");
  else if (mix.school > RARE) out.push("学校の導入がある道も含む");
  return out.join("。") + "。";
}

/** 標準の続きの出来事の名前（短い名前に差し込む数が要る物） */
const CONT_EV: Record<string, string> = { SWITCH_HIGH: "転職", SWITCH_MID: "転職", CLIENT_UP: "顧客が増える", CLIENT_REGAIN: "顧客を戻す", PU_MILE: "有料会員が増える", CLIENT_LOST: "顧客が離れる" };

/** この後の目安に並べる期の数（それより多ければ残りを「ほか N 期」とまとめる。道の画面は標準の続きを 1 期ずつ見せる） */
const CONT_MAX = 5;

/** この後の目安（まとめた行き先の標準の続き。SPEC §4.2: 「この後の目安: 2027 年 11 月 転職活動 → … → 2029 年 11 月に月 X 万円」） */
function contSentence(c: Ctx, cont: readonly MapContStep[], total: number): string {
  const { cal, B } = c;
  const merged: Array<{ m: number; kind: string; ev?: string; n: number }> = [];
  for (const st of cont) {
    const last = merged[merged.length - 1];
    if (last && last.kind === st.kind && !last.ev && !st.ev) last.n++;
    else merged.push({ m: st.m, kind: st.kind, ...(st.ev ? { ev: st.ev } : {}), n: 1 });
  }
  const rest = merged.length > CONT_MAX ? merged.splice(CONT_MAX - 1).reduce((a, st) => a + st.n, 0) : 0;
  let prev: number | null = null;
  const parts = merged.map((st) => {
    const ev = st.ev ? (CONT_EV[st.ev] ?? fill(B.eventShort[st.ev] ?? "", {})) : null;
    const t = `${cal.ymRel(st.m, prev)} ${kindNoun(c, st.kind)}${st.n > 1 ? `（${slot(st.n)} 期）` : ""}${ev ? `（${ev}）` : ""}`;
    prev = st.m;
    return t;
  });
  if (rest) parts.push(`ほか ${slot(rest)} 期`);
  return `この後の目安: ${[...parts, `${cal.ymRel(cal.horizon, prev)}に月 ${slot(man(total))} 万円`].join(" → ")}。`;
}

function composeEnd(c: Ctx, n: number): Card {
  const { map, B, C } = c;
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
      const name = fill(B.eventShort[e.code] ?? "", { ...slots, ...e.x });
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
  const sum = map.sum(n);
  const mix = map.mix(n);
  const cont = map.cont(n);
  const path = msText ? `ここまでの節目は、${msText}。` : "";
  let body: string;
  if (!sum) {
    let job = JOB_WORD[s.j]!;
    if (s.j === "i" && link.indFrom !== null) job = `独立して ${slot(map.month(n) - link.indFrom + 1)} か月目`;
    else if (s.j !== "i" && s.fl.includes("switched")) job = `移った会社で${job}`;
    const head = `${slots.ym}（3 年後）、${job}。`;
    const monthly = `この時の月の稼ぎは合わせて ${slot(man(total))} 万円${s.j === "i" ? `（経費 月 ${slot(man(C.overhead))} 万円を引いた後）` : ""}。`;
    const after = choose(B.after, env, s.fl, slots, hash(map.key(n)), trace, "after") ?? "";
    body = join([head, path, monthly, endContrast(c, n), after]);
  } else {
    // まとめた行き先（truth-5・truth-2）: 中身の幅があれば 9 割がそろう事実だけを言い切り、無ければ平均だと書いて事実として言わない。
    // どの結果の後かを書き出しで言い、兄弟とはこの手からの稼ぎの合計で比べる（兄弟の行き先が同じ骨組みにならない。点検 C6）
    trace.push(mix ? "sum:mix" : "sum:avg");
    const from = sumNamed(c, n) ? `『${labelOf(c, n)}』の後を、` : "この手の後を、";
    const head = mix
      ? `${slots.ym}（3 年後）の見込み（${from}標準の選び方で続けた見積もり）。${mixWords(mix)}`
      : `${slots.ym}（3 年後）の平均（${from}標準の選び方で続けた見積もり）。多くの道を平均した物で、仕事は一番多い${JOB_WORD[s.j]}の道の場合、数は平均（1 本の道の数ではない）。`;
    const monthly = `この時の月の稼ぎは平均で ${slot(man(total))} 万円。`;
    const tail = cont && cont.length ? (trace.push("cont"), contSentence(c, cont, total)) : "この先の道は、この先の分かれ道での選び方と運で分かれる。";
    body = join([head, path, monthly, sumSoFar(c, n), tail]);
  }
  return { title: titleOf(c, n, trace), short: "", body, numbers: numbersRow(c, n), todo: [], trace };
}

// ---- 今日

function composeRoot(c: Ctx, i: number): Card {
  const { map, cal } = c;
  const r = ripple(map, i);
  // 地図の年月は 0 か月目から（user-17・truth-12）。今日の手の「この手の先」の文と同じ骨組みにしない（道の画面で今日と今日の手は並ぶ）
  const sums = r.sumEnds ? `（うち ${slot(n0(r.sumEnds))} は標準の続きの見積もり）` : "";
  const body = `${cal.ym(map.month(i))}時点の地図。今月を今日として、${cal.ym(cal.horizon)}まで 3 か月ごとに手を 1 つずつ選ぶ（${slot(Math.round((cal.horizon - map.month(i)) / 3))} 回）。今日選べる手は ${slot(map.childCount(i))} 通りで、その先の分かれ道は合わせて ${slot(n0(r.forks))}（判断 ${slot(n0(r.decisions))}・出来事の分かれ ${slot(n0(r.splits))}）、3 年後の行き先は ${slot(n0(r.ends))}${sums}。`;
  return { title: ROOT_TITLE, short: "今日", body, numbers: numbersRow(c, i), todo: [], trace: ["root"] };
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
