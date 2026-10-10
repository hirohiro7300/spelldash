# Clean Correct 仕様設計（2026-07-18、v4.1 §12-2）

> **2026-08-15 創業者決定による更新**: メインゲーム（Study/Challenge/Daily）は「1回でもミスタイプしたら不正解＋即スペル表示→打ち直し」に変更（実装済み）。当てずっぽうで正解に到達する経路を廃止したため、本書の「Correct with Typo」区分はメインゲームでは発生しなくなった（ミス＝Recall Fail扱い）。Battleは従来のまま（ミス許容・noMissBonusで差別化）。clean_correct_count列追加の必要性は「ノーミス正解数＝正解数」となったため再評価が必要。

> 実装前の設計書。結論: **学習データ層は既にv4.1の要求をほぼ満たしている**。必要な変更は「集計カウンタの追加」「Challengeスコアの扱い」「表示の分離」の3点で、破壊的変更なし。

## 1. 現在の判定と v4.1 要求の対応表

| v4.1区分 | 現在の内部表現 | SRS/mastered | Recall Loop | スコア | コンボ |
|---|---|---|---|---|---|
| Clean Correct | `isClean = !hasMissedCurrentWord && !isRevealed` → `recordCorrect(id, true)` | ✅前進する（streak+1、10でmastered） | ✅成功扱い | 1点 | ✅+1 |
| Correct with Typo | `recordCorrect(id, false)` | ✅**前進しない**（streak=0・翌日復習） | 成功扱い（思い出せてはいる） | **1点（Cleanと同じ）** | リセット |
| Recall Fail | `recordRecallFail(id)`（Enter答え表示/Battle Pass） | ✅リセット・mastered解除 | ✅Unresolvedへ | 答え見た後の完答も1点(🟨) | リセット |

**既に満たしている**: mastered/SRSはClean限定・XPのcleanボーナス・Battleのnoミスボーナス（noMissBonus=10）・コンボのClean限定。
**ギャップ**: ①Clean数の分離記録がない（correctCountは合算のみ）②ChallengeスコアがCleanもTypoも同点 ③リザルト/統計にClean数が出ない。

## 2. 必要なデータ変更

### ローカル（localStorage: spelldash_word_stats）
- 追加フィールド1つ: `cleanCorrectCount`（number, 初期0）
- 既存レコードは `?? 0` で読む（マイグレーション不要・後方互換）

### セッション集計（保存不要）
- ラン内カウンタ `cleanCount` を追加（score, typingMissCount と並ぶ変数）
- リザルトパネル・session log（appendSessionLog）に clean 数を追加

### Supabase（word_progress）
- 対応列 `clean_correct_count integer default 0` の追加が**将来必要**（SQL実行は承認制）
- ⚠️ **順序制約**: sync.jsの復元は `rowToStat(row)` でstatを再構築するため、**列を追加する前にローカルだけ実装すると、ログインユーザーはpull時に cleanCorrectCount を失う**。
  - 安全な実装順: (a) SQLで列追加（承認後）→ (b) statToRow/rowToStatに1行ずつ追加 → (c) 記録開始
  - SQL承認前に出したい場合の代替: rowToStatのマージを「ローカル既知フィールド温存」に変える手もあるが、同期の単純さが崩れるため**非推奨**。列追加を待つのが正
- activity_days（KPI心拍）への追加は不要（当面は語単位で十分）

## 3. モード別の処理設計

| モード | 変更 |
|---|---|
| **Study** | 記録面は現状維持（既にClean分離済み）。`cleanCorrectCount++`をrecordCorrect内に追加するのみ |
| **Challenge/Daily** | テンポ不変（Typoでも進行）。スコアを「Clean=1点満点、Typo=同じ1点だがClean数を分離集計」とし、**減点はしない**（v4.1は「減点またはボーナス対象外」— 既にコンボ/XPボーナスがClean限定なので"ボーナス対象外"は達成済み。減点は初心者体験を悪化させるため非採用を提案） |
| **Daily共有** | 絵文字グリッドを 🟩Clean / 🟨Typo or 答え見た / ⬛未回答 に細分化する案あり（現状🟩=自力・🟨=答え見た）。**共有仕様の変更は見た目に出るため創業者判断待ち** |
| **Battle** | battleEngineは既に clean を recordCorrect に渡し、noMissBonusもClean限定。cleanCorrectCount++が自動で乗る以外は変更不要 |

## 4. 既存ユーザーデータへの影響

- 追加フィールドのみ・既存値の再解釈なし → **影響ゼロ**（過去のcorrectCountからClean数は遡及計算できないため、導入日以降の集計になる旨をstatsページに注記）
- mastered/SRSの意味は変わらない（既にClean基準）

## 5. 移行手順（提案）

1. 【承認後SQL】`alter table word_progress add column clean_correct_count integer not null default 0;`
2. sync.js: statToRow/rowToStatへ1行ずつ追加
3. stats.js: recordCorrectに `if (wasClean) stats[word].cleanCorrectCount = (stats[word].cleanCorrectCount ?? 0) + 1;`
4. game.js: ラン内cleanCountの集計＋リザルトパネルに「ノーミス正解 N / 正解 M」表示
5. stats.html: 週間サマリー等にClean率を追加（任意・後続）

## 6. テスト項目（E2E追加案）

- Clean正解1語 → cleanCorrectCount=1 / correctCount=1
- Typo後に正解 → cleanCorrectCount=0 / correctCount=1 / cleanCorrectStreak=0
- 答え表示後に完答 → correctCountは増えるがrecallFail=1・Clean=0
- Challenge完走リザルトに Clean数が表示される
- 未ログイン→ログイン同期でcleanCorrectCountが保持される（列追加後）
- 旧データ（フィールド欠損）読み込みでエラーなし

## 7. 見積り

- ローカル実装+E2E: 小（半日以内）
- SQL列追加: 1行（承認制・実行はユーザー）
- リスク: 低（追加のみ・既存判定ロジック不変）

## 8. 打ち終わりの判定と Enter（2026-10-10、K0-1。創業者承認）

綴り入力（英単語・英字の答えの概念カード・英字の空所）の候補は「出題語 → accept → 別解索引」（js/answers.js acceptedAnswers）。1 打ずつ前方一致で、続く候補が無ければ 1 ミス＝不正解（上の 2026-08-15 の決定どおり。変えない）。

| 場面 | 判定 |
|---|---|
| 出題語を打ち切った | **その場で正解**（自力）。それより長い候補（gym に対する gymnasium、a に対する an）が残っていても止めない。以前は止まり、Enter で答えが開いて Recall Fail になっていた（全パック有効で 170 枚） |
| 出題語でない候補（別解）を打ち切った | まだ伸びる候補が残っていれば止めて待つ（出題語 advertisement に対する ad）。残っていなければ確定（綴り違いは正解、それ以外は別解の案内＝×なし・自力にならない・出題語を打ち直し） |
| Enter（答えを見る前） | **打った語で確定**: 打った綴りが候補の 1 つに一致していれば、その語で確定（出題語なら正解、別解なら別解の案内）。一致していなければ答え表示（Recall Fail） |
| 出題語で完成した直後の続き | 続きの綴り（gymnasium の nasium）として打ったキーは次の語の打鍵にしない。Study は正解後の待ちの間は飲み、続きを打っている間は次の語を出さない（最後の続きの打鍵から 1.5 秒まで。打ち切ったら普通の待ちを最後の打鍵から数え直す）。次の語が出た後は最後の打鍵から 0.6 秒の窓で続きが先（飲んだキーが次の語の頭だったと次のキーで分かれば戻す）、窓の外は 4 秒まで次の語でミスになるときだけ飲む（次の語の頭として通した続きの字は、次のキーで続きだったと分かれば次の語から外す）（docs/KEYBOARD.md「英単語: 出題語が別の正解の先頭部分のとき」） |

出題語の後ろに字を足す形の綴り違い（programme・maths・towards・an など、打てるもの 43 組）は出題語の所で正解になり、「X も正解（この教材では Y）」の行は出ない（記録は同じ自力の正解）。出題語で始まる長い別解（gymnasium など 155 組）は、以前の別解の案内ではなく出題語の自力の正解になる。

答えを見た後（候補は出題語だけ）・全文入力・ローマ字の判定・Battle（js/battle*.js、凍結）は変えていない。全カードの再現テストは tests/e2e.mjs の節「judge」（全パックを有効にした全カードで、出題語を 1 字ずつ打つと打ち切った時点で出題語として完成するか）。
