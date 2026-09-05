import { getWordStats, getSessionLog } from "./storage.js";
import { getStreak } from "./level.js";
import { computeCategoryProgress } from "./categoryProgress.js";
import { getActiveDaysLast7, getLearnedDelta7 } from "./growthLog.js";
import { hasumiWeeklyLine, hasumiBubbleHtml } from "./hasumi.js";

// ===== 週間レポート（直近7日） =====
// 「自分は前進している」証拠を週に一度まとめて見せる。
// 数字は端末内の学習記録から算出（サーバー不要）。

const DAY = 86400000;

export function computeWeeklyReport() {
  const now = Date.now();
  const since = now - 7 * DAY;
  const stats = getWordStats();

  let recalled = 0;
  let failed = 0;
  let reviewOk = 0;
  let reviewNg = 0;
  for (const s of Object.values(stats)) {
    if (s.lastRecallSuccessAt && Date.parse(s.lastRecallSuccessAt) >= since) recalled++;
    if (s.lastRecallFailAt && Date.parse(s.lastRecallFailAt) >= since) failed++;
    if (s.lastReviewAt && Date.parse(s.lastReviewAt) >= since) {
      if (s.lastReviewResult === "ok") reviewOk++;
      else if (s.lastReviewResult === "ng") reviewNg++;
    }
  }

  const all = computeCategoryProgress()[0];
  const learnedDelta = getLearnedDelta7(all.learned);
  const activeDays = getActiveDaysLast7();

  const runs = getSessionLog().filter((e) => (Date.parse(e.at ?? 0) || 0) >= since);
  const bestScore = runs.length ? Math.max(...runs.map((e) => e.score)) : 0;

  const retention = reviewOk + reviewNg > 0 ? Math.round((reviewOk / (reviewOk + reviewNg)) * 100) : null;
  const recallRate = recalled + failed > 0 ? Math.round((recalled / (recalled + failed)) * 100) : null;

  const start = new Date(since);
  const end = new Date(now);
  const fmt = (d) => `${d.getMonth() + 1}/${d.getDate()}`;

  return {
    range: `${fmt(start)}〜${fmt(end)}`,
    activeDays,
    learnedDelta,
    learnedTotal: all.learned,
    recalled,
    failed,
    recallRate,
    retention,
    reviewCount: reviewOk + reviewNg,
    bestScore,
    streak: getStreak().current
  };
}

export function buildWeeklyShareText(r = computeWeeklyReport()) {
  const lines = [`SpellDash 週間レポート ${r.range}`];
  lines.push(`📚 学習 ${r.activeDays}/7日 ・ 🧠 覚えた +${r.learnedDelta}語（累計 ${r.learnedTotal}）`);
  const rate = r.retention ?? r.recallRate;
  if (rate != null) lines.push(`↻ 思い出せた率 ${rate}%${r.streak > 0 ? ` ・ 🔥 ${r.streak}日連続` : ""}`);
  else if (r.streak > 0) lines.push(`🔥 ${r.streak}日連続`);
  if (r.bestScore > 0) lines.push(`⏱ 今週のベスト ${r.bestScore}`);
  lines.push("今日も、はちゃんと少しだけ。");
  lines.push("https://www.spelldash.net");
  return lines.join("\n");
}

export function renderWeeklyReport(containerId, { compact = false } = {}) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const r = computeWeeklyReport();
  const rate = r.retention ?? r.recallRate;

  el.innerHTML = `
    <div class="weekly__head">
      <span class="weekly__title">📅 週間レポート</span>
      <span class="weekly__range">${r.range}</span>
    </div>
    ${compact ? "" : hasumiBubbleHtml(hasumiWeeklyLine(r), "hasumi--result")}
    <div class="weekly__grid">
      <div><span>学習した日</span><strong>${r.activeDays}<small> / 7</small></strong></div>
      <div><span>覚えた</span><strong>+${r.learnedDelta}<small> 語</small></strong></div>
      <div><span>思い出せた率</span><strong>${rate == null ? "–" : `${rate}<small>%</small>`}</strong></div>
      <div><span>ベスト</span><strong>${r.bestScore || "–"}</strong></div>
    </div>
    ${r.retention != null ? `<p class="weekly__note">思い出せた率＝1日以上前に覚えた語を復習で思い出せた割合（${r.reviewCount}語）</p>` : ""}
    <div class="weekly__actions">
      <button type="button" class="result-panel__action" data-weekly-share>レポートをシェア</button>
      ${compact ? `<a class="result-panel__action result-panel__action--ghost" href="./stats.html#weekly">くわしく見る</a>` : ""}
    </div>
  `;

  el.querySelector("[data-weekly-share]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const outcome = await shareWeeklyReport().catch(() => "failed");
    if (outcome === "copied") button.textContent = "コピーしました！SNSに貼り付けてね";
    if (outcome === "failed") button.textContent = "シェアできませんでした";
  });
}

export function buildWeeklyReportImage(r = computeWeeklyReport()) {
  const W = 1080;
  const H = 1080;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.2, H * 0.1, 60, W * 0.2, H * 0.1, 700);
  glow.addColorStop(0, "rgba(59,130,246,0.35)");
  glow.addColorStop(1, "rgba(59,130,246,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  const grad = ctx.createLinearGradient(80, 80, 176, 176);
  grad.addColorStop(0, "#3b82f6");
  grad.addColorStop(1, "#6366f1");
  ctx.fillStyle = grad;
  roundRect(ctx, 80, 80, 96, 96, 26);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "800 40px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("SD", 128, 130);
  ctx.textAlign = "left";
  ctx.font = "800 56px sans-serif";
  ctx.fillText("SpellDash", 208, 130);

  ctx.fillStyle = "#93c5fd";
  ctx.font = "800 60px sans-serif";
  ctx.fillText(`週間レポート ${r.range}`, 80, 300);

  ctx.fillStyle = "#f8fafc";
  ctx.font = "800 200px sans-serif";
  ctx.fillText(`+${r.learnedDelta}`, 80, 500);
  const w = ctx.measureText(`+${r.learnedDelta}`).width;
  ctx.fillStyle = "#94a3b8";
  ctx.font = "700 56px sans-serif";
  ctx.fillText("語 覚えた", 80 + w + 24, 520);

  const rate = r.retention ?? r.recallRate;
  const rows = [
    `📚 学習した日  ${r.activeDays} / 7`,
    rate == null ? null : `↻ 思い出せた率  ${rate}%`,
    r.streak > 0 ? `🔥 ${r.streak}日連続` : null,
    r.bestScore > 0 ? `⏱ 今週のベスト  ${r.bestScore}` : null
  ].filter(Boolean);
  ctx.fillStyle = "#e2e8f0";
  ctx.font = "700 52px sans-serif";
  rows.forEach((line, i) => ctx.fillText(line, 80, 660 + i * 84));

  ctx.fillStyle = "#64748b";
  ctx.font = "600 40px sans-serif";
  ctx.fillText("spelldash.net", 80, H - 70);
  return canvas;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export async function shareWeeklyReport() {
  const text = buildWeeklyShareText();
  if (navigator.share) {
    try {
      const blob = await new Promise((resolve) => buildWeeklyReportImage().toBlob(resolve, "image/png"));
      if (blob) {
        const file = new File([blob], "spelldash-weekly.png", { type: "image/png" });
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ text, files: [file] });
          return "shared";
        }
      }
    } catch {
      // 画像共有に失敗したらテキストへ
    }
    try {
      await navigator.share({ text });
      return "shared";
    } catch {
      // キャンセル等 → コピーへ
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return "copied";
  } catch {
    return "failed";
  }
}
