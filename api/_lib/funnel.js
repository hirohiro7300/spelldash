// ===== Pro までの動線の集計（/api/admin/funnel と検証スクリプトで共用） =====
// rows: funnel_events の { device_id, step, source, day }。段階ごとに「端末の数」（同じ端末は 1）を 7 日・30 日で数える。
// 入口（step = entry）は source ごとにも数える。

export const FUNNEL_ORDER = ["first_visit", "day7", "entry", "pro_view", "login_click", "login_return", "checkout_start", "checkout_done"];
export const FUNNEL_SIDE = ["checkout_cancel"];

function addDaysUtc(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

export function summarizeFunnel(rows, today) {
  const since7 = addDaysUtc(today, -6);
  const since30 = addDaysUtc(today, -29);
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
    days7: counts(sets.d7),
    days30: counts(sets.d30),
    sources7: bySource(sources.d7),
    sources30: bySource(sources.d30)
  };
}
