// 見え方の計算: プロジェクトの絞り込み・シナリオ・時点・検索・折りたたみ・経路の強調 → ノードと接続ごとの「隠す・薄さ」
// 変更のたびに作り直す（O(ノード + 接続)）。位置だけの変更では作り直さない
//
// 3 年の分かれ道（未来の道筋 v2）の範囲は、開く・閉じるを文書ではなく見え方（UiState.prefs.impactOpen・端末ごと）で持ち、
// 位置も文書の x・y ではなく、見えているノードだけを目次の形に並べ直した「重ねる位置」を使う（posOf）。設計: docs/DESIGN.md §4.7
//
// 3 年の影響はエンジン（src/model/impactEngine.ts）が数える。ストアの変更はエンジンに渡すだけで（印を付ける）、読まれたときに要る所だけ
// やり直す（作業メモ SPEC v1 §7.1・perf-11）。見込み（未来の道筋の P_path）は、見込みに使う物（道の線・% ・線のシナリオ・入口・種類）の
// 版と方針で覚える（題名・状態・位置だけの変更では数え直さない: perf-2）。

import { computeForecast, type ForecastResult } from "../model/forecast";
import { flowOuts, forkKindOf, isFlowEdge, isImpactRoot } from "../model/forks";
import type { ImpactResult } from "../model/impact";
import { ImpactEngine } from "../model/impactEngine";
import { compareImpactKids, outlineLayout } from "../model/impactLayout";
import { buildIndex, inScenario, type GraphIndex } from "../model/graph";
import { isEmptyQuery, parseQuery, searchNodes } from "../model/search";
import type { DocData, GEdge, GNode, ID } from "../model/types";
import { computeCollapse, computePaths, computeUnreached, type CollapseResult } from "../model/visibility";
import type { ChangeInfo, Store } from "../store/store";
import { isNarrowScreen } from "../ui/breakpoints";
import { mapDocOf } from "./futureCache";
import type { UiState } from "./uiState";

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

/** 3 年の分かれ道の範囲（索引ごとに作り直す） */
interface ImpactScopeInfo {
  index: number;
  /** 入口（ID の順） */
  roots: ID[];
  /** 範囲のノード → それをたどった入口 */
  owner: Map<ID, ID>;
  /** 入口から何歩目か（入口からたどれないノードを並べるときの列） */
  depth: Map<ID, number>;
}

type Pt = { x: number; y: number };

/** 範囲（絞り込み・シナリオで隠す）と折りたたみ・シナリオの推定の結果。選択・検索・時点では変わらない */
interface CollapseState {
  scope: Set<ID>;
  /** 絞り込み中の隣（ほかのプロジェクト） */
  ghost: Set<ID>;
  edgeOk: (e: GEdge) => boolean;
  collapsedOf: (id: ID) => boolean;
  /** 折りたたんだノードの線のうち止める線（3 年の分かれ道の閉じたカードは、同じ範囲の子への道の線だけ） */
  stops: (e: GEdge) => boolean;
  /** 必ず入口にするノード（3 年の分かれ道の入口） */
  roots: ReadonlySet<ID>;
  /** 3 年の分かれ道で、同じ範囲の子のあるノード（閉じると何かが隠れる物） */
  branches: Set<ID>;
  col: CollapseResult;
  unreached: Set<ID>;
}

export class ViewModel {
  index!: GraphIndex;
  readonly nodes = new Map<ID, NodeVis>();
  readonly edges = new Map<ID, EdgeVis>();
  /** 描く順（隠れていないもの。選択中は最後＝上） */
  drawNodes: ID[] = [];
  drawEdges: ID[] = [];
  /** 折りたたんだ接続（線の付け根だけ描く） */
  stubEdges: Array<{ id: ID; count: number }> = [];
  searchHits: Array<{ id: ID; score: number }> = [];
  searchActive = false;
  pathActive = false;
  hiddenCount = 0;
  version = 0;
  /** 索引を作り直した回数（重ねる位置・範囲の作り直しの目印） */
  private indexVersion = 0;
  /** 見込みに使う物（道の線・% ・線のシナリオ・入口・種類）の版。題名・状態・位置では進めない（perf-2） */
  private forecastInputs = 0;
  /** 題名の版（見込みの行き先の並びで、同じ見込みの行き先を題名の順にする所だけが読む） */
  private titleVersion = 0;
  private forecastKey = "";
  private forecastTitles = 0;
  /** 見込みを数え直した回数（3 年の影響のエンジンが、合流のある地図で見込みが変わったかを見る） */
  private forecastStamp = 0;
  private forecastCache: ForecastResult = { active: false, reach: new Map(), ends: [], longest: 0, order: [], impactScope: new Set() };
  /** 3 年の影響のエンジン（文書の変更を受け、読まれたときに要る所だけやり直す） */
  readonly engine = new ImpactEngine();
  /** 直前に見たノード・線（見込みに使う所が変わったかを、変わった物だけ前と後で比べる） */
  private seenNodes = new Map<ID, GNode>();
  private seenEdges = new Map<ID, GEdge>();
  private dirtyIndex = true;
  private dirtyVis = true;
  /** 位置だけが変わった（重ねる位置を入口の位置に合わせ直す） */
  private dirtyPos = false;
  /** 狭い画面か（3 年の分かれ道の最初の形を決める。確かめで差し替えられる） */
  narrow: () => boolean = isNarrowScreen;
  private scopeCache: ImpactScopeInfo | null = null;
  /** 入口ごとの「開いているノード」（保存してある配列か、最初の形） */
  private openCache = new Map<ID, { src: ID[] | undefined; index: number; set: Set<ID> }>();
  /** 入口ごとに、最初の形を狭い画面の形にしたか（この表示の間は変えない。幅が変わっても開いている所を動かさない） */
  private narrowDefault = new Map<ID, boolean>();
  /** 折りたたんでいるか（直前の計算で使った決まり） */
  private collapsedPred: (id: ID) => boolean = (id) => !!this.store.doc.nodes[id]?.collapsed;
  /** 重ねる位置（入口からの相対と、入口の位置を足した物） */
  private overlayRel = new Map<ID, { root: ID; x: number; y: number }>();
  private overlayAbs = new Map<ID, Pt>();
  /** 重ねる位置を作ったときの材料（同じなら作り直さない） */
  private overlayKey: { index: number; opens: Set<ID>[]; visible: ID[] } | null = null;
  /** 直前の計算の中身（隠れた理由を答える・折りたたみを開く計画に使う） */
  private last: {
    scope: Set<ID>;
    edgeOk: (e: GEdge) => boolean;
    stops: (e: GEdge) => boolean;
    roots: ReadonlySet<ID>;
    col: CollapseResult;
    unreached: Set<ID>;
    hideScen: boolean;
    sid: ID | null;
    focus: boolean;
    inProj: (pids: ID[]) => boolean;
  } | null = null;
  /** 範囲・折りたたみ・シナリオの推定の結果と、その材料（key: 索引の版・シナリオ・絞り込み。opens: 入口ごとの開いている所） */
  private collapseCache: (CollapseState & { key: string; opens: Set<ID>[] }) | null = null;

  constructor(
    private readonly store: Store,
    private readonly ui: UiState,
  ) {
    store.on("change", (info) => {
      if (!info.positionsOnly) {
        this.dirtyIndex = true;
        this.dirtyVis = true;
      } else this.dirtyPos = true;
      // 印を付けるだけ（数え直しは読まれたときに。作業メモ perf-4）
      this.engine.note(store.doc, info);
      if (info.full) this.useMapDoc();
      this.noteForecastInputs(info);
    });
    ui.on("visual", () => {
      this.dirtyVis = true;
    });
    this.useMapDoc();
    this.seeAll();
  }

  invalidate(): void {
    this.dirtyIndex = true;
    this.dirtyVis = true;
    this.forecastInputs++;
    this.engine.invalidate();
    this.useMapDoc();
    this.seeAll();
  }

  /** 同梱の地図を組み立てたままの文書なら、3 年の影響の形をその地図の列から作るようにエンジンに知らせる（src/app/futureCache.ts） */
  private useMapDoc(): void {
    const doc = this.store.doc;
    const map = mapDocOf(doc);
    if (map) this.engine.useMap({ map, doc });
  }

  /** 今の文書のノード・線を覚え直す（全部が入れ替わったとき） */
  private seeAll(): void {
    const doc = this.store.doc;
    this.seenNodes = new Map(Object.entries(doc.nodes));
    this.seenEdges = new Map(Object.entries(doc.edges));
  }

  /** 変わったノード・線の前と後を比べ、見込みに使う所が変わっていたら版を進める（題名だけなら題名の版） */
  private noteForecastInputs(info: ChangeInfo): void {
    if (info.full) {
      this.forecastInputs++;
      this.titleVersion++;
      this.seeAll();
      return;
    }
    const doc = this.store.doc;
    let hit = false;
    for (const id of info.nodes) {
      const before = this.seenNodes.get(id);
      const now = doc.nodes[id];
      if (!hit && forecastNodeChanged(before, now)) hit = true;
      if (before && now && before.title !== now.title) this.titleVersion++;
      if (now) this.seenNodes.set(id, now);
      else this.seenNodes.delete(id);
    }
    for (const id of info.edges) {
      const before = this.seenEdges.get(id);
      const now = doc.edges[id];
      if (!hit && forecastEdgeChanged(before, now)) hit = true;
      if (now) this.seenEdges.set(id, now);
      else this.seenEdges.delete(id);
    }
    if (hit) this.forecastInputs++;
  }

  private ensureIndex(): void {
    if (this.dirtyIndex) {
      this.index = buildIndex(this.store.doc);
      this.indexVersion++;
      this.dirtyIndex = false;
      this.dirtyVis = true;
    }
  }

  ensure(): void {
    this.ensureIndex();
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
      this.ensureIndex();
      this.forecastCache = this.titledEnds(computeForecast(doc, this.index.out, sid));
      this.forecastKey = key;
      this.forecastTitles = this.titleVersion;
      this.forecastStamp++;
    }
    return this.forecastCache;
  }

  /** 見込みの行き先の並びを、題名が変わったら読まれたときに並べ直す（computeForecast と同じ並べ方） */
  private titledEnds(fc: ForecastResult): ForecastResult {
    let ends = fc.ends;
    Object.defineProperty(fc, "ends", {
      enumerable: true,
      configurable: true,
      get: (): ID[] => {
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
      out: () => {
        this.ensureIndex();
        return this.index.out;
      },
      reach: () => {
        const fc = this.forecast;
        return { version: this.forecastStamp, of: (id) => fc.reach.get(id)?.p ?? 0 };
      },
    });
  }

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
    // 材料（索引・開いている所・絞り込み・シナリオ）が同じなら前の結果を使う（選択・検索・時点だけの変更では作り直さない）
    const info = this.scopeInfo();
    const opens = info.roots.map((r) => this.openSetOf(r, info));
    const key = `${this.indexVersion}|${sid ?? ""}|${hideScen ? "h" : ""}|${focus ? filter.join(",") : ""}`;
    let cs = this.collapseCache;
    if (!cs || cs.key !== key || cs.opens.length !== opens.length || cs.opens.some((s, i) => s !== opens[i])) {
      cs = this.collapseCache = { key, opens, ...this.collapseState(info, opens, { focus, hideScen, sid, inProj, edgeInScen }) };
    }
    const { scope, ghost, edgeOk, collapsedOf, stops, roots, branches, col, unreached } = cs;
    this.collapsedPred = collapsedOf;

    // 3) 検索
    const q = parseQuery(this.ui.search);
    this.searchActive = !isEmptyQuery(q);
    this.searchHits = this.searchActive ? searchNodes(doc, q) : [];
    const hitSet = new Set(this.searchHits.map((h) => h.id));

    this.last = { scope, edgeOk, stops, roots, col, unreached, hideScen, sid, focus, inProj };

    // 4) 経路（隠れているノードからは強調しない。シナリオで隠した推定の先も同じ）
    const shown = (id: ID) => scope.has(id) && !col.hidden.has(id) && !(hideScen && unreached.has(id));
    const selected = [...sel.nodes].filter(shown);
    this.pathActive = prefs.pathHighlight && selected.length > 0;
    const paths = this.pathActive ? computePaths(doc, idx, selected, (e) => edgeOk(e) && (!sid || edgeInScen(e)) && shown(e.source) && shown(e.target)) : null;
    // 3 年の分かれ道の選択肢を選んだときは、同じ判断のほかの選択肢（兄弟）とそこへの線も薄くしない（並べて比べられるように）
    const siblings = new Set<ID>();
    if (paths && info.roots.length) {
      for (const id of selected) {
        if (!info.owner.has(id)) continue;
        for (const eid of idx.inc.get(id) ?? []) {
          const e = doc.edges[eid];
          const d = e && doc.nodes[e.source];
          if (!e || !d || !isFlowEdge(e) || !info.owner.has(d.id)) continue;
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

    // 5) ノード
    this.nodes.clear();
    const draw: ID[] = [];
    const drawTop: ID[] = [];
    let hiddenCount = 0;
    /** 見えている 3 年の分かれ道のノード（重ねる位置を作る材料） */
    const visibleScope: ID[] = [];
    for (const id in doc.nodes) {
      const n = doc.nodes[id]!;
      const offScenario = sid !== null && (!inScenario(n.scenarioIds, sid) || unreached.has(id));
      const hidden = !scope.has(id) || col.hidden.has(id) || (hideScen && offScenario);
      const inProject = inProj(n.projectIds);
      const isGhost = ghost.has(id);
      let alpha = 1;
      if (hasFilter && !inProject) alpha = Math.min(alpha, isGhost ? 0.55 : 0.13);
      if (offScenario) alpha = Math.min(alpha, 0.22);
      const future = !!(cursor && n.time.due && n.time.due > cursor);
      if (future) alpha = Math.min(alpha, 0.18);
      const match = hitSet.has(id);
      if (this.searchActive && !match) alpha = Math.min(alpha, 0.14);
      const path = !!paths?.nodes.has(id);
      if (this.pathActive && !path && !siblings.has(id)) alpha = Math.min(alpha, 0.3);
      if (hidden) hiddenCount++;
      const inImpact = info.owner.has(id);
      const closed = inImpact ? collapsedOf(id) : n.collapsed;
      const collapsedCount = closed ? (col.counts.get(id) ?? 0) : 0;
      // 3 年の分かれ道は、閉じていて、同じ範囲の子（閉じると隠れる物）があるときだけ折りたたみの印を出す
      const collapsed = inImpact ? closed && branches.has(id) : n.collapsed;
      this.nodes.set(id, { hidden, alpha, match, path, ghost: isGhost, future, offScenario, collapsedCount, collapsed, inProject });
      if (!hidden) {
        (sel.nodes.has(id) ? drawTop : draw).push(id);
        if (inImpact) visibleScope.push(id);
      }
    }
    this.drawNodes = draw.concat(drawTop);
    this.hiddenCount = hiddenCount;

    // 6) 接続
    this.edges.clear();
    const edgesNormal: ID[] = [];
    const edgesTop: ID[] = [];
    const stubs: Array<{ id: ID; count: number }> = [];
    for (const id in doc.edges) {
      const e = doc.edges[id]!;
      const a = this.nodes.get(e.source);
      const b = this.nodes.get(e.target);
      const src = doc.nodes[e.source];
      const offScenario = sid !== null && !edgeInScen(e);
      const cross = idx.cross.has(id);
      // 元のノードの折りたたみで止まる線は描かない（3 年の分かれ道の閉じたカードは、同じ範囲の子への道の線だけ）
      const srcClosed = !!src && collapsedOf(src.id) && stops(e);
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
      if (e.collapsed && a && !a.hidden && !srcClosed && !(hideScen && offScenario)) stubs.push({ id, count: col.counts.get(id) ?? 0 });
    }
    this.drawEdges = edgesNormal.concat(edgesTop);
    this.stubEdges = stubs;

    // 7) 3 年の分かれ道の重ねる位置（開いている所・見えている物・索引が変わったときだけ並べ直す）
    this.updateOverlay(info, opens, visibleScope);
  }

  /** 範囲（シナリオで隠す・プロジェクトに絞る）と折りたたみ・シナリオの推定を計算する（compute が材料ごとに覚えておく） */
  private collapseState(info: ImpactScopeInfo, opens: Set<ID>[], o: { focus: boolean; hideScen: boolean; sid: ID | null; inProj: (pids: ID[]) => boolean; edgeInScen: (e: GEdge) => boolean }): CollapseState {
    const doc = this.store.doc;
    const idx = this.index;
    const { focus, hideScen, sid, inProj, edgeInScen } = o;

    // 1) 範囲（シナリオで隠す・プロジェクトに絞る）
    const scope = new Set<ID>();
    for (const id in doc.nodes) {
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
    const openOf = new Map(info.roots.map((r, i) => [r, opens[i]!]));
    const collapsedOf = info.roots.length
      ? (id: ID): boolean => {
          const r = info.owner.get(id);
          return r !== undefined ? !openOf.get(r)!.has(id) : !!doc.nodes[id]?.collapsed;
        }
      : (id: ID): boolean => !!doc.nodes[id]?.collapsed;
    // 3 年の分かれ道の閉じたカードが止めるのは、同じ範囲の子への道の線だけ（ほかの関係の線・範囲の外へ出る線の先は隠さない）
    const stops = (e: GEdge): boolean => {
      const r = info.owner.get(e.source);
      return r === undefined || (isFlowEdge(e) && info.owner.get(e.target) === r);
    };
    // 3 年の分かれ道の入口は必ず入口にする（カードから今日へ戻る線を引いても、地図ごと消えない）
    const roots = new Set(info.roots.filter((r) => info.owner.get(r) === r));
    const branches = new Set<ID>();
    for (const id of info.owner.keys()) {
      for (const eid of idx.out.get(id) ?? []) {
        const e = doc.edges[eid];
        if (e && e.source !== e.target && stops(e)) {
          branches.add(id);
          break;
        }
      }
    }
    const col = computeCollapse(doc, idx, scope, edgeOk, collapsedOf, { stops, roots });
    const unreached = sid ? computeUnreached(doc, idx, scope, edgeInScen, roots) : new Set<ID>();
    return { scope, ghost, edgeOk, collapsedOf, stops, roots, branches, col, unreached };
  }

  // ------------------------------------------------------------ 3 年の分かれ道（開く・閉じる・重ねる位置）

  /** 3 年の分かれ道の範囲と入口（索引が変わったときだけ作り直す） */
  private scopeInfo(): ImpactScopeInfo {
    this.ensureIndex();
    const c = this.scopeCache;
    if (c && c.index === this.indexVersion) return c;
    const doc = this.store.doc;
    const out = this.index.out;
    const roots = Object.keys(doc.nodes)
      .filter((id) => isImpactRoot(doc.nodes[id]))
      .sort();
    const owner = new Map<ID, ID>();
    const depth = new Map<ID, number>();
    for (const r of roots) {
      if (owner.has(r)) continue;
      owner.set(r, r);
      depth.set(r, 0);
      // 幅優先（いちばん短い歩数を列の深さに）
      const queue = [r];
      for (let i = 0; i < queue.length; i++) {
        const id = queue[i]!;
        for (const e of flowOuts(doc, out, id)) {
          if (owner.has(e.target)) continue;
          owner.set(e.target, r);
          depth.set(e.target, depth.get(id)! + 1);
          queue.push(e.target);
        }
      }
    }
    const info = { index: this.indexVersion, roots, owner, depth };
    this.scopeCache = info;
    return info;
  }

  /** そのノードの先（道の線でつながる子。範囲の中で同じ入口の物。線の順） */
  private impactKids(id: ID, info: ImpactScopeInfo): ID[] {
    const doc = this.store.doc;
    const r = info.owner.get(id);
    const list: ID[] = [];
    for (const eid of this.index.out.get(id) ?? []) {
      const e = doc.edges[eid];
      if (!e || e.source === e.target || !isFlowEdge(e) || info.owner.get(e.target) !== r || list.includes(e.target)) continue;
      list.push(e.target);
    }
    return list;
  }

  /** 入口の「開いているノード」。保存してあればそれ、無ければ最初の形（狭い画面は今日だけ・広い画面は今日と選択肢） */
  private openSetOf(root: ID, info: ImpactScopeInfo): Set<ID> {
    const src = this.ui.prefs.impactOpen[root];
    const c = this.openCache.get(root);
    if (c && c.src === src && (src !== undefined || c.index === info.index)) return c.set;
    let set: Set<ID>;
    if (src) set = new Set(src);
    else {
      let narrow = this.narrowDefault.get(root);
      if (narrow === undefined) this.narrowDefault.set(root, (narrow = this.narrow()));
      set = new Set([root]);
      if (!narrow) for (const k of this.impactKids(root, info)) set.add(k);
    }
    this.openCache.set(root, { src, index: info.index, set });
    return set;
  }

  /** 3 年の分かれ道の範囲のノードか */
  inImpact(id: ID): boolean {
    return this.scopeInfo().owner.has(id);
  }

  /** 3 年の分かれ道の入口（ID の順） */
  impactRoots(): ID[] {
    return this.scopeInfo().roots;
  }

  /** 3 年の分かれ道で開いているか（範囲の外は文書の collapsed の逆） */
  isOpen(id: ID): boolean {
    const info = this.scopeInfo();
    const r = info.owner.get(id);
    if (r === undefined) return !this.store.doc.nodes[id]?.collapsed;
    return this.openSetOf(r, info).has(id);
  }

  /**
   * 折りたたんでいるか（右クリックのメニューの「展開する／この先を折りたたむ」・C で決める向き）。
   * 3 年の分かれ道は見え方で閉じていて、同じ範囲の子（閉じると隠れる物）がある物、それ以外は文書の collapsed
   */
  isCollapsed(id: ID): boolean {
    const info = this.scopeInfo();
    if (!info.owner.has(id)) return !!this.store.doc.nodes[id]?.collapsed;
    return !this.isOpen(id) && this.impactKids(id, info).length > 0;
  }

  /**
   * 開く・閉じる物があるか（折りたたみの印・C・右クリックのメニュー・詳細のボタンで同じ決まり）。
   * 3 年の分かれ道は同じ範囲の子（道の線の先。閉じると隠れる物）があるか。相乗効果などの線や、範囲の外へ出る線だけでは開閉しない。
   * それ以外のノードは出る線があるか
   */
  canCollapse(id: ID): boolean {
    const info = this.scopeInfo();
    if (info.owner.has(id)) return this.impactKids(id, info).length > 0;
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
    const get = (r: ID) => {
      let s = next.get(r);
      if (!s) next.set(r, (s = new Set(this.openSetOf(r, info))));
      return s;
    };
    let changed = false;
    for (const id of open) {
      const r = info.owner.get(id);
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
      const r = info.owner.get(id);
      if (r === undefined) continue;
      if (get(r).delete(id)) changed = true;
    }
    if (!changed) return false;
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
    for (const id of info.owner.keys()) if (this.impactKids(id, info).length > 0) out.push(id);
    return out;
  }

  /**
   * 3 年の分かれ道で、閉じた所の中に隠れているノードを出すために上流を開く（見え方だけ）。開いたら true。
   * 絞り込み・シナリオ・文書の折りたたみで隠れている分はそのまま（それは revealNode が決める）
   */
  openPathTo(id: ID): boolean {
    if (!this.inImpact(id) || !this.node(id).hidden) return false;
    const open = this.collapseBlockers(id).open;
    return open.length > 0 && this.setImpactOpen(open);
  }

  /** 開いた・閉じた・見え方が変わったときに、重ねる位置を並べ直す（材料が同じなら並べ直さない） */
  private updateOverlay(info: ImpactScopeInfo, opens: Set<ID>[], visible: ID[]): void {
    if (!info.roots.length) {
      if (this.overlayRel.size) (this.overlayRel.clear(), this.overlayAbs.clear());
      this.overlayKey = null;
      return;
    }
    const k = this.overlayKey;
    if (k && k.index === this.indexVersion && k.opens.length === opens.length && k.opens.every((s, i) => s === opens[i]) && k.visible.length === visible.length && k.visible.every((id, i) => id === visible[i])) return;
    this.overlayKey = { index: this.indexVersion, opens, visible };
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
      const mine = visible.filter((id) => info.owner.get(id) === r);
      if (!mine.length) return;
      // 入口が隠れている（絞り込みなど）ときは、入口の行だけ空けて、見えている物を下に並べる
      const rootKids = shown.has(r) ? kids : () => [];
      let pos = outlineLayout(r, rootKids);
      // 入口からたどれないが見えているノード（別の線でだけ見えている物など）は、入口の木の下に、その深さの列で並べる
      const rest = mine.filter((id) => !pos.has(id));
      if (rest.length) {
        rest.sort((a, b) => info.depth.get(a)! - info.depth.get(b)! || compareImpactKids(doc.nodes[a]!, doc.nodes[b]!));
        pos = outlineLayout(
          r,
          rootKids,
          rest.map((id) => [id, info.depth.get(id)!] as const),
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
    const scenario = l.hideScen && (!inScenario(n.scenarioIds, l.sid) || l.unreached.has(id));
    const focus = l.focus && !l.scope.has(id) && !l.inProj(n.projectIds);
    return { focus, scenario, collapse: l.scope.has(id) && l.col.hidden.has(id) };
  }

  /**
   * 折りたたみで隠れたノードを出すために開く物（上流の折りたたんだノードと接続）。
   * 隠れた上流を逆にたどり、そこへ入る線を止めている折りたたみを開く。開くと入口が変わることがあるので、見えるまで確かめ直す。
   * nodes・edges は文書の折りたたみ（開くのは文書の変更）、open は 3 年の分かれ道の閉じたノード（開くのは見え方だけ）
   */
  collapseBlockers(id: ID): { nodes: ID[]; edges: ID[]; open: ID[] } {
    this.ensure();
    const l = this.last;
    const openN = new Set<ID>();
    const openE = new Set<ID>();
    const openV = new Set<ID>();
    if (!l || !l.scope.has(id) || !l.col.hidden.has(id)) return { nodes: [], edges: [], open: [] };
    const info = this.scopeInfo();
    const base = this.collapsedPred;
    const closed = (u: ID): boolean => base(u) && !(info.owner.has(u) ? openV : openN).has(u);
    let sim: DocData = this.store.doc;
    let col = l.col;
    for (let round = 0; round < 8 && col.hidden.has(id); round++) {
      const region = new Set<ID>([id]);
      const stack: ID[] = [id];
      while (stack.length) {
        const v = stack.pop()!;
        for (const eid of this.index.inc.get(v) ?? []) {
          const e = sim.edges[eid];
          if (!e || e.source === e.target || !l.scope.has(e.source) || !l.edgeOk(e)) continue;
          // 開くのは、この線を止めている折りたたみだけ（3 年の分かれ道の閉じたカードは、同じ範囲の子への道の線だけを止める）
          if (closed(e.source) && l.stops(e)) (info.owner.has(e.source) ? openV : openN).add(e.source);
          if (e.collapsed) openE.add(eid);
          if (col.hidden.has(e.source) && !region.has(e.source)) {
            region.add(e.source);
            stack.push(e.source);
          }
        }
      }
      if (openE.size) {
        sim = { ...sim, edges: { ...sim.edges } };
        for (const e of openE) sim.edges[e] = { ...sim.edges[e]!, collapsed: false };
      }
      col = computeCollapse(sim, this.index, l.scope, l.edgeOk, closed, { stops: l.stops, roots: l.roots });
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
      const n = this.overlayAbs.get(id) ?? (info.owner.has(id) ? undefined : doc.nodes[id]);
      if (!n) continue;
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    }
    if (minX === Infinity) return null;
    return { minX, minY, maxX, maxY };
  }
}
