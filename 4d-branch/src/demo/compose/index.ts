// 文章の組み立ての入口（I-compose）。設計: 作業メモ SPEC v1 §4.1・§4.4
// 読むだけの地図（src/deepmap/mapData.ts の MapData）の番号 i のカードの文章を、文の型の束（BANKS）と今の年収から作る。DOM は使わない
// 使う所: 生成（題・短い名前・やることを先に作る・全部の本文を点検する）、アプリと試し版（本文と数の行をその場で作る）
// 道の覚え（今日からそのカードまでの手・出来事・使った手引き・道で 1 回だけの文の段取り）と兄弟の題は、地図の物ごとに WeakMap で持つ。
// 初めての 1 枚は道の長さぶん（と兄弟の題）、後は引くだけ。段取りと題は年収で変わらないので、年収を替えても作り直さない
import type { MapData } from "../../deepmap/mapData";
import { BANKS } from "./banks";
import { composeContMarked, composeMarked, contCardsMarked, type ContCard } from "./compose";
import { ctxOf, type ComposeRuntime } from "./path";
import { spaceJa, strip } from "./text";
import type { Banks, Card } from "./types";

export { BANKS } from "./banks";
export { optionValue, quarterSal, recommended, ripple, type ComposeRuntime, type Ripple } from "./path";
export type { ContCard } from "./compose";
export type { Banks, Card, CardTodo, Consts, Step, Variant } from "./types";

export interface ComposeOpts {
  /** 今の年収（万円）。給与の月額と、それで決まる文（避けたい手の訳など）に使う */
  annual: number;
  /** 文の型の束（省けば BANKS） */
  banks?: Banks;
  /**
   * 計算の芯（今の年収）の答え: おすすめの手・一番良い選び方の値・着く行き先の数。本文だけに使う（題・短い名前・やることは変わらない）。
   * 試し版とアプリは画面と同じ物を渡す（画面の「おすすめ」と本文の「おすすめ」を同じ手にする。truth-1）。省けば地図に書いた物で書く
   */
  rt?: ComposeRuntime;
}

function check(map: MapData, i: number, annual: number): void {
  if (!Number.isInteger(i) || i < 0 || i >= map.n) throw new RangeError(`カードの番号が地図の外です: ${i}`);
  if (!Number.isFinite(annual) || annual < 0) throw new RangeError(`年収の値が使えません: ${annual}`);
}

/** 差し込みの印つきのまま組み立てる（点検用。印の外に数字が無いこと・手引きの数字が引いた項目にあることを確かめる） */
export function composeMarkedCard(map: MapData, i: number, opts: ComposeOpts): Card {
  check(map, i, opts.annual);
  return composeMarked(ctxOf(map, opts.banks ?? BANKS, opts.annual, opts.rt ?? null), i);
}

/** 印を消して、言葉の間を地図のほかの文とそろえる */
export function finishCard(c: Card): Card {
  const fin = (s: string): string => spaceJa(strip(s));
  return { title: fin(c.title), short: fin(c.short), body: fin(c.body), numbers: c.numbers.map(fin), todo: c.todo.map((t) => ({ text: t.text, cite: t.cite })), trace: c.trace.slice() };
}

/** カード i の文章（題・短い名前・本文・数の行・やること 3 つまで（元にしたやりたいことリストの番号つき）・使った文の型） */
export function composeCard(map: MapData, i: number, opts: ComposeOpts): Card {
  return finishCard(composeMarkedCard(map, i, opts));
}

/**
 * まとめた行き先 i の標準の続き（cont）の k 番目の期の文章（題・本文・やること）。道の画面が、まとめた行き先の後の期を 1 行ずつ
 * 薄く出すときに使う（SPEC §5.4・reader-1）。まとめた行き先でない・k が範囲の外なら null
 */
export function composeCont(map: MapData, i: number, k: number, opts: ComposeOpts): ContCard | null {
  check(map, i, opts.annual);
  const c = composeContMarked(ctxOf(map, opts.banks ?? BANKS, opts.annual, opts.rt ?? null), i, k);
  if (!c) return null;
  const fin = (s: string): string => spaceJa(strip(s));
  return { m: c.m, kind: c.kind, title: fin(c.title), body: fin(c.body), todo: c.todo.map((t) => ({ text: t.text, cite: t.cite })) };
}

/** まとめた行き先 i の標準の続きの期の文章を全部、差し込みの印つきのまま（点検用。道の画面は composeCont で 1 期ずつ） */
export function composeMarkedConts(map: MapData, i: number, opts: ComposeOpts): ContCard[] {
  check(map, i, opts.annual);
  return contCardsMarked(ctxOf(map, opts.banks ?? BANKS, opts.annual, opts.rt ?? null), i);
}

/** 写し（複製・コピー）に入れる文章: 数の行（1 行）と本文。写しは地図の外のカードになるので、その時の年収で文にして残す */
export function materializeBody(map: MapData, i: number, annual: number, rt?: ComposeRuntime): string {
  const c = composeCard(map, i, { annual, ...(rt ? { rt } : {}) });
  return [c.numbers.join("・"), c.body].filter((x) => x.length > 0).join("\n");
}
