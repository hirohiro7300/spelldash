-- Battle Preseason（CPUランクマッチ）用のDB変更。再実行可能。

-- ===== user_progress にBattle戦績カラムを追加 =====
alter table public.user_progress
  add column if not exists battle_rp integer not null default 0,
  add column if not exists battle_wins integer not null default 0,
  add column if not exists battle_losses integer not null default 0,
  add column if not exists battle_draws integer not null default 0,
  add column if not exists battle_current_win_streak integer not null default 0,
  add column if not exists battle_best_win_streak integer not null default 0;

-- ===== battle_sessions: 試合履歴（将来のGhost Match再生用タイムライン含む） =====
create table if not exists public.battle_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  opponent_type text not null,
  opponent_name text,
  category text,
  duration_seconds integer,
  result text not null,
  player_score integer not null default 0,
  opponent_score integer not null default 0,
  rp_before integer,
  rp_change integer,
  rp_after integer,
  correct_count integer not null default 0,
  typing_miss integer not null default 0,
  recall_fail integer not null default 0,
  accuracy numeric,
  event_timeline jsonb,
  difficulty_profile jsonb,
  played_at timestamptz not null default now()
);

alter table public.battle_sessions enable row level security;

-- 本人のみ閲覧・追加（Ghost Matchの公開範囲は将来別途設計）
drop policy if exists "battle_sessions_select_own" on public.battle_sessions;
create policy "battle_sessions_select_own" on public.battle_sessions
  for select using (auth.uid() = user_id);

drop policy if exists "battle_sessions_insert_own" on public.battle_sessions;
create policy "battle_sessions_insert_own" on public.battle_sessions
  for insert with check (auth.uid() = user_id);

grant select, insert on public.battle_sessions to authenticated;

create index if not exists battle_sessions_user_idx
  on public.battle_sessions (user_id, played_at desc);
