// 左: プロジェクト一覧・シナリオ一覧・タグ・保存の状態

import type { AppContext } from "../app/context";
import { onlyTimeCursor } from "../app/uiState";
import { PROJECT_COLORS, SCENARIO_COLORS } from "../model/constants";
import type { ID } from "../model/types";
import { BACKUP_LABELS } from "../persist/persistence";
import { cloudText } from "./dialogs";
import { MOD, clear, h, isImeKey } from "./dom";
import { icon } from "./icons";
import { menuFromButton, showMenu, type MenuEntry, type MenuItem } from "./overlays";

export function buildLeftSidebar(app: AppContext): HTMLElement {
  const { store, ui, cmd, vm } = app;
  const projectList = h("div", { class: "side-list", role: "listbox", ariaLabel: "プロジェクト" });
  const scenarioList = h("div", { class: "side-list", role: "listbox", ariaLabel: "シナリオ" });
  const tagList = h("div", { class: "tag-cloud" });
  const footer = h("div", { class: "side-footer" });
  let renaming: ID | null = null;

  const section = (key: "projects" | "scenarios" | "tags", title: string, body: HTMLElement, action?: HTMLElement) => {
    const toggle = h("button", { class: "side-head-btn", type: "button", attrs: { "aria-expanded": String(ui.prefs.sections[key]) } }, icon("chevronDown", 13), h("span", null, title));
    toggle.addEventListener("click", () => ui.setPrefs({ sections: { ...ui.prefs.sections, [key]: !ui.prefs.sections[key] } }));
    const sec = h("section", { class: "side-section" }, h("div", { class: "side-head" }, toggle, action ?? null), body);
    sec.dataset.section = key;
    return sec;
  };

  const addProjectBtn = h("button", { class: "icon-btn icon-btn-sm", type: "button", title: "プロジェクトを追加", ariaLabel: "プロジェクトを追加" }, icon("plus", 15));
  addProjectBtn.addEventListener("click", () => {
    const id = cmd.addProject();
    if (id) {
      renaming = id;
      render();
    }
  });
  const addScenarioBtn = h("button", { class: "icon-btn icon-btn-sm", type: "button", title: "シナリオを追加", ariaLabel: "シナリオを追加" }, icon("plus", 15));
  addScenarioBtn.addEventListener("click", () => {
    const id = cmd.addScenario();
    if (id) {
      renaming = id;
      render();
    }
  });

  const root = h(
    "aside",
    { class: "sidebar sidebar-left", ariaLabel: "プロジェクトとシナリオ" },
    h(
      "div",
      { class: "side-scroll" },
      section("projects", "プロジェクト", projectList, addProjectBtn),
      section("scenarios", "シナリオ", scenarioList, addScenarioBtn),
      section("tags", "タグ", tagList),
    ),
    footer,
  );

  const renameInput = (id: ID, kind: "project" | "scenario", current: string) => {
    const input = h("input", { class: "rename-input", value: current, attrs: { "aria-label": "名前", maxlength: "80" } });
    const done = (save: boolean) => {
      if (renaming !== id) return;
      renaming = null;
      const v = input.value.trim();
      if (save && v && v !== current) {
        if (kind === "project") cmd.updateProject(id, { name: v });
        else cmd.updateScenario(id, { name: v });
      }
      render();
    };
    input.addEventListener("keydown", (ev) => {
      // ⌘S・⌘K などはアプリへ通す（ブラウザの「ページを保存」を出さない）。文字の操作はこの欄で
      if (!(ev.metaKey || ev.ctrlKey)) ev.stopPropagation();
      if (isImeKey(ev)) return;
      if (ev.key === "Enter") done(true);
      if (ev.key === "Escape") done(false);
    });
    input.addEventListener("blur", () => done(true));
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
    return input;
  };

  const colorItems = (current: string, palette: string[], set: (c: string) => void): MenuItem[] => palette.map((c) => ({ label: c, swatch: c, checked: c.toUpperCase() === current.toUpperCase(), run: () => set(c) }));

  const projectMenu = (id: ID, at: HTMLElement | { x: number; y: number }) => {
    const p = store.doc.projects[id];
    if (!p) return;
    const ro = store.readOnly;
    const i = store.doc.projectOrder.indexOf(id);
    const entries: MenuEntry[] = [
      { label: "このプロジェクトだけ表示", icon: "eye", run: () => ui.setPrefs({ projectFilter: [id] }) },
      { label: "全体を表示（このプロジェクトに合わせる）", icon: "fit", run: () => app.view.fit(vm.index.projectNodes.get(id) ?? []) },
      "sep",
      { label: "名前を変更", icon: "tag", disabled: ro, run: () => ((renaming = id), render()) },
      { label: "色を変更", icon: "dot", disabled: ro, submenu: colorItems(p.color, PROJECT_COLORS, (c) => cmd.updateProject(id, { color: c })) },
      { label: "説明を編集…", icon: "list", disabled: ro, run: () => app.editDescription("project", id) },
      { label: "上へ", icon: "collapse", disabled: ro || i <= 0, run: () => cmd.moveProject(id, -1) },
      { label: "下へ", icon: "expand", disabled: ro || i >= store.doc.projectOrder.length - 1, run: () => cmd.moveProject(id, 1) },
      "sep",
      { label: "削除…", icon: "trash", danger: true, disabled: ro, run: () => void cmd.deleteProject(id) },
    ];
    if (at instanceof HTMLElement) menuFromButton(at, entries, { minWidth: 240 });
    else showMenu(at.x, at.y, entries, { minWidth: 240 });
  };

  const scenarioMenu = (id: ID, at: HTMLElement | { x: number; y: number }) => {
    const s = store.doc.scenarios[id];
    if (!s) return;
    const ro = store.readOnly;
    const i = store.doc.scenarioOrder.indexOf(id);
    const entries: MenuEntry[] = [
      { label: "名前を変更", icon: "tag", disabled: ro, run: () => ((renaming = id), render()) },
      { label: "色を変更", icon: "dot", disabled: ro, submenu: colorItems(s.color, SCENARIO_COLORS, (c) => cmd.updateScenario(id, { color: c })) },
      { label: "説明を編集…", icon: "list", disabled: ro, run: () => app.editDescription("scenario", id) },
      { label: "上へ", icon: "collapse", disabled: ro || i <= 0, run: () => cmd.moveScenario(id, -1) },
      { label: "下へ", icon: "expand", disabled: ro || i >= store.doc.scenarioOrder.length - 1, run: () => cmd.moveScenario(id, 1) },
      "sep",
      { label: "削除…", icon: "trash", danger: true, disabled: ro, run: () => void cmd.deleteScenario(id) },
    ];
    if (at instanceof HTMLElement) menuFromButton(at, entries, { minWidth: 220 });
    else showMenu(at.x, at.y, entries, { minWidth: 220 });
  };

  const render = () => {
    vm.ensure();
    const doc = store.doc;
    const prefs = ui.prefs;
    const filter = new Set(prefs.projectFilter.filter((p) => doc.projects[p]));
    root.querySelector<HTMLElement>('[data-section="projects"]')!.classList.toggle("collapsed", !prefs.sections.projects);
    root.querySelector<HTMLElement>('[data-section="scenarios"]')!.classList.toggle("collapsed", !prefs.sections.scenarios);
    root.querySelector<HTMLElement>('[data-section="tags"]')!.classList.toggle("collapsed", !prefs.sections.tags);
    for (const b of root.querySelectorAll<HTMLButtonElement>(".side-head-btn")) {
      const key = b.closest<HTMLElement>(".side-section")!.dataset.section as "projects" | "scenarios" | "tags";
      b.setAttribute("aria-expanded", String(prefs.sections[key]));
    }
    addProjectBtn.disabled = store.readOnly;
    addScenarioBtn.disabled = store.readOnly;

    // プロジェクト
    clear(projectList);
    const total = Object.keys(doc.nodes).length;
    const allRow = h(
      "button",
      { class: `side-row${filter.size === 0 ? " active" : ""}`, type: "button", role: "option", attrs: { "aria-selected": String(filter.size === 0) }, title: "すべてのプロジェクトを表示" },
      h("span", { class: "row-icon" }, icon("layers", 15)),
      h("span", { class: "row-name" }, "すべて"),
      h("span", { class: "row-count" }, String(total)),
    );
    allRow.addEventListener("click", () => ui.setPrefs({ projectFilter: [] }));
    projectList.append(allRow);
    for (const pid of doc.projectOrder) {
      const p = doc.projects[pid];
      if (!p) continue;
      const count = vm.index.projectNodes.get(pid)?.length ?? 0;
      const sharedCount = (vm.index.projectNodes.get(pid) ?? []).filter((n) => vm.index.shared.has(n)).length;
      const on = filter.has(pid);
      const more = h("button", { class: "row-more icon-btn icon-btn-xs", type: "button", ariaLabel: `${p.name} のメニュー`, title: "メニュー" }, icon("more", 15));
      more.addEventListener("click", (ev) => {
        ev.stopPropagation();
        projectMenu(pid, more);
      });
      const nameEl = renaming === pid ? renameInput(pid, "project", p.name) : h("span", { class: "row-name", title: p.description || p.name }, p.name);
      const row = h(
        "div",
        { class: `side-row${on ? " active" : ""}`, role: "option", tabIndex: 0, attrs: { "aria-selected": String(on) }, title: `${p.name}（クリックで強調、${MOD}クリックで複数選択）` },
        h("span", { class: "row-dot", style: { background: p.color, "box-shadow": `0 0 0 3px ${p.color}22` } }),
        nameEl,
        sharedCount ? h("span", { class: "row-shared", title: `ほかのプロジェクトと共有しているノード ${sharedCount} 件` }, icon("link", 12), String(sharedCount)) : null,
        h("span", { class: "row-count" }, String(count)),
        more,
      );
      row.style.setProperty("--row-color", p.color);
      const pick = (ev: MouseEvent | KeyboardEvent) => {
        if (renaming === pid) return;
        const multi = ev.metaKey || ev.ctrlKey || ev.shiftKey;
        const cur = new Set(filter);
        if (multi) {
          if (cur.has(pid)) cur.delete(pid);
          else cur.add(pid);
          ui.setPrefs({ projectFilter: [...cur] });
        } else ui.setPrefs({ projectFilter: cur.size === 1 && cur.has(pid) ? [] : [pid] });
      };
      row.addEventListener("click", pick);
      row.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          pick(ev);
        }
      });
      row.addEventListener("dblclick", () => {
        if (store.readOnly) return;
        renaming = pid;
        render();
      });
      row.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        projectMenu(pid, { x: ev.clientX, y: ev.clientY });
      });
      projectList.append(row);
    }
    if (vm.index.unassigned.length) {
      projectList.append(h("div", { class: "side-note" }, `未分類のノード ${vm.index.unassigned.length} 件`));
    }

    // シナリオ
    clear(scenarioList);
    const sid = prefs.scenarioId && doc.scenarios[prefs.scenarioId] ? prefs.scenarioId : null;
    const noneRow = h(
      "button",
      { class: `side-row${sid === null ? " active" : ""}`, type: "button", role: "option", attrs: { "aria-selected": String(sid === null) } },
      h("span", { class: "row-radio" }),
      h("span", { class: "row-name" }, "すべて表示"),
    );
    noneRow.addEventListener("click", () => ui.setPrefs({ scenarioId: null }));
    scenarioList.append(noneRow);
    for (const id of doc.scenarioOrder) {
      const s = doc.scenarios[id];
      if (!s) continue;
      const on = sid === id;
      const more = h("button", { class: "row-more icon-btn icon-btn-xs", type: "button", ariaLabel: `${s.name} のメニュー`, title: "メニュー" }, icon("more", 15));
      more.addEventListener("click", (ev) => {
        ev.stopPropagation();
        scenarioMenu(id, more);
      });
      const nameEl = renaming === id ? renameInput(id, "scenario", s.name) : h("span", { class: "row-name", title: s.description || s.name }, s.name);
      const row = h(
        "div",
        { class: `side-row scenario-row${on ? " active" : ""}`, role: "option", tabIndex: 0, attrs: { "aria-selected": String(on) }, title: s.description || s.name },
        h("span", { class: "row-radio", style: { "--radio": s.color } }),
        nameEl,
        h("span", { class: "row-count", title: "このシナリオだけの要素" }, String(vm.index.scenarioCounts.get(id) ?? 0)),
        more,
      );
      row.style.setProperty("--row-color", s.color);
      const pick = () => {
        if (renaming === id) return;
        ui.setPrefs({ scenarioId: on ? null : id });
      };
      row.addEventListener("click", pick);
      row.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          pick();
        }
      });
      row.addEventListener("dblclick", () => {
        if (store.readOnly) return;
        renaming = id;
        render();
      });
      row.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        scenarioMenu(id, { x: ev.clientX, y: ev.clientY });
      });
      scenarioList.append(row);
    }
    if (sid) {
      const s = doc.scenarios[sid]!;
      scenarioList.append(h("div", { class: "side-note scenario-note" }, s.description || "分岐の線やノードにこのシナリオを付けると、ここで切り替えられます。"));
    }

    // タグ
    clear(tagList);
    const tags = vm.index.tags.slice(0, 30);
    if (!tags.length) tagList.append(h("div", { class: "side-note" }, "タグはまだありません"));
    for (const t of tags) {
      const active = ui.search.trim() === `#${t.tag}`;
      const chip = h("button", { class: `tag-chip${active ? " active" : ""}`, type: "button", title: `#${t.tag} で検索` }, `#${t.tag}`, h("span", { class: "tag-count" }, String(t.count)));
      chip.addEventListener("click", () => ui.setSearch(active ? "" : `#${t.tag}`));
      tagList.append(chip);
    }
    renderFooter();
  };

  const renderFooter = () => {
    clear(footer);
    const per = app.persistence;
    const where = per.mode === "idb" ? "このブラウザ（IndexedDB）" : per.mode === "local" ? "このブラウザ（localStorage）" : "保存しない一時表示";
    footer.append(h("div", { class: "side-footer-row" }, icon("shield", 14), h("span", null, `保存先: ${where}`)));
    if (app.cloudInfo) footer.append(h("div", { class: `side-footer-row cloud-${app.cloudInfo.state}` }, icon("layers", 14), h("span", { title: app.cloudInfo.message }, `アカウント: ${cloudText(app.cloudInfo)}`)));
    if (app.lastBackupLabel) footer.append(h("div", { class: "side-footer-row muted" }, icon("clock", 14), h("span", null, `最新のバックアップ（${BACKUP_LABELS[app.lastBackupLabel.kind]}）${app.lastBackupLabel.when}`)));
    footer.append(
      h(
        "div",
        { class: "side-footer-actions" },
        h("button", { class: "btn btn-sm", type: "button", onClick: () => app.openBackups() }, icon("archive", 14), "バックアップ"),
        h("button", { class: "btn btn-sm", type: "button", onClick: () => app.exportJson() }, icon("download", 14), "書き出す"),
      ),
    );
  };

  store.on("change", (info) => {
    if (!info.positionsOnly) render();
  });
  ui.on("prefs", (p) => {
    if (!onlyTimeCursor(p)) render();
  });
  ui.on("search", render);
  app.persistence.on("status", renderFooter);
  app.onBackupsChanged = renderFooter;
  app.onCloudChanged = renderFooter;
  render();
  return root;
}
