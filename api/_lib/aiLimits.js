// ===== AI の 1 日の回数（無料・Pro）と、AI が使えるか =====
//
// 回数を決めるのはここだけ。覚え方の解説（api/explain-word.js）のゲート（_lib/shared.js の aiTake）と、
// 加入画面の比較表の数（/api/billing/config の ai → js/proView.js）が同じ値を読む（画面の文と本当の上限がずれない）。
// 環境変数: EXPLAIN_WORD_DAILY_LIMIT（無料・既定 3）・EXPLAIN_WORD_DAILY_LIMIT_PRO（Pro・既定 60）。
// 場面カードの自動生成（api/generate-cards.js）: CARD_GEN_DAILY_LIMIT（無料・既定 2）・CARD_GEN_DAILY_LIMIT_PRO（Pro・既定 20）。
//   比較表には出さない（今の画面に入口が無い）。CARD_GEN_ENABLED=1 を入れるまで止めてある（Batch 88: 鍵を入れても使われない）。
// AI が使えるかは鍵（ANTHROPIC_API_KEY）があるかだけで決める（無ければ explain-word は「この機能は準備中」の 503）。

export function explainWordLimits(env = process.env) {
  return {
    free: Number(env.EXPLAIN_WORD_DAILY_LIMIT) || 3,
    pro: Number(env.EXPLAIN_WORD_DAILY_LIMIT_PRO) || 60
  };
}

export function aiConfigured(env = process.env) {
  return Boolean(env.ANTHROPIC_API_KEY);
}

export function cardGenLimits(env = process.env) {
  return {
    free: Number(env.CARD_GEN_DAILY_LIMIT) || 2,
    pro: Number(env.CARD_GEN_DAILY_LIMIT_PRO) || 20
  };
}

// 場面カードの自動生成を受け付けるか（CARD_GEN_ENABLED=1 のときだけ）
export function cardGenEnabled(env = process.env) {
  return env.CARD_GEN_ENABLED === "1";
}
