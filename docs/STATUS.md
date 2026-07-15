# SpellDash 現状整理（2026-07-15 自走セッション第2弾完了時点）

## 直近の追加（2026-07-15 自走セッション: 計12機能を本番反映）

### 第1弾（PR#3〜#7）
1. **Daily Dash**: 1日1回・全ユーザー共通問題の60秒チャレンジ（日付シード決定論生成）
2. **結果シェア**: Wordle式テキスト（🟩🟨⬛グリッド＋スコア＋ストリーク＋URL）
3. **PWA化**: manifest＋SW（Network First・オフライン対応）＋SDアイコン
4. **単語品質チェック**: 全1000語検証（機械検証0件、訳語修正2件＋表記ゆれ統一2件）
5. **学習の伸び可視化**: スコア推移SVGグラフ＋思い出し成功率＋セッションログ

### 第2弾（PR#9〜#14）
6. **OGP対応**: 全ページメタタグ＋OG画像 → シェアURLがリッチカード表示
7. **デイリーランキング**: TOP5＋自分の順位（daily_scoresテーブル、**Supabase SQL適用待ち**。未適用でも静かに非表示でゲーム影響なし）
8. **苦手のみ復習モード**: Studyトグル。苦手語だけ出題→全クリアで達成演出
9. **効果音**: WebAudio合成SE 7種（設定ON/OFF、バトル込み）
10. **初回オンボーディング**: 「30秒で分かるSpellDash」→最初の1語へ誘導
11. **表示名編集**: profiles.display_name編集（ランキング用、ローカルキャッシュ優先）
12. **週間サマリー**: 今週の思い出せた語数・プレイ回数・ベスト・Daily完走（先週比つき）＋README全面刷新

前日(07-14) には Streak Guard（PR#1）とモバイル入力対応（PR#2）を反映済み。

**Wordle型バイラルループ完成**: 毎日同じ問題✓ → ランキングで競う✓ → シェア✓ → OGPリッチカードで流入✓
**残るユーザー操作**: Supabase SQL Editorでschema.sql末尾のdaily_scoresブロックを実行（ランキング有効化）

---

## 前回の追加（モバイル入力対応）

- ソフトキーボード（Android Gboard等）でプレイ不能だった問題を修正（keydown依存 → inputイベント照合を併用）
- メインゲーム・バトル両対応。予測変換の一括挿入・削除の巻き戻しにも対応
- ソフトキーボードのEnter（Go）で開始・答え表示・パスが可能に
- 390px幅のレイアウト確認済み（横崩れなし）
- **これによりスマホ主体のユーザー（中高生、通勤中の社会人・TOEIC学習者）がプレイ可能になった**
- ※ターゲットは中高生に限らず、社会人の英語学び直し層も含む。「英語とタイピングを同時に学べる」ことが独自の強み

---

## 前回の追加（Streak Guard: ストリーク可視化＋シールド）

- ホーム画面にストリークカード（🔥連続日数・今日クリア済みか・シールド・ベスト）を常時表示
- ストリークシールド: 5日連続ごとに1枚獲得（最大2枚）。休んだ日は自動消費で連続記録を守る（1枚=1日）
- 消費・獲得はカードとプレイ後メッセージで明示。シールド不足時のリセットでもシールドは失わない
- streak jsonbに shields / shieldSavedOn を追加（スキーマ変更不要・後方互換・端末間同期対応）

---

## 前回の追加（Study Recall Loop）

- Studyモード：思い出せなかった単語（Unresolved・赤）が3〜5問後に再出題され、自力正解（緑）するまで巡回
- 「今日思い出せた」（Recalled Today）日次ユニークカウント
- lastRecallFailAt / lastRecallSuccessAt をローカル＋word_progressに追加（フィールド単位マージ）→ **Unresolvedは端末をまたいで復元**
- 練習+5XPはセッション内同一単語1回まで。typingMiss/recallFail分離は維持
- Challenge・SRS・mastered判定は変更なし

---
（以下は前フェーズ時点の整理。上記以外は変わらず）


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
