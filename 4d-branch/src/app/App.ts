// 画面の組み立てと配線: 5 つの領域・ショートカット・右クリック・取り込み・保存の出来事

import { WISHLIST_SIZE_LABEL } from "../demo/wishlist";
import { CanvasView, type Hit } from "../canvas/CanvasView";
import { InlineEditor } from "../canvas/inlineEditor";
import { Interaction } from "../canvas/interaction";
import { Minimap } from "../canvas/minimap";
import { buildDemoDoc } from "../demo/demo";
import { APP_VERSION, NODE_TYPES, NODE_TYPE_ORDER, RELATIONS, RELATION_ORDER, STATUSES, STATUS_ORDER } from "../model/constants";
import { NewerDocError, createEmptyDoc } from "../model/schema";
import type { DocData, ID, NodeType } from "../model/types";
import { capabilityWhenReady, errorCode, inArtifactHost, useCapability, type DbApi, type DownloadsApi, type UserApi } from "../host/claude";
import { isDisposableDoc } from "../demo/demo";
import { CloudRepo, CloudSync, baseCovered, dbBackend, type BootDoc, type CloudState, type SyncBase } from "../persist/cloud";
import { downloadText, exportFileName, exportText, mergeDocs } from "../persist/io";
import type { BackupKind, KeptAside, Persistence } from "../persist/persistence";
import type { Store } from "../store/store";
import { buildBottomBar } from "../ui/bottomBar";
import { chooseSyncSource, openBackupDialog, openCopyDialog, openHelpDialog, openImportDialog, openTextDialog, openWelcome, openWishlistDialog } from "../ui/dialogs";
import { openFutureDialog } from "../ui/futureDialog";
import { MOD, h, isTypingTarget } from "../ui/dom";
import { icon } from "../ui/icons";
import { offerImpactSalary } from "../ui/impactPanel";
import { buildInspector, hasUnsavedInput } from "../ui/inspector";
import { buildLeftSidebar } from "../ui/leftSidebar";
import { buildListView } from "../ui/listView";
import { openReleaseSheet } from "../ui/releaseSheet";
import { startTour } from "../ui/onboarding";
import { closeMenus, closeToasts, confirmDialog, menuOpen, modalOpen, showMenu, toast, type MenuEntry } from "../ui/overlays";
import { buildTopbar } from "../ui/topbar";
import { ACCOUNT_NEWER_BLOCKED, accountNewerBanner, showNewerScreen } from "../ui/newerScreen";
import { Commands } from "./commands";
import type { AppContext, LoadOpts, ReplaceOpts } from "./context";
import { editLocked } from "./editLock";
import type { UiState } from "./uiState";
import { ViewModel } from "./viewModel";
import { buildFuture, futureRelease, futureVersion } from "../demo/futureBundle";
import { FRESH_FUTURE, FUTURE_MIN_ZOOM, NO_AUTO_FUTURE, futureAge, futureMaps, hasEditPrints, hasFutureRoot, hasStaleFuture, inPlaceRoot, isFreshFuture, nearFutureRoot, swapFutureDoc, withNoAutoFuture, yieldsToRemote, type FutureMap } from "../demo/futureSwap";

export interface AppOptions {
  store: Store;
  ui: UiState;
  persistence: Persistence;
  ephemeral: boolean;
  firstRun: boolean;
  /** 保存してあった内容を読めず、代わりの内容（デモ・バックアップ）で始めた */
  bootFallback?: boolean;
  notices: string[];
  mount: HTMLElement;
}

/**
 * 起動したときの手元の記録（アカウントの同期の基準を書くまで残す。どのタブからも読め、開き直しても残る）。
 * 最後に基準を書いてから最初の起動の物。代わりの内容（デモ・バックアップ）で始めたときは、その起動の物
 */
const BOOT_DOC_KEY = "cloud:bootDoc";

function asBootDoc(v: unknown): BootDoc | null {
  const o = v as Partial<BootDoc> | null;
  if (!o || typeof o !== "object" || typeof o.id !== "string" || typeof o.updatedAt !== "string") return null;
  const on = o.on;
  const okOn = on === null || (!!on && typeof on === "object" && typeof on.gen === "string" && typeof on.docId === "string" && typeof on.docUpdatedAt === "string");
  return { id: o.id, updatedAt: o.updatedAt, fallback: !!o.fallback, on: okOn ? (on ? { gen: on.gen, docId: on.docId, docUpdatedAt: on.docUpdatedAt } : null) : undefined };
}

/** 記録したときの基準が同じか */
function sameOn(a: BootDoc["on"], b: BootDoc["on"]): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a === null || b === null) return a === b;
  return a.gen === b.gen && a.docId === b.docId && a.docUpdatedAt === b.docUpdatedAt;
}

/** 「未来の道筋」を押したが、アカウントとの突き合わせが済むのを待つときのお知らせ */
const WAIT_FUTURE = "アカウントの内容を確かめています。済んだら未来の道筋を開きます";

/** 待つのをやめた・待ち終えた: 「済んだら開きます」のお知らせを下げる（もう果たさない約束を出したままにしない） */
function closeWaitToast(): void {
  closeToasts((t) => t === WAIT_FUTURE);
}
/** 閲覧のみのタブで編集しようとしたときのお知らせ */
const READ_ONLY_BLOCKED = "このタブは閲覧のみです。編集するには上の「このタブで編集する」を押してください。";
/** 閲覧のみのタブで「未来の道筋」を押したときのお知らせ */
const READ_ONLY_FUTURE = "このタブは閲覧のみです。未来の道筋を開くには、上の「このタブで編集する」を押してください。";
/** 閲覧のみのタブで、何もしていないデモに未来の道筋を自動で開けないときのお知らせ */
const READ_ONLY_AUTO_FUTURE = "このタブは閲覧のみです（別のタブかウィンドウでも開いています）。上の「このタブで編集する」を押すと、未来の道筋を開きます";
/** 「このタブで編集する」で引き継いだときのお知らせ */
const TAKEN_OVER = "このタブで編集できるようになりました";
/**
 * アカウントに新しい版の内容があって編集を止めたら下げるお知らせ（止めた帯と食い違う）: 「このタブで編集する」を押すよう勧める物
 * （そのボタンは出さず、押しても編集できない）と、引き継いだ直後の突き合わせで分かったときの「このタブで編集できるようになりました」
 */
const TAKE_OVER_TOASTS = new Set([READ_ONLY_BLOCKED, READ_ONLY_FUTURE, READ_ONLY_AUTO_FUTURE, TAKEN_OVER]);
/** 未来の道筋を一度に開く入れ替えの名前（履歴・安全用バックアップ） */
const FUTURE_OPEN_LABEL = "未来の道筋を開く";
/** 地図の未来の道筋が、このページより新しい版で作られているとき（古い版に戻さない） */
const FUTURE_NEWER = "この地図の未来の道筋は、このページより新しい版で作られています。ページを開き直すと新しい版で見られます";
/** 新しい版にする前に確かめ直したら、もう新しい版だった */
const FUTURE_UP_TO_DATE = "未来の道筋はもう新しい版になっています";
/** 新しい版にする前に確かめ直したら、地図に未来の道筋が無かった */
const FUTURE_GONE = "未来の道筋が地図から無くなったので、差し替えませんでした";
/** 地図の右下の「未来の道筋」のボタンの説明 */
const FUTURE_BTN_TITLE = "未来の道筋（仕事・3 年の分かれ道）: 地図にあれば今日に寄る・無ければ開く";
/**
 * 自動で開く前に、アカウントとの最初の突き合わせを待つ長さ。これより遅い・つながらないときは開く
 * （開いたばかりで手を付けていない未来の道筋は、後で重なったら別の端末の内容に譲るので、待ち続けて見せないより良い）
 */
const SYNC_WAIT_MS = 10_000;

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
  private cloudStarting = false;
  private cloudLateArmed = false;
  /** 未来の道筋を開いている途中（二度押し・自動で開くのと重なっても、入れ替えは 1 回） */
  private openingFuture = false;
  /** 「未来の道筋」を押したが、アカウントとの突き合わせが済むのを待っている頼み（0 = 無し。取り消すと 0 に戻す） */
  private futureWait = 0;
  /** この起動では、もう自動で開かない（利用者が未来の道筋の読み込みの確認を開いた: 決めるのは利用者） */
  private futureAutoDeclined = false;
  private futureWaitSeq = 0;
  /** 「この地図の未来の道筋は、このページより新しい版」を、このページを開いている間に知らせた */
  private futureNewerTold = false;
  /** 「未来の道筋」のボタン（古い版の地図があれば「新」の印を付ける） */
  private futureBtn: HTMLElement | null = null;
  cloudInfo: { state: CloudState | "unavailable"; message: string; lastSyncedAt: string | null } | null = null;
  onCloudChanged: () => void = () => undefined;
  private adopting = false;
  /** 起動したときに読み込んだ手元（どの編集よりも前）。アカウントの同期で、手元が古いかを決める */
  private readonly bootDoc: BootDoc;
  /** 起動したときの手元を記録し終えた（同期を始める前に待つ） */
  private readonly bootRecorded: Promise<void>;

  private readonly mount: HTMLElement;
  /** このページより新しい版で保存されたデータに気づいて、編集をやめた（画面は開き直すよう伝える物に差し替えた） */
  private newerShown = false;
  /**
   * アカウントの写しがこのページより新しい版と分かって、新しい編集を受けなくなった（開き直すまで。書き手に戻っても・
   * 「このタブで編集する」でも・後の同期でも戻さない）。それまでの編集は手元に保存したまま（送らない・捨てない）
   */
  private heldByAccount = false;
  /** そのときの帯（開き直すまで同じ物を出し続ける。描き直しで「ページを開き直す」のフォーカスを外さない） */
  private newerBanner: HTMLElement | null = null;
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
    this.mount = opts.mount;
    const d0 = this.store.doc;
    this.bootDoc = { id: d0.id, updatedAt: d0.updatedAt, fallback: !!opts.bootFallback && !opts.ephemeral };
    this.bootRecorded = this.recordBootDoc();
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
    // 未来の道筋（仕事・3 年の分かれ道）: どの幅でも見える所に置く（あれば今日に寄る・無ければ開く）。古い版の地図があれば「新」の印
    this.futureBtn = h(
      "button",
      { class: "future-btn", type: "button", title: FUTURE_BTN_TITLE, onClick: () => void this.showFuture() },
      icon("split", 15),
      h("span", null, "未来の道筋"),
      h("span", { class: "future-new", attrs: { "aria-hidden": "true" } }, "新"),
    );
    const zoomCtl = h(
      "div",
      { class: "zoom-ctl" },
      this.futureBtn,
      h("span", { class: "zoom-sep" }),
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
        h("button", { class: "btn", type: "button", onClick: () => this.loadWishlist() }, icon("goal", 15), "やりたいことリスト"),
        h("button", { class: "btn", type: "button", onClick: () => void this.showFuture() }, icon("split", 15), "未来の道筋"),
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
      // 未来の道筋を一度に開いた入れ替えを元に戻した・やり直した地図も、手を付けていない中身（開く前のデモ・空か、開いたままの地図）。
      // 重なったら別の端末の内容に譲る（戻しただけで、別の端末で書いた新しい内容をアカウントから押し流さない）
      if ((info.source === "undo" || info.source === "redo") && info.label === FUTURE_OPEN_LABEL) {
        this.store.doc.meta = { ...this.store.doc.meta, [FRESH_FUTURE]: this.store.doc.updatedAt };
      }
      if (!this.ephemeral && info.source !== "load" && info.source !== "remote") this.persistence.markDirty();
      if (info.source === "tx" || info.source === "undo" || info.source === "redo" || (info.source === "replace" && !this.adopting)) {
        this.cloud?.markDirty();
      }
    });
    this.persistence.on("writer", () => this.applyReadOnly());

    this.shell = h("div", { class: "app-shell" }, buildTopbar(this), buildLeftSidebar(this), center, buildInspector(this), buildBottomBar(this));
    opts.mount.replaceChildren(this.shell, h("div", { attrs: { id: "overlay-root" } }));

    // ---- 配線
    this.store.on("change", (info) => {
      this.syncEmpty();
      this.syncFutureNew();
      this.syncDeep();
      // 全部が入れ替わったら、検索の索引は空いた時間に作り直す（初めての検索の 1 文字を待たせない）
      if (info.full) this.warmSearchSoon();
    });
    this.persistence.on("writer", (w) => {
      this.renderBanner();
      if (!w) this.cloud?.writerLost();
    });
    this.store.on("blocked", () => toast(this.heldByAccount ? ACCOUNT_NEWER_BLOCKED : READ_ONLY_BLOCKED, { tone: "warn" }));
    this.ui.on("prefs", (p) => this.applyPrefs(p));
    this.view.onCamera(() => this.onCamera());
    this.persistence.on("status", () => this.renderBanner());
    this.persistence.on("notice", (n) => toast(n.text, { tone: n.level === "error" ? "error" : n.level === "warn" ? "warn" : "info", ms: 7000 }));

    this.persistence.on("remote", () => this.scheduleRemoteReload());
    // 開いている間に、別のタブの新しい版のページが保存した（保存の競合・引き継ぎ・読み直し・保存先の版が上がったことで気づく）: 編集をやめる
    this.persistence.on("blocked", (e) => this.showNewer(e.kept));
    this.bindKeys();
    this.bindLifecycle();
    this.bindDrop();

    this.applyPrefs({});
    this.syncEmpty();
    this.syncFutureNew();
    this.syncDeep();
    // ページに入れた 3 か月ごとの地図を読み終えた（後から読んだとき）: パネルの幅と、最初の見取り図・新しい地図の知らせ
    this.vm.deep.onReady(() => {
      this.syncDeep();
      this.offerDeep();
    });
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
      else this.offerOnce();
      this.offerFutureUpdate();
      this.autoOpenFuture();
      // 3 年の分かれ道を初めて見せた後、年収がまだ仮なら一度だけ知らせる
      offerImpactSalary(this);
      // 3 か月ごとの地図（版 7）: 広い画面は見取り図を見せて始め、新しい地図の知らせを一度だけ
      this.offerDeep();
      this.afterTour = () => void this.askPersistOnce();
      this.warmSearchSoon();
    });
    void this.refreshLastBackup();
  }

  // ------------------------------------------------------------ 表示

  /** アカウントの写しがこのページより新しい版と分かって、編集を止めている（開き直すまで） */
  get accountNewer(): boolean {
    return this.heldByAccount;
  }

  /**
   * 閲覧のみかを決め直す（書き手が変わった・引き継いだ・新しい版と分かった）。新しい版の訳は開き直すまで消えないので、
   * 書き手に戻っても編集できる状態には戻らない
   */
  private applyReadOnly(): void {
    this.store.readOnly = editLocked({ writer: this.persistence.writer, ephemeral: this.ephemeral, accountNewer: this.heldByAccount, localNewer: this.newerShown });
  }

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

  /** 検索の索引を、手が空いたときに作っておく（requestIdleCallback。無ければ少し後に） */
  private warmSearchSoon(): void {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) ric(() => this.vm.warmSearch(), { timeout: 4000 });
    else setTimeout(() => this.vm.warmSearch(), 1500);
  }

  /** 3 か月ごとの地図（版 7）があるか（右のパネルを少し広く・狭い画面の引き出しは幅いっぱいに。src/styles/deep.css） */
  private syncDeep(): void {
    const on = !!this.vm.deep.get();
    if (this.shell.classList.contains("has-deep") === on) return;
    this.shell.classList.toggle("has-deep", on);
    setTimeout(() => this.view.resize(), 60);
  }

  /** 新しい地図の知らせを出した（この起動で。待っている間に重ねて出さない） */
  private deepOffered = false;

  /**
   * 3 か月ごとの地図（版 7）があれば、右のパネルに見取り図を見せて始める（何も選ばない概要の先頭。広い画面はパネル、
   * スマホは最初の 1 枚として引き出しに: 作業メモ SPEC v1 §5.1・§5.9・user-1・user-5）。
   * 新しい地図の知らせは版ごとに一度だけ（表示の設定 releaseSheet。どの道で地図が入っても: 作業メモ SPEC §5.9・user-5）。
   * 初めての人のようこそ画面・操作ガイド・確認の途中は、閉じるまで待つ
   */
  private offerDeep(): void {
    if (this.deepOffered || this.newerShown) return;
    const ctx = this.vm.deep.get();
    if (!ctx) return;
    this.deepOffered = true;
    if (!this.ui.prefs.rightOpen && !this.ui.selection.nodes.size) this.ui.setPrefs({ rightOpen: true });
    // 文章の組み立ての、地図ごとに 1 回の下ごしらえ（道の覚え・数え）を空いた時間に済ませる（初めてカードを選ぶ 1 回を待たせない）
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const warm = (): void => {
      const c = this.vm.deep.get();
      if (!c) return;
      // ノードの ID → 地図の番号の表と、文章の組み立ての下ごしらえ
      c.indexOf(c.idOf(0));
      c.text().card(0);
    };
    if (ric) ric(warm, { timeout: 3000 });
    else setTimeout(warm, 1500);
    const rel = ctx.map.header.release;
    const seen = Math.max(this.ui.prefs.releaseSheet, typeof this.ui.storedPrefs().releaseSheet === "number" ? this.ui.storedPrefs().releaseSheet! : 0);
    if (rel < 7 || seen >= rel) return;
    const show = (): void => {
      if (this.newerShown) return;
      if (modalOpen() || document.querySelector(".tour")) {
        setTimeout(show, 800);
        return;
      }
      const now = this.vm.deep.get();
      if (!now) return;
      this.ui.setPrefs({ releaseSheet: rel });
      openReleaseSheet(this, now);
    };
    setTimeout(show, 300);
  }

  private syncEmpty(): void {
    // ノードの数は索引が持つ（文書をなめない。作業メモ perf-4・gaps-8）
    this.emptyHint.hidden = this.vm.nodeCount > 0;
  }

  /** 「新」の印の材料（予測の入口のノードの版）と、そのときの答え */
  private futureNewKey = "";
  private futureNewOn = false;

  /**
   * 古い版の未来の道筋があれば、「未来の道筋」のボタンに「新」の印（断って聞かれなくなっても、新しい版にできると分かる）。
   * 入口のノードだけを見る（索引が覚えている入口。入口のノードが変わったときだけ確かめ直す）
   */
  private syncFutureNew(): void {
    const btn = this.futureBtn;
    if (!btn) return;
    const idx = this.vm.index;
    const key = `${idx.version.roots}|${idx.source === this.store.doc}|${futureVersion()}|${futureRelease()}`;
    if (key !== this.futureNewKey) {
      this.futureNewKey = key;
      const nodes: DocData["nodes"] = {};
      for (const id of idx.forecastRoots) {
        const n = this.store.doc.nodes[id];
        if (n) nodes[id] = n;
      }
      this.futureNewOn = hasStaleFuture({ ...this.store.doc, nodes }, futureVersion(), futureRelease());
    }
    const on = this.futureNewOn;
    if (btn.classList.contains("has-new") === on) return;
    btn.classList.toggle("has-new", on);
    btn.title = on ? `${FUTURE_BTN_TITLE}（新しい版があります）` : FUTURE_BTN_TITLE;
  }

  private onCamera(): void {
    this.zoomLabel.textContent = `${Math.round(this.view.camera.zoom * 100)}%`;
    if (this.ephemeral) return;
    if (this.cameraSaveTimer) clearTimeout(this.cameraSaveTimer);
    this.cameraSaveTimer = setTimeout(() => this.ui.saveCamera(this.store.doc.id, this.view.camera), 600);
  }

  /**
   * その場の入力（カードの題名）か、パネルの入力欄（年収・書きかけのタグなど）に、まだ入れていない入力がある途中か。同期の取り込みは終わるまで待つ
   * （入れ替えると欄が作り直されて入力が消え、残りのキーがキャンバスの操作になる）。
   * 打つたびに入れる欄（詳細の題名など）にフォーカスがあるだけなら待たない（作り直した後も、フォーカスと文字の位置が残る）
   */
  editingNow(): boolean {
    return this.editor.active || hasUnsavedInput(document.activeElement);
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
    // アカウントに新しい版の内容があるときの帯は、開き直すまで同じ物を先頭に出したまま（保存の状態が変わるたびに描き直しても、
    // 「ページを開き直す」のフォーカスを外さない）
    const held = this.heldByAccount ? (this.newerBanner ??= accountNewerBanner()) : null;
    for (const c of [...b.children]) if (c !== held) c.remove();
    if (held && held.parentElement !== b) b.prepend(held);
    const per = this.persistence;
    const add = (tone: string, iconName: string, text: string, ...actions: HTMLElement[]) => b.append(h("div", { class: `banner tone-${tone}` }, icon(iconName, 15), h("span", { class: "banner-text" }, text), ...actions));
    if (this.ephemeral) {
      const back = h("button", { class: "btn btn-sm", type: "button" }, "ふだんの画面へ");
      back.addEventListener("click", () => {
        history.replaceState(null, "", location.pathname + location.search.replace(/[?&](stress|demo)(=[^&]*)?/g, "").replace(/^&/, "?"));
        location.reload();
      });
      add("info", "layers", `性能確認用の一時表示です（${this.vm.nodeCount.toLocaleString("ja-JP")} ノード）。変更は保存されず、ふだんのデータにも触れません。`, back);
      return;
    }
    if (!per.writer) {
      // アカウントに新しい版の内容があるときは、引き継いでも編集できないので「このタブで編集する」は出さない（上の帯だけ）
      if (!held)
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
    // アカウントに新しい版の内容がある: 引き継いでも編集できない（開き直すまで）。別のタブのロックも奪わない
    if (this.heldByAccount) return;
    const doc = await this.persistence.takeOver();
    // 保存されているのがこのページより新しい版だった: 引き継がずに止めた（画面は "blocked" の知らせで差し替わる）
    if (this.persistence.blocked) return;
    if (doc) this.store.load(doc, "load");
    // 引き継ぐ間にアカウントの新しい版に気づいていたら、閲覧のみのまま（決まりは applyReadOnly の 1 か所）
    this.applyReadOnly();
    this.cloud?.resync();
    this.renderBanner();
    // 閲覧のみのタブはアカウントを読んでいないので、新しい版の内容があると分かるのは、この後の突き合わせ（そのときは下げる）
    if (!this.store.readOnly) toast(TAKEN_OVER, { tone: "ok" });
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
    // 保存されているのがこのページより新しい版だった: 開きも上書きもせずに止めた（画面は "blocked" の知らせで差し替わる）
    if (this.persistence.blocked) return;
    if (doc) this.store.load(doc, "load");
    if (choice === "reload" && doc) toast("保存されている最新を開きました。このタブの内容はバックアップに残してあります（メニュー →「バックアップと復元」）。", { ms: 6000 });
    this.renderBanner();
  }

  private scheduleRemoteReload(): void {
    if (this.remoteTimer) clearTimeout(this.remoteTimer);
    this.remoteTimer = setTimeout(async () => {
      if (this.persistence.blocked) return;
      let s: Awaited<ReturnType<Persistence["readStored"]>> = null;
      try {
        s = await this.persistence.readStored();
      } catch (e) {
        // 別のタブの新しい版のページが保存した: 読めないのは壊れたからではない。このタブの編集をやめ、開き直してもらう
        if (e instanceof NewerDocError) return this.persistence.blockNewer();
        s = null;
      }
      if (s && !this.persistence.writer) this.store.load(s.doc, "remote");
    }, 400);
  }

  /**
   * このページより新しい版で保存されたデータに気づいた（保存の競合・引き継ぎ・別のタブの保存の読み直し・保存先の版が上がった）。
   * 保存は Persistence が止めている。ここでは同期を止め、編集と設定の保存をやめ、画面を開き直すよう伝える物に差し替える
   * （kept: このタブのまだどこにも無い変更を残した所。画面で伝える）。待っている自動の表示（未来の道筋を開くなど）も、以後は動かない
   */
  private showNewer(kept: KeptAside): void {
    if (this.newerShown) return;
    this.newerShown = true;
    this.cloud?.stop();
    this.applyReadOnly();
    this.ui.persistPrefs = false;
    if (this.remoteTimer) clearTimeout(this.remoteTimer);
    if (this.cameraSaveTimer) clearTimeout(this.cameraSaveTimer);
    this.editor.cancel();
    closeMenus();
    showNewerScreen(this.mount, { kept });
  }

  /**
   * アカウントの写しが、このページより新しい版のアプリで保存されていると分かった（同期はもう止めてあり、開き直すまで再開しない）。
   * 新しい編集を受けない: その場の入力は確定してから（打った文字も手元に残る）ストアを閲覧のみにし、開き直すよう伝える帯を出す。
   * それまでの編集は手元に保存したまま（送らない・捨てない。次の版が扱う）。以後は書き手に戻っても・「このタブで編集する」でも・
   * 後の同期でも編集できる状態に戻さない。開いていたメニュー（開いたときの状態で項目を作ってある）と、
   * 突き合わせを待って未来の道筋を開く頼みもやめる。「このタブで編集できるようになりました」（引き継いだ直後の突き合わせで分かったとき）と、
   * 「このタブで編集する」を押すよう勧めるお知らせも下げる（帯と食い違う）。形が違う・壊れた写しでは呼ばれない（今までどおり編集できる）。
   * 設計: docs/DESIGN.md §5・§5.1
   */
  private holdForAccountNewer(): void {
    if (this.heldByAccount || this.newerShown) return;
    this.editor.commit();
    this.heldByAccount = true;
    this.applyReadOnly();
    if (this.futureWait) closeWaitToast();
    this.futureWait = 0;
    closeToasts((t) => TAKE_OVER_TOASTS.has(t));
    closeMenus();
    this.renderBanner();
  }

  // ------------------------------------------------------------ メニュー

  private pickType(x: number, y: number, pick: (t: NodeType) => void): void {
    showMenu(x + 6, y + 6, [{ header: "ここに作る" }, ...NODE_TYPE_ORDER.map((t) => ({ label: NODE_TYPES[t].label, icon: t, shortcut: NODE_TYPES[t].key, hint: NODE_TYPES[t].hint, run: () => pick(t) }))], { minWidth: 180, className: "type-menu" });
  }

  private contextMenu(hit: Hit, x: number, y: number, world: { x: number; y: number }): void {
    const { cmd, ui, store, vm } = this;
    const ro = store.readOnly;
    let entries: MenuEntry[] = [];
    if (hit.kind === "node" || hit.kind === "badge" || hit.kind === "port") {
      const ids = [...ui.selection.nodes];
      // 3 年の分かれ道のカードの開く・閉じるは見え方だけ（閲覧のみのタブでも使える）
      const viewOnly = ids.every((id) => vm.inImpact(id));
      const single = ids.length === 1 ? store.doc.nodes[ids[0]!] : null;
      const typeSub = NODE_TYPE_ORDER.map((t) => ({ label: NODE_TYPES[t].label, icon: t, shortcut: NODE_TYPES[t].key, checked: !!single && single.type === t, run: () => cmd.setType(ids, t) }));
      const statusSub = STATUS_ORDER.map((s) => ({ label: STATUSES[s].label, swatch: STATUSES[s].color, checked: !!single && single.status === s, run: () => cmd.setStatus(ids, s) }));
      const projSub = store.doc.projectOrder.map((pid) => {
        const p = store.doc.projects[pid]!;
        const all = ids.every((id) => store.doc.nodes[id]?.projectIds.includes(pid));
        return { label: p.name, swatch: p.color, checked: all, run: () => cmd.toggleProjectOf(ids, pid) };
      });
      // 開閉の向きは、開閉する物だけで決める（C と同じ。先の無いカードを混ぜて選んでも、閉じたカードには「展開する」）
      const collapsed = cmd.collapsedAll(ids);
      const canCollapse = cmd.canToggleCollapse(ids);
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
        { label: collapsed ? "展開する" : "この先を折りたたむ", icon: collapsed ? "expand" : "collapse", shortcut: "C", disabled: (ro && !viewOnly) || !canCollapse, run: () => cmd.toggleCollapse(ids) },
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
        // 閲覧のみのタブでも、3 年の分かれ道があれば見え方だけ開ける（文書の折りたたみはそのまま）
        { label: "折りたたみをすべて開く", icon: "expand", disabled: ro && !vm.impactRoots().length, run: () => cmd.expandAll() },
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
      if (this.newerShown || document.querySelector(".modal-backdrop:not(.closing), .tour")) return;
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
        this.ui.flushPrefs();
      } else {
        // 戻ってきた: 別の端末の変更が無いか確かめる（見張りが切れていても追いつく）
        this.cloud?.checkRemote();
      }
    });
    window.addEventListener("online", () => this.cloud?.checkRemote());
    window.addEventListener("pagehide", () => {
      this.editor.commit();
      this.persistence.writeEmergency();
      this.ui.flushPrefs();
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

  /**
   * 書き出す。保存できた（保存を頼んで受けてもらえた・コピーの画面で「保存しました」）なら true。
   * 断られた・確認が重なった・書き出せなかったなら false。mustSave: コピーの画面は「保存しました」を押したときだけ true
   */
  private async exportJsonAsync(doc: DocData, filename: string, mustSave = false): Promise<boolean> {
    let text: string;
    try {
      text = exportText(doc, APP_VERSION);
    } catch (e) {
      toast(`書き出せませんでした（${e instanceof Error ? e.message : String(e)}）`, { tone: "error", ms: 9000 });
      return false;
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
          return true;
        } catch (e) {
          const code = errorCode(e);
          if (code === "declined") {
            toast("書き出しをやめました");
            return false;
          }
          if (code === "rate_limited") {
            toast("保存の確認が開いています。閉じてから、もう一度お試しください", { tone: "warn" });
            return false;
          }
        }
      }
      const saved = await openCopyDialog(text, filename, { mustSave });
      if (saved && mustSave) done();
      return saved;
    }
    downloadText(filename, text);
    toast(`書き出しました: ${filename}`, { tone: "ok" });
    done();
    return true;
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

  /**
   * 入れ替える前に安全用バックアップを残し、Undo でも戻せるようにする。入れ替えたら true。
   * still: 保存とバックアップを待った後に確かめ直す（その間に同期で別の内容を読み込んだ・書き始めた なら入れ替えない）。
   * markBefore: 入れ替える前の地図の meta に足す印（バックアップにも「元に戻す」で戻る物にも付く）
   */
  async replaceDocSafely(doc: DocData, label: string, opts: ReplaceOpts = {}): Promise<boolean> {
    if (this.store.readOnly) return false;
    // 別の中身に入れ替える（デモ・空・復元・インポート）: 突き合わせを待って開くはずだった未来の道筋の頼みは取り消す（選んだ中身を後から入れ替えない）
    if (this.futureWait) closeWaitToast();
    this.futureWait = 0;
    await this.persistence.flush().catch(() => undefined);
    // 未来の道筋が何もしていないデモ・空に入ってくるなら、どの道から来ても入れ替える前の地図に印を付ける（メニューの読み込み・復元も）
    const markFor = (): Record<string, unknown> | undefined => opts.markBefore ?? this.futureMarkFor(doc);
    const mark0 = markFor();
    await this.persistence.createBackup("safety", `「${label}」の前`, mark0 ? { ...this.store.doc, meta: { ...this.store.doc.meta, ...mark0 } } : this.store.doc).catch(() => undefined);
    if (this.store.readOnly || (opts.still && !opts.still())) return false;
    this.editor.cancel();
    // 印は入れ替える直前に付ける（入れ替える物の前の姿として履歴に残り、「元に戻す」で印ごと戻る）
    const mark = markFor();
    if (mark) this.store.doc.meta = { ...this.store.doc.meta, ...mark };
    if (!this.store.replaceDoc(doc, label)) return false;
    // 入れ替えた直後の時刻を印に（手を付けるまでの間に、アカウントで別の端末の内容と重なったら、こちらを送らずに読み込む）
    if (opts.fresh) this.store.doc.meta = { ...this.store.doc.meta, [FRESH_FUTURE]: this.store.doc.updatedAt };
    this.ui.select([]);
    this.ui.setPrefs({ projectFilter: [], scenarioId: null, timeCursor: null });
    this.ui.setSearch("");
    // 全体を見てよい: 入れ替えた直後に 1 回だけ（変更のたびではない）
    const all = Object.keys(this.store.doc.nodes);
    this.view.fit(opts.fitTo ? opts.fitTo(this.store.doc, all) : undefined, { minZoom: opts.fitMinZoom });
    toast(opts.done ?? `${label}しました`, { tone: "ok", action: this.cmd.undoAction() });
    void this.refreshLastBackup();
    return true;
  }

  mergeDoc(doc: DocData, opts: LoadOpts & { label?: string; select?: boolean } = {}): void {
    if (this.store.readOnly) return;
    if (this.futureWait) closeWaitToast();
    this.futureWait = 0;
    const label = opts.label ?? "インポート（追加）";
    // 未来の道筋を何もしていないデモ・空に足す: 足す前の地図に印（「元に戻す」・バックアップで戻した地図は、もう自動では入れ替えない）
    const mark = this.futureMarkFor(doc);
    if (mark) this.store.doc.meta = { ...this.store.doc.meta, ...mark };
    void this.persistence.createBackup("safety", `「${label}」の前`, this.store.doc).catch(() => undefined);
    // 全体を見てよい: 追加の取り込みの前と後に 1 回ずつ（変更のたびではない）
    const before = new Set(Object.keys(this.store.doc.nodes));
    const res = mergeDocs(this.store.doc, doc);
    this.store.replaceDoc(res.doc, label);
    // 全体を見てよい: 同じ取り込みの後の 1 回
    const added = Object.keys(this.store.doc.nodes).filter((id) => !before.has(id));
    this.ui.select(opts.select === false ? [] : added);
    this.view.fit(opts.fitTo ? opts.fitTo(this.store.doc, added) : added, { minZoom: opts.fitMinZoom });
    const n = (v: number) => v.toLocaleString("ja-JP");
    const reused = [res.reusedProjects ? `プロジェクト ${res.reusedProjects} 件` : "", res.reusedScenarios ? `シナリオ ${res.reusedScenarios} 件` : ""].filter(Boolean).join("・");
    toast(`${opts.done ?? ""}ノード ${n(res.added.nodes)} 件・接続 ${n(res.added.edges)} 本を追加しました${reused ? `（同じ名前の${reused}はまとめました）` : ""}`, { tone: "ok", action: this.cmd.undoAction() });
    void this.refreshLastBackup();
  }

  /** やりたいことリストを、確かめてから読み込む */
  loadWishlist(): void {
    if (this.store.readOnly) return;
    if (!this.ui.prefs.wishlistOffered) this.ui.setPrefs({ wishlistOffered: true });
    openWishlistDialog(this);
  }

  /** 未来の道筋（仕事・3 年の分かれ道）を、確かめてから読み込む。もう地図にあれば、2 つ目は足さずに今日へ寄る */
  loadFuture(): void {
    if (this.store.readOnly) return;
    // 利用者がここで決める: 突き合わせを待って開くはずだった頼みも、この起動の自動で開くのもやめる（確認を閉じた後に、勝手に入れ替えない）
    if (this.futureWait) closeWaitToast();
    this.futureWait = 0;
    this.futureAutoDeclined = true;
    if (!this.ui.prefs.futureOffered) this.ui.setPrefs({ futureOffered: true });
    if (hasFutureRoot(this.store.doc)) {
      // 古い版（10 年の道筋など）なら、今日に寄ってから新しい版にするか聞く。このページより新しい版の地図なら訳を知らせる（どちらも showFuture が）
      const st = this.futureState();
      const asks = !st.newer.length && st.stale.length > 0 && !this.futureDeclined();
      const tells = st.newer.length > 0 && !this.futureNewerTold;
      if (!asks && !tells) toast("未来の道筋はもう地図にあります。今日（入口）に寄りました", { ms: 5000 });
      void this.showFuture();
      return;
    }
    openFutureDialog(this);
  }

  /** 今の地図の未来の道筋と版の様子（stale: このページの版より古い・newer: このページより新しい版で作った） */
  private futureState(): { maps: FutureMap[]; stale: FutureMap[]; newer: FutureMap[] } {
    const maps = futureMaps(this.store.doc);
    const age = (m: FutureMap) => futureAge(m, futureVersion(), futureRelease());
    return { maps, stale: maps.filter((m) => age(m) === "old"), newer: maps.filter((m) => age(m) === "newer") };
  }

  /** この版への差し替えを、「未来の道筋」から聞いて断った（この端末で。別のタブで断った物も） */
  private futureDeclined(): boolean {
    return this.ui.isFutureDeclined(futureVersion());
  }

  /** 地図の未来の道筋が、このページより新しい版で作られている: 差し替えずに訳を知らせる（always でなければ、このページを開いている間に 1 回） */
  private tellNewerFuture(always = false): void {
    if (this.futureNewerTold && !always) return;
    this.futureNewerTold = true;
    toast(FUTURE_NEWER, { ms: 9000 });
  }

  /**
   * 「未来の道筋」ボタン: 地図にあれば今日の近くに寄る。何もしていないデモ・空の地図なら、すぐ未来の道筋を開く。
   * 自分で書いた内容があれば、追加か入れ替えかを選ぶ確認を出す
   */
  async showFuture(): Promise<void> {
    // 予測の入口（索引が覚えている。文書の順で最初の物）
    const idx = this.vm.index;
    const rootId = this.vm.forecastRootIds().sort((a, b) => idx.nodeOrder(a) - idx.nodeOrder(b))[0];
    const root = rootId ? this.store.doc.nodes[rootId] : undefined;
    if (root) {
      if (this.ui.prefs.view !== "map") this.ui.setPrefs({ view: "map" });
      // 絞り込み・シナリオで隠れていたら「薄くする」にして出す（検索で選んだときと同じ）
      this.cmd.revealNode(root.id);
      this.ui.select([root.id]);
      this.view.fit(nearFutureRoot(this.store.doc), { minZoom: FUTURE_MIN_ZOOM });
      // 地図の未来の道筋がこのページより新しい版で作られていれば、古い版に戻さずに訳を知らせる（このページで 1 回）。
      // 同梱より古い版（10 年の道筋など）なら、押したこの時に新しい版にするか聞く（お知らせを見逃しても新しい版にできる。
      // 断ったら、この版ではもう聞かない。お知らせとメニューからはできる）
      const st = this.futureState();
      if (st.newer.length) this.tellNewerFuture();
      else if (!this.store.readOnly && st.stale.length && !this.futureDeclined()) void this.swapFuture("button");
      return;
    }
    if (this.store.readOnly) {
      toast(this.heldByAccount ? ACCOUNT_NEWER_BLOCKED : READ_ONLY_FUTURE, { tone: "warn" });
      return;
    }
    if (!isDisposableDoc(this.store.doc)) return this.loadFuture();
    // 同期が止まっている（利用者が直す・決めるまで進まない）: 待たせずに、追加か入れ替えかを選んでもらう
    const st = this.cloudInfo?.state;
    if (st === "paused" || st === "error") {
      toast("アカウントとの同期が止まっているため、読み込み方（追加か入れ替えか）を選んでください", { tone: "warn", ms: 6000 });
      return this.loadFuture();
    }
    // アカウントとの突き合わせの途中: 済んでから開く（先に入れ替えると、別の端末で書いた新しい内容をこの地図で上書きしてしまう）
    if (!this.syncQuiet()) return this.openFutureAfterSync();
    await this.openFutureNow("button");
  }

  /**
   * アカウントとの突き合わせが落ち着いたか（押されて地図を入れ替えてよいか）。同期が無い（Artifact の外）・この起動で突き合わせ終えた、
   * またはこの起動ではもう同期しない（止められた・書けない共有・サインインしていない。機能の返事を待っている間は除く）。
   * つながらない（あとで同期する）・突き合わせの途中・選んでもらう確認の途中は落ち着いていない
   */
  private syncQuiet(): boolean {
    const st = this.cloudInfo?.state;
    return st === undefined || st === "synced" || st === "off" || st === "denied" || (st === "unavailable" && !this.cloudLateArmed);
  }

  /**
   * 突き合わせが済むのを待ってから、もう一度「未来の道筋」を押したのと同じにする（読み込んだ別の端末の内容があれば、追加か入れ替えかを聞く）。
   * 30 秒たっても済まなければ、追加か入れ替えかを選ぶ確認を出す（押した人が決める）
   */
  private openFutureAfterSync(): void {
    // もう一度押された: 待っていることを知らせ直す（黙って何もしないように見せない。同じお知らせが出ていれば重ねない）
    const showing = [...document.querySelectorAll(".toast:not(.closing) .toast-text")].some((t) => t.textContent === WAIT_FUTURE);
    if (!showing) toast(WAIT_FUTURE, { ms: 5000 });
    if (this.futureWait) return;
    const me = (this.futureWait = ++this.futureWaitSeq);
    const started = Date.now();
    const retry = (): void => {
      // 取り消された（利用者が自分で読み込みの確認を開いた など）・新しい頼みに替わった・新しい版のデータで止めた
      if (this.futureWait !== me || this.newerShown) return;
      // 入力・メニュー・確認・操作ガイドの途中なら待つ（自動で開くときと同じ。書きかけを消さない・閉じた後に勝手に入れ替えない）
      const busy = this.futureBusy();
      // 待つ間に同期が止まった（利用者が直す・決めるまで進まない）: もう待たない（showFuture が訳を知らせて確認を出す）
      const st = this.cloudInfo?.state;
      const ready = (this.syncQuiet() || st === "paused" || st === "error") && !busy;
      if (!ready && Date.now() - started < 30000) {
        setTimeout(retry, 400);
        return;
      }
      this.futureWait = 0;
      closeWaitToast();
      if (ready) void this.showFuture();
      else if (this.store.readOnly) toast(this.heldByAccount ? ACCOUNT_NEWER_BLOCKED : READ_ONLY_FUTURE, { tone: "warn" });
      else if (!busy) this.loadFuture();
      else toast("未来の道筋は、入力や開いている画面を閉じてから、地図の右下の「未来の道筋」で開けます", { ms: 6000 });
    };
    setTimeout(retry, 400);
  }

  /**
   * 利用者が何かの途中か（確認・メニュー・操作ガイドが開いている・文字を入れている・その場で書き換えている）。
   * opening: 未来の道筋を開いている途中も数える（開いている途中の確かめ直しでは数えない）
   */
  private futureBusy(opening = true): boolean {
    return modalOpen() || menuOpen() || !!document.querySelector(".tour") || isTypingTarget(document.activeElement) || this.editor.active || (opening && this.openingFuture);
  }

  /**
   * 未来の道筋が、何もしていないデモ・空の地図に入ってくるときの、入れ替える（足す）前の地図に付ける印。
   * 元に戻した・バックアップから戻した地図を、この端末でも別の端末でも、もう自動では入れ替えない（どの道から来ても）
   */
  private futureMarkFor(next: DocData): Record<string, unknown> | undefined {
    const cur = this.store.doc;
    return hasFutureRoot(next) && !hasFutureRoot(cur) && isDisposableDoc(cur) ? { [NO_AUTO_FUTURE]: true } : undefined;
  }

  /**
   * 未来の道筋に入れ替えて、今日（入口）から見せる（何もしていないデモ・空の地図のとき。直前の地図はバックアップに残り、元に戻せる）。
   * 全体（横 8 万）はいちばん引いても画面に収まらないので、読める大きさの入口から右へたどってもらう（10 年後の行き先は右の概要に並ぶ）。
   * 入れ替える前の地図には印を付ける（元に戻した・バックアップから戻した地図は、この端末でも別の端末でも、もう自動では入れ替えない）。
   * 入れ替えた地図には開いたばかりの印を付ける（手を付けるまでの間にアカウントで重なったら、別の端末の内容に譲る）。
   * opened: 入れ替えた。skipped: 開いている途中だった・待つ間に変わったので入れ替えなかった。failed: 組み立てられなかった
   */
  private async openFutureNow(how: "auto" | "button"): Promise<"opened" | "skipped" | "failed"> {
    if (this.openingFuture) return "skipped";
    this.openingFuture = true;
    try {
      let built: ReturnType<typeof buildFuture>;
      try {
        built = buildFuture();
      } catch {
        toast("未来の道筋を組み立てられませんでした。ページを開き直してから、もう一度試してください", { tone: "warn" });
        return "failed";
      }
      const { pv, stats } = built;
      const n = (v: number) => v.toLocaleString("ja-JP");
      const at = this.store.doc;
      // 押したボタン・お知らせの指す地図が見えるように（リストのままでは見えない）
      if (this.ui.prefs.view !== "map") this.ui.setPrefs({ view: "map" });
      const done = await this.replaceDocSafely(pv.doc, FUTURE_OPEN_LABEL, {
        done: `未来の道筋（仕事・3 年の分かれ道）を開きました: 判断 ${n(stats.decisions)}・選択肢 ${n(stats.options)}・3 年後の行き先 ${n(stats.ends)}。カードの色付きの数が、その手の 3 年の影響です（前の地図はバックアップに残ります）`,
        fitTo: (d, ids) => nearFutureRoot(d, ids),
        fitMinZoom: FUTURE_MIN_ZOOM,
        // 待っている間に中身が変わった（同期で別の端末の内容を読み込んだ・書き始めた・ほかで開いた）なら入れ替えない。
        // 自動で開くときは、その間に何かを始めた（メニュー・ガイド・入力）ときも
        still: () => this.store.doc === at && isDisposableDoc(at) && !hasFutureRoot(at) && !this.editor.active && (how === "button" || !this.futureBusy(false)),
        markBefore: { [NO_AUTO_FUTURE]: true },
        fresh: true,
      });
      if (done) this.ui.setPrefs({ futureAutoOpened: true, futureOffered: true, futureNotified: futureVersion() });
      // 押したのに入れ替えなかった（待つ間に地図が変わった・書き始めた・閲覧のみになった）: 黙らない
      else if (how === "button") toast("開いている間に地図が変わったため、入れ替えませんでした。もう一度「未来の道筋」を押してください", { tone: "warn", ms: 6000 });
      return done ? "opened" : "skipped";
    } finally {
      this.openingFuture = false;
    }
  }

  /**
   * 開いた地図が何もしていないデモか空で、未来の道筋がまだ無ければ、未来の道筋を開く（このブラウザで 1 回。元に戻せる）。
   * 操作ガイドを済ませてから開いたときだけ（初めての人には、ようこそ画面とガイドを先に見せる）。
   * 入れ替えない印のある地図（一度開いて元に戻した・デモを読み込む・空にするで作った。別の端末から同期で受け取った物も）は開かない。
   * アカウントとの最初の突き合わせは 10 秒まで待つ（別の端末の内容を先に取り込み、取り込んで中身ができたら開かない）。
   * それより遅い・つながらないときは開く（開いたばかりで手を付けていない間は、後で重なったら別の端末の内容に譲る）。
   * 確認・メニュー・操作ガイド・入力の途中、閲覧のみのタブでは、終わる・編集できるようになるまで待つ（閲覧のみは訳を知らせる）
   */
  private autoOpenFuture(): void {
    if (this.ephemeral || !this.ui.prefs.onboardingDone) return;
    const started = Date.now();
    let toldReadOnly = false;
    const tick = (): void => {
      // 新しい版のデータで止めた・アカウントに新しい版の内容があって編集を止めた: 閲覧のみの訳などを知らせ続けない
      // （止める画面・帯と食い違う。開き直すまで編集できないので、待ち続けもしない）
      if (this.newerShown || this.heldByAccount) return;
      if (this.futureAutoDeclined || this.ui.prefs.futureAutoOpened || this.ui.storedPrefs().futureAutoOpened === true) return;
      if (this.store.doc.meta?.[NO_AUTO_FUTURE] === true) return;
      if (hasFutureRoot(this.store.doc)) return;
      if (!isDisposableDoc(this.store.doc)) return;
      const waited = Date.now() - started;
      // 長く開けないまま（閲覧のみ・何かの途中のまま）: やめる（地図の右下の「未来の道筋」からいつでも開ける）
      if (waited > 10 * 60_000) return;
      // 閲覧のみ（別のタブ・ウィンドウで開いている）: 一度だけ訳を知らせ、このタブで編集できるようになるのを待つ
      if (this.store.readOnly) {
        if (!toldReadOnly && waited > 3000) {
          toldReadOnly = true;
          toast(READ_ONLY_AUTO_FUTURE, { tone: "warn", ms: 9000 });
        }
        setTimeout(tick, 500);
        return;
      }
      // 確認・メニュー・操作ガイドの途中（お知らせの「元に戻す」がガイドの下で押せない）・文字を入れている（検索欄など）間は待つ
      if (this.futureBusy()) {
        setTimeout(tick, 500);
        return;
      }
      // アカウントとの最初の突き合わせ（10 秒まで）: 済むのを待つ。遅い・つながらないときは開く
      const st = this.cloudInfo?.state;
      const settled = st === undefined || st === "synced" || this.syncQuiet();
      if (!settled && waited < SYNC_WAIT_MS) {
        setTimeout(tick, 500);
        return;
      }
      // 開く途中で何かが始まって入れ替えなかった: 落ち着くのを待って、もう一度確かめる（地図が変わっていれば、そこで止まる）
      void this.openFutureNow("auto").then((r) => {
        if (r === "skipped") setTimeout(tick, 500);
      });
    };
    setTimeout(tick, 800);
  }

  /**
   * 文書に入っている未来の道筋を、同梱の新しい版にする（確かめてから。元に戻せる）。3 年の分かれ道は同じ地図の文章と数字だけを新しくし
   * （足したカード・選んだ手・書き換えた所は残る）、それより前の地図（10 年の道筋など）は入れ替える。ほかのノードはそのまま。
   * how: 頼まれた所（menu: メニュー・button: 「未来の道筋」・notice: 新しい版のお知らせ）。
   * 確認を出す前と閉じた後に、今の地図で確かめ直す（お知らせ・確認を出している間に、同期で地図が新しい版になった・無くなった・
   * このページより新しい版になった なら、差し替えずに知らせる）。「未来の道筋」から聞いて断ったら、この版ではもう聞かない
   */
  async swapFuture(how: "menu" | "button" | "notice" = "menu"): Promise<void> {
    if (this.store.readOnly) return;
    const pre = this.futureState();
    if (!pre.maps.length) {
      if (how === "menu") return this.loadFuture();
      toast(FUTURE_GONE, { ms: 6000 });
      return;
    }
    if (!this.futureSwapNeeded(pre)) return;
    let built: ReturnType<typeof buildFuture>;
    try {
      built = buildFuture();
    } catch {
      toast("未来の道筋を組み立てられませんでした。ページを開き直してから、もう一度試してください", { tone: "warn" });
      return;
    }
    const n = (v: number) => v.toLocaleString("ja-JP");
    // 3 年の分かれ道どうし: 同じ地図を新しい版にする（鍵で合わせる）。それより前の地図: 入れ替える
    const upRoot = inPlaceRoot(this.store.doc, built.pv.doc);
    const inPlace = upRoot !== null;
    // 前の版のアプリで読み込んだ地図（書き換えを見分ける指紋が無い）は、書き換えた見込み・文章・やることも新しい版の物になる: 確認とお知らせでそう言う
    const printed = upRoot !== null && hasEditPrints(this.store.doc, upRoot);
    const old = pre.maps.reduce((k, m) => k + m.nodes.size, 0);
    // 同じ地図を新しくするときも、ほかの未来の道筋（10 年の道筋・2 つ目の今日）は今までどおり消える: その数を確認に出す
    const mine = pre.maps.find((m) => m.root === upRoot)?.nodes;
    const others = new Set<ID>();
    for (const m of pre.maps) if (m.root !== upRoot) for (const id of m.nodes) if (!mine?.has(id)) others.add(id);
    const { stats } = built;
    const kept = printed
      ? "あなたが足したカード・選んだ手・見送った手・やることのチェック・年収・自分で書き換えた見込み（%）や文章はそのまま残ります。"
      : "あなたが足したカード・選んだ手・見送った手・やることのチェック・年収はそのまま残ります。この地図は前の版のアプリで開いたため、自分で書き換えた見込み（%）・文章・やることは見分けられず、新しい版の物になります。";
    const ok = await confirmDialog(
      inPlace
        ? {
            title: "未来の道筋を新しい版にしますか？",
            body: `3 年の分かれ道の文章と数字を新しい版にします。${kept}${others.size ? `ほかの古い未来の道筋（ノード ${n(others.size)} 件）は消えます。` : ""}直前の状態は安全用バックアップに残り、「元に戻す」でも戻せます。`,
            ok: "新しい版にする",
          }
        : {
            title: "未来の道筋を新しい版に差し替えますか？",
            body: `今の地図にある未来の道筋（ノード ${n(old)} 件）を、新しい版「3 年の分かれ道」（判断 ${n(stats.decisions)}・選択肢 ${n(stats.options)}・3 年後の行き先 ${n(stats.ends)}。選択肢ごとに 3 年の稼ぎへの影響が見えます）に入れ替えます。ほかのノードはそのままです。直前の状態は安全用バックアップに残り、「元に戻す」でも戻せます。`,
            ok: "差し替える",
          },
    );
    if (!ok) {
      // 「未来の道筋」から聞いて断った: この版ではもう聞かない（お知らせ・メニューからは新しい版にできる。ボタンの「新」の印は残る）
      if (how === "button") this.ui.declineFuture(futureVersion());
      return;
    }
    if (this.store.readOnly) return;
    // 確認を出している間に、同期で地図が変わったかもしれない: 今の地図で確かめ直す
    const now = this.futureState();
    if (!now.maps.length) {
      toast(FUTURE_GONE, { tone: "warn", ms: 6000 });
      return;
    }
    if (!this.futureSwapNeeded(now)) return;
    const upNow = inPlaceRoot(this.store.doc, built.pv.doc);
    if ((upNow !== null) !== inPlace || (upNow !== null && hasEditPrints(this.store.doc, upNow) !== printed)) {
      // 確かめた物と違うやり方になる（同じ地図を新しくすると聞いたのに入れ替える・書き換えが残ると言ったのに残せない など）: しない
      toast("確かめている間に地図が変わったため、新しい版にしませんでした。もう一度試してください", { tone: "warn", ms: 6000 });
      return;
    }
    const label = inPlace ? "未来の道筋を新しい版にする" : "未来の道筋を新しい版に差し替える";
    void this.persistence.createBackup("safety", `「${label}」の前`, this.store.doc).catch(() => undefined);
    const res = swapFutureDoc(this.store.doc, built.pv.doc);
    this.store.replaceDoc(res.doc, label);
    this.ui.setPrefs({ futureNotified: futureVersion(), futureOffered: true });
    this.ui.clearSelection();
    if (res.root && this.store.doc.nodes[res.root]) this.view.fit(nearFutureRoot(this.store.doc), { minZoom: FUTURE_MIN_ZOOM });
    if (inPlace) {
      const changes = [res.updated ? `カードの更新 ${n(res.updated)}` : "", res.added ? `追加 ${n(res.added)}` : "", res.removed ? `削除 ${n(res.removed)}` : ""].filter(Boolean).join("・");
      const mine = res.userKept ? `あなたが足したカード ${n(res.userKept)} 件と、` : "";
      toast(`未来の道筋を新しい版にしました（${changes || "変わったカードはありません"}）。${mine}選んだ手・チェック・年収${printed ? "・書き換えた文章や見込み" : ""}はそのままです`, { tone: "ok", action: this.cmd.undoAction(), ms: 9000 });
    } else {
      toast(`未来の道筋を新しい版に差し替えました（ノード ${n(res.removed)} 件 → ${n(res.added)} 件${res.kept ? `・選んだ手や年収など ${n(res.kept)} 件を引き継ぎ` : ""}）`, { tone: "ok", action: this.cmd.undoAction() });
    }
    void this.refreshLastBackup();
  }

  /**
   * 新しい版にすることがあるか（無ければ訳を知らせて false）。このページより新しい版で作った地図は古い版に戻さない。
   * もう新しい版なら何もしない
   */
  private futureSwapNeeded(st: { stale: FutureMap[]; newer: FutureMap[] }): boolean {
    if (st.newer.length) {
      this.tellNewerFuture(true);
      return false;
    }
    if (!st.stale.length) {
      toast(FUTURE_UP_TO_DATE, { ms: 5000 });
      return false;
    }
    return true;
  }

  /**
   * 文書に入っている未来の道筋が同梱の版より古ければ、一度だけ知らせて新しい版にするのを勧める（版ごとに 1 回）。
   * このページより新しい版で作った地図なら、勧めずに訳を知らせる。閲覧のみのタブでは、編集できるようになってから
   */
  private offerFutureUpdate(): void {
    if (this.ephemeral) return;
    const show = (): void => {
      if (this.store.readOnly) return;
      if (!this.vm.index.forecastRoots.size) return;
      const st = this.futureState();
      if (st.newer.length) return this.tellNewerFuture();
      const v = futureVersion();
      if (this.ui.prefs.futureNotified === v || this.ui.storedPrefs().futureNotified === v) return;
      if (!st.stale.length) return;
      this.ui.setPrefs({ futureNotified: v });
      // 押したときに、今の地図で確かめ直す（20 秒の間に同期で新しい版になった・無くなった なら差し替えない）
      let off = (): void => undefined;
      const opts = { ms: 20000, onClose: () => off() };
      const close =
        inPlaceRoot(this.store.doc) !== null
          ? toast("未来の道筋の新しい版があります（3 年の分かれ道の文章と数字）。あなたが足したカードや選んだ手はそのまま残ります", { ...opts, action: { label: "新しい版にする", run: () => void this.swapFuture("notice") } })
          : toast("未来の道筋が新しくなりました（選択肢ごとに 3 年の影響が見えます）。今の地図の未来の道筋だけを入れ替えます（ほかのノードはそのまま）", { ...opts, action: { label: "差し替える", run: () => void this.swapFuture("notice") } });
      // 出している間に地図が入れ替わり（アカウントの内容を読み込んだ・別のタブの変更・元に戻した など）、古い版の地図が無くなったら
      // （新しい版になった・地図が無くなった・このページより新しい版になった）、もう当たらないお知らせなので下げる
      off = this.store.on("change", (info) => {
        if (!info.full) return;
        const now = this.futureState();
        if (now.stale.length && !now.newer.length) return;
        close();
      });
    };
    setTimeout(() => {
      if (!this.store.readOnly) return show();
      const off = this.persistence.on("writer", (w) => {
        if (!w) return;
        off();
        setTimeout(show, 1200);
      });
    }, 2600);
  }

  /**
   * 前から使っている人に、一度だけ新しい同梱データを知らせる（初めての人には、ようこそ画面で伝える）。
   * やりたいことリストをまだ知らせていなければそれを、知らせていれば未来の道筋を（1 回の起動で 1 つだけ）。
   * 印は実際に出すときに立てる（出す前に閉じた・閲覧のみのタブで使い切らない）。閲覧のみのタブは編集できるようになってから出し、
   * 別のタブがもう出していれば（保存された印を読み直して）出さない
   */
  private offerOnce(): void {
    if (this.ephemeral || !this.ui.prefs.onboardingDone || (this.ui.prefs.wishlistOffered && this.ui.prefs.futureOffered)) return;
    const show = (): void => {
      if (this.store.readOnly) return;
      const stored = this.ui.storedPrefs();
      if (!this.ui.prefs.wishlistOffered && !stored.wishlistOffered) {
        this.ui.setPrefs({ wishlistOffered: true });
        toast(`やりたいことリスト（${WISHLIST_SIZE_LABEL} 件）を用意しました。メニューからいつでも読み込めます`, { action: { label: "見る", run: () => this.loadWishlist() }, ms: 15000 });
        return;
      }
      if (this.ui.prefs.futureOffered || stored.futureOffered) return;
      this.ui.setPrefs({ futureOffered: true });
      toast(`未来の道筋（仕事・3 年の分かれ道）を用意しました。選択肢ごとに 3 年の稼ぎへの影響が見られます（やりたいことリストも ${WISHLIST_SIZE_LABEL} 件になりました）`, { action: { label: "見る", run: () => void this.showFuture() }, ms: 15000 });
    };
    setTimeout(() => {
      if (!this.store.readOnly) return show();
      const off = this.persistence.on("writer", (w) => {
        if (!w) return;
        off();
        setTimeout(show, 1200);
      });
    }, 1200);
  }

  async loadDemo(): Promise<void> {
    const ok = await confirmDialog({ title: "デモを読み込みますか？", body: "今のデータをデモ（3 つのプロジェクト）に入れ替えます。今の内容は安全用バックアップに残り、「元に戻す」でも戻せます。", ok: "読み込む" });
    // 選んで作った地図は、開き直したときに未来の道筋へ入れ替えない（どの端末でも）
    if (ok) await this.replaceDocSafely(withNoAutoFuture(buildDemoDoc()), "デモを読み込む", { done: "デモを読み込みました" });
  }

  async newEmptyDoc(): Promise<void> {
    const ok = await confirmDialog({ title: "空のドキュメントにしますか？", body: "すべてのノード・プロジェクト・シナリオを片付けて、白紙から始めます。今の内容は安全用バックアップに残り、「元に戻す」でも戻せます。", ok: "空にする", danger: true });
    if (ok) await this.replaceDocSafely(withNoAutoFuture(createEmptyDoc()), "空のドキュメントにする", { done: "空のドキュメントにしました" });
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

  /** 「同期をやり直す」（利用者が押した） */
  resyncCloud(): void {
    this.cloud?.resync({ userAsked: true });
  }

  private setCloudInfo(state: CloudState | "unavailable", message = ""): void {
    this.cloudInfo = { state, message, lastSyncedAt: this.cloud?.lastSyncedAt ?? null };
    this.onCloudChanged();
  }

  /** claude.ai の Artifact の中で、サインインしていて自分の場所に書けるなら、アカウントにも写しを置く */
  async startCloud(late?: { db: DbApi; user: UserApi }): Promise<void> {
    if (this.ephemeral || !inArtifactHost() || this.cloud || this.cloudStarting || this.persistence.blocked) return;
    this.cloudStarting = true;
    try {
      await this.startCloudInner(late);
    } finally {
      this.cloudStarting = false;
    }
  }

  /** late: 時間切れの後に返ってきた機能（もう一度待たずにそれを使う） */
  private async startCloudInner(late?: { db: DbApi; user: UserApi }): Promise<void> {
    this.setCloudInfo("connecting");
    const [db, user] = late ? [late.db, late.user] : await Promise.all([useCapability<DbApi>("db"), useCapability<UserApi>("user")]);
    let uid: string | null = null;
    try {
      uid = user ? await user.id() : null;
    } catch {
      uid = null;
    }
    if (!db || !uid) {
      if (user && !uid) {
        this.setCloudInfo("unavailable", "サインインしていないため、このブラウザだけに保存します");
        return;
      }
      // 機能の返事が遅い・読み込めなかった: サインインしていないとは限らない。返事が来たら、そのときに始める
      this.setCloudInfo("unavailable", "アカウントに接続できないため、このブラウザだけに保存しています（つながりしだい同期します）");
      if (!this.cloudLateArmed) {
        this.cloudLateArmed = true;
        void Promise.all([capabilityWhenReady<DbApi>("db"), capabilityWhenReady<UserApi>("user")]).then(async ([d, u]) => {
          // 返事が来た: もう返事待ちではない（始めるなら、始める時点で「接続中」になる。始められなければ、この起動では同期しない）
          this.cloudLateArmed = false;
          if (this.cloud) return;
          if (d && u) return void this.startCloud({ db: d, user: u });
          let signedOut = false;
          try {
            signedOut = !!u && !(await u.id());
          } catch {
            signedOut = false;
          }
          if (!this.cloud) this.setCloudInfo("unavailable", signedOut ? "サインインしていないため、このブラウザだけに保存します" : "アカウントに接続できないため、このブラウザだけに保存します");
        });
      }
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
    // 起動したときの手元の記録を書き終えてから始める（記録より先に読まない）
    await this.bootRecorded;
    // 待つ間に、このページより新しい版のデータに気づいて止めた: 同期も始めない（アカウントへも書かない）
    if (this.persistence.blocked) return;
    /** 手元にまだ保存できていない間の基準（保存できたら書く。基準が手元より先に残らないように） */
    let pendingBase: SyncBase | null = null;
    const writeBaseNow = async (b: SyncBase) => {
      await this.persistence.writeKv(baseKey, b);
      // このブラウザの内容は、このアカウントのもの
      await this.persistence.writeKv("cloud:owner", uid);
      foreign = false;
      // 基準が決まった: 起動したときの手元の記録は済んだ（次に起動したときに、その手元で記録し直す）
      await this.persistence.writeKv(BOOT_DOC_KEY, null).catch(() => undefined);
    };
    // 保存の状態が変わるたびに、保存できた内容が基準に追いついたかを見る（「保存中」ではなく、保存し終えた内容で）
    this.persistence.on("status", () => {
      if (!pendingBase || !baseCovered(this.persistence.lastStored, pendingBase)) return;
      const b = pendingBase;
      pendingBase = null;
      void writeBaseNow(b).catch(() => undefined);
    });
    // 書き手でなくなった: 書けずにいた基準は、引き継いだタブの物ではない（後から古い基準を書かない）
    this.persistence.on("writer", (w) => {
      if (!w) pendingBase = null;
    });
    const sync = new CloudSync(repo, {
      getDoc: () => this.store.doc,
      // 起動したときの手元の記録（このタブ・前に開いたとき・別のタブのどれの物でも。読めなければ記録なし）。
      // 書けずにいる新しい基準があるなら、記録はもう済んだ物として扱う
      bootDoc: async () => (pendingBase ? null : asBootDoc(await this.persistence.readKv(BOOT_DOC_KEY))),
      isWriter: () => this.persistence.writer && !this.store.readOnly,
      isDisposable: (doc) => isDisposableDoc(doc),
      isEditing: () => this.editingNow(),
      // 開いてから手を付けていない未来の道筋（とそれを元に戻しただけの地図）は、重なったら別の端末の内容に譲る
      // （押せばまた開ける。書いた内容を押し流さない。戻した地図は、別の端末が開いたばかりの地図には譲らない）
      yieldsOnConflict: (local, remote) => yieldsToRemote(local, remote),
      isForeign: () => foreign,
      adopt: async (doc, how, stillOk) => {
        const canWrite = () => this.persistence.writer && !this.store.readOnly;
        if (!canWrite() || !stillOk()) return null;
        // 入れ替える前の手元を残す: 別の端末の変更ならふだんの「同期」の枠に、利用者が選んだ切り替えなら押し出されない枠に。
        // 捨ててよい手元（何もしていないデモ・空）は残さない
        // 未来の道筋が、何もしていないデモ・空に入ってくる: 入れ替える前の地図に印（「元に戻す」・バックアップで戻しても、どの端末でも自動では入れ替えない）
        const mark0 = how === "remote" ? this.futureMarkFor(doc) : undefined;
        if (how === "remote") await this.persistence.createBackup("sync", "別の端末の内容を読み込む前", mark0 ? { ...this.store.doc, meta: { ...this.store.doc.meta, ...mark0 } } : this.store.doc).catch(() => undefined);
        if (how === "choice") {
          let kept = false;
          // 残している間に書き足されたら、書き足した後の内容で残し直す
          for (let i = 0; i < 3 && !kept; i++) {
            const at = this.store.doc.updatedAt;
            const saved = await this.persistence.createBackup("kept", "アカウントの内容に切り替える前のこのブラウザの内容", this.store.doc).catch(() => null);
            if (!saved) break;
            kept = this.store.doc.updatedAt === at;
          }
          if (!kept) {
            // 残せない: 書き出してもらう（保存を断られた・書き出している間に書き足された なら、切り替えない）
            const at = this.store.doc.updatedAt;
            if (!(await this.confirmWithoutBackup(this.store.doc, "browser")) || this.store.doc.updatedAt !== at) return null;
          }
        }
        // 読んでいる間・残している間に手元が変わった（入力が始まった）・書き手でなくなった: 入れ替えない
        if (!canWrite() || !stillOk()) return null;
        this.editor.cancel();
        // 手を付けていない中身（一度に開いた未来の道筋・それを元に戻した地図）からの読み込み（重なって譲った・送った後に別の端末が書いた）は、
        // 「元に戻す」の対象にしない（戻すと、押せばまた開ける中身で、別の端末で書いた内容をアカウントから押し流す。中身はバックアップに残る）
        const yielding = how === "remote" && isFreshFuture(this.store.doc);
        // 入れ替える前に見ていた未来の道筋の今日の位置（同じ所にまだあるなら、見ている場所はそのままにする）
        const rootAt = (d: DocData) => {
          // 全体を見てよい: 届いた文書（ストアの文書ではない）の入口を、取り込むときに 1 回探す
          const r = Object.values(d.nodes).find((n) => n.meta?.forecastRoot === true);
          return r ? { x: r.x, y: r.y, v: r.meta?.futureVersion } : null;
        };
        const hadRoot = rootAt(this.store.doc);
        const idBefore = this.store.doc.id;
        // 何もしていないデモ・空のまま読み込む（ほかの端末で開いた未来の道筋が届く など）: 届いた地図の今日に寄る
        const wasDisposable = isDisposableDoc(this.store.doc);
        if (how === "remote" && !yielding) {
          this.adopting = true;
          try {
            const mark = this.futureMarkFor(doc);
            if (mark) this.store.doc.meta = { ...this.store.doc.meta, ...mark };
            if (!this.store.replaceDoc(doc, "別の端末の内容を読み込む")) return null;
          } finally {
            this.adopting = false;
          }
        } else {
          // 初めての同期・利用者の選択・手を付けていない中身からの読み込みは「元に戻す」の対象にしない
          // （戻すと、捨てたデモや選ばなかった内容・押せばまた開ける中身がアカウントへ送られる）
          this.store.load(doc, "load");
          this.persistence.markDirty();
        }
        // 入れ替えた瞬間の手元（この後の編集は、次の送信に回す）
        const ident = { id: this.store.doc.id, updatedAt: this.store.doc.updatedAt };
        // 手元への保存を先に済ませる（同期の基準だけが先に残り、閉じたあとで古い手元を送ってしまうのを防ぐ）
        await this.persistence.flush().catch(() => undefined);
        this.ui.pruneSelection((kind, id) => (kind === "node" ? !!this.store.doc.nodes[id] : !!this.store.doc.edges[id]));
        // 入れ替えた中身に寄る（ふつうの読み込みは見ている場所のまま）。未来の道筋は全体を収めると 4% で読めないので今日から。
        // 見ていた未来の道筋がまだある（同じ文書に別の端末の書き足し・動かしが届いた、または同じ所に今日がある地図を開いた端末に譲った）なら、
        // 見ている場所はそのまま。別の文書で今日の位置も違う（別の内容の横に足された地図など）なら今日に寄る
        const nowRoot = rootAt(this.store.doc);
        const nowMap = !!nowRoot;
        const sameMap = !!nowRoot && !!hadRoot && (this.store.doc.id === idBefore || (nowRoot.x === hadRoot.x && nowRoot.y === hadRoot.y));
        // 別の端末で未来の道筋が新しい版に差し替わった（版の印が変わった）なら、新しい地図として今日から見せる
        const newVersion = !!nowRoot && !!hadRoot && nowRoot.v !== hadRoot.v;
        if (how !== "remote" || (yielding && !sameMap) || (wasDisposable && !hadRoot && nowMap) || newVersion) {
          this.view.fit(nowMap ? nearFutureRoot(this.store.doc) : undefined, { animate: false, minZoom: nowMap ? FUTURE_MIN_ZOOM : undefined });
        }
        void this.refreshLastBackup();
        return ident;
      },
      backup: async (doc, label, kind) => {
        const saved = await this.persistence.createBackup(kind, label, doc).catch(() => null);
        void this.refreshLastBackup();
        return !!saved;
      },
      confirmWithoutBackup: (doc, what) => this.confirmWithoutBackup(doc, what),
      chooseFirst: (remote) => chooseSyncSource({ local: this.store.doc, remote: remote?.manifest ?? null, foreign }),
      // 書けずにいる基準があれば、それが今の基準（保存してある古い基準で、自分が送った内容を重なりと取り違えない）
      readBase: async () => pendingBase ?? (await this.persistence.readKv<SyncBase>(baseKey)),
      writeBase: async (b) => {
        // 基準は、手元にその内容が保存できてから書く（保存に失敗していれば、保存できたときに書く）
        await this.persistence.flush().catch(() => undefined);
        if (!baseCovered(this.persistence.lastStored, b)) {
          pendingBase = this.persistence.writer ? b : null;
          return;
        }
        pendingBase = null;
        await writeBaseNow(b);
      },
      // 突き合わせをやり直す前に、このブラウザの内容がどのアカウントの物かを読み直す（別のタブが同期していたかもしれない）
      refresh: async () => {
        try {
          const owner = await this.persistence.readKv<string>("cloud:owner");
          foreign = !!owner && owner !== uid;
        } catch {
          /* 読めなければ前のまま */
        }
      },
      notice: (text, tone) => toast(text, { tone, ms: 8000 }),
    });
    this.cloud = sync;
    sync.on((st) => this.setCloudInfo(st, sync.message));
    // アカウントの写しがこのページより新しい版: 開き直すまで新しい編集を受けない（形が違う・壊れた写しでは来ない）
    sync.onNewer(() => this.holdForAccountNewer());
    await sync.start();
  }

  /**
   * 起動したときの手元を記録する（基準を書くまで残す）。前の記録が残っていればそれを残す（最後に基準を書いてから
   * 最初の起動の物）。代わりの内容で始めたときは、この起動の物にする。編集できるタブだけが書く
   */
  private async recordBootDoc(): Promise<void> {
    if (this.ephemeral || !this.persistence.writer) return;
    try {
      // 今の基準（このブラウザの内容を最後に同期したアカウントの物）。記録はこの基準に結び付ける
      const owner = await this.persistence.readKv<string>("cloud:owner");
      const base = owner ? await this.persistence.readKv<SyncBase>(`cloud:${owner}`) : null;
      const on: BootDoc["on"] = owner ? (base ? { gen: base.gen, docId: base.docId, docUpdatedAt: base.docUpdatedAt } : null) : undefined;
      const cur = asBootDoc(await this.persistence.readKv(BOOT_DOC_KEY));
      // 前の記録は、同じ基準のままなら残す。基準が書き換わっていた（前の版のタブが書いた など）・代わりの内容で始めたなら、この起動で記録し直す
      if (!cur || this.bootDoc.fallback || !sameOn(cur.on, on)) await this.persistence.writeKv(BOOT_DOC_KEY, { ...this.bootDoc, on });
    } catch {
      /* 記録できなくても続ける（その場合は、今の手元だけで古いかを見る） */
    }
  }

  /**
   * バックアップを作れないブラウザで、置き換えられる内容を書き出してから続けるか聞く。
   * 書き出しが済んだ（保存を受けてもらえた・コピーの画面で「保存しました」）ときだけ続ける。やめた・断られたら false
   */
  private async confirmWithoutBackup(doc: DocData, what: "account" | "browser"): Promise<boolean> {
    const ok = await confirmDialog({
      title: "このブラウザではバックアップを作れません",
      body: `置き換えられる${what === "account" ? "アカウントの内容" : "このブラウザの内容"}は、どこにも残りません。JSON で書き出してから続けますか？（保存できなかったときは、置き換えずに止めます）`,
      ok: "書き出して続ける",
      danger: true,
    });
    if (!ok) return false;
    return this.exportJsonAsync(doc, exportFileName().replace(/\.json$/, what === "account" ? "_account.json" : "_browser.json"), true);
  }

  /** 初めてガイドを終えたときに一度だけ、ブラウザに自動削除からの保護を頼む */
  private async askPersistOnce(): Promise<void> {
    if (this.ephemeral || this.ui.prefs.persistAsked) return;
    this.ui.setPrefs({ persistAsked: true });
    await this.persistence.requestPersist();
  }
}
