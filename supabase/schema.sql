-- SpellDash Knowledge Database schema (2026-07-11)
-- Supabase SQL Editor で実行する。すべてRLS有効・本人のみアクセス可能。

-- ===== profiles: ユーザー設定 =====
create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  avatar_url text,
  audio_mode text not null default 'auto',      -- auto / manual / off
  preferred_accent text not null default 'us',  -- us / uk
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = user_id);
create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = user_id);
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = user_id);

-- ===== word_progress: 単語ごとの学習記録 =====
create table if not exists public.word_progress (
  user_id uuid not null references auth.users (id) on delete cascade,
  word_id text not null,
  play_count integer not null default 0,
  correct_count integer not null default 0,
  typing_miss integer not null default 0,
  recall_fail integer not null default 0,
  clean_correct_streak integer not null default 0,
  mastered boolean not null default false,
  mastered_at timestamptz,
  last_played timestamptz,
  next_review_at timestamptz,
  last_recall_fail_at timestamptz,     -- 最後に思い出せなかった日時（Recall Loop）
  last_recall_success_at timestamptz,  -- 最後に自力で思い出せた日時（Recall Loop）
  updated_at timestamptz not null default now(),
  primary key (user_id, word_id)
);

alter table public.word_progress enable row level security;

create policy "word_progress_select_own" on public.word_progress
  for select using (auth.uid() = user_id);
create policy "word_progress_insert_own" on public.word_progress
  for insert with check (auth.uid() = user_id);
create policy "word_progress_update_own" on public.word_progress
  for update using (auth.uid() = user_id);
create policy "word_progress_delete_own" on public.word_progress
  for delete using (auth.uid() = user_id);

-- ===== user_progress: 全体の進捗（XP・レベル・ストリーク等） =====
create table if not exists public.user_progress (
  user_id uuid primary key references auth.users (id) on delete cascade,
  xp integer not null default 0,
  level integer not null default 1,
  streak jsonb,                       -- {last, current, best}
  best_score integer not null default 0,
  selected_category text,
  selected_mode text,
  updated_at timestamptz not null default now()
);

alter table public.user_progress enable row level security;

create policy "user_progress_select_own" on public.user_progress
  for select using (auth.uid() = user_id);
create policy "user_progress_insert_own" on public.user_progress
  for insert with check (auth.uid() = user_id);
create policy "user_progress_update_own" on public.user_progress
  for update using (auth.uid() = user_id);

-- ===== play_sessions: プレイ履歴（Challenge終了ごと） =====
create table if not exists public.play_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  mode text not null,
  score integer not null default 0,
  typing_speed real,
  typing_miss integer not null default 0,
  recall_fail integer not null default 0,
  duration_seconds real,
  played_at timestamptz not null default now()
);

alter table public.play_sessions enable row level security;

create policy "play_sessions_select_own" on public.play_sessions
  for select using (auth.uid() = user_id);
create policy "play_sessions_insert_own" on public.play_sessions
  for insert with check (auth.uid() = user_id);

-- 復習期限での検索用（将来のミッション/統計クエリ向け）
create index if not exists word_progress_review_idx
  on public.word_progress (user_id, next_review_at);

-- ===== テーブル権限（GRANT） =====
-- RLSは「行」を守るが、テーブル自体へのアクセス権は別途必要。
-- ログインユーザー（authenticated）にのみ付与する。
grant usage on schema public to authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select, insert, update, delete on public.word_progress to authenticated;
grant select, insert, update on public.user_progress to authenticated;
grant select, insert on public.play_sessions to authenticated;
