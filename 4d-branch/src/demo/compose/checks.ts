// 組み立てた文の点検（差し込みの印つきの形 composeMarkedCard で見る）。設計: 作業メモ SPEC v1 §4.6。元: 試作（R2）の checks.ts
// 生成の点検（scripts/impact/textChecks.ts）とテストが使う。アプリは使わない
// 1 枚ごと: C1 数はどれもデータから（差し込みの印の外に数字が無い）・C1b 手引きの文の数字は引いた項目にある・C2 状態（まとめた行き先は中身の幅）と食い違わない・
//   C3 長さ・C4 地図の文の決まり（% と差・敬語・位置・気持ち・埋まっていない差し込み）・C4b 英数字の名前を書かない・C5 結果の名前と顧客の数・
//   C5b 顧客と席は整数・C7 モデルに無い月額（人が見る）・C10 数の言い方（給与は月にならして・有料は手数料とサーバー代を引いて・月に遊んだ人・
//   3 か月は 3 つの月・数の行の数を今日・状態・行き先の本文に書かない）・D1 / D2 文では直せないデータ（計算の側へ返す。まとめた行き先は除く）
// 道ごと: C9 道で 1 回だけの文（暦・静かな期の一言・出来事の助言・避けたい訳）が、今日から行き先までの道で 2 回出ない
import type { MapData } from "../../deepmap/mapData";
import type { WishData } from "../wishlist";
import { ME, MS, PE, PS, spaceJa, strip } from "./text";
import type { Banks, Card } from "./types";

/** 文の型が差し込みなしで書いてよい数字（決まった言い方・月・少ない数） */
export const ALLOWED_NUM: readonly RegExp[] = [/980 円/g, /週 10 時間/g, /週 4 日/g, /\d{1,2} ?月/g, /[1-9] ?か月/g, /[1-3] ?年/g, /[1-3] ?社目/g, /[1-9] ?回/g, /[1-5] ?つ/g, /[1-9] ?件/g, /[1-9] ?本/g, /[1-9] ?期/g, /[0-9] ?円/g, /[1-9] ?日/g, /[1-9] ?人/g, /もう 1 社/g, /1 社 月/g, /1 社あたり/g, /1on1/g, /A4/g, /GA4/g, /D1|D7|D30/g];

/**
 * 役割ごとの長さ（題の字数・本文の字数の下と上）。今日の手は先に読むので本文を長くしてよい。
 * 0.2: 数を数の行に移し（SPEC §4.2）、助言を道で 1 回にしたので、静かな期の本文は短い（数の行が上にある）。
 * 上と下は R1 の木（79,092 枚・年収 360 と 540）で測って決めた: 手 p5 186・最大 466（避けたい手）、状態 p5 63・最大 353、行き先 p5 159・最大 291。
 * 本当の木で測り直す（truth-14）
 */
export const LIMITS = { a: { title: 16, min: 60, max: 480 }, s: { title: 22, min: 30, max: 380 }, e: { title: 24, min: 80, max: 480 }, r: { title: 40, min: 0, max: 600 } } as const;
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

/** 英数字の名前（『high_mid』・手の種類・結果の番号・出来事の名前）。地図の文に出してはいけない（C4b・user-2） */
const ASCII_IDS: readonly RegExp[] = [/[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+/g, /(?<![A-Za-z0-9])(?:cl|pu|mau|u)\d+(?![A-Za-z0-9])/g, /『[\x00-\x7F]+』/g, /(?<![A-Za-z])(?:keep|part)(?![A-Za-z])/g];

export function asciiIds(text: string): string[] {
  return ASCII_IDS.flatMap((re) => text.match(re) ?? []);
}

/**
 * 数の言い方の点検（C10・truth-15）。見つかった物の説明を返す
 * - 給与の月額は「月にならして」か「賞与込み」を付ける（月の手取りと読み違える）
 * - 有料会員の稼ぎは「手数料とサーバー代を引いて」と書く
 * - 遊ぶ人は「月に遊んだ人 N 人」（見込みは「月に遊ぶ人」）、3 か月の差は「3 か月前より」
 * - 3 か月の期間は 3 つの月（「12 月〜2 月」。4 つの月を書かない）
 */
export function numberWording(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/給与[^。、]{0,16}?月 ?[0-9.,]+ ?万円/g)) if (!/にならして|賞与込み/.test(m[0])) out.push(`給与の月額に「月にならして」が無い「${m[0]}」`);
  for (const m of text.matchAll(/有料(?:会員)?(?:は)? ?(?:平均 )?[0-9,]+ ?人(?:ほど)?（([^）]*)）/g)) if (/円/.test(m[1] ?? "") && !/^(?:うち学校の席 [0-9,]+・)?手数料とサーバー代を引いて/.test(m[1] ?? "")) out.push(`有料会員の稼ぎに「手数料とサーバー代を引いて」が無い「${m[0]}」`);
  for (const m of text.matchAll(/遊ぶ人(?:は)? ?月 ?[0-9,]+ ?人/g)) out.push(`遊ぶ人の数の言い方「${m[0]}」`);
  for (const m of text.matchAll(/遊んだ人 [0-9,]+ 人（[+−-]/g)) out.push(`3 か月の差に「3 か月前より」が無い「${m[0]}」`);
  for (const m of text.matchAll(/(\d{1,2}) ?月〜(?:\d{4} ?年 ?)?(\d{1,2}) ?月(?! ?\d+ ?日)/g)) {
    const span = ((Number(m[2]) - Number(m[1]) + 12) % 12) + 1;
    if (span !== 3) out.push(`3 か月の期間が ${span} つの月「${m[0]}」`);
  }
  return out;
}

/** 数の行の数を、今日・状態・行き先の本文に書いていないか（SPEC §4.2・user-9b） */
const ROW_IN_PROSE: readonly RegExp[] = [/年収 (?:平均 )?[0-9,]+ ?万円/, /月にならして [0-9.]+ ?万円/, /月に遊んだ人 (?:平均 )?[0-9,]+ ?人/, /有料 (?:平均 )?[0-9,]+ 人（/, /週 [0-9]+ 時間/, /広告運用 (?:平均 )?[0-9〜]+ ?社（売上/];

/** 1 枚の点検。t は印つきの形（composeMarkedCard）。見つかった物を「点検の名前 説明」で返す */
export function checkCard(map: MapData, i: number, t: Card, banks: Banks, wish: ReadonlyMap<string, WishText>): string[] {
  const out: string[] = [];
  const role = map.role(i);
  const sum = role === "e" && map.sum(i);
  const mix = sum ? map.mix(i) : null;
  // C1b: やることと手引きの文の数字は、そのカードが引いた項目にある
  const src = t.todo
    .map((td) => wish.get(td.cite))
    .filter((w): w is WishText => !!w)
    .map(wishSrc)
    .join(" ");
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
  const nums = t.numbers.map((x) => spaceJa(strip(x)));
  const all = [plain, title, spaceJa(strip(t.short)), ...nums].join("\n");
  // C4: 地図の文で使わない言葉
  if (/[%％Δ]/.test(all)) out.push("C4 % や差を書いている");
  if (/(です|ます)[。、」]?/.test(all)) out.push("C4 敬語");
  if (/(上|下|右|左)の(カード|選択肢|結果|手)/.test(all)) out.push("C4 位置の言葉");
  if (/気持ち/.test(all)) out.push("C4 気持ちの言葉");
  if (/\{\w+\}/.test(all) || /undefined|NaN|null|Infinity/.test(all)) out.push("C3 埋まっていない差し込み");
  if (/[\u0001-\u0004]/.test(all)) out.push("C3 印が残っている");
  // C4b: 英数字の名前（『high_mid』・手の種類・結果の番号）を書かない
  const ascii = asciiIds(all);
  if (ascii.length) out.push(`C4b 英数字の名前: ${ascii.join(",")}`);
  // C10: 数の言い方
  for (const x of numberWording(all)) out.push(`C10 ${x}`);
  if (role !== "a") for (const re of ROW_IN_PROSE) if (re.test(plain)) out.push(`C10 数の行の数を本文に書いている（${re.source}）`);
  // C5b: 顧客と学校の席は整数（ならした値の端数を書かない。truth-5・truth-9）
  if (/[0-9]+\.[0-9]+ ?(?:社|席)/.test(all)) out.push("C5b 顧客か席に端数");
  // C2: 状態と食い違わない（結果・行き先だけ。同じ手の別の結果を言う文は除く）。まとめた行き先は中身の幅と比べる（truth-5）
  if (role === "s" || role === "e") {
    const s = map.st(i);
    // 同じ手の別の結果と比べる文は、その別の結果のことを言うので除く
    const own = plain
      .split("。")
      .filter((x) => !/^同じ手で|だった場合|^別の結果の/.test(x))
      .join("。");
    if (mix) {
      const ban: Array<[boolean, RegExp, string]> = [
        [mix.j.e < 0.9, /仕事は会社員。/, "9 割に満たないのに会社員と言い切る"],
        [mix.j.i < 0.9, /仕事は独立。/, "9 割に満たないのに独立と言い切る"],
        [Math.max(mix.pm["?"], mix.pm.a, mix.pm.s, mix.pm.n) < 0.9, /届け出の答えは『|届け出はしていない/, "9 割に満たないのに届け出の答えを言い切る"],
        [mix.pro < 0.9, /Pro を出している。/, "9 割に満たないのに Pro ありと言い切る"],
        [mix.pro > 0.1, /Pro はまだ出していない/, "Pro のある道があるのにまだと言う"],
        [mix.switched < 0.9, /転職している。/, "9 割に満たないのに転職と言い切る"],
        [mix.switched <= 0.1, /転職した道/, "転職した道がほとんど無いのに含むと言う"],
      ];
      for (const [c, re, why] of ban) if (c && re.test(own)) out.push(`C2 中身の幅と合わない（${why}）`);
    } else {
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
      for (const [c, re, why] of ban) if (c && re.test(own + title)) out.push(`C2 状態と合わない（${why}）`);
    }
    // D: 文では食い違いを無くせないデータ（計算の側へ返す）。まとめた行き先はならした値なので数えない（文は平均・幅と書く）
    if (!sum) {
      if (s.pm === "n" && s.pro === 1 && s.j !== "i") out.push("D1 『どちらも不可』なのに Pro が続いている（状態の食い違い）");
      if (s.cl >= 0.05 && Math.abs(s.cl - Math.round(s.cl)) >= 0.15) out.push("D2 顧客の数が平均（整数でない）");
    }
    // C5: 結果の名前と顧客の数（中身の幅があれば、その上の端と比べる）
    const lab = map.label(i);
    const m1 = /^顧客 (\d+) 社$/.exec(lab);
    const m2 = /^顧客 (\d+) 社以下$/.exec(lab);
    const m3 = /^顧客 (\d+) 社以上$/.exec(lab);
    if (mix) {
      if (m3 && mix.cl[2] < Number(m3[1])) out.push(`C5 結果の名前「${lab}」と中身の幅（顧客 ${mix.cl[0]}〜${mix.cl[2]}）が合わない`);
    } else {
      if (m1 && Math.round(s.cl) !== Number(m1[1])) out.push(`C5 結果の名前「${lab}」と状態の顧客 ${s.cl.toFixed(2)} 社が合わない`);
      if (m2 && Math.round(s.cl) > Number(m2[1])) out.push(`C5 結果の名前「${lab}」と状態の顧客 ${s.cl.toFixed(2)} 社が合わない`);
    }
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
  if (role === "e" && !/^3 年後(?:の見込み|の平均)?: /.test(title)) out.push("C3 行き先の題");
  if ((role === "s" || role === "e" || role === "r") && nums.length < 3) out.push("C3 数の行が短い");
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

// ---- 道ごとの点検（C9: 道で 1 回だけの文）

/** 道で 1 回だけの文の見分け方: 束の言い換えから作った正規表現と、その文の名前（確定申告は年分ごと） */
export interface AdviceMatcher {
  readonly id: string;
  readonly re: RegExp;
  /** その年分を名前に足す（確定申告は年分ごとに 1 回） */
  readonly byYear: boolean;
}

/** 暦の確定申告と住民税の申告の型（どれも同じ年分の「申告の文」） */
const TAX_CELLS = new Set(["TAX_SIDE", "TAX_NEAR", "JUMIN_DECL", "TAX_IND", "TAX_MIX"]);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 言い換え 1 つを正規表現にする（{名前} は句点をまたがない何か。taxYear は年を取り出す） */
function variantRe(v: string): RegExp {
  const parts = v.split(/\{(\w+)\}/);
  let src = "";
  for (let k = 0; k < parts.length; k++) src += k % 2 === 0 ? escapeRe(parts[k]!) : parts[k] === "taxYear" ? "([^。]*?)" : "[^。]*?";
  return new RegExp(src, "g");
}

/** 束から、道で 1 回だけの文（暦・静かな期の一言・出来事の助言・避けたい訳）の見分け方を作る */
export function adviceMatchers(banks: Banks): AdviceMatcher[] {
  const out: AdviceMatcher[] = [];
  const add = (id: string, vs: ReadonlyArray<{ v: readonly string[] }> | undefined, perGroup: boolean, byYear = false): void => {
    (vs ?? []).forEach((g, gi) => {
      for (const v of g.v) out.push({ id: perGroup ? `${id}#${gi}` : id, re: variantRe(v), byYear });
    });
  };
  for (const [code, vs] of Object.entries(banks.cal)) {
    if (TAX_CELLS.has(code)) add("cal.TAX", vs, false, true);
    else add(`cal.${code}`, vs, false);
  }
  add("hint", banks.hint, true);
  for (const [code, vs] of Object.entries(banks.tip)) add(`tip.${code}`, vs, true);
  for (const [kind, vs] of Object.entries(banks.avoid)) add(`avoid.${kind}`, vs, false);
  return out;
}

/** 1 枚の本文（印つき）が使った、道で 1 回だけの文の名前（同じ名前が 2 回あれば 2 回数える） */
export function adviceIn(body: string, matchers: readonly AdviceMatcher[]): string[] {
  const out: string[] = [];
  for (const m of matchers) {
    m.re.lastIndex = 0;
    for (const hit of body.matchAll(m.re)) out.push(m.byYear ? `${m.id}@${(hit[1] ?? "").replace(/[^0-9]/g, "")}` : m.id);
  }
  return out;
}

/**
 * 地図のすべての道（今日から行き先まで）で、道で 1 回だけの文が 2 回出ていないか（C9）。bodyOf はカードの本文（印つき）。
 * 深さ優先で道の数え上げを持ち回るので、カードごとに 1 回だけ本文を見る
 */
export function checkPaths(map: MapData, bodyOf: (i: number) => string, banks: Banks): string[] {
  const matchers = adviceMatchers(banks);
  const out: string[] = [];
  const counts = new Map<string, number>();
  const stack: Array<[number, string[] | null]> = [[0, null]];
  while (stack.length) {
    const [i, undo] = stack.pop()!;
    if (undo) {
      for (const id of undo) counts.set(id, counts.get(id)! - 1);
      continue;
    }
    const ids = adviceIn(bodyOf(i), matchers);
    for (const id of ids) {
      const n = (counts.get(id) ?? 0) + 1;
      counts.set(id, n);
      if (n === 2) out.push(`C9 道で 2 回: ${id} ← ${map.key(i)}`);
    }
    stack.push([i, ids]);
    for (let k = map.childCount(i) - 1; k >= 0; k--) stack.push([map.child(i, k), null]);
  }
  return out;
}
