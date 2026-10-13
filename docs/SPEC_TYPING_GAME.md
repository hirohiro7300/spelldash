# タイピングゲーム（/typing-game.html）— Batch 60

> 創業者の指示（2026-10-10）: よく知られたブラウザのタイピングゲームのように、タイピングだけを普通に練習できる機能を、今のコンセプトのままで。
> 日本語の文（漢字かな交じりの見出し＋ひらがなの読み）が 1 つずつ出て、ローマ字で次々と打つ 90 秒のゲーム。文ごとに持ち時間があり、打ち切れば「取れた」、尽きると「流れた」。
> 「タイピングゲーム」「タイピング 文章 練習」「ローマ字 タイピング 文」で来た人の入口（docs/SPEC_TYPING.md の `/typing.html` と同じ役）。
> 言い分け: このゲームのコース「長い文」（かな 17〜30 の 1 文を持ち時間の中で次々と）と、タイピング練習の「長文」（文章を最後まで打つ。typing.html の 3 つ目の種類。docs/SPEC_TYPING.md §9）は別物。**学習のモードではない**（学習記録を変えない。docs/STATUS.md §5 の例外）。
> よく知られたタイピングゲームからは骨格（コース・制限時間・文ごとの持ち時間・取れた／流れた・ミスは数えるだけ）だけを写し、テーマ（食べ物の皿・通貨）と文は写していない。リポジトリは public なので、木に入る文では他社の固有名を使わない。
> 変えるときの基準はこの文書。設計の経緯（下調べ・反証・レビュー）は Batch 60 の SPEC（scratchpad）にある。

## 1. 範囲

| 入れるもの | 中身 |
|---|---|
| ページ | `/typing-game.html`「タイピングゲーム」。無料・ログイン不要。typing.html と同じ皮（`body.page-typing page-typing-game`。css/typing.css をそのまま当て、差分だけ css/typing-game.css） |
| コース | 3 つ: 「短い語句」（かな 3〜7）・「ふつうの文」（かな 8〜16。既定）・「長い文」（かな 17〜30）。設定はこれだけ。`?course=` の深いリンクとこの端末の記憶で開くコースが決まる（§2 の「開くコース」。Batch 65） |
| 1 回 | 90 秒（3 コース共通）。最初の 1 打（または Space／Enter）で始まる |
| 見本 | 今の文 1 つ: 見出し＋かなの単位（打ったキー／まだの所はローマ字の手本。js/typingDrill.js の `japaneseUnits`）＋持ち時間の線（文の下、3px）。次の文の予告は出さない |
| 持ち時間 | `1.5 秒 ＋ 係数 × 手本の打鍵数`（係数 短い 0.60／ふつう 0.50／長い 0.42 秒。4〜30 秒に丸め）。尽きたら「流れた」（ミスではない） |
| ミス | 数えるだけ。文は止めない。正しいキーで進む |
| 結果 | 取れた N 文（主の数）＋目標の一言／流れた・打/分・正確さ・ミス／自己ベスト（端末、コース×秒数）／もう一度／「思い出して打つ」（`/?from=tgame`）。≥720 は 2 列 |
| 教材 | 創作の 654 文（短い 225・ふつう 277・長い 152）。`scripts/typing-game/*.jsonl` → `scripts/build-typing-game.mjs` → `data/typing-game.json` |
| 入口 | typing.html の札の下に 1 行・お知らせ・sitemap・sw の precache・アプリの PAGES。フッターは変えない |
| 計測 | 新しい端末だけ、`first_visit` の source に `tgame`／`tgame_start`／`tgame_done`／`tgame_study`／`tgame_link`（深いリンク）／`tgame_stats`（学習データの 1 行）、typing.html から初めて来た端末がゲームを開いたら `typing_game`（SQL は変えない） |

入れないもの: 皿・食べ物・通貨・「元を取る」・ランキング・名前の登録、連打メーター・時間ボーナス（BACKLOG D18）、難易度・時間の設定、次の文の予告、打っている間の流れた数・打/分・正確さ（D25）、残り 10 秒の演出・線の色の変化・点滅、間違えたキー、救済、効果音・BGM、Backspace の訂正、文の投稿、学習記録・XP・SRS・はちゃん・Pro・課金・広告・ガチャ・通知、結果のシェア・JSON-LD。

## 2. 画面と状態

- 1 列・最大 720px。h1「タイピングゲーム」＋lead → タブ 3 つ（`.stats-tabs`。群の名前「コース」）＋補足 1 行（「かな8〜16字の文 ・ 目標 8文」。JS が定数から書き、HTML の初期値は E2E と `--check` の V11 が定数と突き合わせる）→ 箱（`.tg-stage`）の中の札（`.result-card`）→「このページについて」（静的な 5 行）。
- 最初の文は 3 コースとも HTML に直書き（教材が届く前から打てる。`[data-tg-first]` の見出し・単位の組〔`.tg-first` は display: contents〕・読み・補足。開いたコースの 1 つだけを CSS が見せ、js は最初の ready で中身を書き替える）: 短い語句「おはよう」・ふつうの文「今日はいい天気だ」／`きょうはいいてんきだ`・長い文「植木に水をやって、新しい芽を数える」（js/typingGame.js `FIRST_SENTENCES`。どれも教材にある文で、コースの中で打鍵の少ない方。`--check` の V11 が 3 つとも教材にあるかを見る）。HTML に手で書いた印は `--check` の「V11 最初の文の印」が `FIRST_SENTENCES`・`COURSES` と突き合わせる（題・読み・補足・かなの単位〔読みから `japaneseUnits` で作り、js/typingKeys.js `appendUnits` と同じ形の HTML と完全一致〕・`#tgWord` の `data-rest`・印の欠け。scripts/build-typing-game.mjs `firstMarkupProblems`。PR #166 のレビュー 8: 前は各文が教材にあるかだけで、手本を 1 字いじっても通った）。補足の書き方を替えるときは js/typingGamePage.js の「note ・ 目標 N単位」と字を同じに（区切りの span は可）。最初の回は開いたコースの内蔵の文で始め、教材が届いたらそのコースの残りを足す。
- **開くコース**（Batch 65 P2。BACKLOG D19。タイピング練習の「開く種類」と同じ形: docs/SPEC_TYPING.md §2）: `?course=short`／`normal`／`long` → この端末の記憶 `spelldash_typing_game_course` → ふつうの文。不正な値（`?course=xx`・記憶の `zzz`）は無いものとして飛ばす（初めての人は既定、覚えた値がある人は覚えたコース）。値はコースの id の一覧の includes で見る（`COURSE_IDS`。js/typingGame.js `isCourse`）。`?course=constructor`・`__proto__`・`toString`・`hasOwnProperty` なども不正な値（PR #166 のレビュー 4: 前はふつうのオブジェクトの引き `COURSES[c]` で、これらを正しい値と読んで `tgame_link` を送っていた）。js/typingGame.js の持ち時間・目標・単位・自己ベストの引きも同じ一覧で見る（不正な id はふつうの文、自己ベストは読まない・書かない）。何も指定しない URL で記憶の無い人は今どおり（ふつうの文・今日はいい天気だ・目標 8文）。
  - head のインラインの 1 行（theme の 1 行の直後。try で包む。CSP は今のまま）が最初の描画の前に `html[data-typing-course]` に置く。`<html>` には `data-typing-course="normal"` を直書き（script が動かないときもふつうの文の形）。js/typingGamePage.js はこの値から始め（`START_COURSE`。js/typingKeys.js `startChoice`）、ready に入るたびに html の値を合わせる。head の 1 行が動かなかったときは、練習と同じく URL → 記憶 → 既定の順で js が読む（前は既定だけ。PR #166 のレビュー 6）。読む・覚える・URL を合わせる・開き直すは練習の種類と同じ js/typingKeys.js の共通の関数（`choiceFromUrl`・`startChoice`・`rememberChoice`〔`syncUrlParam`〕・`reopenLink`）。head の 1 行は CSP・速さのため残し、読む順・許す一覧・記憶の鍵・既定が js と同じことは E2E の静的な検査が守る。
  - ちらつきを出さない: コースごとの CSS（タブの現在地の金の下線と墨の字・見出しと単位の行の予約・長い文の字・横向き）は札の `data-course` ではなく `html[data-typing-course]` で書く（詳細度は同じ）。静的な `.stats-tab--active` はふつうの文に付いたままなので現在地には使わない（class と aria-pressed は js が合わせる）。
  - 覚えるのはタブを押したときだけ（`?course=` で開いただけでは書かない: 貼られたリンク・検索から来た 1 回で、その人が選んだコースを上書きしない）。タブを押すと `?course=` を `history.replaceState` で合わせる（js/typingKeys.js `rememberChoice`。記憶は `storage()` を try で書き、URL は替わるときだけ書く。`?t=`・`?s=` は残す。合わせないと再読み込みで URL の古いコースに戻る。履歴は増えない。共有・ブックマークは今のコースで開く。localStorage が使えない端末でも URL で保つ。オフラインでこの URL を再読み込みしても、sw.js のページ遷移の代わりがパラメータなしの同じパスの保存 → URL の完全一致 → パラメータを見ない一致 → 書斎の順に探して typing-game.html を返す〔Batch 65 の反証。前は書斎に落ちた。PR #166 のレビュー 1 とその反証でパラメータなしの保存を完全一致より先にし、パラメータ付きのページ遷移の応答はパラメータなしのパスにも保存する: パラメータを見ない一致は最初に保存された古い HTML を返しうる。完全一致を先に見ると何週間も前に `?course=long` で開いた古い HTML が、タブで同じ `?course=long` に戻ったときに当たる。docs/SPEC_TYPING.md §2〕。書き替えた URL の開き直しは計測 `tgame_link` に数えない〔§7〕）。学習記録・同期・CSV・バックアップに入れず、「この端末の記録を消す」でも残す（js/backup.js の EXCLUDE・KEEP_ON_CLEAR）。
  - canonical・og:url は今どおり `/typing-game.html` 1 つ、sitemap は増やさない。`#short` のようなハッシュは受けない。
- `#tgBoard[data-state]`: `ready` → `running` → `result`。`loading`（教材の未着のコース）・`error`（教材が取れず次の文が無い。「読み込めなかった」の「開き直す」は今のコースで開き直す: `/typing-game.html?…&course=<コース>`。ほかのパラメータは残し、hash は落とす。js/typingKeys.js `reopenLink`。PR #166 のレビュー 2: 前は静的な `./typing-game.html` のままで、深いリンクで来た人がふつうの文に戻った）。`data-course`・`data-got`・`data-lost` は E2E が読む印。
- 打っている間に Esc／ページが裏に回った／コースのタブ → その回は捨てて ready。bfcache から戻ったときも ready。
- 結果が出てから 0.6 秒（`RESULT_GUARD_MS`）の守りは typing.html と同じ（盤面を出したまま、盤面の外のクリックをすべて捨てる。js/typingKeys.js `createResultGuard`）。
- **高さの予約は箱（`.tg-stage`）**: 箱が結果の最悪の高さ（390: 404px／≤389: 446／≤359: 490／≥720: 302）を始めから取り、札は中身の高さ（紙が半分空いた札にしない）。結果は 90 秒の時計で出る（入力の直後とは限らない）が、札は下に伸びるだけで箱の下は動かない（CLS 0）。札の中は、コースごとに見出しと単位の行数を予約する（390: 見出し 1／1／2 行・単位 1／2／3 行、320: 単位 1／2／3 行、≥720: 単位 1／1／2 行）。文が替わっても（流れた＝入力なしでも）札は上下しない。始まる前の 3 文は打っている間も行の高さを残す（`visibility: hidden`）。
- 持ち時間の線: 地は `--line`、塗りは `--gold-line`（tokens.css。地にも札にも 3:1 以上: 昼 3.9／5.4・夜 6.0／7.2・紙 4.0／5.9・藍 5.4／7.1）。残り比は rAF で `transform: scaleX(r)`（CSS の transition・animation は書かない）。reduced motion は 10 段。残り 2 割で色を変えない・点滅しない。
- 結果: 柱（「ふつうの文・90秒」）・主の数（取れた N＋単位＋目標の句「目標 8文に届いた」／「目標 8文まで あと 2文」。目標の数字は 14px）・補足 1 行目（流れた・打/分・正確さ・ミス。名前と数の組 `.tg-pair` は折らず、区切りの「 ・ 」の後ろでだけ折る。区切りは折れない「 ・」〔`.tp-sep`〕と折れてよい空白で、練習の結果の行と同じ js/typingKeys.js `sep()`。行の頭に「・」が来ない。PR #166 のレビュー 5: 前はふつうの文字の「 ・ 」で、行の幅によっては 2 行目が「・ミス N」で始まった。textContent は同じ）・自己ベスト・勧め（流れた > 取れた かつ短い語句以外:「短い語句のコースから始めると取りやすい。」）・もう一度・導線。
- 読み上げ: 流れた瞬間に `#tgLive`（`role="status"`）を空にし、次のタスク（50ms 後）で「次の文」と書く（2 回続けて流れても読み上げが黙らない。結果・始まる前・読み込めない画面に替わったら予約を捨てる）。結果は「10 文。目標に届いた。流れた 2、打/分 168、正確さ 95%、ミス 9。」。`#input` の `aria-describedby` は見出しと読み（`#tgReading`）。
- タッチ端末: 画面キーボード（A〜Z＋ー＋⌫。Enter は隠す）を typing.html と同じ呼び方で出す。ready に入ったとき・コースを替えたとき、札が盤面に隠れるなら札の上端をヘッダーの下 8px に寄せる。
- 横向き（高さ ≤480px）: 箱の予約を外し、取れた・残りを札の上の角に重ね、かな 22px、長い文は見出しを隠す。高さ ≤360px（844×340 など）は見出しをどのコースでも隠し、線を札の上の縁に重ね、札の上下の余白を詰める。高さ ≤330px（568×320・667×320。BACKLOG D23、Batch 65 Q2）は札の上の余白 8px、取れた・残りを 12px・上 4px、単位の上 11px（札の内側の上から 19px）、長い文だけかな 17px・キー 10px（予約 61px＝2 行）。盤面（keyboard.css の 161px。変えない）の上に札に使えるのは 667×320 で 94px、568×320 で 82px（568 はヘッダーが 2 行に折れて 69px）。いちばん長い文の単位の行の下端は 568×320 で 158（盤面の上端 159）、667×320 で 145。短い語句・ふつうの文は 22px のまま、844×340 は変わらない。単位の予約は横向きで 短い・ふつう 1 行（43px、≤360px は 40px）・長い 2 行（88px／80px）。短い・ふつうの規則はコースつきで書き、縦向き（ふつう 101px）と ≥720 の予約に勝たせる（負けると 667×375 でふつうの文が 2 行分を取り、線が画面キーボードの下に入る）。
- 制約（このまま）: 流れた瞬間の見た目の印は無い（文が替わり線が満に戻るだけ。読み上げは「次の文」。打っている間の「流れた N」の表示は創業者の試し打ちで決める: BACKLOG D25）。横向きの結果は札が伸びる（盤面が畳まれてから出る 1 回だけ）。

## 3. キー（typing.html との差分）

キーの取り方・扱わない場所・焦点・Space／Enter・語末の ん の持ち越しは docs/SPEC_TYPING.md §3 と同じ（キーの振り分け・結果の守り・自己ベストの読み書きは typing.html と共通の js/typingKeys.js・js/typingDrill.js）。違いは次のとおり。

- 状態を変えるのは `run.settle(now)` と `run.press(key, now)` だけ（js/typingGame.js `createGameRun`）。`settle` は今の文の締切（90 秒の中）を過ぎていれば流して次の文へ（次の文の締切も過ぎていれば繰り返す。次の文の持ち時間は締切の瞬間から）、90 秒が切れていれば終える。締切が 90 秒の終わりと同じ文（打ちかけ）は流さない。冪等・単調（状態を変えた時刻より前には戻らない）。
- キーの時刻は `event.timeStamp`（`performance.now()` と同じ時計。5 秒以上ずれていれば今の時刻）。keydown は押した瞬間で締切と厳密に比べる。時計（rAF の 1 本が毎フレーム締切を見て残り秒を書く。rAF が止まったときの保険に、次の締切〔文の持ち時間と回の終わりの早い方〕のタイムアウトを 1 本だけ置く。張り直しと止めるのは `syncClock` だけ）は締切に気づいてから **50ms の余白**（`SETTLE_SLACK_MS`）で流す: 締切の前に押したキーが少し遅れて届いても数える。
- 締切のあとに届いたキーは数えない（流してから捨てる）。
- 流れてから 0.6 秒（`FLOW_GRACE_MS`）は、新しい文として通らないキーを数えない（時間だけで切る。通るキーはそのまま進む）。古い文の続きを打っていた指のキーを新しい文のミスにしない。取れた直後には置かない。
- 流れた文は `createRun` の `skip()`（js/typingDrill.js。typing.html の挙動は変わらない）で飛ばす: 続き（語末の ん）とミスの印を消す。打ちかけの正しい打鍵は打/分に残る。
- Space は打っている間は何もしない（文に空白は無い）。

## 4. コース・時間・数え方

| コース | 帯（かな） | 持ち時間（ms） | 目標（90 秒） | 単位 | 1 文も取れなくなる速さ（目安。ミス 0） |
|---|---|---|---|---|---|
| 短い語句 `short` | 3〜7 | `1500 + 600 × 打鍵` | 20 | 語句 | 約 1.1 打/秒より遅いと 0（1.5 打/秒なら 12 語句） |
| ふつうの文 `normal`（既定） | 8〜16 | `1500 + 500 × 打鍵` | 8 | 文 | 約 1.8 打/秒（110 打/分）前後より遅いとほぼ 0 |
| 長い文 `long` | 17〜30 | `1500 + 420 × 打鍵` | 4 | 文 | 約 2.2 打/秒（130 打/分）前後より遅いとほぼ 0 |

- 打鍵数は手本（`canonicalRomaji(reading, { finalN: true })`。語末の ん だけ n）の長さ。持ち時間は 4〜30 秒に丸める。
- **持ち時間は崖になる**: 固定の 1.5 秒が救うのは短い文だけで、係数の逆数（ふつう 2.0・長い 2.38 打/秒）より遅い人はほぼ全文が同時に流れる（右の列。Batch 60 の反証レビューの試算）。ふつうの文を既定にしたのは創業者の判断待ち（docs/FOUNDER_TODO.md F。短い語句を既定にするなら `DEFAULT_COURSE` と HTML の最初の文を替えるだけ）。
- **目標**は参照の速さ 2.5 打/秒の人がコースの平均の文を 90 秒で取り切れる数: `Math.floor(90 ÷ (平均打鍵 ÷ 2.5 ＋ 0.4))`（`goalFromAverage`。取れる文は整数で、時間切れの打ちかけは数えないので切り捨て）。今の教材の平均 10.1／24.6／48.1 打 → 20.27／8.79／4.58 → **20／8／4**。`COURSES[c].goal` は定数で、`scripts/build-typing-game.mjs --check` が教材の平均から計算し直し、違えば落ちる（3 コースとも差 0）。
- 数え方は typing.html と同じ関数（`summarize`）: 打/分 `Math.round(correct × 60 ÷ 秒)`、正確さ `Math.floor(correct × 100 ÷ total)`（total 0 は「―」）。取れた `got`（持ち時間の中で打ち切った文）、流れた `lost`（持ち時間が尽きた文。90 秒が切れたときの打ちかけは入れない）。
- E2E 用の URL 引数: `?t=N`（1〜90。表示・目標も N 秒ぶん: `max(1, round(目標 × N ÷ 90))`）、`?s=N`（1〜9。文ごとの持ち時間を一律 N 秒に。その回は自己ベストに書かず、比べない）。
- 自己ベスト: `localStorage.spelldash_typing_game` = `{ v: 1, best: { normal: { "90": { got, lost, kpm, acc, day } }, … } }`。**コース×秒数**。取れた文で比べ、同数のときだけ打/分で比べる（はじめての記録／自己ベストを更新（前 N文）／自己ベストと同じ N文・打/分を更新（前 K）／自己ベストと同じ（N文・打/分 K）／自己ベスト N文（あと D文））。書く直前に読み直し、`best[course][秒数]` だけ差し替える。got・lost が整数 0〜200、kpm が整数 0〜2000 でなければ壊れた記録として無い扱い。持ち時間の係数を変えたら `v` を上げる。
- 書いてよいキーは `spelldash_typing_game`・コースの記憶 `spelldash_typing_game_course`（タブを押したとき。Batch 65）・計測（`spelldash_device_id`・`spelldash_funnel_*`）・共通のフッターの `spelldash_billing_open` だけ。typing.html の自己ベスト（`spelldash_typing_practice`）は読みも書きもしない。

## 5. 教材

- 元データ: `scripts/typing-game/short.jsonl`・`normal.jsonl`・`long.jsonl`（1 文 1 行 `{"t":"見出し","r":"よみ","topic":"話題"}`。`#` の行は注釈。束ごとに `# 束名`）。避ける語は `deny.txt`（漢字・カタカナ語だけ。見出しへの部分一致。かなの語は読みに当てると あいさつ・家事・秒 を落とすので置かない）。
- 生成物: `data/typing-game.json`（`{ v: 1, courses: { short: [[見出し, 読み], …], … } }`。1 文 1 行。生 55.4KB・gzip 17.6KB・brotli 15.9KB。data/typing.json より小さい）。head の preload（`as=fetch`）と同じ URL・CORS で 1 回だけ取る。sw の precache には入れない。
- `node scripts/build-typing-game.mjs`（書く）／`--check`（生成物と一致・違反 0・目標の定数・typing-game.html の最初の文の印。CI と E2E）／`--lint <file.jsonl> --course <c>`（書き手の自己検査）／`--report`（topic・かな数の分布・平均打鍵と目標・漢字の一覧（小・中学校のパックに出ない字に *））。**文を直したら作り直す**。
- 検査 V1〜V14: 読みは ひらがな＋ー（ゐゑゎ なし）・手本で打ち切れる・帯・3 コースをまたいで重複なし・見出しの字種（漢字・かな・ー・々、「、」は長い文だけ 2 つまで）と長さ（≤ かな＋2）・見出しのかなが読みに順に出る・かなの行が打っている途中も読みと同じ・避ける語・同じ漢字 2 字の偏り（コースの 4%）・数（200／250／150）と topic・最初の文がふつうにある（V11。typing-game.html の 3 コースの最初の文の印が `FIRST_SENTENCES`・`COURSES` と同じかも「V11 最初の文の印」で見る）・目標の定数（差 0）と参照の速さの人が 1 文も流れない・同じことわざは 1 コースだけ・手本に x・l が無い（文末の っ・単独の小書きかな）。
- 書き方（付録 A の要約）: 創作の日常の文（あいさつ・暮らし・学校・仕事・季節・食・旅・ことわざ）。固有名詞・政治・宗教・差別・性・暴力・病気・事故・災害・金銭・酒・たばこ・賭け事・時事を入れない。読みが揺れる語（明日・一日・十分 など）を使わない。表記どおりのかな（は・へ・を）、長音は仮名遣いどおり、外来語だけ ー。他社のタイピングゲームの文を写さない。表記は 1 つにそろえる（ごはん・鍋・餅・雪解け・日差し）。
- 確認は 2 段（書き手と別のエージェントが 1 文ずつ読みと内容を見て、疑わしい行は落とす）。仕様の見本 30 文は反証レビューの独立の読みを 2 段目とした。
- 並べ方: 1 回ごとに Fisher–Yates で混ぜ、先頭 3 文のうち打鍵の最も少ない文を先頭に（`pickFirst`）。列が尽きたら（`?s=` の回だけ）混ぜ直して後ろに足す。

## 6. 入口・SEO・アプリ

- 入口: typing.html の札の下・「このページについて」の上に 1 行（`.tp-more`「文を次々と打つ 90秒の タイピングゲーム」）。盤面の外なので時間切れの守りに入る（一覧に足す必要はない）。お知らせ 1 件（本文に typing.html も）。フッターの「タイピング練習」は typing.html のまま。ヘッダー・ホームには足さない。
- SEO: title「タイピングゲーム（日本語の文・ローマ字）無料・90秒 | SpellDash」、description（「登録なし」「90秒」、スマホの画面キーボードで打てることを前半に）、canonical／og:url `https://www.spelldash.net/typing-game.html`、本文は静的な HTML。sitemap は `scripts/build-pack-pages.mjs` の `urls`。og:image は共通のまま（BACKLOG D10）。
- アプリ: `scripts/build-app.mjs` の PAGES、`sw.js` の CORE_ASSETS（CACHE_NAME は上げない）。typing-game.html は Service Worker を登録しない。外部への要求は共通の js/supabase.js の SDK 1 本だけ（ほかの静的ページと同じ）。

## 7. 計測（SQL を変えない）

- js/funnelLog.js の族の表 `TYPING_FAMILIES`（typing／tgame）。`markTypingArrival("tgame")`: 開いた時点で番号も学習記録も無く、タイピング練習の印（`spelldash_funnel_typing`）も無い端末なら来た日を `spelldash_funnel_tgame` に控える（必ず `setFooterYear` の前。2 つの組は印でも排他）。`logTypingStage(stage, "tgame")`: その端末だけ `tgame`・`tgame_start`・`tgame_done`・`tgame_study`（積んで次のページで送る）を `first_visit` の source に各 1 回（day は来た日）。
- `logTypingStage("game", "typing")`: typing.html から初めて来た端末（`spelldash_funnel_typing` がある）がゲームを開いたら `typing_game`。鍵が族ごとに分かれているので、1 端末に付く印は最初の 1 ページ分だけ（2 枚のページの数が混ざらない）。既定の引数のままなら typing.html の呼び方は変わらない。
- `tgame_link`: その端末の最初の 1 ページが `?course=` の正しい値の深いリンクだった（正しい値はコースの id の一覧〔`isCourse`〕。`?course=constructor` などは送らない: PR #166 のレビュー 4。`markTypingArrival("tgame")` がその読み込みで印を立てたときだけ。コースごとには分けない。記憶だけ・指定なしでは送らない。タブで書き替えた `?course=` の URL の再読み込み・戻る・開き直しも送らない。Batch 65 P2 と反証の対応。練習の `typing_link` と同じ形）。`tgame_stats`: タイピングゲームから初めて来た端末が学習データの「息抜きに タイピング練習」を押した（js/statsView.js が積み、次のページで送る。Batch 65 P3）。
- 管理画面の「初めて来た」は端末の重複を数えないので数は変わらない。見方は docs/SQL_FUNNEL.md 5。コースの内訳・目標に届いた割合は取れない（要るなら `step` を足す SQL が先）。

## 8. E2E（tests/e2e.mjs）

- 節「typing game:」（「typing:」の後）: 教材（生成物と同じ・条件・数・全文が打ち切れ、かなの行が読みと同じ）、持ち時間・`?t=`・`?s=`・線の残り比の境界・目標の切り捨て、進行（取れた・流れた・締切のあと・猶予は時間だけで切る・時計の余白 50ms・巻き戻らない・文が無いときも落ちない）、時間切れの打ちかけ、ん の持ち越しと skip、集計、自己ベスト（壊れた値に lost も）、createRun の既定の挙動／1200 の 1 枚（?t=6&s=2。reduced motion・CLS）で開いた直後・線の色（4 テーマを読み込みの前に決め、塗りが --gold-line を解いた色と同じ・地にも札にも 3:1）・最初の 1 打・取れた・流れた（流れた瞬間の外れたキーは数えない）・結果（流れた数はページの data-lost から）・Esc と裏に回る・コース・CLS < 0.05・動き 0・学習記録・同一オリジン・自己ベスト（?t=6）・教材が読めない・localStorage が投げる端末／390 mobile（盤面・寄せ・箱の高さ・守り）・360／320（横スクロール・結果が箱に収まる・組が割れない）・844×390／844×340／667×375（いちばん長い文で単位と線が盤面の上）・全文の行数と札の高さ（390／320／844×390／667×375。横向きはどの文でも単位と線が盤面の上）／静的（SEO・本文・目標の文と定数・木に他社の固有名が無い・入口・ci.yml・CSS の規律）。
- 節「typing game funnel:」（「typing funnel:」の後）: tgame・tgame_start・tgame_done（1 回だけ）・tgame_study、学習記録のある端末・ほかのページから来た端末・typing.html から来た端末（typing_game だけ）・途中で離れた回、管理画面の数。
- Batch 65: 節「typing game:」に P2 の 5 件（`?course=short`・`normal`・`long`・何も指定しない URL × 初めて／覚えた後と不正な値 3 通りの 12 通りを、DOMContentLoaded の直後と load の後で、札の `data-course`・html の印・タブの aria-pressed と金の下線・題・補足・単位の数がそのコース、CLS < 0.05、canonical 1 つ、開いただけでは覚えない／module の js を止めて開いても下線・題・補足・単位・札と箱の高さが同じ／タブを押すと覚えて `?course=` を replaceState〔?t= は残る・履歴は増えない〕・再読み込み／localStorage が投げる端末／覚えたコースと種類はバックアップに入らず、復元・端末の記録を消すでも残る）と Q2 の 2 件（横向きの検査に 568×320・667×320。3 コースのいちばん長い文で単位と線が盤面の上・ヘッダーの下、長い文のかなは 16px 以上・短い語句は 22px。教材の全文の検査 G36 にも同じ 2 窓を足した〔件数は同じ・全文 654 × 7 窓〕。高さ 320 ではタブがヘッダーの下に隠れるので要素の click で押す）。節「typing game funnel:」に `tgame_link` の 1 件。反証の対応で 2 件（節「typing game:」: 長い文のタブを押してオフラインで再読み込みしても sw が typing-game.html を返し長い文で開く／節「typing game funnel:」: 何も指定しない URL で来た端末は、タブで書き替えた `?course=` の URL の再読み込み・戻る・開き直しで `tgame_link` を送らない）。仕上げで、読み込み中の空の見出し `#tgTerm` が行の高さを残し単位の行が ready と同じ位置にある 1 件（練習の typing.css の種類の規則がゲームに漏れない）。既存の検査は G23 を `?course=normal` で開く（直前の検査で短い語句を覚えたため）、「変わってよいキー」に `spelldash_typing_game_course`。
- PR #166 のレビュー: 節「typing game:」に 6 件（`--check` の「V11 最初の文の印」: 今の HTML は 0 件、手本のキー・かな・題・読み・補足・data-rest を 1 字ずらした 6 つがどれも落ちる／Node: constructor・__proto__・toString・hasOwnProperty・valueOf のコースはふつうの文の持ち時間・目標・単位で、自己ベストは読まない・書かない／`?t=6&s=1&course=long` で教材が読めない → 「開き直す」の href が `/typing-game.html?t=6&s=1&course=long`、押すと長い文で開き覚えない／結果の補足 1 の行の頭に「・」が無い〔ふつうの文・長い文・短い語句の結果を 390・360・320 と、行の幅 120〜340px の 1px ごとで。Range の字の矩形で行を分ける〕／head の 1 行と js の読む順・許す一覧・記憶の鍵・既定が同じ〔一覧の includes で見て URL の値を `COURSES[c]` で引かない・localStorage.setItem を直に書かない〕／オフラインの代わりが古い版を返さない〔反証。古い版を `?course=long` の URL で cache に直に書いた端末が新しい `/typing-game.html` を開いたあと長い文のタブ〔古い版と同じ URL〕をオフラインで再読み込み → 新しい版で長い文〕）。節「typing game funnel:」に 1 件（`?course=constructor`・`__proto__`・`toString`・`hasOwnProperty` の初めての端末はふつうの文で開き `tgame` は送るが `tgame_link` は送らない・覚えない）。
- 既存の節に足したもの: 「pages:」、SKIN_PAGES、フッターの先頭（静的 11 ページ）、typing.html の守りに `.tp-more`、「CRM: サイトのナビから admin.html にリンクしない」、「Pro: 全 12 ページ」。

## 関連

- 部品: js/typingDrill.js（かなの単位・判定・`skip()`・数え方）、js/typingGame.js（進行・持ち時間・目標・自己ベスト。Node から import できる）、js/typingGamePage.js（配線）、css/typing-game.css（差分）
- タイピング練習: docs/SPEC_TYPING.md（キーの表・守り・計測の元）
- キー: docs/KEYBOARD.md「タイピング練習（/typing.html）のキー」の末尾
- 計測: docs/SQL_FUNNEL.md 5、docs/SPEC_FUNNEL.md
- 書斎の規則の例外: docs/CONCEPT.md §4-7（結果の主の数 1 行）
