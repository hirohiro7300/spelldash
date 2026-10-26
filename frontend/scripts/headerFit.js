// ヘッダーの 1 行が今の字で入るかを測り、入らなければ「収まらないときの形」（css/brand.css の data-fit）にする（PR #170 のレビュー 5）。
// 幅の帯ごとの詰め方（brand.css の 720／449／359px の節）は Web フォントの寸法で決めてあるので、フォントが読めない・代わりの字が広い・
// 端末の文字の拡大（Android の文字の大きさ。アプリの WebView も同じ掛け算）では足りないことがある。ここでは字の寸法によらず、測った結果で形を選ぶ。
// 部品が重ならないことそのものは CSS の構造（印・連続日数・ログインは縮めない・ナビは残りの幅だけ・はみ出しは切る）が守る。
// ここは、リンクの字を「…」で省略する前に、細い形で字を全部見せるため。
//
// 形（data-fit に並べる畳むもの。css/brand.css）: name = 名前を隠す → num = 連続日数は数字だけ・ナビを詰める → battle = 「バトル」のタブを畳む
// → streak = 連続日数も畳む。軽い順に足していく（400px 未満・359px 以下の形と同じ順: 先に連続日数を短く、次にバトルのタブ）。
// 測り方: data-fit-measure（リンクを縮めない）を付けて形を順に当て、見えるリンクの右端がナビの内側（padding の内）に入る最初の形を選ぶ
// （どれも入らなければいちばん畳んだ形。その上で入らない分はリンクの字が「…」になる）。同じ処理の中で付け外しするので、途中の形は描かれない。
// 測り直す時: ナビとリンクの箱の大きさが変わったとき（画面の幅・連続日数やログインの出し入れ・字の拡大）と、Web フォントが届いたとき
// （リンクが縮んでいると、字が広くなっても箱の大きさは変わらない）。

const STEPS = ["", "name", "name num", "name num battle", "name num battle streak"];
let watching = false;

// ナビの中身（縮めていないリンク）がナビの内側に入るか
function navFits(nav) {
  const links = [...nav.querySelectorAll(".site-nav__link")].filter((a) => a.getClientRects().length > 0);
  if (links.length === 0) return true;
  const box = nav.getBoundingClientRect();
  const inside = box.right - (parseFloat(getComputedStyle(nav).paddingRight) || 0);
  return links.every((a) => a.getBoundingClientRect().right <= inside + 0.01);
}

export function fitHeader(inner = document.querySelector(".site-header__inner")) {
  const nav = inner?.querySelector(".site-nav");
  if (!nav) return;
  inner.setAttribute("data-fit-measure", "");
  let pick = STEPS[STEPS.length - 1];
  for (const step of STEPS) {
    if (step) inner.dataset.fit = step;
    else delete inner.dataset.fit;
    if (navFits(nav)) {
      pick = step;
      break;
    }
  }
  if (pick) inner.dataset.fit = pick;
  else delete inner.dataset.fit;
  inner.removeAttribute("data-fit-measure");
}

// 1 ページに 1 回（何度呼んでもよい）。js/headerStreak.js（アプリの頁）と js/staticHeader.js（静的な頁）が連続日数を描いた後に呼ぶ
export function watchHeaderFit() {
  if (watching) return;
  const inner = document.querySelector(".site-header__inner");
  const nav = inner?.querySelector(".site-nav");
  if (!nav) return;
  watching = true;
  const run = () => fitHeader(inner);
  run();
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(run);
    observer.observe(nav);
    for (const link of nav.querySelectorAll(".site-nav__link")) observer.observe(link);
  }
  document.fonts?.addEventListener?.("loadingdone", run);
}
