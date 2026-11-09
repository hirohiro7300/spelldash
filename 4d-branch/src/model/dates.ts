// 期限などの日付は「YYYY-MM-DD」のローカル日付として持つ（時刻・時差を持たない）

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayStr(): string {
  return toDateStr(new Date());
}

export function isDateStr(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** いろいろな書き方の日付を YYYY-MM-DD にそろえる。読めなければ null */
export function normalizeDateStr(input: unknown): string | null {
  if (input == null || input === "") return null;
  if (typeof input !== "string") return null;
  const s = input.trim().normalize("NFKC");
  if (isDateStr(s)) return s;
  // 2027/3/31・2027.3.31・2027-3-31
  const m = /^(\d{4})[/.\-年](\d{1,2})[/.\-月](\d{1,2})日?$/.exec(s);
  if (m) {
    const out = `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`;
    return isDateStr(out) ? out : null;
  }
  // ISO の日時（2027-03-31T00:00:00Z）は日付の部分だけ使う
  const iso = /^(\d{4}-\d{2}-\d{2})T/.exec(s);
  if (iso && isDateStr(iso[1])) return iso[1] ?? null;
  return null;
}

/** 1970-01-01 からの日数（時差の影響を受けないよう UTC で数える） */
export function dayNumber(s: string): number {
  const m = DATE_RE.exec(s);
  if (!m) return NaN;
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS);
}

export function fromDayNumber(n: number): string {
  const d = new Date(n * DAY_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function addDays(s: string, days: number): string {
  return fromDayNumber(dayNumber(s) + days);
}

export function addMonths(s: string, months: number): string {
  const m = DATE_RE.exec(s);
  if (!m) return s;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1 + months;
  const ny = y + Math.floor(mo / 12);
  const nm = ((mo % 12) + 12) % 12;
  const d = Math.min(Number(m[3]), daysInMonth(ny, nm + 1));
  return `${ny}-${pad(nm + 1)}-${pad(d)}`;
}

/** 2027/03/31 */
export function formatDate(s: string | null): string {
  if (!s) return "";
  return s.replace(/-/g, "/");
}

/** 2027/03（カードの上の短い表示） */
export function formatShort(s: string | null, today = todayStr()): string {
  if (!s) return "";
  const [y, m, d] = s.split("-");
  const [ty] = today.split("-");
  return y === ty ? `${Number(m)}/${Number(d)}` : `${y}/${m}`;
}

/** あと 12 日・今日・3 日超過 */
export function relativeDue(s: string | null, today = todayStr()): { text: string; tone: "past" | "soon" | "future" | "today" } | null {
  if (!s) return null;
  const diff = dayNumber(s) - dayNumber(today);
  if (diff === 0) return { text: "今日", tone: "today" };
  if (diff < 0) return { text: `${-diff}日超過`, tone: "past" };
  if (diff <= 14) return { text: `あと${diff}日`, tone: "soon" };
  if (diff < 60) return { text: `あと${diff}日`, tone: "future" };
  const months = Math.round(diff / 30.4);
  if (months < 24) return { text: `あと約${months}か月`, tone: "future" };
  return { text: `あと約${(diff / 365).toFixed(1)}年`, tone: "future" };
}
