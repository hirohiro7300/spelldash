// 文章の組み立ての、地図ごとの覚え（地図の物を鍵にした WeakMap。地図が要らなくなれば一緒に消える）。設計: 作業メモ SPEC v1 §4.1・§4.2
// - 暦: 0 か月目の年月（header.anchor）から、どの月も年月にする。4 月（昇給・評価）の月・確定申告の期間（年ごと）もここから出す
// - 道の覚え（Link）: 判断（今日・状態）ごとに 1 つ。作るのは組み立てたカードの道の上だけで、1 つ前の判断の覚えを指し、
//   その間の手（種類・使った手引き）とこの状態で起きたこと・副業の稼ぎだけを持つ。初めの 1 回は道の長さぶん、その後は引くだけ
// - 先の数え上げ: 判断・出来事の分かれ・行き先を下から 1 回で数える（今日の手の「この手の先」の文）。初めて要るときに 1 回だけ
// 元: 試作（R2）の compose.ts の pathOf・eventsOf・stepsFor。変えた所: 手の 3 か月は翌月から（truth-15）・届け出の答えは届け出る手でだけ・
//   移った会社と戻った会社の出来事（truth-11）・独立した月の翌月に Pro（truth-10）・出来事の年月は文にするときに状態の月から書く・
//   まとめた結果（事実の場合をまとめた 'all'・上げ幅をまとめた 'high_mid'・社数の幅）は事実として言わない出来事にする（facts-1）・
//   出来事の月は W-gen の sim の at と同じ（facts-7）・次の顧客の月額の段（facts-2）・手の値（q とまとめた手の e。reader-1）
import type { MapData, MapHeader } from "../../deepmap/mapData";
import type { ImpactSt, R3 } from "../impact";
import { clr, cond, f2, n0, slot, wari, type Env } from "./text";
import type { Banks, Consts, Step } from "./types";

// ---- 暦

export interface Calendar {
  /** 地図の終わりの月（36） */
  readonly horizon: number;
  /** 4 月を含む月（0 か月目から数えて。昇給・評価・昇格の月） */
  readonly aprils: readonly number[];
  /** m か月目の [年, 月（1〜12）] */
  parts(m: number): [number, number];
  /** その年月が何か月目か（0 か月目より前は負） */
  monthOf(year: number, month: number): number;
  /** 「2027 年 1 月」（数は差し込みの印つき） */
  ym(m: number): string;
  /** 前に書いた月と同じ年なら年を落とす（「2026 年 12 月〜2 月」の後ろ） */
  ymRel(m: number, prev: number | null): string;
  /** m か月目に選んだ手の 3 か月（翌月から 3 か月。「2026 年 12 月〜2027 年 2 月」。truth-15: 4 つの月を書かない） */
  period(m: number): string;
  /** y 年分の確定申告の期間（翌年 2 月 16 日〜3 月 15 日。土日にかかれば次の月曜。年ごとに出す。truth-10） */
  taxPeriod(y: number): string;
  /** y 年分の申告の期限（翌年 3 月 15 日。土日にかかれば次の月曜） */
  taxDeadline(y: number): string;
}

/** 1970 年 1 月 1 日からの日数（グレゴリオ暦。Date を使わないので、時間帯で変わらない） */
export function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** 曜日（0 日曜〜6 土曜） */
export const weekday = (y: number, m: number, d: number): number => (((daysFromCivil(y, m, d) + 4) % 7) + 7) % 7;

/** 土日なら次の月曜の日（申告の期間の始めと終わり。2 月 16 日・3 月 15 日に祝日は来ない） */
const businessDay = (y: number, m: number, d: number): number => {
  const w = weekday(y, m, d);
  return w === 6 ? d + 2 : w === 0 ? d + 1 : d;
};

export function calendarOf(header: MapHeader): Calendar {
  const mm = /^(\d{4})-(\d{2})$/.exec(header.anchor);
  const y0 = mm ? Number(mm[1]) : NaN;
  const mo0 = mm ? Number(mm[2]) : NaN;
  if (!mm || mo0 < 1 || mo0 > 12) throw new Error(`地図の 0 か月目の年月が読めません: ${header.anchor}`);
  const horizon = header.horizon;
  const aprils: number[] = [];
  for (let m = 0; m <= horizon; m++) if ((mo0 - 1 + m) % 12 === 3) aprils.push(m);
  const parts = (m: number): [number, number] => {
    const t = y0 * 12 + (mo0 - 1) + m;
    return [Math.floor(t / 12), (((t % 12) + 12) % 12) + 1];
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
  const taxPeriod = (y: number): string => `${slot(y + 1)} 年 ${slot(2)} 月 ${slot(businessDay(y + 1, 2, 16))} 日〜${slot(3)} 月 ${slot(businessDay(y + 1, 3, 15))} 日`;
  const taxDeadline = (y: number): string => `${slot(y + 1)} 年 ${slot(3)} 月 ${slot(businessDay(y + 1, 3, 15))} 日`;
  return {
    horizon,
    aprils,
    parts,
    monthOf: (year, month) => year * 12 + (month - 1) - (y0 * 12 + (mo0 - 1)),
    ym,
    ymRel,
    period: (m) => `${ym(m + 1)}〜${ymRel(m + 3, m + 1)}`,
    taxPeriod,
    taxDeadline,
  };
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

/**
 * 状態で起きたこと: 出来事の名前・その月・文に差し込む値・文に差し込む年月（何か月目か。文にするときに、そのカードの月から書く）。
 * quiet は行き先の節目にだけ数え、状態の文には書かない
 */
export interface Ev {
  code: string;
  quiet?: boolean;
  m: number;
  x: Record<string, string>;
  at?: Record<string, number>;
  /** 出来事の文の型を選ぶ条件の値（まとめた結果か・何社か など） */
  env?: Env;
}

/** 判断（今日・状態）か行き先までの道の覚え。1 つ前の判断の覚え（up）を指す */
export interface Link {
  readonly up: Link | null;
  /** このカードの番号 */
  readonly i: number;
  /** up からここへ来た手の種類（今日は null） */
  readonly kind: string | null;
  /** その手の番号（今日は −1） */
  readonly move: number;
  /** その手が使った手引きの番号 */
  readonly steps: readonly string[];
  /** この状態で起きたこと */
  readonly evs: readonly Ev[];
  /** その 3 か月の副業の稼ぎ（広告運用 + SpellDash、万円/月。まとめた行き先は 0）・そのうち広告運用と、その手を始めた月・稼ぎが始まった月 */
  readonly side: number;
  readonly ad: number;
  readonly sideM: number;
  readonly sideFrom: number;
  /** 独立した月（道の上で一番新しい物） */
  readonly indFrom: number | null;
  /** 道の最初の手（今日の手）の番号。今日は −1 */
  readonly first: number;
  /** 今日からここまでの判断で、確かにいた顧客の数の一番多い物（まとめた結果は幅の下） */
  readonly bestCl: number;
  /** 次に増える副業の顧客が上の月額（feeFirst でなく feeRaised）か: 顧客が raiseAt 社に届いた後（会社員に戻って手放すと戻る。SPEC §2.3 #6） */
  readonly f5: boolean;
  /** 給与がまとめた結果の平均か（昇格と据え置き・上げ幅の違う転職などをまとめた後。数の行は「平均」と書く。facts-1） */
  readonly salMix: boolean;
  /** この判断に並ぶ手の種類（言い換えを判断ごとに回す数に使う。行き先は空） */
  readonly opts: ReadonlySet<string>;
  /**
   * その 3 か月の終わりに勤め先が変わったか（転職した・会社員に戻った。採用の有無をまとめた結果で独立から会社員か週 4 日に移った 3 か月も）。
   * 覚えを作るときに 1 回だけ決める（今の会社で選んだ手の数を、道の上の状態を読み直さずに数える。F5）
   */
  readonly newEmp: boolean;
}

/** 判断 i に並ぶ手の種類 */
function optKinds(map: MapData, i: number): ReadonlySet<string> {
  const out = new Set<string>();
  for (let k = 0; k < map.childCount(i); k++) {
    const x = map.child(i, k);
    if (map.role(x) === "a") out.add(map.kind(x) ?? "");
  }
  return out;
}

/** 覚えておく道の数の上限（超えたら忘れて作り直す。答えは変わらない） */
const MAX_LINKS = 50_000;

interface PerMap {
  /** 暦（初めて組み立てるときに作る。数え上げだけなら要らない） */
  cal: Calendar | null;
  counts: Counts | null;
  links: WeakMap<Banks, Map<number, Link>>;
  /** 兄弟の題（親の番号 → 子の並びの題と、その題に使った文の型）。題は年収で変わらないので、束ごとに 1 回 */
  titles: WeakMap<Banks, Map<number, readonly TitleEntry[]>>;
}

const MEMO = new WeakMap<MapData, PerMap>();

function perMap(map: MapData): PerMap {
  let pm = MEMO.get(map);
  if (!pm) {
    pm = { cal: null, counts: null, links: new WeakMap(), titles: new WeakMap() };
    MEMO.set(map, pm);
  }
  return pm;
}

/** 題と、その題に使った文の型（trace に足す） */
export type TitleEntry = readonly [string, readonly string[]];

/**
 * 組み立てにその場で渡す、計算の芯（src/deepmap/core。今の年収）の答え。画面と同じ「おすすめ」と数を本文に書くため（truth-1・reader-4・reader-8）。
 * 本文だけに使い、題・短い名前・やることには使わない（焼き込む物は年収で変わらない）。無ければ地図に書いた物（why=best・下からの数え上げ）で書く
 */
export interface ComposeRuntime {
  /** 判断 d の、今の年収のおすすめの手（計算の芯の一番良い選び方 π。画面の「おすすめ」の印と同じ）。決まらなければ −1 */
  recommended?(d: number): number;
  /** 手 a を選んで、その後を一番良い選び方で進んだ、その判断から 36 か月目までの稼ぎ（万円）。無ければ null */
  treeValue?(a: number): number | null;
  /** 今日の手 a の先で、一番良い選び方で着く本当の行き先（まとめた物を除く・見込みのある物）の数と、そのうち見込み 1% 以上の数。無ければ null */
  reach?(a: number): { ends: number; ends1: number } | null;
}

/** 1 枚を組み立てる間の道具一式（作るのは安い。重い物は地図ごとの覚えに置く） */
export interface Ctx {
  readonly map: MapData;
  readonly B: Banks;
  readonly C: Consts;
  readonly annual: number;
  readonly cal: Calendar;
  readonly links: Map<number, Link>;
  readonly titles: Map<number, readonly TitleEntry[]>;
  /** 計算の芯の答え（無ければ null。本文だけに使う） */
  readonly rt: ComposeRuntime | null;
}

export function ctxOf(map: MapData, banks: Banks, annual: number, rt: ComposeRuntime | null = null): Ctx {
  const pm = perMap(map);
  let links = pm.links.get(banks);
  if (!links) {
    links = new Map();
    pm.links.set(banks, links);
  }
  let titles = pm.titles.get(banks);
  if (!titles) {
    titles = new Map();
    pm.titles.set(banks, titles);
  }
  return { map, B: banks, C: banks.C, annual, cal: (pm.cal ??= calendarOf(map.header)), links, titles, rt };
}

/** 抱えられる顧客の数 */
export const capOf = (C: Consts, j: ImpactSt["j"]): number => (j === "i" ? C.capInd : j === "p" ? C.capPart : C.capEmp);

/** 道の上で、その種類の手を選んだ回数（覚えの手まで） */
export function countKind(link: Link, kind: string): number {
  let c = 0;
  for (let l: Link | null = link; l; l = l.up) if (l.kind === kind) c++;
  return c;
}

/** 道の上で、その出来事が起きた回数（覚えの状態まで） */
export function countEvent(link: Link | null, code: string): number {
  let c = 0;
  for (let l: Link | null = link; l; l = l.up) for (const e of l.evs) if (e.code === code) c++;
  return c;
}

/** 直前の 3 つの手（判断の覚え 3 つぶん）が使った手引きの番号（使い切った長い道で、もう一度使ってよい歩みを決める） */
export function recentSteps(link: Link): Set<string> {
  const s = new Set<string>();
  let k = 0;
  for (let l: Link | null = link; l && k < 3; l = l.up, k++) for (const id of l.steps) s.add(id);
  return s;
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

/** 道の上で、その暦の年に入った副業の稼ぎ（万円。ad なら広告運用だけ）。3 か月の稼ぎを、稼ぎが始まった月からその 3 か月の終わりまでにならす */
export function sideIn(c: Ctx, link: Link, year: number, ad = false): number {
  let sum = 0;
  for (let l: Link | null = link; l; l = l.up) {
    const v = ad ? l.ad : l.side;
    if (!v) continue;
    for (let m = l.sideFrom; m <= l.sideM + 3; m++) if (c.cal.parts(m)[0] === year) sum += v;
  }
  return sum;
}

/** 道の上の判断の状態（今日・状態。新しい物から）の仕事 */
function jobsUp(c: Ctx, link: Link, k: number): Array<ImpactSt["j"]> {
  const out: Array<ImpactSt["j"]> = [];
  for (let l: Link | null = link; l && out.length < k; l = l.up) out.push(c.map.st(l.i).j);
  return out;
}

/** 道の上で、今の会社に入ってから（転職・会社員に戻るより後）の転職活動の期の数（覚えの手まで） */
export function searchCount(link: Link): number {
  let n = 0;
  for (let l: Link | null = link; l && l.up; l = l.up) {
    if (l.evs.some((e) => e.code.startsWith("SWITCH_") || e.code === "BACK_EMP")) break;
    if (l.kind === "fc_switch" || l.kind === "fc_switch2") n++;
  }
  return n;
}

/**
 * 道の上で、今の会社に入ってから（転職・会社員に戻るより後）その種類の手を選んだ回数（覚えの手まで）。前の会社で選んだ手は数えない
 * （「担当を広げ続ける」「前の評価の続き」は同じ会社でだけ言う。F5）。勤め先が変わった 3 か月は覚えの newEmp（点検 C12 の kindHereBefore と同じ決まり）
 */
export function countKindHere(link: Link, kind: string): number {
  let n = 0;
  for (let l: Link | null = link; l && l.up; l = l.up) {
    if (l.newEmp) break;
    if (l.kind === kind) n++;
  }
  return n;
}

/**
 * 道の上で一番新しく勤め先が変わった月（転職して移った月・会社員に戻った月。採用の有無をまとめた結果はその 3 か月の終わり）。
 * 道の上で勤め先が変わっていなければ null（今日の会社のまま。入社してすぐの評価の一言に使う。fact-5）
 */
export function joinedAt(c: Ctx, link: Link): number | null {
  for (let l: Link | null = link; l && l.up; l = l.up) {
    if (!l.newEmp) continue;
    const e = l.evs.find((x) => x.code.startsWith("SWITCH_") || x.code === "BACK_EMP" || x.code === "BACK_MIX");
    return e ? e.m : c.map.month(l.move) + 3;
  }
  return null;
}

/**
 * 手を選ぶ判断の道から決まる条件の値（手の書き出し・手引きの条件に使う。reader-6）:
 * emp6 その判断と 1 つ前の判断で会社員か週 4 日（過去 6 か月の月次報告がある）・prevSearch 前の 3 か月が転職活動・
 * search 今の会社での転職活動の期の数（この手を除く）・f5 次に増える副業の顧客が上の月額か・
 * joined 道の上で勤め先が変わった（今の会社は地図の途中で入った会社。fact-5）
 */
export function pathEnv(c: Ctx, link: Link): Env {
  const js = jobsUp(c, link, 2);
  return { emp6: js.every((j) => j !== "i") ? 1 : 0, prevSearch: link.kind === "fc_switch" || link.kind === "fc_switch2" ? 1 : 0, search: searchCount(link), f5: link.f5 ? 1 : 0, joined: joinedAt(c, link) !== null ? 1 : 0 };
}

/** 独立してからの月の数（m か月目の時点。その月を含む。独立していなければ 0）。行き先の「独立して N か月目」と同じ数え方（rep-5） */
export const indMonthsAt = (link: Link, m: number, j: ImpactSt["j"]): number => (j === "i" && link.indFrom !== null ? m - link.indFrom + 1 : 0);

/** 次に増える副業の顧客の月額（万円）: 独立なら独立の月額、会社員・週 4 日は顧客が raiseAt 社に届いた後なら上の月額（SPEC §2.3 #6・facts-2） */
export const newFeeOf = (C: Consts, j: ImpactSt["j"], f5: boolean): number => (j === "i" ? C.indFee : f5 ? C.feeRaised : C.feeFirst);

/**
 * その暦の年に、給与のある月（会社員・週 4 日）と独立していた月がそれぞれ何か月あるか（確定申告の文。truth-10）。
 * 道の出来事（独立した月・会社員に戻った月・週 4 日になった月）から数え、0 か月目より前は今日の仕事、
 * このカードより後の月は、このカードの時点の仕事が続くとみる
 */
export function jobMonths(c: Ctx, link: Link, year: number): { sal: number; ind: number; back: boolean } {
  const { map, cal } = c;
  let root: Link = link;
  while (root.up) root = root.up;
  const spans: Array<[number, ImpactSt["j"]]> = [[-Infinity, map.st(root.i).j]];
  let back = false;
  for (const e of eventsList(link)) {
    if (e.code === "IND_START") spans.push([e.m, "i"]);
    else if (e.code === "BACK_EMP") spans.push([e.m, "e"]);
    else if (e.code === "PART_ON") spans.push([e.m, "p"]);
  }
  const now = map.month(link.i);
  const jNow = map.st(link.i).j;
  let sal = 0;
  let ind = 0;
  for (let mo = 1; mo <= 12; mo++) {
    const m = cal.monthOf(year, mo);
    let j: ImpactSt["j"] = jNow;
    if (m <= now) for (const [from, jj] of spans) if (from <= m) j = jj;
    if (j === "i") ind++;
    else {
      sal++;
      if (ind > 0) back = true;
    }
  }
  return { sal, ind, back };
}

function rootLink(c: Ctx, i: number): Link {
  const lo = clBand(c.map, i)[0];
  return { up: null, i, kind: null, move: -1, steps: [], evs: [], side: 0, ad: 0, sideM: 0, sideFrom: 1, indFrom: null, first: -1, bestCl: lo, f5: lo >= c.C.raiseAt, salMix: false, opts: optKinds(c.map, i), newEmp: false };
}

/** 給与をまとめた結果の平均にする出来事（facts-1） */
const SAL_MIX = new Set(["PROMO_MIX", "SWITCH_MIX", "SEARCH_MIX", "PART_MIX", "BACK_MIX"]);

/** 状態か行き先 n の覚えを、その前の判断の覚え up から作る */
function makeLink(c: Ctx, up: Link, n: number): Link {
  const { map, C } = c;
  const move = map.parent(n);
  const kind = map.kind(move) ?? "";
  const steps = stepsFor(c, move, countKind(up, kind), usedSet(up), recentSteps(up), pathEnv(c, up)).map((s) => s.id);
  // まとめた行き先へは 3 か月ではなく 3 年後の平均へ飛ぶので、出来事を作らない（節目はまとめた所まで）
  const evs = map.sum(n) ? [] : eventsOf(c, n, up);
  const e = map.e(n);
  const m0 = map.month(move);
  const ind = evs.find((x) => x.code === "IND_START");
  // その 3 か月の稼ぎが始まった月: 独立した月・届け出の答えの翌月・Pro の受付を始めた月（それより前の月は会社員の給与だけ。truth-10 の年の分け方）
  const starts = evs.filter((x) => x.code === "IND_START" || x.code === "PRO_START" || x.code.startsWith("PERM_")).map((x) => (x.code.startsWith("PERM_") ? x.m + 1 : x.m));
  const sideFrom = Math.min(m0 + 3, Math.max(m0 + 1, ...starts));
  const months = m0 + 3 - sideFrom + 1;
  const [lo] = clBand(map, n);
  // 会社員に戻ると顧客を手放し、上の月額の決まりも初めから（sim.ts の dropClients）
  const dropped = evs.some((x) => x.code === "BACK_EMP");
  return {
    up,
    i: n,
    kind,
    move,
    steps,
    evs,
    side: map.sum(n) ? 0 : (e[1] + e[2]) / months,
    ad: map.sum(n) ? 0 : e[1] / months,
    sideM: m0,
    sideFrom,
    indFrom: ind ? ind.m : up.indFrom,
    first: up.first >= 0 ? up.first : move,
    bestCl: Math.max(up.bestCl, lo),
    f5: (!dropped && up.f5) || lo >= C.raiseAt,
    salMix: up.salMix || evs.some((x) => SAL_MIX.has(x.code)),
    opts: optKinds(map, n),
    newEmp: evs.some((x) => x.code.startsWith("SWITCH_") || x.code === "BACK_EMP") || (map.st(up.i).j === "i" && map.st(n).j !== "i"),
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

/** 道の上の覚え（状態・行き先は自分の物、手は選ぶ判断の物） */
export function linkFor(c: Ctx, i: number): Link {
  const role = c.map.role(i);
  if (role === "a") return linkOf(c, c.map.parent(i));
  if (role === "e") return endLink(c, i);
  return linkOf(c, i);
}

// ---- 出来事（その 3 か月に起きたこと: 判断の状態 → この状態）

/** 会社に届け出る手（届け出の答えの出来事は、この手でだけ起きる。truth-11） */
export const FILING_KINDS: ReadonlySet<string> = new Set(["ad_perm", "ad_permside", "sd_permpro"]);

/**
 * 事実で分かれる手（昇格・学校・試用・事例・週 4 日・転職・会社員に戻る）。結果が 'all' なら、その事実の場合をまとめた結果
 * （R1 §4 の lean・予算が尽きた判断）。まとめた結果を、どちらか一方の事実として言わない（facts-1・reader-3）
 */
export const FACT_KINDS: ReadonlySet<string> = new Set(["fc_push", "sd_school", "sd_pilot", "ad_portfolio", "part", "fc_switch", "fc_switch2", "back_emp"]);
/** 新しい顧客が決まるかで分かれる手 */
export const SEARCH_KINDS: ReadonlySet<string> = new Set(["ad_side", "ad_more", "ad_permside"]);

/**
 * その 3 か月の何か月目に手の出来事が起きるか（W-gen の sim.ts の at と同じ。届け出の答え 1・週 4 日・学校・独立・顧客 2・ほか 3）。
 * 昇格は 3 か月の中の 4 月（facts-7）
 */
const EVENT_AT: Readonly<Record<string, number>> = { ad_perm: 1, ad_permside: 1, sd_permpro: 1, part: 2, sd_school: 2, ind_quit: 2, ad_side: 2, ad_more: 2, back_emp: 3, fc_switch: 3, fc_switch2: 3, sd_pilot: 3, ad_portfolio: 3 };

/** m0 か月目に選んだ種類 kind の手の出来事の月 */
export function eventMonth(cal: Calendar, kind: string, m0: number): number {
  if (kind === "fc_push") return cal.aprils.find((q) => q > m0 && q <= m0 + 3) ?? m0 + 2;
  return m0 + (EVENT_AT[kind] ?? 3);
}

/** 顧客の数の幅（社数の違う場合をまとめた結果は band.cl。無ければ丸めた数の 1 点） */
export function clBand(map: MapData, i: number): [number, number] {
  const b = map.band(i)?.cl;
  if (b) return [b[0], b[1]];
  const r = clr(map.st(i).cl);
  return [r, r];
}

/** 結果 n が、事実の場合をまとめた物か（事実で分かれる手の 'all' と、上げ幅の違う転職をまとめた 'high_mid'） */
export function mergedFact(map: MapData, n: number): boolean {
  const k = map.kind(map.parent(n)) ?? "";
  const id = map.outId(n);
  return (id === "all" && FACT_KINDS.has(k)) || id === "high_mid";
}

/** 事実の見込み（世界の数。昇格は担当を広げていれば上がり、学校は試用の実績で上がる）。無い手は null */
export function factShare(C: Consts, kind: string, fl: readonly string[]): number | null {
  if (kind === "fc_push") return fl.includes("scope") ? C.promoPScope : C.promoP;
  if (kind === "sd_school") return C.schoolP * (fl.includes("pilot") ? C.pilotMult : 1);
  return null;
}

/**
 * 手 a の結果 id の、その 3 か月の終わりの給与の倍率（その月の rr[0]。W-gen の sim.ts の jobPass と同じ決まり: 手の出来事の後に、
 * 4 月を含む 3 か月なら会社員と週 4 日に 4 月の昇給。転職は上がった倍率を掛け、昇格は 4 月に足し、週 4 日は 0.8 倍、会社員に戻る手は
 * 3 か月目に戻る水準から）。給与で分かれる手（転職・転職の続き・昇格・週 4 日・会社員に戻る）だけで、ほかと、上げ幅をまとめた high_mid は null。
 * まとめた手の結果は 3 年後の平均なので、この 3 か月の答え（移る先の給与・昇格した給与）はこれで言う（広げた手の結果の状態と同じ数。reader-1）
 */
export function quarterSal(map: MapData, C: Consts, cal: Calendar, a: number, id: string): number | null {
  const kind = map.kind(a) ?? "";
  const s0 = map.st(map.parent(a));
  const m0 = map.month(a);
  const raise = cal.aprils.some((q) => q > m0 && q <= m0 + 3) ? 1 + C.aprilRaise : 1;
  const pay = (j: ImpactSt["j"], sal: number): number => (j === "e" ? sal : j === "p" ? C.partFactor * sal : 0);
  switch (kind) {
    case "fc_switch":
    case "fc_switch2":
      return id === "high" ? pay(s0.j, s0.sal * C.switchHigh * raise) : id === "mid" ? pay(s0.j, s0.sal * C.switchMid * raise) : id === "none" ? pay(s0.j, s0.sal * raise) : null;
    case "fc_push":
      return id === "up" ? pay(s0.j, (s0.sal + C.step) * raise) : id === "same" ? pay(s0.j, s0.sal * raise) : null;
    case "part":
      return id === "p" ? pay("p", s0.sal * raise) : id === "e" ? pay(s0.j, s0.sal * raise) : null;
    case "back_emp":
      // 戻るのは 3 か月目（その月が 4 月なら、戻った後に昇給）。戻れなければ独立のまま給与なし
      return id === "e" ? C.backSal * (cal.aprils.includes(m0 + 3) ? 1 + C.aprilRaise : 1) : id === "i" ? 0 : null;
    default:
      return null;
  }
}

/** まとめた結果の文に差し込む見込み（分からなければ空） */
const shareSlot = (p: number | null): string => (p === null ? "" : wari(p));

export function eventsOf(c: Ctx, n: number, up: Link): Ev[] {
  const { map, C, cal } = c;
  const move = map.parent(n);
  const a = map.st(up.i);
  const b = map.st(n);
  const k = map.kind(move) ?? "";
  const id = map.outId(n);
  const m0 = map.month(move);
  const at = eventMonth(cal, k, m0);
  const out: Ev[] = [];
  // 顧客の数は幅で比べる（社数の違う場合をまとめた結果は幅。幅が重なれば、増えた・離れたとは言えない。facts-1）
  const [pl, ph] = clBand(map, up.i);
  const [bl, bh] = clBand(map, n);
  const exact = pl === ph && bl === bh;
  // 事実の場合をまとめた結果（昇格と据え置き・導入と見送りなど）
  const mixed = id === "all" && FACT_KINDS.has(k);
  // 届け出の答え: 届け出る手のときだけ（会社員に戻った・移った会社で答えが変わったのは、下の新しい会社の出来事）。
  // 『全部可』を 1 社目が決まったか（a1・a0）で分けた結果は、それを題と文で言う（reader-5・SPEC §4.2: 分かれた数を題で言う）
  if (FILING_KINDS.has(k) && a.pm === "?" && b.pm !== "?")
    out.push({ code: b.pm === "a" ? "PERM_A" : b.pm === "s" ? "PERM_S" : "PERM_N", m: m0 + 1, x: {}, at: { ym1: m0 + 1, ym2: m0 + 2 }, ...(id === "a1" ? { env: { a1: 1 } } : id === "a0" ? { env: { a0: 1 } } : {}) });
  if (a.j !== "i" && b.j === "i") out.push({ code: "IND_START", m: m0 + 2, x: { overhead: slot(C.overhead) }, at: { ym1: m0 + 1, ym2: m0 + 2 } });
  // 移った・戻った会社: 届け出の範囲を持っていく・出し直す・SpellDash だけを認める会社を選ぶ。顧客は引き継ぎ先に渡す（truth-11・SPEC §2.3 #5）
  let handover = 0;
  const newEmployer = (switched: boolean): void => {
    if (bh < pl) {
      handover = pl - bh;
      out.push({ code: "NEW_EMP_HANDOVER", m: m0 + 3, x: { lost: pl === ph ? slot(pl - bh) : `${slot(pl - bh)}〜${slot(ph - bh)}` } });
    } else if (bh === 0 && ph > 0) out.push({ code: "NEW_EMP_HANDOVER", m: m0 + 3, x: {}, env: { maybe: 1 } });
    if (b.pm === a.pm && (a.pm === "a" || a.pm === "s")) out.push({ code: a.pm === "a" ? "NEW_EMP_CARRY_A" : "NEW_EMP_CARRY_S", m: m0 + 3, x: {} });
    else if (!switched && b.pm === "s") out.push({ code: "NEW_EMP_SONLY", m: m0 + 3, x: {} });
    else if (b.pm === "?") out.push({ code: a.pm === "?" ? "NEW_EMP_FILE" : "NEW_EMP_REFILE", m: m0 + 3, x: {} });
  };
  if (k === "back_emp" && mixed) out.push({ code: "BACK_MIX", m: at, x: {} });
  else {
    if (a.j === "i" && b.j !== "i") {
      out.push({ code: "BACK_EMP", m: at, x: {} });
      newEmployer(false);
    }
    if ((k === "back_emp" || k === "plan_back") && b.j === "i") out.push({ code: "BACK_NO", m: at, x: {} });
  }
  if (k === "part" && mixed) out.push({ code: "PART_MIX", m: at, x: {} });
  else {
    if (a.j === "e" && b.j === "p") out.push({ code: "PART_ON", m: at, x: { salx: `${slot(f2(map.rr(n)[0]))} 倍` } });
    if (k === "part" && b.j === "e") out.push({ code: "PART_NO", m: at, x: {} });
  }
  // 転職: 結果の名前で決める（2 回目の転職でも移ったと分かる）。上げ幅の違う結果をまとめた high_mid は平均の倍率で言い、片方の上げ幅を言わない（facts-1）
  const search = k === "fc_switch" || k === "fc_switch2";
  const moved = search && /^(high|mid|high_mid)$/.test(id);
  if (moved) {
    if (id === "high_mid") out.push({ code: "SWITCH_MIX", m: at, x: { salx: `${slot(f2(b.sal))} 倍`, hiX: `${slot(f2(a.sal * C.switchHigh))} 倍`, midX: `${slot(f2(a.sal * C.switchMid))} 倍` }, at: { ym3: at } });
    else out.push({ code: b.sal / Math.max(1e-9, a.sal) >= 1.13 ? "SWITCH_HIGH" : "SWITCH_MID", m: at, x: { salx: `${slot(f2(b.sal))} 倍` }, at: { ym3: at } });
    newEmployer(true);
  } else if (search) out.push({ code: mixed ? "SEARCH_MIX" : "SEARCH_NONE", m: at, x: {} });
  if (k === "fc_push") {
    if (mixed) out.push({ code: "PROMO_MIX", m: at, x: { share: shareSlot(factShare(C, k, a.fl)), salx: `${slot(f2(b.sal))} 倍` }, at: { ymApril: at } });
    else out.push({ code: id === "up" ? "PROMO" : "PROMO_NO", m: at, x: { salx: `${slot(f2(b.sal))} 倍` }, at: { ymApril: at } });
  }
  // Pro の受付: 認められている手の 2 か月目。期間の途中で独立したなら、独立した翌月（sim.ts の latePro。truth-10）
  if (a.pro === 0 && b.pro === 1 && !out.some((e) => e.code === "PERM_A" || e.code === "PERM_S")) {
    const pm = out.some((e) => e.code === "IND_START") ? m0 + 3 : m0 + 2;
    out.push({ code: "PRO_START", m: pm, x: {}, at: { ym2: pm } });
  }
  const cap = capOf(C, b.j);
  const jobName = b.j === "i" ? "独立" : b.j === "p" ? "週 4 日勤務" : "会社員";
  // 上限に届いた一言は、同じ働き方で道に 1 回だけ（離れて取り戻すたびに言わない。点検 C6）。まとめた幅の下が上限に届いたときだけ
  const capSaid = (): boolean => {
    for (let l: Link | null = up; l; l = l.up) for (const e of l.evs) if (e.x.capNote && e.x.capJob === jobName) return true;
    return false;
  };
  const capNote = bl >= cap && !capSaid() ? `${jobName}で持てる ${slot(cap)} 社の上限に届いた。` : "";
  const cnt = bl === bh ? slot(bl) : `${slot(bl)}〜${slot(bh)}`;
  if (bl > ph) {
    // 確かに増えた（幅が重ならない）。道で確かにいた顧客が一度も無ければ 1 社目、前に確かにいた数までなら取り戻した
    const first = ph === 0 && up.bestCl === 0;
    out.push({ code: first ? "FIRST_CLIENT" : bh <= up.bestCl ? "CLIENT_REGAIN" : "CLIENT_UP", m: m0 + 2, x: { nth: slot(bl), cnt, add: slot(bl - ph), capNote, capJob: jobName }, env: { exact: exact ? 1 : 0, cdef: bl === bh ? 1 : 0, many: bh >= 2 ? 1 : 0, add: exact ? bl - ph : 0 } });
  } else if (bh < pl - handover) {
    // 確かに減った（引き継ぎで手放した分は、離れた顧客として数えない）
    out.push({ code: "CLIENT_LOST", m: m0 + 2, x: { lost: exact ? slot(pl - handover - bh) : "", cnt }, env: { exact: exact ? 1 : 0, cdef: bl === bh ? 1 : 0 } });
  } else if (SEARCH_KINDS.has(k) && bl !== bh) {
    // 決まった場合とまだの場合をまとめた結果（この結果の顧客の数が幅。reader-9）。幅が 1 社なら、多い方の見込みは平均から出る
    const share = bh - bl === 1 ? b.cl - bl : -1;
    const known = share > 0.05 && share < 0.95;
    out.push({ code: "CLIENT_MIX", m: m0 + 3, x: { cnt, ...(known ? { share: wari(share), hi: slot(bh) } : {}) }, env: { share: known ? 1 : 0 } });
  } else if (SEARCH_KINDS.has(k) && pl !== ph) {
    // 前の期がまとめた幅で、この結果の顧客の数は 1 つに決まる（社数で分けた結果）。まとめた見積もり・幅とは言わず、決まった数を言う。
    // 前の幅の下（0 社）か上かで言い方を分ける（兄弟の文の骨組みをそろえない。truth-2）
    out.push({ code: "CLIENT_EXACT", m: m0 + 3, x: { cnt, prev: `${slot(pl)}〜${slot(ph)}` }, env: { zero: bl === 0 ? 1 : 0, top: bl === ph ? 1 : 0 } });
  } else if ((k === "ad_side" || k === "ad_more") && exact && bl === pl) out.push({ code: "CLIENT_NOT_FOUND", m: m0 + 3, x: {} });
  for (const [flag, on, off, kindOf, mix] of FLAG_EVENTS) {
    if (k !== kindOf) continue;
    if (mixed) out.push({ code: mix, m: at, x: { share: shareSlot(factShare(C, k, a.fl)), seats: slot(C.schoolSeats) } });
    // 学校の席は、この 3 か月に加わった分（2 校目なら 2 校目の席。facts-3）
    else out.push({ code: b.fl.includes(flag) && (!a.fl.includes(flag) || flag === "school") && id === "yes" ? on : off, m: at, x: { seats: slot(n0(Math.max(0, b.seats - a.seats))) } });
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

/** 印・出来事（あり / なし / まとめた）・その印を付ける手の種類 */
const FLAG_EVENTS: ReadonlyArray<readonly [string, string, string, string, string]> = [
  ["school", "SCHOOL_ON", "SCHOOL_NO", "sd_school", "SCHOOL_MIX"],
  ["pilot", "PILOT_ON", "PILOT_NO", "sd_pilot", "PILOT_MIX"],
  ["portfolio", "PORTFOLIO_ON", "PORTFOLIO_NO", "ad_portfolio", "PORTFOLIO_MIX"],
];

// ---- 手の値（同じ見積もり方で比べる。SPEC §2.4 の q と、まとめた手の行き先の e）

/** w(x) = x[0]·年収/12 + x[1] + x[2]（万円。src/model/impact.ts と同じ） */
export const wOf = (annual: number, x: R3): number => x[0] * (annual / 12) + x[1] + x[2];

/** 判断のおすすめの手（why=best、無ければ今のまま、それも無ければ先頭） */
export function recommended(map: MapData, d: number): number {
  let base = -1;
  for (let k = 0; k < map.childCount(d); k++) {
    const a = map.child(d, k);
    if (map.why(a) === "best") return a;
    if (map.isBase(a) && base < 0) base = a;
  }
  return base >= 0 ? base : map.child(d, 0);
}

/** 手の一番ありそうな結果（同じ見込みなら並びの先） */
export function likeliest(map: MapData, a: number): number {
  let o = map.child(a, 0);
  for (let k = 1; k < map.childCount(a); k++) if (map.p(map.child(a, k)) > map.p(o)) o = map.child(a, k);
  return o;
}

/**
 * 手 a を選んだ場合の、その判断から 36 か月目までの稼ぎの見積もり（万円）。広げた手は q（その 3 か月は正確に・その後は標準の選び方）、
 * まとめた手は行き先の e の見込みの重みつきの和（同じ見積もり方。truth-2）。どちらも無ければ null
 */
export function optionValue(map: MapData, a: number, annual: number): number | null {
  const q = map.q(a);
  if (q) return wOf(annual, q);
  if (!map.stub(a) || !map.childCount(a)) return null;
  let v = 0;
  for (let k = 0; k < map.childCount(a); k++) {
    const o = map.child(a, k);
    if (!map.sum(o)) return null;
    v += (map.p(o) / 100) * wOf(annual, map.e(o));
  }
  return v;
}

// ---- 手引き（3 か月ごとに 3 つ。同じ道では同じ歩みを繰り返さない）

/**
 * 手 a で使う手引きの歩み（その種類を選ぶのが nth 回目・道で使った歩み used・直前の 3 つの手が使った歩み recent・道で決まる条件の値 extra）。
 * 種類の手引きと _generic を使い切った長い道（同じ手が何期も続く）では、直前の 3 つの手より前に使った種類の歩みをもう一度やることにする
 * （やることを空にしない。もう一度使う歩みの文は本文に入れない。点検 C3）。
 * 今のままは、どの判断にも並ぶ手なので、手引きの始まりを判断の月で回す（道の上の判断ごとに同じ歩みを並べない。reader-8）
 */
export function stepsFor(c: Ctx, a: number, nth: number, used: ReadonlySet<string>, recent: ReadonlySet<string> = used, extra: Env = {}): Step[] {
  const { map, B, C } = c;
  const kind = map.kind(a) ?? "";
  const s = map.st(a);
  const m = map.month(a);
  const book0 = B.playbook[kind] ?? B.playbook._generic ?? [];
  // 判断ごとに 3 つずらす（続く判断の今のままの歩みが重ならない）
  const r = kind === "keep" && book0.length ? m % book0.length : 0;
  const book = r ? [...book0.slice(r), ...book0.slice(0, r)] : book0;
  const env: Env = { ...extra, j: s.j, pm: s.pm, pro: s.pro, cl: s.cl, clr: clr(s.cl), pu: s.pu, mau: s.mau, sal: s.sal, seats: s.seats, cap: capOf(C, s.j), m, mon: c.cal.parts(m)[1], n: nth, first: m === 0 ? 1 : 0 };
  const out: Step[] = [];
  // 同じ番号の歩みは 1 回だけ（試作は種類の手引きと _generic の両方にある番号を 2 回入れることがあった）
  const take = (st: Step): void => {
    if (out.length < 3 && !used.has(st.id) && !out.some((x) => x.id === st.id) && cond(st.if, env, s.fl)) out.push(st);
  };
  for (const st of book) take(st);
  // 道の上でその種類の手引きを使い切ったら、_generic の歩みで埋める
  if (out.length < 3) for (const st of B.playbook._generic ?? []) take(st);
  // それでも足りなければ、直前の 3 つの手より前に使った種類の歩み（1 年近く前の歩みを、もう一度やる）
  if (out.length < 3) for (const st of book) if (out.length < 3 && used.has(st.id) && !recent.has(st.id) && !out.some((x) => x.id === st.id) && cond(st.if, env, s.fl)) out.push(st);
  return out;
}
