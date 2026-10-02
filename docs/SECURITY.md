# SpellDash セキュリティ監査レポート（2026-07-15）

ローンチ前監査。対象: フロントエンド全コード・Supabaseスキーマ/RLS・Service Worker・共有機能。

## ✅ 問題なし（確認済み）

| 項目 | 結果 |
|---|---|
| 秘密情報の混入 | なし。リポジトリ内のキーはanon（公開前提）のみ。service_roleキーなし |
| 危険シンク（eval / new Function / document.write / javascript:） | 使用なし |
| XSS | innerHTML全箇所を精査。ユーザー入力が流入するのはランキングの display_name のみで、`escapeHtml` でエスケープ済み。他は単語データ（リポジトリ管理）・数値・定数のみ |
| RLS | 全テーブルで有効。daily_scores の select-all 以外はすべて `auth.uid() = user_id` で本人限定 |
| Service Worker | same-origin GET のみ処理。クロスオリジン（Supabase・認証）には触れない。res.ok のみキャッシュ |
| target="_blank" | すべて rel="noopener" 付き |
| 外部通信先 | esm.sh（Supabase SDK）と Supabase プロジェクトのみ |
| 依存パッケージ | ゼロ（ビルドなし・npm依存なし）。サプライチェーン面が極小 |

## ⚠️ 発見事項と対応

### 1.【中】daily_scores に値の制約がない → 対応準備済み
anonキーは公開情報なので、誰でも「認証ユーザー」としてREST APIから直接insertできる。
score=999999 や巨大display_nameの荒らしが可能だった。
**対応**: schema.sqlにCHECK制約を追加（score 0〜200 / display_name 30文字以内 / day形式）。
※「もっともらしい偽スコア」はクライアント信頼モデルの限界として残る（受容リスク。将来はEdge Functionでのサーバー採点で解消可能）

### 2.【低】ランキング記録を本人が削除できない → 対応準備済み
プライバシーポリシーでは「連絡してください」としていたが、self-serviceが望ましい。
**対応**: `daily_scores_delete_own` ポリシー追加（UI導線は将来。当面は本人がAPIで削除可能に）

### 3.【低】セキュリティヘッダー未設定 → 対応準備済み
**対応**: vercel.json 新規作成（X-Frame-Options: DENY / nosniff / Referrer-Policy / Permissions-Policy / CSP）。
CSPはインラインscript（SW登録）とesm.shを許可する現実的な構成

### 4.【低・受容】daily_scores が user_id (UUID) を公開
自分の行のハイライトに使用。RLSは auth.uid() 基準のため、UUIDを知っても他人のデータにはアクセス不可。受容

### 5.【低・記録】esm.sh 単一障害点
supabase.js が CDN import のため、esm.sh 障害時はモジュールグラフ全体が失敗しアプリが起動しない。
**推奨（将来）**: dynamic import化＋失敗時スタブでLocal First起動を保証。バージョンも完全固定（@2.x.y）が望ましい

### 6.【低・記録】メールマジックリンクのレート制限
Supabase側設定の既知課題（STATUS.md記載）。Googleログインが主経路のため優先度低

### 7.【低・記録】play_sessions / battle_sessions へのスパムinsert
認証ユーザーは大量insertで自分の統計を歪められる（他人には影響なし）。KPI集計時は異常値除外で対処可能。受容

## 適用手順（承認後）

1. `supabase/schema.sql` 末尾の「セキュリティ強化」ブロックをSQL Editorで実行（CHECK制約＋delete_own）
2. `vercel.json` をmainへマージ → 自動デプロイでヘッダー有効化
3. 反映後の確認: `curl -sI https://www.spelldash.net | grep -iE "x-frame|content-security"` でヘッダー確認、CSP違反がコンソールに出ないか全ページ巡回

## 2026-10-02 追記: 決済（SpellDash Pro、docs/BILLING.md）

| 項目 | 対応 |
|---|---|
| 鍵の置き場 | `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `SUPABASE_SERVICE_ROLE_KEY` は Vercel の環境変数だけ。クライアント・応答・ログに出さない。リポジトリに Stripe の鍵（`sk_` や `whsec` で始まる文字列）は無い（受け入れ基準の grep） |
| カード情報 | Stripe Checkout（Stripe のドメイン）で入力。SpellDash のサーバーには来ない。持つのは status・更新日・Stripe の顧客 id／subscription id／price id だけ（privacy.html「お支払い情報」） |
| Webhook の署名 | `Stripe-Signature` の `t` と `v1` を分解し、生ボディで HMAC-SHA256 → `crypto.timingSafeEqual`（長さ違いは不一致）。`|now − t| > 300 秒` は拒否。`bodyParser: false` で生ボディを読む。未設定なら 503 |
| 逆順到着・再送 | `subscriptions.event_created` に最後に反映した event の `created` を持ち、それ以下は書かない。Supabase に書けなければ 500 を返して Stripe の再送に任せる |
| RLS | `subscriptions` は本人が自分の行を select するだけ（`auth.uid() = user_id`）。insert／update／delete は anon／authenticated から revoke。書くのは webhook（service role）だけ。checkout／portal／AI の回数判定は本人のトークン + anon key で読む |
| 冪等性・二重課金 | Checkout 作成に `Idempotency-Key: checkout:<userId>:<interval>:<分>`。本人の行が Pro なら 409 で Checkout を作らない。Portal は `stripe_customer_id` が無ければ 404 |
| リダイレクト先 | success／cancel／return の URL は `SITE_ORIGIN`（既定 本番）だけから作り、リクエストの Host／Origin ヘッダは使わない |
| PII | ログは `billing/<label>: <種別> <状態>` だけ。メール・顧客 id・本文は書かない。CRM にも Stripe の id は出さない。応答は `Cache-Control: no-store`、sw.js は `/api/` を保存しない |
| CSP | 外部へのリダイレクトは `location.href`（Stripe のドメイン）。スクリプト・接続先の許可は増やしていない（Stripe.js は使わない） |
| 受容リスク | クライアントの `isPro()` は localStorage のキャッシュで、改ざんすれば単語帳の上限・テーマ・修復は端末内で外せる（学習に不公平は生まれない。AI の回数はサーバーで判定） |
