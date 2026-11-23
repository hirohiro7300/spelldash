// 起動: 保存先を開く → 同梱の地図を読み込む → 編集できるタブか確かめる → 読み込む（無ければデモ）→ 画面を組み立てる → （Artifact の中なら）アカウントと同期
// 保存してあったのがこのページより新しい版・このページでは開けないデータなら、読み込みの所で止める（画面・設定・同期を組み立てず、何も書かない）。
// ページに 3 か月ごとの地図を入れたビルド（src/demo/pageBundle.ts の PAGE_Q）は、薄い形（版 2）を読み書きする。地図は要るときだけ読む
// （保存してあった物に地図がある・利用者が地図を開く: 見直し gaps-17）。既定のビルドは何も変わらない

import "./styles/tokens.css";
import "./styles/app.css";
import { App } from "./app/App";
import { UiState } from "./app/uiState";
import { mapForDoc, pageMapDoc, rememberMapDoc } from "./app/futureCache";
import { buildDemoDoc } from "./demo/demo";
import { loadImpactBundle } from "./demo/futureBundle";
import { loadPageMap, PAGE_Q, PAGE_Q_RELEASE } from "./demo/pageBundle";
import { buildStressDoc } from "./demo/stress";
import type { DocData } from "./model/types";
import { decodeStored, enableThinPage, setBeforeMapDecode, thinReadable, toStored, watchThinWrites } from "./persist/codec";
import { Persistence } from "./persist/persistence";
import { Store } from "./store/store";
import { isNarrowScreen } from "./ui/breakpoints";
import { paintDeepSplash } from "./ui/deepSplash";
import { showNewerScreen } from "./ui/newerScreen";

/**
 * 表示の切り替え。claude.ai の Artifact ではクエリ文字列が渡らないので #stress-2000 ・ #demo も受ける。
 * #demo-q: ページに入れた 3 か月ごとの地図（版 7）だけを組み立てた一時表示（保存しない・読むだけの確かめの道。残す: 保存してあるデータに
 * 触れずに地図を見る・性能を測る比べ物。地図を入れないビルドではふつうのデモ）。ふだんの起動は保存してあった物を読む道（下の loadInitial）
 */
function readMode(): { stress: number; demo: boolean; demoQ: boolean } {
  const params = new URLSearchParams(location.search);
  const hash = location.hash.replace(/^#/, "");
  const m = /^stress-(\d{1,5})$/.exec(hash);
  const stress = Math.max(0, Math.min(20000, Number(params.get("stress") || (m ? m[1] : 0)) || 0));
  const demoQ = hash === "demo-q";
  return { stress, demo: params.has("demo") || hash === "demo" || demoQ, demoQ };
}

async function boot(opts: { reopen?: boolean } = {}): Promise<void> {
  // ページの言語（Artifact 版は公開のときの骨組みの <html> に言語が無い）。読み上げ・文節の切れ目での折り返し（word-break: auto-phrase）は、
  // 日本語と分かる所でしか効かない。#app には付けてあるが、その外に足す物（ファイルを落とす所など）もあるので、ページにも付ける
  if (!document.documentElement.lang) document.documentElement.lang = "ja";
  const mount = document.getElementById("app")!;
  const mode = readMode();
  const ephemeral = mode.stress > 0 || mode.demo;
  // 手で # を書き換えて表示の種類が変わったら、開き直す（「この版で開き直す」で起動し直すときは、もう見張っている）
  if (!opts.reopen)
    window.addEventListener("hashchange", () => {
      const next = readMode();
      if (next.stress !== mode.stress || next.demo !== mode.demo || next.demoQ !== mode.demoQ) location.reload();
    });
  // ページに 3 か月ごとの地図を入れたビルド: 薄い形を読み書きする（地図はまだ読まない。保存してあった物に地図があれば、読むときに読む）。
  // 版の記録に基準の文書の指紋があれば、起動で数え直さない（7 万枚で約 0.4 秒: 見直し code-2）
  if (PAGE_Q) enableThinPage(loadPageMap, PAGE_Q_RELEASE?.digest ? { digest: PAGE_Q_RELEASE.digest } : {});
  const persistence = new Persistence({ mode: ephemeral ? "memory" : "auto" });
  await persistence.open();
  // 同梱の地図（未来の道筋・版 6）を、保存してあった文書を読む前に 1 度だけ読み込む（画面・同期・地図の版の見分けは、
  // 同期で読む口 futureVersion などを使う。済む前に呼ぶと止まる。版 6 は読んだ印を立てるだけ）。
  // 3 か月ごとの地図（PAGE_Q）は、ここでは読まない（要るときだけ: src/persist/codec.ts の decodeStoredAsync・ensurePageMap）
  await loadImpactBundle();

  let doc: DocData | null = null;
  let notices: string[] = [];
  let firstRun = false;
  /** 保存してあった内容を読めず、代わりの内容（デモ・バックアップ）で始めた（アカウントの同期で、古い手元として扱う） */
  let bootFallback = false;
  if (mode.stress > 0) doc = buildStressDoc(mode.stress);
  // 3 か月ごとの地図は、8 万枚の文書を組み立てる前に見取り図だけを先に描く
  else if (mode.demoQ) doc = (await pageMapDoc((m) => paintDeepSplash(mount, m))) ?? buildDemoDoc();
  else if (ephemeral) doc = buildDemoDoc();
  else {
    await persistence.acquireWriter();
    // 保存してあった物に地図がある: 地図を読んだ後、基準の文書を組み立てる前（7 万枚で約 1 秒）に、見取り図だけを先に描く
    // （年収は保存してあった今日の物。作業メモ SPEC §7.2 の最初の描画・W-app の I3）
    if (PAGE_Q)
      setBeforeMapDecode(async (raw) => {
        const map = await loadPageMap();
        if (map) await paintDeepSplash(mount, map, ...storedAnnual(raw));
      });
    const loaded = await persistence.loadInitial({ reopen: opts.reopen }).finally(() => setBeforeMapDecode(null));
    if (loaded.blocked) {
      // このページより新しい版で保存されたデータ・このページでは開けないデータ: 壊れたのではない。バックアップやデモで始めず、
      // ストア・画面・設定・アカウントの同期を作らずに止める（どれも作らなければ、本体・緊急コピー・バックアップ・設定のどれにも書かない）。
      // 薄い形を読み書きするページは、保存されているデータをそのまま書き出せる（safety-3）。地図が合わないだけなら「この版で開き直す」も（safety-5）
      const thin = thinReadable();
      showNewerScreen(mount, {
        ...(loaded.why ? { why: loaded.why } : {}),
        ...(thin ? { rawExport: () => persistence.rawRecord() } : {}),
        ...(thin && loaded.why?.reopen ? { reopen: () => void boot({ reopen: true }).catch(fail) } : {}),
      });
      (window as unknown as { __fourD: unknown }).__fourD = { persistence, blocked: true, why: loaded.why ?? null };
      return;
    }
    doc = loaded.doc;
    // 読んだ文書がページの地図を組み立てたままの形と数なら、3 年の影響の形を地図の列から作る（文書から組み立て直さない: W-app の I1）
    const shaped = doc ? mapForDoc(doc) : null;
    if (doc && shaped) rememberMapDoc(doc, shaped);
    notices = loaded.notices;
    bootFallback = loaded.recovered;
    if (!doc) {
      doc = buildDemoDoc();
      firstRun = true;
      bootFallback = true;
    }
  }

  // 表示の設定は、止めずに始めると決まってから読む（読むときに前の版の値を移して書くことがある）
  const ui = new UiState();
  if (ephemeral) ui.persistPrefs = false;
  // 狭い画面では左右のパネルを閉じて始める（キャンバスを広く）。重ねて出す CSS と同じ判定（860px ちょうども狭い側）
  if (isNarrowScreen()) ui.prefs = { ...ui.prefs, leftOpen: false, rightOpen: false };
  const store = new Store(doc);
  // ストアが書いた所を保存の書き手に知らせる（自動保存は変わった所だけ見直す: 見直し perf-10）。画面の部品が変更を受ける前につなぐ
  if (PAGE_Q) watchThinWrites(store);
  store.readOnly = !persistence.writer;
  const app = new App({ store, ui, persistence, ephemeral, firstRun, bootFallback, notices, mount });
  persistence.attach(() => store.doc);
  if (!ephemeral) {
    if (firstRun) persistence.markDirty();
    void persistence.ensureDailyBackup(store.doc).catch(() => undefined);
    void app.startCloud().catch(() => undefined);
  }
  // 確かめ用（E2E・開発者ツール）
  (window as unknown as { __fourD: unknown }).__fourD = { app, store, ui, persistence, codec: { toStored, decodeStored: (raw: unknown) => decodeStored(raw).doc } };
}

/** 保存してあった記録の今日の年収（先に描く見取り図に使う。読めなければ空: 見取り図の既定の年収） */
function storedAnnual(raw: unknown): [number] | [] {
  const r = raw as { nodes?: Record<string, { meta?: Record<string, unknown> } | undefined>; maps?: Array<{ root?: unknown }> } | null;
  const nodes = r && typeof r === "object" ? r.nodes : undefined;
  if (!nodes || typeof nodes !== "object") return [];
  const annualOf = (meta: Record<string, unknown> | undefined): number | undefined => {
    const imp = meta?.impact as { annual?: unknown } | undefined;
    return typeof imp?.annual === "number" && Number.isFinite(imp.annual) && imp.annual > 0 ? imp.annual : undefined;
  };
  const root = Array.isArray(r!.maps) && typeof r!.maps[0]?.root === "string" ? (r!.maps[0]!.root as string) : null;
  const a = root ? annualOf(nodes[root]?.meta) : undefined;
  if (a !== undefined) return [a];
  for (const id of Object.keys(nodes)) {
    const meta = nodes[id]?.meta;
    if (meta?.forecastRoot !== true) continue;
    const b = annualOf(meta);
    if (b !== undefined) return [b];
  }
  return [];
}

/** 起動できなかった（何も書いていない） */
function fail(err: unknown): void {
  console.error(err);
  const mount = document.getElementById("app");
  if (mount) {
    mount.innerHTML = "";
    const box = document.createElement("div");
    box.className = "boot";
    box.textContent = `起動できませんでした: ${err instanceof Error ? err.message : String(err)}。再読み込みしてください。データはこのブラウザに残っています。`;
    mount.append(box);
  }
}

boot().catch(fail);
