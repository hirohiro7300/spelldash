// ===== お知らせデータ＋描画 =====
//
// 新しいお知らせは配列の【先頭】に追加する。
// 書き方はユーザー向け（App Storeのリリースノート調）:
// 開発者向けの内部用語（PR/コミット/リファクタ等）は使わない。
//
// 将来拡張の予約フィールド（今は未使用・実装しない）:
//   tag: "feature" | "fix" | "event" / pinned: true / hasumiComment: "..."

const NEWS = [
  {
    date: "2026.09.05",
    title: "「覚えた単語」が見えるようになりました",
    body: "ホームに覚えた単語数を常設し、学習データにカテゴリ別の進捗一覧（習得・覚えかけ・苦手・未着手）を追加しました。Studyでは「3日ぶりの復習」「新しい単語」など各単語の状態と、正解後に「習得まであと何回か」が表示されます。"
  },
  {
    date: "2026.09.05",
    title: "新カテゴリ「広告・マーケ」追加",
    body: "CPC・CVR・ROASなどWeb広告やマーケティングの現場で毎日使う用語101語（CPM・CPL・LTV・CACなどの略語40語を含む）を、英語として体に入れられるカテゴリを追加しました。仕事で横文字に追いつきたい社会人の学び直しにどうぞ。"
  },
  {
    date: "2026.07.28",
    title: "ライトテーマ登場＋ChallengeにBGM",
    body: "白ベースの新デザインが標準になりました。従来の黒ベースもプロフィールの「見た目の設定」からいつでも選べます。あわせてChallenge/Daily中に控えめなBGMが流れるようになりました（設定でOFFにできます）。"
  },
  {
    date: "2026.07.17",
    title: "マスコット「はちゃん」登場",
    body: "SpellDashの学習パートナー「はすみ（はちゃん）」が仲間入りしました。ホームでのあいさつや、プレイ後のひとことで、あなたの学習を隣で応援します。"
  },
  {
    date: "2026.07.16",
    title: "スマホでの遊びやすさを大幅改善",
    body: "プレイ中は画面が単語と入力欄だけに集中するようになりました。ヘッダーもコンパクトになり、片手でもさらに快適に遊べます。"
  },
  {
    date: "2026.07.15",
    title: "Daily Dash追加",
    body: "毎日1回だけ挑戦できるDaily Dashを追加しました。問題は全員共通・日替わりです。結果は絵文字グリッドでシェアできます。"
  },
  {
    date: "2026.07.15",
    title: "SpellDash β公開",
    body: "世界一継続される英単語サービスを目指して、SpellDashのβ版を公開しました。1日60秒から、少しずつ英語を続けられるサービスを目指します。じっくり覚えるStudy、60秒のChallenge、CPUと対戦するBattle（β）で遊べます。"
  }
];

export function renderNews() {
  const container = document.getElementById("newsList");
  if (!container) return;

  container.innerHTML = NEWS.map(
    (item) => `
    <article class="news-item">
      <time class="news-item__date" datetime="${item.date.replaceAll(".", "-")}">${item.date}</time>
      <h2 class="news-item__title">${item.title}</h2>
      <p class="news-item__body">${item.body}</p>
    </article>
  `
  ).join("");
}
