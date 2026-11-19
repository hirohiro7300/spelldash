// 3 か月ごと 12 段の「3 年の分かれ道」を、読むだけの形で見せる決まった入口（I-map）。設計: 作業メモ SPEC v1 §3.2
// 作る側: 同梱データの読み手（src/demo/impactBundle.ts）。開発中は入れ子の JSON から作る src/deepmap/dev/fromTree.ts
// 使う側: 文章の組み立て（src/demo/compose）・計算の芯と見取り図・道の画面（src/deepmap・src/preview）・アプリ（P2）
// この形を変えるときは、作る側と使う側のすべてを一緒に直す（勝手に足し引きしない）
//
// 番号: カードは 0..n-1 の深さ優先の順（親は子より前・兄弟は並べる順）。0 は今日。
// 役割: r 今日 / a 手（選択肢。結果は見込み % で分かれる）/ s 3 か月ごとの状態（次の判断）/ e 3 年後の行き先
// 値（src/model/impact.ts と同じ）: S = 年収 / 12、w(x) = x[0]·S + x[1] + x[2]（万円）
//   行き先 V(e) = w(rr)·(max(0, 36 − 月) + tail)。tail は 0
//   判断 V(r・s) = 選べる手の V の一番大きい物（選んだ手・見送った手の扱いはアプリの決まりどおり）
//   手 V(a) = Σ p/100 · (w(e(子)) + V(子))

import type { ImpactLine, ImpactSt, R3 } from "../demo/impact";

export type MapRole = "r" | "a" | "s" | "e";

/** 手がカードの並びにある訳: best 一番良い / keep 今のまま（比べる元）/ area 別の領域の代表 / avoid 避けたい手の例 */
export type MapWhy = "best" | "keep" | "area" | "avoid";

/** まとめた行き先の中身（標準の選び方で続けた多くの道を 1 枚にした物）。割合は 0〜1、幅は [10%, 50%, 90%] */
export interface MapMix {
  /** 仕事: 会社員 e・週 4 日 p・独立 i */
  j: { e: number; p: number; i: number };
  /** 会社の届け出の答え */
  pm: { "?": number; a: number; s: number; n: number };
  /** Pro を出している */
  pro: number;
  /** 一度でも転職した */
  switched: number;
  /** 学校の席がある */
  school: number;
  cl: [number, number, number];
  pu: [number, number, number];
  mau: [number, number, number];
  /** 給与の倍率 */
  sal: [number, number, number];
}

/** まとめた手の後の目安の 1 期: その手を始める月・標準の選び方での手・一番ありそうな出来事（文章の組み立ての語彙の名前） */
export interface MapContStep {
  m: number;
  kind: string;
  ev?: string;
}

export interface MapTodo {
  text: string;
  /** 元にした、やりたいことリストの番号 */
  cite: string;
}

export interface MapBand {
  cl?: [number, number];
  pu?: [number, number];
}

export interface MapHeader {
  v: 3;
  kind: "impact3y";
  title: string;
  /** 0 か月目の年月 "YYYY-MM" */
  anchor: string;
  horizon: 36;
  /** 確かめの数字を出したときの年収（万円） */
  annual: number;
  /** 版の順番（同梱データ）。開発用の木は 0 */
  release: number;
  /** 中身の指紋（圧縮する前の決まった並びから） */
  hash: string;
  /** 文の型の版 */
  textVersion: string;
  /** 手の種類: [名前, 領域, まとまり, シナリオ] */
  kinds: Record<string, [string, "sd" | "fc" | "ind" | "base", string, string[]]>;
  /** まとまりの名前 */
  fams: Record<string, string>;
  premises: string[];
  /** まとまりごとに「3 年やらない」場合の今日の見積もり。"_all" は何も除かない同じ見積もり（やる価値はこの 2 つの差）。無い版は空 */
  never: Record<string, R3>;
  counts: { nodes: number; decisions: number; options: number; forks: number; ends: number; sumEnds: number };
}

/** 読むだけの地図。どの関数も番号 i（0..n-1）を受け取る。役割に合わない問い合わせには空の値（null・0・""・空の配列）を返す */
export interface MapData {
  readonly header: MapHeader;
  readonly n: number;
  /** 親の番号（今日は −1） */
  parent(i: number): number;
  childCount(i: number): number;
  /** k 番目の子（並べる順） */
  child(i: number, k: number): number;
  role(i: number): MapRole;
  /** 0 か月目からの月。手はその手を始める月、状態と行き先はその時点の月 */
  month(i: number): number;
  key(i: number): string;
  /** 鍵からの番号（無ければ −1） */
  indexOfKey(key: string): number;

  // ---- 手（a）
  kind(i: number): string | null;
  /** 週の時間の増減 */
  hours(i: number): number;
  /** 今のまま（その判断で比べる元） */
  isBase(i: number): boolean;
  why(i: number): MapWhy | null;
  /** まとめた手（子はまとめた行き先だけ） */
  stub(i: number): boolean;
  /** まとめた手と同じ見積もり方（その 3 か月は正確に・その後は標準の選び方）での、その判断から 36 か月目までの稼ぎ。無い版は null */
  q(i: number): R3 | null;
  todo(i: number): readonly MapTodo[];

  // ---- 結果（s・e）: 親の手からの線
  outId(i: number): string;
  /** 見込み %（整数） */
  p(i: number): number;
  label(i: number): string;
  /** 判断の線の文 */
  line(i: number): string;
  ln(i: number): ImpactLine | null;
  /** その 3 か月の稼ぎ [給与の月数, 広告運用 万円, SpellDash 万円]。まとめた行き先は、その手の 3 か月から 36 か月目までの見込み */
  e(i: number): R3;
  /** 確かめるだけの事実（会社の答えなど）: [事実の名前, 答え] */
  rv(i: number): [string, string] | null;

  // ---- 今日・状態・行き先
  st(i: number): ImpactSt;
  /** その時点の月の稼ぎ [給与の倍率, 広告運用 万円/月, SpellDash 万円/月] */
  rr(i: number): R3;
  /** まとめた行き先 */
  sum(i: number): boolean;
  band(i: number): MapBand | null;
  mix(i: number): MapMix | null;
  cont(i: number): readonly MapContStep[] | null;

  // ---- 先に組み立てた文（同梱。開発用の木では仮の文）
  title(i: number): string;
  short(i: number): string;
}

/** 開発用の入れ子の木（W-gen の生成が書き出す形。src/deepmap/dev/fromTree.ts が MapData にする） */
export interface DevTreeNode {
  /** 鍵 */
  k: string;
  r: MapRole;
  m: number;
  st: ImpactSt;
  /** 今日・状態・行き先の月の稼ぎ（無ければ読み手が 0 にする。作る側が入れること） */
  rr?: R3;
  kind?: string;
  h?: number;
  base?: boolean;
  why?: MapWhy;
  stub?: boolean;
  q?: R3;
  todo?: MapTodo[];
  id?: string;
  p?: number;
  lab?: string;
  line?: string;
  ln?: ImpactLine | null;
  e?: R3;
  rv?: [string, string];
  sum?: boolean;
  band?: MapBand;
  mix?: MapMix;
  cont?: MapContStep[];
  title?: string;
  short?: string;
  kids?: DevTreeNode[];
}

export interface DevTree {
  header: MapHeader;
  root: DevTreeNode;
}
