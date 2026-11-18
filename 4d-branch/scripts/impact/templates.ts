// 文章の型。書き手の文章（text/*.json）が無いノードは、ここで状態から作る。
// 数は給与に依らないもの（顧客の数・月額・有料会員・遊ぶ人・給与の倍率）だけを書く（3 年の差・% は画面で計算して出す）。

import { whenText } from "./group";
import type { St, World } from "./sim";
import type { TNode } from "./tree";

const n0 = (x: number) => Math.round(x).toLocaleString("ja-JP");
const f2 = (x: number) => (Math.round(x * 100) / 100).toFixed(2);
const man = (x: number) => {
  const v = Math.round(x * 10) / 10;
  return Number.isInteger(v) ? `${v}` : v.toFixed(1);
};
const pct = (x: number) => `${Math.round(x * 100)}%`;
/** 文章に入れる数（world.json の値から。値を変えても文章が古くならないように） */
const P = (w: World) => ({
  side: man(w.constants.sideFee),
  ind: man(w.constants.indFee),
  grow: man(w.kinds.plan_ind_grow?.p.fee ?? w.constants.indFee),
  step: pct(w.kinds.fc_push?.p.step ?? 0.1),
  stepPlan: pct(w.kinds.plan_fc?.p.step ?? 0.1),
  capEmp: w.constants.capEmp,
  indAt: w.kinds.plan_ind?.p.threshold ?? w.constants.capEmp,
  seats: w.constants.schoolSeats,
  spend: man(w.kinds.sd_ads?.p.spend ?? 2),
  part: `${w.constants.partFactor}`,
  /** 辞めると伝えてから給与が止まるまでの月数 */
  notice: Math.max(0, (w.kinds.ind_quit?.p.at ?? 1) - 1),
});

/** 画面の短い名前の幅（半角は 0.5） */
export function shortWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[\x20-\x7e]/.test(ch) ? 0.5 : 1;
  return w;
}

export function fitShort(s: string, max = 7): string {
  if (shortWidth(s) <= max) return s;
  let out = "";
  for (const ch of s) {
    if (shortWidth(out + ch) > max - 1) break;
    out += ch;
  }
  return out.trimEnd() + "…";
}

const ALT_TITLE: Record<string, (s: St, stage: number, w: World) => string> = {
  keep: (_s, st) => (st === 0 ? "今のままにする" : st === 1 ? "今のまま 9 か月続ける" : "今のまま 2 年続ける"),
  sd_permpro: () => "届け出て Pro を出す",
  sd_grow: () => "遊ぶ人を増やす",
  sd_pilot: () => "学校・塾に無料で試してもらう",
  sd_pro: () => "Pro（月 980 円）を出す",
  sd_school: () => "学校に導入を提案する",
  sd_ads: () => "広告で遊ぶ人を集める",
  sd_retain: () => "続ける人を増やす",
  fc_scope: () => "社内で担当を広げる",
  fc_push: () => "4 月の評価で昇格を狙う",
  fc_switch: () => "転職活動をする",
  part: () => "週 4 日勤務を相談する",
  ad_portfolio: () => "知人の店の広告を無償で手伝う",
  ad_perm: () => "副業を届け出る",
  ad_permside: () => "届け出て副業の 1 社目を探す",
  ad_side: (s) => (s.cl < 0.5 ? "副業の 1 社目を探す" : "副業の顧客を 1 社増やす"),
  ad_more: () => "紹介で顧客を増やす",
  ind_quit: (_s, st) => (st === 0 ? "今すぐ辞めて独立する" : "辞めて独立する"),
  back_emp: () => "会社員に戻る",
  plan_ind: (_s, _st, w) => `副業を ${P(w).indAt} 社にして独立する`,
  plan_side: (_s, _st, w) => `副業を ${P(w).capEmp} 社まで広げる`,
  plan_sd: (s) => (s.pro ? "学校への導入を広げる" : "Pro を出し学校へ広げる"),
  plan_fc: () => "本業で昇格を 2 回狙う",
  plan_switch: () => "条件の良い会社に移る",
  plan_back: () => "会社員に戻る",
  plan_ind_grow: () => "独立のまま顧客を増やす",
};

const ALT_SHORT: Record<string, (s: St, stage: number, w: World) => string> = {
  keep: () => "今のまま",
  sd_permpro: () => "Pro を出す",
  sd_grow: () => "遊ぶ人を増やす",
  sd_pilot: () => "学校で試す",
  sd_pro: () => "Pro を出す",
  sd_school: () => "学校に提案",
  sd_ads: () => "広告で集客",
  sd_retain: () => "継続を上げる",
  fc_scope: () => "担当を広げる",
  fc_push: () => "昇格を狙う",
  fc_switch: () => "転職活動",
  part: () => "週 4 日勤務",
  ad_portfolio: () => "無償で実績",
  ad_perm: () => "届け出る",
  ad_permside: () => "副業 1 社目",
  ad_side: (s) => (s.cl < 0.5 ? "副業 1 社目" : "1 社増やす"),
  ad_more: () => "紹介で増やす",
  ind_quit: (_s, st) => (st === 0 ? "今すぐ独立" : "独立する"),
  back_emp: () => "会社員に戻る",
  plan_ind: (_s, _st, w) => `${P(w).indAt} 社で独立`,
  plan_side: (_s, _st, w) => `副業 ${P(w).capEmp} 社へ`,
  plan_sd: () => "学校に広げる",
  plan_fc: () => "昇格 2 回",
  plan_switch: () => "良い会社へ",
  plan_back: () => "会社員に戻る",
  plan_ind_grow: () => "顧客を増やす",
};

const ALT_BODY: Record<string, (s: St, stage: number, w: World) => string> = {
  keep: (_s, st) =>
    st === 0
      ? "本業と SpellDash 週 10 時間をこのまま続け、この 3 か月は新しいことを足さない。ほかの手と比べる基準の道。"
      : st === 1
        ? "次の 9 か月も今のやり方のまま続け、新しいことは足さない。ほかの手と比べる基準の道。"
        : "残りの 2 年も今のやり方のまま続ける。ほかの進め方と比べる基準の道。",
  sd_permpro: () => "会社に副業（SpellDash と広告運用）を届け出て、SpellDash が認められたら Pro（月 980 円）の受付を始める。本業はそのまま続ける。",
  sd_grow: () => "SpellDash の週 10 時間を集客に寄せ、SNS・紹介・ストアの見せ方で遊ぶ人を増やす。本業はそのまま。",
  sd_pilot: () => "近くの学校・塾に無料で使ってもらい、授業での使われ方と先生の声を集める。売上はまだ無い。",
  sd_pro: () => "Pro（月 980 円）の受付を始め、無料で遊ぶ人の一部を有料に移す。本業はそのまま。",
  sd_school: (_s, _st, w) => `試してもらった実績を持って、学校に ${P(w).seats} 席の導入を提案する。決まるのは年度の切り替わりが多い。`,
  sd_ads: (_s, _st, w) => `月 ${P(w).spend} 万円の広告で遊ぶ人を集め、有料に移る人を増やす。広告費は SpellDash の売上から引く。`,
  sd_retain: () => "初回の体験と続けたくなる仕組みを直し、無料から有料に移る割合を上げる。",
  fc_scope: () => "本業で担当する顧客・媒体を広げ、次の 4 月の評価で昇格しやすくする。週 4 時間ほど増える。",
  fc_push: (_s, _st, w) => `4 月の評価に向けて成果をまとめ、昇格（給与が ${P(w).step} ほど上がる）を狙う。SpellDash と副業は今のまま。`,
  fc_switch: () => "広告運用の経験を生かして転職先を探す。決まれば給与が上がるが、移る月は賞与を取り逃しやすく、副業の届け出は新しい会社でやり直す。",
  part: (_s, _st, w) => `会社に週 4 日勤務を相談する。認められると給与は ${P(w).part} 倍になり、空いた 1 日を SpellDash と副業に回す。`,
  ad_portfolio: () => "知人の店の広告を無償で手伝い、副業を始めるときに見せられる実績を作る。",
  ad_perm: () => "会社に副業（広告運用と SpellDash）を届け出て、どこまで認められるかの答えを得る。",
  ad_permside: (_s, _st, w) => `会社に副業を届け出て、広告運用が認められたらすぐに 1 社目（月 ${P(w).side} 万円）を探す。`,
  ad_side: (s, _st, w) =>
    s.cl < 0.5 ? `副業として広告運用の 1 社目（月 ${P(w).side} 万円）を探す。本業と SpellDash は今のまま。` : `副業の顧客をもう 1 社（月 ${P(w).side} 万円）増やす。本業と SpellDash は今のまま。`,
  ad_more: (s, _st, w) => (s.j === "i" ? `今の顧客からの紹介と発信で、顧客（月 ${P(w).ind} 万円）を増やす。` : `今の顧客から紹介をもらい、副業の顧客（月 ${P(w).side} 万円）を増やす。`),
  ind_quit: (s, _st, w) =>
    `会社に辞めると伝えて広告運用で独立する。${P(w).notice ? `${P(w).notice} か月後から` : ""}給与が無くなり、新しい顧客は 1 社あたり月 ${P(w).ind} 万円で集める。${s.cl >= 0.5 ? `今の顧客 ${n0(s.cl)} 社は同じ月額のまま続ける。` : "今は顧客が無いところから始める。"}`,
  back_emp: () => "独立をやめて会社員の仕事を探す。決まれば顧客は手放し、給与は今の水準から始める。",
  plan_ind: (_s, _st, w) => `副業の顧客を増やし、2 年後に ${P(w).indAt} 社以上あれば会社を辞めて独立する。届かなければ会社員のまま続ける。`,
  plan_side: (_s, _st, w) => `会社員のまま副業の顧客（月 ${P(w).side} 万円）を ${P(w).capEmp} 社まで広げる。SpellDash は今のまま。`,
  plan_sd: (s) => (s.pro ? "Pro を続けながら、毎年 4 月に学校へ導入を提案して有料の席を増やす。" : "Pro の受付を始め、毎年 4 月に学校へ導入を提案して有料の席を増やす。"),
  plan_fc: (_s, _st, w) => `本業に力を入れ、2 回の 4 月の評価でそれぞれ昇格（給与が ${P(w).stepPlan} ほど上がる）を狙う。`,
  plan_switch: () => "条件の良い会社への転職を狙う。決まれば給与が上がるが、移る月は賞与を取り逃しやすく、副業の届け出はやり直す。",
  plan_back: () => "独立をやめて会社員の仕事を探す。決まれば顧客は手放す。",
  plan_ind_grow: (_s, _st, w) => `独立のまま得意な業種に絞り、1 社あたり月 ${P(w).grow} 万円の顧客を増やす。`,
};

const TODO = (w: World): Record<string, string[]> => ({
  sd_permpro: ["就業規則の副業の決まりを読む", "副業の届け出を出す", "Pro の受付ページを用意する", "最初の有料会員に声をかける"],
  sd_grow: ["遊んだ人の声を 10 件集める", "SNS に週 2 回プレイ動画を出す", "ストアの画像と説明を直す", "紹介してくれた人にお礼を送る"],
  sd_pilot: ["近くの学校・塾を 10 か所書き出す", "試用のお願いの資料を作る", "先生 3 人に話を聞く", "授業での使われ方を記録する"],
  sd_pro: ["Pro の特典を 3 つ決める", "受付ページと支払いを整える", "無料の人に案内を出す", "解約の理由を聞く仕組みを作る"],
  sd_school: ["試用の結果を 1 枚にまとめる", "導入の見積もりを作る", "校長・教務の先生に提案する", "4 月に向けて席の準備をする"],
  sd_ads: [`月 ${P(w).spend} 万円の上限を決める`, "広告から来た人の続き方を測る", "有料に移った人の数を週ごとに見る"],
  sd_retain: ["初回 3 分の体験を直す", "7 日続いた人の割合を測る", "続けた人に特典を出す"],
  fc_scope: ["上司に担当を広げたいと伝える", "新しい媒体の運用を覚える", "成果を月ごとにまとめる"],
  fc_push: ["今期の成果を数字でまとめる", "上司と評価の基準をすり合わせる", "4 月の面談で昇格を相談する"],
  fc_switch: ["職務経歴書を書き直す", "転職サイトとエージェントに登録する", "広告運用の実績を数字でまとめる", "面接で副業の扱いを確かめる"],
  part: ["就業規則の短時間勤務を読む", "上司に週 4 日の相談をする", "空いた 1 日の使い方を決める"],
  ad_portfolio: ["手伝える知人の店を 3 つ挙げる", "広告の目標と数字の取り方を決める", "成果を事例 1 枚にまとめる"],
  ad_perm: ["就業規則の副業の決まりを読む", "副業の届け出を出す", "認められる範囲を書面で残す"],
  ad_permside: ["就業規則の副業の決まりを読む", "副業の届け出を出す", "会社の顧客と重ならない相手を選ぶ", "1 社目の候補に声をかける"],
  ad_side: ["会社の顧客と重ならない相手を選ぶ", `月 ${P(w).side} 万円の運用内容を決める`, "契約書の型を用意する"],
  ad_more: ["今の顧客に紹介をお願いする", "事例を 1 枚にまとめて配る", "抱えられる社数を決めておく"],
  ind_quit: ["退職の時期を上司に伝える", "開業届と国民健康保険の手続きをする", "最初の顧客に声をかける", "半年分の生活費を確かめる"],
  back_emp: ["職務経歴書に独立中の実績を書く", "広告運用の求人に応募する", "顧客に引き継ぎ先を案内する"],
});

const PERM_SHORT: Record<string, string> = { "?": "副業は届け出前", a: "副業も SpellDash も可", s: "SpellDash だけ可", n: "副業は不可" };

/** 状態を 1 行で（画面でも計算して出すが、本文にも残す） */
export function stateLine(w: World, s: St): string {
  const job = s.j === "e" ? `会社員（給与 ${f2(s.sal)} 倍）` : s.j === "p" ? `週 4 日勤務（給与 ${f2(s.sal * w.constants.partFactor)} 倍）` : "独立";
  const cl = s.cl >= 0.5 ? `広告運用の顧客 ${n0(s.cl)} 社（月 ${man(s.cl * s.fee)} 万円）` : "広告運用の顧客なし";
  const sd = s.pro ? `SpellDash 有料 ${n0(s.pu)} 人・遊ぶ人 月 ${n0(s.mau)} 人` : `SpellDash は無料のまま・遊ぶ人 月 ${n0(s.mau)} 人`;
  return `${job}・${s.j === "i" ? "" : `${PERM_SHORT[s.pm]}・`}${cl}・${sd}`;
}

/** 状態の見出し（いちばん目立つ 2〜3 点） */
function headline(s: St, prev: St | null): string {
  const parts: string[] = [];
  if (s.j === "i") parts.push("独立");
  else if (s.j === "p") parts.push("週 4 日");
  else if (prev && s.sal / Math.max(1e-9, prev.sal) >= 1.06) parts.push(s.fl.includes("switched") && !prev.fl.includes("switched") ? `転職で給与 ${f2(s.sal)} 倍` : `給与 ${f2(s.sal)} 倍`);
  else parts.push("会社員");
  if (prev && prev.pm === "?" && s.pm !== "?") parts.push(s.pm === "a" ? "副業も可" : s.pm === "s" ? "SpellDash だけ可" : "副業は不可");
  if (s.cl >= 0.5) parts.push(`顧客 ${n0(s.cl)} 社`);
  if (s.pro) parts.push(`有料 ${n0(s.pu)} 人`);
  else if (s.mau >= 100) parts.push(`遊ぶ人 ${n0(s.mau)}`);
  return parts.join("・");
}

function clip(s: string, max: number): string {
  return [...s].length <= max ? s : [...s].slice(0, max - 1).join("") + "…";
}

export interface NodeText {
  title: string;
  short: string;
  body: string;
  todo?: string[];
}

export function textFor(w: World, n: TNode): NodeText {
  if (n.role === "r") {
    return {
      title: "今日: 会社員と SpellDash 週 10 時間",
      short: "今日",
      body: "広告運用の会社で Google・Meta 広告と GA4 を担当しながら、SpellDash を週 10 時間ほどで作っている。遊んだ人は数十人で、Pro（月 980 円）は受付前、売上は 0 円。ここから 3 年の選び方で、稼ぎがどれだけ変わるかを比べる。",
    };
  }
  if (n.role === "a") {
    const k = n.kind!;
    const title = ALT_TITLE[k]!(n.st, n.stage, w);
    const out: NodeText = { title, short: fitShort(ALT_SHORT[k]!(n.st, n.stage, w)), body: ALT_BODY[k]!(n.st, n.stage, w) };
    const todo = TODO(w)[k];
    if (n.stage <= 1 && todo) out.todo = todo.slice(0, 5);
    return out;
  }
  const o = n.out!;
  const prev = n.parent?.st ?? null;
  const head = headline(n.st, prev);
  const line = stateLine(w, n.st);
  if (n.role === "e") {
    return {
      title: clip(`3 年後: ${head}`, 24),
      short: fitShort(o.short || head.split("・")[0]!),
      body: `${o.line === "（どの場合もこの道）" ? "" : `${o.line}。`}${line}。`,
    };
  }
  return {
    title: clip(`${whenText(n.m)}: ${head}`, 22),
    short: fitShort(o.short || head.split("・")[0]!),
    body: `${o.line === "（どの場合もこの道）" ? "" : `${o.line}。`}${line}。ここで次の一手を選ぶ。`,
  };
}
