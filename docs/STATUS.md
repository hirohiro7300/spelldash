# SpellDash 現状整理（2026-07-11時点）

上流設計の協議用スナップショット。実装の詳細仕様・インフラ・データ構造・既知の課題を網羅する。

## 1. コンセプトと現在地

- 表向き：**思い出すことで記憶を定着させる学習サービス**（Active Recall中心）
- 裏側：ゲーミフィケーション（XP/レベル/称号/コンボ/ストリーク）
- 最終ビジョン：**Knowledge Map Platform**（知識をノードとエッジで可視化、他教科へ拡張）
- UI方向性（未着手）：Monkeytype / Notion / Obsidian系ミニマル

## 2. インフラ・環境

| 項目 | 状態 |
|---|---|
| リポジトリ | github.com/hirohiro7300/spelldash（mainブランチ、push→Vercel自動デプロイ） |
| 本番URL | https://www.spelldash.net（apex spelldash.net は308でwwwへ転送） |
| 旧URL | https://spelldash.vercel.app（生きている） |
| DNS | お名前.com（dnsv.jp）。@ A 216.198.79.1 / www CNAME cname.vercel-dns.com |
| SSL | Vercel自動発行（Let's Encrypt） |
| 認証 | Supabase Auth（プロジェクト: sujvgwozsnzjsjmkcrnk） |
| ├ メール | マジックリンク。**内蔵SMTPのため1時間2通制限あり** |
| ├ Google | OAuth実装済み・動作確認済み（Google Cloudプロジェクト "spelldash"） |
| └ URL設定 | Site URL: www.spelldash.net / Redirect: vercel.app, localhost:4173 |
| DB | **未使用**。Supabaseは認証のみ。学習データはすべてlocalStorage |
| 技術構成 | 素のHTML/CSS/JS（ESモジュール）。ビルドなし・フレームワークなし。supabase-js v2はesm.sh CDN |

## 3. ページ構成

- **index.html（プレイ）**: ヘッダー / ヒーロー / Today's Mission / レベルバー / カテゴリ選択チップ / Study・Challenge切替 / 統計カード / ゲームカード / フッター
- **stats.html（学習データ）**: レベルバー / 概要メトリクス10枚 / タイピング分析6枚 / 習得進捗バー / 苦手単語Top5 / 単語一覧（カテゴリフィルタ＋検索、表示200語まで）
- **profile.html（プロフィール）**: アバター・メール・登録日 / レベルバー / 学習サマリー / タイピング
- ヘッダー共通: ナビ（プレイ/学習データ）＋アカウント（未ログイン=ログインボタン→ホバーでGoogle/メールパネル、ログイン中=アバター→ホバーでメニュー）

## 4. JSモジュール構成（js/）

| ファイル | 責務 |
|---|---|
| main.js / statsView.js / profileView.js | 各ページのエントリ（非同期初期化） |
| game.js | ゲームエンジン（モード管理・Enterフロー・XP・コンボ・出題抽選） |
| stats.js | 単語statsの記録＋簡易SRS |
| storage.js | localStorage全般＋**migration機構（schema v3）** |
| level.js | XP/レベル/称号/デイリーストリーク |
| levelUi.js | レベルバー描画・レベルアップ演出 |
| mission.js | Today's Mission（生成・進行・COMPLETE判定） |
| wordData.js | data/*.json のfetchローダー（キャッシュ付き） |
| wordStore.js | ページ内の単語ストア（全語・カテゴリ絞り込み・索引） |
| categoryPicker.js | カテゴリ選択チップ |
| wordList.js | 単語一覧UI（フィルタ・検索） |
| auth.js | Supabase認証（マジックリンク/Google、ドロップダウンUI） |
| supabase.js | クライアント初期化（anonキー埋め込み・公開キー） |
| ui.js / summary.js / colors.js / footer.js | DOM操作・集計・文字色・共通部品 |

## 5. 単語データ

```
data/
  manifest.json   ← 教科・カテゴリ台帳 {subjects:[{id,label,categories:[{id,label,file}]}]}
  english/  junior(160) highschool(160) toeic(150) business(140) it(140) travel(130) daily(120)
```

- **合計1000語**（ユニーク910語。89語はカテゴリ間重複＝同一単語の統計は共有される）
- 単語スキーマ: `{id, en, ja, level(easy/normal/hard), tags[]}`。subject/categoryはファイル先頭に1回書き、ロード時に各単語へ注入
- `id`は文字列（現状 en と同値）。将来 `prerequisites` / `links` をIDで張ればKnowledge Mapのグラフになる
- 教科追加 = data/<subject>/ を作りmanifestに追記するだけ
- 注意: 単語はAI生成（人間の校閲なし）

## 6. localStorage（クライアント保存データ）

| キー | 内容 |
|---|---|
| spelldash_word_stats | 単語ごと（キーは`en`）: playCount / correctCount / missCount / **typingMiss** / **recallFail** / cleanCorrectStreak / mastered / masteredAt / **lastPlayed** / **nextReviewAt** |
| spelldash_typing_stats | correctChars / missChars / seconds / sessions / bestSpeed（Challengeのみ加算） |
| spelldash_best_score | ベストスコア（Challengeのみ） |
| spelldash_xp | 総XP |
| spelldash_streak | {last, current, best}（連続プレイ日数） |
| spelldash_mission | {date, review[], new[], reviewDone[], newDone[], bonusAwarded} |
| spelldash_category | 出題カテゴリ選択 |
| spelldash_mode | study / challenge |
| spelldash_schema_version | 3（migration管理。v2でSRSフィールド、v3でミス分離を追加） |

## 7. 学習体験の仕様（現行）

### モード
- **Study（デフォルト）**: 制限時間なし。1語ごとに即XP反映（レベルアップもその場で発生）。統計表示は「正解・思い出せず・ミスタイプ」のみ
- **Challenge**: 60秒。スコア・平均タイプ速度・ベスト更新。XPは終了時にまとめて反映

### Enterフロー（Active Recall・両モード共通）
1. 日本語訳が出る。スペルは非表示
2. 打ち間違い → 「Miss!」表示のみ。**答えは出ない**（typingMissとして記録）
3. 分からない → **Enterで答え表示**（recallFailとして記録・SRSリセット）
4. 答え表示後 → 入力して練習（+5 XP）or もう一度Enterで次へ

### XP
- 思い出して正解: 10 +（ノーミス5）+ コンボボーナス（最大10）
- 答えを見た後の練習タイプ: +5
- 今日の初プレイ: +50 / ミッション完了: +40
- レベル: 次のレベルまで 100+(lv-1)×50 XP。称号11種（見習いタイピスト〜伝説のスペルダッシャー Lv.50）

### 簡易SRS
- 連続ノーミス正解数 → 復習間隔 [1,2,3,5,7,10,14,21,30]日
- 10連続で mastered。recallFailで即復習対象・mastered解除
- ミスありの正解は+1日

### Today's Mission（1日1回生成）
- Review 最大12語: 未習得 かつ（recallFailあり or 復習期限到来）。優先度 = missCount降順 → lastPlayed昇順
- New 5語: 未プレイ語から、選択中カテゴリ→易しいレベル優先
- ミッション対象は通常出題で優先（重み+8）→ 遊ぶだけで自然に達成
- 達成で静かな「MISSION COMPLETE」＋40 XP

### 出題抽選（重み付きランダム）
基本3 / +missCount×3 / 正答率50%未満+5 / mastered=1 / ミッション対象+8。選択カテゴリ内から抽選

## 8. 既知の課題・技術的負債

### 機能面
1. **学習データがブラウザ内のみ**（localStorage）。ログインしてもデータは同期されない＝アカウントの実益がまだない。クラウド保存（Supabase DB + RLS）が未着手
2. メールログインは1時間2通制限のまま（Resend SMTP設定が途中: resend.com/domains/add まで。Googleログインがあるため優先度低下）
3. GoogleのOAuth同意画面が未検証状態 → 他人がログインすると「確認されていないアプリ」警告が出る。一般公開前に検証申請が必要
4. Recall Accuracy等の統計は**データ収集のみ開始済み**、表示未実装
5. UIミニマル化（脱ゲーム見た目）未着手。フッターの「使い方/プライバシー」リンクはプレースホルダ（#）
6. スマホ表示の本格検証未実施

### 設計面
7. 単語statsのキーが`en`（idではない）。英語のみなら問題ないが、他教科追加時にid化のmigrationが必要
8. カテゴリ間重複89語は統計を共有する仕様（意図的だが、カテゴリ別の習得率を出すときに注意）
9. タイピング速度統計はChallengeのみ記録（Studyの学習時間は未計測）
10. テストコードなし。ビルドパイプラインなし（素のJS、それ自体は意図的）
11. Googleクライアントシークレットを一度チャットに貼ってしまった → ローテーション推奨（未実施なら）

## 9. 収益化・成長に向けて未着手の領域

- クラウド保存（端末間共有・データ資産化）
- Knowledge Map可視化（tags/idは準備済み、グラフUIなし）
- 他教科（math等。データ構造は対応済み）
- ランキング・共有機能（Challengeモードの設計意図に含まれる）
- PWA化・効果音（TODOに残存）
- 単語データの品質校閲・追加拡張

## 10. 開発体制メモ

- 上流設計: ユーザー＋ChatGPT / 実装: Claude Code
- ドキュメント: docs/DESIGN.md（コンセプト・設計）、docs/CHANGELOG.md（変更履歴）、docs/TODO.md
- ローカル確認: `python3 .claude/serve.py` → http://localhost:4173
