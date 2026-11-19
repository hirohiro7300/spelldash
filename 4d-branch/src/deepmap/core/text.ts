// カードの文章の入口（TextSource）と、地図の数だけで作る仮の文章（設計: 作業メモ SPEC v1 §4.1・§4.2）
// 本当の文章は文章の組み立て（src/demo/compose。別の作業）が作る。見取り図・道の画面はこの入口だけを使い、
// 組み立てができたら差し替える（ここでは組み立てをまねない）。仮の文章も英字の鍵は出さない。

import type { MapData, MapMix } from "../mapData";
import { quarterSpanText, ymText } from "./time";

export interface TextSource {
  /** 題名 */
  title(i: number): string;
  /** 短い名前（並びや帯の中） */
  short(i: number): string;
  /** 本文 */
  body(i: number): string;
  /** 数字の行（年収・広告運用・有料・遊ぶ人・週の時間。状態と行き先のカードの上に固定で出す） */
  numbers(i: number): string[];
}

/** 手の種類の名前（見出しの名前。無ければ「別の手」） */
export function kindLabel(map: MapData, kind: string): string {
  return map.header.kinds[kind]?.[0] ?? "別の手";
}

function man(x: number): string {
  const a = Math.abs(x);
  const s = a < 10 ? (Math.round(a * 10) / 10).toFixed(1).replace(/\.0$/, "") : Math.round(a).toLocaleString("en-US");
  return `${x < 0 && s !== "0" ? "−" : ""}${s} 万円`;
}

function yen(x: number): string {
  const v = Math.round(x * 10000);
  return `${v < 0 ? "−" : ""}${Math.abs(v).toLocaleString("en-US")} 円`;
}

function range(r: readonly [number, number, number], unit: string): string {
  const lo = Math.round(r[0]);
  const hi = Math.round(r[2]);
  return lo === hi ? `${lo} ${unit}` : `${lo}〜${hi} ${unit}`;
}

/** 状態・行き先の数字の行 */
function stateNumbers(map: MapData, i: number, annual: number): string[] {
  const st = map.st(i);
  const rr = map.rr(i);
  const mix: MapMix | null = map.sum(i) ? map.mix(i) : null;
  const S = annual / 12;
  const out: string[] = [];
  out.push(rr[0] > 0 ? `年収 ${Math.round(rr[0] * annual).toLocaleString("en-US")} 万円（月にならして ${man(rr[0] * S)}）` : "給与なし");
  if (mix) out.push(`広告運用 ${range(mix.cl, "社")}（月 ${man(rr[1])}）`);
  else if (st.cl > 0 || rr[1] !== 0 || st.j === "i") out.push(`広告運用 ${Math.round(st.cl)} 社（月 ${man(rr[1])}）`);
  if (mix) out.push(mix.pro >= 0.5 ? `有料 ${range(mix.pu, "人")}（月 ${yen(rr[2])}）` : "Pro はまだのことが多い");
  else out.push(st.pro ? `有料 ${Math.round(st.pu)} 人（手数料とサーバー代を引いて月 ${yen(rr[2])}）` : "Pro はまだ");
  out.push(mix ? `月に遊んだ人 ${range(mix.mau, "人")}` : `月に遊んだ人 ${Math.round(st.mau).toLocaleString("en-US")} 人`);
  return out;
}

/** 地図の数だけで作る仮の文章（文章の組み立てが入るまで） */
export function fallbackText(map: MapData, opts: { annual: number }): TextSource {
  const anchor = map.header.anchor;
  const at = (m: number) => {
    try {
      return ymText(anchor, m);
    } catch {
      return `${m} か月後`;
    }
  };
  const span = (m: number) => {
    try {
      return quarterSpanText(anchor, m);
    } catch {
      return `${m} か月後から 3 か月`;
    }
  };
  const title = (i: number): string => {
    const t = map.title(i);
    if (t && !/^[\x20-\x7e]+$/.test(t)) return t;
    const r = map.role(i);
    if (r === "r") return "今日";
    if (r === "a") return kindLabel(map, map.kind(i) ?? "");
    const lab = map.label(i);
    return lab && !/^[\x20-\x7e]+$/.test(lab) ? lab : r === "e" ? "3 年後" : `${at(map.month(i))}の状態`;
  };
  return {
    title,
    short: (i) => map.short(i) || title(i),
    body: (i) => {
      const r = map.role(i);
      const m = map.month(i);
      if (r === "r") return `${at(0)}時点の地図。ここから 3 か月ごとに手を 1 つ選び、${at(map.header.horizon)}まで続く。`;
      if (r === "a") {
        const h = map.hours(i);
        const todo = map.todo(i).map((t) => t.text);
        const parts = [`${span(m)}: ${kindLabel(map, map.kind(i) ?? "")}。`];
        if (h) parts.push(`週の時間は ${h > 0 ? "+" : "−"}${Math.abs(h)} 時間。`);
        if (todo.length) parts.push(`やること: ${todo.join("・")}。`);
        if (map.stub(i)) parts.push("この手の先は、標準の選び方で続けた見積もり。");
        return parts.join("");
      }
      const line = map.line(i) || map.label(i);
      const parts = [`${at(m)}。${line}（見込み ${Math.round(map.p(i))}%）。`];
      if (map.sum(i)) parts.push("この先は、標準の選び方で続けた見積もり。");
      return parts.join("");
    },
    numbers: (i) => {
      const r = map.role(i);
      if (r === "a") {
        const h = map.hours(i);
        return h ? [`週の時間 ${h > 0 ? "+" : "−"}${Math.abs(h)} 時間`] : [];
      }
      return stateNumbers(map, i, opts.annual);
    },
  };
}
