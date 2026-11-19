// 文章の組み立て（src/demo/compose）の型。設計: 作業メモ SPEC v1 §4.1
// 文の型の束（Banks）は ./banks、組み立ては ./compose.ts、入口は ./index.ts

/** 言い換えの組: 条件（無ければいつも使える）と、同じことを言う言い換え */
export interface Variant {
  if?: string;
  v: string[];
}

/** 手引きの 1 歩（やりたいことリストの 1 項目から作った物） */
export interface Step {
  /** やりたいことリストの番号（カードのやることの元。src/demo/wishlist-data.json） */
  id: string;
  /** やること（24 字まで） */
  todo: string;
  /** 本文に入れる文 */
  act: string;
  /** 同じ種類の手の 2 回目からの題 */
  title?: string;
  if?: string;
}

/** 文が言う計算の前提の数。scripts/impact/world.json と同じ値にする（テストで確かめる） */
export interface Consts {
  /** 副業の顧客 1 社の月額（万円） */
  sideFee: number;
  /** 独立してから増やした顧客 1 社の月額（万円） */
  indFee: number;
  /** 独立の経費（万円/月） */
  overhead: number;
  /** 広告で集客する手の広告費（万円/月） */
  spend: number;
  /** 抱えられる顧客の数: 会社員・週 4 日・独立 */
  capEmp: number;
  capPart: number;
  capInd: number;
  /** Pro 1 人の手取り（万円/月。手数料を引いた後） */
  net: number;
  /** サーバー代（万円/月） */
  infra: number;
  /** 昇格 1 回の給与の上がり幅（今の年収の倍率） */
  step: number;
  /** 学校の 1 席（円/月） */
  seatYen: number;
  /** 週 4 日勤務の給与の倍率 */
  partFactor: number;
  /** 学校 1 校の席の数 */
  schoolSeats: number;
  /** 今日の週の時間（本業と SpellDash 週 10 時間） */
  baseHours: number;
}

/** 文の型の束。節ごとに、手の種類・出来事・結果の分類から言い換えの組を引く */
export interface Banks {
  /** 文の型の版（直したら上げる。同梱データの header.textVersion に書く） */
  version: string;
  C: Consts;
  /** 文に入る決まった言葉（確定申告の期間など） */
  facts: Record<string, string>;
  /** 手引き: 手の種類ごとの歩み（_generic は使い切ったときの残り） */
  playbook: Record<string, Step[]>;
  /** 手の題 */
  title: Record<string, Variant[]>;
  /** 手の書き出し（期間と手） */
  lead: Record<string, Variant[]>;
  /** 手の時間とお金（その種類の初めてのときなど） */
  cost: Record<string, Variant[]>;
  /** 手の結果ごとの意味: 手の種類 → 結果の分類 → 組 */
  branch: Record<string, Record<string, Variant[]>>;
  /** 状態の出来事の文 */
  event: Record<string, Variant[]>;
  /** 出来事の短い名前（節目・短い名前） */
  eventShort: Record<string, string>;
  /** 状態の題 */
  eventTitle: Record<string, Variant[]>;
  /** 次の手を問う言い方 */
  nextPhrase: Record<string, string[]>;
  /** 暦の文（確定申告・住民税・4 月・辞める前） */
  cal: Record<string, Variant[]>;
  /** 3 年後の行き先の、この先の見通し */
  after: Variant[];
  /** 静かな 3 か月の一言 */
  hint: Variant[];
  /** 避けたい手の訳（お金で） */
  avoid: Record<string, Variant[]>;
  /** 手の短い名前 */
  short: Record<string, string>;
  /** 手の名詞の形（「前の 3 か月は〜」） */
  nextNoun: Record<string, string>;
}

/** カードのやること 1 つ: 文と、元にしたやりたいことリストの番号 */
export interface CardTodo {
  text: string;
  cite: string;
}

/** 組み立てたカードの文章 */
export interface Card {
  title: string;
  short: string;
  /** 本文（体の文） */
  body: string;
  /** カードの上の決まった数の行（年収・広告運用・有料・遊ぶ人・週の時間） */
  numbers: string[];
  todo: CardTodo[];
  /** 使った文の型（節.種類#組.言い換え）と、文の型を使わない節の名前 */
  trace: string[];
}
