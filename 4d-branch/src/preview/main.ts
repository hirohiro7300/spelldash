// 3 年の分かれ道（試し版）: 読むだけの別のページ（設計: 作業メモ SPEC v1 §5・§10。作業メモ user-8）
// ページに埋め込んだ地図を読み（load.ts）、計算の芯（src/deepmap/core）で 1 回だけ組み直し、
// 見取り図・手の詳しい画面・道の画面（src/deepmap/views）を出す。アカウントにも外にもつながない（読むだけ）。
// 画面の切り替えはハッシュ: #overview（見取り図）・#move-<手の種類>・#path-t<カードの鍵の短い名前>（そのカードを通る道。ほかの結果・
// 手を押すと、そのカードの #path-t… へ。戻る・進むで道を行き来でき、道ごとに開いていた行と位置を覚えている）。
// 道は鍵から作る名前で指すので、地図を作り直して番号がずれても同じカードの道が開く。今の地図に無い道（と前の版の番号の道）は、
// 見取り図を出して「この道は今の地図には無い」と知らせる（作業メモ code-2）。
// 年収を変えると計算だけやり直す（地図の組み直しはしない）。年収はこの端末にだけ覚える（使えなければ覚えない）。
// 地図は同梱データ（版 7 の候補から。開発用の入れ子の木も読める。load.ts）。カードの文章は文章の組み立て（./composeText.ts）が、
// 道の画面で開いた行と着いた所のカードだけを、その時の年収で書く（起動では組み立てない）。

import "../styles/tokens.css";
import "../deepmap/views/views.css";
import "../styles/goal.css";
import "./preview.css";
import { analyze, CHECKED_ANNUALS, compileMap, goalBase, goalOf, overview, setGoalSource, type Analysis, type CompiledMap, type GoalView, type Overview, type TextSource } from "../deepmap/core";
import { clear, h } from "../deepmap/views/dom";
import {
  findFirstMove,
  findPathToken,
  kindSlug,
  warmPathTokens,
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
  type PathPageHandle,
} from "../deepmap/views";
import { goalAnchor, goalConfigOf, tablesFor } from "../model/goal";
import { parseAnnual } from "../model/impactText";
import { composedText, composeStats, textSkew, type ComposeStats } from "./composeText";
import { LoadError, loadMap, readEmbedded } from "./load";
import { setTextFactory, textSourceFor } from "./textSource";

const STORE_KEY = "deepmap-preview:annual";
const TITLE = "3 年の分かれ道（試し版）";

// カードの文章は文章の組み立て（地図の数だけの仮の文章は使わない）
setTextFactory(composedText);

interface State {
  cm: CompiledMap;
  annual: number;
  a: Analysis;
  ov: Overview;
  text: TextSource;
  /** 行き先の種類ごとの次に見せる番号（今日の手ごと） */
  destCursor: Map<number, Map<string, number>>;
}

/** 試し版の様子（確かめ用。時間は ms。visible は開き始めから見取り図が描かれた次の画面までの時間） */
interface PreviewInfo {
  ready: boolean;
  /** 最初の画面が描かれた */
  visible: boolean;
  error: string | null;
  n: number;
  timings: Record<string, number>;
  /** 道の切り替え（ほかの結果・手を押してから、切り替えた道が描かれた次の画面まで）の時間 */
  pathSwitches: number[];
  /** 地図が持つ物の数（q・mix・cont・never） */
  has: { q: number; mix: number; cont: number; never: boolean } | null;
  /** 埋め込んだデータの形・版の順番・指紋・文の型の版 */
  map: { format: string; release: number; hash: string; textVersion: string } | null;
  /** 文章: 仮の文章か・組み立てた枚数と時間（起動の後は 0 枚。開いた行の分だけ増える） */
  text: { provisional: boolean; composed: ComposeStats };
}
const info: PreviewInfo = { ready: false, visible: false, error: null, n: 0, timings: {}, pathSwitches: [], has: null, map: null, text: { provisional: false, composed: composeStats } };
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
  const tree = fixed ? "計算の前提を直した地図（試し）" : "計算の前提を直す前の地図（試し）";
  return hd.release > 0 ? `${tree}・版 ${num(hd.release)}` : tree;
}

function compute(cm: CompiledMap, annual: number): Pick<State, "a" | "ov" | "text"> {
  const a = analyze(cm, annual);
  // 資産のゴールは仮の前提だけ（試し版は前提を入れる所が無い。どれも（仮）と出る）
  let goal: GoalView | null = null;
  setGoalSource(a, () => {
    if (!goal) {
      const read = goalConfigOf(null);
      const base = goalBase(a);
      goal = { read, base, summary: goalOf(base, tablesFor(read.cfg, goalAnchor(cm.map.header.anchor))) };
    }
    return goal;
  });
  // 本文にもこの年収の計算の芯の答え（おすすめ・数）を渡す（画面と本文で同じおすすめ。作業メモ truth-1）
  return { a, ov: overview(a), text: textSourceFor(cm.map, annual, a) };
}

/** 地図の深さを確かめた年収の外か（作業メモ truth-5） */
const outsideChecked = (v: number): boolean => v < CHECKED_ANNUALS[0] || v > CHECKED_ANNUALS[1];
/** 年収が地図の深さを確かめた範囲の外のときの知らせ（範囲の中なら空） */
function rangeNote(v: number): string {
  if (!outsideChecked(v)) return "";
  return `年収 ${num(v)} 万円は、地図の深さを確かめた ${num(CHECKED_ANNUALS[0])}〜${num(CHECKED_ANNUALS[1])} 万円の外。一番良い道が途中から標準の続きの見積もりになることがある`;
}

async function boot(): Promise<void> {
  const app = document.getElementById("app");
  if (!app) return;
  const t0 = performance.now();
  let cm: CompiledMap;
  let format = "";
  try {
    const src = readEmbedded(document);
    format = src.format;
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
  info.has = { ...cm.has };
  info.map = { format, release: map.header.release, hash: map.header.hash, textVersion: map.header.textVersion };
  info.text.provisional = !!st.text.provisional;
  // 焼き込んだ文章の文の型の版と、この試し版の組み立ての版（違えば知らせる。作業メモ code-1）
  const skew = textSkew(map.header.textVersion);

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
    h("span", { class: "pv-sr", attrs: { id: "pv-annual-note" } }, `賞与込みの額面。100〜3,000 万円。変えると全部の数を計算し直す。地図の深さは ${num(CHECKED_ANNUALS[0])}〜${num(CHECKED_ANNUALS[1])} 万円で確かめた`),
    msg,
  );
  // 地図の深さを確かめた年収の外なら、計算し直した知らせと一緒に言う（作業メモ truth-5）
  if (outsideChecked(st.annual)) msg.textContent = rangeNote(st.annual);
  const forks = cm.nDec[0]! + cm.nSplit[0]!;
  const head = h(
    "header",
    { class: "pv-head" },
    h(
      "div",
      { class: "pv-head-main" },
      h(
        "div",
        { class: "pv-title-row" },
        h("h1", { class: "pv-title" }, TITLE),
        h("p", { class: "pv-date" }, `${ym(map, 0)}時点の地図`, h("span", { class: "pv-size" }, `カード ${num(cm.n)} 枚`, h("span", { class: "pv-size-forks" }, `・分かれ道 ${num(forks)}`))),
      ),
      h("p", { class: "pv-status" }, h("span", { class: "pv-status-tree" }, h("span", { class: "pv-status-dot", attrs: { "aria-hidden": "true" } }), statusText(cm))),
    ),
    form,
  );
  // 見取り図・道の画面の並べ方は入れ物の幅で決まる（views.css の .dm-host。コンテナークエリ）
  const main = h("main", { class: "pv-main dm-host", attrs: { id: "pv-main" } });
  if (skew) head.append(h("p", { class: "pv-notice", attrs: { role: "status" } }, `${skew}。地図を作り直すまで、題と本文の言い方が合わないことがある`));
  const notes = h("div", { class: "pv-notes dm-host" });
  clear(app);
  app.append(head, main, notes);

  let page: PageHandle | null = null;
  let pathPage: PathPageHandle | null = null;
  let current = "";
  let currentHash = "";
  let overviewScroll = 0;
  /** 道の画面ごとに、開いていた行と位置（戻る・進むで元どおりに） */
  const pathMemory = new Map<string, { open: string[]; scroll: number }>();
  /** ほかの結果・手を押した（次の道の画面で、その行を開いて同じ位置に置く） */
  let pending: { href: string; key: string; top: number; t0: number } | null = null;
  const afterPaint = (fn: () => void) => requestAnimationFrame(() => requestAnimationFrame(fn));

  const renderNotes = () => {
    clear(notes);
    notes.append(notesSection(notesVM(st.a, st.ov.basis.delta, st.ov.basis.worth, { worthNoise: st.ov.worthNoise })));
  };

  const render = (opts: { focus: boolean; keepScroll: boolean }) => {
    const t = performance.now();
    const hash = location.hash;
    const r = parseRoute(hash);
    // 道の名前 → カード（今の地図に無ければ −1: 見取り図と知らせ）
    const pathNode = r.name === "path" && r.token ? findPathToken(map, r.token) : -1;
    const lostPath = r.name === "path" && pathNode < 0;
    const key = r.name === "move" ? `move:${r.slug}` : r.name === "path" && pathNode >= 0 ? `path:${pathNode}` : "overview";
    if (current === "overview" && key !== "overview") overviewScroll = scrollY;
    // 道の画面を離れる（作り直す）前に、開いていた行と位置を覚える（新しい 200 本まで）
    if (pathPage) {
      pathMemory.delete(currentHash);
      pathMemory.set(currentHash, { open: pathPage.openKeys(), scroll: scrollY });
      if (pathMemory.size > 200) pathMemory.delete(pathMemory.keys().next().value!);
    }
    const y = scrollY;
    page?.destroy();
    page = null;
    pathPage = null;
    clear(main);
    let el: HTMLElement;
    let sw: { key: string; top: number; t0: number } | null = null;
    let memo: { open: string[]; scroll: number } | undefined;
    if (r.name === "move" && findFirstMove(st.a, kindSlug, r.slug) >= 0) {
      const f = findFirstMove(st.a, kindSlug, r.slug);
      let cursor = st.destCursor.get(f);
      if (!cursor) st.destCursor.set(f, (cursor = new Map()));
      page = renderMoveDetail(moveDetailVM(st.a, f, st.ov), { destCursor: cursor, onDest: (row, k) => (location.hash = pathHash(map, row.ends[k]!)) });
      el = page.el;
    } else if (r.name === "path" && pathNode >= 0) {
      // ほかの結果・手を押して来た: その行だけ開いて同じ位置に。戻る・進む・年収の計算し直し: 覚えた行と位置
      if (pending && pending.href === hash) sw = pending;
      pending = null;
      memo = sw ? undefined : pathMemory.get(hash);
      const tv = performance.now();
      if (sw) info.timings.pathQueue = tv - sw.t0;
      const vm = pathVM(st.a, pathNode, st.text);
      const td = performance.now();
      info.timings.pathVM = td - tv;
      pathPage = renderPathPage(vm, {
        open: sw ? new Set([sw.key]) : memo ? new Set(memo.open) : undefined,
        onSwitch: (k, top, href) => {
          pending = { href, key: k, top, t0: performance.now() };
          // 履歴に足してすぐ描き直す（hashchange を待たない。戻る・進むは hashchange で来る）。使えなければリンクのまま
          try {
            history.pushState(null, "", href);
          } catch {
            return false;
          }
          if (location.hash !== href) return false;
          render({ focus: false, keepScroll: false });
          return true;
        },
      });
      page = pathPage;
      el = pathPage.el;
      info.timings.pathDom = performance.now() - td;
    } else {
      const tv = performance.now();
      const vm = overviewVM(st.a, st.ov);
      const td = performance.now();
      info.timings.overviewVM = td - tv;
      el = renderOverview(vm);
      info.timings.overviewDom = performance.now() - td;
      if (lostPath)
        el.prepend(h("p", { class: "pv-notice", attrs: { role: "status" } }, "開いた道は今の地図には無い（地図を作り直したので、前のリンクの道は別の名前になった）。見取り図を出している"));
    }
    const ta = performance.now();
    main.append(el);
    if (sw && pathPage) {
      pathPage.align(sw.key, sw.top);
      pathPage.focus(sw.key);
      info.timings.pathLayout = performance.now() - ta;
      const t0 = sw.t0;
      afterPaint(() => {
        const ms = performance.now() - t0;
        info.pathSwitches.push(ms);
        if (info.pathSwitches.length > 100) info.pathSwitches.shift();
        info.timings.pathSwitch = ms;
      });
    } else if (opts.keepScroll) scrollTo(0, memo ? memo.scroll : y);
    else if (memo) scrollTo(0, memo.scroll);
    else if (key === "overview" && current !== "" && current !== "overview") scrollTo(0, overviewScroll);
    else if (key !== current) scrollTo(0, 0);
    if (opts.focus && key !== current && !sw) el.querySelector<HTMLElement>(".dm-h2")?.focus({ preventScroll: true });
    current = key;
    currentHash = hash;
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
    const note = rangeNote(v);
    msg.textContent = `年収 ${num(v)} 万円で計算し直した${note ? `。${note}` : ""}`;
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
  // 開き始め（performance の 0）から、最初の画面が描かれた次の画面まで
  afterPaint(() => {
    info.timings.visible = performance.now();
    info.visible = true;
    // 道の名前 → カードの表は、最初の画面の後の空いた時間に少しずつ作っておく（最初に道を開くときに待たせない。長く止めない）
    type Deadline = { timeRemaining(): number };
    const idle = (globalThis as { requestIdleCallback?: (fn: (d: Deadline) => void, o?: { timeout: number }) => number }).requestIdleCallback;
    let spent = 0;
    const warm = (d: Deadline | null) => {
      const t = performance.now();
      let done = false;
      do done = warmPathTokens(map, 2000);
      while (!done && (d ? d.timeRemaining() > 4 : performance.now() - t < 8));
      spent += performance.now() - t;
      if (done) info.timings.pathIndex = spent;
      else if (idle) idle(warm, { timeout: 1000 });
      else setTimeout(() => warm(null), 16);
    };
    if (idle) idle(warm, { timeout: 2000 });
    else setTimeout(() => warm(null), 200);
  });
}

void boot();
