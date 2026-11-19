// 3 か月ごとの地図を作る入口（main.ts）の引数を読む（node の機能を使わないので、テストからも読める）

import { DEFAULTS, R1_ALTS_BY, type Params } from "./gen";
import { menuOf, NSTAGE } from "./world";

export interface CliOpts {
  /** 書き出す木の場所（.gz はその隣） */
  out: string;
  params: Params;
  /** 作る最初の手（無ければ今日の手すべて） */
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
  /** 粗い表を引き始める順を変えて値の幅を測る順の数（1 なら測らない。報告だけで、書き出す物は変わらない。見直し truth-2） */
  spread: number;
  /** 順の幅で「3 年やらない」見積もり（k）の幅も測る（順ごとに粗い表を 16 回作り直すので遅い。報告用） */
  spreadNever: boolean;
  /** 書き出す場所にもうファイルがあっても書き直す（無ければ断る） */
  force: boolean;
  /**
   * 文章: 題・短い名前・やることを焼き込み（入口の textVersion は文の型の束の版）、文章の点検（年収 360・540。40 秒ほど）を生成の点検に入れる。
   * off は試すとき用（版 1 以上では使えない。焼き込まない木は題が仮の文）
   */
  text: boolean;
  /** 文章の点検の報告（Markdown）を書き出す場所 */
  textReport?: string;
  /** 道の見本（今日の手ごとの道。年収 360・540）を書き出す置き場 */
  golden?: string;
}

export const USAGE =
  "使い方: node scripts/impact/q/run.mjs --out <木.json> [--force] [--bundle <同梱.b64>] [--release 0] [--record <版の記録.json>] [--history <releases.json>] [--append-history] [--runs 2] [--spread 5] [--spread-never] [--budget 2000] [--tol 0.02] [--alts 4] [--alts-by 0,4,4,4,4,3,3,3,3,2,2,2|off] [--only keep,ad_permside] [--anchor 2026-11] [--never on|off] [--text on|off] [--text-report <報告.md>] [--golden <置き場>]";

/** 版の記録（release 1 以上）を作れる本番の形の点検: 今日の手すべて・分かれ道 2,000・±2% 以内・never あり・文章あり・2 回作る・見せる手と一貫性の年収は既定。通らない訳を返す */
export function productionProblems(o: Pick<CliOpts, "params" | "only" | "never" | "runs" | "text">): string[] {
  const p = o.params;
  const out: string[] = [];
  if (o.only) out.push(`--only（${o.only.join(",")}）は使えない（今日の手すべてを作る）`);
  if (p.B !== DEFAULTS.B) out.push(`--budget は ${DEFAULTS.B}（${p.B}）`);
  if (!(p.tol <= DEFAULTS.tol + 1e-12)) out.push(`--tol は ${DEFAULTS.tol} 以下（${p.tol}）`);
  if (!o.never) out.push("--never は on");
  if (!o.text) out.push("--text は on（題・短い名前・やることを焼き込み、文章の点検に通す）");
  if (p.annuals.length !== DEFAULTS.annuals.length || p.annuals.some((x, i) => x !== DEFAULTS.annuals[i])) out.push(`一貫性を守る年収は ${DEFAULTS.annuals.join("・")}（${p.annuals.join("・")}）`);
  if (o.runs !== 2) out.push(`--runs は 2（${o.runs}）`);
  if (p.maxAlts !== DEFAULTS.maxAlts) out.push(`--alts は ${DEFAULTS.maxAlts}（${p.maxAlts}）`);
  if (!p.altsBy || p.altsBy.length !== R1_ALTS_BY.length || p.altsBy.some((x, i) => x !== R1_ALTS_BY[i])) out.push(`--alts-by は ${R1_ALTS_BY.join(",")}`);
  return out;
}

/** 引数を読む。既定は R1 が選んだ形（分かれ道 2,000・見せる手 4・1 年目 4／2 年目 3／3 年目 2）。rootMenu は世界の今日の手（地図の年月で昇格を狙う手が足される: menuOf）。読めなければ投げる */
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
  let spread = 5;
  let spreadNever = false;
  let force = false;
  let text = true;
  let textReport: string | undefined;
  let golden: string | undefined;
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
      case "--force":
        force = true;
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
      case "--tol": {
        // 分かれ道の数の目標の幅（±、割合）。小さい予算の木（テストの木）は分かれ道の数が飛ぶので、広げて作る
        const v = value();
        const t = Number(v);
        if (!(Number.isFinite(t) && t > 0)) throw new Error(`--tol は 0 より大きい数です（${v}）`);
        params.tol = t;
        break;
      }
      case "--only":
        only = value().split(",");
        break;
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
      case "--spread":
        spread = int(a, value(), 1);
        break;
      case "--spread-never":
        spreadNever = true;
        break;
      case "--never": {
        const s = value();
        if (s !== "on" && s !== "off") throw new Error(`--never は on か off です（${s}）`);
        never = s === "on";
        break;
      }
      case "--text": {
        const s = value();
        if (s !== "on" && s !== "off") throw new Error(`--text は on か off です（${s}）`);
        text = s === "on";
        break;
      }
      case "--text-report":
        textReport = value();
        break;
      case "--golden":
        golden = value();
        break;
      default:
        throw new Error(`知らない引数です: ${a}`);
    }
  }
  if (!out) throw new Error("--out（書き出す木の場所）が要ります");
  // 今日の手は地図の年月で決まる（1〜3 月の年月なら昇格を狙う手が足される）ので、--only は年月を読んだ後に点検する
  const menu = menuOf(rootMenu, anchor);
  if (only) {
    const bad = only.filter((k) => !menu.includes(k));
    if (bad.length) throw new Error(`--only の手は今日の手（${menu.join(",")}）から選んでください（${bad.join(",")}）`);
  }
  if ((record || appendHistory) && release < 1) throw new Error("--record・--append-history は --release 1 以上と一緒に使います");
  // 版の記録は足すだけで戻せないので、版の順番を付ける（release 1 以上）のは本番の形の時だけ（見直し format-1）。release 0 は試し・テストの木用で自由
  if ((textReport || golden) && !text) throw new Error("--text-report・--golden は --text on の時だけ使えます");
  if (release >= 1) {
    const bad = productionProblems({ params, ...(only ? { only } : {}), never, runs, text });
    if (bad.length) throw new Error(`版の記録は本番の形（今日の手すべて・${DEFAULTS.B.toLocaleString("ja-JP")}・±${DEFAULTS.tol * 100}%・never・文章・2 回）でだけ作れます: ${bad.join("・")}`);
  }
  return {
    out,
    params,
    ...(only ? { only } : {}),
    anchor,
    never,
    ...(bundle ? { bundle } : {}),
    release,
    ...(record ? { record } : {}),
    ...(history ? { history } : {}),
    appendHistory,
    runs,
    spread,
    spreadNever,
    force,
    text,
    ...(textReport ? { textReport } : {}),
    ...(golden ? { golden } : {}),
  };
}
