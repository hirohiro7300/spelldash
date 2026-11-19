// このページより新しい版で保存されたデータに出会ったときの画面と、アカウントの写しが新しい版のときの帯。設計: docs/DESIGN.md §5
// 画面: 読まずに止めたこと（新しい版のデータには触れていない）・開き直すと新しい版で開くことを伝え、開き直すボタンだけを置く。
// 編集の画面は組み立てない（組み立てた後に気づいたときは、画面ごと差し替える）。
// 帯: アカウントの写しだけが新しい版なら、編集の画面の上に出したまま、新しい編集を止めたことと開き直すことを伝える

import { errorCode, inArtifactHost, useCapability, type DownloadsApi } from "../host/claude";
import { downloadText, exportFileName } from "../persist/io";
import type { BlockInfo, KeptAside, RawRecord } from "../persist/persistence";
import { h } from "./dom";
import { icon } from "./icons";
import { haltOverlays } from "./overlays";

/** 止めた画面の見出し（E2E でも確かめる） */
export const NEWER_TITLE = "新しい版のページで保存されたデータです";
/** 保存してあるデータをこのページでは開けない（地図が合わない など）ときの見出し */
export const STORED_BLOCKED_TITLE = "保存されているデータを、このページでは開けません";
/** そのまま書き出すボタンの名前（safety-3） */
export const RAW_EXPORT_LABEL = "保存されているデータをそのまま書き出す";
/** この版で開き直すボタンの名前（safety-5） */
export const REOPEN_LABEL = "この版で開き直す";

/** 止めた画面に足す物（薄い形を読み書きするページだけが渡す。渡さなければ今までどおり「ページを開き直す」だけ） */
export interface BlockedScreenOpts {
  kept?: KeptAside;
  /** 止めた訳（無ければ新しい版のデータ） */
  why?: BlockInfo;
  /** 「保存されているデータをそのまま書き出す」の中身を読む（止めていても読める。無ければ null） */
  rawExport?: () => Promise<RawRecord | null>;
  /** 「この版で開き直す」（同じ版で地図が合わない・前の版の地図のときだけ。安全用バックアップに残してから、この版の地図に合わせて開く） */
  reopen?: () => void;
}

/**
 * 文字をファイルとして保存してもらう（Artifact の中は downloads 機能、使えなければ止めた画面の中にコピーできる欄を出す。外ではダウンロード）。
 * 止めた画面ではダイアログ・お知らせを出さないので、結果は画面の中の文で伝える
 */
async function saveRaw(text: string, filename: string, status: HTMLElement, copyBox: HTMLElement): Promise<void> {
  const say = (t: string): void => {
    status.textContent = t;
  };
  if (inArtifactHost()) {
    const dl = await useCapability<DownloadsApi>("downloads", 5000);
    if (dl) {
      try {
        await dl.save({ filename, data: text });
        say(`書き出しました: ${filename}`);
        return;
      } catch (e) {
        if (errorCode(e) === "declined") {
          say("書き出しをやめました。");
          return;
        }
      }
    }
    // 保存を頼めない画面: 内容をコピーしてもらう（この画面の中に出す）
    const ta = h("textarea", { class: "input copy-area newer-copy", attrs: { readonly: "", rows: "8", "aria-label": "書き出す内容", spellcheck: "false" } });
    ta.value = text;
    const copy = h("button", { class: "btn", type: "button" }, icon("copy", 14), "コピー");
    copy.addEventListener("click", () => {
      const fallback = (): void => {
        ta.focus();
        ta.select();
        say("選択しました。⌘C（Ctrl+C）でコピーしてください。");
      };
      try {
        navigator.clipboard.writeText(text).then(() => say("コピーしました。テキストエディタなどで .json のファイルとして保存してください。"), fallback);
      } catch {
        fallback();
      }
    });
    copyBox.replaceChildren(h("p", { class: "newer-text" }, "この画面からはファイルを直接保存できません。下の内容をコピーして、「", h("b", null, filename), "」として保存してください。"), ta, h("div", { class: "newer-actions" }, copy));
    say("");
    return;
  }
  downloadText(filename, text);
  say(`書き出しました: ${filename}`);
}

/** アカウントの写しがこのページより新しい版のときの帯の文（開き直すまで出したまま。E2E でも確かめる） */
export const ACCOUNT_NEWER_BANNER = "アカウントに新しい版の内容があります。このページは古い版なので、編集を止めました。ページを開き直してください";
/** そのときに編集しようとした・未来の道筋を開こうとしたときのお知らせ（「このタブで編集する」では戻らない） */
export const ACCOUNT_NEWER_BLOCKED = "アカウントに新しい版の内容があるため、このページでは編集を止めています。上の「ページを開き直す」で開き直してください。";

/** 開いている間に気づいて止めたとき、このタブのまだどこにも無い変更を残した所（消えたと思わないように伝える） */
const KEPT_TEXT: Record<Exclude<KeptAside, null>, string> = {
  backup: "このタブでまだ保存されていなかった変更は、「退避」のバックアップに残しました（新しい版のページのメニュー →「バックアップと復元」から戻せます）。",
  copy: "このタブでまだ保存されていなかった変更は、このブラウザの緊急コピーに残しました（新しい版のページを開いたときに、そのページが戻すか「退避」のバックアップに残します）。",
};

/** このページでは開けないデータで止めたときの、残した所（新しい版のページとは限らない） */
const KEPT_TEXT_STORED: Record<Exclude<KeptAside, null>, string> = {
  backup: "このタブでまだ保存されていなかった変更は、「退避」のバックアップに残しました（データを開けるページのメニュー →「バックアップと復元」から戻せます）。",
  copy: "このタブでまだ保存されていなかった変更は、このブラウザの緊急コピーに残しました（データを開けるページを開いたときに、そのページが戻すか「退避」のバックアップに残します）。",
};

/**
 * 画面を差し替えて、開き直すよう伝える。開き直しても同じ画面になる（古い版のページを開いている）ときのことも書く。
 * kept: 開いている間に気づいたとき、このタブの変更を残した所（起動で止めたときは無し）。
 * 以後はお知らせ・ダイアログ・メニューを出さない（この画面の下に見えない物を作らず、フォーカスも取らせない）
 */
export function showNewerScreen(mount: HTMLElement, opts: BlockedScreenOpts = {}): void {
  haltOverlays();
  const reload = h("button", { class: "btn btn-primary newer-reload", type: "button", onClick: () => location.reload() }, icon("reset", 16), "ページを開き直す");
  const stored = opts.why?.kind === "stored";
  // そのまま書き出す・この版で開き直す（渡されたときだけ。既定のビルドの画面は今までどおり）
  const extra: HTMLElement[] = [];
  const status = h("p", { class: "newer-text newer-status", attrs: { role: "status", "aria-live": "polite" } });
  const copyBox = h("div", { class: "newer-copybox" });
  if (opts.rawExport) {
    const raw = opts.rawExport;
    const btn = h("button", { class: "btn newer-raw", type: "button" }, icon("download", 15), RAW_EXPORT_LABEL);
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const rec = await raw();
        if (!rec) status.textContent = "書き出せる保存されたデータが見つかりませんでした。";
        else await saveRaw(rec.text, exportFileName(new Date(), rec.source === "emergency" ? "4d-branch_raw_emergency" : "4d-branch_raw"), status, copyBox);
      } catch (e) {
        status.textContent = `書き出せませんでした（${e instanceof Error ? e.message : String(e)}）。`;
      } finally {
        btn.disabled = false;
      }
    });
    extra.push(btn);
  }
  if (opts.reopen && stored && opts.why?.reopen) {
    const go = opts.reopen;
    const btn = h("button", { class: "btn newer-reopen", type: "button" }, icon("split", 15), REOPEN_LABEL);
    btn.addEventListener("click", () => {
      btn.disabled = true;
      go();
    });
    extra.push(btn);
  }
  const screen = h(
    "main",
    { class: "newer-screen", attrs: { "aria-labelledby": "newer-title" } },
    h(
      "section",
      { class: "newer-card" },
      h("span", { class: "newer-icon", attrs: { "aria-hidden": "true" } }, icon("lock", 22, 1.7)),
      h("h1", { class: "newer-title", attrs: { id: "newer-title" } }, stored ? STORED_BLOCKED_TITLE : NEWER_TITLE),
      stored
        ? h(
            "p",
            { class: "newer-text" },
            "このブラウザの 4D Branch のデータは、このページの地図と合わないため、編集の画面は開かずに止めています。データには触れていません（上書きも削除もしていません）。",
          )
        : h(
            "p",
            { class: "newer-text" },
            "このブラウザの 4D Branch のデータは、このページより新しい版で保存されています。この版では読めないため、編集の画面は開かずに止めています。新しい版のデータには触れていません（上書きも削除もしていません）。",
          ),
      stored && opts.why?.message ? h("p", { class: "newer-text newer-why" }, opts.why.message) : null,
      opts.kept ? h("p", { class: "newer-text newer-kept" }, (stored ? KEPT_TEXT_STORED : KEPT_TEXT)[opts.kept]) : null,
      h("p", { class: "newer-text newer-lead" }, stored ? "ページを開き直すと、もう一度読みます。" : "ページを開き直すと、新しい版で開きます。"),
      h("div", { class: "newer-actions" }, reload),
      extra.length ? h("div", { class: "newer-actions newer-more" }, ...extra) : null,
      extra.length ? status : null,
      extra.length ? copyBox : null,
      stored && opts.reopen && opts.why?.reopen
        ? h(
            "p",
            { class: "newer-note" },
            "「この版で開き直す」は、保存されているデータをそのまま安全用バックアップに残してから、このページの地図に合わせて開きます（地図から無くなったカードで選んだ・書き換えた物は「前の版で決めたこと」に残ります）。",
          )
        : null,
      h(
        "p",
        { class: "newer-note" },
        stored
          ? "開き直してもこの画面になるときは、データを保存したときと違う版のページを開いています。保存したときの版のページで開くか、そのまま書き出して残してください。データはこのブラウザにそのまま残っています。"
          : "開き直してもこの画面になるときは、古い版のページを開いています。最新の版のページを開いてください。データはこのブラウザにそのまま残っています。",
      ),
    ),
  );
  mount.replaceChildren(screen);
  requestAnimationFrame(() => reload.focus());
}

/**
 * アカウントの写しがこのページより新しい版と分かったときの帯（編集の画面の上に、開き直すまで出したまま）。画面ごとは止めず、
 * 新しい編集だけを止めている（見る・書き出すはできる）。「ページを開き直す」はこの状態のただ 1 つの出口なので、スマホの幅でも押しやすい 44px
 */
export function accountNewerBanner(): HTMLElement {
  return h(
    "div",
    { class: "banner tone-warn banner-newer" },
    icon("lock", 15),
    h("span", { class: "banner-text" }, ACCOUNT_NEWER_BANNER),
    h("button", { class: "btn btn-primary banner-reload", type: "button", onClick: () => location.reload() }, icon("reset", 15), "ページを開き直す"),
  );
}
