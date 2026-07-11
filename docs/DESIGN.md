# SpellDash 設計書

## ビジョン

```
SpellDash（英単語タイピング）
  ↓
Knowledge Map Platform
  ↓
自分の知識と成長を可視化するサービス
```

- **表向き**：知的な成長可視化ツール（Minimal / Cyber / Focus / Growth / Knowledge）
- **裏側**：ゲーミフィケーション（XP・レベル・称号・コンボ・ストリーク）

ゲーム性を露骨に見せず、大人がカフェで開ける見た目を保ちながら、継続の仕組みは裏で回す。

## UI方向性

Monkeytype / Notion / Obsidian 系のミニマル。

## Knowledge Map 構想

人間の知識をノード（知識アイテム）とエッジ（つながり）で可視化する。

```
Apple → Fruit → Nutrition → Health
```

表現するもの：知識の量 / 知識同士の繋がり / 苦手領域 / 成長。

将来的には英語だけでなく 数学・歴史・化学・投資・プログラミング へ拡張する。

## データ設計

### ファイル構造

```
data/
  manifest.json        ← 教科・カテゴリの台帳
  english/
    junior.json highschool.json toeic.json
    business.json it.json travel.json daily.json
```

- 教科を増やす → `data/<subject>/` を作り manifest に追記するだけ
- カテゴリを増やす → JSONを1つ置いて manifest に追記するだけ

### 単語スキーマ

```json
{
  "subject": "english",
  "category": "junior",
  "label": "中学英語",
  "words": [
    { "id": "apple", "en": "apple", "ja": "りんご", "level": "easy", "tags": ["food"] }
  ]
}
```

- `subject` / `category` はファイル先頭に1回だけ書き、ローダー（js/wordData.js）が
  読み込み時に全単語へ注入する。実行時のレコードは常に subject を持つ
- `id` は文字列。将来 `prerequisites: ["fruit"]` や `links` をIDで張れば
  そのまま Knowledge Map のグラフになる
- `tags` は横のつながり（マップのエッジ候補）

### ロード方式

- `js/wordData.js` … manifest とカテゴリJSONを fetch（キャッシュ付き）
- `js/wordStore.js` … ページ内の単語ストア。カテゴリ絞り込み・検索・索引
- ゲームはカテゴリ選択チップ（localStorageに保存）で出題範囲を切り替え

### 学習データ

localStorageに保存（キーは単語の `en`）：

- 単語ごと: playCount / correctCount / missCount / cleanCorrectStreak / mastered
- タイピング: correctChars / missChars / seconds / sessions / bestSpeed
- 成長: XP（spelldash_xp）/ ストリーク（spelldash_streak）

## 記憶要素

- 意味記憶：日本語訳から英単語を思い出す
- 運動記憶：指で打つ
- 色彩記憶：アルファベットごとの固定色
- 反復記憶：ミスした単語を優先的に再出題（重み付き抽選）

## ロードマップ

1. ~~XP・レベル・称号・コンボ・ストリーク~~（済）
2. ~~カテゴリ別データ構造（1000語規模）~~（済）
3. UIのミニマル化（Monkeytype/Notion系へ）
4. 学習データのクラウド保存（Supabase、端末間共有）
5. Knowledge Map の可視化（タグ・つながりのグラフ表示）
6. 英語以外の教科追加
