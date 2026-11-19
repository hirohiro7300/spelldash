// 文章の組み立ての小さな道具: 差し込みの印・数の書き方・条件の言葉・言葉の間の空け方。設計: 作業メモ SPEC v1 §4.1
// 元: 試作（R2）の compose.ts の書き方の部分（数の形と空け方は変えていない）
import type { ImpactLine } from "../impact";

/** 差し込んだ値の印（組み立ての途中だけ。点検はこの外に数字が無いことを確かめ、仕上げで消す） */
export const MS = "\u0001";
export const ME = "\u0002";
/** 手引き（やりたいことリストの項目）から入れた文の印。この中の数字は引いた項目にある数字（点検 C1b） */
export const PS = "\u0003";
export const PE = "\u0004";

/** 値を差し込みの印で包む */
export const slot = (s: string | number): string => `${MS}${s}${ME}`;
/** 手引きの文を印で包む（空なら空のまま） */
export const pbText = (s: string): string => (s ? `${PS}${s}${PE}` : "");
/** 印を消す */
export const strip = (s: string): string => s.replace(/[\u0001-\u0004]/g, "");

/** 万円の数（小数 1 桁。.0 は付けない） */
export function man(x: number): string {
  const v = Math.round(x * 10) / 10;
  return Number.isInteger(v) ? `${v === 0 ? 0 : v}` : v.toFixed(1);
}

/** 整数（3 桁ごとに区切る。地域の設定によらない） */
export function n0(x: number): string {
  const r = Math.round(x);
  const s = Math.abs(r)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return r < 0 ? `-${s}` : s;
}

/** 小数 2 桁（給与の倍率） */
export const f2 = (x: number): string => (Math.round(x * 100) / 100).toFixed(2);

/** 顧客の数を整数にする（状態の顧客の数は結果をならした値のことがある） */
export const clr = (cl: number): number => Math.round(cl);

/** 顧客の数の言い方: ちょうど・ほぼ・幅（結果の線の上下で幅を狭める） */
export function clPhrase(cl: number, ln?: ImpactLine | null): string {
  const r = Math.round(cl);
  if (cl < 0.05) return `${slot(0)} 社`;
  if (Math.abs(cl - r) < 0.05) return `${slot(r)} 社`;
  if (Math.abs(cl - r) < 0.15) return `ほぼ ${slot(r)} 社`;
  // 結果の線が顧客の数を区切る（ならした値は、丸めた数ごとの見本から出ている）
  let lo = Math.floor(cl);
  let hi = Math.ceil(cl);
  if (ln && ln[0] === "cl") {
    if (ln[3] !== null) hi = Math.min(hi, ln[3] - 1);
    if (ln[2] !== null) lo = Math.max(lo, ln[2]);
  }
  if (lo >= hi) return `${slot(hi)} 社`;
  return `${slot(lo)}〜${slot(hi)} 社`;
}

/** 小さい額は円（1 万円より下）、大きい額は万円 */
export function yenTxt(x: number): string {
  if (Math.abs(x) < 1) return `${slot(n0(Math.round(Math.abs(x) * 100) * 100))} 円`;
  return `${slot(man(Math.abs(x)))} 万円`;
}

/** 文字列の指紋（FNV-1a 32 ビット）。言い換えを選ぶ種 */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// ---- 条件の言葉: "j=e & pm!=n & cl>=0.5 & fl:pilot & !fl:js | pro=1"（& は | より先に結ぶ）

export type Env = Record<string, number | string>;
type Pred = (env: Env, flags: readonly string[]) => boolean;

/** 読んだ条件の覚え（文の型の条件は数十種類なので、一度読めば足りる） */
const COMPILED = new Map<string, Pred>();

/** 条件が合うか（空なら合う）。書き方が違えば投げる */
export function cond(expr: string | undefined, env: Env, flags: readonly string[]): boolean {
  if (!expr) return true;
  let p = COMPILED.get(expr);
  if (!p) {
    p = compile(expr);
    COMPILED.set(expr, p);
  }
  return p(env, flags);
}

function compile(expr: string): Pred {
  if (!expr.trim()) return () => true;
  const alts = expr.split("|").map((alt) => alt.split("&").map(atom));
  return (env, flags) => alts.some((all) => all.every((f) => f(env, flags)));
}

function atom(raw: string): Pred {
  let t = raw.trim();
  let neg = false;
  if (t.startsWith("!")) {
    neg = true;
    t = t.slice(1).trim();
  }
  let f: Pred;
  if (t.startsWith("fl:")) {
    const name = t.slice(3);
    f = (_env, flags) => flags.includes(name);
  } else {
    const m = /^(\w+)\s*(<=|>=|!=|=|<|>)\s*([\w.?-]+)$/.exec(t);
    if (!m) throw new Error(`条件の書き方が違います: ${t}`);
    const k = m[1]!;
    const op = m[2]!;
    const vs = m[3]!;
    const bNum = Number(vs);
    const b: number | string = Number.isFinite(bNum) && vs !== "?" ? bNum : vs;
    const bs = `${b}`;
    const bn = b as number;
    switch (op) {
      case "=":
        f = (env) => `${env[k]}` === bs;
        break;
      case "!=":
        f = (env) => `${env[k]}` !== bs;
        break;
      case "<":
        f = (env) => (env[k] as number) < bn;
        break;
      case "<=":
        f = (env) => (env[k] as number) <= bn;
        break;
      case ">":
        f = (env) => (env[k] as number) > bn;
        break;
      default:
        f = (env) => (env[k] as number) >= bn;
    }
  }
  return neg ? (env, flags) => !f(env, flags) : f;
}

// ---- 言葉の間: 日本語と英数字の間に 1 文字空け、日本語どうしは空けない（地図のほかの文と同じ）

const A = "A-Za-z0-9+−.,/%";
const NOSP = "（）「」『』〜・、。：:\\s　";
const SP_BEFORE_HOBO = /([^\x00-\x7F（「『、。]) (?=ほぼ)/g;
const SP_JA_A = new RegExp(`([^\\x00-\\x7F${NOSP}${A}])([${A.replace(".,/%", "")}])`, "g");
const SP_A_JA = new RegExp(`([A-Za-z0-9%])([^\\x00-\\x7F${NOSP}−])`, "g");

export function spaceJa(s: string): string {
  return s.replace(SP_BEFORE_HOBO, "$1").replace(SP_JA_A, "$1 $2").replace(SP_A_JA, "$1 $2").replace(/ {2,}/g, " ");
}
