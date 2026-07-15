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
