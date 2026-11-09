# SQL: AI の 1 日の回数を全部のインスタンスで 1 つに数える（ai_usage と ai_take。Batch 88）

> 実行は創業者側（データベースの管理画面 → SQL Editor）。こちらでは流さない。**AI の鍵（`ANTHROPIC_API_KEY`）を入れる前に流す**（docs/FOUNDER_TODO.md の守り 5・7）。
> 流さなくてもアプリは壊れない: `api/_lib/shared.js` の `aiTake` は、関数が無い（404）・失敗・3 秒で答えない・数でない答えのとき、前のとおり **配信のインスタンスごとのメモリー** で数える。
> ただしメモリーで数える間は、インスタンスが増えるほど 1 人の 1 日の回数も増える（Batch 88 の調べ: 10 のインスタンスで無料の 2 回の上限が 20 回になった）。この SQL を流すと、どのインスタンスでも同じ数になる。

## 何をするか

- 表 `public.ai_usage`: 人（user_id）・種類（scope: `explain` 覚え方の解説・`cards` 場面カードの自動生成）・日（UTC）ごとの回数。本人も直接は読めない・書けない（関数だけが書く）。
- 関数 `public.ai_take(p_scope text) returns integer`: 本人のトークンで呼ぶ（`POST /rest/v1/rpc/ai_take`、本文 `{ "p_scope": "explain" }`）。今日の数を 1 つ増やして返す。数えるのは呼んだ本人（`auth.uid()`）の分だけで、ほかの人の数は増やせない。ログインしていない・知らない種類なら、とても大きい数（2147483647）を返す（API は上限を超えたとして 429 を返す）。
- 本人が関数を直接呼んでも、自分の数が増えるだけ（自分が使えなくなるだけ）。
- 上限（無料 3・Pro 60 など）はコード（`api/_lib/aiLimits.js`）が決める。表は数を持つだけ。

## 1. 表と関数を作る（何度流しても同じ）

```sql
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  scope text not null check (scope in ('explain', 'cards')),
  day date not null,
  count integer not null default 0,
  primary key (user_id, scope, day)
);
alter table public.ai_usage enable row level security;
revoke all on table public.ai_usage from anon, authenticated;

create or replace function public.ai_take(p_scope text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v integer;
begin
  if auth.uid() is null or p_scope not in ('explain', 'cards') then
    return 2147483647;
  end if;
  insert into public.ai_usage (user_id, scope, day, count)
  values (auth.uid(), p_scope, (now() at time zone 'utc')::date, 1)
  on conflict (user_id, scope, day) do update set count = public.ai_usage.count + 1
  returning count into v;
  return v;
end $$;

revoke all on function public.ai_take(text) from public, anon;
grant execute on function public.ai_take(text) to authenticated;
```

## 2. 確かめ（どれも読むだけ）

```sql
select proname, prosecdef from pg_proc where proname = 'ai_take';                          -- 1 行・prosecdef = true
select has_function_privilege('anon', 'public.ai_take(text)', 'execute') as anon_can,       -- false
       has_function_privilege('authenticated', 'public.ai_take(text)', 'execute') as auth_can; -- true
select has_table_privilege('authenticated', 'public.ai_usage', 'select') as auth_select;    -- false
select count(*) from public.ai_usage;                                                       -- 走る（0 でよい）
```

流した後に、ログインしてアプリから覚え方を 1 回作ると、`select scope, day, count from public.ai_usage order by day desc limit 5;` に 1 行が出る（自分の行。人の id は出さずに数だけ見るなら `select scope, day, sum(count) from public.ai_usage group by 1, 2 order by 2 desc;`）。

## 3. 戻し方

```sql
drop function if exists public.ai_take(text);
drop table if exists public.ai_usage;
```

戻すと、コードは前の数え方（インスタンスごとのメモリー）に戻る。アプリの画面は変わらない。

## 4. 古い行の掃除（任意・月 1 など）

```sql
delete from public.ai_usage where day < (now() at time zone 'utc')::date - 30;
```
