// 3 年の影響の数の書き方と色の段。設計: docs/DESIGN.md §4.7
// 万円の数は「±0」「+3.1万」「+65万」「−1,240万」「+1.2億」の形。差は必ず符号を付け、水準（3 年の合計など）は付けない。

/** 段の境目（万円）。|x| が 3 未満は「ほぼ同じ」（0 段）、3〜30 が 1 段（給与 1 か月分まで）、30〜100 が 2 段、100〜300 が 3 段、300 以上が 4 段（年収分） */
export const IMPACT_T = [3, 30, 100, 300] as const;

/** 段ごとの塗り（−4〜+4。0 はほぼ同じ）。青 = 良くなる・赤 = 悪くなる（色の見え方の違いでも区別できる組） */
export const IMPACT_FILL: Readonly<Record<number, string>> = {
  [-4]: "#EA9A96",
  [-3]: "#DD706E",
  [-2]: "#B1393E",
  [-1]: "#892B2E",
  0: "#383835",
  1: "#184F95",
  2: "#1C68BF",
  3: "#5598E7",
  4: "#86B6EF",
};

/** 段ごとの文字の色（塗りの上で 4.5:1 以上） */
export const IMPACT_INK: Readonly<Record<number, string>> = {
  [-4]: "#0B0E14",
  [-3]: "#0B0E14",
  [-2]: "#F0EFEC",
  [-1]: "#F0EFEC",
  0: "#F0EFEC",
  1: "#F0EFEC",
  2: "#F0EFEC",
  3: "#0B0E14",
  4: "#0B0E14",
};

/** ほぼ同じ（0 段）の枠の色 */
export const IMPACT_NEUTRAL_RING = "#6B7280";

/** 万円の差を段（−4〜+4）に分ける。数が無ければ 0 */
export function impactBin(x: number | null | undefined): number {
  if (x === null || x === undefined || !Number.isFinite(x)) return 0;
  const a = Math.abs(x);
  let step = 0;
  for (const t of IMPACT_T) if (a >= t) step++;
  return x < 0 ? -step : step;
}

export const MINUS = "−";

function groupDigits(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * 万円の数を書く。signed なら差として符号を付ける（「±0」「+3.1万」「−65万」）。
 * 10 万円未満は小数 1 桁（.0 は落とす）、1 億円未満は整数（3 桁ごとに区切る）、それ以上は億
 */
export function formatMan(x: number, signed = true): string {
  if (!Number.isFinite(x)) return "—";
  const a = Math.abs(x);
  if (signed && a < 0.05) return "±0";
  const sign = signed ? (x < 0 ? MINUS : "+") : x < 0 ? MINUS : "";
  let body: string;
  if (a < 10) body = `${(Math.round(a * 10) / 10).toFixed(1).replace(/\.0$/, "")}万`;
  else if (a < 9999.5) body = `${groupDigits(a)}万`;
  else body = `${(Math.round(a / 1000) / 10).toFixed(1).replace(/\.0$/, "")}億`;
  return sign + body;
}

/** 月の稼ぎの差（「月+2.1万」） */
export function formatMonthlyDelta(x: number): string {
  return `月${formatMan(x, true)}`;
}

/** 月の稼ぎの水準（「月 42万」） */
export function formatMonthly(x: number): string {
  return `月 ${formatMan(x, false)}`;
}

/** 割合（0〜1）を整数の %（1% 未満は「1%」、0 は「0%」） */
export function formatShare(p: number): string {
  if (!(p > 0)) return "0%";
  const v = Math.round(p * 100);
  return `${Math.max(1, Math.min(100, v))}%`;
}
