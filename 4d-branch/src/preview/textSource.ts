// 試し版のカードの文章の入口（TextSource）を作る所。作り手は 1 つで、起動の前に 1 回だけ差し替える:
// main.ts が文章の組み立て（./composeText.ts の composedText。src/demo/compose）を入れる。差し替えなければ、地図の数だけで作る仮の文章
// （「文章は仮」の印が出る）。画面は年収を変えるたびに作り直した入口を使う（本文と数の行はいつもその時の年収）。

import { fallbackText, type Analysis, type TextSource } from "../deepmap/core";
import type { MapData } from "../deepmap/mapData";

/** 文章の作り手: 地図・年収と、その年収の計算の芯の答え（画面と同じおすすめと数を本文に書くため。作業メモ truth-1） */
export type TextFactory = (map: MapData, annual: number, a?: Analysis) => TextSource;

let factory: TextFactory = (map, annual) => fallbackText(map, { annual });

/** 文章の作り手を差し替える（起動の前に 1 回） */
export function setTextFactory(f: TextFactory): void {
  factory = f;
}

/** 今の年収での文章（a はその年収の計算の芯の答え） */
export function textSourceFor(map: MapData, annual: number, a?: Analysis): TextSource {
  return factory(map, annual, a);
}
