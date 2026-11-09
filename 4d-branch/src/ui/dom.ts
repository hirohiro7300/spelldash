// DOM を組み立てる小さな手助け（フレームワークは使わない）

type Child = Node | string | number | null | undefined | false | Child[];

export interface Props {
  class?: string;
  style?: string | Partial<Record<string, string>>;
  dataset?: Record<string, string>;
  text?: string;
  html?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  title?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  checked?: boolean;
  tabIndex?: number;
  role?: string;
  ariaLabel?: string;
  onClick?: (ev: MouseEvent) => void;
  onInput?: (ev: Event) => void;
  onChange?: (ev: Event) => void;
  onKeydown?: (ev: KeyboardEvent) => void;
  onFocus?: (ev: FocusEvent) => void;
  onBlur?: (ev: FocusEvent) => void;
  onPointerdown?: (ev: PointerEvent) => void;
  onDblclick?: (ev: MouseEvent) => void;
  onContextmenu?: (ev: MouseEvent) => void;
  onMouseenter?: (ev: MouseEvent) => void;
  onMouseleave?: (ev: MouseEvent) => void;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) applyProps(el, props);
  append(el, children);
  return el;
}

function applyProps(el: HTMLElement, p: Props): void {
  if (p.class) el.className = p.class;
  if (typeof p.style === "string") el.setAttribute("style", p.style);
  else if (p.style) for (const [k, v] of Object.entries(p.style)) if (v != null) el.style.setProperty(k, v);
  if (p.dataset) for (const [k, v] of Object.entries(p.dataset)) el.dataset[k] = v;
  if (p.text != null) el.textContent = p.text;
  if (p.html != null) el.innerHTML = p.html;
  if (p.title) el.title = p.title;
  if (p.type) el.setAttribute("type", p.type);
  if (p.value != null) (el as HTMLInputElement).value = p.value;
  if (p.placeholder) el.setAttribute("placeholder", p.placeholder);
  if (p.disabled) (el as HTMLButtonElement).disabled = true;
  if (p.checked) (el as HTMLInputElement).checked = true;
  if (p.tabIndex != null) el.tabIndex = p.tabIndex;
  if (p.role) el.setAttribute("role", p.role);
  if (p.ariaLabel) el.setAttribute("aria-label", p.ariaLabel);
  if (p.attrs) for (const [k, v] of Object.entries(p.attrs)) if (v != null && v !== false) el.setAttribute(k, v === true ? "" : String(v));
  if (p.onClick) el.addEventListener("click", p.onClick);
  if (p.onInput) el.addEventListener("input", p.onInput);
  if (p.onChange) el.addEventListener("change", p.onChange);
  if (p.onKeydown) el.addEventListener("keydown", p.onKeydown);
  if (p.onFocus) el.addEventListener("focus", p.onFocus);
  if (p.onBlur) el.addEventListener("blur", p.onBlur);
  if (p.onPointerdown) el.addEventListener("pointerdown", p.onPointerdown);
  if (p.onDblclick) el.addEventListener("dblclick", p.onDblclick);
  if (p.onContextmenu) el.addEventListener("contextmenu", p.onContextmenu);
  if (p.onMouseenter) el.addEventListener("mouseenter", p.onMouseenter);
  if (p.onMouseleave) el.addEventListener("mouseleave", p.onMouseleave);
}

export function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.append(c);
    else el.append(String(c));
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.firstChild.remove();
}

/** 入力中の欄は上書きしない（カーソル位置を飛ばさない） */
export function setValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, v: string): void {
  if (document.activeElement === el) return;
  if (el.value !== v) el.value = v;
}

export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (t as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "range", "color"].includes(type);
  }
  return false;
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? "⌘" : "Ctrl+";

/** テキストエリアを中身に合わせて伸ばす */
export function autosize(ta: HTMLTextAreaElement, max = 360): void {
  ta.style.height = "auto";
  ta.style.height = `${Math.min(max, ta.scrollHeight + 2)}px`;
}

export function hexToRgba(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1]!, 16)}, ${parseInt(m[2]!, 16)}, ${parseInt(m[3]!, 16)}, ${a})`;
}
