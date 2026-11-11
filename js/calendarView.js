import { esc } from "./html.js";
import { getCoreDayGains } from "./growthLog.js";
import { getSessionLog } from "./storage.js";
import { localDateString } from "./stats.js";
import { getMyWords } from "./myWords.js";
import { myGainByDay } from "./myWordsCore.js";
import { dayNoOf } from "./retentionCalc.js";

// ===== 学習カレンダー（直近13週） =====
// 「学習した日」を草として見せる。積み上がりの証拠。
// 濃さ＝その日に覚えた語数（Batch 90: 学習状況の 覚えた と同じ数〔成長ログの core〕の、前の行との差。js/growthLog.js getCoreDayGains）。
//   学習した日で 0 語 → 1、1〜3 語 → 2、4〜7 語 → 3、8 語以上 → 4
// マイ単語帳で 覚えた（Batch 91。docs/SPEC_MY_WORDS.md §17）: その日に初めて 覚えた になり、今も 覚えた の語の数を title の後ろにだけ足す（濃さは英単語のまま）

const WEEKS = 13;

function levelOf(gained) {
  if (gained >= 8) return 4;
  if (gained >= 4) return 3;
  if (gained >= 1) return 2;
  return 1;
}

function loadSetHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem("spelldash_daily_set") || "{}");
    return Array.isArray(raw.history) ? raw.history : [];
  } catch {
    return [];
  }
}

// myList: マイ単語帳の語の並び（学習状況の 1 回の描画で 1 回だけ読んで渡す。渡さなければここで読む）
export function computeCalendarDays(weeks = WEEKS, myList = null) {
  // 学習した日 → その日に覚えた語数（前の core の行との差。この端末で数え始めた行は始まりの値 core0 から。分からない日は null: 濃さは最小・title に語数を出さない）
  const active = getCoreDayGains();
  // growth log の無い日でも、セット完了や Challenge・Daily の記録があれば学習した日（濃さは最小）
  for (const date of loadSetHistory()) if (!active.has(date)) active.set(date, { gained: 0 });
  for (const e of getSessionLog()) {
    const date = e.at ? localDateString(new Date(e.at)) : null;
    if (date && !active.has(date)) active.set(date, { gained: 0 });
  }

  const myByDay = myGainByDay(Array.isArray(myList) ? myList : getMyWords()); // 日番号 → マイ単語帳で 覚えた 語の数

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
      level: info ? levelOf(info.gained) : 0,
      gained: info ? info.gained : null,
      my: myByDay.get(dayNoOf(key)) ?? 0,
      isToday: d.getTime() === today.getTime(),
      isFuture: d.getTime() > today.getTime(),
      month: d.getDate() === 1 || i === 0 ? d.getMonth() + 1 : null
    });
  }
  return { days, weeks };
}

export function renderCalendar(containerId, { myList = null } = {}) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const { days, weeks } = computeCalendarDays(WEEKS, myList);

  // 列＝週、行＝曜日（月〜日）。CSS grid で列方向に流す
  const cells = days
    .map(
      (d) =>
        `<i class="cal__day cal__day--${d.level}${d.isToday ? " cal__day--today" : ""}${d.isFuture ? " cal__day--future" : ""}" title="${d.date}${d.gained != null ? ` ・ 覚えた ${d.gained}語` : ""}${d.my > 0 ? ` ・ マイ単語帳で 覚えた ${d.my}語` : ""}"></i>`
    )
    .join("");
  const months = [];
  days.forEach((d, i) => {
    if (d.month && i % 7 === 0) months.push({ col: Math.floor(i / 7), label: `${d.month}月` });
    else if (d.month && !months.some((m) => m.label === `${d.month}月`)) months.push({ col: Math.floor(i / 7), label: `${d.month}月` });
  });
  const monthRow = `<div class="cal__months" style="grid-template-columns: repeat(${weeks}, 1fr)">${Array.from({ length: weeks }, (_, c) => {
    const m = months.find((x) => x.col === c);
    return `<span>${m ? esc(m.label) : ""}</span>`;
  }).join("")}</div>`;

  // 凡例は「少ない ■■■■ 多い」だけ。濃さの説明は summary の後ろに 1 文（1 回だけ）
  el.innerHTML = `
    <p class="cal__note">濃さ＝その日に覚えた語数</p>
    ${monthRow}
    <div class="cal" style="grid-template-columns: repeat(${weeks}, 1fr)" aria-hidden="true">${cells}</div>
    <p class="cal__legend" aria-hidden="true"><span>少ない</span><i class="cal__day cal__day--1"></i><i class="cal__day cal__day--2"></i><i class="cal__day cal__day--3"></i><i class="cal__day cal__day--4"></i><span>多い</span></p>
  `;
}
