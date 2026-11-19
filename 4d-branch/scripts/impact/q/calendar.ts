// 地図の年月（anchor: 0 か月目の "YYYY-MM"）から、暦で決まる月をすべて出す。設計: 作業メモ SPEC v1 §2.3 #7（見直し truth-12）
// 月の番号 a（1..36）は 0 か月目の a か月後の月。その暦の月は (anchorMonth + a − 1) mod 12 + 1（anchorMonth は 1..12）。
// 4 月の昇給・昇格を狙える 3 か月・学年の始まり・賞与の月・確定申告の時期は、どれもここから出す（2026 年 11 月を決め打ちしない）

/** 生成の既定の年月（0 か月目） */
export const DEFAULT_ANCHOR = "2026-11";

export interface Anchor {
  y: number;
  /** 1..12 */
  m: number;
}

/** "YYYY-MM" を読む。読めなければ投げる */
export function parseAnchor(s: string): Anchor {
  const hit = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(s);
  if (!hit) throw new Error(`地図の年月は YYYY-MM です（${s}）`);
  return { y: Number(hit[1]), m: Number(hit[2]) };
}

/** a か月目の暦の年と月（整数の月の足し算だけ。時刻・時差は使わない） */
export function ymOf(an: Anchor, a: number): Anchor {
  const t = an.y * 12 + (an.m - 1) + a;
  return { y: Math.floor(t / 12), m: (((t % 12) + 12) % 12) + 1 };
}

/** 暦の月 cm（1..12）に当たる 1..H か月目 */
export function monthsOfCal(an: Anchor, cm: number, H = 36): number[] {
  const out: number[] = [];
  for (let a = 1; a <= H; a++) if (ymOf(an, a).m === cm) out.push(a);
  return out;
}

export interface Calendar {
  anchor: Anchor;
  /** 4 月（昇給・昇格の評価・学年の始まり） */
  aprilMonths: number[];
  /** 昇格を狙える 3 か月（4 月を含む段。段 s は 3s+1〜3s+3 か月目） */
  promoStages: number[];
  /** 学年の始まり（4 月） */
  schoolYearStarts: number[];
  /** 賞与の月（夏 6 月・冬 12 月） */
  bonusMonths: number[];
  /** 確定申告の時期（2 月 16 日〜3 月 15 日）に入る月（2 月・3 月） */
  taxMonths: number[];
}

/** 年月から暦の月を出す（H か月目まで、段は 3 か月ごと） */
export function calendarOf(anchor: string, H = 36): Calendar {
  const an = parseAnchor(anchor);
  const aprilMonths = monthsOfCal(an, 4, H);
  const promoStages: number[] = [];
  for (let s = 0; 3 * s < H; s++) if (aprilMonths.some((a) => a > 3 * s && a <= 3 * s + 3)) promoStages.push(s);
  const sorted = (xs: number[]) => xs.sort((a, b) => a - b);
  return {
    anchor: an,
    aprilMonths,
    promoStages,
    schoolYearStarts: [...aprilMonths],
    bonusMonths: sorted([...monthsOfCal(an, 6, H), ...monthsOfCal(an, 12, H)]),
    taxMonths: sorted([...monthsOfCal(an, 2, H), ...monthsOfCal(an, 3, H)]),
  };
}

/** 暦の点検: 4 月の月の番号 a はどれも (anchorMonth + a) mod 12 = 4 で、1..H か月目の 4 月を漏らさない。合わなければその訳を返す */
export function calendarCheck(anchor: string, aprilMonths: readonly number[], H = 36): string[] {
  const an = parseAnchor(anchor);
  const out: string[] = [];
  for (const a of aprilMonths) {
    if (!Number.isInteger(a) || a < 1 || a > H) out.push(`暦: 4 月の月の番号 ${a} が 1..${H} の外`);
    else if ((an.m + a) % 12 !== 4) out.push(`暦: ${a} か月目は 4 月ではない（(${an.m} + ${a}) mod 12 = ${(an.m + a) % 12}）`);
  }
  for (let a = 1; a <= H; a++) if ((an.m + a) % 12 === 4 && !aprilMonths.includes(a)) out.push(`暦: ${a} か月目の 4 月が抜けている`);
  return out;
}

/** 年月の文（例: 2027 年 2 月） */
export const ymText = (an: Anchor, a: number): string => {
  const t = ymOf(an, a);
  return `${t.y} 年 ${t.m} 月`;
};
