// 4D Branch のデータモデル（保存・書き出しの形）。設計: docs/DESIGN.md §3
// 全プロジェクトで 1 つのグラフを共有し、プロジェクト・シナリオはノード／接続に付く「所属」として持つ。

export type ID = string;

/** ノードの種類: 目標・行動・分岐・結果 */
export type NodeType = "goal" | "action" | "branch" | "result";

/** ノードの状態 */
export type NodeStatus = "open" | "active" | "done" | "dropped";

/** 接続の関係: 進む・条件付き・相乗効果・阻害・循環 */
export type Relation = "leads" | "condition" | "supports" | "blocks" | "feedback";

export type Meta = Record<string, unknown>;

/** ノードの条件（チェックリストの 1 行） */
export interface Condition {
  id: ID;
  text: string;
  met: boolean;
}

/** 時間情報。将来、期間・不確かさの幅などを足せるようにオブジェクトで持つ */
export interface NodeTime {
  /** 期限（YYYY-MM-DD・ローカル日付） */
  due: string | null;
  /** 開始（YYYY-MM-DD・任意） */
  start: string | null;
}

export interface GNode {
  id: ID;
  type: NodeType;
  title: string;
  /** 文章（複数行） */
  body: string;
  status: NodeStatus;
  time: NodeTime;
  conditions: Condition[];
  tags: string[];
  /** 所属プロジェクト（複数可。空なら未分類） */
  projectIds: ID[];
  /** 所属シナリオ（空 = 全シナリオ共通） */
  scenarioIds: ID[];
  /** 共通キャンバス上の中心座標 */
  x: number;
  y: number;
  /** このノードの先（下流）を折りたたむ */
  collapsed: boolean;
  createdAt: string;
  updatedAt: string;
  meta: Meta;
}

export interface GEdge {
  id: ID;
  /** 向き: source → target */
  source: ID;
  target: ID;
  relation: Relation;
  label: string;
  /** 条件分岐の条件 */
  condition: string;
  /** 所属シナリオ（空 = 全シナリオ共通） */
  scenarioIds: ID[];
  /** この線の先を折りたたむ */
  collapsed: boolean;
  createdAt: string;
  updatedAt: string;
  meta: Meta;
}

export interface Project {
  id: ID;
  name: string;
  color: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  meta: Meta;
}

export interface Scenario {
  id: ID;
  name: string;
  color: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  meta: Meta;
}

export interface DocData {
  schema: "4d-branch";
  version: number;
  id: ID;
  title: string;
  createdAt: string;
  updatedAt: string;
  projects: Record<ID, Project>;
  scenarios: Record<ID, Scenario>;
  nodes: Record<ID, GNode>;
  edges: Record<ID, GEdge>;
  projectOrder: ID[];
  scenarioOrder: ID[];
  meta: Meta;
}

export type Collection = "nodes" | "edges" | "projects" | "scenarios";

export interface EntityOf {
  nodes: GNode;
  edges: GEdge;
  projects: Project;
  scenarios: Scenario;
}
