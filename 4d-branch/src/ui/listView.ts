// リスト表示: 表でノードを一覧（見えている行だけ作る＝ 2,000 件でも軽い）。並べ替え・選択・マップへ移動

import type { AppContext } from "../app/context";
import type { ListSortKey } from "../app/uiState";
import { NODE_TYPES, NODE_TYPE_ORDER, STATUSES, STATUS_ORDER } from "../model/constants";
import { formatDate, relativeDue } from "../model/dates";
import type { GNode, ID } from "../model/types";
import { clear, h } from "./dom";
import { icon } from "./icons";

const ROW_H = 44;

export function buildListView(app: AppContext): HTMLElement {
  const { store, ui, vm } = app;
  const head = h("div", { class: "list-head", role: "row" });
  const spacer = h("div", { class: "list-spacer" });
  const rowsEl = h("div", { class: "list-rows", role: "rowgroup" });
  const scroller = h("div", { class: "list-scroll" }, head, h("div", { class: "list-body" }, spacer, rowsEl));
  const empty = h("div", { class: "list-empty" }, "表示できるノードがありません（絞り込み・検索・シナリオを確かめてください）");
  const root = h("div", { class: "list-view", role: "table", ariaLabel: "ノードの一覧" }, scroller, empty);
  let ids: ID[] = [];

  const cols: Array<{ key: ListSortKey | null; label: string; cls: string }> = [
    { key: "type", label: "種類", cls: "c-type" },
    { key: "title", label: "タイトル", cls: "c-title" },
    { key: null, label: "プロジェクト", cls: "c-proj" },
    { key: "due", label: "期限", cls: "c-due" },
    { key: "status", label: "状態", cls: "c-status" },
    { key: null, label: "タグ", cls: "c-tags" },
    { key: null, label: "つながり", cls: "c-conn" },
    { key: "updated", label: "更新", cls: "c-upd" },
  ];

  const renderHead = () => {
    clear(head);
    const s = ui.prefs.listSort;
    for (const c of cols) {
      const b = h("button", { class: `list-th ${c.cls}${c.key === s.key ? " sorted" : ""}`, type: "button", disabled: !c.key, role: "columnheader" }, c.label, c.key === s.key ? icon(s.dir === 1 ? "expand" : "collapse", 12) : null);
      if (c.key) {
        const key = c.key;
        b.addEventListener("click", () => ui.setPrefs({ listSort: { key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 } }));
      }
      head.append(b);
    }
  };

  const compute = () => {
    vm.ensure();
    const doc = store.doc;
    const filter = ui.prefs.projectFilter.filter((p) => doc.projects[p]);
    ids = vm.drawNodes.filter((id) => {
      const v = vm.nodes.get(id)!;
      if (filter.length && !v.inProject) return false;
      if (vm.searchActive && !v.match) return false;
      return true;
    });
    const { key, dir } = ui.prefs.listSort;
    const val = (n: GNode): string | number => {
      switch (key) {
        case "due":
          return n.time.due ?? "9999-99-99";
        case "title":
          return n.title;
        case "type":
          return NODE_TYPE_ORDER.indexOf(n.type);
        case "status":
          return STATUS_ORDER.indexOf(n.status);
        case "updated":
          return n.updatedAt;
      }
    };
    ids.sort((a, b) => {
      const na = doc.nodes[a]!;
      const nb = doc.nodes[b]!;
      const va = val(na);
      const vb = val(nb);
      const c = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb), "ja");
      return c * dir || na.title.localeCompare(nb.title, "ja");
    });
    spacer.style.height = `${ids.length * ROW_H}px`;
    empty.hidden = ids.length > 0;
    renderRows();
  };

  const renderRows = () => {
    const doc = store.doc;
    const top = Math.max(0, scroller.scrollTop - head.offsetHeight);
    const hgt = scroller.clientHeight || 600;
    const first = Math.max(0, Math.floor(top / ROW_H) - 6);
    const last = Math.min(ids.length, Math.ceil((top + hgt) / ROW_H) + 6);
    clear(rowsEl);
    rowsEl.style.transform = `translateY(${first * ROW_H}px)`;
    for (let i = first; i < last; i++) {
      const id = ids[i]!;
      const n = doc.nodes[id]!;
      const v = vm.nodes.get(id)!;
      const rel = relativeDue(n.time.due);
      const ins = vm.index.inc.get(id)?.length ?? 0;
      const outs = vm.index.out.get(id)?.length ?? 0;
      const row = h(
        "div",
        { class: `list-row${ui.selection.nodes.has(id) ? " selected" : ""}`, role: "row", tabIndex: -1, style: { opacity: String(Math.max(0.45, v.alpha)) } },
        h("span", { class: "list-td c-type" }, h("span", { class: `type-chip type-${n.type}` }, icon(n.type, 13)), h("span", { class: "type-name" }, NODE_TYPES[n.type].label)),
        h("span", { class: "list-td c-title", title: n.title }, n.title || "（無題）"),
        h("span", { class: "list-td c-proj" }, ...n.projectIds.map((p) => doc.projects[p]).filter((p) => !!p).map((p) => h("span", { class: "proj-pill small", style: { "--c": p!.color } }, h("span", { class: "dot", style: { background: p!.color } }), p!.name))),
        h("span", { class: `list-td c-due tone-${n.status === "done" ? "done" : (rel?.tone ?? "none")}` }, n.time.due ? formatDate(n.time.due) : "—", rel && n.status !== "done" ? h("small", null, rel.text) : null),
        h("span", { class: "list-td c-status" }, h("span", { class: "status-pill", style: { "--c": STATUSES[n.status].color } }, STATUSES[n.status].label)),
        h("span", { class: "list-td c-tags" }, n.tags.slice(0, 3).map((t) => `#${t}`).join(" ")),
        h("span", { class: "list-td c-conn", title: `入る ${ins}・出る ${outs}` }, `←${ins} →${outs}`),
        h("span", { class: "list-td c-upd" }, new Date(n.updatedAt).toLocaleDateString("ja-JP")),
      );
      row.addEventListener("click", (ev) => {
        if (ev.metaKey || ev.ctrlKey || ev.shiftKey) ui.toggleNode(id);
        else ui.select([id]);
      });
      row.addEventListener("dblclick", () => {
        ui.select([id]);
        ui.setPrefs({ view: "map" });
        requestAnimationFrame(() => app.view.centerOn(id));
      });
      rowsEl.append(row);
    }
  };

  scroller.addEventListener("scroll", () => requestAnimationFrame(renderRows), { passive: true });
  const refresh = () => {
    if (root.hidden) return;
    renderHead();
    compute();
  };
  store.on("change", refresh);
  ui.on("visual", refresh);
  ui.on("prefs", refresh);
  app.revealInList = (id: ID) => {
    const i = ids.indexOf(id);
    if (i >= 0) scroller.scrollTop = Math.max(0, i * ROW_H - scroller.clientHeight / 2);
    refresh();
  };
  app.refreshList = refresh;
  return root;
}
