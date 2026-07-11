# SpellDash 現状整理（2026-07-11 Knowledge Databaseフェーズ完了時点）

上流設計（ChatGPT協議）用スナップショット。

## 1. コンセプトと現在地

- 表向き：**思い出すことで記憶を定着させる学習サービス**（Active Recall中心）
- 裏側：ゲーミフィケーション（XP/レベル/称号/コンボ/ストリーク）
- 最終ビジョン：**Knowledge Map Platform**
- **今回の達成：学習データの資産化が完了。「ログインすれば端末が変わっても知識が残る」が本番で動作確認済み**

## 2. インフラ

| 項目 | 状態 |
|---|---|
| 本番 | https://www.spelldash.net（Vercel、mainへのpushで自動デプロイ） |
| 認証 | Supabase Auth（Google OAuth＋メールマジックリンク） |
| DB | **Supabase Postgres 稼働開始**（4テーブル、RLS＋GRANT設定済み、本人のみアクセス可） |
| クライアント | 素のHTML/CSS/JS（ESモジュール）、ビルドなし |

## 3. データベース（Supabase）

| テーブル | 内容 | 主キー |
|---|---|---|
| profiles | 表示名・アバター・音声設定（audio_mode / preferred_accent） | user_id |
| word_progress | 単語ごとの学習記録（play/correct/typing_miss/recall_fail/streak/mastered/last_played/next_review_at） | user_id + word_id |
| user_progress | XP・レベル・ストリーク(jsonb)・ベストスコア・選択カテゴリ/モード | user_id |
| play_sessions | Challengeごとの履歴（score/speed/miss/duration） | id (uuid) |

- 全テーブルRLS有効＋authenticatedロールにのみGRANT。`auth.uid() = user_id` で本人のみ
- スキーマは `supabase/schema.sql` としてリポジトリに保存

## 4. 同期設計（Local First）

- プレイ中はlocalStorageのみに書き込み（毎入力の通信なし）
- **同期タイミング**：Challenge終了時／Studyで10語ごと／ページ離脱時／ログイン直後
- 変更のあった単語だけをdirty管理してupsert（差分同期）
- **初回マージ**：クラウド空→ローカル全アップロード。両方あり→単語ごとにlast_played比較で新しい方を採用。XP・ベスト・最長ストリークは大きい方
- 同期失敗時はローカルで動き続け、次回再試行（フラグ巻き戻し）
- 本番実測済み：34単語・XP・ストリークがクラウド保存され「学習データをクラウドと同期しました」表示

## 5. 単語ID設計（schema v4）

- 主キーを `english-apple` 形式（**教科-単語**）に変更。migration v4で既存ユーザーデータを自動変換
- 依頼の `eng-junior-0001` 形式は不採用。理由：①カテゴリ間重複語（89語）の学習記録を共有すべき（カテゴリは所属でありIDではない）②連番は挿入・削除に弱い
- 将来：`math-...` 等のプレフィックスで他教科に対応。Knowledge Mapのノード IDとしてそのまま使える

## 6. 発音機能（基盤）

- Web Speech API採用（音声ファイル不要・オフライン可・US/UK切替）
- 答え表示時に自動再生（1回）＋🔊ボタンで手動再生
- 設定（auto/manual/off、US/UK）はプロフィールページで変更、profilesテーブルに同期
- 未実装：IPA表記（ipaUs/ipaUk）。データ構造は任意フィールドで拡張可能。音声ファイル（audioUs/audioUk）への差し替えも将来可能

## 7. localStorage（schema v4）

| キー | 内容 |
|---|---|
| spelldash_word_stats | 単語ごと（キーは**word.id**）。playCount/correctCount/missCount/typingMiss/recallFail/cleanCorrectStreak/mastered/lastPlayed/nextReviewAt |
| spelldash_dirty_words | 前回同期以降に変更された単語ID（差分同期用） |
| spelldash_audio | 音声設定 {mode, accent} |
| spelldash_xp / streak / mission / category / mode / best_score / typing_stats | 従来どおり |
| spelldash_schema_version | **4** |

## 8. OAuth公開準備

- プライバシーポリシーページ公開済み：https://www.spelldash.net/privacy.html（フッターからリンク）
- **残タスク（ユーザー操作1分）**：Google Cloud Console → Audience →「アプリを公開」ボタンで本番公開に切替。基本スコープのみなので審査不要で「未確認アプリ」警告が消える

## 9. 既知の課題（次の協議材料）

1. **UIミニマル化が未着手**（Monkeytype/Notion系へ。コンセプトの「顔」）
2. Recall Accuracy等の統計表示（データは収集中、UI未実装）
3. Knowledge Map可視化（id/tagsは準備済み。「意味ある接続」データが不足 → prerequisites/links の設計・付与が先）
4. play_sessionsを使った分析画面（成長グラフ等）未実装
5. ランキング（play_sessions/user_progressが土台。公開範囲設計が必要）
6. 単語データの品質校閲（AI生成1000語）
7. メールログインのレート制限（Resend SMTP途中。Googleログインで実質カバー）
8. スマホ対応の本格検証・PWA化
9. 課金設計（何を有料にするか未定義）

## 10. 収益化に向けて揃った土台

- ✅ アカウント（Google）＋クラウドデータ資産
- ✅ 継続の仕組み（ミッション・SRS・ストリーク・XP）
- ✅ 学習の質データ（recallFail/typingMiss分離、セッション履歴）
- ✅ 拡張可能なデータ構造（教科・カテゴリ・タグ・ID）
- 未：見た目のブランド化、Map可視化、課金導線
