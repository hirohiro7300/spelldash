// 見え方の状態（選択・絞り込み・時点・表示切替）。ドキュメントにも履歴にも入れない。
// 表示の設定は localStorage に、カメラの位置はドキュメントごとに覚える

import type { ID } from "../model/types";
import { isDateStr } from "../model/dates";
import { Emitter } from "../store/emitter";

export type ViewMode = "map" | "list";
export type EdgeMode = "all" | "selection" | "cross";
export type ListSortKey = "due" | "title" | "type" | "status" | "updated";

export interface Prefs {
  view: ViewMode;
  /** 選んでいるプロジェクト（空 = すべて） */
  projectFilter: ID[];
  /** dim: ほかを薄く / focus: そのプロジェクトと隣だけ表示 */
  projectMode: "dim" | "focus";
  scenarioId: ID | null;
  /** dim: シナリオ外を薄く / hide: 隠す */
  scenarioMode: "dim" | "hide";
  /** この日までを表示（後の期限は薄く）。null = すべて */
  timeCursor: string | null;
  showLabels: boolean;
  showMinimap: boolean;
  showGrid: boolean;
  edgeMode: EdgeMode;
  /** 選んだノードの上流・下流を強調 */
  pathHighlight: boolean;
  /** トラックパッド向け（スクロール = 移動）か、マウス向け（ホイール = 拡大縮小）か */
  wheel: "pan" | "zoom";
  /** 経路の流れの動き */
  animate: boolean;
  leftOpen: boolean;
  rightOpen: boolean;
  sections: { projects: boolean; scenarios: boolean; tags: boolean };
  listSort: { key: ListSortKey; dir: 1 | -1 };
  onboardingDone: boolean;
  /** 「やりたいことリスト」を知らせた（ようこそ画面か、一度だけのお知らせで） */
  wishlistOffered: boolean;
  /** 「未来の道筋」を知らせた（ようこそ画面か、一度だけのお知らせで） */
  futureOffered: boolean;
  /** 「未来の道筋の新しい版があります」を知らせた版（同じ版では二度知らせない） */
  futureNotified: string;
  /** 何もしていないデモ・空の地図を、開いたときに未来の道筋へ入れ替えた（このブラウザで 1 回だけ。元に戻した人に何度も出さない） */
  futureAutoOpened: boolean;
  persistAsked: boolean;
  lastType: "goal" | "action" | "branch" | "result";
  /**
   * 3 年の分かれ道で開いているノード（入口の ID ごと）。見え方だけで、文書・履歴・同期には入れない（端末ごと）。
   * 入口が無ければ最初の形（狭い画面は今日だけ・広い画面は今日と 10 の選択肢）
   */
  impactOpen: Record<ID, ID[]>;
}

export const DEFAULT_PREFS: Prefs = {
  view: "map",
  projectFilter: [],
  projectMode: "dim",
  scenarioId: null,
  scenarioMode: "dim",
  timeCursor: null,
  showLabels: true,
  showMinimap: true,
  showGrid: true,
  edgeMode: "all",
  pathHighlight: true,
  wheel: "pan",
  animate: true,
  leftOpen: true,
  rightOpen: true,
  sections: { projects: true, scenarios: true, tags: true },
  listSort: { key: "due", dir: 1 },
  onboardingDone: false,
  wishlistOffered: false,
  futureOffered: false,
  futureNotified: "",
  futureAutoOpened: false,
  persistAsked: false,
  lastType: "action",
  impactOpen: {},
};

export interface CameraState {
  x: number;
  y: number;
  zoom: number;
}

export interface UiEvents {
  prefs: Partial<Prefs>;
  selection: void;
  hover: void;
  search: string;
  /** 見え方に関わる何か（再描画の合図） */
  visual: void;
  /** 3 年の分かれ道でノードを開いた（キャンバスが、開いた子が見える所へ寄る） */
  expand: ID[];
}

/** 時点（再生中は毎フレーム変わる）だけの変更か。パネルの作り直しはしない（押したボタンが差し替わってクリックが消えるため） */
export function onlyTimeCursor(p: Partial<Prefs>): boolean {
  const keys = Object.keys(p);
  return keys.length > 0 && keys.every((k) => k === "timeCursor");
}

/** 覚えておく入口の数（別の地図を読み込み直すたびに増え続けないように） */
const IMPACT_OPEN_ROOTS = 12;

/** 保存してあった「3 年の分かれ道で開いているノード」を確かめる（壊れた値・ID でない物は捨てる） */
export function cleanImpactOpen(v: unknown): Record<ID, ID[]> {
  const out: Record<ID, ID[]> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  // 後ろほど新しく触った入口（覚える数を超えていれば新しい物を残す）
  const entries = Object.entries(v as Record<string, unknown>).filter(([root, list]) => !!root && root.length <= 200 && Array.isArray(list));
  for (const [root, list] of entries.slice(-IMPACT_OPEN_ROOTS)) {
    out[root] = [...new Set((list as unknown[]).filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 200))];
  }
  return out;
}

const PREFS_KEY = "4d-branch:prefs";
const CAMERA_KEY = "4d-branch:camera:";
/**
 * 「未来の道筋を開いた」（futureAutoOpened）は別の場所にも書く。設定をまるごと書く別のタブ（開いたことを知らない古いタブ・
 * 前の版のタブ）に消されて、元に戻した人にもう一度開かないように。一度立てたら戻さない
 */
const FUTURE_OPENED_KEY = "4d-branch:futureAutoOpened";

function futureOpenedMark(): boolean {
  try {
    return globalThis.localStorage?.getItem(FUTURE_OPENED_KEY) === "1";
  } catch {
    return false;
  }
}

function loadPrefs(): Prefs {
  const mark = futureOpenedMark();
  try {
    const raw = globalThis.localStorage?.getItem(PREFS_KEY);
    if (!raw) return { ...structuredClone(DEFAULT_PREFS), futureAutoOpened: mark };
    const p = JSON.parse(raw) as Partial<Prefs>;
    // 壊れた時点（前の版で保存された NaN など）は外す
    if (p.timeCursor != null && !isDateStr(p.timeCursor)) p.timeCursor = null;
    const prefs: Prefs = { ...structuredClone(DEFAULT_PREFS), ...p, sections: { ...DEFAULT_PREFS.sections, ...(p.sections ?? {}) }, listSort: { ...DEFAULT_PREFS.listSort, ...(p.listSort ?? {}) } };
    prefs.impactOpen = cleanImpactOpen(p.impactOpen);
    if (mark) prefs.futureAutoOpened = true;
    return prefs;
  } catch {
    return { ...structuredClone(DEFAULT_PREFS), futureAutoOpened: mark };
  }
}

export class UiState {
  prefs: Prefs;
  readonly selection = { nodes: new Set<ID>(), edges: new Set<ID>() };
  hover: { node: ID | null; edge: ID | null } = { node: null, edge: null };
  search = "";
  /** 一時表示（?stress など）では設定を保存しない */
  persistPrefs = true;
  private readonly emitter = new Emitter<UiEvents>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(prefs?: Prefs) {
    this.prefs = prefs ?? loadPrefs();
  }

  on<K extends keyof UiEvents>(type: K, fn: (p: UiEvents[K]) => void): () => void {
    return this.emitter.on(type, fn);
  }

  setPrefs(patch: Partial<Prefs>): void {
    this.prefs = { ...this.prefs, ...patch };
    this.emitter.emit("prefs", patch);
    this.emitter.emit("visual", undefined);
    this.savePrefsSoon();
  }

  /**
   * 3 年の分かれ道で開いているノードを変える（見え方だけ。文書・履歴・保存・同期は変えない）。ids が null なら最初の形に戻す。
   * opened: 新しく開いたノード（キャンバスが、その子が見える所へ寄る）
   */
  setImpactOpen(root: ID, ids: ID[] | null, opened: ID[] = []): void {
    const next = { ...this.prefs.impactOpen };
    if (ids === null) delete next[root];
    else {
      // いちばん新しく触った入口を最後に（覚える数を超えたら古い物から捨てる）
      delete next[root];
      next[root] = ids;
      const keys = Object.keys(next);
      for (let i = 0; i < keys.length - IMPACT_OPEN_ROOTS; i++) delete next[keys[i]!];
    }
    this.prefs = { ...this.prefs, impactOpen: next };
    this.emitter.emit("visual", undefined);
    if (opened.length) this.emitter.emit("expand", opened);
    this.savePrefsSoon();
  }

  private savePrefsSoon(): void {
    if (!this.persistPrefs) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.writePrefs(), 200);
  }

  /** このブラウザに保存されている設定（別のタブが書いた物も含む。読めなければ空） */
  storedPrefs(): Partial<Prefs> {
    let p: Partial<Prefs> = {};
    try {
      p = JSON.parse(globalThis.localStorage?.getItem(PREFS_KEY) || "{}") as Partial<Prefs>;
    } catch {
      p = {};
    }
    return futureOpenedMark() ? { ...p, futureAutoOpened: true } : p;
  }

  /** まとめて書く前の表示の設定を、今すぐ書く（閉じる・隠れるとき。すぐ開き直しても設定を失わない） */
  flushPrefs(): void {
    if (!this.saveTimer) return;
    this.writePrefs();
  }

  private writePrefs(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.persistPrefs) return;
    try {
      globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify(this.prefs));
      if (this.prefs.futureAutoOpened) globalThis.localStorage?.setItem(FUTURE_OPENED_KEY, "1");
    } catch {
      /* 保存できなくても動く */
    }
  }

  // ---- 選択

  select(nodes: Iterable<ID>, edges: Iterable<ID> = []): void {
    this.selection.nodes = new Set(nodes);
    this.selection.edges = new Set(edges);
    this.emitter.emit("selection", undefined);
    this.emitter.emit("visual", undefined);
  }

  clearSelection(): void {
    if (this.selection.nodes.size === 0 && this.selection.edges.size === 0) return;
    this.select([], []);
  }

  toggleNode(id: ID): void {
    const s = new Set(this.selection.nodes);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    this.select(s, []);
  }

  /** 消えた要素を選択から外す */
  pruneSelection(exists: (kind: "node" | "edge", id: ID) => boolean): void {
    let changed = false;
    for (const id of [...this.selection.nodes]) if (!exists("node", id)) (this.selection.nodes.delete(id), (changed = true));
    for (const id of [...this.selection.edges]) if (!exists("edge", id)) (this.selection.edges.delete(id), (changed = true));
    if (this.hover.node && !exists("node", this.hover.node)) this.hover.node = null;
    if (this.hover.edge && !exists("edge", this.hover.edge)) this.hover.edge = null;
    if (changed) {
      this.emitter.emit("selection", undefined);
      this.emitter.emit("visual", undefined);
    }
  }

  get singleNode(): ID | null {
    return this.selection.nodes.size === 1 && this.selection.edges.size === 0 ? [...this.selection.nodes][0]! : null;
  }

  get singleEdge(): ID | null {
    return this.selection.edges.size === 1 && this.selection.nodes.size === 0 ? [...this.selection.edges][0]! : null;
  }

  setHover(node: ID | null, edge: ID | null): void {
    if (this.hover.node === node && this.hover.edge === edge) return;
    this.hover = { node, edge };
    this.emitter.emit("hover", undefined);
  }

  setSearch(q: string): void {
    if (this.search === q) return;
    this.search = q;
    // 先に「見え方が変わった」を知らせて当たりを計算し直させてから、検索欄（件数・候補）に知らせる。
    // 逆の順だと、検索欄が 1 つ前の言葉の当たりを出す（貼り付けると「0 件・見つかりません」になる）
    this.emitter.emit("visual", undefined);
    this.emitter.emit("search", q);
  }

  // ---- カメラ（ドキュメントごと）

  loadCamera(docId: ID): CameraState | null {
    try {
      const raw = globalThis.localStorage?.getItem(CAMERA_KEY + docId);
      if (!raw) return null;
      const c = JSON.parse(raw) as CameraState;
      return Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.zoom) && c.zoom > 0 ? c : null;
    } catch {
      return null;
    }
  }

  saveCamera(docId: ID, c: CameraState): void {
    if (!this.persistPrefs) return;
    try {
      globalThis.localStorage?.setItem(CAMERA_KEY + docId, JSON.stringify({ x: Math.round(c.x), y: Math.round(c.y), zoom: Math.round(c.zoom * 1000) / 1000 }));
    } catch {
      /* 保存できなくても動く */
    }
  }
}
