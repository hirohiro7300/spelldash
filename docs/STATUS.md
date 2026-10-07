# SpellDash 現状スナップショット（2026-10-07）

> 2026-07-17 版は docs/archive/STATUS_2026-07-17.md に移した（当時の設計論点と、9 月までの追記の履歴はそちら）。
> 変更の履歴は docs/CHANGELOG.md、次にやることは docs/BACKLOG.md、**創業者側の作業と判断は docs/FOUNDER_TODO.md**。

## 1. ひとことで

**SpellDash**（https://www.spelldash.net）— 日本語の訳を見て英単語を記憶から打つ「思い出して打つ」学習サービス。Local-First（学習記録は端末が正、ログインでクラウド同期）。デザインは「墨と朱」（docs/CONCEPT.md）。
対象は社会人の英語学び直し層を中心に、中高生・受験生も。公式キャラクター はちゃん は伴走者で、出るのは 3 場面だけ（docs/CHARACTER.md）。

## 2. いま入っているもの

### 学習
- **4 モード（増やさない）**: Study（セット・Recall Loop・SRS）／Challenge（60 秒）／Daily Dash（全員同じ問題・ランキング）／Battle（CPU ランクマッチ。ロジックは凍結、色・面・文字列だけ触る）
- **道（ホーム）**: コース（10 本: 中学やり直し・ビジネス・会話・高校・英検・NGSL・TSL・BSL・NAWL・TOEIC）→ セクション → ユニット。済みは畳み、現在地のスタートが最初の画面に来る。前回の続きから再開
- **判定**: 1 ミス＝不正解（Clean Correct）。**別解**: 同じ訳の別の英単語を打つと「talk も「話す」。この問題の語は speak」と案内して不正解にしない。パック内で訳のトークンを共有する語は自動で別解、加えて `accept` を人手で確認済み（英単語パック 81 本・4,914 枚・8,908 語）。つづり違い（favourite／favorite）はそのまま正解
- **教材**: 171 カテゴリ・15,464 枚（分野パック 162、`/packs/<id>.html` に入口ページ）。オープン教材は NGSL 24・TSL 11・BSL 15・NAWL 8 = 58 パック・6,814 語（CC BY-SA 4.0、出典表記あり）。英単語カードには例文（ex／exJa）。形式は docs/PACK_FORMAT.md、検証は `node scripts/validate-words.mjs`
- **マイ単語帳**（1 語ずつ／まとめて／場面カード／AI でテキストから）、単語の詳細（履歴・メモ・覚え方を作る）、覚えた単語帳、学習データ（今週・記録・分析）、週間レポート、学習カレンダー
- **音声**: 端末でいちばん自然な英語の声を自動選択、声の試聴、速さ、音で出題（0／25／50%）、効果音（短く小さく。BGM は無し）
- **チュートリアル**: 初回の 1 セットに 1 文ずつ（3 ステップ: 答えを見た→数問後にもう一度／自力で思い出せた→次は日をあけて／道→毎日スタートだけ。画面下の札、既存ユーザーには出ない。docs/SPEC_TUTORIAL.md）
- **専用の画面キーボード**（スマホ。A〜Z＋⌫＋Enter、英文カードだけ空白）。Capacitor で iOS／Android の器もある（docs/APP.md。ストア未提出）

### 継続
- 連続日数＋シールド（5 日ごとに 1 枚、最大 2 枚。Pro は 3 枚＋月 1 回の修復）、XP・レベル・称号（小さく 1 行）、今日のセット（10／15／25 語）、週の学習日の目標

### 有料プラン SpellDash Pro（2026-10-02 解禁、**受付はまだ**: docs/FOUNDER_TODO.md B）
- Stripe Checkout／Billing Portal／Webhook（`api/billing/*`、SDK 無し）。価格はコードに無く Stripe の Price から表示。アプリでは購入導線を出さない
- entitlement: `subscriptions` 行が active／trialing／past_due かつ 期限＋3 日。クライアントは `js/plan.js` が `spelldash_plan` にキャッシュして同期判定
- 特典: マイ単語帳 100 → 1,000 語、AI の 1 日の回数（2／3 → 20／60）、推移 30 → 90 日、シールド 3 枚＋修復、テーマ「紙」「藍」
- 法務: `/terms.html`、`/tokushoho.html`（［ ］は創業者が記入。それまで noindex）、privacy の「お支払い情報」
- 加入までの動線（docs/SPEC_FUNNEL.md）: フッターの「SpellDash Pro」と週間レポートの 1 行（受付中・7 日以上・Pro でない人だけ）、上限に当たった 5 か所の「Pro について」、加入ボタンの直下の「申し込みの前に」（料金・更新・解約・支払い）、加入の途中でログインしても加入画面へ戻る、加入直後に使えるようになったもの。完了パネル・道・はちゃんには Pro を出さない
- 計測: `funnel_events`（端末のランダムな番号と段階だけ）と管理画面の「Pro までの動線」（docs/SQL_FUNNEL.md、**SQL は創業者側**）

### 2 台で使う（Batch 48）
- ログインすると、取り込みが済むまで送らない（空の端末の値でクラウドを上書きしない）。端末の持ち主を覚え、別のアカウントの記録があれば置き換えるかをたずねる。XP は 2 台の増分を足す。現在地（コース・セクション）をクラウドから採る。今日のぶんと成長ログは user_items の day 行で合わせる（docs/SQL_USER_ITEMS.md の 1b. が要る）

### 運営
- **CRM** `/admin.html`（創業者専用。`ADMIN_EMAILS` で権限）: 全プレイヤーのセグメント（活動中／離れかけ／離脱／登録のみ）・活動・覚えた語・プラン、詳細、メモ／タグ／ピン、CSV。docs/CRM.md
- ご意見フォーム（全ページのフッター。保存先 `feedback` は SQL 未実行）、お知らせ `/news.html`（直近 6 件＋月ごとの畳み）。静的ページのヘッダーもアプリと同じ右端（連続日数＋ログイン／設定）
- Supabase の自動停止対策: 日次 `/api/cron/keepalive`。停止中はログイン画面に「つながりません」と案内し、学習は続けられる

## 3. 技術

- フロント: 素の HTML／CSS／ES modules、ビルド無し。ページ: index／list／stats／profile／battle／news／privacy／terms／tokushoho／pro／admin ＋ packs/（生成）
- デザイン: `css/tokens.css` が唯一の色・角丸・フォントの基準。テーマは 白／黒（＋Pro の 紙／藍）。影・グラデーション・絵文字は UI に使わない。英語と数字は等幅（IBM Plex Mono）
- サーバー: Vercel Node 関数 `api/explain-word`・`api/generate-cards`（Claude、`ANTHROPIC_API_KEY` 未設定なら「準備中」）、`api/admin/*`、`api/billing/*`、`api/cron/keepalive`。秘密鍵はすべて Vercel の環境変数（docs/SECURITY.md）
- Supabase: Auth（メールリンク・Google）、テーブル profiles／word_progress／user_progress／battle_sessions／play_sessions／daily_scores／activity_days（RLS）。任意: user_items／feedback／crm_notes／subscriptions（docs/SQL_*.md、**実行は創業者**）
- 環境変数（Vercel）: `ANTHROPIC_API_KEY`、`SUPABASE_SERVICE_ROLE_KEY`、`ADMIN_EMAILS`／`ADMIN_USER_IDS`、`STRIPE_SECRET_KEY`／`STRIPE_PRICE_MONTHLY`／`STRIPE_PRICE_YEARLY`／`STRIPE_TRIAL_DAYS`／`STRIPE_WEBHOOK_SECRET`、`SITE_ORIGIN`、`CRON_SECRET`、AI の回数 `CARD_GEN_DAILY_LIMIT(_PRO)`／`EXPLAIN_WORD_DAILY_LIMIT(_PRO)`
- 性能: 初回表示 約 1 MB・88 リクエスト（JSON 440 KB・JS 370 KB・CSS 130 KB）、読み込むのは有効なパックだけ。別解索引の構築 27 ms

## 4. 品質・流れ

- E2E `npm test`（playwright-core、Supabase はスタブ、約 6 分）: **658 件**。検証 `node scripts/validate-words.mjs`。CI は PR と main で検証を実行
- 本番反映: dev ブランチ → PR → main → Vercel（2 プロジェクトとも success を確認）。条件は E2E 全件＋validate OK。Supabase の SQL・外部への告知は創業者側
- アクセシビリティ: キーボードだけで主線を一周できる（Tab の移動、モーダルの焦点管理、スキップリンク、aria-live、ラベル）。コントラストは AA（ink-3 5.1:1）
- スマホ: 指の端末では入力欄 16px（自動ズームなし）、押せるものは 40〜44px。UI の見直しは 6 回（主線 78 件・主線以外 70 件・Battle／管理画面／旧 CSS 49 件・初回 10 分 30 件・2〜8 日目 24 件・2〜4 週目 34 件）を監査 → 反映 → 査読で通した。game.css の旧パレットは 0
- 大きな変更の進め方: 監査（撮影・計測）→ 指摘を事実と直し方で列挙 → 所有ファイルを分けた並行実装 → 反証レビュー → E2E → PR。データの別解・訳は「提案 → 別の目で反証」の 2 段

## 5. 守っていること（創業者の規則）

- 学習の核は無料。Pay to Win 禁止。通貨／ガチャ／ショップ／通知は作らない。新しいゲームモードを増やさない。Battle のロジックを変えない
- はちゃんは 3 場面（ホーム・完了・週間）。台詞は 1 文・「！」は多くて 1 つ・盛り上げ語なし・数字と矛盾しない・依存や罪悪感を作らない
- 文言は短く断定。UI は日本語、英語は打つ対象だけ。数字を誇張しない
- 秘密鍵をクライアント・ログ・リポジトリに置かない。PII をログに書かない。CRM からプレイヤーには何も届かない

## 6. 数字

- 教材 171 カテゴリ・15,464 枚、別解 8,908 語、コース 10、E2E 658、マージ済み PR 121
- **ユーザー系の数字はまだ無い**（10 人ローンチ前。CRM・activity_days・funnel_events は受け皿として用意済み）

## 7. 次の候補（docs/BACKLOG.md）

- 創業者の判断待ち: **Pro の次の中身と価格（docs/PRO_VALUE.md §6。推奨は受験日から逆算した計画・¥580 で開始）**、無料期間、見出し語 18 件、カタカナ訳 225 語の方針、AI の無料回数（docs/FOUNDER_TODO.md F）
- 創業者側の作業で止まっているもの: Supabase の復旧、Pro の受付（Stripe・特商法の記入）、SQL（SQL_BILLING・SQL_USER_ITEMS・SQL_FUNNEL・SQL_FEEDBACK）
- コード側の候補: 加入までの体験の点検（Batch 51）、UI の残り（docs/BACKLOG.md F13・F15 の残り）、word_progress の列追加（2 台目の履歴・「知ってた」）、1 年の推移、PACK_REVIEW の要確認 id、ランディング（SPEC_ACQUISITION）
