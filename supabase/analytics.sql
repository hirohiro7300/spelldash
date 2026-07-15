-- ============================================================
-- SpellDash KPIクエリ集（Supabase SQL Editorで実行。閲覧専用）
-- SQL Editorはpostgres権限で動くためRLSの影響を受けず全体を集計できる。
-- 正確な値は activity_days が貯まる今後のデータで出る。
-- 過去分は play_sessions / daily_scores / battle_sessions からの近似。
-- ============================================================

-- ---------- 1. DAU推移（直近30日） ----------
select day, count(distinct user_id) as dau,
       count(*) filter (where daily_done) as daily_participants,
       count(*) filter (where battle_runs > 0) as battle_participants
from public.activity_days
where day >= to_char(now() - interval '30 days', 'YYYY-MM-DD')
group by day
order by day desc;

-- ---------- 2. D1継続率（コホート別: 初回日→翌日戻ってきた率、直近14コホート） ----------
with firsts as (
  select user_id, min(day) as first_day from public.activity_days group by user_id
)
select f.first_day as cohort,
       count(*) as new_users,
       count(a.user_id) as returned_d1,
       round(100.0 * count(a.user_id) / count(*), 1) as d1_pct
from firsts f
left join public.activity_days a
  on a.user_id = f.user_id
 and a.day = to_char(f.first_day::date + 1, 'YYYY-MM-DD')
where f.first_day >= to_char(now() - interval '15 days', 'YYYY-MM-DD')
group by f.first_day
order by f.first_day desc;

-- ---------- 3. D7継続率（初回日から7日目に戻ってきた率） ----------
with firsts as (
  select user_id, min(day) as first_day from public.activity_days group by user_id
)
select f.first_day as cohort,
       count(*) as new_users,
       count(a.user_id) as returned_d7,
       round(100.0 * count(a.user_id) / count(*), 1) as d7_pct
from firsts f
left join public.activity_days a
  on a.user_id = f.user_id
 and a.day = to_char(f.first_day::date + 7, 'YYYY-MM-DD')
where f.first_day <= to_char(now() - interval '7 days', 'YYYY-MM-DD')
group by f.first_day
order by f.first_day desc
limit 14;

-- ---------- 4. Daily Dash参加率（DAUに対する完走率、直近14日） ----------
select day,
       count(*) as dau,
       count(*) filter (where daily_done) as daily_done_users,
       round(100.0 * count(*) filter (where daily_done) / count(*), 1) as daily_rate_pct
from public.activity_days
where day >= to_char(now() - interval '14 days', 'YYYY-MM-DD')
group by day
order by day desc;

-- ---------- 5. 1日平均問題数（Study自力正解の分布、直近14日） ----------
select day,
       round(avg(study_correct), 1) as avg_study_correct,
       max(study_correct) as max_study_correct,
       round(avg(challenge_runs), 2) as avg_challenge_runs
from public.activity_days
where day >= to_char(now() - interval '14 days', 'YYYY-MM-DD')
group by day
order by day desc;

-- ---------- 6. ストリーク分布（現在の連続日数。継続の健康診断） ----------
select coalesce((streak->>'current')::int, 0) as streak_days,
       count(*) as users
from public.user_progress
group by 1
order by 1;

-- ---------- 7. 離脱日数分布（最後のアクティブ日からの経過。どこで死んでいるか） ----------
with last_active as (
  select user_id, max(day) as last_day from public.activity_days group by user_id
)
select (current_date - last_day::date) as days_since_active,
       count(*) as users
from last_active
group by 1
order by 1;

-- ---------- 8. 【過去分の近似】activity_days導入前のDAU ----------
-- play_sessions(challenge/daily) ∪ battle_sessions ∪ daily_scores から復元
with events as (
  select user_id, to_char(played_at, 'YYYY-MM-DD') as day from public.play_sessions
  union
  select user_id, to_char(played_at, 'YYYY-MM-DD') from public.battle_sessions
  union
  select user_id, day from public.daily_scores
)
select day, count(distinct user_id) as approx_dau
from events
group by day
order by day desc
limit 30;

-- ---------- 9. モード別プレイ回数（何が使われているか、直近14日） ----------
select to_char(played_at, 'YYYY-MM-DD') as day, mode, count(*) as runs,
       round(avg(score), 1) as avg_score
from public.play_sessions
where played_at >= now() - interval '14 days'
group by 1, 2
order by 1 desc, 2;
