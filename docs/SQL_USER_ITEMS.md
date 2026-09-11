# SQL: 自分のデータの端末間同期（user_items テーブル）

> 実行は創業者側（Supabase ダッシュボード → SQL Editor）。未作成でもアプリは壊れず、これまで通り端末ローカルで動きます。
> 作成すると、ログイン中のユーザーの **マイ単語帳（自分のカード）／単語メモ／追加した分野パック** が端末間で同期されます。

## 何が同期されるか

| kind | key | payload | 元の localStorage |
|---|---|---|---|
| `my_word` | 英単語 or 場面カードのキー | カードの内容そのもの | `spelldash_my_words` |
| `note` | 単語 id | `{ "text": "覚え方" }` | `spelldash_word_notes` |
| `pack` | パック id | `{ "enabled": true }` | `spelldash_packs` |

- 項目ごとに `updated_at` が新しい方が勝つ。削除は `deleted = true` の行（墓標）で他端末に伝わる
- 送信タイミングは学習記録と同じ（Challenge終了・Studyで10語ごと・ページ離脱・ログイン直後のマージ）
- 未ログインの人は何も送らない（Local First）

## 1. テーブル作成＋RLS（本人だけが読み書き）

```sql
create table if not exists public.user_items (
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('my_word', 'note', 'pack')),
  key text not null check (char_length(key) <= 200),
  payload jsonb not null default '{}'::jsonb,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, key)
);

alter table public.user_items enable row level security;

create policy "user_items_select_own" on public.user_items
  for select using (auth.uid() = user_id);
create policy "user_items_insert_own" on public.user_items
  for insert with check (auth.uid() = user_id);
create policy "user_items_update_own" on public.user_items
  for update using (auth.uid() = user_id);
create policy "user_items_delete_own" on public.user_items
  for delete using (auth.uid() = user_id);

grant select, insert, update, delete on public.user_items to authenticated;

create index if not exists user_items_updated_idx
  on public.user_items (user_id, updated_at);
```

## 2. 確認クエリ

```sql
select kind, count(*) filter (where not deleted) as live, count(*) filter (where deleted) as tombstones
from public.user_items
group by kind;
```

## 3. 墓標の掃除（任意・月1など）

```sql
delete from public.user_items where deleted and updated_at < now() - interval '90 days';
```
