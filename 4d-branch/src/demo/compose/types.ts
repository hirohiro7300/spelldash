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

/**
 * 文が言う計算の前提の数。scripts/impact/world.json と同じ値にする（テストで確かめる）。
 * 副業の月額の段（feeFirst・feeRaised・raiseAt）は 3 か月ごとの世界（W-gen の scripts/impact/q/world.ts の quarterWorld）の値（SPEC §2.3 #6）
 */
export interface Consts {
  /** 副業の新しい顧客 1 社の月額（万円） */
  feeFirst: number;
  /** 顧客が raiseAt 社に届いた後に増えた顧客 1 社の月額（万円。今の顧客は据え置く） */
  feeRaised: number;
  raiseAt: number;
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
  /** 昇格 1 回の給与の上がり幅（今日の年収の倍率に足す。4 月の昇給の前に足す） */
  step: number;
  /** 4 月の定期の昇給 */
  aprilRaise: number;
  /** 4 月の評価で昇格する見込み・担当を広げていた場合（fl:scope） */
  promoP: number;
  promoPScope: number;
  /** 学校への提案が 3 か月で導入になる見込みと、試用の実績（fl:pilot）がある場合の倍率 */
  schoolP: number;
  pilotMult: number;
  /** 届け出て『全部可』のとき、その 3 か月に副業の 1 社目が決まる見込み・事例（fl:portfolio）がある場合 */
  firstP: number;
  firstPortfolio: number;
  /** 副業の顧客をもう 1 社探す 3 か月で決まる見込み・事例がある場合 */
  sideP: number;
  sidePPortfolio: number;
  /** 転職で移る先の給与（移る前の給与の倍率）: 大きく上がる・少し上がる */
  switchHigh: number;
  switchMid: number;
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
  /** 文に入る決まった言葉（taxLine: 確定申告が要る副業の所得の線（万円））。確定申告の期間は年ごとに暦から出す */
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
  /** 状態の出来事の文（できごとだけ。同じ出来事が道で何回も起きるときは、何回目かで言い換えを選ぶ） */
  event: Record<string, Variant[]>;
  /** 出来事に添える助言（組ごとに道で 1 回だけ） */
  tip: Record<string, Variant[]>;
  /** 出来事の短い名前（節目・短い名前） */
  eventShort: Record<string, string>;
  /** 節目からの月の言い方（{n} は月の数）。無い出来事は短い名前に「から {n} か月」 */
  since: Record<string, string>;
  /** 同じ種類の節目の 2 回目・3 回目からの言い方（節目の仲間ごと。{nth} は何回目か） */
  sinceAgain: Record<string, string[]>;
  /** 状態の題 */
  eventTitle: Record<string, Variant[]>;
  /** 次の手を問う言い方 */
  nextPhrase: Record<string, string[]>;
  /** 暦の文（確定申告・住民税・4 月・辞める前）。どれも道で 1 回だけ（確定申告はその年分ごとに 1 回） */
  cal: Record<string, Variant[]>;
  /** 3 年後の行き先の、この先の見通し */
  after: Variant[];
  /** 静かな 3 か月の一言（組ごとに道で 1 回だけ） */
  hint: Variant[];
  /** 避けたい手の訳（お金で。組ごとに道で 1 回だけ） */
  avoid: Record<string, Variant[]>;
  /** 手の短い名前 */
  short: Record<string, string>;
  /** 手の名詞の形（この後の目安の並び） */
  nextNoun: Record<string, string>;
  /** 手をした後の言い方（「前の 3 か月は担当を広げた。」。reader-10） */
  did: Record<string, string>;
  /** 標準の続きの 1 期の言い方（手の種類か「種類.出来事」。この後の目安の並び。reader-5） */
  contNoun: Record<string, string>;
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
  /** カードの上の決まった数の行（年収・広告運用・有料・遊ぶ人・週の時間。今日・状態・行き先の本文にはこれらの数を書かない） */
  numbers: string[];
  todo: CardTodo[];
  /** 使った文の型（節.種類#組.言い換え）と、文の型を使わない節の名前 */
  trace: string[];
}
