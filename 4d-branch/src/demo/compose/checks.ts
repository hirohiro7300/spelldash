// 組み立てた文の点検（差し込みの印つきの形 composeMarkedCard で見る）。設計: 作業メモ SPEC v1 §4.6。元: 試作（R2）の checks.ts
// 生成の点検（scripts/impact/textChecks.ts）とテストが使う。アプリは使わない
// 1 枚ごと: C1 数はどれもデータから（差し込みの印の外に数字が無い）・C1b 手引きの文の数字は引いた項目にある・C2 状態（まとめた行き先は中身の幅）と食い違わない・
//   C3 長さ・C4 地図の文の決まり（% と差・敬語・位置・気持ち・埋まっていない差し込み）・C4b 英数字の名前を書かない・C5 結果の名前と顧客の数（本当の状態）・
//   C5b 顧客と席は整数・C7 モデルに無い月額（人が見る）・C10 数の言い方（給与は月にならして・有料は手数料とサーバー代を引いて・月に遊んだ人・
//   3 か月は 3 つの月・数の行の数を今日・状態・行き先の本文に書かない）・D1 / D2 文では直せないデータ（計算の側へ返す。まとめた行き先は除く）
//   C11 手が結果について言う額と数（売上・席・年収・倍率・次の顧客の月額・昇格の額）が、その結果の状態と合う（reader-4）。まとめた手と行き先が言う
//   出来事の月（会社員に戻る月など）が、標準の続きの出来事の月と合う（fact-1）・C2 には前提の言い過ぎ（fact-2〜11・fact-23）も入る・
//   C12 道の歩みと合う（前の手・転職活動の期・顧客の有無・会社員だった期間。reader-6。前の会社で選んだ手の続きと言わない・何も変えなかった結果を
//   月の稼ぎを一番動かした物と言わない。F4・F5）
// 道ごと: C9 道で 1 回だけの文（暦・静かな期の一言・出来事の助言・避けたい訳）が、今日から行き先までの道で 2 回出ない
import type { MapData } from "../../deepmap/mapData";
import type { WishData } from "../wishlist";
import { calendarOf, clBand, eventMonth, mergedFact, newFeeOf, quarterSal, type Calendar } from "./path";
import { clr, f2, man, ME, MS, n0, PE, PS, spaceJa, strip } from "./text";
import type { Banks, Card, Consts } from "./types";

/**
 * 文の型が差し込みなしで書いてよい数字（決まった言い方・暦の月・1 つ 2 つの数え方）。0.7: どの数でも通していた形（N か月・N 日・N 円・N 人・
 * N 回 など）を、文の型が実際に使う数だけにした（前提に無い数「6 か月分」などが通らない。前提の数は差し込みで入れる。fact-12）。
 * Pro の月額 980 円（spell-revenue-d02）・週 10 時間・週 4 日と週 5 日・1 校・4 月（昇給と評価）と 6 月（住民税の通知）・3 か月（1 期）・
 * 届け出の答えの「1 か月ほど」・1 年と 3 年（毎年 4 月・地図の 3 年）・1 社目と 2 社目
 */
export const ALLOWED_NUM: readonly RegExp[] = [/980 円/g, /週 10 時間/g, /週 [45] 日/g, /1 校/g, /[46] ?月/g, /3 ?か月/g, /1 ?か月ほど/g, /[13] ?年/g, /[12] ?社目/g, /1 ?回/g, /[12] ?つ/g, /1 ?件/g, /1 ?本/g, /1 ?期/g, /1 ?日/g, /1 ?人/g, /もう 1 社/g, /1 社 月/g, /1 社あたり/g, /1on1/g, /A4/g, /GA4/g, /D1|D7|D30/g];

/**
 * 役割ごとの長さ（題の字数・本文の字数の下と上）。今日の手は先に読むので本文を長くしてよい。
 * 0.2: 数を数の行に移し（SPEC §4.2）、助言を道で 1 回にしたので、静かな期の本文は短い（数の行が上にある）。
 * 0.4: どの手にも 3 年の見積もりとおすすめとの差（reader-1・reader-2）、広げた手には先の分かれ道の数、まとめた手には結果ごとの 3 年の稼ぎを足した。
 *   上は新しい前提の木（71,619 枚・年収 360 と 540）で測り直した（truth-14）: 手の最大 646（結果が 3 つのまとめた独立の手）、
 *   行き先の最大 490、状態の最大 346、今日の手の最大 458。下は前の測り方のまま。
 *   今日の手の上は、生成 v2 の木（事実の小さい組を段 3 まで分ける。SPEC v1 §2.2・§2.8）で測り直した: 届け出て副業の結果が
 *   『全部可・1 社目』『全部可・まだ』『SpellDash だけ』『どちらも不可』の 4 つになり、その本文が年収 360 で 522 字（ほかの手は 459 まで）。
 *   520 → 560（W-gen が生成の点検につないだ時に直した。W-text が確かめる）。
 *   560 → 660: 今日の手の本文に、見積もり方の名前・一番良い選び方の平均・地図にある行き先と一番良い選び方で着く行き先を足した
 *   （truth-4・reader-4。画面と同じ数。届け出て副業の本文は年収 360 で 604 字ほど）
 *   660 → 700（0.7・W1 で測り直した）: 届け出の結果の意味を、結果ごとの 1 文でその月と額まで言うようにした（rep-7）。届け出て副業の本文は
 *   年収 360 で 652 字・540 で 650 字（前は 621）。手の上と同じにして、W2 が今日の手に足す分の余白を残す
 *   0.9（R6）: 行き先に今日からの 3 年の稼ぎとずっと今のままとの差の 1 文を足した。行き先の上 560 → 620（年収 360 で 583 字・540 で 587 字。
 *   中身の同じ兄弟を言うまとめた行き先）。状態の上 480 → 500（R1: おすすめでない手を選んだ道は、その手の見込みの数を言う。長さの目安 460 で
 *   落とせる文を落とした後の最大が、計算の芯つきで 477 字（年収 240〜1200）・計算の芯なしの組み立てで 493 字）。今日の手は 0.9 で測り直して
 *   660（360）・662（540）なので 700 のまま
 *   1.1（W4・con-6・con-13）: 行き先に今日の手とその答え・3 年の稼ぎの内訳・月の稼ぎの動き・一番分けた判断・3 年の後の伸びしろ（額つき）を足した。
 *   本当の行き先は組み立ての目安 END_BUDGET 640 で落とせる文を落とした後の最大が年収 360 で 644 字、行き先全体の最大は中身の同じ兄弟を言う
 *   まとめた行き先（独立した道を含む物は内訳に経費を引いた額と言う）で年収 360 で 708 字・540 で 711 字。行き先の上 620 → 740
 *   1.2（W5・con-8）: 手の本文は、やること 3 つをその 3 か月の月に置いた段取りで言う（前は 1〜2 つ）。長さの目安 MOVE_BUDGET 680 で落とせる文を
 *   落とし、段取りの 2 つ目・3 つ目をやることの言葉に縮めた後の最大が、年収 360 で 701 字・540 で 701 字（結果が 3 つの独立の手）。手の上 700 → 740
 */
export const LIMITS = { a: { title: 16, min: 60, max: 740 }, s: { title: 22, min: 30, max: 500 }, e: { title: 24, min: 80, max: 740 }, r: { title: 40, min: 0, max: 600 } } as const;
/**
 * 今日の手の本文の上。1.0（W3・con-3・con-5）: 今日の手の結果の名前に見込みを添え、結果ごとの次の判断のおすすめと、選べなくなる手を足した。
 * 届け出て副業の手（結果が 4 つ）が年収 360 で 771 字（組み立ての目安 FIRST_MOVE_BUDGET 760 で選べなくなる手の文を落とす前）。700 → 800。
 * 1.1（W4・con-11）: 結果ごとの分かれ道を結果の名前と見込みで言い、今日の手の先がどれもほぼ同じ数の分かれ道まで開いてあることと、本当の行き先が
 * 着いた所（仕事・移った会社・Pro・顧客）を足した。組み立ての目安 FIRST_MOVE_BUDGET 900 で、届け出て副業の手が年収 360 で 924 字・540 で 922 字
 * （選べなくなる手の文を落とした後。ほかの手は 812 まで）。800 → 960。
 * 1.2（W5・con-8）: やること 3 つを月に置いた段取りにした。届け出て副業の手が年収 360 で 994 字（選べなくなる手を落とし、段取りの 2 つ目・3 つ目を
 * やることの言葉に縮めた後）。960 → 1,040
 */
export const FIRST_MOVE_MAX = 1040;
/**
 * 0.9: 道の最初の状態（今日の手の結果）の本文の上。3 年の見込みの見積もり方とずっと今のままの 3 年を道でここだけが言う（組み立ての
 * FIRST_STATE_BUDGET 600 の後に、落とせない文の分の余白）
 */
export const FIRST_STATE_MAX = 650;
export const TODO_MAX = 24;

const SLOT_SPAN = new RegExp(`${MS}[^${ME}]*${ME}`, "g");
const PB_SPAN = new RegExp(`${PS}([^${PE}]*)${PE}`, "g");

/** 差し込みの印と手引きの文の外にある数字（許した言い方は除く） */
export function digitsOutside(text: string, allowed: readonly RegExp[] = ALLOWED_NUM): string[] {
  let rest = text.replace(SLOT_SPAN, "").replace(PB_SPAN, "");
  for (const re of allowed) rest = rest.replace(re, "");
  return rest.match(/[0-9０-９]+/g) ?? [];
}

/** 手引きから入れた文（印の中身） */
export function playbookSpans(text: string): string[] {
  return [...text.matchAll(PB_SPAN)].map((m) => m[1] ?? "");
}

/** text の数字のうち、src に無い物 */
export function digitsNotIn(text: string, src: string): string[] {
  return (text.match(/\d[\d,.]*/g) ?? []).filter((d) => !src.includes(d));
}

/** やりたいことリストの項目の文（題・本文・達成の目安） */
export interface WishText {
  title: string;
  body: string;
  done: string;
}

export function wishIndex(d: WishData): Map<string, WishText> {
  const out = new Map<string, WishText>();
  for (const a of d.areas) for (const t of a.themes) for (const it of t.items) out.set(it[0], { title: it[2], body: it[3], done: (it[7] ?? []).join(" ") });
  return out;
}

const wishSrc = (w: WishText): string => `${w.title} ${w.body} ${w.done}`;

/** 束の全部の手引きの点検: 引いた項目がある・文と題とやることの数字が引いた項目にある（C1b）・やることの長さ（C3） */
export function checkBanks(banks: Banks, wish: ReadonlyMap<string, WishText>): string[] {
  const out: string[] = [];
  for (const [kind, steps] of Object.entries(banks.playbook)) {
    for (const st of steps) {
      const w = wish.get(st.id);
      if (!w) {
        out.push(`C1b 引用先が無い: ${kind} ${st.id}`);
        continue;
      }
      for (const part of [st.act, st.todo, st.title ?? ""]) for (const d of digitsNotIn(part, wishSrc(w))) out.push(`C1b 引用元に無い数字 ${d}: ${kind} ${st.id}「${part}」`);
      if ([...st.todo].length > TODO_MAX) out.push(`C3 やることが長い（${[...st.todo].length}）: ${kind} ${st.id}「${st.todo}」`);
    }
  }
  return out;
}

/** 英数字の名前（『high_mid』・手の種類・結果の番号・出来事の名前）。地図の文に出してはいけない（C4b・user-2） */
const ASCII_IDS: readonly RegExp[] = [/[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+/g, /(?<![A-Za-z0-9])(?:cl|pu|mau|u)\d+(?![A-Za-z0-9])/g, /『[\x00-\x7F]+』/g, /(?<![A-Za-z])(?:keep|part)(?![A-Za-z])/g];

export function asciiIds(text: string): string[] {
  return ASCII_IDS.flatMap((re) => text.match(re) ?? []);
}

/**
 * 数の言い方の点検（C10・truth-15）。見つかった物の説明を返す
 * - 給与の月額は「月にならして」か「賞与込み」を付ける（月の手取りと読み違える）
 * - 有料会員の稼ぎは「手数料とサーバー代を引いて」と書く
 * - 遊ぶ人は「月に遊んだ人 N 人」（見込みは「月に遊ぶ人」）、3 か月の差は「3 か月前より」
 * - 3 か月の期間は 3 つの月（「12 月〜2 月」。4 つの月を書かない）
 */
export function numberWording(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/給与[^。、]{0,16}?月 ?[0-9.,]+ ?万円/g)) if (!/にならして|賞与込み/.test(m[0])) out.push(`給与の月額に「月にならして」が無い「${m[0]}」`);
  for (const m of text.matchAll(/有料(?:会員)?(?:は)? ?(?:平均 )?[0-9,]+ ?人(?:か [0-9,]+ ?人)?(?:ほど)?（([^）]*)）/g)) if (/円/.test(m[1] ?? "") && !/^(?:うち学校の席 [0-9,]+・)?手数料とサーバー代を引いて/.test(m[1] ?? "")) out.push(`有料会員の稼ぎに「手数料とサーバー代を引いて」が無い「${m[0]}」`);
  for (const m of text.matchAll(/遊ぶ人(?:は)? ?月 ?[0-9,]+ ?人/g)) out.push(`遊ぶ人の数の言い方「${m[0]}」`);
  for (const m of text.matchAll(/遊んだ人 [0-9,]+ 人（[+−-]/g)) out.push(`3 か月の差に「3 か月前より」が無い「${m[0]}」`);
  for (const m of text.matchAll(/(\d{1,2}) ?月〜(?:\d{4} ?年 ?)?(\d{1,2}) ?月(?! ?\d+ ?日)/g)) {
    const span = ((Number(m[2]) - Number(m[1]) + 12) % 12) + 1;
    if (span !== 3) out.push(`3 か月の期間が ${span} つの月「${m[0]}」`);
  }
  return out;
}

/**
 * 0.9（R7）: 割の後でない「N 分」（見込みや割合を「8 分」とだけ書くと、8 分間とも八分（8 割）とも読める）。手引きの文（「日曜 60 分」などの時間）は
 * 見ないので、手引きの印を落とした文で見る
 */
export function bareBuIssues(text: string): string[] {
  return [...text.matchAll(/(?<!割 ?)(?<![0-9,.])[0-9]+ ?分(?!の)/g)].map((m) => `割の後でない「${m[0]}」（見込みや割合は 1 割弱・1 割未満・N 人に 1 人で言う）`);
}

/** 数の行の数を、今日・状態・行き先の本文に書いていないか（SPEC §4.2・user-9b） */
const ROW_IN_PROSE: readonly RegExp[] = [/年収 (?:平均 )?[0-9,]+ ?万円/, /月にならして [0-9.]+ ?万円/, /月に遊んだ人 (?:平均 )?[0-9,]+ ?人/, /有料 (?:平均 )?[0-9,]+ 人(?:か [0-9,]+ 人)?（/, /週 [0-9]+ 時間/, /広告運用 (?:平均 )?[0-9〜]+ ?社（売上/];

/**
 * この地図の前提を、事実や会社の決まりとして言い過ぎる言い方（C2・fact-2・3・6・7・8・9・11・fact-23）。前提は「この地図では…とみる」で言い、
 * 決まらなかった訳は作らず、会社の断った訳は言わない
 */
export const OVERCLAIMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/半月分が減る/, "賞与の取り逃しを、給与が減ると言い切る"],
  [/そのまま続けられる|届け出をし直さずに/, "移った会社・戻った会社では届け出が要らないと言う"],
  [/競業として認められず/, "会社の断った訳を言う"],
  [/高くなりやすい/, "住民税が高くなると言う"],
  [/書類で落ちる先が多く|面接まで進んだ先はあったが|面接は受けたが/, "決まらなかった訳を作る"],
  [/聞けない|聞き直せない/, "聞き直さないこの地図の決まりを、会社の決まりとして言う"],
  [/[0-9] 月で止まる/, "給与が止まる月を、その月まで払われるように言う"],
];

/** 本文の、前提の言い過ぎ（OVERCLAIMS）と、独立が 2027 年 1 月より後に始まった道で「（独立して）3 年がたった」と言うこと（C2・fact-23） */
export function overclaimIssues(map: MapData, i: number, text: string): string[] {
  const out: string[] = [];
  for (const [re, why] of OVERCLAIMS) {
    const m = re.exec(text);
    if (m) out.push(`前提を言い過ぎる（${why}）「${m[0]}」`);
  }
  if (map.role(i) === "e" && /独立[^。]*3 年がたった/.test(text)) {
    const from = indStartOf(map, i);
    if (from === null || from > 2) out.push(`独立して 3 年に満たない道（独立は ${from ?? "無し"} か月目から）で「3 年がたった」と言う`);
  }
  return out;
}

/** カード i までの道で、今続いている独立が始まった月（独立していなければ null）。独立する手の出来事の月（その 3 か月の 2 か月目） */
function indStartOf(map: MapData, i: number): number | null {
  let x = map.role(i) === "a" ? map.parent(i) : i;
  if (map.st(x).j !== "i") return null;
  for (;;) {
    const mv = map.parent(x);
    if (mv < 0) return null;
    const up = map.parent(mv);
    if (up < 0 || map.st(up).j !== "i") return eventMonth(calOf(map), map.kind(mv) ?? "ind_quit", map.month(mv));
    x = up;
  }
}

/** まとめた手・まとめた行き先が月を言う出来事の言い方: 会社員に戻る・独立・週 4 日・移る・昇格（C11・fact-1） */
const EVENT_MONTH_PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  // まとめた手の「標準の続きでは 2027 年 8 月に会社員に戻り」（行き先の節目「2027 年 5 月に会社員に戻る」は道の出来事なので見ない）
  [/(?:(\d{4}) 年 )?(\d{1,2}) 月に会社員に戻り/g, "BACK_EMP"],
  [/（(?:(\d{4}) 年 )?(\d{1,2}) 月に戻る）/g, "BACK_EMP"],
  [/独立（(?:(\d{4}) 年 )?(\d{1,2}) 月から）/g, "IND_START"],
  [/（(?:(\d{4}) 年 )?(\d{1,2}) 月から週 4 日）/g, "PART_ON"],
  [/（(?:(\d{4}) 年 )?(\d{1,2}) 月に移る）/g, "SWITCH"],
  [/（(?:(\d{4}) 年 )?(\d{1,2}) 月に昇格）/g, "PROMO"],
];

/**
 * まとめた手（stub）とまとめた行き先が、標準の続きの出来事について言う月が、モデルの出来事の月（その期の手の月 + その手の出来事の月。
 * path.ts の eventMonth: 会社員に戻るは +3）と同じか（C11・fact-1: 会社員に戻る月を、その期の手の月で言っていた）。
 * 年の無い月は、その前に書いた年（この後の目安の「2027 年 5 月 会社員に戻る仕事探し（8 月に戻る）」）。text は仕上げた本文
 */
export function eventMonthIssues(map: MapData, i: number, text: string): string[] {
  const role = map.role(i);
  const ends: number[] = [];
  if (role === "e" && map.sum(i)) ends.push(i);
  else if (role === "a" && map.stub(i)) for (let k = 0; k < map.childCount(i); k++) if (map.sum(map.child(i, k))) ends.push(map.child(i, k));
  if (!ends.length) return [];
  const cal = calOf(map);
  /** 結果ごとの出来事の月（0.9・code-6: 文が名前を言う結果の月で見る。どの結果かの月でも通すと、別の結果の月を言っても見逃す） */
  const monthsOf = (os: readonly number[]): Map<string, Set<number>> => {
    const ok = new Map<string, Set<number>>();
    for (const o of os)
      for (const st of map.cont(o) ?? []) {
        if (!st.ev) continue;
        const code = st.ev.startsWith("SWITCH_") ? "SWITCH" : st.ev;
        let set = ok.get(code);
        if (!set) ok.set(code, (set = new Set()));
        set.add(eventMonth(cal, st.kind, st.m));
      }
    return ok;
  };
  const all = monthsOf(ends);
  const byLabel = new Map<string, number>();
  for (const o of ends) {
    const lab = shownLabel(map, o);
    if (lab) byLabel.set(lab, o);
  }
  /** k 文字目の言い方が入る文（句点の後から）が名前を言う結果の月。名前が無ければ、どの結果の月でもよい */
  const okAt = (k: number): Map<string, Set<number>> => {
    const from = text.lastIndexOf("。", k) + 1;
    const os = [...text.slice(from, k).matchAll(/『([^』]*)』/g)].map((m) => byLabel.get(m[1]!)).filter((o): o is number => o !== undefined);
    return os.length ? monthsOf(os) : all;
  };
  const years = [...text.matchAll(/(\d{4}) 年/g)].map((m) => [m.index ?? 0, Number(m[1])] as const);
  const yearAt = (k: number): number | null => {
    let y: number | null = null;
    for (const [at, v] of years) if (at < k) y = v;
    return y;
  };
  const out: string[] = [];
  for (const [re, code] of EVENT_MONTH_PHRASES)
    for (const m of text.matchAll(re)) {
      const y = m[1] ? Number(m[1]) : yearAt(m.index ?? 0);
      if (y === null) continue;
      const at = cal.monthOf(y, Number(m[2]));
      const want = okAt(m.index ?? 0).get(code);
      if (!want?.has(at)) out.push(`まとめた見積もりの出来事の月「${m[0]}」が、標準の続きの出来事の月（${want ? [...want].map((x) => cal.parts(x).join("-")).join("・") : "無し"}）と違う`);
    }
  return out;
}

/** 顧客が確かに 1 社のときだけ言える「2 社目が決まれば（埋まれば）」（C2。F2） */
export const TWO_IF = /2 社目が(?:埋ま|決ま)れば/;
/** 顧客が確かに 2 社以上のときだけ言える「2 社目が長続きするか（契約が長く続くか）」（C2。F2） */
export const TWO_LASTS = /2 社目(?:の契約)?が(?:長続き|長く続く)/;

/**
 * 1 枚の点検。t は印つきの形（composeMarkedCard）。見つかった物を「点検の名前 説明」で返す。
 * annual を渡すと、年収で決まる額（年収・昇格の額）も結果の状態と比べる（C11）
 */
export function checkCard(map: MapData, i: number, t: Card, banks: Banks, wish: ReadonlyMap<string, WishText>, annual?: number): string[] {
  const out: string[] = [];
  const role = map.role(i);
  const sum = role === "e" && map.sum(i);
  const mix = sum ? map.mix(i) : null;
  // C1b: やることと手引きの文の数字は、そのカードが引いた項目にある
  const src = t.todo
    .map((td) => wish.get(td.cite))
    .filter((w): w is WishText => !!w)
    .map(wishSrc)
    .join(" ");
  for (const td of t.todo) {
    const w = wish.get(td.cite);
    if (!w) {
      out.push(`C1b 引用先が無い: ${td.cite}`);
      continue;
    }
    for (const d of digitsNotIn(td.text, wishSrc(w))) out.push(`C1b 引用元に無い数字 ${d}: ${td.cite}「${td.text}」`);
  }
  for (const span of [...playbookSpans(t.body), ...playbookSpans(t.title)]) for (const d of digitsNotIn(span, src)) out.push(`C1b 引用元に無い数字 ${d}「${span}」`);
  // C1: ほかの数字はどれも差し込み（データ）か、許した言い方
  const stray = digitsOutside(t.body);
  if (stray.length) out.push(`C1 データに無い数字: ${stray.join(",")}`);
  const strayT = digitsOutside(t.title);
  if (strayT.length) out.push(`C1 題にデータに無い数字: ${strayT.join(",")}`);
  const strayN = t.numbers.flatMap((x) => digitsOutside(x));
  if (strayN.length) out.push(`C1 数の行にデータに無い数字: ${strayN.join(",")}`);
  const plain = spaceJa(strip(t.body));
  const title = spaceJa(strip(t.title));
  const nums = t.numbers.map((x) => spaceJa(strip(x)));
  const all = [plain, title, spaceJa(strip(t.short)), ...nums].join("\n");
  // C4: 地図の文で使わない言葉
  if (/[%％Δ]/.test(all)) out.push("C4 % や差を書いている");
  if (/(です|ます)[。、」]?/.test(all)) out.push("C4 敬語");
  if (/(上|下|右|左)の(カード|選択肢|結果|手)/.test(all)) out.push("C4 位置の言葉");
  if (/気持ち/.test(all)) out.push("C4 気持ちの言葉");
  if (/\{\w+\}/.test(all) || /undefined|NaN|null|Infinity/.test(all)) out.push("C3 埋まっていない差し込み");
  if (/[\u0001-\u0004]/.test(all)) out.push("C3 印が残っている");
  // C4b: 英数字の名前（『high_mid』・手の種類・結果の番号）を書かない
  const ascii = asciiIds(all);
  if (ascii.length) out.push(`C4b 英数字の名前: ${ascii.join(",")}`);
  // C10: 数の言い方
  for (const x of numberWording(all)) out.push(`C10 ${x}`);
  for (const x of bareBuIssues([spaceJa(strip(t.body.replace(PB_SPAN, ""))), title, spaceJa(strip(t.short)), ...nums].join("\n"))) out.push(`C10 ${x}`);
  if (role !== "a") for (const re of ROW_IN_PROSE) if (re.test(plain)) out.push(`C10 数の行の数を本文に書いている（${re.source}）`);
  // C2: この地図の前提を、事実や会社の決まりとして言い過ぎない（fact-2〜11・fact-23）
  for (const x of overclaimIssues(map, i, plain)) out.push(`C2 ${x}`);
  // C11: まとめた手と行き先が言う出来事の月（会社員に戻る月など）は、標準の続きの出来事の月（fact-1）
  for (const x of eventMonthIssues(map, i, plain)) out.push(`C11 ${x}`);
  // C5b: 顧客と学校の席は整数（ならした値の端数を書かない。truth-5・truth-9）。本文と題の「N 席」は 1 校の席の倍数（3 年後の平均の席を言わない。facts-3）
  if (/[0-9]+\.[0-9]+ ?(?:社|席)/.test(all)) out.push("C5b 顧客か席に端数");
  for (const m of `${plain}\n${title}`.matchAll(/([0-9][0-9,]*) ?席/g)) if (Number(m[1]!.replace(/,/g, "")) % banks.C.schoolSeats !== 0) out.push(`C5b 学校の席が 1 校の席の倍数でない「${m[0]}」`);
  if (role === "a") for (const x of moveClaims(map, i, plain, banks.C, annual)) out.push(`C11 ${x}`);
  for (const x of pathContext(map, i, plain, t)) out.push(`C12 ${x}`);
  // C2: 手が言う「N 社目」は、その判断の顧客が確かに N − 1 社のときだけ（社数の違う場合をまとめた幅では社数を決めて言わない。truth-3）。
  //   『』の中（結果や手の名前）は数えない
  if (role === "a") for (const x of ordinalIssues(map, map.parent(i), `${plain}。${title}`)) out.push(`C2 ${x}`);
  // C12: 状態の助言が勧める手は、その状態の次の判断に並ぶ（応募を続ける助言は、転職活動の続きが並ぶときだけ。reader-3）
  if (role === "s") for (const x of adviceKindIssues(map, i, plain)) out.push(`C12 ${x}`);
  // C2（0.9）: 状態と次の判断の並びが支えない言い方（F3）・前の期の顧客探しの見込み（code-1）・無償の広告運用の手伝いの一言（F5）
  for (const x of claimIssues(map, i, plain)) out.push(`C2 ${x}`);
  // C2: 状態と食い違わない（結果・行き先だけ。同じ手の別の結果を言う文は除く）。まとめた行き先は中身の幅と比べる（truth-5）
  if (role === "s" || role === "e") {
    const s = map.st(i);
    // 同じ手の別の結果と比べる文は、その別の結果のことを言うので除く
    const own = plain
      .split("。")
      .filter((x) => !/^同じ手で|だった場合|^別の結果の|『[^』]*』[^。]*(?:場合|比べ)|^数字は、同じ手で/.test(x))
      .join("。");
    if (mix) {
      const ban: Array<[boolean, RegExp, string]> = [
        [mix.j.e < 0.9, /仕事は会社員。/, "9 割に満たないのに会社員と言い切る"],
        [mix.j.i < 0.9, /仕事は独立。/, "9 割に満たないのに独立と言い切る"],
        [Math.max(mix.pm["?"], mix.pm.a, mix.pm.s, mix.pm.n) < 0.9, /届け出の答えは『|届け出はしていない/, "9 割に満たないのに届け出の答えを言い切る"],
        [mix.pro < 0.9, /Pro を出している。/, "9 割に満たないのに Pro ありと言い切る"],
        [mix.pro > 0.1, /Pro はまだ出していない/, "Pro のある道があるのにまだと言う"],
        [mix.switched < 0.9, /転職している。/, "9 割に満たないのに転職と言い切る"],
        [mix.switched <= 0.1, /転職した道/, "転職した道がほとんど無いのに含むと言う"],
      ];
      for (const [c, re, why] of ban) if (c && re.test(own)) out.push(`C2 中身の幅と合わない（${why}）`);
    } else {
      const sw = s.fl.includes("switched");
      const ban: Array<[boolean, RegExp, string]> = [
        [s.j !== "i", /から独立した|独立して \d|独立のまま/, "会社員なのに独立"],
        [s.j === "i", /会社員として|本業で|給与は今日/, "独立しているのに会社員・本業"],
        [s.pm === "n" && s.j !== "i", /副業の顧客が|1 社目が決まった/, "副業不可なのに副業の顧客"],
        [s.pro === 0, /有料会員|Pro の売上|Pro は有料/, "Pro 前なのに有料会員"],
        [s.cl < 0.5, /顧客から|請求書/, "顧客がいないのに顧客から"],
        [s.j !== "p", /週 4 日勤務で給与|週 4 日勤務が認められ/, "週 4 日でないのに週 4 日"],
        [!sw, /会社へ移った|転職した|で転職（/, "転職していないのに転職"],
        [s.seats < 0.5, /学校の席|席が有料の席/, "学校の席が無いのに席"],
        // 2 社目の言い方（F2）。社数の違う場合をまとめた幅は mergedIssues で見る
        [!map.band(i)?.cl && clr(s.cl) !== 1, TWO_IF, "顧客が 1 社でないのに 2 社目が決まれば"],
        [!map.band(i)?.cl && clr(s.cl) < 2, TWO_LASTS, "顧客が 2 社に満たないのに 2 社目が続くか"],
      ];
      // 中身の幅の無いまとめた行き先（平均）は、一番多い仕事の道として書くので仕事の決まりだけを見る（有料・顧客・席・転職は平均で、道ごとに違う）
      for (const [c, re, why] of sum ? ban.slice(0, 2) : ban) if (c && re.test(own + title)) out.push(`C2 状態と合わない（${why}）`);
      if (!sum) for (const x of mergedIssues(map, i, own + "。" + title, banks.C)) out.push(`C2 まとめた結果を 1 つの事実として言う（${x}）`);
      if (!sum) for (const x of exactIssues(map, i, own, title)) out.push(`C2 社数が 1 つに決まった結果を、まとめた結果と言う（${x}）`);
    }
    // まとめた行き先の顧客の数（題・数の行・本文）: 中身の幅か平均に合う整数だけ。結果の名前（『』の中と「…の後」）は、その 3 か月の結果なので除く（truth-5）
    if (sum) for (const x of sumClientIssues(s.cl, mix, [title, ...nums, plain])) out.push(`C2 まとめた行き先の顧客の数${x}`);
    // D: 文では食い違いを無くせないデータ（計算の側へ返す）。まとめた行き先はならした値なので数えない（文は平均・幅と書く）。
    //   社数の違う場合をまとめた結果（幅 band.cl がある。SPEC §2.2）も、顧客の数は平均なので D2 に数えない
    if (!sum) {
      if (s.pm === "n" && s.pro === 1 && s.j !== "i") out.push("D1 『どちらも不可』なのに Pro が続いている（状態の食い違い）");
      if (s.cl >= 0.05 && Math.abs(s.cl - Math.round(s.cl)) >= 0.15 && !map.band(i)?.cl) out.push("D2 顧客の数が平均（整数でない）");
    }
    // C5: 結果の名前と状態の顧客の数（本当の状態と行き先だけ。まとめた行き先の名前はその 3 か月の結果で、状態は 3 年後の平均なので比べない）
    const lab = map.label(i);
    const m1 = /^顧客 (\d+) 社$/.exec(lab);
    const m2 = /^顧客 (\d+) 社以下$/.exec(lab);
    const m3 = /^顧客 (\d+) 社以上$/.exec(lab);
    if (!sum) {
      if (m1 && Math.round(s.cl) !== Number(m1[1])) out.push(`C5 結果の名前「${lab}」と状態の顧客 ${s.cl.toFixed(2)} 社が合わない`);
      if (m2 && Math.round(s.cl) > Number(m2[1])) out.push(`C5 結果の名前「${lab}」と状態の顧客 ${s.cl.toFixed(2)} 社が合わない`);
      if (m3 && Math.round(s.cl) < Number(m3[1])) out.push(`C5 結果の名前「${lab}」と状態の顧客 ${s.cl.toFixed(2)} 社が合わない`);
    }
  }
  // C3: 長さ
  const L = LIMITS[role];
  const len = [...plain].length;
  if ([...title].length > L.title) out.push(`C3 題が長い ${[...title].length}`);
  if (!title) out.push("C3 題が無い");
  const max = role === "a" && map.month(i) === 0 ? FIRST_MOVE_MAX : role === "s" && map.role(map.parent(map.parent(i))) === "r" ? FIRST_STATE_MAX : L.max;
  if (len < L.min || len > max) out.push(`C3 本文の長さ ${len}（${L.min}〜${max}）`);
  for (const td of t.todo) if ([...td.text].length > TODO_MAX) out.push(`C3 やることが長い: ${td.text}`);
  if (role === "a" && t.todo.length < 3) out.push(`C3 やることが ${t.todo.length} つ`);
  if (role === "e" && !/^3 年後(?:の見込み|の平均)?: /.test(title)) out.push("C3 行き先の題");
  if ((role === "s" || role === "e" || role === "r") && nums.length < 3) out.push("C3 数の行が短い");
  // C7: 手引きの文の月額がモデルに無い（人が見る）
  const book = [...(banks.playbook[map.kind(i) ?? ""] ?? []), ...(banks.playbook._generic ?? [])];
  const C = banks.C;
  for (const td of t.todo) {
    const st = book.find((x) => x.id === td.cite);
    if (!st) continue;
    for (const mm of `${st.act}${st.todo}`.matchAll(/月 ?([\d.]+) ?万円/g)) if (![C.feeFirst, C.feeRaised, C.indFee, C.spend, C.overhead].includes(Number(mm[1]))) out.push(`C7 モデルに無い月額 ${mm[0]}: ${td.cite}`);
  }
  return out;
}

/**
 * まとめた結果（事実の場合をまとめた 'all'・上げ幅をまとめた 'high_mid'・社数の違う場合をまとめた幅）を、どちらか一方の事実として
 * 言っていないか（C2・facts-1・reader-3）。見つかった物の説明を返す
 */
export function mergedIssues(map: MapData, i: number, text: string, C: Consts): string[] {
  const out: string[] = [];
  const k = map.kind(map.parent(i)) ?? "";
  if (mergedFact(map, i)) {
    if (k === "fc_push" && /昇格しなかった|評価は据え置き|据え置きで、|評価でも昇格|昇格が決まり|評価で昇格し|一段上がり/.test(text)) out.push("昇格と据え置きをまとめた結果");
    if (k === "sd_school" && /導入を見送った|導入を決め/.test(text)) out.push("導入と見送りをまとめた結果");
    if (map.outId(i) === "high_mid" && /給与が今日の [0-9.]+ 倍の会社へ(?:小幅増で)?移った/.test(text)) out.push("上げ幅の違う転職をまとめた結果");
  }
  const b = map.band(i)?.cl;
  if (b && b[0] < b[1]) {
    const m = /1 社目（月|1 社目が決まり|もう 1 社増えた|[0-9]+ 社目が決まった。|顧客が [0-9]+ 社離れた|契約の終わった顧客が|社との契約が更新されずに|が運用を打ち切った|新しい顧客は決まらなかった|候補からは決まらなかった|まだ良い返事が来ていない|今回も良い返事が来なかった|契約には至らなかった|声をかけたが、まだ決まらない/.exec(text);
    if (m) out.push(`社数の幅 ${b[0]}〜${b[1]} 社「${m[0]}」`);
    const j = map.st(i).j;
    const cap = j === "i" ? C.capInd : j === "p" ? C.capPart : C.capEmp;
    if (b[0] < cap && /上限に届いた|上限まで顧客が(?:いて|いる)|上限に届いている/.test(text)) out.push(`社数の幅 ${b[0]}〜${b[1]} 社で上限と言う`);
    // 3 年後の見通し（F2）: 「2 社目が決まれば」は顧客が確かに 1 社、「2 社目が続くか」は確かに 2 社のときだけ言える
    if (TWO_IF.test(text)) out.push(`社数の幅 ${b[0]}〜${b[1]} 社で、顧客 1 社と決めて 2 社目が決まればと言う`);
    if (b[0] < 2 && TWO_LASTS.test(text)) out.push(`社数の幅 ${b[0]}〜${b[1]} 社で、2 社目が続くかと言う`);
  }
  return out;
}

/**
 * 社数が 1 つに決まった結果（顧客の数に幅が無い・幅の上下が同じ）を、社数の違う場合をまとめた結果と言っていないか（C2・truth-2）:
 * 1 つの社数の「N 社の幅」と、顧客の文の「決まった場合とまだの場合をまとめた」の言い方。own は同じ手の別の結果と比べる文を除いた本文
 */
export function exactIssues(map: MapData, i: number, own: string, title: string): string[] {
  const out: string[] = [];
  const [lo, hi] = clBand(map, i);
  if (map.band(i)?.cl && lo !== hi) return out;
  for (const m of `${own}。${title}`.matchAll(/(?<![0-9〜])([0-9]+) 社の幅/g)) out.push(`「${m[0]}」`);
  for (const sent of own.split("。")) if (/顧客|社目/.test(sent) && /場合とまだの場合|場合を合わせた|場合をまとめ|1 つにまとめ|2 つをまとめ/.test(sent)) out.push(`「${sent.slice(0, 30)}…」`);
  return out;
}

/** 手が言う「N 社目」が、判断 d の確かな顧客の数（N − 1）と合うか（C2・truth-3）。『』の中は数えない */
export function ordinalIssues(map: MapData, d: number, text: string): string[] {
  const out: string[] = [];
  if (d < 0) return out;
  const [lo, hi] = clBand(map, d);
  const bare = text.replace(/『[^』]*』/g, "『』");
  for (const m of bare.matchAll(/([1-9]) 社目/g)) {
    const n = Number(m[1]);
    if (lo !== hi) out.push(`「${m[0]}」と言うが、判断の顧客は ${lo}〜${hi} 社の幅`);
    else if (lo !== n - 1) out.push(`「${m[0]}」と言うが、判断の顧客は ${lo} 社`);
  }
  return out;
}

/**
 * 0.9: 状態・次の判断の並び・1 つ前の期と食い違う言い方（C2）
 * - F3: 「広告運用の顧客と Pro の両方から稼げる」は顧客がいて Pro を出しているときだけ。「顧客探しの手と Pro の手が…どちらも並ぶ」は次の判断に
 *   顧客探し（副業の顧客を 1 社増やす・紹介で顧客を増やす）と Pro の手（SpellDash の手）が並ぶときだけ
 * - code-1: 「N 社目…前の期」の見込みの動きは、1 つ前の期の顧客探しが N 社目を探した（1 つ前の判断の顧客の数が N − 1〜N 社の幅）ときだけ
 * - F5: 届け出の答えがまだか『SpellDash だけ可』の会社員の、知人の店の広告を無償で手伝う手は、就業規則か会社に確かめる一言を持つ（fact-13）
 */
export function claimIssues(map: MapData, i: number, text: string): string[] {
  const out: string[] = [];
  const role = map.role(i);
  if (role === "s") {
    const s = map.st(i);
    const kinds: string[] = [];
    for (let k = 0; k < map.childCount(i); k++) kinds.push(map.kind(map.child(i, k)) ?? "");
    if (/広告運用の顧客と Pro の両方から稼げる/.test(text) && (s.cl < 0.5 || !s.pro)) out.push("顧客がいないか Pro が無いのに、広告運用の顧客と Pro の両方から稼げると言う");
    if (/顧客探しの手と Pro の手が[^。]*どちらも並ぶ/.test(text) && !(kinds.some((k) => k === "ad_side" || k === "ad_more") && kinds.some((k) => k.startsWith("sd_")))) out.push(`次の判断に顧客探しと Pro の手が並ばないのに、どちらも並ぶと言う（${kinds.join("・")}）`);
    const up = map.parent(map.parent(i));
    for (const m of text.matchAll(/([0-9]+) 社目が決まる見込みは、前の期の|前の期に [^。]*だった ([0-9]+) 社目の見込みは|([0-9]+) 社目の見込みは [^。、]*から [^。、]*へ/g)) {
      const n = Number(m[1] ?? m[2] ?? m[3]);
      const [lo, hi] = up >= 0 ? clBand(map, up) : [-1, -1];
      if (lo !== n - 1 || hi !== n) out.push(`「${m[0]}」と言うが、1 つ前の期は ${n} 社目を探した期でない（顧客 ${lo}〜${hi} 社）`);
    }
  }
  if (role === "a" && map.kind(i) === "ad_portfolio") {
    const s0 = map.st(map.parent(i));
    if (s0.j !== "i" && (s0.pm === "?" || s0.pm === "s") && !/就業規則|会社に確かめ/.test(text)) out.push("届け出の答えがまだか SpellDash だけ可なのに、無償の広告運用の手伝いの前に確かめる一言が無い");
  }
  return out;
}

/** 状態の助言が勧める手の種類（その状態の子に並ばない手を勧めない。reader-3） */
const ADVICE_KINDS: ReadonlyArray<readonly [RegExp, readonly string[]]> = [[/応募を続ければ|次の 3 か月にも決まる目|次の応募先選び/, ["fc_switch", "fc_switch2"]]];

/** 状態 i の本文の助言が、次の判断に並ばない手を勧めていないか（C12） */
export function adviceKindIssues(map: MapData, i: number, text: string): string[] {
  const kinds = new Set<string>();
  for (let k = 0; k < map.childCount(i); k++) kinds.add(map.kind(map.child(i, k)) ?? "");
  const out: string[] = [];
  for (const [re, want] of ADVICE_KINDS) {
    const m = re.exec(text);
    if (m && !want.some((x) => kinds.has(x))) out.push(`次の判断に無い手を勧める「${m[0]}」`);
  }
  return out;
}

/** 道の画面の「選べる手」の並びと同じ手の名前（本文の「おすすめの『…』」と比べる。組み立ての listName と同じ決まり） */
export function listNameOf(map: MapData, a: number): string {
  if (map.isBase(a)) return "この 3 か月は今のまま";
  return map.header.kinds[map.kind(a) ?? ""]?.[0] ?? "";
}

/** 手の 3 年の見積もりの文（今日の手・まとめた手の長い言い方と、1.0 の短い言い方 3 つ。rep-1・con-15） */
export const VALUE_SENTENCE = /この手で進むと|までの稼ぎの見積もりは|この手を選ぶと、[^。]*までの稼ぎは|見積もりでは、ここから/;

/**
 * 1b・W3（con-3・C13）: 結果が 2 つ以上の手の本文が言う、結果ごとの次の判断のおすすめの手（「『A』と『B』の後は『X』」「どの結果でも…『X』」）が、
 * その結果の状態の画面のおすすめ（pi。決まらなければ −1 で比べない）と同じ手か。text は仕上げた本文
 */
export function nextRecIssues(map: MapData, a: number, text: string, pi: (d: number) => number): string[] {
  const out: string[] = [];
  if (map.role(a) !== "a") return out;
  const kids: number[] = [];
  for (let k = 0; k < map.childCount(a); k++) kids.push(map.child(a, k));
  const byLab = new Map<string, number>();
  for (const o of kids) {
    const lab = shownLabel(map, o);
    if (lab) byLab.set(lab, o);
  }
  const check = (o: number, said: string): void => {
    if (map.role(o) !== "s") return;
    const r = pi(o);
    if (r < 0) return;
    const want = listNameOf(map, r);
    if (want && said !== want) out.push(`『${map.label(o)}』の後の次のおすすめ『${said}』が画面のおすすめ『${want}』と違う`);
  };
  for (const sent of text.split("。")) {
    if (!/おすすめ/.test(sent)) continue;
    if (/どの結果|結果によらず/.test(sent)) {
      const m = /『([^』]*)』$/.exec(sent);
      if (m) for (const o of kids) check(o, m[1]!);
      continue;
    }
    for (const m of sent.matchAll(/((?:『[^』]*』と)*『[^』]*』)(?:なら|の後は)『([^』]*)』/g))
      for (const l of m[1]!.matchAll(/『([^』]*)』/g)) {
        const o = byLab.get(l[1]!);
        if (o !== undefined) check(o, m[2]!);
      }
  }
  return out;
}

/**
 * 本文の「おすすめ」が、画面のおすすめ（今の年収の一番良い選び方 π。pi(d) はその手、決まらなければ −1）と同じ手か（C13・truth-1）:
 * おすすめの手の本文は「おすすめの手」と言う・ほかの手の本文が言う「おすすめの『…』」はその手の名前・「おすすめの『…』より N 万円多い」と
 * 言い切らない（見積もりで多いなら、その後の選び直しまで入れるとおすすめが上だと訳を言う）。text は仕上げた本文
 */
export function recommendIssues(map: MapData, a: number, text: string, pi: (d: number) => number): string[] {
  const out: string[] = [];
  if (map.role(a) !== "a") return out;
  const d = map.parent(a);
  if (map.role(d) === "r") return out;
  const rec = pi(d);
  if (rec < 0) return out;
  // この手の 3 年の見積もりの文（「この手で進むと」）がある手だけ（値の無い手は比べる文を書かない）
  if (rec === a && VALUE_SENTENCE.test(text) && !/おすすめの手/.test(text)) out.push("おすすめの手の本文が、おすすめの手と言わない");
  for (const m of text.matchAll(/おすすめの『([^』]*)』/g)) if (m[1] !== listNameOf(map, rec)) out.push(`本文のおすすめ『${m[1]}』が画面のおすすめ『${listNameOf(map, rec)}』と違う`);
  const more = /(?<!見積もりでは)おすすめの『[^』]*』より [0-9.,]+ 万円多い/.exec(text);
  if (more) out.push(`おすすめの手より多いと言い切る「${more[0]}」`);
  return out;
}

/** 状態の本文が次の判断のおすすめの手を言う言い方（「おすすめは『…』」「3 年の稼ぎが一番多いのは『…』」「地図を作った年収の見積もりで一番の手は『…』」） */
const STATE_REC = /(?:おすすめは|一番多いのは|一番の手は)『([^』]*)』/;
/** 選べる手が今のままだけの判断の言い方（訳つき） */
const STATE_NO_CHOICE = /選べる手は今のままだけ（/;

/**
 * 状態の本文が、次の判断のおすすめの手を言うか（0.8・W2: どの状態も次のおすすめの手を言い、選べる手が無ければその訳を言う）と、
 * その手が画面のおすすめ（pi。決まらなければ −1 で、地図のおすすめ）と同じか（C13）。text は仕上げた本文
 */
export function stateRecommendIssues(map: MapData, n: number, text: string, pi: (d: number) => number): string[] {
  if (map.role(n) !== "s") return [];
  const m = STATE_REC.exec(text);
  if (!m) return STATE_NO_CHOICE.test(text) ? [] : ["状態の本文が次の判断のおすすめの手を言わない"];
  const rec = pi(n);
  if (rec < 0) return [];
  // 地図の見出しに手の名前が無い手（手で作った地図）は、組み立てが題で言うので名前では比べない
  const want = listNameOf(map, rec);
  return !want || m[1] === want ? [] : [`状態の本文のおすすめ『${m[1]}』が画面のおすすめ『${want}』と違う`];
}

/**
 * まとめた行き先の後の標準の続きの 1 期の文章（composeCont を印つきで）の点検（reader-7: 道の画面で開ける文章も、ほかのカードと同じ決まり）:
 * C1 数はデータから・C1b 手引きの数字は引いた項目に・C4 地図の文の決まり・C4b 英数字の名前・C10 数の言い方・C2 社数の幅で「N 社目」と言わない
 * （まとめた手を選んだ判断の顧客の数と比べる）・やることは 3 つまで。d はまとめた手を選んだ判断
 */
export function checkCont(map: MapData, d: number, t: { title: string; body: string; todo: ReadonlyArray<{ text: string; cite: string }> }, wish: ReadonlyMap<string, WishText>): string[] {
  const out: string[] = [];
  const src = t.todo
    .map((td) => wish.get(td.cite))
    .filter((w): w is WishText => !!w)
    .map(wishSrc)
    .join(" ");
  for (const td of t.todo) if (!wish.get(td.cite)) out.push(`C1b 引用先が無い: ${td.cite}`);
  for (const span of playbookSpans(t.body)) for (const x of digitsNotIn(span, src)) out.push(`C1b 引用元に無い数字 ${x}「${span}」`);
  const stray = [...digitsOutside(t.body), ...digitsOutside(t.title)];
  if (stray.length) out.push(`C1 データに無い数字: ${stray.join(",")}`);
  const plain = spaceJa(strip(t.body));
  const title = spaceJa(strip(t.title));
  const all = `${plain}\n${title}`;
  if (/[%％Δ]/.test(all)) out.push("C4 % や差を書いている");
  if (/(です|ます)[。、」]?/.test(all)) out.push("C4 敬語");
  if (/\{\w+\}/.test(all) || /undefined|NaN|null|Infinity/.test(all)) out.push("C3 埋まっていない差し込み");
  const ascii = asciiIds(all);
  if (ascii.length) out.push(`C4b 英数字の名前: ${ascii.join(",")}`);
  for (const x of numberWording(all)) out.push(`C10 ${x}`);
  for (const [re, why] of OVERCLAIMS) if (re.test(all)) out.push(`C2 前提を言い過ぎる（${why}）`);
  const [lo, hi] = clBand(map, d);
  if (lo !== hi) for (const m of all.replace(/『[^』]*』/g, "『』").matchAll(/([1-9]) 社目/g)) out.push(`C2 標準の続きの期が「${m[0]}」と言うが、判断の顧客は ${lo}〜${hi} 社の幅`);
  if (t.todo.length > 3) out.push(`C3 やることが ${t.todo.length} つ`);
  if (!title) out.push("C3 題が無い");
  return out;
}

/** 判断 d までの道で、顧客が上の月額の数（raiseAt 社）に確かに届いたか（会社員に戻って顧客を手放した所より前は数えない。SPEC §2.3 #6） */
export function reachedRaise(map: MapData, d: number, C: Consts): boolean {
  for (let x = d; x >= 0; ) {
    if (clBand(map, x)[0] >= C.raiseAt) return true;
    const mv = map.parent(x);
    if (mv < 0) return false;
    const up = map.parent(mv);
    if (map.st(up).j === "i" && map.st(x).j !== "i") return false;
    x = up;
  }
  return false;
}

/** 表に出す結果の名前（地図の名前。英数字の名前なら null） */
const shownLabel = (map: MapData, o: number): string | null => {
  const lab = map.label(o);
  return lab && !/^[\x00-\x7F]*$/.test(lab) && !/[A-Za-z]+_/.test(lab) ? lab : null;
};

/**
 * 1b・W3: 本文の『lab』の結果の意味の切れ端（『lab』の後の見込みの括弧と「なら」「の場合は」「では」の後から、次の『か句点まで）。無ければ null。
 * 0.9 までは「『lab』なら」だけだった（1.0 で結果の名前の後に見込みを添え、数で分かれる結果の言い方を位置で 3 つ回す。con-3・L2）
 */
export function outcomeSegment(text: string, lab: string): string | null {
  const m = new RegExp(`『${escapeRe(lab)}』(?:（[^）]*）)?(?:なら|の場合は|では)`).exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  return rest.slice(0, Math.min(...[rest.indexOf("『"), rest.indexOf("。")].map((x) => (x < 0 ? rest.length : x))));
}

/**
 * 手が結果について言う額と数が、その結果の状態と合うか（C11・reader-4）: 次の顧客の月額（道で決まる段）・昇格の額（2 つの結果の給与の差）・
 * 結果ごとの売上・席・倍率・年収（『結果』なら…の中。まとめた行き先は 3 年後の平均なので比べない）。text は仕上げた本文
 */
export function moveClaims(map: MapData, a: number, text: string, C: Consts, annual?: number): string[] {
  const out: string[] = [];
  const kind = map.kind(a) ?? "";
  const d = map.parent(a);
  const s0 = map.st(a);
  if (kind === "ad_side" || kind === "ad_more") {
    const fee = newFeeOf(C, s0.j, reachedRaise(map, d, C));
    for (const m of text.matchAll(/(?:社目|もう 1 社)（月 ([0-9.]+) 万円）|1 社 月 ([0-9.]+) 万円/g)) if (Math.abs(Number(m[1] ?? m[2]) - fee) > 1e-9) out.push(`次の顧客の月額「${m[0]}」が道の月額 ${fee} 万円と違う`);
  }
  const kids: number[] = [];
  for (let k = 0; k < map.childCount(a); k++) kids.push(map.child(a, k));
  if (kind === "fc_push" && annual !== undefined) {
    const real = kids.filter((o) => !map.sum(o));
    const up = real.find((o) => map.outId(o) === "up");
    const same = real.find((o) => map.outId(o) === "same");
    const want = up !== undefined && same !== undefined ? annual * (map.rr(up)[0] - map.rr(same)[0]) : annual * C.step * (1 + C.aprilRaise) * (s0.j === "p" ? C.partFactor : 1);
    for (const m of text.matchAll(/年収(?:が|は) ([0-9,]+) ?万円上が/g)) if (Number(m[1]!.replace(/,/g, "")) !== Math.round(want)) out.push(`昇格の額「${m[0]}」が結果の給与の差 ${Math.round(want)} 万円と違う`);
  }
  // まとめた手の結果の給与（reader-1）: 3 年後の平均ではなく、その 3 か月の終わりの給与（広げた同じ手の結果と同じ数。quarterSal）でだけ言う。
  // 上げ幅をまとめた結果は、大きく上がる場合と小幅の場合のどちらか（式が広げた結果の給与と合うことは、生成の点検 Q1 が確かめる）
  const cal = calOf(map);
  for (const o of kids) {
    const id = map.outId(o);
    if (!map.sum(o)) continue;
    const lab = shownLabel(map, o);
    if (!lab) continue;
    const seg = outcomeSegment(text, lab);
    if (seg === null) continue;
    const ok = (id === "high_mid" ? [quarterSal(map, C, cal, a, "high"), quarterSal(map, C, cal, a, "mid")] : [quarterSal(map, C, cal, a, id)]).filter((x): x is number => x !== null);
    for (const m of seg.matchAll(/今日の ([0-9.]+) 倍/g)) if (!ok.some((x) => f2(x) === m[1])) out.push(`まとめた手の『${lab}』の倍率「${m[0]}」が、その 3 か月の給与 ${ok.map(f2).join("・") || "（無し）"} 倍と違う`);
    if (annual !== undefined) for (const m of seg.matchAll(/年収 ([0-9,]+) 万円/g)) if (!ok.some((x) => n0(annual * x) === m[1])) out.push(`まとめた手の『${lab}』の年収「${m[0]}」が、その 3 か月の給与 ${ok.map((x) => n0(annual * x)).join("・") || "（無し）"} 万円と違う`);
  }
  for (const o of kids) {
    const lab = shownLabel(map, o);
    if (map.sum(o) || !lab) continue;
    const seg = outcomeSegment(text, lab);
    if (seg === null) continue;
    const so = map.st(o);
    const rr = map.rr(o);
    for (const m of seg.matchAll(/売上 月 ([0-9.]+) 万円/g)) if (m[1] !== man(so.cl * so.fee)) out.push(`『${lab}』の売上「${m[0]}」が結果の ${man(so.cl * so.fee)} 万円と違う`);
    for (const m of seg.matchAll(/([0-9,]+) 席分/g)) if (m[1] !== n0(Math.max(0, so.seats - s0.seats))) out.push(`『${lab}』の席「${m[0]}」が加わる席 ${n0(Math.max(0, so.seats - s0.seats))} と違う`);
    for (const m of seg.matchAll(/今日の ([0-9.]+) 倍/g)) if (m[1] !== f2(rr[0]) && m[1] !== f2(so.sal)) out.push(`『${lab}』の倍率「${m[0]}」が結果の ${f2(rr[0])} 倍と違う`);
    if (annual !== undefined) for (const m of seg.matchAll(/年収 ([0-9,]+) 万円/g)) if (m[1] !== n0(annual * rr[0])) out.push(`『${lab}』の年収「${m[0]}」が結果の ${n0(annual * rr[0])} 万円と違う`);
    const [lo, hi] = map.band(o)?.cl ? clBand(map, o) : [Math.floor(so.cl + 1e-9), Math.ceil(so.cl - 1e-9)];
    for (const m of seg.matchAll(/顧客は (?:ほぼ )?([0-9]+)(?:〜([0-9]+))? 社/g)) {
      const a1 = Number(m[1]);
      const b1 = m[2] === undefined ? a1 : Number(m[2]);
      if (a1 < Math.min(lo, clr(so.cl)) || b1 > Math.max(hi, clr(so.cl))) out.push(`『${lab}』の顧客「${m[0]}」が結果の ${lo}〜${hi} 社と違う`);
    }
  }
  return out;
}

/** 手 a までの道で、今の会社での転職活動の期の数（a を含む。転職・会社員に戻るより前は数えない） */
export function searchQuarters(map: MapData, a: number): number {
  const isSearch = (k: string | null): boolean => k === "fc_switch" || k === "fc_switch2";
  let n = isSearch(map.kind(a)) ? 1 : 0;
  for (let d = map.parent(a); d > 0 && map.role(d) === "s"; ) {
    const mv = map.parent(d);
    const up = map.parent(mv);
    if (isSearch(map.kind(mv)) && /^(high|mid|high_mid)$/.test(map.outId(d))) break;
    if (map.st(up).j === "i" && map.st(d).j !== "i") break;
    if (isSearch(map.kind(mv))) n++;
    d = up;
  }
  return n;
}

/**
 * 手 a までの道で、今の会社に入ってから（転職・会社員に戻るより後）その種類の手を選んだ回数（a は含まない。C12・F5）。
 * 組み立ての countKindHere（./path.ts）と同じ決まりを、地図の形で数える
 */
export function kindHereBefore(map: MapData, a: number, kind: string): number {
  const isSearch = (k: string | null): boolean => k === "fc_switch" || k === "fc_switch2";
  let n = 0;
  for (let d = map.parent(a); d > 0 && map.role(d) === "s"; ) {
    const mv = map.parent(d);
    const up = map.parent(mv);
    if (isSearch(map.kind(mv)) && /^(high|mid|high_mid)$/.test(map.outId(d))) break;
    if (map.st(up).j === "i" && map.st(d).j !== "i") break;
    if (map.kind(mv) === kind) n++;
    d = up;
  }
  return n;
}

/**
 * 何も変えなかった結果か（据え置き・見送り・転職せず・断られた・独立のまま・どちらも不可・顧客が増えも減りもしなかった顧客探し。C12・F4）。
 * 組み立ての NO_CHANGE の出来事（./compose.ts）を、地図の形で見る
 */
export function stillOutcome(map: MapData, o: number): boolean {
  const k = map.kind(map.parent(o)) ?? "";
  const id = map.outId(o);
  if (k === "fc_push") return id === "same";
  if (k === "sd_school" || k === "sd_pilot" || k === "ad_portfolio") return id === "no";
  if (k === "fc_switch" || k === "fc_switch2") return id === "none";
  if (k === "part") return id === "e";
  if (k === "back_emp") return id === "i";
  if (k === "ad_perm" || k === "ad_permside" || k === "sd_permpro") return id === "n";
  if (k === "ad_side" || k === "ad_more") {
    const [pl, ph] = clBand(map, map.parent(map.parent(o)));
    const [bl, bh] = clBand(map, o);
    return pl === ph && bl === bh && bl === pl;
  }
  return false;
}

/** 地図の暦（点検ごとに作り直さない） */
const CALS = new WeakMap<MapData, Calendar>();
const calOf = (map: MapData): Calendar => {
  let c = CALS.get(map);
  if (!c) CALS.set(map, (c = calendarOf(map.header)));
  return c;
};

/** 道の歩みと合わない文（C12・reader-6）: 前の手・転職活動の期・顧客の有無・会社員だった期間・広告運用の稼ぎ・前の会社の手の続き・何も変えなかった結果 */
export function pathContext(map: MapData, i: number, text: string, t: Card): string[] {
  const out: string[] = [];
  const role = map.role(i);
  if (/面接に進めなかった/.test(text) && /面接の手応え/.test(text)) out.push("面接に進めなかったのに面接の手応え");
  if (role === "a") {
    const kind = map.kind(i) ?? "";
    const d = map.parent(i);
    const prevKind = map.role(d) === "s" ? map.kind(map.parent(d)) : null;
    if (/前の 3 か月の(?:面接|応募)の手応え/.test(text) && prevKind !== "fc_switch" && prevKind !== "fc_switch2") out.push("前の 3 か月が転職活動でないのに、その手応え");
    if (kind === "fc_switch2")
      for (const m of text.matchAll(/転職活動(?:の|は) ?([0-9]+) 期目|（([0-9]+) 期目）/g)) {
        const n = Number(m[1] ?? m[2]);
        const actual = searchQuarters(map, i);
        if (n !== actual) out.push(`転職活動の期が ${n}（道では ${actual}）`);
      }
    // 1b・W3（con-5）: 『転職せず』の後の判断に転職活動が並ばないのに、続けて探すと言わない
    if (kind === "fc_switch" || kind === "fc_switch2")
      for (let k = 0; k < map.childCount(i); k++) {
        const o = map.child(i, k);
        if (map.outId(o) !== "none" || map.role(o) !== "s") continue;
        let next = false;
        for (let x = 0; x < map.childCount(o); x++) if (/^fc_switch2?$/.test(map.kind(map.child(o, x)) ?? "")) next = true;
        const lab = shownLabel(map, o);
        const seg = lab ? outcomeSegment(text, lab) : null;
        if (!next && seg !== null && /続けられる|続きが並ぶ|続けて探せる|もう 1 期探せる|続けるか|探すかを|次の 3 か月の応募/.test(seg)) out.push(`『${lab}』の後の判断に転職活動が並ばないのに、続けて探すと言う「${seg.slice(0, 30)}」`);
      }
    const dPrev = map.role(d) === "s" ? map.parent(map.parent(d)) : -1;
    if (/過去 6 か月の月次報告/.test(text) && (map.st(d).j === "i" || (dPrev >= 0 && map.st(dPrev).j === "i"))) out.push("独立していた期があるのに過去 6 か月の月次報告");
    if (kind === "ad_portfolio" && (clr(map.st(d).cl) >= 1 || map.st(d).j === "i") && /副業を始めるときに|副業の 1 社目探し/.test(text)) out.push("顧客がいるのに副業を始めるとき");
    if (t.todo.some((x) => /区切る顧客/.test(x.text)) && map.st(d).cl < 0.5) out.push("顧客がいないのに区切る顧客");
    // 担当を広げ続ける・前の評価の続きと言うのは、今の会社で前にその手を選んだときだけ（移った会社・戻った会社では初めから。F5）
    if (((kind === "fc_scope" && /担当を広げ続け|もう一段広げる/.test(text)) || (kind === "fc_push" && /前の評価で足りなかった|評価の資料にまとめ直す/.test(text))) && kindHereBefore(map, i, kind) === 0) out.push("今の会社ではまだ選んでいない手を、前の続きと言う");
  }
  if (role === "e" && !map.sum(i)) {
    // 結びの文が結果の名前で言う 3 か月は、何かを変えた結果だけ（何も変えなかった結果は、その 3 か月の手で言う。F4）
    // 結果の名前で言う形と、3 か月の手で言う形（「…までの『昇格を狙う』の 3 か月で」。据え置きの 3 か月を一番の動きと言わない。reader-11）
    const lv = /一番大きく動かしたのは、([0-9]{4}) 年 ([0-9]{1,2}) 月までの『[^』]*』(?:の 3 か月)?で/.exec(text);
    if (lv) {
      const m = calOf(map).monthOf(Number(lv[1]), Number(lv[2]));
      for (let x = i; x > 0; x = map.parent(map.parent(x)))
        if (map.month(x) === m) {
          if (stillOutcome(map, x)) out.push(`何も変えなかった結果『${map.label(x)}』を、月の稼ぎを一番動かした物と言う`);
          break;
        }
    }
  }
  if (role === "s" && /副業と SpellDash の所得/.test(text)) {
    let any = false;
    for (let x = i; x >= 0 && !any; x = map.parent(x)) if (map.role(x) !== "a" && (map.st(x).cl >= 0.05 || (map.band(x)?.cl?.[1] ?? 0) >= 1)) any = true;
    if (!any) out.push("広告運用の稼ぎが無い道で副業の所得");
  }
  return out;
}

/**
 * まとめた行き先の文の顧客の数が、中身の幅（mix）か平均（cl）に合うか（C2）。1 つの数は平均から 0.15 社以内（「ほぼ」の範囲）、
 * 幅は平均を含む（中身の幅があれば 10%〜90% の整数の幅の中）。『』の中と題の「…の後」（結果の名前）は数えない
 */
export function sumClientIssues(cl: number, mix: { cl: readonly [number, number, number] } | null, texts: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of texts) {
    const bare = t.replace(/『[^』]*』/g, "『』").replace(/: [^:]*の後$/, ": ");
    for (const m of bare.matchAll(/(?:顧客|副業|広告運用)(?:は)? ?(?:平均 ?)?(?:ほぼ ?)?([0-9]+)(?:〜([0-9]+))? ?社(?!目|以上|以下|まで)/g)) {
      const lo = Number(m[1]);
      const hi = m[2] === undefined ? lo : Number(m[2]);
      const ok = mix ? lo >= Math.floor(mix.cl[0]) && hi <= Math.ceil(mix.cl[2]) : m[2] === undefined ? Math.abs(cl - lo) < 0.15 : lo <= cl + 1e-9 && cl <= hi + 1e-9;
      if (!ok) out.push(`「${m[0]}」が${mix ? `中身の幅 ${mix.cl[0]}〜${mix.cl[2]}` : `平均 ${cl.toFixed(2)} 社`}に合わない`);
    }
  }
  return out;
}

// ---- 道ごとの点検（C9: 道で 1 回だけの文）

/** 道で 1 回だけの文の見分け方: 束の言い換えから作った正規表現と、その文の名前（確定申告は年分ごと） */
export interface AdviceMatcher {
  readonly id: string;
  readonly re: RegExp;
  /** その年分を名前に足す（確定申告は年分ごとに 1 回） */
  readonly byYear: boolean;
}

/** 暦の確定申告と住民税の申告の型（どれも同じ年分の「申告の文」） */
const TAX_CELLS = new Set(["TAX_SIDE", "TAX_NEAR", "JUMIN_DECL", "TAX_IND", "TAX_MIX"]);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 言い換え 1 つを正規表現にする（{名前} は句点をまたがない何か。taxYear は年を取り出す） */
function variantRe(v: string): RegExp {
  const parts = v.split(/\{(\w+)\}/);
  let src = "";
  for (let k = 0; k < parts.length; k++) src += k % 2 === 0 ? escapeRe(parts[k]!) : parts[k] === "taxYear" ? "([^。]*?)" : "[^。]*?";
  return new RegExp(src, "g");
}

/** 束から、道で 1 回だけの文（暦・静かな期の一言・出来事の助言・避けたい訳）の見分け方を作る */
export function adviceMatchers(banks: Banks): AdviceMatcher[] {
  const out: AdviceMatcher[] = [];
  const add = (id: string, vs: ReadonlyArray<{ v: readonly string[] }> | undefined, perGroup: boolean, byYear = false): void => {
    (vs ?? []).forEach((g, gi) => {
      for (const v of g.v) out.push({ id: perGroup ? `${id}#${gi}` : id, re: variantRe(v), byYear });
    });
  };
  for (const [code, vs] of Object.entries(banks.cal)) {
    if (TAX_CELLS.has(code)) add("cal.TAX", vs, false, true);
    else add(`cal.${code}`, vs, false);
  }
  add("hint", banks.hint, true);
  for (const [code, vs] of Object.entries(banks.tip)) add(`tip.${code}`, vs, true);
  for (const [kind, vs] of Object.entries(banks.avoid)) add(`avoid.${kind}`, vs, false);
  return out;
}

/** 1 枚の本文（印つき）が使った、道で 1 回だけの文の名前（同じ名前が 2 回あれば 2 回数える） */
export function adviceIn(body: string, matchers: readonly AdviceMatcher[]): string[] {
  const out: string[] = [];
  for (const m of matchers) {
    m.re.lastIndex = 0;
    for (const hit of body.matchAll(m.re)) out.push(m.byYear ? `${m.id}@${(hit[1] ?? "").replace(/[^0-9]/g, "")}` : m.id);
  }
  return out;
}

/**
 * 地図のすべての道（今日から行き先まで）で、道で 1 回だけの文が 2 回出ていないか（C9）。bodyOf はカードの本文（印つき）。
 * contOf があれば、まとめた行き先の後の標準の続きの期の本文（道の画面で開ける行。reader-7）も、その道の続きとして見る。
 * 深さ優先で道の数え上げを持ち回るので、カードごとに 1 回だけ本文を見る
 */
export function checkPaths(map: MapData, bodyOf: (i: number) => string, banks: Banks, contOf?: (i: number) => readonly string[]): string[] {
  const matchers = adviceMatchers(banks);
  const out: string[] = [];
  const counts = new Map<string, number>();
  const stack: Array<[number, string[] | null]> = [[0, null]];
  while (stack.length) {
    const [i, undo] = stack.pop()!;
    if (undo) {
      for (const id of undo) counts.set(id, counts.get(id)! - 1);
      continue;
    }
    const conts = contOf && map.childCount(i) === 0 ? contOf(i) : [];
    const ids = [...adviceIn(bodyOf(i), matchers), ...conts.flatMap((b) => adviceIn(b, matchers))];
    for (const id of ids) {
      const n = (counts.get(id) ?? 0) + 1;
      counts.set(id, n);
      if (n === 2) out.push(`C9 道で 2 回: ${id} ← ${map.key(i)}`);
    }
    stack.push([i, ids]);
    for (let k = map.childCount(i) - 1; k >= 0; k--) stack.push([map.child(i, k), null]);
  }
  return out;
}
