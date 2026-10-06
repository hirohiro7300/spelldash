// ===== Pro までの動線の集計（/api/admin/funnel と検証スクリプトで共用） =====
// rows: funnel_events の { device_id, step, source, day }。段階ごとに「端末の数」（同じ端末は 1）を 7 日・30 日で数える。
// 入口（step = entry）は source ごとにも数える。

import { addDays } from "./admin.js";

export const FUNNEL_ORDER = ["first_visit", "day7", "entry", "pro_view", "login_click", "login_return", "checkout_start", "checkout_done"];
export const FUNNEL_SIDE = ["checkout_cancel"];

// 割合を出す組（分母 → 分子）。並びの隣どうしは包含関係に無いので（ログイン済みはログインの 2 段を通らない、
// 7 日学んだ端末には以前から使っている人も入る）、意味のある組だけにする
export const FUNNEL_RATIOS = [
  { step: "pro_view", base: "entry" },
  { step: "login_return", base: "login_click" },
  { step: "checkout_start", base: "pro_view" },
  { step: "checkout_done", base: "checkout_start" }
];

export function summarizeFunnel(rows, today) {
  const since7 = addDays(today, -6);
  const since30 = addDays(today, -29);
  const sets = { d7: new Map(), d30: new Map() };
  const sources = { d7: new Map(), d30: new Map() };
  const add = (map, key, device) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(device);
  };
  for (const row of rows ?? []) {
    const day = String(row?.day ?? "").slice(0, 10);
    const device = String(row?.device_id ?? "");
    const step = String(row?.step ?? "");
    if (!device || !step || day < since30 || day > today) continue;
    const windows = day >= since7 ? ["d7", "d30"] : ["d30"];
    for (const w of windows) {
      add(sets[w], step, device);
      if (step === "entry") add(sources[w], String(row.source || "other"), device);
    }
  }
  const counts = (map) => Object.fromEntries([...FUNNEL_ORDER, ...FUNNEL_SIDE].map((s) => [s, map.get(s)?.size ?? 0]));
  const bySource = (map) =>
    [...map.entries()].map(([source, set]) => ({ source, devices: set.size })).sort((a, b) => b.devices - a.devices || a.source.localeCompare(b.source));
  return {
    today,
    steps: FUNNEL_ORDER,
    side: FUNNEL_SIDE,
    ratios: FUNNEL_RATIOS,
    days7: counts(sets.d7),
    days30: counts(sets.d30),
    sources7: bySource(sources.d7),
    sources30: bySource(sources.d30)
  };
}

// RPC admin_funnel_counts（docs/SQL_FUNNEL.md 2）の行 { win: "d7"|"d30", step, source, devices } を同じ形にする。
// source が空の行は段階の端末数、step = entry で source のある行は入口ごとの端末数
export function summarizeFunnelCounts(rows, today) {
  const empty = () => Object.fromEntries([...FUNNEL_ORDER, ...FUNNEL_SIDE].map((s) => [s, 0]));
  const out = { days7: empty(), days30: empty(), sources7: [], sources30: [] };
  for (const row of rows ?? []) {
    const win = row?.win === "d7" ? "7" : row?.win === "d30" ? "30" : null;
    if (!win) continue;
    const devices = Number(row.devices) || 0;
    const step = String(row.step ?? "");
    const source = String(row.source ?? "");
    if (source) {
      if (step === "entry") out[`sources${win}`].push({ source, devices });
    } else if (step in out[`days${win}`]) {
      out[`days${win}`][step] = devices;
    }
  }
  const sort = (list) => list.sort((a, b) => b.devices - a.devices || a.source.localeCompare(b.source));
  return { today, steps: FUNNEL_ORDER, side: FUNNEL_SIDE, ratios: FUNNEL_RATIOS, ...out, sources7: sort(out.sources7), sources30: sort(out.sources30) };
}
