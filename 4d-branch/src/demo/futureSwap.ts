// 未来の道筋の差し替え。3 年の分かれ道（v2）どうしは、同じ地図を新しい版にする: 同梱のカード（meta.key のあるノード）だけを
// 鍵で合わせて文章と数字を新しくし、ID・利用者が決めたこと・書き換えた所・足したノードと線は残す。
// それより前の未来の道筋（v1）は、入口から「進む」「条件付き」でたどれるノードを消し、新しい版を同じ場所（入口の位置をそろえる）に入れる。
// どちらも、ほかのノード・プロジェクト・シナリオはそのまま（同じ名前はまとめる）

import { isForecastRoot } from "../model/forecast";
import { isFlowEdge, isImpactRoot, primaryImpactRoot } from "../model/forks";
import { newId } from "../model/ids";
import { isDisposableDoc } from "./demo";
import { edgeTextPrint, fnv36, impactTagsOf } from "./impact";
import type { Condition, DocData, GEdge, GNode, ID, Project, Scenario } from "../model/types";
import { mergeDocs, nameKey } from "../persist/io";

export interface FutureMap {
  /** 予測の入口（「今日」）のノード */
  root: ID;
  /** 入口が持つ同梱データの版（古い版で読み込んだものは無い） */
  version: string | null;
  /** 入口が持つ版の順番（順番を残す前に読み込んだものは無い） */
  release: number | null;
  /** 入口からたどれるノード（未来の道筋そのもの） */
  nodes: Set<ID>;
}

/** 文書に入っている未来の道筋（入口ごと） */
export function futureMaps(doc: DocData): FutureMap[] {
  const out = new Map<ID, ID[]>();
  for (const e of Object.values(doc.edges)) {
    if (e.relation !== "leads" && e.relation !== "condition") continue;
    out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
  }
  const maps: FutureMap[] = [];
  for (const n of Object.values(doc.nodes)) {
    if (!isForecastRoot(n)) continue;
    const nodes = new Set<ID>([n.id]);
    const stack = [n.id];
    while (stack.length) for (const t of out.get(stack.pop()!) ?? []) if (doc.nodes[t] && !nodes.has(t)) (nodes.add(t), stack.push(t));
    maps.push({ root: n.id, version: versionOf(n), release: releaseOf(n), nodes });
  }
  return maps;
}

const versionOf = (n: GNode): string | null => {
  const v = n.meta.futureVersion;
  return typeof v === "string" && v ? v : null;
};
const releaseOf = (n: GNode): number | null => {
  const r = n.meta.futureRelease;
  return typeof r === "number" && Number.isFinite(r) ? r : null;
};

/**
 * 地図の版を、このページの版（version・release）と比べる。old: 古い（新しい版にできる）・same: 同じ・newer: このページより新しい版で作った。
 * 版の順番があれば順番で比べる（指紋には前後が無い）。順番を残す前の地図は、指紋が違えば古い
 */
export function futureAge(m: Pick<FutureMap, "version" | "release">, version: string, release: number): "old" | "same" | "newer" {
  if (m.release !== null) return m.release < release ? "old" : m.release > release ? "newer" : "same";
  return m.version === version ? "same" : "old";
}

/** このページの版より古い（版の無い）未来の道筋 */
export function staleFutureMaps(doc: DocData, version: string, release: number): FutureMap[] {
  return futureMaps(doc).filter((m) => futureAge(m, version, release) === "old");
}

/** このページより新しい版で作った未来の道筋（このページでは差し替えない。ページを開き直せば新しい版で見られる） */
export function newerFutureMaps(doc: DocData, version: string, release: number): FutureMap[] {
  return futureMaps(doc).filter((m) => futureAge(m, version, release) === "newer");
}

/** 古い版の未来の道筋の入口があるか（入口だけを見る。軽いので、変更のたびに見てよい） */
export function hasStaleFuture(doc: DocData, version: string, release: number): boolean {
  for (const id in doc.nodes) {
    const n = doc.nodes[id]!;
    if (isForecastRoot(n) && futureAge({ version: versionOf(n), release: releaseOf(n) }, version, release) === "old") return true;
  }
  return false;
}

/** 文書に未来の道筋（今日の入口）があるか */
export function hasFutureRoot(doc: DocData): boolean {
  return Object.values(doc.nodes).some((n) => isForecastRoot(n));
}

/**
 * 文書の meta の印: この地図を自動で未来の道筋に入れ替えない（押せば開く）。未来の道筋を開く前の地図（「元に戻す」・
 * バックアップで戻した物）と、「デモを読み込む」「空にする」で選んで作った地図に付ける。同期で別の端末にも届くので、
 * どの端末でも開き直したときに入れ替えない
 */
export const NO_AUTO_FUTURE = "noAutoFuture";

/** 印を付けた写し（元の文書は変えない） */
export function withNoAutoFuture(doc: DocData): DocData {
  return { ...doc, meta: { ...doc.meta, [NO_AUTO_FUTURE]: true } };
}

/**
 * 文書の meta の印: 未来の道筋を一度に開いた直後の更新時刻。これと文書の更新時刻が同じ間は、開いてから何も手を付けていない
 * （編集・元に戻す・やり直すで時刻が進むと外れる）。その間にアカウントで別の端末の内容と重なったら、こちらを送らずに
 * 別の端末の内容を読み込む（開いたばかりの未来の道筋は押せばまた開けるが、別の端末で書いた内容は書き直せない）
 */
export const FRESH_FUTURE = "freshFutureAt";

/** 開いてから何も手を付けていない未来の道筋か（開いた入れ替えを元に戻した・やり直しただけの地図も） */
export function isFreshFuture(doc: DocData): boolean {
  const at = doc.meta?.[FRESH_FUTURE];
  return typeof at === "string" && at === doc.updatedAt;
}

/**
 * アカウントで重なったとき、手元を送らずに相手（remote）を読み込むか。手元が手を付けていない中身のときだけ譲る。
 * ただし手元が、未来の道筋を開いた入れ替えを元に戻しただけの地図（開くのを断った）なら、次の相手には譲らない:
 * - 相手も開いたばかりの未来の道筋（断ったことを、別の端末が自動で開いた地図で上書きしない。相手の地図は押せばまた開ける）
 * - 相手が、断った印の無い捨ててよい中身（ノードを動かしただけのデモ・空）。譲ると断った印が消え、その端末が次に開いたとき
 *   自動で開いてしまう（動かしただけの中身は、重なりのバックアップに残る）
 */
export function yieldsToRemote(local: DocData, remote: DocData): boolean {
  if (!isFreshFuture(local)) return false;
  if (hasFutureRoot(local)) return true;
  if (isFreshFuture(remote) && hasFutureRoot(remote)) return false;
  return !(local.meta?.[NO_AUTO_FUTURE] === true && remote.meta?.[NO_AUTO_FUTURE] !== true && !hasFutureRoot(remote) && isDisposableDoc(remote));
}

/** 未来の道筋の入口に寄るときの、いちばん引いた大きさ（これより小さいとカードの文字が出ない。狭い画面では左端の今日から見せる） */
export const FUTURE_MIN_ZOOM = 0.3;

/**
 * 未来の道筋の入口（今日）から右へ 5 列・上下 600 までのノード（ids の中から）。全体は横に長すぎて読めないので、
 * 読み込んだ・開いたときはここに寄る（カードの文字が読める大きさで始める）。入口が無ければ ids をそのまま返す。
 * 3 年の分かれ道（v2）は、入口とその選択肢（ids の中から）。見えている物だけで寄せ、左上にそろえて 45% より引かない（CanvasView.fit）
 */
export function nearFutureRoot(doc: DocData, ids: ID[] = Object.keys(doc.nodes)): ID[] {
  const root = ids.map((id) => doc.nodes[id]).find((n) => n !== undefined && isForecastRoot(n));
  if (!root) return ids;
  if (isImpactRoot(root)) {
    const set = new Set(ids);
    const kids: ID[] = [];
    for (const e of Object.values(doc.edges)) if (e.source === root.id && e.target !== root.id && isFlowEdge(e) && set.has(e.target) && doc.nodes[e.target] && !kids.includes(e.target)) kids.push(e.target);
    return [root.id, ...kids];
  }
  const near = ids.filter((id) => {
    const n = doc.nodes[id];
    return !!n && n.x >= root.x && n.x <= root.x + 5 * 300 && Math.abs(n.y - root.y) <= 600;
  });
  return near.length ? near : [root.id];
}

/** 差し替えた結果 */
export interface FutureSwap {
  doc: DocData;
  /** 消したノード（新しい版に無くなったカード・ほかの地図。入れ替えたときは古い地図の全部） */
  removed: number;
  /** 足したノード（新しい版で増えたカード。入れ替えたときは新しい版の全部） */
  added: number;
  /** 新しい版の入口（同じ地図を新しい版にしたときは、もとの入口の ID のまま） */
  root: ID | null;
  /** 利用者が決めた・書き換えた物を引き継いだカードと線（選んだ手・見送り・チェック・年収・文章・見込み） */
  kept: number;
  /** 文章か数字が新しくなったカード（同じ地図を新しい版にしたときだけ数える） */
  updated: number;
  /** 地図につながったまま残った、利用者が足したノード（同じ地図を新しい版にしたときだけ数える） */
  userKept: number;
  /** 同じ地図を新しい版にした（false: 古い地図を消して入れ替えた・地図が無いので足した） */
  inPlace: boolean;
}

/** 版が変わっても同じカードを指す鍵（同梱のカードだけが持つ） */
const keyOf = (n: GNode | undefined): string | null => {
  const k = n?.meta?.key;
  return typeof k === "string" ? k : null;
};

/**
 * 同じ地図を新しい版にできるなら、その入口（数字と概要を出す v2 の入口）。入口と新しい版の入口が同じ鍵を持つときだけ。
 * incoming を渡さなければ文書の側だけで決める（同梱の新しい版の入口は、いつも鍵を持つ）
 */
export function inPlaceRoot(doc: DocData, incoming?: DocData): ID | null {
  const p = primaryImpactRoot(doc);
  const k = p === null ? null : keyOf(doc.nodes[p]);
  if (p === null || k === null) return null;
  if (incoming) {
    const r = Object.values(incoming.nodes).find(isForecastRoot);
    if (!r || !isImpactRoot(r) || keyOf(r) !== k) return null;
  }
  return p;
}

/**
 * 入口（root）の地図に、書き換えを見分ける指紋（t0 など）が付いているか。このアプリで読み込んだ地図には付く。
 * 前の版のアプリで読み込んだ地図には無く、新しい版にすると、自分で書き換えた見込み（%）・文章・やることも新しい版の物になる
 */
export function hasEditPrints(doc: DocData, root: ID): boolean {
  return typeof doc.nodes[root]?.meta.t0 === "string";
}

/**
 * 未来の道筋を新しい版にした文書を作る（doc は変えない）。数字と概要を出す v2 の入口と新しい版の入口が同じ鍵を持てば、
 * 同じ地図を新しい版にする（upgradeFuture）。そうでなければ（v1 の地図など）古い地図を消して入れ替える。
 * 未来の道筋が無ければ、ふつうの追加と同じく右側に足す
 */
export function swapFutureDoc(doc: DocData, incoming: DocData): FutureSwap {
  const maps = futureMaps(doc);
  const root = inPlaceRoot(doc, incoming);
  return root !== null ? upgradeFuture(doc, incoming, maps, root) : replaceFuture(doc, incoming, maps);
}

type Salary = { annual?: unknown; tail?: unknown };

/** 年収と 36 か月の後に足す月数: 数字と概要を出す入口の物（入口が 2 つ以上あっても、画面に出ている物を引き継ぐ） */
function salaryOf(doc: DocData): Salary | null {
  const id = primaryImpactRoot(doc);
  const imp = id === null ? undefined : doc.nodes[id]?.meta.impact;
  if (!imp || typeof imp !== "object") return null;
  const { annual, tail } = imp as Salary;
  if (annual === undefined && tail === undefined) return null;
  return { ...(annual !== undefined ? { annual } : {}), ...(tail !== undefined ? { tail } : {}) };
}

/** 入口の meta に年収を入れた物（入口でなければそのまま） */
function withSalary(meta: GNode["meta"], salary: Salary | null): GNode["meta"] {
  const ni = meta.impact;
  return salary && ni && typeof ni === "object" ? { ...meta, impact: { ...(ni as Record<string, unknown>), ...salary } } : meta;
}

/** 古い地図（入口からたどれるノード）を消して、新しい版を同じ場所に入れる（v1 の地図など、鍵で合わせられないとき） */
function replaceFuture(doc: DocData, incoming: DocData, maps: FutureMap[]): FutureSwap {
  const gone = new Set(maps.flatMap((m) => [...m.nodes]));
  const nodes: DocData["nodes"] = {};
  for (const [id, n] of Object.entries(doc.nodes)) if (!gone.has(id)) nodes[id] = n;
  const edges: DocData["edges"] = {};
  for (const [id, e] of Object.entries(doc.edges)) if (!gone.has(e.source) && !gone.has(e.target)) edges[id] = e;
  const base: DocData = { ...doc, nodes, edges };
  // 版が変わっても同じカードは同じ鍵（meta.key）を持つ。利用者が決めたこと（選んだ手・見送り・完了、やることのチェック）は新しい版に引き継ぐ。
  // 年収は、数字と概要を出す入口の物を引き継ぐ
  let kept = 0;
  const carried: DocData = { ...incoming, nodes: { ...incoming.nodes } };
  const oldByKey = new Map<string, GNode>();
  for (const id of gone) {
    const o = doc.nodes[id];
    const k = keyOf(o);
    if (o && k !== null) oldByKey.set(k, o);
  }
  const salary = salaryOf(doc);
  for (const [id, n] of Object.entries(incoming.nodes)) {
    const k = keyOf(n);
    const o = k === null ? undefined : oldByKey.get(k);
    let next = n;
    if (o && o.status !== "open" && o.status !== n.status) next = { ...next, status: o.status };
    const met = new Set(o ? o.conditions.filter((c) => c.met).map((c) => c.text) : []);
    if (met.size && next.conditions.some((c) => met.has(c.text) && !c.met)) next = { ...next, conditions: next.conditions.map((c) => (met.has(c.text) ? { ...c, met: true } : c)) };
    if (isForecastRoot(n)) {
      const meta = withSalary(next.meta, salary);
      if (meta !== next.meta) next = { ...next, meta };
    }
    if (next !== n) {
      carried.nodes[id] = next;
      kept++;
    }
  }
  const oldRoot = maps.length ? doc.nodes[maps[0]!.root] : undefined;
  const newRoot = Object.values(carried.nodes).find(isForecastRoot);
  const offset = oldRoot && newRoot ? { dx: oldRoot.x - newRoot.x, dy: oldRoot.y - newRoot.y } : undefined;
  const before = new Set(Object.keys(base.nodes));
  const res = mergeDocs(base, carried, offset ? { offset } : {});
  const root = Object.values(res.doc.nodes).find((n) => !before.has(n.id) && isForecastRoot(n))?.id ?? null;
  return { doc: withFutureTitle(res.doc, incoming), removed: gone.size, added: res.added.nodes, root, kept, updated: 0, userKept: 0, inPlace: false };
}

/**
 * 同じ地図を新しい版にする（rootId: 数字と概要を出す v2 の入口）。入口から道の線でたどれる、鍵のあるノード（同梱のカード）だけを新しい版と鍵で合わせる:
 * - 合うカードは ID と作った時刻をそのままに、新しい版の文章と数字にする。利用者の物は残す（選んだ手・見送り・やることのチェック・年収・
 *   書き換えたタイトルと本文・付けたタグ・足した・書き換えたやること）
 * - 新しい版に無くなったカードは線ごと消す（その下に利用者が足したノードは、つながりの無いノードとして残る）。新しい版で増えたカードは足す
 * - カードどうしの道の線は（元の鍵・先の鍵）で合わせ、線の ID をそのままに新しい版の説明・条件・見込みにする（直した見込み・書き換えた説明と条件は残す）
 * - 鍵の無いノード（利用者が足した物）と、それにつながる線・道でない線は消さない
 * ほかの地図（v1 の地図・数字を出さない 2 つ目の入口）は、今までどおり消す（この地図からたどれるノードは残す）
 */
function upgradeFuture(doc: DocData, incoming: DocData, maps: FutureMap[], rootId: ID): FutureSwap {
  // 今の地図: 入口から道の線でたどる（入口に近い順）
  const flowOut = new Map<ID, GEdge[]>();
  for (const e of Object.values(doc.edges)) {
    if (!isFlowEdge(e) || !doc.nodes[e.target]) continue;
    const list = flowOut.get(e.source);
    if (list) list.push(e);
    else flowOut.set(e.source, [e]);
  }
  const depth = new Map<ID, number>([[rootId, 0]]);
  const order: ID[] = [rootId];
  for (let i = 0; i < order.length; i++) {
    const d = depth.get(order[i]!)! + 1;
    for (const e of flowOut.get(order[i]!) ?? []) {
      if (depth.has(e.target)) continue;
      depth.set(e.target, d);
      order.push(e.target);
    }
  }
  // 同梱のカード（鍵ごとに 1 つ）。複製などで同じ鍵が 2 つ以上あれば、先に作った物（複製は作った時刻が後になる。同じなら入口に近い物・ID の順）。
  // 入口の鍵は数字と概要を出す入口に決める。ほかは利用者のノードとして残す
  const oldRoot = doc.nodes[rootId]!;
  const rootKey = keyOf(oldRoot);
  const oldByKey = new Map<string, GNode>();
  if (rootKey !== null) oldByKey.set(rootKey, oldRoot);
  for (const id of order) {
    const n = doc.nodes[id]!;
    const k = keyOf(n);
    if (k === null || k === rootKey) continue;
    const cur = oldByKey.get(k);
    if (!cur || madeFirst(n, cur, depth)) oldByKey.set(k, n);
  }
  const cards = new Set<ID>();
  for (const n of oldByKey.values()) cards.add(n.id);
  const inByKey = new Map<string, GNode>();
  for (const n of Object.values(incoming.nodes)) {
    const k = keyOf(n);
    if (k !== null) inByKey.set(k, n);
  }
  // 消す物: 新しい版に無くなったカードと、ほかの地図（この地図からたどれる物は除く）
  const gone = new Set<ID>();
  for (const [k, n] of oldByKey) if (!inByKey.has(k)) gone.add(n.id);
  for (const m of maps) if (m.root !== rootId) for (const id of m.nodes) if (!depth.has(id)) gone.add(id);

  // 同梱の線: カードどうしの道の線。指紋の付いた地図（t0 のある入口）では、指紋（c0）の無い線は利用者が引いた線として残す
  const marked = hasEditPrints(doc, rootId);
  const ownLine = (e: GEdge): boolean => marked && typeof e.meta?.c0 !== "string";
  const oldEdge = new Map<string, GEdge>();
  const bundleEdges = new Set<ID>();
  for (const e of Object.values(doc.edges)) {
    if (!isFlowEdge(e) || !cards.has(e.source) || !cards.has(e.target)) continue;
    if (!ownLine(e)) bundleEdges.add(e.id);
    const pk = pairKey(keyOf(doc.nodes[e.source])!, keyOf(doc.nodes[e.target])!);
    const cur = oldEdge.get(pk);
    if (!cur || (ownLine(cur) && !ownLine(e))) oldEdge.set(pk, e);
  }

  // 残す物: 同梱のカードと消す物を除いたノード、それにつながる線（同梱の線は除く）。利用者の線は、合うカードを指したまま残す
  // （合うカードはもとの ID のまま入れ直すので、つながりは切れない）
  const out: DocData = { ...doc, projects: { ...doc.projects }, scenarios: { ...doc.scenarios }, projectOrder: [...doc.projectOrder], scenarioOrder: [...doc.scenarioOrder], nodes: {}, edges: {}, meta: { ...doc.meta } };
  for (const [id, n] of Object.entries(doc.nodes)) if (!gone.has(id) && !cards.has(id)) out.nodes[id] = n;
  for (const [id, e] of Object.entries(doc.edges)) if (!gone.has(e.source) && !gone.has(e.target) && !bundleEdges.has(id)) out.edges[id] = e;
  // 新しい版を入れる: プロジェクト・シナリオは同じ名前の物にまとめ（mergeDocs と同じ）、入口の位置をそろえる。
  // カードは、合う物はもとの ID、増えた物は同梱の決まった ID（文書に同じ ID があれば振り直す）
  const pMap = adoptByName(out, incoming, "projects");
  const sMap = adoptByName(out, incoming, "scenarios");
  const newRoot = Object.values(incoming.nodes).find(isForecastRoot)!;
  const dx = oldRoot.x - newRoot.x;
  const dy = oldRoot.y - newRoot.y;
  const idOf = new Map<ID, ID>();
  for (const n of Object.values(incoming.nodes)) {
    const k = keyOf(n);
    const old = k === null ? undefined : oldByKey.get(k);
    idOf.set(n.id, old ? old.id : doc.nodes[n.id] ? newId("n") : n.id);
  }
  const salary = salaryOf(doc);
  let kept = 0;
  let fresh = 0;
  const updated = new Set<ID>();
  for (const n of Object.values(incoming.nodes)) {
    const id = idOf.get(n.id)!;
    const next: GNode = { ...n, id, x: n.x + dx, y: n.y + dy, projectIds: mapIds(n.projectIds, pMap), scenarioIds: mapIds(n.scenarioIds, sMap) };
    const k = keyOf(n);
    const old = k === null ? undefined : oldByKey.get(k);
    if (!old) {
      out.nodes[id] = next;
      fresh++;
      continue;
    }
    const r = upgradeNode(next, old, id === rootId ? salary : null);
    out.nodes[id] = r.node;
    if (r.kept) kept++;
    if (r.updated) updated.add(id);
  }
  // 線: 合う物はもとの ID（直した見込み・書き換えた説明と条件は残す）。増えた物は新しい ID（同梱の線の ID は版ごとに違う）
  const usedOld = new Set<ID>();
  for (const e of Object.values(incoming.edges)) {
    const source = idOf.get(e.source);
    const target = idOf.get(e.target);
    if (!source || !target) continue;
    const next: GEdge = { ...e, source, target, scenarioIds: mapIds(e.scenarioIds, sMap) };
    const sk = keyOf(out.nodes[source]);
    const tk = keyOf(out.nodes[target]);
    const old = sk !== null && tk !== null ? oldEdge.get(pairKey(sk, tk)) : undefined;
    if (old && !usedOld.has(old.id) && old.source === source && old.target === target) {
      usedOld.add(old.id);
      const r = upgradeEdge(next, old);
      out.edges[old.id] = r.edge;
      if (r.kept) kept++;
      if (r.updated) updated.add(target);
    } else {
      const id = newId("e");
      out.edges[id] = { ...next, id };
      // 新しい版で別のカードの下に移った
      if (cards.has(target)) updated.add(target);
    }
  }
  // 地図につながったまま残った、利用者のノード（鍵の無いノード・同じ鍵の 2 つ目）
  const after = flowReach(out, rootId);
  let userKept = 0;
  for (const id of order) if (!cards.has(id) && after.has(id)) userKept++;
  return { doc: withFutureTitle(out, incoming), removed: gone.size, added: fresh, root: rootId, kept, updated: updated.size, userKept, inPlace: true };
}

/** 線の（元の鍵・先の鍵） */
const pairKey = (source: string, target: string): string => `${source}\u0000${target}`;

/** 同じ鍵のカードのうち、a を b より先の物（同梱のカード）とみるか: 先に作った物、同じ時刻なら入口に近い物、それも同じなら ID の順 */
function madeFirst(a: GNode, b: GNode, depth: Map<ID, number>): boolean {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt;
  const da = depth.get(a.id)!;
  const db = depth.get(b.id)!;
  return da !== db ? da < db : a.id < b.id;
}

/** 取り込む側の ID を文書の ID に（合わない物は外す） */
const mapIds = (ids: ID[], map: Map<ID, ID>): ID[] => ids.map((id) => map.get(id)).filter((id): id is ID => !!id);

/** 取り込む側のプロジェクト・シナリオを、out の同じ名前の物に合わせる（無ければ足す。mergeDocs と同じ決め方）。取り込む側の ID → out の ID */
function adoptByName(out: DocData, incoming: DocData, kind: "projects" | "scenarios"): Map<ID, ID> {
  const have: Record<ID, Project | Scenario> = out[kind];
  const order = kind === "projects" ? out.projectOrder : out.scenarioOrder;
  const byName = new Map<string, ID>();
  for (const g of Object.values(have)) if (!byName.has(nameKey(g.name))) byName.set(nameKey(g.name), g.id);
  const map = new Map<ID, ID>();
  for (const id of kind === "projects" ? incoming.projectOrder : incoming.scenarioOrder) {
    const g: Project | Scenario | undefined = incoming[kind][id];
    if (!g) continue;
    let to = byName.get(nameKey(g.name));
    if (!to) {
      to = newId(kind === "projects" ? "p" : "s");
      have[to] = { ...g, id: to };
      order.push(to);
      byName.set(nameKey(g.name), to);
    }
    map.set(id, to);
  }
  return map;
}

/** 指紋（print）と合わなければ、利用者が書き換えた文（指紋の無い古い地図は、書き換えていないとみなす） */
const edited = (text: string, print: unknown): boolean => typeof print === "string" && fnv36(text) !== print;

/**
 * 合ったカードを新しい版にする（next: 新しい版のカード。ID はもとの物）。利用者の物は old から残す:
 * 選んだ手・見送り・完了、やることのチェック・足した項目・書き換えた項目（upgradeTodo）、書き換えたタイトル・本文、
 * 付けたタグ（前の版で同梱データから付いたタグ＝カードの役割と月から決まる物でも、新しい版で付くタグでもない物。
 * 月が変わって付かなくなった役割のタグは外す）、カードのシナリオ・折りたたみ、入口なら年収（salary）。
 * 指紋（t0・b0・k0）は新しい版の物のまま（書き換えた文は、次の版でも書き換えたと分かる）
 */
function upgradeNode(next: GNode, old: GNode, salary: Salary | null): { node: GNode; kept: boolean; updated: boolean } {
  const title = edited(old.title, old.meta.t0) ? old.title : next.title;
  const body = edited(old.body, old.meta.b0) ? old.body : next.body;
  const status = old.status !== "open" ? old.status : next.status;
  const todo = upgradeTodo(next.conditions, old.conditions, todoPrints(old));
  const conditions = todo.list;
  const given = new Set([...impactTagsOf(old.meta), ...next.tags]);
  const own = old.tags.filter((t) => !given.has(t));
  const tags = own.length ? [...next.tags, ...own] : next.tags;
  const meta = withSalary(next.meta, salary);
  const node: GNode = { ...next, title, body, status, conditions, tags, meta, scenarioIds: old.scenarioIds, collapsed: old.collapsed, createdAt: old.createdAt };
  const kept = title !== next.title || body !== next.body || status !== next.status || todo.kept || own.length > 0 || meta !== next.meta;
  // 文章か数字が変わった（期限・位置・版の印・指紋は数えない）
  const updated =
    title !== old.title ||
    body !== old.body ||
    node.type !== old.type ||
    !sameList(conditions.map((c) => c.text), old.conditions.map((c) => c.text)) ||
    !sameList(tags, old.tags) ||
    !sameList(node.projectIds, old.projectIds) ||
    !sameMeta(meta, old.meta);
  if (!updated) node.updatedAt = old.updatedAt;
  return { node, kept, updated };
}

/**
 * カードのやることの、同梱の項目の指紋（k0: 今の版の項目ごと）。指紋の付いたカードで k0 が無ければ、同梱の項目は無い。
 * 指紋の無いカード（前の版のアプリで読み込んだ地図）は null（利用者が足した項目と見分けられない）
 */
function todoPrints(n: GNode): Set<string> | null {
  const k0 = n.meta.k0;
  if (Array.isArray(k0)) return new Set(k0.filter((p): p is string => typeof p === "string"));
  return typeof n.meta.t0 === "string" ? new Set() : null;
}

/**
 * 合ったカードのやることを新しい版にする（next: 新しい版の項目・old: 今の項目・base: 今の版の同梱の項目の指紋）:
 * - 項目は新しい版の物。同じ文の項目は、チェックともとの ID を残す
 * - 利用者が足した・書き換えた項目（同梱の項目の指紋に無い文）は、前にあった項目の後ろに、チェックごと残す
 * - 利用者が消した・書き換えた同梱の項目（指紋はあるのに今のカードに無い文）は、新しい版でも戻さない
 * - 指紋の無いカードは、項目は新しい版の物だけにして、同じ文の項目のチェックを残す
 * ID はカードの中で重ならないようにする（残す項目のもとの ID を先に押さえ、新しい版の ID がそれと重なれば振り直す）
 */
function upgradeTodo(next: Condition[], old: Condition[], base: Set<string> | null): { list: Condition[]; kept: boolean } {
  // 今の項目が無く、利用者が消した同梱の項目も無い（ほとんどのカード）: 新しい版の項目のまま
  if (!old.length && !base?.size) return { list: next, kept: false };
  const own = (c: Condition): boolean => base !== null && !base.has(fnv36(c.text));
  let items = next;
  if (base !== null) {
    const have = new Set(old.map((c) => fnv36(c.text)));
    items = next.filter((c) => {
      const p = fnv36(c.text);
      return !base.has(p) || have.has(p);
    });
  }
  // 今の項目を文ごとに（新しい版の同じ文の項目が、前から順に 1 つずつ受け継ぐ）。同じ文の項目のどれかに付いたチェックは残す
  const byText = new Map<string, Condition[]>();
  const met = new Set<string>();
  for (const c of old) {
    const q = byText.get(c.text);
    if (q) q.push(c);
    else byText.set(c.text, [c]);
    if (c.met) met.add(c.text);
  }
  // 新しい版に無い、利用者の項目: すぐ前にあった項目（新しい版にもある物）の後ろに置く。先頭にあった物は先頭、
  // すぐ前の同梱の項目が新しい版で無くなった物は最後
  const texts = new Set(items.map((c) => c.text));
  const head: Condition[] = [];
  const tail: Condition[] = [];
  const after = new Map<string, Condition[]>();
  let anchor: string | null = null;
  let top = true;
  for (const c of old) {
    if (texts.has(c.text)) {
      anchor = c.text;
      top = false;
    } else if (!own(c)) {
      anchor = null;
      top = false;
    } else if (anchor !== null) after.set(anchor, [...(after.get(anchor) ?? []), c]);
    else (top ? head : tail).push(c);
  }
  const slots: Array<{ c: Condition; from: Condition | undefined }> = head.map((c) => ({ c, from: c }));
  for (const c of items) {
    slots.push({ c, from: byText.get(c.text)?.shift() });
    const follow = after.get(c.text);
    if (follow) {
      for (const t of follow) slots.push({ c: t, from: t });
      after.delete(c.text);
    }
  }
  for (const c of tail) slots.push({ c, from: c });
  const reserved = new Set<ID>();
  for (const s of slots) if (s.from) reserved.add(s.from.id);
  const used = new Set<ID>();
  let kept = false;
  const list = slots.map(({ c, from }) => {
    let id = from ? from.id : reserved.has(c.id) ? "" : c.id;
    if (!id || used.has(id)) id = newId("c");
    used.add(id);
    if (from === c) {
      // 利用者の項目（そのまま）
      kept = true;
      return id === c.id ? c : { ...c, id };
    }
    const on = c.met || met.has(c.text);
    if (on && !c.met) kept = true;
    return id === c.id && on === c.met ? c : { ...c, id, met: on };
  });
  return { list, kept };
}

/**
 * 合った線を新しい版にする（next: 新しい版の線。両端はもとのカード）。直した見込み（元の見込み p0 と違う %）と、
 * 書き換えた説明・条件（指紋 c0 と合わない物）は残す。元の見込みと指紋は新しい版の物のまま
 */
function upgradeEdge(next: GEdge, old: GEdge): { edge: GEdge; kept: boolean; updated: boolean } {
  let meta = next.meta;
  const p0 = old.meta?.p0;
  if (typeof p0 === "number" && old.meta.prob !== p0 && typeof next.meta.p0 === "number") {
    meta = { ...meta };
    if (old.meta.prob === undefined) delete meta.prob;
    else meta.prob = old.meta.prob;
  }
  const own = typeof old.meta?.c0 === "string" && edgeTextPrint(old.label, old.condition) !== old.meta.c0;
  const label = own ? old.label : next.label;
  const condition = own ? old.condition : next.condition;
  const edge: GEdge = { ...next, id: old.id, label, condition, meta, collapsed: old.collapsed, createdAt: old.createdAt };
  const kept = meta.prob !== next.meta.prob || label !== next.label || condition !== next.condition;
  const updated =
    label !== old.label ||
    condition !== old.condition ||
    edge.relation !== old.relation ||
    !sameList(edge.scenarioIds, old.scenarioIds) ||
    !sameMeta(meta, old.meta);
  if (!updated) edge.updatedAt = old.updatedAt;
  return { edge, kept, updated };
}

/** 比べるときに外す meta: 版の印と指紋 */
const PRINT_KEYS = new Set(["t0", "b0", "k0", "p0", "c0", "futureVersion", "futureRelease"]);

/** meta の中身が同じか（版の印と指紋は比べない。鍵の順は問わない） */
function sameMeta(a: GNode["meta"], b: GNode["meta"]): boolean {
  let n = 0;
  for (const k of Object.keys(a)) {
    if (PRINT_KEYS.has(k)) continue;
    n++;
    if (!Object.hasOwn(b, k) || !sameValue(a[k], b[k])) return false;
  }
  for (const k of Object.keys(b)) if (!PRINT_KEYS.has(k)) n--;
  return n === 0;
}

/** JSON の値として同じか（鍵の順は問わない） */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  const ka = Object.keys(a);
  const o = b as Record<string, unknown>;
  return ka.length === Object.keys(o).length && ka.every((k) => Object.hasOwn(o, k) && sameValue((a as Record<string, unknown>)[k], o[k]));
}

const sameList = <T>(a: readonly T[], b: readonly T[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** 入口から道の線でたどれるノード */
function flowReach(doc: DocData, root: ID): Set<ID> {
  const out = new Map<ID, ID[]>();
  for (const e of Object.values(doc.edges)) {
    if (!isFlowEdge(e)) continue;
    const list = out.get(e.source);
    if (list) list.push(e.target);
    else out.set(e.source, [e.target]);
  }
  const seen = new Set<ID>([root]);
  const stack = [root];
  while (stack.length) for (const t of out.get(stack.pop()!) ?? []) if (doc.nodes[t] && !seen.has(t)) (seen.add(t), stack.push(t));
  return seen;
}

/** 地図の題名が古い版の題名のままなら、新しい版の題名にする（自分で付けた題名はそのまま） */
function withFutureTitle(doc: DocData, incoming: DocData): DocData {
  return OLD_FUTURE_TITLES.includes(doc.title) && incoming.title ? { ...doc, title: incoming.title } : doc;
}

/** 同梱の未来の道筋の、これまでの版の題名 */
const OLD_FUTURE_TITLES = ["未来の道筋（仕事・10 年）"];
