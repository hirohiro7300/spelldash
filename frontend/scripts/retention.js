// ===== 記憶の保持率（学習データ「今週」タブの 1 枚） =====
// この端末の記録（spelldash_retention・spelldash_study_time）を読み、js/retentionCalc.js で集計して描く。
// 実測だけを出す。予測の数字は出さない（docs/SPEC_RETENTION.md）。
// 週間レポートの「思い出せた率」（今週の復習の成功率）とは別の指標なので、注記で区別する。

import { computeRetention, localDay } from "./retentionCalc.js";
import { getRetentionRecords } from "./retentionLog.js";
import { getStudySecondsByDay } from "./studyTime.js";

const LEAD = "覚えた日から 7 日後・30 日後に、最初に答えたとき思い出せた割合。実測。";
const NOTE =
  "7 日後＝覚えた日の 6〜8 日後、30 日後＝27〜33 日後の最初の回答。復習＝その前に別の日に答えた日数。窓に出題されなかった語は未測定。週間レポートの思い出せた率（今週の復習の成功率）とは別。復習の予定は翌日から入るので、続けた人の語は復習ありに寄る。";

export function computeRetentionReport() {
  return computeRetention(getRetentionRecords(), getStudySecondsByDay(), { today: localDay(new Date()) });
}

function pct(bucket) {
  return bucket.n > 0 ? `${Math.round((bucket.ok / bucket.n) * 100)}<small>%</small>` : "–";
}

function wordCount(n7, n30) {
  return `${n7}<small> 語</small>${n30 > 0 ? `<small>（30 日 ${n30} 語）</small>` : ""}`;
}

function formatSince(ymd) {
  const [y, m, d] = String(ymd).split("-").map(Number);
  return Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d) ? `${y}/${m}/${d}` : ymd;
}

export function renderRetention(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  let r = null;
  try {
    r = computeRetentionReport();
  } catch {
    r = null;
  }
  if (!r) {
    el.innerHTML = `<p class="muted">${LEAD}</p>`;
    return;
  }

  // 0 の行は出さない
  const rows = [];
  if (r.d7.none.n > 0) rows.push(["7 日後（復習なし）", pct(r.d7.none)]);
  if (r.d7.some.n > 0) rows.push(["7 日後（復習あり）", pct(r.d7.some)]);
  if (r.d30.none.n > 0) rows.push(["30 日後（復習なし）", pct(r.d30.none)]);
  if (r.d30.some.n > 0) rows.push(["30 日後（復習あり）", pct(r.d30.some)]);
  if (r.d7.measured + r.d30.measured > 0) rows.push(["測定した語", wordCount(r.d7.measured, r.d30.measured)]);
  if (r.d7.unmeasured + r.d30.unmeasured > 0) rows.push(["未測定", wordCount(r.d7.unmeasured, r.d30.unmeasured)]);
  if (r.retained > 0) rows.push(["1 時間で定着", r.perHour == null ? "–" : `${Math.round(r.perHour * 10) / 10}<small> 語</small>`]);

  el.innerHTML = `
    <p class="muted">${LEAD}</p>
    ${rows.length > 0
      ? `<div class="weekly__grid">${rows.map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("")}</div>
    <p class="weekly__note">${NOTE}</p>`
      : `<p class="weekly__note">覚えた語が 7 日たつと、保持率がここに出る。測定は ${formatSince(r.since)} 以降に覚えた語。</p>`}
  `;
}
