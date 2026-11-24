// 資産のゴール（「資産 10 億円」）の前提の欄（設計: 作業メモ goal/design.md §4.7）。概要の見出しの年収の欄の下に 1 行:
// 「ゴール 資産 10 億円・2056 年まで（前提 5 つは仮）［変える］」。変えるで 6 つの欄（目標・今の資産・積立の割合・利回り・事業の伸び・期限）。
// 入れた物だけを入口の meta.goal に置く（元に戻せる。計算はやり直さない: C_PRESENT だけ）。入れない欄は仮の値で計算する。
// 閲覧のみのタブでは値を見せるだけ。
// 見取り図の帯・芽の札・今日の欄の 1 行（src/deepmap/views/goal.ts）は、ここで今の前提の数に埋め直す（前提を変えても見取り図は
// 作り直されないため。数ができていなければ空いた時間に作って埋める）。帯の「前提を変える」「入れる」もここで受ける。
// 版 6 の地図（年月も見取り図も無い）は、この欄の下に同じ帯をアプリの計算の行き先から出す（設計 §4.8）。
// 詳細の欄の「10 億」の 1 文（行き先・途中のカード）と、今日のカードの帯（3 か月ごとの地図）もここで作る（設計 §4.5・§4.6）。

import "../styles/goal.css";
import type { AppContext } from "../app/context";
import { whenIdle } from "../app/idle";
import { goalViewOf, type Analysis } from "../deepmap/core";
import { fillGoalSlots, goalOverviewVM, goalSkeletonEl, goalStripEl, goalStripVM, goalViewKey } from "../deepmap/views";
import { formatOku, goalAnchor, goalConfigOf, type GoalKey, type GoalStored } from "../model/goal";
import { goalCtxOf, goalFactOf, goalImpactStripInput } from "../model/goalImpact";
import { goalFieldPlaceholder, goalFields, goalFieldValue, goalFromInputs, goalViewRow, sameGoal, type GoalField } from "../model/goalForm";
import type { ImpactResult } from "../model/impact";
import type { GNode } from "../model/types";
import { h, isImeKey } from "./dom";
import { toast } from "./overlays";

/** 「変える」で欄を開く（概要を作ったときに差し替わる） */
let goalFocus: ((field?: GoalKey) => void) | null = null;

/** 地図の 0 か月目（入口の meta.anchor。無ければ 3 か月ごとの地図の年月。どちらも無ければ今月から数える） */
function anchorOf(app: AppContext, root: GNode | undefined): ReturnType<typeof goalAnchor> {
  const a = root?.meta?.anchor;
  if (typeof a === "string") return goalAnchor(a);
  return goalAnchor(app.vm.deep.get()?.map.header.anchor);
}

/** 入口のカード（3 年の分かれ道が無ければ undefined） */
function rootOf(app: AppContext): GNode | undefined {
  const imp = app.vm.impact;
  return imp.active && imp.root ? app.store.doc.nodes[imp.root] : undefined;
}

/**
 * 前提を入口の meta.goal に置く（null なら全部を仮に戻す: meta.goal を消す）。同じ中身なら何もしない。元に戻せる
 */
export function applyGoal(app: AppContext, next: GoalStored | null): boolean {
  const root = rootOf(app);
  if (!root || app.store.readOnly) return false;
  const cur = root.meta.goal;
  if (sameGoal(cur, next)) return false;
  const before = formatOku(goalConfigOf(root).cfg.target);
  const meta: Record<string, unknown> = { ...root.meta };
  if (next) meta.goal = next;
  else delete meta.goal;
  const name = next ? formatOku(next.target ?? goalConfigOf({ meta: { goal: next } }).cfg.target) : before;
  const ok = app.store.transact(next ? `${name}の前提を変える` : `${before}の前提を仮に戻す`, (tx) => tx.updateNode(root.id, { meta }));
  if (ok && !app.store.readOnly) toast(next ? `${name}の前提を変えました` : `${before}の前提を仮に戻しました`, { tone: "ok", action: app.cmd.undoAction() });
  return ok;
}

/** 「ゴール 資産 10 億円・2056 年まで（前提 5 つは仮）［変える］」と、その場で入れる欄 */
export function goalWidget(app: AppContext): { el: HTMLElement; update(imp: ImpactResult): void } {
  const name = h("b", { class: "goal-name" });
  const by = h("span", { class: "goal-by" });
  const kari = h("span", { class: "imp-kari" });
  const change = h("button", { class: "imp-link goal-change", type: "button", title: "資産のゴールの前提を入れる・変える", dataset: { fk: "goal" } }, "変える");
  const view = h("div", { class: "goal-view" }, h("span", null, "ゴール"), name, by, kari, change);
  const fieldsBox = h("div", { class: "goal-fields" });
  const ok = h("button", { class: "btn btn-sm btn-primary", type: "button", dataset: { fk: "goal-ok" } }, "決める");
  const cancel = h("button", { class: "btn btn-sm btn-ghost", type: "button", dataset: { fk: "goal-cancel" } }, "やめる");
  const reset = h("button", { class: "imp-link", type: "button", title: "どの前提も仮の値で計算する", dataset: { fk: "goal-reset" } }, "すべて仮に戻す");
  const ro = h("div", { class: "goal-ro" }, "閲覧のみのため変えられません");
  const err = h("div", { class: "goal-err", role: "alert" });
  const edit = h("div", { class: "goal-edit", attrs: { role: "group", "aria-label": "資産のゴールの前提" } }, fieldsBox, h("div", { class: "goal-btns" }, ok, cancel, reset), ro, err);
  edit.hidden = true;
  // 版 6 の地図の帯（アプリの計算の行き先から。3 か月ごとの地図では出さない: 見取り図と今日のカードに出す）
  const strip = h("div", { class: "goal-imp-strip" });
  strip.hidden = true;
  let stripKey = "";
  const el = h("div", { class: "goal-wrap" }, view, edit, strip);
  let fields: GoalField[] = [];
  const inputs = new Map<GoalKey, HTMLInputElement>();

  /** 欄を今の前提で作り直す（開くたび: 期限の範囲は地図の年月で変わる） */
  const build = (): void => {
    const root = rootOf(app);
    const anchor = anchorOf(app, root);
    const { cfg, assumed } = goalConfigOf(root);
    fields = goalFields(anchor);
    inputs.clear();
    fieldsBox.replaceChildren();
    const readOnly = app.store.readOnly;
    for (const f of fields) {
      const id = `goal-in-${f.key}`;
      const input = h("input", {
        class: "input input-sm goal-input",
        type: "text",
        dataset: { fk: `goal-${f.key}` },
        placeholder: goalFieldPlaceholder(f, anchor),
        value: goalFieldValue(f, cfg, assumed, anchor),
        disabled: readOnly,
        // 事業の伸びはマイナスも入れる（数字だけの鍵盤にはマイナスが無いことがある）
        attrs: { id, inputmode: f.key === "bizGrow" ? "text" : "decimal", autocomplete: "off", maxlength: "16", "aria-describedby": `${id}-hint` },
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
      inputs.set(f.key, input);
      fieldsBox.append(
        h(
          "div",
          { class: "goal-field" },
          h("label", { class: "goal-field-label", attrs: { for: id } }, f.label),
          input,
          h("span", { class: "goal-field-unit" }, f.unit),
          h("span", { class: "goal-field-hint", attrs: { id: `${id}-hint` } }, f.hint),
        ),
      );
    }
    ok.disabled = readOnly;
    reset.hidden = readOnly || assumed.size === 6;
    ro.hidden = !readOnly;
  };
  const open = (field?: GoalKey): void => {
    build();
    view.hidden = true;
    edit.hidden = false;
    err.textContent = "";
    const target = (field && inputs.get(field)) || inputs.values().next().value;
    if (target && !target.disabled) {
      target.focus();
      target.select();
    } else cancel.focus();
  };
  const close = (): void => {
    const a = document.activeElement;
    const had = !!a && edit.contains(a);
    edit.hidden = true;
    view.hidden = false;
    err.textContent = "";
    if (had) change.focus();
  };
  const submit = (): void => {
    if (app.store.readOnly) return;
    const raw: Partial<Record<GoalKey, string>> = {};
    for (const [k, input] of inputs) raw[k] = input.value;
    const r = goalFromInputs(fields, raw);
    if (!r.ok) {
      err.textContent = r.error;
      inputs.get(r.key)?.focus();
      return;
    }
    close();
    applyGoal(app, r.stored);
  };
  change.addEventListener("click", () => open());
  ok.addEventListener("click", submit);
  cancel.addEventListener("click", close);
  reset.addEventListener("click", () => {
    close();
    applyGoal(app, null);
  });
  goalFocus = open;
  listenGoalButtons(app);
  return {
    el,
    update(imp) {
      const root = rootOf(app);
      el.hidden = !root;
      if (!root) return;
      const anchor = anchorOf(app, root);
      const { cfg, assumed } = goalConfigOf(root);
      const row = goalViewRow(cfg, assumed, anchor);
      name.textContent = row.name;
      by.textContent = row.by;
      kari.textContent = row.kari ?? "";
      kari.hidden = !row.kari;
      if (!edit.hidden && app.store.readOnly) build();
      goalFocus = open;
      refreshGoalViews(app);
      const vm = impactStripOf(app, imp);
      strip.hidden = !vm;
      if (!vm) stripKey = "";
      else if (vm.key !== stripKey) {
        stripKey = vm.key;
        const was = strip.querySelector("details");
        const fresh = goalStripEl(vm);
        // 見取り図の帯と同じ形だが、見取り図の数では埋めない（data-goal-key を外す）
        delete fresh.dataset.goalKey;
        fresh.dataset.goalImp = vm.key;
        if (was) (fresh.querySelector("details") as HTMLDetailsElement).open = (was as HTMLDetailsElement).open;
        strip.replaceChildren(fresh);
      }
    },
  };
}

/** 概要を出して前提の欄を開く（帯の「前提を変える」「入れる」・ほかの入口）。field の欄にフォーカス */
export function openGoalEditor(app: AppContext, field?: GoalKey): void {
  app.ui.closeDeep();
  app.ui.clearSelection();
  if (!app.ui.prefs.rightOpen) app.ui.setPrefs({ rightOpen: true });
  // 選択を外すと右のパネルは概要に作り直される。その後で欄を開く
  requestAnimationFrame(() => {
    goalFocus?.(field);
    document.querySelector(".goal-edit:not([hidden])")?.scrollIntoView({ block: "nearest" });
  });
}

/** 帯・道の終わりの「前提を変える」「入れる」（data-goal-act）を受ける（アプリごとに 1 回） */
const listening = new WeakSet<AppContext>();
function listenGoalButtons(app: AppContext): void {
  if (listening.has(app) || typeof document === "undefined") return;
  listening.add(app);
  document.addEventListener("click", (ev) => {
    const b = (ev.target as Element | null)?.closest?.<HTMLElement>("[data-goal-act='edit']");
    if (!b) return;
    ev.preventDefault();
    const f = b.dataset.goalField as GoalKey | undefined;
    openGoalEditor(app, f || undefined);
  });
}

/** 見取り図の帯などを埋め直すのを待っている計算 */
const pending = new WeakSet<Analysis>();

/**
 * 見取り図の帯・芽の札・注・今日の欄の 1 行を、今の前提の数に埋め直す（鍵が同じ物は触らない）。数ができていなければ
 * 空いた時間に 1 回作って埋める（起動の最初の絵には入れない）
 */
export function refreshGoalViews(app: AppContext): void {
  if (typeof document === "undefined" || !document.querySelector(".dm-goal[data-goal-key]")) return;
  const ctx = app.vm.deep.get();
  if (!ctx) return;
  const a = ctx.analysis();
  const fill = (compute: boolean): void => {
    const view = goalViewOf(a, compute);
    if (!view) return;
    // どの場所も今の数なら何もしない（題名の 1 文字などの変更で数の形を作らない）
    const key = goalViewKey(view);
    let stale = false;
    for (const el of document.querySelectorAll<HTMLElement>("[data-goal-key]")) if (el.dataset.goalKey !== key) stale = true;
    if (!stale) return;
    // 手の名前は見取り図の行と同じ（文書のカードの題名）
    fillGoalSlots(document, goalOverviewVM(a, view, { name: (n) => ctx.text().title(n) }));
  };
  if (goalViewOf(a, false)) {
    fill(false);
    return;
  }
  if (pending.has(a)) return;
  pending.add(a);
  whenIdle(() => {
    pending.delete(a);
    // その間に作り直された（別の計算）なら、次の更新に任せる
    if (app.vm.deep.get()?.analysis() !== a) return;
    fill(true);
  });
}

// ---------------------------------------------------------------- 版 6 の地図の帯・詳細の欄

/** 計算の結果ごとの番号（帯の鍵） */
const impIds = new WeakMap<ImpactResult, number>();
let impNext = 1;

/** 3 か月ごとの地図の見取り図の数がある（版 7: 入口に年月があるか、見取り図の計算がある） */
function hasDeep(app: AppContext, imp: ImpactResult): boolean {
  const root = imp.root ? app.store.doc.nodes[imp.root] : undefined;
  return typeof root?.meta?.anchor === "string" || (imp.likeBasis && !!app.vm.deep.get());
}

/** 版 6 の地図の見出しの帯（3 か月ごとの地図・行き先の無い地図では null） */
function impactStripOf(app: AppContext, imp: ImpactResult): ReturnType<typeof goalStripVM> | null {
  if (!imp.active || hasDeep(app, imp)) return null;
  const g = goalCtxOf(app.store.doc, imp);
  if (!g) return null;
  let id = impIds.get(imp);
  if (id === undefined) impIds.set(imp, (id = impNext++));
  const key = `imp${id}|${g.t.key}|${[...g.read.assumed].sort().join(",")}`;
  const x = goalImpactStripInput(imp, app.store.doc, g, key);
  return x ? goalStripVM(x) : null;
}

/** 詳細の欄の「10 億」の 1 行（行き先・途中のカード。数が出せなければ null）。「前提を変える」つき */
export function goalFactEl(app: AppContext, imp: ImpactResult, id: string): HTMLElement | null {
  const g = goalCtxOf(app.store.doc, imp);
  const text = g ? goalFactOf(g.t, imp, app.store.doc, id) : null;
  if (!g || !text) return null;
  const name = formatOku(g.t.T).replace(/円$/, "");
  return h(
    "li",
    { class: "goal-fact" },
    h("b", { class: "goal-fact-k" }, name),
    " ",
    text,
    " ",
    h("button", { class: "imp-link goal-change", type: "button", title: "資産のゴールの前提を変える", dataset: { fk: "goal-fact" }, onClick: () => openGoalEditor(app) }, "前提を変える"),
  );
}

/** 今日のカードの詳細の帯（3 か月ごとの地図: 見取り図と同じ帯。数ができていなければ場所だけ置き、空いた時間に埋める）。版 6 は見出しにあるので null */
export function goalRootStripEl(app: AppContext, imp: ImpactResult): HTMLElement | null {
  const ctx = imp.likeBasis ? app.vm.deep.get() : null;
  if (!ctx) return null;
  const a = ctx.analysis();
  const view = goalViewOf(a, false);
  if (view) return goalStripEl(goalOverviewVM(a, view).strip);
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => refreshGoalViews(app));
  return goalSkeletonEl();
}
