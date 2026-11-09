# SpellDash セキュリティ監査レポート（2026-07-15）

ローンチ前監査。対象: フロントエンド全コード・Supabaseスキーマ/RLS・Service Worker・共有機能。

## ✅ 問題なし（確認済み）

| 項目 | 結果 |
|---|---|
| 秘密情報の混入 | なし。リポジトリ内のキーはanon（公開前提）のみ。service_roleキーなし |
| 危険シンク（eval / new Function / document.write / javascript:） | 使用なし |
| XSS | （2026-11-09・Batch 88 で書き直し）語・訳・名前・id の字は、HTML に入れるとき必ず `esc`（js/html.js。`'` も実体にする）か `escapeHtml` を通す。渡すリンク・同期・バックアップで届いた語は信用しない入力で、学習状況・一覧・語の詳細・回の板まで届く。scripts/test-text-safe.mjs の 7（HTML を組むテンプレートの見張り）が漏れを見張る。ハッシュだけの script-src（下の Batch 88 の節）は、入った on* の属性・インラインの script・`javascript:` を止めるが、**認証の部品の配信元（esm.sh）が script-src に残る間は 2 つ目の守りにならない**: 入った HTML の `<iframe srcdoc>` の中の `<script src>` はその配信元から読め（その配信元はだれでも出せる公開の部品を配る）、srcdoc の文書は同じオリジンなので、このページの保存（ログインのセッションを含む）に届く（frame-src でも止まらない）。だから今は esc が唯一の守りで、配信元を外すのは 1 人目の前（docs/FOUNDER_TODO.md の決めてほしいことの 16）。ランキングの display_name も `escapeHtml` |
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
CSP の script-src は、自分のファイル・配るページのインラインの script のハッシュ（中身が 1 字でも違えば動かない）・認証の部品の配信元だけ（2026-11-09・Batch 88 で 'unsafe-inline' を外した。下の Batch 88 の節）

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
| 冪等性・二重課金 | （2026-11-09・Batch 88 で書き直し）手続きはいつも本人の顧客 1 人で作る（行の顧客 → metadata の `user_id` で検索 → 冪等キー `customer:<userId>` で作る）。作成の冪等キーは `checkout:<userId>:<interval>:<trial|paid>:<分>`。本人の行が Pro か、本人の顧客に生きている契約があれば 409。新しい手続きを作ると同じ顧客の開いている手続きを期限切れにし、期限も 35 分。webhook は別の契約の終わりで生きている行を書かない。加入と管理の画面は 1 人 1 分 10 回まで。管理の画面は `stripe_customer_id` が無ければ 404 |
| リダイレクト先 | success／cancel／return の URL は `SITE_ORIGIN`（既定 本番）だけから作り、リクエストの Host／Origin ヘッダは使わない |
| PII | ログは `billing/<label>: <種別> <状態>` だけ。メール・顧客 id・本文は書かない。CRM にも Stripe の id は出さない。応答は `Cache-Control: no-store`、sw.js は `/api/` を保存しない |
| CSP | 外部へのリダイレクトは `location.href`（Stripe のドメイン）。スクリプト・接続先の許可は増やしていない（Stripe.js は使わない） |
| 受容リスク | クライアントの `isPro()` は localStorage のキャッシュで、改ざんすれば単語帳の上限・テーマ・修復は端末内で外せる（学習に不公平は生まれない。AI の回数はサーバーで判定） |

## 2026-11-09 追記: Batch 88（守り。本物の支払いの前）

本物の支払いを受ける前に、外から来る字（渡すリンク・同期・バックアップ）・CSP・決済・AI の回数・管理画面・小さな口を調べ直した。どの直しも、直す前の木で落ちる検査を先に書いて落ちるのを見てから入れた（docs/CHANGELOG.md 2026-11-09）。こちらでは SQL を流しておらず、本物の決済・認証・データベース・AI も呼んでいない（手元の偽物だけ）。

### 直したこと

| 項目 | 見つけたこと | 直したこと | 検査 |
|---|---|---|---|
| 渡すリンクの字（重い） | 渡すリンクで受け取った語の訳が、学習状況の 2 つの一覧（初めて見て正解した語・思い出せるようになった語）に esc なしで入り、開いた人の画面で script が走った（CSP の違反は 0 だった） | 学習状況の一覧とメモの札を esc。ほかの HTML の組み立て（16 ファイル）も、語・訳・名前・id を `esc`／`escapeHtml` に通す。`esc` は `'` も `&#39;` にする。どこからも読まれていない js/wordList.js を消した | E2E 88.1 (1)(2)(4)・scripts/test-text-safe.mjs の 7（js/*.js の HTML のテンプレートで、語・訳・名前・id の字が esc を通らずに出る所。d8f9d69 で 51 → 0。許す 3 件は Battle の分野の定数と回の名前の定数で、理由は検査に書いた） |
| CSP | script-src の `'unsafe-inline'` で、上の穴から入った on* の属性や script がそのまま走った | `'unsafe-inline'` を外し、配るページのインラインの script（14 種類）のハッシュだけを許す（締めるだけ。ほかの指示は変えていない）。ただし認証の部品の配信元が script-src に残るので、入った HTML の `<iframe srcdoc>` からその配信元の script を読む形は止まらない（下の「残したこと」） | scripts/test-site-map.mjs の 8（配る HTML のインラインの script のハッシュが全部 vercel.json にあり、余りが無い）・E2E 88.1 (3)(3b)（本物のヘッダーで各ページの違反 0。入れた on* と後から足した script は走らない） |
| 二重の契約 | 開いたままの手続き 2 つを両方払うと、メールだけで顧客が 2 人でき、契約が 2 つになった。片方の終わりで、生きている方の行が canceled に上書きされた（払い続けているのに無料） | 手続きはいつも本人の顧客 1 人で作る。生きている契約があれば 409。新しい手続きで同じ顧客の開いている手続きを期限切れにし、期限も 35 分。webhook は別の契約の終わりで生きている行を書かない（docs/BILLING.md §7） | scripts/test-billing.mjs の 6b |
| AI の回数（今は鍵が無いので眠っている） | 1 日の回数が関数のインスタンスごとのメモリーだけで、10 のインスタンスで無料の 2 回が 20 回になった。メール未確認・匿名のログインでも使えた。入力を確かめる前に数えた | メールを確認した匿名でない人だけ（ほかは 401）。入力を先に確かめる（400 は数えない）。回数はデータベースの関数 `ai_take` で全部のインスタンスで 1 つに数える（関数が無い・失敗・3 秒で答えないときは前のとおりメモリー。docs/SQL_AI_USAGE.md）。同じ人の同時の呼び出しは 429。前の日の数をメモリーから捨てる。カードを作る口は `CARD_GEN_ENABLED=1` のときだけ（今は入口が無いので 503） | scripts/test-api-guard.mjs（4 つの子のインスタンスで合計が上限を越えない など）・test-billing の 8 |
| 管理画面の門 | `ADMIN_USER_IDS` があってもメールでも通った。未ログインの人にも「設定されていない」を返した | `ADMIN_USER_IDS` があれば id だけで決める。順はログイン（401）→ 設定（503）→ 管理者（403） | test-api-guard の 8 |
| 動線の数 | 集計の関数が無いと 30 日分の行を全部読んだ（多いと関数の時間とメモリーを使い切る） | 5 万行（50 ページ）で止め、管理画面に「数は途中まで」と出す | test-api-guard の 9 |
| cron の鍵 | 文字列の `===` で比べた | 長さをそろえた `timingSafeEqual` | test-api-guard の 10 |
| 加入・管理の画面の回数 | 何度でも呼べた（決済の会社への呼び出しが増える） | 1 人 1 分 10 回（インスタンスのメモリー。11 回目は 429 `too_many`） | test-billing の 7c |
| ご意見のページ名 | ログインなしで書ける表に、URL の全部（長さの上限なし）を書いた | 300 字で切る（データベースの側の上限は docs/SQL_FEEDBACK.md §4） | E2E 88.1 (5) |

### 確かめて変わらなかったこと

- 配るページ（HTML 181 個）に、インラインの on* の属性・`javascript:` の URL・eval・new Function・script の要素を作る所は 0。
- 旧いタブの証明（tests/oldtab）は、ハッシュだけの CSP でも今までどおり出る（ふつうの形は PASS・変異 mirror-session は LEAK）。検査の道具が CSP で目隠しされていない。
- ログに鍵・トークン・メールを書かない（test-api-guard の 11）。足した行に鍵の形の文字列は無い。AI の回数の関数は、トークンの本人の数だけを増やす（ほかの人の数は増やせない）。
- Preview の止め口（js/previewHost.js）・Battle・キーボード・学ぶ回の打つ道・カードの id・同期の 15 列は変えていない。値段・無料期間・Pro の中身と門・100／1,000 語も同じ。

### 残したこと（こちらでは直していない）

- 創業者の作業は docs/FOUNDER_TODO.md の「守り」1〜14（払えなかった後の設定・異議・アカウントを消す順・本番への切り替えの確かめ・AI の鍵の入れ方・Preview の守り・SQL 4 本〔AI の回数・user_items の大きさと数・ご意見の長さ・動線の集計〕・認証の設定・`CRON_SECRET`・`ADMIN_USER_IDS`・量の見張り）。SQL は流さなくてもアプリは壊れない（コードは SQL に頼っていない）。
- 創業者の決めは同じ docs の「決めてほしいこと」10〜17（端末の Pro の印・払えなかった人を Pro とする長さ・無料期間の取り直し・異議の自動化・AI のインスタンスごとの合計・アプリの控え・認証の部品の配信元・無料 100 語をデータベースでも守るか）。
- 端末の Pro の印（上の「受容リスク」）は今のまま。書き換えると端末の特典は開く（決めてほしいことの 10）。
- 認証の部品は外の配信元（esm.sh）から読む（script-src と connect-src に残る。決めてほしいことの 16）。この配信元はだれでも出せる公開の部品を配るので、esc の漏れが 1 か所でもあると、入った HTML の `<iframe srcdoc>` の中の `<script src>` がその配信元の任意の部品を読み、同じオリジンの保存（ログインのセッション）に届く（反証で同じ形の CSP を手元のブラウザで確かめた。`frame-src 'none'` を足しても止まらない）。**1 人目の前に**、固定の版の部品を自分の配信から出してこの配信元を外す（こちらの次の守りの回。Preview は部品を読まないので、配信の答えのハッシュを確かめてから本番に出す）。それまでは HTML を組む所は必ず esc を通し、scripts/test-text-safe.mjs の 7 で見張る。
- アプリの包み（dist）のページに CSP の meta を入れる直し（計画の A8）は今回入れていない。アプリはまだ出しておらず、ログインも購入の画面も無い。アプリを出す回で入れる（frame-ancestors は meta で効かないので外し、connect-src に本番の API の origin を足す）。
- word_progress・play_sessions・battle_sessions の 1 人の行の数の上限は次の守りの回で（それまでは守り 14 の量の見張りで見る）。

### CSP のハッシュの直し方（インラインの script を 1 字でも変えたとき）

1. `node scripts/lib/csp.mjs` を流す。1 行目が、配る HTML のインラインの script のハッシュを全部入れた script-src の値（その下はハッシュごとのファイルの数）。
2. vercel.json の Content-Security-Policy の script-src をその値に置き換える（ほかの指示は変えない）。
3. `node scripts/test-site-map.mjs`（8 がハッシュと HTML の一致を見る）と E2E 88.1 (3) を流す。

ハッシュの合わないインラインの script は本番で黙って動かない。検査が落ちるので、そのまま出ることは無い。
