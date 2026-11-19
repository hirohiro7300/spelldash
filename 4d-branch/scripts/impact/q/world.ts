// 3 か月ごと 12 段の世界: world.json（元の 3 段の世界。同梱の版 6 の元なので変えない）から、どの手も 3 か月で 12 回選ぶ世界を作る。
// 設計: 作業メモ SPEC v1 §2.1・§2.3（P2 の前提）。元の世界から変えた所は CHANGES、地図に書く前提の文は premisesOf

import type { KindDef, World } from "../sim";
import { calendarOf, DEFAULT_ANCHOR, parseAnchor, ymText } from "./calendar";

/** 判断の段の数（0・3・…・33 か月目）。36 か月目で終わる */
export const NSTAGE = 12;
/** 地図の終わりの月 */
export const H = 36;

/** 3 か月ごとの世界だけの決まり（world.json には無い数） */
export interface QRules {
  /** 顧客 1 社がその 3 か月に離れる見込み（毎月 4% の 3 か月分 = 1 − 0.96³） */
  churnQ: number;
  /** 副業の新しい顧客の月額・顧客が raiseAt 社に届いた後に増えた顧客の月額（万円。今の顧客は据え置く） */
  feeFirst: number;
  feeRaised: number;
  raiseAt: number;
  /** 転職活動は 1 つの会社で何期まで・続けて何期まで（続けて決まらなかったら、次の 3 か月はほかの手） */
  searchMax: number;
  searchRun: number;
}

export interface WorldQ extends World {
  /** 転職活動を続ける（fc_switch2）3 か月で移れる見込み: 給与 1.18 倍・1.08 倍 */
  qSwitch2: { pHigh: number; pMid: number };
  /** 0 か月目の年月 "YYYY-MM"（4 月などの暦はここから出す） */
  anchor: string;
  q: QRules;
}

/**
 * 前提の文のうち、手の決まり（quarter.ts の feasibleQ）と同じことを言う文。点検 J3・J4（checks.ts の premiseRuleChecks）が、
 * 文があることと決まりがその通りに効くことを両方見る（決まりだけ変えて文が古いまま、を見つける。見直し truth-3・truth-6）
 */
export const SWITCH_ONCE = "転職（転職活動で移ること）は 3 年で 1 回まで。移った後の会社では転職活動をしない（独立してから会社員に戻った会社では、またできる）";
export const PART_ONEWAY = "週 4 日にした後は 3 年の間 週 5 日に戻さず、転職活動もしない（独立してから会社員に戻る場合を除く）";

/** 元の世界から変えた所（作り直したときの説明の元） */
export const CHANGES: readonly string[] = [
  "期間: 3 か月・9 か月・2 年の 3 段 → 3 か月ごとの 12 段（0・3・…・33 か月目）。2 年の進め方（plan_*）は無くし、3 か月の手の続きで表す",
  "転職: 1 期目 28%（1.18 倍 10%・1.08 倍 18%）は 1 つの会社で 1 回だけ。続けた 2 期目以降は 1 期 12.6%（7.4%・5.2%）で、3 期続けると 45%（20%・25%）＝前の 9 か月の手と同じ",
  "転職活動は 1 つの会社で 4 期まで、続けるのは 2 期まで（2 期続けて決まらなければ次の 3 か月はほかの手）",
  "転職（移ること）は R1 と同じく 3 年で 1 回まで: 移った後の会社では転職活動をしない。独立してから会社員に戻った会社では、また転職活動ができる（前提の文 5 に書く）",
  "副業の届け出の答えは移った会社に引き継ぐ: 移れる見込みは『全部可』なら × 全部可の割合、『SpellDash だけ可』なら × SpellDash を認める割合。まだ・不可なら × 1 で、移った会社でまた届け出る",
  "会社員に戻ると、届け出なしで『SpellDash だけ可』（SpellDash を認める会社に戻る）。広告運用の顧客は手放す",
  "週 4 日勤務: 断られたら同じ会社では聞き直さない（転職・会社員に戻ると聞ける）。認められたら週 5 日には戻さず、転職活動もしない（独立してから会社員に戻る場合を除く。前提の文 3・15 に書く）",
  "続ける人を増やす（有料になる割合 1.3 倍）は 3 年で 1 回だけ効く。遊ぶ人を増やす・広告で集めるは、それぞれ 3 年で 4 期まで",
  "顧客は整数の社数で数え、3 か月ごとに 1 社ずつ 1 − 0.96³（約 11.5%）の見込みで離れる（離れる顧客もその 3 か月の初めの 1 か月分は払う）",
  "副業の月額: 新しい顧客は月 3 万円、顧客が 4 社に届いた後に増えた顧客は月 5 万円（今の顧客は据え置く）。独立してから増やした顧客は月 7 万円のまま。会社員は 2 社までなので、月 5 万円は週 4 日勤務の時だけ（やりたいことの計画 ind-side-d22 の『お試しの申し込みが半年で 3 件を超えたら』とは決め方が違う。申し込みの数え方は P3）",
  "Pro は初回 1 か月無料: 有料になった人はその翌月から払う",
  "4 月の昇給・昇格を狙える 3 か月は、地図の年月（0 か月目）から数える。地図の年月が 1〜3 月なら今日の 3 か月が昇格を狙える 3 か月なので、今日の手に『昇格を狙う』を足す",
  "転職の見込みは今の届け出の答えの範囲を認める会社の割合を掛ける（作業メモ SPEC v1 §2.3 #5）。そのため年収が高いと『SpellDash だけ可』が『どちらも不可』を下回ることがある（前提の文 6 に書く。範囲を捨てて移る手は P2 では入れない）",
];

/**
 * 今日の手: 世界の決まった手（world.json の rootMenu。作業メモ SPEC v1 §2.1）。地図の年月が 1〜3 月なら今日の 3 か月が昇格を狙える 3 か月なので、
 * 『4 月の評価で昇格を狙う』を最後に足す（見直し truth-7。足さないと最初の 4 月の評価を狙えない）
 */
export function menuOf(rootMenu: readonly string[], anchor: string): string[] {
  const menu = [...rootMenu];
  if (calendarOf(anchor, H).promoStages.includes(0) && !menu.includes("fc_push")) menu.push("fc_push");
  return menu;
}

/** 無くす手: 2 年の進め方と、Pro だけを出す手（Pro は届け出が認められると自分で出す。作業メモ SPEC v1 §2.1） */
const DROPPED = ["plan_ind", "plan_side", "plan_sd", "plan_fc", "plan_switch", "plan_back", "plan_ind_grow", "sd_pro"];

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

/** 地図に書く前提の文（見方）。数は世界から入れる */
export function premisesOf(w: WorldQ): string[] {
  const c = w.constants;
  const sw = w.kinds.fc_switch!.p;
  const k = (id: string) => w.kinds[id]!.p;
  const an = parseAnchor(w.anchor);
  const cal = calendarOf(w.anchor, H);
  const first = cal.aprilMonths[0]!;
  const allowAll = c.perm.a;
  const allowSd = c.perm.a + c.perm.s;
  return [
    "数はすべて税引き前の稼ぎ（給与の額面・広告運用の売上・SpellDash の売上）。税金・貯金・投資は入れていない",
    `この地図は ${ymText(an, 0)}時点の見込み。そこから 3 年（${ymText(an, H)}）まで、3 か月ごとに選ぶ。4 月の昇給と昇格の評価は ${ymText(an, first)}から毎年`,
    `給与は今の年収（賞与込みの額面。通勤手当は除く）を 1.0 倍とし、毎年 4 月に ${pct(c.aprilRaise)} 上がる。週 4 日勤務は給与 ${c.partFactor} 倍で、${PART_ONEWAY}`,
    "3 か月ごとに選ぶ手は 1 つ（12 回）。会社への届け出は届け出を含む手でだけ行い、転職活動と同じ 3 か月にはしない",
    `転職は給与が上がる話だけ受ける。転職活動の最初の 3 か月で移れる見込みは ${pct(sw.pHigh3! + sw.pMid3!)}（給与 ${sw.high} 倍 ${pct(sw.pHigh3!)}・${sw.mid} 倍 ${pct(sw.pMid3!)}）で、1 つの会社で 1 回だけ。続けた 3 か月ごとに ${pct(w.qSwitch2.pHigh + w.qSwitch2.pMid)}（${pct(w.qSwitch2.pHigh)}・${pct(w.qSwitch2.pMid)}）。転職活動は 1 つの会社で ${w.q.searchMax} 期（${3 * w.q.searchMax} か月）まで、続けるのは ${w.q.searchRun} 期まで（${w.q.searchRun} 期続けて決まらなければ、次の 3 か月はほかの手にする）。${SWITCH_ONCE}。移る月に賞与の取り逃しとして給与の半月分を引く。転職活動にかける週 ${w.kinds.fc_switch!.hours} 時間は稼ぎに数えていない`,
    `移る先は、今の会社の届け出の答えと同じ範囲を認める会社だけを受ける。『全部可』なら全部可の会社（${pct(allowAll)}）、『SpellDash だけ可』なら SpellDash を認める会社（${pct(allowSd)}）だけなので、移れる見込みはその割合を掛けた分になる。答えがまだか『どちらも不可』なら見込みはそのままで、移った会社でまた届け出られる。顧客がいなくても『全部可』なら全部可の会社だけを受け、SpellDash や副業をやめて移ることはしないので、年収が高いと『SpellDash だけ可』の方が『どちらも不可』より 3 年の稼ぎが少なく出ることがある`,
    `昇格は 4 月の評価で ${pct(k("fc_push").p!)}（担当を広げていれば ${pct(k("fc_push").pScope!)}）。1 回で給与が今の ${pct(k("fc_push").step!)} 分上がる。狙えるのは 4 月を含む 3 か月だけ`,
    `独立は辞めると伝えてから 1 か月後で、その後の給与は 0。経費（道具・会計・通信・交通）と個人事業税として月 ${c.indOverhead} 万円を引く。国民健康保険・国民年金は会社員の社会保険料とほぼ同じとみて数えず、厚生年金の上乗せ・傷病手当金・雇用保険が無くなる分も数えていない`,
    `会社員に戻れる見込みは 3 か月ごとに ${pct(k("back_emp").p!)}。戻る会社は SpellDash を認める会社とみて、届け出なしで『SpellDash だけ可』になる。広告運用の顧客は引き継いで手放す`,
    `広告運用の副業の顧客は、新しい顧客が 1 社 月 ${w.q.feeFirst} 万円（お試し 3 か月・月 ${w.q.feeFirst} 万円の条件のまま続ける）。顧客が ${w.q.raiseAt} 社に届いた後に増えた顧客は月 ${w.q.feeRaised} 万円（今の顧客は据え置く）。独立してから増やした顧客は月 ${c.indFee} 万円（副業からの顧客は同じ月額のまま）。年収を変えても月額は同じ。抱えられるのは会社員 ${c.capEmp} 社・週 4 日 ${c.capPart} 社・独立 ${c.capInd} 社まで${c.capEmp < w.q.raiseAt ? `。会社員の間（${c.capEmp} 社まで）は新しい顧客も月 ${w.q.feeFirst} 万円のままで、月 ${w.q.feeRaised} 万円になるのは週 4 日勤務で顧客が ${w.q.raiseAt} 社に届いた後に増えた顧客だけ` : ""}`,
    `顧客は 3 か月ごとに 1 社ずつ ${pct(w.q.churnQ)}（毎月 ${pct(c.churn)} と同じ割合）の見込みで離れる。離れる顧客もその 3 か月の初めの 1 か月分は払う。その 3 か月に増えた顧客は次の 3 か月から数える`,
    `SpellDash の Pro は月 980 円（手数料を引いて 1 人 ${Math.round(c.net * 10000)} 円）で、初回 1 か月無料（有料になった翌月から払う）。遊ぶ人（月）は続けている開発で月 ${pct(c.g0)} ほど増え、その ${pct(c.conv)} 前後が有料になる。サーバー代は月 ${Math.round(c.infra * 10000).toLocaleString("ja-JP")} 円。学校の導入は 1 校 ${c.schoolSeats} 席で、学校向けの値段として 1 席 月 ${Math.round((c.seatNet ?? c.net) * 10000)} 円とみる`,
    "SpellDash が認められている（届け出の答えが『全部可』か『SpellDash だけ可』、または独立）なら、続けている週 10 時間の中で、認められた・独立した翌月に Pro を出す",
    `副業の届け出（SpellDash と広告運用の両方を書く）の答えは『全部可』${pct(c.perm.a)}・『SpellDash だけ可』${pct(c.perm.s)}・『どちらも不可』${pct(c.perm.n)} と見込む。広告会社の社員が社外の広告運用を受けるのは競業になりやすく、『全部可』は少ない`,
    "週 4 日勤務は 1 つの会社で 1 回だけ相談できる（断られたら転職・会社員に戻るまで聞き直さない。認められたら週 5 日には戻さず、転職活動もしない）。続ける人を増やす工夫（有料になる割合 1.3 倍）は 3 年で 1 回だけ効く。遊ぶ人を増やす・広告で集めるは、それぞれ 3 年で 4 期（12 か月）まで",
    `学校への提案が導入になる見込みは 3 か月ごとに ${pct(k("sd_school").perQuarter!)}（試用があれば ${pct(k("sd_school").perQuarter! * k("sd_school").pilotMult!)}）`,
    "見込み（%）は 10%・50%・90% の 3 点（重み 30・40・30）で幅を表して計算した目安。伸びの幅は 3 か月ごとに引き直すので、3 年後の SpellDash の数の幅は実際より狭く出る",
  ];
}

/** 3 か月ごとの世界（元の世界は変えない）。anchor は 0 か月目の年月。手はどの段でも、できるなら選べる（2 年の進め方と sd_pro は無くす） */
export function quarterWorld(base: World, anchor: string = DEFAULT_ANCHOR): WorldQ {
  const cal = calendarOf(anchor, H);
  const w = JSON.parse(JSON.stringify(base)) as WorldQ;
  w.anchor = anchor;
  w.stages = Array.from({ length: NSTAGE }, (_, i) => ({ month: 3 * i, len: 3, maxAlts: i === 0 ? 10 : 4, maxOuts: 3 }));
  w.rootMenu = menuOf(base.rootMenu, anchor);
  for (const k of DROPPED) delete w.kinds[k];
  const all = Array.from({ length: NSTAGE }, (_, i) => 3 * i);
  for (const k of Object.values(w.kinds)) k.stages = all;
  // 転職活動を続ける（まとまりは転職のまま）。1 期の見込みは、3 期続けると前の 9 か月の手（20%・25%）になるように決める
  const sw = w.kinds.fc_switch!;
  const sw2: KindDef = { ...sw, label: "転職活動を続ける", stages: all, p: { ...sw.p } };
  w.kinds.fc_switch2 = sw2;
  w.qSwitch2 = { pHigh: 0.074, pMid: 0.052 };
  // 暦は地図の年月から（4 月の昇給・昇格を狙える 3 か月）
  w.constants.aprilMonths = cal.aprilMonths;
  w.q = { churnQ: 1 - Math.pow(1 - w.constants.churn, 3), feeFirst: 3, feeRaised: 5, raiseAt: 4, searchMax: 4, searchRun: 2 };
  // 副業の新しい顧客の月額（元の世界の 5 万円は版 6 の前提）
  w.constants.sideFee = w.q.feeFirst;
  w.premises = premisesOf(w);
  return w;
}
