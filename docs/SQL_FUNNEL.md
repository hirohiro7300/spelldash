# SQL: Pro までの動線の計測（funnel_events テーブル）

> 実行は創業者側（Supabase ダッシュボード → SQL Editor）。未作成でもアプリは壊れない（記録を送らないだけ）。設計は docs/SPEC_FUNNEL.md「計測」。

記録するのは「端末ごとのランダムな番号（`device_id`）」と「どの段階まで進んだか」だけ。メールアドレス・表示名・学習の中身は入れない。ログイン中なら `user_id` も付く（本人の行だけ書ける）。同じ端末・同じ段階・同じ入口は 1 日 1 行。

## 1. テーブル作成＋RLS（誰でも書けるが、読めるのは service role だけ）

```sql
create table if not exists public.funnel_events (
  id bigint generated always as identity primary key,
  device_id text not null check (char_length(device_id) between 8 and 64),
  user_id uuid references auth.users(id) on delete set null,
  step text not null check (step in (
    'first_visit', 'day7', 'entry', 'pro_view', 'login_click', 'login_return',
    'checkout_start', 'checkout_done', 'checkout_cancel'
  )),
  source text not null default '' check (char_length(source) <= 32),
  day date not null default ((now() at time zone 'Asia/Tokyo')::date),
  created_at timestamptz not null default now(),
  unique (device_id, step, source, day)
);

create index if not exists funnel_events_day_idx on public.funnel_events (day);

alter table public.funnel_events enable row level security;

-- 未ログインでも書ける（初めて来た人も数えるため）。ログイン中に user_id を付けるなら本人の id だけ
create policy "funnel_events_insert_anyone"
  on public.funnel_events for insert
  to anon, authenticated
  with check (user_id is null or user_id = auth.uid());

-- select ポリシーは作らない（集計は管理画面の /api/admin/funnel が service role で読む）
```

## 2. 管理画面の集計を軽くする関数（任意。行が増えてから）

管理画面は、この関数があれば数十行の集計だけを受け取る（無ければ 30 日分の行を読んで数える）。

```sql
create or replace function public.admin_funnel_counts(p_today date)
returns table (win text, step text, source text, devices bigint)
language sql stable
set search_path = public
as $$
  with w(win, back) as (values ('d7', 6), ('d30', 29))
  select w.win, e.step, ''::text, count(distinct e.device_id)
  from public.funnel_events e join w on e.day between p_today - w.back and p_today
  group by w.win, e.step
  union all
  select w.win, 'entry', e.source, count(distinct e.device_id)
  from public.funnel_events e join w on e.day between p_today - w.back and p_today
  where e.step = 'entry'
  group by w.win, e.source;
$$;

-- service role（管理画面の API）だけが呼べる
revoke all on function public.admin_funnel_counts(date) from public, anon, authenticated;
```

## 3. 確認クエリ

```sql
-- 直近 30 日、段階ごとの端末数
select step, count(distinct device_id) as devices
from public.funnel_events
where day >= ((now() at time zone 'Asia/Tokyo')::date - 29)
group by step
order by devices desc;

-- 入口（どこから加入画面へ来たか）
select source, count(distinct device_id) as devices
from public.funnel_events
where step = 'entry' and day >= ((now() at time zone 'Asia/Tokyo')::date - 29)
group by source
order by devices desc;
```

## 4. 古い行の掃除（任意。行が増えてから）

```sql
delete from public.funnel_events where day < ((now() at time zone 'Asia/Tokyo')::date - 180);
```
