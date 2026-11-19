// このページより新しい版で保存されたデータに出会ったときの画面。設計: docs/DESIGN.md §5
// 読まずに止めたこと（新しい版のデータには触れていない）・開き直すと新しい版で開くことを伝え、開き直すボタンだけを置く。
// 編集の画面は組み立てない（組み立てた後に気づいたときは、画面ごと差し替える）

import type { KeptAside } from "../persist/persistence";
import { h } from "./dom";
import { icon } from "./icons";
import { haltOverlays } from "./overlays";

/** 止めた画面の見出し（E2E でも確かめる） */
export const NEWER_TITLE = "新しい版のページで保存されたデータです";

/** 開いている間に気づいて止めたとき、このタブのまだどこにも無い変更を残した所（消えたと思わないように伝える） */
const KEPT_TEXT: Record<Exclude<KeptAside, null>, string> = {
  backup: "このタブでまだ保存されていなかった変更は、「退避」のバックアップに残しました（新しい版のページのメニュー →「バックアップと復元」から戻せます）。",
  copy: "このタブでまだ保存されていなかった変更は、このブラウザの緊急コピーに残しました（新しい版のページを開いたときに、そのページが戻すか「退避」のバックアップに残します）。",
};

/**
 * 画面を差し替えて、開き直すよう伝える。開き直しても同じ画面になる（古い版のページを開いている）ときのことも書く。
 * kept: 開いている間に気づいたとき、このタブの変更を残した所（起動で止めたときは無し）。
 * 以後はお知らせ・ダイアログ・メニューを出さない（この画面の下に見えない物を作らず、フォーカスも取らせない）
 */
export function showNewerScreen(mount: HTMLElement, opts: { kept?: KeptAside } = {}): void {
  haltOverlays();
  const reload = h("button", { class: "btn btn-primary newer-reload", type: "button", onClick: () => location.reload() }, icon("reset", 16), "ページを開き直す");
  const screen = h(
    "main",
    { class: "newer-screen", attrs: { "aria-labelledby": "newer-title" } },
    h(
      "section",
      { class: "newer-card" },
      h("span", { class: "newer-icon", attrs: { "aria-hidden": "true" } }, icon("lock", 22, 1.7)),
      h("h1", { class: "newer-title", attrs: { id: "newer-title" } }, NEWER_TITLE),
      h(
        "p",
        { class: "newer-text" },
        "このブラウザの 4D Branch のデータは、このページより新しい版で保存されています。この版では読めないため、編集の画面は開かずに止めています。新しい版のデータには触れていません（上書きも削除もしていません）。",
      ),
      opts.kept ? h("p", { class: "newer-text newer-kept" }, KEPT_TEXT[opts.kept]) : null,
      h("p", { class: "newer-text newer-lead" }, "ページを開き直すと、新しい版で開きます。"),
      h("div", { class: "newer-actions" }, reload),
      h("p", { class: "newer-note" }, "開き直してもこの画面になるときは、古い版のページを開いています。最新の版のページを開いてください。データはこのブラウザにそのまま残っています。"),
    ),
  );
  mount.replaceChildren(screen);
  requestAnimationFrame(() => reload.focus());
}
