// 下部: 時間軸（期限の印・今日・時点のつまみ・再生）とシナリオ切替。
// 時点を動かすと、その日より後の期限のノードが薄くなる（未来が時間とともに現れる）

import type { AppContext } from "../app/context";
import { NODE_TYPES, NODE_TYPE_ORDER } from "../model/constants";
import { addMonths, dayNumber, formatDate, fromDayNumber, todayStr } from "../model/dates";
import type { ID, NodeType } from "../model/types";
import { clear, h } from "./dom";
import { icon } from "./icons";

const PAD_L = 14;
const PAD_R = 14;

export function buildBottomBar(app: AppContext): HTMLElement {
  const { store, ui, vm } = app;
  const canvas = h("canvas", { class: "timeline-canvas", attrs: { "aria-label": "時間軸。押した日までを表示します。ダブルクリックで解除", role: "slider", tabindex: "0" } });
  const tip = h("div", { class: "timeline-tip" });
  tip.hidden = true;
  const wrapCanvas = h("div", { class: "timeline-area" }, canvas, tip);
  const playBtn = h("button", { class: "icon-btn timeline-play", type: "button", title: "今日から未来へ再生", ariaLabel: "再生" }, icon("play", 15));
  const cursorBtn = h("button", { class: "timeline-cursor-btn", type: "button", title: "時点を解除して、すべての時期を表示" });
  const scenarioWrap = h("div", { class: "scenario-switch", role: "radiogroup", ariaLabel: "シナリオ切替" });
  const root = h(
    "footer",
    { class: "bottombar" },
    h(
      "div",
      { class: "bottom-row" },
      h("div", { class: "timeline-side" }, h("div", { class: "bottom-label" }, icon("clock", 13), h("span", null, "時間軸")), h("div", { class: "timeline-controls" }, playBtn, cursorBtn)),
      h("div", { class: "scenario-side" }, h("div", { class: "bottom-label" }, icon("split", 13), h("span", null, "シナリオ")), scenarioWrap),
    ),
    wrapCanvas,
  );

  const ctx = canvas.getContext("2d")!;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let range = { start: 0, end: 1 };
  let markers: Array<{ id: ID; x: number; y: number; type: NodeType }> = [];
  let dragging = false;
  let playing: { raf: number; from: number; to: number; t0: number } | null = null;
  let scheduled = false;
  let hoverId: ID | null = null;

  const computeRange = () => {
    const today = dayNumber(todayStr());
    let min = today;
    let max = today;
    for (const id in store.doc.nodes) {
      const due = store.doc.nodes[id]!.time.due;
      if (!due) continue;
      const d = dayNumber(due);
      if (d < min) min = d;
      if (d > max) max = d;
    }
    const startStr = addMonths(fromDayNumber(min), -1).slice(0, 8) + "01";
    const endStr = addMonths(fromDayNumber(Math.max(max, today + 300)), 2).slice(0, 8) + "01";
    range = { start: dayNumber(startStr), end: dayNumber(endStr) };
  };

  const xOf = (day: number) => PAD_L + ((day - range.start) / Math.max(1, range.end - range.start)) * (width - PAD_L - PAD_R);
  const dayOf = (x: number) => Math.round(range.start + ((x - PAD_L) / Math.max(1, width - PAD_L - PAD_R)) * (range.end - range.start));
  const laneY = (t: NodeType) => 20 + NODE_TYPE_ORDER.indexOf(t) * ((height - 24) / 4) + (height - 24) / 8;

  const resize = () => {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    width = Math.max(10, Math.round(r.width));
    height = Math.max(10, Math.round(r.height));
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    schedule();
  };
  new ResizeObserver(resize).observe(wrapCanvas);

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(draw);
  };

  const draw = () => {
    scheduled = false;
    if (!width) return;
    vm.ensure();
    computeRange();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const today = dayNumber(todayStr());
    const font = 'system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';

    // レーン
    for (const t of NODE_TYPE_ORDER) {
      const y = laneY(t);
      ctx.strokeStyle = "rgba(255,255,255,0.045)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD_L, Math.round(y) + 0.5);
      ctx.lineTo(width - PAD_R, Math.round(y) + 0.5);
      ctx.stroke();
    }

    // 目盛り（月・年）。何十年も先の期限があっても最後まで描けるよう、長いときは 1 年・10 年おきにする
    const months = Math.max(1, (range.end - range.start) / 30.4);
    const pxPerMonth = (width - PAD_L - PAD_R) / months;
    const step = months > 2400 ? 120 : months > 240 ? 12 : 1;
    let m = fromDayNumber(range.start);
    if (step > 1) {
      // 1 月 1 日（10 年おきなら 10 で割り切れる年）にそろえる
      let yy = Number(m.slice(0, 4)) + (m.slice(5) === "01-01" ? 0 : 1);
      if (step === 120) yy = Math.ceil(yy / 10) * 10;
      m = `${yy}-01-01`;
    }
    ctx.font = `600 10.5px ${font}`;
    ctx.textBaseline = "top";
    let guard = 0;
    let lastLabel = -Infinity;
    while (dayNumber(m) <= range.end && guard++ < 400) {
      const d = dayNumber(m);
      const x = Math.round(xOf(d)) + 0.5;
      const [y, mo] = m.split("-");
      const isYear = mo === "01";
      const isQuarter = mo === "01" || mo === "04" || mo === "07" || mo === "10";
      ctx.strokeStyle = isYear ? "rgba(255,255,255,0.22)" : isQuarter ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.06)";
      ctx.beginPath();
      ctx.moveTo(x, isYear ? 4 : 14);
      ctx.lineTo(x, height - 4);
      ctx.stroke();
      // 文字は重ならない間隔のときだけ
      if ((isYear || (pxPerMonth > 30 && isQuarter) || pxPerMonth > 54) && x - lastLabel > 38) {
        ctx.fillStyle = isYear ? "rgba(231,234,241,0.85)" : "rgba(163,171,186,0.6)";
        ctx.fillText(isYear ? `${y}年` : `${Number(mo)}月`, x + 4, 3);
        lastLabel = x;
      }
      m = addMonths(m, step);
    }

    // 時点より後を暗く
    const cursor = ui.prefs.timeCursor;
    if (cursor) {
      const cx = xOf(dayNumber(cursor));
      ctx.fillStyle = "rgba(5,7,11,0.55)";
      ctx.fillRect(cx, 0, width - cx, height);
    }

    // 今日
    const tx = Math.round(xOf(today)) + 0.5;
    ctx.strokeStyle = "rgba(77,163,255,0.9)";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(tx, 14);
    ctx.lineTo(tx, height);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(77,163,255,1)";
    ctx.font = `700 10px ${font}`;
    ctx.fillText("今日", tx + 3, 15);

    // 期限の印
    markers = [];
    const doc = store.doc;
    const sel = ui.selection.nodes;
    for (const id of vm.drawNodes) {
      const n = doc.nodes[id]!;
      if (!n.time.due) continue;
      const x = xOf(dayNumber(n.time.due));
      const y = laneY(n.type);
      markers.push({ id, x, y, type: n.type });
    }
    for (const mk of markers) {
      const v = vm.nodes.get(mk.id)!;
      const big = sel.has(mk.id) || hoverId === mk.id;
      const s = big ? 6.5 : 4.2;
      ctx.globalAlpha = Math.max(0.28, v.alpha);
      ctx.fillStyle = NODE_TYPES[mk.type].color;
      ctx.beginPath();
      ctx.moveTo(mk.x, mk.y - s);
      ctx.lineTo(mk.x + s, mk.y);
      ctx.lineTo(mk.x, mk.y + s);
      ctx.lineTo(mk.x - s, mk.y);
      ctx.closePath();
      ctx.fill();
      if (big) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // 時点のつまみ
    if (cursor) {
      const cx = Math.round(xOf(dayNumber(cursor))) + 0.5;
      ctx.strokeStyle = "rgba(165,151,255,1)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, height);
      ctx.stroke();
      ctx.fillStyle = "rgba(165,151,255,1)";
      ctx.beginPath();
      ctx.moveTo(cx - 6, 0);
      ctx.lineTo(cx + 6, 0);
      ctx.lineTo(cx, 8);
      ctx.closePath();
      ctx.fill();
    }
    syncControls();
  };

  const syncControls = () => {
    const cursor = ui.prefs.timeCursor;
    clear(cursorBtn);
    if (cursor) {
      cursorBtn.append(h("span", null, `${formatDate(cursor)} まで`), icon("x", 12, 2));
      cursorBtn.classList.add("on");
      cursorBtn.title = "時点を解除して、すべての時期を表示";
    } else {
      cursorBtn.append(h("span", null, "すべての時期"));
      cursorBtn.classList.remove("on");
      cursorBtn.title = "時間軸を押すと、その日までを表示します";
    }
    clear(playBtn);
    playBtn.append(icon(playing ? "pause" : "play", 15));
    playBtn.title = playing ? "止める" : "今日から未来へ再生（時点を動かす）";
  };

  const setCursorAt = (x: number) => {
    const d = Math.max(range.start, Math.min(range.end, dayOf(x)));
    ui.setPrefs({ timeCursor: fromDayNumber(d) });
  };

  const markerAt = (x: number, y: number) => {
    let best: { id: ID; d: number } | null = null;
    for (const mk of markers) {
      const d = Math.hypot(mk.x - x, mk.y - y);
      if (d <= 8 && (!best || d < best.d)) best = { id: mk.id, d };
    }
    return best?.id ?? null;
  };

  const local = (ev: PointerEvent | MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };

  canvas.addEventListener("pointerdown", (ev) => {
    stopPlay();
    const p = local(ev);
    const cursor = ui.prefs.timeCursor;
    const nearCursor = cursor && Math.abs(xOf(dayNumber(cursor)) - p.x) <= 7;
    const mk = nearCursor ? null : markerAt(p.x, p.y);
    if (mk) {
      ui.select([mk]);
      if (ui.prefs.view === "map") app.view.centerOn(mk);
      else app.revealInList(mk);
      return;
    }
    dragging = true;
    canvas.setPointerCapture(ev.pointerId);
    setCursorAt(p.x);
  });
  canvas.addEventListener("pointermove", (ev) => {
    const p = local(ev);
    if (dragging) {
      setCursorAt(p.x);
      return;
    }
    const mk = markerAt(p.x, p.y);
    if (mk !== hoverId) {
      hoverId = mk;
      schedule();
    }
    if (mk) {
      const n = store.doc.nodes[mk]!;
      tip.hidden = false;
      clear(tip);
      tip.append(h("span", { class: `type-chip type-${n.type}` }, icon(n.type, 11)), h("span", null, n.title || "（無題）"), h("span", { class: "muted" }, formatDate(n.time.due)));
      const mx = markers.find((m2) => m2.id === mk)!;
      tip.style.left = `${Math.max(4, Math.min(width - 220, mx.x - 20))}px`;
      canvas.style.cursor = "pointer";
    } else {
      tip.hidden = true;
      canvas.style.cursor = "col-resize";
    }
  });
  canvas.addEventListener("pointerleave", () => {
    tip.hidden = true;
    if (hoverId) {
      hoverId = null;
      schedule();
    }
  });
  canvas.addEventListener("pointerup", () => (dragging = false));
  canvas.addEventListener("dblclick", () => ui.setPrefs({ timeCursor: null }));
  canvas.addEventListener("keydown", (ev) => {
    const cur = ui.prefs.timeCursor ? dayNumber(ui.prefs.timeCursor) : dayNumber(todayStr());
    if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
      ev.preventDefault();
      const step = ev.shiftKey ? 30 : 7;
      const next = Math.max(range.start, Math.min(range.end, cur + (ev.key === "ArrowRight" ? step : -step)));
      ui.setPrefs({ timeCursor: fromDayNumber(next) });
    } else if (ev.key === "Escape" || ev.key === "Delete" || ev.key === "Backspace") {
      ui.setPrefs({ timeCursor: null });
    }
  });

  cursorBtn.addEventListener("click", () => {
    stopPlay();
    if (ui.prefs.timeCursor) ui.setPrefs({ timeCursor: null });
    else ui.setPrefs({ timeCursor: todayStr() });
  });

  const stopPlay = () => {
    if (!playing) return;
    cancelAnimationFrame(playing.raf);
    playing = null;
    syncControls();
  };
  playBtn.addEventListener("click", () => {
    if (playing) return stopPlay();
    computeRange();
    const from = Math.max(range.start, Math.min(dayNumber(todayStr()), range.end));
    const to = range.end;
    const step = (t: number) => {
      if (!playing) return;
      const p = Math.min(1, (t - playing.t0) / 7000);
      const d = Math.round(playing.from + (playing.to - playing.from) * p);
      ui.setPrefs({ timeCursor: fromDayNumber(d) });
      if (p >= 1) {
        playing = null;
        syncControls();
        return;
      }
      playing.raf = requestAnimationFrame(step);
    };
    playing = { raf: 0, from, to, t0: performance.now() };
    playing.raf = requestAnimationFrame(step);
    syncControls();
  });

  // シナリオ切替
  const renderScenarios = () => {
    clear(scenarioWrap);
    const doc = store.doc;
    const sid = ui.prefs.scenarioId && doc.scenarios[ui.prefs.scenarioId] ? ui.prefs.scenarioId : null;
    const chip = (id: ID | null, label: string, color: string | null) => {
      const on = sid === id;
      const b = h("button", { class: `scen-chip${on ? " active" : ""}`, type: "button", role: "radio", attrs: { "aria-checked": String(on) }, title: id ? (doc.scenarios[id]?.description || label) : "シナリオで絞らずにすべて表示" }, color ? h("span", { class: "dot", style: { background: color } }) : icon("layers", 13), h("span", null, label));
      if (color) b.style.setProperty("--chip-color", color);
      b.addEventListener("click", () => ui.setPrefs({ scenarioId: id }));
      scenarioWrap.append(b);
    };
    chip(null, "すべて", null);
    for (const id of doc.scenarioOrder) {
      const s = doc.scenarios[id];
      if (s) chip(id, s.name, s.color);
    }
  };

  store.on("change", (info) => {
    schedule();
    if (!info.positionsOnly) renderScenarios();
  });
  ui.on("visual", schedule);
  ui.on("prefs", () => {
    schedule();
    renderScenarios();
  });
  renderScenarios();
  return root;
}
