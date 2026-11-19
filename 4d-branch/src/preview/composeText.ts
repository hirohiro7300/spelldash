// 試し版の文章: 文章の組み立て（src/demo/compose）を、カードの文章の入口（TextSource）につなぐ。
// 設計: 作業メモ SPEC v1 §4.1・§4.3・§5.4、W-text の報告 §9。main.ts が起動の前に setTextFactory(composedText) で 1 回だけ差し込む。
// - 本文・数の行は、その時の年収で composeCard。道の画面が問うカード（開いた行の手と結果・道の始めと着いた所）だけを、
//   問われた時に組み立てる。起動では 1 枚も作らない（8 万枚を全部作ると約 5 秒）
// - 本文には計算の芯（src/deepmap/core）のその年収の答えを渡す（textRuntime: おすすめの手・一番良い選び方の値・着く行き先の数）。
//   画面の「おすすめ」の印と本文の「おすすめ」、手の詳しい画面と今日の手の本文の数が同じになる（作業メモ truth-1・reader-4・reader-8）
// - 題・短い名前・やることは地図に焼き込んだ物（MapData.title・short・todo。SPEC §4.3）。焼き込みの文の型の版がこの組み立てと
//   違う地図（作り直し前の地図）や、焼き込みの無い地図だけ、その場で組み立てた題と短い名前（作業メモ code-1。試し版のビルドは版の違う地図を止める）
// - 覚えは地図ごと・年収ごと・カードごと。年収を戻したときも作り直さない（覚える年収は新しい 4 つまで）。今日から道の上の覚えと
//   兄弟の題は組み立て側が地図ごとに持つので、年収を変えても作り直すのは本文と数の行だけ
// - まとめた行き先の後の標準の続きの 1 期は composeCont（道の画面の薄い行を開いたとき）
// - provisional は付けない（「文章は仮」の印は出ない）

import { BANKS, composeCard, composeCont, type Card, type ComposeRuntime } from "../demo/compose";
import { textRuntime, type Analysis, type ContText, type TextSource } from "../deepmap/core";
import type { MapData } from "../deepmap/mapData";

/** 覚えておく年収の数（新しく使った物から） */
const KEEP_ANNUALS = 4;

interface Memo {
  cards: Map<number, Card>;
  /** 「行き先の番号:期」→ 標準の続きの 1 期の文章 */
  cont: Map<string, ContText | null>;
}

const MEMO = new WeakMap<MapData, Map<string, Memo>>();

/** 組み立てた枚数と時間（確かめ用。起動の後に 0 枚なら、起動では作っていない）。banks は組み立ての文の型の版 */
export interface ComposeStats {
  cards: number;
  cont: number;
  ms: number;
  banks: string;
}

export const composeStats: ComposeStats = { cards: 0, cont: 0, ms: 0, banks: BANKS.version };

function memoOf(map: MapData, key: string): Memo {
  let byKey = MEMO.get(map);
  if (!byKey) MEMO.set(map, (byKey = new Map()));
  let m = byKey.get(key);
  if (m) {
    // 使った年収は新しい側へ（古い年収から忘れる）
    byKey.delete(key);
  } else {
    m = { cards: new Map(), cont: new Map() };
  }
  byKey.set(key, m);
  while (byKey.size > KEEP_ANNUALS) byKey.delete(byKey.keys().next().value!);
  return m;
}

/** 地図に焼き込んだ題・短い名前・やることが、この組み立ての文の型の版の物か（違えば題と短い名前はその場で組み立てる） */
export const bakedMatches = (map: MapData): boolean => !!map.header.textVersion && map.header.textVersion === BANKS.version;

/**
 * 焼き込んだ文章の文の型の版（地図の header.textVersion）と、この組み立ての版が違うときの訳（同じ・焼き込みの無い地図・開発用の "dev" は null）。
 * 試し版のビルドはこれで止め、ページはこれを知らせる（題とやることが古い言い方のまま、本文だけ新しくならないように。作業メモ code-1）
 */
export function textSkew(textVersion: string, banks: string = BANKS.version): string | null {
  if (!textVersion || textVersion === "dev" || textVersion === banks) return null;
  return `地図の文の型の版 ${textVersion} が、組み立ての版 ${banks} と違う（題とやることが古い言い方のまま、本文だけ新しくなる）`;
}

/**
 * 文章の組み立てで書いた、年収 annual の文章（TextSource）。a はその年収の計算の芯の答え（画面と同じ物。無ければ地図に書いた物で書く）。
 * 作るだけでは何も組み立てない
 */
export function composedText(map: MapData, annual: number, a?: Analysis): TextSource {
  const rt: ComposeRuntime | undefined = a ? textRuntime(a) : undefined;
  const memo = memoOf(map, `${annual}|${rt ? "rt" : "-"}`);
  const baked = bakedMatches(map);
  const card = (i: number): Card => {
    let c = memo.cards.get(i);
    if (!c) {
      const t = performance.now();
      c = composeCard(map, i, { annual, ...(rt ? { rt } : {}) });
      composeStats.ms += performance.now() - t;
      composeStats.cards++;
      memo.cards.set(i, c);
    }
    return c;
  };
  return {
    title: (i) => (baked && map.title(i) ? map.title(i) : card(i).title),
    short: (i) => (baked ? map.short(i) : card(i).short),
    body: (i) => card(i).body,
    numbers: (i) => card(i).numbers,
    cont: (i, k) => {
      const key = `${i}:${k}`;
      const had = memo.cont.get(key);
      if (had !== undefined) return had;
      const t = performance.now();
      const c = composeCont(map, i, k, { annual, ...(rt ? { rt } : {}) });
      composeStats.ms += performance.now() - t;
      composeStats.cont++;
      const v: ContText | null = c ? { title: c.title, body: c.body, todo: c.todo } : null;
      memo.cont.set(key, v);
      return v;
    },
  };
}
