// 画面の部品どうしが使う共通の入口
import type { CanvasView } from "../canvas/CanvasView";
import type { DocData, ID } from "../model/types";
import type { CloudState } from "../persist/cloud";
import type { BackupKind, Persistence } from "../persist/persistence";
import type { Store } from "../store/store";
import type { Commands } from "./commands";
import type { UiState } from "./uiState";
import type { ViewModel } from "./viewModel";

export interface AppContext {
  store: Store;
  ui: UiState;
  vm: ViewModel;
  cmd: Commands;
  persistence: Persistence;
  view: CanvasView;
  /** 保存しない一時表示（?stress など） */
  ephemeral: boolean;
  lastBackupLabel: { kind: BackupKind; when: string } | null;
  onBackupsChanged: () => void;
  /** アカウントへの同期の状態（claude.ai の Artifact の外では null） */
  cloudInfo: { state: CloudState | "unavailable"; message: string; lastSyncedAt: string | null } | null;
  onCloudChanged: () => void;
  /** アカウントとの突き合わせをやり直す（止めていた同期の再開） */
  resyncCloud(): void;
  focusSearch: () => void;
  focusInspectorTitle: () => void;
  focusEdgeCondition: () => void;
  revealInList: (id: ID) => void;
  refreshList: () => void;
  afterTour?: () => void;
  renameDoc(): void;
  editDescription(kind: "project" | "scenario", id: ID): void;
  openBackups(): void;
  openHelp(): void;
  startTour(): void;
  exportJson(doc?: DocData, filename?: string): void;
  pickImport(): void;
  backupNow(): Promise<void>;
  loadDemo(): Promise<void>;
  newEmptyDoc(): Promise<void>;
  replaceDocSafely(doc: DocData, label: string): Promise<void>;
  mergeDoc(doc: DocData): void;
}
