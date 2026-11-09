# SpellDash Pro（月額サブスクリプション）

> 2026-10-02、創業者の「もう月額の設定進めていいよ」で、これまでの「決済禁止」を解除して実装した（Batch 34）。
> 設計の土台は docs/MONETIZATION.md と docs/PRO_VALUE.md §3（価格はどちらも 2026-10-07 の決定より前の案。決定は第 11 節）。SQL は docs/SQL_BILLING.md。
> 実装は `api/_lib/billing.js`、`api/_lib/aiLimits.js`、`api/billing/*.js`（サーバー）、`js/plan.js`、`js/proView.js`、`pro.html`、`css/pro.css`（クライアント）。サーバー側の単体の検査は `scripts/test-billing.mjs`（CI。偽の fetch で外へ出ない）。
> Stripe ダッシュボードの操作・Vercel の環境変数・SQL の実行は創業者側（手順は第 2 節。docs/FOUNDER_TODO.md B は同じ順の短い一覧）。

## 1. 何であり、何でないか

できること

- 月額の Pro プラン（2026-10-07 の決定: **月額 ¥980（税込）・初めての方は 1 か月無料・年額なし**）。金額はコードに書かず、Stripe の Price から取って `/pro.html` に表示する。年額の Price を変数に入れれば年額も出る作りは残っているが、使わない
- 加入は Web（`/pro.html`）からログインして Stripe Checkout へ。解約・カード変更・領収書は Stripe の Billing Portal（設定 →「解約・お支払いの管理」）
- 加入画面で売る特典（第 4 節）は、今の画面（英単語の学習に絞った形）で本当に使えるものだけ（Batch 83）: マイ単語帳 1,000 語・思い出せるようになった語の推移 90 日・テーマ「紙」「藍」・AI の覚え方の回数（AI が使えるときだけ）
- CRM（docs/CRM.md）にプラン列（`plan` / `planStatus` / `planPeriodEnd` / `planInterval`、要約の `pro`）

しないこと（創業者の規則）

- 学習の核（Study / Challenge / Daily / Battle / 今日のセット / 復習 / 基本の統計）は無料のまま。Pay to Win 禁止（覚えやすくなる・判定有利・ランキング有利は売らない）。継続率を人質にしない（ストリーク・シールドの基本・ランキング参加は無料）
- 通貨・ガチャ・ショップ・通知は作らない。Battle には触れない。はちゃんは docs/CHARACTER.md §3 の場所（3 場面＋学習中の知らせ）以外に出さない
- Pro バッジのランキング表示、はちゃんの差分、「広告なし」、月間レポート PDF は入れない（広告は元から無い）
- アプリ（Capacitor）では購入ボタンと価格を出さない（第 5 節）
- 秘密鍵はサーバーの環境変数だけ。クライアント・応答・ログに出さない。ログにメールなどの PII を出さない。npm 依存は増やさない（Stripe は `fetch` + `crypto`）

## 2. 1 人目に払ってもらう手順（創業者側。上から順に。docs/FOUNDER_TODO.md B と同じ番号。2026-11-09 に並べ直した: Batch 86）

受付を始めるまで `/pro.html` は「Pro はまだ受付前。」と出し、加入はできない（`GET /api/billing/config` が `configured:false`）。受付中かどうかは `STRIPE_SECRET_KEY` と `STRIPE_PRICE_MONTHLY` の 2 つだけで決まる。特商法の表記が埋まったかは見ないので、**表記を埋めてから鍵を入れる**（5 を 10 より前に）。各段の「見る → 次へ」は、どこを見て、何が出れば次へ進むか。

> 鍵や署名の鍵の値は、チャット・コミット・スクリーンショットに貼らない。Vercel の環境変数にだけ入れる。
> 法と税の話は一般的な情報で、法の助言ではない。条文の逐語はこちらでは確かめていない。迷ったら専門家に聞く。

1. **本番の版を確かめる**（配信の管理画面 → Deployments → Production のコミット）。main へのマージが自動で本番に出る設定かも見る（2026-11-04 から、main へのマージで本番に出る）。
   - もう Batch 78 以降の版が本番に出ていたら: 旧いコードの書き込みを断る門（docs/FOUNDER_TODO.md A・docs/SQL_CLIENT_GATE.md）は docs/FOUNDER_TODO.md の「決めてほしいこと」の 1。本番がまだ 0507672 なら、新しい版は門の手順と同じ作業の中で出す。
   - **本番が Batch 86 のマージ以降になるまで、8〜14（課金の表から本物のカードまで）をしない。単語帳のリンクも配らない**。本番に要る直しが 4 つあるため: webhook の生ボディの直し（Batch 83）・単語帳を渡す（Batch 84）・文字の守り（Batch 85）・この道のりの直し（Batch 86）。
   - 確かめ方は 2 つ: 配信の管理画面の Production のコミットが Batch 86 のマージか、それより後（主な見方）。または /news.html に「マイ単語帳の語を、回ごとに混ぜて出すようにした」のお知らせがある（Batch 86 で足したお知らせ。日付では比べない: 同じ 2026.11.09 のお知らせがほかにもある）。
   - 見る → 次へ: 上の確かめ方のどちらかが当たる → 2 へ
2. **データベースが動いているかを見る**。データベースの会社の管理画面で、プロジェクトの状態を見る。止まっていれば今すぐ復旧する（docs/FOUNDER_TODO.md A。リリースの日まで待たない）。止まっているとログインできず、加入も webhook の書き込みもできない。一般の注意として、止まったままの期間が長いと、管理画面から戻せなくなることがある。
   - 毎日の `/api/cron/keepalive` は、配信の変数 `CRON_SECRET` を入れていると、ブラウザで開いても 401 になる。入れていないときだけ、https://www.spelldash.net/api/cron/keepalive を開いて `"ok":true` が出ることでも見られる。
   - 見る → 次へ: 管理画面の状態が動いている（止まっていない）→ 3 へ
3. **配信のプロジェクトが 2 つある件を片付ける**（docs/FOUNDER_TODO.md A の 3 つ目）。変数（10・15）は、www.spelldash.net が付いている方のプロジェクトにだけ入れる。付いていない方は消す。
   - 見る → 次へ: 配信の管理画面のプロジェクトが www.spelldash.net の付いた 1 つになった → 4 へ
4. **決済の会社のアカウントを本番で使える形にする**: 本人確認・事業の情報・入金先の口座。カードの明細に出る名前も決める。
   - 見る → 次へ: 決済の会社の画面で、本番の支払いを受けられる状態になった → 5 へ
5. **特商法の表記（tokushoho.html）の［ ］を埋める**: 販売事業者・運営責任者（本名）・所在地・連絡先のメールアドレスの 4 つ。
   - 電話番号は「請求があれば遅滞なく開示します。」とすでに書いてある。所在地も、個人なら同じ書き方でよいとされる。条件は、請求が来たら本当にすぐ出せること（住所と電話番号をすぐ送れる形で持ち、メールの窓口を毎日見る）。すぐ出せないなら、初めから書く。
   - メールは課金の問い合わせの窓口になる。公開の Issue は、個人の情報を含む問い合わせに向かない。
   - 埋めたら `<meta name="robots" content="noindex">` の行を消す。
   - 見る → 次へ: tokushoho.html に［ ］が残っていない・noindex の行が無い → 6 へ
6. **利用規約（terms.html）を読み、合意できるか決める**。法務の目は入っていない。とくに次の 4 つ:
   - 4. Pro: 月額の自動更新・初めての方は 1 か月無料・解約はいつでも設定から・期間の終わりまで使える・日割りの返金なし・料金を変えるときは 30 日前に知らせる（Batch 83 で「月額または年額」を「月額」に直した）
   - 4. の「解約後も支払い済みの期間の終わりまで Pro を使えます」は、無料期間の中で解約した人には「無料期間の終わりまで」になる（払った期間が無い）。気になるなら文を直す（こちらで直せる）
   - 本サービスを終えるときは 30 日前に知らせ、未提供の期間を返金する
   - 賠償の上限は、直近 1 か月に払った料金
   - 見る → 次へ: 合意した（直したい所があればこちらに言う）→ 7 へ
7. **商品と Price を作る**（まずテストモードで。本番は 13 で）: Products → Add product → 名前「SpellDash Pro」。Price は定期（Recurring）・毎月・JPY・**980**。年額の Price は作らない（作って変数に入れると、画面に年額のボタンが出る）。Price ID（`price_` で始まる）を控える。
   - 見る → 次へ: Price ID を控えた → 8 へ
8. **subscriptions の表を作る**（docs/SQL_BILLING.md）。SQL を流すのは創業者だけ（こちらは流さない）。データベースの会社の SQL Editor で 1 回。これが無いと、払っても webhook が 500 を返し、Pro にならない。
   - 見る → 次へ: 表の画面（Table Editor）に `subscriptions` がある（行は 0）→ 9 へ
9. **Webhook を登録する**（テストモード）: Developers → Webhooks → Add endpoint
   - URL: `https://www.spelldash.net/api/billing/webhook`
   - イベントは 4 つ: `checkout.session.completed`・`customer.subscription.created`・`customer.subscription.updated`・`customer.subscription.deleted`
   - 作ると出る署名の鍵（Signing secret）を控える（10 で入れる）
   - 見る → 次へ: 署名の鍵を控えた → 10 へ
10. **配信の環境変数を入れて Redeploy する**（www.spelldash.net が付いている方のプロジェクト〔3 で 1 つにした〕→ Settings → Environment Variables。**Production だけ**〔Preview には入れない〕。値はテストモードのもの）:

   | 変数 | 値 |
   |---|---|
   | `STRIPE_SECRET_KEY` | Secret key（Developers → API keys。テストモードと本番モードで別の値） |
   | `STRIPE_PRICE_MONTHLY` | 7 の Price ID |
   | `STRIPE_TRIAL_MONTHS` | `1`（初めての方は 1 か月無料。解約して入り直した人には付かない） |
   | `STRIPE_WEBHOOK_SECRET` | 9 の署名の鍵 |
   | `SUPABASE_SERVICE_ROLE_KEY` | service_role key（webhook の書き込み。CRM と共用） |

   - 入れないもの: `STRIPE_PRICE_YEARLY`（年額なし）・`STRIPE_TRIAL_DAYS`（日数の無料期間。月が優先で使わない）。`SITE_ORIGIN` は既定が `https://www.spelldash.net` なので入れなくてよい（success / cancel / return の URL はこれだけから作る）
   - 任意: `ANTHROPIC_API_KEY`（入れると加入画面の比較表に「AI の覚え方」の行〔1 日の回数。無料 3・Pro 60〕が出る。無ければ行を出さない〔使えない特典を売り文に並べない〕。docs/FOUNDER_TODO.md D）
   - 変数は次のデプロイから効く。入れたら Redeploy
   - 見る → 次へ: /pro.html に「受付前」が出ず、月額 ¥980 の料金が出る → 11 へ
11. **Portal と知らせのメールと払えなかった後の状態を設定する**（テストモードと本番モードで別々。本番は 13 でもう一度）
    - Settings → Billing → Customer portal: 「サブスクリプションのキャンセル」（期間の終わりに止める形）と「支払い方法の更新」を許す。請求の履歴（領収書）も見られるようにする
    - Settings → Emails: 成功した支払いのメール（領収書）を ON。加入画面のよくある質問は「解約・お支払いの管理で、過去の請求と領収書を見られる」と書いている
    - 無料期間の終わりの知らせのメールを出すか選ぶ（勧め: 出す。知らない請求への苦情を減らす。docs/FOUNDER_TODO.md の「決めてほしいこと」の 7）
    - 払えなかったときの最後の状態を選ぶ（支払いの再試行が尽きた後）: Settings → Billing → Subscriptions and emails → Manage failed payments で、再試行が全部失敗したら **Cancel the subscription**、再試行の期間は **2 週間以内**（Batch 88・docs/FOUNDER_TODO.md の守り 1）。払えなかった人（past_due）は再試行のあいだ Pro のまま（第 3 節）なので、「past due のまま残す」にすると期間の終わりが毎回進み、払わずにずっと Pro になる
    - 異議（チャージバック）の知らせのメールを ON にする（守り 2。来たときの手順は第 6 節）
    - 無料期間で始めた加入は、支払いとしては出ない（最初の請求は約 1 か月後）。1 人目が加入したかは、決済の会社の「定期の契約」（Subscriptions）の一覧か、管理画面（docs/CRM.md）のプランの列で見る
    - 見る → 次へ: 設定を保存した → 12 へ
12. **テストモードで一巡する**（10 でテストの鍵を本番の www に入れているので、この間はだれでも加入画面を開け、公開されているテストのカードで加入の形だけを作れる〔お金は動かない〕。一巡はまとめて短い時間で行い、終わったらすぐ 13 へ進む〔13 でテストの行を全部消す〕。Preview の配信ではログインを止めているので、この一巡は本番の www でしか行えない）
    1. `/pro.html` を開く。見出しの下が「月額 ¥980（税込）。初めての方は最初の1か月無料。いつでも解約できる。」（年額は出ない）。「いつでも解約できる」の条件（期間の終わりまで使える・日割りの返金なし）は、同じ画面の「申し込みの前に」の解約の行と確定の画面の文にある。見出しの下の 1 行にも条件を入れたいと思ったら言ってもらえれば直せる（字の高さの検査も直す）。比較表はマイ単語帳・推移・テーマの 3 行（AI の鍵を入れたときは AI の覚え方を足した 4 行）。「申し込みの前に」は料金・無料期間・更新・解約・支払い・提供
    2. ログインして「1か月無料で始める（その後 月額 ¥980）」→ Stripe の確定の画面
    3. **確定の画面を見る**（特商法 12 条の 6 の最終確認の画面にあたる。スマホの幅でも）。払うボタンを押す前に、次が同じ画面で読めるか:
       - 価格（月額 ¥980・税込）と、無料期間（1 か月）・最初の請求の日
       - 自動で更新すること
       - 解約の方法と時期（いつでも「設定 → 解約・お支払いの管理」から・期間の終わりまで使える・日割りの返金なし）。ボタンの近くに出る文はこちらが渡している（`custom_text[submit][message]`。`api/_lib/billing.js` の `checkoutSubmitMessage`。金額は書かず、無料期間が付く人にだけ無料と言う）
       - 提供の時期（お申し込みの手続きが終わるとすぐ使える・無料期間中も同じ）。確定の画面の文にも入れてある（特商法の表記の提供時期と同じ。Batch 83 の反証）
       - 足りないと思ったら、文はこちらで直せる。同意のチェック欄（規約への同意）は付けていない。付けたいときは言ってもらえれば足せる
    4. カード（期限は未来の任意・CVC は任意の 3 桁・名前と住所は任意）:
       - 成功: `4242 4242 4242 4242` → 加入になる
       - 拒否: `4000 0000 0000 0002` → 「カードが拒否された」と出て、加入にならない
       - 3D セキュア: `4000 0000 0000 3220` → 確かめの画面が出る。通すと加入、失敗にすると加入にならない
    5. 払うと `/pro.html?pro=done` に戻り、「Pro になった。ありがとう」と、使えるようになったもの（マイ単語帳 1,000語まで・思い出せるようになった語の推移 90日・テーマ 紙・藍、AI の鍵があれば AI の覚え方 1日 60 回）が並ぶ。設定のプランは「Pro の無料期間中（YYYY/M/D から有料で自動更新）」
    6. **webhook の応答を見る**: Developers → Webhooks → 9 のエンドポイント → 配信の一覧。4 つとも 200 なら正しい。番号の読み方:
       - 200: 受け取った（扱わないイベントと、前の行より古いイベントも 200 で何もしない）
       - 400 `bad_signature`: 署名が合わない。署名の鍵の取り違え（テストと本番・別のエンドポイント）が多い。Vercel の関数のログに `billing/webhook: bad_signature (no raw body)` と出ていれば、届いた本文がそのまま読めていない（Vercel の関数の既定の形〔本文を先に読み切る〕は Batch 83 の反証で読めるように直した。それでも出たらこちらで直す。第 7 節・第 8 節）
       - 400 `bad_request`: 署名は合うが本文が JSON でない
       - 500: 表に書けない（8 の表が無い・`SUPABASE_SERVICE_ROLE_KEY` が違う）。決済の会社が再送するので、直したらその配信の再送のボタンを押す
       - 503: 変数が足りない（`STRIPE_WEBHOOK_SECRET`・`STRIPE_SECRET_KEY`・`SUPABASE_SERVICE_ROLE_KEY` のどれか）
    7. 設定 →「解約・お支払いの管理」→ Billing Portal でカードの変更ができる。「キャンセル」すると設定のプランが「Pro（解約予定・YYYY/M/D まで使える）」
    8. マイ単語帳で 101 語目が足せる・学習状況の「詳しい記録」の推移で 90日 が選べる・設定の「見た目」で紙・藍が選べる
    - 見る → 次へ: webhook の 4 つが 200・設定のプランに Pro と出る・Portal で解約できた → 13 へ
13. **本番に切り替える**（この順で。テストモードで作った行を本番に持ち込まない）:
    1. 決済の会社のテストモードで、9 の webhook のエンドポイントを無効にする（Disable。消してもよい）。これでテストの行はもう書かれない
    2. データベースの会社の Table Editor で `subscriptions` の行を全部消す（表の画面で全部を選んで Delete。SQL は流さない。表の形は変えない）。この表は 8 で作ったばかりなので、ここまでの行はどれもテストモードの加入（自分の 12 の行と、テストの間に加入画面からテストのカードで加入した人の行）。残すと、その人が本番で加入しようとしたときに、まだ無料期間の中なら「すでに Pro」（409）、終わっていても無料期間が付かず、テストモードの顧客の番号を本番の決済の会社に渡して「手続きを始められませんでした」（502）になる。「解約・お支払いの管理」も同じ理由で開けない。テストの行の人は、消した後は Pro ではない（テストの契約でお金は動いていない）
    3. 決済の会社を本番モードにして 7・9・11 をもう一度（Price・Webhook・Portal・メール・払えなかった後の状態の設定は本番で別）
    4. 差し替える直前に、`subscriptions` がまだ空かを Table Editor で見る（行があれば 2 をもう一度）。`STRIPE_SECRET_KEY`・`STRIPE_PRICE_MONTHLY`・`STRIPE_WEBHOOK_SECRET` を本番の値に差し替えて Redeploy
    5. 確かめる（Batch 88・守り 4）: 3 つとも本番の値か（**webhook の署名の鍵だけテストのまま残すと、だれでも使えるテストのカードの契約で Pro の行が書かれうる**）・本番の webhook の配信の記録が 200 か（14 の加入の後に見る）・テストモードの webhook は無効か・3 つとも Production だけにあり Preview に無いか
    - 見る → 次へ: `subscriptions` が空のまま・3 つの変数が本番の値で Redeploy した・5 を見た → 14 へ
14. **本物のカードで自分で一度確かめる**:
    1. 自分のアカウントで加入する（13 でテストの行を消したので、本番では行の無い初めての人として 1 か月無料になり、この時点の請求は 0 円。行が残っていると 409 か 502 になる: 13 の 2）→ 設定に Pro と出る → webhook が 200 → Portal でキャンセル → 「解約予定」と出る
    2. 本当の請求も見るなら: 1 で解約予定にした契約を Subscriptions から「すぐにキャンセル」する（解約予定のままだと無料期間の終わりまで Pro なので、加入し直せない）→ 設定のプランが「無料」に戻る → 同じアカウントでもう一度加入する（2 回目は無料期間が付かないので、その場で ¥980 が請求される）→ 領収書のメールが届く → Payments からその支払いを返金（Refund）→ Subscriptions からその契約もすぐにキャンセル（返金だけでは契約は止まらない）
    3. 返金しても、決済の手数料はふつう戻らない（少額の実費として残る）
    - 見る → 次へ: 設定のプランが「Pro の無料期間中」→ 解約 →「無料」に戻った・2 を確かめたなら領収書のメールが届いた → 15 へ
15. **管理画面を使えるようにする**（docs/CRM.md §2）: `ADMIN_USER_IDS`（自分の id。入れると id だけで決める。Batch 88・docs/FOUNDER_TODO.md の守り 12）・`ADMIN_EMAILS`（自分のメール。確認済みのアカウント）・`SUPABASE_SERVICE_ROLE_KEY` を **Production だけ**に入れる → Redeploy → www にログイン → /admin.html を開く。Preview にこの鍵を入れてあれば消す（Preview の配信はどのブランチからも作られ、ログインも止めてある。js/previewHost.js）
    - 見る → 次へ: /admin.html の一覧に自分が出る → 16 へ
16. **ログインのメールが届くかを見る**: チームの外のアドレスで、www からログインのリンクを頼む。届くかを見る（迷惑メールのフォルダも見る）
    - 届かなければ、自前のメールの送り手を設定する（データベースの会社の管理画面の認証の設定）。または、1 人目には外部アカウントのボタンでログインしてもらう（そのボタンが www で動くかも見る。docs/FOUNDER_TODO.md の「決めてほしいこと」の 6）
    - ログインのリンクを送った後の画面には「このページを開いたブラウザで開く（メールのアプリの中で開くと、ここに戻れないことがある）。」と出る（Batch 86）
    - 見る → 次へ: 外のアドレスにメールが届き、リンクを同じブラウザで開くと www でログインした形になる（または外部アカウントのボタンでログインできた）→ 17 へ
17. **user_items を作るか決める**（docs/FOUNDER_TODO.md の「決めてほしいこと」の 2）。作るなら:
    1. docs/SQL_USER_ITEMS.md の 1 を流す（前の版を流してあれば 1b）
    2. 門（docs/SQL_CLIENT_GATE.md）が入っていれば、§4.3 をもう一度流す
    3. パソコンで 1 語足し、スマホのマイ単語帳に出るのを見る
    - 作らないなら、ログイン中のマイ単語帳に「マイ単語帳は、この端末だけに保存している（ほかの端末には届かない）。」の 1 行が出る（Batch 86。表ができると出なくなる）
    - 見る → 次へ: 作ったならスマホに語が出る。作らないなら上の 1 行が出る → 18 へ
18. **1 人目を招く**: 自分の単語帳の「渡す」のリンクを送る（必要なら /pro.html の URL も添える）
    - 「メールのログインのリンクは、同じブラウザで開く」と一言添える
    - 17 で作らなかったなら「語はその端末だけに残る。設定のバックアップを使える」とも添える
    - 本番が Batch 86 のマージより前なら、まだ送らない（1）
    - 見る → 次へ: 管理画面のプランの列か、決済の会社の「定期の契約」の一覧に、その人の加入（無料期間）が出る
19. **知らせる**（任意）: news.html に第 10 節の下書きを貼る。受付中になると、マイ単語帳の上限の文の「Pro なら1,000語」が加入画面へのリンクになる（Web だけ。アプリでは出ない）。フッター・設定の「Pro について」は Batch 78 から出していないので、広く知らせるときは `/pro.html` の URL を直接渡す。
    - 見る → 次へ: /news.html のいちばん上に出た

### 受付を急いで止めるとき

- Vercel の環境変数から `STRIPE_PRICE_MONTHLY` を消して Redeploy する。加入画面は「受付前」になり、新しい加入（`/api/billing/checkout`）は 503 になる。マイ単語帳の上限の文のリンクは、端末の控え（最長 12 時間）が切れると消える（それまでに開いても加入画面は「受付前」）。
- もう加入している人の「解約・お支払いの管理」と webhook（解約予定・更新・支払いの失敗の反映）は動き続ける（秘密鍵だけを見る。Batch 83）。`STRIPE_SECRET_KEY` まで消すと、こちらも 503 で止まる（webhook は Stripe が再送する）。
- 止めるのは新しい手続きの画面を作ることだけ。止める前に作られた手続きの画面（Checkout）は、その期限（作ってから最長 24 時間）までは支払える。だから止めた後にも加入が届くことがある（webhook が記録するので、払った人は Pro になる）。すぐに全部止めたいときは、Stripe の側で開いている手続きを期限切れにする（Checkout Session の expire）。止めた後に届いた加入を断りたいときは、第 6 節の返金と契約のすぐのキャンセル。
- 再開は変数を戻して Redeploy。

## 3. entitlement（Pro かどうか）の定義

サーバー（`api/_lib/billing.js` の `isProRow`）とクライアント（`js/plan.js` の `isProRow`）が同じ式を持つ（モジュールは共有しない）:

```
isProRow(row, now) =
  row があり
  かつ row.status ∈ { active, trialing, past_due }
  かつ（row.current_period_end が無い、または current_period_end + 3 日 > now）
```

- **3 日の猶予**: `current_period_end` + 3 日を過ぎたら、status が何であれ free（webhook が遅れても、期間の終わりの後に長く Pro のままにならない）
- **past_due も Pro**（Batch 88 で書き直し）: 支払いに失敗した人は、決済の会社の再試行が終わって契約が解約されるまで Pro。失敗した時点で `current_period_end` は次の期間の終わりへ進んでいるので、期限 + 3 日では切れない。長さは決済の会社の設定で決める: 再試行は 2 週間以内・全部失敗したら解約（第 2 節の 11・docs/FOUNDER_TODO.md の守り 1）。支払い失敗の直後に特典を止めると、カードの期限切れだけでマイ単語帳の追加やテーマが突然使えなくなるので、コードでは縮めない（決めてほしいことの 11）
- `canceled` / `unpaid` / `incomplete` / `incomplete_expired` / `none` は free。解約予定（`cancel_at_period_end: true`）は status が `active`（無料期間なら `trialing`）のままなので、期間末まで Pro
- クライアントは本人の行を `localStorage` の `spelldash_plan` にキャッシュし、`isPro()` は同期的にそれを見る（ネットワークに行かない）。更新のタイミングはログイン直後・各ページの表示時（`refreshPlan()`）・`?pro=done` のとき（`waitForPro()`）。ログアウトで消す
- 最終判断はサーバー: AI の回数（`api/_lib/shared.js` の `aiTake()`。Batch 88 の前は `reject()`）は本人のトークンで `subscriptions` を読んで決める（ユーザーごと 5 分キャッシュ）。クライアントの判定は表示とローカルのゲート（単語帳の上限・推移・テーマ・修復）だけ

## 4. 特典とゲートの一覧

加入画面の比較表と加入直後の一覧（`js/proView.js`）に書くのは、今の画面（英単語の学習に絞った形）で本当に使えるものだけ（Batch 83）。数はコードの値から入れる（字がずれない）。ゲートそのものは変えていない（書かない特典も、Pro の人には今のとおり効く）。

| 特典 | 無料 | Pro | 加入画面 | どこで変わるか |
|---|---|---|---|---|
| マイ単語帳の語数 | 100 語まで | 1,000 語まで | 書く | `js/myWordsCore.js` の `MY_FREE_LIMIT`・`MY_PRO_LIMIT`、`js/myWords.js` `maxMyWords()`。超えている人も見る・消す・移す・練習はできる（追加だけ止まる）。上限の文の「Pro なら1,000語」は、受付中の Web だけ加入画面へのリンク（`js/myWordsPage.js`。受付前・アプリ・Pro の人は文だけ） |
| 思い出せるようになった語の推移 | 30 日 | 90 日 | 書く | `js/plan.js` の `TREND_DAYS`（学習状況のゲート `js/statsView.js` と比較表が同じ値）。学習状況の「詳しい記録」の中。30／90 の切り替えは Pro の人にだけ出す。選択は `spelldash_trend_range`（growthLog は 120 日ぶん保持） |
| テーマ | 白・黒 | 白・黒・紙（paper）・藍（indigo） | 書く | `js/theme.js`。free の保存値が紙・藍なら白・黒に落として保存し直す。設定の「見た目」の `#themeHint`。head のスニペットは Pro 判定をしない（失効直後は 1 瞬だけ旧テーマ、theme.js が直す） |
| AI（覚え方） | 1 日 3 回 | 1 日 60 回 | 書く（AI の鍵があるときだけ。無ければ行を出さない〔加入直後の一覧も〕。前に取れた config に AI があった端末は、config が遅いときも行を先に出して回数を後から入れる〔`spelldash_billing_open` の `ai`〕。初めて開いて config が遅い〔画面を出した後に届く〕ときは、その画面では AI の行を足さない〔足すと下の節が動く。次に開くと出る〕） | サーバー `api/explain-word.js` → `aiGate()` → 入力の確かめ → `aiTake()`（Batch 88）。回数は `api/_lib/aiLimits.js`（`EXPLAIN_WORD_DAILY_LIMIT`・`EXPLAIN_WORD_DAILY_LIMIT_PRO`）だけで決まり、`/api/billing/config` の `ai` が同じ値を比較表に返す。使う場所は学習状況の語の詳細の「覚え方を作る」（ログイン中） |
| AI（テキストからカード） | 1 日 2 回 | 1 日 20 回 | 書かない（入口の list.html は転送で、今の画面から届かない） | サーバー `api/generate-cards.js` → `aiGate()` → 入力の確かめ → `aiTake()`（`CARD_GEN_DAILY_LIMIT`・`_PRO`。`CARD_GEN_ENABLED=1` のときだけ動き、無ければ 503。Batch 88） |
| シールドの上限 | 2 枚 | 3 枚 | 書かない（今の画面は連続日数とシールドを出さない） | `js/level.js` `shieldMax()` |
| 連続記録の修復 | なし | 月 1 回、途切れてから 7 日以内 | 書かない（学習状況の「詳しい記録」の中にだけ出る） | `js/level.js` `getLostStreak()` / `canRepairStreak()` / `repairStreak()`。`stats.html` の `#streakRepair`（`repairedMonth` を `spelldash_streak` に保存。sync.js はクラウド採用時に `lost` / `repairedMonth` も写す） |

AI の上限の 429 の文: 無料「今日の無料ぶん（N回）は使い切った。」と別の欄 `offer`「Pro なら1日M回」/ Pro「今日の上限（M回）に達した。また明日」。表示側（`js/wordAi.js`）は、受付中で、英単語の学習に絞っていない形（旗を外した形）のときだけ `offer` と「（Pro について）」のリンクを続ける。今の画面では文だけ。

## 5. アプリ版（Capacitor）の扱い

- 加入画面 `/pro.html` と特商法 `/tokushoho.html` はアプリに入れず（scripts/build-app.mjs の PAGES に無い）、アプリではそこへのリンクも出さない（2026-10-13、PR #164 のレビュー。docs/APP.md の課金の行）。`/pro.html` に残る `isNativeApp` の分岐（価格と購入ボタン `#proPlans` を出さず「Pro の加入と管理は Web 版（www.spelldash.net）で。」と状態だけ）は、通らない経路の守りとして残す。プロフィールのプラン行もボタン無し（値だけ）。マイ単語帳の上限の文も、アプリでは Pro の話をしない
- 理由: ストアの審査の決まり（3.1.1）。アプリ内でデジタルコンテンツの購入へ誘導すると、アプリ内課金が必要になり、外の決済への誘導は審査で落ちる。価格やリンクを出さない「リーダー型」なら、Web で加入した状態をアプリで使うのは可
- Web で加入した状態は user_id に紐づく（`subscriptions`）。ただしアプリはまだログインできないので、アプリで Pro にはならない。アプリのログインができるまで「アプリでも使える」とは書かない（加入画面の FAQ からも外した）
- 将来ストアの課金を入れるなら、`subscriptions` に `source`（stripe / ストアの名前）列を足し、`isProRow` はそのまま使える。いまは判断しない（docs/APP.md）
- 審査の説明文に「購入はアプリ外。アプリ内に価格・購入導線は無い」と書く（docs/APP.md §5 と合わせる）

## 6. 解約・返金・問い合わせの運用

- **解約は本人が Billing Portal で**（設定 →「解約・お支払いの管理」）。期間末で止まり（`cancel_at_period_end`）、それまで Pro。日割りの返金はしない（tokushoho.html・terms.html・/pro.html の「申し込みの前に」と確定の画面の文に明記）。解約の取り消しも Portal から
- **返金**は Stripe ダッシュボード → Payments → 該当の支払い → Refund で手動。返金しても subscription は止まらないので、必要なら Subscriptions → Cancel も行う（webhook が `deleted` → `canceled` を書く）
- **領収書**は決済の会社が支払いのたびにメールで送る（Settings → Emails で成功した支払いのメールを ON。第 2 節の 11）。Portal からも過去の請求書を見られる
- **異議（チャージバック）**（Batch 88・守り 2）: 決済の会社から異議の知らせが来たら、先にその人の契約を「すぐにキャンセル」する（webhook が `canceled` を書き、Pro が終わる。次の請求も止まる）。それから異議に答える（加入の日時・確定の画面の文・使った記録）。自動で止めるコードは入れていない（決めてほしいことの 13）
- **問い合わせ**: 「加入したのに Pro にならない」は第 8 節。「カードを変えたい」は「解約・お支払いの管理」。「アカウントを消したい」は **この順で**（Batch 88・守り 3）: (1) 決済の会社の顧客の一覧でその人を探す（契約の metadata の `user_id`、またはメール）。契約があれば「すぐにキャンセル」する（顧客ごと消してもよい） (2) その後に、データベースの認証のユーザー（`auth.users`）を消す（`subscriptions` も `on delete cascade` で消える）。逆の順にすると、行が消えた後も課金が続き、本人は「解約・お支払いの管理」も開けない
- **価格を変えるとき**: Stripe で新しい Price を作って `STRIPE_PRICE_MONTHLY` を差し替える（既存の加入者は旧 Price のまま続く＝実質値上げなし）。コードの変更は不要。特商法の表記と規約は第 11 節
- Pro を手で付けたいとき（お礼・検証）: Stripe で 100% のクーポンを作り Checkout の「プロモーションコード」欄で使ってもらう（`allow_promotion_codes=true`）。DB を直接書くのは最後の手段（docs/SQL_BILLING.md §3）

## 7. プライバシーとセキュリティ

- 鍵の置き場: `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `SUPABASE_SERVICE_ROLE_KEY` は Vercel の環境変数だけ。クライアントに渡さず、応答にも含めず、ログにも書かない。リポジトリには Stripe の鍵（`sk_` や `whsec` で始まる文字列）を置かない（受け入れ基準の grep。`scripts/test-billing.mjs` の偽の鍵もこの形にしていない）
- カード番号は Stripe Checkout（Stripe のドメイン）で入力され、SpellDash のサーバーには来ない（PCI DSS の SAQ A 相当）。SpellDash が持つのは `status` / 更新日 / `stripe_customer_id` / `stripe_subscription_id` / `price_id` だけ（privacy.html「お支払い情報」）
- Webhook の署名検証: `Stripe-Signature: t=...,v1=...` を分解し、`HMAC-SHA256(secret, "${t}.${rawBody}")` の hex を `v1` のどれかと `crypto.timingSafeEqual`（長さ違いは不一致）。`|now - t| > 300 秒` は拒否
- 生ボディ（Batch 83）: Vercel の関数は、既定の補助（helpers）が関数を呼ぶ前に本文を最後まで読み、読み切ったバイト列の写しへ `req.on('data'/'end')` と `req.read` を付け替え、`req.body` は読んだ時に JSON にする（`rawBody` は置かない）。`webhook.js` の `bodyParser: false` の指定は読まない（効かない。Batch 83 の反証で、公開されている実行環境の版の中身を読み、その形を組み直した要求で確かめた）。補助は切らない（関数は `res.status`・`res.json` を使う）。だから `readRawBody` は `rawBody` → 付け替えた `req.on` の写し → まだ読まれていない流れ → 文字列か Buffer の `body` の順に読み、`req.body` は最後まで触らない（読むと解析する・例外を出す作りがある）。写しが終わらないときは 5 秒で諦める。解析済みの値しか無ければ署名を確かめず 400（JSON を作り直して確かめない）。`scripts/test-billing.mjs` がこの形（と前からの 7 つの形）を確かめる。テストモードの一巡（第 2 節の 11）で 200 になれば、本番の形で読めている
- 逆順到着: `subscriptions.event_created` に最後に反映した event の `created` を持ち、それ以下のイベントは書かない（`updated` の後に古い `created` が届いても巻き戻らない）。本人の行がまだ無いときの最初の書き込みは「入れるだけ」（`resolution=ignore-duplicates`）。入らなかった（同時に届いた別のイベントが先に入れた）ら、`event_created` を条件にした書き換えへ進む（同時に届いても新しいイベントが残る。Batch 83）
- RLS: `subscriptions` は本人が自分の行を **読むだけ**。insert / update / delete は `anon` / `authenticated` から revoke。書くのは webhook（service role）だけ。checkout / portal / AI の回数判定は本人のトークン + anon key で読む（RLS で本人だけ）
- 冪等性・二重課金（Batch 88 で書き直し）: 手続きはいつも本人の顧客で作る（行の顧客 → metadata の `user_id` で検索 → 冪等キー `customer:<userId>` で作る。`customer_email` は渡さない）。手続きの作成に冪等キー `checkout:<userId>:<interval>:<trial|paid>:<分>` を付け、同じ分の二度押しは同じ手続き。すでに Pro・本人の顧客に生きている契約があれば 409 `already_subscribed`。新しい手続きを作ったら、同じ顧客の開いている別の手続きを期限切れにし、手続きの期限（`expires_at`）も作ってから 35 分（古いタブや履歴から前の手続きを最後まで進めて、契約が 2 つになるのを止める）。webhook は、行が Pro の間に別の契約の終わりが届いても書かない（`other subscription ignored`）・2 つとも生きていれば新しい方を書いて `duplicate live subscription` をログに出す・行の契約が終わったら同じ顧客のほかの生きている契約を書く（第 8 節。その一覧が読めないときは、4xx〔顧客を消した後の「その顧客は無い」など〕ならほかに無いとみなして届いた状態を書き、一時的な失敗〔5xx・429・つながらない〕ならイベントができてから 1 時間までは 500 で再送を待ち、その後は届いた状態を書く: Batch 88 の反証）。加入と「解約・お支払いの管理」は 1 人 1 分 10 回まで（インスタンスのメモリー。11 回目は 429 `too_many`）
- ログは `billing/<label>: <種別> <状態>` だけ。メール・顧客 id・リクエスト本文は書かない。CRM にも Stripe の id は出さない
- 応答は常に `Cache-Control: no-store`。sw.js は `/api/` を保存しない
- `SITE_ORIGIN` の既定は本番。success / cancel / return の URL をリクエストヘッダから作らない（Host ヘッダ偽装でのオープンリダイレクトを避ける）

## 8. トラブルシューティング

| 画面の表示・症状 | API / ログ | 原因 | 直し方 |
|---|---|---|---|
| /pro.html に「Pro はまだ受付前。」 | `GET /api/billing/config` が `configured:false` / checkout が 503 `not_configured` | `STRIPE_SECRET_KEY` か `STRIPE_PRICE_MONTHLY` が無い | 第 2 節の 10 を入れて Redeploy |
| 鍵と Price を入れたのに「Pro はまだ受付前。」 | config が 502 `upstream`、ログ `billing/config: upstream` | Price ID が違う（テスト／本番の取り違え）、キーが違う | Stripe の Price ID と鍵のモードをそろえる |
| 年額ボタンが出ない | config の `prices` に year が無い | 年額は出さない決定（`STRIPE_PRICE_YEARLY` を入れていない） | 正常 |
| 支払ったのに Free のまま（`?pro=done` で「反映を待っている」） | 決済の会社の画面の Webhooks に配信が無い、または 400 / 500 / 503 | webhook 未設定／URL 違い／`STRIPE_WEBHOOK_SECRET` 違い（400 `bad_signature`）／`subscriptions` 未作成（500、ログ `subscriptions table missing`）／変数の不足（503） | 第 2 節の 8〜10。決済の会社は失敗した配信を再送する。直したら Webhooks → 該当イベント → 再送のボタン。設定を開き直すと反映 |
| Webhook が 400 `bad_signature` | `billing/webhook: bad_signature` | Signing secret の取り違え（テスト／本番、別エンドポイント）、またはプロキシで本文が変わった | 該当エンドポイントの Signing secret を入れ直して Redeploy。時刻ずれなら 300 秒以内か確かめる |
| Webhook が 400 で、ログに `(no raw body)` | `billing/webhook: bad_signature (no raw body)` | 届いた本文のバイト列が読めない（配信の側が先に読み切り、生の値も写しも残していない。今の Vercel の既定の形〔写しを `req.on` に付け替える〕は読める） | コードの側で直す（`readRawBody`。第 7 節）。それまで Stripe は再送を続ける |
| Webhook が 500 | `billing/webhook <type>: upstream subscriptions <status> <code>`（Supabase に書けない）/ `billing/webhook: <type> subscriptions table missing`（テーブル無し）/ `billing/webhook <type>: upstream stripe …`（checkout.session.completed で subscription を取り直せない） | Supabase に書けない（テーブル無し、service role key 違い） | docs/SQL_BILLING.md を実行、`SUPABASE_SERVICE_ROLE_KEY` を確かめる。再送で入る |
| Webhook のログに `no user for customer` | 200 で無視 | `metadata.user_id` が無く、`stripe_customer_id` でも行が見つからない（Stripe ダッシュボードで手で作った subscription など） | Checkout 経由で加入し直すか、docs/SQL_BILLING.md §3 の手順で行を作る |
| 「すでに Pro。」 | checkout 409 `already_subscribed` | 本人の行が isProRow | 正常。設定の「解約・お支払いの管理」へ |
| 「お支払いの記録が無い」 | portal 404 `no_subscription` | `stripe_customer_id` が無い（加入直後で webhook 未着、または一度も加入していない） | 数分待って開き直す。それでも無ければ webhook（上の行） |
| 解約したのに Pro のまま | | 期間末まで Pro（解約予定）。期限 + 3 日の猶予 | 仕様。`#planValue` が「解約予定・YYYY/M/D まで」なら正常 |
| 支払い失敗の人が Pro のまま／急に Free になった | status `past_due` | 払えなかった人は、決済の会社の再試行が終わって契約が解約されるまで Pro（失敗した時点で期間の終わりは次の期間へ進んでいるので、期限 + 3 日では切れない。第 3 節）。解約されると webhook が `canceled` を書いて free | 「解約・お支払いの管理」でカードを更新してもらう。再試行が成功すれば `active` に戻る。画面の文は「お支払いが確認できていない。カードを更新しないと無料に戻る」で日付を出さない（無料に戻る日は決済の会社の再試行と解約の設定が決める: 第 2 節の 11。「past due のまま残す」にすると払わずにずっと Pro） |
| 関数のログに `billing/webhook: duplicate live subscription` | webhook は 200 | 同じ人に生きている契約が 2 つ（Batch 88 より前の版で、開いたままの 2 つの手続きを両方払った・決済の会社の画面で手で作った） | 新しい方を返金して、その契約を「すぐにキャンセル」する（支払いの一覧 → 返金・定期の契約の一覧 → すぐにキャンセル）。行は生きている方を指したまま残り、どちらを先に止めても Pro は切れない（Batch 88。行の契約が終わると、同じ顧客のほかの生きている契約を書く）。番号はログに出さないので、管理画面のプランの列と決済の会社の顧客の画面で 2 つの契約を探す |
| 加入・「解約・お支払いの管理」で「少し待ってからもう一度お試しください。」 | 429 `too_many` | 同じ人が 1 分に 11 回以上押した（Batch 88。インスタンスのメモリーで数える） | 1 分待つ。ふつうの使い方では出ない |
| テーマが白／黒に戻った | | 失効したので紙・藍を落とした（`getTheme()`） | 仕様。再加入で選び直せる |
| ログインし直したら Pro の表示が消えた | | `spelldash_plan` のキャッシュをログアウトで消す。ログイン直後の `refreshPlan()` が終わる前 | 1〜2 秒待つ。続くなら `subscriptions` の RLS（本人 select）を docs/SQL_BILLING.md (a)(b) で確かめる |
| 加入画面の比較表に「AI の覚え方」の行が無い | config の `ai` が null | `ANTHROPIC_API_KEY` が無い（AI が使えない間は行を出さない。Batch 83 の反証） | 任意。入れて Redeploy（docs/FOUNDER_TODO.md D） |
| CRM の `missing` に `subscriptions` | `GET /api/admin/players` | テーブル未作成 | docs/SQL_BILLING.md。無くても CRM は動く（全員 free 表示） |

Stripe のダッシュボードで見る場所: Payments（支払い・返金）、Subscriptions（状態・解約予定）、Customers（メールで検索。SpellDash の `user_id` は subscription の metadata）、Developers → Webhooks（配信ログ。応答本文も見える）、Developers → Logs（API 呼び出し。Idempotency の重複も分かる）。

## 9. API 契約（開発者向け）

すべて JSON、`Cache-Control: no-store`、エラーは `{ error, message }`（message は日本語の短文）。

| エンドポイント | 認証 | 応答 |
|---|---|---|
| `GET /api/billing/config` | 不要 | `{ configured: boolean, prices: [{ interval: "month"\|"year", amount: number, currency: "jpy" }], trialMonths: number, trialDays: number, trialEndsAt?: string, ai: { explain: { free, pro } } \| null }`（無料期間は初めての人だけ。月が設定されていれば trialDays は 0。`ai` は AI の鍵があるときだけ、`api/_lib/aiLimits.js` の 1 日の回数）。未設定なら `{ configured:false, prices:[], trialDays:0, trialMonths:0, ai }`（200）。Price は 10 分メモリキャッシュ。`amount` は `unit_amount` そのまま（JPY はゼロ小数） |
| `POST /api/billing/checkout` `{ interval }` | Bearer 必須 | `{ url }`（決済の会社の手続きの画面）。503 `not_configured` / 401 `login_required` / 400 `bad_request`（interval が month / year 以外、または year 未設定）/ 409 `already_subscribed`（行が Pro か、本人の顧客に生きている契約がある）/ 429 `too_many`（1 人 1 分 10 回。Batch 88）/ 502 `upstream` |
| `POST /api/billing/portal` | Bearer 必須 | `{ url }`（Billing Portal、return は `/profile.html`）。404 `no_subscription` / 503（秘密鍵が無い。月額の Price は見ない）/ 401 / 429 `too_many`（1 人 1 分 10 回。Batch 88）/ 502 |
| `POST /api/billing/webhook` | `Stripe-Signature` | `{ received: true }`（200）。400 `bad_signature`（署名不正・300 秒超・生の本文が読めない）/ 400 `bad_request`（JSON でない）/ 503（署名の鍵・秘密鍵・service role の鍵のどれかが無い。月額の Price は見ない）/ 500（Supabase 書き込み失敗 → Stripe が再送） |

Checkout セッションの中身: `mode=subscription`、`line_items[0][price]`、`client_reference_id=<userId>`、いつも `customer=`（本人の顧客。行の `stripe_customer_id` → metadata の `user_id` で検索 → 冪等キー `customer:<userId>` で作る。`customer_email=` は渡さない。Batch 88）、`expires_at`（作ってから 35 分。Batch 88）、`metadata[user_id]` と `subscription_data[metadata][user_id]`、`success_url=${SITE_ORIGIN}/pro.html?pro=done`（旧 `/profile.html?pro=done` も引き続き反映を待つ）、`cancel_url=${SITE_ORIGIN}/pro.html?pro=cancel`、`locale=ja`、`allow_promotion_codes=true`、初めての人（行が無く、決済の会社の検索でも契約が無い）だけ `subscription_data[trial_end]`（`STRIPE_TRIAL_MONTHS` なら日本時間で n か月後、`STRIPE_TRIAL_DAYS` なら n 日後の UNIX 秒）。確定の画面のボタンの近くの文 `custom_text[submit][message]`（Batch 83。`checkoutSubmitMessage`: 自動更新・最初の請求の日・解約の場所と時期・日割りの返金なし。無料期間が付くときだけ無料と言う。金額は書かない。500 字以内）。同意のチェック欄（`consent_collection`）は付けない（第 2 節の 11 で確定の画面を見てから決める）。

Webhook が扱うイベント: `checkout.session.completed`（`mode=subscription` のみ。`subscription` id で `GET /v1/subscriptions/{id}` を取り直して書く）、`customer.subscription.created` / `updated` / `deleted`（`deleted` は `status=canceled`）。他は 200 で無視。本人の行が無ければ `POST /rest/v1/subscriptions?on_conflict=user_id`・`Prefer: resolution=ignore-duplicates,return=representation`（入れるだけ）、行がある・入らなかったときは `PATCH ...?user_id=eq.<id>&event_created=lte.<created>`（新しくないときだけ書き換える）。

AI の入口（`api/_lib/shared.js`。Batch 88）: `aiGate(req, res)`（メソッド・AI の鍵・メールを確認した匿名でないログイン。ほかは 401 `login_required`）→ 各 api が入力を確かめる（400 は数えない）→ `aiTake(req, res, user, { scope, limit, proLimit })`（同じ人の同時の呼び出しは 429 `busy`。回数はデータベースの関数 `ai_take` で数え、無い・失敗・3 秒で答えないときはインスタンスのメモリー: docs/SQL_AI_USAGE.md）→ モデル → 終わりに放す。超えたら 429 `{ error: "daily_limit", upgrade, message }`。

クライアント（`js/plan.js`）: `getPlan()` → `{ pro, status, interval, periodEnd, cancelAtPeriodEnd, checkedAt }`（`localStorage.spelldash_plan`）、`isPro(now)`、`refreshPlan()`（`document` に `spelldash:plan` イベント）、`waitForPro({ tries, interval })`、`clearPlan()`、`postBilling(path, payload)`、`TREND_DAYS`（推移の日数）。

検査: サーバー側は `scripts/test-billing.mjs`（CI の単体の検査。偽の fetch が決済の会社とデータベースの代わりに答え、外へ出ない。署名（設定した鍵で確かめる・鍵の入れ替えも）・webhook のイベントの書き込みと逆順・同時に届いた 2 つのイベント・生ボディの 9 つの形（配信の補助が先に読み切った本番の既定の形・rawBody を先に見る形を含む）と写しが終わらないときの守り・加入と管理の守り・確定の画面の文（提供の時期も）・受付を止めた後・価格と AI の回数・Pro の判定と無料期間・ログに鍵やメールを書かない）。AI の入口・管理画面の門・動線の数・cron の鍵は `scripts/test-api-guard.mjs`（Batch 88。CI の単体。4 つの子のインスタンスで AI の回数の合計を見る）。画面は E2E（`npm test` の節「19. SpellDash Pro」）: ローカルサーバーが `/api/billing/*` を偽装（config は常に configured・`ai` は無料 3・Pro 60。checkout は Bearer 無し 401・`pro-token` 409・他は `/pro.html?pro=done` へ。portal は `pro-token` だけ 200）。スタブの `from("subscriptions")` は `localStorage.spelldash_test_plan` を本人の行として返す。`localStorage.spelldash_test_delay`（`{"session": ms, "plan": ms}`）があれば、getSession と subscriptions の読みをページを開いてからその時刻まで返さない（加入画面の読み込みの検査。2026-10-14 PR #170 のレビュー）。

## 10. 告知文の下書き（news.html 用。受付開始時に創業者が貼る）

> **SpellDash Pro の受付を始めました**
>
> 思い出して打つ・今日のセット・復習・記録は、これからも無料のままです。
> Pro は、自分の単語をもっと入れたい人、長く続けている人のための追加機能です。
>
> - マイ単語帳: 100 語 → 1,000 語
> - 思い出せるようになった語の推移: 30 日 → 90 日
> - テーマ: 「紙」と「藍」
> - AI の覚え方: 1 日に使える回数が増えます
>
> 月額 ¥980。初めての方は最初の 1 か月無料で、その間に解約すれば料金はかかりません。いつでも解約でき、期間の終わりまで使えます。
> 覚えやすさや判定が有利になるものは売りません。ランキングも無料のままです。
> 詳しくは [SpellDash Pro](./pro.html) へ。

金額は Stripe で決めた額に直してから貼る。AI の覚え方の行は `ANTHROPIC_API_KEY` を入れたときだけ残す（無ければ消す）。news.html の既存の書式（`<article>`、日付）に合わせる。

## 11. 価格

- **決定（2026-10-07）: 月額 ¥980（税込）、初めての方は 1 か月無料（随時）。年額は出さない**
- 以前の仮説（docs/MONETIZATION.md 由来の ¥580/月・¥4,800/年。中高生が小遣いで払える上限を意識して低め）は、この決定で置き換わった。docs/MONETIZATION.md・docs/DECISIONS_V4.md §9・docs/PRO_VALUE.md §6 の ¥580 は、決定より前の記録として残している（それぞれに置き換わった旨の 1 行がある）
- docs/PRO_VALUE.md の「月額 1,000 円払ってもやりたい」は価値設計の目標で、価格の決定ではない
- 決めるのは創業者。画面の金額は Stripe の Price から出るので、Stripe の Price を作り直して環境変数を差し替えれば加入画面は変わる（既存の加入者は旧 Price のまま）。**ただし文で書いてある所がある**: 特商法の表記（tokushoho.html の販売価格・支払時期）には「月額 980 円」「1 か月の無料期間」、利用規約（terms.html の 4.）には「月額の自動更新」「1 か月の無料期間」（規約に金額は無く、加入画面に表示するとだけ書く）。価格・無料期間を変えたら両方を直す。年額を出すなら規約の 4. も直す
- 最初の 10 人・20 人のうちは、価格より「何に払うか」の反応を見る（docs/PRO_VALUE.md §5）。無料期間（1 か月）があるので、最初の数字は「無料期間からの継続率」で見る（管理画面の動線の checkout_done は無料期間の開始で数える）
