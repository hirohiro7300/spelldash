# 初めて来た人が Pro に加入するまでの動線

2026-10-06 作成（Batch 49）。対象は Web 版。アプリ版（Capacitor）は購入の導線を出さない（ストアの規則。加入と管理は Web 版）。

## 原則

- 学習の核は無料。Pro は「上限が増える・長く続ける人の余裕」で、学習を止めて売らない
- Pro の話は、受付中（Stripe の設定が済み、月額の価格がある）のときだけ出す。受付前に「受付前」と書いたページへ送らない
- 完了パネル・道・はちゃんの台詞には Pro を出さない（docs/CHARACTER.md の 3 場面は伴走のため）
- 押し売りの言い方をしない。文は常体で短く、数字は比較表と同じ

## 段階

| 段階 | どこで | 何を出すか | コード |
|---|---|---|---|
| 0. 初回 | トップ → 腕試し → 1 セット | Pro は出さない | — |
| 1. 知る（いつでも） | 全ページのフッター | 「SpellDash Pro」（受付中のときだけ。加入画面では出さない） | js/proFunnel.js renderFooterPro |
| 1. 知る（続けた人） | 学習データの週間レポート | 学んだ日が 7 日以上・Pro でない人に 1 行「Pro なら、シールド 3 枚・推移 90 日・マイ単語帳 1,000語。Pro について」 | js/weeklyReport.js |
| 1. 知る（上限に当たった） | マイ単語帳 100 語・AI の回数・推移 90 日・連続記録の修復・テーマ | それぞれの場所に「Pro について」 | 既存 |
| 2. 比べる | /pro.html | 比較表 5 項目、料金、ボタンの直下に「申し込みの前に」（料金・更新・解約・支払い）と特商法・利用規約へのリンク | js/proView.js termsHtml |
| 3. ログイン | /pro.html の「ログインして始める」 | 押すと加入の途中の印（`spelldash_pro_intent`、30 分）を付けてログインを開く。メールのリンク・Google から戻るとトップに着くので、印があれば /pro.html?resume=1 へ戻し「ログインした。月額か年額を選ぶ。」、月額のボタンに焦点 | js/proFunnel.js resumeProIntent、js/auth.js |
| 4. 支払う | Stripe Checkout | 月額・年額。無料期間（`STRIPE_TRIAL_DAYS`）があれば申し込みの前にで言う | api/billing/checkout.js |
| 5. 加入直後 | /pro.html?pro=done | 反映を待って「Pro になった。ありがとう」と、使えるようになったもの 5 つ（マイ単語帳・テーマへはリンク） | js/proView.js maybeWelcome |
| 5'. 中止 | /pro.html?pro=cancel | 「手続きを中止した。いつでも再開できる」 | 既存 |

## 受付中かどうか

`/api/billing/config` の `configured` と月額の価格。全ページで毎回は取りに行かず、`spelldash_billing_open` に 12 時間キャッシュする（加入画面を開いたときは取り直して上書き）。

## まだ無いもの（次の候補）

- 段階ごとの数（フッター → 加入画面 → ログイン → Checkout → 加入）の計測。いまは Stripe のダッシュボード（Checkout の開始・完了）と CRM のプラン列だけ。計測するなら activity_days とは別の表が要る（SQL）
- 無料期間の有無と日数の判断（創業者。`STRIPE_TRIAL_DAYS`）
- Pro の中身そのもの（docs/PRO_VALUE.md）。動線は中身が弱いと数字に出ない
