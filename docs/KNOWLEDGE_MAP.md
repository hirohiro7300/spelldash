# Knowledge Map 設計ドキュメント（2026-07-15 / 実装前の設計のみ）

## ビジョン

「覚えた単語が孤立した点ではなく、つながった地図になる」。
学習が進むほど自分の知識マップが育っていく可視化は、進捗の実感（継続）と
体系的な記憶（学習効率）の両方に効く。SpellDashの長期ビジョン「Knowledge Map Platform」の中核。

## 現状の土台（済）

- 単語ID: `english-apple` 形式（教科-単語）。他教科（`math-` 等）へ拡張可能
- カテゴリ間重複語は同一IDで学習記録を共有（=ノードは一意）
- tags: 全1000語に付与済み（food / business / software 等）
- 学習状態: mastered / cleanCorrectStreak / recallFail などノードの「色」に使える

## データ設計（提案）

単語エントリに任意フィールドを追加（後方互換・段階的付与）:

```jsonc
{
  "id": "english-investment",
  "en": "investment",
  "ja": "投資",
  "level": "normal",
  "tags": ["finance"],
  // ---- Knowledge Map 拡張（すべて任意） ----
  "root": "vest",                    // 語根ファミリー（invest, vest, investor...）
  "family": ["english-invest", "english-investor"],  // 派生語（双方向にしない。表示時に逆引き）
  "links": [                          // 意味的なつながり
    { "to": "english-profit", "type": "related" },   // 関連
    { "to": "english-saving", "type": "contrast" }   // 対比
  ],
  "prerequisites": ["english-invest"] // これを先に覚えると効率が良い
}
```

### 設計判断

1. **エッジは「保存は片方向・表示は双方向」**: データ量と保守コストを半減。逆引きはロード時にインデックス化
2. **typeは3種から開始**: `family`（派生・語根）/ `related`（連想）/ `contrast`（対義・対比）。増やすのは後
3. **prerequisitesはUI推薦にのみ使用**（出題ブロックはしない。学習の自由を奪わない）
4. **語根（root）を最優先で付与する**: 派生語ファミリーは機械的に検証しやすく、学習効果のエビデンスも強い

## 付与戦略（データが本体）

- Phase A: 頻出語根30個 → 該当語 約150語に `root`/`family` を付与（AI生成 → 機械検証: family相互参照の整合・ID存在チェック → 人力サンプル校閲）
- Phase B: カテゴリ内の `related` リンク（例: travel の airport–luggage–boarding）
- Phase C: `contrast`（buy/sell, profit/loss...）
- 検証スクリプト: `family`/`links.to`/`prerequisites` のID実在・自己参照禁止・重複禁止をCI的にチェック（validate_words.mjs拡張）

## UI構想（軽い順に段階導入）

1. **単語詳細ポップ（最小・最初にやる）**: 答え表示時に「同じ仲間: invest / investor」を1行表示。地図の"予告編"
2. **語根ファミリーカード（stats.html）**: root単位の習得率バー（vest族 3/5 など）。「族を完成させたい」収集欲
3. **マップビュー（本命・最後）**: タグ×習得状態のクラスタ表示から開始（力学グラフは重いので採用しない）。
   SVGで「島（タグ）ごとに単語ドット、覚えた語だけ点灯」→ 自分の地図が育つ画面

## やらないこと

- 力学シミュレーション型の巨大グラフ（重い・スマホで操作不能・情報過多）
- 全1000語への一括リンク付与（品質が担保できない。語根ファミリーから段階的に）
- リンクデータのDB化（当面は静的JSONで十分。編集フローが必要になったら再検討）

## 実装順序の提案

1. データ: 語根30ファミリー付与＋検証スクリプト拡張（0.5日）
2. UI: 答え表示時の「同じ仲間」1行（0.5日）→ 効果測定
3. UI: 語根ファミリーカード（1日）
4. UI: マップビュー v1（タグ島＋点灯、2〜3日）
