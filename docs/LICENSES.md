# 出典とライセンス

SpellDash が使う外部の語彙リストの出典と、その扱い。元のファイルは `data/sources/`（取得の経緯と収録しなかった語は data/sources/ngsl/LICENSE.md）。

- この文書はサイトに載らない（.vercelignore が docs/ を外す）。利用者に見せる出典は画面に出す（下の「画面での表示」）。
- 法的な助言ではない。同梱のファイルで確かめられなかったことは「未確認」と書く。

## 公開する教材「英単語」: NGSL 1.2

公開する 2,857 語（data/public/english.json。形は docs/PACK_FORMAT.md「公開する英単語」）は、NGSL 1.2 の 2,809 語と、SpellDash が足した 48 語。

| 項目 | 中身 |
|---|---|
| リスト | New General Service List（NGSL）1.2。2,809 語（data/sources/ngsl/NGSL_1.2_stats.csv の語の行の数） |
| 作者 | Browne, C., Culligan, B. & Phillips, J. (2013)（data/sources/ngsl/LICENSE.md）。同梱の NAWL の説明文の参考文献も同じ 3 人・2013 年（"New general service list 1.20"） |
| ライセンス | Creative Commons Attribution-ShareAlike 4.0 International（CC BY-SA 4.0）。URL: https://creativecommons.org/licenses/by-sa/4.0/（要約のページ。法的な本文は末尾に legalcode を付けた URL） |
| 配布元 | https://www.newgeneralservicelist.com/（LICENSE.md の一次配布元。パックの `source.url` も同じ） |
| 取り方 | 一次配布元に届かなかったので、ミラー（写し）から取り、語数で照合した（LICENSE.md）。一次配布元の版と同じかは未確認 |
| 使った所 | 語の選定と順位（CSV の SFI Rank）。scripts/build-openlist-packs.mjs が 24 巻（data/packs/ngsl01〜24.json）に切った。語形の一覧（NGSL_1.2_lemmatized_for_research.csv）は例文の語形の候補と、タイピング練習の長文の語の照合（scripts/build-typing-long.mjs）に使った |

SpellDash が変えたこと:
- 数・曜日・月の 48 語を足した。NGSL に無い語で、ngsl01 の頭に置く（scripts/build-openlist-packs.mjs の SUPPLEMENTARY。one・may・march は NGSL の語なので足していない）。公開の表では順位 0。
- 訳・品詞・例文・別解は SpellDash が書いた。品詞と難しさ（level）の初期値は CEFR-J を参照した（下の表。scripts/build-openlist-packs.mjs の頭の注釈）。
- 学ぶ順は NGSL の順位のまま。機能語（tags[0] が fn。前置詞・接続詞・代名詞など）122 語だけを最後に回した（data/public/english.json の order）。
- 同じことを data/public/english.json の `source.changes` に 1 文で持つ（生成器 scripts/build-public-vocab.mjs が数から作る）。

Share-Alike の範囲: SpellDash は「リストに由来する部分（語の選定と順序）が CC BY-SA 4.0 の条件（出典表示・同一条件での共有）に従う」と解釈している（LICENSE.md）。訳・例文と組み合わせた教材全体にどう及ぶかは未確認（専門家の確認は無い）。

## 画面での表示

- 今: パックのページ（packs/ngsl*.html。scripts/build-pack-pages.mjs の「出典」の節）に、リスト名と配布元へのリンク・ライセンス名・頻度順位・「訳・品詞・例文は SpellDash が作成」を出す。作者名とライセンスへのリンクは無い。利用規約（terms.html「6. 教材と著作権」）は「出典を各パックのページに表記」と書く。
- Batch 78 で、学習状況の画面と、規約または教材の情報から常に見られるようにする（創業者の決定 §1・§9-17）。表示は data/public/english.json の `source` を読む。パックのページは noindex で残してよい（決定 §1）。
- 公開していないリスト（下の表の TSL・BSL・NAWL・NGSL-Spoken・NDL・CEFR-J）は data/ に残り配信されるので、出典とライセンスを利用規約の「6. 教材と著作権」の「公開していない教材のデータ」（terms.html#dataSources）に出す（創業者の決定 2026-10-28。Batch 78 段 6）。data/sources にリストを足したら規約にも足す（E2E 78.5 の (8) がファイルの名前と突き合わせる）。

## データとして残し、公開しないもの

公開の対象から外す（Batch 78）。パック・元のファイル・利用者の記録は消さない。

| リスト | 元のファイル | 作者・ライセンス（同梱のファイルの記載） | 扱い |
|---|---|---|---|
| TSL 1.2（TOEIC Service List） | data/sources/ngsl/TSL_1.2_stats.csv → data/packs/tsl01〜11 | NGSL ファミリーのリスト・CC BY-SA 4.0（LICENSE.md）。配布元 https://www.newgeneralservicelist.com/toeic-list（パックの source）。TSL 単独の作者と年を書いたファイルは同梱に無い（LICENSE.md はフォルダのリストをすべて Browne・Culligan・Phillips の NGSL プロジェクトのものとする。未確認） | 公開しない。将来の追加の候補 |
| BSL 1.01（Business Service List） | data/sources/ngsl/BSL_1.01_SFI_freq_bands.csv（ほかに BSL 1.20 の説明文）→ data/packs/bsl01〜15 | Browne, C. & Culligan, B. (2016)（同梱の BSL 1.20 の説明文。そこでは版を 1.0 と書く）・CC BY-SA 4.0（LICENSE.md）。配布元 https://www.newgeneralservicelist.com/bsl-business-service-list | 公開しない。将来の追加の候補 |
| NAWL 1.2（New Academic Word List） | data/sources/ngsl/NAWL_1.2_alphabetized_description.txt → data/packs/nawl01〜08 | Browne, C., Culligan, B. & Phillips, J. (2013)（同梱の説明文）・CC BY-SA 4.0（LICENSE.md）。配布元 https://www.newgeneralservicelist.com/nawl-new-academic-word-list | 公開しない。将来の追加の候補 |
| CEFR-J Vocabulary Profile 1.5 | data/sources/cefrj/cefrj-vocabulary-profile-1.5.csv | 東京外国語大学 投野由紀夫研究室。配布元 https://github.com/openlanguageprofiles/olp-en-cefrj（Open Language Profiles）。利用条件は「配布元の記載に従う」とだけある（LICENSE.md）。中身は未確認なので、NGSL ファミリーの CC BY-SA 4.0 と同じ扱いにしない | 教材ではない。生成パックの品詞と level の初期値（scripts/build-openlist-packs.mjs）と、タイピング練習の長文の語の照合（scripts/build-typing-long.mjs）に使う。語の一覧は教材に写さない |
| NGSL-Spoken 1.2・NDL 1.1 | data/sources/ngsl/ の説明文 | NGSL ファミリー・CC BY-SA 4.0（LICENSE.md） | 収録していない（LICENSE.md「収録しないリストと、その理由」） |

## 未確認

- 配布元の URL: 同梱の NAWL・BSL の説明文の参考文献は http://www.newgeneralservicelist.org/ と書く。.com と .org のどちらが今の配布元かは未確認（2026-10-27 に、この環境からはどちらも開けなかった）。CC BY-SA 4.0 の URL（要約のページと legalcode）も、同じ日に開けていない。
- 一次配布元の版と、同梱の CSV（ミラーから取得）が同じか。
- data/ はサイトに載る（.vercelignore に無い）ので、data/sources/ の元のファイル（CEFR-J の CSV を含む）も配信されている見込み。本番では確かめていない。
- Share-Alike が訳・例文を含む教材全体に及ぶか、有料の機能の中で使うことに条件があるか。
