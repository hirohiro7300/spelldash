// アカウントの形をした、版 6 の地図の文書（tests/fixtures/account-r6.json）を作る（合成。本物のアカウントのデータは使わない。見直し gaps-5・safety-6）。
// 版 6 → 版 7 の引き上げ（作業メモ SPEC v1 §8）を、アカウントと同じ形の文書で確かめるための物。決まった種の乱数で作るので、何度作っても同じバイト。
// この文書は凍結している（見直し found-1）: 版 6 のページが書いた形のまま変えないので、作り方はアプリの今のコードを読まず、
// 版 6 の時の組み立て・並べ方・入れ物の形・決まりの写し（./frozenR6.ts）と、凍結した入力（tests/fixtures/impact-r6.json と版の記録）だけを使う。
// ほかの仕事がアプリの組み立て・並べ方・normalizeDoc・NODE_W・SCHEMA_VERSION などを変えても、作り直した物はバイトまで同じ。
// 今のアプリがこの文書を読めるか（今の normalizeDoc で何も直されないか）は tests/unit/fixturesR6.test.ts が別に確かめる。
// 作り方:
//   1. 凍結した版 6 の同梱データを、版 6 のページの「未来の道筋を読み込む」と同じ地図の文書にする（./frozenR6.ts の buildR6MapDoc。
//      版 6 の組み立ての後に検証を通した物と同じ）
//   2. それより前からあった利用者の文書（同じ名前のプロジェクト 3 つ。うち「広告運用事業での独立」だけは別の ID・自分のプロジェクト・
//      シナリオ 3 つ・前から書いてあったメモ 2 枚）へ、「追加する」と同じやり方で足す（版 6 のページの io.ts の mergeDocs と同じ:
//      ノード・線・やることの ID はすべて振り直し、プロジェクトとシナリオは名前で合わせ、今の文書の右に並べる）。
//      アカウントの地図は、この道で入ったので ID がどれも乱数（同梱の鍵の ID ではない）。mergeDocs の手順もここに写して持つ
//   3. 深さ 1〜6（今日の手 → 3 か月後 → その手 → 1 年後 → 2 年の進め方 → 3 年後）のどこにも、利用者が手を入れた所を作る:
//      選んだ手と見送り・やることのチェックと自分で足した項目・題名と本文の書き換え・見込みの書き換え（77%）・線の説明と条件の書き換え・
//      自分のタグ・地図のカードどうしの自分の線・自分のカード（相乗効果・進む・条件付きの線で地図につなぐ）・自分のプロジェクト・年収
//   4. ノード・線は 1 行に 1 つで書き出す（差分が読める。どの物も版 6 の検証の後と同じ項目の順）
// 書き出し: node scripts/fixtures/run.mjs --check（書いてある物と同じかだけを確かめる）。書いてある物を書き直すのは --force の時だけ。
// 中身は tests/unit/fixturesR6.test.ts が確かめる

import { R6_DEFAULT_DOC_TITLE, R6_NODE_W, R6_SCHEMA, R6_SCHEMA_VERSION, buildR6MapDoc, r6NameKey, type R6Bundle, type R6Condition, type R6Doc, type R6Edge, type R6Group, type R6Node, type R6NodeType, type R6Relation, type R6Release } from "./frozenR6";

type ID = string;

/** 乱数の種（変えると ID がすべて変わる） */
export const ACCOUNT_R6_SEED = 0x4d0b_0006;
/** 利用者が版 6 の地図を読み込んだ日（カードの期限はこの月から数える） */
export const ACCOUNT_R6_LOAD_DAY = { year: 2026, month: 11, day: 12 };
/** 利用者が入れた年収（万円） */
export const ACCOUNT_R6_ANNUAL = 480;

/** 文書を作った時刻・地図を読み込んだ時刻（手を入れた時刻はその後に 1 つずつ進む） */
const T_START = Date.parse("2026-10-26T09:12:34.000Z");
const T_LOAD = Date.parse("2026-11-12T10:30:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** 決まった種の乱数で、版 6 のアプリの newId と同じ形の ID（接頭辞 + "_" + 12 文字。1 バイトを 36 で割った余り）を作る。重なれば作り直す */
function idMaker(seed: number): (prefix: "n" | "e" | "p" | "s" | "c" | "d") => ID {
  let a = seed >>> 0;
  // mulberry32
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  const seen = new Set<ID>();
  return (prefix) => {
    for (;;) {
      let s = "";
      for (let i = 0; i < 12; i++) s += ALPHABET[(next() & 0xff) % 36];
      const id = `${prefix}_${s}`;
      if (seen.has(id)) continue;
      seen.add(id);
      return id;
    }
  };
}

type IdMaker = ReturnType<typeof idMaker>;

/**
 * 「追加する」の取り込み（版 6 のページの src/persist/io.ts の mergeDocs と同じ手順）: 取り込む側のノード・線・やることの ID をすべて振り直して足す。
 * プロジェクト・シナリオは名前が同じならまとめ、位置は今の文書の右端のさらに右へ（上をそろえる）
 */
function mergeAsAdded(base: R6Doc, incoming: Pick<R6Doc, "projects" | "scenarios" | "nodes" | "edges" | "projectOrder" | "scenarioOrder">, newId: IdMaker): R6Doc {
  const doc: R6Doc = { ...base, projects: { ...base.projects }, scenarios: { ...base.scenarios }, nodes: { ...base.nodes }, edges: { ...base.edges }, projectOrder: [...base.projectOrder], scenarioOrder: [...base.scenarioOrder] };
  const pMap = new Map<ID, ID>();
  const sMap = new Map<ID, ID>();
  const pByName = new Map<string, ID>();
  for (const p of Object.values(doc.projects)) if (!pByName.has(r6NameKey(p.name))) pByName.set(r6NameKey(p.name), p.id);
  for (const pid of incoming.projectOrder) {
    const p = incoming.projects[pid];
    if (!p) continue;
    const hit = pByName.get(r6NameKey(p.name));
    if (hit) pMap.set(pid, hit);
    else {
      const id = newId("p");
      doc.projects[id] = { ...p, id };
      doc.projectOrder.push(id);
      pMap.set(pid, id);
      pByName.set(r6NameKey(p.name), id);
    }
  }
  const sByName = new Map<string, ID>();
  for (const s of Object.values(doc.scenarios)) if (!sByName.has(r6NameKey(s.name))) sByName.set(r6NameKey(s.name), s.id);
  for (const sid of incoming.scenarioOrder) {
    const s = incoming.scenarios[sid];
    if (!s) continue;
    const hit = sByName.get(r6NameKey(s.name));
    if (hit) sMap.set(sid, hit);
    else {
      const id = newId("s");
      doc.scenarios[id] = { ...s, id };
      doc.scenarioOrder.push(id);
      sMap.set(sid, id);
      sByName.set(r6NameKey(s.name), id);
    }
  }
  const baseNodes = Object.values(base.nodes);
  const inNodes = Object.values(incoming.nodes);
  let dx = 0;
  let dy = 0;
  if (baseNodes.length && inNodes.length) {
    let baseMaxX = -Infinity;
    let baseMinY = Infinity;
    let inMinX = Infinity;
    let inMinY = Infinity;
    for (const n of baseNodes) {
      baseMaxX = Math.max(baseMaxX, n.x);
      baseMinY = Math.min(baseMinY, n.y);
    }
    for (const n of inNodes) {
      inMinX = Math.min(inMinX, n.x);
      inMinY = Math.min(inMinY, n.y);
    }
    dx = baseMaxX + R6_NODE_W + 600 - inMinX;
    dy = baseMinY - inMinY;
  }
  const nMap = new Map<ID, ID>();
  for (const n of inNodes) {
    const id = newId("n");
    nMap.set(n.id, id);
    doc.nodes[id] = {
      ...n,
      id,
      x: n.x + dx,
      y: n.y + dy,
      projectIds: n.projectIds.map((p) => pMap.get(p)).filter((p): p is ID => !!p),
      scenarioIds: n.scenarioIds.map((s) => sMap.get(s)).filter((s): s is ID => !!s),
      conditions: n.conditions.map((c) => ({ ...c, id: newId("c") })),
    };
  }
  for (const e of Object.values(incoming.edges)) {
    const source = nMap.get(e.source);
    const target = nMap.get(e.target);
    if (!source || !target) continue;
    const id = newId("e");
    doc.edges[id] = { ...e, id, source, target, scenarioIds: e.scenarioIds.map((s) => sMap.get(s)).filter((s): s is ID => !!s) };
  }
  return doc;
}

/** 版 6 の地図（凍結した同梱データから、版 6 のページの読み込みと同じ文書）。カード・線・プロジェクト・シナリオの時刻は読み込んだ時刻 */
function r6Map(raw: string, release: R6Release): ReturnType<typeof buildR6MapDoc> {
  return buildR6MapDoc(JSON.parse(raw) as R6Bundle, ACCOUNT_R6_LOAD_DAY, release, iso(T_LOAD));
}

const group = (id: ID, name: string, color: string, description: string): R6Group => ({ id, name, color, description, createdAt: iso(T_START), updatedAt: iso(T_START), meta: {} });

function card(id: ID, type: R6NodeType, title: string, x: number, y: number, projectIds: ID[], at: string, body = ""): R6Node {
  return { id, type, title, body, status: "open", time: { due: null, start: null }, conditions: [], tags: [], projectIds, scenarioIds: [], x, y, collapsed: false, createdAt: at, updatedAt: at, meta: {} };
}

/** 版 6 の地図を読み込む前からあった利用者の文書（プロジェクト・シナリオ・メモ） */
function accountBase(newId: IdMaker): { doc: R6Doc; own: ID; note: ID; study: ID } {
  const own = newId("p");
  const ind = newId("p");
  const projects: R6Group[] = [
    group("p_spelldash", "SpellDash事業", "#FF7A59", "英単語学習ゲーム SpellDash を事業として伸ばす。"),
    group("p_fcmarketing", "FCマーケティングでの業務", "#22D3EE", "会社での広告運用の仕事。成果と評価を積み上げる。"),
    // 同じ名前で、同梱の地図とは別の ID のプロジェクト（追加すると、地図のカードはこの ID に読み替わる）
    group(ind, "広告運用事業での独立", "#A3E635", "広告運用代行として独立し、収入の柱を作る。"),
    group(own, "資格の勉強", "#F472B6", "会社の外でも使える資格を取る。"),
  ];
  const scenarios: R6Group[] = [
    group("s_balance", "両立（基本）", "#8B7BFF", "会社員を続けながら、SpellDash と副業を同時に育てる。"),
    group("s_early", "早期独立", "#F2C14E", "2027 年中に副業の条件を満たし、独立する。"),
    group("s_focus", "SpellDash集中", "#4FD1E8", "広告に頼らずオーガニックで伸ばし、SpellDash に時間を寄せる。"),
  ];
  const at = iso(T_START);
  const note = card(newId("n"), "goal", "外のメモ: 転職エージェントの面談", -320, -420, ["p_fcmarketing"], at, "面談で聞くこと: 副業の届け出の扱い・リモートの日数。");
  const study = card(newId("n"), "action", "簿記 2 級の勉強を続ける", 60, -420, [own], at, "毎朝 30 分。");
  const doc: R6Doc = {
    schema: R6_SCHEMA,
    version: R6_SCHEMA_VERSION,
    id: newId("d"),
    title: R6_DEFAULT_DOC_TITLE,
    createdAt: at,
    updatedAt: at,
    projects: Object.fromEntries(projects.map((p) => [p.id, p])),
    scenarios: Object.fromEntries(scenarios.map((s) => [s.id, s])),
    nodes: { [note.id]: note, [study.id]: study },
    edges: {},
    projectOrder: projects.map((p) => p.id),
    scenarioOrder: scenarios.map((s) => s.id),
    meta: {},
  };
  return { doc, own, note: note.id, study: study.id };
}

/** アカウントの形をした版 6 の文書を作る（raw は凍結した版 6 の同梱データの文字列、release はその版の記録） */
export function buildAccountR6(raw: string, release: R6Release): R6Doc {
  const newId = idMaker(ACCOUNT_R6_SEED);
  const base = accountBase(newId);
  const doc = mergeAsAdded(base.doc, r6Map(raw, release), newId);

  // 手を入れた時刻（1 つずつ後に）
  let k = 0;
  const stamp = () => iso(T_LOAD + 86_400_000 + ++k * 97_000);
  const byKey = new Map<string, ID>();
  for (const n of Object.values(doc.nodes)) if (typeof n.meta.key === "string") byKey.set(n.meta.key, n.id);
  const id = (key: string): ID => {
    const v = byKey.get(key);
    if (!v) throw new Error(`版 6 の地図に無い鍵: ${key}`);
    return v;
  };
  const node = (key: string): R6Node => doc.nodes[id(key)]!;
  /** 親のカードから key のカードへの同梱の線 */
  const edgeTo = (key: string): R6Edge => {
    const s = id(key.slice(0, key.lastIndexOf(".")));
    const t = id(key);
    const e = Object.values(doc.edges).find((x) => x.source === s && x.target === t);
    if (!e) throw new Error(`道の線が無い: ${key}`);
    return e;
  };
  const patchNode = (key: string, patch: (n: R6Node) => Partial<R6Node>) => {
    const n = node(key);
    doc.nodes[n.id] = { ...n, ...patch(n), updatedAt: stamp() };
  };
  const patchEdge = (e: R6Edge, patch: Partial<R6Edge>) => {
    doc.edges[e.id] = { ...e, ...patch, updatedAt: stamp() };
  };
  const tick = (n: R6Node, items: number[]): R6Condition[] => n.conditions.map((c, i) => (items.includes(i) ? { ...c, met: true } : c));
  const addCard = (type: R6NodeType, title: string, near: R6Node, projectIds: ID[], body = ""): ID => {
    const c = card(newId("n"), type, title, near.x + 320, near.y + 360, projectIds, stamp(), body);
    doc.nodes[c.id] = c;
    return c.id;
  };
  const link = (source: ID, target: ID, relation: R6Relation) => {
    const at = stamp();
    const e: R6Edge = { id: newId("e"), source, target, relation, label: "", condition: "", scenarioIds: [], collapsed: false, createdAt: at, updatedAt: at, meta: {} };
    doc.edges[e.id] = e;
  };
  const indProject = doc.projectOrder.find((p) => doc.projects[p]!.name === "広告運用事業での独立")!;

  // 深さ 0（今日）: 年収
  patchNode("r", (n) => ({ meta: { ...n.meta, impact: { ...(n.meta.impact as object), annual: ACCOUNT_R6_ANNUAL } } }));

  // 深さ 1（今日の 10 の手）: 選んだ手（やることのチェック・自分のタグ）・見送り・題名と本文の書き換え・外のメモからの相乗効果の線
  patchNode("r.fc_switch", (n) => ({ status: "active", conditions: tick(n, [0, 2]), tags: [...n.tags, "自分のタグ"] }));
  patchNode("r.sd_pilot", () => ({ status: "dropped" }));
  patchNode("r.sd_grow", () => ({ title: "遊ぶ人を増やす（自分の言葉）" }));
  patchNode("r.ind_quit", (n) => ({ body: `${n.body}\n\n自分のメモ: 貯金が 1 年分たまるまでは辞めない。` }));
  link(base.note, id("r.fc_switch"), "supports");

  // 深さ 2（3 か月後）: 見込みの書き換え（10% → 77%）・本文の書き換えと自分のタグ・線の説明と条件の書き換え・
  // 状態のカードから自分のカードへの条件付きの線（自分の子）・地図のカードどうしの自分の線
  const high = edgeTo("r.fc_switch.high");
  patchEdge(high, { meta: { ...high.meta, prob: 77 } });
  patchNode("r.fc_switch.none", (n) => ({ body: `${n.body}\n\n自分のメモ: 3 か月で決まらなくても、条件を下げずに続ける。`, tags: [...n.tags, "要注意"] }));
  patchEdge(edgeTo("r.ad_permside.s"), { label: "自分の説明", condition: "自分の条件" });
  const agent = addCard("action", "転職エージェントに登録する", node("r.fc_switch.none"), ["p_fcmarketing"]);
  link(id("r.fc_switch.none"), agent, "condition");
  link(id("r.sd_pilot.no"), id("r.sd_grow"), "supports");

  // 深さ 3（3 か月後の手）: 選んだ手（チェックと自分で足した項目）・見送り・題名の書き換えと自分のタグ・選ばずにチェックだけ
  patchNode("r.fc_switch.none.fc_switch", (n) => ({ status: "active", conditions: [...tick(n, [0]), { id: newId("c"), text: "求人票の条件を表にまとめる", met: true }] }));
  patchNode("r.fc_switch.none.keep", () => ({ status: "dropped" }));
  patchNode("r.fc_switch.high.ad_permside", (n) => ({ title: "転職先でも届け出て副業を探す（自分の言葉）", tags: [...n.tags, "自分のタグ"] }));
  patchNode("r.ad_permside.a0_a1.ad_side", (n) => ({ conditions: tick(n, [1]) }));

  // 深さ 4（1 年後）: 題名と本文の書き換え・自分のタグ
  patchNode("r.fc_switch.none.fc_switch.high", (n) => ({ title: "1 年後: 大幅増で転職できた（自分の言葉）", body: `${n.body}\n\n自分のメモ: 入社の前に副業の届け出の扱いを確かめる。` }));
  patchNode("r.fc_switch.none.fc_switch.none", (n) => ({ tags: [...n.tags, "要注意"] }));

  // 深さ 5（2 年の進め方）: 選んだ手（やることの無いカードに自分で足した項目）・見送り・本文の書き換え・その手から自分のカードへの進む線（自分の子）
  patchNode("r.fc_switch.none.fc_switch.high.plan_side", () => ({ status: "active", conditions: [{ id: newId("c"), text: "転職先の就業規則を読む", met: true }] }));
  patchNode("r.fc_switch.none.fc_switch.high.keep", () => ({ status: "dropped" }));
  patchNode("r.fc_switch.none.fc_switch.none.ind_quit", (n) => ({ body: `${n.body}\n\n自分のメモ: 辞める前に 3 社の見込み客を作る。` }));
  const office = addCard("action", "開業届を出す", node("r.fc_switch.none.fc_switch.none.ind_quit"), [indProject]);
  link(id("r.fc_switch.none.fc_switch.none.ind_quit"), office, "leads");

  // 深さ 6（3 年後の行き先）: 題名の書き換えと自分のタグ・行き先から自分のカードへの進む線と、その先の自分のカード
  patchNode("r.fc_switch.none.fc_switch.high.plan_side.a", (n) => ({ title: "3 年後: 転職先で副業と Pro（目標）", tags: [...n.tags, "目標"] }));
  const goal = node("r.fc_switch.none.fc_switch.high.plan_side.a");
  const rent = addCard("goal", "事務所を借りる（自分のカード）", goal, [base.own]);
  link(goal.id, rent, "leads");
  const work = addCard("result", "事務所で働く", doc.nodes[rent]!, [base.own]);
  link(rent, work, "leads");
  link(base.study, rent, "supports");

  doc.updatedAt = stamp();
  // 書き出す形（JSON）に写す。版 6 のページはここで検証を通したが、どの物も検証の後と同じ形で作ってあるので、今のアプリの検証は通さない
  // （今の検証が何も直さないことは tests/unit/fixturesR6.test.ts が確かめる）
  return JSON.parse(JSON.stringify(doc)) as R6Doc;
}

/** 書き出す形: ノード・線・プロジェクト・シナリオは 1 行に 1 つ（JSON として読める。差分が読める） */
export function accountR6Json(doc: R6Doc): string {
  const lines: string[] = ["{"];
  const keys = Object.keys(doc) as Array<keyof R6Doc>;
  keys.forEach((k, i) => {
    const comma = i < keys.length - 1 ? "," : "";
    const v = doc[k];
    if (k === "nodes" || k === "edges" || k === "projects" || k === "scenarios") {
      const ents = Object.entries(v as Record<string, unknown>);
      lines.push(`${JSON.stringify(k)}: {`);
      ents.forEach(([eid, e], j) => lines.push(`${JSON.stringify(eid)}: ${JSON.stringify(e)}${j < ents.length - 1 ? "," : ""}`));
      lines.push(`}${comma}`);
    } else lines.push(`${JSON.stringify(k)}: ${JSON.stringify(v)}${comma}`);
  });
  lines.push("}");
  return `${lines.join("\n")}\n`;
}
