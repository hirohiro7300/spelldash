// 右のパネル（狭い画面では引き出し）の 3 か月ごとの地図（版 7）の画面。設計: 作業メモ SPEC v1 §5.1〜§5.5・§5.7・§5.8・§4.4
// （見直し user-1〜user-7・user-12・user-14・user-20・safety-10）。画面の形は試し版と同じ物（src/deepmap/views）を使う。
//   見取り図        何も選んでいないときの概要の先頭（10 の手の 3 年の幅・その手で分かること・2 つの差・数・ひと目の 10 行・読み方）
//   手の詳しい画面  見取り図の手を押すと、パネル（引き出し）の中に（扇・分かれ道の帯・進め方・行き先の種類）
//   道の画面        一番ありそうな道・どのカードの「この先の道」も、今日から 2029 年 11 月まで 3 か月に 1 行。ほかの結果・手を押すと道が切り替わる
//   カードの詳細    3 か月ごとの地図のカードなら、この先の道・時間で区切って開く・組み立てた本文（読むだけ）と自分のメモ
// 画面の切り替えはハッシュを使わない（ページの # はアプリの表示の種類: #demo-q など。変えると開き直す）。画面の中のリンク
// （#overview・#move-…・#path-t…）は押したところで止め、パネルの中の画面を切り替える（UiState.openDeep）。
// 試し版の画面は広い画面ではページの幅で列に並ぶが、ここでは入れ物（.dm-host）の幅で決まるので、パネルの中は狭い並べ方になる（views.css）。

import "../deepmap/views/views.css";
import "../styles/deep.css";
import type { AppContext } from "../app/context";
import { whenIdle, type IdleDeadlineLike } from "../app/idle";
import { cardWithDocOdds, type DeepCtx } from "../app/deepState";
import type { DeepPage } from "../app/uiState";
import { endsFrom, goalFrom, type Analysis, type Overview } from "../deepmap/core";
import { goalAnchor, goalConfigOf, tablesFor } from "../model/goal";
import { goalFromLine, findFirstMove, findPathToken, kindSlug, moveDetailVM, notesSection, notesVM, overviewVM, parseRoute, pathVM, renderMoveDetail, renderOverview, renderPathPage, ym, type MoveDetailVM, type OverviewMemo, type OverviewVM, type PathVM } from "../deepmap/views";
import { DEEP_OPEN_CAP, deepHorizons, likelyPaths, likelyReady, quarterOpens, quarterOpensReady, type DeepHorizon } from "../model/deepOpen";
import { buildMultiOpen, depthRows, drawnSplit, foldBtn, hiddenRows, isDrawn, keepFocus, likelyRows, moveFit, moveRun, pickToggle, quarterRows, runBulk, type MoveFit } from "./bulkOpen";
import type { ID } from "../model/types";
import { isNarrowScreen } from "./breakpoints";
import { clear, h } from "./dom";
import { icon } from "./icons";
import { toast } from "./overlays";

/** 数を 3 桁ごとに区切る */
const num = (v: number): string => Math.round(v).toLocaleString("en-US");

/** 画面の中のリンクの先（ハッシュ → 地図の番号）。画面の形を作ったときに分かる物は先に覚える（道の名前の表を作らずに済む） */
type HrefMap = Map<string, number>;

function rememberOverview(vm: OverviewVM, hrefs: HrefMap): void {
  for (const c of [vm.chain, vm.median]) if (c) hrefs.set(c.href, c.node);
}

function rememberMove(vm: MoveDetailVM, hrefs: HrefMap): void {
  for (const c of [vm.chain, vm.median]) if (c) hrefs.set(c.href, c.node);
}

function rememberPath(ctx: DeepCtx, vm: PathVM, hrefs: HrefMap): void {
  const add = (st: PathVM["steps"][number]) => {
    for (const x of st.outcomes) hrefs.set(x.href, x.node);
    for (const x of st.options) hrefs.set(x.href, x.node);
  };
  for (const st of vm.steps) add(st);
  if (vm.resetHref) {
    const f = ctx.cm.first[vm.node] ?? -1;
    hrefs.set(vm.resetHref, f >= 0 ? f : 0);
  }
}

/** 押したリンクの先の地図の番号（覚えていなければ道の名前の表から。無ければ −1） */
function nodeOfHref(ctx: DeepCtx, hrefs: HrefMap, href: string): number {
  const known = hrefs.get(href);
  if (known !== undefined) return known;
  const r = parseRoute(href);
  return r.name === "path" && r.token ? findPathToken(ctx.map, r.token) : -1;
}

/**
 * 画面の中のリンク（#overview・#move-…・#path-t…）をパネルの中の画面の切り替えにする。どのリンクもハッシュは変えない
 * （変えるとアプリが表示の種類を読み直して開き直す）ので、いつも true（行き先が無ければ知らせるだけ）。
 * from: 押した画面（道の画面の中で別の道へは置き換え、ほかからは今の画面を戻る先に積む）
 */
function follow(app: AppContext, ctx: DeepCtx, hrefs: HrefMap, href: string, from: DeepPage["kind"] | "overview"): boolean {
  const r = parseRoute(href);
  const ui = app.ui;
  if (r.name === "overview") {
    ui.closeDeep();
    ui.holdDeep(() => ui.clearSelection());
    return true;
  }
  if (r.name === "move") {
    const f = findFirstMove(ctx.analysis(), kindSlug, r.slug);
    if (f < 0) toast("その手は今の地図には無い", { tone: "warn" });
    else ui.openDeep({ kind: "move", f }, { push: from !== "overview" });
    return true;
  }
  const node = nodeOfHref(ctx, hrefs, href);
  if (node < 0) {
    toast("その道は今の地図には無い", { tone: "warn" });
    return true;
  }
  ui.openDeep({ kind: "path", node }, { push: from !== "overview" && from !== "path" });
  return true;
}

/** 入れ物の中のリンクを押したとき（新しいタブで開く押し方はそのまま。画面の部品が先に止めた物は見ない） */
function interceptLinks(el: HTMLElement, go: (href: string) => boolean): void {
  el.addEventListener("click", (ev) => {
    if (ev.defaultPrevented || ev.button > 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const a = (ev.target as Element | null)?.closest?.("a[href^='#']");
    if (!a || !el.contains(a)) return;
    const href = a.getAttribute("href") ?? "";
    if (go(href)) ev.preventDefault();
  });
}

/**
 * 概要の見取り図を見せる（3 か月ごとの地図の画面を閉じ・選択を外し・パネルを開き、見取り図の見出しまで送ってフォーカス）。
 * 概要がもう出ていても、下の方を見ていたら見取り図の頭へ（見直し user-10）
 */
export function showDeepOverview(app: AppContext): void {
  app.ui.closeDeep();
  app.ui.holdDeep(() => app.ui.clearSelection());
  if (!app.ui.prefs.rightOpen) app.ui.setPrefs({ rightOpen: true });
  requestAnimationFrame(() => {
    const ov = document.querySelector<HTMLElement>(".sidebar-right .deep-ov");
    const sc = document.querySelector<HTMLElement>(".sidebar-right .insp-body-scroll");
    if (!sc) return;
    if (!ov || ov.hidden) {
      sc.scrollTop = 0;
      return;
    }
    sc.scrollTop += ov.getBoundingClientRect().top - sc.getBoundingClientRect().top;
    const head = ov.querySelector<HTMLElement>(".dm-h2, h2, h3");
    if (head) {
      if (!head.hasAttribute("tabindex")) head.setAttribute("tabindex", "-1");
      head.focus({ preventScroll: true });
    }
  });
}

/** 地図の元の数で出している・方針で絞らない、の注記（どちらも無ければ null） */
function ctxNotes(app: AppContext, ctx: DeepCtx): HTMLElement | null {
  const lines: string[] = [];
  if (ctx.edited) lines.push("見取り図と道は、地図の元の数で出している（足したカード・書き換えた見込みは入らない。カードの差の札は書き換えた数で計算）");
  if (ctx.scenario) {
    const name = app.store.doc.scenarios[ctx.scenario]?.name ?? "選んだ方針";
    lines.push(`「${name}」を選んでいる間も、差と 3 年の稼ぎは方針で絞らない（この地図の先の選び方は方針を見ずに作ったので、絞った数は正しくない）。方針の外の手は薄くしている`);
  }
  return lines.length ? h("div", { class: "deep-note", attrs: { role: "note" } }, ...lines.map((t) => h("p", null, t))) : null;
}

// ------------------------------------------------------------ 見取り図（概要の先頭）

/**
 * 描いた見取り図の中身（概要を作り直すたびに描き直さない。カードを選んで閉じたときは、同じ物を戻す）。
 * 計算（Analysis と Overview）が同じなら同じ中身（シナリオ・編集の有無で変わるのは上の注記と、方針の外の手の薄さだけ）
 */
const overviewCache = new WeakMap<AppContext, { a: Analysis; ov: Overview; nodes: Node[]; hrefs: HrefMap; moves: Map<string, number> }>();

/** 見取り図の行の、前に組み立てた物（計算が変わって作り直すとき、中身が同じ行は組み直さずに写す） */
const overviewMemos = new WeakMap<AppContext, OverviewMemo>();
function overviewMemo(app: AppContext): OverviewMemo {
  let m = overviewMemos.get(app);
  if (!m) overviewMemos.set(app, (m = { prev: new Map() }));
  return m;
}

/**
 * 描いてある DOM（a）を、新しく組み立てた同じ形の DOM（b）に合わせる。同じ所はそのまま残し（配置と文字の組み直しをしない）、
 * 違う文字・属性だけ書き換え、形が違う所は b の物と入れ替える。見取り図の部品（src/deepmap/views）は押した時の処理を要素に付けない
 * （リンクは入れ物で受ける）ので、残した要素が古い処理を持つことはない。開いた「見取り図の見方」（details の open）は利用者の物なので残す。
 * 合わせた後の要素（a か、入れ替えた b）を返す
 */
function morphNode(a: Node, b: Node): Node {
  if (a.isEqualNode(b)) return a;
  if (a.nodeType === Node.TEXT_NODE && b.nodeType === Node.TEXT_NODE) {
    (a as Text).data = (b as Text).data;
    return a;
  }
  if (!(a instanceof Element) || !(b instanceof Element) || a.namespaceURI !== b.namespaceURI || a.tagName !== b.tagName) {
    a.parentNode?.replaceChild(b, a);
    return b;
  }
  for (const at of [...a.attributes]) if (!b.hasAttribute(at.name) && !(at.name === "open" && a.tagName === "DETAILS")) a.removeAttribute(at.name);
  for (const at of [...b.attributes]) if (a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value);
  const ac = [...a.childNodes];
  const bc = [...b.childNodes];
  const n = Math.min(ac.length, bc.length);
  for (let i = 0; i < n; i++) morphNode(ac[i]!, bc[i]!);
  for (let i = n; i < ac.length; i++) ac[i]!.remove();
  for (let i = n; i < bc.length; i++) a.appendChild(bc[i]!);
  return a;
}

/**
 * 方針の外の今日の手の行を薄くする（ひと目の行と手のカード。見取り図の数は方針で絞らないので、行は残して薄くするだけ:
 * 作業メモ SPEC v1 §5.11・見直し user-13）。moves は行の行き先（#move-…）→ 今日の手の地図の番号
 */
function dimOffScenario(app: AppContext, ctx: DeepCtx, root: HTMLElement, moves: Map<string, number>): void {
  const imp = app.vm.impact;
  const off = new Set<string>();
  if (ctx.scenario) {
    for (const [href, node] of moves) {
      const a = imp.alt.get(ctx.idOf(node));
      if (a && !a.allowed) off.add(href);
    }
  }
  for (const el of root.querySelectorAll<HTMLAnchorElement>("a.dm-glance-row, a.dm-row")) {
    const href = el.getAttribute("href") ?? "";
    const isOff = off.has(href);
    el.classList.toggle("is-off", isOff);
    if (isOff) el.setAttribute("data-off", "方針の外");
    else el.removeAttribute("data-off");
  }
}

/**
 * 概要の先頭の「3 年の見取り図」。3 か月ごとの地図が無ければ隠し、update は false を返す。
 * 計算（年収・選んだ手・地図の版）が変わったときだけ作り直す（題名の 1 文字などでは作り直さない。概要を作り直しても、
 * 計算が同じなら前に描いた中身をそのまま入れる）
 */
export function buildDeepOverview(app: AppContext): { el: HTMLElement; update(): boolean } {
  const el = h("section", { class: "deep-ov dm-host", attrs: { "aria-label": "3 年の見取り図" } });
  el.hidden = true;
  let shown: { ctx: DeepCtx; notes: string } | null = null;
  let hrefs: HrefMap = new Map();
  let ctxNow: DeepCtx | null = null;
  interceptLinks(el, (href) => (ctxNow ? follow(app, ctxNow, hrefs, href, "overview") : false));
  return {
    el,
    update() {
      const ctx = app.vm.deep.get();
      ctxNow = ctx;
      el.hidden = !ctx;
      if (!ctx) {
        shown = null;
        clear(el);
        return false;
      }
      const notesKey = `${ctx.edited}|${ctx.scenario ?? ""}`;
      if (shown && shown.ctx === ctx && shown.notes === notesKey) return true;
      shown = { ctx, notes: notesKey };
      const a = ctx.analysis();
      const ov = ctx.overview();
      const head = ctxNotes(app, ctx);
      const kept = overviewCache.get(app);
      if (kept && kept.a === a && kept.ov === ov) {
        hrefs = kept.hrefs;
        clear(el);
        el.append(...(head ? [head] : []), ...kept.nodes);
        dimOffScenario(app, ctx, el, kept.moves);
        return true;
      }
      hrefs = new Map();
      const t0 = performance.now();
      const vm = overviewVM(a, ov, { name: (f) => ctx.text().title(f) });
      rememberOverview(vm, hrefs);
      const notes = notesVM(a, ov.basis.delta, ov.basis.worth, { worthNoise: ov.worthNoise });
      const fresh: Node[] = [renderOverview(vm, overviewMemo(app)), h("details", { class: "deep-notes" }, h("summary", null, "見取り図の見方"), notesSection(notes))];
      // 前に描いた見取り図がこの入れ物に入ったまま（取っておいた概要）: 違う所だけ入れ替える。これにした後に概要へ戻ると、変わるのは
      // その手の行（ひと目とカードで 2〜4 行）だけ。全部を置き直すと、10 行の配置と文字の組み直しで机でも 30 ms を超えていた（P4・Esc の行）
      const prev = kept && kept.nodes.length === fresh.length && kept.nodes.every((n) => n.parentNode === el) ? kept.nodes : null;
      let nodes: Node[];
      if (prev) {
        nodes = prev.map((n, i) => morphNode(n, fresh[i]!));
        for (const c of [...el.childNodes]) if (!nodes.includes(c)) c.remove();
        if (head) el.prepend(head);
      } else {
        clear(el);
        nodes = fresh;
        el.append(...(head ? [head] : []), ...nodes);
      }
      const moves = new Map<string, number>();
      for (const r of vm.rows) moves.set(r.href, r.node);
      overviewCache.set(app, { a, ov, nodes, hrefs, moves });
      dimOffScenario(app, ctx, el, moves);
      app.vm.deep.timings.overviewView = performance.now() - t0;
      return true;
    },
  };
}

// ------------------------------------------------------------ 手の詳しい画面・道の画面（パネルの中のページ）

/** 行き先の種類ごとの、次に見せる番号（今日の手ごと。画面を作り直しても続きから） */
const destCursors = new WeakMap<DeepCtx["map"], Map<number, Map<string, number>>>();

function destCursorOf(ctx: DeepCtx, f: number): Map<string, number> {
  let m = destCursors.get(ctx.map);
  if (!m) destCursors.set(ctx.map, (m = new Map()));
  let c = m.get(f);
  if (!c) m.set(f, (c = new Map()));
  return c;
}

/** パネルの中身の入れ物（スクロールする所） */
const scroller = (el: HTMLElement): HTMLElement | null => el.closest<HTMLElement>(".insp-body-scroll");

/** 道の画面の行の見出し */
const rowHead = (el: HTMLElement, key: string): HTMLElement | null => el.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"] > .dm-tl-head`);

/**
 * 道のカードを地図で開く（今日からそのカードまでの判断と手を開く。入口からの親をたどるだけ: O(深さ)）。
 * 開いたカードと道の終わりが見える所へ寄る
 */
function openPathOnCanvas(app: AppContext, ctx: DeepCtx, vm: PathVM): void {
  const ids: ID[] = [];
  const add = (i: number) => {
    if (i >= 0) ids.push(ctx.idOf(i));
  };
  add(0);
  for (const st of vm.steps) {
    add(st.decision);
    add(st.option);
  }
  const end = vm.end.node;
  // 道の終わりまで開く（親の並び。まとめた手の後の行き先も、まとめた手を開けば見える）
  for (const id of app.vm.impactChain(ctx.idOf(end))) ids.push(id);
  const open = [...new Set(ids)];
  app.vm.setImpactOpen(open);
  if (app.ui.prefs.view !== "map") app.ui.setPrefs({ view: "map" });
  app.ui.holdDeep(() => app.ui.select([ctx.idOf(end)]));
  app.vm.ensure();
  app.view.fit([...open, ctx.idOf(end)].filter((id) => !app.vm.node(id).hidden));
}

export interface DeepPageHandle {
  el: HTMLElement;
  /** 計算が変わったら作り直す（開いている行と位置はそのまま） */
  update(): void;
  /** 作った後に（パネルに入れた後で）、道を切り替えた行を同じ位置に・見出しにフォーカス */
  settle(): void;
}

/** パネルの中のページ（手の詳しい画面・道の画面）。地図が無くなっていれば null */
export function buildDeepPage(app: AppContext, page: DeepPage): DeepPageHandle | null {
  const first = app.vm.deep.get();
  if (!first) return null;
  const ui = app.ui;
  const backBtn = h("button", { class: "btn btn-sm btn-ghost deep-back", type: "button", dataset: { fk: "deep-back" }, onClick: () => ui.backDeep() }, icon("arrowLeft", 14), "戻る");
  const closeBtn = h("button", { class: "icon-btn deep-close", type: "button", title: "閉じる（選んだカードの詳細か概要へ）", ariaLabel: "閉じる", dataset: { fk: "deep-close" }, onClick: () => ui.closeDeep() }, icon("x", 15));
  const bar = h("div", { class: "deep-bar" }, backBtn, h("span", { class: "deep-bar-title" }, page.kind === "move" ? "今日の手の見取り図" : "道を読む"), closeBtn);
  const body = h("div", { class: "deep-page-body dm-host" });
  const el = h("div", { class: `deep-page is-${page.kind}` }, bar, body);
  let hrefs: HrefMap = new Map();
  let ctx: DeepCtx = first;
  let pathHandle: ReturnType<typeof renderPathPage> | null = null;
  let destroy: (() => void) | null = null;
  interceptLinks(body, (href) => follow(app, ctx, hrefs, href, page.kind));

  const render = (keep: { open: string[]; scroll: number } | null) => {
    destroy?.();
    destroy = null;
    pathHandle = null;
    hrefs = new Map();
    clear(body);
    const a = ctx.analysis();
    const notes = ctxNotes(app, ctx);
    if (notes) body.append(notes);
    if (page.kind === "move") {
      // 手と結果の名前は見取り図と同じ元（文書のカードの題名）から（押した行の名前と見出しを同じに: 見直し R3）
      const vm = moveDetailVM(a, page.f, ctx.overview(), { name: (f) => ctx.text().title(f) });
      rememberMove(vm, hrefs);
      const handle = renderMoveDetail(vm, { destCursor: destCursorOf(ctx, page.f), onDest: (row, k) => ui.openDeep({ kind: "path", node: row.ends[k]! }, { push: true }) });
      destroy = handle.destroy;
      body.append(handle.el);
    } else {
      const vm = pathVM(a, page.node, ctx.text());
      rememberPath(ctx, vm, hrefs);
      const open = keep ? new Set(keep.open) : page.open ? new Set(page.open) : undefined;
      pathHandle = renderPathPage(vm, {
        open,
        onSwitch: (key, top, href) => {
          const node = nodeOfHref(ctx, hrefs, href);
          if (node < 0) return false;
          ui.openDeep({ kind: "path", node, open: key ? [key] : [], align: key ? { key, top } : undefined });
          return true;
        },
      });
      destroy = pathHandle.destroy;
      // 地図で開く（広い画面だけ。狭い画面では横 8,000 px の列になるので、道の画面で読む: 作業メモ user-7）
      const tools = h(
        "div",
        { class: "deep-tools" },
        isNarrowScreen() ? null : h("button", { class: "btn btn-sm", type: "button", dataset: { fk: "deep-open-map" }, title: "今日からこの道の終わりまでの判断と手を地図で開く", onClick: () => openPathOnCanvas(app, ctx, vm) }, icon("split", 14), "地図でこの道をひらく"),
      );
      body.append(pathHandle.el, tools);
    }
    if (keep) {
      const sc = scroller(el);
      if (sc) sc.scrollTop = keep.scroll;
    }
  };
  render(null);

  /** 道の画面を描いたときの文書の中身の版（道の行の名前は文書のカードの題名。書き換えたら描き直す: 見直し equiv-4） */
  let contentV = app.vm.index.version.content;
  let redraw = 0;
  const rerender = () => {
    const sc = scroller(el);
    render({ open: pathHandle ? pathHandle.openKeys() : [], scroll: sc?.scrollTop ?? 0 });
  };
  return {
    el,
    update() {
      const now = app.vm.deep.get();
      if (!now) return;
      const cv = app.vm.index.version.content;
      if (now === ctx) {
        // 計算は同じで題名だけが変わった: 道の画面は次の画面で 1 回だけ描き直す（続けて打っても 1 回）
        if (page.kind === "path" && cv !== contentV && !redraw) {
          redraw = requestAnimationFrame(() => {
            redraw = 0;
            if (!el.isConnected || app.vm.deep.get() !== ctx) return;
            contentV = app.vm.index.version.content;
            rerender();
          });
        }
        return;
      }
      ctx = now;
      contentV = cv;
      rerender();
    },
    settle() {
      if (page.kind !== "path") {
        el.querySelector<HTMLElement>(".dm-h2")?.focus({ preventScroll: true });
        return;
      }
      const al = page.align;
      const sc = scroller(el);
      if (al && sc) {
        const head = rowHead(el, al.key);
        if (head) {
          sc.scrollTop += head.getBoundingClientRect().top - al.top;
          head.focus({ preventScroll: true });
          return;
        }
      }
      if (sc) sc.scrollTop = 0;
      el.querySelector<HTMLElement>(".dm-h2")?.focus({ preventScroll: true });
    },
  };
}

// ------------------------------------------------------------ カードの詳細（3 か月ごとの地図のカード）

/**
 * 開いた後の枚数の作り直しの鍵: 見えているカードの数と、開いている所の数（題名の 1 文字・選ぶだけでは変わらない）。
 * 地図・年収も含める
 */
export function openKey(app: AppContext, ctx: DeepCtx): string {
  app.vm.ensure();
  let open = 0;
  for (const r in app.ui.prefs.impactOpen) open += app.ui.prefs.impactOpen[r]!.length + 1;
  return `${ctx.map.header.hash}|${ctx.annual}|${app.vm.drawNodes.length}|${open}`;
}

/**
 * 時間で区切って開く（「1 年先まで（331 枚）」。「全部ひらく」の代わり: 作業メモ SPEC v1 §5.8・user-12）。
 * 開いた後のキャンバス全体（見えているほかのカード + このカードの先）が上限を超える区切りは「見取り図で見る」
 */
export function deepOpenActions(app: AppContext, ctx: DeepCtx, i: number): HTMLElement | null {
  return openActions(app, ctx, i, ctx.idOf(i));
}

/** 見取り図で見る（そのカードの今日の手の詳しい画面。今日なら見取り図） */
export function mapLinkOf(app: AppContext, ctx: DeepCtx, i: number): () => void {
  const f = ctx.cm.first[i] ?? -1;
  return () => (f >= 0 ? app.ui.openDeep({ kind: "move", f }) : showDeepOverview(app));
}

/** 複数選択の詳細の頭に置く「選んだ M 枚の先をひらく」（まとめて開く C） */
export function buildDeepMultiOpen(app: AppContext): { el: HTMLElement; update(): void } {
  return buildMultiOpen(app, (ctx, i) => mapLinkOf(app, ctx, i));
}

/**
 * 「この先をひらく」の欄（カードの詳細と概要の今日）。まとめて開く（作業メモ bulk/design.md）:
 *   今日      手ごとに開く・この時期まで全部ひらく（D）・見込みの高い道だけ（B）・ほかのカードも選ぶ
 *   カード    どこまで開くか（A）・見込みの高い道だけ（B）・この先をまとめてたたむ・ほかのカードも選ぶ
 * どのボタンも押す前に開いた後の枚数を出す。キャンバス全体で 3,000 枚を超えるものは開かず「見取り図で見る」
 */
function openActions(app: AppContext, ctx: DeepCtx, i: number, id: ID): HTMLElement | null {
  const t0 = performance.now();
  const el = buildOpenActions(app, ctx, i, id);
  app.vm.deep.timings.openActions = performance.now() - t0;
  return el;
}

function buildOpenActions(app: AppContext, ctx: DeepCtx, i: number, id: ID): HTMLElement | null {
  const hs = deepHorizons(ctx.cm, i);
  if (!hs.length) return null;
  const mapLink = mapLinkOf(app, ctx, i);
  /** 見えているカードの数と、このカードの先の物の数（どの行も同じ物を使う: 1 回だけなめる） */
  const split = drawnSplit(app, ctx, [i]);
  const label = (x: DeepHorizon) => (x.toEnd ? `${ym(ctx.map, ctx.cm.H)}まで` : `${x.months / 12} 年先まで`);
  const parts: Array<HTMLElement | null> = [];
  if (i > 0 && !isDrawn(app, ctx, i)) {
    // 閉じた上のカードの中に隠れているカード: 開いてもキャンバスには何も出ないので、出す道だけ（見直し data-hidden-head-false-toast）
    parts.push(...hiddenRows(app, ctx, [i], `bulk-show:${id}`));
  } else if (i === 0) {
    // 今日（地図の入口）: 手ごとに開く方を先に（今日の「1 年先まで」は 10 の手の全部で縦に長い: 見直し user-8）
    const perMove: HTMLElement[] = [];
    const kids = ctx.cm.kids;
    for (let s = ctx.cm.kidOff[0]!; s < ctx.cm.kidOff[1]!; s++) {
      const f = kids[s]!;
      // 手ごとに開くも、その手の先をちょうどその区切りまでの形にする（数 = 開いた後の数: moveFit）
      const fit = moveFit(app, ctx, f);
      if (!fit) continue;
      // 手の名前は見取り図の行と同じ（文書のカードの題名: 見直し R3）
      const name = ctx.text().title(f).trim() || "（無題）";
      const fx = fit.x;
      perMove.push(openButton(app, ctx, f, fit, label(fx), `「${name}」の先を${label(fx)}の形に開く（前に開いていた、それより先は閉じる）`, `${name}（${label(fx)} ${num(fit.count)} 枚）`));
    }
    if (perMove.length) parts.push(h("p", { class: "deep-open-note" }, "手ごとに開く（今日の手の先を、その手のカードから）"), h("div", { class: "deep-open-row deep-open-moves" }, ...perMove));
    // 今日から時期まで（D）と見込みの高い道（B）は 8 万枚をなめて数える。まだ数えていなければ（起動の直後）、空いた時間に数えてから出す
    // （起動して触れるまでを待たせない。数えた物は覚えるので、その後の作り直しではすぐ出す）
    const later = (sp = drawnSplit(app, ctx, [0])): HTMLElement[] => [...(quarterRows(app, ctx, mapLink, sp) ?? []), ...(likelyRows(app, ctx, 0, mapLink, sp) ?? [])];
    if (quarterOpensReady(ctx.cm) && likelyReady(ctx.analysis(), 0)) parts.push(...later(split));
    else {
      const slot = h("div", { class: "deep-open-later", attrs: { "aria-busy": "true" } }, h("p", { class: "deep-open-note" }, "この時期まで全部ひらく・見込みの高い道を数えています…"));
      parts.push(slot);
      whenIdle(() => {
        if (!slot.isConnected || app.vm.deep.get() !== ctx) return;
        quarterOpens(ctx.cm);
        likelyPaths(ctx.analysis(), 0, 5);
        whenIdle(() => {
          if (slot.isConnected && app.vm.deep.get() === ctx) slot.replaceWith(...later());
        });
      });
    }
  } else {
    parts.push(...(depthRows(app, ctx, i, mapLink, split) ?? []));
    parts.push(...(likelyRows(app, ctx, i, mapLink, split) ?? []));
  }
  const tools = h("div", { class: "deep-open-row deep-open-tools" });
  if (i > 0 && isDrawn(app, ctx, i)) {
    const fold = foldBtn(app, ctx, i, split);
    if (fold) tools.append(fold);
  }
  tools.append(pickToggle(app, `bulk-pick:${id}`));
  parts.push(tools);
  return h("div", { class: "deep-open-sec" }, h("h3", { class: "insp-label" }, "この先をひらく", h("span", { class: "insp-count" }, `キャンバスは全体で ${num(DEEP_OPEN_CAP)} 枚まで`)), ...parts);
}

/**
 * 手ごとに開くボタン（今日の手 k の先を、ちょうど区切り x までの形に: moveFit・moveRun）。開いた後は、狭い画面なら引き出しを閉じ、開いたカードの所へ
 * キャンバスを寄せ（見直し user-8）、何を開いたかと「元に戻す」「見取り図で見る」をお知らせに出す
 */
function openButton(app: AppContext, ctx: DeepCtx, k: number, fit: MoveFit, what: string, title: string, text: string): HTMLElement {
  const kid = ctx.idOf(k);
  const x = fit.x;
  return h(
    "button",
    {
      class: "btn btn-sm deep-open",
      type: "button",
      dataset: { fk: `open:${x.months}:${kid}` },
      title,
      onClick: () => void runBulk(app, ctx, moveRun(app, ctx, k, fit, what, mapLinkOf(app, ctx, k))),
    },
    icon("expand", 14),
    text,
  );
}

/**
 * 3 か月ごとの地図のカードの詳細に足す物（この先の道・時間で区切って開く）。地図のカードでなければ null。
 * 計算が変わったときと、キャンバスで開閉した（見え方が変わった）ときに作り直す
 */
export function buildDeepNodeBlock(app: AppContext, id: ID): { el: HTMLElement; update(): void } | null {
  const ctx0 = app.vm.deep.get();
  if (!ctx0 || ctx0.indexOf(id) < 0) return null;
  const el = h("section", { class: "deep-node" });
  let key = "";
  /** 詰めたときの地図の画面に渡す物（作り直されたら詰め直す: 選んだ手・方針・書き換えで計算が変わると、開くボタンと
   * 「この先の行き先」の 1 文が前の物のまま・「数えています…」のまま残った。見直し data-3） */
  let shown: DeepCtx | null = null;
  return {
    el,
    update() {
      const ctx = app.vm.deep.get();
      const i = ctx ? ctx.indexOf(id) : -1;
      el.hidden = !ctx || i < 0;
      if (!ctx || i < 0) return;
      // 資産のゴールの前提（入口の meta.goal）が変わったら「この先の行き先」の 1 文も作り直す
      const k = `${openKey(app, ctx)}|${i}|${JSON.stringify(app.store.doc.nodes[ctx.root]?.meta?.goal ?? null)}`;
      if (k === key && ctx === shown) return;
      key = k;
      shown = ctx;
      keepFocus(el, () => fillNodeBlock(ctx, i));
    },
  };

  function fillNodeBlock(ctx: DeepCtx, i: number): void {
    const t0 = performance.now();
    clear(el);
    const a = ctx.analysis();
    const btns = h("div", { class: "deep-node-btns" });
    if (i === 0) {
      // 今日: 一番ありそうな道（見込み X%）
      const vm = overviewVM(a, ctx.overview());
      if (vm.chain) btns.append(h("button", { class: "btn btn-sm btn-primary", type: "button", dataset: { fk: `deep-chain:${id}` }, onClick: () => app.ui.openDeep({ kind: "path", node: vm.chain!.node }) }, icon("split", 14), vm.chain.text));
      btns.append(
        h(
          "button",
          {
            class: "btn btn-sm",
            type: "button",
            dataset: { fk: `deep-overview:${id}` },
            onClick: () => showDeepOverview(app),
          },
          icon("layers", 14),
          "3 年の見取り図",
        ),
      );
    } else {
      btns.append(
        h("button", { class: "btn btn-sm btn-primary", type: "button", dataset: { fk: `deep-path:${id}` }, title: "今日からこのカードを通って 2029 年 11 月まで、3 か月に 1 行で読む", onClick: () => app.ui.openDeep({ kind: "path", node: i }) }, icon("split", 14), `この先の道を読む（${ym(ctx.map, ctx.cm.H)}まで）`),
      );
      const f = ctx.cm.first[i] ?? -1;
      if (f >= 0) btns.append(h("button", { class: "btn btn-sm", type: "button", dataset: { fk: `deep-move:${id}` }, onClick: () => app.ui.openDeep({ kind: "move", f }) }, icon("layers", 14), "この手の見取り図"));
    }
    el.append(btns);
    if (i > 0 && ctx.cm.kidOff[i] !== ctx.cm.kidOff[i + 1]) el.append(goalFromEl(app, ctx, i, () => key));
    const opens = openActions(app, ctx, i, id);
    if (opens) el.append(opens);
    app.vm.deep.timings.nodeBlock = performance.now() - t0;
  }
}

/**
 * 途中のカードの「この先の行き先: 2056 年の資産は多くが 0.40〜0.52 億円（真ん中の 8 割・目安）・芽のある行き先 9%」（作業メモ goal/design.md §4.6）。
 * そのカードの先の行き先をなめる（O(部分木)）ので、選んだフレームでは場所だけ置き、空いた時間に埋める。手のカードは詳細の欄に
 * 「10 億」の 1 行が無いので、前提を変える入口も並べる（結果・状態のカードは詳細の欄の 1 行にある）
 */
function goalFromEl(app: AppContext, ctx: DeepCtx, i: number, key: () => string): HTMLElement {
  const text = h("span", { class: "deep-goal-t" }, "この先の行き先の資産を数えています…");
  const el = h("p", { class: "deep-goal", dataset: { fk: `deep-goal:${i}` } }, h("b", { class: "deep-goal-k" }, "ゴール"), " ", text);
  const k0 = key();
  const run = (dl: IdleDeadlineLike | null): void => {
    if (!el.isConnected || key() !== k0 || app.vm.deep.get() !== ctx) return;
    // 空いた時間が短ければ次の空いた時間へ（8 万枚の地図の今日の手の先は数千枚: スマホで数十 ms。選んだ直後の描画・次の操作を待たせない）
    if (dl && !dl.didTimeout && dl.timeRemaining() < 12) {
      whenIdle(run, 2000);
      return;
    }
    const root = app.store.doc.nodes[ctx.root];
    const t = tablesFor(goalConfigOf(root).cfg, goalAnchor(ctx.map.header.anchor));
    const a = ctx.analysis();
    let memo = goalFromMemo.get(a);
    if (!memo) goalFromMemo.set(a, (memo = new Map()));
    const mk = `${i}|${t.key}`;
    let line = memo.get(mk);
    if (line === undefined) {
      line = goalFromLine(t, goalFrom(a, i, endsFrom(a, i), t));
      if (memo.size > 64) memo.clear();
      memo.set(mk, line);
    }
    if (!line) {
      el.remove();
      return;
    }
    text.textContent = line;
    if (app.vm.impact.alt.has(ctx.idOf(i))) el.append(" ", h("button", { class: "imp-link goal-change", type: "button", dataset: { goalAct: "edit" }, title: "資産のゴールの前提を変える" }, "前提を変える"));
  };
  // 選んだフレームと、その直後の操作（続けて選ぶ・開く）の後に回す
  setTimeout(() => whenIdle(run, 2000), 400);
  return el;
}

/** 途中のカードの「この先の行き先」の 1 文（計算ごと・カードと前提ごとに覚える） */
const goalFromMemo = new WeakMap<Analysis, Map<string, string | null>>();

// ------------------------------------------------------------ 組み立てた本文（読むだけ）と自分のメモ（作業メモ SPEC §4.4・safety-10）

/** カードごとの、自分のメモに写した地図の文章（写したときの物。このタブの間だけ覚える。年収を変えた後も、写した物を見分ける） */
const copiedBlocks = new Map<ID, string>();

/**
 * 自分のメモの頭にある、写した地図の文章（覚えている写しか、今の年収で組み立てた文章。どちらでもなければ null）。
 * 写した後に書き換えた所があれば、もう写しではない（自分の文章として残す）
 */
export function copiedPrefix(note: string, id: ID, composed: string): string | null {
  for (const b of [copiedBlocks.get(id), composed]) if (b && note.startsWith(b)) return b;
  return null;
}

/** 写した文章を外した残り（写しと自分のメモの間の空行も外す） */
export function withoutCopy(note: string, prefix: string): string {
  return note.slice(prefix.length).replace(/^\s*\n/, "").replace(/^\n+/, "");
}

/**
 * 3 か月ごとの地図のカードの、組み立てた本文（今の年収で。読むだけ）。地図のカードでなければ null。
 * 「この文章をもとに書き換える」は本文を自分のメモの頭に写す（メモが空でなければ、その前に足す）。
 * 「元の文章に戻す」は、メモの頭に写した文章が書き換えずに残っているときだけ出し、その写しだけを外す（自分で書いた所は残す。
 * 元に戻せるお知らせを出す: 見直し user-3）。写した後は、上の読むだけの文章を最初の数行にたたむ（同じ文章を 2 度並べない）。
 * 年収が変わったら組み立て直す（カードを開いたときに 1 枚だけ組み立てる）
 */
export function buildComposedBody(app: AppContext, id: ID, focusNote: () => void): { el: HTMLElement; update(): void } | null {
  const ctx0 = app.vm.deep.get();
  if (!ctx0 || ctx0.indexOf(id) < 0) return null;
  const nums = h("ul", { class: "dm-numbers deep-nums" });
  const text = h("p", { class: "deep-body-text" });
  const unfold = h("button", { class: "imp-link deep-body-unfold", type: "button", dataset: { fk: `body-unfold:${id}` } }, "元の文章を見る");
  const copy = h("button", { class: "btn btn-sm", type: "button", dataset: { fk: `body-copy:${id}` }, title: "この文章を下の自分のメモの頭に写して書き換える（地図の文章はそのまま）" }, icon("tag", 14), "この文章をもとに書き換える");
  const reset = h("button", { class: "btn btn-sm btn-ghost", type: "button", dataset: { fk: `body-reset:${id}` }, title: "自分のメモの頭に写した地図の文章だけを外す（自分で書いた所は残す）" }, icon("undo", 14), "元の文章に戻す");
  const note = h("p", { class: "deep-body-note" });
  // 書き換えた見込みで組み立てた本文の注記（見込みは書き換えた数・お金の数は地図の元の見込みのまま: 見直し reader-2）
  const oddsNote = h("p", { class: "deep-body-note deep-odds-note", attrs: { role: "note" } }, "この文章の見込み（割・分）は書き換えた見込みで数えている。お金の数（3 年の稼ぎ・差・値打ち）と手の札は、地図の元の見込みで数えたまま");
  oddsNote.hidden = true;
  const el = h("section", { class: "insp-section deep-body" }, h("h3", { class: "insp-label" }, "地図の文章", h("span", { class: "insp-count" }, "読むだけ")), nums, text, oddsNote, unfold, h("div", { class: "btn-row" }, copy, reset), note);
  let shownKey = "";
  /** 本文を組み立てたときの題の版（本文は手を文書のカードの題で呼ぶ: reader-1。どこかの題が変わったら組み立て直す） */
  let shownTitles = -1;
  let titleWait = false;
  let composed = "";
  /** 写した後でも、読むだけの文章を全部見せる（押して開いた） */
  let unfolded = false;
  /** 本文と数の行を組み立てて出す */
  const compose = (ctx: DeepCtx, i: number): void => {
    const t0 = performance.now();
    shownTitles = app.vm.titleStamp;
    const t = ctx.text();
    const own = ctx.edited ? cardWithDocOdds(ctx, app.store.doc, app.vm.index.out, i) : null;
    const row = own ? own.numbers : t.numbers(i);
    const bodyText = own ? own.body : t.body(i);
    clear(nums);
    for (const x of row) nums.append(h("li", null, x));
    nums.hidden = !row.length;
    composed = [row.join("・"), bodyText].filter((x) => x.length > 0).join("\n");
    text.textContent = bodyText || "（このカードには組み立てた本文が無い）";
    oddsNote.hidden = !own;
    app.vm.deep.timings.composed = performance.now() - t0;
  };
  /** 題が変わった後の組み立て直し（今すぐ。写すときに古い名前の文章を写さない） */
  const titlesNow = (): void => {
    if (shownTitles === app.vm.titleStamp) return;
    const ctx = app.vm.deep.get();
    const i = ctx ? ctx.indexOf(id) : -1;
    if (ctx && i >= 0) compose(ctx, i);
  };
  copy.addEventListener("click", () => {
    titlesNow();
    const n = app.store.doc.nodes[id];
    if (!n || app.store.readOnly || !composed) return;
    const next = n.body.trim() ? `${composed}\n\n${n.body}` : composed;
    copiedBlocks.set(id, composed);
    unfolded = false;
    app.cmd.updateNode(id, { body: next }, { label: "地図の文章をもとに書き換える" });
    requestAnimationFrame(focusNote);
  });
  reset.addEventListener("click", () => {
    const n = app.store.doc.nodes[id];
    if (!n || app.store.readOnly) return;
    const prefix = copiedPrefix(n.body, id, composed);
    if (!prefix) return;
    const rest = withoutCopy(n.body, prefix);
    app.cmd.updateNode(id, { body: rest }, { label: "写した地図の文章を外す" });
    copiedBlocks.delete(id);
    toast(rest ? "写した地図の文章を外した（自分で書いた所は残した）" : "写した地図の文章を外した", { tone: "ok", action: app.cmd.undoAction() });
  });
  unfold.addEventListener("click", () => {
    unfolded = !unfolded;
    text.classList.toggle("is-folded", !unfolded);
    unfold.textContent = unfolded ? "たたむ" : "元の文章を見る";
  });
  return {
    el,
    update() {
      const ctx = app.vm.deep.get();
      const i = ctx ? ctx.indexOf(id) : -1;
      el.hidden = !ctx || i < 0;
      const n = app.store.doc.nodes[id];
      if (!ctx || i < 0 || !n) return;
      // 形か数を書き換えた文書では、書き換えた見込みも鍵に（本文の見込みを「つながり」と同じにする: 見直し R6）
      const ver = app.vm.engine.version;
      const k = `${ctx.map.header.hash}|${ctx.annual}|${i}|${ctx.edited ? `${ver.topology}.${ver.numbers}` : ""}`;
      if (k !== shownKey) {
        shownKey = k;
        compose(ctx, i);
      } else if (shownTitles !== app.vm.titleStamp && !titleWait) {
        // どこかのカードの題が変わった（題を打っている途中など）: 本文の手の名前を、手が空いたときに組み立て直す（1 文字ごとに組み立てない）
        titleWait = true;
        whenIdle(() => {
          titleWait = false;
          if (!el.isConnected) {
            shownKey = "";
            return;
          }
          titlesNow();
        }, 1000);
      }
      const ro = app.store.readOnly;
      const copied = copiedPrefix(n.body, id, composed) !== null;
      copy.disabled = ro;
      reset.disabled = ro;
      // 写しが書き換えずに頭にあるときだけ（自分で書いたメモだけのときは出さない）
      reset.hidden = !copied;
      // 写した後は、読むだけの文章を最初の数行に（メモに同じ文章がある）
      text.classList.toggle("is-folded", copied && !unfolded);
      unfold.hidden = !copied;
      unfold.textContent = unfolded ? "たたむ" : "元の文章を見る";
      note.textContent = copied
        ? "自分のメモの頭に、この文章を写してある。「元の文章に戻す」で写した所だけを外す（自分で書いた所は残る）"
        : n.body
          ? "下の自分のメモは、地図の文章とは別に残る（年収を変えても書き換わらない）"
          : "書き足したいことは下の自分のメモへ（地図の文章は年収に合わせて組み立て直す）";
    },
  };
}
