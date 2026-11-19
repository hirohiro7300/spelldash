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
// 状態: 年月と出来事 → 出来事の助言 → 節目からの月（節目が変わったときだけ）→ 静かな期の一言 → 同じ手の別の結果との違い → 次の問い → 暦
// 行き先: 年月と仕事 → まとめた行き先の注 → 節目 → 月の稼ぎ → この先の見通し → この道で月の稼ぎを一番動かした結果（まとめた行き先は、標準の続きの目安）
import type { MapContStep, MapData, MapMix } from "../../deepmap/mapData";
import type { ImpactSt, R3 } from "../impact";
import { capOf, clBand, countEvent, countKind, endLink, eventMonth, eventsList, factShare, jobMonths, linkFor, linkOf, mergedFact, newFeeOf, optionValue, pathEnv, recentSteps, recommended, ripple, sideIn, stepsFor, usedSet, type Ctx, type Ev, type Link, type TitleEntry } from "./path";
import { clPhrase, clr, cond, f2, hash, man, n0, pbText, renyo, slot, spaceJa, strip, wari, yenTxt, type Env } from "./text";
import type { Card, Step, Variant } from "./types";

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

/** 手の種類の名詞（この後の目安の並び）。束に無ければ地図の手の名前、それも無ければ言い換え */
const kindNoun = (c: Ctx, kind: string): string => c.B.nextNoun[kind] ?? c.map.header.kinds[kind]?.[0] ?? "別の手";
/** 手の種類の短い名前 */
const kindShort = (c: Ctx, kind: string): string => c.B.short[kind] ?? c.map.header.kinds[kind]?.[0] ?? "別の手";
/** 手をした後の言い方（「前の 3 か月は担当を広げた」。reader-10: 名詞で「〜こと。」と結ばない） */
const kindDid = (c: Ctx, kind: string): string => c.B.did[kind] ?? (c.map.header.kinds[kind] ? `『${c.map.header.kinds[kind]![0]}』を選んだ` : "別の手を選んだ");

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

/** 顧客の数の幅（まとめた行き先は丸めた平均の 1 点） */
const clBandOf = (c: Ctx, at: number): [number, number] => (c.map.sum(at) ? [clr(c.map.st(at).cl), clr(c.map.st(at).cl)] : clBand(c.map, at));

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
  const env: Env = { j: s.j, pm: s.pm, pro: s.pro, cl: s.cl, clr: clr(s.cl), clo, chi, pu: s.pu, mau: s.mau, sal: s.sal, seats: s.seats, cap, m, mon: cal.parts(m)[1], n: kind ? countKind(link, kind) : 0, first: m === 0 ? 1 : 0, h: 0, sal1: Math.abs(rr[0] - 1) < 0.005 ? 1 : 0, f5: link.f5 ? 1 : 0 };
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
    fee: slot(man(s.fee || newFee)),
    newFee: slot(man(newFee)),
    feeRaised: slot(man(C.feeRaised)),
    raiseAt: slot(C.raiseAt),
    indFee: slot(man(C.indFee)),
    overhead: slot(man(C.overhead)),
    spend: slot(man(C.spend)),
    cap: slot(cap),
    capInd: slot(C.capInd),
    pu: slot(n0(s.pu)),
    mau: slot(n0(s.mau)),
    sdRev: slot(man(rr[2])),
    seats: slot(n0(s.seats)),
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
  const [lo, hi] = clBand(map, at);
  if (map.band(at)?.cl && lo !== hi) return `広告運用 ${hi - lo === 1 ? `${slot(lo)} 社か ${slot(hi)} 社` : `${slot(lo)}〜${slot(hi)} 社`}（平均 月 ${rev} 万円）`;
  return `広告運用 ${bandClients(c, at) ?? clPhrase(s.cl, map.ln(at))}（売上 月 ${rev} 万円）`;
}

/** 有料の項目（学校の席は有料の人数に入っている。truth-5）。Pro の前もサーバー代はかかる（本文の月の稼ぎと合わせる。reader-4） */
function proItem(c: Ctx, s: ImpactSt, rr2: number, avg: string): string {
  if (!s.pro) return rr2 < -0.005 ? `Pro はまだ出していない（サーバー代 月 ${yenTxt(rr2)}の持ち出し）` : "Pro はまだ出していない";
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
  cl: ["FIRST_CLIENT", "CLIENT_UP", "CLIENT_REGAIN", "CLIENT_LOST", "CLIENT_NOT_FOUND", "CLIENT_MIX", "BACK_NO"],
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

const METRIC_NAME: Record<string, string> = { perm: "会社の答え", permside: "会社の答え", sal: "給与", cl: "広告運用の顧客の数", pu: "有料会員の数", mau: "遊ぶ人の数", job: "会社の返事", pilot: "試用の返事", school: "学校の返事", portfolio: "手伝った店の成果", ind: "顧客の数" };
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

/** 手を組み立てる値（題と本文で同じ物） */
function moveCtx(c: Ctx, a: number): { env: Env; slots: Slots; seed: number; nth: number; offered: number; link: Link; steps: ReturnType<typeof stepsFor>; fresh: ReturnType<typeof stepsFor> } {
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
  env.h = h;
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
  if (kind === "fc_push") s2.stepYen = `${slot(n0(promoGap(c, a)))} 万円`;
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

/** 標準の続きで会社員に戻る月（続きの手が会社員に戻る仕事探しで、戻る出来事がある最初の期）。無ければ null */
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
    const back = contBackMonth(c, o);
    const when = back !== null ? `${cal.ym(back)}に` : "";
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
    const labs = g.map((x) => `『${labelOf(c, x.o)}』`);
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

/** 分かれ目: 次の分かれ道がいつ・何で分かれ、それぞれ何を意味するか。nth は道でその種類を選んだ回数、rot は言い換えを回す数 */
function watchSentence(c: Ctx, a: number, slots: Slots, nth: number, rot: number, trace: string[]): string {
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
    // 担当を広げる手: 変わるのは次の 4 月の評価の見込みで、遊ぶ人の数ではない（reader-2）
    if (kind === "fc_scope") {
      trace.push("watch:scope");
      const ap = cal.aprils.find((q) => q > m);
      if (ap === undefined) return `${cal.ym(cal.horizon)}までに 4 月の評価は来ないので、担当を広げた分はこの地図の数には出ない。`;
      return [`この 3 か月で給与は変わらず、担当を広げた分は ${cal.ym(ap)}の評価で効く。`, `給与が動くのは ${cal.ym(ap)}の評価から。この 3 か月の数字はほぼ今のまま。`][rot % 2]!;
    }
    const parts: string[] = [];
    if (Math.abs(b.mau - s0.mau) >= 1) parts.push(`月に遊ぶ人は ${slot(n0(s0.mau))} 人から ${slot(n0(b.mau))} 人`);
    if (b.pro && Math.round(b.pu) !== Math.round(s0.pu)) parts.push(`有料会員は ${slot(n0(s0.pu))} 人から ${slot(n0(b.pu))} 人`);
    if (clr(b.cl) !== clr(s0.cl)) parts.push(`顧客は ${bandClients(c, o) ?? clPhrase(b.cl)}`);
    // 給与は払われる倍率で（週 4 日は 0.8 倍が掛かった額。facts-6）
    const r0 = map.rr(d)[0];
    const r1 = map.rr(o)[0];
    if (Math.abs(r1 - r0) >= 0.005 && b.j !== "i") parts.push(Math.abs(r1 - 1) < 0.005 ? "給与は今日と同じ" : `給与は今日の ${slot(f2(r1))} 倍`);
    if (!parts.length) return `${at}まで、数字はほぼ今のまま。`;
    trace.push("watch:single");
    // 同じ手が続くときに同じ骨組みにしない（道で何回目かで回す）
    const frames = [`${at}の見込みは、${parts.join("、")}ほど。`, `${at}には、${parts.join("、")}ほどになる見込み。`, `この 3 か月で、${parts.join("、")}ほどまで動く見込み。`];
    return frames[(hash(kind) + rot) % frames.length]!;
  }
  const metric = map.ln(ks[0]!)?.[0] ?? "";
  // 答えが出る月: 数で分かれる線はその 3 か月の終わり、事実はその手の出来事の月（届け出は翌月・週 4 日と学校は 2 か月目・昇格は 4 月。facts-7）
  const factAt = NUMERIC.has(metric) ? m + 3 : eventMonth(cal, kind, m);
  const mName = METRIC_NAME[metric] ?? "結果";
  const at = cal.ym(factAt);
  // 「見る数は」は数で分かれる線だけ（返事・成果は数ではない。reader-10）
  const third = NUMERIC.has(metric) ? `見る数は ${at}の${mName}。` : `答えが出るのは ${at}の${mName}。`;
  const heads = [`分かれ目は ${at}の${mName}。`, `${at}の${mName}で道が分かれる。`, third, `その先は ${at}の${mName}しだい。`, `この手の答えは ${at}の${mName}で出る。`];
  // 道の上で同じ数で分かれたのが何回目かで言い方を回す（転職活動・昇格のように同じ数で何度も分かれる道で、同じ書き出しを続けない）
  let seen = 0;
  for (let l: Link | null = linkOf(c, d); l; l = l.up) if (map.role(l.i) === "s" && map.ln(l.i)?.[0] === metric) seen++;
  const head = heads[(hash(metric) + seen) % heads.length]!;
  if (NUMERIC.has(metric)) {
    // まとめた手: 結果ごとの 3 年後までの稼ぎと標準の続きの中身（平均の売上を、その結果の 1 本の道の数として言わない。reader-5）
    if (ks.some((o) => map.sum(o))) return sumOutcomes(c, a, ks, head, rot, trace);
    // 数で分かれる: 結果の名前と、その数を 1 行で
    const num = (o: number): string => {
      const s = map.st(o);
      return metric === "cl" ? (s.cl * s.fee < 0.05 ? "広告運用の売上はまだ無い" : `売上 月 ${slot(man(s.cl * s.fee))} 万円ほど`) : metric === "pu" ? `有料 ${slot(n0(s.pu))} 人ほど` : `月に遊ぶ人 ${slot(n0(s.mau))} 人ほど`;
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
    env.pf0 = s0.fl.includes("portfolio") ? 1 : 0;
    // まとめた行き先（3 年後の平均）か: その数をこの 3 か月の結果として言わない（学校の席など。facts-3）
    env.sumOut = map.sum(o) ? 1 : 0;
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
    const fl = map.st(o).fl;
    // 同じ種類の手が続く判断では、言い換えを回す
    const seed = hash(`${kind}|${cls}`) + rot;
    const cell = bank[cls] ? cls : (cls === "a1" || cls === "a0") && bank.a ? "a" : "_any";
    const meaning = choose(bank[cell], env, fl, s3, seed, trace, `branch.${bankKind}.${cell}`) ?? choose(B.branch._generic?._any, env, fl, s3, seed, trace, "branch._generic._any");
    pieces.push(`『${labelOf(c, o)}』なら${meaning ?? ""}`);
  }
  return head + pieces.join("。") + "。";
}
/** 結果の意味の文でも、手の物を使う差し込み（年月・昇格の額・次の顧客の月額） */
const MOVE_SLOTS = ["ym", "period", "ymNext", "ym1", "ym2", "stepYen", "newFee"] as const;

/** この手の先の数（今日の手）。SPEC §5.1・truth-18: 判断と出来事の分かれを分け、まとめた行き先は見積もりと書く */
function rippleSentence(c: Ctx, a: number): string {
  const { map, cal } = c;
  const r = ripple(map, a);
  const ks = kidsOf(map, a);
  const per = ks.length >= 2 ? `${ks.map((o) => `${labelOf(c, o)}の後 ${slot(n0(ripple(map, o).forks))}`).join("・")}。` : "";
  const sums = r.sumEnds ? `で、うち ${slot(n0(r.sumEnds))} は標準の続きの見積もり` : "";
  return `この手の先、${cal.ym(cal.horizon)}までの分かれ道は ${slot(n0(r.forks))}（判断 ${slot(n0(r.decisions))}・出来事の分かれ ${slot(n0(r.splits))}）。${per}行き先は ${slot(n0(r.ends))}${sums}。`;
}

/** この手の先の分かれ道の数（今日より後の、広げた手。一つの手がこの先の分かれ道をどれだけ持つか。reader-2・user-13） */
function rippleShort(c: Ctx, a: number): string {
  const r = ripple(c.map, a);
  if (!r.forks) return "";
  return `この手の先、${c.cal.ym(c.cal.horizon)}までの分かれ道は ${slot(n0(r.forks))}（判断 ${slot(n0(r.decisions))}・出来事の分かれ ${slot(n0(r.splits))}）。`;
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
 * この手の 3 年の見積もり: その判断から 3 年後（36 か月目）までの稼ぎと、おすすめの手（おすすめの手なら今のまま、今日は今のまま）との差。
 * どれも同じ見積もり方（その 3 か月は正確に・その後は標準の選び方。SPEC §2.4 の q）。まとめた手は、先の分かれ道を開かない見積もりだと書く
 * （reader-1: 決まった一文の代わりに、この手自身の見積もりと差。reader-2: どの手のカードも 3 年への影響を言う）
 */
function valueSentence(c: Ctx, a: number, trace: string[]): string {
  const { map, cal } = c;
  const v = optionValue(map, a, c.annual);
  if (v === null) return "";
  const d = map.parent(a);
  const hz = cal.ym(cal.horizon);
  const best = hasBest(map, d);
  const ref = best ? recommended(map, d) : baseOf(map, d);
  const diff = (x: number, name: string): string => {
    const vr = optionValue(map, x, c.annual);
    if (vr === null) return "";
    const g = v - vr;
    return Math.abs(g) < 1 ? `${name}とほぼ同じ` : `${name}より ${amount(Math.abs(g))} 万円${g > 0 ? "多い" : "少ない"}`;
  };
  let cmp: string;
  if (ref === a) {
    // おすすめの手（今日なら比べる元の今のまま）: 今のままと比べる
    const base = baseOf(map, d);
    const vs = base >= 0 && base !== a ? diff(base, "今のまま") : "";
    cmp = best ? `おすすめの手${vs ? `で、${vs}` : ""}` : "ほかの手はこの道と比べる";
  } else cmp = ref >= 0 ? diff(ref, best ? `おすすめの『${titleOf(c, ref, [])}』` : "今のまま") : "";
  trace.push(map.stub(a) ? "value:stub" : "value");
  const head = `この手で進むと、ここから ${hz}までの稼ぎは合わせて ${amount(v)} 万円ほど${cmp ? `（${cmp}）` : ""}。`;
  // まとめた手の注（truth-2: 先は一番良い選び方ではなく、標準の選び方で続けた見積もり）
  return map.stub(a) ? `${head}この手の先は分かれ道を開かず、標準の選び方で続けた見積もり。` : head;
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
  const { env, slots: s2, seed, nth, offered, link, steps, fresh } = moveCtx(c, a);
  const fl = map.st(a).fl;
  const title = titleOf(c, a, trace);
  const lead = choose(B.lead[kind], env, fl, s2, seed, trace, `lead.${kind}`) ?? "";
  // 長い節がある手（今日の手の先の数・避けたい訳・まとめた手の結果ごとの見積もり）は、手引きの文を 1 つだけにする。本文に入れるのは、道で初めて使う歩みの文だけ
  const oneAct = map.role(d) === "r" || map.why(a) === "avoid" || map.stub(a);
  const acts = !oneAct && fresh.length >= 2 ? pbText(fresh[0]!.act) + pbText(fresh[1]!.act) : pbText(fresh[0]?.act ?? "");
  // お金と仕事・この先の見込みが変わる手だけ、その中身（週の時間は数の行。SPEC §4.2）。結果が事実の場合をまとめた 1 つなら、
  // 見込みは分かれ目の文で言うので重ねない
  const mergedOnly = map.childCount(a) === 1 && mergedFact(map, map.child(a, 0));
  const cost = B.cost[kind] && !mergedOnly ? (choose(B.cost[kind], env, fl, s2, seed, trace, `cost.${kind}`) ?? "") : "";
  const watch = watchSentence(c, a, s2, nth, offered, trace);
  const value = valueSentence(c, a, trace);
  // この手の先の分かれ道の数: 今日の手は結果ごと・行き先まで、ほかの広げた手は短く（まとめた手は先の分かれ道を開かないので書かない）
  const ripple1 = map.stub(a) ? "" : map.role(d) === "r" ? rippleSentence(c, a) : rippleShort(c, a);
  if (ripple1) trace.push("ripple");
  // 避けたい訳（道で 1 回だけ。その先の状態の段取りと同じ答え）
  let avoid = "";
  if (avoidAllowed(c, a, link)) {
    const av = avoidSlots(c, a);
    avoid = choose(B.avoid[kind], { ...env, needOk: av.needOk ? 1 : 0 }, fl, { ...s2, ...av }, seed, trace, `avoid.${kind}`) ?? "";
  }
  // ここへ来た訳: 名前の付いた結果（「どの場合も」でない）なら『結果』を受けて、そうでなければ前の 3 か月の手（状態の節目の文とは重ねない）
  const pm = map.parent(d);
  const prevKind = pm >= 0 && map.role(pm) === "a" ? map.kind(pm) : null;
  const came = map.role(d) === "s" && map.outId(d) !== "all" ? `『${labelOf(c, d)}』を受けて、` : prevKind && prevKind !== kind ? `前の 3 か月は${kindDid(c, prevKind)}。` : "";
  const body = join([came, lead, acts, cost, avoid, watch, value, ripple1]);
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

/**
 * 同じ手の別の結果（一番違う物）との違い。言い方は道の上の何期目かで回す。permOk: 答えの範囲の一言を書く（段取りで決めた）。
 * 顧客の数が幅（社数の違う場合をまとめた結果）なら、平均の売上の差は言わず、社数の幅が重ならないときだけ社数で比べる（reader-9）
 */
function contrastSentence(c: Ctx, o: number, permOk: boolean): string {
  const { map } = c;
  const sib = contrastSib(c, o);
  if (sib === null) return "";
  const so = map.st(o);
  const ss = map.st(sib);
  const d: string[] = [];
  let perm = "";
  const [ol, oh] = clBand(map, o);
  const [sl, sh] = clBand(map, sib);
  const banded = (ol !== oh && !!map.band(o)?.cl) || (sl !== sh && !!map.band(sib)?.cl);
  if (!banded) {
    const dAds = so.cl * so.fee - ss.cl * ss.fee;
    if (Math.abs(dAds) >= 0.5) d.push(`広告運用の売上が月 ${slot(man(Math.abs(dAds)))} 万円${dAds > 0 ? "多い" : "少ない"}`);
  } else if (ol > sh || oh < sl) d.push(`広告運用の顧客が${ol > sh ? "多い" : "少ない"}`);
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
  // 2 つの差は「〜多く、〜高い」とつなぐ（reader-10）
  const ds = d.length >= 2 ? `${renyo(d[0]!)}、${d[1]!}` : d[0]!;
  return [`同じ手で『${lab}』だった場合より、${ds}。`, `『${lab}』だった場合と比べると、${ds}。`, `別の結果の『${lab}』と比べて、${ds}。`, `『${lab}』の場合に比べ、${ds}。`, `${ds}（同じ手で『${lab}』だった場合と比べて）。`, `『${lab}』と比べると、この結果は${ds}。`, `この結果は、『${lab}』の場合より${ds}。`][k]! + perm;
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

/** 次の 3 か月の問い（言い方は 3 通りを回す） */
function nextSentence(c: Ctx, n: number): string {
  const { map, cal } = c;
  const alts = kidsOf(map, n).filter((x) => map.kind(x) !== "keep");
  if (!alts.length) return "次の 3 か月も今のまま続ける。";
  const ph = alts.map((a) => moveShortPhrase(c, a)).filter((x, k, arr) => arr.indexOf(x) === k).slice(0, 3);
  const frames = [`次の 3 か月は、${ph.join("、")}、今のままか。`, `${cal.ym(map.month(n) + 3)}までの手は、${ph.join("、")}、今のままか。`, `ここからは、${ph.join("、")}、何も足さないか。`];
  return frames[hash(map.key(n) + "next") % frames.length]!;
}

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
  const body = join([head, sinceClause(c, link, plan), hint, contrastSentence(c, n, plan.perm), nextSentence(c, n), calText]);
  const top = link.evs[0];
  // 短い名前: 一番の出来事の短い名前（試作は {nth} などを埋めずに返していた）
  const short = top ? (fill(B.eventShort[top.code] ?? "", { ...slots, ...top.x }) ?? "") : "";
  return { title: titleOf(c, n, trace), short, body, numbers: numbersRow(c, n), todo: [], trace };
}

// ---- 3 年後の行き先

/** 行き先の節目に並べる出来事（大事な順） */
const MILESTONE_RANK = ["IND_START", "BACK_EMP", "SWITCH_HIGH", "SWITCH_MID", "SWITCH_MIX", "PERM_A", "PERM_S", "PERM_N", "PART_ON", "PROMO", "FIRST_CLIENT", "SCHOOL_ON", "CLIENT_UP", "PILOT_ON", "PU_MILE", "PORTFOLIO_ON", "CLIENT_LOST", "PRO_START"];

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

/** 標準の続きの 1 期の言い方（種類と出来事の決まった言い方があればそれ。無ければ種類の名詞と出来事の名前。同じことを 2 回言わない。reader-5） */
function contName(c: Ctx, kind: string, ev: string | undefined): string {
  const { B } = c;
  if (ev && B.contNoun[`${kind}.${ev}`]) return B.contNoun[`${kind}.${ev}`]!;
  const noun = B.contNoun[kind] ?? kindNoun(c, kind);
  const evName = ev ? (CONT_EV[ev] ?? fill(B.eventShort[ev] ?? "", {})) : null;
  return evName && evName !== noun ? `${noun}（${evName}）` : noun;
}

/**
 * この後の目安（まとめた行き先の標準の続き。SPEC §4.2）。最後の月の稼ぎは中身の道の平均（その 1 本の道の数ではない。facts-9）。
 * 長ければ、仕事と届け出が変わる期を残して、その間の期を「ほか N 期」とまとめる（会社員に戻る・転職を隠さない）
 */
function contSentence(c: Ctx, cont: readonly MapContStep[], total: number): string {
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
    parts.push(`${cal.ymRel(st.m, prev)} ${contName(c, st.kind, st.ev)}${st.n > 1 ? `（${slot(st.n)} 期）` : ""}`);
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
 * この道で月の稼ぎを一番動かした結果（その 3 か月で、判断の状態から結果の状態へ月の稼ぎが一番動いた物）。行き先の結びを道から作る（reader-8）。
 * 今の年収で決まる
 */
function leverSentence(c: Ctx, link: Link): string {
  const { map, cal } = c;
  let best: Link | null = null;
  let bestD = 0;
  const w = (i: number): number => {
    const rr = map.rr(i);
    return salMan(c, rr[0]) + rr[1] + rr[2];
  };
  for (let l: Link | null = link; l && l.up; l = l.up) {
    if (map.sum(l.i)) continue;
    const dd = w(l.i) - w(l.up.i);
    if (Math.abs(dd) > Math.abs(bestD) + 1e-9) {
      best = l;
      bestD = dd;
    }
  }
  if (!best || Math.abs(bestD) < 1) return "";
  const what = map.outId(best.i) === "all" || map.childCount(best.move) < 2 ? `『${titleOf(c, best.move, [])}』の 3 か月` : `『${labelOf(c, best.i)}』`;
  return `この道で月の稼ぎを一番大きく動かしたのは、${cal.ym(map.month(best.i))}までの${what}で、月 ${sgn(bestD)}${slot(man(Math.abs(bestD)))} 万円。`;
}

/** 移った会社にいる月の数（道で一番新しい転職から）。転職していなければ −1 */
function switchedMonths(c: Ctx, link: Link): number {
  const evs = eventsList(link);
  for (let k = evs.length - 1; k >= 0; k--) if (evs[k]!.code.startsWith("SWITCH_")) return c.map.month(link.i) - evs[k]!.m;
  return -1;
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
    // 移って何か月か（在籍の長さを言う文はこの数で選ぶ。facts-8）
    const swm = switchedMonths(c, link);
    const after = choose(B.after, { ...env, swm }, s.fl, { ...slots, swn: slot(Math.max(0, swm)) }, hash(map.key(n)), trace, "after") ?? "";
    body = join([head, path, monthly, endContrast(c, n), after, leverSentence(c, link)]);
  } else {
    // まとめた行き先（truth-5・truth-2）: 中身の幅があれば 9 割がそろう事実だけを言い切り、無ければ平均だと書いて事実として言わない。
    // どの結果の後かを書き出しで言い、兄弟とはこの手からの稼ぎの合計で比べる（兄弟の行き先が同じ骨組みにならない。点検 C6）。
    // 中身と続きが同じ兄弟があれば、その名前を言い、違いの稼ぎの合計を先に置く（reader-5）
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
    const tail = cont && cont.length ? (trace.push("cont"), contSentence(c, cont, total)) : "この先の道は、この先の分かれ道での選び方と運で分かれる。";
    body = shared ? join([head, shared, sumSoFar(c, n), mix ? mixWords(mix) : "", path, monthly, tail]) : join([head, mix ? mixWords(mix) : "", path, monthly, sumSoFar(c, n), tail]);
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

/**
 * まとめた行き先 i の標準の続き（cont）の k 番目の期。その期の手の種類の書き出し・手引きの文 1 つ（道とそれまでの期で使っていない歩み）・
 * やること 3 つ・一番ありそうな出来事を書く。手引きの条件は、まとめた手を選んだ判断の状態で見る（続きの期の状態は地図に無い）
 */
export function composeContMarked(c: Ctx, i: number, k: number): ContCard | null {
  const { map, B, cal } = c;
  if (map.role(i) !== "e" || !map.sum(i)) return null;
  const cont = map.cont(i) ?? [];
  const step = cont[k];
  if (!step) return null;
  const stub = map.parent(i);
  const d = map.parent(stub);
  const link = linkOf(c, d);
  const used = new Set(usedSet(link));
  for (const st of stepsFor(c, stub, countKind(link, map.kind(stub) ?? ""), used, recentSteps(link), pathEnv(c, link))) used.add(st.id);
  const s0 = map.st(d);
  const { env: env0 } = baseEnv(c, d);
  let picked: Step[] = [];
  for (let x = 0; x <= k; x++) {
    const st = cont[x]!;
    const env: Env = { ...env0, n: cont.slice(0, x).filter((y) => y.kind === st.kind).length, m: st.m, mon: cal.parts(st.m)[1], first: 0 };
    const steps: Step[] = [];
    for (const one of [...(B.playbook[st.kind] ?? []), ...(B.playbook._generic ?? [])]) if (steps.length < 3 && !used.has(one.id) && !steps.some((y) => y.id === one.id) && cond(one.if, env, s0.fl)) steps.push(one);
    for (const one of steps) used.add(one.id);
    if (x === k) picked = steps;
  }
  const noun = B.contNoun[step.kind] ?? kindNoun(c, step.kind);
  const ev = step.ev ? (CONT_EV[step.ev] ?? fill(B.eventShort[step.ev] ?? "", {})) : null;
  const what = ev ? `この期に一番ありそうな出来事は『${ev}』。` : "大きな出来事の無い 3 か月の見込み。";
  const body = join([`${cal.period(step.m)}は、標準の選び方では『${noun}』の 3 か月。`, pbText(picked[0]?.act ?? ""), what, "まとめた行き先の標準の続きで、この期の分かれ道は開いていない。"]);
  return { m: step.m, kind: step.kind, title: contName(c, step.kind, step.ev), body, todo: picked.map((st) => ({ text: st.todo, cite: st.id })) };
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
