// 起動: 保存先を開く → 編集できるタブか確かめる → 読み込む（無ければデモ）→ 画面を組み立てる → （Artifact の中なら）アカウントと同期

import "./styles/tokens.css";
import "./styles/app.css";
import { App } from "./app/App";
import { UiState } from "./app/uiState";
import { buildDemoDoc } from "./demo/demo";
import { buildStressDoc } from "./demo/stress";
import type { DocData } from "./model/types";
import { Persistence } from "./persist/persistence";
import { Store } from "./store/store";
import { isNarrowScreen } from "./ui/breakpoints";

/** 表示の切り替え。claude.ai の Artifact ではクエリ文字列が渡らないので #stress-2000 ・ #demo も受ける */
function readMode(): { stress: number; demo: boolean } {
  const params = new URLSearchParams(location.search);
  const hash = location.hash.replace(/^#/, "");
  const m = /^stress-(\d{1,5})$/.exec(hash);
  const stress = Math.max(0, Math.min(20000, Number(params.get("stress") || (m ? m[1] : 0)) || 0));
  return { stress, demo: params.has("demo") || hash === "demo" };
}

async function boot(): Promise<void> {
  const mount = document.getElementById("app")!;
  const mode = readMode();
  const ephemeral = mode.stress > 0 || mode.demo;
  // 手で # を書き換えて表示の種類が変わったら、開き直す
  window.addEventListener("hashchange", () => {
    const next = readMode();
    if (next.stress !== mode.stress || next.demo !== mode.demo) location.reload();
  });
  const ui = new UiState();
  if (ephemeral) ui.persistPrefs = false;
  // 狭い画面では左右のパネルを閉じて始める（キャンバスを広く）。重ねて出す CSS と同じ判定（860px ちょうども狭い側）
  if (isNarrowScreen()) ui.prefs = { ...ui.prefs, leftOpen: false, rightOpen: false };
  const persistence = new Persistence({ mode: ephemeral ? "memory" : "auto" });
  await persistence.open();

  let doc: DocData | null = null;
  let notices: string[] = [];
  let firstRun = false;
  if (mode.stress > 0) doc = buildStressDoc(mode.stress);
  else if (ephemeral) doc = buildDemoDoc();
  else {
    await persistence.acquireWriter();
    const loaded = await persistence.loadInitial();
    doc = loaded.doc;
    notices = loaded.notices;
    if (!doc) {
      doc = buildDemoDoc();
      firstRun = true;
    }
  }

  const store = new Store(doc);
  store.readOnly = !persistence.writer;
  const app = new App({ store, ui, persistence, ephemeral, firstRun, notices, mount });
  persistence.attach(() => store.doc);
  if (!ephemeral) {
    if (firstRun) persistence.markDirty();
    void persistence.ensureDailyBackup(store.doc).catch(() => undefined);
    void app.startCloud().catch(() => undefined);
  }
  // 確かめ用（E2E・開発者ツール）
  (window as unknown as { __fourD: unknown }).__fourD = { app, store, ui, persistence };
}

boot().catch((err) => {
  console.error(err);
  const mount = document.getElementById("app");
  if (mount) {
    mount.innerHTML = "";
    const box = document.createElement("div");
    box.className = "boot";
    box.textContent = `起動できませんでした: ${err instanceof Error ? err.message : String(err)}。再読み込みしてください。データはこのブラウザに残っています。`;
    mount.append(box);
  }
});
