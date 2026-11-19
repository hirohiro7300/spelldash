// 道の画面（#path-<カードの番号>）: 今日から 2029 年 11 月まで、3 か月に 1 行の縦の道（設計: 作業メモ SPEC v1 §5.4・§5.5。
// 作業メモ user-2 (c)・user-3・user-7・user-9・user-20）。試し版（src/preview）とアプリ（P2）の両方で使う。
//   見出し: 題名・この道の見込み・3 年の合計・最後の月の稼ぎ・月の稼ぎの線（この道とずっと今のまま）・一番ありそうな道と違う所
//   行: 判断の年月・選ぶ手・結果と見込み・月の稼ぎ・ここまでの稼ぎ。押すと開く（その 3 か月の文章・数字の行・やること・
//       この手の結果とこの判断で選べる手。ほかを押すとその道に切り替わる）。「次の 3 か月へ」で次の行を開く
//   続けて同じ手の静かな期は 1 行（押すと 1 期ずつ）。まとめた手の後は標準の続きを薄い行で
// 行き来（ハッシュ）は使う側が決める: ほかの結果・手はリンク（#path-…）で、押す前に onSwitch で知らせる（切り替えた行の位置を保つため）。

import { append, clear, h, nobr, s, type Child } from "./dom";
import { manMonthly, num } from "./format";
import type { PathAltVM, PathCardVM, PathItemVM, PathSparkVM, PathStepVM, PathVM } from "./model";
import { FAN_ALL, FAN_KEEP } from "./model";
import { IMPACT_FILL, IMPACT_INK } from "../../model/impactFormat";

export interface PathPageOpts {
  /** 開いている行・まとめの鍵（無ければ vm.defaultOpen） */
  open?: ReadonlySet<string>;
  /**
   * ほかの結果・手を押した（リンクで切り替わる前）。行の鍵と、その行の見出しの画面の上からの位置。
   * true を返すと、使う側が切り替えた（リンクの行き先へは進まない）。false ならリンクのまま（ハッシュが変わる）
   */
  onSwitch?(key: string, top: number, href: string): boolean;
}

export interface PathPageHandle {
  el: HTMLElement;
  destroy(): void;
  /** 開いている行・まとめの鍵 */
  openKeys(): string[];
  /** 鍵の行の見出しを、画面の上から top の位置に合わせる（切り替えた行をそのままの場所に） */
  align(key: string, top: number): void;
  /** 鍵の行の見出しへ（画面に入れてフォーカス） */
  reveal(key: string): void;
  /** 鍵の行の見出しにフォーカス（動かさない） */
  focus(key: string): void;
}

const reducedMotion = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

let uid = 0;

/** 年月の欄（「2027 年 5 月〜2029 年 8 月」は「〜」の後で折り返せる） */
function whenText(t: string): Child[] {
  const k = t.indexOf("〜");
  if (k < 0) return nobr(t);
  return [...nobr(t.slice(0, k + 1)), h("wbr"), ...nobr(t.slice(k + 1))];
}

/** 数字の行（並べて折り返す） */
function numbersRow(xs: readonly string[]): HTMLElement | null {
  return xs.length ? h("ul", { class: "dm-numbers dm-tl-nums" }, xs.map((t) => h("li", null, nobr(t)))) : null;
}

/** 文章のカード（その 3 か月・結果） */
function cardEl(c: PathCardVM, kind: "move" | "out"): HTMLElement {
  return h(
    "section",
    { class: `dm-tl-card is-${kind}` },
    h("p", { class: "dm-tl-card-head" }, nobr(c.head)),
    h("h4", { class: "dm-tl-card-title" }, c.title),
    numbersRow(c.numbers),
    c.body ? h("p", { class: "dm-tl-text" }, c.body) : null,
    c.todo.length ? h("div", { class: "dm-tl-todo" }, h("p", { class: "dm-tl-todo-head" }, "やること"), h("ul", null, c.todo.map((t) => h("li", null, t)))) : null,
    c.facts.length ? h("p", { class: "dm-tl-facts" }, c.facts.map((t, k) => h("span", { class: "dm-seg-t" }, nobr(t), k < c.facts.length - 1 ? "・" : null))) : null,
  );
}

/** 差の札（色はアプリのカードの札と同じ段の塗り） */
function diffPill(text: string, bin: number): HTMLElement {
  const style = { background: IMPACT_FILL[bin] ?? IMPACT_FILL[0]!, color: IMPACT_INK[bin] ?? "#F0EFEC" };
  return h("b", { class: `dm-pill dm-alt-pill${bin === 0 ? " is-neutral" : ""}`, style }, text);
}

/** ほかの結果・手の 1 つ（この道の物は押せない札） */
function altEl(x: PathAltVM, onPick: (ev: Event, x: PathAltVM) => void): HTMLElement {
  const main = h(
    "span",
    { class: "dm-alt-main" },
    h("span", { class: "dm-alt-name" }, x.name, x.shareText ? h("b", { class: "dm-alt-share" }, ` ${x.shareText}`) : null),
    x.valueText ? h("span", { class: "dm-alt-value" }, nobr(x.valueText)) : null,
    x.tags.length ? h("span", { class: "dm-alt-tags" }, x.tags.map((t) => h("span", { class: `dm-alt-tag${t === "おすすめ" ? " is-pi" : t.startsWith("この道") ? " is-current" : ""}` }, t))) : null,
  );
  const pill = x.diffText ? diffPill(x.diffText, x.bin) : null;
  if (x.current) return h("li", null, h("span", { class: "dm-alt is-current", attrs: { "aria-label": x.aria } }, main, pill));
  return h("li", null, h("a", { class: "dm-alt", attrs: { href: x.href, "aria-label": x.aria }, on: { click: (ev) => onPick(ev, x) } }, main, pill, h("span", { class: "dm-alt-go", attrs: { "aria-hidden": "true" } }, "›")));
}

function altList(head: string, xs: readonly PathAltVM[], onPick: (ev: Event, x: PathAltVM) => void): HTMLElement {
  return h("section", { class: "dm-alts" }, h("h4", { class: "dm-alts-head" }, nobr(head)), h("ul", { class: "dm-alts-list" }, xs.map((x) => altEl(x, onPick))));
}

/** 見出しの月の稼ぎの線（この道・ずっと今のまま）。数は行にも出ているので、線は形を見るため（縦線の札でも読める） */
function sparkEl(sp: PathSparkVM): HTMLElement {
  const W = 320;
  const H = 84;
  const padL = 6;
  const padR = 6;
  const padT = 8;
  const padB = 8;
  const vals = [...sp.path.map((p) => p.v), ...sp.keep.map((p) => p.v)];
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) (lo = 0), (hi = 1);
  if (hi - lo < 1) (lo -= 0.5), (hi += 0.5);
  const pad = (hi - lo) * 0.08;
  lo -= pad;
  hi += pad;
  const mMax = sp.months[sp.months.length - 1] ?? 36;
  const xOf = (m: number) => padL + (m / Math.max(1, mMax)) * (W - padL - padR);
  const yOf = (v: number) => padT + (1 - (v - lo) / Math.max(1e-9, hi - lo)) * (H - padT - padB);
  const svg = s("svg", { class: "dm-spark-svg", attrs: { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", focusable: "false", "aria-hidden": "true" } });
  // 1 年ごとの区切り（1 年後・2 年後）
  sp.months.forEach((m, k) => {
    if (k === 0 || m % 12 !== 0) return;
    svg.append(s("line", { class: "dm-spark-year", attrs: { x1: xOf(m).toFixed(1), x2: xOf(m).toFixed(1), y1: padT, y2: H - padB } }));
  });
  const line = (pts: Array<{ m: number; v: number }>) => pts.map((p, k) => `${k ? "L" : "M"}${xOf(p.m).toFixed(1)},${yOf(p.v).toFixed(1)}`).join("");
  if (sp.keep.length >= 2) svg.append(s("path", { class: "dm-spark-keep", attrs: { d: line(sp.keep), stroke: FAN_KEEP } }));
  // この道: 確かな所は実線、まとめた手の後（見積もり）は点線
  const solid: Array<{ m: number; v: number }> = [];
  const est: Array<{ m: number; v: number }> = [];
  sp.path.forEach((p, k) => {
    if (!p.est) solid.push(p);
    else {
      if (!est.length && k > 0) est.push(sp.path[k - 1]!);
      est.push(p);
    }
  });
  if (solid.length >= 2) svg.append(s("path", { class: "dm-spark-path", attrs: { d: line(solid), stroke: FAN_ALL } }));
  if (est.length >= 2) svg.append(s("path", { class: "dm-spark-path is-est", attrs: { d: line(est), stroke: FAN_ALL } }));
  const cross = s("g", { class: "dm-spark-cross" });
  svg.append(cross);
  const plot = h("div", { class: "dm-spark-plot", attrs: { tabindex: "0", role: "img", "aria-label": `${sp.label}。← → でその時点の数` } }, svg);
  const first = sp.path[0];
  const last = sp.path[sp.path.length - 1];
  const tip = h("div", { class: "dm-tip dm-spark-tip", attrs: { "aria-hidden": "true" } });
  tip.hidden = true;
  plot.append(tip);
  // 縦線の札（指・マウス・キーボード）: 一番近い 3 か月の点
  const pathAt = (m: number) => sp.path.find((p) => p.m === m) ?? null;
  const keepAt = (m: number) => sp.keep.find((p) => p.m === m) ?? null;
  let at = -1;
  const show = (k: number) => {
    if (k < 0 || k >= sp.months.length) return;
    at = k;
    const m = sp.months[k]!;
    clear(cross);
    const x = xOf(m);
    cross.append(s("line", { class: "dm-cross-line", attrs: { x1: x.toFixed(1), x2: x.toFixed(1), y1: padT, y2: H - padB } }));
    const rows: HTMLElement[] = [];
    const p = pathAt(m);
    const q = keepAt(m);
    if (p) rows.push(h("li", null, h("i", { class: "dm-tip-key", style: { background: FAN_ALL } }), h("b", null, manMonthly(p.v)), h("span", null, p.est ? "この道（見積もり）" : "この道")));
    if (q) rows.push(h("li", null, h("i", { class: "dm-tip-key", style: { background: FAN_KEEP } }), h("b", null, manMonthly(q.v)), h("span", null, "ずっと今のまま（真ん中）")));
    clear(tip);
    tip.append(h("p", { class: "dm-tip-when" }, `${sp.yms[k] ?? ""}・月の稼ぎ`), h("ul", null, rows));
    tip.hidden = false;
    const r = plot.getBoundingClientRect();
    const px = (x / W) * r.width;
    const tw = tip.offsetWidth || 170;
    tip.style.left = `${Math.round(px + 10 + tw > r.width ? Math.max(0, px - 10 - tw) : px + 10)}px`;
    tip.style.top = "0px";
  };
  const hide = () => {
    at = -1;
    tip.hidden = true;
    clear(cross);
  };
  const nearest = (clientX: number) => {
    const r = plot.getBoundingClientRect();
    const m = ((clientX - r.left) / Math.max(1, r.width)) * W;
    let best = 0;
    let bd = Infinity;
    sp.months.forEach((mm, k) => {
      const d = Math.abs(xOf(mm) - m);
      if (d < bd) (bd = d), (best = k);
    });
    return best;
  };
  plot.addEventListener("pointermove", (ev) => show(nearest((ev as PointerEvent).clientX)));
  plot.addEventListener("pointerdown", (ev) => show(nearest((ev as PointerEvent).clientX)));
  plot.addEventListener("pointerleave", (ev) => {
    if ((ev as PointerEvent).pointerType === "mouse") hide();
  });
  plot.addEventListener("focus", () => show(at >= 0 ? at : sp.months.length - 1));
  plot.addEventListener("blur", hide);
  plot.addEventListener("keydown", (ev) => {
    const ke = ev as KeyboardEvent;
    const n = sp.months.length;
    let k = at >= 0 ? at : n - 1;
    if (ke.key === "ArrowLeft") k = Math.max(0, k - 1);
    else if (ke.key === "ArrowRight") k = Math.min(n - 1, k + 1);
    else if (ke.key === "Home") k = 0;
    else if (ke.key === "End") k = n - 1;
    else if (ke.key === "Escape") return hide();
    else return;
    ke.preventDefault();
    show(k);
  });
  const years = h("div", { class: "dm-spark-years", attrs: { "aria-hidden": "true" } });
  sp.months.forEach((m, k) => {
    if (k === 0 || m % 12 !== 0 || m >= mMax) return;
    years.append(h("span", { style: { left: `${((xOf(m) / W) * 100).toFixed(2)}%` } }, `${num(m / 12)} 年後`));
  });
  return h(
    "figure",
    { class: "dm-spark" },
    h(
      "ul",
      { class: "dm-legend dm-spark-legend" },
      h("li", null, h("i", { class: "dm-key-line", style: { background: FAN_ALL }, attrs: { "aria-hidden": "true" } }), h("span", null, "この道の月の稼ぎ")),
      h("li", null, h("i", { class: "dm-key-line is-ref", style: { background: FAN_KEEP }, attrs: { "aria-hidden": "true" } }), h("span", null, "ずっと今のまま（真ん中）")),
    ),
    h(
      "div",
      { class: "dm-spark-row" },
      first ? h("span", { class: "dm-spark-end is-start" }, h("small", null, sp.yms[0] ?? ""), h("b", null, manMonthly(first.v))) : null,
      plot,
      last ? h("span", { class: "dm-spark-end is-last" }, h("small", null, sp.yms[sp.yms.length - 1] ?? ""), h("b", null, manMonthly(last.v))) : null,
      years,
    ),
  );
}

/** 道の画面 */
export function renderPathPage(vm: PathVM, opts: PathPageOpts = {}): PathPageHandle {
  const open = new Set<string>(opts.open ?? vm.defaultOpen);
  const id = ++uid;
  /** 鍵 → 行の要素（見出しのボタン・中身・作り方） */
  const rows = new Map<string, { li: HTMLElement; head: HTMLButtonElement; body: HTMLElement; fill: (() => void) | null }>();
  const groupOf = new Map<string, string>();

  const onPick = (ev: Event, x: PathAltVM) => {
    const me = ev as MouseEvent;
    // 新しいタブなどで開く押し方はリンクのまま
    if (me.button > 0 || me.metaKey || me.ctrlKey || me.shiftKey || me.altKey) return;
    const li = (ev.currentTarget as HTMLElement).closest<HTMLElement>("[data-key]");
    const key = li?.dataset.key ?? "";
    const head = key ? rows.get(key)?.head : null;
    if (opts.onSwitch?.(key, head ? head.getBoundingClientRect().top : 0, x.href)) ev.preventDefault();
  };

  const setOpen = (key: string, on: boolean) => {
    const r = rows.get(key);
    if (!r) return;
    if (on && r.fill) {
      r.fill();
      r.fill = null;
    }
    r.head.setAttribute("aria-expanded", String(on));
    r.body.hidden = !on;
    r.li.classList.toggle("is-open", on);
    if (on) open.add(key);
    else open.delete(key);
    // 開いた行がまとめの中なら、まとめも開く
    const g = groupOf.get(key);
    if (on && g && !open.has(g)) setOpen(g, true);
  };

  const scrollToHead = (key: string) => {
    const r = rows.get(key);
    if (!r) return;
    r.head.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
    r.head.focus({ preventScroll: true });
  };

  const endEl = endCard(vm);
  /** 次の 3 か月へ: この行を閉じ、次の行を開いてそこへ（最後の行の次は着いた所） */
  const stepTo = (k: number, fromKey: string | null) => {
    if (fromKey) setOpen(fromKey, false);
    const next = vm.steps[k];
    if (!next) {
      endEl.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
      endEl.focus({ preventScroll: true });
      return;
    }
    setOpen(next.key, true);
    scrollToHead(next.key);
  };

  /** 行の見出し（押すと開く） */
  const headBtn = (key: string, label: string, ...kids: Child[]) => {
    const bodyId = `dm-tl-${id}-${key}`;
    return h(
      "button",
      { class: "dm-tl-head", attrs: { type: "button", "aria-expanded": "false", "aria-controls": bodyId, "aria-label": label }, on: { click: () => setOpen(key, !open.has(key)) } },
      ...kids,
      h("span", { class: "dm-tl-chev", attrs: { "aria-hidden": "true" } }),
    );
  };

  const stepEl = (st: PathStepVM): HTMLElement => {
    const cls = ["dm-tl-item", "is-step", st.off ? "is-off" : "", st.pivot ? "is-pivot" : "", st.stub ? "is-stub" : ""].filter(Boolean).join(" ");
    const head = headBtn(
      st.key,
      st.aria,
      h("span", { class: "dm-tl-when" }, h("b", null, st.ym), st.span ? h("span", null, st.span) : null, st.pivot ? h("span", { class: "dm-tl-flag" }, "ここで切り替えた") : null),
      h("span", { class: "dm-tl-move" }, h("span", { class: "dm-tl-move-name" }, st.move), st.onPi ? h("span", { class: "dm-chip" }, "おすすめ") : h("span", { class: "dm-tl-tag" }, "おすすめの手ではない")),
      st.outcomeText ? h("span", { class: "dm-tl-out" }, "→ ", nobr(st.outcomeText)) : null,
      st.stub ? h("span", { class: "dm-tl-money is-warn" }, "この先は標準の選び方で続けた見積もり") : null,
      st.monthlyText
        ? h("span", { class: "dm-tl-money" }, h("span", { class: "dm-seg-t" }, nobr(st.monthlyText), st.monthlyDiff ? h("small", null, nobr(`（${st.monthlyDiff}）`)) : null, "・"), h("span", { class: "dm-seg-t" }, nobr(st.runningText ?? "")))
        : null,
      st.altOutcomesText || st.altOptionsText
        ? h(
            "span",
            { class: "dm-tl-alt" },
            st.altOutcomeParts.length ? h("span", { class: "dm-seg-t dm-tl-alt-label" }, "ほかの結果") : null,
            st.altOutcomeParts.map((t, k) => h("span", { class: "dm-seg-t" }, t, k < st.altOutcomeParts.length - 1 ? "・" : null)),
            st.altOutcomesText && st.altOptionsText ? h("span", { class: "dm-tl-alt-sep", attrs: { "aria-hidden": "true" } }, " ／ ") : null,
            st.altOptionsText ? h("span", { class: "dm-seg-t" }, st.altOptionsText) : null,
          )
        : null,
    );
    const body = h("div", { class: "dm-tl-body", attrs: { id: `dm-tl-${id}-${st.key}`, role: "region", "aria-label": `${st.ym}の中身` } });
    body.hidden = true;
    const li = h("li", { class: cls, dataset: { key: st.key } }, head, body);
    const fill = () => {
      const d = st.detail();
      append(body, [
        h("div", { class: "dm-tl-cards" }, cardEl(d.move, "move"), d.outcome ? cardEl(d.outcome, "out") : null, d.note ? h("p", { class: "dm-tl-note" }, d.note) : null),
        st.outcomesHead && st.outcomes.length ? altList(st.outcomesHead, st.outcomes, onPick) : null,
        st.options.length > 1 ? altList(st.optionsHead, st.options, onPick) : null,
        h("button", { class: "dm-btn dm-tl-next", attrs: { type: "button" }, on: { click: () => stepTo(st.index + 1, st.key) } }, st.nextText, h("span", { attrs: { "aria-hidden": "true" } }, " ↓")),
      ]);
    };
    rows.set(st.key, { li, head, body, fill });
    return li;
  };

  const itemEl = (it: PathItemVM): HTMLElement => {
    if (it.type === "step") return stepEl(it.step);
    if (it.type === "light") {
      return h(
        "li",
        { class: "dm-tl-item is-light", dataset: { key: it.key } },
        h("div", { class: "dm-tl-lightrow" }, h("span", { class: "dm-tl-when" }, h("b", null, whenText(it.ym))), h("span", { class: "dm-tl-move" }, it.title), it.note ? h("span", { class: "dm-tl-money" }, it.note) : null),
      );
    }
    const head = headBtn(
      it.key,
      it.aria,
      h("span", { class: "dm-tl-when" }, h("b", null, whenText(it.ym)), h("span", null, `${num(it.steps.length)} 期をまとめた`), it.pivot ? h("span", { class: "dm-tl-flag" }, "ここで切り替えた") : null),
      h("span", { class: "dm-tl-move" }, h("span", { class: "dm-tl-move-name" }, it.title)),
      it.outcomeText ? h("span", { class: "dm-tl-out" }, "→ ", nobr(it.outcomeText)) : null,
      it.monthlyText ? h("span", { class: "dm-tl-money" }, h("span", { class: "dm-seg-t" }, nobr(it.monthlyText), "・"), h("span", { class: "dm-seg-t" }, nobr(it.runningText ?? ""))) : null,
      h("span", { class: "dm-tl-alt" }, "押すと 1 期ずつ"),
    );
    const sub = h("ol", { class: "dm-tl dm-tl-sub", attrs: { id: `dm-tl-${id}-${it.key}` } });
    sub.hidden = true;
    for (const st of it.steps) {
      sub.append(stepEl(st));
      groupOf.set(st.key, it.key);
    }
    const li = h("li", { class: `dm-tl-item is-group${it.off ? " is-off" : ""}${it.pivot ? " is-pivot" : ""}`, dataset: { key: it.key } }, head, sub);
    rows.set(it.key, { li, head, body: sub, fill: null });
    return li;
  };

  // 道の始め（今日）
  const startHead = headBtn(
    vm.start.key,
    `${vm.start.ym}・${vm.start.title}。${vm.start.monthlyText}`,
    h("span", { class: "dm-tl-when" }, h("b", null, vm.start.ym)),
    h("span", { class: "dm-tl-move" }, h("span", { class: "dm-tl-move-name" }, vm.start.title)),
    h("span", { class: "dm-tl-money" }, nobr(vm.start.monthlyText)),
  );
  const startBody = h("div", { class: "dm-tl-body", attrs: { id: `dm-tl-${id}-${vm.start.key}` } });
  startBody.hidden = true;
  const startLi = h("li", { class: "dm-tl-item is-start", dataset: { key: vm.start.key } }, startHead, startBody);
  rows.set(vm.start.key, {
    li: startLi,
    head: startHead,
    body: startBody,
    fill: () => {
      append(startBody, [
        h("div", { class: "dm-tl-cards" }, h("section", { class: "dm-tl-card" }, numbersRow(vm.start.numbers), h("p", { class: "dm-tl-text" }, vm.start.body()))),
        vm.steps.length ? h("button", { class: "dm-btn dm-tl-next", attrs: { type: "button" }, on: { click: () => stepTo(0, vm.start.key) } }, `次の 3 か月へ（${vm.steps[0]!.ym}）`, h("span", { attrs: { "aria-hidden": "true" } }, " ↓")) : null,
      ]);
    },
  });

  const list = h("ol", { class: "dm-tl", attrs: { "aria-label": "3 か月ごとの道" } }, startLi, vm.items.map(itemEl));

  // 見出しの数と線
  const figs = h(
    "dl",
    { class: "dm-figs" },
    vm.figures.map((f) => h("div", { class: "dm-fig" }, h("dt", null, f.label), h("dd", { class: "dm-fig-value" }, f.value), f.sub ? h("dd", { class: "dm-fig-sub" }, nobr(f.sub)) : null)),
  );
  const offs = vm.offs.length
    ? h("div", { class: "dm-pathv-offs" }, h("p", { class: "dm-pathv-offs-head" }, "一番ありそうな道と違う所"), h("ul", null, vm.offs.slice(0, 4).map((t) => h("li", null, nobr(t)))), vm.offs.length > 4 ? h("p", { class: "dm-plan-more" }, `ほか ${num(vm.offs.length - 4)} 所`) : null)
    : null;
  const readBtn = h("button", { class: "dm-btn", attrs: { type: "button" }, on: { click: () => stepTo(0, null) } }, vm.readText);
  const side = h(
    "aside",
    { class: "dm-pathv-side", attrs: { "aria-label": "この道のまとめ" } },
    figs,
    sparkEl(vm.spark),
    offs,
    h("div", { class: "dm-pathv-actions" }, readBtn, vm.resetHref ? h("a", { class: "dm-btn", attrs: { href: vm.resetHref } }, vm.resetText) : null),
  );
  const el = h(
    "article",
    { class: "dm-move dm-pathv" },
    h("a", { class: "dm-back", attrs: { href: vm.backHref } }, `‹ ${vm.backText}`),
    h("header", { class: "dm-pathv-head" }, h("p", { class: "dm-eyebrow" }, nobr(vm.eyebrow)), h("h2", { class: "dm-h2", attrs: { tabindex: "-1" } }, vm.title), h("p", { class: "dm-sub" }, vm.intro)),
    h("div", { class: "dm-pathv-layout" }, side, h("div", { class: "dm-pathv-main" }, list, endEl)),
  );
  for (const k of [...open]) {
    if (rows.has(k)) setOpen(k, true);
    else open.delete(k);
  }

  return {
    el,
    destroy() {},
    openKeys: () => [...open],
    align(key, top) {
      const r = rows.get(key);
      if (!r) return;
      const now = r.head.getBoundingClientRect().top;
      if (Math.abs(now - top) > 0.5) scrollBy(0, now - top);
    },
    reveal(key) {
      if (!rows.has(key)) return;
      setOpen(key, true);
      scrollToHead(key);
    },
    focus(key) {
      rows.get(key)?.head.focus({ preventScroll: true });
    },
  };
}

/** 道の終わり（着いた所） */
function endCard(vm: PathVM): HTMLElement {
  const e = vm.end;
  return h(
    "section",
    { class: `dm-tl-end${e.summary ? " is-summary" : ""}`, attrs: { tabindex: "-1", "aria-label": e.head } },
    h("p", { class: "dm-tl-card-head" }, nobr(e.head)),
    h("h3", { class: "dm-tl-end-cls" }, e.cls),
    e.title ? h("p", { class: "dm-tl-end-title" }, e.title) : null,
    numbersRow(e.numbers),
    h("p", { class: "dm-tl-text" }, e.body()),
    h("p", { class: "dm-tl-facts" }, e.facts.map((t, k) => h("span", { class: "dm-seg-t" }, nobr(t), k < e.facts.length - 1 ? "・" : null))),
    e.note ? h("p", { class: "dm-tl-note" }, e.note) : null,
    vm.resetHref ? h("a", { class: "dm-btn", attrs: { href: vm.resetHref } }, vm.resetText) : null,
  );
}
