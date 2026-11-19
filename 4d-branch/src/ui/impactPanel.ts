// 右のパネルの「3 年の影響」（未来の道筋 v2「3 年の分かれ道」）。設計: docs/DESIGN.md §4.7
//   概要（何も選んでいないとき）: 見出しと年収・今決めること・3 年でやる価値が大きい手・避けたい手・この先の大事な判断・
//   3 年後の分布・3 年後の行き先・前提・見方
//   詳細（選んだノード）: 選択肢なら 3 年の影響・選ぶ／見送る・内訳・結果・同じ判断の手。結果・行き先なら見込み・その時の状態・目印
// 数は vm.impact（src/model/impact.ts）を読むだけ。順位は src/model/impactRank.ts。文は src/model/impactText.ts。
// 中身は数が変わったとき（vm.impact が新しくなったとき）と、書いた題名・線の文が変わったときだけ作り直す。年収の欄は作り直さない（入力中に消さない）。
// キーボードで操作しているときは、作り直した後もフォーカスのあった部品（data-fk の鍵）か代わりの部品へ戻す
// （体に落とすと、次の Tab・Backspace がキャンバスの操作になる）。マウス・タッチで押して作り直したときは、押した部品へは戻さず、
// パネルの入れ物（tabindex=-1）に置く（続く Enter・Space で黙って選ばず、Tab・Backspace もキャンバスへ届かない）

import type { AppContext } from "../app/context";
import { futureData } from "../demo/futureBundle";
import { formatPercent } from "../model/forecast";
import { IMPACT_ANNUAL_MAX, IMPACT_ANNUAL_MIN, IMPACT_DEFAULT_ANNUAL, IMPACT_STAR_LEAD, IMPACT_STAR_SHARE, type AltInfo, type ImpactResult, type SalaryFlips } from "../model/impact";
import { formatMan, formatShare, IMPACT_FILL, IMPACT_INK, IMPACT_NEUTRAL_RING, impactBin } from "../model/impactFormat";
import { cachedWorthRanking, famLabel, hasFamLabel, keyDecisions } from "../model/impactRank";
import {
  altMetaParts,
  areaOf,
  binRangeText,
  breakdownAreas,
  divergingBar,
  divergingDomain,
  flipTexts,
  formatManStep,
  headlineOf,
  horizonText,
  hoursText,
  metaSep,
  NO_LINE,
  parseAnnual,
  projectArea,
  riskText,
  splitExact,
  stateLine,
  trailOf,
  yen,
  ymAfter,
  ymText,
  type AreaInfo,
} from "../model/impactText";
import type { DocData, GEdge, ID } from "../model/types";
import { isNarrowScreen } from "./breakpoints";
import { clear, h, isImeKey } from "./dom";
import { icon } from "./icons";
import { modalOpen, toast } from "./overlays";

type Domain = { lo: number; hi: number };
type Child = Node | string | null;

const pct = (x: number): string => `${(Math.max(0, Math.min(1, x)) * 100).toFixed(2)}%`;
const fill = (bin: number): string => IMPACT_FILL[bin] ?? IMPACT_FILL[0]!;

function groupDigits(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 選んでいる方針（シナリオ）の名前。選んでいなければ null */
function scenarioName(app: AppContext): string | null {
  const sid = app.ui.prefs.scenarioId;
  return (sid && app.store.doc.scenarios[sid]?.name) || null;
}

/** 今の選び方の名前（「おすすめの選び方」「あなたの選び方」「早期独立の方針」） */
function whoText(app: AppContext, imp: ImpactResult): string {
  const scen = scenarioName(app);
  return scen ? `${scen}の方針` : imp.hasPicks ? "あなたの選び方" : "おすすめの選び方";
}

// ------------------------------------------------------------ おすすめの値（自分で選んだ手・方針を外した 3 年の稼ぎ）

/**
 * おすすめの選び方での 3 年の稼ぎ。自分で選んだ手（進行中・完了）も方針も無ければ今の値そのもの。
 * あれば、選んだ手を外し（見送りはそのまま）方針でも絞らない 1 回の計算（エンジンが結果ごとに覚える。作業メモ perf-5）
 */
function recommendedValue(imp: ImpactResult, scenario: boolean): number | null {
  if (!imp.hasPicks && !scenario) return imp.vRoot;
  return imp.recommended();
}

// ------------------------------------------------------------ 書いた文の元・フォーカス

const edgeText = (e: GEdge | undefined): string => (e ? `${e.label}\u0000${e.condition}` : "");

/**
 * 書いた題名・線の文の元。題名の入力など、数を計算し直さない文字だけの変更でも、書いた所が変わっていたら作り直す
 * （書いていないノードの題名の入力では作り直さない）
 */
class Seen {
  private readonly nodes = new Map<ID, string>();
  private readonly edges = new Map<ID, string>();

  /** ノードの題名（無ければ空）。書いた物として覚える */
  title(doc: DocData, id: ID): string {
    const t = doc.nodes[id]?.title ?? "";
    this.nodes.set(id, t);
    return t;
  }

  /** 線（説明と条件を書く物として覚える） */
  edge(doc: DocData, id: ID): GEdge | undefined {
    const e = doc.edges[id];
    this.edges.set(id, edgeText(e));
    return e;
  }

  /** 書いた後に、題名・線の文が変わったか */
  changed(doc: DocData): boolean {
    for (const [id, t] of this.nodes) if ((doc.nodes[id]?.title ?? "") !== t) return true;
    for (const [id, t] of this.edges) if (edgeText(doc.edges[id]) !== t) return true;
    return false;
  }
}

/** 押せる・入れられる部品 */
const FOCUSABLE = "button, input, select, textarea, summary, a[href]";

const canFocus = (el: HTMLElement): boolean => !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0;

/** 最後にマウス・タッチで押した所。キーを押したら消す（その後のフォーカスはキーボードで動かした物） */
let pointed: Node | null = null;
if (typeof document !== "undefined") {
  document.addEventListener("pointerdown", (ev) => (pointed = ev.target instanceof Node ? ev.target : null), true);
  document.addEventListener("keydown", () => (pointed = null), true);
}

/** マウス・タッチで root の中を押した後で、まだキーを押していないか */
const pointerIn = (root: Node): boolean => !!pointed && root.contains(pointed);

/**
 * キーボード（や読み上げ）で操作しているフォーカスか。マウス・タッチで押して移ったフォーカスは false
 * （そのときはフォーカスを動かさない。押すと決まるボタンへ黙って移すと、続く Enter・Space で知らないうちに選んでしまう）
 */
export function keyboardFocus(el: Element | null): el is HTMLElement {
  return el instanceof HTMLElement && !pointerIn(el);
}

/** 最初の押せる部品へフォーカスを移す。移せたら true */
function focusFirst(root: ParentNode): boolean {
  for (const el of root.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (!canFocus(el)) continue;
    el.focus();
    if (document.activeElement === el) return true;
  }
  return false;
}

/** root の中の部品をキーボードで操作していれば、その部品の鍵（data-fk。鍵の無い部品は ""）。していなければ null */
function focusKeyIn(root: HTMLElement): string | null {
  const a = document.activeElement;
  return keyboardFocus(a) && root.contains(a) ? (a.dataset.fk ?? "") : null;
}

/** 右のパネルのフォーカスの置き場（作り直しても残る。tabindex=-1・高さ 0。src/ui/inspector.ts） */
const panelPark = (): HTMLElement | null => document.querySelector<HTMLElement>(".sidebar-right .insp-focus-park");
/** 右のパネルの中身の入れ物（押したのがパネルの中か） */
const panelBox = (): HTMLElement | null => document.querySelector<HTMLElement>(".sidebar-right .insp-body-scroll");

/**
 * フォーカスが体に落ちているか（押した部品が作り直しで消えた・隠れた）。隠した部品は、ブラウザが体へ移すまで少しの間フォーカスを持ったままなので、
 * 描かれていない部品にあるときも落ちたとみなす
 */
export function focusLost(): boolean {
  const a = document.activeElement;
  return !a || a === document.body || !a.isConnected || !a.getClientRects().length;
}

/**
 * フォーカスが体に落ちていたら、右のパネルの入れ物に置く。続く Enter・Space は何も押さず、Tab はパネルの最初の部品へ進み、
 * Tab・Backspace・Delete・文字のキーはキャンバス（選んだカード）へ届かない。閉じたパネル（見えない引き出し）には置かない
 */
function parkFocus(): void {
  if (!focusLost()) return;
  const box = panelBox();
  const park = panelPark();
  if (box && park && box.getClientRects().length && getComputedStyle(box).visibility !== "hidden") park.focus({ preventScroll: true });
}

/**
 * パネルの部品を押したときの操作（run）。マウス・タッチで押して、作り直しで押した部品が消えたら、フォーカスをパネルの入れ物に置く
 * （押すと決まるボタンへは移さない。体に落とすと、次の Tab が分岐を足し、Backspace が選んだ手を消す）。
 * キーボードで押したときは、今までどおり作り直しの中で同じ部品か代わりの部品へ戻す
 */
function pressed(run: () => void): void {
  const box = panelBox();
  const byPointer = !!box && pointerIn(box);
  run();
  if (byPointer) parkFocus();
}

/** 今押している「これにする」「見送る」の鍵（押した後の作り直しでだけ「選び直す」へ移す。ほかの変更で作り直しても同じ部品に残す） */
let pressing: string | null = null;

function press(key: string, run: () => void): void {
  pressing = key;
  try {
    pressed(run);
  } finally {
    pressing = null;
  }
}

/**
 * 作り直した後に、前にフォーカスのあった部品（鍵が同じ物）へ戻す。押して用が済んだ・押せなくなった・無くなった部品は代わりへ
 * （「これにする」「見送る」を押した後は「選び直す」、「選び直す」「これを基準にする」の後は「これにする」、それも無ければ最初の部品）。
 * 戻せたら true（root に押せる部品が 1 つも無いときは false）
 */
function refocus(root: HTMLElement, key: string): boolean {
  const at = (k: string) => (k ? root.querySelector<HTMLElement>(`[data-fk="${CSS.escape(k)}"]`) : null);
  const i = key.indexOf(":");
  const kind = i < 0 ? key : key.slice(0, i);
  const id = key.slice(i + 1);
  const keys = [key];
  if ((kind === "pick" || kind === "drop") && key === pressing && at(key)?.getAttribute("aria-pressed") === "true") keys.unshift(`redo:${id}`);
  if (kind === "redo" || kind === "base") keys.push(`pick:${id}`);
  for (const k of keys) {
    const el = at(k);
    if (el && canFocus(el)) {
      el.focus();
      if (document.activeElement === el) return true;
    }
  }
  return focusFirst(root);
}

// ------------------------------------------------------------ 移動

/**
 * そのノードを出して選び、地図ならそこへ寄る（closeDrawer: 狭い画面では右のパネルを閉じてカードを見せる）。
 * キーボードでパネルの行を押したときは、引き出しを開いたまま、選んだノードの詳細（3 年の影響）の最初の部品へフォーカスを移す
 * （体に落とすと、次の Tab・Backspace がキャンバスの操作になる）。マウス・タッチで押したときは、パネルの入れ物に置く
 * （押すと決まる部品へは移さない。続く Enter・Space で黙って選ばず、Tab・Backspace もキャンバスへ届かない）。
 * 狭い画面で引き出しを閉じたときは置かない（見えない引き出しに残さない。続くキーは、寄って見えている選んだカードへ）
 */
function goTo(app: AppContext, id: ID, closeDrawer: boolean): void {
  if (!app.store.doc.nodes[id]) return;
  const panel = document.querySelector<HTMLElement>(".sidebar-right");
  const active = document.activeElement;
  const byPointer = !!panel && pointerIn(panel);
  const from = panel && !byPointer && active instanceof HTMLElement && panel.contains(active) ? active : null;
  app.cmd.revealNode(id);
  app.ui.select([id]);
  const closing = closeDrawer && !from && isNarrowScreen() && app.ui.prefs.rightOpen;
  if (closing) app.ui.setPrefs({ rightOpen: false });
  if (app.ui.prefs.view === "map") app.view.centerOn(id);
  else app.revealInList(id);
  if (byPointer) {
    const a = document.activeElement;
    if (!closing) parkFocus();
    else if (panel && a instanceof HTMLElement && panel.contains(a)) a.blur();
    return;
  }
  // 同じノードを押してパネルが作り直されていなければ、そのまま
  if (!panel || !from || from.isConnected) return;
  const block = panel.querySelector<HTMLElement>(".imp-node:not([hidden])");
  if (!(block && focusFirst(block))) focusFirst(panel);
}

/** 「最初の形に戻す」（開いている所を既定に戻す操作）。まだ無ければ null */
function resetCommand(app: AppContext): ((root: ID | null) => void) | null {
  return () => app.cmd.resetImpactOpen();
}

// ------------------------------------------------------------ 部品

/** 差の札（塗りは段の色、文字は段ごとの色）。基準は「基準」、数が無ければ「—」 */
function deltaPill(delta: number | null, opts: { base?: boolean; partial?: boolean; text?: string; size?: "sm" | "lg" } = {}): HTMLElement {
  const size = opts.size ? ` imp-pill-${opts.size}` : "";
  if (opts.base) return h("span", { class: `imp-pill is-base${size}` }, "基準");
  if (delta === null || !Number.isFinite(delta)) return h("span", { class: `imp-pill is-none${size}`, title: "数字なし" }, "—");
  const bin = impactBin(delta);
  return h("span", { class: `imp-pill${bin === 0 ? " is-neutral" : ""}${size}`, style: { background: fill(bin), color: IMPACT_INK[bin] ?? "#F0EFEC" } }, opts.text ?? `${opts.partial ? "≈" : ""}${formatMan(delta)}`);
}

/** 差の棒（0 を軸に、良くなる手は右・悪くなる手は左へ。同じ範囲 d で描くので行どうしで比べられる） */
function diffBar(v: number | null, d: Domain): HTMLElement {
  const g = divergingBar(v ?? 0, d);
  const bar = h("span", { class: "imp-bar", attrs: { "aria-hidden": "true" } }, h("span", { class: "imp-bar-zero", style: { left: pct(g.zero) } }));
  if (v !== null && Number.isFinite(v) && Math.abs(v) >= 0.05) {
    const bin = impactBin(v);
    bar.append(h("span", { class: `imp-bar-fill ${v < 0 ? "is-neg" : "is-pos"}`, style: { left: pct(g.left), width: `max(2px, ${pct(g.width)})`, background: bin === 0 ? IMPACT_NEUTRAL_RING : fill(bin) } }));
  }
  return bar;
}

function areaChip(a: AreaInfo): HTMLElement {
  return h("span", { class: "imp-area", style: { "--c": a.color } }, a.label);
}

/** ★（おすすめ）・◎（おすすめ: q のある地図の一番良い手。★ でないとき）・≒（ほぼ同じ）・✓（選んだ手） */
function markOf(info: AltInfo): { text: string; label: string } {
  const marks: Array<[string, string]> = [];
  if (info.picked) marks.push(["✓", "選んだ手"]);
  if (info.mark === "star") marks.push(["★", "おすすめ"]);
  else if (info.rec) marks.push(["◎", "おすすめ"]);
  if (info.mark === "tie") marks.push(["≒", "ほぼ同じ"]);
  return { text: marks.map((m) => m[0]).join(""), label: marks.map((m) => m[1]).join("・") };
}

/** 印の部品の class（★ は金、◎ は控えめな金、✓ は緑） */
function markClass(info: AltInfo): string {
  return `imp-mark${info.mark === "star" ? " is-star" : info.rec ? " is-rec" : ""}${info.picked ? " is-picked" : ""}`;
}

const li = (...children: Child[]): HTMLElement => h("li", null, ...children);

/** 3 年の影響の大きい順（数の無い手は後ろ。同じなら今のまま、次に元の並び） */
function byDelta(imp: ImpactResult, ids: ID[]): ID[] {
  const pos = new Map(ids.map((id, i) => [id, i]));
  return [...ids].sort((a, b) => {
    const x = imp.alt.get(a)?.delta ?? null;
    const y = imp.alt.get(b)?.delta ?? null;
    if (x === null || y === null) return x === null && y === null ? pos.get(a)! - pos.get(b)! : x === null ? 1 : -1;
    if (Math.abs(x - y) > 1e-9) return y - x;
    const bx = imp.alt.get(a)?.isBase ? 1 : 0;
    const by = imp.alt.get(b)?.isBase ? 1 : 0;
    return by - bx || pos.get(a)! - pos.get(b)!;
  });
}

/**
 * 選択肢の行: ★・領域・タイトル・差の札 / 差の棒 / 悪くなる見込み・3 年後の月・週の時間。
 * 狭い画面では、タイトルを短い名前（meta.short）の 1 行にし、差の棒と 2 行目を 1 行に詰める（impact.css）
 */
function altRow(app: AppContext, imp: ImpactResult, id: ID, d: Domain, seen: Seen, opts: { current?: boolean; onGo: (id: ID) => void }): HTMLElement | null {
  const doc = app.store.doc;
  const n = doc.nodes[id];
  const info = imp.alt.get(id);
  if (!n || !info) return null;
  const area = areaOf(n, doc);
  const mark = markOf(info);
  const hours = typeof n.meta?.h === "number" && Number.isFinite(n.meta.h) ? (n.meta.h as number) : null;
  // 2 行目: 部品ごとに折り返さない（「月+3.4万」の途中で切らない。部品のあいだでだけ折り返す）
  const parts: Array<{ text: string; keep: boolean }> = [];
  if (info.dropped || !info.allowed) parts.push({ text: [info.dropped ? "見送り" : "", info.allowed ? "" : "方針の外"].filter(Boolean).join("・"), keep: true });
  if (info.isBase) parts.push({ text: "ほかの手は、これと比べた差", keep: false });
  else if (info.delta === null && imp.decision.get(info.decision)?.base === null) parts.push({ text: "基準（今のまま）が無いので差を出せません", keep: false });
  else if (info.delta === null) parts.push({ text: "数字なし（結果と見込みを足すと計算します）", keep: false });
  else for (const p of altMetaParts(info, hours)) parts.push({ text: p, keep: true });
  const meta = h("span", { class: "imp-alt-meta" });
  parts.forEach((p, i) => {
    if (i > 0) meta.append(metaSep(parts[i - 1]!.text));
    meta.append(h("span", { class: p.keep ? "imp-meta-part" : "" }, p.text));
  });
  const title = seen.title(doc, id) || "（無題）";
  const short = typeof n.meta?.short === "string" ? (n.meta.short as string).trim() : "";
  const value = info.isBase ? "基準" : info.delta === null ? "数字なし" : formatMan(info.delta);
  return h(
    "button",
    {
      class: `imp-alt-row${opts.current ? " is-current" : ""}${info.dropped ? " is-dropped" : ""}${info.allowed ? "" : " is-off"}`,
      type: "button",
      title: `${title}（${value}）${mark.label ? `・${mark.label}` : ""}`,
      dataset: { id, fk: `row:${id}` },
      attrs: { "aria-current": opts.current ? "true" : null },
      onClick: () => opts.onGo(id),
    },
    h("span", { class: markClass(info) }, mark.text),
    h(
      "span",
      { class: "imp-alt-title" },
      area ? areaChip(area) : null,
      h("span", { class: `imp-alt-name${short ? " has-short" : ""}` }, title),
      short ? h("span", { class: "imp-alt-short" }, short) : null,
    ),
    deltaPill(info.delta, { base: info.isBase, partial: info.partial }),
    diffBar(info.isBase ? 0 : info.delta, d),
    meta,
  );
}

/** 判断の選択肢の表（3 年の影響の順。差の棒は同じ範囲） */
function decisionList(app: AppContext, imp: ImpactResult, decisionId: ID, seen: Seen, opts: { current?: ID; closeDrawer: boolean }): HTMLElement {
  const list = h("div", { class: "imp-alt-list" });
  const dec = imp.decision.get(decisionId);
  if (!dec) return list;
  const ids = byDelta(imp, dec.alts);
  const d = divergingDomain(ids.map((id) => imp.alt.get(id)?.delta ?? null));
  for (const id of ids) {
    const row = altRow(app, imp, id, d, seen, { current: id === opts.current, onGo: (x) => goTo(app, x, opts.closeDrawer) });
    if (row) list.append(row);
  }
  return list;
}

/** これより小さい地図は、年収の境目をその場で数える（版 6 の 1,533 枚: 40 回ほどの計算で数 ms） */
const FLIP_SYNC_NODES = 4000;

/** 手が空いたときに 1 度呼ぶ（requestIdleCallback。無ければ次の番に） */
function whenIdle(fn: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(fn, { timeout: 300 });
  else setTimeout(fn, 0);
}

/**
 * 年収で今日の一番が入れ替わる所。大きい地図では、パネルを描いた後に、手が空いたときに逆にたどる計算 1 回ずつ進め、
 * その間は「計算中」の行を出す（作業メモ perf-8）。数が変わってパネルを作り直したら（この行が外れたら）、そこで止める
 */
function flipNote(app: AppContext, imp: ImpactResult, seen: Seen): HTMLElement {
  const body = h("div");
  const note = h("div", { class: "imp-flip" }, icon("swap", 13), body);
  const show = (f: SalaryFlips): void => {
    const lines = flipTexts(f, (id) => seen.title(app.store.doc, id) || "（無題）");
    if (!lines.length) lines.push("年収が 200〜1,000 万円のどこでも、いちばんの手は同じ");
    clear(body);
    body.append(...lines.map((l) => h("div", null, l)));
    note.classList.remove("is-busy");
    note.removeAttribute("aria-busy");
  };
  const ready = imp.salaryFlipsReady() ?? (imp.counts.nodes <= FLIP_SYNC_NODES ? imp.salaryFlips() : null);
  if (ready) {
    show(ready);
    return note;
  }
  body.append(h("div", { class: "imp-flip-wait" }, "年収で一番の手が入れ替わる所を計算中…"));
  note.classList.add("is-busy");
  note.setAttribute("aria-busy", "true");
  const step = (): void => {
    // 作り直した・数が変わった: やめる（次のパネルが自分で始める。同じ版なら途中から続く）
    if (!note.isConnected || app.vm.impact !== imp) return;
    const f = imp.salaryFlipsStep();
    if (f) show(f);
    else whenIdle(step);
  };
  whenIdle(step);
  return note;
}

// ------------------------------------------------------------ 年収

/** 「入れる」で概要の年収の欄を開く（概要を作ったときに差し替わる） */
let salaryFocus: (() => void) | null = null;

/** 年収を入れる（null なら仮に戻す）。入口の meta.impact.annual に置くので、元に戻せて、計算し直しになる */
function applyAnnual(app: AppContext, annual: number | null): void {
  const imp = app.vm.impact;
  const rootId = imp.root;
  const root = rootId ? app.store.doc.nodes[rootId] : undefined;
  if (!rootId || !root) return;
  if (annual === null ? !imp.annualSet : imp.annualSet && Math.abs(imp.annual - annual) < 1e-9) return;
  const cfg: Record<string, unknown> = { v: 2, horizon: imp.horizon, ...(root.meta.impact && typeof root.meta.impact === "object" ? (root.meta.impact as Record<string, unknown>) : {}) };
  if (annual === null) delete cfg.annual;
  else cfg.annual = annual;
  const ok = app.store.transact(annual === null ? "年収を仮に戻す" : `年収を ${groupDigits(annual)} 万円に`, (tx) => tx.updateNode(rootId, { meta: { ...root.meta, impact: cfg } }));
  if (ok && !app.store.readOnly) toast(annual === null ? `年収を仮（${IMPACT_DEFAULT_ANNUAL} 万円）に戻しました` : `年収（額面）を ${groupDigits(annual)} 万円にして計算し直しました`, { tone: "ok", action: app.cmd.undoAction() });
}

/** 「年収（額面）360 万円で計算中（仮）［変える］」と、その場で入れる欄 */
function salaryWidget(app: AppContext): { el: HTMLElement; update(imp: ImpactResult): void } {
  const value = h("b", { class: "imp-salary-value" });
  const kari = h("span", { class: "imp-kari" }, "（仮）");
  const change = h("button", { class: "imp-link imp-salary-change", type: "button", title: "年収（額面）を入れる・変える", dataset: { fk: "salary" } }, "変える");
  const view = h("div", { class: "imp-salary" }, h("span", null, "年収（額面）"), value, h("span", null, "で計算中"), kari, change);
  const input = h("input", { class: "input input-sm imp-salary-input", type: "text", dataset: { fk: "salary-input" }, attrs: { inputmode: "numeric", "aria-label": "年収（額面・万円）", autocomplete: "off", maxlength: "12", placeholder: String(IMPACT_DEFAULT_ANNUAL) } });
  const ok = h("button", { class: "btn btn-sm btn-primary", type: "button", dataset: { fk: "salary-ok" } }, "決める");
  const cancel = h("button", { class: "btn btn-sm btn-ghost", type: "button", dataset: { fk: "salary-cancel" } }, "やめる");
  const reset = h("button", { class: "imp-link", type: "button", title: `仮の ${IMPACT_DEFAULT_ANNUAL} 万円で計算する`, dataset: { fk: "salary-reset" } }, "仮に戻す");
  const err = h("div", { class: "imp-salary-err", role: "alert" });
  const edit = h(
    "div",
    { class: "imp-salary-edit" },
    h("label", { class: "imp-salary-field" }, h("span", null, "年収（額面）"), input, h("span", null, "万円")),
    h("div", { class: "imp-salary-btns" }, ok, cancel, reset),
    h("div", { class: "imp-salary-hint" }, `税や手当を引く前の 1 年の給与（${IMPACT_ANNUAL_MIN}〜${groupDigits(IMPACT_ANNUAL_MAX)} 万円）`),
    err,
  );
  edit.hidden = true;
  const el = h("div", { class: "imp-salary-wrap" }, view, edit);
  let current = IMPACT_DEFAULT_ANNUAL;
  const open = () => {
    if (app.store.readOnly) return;
    view.hidden = true;
    edit.hidden = false;
    err.textContent = "";
    input.value = String(current);
    input.focus();
    input.select();
  };
  const close = () => {
    const a = document.activeElement;
    const had = keyboardFocus(a) && edit.contains(a);
    edit.hidden = true;
    view.hidden = false;
    err.textContent = "";
    // 欄の中をキーボードで操作していたら「変える」へ戻す（隠した欄から体に落とさない。マウスで押したときは今までどおり）
    if (had && !change.hidden) change.focus();
  };
  const submit = () => {
    const v = parseAnnual(input.value, IMPACT_ANNUAL_MIN, IMPACT_ANNUAL_MAX);
    if (v === null) {
      err.textContent = `年収は ${IMPACT_ANNUAL_MIN}〜${groupDigits(IMPACT_ANNUAL_MAX)} 万円の間で入れてください`;
      input.focus();
      return;
    }
    close();
    applyAnnual(app, v);
  };
  change.addEventListener("click", open);
  // マウスで押したときは、閉じた欄から体に落としたフォーカスをパネルの入れ物へ（キーボードなら「変える」へ戻す）
  ok.addEventListener("click", () => pressed(submit));
  cancel.addEventListener("click", () => pressed(close));
  reset.addEventListener("click", () =>
    pressed(() => {
      close();
      applyAnnual(app, null);
    }),
  );
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !isImeKey(ev)) {
      ev.preventDefault();
      submit();
    } else if (ev.key === "Escape" && !isImeKey(ev)) {
      ev.preventDefault();
      close();
    }
  });
  salaryFocus = open;
  return {
    el,
    update(imp) {
      current = imp.annual;
      value.textContent = `${groupDigits(imp.annual)} 万円`;
      kari.hidden = imp.annualSet;
      reset.hidden = !imp.annualSet;
      change.hidden = app.store.readOnly;
      if (app.store.readOnly && !edit.hidden) close();
      salaryFocus = open;
    },
  };
}

/** 概要を出して年収の欄を開く（お知らせの「入れる」・詳細の「年収を入れる」） */
export function openSalaryEditor(app: AppContext): void {
  app.ui.clearSelection();
  if (!app.ui.prefs.rightOpen) app.ui.setPrefs({ rightOpen: true });
  // 選択を外すと右のパネルは概要に作り直される。その後で欄を開く
  requestAnimationFrame(() => salaryFocus?.());
}

const SALARY_ASKED_KEY = "4d-branch:impactSalaryAsked";

function salaryAsked(): boolean {
  try {
    return globalThis.localStorage?.getItem(SALARY_ASKED_KEY) === "1";
  } catch {
    return false;
  }
}

function markSalaryAsked(): void {
  try {
    globalThis.localStorage?.setItem(SALARY_ASKED_KEY, "1");
  } catch {
    /* 保存できなくても動く */
  }
}

/**
 * 3 年の分かれ道を初めて見せた後、年収がまだ仮なら一度だけ知らせる（このブラウザで 1 回。邪魔をしないお知らせ）。
 * 確認・操作ガイドの途中は終わるまで待つ。ほかのお知らせ（「開きました」など）が出ている間は、15 秒まで消えるのを待つ
 * （重ねると狭い画面では右のパネルを隠す）。閲覧のみのタブでは編集できるようになってから
 */
export function offerImpactSalary(app: AppContext): void {
  if (app.ephemeral || salaryAsked()) return;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 出してよくなった時刻（ほかのお知らせを待ち始めた時刻） */
  let readyAt = 0;
  const schedule = (ms: number): void => {
    if (done) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(check, ms);
  };
  const check = (): void => {
    timer = null;
    if (done) return;
    if (salaryAsked()) {
      done = true;
      return;
    }
    const imp = app.vm.impact;
    // まだ 3 年の分かれ道が無い・年収はもう入っている・閲覧のみ: 次の変更（編集できるようになった）ときに見直す
    if (!imp.active || imp.annualSet || app.store.readOnly) {
      readyAt = 0;
      return;
    }
    if (modalOpen() || document.querySelector(".tour")) {
      schedule(2000);
      return;
    }
    if (!readyAt) readyAt = Date.now();
    if (document.querySelector(".toast:not(.closing)") && Date.now() - readyAt < 15000) {
      schedule(1000);
      return;
    }
    done = true;
    markSalaryAsked();
    toast(`年収（額面）を入れると、本業の数字が合います（いまは仮に ${IMPACT_DEFAULT_ANNUAL} 万円）`, { action: { label: "入れる", run: () => openSalaryEditor(app) }, ms: 15000 });
  };
  app.store.on("change", () => schedule(1500));
  app.persistence.on("writer", (w) => {
    if (w) schedule(1500);
  });
  schedule(2500);
}

// ------------------------------------------------------------ 見出し（3 年の影響・年収・3 年の稼ぎ・数）

function impactHeader(app: AppContext): { el: HTMLElement; update(imp: ImpactResult): void } {
  const title = h("h3", { class: "insp-label imp-title" });
  const salary = salaryWidget(app);
  const main = h("p", { class: "imp-hl-main" });
  const sub = h("p", { class: "imp-hl-sub" });
  const counts = h("p", { class: "imp-counts" });
  const el = h("section", { class: "imp-sec imp-head" }, title, salary.el, main, sub, counts);
  return {
    el,
    update(imp) {
      const root = imp.root ? app.store.doc.nodes[imp.root] : undefined;
      const from = ymText(root?.time.due);
      const to = ymAfter(root?.time.due, imp.horizon);
      const span = horizonText(imp.horizon);
      title.textContent = `${span}の影響（${from && to ? `${from} → ${to}・` : ""}税引き前）`;
      salary.update(imp);
      const scen = scenarioName(app);
      const hl = headlineOf({ horizon: imp.horizon, value: imp.vRoot, statusQuo: imp.vSQ, best: recommendedValue(imp, !!scen), picks: imp.hasPicks, scenario: scen });
      clear(main);
      if (hl) main.append(`${hl.lead} `, h("b", null, hl.value), hl.vsBest);
      else main.append(`${span}の稼ぎを計算できません（今日から先に数字の無い所があります）`);
      sub.textContent = hl?.sub ?? "";
      sub.hidden = !hl?.sub;
      counts.textContent = `判断 ${groupDigits(imp.counts.decisions)} · 選択肢 ${groupDigits(imp.counts.options)} · ${span}後の行き先 ${groupDigits(imp.counts.ends)}`;
    },
  };
}

// ------------------------------------------------------------ 概要

let premisesCache: string[] | null = null;

/** 同梱の地図の前提（初めて開いたときに 1 度だけ読む） */
function premises(): string[] {
  if (!premisesCache) {
    try {
      const p = futureData().premises;
      premisesCache = Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
    } catch {
      premisesCache = [];
    }
  }
  return premisesCache;
}

function premisesSection(): HTMLElement {
  const list = h("ul", { class: "imp-premise-list" });
  const det = h("details", { class: "imp-premises" }, h("summary", null, "前提（数字の決め方）"), list);
  let filled = false;
  det.addEventListener("toggle", () => {
    if (!det.open || filled) return;
    filled = true;
    const items = premises();
    for (const p of items) list.append(h("li", null, p));
    if (!items.length) list.append(h("li", null, "前提を読み込めませんでした"));
  });
  return h("section", { class: "imp-sec imp-premise" }, det, h("p", { class: "imp-note" }, "数字はモデルの目安です"));
}

/** 見方（q のある地図では ★ と ◎ の決まりが違う: likeBasis） */
function legendSection(): { el: HTMLElement; update(imp: ImpactResult): void } {
  const sample = (bin: number, text: string, chip = false) => h("span", { class: `imp-pill imp-pill-sm${chip ? " is-chip" : ""}`, attrs: { "aria-hidden": "true" }, style: chip ? { "--b": fill(bin) } : { background: fill(bin), color: IMPACT_INK[bin] ?? "#F0EFEC" } }, text);
  const star = h("span");
  const el = h(
    "section",
    { class: "imp-sec imp-legend" },
    h("h3", { class: "insp-label" }, "見方"),
    h(
      "ul",
      { class: "imp-legend-list" },
      li(sample(2, "+65万"), h("span", null, "塗りの数字: その手を今やると、3 年の稼ぎが今のままよりどれだけ変わるか（どちらもその後は一番良い選び方）")),
      li(sample(1, "35%", true), h("span", null, "% の札: その結果になる見込み。色はその結果の良し悪し（今のままと比べて）")),
      li(h("span", { class: "imp-legend-key", attrs: { "aria-hidden": "true" } }, "★"), star),
      li(h("span", { class: "imp-legend-key", attrs: { "aria-hidden": "true" } }, "月"), h("span", null, "月+2.1万: 3 年後の月の稼ぎの差")),
    ),
  );
  const share = Math.round(IMPACT_STAR_SHARE * 10);
  return {
    el,
    update(imp) {
      star.textContent = imp.likeBasis
        ? `★ はっきりおすすめ（同じ見積もり方で、ほかの手より ${IMPACT_STAR_LEAD} 万円以上、かつその判断の差の幅の ${share} 割以上良い）・◎ おすすめ（その判断の一番良い手）・≒ 一番からその差の内・✓ 選んだ手`
        : `★ おすすめ（2 位より ${IMPACT_STAR_LEAD} 万円以上良い）・≒ 一番から ${IMPACT_STAR_LEAD} 万円以内・✓ 選んだ手`;
    },
  };
}

/** 今日の手の先の数の行（q のある地図の今日の手だけ: 判断・出来事の分かれ・行き先。作業メモ perf-14・truth-18） */
function rippleLine(imp: ImpactResult, id: ID, info: AltInfo): HTMLElement | null {
  if (!imp.likeBasis || info.decision !== imp.root) return null;
  const r = imp.ripple(id);
  if (!r) return null;
  const est = r.sumEnds ? `（うち標準の続きで見積もり ${groupDigits(r.sumEnds)}）` : "";
  return li(`この先: 判断 ${groupDigits(r.decisions)} か所・出来事の分かれ ${groupDigits(r.splits)}・行き先 ${groupDigits(r.ends)}${est}`);
}

function fillDecide(app: AppContext, imp: ImpactResult, sec: HTMLElement, seen: Seen): void {
  clear(sec);
  sec.append(h("h3", { class: "insp-label" }, "今決めること", h("span", { class: "insp-count" }, `${horizonText(imp.horizon)}の影響の順`)));
  const root = imp.root;
  if (!root || !imp.decision.get(root)?.alts.length) {
    sec.append(h("p", { class: "imp-note" }, "今日の選択肢がありません"));
    return;
  }
  sec.append(decisionList(app, imp, root, seen, { closeDrawer: true }), flipNote(app, imp, seen));
}

// ------------------------------------------------------------ 順位（3 年でやる価値が大きい手・避けたい手・この先の大事な判断）

/** 「3 年でやる価値が大きい手」に出す、ずっと使わない場合との差の下限（万円）と行の数 */
const WORTH_MIN = 1;
const WORTH_LIMIT = 5;
/** 「避けたい手」「この先の大事な判断」の行の数 */
const AVOID_LIMIT = 3;
const KEY_LIMIT = 6;

/**
 * 手の種類の行を押したときに次に見せる、出てくる所の番号（行の鍵 "worth:種類"・"avoid:種類" ごと）。3 年の影響の結果（imp）ごとに持つ:
 * 数が変わったら最初から。概要を作り直しても（カードを選んで概要へ戻ってきても）続きから
 */
const famCycle = new WeakMap<ImpactResult, Map<string, number>>();

/** 次に見せる番号（0 から） */
function cycleAt(imp: ImpactResult, key: string, n: number): number {
  const i = famCycle.get(imp)?.get(key) ?? 0;
  return n > 0 ? i % n : 0;
}

/** 次に見せる番号を返し、その次へ進める（最後の次は最初） */
function cycleNext(imp: ImpactResult, key: string, n: number): number {
  let m = famCycle.get(imp);
  if (!m) famCycle.set(imp, (m = new Map()));
  const i = cycleAt(imp, key, n);
  m.set(key, n > 0 ? (i + 1) % n : 0);
  return i;
}

/** 手の種類の行の中身（差は、やる価値ならずっと使わない場合との差、避けたい手なら出てくる所の差の平均） */
interface FamRowData {
  fam: string;
  value: number;
  instances: ID[];
  project: ID | null;
}

/**
 * 手の種類の行: 領域の札・種類の名前・差の札 / 「地図に 12 か所 · 次: 2 / 12」。
 * 押すたびに、その種類の手が出てくる所（来る見込みの高い順）を 1 つずつ出して選び、寄る（狭い画面では今決めることの行と同じく引き出しを閉じる）
 */
function famRow(app: AppContext, imp: ImpactResult, r: FamRowData, kind: "worth" | "avoid", seen: Seen): HTMLElement {
  const doc = app.store.doc;
  const key = `${kind}:${r.fam}`;
  // 名前を持たない種類（古い版の地図など）は、最初のカードの題名で書く（その題名を書き換えたら作り直す）
  if (!hasFamLabel(doc, imp.root, r.fam) && r.instances[0]) seen.title(doc, r.instances[0]);
  const label = famLabel(doc, imp.root, r.fam, r.instances);
  const area = projectArea(r.project, doc);
  const n = r.instances.length;
  const value = formatMan(r.value);
  const where = `地図に ${groupDigits(n)} か所`;
  const next = h("span", { class: "imp-meta-part imp-rank-next" });
  const showNext = () => {
    next.textContent = `次: ${cycleAt(imp, key, n) + 1} / ${groupDigits(n)}`;
  };
  if (n >= 2) showNext();
  return h(
    "button",
    {
      class: `imp-rank-row is-${kind}`,
      type: "button",
      title: `${label}（${value}）・${where}`,
      dataset: { fam: r.fam, fk: key },
      onClick: () => {
        if (!n) return;
        goTo(app, r.instances[cycleNext(imp, key, n)]!, true);
        if (n >= 2 && next.isConnected) showNext();
      },
    },
    h("span", { class: "imp-rank-title" }, area ? areaChip(area) : null, h("span", { class: "imp-rank-name" }, label)),
    deltaPill(r.value),
    h("span", { class: "imp-rank-meta" }, h("span", { class: "imp-meta-part" }, where), n >= 2 ? metaSep(where) : null, n >= 2 ? next : null),
  );
}

/** 「3 年でやる価値が大きい手」: 手の種類ごとに、ずっと使わない場合との差が 1 万円以上の物を、大きい順に 5 つまで */
function fillWorth(app: AppContext, imp: ImpactResult, sec: HTMLElement, seen: Seen): void {
  clear(sec);
  const span = horizonText(imp.horizon);
  sec.append(h("h3", { class: "insp-label" }, `${span}でやる価値が大きい手`, h("span", { class: "insp-count" }, "ずっと使わない場合との差")));
  const rows = cachedWorthRanking(app.store.doc, imp, app.vm.forecast)
    .worth.filter((w) => w.k >= WORTH_MIN)
    .slice(0, WORTH_LIMIT);
  if (!rows.length) {
    sec.append(h("p", { class: "imp-note" }, `どの手の種類も、ずっと使わなくても ${span}の差は 1 万円未満`));
    return;
  }
  const list = h("div", { class: "imp-rank-list" });
  for (const w of rows) list.append(famRow(app, imp, { fam: w.fam, value: w.k, instances: w.instances, project: w.project }, "worth", seen));
  sec.append(list, h("p", { class: "imp-note" }, "押すたびに、その手が出てくる所を来る見込みの高い順に地図で見せる"));
}

/** 「避けたい手」: 出てくる所の差の平均（来る見込みで重み付け）が −15 万円以下の種類を、悪い順に 3 つまで。無ければ欄ごと出さない */
function fillAvoid(app: AppContext, imp: ImpactResult, sec: HTMLElement, seen: Seen): void {
  clear(sec);
  const rows = cachedWorthRanking(app.store.doc, imp, app.vm.forecast).avoid.slice(0, AVOID_LIMIT);
  sec.hidden = !rows.length;
  if (!rows.length) return;
  sec.append(h("h3", { class: "insp-label" }, "避けたい手", h("span", { class: "insp-count" }, "出てくる所の差の平均")));
  const list = h("div", { class: "imp-rank-list" });
  for (const a of rows) list.append(famRow(app, imp, { fam: a.fam, value: a.mean, instances: a.instances, project: a.project }, "avoid", seen));
  sec.append(list);
}

/**
 * 「この先の大事な判断」: 今日より後の判断を、おすすめの選び方で来る見込み × その判断での差の大きい順に 6 つまで。無ければ欄ごと出さない。
 * 行: 判断のカードの題名 / 「来る見込み 45%・この判断で最大 +12万の差」/「一番: 一番良い手」。押すとその判断を選び、詳細に選べる手が出る
 */
function fillKeys(app: AppContext, imp: ImpactResult, sec: HTMLElement, seen: Seen): void {
  clear(sec);
  const doc = app.store.doc;
  const rows = keyDecisions(imp, KEY_LIMIT).filter((k) => doc.nodes[k.id]);
  sec.hidden = !rows.length;
  if (!rows.length) return;
  sec.append(h("h3", { class: "insp-label" }, "この先の大事な判断", h("span", { class: "insp-count" }, "来る見込み × 差の大きさの順")));
  const list = h("div", { class: "imp-rank-list" });
  for (const k of rows) {
    const title = seen.title(doc, k.id) || "（無題）";
    const p = `来る見込み ${formatShare(k.p)}`;
    const stakes = `この判断で最大 ${formatMan(k.stakes)}の差`;
    const best = k.best && doc.nodes[k.best] ? seen.title(doc, k.best) || "（無題）" : null;
    list.append(
      h(
        "button",
        { class: "imp-rank-row is-key", type: "button", title: `${title}（${p}・${stakes}${best ? `・一番: ${best}` : ""}）`, dataset: { id: k.id, fk: `key:${k.id}` }, onClick: () => goTo(app, k.id, false) },
        h("span", { class: "imp-rank-title" }, h("span", { class: "imp-rank-name" }, title)),
        h("span", { class: "imp-rank-meta" }, h("span", { class: "imp-meta-part" }, p), "・", h("span", { class: "imp-meta-part" }, stakes)),
        best ? h("span", { class: "imp-rank-meta imp-rank-best" }, `一番: ${best}`) : null,
      ),
    );
  }
  sec.append(list);
}

/** 9 つの段の積み上げ棒（左 = 減る・右 = 増える。段のあいだは 2px あける） */
function distRow(label: string, bins: number[]): HTMLElement {
  const parts: string[] = [];
  const bar = h("div", { class: "imp-dist-bar", role: "img" });
  bins.forEach((share, i) => {
    if (!(share > 0.0005)) return;
    const bin = i - 4;
    parts.push(`${binRangeText(bin)} ${formatShare(share)}`);
    bar.append(h("span", { class: `imp-dist-seg${bin === 0 ? " is-neutral" : ""}`, title: `${binRangeText(bin)}: ${formatShare(share)}`, style: { "flex-grow": String(share), background: fill(bin) } }));
  });
  bar.setAttribute("aria-label", `${label}: ${parts.join("、")}`);
  return h("div", { class: "imp-dist-row" }, h("span", { class: "imp-dist-label" }, label), bar);
}

function scaleLegend(): HTMLElement {
  const sw = h("span", { class: "imp-scale-sw" });
  for (let b = -4; b <= 4; b++) sw.append(h("i", { title: binRangeText(b), style: { background: fill(b) } }));
  return h("div", { class: "imp-scale", title: "段の境目: 3・30・100・300 万円", attrs: { "aria-hidden": "true" } }, h("span", null, "減る"), sw, h("span", null, "増える"));
}

function fillDist(app: AppContext, imp: ImpactResult, sec: HTMLElement): void {
  clear(sec);
  const span = horizonText(imp.horizon);
  sec.append(h("h3", { class: "insp-label" }, `${span}後の分布`, h("span", { class: "insp-count" }, "今のままと比べて")));
  const d = imp.dist;
  if (!d || imp.vSQ === null) {
    sec.append(h("p", { class: "imp-note" }, "分布を出せません（今日から先に数字の無い所があります）"));
    return;
  }
  const scen = scenarioName(app);
  const label = scen ? `${scen}の方針` : imp.hasPicks ? "あなたの選び方" : "おすすめ";
  const lo = formatMan(d.p10, false);
  const hi = formatMan(d.p90, false);
  const range = lo.endsWith("万") && hi.endsWith("万") ? `${lo.slice(0, -1)}〜${hi}` : `${lo}〜${hi}`;
  sec.append(
    distRow(label, d.bins),
    distRow("ずっと今のまま", d.sqBins),
    scaleLegend(),
    h("p", { class: "imp-dist-text" }, `平均 ${formatMan(d.mean, false)}（${formatMan(d.mean - imp.vSQ)}）· 10〜90%: ${range} · 今のままより悪くなる ${formatShare(d.pWorse)}`),
  );
}

function fillEnds(app: AppContext, imp: ImpactResult, sec: HTMLElement, seen: Seen): void {
  clear(sec);
  const doc = app.store.doc;
  const span = horizonText(imp.horizon);
  sec.append(h("h3", { class: "insp-label" }, `${span}後の行き先`, h("span", { class: "insp-count" }, `${whoText(app, imp)}で来る見込み`)));
  const LIMIT = 10;
  const vSQ = imp.vSQ;
  const list = h("div", { class: "imp-end-list" });
  for (const e of imp.ends.slice(0, LIMIT)) {
    const n = doc.nodes[e.id];
    if (!n) continue;
    const g = vSQ === null ? null : e.tot - vSQ;
    const title = seen.title(doc, e.id) || "（無題）";
    list.append(
      h(
        "button",
        { class: "imp-end-row", type: "button", title: `${title}（${formatPercent(e.p)}・${span} ${formatMan(e.tot, false)}）`, dataset: { id: e.id, fk: `end:${e.id}` }, onClick: () => goTo(app, e.id, false) },
        deltaPill(g, { size: "sm" }),
        // 見出しが「3 年後の行き先」なので、タイトルの頭の「3 年後:」は省く
        h("span", { class: "imp-end-title" }, title.replace(/^\s*\d+\s*(年|か月)後\s*[:：]\s*/, "") || title),
        h("span", { class: "imp-end-pct" }, formatPercent(e.p)),
      ),
    );
  }
  sec.append(list);
  if (!imp.ends.length) sec.append(h("p", { class: "imp-note" }, "行き先がありません"));
  else
    sec.append(
      h("p", { class: "imp-note" }, `${imp.ends.length > LIMIT ? `ほか ${groupDigits(imp.ends.length - LIMIT)} か所。` : ""}色付きの数は、${span}の稼ぎの合計がずっと今のままよりどれだけ多いか`),
    );
}

/** 概要（何も選んでいないとき）。3 年の分かれ道が無ければ隠し、update は false を返す */
export function buildImpactOverview(app: AppContext): { el: HTMLElement; update(): boolean } {
  const head = impactHeader(app);
  const decide = h("section", { class: "imp-sec imp-decide" });
  const worth = h("section", { class: "imp-sec imp-worth" });
  const avoid = h("section", { class: "imp-sec imp-avoid" });
  const keys = h("section", { class: "imp-sec imp-keys" });
  const dist = h("section", { class: "imp-sec imp-dist" });
  const ends = h("section", { class: "imp-sec imp-ends" });
  // 3 年の分かれ道だけを見え方で開く（文書・履歴・保存・同期は変えない。自分で折りたたんだ所はそのまま）
  const expandBtn = h("button", { class: "btn btn-sm", type: "button", title: "3 年の分かれ道を全部ひらく", dataset: { fk: "expand" }, onClick: () => app.vm.setImpactOpen(app.vm.impactBranches()) }, icon("expand", 14), "全部ひらく");
  const resetBtn = h("button", { class: "btn btn-sm", type: "button", title: "開いている所を最初の形に戻す", dataset: { fk: "reset-open" }, onClick: () => resetCommand(app)?.(app.vm.impact.root) }, icon("collapse", 14), "最初の形に戻す");
  const legend = legendSection();
  const el = h("div", { class: "imp-overview" }, head.el, decide, worth, avoid, keys, dist, ends, premisesSection(), legend.el, h("div", { class: "btn-row imp-actions" }, expandBtn, resetBtn));
  el.hidden = true;
  let last: ImpactResult | null = null;
  let seen = new Seen();
  return {
    el,
    update() {
      const imp = app.vm.impact;
      el.hidden = !imp.active;
      if (!imp.active) {
        last = null;
        return false;
      }
      head.update(imp);
      legend.update(imp);
      resetBtn.hidden = !resetCommand(app);
      // 数が変わった・書いた題名が変わった（題名の入力）ときだけ作り直す
      if (imp !== last || seen.changed(app.store.doc)) {
        last = imp;
        seen = new Seen();
        // キーボードで操作していた行（data-fk の鍵）は、作り直した後も同じ行へ。無くなったら同じ欄の最初の行、欄ごと無くなったら概要の最初の部品へ
        let at: { sec: HTMLElement; key: string } | null = null;
        for (const sec of [decide, worth, avoid, keys, ends]) {
          const key = focusKeyIn(sec);
          if (key !== null) {
            at = { sec, key };
            break;
          }
        }
        fillDecide(app, imp, decide, seen);
        fillWorth(app, imp, worth, seen);
        fillAvoid(app, imp, avoid, seen);
        fillKeys(app, imp, keys, seen);
        fillDist(app, imp, dist);
        fillEnds(app, imp, ends, seen);
        if (at && !refocus(at.sec, at.key)) focusFirst(el);
      }
      return true;
    },
  };
}

// ------------------------------------------------------------ 詳細（選んだノード）

/**
 * 「これにする」: その手を進行中にし、同じ判断でほかに進行中の手があれば未着手に戻す（選べる手は 1 つ。完了した手はそのまま）。
 * まとめて 1 回で元に戻せる
 */
function pickAlt(app: AppContext, id: ID): void {
  const doc = app.store.doc;
  const n = doc.nodes[id];
  const info = app.vm.impact.alt.get(id);
  if (!n || !info) return;
  const others = (app.vm.impact.decision.get(info.decision)?.alts ?? []).filter((x) => x !== id && doc.nodes[x]?.status === "active");
  app.store.transact(`「${n.title || "無題"}」にする`, (tx) => {
    tx.updateNode(id, { status: "active" });
    for (const x of others) tx.updateNode(x, { status: "open" });
  });
}

/** 選ぶ・見送る・選び直す（状態を 進行中・見送り・未着手 に。すぐに計算し直す） */
function picksRow(app: AppContext, id: ID, info: AltInfo): HTMLElement {
  const ro = app.store.readOnly;
  const status = app.store.doc.nodes[id]?.status;
  const pick = h(
    "button",
    { class: `btn btn-sm imp-pick${info.picked ? " is-on" : " btn-primary"}`, type: "button", disabled: ro, dataset: { fk: `pick:${id}` }, attrs: { "aria-pressed": String(info.picked) }, onClick: () => !info.picked && press(`pick:${id}`, () => pickAlt(app, id)) },
    icon("check", 14),
    info.picked ? (status === "done" ? "これにした（完了）" : "これにした") : "これにする",
  );
  const drop = h(
    "button",
    { class: `btn btn-sm imp-drop${info.dropped ? " is-on" : ""}`, type: "button", disabled: ro, dataset: { fk: `drop:${id}` }, attrs: { "aria-pressed": String(info.dropped) }, onClick: () => !info.dropped && press(`drop:${id}`, () => app.cmd.setStatus([id], "dropped")) },
    icon("x", 14),
    info.dropped ? "見送った" : "見送る",
  );
  const redo = h("button", { class: "btn btn-sm btn-ghost imp-redo", type: "button", disabled: ro || (!info.picked && !info.dropped), title: "未着手に戻して選び直す", dataset: { fk: `redo:${id}` }, onClick: () => pressed(() => app.cmd.setStatus([id], "open")) }, icon("undo", 14), "選び直す");
  return h("div", { class: "imp-picks" }, pick, drop, redo);
}

function altBody(app: AppContext, imp: ImpactResult, id: ID, wrap: HTMLElement, seen: Seen): void {
  const doc = app.store.doc;
  const n = doc.nodes[id];
  const info = imp.alt.get(id);
  if (!n || !info) return;
  const dec = imp.decision.get(info.decision);
  const span = horizonText(imp.horizon);
  const ro = app.store.readOnly;
  // 3 年の影響
  if (info.isBase) {
    wrap.append(h("p", { class: "imp-hl" }, h("span", null, `${span}の稼ぎ:`), deltaPill(0, { base: true, size: "lg" })), h("p", { class: "imp-note" }, "同じ判断のほかの手の数は、この手（この期間は何も足さない）と比べた差"));
  } else if (dec && dec.base === null) {
    wrap.append(h("p", { class: "imp-warn" }, icon("alert", 13), h("span", null, "基準（今のまま）が無いので差を出せません")));
    if (!ro) wrap.append(h("div", { class: "imp-picks" }, h("button", { class: "btn btn-sm", type: "button", dataset: { fk: `base:${id}` }, onClick: () => pressed(() => app.cmd.updateNode(id, { meta: { ...n.meta, base: true } }, { label: "基準にする" })) }, "これを基準にする")));
  } else if (info.delta === null) {
    wrap.append(h("p", { class: "imp-warn" }, icon("alert", 13), h("span", null, "数字なし（結果と見込みを足すと計算します）")));
  } else {
    wrap.append(
      h("p", { class: "imp-hl" }, h("span", null, `${span}の稼ぎ: 今のままより`), deltaPill(info.delta, { size: "lg", text: `${info.partial ? "≈" : ""}${yen(info.delta)}` })),
      h("p", { class: "imp-note" }, "（この期間に何もせず、その後は一番良い選び方をした場合と比べて）"),
    );
  }
  const mark = markOf(info);
  if (mark.text) wrap.append(h("p", { class: "imp-badges" }, h("span", { class: markClass(info) }, mark.text), h("span", null, mark.label)));
  if (!info.allowed) wrap.append(h("p", { class: "imp-note" }, "選んでいる方針の外の手です（計算では選びません）"));
  wrap.append(picksRow(app, id, info));

  // 数
  const facts = h("ul", { class: "imp-facts" });
  if (!info.isBase && info.delta !== null) {
    const fam = typeof n.meta?.fam === "string" ? (n.meta.fam as string) : typeof n.meta?.ak === "string" ? (n.meta.ak as string) : null;
    const never = fam ? imp.never(fam).card.get(id) : undefined;
    if (never !== undefined && Number.isFinite(never)) facts.append(li(`この手を ${span}間ずっとやらない場合と比べると `, h("b", null, yen(never))));
    if (info.dR !== null) facts.append(li(`${span}後の月の稼ぎ: `, h("b", null, `月 ${yen(info.dR)}`)));
    const risk = riskText(info.pBad, info.worst);
    if (risk) facts.append(li(risk));
  }
  const ripple = rippleLine(imp, id, info);
  if (ripple) facts.append(ripple);
  const hrs = n.meta?.h;
  if (typeof hrs === "number" && Number.isFinite(hrs)) facts.append(li(hoursText(hrs)));
  if (facts.children.length) wrap.append(facts);
  if (!imp.annualSet && !info.isBase) {
    wrap.append(
      h(
        "p",
        { class: "imp-note imp-kari-note" },
        h("span", null, `年収が仮（${IMPACT_DEFAULT_ANNUAL} 万円）なので本業の数字は目安です`),
        ro ? null : h("button", { class: "imp-link", type: "button", dataset: { fk: `salary-open:${id}` }, onClick: () => pressed(() => openSalaryEditor(app)) }, "年収を入れる"),
      ),
    );
  }

  // 内訳（表示した 3 年の影響とちょうど合う）
  if (!info.isBase && info.delta !== null && info.deltaV) {
    const { step, values } = splitExact(info.delta, info.deltaV);
    const areas = breakdownAreas(doc);
    const d = divergingDomain(values);
    const sec = h("div", { class: "imp-split" }, h("h3", { class: "insp-label" }, "内訳", h("span", { class: "insp-count" }, `合計 ${formatMan(info.delta)}`)));
    values.forEach((v, i) => {
      const a = areas[i];
      if (!a) return;
      sec.append(h("div", { class: "imp-split-row" }, h("span", { class: "imp-split-label" }, h("span", { class: "dot", style: { background: a.color } }), a.label), diffBar(v, d), h("span", { class: "imp-split-val" }, formatManStep(v, step))));
    });
    wrap.append(sec);
  }

  // 結果（見込み・名前・その結果なら今のままよりどれだけ）
  if (info.outcomes.length) {
    const sec = h("div", { class: "imp-outs" }, h("h3", { class: "insp-label" }, "結果", h("span", { class: "insp-count" }, "この手を選んだ場合の見込み")));
    if (info.outcomes.length >= 2 && info.outcomes.every((o) => typeof doc.edges[o.edge]?.meta?.prob !== "number")) sec.append(h("p", { class: "imp-warn" }, icon("alert", 13), h("span", null, "見込み（%）が入っていません（等分で計算中）")));
    for (const o of info.outcomes) {
      const e = seen.edge(doc, o.edge);
      const t = doc.nodes[o.node];
      const title = seen.title(doc, o.node);
      const short = typeof t?.meta?.short === "string" ? (t.meta.short as string) : "";
      const label = e?.label?.trim() || short || title || "（無題）";
      const line = e?.condition?.trim() ?? "";
      sec.append(
        h(
          "button",
          { class: "imp-out-row", type: "button", title, dataset: { id: o.node, fk: `out:${o.node}` }, onClick: () => goTo(app, o.node, false) },
          h("span", { class: "imp-out-pct" }, formatShare(o.w)),
          h("span", { class: "imp-out-text" }, h("span", { class: "imp-out-label" }, label), line && line !== NO_LINE && line !== label ? h("span", { class: "imp-out-line" }, line) : null),
          deltaPill(o.u, { size: "sm" }),
        ),
      );
    }
    wrap.append(sec);
  }

  // 同じ判断の手（比べる）
  if (dec && dec.alts.length > 1) {
    wrap.append(h("div", { class: "imp-sibs" }, h("h3", { class: "insp-label" }, "同じ判断の手", h("span", { class: "insp-count" }, `${dec.alts.length} 個・${span}の影響の順`)), decisionList(app, imp, info.decision, seen, { current: id, closeDrawer: false })));
  }
}

function outcomeBody(app: AppContext, imp: ImpactResult, id: ID, wrap: HTMLElement, seen: Seen): void {
  const doc = app.store.doc;
  const n = doc.nodes[id];
  if (!n) return;
  const span = horizonText(imp.horizon);
  const o = imp.outcome.get(id);
  const facts = h("ul", { class: "imp-facts" });
  if (o) {
    facts.append(li("この結果になる見込み ", h("b", null, formatShare(o.w)), "（この手を選んだ場合）"));
    if (doc.nodes[o.alt]) facts.append(li(h("span", null, "この手:"), h("button", { class: "imp-link imp-alt-link", type: "button", title: "この手を選ぶ", dataset: { fk: `alt:${o.alt}` }, onClick: () => goTo(app, o.alt, false) }, seen.title(doc, o.alt) || "（無題）")));
  }
  const reach = app.vm.forecast.reach.get(id);
  const piP = imp.pPi.get(id) ?? 0;
  const who = whoText(app, imp);
  facts.append(li(reach ? `この道で ${formatPercent(reach.p)} · ` : "", piP > 0 ? `${who}で ${formatPercent(piP)}` : `${who}では通らない`));
  if (o && o.u !== null) facts.append(li(h("span", null, "この結果なら 今のままより "), deltaPill(o.u, { size: "sm", text: yen(o.u) })));
  const acc = imp.acc.get(id);
  const val = imp.value.get(id);
  if (acc !== undefined && val !== undefined && imp.vSQ !== null) {
    const tot = acc + val;
    const leaf = imp.kind.get(id) === "leaf";
    facts.append(li(leaf ? `この行き先の ${span}の稼ぎ ` : `この後一番良く選ぶと ${span} `, h("b", null, yen(tot, false)), `（ずっと今のままより ${yen(tot - imp.vSQ)}）`));
  }
  wrap.append(facts);
  const line = stateLine(n.meta?.st, n.meta?.rr);
  if (line) wrap.append(h("p", { class: "imp-state" }, h("b", null, "その時: "), line));

  // 目印（今日からここまでの、運で分かれた所）
  const steps = trailOf(doc, app.vm.index.inc, id, (x) => imp.kind.get(x) === "chance", (x) => imp.scope.has(x));
  if (steps.length) {
    const ol = h("ol", { class: "imp-trail" });
    for (const s of steps) {
      seen.edge(doc, s.edge);
      ol.append(
        h(
          "li",
          null,
          h(
            "button",
            { class: `imp-trail-step${s.node === id ? " is-current" : ""}`, type: "button", title: seen.title(doc, s.node), dataset: { id: s.node, fk: `trail:${s.node}` }, onClick: () => goTo(app, s.node, false) },
            h("span", { class: "imp-trail-when" }, s.when ?? "—"),
            h("span", { class: "imp-trail-what" }, h("span", { class: "imp-trail-alt" }, seen.title(doc, s.alt) || "（無題）"), h("span", { class: "imp-trail-line" }, `→ ${s.line || s.label || "どの場合もこの道"}`)),
          ),
        ),
      );
    }
    wrap.append(h("div", { class: "imp-trail-sec" }, h("h3", { class: "insp-label" }, "目印", h("span", { class: "insp-count" }, "今日からここまで")), ol));
  }

  // 判断なら、ここで選べる手
  const dec = imp.decision.get(id);
  if (dec && dec.alts.length) {
    wrap.append(
      h(
        "div",
        { class: "imp-sibs" },
        h("h3", { class: "insp-label" }, "ここで選べる手", h("span", { class: "insp-count" }, dec.stakes !== null ? `この判断で最大 ${formatMan(dec.stakes)}の差` : `${dec.alts.length} 個`)),
        decisionList(app, imp, id, seen, { closeDrawer: false }),
      ),
    );
  }
}

function rootBody(app: AppContext, imp: ImpactResult, id: ID, wrap: HTMLElement, seen: Seen): void {
  const dec = imp.decision.get(id);
  if (!dec || !dec.alts.length) return;
  wrap.append(h("div", { class: "imp-sibs imp-decide" }, h("h3", { class: "insp-label" }, "今決めること", h("span", { class: "insp-count" }, `${horizonText(imp.horizon)}の影響の順`)), decisionList(app, imp, id, seen, { closeDrawer: true }), flipNote(app, imp, seen)));
}

/**
 * 3 年の分かれ道の中のノードの詳細（今日・選択肢・結果・行き先）。範囲の外なら null（今までの詳細だけ）。
 * isAlt: 選択肢（やることのチェックリストを本文の前に出す）
 */
export function buildImpactNodeBlock(app: AppContext, id: ID): { el: HTMLElement; update(): void; isAlt: boolean } | null {
  const imp0 = app.vm.impact;
  if (!imp0.active || !imp0.scope.has(id)) return null;
  const isRoot = imp0.root === id;
  const isAlt = imp0.alt.has(id);
  const head = isRoot ? impactHeader(app) : null;
  const body = h("div", { class: "imp-node-body" });
  const el = h("div", { class: `imp-node${isRoot ? " is-root" : isAlt ? " is-alt" : " is-outcome"}` }, head ? head.el : null, body);
  let last: ImpactResult | null = null;
  let seen = new Seen();
  return {
    el,
    isAlt,
    update() {
      const imp = app.vm.impact;
      if (!imp.active || !imp.scope.has(id) || !app.store.doc.nodes[id]) {
        el.hidden = true;
        last = null;
        return;
      }
      el.hidden = false;
      head?.update(imp);
      // 数が変わった・書いた題名や線の文が変わった（題名の入力）ときだけ作り直す
      if (imp === last && !seen.changed(app.store.doc)) return;
      last = imp;
      seen = new Seen();
      const fk = focusKeyIn(body);
      clear(body);
      if (imp.root === id) rootBody(app, imp, id, body, seen);
      else if (imp.alt.has(id)) altBody(app, imp, id, body, seen);
      else outcomeBody(app, imp, id, body, seen);
      if (fk !== null) refocus(body, fk);
    },
  };
}

/**
 * 接続の詳細の見込み（%）の扱い（3 年の分かれ道の中の線だけ）。
 * decision: 判断の線（% は使わない）・chance: 結果の線（この手の結果の合計を出す）・null: 範囲の外（今までどおり）
 */
export function impactEdgeKind(app: AppContext, source: ID): "decision" | "chance" | null {
  const imp = app.vm.impact;
  if (!imp.active || !imp.scope.has(source)) return null;
  const k = imp.kind.get(source);
  return k === "decision" ? "decision" : k === "chance" ? "chance" : null;
}
