// 文の型の束を書くための小さな道具（./sentences.ts・./playbook.ts で使う）
import type { Step, Variant } from "../types";

/** いつも使える言い換えの組 */
export const V = (...v: string[]): Variant => ({ v });

/** 条件が合うときだけ使う言い換えの組（条件の書き方は ../text.ts の cond） */
export const If = (c: string, ...v: string[]): Variant => ({ if: c, v });

/** 手引きの 1 歩: やりたいことリストの番号・やること・本文の文・{ 2 回目からの題・条件 } */
export const S = (id: string, todo: string, act: string, o: { title?: string; if?: string; lead?: string } = {}): Step => ({ id, todo, act, ...o });
