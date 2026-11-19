// 3 か月ごとの地図を作る入口（main.ts）の引数を読む（node の機能を使わないので、テストからも読める）

import type { Mode } from "./core";
import { DEFAULTS, R1_ALTS_BY, type Params } from "./gen";
import { NSTAGE } from "./world";

export interface CliOpts {
  /** 書き出す木の場所（.gz はその隣） */
  out: string;
  params: Params;
  /** 作る最初の手（無ければ今日の 10 手すべて） */
  only?: string[];
  anchor: string;
  hash: string;
}

export const USAGE =
  "使い方: node scripts/impact/q/run.mjs --out <木.json> [--budget 2000] [--alts 4] [--alts-by 0,4,4,4,4,3,3,3,3,2,2,2|off] [--stub split|fact|lean] [--fact-cl] [--only keep,ad_permside] [--anchor 2026-11] [--hash dev-port]";

const MODES: readonly Mode[] = ["split", "fact", "lean"];

/** 引数を読む。既定は R1 が選んだ形（分かれ道 2,000・見せる手 4・1 年目 4／2 年目 3／3 年目 2・まとめた手も元の地図と同じまとめ方）。読めなければ投げる */
export function parseArgs(args: string[], rootMenu: readonly string[]): CliOpts {
  const params: Params = { ...DEFAULTS, altsBy: [...R1_ALTS_BY] };
  let out: string | null = null;
  let only: string[] | undefined;
  let anchor = "2026-11";
  let hash = "dev-port";
  const int = (name: string, v: string | undefined, min: number): number => {
    const n = Number(v);
    if (v === undefined || !Number.isInteger(n) || n < min) throw new Error(`${name} は ${min} 以上の整数で指定してください（${v ?? "なし"}）`);
    return n;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const v = args[i + 1];
    const value = (): string => {
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} の後に値がありません`);
      i++;
      return v;
    };
    switch (a) {
      case "--out":
        out = value();
        break;
      case "--budget":
        params.B = int(a, value(), 1);
        break;
      case "--alts":
        params.maxAlts = int(a, value(), 2);
        break;
      case "--alts-by": {
        const s = value();
        if (s === "off") {
          delete params.altsBy;
          break;
        }
        const xs = s.split(",");
        if (xs.length !== NSTAGE) throw new Error(`--alts-by は段ごとに ${NSTAGE} 個の数です（${xs.length} 個）`);
        params.altsBy = xs.map((x, k) => (k === 0 ? int(a, x, 0) : int(a, x, 2)));
        break;
      }
      case "--stub": {
        const s = value();
        if (!MODES.includes(s as Mode)) throw new Error(`--stub は ${MODES.join("・")} のどれかです（${s}）`);
        params.stubMode = s as Mode;
        break;
      }
      case "--fact-cl":
        params.factCl = true;
        break;
      case "--only": {
        const ks = value().split(",");
        const bad = ks.filter((k) => !rootMenu.includes(k));
        if (bad.length) throw new Error(`--only の手は今日の手（${rootMenu.join(",")}）から選んでください（${bad.join(",")}）`);
        only = ks;
        break;
      }
      case "--anchor":
        anchor = value();
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(anchor)) throw new Error(`--anchor は YYYY-MM です（${anchor}）`);
        break;
      case "--hash":
        hash = value();
        break;
      default:
        throw new Error(`知らない引数です: ${a}`);
    }
  }
  if (!out) throw new Error("--out（書き出す木の場所）が要ります");
  return { out, params, ...(only ? { only } : {}), anchor, hash };
}
