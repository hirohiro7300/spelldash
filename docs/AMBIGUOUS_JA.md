# 訳が曖昧な語の洗い出し（BACKLOG G1、創業者確認用）

> 2026-09-21 作成。データは変更していない。置換案に ○ を付けてもらえれば反映する。
> 実装側の手当て（Batch 25）: 同じカテゴリに同じ訳の語が複数あるときは、出題文の下に例文の訳を添えるようにした（英語は見せない）。以下の 14 組はすでにこの文脈つきで出題される。

## 1. 同じカテゴリ内で訳が同じ語（14組・28語）

訳だけでは答えが一つに決まらない組。例文の訳で区別できるが、訳そのものも分けた方が学習者に親切。

| パック | 訳 | 語 | 置換案（訳を分ける） |
|---|---|---|---|
| 中学英語1年 | 話す | speak / talk | speak: 話す（言葉・言語を） ／ talk: しゃべる・話し合う |
| 中学英語1年 | 授業 | class / lesson | class: 授業・クラス（学級） ／ lesson: レッスン・（教科書の）課 |
| 中学英語3年 | 宇宙 | universe / space | universe: 宇宙（全体） ／ space: 宇宙空間・空間 |
| 英検5級→4級 | 会社 | office / company | office: 事務所・オフィス ／ company: 会社 |
| 英検4級 | うれしい | happy / glad | happy: 幸せな・うれしい ／ glad: （〜して）うれしい |
| 英検3級 | 計画 | plan / project | plan: 計画・予定 ／ project: 事業・プロジェクト・課題 |
| 英検2級 | 十分な | adequate / sufficient | adequate: 適切な・まずまず十分な ／ sufficient: 十分な（量が足りる） |
| 英検準1級 | 統合 | integration / synthesis | integration: 統合（一体化） ／ synthesis: 合成・総合 |
| 英検1級 | 難解な | abstruse / esoteric | abstruse: 難解な（理解しにくい） ／ esoteric: 秘教的な・一部の人にしか分からない |
| TOEIC 500 | 料金 | fee / charge | fee: 料金・手数料（サービスへの） ／ charge: 請求額・請求する |
| TOEIC 600 | 倉庫 | warehouse / storage | warehouse: 倉庫（建物） ／ storage: 保管・収納 |
| TOEIC 600 | 利益 | benefit / profit | benefit: 恩恵・福利厚生 ／ profit: 利益（もうけ） |
| TOEIC 730 | 契約 | contract / agreement | contract: 契約（書） ／ agreement: 合意・協定 |
| TOEIC 730 | 評判 | publicity / reputation | publicity: 宣伝・世間の注目 ／ reputation: 評判・名声 |

## 2. カタカナだけの訳（225語）

`クリック／click`、`マーケティング／marketing`、`ソフトウェア／software` のように、訳がそのまま英語の音写になっている語。曖昧ではないが「読めば分かる＝思い出す練習にならない」語が多い。IT（約60語）と広告・マーケに集中。

- 案 A: そのまま残す（実務で綴りを打てることに価値がある。IT はカタカナ語を英語で書く場面が多い）
- 案 B: 訳に短い説明を添える（例: `クリック（マウスで押す）`、`ソフトウェア（プログラム一式）`）。出題の難度は上がる
- 案 C: レベル easy に固定し、腕試し・新語導入の序盤だけで出す

機械抽出の条件: 訳がカタカナと長音のみ・3文字以上。一覧は `node -e` で再現できる（docs/STATUS.md 2026-09-21 参照）。

## 3. 1文字の訳（180語）

`犬／dog`、`水／water` など。曖昧ではないので対応不要（参考数値）。
