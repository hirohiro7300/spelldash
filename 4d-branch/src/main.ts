// 起動: 保存先を開く → 編集できるタブか確かめる → 読み込む（無ければデモ）→ 画面を組み立てる

import "./styles/tokens.css";
import "./styles/app.css";
import { App } from "./app/App";
import { UiState } from "./app/uiState";
import { buildDemoDoc } from "./demo/demo";
import { buildStressDoc } from "./demo/stress";
import type { DocData } from "./model/types";
import { Persistence } from "./persist/persistence";
import { Store } from "./store/store";

async function boot(): Promise<void> {
  const mount = document.getElementById("app")!;
  const params = new URLSearchParams(location.search);
  const stress = Math.max(0, Math.min(20000, Number(params.get("stress") || 0)));
  const ephemeral = stress > 0 || params.has("demo");
  const ui = new UiState();
  const persistence = new Persistence({ mode: ephemeral ? "memory" : "auto" });
  await persistence.open();

  let doc: DocData | null = null;
  let notices: string[] = [];
  let firstRun = false;
  if (stress > 0) doc = buildStressDoc(stress);
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
