// 文章の組み立ての、地図ごとの覚え（地図の物を鍵にした WeakMap。地図が要らなくなれば一緒に消える）。設計: 作業メモ SPEC v1 §4.1
// - 暦: 0 か月目の年月（header.anchor）から、どの月も年月にする。4 月（昇給・評価）の月もここから出す
// - 道の覚え（Link）: 判断（今日・状態）ごとに 1 つ。作るのは組み立てたカードの道の上だけで、1 つ前の判断の覚えを指し、
//   その間の手（種類・使った手引き）とこの状態で起きたこと・副業の稼ぎだけを持つ。初めの 1 回は道の長さぶん、その後は引くだけ
// - 先の数え上げ: 判断・出来事の分かれ・行き先を下から 1 回で数える（今日の手の「この手の先」の文）。初めて要るときに 1 回だけ
// 元: 試作（R2）の compose.ts の pathOf・eventsOf・stepsFor（何を数え、何を出来事とするかは変えていない）
import type { MapData, MapHeader } from "../../deepmap/mapData";
import type { ImpactSt } from "../impact";
import { clr, cond, f2, n0, slot, type Env } from "./text";
import type { Banks, Consts, Step } from "./types";

// ---- 暦

export interface Calendar {
  /** 地図の終わりの月（36） */
  readonly horizon: number;
  /** 4 月を含む月（0 か月目から数えて。昇給・評価・昇格の月） */
  readonly aprils: readonly number[];
  /** m か月目の [年, 月（1〜12）] */
  parts(m: number): [number, number];
  /** 「2027 年 1 月」（数は差し込みの印つき） */
  ym(m: number): string;
  /** 前に書いた月と同じ年なら年を落とす（「2026 年 12 月〜2 月」の後ろ） */
  ymRel(m: number, prev: number | null): string;
  /** 手の 3 か月（「2026 年 11 月〜2027 年 2 月」） */
  period(m: number): string;
}

function calendarOf(header: MapHeader): Calendar {
  const mm = /^(\d{4})-(\d{2})$/.exec(header.anchor);
  const y0 = mm ? Number(mm[1]) : NaN;
  const mo0 = mm ? Number(mm[2]) : NaN;
  if (!mm || mo0 < 1 || mo0 > 12) throw new Error(`地図の 0 か月目の年月が読めません: ${header.anchor}`);
  const horizon = header.horizon;
  const aprils: number[] = [];
  for (let m = 0; m <= horizon; m++) if ((mo0 - 1 + m) % 12 === 3) aprils.push(m);
  const parts = (m: number): [number, number] => {
    const t = y0 * 12 + (mo0 - 1) + m;
    return [Math.floor(t / 12), (t % 12) + 1];
  };
  const ym = (m: number): string => {
    const [y, mo] = parts(m);
    return `${slot(y)} 年 ${slot(mo)} 月`;
  };
  const ymRel = (m: number, prev: number | null): string => {
    const [y, mo] = parts(m);
    if (prev !== null && parts(prev)[0] === y) return `${slot(mo)} 月`;
    return `${slot(y)} 年 ${slot(mo)} 月`;
  };
  return { horizon, aprils, parts, ym, ymRel, period: (m) => `${ym(m)}〜${ymRel(m + 3, m)}` };
}

// ---- 先の数え上げ（下から 1 回）

/** あるカードから先（そのカードを含む）の数 */
export interface Ripple {
  /** 選べる手が 2 つ以上ある判断（今日・状態） */
  decisions: number;
  /** 結果が 2 つ以上に分かれる手 */
  splits: number;
  /** 分かれ道（判断 + 出来事の分かれ） */
  forks: number;
  /** 3 年後の行き先 */
  ends: number;
  /** そのうち、標準の選び方で続けた見積もりでまとめた行き先 */
  sumEnds: number;
}

interface Counts {
  dec: Int32Array;
  spl: Int32Array;
  end: Int32Array;
  sumEnd: Int32Array;
}

function countsOf(map: MapData): Counts {
  const n = map.n;
  const dec = new Int32Array(n);
  const spl = new Int32Array(n);
  const end = new Int32Array(n);
  const sumEnd = new Int32Array(n);
  // 深さ優先の番号なので、子孫は親より後ろ。後ろから親へ足していけば 1 回で済む
  for (let i = n - 1; i >= 0; i--) {
    const r = map.role(i);
    if (r === "e") {
      end[i]! += 1;
      if (map.sum(i)) sumEnd[i]! += 1;
    } else if (map.childCount(i) >= 2) {
      if (r === "a") spl[i]! += 1;
      else dec[i]! += 1;
    }
    const p = map.parent(i);
    if (p >= 0) {
      dec[p]! += dec[i]!;
      spl[p]! += spl[i]!;
      end[p]! += end[i]!;
      sumEnd[p]! += sumEnd[i]!;
    }
  }
  return { dec, spl, end, sumEnd };
}

/** カード i から先の判断・出来事の分かれ・行き先の数（地図ごとに 1 回だけ数える） */
export function ripple(map: MapData, i: number): Ripple {
  const pm = perMap(map);
  const c = (pm.counts ??= countsOf(map));
  const decisions = c.dec[i] ?? 0;
  const splits = c.spl[i] ?? 0;
  return { decisions, splits, forks: decisions + splits, ends: c.end[i] ?? 0, sumEnds: c.sumEnd[i] ?? 0 };
}

// ---- 道の覚え

/** 状態で起きたこと: 出来事の名前・その月・文に差し込む値（quiet は行き先の節目にだけ数え、状態の文には書かない） */
export interface Ev {
  code: string;
  quiet?: boolean;
  m: number;
  x: Record<string, string>;
}

/** 判断（今日・状態）か行き先までの道の覚え。1 つ前の判断の覚え（up）を指す */
export interface Link {
  readonly up: Link | null;
  /** このカードの番号 */
  readonly i: number;
  /** up からここへ来た手の種類（今日は null） */
  readonly kind: string | null;
  /** その手が使った手引きの番号 */
  readonly steps: readonly string[];
  /** この状態で起きたこと */
  readonly evs: readonly Ev[];
  /** その 3 か月の副業の稼ぎ（広告運用 + SpellDash、万円/月。まとめた行き先は 0）と、その手を始めた月 */
  readonly side: number;
  readonly sideM: number;
  /** 独立した月（道の上で一番新しい物） */
  readonly indFrom: number | null;
  /** 道の最初の手（今日の手）の番号。今日は −1 */
  readonly first: number;
  /** 今日からここまでの判断で一番多かった顧客の数（整数に丸めて） */
  readonly bestCl: number;
}

/** 覚えておく道の数の上限（超えたら忘れて作り直す。答えは変わらない） */
const MAX_LINKS = 50_000;

interface PerMap {
  /** 暦（初めて組み立てるときに作る。数え上げだけなら要らない） */
  cal: Calendar | null;
  counts: Counts | null;
  links: WeakMap<Banks, Map<number, Link>>;
}

const MEMO = new WeakMap<MapData, PerMap>();

function perMap(map: MapData): PerMap {
  let pm = MEMO.get(map);
  if (!pm) {
    pm = { cal: null, counts: null, links: new WeakMap() };
    MEMO.set(map, pm);
  }
  return pm;
}

/** 1 枚を組み立てる間の道具一式（作るのは安い。重い物は地図ごとの覚えに置く） */
export interface Ctx {
  readonly map: MapData;
  readonly B: Banks;
  readonly C: Consts;
  readonly annual: number;
  readonly cal: Calendar;
  readonly links: Map<number, Link>;
}

export function ctxOf(map: MapData, banks: Banks, annual: number): Ctx {
  const pm = perMap(map);
  let links = pm.links.get(banks);
  if (!links) {
    links = new Map();
    pm.links.set(banks, links);
  }
  return { map, B: banks, C: banks.C, annual, cal: (pm.cal ??= calendarOf(map.header)), links };
}

/** 抱えられる顧客の数 */
export const capOf = (C: Consts, j: ImpactSt["j"]): number => (j === "i" ? C.capInd : j === "p" ? C.capPart : C.capEmp);

/** 道の上で、その種類の手を選んだ回数（覚えの手まで） */
export function countKind(link: Link, kind: string): number {
  let c = 0;
  for (let l: Link | null = link; l; l = l.up) if (l.kind === kind) c++;
  return c;
}

/** 道の上で使った手引きの番号 */
export function usedSet(link: Link): Set<string> {
  const s = new Set<string>();
  for (let l: Link | null = link; l; l = l.up) for (const id of l.steps) s.add(id);
  return s;
}

/** 道の上で起きたこと（今日から順に） */
export function eventsList(link: Link): Ev[] {
  const ls: Link[] = [];
  for (let l: Link | null = link; l; l = l.up) ls.push(l);
  const out: Ev[] = [];
  for (let k = ls.length - 1; k >= 0; k--) out.push(...ls[k]!.evs);
  return out;
}

/** 道の上で、その暦の年に入った副業の稼ぎ（万円）。3 か月の稼ぎを、手を始めた月の翌月から 3 か月にならす */
export function sideIn(c: Ctx, link: Link, year: number): number {
  let sum = 0;
  for (let l: Link | null = link; l; l = l.up) {
    if (!l.side) continue;
    for (let k = 1; k <= 3; k++) if (c.cal.parts(l.sideM + k)[0] === year) sum += l.side;
  }
  return sum;
}

function rootLink(c: Ctx, i: number): Link {
  return { up: null, i, kind: null, steps: [], evs: [], side: 0, sideM: 0, indFrom: null, first: -1, bestCl: clr(c.map.st(i).cl) };
}

/** 状態か行き先 n の覚えを、その前の判断の覚え up から作る */
function makeLink(c: Ctx, up: Link, n: number): Link {
  const { map } = c;
  const move = map.parent(n);
  const kind = map.kind(move) ?? "";
  const steps = stepsFor(c, move, countKind(up, kind), usedSet(up)).map((s) => s.id);
  const evs = eventsOf(c, n, up);
  const e = map.e(n);
  const m0 = map.month(move);
  return {
    up,
    i: n,
    kind,
    steps,
    evs,
    side: map.sum(n) ? 0 : (e[1] + e[2]) / 3,
    sideM: m0,
    indFrom: evs.some((x) => x.code === "IND_START") ? m0 + 2 : up.indFrom,
    first: up.first >= 0 ? up.first : move,
    bestCl: Math.max(up.bestCl, clr(map.st(n).cl)),
  };
}

/** 判断（今日・状態）の覚え。無ければ、覚えのある判断まで道を上ってから作る */
export function linkOf(c: Ctx, i: number): Link {
  const { map, links } = c;
  const hit = links.get(i);
  if (hit) return hit;
  const todo: number[] = [];
  let x = i;
  let base: Link | undefined;
  for (;;) {
    base = links.get(x);
    if (base) break;
    const r = map.role(x);
    if (r === "r") {
      base = rootLink(c, x);
      break;
    }
    if (r !== "s") throw new Error(`判断ではないカードの道を覚えようとしました: ${map.key(x)}`);
    todo.push(x);
    const move = map.parent(x);
    x = move >= 0 ? map.parent(move) : -1;
    if (x < 0) throw new Error(`今日につながらない状態です: ${map.key(i)}`);
  }
  if (links.size + todo.length + 1 > MAX_LINKS) links.clear();
  links.set(x, base);
  let cur = base;
  for (let k = todo.length - 1; k >= 0; k--) {
    cur = makeLink(c, cur, todo[k]!);
    links.set(todo[k]!, cur);
  }
  return cur;
}

/** 行き先の覚え（葉なので覚えずにその場で作る） */
export function endLink(c: Ctx, i: number): Link {
  return makeLink(c, linkOf(c, c.map.parent(c.map.parent(i))), i);
}

// ---- 出来事（その 3 か月に起きたこと: 判断の状態 → この状態）

export function eventsOf(c: Ctx, n: number, up: Link): Ev[] {
  const { map, C, cal } = c;
  const move = map.parent(n);
  const a = map.st(up.i);
  const b = map.st(n);
  const k = map.kind(move) ?? "";
  const id = map.outId(n);
  const m0 = map.month(move);
  const out: Ev[] = [];
  if (a.pm === "?" && b.pm !== "?") out.push({ code: b.pm === "a" ? "PERM_A" : b.pm === "s" ? "PERM_S" : "PERM_N", m: m0 + 1, x: { ym1: cal.ym(m0 + 1), ym2: cal.ymRel(m0 + 2, m0 + 1) } });
  if (a.j !== "i" && b.j === "i") out.push({ code: "IND_START", m: m0 + 2, x: { ym1: cal.ym(m0 + 1), ym2: cal.ymRel(m0 + 2, m0 + 1), overhead: slot(C.overhead) } });
  if (a.j === "i" && b.j === "e") out.push({ code: "BACK_EMP", m: m0 + 3, x: {} });
  if ((k === "back_emp" || k === "plan_back") && b.j === "i") out.push({ code: "BACK_NO", m: m0 + 3, x: {} });
  if (a.j === "e" && b.j === "p") out.push({ code: "PART_ON", m: m0 + 2, x: { salx: `${slot(f2(map.rr(n)[0]))} 倍` } });
  if (k === "part" && b.j === "e") out.push({ code: "PART_NO", m: m0 + 3, x: {} });
  const switched = b.fl.includes("switched") && !a.fl.includes("switched");
  if (switched) out.push({ code: b.sal / Math.max(1e-9, a.sal) >= 1.13 ? "SWITCH_HIGH" : "SWITCH_MID", m: m0 + 3, x: { salx: `${slot(f2(b.sal))} 倍`, ym3: cal.ym(m0 + 3) } });
  if ((k === "fc_switch" || k === "fc_switch2") && !switched) out.push({ code: "SEARCH_NONE", m: m0 + 3, x: {} });
  if (k === "fc_push") {
    const april = cal.aprils.find((q) => q > m0 && q <= m0 + 3) ?? m0 + 2;
    out.push({ code: id === "up" ? "PROMO" : "PROMO_NO", m: april, x: { ymApril: cal.ym(april), salx: `${slot(f2(b.sal))} 倍` } });
  }
  if (a.pro === 0 && b.pro === 1 && !out.some((e) => e.code === "PERM_A" || e.code === "PERM_S")) out.push({ code: "PRO_START", m: m0 + 2, x: { ym2: cal.ym(m0 + 2) } });
  const ca = clr(a.cl);
  const cb = clr(b.cl);
  const cap = capOf(C, b.j);
  const jobName = b.j === "i" ? "独立" : b.j === "p" ? "週 4 日勤務" : "会社員";
  // この 3 か月より前に道で一番多かった顧客の数（離れた分を取り戻したのか、新しい最多なのかで言い方が違う）
  const best = up.bestCl;
  if (cb > ca) out.push({ code: ca === 0 && best === 0 ? "FIRST_CLIENT" : cb <= best ? "CLIENT_REGAIN" : "CLIENT_UP", m: m0 + 2, x: { nth: slot(cb), capNote: cb >= cap ? `${jobName}で持てる ${slot(cap)} 社の上限に届いた。` : "" } });
  else if (cb < ca) out.push({ code: "CLIENT_LOST", m: m0 + 3, x: { lost: slot(ca - cb) } });
  else if ((k === "ad_side" || k === "ad_more") && cb === ca) out.push({ code: "CLIENT_NOT_FOUND", m: m0 + 3, x: {} });
  for (const [flag, on, off, kindOf] of FLAG_EVENTS) {
    if (k !== kindOf) continue;
    out.push({ code: b.fl.includes(flag) && (!a.fl.includes(flag) || flag === "school") && id === "yes" ? on : off, m: m0 + 3, x: { seats: slot(b.seats) } });
  }
  const miles: Ev[] = [];
  for (const mile of [10, 30, 100, 300]) if (a.pu < mile && b.pu >= mile && b.pro) miles.push({ code: "PU_MILE", m: m0 + 3, x: { mile: slot(mile) } });
  for (const mile of [100, 300, 1000]) if (a.mau < mile && b.mau >= mile) miles.push({ code: "MAU_MILE", m: m0 + 3, x: { mile: slot(n0(mile)) } });
  // 節目の数は道の記録（3 年後の行き先）には残すが、状態の文の先頭に出すのは大きな出来事が無いときだけ
  if (!out.length) out.push(...miles.slice(0, 1));
  else out.push(...miles.map((e) => ({ ...e, quiet: true })));
  if (!out.length) out.push({ code: `QUIET_${k}`, m: m0 + 3, x: {} });
  return out;
}

/** 印・出来事（あり / なし）・その印を付ける手の種類 */
const FLAG_EVENTS: ReadonlyArray<readonly [string, string, string, string]> = [
  ["school", "SCHOOL_ON", "SCHOOL_NO", "sd_school"],
  ["pilot", "PILOT_ON", "PILOT_NO", "sd_pilot"],
  ["portfolio", "PORTFOLIO_ON", "PORTFOLIO_NO", "ad_portfolio"],
];

// ---- 手引き（3 か月ごとに 3 つ。同じ道では同じ歩みを繰り返さない）

/** 手 a で使う手引きの歩み（その種類を選ぶのが nth 回目・道で使った歩み used） */
export function stepsFor(c: Ctx, a: number, nth: number, used: ReadonlySet<string>): Step[] {
  const { map, B, C } = c;
  const kind = map.kind(a) ?? "";
  const s = map.st(a);
  const m = map.month(a);
  const book = B.playbook[kind] ?? B.playbook._generic ?? [];
  const env: Env = { j: s.j, pm: s.pm, pro: s.pro, cl: s.cl, clr: clr(s.cl), pu: s.pu, mau: s.mau, sal: s.sal, seats: s.seats, cap: capOf(C, s.j), m, mon: c.cal.parts(m)[1], n: nth, first: m === 0 ? 1 : 0 };
  const out: Step[] = [];
  // 同じ番号の歩みは 1 回だけ（試作は種類の手引きと _generic の両方にある番号を 2 回入れることがあった）
  const take = (st: Step): void => {
    if (out.length < 3 && !used.has(st.id) && !out.some((x) => x.id === st.id) && cond(st.if, env, s.fl)) out.push(st);
  };
  for (const st of book) take(st);
  // 道の上でその種類の手引きを使い切ったら、_generic の歩みで埋める
  if (out.length < 3) for (const st of B.playbook._generic ?? []) take(st);
  return out;
}
