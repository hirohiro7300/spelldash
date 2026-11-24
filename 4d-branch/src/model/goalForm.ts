// 資産のゴールの前提の欄（src/ui/goalPanel.ts）の言葉と、入れた文字の読み方（DOM を使わない。テストで確かめる）。
// 設計: 作業メモ goal/design.md §4.7。入れない欄は仮（文書に書かない）。範囲の外は直さずに知らせる（黙って収めない）

import { byYearOf, DEFAULT_GOAL, formatOku, GOAL_KEYS, GOAL_RANGE, goalStored, MAP_MONTHS, type GoalAnchor, type GoalConfig, type GoalKey, type GoalStored } from "./goal";

export interface GoalField {
  key: GoalKey;
  label: string;
  unit: string;
  hint: string;
  /** 欄の値 1 → 万円（目標は億円で入れる）。期限・割合は 1 */
  scale: number;
  /** 入れられる範囲（欄の単位で） */
  min: number;
  max: number;
  /** 整数だけ（期限の年） */
  integer: boolean;
}

/** 3 桁ごとに区切る */
const commas = (x: number): string => {
  const [i, d] = String(x).split(".");
  return `${i!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${d ? `.${d}` : ""}`;
};

/** 欄の並び（地図の 0 か月目の年で、期限の範囲が決まる） */
export function goalFields(anchor: GoalAnchor): GoalField[] {
  const y0 = anchor.y;
  const y36 = y0 + MAP_MONTHS / 12;
  const [byLo, byHi] = GOAL_RANGE.by;
  const r = (k: Exclude<GoalKey, "by">) => GOAL_RANGE[k];
  return [
    { key: "target", label: "目標の資産", unit: "億円", hint: `${commas(r("target")[0] / 10_000)}〜${commas(r("target")[1] / 10_000)} 億円`, scale: 10_000, min: r("target")[0] / 10_000, max: r("target")[1] / 10_000, integer: false },
    {
      key: "assets",
      label: "今の資産（預金・投資の合計）",
      unit: "万円",
      hint: "空欄は 0 で計算。あなたの地図の保存先（年収と同じ）にだけ残り、画像や共有リンクには入りません",
      scale: 1,
      min: r("assets")[0],
      max: r("assets")[1],
      integer: false,
    },
    { key: "save", label: "積み立てに回す割合", unit: "%（額面の稼ぎのうち）", hint: `${r("save")[0]}〜${r("save")[1]}%`, scale: 1, min: r("save")[0], max: r("save")[1], integer: false },
    { key: "ret", label: "運用の利回り", unit: "%／年", hint: `${r("ret")[0]}〜${r("ret")[1]}%。ふつうは 3〜5%`, scale: 1, min: r("ret")[0], max: r("ret")[1], integer: false },
    {
      key: "bizGrow",
      label: "3 年後からの事業の伸び",
      unit: "%／年",
      hint: `−${-r("bizGrow")[0]}〜${r("bizGrow")[1]}%。0 は「3 年後の事業の稼ぎがそのまま続く」。給与は据え置きで計算します`,
      scale: 1,
      min: r("bizGrow")[0],
      max: r("bizGrow")[1],
      integer: false,
    },
    { key: "by", label: "期限", unit: "年", hint: `${y0 + byLo}〜${y0 + byHi} 年（地図が 3 年分のため、${y36} 年より先）`, scale: 1, min: y0 + byLo, max: y0 + byHi, integer: true },
  ];
}

/** 欄の今の値（入れた物だけ。仮の欄は空） */
export function goalFieldValue(f: GoalField, cfg: Readonly<GoalConfig>, assumed: ReadonlySet<GoalKey>, anchor: GoalAnchor): string {
  if (assumed.has(f.key)) return "";
  const v = f.key === "by" ? byYearOf(cfg, anchor.y) : cfg[f.key];
  return String(Math.round((v / f.scale) * 1e4) / 1e4);
}

/** 欄の仮の値（入れていないときの薄い字） */
export function goalFieldPlaceholder(f: GoalField, anchor: GoalAnchor): string {
  const v = f.key === "by" ? byYearOf(DEFAULT_GOAL, anchor.y) : DEFAULT_GOAL[f.key];
  return String(v / f.scale);
}

export type GoalParse = { ok: true; value: number | null } | { ok: false; error: string };

/** 欄の文字を読む（空は仮。全角・カンマ・単位・マイナスの記号を許す）。範囲の外・数でない物は知らせる */
export function parseGoalField(f: GoalField, input: string): GoalParse {
  const s = input
    .normalize("NFKC")
    .replace(/[−‐‑–—ー]/g, "-")
    .replace(/[,\s]/g, "")
    .replace(/(?:億円|万円|億|万|円|%|％|年)$/, "");
  if (s === "") return { ok: true, value: null };
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return { ok: false, error: `${f.label}は数で入れてください` };
  const x = Number(s);
  const range = f.key === "by" ? `${f.min}〜${f.max} 年` : `${f.min < 0 ? `−${-f.min}` : commas(f.min)}〜${commas(f.max)}${f.unit.startsWith("%") ? "%" : ` ${f.unit}`}`;
  if (!Number.isFinite(x) || x < f.min || x > f.max) {
    const why = f.key === "by" ? `（地図が 3 年分のため、${f.min - 1} 年より先）` : "";
    return { ok: false, error: `${f.label}は ${range}の間で入れてください${why}` };
  }
  if (f.integer && !Number.isInteger(x)) return { ok: false, error: `${f.label}は年（整数）で入れてください` };
  return { ok: true, value: x * f.scale };
}

/** 欄の文字（鍵ごと）を文書に書く形にする。どれかが読めなければ、その欄と知らせ */
export function goalFromInputs(fields: readonly GoalField[], inputs: Readonly<Partial<Record<GoalKey, string>>>): { ok: true; stored: GoalStored | null } | { ok: false; key: GoalKey; error: string } {
  const values: Partial<Record<GoalKey, number>> = {};
  for (const f of fields) {
    const p = parseGoalField(f, inputs[f.key] ?? "");
    if (!p.ok) return { ok: false, key: f.key, error: p.error };
    if (p.value !== null) values[f.key] = p.value;
  }
  const stored = goalStored(values);
  return { ok: true, stored: GOAL_KEYS.some((k) => stored[k] !== undefined) ? stored : null };
}

/** 文書の meta.goal と同じ中身か（鍵の順によらない） */
export function sameGoal(a: unknown, b: GoalStored | null): boolean {
  const norm = (x: unknown): string => {
    if (!x || typeof x !== "object" || Array.isArray(x)) return "null";
    const g = x as Record<string, unknown>;
    if (g.v !== 1) return "null";
    const s = goalStored(Object.fromEntries(GOAL_KEYS.map((k) => [k, typeof g[k] === "number" ? (g[k] as number) : undefined])));
    return GOAL_KEYS.some((k) => s[k] !== undefined) ? JSON.stringify(s) : "null";
  };
  return norm(a) === norm(b);
}

/** 概要の見出しの 1 行（「ゴール 資産 10 億円・2056 年まで（前提 5 つは仮）」の、ゴールの後ろと仮の数） */
export function goalViewRow(cfg: Readonly<GoalConfig>, assumed: ReadonlySet<GoalKey>, anchor: GoalAnchor): { name: string; by: string; kari: string | null } {
  const n = [...assumed].filter((k) => k !== "target").length;
  return { name: `資産 ${formatOku(cfg.target)}`, by: `・${byYearOf(cfg, anchor.y)} 年まで`, kari: n > 0 ? `（前提 ${n} つは仮）` : null };
}
