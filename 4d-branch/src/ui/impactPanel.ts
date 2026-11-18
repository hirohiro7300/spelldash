// 右のパネルの「3 年の影響」（未来の道筋 v2「3 年の分かれ道」）。設計: docs/DESIGN.md §4.7
//   概要（何も選んでいないとき）: 見出しと年収・今決めること・3 年後の分布・3 年後の行き先・前提・見方
//   詳細（選んだノード）: 選択肢なら 3 年の影響・選ぶ／見送る・内訳・結果・同じ判断の手。結果・行き先なら見込み・その時の状態・目印
// 数は vm.impact（src/model/impact.ts）を読むだけ。文は src/model/impactText.ts。
// 中身は数が変わったとき（vm.impact が新しくなったとき）だけ作り直す。年収の欄は作り直さない（入力中に消さない）

import type { AppContext } from "../app/context";
import { futureData } from "../demo/futureBundle";
import { formatPercent } from "../model/forecast";
import { computeImpact, IMPACT_ANNUAL_MAX, IMPACT_ANNUAL_MIN, IMPACT_DEFAULT_ANNUAL, type AltInfo, type ImpactResult } from "../model/impact";
import { formatMan, formatShare, IMPACT_FILL, IMPACT_INK, IMPACT_NEUTRAL_RING, impactBin } from "../model/impactFormat";
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
  riskText,
  splitExact,
  stateLine,
  trailOf,
  yen,
  ymAfter,
  ymText,
  type AreaInfo,
} from "../model/impactText";
import type { ID } from "../model/types";
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

const bestCache = new WeakMap<ImpactResult, number | null>();

/**
 * おすすめの選び方での 3 年の稼ぎ。自分で選んだ手（進行中・完了）も方針も無ければ今の値そのもの。
 * あれば、選んだ手を外し（見送りはそのまま）方針でも絞らずに計算し直す（数が変わるまで覚えておく）
 */
function recommendedValue(app: AppContext, imp: ImpactResult, scenario: boolean): number | null {
  if (!imp.hasPicks && !scenario) return imp.vRoot;
  const hit = bestCache.get(imp);
  if (hit !== undefined) return hit;
  const doc = app.store.doc;
  const nodes = { ...doc.nodes };
  for (const id of imp.scope) {
    const n = nodes[id];
    if (n && (n.status === "active" || n.status === "done")) nodes[id] = { ...n, status: "open" };
  }
  let v: number | null = null;
  try {
    v = computeImpact({ ...doc, nodes }, app.vm.index.out, null, null).vRoot;
  } catch {
    v = null;
  }
  bestCache.set(imp, v);
  return v;
}

// ------------------------------------------------------------ 移動

/** そのノードを出して選び、地図ならそこへ寄る（closeDrawer: 狭い画面では右のパネルを閉じてカードを見せる） */
function goTo(app: AppContext, id: ID, closeDrawer: boolean): void {
  if (!app.store.doc.nodes[id]) return;
  app.cmd.revealNode(id);
  app.ui.select([id]);
  if (closeDrawer && isNarrowScreen() && app.ui.prefs.rightOpen) app.ui.setPrefs({ rightOpen: false });
  if (app.ui.prefs.view === "map") app.view.centerOn(id);
  else app.revealInList(id);
}

/** 「最初の形に戻す」（開いている所を既定に戻す操作）。まだ無ければ null */
function resetCommand(app: AppContext): ((root: ID | null) => void) | null {
  const c = app.cmd as unknown as Record<string, unknown>;
  for (const name of ["resetImpactOpen", "resetImpactView", "resetExpansion"]) {
    const f = c[name];
    if (typeof f === "function") return (root) => (f as (r: ID | null) => void).call(app.cmd, root);
  }
  return null;
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

/** ★（おすすめ）・≒（ほぼ同じ）・✓（選んだ手） */
function markOf(info: AltInfo): { text: string; label: string } {
  const marks: Array<[string, string]> = [];
  if (info.picked) marks.push(["✓", "選んだ手"]);
  if (info.mark === "star") marks.push(["★", "おすすめ"]);
  else if (info.mark === "tie") marks.push(["≒", "ほぼ同じ"]);
  return { text: marks.map((m) => m[0]).join(""), label: marks.map((m) => m[1]).join("・") };
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

/** 選択肢の行: ★・領域・タイトル・差の札 / 差の棒 / 悪くなる見込み・3 年後の月・週の時間 */
function altRow(app: AppContext, imp: ImpactResult, id: ID, d: Domain, opts: { current?: boolean; onGo: (id: ID) => void }): HTMLElement | null {
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
  const title = n.title || "（無題）";
  const value = info.isBase ? "基準" : info.delta === null ? "数字なし" : formatMan(info.delta);
  return h(
    "button",
    {
      class: `imp-alt-row${opts.current ? " is-current" : ""}${info.dropped ? " is-dropped" : ""}${info.allowed ? "" : " is-off"}`,
      type: "button",
      title: `${title}（${value}）${mark.label ? `・${mark.label}` : ""}`,
      dataset: { id },
      attrs: { "aria-current": opts.current ? "true" : null },
      onClick: () => opts.onGo(id),
    },
    h("span", { class: `imp-mark${info.mark === "star" ? " is-star" : ""}${info.picked ? " is-picked" : ""}` }, mark.text),
    h("span", { class: "imp-alt-title" }, area ? areaChip(area) : null, h("span", { class: "imp-alt-name" }, title)),
    deltaPill(info.delta, { base: info.isBase, partial: info.partial }),
    diffBar(info.isBase ? 0 : info.delta, d),
    meta,
  );
}

/** 判断の選択肢の表（3 年の影響の順。差の棒は同じ範囲） */
function decisionList(app: AppContext, imp: ImpactResult, decisionId: ID, opts: { current?: ID; closeDrawer: boolean }): HTMLElement {
  const list = h("div", { class: "imp-alt-list" });
  const dec = imp.decision.get(decisionId);
  if (!dec) return list;
  const ids = byDelta(imp, dec.alts);
  const d = divergingDomain(ids.map((id) => imp.alt.get(id)?.delta ?? null));
  for (const id of ids) {
    const row = altRow(app, imp, id, d, { current: id === opts.current, onGo: (x) => goTo(app, x, opts.closeDrawer) });
    if (row) list.append(row);
  }
  return list;
}

/** 年収で今日の一番が入れ替わる所 */
function flipNote(app: AppContext, imp: ImpactResult): HTMLElement {
  const lines = flipTexts(imp.salaryFlips(), (id) => app.store.doc.nodes[id]?.title || "（無題）");
  if (!lines.length) lines.push("年収が 200〜1,000 万円のどこでも、いちばんの手は同じ");
  return h("div", { class: "imp-flip" }, icon("swap", 13), h("div", null, ...lines.map((l) => h("div", null, l))));
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
  const change = h("button", { class: "imp-link imp-salary-change", type: "button", title: "年収（額面）を入れる・変える" }, "変える");
  const view = h("div", { class: "imp-salary" }, h("span", null, "年収（額面）"), value, h("span", null, "で計算中"), kari, change);
  const input = h("input", { class: "input input-sm imp-salary-input", type: "text", attrs: { inputmode: "numeric", "aria-label": "年収（額面・万円）", autocomplete: "off", maxlength: "12", placeholder: String(IMPACT_DEFAULT_ANNUAL) } });
  const ok = h("button", { class: "btn btn-sm btn-primary", type: "button" }, "決める");
  const cancel = h("button", { class: "btn btn-sm btn-ghost", type: "button" }, "やめる");
  const reset = h("button", { class: "imp-link", type: "button", title: `仮の ${IMPACT_DEFAULT_ANNUAL} 万円で計算する` }, "仮に戻す");
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
    edit.hidden = true;
    view.hidden = false;
    err.textContent = "";
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
  ok.addEventListener("click", submit);
  cancel.addEventListener("click", close);
  reset.addEventListener("click", () => {
    close();
    applyAnnual(app, null);
  });
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
      const hl = headlineOf({ horizon: imp.horizon, value: imp.vRoot, statusQuo: imp.vSQ, best: recommendedValue(app, imp, !!scen), picks: imp.hasPicks, scenario: scen });
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

function legendSection(): HTMLElement {
  const sample = (bin: number, text: string, chip = false) => h("span", { class: `imp-pill imp-pill-sm${chip ? " is-chip" : ""}`, attrs: { "aria-hidden": "true" }, style: chip ? { "--b": fill(bin) } : { background: fill(bin), color: IMPACT_INK[bin] ?? "#F0EFEC" } }, text);
  return h(
    "section",
    { class: "imp-sec imp-legend" },
    h("h3", { class: "insp-label" }, "見方"),
    h(
      "ul",
      { class: "imp-legend-list" },
      li(sample(2, "+65万"), h("span", null, "塗りの数字: その手を今やると、3 年の稼ぎが今のままよりどれだけ変わるか（どちらもその後は一番良い選び方）")),
      li(sample(1, "35%", true), h("span", null, "% の札: その結果になる見込み。色はその結果の良し悪し（今のままと比べて）")),
      li(h("span", { class: "imp-legend-key", attrs: { "aria-hidden": "true" } }, "★"), h("span", null, "★ おすすめ（2 位より 3 万円以上良い）・≒ ほぼ同じ・✓ 選んだ手")),
      li(h("span", { class: "imp-legend-key", attrs: { "aria-hidden": "true" } }, "月"), h("span", null, "月+2.1万: 3 年後の月の稼ぎの差")),
    ),
  );
}

function fillDecide(app: AppContext, imp: ImpactResult, sec: HTMLElement): void {
  clear(sec);
  sec.append(h("h3", { class: "insp-label" }, "今決めること", h("span", { class: "insp-count" }, `${horizonText(imp.horizon)}の影響の順`)));
  const root = imp.root;
  if (!root || !imp.decision.get(root)?.alts.length) {
    sec.append(h("p", { class: "imp-note" }, "今日の選択肢がありません"));
    return;
  }
  sec.append(decisionList(app, imp, root, { closeDrawer: true }), flipNote(app, imp));
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

function fillEnds(app: AppContext, imp: ImpactResult, sec: HTMLElement): void {
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
    const title = n.title || "（無題）";
    list.append(
      h(
        "button",
        { class: "imp-end-row", type: "button", title: `${title}（${formatPercent(e.p)}・${span} ${formatMan(e.tot, false)}）`, dataset: { id: e.id }, onClick: () => goTo(app, e.id, false) },
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
  const dist = h("section", { class: "imp-sec imp-dist" });
  const ends = h("section", { class: "imp-sec imp-ends" });
  const expandBtn = h("button", { class: "btn btn-sm", type: "button", title: "3 年の分かれ道を全部ひらく", onClick: () => app.cmd.expandAll() }, icon("expand", 14), "全部ひらく");
  const resetBtn = h("button", { class: "btn btn-sm", type: "button", title: "開いている所を最初の形に戻す", onClick: () => resetCommand(app)?.(app.vm.impact.root) }, icon("collapse", 14), "最初の形に戻す");
  const el = h("div", { class: "imp-overview" }, head.el, decide, dist, ends, premisesSection(), legendSection(), h("div", { class: "btn-row imp-actions" }, expandBtn, resetBtn));
  el.hidden = true;
  let last: ImpactResult | null = null;
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
      resetBtn.hidden = !resetCommand(app);
      if (imp !== last) {
        last = imp;
        fillDecide(app, imp, decide);
        fillDist(app, imp, dist);
        fillEnds(app, imp, ends);
      }
      return true;
    },
  };
}

// ------------------------------------------------------------ 詳細（選んだノード）

/** 選ぶ・見送る・選び直す（状態を 進行中・見送り・未着手 に。すぐに計算し直す） */
function picksRow(app: AppContext, id: ID, info: AltInfo): HTMLElement {
  const ro = app.store.readOnly;
  const status = app.store.doc.nodes[id]?.status;
  const pick = h(
    "button",
    { class: `btn btn-sm imp-pick${info.picked ? " is-on" : " btn-primary"}`, type: "button", disabled: ro, attrs: { "aria-pressed": String(info.picked) }, onClick: () => !info.picked && app.cmd.setStatus([id], "active") },
    icon("check", 14),
    info.picked ? (status === "done" ? "これにした（完了）" : "これにした") : "これにする",
  );
  const drop = h(
    "button",
    { class: `btn btn-sm imp-drop${info.dropped ? " is-on" : ""}`, type: "button", disabled: ro, attrs: { "aria-pressed": String(info.dropped) }, onClick: () => !info.dropped && app.cmd.setStatus([id], "dropped") },
    icon("x", 14),
    info.dropped ? "見送った" : "見送る",
  );
  const redo = h("button", { class: "btn btn-sm btn-ghost imp-redo", type: "button", disabled: ro || (!info.picked && !info.dropped), title: "未着手に戻して選び直す", onClick: () => app.cmd.setStatus([id], "open") }, icon("undo", 14), "選び直す");
  return h("div", { class: "imp-picks" }, pick, drop, redo);
}

function altBody(app: AppContext, imp: ImpactResult, id: ID, wrap: HTMLElement): void {
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
    if (!ro) wrap.append(h("div", { class: "imp-picks" }, h("button", { class: "btn btn-sm", type: "button", onClick: () => app.cmd.updateNode(id, { meta: { ...n.meta, base: true } }, { label: "基準にする" }) }, "これを基準にする")));
  } else if (info.delta === null) {
    wrap.append(h("p", { class: "imp-warn" }, icon("alert", 13), h("span", null, "数字なし（結果と見込みを足すと計算します）")));
  } else {
    wrap.append(
      h("p", { class: "imp-hl" }, h("span", null, `${span}の稼ぎ: 今のままより`), deltaPill(info.delta, { size: "lg", text: `${info.partial ? "≈" : ""}${yen(info.delta)}` })),
      h("p", { class: "imp-note" }, "（この期間に何もせず、その後は一番良い選び方をした場合と比べて）"),
    );
  }
  const mark = markOf(info);
  if (mark.text) wrap.append(h("p", { class: "imp-badges" }, h("span", { class: `imp-mark${info.mark === "star" ? " is-star" : ""}${info.picked ? " is-picked" : ""}` }, mark.text), h("span", null, mark.label)));
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
  const hrs = n.meta?.h;
  if (typeof hrs === "number" && Number.isFinite(hrs)) facts.append(li(hoursText(hrs)));
  if (facts.children.length) wrap.append(facts);
  if (!imp.annualSet && !info.isBase) {
    wrap.append(
      h(
        "p",
        { class: "imp-note imp-kari-note" },
        h("span", null, `年収が仮（${IMPACT_DEFAULT_ANNUAL} 万円）なので本業の数字は目安です`),
        ro ? null : h("button", { class: "imp-link", type: "button", onClick: () => openSalaryEditor(app) }, "年収を入れる"),
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
      const e = doc.edges[o.edge];
      const t = doc.nodes[o.node];
      const short = typeof t?.meta?.short === "string" ? (t.meta.short as string) : "";
      const label = e?.label?.trim() || short || t?.title || "（無題）";
      const line = e?.condition?.trim() ?? "";
      sec.append(
        h(
          "button",
          { class: "imp-out-row", type: "button", title: t?.title ?? "", dataset: { id: o.node }, onClick: () => goTo(app, o.node, false) },
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
    wrap.append(h("div", { class: "imp-sibs" }, h("h3", { class: "insp-label" }, "同じ判断の手", h("span", { class: "insp-count" }, `${dec.alts.length} 個・${span}の影響の順`)), decisionList(app, imp, info.decision, { current: id, closeDrawer: false })));
  }
}

function outcomeBody(app: AppContext, imp: ImpactResult, id: ID, wrap: HTMLElement): void {
  const doc = app.store.doc;
  const n = doc.nodes[id];
  if (!n) return;
  const span = horizonText(imp.horizon);
  const o = imp.outcome.get(id);
  const facts = h("ul", { class: "imp-facts" });
  if (o) {
    facts.append(li("この結果になる見込み ", h("b", null, formatShare(o.w)), "（この手を選んだ場合）"));
    const alt = doc.nodes[o.alt];
    if (alt) facts.append(li(h("span", null, "この手:"), h("button", { class: "imp-link imp-alt-link", type: "button", title: "この手を選ぶ", onClick: () => goTo(app, o.alt, false) }, alt.title || "（無題）")));
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
      ol.append(
        h(
          "li",
          null,
          h(
            "button",
            { class: `imp-trail-step${s.node === id ? " is-current" : ""}`, type: "button", title: doc.nodes[s.node]?.title ?? "", dataset: { id: s.node }, onClick: () => goTo(app, s.node, false) },
            h("span", { class: "imp-trail-when" }, s.when ?? "—"),
            h("span", { class: "imp-trail-what" }, h("span", { class: "imp-trail-alt" }, doc.nodes[s.alt]?.title || "（無題）"), h("span", { class: "imp-trail-line" }, `→ ${s.line || s.label || "どの場合もこの道"}`)),
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
        decisionList(app, imp, id, { closeDrawer: false }),
      ),
    );
  }
}

function rootBody(app: AppContext, imp: ImpactResult, id: ID, wrap: HTMLElement): void {
  const dec = imp.decision.get(id);
  if (!dec || !dec.alts.length) return;
  wrap.append(h("div", { class: "imp-sibs imp-decide" }, h("h3", { class: "insp-label" }, "今決めること", h("span", { class: "insp-count" }, `${horizonText(imp.horizon)}の影響の順`)), decisionList(app, imp, id, { closeDrawer: true }), flipNote(app, imp)));
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
      if (imp === last) return;
      last = imp;
      clear(body);
      if (imp.root === id) rootBody(app, imp, id, body);
      else if (imp.alt.has(id)) altBody(app, imp, id, body);
      else outcomeBody(app, imp, id, body);
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
