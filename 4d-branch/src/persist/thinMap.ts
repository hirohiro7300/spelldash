// 薄い形（thin）の保存: ページの地図（同梱の 3 か月ごとの地図）の本体を省き、利用者の変更だけを持つ。
// 設計: 作業メモ SPEC v1 §6（D7・D9〜D11）・R0 §5・§6.1〜§6.5・§10、見直し safety-1〜15・gaps-1/5/6/9/14/17・perf-10。
// 呼ぶ口は src/persist/codec.ts（toStored・fromStored）だけ。保存・同期・書き出し・履歴はそこを通す（このファイルを直に呼ばない）。
//
// 形（文書の版 THIN_VERSION = 2。前の版のページ v32・v33 は新しい版のデータとして読まずに止まる）:
//   文書の項目（id・題名・時刻・プロジェクト・シナリオ・並び・meta）はそのまま。nodes には今日のカード（入口。いつも丸ごと）・利用者のノード・
//   地図に入らないノード、edges には地図の線でない線（利用者の線）だけを入れ、maps[0] に地図の変更を入れる（ThinSection）:
//     基準  release・hash（同梱データの中身の指紋）・digest（基準の文書の指紋）・bv（組み立てとこの読み手の決まりの版）・anchor・
//           at（手を付けていないカードの時刻）・dx・dy（位置のずれ）・pmap・smap（基準のプロジェクト・シナリオ → 文書の物。違う物だけ。null は無い）
//     n     カードの鍵 → 変えた所（f: 項目・fd: 消した項目・m: meta・md: 消した meta・k: チェックしたやること・was: 元の題名と短い名前と月）、
//           0（このカードとその先の同梱のカードを全部消した。一番上だけ書く）、−1（このカードだけ消した）
//     e     子の鍵 → 親からの同梱の線の変えた所、0（線だけ消した）
//     nid   鍵 → カードの ID（基準の ID と違うときだけ。線の両端も読み替える）・eid 子の鍵 → 線の ID
//     pin   利用者の線（利用者のノードへの線も）が指す地図のカード → {t, s, m}（次の版で鍵が無くなっても、空のカードにしない: safety-7）
//   基準 = ページの地図を buildQuarterDoc で組み立てた文書に、at・dx・dy・pmap・smap を当てた物。手を付けていないカードは基準と同じ物なので書かない。
//   やることのチェックは元の番号（cite）と枠で覚える（文が変わっても外れない: safety-8）。
//
// 決まり:
//   - 読み手は閉じて失敗する（safety-4）: 同じ版の順番で、中身の指紋・基準の文書の指紋・bv・地図の年月・今日の鍵が違う、知らない鍵の変更・消し・
//     ID の読み替え・印・チェック、どこにもつながらない利用者の線は、黙って読まずに ThinMapError（mismatch）。版の順番が違えば older・新しければ
//     ThinNewerError（NewerDocError の一種）。ページに地図が無ければ unavailable。形が読めなければ corrupt。どれも「止める」側の失敗
//     （保存してあるデータは壊れていない。消さない・上書きしない・代わりの内容で始めない: safety-3）
//   - 基準は地図ごとに 1 度だけ組み立てて持ち（時刻だけは最初に使った物）、ほかの at・dx・dy・pmap・smap は使うたびに、変わるカードだけ写して当てる
//     （写しは基準ごとに 3 つまで持つ）。どの読み込みも新しい入れ物（nodes・edges・projects・scenarios・並び・meta）を返す（safety-11）。
//     組み立てた入れ物は凍らせる（本番も。開発とテストではカードと線と meta も）
//   - 書き手は基準の鍵の並び（配列）を引いて同じ物かを見る。文書の nodes・edges は Object.keys で 1 回ずつ数える（for…in を使わない: perf-10）。
//     書き換えたカードの変えた所は、基準ごとにカードの物で覚える（WeakMap）
//   - 書き手は基準（at・dx・dy・pmap・smap）を文書のカードから決める（散らした見本のカードの多数決。プロジェクト・シナリオは見本のカードと線の並び、
//     決まらなければ同じ ID・同じ名前）。どの基準を選んでも、書いた物を読めば同じ文書になる（違うのは大きさだけ）
//   - 今日のカードの meta の futureVersion・futureRelease は、書くときも読むときも基準の物に書き直す（gaps-6）
//   - 往復: fromStored(toStored(d)) は d と同じ。違ってよいのは、手を付けていない地図のカードの時刻（at になる）・今日の futureVersion・
//     futureRelease・文書の version（1）と、保存したノードと線が normalizeDoc を通ること（アプリで作った文書では何も変わらない）だけ

import type { MapData } from "../deepmap/mapData";
import { fnv36, fnv64x36, impactEdgeId64, impactNodeId64, impactTagsOf } from "../demo/impact";
import { impactBaselineDigest } from "../demo/impactDigest";
import { buildQuarterDoc, type QuarterLayout } from "../demo/quarterDoc";
import { NODE_H, NODE_TYPE_ORDER, NODE_W, STATUS_ORDER } from "../model/constants";
import { impactConfigOf, setPreferredRelease } from "../model/forks";
import { DocFormatError, NewerDocError, normalizeDoc, SCHEMA, SCHEMA_VERSION, setReadableVersion, THIN_VERSION, type NormalizeReport } from "../model/schema";
import { normalizeText } from "../model/search";
import type { Condition, DocData, GEdge, GNode, ID, Meta, NodeStatus, NodeType } from "../model/types";
// 同じ鍵のカードの選び方（新しい版にするときと同じ決まり）
import { madeFirst } from "./keyedCards";

// ---------------------------------------------------------------- 決まった値

/** 地図の変更（maps の 1 つ）の形の版 */
export const THIN_SECTION_V = 1;

/**
 * 基準の組み立ての版。buildQuarterDoc が作る物のうち、基準の文書の指紋（impactBaselineDigest）にも中身の指紋（header.hash）にも入らない所
 * （カードの種類・線の関係・印・指紋 t0/b0/k0/c0・順位・位置）と、この読み手の決まりを変えたら上げる。同じ版の順番でも、保存した文書の bv が
 * 違えば読まずに止める（SPEC §6 の「組み立ての版」。tests/unit/thinMap.test.ts が小さい木の基準の全部の指紋で、上げ忘れを見つける）
 */
export const THIN_BASELINE_VERSION = 1;

/** 基準を組み立てる位置の決め方（読み込む側も同じ決め方で組み立てる。変えたら THIN_BASELINE_VERSION を上げる） */
export const THIN_LAYOUT: QuarterLayout = "none";

/** 基準の写し（at・dx・dy・pmap・smap ごと）を持つ数 */
const VIEW_CACHE = 3;

/** 開発とテストでは、基準のカード・線・meta も凍らせる（本番は入れ物だけ。書き換える所があればすぐ止まる） */
const FREEZE_ALL: boolean = import.meta.env.DEV === true;

// ---------------------------------------------------------------- 形

/** ページの地図の版の記録（src/demo/impact-release.json の {release, hash, digest, anchor}） */
export interface PageMapRecord {
  release: number;
  hash: string;
  digest: string;
  anchor: string;
}

/** 基準の当て方（保存した地図の変更の入口の一部）。pmap・smap は基準のプロジェクト・シナリオごとに 1 つ（null: 文書に無い） */
export interface MapBase {
  at: string;
  dx: number;
  dy: number;
  pmap: Record<ID, ID | null>;
  smap: Record<ID, ID | null>;
}

/**
 * 書き換えたカードの、元の題名・短い名前・月（次の版で鍵が無くなっても空のカードにしない: safety-7）。やることを丸ごと書いたときは元の番号と文の指紋も。
 * チェックだけ書いたとき（k）は、チェックした項目の文（kt。次の版で鍵が無くなったカードに、チェックした項目を文ごと残す）
 */
export interface CardWas {
  t: string;
  s: string;
  m: number;
  c?: string[];
  k0?: string[];
  kt?: string[];
}

/** カードの変えた所 */
export interface NodePatch {
  /** 変えた項目（id と meta 以外。時刻は変えたカードだけ、at と違えば） */
  f?: Record<string, unknown>;
  /** 消した項目（ふつうは無い） */
  fd?: string[];
  /** 変えた meta */
  m?: Record<string, unknown>;
  /** 消した meta */
  md?: string[];
  /** チェックしたやること（元の番号。同じ番号の 2 つ目からは "#2" のように数を付ける）。やることがチェックのほかは同じときだけ */
  k?: string[];
  was: CardWas;
}

/** 親からの同梱の線の変えた所（両端は書かない。両端はカードの ID から決まる） */
export interface EdgePatch {
  f?: Record<string, unknown>;
  fd?: string[];
  m?: Record<string, unknown>;
  md?: string[];
}

/** 線の先の地図のカードの元の題名・短い名前・月 */
export interface CardPin {
  t: string;
  s: string;
  m: number;
}

/** 保存した文書の maps の 1 つ（ページの地図の変更） */
export interface ThinSection {
  v: number;
  /** 今日のカードの ID（今日のカードは nodes に丸ごとある） */
  root: ID;
  /** 今日のカードの鍵 */
  key: string;
  release: number;
  hash: string;
  digest: string;
  bv: number;
  anchor: string;
  at: string;
  dx: number;
  dy: number;
  pmap?: Record<ID, ID | null>;
  smap?: Record<ID, ID | null>;
  n?: Record<string, NodePatch | 0 | -1>;
  e?: Record<string, EdgePatch | 0>;
  nid?: Record<string, ID>;
  eid?: Record<string, ID>;
  pin?: Record<string, CardPin>;
}

/** 保存する文書（地図が無ければ DocData そのもの。あれば版 2 で maps つき） */
export type StoredDoc = DocData & { maps?: ThinSection[] };

/** 書いたときの数（確かめと大きさの見張り） */
export interface ThinStats {
  /** 地図のカード（今日を除く。文書にある物） */
  cards: number;
  /** 書き換えたカード */
  patched: number;
  /** 消したカードの印（0 と −1） */
  tombs: number;
  /** 書き換えた同梱の線 */
  patchedEdges: number;
  /** 消した同梱の線の印 */
  edgeTombs: number;
  nid: number;
  eid: number;
  pins: number;
  /** 丸ごと書いたノード（今日を含む）と線 */
  storedNodes: number;
  storedEdges: number;
  /** 丸ごと書いた、基準の鍵を持つノード（同じ鍵の 2 つ目など。多ければ太い形に近い） */
  fatKeyed: number;
  /** 基準と同じ物でなく、項目ごとに比べたカード（読み込んだ直後の文書なら、書き換えたカードだけ） */
  compared: number;
}

// ---------------------------------------------------------------- 失敗

/** 読めない訳: unavailable ページに地図が無い / older 前の版の地図 / mismatch 同じ版で基準が合わない / corrupt 形が読めない */
export type ThinErrorCode = "unavailable" | "older" | "mismatch" | "corrupt";

/**
 * 薄い形の文書を読めない（止める側の失敗。保存してあるデータは壊れていない: 消さない・上書きしない・代わりの内容で始めない。safety-3）。
 * DocFormatError の一種なので、取り込み・アカウントの写しでは今までどおり読めない理由として扱われる
 */
export class ThinMapError extends DocFormatError {
  override name = "ThinMapError";
  readonly code: ThinErrorCode;
  /** 保存した地図の版の順番（分かれば） */
  readonly release: number | null;
  constructor(code: ThinErrorCode, message: string, opts: { release?: number | null; cause?: unknown } = {}) {
    super(message);
    this.code = code;
    this.release = opts.release ?? null;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

/** 保存した地図が、このページより新しい版の地図（開き直すと新しい版で開く。NewerDocError の一種） */
export class ThinNewerError extends NewerDocError {
  override name = "ThinNewerError";
  readonly release: number;
  constructor(release: number, message?: string) {
    super(THIN_VERSION);
    this.release = release;
    this.message = message ?? `この地図は新しい版（版 ${release}）のページで保存されています。ページを開き直してください（保存されているデータには触れていません）。`;
  }
}

/** 地図のある文書を薄い形で書けない（太い形でも書かない。地図の本体ごと書くと 7,000 万文字を超える: safety-15） */
export class ThinWriteError extends Error {
  override name = "ThinWriteError";
}

/** ページの地図を持つ文書を、基準を用意する前に書こうとした */
export class ThinBaselineMissingError extends ThinWriteError {
  override name = "ThinBaselineMissingError";
  constructor() {
    super("3 か月ごとの地図の基準を用意する前に、地図のある文書を保存しようとしました（地図の本体ごと書くと大きすぎるので書きません）");
  }
}

/** 今日のカードが無いのに、ページの地図のカードがこれより多くあれば、書かずに止める（太い形にしない） */
const ROOTLESS_MAX = 1000;

// ---------------------------------------------------------------- 小さな道具

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: object, k: string): boolean => Object.hasOwn(o, k);
const fzAll = <T>(x: T): T => (FREEZE_ALL ? Object.freeze(x) : x);

/** JSON の値として同じか（鍵の順は問わない） */
export function jsonEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEq(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!own(b, k) || !jsonEq((a as Obj)[k], (b as Obj)[k])) return false;
  return true;
}

const sameStrs = (a: readonly string[], b: readonly string[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

const nameKey = (name: string): string => normalizeText(name.trim());
const isFlowRel = (e: GEdge): boolean => e.relation === "leads" || e.relation === "condition";

// ---------------------------------------------------------------- ページの地図（基準）

interface PageBaseline {
  map: MapData;
  release: number;
  hash: string;
  anchor: string;
  /** 版の記録の基準の文書の指紋（無ければ、組み立てた基準から数える） */
  digest: string | null;
}

/** 組み立てた基準（地図ごとに 1 つ。時刻は最初に使った物。ページの地図を入れ直しても、同じ地図なら作り直さない） */
interface Core {
  readonly map: MapData;
  /** 地図の年月 */
  readonly anchor: string;
  /** この組み立ての基準の文書の指紋（初めて要るときに数える） */
  digest: string | null;
  /** 組み立てた文書（入れ物は凍らせる） */
  readonly doc: DocData;
  readonly at: string;
  readonly n: number;
  readonly keys: readonly string[];
  readonly parent: Int32Array;
  /** 子の並び（CSR）: i の子は kids[kidStart[i] .. kidStart[i+1]) */
  readonly kidStart: Int32Array;
  readonly kids: Int32Array;
  readonly nodes: readonly GNode[];
  /** 親からの線（今日は null） */
  readonly edges: readonly (GEdge | null)[];
  /** カードの ID・親からの線の ID（番号ごと。今日の線は ""） */
  readonly ids: readonly ID[];
  readonly eids: readonly ID[];
  readonly idIndex: ReadonlyMap<ID, number>;
  readonly eidIndex: ReadonlyMap<ID, number>;
  readonly keyIndex: ReadonlyMap<string, number>;
  readonly projects: ReadonlyArray<{ id: ID; name: string }>;
  readonly scenarios: ReadonlyArray<{ id: ID; name: string }>;
  /** 時刻・位置を決める見本（散らした番号） */
  readonly spread: Int32Array;
  /** プロジェクトを決める見本: 1 つのプロジェクトだけのカード（プロジェクトごと）と、全部のプロジェクトのカード */
  readonly projSamples: ReadonlyMap<ID, Int32Array>;
  readonly allSamples: Int32Array;
  readonly allList: readonly ID[];
  /** シナリオを決める見本（同じシナリオの並びの線ごと） */
  readonly scenSamples: ReadonlyArray<{ list: readonly ID[]; idx: Int32Array }>;
  /** カードのやることの枠の名前（チェックを覚える名前） */
  readonly slotMemo: Map<number, readonly string[]>;
  views: View[];
}

/** 基準の写し（at・dx・dy・pmap・smap を当てた物）。変わらないカードと線は組み立てた物のまま */
interface View {
  readonly key: string;
  readonly base: MapBase;
  readonly nodes: readonly GNode[];
  readonly edges: readonly (GEdge | null)[];
  readonly memoN: WeakMap<GNode, Omit<NodePatch, "was"> | null>;
  readonly memoE: WeakMap<GEdge, EdgePatch | null>;
}

let page: PageBaseline | null = null;
/** 地図ごとの基準（地図を手放せば一緒に消える） */
const cores = new WeakMap<MapData, Core>();

/**
 * ページの地図の読み込み方（ページに 3 か月ごとの地図を入れたビルドだけ。main.ts が起動で決める）。地図は要るときに初めて読む
 * （保存してあった物に地図がある・利用者が地図を開く: 見直し gaps-17）。読み込み方があるページは、薄い形（版 2）を読めるページ
 */
let source: { load: () => Promise<MapData | null>; digest?: string } | null = null;
/** 読み込み（1 度だけ。読めなかったら、開き直すまで読めないまま: 薄い形の文書は止める） */
let loading: Promise<boolean> | null = null;

/** 読める保存の版と、入口を選ぶときに先にする版を、今のページの地図に合わせる */
function syncPage(): void {
  setReadableVersion(page !== null || source !== null ? THIN_VERSION : SCHEMA_VERSION);
  setPreferredRelease(page ? page.release : null);
}

/**
 * ページの地図（基準）を入れる。null で外す。digest は版の記録の基準の文書の指紋（無ければ初めて使うときに数える）。
 * 版の順番・中身の指紋・地図の年月は地図の入口から取る。入れている間は、このページは薄い形（版 2）を読める
 */
export function setThinBaseline(map: MapData | null, opts: { digest?: string } = {}): void {
  if (!map) {
    page = null;
    syncPage();
    return;
  }
  const h = map.header;
  if (!Number.isInteger(h.release) || h.release < 0 || typeof h.hash !== "string" || !h.hash || typeof h.anchor !== "string") throw new Error("ページの地図の入口（版の順番・中身の指紋・年月）が読めません");
  page = { map, release: h.release, hash: h.hash, anchor: h.anchor, digest: opts.digest ?? null };
  syncPage();
}

/**
 * ページの地図の読み込み方を決める（null で外す。外すと、入れてある地図も外す）。決めるだけで読まない: 読むのは ensurePageMap。
 * 決めてからは、このページは薄い形（版 2）を読めるページ（版の記録・見出し・マニフェストの docVersion 2 を新しい版と見なさない）
 */
export function setPageMapSource(load: (() => Promise<MapData | null>) | null, opts: { digest?: string } = {}): void {
  source = load ? { load, ...(opts.digest ? { digest: opts.digest } : {}) } : null;
  loading = null;
  if (!load) page = null;
  syncPage();
}

/** このページが薄い形（版 2）を読めるか（ページの地図があるか、読み込み方が決まっている） */
export function thinReadable(): boolean {
  return page !== null || source !== null;
}

/**
 * ページの地図を用意する（入れてあればすぐ true。読み込み方があれば 1 度だけ読んで入れる）。読めなければ false
 * （薄い形の文書は unavailable で止まる。開き直すまで読み直さない）
 */
export function ensurePageMap(): Promise<boolean> {
  if (page) return Promise.resolve(true);
  const src = source;
  if (!src) return Promise.resolve(false);
  loading ??= src.load().then(
    (map) => {
      if (!map || source !== src) return false;
      setThinBaseline(map, { digest: src.digest });
      return true;
    },
    () => false,
  );
  return loading;
}

/** 入れてあるページの地図の版の順番（無ければ null。基準を組み立てずに分かる） */
export function pageRelease(): number | null {
  return page ? page.release : null;
}

/** 入れてあるページの地図の中身の指紋（無ければ null） */
export function pageHash(): string | null {
  return page ? page.hash : null;
}

/** ページの地図の基準の文書の指紋（版の記録の物。無ければ組み立てた基準から数える） */
function pageDigest(pb: PageBaseline): string {
  if (pb.digest !== null) return pb.digest;
  const core = coreOf(pb.map, null);
  return (core.digest ??= impactBaselineDigest(core.doc, core.ids[0]!));
}

/** 入れたページの地図の版の記録（無ければ null。指紋を数えていなければ、ここで基準を組み立てて数える） */
export function thinBaseline(): PageMapRecord | null {
  if (!page) return null;
  return { release: page.release, hash: page.hash, digest: pageDigest(page), anchor: page.anchor };
}

/** ページの地図があるか（基準を組み立てずに分かる） */
export function hasThinBaseline(): boolean {
  return page !== null;
}

/** 組み立てた基準の文書（確かめ用。入れ物は凍っている。まだ組み立てていなければ null） */
export function thinBaselineCore(): DocData | null {
  return page ? (cores.get(page.map)?.doc ?? null) : null;
}

const isoOk = (s: unknown): s is string => typeof s === "string" && Number.isFinite(Date.parse(s));

/** 基準を組み立てる（地図ごとに初めの 1 回だけ。時刻は at があればそれ、無ければ地図の年月の 1 日） */
function coreOf(map: MapData, at: string | null): Core {
  const hit = cores.get(map);
  if (hit) return hit;
  const h = map.header;
  const ms = at !== null && isoOk(at) ? Date.parse(at) : Date.parse(`${h.anchor}-01T00:00:00.000Z`);
  const doc = buildQuarterDoc(map, { version: h.hash, release: h.release, at: Number.isFinite(ms) ? ms : 0, layout: THIN_LAYOUT });
  const n = map.n;
  const keys = new Array<string>(n);
  const nodes = new Array<GNode>(n);
  const edges = new Array<GEdge | null>(n).fill(null);
  const parent = new Int32Array(n);
  const idIndex = new Map<ID, number>();
  const eidIndex = new Map<ID, number>();
  const keyIndex = new Map<string, number>();
  // 組み立ては番号の順にカードと線を入れる（線は今日を除く）。違えば組み立ての決まりが変わったので止める
  let i = 0;
  for (const node of Object.values(doc.nodes)) {
    const k = map.key(i);
    if (node.meta.key !== k) throw new Error(`基準の組み立ての並びが地図の番号と合いません（${i}: ${k}）`);
    keys[i] = k;
    nodes[i] = node;
    idIndex.set(node.id, i);
    keyIndex.set(k, i);
    parent[i] = map.parent(i);
    i++;
  }
  if (i !== n) throw new Error("基準の組み立てのカードの数が地図と合いません");
  i = 1;
  for (const e of Object.values(doc.edges)) {
    if (i >= n || e.target !== nodes[i]!.id || e.source !== nodes[parent[i]!]!.id) throw new Error(`基準の組み立ての線が地図の番号と合いません（${i}）`);
    edges[i] = e;
    eidIndex.set(e.id, i);
    i++;
  }
  if (i !== n) throw new Error("基準の組み立ての線の数が地図と合いません");
  // 子の並び（深さ優先の番号なので、子は番号の順に出てくる）
  const kidStart = new Int32Array(n + 1);
  for (let c = 1; c < n; c++) kidStart[parent[c]! + 1]!++;
  for (let c = 0; c < n; c++) kidStart[c + 1]! += kidStart[c]!;
  const fill = kidStart.slice(0, n);
  const kids = new Int32Array(Math.max(0, n - 1));
  for (let c = 1; c < n; c++) kids[fill[parent[c]!]!++] = c;
  // 見本
  const spreadOf = (list: number[], max: number): Int32Array => {
    if (list.length <= max) return Int32Array.from(list);
    const out = new Int32Array(max);
    for (let k = 0; k < max; k++) out[k] = list[Math.floor(((k + 0.5) * list.length) / max)]!;
    return out;
  };
  const all: number[] = [];
  for (let c = 1; c < n; c++) all.push(c);
  const spread = spreadOf(all, 33);
  const allList = nodes[0]!.projectIds;
  const byProj = new Map<ID, number[]>();
  const allIdx: number[] = [];
  for (let c = 1; c < n; c++) {
    const p = nodes[c]!.projectIds;
    if (p === allList || (p.length === allList.length && sameStrs(p, allList))) allIdx.push(c);
    else if (p.length === 1) {
      const list = byProj.get(p[0]!);
      if (list) list.push(c);
      else byProj.set(p[0]!, [c]);
    }
  }
  const projSamples = new Map<ID, Int32Array>();
  for (const [p, list] of byProj) projSamples.set(p, spreadOf(list, 9));
  const byScen = new Map<string, { list: readonly ID[]; idx: number[] }>();
  for (let c = 1; c < n; c++) {
    const s = edges[c]!.scenarioIds;
    if (!s.length) continue;
    const k = s.join("\u0000");
    const g = byScen.get(k);
    if (g) g.idx.push(c);
    else byScen.set(k, { list: s, idx: [c] });
  }
  const scenSamples = [...byScen.values()].map((g) => ({ list: g.list, idx: spreadOf(g.idx, 9) }));
  // 入れ物は凍らせる（本番も。読み込みのたびに新しい入れ物へ写すので、ここへは誰も書かない: safety-11）
  if (FREEZE_ALL) {
    for (const node of nodes) {
      Object.freeze(node.meta);
      for (const c of node.conditions) Object.freeze(c);
      Object.freeze(node.conditions);
      Object.freeze(node);
    }
    for (const e of edges) if (e) (Object.freeze(e.meta), Object.freeze(e));
    for (const p of Object.values(doc.projects)) (Object.freeze(p.meta), Object.freeze(p));
    for (const s of Object.values(doc.scenarios)) (Object.freeze(s.meta), Object.freeze(s));
  }
  Object.freeze(doc.nodes);
  Object.freeze(doc.edges);
  Object.freeze(doc.projects);
  Object.freeze(doc.scenarios);
  Object.freeze(doc.projectOrder);
  Object.freeze(doc.scenarioOrder);
  Object.freeze(doc.meta);
  Object.freeze(doc);
  const core: Core = {
    map,
    anchor: h.anchor,
    digest: null,
    doc,
    at: nodes[0]!.createdAt,
    n,
    keys,
    parent,
    kidStart,
    kids,
    nodes,
    edges,
    ids: nodes.map((x) => x.id),
    eids: edges.map((e) => (e ? e.id : "")),
    idIndex,
    eidIndex,
    keyIndex,
    projects: doc.projectOrder.map((id) => ({ id, name: doc.projects[id]!.name })),
    scenarios: doc.scenarioOrder.map((id) => ({ id, name: doc.scenarios[id]!.name })),
    spread,
    projSamples,
    allSamples: spreadOf(allIdx, 9),
    allList,
    scenSamples,
    slotMemo: new Map(),
    views: [],
  };
  cores.set(map, core);
  return core;
}

/** 基準のプロジェクト・シナリオの読み替え（同じ ID の物は書かない） */
function compactMap(full: Readonly<Record<ID, ID | null>>): Record<ID, ID | null> | undefined {
  let out: Record<ID, ID | null> | undefined;
  for (const k of Object.keys(full)) if (full[k] !== k) (out ??= {})[k] = full[k]!;
  return out;
}

const baseKey = (b: MapBase): string => JSON.stringify([b.at, b.dx, b.dy, compactMap(b.pmap) ?? null, compactMap(b.smap) ?? null]);

/** ID の並びを読み替える物（全部が同じ ID なら null）。同じ並び（組み立ては同じ中身の並びを共有する）は 1 回だけ読み替える */
function listMapper(map: Readonly<Record<ID, ID | null>>): ((l: readonly ID[]) => ID[]) | null {
  let identity = true;
  for (const k of Object.keys(map)) if (map[k] !== k) identity = false;
  if (identity) return null;
  const memo = new Map<readonly ID[], ID[]>();
  return (l) => {
    const hit = memo.get(l);
    if (hit) return hit;
    const out: ID[] = [];
    for (const id of l) {
      const t = own(map, id) ? map[id]! : id;
      if (t !== null && !out.includes(t)) out.push(t);
    }
    const res = sameStrs(out, l) ? (l as ID[]) : fzAll(out);
    memo.set(l, res);
    return res;
  };
}

/** 基準の写し（at・dx・dy・pmap・smap を当てた物。最近の 3 つを持つ） */
function viewOf(core: Core, base: MapBase): View {
  const key = baseKey(base);
  const k = core.views.findIndex((v) => v.key === key);
  if (k >= 0) {
    const v = core.views[k]!;
    if (k > 0) core.views.splice(k, 1), core.views.unshift(v);
    return v;
  }
  const n = core.n;
  const stamp = base.at !== core.at;
  const shift = base.dx !== 0 || base.dy !== 0;
  const pm = listMapper(base.pmap);
  const sm = listMapper(base.smap);
  const nodes = new Array<GNode>(n);
  const edges = new Array<GEdge | null>(n).fill(null);
  for (let i = 0; i < n; i++) {
    const c = core.nodes[i]!;
    const projectIds = pm ? pm(c.projectIds) : c.projectIds;
    const scenarioIds = sm ? sm(c.scenarioIds) : c.scenarioIds;
    if (!stamp && !shift && projectIds === c.projectIds && scenarioIds === c.scenarioIds) nodes[i] = c;
    else nodes[i] = fzAll({ ...c, projectIds, scenarioIds, x: c.x + base.dx, y: c.y + base.dy, createdAt: base.at, updatedAt: base.at });
  }
  for (let i = 1; i < n; i++) {
    const e = core.edges[i]!;
    const scenarioIds = sm ? sm(e.scenarioIds) : e.scenarioIds;
    if (!stamp && scenarioIds === e.scenarioIds) edges[i] = e;
    else edges[i] = fzAll({ ...e, scenarioIds, createdAt: base.at, updatedAt: base.at });
  }
  const v: View = { key, base: { at: base.at, dx: base.dx, dy: base.dy, pmap: { ...base.pmap }, smap: { ...base.smap } }, nodes, edges, memoN: new WeakMap(), memoE: new WeakMap() };
  core.views.unshift(v);
  if (core.views.length > VIEW_CACHE) core.views.length = VIEW_CACHE;
  return v;
}

/** カードのやることの枠の名前（元の番号。同じ番号の 2 つ目からは "#2"…。元の番号が無い枠は ""） */
function slotsOf(core: Core, i: number): readonly string[] {
  const hit = core.slotMemo.get(i);
  if (hit) return hit;
  const node = core.nodes[i]!;
  const cites = Array.isArray(node.meta.cites) ? (node.meta.cites as unknown[]) : [];
  const seen = new Map<string, number>();
  const out = node.conditions.map((_, t) => {
    const c = typeof cites[t] === "string" ? (cites[t] as string) : "";
    const o = (seen.get(c) ?? 0) + 1;
    seen.set(c, o);
    return o === 1 ? c : `${c}#${o}`;
  });
  core.slotMemo.set(i, out);
  return out;
}

/** ページの地図の今日のカードか（鍵・地図の年月・3 年の分かれ道の入口） */
function isPageRoot(core: Core, n: GNode): boolean {
  return n.meta?.forecastRoot === true && n.meta.key === core.keys[0] && n.meta.anchor === core.anchor && impactConfigOf(n) !== null;
}

/** 文書がページの地図（同じ鍵・年月の今日）を持つか（地図を足すときに ID をそのまま使う・書くと薄い形になる物か。基準を組み立てずに分かる） */
export function holdsPageMap(doc: DocData): boolean {
  if (!page) return false;
  const key = page.map.key(0);
  for (const id of Object.keys(doc.nodes)) {
    const n = doc.nodes[id]!;
    if (n.meta?.forecastRoot === true && n.meta.key === key && n.meta.anchor === page.anchor && impactConfigOf(n) !== null) return true;
  }
  return false;
}

/** 3 か月ごとの地図の今日のカード（どの版でも。地図の年月 anchor を持つ 3 年の分かれ道の入口） */
export function isQuarterRoot(n: GNode | undefined): boolean {
  return !!n && n.meta?.forecastRoot === true && typeof n.meta.anchor === "string" && impactConfigOf(n) !== null;
}

/** 基準の文書（at・dx・dy・pmap・smap を当てた物）を、新しい入れ物で返す（読み込む側が地図を入れるとき・テスト） */
export function thinBaselineDoc(base: Partial<MapBase> = {}): DocData {
  if (!page) throw new ThinMapError("unavailable", "ページに 3 か月ごとの地図がありません");
  const core = coreOf(page.map, base.at ?? null);
  const full: MapBase = {
    at: base.at ?? core.at,
    dx: base.dx ?? 0,
    dy: base.dy ?? 0,
    pmap: { ...Object.fromEntries(core.projects.map((p) => [p.id, p.id])), ...base.pmap },
    smap: { ...Object.fromEntries(core.scenarios.map((s) => [s.id, s.id])), ...base.smap },
  };
  const v = viewOf(core, full);
  const d = core.doc;
  const nodes: Record<ID, GNode> = {};
  const edges: Record<ID, GEdge> = {};
  for (let i = 0; i < core.n; i++) nodes[v.nodes[i]!.id] = v.nodes[i]!;
  for (let i = 1; i < core.n; i++) edges[v.edges[i]!.id] = v.edges[i]!;
  const projects: DocData["projects"] = {};
  for (const id of d.projectOrder) projects[id] = { ...d.projects[id]!, meta: {}, createdAt: full.at, updatedAt: full.at };
  const scenarios: DocData["scenarios"] = {};
  for (const id of d.scenarioOrder) scenarios[id] = { ...d.scenarios[id]!, meta: {}, createdAt: full.at, updatedAt: full.at };
  return { ...d, createdAt: full.at, updatedAt: full.at, projects, scenarios, nodes, edges, projectOrder: [...d.projectOrder], scenarioOrder: [...d.scenarioOrder], meta: {} };
}

/**
 * ページの地図の基準（版 6 までの地図の引き上げ ./legacyMap.ts が読む物）。番号はページの地図（MapData）の番号と同じ。
 * view のカード・線・meta は基準と共有（開発とテストでは凍っている）: 書き換えるときは写す
 */
export interface PageMapAccess {
  readonly map: MapData;
  readonly release: number;
  readonly hash: string;
  readonly anchor: string;
  readonly n: number;
  readonly keys: readonly string[];
  readonly parent: Int32Array;
  readonly kidStart: Int32Array;
  readonly kids: Int32Array;
  readonly keyIndex: ReadonlyMap<string, number>;
  /** 組み立てた基準の時刻と、今日の位置 */
  readonly at: string;
  readonly rootX: number;
  readonly rootY: number;
  readonly projects: ReadonlyArray<{ id: ID; name: string }>;
  readonly scenarios: ReadonlyArray<{ id: ID; name: string }>;
  /** カードのやることの枠の名前（元の番号。同じ番号の 2 つ目からは "#2"…） */
  slots(i: number): readonly string[];
  /** 組み立てたカードのプロジェクト（基準のプロジェクトの ID。読み替える前） */
  projectIdsOf(i: number): readonly ID[];
  /** 基準の写し（at・dx・dy・pmap・smap を当てた物） */
  view(base: MapBase): { readonly nodes: readonly GNode[]; readonly edges: readonly (GEdge | null)[] };
  /** 今日のカードの futureVersion・futureRelease をページの地図の物に */
  withRelease(root: GNode): GNode;
}

/** ページの地図の基準を読む口（無ければ null。基準をまだ組み立てていなければ、at の時刻で組み立てる） */
export function pageMapAccess(at: string | null): PageMapAccess | null {
  const pb = page;
  if (!pb) return null;
  const core = coreOf(pb.map, at);
  return {
    map: core.map,
    release: pb.release,
    hash: pb.hash,
    anchor: pb.anchor,
    n: core.n,
    keys: core.keys,
    parent: core.parent,
    kidStart: core.kidStart,
    kids: core.kids,
    keyIndex: core.keyIndex,
    at: core.at,
    rootX: core.nodes[0]!.x,
    rootY: core.nodes[0]!.y,
    projects: core.projects,
    scenarios: core.scenarios,
    slots: (i) => slotsOf(core, i),
    projectIdsOf: (i) => core.nodes[i]!.projectIds,
    view: (base) => {
      const v = viewOf(core, base);
      return { nodes: v.nodes, edges: v.edges };
    },
    withRelease: (root) => withRelease(root, pb),
  };
}

/** ページの地図の今日の鍵（ページの地図が無ければ null。基準を組み立てずに分かる） */
export function pageRootKey(): string | null {
  return page ? page.map.key(0) : null;
}

// ---------------------------------------------------------------- 書く（文書 → 薄い形）

/** 多数決（同じ数なら先に出た物） */
function vote<T>(xs: readonly T[]): T | undefined {
  const count = new Map<T, number>();
  let best: T | undefined;
  let top = 0;
  for (const x of xs) {
    const c = (count.get(x) ?? 0) + 1;
    count.set(x, c);
    if (c > top) (best = x), (top = c);
  }
  return best;
}

/**
 * 文書のカードから基準（at・dx・dy・pmap・smap）を決める。cards は番号ごとの文書のカード、edges は子の番号ごとの親からの同梱の線。
 * どれを選んでも書いた物を読めば同じ文書になる（合わない基準は変えた所が増えるだけ）
 */
function inferBase(core: Core, doc: DocData, cards: ReadonlyArray<GNode | undefined>, edges: ReadonlyArray<GEdge | undefined>): MapBase {
  const ats: string[] = [];
  const dxs: number[] = [];
  const dys: number[] = [];
  for (const i of core.spread) {
    const c = cards[i];
    if (!c) continue;
    ats.push(c.createdAt);
    dxs.push(c.x - core.nodes[i]!.x);
    dys.push(c.y - core.nodes[i]!.y);
  }
  const root = cards[0]!;
  const at = vote(ats) ?? (isoOk(root.createdAt) ? root.createdAt : core.at);
  const dx = Math.round(vote(dxs) ?? root.x - core.nodes[0]!.x);
  const dy = Math.round(vote(dys) ?? root.y - core.nodes[0]!.y);
  // プロジェクト: 1 つのプロジェクトだけのカード・全部のプロジェクトのカードの、文書の並びで多数決。決まらなければ同じ ID・同じ名前・無い
  const pVotes = new Map<ID, Array<ID | null>>();
  const pv = (p: ID, t: ID | null): void => {
    const list = pVotes.get(p);
    if (list) list.push(t);
    else pVotes.set(p, [t]);
  };
  for (const [p, idx] of core.projSamples) {
    for (const i of idx) {
      const c = cards[i];
      if (!c) continue;
      if (c.projectIds.length === 0) pv(p, null);
      else if (c.projectIds.length === 1 && own(doc.projects, c.projectIds[0]!)) pv(p, c.projectIds[0]!);
    }
  }
  for (const i of core.allSamples) {
    const c = cards[i];
    if (!c || c.projectIds.length !== core.allList.length) continue;
    for (let k = 0; k < core.allList.length; k++) if (own(doc.projects, c.projectIds[k]!)) pv(core.allList[k]!, c.projectIds[k]!);
  }
  const pByName = new Map<string, ID>();
  for (const id of doc.projectOrder) {
    const p = doc.projects[id];
    if (p && !pByName.has(nameKey(p.name))) pByName.set(nameKey(p.name), id);
  }
  const pmap: Record<ID, ID | null> = {};
  for (const p of core.projects) {
    const v = pVotes.has(p.id) ? vote(pVotes.get(p.id)!) : undefined;
    pmap[p.id] = v !== undefined ? v : own(doc.projects, p.id) ? p.id : (pByName.get(nameKey(p.name)) ?? null);
  }
  // シナリオ: 同じ長さの並びの線は位置で多数決。決まった「無い」を外して同じ長さになった並びでもう一度。決まらなければ同じ ID・同じ名前・無い
  const sVotes = new Map<ID, Array<ID | null>>();
  const sv = (s: ID, t: ID | null): void => {
    const list = sVotes.get(s);
    if (list) list.push(t);
    else sVotes.set(s, [t]);
  };
  const later: Array<{ list: readonly ID[]; got: readonly ID[] }> = [];
  for (const g of core.scenSamples) {
    for (const i of g.idx) {
      const e = edges[i];
      if (!e) continue;
      const got = e.scenarioIds;
      if (got.length === g.list.length) {
        for (let k = 0; k < got.length; k++) if (own(doc.scenarios, got[k]!)) sv(g.list[k]!, got[k]!);
      } else if (got.length === 0 && g.list.length === 1) sv(g.list[0]!, null);
      else later.push({ list: g.list, got });
    }
  }
  const sByName = new Map<string, ID>();
  for (const id of doc.scenarioOrder) {
    const s = doc.scenarios[id];
    if (s && !sByName.has(nameKey(s.name))) sByName.set(nameKey(s.name), id);
  }
  const smap: Record<ID, ID | null> = {};
  const decided = (s: { id: ID; name: string }): ID | null | undefined => (sVotes.has(s.id) ? vote(sVotes.get(s.id)!) : undefined);
  const fallback = (s: { id: ID; name: string }): ID | null => (own(doc.scenarios, s.id) ? s.id : (sByName.get(nameKey(s.name)) ?? null));
  for (const s of core.scenarios) {
    const v = decided(s);
    if (v !== undefined) smap[s.id] = v;
  }
  for (const s of core.scenarios) if (!own(smap, s.id) && fallback(s) === null) smap[s.id] = null;
  for (const { list, got } of later) {
    const rest = list.filter((s) => smap[s] !== null);
    if (rest.length !== got.length) continue;
    for (let k = 0; k < got.length; k++) if (!own(smap, rest[k]!) && own(doc.scenarios, got[k]!)) sv(rest[k]!, got[k]!);
  }
  for (const s of core.scenarios) if (!own(smap, s.id)) smap[s.id] = decided(s) ?? fallback(s);
  return { at, dx, dy, pmap, smap };
}

const NODE_FIELDS = ["type", "title", "body", "status", "time", "conditions", "tags", "projectIds", "scenarioIds", "x", "y", "collapsed"] as const;
const NODE_KNOWN = new Set<string>([...NODE_FIELDS, "id", "createdAt", "updatedAt", "meta"]);
const EDGE_FIELDS = ["relation", "label", "condition", "scenarioIds", "collapsed"] as const;
const EDGE_KNOWN = new Set<string>([...EDGE_FIELDS, "id", "source", "target", "createdAt", "updatedAt", "meta"]);

/** 知らない項目（新しい版で足された物など）の違い */
function extrasDiff(cur: Obj, base: Obj, known: ReadonlySet<string>, f: Obj | null, fd: string[] | null): { f: Obj | null; fd: string[] | null } {
  for (const k of Object.keys(cur)) if (!known.has(k) && (!own(base, k) || !jsonEq(cur[k], base[k]))) (f ??= {})[k] = cur[k];
  for (const k of Object.keys(base)) if (!known.has(k) && !own(cur, k)) (fd ??= []).push(k);
  return { f, fd };
}

/** meta の違い（変えた物と消した物） */
function metaDiff(cur: Meta, base: Meta): { m: Obj | null; md: string[] | null } {
  if (cur === base) return { m: null, md: null };
  let m: Obj | null = null;
  let md: string[] | null = null;
  for (const k of Object.keys(cur)) if (!own(base, k) || !jsonEq(cur[k], base[k])) (m ??= {})[k] = cur[k];
  for (const k of Object.keys(base)) if (!own(cur, k)) (md ??= []).push(k);
  return { m, md };
}

/** やることがチェックのほかは同じなら、チェックした枠の名前（同じなら changed: false）。形が違えば null（丸ごと書く） */
function tickDiff(cur: readonly Condition[], base: readonly Condition[], slots: () => readonly string[]): { changed: boolean; checked: string[] } | null {
  if (cur.length !== base.length) return null;
  let changed = false;
  for (let t = 0; t < cur.length; t++) {
    const c = cur[t]!;
    const b = base[t]!;
    if (c === b) continue;
    if (c.id !== b.id || c.text !== b.text) return null;
    const ks = Object.keys(c);
    if (ks.length !== 3 || !own(c, "id") || !own(c, "text") || !own(c, "met") || typeof c.met !== "boolean") return null;
    if (c.met !== b.met) changed = true;
  }
  if (!changed) return { changed: false, checked: [] };
  const names = slots();
  const checked: string[] = [];
  for (let t = 0; t < cur.length; t++) if (cur[t]!.met) checked.push(names[t]!);
  return { changed: true, checked };
}

/** カードの変えた所（基準の写しと比べる。時刻は変えたカードだけ、at と違えば書く）。同じなら null */
function diffNode(cur: GNode, base: GNode, at: string, slots: () => readonly string[]): Omit<NodePatch, "was"> | null {
  let f: Obj | null = null;
  let k: string[] | null = null;
  if (cur.type !== base.type) (f ??= {}).type = cur.type;
  if (cur.title !== base.title) (f ??= {}).title = cur.title;
  if (cur.body !== base.body) (f ??= {}).body = cur.body;
  if (cur.status !== base.status) (f ??= {}).status = cur.status;
  if (cur.time !== base.time && !jsonEq(cur.time, base.time)) (f ??= {}).time = cur.time;
  if (cur.conditions !== base.conditions) {
    const t = tickDiff(cur.conditions, base.conditions, slots);
    if (t === null) (f ??= {}).conditions = cur.conditions;
    else if (t.changed) k = t.checked;
  }
  if (!sameStrs(cur.tags, base.tags)) (f ??= {}).tags = cur.tags;
  if (!sameStrs(cur.projectIds, base.projectIds)) (f ??= {}).projectIds = cur.projectIds;
  if (!sameStrs(cur.scenarioIds, base.scenarioIds)) (f ??= {}).scenarioIds = cur.scenarioIds;
  if (cur.x !== base.x) (f ??= {}).x = cur.x;
  if (cur.y !== base.y) (f ??= {}).y = cur.y;
  if (cur.collapsed !== base.collapsed) (f ??= {}).collapsed = cur.collapsed;
  const ex = extrasDiff(cur as unknown as Obj, base as unknown as Obj, NODE_KNOWN, f, null);
  f = ex.f;
  const { m, md } = metaDiff(cur.meta, base.meta);
  if (!f && !ex.fd && !m && !md && !k) return null;
  if (cur.createdAt !== at) (f ??= {}).createdAt = cur.createdAt;
  if (cur.updatedAt !== at) (f ??= {}).updatedAt = cur.updatedAt;
  const p: Omit<NodePatch, "was"> = {};
  if (f) p.f = f;
  if (ex.fd) p.fd = ex.fd;
  if (m) p.m = m;
  if (md) p.md = md;
  if (k) p.k = k;
  return p;
}

/** 親からの同梱の線の変えた所（両端は比べない）。同じなら null */
function diffEdge(cur: GEdge, base: GEdge, at: string): EdgePatch | null {
  let f: Obj | null = null;
  if (cur.relation !== base.relation) (f ??= {}).relation = cur.relation;
  if (cur.label !== base.label) (f ??= {}).label = cur.label;
  if (cur.condition !== base.condition) (f ??= {}).condition = cur.condition;
  if (!sameStrs(cur.scenarioIds, base.scenarioIds)) (f ??= {}).scenarioIds = cur.scenarioIds;
  if (cur.collapsed !== base.collapsed) (f ??= {}).collapsed = cur.collapsed;
  const ex = extrasDiff(cur as unknown as Obj, base as unknown as Obj, EDGE_KNOWN, f, null);
  f = ex.f;
  const { m, md } = metaDiff(cur.meta, base.meta);
  if (!f && !ex.fd && !m && !md) return null;
  if (cur.createdAt !== at) (f ??= {}).createdAt = cur.createdAt;
  if (cur.updatedAt !== at) (f ??= {}).updatedAt = cur.updatedAt;
  const p: EdgePatch = {};
  if (f) p.f = f;
  if (ex.fd) p.fd = ex.fd;
  if (m) p.m = m;
  if (md) p.md = md;
  return p;
}

/** カードの元の題名・短い名前・月（やることを丸ごと書くときは元の番号と文の指紋も） */
function wasOf(v: GNode, withTodo: boolean): CardWas {
  const w: CardWas = { t: v.title, s: typeof v.meta.short === "string" ? v.meta.short : "", m: typeof v.meta.m === "number" ? v.meta.m : 0 };
  if (withTodo) {
    if (Array.isArray(v.meta.cites)) w.c = (v.meta.cites as unknown[]).map(String);
    if (Array.isArray(v.meta.k0)) w.k0 = (v.meta.k0 as unknown[]).map(String);
  }
  return w;
}

/** 今日のカード: meta の futureVersion・futureRelease を基準の物に（gaps-6） */
function withRelease(root: GNode, pb: PageBaseline): GNode {
  if (root.meta.futureVersion === pb.hash && root.meta.futureRelease === pb.release) return root;
  return { ...root, meta: { ...root.meta, futureVersion: pb.hash, futureRelease: pb.release } };
}

/** 文書を薄い形にする。ページの地図が無い文書は null（そのまま書く）。ページの地図はあるが基準が無ければ ThinBaselineMissingError */
export function encodeThin(doc: DocData): { stored: StoredDoc; stats: ThinStats } | null {
  const docNodes = doc.nodes;
  // ノードの入れ物の無い物（文書の形でない物）は、そのまま書く（書き手は作らないが、壊さずに通す）
  if (!docNodes || typeof docNodes !== "object") return null;
  if (!page) {
    for (const id of Object.keys(docNodes)) if (isQuarterRoot(docNodes[id])) throw new ThinBaselineMissingError();
    return null;
  }
  let core = cores.get(page.map);
  if (!core) {
    // 基準をまだ組み立てていない: 今日のカードの時刻で組み立てる（その文書の写しを作らずに済む）
    let at: string | null = null;
    let keyed = 0;
    for (const id of Object.keys(docNodes)) {
      const node = docNodes[id]!;
      if (typeof node.meta?.key !== "string") continue;
      keyed++;
      if (node.meta.forecastRoot === true && node.meta.key === page.map.key(0) && node.meta.anchor === page.anchor) at = node.createdAt;
    }
    // ページの地図が無い（ほかの版・ほかの年月の 3 か月ごとの地図だけなら、その地図は太い形のまま。大きさは保存する側が見張る）。
    // 今日のカードが無くても鍵のカードが多ければ、ページの地図のカードかを確かめる（基準を組み立てて下で数える）
    if (at === null && keyed < ROOTLESS_MAX) return null;
    core = coreOf(page.map, at);
  }
  const n = core.n;
  const ids = core.ids;
  const eids = core.eids;
  const keys = core.keys;
  const lastView = core.views[0];
  // ---- カード: まず基準の ID で引く（地図のカードはほとんどがそのまま）。今日は今日のカードの形の物だけ
  /** 番号ごとのカード（同じ鍵が 2 つ以上なら、後で選ぶまで候補） */
  const cards = new Array<GNode | undefined>(n);
  let found = 0;
  for (let i = 0; i < n; i++) {
    const node = docNodes[ids[i]!];
    if (node === undefined) continue;
    if (node === core.nodes[i] || node === lastView?.nodes[i] || node.meta?.key === keys[i]) {
      if (i === 0 && !isPageRoot(core, node)) continue;
      cards[i] = node;
      found++;
    }
  }
  // 文書の鍵を 1 回だけ数え、入れた順に基準のカードと突き合わせる（順が合わない物だけ表を引く）。合わない物が、利用者のノードか、ID の違うカード
  const nodeIds = Object.keys(docNodes);
  const odd: ID[] = [];
  if (nodeIds.length !== found) {
    let p = 0;
    for (const id of nodeIds) {
      while (p < n && cards[p] === undefined) p++;
      if (p < n && ids[p] === id) {
        p++;
        continue;
      }
      const i = core.idIndex.get(id);
      if (i !== undefined && cards[i] !== undefined && ids[i] === id) continue;
      odd.push(id);
    }
  }
  const dups = new Map<number, GNode[]>();
  /** 鍵で見つけたカード（ID が基準と違うかもしれない） */
  const byKey: number[] = [];
  const others: ID[] = [];
  for (const id of odd) {
    const node = docNodes[id]!;
    const k = node.meta?.key;
    const j = typeof k === "string" ? core.keyIndex.get(k) : undefined;
    if (j === undefined || (j === 0 && !isPageRoot(core, node))) {
      others.push(id);
      continue;
    }
    const cur = cards[j];
    if (cur === undefined) {
      cards[j] = node;
      byKey.push(j);
    } else {
      const list = dups.get(j);
      if (list) list.push(node);
      else dups.set(j, [cur, node]);
    }
  }
  if (cards[0] === undefined) {
    // 今日のカードが無いのにページの地図のカードが多い（壊れた形）: 太い形で書かずに止める
    if (found + byKey.length >= ROOTLESS_MAX) throw new ThinWriteError(`3 か月ごとの地図のカード（${(found + byKey.length).toLocaleString("ja-JP")} 枚）があるのに、今日のカードが見つかりません（地図の本体ごと書くと大きすぎるので書きません）`);
    return null;
  }
  const docEdges = doc.edges;
  const edgeIds = Object.keys(docEdges);
  // 同じ鍵が 2 つ以上: 今日は先へ進む線のある物 → 早く作った物 → ID の順。ほかは madeFirst（入口から道の線でたどる）
  const losers: ID[] = [];
  if (dups.size) {
    const rootDups = dups.get(0);
    if (rootDups) {
      const from = new Set<ID>();
      for (const eid of edgeIds) {
        const e = docEdges[eid]!;
        if (isFlowRel(e) && e.source !== e.target && docNodes[e.target]) from.add(e.source);
      }
      let best = rootDups[0]!;
      for (const r of rootDups.slice(1)) {
        const a = from.has(r.id);
        const b = from.has(best.id);
        if (a !== b ? a : r.createdAt !== best.createdAt ? r.createdAt < best.createdAt : r.id < best.id) best = r;
      }
      cards[0] = best;
      for (const r of rootDups) if (r !== best) losers.push(r.id);
      dups.delete(0);
    }
    if (dups.size) {
      const out = new Map<ID, ID[]>();
      for (const eid of edgeIds) {
        const e = docEdges[eid]!;
        if (!isFlowRel(e) || !docNodes[e.target]) continue;
        const list = out.get(e.source);
        if (list) list.push(e.target);
        else out.set(e.source, [e.target]);
      }
      const depth = new Map<ID, number>([[cards[0]!.id, 0]]);
      const order = [cards[0]!.id];
      for (let q = 0; q < order.length; q++) {
        const d = depth.get(order[q]!)! + 1;
        for (const t of out.get(order[q]!) ?? []) {
          if (depth.has(t)) continue;
          depth.set(t, d);
          order.push(t);
        }
      }
      for (const [i, list] of dups) {
        let best = list[0]!;
        for (const c of list.slice(1)) if (madeFirst(c, best, depth)) best = c;
        cards[i] = best;
        byKey.push(i);
        for (const c of list) if (c !== best) losers.push(c.id);
      }
    }
  }
  const root = cards[0]!;
  // カードの ID → 番号（基準の ID と違うカードだけ。鍵で見つけた物の中にしか無い）
  const nidIndex = new Map<ID, number>();
  for (const i of byKey) {
    const c = cards[i]!;
    if (c.id !== ids[i]) nidIndex.set(c.id, i);
  }
  const indexOfCard = (id: ID): number | undefined => {
    const j = nidIndex.get(id);
    if (j !== undefined) return j;
    const k = core!.idIndex.get(id);
    return k !== undefined && cards[k]?.id === id ? k : undefined;
  };
  // ---- 親からの同梱の線: 基準の ID で引いて両端が合う物。ほかは、親のカードから子のカードへの指紋（c0）のある線（ID が違う同梱の線）
  const bundle = new Array<GEdge | undefined>(n);
  let foundE = 0;
  for (let i = 1; i < n; i++) {
    const c = cards[i];
    if (c === undefined) continue;
    const pc = cards[core.parent[i]!];
    if (pc === undefined) continue;
    const e = docEdges[eids[i]!];
    if (e !== undefined && e.target === c.id && e.source === pc.id) {
      bundle[i] = e;
      foundE++;
    }
  }
  const oddEdges: ID[] = [];
  if (edgeIds.length !== foundE) {
    let p = 1;
    for (const id of edgeIds) {
      while (p < n && bundle[p] === undefined) p++;
      if (p < n && eids[p] === id) {
        p++;
        continue;
      }
      const i = core.eidIndex.get(id);
      if (i !== undefined && bundle[i] !== undefined && eids[i] === id) continue;
      oddEdges.push(id);
    }
  }
  const userEdges: ID[] = [];
  for (const eid of oddEdges) {
    const e = docEdges[eid]!;
    const t = indexOfCard(e.target);
    const s = t !== undefined && t > 0 ? indexOfCard(e.source) : undefined;
    if (t !== undefined && s !== undefined && core.parent[t] === s && bundle[t] === undefined && typeof e.meta?.c0 === "string") bundle[t] = e;
    else userEdges.push(eid);
  }
  // ---- 基準
  const base = inferBase(core, doc, cards, bundle);
  const view = viewOf(core, base);
  // ---- 地図のカードと線の変更
  const nPatch: Record<string, NodePatch | 0 | -1> = {};
  const ePatch: Record<string, EdgePatch | 0> = {};
  const nid: Record<string, ID> = {};
  const eid: Record<string, ID> = {};
  const stats: ThinStats = { cards: 0, patched: 0, tombs: 0, patchedEdges: 0, edgeTombs: 0, nid: 0, eid: 0, pins: 0, storedNodes: 0, storedEdges: 0, fatKeyed: 0, compared: 0 };
  // 消したカード: その先の同梱のカードも全部無ければ 0（一番上だけ）、ほかは −1
  const allGone = new Uint8Array(n);
  for (let i = n - 1; i >= 1; i--) {
    if (cards[i]) continue;
    let gone = 1;
    for (let k = core.kidStart[i]!; k < core.kidStart[i + 1]!; k++)
      if (!allGone[core.kids[k]!]) {
        gone = 0;
        break;
      }
    allGone[i] = gone;
  }
  for (let i = 1; i < n; i++) {
    const c = cards[i];
    const v = view.nodes[i]!;
    if (!c) {
      if (allGone[i]) {
        if (!allGone[core.parent[i]!]) (nPatch[keys[i]!] = 0), stats.tombs++;
      } else (nPatch[keys[i]!] = -1), stats.tombs++;
      continue;
    }
    stats.cards++;
    if (c.id !== v.id) (nid[keys[i]!] = c.id), stats.nid++;
    if (c === v) continue;
    let p = view.memoN.get(c);
    if (p === undefined) {
      stats.compared++;
      p = diffNode(c, v, base.at, () => slotsOf(core!, i));
      view.memoN.set(c, p);
    }
    if (p) {
      const was = wasOf(v, !!p.f && own(p.f, "conditions"));
      // チェックだけ書くときは、チェックした項目の文も（次の版で鍵が無くなったカードに、チェックを文ごと残す）
      if (p.k) was.kt = c.conditions.filter((x) => x.met).map((x) => x.text);
      nPatch[keys[i]!] = { ...p, was };
      stats.patched++;
    }
  }
  for (let i = 1; i < n; i++) {
    if (!cards[i] || !cards[core.parent[i]!]) continue;
    const e = bundle[i];
    if (!e) {
      ePatch[keys[i]!] = 0;
      stats.edgeTombs++;
      continue;
    }
    const v = view.edges[i]!;
    if (e.id !== v.id) (eid[keys[i]!] = e.id), stats.eid++;
    if (e === v) continue;
    let p = view.memoE.get(e);
    if (p === undefined) {
      p = diffEdge(e, v, base.at);
      view.memoE.set(e, p);
    }
    if (p) (ePatch[keys[i]!] = p), stats.patchedEdges++;
  }
  // ---- 丸ごと書くノードと線（今日を先に）。利用者の線が指す地図のカードには印
  const nodesOut: Record<ID, GNode> = {};
  nodesOut[root.id] = withRelease(root, page);
  // 文書の順に（同じ鍵の 2 つ目があるときだけ、順を数え直す）
  let stored = others;
  if (losers.length) {
    const pos = new Map<ID, number>();
    nodeIds.forEach((id, q) => pos.set(id, q));
    stored = [...others, ...losers].sort((a, b) => pos.get(a)! - pos.get(b)!);
  }
  for (const id of stored) {
    const node = docNodes[id]!;
    nodesOut[id] = node;
    if (typeof node.meta?.key === "string" && core.keyIndex.has(node.meta.key)) stats.fatKeyed++;
  }
  stats.storedNodes = stored.length + 1;
  const edgesOut: Record<ID, GEdge> = {};
  const pinned = new Set<number>();
  for (const id of userEdges) {
    const e = docEdges[id]!;
    edgesOut[id] = e;
    const s = indexOfCard(e.source);
    const t = indexOfCard(e.target);
    if (s !== undefined && s > 0) pinned.add(s);
    if (t !== undefined && t > 0) pinned.add(t);
  }
  stats.storedEdges = userEdges.length;
  const pin: Record<string, CardPin> = {};
  for (const i of [...pinned].sort((a, b) => a - b)) {
    const v = view.nodes[i]!;
    pin[keys[i]!] = { t: v.title, s: typeof v.meta.short === "string" ? v.meta.short : "", m: typeof v.meta.m === "number" ? v.meta.m : 0 };
  }
  stats.pins = pinned.size;
  const section: ThinSection = {
    v: THIN_SECTION_V,
    root: root.id,
    key: keys[0]!,
    release: page.release,
    hash: page.hash,
    digest: pageDigest(page),
    bv: THIN_BASELINE_VERSION,
    anchor: page.anchor,
    at: base.at,
    dx: base.dx,
    dy: base.dy,
  };
  const pmap = compactMap(base.pmap);
  if (pmap) section.pmap = pmap;
  const smap = compactMap(base.smap);
  if (smap) section.smap = smap;
  if (Object.keys(nPatch).length) section.n = nPatch;
  if (Object.keys(ePatch).length) section.e = ePatch;
  if (stats.nid) section.nid = nid;
  if (stats.eid) section.eid = eid;
  if (stats.pins) section.pin = pin;
  const out: StoredDoc = { ...doc, version: THIN_VERSION, nodes: nodesOut, edges: edgesOut, maps: [section] };
  return { stored: out, stats };
}

// ---------------------------------------------------------------- 読む（薄い形 → 文書）

/** 薄い形の文書の形か（版 2 以上か、maps がある。読めなければ止める側: safety-3） */
export function isThinShape(raw: unknown): boolean {
  return isObj(raw) && ((typeof raw.version === "number" && raw.version >= THIN_VERSION) || own(raw, "maps"));
}

const corrupt = (what: string, release?: number | null): ThinMapError => new ThinMapError("corrupt", `保存されている地図の変更の形が読めません（${what}）。保存されているデータには触れていません。`, { release: release ?? null });
const mismatch = (what: string, release: number): ThinMapError =>
  new ThinMapError("mismatch", `保存されている地図が、このページの地図と合いません（${what}）。保存されているデータには触れていません。ページを開き直すか、保存されているデータを書き出してください。`, { release });

const validId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 100 && !/\s/.test(v) && !(v in Object.prototype);
const strList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
/** JSON の辞書（組み込みの名前の鍵は使わない） */
function dict(v: unknown, what: string): Obj {
  if (!isObj(v)) throw corrupt(what);
  for (const k of Object.keys(v)) if (k === "__proto__" || k === "constructor" || k === "prototype") throw corrupt(what);
  return v;
}

/** maps[0] の形を確かめる（版の順番を見る前に、版の順番・印の形だけ先に読む） */
function parseSection(raw: unknown): ThinSection {
  const s = dict(raw, "地図の変更");
  const release = s.release;
  if (typeof release !== "number" || !Number.isInteger(release) || release < 0) throw corrupt("版の順番");
  if (typeof s.v !== "number" || !Number.isInteger(s.v)) throw corrupt("形の版", release);
  if (s.v > THIN_SECTION_V) throw new ThinNewerError(release, "この地図は新しい版のページで保存されています（地図の変更の形が新しい）。ページを開き直してください（保存されているデータには触れていません）。");
  if (s.v !== THIN_SECTION_V) throw corrupt("形の版", release);
  for (const k of ["key", "hash", "digest", "anchor", "at"] as const) if (typeof s[k] !== "string") throw corrupt(k, release);
  if (!validId(s.root)) throw corrupt("今日の ID", release);
  if (typeof s.bv !== "number" || !Number.isInteger(s.bv)) throw corrupt("組み立ての版", release);
  if (!isoOk(s.at)) throw corrupt("時刻", release);
  for (const k of ["dx", "dy"] as const) if (typeof s[k] !== "number" || !Number.isFinite(s[k])) throw corrupt(k, release);
  const idMap = (k: "pmap" | "smap"): void => {
    if (s[k] === undefined) return;
    const m = dict(s[k], k);
    for (const x of Object.keys(m)) if (m[x] !== null && !validId(m[x])) throw corrupt(k, release);
  };
  idMap("pmap");
  idMap("smap");
  const patchOk = (p: Obj, node: boolean): boolean => {
    for (const k of Object.keys(p)) if (!(node ? ["f", "fd", "m", "md", "k", "was"] : ["f", "fd", "m", "md"]).includes(k)) return false;
    if (p.f !== undefined && (!isObj(p.f) || own(p.f, "id") || own(p.f, "meta") || own(p.f, "source") || own(p.f, "target"))) return false;
    if (p.m !== undefined && !isObj(p.m)) return false;
    for (const k of ["fd", "md", "k"]) if (p[k] !== undefined && !strList(p[k])) return false;
    if (node) {
      const w = p.was;
      if (!isObj(w) || typeof w.t !== "string" || typeof w.s !== "string" || typeof w.m !== "number") return false;
      if ((w.c !== undefined && !strList(w.c)) || (w.k0 !== undefined && !strList(w.k0)) || (w.kt !== undefined && !strList(w.kt))) return false;
      if (p.k !== undefined && p.f !== undefined && own(p.f as Obj, "conditions")) return false;
    }
    return true;
  };
  if (s.n !== undefined) {
    const m = dict(s.n, "カードの変更");
    for (const k of Object.keys(m)) {
      const p = m[k];
      if (p !== 0 && p !== -1 && !(isObj(p) && patchOk(p, true))) throw corrupt("カードの変更", release);
    }
  }
  if (s.e !== undefined) {
    const m = dict(s.e, "線の変更");
    for (const k of Object.keys(m)) {
      const p = m[k];
      if (p !== 0 && !(isObj(p) && patchOk(p, false))) throw corrupt("線の変更", release);
    }
  }
  for (const k of ["nid", "eid"] as const) {
    if (s[k] === undefined) continue;
    const m = dict(s[k], k);
    for (const x of Object.keys(m)) if (!validId(m[x])) throw corrupt(k, release);
  }
  if (s.pin !== undefined) {
    const m = dict(s.pin, "印");
    for (const x of Object.keys(m)) {
      const p = m[x];
      if (!isObj(p) || typeof p.t !== "string" || typeof p.s !== "string" || typeof p.m !== "number") throw corrupt("印", release);
    }
  }
  return s as unknown as ThinSection;
}

/** 当てる: カードの変えた所（読み替えた ID で） */
function applyNode(v: GNode, p: NodePatch, id: ID, slots: readonly string[]): GNode {
  const out: Obj = { ...v, id };
  if (p.f) for (const k of Object.keys(p.f)) out[k] = p.f[k];
  if (p.fd) for (const k of p.fd) if (!NODE_KNOWN.has(k)) delete out[k];
  if (p.m || p.md) {
    const meta: Obj = { ...v.meta };
    if (p.m) for (const k of Object.keys(p.m)) meta[k] = p.m[k];
    if (p.md) for (const k of p.md) delete meta[k];
    out.meta = meta;
  }
  if (p.k) {
    const on = new Set(p.k);
    out.conditions = v.conditions.map((c, t) => (on.has(slots[t]!) === c.met ? c : { ...c, met: on.has(slots[t]!) }));
  }
  return out as unknown as GNode;
}

/** 当てる: 線の変えた所（両端はカードの ID） */
function applyEdge(v: GEdge, p: EdgePatch | undefined, id: ID, source: ID, target: ID): GEdge {
  if (!p && id === v.id && source === v.source && target === v.target) return v;
  const out: Obj = { ...v, id, source, target };
  if (p?.f) for (const k of Object.keys(p.f)) out[k] = p.f[k];
  if (p?.fd) for (const k of p.fd) if (!EDGE_KNOWN.has(k)) delete out[k];
  if (p && (p.m || p.md)) {
    const meta: Obj = { ...v.meta };
    if (p.m) for (const k of Object.keys(p.m)) meta[k] = p.m[k];
    if (p.md) for (const k of p.md) delete meta[k];
    out.meta = meta;
  }
  return out as unknown as GEdge;
}

/**
 * 違う版・違う組み立ての地図の変更を、ページの地図に鍵で当て直すか（版をまたぐ読み方: SPEC §6・D10・D11、R0 §6.2）:
 *   older 前の版の地図だけ当て直す（既定。地図はいつもページの版で開く）・any 同じ版で合わない物も（「この版で開き直す」・取り込み）・none しない
 */
export type ThinUpgradeMode = "none" | "older" | "any";

export interface ThinDecodeOpts {
  upgrade?: ThinUpgradeMode;
}

/** 当て直したときの数（知らせに使う） */
export interface ThinUpgradeInfo {
  from: { release: number; hash: string };
  to: { release: number; hash: string };
  /** 鍵でページの地図のカードに当てた、書き換えたカード */
  applied: number;
  /** 消してあったカード（ページの地図のカードとして戻った。一番上だけ数える） */
  restored: number;
  /** ページの地図に無くなったカードで、利用者の物（選んだ・書き換えた・チェックした・線でつないだ）を持つ物（「前の版で決めたこと」に残した） */
  detached: number;
  /** 当てられなかったやることのチェック（ページの地図の同じカードに、同じ元の番号の項目が無い） */
  lostTicks: number;
  /** 当てられなかった同梱の線の変更（子の鍵がページの地図に無い） */
  droppedEdges: number;
  /** 版 6 までの地図（太い形）から引き上げた内訳（./legacyMap.ts。無ければ、薄い形の版をまたいだ当て直し） */
  legacy?: LegacyUpgradeDetail;
}

/**
 * 利用者の物を持つカードの数。選んだ手・見送った手は状態で数え、そのほかのカード（cards − picks − drops 枚）だけを、
 * チェック・書き換え・線の種類ごとに数える（そのほかの 1 枚が 2 つの種類に入ることもある）
 */
export interface CardCounts {
  /** カードの枚数 */
  cards: number;
  /** そのうち選んだ手（進める・済み） */
  picks: number;
  /** 見送った手 */
  drops: number;
  /** そのほかのうち、やることをチェックしたカード */
  ticks: number;
  /** そのほかのうち、書き換えたカード（題名・本文・やること・タグ・見込みや線の説明・利用者の meta） */
  edits: number;
  /** そのほかのうち、利用者の線（利用者のカードへの線も）がつながるカード */
  links: number;
}

/** 版 6 までの地図（太い形）を、ページの 3 か月ごとの地図に引き上げたときの内訳（知らせの文に、そのままの数で出す: user-6） */
export interface LegacyUpgradeDetail {
  /** 鍵がそのまま残ったカード（最初の手・3 か月後。今日を除く）で、利用者の物を引き継いだ物 */
  kept: CardCounts;
  /** 3 か月後の手を、ページの地図の最初の 3 か月の同じ手へ移した物（利用者の物を持つ物） */
  moved: CardCounts;
  /** 「前の版で決めたこと」に別のカードとして残した物 */
  detached: CardCounts;
  /** 移した先の手を選ぶ年月（「2027 年 2 月」） */
  movedAt: string;
}

/** 読んだ結果（当て直したときは upgrade に数） */
export interface ThinDecoded {
  doc: DocData;
  report: NormalizeReport;
  upgrade?: ThinUpgradeInfo;
}

/**
 * 薄い形の文書を読む（新しい入れ物の文書と、保存したノードと線を整えた報告）。読めなければ ThinMapError か ThinNewerError・NewerDocError
 * （どれも止める側の失敗）。読み手を通さない失敗も、ここで ThinMapError（corrupt）にまとめる。
 * 前の版の地図は、鍵でページの地図に当て直して読む（opts.upgrade。既定 older）。同じ版で合わない物は、any のときだけ当て直す
 */
export function decodeThin(raw: unknown, opts: ThinDecodeOpts = {}): ThinDecoded {
  try {
    return decodeThinInner(raw, opts.upgrade ?? "older");
  } catch (e) {
    if (e instanceof ThinMapError || e instanceof NewerDocError) throw e;
    throw new ThinMapError("corrupt", `保存されている地図を読めませんでした（${e instanceof Error ? e.message : String(e)}）。保存されているデータには触れていません。`, { cause: e });
  }
}

/** 薄い形の記録の地図の変更（maps[0]）を、形だけ確かめて読む（無ければ null。2 つ以上・読めない形は ThinMapError） */
export function sectionOf(raw: unknown): ThinSection | null {
  if (!isObj(raw)) return null;
  const maps = raw.maps;
  if (maps === undefined || (Array.isArray(maps) && maps.length === 0)) return null;
  if (!Array.isArray(maps)) throw corrupt("maps");
  if (maps.length !== 1) throw new ThinMapError("corrupt", "保存されている地図の変更が 2 つ以上あります（このページは 1 つだけ読めます）。保存されているデータには触れていません。");
  return parseSection(maps[0]);
}

function decodeThinInner(raw: unknown, mode: ThinUpgradeMode): ThinDecoded {
  if (!isObj(raw)) throw corrupt("文書");
  if (raw.schema !== SCHEMA) throw corrupt("schema");
  const v = typeof raw.version === "number" && Number.isFinite(raw.version) ? Math.floor(raw.version) : NaN;
  if (Number.isNaN(v)) throw corrupt("版");
  if (v > THIN_VERSION) throw new NewerDocError(v);
  const rest: Obj = { ...raw };
  delete rest.maps;
  const s = sectionOf(raw);
  if (!s) {
    // 地図の無い版 2（書き手は書かないが、読めるので読む）
    return normalizeDoc({ ...rest, version: 1 });
  }
  const pb = page;
  if (!pb) throw new ThinMapError("unavailable", "このページでは、保存されている地図を組み立てられません（ページに地図の同梱データがありません）。ページを開き直してください。保存されているデータには触れていません。", { release: s.release });
  if (s.release > pb.release) throw new ThinNewerError(s.release);
  if (s.release < pb.release) {
    if (mode === "none") throw new ThinMapError("older", `保存されている地図は前の版（版 ${s.release}）の物です。このページ（版 ${pb.release}）では、そのままでは読めません。保存されているデータには触れていません。`, { release: s.release });
    return rebaseThin(rest, s, pb);
  }
  try {
    return decodeExact(rest, s, pb);
  } catch (e) {
    // 同じ版で合わない（違う組み立て・知らない鍵）: 頼まれたときだけ、鍵で当て直す（「この版で開き直す」・取り込み）
    if (mode === "any" && e instanceof ThinMapError && e.code === "mismatch") return rebaseThin(rest, s, pb);
    throw e;
  }
}

/** 同じ版・同じ組み立ての地図の変更を、そのまま当てて読む（合わなければ ThinMapError mismatch: 閉じて失敗する） */
function decodeExact(rest: Obj, s: ThinSection, pb: PageBaseline): ThinDecoded {
  if (s.hash !== pb.hash) throw mismatch("中身の指紋", s.release);
  if (s.bv !== THIN_BASELINE_VERSION) throw mismatch("組み立ての版", s.release);
  if (s.anchor !== pb.anchor) throw mismatch("地図の年月", s.release);
  const core = coreOf(pb.map, s.at);
  if (s.digest !== pageDigest(pb)) throw mismatch("基準の文書の指紋", s.release);
  if (s.key !== core.keys[0]) throw mismatch("今日の鍵", s.release);
  const n = core.n;
  const keys = core.keys;
  const known = (k: string, what: string, rootOk = false): number => {
    const i = core.keyIndex.get(k);
    if (i === undefined || (i === 0 && !rootOk)) throw mismatch(`知らない鍵の${what}: ${k.slice(0, 80)}`, s.release);
    return i;
  };
  // 基準のプロジェクト・シナリオの読み替え（無ければ同じ ID）。読み替えた先は文書にあること
  const projects = isObj(rest.projects) ? rest.projects : {};
  const scenarios = isObj(rest.scenarios) ? rest.scenarios : {};
  const fullMap = (list: ReadonlyArray<{ id: ID }>, m: Record<ID, ID | null> | undefined, have: Obj, what: string): Record<ID, ID | null> => {
    const out: Record<ID, ID | null> = {};
    for (const x of Object.keys(m ?? {})) if (!list.some((g) => g.id === x)) throw mismatch(`知らない${what}の読み替え: ${x}`, s.release);
    for (const g of list) {
      const t = m && own(m, g.id) ? m[g.id]! : g.id;
      if (t !== null && !own(have, t)) throw mismatch(`${what}の読み替えの先が文書にありません: ${t}`, s.release);
      out[g.id] = t;
    }
    return out;
  };
  const base: MapBase = { at: s.at, dx: s.dx, dy: s.dy, pmap: fullMap(core.projects, s.pmap, projects, "プロジェクト"), smap: fullMap(core.scenarios, s.smap, scenarios, "シナリオ") };
  const view = viewOf(core, base);
  // 消したカード
  const gone = new Uint8Array(n);
  const nPatch = s.n ?? {};
  const stack: number[] = [];
  for (const k of Object.keys(nPatch)) {
    const i = known(k, "カードの変更");
    const p = nPatch[k]!;
    if (p === 0) stack.push(i);
    else if (p === -1) gone[i] = 1;
  }
  while (stack.length) {
    const i = stack.pop()!;
    gone[i] = 1;
    for (let k = core.kidStart[i]!; k < core.kidStart[i + 1]!; k++) stack.push(core.kids[k]!);
  }
  for (const k of Object.keys(nPatch)) {
    const p = nPatch[k]!;
    if (p !== 0 && p !== -1 && gone[core.keyIndex.get(k)!]) throw mismatch(`消したカードの変更: ${k.slice(0, 80)}`, s.release);
  }
  // カードの ID（今日は保存した ID、ほかは読み替えか基準の ID）。重なれば読まない
  const idOf = new Array<ID | undefined>(n);
  idOf[0] = s.root;
  const nidIndex = new Map<ID, number>();
  for (const k of Object.keys(s.nid ?? {})) {
    const i = known(k, "ID の読み替え");
    if (gone[i]) throw mismatch(`消したカードの ID の読み替え: ${k.slice(0, 80)}`, s.release);
    const id = s.nid![k]!;
    if (nidIndex.has(id) || id === s.root) throw corrupt("カードの ID が重なっています", s.release);
    nidIndex.set(id, i);
  }
  for (let i = 1; i < n; i++) if (!gone[i]) idOf[i] = s.nid?.[keys[i]!] ?? view.nodes[i]!.id;
  const cardAt = (id: ID): number | undefined => {
    const j = nidIndex.get(id);
    if (j !== undefined) return j;
    if (id === s.root) return 0;
    const k = core.idIndex.get(id);
    return k !== undefined && k > 0 && !gone[k] && idOf[k] === id ? k : undefined;
  };
  for (const [id, i] of nidIndex) {
    const k = core.idIndex.get(id);
    if (k !== undefined && k !== i && !gone[k] && idOf[k] === id) throw corrupt("カードの ID が重なっています", s.release);
  }
  if (core.idIndex.get(s.root) !== undefined && core.idIndex.get(s.root) !== 0 && !gone[core.idIndex.get(s.root)!] && idOf[core.idIndex.get(s.root)!] === s.root) throw corrupt("今日の ID が重なっています", s.release);
  // 保存したノードと線（今日・利用者の物）
  const rawNodes = dict(rest.nodes ?? {}, "nodes");
  const rawEdges = dict(rest.edges ?? {}, "edges");
  const refOf = (key: string, value: unknown): string => (isObj(value) && (typeof value.id === "string" || typeof value.id === "number") ? String(value.id) : key);
  const storedIds = new Set<string>();
  for (const k of Object.keys(rawNodes)) {
    const ref = refOf(k, rawNodes[k]);
    if (ref !== s.root && cardAt(ref) !== undefined) throw corrupt(`保存したノードの ID がカードと重なっています: ${ref.slice(0, 40)}`, s.release);
    storedIds.add(ref);
  }
  const rootRaw = Object.keys(rawNodes)
    .map((k) => rawNodes[k])
    .find((x) => isObj(x) && x.id === s.root);
  if (!isObj(rootRaw) || !isObj(rootRaw.meta) || rootRaw.meta.key !== keys[0]) throw mismatch("今日のカードがありません", s.release);
  const endOk = (v: unknown): boolean => {
    const r = typeof v === "number" && Number.isFinite(v) ? String(v) : v;
    return typeof r === "string" && (storedIds.has(r) || cardAt(r) !== undefined);
  };
  for (const k of Object.keys(rawEdges)) {
    const e = rawEdges[k];
    if (!isObj(e)) continue;
    // 利用者の線の端は、保存したノードか読んだカード（無ければ基準が変わった: 黙って線を捨てない。safety-4）
    if (!endOk(e.source ?? e.from) || !endOk(e.target ?? e.to)) throw mismatch(`線の端のカードが見つかりません: ${String(e.id ?? k).slice(0, 40)}`, s.release);
  }
  // 印・線の変更・線の ID の読み替え: 知らない鍵は読まない。印と元の題名は、同じ版の基準と同じはず（違えば基準の中身が変わった）
  const sameWas = (i: number, w: { t: string; s: string; m: number }): boolean => {
    const vn = view.nodes[i]!;
    return w.t === vn.title && w.s === (typeof vn.meta.short === "string" ? vn.meta.short : "") && w.m === (typeof vn.meta.m === "number" ? vn.meta.m : 0);
  };
  for (const k of Object.keys(s.pin ?? {})) {
    const i = known(k, "印");
    if (gone[i]) throw mismatch(`消したカードの印: ${k.slice(0, 80)}`, s.release);
    if (!sameWas(i, s.pin![k]!)) throw mismatch(`印の題名が基準と違います: ${k.slice(0, 80)}`, s.release);
  }
  const ePatch = s.e ?? {};
  for (const k of Object.keys(ePatch)) {
    const i = known(k, "線の変更");
    if (gone[i] || gone[core.parent[i]!]) throw mismatch(`消したカードの線の変更: ${k.slice(0, 80)}`, s.release);
  }
  /** 線の ID（読み替えた物だけ。番号ごと） */
  const eidOver = new Array<ID | undefined>(n);
  const eidIndex = new Map<ID, number>();
  for (const k of Object.keys(s.eid ?? {})) {
    const i = known(k, "線の ID の読み替え");
    if (gone[i] || gone[core.parent[i]!] || ePatch[k] === 0) throw mismatch(`消した線の ID の読み替え: ${k.slice(0, 80)}`, s.release);
    const id = s.eid![k]!;
    if (eidIndex.has(id)) throw corrupt("線の ID が重なっています", s.release);
    eidIndex.set(id, i);
    eidOver[i] = id;
  }
  const edgeIdOf = (i: number): ID => eidOver[i] ?? view.edges[i]!.id;
  const edgeLive = (i: number): boolean => !gone[i] && !gone[core.parent[i]!] && ePatch[keys[i]!] !== 0;
  for (const [id, i] of eidIndex) {
    const k = core.eidIndex.get(id);
    if (k !== undefined && k !== i && edgeLive(k) && edgeIdOf(k) === id) throw corrupt("線の ID が重なっています", s.release);
  }
  for (const k of Object.keys(rawEdges)) {
    const ref = refOf(k, rawEdges[k]);
    const j = eidIndex.get(ref) ?? core.eidIndex.get(ref);
    if (j !== undefined && edgeLive(j) && edgeIdOf(j) === ref) throw corrupt(`保存した線の ID が地図の線と重なっています: ${ref.slice(0, 40)}`, s.release);
  }
  // 書き換えたカードと線を作り、保存したノードと線と一緒に整える（地図のほかのカードの ID は外にある物として、線を残す）
  const nodesIn: Obj = { [s.root]: rootRaw };
  for (const k of Object.keys(rawNodes)) if (rawNodes[k] !== rootRaw) nodesIn[k] = rawNodes[k];
  const patched = new Uint8Array(n);
  for (const k of Object.keys(nPatch)) {
    const p = nPatch[k]!;
    if (p === 0 || p === -1) continue;
    const i = core.keyIndex.get(k)!;
    const slots = slotsOf(core, i);
    if (p.k) for (const x of p.k) if (!slots.includes(x)) throw mismatch(`知らないやることのチェック: ${k.slice(0, 60)} / ${x.slice(0, 40)}`, s.release);
    if (!sameWas(i, p.was)) throw mismatch(`元の題名が基準と違います: ${k.slice(0, 80)}`, s.release);
    nodesIn[idOf[i]!] = applyNode(view.nodes[i]!, p, idOf[i]!, slots);
    patched[i] = 1;
  }
  const edgesIn: Obj = { ...rawEdges };
  const patchedE = new Uint8Array(n);
  for (const k of Object.keys(ePatch)) {
    const p = ePatch[k]!;
    if (p === 0) continue;
    const i = core.keyIndex.get(k)!;
    const id = edgeIdOf(i);
    edgesIn[id] = applyEdge(view.edges[i]!, p, id, idOf[core.parent[i]!]!, idOf[i]!);
    patchedE[i] = 1;
  }
  const norm = normalizeDoc({ ...rest, version: 1, nodes: nodesIn, edges: edgesIn }, { externalNodeIds: (id) => cardAt(id) !== undefined });
  const nd = norm.doc;
  // 読み替えたプロジェクト・シナリオは、整えた後も文書にあること（無いのに当てると、カードが無いプロジェクトを指す）
  for (const t of Object.values(base.pmap)) if (t !== null && !own(nd.projects, t)) throw corrupt(`プロジェクトの読み替えの先: ${t}`, s.release);
  for (const t of Object.values(base.smap)) if (t !== null && !own(nd.scenarios, t)) throw corrupt(`シナリオの読み替えの先: ${t}`, s.release);
  // 新しい入れ物: 今日 → 地図のカード（番号の順）→ 保存したノード、地図の線（番号の順）→ 保存した線
  const nodes: Record<ID, GNode> = {};
  const rootNode = nd.nodes[s.root];
  // 今日のカードはページの地図の入口の形であること（入口でなくなった今日は、次に書くとき地図ごと太い形になる）
  if (!rootNode || !isPageRoot(core, rootNode)) throw mismatch("今日のカードがページの地図の入口の形ではありません", s.release);
  nodes[s.root] = withRelease(rootNode, pb);
  for (let i = 1; i < n; i++) {
    const id = idOf[i];
    if (id === undefined) continue;
    if (patched[i]) {
      const x = nd.nodes[id];
      if (!x) throw corrupt(`書き換えたカードを読めません: ${keys[i]!.slice(0, 60)}`, s.release);
      nodes[id] = x;
    } else {
      const vn = view.nodes[i]!;
      nodes[id] = id === vn.id ? vn : { ...vn, id };
    }
  }
  for (const id of Object.keys(nd.nodes)) if (!own(nodes, id)) nodes[id] = nd.nodes[id]!;
  const edges: Record<ID, GEdge> = {};
  for (let i = 1; i < n; i++) {
    if (!edgeLive(i)) continue;
    const id = edgeIdOf(i);
    if (patchedE[i]) {
      const x = nd.edges[id];
      if (!x) throw corrupt(`書き換えた線を読めません: ${keys[i]!.slice(0, 60)}`, s.release);
      edges[id] = x;
    } else edges[id] = applyEdge(view.edges[i]!, undefined, id, idOf[core.parent[i]!]!, idOf[i]!);
  }
  for (const id of Object.keys(nd.edges)) if (!own(edges, id)) edges[id] = nd.edges[id]!;
  const doc: DocData = { ...nd, nodes, edges };
  return { doc, report: norm.report };
}

// ---------------------------------------------------------------- 版をまたいで読む（前の版・違う組み立ての地図の変更を、ページの地図に鍵で当て直す）
//
// 作業メモ SPEC v1 §6（D10・D11・safety-5・safety-7・safety-8）・R0 §6.2。保存した物とページの地図だけから決まる（乱数・今の時刻を使わない）。
// 文書の id と updatedAt は変えない（どの端末も「新しい版にした」を変更として送らない）。
//   - 鍵がページの地図にあるカード: ページの地図のカードに、利用者の物（状態・書き換えた題名と本文・やることのチェック（元の番号と枠で）・
//     自分で直したやること・付けたタグ・期限・プロジェクトとシナリオ・折りたたみ・利用者の meta）を当てる。ID の読み替えは残す（利用者の線がつながったまま）
//   - 同梱の線の変更: 子の鍵がページの地図にあれば、直した見込み（%）・書き換えた説明と条件・関係を当てる
//   - 消したカード・線: 戻す（今までの「自分で消したカードは戻る」と同じ）。同じ 2 枚の間に利用者が引き直した線があれば、線は戻さない
//   - 鍵がページの地図に無くなったカード: 利用者の物を持つ物（と、利用者の線・利用者のカードがつながる物）を、鍵の無い利用者のカードとして
//     「前の版で決めたこと」の見出しの下（今日の左）に残す。題名・本文・状態・やること（チェックした項目は文ごと）・利用者の線はそのまま
//   - 今日（丸ごと保存してある）: ページの地図の今日に、利用者の物（書き換えた題名と本文・状態・付けたタグ・位置・年収）を当てる

/** 組み立てが作るカードの meta（版が変われば新しい版の物にする。利用者の meta とは分ける。版 6 の組み立ての物も含む） */
export const BUILDER_NODE_META: ReadonlySet<string> = new Set([
  "forecastRoot",
  "futureVersion",
  "futureRelease",
  "impact",
  "anchor",
  "textVersion",
  "never",
  "fams",
  "fork",
  "m",
  "short",
  "st",
  "rr",
  "key",
  "t0",
  "b0",
  "k0",
  "ak",
  "fam",
  "h",
  "why",
  "stub",
  "base",
  "cites",
  "rank",
  "q",
  "band",
  "end",
  "sum",
]);
/** 組み立てが作る線の meta（直した見込み prob は利用者の物として当てる） */
export const BUILDER_EDGE_META: ReadonlySet<string> = new Set(["r", "ln", "rv", "p0", "c0"]);

const NODE_TYPES = new Set<string>(NODE_TYPE_ORDER);
const NODE_STATUSES = new Set<string>(STATUS_ORDER);

/** 「前の版で決めたこと」の見出しの題名 */
export const PREV_GROUP_TITLE = "前の版で決めたこと";
/** 「前の版で決めたこと」の見出し・カードを置く所（今日の左。列の幅と行の高さ）と、ほかのカードとあける間 */
const PREV_GROUP_DX = -1400;
export const PREV_ROW = 140;
const PREV_GAP = 60;

/**
 * 「前の版で決めたこと」の列（見出しとその下の rows 枚）の横の位置（カードの中心）。今日（rx, ry）の左に置き、ほかのカード（others。
 * 地図のカードは除く）と重なれば、重なったカードのさらに左へずらす（どの端末でも同じ位置: 文書の中身だけで決まる）
 */
export function prevColumnX(rx: number, ry: number, rows: number, others: ReadonlyArray<{ x: number; y: number }>): number {
  const top = ry - NODE_H / 2 - PREV_GAP;
  const bottom = ry + PREV_ROW * rows + NODE_H / 2 + PREV_GAP;
  const band = others.filter((o) => o.y + NODE_H / 2 >= top && o.y - NODE_H / 2 <= bottom);
  let x = Math.round(rx + PREV_GROUP_DX);
  for (let guard = 0; guard <= band.length; guard++) {
    let hit: number | null = null;
    for (const o of band) if (Math.abs(o.x - x) < NODE_W + PREV_GAP && (hit === null || o.x < hit)) hit = o.x;
    if (hit === null) return x;
    x = Math.floor(hit - NODE_W - PREV_GAP);
  }
  return x;
}

/**
 * 「前の版で決めたこと」の見出しのカード（その下に、地図から無くなったカードで利用者の物を持つ物を並べる）。
 * from: 前の版の版の順番・to: ページの地図の版の順番・at: 作った時刻（保存してあった物から決める）
 */
export function prevGroupCard(id: ID, from: number, to: number, x: number, y: number, at: string): GNode {
  return {
    id,
    type: "goal",
    title: PREV_GROUP_TITLE,
    body: `地図が新しい版（版 ${to}）になり、前の版（版 ${from}）の地図から無くなったカードのうち、あなたが選んだ・見送った・書き換えた・チェックした・タグや線を付けたカードです（カードの中身は前の版のまま）。`,
    status: "open",
    time: { due: null, start: null },
    conditions: [],
    tags: [],
    projectIds: [],
    scenarioIds: [],
    x,
    y,
    collapsed: false,
    createdAt: at,
    updatedAt: at,
    meta: { prevGroup: from },
  };
}

/**
 * 基準のプロジェクト・シナリオ（list）を文書の物（have）へ: 保存した読み替え（m）があればそれ、無ければ同じ ID、同じ名前、無い（null）。
 * 読み替えの先は文書にある物だけ
 */
export function looseIdMap(list: ReadonlyArray<{ id: ID; name: string }>, m: Record<ID, ID | null> | undefined, have: Readonly<Record<string, unknown>>): Record<ID, ID | null> {
  const byName = new Map<string, ID>();
  for (const id of Object.keys(have)) {
    const g = have[id];
    const name = isObj(g) && typeof g.name === "string" ? nameKey(g.name) : null;
    if (name !== null && !byName.has(name)) byName.set(name, id);
  }
  const out: Record<ID, ID | null> = {};
  for (const g of list) {
    let t: ID | null = m && own(m, g.id) ? m[g.id]! : own(have, g.id) ? g.id : (byName.get(nameKey(g.name)) ?? null);
    if (t !== null && !own(have, t)) t = null;
    out[g.id] = t;
  }
  return out;
}

/** 書き換えたカードが利用者の物を持つか（鍵が無くなったときに残す物）。位置・折りたたみ・時刻だけの変更は持たない */
function carriesUserState(p: NodePatch): boolean {
  const f = (p.f ?? {}) as Obj;
  if (typeof f.status === "string" && f.status !== "open") return true;
  if ((p.k?.length ?? 0) > 0) return true;
  if (typeof f.title === "string" || (typeof f.body === "string" && f.body !== "")) return true;
  if (Array.isArray(f.conditions) || Array.isArray(f.tags)) return true;
  return Object.keys(p.m ?? {}).some((k) => !BUILDER_NODE_META.has(k));
}

/** ページの地図のカードに、前の版の変更のうち利用者の物を当てる（位置は新しい地図の物のまま）。整える前の形を返す */
function carryNode(v: GNode, p: NodePatch, id: ID, slots: readonly string[], info: ThinUpgradeInfo): Obj {
  const f = (p.f ?? {}) as Obj;
  const out: Obj = { ...v, id };
  for (const k of ["type", "title", "body", "status", "time", "collapsed", "createdAt", "updatedAt", "projectIds", "scenarioIds"] as const) if (own(f, k)) out[k] = f[k];
  // 新しい版の書き手が足した項目（知らない項目）は持ち越す
  for (const k of Object.keys(f)) if (!NODE_KNOWN.has(k)) out[k] = f[k];
  if (own(f, "conditions")) out.conditions = f.conditions;
  else if (p.k) {
    const on = new Set(p.k);
    out.conditions = v.conditions.map((c, t) => (on.has(slots[t]!) && !c.met ? { ...c, met: true } : c));
    for (const x of on) if (!slots.includes(x)) info.lostTicks++;
  }
  if (own(f, "tags") && Array.isArray(f.tags)) {
    // 付けたタグ（前の版で役割と月から付いたタグでも、新しい版で付くタグでもない物）だけを、新しい版のタグの後ろに
    const given = new Set([...impactTagsOf({ ...v.meta, m: p.was.m }), ...v.tags]);
    const mine = (f.tags as unknown[]).filter((t): t is string => typeof t === "string" && !given.has(t));
    out.tags = mine.length ? [...v.tags, ...mine] : v.tags;
  }
  if (p.m || p.md) {
    const meta: Obj = { ...v.meta };
    for (const k of Object.keys(p.m ?? {})) if (!BUILDER_NODE_META.has(k)) meta[k] = p.m![k];
    for (const k of p.md ?? []) if (!BUILDER_NODE_META.has(k)) delete meta[k];
    out.meta = meta;
  }
  return out;
}

/** ページの地図の同梱の線に、前の版の変更のうち利用者の物（直した見込み・説明・条件・関係・シナリオ・折りたたみ）を当てる */
function carryEdge(v: GEdge, p: EdgePatch, id: ID, source: ID, target: ID): Obj {
  const f = (p.f ?? {}) as Obj;
  const out: Obj = { ...v, id, source, target };
  for (const k of ["relation", "label", "condition", "scenarioIds", "collapsed", "createdAt", "updatedAt"] as const) if (own(f, k)) out[k] = f[k];
  for (const k of Object.keys(f)) if (!EDGE_KNOWN.has(k)) out[k] = f[k];
  if (p.m || p.md) {
    const meta: Obj = { ...v.meta };
    for (const k of Object.keys(p.m ?? {})) if (!BUILDER_EDGE_META.has(k)) meta[k] = p.m![k];
    for (const k of p.md ?? []) if (!BUILDER_EDGE_META.has(k)) delete meta[k];
    out.meta = meta;
  }
  return out;
}

/** 鍵が無くなったカードを、鍵の無い利用者のカードにする（題名・本文・状態・やること・タグ・時刻は利用者の物、無ければ元の題名） */
function detachedCard(k: string, p: NodePatch | null, pin: CardPin | null, id: ID, x: number, y: number, s: ThinSection): Obj {
  const f = (p?.f ?? {}) as Obj;
  const w: { t: string; s: string } = p ? p.was : pin!;
  let conditions: unknown = [];
  if (Array.isArray(f.conditions)) conditions = f.conditions;
  else if (p?.k?.length) {
    // チェックした項目（文が無い古い書き方なら、元の番号）
    const texts = p.was.kt ?? p.k;
    conditions = texts.map((text, t) => ({ id: `c_${fnv64x36(k)}_${t}`, text, met: true }));
  }
  const meta: Obj = { prevKey: k, prevRelease: s.release };
  if (w.s) meta.prevShort = w.s;
  for (const mk of Object.keys(p?.m ?? {})) if (!BUILDER_NODE_META.has(mk)) meta[mk] = p!.m![mk];
  return {
    id,
    type: typeof f.type === "string" && NODE_TYPES.has(f.type) ? (f.type as NodeType) : "action",
    title: typeof f.title === "string" ? f.title : w.t,
    body: typeof f.body === "string" ? f.body : "",
    status: typeof f.status === "string" && NODE_STATUSES.has(f.status) ? (f.status as NodeStatus) : "open",
    time: isObj(f.time) ? f.time : { due: null, start: null },
    conditions,
    tags: Array.isArray(f.tags) ? f.tags : [],
    projectIds: Array.isArray(f.projectIds) ? f.projectIds : [],
    scenarioIds: Array.isArray(f.scenarioIds) ? f.scenarioIds : [],
    x,
    y,
    collapsed: false,
    createdAt: typeof f.createdAt === "string" && isoOk(f.createdAt) ? f.createdAt : s.at,
    updatedAt: typeof f.updatedAt === "string" && isoOk(f.updatedAt) ? f.updatedAt : s.at,
    meta,
  };
}

/**
 * 今日: ページの地図の今日に、保存してあった今日の利用者の物を当てる（書き換えた題名と本文・状態・付けたタグ・位置・年収・利用者の meta）。
 * 保存してあった今日は、前の版の薄い形の今日でも、版 6 までの地図（太い形）の今日でもよい（どちらも前の版の指紋 t0・b0 を持つ）
 */
export function carryRoot(pr: GNode, sr: GNode): GNode {
  const t0 = sr.meta.t0;
  const b0 = sr.meta.b0;
  const title = typeof t0 === "string" && fnv36(sr.title) !== t0 ? sr.title : pr.title;
  const body = typeof b0 === "string" && fnv36(sr.body) !== b0 ? sr.body : pr.body;
  const given = new Set([...impactTagsOf(sr.meta), ...pr.tags]);
  const mine = sr.tags.filter((t) => !given.has(t));
  const meta: Meta = { ...pr.meta };
  for (const k of Object.keys(sr.meta)) if (!BUILDER_NODE_META.has(k)) meta[k] = sr.meta[k];
  const si = sr.meta.impact;
  const pi = pr.meta.impact;
  if (isObj(si) && isObj(pi)) {
    const imp: Obj = { ...pi };
    if (si.annual !== undefined) imp.annual = si.annual;
    if (si.tail !== undefined) imp.tail = si.tail;
    meta.impact = imp;
  }
  return {
    ...pr,
    id: sr.id,
    title,
    body,
    status: sr.status,
    tags: mine.length ? [...pr.tags, ...mine] : pr.tags,
    conditions: sr.conditions.length ? sr.conditions : pr.conditions,
    projectIds: sr.projectIds,
    scenarioIds: sr.scenarioIds,
    x: sr.x,
    y: sr.y,
    collapsed: sr.collapsed,
    createdAt: sr.createdAt,
    updatedAt: sr.updatedAt,
    meta,
  };
}

/**
 * 前の版・違う組み立ての地図の変更（s）を、ページの地図に鍵で当て直して読む。rest は maps を除いた保存した文書。
 * 保存した物とページの地図だけから決まる（同じ物からは、どの端末でも同じ文書）
 */
function rebaseThin(rest: Obj, s: ThinSection, pb: PageBaseline): ThinDecoded {
  const core = coreOf(pb.map, s.at);
  if (s.key !== core.keys[0]) throw mismatch("今日の鍵（別の地図）", s.release);
  const n = core.n;
  const keys = core.keys;
  const info: ThinUpgradeInfo = { from: { release: s.release, hash: s.hash }, to: { release: pb.release, hash: pb.hash }, applied: 0, restored: 0, detached: 0, lostTicks: 0, droppedEdges: 0 };
  // プロジェクト・シナリオ: 保存した読み替えのうち、ページの地図にある物。無ければ同じ ID・同じ名前・無い（読み替えの先は文書にある物だけ）
  const projects = isObj(rest.projects) ? rest.projects : {};
  const scenarios = isObj(rest.scenarios) ? rest.scenarios : {};
  const base: MapBase = { at: s.at, dx: Math.round(s.dx), dy: Math.round(s.dy), pmap: looseIdMap(core.projects, s.pmap, projects), smap: looseIdMap(core.scenarios, s.smap, scenarios) };
  const view = viewOf(core, base);
  const nPatch = s.n ?? {};
  const ePatch = s.e ?? {};
  const nidMap = s.nid ?? {};
  const eidMap = s.eid ?? {};
  const pins = s.pin ?? {};
  // 保存したノードと線（今日・利用者の物）
  const rawNodes = dict(rest.nodes ?? {}, "nodes");
  const rawEdges = dict(rest.edges ?? {}, "edges");
  const refOf = (key: string, value: unknown): string => (isObj(value) && (typeof value.id === "string" || typeof value.id === "number") ? String(value.id) : key);
  let rootRaw: Obj | undefined;
  const storedIds = new Set<ID>();
  for (const k of Object.keys(rawNodes)) {
    const x = rawNodes[k];
    if (isObj(x) && x.id === s.root) rootRaw = x;
    storedIds.add(refOf(k, x));
  }
  if (!rootRaw || !isObj(rootRaw.meta) || rootRaw.meta.key !== keys[0]) throw mismatch("今日のカードがありません", s.release);
  const storedEdgeIds = new Set<ID>();
  for (const k of Object.keys(rawEdges)) storedEdgeIds.add(refOf(k, rawEdges[k]));
  // ページの地図のカードの ID: 読み替えがあればそれ（利用者の線がつながったまま）、無ければ基準の ID。保存したノードと重なれば、鍵から決まる別の ID
  const used = new Set<ID>(storedIds);
  const idOf = new Array<ID>(n);
  idOf[0] = s.root;
  for (let i = 1; i < n; i++) {
    const k = keys[i]!;
    let id = own(nidMap, k) ? nidMap[k]! : view.nodes[i]!.id;
    if (used.has(id)) id = view.nodes[i]!.id;
    if (used.has(id)) id = impactNodeId64(`${k}#2`);
    if (used.has(id)) throw corrupt("カードの ID が重なっています", s.release);
    used.add(id);
    idOf[i] = id;
  }
  // 鍵が無くなったカード（利用者の物を持つ物・利用者の線や利用者のカードがつながる物）: 前の ID のまま、利用者のカードとして残す
  const rx = typeof rootRaw.x === "number" && Number.isFinite(rootRaw.x) ? Math.round(rootRaw.x) : 0;
  const ry = typeof rootRaw.y === "number" && Number.isFinite(rootRaw.y) ? Math.round(rootRaw.y) : 0;
  const detached: Obj[] = [];
  const detach = (k: string, p: NodePatch | null, pin: CardPin | null): void => {
    let id = own(nidMap, k) ? nidMap[k]! : impactNodeId64(k);
    if (used.has(id)) id = impactNodeId64(`${k}#prev`);
    if (used.has(id)) return;
    used.add(id);
    detached.push(detachedCard(k, p, pin, id, 0, 0, s));
  };
  const detachedKeys = new Set<string>();
  for (const k of Object.keys(nPatch)) {
    const p = nPatch[k]!;
    if (core.keyIndex.has(k)) {
      if (p === 0 || p === -1) info.restored++;
      continue;
    }
    if (p === 0 || p === -1 || !carriesUserState(p)) continue;
    detachedKeys.add(k);
    detach(k, p, null);
  }
  for (const k of Object.keys(pins)) {
    if (core.keyIndex.has(k) || detachedKeys.has(k)) continue;
    detach(k, null, pins[k]!);
  }
  info.detached = detached.length;
  // 列の位置: 今日の左。保存したノード（今日・利用者のカード）と重なれば、さらに左へ（文書の中身だけで決まる）
  const placed: Array<{ x: number; y: number }> = [];
  for (const k of Object.keys(rawNodes)) {
    const x = rawNodes[k];
    if (isObj(x) && typeof x.x === "number" && typeof x.y === "number" && Number.isFinite(x.x) && Number.isFinite(x.y)) placed.push({ x: x.x, y: x.y });
  }
  const gx = detached.length ? prevColumnX(rx, ry, detached.length, placed) : rx;
  detached.forEach((d, j) => {
    d.x = gx;
    d.y = ry + PREV_ROW * (j + 1);
  });
  // 書き換えたカード（ページの地図にある鍵）と、整える前のノード: 今日 → 書き換えたカード → 前の版で決めたこと → 利用者のノード
  const nodesIn: Obj = { [s.root]: rootRaw };
  const carried = new Uint8Array(n);
  for (let i = 1; i < n; i++) {
    const p = nPatch[keys[i]!];
    if (p === undefined || p === 0 || p === -1) continue;
    nodesIn[idOf[i]!] = carryNode(view.nodes[i]!, p, idOf[i]!, slotsOf(core, i), info);
    carried[i] = 1;
    info.applied++;
  }
  let groupId: ID | null = null;
  if (detached.length) {
    groupId = `n_prev_${fnv64x36(`${s.root}\u0000${s.release}\u0000${s.hash}`)}`;
    if (used.has(groupId)) groupId = `n_prev_${fnv64x36(`${s.root}\u0000${s.release}\u0000${s.hash}#2`)}`;
    used.add(groupId);
    nodesIn[groupId] = prevGroupCard(groupId, s.release, pb.release, gx, ry, s.at);
    for (const d of detached) nodesIn[d.id as string] = d;
  }
  for (const k of Object.keys(rawNodes)) if (rawNodes[k] !== rootRaw) nodesIn[k] = rawNodes[k];
  // 同梱の線（ページの地図の物）: 変更を当てる。消してあった線は戻す（同じ 2 枚の間に利用者が引き直した線があれば戻さない）
  const pairs = new Set<string>();
  for (const k of Object.keys(rawEdges)) {
    const e = rawEdges[k];
    if (isObj(e)) pairs.add(`${String(e.source ?? e.from)}\u0000${String(e.target ?? e.to)}`);
  }
  const usedE = new Set<ID>(storedEdgeIds);
  const edgeIdOf = new Array<ID>(n);
  for (let i = 1; i < n; i++) {
    const k = keys[i]!;
    let id = own(eidMap, k) ? eidMap[k]! : view.edges[i]!.id;
    if (usedE.has(id)) id = view.edges[i]!.id;
    if (usedE.has(id)) id = impactEdgeId64(`${k}#2`);
    usedE.add(id);
    edgeIdOf[i] = id;
  }
  const edgesIn: Obj = {};
  const carriedE = new Uint8Array(n);
  const skipE = new Uint8Array(n);
  for (const k of Object.keys(ePatch)) {
    const i = core.keyIndex.get(k);
    if (i === undefined || i === 0) {
      info.droppedEdges++;
      continue;
    }
    const p = ePatch[k]!;
    if (p === 0) {
      if (pairs.has(`${idOf[core.parent[i]!]!}\u0000${idOf[i]!}`)) skipE[i] = 1;
      continue;
    }
    edgesIn[edgeIdOf[i]!] = carryEdge(view.edges[i]!, p, edgeIdOf[i]!, idOf[core.parent[i]!]!, idOf[i]!);
    carriedE[i] = 1;
  }
  for (const k of Object.keys(rawEdges)) edgesIn[k] = rawEdges[k];
  const pageIds = new Set<ID>(idOf);
  const norm = normalizeDoc({ ...rest, version: 1, nodes: nodesIn, edges: edgesIn }, { externalNodeIds: (id) => pageIds.has(id) });
  const nd = norm.doc;
  const sr = nd.nodes[s.root];
  if (!sr) throw corrupt("今日のカードを読めません", s.release);
  // 新しい入れ物: 今日 → 地図のカード（番号の順）→ 前の版で決めたこと・利用者のノード、地図の線（番号の順）→ 利用者の線
  const nodes: Record<ID, GNode> = {};
  nodes[s.root] = withRelease(carryRoot(view.nodes[0]!, sr), pb);
  for (let i = 1; i < n; i++) {
    const id = idOf[i]!;
    if (carried[i]) {
      const x = nd.nodes[id];
      if (!x) throw corrupt(`書き換えたカードを読めません: ${keys[i]!.slice(0, 60)}`, s.release);
      nodes[id] = x;
    } else {
      const vn = view.nodes[i]!;
      nodes[id] = id === vn.id ? vn : { ...vn, id };
    }
  }
  for (const id of Object.keys(nd.nodes)) if (!own(nodes, id)) nodes[id] = nd.nodes[id]!;
  const edges: Record<ID, GEdge> = {};
  for (let i = 1; i < n; i++) {
    if (skipE[i]) continue;
    const id = edgeIdOf[i]!;
    if (carriedE[i]) {
      const x = nd.edges[id];
      // 整えたら無くなった（関係が知らない物など）: 同梱の線のまま
      edges[id] = x ?? applyEdge(view.edges[i]!, undefined, id, idOf[core.parent[i]!]!, idOf[i]!);
    } else edges[id] = applyEdge(view.edges[i]!, undefined, id, idOf[core.parent[i]!]!, idOf[i]!);
  }
  for (const id of Object.keys(nd.edges)) if (!own(edges, id)) edges[id] = nd.edges[id]!;
  const doc: DocData = { ...nd, nodes, edges };
  return { doc, report: norm.report, upgrade: info };
}
