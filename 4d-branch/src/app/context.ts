// 画面の部品どうしが使う共通の入口
import type { CanvasView } from "../canvas/CanvasView";
import type { DocData, ID } from "../model/types";
import type { CloudState } from "../persist/cloud";
import type { BackupKind, Persistence } from "../persist/persistence";
import type { Store } from "../store/store";
import type { Commands } from "./commands";
import type { UiState } from "./uiState";
import type { ViewModel } from "./viewModel";

/** 読み込んだ後の見せ方 */
export interface LoadOpts {
  /** お知らせの文（入れ替え: そのまま、追加: 件数の前に付ける） */
  done?: string;
  /** 読み込んだ後に寄るノード（added: 足したノード。入れ替えではすべて） */
  fitTo?: (doc: DocData, added: ID[]) => ID[];
}

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
  /** リストに今出ている行のノード */
  listIds: () => ID[];
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
  /** やりたいことリスト（2,000 件）を読み込む前の確認を開く */
  loadWishlist(): void;
  newEmptyDoc(): Promise<void>;
  /** 文書を入れ替える（label は元に戻す・安全用バックアップの名前） */
  replaceDocSafely(doc: DocData, label: string, opts?: LoadOpts): Promise<void>;
  /** 取り込んだ文書を今のデータに足す（select: false なら足した分を選ばない） */
  mergeDoc(doc: DocData, opts?: LoadOpts & { label?: string; select?: boolean }): void;
}
