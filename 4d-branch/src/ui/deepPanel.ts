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
import type { DeepCtx } from "../app/deepState";
import type { DeepPage } from "../app/uiState";
import type { Analysis, Overview } from "../deepmap/core";
import { findFirstMove, findPathToken, kindSlug, moveDetailVM, notesSection, notesVM, overviewVM, parseRoute, pathVM, renderMoveDetail, renderOverview, renderPathPage, ym, type MoveDetailVM, type OverviewVM, type PathVM } from "../deepmap/views";
import { DEEP_OPEN_CAP, deepHorizons, horizonOpen, type DeepHorizon } from "../model/deepOpen";
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
 * 計算（Analysis と Overview）が同じなら同じ中身（シナリオ・編集の有無で変わるのは上の注記だけ）
 */
const overviewCache = new WeakMap<AppContext, { a: Analysis; ov: Overview; nodes: Node[]; hrefs: HrefMap }>();

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
        return true;
      }
      hrefs = new Map();
      const t0 = performance.now();
      const vm = overviewVM(a, ov);
      rememberOverview(vm, hrefs);
      clear(el);
      const notes = notesVM(a, ov.basis.delta, ov.basis.worth, { worthNoise: ov.worthNoise });
      const nodes = [renderOverview(vm), h("details", { class: "deep-notes" }, h("summary", null, "見取り図の見方"), notesSection(notes))];
      el.append(...(head ? [head] : []), ...nodes);
      overviewCache.set(app, { a, ov, nodes, hrefs });
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
      const vm = moveDetailVM(a, page.f, ctx.overview());
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

  return {
    el,
    update() {
      const now = app.vm.deep.get();
      if (!now) return;
      if (now === ctx) return;
      ctx = now;
      const sc = scroller(el);
      render({ open: pathHandle ? pathHandle.openKeys() : [], scroll: sc?.scrollTop ?? 0 });
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

function openActions(app: AppContext, ctx: DeepCtx, i: number, id: ID): HTMLElement | null {
  const hs = deepHorizons(ctx.cm, i);
  if (!hs.length) return null;
  // 今見えているカードのうち、このカードの先の物（開いた後の全体 = それ以外 + 開いた後のこのカードの先）
  const end = i + ctx.cm.size[i]!;
  app.vm.ensure();
  let inside = 0;
  for (const nid of app.vm.drawNodes) {
    const j = ctx.indexOf(nid);
    if (j > i && j < end) inside++;
  }
  const outside = app.vm.drawNodes.length - inside;
  const row = h("div", { class: "deep-open-row" });
  const label = (x: DeepHorizon) => (x.toEnd ? `${ym(ctx.map, ctx.cm.H)}まで` : `${x.months / 12} 年先まで`);
  let over: DeepHorizon | null = null;
  for (const x of hs) {
    const total = outside + x.count;
    if (total > DEEP_OPEN_CAP) {
      over ??= x;
      continue;
    }
    row.append(
      h(
        "button",
        {
          class: "btn btn-sm deep-open",
          type: "button",
          dataset: { fk: `open:${x.months}:${id}` },
          title: `この先の${label(x)}の判断と手を開く（開いた後のキャンバス ${num(total)} 枚）`,
          onClick: () => {
            const ids = horizonOpen(ctx.cm, i, x).map((j) => ctx.idOf(j));
            app.vm.setImpactOpen(ids, [], { reveal: true });
            if (app.ui.prefs.view !== "map") app.ui.setPrefs({ view: "map" });
          },
        },
        icon("expand", 14),
        `${label(x)}（${num(x.count)} 枚）`,
      ),
    );
  }
  if (over) {
    // 上限を超える: 見取り図（この手の詳しい画面・今日なら見取り図）で見る
    const f = ctx.cm.first[i] ?? -1;
    row.append(
      h(
        "button",
        {
          class: "btn btn-sm deep-open is-map",
          type: "button",
          dataset: { fk: `open-map:${id}` },
          title: `${label(over)}は ${num(over.count)} 枚（キャンバスに出せるのは全体で ${num(DEEP_OPEN_CAP)} 枚まで）`,
          onClick: () => {
            if (f >= 0) app.ui.openDeep({ kind: "move", f });
            else {
              app.ui.closeDeep();
              app.ui.holdDeep(() => app.ui.clearSelection());
              if (!app.ui.prefs.rightOpen) app.ui.setPrefs({ rightOpen: true });
            }
          },
        },
        icon("layers", 14),
        `見取り図で見る（${label(over)} ${num(over.count)} 枚）`,
      ),
    );
  }
  return h("div", { class: "deep-open-sec" }, h("h3", { class: "insp-label" }, "この先をひらく", h("span", { class: "insp-count" }, `キャンバスは全体で ${num(DEEP_OPEN_CAP)} 枚まで`)), row);
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
  return {
    el,
    update() {
      const ctx = app.vm.deep.get();
      const i = ctx ? ctx.indexOf(id) : -1;
      el.hidden = !ctx || i < 0;
      if (!ctx || i < 0) return;
      const k = `${openKey(app, ctx)}|${i}`;
      if (k === key) return;
      key = k;
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
              onClick: () => {
                app.ui.closeDeep();
                app.ui.holdDeep(() => app.ui.clearSelection());
              },
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
      const opens = openActions(app, ctx, i, id);
      if (opens) el.append(opens);
      app.vm.deep.timings.nodeBlock = performance.now() - t0;
    },
  };
}

// ------------------------------------------------------------ 組み立てた本文（読むだけ）と自分のメモ（作業メモ SPEC §4.4・safety-10）

/**
 * 3 か月ごとの地図のカードの、組み立てた本文（今の年収で。読むだけ）。地図のカードでなければ null。
 * 「この文章をもとに書き換える」は本文を自分のメモに写す（メモが空でなければ、その前に足す）。「元の文章に戻す」はメモを空にする。
 * 年収が変わったら組み立て直す（カードを開いたときに 1 枚だけ組み立てる）
 */
export function buildComposedBody(app: AppContext, id: ID, focusNote: () => void): { el: HTMLElement; update(): void } | null {
  const ctx0 = app.vm.deep.get();
  if (!ctx0 || ctx0.indexOf(id) < 0) return null;
  const nums = h("ul", { class: "dm-numbers deep-nums" });
  const text = h("p", { class: "deep-body-text" });
  const copy = h("button", { class: "btn btn-sm", type: "button", dataset: { fk: `body-copy:${id}` }, title: "この文章を下の自分のメモに写して書き換える（地図の文章はそのまま）" }, icon("tag", 14), "この文章をもとに書き換える");
  const reset = h("button", { class: "btn btn-sm btn-ghost", type: "button", dataset: { fk: `body-reset:${id}` }, title: "自分のメモを空にして、地図の文章だけにする" }, icon("undo", 14), "元の文章に戻す");
  const note = h("p", { class: "deep-body-note" });
  const el = h("section", { class: "insp-section deep-body" }, h("h3", { class: "insp-label" }, "地図の文章", h("span", { class: "insp-count" }, "読むだけ")), nums, text, h("div", { class: "btn-row" }, copy, reset), note);
  let shownKey = "";
  let composed = "";
  copy.addEventListener("click", () => {
    const n = app.store.doc.nodes[id];
    if (!n || app.store.readOnly || !composed) return;
    const next = n.body.trim() ? `${composed}\n\n${n.body}` : composed;
    app.cmd.updateNode(id, { body: next }, { label: "地図の文章をもとに書き換える" });
    requestAnimationFrame(focusNote);
  });
  reset.addEventListener("click", () => {
    const n = app.store.doc.nodes[id];
    if (!n || app.store.readOnly || !n.body) return;
    app.cmd.updateNode(id, { body: "" }, { label: "元の文章に戻す" });
  });
  return {
    el,
    update() {
      const ctx = app.vm.deep.get();
      const i = ctx ? ctx.indexOf(id) : -1;
      el.hidden = !ctx || i < 0;
      const n = app.store.doc.nodes[id];
      if (!ctx || i < 0 || !n) return;
      const ro = app.store.readOnly;
      copy.disabled = ro;
      reset.disabled = ro;
      reset.hidden = !n.body;
      note.textContent = n.body ? "下の自分のメモは、地図の文章とは別に残る（年収を変えても書き換わらない）" : "書き足したいことは下の自分のメモへ（地図の文章は年収に合わせて組み立て直す）";
      const k = `${ctx.map.header.hash}|${ctx.annual}|${i}`;
      if (k === shownKey) return;
      shownKey = k;
      const t0 = performance.now();
      const t = ctx.text();
      clear(nums);
      const row = t.numbers(i);
      for (const x of row) nums.append(h("li", null, x));
      nums.hidden = !row.length;
      composed = [row.join("・"), t.body(i)].filter((x) => x.length > 0).join("\n");
      text.textContent = t.body(i) || "（このカードには組み立てた本文が無い）";
      app.vm.deep.timings.composed = performance.now() - t0;
    },
  };
}
