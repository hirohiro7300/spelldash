# SQL: Pro までの動線の計測（funnel_events テーブル）

> 実行は創業者側（Supabase ダッシュボード → SQL Editor）。未作成でもアプリは壊れない（記録を送らないだけ）。設計は docs/SPEC_FUNNEL.md「計測」。

記録するのは「端末ごとのランダムな番号（`device_id`）」と「どの段階まで進んだか」だけ。メールアドレス・表示名・学習の中身は入れない。ログイン中なら `user_id` も付く（本人の行だけ書ける）。同じ端末・同じ段階・同じ入口は 1 日 1 行。

## 1. テーブル作成＋RLS（誰でも書けるが、読めるのは service role だけ）

```sql
create table if not exists public.funnel_events (
  id bigint generated always as identity primary key,
  device_id text not null check (char_length(device_id) between 8 and 64),
  user_id uuid references auth.users(id) on delete set null,
  step text not null check (step in (
    'first_visit', 'day7', 'entry', 'pro_view', 'login_click', 'login_return',
    'checkout_start', 'checkout_done', 'checkout_cancel'
  )),
  source text not null default '' check (char_length(source) <= 32),
  day date not null default ((now() at time zone 'Asia/Tokyo')::date),
  created_at timestamptz not null default now(),
  unique (device_id, step, source, day)
);

create index if not exists funnel_events_day_idx on public.funnel_events (day);

alter table public.funnel_events enable row level security;

-- 未ログインでも書ける（初めて来た人も数えるため）。ログイン中に user_id を付けるなら本人の id だけ
create policy "funnel_events_insert_anyone"
  on public.funnel_events for insert
  to anon, authenticated
  with check (user_id is null or user_id = auth.uid());

-- select ポリシーは作らない（集計は管理画面の /api/admin/funnel が service role で読む）
```

## 2. 管理画面の集計を軽くする関数（任意。行が増えてから）

管理画面は、この関数があれば数十行の集計だけを受け取る（無ければ 30 日分の行を読んで数える）。入口の行は source が空なら other にまとめる（段階の合計の行は source が空）。以前の版を流してあれば、同じ文をもう一度流すと置き換わる。

```sql
create or replace function public.admin_funnel_counts(p_today date)
returns table (win text, step text, source text, devices bigint)
language sql stable
set search_path = public
as $$
  with w(win, back) as (values ('d7', 6), ('d30', 29))
  select w.win, e.step, ''::text, count(distinct e.device_id)
  from public.funnel_events e join w on e.day between p_today - w.back and p_today
  group by w.win, e.step
  union all
  select w.win, 'entry', coalesce(nullif(e.source, ''), 'other'), count(distinct e.device_id)
  from public.funnel_events e join w on e.day between p_today - w.back and p_today
  where e.step = 'entry'
  group by w.win, coalesce(nullif(e.source, ''), 'other');
$$;

-- service role（管理画面の API）だけが呼べる
revoke all on function public.admin_funnel_counts(date) from public, anon, authenticated;
```

## 3. 確認クエリ

```sql
-- 直近 30 日、段階ごとの端末数
select step, count(distinct device_id) as devices
from public.funnel_events
where day >= ((now() at time zone 'Asia/Tokyo')::date - 29)
group by step
order by devices desc;

-- 入口（どこから加入画面へ来たか）
select source, count(distinct device_id) as devices
from public.funnel_events
where step = 'entry' and day >= ((now() at time zone 'Asia/Tokyo')::date - 29)
group by source
order by devices desc;
```

## 4. 古い行の掃除（任意。行が増えてから）

```sql
delete from public.funnel_events where day < ((now() at time zone 'Asia/Tokyo')::date - 180);
```

## 5. タイピング練習から来た端末（SQL の変更なし。Batch 59、docs/SPEC_TYPING.md §7）

`/typing.html` から**初めて来た端末だけ**（開いた時点で端末の番号 `spelldash_device_id` が無く、学習記録も無い）、`first_visit` の `source` に段階を入れて各 1 回送る。`day` は**来た日**（あとで打ち始めても、その行の日は来た日。30 日の窓で「初めて来た」に入る日がずれない）。テーブル・check・RPC・管理画面は変えない。

| source | 意味 |
|---|---|
| `typing` | タイピング練習を開いた（送れるまで開くたびに試す） |
| `typing_start` | 最初の 1 回を打ち始めた |
| `typing_done` | 結果が初めて出た（1 回目を途中でやめても、後の回で結果が出れば送る。打っている途中でやめた・ページを離れた回では送らない）。長文は最後まで打った回だけ（Esc・「やめる」の途中までの結果では送らない） |
| `typing_study` | 「思い出して打つ」か本文の本体へのリンクを押した（端末に積み、次のページで送る） |
| `typing_game` | タイピング練習から初めて来た端末が、タイピングゲーム（/typing-game.html）を開いた（typing.html → ゲームの導線。Batch 60） |
| `typing_long` | タイピング練習から初めて来た端末が、長文のタブを初めて押した（Batch 62。docs/SPEC_TYPING.md §9.7） |
| `typing_long_start` | その端末が長文を初めて打ち始めた（最初に判定したキー） |
| `typing_long_done` | その端末が長文を初めて最後まで打った（途中までの結果では送らない） |

タイピングゲーム（`/typing-game.html`、Batch 60、docs/SPEC_TYPING_GAME.md §7）から**初めて来た端末**も同じ仕組みで、鍵を分けて（`spelldash_funnel_tgame`）送る。1 端末に付く印は最初の 1 ページ分だけ（番号が無いときにしか印は付かないので、typing と tgame は混ざらない）。

| source | 意味 |
|---|---|
| `tgame` | タイピングゲームを開いた（送れるまで開くたびに試す） |
| `tgame_start` | 最初の 1 回を打ち始めた |
| `tgame_done` | 結果が初めて出た（途中でやめた回では送らない） |
| `tgame_study` | 「思い出して打つ」か本文の本体へのリンクを押した（`/?from=tgame`。端末に積み、次のページで送る） |

- `funnel_events.source` の `typing*` は**段階**で、docs/SPEC_ACQUISITION.md（DESIGN ONLY・未実装）が設計している流入元（UTM の source）とは別物。
- 管理画面の段階の数（RPC も行を読む経路も）は段階ごとに端末の重複を数えないので、`first_visit` の数は変わらない（typing の行を送る端末は、必ず source が空の first_visit も送る）。1 端末に first_visit が最大 9 行になる（typing の族: 空＋typing・typing_start・typing_done・typing_study＋typing_game＋長文の typing_long・typing_long_start・typing_long_done。tgame の族は 空＋4 = 5 行。source が空の行が「初めて来た」端末の数）。`typing_start` は長文の回も入る（どの種類でも最初の回を打ち始めた）。
- 既存の端末・ほかのページから来た端末は送らない。回数・既存の人の利用は数えない。

```sql
-- タイピング練習から初めて来た端末の段階（直近 30 日。端末の数）
select source, count(distinct device_id) as devices
from public.funnel_events
where step = 'first_visit' and source like 'typing%'
  and day >= ((now() at time zone 'Asia/Tokyo')::date - 29)
group by source
order by devices desc;

-- そのうち 7 日以上学んだ端末
select count(distinct f.device_id) as devices
from public.funnel_events f
join public.funnel_events d on d.device_id = f.device_id and d.step = 'day7'
where f.step = 'first_visit' and f.source = 'typing';

-- タイピングゲームから初めて来た端末の段階（直近 30 日。端末の数）。typing と同じ週で並べる
select source, count(distinct device_id) as devices
from public.funnel_events
where step = 'first_visit' and (source like 'tgame%' or source = 'typing_game')
  and day >= ((now() at time zone 'Asia/Tokyo')::date - 29)
group by source
order by devices desc;
```

- タイピングゲームの割合: tgame_start ÷ tgame（開いてすぐ打てたか）、tgame_done ÷ tgame_start（90 秒もったか）、tgame_study ÷ tgame_done（本体への導線）、day7 ÷ tgame_study、typing_game ÷ typing（1 分のドリル → ゲームの導線）。コースの内訳・目標に届いた割合・流れた率は取れない（要るなら step を足す SQL が先）。
- 見る割合: typing_start ÷ typing（すぐ打てたか）、typing_done ÷ typing_start（1 分を打ち切るところまで行ったか。最初の回とは限らない）、typing_study ÷ typing_done（導線が効いたか）、day7 ÷ typing_study（学習になったか）。
- 長文の割合: typing_long ÷ typing（来た人のうち長文を選ぶ割合。専用ページを作るかの材料）、typing_long_start ÷ typing_long（選んだが打たない＝題や長さが合わない）、typing_long_done ÷ typing_long_start（低ければ短めをさらに短く）。`typing_long_start` が 50 件ほど貯まるまで決めない（docs/FOUNDER_TODO.md F-13）。上の `like 'typing%'` の SELECT がそのまま拾う。文章ごと・言語ごとの内訳は取れない（要るなら step を足す SQL が先）。
- **分母の `typing` には検索エンジンの描画（ボット）が混ざりうる**（JS を動かして描画し、新しい端末として送るなら typing_start ÷ typing が実際より低く出る。書き込みまで行うかは未確認）。比は 1 回の値でなく**週ごとの推移**で見る。ボットを除く仕組みは v1 では入れない（BACKLOG D16）。
- 取れないもの: 既存の端末が使った数・1 台の回数・日ごとの回数。要るなら check に段階（例 `typing_view`）を足す SQL が先（check に無い段階を先に送ると表が断り、送り直し続ける。**SQL より先にコードを入れない**）。来た数の全体・検索語は Google Search Console のページ別。
