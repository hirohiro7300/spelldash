# 流入元計測（Acquisition Tracking）設計書

```
Status: DESIGN ONLY（実装・SQL実行は創業者承認後）
関連: docs/ADS.md（広告クリエイティブDRAFT）
```

## 目的

広告・SNS投稿ごとのUTM付きURL（例: `https://www.spelldash.net/?utm_source=tiktok&utm_medium=organic&utm_campaign=t2`）から、**どの投稿が実際にプレイ・継続につながったか**を後から評価できるようにする。

## 方針（創業者決定済み）

- activity_daysへのUTM列追加は**行わない**
- 初回流入元は **profiles** に保存（第一候補）
- 未ログイン時はlocalStorageに**初回のみ**保存 → ログイン時にprofilesへ同期
- **既存の値は上書きしない**（First-touch attribution: 最初の流入元だけを永続保持）

## データ設計

### localStorage（未ログイン・全ユーザー共通の一次保存）

キー: `spelldash_acquisition`（JSON、**存在したら二度と書かない**）

```json
{
  "source": "tiktok",      // utm_source（無ければ document.referrer のホスト名、それも無ければ "direct"）
  "medium": "organic",     // utm_medium（無ければ null）
  "campaign": "t2",        // utm_campaign（無ければ null）
  "content": null,          // utm_content
  "acquiredAt": "2026-07-20T12:34:56.000Z"
}
```

- 保存タイミング: main.js等の起動時に1回。`localStorage.getItem`がnullの場合のみ書く
- 値は最大64文字に切り詰め＋英数と`-_.`のみに正規化（後述のセキュリティ参照）

### Supabase（profiles列追加・SQL案）

```sql
alter table public.profiles
  add column if not exists acquisition_source   text,
  add column if not exists acquisition_medium   text,
  add column if not exists acquisition_campaign text,
  add column if not exists acquisition_content  text,
  add column if not exists acquired_at          timestamptz;
```

### RLS

- **追加ポリシー不要**。profilesは既に `select/insert/update = 本人のみ`（profiles_select_own / insert_own / update_own）で、acquisition列も同じ保護下に入る
- 集計（どの広告が効いたか）は創業者がSQL Editor（service_role相当）で実行するため、公開ポリシーは不要
- grantも既存の `grant select, insert, update on profiles to authenticated` で足りる

### 同期ロジック（auth.js または sync.js）

1. ログイン確立時、`spelldash_acquisition` があればprofilesを読む
2. **profiles.acquisition_source が null の場合のみ** upsert で5列を書く（既存値は上書きしない=First-touch保持）
3. 書き込み成功後もlocalStorageは消さない（ログアウト→別アカウントの初回判定に使わない。あくまで端末の初回流入）

## 匿名ユーザーの扱い

- 未ログインユーザーはprofiles行が存在しない → localStorageのみに保持（クラウド送信なし＝プライバシー上も最小）
- 匿名のまま辞めたユーザーの流入元は**計測できない**（許容する）。匿名の行動量はactivity_daysで別途見えるため、「投稿→アクセス増」の相関はXのアナリティクス＋activity_daysの日次件数で代替評価
- 将来Supabaseの匿名認証を導入する場合もこの設計のまま動く（行ができた時点で同期）

## 影響範囲

| 箇所 | 変更 |
|---|---|
| 新規 js/acquisition.js | URLパース＋初回保存（~40行） |
| js/main.js ほか各ページ | 起動時に1回呼ぶ（1行×5ページ or main系のみ） |
| js/auth.js or sync.js | ログイン時の1回同期（~20行） |
| supabase/schema.sql | 上記SQL追記（実行は承認制） |
| 既存機能への影響 | なし（読み取り専用の追加。ゲームロジック・同期本体に触れない） |
| プライバシーポリシー | 「流入元パラメータを保存する」旨の追記が必要（1行） |

## セキュリティ・プライバシー考慮

- UTM値はユーザーが自由に操作できるURL由来 → **保存前に正規化必須**（長さ制限64・許可文字 `[a-z0-9-_.]`・小文字化）。表示にはどこにも出さない（XSS面の露出なし）
- 個人特定情報は含まない（IP・フィンガープリント等は収集しない）
- referrerはホスト名のみ保存（フルURLは保存しない）

## テスト項目（実装時のE2E追加案）

1. `/?utm_source=tiktok&utm_campaign=t2` 初回訪問 → localStorageに正しく保存
2. 2回目訪問（別UTM付き）→ **上書きされない**
3. UTMなし直接訪問 → source="direct"
4. 異常値（長大文字列・スクリプト断片）→ 正規化されて保存
5. ログイン時 → profilesへ1回だけ同期（モックで検証）

## 見積り

実装0.5日＋SQL1回（承認制）。広告投稿開始（ADS.md T2）より**前**に入れるのが理想だが、オーガニック検証第1弾はXアナリティクス＋activity_days日次件数でも代替可能なため、ブロッカーではない。
