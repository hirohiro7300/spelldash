# SpellDash 現状スナップショット（2026-10-08）

> 2026-07-17 版は docs/archive/STATUS_2026-07-17.md に移した（当時の設計論点と、9 月までの追記の履歴はそちら）。
> 変更の履歴は docs/CHANGELOG.md、次にやることは docs/BACKLOG.md、**創業者側の作業と判断は docs/FOUNDER_TODO.md**。

## 1. ひとことで

**SpellDash**（https://www.spelldash.net）— 日本語の訳を見て英単語を記憶から打つ「思い出して打つ」学習サービス。Local-First（学習記録は端末が正、ログインでクラウド同期）。デザインは「魔法使いの書斎 — 星図と羊皮紙」（ホームは部屋と机の本と本棚、打つ画面は「墨と朱」のまま。docs/CONCEPT.md）。
対象は社会人の英語学び直し層を中心に、中高生・受験生も。公式キャラクター はちゃん はとんがり帽子の見習いで、出るのは 3 場面だけ（docs/CHARACTER.md）。

## 2. いま入っているもの

### 学習
- **4 モード（増やさない）**: Study（セット・Recall Loop・SRS）／Challenge（60 秒）／Daily Dash（全員同じ問題・ランキング）／Battle（CPU ランクマッチ。ロジックは凍結、色・面・文字列だけ触る）
- **書斎（ホーム）**: 机の上の本 = コース（10 本: 中学やり直し・ビジネス・会話・高校・英検・NGSL・TSL・BSL・NAWL・TOEIC）→ 巻 → 章。左頁に書名と進み、右頁に今の章と全幅のスタート（390 で 1 画面目）、3 枚目に目次（済みは畳む）。前回の続きから再開。**本棚**（171 冊を 9 段）から背を押すと机の本が替わる、函でコース、本をさがす（別名つき）。初回は同じ部屋で 英単語 のスタート（腕試し）＋ 社会・理科・国語・仕事 の 4 冊を積む
- **判定**: 1 ミス＝不正解（Clean Correct）。**別解**: 同じ訳の別の英単語を打つと「talk も「話す」。この問題の語は speak」と案内して不正解にしない。パック内で訳のトークンを共有する語は自動で別解、加えて `accept` を人手で確認済み（英単語パック 81 本・4,914 枚・8,908 語）。つづり違い（favourite／favorite）はそのまま正解
- **教材**: 171 カテゴリ・15,464 枚（分野パック 162、`/packs/<id>.html` に入口ページ）。オープン教材は NGSL 24・TSL 11・BSL 15・NAWL 8 = 58 パック・6,814 語（CC BY-SA 4.0、出典表記あり）。英単語カードには例文（ex／exJa）。形式は docs/PACK_FORMAT.md、検証は `node scripts/validate-words.mjs`
- **マイ単語帳**（1 語ずつ／まとめて／場面カード／AI でテキストから）、単語の詳細（履歴・メモ・覚え方を作る）、覚えた単語帳、学習データ（今週・記録・分析）、週間レポート、学習カレンダー
- **音声**: 端末でいちばん自然な英語の声を自動選択、声の試聴、速さ、音で出題（0／25／50%）、効果音（短く小さく。BGM は無し）
- **チュートリアル**: 初回の 1 セットに 1 文ずつ（3 ステップ: 答えを見た→数問後にもう一度／自力で思い出せた→次は日をあけて／道→毎日スタートだけ。画面下の札、既存ユーザーには出ない。docs/SPEC_TUTORIAL.md）
- **専用の画面キーボード**（スマホ。A〜Z＋⌫＋Enter、英文カードだけ空白）。Capacitor で iOS／Android の器もある（docs/APP.md。ストア未提出）

### 継続
- 連続日数＋シールド（5 日ごとに 1 枚、最大 2 枚。Pro は 3 枚＋月 1 回の修復）、XP・レベル・称号（小さく 1 行）、今日のセット（10／15／25 語）、正解のあと（すぐ次へ／少し見せる／長く見せる）、週の学習日の目標

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
- デザイン: `css/tokens.css` が唯一の色・角丸・フォントの基準（昼 light／紙 paper・夜 dark／藍 indigo。同じ名前で値だけ変える）。部屋は `css/room.css`・`css/bookshelf.css`、場面の絵は `scripts/room-art/` から `assets/images/room/` に焼いた WebP。フォントは自前（`css/fonts.css`: Shippori Mincho 500／700・Cormorant Garamond 600・IBM Plex Mono。外部リクエスト 0）。打つ対象の英語と数字は等幅、部屋の中は明朝。絵文字は UI に使わない
- サーバー: Vercel Node 関数 `api/explain-word`・`api/generate-cards`（Claude、`ANTHROPIC_API_KEY` 未設定なら「準備中」）、`api/admin/*`、`api/billing/*`、`api/cron/keepalive`。秘密鍵はすべて Vercel の環境変数（docs/SECURITY.md）
- Supabase: Auth（メールリンク・Google）、テーブル profiles／word_progress／user_progress／battle_sessions／play_sessions／daily_scores／activity_days（RLS）。任意: user_items／feedback／crm_notes／subscriptions（docs/SQL_*.md、**実行は創業者**）
- 環境変数（Vercel）: `ANTHROPIC_API_KEY`、`SUPABASE_SERVICE_ROLE_KEY`、`ADMIN_EMAILS`／`ADMIN_USER_IDS`、`STRIPE_SECRET_KEY`／`STRIPE_PRICE_MONTHLY`／`STRIPE_PRICE_YEARLY`／`STRIPE_TRIAL_DAYS`／`STRIPE_WEBHOOK_SECRET`、`SITE_ORIGIN`、`CRON_SECRET`、AI の回数 `CARD_GEN_DAILY_LIMIT(_PRO)`／`EXPLAIN_WORD_DAILY_LIMIT(_PRO)`
- 性能（ホーム 390・非圧縮）: 初回表示 約 2.2 MB・161 リクエスト（フォント 479 KB・JS 577 KB・CSS 420 KB・JSON 441 KB・画像 87 KB）、読み込むのは有効なパックと画面に出た文字のフォントだけ。DOMContentLoaded 0.4 秒・LCP 0.4 秒（手元）、1 リクエスト 80ms の遅延で 1.7 秒・2.0 秒。予算: フォント ≤ 520 KB・場面の画像 ≤ 260 KB（E2E が守る）。CLS は戻ってきた人の 390 で 0（遅延 80ms。E2E が < 0.05 を守る）。別解索引の構築 27 ms

## 4. 品質・流れ

- E2E `npm test`（playwright-core、Supabase はスタブ、約 8 分）: **1,170 件**。検証 `node scripts/validate-words.mjs`。import を足した・data/manifest.json の基本カテゴリを変えたら `node scripts/modulepreload.mjs`（各ページの先読みを生成。ずれると E2E と CI が落ちる）。CI は PR と main で検証を実行
- 本番反映: dev ブランチ → PR → main → Vercel（2 プロジェクトとも success を確認）。条件は E2E 全件＋validate OK。Supabase の SQL・外部への告知は創業者側
- アクセシビリティ: キーボードだけで主線を一周できる（Tab の移動、モーダルの焦点管理、スキップリンク、aria-live、ラベル、本棚の段は roving tabindex）。コントラストは AA（ink-3 6.6:1、スタートの文字 4.77:1 以上）。reduced motion で動き 0。320／390 で横スクロール無し
- スマホ: 指の端末では入力欄 16px（自動ズームなし）、押せるものは 40〜44px。UI の見直しは 6 回（主線 78 件・主線以外 70 件・Battle／管理画面／旧 CSS 49 件・初回 10 分 30 件・2〜8 日目 24 件・2〜4 週目 34 件）を監査 → 反映 → 査読で通した。game.css の旧パレットは 0
- 大きな変更の進め方: 監査（撮影・計測）→ 指摘を事実と直し方で列挙 → 所有ファイルを分けた並行実装 → 反証レビュー → E2E → PR。データの別解・訳は「提案 → 別の目で反証」の 2 段

## 5. 守っていること（創業者の規則）

- 学習の核は無料。Pay to Win 禁止。通貨／ガチャ／ショップ／通知は作らない。新しいゲームモードを増やさない。Battle のロジックを変えない
- はちゃんは 3 場面（ホーム・完了・週間）。台詞は 1 文・「！」は多くて 1 つ・盛り上げ語なし・数字と矛盾しない・依存や罪悪感を作らない。部屋に Pro の文言を出さない
- 文言は短く断定。UI は日本語、英語は打つ対象だけ。数字を誇張しない
- 秘密鍵をクライアント・ログ・リポジトリに置かない。PII をログに書かない。CRM からプレイヤーには何も届かない

## 6. 数字

- 教材 171 カテゴリ・15,464 枚、別解 8,908 語、コース 10、本棚 9 段、E2E 1,170、マージ済み PR 143
- **ユーザー系の数字はまだ無い**（10 人ローンチ前。CRM・activity_days・funnel_events は受け皿として用意済み）

## 7. 次の候補（docs/BACKLOG.md）

- 決定（2026-10-07）: **Pro は月額 ¥980、初めての方は 1 か月無料（随時）、年額なし**。創業者側の設定: Stripe の ¥980 の Price・`STRIPE_PRICE_MONTHLY`・`STRIPE_TRIAL_MONTHS=1`（docs/FOUNDER_TODO.md B）
- 創業者の判断待ち: Pro の次の中身（docs/PRO_VALUE.md §6）、見出し語 18 件、カタカナ訳 225 語の方針、AI の無料回数（docs/FOUNDER_TODO.md F）
- 創業者側の作業で止まっているもの: Supabase の復旧、Pro の受付（Stripe・特商法の記入）、SQL（SQL_BILLING・SQL_USER_ITEMS・SQL_FUNNEL・SQL_FEEDBACK）
- コード側の候補: 書斎の続き（Batch 56b: 部屋以外のページの皮・夜の味付け・批評の nice-to-have・アプリの dist 再生成）、word_progress の列追加（2 台目の履歴・「知ってた」）、1 年の推移、PACK_REVIEW の要確認 id、ランディング（SPEC_ACQUISITION）
