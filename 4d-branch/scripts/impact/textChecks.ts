// 文章の点検（生成が止める点検。設計: 作業メモ SPEC v1 §4.6・§4.7）。持ち主は W-text。生成の runChecks（./check.ts）へは W-gen がつなぐ
// 地図（MapData）の全部のカードを年収ごとに組み立てて点検し、点検ごとの数と例・長さ・道の繰り返し・兄弟の題・時間を返す。DOM も node も使わない
// 1 枚ごとの点検は src/demo/compose/checks.ts（checkCard）、ここは束・兄弟・道の点検と、まとめ・道の見本（golden）を持つ
//   C1 数はどれもデータから・C1b 手引きの数字は引いた項目に・C2 状態と食い違わない・C3 長さと題とやること 3 つ・C4 地図の文の決まり・
//   C4b 英数字の名前・C5 結果の名前と状態（本当の状態）・C5b 顧客と席は整数・C6 似かた（兄弟の骨組み・道の繰り返し）・C7 手引きの月額・
//   C8 言葉の間とカードの年月の言い直し・C9 道で 1 回だけの文・C10 数の言い方・C11 手が結果について言う額と数が結果の状態と合う（reader-4）・
//   C12 道の歩みと合う（reader-6。前の会社で選んだ手の続き・何も変えなかった結果を一番の動きと言う。F4・F5）・T4 兄弟の題は違う（手も結果も。gaps-11）。
//   題は年収で変わらない（年収ごとに新しい覚えで組み立てて比べる。code-1）。道の繰り返しの行のまとめ方は、道の画面と同じ計算の芯の joinsRow
//   D1・D2 は文では直せないデータ（警告。計算の側へ返す）
// 使い方（CLI）: node scripts/impact/runTextChecks.mjs <木.json|木.json.gz> [--annual 360,540] [--examples 5] [--out 報告.md] [--golden 置き場]
import { compileMap } from "../../src/deepmap/core/compile";
import { textRuntime } from "../../src/deepmap/core/moves";
import { analyze } from "../../src/deepmap/core/passes";
import { joinsRow, rowJoinOf, type RowJoin } from "../../src/deepmap/core/path";
import { fromDevTree } from "../../src/deepmap/dev/fromTree";
import type { DevTree, MapData, MapRole } from "../../src/deepmap/mapData";
import { BANKS, composeMarkedCard, composeMarkedConts, finishCard, type Banks, type Card, type ComposeRuntime } from "../../src/demo/compose";
import { checkBanks, checkCard, checkCont, checkPaths, recommendIssues, stateRecommendIssues, wishIndex, type WishText } from "../../src/demo/compose/checks";
import { calendarOf, likeliest, recommended, type Calendar } from "../../src/demo/compose/path";
import { hash, spaceJa, strip } from "../../src/demo/compose/text";
import type { WishData } from "../../src/demo/wishlist";
import wishData from "../../src/demo/wishlist-data.json";

// ---- 点検の名前

export type TextCheckId = "C1" | "C1b" | "C2" | "C3" | "C4" | "C4b" | "C5" | "C5b" | "C6" | "C7" | "C8" | "C9" | "C10" | "C11" | "C12" | "C13" | "T4" | "D1" | "D2";

export interface TextCheckDef {
  id: TextCheckId;
  name: string;
  /** 落ちたら生成を止める（D はデータの指摘なので警告） */
  block: boolean;
}

export const TEXT_CHECKS: readonly TextCheckDef[] = [
  { id: "C1", name: "数はどれもデータから（差し込みの印の外に数字が無い）", block: true },
  { id: "C1b", name: "手引きの文の数字は、引いたやりたいことリストの項目にある", block: true },
  { id: "C2", name: "状態と食い違わない（まとめた行き先は中身の幅と平均・社数の幅で 2 社目を決めて言わない）・この地図の前提を事実や会社の決まりとして言い過ぎない", block: true },
  { id: "C3", name: "長さ・題・やること 3 つ・数の行", block: true },
  { id: "C4", name: "地図の文の決まり（% と差・敬語・位置・気持ち）", block: true },
  { id: "C4b", name: "英数字の名前を書かない", block: true },
  { id: "C5", name: "結果の名前と状態の顧客の数が合う（本当の状態と行き先）", block: true },
  { id: "C5b", name: "顧客と学校の席は整数", block: true },
  { id: "C6", name: "似かた（兄弟の骨組み・中身の同じまとめた行き先・道の繰り返し・判断ごとの繰り返し）", block: true },
  { id: "C7", name: "手引きの月額がモデルにある", block: true },
  { id: "C8", name: "言葉の間・カードの年月を言い直さない", block: true },
  { id: "C9", name: "道で 1 回だけの文が、道で 2 回出ない", block: true },
  { id: "C10", name: "数の言い方（月にならして・手数料とサーバー代を引いて・月に遊んだ人・3 つの月）", block: true },
  { id: "C11", name: "手が結果について言う額と数（売上・席・年収・倍率・次の顧客の月額・昇格の額）が結果の状態と合う・まとめた手と行き先が言う出来事の月（会社員に戻る月など）が標準の続きの出来事の月と合う", block: true },
  { id: "C12", name: "道の歩みと合う（前の手・転職活動の期・顧客の有無・会社員だった期間・広告運用の稼ぎ・前の会社の手の続き・何も変えなかった結果・次の判断に無い手を勧めない）", block: true },
  { id: "C13", name: "本文の「おすすめ」が画面のおすすめ（その年収の一番良い選び方の手）と同じ手で、おすすめより多いと言い切らない・状態は次の判断のおすすめの手（選べる手が無ければその訳）を言う", block: true },
  { id: "T4", name: "兄弟の題が違う（手も結果も）", block: true },
  { id: "D1", name: "『どちらも不可』なのに Pro が続く（データ。計算の側へ返す）", block: false },
  { id: "D2", name: "本当の状態の顧客の数が整数でない（データ。計算の側へ返す）", block: false },
];
const DEF = new Map(TEXT_CHECKS.map((d) => [d.id, d] as const));
const isCheckId = (x: string): x is TextCheckId => DEF.has(x as TextCheckId);

// ---- C6 の門（SPEC §4.6: 測ってから決める。最初は道 1 本で 4 つまで・兄弟は 0）

export interface TextGates {
  /** 今日から行き先までの道 1 本で、構造でない文（同じ骨組み）の繰り返しの上限。どの道もこれ以下 */
  pathRepeats: number;
  /** 兄弟（同じ判断の手どうし・同じ手の結果どうし）で本文の骨組みが同じ組の数の上限 */
  siblingSame: number;
  /** 続く 2 つの判断に並ぶ同じ種類の手（道で選ばなかった方）どうしが、同じ骨組みで言う構造でない文の数の上限（reader-8） */
  decisionRepeats: number;
}

/**
 * 門（SPEC §4.6: 測ってから決める）。道の繰り返しは、道の画面（W-view の groupRows）と同じまとめ方で数えて道 1 本 4 まで。
 * 兄弟の骨組みが同じ組は 0。判断ごとの繰り返しは、続く 2 つの判断の同じ種類の手が同じ文を 1 つまで（今のままの書き出し・手引きは判断の月で回す）。
 * 測った値は作業メモ reports/text-v1.md。P3 で締める
 */
export const TEXT_GATES: TextGates = { pathRepeats: 4, siblingSame: 0, decisionRepeats: 1 };

// ---- 骨組み（数字を # にした文）と、構造の文

/** 数字を # にする（言い換えの骨組みを比べる。R2 の scale.ts と同じ） */
export const mask = (s: string): string => s.replace(/[0-9][0-9,.]*/g, "#");

/** 本文を文に分ける（句点で。8 字以下の切れ端は数えない。R2 と同じ） */
export function sentencesOf(body: string): string[] {
  return body
    .split("。")
    .map((x) => x.trim())
    .filter((x) => [...x].length > 8);
}

/**
 * 構造の文: どのカードにもある枠で、中身は数の行と同じくデータ（0.8 からは状態の数の枠: この結果の見込みと月の稼ぎの動き・3 年の見込み・
 * 別の結果との 3 年の見込みの差・次の手の並びの違い・分かれ道・次の手とおすすめ・今日の手の効き目。手の 1 つの結果の見込み・分かれ目の書き出し・
 * 数で分かれる結果の数・年月だけの書き出し）。状態の数の枠は言い方ごとに 1 つの枠として数える（道 1 本で 4 回まで。L2）。道の繰り返し（C6）には数えない（user-9: 構造の文が並ぶのは水増しに読めない）。
 * 状態の書き出しの年月（「# 年 # 月、」）は落としてから、残り（出来事の文）を中身として比べる
 */
/** 見込みの割（「# 割」「# 割 # 分」「# 分」） */
const WARI = "# (?:割(?: # 分)?|分)";
/** 3 年の見込みの差に添える月の稼ぎの違い（「（年収で # 万円の差）」） */
const NOTE = "(?:（[^）]*）)?";
const L = "『[^』]*』";
export const STRUCTURAL: readonly RegExp[] = [
  // 0.8（W2）: 状態の数の枠（L2: どれも 3 つ以上の言い方を道の上の位置で回す。言い方ごとに 1 つの枠として数える）
  // S1 この結果の見込みと、この 3 か月の月の稼ぎの動き
  new RegExp(`^(?:見込み ${WARI}の結果で、)?月の稼ぎは # か月前(?:とほぼ同じ|より # 万円(?:増えた|減った)(?:（主に[^）]*）)?)$`),
  new RegExp(`^この # か月で月の稼ぎは(?:ほぼ動いていない|ほぼ動かず、この結果になる見込みは ${WARI}だった| # 万円(?:増えた|減った)(?:（主に[^）]*）)?| # 万円(?:増え|減り)(?:（主に[^）]*）)?、この結果になる見込みは ${WARI}だった)$`),
  new RegExp(`^(?:${WARI}の見込みで起きた結果で、)?(?:月の稼ぎは # か月前と変わらない|# か月前と比べた月の稼ぎは [+−]# 万円(?:（主に[^）]*）)?)$`),
  new RegExp(`^この結果になる見込みは ${WARI}だった$`),
  new RegExp(`^${WARI}の見込みで起きた結果$`),
  new RegExp(`^見込み ${WARI}の結果$`),
  // S2 今日からの 3 年の見込み（ここまで + この先）と、3 か月前からの動き・ずっと今のままとの差（L1・L4）
  /^今日からの # 年の見込みは −?# 万円（ここまで −?# 万円＋この先 −?# 万円）(?:で、(?:今日|# か月前)の見込み(?:より # 万円(?:上がった|下がった)|とほぼ同じ))?$/,
  /^この先は、(?:毎回おすすめの手を選んだ場合|おすすめの手の後を標準の選び方で続けた場合)(?:で、ずっと今のままなら # 年で −?# 万円)?$/,
  /^# 年の見込みは、ここまでの −?# 万円とこの先の −?# 万円で −?# 万円(?:になり、# か月前(?:より # 万円(?:上がった|下がった)|とほぼ同じ))?$/,
  /^ここまでの −?# 万円にこの先の −?# 万円を足した # 年の見込みは −?# 万円(?:で、# か月前(?:より # 万円(?:上がった|下がった)|とほぼ同じ))?$/,
  /^ずっと今のままの # 年(?:より # 万円(?:多い|少ない)|とほぼ同じ)$/,
  // S3 同じ手の別の結果との 3 年の見込みの差（7 つの言い方を位置と兄弟の並びで回す。rep-4）
  new RegExp(`^同じ手で${L}だった場合より、# 年の見込みが # 万円(?:多い|少ない)${NOTE}$`),
  new RegExp(`^# 年の見込みを${L}の場合と比べると、# 万円(?:多い|少ない)${NOTE}$`),
  new RegExp(`^${L}だった道と比べて、# 年の見込みは # 万円(?:多い|少ない)${NOTE}$`),
  new RegExp(`^この結果の # 年の見込みは、${L}の場合より # 万円(?:多い|少ない)${NOTE}$`),
  new RegExp(`^${L}の場合なら、# 年の見込みは # 万円(?:少なかった|多かった)${NOTE}$`),
  new RegExp(`^${L}の場合と比べた # 年の見込みは [+−]# 万円${NOTE}$`),
  new RegExp(`^# 年の見込みで見ると、この結果は${L}の場合より # 万円(?:多い|少ない)${NOTE}$`),
  new RegExp(`^同じ手で${L}だった場合と、# 年の見込みはほとんど変わらない${NOTE}$`),
  new RegExp(`^# 年の見込みは、${L}の場合とほぼ同じ${NOTE}$`),
  new RegExp(`^${L}と比べても、この結果の # 年の見込みはほぼ同じ${NOTE}$`),
  new RegExp(`^# 年の見込みは、${L}の場合より # 万円少なく、${L}の場合より # 万円多い$`),
  new RegExp(`^この結果の # 年の見込みは、${L}だった場合に # 万円届かず、${L}だった場合を # 万円上回る$`),
  new RegExp(`^同じ手の結果と比べると、# 年の見込みは${L}の場合の # 万円下で、${L}の場合の # 万円上$`),
  // S3 の続き: 別の結果と比べた次の手の並び
  new RegExp(`^${L}の場合に次に並んだ.+は、この結果では選べ(?:ず、代わりに.+が並ぶ|ない)$`),
  new RegExp(`^この結果では.+が選べる代わりに、${L}の場合にある.+は並ばない$`),
  new RegExp(`^次の手の並びも${L}の場合とは違い、.+が消えて.+が入る$`),
  new RegExp(`^この結果の次の手には、${L}の場合(?:にある.+が無い|に無い.+が加わる)$`),
  new RegExp(`^次の手の並びは${L}の場合より(?:少なく、.+が無い|多く、.+も選べる)$`),
  new RegExp(`^${L}の場合には無い.+が、この結果では選べる$`),
  // S4 今日の手の先の分かれ道のうち、ここから残る数（別の結果の後の数と比べる）
  /^ここから # 年 # 月までの分かれ道は #（判断 #・出来事の分かれ #）/,
  new RegExp(`^今日の(?:${L}|手)の先の # の分かれ道のうち、ここから残るのは #（判断 #・出来事の分かれ #）`),
  new RegExp(`^今日の(?:${L}|手)から数えて # ある分かれ道は、この結果の先に #（判断 #・出来事の分かれ #）が残る`),
  new RegExp(`^この先に続く分かれ道は、今日の(?:${L}|手)の後の # のうち #（判断 #・出来事の分かれ #）`),
  new RegExp(`^今日の(?:${L}|手)の先の(?: # の分かれ道のうち、ここから残るのは #|分かれ道 #（判断 #・出来事の分かれ #）は、どれもこの結果から続く)$`),
  new RegExp(`^今日の(?:${L}|手)から数え(?:て # ある分かれ道は、この結果の先に # が残る|た分かれ道 #（判断 #・出来事の分かれ #）が、そのままこの先に残る)$`),
  new RegExp(`^この先に続く分かれ道は、今日の(?:${L}|手)の後の(?: # のうち #|（判断 #・出来事の分かれ #）の全部| #（判断 #・出来事の分かれ #）の全部)$`),
  // 出来事の後の数の枠: 持てる顧客の上限・次の顧客の見込みの動き・今のままの期と残る判断
  /^(?:会社員|週 # 日勤務|独立)で持てる顧客は # 社まで(?:（あと # 社）)?$/,
  /^(?:あと # 社で、(?:会社員|週 # 日勤務|独立)で持てる # 社の上限に届く|(?:会社員|週 # 日勤務|独立)のうちに持てる顧客の上限は # 社)$/,
  /^(?:(?:会社員|週 # 日勤務|独立)のうちは # 社が上限で、残りは # 社|顧客の上限は、(?:会社員|週 # 日勤務|独立)で # 社)$/,
  new RegExp(`^# 社目が決まる見込みは、前の期の ${WARI}から ${WARI}に動いた$`),
  new RegExp(`^前の期に ${WARI}だった # 社目の見込みは、今回 ${WARI}$`),
  new RegExp(`^# 社目の見込みは ${WARI}から ${WARI}へ$`),
  /^何も足さない期はこれで # 期目で、# 年 # 月までに残る判断は # 回$/,
  /^今のままを選んだのは # 回目で、残る判断はあと # 回$/,
  /^# 年 # 月までの判断はあと # 回で、今のままはこれが # 期目$/,
  // S5 次の手の数・おすすめの手（見込み）・ほかの手との差（rep-8）
  new RegExp(`^# 年 # 月までの手は # つで、(?:おすすめは|地図を作った年収の見積もりで一番の手は)${L}(?:（[^）]*）)?$`),
  new RegExp(`^次の # か月に選べる # つの手のうち、(?:おすすめは|地図を作った年収の見積もりで一番の手は)${L}(?:（[^）]*）)?$`),
  new RegExp(`^ここで選べる手は # つあり、(?:# 年の稼ぎが一番多いのは|地図を作った年収の見積もりで一番の手は)${L}(?:（[^）]*）)?$`),
  /^次の # か月に選べる手は今のままだけ（[^）]*）$/,
  /^ほかの手は、『/,
  /^おすすめとの差は、『/,
  /^残りの手は、おすすめ(?:より|と)『/,
  /^ほかに選べるのは、『/,
  // 今日の手とその答えが、この状態をまだ決めている（L4・rep-14）
  new RegExp(`^.+のは、今日の${L}(?:の結果が${L}だった|があった)から$`),
  new RegExp(`^今日の${L}(?:が${L}だったので|で)、`),
  new RegExp(`^# 年 # 月(?:の${L}（今日の${L}の結果）|までの${L}（今日の手）)がまだ効いていて、`),
  // 1 つの結果の見込み（手）
  /^# 年 # 月の見込みは、/,
  /^# 年 # 月には、.*見込み$/,
  /^この # か月で、.*見込み$/,
  /^# 年 # 月まで、数字はほぼ今のまま$/,
  /^# 年 # 月の見積もり（標準の続き）は、/,
  // 分かれ目の書き出し（手）
  /^分かれ目は # 年 # 月の/,
  /^# 年 # 月の.*で道が分かれる$/,
  /^見る数は # 年 # 月の/,
  /^その先は # 年 # 月の.*しだい$/,
  /^この手の答えは # 年 # 月の.*で出る$/,
  // 数で分かれる結果ごとの数（手）
  /^『[^』]*』なら(?:売上 月 # 万円ほど|広告運用の売上はまだ無い|有料 # 人ほど|月に遊ぶ人 # 人ほど|# 年 # 月に平均で)/,
  // 前の 3 か月の手をつなぐ一言（道のデータ。道の画面では前の行にある）
  /^前の # か月は[^、]*$/,
  // 事実の答えが出る月（手）
  /^答えが出るのは # 年 # 月の/,
  // この手の 3 年の見積もりと、この手の先の分かれ道の数（どの手にもある数の行と同じデータ。reader-1・reader-2）。見積もり方の言い方は truth-4
  /^この手で進むと、ここから # 年 # 月までの稼ぎは/,
  /^その後を一番良い選び方で進めば、平均 # 万円$/,
  /^この手の先、# 年 # 月までの分かれ道は/,
  // まとめた手の印（SPEC §4.2 が求める決まった注。手の種類の名前のような物）
  /^この手の先は分かれ道を開かず、標準の選び方で続けた見積もり$/,
  // 標準の続きの 1 期の枠（道の画面の薄い行の見出しと同じデータ: その期の手・一番ありそうな出来事。reader-7）
  /^# 年 # 月〜(?:# 年 )?# 月は、標準の選び方では『[^』]*』の # か月$/,
  /^この期に一番ありそうな出来事は『[^』]*』$/,
  /^(?:大きな出来事の無い # か月の見込み|目立った出来事の無い # か月とみた)$/,
];

/** 文の骨組み。構造の文なら null。書き出しの年月（「# 年 # 月、」）と、来た結果を受ける言葉（「『…』を受けて、」）は落として比べる */
export function skeleton(sentence: string): string | null {
  const k = mask(sentence).replace(/^(?:# 年 # 月|今月)、/, "").replace(/^『[^』]*』を受けて、/, "");
  if ([...k].length <= 8) return null;
  return STRUCTURAL.some((re) => re.test(k)) ? null : k;
}

// ---- C8（言葉の間・カードの年月の言い直し）

/** 文の型に差し込む言葉のうち、日本語で始まることがある物（前に空白を置くと「は 年収」になる） */
const JA_START = new Set(["salYen", "hiYen", "midYen", "salNow", "salBack", "partLoss", "job", "jobName", "lab", "next1", "act1", "act2", "stepTitle", "capNote", "period", "ym"]);
/** 日本語で終わる物（後ろに空白を置くと「社 の」になる） */
const JA_END = new Set(["period", "ym", "ymNext", "ym1", "ym2", "ymTell", "ymInd", "ymApril", "nextApril", "ymEv", "job", "salx", "salYen", "salBack", "stepYen", "clp", "lab", "next1", "taxYear", "taxPeriod", "taxDeadline", "salNow", "partLoss", "act1", "act2", "stepTitle", "promoP", "promoPScope", "schoolP", "schoolPPilot", "firstP", "firstPPortfolio", "sideP", "sidePPortfolio", "permA", "permS", "permN", "switchP1", "switchP2", "partP", "backP", "pilotP", "churnQ", "share", "sharePrev", "growth", "conv", "hz", "jobName", "hiX", "midX", "hiYen", "midYen"]);

/** 束の言い換えの、差し込みの隣の空白（間は組み立てが空ける。R2 の C8） */
export function bankSpacing(banks: Banks): string[] {
  const out: string[] = [];
  const visit = (where: string, v: string): void => {
    for (const m of v.matchAll(/([^\x00-\x7F]) \{(\w+)\}/g)) if (JA_START.has(m[2]!)) out.push(`C8 差し込みの前に空白「${m[1]} {${m[2]}}」: ${where}「${v}」`);
    for (const m of v.matchAll(/\{(\w+)\} ([^\x00-\x7F\s])/g)) if (JA_END.has(m[1]!)) out.push(`C8 差し込みの後に空白「{${m[1]}} ${m[2]}」: ${where}「${v}」`);
  };
  const walk = (where: string, x: unknown): void => {
    if (typeof x === "string") visit(where, x);
    else if (Array.isArray(x)) x.forEach((y, k) => walk(`${where}#${k}`, y));
    else if (x && typeof x === "object") for (const [k, y] of Object.entries(x)) walk(where ? `${where}.${k}` : k, y);
  };
  for (const [sec, x] of Object.entries(banks)) if (sec !== "playbook" && sec !== "C" && sec !== "version") walk(sec, x);
  return out;
}

/**
 * 仕上げた文の言葉の間（C8）: 日本語どうしの間の空白・空白の重なり・端の空白・句読点と括弧の隣の空白。
 * 決まった書き方は除く: 月額の「売上 月 5 万円」、数の行の「年収 平均 400 万円」、符号の「−2」、「」の中の検索の言葉
 */
export function spacingIssues(s: string): string[] {
  const out: string[] = [];
  if (/ {2,}/.test(s)) out.push("空白が 2 つ続く");
  if (/^\s|\s$/.test(s)) out.push("端に空白");
  const p = / [、。）」』]|[（「『] /.exec(s);
  if (p) out.push(`句読点か括弧の隣に空白「${p[0]}」`);
  // 「この後の目安: 2027 年 11 月 転職活動 → …」は年月と手を空けて並べる決まった書き方（SPEC §4.2）
  const t = s.replace(/「[^」]*」/g, "「」").replace(/この後の目安: [^。]*/g, "");
  for (const m of t.matchAll(/([^\x00-\x7F]) ([^\x00-\x7F])/g)) {
    const after = t.slice((m.index ?? 0) + 2);
    if (m[2] === "−" || (m[2] === "月" && /^月 [0-9]/.test(after)) || (m[2] === "平" && /^平均 [0-9]/.test(after))) continue;
    out.push(`日本語の間に空白「${m[0]}」`);
  }
  return out;
}

/** カードの年月を、2 つ目からの文の頭でもう一度言う（状態の書き出し「2027 年 8 月、」の後に「8 月に…」。R2 の C8） */
export function ownDateAgain(body: string, cal: Calendar, m: number): string | null {
  if (m === 0) return null;
  const [y, mo] = cal.parts(m);
  const full = `${y} 年 ${mo} 月`;
  const short = new RegExp(`^${mo} 月(?![〜0-9])`);
  let hits = 0;
  for (const x of body.split("。")) {
    const t = x.trim();
    if (t.startsWith(full) || short.test(t)) hits++;
  }
  return hits >= 2 ? full : null;
}

// ---- 走らせ方と結果

export interface TextCheckOpts {
  /** 年収（万円）。既定は 360 と 540（SPEC §4.7 と同じ 2 つ） */
  annuals?: readonly number[];
  banks?: Banks;
  /** やりたいことリストの索引（既定は src/demo/wishlist-data.json） */
  wish?: ReadonlyMap<string, WishText>;
  /** 点検ごとの例の数（既定 5） */
  examples?: number;
  gates?: Partial<TextGates>;
}

export interface CheckCount {
  id: TextCheckId;
  name: string;
  block: boolean;
  /** 見つかった数（カードごとの点検はカードの数ではなく見つかった物の数） */
  n: number;
  /** 役割ごと（束の点検は bank・道の点検は path） */
  by: Record<string, number>;
  examples: string[];
}

export interface Dist {
  n: number;
  min: number;
  p10: number;
  median: number;
  p90: number;
  max: number;
  mean: number;
}

export interface PathRepeats {
  /** 道の数（今日から行き先まで。行き先の数と同じ） */
  paths: number;
  /** 門にかける数（同じ手が続く期を 1 つにまとめた繰り返し）の分布 */
  dist: Dist;
  /** 繰り返しの数 → 道の数 */
  hist: Record<number, number>;
  /** まとめない繰り返し（同じ骨組みが n 回なら n − 1）の分布 */
  raw: Dist;
  histRaw: Record<number, number>;
  overGate: number;
  /** 一番多い道 */
  worst: Array<{ key: string; n: number; repeated: string[] }>;
  /** よく繰り返す骨組み（道の数で数える） */
  top: Array<[string, number]>;
  /**
   * 1 つの枠を一番多く使う数（道ごと。構造の文も入れる。行ごとに 1 回）の分布と、目安（FRAME_SOFT）を超える道の数・一番多く使われる枠
   * （道の数）。止めない（作業メモ text-w1 の L2: 数の枠を構造の文にしてよい代わりに、道でいくつ並ぶかを報告する）
   */
  frames: { dist: Dist; hist: Record<number, number>; over: number; top: Array<[string, number]> };
  /** 同じ物を状態の本文の文だけで数えた物（0.8・W2: 状態の数の枠は道の上の位置で 3 つ以上の言い方を回すので、目安の 4 に収まるか） */
  stateFrames: { dist: Dist; hist: Record<number, number>; over: number; top: Array<[string, number]> };
}

/** 道 1 本で 1 つの枠を使う数の目安（報告だけ。止めない。L2） */
export const FRAME_SOFT = 4;

/** 文の枠: 構造の文は「構造 N」（STRUCTURAL の何番目か）、ほかは骨組みの『』の中も伏せた物（L2 の報告で数える） */
export function frameOf(sentence: string): string | null {
  const k = mask(sentence).replace(/^(?:# 年 # 月|今月)、/, "").replace(/^『[^』]*』を受けて、/, "");
  if ([...k].length <= 8) return null;
  const si = STRUCTURAL.findIndex((re) => re.test(k));
  return si >= 0 ? `構造 ${si}` : k.replace(/『[^』]*』/g, "『』");
}

export interface Siblings {
  movePairs: number;
  moveSame: number;
  outPairs: number;
  outSame: number;
  titlePairs: number;
  titleSame: number;
  titleSameByRole: Record<string, number>;
  /** 手の兄弟で、本文の書き出し（数字を伏せた最初の 14 字）が同じ組（報告だけ。rep-6・L6） */
  openerSame: number;
  /** 結果が 3 つ以上で、どれも別の結果と比べる文を持つ組と、そのうち比べる文の枠がどれも同じ組（報告だけ。rep-4・L6） */
  cmpGroups: number;
  cmpSame: number;
}

/** 判断ごとの繰り返し: 続く 2 つの判断に並ぶ同じ種類の手（道で選ばなかった方）どうしが同じ骨組みで言う構造でない文の数 */
export interface DecisionRepeats {
  /** 比べた組の数 */
  pairs: number;
  /** 同じ文の数 → 組の数 */
  hist: Record<number, number>;
  overGate: number;
  /** よく重なる骨組み（組の数） */
  top: Array<[string, number]>;
}

export interface TextCheckRun {
  annual: number;
  cards: number;
  /** 点検した標準の続きの期の数（まとめた行き先の後の行。reader-7） */
  contRows: number;
  checks: CheckCount[];
  /** 本文の字数（役割ごと） */
  lengths: Record<string, Dist>;
  titleLengths: Record<string, Dist>;
  pathRepeats: PathRepeats;
  decisionRepeats: DecisionRepeats;
  siblings: Siblings;
  /** いとこ（同じ最初の手・月・種類で親が違う。R2 と同じ抜き出し）: 同じ文・同じ骨組み（参考。門ではない） */
  cousins: { pairs: number; same: number; skeleton: number };
  /** 本文が完全に同じカードの割合（参考） */
  identical: number;
  /** 状態の本文がほかのカードの本文と同じ数と、状態の数（参考。rep-3） */
  identicalState: { same: number; states: number };
  /** 状態のうち、次の判断のおすすめの手（選べる手が無ければその訳）を言う数（0.8・W2。言わない物は C13 で止める） */
  stateRec: { named: number; states: number };
  ms: { compose: number; perCardUs: number; cardChecks: number; paths: number; siblings: number };
}

export interface TextCheckReport {
  ok: boolean;
  tree: { nodes: number; hash: string; anchor: string };
  gates: TextGates;
  /** 生成を止める物（点検ごとに数と例） */
  failures: string[];
  /** 止めない物（データの指摘） */
  warnings: string[];
  /** 束の点検（年収によらない） */
  bank: CheckCount[];
  runs: TextCheckRun[];
}

const ROLES: readonly MapRole[] = ["r", "a", "s", "e"];

function dist(xs: readonly number[]): Dist {
  if (!xs.length) return { n: 0, min: 0, p10: 0, median: 0, p90: 0, max: 0, mean: 0 };
  const s = xs.slice().sort((a, b) => a - b);
  const q = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return { n: s.length, min: s[0]!, p10: q(0.1), median: q(0.5), p90: q(0.9), max: s[s.length - 1]!, mean: Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 10) / 10 };
}

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** 点検の数え上げ（例は同じ説明を重ねずに k 個まで） */
class Tally {
  private readonly m = new Map<TextCheckId, CheckCount>();
  private readonly seen = new Map<TextCheckId, Set<string>>();
  constructor(private readonly k: number) {}
  add(msg: string, where: string, ex?: string): void {
    const id0 = msg.split(" ")[0] ?? "";
    const id: TextCheckId = isCheckId(id0) ? id0 : "C3";
    let c = this.m.get(id);
    if (!c) {
      const d = DEF.get(id)!;
      c = { id, name: d.name, block: d.block, n: 0, by: {}, examples: [] };
      this.m.set(id, c);
      this.seen.set(id, new Set());
    }
    c.n++;
    c.by[where] = (c.by[where] ?? 0) + 1;
    // 例は説明ごとに 1 つ（同じ説明が何千とあっても、ほかの種類の例が埋もれない）
    const kind = msg.replace(/[0-9][0-9,.]*/g, "#").slice(0, 40);
    const seen = this.seen.get(id)!;
    if (c.examples.length < this.k && !seen.has(kind)) {
      seen.add(kind);
      c.examples.push(ex ? `${msg} ← ${ex}` : msg);
    }
  }
  list(): CheckCount[] {
    return TEXT_CHECKS.map((d) => this.m.get(d.id)).filter((x): x is CheckCount => !!x);
  }
}

let WISH: ReadonlyMap<string, WishText> | null = null;
/** やりたいことリストの索引（1 回だけ作る） */
export function defaultWish(): ReadonlyMap<string, WishText> {
  return (WISH ??= wishIndex(wishData as unknown as WishData));
}

/**
 * 地図の全部のカードを年収ごとに組み立てて、文章の点検を走らせる。
 * 返す failures が空でなければ生成を止める（W-gen の runChecks の failures に足す）。warnings はデータの指摘
 */
export function runTextChecks(map: MapData, opts: TextCheckOpts = {}): TextCheckReport {
  const banks = opts.banks ?? BANKS;
  const wish = opts.wish ?? defaultWish();
  const k = opts.examples ?? 5;
  const gates: TextGates = { ...TEXT_GATES, ...opts.gates };
  const annuals = opts.annuals ?? [360, 540];
  // 束の点検（年収によらない）
  const bt = new Tally(k);
  for (const x of checkBanks(banks, wish)) bt.add(x, "bank");
  for (const x of bankSpacing(banks)) bt.add(x, "bank");
  // 題は年収で変わらない（題は兄弟ごとに覚えるので、年収で変わると組み立ての順で題が変わる。code-1）。年収ごとに束を写して新しい覚えで組み立て、題を比べる
  const titles: string[][] = [];
  const runs = annuals.map((annual, r) => runOne(map, annual, r === 0 ? banks : { ...banks }, wish, k, gates, (t) => titles.push(t)));
  for (let r = 1; r < titles.length; r++) {
    let diff = 0;
    for (let i = 0; i < map.n; i++)
      if (titles[r]![i] !== titles[0]![i]) {
        if (diff < k) bt.add(`C3 題が年収で変わる（${annuals[0]}「${titles[0]![i]}」・${annuals[r]}「${titles[r]![i]}」）`, map.role(i), map.key(i));
        diff++;
      }
    for (let j = k; j < diff; j++) bt.add("C3 題が年収で変わる", "title");
  }
  const bank = bt.list();
  const failures: string[] = [];
  const warnings: string[] = [];
  const emit = (c: CheckCount, at: string): void => {
    const head = `${c.id} ${c.name}: ${c.n.toLocaleString("en-US")} 件（${at}・${Object.entries(c.by)
      .map(([r, v]) => `${r} ${v.toLocaleString("en-US")}`)
      .join("・")}）`;
    (c.block ? failures : warnings).push(head, ...c.examples.map((e) => `  ${e}`));
  };
  for (const c of bank) emit(c, "束");
  for (const r of runs) for (const c of r.checks) emit(c, `年収 ${r.annual}`);
  return { ok: failures.length === 0, tree: { nodes: map.n, hash: map.header.hash, anchor: map.header.anchor }, gates, failures, warnings, bank, runs };
}

/** 地図をその年収で計算の芯にかけた答え（画面と同じおすすめ・一番良い選び方の値・着く行き先の数）。組み立てに渡す（truth-1・reader-4） */
export function runtimeOf(map: MapData, annual: number): ComposeRuntime {
  return textRuntime(analyze(compileMap(map), annual));
}

function runOne(map: MapData, annual: number, banks: Banks, wish: ReadonlyMap<string, WishText>, k: number, gates: TextGates, onTitles: (t: string[]) => void): TextCheckRun {
  const n = map.n;
  const cal = calendarOf(map.header);
  const marked: Card[] = new Array<Card>(n);
  const fin: Card[] = new Array<Card>(n);
  // 画面（試し版・アプリ）と同じ本文を点検する: 計算の芯の答えを組み立てに渡す
  const rt = runtimeOf(map, annual);
  const t0 = now();
  for (let i = 0; i < n; i++) {
    const c = composeMarkedCard(map, i, { annual, banks, rt });
    marked[i] = c;
    fin[i] = finishCard(c);
  }
  // まとめた行き先の後の標準の続きの期（道の画面で開ける行。reader-7）。行き先ごとに全部の期を 1 回で
  const contMarked = new Map<number, Card[]>();
  const contFin = new Map<number, string[]>();
  for (let i = 0; i < n; i++) {
    if (map.role(i) !== "e" || !map.sum(i) || !map.cont(i)?.length) continue;
    const rows = composeMarkedConts(map, i, { annual, banks, rt }).map((x) => ({ title: x.title, short: "", body: x.body, numbers: [], todo: x.todo, trace: [] }) as Card);
    contMarked.set(i, rows);
    contFin.set(i, rows.map((x) => spaceJa(strip(x.body))));
  }
  const tCompose = now() - t0;
  const tally = new Tally(k);
  // 状態のうち、次の判断のおすすめの手（無ければ選べない訳）を言う物（0.8・W2）
  const stateRec = { named: 0, states: 0 };
  // 1 枚ごと（C1・C1b・C2・C3・C4・C4b・C5・C5b・C7・C10・D1・D2 は checks.ts、C8 はここ）
  const t1 = now();
  for (let i = 0; i < n; i++) {
    const role = map.role(i);
    const key = map.key(i);
    for (const x of checkCard(map, i, marked[i]!, banks, wish, annual)) tally.add(x, role, key);
    const f = fin[i]!;
    for (const part of [f.title, f.short, f.body, ...f.numbers, ...f.todo.map((t) => t.text)]) for (const x of spacingIssues(part)) tally.add(`C8 ${x}`, role, key);
    const again = ownDateAgain(f.body, cal, map.month(i));
    if (again) tally.add(`C8 カードの年月（${again}）を文の頭でもう一度言う`, role, key);
    // C13: 本文の「おすすめ」は画面のおすすめと同じ手（truth-1）。状態は次の判断のおすすめの手を必ず言う（0.8・W2）
    if (role === "a") for (const x of recommendIssues(map, i, f.body, rt.recommended!)) tally.add(`C13 ${x}`, role, key);
    if (role === "s") {
      const xs = stateRecommendIssues(map, i, f.body, rt.recommended!);
      for (const x of xs) tally.add(`C13 ${x}`, role, key);
      stateRec.states++;
      if (!xs.length) stateRec.named++;
    }
  }
  // 標準の続きの期（1 枚ごとの点検と言葉の間）
  let contRows = 0;
  for (const [i, rows] of contMarked) {
    const d = map.parent(map.parent(i));
    rows.forEach((row, j) => {
      contRows++;
      const key = `${map.key(i)}#${j}`;
      for (const x of checkCont(map, d, row, wish)) tally.add(x, "cont", key);
      const f = finishCard(row);
      for (const part of [f.title, f.body, ...f.todo.map((t) => t.text)]) for (const x of spacingIssues(part)) tally.add(`C8 ${x}`, "cont", key);
    });
  }
  const tCards = now() - t1;
  // 道（C9・C6 の道の繰り返し）
  const t2 = now();
  for (const x of checkPaths(map, (i) => marked[i]!.body, banks, (i) => (contMarked.get(i) ?? []).map((x) => x.body))) tally.add(x, "path");
  const pathRepeats = repeatsOnPaths(map, fin, gates, k, (i) => contFin.get(i) ?? [], (i, j) => map.cont(i)![j]!.m);
  for (const w of pathRepeats.worst.filter((x) => x.n > gates.pathRepeats)) tally.add(`C6 道の繰り返し ${w.n}（門 ${gates.pathRepeats}）: ${w.repeated.slice(0, 3).join(" / ")}`, "path", w.key);
  for (let j = pathRepeats.worst.filter((x) => x.n > gates.pathRepeats).length; j < pathRepeats.overGate; j++) tally.add(`C6 道の繰り返しが門（${gates.pathRepeats}）を超える`, "path");
  const decisionRepeats = repeatsByDecision(map, marked, gates, (msg, key) => tally.add(msg, "decision", key));
  const tPaths = now() - t2;
  // 兄弟（C6 の骨組み・T4 の題）
  const t3 = now();
  // 兄弟の組は門（siblingSame）より多い分だけ落とす（門が 0 なら全部の組）
  const siblings = siblingPass(map, fin, banks, gates.siblingSame, (msg, role, key) => tally.add(msg, role, key));
  const tSibs = now() - t3;
  // 長さ
  const lengths: Record<string, Dist> = {};
  const titleLengths: Record<string, Dist> = {};
  for (const r of ROLES) {
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (map.role(i) === r) idx.push(i);
    if (!idx.length) continue;
    lengths[r] = dist(idx.map((i) => [...fin[i]!.body].length));
    titleLengths[r] = dist(idx.map((i) => [...fin[i]!.title].length));
  }
  const firsts: number[] = [];
  for (let c = 0; c < map.childCount(0); c++) firsts.push(map.child(0, c));
  if (firsts.length) lengths.first = dist(firsts.map((i) => [...fin[i]!.body].length));
  // 参考: いとこと、まったく同じ本文
  const cousins = cousinPass(map, fin);
  const bodies = new Map<string, number>();
  for (let i = 1; i < n; i++) bodies.set(fin[i]!.body, (bodies.get(fin[i]!.body) ?? 0) + 1);
  let dup = 0;
  for (const v of bodies.values()) if (v > 1) dup += v;
  // 状態の本文がほかのカードと同じ（参考。rep-3）
  const identicalState = { same: 0, states: 0 };
  for (let i = 1; i < n; i++)
    if (map.role(i) === "s") {
      identicalState.states++;
      if ((bodies.get(fin[i]!.body) ?? 0) > 1) identicalState.same++;
    }
  onTitles(fin.map((c) => c.title));
  return {
    annual,
    cards: n,
    contRows,
    checks: tally.list(),
    lengths,
    titleLengths,
    pathRepeats,
    decisionRepeats,
    siblings,
    cousins,
    identical: n > 1 ? dup / (n - 1) : 0,
    identicalState,
    stateRec,
    ms: { compose: Math.round(tCompose), perCardUs: Math.round((tCompose / Math.max(1, n)) * 10000) / 10, cardChecks: Math.round(tCards), paths: Math.round(tPaths), siblings: Math.round(tSibs) },
  };
}

/**
 * 文の骨組みを番号にした、カードごとの構造でない文（道の繰り返し・判断ごとの繰り返しで使う）。bodyOf は比べる本文。
 * idsOf はほかの本文（標準の続きの期）の骨組みを同じ番号で（新しい骨組みは names に足す）
 */
function skeletonIds(map: MapData, bodyOf: (i: number) => string): { perCard: Int32Array[]; names: string[]; idsOf: (body: string) => Int32Array } {
  const ids = new Map<string, number>();
  const names: string[] = [];
  const idsOf = (body: string): Int32Array => {
    const arr: number[] = [];
    for (const s of sentencesOf(body)) {
      const sk = skeleton(s);
      if (sk === null) continue;
      let id = ids.get(sk);
      if (id === undefined) {
        id = names.length;
        ids.set(sk, id);
        names.push(sk);
      }
      arr.push(id);
    }
    return Int32Array.from(arr);
  };
  const perCard: Int32Array[] = new Array<Int32Array>(map.n);
  for (let i = 0; i < map.n; i++) perCard[i] = idsOf(bodyOf(i));
  return { perCard, names, idsOf };
}

/**
 * 道の行（判断・手・結果 i）の番号: 道の画面が前の行（prev）とまとめるなら前の行の番号 run のまま、そうでなければ手の月を新しい行の番号にする
 * （手の月は道で増える）。まとめるかは道の画面と同じ決まり（計算の芯の joinsRow。src/deepmap/core/path.ts の groupRows も使う。
 * code-2: 種類だけでまとめると、道の画面より多くまとめてしまう）
 */
export function rowOf(map: MapData, prev: RowJoin | null, run: number, i: number): { key: RowJoin; run: number } {
  const a = map.parent(i);
  const key = rowJoinOf(map, a, i);
  return { key, run: joinsRow(prev, key) ? run : map.month(a) };
}

/**
 * 道（今日から行き先まで）ごとの、構造でない文の繰り返しの数。全部の道を深さ優先で 1 回。2 つ数える:
 * - そのまま: 同じ骨組みの文が道で n 回なら n − 1
 * - 門にかける数: 道の画面が 1 行にまとめる行（rowOf: 同じ手が続き、結果が 1 つか同じ名前）を 1 つにまとめて数える。
 *   まとめた行の中で同じ文が出るのは、画面では 1 行に入る同じ状況。別の行どうしの繰り返しを門にかける（SPEC §4.6・§5.4、W-view の groupRows）
 * 手の文は、その結果の行に入れて数える（行は判断・手・結果の組）。
 * まとめた行き先の後の標準の続きの期（道の画面で開ける薄い行。reader-7）も、その道の続きの行として数える（contOf: 期ごとの本文・contMonth: 期の月）
 */
function repeatsOnPaths(map: MapData, fin: readonly Card[], gates: TextGates, k: number, contOf: (i: number) => readonly string[] = () => [], contMonth: (i: number, j: number) => number = () => 0): PathRepeats {
  const { perCard, names, idsOf } = skeletonIds(map, (i) => fin[i]!.body);
  const contIds = new Map<number, Int32Array[]>();
  for (let i = 0; i < map.n; i++) {
    if (map.childCount(i)) continue;
    const bodies = contOf(i);
    if (bodies.length) contIds.set(i, bodies.map(idsOf));
  }
  // 枠（構造の文も入れる。報告だけ。L2）: 行ごとに 1 回数え、道の終わりで一番多く使った枠の数
  const fIds = new Map<string, number>();
  const fNames: string[] = [];
  const framesOf = (body: string): Int32Array => {
    const arr: number[] = [];
    for (const x of sentencesOf(body)) {
      const fr = frameOf(x);
      if (fr === null) continue;
      let id = fIds.get(fr);
      if (id === undefined) {
        id = fNames.length;
        fIds.set(fr, id);
        fNames.push(fr);
      }
      arr.push(id);
    }
    return Int32Array.from(arr);
  };
  const perFrame: Int32Array[] = new Array<Int32Array>(map.n);
  for (let i = 0; i < map.n; i++) perFrame[i] = framesOf(fin[i]!.body);
  // 元に戻す記録: [枠, 前の fLast（−3 は同じ行の中）]
  type FUndo = Array<[number, number]>;
  // 状態の本文の枠だけ（行ごとに 1 回。状態の枠の使い方を、手の枠と分けて見る）
  const sRuns = new Int32Array(fNames.length + 1);
  const sLast = new Int32Array(fNames.length + 1).fill(-2);
  const sOn: number[] = [];
  const sMax: number[] = [];
  const sHist: Record<number, number> = {};
  const sTop = new Map<number, number>();
  const countS = (ids: Int32Array, r: number, u: FUndo): void => {
    for (const f of ids) {
      if (sLast[f] === r) {
        u.push([f, -3]);
        continue;
      }
      sRuns[f]!++;
      sOn.push(f);
      u.push([f, sLast[f]!]);
      sLast[f] = r;
    }
  };
  const undoS = (u: FUndo): void => {
    for (let j = u.length - 1; j >= 0; j--) {
      const [f, last] = u[j]!;
      if (last === -3) continue;
      sRuns[f]!--;
      sLast[f] = last;
      sOn.pop();
    }
  };
  const contFrames = new Map<number, Int32Array[]>();
  for (let i = 0; i < map.n; i++) if (!map.childCount(i) && contOf(i).length) contFrames.set(i, contOf(i).map(framesOf));
  const fRuns = new Int32Array(fNames.length);
  const fLast = new Int32Array(fNames.length).fill(-2);
  const fOn: number[] = [];
  const fMax: number[] = [];
  const fHist: Record<number, number> = {};
  const fTop = new Map<number, number>();
  const countF = (ids: Int32Array, r: number, u: FUndo): void => {
    for (const f of ids) {
      if (fLast[f] === r) {
        u.push([f, -3]);
        continue;
      }
      fRuns[f]!++;
      fOn.push(f);
      u.push([f, fLast[f]!]);
      fLast[f] = r;
    }
  };
  const undoF = (u: FUndo): void => {
    for (let j = u.length - 1; j >= 0; j--) {
      const [f, last] = u[j]!;
      if (last === -3) continue;
      fRuns[f]!--;
      fLast[f] = last;
      fOn.pop();
    }
  };
  const cnt = new Int32Array(names.length);
  const runs = new Int32Array(names.length);
  const lastRun = new Int32Array(names.length).fill(-2);
  const repAt = new Int32Array(names.length);
  const hist: Record<number, number> = {};
  const histRaw: Record<number, number> = {};
  const per: number[] = [];
  const perRaw: number[] = [];
  const worst: Array<{ key: string; n: number; repeated: string[] }> = [];
  let raw = 0;
  let rep = 0;
  // 今の道で、門にかかる繰り返しになった骨組み
  const active: number[] = [];
  // 元に戻す記録: [骨組み, 前の lastRun（−3 は同じ行の中）, 別の行の繰り返しだったか]
  type Undo = Array<[number, number, boolean]>;
  const count = (ids: Int32Array, r: number, u: Undo): void => {
    for (const s of ids) {
      if (cnt[s]! >= 1) raw++;
      cnt[s]!++;
      if (lastRun[s] === r) {
        u.push([s, -3, false]);
        continue;
      }
      const counted = runs[s]! >= 1;
      if (counted) {
        rep++;
        active.push(s);
      }
      runs[s]!++;
      u.push([s, lastRun[s]!, counted]);
      lastRun[s] = r;
    }
  };
  const undoAll = (undo: Undo): void => {
    for (let j = undo.length - 1; j >= 0; j--) {
      const [s, last, counted] = undo[j]!;
      cnt[s]!--;
      if (cnt[s]! >= 1) raw--;
      if (last !== -3) {
        runs[s]!--;
        lastRun[s] = last;
      }
      if (counted) {
        rep--;
        active.pop();
      }
    }
  };
  // [カード, 行の番号, 前の行の値, 戻るときの記録（骨組みと枠）]
  const stack: Array<[number, number, RowJoin | null, [Undo, FUndo, FUndo] | null]> = [[0, -1, null, null]];
  while (stack.length) {
    const [i, run, prev, undo] = stack.pop()!;
    if (undo) {
      undoAll(undo[0]);
      undoF(undo[1]);
      undoS(undo[2]);
      continue;
    }
    const role = map.role(i);
    let r = run;
    let next = prev;
    const u: Undo = [];
    const uf: FUndo = [];
    const us: FUndo = [];
    if (role === "r") {
      count(perCard[i]!, r, u);
      countF(perFrame[i]!, r, uf);
    } else if (role === "s" || role === "e") {
      // 行（判断・手・結果）: 道の画面が前の行とまとめるなら同じ行の番号、そうでなければ新しい行
      const a = map.parent(i);
      const row = rowOf(map, prev, r, i);
      r = row.run;
      next = row.key;
      count(perCard[a]!, r, u);
      count(perCard[i]!, r, u);
      countF(perFrame[a]!, r, uf);
      countF(perFrame[i]!, r, uf);
      if (role === "s") countS(perFrame[i]!, r, us);
    }
    if (role !== "a") stack.push([i, r, next, [u, uf, us]]);
    const kids = map.childCount(i);
    if (!kids) {
      // 標準の続きの期（期ごとに別の行。行の番号は道の行の月と重ならないように 100 + 月）
      const uc: Undo = [];
      const ucf: FUndo = [];
      (contIds.get(i) ?? []).forEach((ids, j) => count(ids, 100 + contMonth(i, j), uc));
      (contFrames.get(i) ?? []).forEach((ids, j) => countF(ids, 100 + contMonth(i, j), ucf));
      let fm = 0;
      let fa = -1;
      for (const f of fOn)
        if (fRuns[f]! > fm) {
          fm = fRuns[f]!;
          fa = f;
        }
      fMax.push(fm);
      fHist[fm] = (fHist[fm] ?? 0) + 1;
      if (fa >= 0) fTop.set(fa, (fTop.get(fa) ?? 0) + 1);
      let sm = 0;
      let sa = -1;
      for (const f of sOn)
        if (sRuns[f]! > sm) {
          sm = sRuns[f]!;
          sa = f;
        }
      sMax.push(sm);
      sHist[sm] = (sHist[sm] ?? 0) + 1;
      if (sa >= 0) sTop.set(sa, (sTop.get(sa) ?? 0) + 1);
      undoF(ucf);
      per.push(rep);
      perRaw.push(raw);
      hist[rep] = (hist[rep] ?? 0) + 1;
      histRaw[raw] = (histRaw[raw] ?? 0) + 1;
      for (const s of active) repAt[s]!++;
      if (worst.length < Math.max(k, 20) || rep > worst[worst.length - 1]!.n) {
        const counted = new Map<string, number>();
        for (const s of active) counted.set(names[s]!, (counted.get(names[s]!) ?? 0) + 1);
        worst.push({ key: map.key(i), n: rep, repeated: [...counted].sort((a, b) => b[1] - a[1]).map(([x, c]) => `「${x.slice(0, 30)}…」×${c + 1}`) });
        worst.sort((a, b) => b.n - a.n);
        if (worst.length > Math.max(k, 20)) worst.length = Math.max(k, 20);
      }
      undoAll(uc);
      continue;
    }
    for (let c = kids - 1; c >= 0; c--) stack.push([map.child(i, c), r, next, null]);
  }
  const top: Array<[string, number]> = [];
  for (let s = 0; s < names.length; s++) if (repAt[s]! > 0) top.push([names[s]!, repAt[s]!]);
  top.sort((a, b) => b[1] - a[1]);
  const frames = {
    dist: dist(fMax),
    hist: fHist,
    over: fMax.filter((x) => x > FRAME_SOFT).length,
    top: [...fTop]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([f, c]) => [fNames[f]!, c] as [string, number]),
  };
  const stateFrames = {
    dist: dist(sMax),
    hist: sHist,
    over: sMax.filter((x) => x > FRAME_SOFT).length,
    top: [...sTop]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([f, c]) => [fNames[f]!, c] as [string, number]),
  };
  return { paths: per.length, dist: dist(per), hist, raw: dist(perRaw), histRaw, overGate: per.filter((x) => x > gates.pathRepeats).length, worst: worst.slice(0, Math.max(k, 10)), top: top.slice(0, 15), frames, stateFrames };
}

/**
 * 判断ごとの繰り返し（reader-8）: 判断 d の手 a と、1 つ前の判断に並ぶ同じ種類の手 b（d へ来た手は除く。それは道の上で続く手で、
 * 道の繰り返しで数える）が、同じ骨組みで言う構造でない文の数。道をたどる人が判断ごとにほかの手を開くと、この文が続けて出る。
 * 1 つ前の判断が今日なら比べない（今日の手は見取り図で並べて読む決まった 10 の手で、言い換えの種は道の最初の手ごとに決まる）。
 * 手引きの文（その種類の手で最初にやること。独立なら退職の規則を確かめる）は、いつ選んでも同じなのが正しいので比べない。
 * ただし今のままの手引きは決まった順の無い日々の歩みなので比べる（どの判断にも並び、同じ歩みを続けて出さない）
 */
function repeatsByDecision(map: MapData, marked: readonly Card[], gates: TextGates, fail: (msg: string, key: string) => void): DecisionRepeats {
  const PB = /\u0003[^\u0004]*\u0004/g;
  const { perCard, names } = skeletonIds(map, (i) => {
    const b = map.role(i) === "a" && map.kind(i) !== "keep" ? marked[i]!.body.replace(PB, "") : marked[i]!.body;
    return spaceJa(strip(b));
  });
  const hist: Record<number, number> = {};
  const seen = new Map<number, number>();
  let pairs = 0;
  let over = 0;
  for (let a = 0; a < map.n; a++) {
    if (map.role(a) !== "a") continue;
    const d = map.parent(a);
    if (map.role(d) !== "s") continue;
    const via = map.parent(d);
    const d2 = map.parent(via);
    if (map.role(d2) === "r") continue;
    let b = -1;
    for (let c = 0; c < map.childCount(d2); c++) {
      const x = map.child(d2, c);
      if (x !== via && map.kind(x) === map.kind(a)) {
        b = x;
        break;
      }
    }
    if (b < 0) continue;
    pairs++;
    const sb = new Set(perCard[b]!);
    const shared = [...new Set(perCard[a]!)].filter((s) => sb.has(s));
    hist[shared.length] = (hist[shared.length] ?? 0) + 1;
    for (const s of shared) seen.set(s, (seen.get(s) ?? 0) + 1);
    if (shared.length > gates.decisionRepeats) {
      over++;
      fail(`C6 判断ごとの繰り返し ${shared.length}（門 ${gates.decisionRepeats}）: ${shared.map((s) => `「${names[s]!.slice(0, 24)}…」`).join(" / ")}（${map.key(b)}）`, map.key(a));
    }
  }
  const top = [...seen].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([s, c]) => [names[s]!, c] as [string, number]);
  return { pairs, hist, overGate: over, top };
}

/**
 * 兄弟: 本文の骨組みが同じ組（C6）と、題が同じ組（T4）。同じ種類の手が兄弟に 2 つある組（データの重なり）と、
 * 束に無い種類どうし（どちらも「別の手」と書く）の組は比べない
 */
function siblingPass(map: MapData, fin: readonly Card[], banks: Banks, allowed: number, fail: (msg: string, role: string, key: string) => void): Siblings {
  const r: Siblings = { movePairs: 0, moveSame: 0, outPairs: 0, outSame: 0, titlePairs: 0, titleSame: 0, titleSameByRole: {}, openerSame: 0, cmpGroups: 0, cmpSame: 0 };
  const known = (i: number): boolean => !!banks.title[map.kind(i) ?? ""];
  // 別の結果と比べる文の枠: 比べ方の言い方（「同じ手で『…』だった場合より、」「（同じ手で『…』だった場合と比べて）」など。数字と『』の中は伏せる。
  // 差の中身は兄弟で違うので見ない。報告だけ。rep-4・L6）
  const cmpFrame = (body: string): string | null => {
    const x = sentencesOf(body).find((t) => /だった場合|と比べ|の場合に比べ|の場合より|の場合とも|場合と、数字/.test(t));
    if (x === undefined) return null;
    const t = mask(x).replace(/『[^』]*』/g, "『』");
    const m = /（[^）]*比べて）$/.exec(t) ?? /^[^、]*?(?:場合より|と比べると|と比べて|に比べ|この結果は)/.exec(t);
    return m ? m[0] : t;
  };
  for (let p = 0; p < map.n; p++) {
    const kc = map.childCount(p);
    if (kc < 2) continue;
    const ks: number[] = [];
    for (let c = 0; c < kc; c++) ks.push(map.child(p, c));
    const sk = ks.map((x) => mask(fin[x]!.body));
    if (kc >= 3 && map.role(ks[0]!) === "s") {
      const fr = ks.map((x) => cmpFrame(fin[x]!.body));
      if (fr.every((x) => x !== null)) {
        r.cmpGroups++;
        if (fr.every((x) => x === fr[0])) r.cmpSame++;
      }
    }
    for (let a = 0; a < ks.length; a++)
      for (let b = a + 1; b < ks.length; b++) {
        const x = ks[a]!;
        const y = ks[b]!;
        const role = map.role(x);
        if (role === "a" && (map.kind(x) === map.kind(y) || (!known(x) && !known(y)))) continue;
        const same = sk[a] === sk[b];
        if (role === "a") {
          r.movePairs++;
          if (same) r.moveSame++;
          if ([...sk[a]!].slice(0, 14).join("") === [...sk[b]!].slice(0, 14).join("")) r.openerSame++;
        } else {
          r.outPairs++;
          if (same) r.outSame++;
        }
        if (same && r.moveSame + r.outSame > allowed) fail(`C6 兄弟の本文の骨組みが同じ: ${map.key(y)}`, role, map.key(x));
        // 中身（幅と続き）が同じまとめた行き先は、同じだと言い、違い（稼ぎの合計）を先に置く（reader-5）
        if (role === "e" && map.sum(x) && map.sum(y) && sumKey(map, x) === sumKey(map, y) && !(fin[x]!.trace.includes("sum:same") && fin[y]!.trace.includes("sum:same"))) fail(`C6 中身の同じまとめた行き先が、同じだと言わない: ${map.key(y)}`, role, map.key(x));
        r.titlePairs++;
        if (fin[x]!.title === fin[y]!.title) {
          r.titleSame++;
          r.titleSameByRole[role] = (r.titleSameByRole[role] ?? 0) + 1;
          fail(`T4 兄弟の題が同じ「${fin[x]!.title}」: ${map.key(y)}`, role, map.key(x));
        }
      }
  }
  return r;
}

/** まとめた行き先の中身（幅・続き。幅が無ければ平均の状態）の鍵 */
const sumKey = (map: MapData, x: number): string => JSON.stringify([map.mix(x), map.cont(x), map.mix(x) ? null : map.st(x)]);

/** いとこ（同じ最初の手・同じ月・同じ種類の手か同じ手の同じ結果で、親が違う）を決まった抜き出しで比べる（R2 の scale.ts と同じ） */
function cousinPass(map: MapData, fin: readonly Card[]): { pairs: number; same: number; skeleton: number } {
  const groups = new Map<string, number[]>();
  const firstOf = (i: number): number => {
    let x = i;
    while (map.parent(x) > 0) x = map.parent(x);
    return x;
  };
  for (let i = 1; i < map.n; i++) {
    const sig = map.role(i) === "a" ? `a|${map.kind(i)}` : `${map.role(i)}|${map.kind(map.parent(i))}|${map.outId(i)}`;
    const g = `${firstOf(i)}|${map.month(i)}|${sig}`;
    const arr = groups.get(g);
    if (arr) arr.push(i);
    else groups.set(g, [i]);
  }
  let pairs = 0;
  let same = 0;
  let skel = 0;
  for (const arr of groups.values()) {
    if (arr.length < 2) continue;
    for (let t = 0; t < Math.min(40, arr.length * 2); t++) {
      const a = arr[hash(`${t}a${map.key(arr[0]!)}`) % arr.length]!;
      const b = arr[hash(`${t}b${map.key(arr[0]!)}`) % arr.length]!;
      if (a === b || map.parent(a) === map.parent(b)) continue;
      pairs++;
      same += Number(fin[a]!.body === fin[b]!.body);
      skel += Number(mask(fin[a]!.body) === mask(fin[b]!.body));
    }
  }
  return { pairs, same, skeleton: skel };
}

// ---- 道の見本（SPEC §4.7: 今日の手ごとに、一番ありそうな道と、決まった種で選んだ道 5 本。年収 360 と 540）

export interface GoldenCard {
  k: string;
  r: MapRole;
  m: number;
  /** まとめた手・まとめた行き先（無ければ書かない） */
  stub?: true;
  sum?: true;
  /** 結果の見込み %（手は無し） */
  p?: number;
  label?: string;
  title: string;
  numbers: string[];
  body: string;
  todo: string[];
}

export interface GoldenPath {
  /** 今日の手の種類 */
  first: string;
  /** likely: 一番ありそうな道（おすすめの手・一番ありそうな結果）/ random-N: 決まった種で選んだ道（まとめていない手から）/
   *  any-N: どの手も同じ重みで選ぶ道（まとめた手も選ぶ。読む人が一番よく行き着く、まとめた行き先と「ほか N 期」を見本に入れる。reader-1） */
  how: string;
  /** 道の見込み（結果の見込みの積、%） */
  prob: number;
  cards: GoldenCard[];
}

/** 小さな決まった乱数（mulberry32） */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 判断のおすすめの手（why=best、無ければ今のまま）・手の一番ありそうな結果は、組み立てと同じ物（src/demo/compose/path.ts） */
export { likeliest, recommended };

/**
 * 今日の手ごとの道の見本: 一番ありそうな道（判断ではおすすめの手、手では一番ありそうな結果）と、決まった種で選んだ道 random 本
 * （判断ではまとめていない手から同じ重みで選ぶ（全部まとめた手ならその中から）。道を 3 年先まで読めるように。結果は見込みの重み。
 * 同じ道が出たら引き直す・10 回で諦める）と、どの手も同じ重みで選ぶ道 any 本（まとめた手も選ぶ。別の種。reader-1: 読む人が一番よく行き着く
 * まとめた手・まとめた行き先・「ほか N 期」を、見直しの見本に入れる）
 */
export function goldenPaths(map: MapData, opts: { annual: number; banks?: Banks; random?: number; any?: number; seed?: number; first?: (key: string) => boolean; rt?: ComposeRuntime }): GoldenPath[] {
  const banks = opts.banks ?? BANKS;
  const nRandom = opts.random ?? 5;
  const nAny = opts.any ?? 3;
  // 計算の芯の答えがあれば、画面と同じ本文とおすすめの手（無ければ地図の why=best）
  const rt = opts.rt;
  const rec = (d: number): number => {
    const x = rt?.recommended?.(d) ?? -1;
    return x >= 0 ? x : recommended(map, d);
  };
  const card = (i: number): GoldenCard => {
    const c = finishCard(composeMarkedCard(map, i, { annual: opts.annual, banks, ...(rt ? { rt } : {}) }));
    const out: GoldenCard = { k: map.key(i), r: map.role(i), m: map.month(i), title: c.title, numbers: c.numbers, body: c.body, todo: c.todo.map((t) => `${t.text}（${t.cite}）`) };
    if (map.role(i) === "a" && map.stub(i)) out.stub = true;
    if (map.role(i) === "e" && map.sum(i)) out.sum = true;
    if (map.role(i) === "s" || map.role(i) === "e") {
      out.p = map.p(i);
      out.label = map.label(i);
    }
    return out;
  };
  const walk = (first: number, pickMove: (d: number) => number, pickOut: (a: number) => number): { cards: number[]; prob: number } => {
    const cards: number[] = [];
    let prob = 1;
    let a = first;
    for (;;) {
      cards.push(a);
      if (!map.childCount(a)) break;
      const o = pickOut(a);
      prob *= map.p(o) / 100;
      cards.push(o);
      if (!map.childCount(o)) break;
      a = pickMove(o);
    }
    return { cards, prob };
  };
  const out: GoldenPath[] = [];
  const r = rng(opts.seed ?? 20261119);
  const r2 = rng((opts.seed ?? 20261119) + 1);
  const byP = (rr: () => number) => (a: number): number => {
    let roll = rr() * 100;
    for (let c = 0; c < map.childCount(a); c++) {
      roll -= map.p(map.child(a, c));
      if (roll < 0) return map.child(a, c);
    }
    return map.child(a, map.childCount(a) - 1);
  };
  for (let f = 0; f < map.childCount(0); f++) {
    const first = map.child(0, f);
    if (opts.first && !opts.first(map.key(first))) continue;
    const kind = map.kind(first) ?? "";
    const seen = new Set<string>();
    const add = (how: string, w: { cards: number[]; prob: number }): void => {
      seen.add(w.cards.join(","));
      out.push({ first: kind, how, prob: Math.round(w.prob * 10000) / 100, cards: w.cards.map(card) });
    };
    add("likely", walk(first, rec, (a) => likeliest(map, a)));
    for (let t = 0; t < nRandom; t++) {
      for (let tries = 0; tries < 10; tries++) {
        const w = walk(
          first,
          (d) => {
            const all: number[] = [];
            for (let c = 0; c < map.childCount(d); c++) all.push(map.child(d, c));
            const open = all.filter((a) => !map.stub(a));
            const pool = open.length ? open : all;
            return pool[Math.floor(r() * pool.length)]!;
          },
          byP(r),
        );
        if (seen.has(w.cards.join(",")) && tries < 9) continue;
        if (!seen.has(w.cards.join(","))) add(`random-${t + 1}`, w);
        break;
      }
    }
    for (let t = 0; t < nAny; t++) {
      for (let tries = 0; tries < 10; tries++) {
        const w = walk(first, (d) => map.child(d, Math.floor(r2() * map.childCount(d))), byP(r2));
        if (seen.has(w.cards.join(",")) && tries < 9) continue;
        if (!seen.has(w.cards.join(","))) add(`any-${t + 1}`, w);
        break;
      }
    }
  }
  return out;
}

/** 道の見本を、見直しのための Markdown にする */
export function goldenMarkdown(map: MapData, paths: readonly GoldenPath[], annual: number): string {
  const L: string[] = [];
  L.push(`# 道の見本（年収 ${annual} 万円・${map.header.anchor} 時点の地図・${map.n.toLocaleString("en-US")} 枚・${map.header.hash}）`, "");
  L.push("今日の手ごとに、一番ありそうな道（判断ではおすすめの手、手では一番ありそうな結果）と、決まった種で選んだ道（判断ではまとめていない手から同じ重み、結果は見込みの重み）と、どの手も同じ重みで選ぶ道（まとめた手も選ぶ。読む人がよく行き着くまとめた行き先を見るため）。SPEC v1 §4.7", "");
  for (const p of paths) {
    const how = p.how === "likely" ? "一番ありそうな道" : p.how.startsWith("any-") ? `どの手も同じ重みの道 ${p.how.slice(4)}` : `決まった種の道 ${p.how.slice(7)}`;
    L.push(`## ${p.first} — ${how}（見込み ${p.prob}%・${p.cards.length} 枚）`, "");
    for (const c of p.cards) {
      const head = c.r === "a" ? (c.stub ? "まとめた手" : "手") : c.r === "s" ? `状態（${c.p}%「${c.label}」）` : `${c.sum ? "まとめた行き先" : "行き先"}（${c.p}%「${c.label}」）`;
      L.push(`### ${c.m} か月目・${head}: ${c.title}`, `<sub>${c.k}</sub>`, "");
      if (c.numbers.length) L.push(`> ${c.numbers.join("｜")}`, "");
      L.push(c.body, "");
      if (c.todo.length) L.push(`やること: ${c.todo.join(" / ")}`, "");
    }
  }
  return L.join("\n");
}

/** 手で作った地図の道の見本の作り方: 地図の名前 → 年収と決まった種の道の本数・使う今日の手（鍵の頭の 2 つ。無ければ全部） */
export const FIXTURE_GOLDEN: Readonly<Record<string, { runs: ReadonlyArray<readonly [number, number]>; only?: readonly string[] }>> = {
  TREE: {
    runs: [
      [360, 1],
      [540, 0],
    ],
  },
  // まとめた行き先の中身の幅と標準の続き・確定申告の年・移った会社と戻った会社（R1 の木に無い所）・まとめた結果・次の顧客の月額・節目の月・
  //   題と年収・標準の続きの残す期・中身の同じ兄弟（見直しの指摘）
  RULES: { runs: [[360, 0]], only: ["r.mix", "r.mixb", "r.avg", "r.ind", "r.quit", "r.back", "r.refile", "r.handover", "r.sonly", "r.merge", "r.fee", "r.since", "r.dec", "r.mau", "r.contback", "r.twins"] },
};

/**
 * 手で作った小さな地図の道の見本（単体テストが比べる tests/unit/composeGolden.json の中身）。TREE は年収 360 で一番ありそうな道と
 * 決まった種の道 1 本、540 で一番ありそうな道。RULES は SPEC §4.2 の決まりごとの道（360）。作り直しは node scripts/impact/runTextChecks.mjs --fixture-golden
 */
export function fixtureGolden(trees: Readonly<Record<string, DevTree>>): string {
  const paths: Record<string, Record<string, GoldenPath[]>> = {};
  for (const [name, tree] of Object.entries(trees)) {
    const map = fromDevTree(tree);
    const how = FIXTURE_GOLDEN[name];
    if (!how) continue;
    const only = how.only ? new Set(how.only) : null;
    const per: Record<string, GoldenPath[]> = {};
    for (const [annual, random] of how.runs) per[String(annual)] = goldenPaths(map, { annual, random, first: only ? (k) => only.has(k.split(".").slice(0, 2).join(".")) : undefined });
    paths[name] = per;
  }
  return JSON.stringify({ textVersion: BANKS.version, paths }, null, 1);
}

// ---- まとめ（Markdown）

const f = (x: number): string => x.toLocaleString("en-US");
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const dl = (d: Dist): string => `最小 ${f(d.min)}・中央 ${f(d.median)}・p90 ${f(d.p90)}・最大 ${f(d.max)}（平均 ${d.mean}・${f(d.n)} 枚）`;

export function reportMarkdown(rep: TextCheckReport): string {
  const L: string[] = [];
  L.push(`# 文章の点検（${rep.tree.hash}・${f(rep.tree.nodes)} 枚・${rep.tree.anchor} 時点）: ${rep.ok ? "通る" : "止める"}`, "");
  L.push(`門: 道 1 本の構造でない文の繰り返し ${rep.gates.pathRepeats} まで（道の画面と同じまとめ方）・兄弟で骨組みが同じ組 ${rep.gates.siblingSame} まで・続く判断の同じ種類の手が同じ文 ${rep.gates.decisionRepeats} まで`, "");
  if (rep.bank.length) {
    L.push("## 束", "");
    for (const c of rep.bank) L.push(`- ${c.id} ${f(c.n)} 件: ${c.examples.join(" / ")}`);
    L.push("");
  }
  for (const r of rep.runs) {
    L.push(`## 年収 ${r.annual}`, "");
    L.push(`- 組み立て ${f(r.ms.compose)} ms（1 枚 ${r.ms.perCardUs} µs）・1 枚の点検 ${f(r.ms.cardChecks)} ms・道 ${f(r.ms.paths)} ms・兄弟 ${f(r.ms.siblings)} ms`);
    L.push(`- まとめた行き先の後の標準の続きの期 ${f(r.contRows)} 行も、1 枚ごとの点検・道で 1 回だけの文（C9）・道の繰り返し（C6）に入れた`);
    L.push("- 点検:");
    if (!r.checks.length) L.push("  - なし");
    for (const c of r.checks) {
      L.push(`  - ${c.id}${c.block ? "" : "（警告）"} ${f(c.n)} 件（${Object.entries(c.by)
        .map(([k, v]) => `${k} ${f(v)}`)
        .join("・")}）`);
      for (const e of c.examples) L.push(`    - ${e}`);
    }
    L.push("- 本文の字数:");
    for (const [k, d] of Object.entries(r.lengths)) L.push(`  - ${k}: ${dl(d)}`);
    L.push("- 題の字数:");
    for (const [k, d] of Object.entries(r.titleLengths)) L.push(`  - ${k}: ${dl(d)}`);
    const pr = r.pathRepeats;
    L.push(`- 道の繰り返し（構造でない文。全部の道 ${f(pr.paths)} 本）`);
    L.push(`  - 門にかける数（同じ手が続く期を 1 つにまとめる）: ${dl(pr.dist).replace(/ 枚）/, " 本）")}・門を超える道 ${f(pr.overGate)}`);
    L.push(`    - 数ごとの道: ${Object.entries(pr.hist)
      .map(([x, c]) => `${x}: ${f(c)}`)
      .join("・")}`);
    L.push(`  - まとめない数: ${dl(pr.raw).replace(/ 枚）/, " 本）")}`);
    L.push(`    - 数ごとの道: ${Object.entries(pr.histRaw)
      .map(([x, c]) => `${x}: ${f(c)}`)
      .join("・")}`);
    L.push(`  - よく繰り返す文（道の数）: ${pr.top
      .slice(0, 10)
      .map(([x, c]) => `「${x.slice(0, 32)}…」${f(c)}`)
      .join(" / ")}`);
    L.push(`  - 1 つの枠を一番多く使う数（構造の文も入れ、行ごとに 1 回。目安 ${FRAME_SOFT} まで・止めない）: ${dl(pr.frames.dist).replace(/ 枚）/, " 本）")}・目安を超える道 ${f(pr.frames.over)}`);
    L.push(`    - 数ごとの道: ${Object.entries(pr.frames.hist)
      .map(([x, c]) => `${x}: ${f(c)}`)
      .join("・")}`);
    L.push(`    - 一番多く使う枠（道の数）: ${pr.frames.top.map(([x, c]) => `「${x.slice(0, 28)}…」${f(c)}`).join(" / ")}`);
    L.push(`  - 同じ数え方で状態の本文の文だけ（0.8・W2 の状態の数の枠。目安 ${FRAME_SOFT} まで・止めない）: ${dl(pr.stateFrames.dist).replace(/ 枚）/, " 本）")}・目安を超える道 ${f(pr.stateFrames.over)}`);
    L.push(`    - 数ごとの道: ${Object.entries(pr.stateFrames.hist)
      .map(([x, c]) => `${x}: ${f(c)}`)
      .join("・")}`);
    L.push(`    - 一番多く使う枠（道の数）: ${pr.stateFrames.top.map(([x, c]) => `「${x.slice(0, 28)}…」${f(c)}`).join(" / ")}`);
    const dr = r.decisionRepeats;
    L.push(`- 判断ごとの繰り返し（続く 2 つの判断の同じ種類の手が同じ骨組みで言う文。${f(dr.pairs)} 組）: 門を超える組 ${f(dr.overGate)}`);
    L.push(`  - 同じ文の数ごとの組: ${Object.entries(dr.hist)
      .map(([x, c]) => `${x}: ${f(c)}`)
      .join("・")}`);
    L.push(`  - よく重なる文（組の数）: ${dr.top
      .slice(0, 8)
      .map(([x, c]) => `「${x.slice(0, 32)}…」${f(c)}`)
      .join(" / ")}`);
    const s = r.siblings;
    L.push(`- 兄弟: 手 ${f(s.movePairs)} 組で骨組みが同じ ${f(s.moveSame)}・結果 ${f(s.outPairs)} 組で ${f(s.outSame)}・題が同じ ${f(s.titleSame)} 組（${f(s.titlePairs)} 組のうち）`);
    L.push(`  - 参考（止めない）: 手の書き出し（最初の 14 字）が同じ組 ${f(s.openerSame)}（${pct(s.openerSame / Math.max(1, s.movePairs))}）・結果が 3 つ以上でどれも別の結果と比べる組 ${f(s.cmpGroups)} のうち、比べる文の枠がどれも同じ組 ${f(s.cmpSame)}`);
    L.push(`- 状態の本文が次の判断のおすすめの手（選べる手が無ければその訳）を言う: ${f(r.stateRec.named)} / ${f(r.stateRec.states)}（${pct(r.stateRec.named / Math.max(1, r.stateRec.states))}。言わない物は C13）`);
    L.push(`- いとこ（参考）: ${f(r.cousins.pairs)} 組で文が同じ ${pct(r.cousins.same / Math.max(1, r.cousins.pairs))}・骨組みが同じ ${pct(r.cousins.skeleton / Math.max(1, r.cousins.pairs))}。本文が完全に同じカード ${pct(r.identical)}・状態の本文がほかのカードと同じ ${f(r.identicalState.same)} / ${f(r.identicalState.states)}（${pct(r.identicalState.same / Math.max(1, r.identicalState.states))}）`);
    L.push("");
  }
  return L.join("\n");
}

// ---- CLI（scripts/impact/runTextChecks.mjs が木を読んで渡す。ファイルは返した物を書く）

export interface CliResult {
  code: number;
  text: string;
  files: Record<string, string>;
}

export function cli(tree: DevTree, args: readonly string[]): CliResult {
  const arg = (name: string): string | undefined => {
    const k = args.indexOf(name);
    return k >= 0 ? args[k + 1] : undefined;
  };
  const annuals = (arg("--annual") ?? "360,540").split(",").map(Number);
  if (annuals.some((x) => !Number.isFinite(x) || x <= 0)) return { code: 2, text: `年収が読めません: ${arg("--annual")}`, files: {} };
  const examples = Number(arg("--examples") ?? 5);
  const map = fromDevTree(tree);
  const rep = runTextChecks(map, { annuals, examples });
  const md = reportMarkdown(rep);
  const files: Record<string, string> = {};
  const out = arg("--out");
  if (out) files[out] = md;
  const json = arg("--json");
  if (json) files[json] = JSON.stringify(rep, null, 1);
  const golden = arg("--golden");
  if (golden) for (const annual of annuals) files[`${golden}/golden-${annual}.md`] = goldenMarkdown(map, goldenPaths(map, { annual, rt: runtimeOf(map, annual) }), annual);
  return { code: rep.ok ? 0 : 1, text: md, files };
}
