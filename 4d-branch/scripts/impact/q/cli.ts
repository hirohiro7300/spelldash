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
  /** 「3 年やらない」見積もり（never）を作る（off は試すとき用） */
  never: boolean;
  /** 同梱データ（決まった並びの gzip の base64）を書き出す場所。無ければ書かない（点検はする） */
  bundle?: string;
  /** 版の順番（入口の release。開発用の木は 0） */
  release: number;
  /** 提案する版の記録 {release, hash, anchor} を書き出す場所（release が 1 以上のとき） */
  record?: string;
  /** 版の記録（足すだけ）の場所。無ければ scripts/impact/releases.json */
  history?: string;
  /** 版の記録に足す（既定は足さずに、足せるかだけを点検する） */
  appendHistory: boolean;
  /** 作る回数。2 なら最初から作り直して、決まった並びと指紋が同じかを点検する（D1） */
  runs: number;
}

export const USAGE =
  "使い方: node scripts/impact/q/run.mjs --out <木.json> [--bundle <同梱.b64>] [--release 0] [--record <版の記録.json>] [--history <releases.json>] [--append-history] [--runs 2] [--budget 2000] [--tol 0.02] [--alts 4] [--alts-by 0,4,4,4,4,3,3,3,3,2,2,2|off] [--stub split|fact|lean] [--fact-cl] [--only keep,ad_permside] [--anchor 2026-11] [--never on|off]";

const MODES: readonly Mode[] = ["split", "fact", "lean"];

/** 引数を読む。既定は R1 が選んだ形（分かれ道 2,000・見せる手 4・1 年目 4／2 年目 3／3 年目 2・まとめた手も元の地図と同じまとめ方）。読めなければ投げる */
export function parseArgs(args: string[], rootMenu: readonly string[]): CliOpts {
  const params: Params = { ...DEFAULTS, altsBy: [...R1_ALTS_BY] };
  let out: string | null = null;
  let only: string[] | undefined;
  let anchor = "2026-11";
  let never = true;
  let bundle: string | undefined;
  let release = 0;
  let record: string | undefined;
  let history: string | undefined;
  let appendHistory = false;
  let runs = 2;
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
      case "--tol": {
        // 分かれ道の数の目標の幅（±、割合）。小さい予算の木（テストの木）は分かれ道の数が飛ぶので、広げて作る
        const v = value();
        const t = Number(v);
        if (!(Number.isFinite(t) && t > 0)) throw new Error(`--tol は 0 より大きい数です（${v}）`);
        params.tol = t;
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
      case "--bundle":
        bundle = value();
        break;
      case "--release":
        release = int(a, value(), 0);
        break;
      case "--record":
        record = value();
        break;
      case "--history":
        history = value();
        break;
      case "--append-history":
        appendHistory = true;
        break;
      case "--runs":
        runs = int(a, value(), 1);
        if (runs > 2) throw new Error(`--runs は 1 か 2 です（${runs}）`);
        break;
      case "--never": {
        const s = value();
        if (s !== "on" && s !== "off") throw new Error(`--never は on か off です（${s}）`);
        never = s === "on";
        break;
      }
      default:
        throw new Error(`知らない引数です: ${a}`);
    }
  }
  if (!out) throw new Error("--out（書き出す木の場所）が要ります");
  if ((record || appendHistory) && release < 1) throw new Error("--record・--append-history は --release 1 以上と一緒に使います");
  return { out, params, ...(only ? { only } : {}), anchor, never, ...(bundle ? { bundle } : {}), release, ...(record ? { record } : {}), ...(history ? { history } : {}), appendHistory, runs };
}
