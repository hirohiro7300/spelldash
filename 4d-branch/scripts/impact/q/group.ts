// 3 か月の数え上げを、見込み（%）付きの結果にまとめる（3 か月ごとの世界の split のまとめ方）。元の ../group.ts（同梱の版 6 の元。変えない）と同じ手順に、
// P2 の決まりを足す（作業メモ SPEC v1 §2.2）:
//   事実（会社の答え・仕事・試用／導入／実績・転職したか）は決して平均しない: 小さい組も、同じ事実の組とだけまとめる
//   顧客は整数の社数: 社数で分けた結果の名前は、その組に本当にある社数（例「顧客 1〜2 社」）。社数の違う場合をまとめた組の状態は、場合の混ざり（帳簿）を持つ
// 線（ln）は元と同じ: 数の線は全体を隙間・重なり無く覆う区間、分類の線はその組の分類

import { signature, whenText, type Line } from "../group";
import { round2, round4, type Driver, type Vec3 } from "../sim";
import { isSearch } from "./quarter";
import { BookAcc, runRateQ, setBook, type QSample, type QSt } from "./sim";
import type { WorldQ } from "./world";

export interface OutcomeQ {
  /** 鍵に使う短い名前（同じ分け方なら作り直しても変わらない） */
  id: string;
  /** 見込み（整数の %、合計 100） */
  p: number;
  w: number;
  st: QSt;
  r: Vec3;
  lab: string;
  /** カードの短い名前（7 文字幅まで） */
  short: string;
  line: string;
  ln: Line;
  sig: string;
  local: number;
}

/** 代表の状態: 分類は一番重い物（同じ重さなら先に出た物）・数は重みの平均・印は半分以上が持つ物・顧客は場合の混ざり（帳簿。社数はどの場合も整数） */
export function repStateQ(w: WorldQ, items: ReadonlyArray<{ x: QSt; w: number }>): QSt {
  let total = 0;
  let mau = 0;
  let pu = 0;
  let seats = 0;
  let sal = 0;
  let cv = 0;
  const jw = new Map<string, number>();
  const pmw = new Map<string, number>();
  const prow = new Map<number, number>();
  const flags = new Map<string, number>();
  const acc = new BookAcc();
  for (const s of items) {
    const x = s.x;
    const v = s.w;
    total += v;
    mau += x.mau * v;
    pu += x.pu * v;
    seats += x.seats * v;
    sal += x.sal * v;
    cv += x.cv * v;
    jw.set(x.j, (jw.get(x.j) ?? 0) + v);
    pmw.set(x.pm, (pmw.get(x.pm) ?? 0) + v);
    prow.set(x.pro, (prow.get(x.pro) ?? 0) + v);
    for (const f of x.fl) flags.set(f, (flags.get(f) ?? 0) + v);
    for (const c of x.cb) acc.add(c.n, c.f5, c.w * v);
  }
  // 一番重い物（同じ重さなら先に出た物。並べ替えの安定な順と同じ）
  const mode = <T>(m: Map<T, number>): T => {
    let best: T | undefined;
    let bw = -Infinity;
    for (const [k, v] of m)
      if (v > bw) {
        bw = v;
        best = k;
      }
    return best!;
  };
  const fl: string[] = [];
  for (const [f, v] of flags) if (v / total >= 0.5) fl.push(f);
  fl.sort();
  const x: QSt = {
    j: mode(jw) as QSt["j"],
    pm: mode(pmw) as QSt["pm"],
    pro: mode(prow) as QSt["pro"],
    mau: round2(mau / total),
    pu: round2(pu / total),
    seats: Math.round(seats / total),
    cl: 0,
    fee: 0,
    sal: round4(sal / total),
    cv: round4(cv / total),
    fl,
    cb: [],
  };
  return setBook(w, x, acc.book());
}

/** 社数の分布（社数 → 重み。社数の小さい順） */
export function clientDist(st: QSt): Array<[number, number]> {
  const m = new Map<number, number>();
  for (const c of st.cb) {
    const k = c.n[0] + c.n[1] + c.n[2];
    m.set(k, (m.get(k) ?? 0) + c.w);
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]);
}

/**
 * 社数の違う場合をまとめた状態の幅: まとめた分布の 10%〜90%（整数の社数。MapMix・扇の図と同じ取り方）。1 つの社数だけなら無し。
 * 下限と上限が同じこともある（例: 2 社が 9 割を超える → [2, 2]。まとめた状態であることは幅があることで分かる）
 */
export function bandOf(_w: WorldQ, st: QSt): { cl: [number, number] } | undefined {
  const d = clientDist(st);
  if (d.length < 2) return undefined;
  let acc = 0;
  let lo = -1;
  let hi = -1;
  for (const [k, p] of d) {
    acc += p;
    if (lo < 0 && acc >= 0.1 - 1e-12) lo = k;
    if (hi < 0 && acc >= 0.9 - 1e-12) hi = k;
  }
  return { cl: [lo, hi < 0 ? d.at(-1)![0] : hi] };
}

function meanR(samples: QSample[]): Vec3 {
  const total = samples.reduce((a, s) => a + s.w, 0);
  return [round4(samples.reduce((a, s) => a + s.r[0] * s.w, 0) / total), round2(samples.reduce((a, s) => a + s.r[1] * s.w, 0) / total), round2(samples.reduce((a, s) => a + s.r[2] * s.w, 0) / total)];
}

interface Group {
  keys: string[];
  order: number;
  samples: QSample[];
  w: number;
  local: number;
  sig: string;
  /** 数の線の区間（バケットの下限・上限） */
  lo: number | null;
  hi: number | null;
  /** 測る数の範囲（顧客は整数の社数） */
  vmin: number;
  vmax: number;
}

function bucketOf(v: number, edges: number[]): number {
  let b = 0;
  for (const e of edges) if (v >= e) b++;
  return b;
}

/** 数え上げを結果にまとめる。S は月給（まとめる判断の目安の値に使う）。kind は手（続ける転職活動 fc_switch2 もそのまま） */
export function groupOutcomesQ(w: WorldQ, kind: string, driver: Driver, s0: QSt, m0: number, samples: QSample[], maxOuts: number, S: number): OutcomeQ[] {
  const mEnd = m0 + 3;
  const localOf = (smp: QSample): number => {
    const rr = runRateQ(w, smp.x);
    return S * smp.r[0] + smp.r[1] + smp.r[2] + (S * rr[0] + rr[1] + rr[2]) * Math.max(0, w.horizon - mEnd);
  };
  const salRatio = (x: QSt) => x.sal / Math.max(1e-9, s0.sal);
  const metricOf = (x: QSt): number => {
    if (driver.t === "num") return driver.metric === "cl" ? Math.round(x.cl) : driver.metric === "pu" ? x.pu : x.mau;
    if (driver.t === "sal") return salRatio(x);
    return 0;
  };
  const edges = driver.t === "num" ? w.buckets[driver.metric] : [];
  const catOf = (smp: QSample): { key: string; order: number } => {
    const x = smp.x;
    if (driver.t === "none") return { key: "all", order: 0 };
    if (driver.t === "num") {
      const b = bucketOf(metricOf(x), edges);
      return { key: `${driver.metric}${b}`, order: b };
    }
    if (driver.t === "sal") return { key: smp.tag || "none", order: 0 };
    switch (driver.metric) {
      case "perm":
        return { key: x.pm, order: x.pm === "a" ? 0 : x.pm === "s" ? 1 : 2 };
      case "job":
        return { key: x.j, order: x.j === "p" ? 0 : x.j === "e" ? 1 : 2 };
      case "flag":
        return x.fl.includes(driver.flag!) ? { key: "yes", order: 0 } : { key: "no", order: 1 };
      case "permside":
        return { key: smp.tag, order: ["a1", "a0", "s", "n"].indexOf(smp.tag) };
      default:
        return { key: "all", order: 0 };
    }
  };
  // 事実: 会社の答え（a0・a1 はどちらも『全部可』）・仕事・試用／導入／実績・転職したか。null は事実でない（数・昇格・分け方が無い）
  const factOfKey = (key: string): string | null => {
    if (driver.t === "cat") return driver.metric === "perm" || driver.metric === "permside" ? key.charAt(0) : key;
    if (driver.t === "sal" && isSearch(kind)) return key === "none" ? "stay" : "move";
    return null;
  };
  const factOf = (g: Group): string | null => {
    const fs = new Set(g.keys.map(factOfKey));
    return fs.size === 1 ? [...fs][0]! : "*";
  };
  const sameFact = (a: Group, b: Group) => factOf(a) === factOf(b);
  // 1) 初めの組
  const map = new Map<string, Group>();
  for (const smp of samples) {
    const { key, order } = catOf(smp);
    let g = map.get(key);
    if (!g) {
      const b = driver.t === "num" ? bucketOf(metricOf(smp.x), edges) : -1;
      g = { keys: [key], order, samples: [], w: 0, local: 0, sig: "", lo: b >= 0 ? (b === 0 ? null : edges[b - 1]!) : null, hi: b >= 0 ? (b < edges.length ? edges[b]! : null) : null, vmin: Infinity, vmax: -Infinity };
      map.set(key, g);
    }
    g.samples.push(smp);
    const v = metricOf(smp.x);
    g.vmin = Math.min(g.vmin, v);
    g.vmax = Math.max(g.vmax, v);
  }
  const refresh = (g: Group) => {
    g.w = g.samples.reduce((a, s) => a + s.w, 0);
    g.local = g.samples.reduce((a, s) => a + localOf(s) * s.w, 0) / g.w;
    g.sig = signature(repStateQ(w, g.samples));
  };
  let groups = [...map.values()];
  groups.forEach(refresh);
  const ordered = driver.t === "num" || driver.t === "sal";
  const sortGroups = () => {
    if (driver.t === "sal") groups.sort((a, b) => a.samples.reduce((s, x) => s + metricOf(x.x) * x.w, 0) / a.w - b.samples.reduce((s, x) => s + metricOf(x.x) * x.w, 0) / b.w);
    else groups.sort((a, b) => a.order - b.order);
  };
  sortGroups();
  const merge = (i: number, j: number) => {
    const [a, b] = i < j ? [i, j] : [j, i];
    const ga = groups[a]!;
    const gb = groups[b]!;
    const g: Group = {
      keys: [...ga.keys, ...gb.keys],
      order: Math.min(ga.order, gb.order),
      samples: [...ga.samples, ...gb.samples],
      w: 0,
      local: 0,
      sig: "",
      lo: ga.lo === null || gb.lo === null ? null : Math.min(ga.lo, gb.lo),
      hi: ga.hi === null || gb.hi === null ? null : Math.max(ga.hi, gb.hi),
      vmin: Math.min(ga.vmin, gb.vmin),
      vmax: Math.max(ga.vmax, gb.vmax),
    };
    refresh(g);
    groups.splice(b, 1);
    groups.splice(a, 1, g);
  };
  const minP = w.minOutcomeP / 100;
  const nearest = (i: number, cand: number[]) =>
    cand.sort((a, b) => Number(groups[b]!.sig === groups[i]!.sig) - Number(groups[a]!.sig === groups[i]!.sig) || Math.abs(groups[a]!.local - groups[i]!.local) - Math.abs(groups[b]!.local - groups[i]!.local))[0]!;
  // 2) 小さい組（10% 未満）を隣（分類なら似た組）にまとめる。同じ事実の組が無ければ、小さいまま残す（事実は平均しない）
  const alone = new Set<Group>();
  for (let guard = 0; guard < 50 && groups.length > 1; guard++) {
    let i = -1;
    let least = Infinity;
    groups.forEach((g, k) => {
      if (!alone.has(g) && g.w < minP - 1e-12 && g.w < least) (least = g.w), (i = k);
    });
    if (i < 0) break;
    const cand = (ordered ? [i - 1, i + 1].filter((k) => k >= 0 && k < groups.length) : groups.map((_, k) => k).filter((k) => k !== i)).filter((k) => sameFact(groups[k]!, groups[i]!));
    if (!cand.length) {
      alone.add(groups[i]!);
      continue;
    }
    merge(i, nearest(i, cand));
    sortGroups();
  }
  // 3) 次の手が同じ・同じ事実で、値の差が小さい隣どうしはまとめる（意味のある分かれ道だけ残す）
  const band = w.neutralBand;
  for (let guard = 0; guard < 50 && groups.length > 1; guard++) {
    let best = -1;
    let bestJ = -1;
    let diff = Infinity;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        if (ordered && j !== i + 1) continue;
        if (groups[i]!.sig !== groups[j]!.sig || !sameFact(groups[i]!, groups[j]!)) continue;
        const d = Math.abs(groups[i]!.local - groups[j]!.local);
        if (d < band && d < diff) (diff = d), (best = i), (bestJ = j);
      }
    }
    if (best < 0) break;
    merge(best, bestJ);
    sortGroups();
  }
  // 4) 数を抑える（ふつう 3 個。次の手が全部違うなら 4 個まで）。違う事実どうしはまとめない
  for (let guard = 0; guard < 50; guard++) {
    const distinct = new Set(groups.map((g) => g.sig)).size === groups.length;
    if (groups.length <= maxOuts || (distinct && groups.length <= maxOuts + 1)) break;
    let best = -1;
    let bestJ = -1;
    let score = Infinity;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        if (ordered && j !== i + 1) continue;
        if (!sameFact(groups[i]!, groups[j]!)) continue;
        const same = groups[i]!.sig === groups[j]!.sig;
        const d = Math.abs(groups[i]!.local - groups[j]!.local) + (same ? 0 : 1e6);
        if (d < score) (score = d), (best = i), (bestJ = j);
      }
    }
    if (best < 0) break;
    merge(best, bestJ);
    sortGroups();
  }
  // 線が全体を覆うように、いちばん下の組の下限・いちばん上の組の上限を外す
  if (driver.t === "num" && groups.length > 1) {
    groups[0]!.lo = null;
    groups[groups.length - 1]!.hi = null;
    // 間に数の無い区間があれば下の組に含める（隙間・重なりを無くす）
    for (let i = 0; i + 1 < groups.length; i++) groups[i]!.hi = groups[i + 1]!.lo;
  }
  // 5) 見込み（整数 %、合計 100）。事実の小さい組が 0% にならないように、一番大きい組から 1% ずつ回す
  const total = groups.reduce((a, g) => a + g.w, 0);
  const raw = groups.map((g) => (g.w / total) * 100);
  const fl = raw.map(Math.floor);
  const order = raw.map((v, i) => [v - fl[i]!, i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const missing = 100 - fl.reduce((a, b) => a + b, 0);
  for (let k = 0; k < missing; k++) fl[order[k % order.length]![1]]!++;
  if (groups.length > 1)
    for (let i = 0; i < fl.length; i++) {
      if (fl[i]! > 0) continue;
      let big = 0;
      for (let k = 1; k < fl.length; k++) if (fl[k]! > fl[big]!) big = k;
      fl[big]!--;
      fl[i] = 1;
    }
  // 6) 線と名前
  const salCuts: number[] = [];
  if (driver.t === "sal") {
    for (let i = 0; i + 1 < groups.length; i++) salCuts.push(Math.round(((groups[i]!.vmax + groups[i + 1]!.vmin) / 2) * 100) / 100);
  }
  return groups.map((g, i) => {
    const st = repStateQ(w, g.samples);
    const r = meanR(g.samples);
    const { id, lab, line, ln } = describe(driver, g, i, groups.length, salCuts, m0, mEnd, kind);
    return { id, p: groups.length === 1 ? 100 : fl[i]!, w: g.w / total, st, r, lab, short: shortOf(driver, g, groups.length, kind), line, ln, sig: g.sig, local: g.local };
  });
}

const SHORT_TAG: Record<string, string> = {
  high: "大幅増で転職",
  mid: "微増で転職",
  none: "転職せず",
  up: "昇格",
  same: "据え置き",
  a: "全部可",
  s: "SpellDashだけ",
  n: "どちらも不可",
  a1: "全部可・1社目",
  a0: "全部可・まだ",
};

/** 社数の範囲の文（顧客は整数の社数。本当にある社数だけを書く） */
const clRange = (lo: number, hi: number) => (lo === hi ? `${lo} 社` : `${lo}〜${hi} 社`);

/** カードの短い名前（半角は 0.5 として 7 文字幅まで） */
function shortOf(driver: Driver, g: Group, n: number, kind: string): string {
  if (driver.t === "none" || n === 1) return "";
  if (driver.t === "num") {
    if (driver.metric === "cl") return g.vmin === g.vmax ? `顧客${g.vmin}社` : `顧客${g.vmin}〜${g.vmax}社`;
    const name = driver.metric === "pu" ? "有料" : "遊ぶ人";
    const unit = driver.metric === "pu" ? "人" : "";
    const { lo, hi } = g;
    if (lo === null && hi !== null) return hi === 1 ? `${name}0${unit}` : `${name}〜${hi - 1}${unit}`;
    if (hi === null && lo !== null) return `${name}${lo}${unit}〜`;
    if (lo !== null && hi !== null) return hi - lo === 1 ? `${name}${lo}${unit}` : `${name}${lo}〜${hi - 1}${unit}`;
    return name;
  }
  if (driver.t === "cat" && driver.metric === "job") {
    const k = g.keys.length === 1 ? g.keys[0]! : "";
    if (kind === "back_emp") return k === "e" ? "会社員に戻る" : k === "i" ? "独立のまま" : "";
    return k === "p" ? "週4日に" : k === "e" ? "認められず" : "";
  }
  if (driver.t === "cat" && driver.metric === "flag") {
    const yes = g.keys.length === 1 && g.keys[0] === "yes";
    const T: Record<string, [string, string]> = { pilot: ["試用が決まる", "見つからず"], portfolio: ["実績ができる", "成果が出ず"], school: ["導入が決まる", "見送り"] };
    const t = T[driver.flag!];
    return g.keys.length > 1 || !t ? "" : yes ? t[0] : t[1];
  }
  if (driver.t === "cat" && driver.metric === "permside" && isAllAnswer(g.keys)) return SHORT_TAG.a!;
  return g.keys.map((k) => SHORT_TAG[k] ?? k).join("・");
}

/** 『全部可』の 1 社目が決まる・まだ をまとめた組 */
const isAllAnswer = (keys: string[]) => keys.length === 2 && keys.includes("a0") && keys.includes("a1");

const PERM_TEXT: Record<string, string> = { a: "『副業も SpellDash も可』", s: "『SpellDash だけ可』", n: "『どちらも不可』" };
const PERM_LAB: Record<string, string> = { a: "全部可", s: "SpellDash だけ", n: "どちらも不可" };

/** 数の線の区間の文（線は全体を覆う区間。顧客の線は社数の整数） */
function rangeText(metric: string, lo: number | null, hi: number | null): { lab: string; range: string } {
  const unit = metric === "cl" ? "社" : "人";
  const name = metric === "cl" ? "顧客" : metric === "pu" ? "有料" : "遊ぶ人";
  const fmt = (n: number) => n.toLocaleString("ja-JP");
  if (lo === null && hi === null) return { lab: `${name}`, range: "（どれでも）" };
  if (lo === null) {
    if (hi === 1) return { lab: `${name} 0 ${unit}`, range: `0 ${unit}` };
    return { lab: `${name} ${fmt(hi! - 1)} ${unit}以下`, range: `${fmt(hi! - 1)} ${unit}以下` };
  }
  if (hi === null) return { lab: `${name} ${fmt(lo)} ${unit}以上`, range: `${fmt(lo)} ${unit}以上` };
  if (hi - lo === 1) return { lab: `${name} ${fmt(lo)} ${unit}`, range: `${fmt(lo)} ${unit}` };
  return { lab: `${name} ${fmt(lo)}〜${fmt(hi - 1)} ${unit}`, range: `${fmt(lo)}〜${fmt(hi - 1)} ${unit}` };
}

function describe(driver: Driver, g: Group, i: number, n: number, salCuts: number[], m0: number, mEnd: number, kind: string): { id: string; lab: string; line: string; ln: Line } {
  const when = whenText(mEnd);
  if (driver.t === "none" || n === 1) {
    return { id: "all", lab: "—", line: "（どの場合もこの道）", ln: { metric: "none", at: mEnd, lo: null, hi: null, cat: "all" } };
  }
  if (driver.t === "num") {
    const metricName = driver.metric === "cl" ? "広告運用の顧客" : driver.metric === "pu" ? "有料会員" : "遊ぶ人（月）";
    const { lab, range } = rangeText(driver.metric, g.lo, g.hi);
    // 顧客の名前は、その組に本当にある社数（線は全体を覆う区間のまま）
    const name = driver.metric === "cl" ? `顧客 ${clRange(g.vmin, g.vmax)}` : lab;
    return { id: `${driver.metric}${g.lo ?? 0}`, lab: name, line: `${when}の${metricName}が ${range}`, ln: { metric: driver.metric, at: mEnd, lo: g.lo, hi: g.hi } };
  }
  if (driver.t === "sal") {
    const lo = i === 0 ? null : salCuts[i - 1]!;
    const hi = i === n - 1 ? null : salCuts[i]!;
    const tags = g.keys;
    const labOf = (t: string) => ({ high: "大きく上げて転職", mid: "少し上げて転職", none: "転職せず", up: "昇格", same: "据え置き" })[t] ?? t;
    const lab = tags.length === 1 ? labOf(tags[0]!) : tags.map(labOf).join("・");
    const f = (x: number) => x.toFixed(2).replace(/0$/, "");
    const range = lo === null ? `${f(hi!)} 倍未満` : hi === null ? `${f(lo)} 倍以上` : `${f(lo)}〜${f(hi)} 倍`;
    const id = tags.slice().sort().join("_");
    // 倍は期間の初めの給与に対して（今日からの期間なら「今の」）
    return { id, lab, line: `${when}の給与が${m0 === 0 ? "今" : ` ${whenText(m0)}`}の ${range}`, ln: { metric: "sal", at: mEnd, lo, hi } };
  }
  const keys = g.keys.slice().sort();
  const id = keys.join("_");
  switch (driver.metric) {
    case "perm":
      return { id, lab: keys.map((k) => PERM_LAB[k]).join("か"), line: `会社の答えが${keys.map((k) => PERM_TEXT[k]).join("か")}`, ln: { metric: "perm", at: mEnd, lo: null, hi: null, cat: id } };
    case "job": {
      const back = kind === "back_emp";
      if (keys.length > 1) return { id, lab: "どちらでも", line: "（どの場合もこの道）", ln: { metric: "job", at: mEnd, lo: null, hi: null, cat: id } };
      const k = keys[0]!;
      if (back) return k === "e" ? { id, lab: "会社員に戻る", line: "会社員として採用が決まる", ln: { metric: "job", at: mEnd, lo: null, hi: null, cat: k } } : { id, lab: "独立のまま", line: "採用が決まらず独立のまま", ln: { metric: "job", at: mEnd, lo: null, hi: null, cat: k } };
      return k === "p" ? { id, lab: "週 4 日に", line: "週 4 日勤務が認められる", ln: { metric: "job", at: mEnd, lo: null, hi: null, cat: k } } : { id, lab: "認められず", line: "週 4 日勤務が認められない", ln: { metric: "job", at: mEnd, lo: null, hi: null, cat: k } };
    }
    case "flag": {
      const yes = keys.length === 1 && keys[0] === "yes";
      const both = keys.length > 1;
      const T: Record<string, [string, string, string, string]> = {
        pilot: ["試用が決まる", "試してくれる学校・塾が見つかる", "見つからず", "試してくれる学校・塾が見つからない"],
        portfolio: ["実績ができる", "手伝った店で成果が出て実績になる", "成果が出ず", "手伝ったが実績になる成果は出ない"],
        school: ["導入が決まる", "学校が導入を決める", "見送られる", "導入は見送られる"],
      };
      const t = T[driver.flag!]!;
      if (both) return { id, lab: "どちらでも", line: "（どの場合もこの道）", ln: { metric: driver.flag!, at: mEnd, lo: null, hi: null, cat: id } };
      return { id, lab: yes ? t[0] : t[2], line: yes ? t[1] : t[3], ln: { metric: driver.flag!, at: mEnd, lo: null, hi: null, cat: id } };
    }
    case "permside": {
      if (isAllAnswer(keys)) return { id, lab: PERM_LAB.a!, line: `会社の答えが${PERM_TEXT.a}`, ln: { metric: "permside", at: mEnd, lo: null, hi: null, cat: id } };
      const T: Record<string, [string, string]> = {
        a1: ["全部可・1 社目", "『全部可』で副業の 1 社目が決まる"],
        a0: ["全部可・まだ", "『全部可』だが 1 社目はまだ決まらない"],
        s: ["SpellDash だけ", "会社の答えが『SpellDash だけ可』"],
        n: ["どちらも不可", "会社の答えが『どちらも不可』"],
      };
      return { id, lab: keys.map((k) => T[k]![0]).join("か"), line: keys.map((k) => T[k]![1]).join("か、"), ln: { metric: "permside", at: mEnd, lo: null, hi: null, cat: id } };
    }
    default:
      return { id, lab: id, line: id, ln: { metric: "cat", at: mEnd, lo: null, hi: null, cat: id } };
  }
}
