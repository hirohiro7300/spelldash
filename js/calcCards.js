// ===== 計算カード（式を「使える」ようにする） =====
// Day 0 ハンドブック「式は5本だけ暗記してよい」を、毎回違う数字で計算する練習にする。
// 出題のたびに数字を作り直す。答えは割り切れる組み合わせだけを使う（暗算で出せる範囲）。

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const yen = (n) => `${n.toLocaleString("ja-JP")}円`;
const num = (n) => n.toLocaleString("ja-JP");

// 数値の答えの表記ゆれ: 8000 / 8,000 / 8000円 / ¥8000
function moneyAccept(n) {
  return [String(n), num(n), `${n}円`, `${num(n)}円`, `¥${n}`, `${n}yen`];
}

// 割合の答え: 3% / 3 / 0.03
function percentAccept(p) {
  const s = String(p);
  return [`${s}%`, `${s}％`, s, `${s}パーセント`, String(Math.round(p * 1000) / 100000)];
}

export const CALC_KINDS = {
  ctr: {
    label: "CTR",
    formula: "CTR = Click ÷ Imp",
    make() {
      const imp = pick([1000, 2000, 4000, 5000, 10000, 20000, 50000]);
      const ctr = pick([1, 2, 2.5, 4, 5, 8, 10]);
      const click = Math.round((imp * ctr) / 100);
      return {
        q: `表示回数（Imp）${num(imp)}回、クリック ${num(click)}回。CTR（クリック率）は何%？`,
        answer: `${ctr}%`,
        accept: percentAccept(ctr),
        explain: `CTR = Click ÷ Imp = ${num(click)} ÷ ${num(imp)} = ${ctr}%`,
        values: { imp, click, ctr }
      };
    }
  },
  cpc: {
    label: "CPC",
    formula: "CPC = Cost ÷ Click",
    make() {
      const click = pick([50, 80, 100, 120, 150, 200, 250, 400]);
      const cpc = pick([60, 80, 100, 120, 150, 200, 250, 300]);
      const cost = click * cpc;
      return {
        q: `広告費（Cost）${yen(cost)}、クリック ${num(click)}回。CPC（クリック単価）は？`,
        answer: String(cpc),
        accept: moneyAccept(cpc),
        explain: `CPC = Cost ÷ Click = ${num(cost)} ÷ ${num(click)} = ${yen(cpc)}`,
        values: { cost, click, cpc }
      };
    }
  },
  cvr: {
    label: "CVR",
    formula: "CVR = CV ÷ Click",
    make() {
      const click = pick([50, 100, 200, 250, 400, 500, 1000]);
      const cvr = pick([2, 4, 5, 8, 10, 12, 20]);
      const cv = Math.round((click * cvr) / 100);
      return {
        q: `クリック ${num(click)}回のうち、問い合わせ（CV）が ${num(cv)}件。CVR は何%？`,
        answer: `${cvr}%`,
        accept: percentAccept(cvr),
        explain: `CVR = CV ÷ Click = ${num(cv)} ÷ ${num(click)} = ${cvr}%`,
        values: { click, cv, cvr }
      };
    }
  },
  cpa: {
    label: "CPA",
    formula: "CPA = Cost ÷ CV",
    make() {
      const cv = pick([5, 8, 10, 12, 15, 20, 25, 40]);
      const cpa = pick([2000, 4000, 5000, 6000, 8000, 10000, 12000, 15000]);
      const cost = cv * cpa;
      return {
        q: `広告費 ${yen(cost)} で問い合わせ（CV）${num(cv)}件。CPA（CV単価）は？`,
        answer: String(cpa),
        accept: moneyAccept(cpa),
        explain: `CPA = Cost ÷ CV = ${num(cost)} ÷ ${num(cv)} = ${yen(cpa)}`,
        values: { cost, cv, cpa }
      };
    }
  },
  roas: {
    label: "ROAS",
    formula: "ROAS = CV Value ÷ Cost",
    make() {
      const cost = pick([100000, 200000, 250000, 400000, 500000, 1000000]);
      const roas = pick([80, 120, 150, 200, 250, 300, 400, 500]);
      const value = (cost * roas) / 100;
      return {
        q: `広告費 ${yen(cost)}、CVに付けた価値（CV Value）の合計 ${yen(value)}。ROAS は何%？`,
        answer: `${roas}%`,
        accept: [...percentAccept(roas), `${roas / 100}倍`],
        explain: `ROAS = CV Value ÷ Cost = ${num(value)} ÷ ${num(cost)} = ${roas}%`,
        values: { cost, value, roas }
      };
    }
  },
  "cpa-decomp": {
    label: "CPA = CPC ÷ CVR",
    formula: "CPA = CPC ÷ CVR",
    make() {
      const cpc = pick([80, 100, 120, 150, 200, 240, 300]);
      const cvr = pick([2, 4, 5, 8, 10]);
      const cpa = Math.round(cpc / (cvr / 100));
      return {
        q: `CPC ${yen(cpc)}、CVR ${cvr}%。CPA はいくら？（クリック数は不明）`,
        answer: String(cpa),
        accept: moneyAccept(cpa),
        explain: `CPA = CPC ÷ CVR = ${cpc} ÷ ${cvr / 100} = ${yen(cpa)}。CPA悪化はCPCとCVRのどちらが動いたかで分ける`,
        values: { cpc, cvr, cpa }
      };
    }
  },
  "lead-value": {
    label: "期待粗利 / Lead",
    formula: "期待粗利/Lead = P(成約|Lead) × 粗利/成約",
    make() {
      const leads = 100;
      const deals = pick([2, 4, 5, 8, 10]);
      const profit = pick([20000, 30000, 40000, 50000, 60000]);
      const perLead = (deals * profit) / leads;
      return {
        q: `問い合わせ ${leads}件から成約 ${deals}件、1成約あたりの限界粗利 ${yen(profit)}。問い合わせ1件の期待粗利は？`,
        answer: String(perLead),
        accept: moneyAccept(perLead),
        explain: `期待粗利/Lead = (${deals} ÷ ${leads}) × ${num(profit)} = ${yen(perLead)}。許容CPAの上限はここから逆算`,
        values: { leads, deals, profit, perLead }
      };
    }
  },
  "marginal-cpa": {
    label: "限界CPA",
    formula: "限界CPA = 追加広告費 ÷ 追加CV",
    make() {
      const extraCost = pick([50000, 100000, 150000, 200000, 300000, 400000]);
      const extraCv = pick([5, 10, 20, 25, 40, 50]);
      const cpa = extraCost / extraCv;
      return {
        q: `広告費を ${yen(extraCost)} 追加したら、問い合わせが ${num(extraCv)}件増えた。限界CPA は？`,
        answer: String(cpa),
        accept: moneyAccept(cpa),
        explain: `限界CPA = 追加広告費 ÷ 追加CV = ${num(extraCost)} ÷ ${num(extraCv)} = ${yen(cpa)}。平均CPAより高くなるのが普通`,
        values: { extraCost, extraCv, cpa }
      };
    }
  }
};

export function generateCalc(kind) {
  const def = CALC_KINDS[kind];
  if (!def) return null;
  const made = def.make();
  return { ...made, formula: def.formula, label: def.label };
}
