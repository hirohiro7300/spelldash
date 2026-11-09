// 画面の組み立てと配線: 5 つの領域・ショートカット・右クリック・取り込み・保存の出来事

import { CanvasView, type Hit } from "../canvas/CanvasView";
import { InlineEditor } from "../canvas/inlineEditor";
import { Interaction } from "../canvas/interaction";
import { Minimap } from "../canvas/minimap";
import { buildDemoDoc } from "../demo/demo";
import { APP_VERSION, NODE_TYPES, NODE_TYPE_ORDER, RELATIONS, RELATION_ORDER, STATUSES, STATUS_ORDER } from "../model/constants";
import { createEmptyDoc } from "../model/schema";
import type { DocData, ID, NodeType } from "../model/types";
import { errorCode, inArtifactHost, useCapability, type DbApi, type DownloadsApi, type UserApi } from "../host/claude";
import { isDisposableDoc } from "../demo/demo";
import { CloudRepo, CloudSync, dbBackend, type CloudState, type SyncBase } from "../persist/cloud";
import { downloadText, exportFileName, exportText, mergeDocs } from "../persist/io";
import type { BackupKind, Persistence } from "../persist/persistence";
import type { Store } from "../store/store";
import { buildBottomBar } from "../ui/bottomBar";
import { chooseSyncSource, openBackupDialog, openCopyDialog, openHelpDialog, openImportDialog, openTextDialog, openWelcome } from "../ui/dialogs";
import { MOD, h, isTypingTarget } from "../ui/dom";
import { icon } from "../ui/icons";
import { buildInspector } from "../ui/inspector";
import { buildLeftSidebar } from "../ui/leftSidebar";
import { buildListView } from "../ui/listView";
import { startTour } from "../ui/onboarding";
import { closeMenus, confirmDialog, showMenu, toast, type MenuEntry } from "../ui/overlays";
import { buildTopbar } from "../ui/topbar";
import { Commands } from "./commands";
import type { AppContext } from "./context";
import type { UiState } from "./uiState";
import { ViewModel } from "./viewModel";

export interface AppOptions {
  store: Store;
  ui: UiState;
  persistence: Persistence;
  ephemeral: boolean;
  firstRun: boolean;
  notices: string[];
  mount: HTMLElement;
}

export class App implements AppContext {
  readonly store: Store;
  readonly ui: UiState;
  readonly vm: ViewModel;
  readonly cmd: Commands;
  readonly persistence: Persistence;
  readonly view: CanvasView;
  readonly ephemeral: boolean;
  readonly editor: InlineEditor;
  readonly interaction: Interaction;
  lastBackupLabel: { kind: BackupKind; when: string } | null = null;
  onBackupsChanged: () => void = () => undefined;
  focusSearch: () => void = () => undefined;
  focusInspectorTitle: () => void = () => undefined;
  focusEdgeCondition: () => void = () => undefined;
  revealInList: (id: ID) => void = () => undefined;
  listIds: () => ID[] = () => [];
  refreshList: () => void = () => undefined;
  afterTour?: () => void;
  /** アカウントへの同期（claude.ai の Artifact の中で、サインインしているときだけ） */
  cloud: CloudSync | null = null;
  cloudInfo: { state: CloudState | "unavailable"; message: string; lastSyncedAt: string | null } | null = null;
  onCloudChanged: () => void = () => undefined;
  private adopting = false;

  private readonly shell: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly emptyHint: HTMLElement;
  private readonly zoomLabel: HTMLElement;
  private cameraSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private remoteTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: AppOptions) {
    this.store = opts.store;
    this.ui = opts.ui;
    this.persistence = opts.persistence;
    this.ephemeral = opts.ephemeral;
    this.vm = new ViewModel(this.store, this.ui);
    this.view = new CanvasView(this.store, this.ui, this.vm);
    this.cmd = new Commands(this.store, this.ui, this.vm, {
      toast: (t, o) => toast(t, o),
      viewCenter: () => this.view.viewCenter(),
      startEdit: (id) => this.startEdit(id),
      reveal: (id) => {
        if (this.ui.prefs.view === "map") this.view.centerOn(id, { onlyIfHidden: true });
        else this.revealInList(id);
      },
      confirm: (o) => confirmDialog(o),
    });
    this.editor = new InlineEditor(this.view, this.store, this.cmd);
    this.interaction = new Interaction(this.view, this.store, this.ui, this.vm, this.cmd, {
      startEdit: (id) => this.startEdit(id),
      contextMenu: (hit, x, y, w) => this.contextMenu(hit, x, y, w),
      pickTypeAt: (x, y, pick) => this.pickType(x, y, pick),
      focusEdge: (id) => {
        this.ui.select([], [id]);
        this.ui.setPrefs({ rightOpen: true });
        requestAnimationFrame(() => this.focusEdgeCondition());
      },
    });
    const minimap = new Minimap(this.view, this.store, this.vm, this.ui);

    // ---- キャンバスの上の部品
    this.zoomLabel = h("button", { class: "zoom-label", type: "button", title: "100% に戻す（0）", onClick: () => this.view.setZoom(1) }, "100%");
    const zoomCtl = h(
      "div",
      { class: "zoom-ctl" },
      h("button", { class: "icon-btn", type: "button", title: "縮小（−）", ariaLabel: "縮小", onClick: () => this.view.zoomBy(0.8) }, icon("minus", 16)),
      this.zoomLabel,
      h("button", { class: "icon-btn", type: "button", title: "拡大（＋）", ariaLabel: "拡大", onClick: () => this.view.zoomBy(1.25) }, icon("plus", 16)),
      h("span", { class: "zoom-sep" }),
      h("button", { class: "icon-btn", type: "button", title: "全体を表示（F）", ariaLabel: "全体を表示", onClick: () => this.view.fit() }, icon("fit", 16)),
    );
    this.emptyHint = h(
      "div",
      { class: "empty-hint" },
      h("div", { class: "empty-icon" }, icon("split", 28, 1.4)),
      h("h2", null, "まだノードがありません"),
      h("p", null, "空いている所をダブルクリックするか、上の ＋目標・＋行動 から作りましょう。"),
      h(
        "div",
        { class: "btn-row center" },
        h("button", { class: "btn btn-primary", type: "button", onClick: () => this.cmd.createNode("goal", undefined, { edit: true }) }, icon("goal", 15), "目標を作る"),
        h("button", { class: "btn", type: "button", onClick: () => void this.loadDemo() }, icon("sparkle", 15), "デモを読み込む"),
      ),
    );
    this.view.root.append(minimap.el, zoomCtl, this.emptyHint);
    this.listEl = buildListView(this);
    this.banner = h("div", { class: "banner-area", attrs: { "aria-live": "polite" } });
    // 狭い画面でパネルを重ねて出しているとき、外側を押すと閉じる
    const scrim = h("div", { class: "overlay-scrim", attrs: { "aria-hidden": "true" } });
    scrim.addEventListener("click", () => this.ui.setPrefs({ leftOpen: false, rightOpen: false }));
    const center = h("main", { class: "center", ariaLabel: "キャンバス" }, this.banner, this.view.root, this.listEl, scrim);

    // 保存と「閲覧のみ」の切替は、画面の部品より先につなぐ（部品が先に反応すると古い状態で描く・部品の失敗で保存が止まる）
    this.store.on("change", (info) => {
      if (!this.ephemeral && info.source !== "load" && info.source !== "remote") this.persistence.markDirty();
      if (info.source === "tx" || info.source === "undo" || info.source === "redo" || (info.source === "replace" && !this.adopting)) {
        this.cloud?.markDirty();
      }
    });
    this.persistence.on("writer", (w) => {
      this.store.readOnly = !w && !this.ephemeral;
    });

    this.shell = h("div", { class: "app-shell" }, buildTopbar(this), buildLeftSidebar(this), center, buildInspector(this), buildBottomBar(this));
    opts.mount.replaceChildren(this.shell, h("div", { attrs: { id: "overlay-root" } }));

    // ---- 配線
    this.store.on("change", () => this.syncEmpty());
    this.persistence.on("writer", () => this.renderBanner());
    this.store.on("blocked", () => toast("このタブは閲覧のみです。編集するには上の「このタブで編集する」を押してください。", { tone: "warn" }));
    this.ui.on("prefs", (p) => this.applyPrefs(p));
    this.view.onCamera(() => this.onCamera());
    this.persistence.on("status", () => this.renderBanner());
    this.persistence.on("notice", (n) => toast(n.text, { tone: n.level === "error" ? "error" : n.level === "warn" ? "warn" : "info", ms: 7000 }));

    this.persistence.on("remote", () => this.scheduleRemoteReload());
    this.bindKeys();
    this.bindLifecycle();
    this.bindDrop();

    this.applyPrefs({});
    this.syncEmpty();
    this.renderBanner();
    this.ui.persistPrefs = !this.ephemeral;

    // カメラ: 前回の位置か、全体
    requestAnimationFrame(() => {
      this.view.resize();
      const cam = this.ephemeral ? null : this.ui.loadCamera(this.store.doc.id);
      if (cam) {
        this.view.camera.x = cam.x;
        this.view.camera.y = cam.y;
        this.view.camera.zoom = cam.zoom;
        this.view.cameraChanged();
      } else this.view.fit(undefined, { animate: false });
      for (const n of opts.notices) toast(n, { tone: "warn", ms: 9000 });
      if (opts.firstRun && !this.ui.prefs.onboardingDone && !this.ephemeral) openWelcome(this);
      this.afterTour = () => void this.askPersistOnce();
    });
    void this.refreshLastBackup();
  }

  // ------------------------------------------------------------ 表示

  private applyPrefs(p: Partial<UiState["prefs"]>): void {
    const prefs = this.ui.prefs;
    this.shell.classList.toggle("left-closed", !prefs.leftOpen);
    this.shell.classList.toggle("right-closed", !prefs.rightOpen);
    const list = prefs.view === "list";
    this.view.root.hidden = list;
    this.listEl.hidden = !list;
    if (list) this.refreshList();
    if ("view" in p && !list) requestAnimationFrame(() => this.view.resize());
    if ("leftOpen" in p || "rightOpen" in p) setTimeout(() => this.view.resize(), 220);
    if ("projectFilter" in p && prefs.projectFilter.length && prefs.view === "map") {
      // 選んだプロジェクトに寄る
      const ids = new Set<ID>();
      for (const pid of prefs.projectFilter) for (const id of this.vm.index.projectNodes.get(pid) ?? []) ids.add(id);
      if (ids.size) this.view.fit(ids);
    }
  }

  private syncEmpty(): void {
    this.emptyHint.hidden = Object.keys(this.store.doc.nodes).length > 0;
  }

  private onCamera(): void {
    this.zoomLabel.textContent = `${Math.round(this.view.camera.zoom * 100)}%`;
    if (this.ephemeral) return;
    if (this.cameraSaveTimer) clearTimeout(this.cameraSaveTimer);
    this.cameraSaveTimer = setTimeout(() => this.ui.saveCamera(this.store.doc.id, this.view.camera), 600);
  }

  private startEdit(id: ID): void {
    if (this.store.readOnly) return;
    if (this.ui.prefs.view === "list" || this.view.width === 0) {
      this.ui.select([id]);
      this.ui.setPrefs({ rightOpen: true });
      requestAnimationFrame(() => this.focusInspectorTitle());
      return;
    }
    this.editor.start(id);
  }

  private renderBanner(): void {
    const b = this.banner;
    b.replaceChildren();
    const per = this.persistence;
    const add = (tone: string, iconName: string, text: string, ...actions: HTMLElement[]) => b.append(h("div", { class: `banner tone-${tone}` }, icon(iconName, 15), h("span", { class: "banner-text" }, text), ...actions));
    if (this.ephemeral) {
      const back = h("button", { class: "btn btn-sm", type: "button" }, "ふだんの画面へ");
      back.addEventListener("click", () => {
        history.replaceState(null, "", location.pathname + location.search.replace(/[?&](stress|demo)(=[^&]*)?/g, "").replace(/^&/, "?"));
        location.reload();
      });
      add("info", "layers", `性能確認用の一時表示です（${Object.keys(this.store.doc.nodes).length.toLocaleString("ja-JP")} ノード）。変更は保存されず、ふだんのデータにも触れません。`, back);
      return;
    }
    if (!per.writer) {
      add(
        "warn",
        "lock",
        "別のタブで編集中のため、このタブは閲覧のみです。",
        h("button", { class: "btn btn-sm btn-primary", type: "button", onClick: () => void this.takeOver() }, "このタブで編集する"),
      );
    } else if (per.status === "conflict") {
      add(
        "danger",
        "alert",
        per.statusMessage || "別の場所で保存された内容があります。",
        h("button", { class: "btn btn-sm", type: "button", onClick: () => void this.resolveConflict("reload") }, "保存されている最新を開く"),
        h("button", { class: "btn btn-sm btn-danger", type: "button", onClick: () => void this.resolveConflict("overwrite") }, "このタブの内容で上書き"),
      );
    } else if (per.status === "error") {
      add("danger", "alert", per.statusMessage || "保存できませんでした。", h("button", { class: "btn btn-sm", type: "button", onClick: () => this.exportJson() }, "JSON で書き出す"));
    }
  }

  private async takeOver(): Promise<void> {
    const doc = await this.persistence.takeOver();
    if (doc) this.store.load(doc, "load");
    this.store.readOnly = false;
    this.cloud?.resync();
    this.renderBanner();
    toast("このタブで編集できるようになりました", { tone: "ok" });
  }

  private async resolveConflict(choice: "reload" | "overwrite"): Promise<void> {
    if (choice === "overwrite") {
      const ok = await confirmDialog({ title: "このタブの内容で上書きしますか？", body: "別のタブで保存された内容は「退避」バックアップに残っていないため、上書きすると見えなくなります（このタブの内容はすでに退避済みです）。", ok: "上書きする", danger: true });
      if (!ok) return;
      const latest = await this.persistence.readStored().catch(() => null);
      if (latest) await this.persistence.createBackup("conflict", "上書きされる前に保存されていた内容", latest.doc).catch(() => undefined);
    }
    if (choice === "reload") {
      // 競合に気づいた後の変更はまだどこにも無いので、開く前にこのタブの内容をもう一度退避する
      const saved = await this.persistence.createBackup("conflict", "保存されている最新を開く前のこのタブの内容", this.store.doc).catch(() => null);
      if (saved) void this.refreshLastBackup();
    }
    const doc = await this.persistence.resolveConflict(choice);
    if (doc) this.store.load(doc, "load");
    if (choice === "reload" && doc) toast("保存されている最新を開きました。このタブの内容はバックアップに残してあります（メニュー →「バックアップと復元」）。", { ms: 6000 });
    this.renderBanner();
  }

  private scheduleRemoteReload(): void {
    if (this.remoteTimer) clearTimeout(this.remoteTimer);
    this.remoteTimer = setTimeout(async () => {
      const s = await this.persistence.readStored().catch(() => null);
      if (s && !this.persistence.writer) this.store.load(s.doc, "remote");
    }, 400);
  }

  // ------------------------------------------------------------ メニュー

  private pickType(x: number, y: number, pick: (t: NodeType) => void): void {
    showMenu(x + 6, y + 6, [{ header: "ここに作る" }, ...NODE_TYPE_ORDER.map((t) => ({ label: NODE_TYPES[t].label, icon: t, shortcut: NODE_TYPES[t].key, hint: NODE_TYPES[t].hint, run: () => pick(t) }))], { minWidth: 180, className: "type-menu" });
  }

  private contextMenu(hit: Hit, x: number, y: number, world: { x: number; y: number }): void {
    const { cmd, ui, store } = this;
    const ro = store.readOnly;
    let entries: MenuEntry[] = [];
    if (hit.kind === "node" || hit.kind === "badge" || hit.kind === "port") {
      const ids = [...ui.selection.nodes];
      const single = ids.length === 1 ? store.doc.nodes[ids[0]!] : null;
      const typeSub = NODE_TYPE_ORDER.map((t) => ({ label: NODE_TYPES[t].label, icon: t, shortcut: NODE_TYPES[t].key, checked: !!single && single.type === t, run: () => cmd.setType(ids, t) }));
      const statusSub = STATUS_ORDER.map((s) => ({ label: STATUSES[s].label, swatch: STATUSES[s].color, checked: !!single && single.status === s, run: () => cmd.setStatus(ids, s) }));
      const projSub = store.doc.projectOrder.map((pid) => {
        const p = store.doc.projects[pid]!;
        const all = ids.every((id) => store.doc.nodes[id]?.projectIds.includes(pid));
        return { label: p.name, swatch: p.color, checked: all, run: () => cmd.toggleProjectOf(ids, pid) };
      });
      const collapsed = ids.every((id) => store.doc.nodes[id]?.collapsed);
      entries = [
        ...(single
          ? ([
              { label: "タイトルを編集", icon: "tag", shortcut: "Enter", disabled: ro, run: () => this.startEdit(single.id) },
              { label: "分岐を追加", icon: "plus", shortcut: "Tab", disabled: ro, run: () => cmd.addChild(single.id) },
              { label: "2 つに分岐", icon: "split", disabled: ro, run: () => cmd.addBranches(single.id, 2) },
            ] as MenuEntry[])
          : ([{ label: `${ids.length} 件を 1 つに合流`, icon: "merge", disabled: ro || ids.length < 2, run: () => cmd.mergeInto(ids) }] as MenuEntry[])),
        "sep",
        { label: "種類", icon: single?.type ?? "layers", disabled: ro, submenu: typeSub },
        { label: "状態", icon: "check", disabled: ro, submenu: statusSub },
        { label: "プロジェクト", icon: "folder", disabled: ro || !projSub.length, submenu: projSub },
        { label: collapsed ? "展開する" : "この先を折りたたむ", icon: collapsed ? "expand" : "collapse", shortcut: "C", disabled: ro, run: () => cmd.toggleCollapse(ids) },
        "sep",
        { label: "経路をたどって表示", icon: "fit", hint: "上流と下流をまとめて画面に収める", run: () => this.fitPaths(ids) },
        { label: "複製", icon: "copy", shortcut: `${MOD}D`, disabled: ro, run: () => cmd.duplicate(ids) },
        ...(ids.length > 1 ? ([{ label: "横にそろえる", icon: "minus", disabled: ro, run: () => cmd.align(ids, "h") }, { label: "縦にそろえる", icon: "pause", disabled: ro, run: () => cmd.align(ids, "v") }] as MenuEntry[]) : []),
        "sep",
        { label: "削除", icon: "trash", shortcut: "Delete", danger: true, disabled: ro, run: () => cmd.deleteSelection() },
      ];
    } else if (hit.kind === "edge" || hit.kind === "label" || hit.kind === "stub") {
      const ids = [...ui.selection.edges];
      const e = store.doc.edges[hit.edge];
      entries = [
        { header: "接続" },
        ...RELATION_ORDER.map((r) => ({ label: RELATIONS[r].label, swatch: RELATIONS[r].color, hint: RELATIONS[r].hint, checked: e?.relation === r, disabled: ro, run: () => cmd.setRelation(ids, r) })),
        "sep",
        { label: "条件・説明を編集", icon: "tag", disabled: ro, run: () => this.interactionFocusEdge(hit.edge) },
        { label: e?.collapsed ? "この先を展開" : "この先を折りたたむ", icon: e?.collapsed ? "expand" : "collapse", disabled: ro, run: () => cmd.toggleEdgeCollapse(hit.edge) },
        { label: "向きを反転", icon: "swap", disabled: ro, run: () => cmd.reverseEdge(hit.edge) },
        "sep",
        { label: "削除", icon: "trash", danger: true, disabled: ro, run: () => cmd.deleteSelection() },
      ];
    } else {
      entries = [
        { header: "ここに作る" },
        ...NODE_TYPE_ORDER.map((t) => ({ label: NODE_TYPES[t].label, icon: t, hint: NODE_TYPES[t].hint, disabled: ro, run: () => cmd.createNode(t, world, { edit: true, exact: true }) })),
        "sep",
        { label: "全体を表示", icon: "fit", shortcut: "F", run: () => this.view.fit() },
        { label: "すべて選択", icon: "layers", shortcut: `${MOD}A`, run: () => (this.ui.prefs.view === "list" ? this.ui.select(this.listIds()) : cmd.selectAll()) },
        { label: "折りたたみをすべて開く", icon: "expand", disabled: ro, run: () => cmd.expandAll() },
      ];
    }
    showMenu(x, y, entries, { minWidth: 230 });
  }

  private interactionFocusEdge(id: ID): void {
    this.ui.select([], [id]);
    this.ui.setPrefs({ rightOpen: true });
    requestAnimationFrame(() => this.focusEdgeCondition());
  }

  private fitPaths(ids: ID[]): void {
    this.vm.ensure();
    const set = new Set<ID>(ids);
    for (const [id, v] of this.vm.nodes) if (v.path && !v.hidden) set.add(id);
    this.view.fit(set);
  }

  // ------------------------------------------------------------ キー

  private bindKeys(): void {
    document.addEventListener("keydown", (ev) => {
      if (document.querySelector(".modal-backdrop:not(.closing), .tour")) return;
      const typing = isTypingTarget(ev.target);
      const mod = ev.metaKey || ev.ctrlKey;
      const key = ev.key;
      const lower = key.length === 1 ? key.toLowerCase() : key;
      if (mod && lower === "z" && !typing) {
        ev.preventDefault();
        if (ev.shiftKey) this.cmd.redo();
        else this.cmd.undo();
        return;
      }
      if (mod && lower === "y" && !typing) {
        ev.preventDefault();
        this.cmd.redo();
        return;
      }
      if (mod && lower === "s") {
        ev.preventDefault();
        void Promise.all([this.persistence.flush(), this.cloud?.flush()]).then(() => {
          const per = this.persistence;
          // 本当に保存できたときだけ「保存しました」と言う
          if (this.ephemeral) toast("一時表示のため保存しません", { ms: 1500 });
          else if (!per.writer) toast("このタブは閲覧のみです（別のタブで編集中）", { tone: "warn" });
          else if (per.status === "conflict" || per.status === "error") toast(per.statusMessage || "保存できませんでした", { tone: "error" });
          else if (per.hasUnsaved) toast("保存しています…", { ms: 1500 });
          else toast("保存しました", { tone: "ok", ms: 1500 });
        });
        return;
      }
      if (mod && lower === "k") {
        ev.preventDefault();
        this.focusSearch();
        return;
      }
      if (mod && lower === "e") {
        ev.preventDefault();
        this.exportJson();
        return;
      }
      if (typing) return;
      const active = document.activeElement;
      const onCanvas = active === document.body || active === this.view.canvas || active === null || this.listEl.contains(active);
      if (mod && lower === "a" && onCanvas) {
        ev.preventDefault();
        // リストでは、絞り込み・検索で表に出ている行だけを選ぶ（見えない行まで消したり変えたりしない）
        if (this.ui.prefs.view === "list") this.ui.select(this.listIds());
        else this.cmd.selectAll();
        return;
      }
      if (mod && lower === "d") {
        ev.preventDefault();
        this.cmd.duplicate([...this.ui.selection.nodes]);
        return;
      }
      if (mod || ev.altKey) return;
      const single = this.ui.singleNode;
      const nodes = [...this.ui.selection.nodes];
      switch (key) {
        case " ":
          if (onCanvas) {
            ev.preventDefault();
            this.interaction.spaceDown = true;
            this.view.canvas.style.cursor = "grab";
          }
          return;
        case "/":
          ev.preventDefault();
          this.focusSearch();
          return;
        case "?":
          ev.preventDefault();
          this.openHelp();
          return;
        case "Escape":
          closeMenus();
          if (this.ui.search) this.ui.setSearch("");
          else this.ui.clearSelection();
          return;
      }
      if (!onCanvas) return;
      switch (key) {
        case "Delete":
        case "Backspace":
          ev.preventDefault();
          this.cmd.deleteSelection();
          return;
        case "Tab":
          if (single) {
            ev.preventDefault();
            this.cmd.addChild(single);
          }
          return;
        case "Enter":
        case "F2":
          if (single) {
            ev.preventDefault();
            this.startEdit(single);
          } else if (this.ui.singleEdge) {
            ev.preventDefault();
            this.interactionFocusEdge(this.ui.singleEdge);
          }
          return;
        case "n":
        case "N":
          ev.preventDefault();
          this.cmd.createNode(this.ui.prefs.lastType, undefined, { edit: true });
          return;
        case "1":
        case "2":
        case "3":
        case "4":
          if (nodes.length) this.cmd.setType(nodes, NODE_TYPE_ORDER[Number(key) - 1]!);
          return;
        case "c":
        case "C":
          if (nodes.length) this.cmd.toggleCollapse(nodes);
          return;
        case "f":
        case "F":
          this.view.fit(nodes.length ? nodes : undefined);
          return;
        case "0":
          this.view.setZoom(1);
          return;
        case "+":
        case "=":
          this.view.zoomBy(1.25);
          return;
        case "-":
        case "_":
          this.view.zoomBy(0.8);
          return;
        case "ArrowUp":
        case "ArrowDown":
        case "ArrowLeft":
        case "ArrowRight": {
          if (this.ui.prefs.view !== "map") return;
          ev.preventDefault();
          const s = ev.shiftKey ? 50 : 10;
          const dx = key === "ArrowLeft" ? -s : key === "ArrowRight" ? s : 0;
          const dy = key === "ArrowUp" ? -s : key === "ArrowDown" ? s : 0;
          this.interaction.nudge(dx, dy);
          return;
        }
      }
    });
    document.addEventListener("keyup", (ev) => {
      if (ev.key === " ") {
        this.interaction.spaceDown = false;
        this.view.canvas.style.cursor = "default";
      }
    });
  }

  // ------------------------------------------------------------ 閉じる・隠れる・ファイルを落とす

  private bindLifecycle(): void {
    if (this.ephemeral) return;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        this.editor.commit();
        this.persistence.writeEmergency();
        void this.persistence.flush();
        void this.cloud?.flush();
        this.ui.saveCamera(this.store.doc.id, this.view.camera);
      } else {
        // 戻ってきた: 別の端末の変更が無いか確かめる（見張りが切れていても追いつく）
        this.cloud?.checkRemote();
      }
    });
    window.addEventListener("online", () => this.cloud?.checkRemote());
    window.addEventListener("pagehide", () => {
      this.editor.commit();
      this.persistence.writeEmergency();
    });
    window.addEventListener("beforeunload", (ev) => {
      this.editor.commit();
      if (!this.persistence.hasUnsaved) return;
      this.persistence.writeEmergency();
      void this.persistence.flush();
      // 緊急コピーは書けているので通常は止めない。保存に失敗しているときだけ確かめる
      if (this.persistence.status === "error" || this.persistence.status === "conflict") {
        ev.preventDefault();
        ev.returnValue = "";
      }
    });
  }

  private bindDrop(): void {
    const overlay = h("div", { class: "drop-overlay" }, h("div", { class: "drop-card" }, icon("upload", 28, 1.5), h("b", null, "JSON をここに落として読み込む"), h("span", null, "4D Branch で書き出したファイル")));
    overlay.hidden = true;
    document.body.append(overlay);
    let depth = 0;
    const hasFiles = (ev: DragEvent) => [...(ev.dataTransfer?.types ?? [])].includes("Files");
    window.addEventListener("dragenter", (ev) => {
      if (!hasFiles(ev) || this.store.readOnly) return;
      depth++;
      overlay.hidden = false;
    });
    window.addEventListener("dragleave", () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) overlay.hidden = true;
    });
    window.addEventListener("dragover", (ev) => {
      if (hasFiles(ev)) ev.preventDefault();
    });
    window.addEventListener("drop", (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      depth = 0;
      overlay.hidden = true;
      const f = ev.dataTransfer?.files[0];
      if (f && !this.store.readOnly) void openImportDialog(this, f);
    });
  }

  // ------------------------------------------------------------ データの出し入れ

  exportJson(doc: DocData = this.store.doc, filename = exportFileName()): void {
    void this.exportJsonAsync(doc, filename);
  }

  private async exportJsonAsync(doc: DocData, filename: string): Promise<void> {
    let text: string;
    try {
      text = exportText(doc, APP_VERSION);
    } catch (e) {
      toast(`書き出せませんでした（${e instanceof Error ? e.message : String(e)}）`, { tone: "error", ms: 9000 });
      return;
    }
    const done = () => {
      try {
        localStorage.setItem("4d-branch:lastExport", new Date().toISOString());
      } catch {
        /* 記録できなくてもよい */
      }
    };
    if (inArtifactHost()) {
      // claude.ai の Artifact の中: ページからは直接ダウンロードできないので、downloads 機能で保存を頼む
      const dl = await useCapability<DownloadsApi>("downloads", 5000);
      if (dl) {
        try {
          const r = await dl.save({ filename, data: text });
          toast(r.status === "saved" ? `書き出しました: ${filename}` : "書き出しました", { tone: "ok" });
          done();
          return;
        } catch (e) {
          const code = errorCode(e);
          if (code === "declined") return void toast("書き出しをやめました");
          if (code === "rate_limited") return void toast("保存の確認が開いています。閉じてから、もう一度お試しください", { tone: "warn" });
        }
      }
      openCopyDialog(text, filename);
      return;
    }
    downloadText(filename, text);
    toast(`書き出しました: ${filename}`, { tone: "ok" });
    done();
  }

  pickImport(): void {
    if (this.store.readOnly) return;
    const input = h("input", { type: "file", attrs: { accept: ".json,application/json" } });
    input.addEventListener("change", () => {
      const f = input.files?.[0];
      if (f) void openImportDialog(this, f);
    });
    input.click();
  }

  async backupNow(): Promise<void> {
    await this.persistence.flush();
    const b = await this.persistence.createBackup("manual", "手動のバックアップ").catch(() => null);
    if (b) {
      toast("バックアップを作りました", { tone: "ok" });
      await this.refreshLastBackup();
    } else toast(this.persistence.canBackup ? "バックアップを作れませんでした" : "このブラウザではバックアップを作れません。JSON で書き出してください", { tone: "warn" });
  }

  private async refreshLastBackup(): Promise<void> {
    const list = await this.persistence.listBackups().catch(() => []);
    const b = list[0];
    this.lastBackupLabel = b ? { kind: b.kind, when: new Date(b.createdAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) } : null;
    this.onBackupsChanged();
  }

  /** 入れ替える前に安全用バックアップを残し、Undo でも戻せるようにする */
  async replaceDocSafely(doc: DocData, label: string): Promise<void> {
    if (this.store.readOnly) return;
    await this.persistence.flush().catch(() => undefined);
    await this.persistence.createBackup("safety", `「${label}」の前`, this.store.doc).catch(() => undefined);
    this.editor.cancel();
    this.store.replaceDoc(doc, label);
    this.ui.select([]);
    this.ui.setPrefs({ projectFilter: [], scenarioId: null, timeCursor: null });
    this.ui.setSearch("");
    this.view.fit();
    toast(`${label}しました`, { tone: "ok", action: this.cmd.undoAction() });
    void this.refreshLastBackup();
  }

  mergeDoc(doc: DocData): void {
    if (this.store.readOnly) return;
    void this.persistence.createBackup("safety", "「インポート（追加）」の前", this.store.doc).catch(() => undefined);
    const before = new Set(Object.keys(this.store.doc.nodes));
    const res = mergeDocs(this.store.doc, doc);
    this.store.replaceDoc(res.doc, "インポート（追加）");
    const added = Object.keys(this.store.doc.nodes).filter((id) => !before.has(id));
    this.ui.select(added);
    this.view.fit(added);
    toast(`ノード ${res.added.nodes} 件・接続 ${res.added.edges} 本を追加しました${res.reusedProjects ? `（同じ名前のプロジェクト ${res.reusedProjects} 件はまとめました）` : ""}`, { tone: "ok", action: this.cmd.undoAction() });
    void this.refreshLastBackup();
  }

  async loadDemo(): Promise<void> {
    const ok = await confirmDialog({ title: "デモを読み込みますか？", body: "今のデータをデモ（3 つのプロジェクト）に入れ替えます。今の内容は安全用バックアップに残り、「元に戻す」でも戻せます。", ok: "読み込む" });
    if (ok) await this.replaceDocSafely(buildDemoDoc(), "デモを読み込む");
  }

  async newEmptyDoc(): Promise<void> {
    const ok = await confirmDialog({ title: "空のドキュメントにしますか？", body: "すべてのノード・プロジェクト・シナリオを片付けて、白紙から始めます。今の内容は安全用バックアップに残り、「元に戻す」でも戻せます。", ok: "空にする", danger: true });
    if (ok) await this.replaceDocSafely(createEmptyDoc(), "空のドキュメントにする");
  }

  renameDoc(): void {
    if (this.store.readOnly) return;
    void openTextDialog({ title: "ドキュメントの名前", label: "名前", value: this.store.doc.title }).then((v) => {
      const name = v?.trim();
      if (name) this.store.transact("名前を変更", (tx) => tx.setTitle(name));
    });
  }

  editDescription(kind: "project" | "scenario", id: ID): void {
    const g = kind === "project" ? this.store.doc.projects[id] : this.store.doc.scenarios[id];
    if (!g || this.store.readOnly) return;
    void openTextDialog({ title: `「${g.name}」の説明`, label: "説明", value: g.description, multiline: true, placeholder: kind === "scenario" ? "例: 2027 年中に副業の条件を満たし、独立する" : "例: 英単語学習ゲームを事業として伸ばす" }).then((v) => {
      if (v === null) return;
      if (kind === "project") this.cmd.updateProject(id, { description: v });
      else this.cmd.updateScenario(id, { description: v });
    });
  }

  openBackups(): void {
    openBackupDialog(this);
  }

  openHelp(): void {
    openHelpDialog(this);
  }

  startTour(): void {
    closeMenus();
    startTour(this);
  }

  // ------------------------------------------------------------ アカウントへの同期

  resyncCloud(): void {
    this.cloud?.resync();
  }

  private setCloudInfo(state: CloudState | "unavailable", message = ""): void {
    this.cloudInfo = { state, message, lastSyncedAt: this.cloud?.lastSyncedAt ?? null };
    this.onCloudChanged();
  }

  /** claude.ai の Artifact の中で、サインインしていて自分の場所に書けるなら、アカウントにも写しを置く */
  async startCloud(): Promise<void> {
    if (this.ephemeral || !inArtifactHost() || this.cloud) return;
    this.setCloudInfo("connecting");
    const [db, user] = await Promise.all([useCapability<DbApi>("db"), useCapability<UserApi>("user")]);
    let uid: string | null = null;
    try {
      uid = user ? await user.id() : null;
    } catch {
      uid = null;
    }
    if (!db || !uid) {
      this.setCloudInfo("unavailable", "サインインしていないため、このブラウザだけに保存します");
      return;
    }
    let repo: CloudRepo;
    try {
      repo = new CloudRepo(dbBackend(db), uid, this.persistence.tabId);
      db.doc(repo.manifestPath); // 置き場所の名前が使えるか（使えなければ TypeError）
    } catch {
      this.setCloudInfo("unavailable", "アカウントの保存場所を使えないため、このブラウザだけに保存します");
      return;
    }
    const baseKey = `cloud:${uid}`;
    // このブラウザの内容が、前に別のアカウントで同期していた物か（その場合は聞かずに送らない）
    let foreign = false;
    try {
      const owner = await this.persistence.readKv<string>("cloud:owner");
      foreign = !!owner && owner !== uid;
    } catch {
      foreign = false;
    }
    const sync = new CloudSync(repo, {
      getDoc: () => this.store.doc,
      isWriter: () => this.persistence.writer && !this.store.readOnly,
      isDisposable: (doc) => isDisposableDoc(doc),
      isEditing: () => this.editor.active,
      isForeign: () => foreign,
      adopt: async (doc, how, stillOk) => {
        // 入れ替える前の手元を残す: 別の端末の変更なら安全用に、利用者が選んだ切り替えなら必ず（残せなければやめる）。
        // 捨ててよい手元（何もしていないデモ・空）は残さない
        if (how === "remote") await this.persistence.createBackup("safety", "別の端末の内容を読み込む前", this.store.doc).catch(() => undefined);
        if (how === "choice") {
          const saved = await this.persistence.createBackup("safety", "アカウントの内容に切り替える前のこのブラウザの内容", this.store.doc).catch(() => null);
          if (!saved) return false;
        }
        // 読んでいる間・バックアップの間に手元が変わった（入力が始まった）: 入れ替えない
        if (!stillOk()) return false;
        if (!this.persistence.writer || this.store.readOnly) throw new Error("読み込めませんでした（このタブは閲覧のみ）");
        this.editor.cancel();
        if (how === "remote") {
          this.adopting = true;
          try {
            if (!this.store.replaceDoc(doc, "別の端末の内容を読み込む")) throw new Error("読み込めませんでした（このタブは閲覧のみ）");
          } finally {
            this.adopting = false;
          }
        } else {
          // 初めての同期・利用者の選択は「元に戻す」の対象にしない（戻すと、捨てたデモや選ばなかった内容がアカウントへ送られる）
          this.store.load(doc, "load");
          this.persistence.markDirty();
        }
        // 手元への保存を先に済ませる（同期の基準だけが先に残り、閉じたあとで古い手元を送ってしまうのを防ぐ）
        await this.persistence.flush().catch(() => undefined);
        this.ui.pruneSelection((kind, id) => (kind === "node" ? !!this.store.doc.nodes[id] : !!this.store.doc.edges[id]));
        if (how !== "remote") this.view.fit(undefined, { animate: false });
        void this.refreshLastBackup();
        return true;
      },
      backup: async (doc, label) => {
        const saved = await this.persistence.createBackup("conflict", label, doc).catch(() => null);
        void this.refreshLastBackup();
        return !!saved;
      },
      chooseFirst: (remote) => chooseSyncSource({ local: this.store.doc, remote: remote?.manifest ?? null, foreign }),
      readBase: () => this.persistence.readKv<SyncBase>(baseKey),
      writeBase: async (b) => {
        await this.persistence.writeKv(baseKey, b);
        // このブラウザの内容は、このアカウントのもの
        await this.persistence.writeKv("cloud:owner", uid);
        foreign = false;
      },
      notice: (text, tone) => toast(text, { tone, ms: 8000 }),
    });
    this.cloud = sync;
    sync.on((st) => this.setCloudInfo(st, sync.message));
    await sync.start();
  }

  /** 初めてガイドを終えたときに一度だけ、ブラウザに自動削除からの保護を頼む */
  private async askPersistOnce(): Promise<void> {
    if (this.ephemeral || this.ui.prefs.persistAsked) return;
    this.ui.setPrefs({ persistAsked: true });
    await this.persistence.requestPersist();
  }
}
