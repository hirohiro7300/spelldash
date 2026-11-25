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
import type { DeepCtx } from "../app/deepState";
import { whenIdleWeak } from "../app/idle";
import { goalViewOf, type Analysis } from "../deepmap/core";
import { fillGoalSlots, goalOverviewVM, goalSkeletonEl, goalStripEl, goalStripVM, goalViewKey } from "../deepmap/views";
import { formatGoalShare, formatOku, goalAnchor, goalAnchorOfRoot, goalConfigOf, type GoalKey, type GoalStored } from "../model/goal";
import { goalCtxOf, goalFactOf, goalImpactStrip } from "../model/goalImpact";
import { goalEditorStale, goalFieldPlaceholder, goalFields, goalFieldValue, goalFromInputs, goalViewRow, sameGoal, type GoalField } from "../model/goalForm";
import type { GoalMoveTag, GoalRailHost, GoalRailInfo } from "../canvas/goalRail";
import type { ImpactResult } from "../model/impact";
import type { GNode, ID } from "../model/types";
import { h, isImeKey } from "./dom";
import { toast } from "./overlays";

/** 「変える」で欄を開く（概要を作ったときに差し替わる） */
let goalFocus: ((field?: GoalKey) => void) | null = null;

/**
 * 地図の 0 か月目（入口の meta.anchor。無ければ 3 か月ごとの地図の年月。どちらも無ければ入口の期限 = 版 6 の地図を作った月。
 * それも無ければ今月から数える）
 */
function anchorOf(app: AppContext, root: GNode | undefined): ReturnType<typeof goalAnchor> {
  const a = root?.meta?.anchor;
  if (typeof a === "string") return goalAnchor(a);
  const deep = goalAnchor(app.vm.deep.get()?.map.header.anchor);
  return deep.clock ? goalAnchorOfRoot(root) : deep;
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
  const kari = h("span", { class: "goal-kari" });
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
  /** 欄を作ったときに閲覧のみだったか（変わったら作り直す: 書けるようになったタブで欄が止まったままにならない） */
  let builtRo = false;

  /** 欄を今の前提で作り直す（開くたび: 期限の範囲は地図の年月で変わる）。keep は入れかけの文字（作り直しても残す） */
  const build = (keep?: ReadonlyMap<GoalKey, string>): void => {
    const root = rootOf(app);
    const anchor = anchorOf(app, root);
    const { cfg, assumed } = goalConfigOf(root);
    fields = goalFields(anchor);
    inputs.clear();
    fieldsBox.replaceChildren();
    const readOnly = app.store.readOnly;
    builtRo = readOnly;
    for (const f of fields) {
      const id = `goal-in-${f.key}`;
      const input = h("input", {
        class: "input input-sm goal-input",
        type: "text",
        dataset: { fk: `goal-${f.key}` },
        placeholder: goalFieldPlaceholder(f, anchor),
        value: keep?.get(f.key) ?? goalFieldValue(f, cfg, assumed, anchor),
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
    // 版 6 の帯があるときは見出しの行を出さない（goal.css）: 帯の「くわしく」へ戻す
    if (had) ((el.classList.contains("has-strip") && el.querySelector<HTMLElement>(".goal-imp-strip summary")) || change).focus();
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
      if (goalEditorStale(!edit.hidden, builtRo, app.store.readOnly)) {
        // 入れかけの文字と、どの欄にいたかは残す
        const keep = new Map([...inputs].map(([k, x]) => [k, x.value] as const));
        const at = [...inputs].find(([, x]) => x === document.activeElement)?.[0];
        const wasCancel = document.activeElement === cancel;
        build(keep);
        const back = at ? inputs.get(at) : wasCancel && !app.store.readOnly ? inputs.values().next().value : undefined;
        if (back && !back.disabled) back.focus();
        else if (at || wasCancel) cancel.focus();
      }
      goalFocus = open;
      refreshGoalViews(app);
      const vm = impactStripOf(app, imp);
      strip.hidden = !vm;
      // 帯があれば、見出しの行は帯の 1 行目が言う（同じ事を 2 度言わず、スマホの引き出しで今決めることの 10 行を押し下げない: goal.css）
      el.classList.toggle("has-strip", !!vm);
      if (!vm) stripKey = "";
      else if (vm.key !== stripKey) {
        stripKey = vm.key;
        const was = strip.querySelector("details");
        const fresh = goalStripEl(vm);
        // 見取り図の帯と同じ形だが、見取り図の数では埋めない（data-goal-key を外す）
        delete fresh.dataset.goalKey;
        // 見出しの行に期限の年がある（帯の 1 行目）: 棒の横は「約 0.44 億円（4%）・目安」だけ
        const bt = fresh.querySelector<HTMLElement>(".dm-goal-bartext");
        if (bt) bt.textContent = vm.barText.replace(/^\d+ 年に/, "");
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
 * 空いた時間に 1 回作って埋める（起動の最初の絵には入れない）。待つ間は計算を弱く持つ（前は待つ関数が計算と画面に渡す物を
 * 持ち、続けて選ぶと前の計算が残った）
 */
export function refreshGoalViews(app: AppContext): void {
  if (typeof document === "undefined" || !document.querySelector(".dm-goal[data-goal-key]")) return;
  const ctx = app.vm.deep.get();
  if (!ctx) return;
  const a = ctx.analysis();
  if (goalViewOf(a, false)) {
    fillGoalViews(ctx, a, false);
    return;
  }
  if (pending.has(a)) return;
  pending.add(a);
  whenIdleWeak(a, (an) => {
    pending.delete(an);
    // その間に作り直された（別の計算）なら、次の更新に任せる
    const cur = app.vm.deep.get();
    if (!cur || cur.analysis() !== an) return;
    fillGoalViews(cur, an, true);
  });
}

/** 見取り図の帯などを、計算 a の今の前提の数で埋める（どの場所も今の数なら何もしない: 題名の 1 文字などの変更で数の形を作らない） */
function fillGoalViews(ctx: DeepCtx, a: Analysis, compute: boolean): void {
  const view = goalViewOf(a, compute);
  if (!view) return;
  const key = goalViewKey(view);
  let stale = false;
  for (const el of document.querySelectorAll<HTMLElement>("[data-goal-key]")) if (el.dataset.goalKey !== key) stale = true;
  if (!stale) return;
  // 手の名前は見取り図の行と同じ（文書のカードの題名）
  fillGoalSlots(document, goalOverviewVM(a, view, { name: (n) => ctx.text().title(n) }));
}

// ---------------------------------------------------------------- 版 6 の地図の帯・詳細の欄

/** 計算の結果ごとの番号（帯の鍵） */
const impIds = new WeakMap<ImpactResult, number>();
let impNext = 1;
/** 前提ごとの番号（帯の鍵に前提の数を入れない） */
const tableIds = new Map<string, number>();
let tableNext = 1;

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
  // 鍵に前提の数そのもの（今の資産など）を入れない: 同じ前提に同じ番号（見直し data-4）
  let tid = tableIds.get(g.t.key);
  if (tid === undefined) tableIds.set(g.t.key, (tid = tableNext++));
  const key = `imp${id}|t${tid}|${[...g.read.assumed].sort().join(",")}`;
  // 結果と前提が同じなら前の帯（見出しは概要を描き直すたびに呼ばれる: 行き先をなめ直さない）
  return goalImpactStrip(imp, app.store.doc, g, key, goalStripVM);
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

// ---------------------------------------------------------------- 地図のゴールのカード（src/canvas/goalRail.ts）

/**
 * 地図のいちばん右のゴールのカード・札の数（3 か月ごとの地図の見取り図と同じ数: おすすめの選び方の期限の年の資産の真ん中）。
 * 描くフレームの中では作らない（compute が false: 作ってある物だけ。計算か前提が変わった後は前の数に別の鍵を付けて返し、
 * 空いた時間に compute を true で呼び直してもらう）。押すと前提の欄を開く
 */
export function goalRailHost(app: AppContext): GoalRailHost {
  let memo: { ctx: unknown; raw: unknown; info: GoalRailInfo; imp: unknown; root: unknown } | null = null;
  return {
    info(compute) {
      // 描くたびに呼ばれる: 計算の結果と入口のカードが前と同じなら、地図の画面に渡す物（deep.get）を引かずに前の数
      const imp = app.vm.impact;
      const rootNode = imp.active && imp.root ? app.store.doc.nodes[imp.root] : undefined;
      if (memo && memo.imp === imp && memo.root === rootNode) return memo.info;
      const ctx = app.vm.deep.get();
      if (!ctx) return null;
      const raw = app.store.doc.nodes[ctx.root]?.meta?.goal;
      if (memo && memo.ctx === ctx && memo.raw === raw) {
        memo.imp = imp;
        memo.root = rootNode;
        return memo.info;
      }
      if (!compute) return memo ? { ...memo.info, key: `${memo.info.key}|old` } : null;
      const view = goalViewOf(ctx.analysis(), true);
      if (!view) return null;
      const s = view.summary;
      const scope = s.pi ?? s.keep;
      const mid = scope?.atBy?.p50 ?? null;
      const byKari = view.read.assumed.has("by");
      // どの選び方の数か（おすすめの選び方・無ければずっと今のまま: カードの「おすすめの道」「今のまま」。見直し reader-3）
      const path: GoalRailInfo["path"] = s.pi ? "pi" : s.keep ? "keep" : null;
      // 今日の手のカードの芽の札（見取り図の「10 の手をひと目で」の芽の札と同じ言葉: 見直し reader-4）
      const moves = new Map<ID, GoalMoveTag>();
      for (const m of s.moves) {
        const text = m.seed > 0 ? `芽 ${formatGoalShare(m.seed)}` : m.choiceOnly ? "芽: 選び方" : null;
        if (text) moves.set(ctx.idOf(m.node), { text, share: m.seed > 0 ? m.seed : 0 });
      }
      // 鍵は数そのもの（選び方の計算の入れ物が作り直されても、同じ数なら同じ鍵: カードの文字を書き直さない）
      const info: GoalRailInfo = { key: `${s.tables.T}|${s.tables.by}|${byKari ? 1 : 0}|${path ?? "-"}|${mid === null ? "-" : mid.toFixed(1)}`, T: s.tables.T, by: s.tables.by, byKari, mid, path, moves };
      memo = { ctx, raw, info, imp, root: rootNode };
      return info;
    },
    open: () => openGoalEditor(app),
  };
}
