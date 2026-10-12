# 単語ごとの習熟度と Study の 60 秒 — 仕様（Batch 63）

> 確定版（2026-10-12）。**段階 1 は実装済み**（§2 の A〜K1。§11 に実装で決めたこと）。**段階 2（§6 の S1〜S5）はまだ**。創業者の指示（2026-10-11）:「習熟度ランクがあってもいいと思うんだよね。りんごをappleって言えない人っていないじゃん？ど忘れでもないものやん。その単語に対してどれぐらいの記憶認識しているのかを可視化できるようにしたい。60秒間のタイム制はやっぱり学習モードでもあった方がよくて、その時点での各単語の習熟度を出すべきだと思うんだよね。」
> 学習の本体（Study ほか）の話として扱う。集客の /typing.html・/typing-game.html は触らない（別の作業）。
> 起草は 2026-10-12。3 つの案（学習科学・体験・最小）を採点して学習科学の案を土台に選び（付録 C）、同日 3 つの視点（段の論理・60 秒の回と画面と E2E・創業者の指示）の反証を受けて改訂した（付録 D）。
> 文中の行番号は実装前の木（d079352）のもの。実装後の場所は関数名で引く。
> 進め方: **段階 1（PR 1）** = §2 の A〜K1。**段階 2（PR 2）** = §6 の SRS とのつなぎ S1〜S5（段階 1 のマージ後、E2E 全件と保持率の節が通ってから）。**2〜4 週後** に §3.8 の集計で仮の値を見直す。

## 0. 要点

1. 習熟度は**単語ごとの段**。5 段: まだ／あやふや／思い出せる／身についた／即答。未着手は段に数えない。利用者側に出すのは段ごとの語数まで。
2. 段を決める記録は重い順に **正誤 → 前の答えからの日数（× の日から数える）→ 速さ**。速さは「即答」と「初見の身についた」を決めるときだけ使う。
3. 段が**上がる**のは**その日の最初の答えだけ**（前の答えから 6 時間未満は日付をまたいでも同じ日の扱い）で、1 日 1 段。**下がる**のはその日の最初の ×（○ の後でも）で 1 段。飛ぶのは直前に見ていない答え（初めての答え・知ってた語の 2 週間後の最初の確認）だけ。
4. 速さは**出題から最初のキーまで（T1）**を**本人の中央値**（答えの種類 × 入力 × Study／遊びの 8 つの箱、20 件たまってから）と比べる。たまるまでは、**初めての答えに限り**、入力ごとの既定の線（物理キーボード 1.5 秒・画面キーボード 2.1 秒。英語の綴りだけ）で「すぐ」だけを決める。秒数は画面に出さない。
5. 60 秒は**今日のセットの長さ**の選び方の 1 つ（10語／15語／25語／60秒）。入口・出題・記録は Study のまま。回の種類と長さは始めるときに 1 度だけ決める。スコア・ベスト・BGM・赤い秒読みは持たない。時間切れの語は × にしない。
6. 60 秒の終わりは完了パネルの形で、**答えた語を段ごとの語チップ**に並べ、「初めて」「上がった」「下がった」「時間がかかった」を文字で付ける。
7. 単語帳・語の詳細・学習データ・語数のセットの完了パネル・Challenge／Daily の結果に同じ物差しを出す。語の詳細では、段の名前に**その語の事実**（いつ・何日あけて思い出せたか）と**次の段の条件**を添える。段ごとの決まり文句で経緯を言わない。常に 0/10 だった記憶ゲージは外す。
8. 記録は word_stats に**端末だけの欄 2 つ**（`masteryRank`・`masteryAt`）と別キー `spelldash_mastery_meta` 1 つ。schema 6 のまま、SQL は要らない。
9. 期日前の身についた以上の語と、2 週間後の確認を待つ知ってた語は、補充・ミッション・息抜きに出さない（S6、**段階 1**）。段階 2 で間隔とつなぐ（正解で期日を早めない・日をあけた正解は間隔を伸ばす・身についた 7 日／即答 30 日の下限）。apple が 106 日までに出る回数は、今の 10 回＋期日を見ない補充から、段階 1 で 10 回（補充なし）、段階 2 で 5 回になる（Challenge・Daily・Battle で答えなければ）。予定どおり続ける人の間隔は今と同じ。

---

## 1. 指示の読み方

| 原文 | 読み | 根拠 |
|---|---|---|
| 習熟度ランクがあってもいい | **単語ごとの段**を足す。人のランクは作らない | 3 文目「その単語に対して」、4 文目「各単語の習熟度」が語を指す。人の段はもう 2 つある（レベルの称号、Battle のランク）。級・学年の見立ては DECISIONS_V4_1 §5 に触れる |
| りんごをappleって言えない人っていない。ど忘れでもない | 記憶には「言えない／ど忘れ（たまに出ない）／考えずに出る」の段がある。今のアプリはこれを分けず、apple を何度も出す | 今の apple: 知ってた → 14 日後の確認のあと段 2（2 日後）から上り直し、習得まで 10 回出る（stats.js:47-76）。補充の既習 8 割は期日を見ない（studyQueue.js:305）。1 打ミスで streak 0・苦手（stats.js:139-141）。SRS の段では apple も「1/10」 |
| どれぐらいの記憶認識しているのかを可視化 | 語の記憶の強さを、事実の記録から段で、どの画面でも同じ物差しで見せる | 今の記憶ゲージは苦手の語だけに出て常に 0/10（listView.js:380）。語の強さを表すものが画面ごとに違う |
| 60秒間のタイム制は学習モードでも | Study に 60 秒で区切る回を**足す**（今日のセットの長さに 60 秒）。Study を 60 秒に置き換えない | 「学習モードで**も**」。語数のセット・約5分・続きから・チュートリアルを残す。Challenge を学習のモードにする読みは「も」と合わない |
| その時点での各単語の習熟度を出す | 60 秒が終わった時点の、答えた語それぞれの今の段と、この回での変化を出す | 「その時点」= 終わりのスナップショット。段は上がりも下がりもする |

- 前半と後半のつながり: 60 秒は区切り、段は終わりの見せ方。加えて「考えずに出る」を最上段「即答」の条件にし、そこだけ速さを使う。段 1〜4 は正誤と日数だけで決まる（初見の身についただけ速さを使う）ので、速さを測れない答え・端末でも段は成り立つ。
- 「りんご→apple」に初日から応える: 使い始めの人は本人の基準がまだ無い。そこで初めての答えに限り、考えずに出た答えだけが入る既定の線で「すぐ」を決め、初見で身についたに置く（§3.4）。
- 採らない読み: 利用者のランク・推定語彙数、Study そのものを 60 秒にする、時間を見せるだけ。

## 2. 範囲

### 入れるもの

| # | もの | 段階 | 主な場所 |
|---|---|---|---|
| A | 段の規則（純関数）・答えの文脈・古い記録からの初期値・語ごとの根拠と次の条件の文 | 1 | 新 js/mastery.js |
| B | 段の書き込み（既存の書き手の中で。答える前の stat を `recordCorrect` の頭で控える） | 1 | js/stats.js |
| C | 1 問ごとの速さの計測、本人の基準と既定の線、段の確かめ用の集計 | 1 | js/game.js、新 js/masteryMeta.js |
| D | 60 秒の回（今日のセットの長さ。回の種類と長さを始めに決める） | 1 | js/dailySet.js・js/game.js・js/tutorial.js・profile.html・index.html・js/main.js・js/profileView.js・js/pathView.js・js/hasumi.js |
| E | 60 秒の終わりのパネル（段ごとの語チップ） | 1 | js/game.js・css/card.css |
| F | 単語帳・語の詳細・学習データ・CSV の段 | 1 | js/listView.js・js/wordDetail.js・js/statsView.js・js/exportCsv.js・css/brand.css・css/pages.css |
| G | 語数のセットの完了パネルと Challenge／Daily の結果に「段が動いた語」 | 1 | js/game.js |
| H | 盤面の 1 行の文（知ってた・日をあけた正解） | 1 | js/game.js `applyStudyXp` |
| I | 事実と合わない文の直し 3 件と小さな不具合 2 件（§5.10） | 1 | game.js・wordDetail.js・myWordsView.js・stats.js・studyQueue.js |
| J | 段階 1 の E2E・単体・docs | 1 | tests/e2e.mjs・scripts/test-mastery.mjs・docs |
| K1 | 期日前の強い語と確認待ちの知ってた語を補充・ミッション・息抜きに出さない（S6） | 1 | js/studyQueue.js・js/mission.js |
| K | SRS の間隔とのつなぎ S1〜S5 | 2 | js/stats.js |

### 入れないもの

人のランク・総合点・推定語彙数・級の見立て／語ごとの「記憶率 ○%」などの予測の数字／時間がたつと黙って下がる段／段と XP・レベル・称号・解放のつなぎ（段が上がっても XP は増えない）／判定の変更（1 ミス＝不正解のまま）／習得（streak 10）と「覚えた N語」の定義の変更／Battle のコード（battleEngine.js は触らない）／タイピングの 2 ページ／道（机の本）・ホームへの段の表示／打つ前・打っている間の段の表示／段の推移のグラフ・段の絞り込み・並べ替え／ランキング・公開・通知・Pro／新しい SQL／60 秒の回の新出の数の制限（Study のキューのまま）／下がる前の段への早戻り（Q4 の代案。既定では入れない）。

## 3. 習熟度

### 3.1 段の数・名前・説明

見出しの語は創業者の語「習熟度」。裸の「ランク」、英字の段名、星は使わない（Battle のランク・称号と紛れる）。名前は語の状態を言い、本人の実力とは言わない。

| 段 | 名前 | 画面の短い説明 `RANK_GLOSS`（入り方によらず真。学習データの行にだけ出す） | 入る条件（仕様用。§3.5） |
|---|---|---|---|
| 0 | （出さない） | — | 答えの記録が無い（出題だけの語も 0） |
| 1 | まだ | 思い出せなかったまま | 初めての答えが ×／2 からその日の最初の × で下がった |
| 2 | あやふや | 思い出せたが、確かではない | まだ の語を自力で思い出せた（同じ日でも）／打ち間違いを含む自力正解（Battle）／3 からその日の最初の × で下がった |
| 3 | 思い出せる | 間違えずに思い出せた | 前の答えから 1 日以上（6 時間以上）あけたノーミス正解（2 から）／初めての答えのノーミス正解（速さが「すぐ」でない）／4 から × で下がった |
| 4 | 身についた | 6日以上あけて思い出せた（初めてで、すぐ打てた語も） | 前の答えから 6 日以上あけたノーミス正解（3 から）／初めての答えでノーミス・すぐ／知ってた語の最初の確認（14 日以上）でノーミス／5 から下がった |
| 5 | 即答 | 2週間以上あけて、すぐ打てた | 前の答えから 20 日以上あけて、本人の基準よりすぐ打てたノーミス正解（4 から）／知ってた語の最初の確認（14 日以上）ですぐ |

- `RANK_GLOSS` は入り方のどれを通っても真になる文だけにした（例: 段 3 は初見のノーミス正解でも入るので「日をあけて」と言わない。段 4 は初見ですぐ打てた語でも入るので括弧で添える）。下がって入った語は、その段の上り口を過去に通っている（段 3 から下がった語の 2 の文「思い出せたが」、5 から下がった語の 4 の文「6日以上あけて」はどちらも過去の事実）。
- 段ごとの決まり文句は語の詳細に出さない。語の詳細は、その語の事実から作る `rankBasis` と次の段の条件 `rankNext` を出す（§5.2）。
- 規則の文 `RANK_RULE`（学習データの注記と、語の詳細の畳んだ「習熟度の決まり」。§5.2・§5.3）: 「日をあけて間違えずに思い出せると 1 段上がる（1 日に 1 段まで）。身についた には前の答えから 6日、即答 には 20日あけて すぐ打てることが要る。初めて答えて間違えずに打てた語は 思い出せる（すぐなら 身についた）から始まり、2週間後の確認で すぐ打てると 即答。思い出せなかった日は 1 段下がる。時間がたつだけでは下がらない。」
- 既存の語とぶつけない: 「定着」（保持率の 7 日窓・今日定着）・「覚えた」（ホームの数・題箋）・「習得」（streak 10）・「苦手」（最後が ×）・「知ってた」は段の名前に使わない。段 2 は「覚え」の字を含む名前を避けた（題箋「覚えた」と同じカードに並ぶため）。状態の題箋（未着手／苦手／覚えた／習得／知ってた）はそのまま残す（題箋は「何が起きたか」、段は「どれだけ強いか」。並びの理由は語の詳細の根拠の文で分かる）。
- UI の文の「初見」は「初めて」にそろえる（チップの「初めて」、詳細の「初めて答えて…」）。仕様の地の文では「初見」も使う。
- 定数（js/mastery.js）: `RANK_NAMES = ["", "まだ", "あやふや", "思い出せる", "身についた", "即答"]`、`RANK_GLOSS`（上の表）、`RANK_RULE`。名前は 1 か所だけに置き、各画面はここを呼ぶ。

### 3.2 見た目（色だけに頼らない）

```html
<span class="rank" data-rank="4" role="img" aria-label="習熟度 身についた（5段のうち4）"><i></i><i></i><i></i><i></i><i></i><span class="rank__name">身についた</span></span>
```

- `rankHtml(rank, { name = true, label = "習熟度 ", title = "" } = {})` が返す。段 0 は空文字。分数・「/10」の文字は出さない。見出しに「習熟度」がある所（語の詳細・学習データ）は `label: ""` で、読み上げで「習熟度」が 2 回続かないようにする。`title` は単語帳のカードで根拠の文（`rankBasis`）を渡す（マウスで見られる補足。読み上げは `aria-label` の 1 文のまま）。
- 目盛り 5 つ: 幅 5px、高さは左から 6／8／10／12／14px（並びの向きを形でも伝える）、間 2px、下揃え、角 1px。塗りは `--ink-3`、空きは `--line-2` の 1px の枠。塗りは CSS だけ（`.rank[data-rank="4"] i:nth-child(-n+4)` のように 5 行）。インラインの style は使わない。
- `.rank`・`.rank__name`・目盛りの 5 行は全ページが読む css/brand.css に 1 か所だけ置く（index.html は card.css だけ、list.html・stats.html は pages.css だけを読むため）。CSS の規律（B57-12: 足した行に `var(--radius)`・`var(--radius-lg)`・`999px`・`rgba(0,0,0`・`#FFF` を書かない）を守る。角丸が要る所は `var(--radius-room)`。
- 名前の文字は 12px（390 でも省かない）。名前が主、目盛りは添え。緑・朱・金・信号の色・記号の飾りは使わない。昼・紙・夜・藍はトークンだけで描く。
- 読み上げは `aria-label` の 1 文。`#wordMeta`（aria-live）には段を入れない（毎語読まれる）。

### 3.3 1 回の答えと前の答えの日

| 用語 | 定義 |
|---|---|
| 答え | `recordRecallSuccess`（○）か `recordRecallFail`（×）。答え表示の後の打ち直し・別解を打った後の打ち直しは答えに数えない（今と同じ） |
| ×（思い出せず） | Enter／Esc の答え表示・ヒント・1 打ミス・Battle のパス（今の `recordRecallFail` と同じ。保持率と同じ基準） |
| 答える前の stat（`pendingAnswer`） | ○ は `recordCorrect` が先に streak・mastered を書き換える（game.js:1902-1909、battleEngine.js:190-191 はどちらも `recordCorrect` → `recordRecallSuccess` の順）。そこで `recordCorrect` の**先頭（写す前）**で `{ id, rankBefore, streakBefore, knownBefore, clean, ctx }` をモジュール変数に控え、同じタスクの `recordRecallSuccess` は id が同じならこれを使う。`queueMicrotask` で捨てる（storage.js の draft と同じ作法。答え表示の後の打ち直しで `recordCorrect` だけが呼ばれたとき、次の答えへ持ち越さない）。× は `recordRecallFail` の先頭で書く前の stat を読む |
| ○ノーミス（clean） | `answer.clean`（game.js が `completeWord` の `isClean` を渡す）→ 無ければ `pendingAnswer.clean`（Battle。`recordCorrect` の `wasClean`）→ どちらも無ければ打ち間違いありとみなす（控えめ） |
| 前の答えの時刻 `prevAt`・日 `prevDay` | 答える前の `max(lastRecallSuccessAt, lastRecallFailAt)` と、そのローカル日。どちらも無ければ `null` |
| 同じ日の扱い `sameDay` | `prevDay === today`、または `今 − prevAt < MIN_GAP_MS`（6 時間）、または `dayDiff(prevDay, today)` が 1 未満・数でない（時計の戻り・別の端末の時計の進み） |
| 間隔 `gap` | `sameDay` でないときだけ `dayDiff(prevDay, today)`（js/retentionCalc.js の `localDay`・`dayDiff`。整数日）。× のあとは答えを見ているので × の日から数え直す |
| その日の最初の答え | `prevDay !== null && !sameDay`。段が上がる・速さを基準に入れる・§3.8 で数える・S2／S3 を当てるのはこの答えだけ |
| 初めての答え（段の枝） | `prevDay === null && rankBefore === 0` |
| 日数が分からない答え | `prevDay === null && rankBefore >= 1`（時刻の欄が無いのに段がある古い行。mastered だけ持つ語など） |
| 初見の判定（知ってたを立てる条件） | `isFirstAnswer(stat)` = `!lastRecallSuccessAt && !lastRecallFailAt && (recallFail ?? 0) === 0`。`playCount` は見ない（§5.10 の直し） |
| 知ってた語 | `knownOnSight === true && (recallFail ?? 0) === 0` |
| 知ってた語の最初の確認 `knownCheck` | 知ってた語で、答える前の streak が 1（`pendingAnswer.streakBefore === 1`）。初見の日のあと、別の日のノーミス正解（streak 2）・打ち間違いありの正解（streak 0）・×（recallFail 1）のどれも無い。streak 0 から別の日のノーミスで 1 に戻った語と見分けるため、期日が最後の自力正解から 13 日以上先であることも要る（`isKnownWaiting`。§11.1 の 9） |
| 今日もう × がある `failedToday` | 答える前の `lastRecallFailAt` が同じ日の扱い（ローカル日が今日、または 6 時間未満） |

- これらは `answerContext(stat, nowMs)`（mastery.js の純関数）が 1 か所で出す。stats.js の書き手と game.js（速さの分類・基準に入れるか・60 秒のパネル）が同じ関数を呼ぶ。
- 2 つの日時は同期する欄で、マージは欄ごとに新しい方（sync.js:434-437）。**取り込んだ後は**、2 台で使っても `gap` と「その日の最初の答え」は同じに出る。取り込む前（タブごとの initialSync、sync.js:362-450 の前）の答えは、この端末の答えとして扱う（段は端末ごと、§7.3 とそろえる）。

### 3.4 速さ

| 量 | 定義 |
|---|---|
| `tShow` | `setNewWord` で出題の文を書いた後の、最初の `requestAnimationFrame` の中の `performance.now()`（重い端末で `recordPlay` の同期の書き込み、Batch 58 の計測で約 135ms を数えないため）。これより前に最初のキーが来た語は測らない |
| `tFirst` | この語の最初のキー: `acceptChar`（英単語）／`handleTypingMiss`／ローマ字の受理と miss。ヒントで足した字（`useHint`）は入れない |
| 入力の種類 `input` | その語の最初のキーが来た経路: 物理キーの keydown（`handleKeydown` で受けた印字できるキー）→ `kbd`。画面キーボード（`#osk` のボタン → `editAtCaret`）・ソフトウェアキーボードの beforeinput／input（`handleBeforeInput`・`handleTextInput`）→ `touch`。タブレットに外付けキーボードをつなぐ人、タッチ式のノート PC で画面キーボードを出す人も、実際の打ち方の箱に入る |
| `tDone` | `completeWord` の頭 |
| T1 | `tFirst − tShow`（ms）。速さの本体 |
| 1 字あたり pc | `(tDone − tFirst) ÷ (打った字数 − 1)`。字数 3 以上のときだけ。綴りで迷った語の見張り |

**測らない（速さ＝`unknown`、基準にも入れない）**: ヒント・答え表示の語（どちらも ×）／前の語の続き（spill・shared）の字がこの語の最初の字になった語／出題から最初のキーまでにタブが裏に回った語（visibilitychange を数える）／ページを開いて最初の語（キューの先頭の強い語と腕試しの最初の語を測れないが、即答の機会を 1 回失うだけで控えめ側）／音で出題（`listenMode`）／例文の訳を添えた問い（`isAmbiguousPrompt`）／全文入力のカード（`freeMode`・概念カード・IME）・計算・英文を打つ・空欄・並べ替えのカード／`tShow` より前のキー／T1 < 200ms（先打ちの疑い）／Battle（引数なし）。ローマ字の答えは測る（`ja` の箱）。

**本人の基準**（js/masteryMeta.js）:

- 箱は 8 つ: `${lang}.${input}.${ctx}`。`lang` = `en`（英語の綴り）／`ja`（ローマ字の答え）、`input` = `kbd`／`touch`（上の経路）、`ctx` = `study`（語数の Study と 60 秒の Study）／`play`（Challenge・Daily）。Study の 60 秒は語数の Study と同じ箱に入れる（60 秒に切り替えた最初の数回に基準が空にならない。待ち 0 の Challenge が基準を速い側へ引っ張らない）。
- 各箱に直近 40 件の T1（入れるとき 7,000ms で丸める）と直近 40 件の pc。基準は中央値。
- 入れる答え: 初めての答え、またはその日の最初の答えで、ノーミス正解、速さを測れたもの。今の答えは**入れる前に**分類する。

**分類** `classifySpeed(sample, box, { firstAnswer })` → `{ speed, basis }`（仮の値。§3.8 で見直す）:

| 分類 | 自分の箱の T1 が 20 件以上 | 20 件未満（既定の線） |
|---|---|---|
| `fast`（すぐ） | `T1 ≤ 基準 × 0.75`、かつ（pc を測れて pc の箱が 20 件以上なら）`pc ≤ pc 基準 × 2`。`basis: "own"` | 初めての答え（`firstAnswer`）で、`lang` が `en`、`T1 ≤ COLD_FAST_MS[en.${input}]`。pc は見ない。`basis: "prior"` |
| `slow`（遅い） | `T1 > 基準 × 1.5`、または（pc の箱が 20 件以上なら）`pc > pc 基準 × 2.5` | 出さない |
| `normal` | 上のどれでもない | 出さない |
| `unknown` | 測らない答え | 測らない答え・上の fast に当たらない答え（初めてでない答え・ja の答え・線より遅い答え） |

- pc の箱が 20 件未満なら、fast でも slow でも pc は見ない。
- 定数: `FAST_RATIO = 0.75`・`SLOW_RATIO = 1.5`・`PC_FAST_MAX = 2`・`PC_SLOW = 2.5`・`MIN_SAMPLES = 20`・`KEEP = 40`・`T1_MIN = 200`・`T1_CAP = 7000`・`COLD_FAST_MS = { "en.kbd": 1500, "en.touch": 2100 }`。秒数・打/秒・分類の名前は画面に出さない。
- 本人の基準と比べる（固定の秒数で全部を決めない）のは、打つのが遅い人・スマホの人がいつまでも即答に行けないため。それでも基準が無い間の初めての答えにだけ既定の線を使うのは、腕試しの最初の易しい 3 語（studyQueue.js:430-437 の短い easy 語）のような「りんご→apple」にあたる語が、必ず箱が空のときに来るため。線が無いと、新しい人では創業者の例が初日に必ず思い出せるどまりになり、補充にも出続ける。
- 既定の線は推定（原典は無い。§3.8 の集計で見直す）: T1 は「訳を読む＋語を取り出す＋最初の 1 打」。1.5 秒は、りんご のような短い訳で考えずに出る語を 2 秒台の迷いと分ける線。画面キーボードは最初のキーを目で探して親指を運ぶ分を足して 2.1 秒。どちらも「控えめな既定の中央値（2,000／2,800ms）× 0.75」と同じ値。
- 既定の線を速い側・初めての答え・英語だけに絞る理由: (1) 遅い側に使うと、打つのが遅い人・スマホの人の初見の apple が下に落ちる（創業者の例と逆）。(2) ローマ字の答えは、かなを読んでローマ字に直す時間を見積もる根拠が無い。(3) 即答（3→5・4→5）は最も強い言い方なので、本人の基準（20 件以上）で測った「すぐ」だけで決める。毎日 1 セット学ぶ人なら 2 週間後の確認までに箱は 20 件を超える。
- 外れの向き: 遅い人は 3 に留まる（線が無いときと同じ）。誤って 4 になりうるのは初めての答えのノーミス正解、つまり知っていた語だけで、差は 3 と 4 の 1 段。確かめは §3.8 の `check.firstFast`。

### 3.5 段の動き（`nextRank`）

```js
// r = 答える前の段（○ は pendingAnswer.rankBefore、× は書く前の rankOf）
// a = { ok, clean, speed }、c = answerContext の値 { prevDay, sameDay, gap, knownCheck, failedToday }
export const SOLID_GAP_DAYS = 6, TOP_GAP_DAYS = 20, KNOWN_CHECK_DAYS = 14, MIN_GAP_MS = 6 * 60 * 60 * 1000;
export function nextRank(r, a, c) {
  if (c.prevDay === null && r === 0) {                        // 初めての答え
    if (!a.ok) return 1;
    if (!a.clean) return 2;
    return a.speed === "fast" ? 4 : 3;                        // 遅くても 3（遅さは 2 週間後の確認で見る）
  }
  if (!a.ok) return c.failedToday ? r : Math.max(1, r - 1);   // × はその日の最初の 1 回だけ 1 段（○ との順は問わない）
  if (c.prevDay === null || c.sameDay) return r <= 1 ? 2 : r;  // 日数が分からない・同じ日の ○: まだ → あやふや だけ
  if (!a.clean) return Math.max(r, 2);                        // 打ち間違いあり（Battle）は 2 より上げない。正解で下げない
  if (c.knownCheck && (r === 3 || r === 4) && c.gap >= KNOWN_CHECK_DAYS) return a.speed === "fast" ? 5 : 4;
  if (r === 5) return a.speed === "slow" ? 4 : 5;             // 遅い答えのまま「即答」と言わない
  const e = c.gap >= TOP_GAP_DAYS && a.speed === "fast" ? 5 : c.gap >= SOLID_GAP_DAYS ? 4 : 3;
  return e > r ? r + 1 : r;                                   // 1 日 1 段
}
```

誤って上げないための守り:

1. 上がるのはその日の最初の答えだけ（Recall Loop の 2 回目・60 秒の中の 2 回目・同じ日の 2 回目の 60 秒では上がらない。例外は 1 → 2 だけ）。前の答えから 6 時間未満なら、日付をまたいでも同じ日の扱い（23:50 に × → 00:03 に ○ を「日をあけた」と数えない）。
2. 上がるのは 1 日 1 段。飛ぶのは初めての答え（0 → 3／4）と知ってた語の最初の確認（3 → 5）だけで、どちらも直前に見ていない答え。知ってた語の確認の枝は `knownCheck`（確認の前に別の日の答えが無い）に限る。
3. 身についた・即答には、前の答え（× で答えを見た日も含む）から 6 日・20 日あけた正解が要る。期日前の早い正解は `gap` が短いので上がらない。
4. 即答には本人の基準（20 件以上）で測った「すぐ」が要る。既定の線が「すぐ」と言うのは初めての答えだけで、届くのは身についたまで。
5. ヒント・答え表示・1 打ミスは ×（今の判定のまま）。打ち間違いありの自力正解（Battle）は 2 より上げない。
6. 古い記録の初期値は控えめ（§3.6。即答にしない。6 日あけた証拠が無ければ身についたにしない）。
7. 日数が分からない答え・時計が戻った答えでは上げない（同じ日の扱い）。

下げすぎないための守り: × は 1 段だけ・1 日 1 回（同じ日の 2 回目の × では下がらない。その日の最初の × は ○ の後でも下がる）・最低は 1・時間では下げない・正解で下げるのは即答の遅い答え（5 → 4）だけ・初めての答えは遅くても 3。

### 3.6 読み方（`rankOf`）と古い記録・ほかの端末・古い版

```js
export function rankOf(s) {
  if (!answered(s)) return 0;     // answered = lastRecallSuccessAt・lastRecallFailAt・mastered・knownOnSight のどれかがある
  if (Number.isInteger(s.masteryRank) && s.masteryRank >= 1 && s.masteryRank <= 5) {
    // この端末の段が見ていない × がある（古い版・2 台目で答えた）: 読むときだけ 1 段下げる。書かない
    const unseenFail = (Date.parse(s.lastRecallFailAt ?? "") || 0) > (Date.parse(s.masteryAt ?? "") || 0);
    return unseenFail && isUnresolved(s) ? Math.max(1, s.masteryRank - 1) : s.masteryRank;
  }
  return initialRank(s);
}
```

`initialRank(s)`（段の欄が無い語。読むたびに計算し、書かない。次に答えたとき書き手がこの値を起点に更新して保存する）:

| 条件（上から） | 段 |
|---|---|
| 答えの記録が無い | 0 |
| 知ってた語で streak ≥ 2 | history に「6 日以上あいた ○」があれば 4、無ければ 3（history が 2 件未満なら 4） |
| 知ってた語で streak 1 | 3 |
| 未解決（最後の × が最後の自力正解より新しい）で、`masteredAt` あり | 3 |
| 未解決 | history で最後の × より前に ○ の日が 2 日以上あれば 2、それ以外は 1 |
| 自力正解が無い（習得でもない） | 1 |
| 習得、または streak ≥ 6 | history に「6 日以上あいた ○」があれば 4、無ければ 3（history が 2 件未満なら 4） |
| streak ≥ 2 | 3 |
| それ以外（自力正解あり） | 2 |

- 「6 日以上あいた ○」: 端末の `history`（直近 8 件の `{ d, r }`）で、`r === "o"` の項目とその前の項目の日の差が 6 以上の組がある。ミッションの復習（missCount > 0 の語を期日を見ずに出す）で 10 日続けて答えて習得になった語は、6 日あけた証拠が無いので 3。
- history が 2 件未満の語（2 台目の取り込みなど。history は同期しない）は判断できないので、今の表のまま 4。
- 知ってた語の行を先に置く（`knownOnSight` だけで `lastRecallSuccessAt` の無い種でも「まだ」にしない）。
- 2 台目の初回の取り込みでは `knownOnSight` が届かない（sync.js:424）ので、知ってた語は streak から 2〜4 に見える（控えめな側）。
- 2 台目・古い版で答えた ○ はこの端末の段を上げない。× は `unseenFail` で 1 段として数える。どちらも次にこの端末で答えたとき `masteryAt` が今に揃う。自分で書いた × で `unseenFail` が立たないよう、`masteryAt` は書いた `lastRecall*At` と同じ文字列にする（§7.2）。
- `isUnresolved` は studyQueue.js:94-98 と同じ 4 行を mastery.js に持つ（mastery.js は js/retentionCalc.js 以外を import しない。単体テストで読むため）。

### 3.7 りんご → apple の道（S6 は段階 1、S1〜S3 は段階 2）

| 日 | 起きること | 段 | 次の確認 |
|---|---|---|---|
| 0 | 初見でノーミス・すぐ（本人の基準がまだなら既定の線: 物理キーボード 1.5 秒・画面キーボード 2.1 秒） | 身についた。すぐでなければ 思い出せる | 14 日後（今と同じ） |
| 1〜13 | 確認待ちの知ってた語なので、段に関係なく補充・ミッション・息抜きに出ない（S6）。Challenge で出て正解しても期日は早まらない（S1） | そのまま | 14 日目のまま |
| 14 | ノーミス・すぐ（知ってた語の最初の確認。本人の基準 20 件以上で測る） | 即答 | 30 日後（S3） |
| 44・74・104 | ノーミス（遅くない） | 即答 | 30 日ごと |

- 106 日までに出るのは 0・14・44・74・104 日の 5 回（Challenge・Daily・Battle で答えなければ。0 日目の速さによらない）。今は 0・14・16・19・24・31・41・55・76・106 日の 10 回に、期日を見ない補充が加わる。段階 1 だけの間は、S6 で補充が消え、間隔は今の 10 回のまま。
- 14 日目がふつうの速さ（または本人の基準が 20 件未満）なら身についた、次は 21 日後（S2）。35 日目（gap 21）にすぐなら即答、ふつうなら身についたのまま次は 30 日後。0・14・35・65・95 日の 5 回。
- 1〜13 日に Challenge などで答えると、streak が動いて `knownCheck` が外れ、前の答えの日も動く。14 日目以降は通常の規則（6 日あけて身についた、20 日あけてすぐで即答）。
- 初見で 1 打ミス（appel）なら まだ（1）。Recall Loop で打てたら あやふや（2）。その後は条件を満たした日に 1 段ずつ（翌日以降のノーミスで 思い出せる、その 6 日以上あとで 身についた、20 日以上あとにすぐで 即答）。

1 回の打ち間違い（即答の語が 44 日目に appel）:

| 日 | 起きること | 段 | 次 |
|---|---|---|---|
| 44 | 期日の確認で 1 打ミス（×） | 即答 → 身についた | Recall Loop で打てる（同じ日なので段は動かない）。翌日 |
| 45 | ノーミス（gap 1） | 身についた のまま | 7 日後（S3） |
| 52・62・76 | ノーミス（gap 7・10・14） | 身についた | 10・14・21 日後（S2） |
| 97 | ノーミス・すぐ（gap 21） | 即答 | 30 日後 |

今は 44 日目に streak 0・習得の取り消し・苦手になり、1・2・3・5・7… 日と上り直す。即答へ戻るまでの 53 日・復習 4 回が多すぎるかは Q4 で創業者に聞く。

### 3.8 段が記憶を表しているかの確かめ（画面には出さない）

- `spelldash_mastery_meta.check.rank` に、その日の最初の答え（`gap ≥ 1`）ごとに「**答える前の段** × **gap の帯**（`1`・`2-5`・`6-13`・`14-29`・`30+`）× 結果（○／×）」を数える（stats.js の書き手から。Battle も入る。答える前の段は `pendingAnswer.rankBefore`）。`check.since` に数え始めた日。段が高い語ほど長い間隔で問う（SRS は忘れかけた頃に問う）ので、段どうしは**同じ帯の中で**比べる。
- `check.firstFast = { prior: [o, x], own: [o, x] }`: 初めての答えで「すぐ」と分類した語の、次のその日の最初の答えの結果。既定の線（prior）と本人の基準（own）を分けて数える。答えを待つ語は `check.pending`（`{ id: "p" | "o" }`、200 件まで、古い順に捨てる）に控え、数えたら消す。
- `check.firstMedian`: 各箱で初めて 20 件たまったときの本人の中央値（1 回だけ書く）。既定の値（en.kbd 2,000ms・en.touch 2,800ms）と比べる。
- 見るもの: 同じ帯で段が上がるほど ○ の割合が上がるか（単調か）。即答 ≥ 身についた ≥ 思い出せる … か。Batch 55 の保持率（7 日窓）と同じ向きか。`firstFast.prior` の ○ 率が `own` や段 4 のほかの語より低くないか。段 5 の語の割合の推移（本人の基準は相対なので、強い語ばかり答える人ほど中央値が下がり fast が出にくくなる）。
- 見方: 2〜4 週後、創業者の端末の設定「バックアップ」の JSON で読む（`spelldash_` で始まるので自動で入る）。
- 単調でなければ仮の値（0.75・1.5・6・20・14 日・20 件・6 時間）を直す。`firstFast.prior` が低ければ `COLD_FAST_MS` を締める（`firstMedian` が既定より速い人が多ければ既定を下げる）。即答が身についたより低いままなら、即答の条件を厳しくするか、Q2 の代案（速さを使わない最上段）に切り替える。直すのは定数だけで、記録は変えない。

## 4. 60 秒の回

### 4.0 回の種類と長さ（始めるときに 1 度だけ決める）

- `startGame` で `runKind`（`timed`・`words`・`retry`・`resume` のどれか）と `runSize` を決めて持つ。回の途中で設定が変わっても、この回には効かない（次の回から効く）。
  - `retry`（思い出せなかった N語をもう一度・単語帳の `?words=`）: `runSize = ids.length`。
  - `resume`（前回の続きから）: `runSize = resume.setSize`（無ければ `getSetSize()`）。
  - `timed`: `isTimedSet() && !retry && !resume && !isPlacementRun() && !isTutorialRunPending()`。判定は `startStudyQueue` の後（`isPlacementRun()` が決まってから）に置く。
  - それ以外は `words`（腕試し・チュートリアルの回を含む）: `runSize = getSetSize()`。
- `currentSetSize()`（game.js:2052-2054）は `runSize` を返す。
- `timed` の回は `setCompletePending` を立てない（game.js:1932。15 語に届いても回は終わらない）・`saveResumePoint` と `clearSession` を呼ばない・`renderSetProgress` で時計を描く。
- Challenge の結果の「苦手を復習」（`#resultStudy` → `startGame()`）は、今日のセットの長さに従う（60 秒の設定なら 60 秒の回）。

### 4.1 入口

- 保存は今のキー `spelldash_set_size` に値 `"60s"` を足す。js/dailySet.js:
  - `SET_LENGTHS = ["10", "15", "25", "60s"]`。
  - `getSetLength()`: 保存値をそのまま返す（`"10"`・`"15"`・`"25"`・`"60s"`、不正な値は `"15"`）。URL の `?set=` は見ない。2 つの select はこれで初期化する。
  - `isTimedSet()` = URL の `set` が `"60s"`、または（URL に数の `?set=` が無く）保存値が `"60s"`。数の `?set=N` が勝つ（E2E の `?set=2／3／5` に 60 秒が混ざらない）。
  - `getSetSize()` は 60 秒のとき 15 を返す（今の呼び手を壊さない。古い版は `Number("60s")` が NaN で 15 語に戻る）。`?set=N`（数）は今のまま。
  - `setSetSize(v)` は `SET_LENGTHS` の値を受ける。
- 設定（profile.html:193-201）: ラベルを「今日のセットの長さ」に。id は `#setSizeSelect` のまま。初期値は `getSetLength()`（profileView.js:37 の `String(getSetSize())` を替える。替えないと 60 秒を選んで開き直すと「15語」に見える）。選択肢: `10語（約3分）`／`15語（約5分・標準）`／`25語（約8分）`／`60秒（時間で区切る）`。注記は 60 秒のとき「60秒たつと終わり。自力で思い出せた語が1語以上あれば、今日のぶんは完了」、ほかは今の文。meta description と og:description（profile.html:25）の「語数」を「長さ」に。
- ホームの出題設定（`#setupPanel`、index.html:326 の苦手のみ復習の行の次）: `<label for="setLengthSelect" class="setup__label">今日のセットの長さ</label>` と同じ 4 択の `<select id="setLengthSelect" class="setting-select">`。初期値は `getSetLength()`、change で `setSetSize`。2 つの select は同じ値を読み書きする。変えたら道の右頁と要約を描き直す。select の見た目は pages.css:1931 にしか無いので、home.css に `.setup` の中だけの規則を足す。畳まれているので盤面の寸法は変わらない。
- プレイ中に `#setLengthSelect` を変えても今の回は変わらない（§4.0）。次の回から効く。
- 出題の要約（main.js `renderSetupSummary`）: 60 秒なら最後に「60秒」を足す（例「すべて › 60秒」）。
- 道の右頁の 1 行（pathView.js:160-168）: 60 秒なら `今日のセット 60秒${復習の句}`（「約5分」は付けない）。60 秒のときは続きからの文とボタン（「前回の続きから（N／M語 済み）」「続きから」）を出さない（§4.2）。今日のぶんが済んだ日は「今日のぶんは完了 ・ 次は60秒」（ボタンは今の「もう1回」のまま。押すと 60 秒の回だと文字で分かる）。腕試しの文は今のまま。
- 盤面の待ち受け（`showIdleMessage`）: 60 秒なら Study でも「Enter で開始（60秒）」。
- スタートは机の本の `#pathStart` 1 つのまま。新しいボタン・タイル・ページ・「ほかの遊び方」の行は作らない。

### 4.2 60 秒にしない回（語数で走る）

- 腕試し（初回 10 語。10 語そろって判定する）。
- チュートリアルの回: tutorial.js に `isTutorialRunPending()`（`started && !setDone && まだ見ていない札がある`）を export し、§4.0 の判定で使う。初回のセットと、設定の「チュートリアルをもう一度」（`resetTutorial`）の後の回の両方を拾う（T3 の待ち延ばし 1.5 秒が 60 秒の回に入らない）。
- 決めた語だけの回: 「思い出せなかった N語をもう一度」（`retry`）・単語帳の「苦手だけ練習」（`?words=`）。
- 前回の続きから: 長さが語数のときだけ。長さが 60 秒なら `#pathStart`（main.js:151 の `startUnit`）は続きを見ずに 60 秒の回を始め、`spelldash_session` には触れない（長さを語数に戻すと続きが出る。保存した `setSize` で走る）。利用者が選んだ長さを優先する。

### 4.3 出題

- Study のキューそのまま（`startStudyQueue`: 未解決 → ミッション → 期日の復習 → 今日の反復 → 補充）。Recall Loop・新出の同じ日 4 回・苦手のみ・出題比率・ジャンル・息抜き（`insertBreather`）もそのまま効く（S6 は語数の回と同じく効く）。
- 60 秒で終わらなかった新出の反復は、その日の次の回（語数でも 60 秒でも）に持ち越す（今の仕組み）。
- 苦手のみで出題が尽きたら、1 語以上答えていれば終わりのパネル、0 語なら今の 1 行（game.js:2392-2397）。

### 4.4 1 問の流れ

- Study と同じ: Enter／Esc で答え表示、1 打ミスで答え表示、7 秒でヒント、答え表示の後は打ち直し、Recall Loop。キーの意味は KEYBOARD.md のまま。
- 違いは待ちと知らせ:
  - 正解のあとは「すぐ次へ」（`waitAfterCorrect({ …, pace: "quick" })` = 250ms、例文は見せない）。
  - 覚えた（`celebrateLearned`、game.js:2074-2103）はメッセージ行の「覚えた！ X」だけ。スタンプ（盤面の中央に 1.4 秒。待ち 250ms だと次の語の出題と入力欄に約 1.1 秒かぶる）と `#learnToast` のはちゃんは出さない。待ちも延ばさない（`MILESTONE_MS` を使わない）。
  - 3 つ続けて思い出せなかったときの立て直し（game.js:1369-1379）: 息抜きの語を挟むことは残し、`#learnToast` のはちゃんの知らせは出さない。
  - レベルアップの幕（`celebrateRankUp`）は出さず 1 行で言う（腕試しと同じ扱い）。
- BGM・`body.is-playing`・`#bigTimer`・スコア・コンボは使わない（Study のまま）。XP・ミッションは Study と同じ。
- 時計は止めずに進む。止まるのは §4.5 の間だけ。答え表示の後の打ち直しの間も進む。

### 4.5 時計

- 長さ `TIMED_SECONDS = durationOverride ?? 60`（`?t=N` を Challenge と共有。Study に効くのは 60 秒の回だけ。既定の 15 語の Study には効かない）。
- 最初の語を出した時に `deadline = performance.now() + 秒 × 1000`。250ms ごとに描く。interval は既存の `timer`（game.js:128）に載せる（Challenge と同じ。今の `clearInterval(timer)` が stopGame・restartGame・endStudySession・`#setRetry`・endChallenge のすべてで効き、苦手のみのトグルや `#setRetry` から始め直しても前の時計が残らない）。
- 止める間:
  - タブが裏: visibilitychange で `hiddenAt` を記録し、visible に戻ったら `deadline += now − hiddenAt`（裏ではブラウザが interval を間引くので、tick 間の差では数えない）。
  - 覚え方のメモを書いている間（`isEditingNote()`）・覚え方を作っている間（`isMakingWordAi()`）・覚え方を作った後の読む間（`readingHold`）: 250ms の描画ごとに見て、止まっていた分（前の描画からの経過）を `deadline` に足す。
- 表示は `#setProgress` の中身だけ替える（同じ 3 つの要素なので高さは同じ、入力欄の位置は動かない）:

  ```html
  <span class="set-progress__label">60秒</span>
  <span class="set-progress__count">残り <b>42</b>秒</span>
  <span class="set-progress__bar"><i style="width:70%"></i></span>
  ```

  ラベルは `${TIMED_SECONDS}秒`。残りは `Math.ceil(ms / 1000)`、棒は残りの割合で減る。残り 10 秒でも朱にしない・点滅しない（reduced motion では棒は動かない）。
- 読み上げ: `#setProgress` は aria-live にしない（毎秒読まない）。始めに `announce(TIMED_SECONDS + "秒")`（既定は「60秒」）、残り 10 秒で 1 回だけ `announce("残り10秒")`（長さが 10 秒より長いとき）。

### 4.6 時間切れ

- 0 になったらその場で止める（`advanceTimer`・ヒントの時計を止め、終わりのパネルへ）。
- 画面の語にまだ答えていない（打っていない・途中まで打った）: **× にしない・何も記録しない**（段・SRS・履歴・保持率・苦手は動かない）。出題の `recordPlay`（出題回数 +1）は残るが、初めての答えの判定は `playCount` を見ない（§3.3）ので害は無い。T1 も捨てる。
- 答え表示の後の打ち直しの途中: × は記録済み。そのまま終わる。
- 正解のあとの待ちの途中: 記録済み。そのまま終わる。
- Recall Loop で戻る前の語は未解決のまま、次の回の先頭に出る。
- 途中で机に戻る（`stopGame`）: パネルも今日のぶんも無し。答えた語は記録済み。

### 4.7 終わりのパネル

`endStudySession({ timed: true })`。今の完了パネルの骨組み（見出し 1 つ・はちゃん 1 文・数字 1 行・語チップ・ボタン）。

```
今日のセット完了                         ← h2#resultTitle（焦点）。思い出せた 0 語の回は「60秒 終わり」
（はちゃん 1 文）                        ← hasumiSetLine（今のまま）。0 語の回は下の 2 通り
思い出せた 11 ・ 思い出せず 3             ← .result-panel__grid（今のまま）
習熟度（この回に答えた語）                 ← .rank-groups__title（語数は書かない。数字は上の 1 行だけ）
[目盛り 即答]       apple りんご ・ water 水
[目盛り 身についた]  budget 予算 上がった ・ office 事務所 初めて ・ desk 机 時間がかかった
[目盛り 思い出せる]  invoice 請求書
[目盛り あやふや]    negotiate 交渉する 下がった
[目盛り まだ]        accommodate 収容する
習熟度が上がるのは、各語その日の最初の答えだけ。   ← 今日もう答えていた語があった回だけ
明日の復習: …                              ← 今のまま
[思い出せなかった3語をもう一度] [もう60秒]   ← #setRetry・#setAgain
```

- 群は段 5 → 1、0 語の群は出さない。答えた語が 0 なら題も群も出さない。群は `<div class="word-chips rank-group" role="group" aria-labelledby="rankGroupN">`、題は `<span class="word-chips__title" id="rankGroupN">${rankHtml(N)}</span>`。群の中は回で最初に答えた順。
- 語チップは今の `.word-chip`（押すと発音、`data-speak`）。`max-width: 100%` と中での折り返しを足す（長い訳の語が 320 幅で箱をはみ出さない）。中に `<span class="word-chip__move">` で 1 語だけ:
  - 「初めて」: 回の前が段 0。
  - 「上がった」: 今の段 ＞ 回の前 ≥ 1。
  - 「時間がかかった」: 今の段 ＝ 回の前 − 1 で、下がったのが回の最初の答えの遅い正解（5 → 4）だけのとき（その後この回で × があれば「下がった」）。正解したのに「下がった」と出て不具合に見えないように。
  - 「下がった」: 今の段 ＜ 回の前（上の場合を除く）。
  - 同じなら無し。矢印・記号は使わない。ボタンの名前は「budget 予算 上がった」と読まれる。
- 回の前の段: その語に回で最初に答える直前の `rankOf`（○ は `completeWord` の `prevStat`、game.js:1882、`recordCorrect` の前。× は `recordRecallFail` を呼ぶ前の stat）。メモリーの Map `runRankBefore: Map<id, { before, seenToday, slowDown }>` に控える（保存しない）。`seenToday` は回で最初に答えた時点の `answerContext(...).sameDay`、`slowDown` は回の最初の答えが ○・slow で 5 → 4 になったとき真、この回でその語に × があれば偽。今の段は終わりの時点の `rankOf`。
- 「習熟度が上がるのは…」の行: `seenToday` の語が 1 つ以上あるとき。
- はちゃん（`hasumiSetLine` に `timedEmpty` の枝。思い出せた 0 語の回）: 思い出せず ≥ 1 なら「思い出せなかった語は、次の回の最初に出る。」（未解決の語はキューの先頭に来る）。思い出せず 0（何も答えずに時間が切れた）なら「時間切れの語は、記録していない。」。
- 数字は今の 1 行だけ（上がった・下がったの数の行は足さない。語そのものを見せる）。「覚えた（前は出てこなかった語）」の群は置かない（前の日に思い出せなかった語は 1 → 2 の「上がった」で見える）。
- ボタン: 思い出せなかった語があれば `#setRetry`（主・朱）「思い出せなかったN語をもう一度」（語数で走る）と `#setAgain`（ゴースト）「もう60秒」。無ければ `#setAgain` が主。`#setChallenge`「Challenge（60秒）」は置かない（60 秒のボタンが 2 つ並ぶと紛れる）。`#setInstall` は今のまま。
- 語数で走った回（腕試し・もう一度・続きから）の完了パネルでも、次に `#setAgain` で始まるのが 60 秒の回なら、文を「もう1セット」から「もう60秒」にする（B57 は既定の 15 語で測るので幅 110 は変わらない）。`#setChallenge` はそのまま。
- 焦点は見出しへ（`focusResultTitle`）。Tab で語チップとボタンを回る。390 で語チップは折り返す（横スクロール 0）。
- はちゃんはこの 1 文だけ。Pro の文言は出さない。

### 4.8 今日のぶん

- 自力で思い出せた語が 1 語以上の回: `markDailySetDone(recalled)`（今日のぶん済み・7 日のドット・解放の累計 `bumpTotalSets`・user_items の day）。語数のセットと同じく、回ごとに 1 セットと数える。
- 0 語の回: `markDailySetDone` を呼ばない（時間を流すだけで今日のぶん・7 日のドット・解放の累計が進む抜け道を塞ぐ）。連続日数は今と同じく `applyStudyXp` の `updateStreak`（game.js:2267）が数える（答えを見て打ち直しただけの回でも続く。今の語数のセットと同じ）。
- 続きからの地点を残さない（`saveResumePoint` を呼ばない）。語数のセットの続きは消さない（`clearSession` を呼ばない）。
- 終わりに `pushSync`（今と同じ）。`spelldash:session-end` の detail に `timed: true`。
- ホームのはちゃん（`hasumiHomeLine`、hasumi.js:50）: 今日遊んで未完了の枝は、続き（`resumableFor`）が無いとき、または長さが 60 秒のとき「今日はまだ途中。」（「続きから。」と言わない。60 秒の回は続きの地点を残さない）。

### 4.9 Challenge との違い

| | Study の 60 秒 | Challenge（変えない） |
|---|---|---|
| 位置づけ | 考えて思い出す（学ぶ側） | 覚えた語を速く引き出して遊ぶ |
| 入口 | 設定の長さ＋机の本の同じスタート | 幕板の「ほかの遊び方」・完了パネル |
| 出題 | Study のキュー（未解決・期日の復習が先、Recall Loop） | 重み付きの抽選（Recall Loop なし） |
| 正解のあと | 250ms | 待ち 0 |
| 分からないとき | 答えを見て打ち直す | Enter で次の語 |
| 時計 | `#setProgress` の小さな残り秒。赤にしない。裏に回ると止まる | `#bigTimer`。残り 10 秒で朱。止まらない |
| 音・画面 | BGM なし・`is-playing` なし・スタンプなし | BGM・`is-playing` |
| 数 | 思い出せた・思い出せず | スコア・ベスト・速度・経験値 |
| 終わり | 完了パネル（段ごとの語チップ） | 結果パネル（下に段が動いた語の行。§5.5） |
| 今日のぶん | 数える | 数えない |
| 記録・速さの箱 | 同じ関数・`study`（語数の Study と同じ箱） | 同じ関数・`play` |

## 5. ほかの画面

### 5.1 単語帳（list.html）

- 答えたことのある語のカードの足元（`.gcard__foot`）に、履歴の点の隣に `rankHtml(rankOf(stat), { title: rankBasis(stat, today) })`。listView.js:380 の `${status === "weak" ? memoryGaugeHtml(stat) : ""}` を置き換える。
- 状態の題箋・絞り込み（すべて／未着手／苦手／覚えた）・要約は今のまま。390 で足元は折り返す（flex-wrap）。
- 題箋と段が同じカードに並ぶ組み合わせ（覚えた＋あやふや・習得＋思い出せる・苦手＋身についた）は、語の詳細の根拠の文で理由が分かる（例: 苦手＋身についた →「10月11日は思い出せなかった」）。BACKLOG の「状態の呼び名の表を 1 か所に」にこの 3 組を書く。
- `memoryGaugeHtml`（learnedWords.js:108-120）と単独の `.mem` の規則（pages.css:1193-1215・2428）は消す。pages.css:2615・2646・2652 の `:is()` の並びの `.mem`・`.mem__bar` は残す（特定度を変えない。typing-game.css:89 の注記）。

### 5.2 語の詳細（wordDetail.js）

- meta の行の下に 2 行:

  ```
  習熟度 [目盛り] 身についた ・ 10月3日に思い出せた（7日あけて）
  まだ ・ あやふや ・ 思い出せる ・ 身についた ・ 即答 ・ 10月23日以降に すぐ打てると 即答
  ```

  1 行目は `習熟度 ${rankHtml(r, { label: "" })} ・ ${rankBasis(stat, today)}`。2 行目は段の梯子（今の段だけ太字。`aria-hidden="true"`）と、次の段の条件 `rankNext(stat, today)`（読み上げる。段 5 は無し）。その下に畳んだ `<details class="rank-rule"><summary>習熟度の決まり</summary><p>${RANK_RULE}</p></details>`（開くと規則の文。閉じていれば 1 行で、毎語に 4 文が並ばない）。段 0 なら 3 つとも出さない。
- `rankBasis(stat, today)`（mastery.js の純関数。記録から事実だけを返す。上から最初に当たる枝）:

  | 語 | 文 |
  |---|---|
  | 段の欄が無い（初期値で読んでいる） | これまでの記録から決めた仮の段（最後の答え M月D日） |
  | 未解決 | M月D日は思い出せなかった（`lastRecallFailAt` の日） |
  | 確認待ちの知ってた語（知ってた語で streak 1）で段 4 | M月D日に初めて答えて、すぐ打てた |
  | 確認待ちの知ってた語で段 3 | M月D日に初めて答えて、間違えずに打てた |
  | それ以外 | M月D日に思い出せた（N日あけて）。N は history の最後の `o`（日が `lastRecallSuccessAt` と同じ）とその前の項目の日の差。差が 0・history が足りないときは括弧ごと省く |

  どの枝も日付を持つので、段が「いつの時点の段か」も分かる（段は時間では下がらない）。
- `rankNext(stat, today)`（日付は前の答えの日 `prevDay` から。その日付が今日以前なら「M月D日以降に」を「次に」にする）:

  | 段 | 文 |
  |---|---|
  | 1 | 自力で思い出せると あやふや |
  | 2 | M月D日以降に（prevDay＋1） 間違えずに思い出せると 思い出せる |
  | 3・4 の確認待ちの知ってた語 | M月D日の確認で（`nextReviewAt` の日。無ければ prevDay＋14） すぐ打てると 即答 |
  | 3 | M月D日以降に（prevDay＋6） 間違えずに思い出せると 身についた |
  | 4 | M月D日以降に（prevDay＋20） すぐ打てると 即答 |
  | 5 | 無し |

- 段の梯子とこの 2 つの文で、「なぜこの段か・どうすれば上がるか」が分かる。決まり文句（「6日以上あけても思い出せた」）は出さないので、初見で入った語に「日をあけて」と出ることは無い。
- 題箋の title から「思い出せた N回」（答えを見た後の打ち直しも数えて多めに出る）を外す。新しい title: `思い出せず ${recallFail}回${streak ? ` ・ ノーミス連続 ${streak}/10` : ""}`。
- 「次の復習 N日後」・履歴は今のまま。

### 5.3 学習データ（stats.html 記録タブ）

- 覚えた単語帳の上に節「習熟度」: 行は段 5 → 1 で `rankHtml(n, { label: "" })`＋語数（`12<small> 語</small>`）＋小さく `RANK_GLOSS[n]`（例「まだ 12語 思い出せなかったまま」。行だけで意味が通る）。その段に知ってた語が含まれるときだけ、語数の後に「（うち知ってた M語）」（ホームの「覚えた N語」は知ってた語を除くので、並べて食い違って見えないように）。0 の行は出さない。数える語は `findWord` で引ける語のうち段 1 以上（知ってた語・苦手の語も含む）。1 語も無ければ節ごと出さない。
- 注記: 「答えた記録から決める（予測ではない）。」＋ `RANK_RULE` ＋「最後に答えた時点の段。この端末の記録から。」
- 保持率の 1 枚とは並べない。率・合計点・前週比・推移は出さない。

### 5.4 語数のセットの完了パネル

- 今の語チップ（覚えた（前は出てこなかった語）／思い出せた（2回目）／思い出せず）・数字の行・文言・id・寸法は変えない。
- 語チップの下に、回の前が段 1 以上で段が動いた語があるときだけ 1〜2 行（`<p class="rank-moves">`）:
  「習熟度が上がった: budget（身についた）・ invoice（思い出せる）」／「習熟度が下がった: accommodate（あやふや）・ desk（身についた・時間がかかった）」。正解の遅さで下がった語は §4.7 と同じ判定で「・時間がかかった」を添える。1 行 8 語まで、残りは「ほか N語」。無ければ何も足さない。
- 「覚えた（前は出てこなかった語）」のチップに出ている語は「上がった」の行から除く（必ず 1 → 2 で上がっているので、同じ語を 2 か所で言わない）。

### 5.5 Challenge／Daily の結果

- 数字の行・はちゃん・ボタン・「ベスト」・`#resultRetry` は今のまま。`.result-panel__grid` の下に §5.4 と同じ行（段が動いた語があるときだけ）。そのために Challenge／Daily でも `runRankBefore` に回で最初に答えた語を控える。

### 5.6 盤面の 1 行の文（`applyStudyXp`、要素も行も増やさない）

- 知ってた（game.js:2346）: 段 4 なら `知ってた。${en} はもう身についている。2週間後に確認${xp}`、それ以外は `知ってた。${en} は2週間後に確認${xp}`（初見の日なので「身についた」と過去形で言わない。S6 で 2 週間は補充に出ないので「2週間後に確認」は事実）。
- 日をあけた正解（game.js:2342）: `${days ? `${days}日ぶりでも` : ""}思い出せた${promo}${xp}`。`promo` はこの答えで段が 4 か 5 に上がったときだけ `。習熟度 ${名前}`（例「9日ぶりでも思い出せた。習熟度 身についた」）。
- ほかの文の順と中身は今のまま。打つ前・打っている間は段を見せない。

### 5.7 道・ホーム

段は出さない（目立つのは覚えた語数と今日のセットの残りだけ）。60 秒のときの右頁の 1 行（§4.1）とホームのはちゃんの 1 文（§4.8）だけ替える。

### 5.8 マイ単語帳

myWordsView.js:9 の表に `known: "知ってた"` を足す（「・ undefined」と出る不具合）。段は出さない。

### 5.9 CSV（exportCsv.js）

`status` の次に列 `mastery`（段の名前。段 0 は空）。知ってた語の行にも入れる。

### 5.10 文言と小さな不具合の直し

| 場所 | 今 | 新 | 理由 |
|---|---|---|---|
| game.js:2346 | 知ってた。X は2週間後にもう一度だけ確認 | 知ってた。X は2週間後に確認（段 4 は「X はもう身についている。2週間後に確認」） | 確認のあとも出続ける。「一度だけ」は事実と違う |
| game.js:2342 | 定着。N日ぶりでも思い出せた | N日ぶりでも思い出せた（＋段が 4・5 に上がったら「。習熟度 …」） | 20 時間以上で出る文。保持率の「定着」（7 日窓）と食い違う |
| wordDetail.js:74 | title「思い出せた N回」 | 外す（思い出せず・ノーミス連続は残す） | `correctCount` は答えを見た後の打ち直しも数える |
| myWordsView.js:9 | 知ってたが「undefined」 | 「知ってた」 | 表に `known` が無い |
| stats.js:47・game.js:1895・studyQueue.js:565 | 初見の判定が `playCount === 1`（studyQueue は `<= 1`） | stats.js と game.js は `isFirstAnswer(stat)`。studyQueue.js（× を書いた後に呼ばれる）は `(recallFail ?? 0) <= 1 && !lastRecallSuccessAt` | 出題だけされて答えなかった語（Challenge・60 秒の時間切れ・途中で離れた）が二度と知ってたになれない |

## 6. SRS との関係（S6 は段階 1、S1〜S5 は段階 2）

段は SRS の上に載る別の値。`REVIEW_INTERVAL_DAYS = [1,2,3,5,7,10,14,21,30]`・streak は 1 日 1 回だけ進む・習得＝streak 10・`isReviewDue` は変えない。次の 6 つを入れる（Q3 の既定）。

| # | 規則 | 段階 | 中身 | 置く所 |
|---|---|---|---|---|
| S6 | 期日前に出さない | 1 | 対象: (a) 段 4 以上で `nextReviewAt` が未来の語、(b) 確認待ちの知ってた語（知ってた語で streak 1、`nextReviewAt` が未来。段に関係なく）。補充の既習（`pickFillers` の `familiarPool`）・ミッションの復習（mission.js `pickReviewWords`）・息抜き（`insertBreather`、studyQueue.js:237）から外す。苦手（未解決。最後が ×）の語は期日を見ずに外さない（§11.1 の 10）。補充が足りないときの埋め（「それでも足りなければ」）では最後に戻す。息抜きとミッションには戻さない（息抜きの候補が無ければ今と同じく挟まない。確認と 20 日の間隔を崩さないほうを取る）。ミッションに限り、段 3 で `nextReviewAt` が未来の語も外す（missCount > 0 の語は期日を見ずに毎日出るので、段 3 のまま gap 1 が続いて習得に届き、6 日休む機会が無い）。Challenge の抽選は変えない | studyQueue.js・mission.js |
| S1 | 正解で期日を早めない | 2 | ノーミスで streak が進んだとき `next = max(今の期日（未来なら）, 今日 + streak の間隔)`。知ってたの 14 日は今のまま。例外: Battle の打ち間違いありの正解は `recordCorrect` の非 clean の枝で期日を翌日にする（stats.js:79-81。今のまま。翌日の答えで S3 の下限に戻るので害は小さい） | stats.js `recordCorrect` |
| S2 | 日をあけた正解は間隔を伸ばす | 2 | その日の最初の答え（`prevDay !== null` かつ `sameDay` でない、`gap ≥ 1`）のノーミス正解で、速さが `slow` でないとき `credit = REVIEW_INTERVAL_DAYS.find(d => d > gap) ?? 30`。初めての答え・`gap` が数でないときは credit なし（`dayDiff(null, …)` の NaN で 30 日にならない） | stats.js `recordRecallSuccess` |
| S3 | 段ごとの下限 | 2 | S2 と同じ条件の答えの後、段 4 なら 7 日、段 5 なら 30 日 | 同上 |
| — | 当て方 | 2 | `nextReviewAt = max(recordCorrect が決めた期日, 今 + max(credit, 下限) 日)`（伸ばすだけ。30 日が上限） | 同上 |
| S4 | × の後 | — | 今と同じ（streak 0・習得の取り消し・期日は今・Recall Loop）。翌日のノーミス正解から S2・S3 が効く | 変えない |
| S5 | 知ってた | — | 初見は今と同じく 14 日後（S2 は当てない）。確認の後は即答なら 30 日、身についたなら 21 日（S2）、その次は 30 日 | §3.7 の結果 |

- S6 を段階 1 に置くのは、間隔の計算を変えず補充などの中身だけを変えるため（保持率の 7 日窓は期日の復習で測るので影響は小さい）。段階 1 だけの間に、補充で出た apple が毎回「即答」と出て、創業者の不満（apple を何度も出す）がかえって目立つのを防ぐ。今の「知っている語で時間を使わせない」という決定（stats.js:47 の注記）にも合う。
- 予定どおり続ける人では `gap` ＝ 前の間隔なので、S2 の `credit` は streak の次の間隔と同じ（1→2→3→5→7→10→14→21→30）。段 4 に届くのは早くて学んで 7 日目（0・1・7 日）で、S3 の 7 日も streak 5 の間隔と同じ。**保持率の 7 日窓（+6〜+8 日）の測り方はほぼ変わらない**。変わるのは遅れて戻った人の語・強い語のつまずきの後・知ってた語・即答の語。SPEC_RETENTION §4 に偏りの注記を 1 行足す（段階 1:「2026-10 から、身についた以上の語と確認待ちの知ってた語は期日前の補充に出ない」、段階 2:「日をあけて思い出せた語と身についた以上の語は間隔が延びる」）。
- 習得の語は今どおり期日の復習に出ない。補充には S6 で期日（最後の間隔）を過ぎてから戻る。
- S2・S3 は純関数 `intervalAfter({ streakDays, gap, rank, speed })` と `keepLaterDue(prevIso, nextIso, nowMs)` として mastery.js に置き、単体テストで表を守る。`intervalAfter` は `gap` が数でない・1 未満のとき credit なしを返す。S6 の判定は `holdBeforeDue(stat, nowMs, { includeRank3 })` として mastery.js に置き、studyQueue.js と mission.js が呼ぶ。

## 7. 記録と同期

### 7.1 保存の形

| 置き場所 | 欄・中身 | 書く所 | 同期 |
|---|---|---|---|
| `spelldash_word_stats[id]` | `masteryRank`（1〜5 の整数） | `recordRecallSuccess`・`recordRecallFail` の中（同じ写し） | しない（`statToRow` は 15 列のまま） |
| 同上 | `masteryAt`（ISO。段を決めた答えの時刻。書いた `lastRecall*At` と同じ文字列） | 同上（答えごとに必ず書く。段が変わらなくても） | しない |
| `spelldash_mastery_meta`（新しいキー） | 下の JSON | js/masteryMeta.js | しない（入力の速さは端末と指に固有） |
| メモリー（タスクの中だけ） | `pendingAnswer = { id, rankBefore, streakBefore, knownBefore, clean, ctx }` | stats.js `recordCorrect` の先頭。`queueMicrotask` で捨てる | — |
| メモリー（回の中だけ） | `runKind`・`runSize`、`runRankBefore: Map<id, { before, seenToday, slowDown }>`、60 秒の `deadline`・`hiddenAt`、語ごとの `{ tShow, tFirst, input, invalid }` | game.js | — |
| `spelldash_set_size` | `"60s"` を足す（キーは今のまま。バックアップの対象） | dailySet.js | しない（今と同じ） |

```
spelldash_mastery_meta = {
  v: 1,
  speed: { "en.kbd.study": { t1: [1840, 2210, …], pc: [180, …] }, "ja.touch.play": { … }, … },   // 箱 8 つ・各 40 件まで（約 3KB）
  check: {
    since: "2026-10-20",
    rank: { "3": { "1": [o, x], "2-5": [o, x], "6-13": [o, x], "14-29": [o, x], "30+": [o, x] }, … },  // 段 1〜5 × 帯 5（約 1KB）
    firstFast: { prior: [o, x], own: [o, x] },
    pending: { "<id>": "p", … },        // 200 件まで（約 4KB）
    firstMedian: { "en.kbd.study": 1840, … }
  }
}
```

- `CURRENT_SCHEMA_VERSION` は 6 のまま。移行なし。読む側は `rankOf`（欄が無ければ初期値）。キーが無い・壊れているときは空として読む。
- 書き込みはすべて try/catch。失敗しても学習は続く（retentionLog.js と同じ作法）。

### 7.2 書く順序と回数

- 書き手の引数: `recordRecallSuccess(word, answer?)`。`answer = { clean: boolean, speed: "fast" | "normal" | "slow" | "unknown" }`。省略（Battle）は §3.3 のとおり（`pendingAnswer.clean`）。`recordRecallFail(word)` は今のまま（× はどこからでも同じに扱う）。Battle の呼び方の意味は変わらない。
- `recordCorrect(word, wasClean)`: 先頭（`{ ...stats[word] }` で写す前）で `pendingAnswer` を置く（`rankBefore = rankOf(s)`・`streakBefore = s.cleanCorrectStreak ?? 0`・`knownBefore`・`clean = wasClean`・`ctx = answerContext(s, now)`）→ 今の処理（知ってたの枝も含む）。
- `recordRecallSuccess`: `p = pendingAnswer?.id === word ? pendingAnswer : null`。`r = p?.rankBefore ?? rankOf(s)`、`ctx = p?.ctx ?? answerContext(s, now)`、`knownCheck = !!p?.knownBefore`（`knownBefore` は `recordCorrect` の先頭で控えた `isKnownWaiting(stat)`。streak 1 を含む。§11.1 の 9） → 今の処理 → `const nowIso = new Date().toISOString()` を 1 回だけ取り、`lastRecallSuccessAt = nowIso` → `nextRank` → `masteryRank`・`masteryAt = nowIso` を同じ写しに書く → （段階 2）S2・S3 → `noteRankCheck({ id, rankBefore: r, gap, ok: true })`（その日の最初の答えのとき）。
- `recordRecallFail`: 先頭で `ctx = answerContext(s, now)`・`r = rankOf(s)` を読む（書く前）→ `nowIso` を 1 回だけ取り、`nextReviewAt`・`lastRecallFailAt`・`masteryAt` に同じ値を使う（今は `new Date()` を 2 回呼んでいる。stats.js:141-142）→ `nextRank(r, { ok: false }, ctx)` → `noteRankCheck({ id, rankBefore: r, gap, ok: false })`。
- 書いた直後は `rankOf(stat) === masteryRank`（`masteryAt` と `lastRecall*At` が同じ文字列なので `unseenFail` が立たない）。単体と E2E で守る。
- `recordCorrect` → `recordRecallSuccess` は同じタスクなので、**正解の 1 打の word_stats の書き込みは 1 回のまま**（storage.js:154-178、E2E R3）。`pendingAnswer` はメモリーだけ。
- 速さ: game.js が `completeWord` で `answerContext(prevStat, now)` と `classifySpeed(sample, box, { firstAnswer })` を書き手の前に呼び、結果を `answer` で渡す。書き手の後、初めての答えかその日の最初の答えで、ノーミス正解・測れた答えだけ `noteSpeedSample(box, sample)`。初めての答えで fast なら `notePendingFirstFast(id, basis)`。
- `spelldash_mastery_meta` は答えごとには書かない。メモリーに持ち、変わったとき（dirty）だけ、10 答えごと・`endStudySession`・`endChallenge`・`stopGame`・pagehide で 1 回書く（`flushMasteryMeta`）。変わっていなければ書かない（stopGame は setMode・startUnit・机に戻るのたびに走る。読むだけのページの pagehide でも書かない）。
- 読み手（単語帳・詳細・学習データ・パネル）は `rankOf`・`rankBasis`・`rankNext` で読むだけ。凍った記録を書き換えない。

### 7.3 古い版・2 台目・バックアップ

| 相手 | 起きること |
|---|---|
| 古い版（オフラインのキャッシュ・アプリの dist）が答えた | 古い書き手も `{ ...stats[id] }` で写して書くので欄は消えない。段は動かず `masteryAt` は古いまま。× は `rankOf` の `unseenFail` で 1 段として読む。`gap` は同期する日時から出すので短く見積もる側に倒れる（不当に上げない） |
| 古い版が読む `"60s"` | NaN → 15 語で走る |
| 2 台目の初回の取り込み | クラウドだけの語は端末だけの欄が無い（sync.js:423-427）→ 初期値（控えめ）。取り込む前に答えた語は、この端末の答えとして段が動く |
| 両方にある語のマージ | `{ ...l, ...rowToStat(c, l), ...recallFields }` で端末の欄は残る（sync.js:446）。段は端末ごと。もう 1 台の × は `unseenFail` で効き、○ は効かない |
| 2 つのタブで同時に学ぶ | `spelldash_mastery_meta` はメモリーから書くので後勝ち。§3.8 の集計が少しずれるだけ（段は word_stats なので今の作法のまま） |
| バックアップ・復元 | `spelldash_*` を丸ごと持ち出す。新しい欄も新しいキーも入る。復元（backup.js:85 の `applyBackup`）でも `forgetMasteryMeta()` を `forgetWordStats()` の隣で呼ぶ（メモリーの古い基準が後から復元した中身を上書きしない） |
| 端末の記録を消す（`clearLocalRecords`） | `spelldash_mastery_meta` も消える（KEEP_ON_CLEAR に入れない）。メモリーの基準も捨てる（`forgetMasteryMeta()` を `forgetWordStats()` の隣で呼ぶ） |

### 7.4 SQL

- **段階 1・2 とも要らない。**
- 2 台目でも同じ段を見せたくなったとき（Phase 2）の手順を FOUNDER_TODO の E に書くだけ。創業者が先に実行し、連絡を受けてからコードで `statToRow`／`rowToStat` に足す（逆順だと word_progress の送信が丸ごと失敗し続け、E2E のスタブは列を検査しないので気づけない）:

  ```sql
  alter table public.word_progress
    add column if not exists mastery_rank smallint,
    add column if not exists mastery_at timestamptz,
    add column if not exists known_on_sight boolean;
  ```

  マージは今の規則（`lastPlayed` が新しい行）に従う。`known_on_sight` は BACKLOG F16 の残りを同じ機会に入れる。

## 8. 規則との関係

| 規則 | 守り方 |
|---|---|
| 新しいゲームモードを増やさない | 60 秒は今日のセットの長さ。入口は同じ `#pathStart` と設定、出題は Study のキュー、記録は同じ関数・同じ意味、スコア・ベスト・コンボ・ランキング・BGM なし、終わりは完了パネルの形、名前は長さ（「今日のセット 60秒」）。6 つの条件をすべて満たす。実装後に STATUS §2 の行を「Study（セット・Recall Loop・SRS。長さは 10／15／25 語か 60 秒）」、継続の行を「今日のセット（10／15／25 語・60 秒）」に。CONCEPT §9 の「game.js・studyQueue.js・stats.js は触らない」は書斎の皮の作業の範囲として残し、Batch 63 は学習の本体として触ると書き分ける |
| Battle のロジックは凍結 | battleEngine.js は触らない。Battle の答えは今の書き手を引数なしで通り、段に入る（保持率と同じ前例）。速さは `unknown`、打ち間違いありは 2 より上げない（`recordCorrect` が控えた `wasClean` を使う） |
| はちゃんは 3 場面 | 60 秒の終わり（完了の場面）の 1 文だけ。今の `hasumiSetLine` と、0 語の回の 2 通りの 1 文を hasumi.js に足す。60 秒の回の間は、覚えたと立て直しの `#learnToast` のはちゃんを出さない。段が上がった瞬間・単語帳・詳細には出さない。ホームの 1 文は「続きから。」を事実に合わせるだけ |
| 完了のパネル・道・はちゃん・アプリに Pro を出さない／学習の核は無料 | 段・60 秒・段の表示はすべて無料。「Pro なら推移が見える」も出さない。段で判定や出題の回数を変える Pro は作らない |
| 数字を誇張しない | 段は事実（正誤・日数・測った速さ）から。予測の割合・秒数は出さない。語の詳細は段の名前にその語の事実（日付・あけた日数）を添え、決まり文句で経緯を言わない。学習データの説明は入り方によらず真になる文だけ。即答は本人の基準で測った速さが要り、既定の線は初めての答えの「すぐ」だけ。古い記録は控えめ（6 日あけた証拠が無ければ身についたにしない）。日付をまたいだだけの答えを「日をあけた」と数えない。時間切れの語を × にしない。「もう一度だけ確認」「定着。N日ぶりでも」「思い出せた N回」を事実に合わせる。「この端末の記録から」と書く |
| 通貨・ガチャ・ショップ・通知・人と比べない | 段は集める物・交換する物にしない。段が下がった・期日が来たの知らせを外に出さない。段を公開しない |
| 文言 | 短い断定の常体・絵文字なし・UI は日本語（段の名前も日本語）。例: 「今日のセット 60秒」「60秒 終わり」「習熟度が上がった: …」「習熟度が上がるのは、各語その日の最初の答えだけ。」「時間切れの語は、記録していない。」 |
| 見た目 | 墨の目盛り＋文字。朱は 1 画面 1 回（主のボタン）、緑・金は使わない、記号の飾りなし |
| キーボード・読み上げ | 新しい操作は select 2 つ（ラベル付き）。60 秒の回のキーは Study と同じ。時計は毎秒読まず、始めと残り 10 秒に 1 回。終わりは見出しに焦点。段は `role="img"` と `aria-label`（見出しのある所では「習熟度」を重ねない）、群は `role="group"`、変化はチップの中の文字、次の段の条件は読み上げる |
| 390／1200・白と黒（夜）・画面キーボード | 時計は `#setProgress`（入力欄より上・画面キーボードに隠れない位置。行は増えない）。語チップ・足元は折り返す。トークンだけで描く。速さの箱は実際の打ち方（最初のキーの経路）で分ける |
| CSP は self のみ・秘密・PII | 外部の部品なし。速さ・段をログ・計測・funnel に出さない |
| 木に他社の名前・モデル名を書かない | docs・コメント・お知らせに書かない |
| SQL は創業者側 | 0 本。Phase 2 の手順だけ書く（docs/FOUNDER_TODO.md E） |

## 9. E2E・単体

### 9.1 守るもの

1. **Study は既定で時間切れしない**: 長さの既定は 15 語のまま。60 秒は `spelldash_set_size = "60s"` か `?set=60s` のときだけ。数の `?set=N` は保存値の `"60s"` に勝つ。`?t=` は 60 秒の回だけ Study に効く（Challenge の 23 か所はそのまま）。24〜40 語を回す節はそのまま通る。
2. **B57_GEOMETRY ±0**（tests/e2e.mjs:3305-3307・3465-3480）: 語数の Study の盤面に要素を足さない。完了パネルの「もう1セット」110・「Challenge（60秒）」162・ボタンの高さ 40／38・語チップの左端と高さは変えない（B57 は既定の 15 語で測るので「もう60秒」にはならない）。§5.4 の行は段が動いた語があるときだけで、B57 の種（新しい語だけ）では出ない。
3. **R3**（:6125-6160）: 正解の 1 打で word_stats の書き込みは 1 回・2MB の parse は 1 回以下。同じ 1 打で `spelldash_mastery_meta` の書き込みも 0 回。
4. **凍った記録**: `rankOf`・`initialRank`・`rankHtml`・`rankBasis`・`rankNext` は stat を書き換えない。全ページの「エラー0」。
5. **`schema_version` は "6"**。欄が欠けた種の stat でも初期値で表示する。
6. 文言・id: 「今日のセット完了」「明日」「思い出せた」「思い出せず」「覚えた（前は出てこなかった語）」・`.word-chip--learned`・`#setRetry`・`#setAgain`・`#setChallenge`（語数のセット）・`#setProgress` の「/ 2」・`#setSizeSelect`・Challenge の「ベスト」・`#resultRetry`・「知ってた」（:3805 は `includes`）・`knownOnSight === true`・`dailyLearningStage >= 4`。
7. タイピングの 2 ページは学習記録を変えない（:922・1478）。mastery.js・masteryMeta.js を読まない。
8. 同期: スタブに届く `word_progress` の行が 15 列のまま（`mastery*` の鍵が無い）。
9. import を足したら `node scripts/modulepreload.mjs`。
10. **CSS の規律（B57-12、:3664-3675）**: 足した CSS の行に `var(--radius)`・`var(--radius-lg)`・`999px`・`rgba(0,0,0`・`#FFF` を書かない。目盛りの角は 1px、角丸のトークンは `var(--radius-room)`。
11. **CI の分割**: 新しい節は「// ===== 」の目印の行で始め、`newPage` から単独で動く（`node scripts/e2e-shard.mjs --check 4` が通る）。

### 9.2 書き換えるもの

- :4625「単語帳: 苦手の語に記憶ゲージ（3/10・復習2日後）」→「単語帳: 苦手の語に習熟度（`.rank[data-rank="1"]`・aria-label に「まだ」）。`.mem__bar` と『/10』が無い」。種（未解決・streak 3・`masteredAt` なし・history は ○ 1 日 → ×）はそのまま 1 になる。
- :4612「覚えた（習得前）の語には記憶ゲージが出ない」はそのまま通る（種は解決済み・streak 3 で段 3。`.rank` を足すだけ）。見出しの文を「記憶ゲージ（/10）が出ない」に揃えるだけ。
- :3759-3762 の設定の節: 選択肢が 4 つ（「60秒」を含む）であることを足す。
- 出題から 200〜1,500ms 待って打つ既存の E2E は、既定の線で初めての答えが「身についた」になり、盤面の文（「知ってた。X はもう身についている。…」）が変わりうる。全件を回して `includes("知ってた")` 以外の完全一致があれば直す。

### 9.3 足すもの

**単体 `node scripts/test-mastery.mjs`**（test-retention.mjs と同じ作り。`TZ=Asia/Tokyo`。CI の ci.yml に 1 行。STATUS §4 に件数。段階 1 は 1〜13 と書き手〔js/stats.js を Node で読む〕の節で 227 件。14 は段階 2 で足す）:

1. `nextRank` 初めての答え: × → 1、ノーミス fast → 4、normal → 3、unknown → 3、slow → 3、打ち間違いあり → 2。
2. 同じ日の扱い: ○ で r 1 → 2、r 3 → 3。朝 ○ の後の × → r 4 → 3（`failedToday` 偽）、同じ日の 2 回目の × → 3 のまま（`failedToday` 真）。23:56 の × → 00:03 の ○ は同じ日の扱い（r 2 → 2）。gap −1（時計の戻り）で ○ r 2 → 2、× r 4 → 3。
3. その日の最初の ×: 5 → 4、2 → 1、1 → 1。
4. 日数が分からない答え（`prevDay === null`・r ≥ 1）: ○ r 4 → 4、× r 4 → 3（1 まで落ちない）。
5. ノーミス: r 2・gap 1 → 3、r 3・gap 5 → 3、r 3・gap 6 → 4、r 2・gap 30 → 3（1 日 1 段）、r 4・gap 20・fast → 5、r 4・gap 19・fast → 4、r 4・gap 20・normal → 4、r 4・gap 20・unknown → 4、r 5・slow → 4、r 5・normal → 5、r 5・unknown → 5。
6. 知ってた語の最初の確認: r 3・gap 14・fast → 5、r 3・gap 13・fast → 4、r 3・gap 14・normal → 4、r 4・gap 14・unknown → 4、知ってた語で確認の前に別の日の答えあり（`knownCheck` 偽）・r 4・gap 14・fast → 4、知ってたでない r 3・gap 14・fast → 4。
7. 打ち間違いあり（Battle）: r 1 → 2、r 4 → 4。
8. `answerContext`: 同じ日・6 時間未満で日付をまたぐ・gap −1・`failedToday`（今日の × あり／昨日の × のみ）・初めての答え・日数が分からない答え・`knownCheck`（streak 1／2、streak 1 でも期日が最後の自力正解の翌日なら偽）。
9. `rankOf`: 欄が勝つ、見ていない ×（`lastRecallFailAt > masteryAt` かつ未解決）で −1、解決済みならそのまま、`masteryAt` と `lastRecallFailAt` が同じ文字列なら下げない、範囲外の値は初期値。`initialRank` の表の各行（history に 6 日以上あいた ○ あり／なし／2 件未満、未解決で最後の × の前に ○ の日 2 日／1 日、`knownOnSight` だけで `lastRecallSuccessAt` なし → 3）。
10. `isFirstAnswer`: playCount 3・答えなし → true、recallFail 1 → false、lastRecallSuccessAt あり → false。
11. `classifySpeed`: 19 件・初めての答え・en.kbd・1,400ms → fast（prior）／1,600ms → unknown／en.touch・2,000ms → fast／初めてでない → unknown／ja → unknown／2,500ms → unknown（既定から slow・normal は出ない）。20 件: 200ms 未満 → unknown、0.75 倍ちょうど → fast（own）、1.5 倍ちょうど → normal、1.5 倍超 → slow、pc の箱 19 件なら pc を見ない（fast も slow も）、pc の箱 20 件で 2 倍超は fast にしない・2.5 倍超で slow。入れるとき 7,000 で丸める、41 件目で古い 1 件を捨てる、箱のキー 8 つ（en／ja × kbd／touch × study／play）。
12. `rankBasis`・`rankNext`: 表の各枝（初期値・未解決・確認待ちの段 3／4・N日あけて・history 不足で括弧なし・日付が過去なら「次に」・段 5 は無し）。初めての答えで入った語の文に「日をあけ」「6日以上」が無い。
13. `holdBeforeDue`: 段 4・期日が未来 → 真、期日が過去 → 偽、確認待ちの知ってた語・段 3 → 真、段 3・`includeRank3` で期日が未来 → 真、段 4・段 5 から × と打ち直しをした苦手の語（期日は翌日）→ 偽（`includeRank3` でも）。
14. 段階 2: `intervalAfter` — 予定どおりの列 1・2・3・5・7・10・14・21・30 が今と同じ、初見の知ってた語 → 14（credit なし）、確認 → fast 30／normal 21、段 4 の × の翌日 → 7、gap 40 → 30（上限）、slow → credit なし、gap が NaN・0 → credit なし。`keepLaterDue` — 未来の期日は早めない・過去の期日は新しい方。

**E2E 節「mastery: 9.565」（1〜3・11 と CSV。画面）と「mastery writers: 9.566」（4〜10・12・13 とタイピングの 2 ページ。書き手・速さ・同期・S6）**（どちらも「9.56 記憶の保持率」の節の後。`newPage` から単独で動く。§9.1-3 の mastery_meta の 0 回は Batch 58 の R3 に足した）:

1. 単語帳: `initialRank` の各行を種にした語で `.rank[data-rank]` の値・aria-label の名前・`.rank__name` の文字・`title` に根拠の文。`.mem__bar`・「/10」なし。題箋と段の組み合わせ（覚えた＋あやふや・習得＋思い出せる・苦手＋身についた）の種を入れて 390／1200 × 昼・夜を撮る。320／390 で横スクロールなし。
2. 語の詳細: 習熟度の行（根拠の文）・段の梯子（今の段が太字）・次の段の条件・畳んだ「習熟度の決まり」（Enter で開くと規則の文）。初めての答えで段 4 の語に「日をあけ」「6日以上」が無く「初めて答えて」がある。未解決の語に「思い出せなかった」がある。title に「思い出せた」が無い。aria-label に「習熟度」が重ならない。
3. 学習データ: 習熟度の節の行・語数・説明の文、知ってた語を含む段だけ「（うち知ってた M語）」、0 の行が無い、「%」が無い、注記に規則の文と「この端末の記録から」。
4. 書き手（Study）と速さ: 1 語目は捨てて（ページの最初の語は測らない）2 語目で測る。訳が一意で `isAmbiguousPrompt` でない語を選ぶ。(a) 本人の基準を 20 件（中央値 2,000ms、`en.kbd.study`）種にして、初見の語を出題から 400ms 待って打つ → `masteryRank` 4・`masteryAt` あり・文「知ってた。X はもう身についている。2週間後に確認」。(b) 基準なし・400ms → 4。(c) 基準なし・1,800ms（kbd）→ 3・文「知ってた。X は2週間後に確認」（「もう一度だけ」が無い）。(d) 基準なし・2,500ms → 3。(e) 390 mobile・基準なし・`#osk` のキーを押して 1,800ms → 4（`page.press` は物理キーの経路になるので使わない）。
5. 段 3・`lastRecallSuccessAt` 8 日前の種 → ノーミス → 4、文に「習熟度 身についた」。続けて同じ日に × → 3、同じ日の 2 回目の × → 3 のまま。段 4・前の答え 1 日前の種で × → 3。書くたびに `rankOf(stat) === masteryRank`（モジュール直呼びで読む）。
6. 初見の直し: playCount 2・答えなしの種 → ノーミス → `knownOnSight === true`。
7. 測らない答え: 音で出題の語・ヒントの語・出題後にタブを裏にした語（`document.hidden` と `visibilityState` の両方を偽装）・ページの最初の語では基準の件数が増えない。正解の 1 打で `spelldash_mastery_meta` の setItem が 0 回、`endStudySession` で 1 回、変わっていないまま `stopGame` で 0 回。
8. Battle 型の呼び方（モジュール直呼び）: `recordRecallFail(id)` で段 −1、`recordCorrect(id, false)`＋`recordRecallSuccess(id)` で 2 より上がらない、`recordCorrect(id, true)`＋`recordRecallSuccess(id)` で 5 にならない。段の欄なし・streak 5・前の答え 3 日前の種で `recordCorrect(id, true)`＋`recordRecallSuccess(id)` → 3（`recordCorrect` の後の streak 6 で 4 と読まない）。`recordCorrect` だけ呼んだ次のタスクの `recordRecallSuccess(別の id)` に `pendingAnswer` が持ち越されない。
9. 語数のセットの完了パネル: 段 2 の語を種にしてノーミス（翌日扱い）→「習熟度が上がった: X（思い出せる）」の行。段 5・前の答え 30 日前の種を 2 語目に出して遅く正解（本人の基準 中央値 2,000ms を種にして 3,500ms 待つ）→「時間がかかった」が出て「下がった」が出ない。「覚えた」のチップの語は行に出ない。新しい語だけの回では行が無い。
10. Challenge の結果（`?t=3`）: 段が動いた語の行、「ベスト」と `#resultRetry` は残る。
11. マイ単語帳: 知ってた語に「知ってた」、「undefined」が無い。
12. 同期: 送る行が 15 列。`schema_version` "6"。エラー 0。
13. S6（段階 1）: 段 4・期日が先の語と確認待ちの知ってた語（段 3）は、ほかの候補があれば補充に出ない／期日が来たら出る／ミッションの復習に出ない（段 3・期日が先の語も）／息抜きに出ない／補充の候補が足りないときは出る／× の後に打ち直した苦手の語（段 3・段 4。期日は翌日）はミッションの復習に入る。保持率の節が通る。

**E2E 節「study 60s」**（「9.4 今日のセット」の節の後。`spelldash_set_size: "60s"` の種。時間切れだけを見る回は `?t=3`、答える回は `?t=8`）:

1. 設定: `#setSizeSelect` に 4 つの選択肢、「60秒」を選ぶと `"60s"` が保存され、注記の文が替わる。開き直しても `#setSizeSelect.value === "60s"`、`#setLengthSelect.value === "60s"`。要約に「60秒」。道の 1 行が「今日のセット 60秒」で「約5分」を含まない。`#pathStart` はちょうど 1 つ。「ほかの遊び方」は今の行数のまま。保存値 `"60s"` で `?set=3` を開くと 3 語の語数の回（時計なし）。
2. 始める（`?t=8`）: `#setProgress` に「秒」と「残り」。`#bigTimer` は hidden、`body.is-playing` なし、BGM が鳴らない。始めに `#srStatus` が「8秒」。
3. 時間切れ（`?t=3`、画面の語に何も打たない）→ パネル。その語の `recallFail`・`lastRecallFailAt`・`history`・`masteryRank` が変わらない。
4. 1 語以上思い出せた回（`?t=8`）: 見出し「今日のセット完了」、習熟度の群（段の名前の文字）、題に語数が無い、「初めて」「上がった」「下がった」の文字、「Pro」「ベスト」「スコア」が無い、焦点が `#resultTitle`、`#setAgain` が「もう60秒」、`#setChallenge` が無い、`isDailySetDone()` が真、`spelldash_session` が変わらない。回の間に `#learnToast` の中の `.hasumi` とスタンプが出ない。
5. 0 語の回（`?t=3`）: 見出し「60秒 終わり」。何も打たない回ははちゃん「時間切れの語は、記録していない。」で群も題も無い。Enter で答えを見た回は「思い出せなかった語は、次の回の最初に出る。」と まだ の群。どちらも `isDailySetDone()` は偽のまま。続けてホームのはちゃんが「続きから。」を言わない。
6. 止める（`?t=8`）: `document.hidden` と `visibilityState` を偽装して visibilitychange を発火 → 残りが減らない。戻すと減り始め、戻した直後に一気に減らない。
7. 同じ日の 2 回目（`?t=8`）: 今日もう答えた語が出たら「習熟度が上がるのは…」の行。
8. 腕試し前の人は 60 秒の設定でも腕試しの 10 語。パネルの「思い出せなかった N語をもう一度」は語数で走る。腕試しの完了パネルの `#setAgain` が「もう60秒」。`resetTutorial` の後の回も語数で走る。
9. キーボードだけ（`?t=8`）: Enter で開始 → 答える → 時間切れ → 末尾から Shift+Tab（または語チップの数だけ Tab）でボタン → Enter「もう60秒」で同じ長さが始まる。
10. 390 mobile（画面キーボード）・1200 × 昼・夜で撮る。320 で横スクロールなし。時計の行が画面キーボードに隠れない。
11. 回の長さ: `?t=60` で 16 語以上思い出しても回が終わらない。setSize 25 の続き（`spelldash_session`）がある人が 60 秒の設定で `#pathStart` を押すと 60 秒の回が始まり、`spelldash_session` は変わらない。長さを 25 語に戻すと続きから始まり 25 語で完了し、保存の setSize も 25 のまま。
12. プレイ中の長さの変更（`?t=8`）: 60 秒の回の途中で `#setLengthSelect` を 15 語にしても回は 60 秒のまま終わり、次の回は 15 語。

## 10. 創業者に確かめたい既定（答えが無ければ既定で進める）

| # | 問い | 既定（このまま作る） | 代案 |
|---|---|---|---|
| Q1 | 60 秒の入口と、今日のぶんへの数え方 | 今日のセットの長さに「60秒」を足す（設定とホームの出題設定の 2 か所。スタートは 1 つのまま。60 秒を選んでいる間は、語数のセットの続きより 60 秒を始める）。自力で思い出せた語が 1 語以上の回は今日のぶん済み（7 日のドット・解放の数に入る。回ごとに 1 セット）。1 日の約束が「15語・約5分」から「60秒・1語以上」に変わり、解放の累計が回ごとに進む（付録 B.5）ことを FOUNDER_TODO の問いの文に書く | (a) 出題設定の「60秒で区切る」トグルにして、思い出せた語を今日のセットの語数に足す（語数に届いたら完了。60 秒 1 回では完了にしない）。(b) 60 秒は今日のぶんに数えない。(c) 既定のまま、解放の累計（`bumpTotalSets`）だけ 60 秒の回は 1 日 1 回まで数える |
| Q2 | 段の名前と、速さを使うか | 「まだ／あやふや／思い出せる／身についた／即答」。速さ（出題から最初のキーまでを本人の中央値と比べる。使い始めは初めての答えに限り既定の線 1.5 秒／画面キーボード 2.1 秒）は即答と初見の身についただけに使う。秒数は出さない | 段 2 を「うろ覚え」に（題箋「覚えた」と同じカードに並ぶ）／段 1 を「出てこない」に（「まだ 12語」が「残り 12語」と読める。ただしパネルの「前は出てこなかった語」と字が近い）／速さを使わず、最上段を「20日以上あけて2回思い出せた」などにし、名前を「熟知」にする |
| Q3 | 復習の間隔を段とつなぐか（apple を何度も出さない） | つなぐ。段階 1 で S6（身についた以上の期日前の語と、2 週間後の確認を待つ知ってた語を補充・ミッション・息抜きに出さない）。段階 2 で S1〜S5（正解で期日を早めない、日をあけて思い出せた語は間隔を伸ばす、下限は身についた 7 日・即答 30 日）。apple は 106 日までに 10 回＋補充 → 段階 1 で 10 回 → 段階 2 で 5 回。予定どおり続ける人の間隔と保持率の測り方はほぼ変わらない | 段は見せるだけにし、出題と間隔は今のまま（apple は今どおり 10 回＋補充で出る）／S6 だけ入れて間隔は今のまま |
| Q4 | 打ち間違い 1 回で下がった段の戻り方 | 今の規則のまま（即答の apple を 44 日目に appel と打つと、即答に戻るのは 97 日目。その間に復習が 4 回。§3.7 の表を見せて聞く） | × で下がった語は、翌日以降のノーミス正解（遅くない）で、下がる前の段まで 1 日 1 段、間の日数の条件なしに戻す。下がる前の段は端末だけの欄 `masteryPeak` に控える（同期しない・SQL 不要） |

---

## 11. 実装で決めたこと（仕様の穴を控えめに埋めた所。段階 1）

### 11.1 段の規則と記録（js/mastery.js・js/masteryMeta.js・js/stats.js・js/studyQueue.js）

1. `isFirstAnswer` に「習得・知ってた・ノーミス連続のある語は初見と読まない」を足した。§3.3 の 3 条件だけだと、日時の欄ができる前の記録で日時が無いまま習得・連続正解を持つ語が、次のノーミス正解で知ってた扱いになり streak が 1 に戻る。段 0（`answered` が偽）と同じ意味にそろえた。§9.3 単体 10 の 3 例の真偽は変わらない。
2. `initialRank` の「知ってた語で streak 1 → 3」を「streak 2 未満（1・0・欄なし）→ 3」と読んだ（§9.3 単体 9 の「knownOnSight だけの種 → 3」と合わせる。streak 0 は初見のあとの打ち間違いありの正解で、書き手でも 3 から下げない）。
3. `rankNext`: 確認待ちの知ってた語で確認の日が過ぎていれば「次の確認で」（「以降に → 次に」と同じ扱い）。前の答えの日が分からない古い行は日付を言わず「日をあけて／6日以上あけて／20日以上あけて」（次の答えは同じ日の扱いで上がらないので、日付を約束しない）。
4. `rankBasis`: 日付が取れない枝は日付の部分を省く。
5. 補充が足りないときの埋めでは、期日前に出さない語（S6）は別ユニットの未出題語より後に戻す。
6. `check.since` は最初に確かめの記録を書いた日。`check.pending` に同じ語を入れ直すと新しい側へ移す。pc は丸めない（丸めは T1 だけ）。
7. `recordRecallSuccess` は `pendingAnswer` を使ったら消す（同じタスクで 2 回使わない）。
8. `spelldash_mastery_meta` の 10 答えごとの保存は stats.js の書き手の中で数える（Battle の答えも数える）。10 答え目の 1 打では 1 回書く。E2E の「正解の 1 打で 0 回」はその 1 打が 10 答え目でないときに測る。
9. 確認待ちの知ってた語（`isKnownWaiting`。`knownCheck`・`rankBasis`・`rankNext`・S6 が読む）は、streak 1 に加えて「期日と最後の自力正解の両方があれば、期日が最後の自力正解から 13 日以上先」とした。streak だけだと、知ってた語が打ち間違いありの正解（Battle。streak 0）のあと別の日のノーミスで streak 1 に戻ったとき、もう一度確認待ちと読み、語の詳細に「M月D日に初めて答えて…」（事実と違う）、次の条件に「M月D日の確認で すぐ打てると 即答」（翌日は gap 1 で守られない）と出て、14 日あけると 3 → 5 と飛んだ（打ち間違いの無い同じ流れは 3 → 4）。初見の知ってたは期日を 14 日後に置き、同じ日の答えは期日を動かさない。別の日の答えがあると期日は streak の間隔（1〜2 日）に戻るので見分けられる。期日は同期する欄なので 2 台目でも同じに読める。日時の欄の無い古い行は streak だけで読む（今までどおり）。stats.js の控えの `knownBefore` もこの関数で取る。
10. S6（`holdBeforeDue`）は苦手（未解決。最後の × が最後の自力正解より新しい）の語を外さない。Study の × は答えを見た打ち直し（`recordCorrect` の非 clean の枝。今の処理）で期日が翌日になるので、期日で判断すると、身についた・即答の語が × で苦手になったとき 24 時間ミッションの復習から外れていた。§6 S4「× の後、期日は今」と L5（苦手の語を毎日見直すミッションの役目は変えない）に合わせた。

### 11.2 60 秒の回と速さ（js/game.js ほか）

1. 動きを減らす設定では、時計の棒の幅を替えない（「棒は動かない」を字のとおりに読んだ。残りは数字だけが言う）。
2. 見出し「60秒 終わり」とボタン「もう60秒」は `?t=N` でも字のまま（長さの選択肢の名前）。時計のラベルと始めの読み上げは `?t` に従う。
3. 次の回が 60 秒か: 待ち受けの文と `#setAgain` は「長さが 60 秒・腕試し前でない・チュートリアルの回でない」。道の 1 行と `startUnit` は「長さが 60 秒・チュートリアルの回でない」（腕試しの案内は今の文が先に決まる）。回そのものは `startGame` が `isPlacementRun()` で決める。
4. 出題の要約の「› 60秒」は設定を言うので、腕試し前・チュートリアルの回の前でも出す。
5. 語チップの `max-width: 100%` と中での折り返しは 60 秒のパネルの群（`.rank-group .word-chip`）だけに付けた（語数のセットの語チップの寸法〔B57〕を変えない）。
6. 例文の訳を添える問いの判定（`isAmbiguousPrompt`）は、例文の有無によらず「訳だけで決まらない問い」を測らない。カテゴリ × 語でキャッシュし、測るとき（自力・ノーミスの正解）だけ呼ぶ（Challenge の待ち 0 の次の語を遅らせない）。
7. 前の語の続き（spill）が生きている間に来た打鍵がこの語の最初の打鍵になった語は測らない（§3.4 の「続きの字が最初の字になった語」より少し広い。控えめな側）。
8. 60 秒の回の「覚えた！」は音だけ残し、スタンプ・盤面の光・`#learnToast` は出さない。
9. 続きからの回の語数は保存した `setSize`（§4.0）。以前は今の設定の語数だった。
10. ホームのはちゃん: 語数の設定でも続きが無ければ「今日はまだ途中。」（以前は続きが無くても「続きから。」と言っていた）。
11. 60 秒の回の始めの「復習 N・…から」の行と、週の目標を達した日の 1 行は今のまま残す。
12. 道の「初回」の判定（記録が 1 件も無いと腕試しの案内）は今のまま。腕試し済みで記録が空の人は、道は腕試しの案内、回は 60 秒になる（語数の回でも同じずれ）。
13. ホームの出題設定で長さを替えたら、道と要約に加えてはちゃんの紙片も描き直す（続きがある人が 60 秒に替えると、道から続きが消えるのに紙片だけ「続きから。」と言っていた。§4.8）。待ち受けの文「Enter で開始（60秒）」は描き直さない（ホームでは #message が空で見えない）。
14. 長さの 2 つの select（#setLengthSelect・#setSizeSelect）に `autocomplete="off"` を付けた（履歴で戻ったとき、ブラウザのフォームの復元が保存値を古い選択で上書きしていた）。bfcache で戻すブラウザ向けに、pageshow（`persisted`）で保存値と違えば合わせ直して描き直す。

### 11.3 画面（単語帳・語の詳細・学習データ）

1. 単語帳の 390 の既定は簡潔表示で、足元（`.gcard__foot`）ごと隠れるので段は見えない（記憶ゲージも同じだった）。「詳しく」に切り替えると出る。簡潔表示の 1 行目に足すと題箋の列と当たり判定の作りが変わるので、しなかった（docs/BACKLOG.md）。
2. 学習データの「（うち知ってた M語）」は題箋と同じ「知ってた」（`classifyWord(stat) === "known"`。習得に届いた知ってた語は含まない）で数える（付録 D の C4、ホームの「覚えた N語」が除くのも同じ語）。
3. 学習データのタブの切り替えは節の `hidden` を上書きするので、中身の無い節（`data-tab-empty`）はタブを開いても出さない。
4. 語の詳細の 2 行目: 梯子と次の条件の間の「・」は梯子と一緒に読み上げない（読み上げは次の条件の文だけ）。
5. `initialRank` の「自力正解が無い（習得でもない）→ 1」の行は、日時の無い古い記録でしか通らないので単体だけで確かめる。

### 11.4 E2E

1. 節の名前は「study 60s」（60 秒）・「mastery: 9.565」（画面）・「mastery writers: 9.566」（書き手・速さ・同期・S6）。節の重さの表（scripts/e2e-shard.mjs の SECONDS）には CI の秒が出てから足す（それまでは行数から見積もる）。
2. §9.3 E2E 習熟度 9 の「『時間がかかった』が出て『下がった』が出ない」: 語数のセットの完了パネルの行は §5.4 の形（「習熟度が下がった: stone（身についた・時間がかかった）」）なので、その語の項に「・時間がかかった」が付くことを見る。60 秒の終わりのパネルでは、語チップの文字が「時間がかかった」で「下がった」を含まないことを見る。
3. 画像は E2E に保存しない（ほかの節と同じ）。390／1200 × 昼・夜と 320 の寸法・計算した色・横スクロールを検査する。
4. Challenge の結果の検査は `?t=4`（出てから 0.3 秒の Enter は飲まれるので、答えを見るまでの余裕をとる）。
5. 7.5・7.6 のお知らせの検査は、先頭の 1 件でなくリンク（./typing.html・./typing-game.html）で項目を探す（お知らせは新しい順に先頭へ足すので、2026.10.12 の項で位置がずれて落ちていた）。

## 付録 A. 変えるファイル

| ファイル | 段階 | 変更 |
|---|---|---|
| js/mastery.js（新） | 1・2 | `RANK_NAMES`・`RANK_GLOSS`・`RANK_RULE`・`isFirstAnswer`・`answered`・`isUnresolved`（写し）・`answerContext`・`nextRank`・`initialRank`（history の判定込み）・`rankOf`・`rankHtml`・`rankBasis`・`rankNext`・`holdBeforeDue`・定数。段階 2 で `intervalAfter`・`keepLaterDue`。import は js/retentionCalc.js だけ |
| js/masteryMeta.js（新） | 1 | 速さの箱（`boxKey`・`classifySpeed`・`noteSpeedSample`・`COLD_FAST_MS`）、確かめの集計（`noteRankCheck`・`notePendingFirstFast`・`firstMedian`）、`flushMasteryMeta`（dirty のときだけ）・`forgetMasteryMeta`、pagehide で書く |
| js/stats.js | 1・2 | `recordCorrect` の先頭で `pendingAnswer`。`recordRecallSuccess(word, answer?)`・`recordRecallFail` で段を書く（`nowIso` を 1 回だけ取る）。知ってたの条件を `isFirstAnswer`。段階 2 で S1〜S3 |
| js/game.js | 1 | `runKind`・`runSize` と `currentSetSize()`、語ごとの時刻（`setNewWord` の後の rAF・`acceptChar`・`handleTypingMiss`・ローマ字の受理と miss・spill の字・visibilitychange）と最初のキーの経路、`answerContext`・`classifySpeed` と `answer`、`runRankBefore`（prevStat から）、60 秒（`timer` に載せた時計・止める・時間切れ・待ち・スタンプと `#learnToast` のはちゃんを出さない・幕なし・続きを触らない）、`renderSetProgress` の 60 秒、`endStudySession({ timed })` のパネル、`#setAgain` の「もう60秒」、§5.4・§5.5 の行、`applyStudyXp` の文 2 つ、learnEvent の known の条件、`showIdleMessage` |
| js/dailySet.js | 1 | `SET_LENGTHS`・`getSetLength`・`isTimedSet`（数の `?set=` が勝つ）・`?set=60s`・`setSetSize` |
| js/tutorial.js | 1 | `isTutorialRunPending()` を export |
| profile.html・js/profileView.js | 1 | 「今日のセットの長さ」・選択肢「60秒」・注記・初期値を `getSetLength()`・meta description と og:description |
| index.html・js/main.js | 1 | `#setupPanel` の `#setLengthSelect`（`getSetLength()`）、要約の「60秒」、`startUnit` は 60 秒のとき続きを見ない |
| js/pathView.js | 1 | 右頁の 1 行（60 秒・続きの文を出さない・「今日のぶんは完了 ・ 次は60秒」） |
| js/hasumi.js | 1 | `hasumiSetLine` に `timedEmpty` の 2 通り、`hasumiHomeLine` の「今日はまだ途中。」 |
| js/listView.js・js/learnedWords.js | 1 | 足元の段（title に根拠）・`memoryGaugeHtml` を消す |
| js/wordDetail.js | 1 | 習熟度の行（根拠）・段の梯子・次の段の条件・畳んだ「習熟度の決まり」・title |
| js/statsView.js・stats.html | 1 | 習熟度の節（説明・うち知ってた・規則の文） |
| js/exportCsv.js・js/myWordsView.js | 1 | `mastery` 列・`known` の名前 |
| js/studyQueue.js | 1 | 初見の条件（:565）。S6（`pickFillers`・`insertBreather`） |
| js/mission.js | 1 | S6（`pickReviewWords`。段 3 で期日が未来の語も外す） |
| js/backup.js | 1 | `clearLocalRecords` と `applyBackup` の後に `forgetMasteryMeta()` |
| css/brand.css | 1 | `.rank`・`.rank__name`・目盛りの 5 行（全ページが読む） |
| css/card.css | 1 | `.rank-group`・`.rank-groups__title`・`.word-chip__move`・`.word-chip` の `max-width` と折り返し・`.rank-moves` |
| css/pages.css | 1 | `.rank-ladder`・`.rank-rule`・`.word-detail__rank`・学習データの表と説明。`.mem` の単独の規則を消す |
| css/home.css | 1 | `.setup` の中の `.setting-select` |
| tests/e2e.mjs・scripts/test-mastery.mjs・.github/workflows/ci.yml・各ページの modulepreload | 1・2 | §9 |
| docs | 1・2 | SPEC_MASTERY.md（新。この仕様の確定版）・STATUS §2・§4・CONCEPT §9・KEYBOARD.md（60 秒のキーは Study と同じ、と 1 行）・CHANGELOG・BACKLOG（段の絞り込み・推移・状態の呼び名の表を 1 か所に（題箋と段の 3 組）・即答の 60／90 日・Phase 2 の同期・§3.8 の見直し日・右頁の「約5分」が語数によらない・時間切れのときにほかの窓で打っていると `focusResultTitle` が焦点を奪う）・FOUNDER_TODO（F に Q1〜Q4、E に Phase 2 の SQL の手順）・SPEC_RETENTION §4（段階 1 と段階 2 の 1 行ずつ）。お知らせ 1 件（js/news.js）「単語ごとの習熟度（5段）が単語帳と終わりの画面に出る。今日のセットの長さに60秒を足した。」 |

## 付録 B. 残るリスク

1. 仮の値（0.75・1.5・2・2.5 倍、6・20・14 日、20 件、6 時間、既定の線 1.5／2.1 秒）は推定で、研究の原典も確かめていない。§3.8 の集計で 2〜4 週後に見直す。
2. 使い始め（各箱の T1 が 20 件未満）は、初めての答えだけ既定の線で「すぐ」を決める。線より遅い人・ローマ字の答えの初見の語は思い出せるどまり（控えめな側）。線が甘すぎると、知っていたが少し迷った語が身についたになる（差は 1 段。§3.8 の `firstFast.prior` で見る）。基準が 20 件たまる前の 2 週間後の確認では即答にならず、20 日以上あけてすぐ打てたときに届く。
3. 段は端末ごと。もう 1 台の ○ は効かない（× は 1 段として読む）。揃えるのは Phase 2（SQL が先）。
4. 新出の語は初日に まだ／あやふや に入り、思い出せる に上がるには翌日以降のノーミス正解が要る。60 秒だけで短く回す人は、翌日に同じ語へ戻る前に回が終わりやすく、あやふや に溜まりやすい。段の表で見えるので気づける。
5. 60 秒の回ごとに 1 セットと数えるので、Daily（2 セット）・Battle（5 セット）の解放が早く進む（Q1 の代案 (a)・(c) なら起きない）。
6. S6（段階 1）で強い語・知ってた語が補充に出なくなり、段階 2 で強い語の確認が遅くなる。保持率の母数の偏りを SPEC_RETENTION §4 に書く。語の少ない人は補充の候補が足りずに戻ることがある。
7. 全文入力・音で出題・例文の訳つきの語は速さを測らないので、即答に届くのは綴りを打つ語とローマ字の答えが主になる（ローマ字の答えは本人の基準ができてから）。
8. E2E の打鍵は速すぎて T1 が 200ms を割る。速さを見る節は出題から 400ms 以上待って打ち、基準は種で入れる。既定の線の境目（1.5／2.1 秒）を跨ぐ待ちは 300ms 以上の余裕をとる。
9. 本人の基準は相対なので漂う（強い語ばかり答える人ほど中央値が下がり、即答が出にくくなる）。§3.8 で段 5 の割合の推移を見る。代案は、知ってた語の初見の T1 の中央値を「考えずに出る速さ」の基準にすること。
10. 2 つのタブで同時に学ぶと `spelldash_mastery_meta` は後勝ち。集計が少しずれるだけ。
11. 題箋（何が起きたか）と段（どれだけ強いか）は別の物差しなので、同じカードで食い違って見える組み合わせが残る（覚えた＋あやふや・習得＋思い出せる・苦手＋身についた）。語の詳細の根拠の文で説明し、呼び名の表は BACKLOG。

---

## 付録 C. 採点表（3 案）

1〜5 点。5 がいちばん良い。

| 物差し | 学習科学の案 | 体験の案 | 最小の案 |
|---|---|---|---|
| 1. 創業者の指示に応えているか（りんご → apple・語ごとの可視化・学習モードの 60 秒・その時点の習熟度） | **5** — apple を初見で上に置き、14 日後にすぐなら即答、出し直しも減らす。「考えずに出る」を速さで表す。4 つとも満たす | **5** — 同じく 4 つを満たす。「1打ミス／思い出せず」の理由を添えて「ど忘れ」に答え、Challenge／Daily にも語を出す | **3** — 語ごとの段・60 秒・終わりの段は満たす。速さを使わず、apple は今どおり何度も出る。1 回のつまずきで「まだ」に落ちる |
| 2. 測り方の正しさ（誤って上げない・下げすぎない） | **5** — その日の最初の答えだけ・1 日 1 段・× は 1 段・× の日から数える・速さは本人の基準・遅い即答は下げる・初期値は控えめ・Battle の答えも筋道を持って扱う | **4** — 骨組みは同じ。21 日あければ速さなしで「即答」（名前が実態より強い）、基準が無い間は固定の秒数で「すぐ」を決める（反証のあと、初めての答え・速い側・英語だけに絞って採った。付録 D）、Battle の × で段が動かない | **2** — streak を軸にするので、期日前の補充の正解でも毎日上がる（別々の日 5 回で身についた）。つまずきの無い語は 2 日で最上段。1 回の × で「まだ」まで落ちる |
| 3. 規則と矛盾しないか（モード・はちゃん・Pro・誇張） | **4** — 6 条件を満たす。段の名に「定着」を使い、保持率の「定着」と食い違う | **3** — 6 条件を満たすが、増えた枡を金で塗る（金は「済み」の色）、速さなしの即答は誇張に近い | **5** — 最小の足し算で、速さを測らないうちは即答と名乗らない |
| 4. 今の記録・同期・E2E を壊しにくいか | **3** — 欄 2 つ・別キー・計測の差し込み・SRS の S1〜S6 で広く触る。段階を分け、R3・凍った記録・schema 6・15 列を守る手立ては具体的 | **3** — 欄 2 つ・別キー・下限と補充の変更・Challenge／Daily の結果に語チップ。守りは具体的 | **5** — 新しい欄・保存なし、SRS は変えない、E2E の書き換えは 1 件 |
| 5. 分かりやすさ（390・読み上げ・色だけに頼らない） | **4** — 目盛り＋名前、変化は文字、記号なし、群は段ごと。詳細は 1 行で簡潔 | **4** — 段の梯子は初めての人に分かりやすい。語チップに英・訳・枡・名前・前の段・理由が並び、390 で重い。金の塗りは色だけの手がかり | **4** — 目盛り＋名前で簡潔。変化を ↑↓ の記号で見せる（読み上げ用の文は付ける） |
| 6. 作る量と保守 | **2** — 計測・基準・規則 R1〜R8・集計・SRS の表の変更と多い | **2** — 計測・基準・下限・2 か所の設定・結果パネル 2 種・はちゃんの新しい台詞と多い | **5** — 新しい js 1 本（約 70 行）と表示の差し替えが中心 |
| 合計（素点） | **23** | **21** | **24** |
| 合計（1・2 を 2 倍） | **33** | **30** | **29** |

- 土台に選んだのは学習科学の案。素点では最小の案が 1 点上だが、物差し 1（創業者の指示）と 2（測り方の正しさ）はこの作業の目的そのものなので 2 倍で比べた。最小の案は作りやすいが、創業者の例の apple が今どおり何度も出て、1 回の打ち間違いで「まだ」に落ちるので、指示の芯に届かない。
- 接ぎ木したもの:
  - 最小の案から: 60 秒を今日のセットの長さにする形（`"60s"`・`getSetSize()` は 15 を返す・`?set=60s`）、Study のキューを変えない（新出の数を絞らない）、`#setProgress` の同じ 3 要素で時計を出す、待ち受けの「Enter で開始（60秒）」、続きからの地点を残さない、0 語の回は今日のぶんにしない、今の `hasumiSetLine` を使う、記録の欄を 2 つに絞る（最長の間隔の欄はやめた）、確かめの集計を段ごとの数にする、解放が早まるリスクの明記。
  - 体験の案から: 設定とホームの出題設定の 2 か所で長さを選ぶ、語の詳細の段の梯子、答えの種類（英語／ローマ字）で速さの箱を分ける、初見の判定を「まだ答えていない」に直す（3 か所）、古い版・2 台目の答えを短く見積もる考え（`masteryAt` と「見ていない ×」）、60 秒の終わりの「もう60秒」と Challenge のボタンを並べないこと、残り 10 秒の 1 回だけの読み上げ、`?t=` は 60 秒のときだけ Study に効かせる、Challenge／Daily の結果に語を出す（行の形に軽くした）、送る行が 15 列のままかの検査、Battle の検査、基準が無い間の既定の線（反証のあと、初めての答え・速い側・英語の綴りだけに絞って採った。即答には使わない）。
  - 学習科学の案で変えたもの: 段 4 の名を「定着」から「身についた」に、60 秒をトグルから長さに、SRS の間隔の表を 60／90 日まで延ばす案は 30 日までに（延長は BACKLOG）、速さの集計（速さ × 結果）は前の答えの速さを語ごとに持つ必要があるのでやめ、初見ですぐの語の次の結果だけを数える形にした、最長の間隔の欄（`maxRecallGap`）はやめて詳細はその語の事実の文（`rankBasis`）で言う、60 秒の新出 2 語の上限はやめた（Study のキューのまま）。
  - 採らなかったもの: 体験の案の金の塗り（金は「済み」の色）・語チップの「1打ミス／思い出せず」の添え書き（390 でチップが重い。下がったことは文字で出し、正解の遅さで下がったときだけ「時間がかかった」）・既定の秒数で即答を決めること・既定の秒数で遅い側を決めること（遅い人・スマホの人の初見の語を下げる）・Battle の答えで段を動かさない扱い（Battle の × のあとも段が高いままになる）。最小の案の ↑↓ の記号（記号の飾りを使わない）・streak を軸にした段（期日前の正解でも上がる）。

---

## 付録 D. 反証の対応

視点: 論理＝段の規則と記録、流れ＝60 秒の回・画面・E2E、創業者＝指示の芯と見え方。親＝統括からの指摘。

### D.1 親の指摘

| # | 指摘 | 結論 | どう直したか |
|---|---|---|---|
| (a) | 使い始めの人は速さの箱が 20 件たまるまで「すぐ」と言えず、初見の apple が思い出せるどまり | **採る。ただし絞る**: 本人の箱が 20 件未満の間、初めての答え・英語の綴りに限り、既定の線（物理キーボード 1,500ms・画面キーボード 2,100ms＝既定の中央値 2,000／2,800ms × 0.75）以下なら「すぐ」。既定から遅い・ふつうは出さず、pc も見ない。即答（3→5・4→5）は本人の基準 20 件以上のときだけ。ローマ字の答えは既定なし | §0-4・§1・§3.4（分類の表・定数・根拠・外れの向き・絞る理由）・§3.5 守り 4・§3.7 0 日目・§3.8 `firstFast`・`firstMedian`・§9.3 単体 11・E2E 習熟度 4・付録 B-2・付録 C。あわせて速さの箱の時計の軸を Study／遊びに替えた（60 秒に切り替えた直後に基準が空にならない） |
| (b) | 段 3 の意味の文「日をあけても思い出せた」が初見のノーミス正解に出ると事実と合わない | **採る**: 段ごとの決まり文句を語の詳細に出すのをやめ、その語の事実（`rankBasis`: 日付・あけた日数・初めて答えて打てた・思い出せなかった）と次の段の条件（`rankNext`）を出す。学習データの行の説明 `RANK_GLOSS` は、入り方のどれを通っても真になる文に作り直した（段 3「間違えずに思い出せた」、段 4「6日以上あけて思い出せた（初めてで、すぐ打てた語も）」、段 5「2週間以上あけて、すぐ打てた」）。`KNOWN_CHECK_DAYS` を 14 に | §3.1（表・`RANK_GLOSS`・`RANK_RULE`）・§3.5・§5.2（2 つの表）・§5.3・§5.6（初見の日は「もう身についている」）・§9.3 単体 12・E2E 習熟度 2 |

### D.2 mustFix（11 件。すべて反映）

| # | 視点 | 項目 | 対応 | どう直したか |
|---|---|---|---|---|
| M1 | 論理 | 既定の基準（親 a） | 反映 | D.1 (a) のとおり。論理の案（初めての答え・速い側・英語だけ、即答は本人の基準）をそのまま採った。S6 に確認待ちの知ってた語を段に関係なく足した（§6） |
| M2 | 論理 | 段の意味の文と入り方（親 b） | 反映 | D.1 (b)。論理の案の `rankNote` と確認待ちの差し替えは `rankBasis` の枝に入れた。論理の案の RANK_NOTES 本体（段 3「1日以上あけても」）は、初見ですぐ（4）の語が × で 3 に下がったときに偽になるので、`RANK_GLOSS` は別の文にした。`KNOWN_CHECK_DAYS` 14、単体の 13／12 は 14／13 に |
| M3 | 論理 | `rankOf` を `recordCorrect` の後に読むと古い記録で段が上がる | 反映 | `recordCorrect` の先頭で `pendingAnswer` を控え、`queueMicrotask` で捨てる。Battle の clean の推定も `pendingAnswer.clean` に替えた。`runRankBefore` は `completeWord` の `prevStat` から（§3.3・§4.7・§7.1・§7.2・E2E 習熟度 8） |
| M4 | 論理 | 知ってた語の分岐が最初の確認に限られていない | 反映 | `knownCheck = 知ってた語 && streakBefore === 1`。`nextRank` の引数を替えた（§3.3・§3.5 守り 2・§3.7・単体 6） |
| M5 | 論理 | 同じ日に ○ の後で × でも下がらない | 反映 | 下げるのはその日の最初の ×（○ との順は問わない）。`failedToday` を渡す（§0-3・§3.3・§3.5・単体 2・E2E 習熟度 5）。60 秒の行の文を「習熟度が上がるのは…」に |
| M6 | 論理 | 初見の答えに S2 を当てると 30 日 | 反映 | S2・S3 は `prevDay !== null` かつ同じ日でない `gap ≥ 1` のときだけ。`intervalAfter` は gap が数でないとき credit なし（§6・単体 14） |
| M7 | 流れ | 60 秒の回でも 15 語で完了し、続きを消す。続きを 60 秒の設定で再開すると 15 語で完了 | 反映 | §4.0 を新設（`runKind`・`runSize` を始めに決める。timed は `setCompletePending`・`saveResumePoint`・`clearSession` を使わない）。E2E 60 秒 11 |
| M8 | 流れ | 設定の select が 60 秒を「15語」と出す | 反映 | `getSetLength()` を足し、2 つの select の初期値に（§4.1・付録 A・E2E 60 秒 1） |
| M9 | 流れ | 語の詳細の段の意味の文が事実と違う | 反映 | M2 と同じ直し（流れの案の「語の事実から作る」を採った） |
| M10 | 創業者 | 既定の基準・箱の時計の軸・付録 C の理由 | 反映（論理の M1 と食い違う 1 点は論理を採った） | D.1 (a)。値（2,000／2,800 × 0.75）・根拠・slow を出さない・ja に置かない・箱の軸を Study／遊びに・`check.firstFast` と `firstMedian`・E2E（390 で 1,800ms → 4 など）を採った。**採らなかった 1 点**: 「既定の間でも 2 週間後の確認ですぐなら即答」。即答は最も強い言い方なので本人の基準で測った速さに限る（論理の案）。毎日学ぶ人は確認までに 20 件を超え、超えない人も 20 日あけてすぐなら即答に届く |
| M11 | 創業者 | 段ごとの決まり文句をやめ、規則の文・語ごとの根拠・次の条件を出す | 反映 | `RANK_RULE`・`rankBasis`・`rankNext` を採った（§3.1・§5.2・§5.3）。`RANK_RULE` は学習データの注記と、語の詳細の梯子の下に置く。詳細では畳んだ「習熟度の決まり」の中に入れる（語ごとの次の条件が先に読め、毎語に 4 文の規則が開いて並ばない）。学習データの行には、創業者の視点の shouldFix（段 1 の名前）に沿って入り方によらず真の短い説明を添えた |

### D.3 shouldFix（論理 10・流れ 14・創業者 10）

| # | 視点 | 項目 | 対応 | どう直したか／しなかった理由 |
|---|---|---|---|---|
| L1 | 論理 | 日付をまたいだだけで「日をあけた」 | 反映 | `MIN_GAP_MS` 6 時間（仮の値。§3.8 で見直す）。`failedToday` も同じ範囲（§3.3・§3.5 守り 1・単体 2・8） |
| L2 | 論理 | 時刻の欄が無いのに段がある語・gap < 1 | 反映 | 初めての答えは `prevDay === null && r === 0` だけ。日数が分からない答えは ○ で上げず × で 1 段。gap < 1 は同じ日の扱い（§3.3・§3.5 守り 7・単体 2・4） |
| L3 | 論理 | 段だけの ○ 率は間隔の違いで単調にならない | 反映 | `check.rank` を段 × gap の帯 × ○／× に（§3.8・§7.1） |
| L4 | 論理 | 古い記録の初期値の下げすぎと上げすぎ | 反映 | history を使う（未解決でも ○ の日 2 日以上で 2。習得・streak ≥ 6・知ってた streak ≥ 2 は 6 日以上あいた ○ があるときだけ 4。history 2 件未満は今の表）（§3.6・単体 9） |
| L5 | 論理 | ミッションで段 3 のまま習得に届く | 反映（案 2） | ミッションに限り S6 の対象に段 3・期日が未来を足した（段階 1）。案 1（ミッションの条件を「未解決、または期日」に替える）は、苦手の語を毎日見直すミッションの役目を広く変えるので採らない。題箋と段のずれの説明は §5.1・付録 B-11 |
| L6 | 論理 | 箱の input を `isTouchDevice()` で決めると打ち方と違う箱に入る | 反映 | 最初のキーが来た経路で決める（§3.4） |
| L7 | 論理 | slow の pc 条件の前提が無い | 反映 | pc の箱が 20 件未満なら fast でも slow でも見ない（§3.4・単体 11） |
| L8 | 論理 | `masteryAt` と `lastRecall*At` の同じ文字列を検査していない | 反映 | `nowIso` を 1 回だけ取って両方に使う。書いた直後の `rankOf === masteryRank` を単体と E2E で（§7.2・単体 9・E2E 習熟度 5） |
| L9 | 論理 | 2 台で同じに出るのは取り込んだ後だけ | 反映 | 文を直した（§3.3・§7.3） |
| L10 | 論理 | 息抜きと Battle の非 clean が S6・S1 の漏れ | 反映 | 息抜きを S6 の対象に（候補が無ければ挟まない。戻さない）。Battle の非 clean は S1 の例外として表に書いた（§6） |
| F1 | 流れ | 60 秒を選んだ人のスタートが語数の続きになる | 反映（案 a） | 60 秒の間は `#pathStart` が 60 秒の回を始め、続きには触れない。右頁は続きの文を出さず、済んだ日は「今日のぶんは完了 ・ 次は60秒」（§4.1・§4.2・E2E 60 秒 11） |
| F2 | 流れ | チュートリアルの回を見分けられない | 反映 | `isTutorialRunPending()` を export、§4.0 の判定に（§4.2・付録 A・E2E 60 秒 8） |
| F3 | 流れ | 60 秒の回の途中にはちゃんとスタンプが出る | 反映 | 覚えたはメッセージ行だけ（スタンプ・`#learnToast` のはちゃんなし）。立て直しの知らせも出さない（§4.4・§8・E2E 60 秒 4）。流れの案の「立て直しを文字の 1 行に」ではなく、創業者の視点の案（知らせ自体を出さない）を採った（時計の進む盤面に行を足さない） |
| F4 | 流れ | 0 語の回とホームのはちゃんの文が事実と違う | 反映 | 思い出せず ≥ 1／0 の 2 通り。0 のときは創業者の視点の文「時間切れの語は、記録していない。」を採った（流れの案の「次の回は、続きの語から出る。」は、時間切れの語が次の回の先頭に来るとは限らず事実と言い切れない）。ホームは「今日はまだ途中。」（§4.7・§4.8・E2E 60 秒 5） |
| F5 | 流れ | 語数のパネルの「もう1セット」が 60 秒で走る | 反映 | 次が 60 秒なら「もう60秒」（§4.7・E2E 60 秒 8） |
| F6 | 流れ | プレイ中に長さを変えたとき | 反映 | 次の回から効く（§4.0・§4.1・E2E 60 秒 12） |
| F7 | 流れ | `?set=N` と保存値 60s のどちらが勝つか | 反映 | 数の `?set=` が勝つ（§4.1・§9.1-1・E2E 60 秒 1） |
| F8 | 流れ | 時計の変数・裏に回ったとき・読む間 | 反映 | 既存の `timer` に載せる。`hiddenAt` で戻ったときに足す。メモ・覚え方・`readingHold` は描画ごとに見て足す（§4.5・E2E 60 秒 6） |
| F9 | 流れ | CSS の置き場所と規律 | 反映 | `.rank` は brand.css、群は card.css、梯子と表は pages.css、select は home.css。§9.1-10 に B57-12（§3.2・付録 A） |
| F10 | 流れ | 段の欄が無い古い語の答える前の段 | 反映 | M3 と同じ直し（`pendingAnswer`） |
| F11 | 流れ | 「うろ覚え」と題箋「覚えた」が同じ語に並ぶ | 反映 | 段 2 の既定の名前を「あやふや」に。Q2 の代案に「うろ覚え」。語数のパネルの行から「覚えた」のチップの語を除く（§3.1・§5.4・§10） |
| F12 | 流れ | ローマ字の速さを測るかの食い違い | 反映 | 測る（`ja` の箱は残し、既定の線は置かない）。付録 B-7 から外した |
| F13 | 流れ | E2E の作り方（分割の目印・3 秒の揺れ・最初の語・hidden・Tab） | 反映 | 目印の行と単独で動くこと、答える回は `?t=8`、2 語目で測る、`visibilityState` も偽装、Shift+Tab（§9.1-11・§9.3） |
| F14 | 流れ | meta の書き出しが変わらなくても走る・復元で古い基準 | 反映 | dirty のときだけ書く。`applyBackup` でも `forgetMasteryMeta()`（§7.2・§7.3・E2E 習熟度 7） |
| C1 | 創業者 | 即答の語が正解で下がると「下がった」とだけ出る | 反映 | 「時間がかかった」（§4.7・§5.4・E2E 習熟度 9） |
| C2 | 創業者 | 初見の遅い正解で「知ってた」と段 2 が並ぶ | 反映 | 初見のノーミス正解は遅くても 3（§3.5・単体 1） |
| C3 | 創業者 | 題箋と段の組み合わせが矛盾して読める | 反映（一部） | 語の詳細の根拠の文、単語帳のカードの `title` に根拠、段 2 の名前、E2E の撮影に 3 組、BACKLOG（§5.1）。`aria-label` には根拠を足さない（単語帳で語ごとに長い文が読まれる。詳細を開けば読める） |
| C4 | 創業者 | 段の語数が「覚えた N語」より多く見える | 反映（文を変えた） | 「（うち知ってた M語）」。題箋と同じ「知ってた」の語にした（UI の「初見」は「初めて」にそろえたため）（§5.3・E2E 習熟度 3） |
| C5 | 創業者 | S6 に確認待ちを足し、段階 1 に前倒し | 反映 | §0-9・§2 K1・§3.7・§6・E2E 習熟度 13。5 回の条件（Challenge・Daily・Battle で答えなければ）を書いた |
| C6 | 創業者 | 打ち間違い 1 回で即答から 50 日以上外れる | 反映 | Q4 を足した（既定は今の規則。代案は `masteryPeak`） |
| C7 | 創業者 | 60 秒の回の間にトーストのはちゃん | 反映 | F3 と同じ直し |
| C8 | 創業者 | 0 語の回の文・群の題の語数 | 反映 | F4 と同じ直し。題は「習熟度（この回に答えた語）」、答えた語が 0 なら群も題も無し（§4.7） |
| C9 | 創業者 | 3 か月答えていない語も即答のまま（いつの時点か分からない） | 反映（形を変えた） | `rankBasis` のどの枝も日付を持つので「（M月D日の時点）」を別に添えない。学習データの注記に「最後に答えた時点の段」（§5.2・§5.3） |
| C10 | 創業者 | 段 1「まだ」が単独で意味が決まらない | 反映 | 学習データの行に `RANK_GLOSS`（まだ＝思い出せなかったまま）。Q2 の代案に「出てこない」（§3.1・§5.3・§10） |

### D.4 notes から入れたもの

- 論理: `tShow` を rAF で取る（§3.4）、ページの最初の語を測らないことの理由（§3.4）、§3.7 の「1 日 1 段ずつ」を「条件を満たした日に 1 段ずつ」に、基準の漂いと段 5 の割合（§3.8・付録 B-9）、既定の線を遅い側に使わない（§3.4）。
- 流れ: `initialRank` で知ってた語の行を上に（§3.6）、詳細の確認の日付を次の条件の 1 か所に（§5.2）、詳細の `aria-label` から「習熟度」を外す（§3.2）、`.word-chip` の `max-width` と折り返し（§4.7）、`#resultStudy` は今日のセットの長さに従う（§4.0）、済んだ日の右頁に「次は60秒」（§4.1）、§4.8 の連続日数は `updateStreak` が数える（§4.8）、og:description（§4.1）、右頁の「約5分」と焦点の件は BACKLOG（付録 A）、2 タブの後勝ち（§7.3・付録 B-10）、60 秒のパネルに「覚えた」の群を置かない理由（§4.7）。
- 創業者: Q1 に 1 日の約束の変化と解放の累計を書き、代案 (c)（§10）、UI の「初見」を「初めて」にそろえる（§3.1）、付録 B-4 の理由の書き直し。
