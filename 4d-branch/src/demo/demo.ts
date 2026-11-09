// 初回起動のデモ: 3 つのプロジェクトが「広告運用を学ぶ」などの共通の行動・結果でつながり、相乗効果が見える。
// 横の位置はおおよそ時間（左 = 今、右 = 未来）。上から SpellDash・FC マーケティング・独立 の帯に並べる。

import { DEFAULT_DOC_TITLE, createEmptyDoc, makeCondition, makeEdge, makeNode, makeProject, makeScenario } from "../model/schema";
import type { DocData, GNode, NodeStatus, NodeType, Relation } from "../model/types";

interface N {
  id: string;
  type: NodeType;
  title: string;
  p: Array<"spell" | "fc" | "ind">;
  x: number;
  y: number;
  due?: string;
  start?: string;
  status?: NodeStatus;
  tags?: string[];
  body?: string;
  cond?: Array<[string, boolean]>;
  scen?: Array<"base" | "early" | "focus">;
}

interface E {
  from: string;
  to: string;
  rel?: Relation;
  label?: string;
  cond?: string;
  scen?: Array<"base" | "early" | "focus">;
}

const NODES: N[] = [
  // ---- 3 つすべてに効く行動（いちばん左の起点）
  {
    id: "learn-ads",
    type: "action",
    title: "広告運用を学ぶ（Google・Meta）",
    p: ["spell", "fc", "ind"],
    x: 0,
    y: -40,
    start: "2026-10-01",
    due: "2027-03-31",
    status: "active",
    tags: ["スキル", "広告"],
    body: "仕事の成果・SpellDash の集客・独立の 3 つすべてに効く、いちばん効く行動。\n学んだことはまず担当案件と SpellDash で試す。",
    cond: [
      ["週 5 時間の学習時間を確保", true],
      ["Google 広告の認定資格を取る", false],
    ],
  },

  // ---- SpellDash事業
  { id: "seo", type: "action", title: "SEO 記事を週 2 本公開", p: ["spell"], x: 300, y: -600, due: "2027-03-31", status: "active", tags: ["集客", "SEO"], body: "英単語の覚え方・試験別の単語リストなど、検索される記事を積み上げる。" },
  { id: "shorts", type: "action", title: "ショート動画で単語クイズを発信", p: ["spell"], x: 300, y: -470, due: "2027-05-31", tags: ["集客", "SNS"], body: "TikTok・YouTube ショートで 1 日 1 本。反応の良い形式を記事にも回す。" },
  {
    id: "channel",
    type: "branch",
    title: "集客の主軸をどうするか",
    p: ["spell"],
    x: 600,
    y: -540,
    due: "2027-06-30",
    tags: ["判断"],
    body: "広告で一気に伸ばすか、オーガニックで積み上げるか。半年の数字で決める。",
    cond: [
      ["広告の CPA が 1,500 円以下で回る", false],
      ["SEO 流入が月 3 万を超える", false],
    ],
  },
  { id: "organic", type: "action", title: "オーガニック中心で積み上げる", p: ["spell"], x: 900, y: -660, due: "2027-09-30", tags: ["集客", "SEO"], scen: ["focus"], body: "広告費をかけず、記事と動画と口コミで伸ばす。" },
  { id: "own-ads", type: "action", title: "SpellDash の広告を自分で運用する", p: ["spell", "ind"], x: 900, y: -420, due: "2027-09-30", tags: ["広告", "実績"], body: "自社サービスなので数字を公開しやすい。独立後の営業資料にもなる。" },
  { id: "ad-cost", type: "result", title: "広告単価の上昇（外部の出来事）", p: ["spell", "ind"], x: 900, y: -280, tags: ["リスク", "外部"], body: "競合の参入やプラットフォームの変更で CPC が上がる可能性。" },
  { id: "members300", type: "result", title: "有料会員 300 人", p: ["spell"], x: 1200, y: -580, due: "2027-12-31", tags: ["KPI"], body: "MRR 約 15 万円。サーバー代と広告費をまかなえる。" },
  { id: "ad-pattern", type: "result", title: "広告の勝ちパターンが見つかる", p: ["spell"], x: 1200, y: -360, due: "2027-12-31", tags: ["広告", "実績"], body: "CPA・LTV の実数と、効いたクリエイティブの型。" },
  { id: "members1000", type: "goal", title: "SpellDash 有料会員 1,000 人", p: ["spell"], x: 1500, y: -580, due: "2028-09-30", tags: ["KPI", "収益"], body: "継続課金の会員を 1,000 人にして、月の売上を安定させる。" },

  // ---- FCマーケティングでの業務
  { id: "client-ops", type: "action", title: "担当案件の運用改善（週次レポート）", p: ["fc"], x: 300, y: 40, due: "2027-01-31", status: "active", tags: ["仕事", "広告"], body: "入札と除外キーワードを毎週見直し、改善の理由をレポートに残す。" },
  { id: "ga4", type: "action", title: "GA4・計測の設計を任される", p: ["fc"], x: 600, y: -60, due: "2027-04-30", tags: ["仕事", "計測"], body: "計測の設計ができると、提案の幅が広がる。" },
  { id: "roas", type: "result", title: "担当案件で ROAS 300% を達成", p: ["fc"], x: 600, y: 160, due: "2027-06-30", tags: ["実績", "広告"], body: "社内の評価と、独立後の事例（許可の範囲で）の両方になる。" },
  {
    id: "career",
    type: "branch",
    title: "社内でのキャリアをどうするか",
    p: ["fc"],
    x: 900,
    y: 40,
    due: "2027-09-30",
    tags: ["判断"],
    body: "マネージャーを目指すか、運用のスペシャリストを極めるか。",
    cond: [["評価 A を 2 期連続", false]],
  },
  { id: "leader", type: "result", title: "運用チームのリーダーに昇格", p: ["fc"], x: 1200, y: -10, due: "2028-03-31", tags: ["仕事"], scen: ["base", "focus"], body: "収入は安定するが、副業に使える時間は減る。" },
  { id: "trusted", type: "goal", title: "社内で信頼される運用者になる", p: ["fc"], x: 1500, y: 40, due: "2028-09-30", tags: ["仕事"], body: "難しい案件を任される・後輩に教えられる。" },

  // ---- 広告運用事業での独立
  { id: "side-gigs", type: "action", title: "副業で小さく受注（2 社）", p: ["ind"], x: 600, y: 520, due: "2027-04-30", tags: ["副業", "営業"], body: "知人の紹介から。単価より実績と推薦の言葉を優先する。" },
  { id: "portfolio", type: "result", title: "実績ポートフォリオができる", p: ["ind"], x: 1200, y: 360, due: "2027-08-31", tags: ["実績"], body: "副業・SpellDash・担当案件の 3 つの数字が合流する。" },
  {
    id: "when-indep",
    type: "branch",
    title: "独立のタイミング",
    p: ["ind"],
    x: 1500,
    y: 360,
    due: "2027-10-31",
    tags: ["判断"],
    body: "会社に残りながら副業を続けるか、独立するか。",
    cond: [
      ["副業の月収 30 万円が 3 か月続く", false],
      ["生活費 6 か月分の貯金", true],
    ],
  },
  { id: "go-indep", type: "action", title: "独立して広告運用代行を始める", p: ["ind"], x: 1800, y: 250, due: "2028-01-31", tags: ["独立"], scen: ["early"], body: "得意な業種（教育・サブスク）に絞って始める。" },
  { id: "stay", type: "action", title: "会社に残り、副業を続ける", p: ["ind", "fc"], x: 1800, y: 480, due: "2028-01-31", tags: ["副業"], scen: ["base", "focus"], body: "収入を保ちながら、条件がそろうのを待つ。" },
  { id: "referrals", type: "result", title: "紹介で顧客が増える", p: ["ind"], x: 2100, y: 560, due: "2028-06-30", tags: ["営業"], scen: ["early"], body: "成果が出た顧客からの紹介が、いちばん強い営業になる。" },
  { id: "indep-goal", type: "goal", title: "独立して月収 80 万円", p: ["ind"], x: 2100, y: 360, due: "2028-12-31", tags: ["収入"], body: "広告運用代行と SpellDash の 2 本の柱で。" },
];

const EDGES: E[] = [
  // SpellDash
  { from: "seo", to: "channel" },
  { from: "shorts", to: "channel" },
  { from: "learn-ads", to: "channel", rel: "supports", label: "広告という選択肢が持てる" },
  { from: "channel", to: "own-ads", rel: "condition", cond: "CPA 1,500 円以下で回るなら", scen: ["base", "early"] },
  { from: "channel", to: "organic", rel: "condition", cond: "広告が合わなければ", scen: ["focus"] },
  { from: "own-ads", to: "members300" },
  { from: "organic", to: "members300" },
  { from: "own-ads", to: "ad-pattern" },
  { from: "ad-cost", to: "ad-pattern", rel: "blocks", label: "CPA が悪化する" },
  { from: "members300", to: "members1000" },
  { from: "members300", to: "seo", rel: "feedback", label: "会員の声を記事のネタに" },

  // FCマーケティング
  { from: "learn-ads", to: "client-ops", rel: "supports", label: "学んだことを担当案件で試す" },
  { from: "client-ops", to: "roas" },
  { from: "client-ops", to: "ga4" },
  { from: "ga4", to: "career" },
  { from: "roas", to: "career" },
  { from: "career", to: "leader", rel: "condition", cond: "評価 A を 2 期連続", scen: ["base", "focus"] },
  { from: "leader", to: "trusted" },
  { from: "roas", to: "trusted" },

  // プロジェクトをまたぐ影響（交差リンク）
  { from: "ga4", to: "own-ads", rel: "supports", label: "計測の知見を SpellDash に" },
  { from: "roas", to: "portfolio", rel: "supports", label: "社内の成果を事例に（許可の範囲で）" },
  { from: "ad-pattern", to: "portfolio", rel: "supports", label: "SpellDash の数字が営業材料に" },
  { from: "members300", to: "when-indep", rel: "supports", label: "収入の柱が増え、独立の不安が減る" },
  { from: "leader", to: "when-indep", rel: "blocks", label: "責任が増え、副業の時間が減る" },

  // 独立
  { from: "learn-ads", to: "side-gigs", label: "副業の土台" },
  { from: "side-gigs", to: "portfolio" },
  { from: "portfolio", to: "when-indep" },
  { from: "when-indep", to: "go-indep", rel: "condition", cond: "副業の月収 30 万円が 3 か月続いたら", scen: ["early"] },
  { from: "when-indep", to: "stay", rel: "condition", cond: "条件に届かなければ", scen: ["base", "focus"] },
  { from: "go-indep", to: "indep-goal" },
  { from: "stay", to: "indep-goal", label: "時期は遅れても届く", scen: ["base"] },
  { from: "go-indep", to: "referrals" },
  { from: "referrals", to: "portfolio", rel: "feedback", label: "実績がさらに増える" },
];

export function buildDemoDoc(): DocData {
  const doc = createEmptyDoc("わたしの未来の分岐（デモ）");
  const projects = {
    spell: makeProject({ id: "p_spelldash", name: "SpellDash事業", color: "#FF7A59", description: "英単語学習ゲーム SpellDash を事業として伸ばす。" }),
    fc: makeProject({ id: "p_fcmarketing", name: "FCマーケティングでの業務", color: "#22D3EE", description: "会社での広告運用の仕事。成果と評価を積み上げる。" }),
    ind: makeProject({ id: "p_independence", name: "広告運用事業での独立", color: "#A3E635", description: "広告運用代行として独立し、収入の柱を作る。" }),
  };
  const scenarios = {
    base: makeScenario({ id: "s_balance", name: "両立（基本）", color: "#8B7BFF", description: "会社員を続けながら、SpellDash と副業を同時に育てる。" }),
    early: makeScenario({ id: "s_early", name: "早期独立", color: "#F2C14E", description: "2027 年中に副業の条件を満たし、独立する。" }),
    focus: makeScenario({ id: "s_focus", name: "SpellDash集中", color: "#4FD1E8", description: "広告に頼らずオーガニックで伸ばし、SpellDash に時間を寄せる。" }),
  };
  for (const p of Object.values(projects)) {
    doc.projects[p.id] = p;
    doc.projectOrder.push(p.id);
  }
  for (const s of Object.values(scenarios)) {
    doc.scenarios[s.id] = s;
    doc.scenarioOrder.push(s.id);
  }
  const ids = new Map<string, string>();
  for (const n of NODES) {
    const node: GNode = makeNode({
      id: `n_demo_${n.id.replace(/-/g, "_")}`,
      type: n.type,
      title: n.title,
      body: n.body ?? "",
      status: n.status ?? "open",
      time: { due: n.due ?? null, start: n.start ?? null },
      conditions: (n.cond ?? []).map(([t, met]) => makeCondition(t, met)),
      tags: n.tags ?? [],
      projectIds: n.p.map((k) => projects[k].id),
      scenarioIds: (n.scen ?? []).map((k) => scenarios[k].id),
      x: n.x,
      y: n.y,
    });
    doc.nodes[node.id] = node;
    ids.set(n.id, node.id);
  }
  for (const e of EDGES) {
    const source = ids.get(e.from);
    const target = ids.get(e.to);
    if (!source || !target) throw new Error(`デモの接続の端が無い: ${e.from} → ${e.to}`);
    const edge = makeEdge({
      id: `e_demo_${e.from.replace(/-/g, "_")}__${e.to.replace(/-/g, "_")}`,
      source,
      target,
      relation: e.rel ?? "leads",
      label: e.label ?? "",
      condition: e.cond ?? "",
      scenarioIds: (e.scen ?? []).map((k) => scenarios[k].id),
    });
    doc.edges[edge.id] = edge;
  }
  return doc;
}

// ------------------------------------------------------------ 何もしていないデモか

/** 中身の指紋（位置・折りたたみ・時刻・接続や条件の ID は除く。動かしただけ・畳んだだけのデモは同じ） */
function contentSignature(doc: DocData): string {
  const nodes = Object.values(doc.nodes)
    .map((n) => [n.id, n.type, n.title, n.body, n.status, n.time.due, n.time.start, n.conditions.map((c) => [c.text, c.met]), n.tags, n.projectIds, n.scenarioIds])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const edges = Object.values(doc.edges)
    .map((e) => [e.source, e.target, e.relation, e.label, e.condition, e.scenarioIds])
    .sort((a, b) => `${a[0]}>${a[1]}`.localeCompare(`${b[0]}>${b[1]}`));
  const groups = (m: DocData["projects"] | DocData["scenarios"]) =>
    Object.values(m)
      .map((g) => [g.id, g.name, g.color, g.description])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify([doc.title, nodes, edges, groups(doc.projects), groups(doc.scenarios)]);
}

let demoSignature: string | null = null;

/**
 * 捨ててよい中身か: 初回のデモに何も足していない（動かした・畳んだだけ）か、まっさらな空
 * （ノード・接続・プロジェクト・シナリオが無く、名前も付けていない）。
 * 初めての同期で、聞かずにもう一方を採ってよい。プロジェクトだけ作った・名前だけ付けた物は捨てない
 */
export function isDisposableDoc(doc: DocData): boolean {
  const blank =
    Object.keys(doc.nodes).length === 0 &&
    Object.keys(doc.edges).length === 0 &&
    Object.keys(doc.projects).length === 0 &&
    Object.keys(doc.scenarios).length === 0 &&
    doc.title === DEFAULT_DOC_TITLE;
  if (blank) return true;
  demoSignature ??= contentSignature(buildDemoDoc());
  return contentSignature(doc) === demoSignature;
}
