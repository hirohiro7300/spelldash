// 年月（地図の 0 か月目 anchor "YYYY-MM" から月の数を足すだけ。日付やタイムゾーンは使わない: 作業メモ safety-14・truth-12）

export interface YearMonth {
  y: number;
  /** 1〜12 */
  mo: number;
}

/** "YYYY-MM" を読む。読めなければ null */
export function parseAnchor(anchor: string): YearMonth | null {
  const m = /^(\d{4})-(\d{2})$/.exec(anchor);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return mo >= 1 && mo <= 12 ? { y, mo } : null;
}

/** 0 か月目から m か月後の年月（anchor が読めなければ例外） */
export function ymAt(anchor: string, m: number): YearMonth {
  const a = parseAnchor(anchor);
  if (!a) throw new RangeError(`地図の年月が読めません: ${anchor}`);
  const t = a.y * 12 + (a.mo - 1) + Math.floor(m);
  return { y: Math.floor(t / 12), mo: (t % 12) + 1 };
}

/** 「2027 年 2 月」 */
export function ymText(anchor: string, m: number): string {
  const x = ymAt(anchor, m);
  return `${x.y} 年 ${x.mo} 月`;
}

/** 「2027 年 8 月〜2028 年 2 月」（同じ年なら「2027 年 8 月〜11 月」。同じ月ならその月だけ） */
export function ymSpanText(anchor: string, m0: number, m1: number): string {
  const a = ymAt(anchor, m0);
  const b = ymAt(anchor, m1);
  if (a.y === b.y && a.mo === b.mo) return `${a.y} 年 ${a.mo} 月`;
  return a.y === b.y ? `${a.y} 年 ${a.mo} 月〜${b.mo} 月` : `${a.y} 年 ${a.mo} 月〜${b.y} 年 ${b.mo} 月`;
}

/** 手の 3 か月（「11 月〜1 月」。m はその手を始める月） */
export function quarterSpanText(anchor: string, m: number, len = 3): string {
  const a = ymAt(anchor, m);
  const b = ymAt(anchor, m + Math.max(1, len) - 1);
  return `${a.mo} 月〜${b.mo} 月`;
}
