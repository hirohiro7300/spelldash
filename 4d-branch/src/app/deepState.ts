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
// 文書の形や数を書き換えた後（自分で足したカード・書き換えた見込み）も、見取り図と道は地図の元の数で出す（edited。画面がそう書く）。
// どれも読まれたときに作り、材料（地図・形と数の版・年収・選んだ手の版）が同じなら前の物を返す（変更のたびには作らない: 作業メモ perf-4）

import { analyze, overview, type Analysis, type CompiledMap, type Overview, type TextSource } from "../deepmap/core";
import { ym } from "../deepmap/views/format";
import { F_STUB, ROLE_A } from "../deepmap/core/compile";
import type { MapData } from "../deepmap/mapData";
import { composeCard, materializeBody, type Card } from "../demo/compose";
import { impactNodeId64 } from "../demo/impact";
import { loadPageMap, PAGE_Q } from "../demo/pageBundle";
import { compiledMapOf, statusCode } from "../model/impactGraph";
import type { DocData, GNode, ID } from "../model/types";
import { Emitter } from "../store/emitter";
import type { Store } from "../store/store";
import { mapDocOf } from "./futureCache";
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

export function deepText(map: MapData, annual: number): DeepText {
  const m = textMemo.get(map);
  if (m && m.annual === annual) return m.text;
  const memo = new Map<number, Card>();
  const card = (i: number): Card => {
    let c = memo.get(i);
    if (!c) memo.set(i, (c = composeCard(map, i, { annual })));
    return c;
  };
  // provisional は付けない（「文章は仮」の印を出さない）
  const text: DeepText = { title: (i) => card(i).title, short: (i) => card(i).short, body: (i) => card(i).body, numbers: (i) => card(i).numbers, card };
  textMemo.set(map, { annual, text });
  return text;
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
   * 文章（道の画面・行き先の名前）。題名と短い名前は文書のカードの物（キャンバス・詳細・検索と同じ名前。書き換えればそれが出る）。
   * 地図の題名を書いていない「—」・空の物だけ、組み立てた名前（作業メモ SPEC v1 §4.3・見直し equiv-4）。本文と数の行は組み立てた物
   */
  text(): DeepText;
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

/** 地図の番号ごとのカードの ID（鍵の 64 ビットの指紋。地図ごとに 1 回だけ。buildQuarterDoc と同じ ID） */
const idsMemo = new WeakMap<MapData, ID[]>();
function idsOf(map: MapData): ID[] {
  let ids = idsMemo.get(map);
  if (!ids) {
    ids = new Array<ID>(map.n);
    for (let i = 0; i < map.n; i++) ids[i] = impactNodeId64(map.key(i));
    idsMemo.set(map, ids);
  }
  return ids;
}

/** ノードの ID → 地図の番号（地図ごとに 1 回作る。カードを選ぶたび・見えるカードごとに鍵から地図をたどらない） */
const revMemo = new WeakMap<MapData, ReadonlyMap<ID, number>>();
function revOf(map: MapData): ReadonlyMap<ID, number> {
  let rev = revMemo.get(map);
  if (!rev) {
    const ids = idsOf(map);
    const m = new Map<ID, number>();
    for (let i = 0; i < ids.length; i++) m.set(ids[i]!, i);
    revMemo.set(map, (rev = m));
  }
  return rev;
}

/**
 * 3 年の影響のエンジンが地図の列から形を作ったとき、その ID の並びと表（番号は地図と同じ）を、ここの表として覚える
 * （起動のときに 7.2 万の鍵の指紋と表をもう 1 つ作らない: 見直し perf-7）。どちらも書き換えない
 */
function adoptIds(map: MapData, ids: ID[], idx: ReadonlyMap<ID, number>): void {
  if (!idsMemo.has(map) && ids.length === map.n) idsMemo.set(map, ids);
  if (!revMemo.has(map) && idx.size === map.n) revMemo.set(map, idx);
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

/** その計算の見取り図の数（plainAnalysis の物なら覚える） */
export function plainOverview(cm: CompiledMap, a: Analysis): Overview {
  const m = plainMemo.get(cm);
  if (m && m.a === a) return (m.ov ??= overview(a));
  return overview(a);
}

const isZero = (arr: Uint8Array): boolean => {
  for (let i = 0; i < arr.length; i++) if (arr[i]) return false;
  return true;
};

/** 選んだ手・見送った手を、文書から地図の番号ごとに読む（手のカードだけ） */
function statusFromDoc(doc: DocData, cm: CompiledMap, ids: ID[]): Uint8Array {
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
  /** かかった時間（確かめ用。ms）: 計算（analyze）・見取り図の数（overview）・画面（見取り図・ページ・カードの詳細の地図の部分） */
  readonly timings: Record<string, number> = {};

  constructor(
    private readonly vm: ViewModel,
    private readonly store: Store,
    private readonly ui: UiState,
  ) {}

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
        else {
          const imp = this.vm.impact;
          if (imp.active && imp.hasPicks) imp.recommended();
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
  private docIds: { map: MapData; nodes: DocData["nodes"]; topo: number; ids: ID[]; rev: ReadonlyMap<ID, number> } | null = null;
  /** 表を作り直した回数（作り直したら画面に渡す物も作り直す） */
  private idStamp = 0;

  /**
   * 地図の番号 → 文書のカードの ID。今日が鍵の指紋の ID なら、どのカードも鍵の指紋の ID（地図ごとの表）。
   * そうでなければ（版 6 から引き上げた・ID を引き継いだ地図）、文書の鍵から表を作る（形が変わったときだけ）
   */
  private idTable(doc: DocData, map: MapData): { ids: ID[]; rev(): ReadonlyMap<ID, number>; hashed: boolean } {
    // 今日が鍵の指紋の ID: 地図ごとの表（エンジンが地図の列から作っていればその物。なければ要るときに作る: 起動で 7 万の指紋を作らない）
    const memo = idsMemo.get(map);
    if (doc.nodes[memo?.[0] ?? impactNodeId64(map.key(0))]?.meta?.key === map.key(0)) return { ids: memo ?? new Array<ID>(map.n), rev: () => revOf(map), hashed: true };
    const hashed = idsOf(map);
    const topo = this.vm.index.version.topo;
    const c = this.docIds;
    if (c && c.map === map && c.nodes === doc.nodes && c.topo === topo) return { ids: c.ids, rev: () => c.rev, hashed: false };
    // 多くのカードは鍵の指紋の ID のまま（引き上げで前の ID を引き継いだカードだけが違う）: まず番号ごとに鍵の指紋の ID を引き、
    // 見つからない番号だけを、鍵の指紋でない ID のカードの鍵から埋める（7 万の鍵を表で引かない）
    const ids = hashed.slice();
    const seen = new Uint8Array(map.n);
    const taken = new Set<ID>();
    for (let i = 0; i < map.n; i++) {
      const n = doc.nodes[hashed[i]!];
      if (n && n.meta?.key === map.key(i)) {
        seen[i] = 1;
        taken.add(hashed[i]!);
      }
    }
    // 全体を見てよい: ID が鍵の指紋と違う地図（版 6 から引き上げた地図など）で、文書の形が変わったときに 1 回
    for (const id in doc.nodes) {
      if (taken.has(id)) continue;
      const k = doc.nodes[id]!.meta?.key;
      if (typeof k !== "string") continue;
      const i = map.indexOfKey(k);
      if (i < 0 || seen[i]) continue;
      seen[i] = 1;
      ids[i] = id;
    }
    const rev = new Map<ID, number>();
    for (let i = 0; i < ids.length; i++) rev.set(ids[i]!, i);
    this.docIds = { map, nodes: doc.nodes, topo, ids, rev };
    this.idStamp++;
    return { ids, rev: () => rev, hashed: false };
  }

  /** 文書の地図（無ければ null）。ページに入っていれば読み込みを始める */
  private mapOf(doc: DocData, root: ID): MapData | null {
    const reg = mapDocOf(doc);
    if (reg && this.matches(reg, doc, root)) return reg;
    if (!this.loaded) {
      const r = doc.nodes[root];
      // 3 か月ごとの地図（入口に地図の年月がある）なら、ページに入れた地図を読む
      if (r && typeof r.meta?.anchor === "string") this.load();
      return null;
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
    if (t && t.map === map && t.cm) {
      adoptIds(map, t.ids, t.idx);
      return t.cm;
    }
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
    const calcKey = `${map.header.hash}|${cm.version.topology}|${cm.version.numbers}|${imp.annual}|${st.key}#${this.statusStamp}`;
    const key = `${calcKey}|${edited ? 1 : 0}|${sid ?? ""}|${table.hashed ? 0 : this.idStamp}`;
    const b = this.built;
    if (b && b.key === key && b.ctx.map === map) return b.ctx;
    const annual = imp.annual;
    // ID の並び（今日が鍵の指紋の ID なら地図ごとの表。違えば文書から作った表）
    const ids: ID[] = table.ids;
    // 見取り図と道の計算は方針（シナリオ）にも編集の有無にも依らない: 同じ計算なら前の物を使う（シナリオを変えても数え直さない）
    const calc: Calc = this.calc && this.calc.key === calcKey ? this.calc : { key: calcKey, a: null, ov: null };
    this.calc = calc;
    let picked: boolean | null = null;
    let docText: DeepText | null = null;
    const store = this.store;
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
        calc.a = isZero(st.arr) ? plainAnalysis(cm, annual) : analyze(cm, annual, { status: st.arr });
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
      text: () => {
        if (docText) return docText;
        const base = deepText(map, annual);
        const nodeOf = (i: number) => {
          const id = ids[i] ?? (i >= 0 && i < map.n ? (ids[i] = impactNodeId64(map.key(i))) : undefined);
          return id ? store.doc.nodes[id] : undefined;
        };
        docText = {
          ...base,
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
      place: (i) => ({ ym: ym(map, cm.month[i] ?? 0), parent: i > 0 ? (cm.parent[i] ?? -1) : -1 }),
      indexOf: (id) => {
        // 今の文書で読む（ストアは文書の物を保ったまま中身を入れ替える。全部の入れ替えでは計算し直す）。
        // 地図のカードの ID は鍵から決まる（impactNodeId64）ので、ID から番号を引き、鍵が同じかを確かめる
        const k = this.store.doc.nodes[id]?.meta?.key;
        if (typeof k !== "string") return -1;
        const i = table.rev().get(id);
        return i !== undefined && map.key(i) === k ? i : -1;
      },
      idOf: (i) => ids[i] ?? (ids[i] = impactNodeId64(map.key(i))),
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
  private statusArr(doc: DocData, map: MapData, cm: CompiledMap, ids: ID[] | null): { key: string; arr: Uint8Array } {
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
    this.status = { key, doc, arr: statusFromDoc(doc, cm, ids ?? idsOf(map)) };
    this.statusStamp++;
    return this.status;
  }

  /** 写し（複製）に入れる文章（地図のカードなら、その時の年収で組み立てた数の行と本文。地図のカードでなければ null） */
  materialize(id: ID): string | null {
    const ctx = this.get();
    if (!ctx) return null;
    const i = ctx.indexOf(id);
    return i >= 0 ? materializeBody(ctx.map, i, ctx.annual) : null;
  }
}
