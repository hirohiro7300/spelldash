// 資産のゴール（「資産 10 億円」）を地図のいちばん右に置き、行き先のカードからゴールへ線をつなぐ（設計: 作業メモ goal/design.md §4.3）
//   ゴールの列   入口から impactColX(26)（2029 年 11 月 = 36 か月目の列の 1 つ右）。目盛りの下から画面の下まで、薄い金色の破線
//   線           見えている行き先のカードの右のつまみから、ゴールの列まで同じ高さで。期限の年の資産がゴールの何割か（frac）の所まで
//                実線、その先は点線（3 年より先は前提から出した目安なので）。芽の行き先は金色、ほかは灰色。4 本の線にまとめて描く。
//                選んだ道（選んだカードの前後）があれば、その道の行き先の線は濃く、ほかは 25% の濃さ（濃い 4 本と薄い 4 本）。
//                縮めたとき（low・dot）は芽の線だけを 1px で 400 本まで
//   選んだ行き先 線の右に「2056 年 0.45 億円（5%）目安」。スマホでゴールの列が画面の右の外なら、そのカードから右の札まで破線を 1 本
//   ゴールのカード DOM のボタン 1 つ（.goal-rail。キャンバスの入れ物の中）。目盛りのすぐ下、ゴールの列の右。フレームごとに位置を
//                1 度だけ書く（変わったときだけ）。列が画面の外なら端に札で寄せる（机「→ ゴール 10 億円 5%」・スマホ「10億 5% ›」）。
//                上に置くので、下の操作・お知らせには重ならない。文字は空いた時間に入れる（起動の最初の絵には出さない）。
//                押すと: カードは前提と内訳を開く・札はゴールの列が見える所へ動く
// 地図の文書にもデータにも何も足さない（描くだけ）。数は行き先のカードの札（ImpactCards の card.goal: 計算の結果ごとに作る）から。

import { whenIdle } from "../app/idle";
import { formatGoalShare, formatOku, type GoalTables } from "../model/goal";
import { impactColX } from "../model/impactLayout";
import type { ID } from "../model/types";
import { h } from "../ui/dom";
import type { Lod } from "./draw";
import { HALF_W } from "./geometry";
import type { ImpactCard } from "./impactCards";
import { CANVAS_FONT } from "./text";

/** ゴールの列（入口からの列の番号。36 か月目の列 24 の 1 つ右の判断・結果の列） */
export const GOAL_RAIL_DEPTH = 26;
/** 入口からゴールの列までの横の距離（世界の座標） */
export const GOAL_RAIL_DX = impactColX(GOAL_RAIL_DEPTH);
/** 縮めたとき（low・dot）に描く芽の線の上限 */
export const GOAL_STUB_LOW_CAP = 400;
/** 狭い画面（スマホの縦向き）の幅 */
const NARROW = 640;
/** カードと札の、目盛りの下からの間（px）と、画面の端からの間 */
const GAP_TOP = 8;
const GAP_SIDE = 12;
/** ゴールのカードの幅（CSS の .goal-rail と同じ） */
const CARD_W = 176;
const CARD_W_NARROW = 128;
/** 札の高さ（CSS の .goal-rail.is-chip の min-height と同じ） */
const CHIP_H = 36;

/** ゴールの数（カードと札の文字） */
export interface GoalRailInfo {
  /** 同じ鍵なら文字を入れ直さない */
  key: string;
  /** 目標（万円） */
  T: number;
  /** 期限の年と、期限を入れていない（仮） */
  by: number;
  byKari: boolean;
  /** 今の道（おすすめの選び方）の期限の年の資産の真ん中（万円・目安）。出せなければ null */
  mid: number | null;
}

/** アプリが渡す物（数の出どころと、カードを押したときに開く物） */
export interface GoalRailHost {
  /** compute が false なら作ってある物だけ（無ければ null: 空いた時間に compute を true にして呼び直す） */
  info(compute: boolean): GoalRailInfo | null;
  /** 前提と内訳を開く */
  open(): void;
}

/** 線を描く 1 フレームの材料（画面の座標で描く: ctx は画面の px × dpr の変換のまま） */
export interface GoalScene {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  /** 目盛りの下の端（px） */
  top: number;
  z: number;
  cx: number;
  cy: number;
  lod: Lod;
  /** ゴールの列（世界の x） */
  railX: number;
  /** 見えている行き先のカード */
  ends: readonly ID[];
  pos(id: ID): { x: number; y: number };
  card(id: ID): ImpactCard | null;
  /** 選んだ道が出ている（そのときは道の上の行き先の線を濃く、ほかを薄く） */
  pathActive: boolean;
  onPath(id: ID): boolean;
  /** 1 つだけ選んでいるカード */
  selected: ID | null;
  /** 前提の係数（札の年と単位） */
  t: GoalTables | null;
}

/** 線の 8 つの組（金の実線・金の点線・灰の実線・灰の点線、それぞれ濃い / 薄い）の色（近い: full・compact） */
const NEAR_STYLE: ReadonlyArray<{ color: string; width: number; dot: boolean }> = [
  { color: "rgba(255,181,71,0.85)", width: 1.6, dot: false },
  { color: "rgba(255,181,71,0.7)", width: 1.6, dot: true },
  { color: "rgba(150,160,178,0.6)", width: 1.3, dot: false },
  { color: "rgba(150,160,178,0.55)", width: 1.4, dot: true },
];
/** 選んだ道の上（濃く） */
const EMPH_STYLE: ReadonlyArray<{ color: string; width: number; dot: boolean }> = [
  { color: "rgba(255,181,71,1)", width: 2.2, dot: false },
  { color: "rgba(255,181,71,0.95)", width: 2.2, dot: true },
  { color: "rgba(200,208,222,0.95)", width: 1.8, dot: false },
  { color: "rgba(200,208,222,0.85)", width: 1.8, dot: true },
];
/** 選んだ道の外（ふだんの 25%） */
const DIM_STYLE = NEAR_STYLE.map((s) => ({ ...s, color: s.color.replace(/[\d.]+\)$/, (a) => `${Math.round(parseFloat(a) * 25) / 100})`) }));
/** 縮めたとき（芽だけ・1px） */
const FAR_STYLE: ReadonlyArray<{ color: string; width: number; dot: boolean }> = [
  { color: "rgba(255,181,71,0.8)", width: 1, dot: false },
  { color: "rgba(255,181,71,0.55)", width: 1, dot: true },
];

/** 札の短い目標（「10 億」「3,000 万」） */
function shortGoal(T: number): string {
  return formatOku(T).replace(/ /g, "").replace(/円$/, "");
}

/** ゴールの何割か（丸めて 0% なら null: 「0%」は出さない） */
function shareOf(mid: number | null, T: number): string | null {
  if (mid === null || !(T > 0)) return null;
  const s = formatGoalShare(Math.min(1, Math.max(0, mid / T)));
  return s === "0%" ? null : s;
}

/** カードと札の文字（テストで確かめる。DOM を使わない） */
export function goalRailText(x: GoalRailInfo): { name: string; by: string; now: string | null; chipWide: string; chipNarrow: string; aria: string; chipAria: string } {
  const goal = formatOku(x.T);
  const oku = x.T >= 10_000;
  const share = shareOf(x.mid, x.T);
  const now = x.mid !== null ? `今の道 ${formatOku(x.mid, oku).replace(/ 億円$/, " 億")}${share ? `（${share}）` : "・"}目安` : null;
  const by = `${x.by} 年まで${x.byKari ? "（仮）" : ""}`;
  const aria = `ゴールは資産 ${goal}、${x.by} 年まで${x.byKari ? "（期限は仮）" : ""}。${x.mid !== null ? `今の道では約 ${formatOku(x.mid, oku)}${share ? `（ゴールの ${share}）` : ""}の目安。` : ""}押すと前提と内訳を開きます`;
  return {
    name: `資産 ${goal}`,
    by,
    now,
    chipWide: `→ ゴール ${goal}${share ? ` ${share}` : ""}`,
    chipNarrow: `${shortGoal(x.T)}${share ? ` ${share}` : ""} ›`,
    aria,
    chipAria: `ゴールの資産 ${goal}（${x.by} 年まで）は地図の 3 年後の列の右です${share ? `。今の道ではゴールの ${share}（目安）` : ""}。押すとゴールの所へ動きます`,
  };
}

/** 選んだ行き先の線の札（「2056 年 0.45 億円（5%）目安」） */
export function goalStubLabel(t: GoalTables, atBy: number): string {
  const share = shareOf(atBy, t.T);
  return `${t.by} 年 ${formatOku(atBy, t.T >= 10_000)}${share ? `（${share}）` : "・"}目安`;
}

/** 札の幅を測る入れ物（1 つだけ作って使い回す: 測るたびにキャンバスを作らない） */
let measure: CanvasRenderingContext2D | null | undefined;
function measureCtx(): CanvasRenderingContext2D | null {
  if (measure === undefined) measure = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
  return measure;
}

export class GoalRail {
  /** 直近のフレームで描いた線の数（確かめ用: 数だけ。どの行き先かも値も持たない） */
  stubs = 0;
  /** そのうち選んだ道の上で濃く描いた数 */
  emph = 0;
  /** 線を描いた回数（stroke。まとめて描けているか） */
  strokes = 0;
  /** 選んだ行き先の線の札を描いた（確かめ用） */
  labeled = false;
  /** スマホで選んだ行き先から右の札へ破線を描いた（確かめ用） */
  connector = false;
  /** 直近のフレームのゴールの列の画面の x（列を描かなかったら null） */
  railSx: number | null = null;
  /** ゴールのカードの形（"" は出していない） */
  state: "" | "card" | "right" | "left" = "";

  private el: HTMLButtonElement | null = null;
  private parts: { name: HTMLElement; by: HTMLElement; now: HTMLElement; chip: HTMLElement } | null = null;
  private host: GoalRailHost | null = null;
  private text: ReturnType<typeof goalRailText> | null = null;
  private filledKey = "";
  private asked = false;
  private narrow = false;
  private chipW = { wide: 0, narrow: 0 };
  private placed = "";
  private placedNarrow = false;
  private dirty = false;
  private readonly segs: number[][] = Array.from({ length: 8 }, () => []);

  /** pan: 札を押したとき、ゴールの列が見える所へ動かす。redraw: 文字を入れた後に描き直す */
  constructor(
    private readonly pan: () => void,
    private readonly redraw: () => void,
  ) {}

  /** お知らせの帯（キャンバスの上に重ねて出す物）の高さ。出ている間はカードと札をその下へ */
  private bannerH = 0;

  /**
   * ゴールのカード（DOM）をキャンバスの入れ物に置く（アプリから 1 度）。banner: キャンバスの上に重ねるお知らせの帯の入れ物
   * （高さが変わったときだけ測る: 描くたびに DOM を測らない）
   */
  attach(parent: HTMLElement, host: GoalRailHost, banner?: HTMLElement): void {
    if (this.el) return;
    this.host = host;
    const name = h("b", { class: "goal-rail-name" });
    const by = h("span", { class: "goal-rail-by" });
    const now = h("span", { class: "goal-rail-now" });
    const chip = h("span", { class: "goal-rail-chip" });
    const el = h("button", { class: "goal-rail", type: "button", dataset: { fk: "goal-rail" } }, h("span", { class: "goal-rail-k" }, "ゴール"), name, by, now, chip);
    el.hidden = true;
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (this.state === "card") this.host?.open();
      else this.pan();
    });
    // キャンバスの押す・動かすに渡さない（ボタンとして押す）
    el.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    this.el = el;
    this.parts = { name, by, now, chip };
    parent.append(el);
    if (banner && typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => {
        const hgt = Math.round(banner.getBoundingClientRect().height);
        const off = hgt > 0 ? hgt + 10 : 0;
        if (off === this.bannerH) return;
        this.bannerH = off;
        el.style.setProperty("--goal-banner", `${off}px`);
        this.redraw();
      }).observe(banner);
    }
  }

  /** 札の右の端から左へ伸びる幅（スマホの破線の行き先。文字を入れたときに測る） */
  private chipWidth(): number {
    return this.narrow ? this.chipW.narrow : this.chipW.wide;
  }

  /** 線とゴールの列を描く（画面の座標）。続けてゴールのカードを置く */
  draw(s: GoalScene): void {
    const { ctx, width: W, height: H, z, cx, cy, lod, t } = s;
    const rx = s.railX * z + cx;
    this.railSx = rx;
    this.narrow = W < NARROW;
    let strokes = 0;
    // ゴールの列（薄い金色の破線。目盛りの下から下まで）
    if (rx > -2 && rx < W + 2) {
      ctx.save();
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = "rgba(255,181,71,0.42)";
      ctx.beginPath();
      const x = Math.round(rx) + 0.5;
      ctx.moveTo(x, s.top);
      ctx.lineTo(x, H);
      ctx.stroke();
      ctx.restore();
      strokes++;
    }
    // 行き先からゴールへの線（4 つ・選んだ道があれば 8 つの組にまとめる）
    const near = lod === "full" || lod === "compact";
    const segs = this.segs;
    for (const a of segs) a.length = 0;
    let n = 0;
    let emph = 0;
    let far = 0;
    let sel: { x0: number; y: number; atBy: number } | null = null;
    const y0 = s.top - 2;
    const y1 = H + 2;
    const xr = Math.min(rx, W + 2);
    if (rx > 0) {
      for (const id of s.ends) {
        const p = s.pos(id);
        const y = p.y * z + cy;
        if (y < y0 || y > y1) continue;
        const x0 = (p.x + HALF_W) * z + cx;
        if (x0 >= rx || x0 > W) continue;
        const g = s.card(id)?.goal;
        if (!g) continue;
        if (id === s.selected) sel = { x0, y, atBy: g.atBy };
        if (!near) {
          if (!g.seed || far >= GOAL_STUB_LOW_CAP) continue;
          far++;
        }
        const on = s.pathActive && s.onPath(id);
        const grp = (g.seed ? 0 : 2) + (s.pathActive && !on ? 4 : 0);
        // 実線はゴールの何割かの所まで（短くても 6px: 線があることは見える）。その先は点線（前提から出した目安）
        const xs = Math.min(rx, x0 + Math.max(6, g.frac * (rx - x0)));
        const a = Math.max(-2, x0);
        if (xs > a) segs[grp]!.push(a, Math.min(xs, xr), y);
        if (rx > xs && xs < W + 2) segs[grp + 1]!.push(Math.max(-2, xs), xr, y);
        n++;
        if (on) emph++;
      }
    }
    for (let k = 0; k < 8; k++) {
      const list = segs[k]!;
      if (!list.length) continue;
      const st = !near ? FAR_STYLE[k & 1]! : s.pathActive ? (k >= 4 ? DIM_STYLE[k - 4]! : EMPH_STYLE[k]!) : NEAR_STYLE[k]!;
      ctx.lineWidth = st.width;
      ctx.strokeStyle = st.color;
      ctx.lineCap = st.dot ? "round" : "butt";
      ctx.setLineDash(st.dot ? [0.5, st.width * 2.6] : []);
      ctx.beginPath();
      for (let i = 0; i < list.length; i += 3) {
        ctx.moveTo(list[i]!, list[i + 2]!);
        ctx.lineTo(list[i + 1]!, list[i + 2]!);
      }
      ctx.stroke();
      strokes++;
    }
    ctx.setLineDash([]);
    ctx.lineCap = "butt";
    this.stubs = n;
    this.emph = emph;
    this.labeled = false;
    this.connector = false;
    // 選んだ行き先: 線の右に期限の年の資産
    if (sel && t) {
      const text = goalStubLabel(t, sel.atBy);
      ctx.font = `650 11px ${CANVAS_FONT}`;
      ctx.textBaseline = "alphabetic";
      ctx.lineJoin = "round";
      const x = Math.max(4, sel.x0 + 8);
      const y = sel.y - 6;
      if (x < W && y > s.top + 10) {
        ctx.strokeStyle = "rgba(7,9,13,0.92)";
        ctx.lineWidth = 4;
        ctx.strokeText(text, x, y);
        ctx.fillStyle = "rgba(255,208,138,1)";
        ctx.fillText(text, x, y);
        this.labeled = true;
      }
      // スマホでゴールの列が右の外: そのカードから右の札まで破線を 1 本
      if (this.narrow && rx > W && sel.x0 < W - 4 && this.text) {
        const ex = W - GAP_SIDE - this.chipWidth();
        const ey = s.top + GAP_TOP + this.bannerH + CHIP_H / 2;
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = "rgba(255,181,71,0.8)";
        ctx.beginPath();
        ctx.moveTo(Math.max(0, sel.x0), sel.y);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        ctx.restore();
        strokes++;
        this.connector = true;
      }
    }
    this.strokes = strokes;
    this.place(W, rx);
  }

  /** ゴールの列を描かない（3 か月ごとの地図でない・入口が見えていない）: カードも隠す */
  off(): void {
    this.stubs = 0;
    this.emph = 0;
    this.strokes = 0;
    this.labeled = false;
    this.connector = false;
    this.railSx = null;
    this.state = "";
    if (this.el && !this.el.hidden) this.el.hidden = true;
  }

  /** カードを置く（列が見えていれば列の右、外なら端の札）。書くのは変わったときだけ */
  private place(W: number, rx: number): void {
    const el = this.el;
    if (!el || !this.host) return;
    const info = this.host.info(false);
    if (!info || (info.key !== this.filledKey && !this.text)) {
      // 文字は空いた時間に入れる（初めてなら、このフレームでは出さない）
      this.ask();
      if (!el.hidden) el.hidden = true;
      this.state = "";
      return;
    }
    // 前提が変わった: 前の文字のまま置き、空いた時間に入れ直す
    if (info.key !== this.filledKey) this.ask();
    const cw = this.narrow ? CARD_W_NARROW : CARD_W;
    // 列の右に入らなければ列の左に（列が画面の中なら札にしない）。列が画面の外なら端の札
    const x = rx + 8 + cw <= W - 8 ? rx + 8 : rx - 8 - cw;
    const state: GoalRail["state"] = rx > W - 4 || (x !== rx + 8 && x < 8) ? (rx < 0 ? "left" : "right") : rx < 4 ? "left" : "card";
    if (el.hidden) el.hidden = false;
    if (state !== this.state || this.narrow !== this.placedNarrow || this.dirty) {
      this.state = state;
      this.placedNarrow = this.narrow;
      this.dirty = false;
      this.setState(state);
    }
    // 位置は 1 つの書き込みだけ（カードは列の右へ。札は CSS で端に）
    const tr = state === "card" ? `translate3d(${Math.round(x)}px,0,0)` : "";
    if (tr !== this.placed) {
      el.style.transform = tr;
      this.placed = tr;
    }
  }

  private setState(state: GoalRail["state"]): void {
    const el = this.el!;
    const p = this.parts!;
    const x = this.text;
    el.classList.toggle("is-chip", state !== "card");
    el.classList.toggle("is-left", state === "left");
    el.classList.toggle("is-narrow", this.narrow);
    if (!x) return;
    let chip = this.narrow ? x.chipNarrow : x.chipWide;
    // 左の外（ゴールより右へ動かした）: 矢印を左へ
    if (state === "left") chip = this.narrow ? `‹ ${chip.replace(/ ›$/, "")}` : chip.replace(/^→ /, "← ");
    p.chip.textContent = chip;
    el.setAttribute("aria-label", state === "card" ? x.aria : state === "left" ? x.chipAria.replace("は地図の 3 年後の列の右です", "は今見ている所より左です") : x.chipAria);
  }

  /** 空いた時間に数を作って文字を入れる（1 度に 1 回だけ頼む） */
  private ask(): void {
    if (this.asked) return;
    this.asked = true;
    whenIdle(() => {
      this.asked = false;
      const info = this.host?.info(true);
      if (!info || !this.parts || !this.el) return;
      // 同じ数なら何も書かない（計算の入れ物が作り直されただけ）
      if (info.key === this.filledKey && this.text) return;
      const x = goalRailText(info);
      this.text = x;
      this.filledKey = info.key;
      this.parts.name.textContent = x.name;
      this.parts.by.textContent = x.by;
      // 「目安」の途中で折り返さない（数と目安をそれぞれ 1 かたまりに）
      const head = (x.now ?? "").replace(/目安$/, "");
      this.parts.now.replaceChildren(h("span", null, head), " ", h("span", null, x.now ? "目安" : ""));
      this.parts.now.hidden = !x.now;
      // 札の幅（スマホの破線の行き先）: CSS と同じ文字の形で測る（DOM を測らない）
      const c = measureCtx();
      if (c) {
        c.font = `650 12px ${CANVAS_FONT}`;
        this.chipW = { wide: c.measureText(x.chipWide).width + 26, narrow: c.measureText(x.chipNarrow).width + 26 };
      }
      // 次のフレームで札の文字と読み上げも入れ直す
      this.dirty = true;
      this.redraw();
    }, 600);
  }
}
