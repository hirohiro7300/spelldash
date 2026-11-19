// 版 6 までの地図（太い形の「3 年の分かれ道」）を、ページの 3 か月ごとの地図（版 7 から）へ読むときに引き上げる。
// 設計: 作業メモ SPEC v1 §8（D11）・見直し safety-1・safety-13・user-6・gaps-14。呼ぶ口は保存の口（./codec.ts の decodeStored）と、
// 地図を新しい版にする差し替え（src/demo/futureSwap.ts の swapFutureDoc。ページの地図にするときだけ）。
//
// 保存してあった文書（版 1 を整えた物）とページの地図だけから決まる（乱数・今の時刻を使わない。どの端末でも同じ文書になる）。
// 文書の id と updatedAt は変えない（どの端末も「新しい版にした」を変更として送らない。アカウントにはどの道具も書かない: safety-13）。
// 次に保存するとき、ページの地図を持つ文書として薄い形で書く。
//   - 鍵がページの地図にもあるカード（今日・最初の 10 の手・3 か月後の状態）: ページの地図のカードに、利用者の物を当てる（ID はそのまま）
//   - 3 か月後の手 r.<手>.<結果>.<種類>: 同じ状態の、最初の 3 か月（3 か月目に選ぶ）の同じ種類の手へ移す（鍵の読み替え。
//     版 7 では 84 枚のうち 55 枚にある）。状態・チェック・書き換えた所も一緒に移す（ID はそのまま）
//   - ほかの、利用者の物を持つカード: 鍵の無い利用者のカードにして「前の版で決めたこと」（今日の左）に残す。題名・本文・状態・
//     やること・タグ・期限・利用者の線はそのまま（ID もそのまま）。直した見込み・線の説明は meta.prevEdge に
//   - 利用者の物を持たないカードと、地図のカードどうしの同梱の線は、ページの地図の物になる（直した見込み・説明は、残った線に当てる）
//   利用者の物: 未着手でない状態・チェックしたやること・書き換えた題名・本文・やること（指紋 t0・b0・k0 と違う）・付けたタグ・
//   直した見込みと線の説明（p0・c0 と違う）・利用者の meta・利用者の線（利用者のカード・ほかのカードへの線）・
//   直した期限・開始・種類・プロジェクト・シナリオ（版 6 の組み立ての決まりと違う: r6Rules。見直し loss-3）

import { anchorMonthStart } from "../demo/quarterDoc";
import { edgeTextPrint, fnv36, fnv64x36, impactEdgeId64, impactNodeId64, impactTagsOf } from "../demo/impact";
import { isFlowEdge, isImpactRoot, primaryImpactRoot } from "../model/forks";
import { normalizeDoc } from "../model/schema";
import type { Condition, DocData, GEdge, GNode, ID, Meta, NodeStatus } from "../model/types";
import { madeFirst } from "./keyedCards";
import {
  BUILDER_EDGE_META,
  BUILDER_NODE_META,
  carryRoot,
  holdsPageMap,
  looseIdMap,
  pageMapAccess,
  pageRelease,
  pageRootKey,
  prevColumnX,
  prevGroupCard,
  PREV_ROW,
  type CardCounts,
  type MapBase,
  type PageMapAccess,
  type ThinUpgradeInfo,
} from "./thinMap";

// ---------------------------------------------------------------- 利用者の物

/** 太い形の地図のカードに、利用者が入れた物（新しい版にするとき、引き継ぐか別のカードに残すかを決める） */
export interface FatCardState {
  /** 未着手でない状態（選んだ・済み・見送った） */
  status: NodeStatus | null;
  /** チェックしたやることの数 */
  ticks: number;
  /** 題名・本文を書き換えた（指紋 t0・b0 と違う） */
  title: boolean;
  body: boolean;
  /** やることを足した・消した・書き換えた（同梱の項目の指紋 k0 と違う） */
  todo: boolean;
  /** 付けたタグ（役割と月から付いたタグでない物） */
  tags: string[];
  /** 利用者の meta の名前（組み立てが作る meta でない物） */
  meta: string[];
  /** 親からの同梱の線の見込み・説明・条件を直した */
  edge: boolean;
  /** 利用者の線（利用者のカード・ほかのカードへの線）の数 */
  links: number;
  /**
   * 版 6 の組み立ての決まりと違う項目（利用者が直した期限 due・開始 start・種類 type・プロジェクト projects・シナリオ scenarios: loss-3）。
   * 決まりは文書から多数決で決める（r6Rules）。決まりを渡さなければ空
   */
  fields: string[];
}

// ---------------------------------------------------------------- 版 6 の組み立ての決まり（期限・開始・種類・プロジェクト・シナリオ）

/**
 * 版 6 までの組み立て（src/demo/impact.ts の buildImpactDoc。版 1〜6 で同じ決まり）が、手を入れていないカードに付けた値を、文書から決める
 * （版 6 の同梱データはページに無いので、地図のカードの多数決で: 見直し loss-3）:
 *   期限・開始: 地図を読み込んだ日 today から、月の数で（今日の期限と最初の手の開始は today、ほかは月末: monthDate）。
 *     today の年月は、カードの月 meta.m と期限・開始の年月の差の多数決。日付は、今日の期限と最初の手の開始の多数決
 *   種類: 今日 goal・手 action・状態 branch・行き先 result
 *   プロジェクト: 今日・状態・行き先は全部の領域（多数決で決めた組）、手は種類ごとの組（多数決。決まらなければ、全部の組か領域 1 つなら直していない）
 *   シナリオ: カードは無し
 */
export interface R6Rules {
  /** 地図を読み込んだ年月（年 × 12 ＋ 月 − 1。決まらなければ null） */
  ym0: number | null;
  /** 地図を読み込んだ日（"YYYY-MM-DD"。決まらなければ null） */
  d0: string | null;
  /** 全部の領域のプロジェクトの組（並べて "\u0000" でつないだ物。決まらなければ null）と、その ID */
  all: string | null;
  allSet: ReadonlySet<string>;
  /** 手の種類ごとのプロジェクトの組（はっきり多数の物だけ） */
  byKind: ReadonlyMap<string, string>;
  /** 鍵 → その子のカードの月（手の期限は、子の月の月末） */
  childMonth: ReadonlyMap<string, number>;
}

const setKey = (ids: readonly string[]): string => [...ids].sort().join("\u0000");

/** はっきり多数（半分より多い）の物（無ければ null） */
function majority<T>(xs: readonly T[]): T | null {
  const count = new Map<T, number>();
  for (const x of xs) count.set(x, (count.get(x) ?? 0) + 1);
  for (const [x, c] of count) if (c * 2 > xs.length) return x;
  return null;
}

/** "YYYY-MM-DD" の年月（年 × 12 ＋ 月 − 1。読めなければ null） */
function ymOf(day: unknown): number | null {
  if (typeof day !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  return Number(m[1]) * 12 + Number(m[2]) - 1;
}

/** その月の日数（グレゴリオ暦。時計を使わない） */
function daysIn(y: number, m0: number): number {
  if (m0 === 1) return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28;
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m0]!;
}

/** 年月（年 × 12 ＋ 月 − 1）の月末（"YYYY-MM-DD"） */
function monthEnd(ym: number): string {
  const y = Math.floor(ym / 12);
  const m0 = ym - y * 12;
  return `${y}-${String(m0 + 1).padStart(2, "0")}-${String(daysIn(y, m0)).padStart(2, "0")}`;
}

/** 版 6 のカードの役割（今日 r・手 a・状態 s・行き先 e） */
function roleOf(meta: Meta): "r" | "a" | "s" | "e" {
  return meta.forecastRoot === true ? "r" : meta.end === true ? "e" : isStr(meta.ak) ? "a" : "s";
}

const ROLE_TYPE: Record<"r" | "a" | "s" | "e", string> = { r: "goal", a: "action", s: "branch", e: "result" };

/** 文書の版 6 の地図のカード（今日 root・鍵ごとのカード cards）から、組み立ての決まりを決める */
export function r6Rules(root: GNode, cards: ReadonlyMap<string, GNode>): R6Rules {
  const yms: number[] = [];
  const days: string[] = [];
  const allVotes: string[] = [];
  const kindVotes = new Map<string, string[]>();
  const childMonth = new Map<string, number>();
  if (isStr(root.time.due)) {
    days.push(root.time.due);
    const ym = ymOf(root.time.due);
    if (ym !== null) yms.push(ym);
  }
  allVotes.push(setKey(root.projectIds));
  for (const [k, c] of cards) {
    const meta = c.meta ?? {};
    const m = typeof meta.m === "number" && Number.isFinite(meta.m) ? meta.m : null;
    if (m === null) continue;
    const pk = k.slice(0, k.lastIndexOf("."));
    if (!childMonth.has(pk)) childMonth.set(pk, m);
    const role = roleOf(meta);
    if (role === "a") {
      const ym = ymOf(c.time.start);
      if (ym !== null) yms.push(ym - m);
      if (m <= 0 && isStr(c.time.start)) days.push(c.time.start);
      const kind = meta.ak as string;
      const list = kindVotes.get(kind) ?? [];
      list.push(setKey(c.projectIds));
      kindVotes.set(kind, list);
    } else {
      const ym = ymOf(c.time.due);
      if (ym !== null) yms.push(ym - m);
      allVotes.push(setKey(c.projectIds));
    }
  }
  const all = majority(allVotes);
  const byKind = new Map<string, string>();
  for (const [kind, list] of kindVotes) {
    const v = list.length >= 2 ? majority(list) : null;
    if (v !== null) byKind.set(kind, v);
  }
  return { ym0: majority(yms), d0: majority(days), all, allSet: new Set(all ? all.split("\u0000").filter(Boolean) : []), byKind, childMonth };
}

/** 版 6 の組み立ての決まりと違う項目（期限 due・開始 start・種類 type・プロジェクト projects・シナリオ scenarios）。今日は見ない */
export function r6FieldEdits(rules: R6Rules, key: string, card: GNode): string[] {
  const meta = card.meta ?? {};
  const role = roleOf(meta);
  if (role === "r") return [];
  const out: string[] = [];
  const m = typeof meta.m === "number" && Number.isFinite(meta.m) ? meta.m : null;
  if (rules.ym0 !== null && m !== null) {
    let due: string | null | undefined;
    let start: string | null | undefined;
    if (role === "a") {
      start = m <= 0 ? (rules.d0 ?? undefined) : monthEnd(rules.ym0 + m);
      const cm = rules.childMonth.get(key);
      due = cm === undefined ? undefined : monthEnd(rules.ym0 + cm);
    } else {
      due = monthEnd(rules.ym0 + m);
      start = null;
    }
    // 決まらない値（undefined）は比べない（直したと決めつけない）
    if (due !== undefined && card.time.due !== due) out.push("due");
    if (start !== undefined && card.time.start !== start) out.push("start");
  }
  if (card.type !== ROLE_TYPE[role]) out.push("type");
  const pk = setKey(card.projectIds);
  if (role === "a") {
    const want = rules.byKind.get(meta.ak as string);
    if (want !== undefined ? pk !== want : !(pk === rules.all || (card.projectIds.length === 1 && rules.allSet.has(card.projectIds[0]!)))) out.push("projects");
  } else if (rules.all !== null && pk !== rules.all) out.push("projects");
  if (card.scenarioIds.length) out.push("scenarios");
  return out;
}

/** 決まりの組（プロジェクト）を ID の並びに（決まらなければ null） */
function expectedProjects(rules: R6Rules, card: GNode): string[] | null {
  const meta = card.meta ?? {};
  const role = roleOf(meta);
  const key = role === "a" ? (rules.byKind.get(meta.ak as string) ?? null) : rules.all;
  return key === null ? null : key.split("\u0000").filter(Boolean);
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isObjMeta = (v: unknown): v is Meta => !!v && typeof v === "object" && !Array.isArray(v);
const isoOk = (s: unknown): s is string => typeof s === "string" && Number.isFinite(Date.parse(s));
const own = (o: object, k: string): boolean => Object.hasOwn(o, k);

/** 版 6 の組み立ての、親からの同梱の線の関係（手へは leads、状態・行き先へは condition）と違うか（利用者が関係を変えた） */
export function relationEdited(e: GEdge, child: GNode): boolean {
  return e.relation !== (isStr(child.meta?.ak) ? "leads" : "condition");
}

/** 同梱の線を利用者が直したか（元の見込み p0 と違う %・指紋 c0 と違う説明と条件・利用者の meta）。指紋の無い線は、見込みと文を直していないと見なす */
export function fatEdgeEdited(e: GEdge): boolean {
  const m = e.meta ?? {};
  if (typeof m.p0 === "number" && m.prob !== m.p0) return true;
  if (isStr(m.c0) && edgeTextPrint(e.label, e.condition) !== m.c0) return true;
  return Object.keys(m).some((k) => k !== "prob" && !BUILDER_EDGE_META.has(k));
}

/**
 * 太い形の地図のカードの、利用者の物（無ければ null）。inEdge: 親からの同梱の線・links: 利用者の線の数・fields: 版 6 の組み立ての決まりと
 * 違う項目（r6FieldEdits。期限・開始・種類・プロジェクト・シナリオ: loss-3）。
 * 指紋の無いカード（指紋を付ける前のアプリで読み込んだ地図）は、題名・本文・やることの書き換えを見分けられない（書き換えていないと見なす）
 */
export function fatCardState(card: GNode, inEdge: GEdge | undefined, links: number, fields: readonly string[] = []): FatCardState | null {
  const meta = card.meta ?? {};
  const printed = isStr(meta.t0);
  const status = card.status !== "open" ? card.status : null;
  let ticks = 0;
  for (const c of card.conditions) if (c.met) ticks++;
  const title = printed && fnv36(card.title) !== meta.t0;
  const body = isStr(meta.b0) && fnv36(card.body) !== meta.b0;
  let todo = false;
  const k0 = Array.isArray(meta.k0) ? (meta.k0 as unknown[]).filter(isStr) : printed ? [] : null;
  if (k0 !== null) {
    const left = [...k0];
    for (const c of card.conditions) {
      const j = left.indexOf(fnv36(c.text));
      if (j < 0) {
        todo = true;
        break;
      }
      left.splice(j, 1);
    }
    if (left.length) todo = true;
  }
  const given = new Set(impactTagsOf(meta));
  const tags = card.tags.filter((t) => !given.has(t));
  const userMeta = Object.keys(meta).filter((k) => !BUILDER_NODE_META.has(k));
  const edge = !!inEdge && fatEdgeEdited(inEdge);
  if (!status && !ticks && !title && !body && !todo && !tags.length && !userMeta.length && !edge && !links && !fields.length) return null;
  return { status, ticks, title, body, todo, tags, meta: userMeta, edge, links, fields: [...fields] };
}

/** カードの項目（状態・題名・本文・やること・タグ・meta・期限など）を変える物があるか（線だけ・線の見込みだけなら false） */
const changesCard = (st: FatCardState): boolean => !!st.status || st.ticks > 0 || st.title || st.body || st.todo || st.tags.length > 0 || st.meta.length > 0 || st.fields.length > 0;

export const zeroCounts = (): CardCounts => ({ cards: 0, picks: 0, drops: 0, ticks: 0, edits: 0, links: 0 });

/** 利用者の物を持つカードを数える（選んだ手・見送った手は状態で数え、そのほかのカードだけを、チェック・書き換え・線で数える） */
export function countCard(c: CardCounts, st: FatCardState): void {
  c.cards++;
  if (st.status === "active" || st.status === "done") {
    c.picks++;
    return;
  }
  if (st.status === "dropped") {
    c.drops++;
    return;
  }
  if (st.ticks) c.ticks++;
  if (st.title || st.body || st.todo || st.tags.length || st.meta.length || st.edge || st.fields.length) c.edits++;
  if (st.links) c.links++;
}

/**
 * 地図から無くなったカードを、鍵の無い利用者のカードにする（「前の版で決めたこと」の列に置く）。題名・本文・状態・やること・タグ・期限・
 * プロジェクト・シナリオ・時刻・ID はそのまま。組み立てが作る meta は外し、前の鍵・版・短い名前と、直した見込み・線の説明（prevEdge）を残す
 */
export function detachFatCard(c: GNode, key: string, st: FatCardState, inEdge: GEdge | undefined, from: number, x: number, y: number): GNode {
  const meta: Meta = { prevKey: key, prevRelease: from };
  if (isStr(c.meta?.short) && c.meta.short) meta.prevShort = c.meta.short;
  for (const k of st.meta) meta[k] = c.meta[k];
  if (st.edge && inEdge) {
    const m6 = inEdge.meta ?? {};
    const pe: Meta = {};
    if (typeof m6.p0 === "number" && m6.prob !== m6.p0) {
      pe.p0 = m6.p0;
      if (m6.prob !== undefined) pe.prob = m6.prob;
    }
    if (isStr(m6.c0) && edgeTextPrint(inEdge.label, inEdge.condition) !== m6.c0) {
      pe.label = inEdge.label;
      pe.condition = inEdge.condition;
    }
    for (const k of Object.keys(m6)) if (k !== "prob" && !BUILDER_EDGE_META.has(k)) pe[k] = m6[k];
    meta.prevEdge = pe;
  }
  // 関係を変えた線（別のカードには線が無いので、関係も残す）
  if (inEdge && relationEdited(inEdge, c)) meta.prevEdge = { ...(isObjMeta(meta.prevEdge) ? meta.prevEdge : {}), relation: inEdge.relation };
  return { ...c, x, y, meta };
}

/** 鍵を外したノード（同じ鍵の 2 つ目を利用者のノードとして残すとき。ページの地図のカードと取り違えない） */
function withoutKey(n: GNode): GNode {
  const { key: _key, ...meta } = n.meta;
  return { ...n, meta };
}

// ---------------------------------------------------------------- 版 6 までの地図の今日

/** 版 6 までの地図（太い形）の今日か（整える前の物でも見る: 3 年の分かれ道 v2 の入口で、地図の年月 anchor が無く、鍵がある） */
export function isLegacyRootRaw(n: unknown): boolean {
  if (!n || typeof n !== "object") return false;
  const m = (n as { meta?: unknown }).meta;
  if (!m || typeof m !== "object") return false;
  const meta = m as Record<string, unknown>;
  const imp = meta.impact;
  return meta.forecastRoot === true && !!imp && typeof imp === "object" && (imp as { v?: unknown }).v === 2 && typeof meta.anchor !== "string" && typeof meta.key === "string";
}

/** ページの地図（今日の鍵 rootKey・版の順番 release）に引き上げる、版 6 までの地図の今日か */
function isLegacyFor(n: GNode | undefined, rootKey: string, release: number): n is GNode {
  if (!n || !isImpactRoot(n) || isStr(n.meta.anchor) || n.meta.key !== rootKey) return false;
  const r = n.meta.futureRelease;
  return !(typeof r === "number" && Number.isFinite(r) && r >= release);
}

/** 文書の、ページの地図に引き上げる版 6 までの地図の今日（数字と概要を出す入口。無ければ null。ページの地図をもう持つ文書も null） */
export function legacyRootOf(doc: DocData): GNode | null {
  const rootKey = pageRootKey();
  const release = pageRelease();
  if (rootKey === null || release === null) return null;
  const id = primaryImpactRoot(doc);
  const p = id === null ? undefined : doc.nodes[id];
  if (!isLegacyFor(p, rootKey, release) || holdsPageMap(doc)) return null;
  return p;
}

// ---------------------------------------------------------------- 引き上げ

/** 鍵の読み替え: 版 6 の 3 か月後の手 r.<手>.<結果>.<種類> → ページの地図の同じ状態の、3 か月目に選ぶ同じ種類の手（無ければ −1） */
export function movedIndex(pa: PageMapAccess, key: string, card: GNode): number {
  const seg = key.split(".");
  if (seg.length !== 4 || seg[0] !== pa.keys[0] || card.meta?.m !== 3) return -1;
  const kind = isStr(card.meta.ak) ? card.meta.ak : seg[3]!;
  const s = pa.keyIndex.get(seg.slice(0, 3).join("."));
  if (s === undefined || pa.map.role(s) !== "s" || pa.map.month(s) !== 3) return -1;
  for (let k = pa.kidStart[s]!; k < pa.kidStart[s + 1]!; k++) {
    const c = pa.kids[k]!;
    if (pa.map.role(c) === "a" && pa.map.month(c) === 3 && pa.map.kind(c) === kind) return c;
  }
  return -1;
}

/** 年月の言い方（"2027-02-01" → 「2027 年 2 月」） */
function ymLabel(day: string): string {
  const [y, m] = day.split("-");
  return `${Number(y)} 年 ${Number(m)} 月`;
}

/** 枠の名前（元の番号。同じ番号の 2 つ目からは "#2"…。元の番号が無い枠は ""） */
function slotNames(cites: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return cites.map((c) => {
    const o = (seen.get(c) ?? 0) + 1;
    seen.set(c, o);
    return o === 1 ? c : `${c}#${o}`;
  });
}

/**
 * やることを移す（next: ページの地図のカードの項目・slots: その枠の名前・c: 版 6 のカード）。チェックは元の番号と枠で同じ項目へ
 * （無ければ、チェックした項目を文ごと後ろに足す）。利用者が足した・書き換えた項目は後ろに（チェックごと）。利用者が消した同梱の項目は、
 * 同じ元の番号の項目を新しい版でも出さない。指紋の無いカードは、チェックした項目だけを文ごと足す（利用者の項目と見分けられない）
 */
function carryFatTodo(next: readonly Condition[], slots: readonly string[], c: GNode, key: string): Condition[] {
  const meta = c.meta ?? {};
  const printed = isStr(meta.t0);
  const k0 = Array.isArray(meta.k0) ? (meta.k0 as unknown[]).map(String) : printed ? [] : null;
  const cites = Array.isArray(meta.cites) ? (meta.cites as unknown[]).map(String) : [];
  const r6Slots = slotNames(k0 ? k0.map((_, t) => cites[t] ?? "") : []);
  const on = new Set<string>();
  const extra: Condition[] = [];
  const usedSlot = new Uint8Array(k0?.length ?? 0);
  for (const cond of c.conditions) {
    if (k0 === null) {
      if (cond.met) extra.push(cond);
      continue;
    }
    const p = fnv36(cond.text);
    let t = -1;
    for (let j = 0; j < k0.length; j++)
      if (!usedSlot[j] && k0[j] === p) {
        t = j;
        break;
      }
    if (t < 0) {
      // 利用者の項目（足した・書き換えた）
      extra.push(cond);
      continue;
    }
    usedSlot[t] = 1;
    if (!cond.met) continue;
    const s = r6Slots[t]!;
    if (s && slots.includes(s)) on.add(s);
    else extra.push(cond);
  }
  const gone = new Set<string>();
  if (k0) for (let t = 0; t < k0.length; t++) if (!usedSlot[t] && r6Slots[t]) gone.add(r6Slots[t]!);
  const list: Condition[] = [];
  next.forEach((x, t) => {
    const s = slots[t] ?? "";
    if (s && gone.has(s)) return;
    list.push(s && on.has(s) && !x.met ? { ...x, met: true } : x);
  });
  const ids = new Set(list.map((x) => x.id));
  for (const x of extra) {
    let id = x.id;
    for (let k = 2; ids.has(id); k++) id = `c_${fnv64x36(`${key}#${x.text}`)}_${k}`;
    ids.add(id);
    list.push(id === x.id ? x : { ...x, id });
  }
  return list;
}

/**
 * ページの地図のカードに、版 6 のカードの利用者の物を当てる（ID・時刻は版 6 のカードの物。位置はページの地図の物。期限・開始・種類・
 * シナリオは、利用者が直した物だけ版 6 のカードの値。プロジェクトは、ページの地図の組に、利用者が足した物を足し外した物を外す: loss-3）
 */
function carryFat(v: GNode, c: GNode, st: FatCardState, slots: readonly string[], key: string, rules: R6Rules | null): GNode {
  const out: GNode = { ...v, id: c.id, createdAt: c.createdAt, updatedAt: c.updatedAt };
  const f = new Set(st.fields);
  if (f.has("due") || f.has("start")) out.time = { ...v.time, ...(f.has("due") ? { due: c.time.due } : {}), ...(f.has("start") ? { start: c.time.start } : {}) };
  if (f.has("type")) out.type = c.type;
  if (f.has("scenarios")) out.scenarioIds = c.scenarioIds;
  if (f.has("projects")) {
    const want = rules ? expectedProjects(rules, c) : null;
    const added = c.projectIds.filter((p) => (want ? !want.includes(p) : !rules?.allSet.has(p)));
    const removed = want ? want.filter((p) => !c.projectIds.includes(p)) : [];
    const next = v.projectIds.filter((p) => !removed.includes(p));
    for (const p of added) if (!next.includes(p)) next.push(p);
    out.projectIds = next;
  }
  if (st.status) out.status = st.status;
  if (st.title) out.title = c.title;
  if (st.body) out.body = c.body;
  if (st.tags.length) {
    const have = new Set(v.tags);
    const add = st.tags.filter((t) => !have.has(t));
    if (add.length) out.tags = [...v.tags, ...add];
  }
  if (st.meta.length) {
    const meta: Meta = { ...v.meta };
    for (const k of st.meta) meta[k] = c.meta[k];
    out.meta = meta;
  }
  if (st.ticks || st.todo) out.conditions = carryFatTodo(v.conditions, slots, c, key);
  return out;
}

/** ページの地図の同梱の線に、版 6 の同梱の線で利用者が直した物（見込み・説明と条件・利用者の meta）を当てる（関係は新しい版の物のまま） */
function carryFatEdge(v: GEdge, e6: GEdge, id: ID, source: ID, target: ID): GEdge {
  const out: GEdge = { ...v, id, source, target, createdAt: e6.createdAt, updatedAt: e6.updatedAt };
  const m6 = e6.meta ?? {};
  let meta: Meta | null = null;
  if (typeof m6.p0 === "number" && m6.prob !== m6.p0) {
    meta = { ...v.meta };
    if (m6.prob === undefined) delete meta.prob;
    else meta.prob = m6.prob;
  }
  if (isStr(m6.c0) && edgeTextPrint(e6.label, e6.condition) !== m6.c0) {
    out.label = e6.label;
    out.condition = e6.condition;
  }
  for (const k of Object.keys(m6)) if (k !== "prob" && !BUILDER_EDGE_META.has(k)) (meta ??= { ...v.meta })[k] = m6[k];
  if (meta) out.meta = meta;
  return out;
}

/** 引き上げた結果 */
export interface LegacyUpgrade {
  doc: DocData;
  info: ThinUpgradeInfo;
}

/**
 * 版 6 までの地図（太い形）を持つ文書を、ページの 3 か月ごとの地図を持つ文書にする（doc は変えない）。ページの地図が無い・
 * 引き上げる地図が無い（ページの地図をもう持つ・別の地図）なら null。保存してあった物とページの地図だけから決まる
 */
export function upgradeLegacyMap(doc: DocData): LegacyUpgrade | null {
  const P = legacyRootOf(doc);
  if (!P) return null;
  const pa = pageMapAccess(isoOk(P.createdAt) ? P.createdAt : null);
  if (!pa) return null;
  const rootKey = pa.keys[0]!;
  const n = pa.n;
  const nodeIds = Object.keys(doc.nodes);
  const edgeIds = Object.keys(doc.edges);

  // ---- 今の地図: 入口から道の線でたどる。ほかの地図（ほかの入口からだけたどれる物）には触らない
  const flowOut = new Map<ID, ID[]>();
  for (const id of edgeIds) {
    const e = doc.edges[id]!;
    if (!isFlowEdge(e) || e.source === e.target || !doc.nodes[e.target]) continue;
    const list = flowOut.get(e.source);
    if (list) list.push(e.target);
    else flowOut.set(e.source, [e.target]);
  }
  const reach = (from: ID): Map<ID, number> => {
    const depth = new Map<ID, number>([[from, 0]]);
    const order = [from];
    for (let q = 0; q < order.length; q++) {
      const d = depth.get(order[q]!)! + 1;
      for (const t of flowOut.get(order[q]!) ?? []) {
        if (depth.has(t)) continue;
        depth.set(t, d);
        order.push(t);
      }
    }
    return depth;
  };
  const depth = reach(P.id);
  const others = new Set<ID>();
  for (const id of nodeIds) {
    if (id === P.id || doc.nodes[id]!.meta?.forecastRoot !== true) continue;
    for (const x of reach(id).keys()) if (!depth.has(x)) others.add(x);
  }

  // ---- 版 6 の地図のカード（鍵ごとに 1 つ。入口からたどれる物 → 先に作った物 → 入口に近い物 → ID の順）。選ばれなかった物は利用者のノード
  const byKey = new Map<string, GNode>();
  const losers = new Set<ID>();
  for (const id of nodeIds) {
    const nd = doc.nodes[id]!;
    const k = nd.meta?.key;
    if (!isStr(k) || id === P.id || others.has(id)) continue;
    if (k === rootKey) {
      losers.add(id);
      continue;
    }
    const cur = byKey.get(k);
    if (!cur) byKey.set(k, nd);
    else if (madeFirst(nd, cur, depth)) {
      losers.add(cur.id);
      byKey.set(k, nd);
    } else losers.add(id);
  }
  const keyOfCard = new Map<ID, string>([[P.id, rootKey]]);
  for (const [k, c] of byKey) keyOfCard.set(c.id, k);

  // ---- 同梱の線（親の鍵のカード → 子の鍵のカード。子ごとに 1 本）: 指紋の付いた地図では指紋 c0 のある線、無い地図では道の線を先に
  const printed = isStr(P.meta.t0);
  const bundleLine = (e: GEdge): boolean => (printed ? isStr(e.meta?.c0) : isFlowEdge(e));
  const rank = (e: GEdge): number => (isFlowEdge(e) ? (bundleLine(e) ? 0 : 1) : bundleLine(e) ? 2 : printed ? -1 : 3);
  const inEdge = new Map<ID, GEdge>();
  for (const id of edgeIds) {
    const e = doc.edges[id]!;
    const tk = keyOfCard.get(e.target);
    const sk = keyOfCard.get(e.source);
    if (tk === undefined || sk === undefined || e.source === e.target || tk.slice(0, tk.lastIndexOf(".")) !== sk) continue;
    const r = rank(e);
    if (r < 0) continue;
    const cur = inEdge.get(e.target);
    if (!cur || r < rank(cur)) inEdge.set(e.target, e);
  }
  const bundle = new Set<ID>();
  for (const e of inEdge.values()) bundle.add(e.id);
  // 利用者の線（同梱の線でない物）。残す線と、カードにつながる利用者の線の数
  const keptEdges: GEdge[] = [];
  const links = new Map<ID, number>();
  for (const id of edgeIds) {
    if (bundle.has(id)) continue;
    const e = doc.edges[id]!;
    keptEdges.push(e);
    links.set(e.source, (links.get(e.source) ?? 0) + 1);
    links.set(e.target, (links.get(e.target) ?? 0) + 1);
  }

  // ---- カードの行き先（鍵の順に決める: 文書の並びによらない）。鍵がそのまま → 読み替えた手 → 利用者の物があれば残す
  const matchOf = new Array<GNode | undefined>(n);
  const stateOf = new Array<FatCardState | null>(n).fill(null);
  matchOf[0] = P;
  const kept = zeroCounts();
  const moved = zeroCounts();
  const det = zeroCounts();
  const detachList: Array<{ key: string; card: GNode; st: FatCardState }> = [];
  // 版 6 の組み立ての決まり（期限・開始・種類・プロジェクト・シナリオ）: 違うカードは利用者が直した物（loss-3）
  const rules = r6Rules(P, byKey);
  for (const k of [...byKey.keys()].sort()) {
    const card = byKey.get(k)!;
    const st = fatCardState(card, inEdge.get(card.id), links.get(card.id) ?? 0, r6FieldEdits(rules, k, card));
    let i = pa.keyIndex.get(k) ?? -1;
    let how: CardCounts = kept;
    if (i < 0) {
      i = movedIndex(pa, k, card);
      how = moved;
    }
    if (i > 0 && matchOf[i] === undefined) {
      matchOf[i] = card;
      stateOf[i] = st;
      if (st) countCard(how, st);
      continue;
    }
    // 新しい地図に無いカード: 親からの線の関係だけを変えた物も残す（関係は meta.prevEdge に。別のカードには線が無い）
    const ie = inEdge.get(card.id);
    const rel = !!ie && relationEdited(ie, card);
    const left = st ?? (rel ? { status: null, ticks: 0, title: false, body: false, todo: false, tags: [], meta: [], edge: true, links: 0, fields: [] } : null);
    if (left) {
      if (rel) left.edge = true;
      detachList.push({ key: k, card, st: left });
      countCard(det, left);
    }
  }

  // ---- 基準（at は版 6 の今日を作った時刻・位置のずれは版 6 の今日の位置・プロジェクトとシナリオは同じ ID か同じ名前）。
  // 同じ ID も同じ名前も無いプロジェクト（利用者が名前を変えた）は、当てたカードの版 6 のプロジェクトの多数決で決める（決まらなければ無い）
  const pmap = looseIdMap(pa.projects, undefined, doc.projects);
  if (pa.projects.some((g) => pmap[g.id] === null)) {
    const votes = new Map<ID, Map<ID, number>>();
    for (let i = 1; i < n; i++) {
      const m = matchOf[i];
      const pp = pa.projectIdsOf(i);
      if (!m || pp.length !== 1 || pmap[pp[0]!] !== null || m.projectIds.length !== 1 || !own(doc.projects, m.projectIds[0]!)) continue;
      const v = votes.get(pp[0]!) ?? new Map<ID, number>();
      v.set(m.projectIds[0]!, (v.get(m.projectIds[0]!) ?? 0) + 1);
      votes.set(pp[0]!, v);
    }
    // 読み替えの先は 1 つのプロジェクトに 1 つだけ（ほかの基準のプロジェクトがもう使っている先は選ばない）。同じ数なら ID の順
    const taken = new Set(Object.values(pmap).filter((t): t is ID => t !== null));
    for (const g of pa.projects) {
      const v = votes.get(g.id);
      if (!v) continue;
      let best: ID | null = null;
      let top = 0;
      for (const t of [...v.keys()].sort()) if (!taken.has(t) && v.get(t)! > top) (best = t), (top = v.get(t)!);
      if (best !== null) (pmap[g.id] = best), taken.add(best);
    }
  }
  const base: MapBase = {
    at: isoOk(P.createdAt) ? P.createdAt : pa.at,
    dx: Math.round(P.x) - pa.rootX,
    dy: Math.round(P.y) - pa.rootY,
    pmap,
    smap: looseIdMap(pa.scenarios, undefined, doc.scenarios),
  };
  const view = pa.view(base);

  // ---- ID: 当てたカードは版 6 のカードの ID のまま（利用者の線はつながったまま）。ほかは鍵から決まる ID（文書の ID と重なれば鍵 + "#2"…）
  const used = new Set<ID>(nodeIds);
  const idOf = new Array<ID>(n);
  idOf[0] = P.id;
  for (let i = 1; i < n; i++) {
    const m = matchOf[i];
    if (m) {
      idOf[i] = m.id;
      continue;
    }
    let id = view.nodes[i]!.id;
    for (let t = 2; used.has(id); t++) id = impactNodeId64(`${pa.keys[i]}#${t}`);
    used.add(id);
    idOf[i] = id;
  }
  const usedE = new Set<ID>(edgeIds);
  const edgeIdOf = new Array<ID>(n);
  for (let i = 1; i < n; i++) {
    let id = view.edges[i]!.id;
    for (let t = 2; usedE.has(id); t++) id = impactEdgeId64(`${pa.keys[i]}#${t}`);
    usedE.add(id);
    edgeIdOf[i] = id;
  }

  // ---- 整える前のノード: 今日 → 当てたカード → 前の版で決めたこと → 利用者のノード（文書の順）
  const fromRel = typeof P.meta.futureRelease === "number" && Number.isFinite(P.meta.futureRelease) ? P.meta.futureRelease : 0;
  const nodesIn: Record<ID, GNode> = { [P.id]: P };
  const carried = new Uint8Array(n);
  for (let i = 1; i < n; i++) {
    const m = matchOf[i];
    const st = stateOf[i];
    if (!m || !st || !changesCard(st)) continue;
    nodesIn[m.id] = carryFat(view.nodes[i]!, m, st, pa.slots(i), pa.keys[i]!, rules);
    carried[i] = 1;
  }
  const rx = Math.round(P.x);
  const ry = Math.round(P.y);
  if (detachList.length) {
    // 列の位置: 今日の左。地図の外のカード（利用者のノード・ほかの地図・今日）と重なれば、さらに左へ
    const placed: Array<{ x: number; y: number }> = [];
    for (const id of nodeIds) if (!keyOfCard.has(id) || id === P.id) placed.push(doc.nodes[id]!);
    const gx = prevColumnX(rx, ry, detachList.length, placed);
    const ver = isStr(P.meta.futureVersion) ? P.meta.futureVersion : "";
    let gid = `n_prev_${fnv64x36(`${P.id}\u0000${fromRel}\u0000${ver}`)}`;
    for (let t = 2; used.has(gid); t++) gid = `n_prev_${fnv64x36(`${P.id}\u0000${fromRel}\u0000${ver}#${t}`)}`;
    used.add(gid);
    nodesIn[gid] = prevGroupCard(gid, fromRel, pa.release, gx, ry, base.at);
    detachList.forEach(({ key, card, st }, j) => {
      nodesIn[card.id] = detachFatCard(card, key, st, inEdge.get(card.id), fromRel, gx, ry + PREV_ROW * (j + 1));
    });
  }
  for (const id of nodeIds) {
    if (id === P.id || keyOfCard.has(id)) continue;
    const nd = doc.nodes[id]!;
    nodesIn[id] = losers.has(id) ? withoutKey(nd) : nd;
  }

  // ---- 線: 同梱の線（ページの地図の物。利用者が直した見込み・説明は、版 6 の線から当てる）→ 利用者の線（そのまま）。
  // 同じ 2 枚の間に利用者の線があれば、同梱の線は足さない（同じ向きの線は 2 本にしない）
  const pairs = new Set<string>();
  for (const e of keptEdges) pairs.add(`${e.source}\u0000${e.target}`);
  const edgesIn: Record<ID, GEdge> = {};
  const carriedE = new Uint8Array(n);
  const skipE = new Uint8Array(n);
  let relations = 0;
  for (let i = 1; i < n; i++) {
    const s = idOf[pa.parent[i]!]!;
    const t = idOf[i]!;
    if (pairs.has(`${s}\u0000${t}`)) {
      skipE[i] = 1;
      continue;
    }
    const c = matchOf[i];
    const pc = matchOf[pa.parent[i]!];
    const e6 = c && pc ? inEdge.get(c.id) : undefined;
    // 関係を変えた同梱の線は、新しい地図の関係に戻す（数えて知らせる: loss-6）
    if (e6 && e6.source === pc!.id && relationEdited(e6, c!)) relations++;
    if (!e6 || e6.source !== pc!.id || !fatEdgeEdited(e6)) continue;
    edgesIn[edgeIdOf[i]!] = carryFatEdge(view.edges[i]!, e6, edgeIdOf[i]!, s, t);
    carriedE[i] = 1;
  }
  for (const e of keptEdges) edgesIn[e.id] = e;

  // ---- 整える（地図のほかのカードの ID は外にある物として、利用者の線を残す）。何かが落ちたら引き上げない（読み手の誤り）
  const pageIds = new Set<ID>(idOf);
  const norm = normalizeDoc({ ...doc, version: 1, nodes: nodesIn, edges: edgesIn }, { externalNodeIds: (id) => pageIds.has(id) });
  const nd = norm.doc;
  const dr = norm.report.dropped;
  if (dr.nodes || dr.edges || dr.projects || dr.scenarios || Object.keys(nd.nodes).length !== Object.keys(nodesIn).length || Object.keys(nd.edges).length !== Object.keys(edgesIn).length)
    throw new Error("版 6 の地図を新しい版にする途中で、ノードか線が落ちました");

  // ---- 新しい入れ物: 今日 → 地図のカード（番号の順）→ 前の版で決めたこと・利用者のノード、地図の線（番号の順）→ 利用者の線
  const nodes: Record<ID, GNode> = {};
  nodes[P.id] = pa.withRelease(carryRoot(view.nodes[0]!, nd.nodes[P.id]!));
  for (let i = 1; i < n; i++) {
    const id = idOf[i]!;
    if (carried[i]) {
      nodes[id] = nd.nodes[id]!;
      continue;
    }
    const vn = view.nodes[i]!;
    nodes[id] = id === vn.id ? vn : { ...vn, id };
  }
  for (const id of Object.keys(nd.nodes)) if (!own(nodes, id)) nodes[id] = nd.nodes[id]!;
  const edges: Record<ID, GEdge> = {};
  for (let i = 1; i < n; i++) {
    if (skipE[i]) continue;
    const id = edgeIdOf[i]!;
    if (carriedE[i]) {
      edges[id] = nd.edges[id]!;
      continue;
    }
    const ve = view.edges[i]!;
    const s = idOf[pa.parent[i]!]!;
    const t = idOf[i]!;
    edges[id] = id === ve.id && s === ve.source && t === ve.target ? ve : { ...ve, id, source: s, target: t };
  }
  for (const id of Object.keys(nd.edges)) if (!own(edges, id)) edges[id] = nd.edges[id]!;

  const info: ThinUpgradeInfo = {
    from: { release: fromRel, hash: isStr(P.meta.futureVersion) ? P.meta.futureVersion : "" },
    to: { release: pa.release, hash: pa.hash },
    applied: kept.cards + moved.cards,
    restored: 0,
    detached: detachList.length,
    lostTicks: 0,
    droppedEdges: 0,
    legacy: { kept, moved, detached: det, movedAt: ymLabel(anchorMonthStart(pa.anchor, 3)), ...(relations ? { relations } : {}) },
  };
  return { doc: { ...nd, nodes, edges }, info };
}
