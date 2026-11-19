// 試し版の文章: 文章の組み立て（src/demo/compose）を、カードの文章の入口（TextSource）につなぐ。
// 設計: 作業メモ SPEC v1 §4.1・§4.3・§5.4、W-text の報告 §9。main.ts が起動の前に setTextFactory(composedText) で 1 回だけ差し込む。
// - 題・短い名前・本文・数の行は、その時の年収で composeCard。道の画面が問うカード（開いた行の手と結果・道の始めと着いた所）だけを、
//   問われた時に組み立てる。起動では 1 枚も作らない（8 万枚を全部作ると約 5 秒）
// - 覚えは地図ごと・年収ごと・カードごと。年収を戻したときも作り直さない（覚える年収は新しい 4 つまで）。今日から道の上の覚えと
//   兄弟の題は組み立て側が地図ごとに持つので、年収を変えても作り直すのは本文と数の行だけ
// - やることは地図に焼き込んだ物（MapData.todo）を道の画面がそのまま出す（組み立てたやることと同じ。生成の TB1 の点検）
// - まとめた行き先の後の標準の続きの 1 期は composeCont（道の画面の薄い行を開いたとき）
// - provisional は付けない（「文章は仮」の印は出ない）
// - 今日の手の本文の先の分かれ道の数（ripple）は、組み立て側が地図ごとに 1 回下から数える。計算の芯（src/deepmap/core）の数を
//   渡す入口は組み立てに無いので、そのまま使う

import { composeCard, composeCont, type Card } from "../demo/compose";
import type { ContText, TextSource } from "../deepmap/core";
import type { MapData } from "../deepmap/mapData";

/** 覚えておく年収の数（新しく使った物から） */
const KEEP_ANNUALS = 4;

interface Memo {
  cards: Map<number, Card>;
  /** 「行き先の番号:期」→ 標準の続きの 1 期の文章 */
  cont: Map<string, ContText | null>;
}

const MEMO = new WeakMap<MapData, Map<number, Memo>>();

/** 組み立てた枚数と時間（確かめ用。起動の後に 0 枚なら、起動では作っていない） */
export interface ComposeStats {
  cards: number;
  cont: number;
  ms: number;
}

export const composeStats: ComposeStats = { cards: 0, cont: 0, ms: 0 };

function memoOf(map: MapData, annual: number): Memo {
  let byAnnual = MEMO.get(map);
  if (!byAnnual) MEMO.set(map, (byAnnual = new Map()));
  let m = byAnnual.get(annual);
  if (m) {
    // 使った年収は新しい側へ（古い年収から忘れる）
    byAnnual.delete(annual);
  } else {
    m = { cards: new Map(), cont: new Map() };
  }
  byAnnual.set(annual, m);
  while (byAnnual.size > KEEP_ANNUALS) byAnnual.delete(byAnnual.keys().next().value!);
  return m;
}

/** 文章の組み立てで書いた、年収 annual の文章（TextSource）。作るだけでは何も組み立てない */
export function composedText(map: MapData, annual: number): TextSource {
  const memo = memoOf(map, annual);
  const card = (i: number): Card => {
    let c = memo.cards.get(i);
    if (!c) {
      const t = performance.now();
      c = composeCard(map, i, { annual });
      composeStats.ms += performance.now() - t;
      composeStats.cards++;
      memo.cards.set(i, c);
    }
    return c;
  };
  return {
    title: (i) => card(i).title,
    short: (i) => card(i).short,
    body: (i) => card(i).body,
    numbers: (i) => card(i).numbers,
    cont: (i, k) => {
      const key = `${i}:${k}`;
      const had = memo.cont.get(key);
      if (had !== undefined) return had;
      const t = performance.now();
      const c = composeCont(map, i, k, { annual });
      composeStats.ms += performance.now() - t;
      composeStats.cont++;
      const v: ContText | null = c ? { title: c.title, body: c.body, todo: c.todo } : null;
      memo.cont.set(key, v);
      return v;
    },
  };
}
