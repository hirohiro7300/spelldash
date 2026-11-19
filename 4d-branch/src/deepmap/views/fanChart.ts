// 月の稼ぎの扇（設計: 作業メモ SPEC v1 §5.2。作業メモ user-1 (2)）
// 横は 0〜36 か月目（3 か月ごとの点）、縦は月の稼ぎ（万円）。帯は 10〜90%、線は真ん中（50%）。比べる線はずっと今のまま。
// 事実を知る手は答えごとに 1 本ずつ（「まとめて」に切り替えられる）。
// 指・マウスを動かすと一番近い 3 か月の点に縦線を立て、出しているどの帯の数も 1 つの札に並べる（キーボードは ← →）。
// 数は「表で見る」でも読める（札だけにしない）。幅は入れ物の幅に合わせて描き直す（文字は縮めない）。
// 狭い画面（幅 520px 未満）では、札を図の下の欄に出す（図に重ねない。最初は最後の月の数。作業メモ user-11）。
// 広い画面では、縦線の右か左の空いている方に出し、縦線には重ねない。

import { clear, h, nobr, s } from "./dom";
import { manMonthly, num, pct } from "./format";
import { fanDomain, type FanSeries, type FanVM } from "./model";

export interface FanChartHandle {
  el: HTMLElement;
  destroy(): void;
}

type Mode = "answers" | "all";

interface Geom {
  W: number;
  H: number;
  padL: number;
  padR: number;
  padT: number;
  padB: number;
  xOf(m: number): number;
  yOf(v: number): number;
  mMax: number;
}

function fmt1(v: number): string {
  return (Math.round(v * 10) / 10).toFixed(1);
}

/** 帯の面（10〜90%）の形 */
function areaPath(ser: FanSeries, g: Geom): string {
  const top: string[] = [];
  const bot: string[] = [];
  for (const p of ser.pts) {
    if (p.lo === null || p.hi === null) continue;
    top.push(`${g.xOf(p.m).toFixed(1)},${g.yOf(p.hi).toFixed(1)}`);
    bot.push(`${g.xOf(p.m).toFixed(1)},${g.yOf(p.lo).toFixed(1)}`);
  }
  if (top.length < 2) return "";
  return `M${top.join("L")}L${bot.reverse().join("L")}Z`;
}

/** 真ん中の線の形 */
function linePath(ser: FanSeries, g: Geom): string {
  const pts: string[] = [];
  for (const p of ser.pts) if (p.mid !== null) pts.push(`${g.xOf(p.m).toFixed(1)},${g.yOf(p.mid).toFixed(1)}`);
  return pts.length >= 2 ? `M${pts.join("L")}` : "";
}

export function fanChart(vm: FanVM, opts: { mode?: Mode } = {}): FanChartHandle {
  const hasAnswers = vm.answers.length >= 2;
  let mode: Mode = hasAnswers ? (opts.mode ?? "answers") : "all";
  const shown = (): FanSeries[] => (mode === "answers" ? [...vm.answers, vm.keep] : [vm.all, vm.keep]);

  const legend = h("ul", { class: "dm-legend" });
  const btnA = h("button", { class: "dm-seg-btn", text: "答えごと", attrs: { type: "button" } });
  const btnB = h("button", { class: "dm-seg-btn", text: "まとめて", attrs: { type: "button" } });
  const seg = hasAnswers ? h("div", { class: "dm-seg", attrs: { role: "group", "aria-label": "帯の分け方" } }, btnA, btnB) : null;
  const plot = h("div", { class: "dm-fan-plot", attrs: { tabindex: "0", role: "img" } });
  const tip = h("div", { class: "dm-tip", attrs: { "aria-hidden": "true" } });
  tip.hidden = true;
  const tableBox = h("div", { class: "dm-scroll" });
  const table = h("details", { class: "dm-table" }, h("summary", null, "表で見る（3 か月ごとの月の稼ぎ）"), tableBox);
  const el = h(
    "figure",
    { class: "dm-fan" },
    h("div", { class: "dm-fan-bar" }, legend, seg),
    plot,
    h(
      "figcaption",
      { class: "dm-fan-cap" },
      h("span", null, "帯は 10〜90%、線は真ん中（50%）。縦線を動かすと、その時点の数が出る"),
      h("span", null, nobr(vm.formula)),
      vm.notes.map((n) => h("span", { class: "dm-note-warn" }, n)),
    ),
    table,
  );

  let geom: Geom | null = null;
  let svg: SVGSVGElement | null = null;
  let cross: SVGGElement | null = null;
  let at = -1;
  let lastW = -1;
  let narrow = false;

  function fillLegend(): void {
    clear(legend);
    for (const ser of shown()) {
      const key = ser.band ? h("i", { class: "dm-key-band", style: { background: ser.color, "border-color": ser.color } }) : h("i", { class: "dm-key-line", style: { background: ser.color } });
      key.setAttribute("aria-hidden", "true");
      legend.append(h("li", null, key, h("span", null, ser.label), ser.share !== null ? h("b", null, pct(ser.share)) : null));
    }
    if (seg) {
      btnA.setAttribute("aria-pressed", String(mode === "answers"));
      btnB.setAttribute("aria-pressed", String(mode === "all"));
    }
  }

  function fillTable(): void {
    clear(tableBox);
    const ser = shown();
    const head = h("tr", null, h("th", { attrs: { scope: "col" } }, "年月"), ser.map((x) => h("th", { attrs: { scope: "col" } }, x.share !== null ? `${x.label}（${pct(x.share)}）` : x.label)));
    const body = h("tbody");
    vm.months.forEach((m, k) => {
      body.append(
        h(
          "tr",
          null,
          h("th", { attrs: { scope: "row" } }, vm.yms[k] ?? `${m} か月後`),
          ser.map((x) => {
            const p = x.pts[k];
            if (!p || p.mid === null) return h("td", null, "—");
            return h("td", null, x.band && p.lo !== null && p.hi !== null && Math.abs(p.hi - p.lo) > 0.05 ? `${fmt1(p.mid)}（${fmt1(p.lo)}〜${fmt1(p.hi)}）` : fmt1(p.mid));
          }),
        ),
      );
    });
    tableBox.append(h("table", null, h("caption", null, "月の稼ぎ（万円）: 真ん中（10〜90%）"), h("thead", null, head), body));
  }

  function summaryLabel(): string {
    const k = vm.months.length - 1;
    const parts = shown().map((x) => {
      const p = x.pts[k];
      if (!p || p.mid === null) return `${x.label}: 数なし`;
      return x.band && p.lo !== null && p.hi !== null ? `${x.label} 真ん中 ${manMonthly(p.mid)}（10〜90%: ${manMonthly(p.lo)}〜${manMonthly(p.hi)}）` : `${x.label} ${manMonthly(p.mid)}`;
    });
    return `月の稼ぎの広がり（${vm.yms[0] ?? ""}〜${vm.yms[k] ?? ""}）。${vm.yms[k] ?? ""}: ${parts.join("、")}。数は表で見られる`;
  }

  function draw(): void {
    const W = Math.floor(plot.clientWidth);
    if (W < 120) return;
    lastW = W;
    narrow = W < 520;
    plot.classList.toggle("is-narrow", narrow);
    const H = narrow ? 228 : 292;
    const ser = shown();
    const dom = fanDomain(ser);
    const mMax = vm.months[vm.months.length - 1] ?? 36;
    const padL = 34;
    const padR = narrow ? 12 : 76;
    const padT = 24;
    const padB = 50;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const g: Geom = {
      W,
      H,
      padL,
      padR,
      padT,
      padB,
      mMax,
      xOf: (m) => padL + (m / Math.max(1, mMax)) * plotW,
      yOf: (v) => padT + (1 - (v - dom.lo) / Math.max(1e-9, dom.hi - dom.lo)) * plotH,
    };
    geom = g;
    const root = s("svg", { class: "dm-fan-svg", attrs: { width: W, height: H, viewBox: `0 0 ${W} ${H}`, focusable: "false", "aria-hidden": "true" } });
    // 目盛り（横線は細く・数は軸の左）と軸の名前
    root.append(s("text", { class: "dm-ax-title", attrs: { x: 0, y: 12 } }, "月の稼ぎ（万円）"));
    for (const t of dom.ticks) {
      const y = g.yOf(t);
      if (y < padT - 1 || y > padT + plotH + 1) continue;
      root.append(s("line", { class: "dm-grid", attrs: { x1: padL, x2: W - padR, y1: y.toFixed(1), y2: y.toFixed(1) } }));
      root.append(s("text", { class: "dm-ax", attrs: { x: padL - 6, y: (y + 4).toFixed(1), "text-anchor": "end" } }, num(t)));
    }
    // 横の目盛り: 3 か月ごとの小さな刻みと、1 年ごとの年月
    const baseY = padT + plotH;
    root.append(s("line", { class: "dm-axis", attrs: { x1: padL, x2: W - padR, y1: baseY, y2: baseY } }));
    vm.months.forEach((m, k) => {
      const x = g.xOf(m);
      const year = m % 12 === 0;
      root.append(s("line", { class: year ? "dm-tick is-year" : "dm-tick", attrs: { x1: x.toFixed(1), x2: x.toFixed(1), y1: baseY, y2: baseY + (year ? 6 : 3) } }));
      if (year) {
        // 「11 月」と「2026 年」の 2 行（狭い画面でも隣の年と重ならない）
        const anchor = k === 0 ? "start" : k === vm.months.length - 1 ? "end" : "middle";
        const ymm = /^(\d{4}) 年 (\d{1,2}) 月$/.exec(vm.yms[k] ?? "");
        const t = s("text", { class: "dm-ax", attrs: { x: x.toFixed(1), y: baseY + 18, "text-anchor": anchor } });
        if (ymm) {
          t.append(s("tspan", { attrs: { x: x.toFixed(1) } }, `${ymm[2]} 月`), s("tspan", { class: "dm-ax-year", attrs: { x: x.toFixed(1), dy: 14 } }, `${ymm[1]} 年`));
        } else t.textContent = vm.yms[k] ?? "";
        root.append(t);
      }
    });
    // 帯（薄い塗り）→ ずっと今のまま → 真ん中の線
    for (const x of ser) {
      if (!x.band) continue;
      const d = areaPath(x, g);
      if (d) root.append(s("path", { class: "dm-band", attrs: { d, fill: x.color, "fill-opacity": x.id === "all" ? "0.2" : "0.16" } }));
    }
    for (const x of ser) {
      const d = linePath(x, g);
      if (d) root.append(s("path", { class: x.band ? "dm-line" : "dm-line is-ref", attrs: { d, stroke: x.color, fill: "none" } }));
    }
    // 右端の数（広い画面だけ。重なる物は出さない）
    if (!narrow) {
      const k = vm.months.length - 1;
      const labels = ser
        .map((x) => ({ x, v: x.pts[k]?.mid ?? null }))
        .filter((l): l is { x: FanSeries; v: number } => l.v !== null)
        .map((l) => ({ ...l, y: g.yOf(l.v) }))
        .sort((p, q) => p.y - q.y);
      let lastY = -Infinity;
      for (const l of labels) {
        if (l.y - lastY < 14) continue;
        lastY = l.y;
        root.append(s("circle", { class: "dm-end-dot", attrs: { cx: g.xOf(mMax).toFixed(1), cy: l.y.toFixed(1), r: 4, fill: l.x.color } }));
        root.append(s("text", { class: "dm-end-label", attrs: { x: (g.xOf(mMax) + 9).toFixed(1), y: (l.y + 4).toFixed(1) } }, `${fmt1(l.v)} 万円`));
      }
    }
    // 縦線（指・マウス・キーボードで動かす）
    cross = s("g", { class: "dm-cross" });
    cross.style.display = "none";
    root.append(cross);
    if (svg) svg.replaceWith(root);
    else plot.prepend(root);
    svg = root;
    plot.setAttribute("aria-label", summaryLabel());
    if (at >= 0) show(at);
    else if (narrow) fillTip(vm.months.length - 1);
    else tip.hidden = true;
  }

  function nearest(px: number): number {
    if (!geom) return -1;
    const m = ((px - geom.padL) / Math.max(1, geom.W - geom.padL - geom.padR)) * geom.mMax;
    let best = 0;
    let bd = Infinity;
    vm.months.forEach((mm, k) => {
      const d = Math.abs(mm - m);
      if (d < bd) (bd = d), (best = k);
    });
    return best;
  }

  /** 札の中身（k 番目の点の、出しているどの帯の数も） */
  function fillTip(k: number): void {
    const m = vm.months[k]!;
    const rows: HTMLElement[] = [];
    for (const ser of shown()) {
      const p = ser.pts[k];
      if (!p || p.mid === null) continue;
      const range = ser.band && p.lo !== null && p.hi !== null && Math.abs(p.hi - p.lo) > 0.05 ? `10〜90%: ${fmt1(p.lo)}〜${fmt1(p.hi)}` : null;
      rows.push(h("li", null, h("i", { class: "dm-tip-key", style: { background: ser.color } }), h("b", null, manMonthly(p.mid)), h("span", null, ser.label, range ? h("small", null, range) : null)));
    }
    clear(tip);
    tip.append(h("p", { class: "dm-tip-when" }, `${vm.yms[k] ?? ""}${m > 0 ? `（${num(m)} か月後）` : "（今日）"}・月の稼ぎ`), h("ul", null, rows));
    tip.hidden = false;
    tip.style.left = "";
    tip.style.top = "";
    tip.style.maxWidth = "";
  }

  function show(k: number): void {
    if (!geom || !cross || k < 0 || k >= vm.months.length) return;
    at = k;
    const g = geom;
    const m = vm.months[k]!;
    const x = g.xOf(m);
    clear(cross);
    cross.style.display = "";
    cross.append(s("line", { class: "dm-cross-line", attrs: { x1: x.toFixed(1), x2: x.toFixed(1), y1: g.padT, y2: g.H - g.padB } }));
    for (const ser of shown()) {
      const p = ser.pts[k];
      if (!p || p.mid === null) continue;
      cross.append(s("circle", { class: "dm-cross-dot", attrs: { cx: x.toFixed(1), cy: g.yOf(p.mid).toFixed(1), r: 4, fill: ser.color } }));
    }
    fillTip(k);
    if (narrow) return;
    // 縦線の右か左の空いている方へ（縦線には重ねない。どちらも足りなければ広い方に、幅を縮めて）
    const tw = tip.offsetWidth || 180;
    const roomR = g.W - x - 12;
    const roomL = x - 12;
    let left: number;
    if (roomR >= tw) left = x + 12;
    else if (roomL >= tw) left = x - 12 - tw;
    else if (roomR >= roomL) {
      left = x + 12;
      tip.style.maxWidth = `${Math.max(120, Math.floor(roomR))}px`;
    } else {
      const w = Math.max(120, Math.floor(roomL));
      tip.style.maxWidth = `${w}px`;
      left = Math.max(0, x - 12 - w);
    }
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${g.padT}px`;
  }

  function hide(): void {
    at = -1;
    if (cross) cross.style.display = "none";
    // 狭い画面の欄は消さない（最後の月の数に戻す）
    if (narrow) fillTip(vm.months.length - 1);
    else tip.hidden = true;
  }

  const pointer = (ev: Event): void => {
    const pe = ev as PointerEvent;
    const r = plot.getBoundingClientRect();
    show(nearest(pe.clientX - r.left));
  };
  plot.addEventListener("pointermove", pointer);
  plot.addEventListener("pointerdown", pointer);
  plot.addEventListener("pointerleave", (ev) => {
    if ((ev as PointerEvent).pointerType === "mouse") hide();
  });
  plot.addEventListener("focus", () => show(at >= 0 ? at : vm.months.length - 1));
  plot.addEventListener("blur", hide);
  plot.addEventListener("keydown", (ev) => {
    const ke = ev as KeyboardEvent;
    const n = vm.months.length;
    let k = at >= 0 ? at : n - 1;
    if (ke.key === "ArrowLeft") k = Math.max(0, k - 1);
    else if (ke.key === "ArrowRight") k = Math.min(n - 1, k + 1);
    else if (ke.key === "Home") k = 0;
    else if (ke.key === "End") k = n - 1;
    else if (ke.key === "Escape") {
      hide();
      return;
    } else return;
    ke.preventDefault();
    show(k);
  });
  const setMode = (m: Mode) => {
    if (mode === m) return;
    mode = m;
    fillLegend();
    fillTable();
    draw();
  };
  btnA.addEventListener("click", () => setMode("answers"));
  btnB.addEventListener("click", () => setMode("all"));
  plot.append(tip);
  fillLegend();
  fillTable();

  // 幅が変わったら描き直す（入れ物に入った最初の 1 回もここで描く）
  let raf = 0;
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (Math.floor(plot.clientWidth) !== lastW) draw();
    });
  };
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
  if (ro) ro.observe(plot);
  else addEventListener("resize", schedule);
  return {
    el,
    destroy() {
      ro?.disconnect();
      if (!ro) removeEventListener("resize", schedule);
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
