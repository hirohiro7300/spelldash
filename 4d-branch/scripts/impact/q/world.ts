// 3 か月ごと 12 段の世界: world.json（元の 3 段の世界）から、どの手も 3 か月で 12 回選ぶ世界を作る。設計: 作業メモ SPEC v1 §2.1
// R1 の試作（model-tree/worldq.ts）を移した物で、計算は同じ。変えた所は CHANGES に書く（前提の文の書き換えは次の段で行う）

import type { KindDef, World } from "../sim";

/** 判断の段の数（0・3・…・33 か月目）。36 か月目で終わる */
export const NSTAGE = 12;
/** 地図の終わりの月 */
export const H = 36;

export interface WorldQ extends World {
  /** 転職活動を続ける（fc_switch2）3 か月で移れる見込み: 給与 1.18 倍・1.08 倍 */
  qSwitch2: { pHigh: number; pMid: number };
}

/** 元の世界から変えた所（前提の文を書き換えるときの元） */
export const CHANGES: readonly string[] = [
  "期間: 3 か月・9 か月・2 年の 3 段 → 3 か月ごとの 12 段（0・3・…・33 か月目）。2 年の進め方（plan_*）は無くし、3 か月の手の続きで表す",
  "転職: 1 期目 28%（1.18 倍 10%・1.08 倍 18%）は今のまま。続けた 2 期目以降は 1 期 12.6%（7.4%・5.2%）で、3 期続けると 45%（20%・25%）＝前の 9 か月の手と同じ",
  "週 4 日勤務: 断られたら同じ会社では聞き直さない（転職・会社員に戻ると聞ける）",
  "転職活動の 1 期目の見込み（28%）は 1 つの会社で 1 回だけ。休んでから再開しても 2 期目以降の見込み（12.6%）",
  "続ける人を増やす（有料になる割合 1.3 倍）は 3 年で 1 回だけ効く（前の地図でも 1 回だけだった）",
  "遊ぶ人を増やす・広告で集めるは、それぞれ 3 年で 4 期（12 か月）まで（前の地図の上限 12 か月・9 か月に合わせる。毎期続けると伸びが 3 年複利で積み上がるため）",
];

/** 無くす 2 年の進め方 */
const PLANS = ["plan_ind", "plan_side", "plan_sd", "plan_fc", "plan_switch", "plan_back", "plan_ind_grow"];

/** 3 か月ごとの世界（元の世界は変えない）。手はどの段でも、できるなら選べる（sd_pro は出さない: Pro は届け出が認められると自分で出す） */
export function quarterWorld(base: World): WorldQ {
  const w = JSON.parse(JSON.stringify(base)) as WorldQ;
  w.stages = Array.from({ length: NSTAGE }, (_, i) => ({ month: 3 * i, len: 3, maxAlts: i === 0 ? 10 : 4, maxOuts: 3 }));
  for (const k of PLANS) delete w.kinds[k];
  const all = Array.from({ length: NSTAGE }, (_, i) => 3 * i);
  for (const [id, k] of Object.entries(w.kinds)) k.stages = id === "sd_pro" ? [] : all;
  // 転職活動を続ける（まとまりは転職のまま）。1 期の見込みは、3 期続けると前の 9 か月の手（20%・25%）になるように決める
  const sw = w.kinds.fc_switch!;
  const sw2: KindDef = { ...sw, label: "転職活動を続ける", stages: all, p: { ...sw.p } };
  w.kinds.fc_switch2 = sw2;
  w.qSwitch2 = { pHigh: 0.074, pMid: 0.052 };
  return w;
}
