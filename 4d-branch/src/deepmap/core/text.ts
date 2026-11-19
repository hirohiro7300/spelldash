// カードの文章の入口（TextSource）と、地図の数だけで作る仮の文章（設計: 作業メモ SPEC v1 §4.1・§4.2・§5.4）
// 本当の文章は文章の組み立て（src/demo/compose）が作り、試し版は src/preview/composeText.ts でこの入口につなぐ。
// 見取り図・道の画面はこの入口だけを使う（ここでは組み立てをまねない）。仮の文章も英字の鍵は出さない。
// 仮の文章は、行の見出しにすでに出ている事（年月・手の名前・結果と見込み）を繰り返さず、数から分かる事だけを書く:
//   手      結果ごとの 3 か月後の月の稼ぎ（判断の月の稼ぎと並べて）
//   状態    3 か月前の判断から変わった所（仕事・会社の答え・年収・顧客・Pro・有料・遊ぶ人・学校の席）
//   まとめた行き先  標準の選び方で続けた多くの道の平均であること（mix があればその中身）
// 判断の線の文（map.line: 「6 か月後の給与が 3 か月後の 1.07 倍未満」）は 0 か月目からの数え方で、行の年月と食い違うので使わない（作業メモ user-4）。

import type { ImpactSt } from "../../demo/impact";
import type { MapData, MapMix, MapTodo } from "../mapData";
import { destClassOf, destLabel } from "./dest";
import { ymText } from "./time";

/** まとめた行き先の後の標準の続きの 1 期の文章（その期の標準の手と一番ありそうな出来事。見積もりの代表の 1 本） */
export interface ContText {
  title: string;
  body: string;
  /** やること（元にしたやりたいことリストの番号つき） */
  todo: readonly MapTodo[];
}

export interface TextSource {
  /** 題名 */
  title(i: number): string;
  /** 短い名前（並びや帯の中） */
  short(i: number): string;
  /** 本文 */
  body(i: number): string;
  /** 数字の行（年収・広告運用・有料・遊ぶ人・週の時間。状態と行き先のカードの上に固定で出す） */
  numbers(i: number): string[];
  /** 仮の文章（地図の数だけで作った物）。画面は本文に「文章は仮」と付ける。文章の組み立ては付けない（無ければ仮ではない） */
  readonly provisional?: boolean;
  /**
   * まとめた行き先 i の標準の続き（map.cont(i)）の k 番目の期の文章。無ければ null。
   * 持つ作り手なら、道の画面はまとめた手の後の薄い行を押して開ける（開いたときに 1 期ずつ呼ぶ）。仮の文章は持たない（行は年月と手の名前だけ）
   */
  cont?(i: number, k: number): ContText | null;
}

/** 手の種類の名前（見出しの名前。無ければ「別の手」） */
export function kindLabel(map: MapData, kind: string): string {
  return map.header.kinds[kind]?.[0] ?? "別の手";
}

const JOB: Record<ImpactSt["j"], string> = { e: "会社員", p: "週 4 日", i: "独立" };
const PERM: Record<ImpactSt["pm"], string> = { "?": "まだ", a: "全部可", s: "SpellDash だけ可", n: "どちらも不可" };

function int(x: number): string {
  return Math.round(x).toLocaleString("en-US");
}

function man(x: number): string {
  const a = Math.abs(x);
  const s = a < 10 ? (Math.round(a * 10) / 10).toFixed(1).replace(/\.0$/, "") : Math.round(a).toLocaleString("en-US");
  return `${x < 0 && s !== "0" ? "−" : ""}${s} 万円`;
}

/** 月の稼ぎ（小数 1 桁） */
function manMonthly(x: number): string {
  const a = Math.abs(x);
  return `${x < 0 && a >= 0.05 ? "−" : ""}${(Math.round(a * 10) / 10).toFixed(1)} 万円`;
}

function yen(x: number): string {
  const v = Math.round(x * 10000);
  return `${v < 0 ? "−" : ""}${Math.abs(v).toLocaleString("en-US")} 円`;
}

function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

function range(r: readonly [number, number, number], unit: string): string {
  const lo = Math.round(r[0]);
  const hi = Math.round(r[2]);
  return lo === hi ? `${lo} ${unit}` : `${lo}〜${hi} ${unit}`;
}

/** 状態・行き先の数字の行（まとめた行き先は標準の続きの平均: 先頭にそう書き、数は「約」で丸める。いくつかの場合をまとめた結果は顧客の数を幅で） */
function stateNumbers(map: MapData, i: number, annual: number): string[] {
  const st = map.st(i);
  const rr = map.rr(i);
  const sum = map.sum(i);
  const mix: MapMix | null = sum ? map.mix(i) : null;
  const cb = map.band(i)?.cl ?? null;
  // 平均の数（多くの道・いくつかの場合）: 「約」を付けて丸める（作業メモ user-6・truth-3）
  const avg = sum || cb !== null;
  const about = avg ? "約 " : "";
  const S = annual / 12;
  const out: string[] = [];
  if (sum) out.push("標準の続きの平均");
  out.push(rr[0] > 0 ? `年収 ${about}${int(rr[0] * annual)} 万円（月にならして ${about}${man(rr[0] * S)}）` : "給与なし");
  if (mix) out.push(`広告運用 ${range(mix.cl, "社")}（月 約 ${man(rr[1])}）`);
  else if (sum) {
    if (rr[1] !== 0) out.push(`広告運用 月 約 ${man(rr[1])}`);
  } else if (cb) {
    const lo = Math.min(cb[0], cb[1]);
    const hi = Math.max(cb[0], cb[1]);
    out.push(lo === hi ? `広告運用 ${lo} 社（月 ${man(rr[1])}）` : `広告運用 ${lo}〜${hi} 社（いくつかの場合をまとめた道。月 ${man(rr[1])}は平均）`);
  } else if (st.cl > 0 || rr[1] !== 0 || st.j === "i") {
    // 幅の書いていない端数（開発用の木）は丸めず平均と書く
    const frac = Math.abs(st.cl - Math.round(st.cl)) > 0.05;
    out.push(frac ? `広告運用 平均 ${st.cl.toFixed(1)} 社（月 ${man(rr[1])}）` : `広告運用 ${Math.round(st.cl)} 社（月 ${man(rr[1])}）`);
  }
  if (mix) out.push(mix.pro >= 0.5 ? `有料 ${range(mix.pu, "人")}（月 約 ${man(rr[2])}）` : "Pro はまだのことが多い");
  else if (!st.pro) out.push("Pro はまだ");
  else if (avg) out.push(`有料 約 ${int(st.pu)} 人（手数料とサーバー代を引いて月 約 ${man(rr[2])}）`);
  else out.push(`有料 ${Math.round(st.pu)} 人（手数料とサーバー代を引いて月 ${yen(rr[2])}）`);
  out.push(mix ? `月に遊んだ人 ${range(mix.mau, "人")}` : `月に遊んだ人 ${about}${int(st.mau)} 人`);
  return out;
}

/** 英数字と記号だけの文字（鍵に見える） */
function ascii(s: string): boolean {
  return /^[\x20-\x7e]+$/.test(s);
}

/**
 * 地図の数だけで作る仮の文章（文章の組み立てが入るまで。provisional = true）。
 * やること（map.todo）は本文に入れない（画面がやることの並びとして別に出す。組み立てた本文と同じ扱い）。
 * 結果が 1 つの手の結果（「どの場合も」）は名前にしない: 状態は「〜の状態」、行き先は行き先の種類（仕事・会社の答え・副業・Pro）
 */
export function fallbackText(map: MapData, opts: { annual: number }): TextSource {
  const anchor = map.header.anchor;
  const annual = opts.annual;
  const S = annual / 12;
  const at = (m: number) => {
    try {
      return ymText(anchor, m);
    } catch {
      return `${m} か月後`;
    }
  };
  const monthly = (i: number) => {
    const r = map.rr(i);
    return r[0] * S + r[1] + r[2];
  };
  /** 結果が 1 つの手の結果 */
  const single = (i: number): boolean => {
    const par = map.parent(i);
    return par >= 0 && map.role(par) === "a" && map.childCount(par) === 1;
  };
  const outName = (i: number): string => {
    const lab = map.label(i);
    return lab && !ascii(lab) && lab !== "—" ? lab : "その結果";
  };
  const title = (i: number): string => {
    const r = map.role(i);
    const t = map.title(i);
    if (r === "r") return t && !ascii(t) ? t : "今日";
    if (r === "a") return t && !ascii(t) ? t : kindLabel(map, map.kind(i) ?? "");
    const lab = map.label(i);
    // 組み立てた題名（結果の名前をそのまま写しただけの物は除く）
    if (t && !ascii(t) && t !== lab) return t;
    if (r === "e") return destLabel(destClassOf(map.st(i), map.sum(i) ? map.mix(i) : null, map.band(i)));
    return lab && !ascii(lab) && lab !== "—" && !single(i) ? lab : `${at(map.month(i))}の状態`;
  };
  /** 手: 結果ごとの 3 か月後の月の稼ぎ（判断の月の稼ぎと並べる）。まとめた手は、結果ごとの 2029 年 11 月の月の稼ぎ（多くの道の平均） */
  const optionBody = (i: number): string => {
    const n = map.childCount(i);
    if (n === 0) return "";
    const d = map.parent(i);
    const first = map.child(i, 0);
    const avg = map.stub(i) ? "多くの道の平均。" : "";
    const now = `${avg}${at(map.month(d))}は ${manMonthly(monthly(d))}`;
    if (n === 1) return `${at(map.month(first))}の月の稼ぎ ${manMonthly(monthly(first))}（${now}）。`;
    const outs: string[] = [];
    for (let k = 0; k < n; k++) {
      const c = map.child(i, k);
      outs.push(`${outName(c)} ${manMonthly(monthly(c))}`);
    }
    return `結果ごとの ${at(map.month(first))}の月の稼ぎ（${now}）: ${outs.join("・")}。`;
  };
  /** 状態・行き先: 3 か月前の判断から変わった所 */
  const changeBody = (i: number): string => {
    const opt = map.parent(i);
    const prev = opt >= 0 ? map.parent(opt) : -1;
    if (prev < 0) return "";
    const a = map.st(prev);
    const b = map.st(i);
    const ra = map.rr(prev);
    const rb = map.rr(i);
    const merged = !!map.band(i)?.cl;
    const ch: string[] = [];
    if (a.j !== b.j) ch.push(`仕事 ${JOB[a.j] ?? "?"} → ${JOB[b.j] ?? "?"}`);
    if (a.pm !== b.pm) ch.push(`会社の答え ${PERM[a.pm] ?? "?"} → ${PERM[b.pm] ?? "?"}`);
    if (Math.abs(ra[0] - rb[0]) * annual >= 0.5) ch.push(rb[0] > 0 ? `年収 ${int(ra[0] * annual)} → ${merged ? "約 " : ""}${int(rb[0] * annual)} 万円` : "給与なし");
    const cb = map.band(i)?.cl;
    const clA = Math.round(a.cl);
    if (cb && Math.min(cb[0], cb[1]) !== Math.max(cb[0], cb[1])) {
      ch.push(`広告運用の顧客 ${clA} → ${Math.min(cb[0], cb[1])}〜${Math.max(cb[0], cb[1])} 社`);
    } else {
      const clB = cb ? cb[0] : b.cl;
      if (Math.abs(clB - a.cl) >= 0.5) ch.push(Math.abs(clB - Math.round(clB)) > 0.05 ? `広告運用の顧客 ${clA} → 平均 ${clB.toFixed(1)} 社` : `広告運用の顧客 ${clA} → ${Math.round(clB)} 社`);
    }
    if (a.pro !== b.pro) ch.push(b.pro ? "Pro を出した" : "Pro をやめた");
    else if (b.pro && Math.abs(b.pu - a.pu) >= 0.5) ch.push(`有料 ${int(a.pu)} → ${merged ? "約 " : ""}${int(b.pu)} 人`);
    if (Math.abs(b.mau - a.mau) >= 1) ch.push(`月に遊んだ人 ${int(a.mau)} → ${merged ? "約 " : ""}${int(b.mau)} 人`);
    if (Math.round(a.seats) !== Math.round(b.seats)) ch.push(`学校の席 ${int(a.seats)} → ${int(b.seats)}`);
    const since = at(map.month(prev));
    const tail = merged ? "（いくつかの場合をまとめた結果。数は平均）" : "";
    return ch.length ? `${since}から変わった所: ${ch.join("・")}${tail}。` : `${since}から大きな変わりは無い${tail}。`;
  };
  /** まとめた行き先: 多くの道の平均（年月を頭に付けない。まとめた手の結果の文も使わない） */
  const summaryBody = (i: number): string => {
    const parts = [`標準の選び方で ${at(map.header.horizon)}まで続けた多くの道の平均。`];
    const mix = map.mix(i);
    if (mix) {
      const fx: string[] = [];
      if (mix.switched > 0.005) fx.push(`転職した ${pct(mix.switched)}`);
      if (mix.j.i > 0.005) fx.push(`独立した ${pct(mix.j.i)}`);
      if (mix.j.p > 0.005) fx.push(`週 4 日 ${pct(mix.j.p)}`);
      fx.push(`Pro を出した ${pct(mix.pro)}`);
      if (mix.school > 0.005) fx.push(`学校の席がある ${pct(mix.school)}`);
      parts.push(`その道の中で${fx.join("・")}。`);
    }
    return parts.join("");
  };
  return {
    provisional: true,
    title,
    short: (i) => map.short(i) || title(i),
    body: (i) => {
      const r = map.role(i);
      if (r === "r") return `${at(0)}時点の地図。ここから 3 か月ごとに手を 1 つ選び、${at(map.header.horizon)}まで続く。`;
      if (r === "a") return optionBody(i);
      if (map.sum(i)) return summaryBody(i);
      return changeBody(i);
    },
    numbers: (i) => {
      const r = map.role(i);
      if (r === "a") {
        const h = map.hours(i);
        return h ? [`週の時間 ${h > 0 ? "+" : "−"}${Math.abs(h)} 時間`] : [];
      }
      return stateNumbers(map, i, annual);
    },
  };
}
