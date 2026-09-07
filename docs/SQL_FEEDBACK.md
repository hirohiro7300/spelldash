# SQL: ご意見フォーム（feedback テーブル）

> 実行は創業者側（Supabase ダッシュボード → SQL Editor）。未作成でもアプリは壊れず、送信内容は端末に保持され次回接続時に再送されます。

## 1. テーブル作成＋RLS（匿名でも投稿可・閲覧はダッシュボードのみ）

```sql
create table if not exists public.feedback (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  message text not null check (char_length(message) <= 1000),
  contact text check (contact is null or char_length(contact) <= 120),
  page text,
  user_agent text,
  created_at timestamptz not null default now()
);

alter table public.feedback enable row level security;

-- 誰でも投稿できる（未ログインの10人ローンチ参加者を想定）
create policy "feedback_insert_anyone"
  on public.feedback for insert
  to anon, authenticated
  with check (true);

-- select ポリシーは作らない（閲覧は Supabase ダッシュボード / service_role のみ）
```

## 2. 荒らし対策（任意・後回し可）

匿名投稿を許可するため、量が増えたら以下のいずれかを検討:

- Supabase の Rate Limiting（API Gateway 側）
- `created_at` と `user_agent` で1分に1件の制限をトリガーで実装
- 投稿数が落ち着くまでは `anon` を外し `authenticated` のみに変更

```sql
-- ログインユーザーのみに絞る場合
drop policy if exists "feedback_insert_anyone" on public.feedback;
create policy "feedback_insert_authenticated"
  on public.feedback for insert
  to authenticated
  with check (auth.uid() = user_id);
```

## 3. 確認クエリ

```sql
select created_at, page, left(message, 80) as message, contact
from public.feedback
order by created_at desc
limit 50;
```

---

# 参考: 単語メモのクラウド同期（将来・任意）

自分のメモ（`spelldash_word_notes`）は現状端末ローカル＋バックアップのみ。端末間で同期したくなったら:

```sql
alter table public.word_progress add column if not exists note text check (note is null or char_length(note) <= 80);
```

列追加後にアプリ側で `statToRow / rowToStat` に `note` を足す（列が無い状態で送るとupsert全体が失敗するため、アプリ側の対応は列追加の後）。
