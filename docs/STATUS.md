# SpellDash 現状スナップショット（2026-10-13）

> 2026-07-17 版は docs/archive/STATUS_2026-07-17.md に移した（当時の設計論点と、9 月までの追記の履歴はそちら）。
> 変更の履歴は docs/CHANGELOG.md、次にやることは docs/BACKLOG.md、**創業者側の作業と判断は docs/FOUNDER_TODO.md**。

## 1. ひとことで

**SpellDash**（https://www.spelldash.net）— 日本語の訳を見て英単語を記憶から打つ「思い出して打つ」学習サービス。Local-First（学習記録は端末が正、ログインでクラウド同期）。デザインは「魔法使いの書斎 — 星図と羊皮紙」（ホームは部屋と机の本と本棚、打つ画面は「墨と朱」のまま。docs/CONCEPT.md）。
対象は社会人の英語学び直し層を中心に、中高生・受験生も。公式キャラクター はちゃん はとんがり帽子の見習いで、出るのは 3 場面だけ（docs/CHARACTER.md）。

## 2. いま入っているもの

### 学習
- **4 モード（増やさない）**: Study（セット・Recall Loop・SRS。長さは 10／15／25 語か 60 秒）／Challenge（60 秒）／Daily Dash（全員同じ問題・ランキング）／Battle（CPU ランクマッチ。ロジックは凍結、色・面・文字列だけ触る）
- **タイピング練習**（`/typing.html`、2026-10 創業者指示で足した集客の入口のページ。**学習のモードではない・学習記録を変えない**）: 見本を見て 1 分打つ。英単語（訳つき）／日本語（小・中学校の用語の読みをローマ字で）。3 つ目の種類「長文」（2026-10-12、Batch 62）は書き下ろしの文章 20 編（日本語 12・英語 8。英語は 1 行ごとに訳つき）から 1 本選んで最後の行まで打つ（句読点・英語の記号も打つ・Esc やスマホの「やめる」でそこまでの結果・裏に回ると止める）。結果は打/分・正確さ・間違えたキー・自己ベスト（端末。1 分の結果の高さは札の箱が始めから取るので、時間切れで結果が出ても下が動かない。720 以上は 2 列。スマホで画面キーボードが出ている始まる前は、箱の空き〔札のすぐ下〕にタイピングゲームへの 1 行を出す。長文の始まる前は札の 1 行目の select の右に「ゲーム」）、長文はスコア（打/分×正確さの 2 乗）と時間、本体へ「思い出して打つ」。**種類への深いリンクと記憶**（Batch 65）: `?kind=en`／`ja`／`long`（`#long` も）→ この端末に覚えた種類（タブを押したときだけ書く）→ 英単語。head の 1 行が最初の描画の前に html に印を付け、CSS がタブ・札・文を出し分ける（英単語を描いてから替えない）。タブを押すと URL を `?kind=` に合わせる（replaceState）。`#long` は読み込みのときに `?kind=long` に替える。canonical は 1 つ。入口は全ページのフッターの先頭・お知らせ・sitemap・学習データの本文の最後の 1 行「息抜きに タイピング練習」。計測は first_visit の source に typing*（長文は typing_long*、最初の 1 ページが深いリンクなら typing_link、学習データの 1 行は typing_stats）（docs/SPEC_TYPING.md）
- **タイピングゲーム**（`/typing-game.html`、2026-10 創業者指示。学習のモードではない・学習記録を変えない）: 日本語の文を読みとローマ字の手本つきで 90 秒打つ。3 コース（短い語句・ふつうの文・長い文）・文ごとの持ち時間（尽きると「流れた」）・取れた文・目標・自己ベスト（端末、コース×秒数）。教材は創作の 654 文（`scripts/typing-game/*.jsonl` → `data/typing-game.json`）。**コースへの深いリンクと記憶**（Batch 65）: `?course=short`／`normal`／`long` → この端末に覚えたコース → ふつうの文（練習と同じ形で、読む・覚える・URL を合わせる処理は js/typingKeys.js の共通の関数。3 コースの最初の文を HTML に直書きして CSS が 1 つだけ見せ、`--check` が `FIRST_SENTENCES` と突き合わせる）。高さ 330px 以下の横向きは長い文のかなを 17px にして 2 行を盤面の上に収める。入口は typing.html の札の下の 1 行（スマホの始まる前は箱の中・長文は 1 行目）・お知らせ・sitemap。計測は first_visit の source に tgame*（最初の 1 ページが深いリンクなら tgame_link）・typing_game（docs/SPEC_TYPING_GAME.md）
- **書斎（ホーム）**: 机の上の本 = コース（10 本: 中学やり直し・ビジネス・会話・高校・英検・NGSL・TSL・BSL・NAWL・TOEIC）→ 巻 → 章。左頁に書名と進み、右頁に今の章と全幅のスタート（390 で 1 画面目）、3 枚目に目次（済みは畳む）。前回の続きから再開。**わたしの本棚**（自分で足した本と函。机の本は空き）から背を押すと机の本が替わる、函でコース。「本を足す」の窓で 171 冊の目録（検索・棚ごとの見出し 9 つ）。整理で下ろす（記録は消えない）。棚は端末ごと（Batch 61）。初回は同じ部屋で 英単語 のスタート（腕試し）＋ 社会・理科・国語・仕事 の 4 冊を積み、「171冊から選ぶ」で目録から選べる（最初の描画から初回の本。index.html のインラインが js/welcome.js と同じ判定で出す。Batch 66）。出題の設定の「分野を追加」は単語帳の分野パックへ（チップ・机の本・棚の 3 つがそろう。Batch 66 で今のままと決めた）
- **判定**: 1 ミス＝不正解（Clean Correct）。出題語を打ち切ったらその場で正解（gym に対して gymnasium のような長い候補が残っていても止めない）、Enter は打った語で確定、続けて打った長い候補の続きは次の語に入れない。ローマ字の短い漢字の別解に読みが無い約 400 枚は判断待ち（FOUNDER_TODO F-10）（Study は続きを打つ間は次の語を待たせる〔1 打の続き＝語末の ん の 2 つ目の n は待ちを変えない〕。次の語が出た後は、1 打を続きの見方と次の語の両方に食わせてどちらかが拒んだ時点で解決する記録 1 つ。両方が受ける引き分けは次の語に見せたまま次の打鍵で決め、次の語として完成したら次の語の正解〔続きもまだ続く out → do は保留し、次の打鍵が続きなら続き、来なければ 1.5 秒で次の語の正解〕。K0-1 と PR #149 レビューの対応、2026-10-10。docs/SPEC_CLEAN_CORRECT.md §8・docs/KEYBOARD.md）。**別解**: 同じ訳の別の英単語を打つと「talk も「話す」。この問題の語は speak」と案内して不正解にしない。パック内で訳のトークンを共有する語は自動で別解、加えて `accept` を人手で確認済み（英単語パック 81 本・4,914 枚・8,908 語）。つづり違い（favourite／favorite）はそのまま正解
- **教材**: 171 カテゴリ・15,464 枚（分野パック 162、`/packs/<id>.html` に入口ページ）。オープン教材は NGSL 24・TSL 11・BSL 15・NAWL 8 = 58 パック・6,814 語（CC BY-SA 4.0、出典表記あり）。英単語カードには例文（ex／exJa）。形式は docs/PACK_FORMAT.md、検証は `node scripts/validate-words.mjs`
- **習熟度**（単語ごとの 5 段: まだ／あやふや／思い出せる／身についた／即答。Batch 63 段階 1・2、docs/SPEC_MASTERY.md）: 正誤 → 前の答えからの日数 → 速さ（出題から最初のキーまでを本人の中央値と比べる。即答と初めての答えの身についただけに使う）で決める。上がるのはその日の最初の答えだけで 1 日 1 段、下がるのはその日の最初の × で 1 段。単語帳（スマホの既定の簡潔表示は 1 行目の題箋の左に目盛りだけ・名前は読み上げと title〔目盛りは語のボタンの覆いの上で、押すと詳細〕、「詳しく」は足元に目盛り＋名前）・語の詳細（その語の事実と次の段の条件。題箋と食い違って見える組〔苦手＋身についた など〕には「題箋と習熟度は別の物差し」の 1 文。呼び名の表は SPEC_MASTERY 付録 E）・学習データ・CSV・完了パネル・Challenge／Daily の結果に出す。記録は word_stats の端末だけの欄（段・段を決めた時刻・段を下げた時刻・別解で答えを見た印）と `spelldash_mastery_meta`（schema 6 のまま・SQL なし・送る行は 15 列のまま）。2 台目でも確認待ちの知ってた語は同期する欄から読む。期日前の身についた以上の語と確認待ちの知ってた語は補充・ミッション・息抜きに出さない（S6）。段階 2 で SRS の間隔とつないだ（S1〜S5: 正解で期日を早めない・日をあけて思い出せた語は間隔を伸ばす・下限は身についた 7 日／即答 30 日。予定どおり続ける人の間隔 1→2→3→5→7→10→14→21→30 は今と同じ。apple のような知ってた語は 106 日までに 5 回）
- **マイ単語帳**（1 語ずつ／まとめて／場面カード／AI でテキストから）、単語の詳細（履歴・メモ・覚え方を作る）、覚えた単語帳、学習データ（今週・記録・分析）、週間レポート、学習カレンダー
- **音声**: 端末でいちばん自然な英語の声を自動選択、声の試聴、速さ、音で出題（0／25／50%）、効果音（短く小さく。BGM は無し）
- **チュートリアル**: 初回の 1 セットに 1 文ずつ（3 ステップ: 答えを見た→数問後にもう一度／自力で思い出せた→次は日をあけて／道→毎日スタートだけ〔今日のセットの長さに合わせて約3／5／8分か60秒〕。画面下の札、既存ユーザーには出ない。docs/SPEC_TUTORIAL.md）
- **専用の画面キーボード**（スマホ。A〜Z＋⌫＋Enter、英文カードだけ空白）。Capacitor で iOS／Android の器もある（docs/APP.md。ストア未提出。dist は 10 ページで、フッターの利用規約もアプリの中で開ける。加入画面と特商法は Web だけのページで、アプリではリンクを出さない）

### 継続
- 連続日数＋シールド（5 日ごとに 1 枚、最大 2 枚。Pro は 3 枚＋月 1 回の修復）、XP・レベル・称号（小さく 1 行）、今日のセット（10／15／25 語〔道の右頁は約3分／約5分／約8分〕・60 秒。60 秒は時間で区切る回で、自力で思い出せた語が 1 語以上なら今日のぶん。終わりに答えた語を段ごとに並べる。時間切れの瞬間に盤面の外の書ける欄〔ログインの欄など〕・開いている窓・メモの欄で作業中なら焦点を奪わない〔押したあとのボタンや盤面の空いた所に焦点があるときは今どおり見出しへ〕。窓〔ご意見・語の詳細・本を足す〕が開いている間は、窓の中の読み上げの行で終わりの見出しの文を読む〔Batch 65・PR #166 のレビュー〕）、正解のあと（すぐ次へ／少し見せる／長く見せる）、週の学習日の目標

### 有料プラン SpellDash Pro（2026-10-02 解禁、**受付はまだ**: docs/FOUNDER_TODO.md B）
- Stripe Checkout／Billing Portal／Webhook（`api/billing/*`、SDK 無し）。価格はコードに無く Stripe の Price から表示。アプリでは購入導線を出さない（加入画面と特商法は dist に入れず、リンクも出さない）
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

- フロント: 素の HTML／CSS／ES modules、ビルド無し。ページ: index／list／stats／profile／battle／news／privacy／terms／tokushoho／pro／admin／typing／typing-game ＋ packs/（生成）
- デザイン: `css/tokens.css` が唯一の色・角丸・フォントの基準（昼 light／紙 paper・夜 dark／藍 indigo。同じ名前で値だけ変える）。部屋は `css/room.css`・`css/bookshelf.css`、場面の絵は `scripts/room-art/` から `assets/images/room/` に焼いた WebP。フォントは自前（`css/fonts.css`: Shippori Mincho 500／700・Cormorant Garamond 600・IBM Plex Mono。外部リクエスト 0）。og-image（1200×630、全ページ共通）は型 `scripts/og-image.html` を `node scripts/build-og-image.mjs` で撮る（名前と 1 行の説明と札の見本。数字・絵文字なし。URL に版 `?v=2`: SNS は絵を URL で覚えるので、絵を変えたら全ページと E2E の版を 1 つ上げる）。打つ対象の英語と数字は等幅、部屋の中は明朝。絵文字は UI に使わない
- サーバー: Vercel Node 関数 `api/explain-word`・`api/generate-cards`（Claude、`ANTHROPIC_API_KEY` 未設定なら「準備中」）、`api/admin/*`、`api/billing/*`、`api/cron/keepalive`。秘密鍵はすべて Vercel の環境変数（docs/SECURITY.md）
- Supabase: Auth（メールリンク・Google）、テーブル profiles／word_progress／user_progress／battle_sessions／play_sessions／daily_scores／activity_days（RLS）。任意: user_items／feedback／crm_notes／subscriptions（docs/SQL_*.md、**実行は創業者**）
- 環境変数（Vercel）: `ANTHROPIC_API_KEY`、`SUPABASE_SERVICE_ROLE_KEY`、`ADMIN_EMAILS`／`ADMIN_USER_IDS`、`STRIPE_SECRET_KEY`／`STRIPE_PRICE_MONTHLY`／`STRIPE_PRICE_YEARLY`／`STRIPE_TRIAL_DAYS`／`STRIPE_WEBHOOK_SECRET`、`SITE_ORIGIN`、`CRON_SECRET`、AI の回数 `CARD_GEN_DAILY_LIMIT(_PRO)`／`EXPLAIN_WORD_DAILY_LIMIT(_PRO)`
- 性能（ホーム 390・非圧縮）: 初回表示 約 2.2 MB・161 リクエスト（フォント 479 KB・JS 577 KB・CSS 420 KB・JSON 441 KB・画像 87 KB）、読み込むのは有効なパックと画面に出た文字のフォントだけ。DOMContentLoaded 0.4 秒・LCP 0.4 秒（手元）、1 リクエスト 80ms の遅延で 1.7 秒・2.0 秒。予算: フォント ≤ 520 KB・場面の画像 ≤ 260 KB（E2E が守る）。CLS は戻ってきた人の 390 で 0（遅延 80ms。E2E が < 0.05 を守る）、初回の書斎は 1200×900・1200×1100・390 で < 0.02（遅延 80ms。E2E が守る。Batch 66）。別解索引の構築 27 ms

## 4. 品質・流れ

- E2E `npm test`（playwright-core、Supabase はスタブ、手元で 1 本約 20 分）: **1,960 件**。CI は 4 組に分けて並列のジョブで流す（`node scripts/e2e-shard.mjs --shard k/4`。節の重さ＝CI で測った秒で釣り合わせ、毎回同じ分け方。表は 2026-10-13 に main の CI〔run 38417468654〕の 4 組のログで 61 節すべてを写し直し、Batch 66 で足した検査の秒の見積もりを足して、4 組の重さは 656／656／657／657 秒〔前の表のままだと、いちばん重い組が 839 秒〕・各ジョブの上限 20 分。1 本では CI で約 29 分かかり、上限 45 分で時間を稼いでいた。2026-10-11）。手元で 1 組だけ流すのは `npm run test:shard -- 2/4`、分け方の表は `node scripts/e2e-shard.mjs --plan 4`。節を足しても組は自動で分かれる（表に無い節は行数から見積もる）。偏ってきたら CI の組のログの最後の「節ごとの秒」を scripts/e2e-shard.mjs の SECONDS に写す。検証 `node scripts/validate-words.mjs`、単体: 習熟度の規則 `node scripts/test-mastery.mjs`（365 件）・保持率 `node scripts/test-retention.mjs`（93 件）・ローマ字 `node scripts/test-romaji.mjs`（406 件）・本棚の規則 `node scripts/test-shelf.mjs`（144 件）。import を足した・data/manifest.json の基本カテゴリを変えたら `node scripts/modulepreload.mjs`（各ページの先読みを生成。ずれると E2E と CI が落ちる）。パックの語・訳・読みを直したら `node scripts/build-typing.mjs`（タイピング練習の教材 data/typing.json を作り直す。ずれると E2E と CI が落ちる）。タイピング練習の長文の文章（`scripts/typing-long/*.jsonl`）を直したら `node scripts/build-typing-long.mjs`（data/typing-long.json）。**タイピングゲームの教材やパックを直したときも `node scripts/build-typing-long.mjs --check`（ゲームの文との重複）と `--report`（許す漢字 kanji.txt と今のパック・ゲームの字の差）を流す**。CI は PR と main で検証を実行
- 本番反映: dev ブランチ → PR → main → Vercel（2 プロジェクトとも success を確認）。条件は E2E 全件＋validate OK。Supabase の SQL・外部への告知は創業者側
- アクセシビリティ: キーボードだけで主線を一周できる（Tab の移動、モーダルの焦点管理、スキップリンク、aria-live〔窓が開いている間は窓の中の読み上げの行 `[data-sr-live]` に書く。`dialog:modal` も背後を inert にする窓も 1 つの判定で見る。タイピングの 2 ページも同じ判定〔js/srLive.js。Batch 66〕〕、ラベル、本棚は 1 つの roving tabindex）。コントラストは AA（ink-3 6.6:1、スタートの文字 4.77:1 以上）。reduced motion で動き 0。320／390 で横スクロール無し
- スマホ: 指の端末では入力欄 16px（自動ズームなし）、押せるものは 40〜44px。ヘッダーは 720px 以下で詰めた 1 行（印だけ・13px のナビ・数字だけの連続日数。Batch 66）で、320〜1400 のどの幅・どの状態（ログイン・Pro・アプリ）でもナビの字が折れず、帯の高さは書斎 56・ほか 57px。UI の見直しは 6 回（主線 78 件・主線以外 70 件・Battle／管理画面／旧 CSS 49 件・初回 10 分 30 件・2〜8 日目 24 件・2〜4 週目 34 件）を監査 → 反映 → 査読で通した。game.css の旧パレットは 0
- 大きな変更の進め方: 監査（撮影・計測）→ 指摘を事実と直し方で列挙 → 所有ファイルを分けた並行実装 → 反証レビュー → E2E → PR。データの別解・訳は「提案 → 別の目で反証」の 2 段

## 5. 守っていること（創業者の規則）

- 学習の核は無料。Pay to Win 禁止。通貨／ガチャ／ショップ／通知は作らない。新しいゲームモードを増やさない（入口のタイピング練習（長文を含む）・タイピングゲームは例外: 2026-10 創業者指示。モードではなく別ページ）。Battle のロジックを変えない
- はちゃんは 3 場面（ホーム・完了・週間）。台詞は 1 文・「！」は多くて 1 つ・盛り上げ語なし・数字と矛盾しない・依存や罪悪感を作らない。部屋に Pro の文言を出さない
- 文言は短く断定。UI は日本語、英語は打つ対象だけ。数字を誇張しない
- 秘密鍵をクライアント・ログ・リポジトリに置かない。PII をログに書かない。CRM からプレイヤーには何も届かない

## 6. 数字

- 教材 171 カテゴリ・15,464 枚、別解 8,908 語、コース 10、目録の棚 9、タイピング練習の教材 英 942・日 663 語、長文 20 編（日本語・短め 8・長め 4、英語・短め 5・長め 3。275 行・11,495 打）、タイピングゲームの教材 654 文（短い語句 225・ふつうの文 277・長い文 152）、E2E 1,960、マージ済み PR 168
- **ユーザー系の数字はまだ無い**（10 人ローンチ前。CRM・activity_days・funnel_events は受け皿として用意済み）

## 7. 次の候補（docs/BACKLOG.md）

- 決定（2026-10-07）: **Pro は月額 ¥980、初めての方は 1 か月無料（随時）、年額なし**。創業者側の設定: Stripe の ¥980 の Price・`STRIPE_PRICE_MONTHLY`・`STRIPE_TRIAL_MONTHS=1`（docs/FOUNDER_TODO.md B）
- 創業者の判断待ち: Pro の次の中身（docs/PRO_VALUE.md §6）、見出し語 18 件、カタカナ訳 225 語の方針、AI の無料回数（docs/FOUNDER_TODO.md F）
- 創業者側の作業で止まっているもの: Supabase の復旧、Pro の受付（Stripe・特商法の記入）、SQL（SQL_BILLING・SQL_USER_ITEMS・SQL_FUNNEL・SQL_FEEDBACK）
- コード側の候補: 書斎の続き（Batch 56b: 部屋以外のページの皮・夜の味付け・批評の nice-to-have・アプリの dist 再生成）、word_progress の列追加（2 台目の履歴・「知ってた」）、1 年の推移、PACK_REVIEW の要確認 id、ランディング（SPEC_ACQUISITION）
