// 3 か月ごとの地図（版 7）の見取り図・手の詳しい画面・道の画面（src/deepmap/views）と、カードの組み立てた本文に渡す物を、
// アプリの文書から作る所。設計: 作業メモ SPEC v1 §5・§4.4（見直し user-1〜user-7・user-12〜user-15・safety-10）
//
//   地図         ページに入れた 3 か月ごとの地図（src/demo/pageBundle.ts。組み立てたままの文書なら src/app/futureCache.ts の物）が、
//                文書の 3 年の分かれ道と同じ物のとき（入口のカードの ID が地図の今日の鍵の ID で、版の指紋 futureVersion が地図の指紋）
//   計算の芯     地図を 1 回だけ型付き配列に組み直す（3 年の影響のエンジンが地図の列から形を作っていれば、その組み直しを使う）
//   選んだ手     地図の番号ごとの 選んだ・見送った（エンジンが地図の列から形を作っていればエンジンの物、そうでなければ文書から読む）
//   方針         数は方針（シナリオ）で絞らない（SPEC §5.11。方針の外の手は、キャンバスとパネルで薄くするだけ）
//   年収         3 年の影響の年収（入口の meta.impact.annual）
//   文章         文章の組み立て（src/demo/compose）。カードごと・年収ごとに 1 回だけ、読まれたときに組み立てる（全部を先に組み立てない）
//   資産のゴール 入口の meta.goal（10 億円の前提）で、計算ごとの goalBase と設定ごとの goalOf を読む（ctx.goal()）。前提を変えても
//                計算（analyze・overview）はやり直さない（鍵 calcKey に入れない。読むたびに入口の meta.goal を見る）
// 文書の形や数を書き換えた後（自分で足したカード・書き換えた見込み）も、見取り図と道は地図の元の数で出す（edited。画面がそう書く）。
// どれも読まれたときに作り、材料（地図・形と数の版・年収・選んだ手の版）が同じなら前の物を返す（変更のたびには作らない: 作業メモ perf-4）

import { analyze, goalBase, goalOf, overview, textRuntime, type Analysis, type CompiledMap, type GoalBase, type GoalSummary, type Overview, type TextSource } from "../deepmap/core";
import { ym } from "../deepmap/views/format";
import { F_STUB, ROLE_A } from "../deepmap/core/compile";
import type { MapData } from "../deepmap/mapData";
import { composeCard, materializeBody, type Card, type ComposeRuntime } from "../demo/compose";
import { impactNodeId64 } from "../demo/impact";
import { quarterIdIndex, quarterIdTable } from "../demo/quarterIds";
import { loadPageMap, PAGE_Q, pageMapIfLoaded } from "../demo/pageBundle";
import { goalAnchor, tablesFor, type GoalRead, type GoalTables } from "../model/goal";
import { compiledMapOf, statusCode } from "../model/impactGraph";
import type { DocData, GEdge, GNode, ID } from "../model/types";
import { edgeProb } from "../model/forecast";
import { chanceWeights, goalConfigOf, isFlowEdge } from "../model/forks";
import { Emitter } from "../store/emitter";
import type { Store } from "../store/store";
import { mapOfBuiltDoc } from "./futureCache";
import { idleSteps } from "./idle";
import type { UiState } from "./uiState";
import type { ViewModel } from "./viewModel";

/** 組み立てた文章の入口（見取り図・道の画面の TextSource に、やることとカードの全部を足した物） */
export interface DeepText extends TextSource {
  /** カード i の組み立てた文章（題・短い名前・本文・数の行・やること） */
  card(i: number): Card;
}

/** 文章の組み立てを、カードごと・年収ごとに 1 回だけ（読まれたときに）。年収が変わったら作り直す（題は年収で変わらない） */
const textMemo = new WeakMap<MapData, { annual: number; text: DeepText }>();
/** 画面と同じ計算で組み立てた文章（計算ごと。おすすめ・3 年の値を、その年収と選んだ手の計算から書く） */
const textMemoA = new WeakMap<Analysis, DeepText>();
/** アプリの画面の本文（手を文書のカードの題で呼ぶ: DeepCtx.text）。計算ごとに、題の版と ID の並びが同じ間だけ */
const ownTextMemo = new WeakMap<Analysis, { stamp: number; ids: readonly ID[]; memo: Map<number, Card> }>();

/**
 * 組み立てた文章。a はその年収の画面と同じ計算（あれば、本文の「おすすめ」「一番の手」と 3 年の値をその計算で書く。無ければ地図に
 * 書いた年収の値で書き、年収が違えば「年収 360 万円の見積もりで…」とぼかす。画面の札と食い違うので、アプリの画面は a を渡す: 見直し R4）
 */
export function deepText(map: MapData, annual: number, a?: Analysis): DeepText {
  if (a) {
    const hit = textMemoA.get(a);
    if (hit) return hit;
  } else {
    const m = textMemo.get(map);
    if (m && m.annual === annual) return m.text;
  }
  const rt = a ? textRuntime(a) : undefined;
  const memo = new Map<number, Card>();
  const card = (i: number): Card => {
    let c = memo.get(i);
    if (!c) memo.set(i, (c = composeCard(map, i, rt ? { annual, rt } : { annual })));
    return c;
  };
  // provisional は付けない（「文章は仮」の印を出さない）
  const text: DeepText = { title: (i) => card(i).title, short: (i) => card(i).short, body: (i) => card(i).body, numbers: (i) => card(i).numbers, card };
  if (a) textMemoA.set(a, text);
  else textMemo.set(map, { annual, text });
  return text;
}

/**
 * 書き換えた見込みで組み立てたカード i の文章（見直し R6: 「つながり」の線の見込みを書き換えても、組み立てた本文が地図の元の見込みを
 * 言い続けていた）。結果の見込みは文書の線の見込みを兄弟の合計で割った物（「つながり」のかっこの中の、数えている見込みと同じ）。
 * 本文が読んだ見込みがどれも地図と同じなら null（ふつうの組み立てた文章を使う）。お金の数は地図の元の数のまま（見取り図と道と同じ）
 */
export function cardWithDocOdds(ctx: DeepCtx, doc: DocData, out: ReadonlyMap<ID, readonly ID[]>, i: number): Card | null {
  const map = ctx.map;
  const memo = new Map<number, number>();
  let differs = false;
  const pOf = (o: number): number => {
    const hit = memo.get(o);
    if (hit !== undefined) return hit;
    const base = map.p(o);
    let v = base;
    const par = o > 0 ? map.parent(o) : -1;
    const role = map.role(o);
    // 見込みがあるのは結果（状態・行き先）だけ。手（判断の子）と今日は地図のまま
    if (par >= 0 && (role === "s" || role === "e")) {
      const pid = ctx.idOf(par);
      const id = ctx.idOf(o);
      if (doc.nodes[pid] && doc.nodes[id]) {
        const sibs: GEdge[] = [];
        for (const eid of out.get(pid) ?? []) {
          const e = doc.edges[eid];
          if (e && isFlowEdge(e) && e.source !== e.target && doc.nodes[e.target]) sibs.push(e);
        }
        const j = sibs.findIndex((e) => e.target === id);
        // 兄弟のどれかの見込みを書き換えた（地図の見込みと違う・地図に無い線に見込みがある）ときだけ、文書の見込みで数える
        const same = sibs.every((e) => {
          const k = ctx.indexOf(e.target);
          return k >= 0 && map.parent(k) === par ? edgeProb(e) === map.p(k) : edgeProb(e) === null;
        });
        if (j >= 0 && !same) v = Math.round(chanceWeights(sibs)[j]! * 100);
      }
    }
    if (v !== base) differs = true;
    memo.set(o, v);
    return v;
  };
  // 先に、本文が見込みを言う近くの結果（今日からのカードの道の上の判断の結果・このカードの子と孫）を確かめる。どれも地図のままなら
  // 組み立て直さない（形を変えた文書では選ぶたびに来る。組み立て直しは道の覚えから作るので重い）
  const near: number[] = [];
  for (let x = i; x >= 0; x = x > 0 ? map.parent(x) : -1) {
    near.push(x);
    if (x === 0) break;
  }
  const kids = (x: number): number[] => Array.from({ length: map.childCount(x) }, (_, k) => map.child(x, k));
  const fams = new Set<number>(near);
  for (const c of kids(i)) fams.add(c);
  for (const f of fams) for (const c of kids(f)) pOf(c);
  if (!differs) return null;
  const view: MapData = Object.create(map, { p: { value: pOf } });
  const card = composeCard(view, i, { annual: ctx.annual, rt: { ...textRuntime(ctx.analysis()), title: (x) => ctx.ownTitle(x) } });
  return card;
}

/** 資産のゴールの数（入口の meta.goal の設定で。どれも 36 か月目より先は目安） */
export interface DeepGoal {
  /** 設定（入れていない鍵は仮の値。assumed に入る） */
  readonly read: GoalRead;
  /** 年ごとの係数（地図の 0 か月目から） */
  readonly tables: GoalTables;
  /** 設定によらない物（計算ごとに 1 つ） */
  readonly base: GoalBase;
  /** 今日の手ごと・おすすめ・ずっと今のままの数 */
  readonly summary: GoalSummary;
}

/** 文書の 3 年の分かれ道が同梱の地図のとき、画面に渡す物 */
export interface DeepCtx {
  readonly map: MapData;
  readonly cm: CompiledMap;
  /** 入口（今日）のカードの ID */
  readonly root: ID;
  readonly annual: number;
  /** 形か数を書き換えた（自分で足したカード・書き換えた見込み）。見取り図と道は地図の元の数で出す */
  readonly edited: boolean;
  /** 方針（シナリオ）を選んでいる（数は絞らない） */
  readonly scenario: string | null;
  /** 計算（選んだ手・見送った手を入れた、おすすめの選び方とずっと今のまま） */
  analysis(): Analysis;
  overview(): Overview;
  /**
   * 資産のゴールの数（入口の meta.goal を読むたびに見る。前提だけを変えたときは計算をやり直さず、設定ごとの数だけ作る。
   * 同じ計算・同じ meta.goal なら同じ物）
   */
  goal(): DeepGoal;
  /**
   * 文章（道の画面・行き先の名前）。題名と短い名前は文書のカードの物（キャンバス・詳細・検索と同じ名前。書き換えればそれが出る）。
   * 地図の題名を書いていない「—」・空の物だけ、組み立てた名前（作業メモ SPEC v1 §4.3・見直し equiv-4）。本文と数の行は組み立てた物
   */
  text(): DeepText;
  /**
   * 地図の番号 i のカードの、文書のカードの題（利用者が書き換えた名前。無い・仮の物は null）。組み立てた本文が手をこの名前で呼ぶ
   * （見取り図・同じ判断の手・キャンバスと同じ名前: P4 の見直し reader-1）
   */
  ownTitle(i: number): string | null;
  /** 地図の番号 i のカードの年月（「2027 年 2 月」）と親のカードの番号（今日は −1）。パネルの行・検索の行に使う（見直し user-6・gaps-11） */
  place(i: number): { ym: string; parent: number };
  /** 文書のカードの地図の番号（地図のカードでなければ −1） */
  indexOf(id: ID): number;
  /** 地図の番号のカードの ID */
  idOf(i: number): ID;
  /**
   * 自分で選んだ手の中に、選び方の道の上のまとめた手（この先は標準の続きの見積もり）がある（3 年の稼ぎと分布は、その先が
   * 標準の続きの平均になる: 作業メモ SPEC v1 §5.12・user-20）
   */
  pickedSummary(): boolean;
}

interface Built {
  key: string;
  ctx: DeepCtx;
}

/** 計算（地図の版・年収・選んだ手が同じなら同じ）。シナリオ・編集の有無だけが変わったときは数え直さない */
interface Calc {
  key: string;
  a: Analysis | null;
  ov: Overview | null;
}

/**
 * 地図の番号ごとのカードの ID（鍵の 64 ビットの指紋。地図ごとに 1 回だけ。buildQuarterDoc と同じ ID）。組み立て・保存の基準と同じ表
 * （../demo/quarterIds.ts: 起動で 7.7 万の鍵の指紋と表を、ここでもう 1 つ作らない。見直し perf-1・perf-7）。書き換えない
 */
function idsOf(map: MapData): readonly ID[] {
  return quarterIdTable(map).node;
}

/** ID → 地図の番号（get・has だけ） */
interface IdRev {
  get(id: ID): number | undefined;
  has(id: ID): boolean;
}

/** ノードの ID → 地図の番号（地図ごとに 1 つ。保存の基準と同じ表） */
function revOf(map: MapData): IdRev {
  return quarterIdIndex(map);
}

/**
 * 文書ごとの ID → 番号: 鍵の指紋と違う ID の番号だけを表に持ち、ほかは地図ごとの表（base）で引く（同じ ID が 2 つあれば後の番号:
 * 前の Map と同じ）。7.7 万の表をもう 1 つ作らない。関数の外で作る（中で作ると、閉じた所が前の表や文書をつかんだままになる）
 */
function overRev(ids: readonly ID[], hashed: readonly ID[], base: IdRev): IdRev {
  const over = new Map<ID, number>();
  for (let i = 0; i < ids.length; i++) if (ids[i] !== hashed[i]) over.set(ids[i]!, i);
  const get = (id: ID): number | undefined => {
    const o = over.get(id);
    const j = base.get(id);
    const b = j !== undefined && ids[j] === id ? j : undefined;
    return o === undefined ? b : b === undefined || o > b ? o : b;
  };
  return { get, has: (id) => get(id) !== undefined };
}

/** 題名が仮の物（地図の題名を書いていない行き先の「—」・空）か */
const placeholderTitle = (t: string | undefined): boolean => !t || !t.trim() || /^[—―\-－]+$/.test(t.trim());

/**
 * 選んだ手も見送った手も無いときの計算（地図と年収ごとに 1 つ。起動の前に見取り図だけ先に描いたとき（src/ui/deepSplash.ts）の物を、
 * アプリの画面でもそのまま使う）
 */
const plainMemo = new WeakMap<CompiledMap, { annual: number; a: Analysis; ov: Overview | null }>();

/** 選んだ手も見送った手も無いときの計算（覚えた物があればそれ） */
export function plainAnalysis(cm: CompiledMap, annual: number): Analysis {
  const m = plainMemo.get(cm);
  if (m && m.annual === annual) return m.a;
  const a = analyze(cm, annual, {});
  plainMemo.set(cm, { annual, a, ov: null });
  return a;
}

/**
 * 選んだ手・見送った手のある計算（地図ごとに最後の 1 つを覚える。起動の前に見取り図だけ先に描いたとき、保存してあった選んだ手で数えた物を、
 * アプリの画面でもそのまま使う: 同じ地図・年収・選んだ手の並びなら数え直さない。見直し perf-1）
 */
const statusMemo = new WeakMap<CompiledMap, { annual: number; status: Uint8Array; a: Analysis; ov: Overview | null }>();

/** 2 つの配列が同じ中身か */
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/** 選んだ手・見送った手（地図の番号ごと: statusCode）での計算。どれも 0 なら plainAnalysis */
export function statusAnalysis(cm: CompiledMap, annual: number, status: Uint8Array): Analysis {
  if (isZero(status)) return plainAnalysis(cm, annual);
  const m = statusMemo.get(cm);
  if (m && m.annual === annual && sameBytes(m.status, status)) return m.a;
  const a = analyze(cm, annual, { status });
  statusMemo.set(cm, { annual, status: status.slice(), a, ov: null });
  return a;
}

/** その計算の見取り図の数（plainAnalysis・statusAnalysis の物なら覚える） */
export function plainOverview(cm: CompiledMap, a: Analysis): Overview {
  const m = plainMemo.get(cm);
  if (m && m.a === a) return (m.ov ??= overview(a));
  const sm = statusMemo.get(cm);
  if (sm && sm.a === a) return (sm.ov ??= overview(a));
  return overview(a);
}

const isZero = (arr: Uint8Array): boolean => {
  for (let i = 0; i < arr.length; i++) if (arr[i]) return false;
  return true;
};

/** 選んだ手・見送った手を、文書から地図の番号ごとに読む（手のカードだけ） */
function statusFromDoc(doc: DocData, cm: CompiledMap, ids: readonly ID[]): Uint8Array {
  const out = new Uint8Array(cm.n);
  const role = cm.role;
  for (let i = 0; i < cm.n; i++) if (role[i] === ROLE_A) out[i] = statusCode(doc.nodes[ids[i]!] as GNode | undefined);
  return out;
}

export class DeepState {
  /** ページに入れた地図（読み込んだら） */
  private loaded: MapData | null = null;
  private loading = false;
  private built: Built | null = null;
  private calc: Calc | null = null;
  private status: { key: string; doc: DocData; arr: Uint8Array } | null = null;
  /** 選んだ手の配列を作り直した回数（画面に渡す物の鍵。同じ版の鍵でも配列が替われば作り直す） */
  private statusStamp = 0;
  private readonly emitter = new Emitter<{ ready: void }>();
  /**
   * かかった時間（確かめ用。ms）: 計算（analyze）・見取り図の数（overview）・資産のゴールの設定ごとの数（goal）・画面（見取り図・ページ・
   * カードの詳細の地図の部分）
   */
  readonly timings: Record<string, number> = {};

  constructor(
    private readonly vm: ViewModel,
    private readonly store: Store,
    private readonly ui: UiState,
  ) {
    // 文書ごとの番号 → ID の表を、変わったカードだけで確かめるための印（形が変わるたびに 7 万枚を読み直さない: 見直し perf-3）
    store.on("change", (info) => {
      if (!this.docIds) return;
      if (info.full) this.idsFull = true;
      else if (!this.idsFull) for (const id of info.nodes) this.idsTouched.add(id);
    });
  }

  /** 表を作った後に変わったカード（全部の入れ替えがあれば idsFull） */
  private readonly idsTouched = new Set<ID>();
  private idsFull = false;

  /** 地図を読み終えた（画面が見取り図を出し直す） */
  onReady(fn: () => void): () => void {
    return this.emitter.on("ready", fn);
  }

  /** 先に済ませる仕事を待っている */
  private prewarmQueued = false;

  /**
   * 文書が変わった後（手を選んだ・見送った・元に戻した・年収 など）: 見取り図の計算と数、おすすめの値を、空いた時間に 1 つずつ先に
   * 済ませる（カードの詳細から概要に戻ったとき、その場で 8 万枚を数え直さない: 見直し perf-6）。同じ材料なら覚えた物を使うので、
   * 題名の 1 文字などでは何もしない
   */
  prewarmSoon(): void {
    if (this.prewarmQueued) return;
    this.prewarmQueued = true;
    let k = 0;
    idleSteps(
      () => {
        if (k === 0) this.prewarmQueued = false;
        const ctx = this.get();
        if (!ctx) return true;
        if (k === 0) ctx.analysis();
        else if (k === 1) ctx.overview();
        // 資産のゴール: 設定によらない物（行き先を 1 回なめる）と、今の設定の数を 1 歩ずつ（見取り図の帯を空いた時間に埋める）
        else if (k === 2) goalBase(ctx.analysis());
        else if (k === 3) ctx.goal();
        else {
          // おすすめの値は 1 回の逆にたどる計算を分けて、空いた時間の 1 歩ずつ（perf-10）
          const imp = this.vm.impact;
          if (!imp.active || !imp.hasPicks) return true;
          if (imp.recommendedStep) return imp.recommendedStep();
          imp.recommended();
          return true;
        }
        k++;
        return false;
      },
      () => true,
      2000,
    );
  }

  /** ページに入れた地図を読む（ページに入っていなければ何もしない。1 度だけ） */
  private load(): void {
    if (this.loading || !PAGE_Q) return;
    this.loading = true;
    void loadPageMap().then(
      (m) => {
        this.loaded = m;
        if (m) this.emitter.emit("ready", undefined);
      },
      () => undefined,
    );
  }

  /**
   * 文書の 3 年の分かれ道の入口が、その地図の今日か（今日の鍵と版の指紋）。今日の ID は鍵の指紋の ID とは限らない
   * （版 6 から引き上げた地図・ID を引き継いで取り込んだ地図は、前の ID のまま: W-store の §2.3）
   */
  private matches(map: MapData, doc: DocData, root: ID): boolean {
    const n = doc.nodes[root];
    if (!n || n.meta?.futureVersion !== map.header.hash || n.meta?.futureRelease !== map.header.release) return false;
    return n.meta?.key === map.key(0);
  }

  /** 文書ごとの、地図の番号 → カードの ID の表と、その逆（鍵の指紋と違う ID の文書だけ。文書の入れ物と形の版ごとに作る） */
  private docIds: { map: MapData; nodes: DocData["nodes"]; topo: number; ids: ID[]; rev: IdRev } | null = null;
  /** 表を作り直した回数（作り直したら画面に渡す物も作り直す） */
  private idStamp = 0;

  /**
   * 地図の番号 → 文書のカードの ID。今日が鍵の指紋の ID なら、どのカードも鍵の指紋の ID（地図ごとの表）。
   * そうでなければ（版 6 から引き上げた・ID を引き継いだ地図）、文書の鍵から表を作る（形が変わったときだけ）
   */
  private idTable(doc: DocData, map: MapData): { ids: readonly ID[]; rev(): IdRev; hashed: boolean } {
    // 今日が鍵の指紋の ID: 地図ごとの表（組み立て・保存の基準と同じ物）
    const hashed = idsOf(map);
    if (doc.nodes[hashed[0]!]?.meta?.key === map.key(0)) return { ids: hashed, rev: () => revOf(map), hashed: true };
    const topo = this.vm.index.version.topo;
    const c = this.docIds;
    if (c && c.map === map && c.nodes === doc.nodes && c.topo === topo) return { ids: c.ids, rev: () => c.rev, hashed: false };
    // 形が変わっただけで、地図のカード（鍵のあるカード・表にあるカード）を足しも消しもしていない（Tab で足した子・線・その元に戻す）:
    // 表はそのまま使う（変わったカードだけを見る）
    if (c && c.map === map && c.nodes === doc.nodes && !this.idsFull) {
      let same = true;
      for (const id of this.idsTouched) {
        if (c.rev.has(id) || typeof doc.nodes[id]?.meta?.key === "string") {
          same = false;
          break;
        }
      }
      this.idsTouched.clear();
      if (same) {
        c.topo = topo;
        return { ids: c.ids, rev: () => c.rev, hashed: false };
      }
    }
    this.idsTouched.clear();
    this.idsFull = false;
    // 多くのカードは鍵の指紋の ID のまま（引き上げで前の ID を引き継いだカードだけが違う）: まず番号ごとに鍵の指紋の ID を引き、
    // 見つからない番号だけを、鍵の指紋でない ID のカードの鍵から埋める（7 万の鍵を表で引かない）
    const ids = hashed.slice();
    const seen = new Uint8Array(map.n);
    let unseen = 0;
    const keys = quarterIdTable(map).keys;
    for (let i = 0; i < map.n; i++) {
      const n = doc.nodes[hashed[i]!];
      if (n && n.meta?.key === keys[i]) seen[i] = 1;
      else unseen++;
    }
    // どの番号も鍵の指紋の ID で見つかったなら、下で全体を見ても何も変わらないので見ない。鍵の指紋の ID で見つかったカードは飛ばす
    // （前は見つかった ID の集まりを作っていた: 7 万の ID を入れずに、地図ごとの表で引く）
    const base = revOf(map);
    if (unseen > 0) {
      // 全体を見てよい: ID が鍵の指紋と違う地図（版 6 から引き上げた地図など）で、文書の形が変わったときに 1 回
      for (const id in doc.nodes) {
        const j = base.get(id);
        if (j !== undefined && seen[j]) continue;
        const k = doc.nodes[id]!.meta?.key;
        if (typeof k !== "string") continue;
        const i = map.indexOfKey(k);
        if (i < 0 || seen[i]) continue;
        seen[i] = 1;
        ids[i] = id;
      }
    }
    const rev = overRev(ids, hashed, base);
    this.docIds = { map, nodes: doc.nodes, topo, ids, rev };
    this.idStamp++;
    return { ids, rev: () => rev, hashed: false };
  }

  /** 文書の地図（無ければ null）。ページに入っていれば読み込みを始める */
  private mapOf(doc: DocData, root: ID): MapData | null {
    // 組み立てた地図（形を書き換えた後でも同じ地図: 入口は鍵と版で確かめる）
    const reg = mapOfBuiltDoc(doc);
    if (reg && this.matches(reg, doc, root)) return reg;
    if (!this.loaded) {
      const r = doc.nodes[root];
      if (!r || typeof r.meta?.anchor !== "string") return null;
      // 3 か月ごとの地図（入口に地図の年月がある）なら、ページに入れた地図を読む。もう読み終えていれば（保存してあった物を読むときに読んだ）
      // そのまま使う（読み終えた知らせは出さない: 呼んだ所が今作っている。画面を 2 度作らない）
      const ready = PAGE_Q ? pageMapIfLoaded() : null;
      if (!ready) {
        this.load();
        return null;
      }
      this.loaded = ready;
      this.loading = true;
    }
    return this.matches(this.loaded, doc, this.root(doc) ?? root) ? this.loaded : null;
  }

  private root(doc: DocData): ID | null {
    const imp = this.vm.impact;
    return imp.active && imp.root && doc.nodes[imp.root] ? imp.root : null;
  }

  /** 計算の芯（地図ごとに 1 回だけ。3 年の影響のエンジンが地図の列から形を作るときと同じ物: compiledMapOf） */
  private cmOf(map: MapData): CompiledMap {
    const t = this.vm.engine.graph.topo;
    if (t && t.map === map && t.cm) return t.cm;
    return compiledMapOf(map);
  }

  /** 今の文書の地図の画面に渡す物（3 か月ごとの地図でなければ null） */
  get(): DeepCtx | null {
    const vm = this.vm;
    const doc = this.store.doc;
    const imp = vm.impact;
    const root = imp.active ? imp.root : null;
    if (!root || !doc.nodes[root]) {
      this.built = null;
      return null;
    }
    const map = this.mapOf(doc, root);
    if (!map) {
      this.built = null;
      return null;
    }
    const cm = this.cmOf(map);
    const table = this.idTable(doc, map);
    const st = this.statusArr(doc, map, cm, table.hashed ? null : table.ids);
    const edited = !vm.engine.mapTopo(doc);
    const sid0 = this.ui.prefs.scenarioId;
    const sid = sid0 && doc.scenarios[sid0] ? sid0 : null;
    // 選んだ手は配列で決まる（新しい配列にしたら statusStamp が進む。中身が同じなら同じ配列のまま: 形だけの変更で数え直さない）
    const calcKey = `${map.header.hash}|${cm.version.topology}|${cm.version.numbers}|${imp.annual}|${st.key[0]}#${this.statusStamp}`;
    const key = `${calcKey}|${edited ? 1 : 0}|${sid ?? ""}|${table.hashed ? 0 : this.idStamp}`;
    const b = this.built;
    if (b && b.key === key && b.ctx.map === map) return b.ctx;
    const annual = imp.annual;
    // ID の並び（今日が鍵の指紋の ID なら地図ごとの表。違えば文書から作った表）
    const ids: readonly ID[] = table.ids;
    // 見取り図と道の計算は方針（シナリオ）にも編集の有無にも依らない: 同じ計算なら前の物を使う（シナリオを変えても数え直さない）
    const calc: Calc = this.calc && this.calc.key === calcKey ? this.calc : { key: calcKey, a: null, ov: null };
    this.calc = calc;
    let picked: boolean | null = null;
    let docText: DeepText | null = null;
    let goalMemo: { raw: unknown; a: Analysis; g: DeepGoal } | null = null;
    const store = this.store;
    const nodeOf = (i: number): GNode | undefined => {
      const id = ids[i] ?? (i >= 0 && i < map.n ? impactNodeId64(map.key(i)) : undefined);
      return id ? store.doc.nodes[id] : undefined;
    };
    const ctx: DeepCtx = {
      map,
      cm,
      root,
      annual,
      edited,
      scenario: sid,
      analysis: () => {
        if (calc.a) return calc.a;
        const t0 = performance.now();
        // 選んだ手も見送った手も無い: 先に描いた見取り図と同じ計算を使う
        if (isZero(st.arr)) calc.a = plainAnalysis(cm, annual);
        else {
          // 先に描いた見取り図が同じ選んだ手で数えていれば、その物（statusAnalysis）
          calc.a = statusAnalysis(cm, annual, st.arr);
          // 選んだ手の無い計算は、もう使わないので持ち続けない（10 本ほどの 8 万の列: 見直し perf-6）
          plainMemo.delete(cm);
        }
        this.timings.analyze = performance.now() - t0;
        return calc.a;
      },
      overview: () => {
        if (calc.ov) return calc.ov;
        const an = ctx.analysis();
        const t0 = performance.now();
        calc.ov = plainOverview(cm, an);
        this.timings.overview = performance.now() - t0;
        return calc.ov;
      },
      goal: () => {
        const an = ctx.analysis();
        // 入口の meta.goal は前提を変えたときだけ別の物になる（題名・位置などの変更では同じ物のまま）
        const raw = store.doc.nodes[root]?.meta?.goal;
        if (goalMemo && goalMemo.a === an && goalMemo.raw === raw) return goalMemo.g;
        const read = goalConfigOf(store.doc.nodes[root]);
        const tables = tablesFor(read.cfg, goalAnchor(map.header.anchor));
        const base = goalBase(an);
        const t0 = performance.now();
        const summary = goalOf(base, tables);
        this.timings.goal = performance.now() - t0;
        const g: DeepGoal = { read, tables, base, summary };
        goalMemo = { raw, a: an, g };
        return g;
      },
      text: () => {
        if (docText) return docText;
        const an = ctx.analysis();
        const base = deepText(map, annual, an);
        // 本文と数の行は、手を文書のカードの題で呼んで組み立てる（利用者が書き換えた題: reader-1）。題を書き換えていなければ
        // 組み立てた物と同じ文章。覚えは計算ごとに持ち、どこかの題が変わったら捨てる（読まれたカードだけ組み立て直す）
        const rt: ComposeRuntime = { ...textRuntime(an), title: (i) => ctx.ownTitle(i) };
        const card = (i: number): Card => {
          let m = ownTextMemo.get(an);
          const stamp = vm.titleStamp;
          if (!m || m.stamp !== stamp || m.ids !== ids) ownTextMemo.set(an, (m = { stamp, ids, memo: new Map() }));
          let c = m.memo.get(i);
          if (!c) m.memo.set(i, (c = composeCard(map, i, { annual, rt })));
          return c;
        };
        docText = {
          ...base,
          card,
          body: (i) => card(i).body,
          numbers: (i) => card(i).numbers,
          title: (i) => {
            const t = nodeOf(i)?.title;
            return placeholderTitle(t) ? base.title(i) : t!.trim();
          },
          short: (i) => {
            const n = nodeOf(i);
            const sh = n?.meta?.short;
            if (typeof sh === "string" && !placeholderTitle(sh)) return sh.trim();
            return placeholderTitle(n?.title) ? base.short(i) : n!.title.trim();
          },
        };
        return docText;
      },
      ownTitle: (i) => {
        const t = nodeOf(i)?.title;
        return placeholderTitle(t) ? null : t!.trim();
      },
      place: (i) => ({ ym: ym(map, cm.month[i] ?? 0), parent: i > 0 ? (cm.parent[i] ?? -1) : -1 }),
      indexOf: (id) => {
        // 今の文書で読む（ストアは文書の物を保ったまま中身を入れ替える。全部の入れ替えでは計算し直す）。
        // 地図のカードの ID は鍵から決まる（impactNodeId64）ので、ID から番号を引き、鍵が同じかを確かめる
        const k = this.store.doc.nodes[id]?.meta?.key;
        if (typeof k !== "string") return -1;
        const i = table.rev().get(id);
        return i !== undefined && map.key(i) === k ? i : -1;
      },
      idOf: (i) => ids[i] ?? impactNodeId64(map.key(i)),
      pickedSummary: () => {
        if (picked !== null) return picked;
        const reach = ctx.analysis().pi.reach;
        const { flags } = cm;
        const arr = st.arr;
        picked = false;
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] === 1 && flags[i]! & F_STUB && reach[i]! > 0) {
            picked = true;
            break;
          }
        }
        return picked;
      },
    };
    this.built = { key, ctx };
    return ctx;
  }

  /** 選んだ・見送った（地図の番号ごと）と、その版の鍵 */
  private statusArr(doc: DocData, map: MapData, cm: CompiledMap, ids: readonly ID[] | null): { key: string; arr: Uint8Array } {
    const eng = this.vm.engine;
    const fromMap = eng.mapStatus(doc);
    // 選んだ手の版（エンジンの形・状態の版）が同じなら、文書の物が替わっても（全部の入れ替えを変わった物だけで受けた後）同じ配列
    // （計算をやり直さない: 見直し perf-4）
    if (fromMap && fromMap.length === cm.n) {
      const key = `m${eng.version.topology}|${eng.version.statuses}`;
      if (this.status?.key !== key || this.status.arr !== fromMap) {
        this.status = { key, doc, arr: fromMap };
        this.statusStamp++;
      } else this.status.doc = doc;
      return this.status;
    }
    const key = `d${eng.version.topology}|${eng.version.statuses}|${map.header.hash}|${ids ? this.idStamp : 0}`;
    if (this.status && this.status.key === key) {
      this.status.doc = doc;
      return this.status;
    }
    const arr = statusFromDoc(doc, cm, ids ?? idsOf(map));
    // 形だけが変わって選んだ手は同じ（Tab で足したカード・その元に戻す）: 前の配列のまま（計算・見取り図の数をやり直さない: perf-4）
    if (this.status && this.status.key.startsWith("d") && sameBytes(this.status.arr, arr)) {
      this.status = { key, doc, arr: this.status.arr };
      return this.status;
    }
    this.status = { key, doc, arr };
    this.statusStamp++;
    return this.status;
  }

  /** 写し（複製）に入れる文章（地図のカードなら、その時の年収で組み立てた数の行と本文。地図のカードでなければ null） */
  materialize(id: ID): string | null {
    const ctx = this.get();
    if (!ctx) return null;
    const i = ctx.indexOf(id);
    // 手は文書のカードの題で呼ぶ（画面の本文と同じ名前: reader-1）
    return i >= 0 ? materializeBody(ctx.map, i, ctx.annual, { title: (x) => ctx.ownTitle(x) }) : null;
  }
}
