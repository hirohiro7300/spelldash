# SpellDash アプリ版（iOS / Android）— 手順と現状

> 2026-09-16 創業者判断「アプリ版の完成が一番先」。DECISIONS_V4 §8「現時点でしない」は解除。
> 方式は **Capacitor**（既存の Web をそのまま WebView アプリにし、触覚・スプラッシュ・ステータスバー等だけネイティブ）。
> **v1 の完成 = 創業者の iPhone に TestFlight（または実機直挿し）で入り、毎日使える状態。** ストア公開は v2。

## 1. 何がどこにあるか

| もの | 場所 | 備考 |
|---|---|---|
| Capacitor 設定 | `capacitor.config.json` | appId `net.spelldash.app`、webDir `dist` |
| Web → dist の組み立て | `scripts/build-app.mjs`（`npm run app:build`） | index/list/stats/profile/battle/news/privacy ＋ css/js/data/assets。api・packs/・sitemap は入れない |
| iOS プロジェクト | `ios/App/App.xcodeproj` | Swift Package Manager（CocoaPods 不要）。`ios/App/App/public` は生成物（git 管理外） |
| Android プロジェクト | `android/` | `android/app/src/main/assets/public` は生成物（git 管理外） |
| アイコン・スプラッシュの元 | `assets/app/`（icon.png 1024 / splash.png 2732） | `npx @capacitor/assets generate --assetPath assets/app --ios --android` で各サイズを生成済み |
| 実行環境の分岐 | `js/appEnv.js` | アプリなら `html.native-app`、API は `https://www.spelldash.net/api/...`、認証のリダイレクトも本番へ |
| 専用キーボード | `js/keyboard.js` / `css/keyboard.css` | A〜Z＋⌫＋Enter（＋英文カードのみ空白）。タッチ端末で自動オン、設定で常時オン／オフ |
| Service Worker | 各ページの登録スクリプト | `window.Capacitor` があるときは登録しない |

## 2. 創業者側の手順（Mac が必要）

### 準備（初回だけ）
1. Xcode（App Store から）と Command Line Tools。`xcode-select --install`
2. Apple Developer Program に登録（年額）。Google Play は Play Console（初回のみの登録料）
3. `git pull` してから `npm install`

### iOS を実機で動かす
```bash
npm run app:ios          # dist を作り直し → cap sync ios → Xcode が開く
```
Xcode で:
1. 左のツリーで `App` → TARGETS `App` → **Signing & Capabilities** → Team に自分の Apple ID のチームを選ぶ（Automatically manage signing ON）
2. Bundle Identifier は `net.spelldash.app`（既に入っている。Team と重複していたら末尾を変える）
3. 上部のデバイス選択で自分の iPhone（USB 接続、または同じ Wi-Fi）を選び ▶ Run
4. 初回は iPhone 側で 設定 → 一般 → VPNとデバイス管理 → 開発者を信頼

### TestFlight に上げる（自分の端末に「ちゃんとしたアプリ」として入れる）
1. App Store Connect で App を作成（名前 SpellDash、Bundle ID `net.spelldash.app`、SKU 任意）
2. Xcode: Product → Archive → Distribute App → App Store Connect → Upload
3. App Store Connect → TestFlight → 内部テスト に自分を追加 → iPhone の TestFlight アプリからインストール
4. 以後、Web を更新するたびに `npm run app:ios` → Archive → Upload（内部テストは審査なしで数分で配信）

### Android（任意）
```bash
npm run app:android      # dist → cap sync android → Android Studio が開く
```
Android Studio で ▶ Run（USB デバッグ ON の端末）。Play への配信は Build → Generate Signed Bundle。

## 3. 制約と既知の課題（v1 で受け入れるもの）

| 事項 | 状態 | 対応 |
|---|---|---|
| Google ログイン | アプリ内 WebView では Google が拒否する（`disallowed_useragent`） | v1 では使わない。v2 で `@capacitor/browser`＋Universal Links、または Sign in with Apple |
| メールのログインリンク | リンクは Safari で開き、アプリにはセッションが入らない | v1 はローカルのみで使う（Local-First なので学習は全部動く）。v2 で Universal Links |
| 教材・コードの更新 | dist を同梱しているので、更新のたびにビルドし直しが必要 | 内部テストなら数分。頻度が上がったら Capacitor の Live Updates か、教材だけ本番から取得する方式に |
| Apple 審査 4.2（薄い Web ラッパー） | 公開申請時のリスク | 専用キーボード・触覚・オフライン動作・スプラッシュで「アプリらしさ」を用意済み。申請時の説明文は §5 |
| 通知 | 方針で保留（DECISIONS_V4 §7） | 解禁するなら `@capacitor/push-notifications` か、まずローカル通知 |
| 課金 | やらない（禁止事項） | ストア公開時も無料。将来は Stripe（Web）か StoreKit を別途判断 |

## 4. 専用キーボードの仕様（docs/KEYBOARD.md の実装）

- 配列: QWERTY 3段＋最下段に ⌫。最下段の下に Enter（答え表示／次へ／判定）。英文を丸ごと打つカードだけ「空白」キーが出る
- 日本語で答えるカード（場面カード・義務教育）は A〜Z では打てないので、OS キーボードに戻る
- 表示中は `#input` に `inputmode="none"` を付けて OS キーボードを抑止。入力欄のフォーカスは維持
- 綴り入力では受理済みの文字は消せない（1ミス＝不正解の方針のまま）。⌫ は英文カードでだけ効く
- 触覚: Capacitor の Haptics（アプリ）／`navigator.vibrate`（Web）
- 設定: プロフィール → 画面キーボード（自動／常にオン／オフ）。`spelldash_osk`
- 未実装（構想に残す）: 次に打つキーを薄く光らせる補助モード

## 5. ストア申請時のメモ（v2 用の下書き）

- カテゴリ: 教育。年齢: 4+。価格: 無料、アプリ内課金なし
- 説明文の骨子: 「思い出して打つから、英単語が残る。日本語を見て英単語をタイピングする学習アプリ。専用キーボードで日本語切替なし、オフラインでも学習できる。中学英語のやり直しから英検・TOEIC・仕事の専門用語まで104パック。登録不要。」
- 審査メモ（Review Notes）: 「本アプリはオフラインで全機能が動作し、専用のソフトウェアキーボード、触覚フィードバック、端末内の学習記録と間隔反復を実装しています。Web 版と同じ教材を同梱しています。」
- プライバシー: `privacy.html` の内容を App Privacy に転記（学習データは端末内、ログイン時のみメール／Google の識別子）

## 6. こちら側の次の作業（創業者が実機で触ってから）

- 実機での手触り: キーの高さ・間隔、Enter の位置、打鍵音との同期
- iOS の Safe Area とキーボード表示中のスクロール位置
- Universal Links（メールリンクをアプリで開く）と Sign in with Apple
- ユニット制覇の演出（道の続き）

## 7. Universal Links / App Links の準備（v2、Team ID が分かってから有効化）

- `/.well-known/apple-app-site-association` と `/.well-known/assetlinks.json` を置いてある（vercel.json で `Content-Type: application/json` を付与）。
- iOS: `TEAMID` を Apple Developer の Team ID（例 `AB12CD34EF`）に置き換える。Xcode の Signing & Capabilities で **Associated Domains** を追加し `applinks:www.spelldash.net` と `webcredentials:www.spelldash.net` を入れる。
- Android: `REPLACE_WITH_RELEASE_KEY_SHA256` をリリース署名鍵の SHA-256（`keytool -list -v -keystore <release.keystore>`）に置き換え、`android/app/src/main/AndroidManifest.xml` の MainActivity に `autoVerify` 付きの intent-filter（scheme https、host www.spelldash.net）を追加する。
- アプリ側の受け口（`@capacitor/app` の `appUrlOpen` でパスを開く）は v2 で実装する。これが入ると、メールのログインリンクがアプリで開き、Web と同じ `?add=<pack>` の紹介リンクもアプリに入る。
