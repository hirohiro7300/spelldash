// 薄い形の保存（src/persist/thinMap.ts）の確かめに使う、利用者の編集の種と、アカウントの形の文書にする写し。
// 編集は本物のストア（src/store/store.ts）を通す（時刻・履歴・元に戻すがアプリと同じに動く）。種が同じなら同じ順の編集
// （時刻は今の時刻なので、往復の比べ方は時刻に依らない）。
//   状態・やることのチェック・やることの文と数・題名・本文・見込み（%）・線の説明と条件・線の関係・タグ・meta・利用者のカードと線
//   （地図から・地図へ・地図のカードどうし）・地図のカードを消す（その先ごと・1 枚だけ・親からの線だけ）・同梱の線の付け替え・
//   プロジェクトとシナリオの名前の変更・足す・消す・年収・今日の題名・折りたたみ・利用者のカードの移動・複製・元に戻す・やり直す
// アカウントの形（見直し safety-6・gaps-5）: カード・線・やることの項目・今日・プロジェクトの ID を乱数の形に振り直し、位置をずらし、時刻を変える

import { makeCondition, makeEdge, makeNode, makeProject, makeScenario } from "../../../src/model/schema";
import type { DocData, GEdge, GNode, ID, Meta, NodeStatus } from "../../../src/model/types";
import type { Store } from "../../../src/store/store";

/** 種から決まる乱数（mulberry32） */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHA = "0123456789abcdefghijklmnopqrstuvwxyz";
/** 乱数の形の ID（アプリの newId と同じ形。種から決まる） */
export function fakeId(R: () => number, prefix: string): ID {
  let s = "";
  for (let i = 0; i < 12; i++) s += ALPHA[Math.floor(R() * 36)];
  return `${prefix}_${s}`;
}

const pick = <T>(R: () => number, xs: readonly T[]): T => xs[Math.floor(R() * xs.length)]!;
const keyOf = (n: GNode | undefined): string | null => (typeof n?.meta?.key === "string" ? n.meta.key : null);

/** 複製で写しに持たせない meta（src/app/commands.ts の COPY_DROP_NODE と同じ） */
const COPY_DROP = ["forecastRoot", "impact", "futureVersion", "futureRelease", "key", "base", "t0", "b0", "k0", "fams", "anchor", "textVersion", "never"];

export type EditKind =
  | "status"
  | "tick"
  | "todoText"
  | "todoAdd"
  | "todoDel"
  | "title"
  | "body"
  | "prob"
  | "edgeText"
  | "relation"
  | "tag"
  | "metaSet"
  | "metaDel"
  | "userCard"
  | "userEdgeIn"
  | "userEdgeMap"
  | "delSubtree"
  | "delCard"
  | "delBundleEdge"
  | "repoint"
  | "projRename"
  | "projAdd"
  | "projDelete"
  | "scenRename"
  | "scenAdd"
  | "scenDelete"
  | "salary"
  | "rootTitle"
  | "collapse"
  | "moveUser"
  | "dupCard"
  | "userDelete"
  | "undo"
  | "redo";

export const EDIT_KINDS: readonly EditKind[] = [
  "status",
  "tick",
  "todoText",
  "todoAdd",
  "todoDel",
  "title",
  "body",
  "prob",
  "edgeText",
  "relation",
  "tag",
  "metaSet",
  "metaDel",
  "userCard",
  "userEdgeIn",
  "userEdgeMap",
  "delSubtree",
  "delCard",
  "delBundleEdge",
  "repoint",
  "projRename",
  "projAdd",
  "projDelete",
  "scenRename",
  "scenAdd",
  "scenDelete",
  "salary",
  "rootTitle",
  "collapse",
  "moveUser",
  "dupCard",
  "userDelete",
  "undo",
  "redo",
];

/** 文書の中の地図のカード（鍵のあるノード）と今日 */
function cardsOf(doc: DocData): { root: GNode | null; cards: GNode[]; users: GNode[] } {
  let root: GNode | null = null;
  const cards: GNode[] = [];
  const users: GNode[] = [];
  for (const id of Object.keys(doc.nodes)) {
    const n = doc.nodes[id]!;
    if (n.meta.forecastRoot === true && keyOf(n) !== null) root = n;
    else if (keyOf(n) !== null) cards.push(n);
    else users.push(n);
  }
  return { root, cards, users };
}

/** 道の線でたどれる子（鍵のあるカードだけ） */
function keyedBelow(doc: DocData, id: ID): ID[] {
  const out = new Map<ID, ID[]>();
  for (const e of Object.values(doc.edges)) {
    if (e.relation !== "leads" && e.relation !== "condition") continue;
    const l = out.get(e.source);
    if (l) l.push(e.target);
    else out.set(e.source, [e.target]);
  }
  const seen = new Set<ID>([id]);
  const stack = [id];
  while (stack.length) for (const t of out.get(stack.pop()!) ?? []) if (!seen.has(t) && keyOf(doc.nodes[t]) !== null) (seen.add(t), stack.push(t));
  return [...seen];
}

/** 親からの同梱の線（両端が鍵のあるカードで、先の鍵が元の鍵 + "."…） */
function bundleEdges(doc: DocData): GEdge[] {
  const out: GEdge[] = [];
  for (const e of Object.values(doc.edges)) {
    const s = keyOf(doc.nodes[e.source]);
    const t = keyOf(doc.nodes[e.target]);
    // 先の鍵の最後の "." より前が、元の鍵とちょうど同じ
    if (s !== null && t !== null && t.lastIndexOf(".") === s.length && t.startsWith(s)) out.push(e);
  }
  return out;
}

/**
 * 編集を 1 つする（できなければ何もしない）。何をしたかを返す。once は 1 回だけにする種類（消すなど）を数える
 */
export function applyEdit(store: Store, R: () => number, kind: EditKind, once: Set<EditKind>): boolean {
  const doc = store.doc;
  const { root, cards, users } = cardsOf(doc);
  if (!root) return false;
  // 種類ごとに要る物だけ数える（毎回ぜんぶ数えると、編集の多いテストが遅くなる）
  const withTodoOf = (): GNode[] => cards.filter((n) => n.conditions.length > 0);
  const outcomeEdgesOf = (): GEdge[] => Object.values(doc.edges).filter((e) => typeof e.meta.prob === "number");
  const pids = doc.projectOrder.filter((p) => doc.projects[p]);
  const sids = doc.scenarioOrder.filter((s) => doc.scenarios[s]);
  const card = (): GNode | null => (cards.length ? pick(R, cards) : null);
  switch (kind) {
    case "status": {
      const c = card();
      if (!c) return false;
      const status: NodeStatus = pick(R, ["active", "dropped", "done", "open"] as const);
      return store.transact("状態", (tx) => tx.updateNode(c.id, { status }));
    }
    case "tick": {
      const withTodo = withTodoOf();
      if (!withTodo.length) return false;
      const c = pick(R, withTodo);
      const t = Math.floor(R() * c.conditions.length);
      return store.transact("チェック", (tx) => tx.updateNode(c.id, { conditions: c.conditions.map((x, k) => (k === t ? { ...x, met: !x.met } : x)) }));
    }
    case "todoText": {
      const withTodo = withTodoOf();
      if (!withTodo.length) return false;
      const c = pick(R, withTodo);
      const t = Math.floor(R() * c.conditions.length);
      return store.transact("やることの文", (tx) => tx.updateNode(c.id, { conditions: c.conditions.map((x, k) => (k === t ? { ...x, text: `${x.text}（自分の言葉で）` } : x)) }));
    }
    case "todoAdd": {
      const c = card();
      if (!c) return false;
      return store.transact("やることを足す", (tx) => tx.updateNode(c.id, { conditions: [...c.conditions, makeCondition("総務に副業の届け出の様式をもらう", R() < 0.5)] }));
    }
    case "todoDel": {
      const withTodo = withTodoOf();
      if (!withTodo.length) return false;
      const c = pick(R, withTodo);
      const t = Math.floor(R() * c.conditions.length);
      return store.transact("やることを消す", (tx) => tx.updateNode(c.id, { conditions: c.conditions.filter((_, k) => k !== t) }));
    }
    case "title": {
      const c = card();
      if (!c) return false;
      return store.transact("題名", (tx) => tx.updateNode(c.id, { title: `${c.title}（直した）` }));
    }
    case "body": {
      const c = card();
      if (!c) return false;
      return store.transact("本文", (tx) => tx.updateNode(c.id, { body: `${c.body}\n自分のメモ: 2027 年 3 月に見直す。顧客 2 社・月 18 万円を下回ったら手を変える。` }));
    }
    case "prob": {
      const outcomeEdges = outcomeEdgesOf();
      if (!outcomeEdges.length) return false;
      const e = pick(R, outcomeEdges);
      const prob = Math.max(1, Math.min(99, (e.meta.prob as number) + (R() < 0.5 ? -7 : 9)));
      return store.transact("見込み", (tx) => tx.updateEdge(e.id, { meta: { ...e.meta, prob } }));
    }
    case "edgeText": {
      const outcomeEdges = outcomeEdgesOf();
      if (!outcomeEdges.length) return false;
      const e = pick(R, outcomeEdges);
      return store.transact("線の文", (tx) => tx.updateEdge(e.id, { label: `${e.label}（自分）`, condition: `${e.condition} かつ 自分の条件` }));
    }
    case "relation": {
      const bs = bundleEdges(doc);
      if (!bs.length) return false;
      const e = pick(R, bs);
      return store.transact("関係", (tx) => tx.updateEdge(e.id, { relation: pick(R, ["supports", "blocks", "feedback"] as const) }));
    }
    case "tag": {
      const c = card();
      if (!c) return false;
      return store.transact("タグ", (tx) => tx.updateNode(c.id, { tags: [...c.tags, pick(R, ["大事", "要確認", "家族と相談"])].filter((x, i, a) => a.indexOf(x) === i) }));
    }
    case "metaSet": {
      const c = card();
      if (!c) return false;
      return store.transact("meta", (tx) => tx.updateNode(c.id, { meta: { ...c.meta, note: { by: "自分", at: Math.floor(R() * 1000) } } }));
    }
    case "metaDel": {
      const c = cards.find((n) => typeof n.meta.why === "string" || typeof n.meta.rank === "number");
      if (!c) return false;
      const meta: Meta = { ...c.meta };
      if (typeof meta.why === "string") delete meta.why;
      else delete meta.rank;
      return store.transact("meta を消す", (tx) => tx.updateNode(c.id, { meta }));
    }
    case "userCard": {
      const c = R() < 0.2 ? root : card();
      if (!c) return false;
      const nn = makeNode({ type: "action", title: `自分のカード ${users.length + 1}`, body: "会社の副業規定を総務に確認する。返事の期限は 12 月末。", x: Math.round(R() * 4000), y: Math.round(R() * 3000) });
      return store.transact("自分のカード", (tx) => {
        tx.addNode(nn);
        tx.addEdge(makeEdge({ source: c.id, target: nn.id }));
      });
    }
    case "userEdgeIn": {
      const c = card();
      if (!c || !users.length) return false;
      const u = pick(R, users);
      return store.transact("地図へ線", (tx) => void tx.addEdge(makeEdge({ source: u.id, target: c.id, relation: "supports" })));
    }
    case "userEdgeMap": {
      if (cards.length < 2) return false;
      const a = pick(R, cards);
      const b = pick(R, cards);
      if (a === b) return false;
      return store.transact("カードどうしの線", (tx) => void tx.addEdge(makeEdge({ source: a.id, target: b.id, relation: "blocks", label: "ぶつかる" })));
    }
    case "delSubtree": {
      const opts = cards.filter((n) => typeof n.meta.ak === "string");
      if (!opts.length) return false;
      const c = pick(R, opts);
      const sub = keyedBelow(doc, c.id);
      return store.transact("その先ごと消す", (tx) => sub.forEach((id) => tx.deleteNode(id)));
    }
    case "delCard": {
      const c = card();
      if (!c) return false;
      return store.transact("1 枚消す", (tx) => tx.deleteNode(c.id));
    }
    case "delBundleEdge": {
      const bs = bundleEdges(doc);
      if (!bs.length) return false;
      const e = pick(R, bs);
      return store.transact("線を消す", (tx) => tx.deleteEdge(e.id));
    }
    case "repoint": {
      const bs = bundleEdges(doc);
      if (!bs.length || !users.length) return false;
      const e = pick(R, bs);
      const u = pick(R, users);
      return store.transact("付け替え", (tx) => void tx.updateEdge(e.id, { target: u.id }));
    }
    case "projRename": {
      if (!pids.length) return false;
      const p = pick(R, pids);
      return store.transact("プロジェクトの名前", (tx) => void tx.updateProject(p, { name: `${doc.projects[p]!.name}（改）` }));
    }
    case "projAdd": {
      const p = makeProject({ name: `資格の勉強 ${pids.length}` });
      const cs = cards.slice(0, 5);
      return store.transact("プロジェクトを足す", (tx) => {
        tx.addProject(p);
        for (const c of cs) tx.updateNode(c.id, { projectIds: [...c.projectIds, p.id] });
      });
    }
    case "projDelete": {
      if (once.has(kind) || !pids.length) return false;
      once.add(kind);
      return store.transact("プロジェクトを消す", (tx) => tx.deleteProject(pick(R, pids)));
    }
    case "scenRename": {
      if (!sids.length) return false;
      const s = pick(R, sids);
      return store.transact("シナリオの名前", (tx) => void tx.updateScenario(s, { name: `${doc.scenarios[s]!.name}（改）` }));
    }
    case "scenAdd": {
      const s = makeScenario({ name: `自分の方針 ${sids.length}` });
      return store.transact("シナリオを足す", (tx) => void tx.addScenario(s));
    }
    case "scenDelete": {
      if (once.has(kind) || !sids.length) return false;
      once.add(kind);
      return store.transact("シナリオを消す", (tx) => tx.deleteScenario(pick(R, sids)));
    }
    case "salary": {
      const imp = (root.meta.impact ?? {}) as Record<string, unknown>;
      return store.transact("年収", (tx) => tx.updateNode(root.id, { meta: { ...root.meta, impact: { ...imp, annual: pick(R, [360, 420, 480, 540]) } } }));
    }
    case "rootTitle":
      return store.transact("今日の題名", (tx) => tx.updateNode(root.id, { title: `${root.title}（2026 年 11 月）` }));
    case "collapse": {
      const c = card();
      if (!c) return false;
      return store.transact("折りたたむ", (tx) => tx.updateNode(c.id, { collapsed: !c.collapsed }));
    }
    case "moveUser": {
      if (!users.length) return false;
      const u = pick(R, users);
      return store.transact("移動", (tx) => tx.updateNode(u.id, { x: u.x + 40, y: u.y - 20 }));
    }
    case "dupCard": {
      const c = card();
      if (!c) return false;
      const meta: Meta = { ...c.meta };
      for (const k of COPY_DROP) delete meta[k];
      const copy = makeNode({ ...c, id: fakeId(R, "n"), x: c.x + 40, y: c.y + 40, conditions: c.conditions.map((x) => ({ ...x, id: fakeId(R, "c") })), createdAt: undefined, updatedAt: undefined, collapsed: false, meta });
      return store.transact("複製", (tx) => void tx.addNode(copy));
    }
    case "userDelete": {
      if (!users.length) return false;
      return store.transact("自分のカードを消す", (tx) => tx.deleteNode(pick(R, users).id));
    }
    case "undo":
      return store.undo();
    case "redo":
      return store.redo();
  }
}

/** 種から編集を count 回する（kinds から選ぶ。できなかった物も数える）。した種類を返す */
export function randomEdits(store: Store, R: () => number, count: number, kinds: readonly EditKind[] = EDIT_KINDS): Set<EditKind> {
  const done = new Set<EditKind>();
  const once = new Set<EditKind>();
  for (let i = 0; i < count; i++) {
    const k = pick(R, kinds);
    if (!applyEdit(store, R, k, once)) continue;
    done.add(k);
    // 元に戻した直後は、やり直すこともある（ほかの編集を挟むとやり直せない）
    if (k === "undo" && kinds.includes("redo") && R() < 0.5 && store.redo()) done.add("redo");
  }
  return done;
}

/**
 * アカウントの形にする（写しを返す。元の文書は変えない）: rate の割合のカード（と今日）の ID・やることの項目の ID を乱数の形に振り直し、
 * 線の端も読み替え、同じ割合の線の ID も振り直す。project があれば、そのプロジェクトの ID を振り直す（カードの所属も）。
 * dx・dy で位置をずらし、at があれば地図のカードと線の時刻をそれにする
 */
export function accountShape(doc: DocData, R: () => number, opts: { rate?: number; rootReId?: boolean; project?: ID; scenario?: ID; dx?: number; dy?: number; at?: string } = {}): DocData {
  const rate = opts.rate ?? 0.1;
  const nodeMap = new Map<ID, ID>();
  const nodes: DocData["nodes"] = {};
  const pNew = opts.project ? fakeId(R, "p") : null;
  const sNew = opts.scenario ? fakeId(R, "s") : null;
  const mapP = (ids: ID[]): ID[] => (pNew ? ids.map((p) => (p === opts.project ? pNew : p)) : ids);
  const mapS = (ids: ID[]): ID[] => (sNew ? ids.map((s) => (s === opts.scenario ? sNew : s)) : ids);
  for (const id of Object.keys(doc.nodes)) {
    const n = doc.nodes[id]!;
    const isRoot = n.meta.forecastRoot === true;
    const reId = keyOf(n) !== null && (isRoot ? opts.rootReId === true : R() < rate);
    const nid = reId ? fakeId(R, "n") : id;
    nodeMap.set(id, nid);
    nodes[nid] = {
      ...n,
      id: nid,
      x: n.x + (opts.dx ?? 0),
      y: n.y + (opts.dy ?? 0),
      projectIds: mapP(n.projectIds),
      scenarioIds: mapS(n.scenarioIds),
      conditions: reId ? n.conditions.map((c) => ({ ...c, id: fakeId(R, "c") })) : n.conditions,
      ...(opts.at && keyOf(n) !== null && !isRoot ? { createdAt: opts.at, updatedAt: opts.at } : {}),
    };
  }
  const edges: DocData["edges"] = {};
  for (const id of Object.keys(doc.edges)) {
    const e = doc.edges[id]!;
    const eid = R() < rate ? fakeId(R, "e") : id;
    edges[eid] = { ...e, id: eid, source: nodeMap.get(e.source) ?? e.source, target: nodeMap.get(e.target) ?? e.target, scenarioIds: mapS(e.scenarioIds), ...(opts.at ? { createdAt: opts.at, updatedAt: opts.at } : {}) };
  }
  const projects: DocData["projects"] = {};
  for (const id of Object.keys(doc.projects)) {
    const pid = pNew && id === opts.project ? pNew : id;
    projects[pid] = { ...doc.projects[id]!, id: pid };
  }
  const scenarios: DocData["scenarios"] = {};
  for (const id of Object.keys(doc.scenarios)) {
    const sid = sNew && id === opts.scenario ? sNew : id;
    scenarios[sid] = { ...doc.scenarios[id]!, id: sid };
  }
  return {
    ...doc,
    nodes,
    edges,
    projects,
    scenarios,
    projectOrder: doc.projectOrder.map((p) => (pNew && p === opts.project ? pNew : p)),
    scenarioOrder: doc.scenarioOrder.map((s) => (sNew && s === opts.scenario ? sNew : s)),
    meta: { ...doc.meta },
  };
}
