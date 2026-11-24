// 見え方の状態（選択・絞り込み・時点・表示切替）。ドキュメントにも履歴にも入れない。
// 表示の設定は localStorage に、カメラの位置はドキュメントごとに覚える

import type { ID } from "../model/types";
import { isDateStr } from "../model/dates";
import { Emitter } from "../store/emitter";

export type ViewMode = "map" | "list";
export type EdgeMode = "all" | "selection" | "cross";
export type ListSortKey = "due" | "title" | "type" | "status" | "updated";

/**
 * 3 か月ごとの地図（版 7）の、右のパネル（狭い画面では引き出し）に出す画面（作業メモ SPEC v1 §5.2〜§5.5・§5.7）。
 * move: 今日の手の詳しい画面（扇・分かれ道の帯・進め方・行き先）。f は地図の番号。
 * path: そのカードを通る道（今日から 2029 年 11 月まで 3 か月に 1 行）。node は地図の番号。open: 開いている行の鍵。
 * 見取り図そのものは、何も選んでいないときの概要の先頭（ページではない）
 */
export type DeepPage = { kind: "move"; f: number } | { kind: "path"; node: number; open?: string[]; align?: { key: string; top: number } };

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
  /**
   * 「未来の道筋」を押して聞かれた新しい版への差し替えを断った版（この端末で。同じ版ではボタンからもう聞かない）。
   * このタブで断った物。保存は設定とは別の場所（UiState.declineFuture・isFutureDeclined）。設定の中の値は前の版から移すときだけ読む
   */
  futureDeclined: string;
  /** 何もしていないデモ・空の地図を、開いたときに未来の道筋へ入れ替えた（このブラウザで 1 回だけ。元に戻した人に何度も出さない） */
  futureAutoOpened: boolean;
  persistAsked: boolean;
  lastType: "goal" | "action" | "branch" | "result";
  /**
   * 3 年の分かれ道で開いているノード（入口の ID ごと）。見え方だけで、文書・履歴・同期には入れない（端末ごと）。
   * 入口が無ければ最初の形（狭い画面は今日だけ・広い画面は今日と 10 の選択肢）
   */
  impactOpen: Record<ID, ID[]>;
  /** 新しい地図の知らせ（版 7 の 12 段・2,000 の分かれ道・差の比べ方）を見せた版（futureRelease。見せたら以後は出さない） */
  releaseSheet: number;
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
  futureDeclined: "",
  futureAutoOpened: false,
  persistAsked: false,
  lastType: "action",
  impactOpen: {},
  releaseSheet: 0,
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
  /** 右のパネルの 3 か月ごとの地図の画面（手の詳しい画面・道の画面）が変わった */
  deep: DeepPage | null;
  /** ほかのカードも選ぶ（UiState.multiPick）を入れた・やめた */
  pick: boolean;
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

/**
 * 「未来の道筋」から聞かれた新しい版を断った版（futureDeclined）も別の場所に書く。設定をまるごと書く別のタブ（断ったことを
 * 知らないタブ。カードを開く・閉じるだけでも書く）に消されて、開き直したときにまた聞かないように
 */
const FUTURE_DECLINED_KEY = "4d-branch:futureDeclined";

/** 保存してある断った版（無い・読めなければ null） */
function storedDeclined(): string | null {
  try {
    const v = globalThis.localStorage?.getItem(FUTURE_DECLINED_KEY);
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

function writeDeclined(version: string): void {
  try {
    globalThis.localStorage?.setItem(FUTURE_DECLINED_KEY, version);
  } catch {
    /* 保存できなくても動く（このタブの間は覚えている） */
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
    if (typeof prefs.releaseSheet !== "number" || !Number.isFinite(prefs.releaseSheet)) prefs.releaseSheet = 0;
    if (mark) prefs.futureAutoOpened = true;
    // 前の版が設定の中に書いた断った版は、別の場所がまだ無ければ一度だけ移す
    if (typeof p.futureDeclined === "string" && p.futureDeclined && storedDeclined() === null) writeDeclined(p.futureDeclined);
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
  /** 右のパネルに出している 3 か月ごとの地図の画面（無ければ選んだ物の詳細か概要）。前の画面の並び（戻る） */
  deepPage: DeepPage | null = null;
  private deepStack: DeepPage[] = [];
  /** この間の選択の変更では、3 か月ごとの地図の画面を閉じない（画面の中から選ぶとき） */
  private deepHold = 0;
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

  /**
   * 開いているノードを、前に持っていた形（まとめて開く前の物）にまるごと戻す（お知らせの「元に戻す」。描き直しの合図 1 回・設定の書き込み 1 回）
   */
  replaceImpactOpen(all: Record<ID, ID[]>): void {
    this.prefs = { ...this.prefs, impactOpen: all };
    this.emitter.emit("visual", undefined);
    this.savePrefsSoon();
  }

  /**
   * ほかのカードも選ぶ（タッチで ⇧ の代わり: 押すたびに選びに足す・外す）。保存しない（このタブの間だけ）
   */
  multiPick = false;

  /**
   * 次の「visual」での右のパネルの合わせ直しを、キャンバスを描いた後に回す（まとめて開くの 1 回: 2,600 枚を開いた仕事を、
   * キャンバスを描く仕事とパネルを作り直す仕事に分ける。スマホで 1 つの長い仕事にしない: 見直し speed-phone-open-one-long-task）
   */
  panelAfterPaint = false;

  setMultiPick(on: boolean): void {
    if (this.multiPick === on) return;
    this.multiPick = on;
    this.emitter.emit("pick", on);
  }

  private savePrefsSoon(): void {
    if (!this.persistPrefs) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.writePrefs(), 200);
  }

  /**
   * その版への差し替えを、「未来の道筋」から聞いて断ったか（このタブで・このブラウザのほかのタブで。
   * 前の版のタブが設定の中に書いた物も）
   */
  isFutureDeclined(version: string): boolean {
    if (!version) return false;
    return this.prefs.futureDeclined === version || storedDeclined() === version || this.storedPrefs().futureDeclined === version;
  }

  /** 断った版を覚える（設定とは別の場所にも書く。設定をまるごと書く別のタブに消されない） */
  declineFuture(version: string): void {
    this.setPrefs({ futureDeclined: version });
    if (this.persistPrefs) writeDeclined(version);
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

  // ---- 3 か月ごとの地図の画面（右のパネル・狭い画面の引き出し）

  /**
   * 画面を開く。push: 今の画面を戻る先に積む（手の詳しい画面から道へ）。そうでなければ置き換える（道の切り替え）。
   * 開いたら右のパネルも開く（狭い画面では引き出し）
   */
  openDeep(page: DeepPage, opts: { push?: boolean } = {}): void {
    if (opts.push && this.deepPage) this.deepStack.push(this.deepPage);
    if (!opts.push && !this.deepPage) this.deepStack = [];
    this.deepPage = page;
    if (!this.prefs.rightOpen) this.setPrefs({ rightOpen: true });
    this.emitter.emit("deep", page);
  }

  /** 1 つ前の画面へ（無ければ閉じて、選んだ物の詳細か概要へ） */
  backDeep(): void {
    this.deepPage = this.deepStack.pop() ?? null;
    this.emitter.emit("deep", this.deepPage);
  }

  /** 画面を閉じる（選んだ物の詳細か概要へ） */
  closeDeep(): void {
    if (!this.deepPage && !this.deepStack.length) return;
    this.deepPage = null;
    this.deepStack = [];
    this.emitter.emit("deep", null);
  }

  /** 開いている道の画面の、開いている行と位置を覚え直す（作り直したときに戻すため。知らせは出さない） */
  rememberDeep(page: DeepPage): void {
    if (this.deepPage && this.deepPage.kind === page.kind) this.deepPage = page;
  }

  /** fn の間の選択の変更では、3 か月ごとの地図の画面を閉じない */
  holdDeep<T>(fn: () => T): T {
    this.deepHold++;
    try {
      return fn();
    } finally {
      this.deepHold--;
    }
  }

  /** 選択の変更で画面を閉じてよいか（画面の中から選んだ間は閉じない） */
  get deepHeld(): boolean {
    return this.deepHold > 0;
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
