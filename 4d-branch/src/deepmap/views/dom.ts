// 見取り図・手の詳しい画面・道の画面の DOM を組み立てる小さな手助け（フレームワークは使わない。試し版とアプリの両方で使う）
// 文字はいつも textContent で入れる（地図の名前をそのまま HTML にしない）

export type Child = Node | string | number | null | undefined | false | readonly Child[];

export interface Attrs {
  class?: string;
  /** 文字（textContent） */
  text?: string;
  title?: string;
  style?: Readonly<Record<string, string>>;
  dataset?: Readonly<Record<string, string>>;
  /** そのほかの属性（null・false は付けない。true は空の値で付ける） */
  attrs?: Readonly<Record<string, string | number | boolean | null | undefined>>;
  on?: Readonly<Partial<Record<keyof HTMLElementEventMap, (ev: Event) => void>>>;
}

function applyAttrs(el: Element, a: Attrs | null): void {
  if (!a) return;
  if (a.class) el.setAttribute("class", a.class);
  if (a.text !== undefined) el.textContent = a.text;
  if (a.title) el.setAttribute("title", a.title);
  if (a.style) for (const [k, v] of Object.entries(a.style)) (el as HTMLElement | SVGElement).style.setProperty(k, v);
  if (a.dataset) for (const [k, v] of Object.entries(a.dataset)) (el as HTMLElement | SVGElement).dataset[k] = v;
  if (a.attrs) for (const [k, v] of Object.entries(a.attrs)) if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v === true ? "" : String(v));
  if (a.on) for (const [k, fn] of Object.entries(a.on)) if (fn) el.addEventListener(k, fn);
}

export function append(el: Element, children: readonly Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c as readonly Child[]);
    else if (c instanceof Node) el.append(c);
    else el.append(String(c));
  }
}

/** HTML の要素 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, a: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyAttrs(el, a);
  append(el, children);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** SVG の要素 */
export function s<K extends keyof SVGElementTagNameMap>(tag: K, a: Attrs | null = null, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  applyAttrs(el, a);
  append(el, children);
  return el;
}

/** 年月（2029 年 11 月）と数・数の幅（+35〜+328 万円・1,452 回・20%）を 1 つにまとめる所 */
const NOBR = /\d{4} 年 \d{1,2} 月(?:〜(?:\d{4} 年 )?\d{1,2} 月)?|[+−±]?\d[\d,]*(?:\.\d+)?(?:〜[+−±]?\d[\d,]*(?:\.\d+)?)?(?: ?(?:万円|%|回|枚|社|人|か月|時間))?/g;

/** 文を、年月と数の所だけ折り返さない形にする（それ以外はふつうに折り返す） */
export function nobr(text: string): Child[] {
  const out: Child[] = [];
  let last = 0;
  for (const m of text.matchAll(NOBR)) {
    const i = m.index ?? 0;
    if (!m[0] || !/[\s〜]/.test(m[0])) continue;
    if (i > last) out.push(text.slice(last, i));
    const span = document.createElement("span");
    span.className = "dm-nw";
    span.textContent = m[0];
    out.push(span);
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function clear(el: Element): void {
  while (el.firstChild) el.firstChild.remove();
}
