// 未来の道筋（仕事・3 年の分かれ道）を読み込む前の確認。dialogs.ts から移した（中身・見え方は同じ。見直し gaps-7）。
// 読み込む前の確認の枠（件数・追加か置き換えか）は、インポート・やりたいことリストと同じ dialogs.ts の openImportPreview

import type { AppContext } from "../app/context";
import { buildPageFuture, pageFutureIsQuarterly } from "../app/pageFuture";
import { FUTURE_MIN_ZOOM, nearFutureRoot } from "../demo/futureSwap";
import { openImportPreview } from "./dialogs";
import { h } from "./dom";
import { openModal } from "./overlays";

/** 確かめの画面を開いている間は、もう 1 枚開かない */
let futureOpen = false;

/** 未来の道筋（仕事・3 年の分かれ道）を読み込む前の確認。組み立てに失敗したら、そう伝えて閉じる */
export function openFutureDialog(app: AppContext): void {
  if (futureOpen) return;
  futureOpen = true;
  void buildPageFuture().then(
    (built) => {
      futureOpen = false;
      showFutureDialog(app, built);
    },
    () => {
      futureOpen = false;
      failed();
    },
  );
}

/** 組み立てられなかった */
function failed(): void {
  const m = openModal({ title: "読み込めませんでした", width: 460, icon: "alert" });
  m.body.append(h("p", { class: "modal-text" }, "未来の道筋を組み立てられませんでした。ページを開き直してから、もう一度試してください。"));
  m.footer.append(h("button", { class: "btn btn-primary", type: "button", onClick: () => m.close() }, "閉じる"));
}

/** 読み込む前の確認を出す */
function showFutureDialog(app: AppContext, built: Awaited<ReturnType<typeof buildPageFuture>>): void {
  if (futureOpen) return;
  const { pv, stats } = built;
  const quarterly = pageFutureIsQuarterly();
  const lead = h(
    "div",
    { class: "wish-lead" },
    h("p", { class: "modal-text" }, "SpellDash・FC マーケティング・独立の 3 つの仕事で、今日から 3 年先までの選択肢と、その手で 3 年の稼ぎがどれだけ変わるかを計算した地図です。", h("b", null, `判断 ${stats.decisions.toLocaleString("ja-JP")} か所・選択肢 ${stats.options.toLocaleString("ja-JP")}`), "から、", h("b", null, `${stats.ends.toLocaleString("ja-JP")} の 3 年後`), "に分かれます。"),
    h(
      "ul",
      { class: "wish-howto" },
      h("li", null, h("b", null, "今日"), quarterly ? "の 10 の手から始まり、3 か月ごとに選び直します（2029 年 11 月まで 12 回）。どの道も 3 年後の行き先まで書いてあります。" : "の 10 の手から始まり、3 か月後・1 年後にまた選び直します。どの道も 3 年後の行き先まで書いてあります。"),
      h("li", null, h("b", null, "選択肢のカード"), "の色付きの数は、その手で 3 年の稼ぎが「今のまま」よりどれだけ変わるか（青 = 増える・赤 = 減る）。"),
      h("li", null, h("b", null, "結果"), "には見込み % と判断の線（測れる条件）が付いています。% を直すと、すぐに計算し直します。"),
      h("li", null, h("b", null, "右の概要"), "に「今決めること」の順位と 3 年後の分布が出ます。年収を入れると本業の数が合います。"),
    ),
  );
  futureOpen = true;
  openImportPreview(app, pv, {
    onClose: () => (futureOpen = false),
    title: "未来の道筋を読み込む",
    subtitle: `今日から 3 年後まで、${stats.ends.toLocaleString("ja-JP")} の行き先に分かれる道`,
    icon: "split",
    lead,
    stats: [
      ["判断", stats.decisions],
      ["選択肢", stats.options],
      ["分かれ道", stats.forks],
      ["3 年後の行き先", stats.ends],
    ],
    mode: "merge",
    mergeDesc: "今のデータはそのまま。未来の道筋を右側に足します。SpellDash事業など同じ名前のプロジェクトとシナリオはまとめます。",
    replaceDesc: "今のデータを未来の道筋だけに入れ替えます。直前の状態は安全用バックアップに残り、「元に戻す」でも戻せます。",
    label: { merge: "未来の道筋を追加", replace: "未来の道筋に入れ替え" },
    selectAdded: false,
    after: {
      replaceDone: "未来の道筋に入れ替えました。右の概要に今決めることと 3 年後の分布が出ます",
      mergeDone: "未来の道筋: ",
      // 全体は横に長すぎて読めないので、今日から数歩先までに寄る（カードの文字が読める大きさで始める。狭い画面では今日から）
      fitTo: (doc, added) => nearFutureRoot(doc, added),
      fitMinZoom: FUTURE_MIN_ZOOM,
    },
  });
}
