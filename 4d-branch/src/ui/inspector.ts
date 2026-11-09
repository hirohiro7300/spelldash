// 右: 選んだノード・接続の詳細（文章・期限・条件・タグ・プロジェクト・シナリオ・つながり）
// 入力中の欄は上書きしない（ストアの変更では値だけ合わせ、選択が変わったときだけ作り直す）

import type { AppContext } from "../app/context";
import { onlyTimeCursor } from "../app/uiState";
import { NODE_TYPES, NODE_TYPE_ORDER, RELATIONS, RELATION_ORDER, STATUSES, STATUS_ORDER } from "../model/constants";
import { MAX_YEAR, MIN_YEAR, formatDate, normalizeDateStr, relativeDue } from "../model/dates";
import type { GEdge, GNode, ID } from "../model/types";
import { MOD, autosize, clear, h, isImeKey, setValue } from "./dom";
import { icon } from "./icons";
import { toast } from "./overlays";

type Updater = () => void;

export function buildInspector(app: AppContext): HTMLElement {
  const { store, ui } = app;
  const headTitle = h("span", { class: "insp-head-title" }, "詳細");
  const headSub = h("span", { class: "insp-head-sub" });
  const body = h("div", { class: "insp-body-scroll" });
  const root = h("aside", { class: "sidebar sidebar-right", ariaLabel: "詳細" }, h("div", { class: "insp-head" }, headTitle, headSub), body);
  let key = "";
  let updaters: Updater[] = [];

  const selKey = () => {
    const s = ui.selection;
    if (s.nodes.size === 0 && s.edges.size === 0) return "none";
    if (s.nodes.size === 1 && s.edges.size === 0) return `node:${[...s.nodes][0]}`;
    if (s.edges.size === 1 && s.nodes.size === 0) return `edge:${[...s.edges][0]}`;
    return `multi:${[...s.nodes].sort().join(",")}|${[...s.edges].sort().join(",")}`;
  };

  const render = (force = false) => {
    const k = selKey();
    if (k === key && !force) {
      for (const u of updaters) u();
      return;
    }
    key = k;
    updaters = [];
    clear(body);
    const doc = store.doc;
    if (k.startsWith("node:")) {
      const id = k.slice(5);
      if (doc.nodes[id]) nodePanel(app, id, body, (u) => updaters.push(u));
    } else if (k.startsWith("edge:")) {
      const id = k.slice(5);
      if (doc.edges[id]) edgePanel(app, id, body, (u) => updaters.push(u));
    } else if (k.startsWith("multi:")) multiPanel(app, body, (u) => updaters.push(u));
    else overviewPanel(app, body, (u) => updaters.push(u));
    headTitle.textContent = k === "none" ? "概要" : k.startsWith("edge:") ? "接続の詳細" : k.startsWith("multi:") ? "まとめて編集" : "ノードの詳細";
    headSub.textContent = store.readOnly ? "閲覧のみ" : "";
    for (const u of updaters) u();
  };

  ui.on("selection", () => render());
  store.on("change", (info) => {
    // 消えた要素を選んでいたら外す
    ui.pruneSelection((kind, id) => (kind === "node" ? !!store.doc.nodes[id] : !!store.doc.edges[id]));
    if (info.full) render(true);
    else render();
  });
  ui.on("prefs", (p) => {
    if (!onlyTimeCursor(p)) render();
  });
  app.persistence.on("writer", () => render(true));
  app.focusInspectorTitle = () => {
    const t = body.querySelector<HTMLTextAreaElement>(".insp-title");
    t?.focus();
    t?.select();
  };
  app.focusEdgeCondition = () => {
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

/** 入力のたびに保存し、続けての入力は Undo 1 回にまとめる。欄を離れたらまとめを切る */
function bindText(app: AppContext, el: HTMLInputElement | HTMLTextAreaElement, write: (v: string) => void): void {
  el.addEventListener("input", () => {
    if (el instanceof HTMLTextAreaElement) autosize(el);
    write(el.value);
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
  const sel = h("select", { class: "input select-status", attrs: { "aria-label": "状態" } });
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

function nodePanel(app: AppContext, id: ID, root: HTMLElement, push: (u: Updater) => void): void {
  const { store, cmd, ui, vm } = app;
  const node = () => store.doc.nodes[id];
  const ro = () => store.readOnly;
  const wrap = h("div", { class: "insp-node" });
  root.append(wrap);

  // 種類
  wrap.append(typePicker(app, () => node()?.type ?? null, (t) => cmd.setType([id], t), push));
  const status = statusSelect(app, () => node()?.status ?? null, (s) => cmd.setStatus([id], s), push);

  // タイトル
  const title = h("textarea", { class: "insp-title", placeholder: "タイトル", attrs: { rows: "1", "aria-label": "タイトル", spellcheck: "false" } });
  bindText(app, title, (v) => cmd.updateNode(id, { title: v.replace(/\n/g, " ") }, { label: "タイトルを編集", coalesce: `title:${id}` }));
  title.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !isImeKey(ev)) {
      ev.preventDefault();
      title.blur();
    }
  });
  wrap.append(title);

  const projLine = h("div", { class: "insp-projline" });
  wrap.append(h("div", { class: "insp-meta" }, status, projLine));

  // 文章
  const bodyTa = h("textarea", { class: "input insp-text", placeholder: "メモ・背景・外部の AI と考えたこと…", attrs: { rows: "3", "aria-label": "文章" } });
  bindText(app, bodyTa, (v) => cmd.updateNode(id, { body: v }, { label: "文章を編集", coalesce: `body:${id}` }));
  wrap.append(sectionEl("文章", bodyTa));

  // 期限
  const n0 = node()!;
  const due = dateInput(n0.time.due, (v) => cmd.updateNode(id, { time: { ...node()!.time, due: v } }, { label: v ? "期限を設定" : "期限を外す" }), "期限");
  const start = dateInput(n0.time.start, (v) => cmd.updateNode(id, { time: { ...node()!.time, start: v } }, { label: v ? "開始日を設定" : "開始日を外す" }), "開始日");
  const clearDue = h("button", { class: "icon-btn icon-btn-xs", type: "button", title: "期限を外す", ariaLabel: "期限を外す", onClick: () => cmd.updateNode(id, { time: { ...node()!.time, due: null } }, { label: "期限を外す" }) }, icon("x", 13));
  const rel = h("span", { class: "due-rel" });
  const dates = h(
    "div",
    { class: "insp-dates" },
    h("label", { class: "date-field" }, h("span", { class: "date-label" }, "期限"), due, clearDue),
    h("label", { class: "date-field" }, h("span", { class: "date-label" }, "開始"), start),
    rel,
  );
  wrap.append(sectionEl("時間", dates));

  // 条件
  const condCount = h("span", { class: "insp-count" });
  const condList = h("div", { class: "cond-list" });
  const condAdd = h("input", { class: "input input-sm", placeholder: "条件を追加（Enter）", attrs: { "aria-label": "条件を追加" } });
  condAdd.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !isImeKey(ev) && condAdd.value.trim()) {
      ev.preventDefault();
      cmd.addCondition(id, condAdd.value);
      condAdd.value = "";
    }
  });
  const condSec = sectionEl("条件", condList, condAdd);
  condSec.querySelector(".insp-label")!.append(condCount);
  wrap.append(condSec);
  const condRows = new Map<ID, { row: HTMLElement; box: HTMLInputElement; text: HTMLInputElement }>();

  // タグ
  const tagWrap = h("div", { class: "tag-edit" });
  const tagInput = h("input", { class: "tag-input", placeholder: "タグを追加", attrs: { "aria-label": "タグを追加", list: "tag-suggestions" } });
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

  // 操作
  const dupBtn = h("button", { class: "btn btn-sm", type: "button", title: `複製（${MOD}D）`, onClick: () => cmd.duplicate([id]) }, icon("copy", 14), "複製");
  const colBtn = h("button", { class: "btn btn-sm", type: "button", title: "この先を折りたたむ（C）", onClick: () => cmd.toggleCollapse([id]) }, icon("collapse", 14), h("span", null, "折りたたむ"));
  const delBtn = h("button", { class: "btn btn-sm btn-danger-ghost", type: "button", title: "削除（Delete）", onClick: () => cmd.deleteNodes([id]) }, icon("trash", 14), "削除");
  const foot = h("div", { class: "insp-foot" });
  wrap.append(h("div", { class: "insp-actions" }, dupBtn, colBtn, delBtn), foot);

  push(() => {
    const n = node();
    if (!n) return;
    const doc = store.doc;
    wrap.style.setProperty("--type-color", NODE_TYPES[n.type].color);
    setValue(title, n.title);
    autosize(title, 140);
    setValue(bodyTa, n.body);
    autosize(bodyTa);
    for (const el of [title, bodyTa, due, start, condAdd, tagInput]) el.disabled = ro();
    setValue(due, n.time.due ?? "");
    setValue(start, n.time.start ?? "");
    clearDue.hidden = !n.time.due;
    const r = relativeDue(n.time.due);
    rel.textContent = r ? (n.status === "done" ? `完了（期限 ${formatDate(n.time.due)}）` : r.text) : "期限なし";
    rel.dataset.tone = n.status === "done" ? "done" : (r?.tone ?? "none");

    // 所属の一行
    clear(projLine);
    for (const pid of n.projectIds) {
      const p = doc.projects[pid];
      if (p) projLine.append(h("span", { class: "proj-pill", style: { "--c": p.color } }, h("span", { class: "dot", style: { background: p.color } }), p.name));
    }
    if (n.projectIds.length > 1) projLine.append(h("span", { class: "shared-pill", title: "複数のプロジェクトから参照されている共有ノード" }, icon("link", 12), "共有"));
    if (!n.projectIds.length) projLine.append(h("span", { class: "muted-pill" }, "未分類"));

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
        const text = h("input", { class: "cond-text", attrs: { "aria-label": "条件" } });
        bindText(app, text, (v) => cmd.updateCondition(id, c.id, { text: v }, `cond:${c.id}`));
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

    // タグ
    clear(tagWrap);
    for (const t of n.tags) {
      const x = h("button", { class: "tag-x", type: "button", ariaLabel: `${t} を外す`, disabled: ro(), onClick: (ev) => (ev.stopPropagation(), cmd.removeTag(id, t)) }, icon("x", 11, 2.2));
      const chip = h("span", { class: "tag-chip static" }, h("button", { class: "tag-link", type: "button", title: `#${t} で検索`, onClick: () => ui.setSearch(`#${t}`) }, `#${t}`), x);
      tagWrap.append(chip);
    }
    clear(datalist);
    for (const t of vm.index.tags.slice(0, 40)) if (!n.tags.includes(t.tag)) datalist.append(h("option", { value: t.tag }));

    // プロジェクト
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

    // つながり
    clear(conns);
    const ins = vm.index.inc.get(id) ?? [];
    const outs = vm.index.out.get(id) ?? [];
    const connRow = (eid: ID, dir: "in" | "out") => {
      const e = doc.edges[eid]!;
      const other = doc.nodes[dir === "in" ? e.source : e.target]!;
      const relMeta = RELATIONS[e.relation];
      const row = h(
        "div",
        { class: "conn-row" },
        h("span", { class: "conn-dir", title: dir === "in" ? "入る（ここへ至る）" : "出る（ここから進む）" }, icon(dir === "in" ? "arrowLeft" : "arrowRight", 13)),
        h("button", { class: "conn-node", type: "button", title: "このノードへ移動", onClick: () => (ui.select([other.id]), app.view.centerOn(other.id, { onlyIfHidden: true })) }, h("span", { class: `type-chip type-${other.type}` }, icon(other.type, 12)), h("span", { class: "conn-title" }, other.title || "（無題）")),
        h("button", { class: "conn-rel", type: "button", title: `${relMeta.label}${e.condition ? `: ${e.condition}` : ""}（接続を選ぶ）`, style: { "--rel": relMeta.color }, onClick: () => ui.select([], [eid]) }, h("span", { class: "dot", style: { background: relMeta.color } }), relMeta.label),
      );
      if (vm.index.cross.has(eid)) row.classList.add("cross");
      return row;
    };
    if (!ins.length && !outs.length) conns.append(h("div", { class: "muted small" }, "まだつながりがありません。ノード右の ● をドラッグして別のノードへつなぐか、「分岐を追加」で先を作れます。"));
    if (ins.length) conns.append(h("div", { class: "conn-head" }, `入る ${ins.length}`), ...ins.map((e) => connRow(e, "in")));
    if (outs.length) conns.append(h("div", { class: "conn-head" }, `出る ${outs.length}`), ...outs.map((e) => connRow(e, "out")));
    if (ins.length >= 2) conns.prepend(h("div", { class: "merge-note" }, icon("merge", 13), `${ins.length} つの道がここで合流しています`));
    addChild.disabled = ro();
    addTwo.disabled = ro();
    dupBtn.disabled = ro();
    delBtn.disabled = ro();
    colBtn.disabled = ro() || outs.length === 0;
    (colBtn.lastElementChild as HTMLElement).textContent = n.collapsed ? "展開する" : "折りたたむ";
    colBtn.replaceChild(icon(n.collapsed ? "expand" : "collapse", 14), colBtn.firstElementChild!);
    foot.textContent = `作成 ${new Date(n.createdAt).toLocaleDateString("ja-JP")} · 更新 ${new Date(n.updatedAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
  });
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

  const cond = h("textarea", { class: "input insp-text edge-condition", placeholder: "例: 副業の月収 30 万円が 3 か月続いたら", attrs: { rows: "2", "aria-label": "条件" } });
  bindText(app, cond, (v) => cmd.updateEdge(id, { condition: v }, { label: "条件を編集", coalesce: `econd:${id}` }));
  wrap.append(sectionEl("条件（この道に進む条件）", cond));

  const label = h("input", { class: "input", placeholder: "例: 実績が営業材料になる", attrs: { "aria-label": "説明" } });
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
    autosize(cond);
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

function multiPanel(app: AppContext, root: HTMLElement, push: (u: Updater) => void): void {
  const { store, cmd, ui } = app;
  const ids = () => [...ui.selection.nodes].filter((id) => store.doc.nodes[id]);
  const edges = () => [...ui.selection.edges].filter((id) => store.doc.edges[id]);
  const ro = () => store.readOnly;
  const wrap = h("div", { class: "insp-multi" });
  root.append(wrap);
  const head = h("div", { class: "multi-head" });
  const summary = h("div", { class: "type-summary" });
  wrap.append(head, summary);

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

  const tagInput = h("input", { class: "input input-sm", placeholder: "まとめてタグを追加（Enter）", attrs: { "aria-label": "タグを追加" } });
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
  const col = h("button", { class: "btn btn-sm", type: "button", onClick: () => cmd.toggleCollapse(ids()) }, icon("collapse", 14), "折りたたむ");
  const del = h("button", { class: "btn btn-sm btn-danger-ghost", type: "button", onClick: () => cmd.deleteSelection() }, icon("trash", 14), "削除");
  wrap.append(h("div", { class: "insp-actions" }, dup, col, del));

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
    for (const b of [dup, col]) b.disabled = ro() || !ns.length;
    del.disabled = ro();
    tagInput.disabled = ro() || !ns.length;
  });
}

// ------------------------------------------------------------ 何も選んでいない

function overviewPanel(app: AppContext, root: HTMLElement, push: (u: Updater) => void): void {
  const { store, vm, ui } = app;
  const wrap = h("div", { class: "insp-overview" });
  root.append(wrap);
  const stats = h("div", { class: "stat-grid" });
  const bars = h("div", { class: "type-bars" });
  const insight = h("div", { class: "insight" });
  wrap.append(stats, bars, insight);
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
  push(() => {
    vm.ensure();
    const doc = store.doc;
    const nodes = Object.values(doc.nodes);
    clear(stats);
    const stat = (label: string, value: number, hint: string, iconName: string) => h("div", { class: "stat", title: hint }, h("span", { class: "stat-icon" }, icon(iconName, 14)), h("span", { class: "stat-value" }, value.toLocaleString("ja-JP")), h("span", { class: "stat-label" }, label));
    stats.append(
      stat("ノード", nodes.length, "目標・行動・分岐・結果", "layers"),
      stat("接続", Object.keys(doc.edges).length, "方向と関係を持つ線", "link"),
      stat("共有ノード", vm.index.shared.size, "2 つ以上のプロジェクトに属するノード", "merge"),
      stat("プロジェクト間の線", vm.index.cross.size, "別のプロジェクトへ影響する線", "sparkle"),
    );
    clear(bars);
    const total = Math.max(1, nodes.length);
    for (const t of NODE_TYPE_ORDER) {
      const c = nodes.filter((n) => n.type === t).length;
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
    // いちばん多くのプロジェクトに効いている行動（相乗効果の目安。計算はせず、所属と線の数だけ）
    clear(insight);
    const hubs = nodes
      .map((n) => ({ n, reach: new Set([...(vm.index.out.get(n.id) ?? [])].flatMap((eid) => doc.nodes[doc.edges[eid]!.target]!.projectIds)).size, outs: vm.index.out.get(n.id)?.length ?? 0 }))
      .filter((x) => x.n.projectIds.length > 1 || x.reach > 1)
      .sort((a, b) => b.n.projectIds.length + b.reach - (a.n.projectIds.length + a.reach) || b.outs - a.outs)
      .slice(0, 3);
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
