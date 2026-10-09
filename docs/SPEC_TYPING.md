# タイピング練習（/typing.html）— Batch 59

> 創業者の指示（2026-10-09）: 「シンプルにタイピング練習できるようにして。そこから集客伸ばせるかもしれない。」
> 「タイピング練習」「英語 タイピング」「ローマ字 タイピング」で検索して来た人が、登録なし・設定なしで開いた瞬間に打てる 1 枚のページ。
> 1 分打ったあと、本体（訳を見て思い出して打つ Study）へ 1 本の導線でつなぐ集客の入口。**学習のモードではない**（4 モードは増やさない。docs/STATUS.md §2・§5 の例外）。
> 変えるときの基準はこの文書。設計の経緯（下調べ・反証・改訂）は Batch 59 の SPEC（scratchpad）にある。

## 1. 範囲

| 入れるもの | 中身 |
|---|---|
| ページ | `/typing.html`「タイピング練習」。無料・ログイン不要。書斎の読む机の皮（news.html と同じヘッダー・フッター・`--sheet` の札） |
| 種類 | 2 つ: 「英単語」（既定・訳つき）・「日本語（ローマ字）」（小・中学校の用語の読み） |
| 1 回 | 60 秒。最初の 1 打（または Space／Enter）で始まる。開始ボタン・カウントダウンなし |
| 見本 | 今の語 1 つ＋次の語の予告 1 つ。英単語は訳つき。日本語は用語＋かなの下に打ったキー／まだの所はローマ字の手本 |
| ミス | 数えるだけ。語は止めない。正しいキーで進む（Study の 1 ミス＝不正解とは別物） |
| 結果 | 打/分・正確さ・ミス・間違えたキー（上位 3）・自己ベスト（端末、種類ごと・秒数ごと）・もう一度・「思い出して打つ」（`/?from=typing`） |
| 入口 | 全ページのフッターの先頭（battle.html を除く 10 ページ＋packs の生成器）・お知らせ 1 件・sitemap |
| 計測 | 新しい端末だけ、`first_visit` の source に `typing`／`typing_start`／`typing_done`／`typing_study`（SQL は変えない） |

入れないもの: 学習記録への書き込み（`spelldash_word_stats`・SRS・Recall Loop・保持率・XP・連続日数・ミッション・`spelldash_typing_stats`・セッション履歴・`spelldash_key_miss`）、ランク・称号・全国ランキング、時間・語数・難しさの設定、3 つ目の種類、キーボードの図・指の色分け、進み具合の棒・カウントダウン・打っている間の速さ表示、グラフ・履歴、コンボ・効果音・BGM、はちゃん・Pro・課金・広告・通貨、結果のシェア、タブの記憶・`?kind=`、管理画面への表示（BACKLOG D9〜D16）。

## 2. 画面と状態

- 1 列・最大 720px（`.app--narrow`）。h1「タイピング練習」＋lead「英単語は訳つき。登録なし・無料。」→ タブ 2 つ（`.stats-tabs`）→ 札（`.result-card`）→「このページについて」（静的な 5 行。検索にも出す）。
- 最初の語 `apple`／`りんご` は HTML に直書き（教材が届く前から見え、打てる）。
- `#typingBoard[data-state]`: `ready`（始まる前）→ `running`（打っている間）→ `result`（結果。同じ札の中で入れ替える）。`loading`（日本語を選んだが教材が未着）・`error`（教材が取れず、次の語が無い）。
- 打っている間に Esc／ページが裏に回った（`visibilitychange`）／種類のタブ → その回は捨てて `ready`（結果・自己ベスト・計測なし）。
- 結果が出てから **0.6 秒（`RESULT_GUARD_MS`）の守り**: 画面キーボードを出したまま、結果のボタン群（もう一度・本体への札・このページについて）を `inert`、Enter／Space は無視。0.6 秒後に盤面を畳む（keyboard.js は body の class の変化でも盤面を畳むので、守りの間は `typing--live`・`romaji-answer` を外さない）。
- 英単語: 打った字＝朱、まだ＝薄墨、次の 1 字に朱の下線（`text-decoration-skip-ink: none`。g・j・p・q・y でも線が切れない）。ミスの印（次の字の下線を朱の**波線**に、背景 `--signal-soft`）は**正しいキーを打つまで残す**（時間で消さない＝点滅にしない。面だけでは地との差が 1.15:1 で見えないので形で知らせる）。
- 日本語: かなの単位を 2 段（かな／キー）。済み＝朱、今＝打った分（朱の文字）＋残りの手本、まだ＝手本。手本は各かなの最初の綴りで、打った人が別の綴り（si など）を選ぶとその後の手本も替わる。手本の ん は途中 `nn`・語末だけ `n`。っ を子音の重ねで打った直後（がっこう を gakk）は、済みの っ と今の こ に分ける（かなの行は打っている途中も読みと同じ）。単位の幅はかなとキーの広い方（`min-width: 0`）。ミスの印は今の単位ごと面と朱の細い内枠（`box-shadow: inset`。単位の大きさは変えない）＋キーの下線の波線。
- 種類の補足（「小・中学校の用語。…」）と次の語の行は、見せないときも行の高さを残す（`visibility: hidden`。種類を替えたとき・教材が届いたときに札や一文が上下しない）。読み込めない（error）ときは残り時間を出さない。
- 文言の全文と CSS は `typing.html`・`css/typing.css`。数の行は 3 行まで（打/分／正確さ・ミス・自己ベスト／間違えたキー。ミス 0 なら間違えたキーの行は出さない）。打/分だけを主の数 1 行（SD Num 36px、720 以上 44px）にする（docs/CONCEPT.md §4-7 の例外）。結果の数は `lining-nums`（Cormorant の旧式数字は 0 が o・1 が ı に見える。ほかのページの SD Num と同じ）。間違えたキーは題箋（細い枠・角 2px）、回数は数の書体。自己ベストの句は 1 かたまりで折る（`inline-block`）。
- 札の焦点の印は墨の枠（`--ink-3`）＋ `--focus` の輪（朱の枠にしない: 札が大きく、開いた直後から朱が下線と 2 か所になる）。結果では出さない。
- 読み上げ: 結果は常に DOM にある sr-only の `#typingLive`（`role="status"`）に 1 文（「312 打/分。正確さ 96%、ミス 13。」）。PC は結果の数の行（`#typingKpmLine`、`tabindex="-1"`）へ焦点。`#input`（sr-only・読み取り専用）の `aria-describedby` で今の語が読まれる。
- タッチ端末: 既存の画面キーボード（A〜Z＋⌫、日本語では ー）を使う。設定が「オフ」でも出す。Enter は CSS で隠す、英単語では 3 段目ごと隠す。ready に入ったとき札が盤面に隠れるなら札を盤面の上に寄せる（`scrollBy`）。横向き（高さ 480px 以下）は次の語・始まる前の一文を隠し、札の最小の高さを外す。タッチ端末では `#input` に焦点を当てない。

## 3. キー

document の keydown で受ける（焦点が `#input` に無くても打てる。画面キーボードの合成イベントも上がってくる）。キーは英単語も日本語も `romajiKeyOf(event)`（IME オンの `Process`・JIS かな配列・Shift つきも物理キーの位置で読む）。

| キー | ready | running | result | loading・error |
|---|---|---|---|---|
| ローマ字のキー（a-z・0-9・`-`・`'`） | 時間を測り始め、そのキーを判定 | 判定（正しい／ミス／飲む） | 何もしない | 何もしない |
| ほかの 1 文字のキー（`/` など） | 既定 | 数えない・`preventDefault` | 既定 | 既定 |
| Backspace・Delete | `preventDefault` だけ | 同左 | 何もしない | 何もしない |
| Esc | 何もしない | ready に戻す | もう一度 | 何もしない |
| Enter・Space | 時間を測り始める（判定しない） | 数えない | 0.6 秒以降なら もう一度 | 何もしない |
| Enter・Space（焦点がボタン・リンク） | 既定（押す） | 既定。ただし種類のタブ・「ご意見・不具合」の上では押させない | 既定 | 既定 |
| IME 確定の Enter（`isComposing`・`keyCode 229`）・押しっぱなし（`repeat`）・修飾キーつき | 数えない（修飾キーつきは既定のまま） | 同左 | 同左 | 同左 |

- 扱わない場所: `[aria-modal="true"]` が見えている（ご意見の窓）、対象が `#input` 以外の入力できる要素。
- 語末の ん を手本どおり n 1 つで終えたあと、nn と打つ癖の 2 つ目の n: 次の語の 1 打目として通るならそちらを先に取り、通らず 0.6 秒以内で終えた語の続きとして通るなら飲む（数えない）。**Study と順番が違う**（Study は続きの窓の中では続きが先）: 手本が語末の ん を n 1 つで見せるので、手本どおりに打つ人の次のキーを飲まないため。nn の人が損をするのは次の語が な行 で始まるときの 1 ミスだけ。

## 4. 数え方

| 名前 | 定義 |
|---|---|
| 正しい打鍵 `correct` | 判定で通ったキーの数（飲んだ続き・無視したキーは入れない） |
| ミス `miss` | 判定で通らなかったローマ字のキーの数 |
| **打/分** | `Math.round(correct × 60 ÷ 秒)`（60 秒なら correct と同じ。「打った文字数」と 1 つにまとめた。WPM という名前は使わない） |
| **正確さ** | `total > 0 ? Math.floor(correct × 100 ÷ total) : null`（切り捨て: ミスがあれば 100% にしない。null は「―」） |
| 間違えたキー | ミスのとき「打つはずだったキー」ごとの回数。多い順・同数は a→z・上位 3。`spelldash_key_miss` には書かない |

- 日本語の打/分はローマ字のキーで数える（shi は 3、si は 2）。Challenge の 打/秒（かなの数）とは定義が違うので並べない・混ぜない。
- 時間は `?t=N`（1〜60 の整数。ほかは 60）で縮められる（E2E 用。表示も「N秒」）。
- 自己ベスト: `localStorage.spelldash_typing_practice` = `{ v: 1, best: { en: { "60": { kpm, acc, day } }, ja: { … } } }`。**種類ごと・秒数ごと**（`?t=3` の 3 秒の回が 1 分の記録を壊さない）。比べるのは kpm だけ（はじめて／更新（前 N）／同じ／自己ベスト N（あと 差））。書く直前に読み直し、`best[kind][秒数]` だけ差し替える。最後まで打った回だけ保存。読めない・書けない端末では出さない。保存値の kpm が整数でない・0〜2000（`BEST_KPM_MAX`）の外なら壊れた値として無い扱い（次の結果が「はじめての記録」で上書きする）。
- 書いてよいキーは `spelldash_typing_practice` と計測（`spelldash_device_id`・`spelldash_funnel_*`）、共通のフッターの `spelldash_billing_open` だけ（E2E が見る）。storage.js・stats.js・summary.js・ui.js・game.js・wordStore.js は import しない。

## 5. 教材（data/typing.json）

- `scripts/build-typing.mjs` がパックから作る生成物（1 語 1 行、英 942 語・日 663 語、54.0KB・gzip 19.9KB）。`node scripts/build-typing.mjs` で作り直し、`--check` で生成物との一致と条件を見る（CI と E2E）。**パックの語・訳・読みを直したら作り直す**。
- 英単語: manifest の english の並び順に、自作の単語帳（`source` の無いファイル。NGSL・TSL・BSL・NAWL の CC BY-SA の「選定と順序」を持ち込まない）の語で、`/^[a-z]{3,8}$/`・`level` が easy か normal・訳が 12 字以下で「略」を含まないもの。同じ綴りは先に出た方。**群 `EXCLUDE_EN` は外す**: `ads`（広告の専門の訳のまま出る: exact=完全一致（マッチタイプ）など）・`eikenp1`・`eiken1`（haughty・obstinate が normal／easy に入っている）・`toeic860`・`toeic990`（latency=（通信の）遅延 など）。`level` はパックの中の相対の難しさなので群で外す。
- 日本語: concept の群のうち group が「小学校」「中学校」で始まるもの（15 本）の用語で、主な読みが 3〜10 かな・標準の綴り（語末の ん は n）で打ち終えられ、答えが かな・ー・・・＝ だけではないもの（用語の行とかなの行が同じ字になる）。候補は主な読み 1 つ（別解を渡すと短い読みで先に終わる）。日常の語はデータに無い（BACKLOG D11）。
- 並べ方: 1 回ごとに全語を Fisher–Yates で混ぜる。ページを開いた最初の 1 回の英単語だけ先頭を apple に固定。難しさの順にはしない。
- 読み込み: head の `<link rel="preload" as="fetch" crossorigin>` と同じ URL・CORS で `fetch("./data/typing.json")`（1 回だけ取る）。届く前に apple を打ち終えたら札に「読み込み中」（時間は止めない）。取れなければ `error`。

## 6. 入口・SEO・アプリ

- 入口: フッターの nav の先頭に「タイピング練習」（index・stats・profile・news・list・pro・privacy・terms・tokushoho・admin と packs の生成器。battle.html は Battle の凍結で触らない）。typing.html 自身は `aria-current="page"`、nav に `data-no-pro`（js/proFunnel.js がフッターの「SpellDash Pro」を出さない）。ヘッダーのナビには足さない（390〜430 幅で崩れる）。ホームの「ほかの遊び方」・初回にも足さない（5 つ目のモードに見える）。お知らせ 1 件（js/news.js）。
- SEO: title「タイピング練習（英単語・ローマ字）無料・1分 | SpellDash」、description（「登録なし」「1分」）、canonical／og:url `https://www.spelldash.net/typing.html`、本文は静的な HTML。sitemap は `scripts/build-pack-pages.mjs` の `urls`（生成物）。og:image は共通のまま（作り直しは BACKLOG D10）。
- アプリ: `scripts/build-app.mjs` の PAGES に typing.html（全ページのフッターからリンクするため）。`sw.js` の CORE_ASSETS に `/typing.html`（CACHE_NAME は上げない）。typing.html は Service Worker を登録しない（news.html・admin.html と同じ。検索から来た 1 ページ目で precache を走らせない）。
- 外部: typing のファイル・フォント・画像はすべて同一オリジン。外部への要求は、共通の js/supabase.js がページを開いたとき（モジュールの読み込み時）に読む Supabase の SDK（esm.sh）1 本だけ（ほかの静的ページと同じ。打鍵は待たない。esm.sh が止まっても打てる）。E2E は supabase.js をスタブに替えるので、この 1 本は E2E の「要求はすべて同一オリジン」には出ない。

## 7. 計測（SQL を変えない）

- 「このページから初めて来た端末」= typing.html を開いた時点で `spelldash_device_id` が無く、学習記録（`spelldash_word_stats` が空でない）も無い端末。その日を `spelldash_funnel_typing` に控える（消さない。js/funnelLog.js `markTypingArrival`。必ず `setFooterYear` の前に呼ぶ）。
- その端末だけ、`first_visit` の source に段階を入れて各 1 回（`logTypingStage`。day は**来た日**）: `typing`（開いた）・`typing_start`（最初の 1 回を打ち始めた）・`typing_done`（結果が初めて出た。1 回目を途中でやめても、後の回で結果が出れば送る。途中でやめた回では送らない）・`typing_study`（本体へのリンクを押した。端末に積み、次のページで送る）。
- 管理画面の「初めて来た」は段階ごとに端末の重複を数えないので、数は変わらない（E2E が `summarizeFunnel` で確かめる）。`entry` には入れない（加入の割合が崩れる）。見方は docs/SQL_FUNNEL.md 5（SELECT だけ）。

## 8. E2E（tests/e2e.mjs）

- 節「typing:」（「news:」の後）: 教材が生成物と同じ・英日の条件と件数、`?t=`、数え方、日本語の手本、日本語のかなの行が打っている途中も読みと同じ（っ の重ね・663 語）、語末の ん とミスの印、自己ベストの分離と読み直し（桁外れ・小数の値は無い扱い）／1200 の 1 枚（?t=5）で ready → running（ミスの波線、IME オンの Process・かな配列・変換中のキーも 1 打）→ result（数は lining）→ 自己ベスト → Esc・裏に回る・タブの Space → 日本語（補足で札が動かない）、reduced motion で動き 0、学習記録を変えない、Pro・はちゃんを出さない、要求は同一オリジン・教材 1 回、導線、教材が読めない、localStorage が投げる端末／390 mobile（設定「オフ」でも盤面・Enter と 3 段目なし・守りの 0.6 秒・ー・320 の横スクロール）・375×560 の寄せ／静的（title・canonical・description・本文、フッターの先頭（packs は全枚）、sitemap・sw・PAGES・お知らせ・ci.yml、typing.css の longhand と animation 0）。
- 節「typing funnel:」（「funnel log:」の後）: first_visit の空と typing の 2 行・typing_start・typing_done（1 回だけ）、typing_study、学習記録のある端末・ほかのページから来た端末・途中で離れた回、管理画面の数。
- 既存の節に足したもの: 「pages:」、「pages (書斎の皮)」の SKIN_PAGES、「CRM: サイトのナビから admin.html にリンクしない」、「Pro: 全 11 ページのフッターにプライバシーの直後の特商法リンク」。

## 関連

- 教材: `data/typing.json` はパックから作る生成物（`scripts/build-typing.mjs`。語・訳・読みを直したら作り直す。`EXCLUDE_EN` の群の理由は §5 と生成器の注釈）。ずれると CI（「タイピング練習の教材が最新か」）と E2E が落ちる
- キー: docs/KEYBOARD.md「タイピング練習（/typing.html）のキー」（`initializeKeyboard({ playingClass, forceOnTouch })`）
- アプリ: docs/APP.md の表（PAGES に typing.html）
- 計測: docs/SQL_FUNNEL.md 5、docs/SPEC_FUNNEL.md（first_visit は source ごとに端末で 1 回きり）
- 書斎の規則の例外: docs/CONCEPT.md §4-7（結果の打/分だけ主の数 1 行）
