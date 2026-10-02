# プレイヤー管理（CRM）

> 創業者だけが開ける管理画面。URL は `/admin.html`（サイトのナビからはリンクしない。検索エンジンにも出さない）。
> 誰が、どれだけ、いつまで使っていて、誰が離れかけているかを見て、プレイヤーごとにメモとタグを残す。
> SQL は docs/SQL_CRM.md。API の実装は `api/_lib/admin.js`、`api/admin/*.js`。

## 1. 何であり、何でないか

できること

- 一覧: 全プレイヤーのセグメント、最終活動、7 日・30 日の活動日数、覚えた語、連続日数、レベル、タグ
- 絞り込み（セグメントのチップ）、検索（email・表示名・タグの部分一致）、並び替え。ピン留めは常に先頭
- 詳細パネル: 登録日・最終ログイン、30 日の活動、直近のプレイ、追加している分野、最近覚えた語、ご意見フォームの投稿
- メモ・タグ・ピン留めの保存（docs/SQL_CRM.md の `crm_notes` を作ってから）
- CSV のダウンロード（ブラウザ内で作る）

しないこと（創業者の規則）

- プレイヤーへの通知・メール・プッシュ。CRM からプレイヤーには何も届かない
- 課金、ゲームの新モード、Battle の変更
- 外部サービスへの送信。データは Supabase と Vercel の外に出ない

## 2. 有効にする手順

1. Supabase ダッシュボード → Project Settings → API → **service_role** の key を控える。
   これは全テーブルを RLS 抜きで読めるキー。クライアント・リポジトリ・チャット・ログに置かない。
2. Vercel → Project → Settings → Environment Variables に次を追加（Production と Preview）:

   | 変数 | 値 | 必須 |
   |---|---|---|
   | `SUPABASE_SERVICE_ROLE_KEY` | 1 で控えた key | 必須 |
   | `ADMIN_EMAILS` | 管理者のメールアドレス（カンマ区切り。大文字小文字は区別しない） | `ADMIN_USER_IDS` が無ければ必須 |
   | `ADMIN_USER_IDS` | 管理者の Supabase ユーザー id（カンマ区切り） | 任意 |

   `SUPABASE_URL` / `SUPABASE_ANON_KEY` は `api/_lib/shared.js` の既定値が使われる（別プロジェクトなら上書き）。
3. Redeploy する（環境変数は次のデプロイから効く）。
4. `/admin.html` を開き、右上からいつもどおりログインする（ログインの仕組みは他のページと同じ）。
   `ADMIN_EMAILS` に入っているアカウントなら一覧が出る。
5. 任意: docs/SQL_CRM.md の SQL を Supabase の SQL Editor で実行する。
   - `crm_notes` — メモ・タグ・ピン留めを保存できるようになる
   - `admin_player_summary()` — 人数が増えて一覧が遅くなったら。API が自動で使う

無効にするには `SUPABASE_SERVICE_ROLE_KEY` か `ADMIN_EMAILS`（と `ADMIN_USER_IDS`）を消して Redeploy する。API は 503 を返し、誰にも開けなくなる。

## 3. セグメントの定義

基準日 `today` はサーバーの JST の日付（応答の `today`）。`lastActiveDay` は activity_days の最新の日（プレイヤーの端末の日付、`YYYY-MM-DD`）。

| セグメント | 画面の文言 | 条件 |
|---|---|---|
| `active` | 活動中 | `today − lastActiveDay` が 0〜7 日 |
| `atRisk` | 離れかけ | 8〜21 日 |
| `churned` | 離脱 | 22 日以上 |
| `dormant` | 登録のみ | 一度も活動していない（`lastActiveDay` が無い） |

- 「新規」（`isNew`）: 登録日（`createdAt` を JST の日付にしたもの）が `today` から 7 日以内。セグメントとは独立
- 端末の時差で `lastActiveDay` が `today` より先の日付になることがある。その場合も「活動中」
- 活動は Study・Challenge・Daily・Battle のどれでも 1 日 1 行（activity_days）。ログインしただけでは活動にならない

## 4. 一覧の列

| 列 | 意味 | 元のデータ |
|---|---|---|
| プレイヤー | 表示名。その下に email | profiles.display_name / Supabase Auth |
| セグメント | 上の 4 区分。新規なら「新規」のチップ | 計算 |
| 最終活動 | 今日・昨日・N日前・まだ無し | activity_days の最新の日 |
| 7日 / 30日 | 直近 7 日・30 日のうち活動した日数（今日を含む） | activity_days |
| 覚えた語 | `mastered = true` の語数（`wordsMastered`）。`wordsPlayed` は 1 回でも出た語数 | word_progress |
| 連続 | 現在の連続日数（`streakCurrent`）。`streakBest` は最長 | user_progress.streak |
| Lv | レベル（`level`）。`xp` も応答にある | user_progress |
| タグ | 管理者が付けたタグ | crm_notes |

応答にだけある項目: `studyCorrect30`（30 日の Study 自力正解数）、`dailyDone30`（30 日の Daily 完走日数）、`battleRuns30`、`packs`（追加している分野パックの id）、`feedbackCount`（ご意見フォームの投稿数）、`lastSignInAt`（最終ログイン。活動とは別）、`note`、`pinned`。

要約行: 「全 N ・ 活動中 a ・ 離れかけ b ・ 離脱 c ・ 登録のみ d ・ 今週の新規 e」。`summary.total` は Supabase Auth の全ユーザー数（データが 1 行も無い人も数える）。

## 5. 詳細パネル

| 項目 | 内容 | 件数・期間 |
|---|---|---|
| 見出し | 表示名・email・登録日・最終ログイン・セグメント | |
| 30 日の活動 | 1 日 1 本の縦棒。高さは Study の自力正解数 | `activityDays` は直近 90 日（日付降順）。棒は直近 30 日ぶん |
| 直近のプレイ | Challenge（`playSessions`）・Daily（`dailyScores`）・Battle（`battleSessions`）を日時順に | 各 10 件 |
| 追加している分野 | user_items の kind=pack（削除済みを除く） | 全件 |
| 最近覚えた語 | `recentMastered`（word_id と覚えた日時） | mastered_at 降順 20 件 |
| ご意見 | feedback テーブルのその人の投稿（本文・連絡先・ページ・日時） | 全件（新しい順） |

`battleSessions` の 1 件: `opponentType, opponentName, category, result, playerScore, opponentScore, rpChange, correctCount, durationSeconds, playedAt`。

## 6. メモとタグ

- メモは 2000 文字まで。タグは 1 つ 30 文字まで・最大 20 個（前後の空白は落とし、重複は 1 つにする）。ピン留めは一覧の先頭に固定するだけ
- 保存は `POST /api/admin/note`。渡した項目だけが更新される（メモだけ直してもタグは消えない）
- 保存先は `crm_notes`（docs/SQL_CRM.md）。テーブルが無いあいだは保存ボタンが 503 の案内を出す。一覧・詳細はそのまま使える
- メモはプレイヤー本人には見えない（本人のアカウントからは読めないテーブル）。個人の評価や推測ではなく、事実と次の一手を書く

## 7. CSV

`#adminExport` でダウンロード。列: `email, displayName, segment, lastActiveDay, activeDays7, activeDays30, wordsMastered, streakCurrent, level, tags, note`。
ブラウザの中で文字列を組み立てて `spelldash-players-YYYY-MM-DD.csv` として保存するだけで、サーバーにも外部にも送らない。
BOM 付き UTF-8（Excel で文字化けしない）。値はダブルクォートでくくり、`=` `+` `-` `@` で始まる値には `'` を前置する（表計算ソフトの数式として実行されないため）。

CSV には email が入る。保存先と共有相手に気をつける（第 9 節）。

## 8. データの取り方と性能

- ユーザーの一覧は Supabase Auth の admin API（`/auth/v1/admin/users`、1000 人ずつ全ページ）
- テーブルは PostgREST を `Range` ヘッダで 1000 行ずつ全件読む（既定の上限が 1000 行のため。Max Rows の設定は既定のまま）
- 一覧はまず RPC `admin_player_summary` を試し、無ければ profiles / user_progress / activity_days / word_progress を全件読んで同じ値を計算する。
  word_progress は「ユーザー数 × 語数」なので、プレイヤーが増えると REST 集計が数秒かかるようになる。そうなったら docs/SQL_CRM.md の関数を作る（API の変更は不要）。
  `api/admin/players.js` の maxDuration は 30 秒（vercel.json）
- `feedback` / `user_items` / `crm_notes` は未作成でもよい。PostgREST の 404、または SQLSTATE 42P01 を「テーブルが無い」と見なし、空として扱って応答の `missing[]` に名前を入れる

## 9. プライバシーとセキュリティ

- email は PII。管理者（`ADMIN_EMAILS` / `ADMIN_USER_IDS`）にだけ返す。サーバーのログには書かない（ログに出るのは状態コードと SQLSTATE だけ）
- service role key はサーバー（Vercel 関数）の環境変数にだけ置く。クライアントに渡さず、応答にも含めない。Supabase からのエラー本文も応答には出さない（502 の詳細はサーバーログのみ）
- データは Supabase と Vercel の外に出ない。CRM は外部サービスを呼ばない。CSV はブラウザ内で作る
- `/api/admin/*` は Web からだけ使う。アプリ（Capacitor の WebView）由来の Origin にも CORS を許可しない。応答は常に `Cache-Control: no-store`。サイトの Service Worker（sw.js）は `/api/` を保存しないので、プレイヤーのメールが端末のキャッシュに残らない
- メールでの管理者判定は、そのメールが Supabase 側で確認済みのときだけ有効。より強く縛りたければ `ADMIN_USER_IDS`（Supabase の Authentication → Users に出る UUID）を使う
- `admin.html` は `noindex, nofollow`、`robots.txt` で `Disallow`、sitemap に載せない。URL を知っていてもログインと管理者判定を通らなければ何も返らない
- 管理者を減らすときは `ADMIN_EMAILS` から外して Redeploy。service role key が漏れた疑いがあるときは Supabase 側で key をローテーションし、Vercel の変数を差し替える

## 10. トラブルシューティング

| 画面の表示 | API | 原因 | 直し方 |
|---|---|---|---|
| ログインしてください。右上からログインできます。 | 401 `login_required` | 未ログイン、またはセッション切れ | 右上からログインし直す |
| このアカウントには権限がありません。 | 403 `forbidden` | ログインした email が `ADMIN_EMAILS` に無い（id も `ADMIN_USER_IDS` に無い） | 綴り・大文字小文字・余分な空白を確かめる。別アカウントでログインしていないか確かめる。変えたら Redeploy |
| 管理画面はまだ設定されていません…（docs/CRM.md） | 503 `not_configured` | `SUPABASE_SERVICE_ROLE_KEY` が無い、または `ADMIN_EMAILS` と `ADMIN_USER_IDS` が両方無い | 第 2 節の環境変数を入れて Redeploy |
| 取得できませんでした。 | 502 `upstream` ／ 504 ／ 応答なし | Supabase からエラー（キーが違う、プロジェクトが停止中、テーブルが無い など）、関数のタイムアウト（30 秒）、通信断 | Vercel のログの `admin/players: upstream <table> <status> <SQLSTATE>` を見る。401/403 なら key が service_role か確かめる。42P01 なら supabase/schema.sql を実行する |
| 一覧の上に「メモとタグを保存するには docs/SQL_CRM.md のテーブルが必要です」 | 200（`missing` に `crm_notes`） | `crm_notes` が未作成 | docs/SQL_CRM.md の 1 を実行する。一覧はそのまま使える |
| 保存ボタンで「…crm_notes テーブルが必要です（手順: docs/SQL_CRM.md）」 | 503 `not_configured` | 同上 | 同上。作った直後なら `notify pgrst, 'reload schema';` |
| 保存で「該当するプレイヤーがいません」 | 404 `not_found` | そのユーザーが削除済み | 一覧を再取得する |
| 保存で「メモは 2000 文字までです」など | 400 `bad_request` | 長さ・個数の上限 | 第 6 節の上限に収める |
| 詳細が開かない | 404 `not_found` / 400 `bad_request` | ユーザーが削除済み / userId が UUID でない | 一覧を再取得する |
| ご意見が「まだ無し」、分野が空 | 200（`missing` に `feedback` / `user_items`） | テーブルが未作成 | docs/SQL_FEEDBACK.md / docs/SQL_USER_ITEMS.md。無くても他は動く |
| 数字が SQL Editor の集計と合わない | | `today` が JST、活動日はプレイヤーの端末日付、`summary.total` は Auth の全ユーザー数 | docs/SQL_CRM.md の確認クエリ (d)(e) で突き合わせる |

## 11. API 契約（開発者向け）

すべて `/api/admin/*`、`Authorization: Bearer <Supabase access token>` 必須、JSON、`Cache-Control: no-store`。
確認の順は 設定（503）→ ログイン（401）→ 権限（403）。

| エンドポイント | 応答 |
|---|---|
| `GET /api/admin/players` | `tests/fixtures/admin-players.json` と同じ形（`generatedAt, today, missing[], summary{total, bySegment{active,atRisk,churned,dormant}, newThisWeek}, players[]`） |
| `GET /api/admin/player?userId=<uuid>` | `tests/fixtures/admin-player.json` と同じ形。無ければ 404 |
| `POST /api/admin/note` `{ userId, note?, tags?, pinned? }` | `{ ok: true, note, tags, pinned }` |

エラーの形は `{ "error": "<code>", "message": "<日本語の短文>" }`。code: `login_required`(401) / `forbidden`(403) / `not_configured`(503) / `method_not_allowed`(405) / `bad_request`(400) / `not_found`(404) / `upstream`(502)。

ネットワーク無しでの確認: `fetch` を差し替えて Supabase の缶詰応答を返す小さな Node スクリプトで、401/403/503/200、`Range` の全件取得、セグメント計算、RPC 有無で同じ JSON になること、userId の検査を確かめる（E2E は `npm test` の「admin crm:」）。
