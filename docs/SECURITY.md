# SpellDash セキュリティ監査レポート（2026-07-15）

ローンチ前監査。対象: フロントエンド全コード・Supabaseスキーマ/RLS・Service Worker・共有機能。

## ✅ 問題なし（確認済み）

| 項目 | 結果 |
|---|---|
| 秘密情報の混入 | なし。リポジトリ内のキーはanon（公開前提）のみ。service_roleキーなし |
| 危険シンク（eval / new Function / document.write / javascript:） | 使用なし |
| XSS | （2026-11-09・Batch 88 で書き直し・2026-11-18・Batch 97 で直した）語・訳・名前・id の字は、HTML に入れるとき必ず `esc`（js/html.js。`'` も実体にする）か `escapeHtml` を通す。渡すリンク・同期・バックアップで届いた語は信用しない入力で、学習状況・一覧・語の詳細・回の板まで届く。scripts/test-text-safe.mjs の 7（HTML を組むテンプレートの見張り）が漏れを見張る。ハッシュだけの script-src（下の Batch 88 の節）は、入った on* の属性・インラインの script・`javascript:` を止める。Batch 97 から script-src は自分のファイルとハッシュだけ（認証の部品も自分の配信から出す。下の Batch 97 の節）なので、入った HTML の `<iframe srcdoc>` の中の外の `<script src>` も走らない（E2E 97.1 (3)）。esc は 1 つ目の守りのまま（scripts/test-text-safe.mjs の 7 が漏れを見張る）。ランキングの display_name も `escapeHtml` |
| RLS | 全テーブルで有効。daily_scores の select-all 以外はすべて `auth.uid() = user_id` で本人限定 |
| Service Worker | same-origin GET のみ処理。クロスオリジン（Supabase・認証）には触れない。res.ok のみキャッシュ |
| target="_blank" | すべて rel="noopener" 付き |
| 外部通信先 | 認証とデータのプロジェクト（connect-src の 1 か所）のみ。認証の部品は自分の配信から出す（2026-11-18・Batch 97。下の Batch 97 の節） |
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
CSP の script-src は、自分のファイルと配るページのインラインの script のハッシュ（中身が 1 字でも違えば動かない）だけ（2026-11-09・Batch 88 で 'unsafe-inline' を外し、2026-11-18・Batch 97 で認証の部品の外の配信元を外した。下の Batch 88 と Batch 97 の節）

### 4.【低・受容】daily_scores が user_id (UUID) を公開
自分の行のハイライトに使用。RLSは auth.uid() 基準のため、UUIDを知っても他人のデータにはアクセス不可。受容

### 5.【低・記録】認証の部品の配信の単一障害点 → 対応済み
以前は js/supabase.js が外の配信元から静的 import していて、そこが落ちるとモジュールグラフ全体が失敗しアプリが起動しなかった。
**対応**: 動的 import と、読めないときのオフラインのスタブ（Local First で起動する）・版の固定（2.118.0）。2026-11-18・Batch 97 から部品は自分の配信の関数（api/auth-module.js）が出す。関数が答えないときも、使えないのはログイン・同期・ご意見の送信・動線の計測だけで、学習は端末の記録で動く（E2E 97.1 (2)）

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
| 冪等性・二重課金 | （2026-11-09・Batch 88 で書き直し）手続きはいつも本人の顧客 1 人で作る（行の顧客 → metadata の `user_id` で検索 → 冪等キー `customer:<userId>` で作る。作る要求の本文は人の id だけで、メールは作った後に書く）。作成の冪等キーは `checkout:<userId>:<interval>:<trial|paid>:<分>`。本人の行が Pro か、本人の顧客に生きている契約があれば 409。新しい手続きを作ると同じ顧客の開いている手続きを期限切れにし、期限も 35 分。webhook は別の契約の終わりで生きている行を書かない。加入と管理の画面は 1 人 1 分 10 回まで。管理の画面は `stripe_customer_id` が無ければ 404 |
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
| AI の回数（今は鍵が無いので眠っている） | 1 日の回数が関数のインスタンスごとのメモリーだけで、10 のインスタンスで無料の 2 回が 20 回になった。メール未確認・匿名のログインでも使えた。入力を確かめる前に数えた | メールを確認した匿名でない人だけ（ほかは 401）。入力を先に確かめる（400 は数えない）。回数はデータベースの関数 `ai_take` で全部のインスタンスで 1 つに数える（関数が無い・失敗・3 秒で答えないときは前のとおりメモリー。docs/SQL_AI_USAGE.md）。同じ人の同時の呼び出しは 429（処理中の印は 90 秒で古いとみなす。関数の時間切れで印が残っても、その人をずっと止めない）。前の日の数をメモリーから捨てる。カードを作る口は `CARD_GEN_ENABLED=1` のときだけ（今は入口が無いので 503） | scripts/test-api-guard.mjs（4 つの子のインスタンスで合計が上限を越えない など）・test-billing の 8 |
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
- ✅（2026-11-18・Batch 97 で直した）認証の部品を外の配信元から読んでいた（script-src と connect-src に残っていた。決めてほしいことの 16）。esc の漏れが 1 か所でもあると、入った HTML の `<iframe srcdoc>` の中の `<script src>` がその配信元の任意の部品を読み、同じオリジンの保存（ログインのセッション）に届く形だった（`frame-src 'none'` を足しても止まらない）。固定の版を自分の配信から出し、この配信元を CSP から外した（下の Batch 97 の節）。Preview は部品を読まないので、マージ（＝本番に出す）の前に創業者が確認用の配信で関数の答えを開いて見る（関数は sha512 と sha256 が固定の値と同じときだけ答えを出すので、`/*!` と `MIT License` の字が出れば確かめは済む。PR の本文）。本番に出たら www で 1 回ログインする（docs/FOUNDER_TODO.md の守り 15）
- アプリの包み（dist）のページに CSP の meta を入れる直し（計画の A8）は今回入れていない。アプリはまだ出しておらず、ログインも購入の画面も無い。アプリを出す回で入れる（frame-ancestors は meta で効かないので外し、connect-src に本番の API の origin を足す）。
- word_progress・play_sessions・battle_sessions の 1 人の行の数の上限は次の守りの回で（それまでは守り 14 の量の見張りで見る）。

### CSP のハッシュの直し方（インラインの script を 1 字でも変えたとき）

1. `node scripts/lib/csp.mjs` を流す。1 行目が、配る HTML のインラインの script のハッシュを全部入れた script-src の値（その下はハッシュごとのファイルの数）。
2. vercel.json の Content-Security-Policy の script-src をその値に置き換える（ほかの指示は変えない）。
3. `node scripts/test-site-map.mjs`（8 がハッシュと HTML の一致を見る）と E2E 88.1 (3) を流す。

ハッシュの合わないインラインの script は本番で黙って動かない。検査が落ちるので、そのまま出ることは無い。

## 2026-11-18 追記: Batch 97（認証の部品を自分の配信から）

Batch 88 で残した「認証の部品の外の配信元」を外した（docs/FOUNDER_TODO.md の決めてほしいことの 16）。直す前の木で落ちる検査を先に書いた（docs/CHANGELOG.md 2026-11-18）。こちらでは本番・配信の管理画面・本物の認証には触れていない（登録所の公開の tarball は CI と手元で取った）。

### 形

| 項目 | 決まり | 検査 |
|---|---|---|
| 出す口 | `GET` の `/api/auth-module?v=2.118.0&h=c1a6b90c` だけ（api/auth-module.js。ログイン不要・鍵なし）。v は版、h は答えの sha256 の頭 8 字（答えのバイトが変われば URL も変わる）。ほかの版・印・余った問い・問い無しは 404、GET のほかは 405（HEAD も: 中身の無い答えに 1 年の保存の頭を付けない）。どちらも保存させない | 単体 test-auth-module の B・C5 |
| 作り方 | 関数が登録所の決まった tarball の URL（https。転送されたら行き着いた先も https か見る）から固定の版を取る（5 秒で打ち切り・読みながら数えて 2 MB まで）→ 開く前に sha512 が固定の integrity と同じか → メモリの中で開く（ファイルに書かない）→ package.json の名前と版 → 束の形 → 束と export の行の sha256 → 頭に配布物の LICENSE の文（そのまま）→ 答えの sha256。どれかが違えば作らない。固定の値と作り方は api/_lib/authModule.js の 1 か所（tests/oldtab/lib/authLib.mjs も同じ物を読む） | 単体 A・C。CI の oldtab のジョブの `--live`（毎回本物の登録所から作って、固定の値と同じか・旧タブの証明の写しと束が 1 バイトも違わないか） |
| 答え | 200 は `text/javascript; charset=utf-8`・`nosniff`・`public, max-age=31536000, s-maxage=31536000, immutable`（版ごとに URL が変わる）・`Cross-Origin-Resource-Policy: same-origin`。作れないときは 503・`no-store`・`Retry-After: 10`。インスタンスのメモリーに 1 回作った物を持つ。同時の呼び出しは同じ 1 回を待つ。作れなかった後 10 秒は作り直さない（登録所が止まっている間、呼ぶたびに待たせない） | 単体 B |
| ログ | `auth-module: unavailable <理由の短い字>` だけ（URL・問いの字・中身を書かない） | 単体 B7 |
| 読む側 | js/supabase.js は同じオリジンの `/api/auth-module?v=2.118.0&h=c1a6b90c`（api/_lib/authModule.js の `AUTH_MODULE_URL` と同じ字。単体 C1）を動的 import で読む（Service Worker は `/api/` を保存しないので sw.js は変えていない）。確認用の Preview は今までどおり読まない | E2E 97.1 (1)・78.8・86.1 |
| テストの口 | `window.__SUPABASE_MODULE_URL` は、字（string）で、ページの無い所（単体の検査）か手元の名前（localhost・127.0.0.1・[::1]）のときだけ読む。www では読まない。入った HTML の要素で window の名前を上書きされても読まない（前は読んだ） | 単体 D・E2E 97.1 (4) |
| CSP | script-src は `'self'` とインラインの script のハッシュだけ。connect-src から外の配信元を外した（締めるだけ。ほかの指示は同じ） | scripts/test-site-map.mjs の 8（外の先・`https:`・`data:`・`blob:`・`*` などを足す変異で落ちる）・E2E 88.1 (3)・7.5 の P1・97.1 (3) |
| 答えないとき | ログイン・同期・ご意見の送信・動線の計測だけが使えない（ご意見は端末の列に残る）。学習と記録は端末で今までどおり。データは消えない | E2E 97.1 (2)・78.7 (14) |

### 版を上げるとき

1. `node scripts/test-auth-module.mjs --print <版>`（ネットワーク）が、登録所の版の情報の integrity と tarball の sha512 を合わせてから、4 つの値（版・integrity・body・served）と配る URL を出す。
2. api/_lib/authModule.js の `AUTH_MODULE_VERSION` と `AUTH_MODULE_PIN` をその値に、js/supabase.js の `OWN_MODULE_URL` を出た URL（`AUTH_MODULE_URL` と同じ字。h は served の頭 8 字）にする（単体 C1・C5 が見る）。
3. 旧タブの証明（tests/oldtab）・scripts/test-areas.mjs・scripts/test-auth-module.mjs（`--live` も）・E2E 78.7 と 97.1 を流す。CI の控えの鍵は api/_lib/authModule.js が変わると変わる。
4. 版を上げずに答えのバイトだけが変わるとき（束の作り方・注記を変える）も同じ: served が変わるので URL の h も変わる。答えは端末に 1 年保存させる（immutable）ので、同じ URL のまま答えを替えると、前に読んだ端末には届かない（C5 が URL と served の頭 8 字を合わせて見る）。

### 残したこと

- 答えの大きさ: 約 220 KB（縮めると約 56 KB）。配信が関数の答えを縮めて届けるかは、こちらから確かめられない。immutable なので端末ごとに 1 回。本番で見てから決める（docs/BACKLOG.md）。
- 冷えたインスタンスの初めの 1 回は登録所から取る（手元で 3 回測って 0.09〜0.13 秒）。登録所が止まっていて縁にも保存が無いときは 503 で、上の表の「答えないとき」と同じ（ログイン・同期・ご意見の送信・動線の計測が使えず、学習は端末で動く）。作れなかったインスタンスは 10 秒は作り直さず、その後の要求で作り直す（登録所が戻っていれば出る）。
- アプリの包み（dist）は部品を読まない（アプリの中に `/api/` は無い）。アプリはまだ出しておらず、ログインの入口も無い。アプリを出す回で読み方を決める（docs/BACKLOG.md）。
- 確かめは創業者のブラウザで: マージの前に確認用の配信で関数の答えを 1 回（PR の本文）、本番に出たら www で 1 回（docs/FOUNDER_TODO.md の守り 15）。
