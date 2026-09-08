import { getStreak } from "./level.js";
import { getLearnedWordsToday } from "./learnedWords.js";
import { getSetsToday } from "./dailySet.js";
import { getLearnedWordList } from "./learnedWords.js";
import { computeCategoryProgress } from "./categoryProgress.js";
import { getGrowthLog } from "./growthLog.js";

// ===== 今日のセット完了のシェア（語が載る1枚） =====
// 数字だけでなく「今日覚えた語」を載せる。勉強している自分をそのまま出せる画像にする。

export function buildSetShareData({ recalled = 0 } = {}) {
  const learned = getLearnedWordsToday().slice(0, 5);
  const d = new Date();
  return {
    date: `${d.getMonth() + 1}/${d.getDate()}`,
    recalled,
    sets: getSetsToday(),
    learned,
    streak: getStreak().current
  };
}

export function buildSetShareText(data = buildSetShareData()) {
  const lines = [`SpellDash 今日のセット ${data.date} ✓`];
  lines.push(`🧠 ${data.recalled}語 思い出せた${data.sets > 1 ? `（${data.sets}セット）` : ""}${data.streak > 0 ? ` / 🔥 ${data.streak}日連続` : ""}`);
  if (data.learned.length > 0) lines.push(`✨ 今日覚えた: ${data.learned.map((w) => w.en).join(", ")}`);
  lines.push("今日も、はちゃんと少しだけ。");
  lines.push("https://www.spelldash.net");
  return lines.join("\n");
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

export function buildSetShareImage(data = buildSetShareData()) {
  const W = 1080;
  const H = 1080;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.8, H * 0.15, 60, W * 0.8, H * 0.15, 700);
  glow.addColorStop(0, "rgba(250,204,21,0.28)");
  glow.addColorStop(1, "rgba(250,204,21,0)");
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
  ctx.font = "800 56px sans-serif";
  ctx.fillText(`今日のセット ${data.date} ✓`, 80, 290);

  ctx.fillStyle = "#f8fafc";
  ctx.font = "800 190px sans-serif";
  ctx.fillText(`${data.recalled}`, 80, 470);
  const w = ctx.measureText(`${data.recalled}`).width;
  ctx.fillStyle = "#94a3b8";
  ctx.font = "700 56px sans-serif";
  ctx.fillText("語 思い出せた", 80 + w + 24, 490);

  let y = 620;
  if (data.learned.length > 0) {
    ctx.fillStyle = "#fde68a";
    ctx.font = "700 44px sans-serif";
    ctx.fillText("✨ 今日覚えた", 80, y);
    y += 80;
    ctx.font = "800 60px sans-serif";
    for (const word of data.learned) {
      ctx.fillStyle = "#f8fafc";
      ctx.fillText(word.en, 80, y);
      const ww = ctx.measureText(word.en).width;
      ctx.fillStyle = "#94a3b8";
      ctx.font = "600 36px sans-serif";
      ctx.fillText(word.ja.slice(0, 14), 80 + ww + 28, y + 8);
      ctx.font = "800 60px sans-serif";
      y += 74;
    }
  } else {
    ctx.fillStyle = "#cbd5e1";
    ctx.font = "700 44px sans-serif";
    ctx.fillText("思い出して打つから、英単語が残る。", 80, y);
  }

  if (data.streak > 0) {
    ctx.fillStyle = "#fb923c";
    ctx.font = "700 48px sans-serif";
    ctx.fillText(`🔥 ${data.streak}日連続`, 80, H - 150);
  }
  ctx.fillStyle = "#64748b";
  ctx.font = "600 40px sans-serif";
  ctx.fillText("spelldash.net", 80, H - 70);
  return canvas;
}

// ===== 累計の一枚絵（「SpellDashで覚えた語 312」） =====
export function buildTotalShareData() {
  // マイ単語帳も含めて、覚えた語を語の単位で数える（カテゴリ間の重複は1回）
  const list = getLearnedWordList();
  const days = getGrowthLog().filter((e) => e.active).length;
  return {
    learned: list.length,
    mastered: list.filter((w) => w.status === "mastered").length,
    total: computeCategoryProgress()[0]?.total ?? 0,
    days,
    streak: getStreak().current,
    best: getStreak().best,
    recent: list.slice(0, 5)
  };
}

export function buildTotalShareText(d = buildTotalShareData()) {
  return [
    `SpellDashで覚えた英単語 ${d.learned}語（習得 ${d.mastered}）`,
    `📅 学習 ${d.days}日${d.best > 1 ? ` / 最長 ${d.best}日連続` : ""}`,
    d.recent.length ? `最近覚えた: ${d.recent.map((w) => w.en).join(", ")}` : null,
    "思い出して打つから、英単語が残る。",
    "https://www.spelldash.net"
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildTotalShareImage(d = buildTotalShareData()) {
  const W = 1080;
  const H = 1080;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.2, H * 0.85, 60, W * 0.2, H * 0.85, 700);
  glow.addColorStop(0, "rgba(96,165,250,0.3)");
  glow.addColorStop(1, "rgba(96,165,250,0)");
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
  ctx.font = "700 48px sans-serif";
  ctx.fillText("これまでに覚えた英単語", 80, 300);
  ctx.fillStyle = "#f8fafc";
  ctx.font = "800 220px sans-serif";
  ctx.fillText(`${d.learned}`, 80, 470);
  const w = ctx.measureText(`${d.learned}`).width;
  ctx.fillStyle = "#94a3b8";
  ctx.font = "700 60px sans-serif";
  ctx.fillText("語", 80 + w + 24, 500);

  ctx.fillStyle = "#cbd5e1";
  ctx.font = "600 42px sans-serif";
  ctx.fillText(`🏆 習得 ${d.mastered}   📅 学習 ${d.days}日${d.best > 1 ? `   🔥 最長 ${d.best}日連続` : ""}`, 80, 640);

  let y = 740;
  if (d.recent.length) {
    ctx.fillStyle = "#fde68a";
    ctx.font = "700 40px sans-serif";
    ctx.fillText("最近覚えた", 80, y);
    y += 66;
    ctx.font = "800 52px sans-serif";
    ctx.fillStyle = "#f8fafc";
    ctx.fillText(d.recent.map((r) => r.en).join("  ·  ").slice(0, 60), 80, y);
  }
  ctx.fillStyle = "#64748b";
  ctx.font = "600 40px sans-serif";
  ctx.fillText("spelldash.net", 80, H - 70);
  return canvas;
}

export async function shareTotalResult(d = buildTotalShareData()) {
  return shareWithImage(buildTotalShareText(d), () => buildTotalShareImage(d), "spelldash-total.png");
}

async function shareWithImage(text, makeCanvas, filename) {
  if (navigator.share) {
    try {
      const blob = await new Promise((resolve) => makeCanvas().toBlob(resolve, "image/png"));
      if (blob) {
        const file = new File([blob], filename, { type: "image/png" });
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
      return "cancelled";
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return "copied";
  } catch {
    return "failed";
  }
}

export async function shareSetResult(data = buildSetShareData()) {
  const text = buildSetShareText(data);
  if (navigator.share) {
    try {
      const blob = await new Promise((resolve) => buildSetShareImage(data).toBlob(resolve, "image/png"));
      if (blob) {
        const file = new File([blob], "spelldash-today.png", { type: "image/png" });
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
      return "cancelled";
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return "copied";
  } catch {
    return "failed";
  }
}
