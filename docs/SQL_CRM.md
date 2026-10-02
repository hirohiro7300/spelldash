# SQL: プレイヤー管理（CRM）— crm_notes テーブルと admin_player_summary 関数

> 実行は創業者側（Supabase ダッシュボード → SQL Editor）。どちらも未作成でも管理画面は動きます。
> - `crm_notes` が無い: 一覧・詳細は見える。メモ・タグ・ピン留めの保存だけ 503 `not_configured` になり、一覧の上に案内が出る。
> - `admin_player_summary` が無い: API がテーブルを直接読んで同じ数字を出す（人数が増えて一覧が遅くなったら作る）。
>
> 画面の使い方・環境変数・エラーの意味は docs/CRM.md。

## 1. crm_notes — プレイヤーごとのメモ・タグ・ピン留め（必要になったら）

RLS を有効にし、**ポリシーは作らない**。`anon` / `authenticated` はどの行にも触れず、service role（Vercel 関数）だけが読み書きする。
プレイヤー本人にも見えない（管理者の内部メモのため）。

```sql
create table if not exists public.crm_notes (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  note       text not null default '' check (char_length(note) <= 2000),
  tags       text[] not null default '{}' check (cardinality(tags) <= 20),
  pinned     boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.crm_notes enable row level security;
-- ポリシーは作らない（service role のみ）

-- 既定権限で付いている場合に備えて、ログインユーザー・匿名からはテーブル権限も外す
revoke all on table public.crm_notes from anon, authenticated;
grant select, insert, update, delete on table public.crm_notes to service_role;
```

API（`POST /api/admin/note`）は `on_conflict=user_id` の upsert で、渡された項目（note / tags / pinned）だけを更新し `updated_at` を今にする。
タグは 1 つ 30 文字まで・最大 20 個、メモは 2000 文字まで（API 側でも検査する）。

## 2. admin_player_summary() — 一覧の集計を DB 側で 1 回にまとめる（任意）

`GET /api/admin/players` は、まず `POST /rest/v1/rpc/admin_player_summary` を試し、404（関数が無い）なら
profiles / user_progress / activity_days / word_progress を REST で全件読んで同じ値を計算する。
**どちらの経路でも返る JSON は同じ**になるよう、定義をここに固定する。

- 1 行 = 1 ユーザー（profiles / user_progress / activity_days / word_progress のどれかに行がある人）
- `p_today`: 基準日（API は JST の今日を渡す。省略時は DB 側で JST の今日）
- 直近 7 日 = `day >= p_today − 6`、直近 30 日 = `day >= p_today − 29`（`day` は `'YYYY-MM-DD'` の文字列比較）
- `last_active_day` = activity_days の最大の `day`（形式が `YYYY-MM-DD` でない行は無視）
- `words_played` = `play_count > 0` の行数、`words_mastered` = `mastered = true` の行数
- `streak_current` / `streak_best` = `user_progress.streak`（jsonb）の数値。数値でなければ 0

`security definer` で作るので、呼び出し側の RLS に関係なく全員分を集計できる。そのぶん **anon / authenticated から実行権限を外す**のが必須。

```sql
create or replace function public.admin_player_summary(p_today date default null)
returns table (
  user_id         uuid,
  display_name    text,
  xp              integer,
  level           integer,
  streak_current  integer,
  streak_best     integer,
  last_active_day text,
  active_days7    integer,
  active_days30   integer,
  study_correct30 integer,
  daily_done30    integer,
  battle_runs30   integer,
  words_played    integer,
  words_mastered  integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with bounds as (
    select
      to_char(coalesce(p_today, (now() at time zone 'Asia/Tokyo')::date) - 6,  'YYYY-MM-DD') as from7,
      to_char(coalesce(p_today, (now() at time zone 'Asia/Tokyo')::date) - 29, 'YYYY-MM-DD') as from30
  ),
  act as (
    select
      a.user_id,
      max(a.day)                                                                   as last_active_day,
      count(*)                      filter (where a.day >= b.from7)::int           as active_days7,
      count(*)                      filter (where a.day >= b.from30)::int          as active_days30,
      coalesce(sum(a.study_correct) filter (where a.day >= b.from30), 0)::int      as study_correct30,
      count(*)                      filter (where a.day >= b.from30 and a.daily_done)::int as daily_done30,
      coalesce(sum(a.battle_runs)   filter (where a.day >= b.from30), 0)::int      as battle_runs30
    from public.activity_days a
    cross join bounds b
    where a.day ~ '^\d{4}-\d{2}-\d{2}$'
    group by a.user_id
  ),
  words as (
    select
      w.user_id,
      count(*) filter (where w.play_count > 0)::int as words_played,
      count(*) filter (where w.mastered)::int       as words_mastered
    from public.word_progress w
    group by w.user_id
  ),
  ids as (
    select user_id from public.profiles
    union
    select user_id from public.user_progress
    union
    select user_id from act
    union
    select user_id from words
  )
  select
    i.user_id,
    p.display_name,
    coalesce(up.xp, 0),
    coalesce(up.level, 1),
    case when jsonb_typeof(up.streak -> 'current') = 'number' then round((up.streak ->> 'current')::numeric)::int else 0 end,
    case when jsonb_typeof(up.streak -> 'best')    = 'number' then round((up.streak ->> 'best')::numeric)::int    else 0 end,
    act.last_active_day,
    coalesce(act.active_days7, 0),
    coalesce(act.active_days30, 0),
    coalesce(act.study_correct30, 0),
    coalesce(act.daily_done30, 0),
    coalesce(act.battle_runs30, 0),
    coalesce(words.words_played, 0),
    coalesce(words.words_mastered, 0)
  from ids i
  left join public.profiles      p  on p.user_id  = i.user_id
  left join public.user_progress up on up.user_id = i.user_id
  left join act                     on act.user_id = i.user_id
  left join words                   on words.user_id = i.user_id
  order by i.user_id;
$$;

-- service role だけが呼べるようにする（Postgres の既定では public に execute が付くため、必ず外す）
revoke all on function public.admin_player_summary(date) from public;
revoke all on function public.admin_player_summary(date) from anon, authenticated;
grant execute on function public.admin_player_summary(date) to service_role;
```

関数を作り直したいときは同じ文を再実行する（`create or replace`）。やめるときは
`drop function public.admin_player_summary(date);` — API は自動で REST 集計に戻る。

## 3. 確認クエリ

```sql
-- (a) crm_notes: RLS が有効で、ポリシーが 0 件であること
select relrowsecurity as rls_enabled
from pg_class where oid = 'public.crm_notes'::regclass;            -- true

select count(*) as policies
from pg_policies where schemaname = 'public' and tablename = 'crm_notes';  -- 0

-- (b) crm_notes: ログインユーザー・匿名にテーブル権限が無いこと（すべて false）
select
  has_table_privilege('anon', 'public.crm_notes', 'select')          as anon_select,
  has_table_privilege('authenticated', 'public.crm_notes', 'select') as authenticated_select,
  has_table_privilege('authenticated', 'public.crm_notes', 'insert') as authenticated_insert;

-- (c) 関数: anon / authenticated は実行できず、service_role だけができること
select
  has_function_privilege('anon', 'public.admin_player_summary(date)', 'execute')          as anon_can,      -- false
  has_function_privilege('authenticated', 'public.admin_player_summary(date)', 'execute') as authenticated_can, -- false
  has_function_privilege('service_role', 'public.admin_player_summary(date)', 'execute')  as service_role_can;  -- true

-- (d) 関数の結果を目で見る（基準日を固定すると API の today と突き合わせやすい）
select *
from public.admin_player_summary('2026-10-02')
order by last_active_day desc nulls last
limit 20;

-- (e) セグメント別の人数（API の summary.bySegment と同じ定義。
--     ただし関数はデータが 1 行も無い人を返さないので、「登録しただけ」の人は API の dormant より少なく出る）
with s as (select * from public.admin_player_summary()),
     d as (select (now() at time zone 'Asia/Tokyo')::date as today)
select
  case
    when s.last_active_day is null then 'dormant'
    when d.today - s.last_active_day::date <= 7  then 'active'
    when d.today - s.last_active_day::date <= 21 then 'atRisk'
    else 'churned'
  end as segment,
  count(*)
from s cross join d
group by 1
order by 1;

-- (f) メモの一覧
select user_id, left(note, 40) as note, tags, pinned, updated_at
from public.crm_notes
order by pinned desc, updated_at desc;
```

## 4. うまくいかないとき

- 関数を作ったのに API がまだ REST 集計のまま（Vercel のログに `admin/rpc` の警告が無く、遅いまま）: PostgREST のスキーマキャッシュが古い。`notify pgrst, 'reload schema';` を実行して 1 分ほど待つ。
- Vercel のログに `admin/rpc admin_player_summary: <HTTP 状態> 42501 (fallback to REST)` と出る: 実行権限が無い。上の `grant execute ... to service_role` を実行する。
- `admin/rpc admin_player_summary: <HTTP 状態> 42P01 (fallback to REST)`: 関数が参照するテーブル（activity_days など）が無い。supabase/schema.sql を先に実行する。
- `crm_notes` を作ったのにメモ保存が 503 のまま: スキーマキャッシュ（上と同じ `notify`）。それでも直らなければ (a)(b) の確認クエリでテーブル名の綴りを確かめる。
