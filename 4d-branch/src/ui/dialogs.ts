// ダイアログ: バックアップと復元・インポート・ヘルプ・ようこそ・文章の編集

import type { AppContext } from "../app/context";
import { NODE_TYPES, NODE_TYPE_ORDER, RELATIONS, RELATION_ORDER } from "../model/constants";
import { DocFormatError } from "../model/schema";
import type { DocData } from "../model/types";
import { previewImport, type ImportPreview } from "../persist/io";
import { inArtifactHost } from "../host/claude";
import { BACKUP_LABELS, type BackupMeta } from "../persist/persistence";
import { MOD, clear, h } from "./dom";
import { icon } from "./icons";
import { confirmDialog, openModal, toast } from "./overlays";

function fmtBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// ------------------------------------------------------------ バックアップと復元

export function openBackupDialog(app: AppContext): void {
  const m = openModal({ title: "バックアップと復元", subtitle: "このブラウザの中に自動で残しています。ほかの場所にも残すには JSON で書き出してください。", width: 680, icon: "archive", className: "backup-modal" });
  const info = h("div", { class: "storage-card" });
  const list = h("div", { class: "backup-list" });
  const per = app.persistence;
  const ro = app.store.readOnly;

  const backupBtn = h("button", { class: "btn btn-primary", type: "button", disabled: !per.canBackup }, icon("shield", 15), "今すぐバックアップ");
  backupBtn.addEventListener("click", async () => {
    await app.backupNow();
    await renderList();
  });
  const exportBtn = h("button", { class: "btn", type: "button", onClick: () => app.exportJson() }, icon("download", 15), "JSON で書き出す");
  const importBtn = h("button", { class: "btn", type: "button", disabled: ro, onClick: () => (m.close(), app.pickImport()) }, icon("upload", 15), "JSON を読み込む");
  m.body.append(info, h("div", { class: "btn-row" }, backupBtn, exportBtn, importBtn), h("h3", { class: "insp-label" }, "バックアップの一覧"), list);
  m.footer.append(h("span", { class: "muted small grow" }, "自動: 変更がある間 10 分ごと（最新 24 件）・日次: その日の最初の起動時（30 日分）・安全用: 取り込み・復元の直前・退避: 保存が重なったときの内容"), h("button", { class: "btn", type: "button", onClick: () => m.close() }, "閉じる"));

  const renderInfo = async () => {
    const s = await per.storageInfo();
    clear(info);
    const where = per.mode === "idb" ? "このブラウザ（IndexedDB）" : per.mode === "local" ? "このブラウザ（localStorage・容量小）" : "保存しない一時表示";
    const protect =
      s.persisted === true
        ? h("span", { class: "ok-text" }, icon("check", 13, 2.2), "有効（ブラウザが勝手に消さない）")
        : h(
            "span",
            null,
            h("span", { class: "warn-text" }, "未設定"),
            h(
              "button",
              {
                class: "btn btn-sm",
                type: "button",
                onClick: async () => {
                  const ok = await per.requestPersist();
                  toast(ok ? "ブラウザに保護を頼みました（自動削除されにくくなります）" : "ブラウザが保護を認めませんでした。こまめに書き出してください", { tone: ok ? "ok" : "warn" });
                  void renderInfo();
                },
              },
              "保護を頼む",
            ),
          );
    info.append(
      h("div", { class: "storage-row" }, h("span", { class: "storage-k" }, "保存先"), h("span", null, where)),
      h("div", { class: "storage-row" }, h("span", { class: "storage-k" }, "最後の保存"), h("span", null, per.savedAt ? fmtWhen(per.savedAt) : "—"), h("span", { class: "muted" }, `（版 ${per.rev}）`)),
      h("div", { class: "storage-row" }, h("span", { class: "storage-k" }, "使用量"), h("span", null, `${fmtBytes(s.usage)} / ${fmtBytes(s.quota)}`)),
      h("div", { class: "storage-row" }, h("span", { class: "storage-k" }, "自動削除からの保護"), protect),
    );
    if (app.cloudInfo) info.append(h("div", { class: "storage-row" }, h("span", { class: "storage-k" }, "アカウント（claude.ai）"), h("span", null, cloudText(app.cloudInfo))));
  };

  const renderList = async () => {
    const items = await per.listBackups();
    clear(list);
    if (!per.canBackup) {
      list.append(h("div", { class: "muted" }, "このブラウザではバックアップを保存できません。JSON で書き出してください。"));
      return;
    }
    if (!items.length) {
      list.append(h("div", { class: "muted" }, "まだバックアップはありません。"));
      return;
    }
    for (const b of items) list.append(backupRow(app, b, m.close, renderList));
  };
  void renderInfo();
  void renderList();
}

function backupRow(app: AppContext, b: BackupMeta, closeDialog: () => void, refresh: () => Promise<void>): HTMLElement {
  const per = app.persistence;
  const restore = h("button", { class: "btn btn-sm", type: "button", disabled: app.store.readOnly, title: "この時点の内容に戻す（今の内容は安全用バックアップに残ります）" }, icon("reset", 13), "復元");
  restore.addEventListener("click", async () => {
    const doc = await per.readBackup(b.id);
    if (!doc) return toast("このバックアップを読めませんでした", { tone: "error" });
    const ok = await confirmDialog({
      title: "このバックアップに戻しますか？",
      body: `${fmtWhen(b.createdAt)} の内容（ノード ${b.counts.nodes} 件・接続 ${b.counts.edges} 本）に入れ替えます。今の内容は「安全用」バックアップに残り、「元に戻す」でも戻せます。`,
      ok: "復元する",
    });
    if (!ok) return;
    await app.replaceDocSafely(doc, "バックアップから復元");
    closeDialog();
  });
  const dl = h("button", { class: "icon-btn icon-btn-sm", type: "button", title: "JSON でダウンロード", ariaLabel: "ダウンロード" }, icon("download", 15));
  dl.addEventListener("click", async () => {
    const doc = await per.readBackup(b.id);
    if (doc) app.exportJson(doc, `4d-branch_backup_${b.createdAt.slice(0, 16).replace(/[:T]/g, "-")}.json`);
  });
  const del = h("button", { class: "icon-btn icon-btn-sm", type: "button", title: "このバックアップを削除", ariaLabel: "削除" }, icon("trash", 15));
  del.addEventListener("click", async () => {
    const ok = await confirmDialog({ title: "バックアップを削除", body: `${fmtWhen(b.createdAt)} のバックアップを削除します。この操作は元に戻せません。`, ok: "削除する", danger: true });
    if (!ok) return;
    await per.deleteBackup(b.id);
    await refresh();
  });
  return h(
    "div",
    { class: "backup-row" },
    h("span", { class: `backup-kind kind-${b.kind}` }, BACKUP_LABELS[b.kind]),
    h("div", { class: "backup-main" }, h("div", { class: "backup-when" }, fmtWhen(b.createdAt)), h("div", { class: "backup-sub" }, [b.label, b.docTitle].filter(Boolean).join(" · "))),
    h("span", { class: "backup-counts" }, `ノード ${b.counts.nodes} · 接続 ${b.counts.edges}`),
    h("div", { class: "backup-actions" }, restore, dl, del),
  );
}

// ------------------------------------------------------------ インポート

export async function openImportDialog(app: AppContext, file: File): Promise<void> {
  let pv: ImportPreview;
  try {
    pv = previewImport(await file.text());
  } catch (e) {
    const msg = e instanceof DocFormatError ? e.message : "ファイルを読めませんでした。";
    const m = openModal({ title: "読み込めませんでした", width: 460, icon: "alert" });
    m.body.append(h("p", { class: "modal-text" }, msg), h("p", { class: "muted small" }, file.name));
    m.footer.append(h("button", { class: "btn btn-primary", type: "button", onClick: () => m.close() }, "閉じる"));
    return;
  }
  const m = openModal({ title: "JSON を読み込む", subtitle: file.name, width: 560, icon: "upload" });
  const c = pv.counts;
  m.body.append(
    h(
      "div",
      { class: "import-counts" },
      ...[
        ["ノード", c.nodes],
        ["接続", c.edges],
        ["プロジェクト", c.projects],
        ["シナリオ", c.scenarios],
      ].map(([k, v]) => h("div", { class: "stat" }, h("span", { class: "stat-value" }, String(v)), h("span", { class: "stat-label" }, String(k)))),
    ),
  );
  if (pv.report.warnings.length) {
    const det = h("details", { class: "import-warn" }, h("summary", null, icon("alert", 14), `直したところ ${pv.report.warnings.length} 件（読み込みはできます）`), h("ul", null, ...pv.report.warnings.slice(0, 30).map((w) => h("li", null, w))));
    m.body.append(det);
  }
  const mode = { v: "merge" as "merge" | "replace" };
  const opt = (v: "merge" | "replace", title: string, desc: string) => {
    const input = h("input", { type: "radio", attrs: { name: "import-mode", value: v }, checked: mode.v === v });
    input.addEventListener("change", () => (mode.v = v));
    return h("label", { class: "radio-card" }, input, h("div", null, h("div", { class: "radio-title" }, title), h("div", { class: "radio-desc" }, desc)));
  };
  m.body.append(
    h(
      "div",
      { class: "radio-cards" },
      opt("merge", "追加する", "今のデータはそのまま。取り込んだ分を右側に足します（ID は振り直し、同じ名前のプロジェクト・シナリオはまとめます）。外部の AI と作った案を足すときに。"),
      opt("replace", "置き換える", "今のデータを取り込んだ内容に入れ替えます。直前の状態は安全用バックアップに残り、「元に戻す」でも戻せます。"),
    ),
  );
  const go = h("button", { class: "btn btn-primary", type: "button" }, "読み込む");
  go.addEventListener("click", async () => {
    m.close();
    if (mode.v === "replace") await app.replaceDocSafely(pv.doc, "インポート（置き換え）");
    else app.mergeDoc(pv.doc);
  });
  m.footer.append(h("button", { class: "btn", type: "button", onClick: () => m.close() }, "キャンセル"), go);
}

// ------------------------------------------------------------ ヘルプ

const SHORTCUTS: Array<[string, string]> = [
  ["ノードを作る（前回の種類）", "N ／ 空き所をダブルクリック"],
  ["子ノード（分岐）を足す", "Tab"],
  ["タイトルを編集", "Enter ／ F2 ／ ダブルクリック"],
  ["種類を変える", "1 目標・2 行動・3 分岐・4 結果"],
  ["折りたたむ・展開する", "C"],
  ["削除", "Delete ／ Backspace"],
  ["複製", `${MOD}D`],
  ["すべて選択", `${MOD}A`],
  ["元に戻す／やり直す", `${MOD}Z ／ ${MOD}⇧Z`],
  ["検索", `${MOD}K ／ /`],
  ["全体を表示・選択に合わせる", "F"],
  ["拡大・縮小・100%", "+ ／ − ／ 0"],
  ["少し動かす", "矢印（⇧ で大きく）"],
  ["移動（パン）", "スペース＋ドラッグ／空き所をドラッグ"],
  ["範囲選択", "⇧＋ドラッグ"],
  ["すぐ保存", `${MOD}S`],
  ["JSON で書き出す", `${MOD}E`],
  ["選択を外す・閉じる", "Esc"],
];

export function openHelpDialog(app: AppContext): void {
  const m = openModal({ title: "ヘルプ", subtitle: "4D Branch — 未来の分岐を記録するメモ帳", width: 720, icon: "help" });
  const legend = h("div", { class: "legend-grid" });
  for (const t of NODE_TYPE_ORDER) legend.append(h("div", { class: `legend-item type-${t}` }, h("span", { class: `type-chip type-${t}` }, icon(t, 14)), h("div", null, h("b", null, NODE_TYPES[t].label), h("span", { class: "muted" }, NODE_TYPES[t].hint))));
  const rels = h("div", { class: "legend-grid rel" });
  for (const r of RELATION_ORDER) rels.append(h("div", { class: "legend-item" }, h("span", { class: `rel-line rel-${r}`, style: { "--rel": RELATIONS[r].color } }), h("div", null, h("b", null, RELATIONS[r].label), h("span", { class: "muted" }, RELATIONS[r].hint))));
  const keys = h("div", { class: "shortcut-grid" }, ...SHORTCUTS.map(([k, v]) => h("div", { class: "shortcut-row" }, h("span", null, k), h("kbd", null, v))));
  m.body.append(
    h("p", { class: "modal-text" }, "目標・行動・分岐・結果をノードとしてつなぎ、未来の分岐を見える化します。プロジェクトはノードを入れる箱ではなく「所属」なので、1 つの行動を複数のプロジェクトの目標につなげられます。"),
    h("div", { class: "btn-row" }, h("button", { class: "btn btn-primary", type: "button", onClick: () => (m.close(), app.startTour()) }, icon("play", 14), "操作ガイドを始める")),
    h("h3", { class: "insp-label" }, "ノードの種類"),
    legend,
    h("h3", { class: "insp-label" }, "接続の関係（矢印の向き = 影響の向き）"),
    rels,
    h("h3", { class: "insp-label" }, "ショートカット"),
    keys,
    h("h3", { class: "insp-label" }, "データの守り方"),
    h(
      "ul",
      { class: "hint-list" },
      h("li", null, "変更はすぐこのブラウザ（IndexedDB）に保存されます。閉じる瞬間の変更も緊急コピーで守ります。"),
      h("li", null, "バックアップ: 10 分ごと・毎日・取り込みや復元の直前に自動で残ります（メニュー →「バックアップと復元」）。"),
      h("li", null, "同じブラウザで 2 つ以上のタブを開くと、編集できるのは 1 つだけです（ほかは閲覧のみ）。"),
      inArtifactHost()
        ? h("li", null, "claude.ai にサインインしていれば、あなただけが読める場所（この Artifact の中）にも写しを置き、別の端末で開いても同じ内容が出ます。ほかの人には見えません。")
        : h("li", null, "ブラウザのデータを消すと消えます。大事なときは JSON で書き出して、別の場所にも残してください。"),
      h("li", null, "大事な節目には JSON で書き出して、別の場所にも残してください。"),
    ),
  );
  m.footer.append(h("button", { class: "btn", type: "button", onClick: () => m.close() }, "閉じる"));
}

// ------------------------------------------------------------ ようこそ

export function openWelcome(app: AppContext): void {
  const m = openModal({ title: "4D Branch へようこそ", width: 620, className: "welcome-modal", onClose: () => app.ui.setPrefs({ onboardingDone: true }) });
  const types = h("div", { class: "welcome-types" });
  for (const t of NODE_TYPE_ORDER) types.append(h("div", { class: `welcome-type type-${t}` }, h("span", { class: `type-chip type-${t}` }, icon(t, 16)), h("b", null, NODE_TYPES[t].label), h("span", null, NODE_TYPES[t].hint)));
  m.body.append(
    h("p", { class: "welcome-lead" }, "目標・行動・分岐・結果をノードとしてつなぎ、", h("b", null, "未来の分岐"), "を見える化するメモ帳です。プロジェクトをまたいで、1 つの行動が複数の目標に効く様子を描けます。"),
    types,
    h("div", { class: "welcome-demo" }, icon("sparkle", 16), h("div", null, h("b", null, "デモを開いています: "), "「SpellDash事業」「FCマーケティングでの業務」「広告運用事業での独立」の 3 つが、「広告運用を学ぶ」などの共通のノードでつながっています。")),
    h(
      "p",
      { class: "muted small" },
      inArtifactHost()
        ? "データはこのブラウザに保存し、claude.ai にサインインしていれば、あなただけが読める場所（この Artifact の中）にも同期します。ほかの人には見えません。AI による分析や予測はしません。外部の AI と考えた内容を、ここに自由に記録してください。"
        : "データはこのブラウザの中だけに保存されます（サーバーには送りません）。AI による分析や予測はしません。外部の AI と考えた内容を、ここに自由に記録してください。",
    ),
  );
  const tourBtn = h("button", { class: "btn btn-primary", type: "button" }, icon("play", 14), "操作ガイドを見る（1 分）");
  tourBtn.addEventListener("click", () => {
    m.close();
    app.startTour();
  });
  m.footer.append(h("button", { class: "btn", type: "button", onClick: () => m.close() }, "すぐに使う"), tourBtn);
  setTimeout(() => tourBtn.focus());
}

// ------------------------------------------------------------ 文章の編集・名前

export function openTextDialog(opts: { title: string; label: string; value: string; multiline?: boolean; placeholder?: string; ok?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const m = openModal({ title: opts.title, width: 480, onClose: () => resolve(result) });
    const field = opts.multiline
      ? h("textarea", { class: "input", value: opts.value, placeholder: opts.placeholder, attrs: { rows: "5", "aria-label": opts.label } })
      : h("input", { class: "input", value: opts.value, placeholder: opts.placeholder, attrs: { "aria-label": opts.label, maxlength: "120" } });
    m.body.append(h("label", { class: "field" }, h("span", { class: "insp-label" }, opts.label), field));
    const ok = h("button", { class: "btn btn-primary", type: "button" }, opts.ok ?? "保存");
    const submit = () => {
      result = field.value;
      m.close();
    };
    ok.addEventListener("click", submit);
    field.addEventListener("keydown", (ev) => {
      const e = ev as KeyboardEvent;
      if (e.key === "Enter" && !e.isComposing && (!opts.multiline || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
    });
    m.footer.append(h("button", { class: "btn", type: "button", onClick: () => m.close() }, "キャンセル"), ok);
    setTimeout(() => {
      field.focus();
      if (field instanceof HTMLInputElement) field.select();
    });
  });
}

export type { DocData };

// ------------------------------------------------------------ 同期の状態の文

export function cloudText(c: { state: string; message: string; lastSyncedAt: string | null }): string {
  const at = c.lastSyncedAt ? new Date(c.lastSyncedAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "";
  switch (c.state) {
    case "synced":
      return `同期済み${at ? `（${at}）` : ""}`;
    case "pending":
      return c.message || "同期待ち（少しまとめてから送ります）";
    case "syncing":
      return "同期中…";
    case "connecting":
      return "接続中…";
    case "offline":
    case "error":
    case "denied":
    case "unavailable":
      return c.message || "このブラウザだけに保存しています";
    default:
      return "同期していません";
  }
}

// ------------------------------------------------------------ 書き出しの代わり（ファイルを保存できない画面）

export function openCopyDialog(text: string, filename: string): void {
  const m = openModal({ title: "JSON を書き出す", subtitle: filename, width: 620, icon: "download" });
  const ta = h("textarea", { class: "input copy-area", attrs: { readonly: "", rows: "12", "aria-label": "書き出す内容", spellcheck: "false" } });
  ta.value = text;
  m.body.append(
    h("p", { class: "modal-text" }, "この画面からはファイルを直接保存できません。下の内容をコピーして、テキストエディタなどで「", h("b", null, filename), "」として保存してください。読み込むときは、その .json ファイルを選びます。"),
    ta,
    h("p", { class: "muted small" }, `${(text.length / 1024).toFixed(1)} KB`),
  );
  const copy = h("button", { class: "btn btn-primary", type: "button" }, icon("copy", 14), "コピー");
  copy.addEventListener("click", () => {
    const fallback = () => {
      ta.focus();
      ta.select();
      toast("選択しました。⌘C（Ctrl+C）でコピーしてください");
    };
    try {
      navigator.clipboard.writeText(text).then(() => toast("コピーしました", { tone: "ok" }), fallback);
    } catch {
      fallback();
    }
  });
  m.footer.append(h("button", { class: "btn", type: "button", onClick: () => m.close() }, "閉じる"), copy);
  setTimeout(() => copy.focus());
}
