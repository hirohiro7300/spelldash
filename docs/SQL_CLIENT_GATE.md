# SQL: 旧いコードの書き込みを断る門（X-Client-Info の印）

> **案だけ・未実行。流すのは創業者が明示して許したときだけ。** こちらからは流さない。データベースへの通信もしない。
> 実行は創業者側（Supabase ダッシュボード → SQL Editor と、端末からの呼び出し 1 つ）。2026-10-29 作成（Batch 78-7）。アカウント分離を公開する前に要る。

## 0. 要点

- 新しい版（アカウント分離の入った版）は、表への要求に見出し `X-Client-Info: spelldash/2 supabase-js-web/2.118.0` を付ける。js/supabase.js の `CLIENT_INFO`。ブランチ b78-7-areas の e4d22b9 から入っている。統合の木 b78-6-release には 459ca49（2026-10-30 の統合）で入った（統合の後に js/supabase.js の `CLIENT_INFO` とこの文書の印が同じことを確かめた）。
- 直前の本番 0507672 までのコードは、認証の部品の既定の印だけを送る。`spelldash/` で始まらない。0507672 は部品を版を決めずに（`@2`）読むので、形は届いた版で違う。今の部品（2.118.0 など）は `supabase-js/<版>; runtime=web`。前の部品（2.105.0 など）は `supabase-js-web/<版>`。
- 門は、書き込み（insert・update・delete）を、印の世代が 2 以上の要求だけに許す。行の権限の restrictive の方針で足す。今の許す側の方針（本人の行だけ など）はそのまま残る。読む（select）は今のまま。
- 10 個の表に 3 つずつ、計 30 個の方針と、小さな関数 1 つ。関数を先に入れ、本物の通り道で印が届くことを確かめてから、方針を入れる（§4）。何度流しても同じ。戻し方がある（§6）。
- 印は守りではない。だれでも付けられる。止めるのは、手を加えていない旧いコードだけ（§8）。

## 1. なぜ要るか

- 旧タブの証明（tests/oldtab・ブランチ b78-7-oldtab）で、次の形が見つかった。
  - 旧いタブの認証の部品が 2.107.0 より前の版だと、移行をまたいだトークンの更新の結果を、旧い鍵 `sb-<ref>-auth-token` へ A のセッションとして書き戻す。
  - その間、旧いタブは A として、移行の後の空の端末の値を A のクラウドへ送る。最高点・連続日数・Battle の数・語の回数・今日の活動が後ろへ戻る。B への漏れは 0。
- 直しの本体はクライアント側にある（新しいコードの見張りが、旧い鍵への書き戻しをその場で片付ける）。ただし、新しいコードのタブが 1 つも開いていない間は、旧いタブだけが動き続けうる。
- 門はその残りを止める 2 枚目の守り。旧いコードの書き込みは、どのタブからでもサーバーが断る。旧いタブがどの人のセッションを持っていても同じ。

## 2. 対象の表

クライアントが書く表は、main 0507672 と b78-7-areas（5f26dc7）と統合の木（459ca49 の後）で同じ 10 個（js/ の `.from(` の呼び出しを全部数えた）。許す側の方針は docs と supabase/schema.sql から読んだ。本物のデータベースと違うことがあるので、§5.1 の写しで確かめる。

| 表 | クライアントの書き込み | 今の許す側の方針（docs から） |
|---|---|---|
| profiles | insert（js/sync.js）・upsert（js/audio.js・js/profileView.js） | select・insert・update（本人）。supabase/schema.sql |
| word_progress | upsert（js/sync.js） | select・insert・update・delete（本人）。supabase/schema.sql |
| user_progress | upsert（js/sync.js） | select・insert・update（本人）。supabase/schema.sql |
| activity_days | upsert（js/sync.js） | select・insert・update（本人）。supabase/schema.sql |
| battle_sessions | insert（js/sync.js） | select・insert（本人）。supabase/schema.sql・migrations/2026-07-13 |
| play_sessions | insert（js/sync.js） | select・insert（本人）。supabase/schema.sql |
| daily_scores | insert（js/dailyRank.js） | select（全員）・insert・delete（本人）。supabase/schema.sql |
| user_items | upsert（js/userItemsSync.js） | select・insert・update・delete（本人）。docs/SQL_USER_ITEMS.md。まだ作っていないかもしれない |
| funnel_events | upsert・重複は無視（js/funnelLog.js） | insert（未ログインも。user_id は空か本人）。select は無い。docs/SQL_FUNNEL.md。まだ作っていないかもしれない。今の書き込みは門が無くても断られているおそれがある（下） |
| feedback | insert（js/feedback.js） | insert（未ログインも）。docs/SQL_FEEDBACK.md §2 の版なら本人だけ。まだ作っていないかもしれない |

- 3 つの命令を全部の表にそろえる。許す側の方針が無い命令（例 battle_sessions の update）は、もともと断られる。門を足しても変わらない。
- delete は今のクライアントが出さない。それでも断る。新しい版は印を付けるので、後で delete を使っても通る。
- 門を付けない表: subscriptions（書くのは課金の webhook の service role だけ。authenticated に書く権限が無い。docs/SQL_BILLING.md）・crm_notes（service role だけ。docs/SQL_CRM.md）。
- service role は行の権限を飛ばす。サーバーの API（api/）の書き込みはどれも service role なので、門に関係なく今のまま動く。日次の keepalive は読むだけ。
- クライアントは関数（rpc）を呼ばない。表へ書く経路は上の 10 個だけ。
- funnel_events は、この文書の外の前からの問題（統合担当へ）。js/funnelLog.js の funnel_events への upsert（統合の木で 113 行）は onConflict と ignoreDuplicates を付ける。要求は `insert … on conflict (device_id, step, source, day) do nothing` になる。衝突の先の列を名指す on conflict は、その列を読む扱いになり、select の方針が要る。docs/SQL_FUNNEL.md はわざと select の方針を作らない。反証の役が手元の使い捨てのデータベース（版 16）で試すと、門を外しても行の権限の違反（42501）で断られた。本番では確かめていない。select の方針を足すか、衝突の先を名指さない on conflict にすると通る。門はこの表の結果を変えない。

## 3. 順番（いちばん大事）

0. 創業者が明示して許す。それまで何も流さない。
1. 前提:
   - 新しい版（印を送る版）が受け入れ基準を通り、公開できる状態にある。公開する木の js/supabase.js で、`CLIENT_INFO` が `spelldash/2 ` で始まり、接続の口に渡す見出しの名前が `"X-Client-Info"`（この大文字・小文字のまま）であることを見る（§8.6）。
   - 新しい版のデプロイを先に作っておく。§4 の後は、本番へ切り替える操作だけが残る状態にする。デプロイは日次の上限に当たったことがある（docs/FOUNDER_TODO.md の A。重複のプロジェクトを先に消すと枠が空く）。
2. Supabase のプロジェクトを復旧する（docs/FOUNDER_TODO.md の A。同じプロジェクト）。今は止まっている。この時点の本番はまだ旧い版。新しいコードが無いので移行は起きず、門はまだ要らない。
3. 新しい版を公開する直前に、同じ作業の続きで:
   1. §5.1 の写しを取る。
   2. §4.1 を流す（関数だけ。まだ何も断らない）。
   3. §4.2 で、本物の通り道で印がデータベースまで届くことを見る。印ありで `true`、印なしで `false`。違えばここで止めて連絡する。方針は入れない。
   4. §4.3 を流す（方針 30 個。ここから旧い本番の同期が断られる）。
   5. §5.2〜§5.4 で確かめる。
4. 推奨: 旧い本番で断られることを 1 回見る。本番を開いてログインし、1 語答える。ブラウザの開発者ツールの通信で、`/rest/v1/word_progress` への POST が 403 か 401。要求の見出し `x-client-info` が `spelldash/` で始まらない（今の部品なら `supabase-js/<版>; runtime=web`、前の部品なら `supabase-js-web/<版>`）。
5. 新しい版を公開する（1 で作ったデプロイを本番へ切り替える）。
6. 必須: 新しい版で通ることを見る。読み直してログインし、1 語答える。`/rest/v1/` への POST が 2xx。見出し `x-client-info` が `spelldash/2 supabase-js-web/2.118.0`。2xx でなければ、すぐ §6 を流す。
   - その間は新しい版の書き込みも断られている。語の記録・ユーザーの品・Battle の履歴は端末の送信待ちに残り、戻した後の送信で送られる。XP・連続日数などは次の送信で今の値が送られる。
   - 送り直しの仕組みの無い行（Challenge の 1 回の履歴・過ぎた日の活動・Daily Dash の完走・計測）は、その間の分がクラウドに入らない。端末の記録は残る（§7）。
7. 門は残す。旧いタブ（凍った裏のタブ・開いたままの端末）は何週間も残りうる。外す日は決めない。

守ること:

- 門を入れる前に新しい版を公開しない。止まっている間に公開すると、移行は端末の中で進む。復旧した瞬間から門を入れるまでの間、旧いタブが書ける。
- §4.3 から新しい版の公開までを短くする（同じ作業の続き）。その間は旧い本番の同期が全部断られる。ログインと読むのは動く。止まっている今より悪くはない。
- 新しい版を同じ作業の間に出せない（デプロイが上限で止まった・切り替えに失敗した など）なら、§6 を流して門を外す。旧い本番の同期が戻る。出せる日に 3 からやり直す。
- 復旧が公開よりずっと前になるなら、門は公開の直前まで入れない。
- 本番を旧い版へ戻すときは、同じ時に §6 を流す。戻さないと、戻した版の書き込みが全部断られる。分離の後の端末で旧い版へ戻すこと自体の危うさは、この文書では扱わない。
- 3 つの状態の列の SQL（docs/FOUNDER_TODO.md の E）とは別。どちらを先に流してもよい。

## 4. 門の SQL（2 回に分けて流す。間に §4.2 の呼び出し）

### 4.1 関数（これだけでは何も断らない）

```sql
-- 案（未実行）。何度流しても同じ。書き込みの振る舞いは変わらない
begin;

-- 印の確かめ。表への要求の見出し x-client-info が「spelldash/<世代>」と空白（か終わり）で始まり、世代が 2 以上なら true。
-- 見出しが無い・空・形が違うなら false。SQL Editor とサーバーの API（service role）には効かない（行の権限を飛ばすため）
create or replace function public.spelldash_client_ok()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
    substring(
      (nullif(current_setting('request.headers', true), '')::json ->> 'x-client-info')
      from '^spelldash/([0-9]{1,6})(?: |$)'
    )::int >= 2,
    false
  );
$$;

grant execute on function public.spelldash_client_ok() to anon, authenticated;

commit;

-- 表への API が新しい関数をすぐ見つけるように（§4.2 で呼ぶため）
notify pgrst, 'reload schema';
```

- `nullif(…, '')` は、見出しの設定が空の文字のときに json の読み違いで落ちないため。
- 関数は公開の鍵で呼べる（§4.2 で使う）。返すのは、呼んだ要求の見出しの形が合うかだけ。表のデータは読まない。

### 4.2 本物の通り道で印が届くかを見る（§4.3 の前に必ず）

§5.4 は見出しを作って入れた試しで、ゲートウェイが見出しをデータベースまで渡すかは見ない。ここで、利用者の要求と同じ道（`/rest/v1/`・公開の鍵）で関数を呼ぶ。端末（ターミナル）の HTTP の道具で送る。表には何も書かない。

鍵は js/supabase.js の `supabaseAnonKey`（公開の鍵。ダッシュボードの Project Settings → API の anon と同じ）。

要求は 3 つ。どれも同じ URL への POST で、本文は `{}`。見出しの名前と値は字のとおりに送る（3 つで違うのは `X-Client-Info` だけ）。

```
POST https://sujvgwozsnzjsjmkcrnk.supabase.co/rest/v1/rpc/spelldash_client_ok
apikey: <公開の鍵>
Authorization: Bearer <公開の鍵>
Content-Type: application/json

{}
```

| # | `X-Client-Info` | 答え |
|---|---|---|
| 1 | `spelldash/2 supabase-js-web/2.118.0`（新しい版の印） | `true` |
| 2 | 送らない（印なし） | `false` |
| 3 | `supabase-js/2.118.0; runtime=web`（旧い本番の印。今の部品の既定） | `false` |

- 合格: 1 が `true`、2 と 3 が `false`。このときだけ §4.3 へ進む。
- 1 が `false`: 見出しがデータベースまで届いていない。§4.3 を流すと、新しい版の書き込みも全部断られる。ここで止めて連絡する。関数は残しても害は無い（外すなら §6）。
- `PGRST202`（関数が見つからない）: 表への API がまだ関数を知らない。数秒おいて `notify pgrst, 'reload schema';` を流し直し、もう一度呼ぶ。
- 401: 鍵の写し違い。
- 同じ 1 の呼び出しは、後の見張りにも使える（§8.8）。

### 4.3 書き込みの門（方針 30 個）

```sql
-- 案（未実行）。§4.2 が合格のときだけ流す。何度流しても同じ。全部が 1 つの取引で入るか、何も入らない
-- 関数が無ければ失敗して何も入らない（先に §4.1）
begin;

-- restrictive の方針。今の許す側の方針には触らない。読む（select）には付けない
do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'word_progress', 'user_progress', 'activity_days', 'battle_sessions',
    'play_sessions', 'daily_scores', 'user_items', 'funnel_events', 'feedback'
  ] loop
    if to_regclass(format('public.%I', t)) is null then
      raise notice '飛ばした: public.% が無い（作った後に、この SQL をもう一度流す）', t;
      continue;
    end if;
    execute format('drop policy if exists spelldash_gate_insert on public.%I', t);
    execute format('drop policy if exists spelldash_gate_update on public.%I', t);
    execute format('drop policy if exists spelldash_gate_delete on public.%I', t);
    execute format(
      'create policy spelldash_gate_insert on public.%I as restrictive for insert to anon, authenticated
         with check ((select public.spelldash_client_ok()))', t);
    execute format(
      'create policy spelldash_gate_update on public.%I as restrictive for update to anon, authenticated
         using ((select public.spelldash_client_ok())) with check ((select public.spelldash_client_ok()))', t);
    execute format(
      'create policy spelldash_gate_delete on public.%I as restrictive for delete to anon, authenticated
         using ((select public.spelldash_client_ok()))', t);
  end loop;
end $$;

commit;
```

- restrictive の方針は、許す側の方針と「かつ」で重なる。本人の行だけ、かつ印がある、のときだけ書ける。
- `(select …)` で包むので、関数は文ごとに 1 回だけ動く。
- 印は世代の数で比べる。次の世代（`spelldash/3`）を出しても、門を直さずに通る（§9）。

## 5. 確かめ（読むだけ。§5.4 は試しの行を必ず取り消す）

### 5.1 流す前と流した後の写し

§4.1 の前に流して、結果を CSV で残す。§4.3 の後にもう一度流して比べる。`spelldash_gate_*` の行が増えただけなら合格。ほかの行が変わっていたら止めて連絡する。

```sql
select tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('profiles', 'word_progress', 'user_progress', 'activity_days', 'battle_sessions',
                    'play_sessions', 'daily_scores', 'user_items', 'funnel_events', 'feedback')
order by tablename, policyname;
```

### 5.2 表ごとのまとめ

```sql
-- 作った表ごとに: table_exists = true・rls_on = true・gate_policies = 3・permissive_policies = 流す前と同じ数
-- rls_on が false の表があれば、門はその表に効かない。止めて連絡する（ここでは RLS を入れない。入れると今の書き込みが止まりうる）
-- まだ作っていない表は table_exists = false・gate_policies = 0
select t.name as table_name,
       c.oid is not null as table_exists,
       c.relrowsecurity as rls_on,
       count(p.policyname) filter (where p.policyname like 'spelldash_gate_%' and p.permissive = 'RESTRICTIVE') as gate_policies,
       count(p.policyname) filter (where p.permissive = 'PERMISSIVE') as permissive_policies
from unnest(array['profiles', 'word_progress', 'user_progress', 'activity_days', 'battle_sessions',
                  'play_sessions', 'daily_scores', 'user_items', 'funnel_events', 'feedback']) as t(name)
left join pg_class c on c.oid = to_regclass('public.' || t.name)
left join pg_policies p on p.schemaname = 'public' and p.tablename = t.name
group by t.name, c.oid, c.relrowsecurity
order by t.name;
```

### 5.3 門の中身

```sql
-- 表ごとに INSERT・UPDATE・DELETE の 3 行。permissive = RESTRICTIVE・roles = {anon,authenticated}
-- INSERT は with_check だけ、UPDATE は qual と with_check、DELETE は qual だけに spelldash_client_ok() が入る
select tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public' and policyname like 'spelldash_gate_%'
order by tablename, cmd;

-- 読むのには門が無い（0）
select count(*) as gate_on_reads
from pg_policies
where schemaname = 'public' and policyname like 'spelldash_gate_%' and cmd in ('SELECT', 'ALL');

-- 関数: provolatile = s（stable）・prosecdef = false（security definer でない）
select p.proname, p.provolatile, p.prosecdef, pg_get_function_result(p.oid) as returns
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'spelldash_client_ok';
```

### 5.4 振る舞いの試し（見出しを作って入れる。試しの行は残らない）

最初の利用者 1 人の id を借り、word_progress に試しの語 `spelldash-gate-probe` を作ろうとする。どの行も、その場の取り消しと最後の rollback の両方で消える。エラーが出ずに `OK` が出れば合格。`NG` で始まるエラーが出たら、その番号を控えて §6 を流す。

```sql
begin;
do $$
declare
  new_info constant text := '{"x-client-info":"spelldash/2 supabase-js-web/2.118.0"}';
  -- 旧い本番の印（今の部品の既定）
  old_info constant text := '{"x-client-info":"supabase-js/2.118.0; runtime=web"}';
  probe_word constant text := 'spelldash-gate-probe';
  probe_user uuid;
  n integer;
begin
  -- 1. 印の読み方（表に触らない）
  perform set_config('request.headers', new_info, true);
  if not public.spelldash_client_ok() then raise exception 'NG 1a: 新しい印が通らない'; end if;
  perform set_config('request.headers', '{"x-client-info":"spelldash/3 supabase-js-web/2.200.0"}', true);
  if not public.spelldash_client_ok() then raise exception 'NG 1b: 次の世代の印が通らない'; end if;
  perform set_config('request.headers', old_info, true);
  if public.spelldash_client_ok() then raise exception 'NG 1c: 旧い本番の印（今の部品）が通る'; end if;
  perform set_config('request.headers', '{"x-client-info":"spelldash/1 supabase-js-web/2.118.0"}', true);
  if public.spelldash_client_ok() then raise exception 'NG 1d: 世代 1 の印が通る'; end if;
  perform set_config('request.headers', '{}', true);
  if public.spelldash_client_ok() then raise exception 'NG 1e: 印の無い要求が通る'; end if;
  perform set_config('request.headers', '', true);
  if public.spelldash_client_ok() then raise exception 'NG 1f: 見出しの無い接続が通る'; end if;
  perform set_config('request.headers', '{"x-client-info":"supabase-js-web/2.105.0"}', true);
  if public.spelldash_client_ok() then raise exception 'NG 1g: 旧い本番の印（前の部品）が通る'; end if;

  -- 2. 本物の行の権限（word_progress）
  select id into probe_user from auth.users order by created_at limit 1;
  if probe_user is null then
    raise notice '利用者が 0 人なので 2 は飛ばした';
    return;
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', probe_user, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- 2a. 旧い印では作れない
  perform set_config('request.headers', old_info, true);
  begin
    insert into public.word_progress (user_id, word_id) values (probe_user, probe_word);
    raise exception 'NG 2a: 旧い印で行を作れた';
  exception when insufficient_privilege then
    null;
  end;

  -- 2b〜2f. 新しい印で作った行を、旧い印では書き換えも消しも upsert もできない。新しい印では書き換えられる
  begin
    perform set_config('request.headers', new_info, true);
    insert into public.word_progress (user_id, word_id) values (probe_user, probe_word);
    perform set_config('request.headers', old_info, true);
    update public.word_progress set play_count = 99 where user_id = probe_user and word_id = probe_word;
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'NG 2b: 旧い印で行を書き換えられた'; end if;
    delete from public.word_progress where user_id = probe_user and word_id = probe_word;
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'NG 2c: 旧い印で行を消せた'; end if;
    begin
      insert into public.word_progress (user_id, word_id, play_count) values (probe_user, probe_word, 5)
        on conflict (user_id, word_id) do update set play_count = excluded.play_count;
      raise exception 'NG 2d: 旧い印で既にある行へ upsert できた';
    exception when insufficient_privilege then
      null;
    end;
    perform set_config('request.headers', new_info, true);
    update public.word_progress set play_count = 1 where user_id = probe_user and word_id = probe_word;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'NG 2e: 新しい印で行を書き換えられない'; end if;
    raise exception using errcode = 'SDGT0', message = '試しの行を取り消す';
  exception
    when sqlstate 'SDGT0' then null;
    when insufficient_privilege then raise exception 'NG 2f: 新しい印で書けない（%）', sqlerrm;
  end;

  reset role;
  perform set_config('request.headers', '', true);
  perform set_config('request.jwt.claims', '', true);
  raise notice 'OK: 門は効いている';
end $$;
rollback;

-- 試しの行が残っていない（0）
select count(*) as probe_rows_left from public.word_progress where word_id = 'spelldash-gate-probe';
```

- 2a の旧い印の insert は `insufficient_privilege`（42501。行の権限の違反）で断られる。本物の要求では 403 か 401 になる。
- 2b・2c の旧い印の update・delete はエラーにならず、0 行になる（行が見えない扱い）。旧いコードは update・delete を出さない。
- 2d の upsert（旧いコードの同期の形）は、既にある行でもエラーで断られる。新しい行なら 2a と同じ。
- この試しは見出しを作って入れたもの。本物の通り道（見出しがデータベースまで届くか）は §4.2 で見る。本物の書き込みは §3 の 4 と 6 で見る。

## 6. 戻し方

門だけを外す。今の許す側の方針には触らない。データは変わらない。§4.1 だけを流して止めたときも、同じ SQL で関数だけが消える。

```sql
begin;
do $$
declare
  r record;
begin
  for r in
    select tablename, policyname from pg_policies
    where schemaname = 'public'
      and policyname in ('spelldash_gate_insert', 'spelldash_gate_update', 'spelldash_gate_delete')
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;
drop function if exists public.spelldash_client_ok();
commit;

-- 確かめ（0 と 0）。§5.1 の SELECT が、流す前の写しと同じになる
select count(*) as gate_policies_left from pg_policies where policyname like 'spelldash_gate_%';
select count(*) as gate_function_left from pg_proc where proname = 'spelldash_client_ok';
```

- 方針を先に外し、関数は後で外す。方針が残っていれば関数の削除は失敗する（取り残しに気づける）。
- 外した後は、旧いコードの書き込みもまた通る。旧いタブによる A の記録の後退（§1）を止める物は、クライアント側の片付けだけになる。

## 7. 旧いタブの利用者に見えること

- 画面と学習は今のまま動く。端末の中の記録も今のまま増える。
- クラウドへの書き込みだけが断られる（403 か 401）。旧いコードは insert と upsert だけを出すので、どれもエラーになる。旧いコードは多くの失敗を画面に出さない。だから同期が黙って止まる。
  - 語の記録（word_progress）・ユーザーの品（user_items）: 送信待ちに残る。次の送信でまた断られる。
  - XP・連続日数など（user_progress）: クラウドの値が進まない。XP の基準も進まない。
  - Battle の履歴（battle_sessions）: 送信待ちの列に残る。
  - Challenge の 1 回の履歴（play_sessions）・その日の活動（activity_days）: 送り直しの仕組みが無い。その回の行はクラウドに入らない。
  - Daily Dash の完走（daily_scores）: その日の順位に載らない。失敗の文は出ない。
  - 表示名の保存（設定）: 「保存できなかった。時間をおいてもう一度」と出る。音の設定の保存は黙って失敗する。
  - ご意見（feedback）: 端末に控え、次のページで送り直す。旧いタブのままなら断られ続ける。
  - 計測（funnel_events）: 今の書き込みは、門が無くても断られているおそれがある（§2）。門はこの結果を変えない。
- ログイン・ログアウト・トークンの更新・クラウドを読むことは今のまま動く。
- 断られた行の行き先:
  - 新しいコードをまだ開いていない端末: 旧い場所（`spelldash_*`）に残る。次にページを開くと、新しいコードが移行でその人の領域へ移し、印を付けて送る。遅れるだけ。送り直しの仕組みの無い行（上の play_sessions・activity_days の過ぎた日・daily_scores）はクラウドに入らない。端末の記録は残る。
  - 移行の後の端末の旧いタブ: 旧い場所に書いた値は、新しいコードが端末の控え（IndexedDB の orphans）へ写して消す。読まない・送らない。これは門が無くても同じ（アカウント分離の決まり）。移行の後に旧いタブでした学習は、クラウドにも新しい領域にも入らない。門が変えるのは、その旧いタブが A のクラウドを空の値で上書きすることを止める点だけ。

## 8. 限界（正直に）

1. 印は守りではない。公開の鍵と印はページの中に見える。だれでも同じ印を付けて書ける。本当の守りは、今までどおり本人の行だけの許す側の方針。門が止めるのは、手を加えていない旧いコード（0507672 まで。古いアプリ版の束が配られていれば、それも）だけ。§4.1 の関数をだれでも呼べることも、これ以上は何も明かさない。
2. 同じ人の新しいタブと旧いタブを見分けるのは印だけ。旧いコードが印を付けないことに頼る。
3. 止めるのは表への書き込み（`/rest/v1/`）だけ。認証（`/auth/v1/`）は止めない。旧いタブのトークンの更新・端末の中の書き戻し・ログイン・ログアウトは今のまま動く。止めるのは、その後の送信。
4. 読むのは止めない。旧いタブはクラウドの A の行を読んで、旧い場所へ取り込める。クラウドは変わらない。
5. service role と security definer の関数は行の権限を飛ばす。サーバーの API の書き込み（課金の webhook・管理画面のメモ）は門の外。今のクライアントは関数を呼ばない。表へ書く関数を後で足すなら、その中で `public.spelldash_client_ok()` を確かめる。
6. 新しい版が印を落とすと、その版の書き込みも全部断られる。多くは画面に出ずに失敗する。落とす形:
   - 2 つ目の接続の口を作る。
   - 認証の部品の版を上げて見出しの扱いが変わる。
   - `CLIENT_INFO` を書き替える。
   - 見出しの名前の大文字・小文字を変える。部品は既定の見出しと渡した見出しを、名前の字そのままで重ねる。js/supabase.js の `"X-Client-Info"` は既定と同じ名前なので既定を置き換え、表への POST・GET・HEAD はどれも `spelldash/2 supabase-js-web/2.118.0` だけを送る（反証の役が 2.118.0 と 2.105.0 の本物の部品で確かめた）。小文字の `x-client-info` で渡すと既定も残り、送る見出しは `supabase-js/2.118.0; runtime=web, spelldash/2 …` のように 2 つがつながる。`spelldash/` で始まらないので、門は新しい版の書き込みを全部断る。
   - 単体（scripts/test-areas.mjs の U8）は、接続の口に渡す設定を名前 `X-Client-Info` そのままで引く。名前の字を変えると落ちる。部品の中の扱いの変化は、単体でも E2E でも見えない（E2E の受け口は見出しを見ない）。本物の要求に印が載るかは §3 の 6 の目視で見る。部品の版を上げたときも同じ目視をする。
7. 門の効きは、旧タブの証明（tests/oldtab）ではまだ確かめていない。にせの受け口は見出しで断らない。§5.4 は見出しを作って入れた試し。本物の通り道（ゲートウェイが見出しをデータベースまで渡すか）は、方針を入れる前に §4.2 で見る。本物の書き込みは §3 の 4 と 6 で見る。§4.2 は関数の呼び出しで、表への書き込みではない。書き込みの道だけ見出しの扱いが違う作りなら、§3 の 6 まで気づかない（そのときは §6）。
8. 関数は、表への API が見出しを `request.headers`（小文字の名前の JSON）で渡す作りに頼る。作りが変われば関数は false を返し、書き込みが全部断られる（安全側に倒れる。利用者には黙った失敗）。§4.2 の 1 の呼び出しで気づける（`true` でなく `false` が返る）。Supabase の更新のお知らせの後や、月に 1 回などに流すとよい。日次の keepalive に足すのはコードの変更なので、ここではしない。気づいたら §6 で戻す。
9. 門は、入れた後の書き込みだけを止める。入れる前に後ろへ戻ったクラウドの記録は直さない。
10. クライアント側の直しの代わりではない。門を外せば、新しいコードのタブが 1 つも開いていない間に、旧いタブが A の記録を後ろへ戻しうる。
11. 門が入ると、移行と関係のない旧いタブ（新しいコードをまだ開いていない端末）の送信も断られる。§7 のとおり、多くは遅れるだけ。送り直しの仕組みの無い行は失う（クラウドの側だけ）。
12. 後で作った表は、§4.3 を流し直すまで門の外。
13. 費用は書き込みの文 1 つにつき関数 1 回。小さい。

## 9. 後で変えるとき

- user_items・feedback・funnel_events をまだ作っていないなら、その SQL（docs/SQL_USER_ITEMS.md・docs/SQL_FEEDBACK.md・docs/SQL_FUNNEL.md）を流した後に §4.3 をもう一度流す。§5.2 でその表が 3 になったことを見る。
- クライアントが書く表を新しく足すときは、§4.3 の表の並びと §5 の並びに足して流し直す。
- 次の世代の版（`spelldash/3`）は、門を直さずに通る。世代 2 のタブも止めたくなったら、先に世代 3 の版を公開して §3 の 6 で確かめる。その後で、関数の `>= 2` を `>= 3` に替えて、§4.1 だけを流し直す。§4.2 の呼び出しで、世代 3 の印が `true`、世代 2 の印が `false` になることを見る。
- 認証の部品の版を上げるときは、新しい版の `CLIENT_INFO` を直す。見出しの名前は `"X-Client-Info"` のまま（§8.6）。公開の後に §3 の 6 と同じ目視をする。
