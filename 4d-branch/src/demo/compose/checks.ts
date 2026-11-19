// 組み立てた 1 枚の点検（差し込みの印つきの形 composeMarkedCard で見る）。設計: 作業メモ SPEC v1 §4.6。元: 試作（R2）の checks.ts
// 生成の点検（scripts/impact/textChecks.ts）とテストが使う。アプリは使わない
// C1 数はどれもデータから（差し込みの印の外に数字が無い）・C1b 手引きの文の数字は引いた項目にある・C2 状態と食い違わない・C3 長さ
// C4 地図の文の決まり（% と差・敬語・位置・気持ち・埋まっていない差し込み）・C4b 英数字の名前を書かない・C5 結果の名前と状態の顧客の数
// C7 モデルに無い月額（人が見る）・D1 / D2 文では直せないデータ（計算の側へ返す）
import type { MapData } from "../../deepmap/mapData";
import type { WishData } from "../wishlist";
import { ME, MS, PE, PS, spaceJa, strip } from "./text";
import type { Banks, Card } from "./types";

/** 文の型が差し込みなしで書いてよい数字（決まった言い方・月・少ない数） */
export const ALLOWED_NUM: readonly RegExp[] = [/980 円/g, /週 10 時間/g, /週 4 日/g, /\d{1,2} ?月/g, /[1-9] ?か月/g, /[1-3] ?年/g, /[1-3] ?社目/g, /[1-9] ?回/g, /[1-5] ?つ/g, /[1-9] ?件/g, /[1-9] ?本/g, /[1-9] ?期/g, /[0-9] ?円/g, /[1-9] ?日/g, /[1-9] ?人/g, /もう 1 社/g, /1 社 月/g, /1 社あたり/g, /1on1/g, /A4/g, /GA4/g, /D1|D7|D30/g];

/** 役割ごとの長さ（題の字数・本文の字数の下と上）。今日の手は先に読むので本文を長くしてよい */
export const LIMITS = { a: { title: 16, min: 150, max: 340 }, s: { title: 22, min: 120, max: 330 }, e: { title: 24, min: 170, max: 360 }, r: { title: 40, min: 0, max: 600 } } as const;
export const FIRST_MOVE_MAX = 420;
export const TODO_MAX = 24;

const SLOT_SPAN = new RegExp(`${MS}[^${ME}]*${ME}`, "g");
const PB_SPAN = new RegExp(`${PS}([^${PE}]*)${PE}`, "g");

/** 差し込みの印と手引きの文の外にある数字（許した言い方は除く） */
export function digitsOutside(text: string, allowed: readonly RegExp[] = ALLOWED_NUM): string[] {
  let rest = text.replace(SLOT_SPAN, "").replace(PB_SPAN, "");
  for (const re of allowed) rest = rest.replace(re, "");
  return rest.match(/[0-9０-９]+/g) ?? [];
}

/** 手引きから入れた文（印の中身） */
export function playbookSpans(text: string): string[] {
  return [...text.matchAll(PB_SPAN)].map((m) => m[1] ?? "");
}

/** text の数字のうち、src に無い物 */
export function digitsNotIn(text: string, src: string): string[] {
  return (text.match(/\d[\d,.]*/g) ?? []).filter((d) => !src.includes(d));
}

/** やりたいことリストの項目の文（題・本文・達成の目安） */
export interface WishText {
  title: string;
  body: string;
  done: string;
}

export function wishIndex(d: WishData): Map<string, WishText> {
  const out = new Map<string, WishText>();
  for (const a of d.areas) for (const t of a.themes) for (const it of t.items) out.set(it[0], { title: it[2], body: it[3], done: (it[7] ?? []).join(" ") });
  return out;
}

const wishSrc = (w: WishText): string => `${w.title} ${w.body} ${w.done}`;

/** 束の全部の手引きの点検: 引いた項目がある・文と題とやることの数字が引いた項目にある（C1b）・やることの長さ（C3） */
export function checkBanks(banks: Banks, wish: ReadonlyMap<string, WishText>): string[] {
  const out: string[] = [];
  for (const [kind, steps] of Object.entries(banks.playbook)) {
    for (const st of steps) {
      const w = wish.get(st.id);
      if (!w) {
        out.push(`C1b 引用先が無い: ${kind} ${st.id}`);
        continue;
      }
      for (const part of [st.act, st.todo, st.title ?? ""]) for (const d of digitsNotIn(part, wishSrc(w))) out.push(`C1b 引用元に無い数字 ${d}: ${kind} ${st.id}「${part}」`);
      if ([...st.todo].length > TODO_MAX) out.push(`C3 やることが長い（${[...st.todo].length}）: ${kind} ${st.id}「${st.todo}」`);
    }
  }
  return out;
}

/** 1 枚の点検。t は印つきの形（composeMarkedCard）。見つかった物を「点検の名前 説明」で返す */
export function checkCard(map: MapData, i: number, t: Card, banks: Banks, wish: ReadonlyMap<string, WishText>): string[] {
  const out: string[] = [];
  const role = map.role(i);
  // C1b: やることと手引きの文の数字は、そのカードが引いた項目にある
  const src = t.todo.map((td) => wish.get(td.cite)).filter((w): w is WishText => !!w).map(wishSrc).join(" ");
  for (const td of t.todo) {
    const w = wish.get(td.cite);
    if (!w) {
      out.push(`C1b 引用先が無い: ${td.cite}`);
      continue;
    }
    for (const d of digitsNotIn(td.text, wishSrc(w))) out.push(`C1b 引用元に無い数字 ${d}: ${td.cite}「${td.text}」`);
  }
  for (const span of [...playbookSpans(t.body), ...playbookSpans(t.title)]) for (const d of digitsNotIn(span, src)) out.push(`C1b 引用元に無い数字 ${d}「${span}」`);
  // C1: ほかの数字はどれも差し込み（データ）か、許した言い方
  const stray = digitsOutside(t.body);
  if (stray.length) out.push(`C1 データに無い数字: ${stray.join(",")}`);
  const strayT = digitsOutside(t.title);
  if (strayT.length) out.push(`C1 題にデータに無い数字: ${strayT.join(",")}`);
  const strayN = t.numbers.flatMap((x) => digitsOutside(x));
  if (strayN.length) out.push(`C1 数の行にデータに無い数字: ${strayN.join(",")}`);
  const plain = spaceJa(strip(t.body));
  const title = spaceJa(strip(t.title));
  const all = [plain, title, spaceJa(strip(t.short)), ...t.numbers.map((x) => spaceJa(strip(x)))].join("\n");
  // C4: 地図の文で使わない言葉
  if (/[%％Δ]/.test(all)) out.push("C4 % や差を書いている");
  if (/(です|ます)[。、」]?/.test(all)) out.push("C4 敬語");
  if (/(上|下|右|左)の(カード|選択肢|結果|手)/.test(all)) out.push("C4 位置の言葉");
  if (/気持ち/.test(all)) out.push("C4 気持ちの言葉");
  if (/\{\w+\}/.test(all) || /undefined|NaN|null|Infinity/.test(all)) out.push("C3 埋まっていない差し込み");
  if (/[\u0001-\u0004]/.test(all)) out.push("C3 印が残っている");
  // C4b: 英数字の名前（『high_mid』など）を書かない
  const ascii = all.match(/[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+/g);
  if (ascii) out.push(`C4b 英数字の名前: ${ascii.join(",")}`);
  // C2: 状態と食い違わない（結果・行き先だけ。同じ手の別の結果を言う文は除く）
  if (role === "s" || role === "e") {
    const s = map.st(i);
    const sw = s.fl.includes("switched");
    const ban: Array<[boolean, RegExp, string]> = [
      [s.j !== "i", /から独立した|独立して \d|独立のまま/, "会社員なのに独立"],
      [s.j === "i", /会社員として|本業で|給与は今日/, "独立しているのに会社員・本業"],
      [s.pm === "n" && s.j !== "i", /副業の顧客が|1 社目が決まった/, "副業不可なのに副業の顧客"],
      [s.pro === 0, /有料会員|Pro の売上|Pro は有料/, "Pro 前なのに有料会員"],
      [s.cl < 0.5, /顧客から|請求書/, "顧客がいないのに顧客から"],
      [s.j !== "p", /週 4 日勤務で給与|週 4 日勤務が認められ/, "週 4 日でないのに週 4 日"],
      [!sw, /会社へ移った|転職した|で転職（/, "転職していないのに転職"],
      [s.seats < 0.5, /学校の席|席が有料の席/, "学校の席が無いのに席"],
    ];
    const own = plain
      .split("。")
      .filter((x) => !x.startsWith("同じ手で"))
      .join("。");
    for (const [c, re, why] of ban) if (c && re.test(own + title)) out.push(`C2 状態と合わない（${why}）`);
    // D: 文では食い違いを無くせないデータ（計算の側へ返す）
    if (s.pm === "n" && s.pro === 1 && s.j !== "i") out.push("D1 『どちらも不可』なのに Pro が続いている（状態の食い違い）");
    if (s.cl >= 0.05 && Math.abs(s.cl - Math.round(s.cl)) >= 0.15) out.push("D2 顧客の数が平均（整数でない）");
    // C5: 結果の名前と状態の顧客の数
    const lab = map.label(i);
    const m1 = /^顧客 (\d+) 社$/.exec(lab);
    if (m1 && Math.round(s.cl) !== Number(m1[1])) out.push(`C5 結果の名前「${lab}」と状態の顧客 ${s.cl.toFixed(2)} 社が合わない`);
    const m2 = /^顧客 (\d+) 社以下$/.exec(lab);
    if (m2 && Math.round(s.cl) > Number(m2[1])) out.push(`C5 結果の名前「${lab}」と状態の顧客 ${s.cl.toFixed(2)} 社が合わない`);
  }
  // C3: 長さ
  const L = LIMITS[role];
  const len = [...plain].length;
  if ([...title].length > L.title) out.push(`C3 題が長い ${[...title].length}`);
  if (!title) out.push("C3 題が無い");
  const max = role === "a" && map.month(i) === 0 ? FIRST_MOVE_MAX : L.max;
  if (len < L.min || len > max) out.push(`C3 本文の長さ ${len}（${L.min}〜${max}）`);
  for (const td of t.todo) if ([...td.text].length > TODO_MAX) out.push(`C3 やることが長い: ${td.text}`);
  if (role === "a" && t.todo.length < 3) out.push(`C3 やることが ${t.todo.length} つ`);
  if (role === "e" && !title.startsWith("3 年後:")) out.push("C3 行き先の題");
  // C7: 手引きの文の月額がモデルに無い（人が見る）
  const book = [...(banks.playbook[map.kind(i) ?? ""] ?? []), ...(banks.playbook._generic ?? [])];
  const C = banks.C;
  for (const td of t.todo) {
    const st = book.find((x) => x.id === td.cite);
    if (!st) continue;
    for (const mm of `${st.act}${st.todo}`.matchAll(/月 ?([\d.]+) ?万円/g)) if (![C.sideFee, C.indFee, C.spend, C.overhead].includes(Number(mm[1]))) out.push(`C7 モデルに無い月額 ${mm[0]}: ${td.cite}`);
  }
  return out;
}
