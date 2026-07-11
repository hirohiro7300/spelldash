-- Study Recall Loop用のカラム追加（既存環境向け・再実行可能）
-- last_recall_fail_at    = 最後に思い出せなかった日時
-- last_recall_success_at = 最後に自力で思い出せた日時
-- Unresolved判定: fail_at があり、success_at が無い or fail_at > success_at

alter table public.word_progress
  add column if not exists last_recall_fail_at timestamptz,
  add column if not exists last_recall_success_at timestamptz;
