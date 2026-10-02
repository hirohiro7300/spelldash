// ===== プレイヤー管理（CRM・創業者専用） =====
//
// /api/admin/* から一覧と詳細を取り、見る・メモする・CSV に書き出すだけの画面。
// プレイヤーへ何かを送る機能は作らない（docs/CRM.md）。
// 一覧・詳細の取得には Supabase のアクセストークンを Bearer で付ける（js/wordAi.js と同じ）。
// 管理者かどうかはサーバーが判定する。この画面は 401/403/503 をそのまま文言にするだけ。
//
// buildCsv() はテストから直接 import される。DOM や Supabase に触るモジュールは init() の中で
// 動的に読み込み、Node から import しても壊れないようにしている。

import { icon } from "./icons.js";

export const SEGMENT_LABEL = { active: "活動中", atRisk: "離れかけ", churned: "離脱", dormant: "登録のみ" };
export const CSV_COLUMNS = [
  "email", "displayName", "segment", "lastActiveDay", "activeDays7", "activeDays30",
  "wordsMastered", "streakCurrent", "level", "plan", "tags", "note"
];
const PLAN_INTERVAL_LABEL = { month: "月額", year: "年額" };

const DAY_MS = 86400000;

// ---- CSV（ブラウザ内で作ってダウンロードするだけ。外へは送らない） ----

// 1 セル: 常にダブルクォートでくくる。`"` は `""`。先頭が = + - @ なら `'` を前置して数式として評価されないようにする
export function csvCell(value) {
  let text = value == null ? "" : Array.isArray(value) ? value.join(", ") : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function buildCsv(players) {
  const lines = [CSV_COLUMNS.map(csvCell).join(",")];
  for (const player of Array.isArray(players) ? players : []) {
    lines.push(CSV_COLUMNS.map((key) => csvCell(player?.[key])).join(","));
  }
  return "﻿" + lines.join("\n");
}

// ---- 日付（すべて YYYY-MM-DD の文字列で扱う） ----

function dayToUtc(day) {
  if (typeof day !== "string" || day.length < 10) return NaN;
  return Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
}

// today − day（日数）。どちらかが無ければ null
export function dayDiff(today, day) {
  const a = dayToUtc(today);
  const b = dayToUtc(day);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((a - b) / DAY_MS);
}

export function shiftDay(day, delta) {
  const t = dayToUtc(day);
  if (Number.isNaN(t)) return day;
  return new Date(t + delta * DAY_MS).toISOString().slice(0, 10);
}

export function lastActiveLabel(today, lastActiveDay) {
  const diff = dayDiff(today, lastActiveDay);
  if (diff == null) return "まだ無し";
  if (diff <= 0) return "今日";
  if (diff === 1) return "昨日";
  return `${diff}日前`;
}

// JST の今日（API の today が取れない時の予備）
function jstToday() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function jstParts(iso) {
  const t = Date.parse(iso ?? "");
  if (Number.isNaN(t)) return null;
  const s = new Date(t + 9 * 3600 * 1000).toISOString();
  return { date: s.slice(0, 10), time: s.slice(11, 16) };
}

function fmtDate(iso) {
  return jstParts(iso)?.date ?? "—";
}

function fmtDateTime(iso) {
  const p = jstParts(iso);
  return p ? `${p.date} ${p.time}` : "—";
}

export function parseTags(text) {
  const seen = new Set();
  const tags = [];
  for (const raw of String(text ?? "").split(/[,、\n]/)) {
    const tag = raw.trim().slice(0, 30);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= 20) break;
  }
  return tags;
}

// ---- 並び替え・絞り込み ----

function sortValue(player, key) {
  if (key === "createdAt") return player.createdAt || "";
  if (key === "wordsMastered" || key === "streakCurrent") return Number(player[key]) || 0;
  return player.lastActiveDay || "";
}

export function sortPlayers(players, key = "lastActive") {
  return [...players].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (va !== vb) return va > vb ? -1 : 1;
    return String(a.email || "").localeCompare(String(b.email || ""));
  });
}

export function matchesQuery(player, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return true;
  return [player.email, player.displayName, ...(Array.isArray(player.tags) ? player.tags : [])]
    .some((v) => String(v ?? "").toLowerCase().includes(q));
}

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : "0";
}

// ===== ここから画面 =====

const state = {
  status: "loading",
  today: jstToday(),
  players: [],
  summary: null,
  missing: [],
  segment: "all",
  plan: "all", // "all" | "pro"（Pro だけに絞る。セグメントとは独立）
  query: "",
  sort: "lastActive",
  openUserId: null,
  loadedUserId: null,
  lastFocusedRow: null
};

let supabase = null;
let apiUrl = (path) => path;
let els = null;

if (typeof document !== "undefined" && document.getElementById("adminTable")) {
  init();
}

async function init() {
  els = {
    state: document.getElementById("adminState"),
    bar: document.getElementById("adminBar"),
    summary: document.getElementById("adminSummary"),
    refresh: document.getElementById("adminRefresh"),
    exportBtn: document.getElementById("adminExport"),
    main: document.getElementById("adminMain"),
    missing: document.getElementById("adminMissing"),
    segment: document.getElementById("adminSegment"),
    search: document.getElementById("adminSearch"),
    sort: document.getElementById("adminSort"),
    table: document.getElementById("adminTable"),
    drawer: document.getElementById("adminDrawer"),
    drawerClose: document.getElementById("adminDrawerClose"),
    drawerName: document.getElementById("adminDrawerName"),
    drawerEmail: document.getElementById("adminDrawerEmail"),
    drawerFacts: document.getElementById("adminDrawerFacts"),
    drawerNumbers: document.getElementById("adminDrawerNumbers"),
    activity: document.getElementById("adminActivity"),
    activityCap: document.getElementById("adminActivityCap"),
    sessions: document.getElementById("adminSessions"),
    packs: document.getElementById("adminPacks"),
    mastered: document.getElementById("adminMastered"),
    feedback: document.getElementById("adminFeedback"),
    note: document.getElementById("adminNote"),
    tags: document.getElementById("adminTags"),
    pinned: document.getElementById("adminPinned"),
    save: document.getElementById("adminSaveNote"),
    noteStatus: document.getElementById("adminNoteStatus")
  };

  els.refresh.innerHTML = `${icon("refresh", { size: 14 })}<span>再取得</span>`;
  els.drawerClose.innerHTML = icon("x", { size: 16 });

  // 共通の土台（ヘッダーのログイン・フッター・連続日数）。profile.html と同じ呼び方
  const [{ supabase: client }, { apiUrl: toApiUrl }, { initializeAuth }, { setFooterYear }, { renderHeaderStreak }] = await Promise.all([
    import("./supabase.js"),
    import("./appEnv.js"),
    import("./auth.js"),
    import("./footer.js"),
    import("./headerStreak.js")
  ]);
  supabase = client;
  apiUrl = toApiUrl;

  initializeAuth();
  setFooterYear();
  renderHeaderStreak();

  bindEvents();
  load();

  // ログイン／ログアウトで取り直す（同じユーザーの再通知では取り直さない）
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT") {
      state.loadedUserId = null;
      load();
      return;
    }
    if (event !== "SIGNED_IN" && event !== "USER_UPDATED") return;
    const userId = session?.user?.id ?? null;
    if (state.status === "ready" && userId && userId === state.loadedUserId) return;
    load();
  });
}

function bindEvents() {
  els.refresh.addEventListener("click", () => load());
  els.exportBtn.addEventListener("click", downloadCsv);

  // Pro フィルタ（セグメントのチップ列の末尾。押すたびに on/off）
  els.segment.insertAdjacentHTML("beforeend", '<button type="button" class="admin-chip admin-chip--plan" data-plan="pro" aria-pressed="false">Pro</button>');
  els.segment.addEventListener("click", (event) => {
    const planChip = event.target.closest(".admin-chip[data-plan]");
    if (planChip) {
      state.plan = state.plan === "pro" ? "all" : "pro";
      const on = state.plan === "pro";
      planChip.classList.toggle("admin-chip--active", on);
      planChip.setAttribute("aria-pressed", String(on));
      renderTable();
      return;
    }
    const chip = event.target.closest(".admin-chip[data-segment]");
    if (!chip) return;
    state.segment = chip.dataset.segment;
    for (const b of els.segment.querySelectorAll(".admin-chip")) {
      const on = b === chip;
      b.classList.toggle("admin-chip--active", on);
      b.setAttribute("aria-pressed", String(on));
    }
    renderTable();
  });

  els.search.addEventListener("input", () => {
    state.query = els.search.value;
    renderTable();
  });

  els.sort.addEventListener("change", () => {
    state.sort = els.sort.value;
    renderTable();
  });

  els.table.addEventListener("click", (event) => {
    const row = event.target.closest(".admin-row[data-user-id]");
    if (row) openDrawer(row.dataset.userId, row);
  });
  els.table.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest(".admin-row[data-user-id]");
    if (!row) return;
    event.preventDefault();
    openDrawer(row.dataset.userId, row);
  });

  els.drawerClose.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !els.drawer.hidden) closeDrawer();
  });

  els.save.addEventListener("click", saveNote);
}

// ---- API ----

async function getToken() {
  try {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || null;
  } catch {
    return null;
  }
}

// 応答を { status, body } にそろえる。通信できなければ status 0
async function apiFetch(path, init = {}) {
  const token = await getToken();
  if (!token) return { status: 401, body: { error: "login_required" } };
  const headers = { Authorization: `Bearer ${token}`, ...(init.headers || {}) };
  let response;
  try {
    response = await fetch(apiUrl(path), { ...init, headers, cache: "no-store" });
  } catch {
    return { status: 0, body: {} };
  }
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return { status: response.status, body: body && typeof body === "object" ? body : {} };
}

// ---- 状態 ----

function setState(status, message = "") {
  state.status = status;
  const ready = status === "ready";
  els.state.hidden = ready;
  els.main.hidden = !ready;
  els.bar.hidden = !(ready || status === "error");
  els.summary.hidden = !ready;
  els.exportBtn.hidden = !ready;
  if (!ready) {
    closeDrawer();
    els.state.textContent = message;
  }
}

async function load() {
  setState("loading", "読み込んでいます");
  const { status, body } = await apiFetch("/api/admin/players");

  if (status === 401) return setState("login", "ログインしてください。右上からログインできます。");
  if (status === 403) return setState("forbidden", "このアカウントには権限がありません。");
  if (status === 503) {
    const text = body.message || "管理画面の設定がまだです。";
    return setState("unconfigured", text.includes("docs/CRM.md") ? text : `${text} 設定の手順: docs/CRM.md`);
  }
  if (status !== 200 || !Array.isArray(body.players)) return setState("error", "取得できませんでした。");

  state.players = body.players;
  state.summary = body.summary ?? null;
  state.missing = Array.isArray(body.missing) ? body.missing : [];
  state.today = typeof body.today === "string" && body.today.length >= 10 ? body.today : jstToday();
  const { data } = await supabase.auth.getSession().catch(() => ({ data: null }));
  state.loadedUserId = data?.session?.user?.id ?? null;

  els.missing.hidden = !state.missing.includes("crm_notes");
  renderSummary();
  renderTable();
  setState("ready");
}

// ---- 一覧 ----

function summaryCounts() {
  const s = state.summary;
  const by = s?.bySegment ?? {};
  const count = (seg) => (by[seg] != null ? by[seg] : state.players.filter((p) => p.segment === seg).length);
  return {
    total: s?.total != null ? s.total : state.players.length,
    active: count("active"),
    atRisk: count("atRisk"),
    churned: count("churned"),
    dormant: count("dormant"),
    newThisWeek: s?.newThisWeek != null ? s.newThisWeek : state.players.filter((p) => p.isNew).length,
    pro: s?.pro != null ? s.pro : state.players.filter((p) => p.plan === "pro").length
  };
}

function renderSummary() {
  const c = summaryCounts();
  const items = [
    ["全", c.total], ["活動中", c.active], ["離れかけ", c.atRisk],
    ["離脱", c.churned], ["登録のみ", c.dormant], ["今週の新規", c.newThisWeek], ["Pro", c.pro]
  ];
  els.summary.innerHTML = items
    .map(([label, n]) => `<span class="admin-summary__item">${label} <b class="admin-n">${num(n)}</b></span>`)
    .join('<span class="admin-summary__sep" aria-hidden="true"> ・ </span>');
}

function visiblePlayers() {
  const filtered = state.players.filter(
    (p) =>
      (state.segment === "all" || p.segment === state.segment) &&
      (state.plan === "all" || p.plan === "pro") &&
      matchesQuery(p, state.query)
  );
  return sortPlayers(filtered, state.sort);
}

function segmentChip(player) {
  const seg = SEGMENT_LABEL[player.segment] ? player.segment : "dormant";
  const extra = player.isNew ? ' <span class="admin-new">新規</span>' : "";
  return `<span class="admin-seg admin-seg--${seg}">${SEGMENT_LABEL[seg]}</span>${extra}`;
}

// プラン: Pro だけチップ（朱の線）。free は何も出さない
function planChip(player) {
  return player.plan === "pro" ? '<span class="admin-plan">Pro</span>' : "";
}

// ドロワー用: 「Pro ・ 月額 ・ active ・ 次回 2026-10-20」／「Free」
function planFacts(player) {
  if (player.plan !== "pro") return "プラン <b class=\"admin-n\">Free</b>";
  const parts = [planChip(player)];
  if (player.planInterval) parts.push(escapeHtml(PLAN_INTERVAL_LABEL[player.planInterval] || player.planInterval));
  if (player.planStatus) parts.push(`<span class="mono">${escapeHtml(player.planStatus)}</span>`);
  if (player.planPeriodEnd) parts.push(`次回 <b class="admin-n">${fmtDate(player.planPeriodEnd)}</b>`);
  return parts.join(" ");
}

function lastActiveHtml(player) {
  const diff = dayDiff(state.today, player.lastActiveDay);
  if (diff == null) return '<span class="admin-last admin-last--none">まだ無し</span>';
  if (diff <= 0) return '<span class="admin-last admin-last--today">今日</span>';
  if (diff === 1) return '<span class="admin-last">昨日</span>';
  return `<span class="admin-last"><b class="admin-n">${diff}</b>日前</span>`;
}

function numCell(label, value, { mono = true } = {}) {
  const n = Number(value) || 0;
  return `<div class="admin-cell admin-cell--num" data-label="${label}"><span class="admin-num${n === 0 ? " admin-num--zero" : ""}${mono ? "" : " admin-num--plain"}">${n}</span></div>`;
}

function tagsHtml(tags, { mono = false, empty = "" } = {}) {
  const list = Array.isArray(tags) ? tags.filter(Boolean) : [];
  if (!list.length) return empty ? `<span class="admin-none">${empty}</span>` : "";
  return list.map((t) => `<span class="admin-tag${mono ? " mono" : ""}">${escapeHtml(t)}</span>`).join("");
}

function rowHtml(player) {
  const name = player.displayName ? escapeHtml(player.displayName) : '<span class="admin-name--none">（名前なし）</span>';
  const pin = player.pinned ? '<span class="admin-pin">ピン留め</span>' : "";
  const label = `${player.displayName || player.email || ""} の詳細を開く`;
  return `
    <div class="admin-row${player.pinned ? " admin-row--pinned" : ""}" role="button" tabindex="0" data-user-id="${escapeHtml(player.userId)}" aria-label="${escapeHtml(label)}">
      <div class="admin-cell admin-cell--player">
        <span class="admin-name">${name}${pin}</span>
        <span class="admin-email mono">${escapeHtml(player.email)}</span>
      </div>
      <div class="admin-cell admin-cell--seg">${segmentChip(player)}</div>
      <div class="admin-cell admin-cell--plan">${planChip(player)}</div>
      <div class="admin-stats">
        <div class="admin-cell admin-cell--last" data-label="最終活動">${lastActiveHtml(player)}</div>
        ${numCell("7日", player.activeDays7)}
        ${numCell("30日", player.activeDays30)}
        ${numCell("覚えた語", player.wordsMastered)}
        ${numCell("連続", player.streakCurrent)}
        ${numCell("Lv", player.level)}
      </div>
      <div class="admin-cell admin-cell--tags admin-tags">${tagsHtml(player.tags)}</div>
    </div>`;
}

const HEAD_HTML = `
  <div class="admin-head-row" aria-hidden="true">
    <div class="admin-cell admin-cell--player">プレイヤー</div>
    <div class="admin-cell admin-cell--seg">セグメント</div>
    <div class="admin-cell admin-cell--plan">プラン</div>
    <div class="admin-stats">
      <div class="admin-cell admin-cell--last">最終活動</div>
      <div class="admin-cell admin-cell--num">7日</div>
      <div class="admin-cell admin-cell--num">30日</div>
      <div class="admin-cell admin-cell--num">覚えた語</div>
      <div class="admin-cell admin-cell--num">連続</div>
      <div class="admin-cell admin-cell--num">Lv</div>
    </div>
    <div class="admin-cell admin-cell--tags">タグ</div>
  </div>`;

function renderTable() {
  const list = visiblePlayers();
  if (!list.length) {
    els.table.innerHTML = `<p class="admin-empty">${state.players.length ? "該当するプレイヤーはいません。" : "プレイヤーはまだいません。"}</p>`;
    return;
  }
  els.table.innerHTML = HEAD_HTML + list.map(rowHtml).join("");
  if (state.openUserId) {
    els.table.querySelector(`.admin-row[data-user-id="${CSS.escape(state.openUserId)}"]`)?.classList.add("admin-row--open");
  }
}

function downloadCsv() {
  const csv = buildCsv(sortPlayers(state.players, state.sort));
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `spelldash-players-${state.today}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- 詳細（右側のパネル） ----

const LOADING = '<p class="admin-none">読み込んでいます</p>';
const FAILED = '<p class="admin-none">取得できませんでした。</p>';

function fillHeader(player) {
  els.drawerName.innerHTML = player.displayName ? escapeHtml(player.displayName) : '<span class="admin-name--none">（名前なし）</span>';
  els.drawerEmail.textContent = player.email || "";
  els.drawerFacts.innerHTML = [
    `登録 <b class="admin-n">${fmtDate(player.createdAt)}</b>`,
    `最終ログイン <b class="admin-n">${fmtDate(player.lastSignInAt)}</b>`,
    segmentChip(player),
    planFacts(player)
  ].join('<span class="admin-summary__sep" aria-hidden="true"> ・ </span>');
  els.drawerNumbers.innerHTML = [
    `覚えた語 <b class="admin-n">${num(player.wordsMastered)}</b>`,
    `打った語 <b class="admin-n">${num(player.wordsPlayed)}</b>`,
    `連続 <b class="admin-n">${num(player.streakCurrent)}</b>（最長 <b class="admin-n">${num(player.streakBest)}</b>）`,
    `Lv <b class="admin-n">${num(player.level)}</b>`,
    `XP <b class="admin-n">${num(player.xp)}</b>`
  ].join('<span class="admin-summary__sep" aria-hidden="true"> ・ </span>');
}

function fillForm(player) {
  els.note.value = player.note || "";
  els.tags.value = Array.isArray(player.tags) ? player.tags.join(", ") : "";
  els.pinned.checked = !!player.pinned;
  setNoteStatus("");
}

function setSections(html) {
  els.activity.innerHTML = "";
  els.activityCap.textContent = "";
  for (const el of [els.sessions, els.packs, els.mastered, els.feedback]) el.innerHTML = html;
}

async function openDrawer(userId, rowElement = null) {
  const player = state.players.find((p) => p.userId === userId);
  if (!player) return;
  state.openUserId = userId;
  state.lastFocusedRow = rowElement;
  for (const r of els.table.querySelectorAll(".admin-row--open")) r.classList.remove("admin-row--open");
  rowElement?.classList.add("admin-row--open");

  fillHeader(player);
  fillForm(player);
  setSections(LOADING);
  els.drawer.hidden = false;
  els.drawer.scrollTop = 0;
  els.drawerClose.focus({ preventScroll: true });

  const { status, body } = await apiFetch(`/api/admin/player?userId=${encodeURIComponent(userId)}`);
  if (state.openUserId !== userId || els.drawer.hidden) return;
  if (status !== 200) {
    setSections(FAILED);
    return;
  }
  renderActivity(body);
  renderSessions(body);
  els.packs.innerHTML = tagsHtml(body.packs ?? player.packs, { mono: true, empty: "なし" });
  renderMastered(body);
  renderFeedback(body);
}

function closeDrawer() {
  if (els.drawer.hidden) return;
  els.drawer.hidden = true;
  state.openUserId = null;
  for (const r of els.table.querySelectorAll(".admin-row--open")) r.classList.remove("admin-row--open");
  const row = state.lastFocusedRow;
  state.lastFocusedRow = null;
  if (row && row.isConnected) row.focus({ preventScroll: true });
}

function renderActivity(detail) {
  const byDay = new Map((Array.isArray(detail.activityDays) ? detail.activityDays : []).map((d) => [d.day, d]));
  const days = [];
  for (let i = 29; i >= 0; i--) days.push(shiftDay(state.today, -i));
  const max = Math.max(1, ...days.map((d) => Number(byDay.get(d)?.studyCorrect) || 0));
  let activeDays = 0;
  let correct = 0;
  let daily = 0;
  let battles = 0;
  let challenges = 0;
  const bars = days.map((day) => {
    const a = byDay.get(day);
    const n = Number(a?.studyCorrect) || 0;
    const active = !!a && (n > 0 || Number(a.challengeRuns) > 0 || !!a.dailyDone || Number(a.battleRuns) > 0);
    if (active) activeDays++;
    correct += n;
    if (a?.dailyDone) daily++;
    battles += Number(a?.battleRuns) || 0;
    challenges += Number(a?.challengeRuns) || 0;
    const h = n > 0 ? Math.max(12, Math.round((n / max) * 100)) : active ? 10 : 0;
    const title = active ? `${day} 正解 ${n}` : `${day} 活動なし`;
    return `<span class="admin-day${active ? "" : " admin-day--off"}" style="--h:${h}%" title="${title}"></span>`;
  });
  els.activity.innerHTML = bars.join("");
  els.activityCap.innerHTML = [
    `<b class="admin-n">${days[0].slice(5).replace("-", "/")}</b> から <b class="admin-n">${days[29].slice(5).replace("-", "/")}</b>`,
    `活動 <b class="admin-n">${activeDays}</b>日`,
    `正解 <b class="admin-n">${correct}</b>`,
    `Challenge <b class="admin-n">${challenges}</b>`,
    `今日のセット <b class="admin-n">${daily}</b>`,
    `バトル <b class="admin-n">${battles}</b>`
  ].join('<span class="admin-summary__sep" aria-hidden="true"> ・ </span>');
}

const MODE_LABEL = { challenge: "Challenge", study: "Study", daily: "Daily", battle: "バトル" };
const RESULT_LABEL = { win: "勝ち", loss: "負け", lose: "負け", draw: "引き分け" };

function speedText(speed) {
  const n = Number(speed);
  return Number.isFinite(n) && n > 0 ? `${(Math.round(n * 10) / 10).toFixed(1)}打/秒` : "";
}

function renderSessions(detail) {
  const items = [];
  for (const s of Array.isArray(detail.playSessions) ? detail.playSessions : []) {
    items.push({
      at: s.playedAt || "",
      when: fmtDateTime(s.playedAt),
      kind: MODE_LABEL[s.mode] || escapeHtml(s.mode || "プレイ"),
      value: [`${num(s.score)}点`, speedText(s.typingSpeed)].filter(Boolean).join(" ・ ")
    });
  }
  for (const s of Array.isArray(detail.dailyScores) ? detail.dailyScores : []) {
    items.push({
      at: s.day || "",
      when: escapeHtml(s.day || "—"),
      kind: "Daily",
      value: [`${num(s.score)}点`, speedText(s.typingSpeed)].filter(Boolean).join(" ・ ")
    });
  }
  for (const s of Array.isArray(detail.battleSessions) ? detail.battleSessions : []) {
    const playedAt = s.playedAt ?? s.played_at ?? "";
    const result = RESULT_LABEL[String(s.result || "").toLowerCase()] || escapeHtml(s.result || "");
    const mine = s.playerScore ?? s.player_score;
    const theirs = s.opponentScore ?? s.opponent_score;
    const opponent = s.opponentName ?? s.opponent_name;
    items.push({
      at: playedAt,
      when: fmtDateTime(playedAt),
      kind: `バトル${opponent ? ` ・ ${escapeHtml(opponent)}` : ""}`,
      value: [result, mine != null && theirs != null ? `${num(mine)} - ${num(theirs)}` : ""].filter(Boolean).join(" ・ ")
    });
  }
  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const top = items.slice(0, 10);
  if (!top.length) {
    els.sessions.innerHTML = '<p class="admin-none">まだ無し</p>';
    return;
  }
  els.sessions.innerHTML = top
    .map((i) => `<div class="admin-session"><span class="admin-session__at mono">${i.when}</span><span class="admin-session__kind">${i.kind}</span><span class="admin-session__val mono">${i.value}</span></div>`)
    .join("");
}

function renderMastered(detail) {
  const list = Array.isArray(detail.recentMastered) ? detail.recentMastered : [];
  if (!list.length) {
    els.mastered.innerHTML = '<p class="admin-none">まだ無し</p>';
    return;
  }
  els.mastered.innerHTML = list
    .map((m) => `<span class="admin-word mono"><span class="admin-word__id">${escapeHtml(m.wordId)}</span><span class="admin-word__at">${fmtDate(m.masteredAt).slice(5)}</span></span>`)
    .join("");
}

function renderFeedback(detail) {
  const list = Array.isArray(detail.feedback) ? detail.feedback : [];
  if (!list.length) {
    els.feedback.innerHTML = '<p class="admin-none">まだ無し</p>';
    return;
  }
  els.feedback.innerHTML = list
    .map((f) => {
      const meta = [fmtDateTime(f.createdAt), f.page ? escapeHtml(f.page) : "", f.contact ? `連絡先 ${escapeHtml(f.contact)}` : ""].filter(Boolean).join(" ・ ");
      return `<div class="admin-fb"><p class="admin-fb__meta mono">${meta}</p><p class="admin-fb__text">${escapeHtml(f.message)}</p></div>`;
    })
    .join("");
}

// ---- メモ・タグ・ピン ----

function setNoteStatus(text, isError = false) {
  els.noteStatus.textContent = text;
  els.noteStatus.classList.toggle("admin-note__status--error", isError && !!text);
}

async function saveNote() {
  const userId = state.openUserId;
  const player = state.players.find((p) => p.userId === userId);
  if (!player) return;

  const payload = {
    userId,
    note: els.note.value.trim().slice(0, 2000),
    tags: parseTags(els.tags.value),
    pinned: els.pinned.checked
  };

  els.save.disabled = true;
  setNoteStatus("保存しています");
  const { status, body } = await apiFetch("/api/admin/note", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  els.save.disabled = false;

  if (status === 200 && body.ok) {
    player.note = typeof body.note === "string" ? body.note : payload.note;
    player.tags = Array.isArray(body.tags) ? body.tags : payload.tags;
    player.pinned = typeof body.pinned === "boolean" ? body.pinned : payload.pinned;
    fillForm(player);
    setNoteStatus("保存しました");
    renderTable();
    return;
  }
  if (status === 503) return setNoteStatus(body.message || "メモの保存先がありません。docs/SQL_CRM.md のテーブルを作ってください。", true);
  if (status === 401) return setNoteStatus("ログインしてください。", true);
  if (status === 403) return setNoteStatus("このアカウントには権限がありません。", true);
  setNoteStatus(body.message || "保存できませんでした。", true);
}
