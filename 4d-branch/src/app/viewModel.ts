// 見え方の計算: プロジェクトの絞り込み・シナリオ・時点・検索・折りたたみ・経路の強調 → ノードと接続ごとの「隠す・薄さ」
// 設計: docs/DESIGN.md §3.8・§4.7、作業メモ SPEC v1 §7.1 の 5・6・9（見直し perf-3・perf-4・perf-9・gaps-8）
//
// 3 年の分かれ道（未来の道筋 v2）の範囲は、開く・閉じるを文書ではなく見え方（UiState.prefs.impactOpen・端末ごと）で持ち、
// 位置も文書の x・y ではなく、見えているノードだけを目次の形に並べ直した「重ねる位置」を使う（posOf）。
//
// 変更のたびに文書をなめない（8 万枚の地図でも、1 文字・選ぶ・開くが軽い）:
//   索引（src/model/docIndex.ts）    : 変わったノード・線だけ直す。版（形・道の線・所属・期限・入口・シナリオ・折りたたみ・中身）で読み手が比べる
//   見えるノード（速い道）           : 絞り込み（プロジェクトに絞る・シナリオで隠す）が無いとき。入口（3 年の分かれ道の入口と、
//                                      自分のノードの入口）から、止める線を通らずにたどった所だけ（O(見える物)。下の「見え方の決まり」）。
//                                      計算は見えるノードと自分のノード（3 年の分かれ道の範囲の外）だけ。隠れた地図のカードの NodeVis は作らない
//   見えるノード（絞り込みの道）     : 絞り込みがあるときは、今までどおり範囲を作って computeCollapse・computeUnreached（O(ノード)）
//   折りたたみの件数                 : 閉じたカードの先が木（どのカードも入る線が 1 本・出る線は木の線だけ）なら、先の数（形の版ごとに 1 回数える）。
//                                      そうでなければ、隠れている所だけをたどって数える
//   隠れたカードを出す・寄る         : 3 年の分かれ道のカードは、入口からの親をたどって閉じた所を開く（O(深さ)）
//   検索                             : 文字の表の索引（src/model/searchIndex.ts）。当たりは（言葉, 中身の版）で覚え、上の 50 件だけ並べる
//   見込み（未来の道筋の P_path）    : 見込みに使う物（道の線・% ・線のシナリオ・入口・種類）の版と方針で覚える（perf-2）
//   3 年の影響                       : エンジン（src/model/impactEngine.ts）。変更は印を付けるだけで、読まれたときに要る所だけやり直す
//
// 見え方の決まり（src/model/visibility.ts の computeCollapse・computeUnreached と同じ答え。tests/unit/visibleSet.test.ts が確かめる）:
//   - 別の親が見えていれば合流先は消えない（入口からたどれるため）。自分のノードから地図の深いカードへの線（相乗効果など）でも出る
//   - 3 年の分かれ道の閉じたカードが止めるのは、同じ範囲の子への道の線だけ（ほかの関係の線・範囲の外へ出る線の先は隠さない）
//   - 3 年の分かれ道のカードから「進む」「条件付き」でつないだ自分のノードは範囲に入り、閉じると一緒に隠れる
//   - 入口は、3 年の分かれ道の入口（必ず入口）と、範囲の外のノードで入る線（循環の線を除く）の無い物、入口の無い循環のかたまりの起点。
//     絞り込みが無いとき、範囲のノードは必ず入口から数える線でつながる（入口にも、入口の無い循環にもならない）ので、
//     自分のノードだけで入口を決めればよい（computeCollapse を自分のノードの部分にだけ使うのと同じ）

import { ForecastPlan, type ForecastResult, type PlanSteps } from "../model/forecast";
import { flowOuts, forkKindOf, isFlowEdge, isImpactRoot } from "../model/forks";
import { DocIndex } from "../model/docIndex";
import type { ImpactResult } from "../model/impact";
import { ImpactEngine } from "../model/impactEngine";
import { compareImpactKids, outlineLayout } from "../model/impactLayout";
import { inScenario } from "../model/graph";
import { isEmptyQuery, parseQuery } from "../model/search";
import { SearchIndex, type SearchResult } from "../model/searchIndex";
import type { DocData, GEdge, GNode, ID } from "../model/types";
import { computeCollapse, computePaths, computeUnreached, stronglyConnected, type CollapseResult } from "../model/visibility";
import type { ChangeInfo, Store } from "../store/store";
import { isNarrowScreen } from "../ui/breakpoints";
import { DeepState } from "./deepState";
import { idleSteps, whenIdle } from "./idle";
import { forgetMapDoc, mapDocOf, rememberMapDoc } from "./futureCache";
import type { UiState } from "./uiState";

/** 全部の入れ替えを変わった物だけで受けたとき、検索の索引を直す数の上限（多ければ作り直す） */
const SEARCH_PATCH_MAX = 2000;
/** 見込みが無いとき・捨てた後の答え */
const EMPTY_FORECAST: ForecastResult = { active: false, reach: new Map(), ends: [], longest: 0, order: [], impactScope: new Set() };

/** 検索の索引を空いた時間に作るときの 1 歩のノードの数 */
const SEARCH_SLICE = 2000;

/** 空いた時間に少しずつ作っている検索の索引（ids は作り始めたときの文書の順。pos まで入れた） */
interface SearchBuild {
  idx: SearchIndex;
  ids: ID[];
  pos: number;
}

export interface NodeVis {
  hidden: boolean;
  alpha: number;
  /** 検索に当たった */
  match: boolean;
  /** 選択の経路の上 */
  path: boolean;
  /** 絞り込み中の隣（ほかのプロジェクト） */
  ghost: boolean;
  /** 時点より後の期限 */
  future: boolean;
  /** 選んだシナリオに入らない（推定を含む） */
  offScenario: boolean;
  /** 折りたたみで隠れた件数（折りたたんだノードだけ） */
  collapsedCount: number;
  /** 折りたたんでいる（3 年の分かれ道は見え方で閉じていて、先があるもの。それ以外は文書の collapsed） */
  collapsed: boolean;
  inProject: boolean;
}

export interface EdgeVis {
  hidden: boolean;
  alpha: number;
  path: boolean;
  cross: boolean;
  offScenario: boolean;
}

const HIDDEN_NODE: NodeVis = { hidden: true, alpha: 0, match: false, path: false, ghost: false, future: false, offScenario: false, collapsedCount: 0, collapsed: false, inProject: false };

/** 1 段だけの比較（配列は要素ごと、オブジェクトはキーごと。それより深い物は同じ物かだけ） */
function same1(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ra = a as Record<string, unknown>;
    const rb = b as Record<string, unknown>;
    const ka = Object.keys(ra);
    return ka.length === Object.keys(rb).length && ka.every((k) => k in rb && Object.is(ra[k], rb[k]));
  }
  return false;
}

/** 見込み（computeForecast）が読むノードの所: 種類（分岐の割り方）・入口・分かれ道の種類・3 年の分かれ道の入口の印 */
function forecastNodeChanged(a: GNode | undefined, b: GNode | undefined): boolean {
  if (!a || !b) return a !== b;
  if (a.type !== b.type) return true;
  if (a.meta === b.meta) return false;
  return a.meta?.forecastRoot !== b.meta?.forecastRoot || a.meta?.fork !== b.meta?.fork || isImpactRoot(a) !== isImpactRoot(b);
}

/** 見込みが読む線の所（道の線だけ）: 両端・関係・% ・シナリオ */
function forecastEdgeChanged(a: GEdge | undefined, b: GEdge | undefined): boolean {
  if (a === b) return false;
  const fa = !!a && isFlowEdge(a);
  const fb = !!b && isFlowEdge(b);
  if (!fa && !fb) return false;
  if (!a || !b || fa !== fb) return true;
  return a.source !== b.source || a.target !== b.target || !Object.is(a.meta?.prob, b.meta?.prob) || !same1(a.scenarioIds, b.scenarioIds);
}

/**
 * 3 年の分かれ道の範囲（道の線の版ごとに作り直す）。入口（ID の順）から道の線で幅優先にたどった順に番号（pos）を振る。
 * 範囲のノード → それをたどった入口・入口から何歩目か・たどった親とその線
 */
interface ImpactScopeInfo {
  flow: number;
  /** 入口（ID の順） */
  roots: ID[];
  /** 範囲のノード → 幅優先の順の番号 */
  pos: Map<ID, number>;
  /** 番号 → ノード */
  order: ID[];
  /** 番号 → それをたどった入口（roots の添え字） */
  rootOf: Int32Array;
  /** 番号 → 入口から何歩目か（いちばん短い道） */
  depth: Int32Array;
  /** 番号 → たどった親の番号（入口は −1） */
  parent: Int32Array;
  /** 番号 → たどった親からの線（入口は ""） */
  parentEdge: ID[];
}

/** 範囲のカードの先が木かと、その大きさ（形の版ごと。閉じたカードの件数を、たどらずに出す） */
interface TreeInfo {
  key: string;
  /** 自分を含む先の数（たどった親子の木で） */
  size: Int32Array;
  /** 先が木: 止める線の先がどれも、自分がたどった子で、入る線が 1 本・出る線が木の線だけ、その先も木 */
  clean: Uint8Array;
  /** 入る線が 1 本で、出る線がどれも木の線 */
  regular: Uint8Array;
}

/** 自分のノード（3 年の分かれ道の範囲の外）の入口（形の版ごと） */
interface UserPart {
  key: string;
  /** 範囲の外のノード（文書の順） */
  users: ID[];
  /** 入る線（循環の線を除く）の無い物 */
  indeg0: ID[];
  /** 外から入る線の無い循環のかたまり（2 つ以上） */
  sccs: ID[][];
}

type Pt = { x: number; y: number };

/** 速い道の結果（絞り込みが無いとき） */
interface FastVis {
  key: string;
  opens: Set<ID>[];
  visible: Set<ID>;
  /** 折りたたみの起点（ノード ID か接続 ID）→ それで隠れた件数（見えている起点だけ） */
  counts: Map<ID, number>;
}

/** 絞り込みの道の結果（範囲を作って computeCollapse・computeUnreached） */
interface FullVis {
  key: string;
  opens: Set<ID>[];
  scope: Set<ID>;
  /** 絞り込み中の隣（ほかのプロジェクト） */
  ghost: Set<ID>;
  col: CollapseResult;
  unreached: Set<ID>;
}

/** 直前の計算の中身（隠れた理由を答える・折りたたみを開く計画に使う） */
interface LastVis {
  fast: FastVis | null;
  full: FullVis | null;
  edgeOk: (e: GEdge) => boolean;
  stops: (e: GEdge) => boolean;
  roots: ReadonlySet<ID>;
  collapsedOf: (id: ID) => boolean;
  unreached: (id: ID) => boolean;
  hideScen: boolean;
  sid: ID | null;
  focus: boolean;
  inProj: (pids: ID[]) => boolean;
}

const EMPTY_SET: ReadonlySet<ID> = new Set();

/**
 * 3 か月ごとの地図（入口に地図の年月 anchor がある）の列を月から決める（作業メモ SPEC v1 §5.6・user-3・user-15）:
 * 判断・状態・行き先は 月 / 3 × 2、手はその次の列。まとめた行き先（36 か月目）は 2029 年 11 月の列に並ぶ。
 * 月の無いカード（自分で足したカード）は深さの列。3 か月ごとの地図でなければ null（今までどおり深さの列）
 */
function quarterCol(doc: DocData, root: ID): ((id: ID, depth: number) => number) | null {
  if (typeof doc.nodes[root]?.meta?.anchor !== "string") return null;
  return (id, depth) => {
    const meta = doc.nodes[id]?.meta;
    const m = meta?.m;
    if (typeof m !== "number" || !Number.isFinite(m) || m < 0) return depth;
    return Math.round(m / 3) * 2 + (meta?.fork === "chance" ? 1 : 0);
  };
}

/** これより小さい文書は、見込みをその場で数える（大きい文書は空いた時間に: ViewModel.forecastIfReady） */
const FORECAST_SYNC_NODES = 5000;

export class ViewModel {
  /** 文書の索引（変更のたびに変わった物だけ直す。GraphIndex と同じ中身に、数・期限の幅・入口などを足した物） */
  readonly index: DocIndex;
  readonly nodes = new Map<ID, NodeVis>();
  readonly edges = new Map<ID, EdgeVis>();
  /** 描く順（隠れていないもの。文書の順で、選択中は最後＝上） */
  drawNodes: ID[] = [];
  drawEdges: ID[] = [];
  /** 折りたたんだ接続（線の付け根だけ描く） */
  stubEdges: Array<{ id: ID; count: number }> = [];
  /** 検索の上の当たり（点数の高い順に最大 50 件。全部の数は searchCount） */
  searchHits: Array<{ id: ID; score: number }> = [];
  /** 検索に当たった数（全部） */
  searchCount = 0;
  searchActive = false;
  pathActive = false;
  hiddenCount = 0;
  version = 0;
  /** 見込みに使う物（道の線・% ・線のシナリオ・入口・種類）の版。題名・状態・位置では進めない（perf-2） */
  private forecastInputs = 0;
  /** 題名の版（見込みの行き先の並びで、同じ見込みの行き先を題名の順にする所だけが読む） */
  private titleVersion = 0;
  private forecastKey = "";
  private forecastTitles = 0;
  /** 見込みを数え直した回数（3 年の影響のエンジンが、合流のある地図で見込みが変わったかを見る） */
  private forecastStamp = 0;
  private forecastCache: ForecastResult = EMPTY_FORECAST;
  /** 見込みの計画（見込みに使う物の版ごと。方針を変えたら流し直すだけ） */
  private forecastPlan: { inputs: number; doc: DocData; plan: ForecastPlan } | null = null;
  /** 3 年の影響のエンジン（文書の変更を受け、読まれたときに要る所だけやり直す） */
  readonly engine = new ImpactEngine();
  /** 3 か月ごとの地図（版 7）の見取り図・道の画面・組み立てた本文に渡す物（src/app/deepState.ts） */
  readonly deep: DeepState;
  /** 検索の索引（初めて探すときに作る。それまでは変更を受けても何もしない） */
  private search: SearchIndex | null = null;
  /** 空いた時間に少しずつ作っている検索の索引（warmSearch） */
  private searchBuild: SearchBuild | null = null;
  /** 索引が受けた最後の変更（ストアの revision。トランザクションの中の「ノードの線」を索引から答えてよいか） */
  private appliedRev: number;
  private dirtyVis = true;
  /** 位置だけが変わった（重ねる位置を入口の位置に合わせ直す） */
  private dirtyPos = false;
  /** 狭い画面か（3 年の分かれ道の最初の形を決める。確かめで差し替えられる） */
  narrow: () => boolean = isNarrowScreen;
  private scopeCache: ImpactScopeInfo | null = null;
  /** 範囲を地図の形から作るために、3 年の影響の計算を呼んでいる途中 */
  private scopeBusy = false;
  private treeCache: TreeInfo | null = null;
  private userCache: UserPart | null = null;
  private unreachCache: { key: string; reached: Set<ID> | null } | null = null;
  private hubsCache: { key: string; list: ID[] } | null = null;
  /** 入口ごとの「開いているノード」（保存してある配列か、最初の形） */
  private openCache = new Map<ID, { src: ID[] | undefined; flow: number; set: Set<ID> }>();
  /** 入口ごとに、最初の形を狭い画面の形にしたか（この表示の間は変えない。幅が変わっても開いている所を動かさない） */
  private narrowDefault = new Map<ID, boolean>();
  /** 重ねる位置（入口からの相対と、入口の位置を足した物） */
  private overlayRel = new Map<ID, { root: ID; x: number; y: number }>();
  private overlayAbs = new Map<ID, Pt>();
  /** 重ねる位置を作ったときの材料（同じなら作り直さない） */
  private overlayKey: { flow: number; topo: number; opens: Set<ID>[]; visible: ID[] } | null = null;
  private last: LastVis | null = null;
  private fastCache: FastVis | null = null;
  private fullCache: FullVis | null = null;

  constructor(
    private readonly store: Store,
    private readonly ui: UiState,
  ) {
    this.index = new DocIndex(store.doc);
    this.deep = new DeepState(this, store, ui);
    this.appliedRev = store.revision;
    // トランザクションの中の「ノードの線」（ノードの削除・つなぐときの重なりの確かめ）は、この索引に変えた線だけを足し引きして答える（perf-15）
    store.incidence = (id) => {
      if (this.appliedRev !== store.revision || this.index.source !== store.doc) return null;
      const out = this.index.out.get(id);
      const inc = this.index.inc.get(id);
      return out && inc ? out.concat(inc) : out ?? inc ?? [];
    };
    store.on("change", (info) => this.onChange(info));
    ui.on("visual", () => {
      this.dirtyVis = true;
    });
    this.useMapDoc();
  }

  /** 変更を受ける: 索引・検索・見込みの材料を、変わった物だけ直し、印を付ける（数え直しは読まれたときに。perf-4） */
  private onChange(info: ChangeInfo): void {
    const store = this.store;
    const doc = store.doc;
    if (!info.positionsOnly) this.dirtyVis = true;
    else this.dirtyPos = true;
    // 全部の入れ替え（取り込み・読み込み・入れ替えの元に戻す）で、前と同じ並びのまま直せるとき: 変わった物だけの変更として受ける
    // （索引・3 年の影響の形・見込みの組み立て・見え方の木を作り直さない。中身が同じで物だけ替わったカードは、覚えた物を替えるだけ: 見直し perf-4）
    const diff = info.full && this.index.source !== doc ? this.index.diffDoc(doc) : null;
    const change = diff ? { full: false, nodes: diff.nodes, edges: diff.edges, projects: diff.projects, scenarios: diff.scenarios } : info;
    this.engine.note(doc, change);
    // 組み立てたままと覚えた文書の形か数を、その場で書き換えた（エンジンが組み立てたままと見なさなくなった）: 覚えた物を忘れる。
    // 全部の入れ替えの元に戻す・やり直すは同じ文書の物に戻るので、忘れないと書き換えた見込みを無視して地図の列から作る（見直し data-1）
    if (!info.full && (info.nodes.size || info.edges.size) && !this.engine.holdsMap(doc)) forgetMapDoc(doc);
    if (diff) this.engine.rebindObjects(diff.sameNodes, diff.sameEdges);
    if (!diff && (info.full || this.index.source !== doc)) {
      this.index.rebuild(doc);
      this.search = null;
      this.searchBuild = null;
      this.forecastInputs++;
      this.titleVersion++;
      this.useMapDoc();
    } else {
      let hit = false;
      let addedOrRemoved = false;
      const touched = new Set<ID>();
      const visit = {
        node: (id: ID, before: GNode | undefined, after: GNode | undefined) => {
          if (!before || !after) addedOrRemoved = true;
          if (!hit && forecastNodeChanged(before, after)) hit = true;
          if (before && after && before.title !== after.title) this.titleVersion++;
          if (!before || !after || !info.positionsOnly) touched.add(id);
        },
        edge: (_id: ID, before: GEdge | undefined, after: GEdge | undefined) => {
          if (!hit && forecastEdgeChanged(before, after)) hit = true;
          if (before) touched.add(before.target);
          if (after) touched.add(after.target);
        },
      };
      if (diff) {
        this.index.rebase(doc, diff, visit);
        // 形と数が同梱の地図のままなら、新しい文書もその地図の文書として覚える（3 年の影響の形・見え方の範囲を地図の列から作り続ける）
        const map = this.engine.rebindDoc(doc);
        if (map) rememberMapDoc(doc, map);
      } else this.index.apply(doc, info, visit);
      if (hit) this.forecastInputs++;
      // 見込みの計画が前の文書の物を持ち続けない（取り込みの写しを残さない: 見直し perf-4）。見込みに使う所が同じなら新しい文書に替え、
      // 変わったなら捨てる（読まれたときに作り直す）
      const fp = this.forecastPlan;
      if (diff && fp && fp.doc !== doc && fp.inputs === this.forecastInputs) {
        fp.plan.rebase(doc);
        fp.doc = doc;
      }
      // 作っている途中の検索の索引: ノードが増えた・減った・多く替わったら作り直し、中身だけ変わったら入れた物だけ直す
      // （まだ入れていないノードは、入れるときに今の文書から読む）
      const b = this.searchBuild;
      if (b) {
        if (addedOrRemoved || touched.size > SEARCH_PATCH_MAX) {
          this.searchBuild = null;
          whenIdle(() => this.warmSearch(), 4000);
        } else {
          const put = [...touched].filter((id) => b.idx.has(id));
          if (put.length) b.idx.update(doc, this.index, put);
        }
      }
      if (this.search) {
        // 多くのカードの物が替わった（取り込み）: 検索の索引は空いた時間に作り直す（直すより軽い。App が全部の入れ替えの後に作る）
        if (diff && touched.size > SEARCH_PATCH_MAX) this.search = null;
        else {
          if (touched.size) this.search.update(doc, this.index, touched);
          if (change.projects.size) this.search.touch();
        }
      }
    }
    // 見込みに使う物が変わった: 前の計画と答えは使わないので、すぐ捨てる（見込みは読まれたときに作る。それまで前の文書を持ち続けない）
    if (this.forecastPlan && this.forecastPlan.inputs !== this.forecastInputs) {
      this.forecastPlan = null;
      this.forecastCache = EMPTY_FORECAST;
      this.forecastKey = "";
    }
    this.appliedRev = store.revision;
  }

  invalidate(): void {
    this.index.rebuild(this.store.doc);
    this.search = null;
    this.searchBuild = null;
    this.appliedRev = this.store.revision;
    this.dirtyVis = true;
    this.forecastInputs++;
    this.forecastPlan = null;
    this.forecastCache = EMPTY_FORECAST;
    this.forecastKey = "";
    this.engine.invalidate();
    this.useMapDoc();
  }

  /** 同梱の地図を組み立てたままの文書なら、3 年の影響の形をその地図の列から作るようにエンジンに知らせる（src/app/futureCache.ts） */
  private useMapDoc(): void {
    const doc = this.store.doc;
    const map = mapDocOf(doc);
    if (map) this.engine.useMap({ map, doc });
  }

  ensure(): void {
    if (this.dirtyVis) {
      this.compute();
      this.dirtyVis = false;
      this.version++;
    }
    if (this.dirtyPos) {
      this.dirtyPos = false;
      this.placeOverlay();
    }
  }

  node(id: ID): NodeVis {
    this.ensure();
    return this.nodes.get(id) ?? HIDDEN_NODE;
  }

  /** ノードの数（文書をなめない） */
  get nodeCount(): number {
    return this.index.nodeCount;
  }

  /** 3 年の分かれ道の範囲の外のノード（自分のノード。文書の順。形の版ごとに覚えている） */
  userNodeIds(): readonly ID[] {
    return this.userPart(this.scopeInfo()).users;
  }

  /** 予測の入口のノード（文書をなめない） */
  forecastRootIds(): ID[] {
    return [...this.index.forecastRoots];
  }

  /**
   * 未来の道筋の見込み（予測の入口があるときだけ active）。シナリオを選んでいれば、そのシナリオを選んだ場合の見込み。
   * 見込みに使う物（道の線・% ・線のシナリオ・入口・種類）が変わるか、選んだシナリオが変わったときだけ数え直す（作業メモ perf-2）。
   * 題名だけが変わったときは、行き先の並び（同じ見込みの中は題名の順）だけを、読まれたときに並べ直す
   */
  get forecast(): ForecastResult {
    const doc = this.store.doc;
    const sid0 = this.ui.prefs.scenarioId ?? null;
    const sid = sid0 && doc.scenarios[sid0] ? sid0 : null;
    const key = `${this.forecastInputs}|${sid ?? ""}`;
    if (key !== this.forecastKey) {
      // 計画（方針に依らない所）は見込みに使う物の版ごとに 1 度だけ作り、方針ごとに流し直す（computeForecast と同じ答えの速い作り）。
      // 入口（文書の順）と 3 年の分かれ道の範囲は、索引と見え方の計算が持っている物を使う
      let plan = this.forecastPlan;
      if (!plan || plan.inputs !== this.forecastInputs) {
        // 空いた時間に作りかけの計画があれば、その続きを作る（同じ入力のときだけ）
        const st = this.forecastSteps;
        this.forecastSteps = null;
        if (st && st.inputs === this.forecastInputs && st.doc === doc) {
          while (!st.steps.step());
          plan = this.forecastPlan = { inputs: st.inputs, doc, plan: st.steps.plan! };
        } else {
          const idx = this.index;
          const roots = [...idx.forecastRoots].sort((a, b) => idx.nodeOrder(a) - idx.nodeOrder(b));
          plan = this.forecastPlan = { inputs: this.forecastInputs, doc, plan: new ForecastPlan(doc, idx.out, { roots, impactScope: this.scopeSet() }) };
        }
      } else if (plan.doc !== doc) {
        // 見込みに使う所は同じで文書の物だけ替わった（全部の入れ替えを変わった物だけで受けた後）: 計画は作り直さない（見直し perf-4）
        plan.plan.rebase(doc);
        plan.doc = doc;
      }
      this.forecastCache = this.titledEnds(plan.plan.run(sid));
      this.forecastKey = key;
      this.forecastTitles = this.titleVersion;
      this.forecastStamp++;
    }
    return this.forecastCache;
  }

  /** 空いた時間に少しずつ作っている見込みの計画（入力の版と文書が同じ間だけ続ける） */
  private forecastSteps: { inputs: number; doc: DocData; steps: PlanSteps } | null = null;
  private forecastWaiters: Array<() => void> = [];
  private forecastWarming = false;

  /**
   * 見込み（もう数えてあれば。数えていなければ null: 大きい文書では読んでも数えない。小さい文書（ノード 5,000 枚まで）はその場で数えて返す:
   * 数えるのは数 ms で、空いた時間を待つと見え方が一度変わるだけ）
   */
  forecastIfReady(): ForecastResult | null {
    const doc = this.store.doc;
    const sid0 = this.ui.prefs.scenarioId ?? null;
    const sid = sid0 && doc.scenarios[sid0] ? sid0 : null;
    if (`${this.forecastInputs}|${sid ?? ""}` === this.forecastKey) return this.forecastCache;
    return this.index.nodeCount <= FORECAST_SYNC_NODES ? this.forecast : null;
  }

  /**
   * 見込みを空いた時間に少しずつ数え、数え終えたら done を呼ぶ（もう数えてあればすぐ）。起動の最初のフレーム・概要の最初の作りを、
   * 8 万枚の地図の見込みの計画（4 倍遅いスマホで 0.6 秒ほど）で待たせない（見直し perf-1: 見取り図を先に見せて、触れるようにしてから）。
   * 途中で見込みに使う物が変わったら、作りかけの計画を捨てて作り直す
   */
  warmForecast(done: () => void): void {
    if (this.forecastIfReady()) {
      done();
      return;
    }
    this.forecastWaiters.push(done);
    if (this.forecastWarming) return;
    this.forecastWarming = true;
    const finish = (): true => {
      this.forecastWarming = false;
      const ws = this.forecastWaiters;
      this.forecastWaiters = [];
      for (const w of ws) w();
      return true;
    };
    idleSteps(() => {
      if (this.forecastIfReady()) return finish();
      const doc = this.store.doc;
      const plan = this.forecastPlan;
      if (!plan || plan.inputs !== this.forecastInputs) {
        let st = this.forecastSteps;
        if (!st || st.inputs !== this.forecastInputs || st.doc !== doc) {
          const idx = this.index;
          const roots = [...idx.forecastRoots].sort((a, b) => idx.nodeOrder(a) - idx.nodeOrder(b));
          st = this.forecastSteps = { inputs: this.forecastInputs, doc, steps: ForecastPlan.steps(doc, idx.out, { roots, impactScope: this.scopeSet() }) };
        }
        if (!st.steps.step()) return false;
        this.forecastPlan = { inputs: st.inputs, doc, plan: st.steps.plan! };
        this.forecastSteps = null;
        // 流すのは次の空いた時間に
        return false;
      }
      void this.forecast;
      return finish();
    });
  }

  /** 見込みの行き先の並びを、題名が変わったら読まれたときに並べ直す（computeForecast と同じ並べ方。初めの並べ替えも読まれたときに） */
  private titledEnds(fc: ForecastResult): ForecastResult {
    const base = Object.getOwnPropertyDescriptor(fc, "ends");
    let ends: ID[] | null = null;
    Object.defineProperty(fc, "ends", {
      enumerable: true,
      configurable: true,
      get: (): ID[] => {
        if (ends === null) ends = (base?.get ? base.get.call(fc) : base?.value) as ID[];
        if (this.forecastTitles !== this.titleVersion) {
          this.forecastTitles = this.titleVersion;
          const doc = this.store.doc;
          ends = ends.slice().sort((a, b) => fc.reach.get(b)!.p - fc.reach.get(a)!.p || (doc.nodes[a]?.title || "").localeCompare(doc.nodes[b]?.title || "", "ja"));
        }
        return ends;
      },
    });
    return fc;
  }

  /** 3 年の分かれ道の範囲（道の線の版ごとに 1 度だけ作る集合） */
  private scopeSetCache: { flow: number; set: ReadonlySet<ID> } | null = null;
  private scopeSet(): ReadonlySet<ID> {
    const info = this.scopeInfo();
    const c = this.scopeSetCache;
    if (c && c.flow === info.flow) return c.set;
    const set = new Set(info.order);
    this.scopeSetCache = { flow: info.flow, set };
    return set;
  }

  /**
   * 3 年の影響（v2 の未来の道筋があるときだけ active）。エンジンが、計算に使う物が変わったときだけやり直す
   * （% ・状態・年収・種類・時間・meta・つなぎ方の編集とシナリオ。題名などの文字だけの編集・開く・閉じる・選ぶだけでは同じ結果を返す。
   * 題名を書いている所は、それぞれが文書から書き直す）
   */
  get impact(): ImpactResult {
    const doc = this.store.doc;
    const sid0 = this.ui.prefs.scenarioId ?? null;
    const sid = sid0 && doc.scenarios[sid0] ? sid0 : null;
    return this.engine.result({
      doc,
      sid,
      out: () => this.index.out,
      roots: () => {
        const idx = this.index;
        return [...idx.impactRoots].sort((a, b) => idx.nodeOrder(a) - idx.nodeOrder(b));
      },
      reach: () => {
        const fc = this.forecast;
        return { version: this.forecastStamp, of: (id) => fc.reach.get(id)?.p ?? 0 };
      },
    });
  }

  /**
   * 検索の索引を先に作っておく（起動の後・全部の入れ替えの後の空いた時間に。初めての検索の 1 文字を待たせない）。
   * 8 万枚を 1 度に作ると長い 1 つの仕事になるので、ノード 2,000 枚ずつ、空いた時間の内に作る（見直し perf-8）。
   * 途中で検索したら、残りをその場で作る
   */
  warmSearch(): void {
    if (this.search || this.searchBuild) return;
    const ids = [...this.index.nodeIds()];
    const b: SearchBuild = { idx: new SearchIndex(), ids, pos: 0 };
    this.searchBuild = b;
    idleSteps(
      () => {
        const to = Math.min(ids.length, b.pos + SEARCH_SLICE);
        b.idx.putRange(this.store.doc, this.index, ids, b.pos, to);
        b.pos = to;
        if (to < ids.length) return false;
        this.finishSearchBuild(b);
        return true;
      },
      () => this.searchBuild === b,
      4000,
    );
  }

  /** 作っている途中の検索の索引を、残りを入れて使い始める */
  private finishSearchBuild(b: SearchBuild): SearchIndex {
    if (b.pos < b.ids.length) b.idx.putRange(this.store.doc, this.index, b.ids, b.pos, b.ids.length);
    b.pos = b.ids.length;
    b.idx.finish();
    if (this.searchBuild === b) this.searchBuild = null;
    this.search = b.idx;
    return b.idx;
  }

  /** 検索の当たり（言葉と中身の版が同じなら前の答え） */
  private searchResult(): SearchResult | null {
    const q = parseQuery(this.ui.search);
    if (isEmptyQuery(q)) return null;
    if (!this.search) this.search = this.searchBuild ? this.finishSearchBuild(this.searchBuild) : new SearchIndex(this.store.doc, this.index);
    return this.search.query(q, this.store.doc);
  }

  // ------------------------------------------------------------ 見え方

  private compute(): void {
    const doc = this.store.doc;
    const prefs = this.ui.prefs;
    const idx = this.index;
    const filter = prefs.projectFilter.filter((p) => doc.projects[p]);
    const hasFilter = filter.length > 0;
    const fset = new Set(filter);
    const focus = hasFilter && prefs.projectMode === "focus";
    const sid = prefs.scenarioId && doc.scenarios[prefs.scenarioId] ? prefs.scenarioId : null;
    const hideScen = sid !== null && prefs.scenarioMode === "hide";
    const cursor = prefs.timeCursor;
    const sel = this.ui.selection;

    const inProj = (pids: ID[]) => !hasFilter || pids.some((p) => fset.has(p));
    const edgeInScen = (e: GEdge) => inScenario(e.scenarioIds, sid);

    // 1)・2) 範囲・折りたたみ・シナリオの推定（3 年の分かれ道の範囲は、文書の collapsed ではなく見え方の「開いているノード」で決める）。
    // 材料（形・開いている所・折りたたみ・絞り込み・シナリオ）が同じなら前の結果を使う（選択・検索・時点・文字だけの変更では作り直さない）
    const info = this.scopeInfo();
    const opens = info.roots.map((r) => this.openSetOf(r, info));
    const collapsedOf = this.collapsedFn(info, opens);
    const stops = this.stopsFn(info);
    const roots = this.forcedRoots(info);
    const filtered = focus || hideScen;
    let fast: FastVis | null = null;
    let full: FullVis | null = null;
    let edgeOk: (e: GEdge) => boolean = () => true;
    let unreached: (id: ID) => boolean = () => false;
    if (!filtered) {
      fast = this.fastVis(info, opens, collapsedOf, stops, roots);
      if (sid) {
        const reached = this.scenarioReach(info, sid, roots);
        if (reached) unreached = (id) => !reached.has(id);
      }
    } else {
      full = this.fullVis(opens, { focus, hideScen, sid, inProj, edgeInScen, collapsedOf, stops, roots, filter });
      edgeOk = (e: GEdge) => !hideScen || edgeInScen(e);
      const un = full.unreached;
      unreached = (id) => un.has(id);
    }
    const scope = full?.scope ?? null;
    const ghost = full?.ghost ?? EMPTY_SET;
    const counts = fast ? fast.counts : full!.col.counts;
    const visible = fast ? fast.visible : null;
    const colHidden = full ? full.col.hidden : null;
    this.last = { fast, full, edgeOk, stops, roots, collapsedOf, unreached, hideScen, sid, focus, inProj };

    // 3) 検索
    const sres = this.searchResult();
    this.searchActive = sres !== null;
    this.searchHits = sres ? sres.hits : [];
    this.searchCount = sres ? sres.count : 0;

    /** 見えているか（範囲・折りたたみ・シナリオで隠す） */
    const offScenOf = (id: ID, n: GNode) => sid !== null && (!inScenario(n.scenarioIds, sid) || unreached(id));
    const shownBase = visible ? (id: ID) => visible.has(id) : (id: ID) => scope!.has(id) && !colHidden!.has(id);
    const shown = (id: ID): boolean => {
      if (!shownBase(id)) return false;
      if (!hideScen) return true;
      const n = doc.nodes[id];
      return !!n && !offScenOf(id, n);
    };

    // 4) 経路（隠れているノードからは強調しない。シナリオで隠した推定の先も同じ）
    const selected = [...sel.nodes].filter((id) => !!doc.nodes[id] && shown(id));
    this.pathActive = prefs.pathHighlight && selected.length > 0;
    const paths = this.pathActive ? computePaths(doc, idx, selected, (e) => edgeOk(e) && (!sid || edgeInScen(e)) && shown(e.source) && shown(e.target)) : null;
    // 3 年の分かれ道の選択肢を選んだときは、同じ判断のほかの選択肢（兄弟）とそこへの線も薄くしない（並べて比べられるように）
    const siblings = new Set<ID>();
    if (paths && info.roots.length) {
      for (const id of selected) {
        if (!info.pos.has(id)) continue;
        for (const eid of idx.inc.get(id) ?? []) {
          const e = doc.edges[eid];
          const d = e && doc.nodes[e.source];
          if (!e || !d || !isFlowEdge(e) || !info.pos.has(d.id)) continue;
          const outs = flowOuts(doc, idx.out, d.id);
          if (forkKindOf(d, outs) !== "decision") continue;
          for (const o of outs) {
            if (!shown(o.target)) continue;
            siblings.add(o.target);
            siblings.add(o.id);
          }
        }
      }
    }

    // 5) ノード: 見えるノードと自分のノード（範囲の外）だけ。隠れた地図のカードは作らない（HIDDEN_NODE を返す）
    const users = this.userPart(info).users;
    let candidates: ID[];
    if (visible) {
      const set = new Set<ID>(visible);
      for (const u of users) set.add(u);
      candidates = [...set];
    } else {
      // 絞り込みの道: 範囲のノードの中の見える物と、自分のノード
      const set = new Set<ID>(users);
      for (const id of scope!) if (!colHidden!.has(id)) set.add(id);
      candidates = [...set];
    }
    candidates.sort((a, b) => idx.nodeOrder(a) - idx.nodeOrder(b));
    this.nodes.clear();
    const draw: ID[] = [];
    const drawTop: ID[] = [];
    let visibleCount = 0;
    /** 見えている 3 年の分かれ道のノード（重ねる位置を作る材料。文書の順） */
    const visibleScope: ID[] = [];
    const hitHas = sres ? (id: ID) => sres.has(id) : () => false;
    for (const id of candidates) {
      const n = doc.nodes[id];
      if (!n) continue;
      const offScenario = offScenOf(id, n);
      const hidden = !shownBase(id) || (hideScen && offScenario);
      const inProject = inProj(n.projectIds);
      const isGhost = ghost.has(id);
      let alpha = 1;
      if (hasFilter && !inProject) alpha = Math.min(alpha, isGhost ? 0.55 : 0.13);
      if (offScenario) alpha = Math.min(alpha, 0.22);
      const future = !!(cursor && n.time.due && n.time.due > cursor);
      if (future) alpha = Math.min(alpha, 0.18);
      const match = hitHas(id);
      if (this.searchActive && !match) alpha = Math.min(alpha, 0.14);
      const path = !!paths?.nodes.has(id);
      if (this.pathActive && !path && !siblings.has(id)) alpha = Math.min(alpha, 0.3);
      const inImpact = info.pos.has(id);
      const closed = collapsedOf(id);
      const collapsedCount = closed ? (counts.get(id) ?? 0) : 0;
      // 3 年の分かれ道は、閉じていて、同じ範囲の子（閉じると隠れる物）があるときだけ折りたたみの印を出す
      const collapsed = inImpact ? closed && this.hasStops(id, stops) : n.collapsed;
      this.nodes.set(id, { hidden, alpha, match, path, ghost: isGhost, future, offScenario, collapsedCount, collapsed, inProject });
      if (!hidden) {
        visibleCount++;
        (sel.nodes.has(id) ? drawTop : draw).push(id);
        if (inImpact) visibleScope.push(id);
      }
    }
    this.drawNodes = draw.concat(drawTop);
    this.hiddenCount = idx.nodeCount - visibleCount;

    // 6) 接続: 元が見えるノード・自分のノードの線だけ（描く線はどれも元が見える。文書の順）
    this.edges.clear();
    const edgeIds: ID[] = [];
    for (const id of candidates) for (const eid of idx.out.get(id) ?? []) edgeIds.push(eid);
    edgeIds.sort((a, b) => idx.edgeOrder(a) - idx.edgeOrder(b));
    const edgesNormal: ID[] = [];
    const edgesTop: ID[] = [];
    const stubs: Array<{ id: ID; count: number }> = [];
    for (const id of edgeIds) {
      const e = doc.edges[id];
      if (!e) continue;
      const a = this.nodes.get(e.source);
      const b = this.nodes.get(e.target);
      const offScenario = sid !== null && !edgeInScen(e);
      const cross = idx.cross.has(id);
      // 元のノードの折りたたみで止まる線は描かない（3 年の分かれ道の閉じたカードは、同じ範囲の子への道の線だけ）
      const srcClosed = collapsedOf(e.source) && stops(e);
      let hidden = !a || !b || a.hidden || b.hidden || (hideScen && offScenario) || srcClosed || e.collapsed;
      const incident = sel.nodes.has(e.source) || sel.nodes.has(e.target) || sel.edges.has(id);
      if (prefs.edgeMode === "selection" && !incident) hidden = true;
      if (prefs.edgeMode === "cross" && !cross && !incident) hidden = true;
      let alpha = Math.min(a?.alpha ?? 0, b?.alpha ?? 0);
      if (offScenario) alpha = Math.min(alpha, 0.16);
      const path = !!paths?.edges.has(id);
      if (this.pathActive && !path && !siblings.has(id)) alpha = Math.min(alpha, 0.2);
      this.edges.set(id, { hidden, alpha, path, cross, offScenario });
      if (!hidden) (path || sel.edges.has(id) ? edgesTop : edgesNormal).push(id);
      if (e.collapsed && a && !a.hidden && !srcClosed && !(hideScen && offScenario)) stubs.push({ id, count: counts.get(id) ?? 0 });
    }
    this.drawEdges = edgesNormal.concat(edgesTop);
    this.stubEdges = stubs;

    // 7) 3 年の分かれ道の重ねる位置（開いている所・見えている物・形が変わったときだけ並べ直す）
    this.updateOverlay(info, opens, visibleScope);
  }

  /** 折りたたんでいるか: 3 年の分かれ道は見え方の「開いているノード」、それ以外は文書の collapsed */
  private collapsedFn(info: ImpactScopeInfo, opens: Set<ID>[]): (id: ID) => boolean {
    const doc = this.store.doc;
    if (!info.roots.length) return (id) => !!doc.nodes[id]?.collapsed;
    return (id) => {
      const p = info.pos.get(id);
      return p !== undefined ? !opens[info.rootOf[p]!]!.has(id) : !!doc.nodes[id]?.collapsed;
    };
  }

  /** 3 年の分かれ道の閉じたカードが止めるのは、同じ範囲の子への道の線だけ（ほかの関係の線・範囲の外へ出る線の先は隠さない） */
  private stopsFn(info: ImpactScopeInfo): (e: GEdge) => boolean {
    return (e) => {
      const p = info.pos.get(e.source);
      if (p === undefined) return true;
      if (!isFlowEdge(e)) return false;
      const q = info.pos.get(e.target);
      return q !== undefined && info.rootOf[q] === info.rootOf[p];
    };
  }

  /** 3 年の分かれ道の入口は必ず入口にする（カードから今日へ戻る線を引いても、地図ごと消えない）。ほかの入口がたどった入口は除く */
  private forcedRoots(info: ImpactScopeInfo): ReadonlySet<ID> {
    const out = new Set<ID>();
    info.roots.forEach((r, i) => {
      const p = info.pos.get(r);
      if (p !== undefined && info.rootOf[p] === i) out.add(r);
    });
    return out;
  }

  /** 止める線が出ているか（閉じると何かが隠れる） */
  private hasStops(id: ID, stops: (e: GEdge) => boolean): boolean {
    const doc = this.store.doc;
    for (const eid of this.index.out.get(id) ?? []) {
      const e = doc.edges[eid];
      if (e && e.source !== e.target && stops(e)) return true;
    }
    return false;
  }

  /**
   * 速い道（絞り込みが無いとき）: 入口から、止める線（閉じたカードの止める線・折りたたんだ線）を通らずにたどった所が見える（O(見える物)）。
   * 件数は見えている起点だけ（閉じたカードの先が木なら先の数、そうでなければ隠れた所をたどる）
   */
  private fastVis(info: ImpactScopeInfo, opens: Set<ID>[], collapsedOf: (id: ID) => boolean, stops: (e: GEdge) => boolean, roots: ReadonlySet<ID>): FastVis {
    const v = this.index.version;
    const key = `${v.topo}|${v.flow}|${v.collapse}`;
    const c = this.fastCache;
    if (c && c.key === key && c.opens.length === opens.length && c.opens.every((s, i) => s === opens[i])) return c;
    const doc = this.store.doc;
    const edgeColl = (e: GEdge) => e.collapsed;
    const visible = this.visibleWith(info, collapsedOf, stops, roots, edgeColl);
    // 件数
    const counts = new Map<ID, number>();
    const tree = this.treeInfo(info);
    for (const id of visible) {
      const list = this.index.out.get(id);
      if (!list?.length) continue;
      const closed = collapsedOf(id);
      let stopped: ID[] | null = null;
      for (const eid of list) {
        const e = doc.edges[eid];
        if (!e || e.source === e.target) continue;
        const stop = closed && stops(e);
        if (stop) (stopped ??= []).push(e.target);
        else if (e.collapsed) {
          // 折りたたんだ線（元のカードの折りたたみで止まっていない物）: その先
          counts.set(eid, this.countFrom([e.target], visible, info, tree, eid));
        }
      }
      if (stopped) counts.set(id, this.countBelow(id, stopped, visible, info, tree));
    }
    const res: FastVis = { key, opens, visible, counts };
    this.fastCache = res;
    return res;
  }

  /** 閉じたカード id の件数: 先が木ならたどらずに先の数、そうでなければ隠れている所をたどる */
  private countBelow(id: ID, starts: ID[], visible: ReadonlySet<ID>, info: ImpactScopeInfo, tree: TreeInfo): number {
    const p = info.pos.get(id);
    if (p !== undefined && tree.clean[p]) return tree.size[p]! - 1;
    return this.countFrom(starts, visible, info, tree, null);
  }

  /** starts の隠れている物から、隠れている所だけをたどって届く数（見えている所で止める＝開くと出てくる物） */
  private countFrom(starts: ID[], visible: ReadonlySet<ID>, info: ImpactScopeInfo, tree: TreeInfo, via: ID | null): number {
    // 折りたたんだ線の先が、その線だけが入る木なら、たどらずに先の数
    if (via !== null && starts.length === 1) {
      const t = starts[0]!;
      const q = info.pos.get(t);
      if (q !== undefined && !visible.has(t) && tree.regular[q] && tree.clean[q] && info.parentEdge[q] === via) return tree.size[q]!;
    }
    const doc = this.store.doc;
    const seen = new Set<ID>();
    const stack: ID[] = [];
    for (const s of starts) if (!visible.has(s) && !seen.has(s)) (seen.add(s), stack.push(s));
    let k = 0;
    while (stack.length) {
      const cur = stack.pop()!;
      k++;
      for (const eid of this.index.out.get(cur) ?? []) {
        const e = doc.edges[eid];
        if (!e || e.source === e.target) continue;
        const t = e.target;
        if (!visible.has(t) && !seen.has(t)) (seen.add(t), stack.push(t));
      }
    }
    return k;
  }

  /**
   * 見えるノード（絞り込みが無いとき）: 入口から、止める線を通らずにたどれる所。collapsedOf・edgeColl を差し替えて、
   * 開いた後の見え方も求められる（隠れたノードを出す計画）
   */
  private visibleWith(info: ImpactScopeInfo, collapsedOf: (id: ID) => boolean, stops: (e: GEdge) => boolean, roots: ReadonlySet<ID>, edgeColl: (e: GEdge) => boolean): Set<ID> {
    const doc = this.store.doc;
    const out = this.index.out;
    const part = this.userPart(info);
    const visible = new Set<ID>();
    const stack: ID[] = [];
    const enter = (id: ID) => {
      if (!visible.has(id) && doc.nodes[id]) (visible.add(id), stack.push(id));
    };
    for (const r of roots) enter(r);
    for (const u of part.indeg0) enter(u);
    for (const m of part.sccs) {
      // 入口の無い循環のかたまり: その中の折りたたみの起点（無ければ全員）
      const os = m.filter((id) => this.isOrigin(id, collapsedOf, stops, edgeColl));
      for (const id of os.length ? os : m) enter(id);
    }
    while (stack.length) {
      const u = stack.pop()!;
      const closed = collapsedOf(u);
      for (const eid of out.get(u) ?? []) {
        const e = doc.edges[eid];
        if (!e || e.source === e.target) continue;
        if (edgeColl(e) || (closed && stops(e))) continue;
        enter(e.target);
      }
    }
    return visible;
  }

  /** 折りたたみの起点か（閉じていて止める線が出ている・折りたたんだ線が出ている） */
  private isOrigin(id: ID, collapsedOf: (id: ID) => boolean, stops: (e: GEdge) => boolean, edgeColl: (e: GEdge) => boolean): boolean {
    const doc = this.store.doc;
    const closed = collapsedOf(id);
    for (const eid of this.index.out.get(id) ?? []) {
      const e = doc.edges[eid];
      if (!e || e.source === e.target) continue;
      if ((closed && stops(e)) || edgeColl(e)) return true;
    }
    return false;
  }

  /**
   * 自分のノード（3 年の分かれ道の範囲の外）の入口（形の版ごと。範囲の外のノードは少ない）: 入る線（循環の線・自分への線を除く。
   * 地図のカードからの線も数える）の無い物と、外から入る線の無い循環のかたまり（computeCollapse の入口の決まりを、この部分にだけ使う）
   */
  private userPart(info: ImpactScopeInfo): UserPart {
    const v = this.index.version;
    const key = `${v.topo}|${v.flow}`;
    const c = this.userCache;
    if (c && c.key === key) return c;
    const doc = this.store.doc;
    const idx = this.index;
    const users: ID[] = [];
    // 範囲の外のノード（形が変わったときだけ。ノードの数だけ回る）
    for (const id of idx.out.keys()) if (!info.pos.has(id)) users.push(id);
    users.sort((a, b) => idx.nodeOrder(a) - idx.nodeOrder(b));
    const counted = (e: GEdge | undefined): e is GEdge => !!e && e.source !== e.target && e.relation !== "feedback";
    const indeg0: ID[] = [];
    for (const u of users) {
      let any = false;
      for (const eid of idx.inc.get(u) ?? []) {
        if (counted(doc.edges[eid])) {
          any = true;
          break;
        }
      }
      if (!any) indeg0.push(u);
    }
    const userSet = new Set(users);
    const succ = (id: ID): ID[] => {
      const list: ID[] = [];
      for (const eid of idx.out.get(id) ?? []) {
        const e = doc.edges[eid];
        if (counted(e) && userSet.has(e.target)) list.push(e.target);
      }
      return list;
    };
    const comp = stronglyConnected(users, succ);
    const members = new Map<number, ID[]>();
    for (const u of users) {
      const k = comp.get(u)!;
      let m = members.get(k);
      if (!m) members.set(k, (m = []));
      m.push(u);
    }
    const sccs: ID[][] = [];
    for (const m of members.values()) {
      if (m.length < 2) continue;
      const k = comp.get(m[0]!)!;
      let outer = false;
      for (const u of m) {
        for (const eid of idx.inc.get(u) ?? []) {
          const e = doc.edges[eid];
          if (!counted(e)) continue;
          if (!userSet.has(e.source) || comp.get(e.source) !== k) {
            outer = true;
            break;
          }
        }
        if (outer) break;
      }
      if (!outer) sccs.push(m);
    }
    const res: UserPart = { key, users, indeg0, sccs };
    this.userCache = res;
    return res;
  }

  /**
   * 範囲のカードの先が木か・その大きさ（形の版ごと）。幅優先の順の後ろから: 入る線が 1 本で出る線がどれも木の線なら regular、
   * 止める線の先がどれも自分がたどった子で regular かつ clean なら clean（閉じたときの件数 = 大きさ − 1）
   */
  private treeInfo(info: ImpactScopeInfo): TreeInfo {
    const v = this.index.version;
    const key = `${v.topo}|${v.flow}`;
    const c = this.treeCache;
    if (c && c.key === key) return c;
    const doc = this.store.doc;
    const idx = this.index;
    const n = info.order.length;
    const size = new Int32Array(n);
    const clean = new Uint8Array(n);
    const regular = new Uint8Array(n);
    for (let p = n - 1; p >= 0; p--) {
      const u = info.order[p]!;
      // 入る線の数（自分への線を除く。自分への線は出る線でも数えるので、そこで引く）
      let inDeg = idx.inc.get(u)?.length ?? 0;
      let reg = true;
      let cl = true;
      let sz = 1;
      for (const eid of idx.out.get(u) ?? []) {
        const e = doc.edges[eid];
        if (!e) continue;
        if (e.target === u) {
          inDeg--;
          continue;
        }
        const q = info.pos.get(e.target);
        const isTree = q !== undefined && info.parent[q] === p;
        if (!isTree) reg = false;
        const stop = isFlowEdge(e) && q !== undefined && info.rootOf[q] === info.rootOf[p];
        if (stop) {
          if (!isTree || !regular[q!] || !clean[q!]) cl = false;
          else sz += size[q!]!;
        }
      }
      size[p] = sz;
      clean[p] = cl ? 1 : 0;
      regular[p] = reg && inDeg === 1 ? 1 : 0;
    }
    const res: TreeInfo = { key, size, clean, regular };
    this.treeCache = res;
    return res;
  }

  /**
   * シナリオの推定（絞り込みが無いとき。computeUnreached と同じ）: 入口から、そのシナリオに入る線だけでたどれる所。
   * 届かない物がシナリオの外。シナリオに入らない線が 1 本も無ければ null（全部が届く）。形・シナリオ・方針が同じなら前の物
   */
  private scenarioReach(info: ImpactScopeInfo, sid: ID, roots: ReadonlySet<ID>): Set<ID> | null {
    const v = this.index.version;
    const key = `${v.topo}|${v.flow}|${v.scen}|${sid}`;
    const c = this.unreachCache;
    if (c && c.key === key) return c.reached;
    const doc = this.store.doc;
    const out = this.index.out;
    const inScen = (e: GEdge) => inScenario(e.scenarioIds, sid);
    const part = this.userPart(info);
    const reached = new Set<ID>();
    const stack: ID[] = [];
    let blocked = false;
    const enter = (id: ID) => {
      if (!reached.has(id) && doc.nodes[id]) (reached.add(id), stack.push(id));
    };
    for (const r of roots) enter(r);
    for (const u of part.indeg0) enter(u);
    for (const m of part.sccs) {
      // 入口の無い循環のかたまり: その中の、シナリオに入らない線の元（無ければ全員）
      const os = m.filter((id) => {
        for (const eid of out.get(id) ?? []) {
          const e = doc.edges[eid];
          if (e && e.source !== e.target && !inScen(e)) return true;
        }
        return false;
      });
      for (const id of os.length ? os : m) enter(id);
    }
    while (stack.length) {
      const u = stack.pop()!;
      for (const eid of out.get(u) ?? []) {
        const e = doc.edges[eid];
        if (!e || e.source === e.target) continue;
        if (!inScen(e)) {
          blocked = true;
          continue;
        }
        enter(e.target);
      }
    }
    // 届かなかった所から出る線にもシナリオの外の線があれば、それも止める線（computeUnreached の「止める線が 1 本も無い」の確かめ）
    if (!blocked && reached.size < this.index.nodeCount) {
      for (const [id, list] of out) {
        if (reached.has(id)) continue;
        for (const eid of list) {
          const e = doc.edges[eid];
          if (e && e.source !== e.target && !inScen(e)) {
            blocked = true;
            break;
          }
        }
        if (blocked) break;
      }
    }
    const res = blocked ? reached : null;
    this.unreachCache = { key, reached: res };
    return res;
  }

  /** 絞り込みの道: 範囲（シナリオで隠す・プロジェクトに絞る）と折りたたみ・シナリオの推定を計算する（材料ごとに覚えておく） */
  private fullVis(
    opens: Set<ID>[],
    o: { focus: boolean; hideScen: boolean; sid: ID | null; inProj: (pids: ID[]) => boolean; edgeInScen: (e: GEdge) => boolean; collapsedOf: (id: ID) => boolean; stops: (e: GEdge) => boolean; roots: ReadonlySet<ID>; filter: ID[] },
  ): FullVis {
    const v = this.index.version;
    const key = `${v.topo}|${v.flow}|${v.collapse}|${v.members}|${v.scen}|${o.sid ?? ""}|${o.hideScen ? "h" : ""}|${o.focus ? o.filter.join(",") : ""}`;
    const c = this.fullCache;
    if (c && c.key === key && c.opens.length === opens.length && c.opens.every((s, i) => s === opens[i])) return c;
    const doc = this.store.doc;
    const idx = this.index;
    const { focus, hideScen, sid, inProj, edgeInScen } = o;
    // 1) 範囲（シナリオで隠す・プロジェクトに絞る）。絞り込みがあるときだけの道（ノードの数だけ回る）
    const scope = new Set<ID>();
    for (const id of idx.out.keys()) {
      const n = doc.nodes[id]!;
      if (hideScen && !inScenario(n.scenarioIds, sid)) continue;
      if (focus && !inProj(n.projectIds)) continue;
      scope.add(id);
    }
    const ghost = new Set<ID>();
    if (focus) {
      for (const id of [...scope]) {
        for (const list of [idx.out.get(id), idx.inc.get(id)]) {
          for (const eid of list ?? []) {
            const e = doc.edges[eid]!;
            const other = e.source === id ? e.target : e.source;
            if (scope.has(other) || ghost.has(other)) continue;
            const on = doc.nodes[other];
            if (!on) continue;
            if (hideScen && (!inScenario(on.scenarioIds, sid) || !edgeInScen(e))) continue;
            ghost.add(other);
          }
        }
      }
      for (const g of ghost) scope.add(g);
    }
    const edgeOk = (e: GEdge) => !hideScen || edgeInScen(e);
    // 2) 折りたたみ・シナリオの推定
    const col = computeCollapse(doc, idx, scope, edgeOk, o.collapsedOf, { stops: o.stops, roots: o.roots });
    const unreached = sid ? computeUnreached(doc, idx, scope, edgeInScen, o.roots) : new Set<ID>();
    const res: FullVis = { key, opens, scope, ghost, col, unreached };
    this.fullCache = res;
    return res;
  }

  // ------------------------------------------------------------ 3 年の分かれ道（開く・閉じる・重ねる位置）

  /** 3 年の分かれ道の範囲と入口（道の線の版が変わったときだけ作り直す） */
  private scopeInfo(): ImpactScopeInfo {
    const flow = this.index.version.flow;
    const c = this.scopeCache;
    if (c && c.flow === flow) return c;
    const fromMap = this.scopeFromMap(flow);
    if (fromMap) return (this.scopeCache = fromMap);
    const doc = this.store.doc;
    const out = this.index.out;
    const roots = [...this.index.impactRoots].sort();
    const pos = new Map<ID, number>();
    const order: ID[] = [];
    const rootOfL: number[] = [];
    const depthL: number[] = [];
    const parentL: number[] = [];
    const parentEdge: ID[] = [];
    roots.forEach((r, ri) => {
      if (pos.has(r)) return;
      // 幅優先（いちばん短い歩数を列の深さに）
      const start = order.length;
      pos.set(r, start);
      order.push(r);
      rootOfL.push(ri);
      depthL.push(0);
      parentL.push(-1);
      parentEdge.push("");
      for (let i = start; i < order.length; i++) {
        const id = order[i]!;
        // flowOuts と同じ選び方（索引の線は両端のノードがある物だけ）を、並びを作らずに
        for (const eid of out.get(id) ?? []) {
          const e = doc.edges[eid];
          if (!e || (e.relation !== "leads" && e.relation !== "condition") || e.target === id || pos.has(e.target)) continue;
          pos.set(e.target, order.length);
          order.push(e.target);
          rootOfL.push(ri);
          depthL.push(depthL[i]! + 1);
          parentL.push(i);
          parentEdge.push(e.id);
        }
      }
    });
    const info: ImpactScopeInfo = { flow, roots, pos, order, rootOf: Int32Array.from(rootOfL), depth: Int32Array.from(depthL), parent: Int32Array.from(parentL), parentEdge };
    this.scopeCache = info;
    return info;
  }

  /**
   * 組み立てたままの同梱の地図（自分のノード・線が無く、形を変えていない）なら、範囲をエンジンの地図の形から作る（文書をたどらない）。
   * 番号は地図の深さ優先の順（親は子より前。幅優先の順と同じく、後ろから数えれば子が先）。木なので、たどった親・歩数は幅優先と同じ
   */
  private scopeFromMap(flow: number): ImpactScopeInfo | null {
    const doc = this.store.doc;
    const idx = this.index;
    // 組み立てたままの地図（数も地図と同じ）なら、エンジンに地図の列から形を作らせる（3 年の影響の計算でもすぐ要る物。まだなら今。
    // エンジンの計算の中から見込み → 範囲と来たときは作らせない）
    let t = this.engine.mapTopo(doc);
    const map = t ? null : mapDocOf(doc);
    if (map && !this.scopeBusy && idx.nodeCount === map.n && idx.edgeCount === map.n - 1) {
      this.scopeBusy = true;
      try {
        void this.impact;
      } finally {
        this.scopeBusy = false;
      }
      t = this.engine.mapTopo(doc);
    }
    if (!t || !t.cm || idx.nodeCount !== t.n || idx.edgeCount !== t.n - 1 || idx.impactRoots.size !== 1 || !idx.impactRoots.has(t.ids[0]!)) return null;
    const n = t.n;
    const cm = t.cm;
    const parentEdge: ID[] = new Array(n);
    parentEdge[0] = "";
    for (let i = 1; i < n; i++) parentEdge[i] = t.eid[t.incSlot[t.incOff[i]!]!]!;
    const info: ImpactScopeInfo = { flow, roots: [t.ids[0]!], pos: t.idx, order: t.ids, rootOf: new Int32Array(n), depth: Int32Array.from(cm.depth), parent: cm.parent, parentEdge };
    // 先の数: どのカードも入る線が 1 本・出る線は木の線だけ（地図のまま）
    const regular = new Uint8Array(n).fill(1);
    regular[0] = 0;
    const v = idx.version;
    this.treeCache = { key: `${v.topo}|${flow}`, size: cm.size, clean: new Uint8Array(n).fill(1), regular };
    return info;
  }

  /** そのノードの先（道の線でつながる子。範囲の中で同じ入口の物。線の順） */
  private impactKids(id: ID, info: ImpactScopeInfo): ID[] {
    const doc = this.store.doc;
    const p = info.pos.get(id);
    const list: ID[] = [];
    if (p === undefined) return list;
    const r = info.rootOf[p];
    for (const eid of this.index.out.get(id) ?? []) {
      const e = doc.edges[eid];
      if (!e || e.source === e.target || !isFlowEdge(e)) continue;
      const q = info.pos.get(e.target);
      if (q === undefined || info.rootOf[q] !== r || list.includes(e.target)) continue;
      list.push(e.target);
    }
    return list;
  }

  /** 入口の「開いているノード」。保存してあればそれ、無ければ最初の形（狭い画面は今日だけ・広い画面は今日と選択肢） */
  private openSetOf(root: ID, info: ImpactScopeInfo): Set<ID> {
    const src = this.ui.prefs.impactOpen[root];
    const c = this.openCache.get(root);
    if (c && c.src === src && (src !== undefined || c.flow === info.flow)) return c.set;
    let set: Set<ID>;
    if (src) set = new Set(src);
    else {
      let narrow = this.narrowDefault.get(root);
      if (narrow === undefined) this.narrowDefault.set(root, (narrow = this.narrow()));
      set = new Set([root]);
      if (!narrow) for (const k of this.impactKids(root, info)) set.add(k);
    }
    this.openCache.set(root, { src, flow: info.flow, set });
    return set;
  }

  /** 3 年の分かれ道の範囲のノードか */
  inImpact(id: ID): boolean {
    return this.scopeInfo().pos.has(id);
  }

  /** 3 年の分かれ道の入口（ID の順） */
  impactRoots(): ID[] {
    return this.scopeInfo().roots;
  }

  /** 3 年の分かれ道で開いているか（範囲の外は文書の collapsed の逆） */
  isOpen(id: ID): boolean {
    const info = this.scopeInfo();
    const p = info.pos.get(id);
    if (p === undefined) return !this.store.doc.nodes[id]?.collapsed;
    return this.openSetOf(info.roots[info.rootOf[p]!]!, info).has(id);
  }

  /**
   * 折りたたんでいるか（右クリックのメニューの「展開する／この先を折りたたむ」・C で決める向き）。
   * 3 年の分かれ道は見え方で閉じていて、同じ範囲の子（閉じると隠れる物）がある物、それ以外は文書の collapsed
   */
  isCollapsed(id: ID): boolean {
    const info = this.scopeInfo();
    if (!info.pos.has(id)) return !!this.store.doc.nodes[id]?.collapsed;
    return !this.isOpen(id) && this.impactKids(id, info).length > 0;
  }

  /**
   * 開く・閉じる物があるか（折りたたみの印・C・右クリックのメニュー・詳細のボタンで同じ決まり）。
   * 3 年の分かれ道は同じ範囲の子（道の線の先。閉じると隠れる物）があるか。相乗効果などの線や、範囲の外へ出る線だけでは開閉しない。
   * それ以外のノードは出る線があるか
   */
  canCollapse(id: ID): boolean {
    const info = this.scopeInfo();
    if (info.pos.has(id)) return this.impactKids(id, info).length > 0;
    return (this.index.out.get(id)?.length ?? 0) > 0;
  }

  /**
   * 3 年の分かれ道のノードを開く・閉じる（見え方だけ。文書・履歴・保存・同期は変えない）。範囲の外の ID は無視する。
   * reveal: 開いた子が見える所へキャンバスを寄せる。変えたら true
   */
  setImpactOpen(open: Iterable<ID>, close: Iterable<ID> = [], opts: { reveal?: boolean } = {}): boolean {
    const info = this.scopeInfo();
    const next = new Map<ID, Set<ID>>();
    const opened = new Map<ID, ID[]>();
    const rootOf = (id: ID): ID | undefined => {
      const p = info.pos.get(id);
      return p === undefined ? undefined : info.roots[info.rootOf[p]!];
    };
    const get = (r: ID) => {
      let s = next.get(r);
      if (!s) next.set(r, (s = new Set(this.openSetOf(r, info))));
      return s;
    };
    let changed = false;
    /** 開く物の先頭（時間で区切って開くときは、開き始めたカード。もう開いていても、キャンバスを寄せる目印として見せる物の先頭に） */
    let head: ID | null = null;
    for (const id of open) {
      head ??= id;
      const r = rootOf(id);
      if (r === undefined) continue;
      const s = get(r);
      if (s.has(id)) continue;
      s.add(id);
      changed = true;
      let list = opened.get(r);
      if (!list) opened.set(r, (list = []));
      list.push(id);
    }
    for (const id of close) {
      const r = rootOf(id);
      if (r === undefined) continue;
      if (get(r).delete(id)) changed = true;
    }
    if (!changed) return false;
    if (opts.reveal && head !== null) {
      const r = rootOf(head);
      const list = r === undefined ? undefined : opened.get(r);
      if (list && list[0] !== head) list.unshift(head);
    }
    for (const [r, s] of next) this.ui.setImpactOpen(r, [...s], opts.reveal ? (opened.get(r) ?? []) : []);
    return true;
  }

  /** 3 年の分かれ道の開いている所を最初の形（今の画面の幅の形）に戻す（見え方だけ） */
  resetImpactOpen(): void {
    const info = this.scopeInfo();
    for (const r of info.roots) {
      this.narrowDefault.delete(r);
      this.openCache.delete(r);
      this.ui.setImpactOpen(r, null);
    }
  }

  /** 3 年の分かれ道の、先（同じ範囲の子）のあるノード（すべて開くとき。開閉する物は canCollapse と同じ決まり） */
  impactBranches(): ID[] {
    const info = this.scopeInfo();
    const out: ID[] = [];
    for (const id of info.order) if (this.impactKids(id, info).length > 0) out.push(id);
    return out;
  }

  /**
   * 3 年の分かれ道で、閉じた所の中に隠れているノードを出すために上流を開く（見え方だけ）。開いたら true。
   * 入口からの親をたどり、閉じたカードを開く（O(深さ)）。絞り込み・シナリオ・文書の折りたたみで隠れている分はそのまま（それは revealNode が決める）
   */
  openPathTo(id: ID): boolean {
    if (!this.inImpact(id) || !this.node(id).hidden) return false;
    const open = this.collapseBlockers(id).open;
    return open.length > 0 && this.setImpactOpen(open);
  }

  /** 3 年の分かれ道のカードの、入口からの親の並び（入口が先頭・自分が最後）。範囲の外なら空 */
  impactChain(id: ID): ID[] {
    const info = this.scopeInfo();
    let p = info.pos.get(id);
    const out: ID[] = [];
    while (p !== undefined && p >= 0) {
      out.push(info.order[p]!);
      p = info.parent[p]!;
    }
    return out.reverse();
  }

  /** 開いた・閉じた・見え方が変わったときに、重ねる位置を並べ直す（材料が同じなら並べ直さない） */
  private updateOverlay(info: ImpactScopeInfo, opens: Set<ID>[], visible: ID[]): void {
    if (!info.roots.length) {
      if (this.overlayRel.size) (this.overlayRel.clear(), this.overlayAbs.clear());
      this.overlayKey = null;
      return;
    }
    const topo = this.index.version.topo;
    const k = this.overlayKey;
    if (k && k.flow === info.flow && k.topo === topo && k.opens.length === opens.length && k.opens.every((s, i) => s === opens[i]) && k.visible.length === visible.length && k.visible.every((id, i) => id === visible[i])) return;
    this.overlayKey = { flow: info.flow, topo, opens, visible };
    const doc = this.store.doc;
    const rel = new Map<ID, { root: ID; x: number; y: number }>();
    const shown = new Set(visible);
    info.roots.forEach((r, i) => {
      const open = opens[i]!;
      const kids = (id: ID): ID[] => {
        if (!open.has(id)) return [];
        const list = this.impactKids(id, info).filter((c) => shown.has(c));
        if (list.length > 1) list.sort((a, b) => compareImpactKids(doc.nodes[a]!, doc.nodes[b]!));
        return list;
      };
      const mine = visible.filter((id) => info.roots[info.rootOf[info.pos.get(id)!]!] === r);
      if (!mine.length) return;
      // 入口が隠れている（絞り込みなど）ときは、入口の行だけ空けて、見えている物を下に並べる
      const rootKids = shown.has(r) ? kids : () => [];
      const col = quarterCol(doc, r);
      let pos = outlineLayout(r, rootKids, [], col);
      // 入口からたどれないが見えているノード（別の線でだけ見えている物など）は、入口の木の下に、その深さの列で並べる
      const rest = mine.filter((id) => !pos.has(id));
      if (rest.length) {
        const depthOf = (id: ID) => info.depth[info.pos.get(id)!]!;
        rest.sort((a, b) => depthOf(a) - depthOf(b) || compareImpactKids(doc.nodes[a]!, doc.nodes[b]!));
        pos = outlineLayout(
          r,
          rootKids,
          rest.map((id) => [id, depthOf(id)] as const),
          col,
        );
      }
      for (const [id, p] of pos) if (shown.has(id)) rel.set(id, { root: r, x: p.x, y: p.y });
    });
    this.overlayRel = rel;
    this.placeOverlay();
  }

  /** 重ねる位置 = 入口の文書の位置 + 相対の位置（入口が動いたときは、ここだけ作り直す） */
  private placeOverlay(): void {
    const doc = this.store.doc;
    const abs = new Map<ID, Pt>();
    for (const [id, p] of this.overlayRel) {
      const r = doc.nodes[p.root];
      if (r) abs.set(id, { x: r.x + p.x, y: r.y + p.y });
    }
    this.overlayAbs = abs;
  }

  /**
   * ノードの位置。3 年の分かれ道の見えているノードは重ねる位置、それ以外は文書の位置（隠れている範囲のノードも文書の位置。出してから使う）。
   * 返す物は書き換えない（描くたびに作らないよう、同じ物を返す）
   */
  posOf(id: ID): Pt | null {
    this.ensure();
    return this.overlayAbs.get(id) ?? this.store.doc.nodes[id] ?? null;
  }

  /** 重ねる位置で並べているノードか（3 年の分かれ道の見えているノード） */
  hasOverlay(id: ID): boolean {
    this.ensure();
    return this.overlayAbs.has(id);
  }

  /** 重ねる位置で並べているカードの位置（新しいノードの空いている所を探すときに避ける。3 年の分かれ道が無ければ空） */
  overlayPoints(): Pt[] {
    this.ensure();
    return [...this.overlayAbs.values()];
  }

  /**
   * ids が 3 年の分かれ道の入口とその子（選択肢）だけか（開いた・読み込んだ・寄ったときの最初の見え方）。
   * 入口 1 つだけのときは違う（F で今日だけに寄るのは、ふつうの寄り方）
   */
  isImpactEntry(ids: readonly ID[]): boolean {
    if (ids.length < 2) return false;
    const info = this.scopeInfo();
    const root = ids.find((id) => info.roots.includes(id));
    if (!root) return false;
    const kids = new Set(this.impactKids(root, info));
    return ids.every((id) => id === root || kids.has(id));
  }

  /** そのノードが表示の設定（プロジェクトに絞る・シナリオで隠す）で隠れているか */
  hiddenBy(id: ID): { focus: boolean; scenario: boolean; collapse: boolean } {
    this.ensure();
    const n = this.store.doc.nodes[id];
    const l = this.last;
    if (!n || !l) return { focus: false, scenario: false, collapse: false };
    if (l.fast) return { focus: false, scenario: false, collapse: !l.fast.visible.has(id) };
    const f = l.full!;
    const scenario = l.hideScen && (!inScenario(n.scenarioIds, l.sid) || f.unreached.has(id));
    const focus = l.focus && !f.scope.has(id) && !l.inProj(n.projectIds);
    return { focus, scenario, collapse: f.scope.has(id) && f.col.hidden.has(id) };
  }

  /**
   * 折りたたみで隠れたノードを出すために開く物（上流の折りたたんだノードと接続）。
   * nodes・edges は文書の折りたたみ（開くのは文書の変更）、open は 3 年の分かれ道の閉じたノード（開くのは見え方だけ）。
   * 3 年の分かれ道のカード（絞り込みが無いとき）: 入口からの親をたどり、閉じたカードと折りたたんだ線を、見えているカードまで開く（O(深さ)）。
   * それ以外: 隠れた上流を逆にたどり、そこへ入る線を止めている折りたたみを開く。開くと入口が変わることがあるので、見えるまで確かめ直す
   */
  collapseBlockers(id: ID): { nodes: ID[]; edges: ID[]; open: ID[] } {
    this.ensure();
    const l = this.last;
    const none = { nodes: [], edges: [], open: [] };
    if (!l) return none;
    const info = this.scopeInfo();
    if (l.fast) {
      const visible = l.fast.visible;
      if (visible.has(id) || !this.store.doc.nodes[id]) return none;
      const p0 = info.pos.get(id);
      if (p0 !== undefined) return this.chainBlockers(info, p0, visible, l.collapsedOf);
      return this.searchBlockers(id, info, l, (closed, edgeColl) => this.visibleWith(info, closed, l.stops, l.roots, edgeColl), (u) => !visible.has(u));
    }
    const f = l.full!;
    if (!f.scope.has(id) || !f.col.hidden.has(id)) return none;
    return this.searchBlockers(id, info, l, null, (u) => f.col.hidden.has(u));
  }

  /** 3 年の分かれ道のカード: 入口からの親をたどり、閉じた親と折りたたんだ線を、見えている親まで集める */
  private chainBlockers(info: ImpactScopeInfo, p0: number, visible: ReadonlySet<ID>, collapsedOf: (id: ID) => boolean): { nodes: ID[]; edges: ID[]; open: ID[] } {
    const doc = this.store.doc;
    const open: ID[] = [];
    const edges: ID[] = [];
    let p = p0;
    while (info.parent[p]! >= 0) {
      const q = info.parent[p]!;
      const u = info.order[q]!;
      const e = doc.edges[info.parentEdge[p]!];
      if (e?.collapsed) edges.push(e.id);
      if (collapsedOf(u)) open.push(u);
      if (visible.has(u)) break;
      p = q;
    }
    return { nodes: [], edges, open: open.reverse() };
  }

  /**
   * 隠れた上流を逆にたどり、そこへ入る線を止めている折りたたみを開く（見えるまで確かめ直す）。
   * visibleWith があれば速い道で見え方を求め直し、無ければ範囲で computeCollapse
   */
  private searchBlockers(
    id: ID,
    info: ImpactScopeInfo,
    l: LastVis,
    visibleWith: ((closed: (u: ID) => boolean, edgeColl: (e: GEdge) => boolean) => Set<ID>) | null,
    hidden0: (u: ID) => boolean,
  ): { nodes: ID[]; edges: ID[]; open: ID[] } {
    const openN = new Set<ID>();
    const openE = new Set<ID>();
    const openV = new Set<ID>();
    const base = l.collapsedOf;
    const closed = (u: ID): boolean => base(u) && !(info.pos.has(u) ? openV : openN).has(u);
    const edgeColl = (e: GEdge) => e.collapsed && !openE.has(e.id);
    let sim: DocData = this.store.doc;
    const scopeHas = l.full ? (u: ID) => l.full!.scope.has(u) : () => true;
    let isHidden = hidden0;
    for (let round = 0; round < 8 && isHidden(id); round++) {
      const region = new Set<ID>([id]);
      const stack: ID[] = [id];
      while (stack.length) {
        const v = stack.pop()!;
        for (const eid of this.index.inc.get(v) ?? []) {
          const e = sim.edges[eid];
          if (!e || e.source === e.target || !scopeHas(e.source) || !l.edgeOk(e)) continue;
          // 開くのは、この線を止めている折りたたみだけ（3 年の分かれ道の閉じたカードは、同じ範囲の子への道の線だけを止める）
          if (closed(e.source) && l.stops(e)) (info.pos.has(e.source) ? openV : openN).add(e.source);
          if (e.collapsed) openE.add(eid);
          if (isHidden(e.source) && !region.has(e.source)) {
            region.add(e.source);
            stack.push(e.source);
          }
        }
      }
      if (visibleWith) {
        const vis = visibleWith(closed, edgeColl);
        isHidden = (u) => !vis.has(u);
      } else {
        if (openE.size) {
          sim = { ...sim, edges: { ...sim.edges } };
          for (const e of openE) sim.edges[e] = { ...sim.edges[e]!, collapsed: false };
        }
        const col = computeCollapse(sim, this.index, l.full!.scope, l.edgeOk, closed, { stops: l.stops, roots: l.roots });
        isHidden = (u) => col.hidden.has(u);
      }
    }
    return { nodes: [...openN], edges: [...openE], open: [...openV] };
  }

  /**
   * 表示中のノードを囲む範囲（全体を表示に使う）。位置は posOf（3 年の分かれ道は重ねる位置）。
   * 3 年の分かれ道の隠れているノードは数えない（重ねる位置が無い）
   */
  bounds(ids?: Iterable<ID>): { minX: number; minY: number; maxX: number; maxY: number } | null {
    this.ensure();
    const doc = this.store.doc;
    const info = this.scopeInfo();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const id of ids ?? this.drawNodes) {
      const n = this.overlayAbs.get(id) ?? (info.pos.has(id) ? undefined : doc.nodes[id]);
      if (!n) continue;
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    }
    if (minX === Infinity) return null;
    return { minX, minY, maxX, maxY };
  }

  /**
   * プロジェクトをまたぐノード（概要の目安・操作ガイドが照らすノード）: 3 年の分かれ道の範囲の外のノードだけ（地図のカードは
   * どれも 3 つの領域に属するので数えない）。所属の数 + 線の先のプロジェクトの数の多い順、同じなら出る線の多い順。形・所属の版ごとに覚える
   */
  hubs(limit = 3): ID[] {
    const info = this.scopeInfo();
    const v = this.index.version;
    const key = `${v.topo}|${v.flow}|${v.members}|${limit}`;
    const c = this.hubsCache;
    if (c && c.key === key) return c.list;
    const doc = this.store.doc;
    const idx = this.index;
    const rows: Array<{ id: ID; score: number; outs: number; order: number }> = [];
    for (const id of this.userPart(info).users) {
      const n = doc.nodes[id];
      if (!n) continue;
      const reach = new Set<ID>();
      for (const eid of idx.out.get(id) ?? []) for (const p of doc.nodes[doc.edges[eid]!.target]?.projectIds ?? []) reach.add(p);
      if (!(n.projectIds.length > 1 || reach.size > 1)) continue;
      rows.push({ id, score: n.projectIds.length + reach.size, outs: idx.out.get(id)?.length ?? 0, order: idx.nodeOrder(id) });
    }
    rows.sort((a, b) => b.score - a.score || b.outs - a.outs || a.order - b.order);
    const list = rows.slice(0, limit).map((r) => r.id);
    this.hubsCache = { key, list };
    return list;
  }
}
