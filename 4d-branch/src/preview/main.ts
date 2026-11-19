// 3 年の分かれ道（試し版）: 読むだけの別のページ（設計: 作業メモ SPEC v1 §5・§10。作業メモ user-8）
// ページに埋め込んだ地図を読み（load.ts）、計算の芯（src/deepmap/core）で 1 回だけ組み直し、
// 見取り図・手の詳しい画面・道の画面（src/deepmap/views）を出す。アカウントにも外にもつながない（読むだけ）。
// 画面の切り替えはハッシュ: #overview（見取り図）・#move-<手の種類>・#path-<カードの番号>。
// 年収を変えると計算だけやり直す（地図の組み直しはしない）。年収はこの端末にだけ覚える（使えなければ覚えない）。

import "../styles/tokens.css";
import "../deepmap/views/views.css";
import "./preview.css";
import { analyze, compileMap, overview, type Analysis, type CompiledMap, type Overview, type TextSource } from "../deepmap/core";
import { clear, h } from "../deepmap/views/dom";
import {
  findFirstMove,
  kindSlug,
  moveDetailVM,
  notesSection,
  notesVM,
  num,
  overviewVM,
  parseRoute,
  pathHash,
  pathVM,
  renderMoveDetail,
  renderOverview,
  renderPathPage,
  ym,
  type PageHandle,
} from "../deepmap/views";
import { parseAnnual } from "../model/impactText";
import { LoadError, loadMap, readEmbedded } from "./load";
import { textSourceFor } from "./textSource";

const STORE_KEY = "deepmap-preview:annual";
const TITLE = "3 年の分かれ道（試し版）";

interface State {
  cm: CompiledMap;
  annual: number;
  a: Analysis;
  ov: Overview;
  text: TextSource;
  /** 行き先の種類ごとの次に見せる番号（今日の手ごと） */
  destCursor: Map<number, Map<string, number>>;
}

/** 試し版の様子（確かめ用。時間は ms） */
interface PreviewInfo {
  ready: boolean;
  error: string | null;
  n: number;
  timings: Record<string, number>;
}
const info: PreviewInfo = { ready: false, error: null, n: 0, timings: {} };
(globalThis as { __deepmapPreview?: PreviewInfo }).__deepmapPreview = info;

function readStoredAnnual(): number | null {
  try {
    const v = localStorage.getItem(STORE_KEY);
    return v === null ? null : parseAnnual(v);
  } catch {
    return null;
  }
}

function storeAnnual(v: number): void {
  try {
    localStorage.setItem(STORE_KEY, String(v));
  } catch {
    /* 覚えられない（保存できないブラウザ）: その時だけの計算 */
  }
}

function showError(app: HTMLElement, e: unknown): void {
  const msg = e instanceof LoadError ? e.message : e instanceof Error && /[^\x20-\x7e]/.test(e.message) ? `地図を開けなかった: ${e.message}` : "地図を開けなかった（思わぬ不具合）";
  info.error = msg;
  console.error(e);
  clear(app);
  app.append(h("div", { class: "pv-error", attrs: { role: "alert" } }, h("h1", { class: "pv-title" }, TITLE), h("p", null, msg)));
}

function statusText(cm: CompiledMap): string {
  const hd = cm.map.header;
  const fixed = cm.has.q > 0;
  const tree = fixed ? "計算の前提を直した木（試し）" : "計算の前提を直す前の木（試し）";
  return hd.release > 0 ? `${tree}・版 ${num(hd.release)}` : tree;
}

function compute(cm: CompiledMap, annual: number): Pick<State, "a" | "ov" | "text"> {
  const a = analyze(cm, annual);
  return { a, ov: overview(a), text: textSourceFor(cm.map, annual) };
}

async function boot(): Promise<void> {
  const app = document.getElementById("app");
  if (!app) return;
  const t0 = performance.now();
  let cm: CompiledMap;
  try {
    const src = readEmbedded(document);
    const t1 = performance.now();
    const map = await loadMap(src);
    const t2 = performance.now();
    cm = compileMap(map);
    const t3 = performance.now();
    info.timings.read = t1 - t0;
    info.timings.decode = t2 - t1;
    info.timings.compile = t3 - t2;
  } catch (e) {
    showError(app, e);
    return;
  }
  const map = cm.map;
  const t3 = performance.now();
  const annual0 = readStoredAnnual() ?? (parseAnnual(String(map.header.annual)) ?? 360);
  const st: State = { cm, annual: annual0, ...compute(cm, annual0), destCursor: new Map() };
  info.timings.analyze = performance.now() - t3;
  info.n = cm.n;

  // ---- 見出し（題名・地図の年月・木の様子・年収・地図の大きさ）
  const input = h("input", {
    class: "pv-annual",
    title: "賞与込みの額面（100〜3,000 万円）",
    attrs: { id: "pv-annual", name: "annual", type: "text", inputmode: "decimal", autocomplete: "off", value: String(st.annual), "aria-describedby": "pv-annual-note pv-annual-msg", enterkeyhint: "done" },
  });
  const msg = h("p", { class: "pv-annual-msg", attrs: { id: "pv-annual-msg", "aria-live": "polite" } });
  const form = h(
    "form",
    { class: "pv-salary", attrs: { novalidate: true } },
    h("label", { class: "pv-annual-label", attrs: { for: "pv-annual" }, title: "賞与込みの額面" }, "年収"),
    input,
    h("span", { class: "pv-annual-unit" }, "万円で計算"),
    h("button", { class: "pv-annual-go", attrs: { type: "submit" } }, "計算し直す"),
    h("span", { class: "pv-sr", attrs: { id: "pv-annual-note" } }, "賞与込みの額面。100〜3,000 万円。変えると全部の数を計算し直す"),
    msg,
  );
  const forks = cm.nDec[0]! + cm.nSplit[0]!;
  const head = h(
    "header",
    { class: "pv-head" },
    h(
      "div",
      { class: "pv-head-main" },
      h("div", { class: "pv-title-row" }, h("h1", { class: "pv-title" }, TITLE), h("p", { class: "pv-date" }, `${ym(map, 0)}時点の地図`)),
      h(
        "p",
        { class: "pv-status" },
        h("span", { class: "pv-status-tree" }, h("span", { class: "pv-status-dot", attrs: { "aria-hidden": "true" } }), statusText(cm)),
        h("span", { class: "pv-size" }, `カード ${num(cm.n)} 枚・分かれ道 ${num(forks)}`),
      ),
    ),
    form,
  );
  const main = h("main", { class: "pv-main", attrs: { id: "pv-main" } });
  const notes = h("div", { class: "pv-notes" });
  clear(app);
  app.append(head, main, notes);

  let page: PageHandle | null = null;
  let current = "";
  let overviewScroll = 0;

  const renderNotes = () => {
    clear(notes);
    notes.append(notesSection(notesVM(st.a, st.ov.basis.delta, st.ov.basis.worth)));
  };

  const render = (opts: { focus: boolean; keepScroll: boolean }) => {
    const t = performance.now();
    const r = parseRoute(location.hash);
    const key = r.name === "move" ? `move:${r.slug}` : r.name === "path" ? `path:${r.node}` : "overview";
    if (current === "overview" && key !== "overview") overviewScroll = scrollY;
    const y = scrollY;
    page?.destroy();
    page = null;
    clear(main);
    let el: HTMLElement;
    if (r.name === "move" && findFirstMove(st.a, kindSlug, r.slug) >= 0) {
      const f = findFirstMove(st.a, kindSlug, r.slug);
      let cursor = st.destCursor.get(f);
      if (!cursor) st.destCursor.set(f, (cursor = new Map()));
      page = renderMoveDetail(moveDetailVM(st.a, f, st.ov), { destCursor: cursor, onDest: (row, k) => (location.hash = pathHash(row.ends[k]!)) });
      el = page.el;
    } else if (r.name === "path" && r.node < cm.n) {
      page = renderPathPage(pathVM(st.a, r.node, st.text));
      el = page.el;
    } else {
      el = renderOverview(overviewVM(st.a, st.ov));
    }
    main.append(el);
    if (opts.keepScroll) scrollTo(0, y);
    else if (key === "overview" && current !== "" && current !== "overview") scrollTo(0, overviewScroll);
    else if (key !== current) scrollTo(0, 0);
    if (opts.focus && key !== current) el.querySelector<HTMLElement>(".dm-h2")?.focus({ preventScroll: true });
    current = key;
    info.timings.render = performance.now() - t;
  };

  const recompute = (v: number) => {
    if (v === st.annual) return;
    const t = performance.now();
    st.annual = v;
    Object.assign(st, compute(cm, v));
    storeAnnual(v);
    renderNotes();
    render({ focus: false, keepScroll: true });
    const ms = performance.now() - t;
    info.timings.recompute = ms;
    msg.textContent = `年収 ${num(v)} 万円で計算し直した`;
  };
  // Enter では change と送信の両方が来る: 2 回目は同じ年収なので何もしない（読めない年収の知らせだけ消す）
  const apply = () => {
    const v = parseAnnual(input.value);
    if (v === null) {
      msg.textContent = "年収は 100〜3,000 万円の数で入れる（例: 360）";
      input.setAttribute("aria-invalid", "true");
      return;
    }
    input.value = String(v);
    if (input.getAttribute("aria-invalid") === "true") {
      input.removeAttribute("aria-invalid");
      msg.textContent = "";
    }
    recompute(v);
  };
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    apply();
  });
  input.addEventListener("change", apply);

  renderNotes();
  render({ focus: false, keepScroll: false });
  addEventListener("hashchange", () => render({ focus: true, keepScroll: false }));
  info.timings.total = performance.now() - t0;
  info.ready = true;
}

void boot();
