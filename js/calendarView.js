import { getGrowthLog } from "./growthLog.js";
import { getSessionLog } from "./storage.js";
import { localDateString } from "./stats.js";

// ===== 学習カレンダー（直近13週） =====
// 「学習した日」を草として見せる。積み上がりの証拠。
// 濃さ: 学習した日=1、セット完了やChallenge/Dailyの回数が多い日ほど濃く（最大4）

const WEEKS = 13;

function loadSetHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem("spelldash_daily_set") || "{}");
    return Array.isArray(raw.history) ? raw.history : [];
  } catch {
    return [];
  }
}

export function computeCalendarDays(weeks = WEEKS) {
  const active = new Map();
  for (const e of getGrowthLog()) if (e.active) active.set(e.date, { learned: e.learned ?? 0, score: 1 });
  for (const date of loadSetHistory()) {
    const cur = active.get(date) ?? { learned: 0, score: 0 };
    cur.score += 1;
    cur.set = true;
    active.set(date, cur);
  }
  for (const e of getSessionLog()) {
    const date = e.at ? localDateString(new Date(e.at)) : null;
    if (!date) continue;
    const cur = active.get(date) ?? { learned: 0, score: 0 };
    cur.score += 1;
    cur.runs = (cur.runs ?? 0) + 1;
    active.set(date, cur);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = (today.getDay() + 6) % 7; // 月曜=0
  const start = new Date(today);
  start.setDate(today.getDate() - dow - (weeks - 1) * 7);

  const days = [];
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = localDateString(d);
    const info = active.get(key);
    days.push({
      date: key,
      level: info ? Math.min(4, info.score) : 0,
      learned: info?.learned ?? null,
      isToday: d.getTime() === today.getTime(),
      isFuture: d.getTime() > today.getTime(),
      month: d.getDate() === 1 || i === 0 ? d.getMonth() + 1 : null
    });
  }
  const activeDays = days.filter((d) => d.level > 0).length;
  return { days, activeDays, weeks };
}

export function renderCalendar(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const { days, activeDays, weeks } = computeCalendarDays();

  // 列＝週、行＝曜日（月〜日）。CSS grid で列方向に流す
  const cells = days
    .map(
      (d) =>
        `<i class="cal__day cal__day--${d.level}${d.isToday ? " cal__day--today" : ""}${d.isFuture ? " cal__day--future" : ""}" title="${d.date}${d.level > 0 ? " 学習した日" : ""}${d.learned != null ? `・覚えた ${d.learned}語` : ""}"></i>`
    )
    .join("");
  const months = [];
  days.forEach((d, i) => {
    if (d.month && i % 7 === 0) months.push({ col: Math.floor(i / 7), label: `${d.month}月` });
    else if (d.month && !months.some((m) => m.label === `${d.month}月`)) months.push({ col: Math.floor(i / 7), label: `${d.month}月` });
  });
  const monthRow = `<div class="cal__months" style="grid-template-columns: repeat(${weeks}, 1fr)">${Array.from({ length: weeks }, (_, c) => {
    const m = months.find((x) => x.col === c);
    return `<span>${m ? m.label : ""}</span>`;
  }).join("")}</div>`;

  el.innerHTML = `
    <div class="cal__summary">直近${weeks}週で <b>${activeDays}日</b> 学習</div>
    ${monthRow}
    <div class="cal" style="grid-template-columns: repeat(${weeks}, 1fr)">${cells}</div>
    <p class="cal__legend">少ない <i class="cal__day cal__day--1"></i><i class="cal__day cal__day--2"></i><i class="cal__day cal__day--3"></i><i class="cal__day cal__day--4"></i> 多い（セット完了・Challenge・Dailyの回数）</p>
  `;
}
