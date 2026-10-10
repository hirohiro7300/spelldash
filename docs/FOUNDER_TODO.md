# 創業者側でやること（1 枚にまとめ）

> 2026-10-02 作成。コード側はすべて本番に入っている。ここにあるのは **ダッシュボードの操作・SQL の実行・記入・判断** で、こちらからは代われないもの。
> 終わったら行頭を ☐ → ✅ にして commit するか、チャットで一言ください（次の自走の前提が変わるため）。

## A. いますぐ（サービスが一部止まっている）

- ☐ **Supabase のプロジェクトを復旧する** — ダッシュボード → プロジェクト `sujvgwozsnzjsjmkcrnk` → **Restore project**。
  無料プロジェクトは 1 週間 API が呼ばれないと自動停止し、ホスト名が消える（`DNS_PROBE_FINISHED_NXDOMAIN`）。停止中はログイン・クラウド同期・ランキング・CRM・Pro の API が止まる（学習そのものは端末内で動く）。
  復旧後は、日次の `/api/cron/keepalive` が止まらないように保つ。根本対策は Supabase Pro（$25/月）。
- ☐ **Vercel の重複プロジェクトを消す** — `spelldash` と `spelldash-jzf8` の 2 つが同じリポジトリに繋がっていて、デプロイ枠を 2 倍使う（過去に日次上限に到達）。消す前に: 本番ドメイン `www.spelldash.net` がどちらに付いているか／環境変数がどちらにあるか を確認し、付いていない方を削除（docs/DECISIONS_V4.md §10）。

## B. 課金（SpellDash Pro）を受け付け始めるなら — 手順は docs/BILLING.md §2

- ☐ Stripe で商品「SpellDash Pro」と **Price（月額 ¥980・税込 JPY・毎月）** を作る（2026-10-07 決定）。**価格はコードに無い**ので、Stripe の Price が画面に出る。年額は作らない（作ると画面に年額のボタンが出る）
- ☐ Vercel の環境変数: `STRIPE_SECRET_KEY`、`STRIPE_PRICE_MONTHLY`（¥980 の Price の id）、**`STRIPE_TRIAL_MONTHS` = `1`**（初めての方は 1 か月無料。解約して入り直した人には付かない）、`STRIPE_WEBHOOK_SECRET`、`SUPABASE_SERVICE_ROLE_KEY`（CRM と共用）→ Redeploy
- ☐ Stripe の Webhook に `https://www.spelldash.net/api/billing/webhook`（イベント: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`）
- ☐ Supabase SQL Editor で **docs/SQL_BILLING.md**（`subscriptions` テーブル）
- ☐ **tokushoho.html の［ ］を記入**（事業者名・運営責任者・所在地・連絡先）。記入したら `<meta name="robots" content="noindex">` の行を消す。**特定商取引法の必須項目**なので、受付開始前に必ず
- ☐ **terms.html（利用規約）を一読**。法務の目は入っていない。特に「料金変更は 30 日前告知」「終了時は未提供期間を返金」「損害賠償の上限は直近 1 か月分」は、合意できる内容か確認
- ✅ 無料期間 → **初めての方は 1 か月無料（随時）**（2026-10-07 決定）。`STRIPE_TRIAL_MONTHS=1` で、加入画面の料金の行・ボタン「1か月無料で始める（その後 月額 ¥980）」・「申し込みの前に」の無料期間の行（終わりの日と請求額）が自動で出る。特商法の表記と利用規約にも書いた
- ☐ テストモードのカード `4242 4242 4242 4242` で加入 → プロフィールに「Pro」が出る → Portal で解約、まで一巡 → 本番キーに差し替え → お知らせ（下書きは docs/BILLING.md §10）

## C. 管理画面（CRM）を使うなら — docs/CRM.md §2

- ☐ Vercel の環境変数 `SUPABASE_SERVICE_ROLE_KEY` と `ADMIN_EMAILS`（自分のメール。確認済みのアカウント）→ Redeploy → `/admin.html`
- ☐ メモ・タグ・ピン留めを使うなら docs/SQL_CRM.md の 1（`crm_notes`）。人数が増えて一覧が遅くなったら 2（RPC）
- ☐ Pro までの動線を数えるなら docs/SQL_FUNNEL.md の 1（`funnel_events`）。流すと管理画面に「Pro までの動線」の数が出る。受付を始める前に流しておくと、最初の加入から数えられる
- ☐ 任意: タイピング練習（/typing.html、Batch 59）の数を見る。docs/SQL_FUNNEL.md 5 の SELECT を SQL Editor で流す（表は変えない。上の 1 を流してあれば数え始めている）。比は週ごとの推移で見る（ボットが分母に混ざりうる）

## D. AI 機能（テキストからカード・覚え方の解説）を開けるなら

- ☐ Vercel の環境変数 `ANTHROPIC_API_KEY` → Redeploy。無料は 1 日 カード 2 回／解説 3 回、Pro は 20／60 回（`CARD_GEN_DAILY_LIMIT*` / `EXPLAIN_WORD_DAILY_LIMIT*` で変更可）

## E. ずっと前からの保留（効くのは該当機能だけ）

- ☐ docs/SQL_USER_ITEMS.md — マイ単語帳・メモ・追加したパック・日ごとの記録（今日のぶん・成長ログ）の端末間同期（`user_items`）。まだ流していなければ 1. をそのまま、以前の版を流してあれば 1b. の 2 文（kind に `day` を足す）を 1 回
- ☐ docs/SQL_FEEDBACK.md — ご意見フォームの保存先（`feedback`）。未実行の間、フォームの送信は失敗する
- （いまは何も要らない）記憶の保持率（docs/SPEC_RETENTION.md、2026-10-08）は Phase 1 がこの端末の記録だけで動く。**Phase 2（2 台目への同期）に進むときに SQL が 1 本**（user_items の kind に `ret` を足す check 制約の ALTER か、新テーブル）。そのときに docs/SQL_USER_ITEMS.md の隣に書く
- ☐ アプリ版（Capacitor）: Mac／Xcode／TestFlight。docs/APP.md。コードは Web と同じものを `npm run app:build` で `dist/` に出す

## F. 判断してほしいこと（決まれば反映はこちらでやる）

0. ✅ **価格**: 月額 ¥980、初めての方は 1 か月無料（2026-10-07 決定）。残り: Pro の次の中身（docs/PRO_VALUE.md §6 の「受験日から逆算した計画」など）

1. **見出し語の変更 18 件**（docs/AMBIGUOUS_JA.md §7）: headquarter → headquarters、pant → pants、descendent → descendant、congratulation(s)、sightsee、unauthorize、stockmarket、品詞のずれ（cosmetic／overtime／capitalist）、接頭辞カード inter。id と学習記録に触るので方針が要る（例: 「英語として標準形に直す。id は据え置き」）
2. **カタカナだけの訳 225 語の方針**（docs/AMBIGUOUS_JA.md §2 の案 A／B／C）
3. **無料の AI 回数**（年額は出さない前提。出すなら Stripe に年額の Price を作り `STRIPE_PRICE_YEARLY` を足すだけで画面に出る）
4. **はちゃんの台詞の方向**: Batch 38 で「1 文・！は 1 つ・盛り上げ語なし」に揃えた。物足りなければ docs/CHARACTER.md の範囲で戻せる
5. **390px でヘッダーの「バトル」タブを隠した**（ホームの「ほかの遊び方」から入れる）。Battle を前に出したいなら戻す
6. **アプリ版での Pro の扱い**: 購入導線は出していない（Apple 3.1.1）。Web で加入すれば同じアカウントで有効。ストア審査の方針が決まったら見直す
7. **はちゃんの 4 場面目**: プレイ中に語を自力で思い出せたとき、はちゃんが「invoice、残ってた。」と吹き出しで出る（`#learnToast`）。規則の 3 場面（ホーム・完了・週間）に入っていない。残すなら docs/CHARACTER.md に「4 場面目: 覚えた瞬間」と書き、外すなら吹き出しをやめて文字だけの表示にする。あわせて、はちゃんの台詞のうち「おはよう。今日の15語、いこう。」のような挨拶＋1 文（2 文）を許すかどうか
8. **Battle の文言を日本語にした（Batch 43）**: ロジックは触っていないが、画面の英語ラベル（Ranked Match／VICTORY／Score／Miss! など）を「対戦を始める／勝ち／スコア／違う」に、CPU のタイプ名を「安定型／速攻型／堅実型／互角」にした。ランク名（Bronze…）と RP はそのまま。英語の雰囲気を残したければ戻せる（文字列だけ）

9. **タイピング練習（/typing.html、Batch 59）の既定案**（実装はこの案で入っている。変えるなら言ってもらえれば直す。docs/SPEC_TYPING.md）:
   - 日本語の題材は小・中学校の用語（社会・理科・国語・算数）だけ。日常の語（あいさつ・食べ物など）はデータに無い。足すなら教材の執筆が別に要る（BACKLOG D11）
   - ページの本文（このページについて）にだけ「広告なし」と書いた。検索の説明文には入れていない（docs/MONETIZATION.md で広告が検討の対象に残っているため）。集客のページに広告を載せる考えがあれば本文の 1 か所を消す
   - battle.html のフッターにはリンクを足していない（Battle は触らない、を HTML まで広げて読んだ）。そろえたいなら 1 行足すだけ
   - 計測の内訳は管理画面に出さず、SQL Editor で SELECT を流して見る（BACKLOG D12 で画面に出せる。SQL の変更なし）
   - 日本語の回のあとの行き先も英単語と同じ `/?from=typing`（初回は英単語の 1 冊から入る。一文で「ほかの本から始める」で社会・理科も選べると案内）。社会・理科を打ちに来た人を早く届けたいなら、日本語の回のあとだけ `/packs/` にできる
   - CI の上限は 25 分（PR #145 で main に入った。それまでは 10 分の上限で E2E が 9 分 36 秒で打ち切られていた）。main の CI の E2E は 1,175 件で約 17〜18 分、この PR の E2E は 1,236 件（足した 61 件で約 1 分増える見込み。手元の作業環境では約 20 分）

10. **判定の不具合（K0-1）の残り: ローマ字の約 400 枚**（英語の 170 枚は直して公開済み）。漢字の別解（直列回路の「直列」など）に読みが無いので、短い形を打ち切っても終わらず Enter で×になる。カードごとに「読みを足す（同等の答え）」か「別解から外す（同等でない: 慣性≠慣性の法則）」かを決めないと直らない（品質の報告書 K0-2 の型）。案: 学校のパック（中学社会・理科など。実際に×になるのは約 20 枚）から、執筆→別の目で反証の 2 段で読みを足す。残りの分野パック約 370 枚は K0-2 の承認後に

## G. 情報があると次が決まるもの

- 10 人ローンチの観察メモ（docs/LAUNCH.md のチェックリスト）。「どこで迷ったか」が 1 件あれば、それが次のバッチになる
- 受験生の指摘のような一言（別解の件はそれで 81 パック分が動いた）
- 任意: Google Search Console で `/typing.html` の表示回数と検索語（設定済みなら。コードの変更は要らない）
