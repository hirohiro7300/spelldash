// 数え上げた結果を、見込み（%）付きの 1〜3 個（違う道になるなら 4 個まで）の結果にまとめる。
// 分け方（遊ぶ人・有料会員・顧客の数・給与・会社の答えなど）ごとに、測れる「判断の線」を作る（漏れ・重なりが無い）。

import { round2, round4, runRate, type Driver, type Sample, type St, type Vec3, type World } from "./sim";

export interface Line {
  /** 測る物 */
  metric: string;
  /** 何か月目に測るか */
  at: number;
  /** 数の線: 下限（含む）・上限（含まない）。null は無し。分類の線は cat */
  lo: number | null;
  hi: number | null;
  cat?: string;
}

export interface Outcome {
  /** 鍵に使う短い名前（同じ分け方なら作り直しても変わらない） */
  id: string;
  /** 見込み（整数の %、合計 100） */
  p: number;
  w: number;
  st: St;
  r: Vec3;
  lab: string;
  /** カードの短い名前（7 文字幅まで） */
  short: string;
  line: string;
  ln: Line;
  sig: string;
  local: number;
}

interface Group {
  keys: string[];
  order: number;
  samples: Sample[];
  w: number;
  local: number;
  sig: string;
  /** 数の線の区間（バケットの下限・上限） */
  lo: number | null;
  hi: number | null;
  /** 給与の倍率の範囲 */
  vmin: number;
  vmax: number;
}

export const whenText = (m: number): string => (m === 3 ? "3 か月後" : m === 12 ? "1 年後" : m === 24 ? "2 年後" : m === 36 ? "3 年後" : `${m} か月後`);

const coarseCl = (cl: number) => (Math.round(cl) <= 0 ? 0 : Math.round(cl) < 3 ? 1 : 2);
const coarsePu = (pu: number) => (pu < 1 ? 0 : pu < 30 ? 1 : 2);
const SIG_FLAGS = ["pilot", "portfolio", "scope", "switched", "school"];

/** 次に選べる手が変わる性質（同じなら結果をまとめてよい） */
export function signature(s: St): string {
  return [s.j, s.pm, s.pro, coarseCl(s.cl), coarsePu(s.pu), s.fl.filter((f) => SIG_FLAGS.includes(f)).join("+")].join("|");
}

function repState(samples: Sample[]): St {
  const total = samples.reduce((a, s) => a + s.w, 0);
  const mean = (f: (x: St) => number) => samples.reduce((a, s) => a + f(s.x) * s.w, 0) / total;
  const mode = <T>(f: (x: St) => T): T => {
    const m = new Map<T, number>();
    for (const s of samples) m.set(f(s.x), (m.get(f(s.x)) ?? 0) + s.w);
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  };
  const flags = new Map<string, number>();
  for (const s of samples) for (const f of s.x.fl) flags.set(f, (flags.get(f) ?? 0) + s.w);
  return {
    j: mode((x) => x.j),
    pm: mode((x) => x.pm),
    pro: mode((x) => x.pro),
    mau: round2(mean((x) => x.mau)),
    pu: round2(mean((x) => x.pu)),
    seats: Math.round(mean((x) => x.seats)),
    cl: round4(mean((x) => x.cl)),
    fee: round2(mean((x) => (x.cl > 0 ? x.fee : 0)) / Math.max(1e-9, mean((x) => (x.cl > 0 ? 1 : 0))) || 0),
    sal: round4(mean((x) => x.sal)),
    cv: round4(mean((x) => x.cv)),
    fl: [...flags.entries()]
      .filter(([, v]) => v / total >= 0.5)
      .map(([f]) => f)
      .sort(),
  };
}

function meanR(samples: Sample[]): Vec3 {
  const total = samples.reduce((a, s) => a + s.w, 0);
  return [round4(samples.reduce((a, s) => a + s.r[0] * s.w, 0) / total), round2(samples.reduce((a, s) => a + s.r[1] * s.w, 0) / total), round2(samples.reduce((a, s) => a + s.r[2] * s.w, 0) / total)];
}

function bucketOf(v: number, edges: number[]): number {
  let b = 0;
  for (const e of edges) if (v >= e) b++;
  return b;
}

/** 数え上げを結果にまとめる。S は月給（まとめる判断の目安の値に使う） */
export function groupOutcomes(w: World, kind: string, driver: Driver, s0: St, m0: number, L: number, samples: Sample[], maxOuts: number, S: number): Outcome[] {
  const H = w.horizon;
  const mEnd = m0 + L;
  const localOf = (smp: Sample): number => {
    const rr = runRate(w, smp.x);
    return S * smp.r[0] + smp.r[1] + smp.r[2] + (S * rr[0] + rr[1] + rr[2]) * Math.max(0, H - mEnd);
  };
  const salRatio = (x: St) => x.sal / Math.max(1e-9, s0.sal);
  const metricOf = (x: St): number => {
    if (driver.t === "num") return driver.metric === "cl" ? Math.round(x.cl) : driver.metric === "pu" ? x.pu : x.mau;
    if (driver.t === "sal") return salRatio(x);
    return 0;
  };
  const edges = driver.t === "num" ? w.buckets[driver.metric] : [];
  const catOf = (smp: Sample): { key: string; order: number } => {
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
      case "ind": {
        if (x.j !== "i") return { key: "e", order: 2 };
        return Math.round(x.cl) >= 5 ? { key: "i5", order: 0 } : { key: "i0", order: 1 };
      }
      default:
        return { key: "all", order: 0 };
    }
  };
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
    g.sig = signature(repState(g.samples));
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
  // 会社の答え（全部可・SpellDash だけ・不可）は会社ごとに決まった事実で、アプリは同じ答えの世界どうしで比べる（結果の線の meta.rv）。
  // 答えの違う組をまとめると、その比べ方と「結果の差の平均 = 手の差」が崩れるので、小さい組はまず同じ答えの組にまとめる
  const answerOf = (g: Group): string | null => {
    if (driver.t !== "cat" || (driver.metric !== "perm" && driver.metric !== "permside")) return null;
    const set = new Set(g.keys.map((k) => k.charAt(0)));
    return set.size === 1 ? [...set][0]! : "*";
  };
  // 2) 小さい組（10% 未満）を隣（分類なら似た組）にまとめる
  for (let guard = 0; guard < 50 && groups.length > 1; guard++) {
    let i = -1;
    let least = Infinity;
    groups.forEach((g, k) => {
      if (g.w < minP - 1e-12 && g.w < least) (least = g.w), (i = k);
    });
    if (i < 0) break;
    let j: number;
    if (ordered) {
      const cand = [i - 1, i + 1].filter((k) => k >= 0 && k < groups.length);
      j = cand.sort((a, b) => Number(groups[b]!.sig === groups[i]!.sig) - Number(groups[a]!.sig === groups[i]!.sig) || Math.abs(groups[a]!.local - groups[i]!.local) - Math.abs(groups[b]!.local - groups[i]!.local))[0]!;
    } else {
      let cand = groups.map((_, k) => k).filter((k) => k !== i);
      const ans = answerOf(groups[i]!);
      const same = ans === null ? [] : cand.filter((k) => answerOf(groups[k]!) === ans);
      if (same.length) cand = same;
      j = cand.sort((a, b) => Number(groups[b]!.sig === groups[i]!.sig) - Number(groups[a]!.sig === groups[i]!.sig) || Math.abs(groups[a]!.local - groups[i]!.local) - Math.abs(groups[b]!.local - groups[i]!.local))[0]!;
    }
    merge(i, j);
    sortGroups();
  }
  // 3) 次の手が同じで、値の差が小さい隣どうしはまとめる（意味のある分かれ道だけ残す）
  const band = w.neutralBand;
  for (let guard = 0; guard < 50 && groups.length > 1; guard++) {
    let best = -1;
    let bestJ = -1;
    let diff = Infinity;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        if (ordered && j !== i + 1) continue;
        if (groups[i]!.sig !== groups[j]!.sig) continue;
        const d = Math.abs(groups[i]!.local - groups[j]!.local);
        if (d < band && d < diff) (diff = d), (best = i), (bestJ = j);
      }
    }
    if (best < 0) break;
    merge(best, bestJ);
    sortGroups();
  }
  // 4) 数を抑える（ふつう 3 個。次の手が全部違うなら 4 個まで）
  for (let guard = 0; guard < 50; guard++) {
    const distinct = new Set(groups.map((g) => g.sig)).size === groups.length;
    if (groups.length <= maxOuts || (distinct && groups.length <= maxOuts + 1)) break;
    let best = -1;
    let bestJ = -1;
    let score = Infinity;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        if (ordered && j !== i + 1) continue;
        const same = groups[i]!.sig === groups[j]!.sig;
        const d = Math.abs(groups[i]!.local - groups[j]!.local) + (same ? 0 : 1e6);
        if (d < score) (score = d), (best = i), (bestJ = j);
      }
    }
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
  // 5) 見込み（整数 %、合計 100）
  const total = groups.reduce((a, g) => a + g.w, 0);
  const raw = groups.map((g) => (g.w / total) * 100);
  const fl = raw.map(Math.floor);
  const order = raw.map((v, i) => [v - fl[i]!, i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const missing = 100 - fl.reduce((a, b) => a + b, 0);
  for (let k = 0; k < missing; k++) fl[order[k % order.length]![1]]!++;
  // 6) 線と名前
  const salCuts: number[] = [];
  if (driver.t === "sal") {
    for (let i = 0; i + 1 < groups.length; i++) salCuts.push(Math.round(((groups[i]!.vmax + groups[i + 1]!.vmin) / 2) * 100) / 100);
  }
  return groups.map((g, i) => {
    const st = repState(g.samples);
    const r = meanR(g.samples);
    const { id, lab, line, ln } = describe(driver, g, i, groups.length, salCuts, m0, mEnd, kind, w.kinds.plan_ind?.p.threshold ?? 3);
    return { id, p: groups.length === 1 ? 100 : fl[i]!, w: g.w / total, st, r, lab, short: shortOf(driver, g, groups.length, ln, kind), line, ln, sig: g.sig, local: g.local };
  });
}

const SHORT_TAG: Record<string, string> = {
  high: "大幅増で転職",
  mid: "微増で転職",
  none: "転職せず",
  up: "昇格",
  same: "据え置き",
  u0: "昇格なし",
  u1: "昇格1回",
  u2: "昇格2回",
  a: "全部可",
  s: "SpellDashだけ",
  n: "どちらも不可",
  a1: "全部可・1社目",
  a0: "全部可・まだ",
  i5: "独立・5社〜",
  i0: "独立・4社以下",
};

/** カードの短い名前（半角は 0.5 として 7 文字幅まで） */
function shortOf(driver: Driver, g: Group, n: number, ln: Line, kind: string): string {
  if (driver.t === "none" || n === 1) return "";
  if (driver.t === "num") {
    const name = driver.metric === "cl" ? "顧客" : driver.metric === "pu" ? "有料" : "遊ぶ人";
    const unit = driver.metric === "cl" ? "社" : driver.metric === "pu" ? "人" : "";
    const lo = ln.lo;
    const hi = ln.hi;
    if (lo === null && hi !== null) return hi === 1 ? `${name}0${unit}` : `${name}〜${hi - 1}${unit}`;
    if (hi === null && lo !== null) return `${name}${lo}${unit}〜`;
    if (lo !== null && hi !== null) return hi - lo === 1 ? `${name}${lo}${unit}` : `${name}${lo}〜${hi - 1}${unit}`;
    return name;
  }
  if (driver.t === "cat" && driver.metric === "job") {
    const k = g.keys.length === 1 ? g.keys[0]! : "";
    const back = kind === "back_emp" || kind === "plan_back";
    if (back) return k === "e" ? "会社員に戻る" : k === "i" ? "独立のまま" : "";
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

function numText(metric: string, lo: number | null, hi: number | null): { lab: string; range: string } {
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

function describe(driver: Driver, g: Group, i: number, n: number, salCuts: number[], m0: number, mEnd: number, kind: string, indAt: number): { id: string; lab: string; line: string; ln: Line } {
  const when = whenText(mEnd);
  if (driver.t === "none" || n === 1) {
    return { id: "all", lab: "—", line: "（どの場合もこの道）", ln: { metric: "none", at: mEnd, lo: null, hi: null, cat: "all" } };
  }
  if (driver.t === "num") {
    const metricName = driver.metric === "cl" ? "広告運用の顧客" : driver.metric === "pu" ? "有料会員" : "遊ぶ人（月）";
    const { lab, range } = numText(driver.metric, g.lo, g.hi);
    return { id: `${driver.metric}${g.lo ?? 0}`, lab, line: `${when}の${metricName}が ${range}`, ln: { metric: driver.metric, at: mEnd, lo: g.lo, hi: g.hi } };
  }
  if (driver.t === "sal") {
    const lo = i === 0 ? null : salCuts[i - 1]!;
    const hi = i === n - 1 ? null : salCuts[i]!;
    const tags = g.keys;
    const labOf = (t: string) =>
      ({ high: "大きく上げて転職", mid: "少し上げて転職", none: "転職せず", up: "昇格", same: "据え置き", u0: "昇格なし", u1: "昇格 1 回", u2: "昇格 2 回" })[t] ?? t;
    const lab = tags.length === 1 ? labOf(tags[0]!) : tags.map(labOf).join("・");
    const f = (x: number) => x.toFixed(2).replace(/0$/, "");
    const range = lo === null ? `${f(hi!)} 倍未満` : hi === null ? `${f(lo)} 倍以上` : `${f(lo)}〜${f(hi)} 倍`;
    const id = tags.slice().sort().join("_");
    // 倍は期間の初めの給与に対して（今日からの期間なら「今の」）
    return { id, lab, line: `${when}の給与が${m0 === 0 ? "今" : whenText(m0)}の ${range}`, ln: { metric: "sal", at: mEnd, lo, hi } };
  }
  const keys = g.keys.slice().sort();
  const id = keys.join("_");
  switch (driver.metric) {
    case "perm":
      return { id, lab: keys.map((k) => PERM_LAB[k]).join("か"), line: `会社の答えが${keys.map((k) => PERM_TEXT[k]).join("か")}`, ln: { metric: "perm", at: mEnd, lo: null, hi: null, cat: id } };
    case "job": {
      const back = kind === "back_emp" || kind === "plan_back";
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
    case "ind": {
      const T: Record<string, [string, string]> = {
        i5: ["独立・5 社以上", `2 年後に ${indAt} 社以上で独立し、3 年後の顧客が 5 社以上`],
        i0: ["独立・4 社以下", `2 年後に ${indAt} 社以上で独立し、3 年後の顧客が 4 社以下`],
        e: ["会社員のまま", `2 年後の顧客が ${indAt} 社に届かず、会社員のまま`],
      };
      return { id, lab: keys.map((k) => T[k]![0]).join("か"), line: keys.map((k) => T[k]![1]).join("か、"), ln: { metric: "ind", at: mEnd, lo: null, hi: null, cat: id } };
    }
    default:
      return { id, lab: id, line: id, ln: { metric: "cat", at: mEnd, lo: null, hi: null, cat: id } };
  }
}
