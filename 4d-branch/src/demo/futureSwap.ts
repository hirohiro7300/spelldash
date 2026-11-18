// 未来の道筋の差し替え: 文書に入っている未来の道筋（予測の入口から「進む」「条件付き」でたどれるノード）だけを消し、
// 新しい版を同じ場所（入口の位置をそろえる）に入れる。ほかのノード・プロジェクト・シナリオはそのまま（同じ名前はまとめる）

import { isForecastRoot } from "../model/forecast";
import { isFlowEdge, isImpactRoot } from "../model/forks";
import { isDisposableDoc } from "./demo";
import type { DocData, ID } from "../model/types";
import { mergeDocs } from "../persist/io";

export interface FutureMap {
  /** 予測の入口（「今日」）のノード */
  root: ID;
  /** 入口が持つ同梱データの版（古い版で読み込んだものは無い） */
  version: string | null;
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
    const v = n.meta.futureVersion;
    maps.push({ root: n.id, version: typeof v === "string" && v ? v : null, nodes });
  }
  return maps;
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

/** 新しい版と違う（または版の無い）未来の道筋があるか */
export function staleFutureMaps(doc: DocData, version: string): FutureMap[] {
  return futureMaps(doc).filter((m) => m.version !== version);
}

/**
 * 未来の道筋を新しい版に差し替えた文書を作る（doc は変えない）。
 * 未来の道筋が無ければ、ふつうの追加と同じく右側に足す
 */
export function swapFutureDoc(doc: DocData, incoming: DocData): { doc: DocData; removed: number; added: number; root: ID | null; kept: number } {
  const maps = futureMaps(doc);
  const gone = new Set(maps.flatMap((m) => [...m.nodes]));
  const nodes: DocData["nodes"] = {};
  for (const [id, n] of Object.entries(doc.nodes)) if (!gone.has(id)) nodes[id] = n;
  const edges: DocData["edges"] = {};
  for (const [id, e] of Object.entries(doc.edges)) if (!gone.has(e.source) && !gone.has(e.target)) edges[id] = e;
  const base: DocData = { ...doc, nodes, edges };
  // 版が変わっても同じカードは同じ鍵（meta.key）を持つ。利用者が決めたこと（選んだ手・見送り・完了、やることのチェック、年収）は新しい版に引き継ぐ
  let kept = 0;
  const carried: DocData = { ...incoming, nodes: { ...incoming.nodes } };
  const oldByKey = new Map<string, DocData["nodes"][string]>();
  for (const id of gone) {
    const o = doc.nodes[id];
    const k = o?.meta?.key;
    if (o && typeof k === "string") oldByKey.set(k, o);
  }
  for (const [id, n] of Object.entries(incoming.nodes)) {
    const k = n.meta?.key;
    const o = typeof k === "string" ? oldByKey.get(k) : undefined;
    if (!o) continue;
    let next = n;
    if (o.status !== "open" && o.status !== n.status) next = { ...next, status: o.status };
    const met = new Set(o.conditions.filter((c) => c.met).map((c) => c.text));
    if (met.size && next.conditions.some((c) => met.has(c.text) && !c.met)) next = { ...next, conditions: next.conditions.map((c) => (met.has(c.text) ? { ...c, met: true } : c)) };
    const oi = o.meta?.impact as Record<string, unknown> | undefined;
    const ni = n.meta?.impact as Record<string, unknown> | undefined;
    if (oi && ni && (oi.annual !== undefined || oi.tail !== undefined)) {
      const impact = { ...ni, ...(oi.annual !== undefined ? { annual: oi.annual } : {}), ...(oi.tail !== undefined ? { tail: oi.tail } : {}) };
      next = { ...next, meta: { ...next.meta, impact } };
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
  // 地図の題名が古い版の題名のままなら、新しい版の題名にする（自分で付けた題名はそのまま）
  const out = OLD_FUTURE_TITLES.includes(res.doc.title) && incoming.title ? { ...res.doc, title: incoming.title } : res.doc;
  return { doc: out, removed: gone.size, added: res.added.nodes, root, kept };
}

/** 同梱の未来の道筋の、これまでの版の題名 */
const OLD_FUTURE_TITLES = ["未来の道筋（仕事・10 年）"];
