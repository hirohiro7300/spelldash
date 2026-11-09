import type { NodeStatus, NodeType, Relation } from "./types";

// 色はここと src/styles/tokens.css の 2 か所に集める（デザインの差し替えを小さくする）

export interface NodeTypeMeta {
  label: string;
  en: string;
  color: string;
  /** 種類を切り替えるキー */
  key: string;
  hint: string;
}

export const NODE_TYPES: Record<NodeType, NodeTypeMeta> = {
  goal: { label: "目標", en: "GOAL", color: "#FFB547", key: "1", hint: "到達したい状態" },
  action: { label: "行動", en: "ACTION", color: "#4DA3FF", key: "2", hint: "自分がやること" },
  branch: { label: "分岐", en: "BRANCH", color: "#B983FF", key: "3", hint: "選択・判断のポイント" },
  result: { label: "結果", en: "RESULT", color: "#3DD9A4", key: "4", hint: "起きる出来事・得られる結果" },
};

export const NODE_TYPE_ORDER: NodeType[] = ["goal", "action", "branch", "result"];

export interface RelationMeta {
  label: string;
  color: string;
  /** 線の破線パターン（ワールド座標の長さ） */
  dash: number[];
  width: number;
  hint: string;
}

export const RELATIONS: Record<Relation, RelationMeta> = {
  leads: { label: "進む", color: "#8A97B1", dash: [], width: 1.6, hint: "次の段階・因果" },
  condition: { label: "条件付き", color: "#F2C14E", dash: [7, 5], width: 1.7, hint: "条件を満たしたら進む" },
  supports: { label: "相乗効果", color: "#FF6FB5", dash: [1, 6], width: 2.6, hint: "別の目標・プロジェクトを後押しする" },
  blocks: { label: "阻害", color: "#FF5D6C", dash: [], width: 1.8, hint: "妨げる・トレードオフ" },
  feedback: { label: "循環", color: "#4FD1E8", dash: [12, 6], width: 1.7, hint: "結果が前の行動に戻る" },
};

export const RELATION_ORDER: Relation[] = ["leads", "condition", "supports", "blocks", "feedback"];

export const STATUSES: Record<NodeStatus, { label: string; color: string }> = {
  open: { label: "未着手", color: "#8A94A6" },
  active: { label: "進行中", color: "#4DA3FF" },
  done: { label: "完了", color: "#3DD9A4" },
  dropped: { label: "見送り", color: "#6B7280" },
};

export const STATUS_ORDER: NodeStatus[] = ["open", "active", "done", "dropped"];

export const PROJECT_COLORS = ["#FF7A59", "#22D3EE", "#A3E635", "#F472B6", "#A78BFA", "#FACC15", "#60A5FA", "#FB923C", "#2DD4BF", "#94A3B8"];

export const SCENARIO_COLORS = ["#8B7BFF", "#F2C14E", "#4FD1E8", "#FF6FB5", "#3DD9A4", "#FB923C", "#A3E635", "#94A3B8"];

/** ノードの大きさ（ワールド座標）。全種類で同じにして、並べやすく・当たり判定を速くする */
export const NODE_W = 212;
export const NODE_H = 96;

/** 子ノードを置くときの横の間隔 */
export const CHILD_DX = 300;
/** 兄弟ノードの縦の間隔 */
export const SIBLING_DY = 128;

export const APP_NAME = "4D Branch";
export const APP_VERSION = "0.1.0";
