# NGSL ファミリーの語彙リスト（出典・ライセンス）

このフォルダの CSV / TXT は、Charles Browne・Brent Culligan・Joseph Phillips による **New General Service List (NGSL) プロジェクト**の公開リストです。

- NGSL 1.2（New General Service List, 2,809 語）— Browne, C., Culligan, B. & Phillips, J. (2013)
- NAWL 1.2（New Academic Word List）、TSL 1.2（TOEIC Service List）、BSL 1.01 / 1.2（Business Service List）、NGSL-Spoken 1.2、NDL 1.1（New Dolch List）
- ライセンス: **Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)**
- 一次配布元: https://www.newgeneralservicelist.com/ （この環境からは到達できなかったため、GitHub 上のミラーから取得。内容は語数で照合）

SpellDash はこれらのリストを「どの語を、どの順に出すか」の骨組みとして使い、日本語訳・品詞・例文は SpellDash 側で書き足しています。
リストに由来する部分（語の選定と順序）は CC BY-SA 4.0 の条件（出典表示・同一条件での共有）に従います。アプリ内のパック紹介と docs/LICENSES.md に出典を表示します。

## 収録できなかった語（TSL・BSL）

SpellDash の見出し語（`en`）は「小文字の英字とハイフンだけの1語」に限られます（タイピングで打つ対象なので）。
TSL 1.2 のうち次の3語はこの形に入らないため収録していません。

| 語 | TSL 順位 | 理由 |
|---|---|---|
| o'clock | 10 | アポストロフィを含む |
| ice cream | 291 | 2語 |
| ma'am | 725 | アポストロフィを含む |

BSL 1.01 では次の1語を外しています。

| 語 | BSL 順位 | 理由 |
|---|---|---|
| ordinate | 1096 | co-ordinate を分割した断片。単独では使わず、訳を書くと「co-ordinate と打つ」問題になってしまう |

アクセント記号のある résumé（26位）・café（105位）・entrée（714位）は、標準的な無記号つづり
（resume / cafe / entree）で収録しています。それ以外に落とした語はありません
（`node scripts/build-openlist-packs.mjs tsl` が収録できなかった語を必ず表示します）。

# CEFR-J Vocabulary Profile

`../cefrj/cefrj-vocabulary-profile-1.5.csv` は東京外国語大学 投野由紀夫研究室の CEFR-J Vocabulary Profile（Ver 1.5）です。
品詞と CEFR レベル（A1〜B2）の参照に使います。配布元: https://github.com/openlanguageprofiles/olp-en-cefrj （Open Language Profiles、利用条件は配布元の記載に従う）。
