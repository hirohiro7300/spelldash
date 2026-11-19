// 試し版のカードの文章の入口（TextSource）。いまは地図の数だけで作る仮の文章。
// 文章の組み立て（src/demo/compose。別の作業）ができたら、この 1 か所で差し替える（ここでは組み立てをまねない）。

import { fallbackText, type TextSource } from "../deepmap/core";
import type { MapData } from "../deepmap/mapData";

export type TextFactory = (map: MapData, annual: number) => TextSource;

let factory: TextFactory = (map, annual) => fallbackText(map, { annual });

/** 文章の作り手を差し替える（文章の組み立てをつなぐとき） */
export function setTextFactory(f: TextFactory): void {
  factory = f;
}

/** 今の年収での文章 */
export function textSourceFor(map: MapData, annual: number): TextSource {
  return factory(map, annual);
}
