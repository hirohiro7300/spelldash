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
 * 0.7 は文章の波 1 の W1（事実と余白。作業メモ text-w1/audit の fact-*・rep-5・rep-7）: まとめた手が言う会社員に戻る月を、モデルの出来事の月
 * （その期の 3 か月目）にし、この後の目安の会社員に戻る・独立・週 4 日・移る・昇格の期にその月を添えた（fact-1。点検 C11）。
 * この地図の前提（賞与の取り逃しの半月分・移った会社の届け出・聞き直さない・届け出の答えの時期・4 月の昇給と評価）は「この地図では…」で言い、
 * 住民税の言い方・会社の断った訳・決まらなかった訳・給与が止まる月を直し、入社してすぐの評価の対象を人事に確かめる一言を足した
 * （fact-2〜11・fact-23。点検 C2 の言い過ぎ）。前提の数を C に足した（fact-12）。届け出の結果の意味は結果ごとに 1 文にし、「転職か独立」は
 * 1 か所だけで言う（rep-7）。会社員に戻る仕事探し・決まらない期・今のままが長く続く道は、独立してからの月・何期目で言い方を進める（rep-5）。
 * 組み立ては束ごとに道の覚えを持つので、書き換えない（凍らせてある。別の束は写して作る） */
export const BANKS: Banks = deepFreeze({
  version: "0.7",
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
    // 0.7（fact-12）: 届け出の答え・転職・週 4 日・会社員に戻る・試用の見込み、転職活動の上限、移る月の賞与の取り逃し、Pro の円の額、
    //   顧客が離れる見込み（3 か月）、遊ぶ人の伸びと有料になる割合、集客の手の上限
    permA: 0.2,
    permS: 0.45,
    permN: 0.35,
    switchP1: 0.28,
    switchP2: 0.126,
    searchMax: 4,
    searchRun: 2,
    switchCost: 0.5,
    partP: 0.35,
    backP: 0.6,
    pilotP: 0.3,
    netYen: 940,
    infraYen: 3000,
    churnQ: 0.115264,
    growth: 0.08,
    conv: 0.04,
    growMax: 4,
    adsMax: 4,
    retainMax: 1,
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
