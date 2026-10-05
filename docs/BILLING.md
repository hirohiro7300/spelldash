# SpellDash Pro（月額サブスクリプション）

> 2026-10-02、創業者の「もう月額の設定進めていいよ」で、これまでの「決済禁止」を解除して実装した（Batch 34）。
> 設計の土台は docs/MONETIZATION.md と docs/PRO_VALUE.md §3。SQL は docs/SQL_BILLING.md。
> 実装は `api/_lib/billing.js`、`api/billing/*.js`（サーバー）、`js/plan.js`、`js/proView.js`、`pro.html`、`css/pro.css`（クライアント）。
> Stripe ダッシュボードの操作・Vercel の環境変数・SQL の実行は創業者側（手順は第 2 節）。

## 1. 何であり、何でないか

できること

- 月額（必須）と年額（Stripe に Price があれば出す）の Pro プラン。金額はコードに書かず、Stripe の Price から取って `/pro.html` に表示する
- 加入は Web（`/pro.html`）からログインして Stripe Checkout へ。解約・カード変更・領収書は Stripe の Billing Portal（プロフィール →「お支払いの管理」）
- Pro の特典（第 4 節）: マイ単語帳 1,000 語、AI の回数、90 日の推移、シールド 3 枚と連続記録の修復、テーマ「紙」「藍」
- CRM（docs/CRM.md）にプラン列（`plan` / `planStatus` / `planPeriodEnd` / `planInterval`、要約の `pro`）

しないこと（創業者の規則）

- 学習の核（Study / Challenge / Daily / Battle / 今日のセット / 復習 / 基本の統計）は無料のまま。Pay to Win 禁止（覚えやすくなる・判定有利・ランキング有利は売らない）。継続率を人質にしない（ストリーク・シールドの基本・ランキング参加は無料）
- 通貨・ガチャ・ショップ・通知は作らない。Battle には触れない。はちゃんは 3 場面以外に出さない
- Pro バッジのランキング表示、はちゃんの差分、「広告なし」、月間レポート PDF は入れない（広告は元から無い）
- アプリ（Capacitor）では購入ボタンと価格を出さない（第 5 節）
- 秘密鍵はサーバーの環境変数だけ。クライアント・応答・ログに出さない。ログにメールなどの PII を出さない。npm 依存は増やさない（Stripe は `fetch` + Node `crypto`）

## 2. 有効にする手順（創業者側）

受付開始までは `/pro.html` に「Pro はまだ受付前です。」と出て、加入はできない（`GET /api/billing/config` が `configured:false`）。

1. **Stripe アカウント**を作る（https://dashboard.stripe.com）。本人確認と銀行口座は本番キーに切り替える前までに済ませる。
2. **商品と Price**: Products → Add product → 名前「SpellDash Pro」。Price は **定期（Recurring）・JPY・税込**で、
   - 月額（必須）: 例 ¥580 / month
   - 年額（任意）: 例 ¥4,800 / year
   それぞれの Price ID（`price_...`）を控える。テストモードと本番モードで ID は別。
3. **Vercel → Project → Settings → Environment Variables**（Production。Preview にも入れるならテストモードのキー）:

   | 変数 | 値 | 必須 |
   |---|---|---|
   | `STRIPE_SECRET_KEY` | Stripe の Secret key（Developers → API keys。テストモードと本番モードで別の値。`sk_` に続く test／live でモードが分かる） | 必須 |
   | `STRIPE_PRICE_MONTHLY` | 月額の Price ID | 必須 |
   | `STRIPE_PRICE_YEARLY` | 年額の Price ID | 任意（無ければ年額ボタンを出さない） |
   | `STRIPE_WEBHOOK_SECRET` | 4 で作る Webhook の Signing secret（`whsec` で始まる） | webhook に必須 |
   | `STRIPE_TRIAL_DAYS` | 無料トライアルの日数 | 任意（既定 0） |
   | `SITE_ORIGIN` | `https://www.spelldash.net` | 任意（既定がこの値。success / cancel / return の URL はこれだけから作る） |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase の service_role key（CRM と共用） | webhook の書き込みに必須 |

   「設定済み」= `STRIPE_SECRET_KEY` と `STRIPE_PRICE_MONTHLY` が両方ある。
4. **Webhook**: Developers → Webhooks → Add endpoint。
   - Endpoint URL: `https://www.spelldash.net/api/billing/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
   - 作ったら Signing secret（`whsec` で始まる）を控え、3 の `STRIPE_WEBHOOK_SECRET` に入れる
5. **Redeploy**（環境変数は次のデプロイから効く）。
6. **docs/SQL_BILLING.md** の SQL を Supabase の SQL Editor で実行する（`subscriptions` テーブル）。
   これが無いと、加入はできても webhook が 500 を返し、Pro にならない。
7. **tokushoho.html の［ ］を埋める**（販売事業者・運営責任者・所在地・連絡先）。公開ページなので、受付開始の前に。
   個人の場合、所在地と電話番号は「請求があれば遅滞なく開示します」でもよい。
8. **テストモードで一巡**（Stripe のキーがテストモードのうちに）:
   1. `/pro.html` を開く。価格が 2 つ（または月額だけ）出る
   2. ログインして「月額 ¥… で始める」→ Stripe Checkout
   3. カード番号 `4242 4242 4242 4242`、有効期限は未来の任意、CVC は任意の 3 桁、名前・住所は任意
   4. 支払うと `/profile.html?pro=done` に戻り、「お支払いを確認しています…」→「Pro になりました。ありがとうございます。」
      プラン行が「Pro（次回の更新 YYYY/M/D）」になる。Stripe → Developers → Webhooks → 該当エンドポイントで 4 イベントが 200
   5. 「お支払いの管理」→ Billing Portal が開く。そこで「プランをキャンセル」→ プロフィールが「Pro（解約予定・YYYY/M/D まで）」
   6. 失敗のカード `4000 0000 0000 0002`（拒否）、`4000 0000 0000 3220`（3D セキュア）も試す
   7. マイ単語帳 101 語目・学習データの 90 日・テーマ「紙」が使える
9. **本番キーに差し替え**: `STRIPE_SECRET_KEY` を本番モードの Secret key、Price ID を本番モードのもの、Webhook も本番モードで作り直して `STRIPE_WEBHOOK_SECRET` を差し替える → Redeploy。
   Billing Portal の設定（Settings → Billing → Customer portal）で「サブスクリプションのキャンセル」と「支払い方法の更新」を許可しておく（テストモードと本番モードで別々）。
10. **告知**: news.html に第 10 節の下書きを貼る。

## 3. entitlement（Pro かどうか）の定義

サーバー（`api/_lib/billing.js` の `isProRow`）とクライアント（`js/plan.js` の `isProRow`）が同じ式を持つ（モジュールは共有しない）:

```
isProRow(row, now) =
  row があり
  かつ row.status ∈ { active, trialing, past_due }
  かつ（row.current_period_end が無い、または current_period_end + 3 日 > now）
```

- **3 日の猶予**: 更新日に支払いが失敗しても、Stripe の再試行（Smart Retries）が走る数日は Pro を切らない。期限 + 3 日を過ぎたら、status が何であれ free
- **past_due も Pro**: 支払い失敗の直後に特典を止めると、カードの期限切れだけで記録の修復やテーマが突然消える。猶予の 3 日で回収する
- `canceled` / `unpaid` / `incomplete` / `incomplete_expired` / `none` は free。解約予定（`cancel_at_period_end: true`）は status が `active` のままなので、期間末まで Pro
- クライアントは本人の行を `localStorage` の `spelldash_plan` にキャッシュし、`isPro()` は同期的にそれを見る（ネットワークに行かない）。更新のタイミングはログイン直後・各ページの表示時（`refreshPlan()`）・`?pro=done` のとき（`waitForPro()`、2 秒 × 6 回）。ログアウトで消す
- 最終判断はサーバー: AI の回数（`api/_lib/shared.js` の `reject()`）は本人のトークンで `subscriptions` を読んで決める（ユーザーごと 5 分キャッシュ）。クライアントの判定は表示とローカルのゲート（単語帳の上限・推移・テーマ・修復）だけ

## 4. 特典とゲートの一覧

| 特典 | 無料 | Pro | どこで変わるか |
|---|---|---|---|
| マイ単語帳の語数 | 100 語まで | 1,000 語まで | `js/myWords.js` `maxMyWords()`。超えている人も閲覧・削除はできる（追加だけ止まる）。上限の文に「Pro について」のリンク（`js/myWordsView.js`） |
| AI（テキストからカード） | 1 日 2 回（`CARD_GEN_DAILY_LIMIT`） | 1 日 20 回（`CARD_GEN_DAILY_LIMIT_PRO`） | サーバー `api/generate-cards.js` → `reject()`。429 `daily_limit` の `upgrade:true` で `#cardGenStatus` に「Pro について」 |
| AI（覚え方の解説） | 1 日 3 回（`EXPLAIN_WORD_DAILY_LIMIT`） | 1 日 60 回（`EXPLAIN_WORD_DAILY_LIMIT_PRO`） | サーバー `api/explain-word.js` → `reject()`。`js/wordAi.js` が `.ai-upgrade` のリンクを添える |
| 覚えた単語の推移 | 30 日 | 90 日 | `stats.html` の `[data-trend-range]`。free が 90 を押すと `.trend-range__hint`。選択は `spelldash_trend_range`（growthLog は 120 日ぶん保持済み） |
| シールドの上限 | 2 枚 | 3 枚 | `js/level.js` `shieldMax()` |
| 連続記録の修復 | なし | 月 1 回、途切れてから 7 日以内 | `js/level.js` `getLostStreak()` / `canRepairStreak()` / `repairStreak()`。`stats.html` の `#streakRepair`（`repairedMonth` を `spelldash_streak` に保存。sync.js はクラウド採用時に `lost` / `repairedMonth` も写す） |
| テーマ | 白・黒 | 白・黒・紙（paper）・藍（indigo） | `js/theme.js`。free の保存値が紙・藍なら白・黒に落として保存し直す。プロフィールの `#themeHint`。head のスニペットは Pro 判定をしない（失効直後は 1 瞬だけ旧テーマ、theme.js が直す） |

AI の上限の 429 メッセージ: 無料「今日の無料ぶん（N回）は使い切った。Pro なら1日M回」/ Pro「今日の上限（M回）に達した。また明日」。表示側（`js/wordAi.js`）は無料の文の末尾に「（Pro について）」のリンクを括弧で続ける。

## 5. アプリ版（Capacitor）の扱い

- `isNativeApp` のときは `/pro.html` の価格と購入ボタン（`#proPlans`）を出さず、「Pro の加入と管理は Web 版（www.spelldash.net）で。」と状態だけ出す。プロフィールのプラン行もボタン無し（値だけ）
- 理由: App Store Review Guideline 3.1.1。アプリ内でデジタルコンテンツの購入へ誘導すると、アプリ内課金（StoreKit）が必要になり、Stripe への誘導は審査で落ちる。価格やリンクを出さない「リーダー型」なら、Web で加入した状態をアプリで使うのは可
- Web で加入すると、同じアカウントでログインしたアプリでも Pro になる（`subscriptions` は user_id に紐づく。`refreshPlan()` は Supabase の本番 URL を使う）
- 将来 StoreKit / Google Play Billing を入れるなら、`subscriptions` に `source`（stripe / apple / google）列を足し、`isProRow` はそのまま使える。いまは判断しない（docs/APP.md）
- 審査の説明文に「購入はアプリ外。アプリ内に価格・購入導線は無い」と書く（docs/APP.md §5 と合わせる）

## 6. 解約・返金・問い合わせの運用

- **解約は本人が Billing Portal で**（プロフィール →「お支払いの管理」）。期間末で止まり（`cancel_at_period_end`）、それまで Pro。日割りの返金はしない（tokushoho.html・privacy.html・/pro.html の FAQ に明記）。解約の取り消しも Portal から
- **返金**は Stripe ダッシュボード → Payments → 該当の支払い → Refund で手動。返金しても subscription は止まらないので、必要なら Subscriptions → Cancel も行う（webhook が `deleted` → `canceled` を書く）
- **領収書**は Stripe が支払いのたびにメールで送る（Settings → Emails で「成功した支払いのメール」を ON にしておく）。Portal からも過去の請求書を見られる
- **問い合わせ**: 「加入したのに Pro にならない」は第 8 節。「カードを変えたい」は Portal。「アカウントを消したい」はこれまでどおり（Supabase の `auth.users` を消すと `subscriptions` も `on delete cascade`。Stripe 側の顧客は残るので、必要なら Customers から削除）
- **価格を変えるとき**: Stripe で新しい Price を作って `STRIPE_PRICE_MONTHLY` を差し替える（既存の加入者は旧 Price のまま続く＝実質値上げなし）。コードの変更は不要
- Pro を手で付けたいとき（お礼・検証）: Stripe で 100% のクーポンを作り Checkout の「プロモーションコード」欄で使ってもらう（`allow_promotion_codes=true`）。DB を直接書くのは最後の手段（docs/SQL_BILLING.md §3）

## 7. プライバシーとセキュリティ

- 鍵の置き場: `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `SUPABASE_SERVICE_ROLE_KEY` は Vercel の環境変数だけ。クライアントに渡さず、応答にも含めず、ログにも書かない。リポジトリには Stripe の鍵（`sk_` や `whsec` で始まる文字列）を置かない（受け入れ基準の grep）
- カード番号は Stripe Checkout（Stripe のドメイン）で入力され、SpellDash のサーバーには来ない（PCI DSS の SAQ A 相当）。SpellDash が持つのは `status` / 更新日 / `stripe_customer_id` / `stripe_subscription_id` / `price_id` だけ（privacy.html「お支払い情報」）
- Webhook の署名検証: `Stripe-Signature: t=...,v1=...` を分解し、`HMAC-SHA256(secret, "${t}.${rawBody}")` の hex を `v1` のどれかと `crypto.timingSafeEqual`（長さ違いは不一致）。`|now - t| > 300 秒` は拒否。生ボディを使うため `bodyParser: false`
- 逆順到着: `subscriptions.event_created` に最後に反映した event の `created` を持ち、それ以下のイベントは書かない（`updated` の後に古い `created` が届いても巻き戻らない）
- RLS: `subscriptions` は本人が自分の行を **読むだけ**。insert / update / delete は `anon` / `authenticated` から revoke。書くのは webhook（service role）だけ。checkout / portal / AI の回数判定は本人のトークン + anon key で読む（RLS で本人だけ）
- 冪等性: Checkout の作成に `Idempotency-Key: checkout:<userId>:<interval>:<分>` を付け、二重押しで 2 つのセッションを作らない。すでに Pro の人は 409 `already_subscribed`
- ログは `billing/<label>: <種別> <状態>` だけ。メール・顧客 id・リクエスト本文は書かない。CRM にも Stripe の id は出さない
- 応答は常に `Cache-Control: no-store`。sw.js は `/api/` を保存しない
- `SITE_ORIGIN` の既定は本番。success / cancel / return の URL をリクエストヘッダから作らない（Host ヘッダ偽装でのオープンリダイレクトを避ける）

## 8. トラブルシューティング

| 画面の表示・症状 | API / ログ | 原因 | 直し方 |
|---|---|---|---|
| /pro.html に「Pro はまだ受付前です。」 | `GET /api/billing/config` が `configured:false` / checkout が 503 `not_configured` | `STRIPE_SECRET_KEY` か `STRIPE_PRICE_MONTHLY` が無い | 第 2 節の 3 を入れて Redeploy |
| 価格が出ず「手続きを始められませんでした」 | config が 502 `upstream`、ログ `billing/config: upstream` | Price ID が違う（テスト／本番の取り違え）、キーが違う | Stripe の Price ID と鍵のモードをそろえる |
| 年額ボタンが出ない | config の `prices` に year が無い | `STRIPE_PRICE_YEARLY` が無い、または取れなかった | 任意。出すなら Price を作って変数に入れる |
| 支払ったのに Free のまま（`?pro=done` で「反映まで少しお待ちください」） | Stripe → Webhooks に配信が無い、または 400 / 500 | webhook 未設定／URL 違い／`STRIPE_WEBHOOK_SECRET` 違い（400 `bad_signature`）／`subscriptions` 未作成（500、ログ `subscriptions table missing`） | 第 2 節の 4〜6。Stripe は失敗した配信を再送する（3 日間）。直したら Webhooks → 該当イベント → Resend。プロフィールを開き直すと反映 |
| Webhook のログが 400 `bad_signature` | `billing/webhook: bad_signature` | Signing secret の取り違え（テスト／本番、別エンドポイント）、またはプロキシで本文が変わった | 該当エンドポイントの Signing secret を入れ直して Redeploy。時刻ずれなら 300 秒以内か確かめる |
| Webhook のログが 500 | `billing/webhook <type>: upstream subscriptions <status> <code>`（Supabase に書けない）/ `billing/webhook: <type> subscriptions table missing`（テーブル無し）/ `billing/webhook <type>: upstream stripe …`（checkout.session.completed で subscription を取り直せない） | Supabase に書けない（テーブル無し、service role key 違い） | docs/SQL_BILLING.md を実行、`SUPABASE_SERVICE_ROLE_KEY` を確かめる。再送で入る |
| Webhook のログに `no user for customer` | 200 で無視 | `metadata.user_id` が無く、`stripe_customer_id` でも行が見つからない（Stripe ダッシュボードで手で作った subscription など） | Checkout 経由で加入し直すか、docs/SQL_BILLING.md §3 の手順で行を作る |
| 「すでに Pro です。」 | checkout 409 `already_subscribed` | 本人の行が isProRow | 正常。プロフィールの「お支払いの管理」へ |
| 「お支払いの記録が見つかりません」 | portal 404 `no_subscription` | `stripe_customer_id` が無い（加入直後で webhook 未着、または一度も加入していない） | 数分待って開き直す。それでも無ければ webhook（上の行） |
| 解約したのに Pro のまま | | 期間末まで Pro（解約予定）。期限 + 3 日の猶予 | 仕様。`#planValue` が「解約予定・YYYY/M/D まで」なら正常 |
| 支払い失敗の人が Pro のまま／急に Free になった | status `past_due` | 期限 + 3 日は猶予（第 3 節）。過ぎると free | Portal でカードを更新してもらう。Stripe の Smart Retries が成功すれば `active` に戻る |
| テーマが白／黒に戻った | | 失効したので紙・藍を落とした（`getTheme()`） | 仕様。再加入で選び直せる |
| ログインし直したら Pro の表示が消えた | | `spelldash_plan` のキャッシュをログアウトで消す。ログイン直後の `refreshPlan()` が終わる前 | 1〜2 秒待つ。続くなら `subscriptions` の RLS（本人 select）を docs/SQL_BILLING.md (a)(b) で確かめる |
| CRM の `missing` に `subscriptions` | `GET /api/admin/players` | テーブル未作成 | docs/SQL_BILLING.md。無くても CRM は動く（全員 free 表示） |

Stripe のダッシュボードで見る場所: Payments（支払い・返金）、Subscriptions（状態・解約予定）、Customers（メールで検索。SpellDash の `user_id` は subscription の metadata）、Developers → Webhooks（配信ログ。応答本文も見える）、Developers → Logs（API 呼び出し。Idempotency の重複も分かる）。

## 9. API 契約（開発者向け）

すべて JSON、`Cache-Control: no-store`、エラーは `{ error, message }`（message は日本語の短文）。

| エンドポイント | 認証 | 応答 |
|---|---|---|
| `GET /api/billing/config` | 不要 | `{ configured: boolean, prices: [{ interval: "month"\|"year", amount: number, currency: "jpy" }], trialDays: number }`。未設定なら `{ configured:false, prices:[], trialDays:0 }`（200）。Price は 10 分メモリキャッシュ。`amount` は `unit_amount` そのまま（JPY はゼロ小数） |
| `POST /api/billing/checkout` `{ interval }` | Bearer 必須 | `{ url }`（Stripe Checkout）。503 `not_configured` / 401 `login_required` / 400 `bad_request`（interval が month / year 以外、または year 未設定）/ 409 `already_subscribed` / 502 `upstream` |
| `POST /api/billing/portal` | Bearer 必須 | `{ url }`（Billing Portal、return は `/profile.html`）。404 `no_subscription` / 503 / 401 / 502 |
| `POST /api/billing/webhook` | `Stripe-Signature` | `{ received: true }`（200）。400 `bad_signature`（署名不正・300 秒超）/ 503（未設定）/ 500（Supabase 書き込み失敗 → Stripe が再送） |

Checkout セッションの中身: `mode=subscription`、`line_items[0][price]`、`client_reference_id=<userId>`、既存の `stripe_customer_id` があれば `customer=`、無ければ `customer_email=`、`metadata[user_id]` と `subscription_data[metadata][user_id]`、`success_url=${SITE_ORIGIN}/profile.html?pro=done`、`cancel_url=${SITE_ORIGIN}/pro.html?pro=cancel`、`locale=ja`、`allow_promotion_codes=true`、`STRIPE_TRIAL_DAYS>0` なら `subscription_data[trial_period_days]`。

Webhook が扱うイベント: `checkout.session.completed`（`mode=subscription` のみ。`subscription` id で `GET /v1/subscriptions/{id}` を取り直して upsert）、`customer.subscription.created` / `updated` / `deleted`（`deleted` は `status=canceled`）。他は 200 で無視。upsert は `POST /rest/v1/subscriptions?on_conflict=user_id`、`Prefer: resolution=merge-duplicates`。

AI の回数（`api/_lib/shared.js` `reject(req, res, { scope, limit, proLimit })`）: 超えたら 429 `{ error: "daily_limit", upgrade: !isPro, message }`。

クライアント（`js/plan.js`）: `getPlan()` → `{ pro, status, interval, periodEnd, cancelAtPeriodEnd, checkedAt }`（`localStorage.spelldash_plan`）、`isPro(now)`、`refreshPlan()`（`document` に `spelldash:plan` イベント）、`waitForPro({ tries, interval })`、`clearPlan()`、`postBilling(path, payload)`。

E2E（`npm test` の「pro:」、84 件）: ローカルサーバーが `/api/billing/*` を偽装（config は常に configured。checkout は Bearer 無し 401・`pro-token` 409・他は `/profile.html?pro=done` へ。portal は `pro-token` だけ 200）。スタブの `from("subscriptions")` は `localStorage.spelldash_test_plan` を本人の行として返す。Webhook・署名・逆順・form の中身はネットワーク無しの `scratchpad/billing-test.mjs`（fetch 差し替え）で確かめる。

## 10. 告知文の下書き（news.html 用。受付開始時に創業者が貼る）

> **SpellDash Pro の受付を始めました**
>
> 思い出して打つ・今日のセット・復習・記録は、これからも無料のままです。
> Pro は、自分の単語をもっと入れたい人、長く続けている人のための追加機能です。
>
> - マイ単語帳: 100 語 → 1,000 語
> - AI（テキストからカード・覚え方の解説）: 1 日に使える回数が増えます
> - 覚えた単語の推移: 30 日 → 90 日
> - 連続記録: シールドが最大 3 枚。途切れても月 1 回、7 日以内なら前の連続日数を取り戻せます
> - テーマ: 「紙」と「藍」
>
> 月額 ¥580（年額 ¥4,800）。いつでも解約でき、期間の終わりまで使えます。
> 覚えやすさや判定が有利になるものは売りません。ランキングも無料のままです。
> 詳しくは [SpellDash Pro](./pro.html) へ。アプリ版の方は Web 版（www.spelldash.net）で加入すると、同じアカウントで使えます。

金額は Stripe で決めた額に直してから貼る。news.html の既存の書式（`<article>`、日付）に合わせる。

## 11. 価格の仮説

- docs/MONETIZATION.md 由来: **¥580/月・¥4,800/年（月あたり ¥400）**。中高生が小遣いで払える上限を意識して低め。年払いで解約率を下げる
- 比較: Duolingo Super 約 ¥1,100、mikan Premium 約 ¥600〜1,000、abceed 約 ¥1,400（2026-07 時点）。docs/PRO_VALUE.md の「月額 1,000 円払ってもやりたい」は価値設計の目標で、価格の決定ではない
- 決めるのは創業者。コードに金額は無いので、Stripe の Price を作り直して環境変数を差し替えるだけで変えられる（既存の加入者は旧 Price のまま）
- 最初の 10 人・20 人のうちは、価格より「何に払うか」の反応を見る（docs/PRO_VALUE.md §5）。無料トライアル（`STRIPE_TRIAL_DAYS`）は、必要になってから
