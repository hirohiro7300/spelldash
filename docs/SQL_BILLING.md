# SQL: SpellDash Pro — subscriptions テーブル

> 実行は創業者側（Supabase ダッシュボード → SQL Editor）。手順の全体・環境変数・Stripe 側の設定は docs/BILLING.md。
> このテーブルが無いあいだは: `/api/billing/checkout` と `/api/billing/portal` は「行なし」として動く（加入は始められる）が、
> webhook が 500 を返して Vercel のログに `subscriptions table missing` と出る → 加入しても Pro にならない。**受付開始の前に必ず実行する。**

## 1. subscriptions — ユーザーごとの加入状態（Stripe の写し）

1 ユーザー 1 行。書くのは webhook（service role）だけ。本人は自分の行を読むだけ（RLS）。

```sql
create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text,
  status text not null default 'none',          -- Stripe の status をそのまま: active / trialing / past_due / canceled / unpaid / incomplete / incomplete_expired / none
  price_id text,
  plan_interval text,                            -- 'month' / 'year'
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  event_created bigint not null default 0,       -- 最後に反映した Stripe event の created（古いイベントの逆順到着を無視する）
  updated_at timestamptz not null default now()
);
alter table public.subscriptions enable row level security;
create policy "subscriptions_select_own" on public.subscriptions for select using (auth.uid() = user_id);
revoke all on public.subscriptions from anon, authenticated;        -- 既定で付く権限をいったん全部外す
grant select on public.subscriptions to authenticated;              -- 本人は読むだけ（行は RLS で本人のみ）
grant select, insert, update, delete on public.subscriptions to service_role;

-- PostgREST にスキーマの変更を知らせる（作った直後に API が 404 を返すとき）
notify pgrst, 'reload schema';
```

列の意味:

| 列 | 入るもの | 誰が使う |
|---|---|---|
| `status` | Stripe の subscription.status。`customer.subscription.deleted` は `canceled` | entitlement（下の式）、CRM の planStatus |
| `current_period_end` | 今の期間の終わり（更新日）。Stripe の秒を ISO に直して保存 | entitlement の猶予判定、画面の「次回の更新」 |
| `cancel_at_period_end` | 解約予定なら true（期間末まで使える） | 画面の「解約予定」 |
| `stripe_customer_id` | Stripe の顧客 id。Portal を開くのに必要 | `/api/billing/portal`、再加入時の `customer=` |
| `event_created` | 最後に反映した event の `created`。これ以下のイベントは捨てる | webhook |

**entitlement の式（サーバー `api/_lib/billing.js` の `isProRow` とクライアント `js/plan.js` が同じ式を持つ）**:
`status in ('active','trialing','past_due')` かつ（`current_period_end is null` または `current_period_end + 3 日 > now()`）。
それ以外は free。3 日の猶予は、支払い失敗の再試行（Stripe の Smart Retries）を待つため。

## 2. 確認クエリ

```sql
-- (a) RLS が有効で、本人 select のポリシーが 1 件だけあること
select relrowsecurity as rls_enabled
from pg_class where oid = 'public.subscriptions'::regclass;            -- true

select policyname, cmd
from pg_policies where schemaname = 'public' and tablename = 'subscriptions';  -- subscriptions_select_own / SELECT

-- (b) 権限: authenticated は select だけ、anon は何もできない、service_role は全部
select
  has_table_privilege('authenticated', 'public.subscriptions', 'select') as authenticated_select, -- true
  has_table_privilege('authenticated', 'public.subscriptions', 'insert') as authenticated_insert, -- false
  has_table_privilege('authenticated', 'public.subscriptions', 'update') as authenticated_update, -- false
  has_table_privilege('anon', 'public.subscriptions', 'select')          as anon_select,          -- false
  has_table_privilege('service_role', 'public.subscriptions', 'update')  as service_role_update;  -- true

-- (c) 自分の行を見る（SQL Editor は service role なので全員分が見える。user_id で絞る）
select user_id, status, plan_interval, current_period_end, cancel_at_period_end, event_created, updated_at
from public.subscriptions
where user_id = '<自分の Supabase ユーザー id>';

-- (d) Pro の人数（API の summary.pro・CRM の「Pro p」と同じ式）
select count(*) as pro
from public.subscriptions
where status in ('active', 'trialing', 'past_due')
  and (current_period_end is null or current_period_end + interval '3 days' > now());

-- (e) 支払いが滞っている人（past_due）。猶予の残りも出す
select user_id, current_period_end,
       current_period_end + interval '3 days' - now() as grace_left,
       updated_at
from public.subscriptions
where status = 'past_due'
order by current_period_end;

-- (f) 解約予定（期間末で止まる人）
select user_id, current_period_end, updated_at
from public.subscriptions
where cancel_at_period_end and status in ('active', 'trialing')
order by current_period_end;

-- (g) 状態ごとの人数
select status, count(*) from public.subscriptions group by status order by 2 desc;

-- (h) 直近に webhook が書いた行（反映の確認。updated_at が古いままなら webhook が届いていない）
select user_id, status, event_created, to_timestamp(event_created) as event_at, updated_at
from public.subscriptions
order by updated_at desc
limit 20;
```

## 3. うまくいかないとき

- 作った直後に Vercel のログへ `billing/webhook: <type> subscriptions table missing` が出続ける: PostgREST のスキーマキャッシュが古い。`notify pgrst, 'reload schema';` を実行して 1 分ほど待つ。Stripe は失敗した webhook を再送するので、届き直せば行が入る（Stripe ダッシュボード → Developers → Webhooks → 該当イベント → Resend でも可）。
- 加入したのに `(c)` に行が無い: webhook が届いていない（エンドポイント URL・`STRIPE_WEBHOOK_SECRET`・イベントの購読を確認。docs/BILLING.md の 8）。
- 行はあるのに画面が Free のまま: `status` と `current_period_end` を `(c)` で見る。式は上のとおり。クライアントは `spelldash_plan` をキャッシュするので、ログインし直すかページを開き直す。
- `(b)` で authenticated_insert が true: `revoke all on public.subscriptions from anon, authenticated;` と `grant select ... to authenticated;` を実行し直す。本人が自分の行を書けてはいけない。
- 行を手で直したいとき（返金後に止める、など）: `update public.subscriptions set status = 'canceled', updated_at = now() where user_id = '<id>';`。ただし Stripe 側で解約しないと次の請求は止まらない。原則は Stripe ダッシュボードで操作し、webhook に書かせる。
