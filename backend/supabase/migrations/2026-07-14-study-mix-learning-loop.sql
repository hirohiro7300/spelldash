-- Study Mix Control ＋ New Word Learning Loop 用のカラム追加（再実行可能）

-- word_progress: 同日学習ループの状態とSRSの1日1回ゲート
-- daily_learning_date … New単語を学習中にした日（ローカル日付 YYYY-MM-DD）
-- daily_learning_stage … 同日の自力正解回数（4でToday Secured）
-- srs_advanced_on … cleanCorrectStreakを最後に進めた日（1日1回制限用）
alter table public.word_progress
  add column if not exists daily_learning_date text,
  add column if not exists daily_learning_stage integer not null default 0,
  add column if not exists srs_advanced_on text;

-- user_progress: 出題比率（回答済み割合 0〜100）
alter table public.user_progress
  add column if not exists study_familiar_ratio integer not null default 80;
