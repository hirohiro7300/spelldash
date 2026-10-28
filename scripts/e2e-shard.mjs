// E2E（tests/e2e.mjs）を組に分けて 1 組だけ流す。CI の並列ジョブ用（.github/workflows/ci.yml の matrix）
//
// 使い方:
//   node scripts/e2e-shard.mjs --shard 2/4   4 組のうち 2 組目を流す（npm run test:shard -- 2/4）。保留の節（下の HOLD）は流さない
//   node scripts/e2e-shard.mjs --all         保留でない節を全部 1 本で流す（CI の 4 組を足したのと同じ節。手元で全件を流すとき）
//   node scripts/e2e-shard.mjs --held        保留の節だけを 1 本で流す（CI では流さない。保留の節を直す・戻すとき）
//   node scripts/e2e-shard.mjs --only "9.6 マイ単語帳" [--only "<節の名前>" …]   名前の節だけを 1 本で流す（保留の節も流せる）
//   node scripts/e2e-shard.mjs --plan 4      組の分け方の表と保留の節を出す（流さない）
//   node scripts/e2e-shard.mjs --check 4     全部の組と保留の台本を作り、構文と「どの節も、ちょうど 1 つの組か保留のどちらか」を確かめる（流さない）
//   --include-held を --shard・--all・--plan に足すと、保留の節も組に入れる（保留の前の分け方。全部の節を流すとき）
//
// 保留（HOLD）: CI で流さない節。コードは tests/e2e.mjs に残す（消さない）。Batch 78 で利用者の導線から外した機能（本棚・コース・ほかの教材・
// Challenge・Daily・60 秒・マイ単語帳・前の学習データ・前のランク）の検査と、内部の仕組みで単体が守る検査のうち今の木で落ちるもの。
// 分け方の一覧と理由は節の名前ごとに HOLD の値（docs は統合担当）。節を戻すときは HOLD の行を消す（SECONDS の秒で組に入る）。
//
// 節は 1 つずつ try { } catch で包む: 節が途中で投げても（待ちの 30 秒切れなど）その節の残りは流れないが、✗ を 1 件数えて次の節へ進む
// （前は投げた節の後の節がその組で 1 つも流れなかった）。投げた節が開いたままの文脈（newPage のページ）は閉じる。待たれていない
// Promise の失敗も ✗ に数えて止めない。最後に節ごとの ✓・✗ と投げた節を出す。終了コードは前と同じ（✗ が 1 件でもあれば 1）。
//
// tests/e2e.mjs を 3 つに切る:
//   頭     … 最初の「// ===== 」の行の手前まで（import・偽のサーバー・check・waitUntil・newPage・ブラウザの起動）
//   節     … 「// ===== 」で始まる行から、次の同じ行（最後の節は後始末）の手前まで
//   後始末 … 最後の「await browser.close();」の行から終わりまで（件数の行と終了コード）
// 組 k の台本 = 頭 + 組 k の節（元の順） + 後始末。tests/ の下に一時ファイルとして書くので、頭の ROOT（import.meta.url から）や
// 節の中の import("../…") はそのまま動く。流し終えたら（中断されても）消す。
//
// 組の分け方は決定的（毎回同じ）: 節の重さ = CI で測った秒（下の SECONDS。節の名前 = 目印の行の「:」「（」の手前）。表に無い節
// （足した・名前を変えた）は行数 × 表の節の平均（秒／行）で見積もる。重い順（同じ重さなら前の節から）に、その時点でいちばん軽い組
// （同じなら番号の小さい組）へ入れる。行数や check( の数だけで分けると、1 行あたりの時間が節によって 1 桁違う（16.5 判定は打鍵の
// 間合いを待つので重い）ため、いちばん重い組が 1.5 倍に偏る（2026-10-11 の CI の秒で試算: 行数で 11.5 分・秒の表で 7.4 分）。
// 節はどれも { } の中で閉じていて、ページは newPage で毎回作り直すので単独で動く。前の節の変数・ページ・状態に頼る節を足すときは
// STICKY に書き、前の節と 1 かたまりで動かす。
// 組の中の節にかかった秒を最後に SECONDS の形で出す（CI の組のログから写せば表を更新できる）。件数の行（「N passed, M failed」）は
// 1 本のときと同じく最後の行。
//
// ローカルの npm test は 1 本のまま（並列で流すと負荷で時間に敏感な検査が揺れる）。npm test（node tests/e2e.mjs）は保留の節も流し、
// 節を包まないので、投げた節で止まる。保留を除いた全件は --all。

import fs from "fs";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { isMain } from "./lib/is-main.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "tests", "e2e.mjs");
const MARK = /^\/\/ ===== /;
const TAIL = /^await browser\.close\(\);/;

// 前の節と同じ組に置く節（節の名前で照合）。今は無い（2026-10-11 に 4 組で全件を確かめた）
export const STICKY = [];

// 保留の節（CI で流さない）: 節の名前 → 理由。Batch 78 段 6（創業者の決定 §10「削除または保留する旧 E2E」）。消さずに残し、--held で流せる。
// 分類（K = 仕様として CI に残す・U = 内部の仕組み〔単体が守る。通れば CI に残す〕・H = 外した機能）は S/b78/impl/e2e-final.tsv。ここは H と、落ちる U
export const HOLD = {
  "3. Daily Dash": "H: Daily は主導線から外した（ホームに札を出さない）",
  "4. ストリークカード＋苦手トグル＋ヘッダーストリーク表示": "H: 連続日数の札・苦手のみ・ヘッダーの連続日数はホームとヘッダーに出さない",
  "5. Challenge": "H: Challenge は主導線から外した",
  "6. モバイル": "H: Challenge の結果と道（前のホーム）。スマホの中心の学習は 78.3・78.6 が見る",
  "8.6 わたしの本棚": "H: 本棚（複数の教材から選ぶ）は主導線から外した",
  "8.6 窓の表紙": "H: 本棚の窓の表紙",
  "9. 難易度ゲート": "H: XP の難易度と他教科のカテゴリ（中心の学習で使わない）",
  "9.3 Challengeの手触り": "H: Challenge",
  "9.4 今日のセット": "H: 今日のセット（10／15／25 語）は中心の学習の回に替わった",
  "study 60s": "H: 60 秒の回",
  "9.5 学習データ": "H: 前の学習データ（カテゴリ別の進捗・段ごとの実測）。学習状況は 78.4 が見る",
  "9.5 覚えた瞬間 v2": "H: 知ってた・覚えた！のスタンプと語チップ（中心の学習で出さない）",
  "9.55 成長の証拠": "H: 週間レポート（詳しい記録の畳みの中）",
  "mastery": "H: 習熟度の 5 段の画面（段の名前を利用者の画面から外した）。決まりは test-mastery",
  "9.6 マイ単語帳": "H: マイ単語帳",
  "9.8 初回体験と継続": "H: 腕試し・回収・中身予告・週の目標。初めての人は 78.6 とチュートリアルが見る",
  "9.9 成長の証拠と獲得": "H: マイ単語帳の語のミスキー・カレンダー・CSV・単語帳の語の詳細（前の学習データ）",
  "9.955 学習のランク": "H: XP の 21 段のランクの画面（9 段に替えた。XP の決まりは test-level）。9 段は 78.4 と 9.956",
  "9.97 概念カード「リスティング広告 実務」": "H: 他教科の概念カード",
  "9.98 単語帳": "H: 単語帳（開くとホームへ案内する）",
  "9.99 Batch 5a": "H: マイ場面カード・救済・今月・記憶のゲージ",
  "9.995 Batch 5b": "H: 前の学習データの 3 つのタブ・苦手だけ練習・累計シェア",
  "9.999 Batch 6": "H: 計算ドリル・音で出題（出題の設定を出さない）",
  "9.9995 Batch 7a": "H: AI で場面カードを作る（マイ単語帳）",
  "9.9996 Batch 8": "H: 教材ライブラリ・分野パック",
  "Batch 58 ここまで": "H: 目印だけ（検査 0）",
  "10. 新カテゴリ「広告・マーケ」": "H: 目印だけ（検査 0。他教科）",
  "日本語の答えは読みをローマ字で打つ": "H: 日本語で答える教材（他教科）。判定は test-romaji・test-judge",
  "12. コース選択と制覇の演出": "H: コース選択と制覇",
  "12.5 Batch 47": "H: 「今日覚えた」の札とコースをまたぐ復習",
  "13. 道": "H: 道（コースのユニット）",
};
const isHeld = (s) => Object.hasOwn(HOLD, s.key);

// 節ごとの CI の秒（2026-10-13、main の CI〔run 38417468654・872b15e〕の 4 組のログの「節ごとの秒」。4 組で 1,947 件・節の秒の和 2,527 秒）に、
// Batch 66 で足した検査の秒の見積もり（手元の秒 × その節の CI／手元の比）を足したもの: 7.5 +4・7.55 +2・7.6 +10・8.7 +63（ヘッダーの字が 1 行の検査）・8.8 +15（初回の書斎の CLS の検査）・9.9996 +5。
// PR #168 のレビューで足した検査の見積もり: 7.5 +3（2 ページの窓の間は打鍵で始まらない）・8.7 +9（フッターの名前・家へのリンクの名前・連続日数の見た目）・8.8 +16（語の記録の 4 通り・判定の写しの突き合わせ・静的な積み）。
// Batch 67 で足した検査の見積もり: 8.6 書斎 +10（壊れた語の記録）・8.7 +75（ヘッダーの部品の重なり・battle／profile／packs の細い幅・全ページの横スクロール）・9.5 学習データ +19・9.98 単語帳 +19・19 Pro +52（読み込みの CLS +25・config だけが遅いとき +27）・9.7 +6（ご意見の窓の殻）。
// PR #170 のレビューで足した検査の見積もり: 8.6 書斎 +3（壊れた記録の写しの期限と上限）・8.7 +167（ヘッダーの重なり: フォントなし・代わりの字が広い・文字 1.3 倍と台の待ち方。合わせた木の手元 391 秒 × 0.89）・8.8 +0（welcome.js の鍵）・9.98 単語帳 +31（字を待つ時間・分野パックの見出しの行・.finally の 1 回）・19 Pro +72（料金の 1 行の予約・支払いの反映待ち。合わせた木の手元 194 秒）。
// Batch 68 で足した検査の見積もり: 2. Study +30・5. Challenge +5・study 60s +14・mastery +10・mastery writers +4・9.7 +2・Batch 58 +7・20 +3（記録の質）、
// 8.6 書斎 +8（語ごとの記録の質の保存 spelldash_memory_words が壊れていても止まらない: 2 ページ）。
// PR #172 のレビューで足した検査の見積もり: 2. Study +5（ヘッダーのログインの欄は outside・#setupToggle に焦点が残ったまま打つ・隣のキーの写しと #osk の矩形）・
// mastery writers +3（7 答えのあと裏に回るとその場で書く）・8.6 書斎 +1（上限で影のデータを消して語の記録を書き直す）。
// Batch 69 で足した検査の見積もり: 2.6 +7（英字の答えの大小文字: 2 ページ）・16.5 判定 +5（判定器で全カードを打つ〔Node だけ〕・品詞をまたぐ別解: 1 ページ）・日本語の答え +1（判定器で全カードの読み〔Node だけ〕）。
// ページごとの og-image（2026-10-15）で足した検査の見積もり: 1. 全ページ +3（ページごとの型を 2 ページ開く）。
// PR #176 のレビューで足した検査の見積もり: 1. 全ページ +1（SNS 用の絵をアプリに入れない。Node だけ）。
// 学習のランクで足した節の見積もり: 9.955 学習のランク 110（新しい節。手元 109 秒 × 9.95 の CI／手元の比 ≈ 1。幕を開く回 15・学習データ 23 ページ・読み込みの CLS 3 回・42 枚の大きさ）。
// PR #175 のレビューで足した検査の見積もり: 2.6 +5（盤面の外の元の綴り: ホームの「今日覚えた」・はちゃんの一言・学習データの 3 つの一覧を 1 ページで）・16.5 判定 +4（品詞の札の確かさ: eiken2＋nawl02 の盤面の 1 ページ）。
// Batch 70 で足した検査の見積もり: study 60s +25（60 秒の回の終わりの「時間がかかった」と語数のセット）・9.5 学習データ +10・mastery +10（語の詳細の思い出す速さ）・
// mastery writers +20（M1・M1'・Battle の ×・同期の控え、語の詳細の次の条件と完了パネルの「上がった」）・9.98 単語帳 +28（詳しく・簡潔の速さの語と行の高さ・履歴 8 点の語の札の行）。
// PR #178 のレビューで足した検査の見積もり: 9.955 学習のランク +128（覚えた と重なる・60 秒・腕試し・語数の最後・Daily の幕 6 回、先読み 2 回、学習データの行の高さ
// 〔2 つの行 × 3 つの書体 × 文字 3 倍率・夜を足して 27 ページ × 320〜414 の各幅〕・書体が遅れて届く 5 回、一覧の読み直し 3 回。関係する節を 1 本で流した手元 428 秒 − ほかの節の表の秒 190）。
// PR #178 の反証で足した検査の見積もり: 9.955 学習のランク +20（60 秒の回の途中で苦手のみ復習を切り替える回 1 つ・一覧を文字 3 倍率 × 2 書体〔1.3 倍は夜も〕の 8 ページ × 320〜414 の各幅。その 2 件だけを流した手元 約 22 秒）。
// PR #180 のレビューで足した検査の見積もり: mastery writers +20（ローマ字の答えの 1 打ミス 2 語・日付の無い古い行の「時間がかかった」〔3,500ms 待つ答え 2 つ〕。手元 約 18 秒）・
// 9.5 学習データ +2（別のタブが書いた後の実測の読み直し 2 件。手元 +1.0 秒）。9.955・study 60s の読み上げの待ちは決め打ちを「入るまで」に替えただけ（±0）。
// 窓の表紙（2026-10-16）で足した節の見積もり: 8.6 窓の表紙 120（新しい節。手元 約 120 秒 × 8.6 わたしの本棚の CI／手元の比 ≈ 1。窓の 15 ページ〔9 棚を開いて送る・
// 表紙を入れる前の形との 235 行の突き合わせ 3 幅・404 2 回〔390 昼・1200 夜。画面を撮って壊れた絵の印の画素を数える〕・遅れて届く絵 2 回・320／390／1200 × 昼夜〕と 22 枚の大きさ〔Node〕）。
// はちゃんの絵（2026-10-17）で足した節と検査の見積もり: 8.65 はちゃんの絵 85（新しい節。書斎と学習データの読み込みの CLS 12 回〔320／390／1200 × 昼夜〕・
// 結果のパネル 6 回〔Challenge の 3 秒〕・場面 6 枚の相関〔ページ 1 枚〕。関係する節を 1 本で流した手元 約 130 秒 − ほかの節の表の秒 47）・5. Challenge +1・9.99 Batch 5a +1（アバターの読み込みを待つ）。
// PR #183 のレビューで足した検査の見積もり: 8.6 窓の表紙 +70（寸法と書名の行数の幅を 3 → 7〔359.5・599.5 は zoom の iframe・599・600〕・404 の後の検索 5 打と online の読み直し・
// 404 の画素の件を分けた 2 件〔撮るのは同じ〕。節を 1 本で流した手元 約 190 秒 − 前の 120）。
// PR #183 のレビューの仕上げで足した検査の見積もり: 8.6 窓の表紙 +12（404 のほかの棚の件〔コース・英単語・試験の棚を開いて送り、2 枚撮る〕約 7 秒・遅い 404 で打ち替える件〔400ms の 404 を 2 回待つ・1 枚撮る〕約 5 秒）。
// PR #184 のレビュー（2026-10-17）で足した検査の見積もり: 8.65 はちゃんの絵 +10（dpr 1・2・3 の学習データ 3 回と dpr 3 の結果のパネル 1 回）・
// 8.6 書斎 +1（表示中の場面の 1 枚を読み直して上限と比べる 3 回）。5・9.5 覚えた瞬間 v2・9.55・9.99 はアバターの検査の場所を動かしただけ（±0）。
// Batch 72（2026-10-18）で足した検査の見積もり: mastery writers +60（M1 の道 a・道 b の 1 日目と 2 日目〔5 秒・1.8 秒〕のページ 6 枚と Challenge の乱数 0 の 2 枚。
// 節を 1 本で流した手元 208 秒）・2.6 +3（ヒントの 1 枚）・9.55 成長の証拠 +6（学習データを 0ms・80ms 遅延で開いて 2.5 秒ずつ待つ 2 枚）・mastery +2（語の詳細の次の復習の 1 枚）。
// PR #189 のレビュー（2026-10-21）で足した検査の見積もり: mastery writers +103（E1〜E12 の 14 件。ページ 18 枚〔2 日の答え・続きからの開き直しを含む。
// E12 は文法パックのカードを 2 日答える 2 枚・5 秒待つ答え 1 つで +10〕。その区切りだけを流した手元 83 秒〔E12 の前〕。節を 1 本で流した手元は 287〜334 秒、E12 の後 301 秒）・9.55 成長の証拠 +3（目録を落として学習データを開く 1 枚。手元の節 8 → 11 秒）。
// 2 Study は回の最初の語の検査を書き換えただけ（±0。手元 48 秒）。
// PR #191 のレビュー（2026-10-21）で足した検査の見積もり: 9.6 マイ単語帳 +5（利用者の場面カード SSL と CPC のホームと単語帳の 4 ページ。節を 1 本で流した手元 約 18 秒）・
// 9.98 単語帳 +2（日本語の名前で検索・語の詳細の別名）。
// Batch 74（2026-10-22）で足した検査の見積もり: 8.6 わたしの本棚 +15（プログラミングの英単語 1・2 の 5 件。窓の英単語の見出し・検索 2 回・棚に足す・机に出してスタート 2 回。
// その塊を 8.6 の頭の道具と流した手元 17 秒〔ブラウザの立ち上げを含む〕。節を 1 本で流した手元 136 秒）。
// 組の重さにだけ使う。ずれても落ちはせず、偏るだけ。節を足したら CI の組のログ（最後の「節ごとの秒」）から写す（表に無い節は行数で見積もる）
// Batch 75 で足した節の見積もり: 9.956 アカウントの紋章 200（新しい節。手元 150〜250 秒。7 ページ・読み込みの順と要求の数・遅い絵と 404・幕の後・60 秒の回・幅と昼夜・別のタブ・回の途中に届いた処理 C-P1〜P4）。
// Batch 76 で足した節の見積もり: 9.57 一冊を終えるまでの目安 80（新しい節。手元の実測から）。
export const SECONDS = {
  "1. 全ページがエラーなく表示される": 31, "2. Study": 48, "2.5 日本語IME＋Studyキュー配置": 3,
  "2.6 1ミス＝不正解＋スペル表示": 25, "3. Daily Dash": 6, "4. ストリークカード＋苦手トグル＋ヘッダーストリーク表示": 6,
  "5. Challenge": 12, "6. モバイル": 7, "7. お知らせページ＋フッターリンク": 3,
  "7.5 タイピング練習": 192, "7.55 タイピング練習の長文": 91, "7.6 タイピングゲーム": 148,
  "8. テーマ": 4, "8.5 書斎の土台": 3, "8.6 書斎": 40,
  "8.6 わたしの本棚": 154, "8.6 窓の表紙": 202, "8.65 はちゃんの絵": 95, "8.7 書斎の皮": 351, "8.8 書斎の仕上げ": 71,
  "8.9 Batch 57": 160, "9. 難易度ゲート": 3, "9.3 Challengeの手触り": 6,
  "9.4 今日のセット": 24, "study 60s": 194, "9.5 学習データ": 33,
  "9.5 覚えた瞬間 v2": 7, "9.55 成長の証拠": 11, "9.56 記憶の保持率": 12, "9.57 一冊を終えるまでの目安": 110,
  "mastery": 55, "mastery writers": 320, "9.6 マイ単語帳": 13,
  "9.7 学びの質": 25, "9.8 初回体験と継続": 73, "9.9 成長の証拠と獲得": 6,
  "9.95 Challenge・品質": 13, "9.955 学習のランク": 258, "9.956 アカウントの紋章": 100, "9.97 概念カード「リスティング広告 実務」": 6, "9.98 単語帳": 89,
  "9.99 Batch 5a": 28, "9.995 Batch 5b": 19, "9.999 Batch 6": 13,
  "9.9995 Batch 7a": 13, "9.9996 Batch 8": 70, "Batch 58": 190,
  "Batch 58 ここまで": 0, "10. 新カテゴリ「広告・マーケ」": 0, "日本語の答えは読みをローマ字で打つ": 32,
  "11. レビュー修正": 28, "12. コース選択と制覇の演出": 10, "12.5 Batch 47": 4,
  "13. 道": 2, "14. 前回の続きから": 14, "15. ネイティブアプリ": 19,
  "16. 同じ訳の語には例文の訳を文脈として添える": 14, "16.5 判定": 489, "17. 答え表示後の操作が1行": 3,
  "18. プレイヤー管理 CRM": 9, "19. SpellDash Pro": 195, "チュートリアル": 26,
  "20. Batch 48": 47, "78.2 3 状態の移行と保存": 10, "78.3 3 つの学習": 110, "78.4 学習状況とランク": 80, "78.5 導線と検索": 100, "78.6 ホームと旧 URL": 90, "21. Pro までの動線の計測": 6, "21.5 タイピング練習から来た端末": 40,
  "21.6 タイピングゲームから来た端末": 41,
};

// 節の名前: 目印の行から「// ===== 」と末尾の「=====」を除き、最初の「:」「：」「（」「(」の手前
export const sectionKey = (title) => title.split(/[:：（(]/)[0].trim();

export function splitE2E(src) {
  const lines = src.split("\n");
  const first = lines.findIndex((l) => MARK.test(l));
  const tail = lines.findLastIndex((l) => TAIL.test(l));
  if (first < 0 || tail <= first) throw new Error("tests/e2e.mjs の頭（最初の「// ===== 」）か後始末（await browser.close();）が見つからない");
  const starts = [];
  for (let i = first; i < tail; i++) if (MARK.test(lines[i])) starts.push(i);
  const sections = starts.map((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : tail;
    const title = lines[start].replace(MARK, "").replace(/\s*=+\s*$/, "");
    return { index: k, line: start + 1, title, key: sectionKey(title), text: lines.slice(start, end).join("\n"), lines: end - start };
  });
  // 重さ（秒）: 表にある節は表の秒、無い節は行数 × 表にある節の秒／行
  const known = sections.filter((s) => Object.hasOwn(SECONDS, s.key));
  const knownLines = known.reduce((a, s) => a + s.lines, 0);
  const perLine = knownLines ? known.reduce((a, s) => a + SECONDS[s.key], 0) / knownLines : 1;
  for (const s of sections) {
    s.estimated = !Object.hasOwn(SECONDS, s.key);
    s.weight = s.estimated ? Math.round(s.lines * perLine) : SECONDS[s.key];
  }
  return { head: lines.slice(0, first).join("\n"), sections, tail: lines.slice(tail).join("\n") };
}

// 組に分ける。sections は分ける節だけ（保留を除いた並びでもよい）。返す idx は splitE2E の節の番号（index）
export function planShards(sections, total) {
  const units = [];
  for (const s of sections) {
    if (units.length && STICKY.includes(s.key)) units.at(-1).push(s);
    else units.push([s]);
  }
  const order = units
    .map((list, k) => ({ idx: list.map((s) => s.index), k, weight: list.reduce((sum, s) => sum + s.weight, 0) }))
    .sort((a, b) => b.weight - a.weight || a.k - b.k);
  const shards = Array.from({ length: total }, () => ({ weight: 0, idx: [] }));
  for (const unit of order) {
    let best = 0;
    for (let j = 1; j < total; j++) if (shards[j].weight < shards[best].weight) best = j;
    shards[best].weight += unit.weight;
    shards[best].idx.push(...unit.idx);
  }
  for (const s of shards) s.idx.sort((a, b) => a - b);
  return shards;
}

// 組に入れる節（保留を除く。includeHeld なら全部）と保留の節
export function shardable(parts, includeHeld = false) {
  return includeHeld ? parts.sections : parts.sections.filter((s) => !isHeld(s));
}
export const heldSections = (parts) => parts.sections.filter(isHeld);

function buildScript({ head, sections, tail }, idx) {
  const timer = [
    "// ---- e2e-shard: 節ごとの秒と件数・投げた節を閉じて次へ（scripts/e2e-shard.mjs が足した。tests/e2e.mjs には無い） ----",
    "const __e2eShardTimes = [];",
    "let __e2eShardContexts = new Set();",
    "function __e2eShardLap(title) {",
    "  const now = Date.now();",
    "  const last = __e2eShardTimes.at(-1);",
    "  if (last) Object.assign(last, { ms: now - last.at, passed: passed - last.passed0, failed: failed - last.failed0 });",
    "  if (title !== null) __e2eShardTimes.push({ title, at: now, ms: 0, passed0: passed, failed0: failed, passed: 0, failed: 0, threw: false });",
    "  __e2eShardContexts = new Set(browser.contexts());",
    "}",
    "const __e2eShardErr = (e) => String(e?.stack ?? e).split(\"\\n\").slice(0, 6).join(\" ／ \");",
    "// 節が投げた: ✗ を 1 件数え、その節が開いたままの文脈（newPage のページ）を閉じて次の節へ",
    "async function __e2eShardThrew(title, e) {",
    "  const last = __e2eShardTimes.at(-1);",
    "  if (last) last.threw = true;",
    "  check(`節「${title}」が途中で投げた（この節の残りは流れていない。次の節へ進む）`, false, __e2eShardErr(e));",
    "  for (const c of browser.contexts()) if (!__e2eShardContexts.has(c)) await c.close().catch(() => {});",
    "}",
    "process.on(\"unhandledRejection\", (e) => check(\"待たれていない Promise が投げた（止めずに ✗ に数える）\", false, __e2eShardErr(e)));",
    ""
  ].join("\n");
  const report = [
    "",
    "__e2eShardLap(null);",
    'console.log("\\n節ごとの件数（この台本。「投げた」は途中で止まった節）:");',
    'for (const t of __e2eShardTimes) console.log(`  ${t.threw ? "投げた" : t.failed ? "✗ あり" : "      "}  ✓ ${t.passed}・✗ ${t.failed}  ${t.title}`);',
    'console.log("\\n節ごとの秒（この台本。scripts/e2e-shard.mjs の SECONDS の形）:");',
    'for (const t of __e2eShardTimes) console.log(`  ${JSON.stringify(t.title)}: ${Math.round(t.ms / 1000)},`);',
    ""
  ].join("\n");
  // 節は { } の中で閉じている（頭の名前だけを使う）ので、try { } で包んでも中身の意味は変わらない
  const body = idx
    .map((i) => {
      const key = JSON.stringify(sections[i].key);
      return `__e2eShardLap(${key});\ntry {\n${sections[i].text}\n} catch (__e2eShardError) {\n  await __e2eShardThrew(${key}, __e2eShardError);\n}`;
    })
    .join("\n");
  return `${head}\n${timer}\n${body}\n${report}\n${tail}`;
}

function parseShard(arg) {
  const m = /^(\d+)\/(\d+)$/.exec(arg ?? "");
  const k = m ? Number(m[1]) : NaN;
  const n = m ? Number(m[2]) : NaN;
  if (!(n >= 1 && k >= 1 && k <= n)) throw new Error(`組の指定は k/N（1 ≤ k ≤ N）: ${arg}`);
  return { k, n };
}

// 一時の台本の名前（tests/.e2e-shard-*.mjs は .gitignore にある）
function tempPath(label) {
  return path.join(ROOT, "tests", `.e2e-shard-${label}-${process.pid}.mjs`);
}

const weightOf = (parts, idx) => idx.reduce((a, i) => a + parts.sections[i].weight, 0);

function printPlan(parts, n, includeHeld) {
  const list = shardable(parts, includeHeld);
  const shards = planShards(list, n);
  const held = includeHeld ? [] : heldSections(parts);
  const est = list.filter((s) => s.estimated);
  console.log(`tests/e2e.mjs: 節 ${parts.sections.length} 個のうち ${list.length} 個・重さ ${weightOf(parts, list.map((s) => s.index))} 秒を ${n} 組に（* = SECONDS に無く行数から見積もった節: ${est.length} 個）`);
  shards.forEach((s, j) => {
    console.log(`\n組 ${j + 1}/${n}（重さ ${s.weight} 秒・節 ${s.idx.length} 個）`);
    for (const i of s.idx) {
      const sec = parts.sections[i];
      console.log(`  ${String(sec.weight).padStart(4)}${sec.estimated ? "*" : " "} L${sec.line}  ${sec.title.slice(0, 70)}`);
    }
  });
  if (held.length) {
    console.log(`\n保留（CI で流さない。--held で流す・--include-held で組に入れる）: 節 ${held.length} 個・重さ ${weightOf(parts, held.map((s) => s.index))} 秒`);
    for (const sec of held) console.log(`  ${String(sec.weight).padStart(4)}${sec.estimated ? "*" : " "} L${sec.line}  ${sec.key} … ${HOLD[sec.key]}`);
  }
}

// 台本の構文を node --check で見る。通らなければ false
function syntaxOk(parts, idx, label, tag) {
  const file = tempPath(tag);
  try {
    fs.writeFileSync(file, buildScript(parts, idx));
    const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (r.status === 0) return true;
    console.error(`${label} の台本が構文で通らない（節の目印「// ===== 」が { } の中にある？）:\n${r.stderr}`);
    return false;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function check(parts, n) {
  const all = parts.sections;
  // 節の名前（SECONDS・STICKY・HOLD の鍵）が重なると、どの節のことか決まらない
  const dup = all.filter((s, i) => all.findIndex((t) => t.key === s.key) !== i).map((s) => s.key);
  if (dup.length) throw new Error(`節の名前が重なっている（目印の行の「:」「（」の手前を変える）: ${JSON.stringify(dup)}`);
  // 保留の表の名前は今の節にあること（名前を変えた・消した節が表に残ると、保留したつもりの節が CI で流れる）
  const stale = Object.keys(HOLD).filter((k) => !all.some((s) => s.key === k));
  if (stale.length) throw new Error(`HOLD に tests/e2e.mjs に無い節の名前がある: ${JSON.stringify(stale)}`);
  const badReason = Object.entries(HOLD).filter(([, why]) => typeof why !== "string" || !why.trim()).map(([k]) => k);
  if (badReason.length) throw new Error(`HOLD の理由が空: ${JSON.stringify(badReason)}`);
  // 前の節と 1 かたまりで動く節（STICKY）は、前の節と保留かどうかがそろうこと
  const split = all.filter((s, i) => i > 0 && STICKY.includes(s.key) && isHeld(s) !== isHeld(all[i - 1])).map((s) => s.key);
  if (split.length) throw new Error(`STICKY の節と前の節で保留かどうかが違う: ${JSON.stringify(split)}`);
  // どの節も、ちょうど 1 つの組か保留のどちらか（保留を組に入れたときは、どの節もちょうど 1 つの組）
  const held = heldSections(parts).map((s) => s.index);
  for (const includeHeld of [false, true]) {
    const shards = planShards(shardable(parts, includeHeld), n);
    const seen = [...shards.flatMap((s) => s.idx), ...(includeHeld ? [] : held)].sort((a, b) => a - b);
    const once = seen.length === all.length && seen.every((v, i) => v === i);
    if (!once) throw new Error(`どの節も、ちょうど 1 つの組か保留のどちらかに入っていない${includeHeld ? "（--include-held）" : ""}: ${JSON.stringify(seen)}`);
  }
  // 頭（最初の節の手前）は全部の組に入るので、そこに検査があると件数が組の数だけ水増しされる
  if (/(^|[^\w.])check\(/m.test(parts.head.replace(/^function check\(/m, ""))) throw new Error("tests/e2e.mjs の頭（最初の「// ===== 」の手前）に check( がある。検査は節の中に書く");
  const shards = planShards(shardable(parts), n);
  let bad = 0;
  shards.forEach((s, j) => {
    if (!syntaxOk(parts, s.idx, `組 ${j + 1}/${n}`, `${j + 1}of${n}`)) bad++;
  });
  if (held.length && !syntaxOk(parts, held, "保留", "held")) bad++;
  if (bad) process.exit(1);
  console.log(`OK: ${n} 組（節 ${all.length} 個のうち ${all.length - held.length} 個はどれもちょうど 1 つの組に入り、${held.length} 個は保留〔CI で流さない〕。どの組の台本も保留の台本も構文が通る）`);
}

async function run(parts, idx, label, tag, total = null) {
  const heldOut = heldSections(parts).filter((s) => !idx.includes(s.index)).length;
  console.log(`E2E ${label}: 節 ${idx.length} 個（重さ ${weightOf(parts, idx)} 秒${total === null ? "" : `／全体 ${total} 秒`}）${heldOut ? `。保留の節 ${heldOut} 個は流さない（--held で流す）` : ""}`);
  for (const i of idx) console.log(`  L${parts.sections[i].line}  ${parts.sections[i].title.slice(0, 70)}`);
  const file = tempPath(tag);
  fs.writeFileSync(file, buildScript(parts, idx));
  const cleanup = () => fs.rmSync(file, { force: true });
  process.on("exit", cleanup);
  const child = spawn(process.execPath, [file], { stdio: "inherit", env: process.env });
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      child.kill(sig);
      cleanup();
      process.exit(130);
    });
  }
  const code = await new Promise((resolve) => child.on("close", (c, signal) => resolve(signal ? 1 : c ?? 1)));
  cleanup();
  process.exit(code);
}

// 直接呼ばれたときだけ動く（symlink を含むパスで呼ばれても実体のパスでそろえて比べる）
if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.findIndex((a) => a === name || a.startsWith(name + "="));
    if (i < 0) return undefined;
    return args[i].includes("=") ? args[i].slice(name.length + 1) : args[i + 1];
  };
  // 何度でも書ける名前（--only）の値をすべて
  const opts = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : a.startsWith(name + "=") ? [a.slice(name.length + 1)] : []));
  const includeHeld = args.includes("--include-held");
  const parts = splitE2E(fs.readFileSync(SRC, "utf8"));
  if (opt("--plan") !== undefined) {
    const n = Number(opt("--plan"));
    if (!(n >= 1)) throw new Error("--plan N（N ≥ 1）");
    printPlan(parts, n, includeHeld);
  } else if (opt("--check") !== undefined) {
    const n = Number(opt("--check"));
    if (!(n >= 1)) throw new Error("--check N（N ≥ 1）");
    check(parts, n);
  } else if (args.includes("--held")) {
    const held = heldSections(parts).map((s) => s.index);
    if (!held.length) throw new Error("保留の節が無い（HOLD が空）");
    await run(parts, held, "保留の節", "held");
  } else if (opt("--only") !== undefined) {
    const names = opts("--only");
    const unknown = names.filter((k) => !parts.sections.some((s) => s.key === k));
    if (unknown.length) throw new Error(`--only の名前の節が無い（節の名前は --plan の行。目印の「:」「（」の手前）: ${JSON.stringify(unknown)}`);
    await run(parts, parts.sections.filter((s) => names.includes(s.key)).map((s) => s.index), "名前の節", "only");
  } else if (args.includes("--all")) {
    await run(parts, shardable(parts, includeHeld).map((s) => s.index), includeHeld ? "全部の節（保留も）" : "保留でない節（CI の 4 組と同じ）", "all");
  } else {
    const { k, n } = parseShard(opt("--shard") ?? args.find((a) => /^\d+\/\d+$/.test(a)));
    const shards = planShards(shardable(parts, includeHeld), n);
    await run(parts, shards[k - 1].idx, `組 ${k}/${n}`, `${k}of${n}`, shards.reduce((a, s) => a + s.weight, 0));
  }
}
