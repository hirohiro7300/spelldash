// 右: 選んだノード・接続の詳細（文章・期限・条件・タグ・プロジェクト・シナリオ・つながり）
// 入力中の欄は上書きしない（ストアの変更では値だけ合わせ、選択が変わったときだけ作り直す）

import type { AppContext } from "../app/context";
import { onlyTimeCursor } from "../app/uiState";
import { NODE_TYPES, NODE_TYPE_ORDER, RELATIONS, RELATION_ORDER, STATUSES, STATUS_ORDER } from "../model/constants";
import { MAX_YEAR, MIN_YEAR, formatDate, normalizeDateStr, relativeDue } from "../model/dates";
import type { GEdge, GNode, ID } from "../model/types";
import { isNarrowScreen } from "./breakpoints";
import { MOD, clear, h, isImeKey, isTypingTarget, setValue } from "./dom";
import { icon } from "./icons";
import { buildComposedBody, buildDeepMultiOpen, buildDeepNodeBlock, buildDeepOverview, buildDeepPage, type DeepPageHandle } from "./deepPanel";
import { PREV_BODY_META } from "../persist/legacyMap";
import { buildImpactNodeBlock, buildImpactOverview, focusLost, impactEdgeKind, keyboardFocus } from "./impactPanel";
import { toast } from "./overlays";
import { edgeProb, formatPercent } from "../model/forecast";
import { chanceWeights, flowOuts, isFlowEdge } from "../model/forks";

type Updater = () => void;

export function buildInspector(app: AppContext): HTMLElement {
  const { store, ui } = app;
  const headTitle = h("span", { class: "insp-head-title" }, "詳細");
  const headSub = h("span", { class: "insp-head-sub" });
  // 中身は作り直すが、この入れ物は残る
  const body = h("div", { class: "insp-body-scroll" });
  // 押した部品・入力していた欄が作り直しで消えたときのフォーカスの置き場（tabindex=-1・高さ 0）。
  // 入れ物そのものにすると、パネルの何も無い所を押しただけでフォーカスが移り、キャンバスのキーが黙って効かなくなる
  const park = h("div", { class: "insp-focus-park", tabIndex: -1, ariaLabel: "詳細のパネル" });
  const root = h("aside", { class: "sidebar sidebar-right", ariaLabel: "詳細" }, park, h("div", { class: "insp-head" }, headTitle, headSub), body);
  let key = "";
  let updaters: Updater[] = [];
  /** 見え方だけの変更（3 年の分かれ道の開閉など）で合わせる物。文書の変更でも updaters から合わせる */
  let viewUpdaters: Updater[] = [];
  /** 出しているノードの詳細（ノードを 1 つ選んでいるとき） */
  let panel: NodePanel | null = null;
  /** 取っておいた概要とノードの詳細（別の物を出している間は置かずに持つ） */
  const kept = new Map<"none" | "node", { el: HTMLElement; updaters: Updater[]; viewUpdaters: Updater[]; panel: NodePanel | null }>();

  const selKey = () => {
    // 3 か月ごとの地図の画面（手の詳しい画面・道の画面）は、選んだ物より前に出す
    const pg = ui.deepPage;
    if (pg) return pg.kind === "move" ? `deep:move:${pg.f}` : `deep:path:${pg.node}`;
    const s = ui.selection;
    if (s.nodes.size === 0 && s.edges.size === 0) return "none";
    if (s.nodes.size === 1 && s.edges.size === 0) return `node:${[...s.nodes][0]}`;
    if (s.edges.size === 1 && s.nodes.size === 0) return `edge:${[...s.edges][0]}`;
    return `multi:${[...s.nodes].sort().join(",")}|${[...s.edges].sort().join(",")}`;
  };

  /**
   * 作り直しで消えると困る、パネルの中のフォーカス: 入力欄（マウスで入っても）か、キーボードで操作している部品。無ければ null
   * （マウス・タッチで押しただけのボタンは数えない。作り直した後も今までどおり、そこへは戻さない）
   */
  const heldFocus = (): HTMLElement | null => {
    const a = document.activeElement;
    return a instanceof HTMLElement && body.contains(a) && (isTypingTarget(a) || keyboardFocus(a)) ? a : null;
  };
  /**
   * 作り直しで held（前にフォーカスのあった部品）が無くなり、フォーカスが体に落ちたとき（別の端末で、その欄・線・ノードが消えた など）:
   * パネルのフォーカスの置き場へ移す。体に落とすと、次の Tab・Backspace・文字のキーがキャンバスの操作（分岐を足す・選んだカードを消す・作る）になる。
   * 入力していた欄でも、ほかの欄（題名など）へは移さない（続けて打った文字・Backspace が黙ってその欄を書き換える）
   */
  const settleFocus = (held: HTMLElement | null): void => {
    // ほとんどの変更（打っている欄が残っている）は、ここで済ませる（大きさを測らない）
    if (!held || (held.isConnected && document.activeElement === held) || !focusLost()) return;
    if (!root.isConnected || getComputedStyle(root).visibility === "hidden") return;
    park.focus({ preventScroll: true });
  };

  /** 狭い画面で引き出しを閉じている間に作り直しを頼まれた（開いたときに作る） */
  let pendingForce = false;
  /** 押して選んだ後の作り直しを、次のフレームの頭に待たせている（requestAnimationFrame の番号） */
  let pendingSel = 0;
  /** これより多くのカードが見えているときは、押して選んだ詳細をキャンバスを描いた後に作る */
  const BIG_CANVAS = 1500;
  const render = (force = false) => {
    // どの作り直しも今の選択から作る: 待たせていた分はここで済む
    if (pendingSel) {
      cancelAnimationFrame(pendingSel);
      pendingSel = 0;
    }
    // 狭い画面で引き出しを閉じている（置かれていない）間は作らず、開いたときに作る（カードを押すたびに見えないパネルを作らない: 見直し perf-5）
    if (isNarrowScreen() && !ui.prefs.rightOpen) {
      if (force) pendingForce = true;
      return;
    }
    if (pendingForce) {
      pendingForce = false;
      force = true;
    }
    const k = selKey();
    if (k === key && !force) {
      for (const u of updaters) u();
      return;
    }
    // 変換中（IME）の欄を作り直す・別のカードに替える前に、変換を決めさせて文書に入れる（変換中の文字は打つたびには入れていない）
    const typing = document.activeElement;
    if (typing instanceof HTMLElement && body.contains(typing) && composingEls.has(typing)) {
      typing.blur();
      // 決めた文字を入れた変更で、もう作り直した（同じ物を 2 度作らない）
      if (key === k && !force) return;
      // blur の中で変換が決まらなかった（compositionend を後で送るブラウザ）: 欄を使い回さずに作り直す。後から来た決めた文字は、外した欄の
      // 中身のまま、変換を始めたときのカードへ入る（bindText の owner。使い回すと、次のカードの題名を入れた欄の中身を前のカードへ入れるか、
      // 決めた文字を次のカードへ入れてしまう: 見直し data-3）
      if (composingEls.has(typing)) force = true;
    }
    // ノードから別のノードへ（同じ書き手・同じ形のまま）: 欄は作り直さず、カードごとの部分と中身だけ入れ替える
    // （選ぶたびに詳細の全部を作り直して配置し直すと、机でも 30 ms を超える: 作業メモ perf-8）
    if (!force && panel && key.startsWith("node:") && k.startsWith("node:") && store.doc.nodes[k.slice(5)]) {
      // 前のカードの欄に入っていたフォーカスは外す（続けて打った文字が、新しいカードの題名に入らないように。前は欄ごと消えていた）
      const a = document.activeElement;
      if (a instanceof HTMLElement && body.contains(a)) a.blur();
      key = k;
      body.scrollTop = 0;
      panel.retarget(k.slice(5));
      panel.lowerLater();
      for (const u of updaters) u();
      return;
    }
    // 同じ選択のまま作り直す（全部が入れ替わった・書き手が変わった）: フォーカスのあった部品（data-fk の鍵）へ戻す。
    // その部品が無くなっていたら（別の端末でその欄が消えた など）、パネルの中の決まった所へ
    const held = k === key ? heldFocus() : null;
    const back = k === key ? holdFocus(body) : null;
    const moved = k !== key;
    key = k;
    updaters = [];
    viewUpdaters = [];
    panel = null;
    // 別の物を出した（道の画面を閉じてカードの詳細へ戻った など）: 前の画面の送った位置のまま、詳細の途中から見せない（見直し user-15）。
    // 中身を隠す・入れ替える前に（その後に送った位置を変えると、その場で全部を配置し直す。前のフレームで配置は済んでいる）
    if (moved && body.scrollTop) body.scrollTop = 0;
    // 作り直しを頼まれた（全部の入れ替え・書き手・閲覧のみ・地図の画面）: 取っておいた概要とノードの詳細も使わない
    if (force) {
      kept.clear();
      clear(body);
    } else {
      // 取っておいた概要は外さずに隠す（content-visibility: hidden。配置と文字の組みを持ったまま描かない）。外して入れ直すと、
      // 概要へ戻るたびに見取り図と 3 年の影響の全部を配置し直し、文字を組み直す（Esc で概要へ戻ると机でも 30 ms を超えていた: P4）。
      // 隠した物の中の部品は押せず、Tab でも行かず、読み上げにも出ない。中にあったフォーカスは、外したときと同じく外す。
      // ほかの物（ノードの詳細・接続・道の画面など）は今までどおり外す
      const ov = kept.get("none")?.el;
      for (const c of [...body.childNodes]) {
        if (c === ov) {
          const a = document.activeElement;
          if (a instanceof HTMLElement && ov.contains(a)) a.blur();
          ov.classList.add("insp-kept-off");
          ov.setAttribute("aria-hidden", "true");
        } else c.remove();
      }
    }
    // 隠した概要（あれば）。出す物はいつもその前に置く（ページの順で、出している物が隠した物より先に来る）
    const ovEl = kept.get("none")?.el;
    const hiddenOv = ovEl && ovEl.parentNode === body ? ovEl : null;
    const last0 = body.lastElementChild;
    const doc = store.doc;
    let page: DeepPageHandle | null = null;
    // 概要とノードの詳細は取っておき、戻ったときに作り直さずに中身だけ合わせる（カードを選ぶ・概要へ戻るたびに全部を作らない: 作業メモ perf-8）
    const slot = k === "none" ? "none" : k.startsWith("node:") && doc.nodes[k.slice(5)] ? "node" : null;
    const hit = slot ? kept.get(slot) : undefined;
    if (hit) {
      if (hit.el === hiddenOv) {
        hit.el.classList.remove("insp-kept-off");
        hit.el.removeAttribute("aria-hidden");
      } else body.insertBefore(hit.el, hiddenOv);
      updaters = hit.updaters;
      viewUpdaters = hit.viewUpdaters;
      panel = hit.panel;
      panel?.retarget(k.slice(5), true);
    } else if (k.startsWith("deep:") && ui.deepPage) {
      page = buildDeepPage(app, ui.deepPage);
      if (page) {
        body.append(page.el);
        const pg = page;
        updaters.push(() => pg.update());
      } else ui.closeDeep();
    } else if (k.startsWith("node:")) {
      const id = k.slice(5);
      if (doc.nodes[id]) panel = nodePanel(app, id, body, (u) => updaters.push(u), (u) => viewUpdaters.push(u));
    } else if (k.startsWith("edge:")) {
      const id = k.slice(5);
      if (doc.edges[id]) edgePanel(app, id, body, (u) => updaters.push(u));
    } else if (k.startsWith("multi:")) multiPanel(app, body, (u) => updaters.push(u), (u) => viewUpdaters.push(u));
    else overviewPanel(app, body, (u) => updaters.push(u), (u) => viewUpdaters.push(u));
    // 新しく作った物（後ろに足された物）。隠した概要があれば、その前へ移す（まだ配置していないので、移しても配置はやり直さない）
    const fresh: Element[] = [];
    for (let c = last0 ? last0.nextElementSibling : body.firstElementChild; c; c = c.nextElementSibling) fresh.push(c);
    if (hiddenOv) for (const c of fresh) body.insertBefore(c, hiddenOv);
    const made = fresh[0];
    if (slot && !hit && made instanceof HTMLElement) kept.set(slot, { el: made, updaters, viewUpdaters, panel });
    headTitle.textContent = k === "none" ? "概要" : k.startsWith("deep:") ? "3 年の分かれ道" : k.startsWith("edge:") ? "接続の詳細" : k.startsWith("multi:") ? "まとめて編集" : "ノードの詳細";
    headSub.textContent = store.readOnly ? "閲覧のみ" : "";
    if (moved) panel?.lowerLater();
    for (const u of updaters) u();
    back?.();
    settleFocus(held);
    // パネルに入れた後で、道を切り替えた行を同じ位置に（入れる前は位置を測れない）
    page?.settle();
  };

  ui.on("selection", () => {
    // 選んだ物が変わった（キャンバス・リスト・検索で選んだ）: 3 か月ごとの地図の画面を閉じて、その詳細へ（画面の中から選んだときは閉じない）
    if (ui.deepPage && !ui.deepHeld) ui.closeDeep();
    // キャンバスを押して選んだ: 詳細は次のフレームの頭で作る。離した後のブラウザの当たり判定（click）が、作りかけの詳細の配置をその場で
    // やり直させない（選んだカードの光りと詳細は同じフレームに出る。机で 1 回 7〜10 ms: 作業メモ perf-8）。パネルのボタン・キーボードで
    // 選んだときは今までどおりすぐ作る（押した後にフォーカスを詳細の部品へ移す所がある）
    const ev = typeof window !== "undefined" ? window.event : undefined;
    if (ev instanceof PointerEvent && (ev.type === "pointerup" || ev.type === "pointerdown") && ev.target instanceof HTMLCanvasElement) {
      // まとめて開いてキャンバスに多くのカードが見えている間（1,500 枚より多い）は、選んだカードの光りを先に描き、詳細はその後の
      // フレームで（2,600 枚を描くフレームに詳細の作り直しと配置を重ねると、机で 30 ms・スマホで 120 ms を超えた: 見直し speed-selectbig-confirmed）
      const big = app.vm.drawNodes.length > BIG_CANVAS;
      if (!pendingSel)
        pendingSel = requestAnimationFrame(() => {
          if (!big) {
            pendingSel = 0;
            render();
            return;
          }
          setTimeout(() => {
            if (!pendingSel) return;
            pendingSel = 0;
            render();
          }, 0);
        });
      return;
    }
    render();
  });
  // 3 か月ごとの地図の画面を開いた・切り替えた・閉じた
  ui.on("deep", () => render(true));
  // ページに入れた 3 か月ごとの地図を読み終えた（見取り図・カードの詳細を出し直す）
  app.vm.deep.onReady(() => render(true));
  store.on("change", (info) => {
    // 消えた要素を選んでいたら外す（別の端末の内容を取り込んで、選んでいたノード・線が無くなった など）。
    // そのときパネルの中にあったフォーカス（入力していた欄・キーボードで操作していた部品）は、作り直した後にパネルの中の決まった所へ
    const held = heldFocus();
    ui.pruneSelection((kind, id) => (kind === "node" ? !!store.doc.nodes[id] : !!store.doc.edges[id]));
    if (info.full) render(true);
    else render();
    settleFocus(held);
  });
  ui.on("prefs", (p) => {
    if (onlyTimeCursor(p)) return;
    // パネルの開け閉め・幅で、題名と文章の欄の高さを測り直す
    fitEpoch++;
    render();
    // 閉じていた引き出しを開いた: 閉じている間に合わせなかった見え方の欄を合わせる
    if (viewStale && !hiddenDrawer()) {
      viewStale = false;
      if (!pendingSel) for (const u of viewUpdaters) u();
    }
  });
  // 3 年の分かれ道の開閉は見え方だけ（文書の変更は届かない）: 折りたたみのボタンなどをキャンバスでの開閉に合わせる
  let viewLater = 0;
  /** 狭い画面で引き出しを閉じている間に、見え方の欄を合わせずにおいた（開いたときに合わせる） */
  let viewStale = false;
  const hiddenDrawer = () => isNarrowScreen() && !ui.prefs.rightOpen;
  ui.on("visual", () => {
    // 次のフレームで作り直す（前に選んでいた物の欄を合わせても捨てるだけ）
    if (pendingSel) return;
    // 狭い画面で引き出しを閉じている: 見えないパネルの枚数を数え直さない（開いたときに合わせる。まとめて開いて 2,600 枚見えている
    // 間に C で 1 つ開くたびに、書き換えた地図の数え直しで数百 ms かかっていた）
    if (hiddenDrawer()) {
      viewStale = true;
      ui.panelAfterPaint = false;
      return;
    }
    // まとめて開いた: キャンバスを描いた後に合わせる（その間にほかの合わせ直しが来たら、そのときの欄で 1 回だけ）
    if (ui.panelAfterPaint || viewLater) {
      ui.panelAfterPaint = false;
      if (viewLater) return;
      viewLater = requestAnimationFrame(() =>
        setTimeout(() => {
          viewLater = 0;
          if (!pendingSel) for (const u of viewUpdaters) u();
        }, 0),
      );
      return;
    }
    for (const u of viewUpdaters) u();
  });
  // 閲覧のみになった・編集できるようになった（別のタブに引き継がれた・引き継いだ・アカウントに新しい版の内容があった）: 欄を作り直す
  store.on("readOnly", () => render(true));
  app.focusInspectorTitle = () => {
    if (pendingSel) render();
    const t = body.querySelector<HTMLTextAreaElement>(".insp-title");
    t?.focus();
    t?.select();
  };
  // ノードの詳細を、空いた時間に先に作っておく（1 歩目: 置かずに作って中身を合わせる。2 歩目: 見えない所に置いて 1 度配置し、外して取っておく）。
  // 初めてカードを選んだときは、取っておいた入れ物を使う（2 回目から選ぶときと同じ道）。何かを選んでいる・作り直した・閉じた引き出しの中なら何もしない
  let warm: { stage: HTMLElement; filled: number; slot: { el: HTMLElement; updaters: Updater[]; viewUpdaters: Updater[]; panel: NodePanel | null } } | null = null;
  app.prewarmInspector = (): boolean => {
    // 狭い画面（スマホ）では作らない: 4 倍遅いスマホでは組み立てた本文の 1 つで 150 ms ほどの長い仕事になる（予算 120 ms の選ぶの方が余裕がある）
    const stale = (): boolean => key !== "none" || kept.has("node") || pendingSel !== 0 || isNarrowScreen() || !root.isConnected;
    if (stale()) {
      warm = null;
      return true;
    }
    if (!warm) {
      const imp = app.vm.impact;
      const alts = imp.active && imp.root ? imp.decision.get(imp.root)?.alts : undefined;
      const id = alts?.find((x) => store.doc.nodes[x]) ?? (imp.root && store.doc.nodes[imp.root] ? imp.root : null);
      if (!id) return true;
      const stage = h("div", { class: "insp-prewarm", attrs: { "aria-hidden": "true", inert: "" } });
      const ups: Updater[] = [];
      const vups: Updater[] = [];
      const p = nodePanel(app, id, stage, (u) => ups.push(u), (u) => vups.push(u));
      const el = stage.firstElementChild;
      if (!(el instanceof HTMLElement)) return true;
      warm = { stage, filled: 0, slot: { el, updaters: ups, viewUpdaters: vups, panel: p } };
      return false;
    }
    if (warm.filled < warm.slot.updaters.length) {
      // 中身を合わせる（1 歩で 1 つ: どの 1 つも短いが、全部では机で 40 ms ほど）
      warm.slot.updaters[warm.filled++]!();
      return false;
    }
    const w = warm;
    warm = null;
    body.append(w.stage);
    // 配置させる（高さ 0 の見えない入れ物の中で。文字の組み・式の当てはめを済ませる）
    void w.slot.el.offsetHeight;
    w.stage.remove();
    w.slot.el.remove();
    kept.set("node", w.slot);
    return true;
  };
  app.focusEdgeCondition = () => {
    if (pendingSel) render();
    const t = body.querySelector<HTMLTextAreaElement>(".edge-condition");
    t?.focus();
  };
  render(true);
  return root;
}

// ------------------------------------------------------------ 部品

function sectionEl(title: string, ...children: Array<Node | null>): HTMLElement {
  return h("section", { class: "insp-section" }, h("h3", { class: "insp-label" }, title), ...children);
}

/** 次のフレームで高さを合わせるテキストエリア（と高さの上限） */
const pendingFit = new Map<HTMLTextAreaElement, number | undefined>();
let fitRaf = 0;

/**
 * テキストエリアの高さを中身に合わせる。閉じている右のパネル（狭い画面の引き出しも）の中では幅がほとんど無く、
 * 高く測ったまま開いた後も残る。パネルを開く知らせはパネルが広がる前に届くので、次のフレーム（広がった後）に合わせる。
 * 合わせるのは次のフレームの描く前に、その時の物をまとめて 1 回（先に全部を auto にしてから測る: 測るたびに配置を
 * やり直さない。選ぶ・1 文字のたびに何度も配置をやり直すと、スマホで 100 ms 以上かかる: 作業メモ perf-4・perf-12）
 */
function fitHeight(ta: HTMLTextAreaElement, max?: number): void {
  pendingFit.set(ta, max);
  if (fitRaf) return;
  fitRaf = requestAnimationFrame(() => {
    fitRaf = 0;
    // 置いていない欄（下の欄を次のフレームに回している間・閉じた引き出し）は測らない（高さ 0 と測って縮めない）
    const list = [...pendingFit].filter(([t]) => t.isConnected && t.getClientRects().length > 0);
    pendingFit.clear();
    for (const [t] of list) t.style.height = "auto";
    const hs = list.map(([t, m]) => Math.min(m ?? 360, t.scrollHeight + 2));
    list.forEach(([t], i) => (t.style.height = `${hs[i]}px`));
  });
}

/** 変換中（IME）の欄（変換中の文字はまだ文書に入れていない） */
const composingEls = new WeakSet<Element>();

/** 欄ごとの「まだ文書に入れていない入力があるか」 */
const unsaved = new WeakMap<Element, () => boolean>();

/**
 * フォーカスのある入力欄に、まだ文書に入れていない入力があるか（同期の取り込みは入れ終わるまで待つ。入れ替えると欄が作り直されて消える）。
 * 打つたびに入れる欄・選ぶとすぐ入れる欄は、変換中（IME）でなければ無い（取り込んで作り直した後も、フォーカスと文字の位置を戻す）。
 * 分からない欄（年収の欄・検索など）は、フォーカスがある間はあるとみなす
 */
export function hasUnsavedInput(el: Element | null): boolean {
  if (!el || !isTypingTarget(el)) return false;
  const check = unsaved.get(el);
  return check ? check() : true;
}

/**
 * 作り直す前のフォーカス（data-fk の鍵・文字の選択・パネルの位置）を覚え、作り直した後に同じ鍵の部品へ戻す関数を返す。
 * ボタンはキーボードで操作しているときだけ（マウスで押した後は今までどおり、続くキーは選んだカードへの操作）
 */
function holdFocus(body: HTMLElement): (() => void) | null {
  const a = document.activeElement;
  if (!(a instanceof HTMLElement) || !body.contains(a) || !a.dataset.fk) return null;
  if (!isTypingTarget(a) && !keyboardFocus(a)) return null;
  const fk = a.dataset.fk;
  const top = body.scrollTop;
  let sel: { start: number; end: number; dir: "forward" | "backward" | "none" } | null = null;
  try {
    if ((a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement) && a.selectionStart !== null && a.selectionEnd !== null) sel = { start: a.selectionStart, end: a.selectionEnd, dir: a.selectionDirection ?? "none" };
  } catch {
    /* 文字の位置を持たない欄（日付・数） */
  }
  return () => {
    const el = body.querySelector<HTMLElement>(`:scope > :not(.insp-kept-off) [data-fk="${CSS.escape(fk)}"]`);
    if (!el) return;
    body.scrollTop = top;
    el.focus();
    if (!sel || document.activeElement !== el || !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
    try {
      const n = el.value.length;
      el.setSelectionRange(Math.min(sel.start, n), Math.min(sel.end, n), sel.dir);
    } catch {
      /* 文字の位置を持たない欄 */
    }
  };
}

/**
 * 入力のたびに保存し、続けての入力は Undo 1 回にまとめる。欄を離れたらまとめを切る。変換中（IME）だけは入れ終わっていない。
 * 変換中（compositionstart から compositionend まで）の 1 文字ずつは文書に入れない（キャンバス・詳細・検索の作り直しを変換の 1 文字ごとに
 * しない: 作業メモ perf-9）。変換を決めたとき（compositionend）にその時の欄の中身を入れる（Chrome は compositionend の後に input を
 * 送らない。送るブラウザでは同じ中身なので、2 度目は何も変えない）。変換中に欄を離れる・作り直すときは、先に変換を決めさせる（詳細の render）
 */
function bindText<T = undefined>(app: AppContext, el: HTMLInputElement | HTMLTextAreaElement, write: (v: string, at: T) => void, owner?: () => T): void {
  let composing = false;
  /** 変換を始めたときの書き先（欄を別のカードに使い回しても、決めた文字は始めたときのカードへ: 見直し data-3） */
  let at = undefined as T;
  el.addEventListener("compositionstart", () => {
    composing = true;
    composingEls.add(el);
    at = owner ? owner() : (undefined as T);
  });
  el.addEventListener("compositionend", () => {
    const t = composing ? at : owner ? owner() : (undefined as T);
    composing = false;
    composingEls.delete(el);
    write(el.value, t);
  });
  unsaved.set(el, () => composing);
  el.addEventListener("input", (ev) => {
    if (el instanceof HTMLTextAreaElement) fitHeight(el);
    if (composing || (ev as InputEvent).isComposing) return;
    write(el.value, owner ? owner() : (undefined as T));
  });
  el.addEventListener("blur", () => app.store.history.seal());
  el.addEventListener("keydown", (ev) => {
    if ((ev as KeyboardEvent).key === "Escape") (ev.target as HTMLElement).blur();
  });
}

function dateInput(value: string | null, onChange: (v: string | null) => void, label: string): HTMLInputElement {
  const el = h("input", { class: "input input-date", type: "date", value: value ?? "", attrs: { "aria-label": label, min: "1900-01-01", max: "2999-12-31" } });
  el.addEventListener("change", () => {
    const v = normalizeDateStr(el.value);
    // 範囲の外など読めない日付で、今の期限を黙って消さない
    if (el.value && !v) {
      toast(`日付は ${MIN_YEAR}〜${MAX_YEAR} 年の間で入れてください`, { tone: "warn" });
      return;
    }
    onChange(v);
  });
  return el;
}

function typePicker(app: AppContext, current: () => GNode["type"] | null, onPick: (t: GNode["type"]) => void, push: (u: Updater) => void): HTMLElement {
  const wrap = h("div", { class: "type-picker block", role: "radiogroup", ariaLabel: "種類" });
  const btns = NODE_TYPE_ORDER.map((t) => {
    const meta = NODE_TYPES[t];
    const b = h("button", { class: `type-opt type-${t}`, type: "button", role: "radio", title: `${meta.label}: ${meta.hint}（キー ${meta.key}）` }, icon(t, 15), h("span", null, meta.label));
    b.addEventListener("click", () => onPick(t));
    wrap.append(b);
    return { t, b };
  });
  push(() => {
    const cur = current();
    for (const { t, b } of btns) {
      b.classList.toggle("active", cur === t);
      b.setAttribute("aria-checked", String(cur === t));
      b.disabled = app.store.readOnly;
    }
  });
  return wrap;
}

function statusSelect(app: AppContext, current: () => GNode["status"] | null, onPick: (s: GNode["status"]) => void, push: (u: Updater) => void): HTMLSelectElement {
  const sel = h("select", { class: "input select-status", dataset: { fk: "status" }, attrs: { "aria-label": "状態" } });
  // 選ぶとすぐ入れる（入れ終わっていない入力は持たない）
  unsaved.set(sel, () => false);
  // 複数選択で状態がそろっていないとき用（どの状態を選んでも変更として届くように）
  const mixed = h("option", { value: "", disabled: true }, "混在");
  sel.append(mixed);
  for (const s of STATUS_ORDER) sel.append(h("option", { value: s }, STATUSES[s].label));
  sel.addEventListener("change", () => {
    if (sel.value) onPick(sel.value as GNode["status"]);
  });
  push(() => {
    const cur = current();
    mixed.hidden = !!cur;
    setValue(sel, cur ?? "");
    sel.dataset.status = cur ?? "";
    sel.disabled = app.store.readOnly;
  });
  return sel;
}

function chipToggle(label: string, color: string | null, on: boolean, onClick: () => void, opts: { partial?: boolean; disabled?: boolean; title?: string } = {}): HTMLButtonElement {
  const b = h(
    "button",
    { class: `chip-toggle${on ? " on" : ""}${opts.partial ? " partial" : ""}`, type: "button", title: opts.title, disabled: opts.disabled, attrs: { "aria-pressed": String(on) } },
    color ? h("span", { class: "dot", style: { background: color } }) : null,
    h("span", null, label),
    on ? icon("check", 12, 2.4) : null,
  );
  if (color) b.style.setProperty("--chip-color", color);
  b.addEventListener("click", onClick);
  return b;
}

// ------------------------------------------------------------ ノード

/** ノードの詳細（別のノードを選んだら、欄を作り直さずに中身だけ入れ替える: 作業メモ perf-8） */
interface NodePanel {
  /** 別のカードにする（again: 同じカードでも、カードごとの部分を作り直す。取っておいた詳細を置き直したとき） */
  retarget(id: ID, again?: boolean): void;
  /**
   * 3 年の分かれ道のカード（上に 3 年の影響の長い欄がある）: 画面の外の下の欄（内訳・結果・同じ判断の手・自分のメモ・時間・条件・タグ・
   * つながりなど）は、選んだフレームでは置かず、その次に出す（中身は今合わせてある。選んだフレームの配置を上の見える所だけにする: 作業メモ perf-8）
   */
  lowerLater(): void;
}

/** 前に出した物（物の同一性で比べる）と同じか。違えば覚え直して true（作り直す） */
class RefSeen {
  private prev: unknown[] | null = null;
  changed(next: unknown[]): boolean {
    const p = this.prev;
    if (p && p.length === next.length && p.every((x, i) => x === next[i])) return false;
    this.prev = next;
    return true;
  }
  reset(): void {
    this.prev = null;
  }
}

const dayFormat = new Intl.DateTimeFormat("ja-JP");
const stampFormat = new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** テキストエリアの高さを合わせた時の中身（と、パネルの開け閉めの回数）。同じなら測り直さない（測るたびにパネル全体の配置をやり直す） */
const fitSeen = new WeakMap<HTMLTextAreaElement, string>();
/** パネルの開け閉め・幅の変わる設定の回数（変われば測り直す） */
let fitEpoch = 0;
function fitChanged(ta: HTMLTextAreaElement, max?: number): void {
  const k = `${fitEpoch}|${ta.value}`;
  if (fitSeen.get(ta) === k) return;
  fitSeen.set(ta, k);
  fitHeight(ta, max);
}

function nodePanel(app: AppContext, id0: ID, root: HTMLElement, push: (u: Updater) => void, pushView: (u: Updater) => void): NodePanel {
  const { store, cmd, ui, vm } = app;
  /** 出しているカード（別のカードを選んだら、欄はそのまま中身だけ入れ替える: retarget） */
  let id = id0;
  const node = () => store.doc.nodes[id];
  const ro = () => store.readOnly;
  const wrap = h("div", { class: "insp-node" });
  root.append(wrap);

  // 種類
  // 「前の版で決めたこと」の見出しのカードは、まとめの見出しで目標ではない: 種類と状態の欄を出さない（見直し R7）
  const isGroup = (): boolean => typeof node()?.meta?.prevGroup === "number";
  const picker = typePicker(app, () => node()?.type ?? null, (t) => cmd.setType([id], t), push);
  wrap.append(picker);
  const status = statusSelect(app, () => node()?.status ?? null, (s) => cmd.setStatus([id], s), push);
  push(() => {
    const g = isGroup();
    picker.hidden = g;
    status.hidden = g;
  });

  // タイトル
  const title = h("textarea", { class: "insp-title", placeholder: "タイトル", dataset: { fk: "title" }, attrs: { rows: "1", "aria-label": "タイトル", spellcheck: "false" } });
  // 書き先は打ったとき（変換なら変換を始めたとき）のカード。そのカードが無くなっていたら入れない
  const owner = (): ID => id;
  bindText(
    app,
    title,
    (v, at) => {
      if (store.doc.nodes[at]) cmd.updateNode(at, { title: v.replace(/\n/g, " ") }, { label: "タイトルを編集", coalesce: `title:${at}` });
    },
    owner,
  );
  title.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !isImeKey(ev)) {
      ev.preventDefault();
      title.blur();
    }
  });
  wrap.append(title);

  const projLine = h("div", { class: "insp-projline" });
  wrap.append(h("div", { class: "insp-meta" }, status, projLine));
  // 文章（3 か月ごとの地図のカードは、組み立てた本文を読むだけで上に出し、下の欄は自分のメモ: 作業メモ SPEC v1 §4.4・safety-10）
  const bodyTa = h("textarea", { class: "input insp-text", placeholder: "メモ・背景・外部の AI と考えたこと…", dataset: { fk: "body" }, attrs: { rows: "3", "aria-label": "文章" } });
  bindText(
    app,
    bodyTa,
    (v, at) => {
      const n = store.doc.nodes[at];
      if (!n) return;
      // 前の版で書き換えた本文を移したメモ（meta.prevBody）を書き換えたら、もう前の版の本文のままではないので印を外す（見直し data-3）
      const meta = n.meta;
      const prev = meta?.[PREV_BODY_META] === true ? Object.fromEntries(Object.entries(meta).filter(([k]) => k !== PREV_BODY_META)) : null;
      cmd.updateNode(at, prev ? { body: v, meta: prev } : { body: v }, { label: "文章を編集", coalesce: `body:${at}` });
    },
    owner,
  );
  // カードごとの部分（組み立てた本文・3 年の影響・3 か月ごとの地図の操作）。別のカードを選んだら、ここだけ作り直す（mountBlocks）
  let composed: ReturnType<typeof buildComposedBody> = null;
  let impact: ReturnType<typeof buildImpactNodeBlock> = null;
  let deepBlock: ReturnType<typeof buildDeepNodeBlock> = null;
  // 3 か月ごとの地図のカード: この先の道を読む・時間で区切って開く（作業メモ SPEC v1 §5.4・§5.5・§5.8）
  // 3 年の影響の欄の下にあるので、下の欄を次のフレームに回している間は合わせない（出す前に合わせる）
  push(() => {
    if (!lowerTimer) deepBlock?.update();
  });
  pushView(() => {
    if (!lowerTimer) deepBlock?.update();
  });
  // 未来の道筋: ここに至る見込みと、今日から何歩目か
  const forecastLine = h("div", { class: "insp-forecast", attrs: { role: "status" } });
  forecastLine.hidden = true;
  wrap.append(forecastLine);
  // 3 年の影響の欄の中に入らなかった（範囲の外など）組み立てた本文を置く所
  const composedAt = document.createComment("composed");
  wrap.append(composedAt);
  push(() => composed?.update());
  const bodySec = sectionEl("文章", bodyTa);
  wrap.append(bodySec);
  // 前の版（版 6 まで）の地図で書き換えた本文を移したメモ: 「前の版のメモ」と言う（地図の文章は上。W-store の §10.5・W-app の I9）
  const bodyLabel = bodySec.querySelector(".insp-label")!;
  const hint = h("p", { class: "insp-hint deep-prev-note" }, "前の版の地図で書き換えた本文を、そのまま残しています。新しい地図の文章は上にあります");
  hint.hidden = true;
  bodySec.append(hint);
  const syncPrev = (): void => {
    if (!composed) {
      bodyLabel.textContent = "文章";
      hint.hidden = true;
      bodyTa.placeholder = "メモ・背景・外部の AI と考えたこと…";
      bodyTa.setAttribute("aria-label", "文章");
      return;
    }
    const n = node();
    const prev = !!n && n.meta?.[PREV_BODY_META] === true && n.body.trim().length > 0;
    bodyLabel.textContent = prev ? "前の版のメモ" : "自分のメモ";
    hint.hidden = !prev;
    bodyTa.placeholder = "自分のメモ（地図の文章とは別に残る）";
    bodyTa.setAttribute("aria-label", prev ? "前の版のメモ" : "自分のメモ");
  };
  push(syncPrev);

  // 期限
  const n0 = node()!;
  const due = dateInput(n0.time.due, (v) => cmd.updateNode(id, { time: { ...node()!.time, due: v } }, { label: v ? "期限を設定" : "期限を外す" }), "期限");
  const start = dateInput(n0.time.start, (v) => cmd.updateNode(id, { time: { ...node()!.time, start: v } }, { label: v ? "開始日を設定" : "開始日を外す" }), "開始日");
  // 日付は決まると入れる。書きかけ（読めない・まだ入れていない日付）の間だけ、入れ終わっていない入力がある
  for (const [el, k] of [[due, "due"], [start, "start"]] as const) {
    el.dataset.fk = k;
    unsaved.set(el, () => el.validity.badInput || el.value !== (node()?.time[k] ?? ""));
  }
  const clearDue = h("button", { class: "icon-btn icon-btn-xs", type: "button", title: "期限を外す", ariaLabel: "期限を外す", onClick: () => cmd.updateNode(id, { time: { ...node()!.time, due: null } }, { label: "期限を外す" }) }, icon("x", 13));
  const rel = h("span", { class: "due-rel" });
  const dates = h(
    "div",
    { class: "insp-dates" },
    h("label", { class: "date-field" }, h("span", { class: "date-label" }, "期限"), due, clearDue),
    h("label", { class: "date-field" }, h("span", { class: "date-label" }, "開始"), start),
    rel,
  );
  const timeSec = sectionEl("時間", dates);
  wrap.append(timeSec);

  // 条件（3 年の分かれ道の選択肢では「やること」として文章の前に）
  const condCount = h("span", { class: "insp-count" });
  const condList = h("div", { class: "cond-list" });
  const condAdd = h("input", { class: "input input-sm", placeholder: "条件を追加（Enter）", dataset: { fk: "cond-add" }, attrs: { "aria-label": "条件を追加" } });
  // Enter で入れるまでは、書いた文字が入れ終わっていない入力
  unsaved.set(condAdd, () => !!condAdd.value.trim());
  condAdd.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !isImeKey(ev) && condAdd.value.trim()) {
      ev.preventDefault();
      cmd.addCondition(id, condAdd.value);
      condAdd.value = "";
    }
  });
  const condSec = sectionEl("条件", condList, condAdd);
  const condLabel = condSec.querySelector(".insp-label")!;
  const condLabelText = document.createTextNode("条件");
  condLabel.replaceChildren(condLabelText, condCount);
  // 「やること」でないときの条件の欄の置き場（時間の欄の後）
  const condAt = document.createComment("conditions");
  wrap.append(condAt);
  const condRows = new Map<ID, { row: HTMLElement; box: HTMLInputElement; text: HTMLInputElement }>();

  /** カードごとの部分を、今のカード（id）の物にする（初めてと、別のカードを選んだとき） */
  const mountBlocks = (): void => {
    composed?.el.remove();
    impact?.el.remove();
    deepBlock?.el.remove();
    composed = buildComposedBody(app, id, () => bodyTa.focus());
    // 3 年の分かれ道の中のノード: 3 年の影響・見込み・目印（下の「ここに至る見込み」の代わり）。組み立てた本文は、その数のすぐ後に
    // （狭い画面でも、具体的な文章を 2 画面より下へ押しやらない: 見直し user-11）
    impact = buildImpactNodeBlock(app, id, composed?.el ?? null);
    if (impact) wrap.insertBefore(impact.el, forecastLine);
    deepBlock = buildDeepNodeBlock(app, id);
    if (deepBlock) wrap.insertBefore(deepBlock.el, forecastLine);
    if (composed && !impact) wrap.insertBefore(composed.el, composedAt);
    const todo = !!impact?.isAlt;
    condLabelText.data = todo ? "やること" : "条件";
    condAdd.placeholder = todo ? "やることを追加（Enter）" : "条件を追加（Enter）";
    condAdd.setAttribute("aria-label", todo ? "やることを追加" : "条件を追加");
    if (todo) wrap.insertBefore(condSec, bodySec);
    else wrap.insertBefore(condSec, condAt);
  };
  mountBlocks();

  // タグ
  const tagWrap = h("div", { class: "tag-edit" });
  const tagInput = h("input", { class: "tag-input", placeholder: "タグを追加", dataset: { fk: "tag-add" }, attrs: { "aria-label": "タグを追加", list: "tag-suggestions" } });
  unsaved.set(tagInput, () => !!tagInput.value.trim());
  const datalist = h("datalist", { attrs: { id: "tag-suggestions" } });
  tagInput.addEventListener("keydown", (ev) => {
    if ((ev.key === "Enter" || ev.key === ",") && !isImeKey(ev) && tagInput.value.trim()) {
      ev.preventDefault();
      cmd.addTag([id], tagInput.value);
      tagInput.value = "";
    } else if (ev.key === "Backspace" && !tagInput.value && !ev.repeat && !isImeKey(ev)) {
      // 長押しの繰り返しでは消さない（文字を消し終えた勢いで、今あるタグまで消さない）
      const n = node();
      const last = n?.tags[n.tags.length - 1];
      if (last) cmd.removeTag(id, last);
    }
  });
  const tagBox = h("div", { class: "tag-box" }, tagWrap, tagInput, datalist);
  tagBox.addEventListener("click", () => tagInput.focus());
  wrap.append(sectionEl("タグ", tagBox));

  // プロジェクト・シナリオ
  const projChips = h("div", { class: "chip-row" });
  wrap.append(sectionEl("プロジェクト（複数可）", projChips));
  const scenChips = h("div", { class: "chip-row" });
  wrap.append(sectionEl("シナリオ", scenChips));

  // つながり
  const conns = h("div", { class: "conn-list" });
  const addChild = h("button", { class: "btn btn-sm", type: "button", title: "この先に分岐を 1 つ足す（Tab）", onClick: () => cmd.addChild(id) }, icon("plus", 14), "分岐を追加");
  const addTwo = h("button", { class: "btn btn-sm", type: "button", title: "条件つきの分岐を 2 つまとめて作る", onClick: () => cmd.addBranches(id, 2) }, icon("split", 14), "2 つに分岐");
  const connSec = sectionEl("つながり", conns, h("div", { class: "btn-row" }, addChild, addTwo));
  wrap.append(connSec);
  // 「前の版で決めたこと」の見出しのカードは、まとめの見出し: 空の期限・条件・つながりの欄は出さない（見直し reader-5。何か入っていれば
  // 出す: 入れた物を隠さない）
  push(() => {
    const n = node();
    const g = !!n && isGroup();
    timeSec.hidden = g && !n.time.due && !n.time.start;
    condSec.hidden = g && !n.conditions.length;
    connSec.hidden = g && !(vm.index.out.get(id) ?? []).length && !(vm.index.inc.get(id) ?? []).length;
  });

  // 操作
  const dupBtn = h("button", { class: "btn btn-sm", type: "button", title: `複製（${MOD}D）`, onClick: () => cmd.duplicate([id]) }, icon("copy", 14), "複製");
  const colLabel = h("span", null, "折りたたむ");
  const colBtn = h("button", { class: "btn btn-sm", type: "button", title: "この先を折りたたむ（C）", onClick: () => cmd.toggleCollapse([id]) }, icon("collapse", 14), colLabel);
  const delBtn = h("button", { class: "btn btn-sm btn-danger-ghost", type: "button", title: "削除（Delete）", onClick: () => cmd.deleteNodes([id]) }, icon("trash", 14), "削除");
  const foot = h("div", { class: "insp-foot" });
  wrap.append(h("div", { class: "insp-actions" }, dupBtn, colBtn, delBtn), foot);
  /**
   * 折りたたむ・展開する。3 年の分かれ道のノードは見え方で開閉する（文書の collapsed ではない。閲覧のみでも使える）。
   * キャンバスで開閉したとき（見え方だけの変更）にも合わせる
   */
  let colShown: boolean | null = null;
  const syncCol = () => {
    if (!node()) return;
    const collapsed = cmd.isCollapsed(id);
    // 開閉する物が無ければ押せない（3 年の分かれ道は同じ範囲の子のあるカードだけ。印・C・メニューと同じ決まり）
    colBtn.disabled = (ro() && !vm.inImpact(id)) || !vm.canCollapse(id);
    if (collapsed === colShown) return;
    colShown = collapsed;
    colLabel.textContent = collapsed ? "展開する" : "折りたたむ";
    colBtn.title = collapsed ? "この先を展開する（C）" : "この先を折りたたむ（C）";
    colBtn.replaceChild(icon(collapsed ? "expand" : "collapse", 14), colBtn.firstElementChild!);
  };
  pushView(syncCol);

  const projLineSeen = new RefSeen();
  const tagSeen = new RefSeen();
  const tagListSeen = new RefSeen();
  const chipSeen = new RefSeen();
  const connSeen = new RefSeen();
  const footSeen = new RefSeen();
  /** 下の欄を次のフレームに回している（lowerLater）。その間は下の欄の中身も合わせない（出す前に合わせる） */
  let lowerTimer: ReturnType<typeof setTimeout> | 0 = 0;
  push(() => {
    const n = node();
    if (!n) return;
    const doc = store.doc;
    wrap.style.setProperty("--type-color", NODE_TYPES[n.type].color);
    setValue(title, n.title);
    fitChanged(title, 140);
    setValue(bodyTa, n.body);
    fitChanged(bodyTa);
    for (const el of [title, bodyTa, due, start, condAdd, tagInput]) el.disabled = ro();
    setValue(due, n.time.due ?? "");
    setValue(start, n.time.start ?? "");
    clearDue.hidden = !n.time.due;
    const r = relativeDue(n.time.due);
    rel.textContent = r ? (n.status === "done" ? `完了（期限 ${formatDate(n.time.due)}）` : r.text) : "期限なし";
    rel.dataset.tone = n.status === "done" ? "done" : (r?.tone ?? "none");

    // 所属の一行（プロジェクトの物か所属が変わったときだけ作り直す。題名の 1 文字などでは作らない: 作業メモ perf-9）
    if (projLineSeen.changed([n.projectIds, ...n.projectIds.map((pid) => doc.projects[pid])])) {
    clear(projLine);
    for (const pid of n.projectIds) {
      const p = doc.projects[pid];
      if (p) projLine.append(h("span", { class: "proj-pill", style: { "--c": p.color } }, h("span", { class: "dot", style: { background: p.color } }), p.name));
    }
    if (n.projectIds.length > 1) projLine.append(h("span", { class: "shared-pill", title: "複数のプロジェクトから参照されている共有ノード" }, icon("link", 12), "共有"));
    if (!n.projectIds.length && !isGroup()) projLine.append(h("span", { class: "muted-pill" }, "未分類"));
    }

    // 3 年の影響（数が変わったときだけ作り直す。下の欄を次のフレームに回している間は、画面の外の並びの中身も後で作る）
    impact?.update(lowerTimer !== 0);

    // 見込み（予測の入口から届くノードだけ。3 年の分かれ道の中では上の 3 年の影響に出す）
    const fc = vm.forecast;
    const reach = fc.active && !impact ? fc.reach.get(id) : undefined;
    forecastLine.hidden = !reach;
    clear(forecastLine);
    if (reach) {
      const sid = ui.prefs.scenarioId;
      const scen = sid ? doc.scenarios[sid] : undefined;
      const steps = reach.minSteps === reach.maxSteps ? `${reach.minSteps}` : `${reach.minSteps}〜${reach.maxSteps}`;
      if (reach.maxSteps === 0) forecastLine.append(icon("sparkle", 13), h("span", null, "予測の入口（今日）。ここから先の見込みを計算しています"));
      else
        forecastLine.append(
          icon("sparkle", 13),
          h("span", null, "ここに至る見込み "),
          h("b", { class: "forecast-pct" }, formatPercent(reach.p)),
          h("span", { class: "muted" }, `・今日から ${steps} 歩目${scen ? `（${scen.name}を選んだ場合）` : ""}`),
        );
    }

    if (!lowerTimer) updateLower();
  });

  /** 下の欄（条件・タグ・プロジェクト・シナリオ・つながり・操作）を今のカードに合わせる */
  const updateLower = (): void => {
    const n = node();
    if (!n) return;
    const doc = store.doc;
    // 条件（ID ごとに行を残す＝入力中の行を壊さない）
    const met = n.conditions.filter((c) => c.met).length;
    condCount.textContent = n.conditions.length ? `${met}/${n.conditions.length}` : "";
    const seen = new Set<ID>();
    n.conditions.forEach((c, i) => {
      seen.add(c.id);
      let r2 = condRows.get(c.id);
      if (!r2) {
        const box = h("input", { type: "checkbox", class: "cond-check", attrs: { "aria-label": "満たした" } });
        box.addEventListener("change", () => cmd.updateCondition(id, c.id, { met: box.checked }));
        const text = h("input", { class: "cond-text", dataset: { fk: `cond:${c.id}` }, attrs: { "aria-label": "条件" } });
        bindText(app, text, (v, at) => cmd.updateCondition(at, c.id, { text: v }, `cond:${c.id}`), owner);
        text.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" && !isImeKey(ev)) text.blur();
        });
        const del = h("button", { class: "icon-btn icon-btn-xs cond-del", type: "button", ariaLabel: "条件を削除", title: "条件を削除", onClick: () => cmd.removeCondition(id, c.id) }, icon("x", 13));
        r2 = { row: h("div", { class: "cond-row" }, box, text, del), box, text };
        condRows.set(c.id, r2);
      }
      r2.box.checked = c.met;
      r2.box.disabled = ro();
      r2.text.disabled = ro();
      r2.row.classList.toggle("met", c.met);
      setValue(r2.text, c.text);
      // 並び順をそろえる。順番が合っている行は動かさない（動かすと入力中の欄からフォーカスが外れ、次のキーがキャンバスへ行く）
      const at = condList.children[i];
      if (at !== r2.row) condList.insertBefore(r2.row, at ?? null);
    });
    for (const [cid, r3] of condRows) {
      if (!seen.has(cid)) {
        r3.row.remove();
        condRows.delete(cid);
      }
    }

    // タグ（タグ・候補・閲覧のみが変わったときだけ）
    if (tagSeen.changed([n.tags, ro()])) {
    clear(tagWrap);
    for (const t of n.tags) {
      const x = h("button", { class: "tag-x", type: "button", ariaLabel: `${t} を外す`, disabled: ro(), onClick: (ev) => (ev.stopPropagation(), cmd.removeTag(id, t)) }, icon("x", 11, 2.2));
      const chip = h("span", { class: "tag-chip static" }, h("button", { class: "tag-link", type: "button", title: `#${t} で検索`, onClick: () => ui.setSearch(`#${t}`) }, `#${t}`), x);
      tagWrap.append(chip);
    }
    }
    const topTags = vm.index.tags.slice(0, 40);
    if (tagListSeen.changed([n.tags, ...topTags.map((t) => t.tag)])) {
      clear(datalist);
      for (const t of topTags) if (!n.tags.includes(t.tag)) datalist.append(h("option", { value: t.tag }));
    }

    // プロジェクト
    if (chipSeen.changed([ro(), n.projectIds, doc.projectOrder, ...doc.projectOrder.map((pid) => doc.projects[pid]), n.scenarioIds, doc.scenarioOrder, ...doc.scenarioOrder.map((sid) => doc.scenarios[sid])])) {
    clear(projChips);
    for (const pid of doc.projectOrder) {
      const p = doc.projects[pid];
      if (!p) continue;
      projChips.append(chipToggle(p.name, p.color, n.projectIds.includes(pid), () => cmd.toggleProjectOf([id], pid), { disabled: ro() }));
    }
    if (!doc.projectOrder.length) projChips.append(h("span", { class: "muted" }, "プロジェクトがありません（左の ＋ で追加）"));

    // シナリオ
    clear(scenChips);
    scenChips.append(chipToggle("全シナリオ共通", null, n.scenarioIds.length === 0, () => cmd.setScenarioOf({ nodes: [id] }, null), { disabled: ro(), title: "どのシナリオでも起きる" }));
    for (const sid of doc.scenarioOrder) {
      const s = doc.scenarios[sid];
      if (!s) continue;
      scenChips.append(chipToggle(s.name, s.color, n.scenarioIds.includes(sid), () => cmd.setScenarioOf({ nodes: [id] }, sid), { disabled: ro() }));
    }
    }

    // つながり（線・その先のカード・見込みの兄弟の線のどれかが変わったときだけ作り直す。題名の 1 文字ではそのまま: 作業メモ perf-9）
    const ins = (vm.index.inc.get(id) ?? []).slice();
    const outs = (vm.index.out.get(id) ?? []).slice();
    const connRefs: unknown[] = [ro(), ins.length, outs.length];
    for (const [list, dir] of [[ins, "in"], [outs, "out"]] as const) {
      for (const eid of list) {
        const e = doc.edges[eid];
        connRefs.push(eid, e, e ? doc.nodes[dir === "in" ? e.source : e.target] : undefined, vm.index.cross.has(eid));
        if (e && edgeProb(e) !== null) connRefs.push(...flowOuts(doc, vm.index.out, e.source));
      }
    }
    if (connSeen.changed(connRefs)) {
    clear(conns);
    // 線の見込み。兄弟の見込みの合計が 100% でなければ、数えている見込みも（「77%（ほかと合わせて 46%）」: 見直し R6）
    const probLabel = (e: GEdge, label: string): string => {
      const p = edgeProb(e);
      if (p === null) return label;
      const sibs = flowOuts(doc, vm.index.out, e.source);
      const j = sibs.findIndex((x) => x.id === e.id);
      if (j < 0 || sumOfProbs(sibs) === null) return `${label} ${p}%`;
      const w = Math.round(chanceWeights(sibs)[j]! * 100);
      return w === Math.round(p) ? `${label} ${p}%` : `${label} ${p}%（ほかと合わせて ${w}%）`;
    };
    const connRow = (eid: ID, dir: "in" | "out") => {
      const e = doc.edges[eid]!;
      const other = doc.nodes[dir === "in" ? e.source : e.target]!;
      const relMeta = RELATIONS[e.relation];
      const row = h(
        "div",
        { class: "conn-row" },
        h("span", { class: "conn-dir", title: dir === "in" ? "入る（ここへ至る）" : "出る（ここから進む）" }, icon(dir === "in" ? "arrowLeft" : "arrowRight", 13)),
        h("button", { class: "conn-node", type: "button", title: "このノードへ移動", onClick: () => (ui.select([other.id]), app.view.centerOn(other.id, { onlyIfHidden: true })) }, h("span", { class: `type-chip type-${other.type}` }, icon(other.type, 12)), h("span", { class: "conn-title" }, other.title || "（無題）")),
        h("button", { class: "conn-rel", type: "button", title: `${relMeta.label}${e.condition ? `: ${e.condition}` : ""}（接続を選ぶ）`, style: { "--rel": relMeta.color }, onClick: () => ui.select([], [eid]) }, h("span", { class: "dot", style: { background: relMeta.color } }), probLabel(e, relMeta.label)),
      );
      if (vm.index.cross.has(eid)) row.classList.add("cross");
      return row;
    };
    // 出る線の見込みの合計が 100% でない: 割って数えていることを言う（つながりの 77% と結果の 46% が並んで見える: 見直し R6）
    const outSum = sumOfProbs(outs.map((x) => doc.edges[x]).filter((x): x is GEdge => !!x));
    if (outSum !== null) conns.append(h("div", { class: "muted small conn-prob-note" }, `出る線の見込みは合わせて ${outSum}%。100% になるように割って数えている（かっこの中が数えている見込み）`));
    if (!ins.length && !outs.length) conns.append(h("div", { class: "muted small" }, "まだつながりがありません。ノード右の ● をドラッグして別のノードへつなぐか、「分岐を追加」で先を作れます。"));
    if (ins.length) conns.append(h("div", { class: "conn-head" }, `入る ${ins.length}`), ...ins.map((e) => connRow(e, "in")));
    if (outs.length) conns.append(h("div", { class: "conn-head" }, `出る ${outs.length}`), ...outs.map((e) => connRow(e, "out")));
    if (ins.length >= 2) conns.prepend(h("div", { class: "merge-note" }, icon("merge", 13), `${ins.length} つの道がここで合流しています`));
    }
    addChild.disabled = ro();
    addTwo.disabled = ro();
    dupBtn.disabled = ro();
    delBtn.disabled = ro();
    syncCol();
    if (footSeen.changed([n.createdAt, n.updatedAt])) foot.textContent = `作成 ${dayFormat.format(new Date(n.createdAt))} · 更新 ${stampFormat.format(new Date(n.updatedAt))}`;
  };

  return {
    lowerLater(): void {
      if (!impact || lowerTimer) return;
      wrap.classList.add("insp-lower-later");
      lowerTimer = setTimeout(() => {
        lowerTimer = 0;
        deepBlock?.update();
        impact?.fillLater();
        updateLower();
        wrap.classList.remove("insp-lower-later");
        // 置いていなかった間は高さを測れない
        fitHeight(bodyTa);
      }, 0);
    },
    retarget(next: ID, again = false): void {
      if (next === id && !again) return;
      id = next;
      // 前のカードの書きかけ（Enter で入れる前の条件・タグ）は持ち越さない（前は欄ごと作り直して消えていた）
      condAdd.value = "";
      tagInput.value = "";
      for (const r of condRows.values()) r.row.remove();
      condRows.clear();
      colShown = null;
      for (const seen of [projLineSeen, tagSeen, tagListSeen, chipSeen, connSeen, footSeen]) seen.reset();
      fitSeen.delete(title);
      fitSeen.delete(bodyTa);
      mountBlocks();
    },
  };
}

/** 見込みのある線の兄弟（同じノードから出る道の線）。見込みの合計が 100% でなければ、その合計（ちょうど 100% か見込みが 1 つも無ければ null） */
function sumOfProbs(edges: readonly GEdge[]): number | null {
  const known = edges.filter((e) => isFlowEdge(e)).map(edgeProb).filter((v): v is number => v !== null);
  if (known.length < 2) return null;
  const sum = Math.round(known.reduce((n, v) => n + v, 0));
  return sum === 100 ? null : sum;
}

// ------------------------------------------------------------ 接続

function edgePanel(app: AppContext, id: ID, root: HTMLElement, push: (u: Updater) => void): void {
  const { store, cmd, ui, vm } = app;
  const edge = () => store.doc.edges[id];
  const ro = () => store.readOnly;
  const wrap = h("div", { class: "insp-edge" });
  root.append(wrap);

  const ends = h("div", { class: "edge-ends" });
  wrap.append(ends);

  const relGrid = h("div", { class: "rel-grid", role: "radiogroup", ariaLabel: "関係" });
  const relBtns = RELATION_ORDER.map((r) => {
    const meta = RELATIONS[r];
    const b = h("button", { class: "rel-opt", type: "button", role: "radio", title: meta.hint, style: { "--rel": meta.color } }, h("span", { class: `rel-line rel-${r}` }), h("span", { class: "rel-name" }, meta.label), h("span", { class: "rel-hint" }, meta.hint));
    b.addEventListener("click", () => cmd.setRelation([id], r));
    relGrid.append(b);
    return { r, b };
  });
  wrap.append(sectionEl("関係", relGrid));

  const cond = h("textarea", { class: "input insp-text edge-condition", placeholder: "例: 副業の月収 30 万円が 3 か月続いたら", dataset: { fk: "edge-cond" }, attrs: { rows: "2", "aria-label": "条件" } });
  bindText(app, cond, (v) => cmd.updateEdge(id, { condition: v }, { label: "条件を編集", coalesce: `econd:${id}` }));
  wrap.append(sectionEl("条件（この道に進む条件）", cond));

  // 見込み（%）: 分かれ道から出る線に付ける。未来の道筋の「ここに至る見込み」の計算に使う
  const prob = h("input", { class: "input input-sm edge-prob", type: "number", dataset: { fk: "edge-prob" }, attrs: { min: "0", max: "100", step: "1", inputmode: "numeric", "aria-label": "見込み（%）", placeholder: "例: 30" } });
  // 欄を離れる・Enter で入れる。それまでの書きかけ（今の見込みと違う・読めない数）は入れ終わっていない入力
  unsaved.set(prob, () => {
    const e = edge();
    const p0 = e ? edgeProb(e) : null;
    return prob.validity.badInput || prob.value.trim() !== (p0 === null ? "" : String(p0));
  });
  const probSum = h("span", { class: "prob-sum" });
  prob.addEventListener("change", () => {
    const e = edge();
    if (!e || ro()) return;
    const raw = prob.value.trim();
    const meta = { ...e.meta };
    if (raw === "") delete meta.prob;
    else {
      const v = Math.round(Number(raw));
      if (!Number.isFinite(v)) return;
      meta.prob = Math.max(0, Math.min(100, v));
    }
    cmd.updateEdge(id, { meta }, { label: "見込みを編集", coalesce: `eprob:${id}` });
  });
  const probSec = sectionEl("見込み（この道に進む見込み %）", h("div", { class: "prob-row" }, prob, h("span", { class: "prob-unit" }, "%"), probSum));
  const probTitle = probSec.querySelector(".insp-label")!;
  wrap.append(probSec);

  const label = h("input", { class: "input", placeholder: "例: 実績が営業材料になる", dataset: { fk: "edge-label" }, attrs: { "aria-label": "説明" } });
  bindText(app, label, (v) => cmd.updateEdge(id, { label: v }, { label: "説明を編集", coalesce: `elabel:${id}` }));
  wrap.append(sectionEl("説明", label));

  const scen = h("div", { class: "chip-row" });
  wrap.append(sectionEl("シナリオ（この道を通るシナリオ）", scen));

  const collapse = h("input", { type: "checkbox", class: "switch", attrs: { "aria-label": "この先を折りたたむ" } });
  collapse.addEventListener("change", () => cmd.toggleEdgeCollapse(id));
  wrap.append(sectionEl("表示", h("label", { class: "switch-row" }, collapse, h("span", null, "この線の先を折りたたむ"))));

  const crossNote = h("div", { class: "cross-note" });
  wrap.append(crossNote);

  const rev = h("button", { class: "btn btn-sm", type: "button", onClick: () => cmd.reverseEdge(id) }, icon("swap", 14), "向きを反転");
  const del = h("button", { class: "btn btn-sm btn-danger-ghost", type: "button", onClick: () => cmd.deleteNodes([], [id]) }, icon("trash", 14), "削除");
  wrap.append(h("div", { class: "insp-actions" }, rev, del));

  push(() => {
    const e = edge();
    if (!e) return;
    const doc = store.doc;
    const meta = RELATIONS[e.relation];
    wrap.style.setProperty("--rel-color", meta.color);
    clear(ends);
    const endBtn = (nid: ID) => {
      const n = doc.nodes[nid]!;
      return h("button", { class: "edge-end", type: "button", title: "このノードを選ぶ", onClick: () => (ui.select([nid]), app.view.centerOn(nid, { onlyIfHidden: true })) }, h("span", { class: `type-chip type-${n.type}` }, icon(n.type, 12)), h("span", { class: "edge-end-title" }, n.title || "（無題）"));
    };
    ends.append(endBtn(e.source), h("span", { class: "edge-arrow", style: { color: meta.color } }, icon("arrowRight", 18, 2)), endBtn(e.target));
    for (const { r, b } of relBtns) {
      b.classList.toggle("active", r === e.relation);
      b.setAttribute("aria-checked", String(r === e.relation));
      b.disabled = ro();
    }
    setValue(cond, e.condition);
    fitHeight(cond);
    // 見込みは分かれ道から出る線か、すでに見込みのある線にだけ出す。
    // 3 年の分かれ道の中では、結果の線（選択肢から出る線）に出し、判断の線の % は使わない（あれば、そう伝えて消せるように残す）
    const p0 = edgeProb(e);
    const impKind = e.relation === "leads" || e.relation === "condition" ? impactEdgeKind(app, e.source) : null;
    const fromBranch = impKind === null && doc.nodes[e.source]?.type === "branch";
    probSec.hidden = impKind === "decision" ? p0 === null : impKind === "chance" ? false : !fromBranch && p0 === null;
    probTitle.textContent = impKind === "chance" ? "見込み（この結果になる見込み %）" : "見込み（この道に進む見込み %）";
    if (document.activeElement !== prob) prob.value = p0 === null ? "" : String(p0);
    prob.disabled = ro();
    if (fromBranch || impKind === "chance") {
      const sibs = (vm.index.out.get(e.source) ?? []).map((x) => doc.edges[x]!).filter((x) => x.relation === "leads" || x.relation === "condition");
      const total = sibs.reduce((n, x) => n + (edgeProb(x) ?? 0), 0);
      const missing = sibs.filter((x) => edgeProb(x) === null).length;
      if (impKind === "chance" && sibs.length > 1 && missing === sibs.length) probSum.textContent = "見込み（%）が入っていません（等分で計算中）";
      else probSum.textContent = `${impKind === "chance" ? "この手の結果の合計" : "この分かれ道の合計"} ${total}%${missing ? `（見込みの無い線 ${missing} 本には残りを等分）` : ""}`;
      probSum.dataset.tone = (!missing && total !== 100) || (impKind === "chance" && missing === sibs.length && sibs.length > 1) ? "warn" : "ok";
    } else if (impKind === "decision") {
      probSum.textContent = "判断の線なので % は使いません（選んだ手で計算します）";
      probSum.dataset.tone = "warn";
    } else probSum.textContent = "";
    setValue(label, e.label);
    cond.disabled = ro();
    label.disabled = ro();
    collapse.checked = e.collapsed;
    collapse.disabled = ro();
    clear(scen);
    scen.append(chipToggle("全シナリオ共通", null, e.scenarioIds.length === 0, () => cmd.setScenarioOf({ edges: [id] }, null), { disabled: ro() }));
    for (const sid of doc.scenarioOrder) {
      const s = doc.scenarios[sid];
      if (s) scen.append(chipToggle(s.name, s.color, e.scenarioIds.includes(sid), () => cmd.setScenarioOf({ edges: [id] }, sid), { disabled: ro() }));
    }
    const a = doc.nodes[e.source]!;
    const b = doc.nodes[e.target]!;
    if (vm.index.cross.has(id)) {
      const pa = a.projectIds.map((p) => doc.projects[p]?.name).filter(Boolean).join("・");
      const pb = b.projectIds.map((p) => doc.projects[p]?.name).filter(Boolean).join("・");
      crossNote.hidden = false;
      clear(crossNote);
      crossNote.append(icon("link", 14), h("span", null, `プロジェクトをまたぐ影響: ${pa} → ${pb}`));
    } else crossNote.hidden = true;
    rev.disabled = ro();
    del.disabled = ro();
  });
}

// ------------------------------------------------------------ 複数選択

function multiPanel(app: AppContext, root: HTMLElement, push: (u: Updater) => void, pushView: (u: Updater) => void): void {
  const { store, cmd, ui, vm } = app;
  const ids = () => [...ui.selection.nodes].filter((id) => store.doc.nodes[id]);
  const edges = () => [...ui.selection.edges].filter((id) => store.doc.edges[id]);
  const ro = () => store.readOnly;
  const wrap = h("div", { class: "insp-multi" });
  root.append(wrap);
  const head = h("div", { class: "multi-head" });
  const summary = h("div", { class: "type-summary" });
  wrap.append(head, summary);
  // 3 か月ごとの地図のカードを選んでいれば「選んだ M 枚の先をひらく」を頭に（まとめて開く C）
  const bulk = buildDeepMultiOpen(app);
  wrap.append(bulk.el);
  push(() => bulk.update());
  pushView(() => bulk.update());

  const mergeBtn = h("button", { class: "btn btn-primary btn-block", type: "button", title: "選んだノードからの道を 1 つのノードに合流させる", onClick: () => cmd.mergeInto(ids()) }, icon("merge", 15), "合流ノードを作る");
  const mergeHint = h("p", { class: "muted small" }, "選んだすべてのノードから、新しい「結果」ノードへ線を引きます。既存のノードへ合流させるときは、ノード右の ● をそのノードへドラッグします（複数選択中は全部から線が出ます）。");
  wrap.append(sectionEl("合流", mergeBtn, mergeHint));

  wrap.append(sectionEl("種類", typePicker(app, () => {
    const ts = new Set(ids().map((id) => store.doc.nodes[id]!.type));
    return ts.size === 1 ? [...ts][0]! : null;
  }, (t) => cmd.setType(ids(), t), push)));

  const status = statusSelect(app, () => {
    const ss = new Set(ids().map((id) => store.doc.nodes[id]!.status));
    return ss.size === 1 ? [...ss][0]! : null;
  }, (s) => cmd.setStatus(ids(), s), push);
  wrap.append(sectionEl("状態", status));

  const projChips = h("div", { class: "chip-row" });
  wrap.append(sectionEl("プロジェクト", projChips));

  const tagInput = h("input", { class: "input input-sm", placeholder: "まとめてタグを追加（Enter）", dataset: { fk: "tag-add" }, attrs: { "aria-label": "タグを追加" } });
  unsaved.set(tagInput, () => !!tagInput.value.trim());
  tagInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !isImeKey(ev) && tagInput.value.trim()) {
      cmd.addTag(ids(), tagInput.value);
      tagInput.value = "";
    }
  });
  wrap.append(sectionEl("タグ", tagInput));

  const alignH = h("button", { class: "btn btn-sm", type: "button", onClick: () => cmd.align(ids(), "h") }, icon("minus", 14), "横にそろえる");
  const alignV = h("button", { class: "btn btn-sm", type: "button", onClick: () => cmd.align(ids(), "v") }, icon("pause", 14), "縦にそろえる");
  wrap.append(sectionEl("並べる", h("div", { class: "btn-row" }, alignH, alignV)));

  const dup = h("button", { class: "btn btn-sm", type: "button", onClick: () => cmd.duplicate(ids()) }, icon("copy", 14), "複製");
  const colLabel = h("span", null, "折りたたむ");
  const col = h("button", { class: "btn btn-sm", type: "button", title: "この先を折りたたむ（C）", onClick: () => cmd.toggleCollapse(ids()) }, icon("collapse", 14), colLabel);
  const del = h("button", { class: "btn btn-sm btn-danger-ghost", type: "button", onClick: () => cmd.deleteSelection() }, icon("trash", 14), "削除");
  wrap.append(h("div", { class: "insp-actions" }, dup, col, del));
  /**
   * 折りたたむ・展開する: C・右クリックのメニューと同じ決まり。開閉する物（3 年の分かれ道は同じ範囲の子のあるカード）が無ければ押せず、
   * 向きは開閉する物だけで決める（先の無いカードを混ぜて選んでも、閉じたカードには「展開する」）。3 年の分かれ道のカードだけなら
   * 見え方の開閉なので閲覧のみでも使える。キャンバスでの開閉（見え方だけの変更）にも合わせる
   */
  let colShown: boolean | null = null;
  const syncCol = () => {
    const ns = ids();
    const viewOnly = ns.every((id) => vm.inImpact(id));
    col.disabled = (ro() && !viewOnly) || !cmd.canToggleCollapse(ns);
    const collapsed = cmd.collapsedAll(ns);
    if (collapsed === colShown) return;
    colShown = collapsed;
    colLabel.textContent = collapsed ? "展開する" : "折りたたむ";
    col.title = collapsed ? "この先を展開する（C）" : "この先を折りたたむ（C）";
    col.replaceChild(icon(collapsed ? "expand" : "collapse", 14), col.firstElementChild!);
  };
  pushView(syncCol);

  push(() => {
    const ns = ids();
    const es = edges();
    const doc = store.doc;
    head.textContent = `${ns.length} 件のノード${es.length ? `・${es.length} 本の接続` : ""}を選択中`;
    clear(summary);
    for (const t of NODE_TYPE_ORDER) {
      const c = ns.filter((id) => doc.nodes[id]!.type === t).length;
      if (c) summary.append(h("span", { class: `type-count type-${t}` }, icon(t, 12), `${NODE_TYPES[t].label} ${c}`));
    }
    mergeBtn.disabled = ro() || ns.length < 2;
    clear(projChips);
    for (const pid of doc.projectOrder) {
      const p = doc.projects[pid];
      if (!p) continue;
      const k = ns.filter((id) => doc.nodes[id]!.projectIds.includes(pid)).length;
      projChips.append(chipToggle(p.name, p.color, k === ns.length && k > 0, () => cmd.toggleProjectOf(ns, pid), { partial: k > 0 && k < ns.length, disabled: ro() || !ns.length, title: k > 0 && k < ns.length ? `${k}/${ns.length} 件が所属` : undefined }));
    }
    for (const b of [alignH, alignV]) b.disabled = ro() || ns.length < 2;
    dup.disabled = ro() || !ns.length;
    syncCol();
    del.disabled = ro();
    tagInput.disabled = ro() || !ns.length;
  });
}

// ------------------------------------------------------------ 何も選んでいない

/** 未来の道筋（v1）の分かれ道の数（見込みの結果ごとに 1 回数える） */
const forkCounts = new WeakMap<object, number>();
function forkCount(fc: { reach: ReadonlyMap<ID, unknown> }, doc: { nodes: Record<ID, GNode> }): number {
  let c = forkCounts.get(fc);
  if (c === undefined) {
    c = 0;
    for (const id of fc.reach.keys()) if (doc.nodes[id]?.type === "branch") c++;
    forkCounts.set(fc, c);
  }
  return c;
}

function overviewPanel(app: AppContext, root: HTMLElement, push: (u: Updater) => void, pushView: (u: Updater) => void): void {
  const { store, vm, ui } = app;
  const wrap = h("div", { class: "insp-overview" });
  root.append(wrap);
  const stats = h("div", { class: "stat-grid" });
  const bars = h("div", { class: "type-bars" });
  const insight = h("div", { class: "insight" });
  // 3 か月ごとの地図（版 7）: 3 年の見取り図を先頭に（作業メモ SPEC v1 §5.1）
  const deep = buildDeepOverview(app);
  // 3 年の分かれ道（v2）: 3 年の影響・今決めること・分布・行き先（あれば下の「行き先の見込み」の代わり）
  const impact = buildImpactOverview(app);
  // 開閉（見え方だけ）で、今日の「この先をひらく」の枚数を合わせる（文書の変更は届かない）
  pushView(() => impact.updateOpen());
  // 未来の道筋: 行き先（その先が無いノード）の見込み
  const ends = h("div", { class: "forecast-ends" });
  // 今日から開く（まとめて開く）は見取り図のすぐ後（3 年の影響の数の前。概要の先頭は見取り図: SPEC §5.1。見直し reader-2）
  wrap.append(deep.el, impact.openEl, impact.el, ends, stats, bars, insight);
  wrap.append(
    h(
      "div",
      { class: "hint-card" },
      h("h3", { class: "insp-label" }, "使い方"),
      h(
        "ul",
        { class: "hint-list" },
        h("li", null, h("b", null, "作る: "), "空いている所をダブルクリック／上の ＋"),
        h("li", null, h("b", null, "つなぐ: "), "ノード右の ● を別のノードへドラッグ"),
        h("li", null, h("b", null, "分岐: "), "● を空いている所で離す／", h("kbd", null, "Tab")),
        h("li", null, h("b", null, "合流: "), "⇧クリックで複数選び「合流ノードを作る」"),
        h("li", null, h("b", null, "動かす: "), "ドラッグ・2 本指スクロール・ピンチ"),
        h("li", null, h("b", null, "戻す: "), h("kbd", null, `${MOD}Z`), " ／ やり直す ", h("kbd", null, `${MOD}⇧Z`)),
      ),
      h("button", { class: "btn btn-sm", type: "button", onClick: () => app.startTour() }, icon("help", 14), "操作ガイドを見る"),
    ),
  );
  // 数はどれも索引から（文書をなめない。作業メモ perf-4・gaps-8）。プロジェクトをまたぐノードは見え方の計算が覚えている物
  push(() => {
    const doc = store.doc;
    const idx = vm.index;
    deep.update();
    const impactShown = impact.update();
    clear(ends);
    // 見込みの行き先は 3 年の影響を出していないときだけ（出しているときは見込みの計画を作らない: 8 万枚の地図の起動を待たせない。見直し perf-7）
    const fc = impactShown ? null : vm.forecast;
    ends.hidden = !fc || !fc.active || !fc.ends.length;
    if (fc && fc.active && fc.ends.length) {
      const sid = ui.prefs.scenarioId;
      const scen = sid ? doc.scenarios[sid] : undefined;
      const forks = forkCount(fc, doc);
      ends.append(
        h("h3", { class: "insp-label" }, "行き先の見込み", scen ? h("span", { class: "insp-count" }, `${scen.name}を選んだ場合`) : null),
        h("div", { class: "muted small forecast-sub" }, `今日から最長 ${fc.longest} 歩・分かれ道 ${forks} 個。線の % を直すと計算し直します`),
      );
      const LIMIT = 14;
      for (const id of fc.ends.slice(0, LIMIT)) {
        const n = doc.nodes[id]!;
        const p = fc.reach.get(id)!.p;
        ends.append(
          h(
            "button",
            { class: "end-row", type: "button", title: `${n.title}（${formatPercent(p)}）へ移動`, onClick: () => (ui.select([id]), app.view.centerOn(id)) },
            h("span", { class: `type-chip type-${n.type}` }, icon(n.type, 12)),
            h("span", { class: "end-title" }, n.title || "（無題）"),
            h("span", { class: "end-bar", style: { "--w": `${Math.max(2, Math.round(p * 100))}%` } }),
            h("span", { class: "end-pct" }, formatPercent(p)),
          ),
        );
      }
      if (fc.ends.length > LIMIT) ends.append(h("div", { class: "muted small" }, `ほか ${fc.ends.length - LIMIT} か所`));
    }
    clear(stats);
    const stat = (label: string, value: number, hint: string, iconName: string) => h("div", { class: "stat", title: hint }, h("span", { class: "stat-icon" }, icon(iconName, 14)), h("span", { class: "stat-value" }, value.toLocaleString("ja-JP")), h("span", { class: "stat-label" }, label));
    stats.append(
      stat("ノード", idx.nodeCount, "目標・行動・分岐・結果", "layers"),
      stat("接続", idx.edgeCount, "方向と関係を持つ線", "link"),
      stat("共有ノード", idx.shared.size, "2 つ以上のプロジェクトに属するノード", "merge"),
      stat("プロジェクト間の線", idx.cross.size, "別のプロジェクトへ影響する線", "sparkle"),
    );
    clear(bars);
    const total = Math.max(1, idx.nodeCount);
    for (const t of NODE_TYPE_ORDER) {
      const c = idx.typeCounts[t] ?? 0;
      bars.append(
        h(
          "div",
          { class: `type-bar type-${t}` },
          h("span", { class: "type-bar-label" }, icon(t, 13), NODE_TYPES[t].label),
          h("span", { class: "type-bar-track" }, h("span", { class: "type-bar-fill", style: { width: `${(c / total) * 100}%` } })),
          h("span", { class: "type-bar-count" }, String(c)),
        ),
      );
    }
    // いちばん多くのプロジェクトに効いている行動（相乗効果の目安。計算はせず、所属と線の数だけ）。3 年の分かれ道のカードは除く
    // （地図のカードはどれも 3 つの領域に属する。見え方の計算が形・所属の版ごとに覚えている）
    clear(insight);
    const hubs = vm
      .hubs(3)
      .map((id) => doc.nodes[id])
      .filter((n): n is GNode => !!n)
      .map((n) => ({ n }));
    if (hubs.length) {
      insight.append(h("h3", { class: "insp-label" }, "プロジェクトをまたぐノード"));
      for (const x of hubs) {
        const btn = h(
          "button",
          { class: "hub-row", type: "button", onClick: () => (ui.select([x.n.id]), app.view.centerOn(x.n.id)) },
          h("span", { class: `type-chip type-${x.n.type}` }, icon(x.n.type, 12)),
          h("span", { class: "hub-title" }, x.n.title || "（無題）"),
          h("span", { class: "hub-dots" }, ...x.n.projectIds.map((p) => doc.projects[p]).filter((p) => !!p).map((p) => h("span", { class: "dot", style: { background: p!.color } }))),
        );
        insight.append(btn);
      }
    }
  });
}

export type { GEdge };
