// 見取り図と手の詳しい画面で使う小さな部品: 3 年の分布の棒（9 段）・段の色の見本・差の札・分かれ方の細い棒・分かれ道の小さな帯

import { IMPACT_FILL, IMPACT_INK } from "../../model/impactFormat";
import { h, nobr, s } from "./dom";
import { binText, num, pct } from "./format";
import type { PillVM, SharePart, StripCol } from "./model";

const fill = (bin: number): string => IMPACT_FILL[bin] ?? IMPACT_FILL[0]!;

/** 段の中に割合を書く大きさ（これより小さい段は書かない） */
const SEG_LABEL_MIN = 0.12;

/**
 * 9 つの段の積み上げ棒（左 = 減る・右 = 増える。段のあいだは 2px あける。アプリの distRow と同じ見た目）。
 * 大きな段には割合を書く（指で触る端末は title が出ないので、色の見本を見に戻らなくても読めるように。作業メモ user-13）
 */
export function distBar(bins: readonly number[] | null, label: string): HTMLElement {
  const bar = h("span", { class: "dm-dist", attrs: { role: "img" } });
  const parts: string[] = [];
  if (!bins) {
    bar.classList.add("is-empty");
    bar.setAttribute("aria-label", `${label}: 数が出せない`);
    return bar;
  }
  bins.forEach((share, i) => {
    if (!(share > 0.0005)) return;
    const bin = i - 4;
    parts.push(`${binText(bin)} ${pct(share)}`);
    const seg = h("span", { class: "dm-dist-seg", title: `${binText(bin)}: ${pct(share)}`, style: { "flex-grow": String(share), background: fill(bin), color: IMPACT_INK[bin] ?? "#F0EFEC" } });
    if (share >= SEG_LABEL_MIN) seg.append(h("span", { class: "dm-dist-pct", attrs: { "aria-hidden": "true" } }, pct(share)));
    bar.append(seg);
  });
  bar.setAttribute("aria-label", `${label}: ${parts.join("、")}`);
  return bar;
}

/** 段の境目（万円） */
const SCALE_TICKS = ["−300", "−100", "−30", "−3", "+3", "+30", "+100", "+300"];

/** 段の色の見本（色の下に境目の数。減る ■■■■■■■■■ 増える）。作業メモ user-13 */
export function scaleLegend(title: string): HTMLElement {
  const sw = h("span", { class: "dm-scale-sw", attrs: { "aria-hidden": "true" } });
  for (let b = -4; b <= 4; b++) sw.append(h("i", { title: binText(b), style: { background: fill(b) } }));
  const ticks = h("span", { class: "dm-scale-ticks", attrs: { "aria-hidden": "true" } });
  SCALE_TICKS.forEach((t, k) => ticks.append(h("span", { style: { "grid-column": `${2 * k + 2} / span 2` } }, t)));
  const names: string[] = [];
  for (let b = -4; b <= 4; b++) names.push(binText(b));
  return h(
    "figure",
    { class: "dm-scale", attrs: { role: "img", "aria-label": `${title}。色は左から ${names.join("・")}` } },
    h("figcaption", { class: "dm-scale-note" }, nobr(title)),
    h("span", { class: "dm-scale-box", attrs: { "aria-hidden": "true" } }, sw, ticks, h("span", { class: "dm-scale-ends" }, h("span", null, "← 減る"), h("span", null, "増える →"))),
  );
}

/** 差の札の値だけ（塗った値）。色はアプリのカードの札と同じ段の塗りと文字の色 */
export function pillValue(p: PillVM): HTMLElement {
  const style: Record<string, string> = p.base ? {} : { background: fill(p.bin), color: IMPACT_INK[p.bin] ?? "#F0EFEC" };
  return h("b", { class: `dm-pill${p.bin === 0 ? " is-neutral" : ""}${p.base ? " is-base" : ""}`, style }, p.text);
}

/** 差の札（名前・塗った値・出し方） */
export function pill(p: PillVM): HTMLElement {
  return h("span", { class: "dm-pill-wrap" }, h("span", { class: "dm-pill-label" }, p.label), pillValue(p), p.basis ? h("span", { class: "dm-pill-basis" }, p.basis) : null);
}

/** 事実の答えの色（扇の答えの帯と同じ順） */
export const SPLIT_COLORS = ["#199e70", "#d95926", "#9085e9"] as const;
/** 結果の分かれ方の色（色で名前を区別しない: 明るさだけを変えた灰色） */
const OUT_GRAYS = ["#5d6577", "#465062", "#353d4c", "#2a3140"] as const;

/** 分かれ方の細い棒（答え・結果の割合）。colored なら事実の答えの色 */
export function splitBar(parts: readonly SharePart[], colored: boolean, label: string): HTMLElement {
  const bar = h("span", { class: "dm-split", attrs: { role: "img", "aria-label": `${label}: ${parts.map((p) => `${p.label} ${pct(p.share)}`).join("、")}` } });
  parts.forEach((p, k) => {
    if (!(p.share > 0.0005)) return;
    const color = colored ? (SPLIT_COLORS[k] ?? OUT_GRAYS[k % OUT_GRAYS.length]!) : OUT_GRAYS[k % OUT_GRAYS.length]!;
    bar.append(h("span", { class: "dm-split-seg", title: `${p.label}: ${pct(p.share)}`, style: { "flex-grow": String(p.share), background: color } }));
  });
  return bar;
}

/** 名前の前の色の印（答えの色と結びつける） */
export function swatch(color: string): HTMLElement {
  return h("i", { class: "dm-sw", style: { background: color }, attrs: { "aria-hidden": "true" } });
}

/**
 * 分かれ道の小さな帯（3 か月ごとの判断 + 出来事の分かれの数。下が判断・上が出来事の分かれ）。
 * max は見取り図の全部の手で共通の上限（手どうしで高さを比べられる）
 */
export function miniStrip(cols: readonly StripCol[], max: number, label: string): SVGSVGElement {
  const W = 132;
  const H = 30;
  const n = Math.max(1, cols.length);
  const gap = 2;
  const bw = (W - gap * (n - 1)) / n;
  const top = Math.max(1, max);
  const svg = s("svg", { class: "dm-mini", attrs: { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": `${label}: ${cols.map((c) => num(c.dec + c.split)).join("・")}`, focusable: "false" } });
  svg.append(s("line", { class: "dm-mini-base", attrs: { x1: 0, x2: W, y1: H - 0.5, y2: H - 0.5 } }));
  cols.forEach((c, k) => {
    const x = k * (bw + gap);
    const hd = (c.dec / top) * (H - 2);
    const hs = (c.split / top) * (H - 2);
    if (hd > 0) svg.append(s("rect", { class: "dm-mini-dec", attrs: { x: x.toFixed(2), y: (H - 1 - hd).toFixed(2), width: bw.toFixed(2), height: Math.max(1, hd).toFixed(2), rx: 1 } }));
    if (hs > 0) svg.append(s("rect", { class: "dm-mini-split", attrs: { x: x.toFixed(2), y: (H - 1 - hd - hs - (hd > 0 ? 1 : 0)).toFixed(2), width: bw.toFixed(2), height: Math.max(1, hs).toFixed(2), rx: 1 } }));
  });
  return svg;
}
