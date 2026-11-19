// 文の型の束（BANKS）。組み立て（../compose.ts）が、カードの状態と道に合う型を選んで数を差し込む。設計: 作業メモ SPEC v1 §4.1・§4.5
// 中身は ./sentences.ts（文の型）と ./playbook.ts（手引き）。この束が文の型の唯一の元（生成でも画面でも同じ物を使う）
import type { Banks } from "../types";
import { PLAYBOOK } from "./playbook";
import { SENTENCES } from "./sentences";

/** 今の文の型の束。言葉を直したら version を上げる（0.1 は試作 R2 の束をそのまま移した版。0.2 は SPEC §4.2 に合わせた版:
 * 数の言い方・道で 1 回だけの助言（tip）・節目からの月の言い方（since）・確定申告の年ごとの文・移った会社と戻った会社の出来事・学校の年度の文を除く。
 * 0.3 は道の繰り返しを減らした版: 2 回目からの手の書き出し・結果の意味・出来事の言い換えを足し、同じ種類の節目の 2 回目の言い方（sinceAgain）と、
 * 週 4 日勤務で届け出が不可・まだのときの 3 年後の一言を足した。点検 C6・C8）。
 * 0.4 は見直し（reader-*・facts-*・code-*）を当てた版: 副業の月額の段（新しい顧客 3 万円・4 社の後は 5 万円）・後の見込みを変える手の見込み（割）・
 * まとめた結果の文（昇格と据え置き・上げ幅の違う転職・社数の幅・学校）・前の 3 か月の手（〜した）・標準の続きの言い方・道の歩みに合わせた条件・
 * 続く判断で同じ文にならない言い換え。
 * 0.5 は最後の点検の指摘（F1〜F6）を当てた版: 続く判断に並ぶ手の組はどれも言い換えを 2 つ以上（会社員に戻る手など）・3 年後の見通しは顧客の数か
 * 幅で言い分ける（2 社目を決めて言わない）・同じ節目の 2 回目の名前（eventShortAgain）・前の会社の手の続きと言わない・昇格の結果で次の機会を
 * 2 回言わない・事例と状態の題の言い方。
 * 0.6 は生成 v2 の見直し（reader-*・truth-*）を当てた版: まとめた手の結果の給与はその 3 か月の給与で言う（上げ幅をまとめた結果は 2 つ）・
 * 前の期がまとめた幅で社数が 1 つに決まった結果の文と題（CLIENT_EXACT）・社数の幅の判断では何社目と言わない手の題と書き出し・
 * 『全部可』を 1 社目で分けた結果の題と文・応募を続ける助言は次の判断に転職活動の続きが並ぶときだけ。
 * 組み立ては束ごとに道の覚えを持つので、書き換えない（凍らせてある。別の束は写して作る） */
export const BANKS: Banks = deepFreeze({
  version: "0.6",
  // 文が言う計算の前提の数（scripts/impact/world.json の constants・kinds と同じ値。副業の月額の段は 3 か月ごとの世界の値。tests/unit/compose.test.ts で確かめる）
  C: {
    feeFirst: 3,
    feeRaised: 5,
    raiseAt: 4,
    indFee: 7,
    overhead: 3,
    spend: 2,
    capEmp: 2,
    capPart: 4,
    capInd: 6,
    net: 0.094,
    infra: 0.3,
    step: 0.07,
    aprilRaise: 0.03,
    promoP: 0.3,
    promoPScope: 0.4,
    schoolP: 0.1,
    pilotMult: 1.5,
    firstP: 0.4,
    firstPortfolio: 0.5,
    sideP: 0.55,
    sidePPortfolio: 0.7,
    switchHigh: 1.18,
    switchMid: 1.08,
    backSal: 1,
    seatYen: 300,
    partFactor: 0.8,
    schoolSeats: 40,
    baseHours: 52,
  },
  ...SENTENCES,
  playbook: PLAYBOOK,
});

function deepFreeze<T>(x: T): T {
  if (x && typeof x === "object" && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x)) deepFreeze(v);
  }
  return x;
}
