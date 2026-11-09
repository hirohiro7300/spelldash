// 上部: 表示切替・検索・編集ツール・保存状態・メニュー

import type { AppContext } from "../app/context";
import { NODE_TYPES, NODE_TYPE_ORDER } from "../model/constants";
import { formatDate } from "../model/dates";
import type { ID } from "../model/types";
import type { SaveStatus } from "../persist/persistence";
import { isCompactTopbar } from "./breakpoints";
import { MOD, clear, h } from "./dom";
import { icon } from "./icons";
import { menuFromButton, type MenuEntry } from "./overlays";

const STATUS_TEXT: Record<SaveStatus, string> = {
  idle: "保存済み",
  pending: "未保存の変更",
  saving: "保存中…",
  saved: "保存済み",
  error: "保存できません",
  conflict: "保存を止めています",
  readonly: "閲覧のみ",
  ephemeral: "一時表示（保存しません）",
};

export function buildTopbar(app: AppContext): HTMLElement {
  const { store, ui, cmd } = app;

  // ---- ブランド
  const titleEl = h("button", { class: "doc-title", type: "button", title: "ドキュメントの名前（押して変更）" });
  titleEl.addEventListener("click", () => app.renameDoc());
  const brand = h(
    "div",
    { class: "brand" },
    h("span", { class: "brand-mark", html: '<svg viewBox="0 0 64 64" width="26" height="26" aria-hidden="true"><path d="M14 32 C24 32 24 18 34 18 M14 32 C24 32 24 46 34 46 M34 18 C42 18 42 32 50 32 M34 46 C42 46 42 32 50 32" fill="none" stroke="#8b7bff" stroke-width="3.2" stroke-linecap="round" opacity=".8"/><circle cx="14" cy="32" r="6.5" fill="#4da3ff"/><circle cx="34" cy="18" r="6.5" fill="#b983ff"/><circle cx="34" cy="46" r="6.5" fill="#3dd9a4"/><circle cx="50" cy="32" r="6.5" fill="#ffb547"/></svg>' }),
    h("div", { class: "brand-text" }, h("span", { class: "brand-name" }, "4D Branch"), titleEl),
  );

  const leftToggle = h("button", { class: "icon-btn", type: "button", title: "左のパネルを開閉", ariaLabel: "左のパネルを開閉", onClick: () => ui.setPrefs({ leftOpen: !ui.prefs.leftOpen }) }, icon("sidebarLeft", 17));
  const rightToggle = h("button", { class: "icon-btn", type: "button", title: "右のパネルを開閉", ariaLabel: "右のパネルを開閉", onClick: () => ui.setPrefs({ rightOpen: !ui.prefs.rightOpen }) }, icon("sidebarRight", 17));

  // ---- 表示切替
  const mapBtn = h("button", { class: "seg-btn", type: "button", title: "マップ（キャンバス）", onClick: () => ui.setPrefs({ view: "map" }) }, icon("map", 15), h("span", null, "マップ"));
  const listBtn = h("button", { class: "seg-btn", type: "button", title: "リスト（表）", onClick: () => ui.setPrefs({ view: "list" }) }, icon("list", 15), h("span", null, "リスト"));
  const viewSeg = h("div", { class: "seg view-seg", role: "tablist", ariaLabel: "表示の切り替え" }, mapBtn, listBtn);

  const displayBtn = h("button", { class: "btn btn-ghost btn-sm display-btn", type: "button", title: "表示の設定" }, icon("sliders", 15), h("span", null, "表示"), icon("chevronDown", 13));
  displayBtn.addEventListener("click", () => menuFromButton(displayBtn, displayMenu(app), { minWidth: 260 }));

  // ---- 検索
  const search = buildSearch(app);

  // ---- 追加
  const addGroup = h("div", { class: "add-group", role: "group", ariaLabel: "ノードを追加" });
  for (const t of NODE_TYPE_ORDER) {
    const meta = NODE_TYPES[t];
    const b = h(
      "button",
      { class: `add-btn type-${t}`, type: "button", title: `${meta.label}を追加（${meta.hint}）`, onClick: () => cmd.createNode(t, undefined, { edit: true }) },
      h("span", { class: "add-plus" }, icon("plus", 12, 2.4)),
      icon(t, 15),
      h("span", { class: "add-label" }, meta.label),
    );
    b.dataset.type = t;
    addGroup.append(b);
  }

  // 狭い画面では 4 つの追加ボタンの代わりに 1 つ（押すと種類を選ぶ）
  const addMobile = h("button", { class: "icon-btn mobile-only", type: "button", title: "ノードを追加", ariaLabel: "ノードを追加" }, icon("plus", 18));
  addMobile.addEventListener("click", () =>
    menuFromButton(addMobile, [{ header: "ノードを追加" }, ...NODE_TYPE_ORDER.map((t) => ({ label: NODE_TYPES[t].label, icon: t, hint: NODE_TYPES[t].hint, disabled: store.readOnly, run: () => cmd.createNode(t, undefined, { edit: true }) }))], { minWidth: 200 }),
  );

  // ---- 元に戻す
  const undoBtn = h("button", { class: "icon-btn", type: "button", ariaLabel: "元に戻す", onClick: () => cmd.undo() }, icon("undo", 17));
  const redoBtn = h("button", { class: "icon-btn redo-btn", type: "button", ariaLabel: "やり直す", onClick: () => cmd.redo() }, icon("redo", 17));
  const updateHistory = () => {
    const hist = store.history;
    undoBtn.disabled = !hist.canUndo || store.readOnly;
    redoBtn.disabled = !hist.canRedo || store.readOnly;
    undoBtn.title = hist.undoLabel ? `元に戻す: ${hist.undoLabel}（${MOD}Z）` : `元に戻す（${MOD}Z）`;
    redoBtn.title = hist.redoLabel ? `やり直す: ${hist.redoLabel}（${MOD}⇧Z）` : `やり直す（${MOD}⇧Z）`;
  };
  store.on("history", updateHistory);
  updateHistory();

  // ---- 保存状態・メニュー
  const saveDot = h("span", { class: "save-dot" });
  const saveText = h("span", { class: "save-text" });
  const saveBtn = h("button", { class: "save-status", type: "button", title: "保存とバックアップ", onClick: () => app.openBackups() }, saveDot, saveText);
  const updateSave = () => {
    const st = app.persistence.status;
    saveBtn.dataset.status = st;
    saveText.textContent = STATUS_TEXT[st];
    const at = app.persistence.savedAt;
    saveBtn.title = st === "saved" && at ? `このブラウザに保存済み（${new Date(at).toLocaleTimeString("ja-JP")}）。押すとバックアップと復元` : app.persistence.statusMessage || "保存とバックアップ";
  };
  app.persistence.on("status", updateSave);
  updateSave();

  const menuBtn = h("button", { class: "icon-btn", type: "button", title: "メニュー", ariaLabel: "メニュー" }, icon("more", 18));
  menuBtn.addEventListener("click", () => menuFromButton(menuBtn, mainMenu(app), { align: "right", minWidth: 270 }));
  const helpBtn = h("button", { class: "icon-btn help-btn", type: "button", title: "ヘルプと操作ガイド（?）", ariaLabel: "ヘルプ", onClick: () => app.openHelp() }, icon("help", 18));

  const bar = h(
    "header",
    { class: "topbar" },
    brand,
    h("div", { class: "topbar-group" }, leftToggle, viewSeg, displayBtn),
    h("div", { class: "topbar-search" }, search),
    h("div", { class: "topbar-group" }, addGroup, addMobile),
    h("div", { class: "topbar-group" }, undoBtn, redoBtn),
    h("div", { class: "topbar-group topbar-right" }, saveBtn, menuBtn, helpBtn, rightToggle),
  );

  const sync = () => {
    mapBtn.classList.toggle("active", ui.prefs.view === "map");
    listBtn.classList.toggle("active", ui.prefs.view === "list");
    mapBtn.setAttribute("aria-selected", String(ui.prefs.view === "map"));
    listBtn.setAttribute("aria-selected", String(ui.prefs.view === "list"));
    titleEl.textContent = store.doc.title;
    leftToggle.classList.toggle("active", ui.prefs.leftOpen);
    rightToggle.classList.toggle("active", ui.prefs.rightOpen);
    addGroup.classList.toggle("disabled", store.readOnly);
  };
  ui.on("prefs", sync);
  store.on("change", sync);
  app.persistence.on("writer", sync);
  sync();
  return bar;
}

function check(label: string, on: boolean, run: () => void, hint?: string): MenuEntry {
  return { label, checked: on, run, hint };
}

function displayMenu(app: AppContext): MenuEntry[] {
  const { ui, cmd } = app;
  const p = ui.prefs;
  return [
    { header: "表示" },
    check("接続線のラベル（条件・説明）", p.showLabels, () => ui.setPrefs({ showLabels: !p.showLabels })),
    check("ミニマップ", p.showMinimap, () => ui.setPrefs({ showMinimap: !p.showMinimap })),
    check("ドットの格子", p.showGrid, () => ui.setPrefs({ showGrid: !p.showGrid })),
    check("選んだノードの経路を強調", p.pathHighlight, () => ui.setPrefs({ pathHighlight: !p.pathHighlight }), "上流（そこへ至る道）と下流（そこから広がる未来）を明るく"),
    check("経路の流れを動かす", p.animate, () => ui.setPrefs({ animate: !p.animate })),
    "sep",
    { header: "接続線" },
    check("すべて表示", p.edgeMode === "all", () => ui.setPrefs({ edgeMode: "all" })),
    check("選んだノードの線だけ", p.edgeMode === "selection", () => ui.setPrefs({ edgeMode: "selection" }), "線を折りたたんで、選んだノードの線だけ出す"),
    check("プロジェクト間の線だけ", p.edgeMode === "cross", () => ui.setPrefs({ edgeMode: "cross" }), "相乗効果・影響の線だけ出す"),
    "sep",
    { header: "プロジェクトを選んだとき" },
    check("ほかのプロジェクトを薄く", p.projectMode === "dim", () => ui.setPrefs({ projectMode: "dim" })),
    check("つながる相手だけ残して隠す", p.projectMode === "focus", () => ui.setPrefs({ projectMode: "focus" })),
    { header: "シナリオを選んだとき" },
    check("シナリオ外を薄く", p.scenarioMode === "dim", () => ui.setPrefs({ scenarioMode: "dim" })),
    check("シナリオ外を隠す", p.scenarioMode === "hide", () => ui.setPrefs({ scenarioMode: "hide" })),
    "sep",
    { header: "スクロールの動き" },
    check("移動する（トラックパッド向け）", p.wheel === "pan", () => ui.setPrefs({ wheel: "pan" }), "拡大縮小はピンチか ⌘／Ctrl＋スクロール"),
    check("拡大縮小する（マウス向け）", p.wheel === "zoom", () => ui.setPrefs({ wheel: "zoom" })),
    "sep",
    { label: "全体を表示", icon: "fit", shortcut: "F", run: () => app.view.fit() },
    { label: "折りたたみをすべて開く", icon: "expand", run: () => cmd.expandAll() },
  ];
}

function mainMenu(app: AppContext): MenuEntry[] {
  const ro = app.store.readOnly;
  // 上部バーをまとめている幅では、バーから外したボタンをここに出す
  const compact: MenuEntry[] = isCompactTopbar()
    ? [
        { header: "表示" },
        { label: app.ui.prefs.view === "map" ? "リストで見る" : "マップで見る", icon: app.ui.prefs.view === "map" ? "list" : "map", run: () => app.ui.setPrefs({ view: app.ui.prefs.view === "map" ? "list" : "map" }) },
        { label: "表示の設定", icon: "sliders", submenu: displayMenu(app) },
        { label: "やり直す", icon: "redo", disabled: !app.store.history.canRedo || ro, run: () => app.cmd.redo() },
        { label: "ヘルプ", icon: "help", run: () => app.openHelp() },
        "sep",
      ]
    : [];
  return [
    ...compact,
    { header: "データ" },
    { label: "JSON でエクスポート", icon: "download", shortcut: `${MOD}E`, run: () => app.exportJson() },
    { label: "JSON をインポート…", icon: "upload", disabled: ro, run: () => app.pickImport() },
    { label: "バックアップと復元…", icon: "archive", run: () => app.openBackups() },
    { label: "今すぐバックアップ", icon: "shield", run: () => void app.backupNow() },
    "sep",
    { header: "ドキュメント" },
    { label: "名前を変更…", icon: "tag", disabled: ro, run: () => app.renameDoc() },
    { label: "デモを読み込む（置き換え）", icon: "sparkle", disabled: ro, run: () => void app.loadDemo() },
    { label: "空のドキュメントにする", icon: "reset", disabled: ro, run: () => void app.newEmptyDoc() },
    "sep",
    { header: "そのほか" },
    { label: "操作ガイドを見る", icon: "help", run: () => app.startTour() },
    { label: "ショートカット一覧", icon: "keyboard", shortcut: "?", run: () => app.openHelp() },
    {
      label: "性能確認（2,000 ノード・保存しない）",
      icon: "layers",
      // 同じ画面のまま切り替える（claude.ai の枠は新しいタブを開かせない）。# が変わると main.ts が開き直し、帯の「ふだんの画面へ」で戻る
      run: () => {
        location.hash = "stress-2000";
      },
    },
  ];
}

// ------------------------------------------------------------ 検索

function buildSearch(app: AppContext): HTMLElement {
  const { ui, store, vm } = app;
  const input = h("input", { class: "search-input", type: "search", placeholder: "検索（#タグ も可）", attrs: { "aria-label": "ノードを検索", autocomplete: "off", spellcheck: "false" } });
  const count = h("span", { class: "search-count" });
  const kbd = h("kbd", { class: "search-kbd" }, `${MOD}K`);
  const results = h("div", { class: "search-results", role: "listbox" });
  results.hidden = true;
  let active = 0;
  let items: ID[] = [];

  const render = () => {
    vm.ensure();
    const hits = vm.searchHits;
    count.textContent = ui.search.trim() ? `${hits.length} 件` : "";
    kbd.hidden = !!ui.search || document.activeElement === input;
    clear(results);
    items = hits.slice(0, 50).map((x) => x.id);
    if (!ui.search.trim() || document.activeElement !== input) {
      results.hidden = true;
      return;
    }
    results.hidden = false;
    if (items.length === 0) {
      results.append(h("div", { class: "search-empty" }, "見つかりません"));
      return;
    }
    active = Math.min(active, items.length - 1);
    items.forEach((id, i) => {
      const n = store.doc.nodes[id]!;
      const colors = n.projectIds.map((p) => store.doc.projects[p]?.color).filter((c): c is string => !!c);
      const row = h(
        "button",
        { class: `search-row${i === active ? " active" : ""}`, type: "button", role: "option", attrs: { "aria-selected": String(i === active) } },
        h("span", { class: `type-chip type-${n.type}` }, icon(n.type, 13)),
        h("span", { class: "search-title" }, n.title || "（無題）"),
        ui.prefs.view === "map" && vm.node(id).hidden ? h("span", { class: "search-hidden", title: "折りたたみや表示の絞り込みで隠れています。選ぶと表示します", attrs: { role: "img", "aria-label": "隠れています" } }, icon("eyeOff", 13)) : null,
        h("span", { class: "search-meta" }, ...colors.slice(0, 4).map((c) => h("span", { class: "dot", style: { background: c } })), n.time.due ? h("span", { class: "search-due" }, formatDate(n.time.due)) : null),
      );
      row.addEventListener("pointerdown", (ev) => ev.preventDefault());
      row.addEventListener("click", () => go(i));
      row.addEventListener("mouseenter", () => {
        active = i;
        for (const [k, el] of [...results.children].entries()) el.classList.toggle("active", k === i);
      });
      results.append(row);
    });
  };

  const go = (i: number) => {
    const id = items[i];
    if (!id) return;
    if (ui.prefs.view === "map") app.cmd.revealNode(id); // 折りたたみや絞り込みで隠れていたら出す
    ui.select([id]);
    if (ui.prefs.view === "map") app.view.centerOn(id);
    else app.revealInList(id);
  };

  input.addEventListener("input", () => {
    active = 0;
    ui.setSearch(input.value);
  });
  input.addEventListener("focus", render);
  input.addEventListener("blur", () => setTimeout(render, 120));
  input.addEventListener("keydown", (ev) => {
    if (ev.isComposing) return;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (!items.length) return;
      active = (active + (ev.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      render();
      results.children[active]?.scrollIntoView({ block: "nearest" });
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      go(active);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      if (input.value) {
        input.value = "";
        ui.setSearch("");
      } else input.blur();
    }
  });
  ui.on("search", (q) => {
    if (input.value !== q) input.value = q;
    render();
  });
  store.on("change", () => {
    if (ui.search) render();
  });
  app.focusSearch = () => {
    input.focus();
    input.select();
  };
  // 欄は狭くなると中身を切る（上部バーの足りない幅を吸う）。候補はその外に置いて切られないようにする。
  // 欄は label にして、入力欄がほとんど見えないほど縮んでも、欄のどこを押しても入力できるようにする
  return h("div", { class: "search-box" }, h("label", { class: "search" }, icon("search", 15), input, count, kbd), results);
}
