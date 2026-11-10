# SQL: 自分のデータの端末間同期（user_items テーブル）

> 実行は創業者側（Supabase ダッシュボード → SQL Editor）。未作成でもアプリは壊れず、これまで通り端末ローカルで動きます。
> 作成すると、ログイン中のユーザーの **マイ単語帳（自分のカード）／単語メモ／追加した分野パック／日ごとの記録（今日のぶん・成長ログ）** が端末間で同期されます。
>
> **すでに 1. を流してある場合**: `day` を足すため、下の「1b. kind に day を足す」の 2 文を 1 回だけ流してください（流すまで `day` の行は送信に失敗し、日ごとの記録だけが端末ローカルのままになります。他は動きます）。

## 何が同期されるか

| kind | key | payload | 元の localStorage |
|---|---|---|---|
| `my_word` | 英単語 or 場面カードのキー | カードの内容そのもの | `spelldash_my_words` |
| `note` | 単語 id | `{ "text": "覚え方" }` | `spelldash_word_notes` |
| `pack` | パック id | `{ "enabled": true }` | `spelldash_packs` |
| `day` | 日付 `YYYY-MM-DD` | `{ "learned": 180, "mastered": 40, "active": true, "set": true, "sets": 2 }` | `spelldash_growth_log` の同じ日の行＋`spelldash_daily_set`（history・setsToday） |

- 項目ごとに `updated_at` が新しい方が勝つ。削除は `deleted = true` の行（墓標）で他端末に伝わる
- `day` だけは値で合わせる: learned・mastered・sets は大きい方、active・set はどちらかが true なら true。送る前にクラウドの同じ日の行を読んで合わせてから書くので、同じ日に 2 台で学んでも巻き戻らない（読めなかった日は送らずに次回へ回す）。削除は無い（120 日より古い日は端末に持たない）
- 送信タイミングは学習記録と同じ（Challenge終了・Studyで10語ごと・ページ離脱・ログイン直後のマージ）
- 未ログインの人は何も送らない（Local First）
- 送る写しの字は整える（Batch 85）: この表が受け付けない字（NUL と組になっていないサロゲート）だけを 1 字ずつ U+FFFD に替える（ほかの字は前のまま送る）。1 字でも入ると同じ要求の行がどれも断られるため（端末の保存は書き換えない）。鍵にその字がある項目（Batch 85 より前のとても古いデータだけ）は送らない。行の中身で断られた組は半分ずつ送り直し、1 行だけで断られた行は、その行が変わるか 1 日たつまで送らない（docs/SPEC_MY_WORDS.md §14.3）。表の形と kind は変えない（流す文は無い）
- 読み方（Batch 87）: 1 回の読みの答えには行の上限がある（管理画面の Max Rows。既定 1,000）ので、(kind, key) で並べて 1,000 行ずつ、全部の行の数に届くまで読む（学習記録の word_progress も word_id で並べて同じ）。1 ページでも読めなければ、その回は合わせず送り返さない（次の同期で読み直す）。取り込みで送れた行と取り込んだ行は送る待ちから外す。Max Rows は 1,000 より小さくしない（値が何でも全部読めるが、小さくすると要求の数が増える）（docs/SPEC_MY_WORDS.md §16.1・§16.2）。表の形と kind は変えない（流す文は無い）

## 1. テーブル作成＋RLS（本人だけが読み書き）

```sql
create table if not exists public.user_items (
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('my_word', 'note', 'pack', 'day')),
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

## 1b. kind に day を足す（1. を以前の版で流してある人だけ・1 回）

```sql
alter table public.user_items drop constraint if exists user_items_kind_check;
alter table public.user_items add constraint user_items_kind_check check (kind in ('my_word', 'note', 'pack', 'day'));
```

（制約名は 1. の書き方で Postgres が付ける既定の名前。違う名前で作った場合は、SQL Editor で `select conname from pg_constraint where conrelid = 'public.user_items'::regclass and contype = 'c';` を流して確かめ、置き換える）

## 2. 確認クエリ

```sql
select kind, count(*) filter (where not deleted) as live, count(*) filter (where deleted) as tombstones
from public.user_items
group by kind;
```

## 3. 墓標と古い日の行の掃除（任意・月1など。4 の 1 人 5,000 行に近づかないように）

```sql
delete from public.user_items where deleted and updated_at < now() - interval '90 days';
```

日ごとの記録（`day`）は消す印を使わず、1 日 1 行ずつ増える。端末は 120 日より古い日を読み込まない（js/userItemsSync.js）ので、400 日より古い日の行は消してよい:

```sql
delete from public.user_items where kind = 'day' and key < to_char(now() - interval '400 days', 'YYYY-MM-DD');
```

## 4. 1 行の大きさと 1 人の行の数の上限（Batch 88・docs/FOUNDER_TODO.md の守り 8。任意だが 1 人目の前に勧める）

本人のトークンで書ける表なので、上限が無いと 1 人が巨大な行や大量の行を書いて、データベースの容量と費用を使える（端末の決まり〔100／1,000 語・字数〕は端末の中だけで、直接書けば通る）。
上限はプランに関係ない量の上限（無料の 100 語は端末の決まりのまま。docs/FOUNDER_TODO.md の決めてほしいことの 17）:

| 上限 | 値 | 今の端末が書く最大（目安） |
|---|---|---|
| 1 行の中身（`payload`）: `my_word` | 4,096 バイト | 語 約 1,000 バイト（英語 150 字・訳 150 字）・前の場面カード 約 1,500〜2,300 バイト |
| 1 行の中身: `note`・`pack`・`day` | 512 バイト | メモ 約 250 バイト（80 字）・日 約 80 バイト・パック 17 バイト |
| 鍵（`key`） | 256 バイト | 183 バイト（英語 150 字 + 印） |
| 1 人の行（消した印も数える） | 5,000 行 | 語 1,000 行 + 消した印 + メモ + パック + 日（1 日 1 行） |
| 1 人の消していない語（`my_word`） | 1,000 行 | Pro の上限と同じ |

- 消していない語の数は、新しい鍵を入れるときだけでなく、書き直し（`update` と upsert の書き直し）で語が増える形でも数える: 消した語（`deleted = true`）を戻す・ほかの kind の行を語に替える。前の案は新しい鍵の `insert` だけを数えたので、消した語として 1,000 を超えて入れてから `deleted = false` に書き直すと上限を越えられた。
- 消した印（`deleted = true` の行）の中身は空（`{}`）にして保存する。読む側（js/userItemsSync.js）は消した印の中身を見ない。
- 同じ人の同時の書き込みは 1 つずつ数える（取引の間だけの印 `pg_advisory_xact_lock`）。印が無いと、同時に送った要求どうしがお互いの行を数えず、上限を越えられる。
- 1 人が上限まで書いたときの大きさ（行の頭と索引を含めた目安）: 語 1,000 行 × 約 4.8 KB ＋ ほかの行 4,000 行 × 約 1.2 KB ＝ **約 10 MB**。無料のプランのデータベースの容量（500 MB）の 2% で、埋めるには上限まで書いたアカウントが 50 ほど要る（前の案〔1 行 8,192 バイト・1 人 20,000 行〕は 1 人 約 164 MB で、3 人で埋まった）。アカウントを多く作れば上限は越えられるので、守り 14 の量の見張り（1 人だけ桁が違う行の数・週の行の急な増え方）と、データベースの使用量の知らせも入れる。埋めた人がいたら、その人の認証のユーザーを消す（行は `on delete cascade` で消える）。
- 長く使う人が 5,000 行に近づかないように、3 の掃除（消した印と古い日の行）を月 1 回ほど流す。届いたら、その人の新しい鍵の行だけが断られる（今ある行の書き直しは通る・端末のデータは消えない）。

断られた行は 400（check_violation）で返り、端末は Batch 85 の形でその行だけ 1 日待つ（ほかの行の同期は止まらない・端末のデータは消えない）。

**先に、今のデータが上限の内かを見る**（読むだけ）。どれかが越えていたら流さずに知らせる:

```sql
select
  (select coalesce(max(octet_length(payload::text)), 0) from public.user_items where kind = 'my_word' and not deleted) as max_word_payload_bytes,   -- 4096 以下
  (select coalesce(max(octet_length(payload::text)), 0) from public.user_items where kind <> 'my_word' and not deleted) as max_other_payload_bytes, -- 512 以下
  (select coalesce(max(octet_length(key)), 0) from public.user_items) as max_key_bytes,                                                          -- 256 以下
  (select coalesce(max(c), 0) from (select count(*) c from public.user_items group by user_id) s) as max_rows_per_user,                          -- 5000 未満
  (select coalesce(max(c), 0) from (select count(*) c from public.user_items where kind = 'my_word' and not deleted group by user_id) s) as max_live_words_per_user; -- 1000 以下
```

内なら（何度流しても同じ。前の版の 4 を流してあっても、この 2 文がそのまま置き換える）:

```sql
create or replace function public.user_items_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  became_live_word boolean;
begin
  -- 消した印は中身を持たない（読む側は消した印の中身を見ない）
  if new.deleted then
    new.payload := '{}'::jsonb;
  end if;
  if octet_length(new.key) > 256 then
    raise exception 'user_items key too long' using errcode = 'check_violation';
  end if;
  if octet_length(new.payload::text) > (case when new.kind = 'my_word' then 4096 else 512 end) then
    raise exception 'user_items payload too large' using errcode = 'check_violation';
  end if;
  -- 同じ人の書き込みを 1 つずつ数える（取引が終わると外れる）
  perform pg_advisory_xact_lock(hashtextextended('user_items_guard:' || new.user_id::text, 0));
  if tg_op = 'INSERT' then
    -- 今ある鍵への upsert は、続く書き直し（UPDATE の側）で数える
    if exists (select 1 from public.user_items where user_id = new.user_id and kind = new.kind and key = new.key) then
      return new;
    end if;
    if (select count(*) from (select 1 from public.user_items where user_id = new.user_id limit 5000) s) >= 5000 then
      raise exception 'user_items too many rows' using errcode = 'check_violation';
    end if;
    became_live_word := new.kind = 'my_word' and not new.deleted;
  else
    -- 書き直しで消していない語が増える形（消した語を戻す・ほかの kind から語へ）
    became_live_word := new.kind = 'my_word' and not new.deleted and not (old.kind = 'my_word' and not old.deleted);
  end if;
  if became_live_word and (
    select count(*) from (select 1 from public.user_items where user_id = new.user_id and kind = 'my_word' and not deleted limit 1000) s
  ) >= 1000 then
    raise exception 'user_items too many words' using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists user_items_guard on public.user_items;
create trigger user_items_guard before insert or update on public.user_items
  for each row execute function public.user_items_guard();
```

確かめ（読むだけ）:

```sql
select tgname from pg_trigger where tgrelid = 'public.user_items'::regclass and not tgisinternal;   -- user_items_guard の 1 行
select position('became_live_word' in prosrc) > 0 as counts_updates, position('pg_advisory_xact_lock' in prosrc) > 0 as one_at_a_time
from pg_proc where proname = 'user_items_guard';                                                       -- どちらも true（前の案のままなら false）
```

戻し方:

```sql
drop trigger if exists user_items_guard on public.user_items;
drop function if exists public.user_items_guard();
```
