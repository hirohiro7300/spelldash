// 文章を生成につなぐ（作業メモ SPEC v1 §3.1・§4.3・§4.6・§2.8）:
//   bakeText（TB2）題・短い名前・やること（やりたいことリストの元の番号つき）を、開発用の木（同梱データの精度に丸めた木）に焼き込む。
//              文章の組み立て（src/demo/compose の composeCard）を入口の年収で呼んだ物。ほかの年収（540 万円）でも組み立て直して、
//              年収で変わらないことを確かめる（変われば通らない）。入口の textVersion は文の型の束の版（BANKS.version）
//   checkBaked（TB1）同梱データを読んだ地図の題・短い名前・やることが、その地図で組み立て直した物と同じ（アプリと試し版がその場で組み立てる物と同じ）
//   textGate（TC）文章の点検（scripts/impact/textChecks.ts の runTextChecks。W-text の物）を生成の点検にする: 止める点検は通らない物、データの指摘は注意
// 本文と数の行は焼き込まない（その場で今の年収で組み立てる。§4.3）。node の機能は使わない（テストからも呼ぶ）

import { BANKS, composeCard, type Banks, type Card } from "../../../src/demo/compose";
import { fromDevTree } from "../../../src/deepmap/dev/fromTree";
import type { DevTree, DevTreeNode, MapData, MapTodo } from "../../../src/deepmap/mapData";
import { runTextChecks, type TextCheckOpts, type TextCheckReport } from "../textChecks";

/** 組み立て（テストで差し替える）。banks はカードの覚えの持ち主（同じ束なら同じ覚えを使う） */
export type ComposeFn = (map: MapData, i: number, annual: number, banks: Banks) => Card;

const defaultCompose: ComposeFn = (map, i, annual, banks) => composeCard(map, i, { annual, banks });

/** 焼き込む文（題・短い名前・やること） */
interface Baked {
  title: string;
  short: string;
  todo: MapTodo[];
}

const LIMIT = 20;

/** 2 つのやることの並びが同じか（文と元の番号） */
const sameTodo = (a: readonly MapTodo[], b: readonly MapTodo[]): boolean => a.length === b.length && a.every((t, k) => t.text === b[k]!.text && t.cite === b[k]!.cite);

/** 開発用の木を、読むだけの地図と同じ番号の順（深さ優先・兄弟は木の順）に並べる（fromDevTree と同じたどり方） */
export function devNodes(tree: DevTree): DevTreeNode[] {
  const out: DevTreeNode[] = [];
  const stack: DevTreeNode[] = [tree.root];
  while (stack.length) {
    const n = stack.pop()!;
    out.push(n);
    const ks = n.kids ?? [];
    for (let k = ks.length - 1; k >= 0; k--) stack.push(ks[k]!);
  }
  return out;
}

export interface BakeResult {
  /** 通らない物（題が空・題・短い名前・やることが年収で変わる・手でないカードにやること・やることの文か元の番号が空） */
  fails: string[];
  cards: number;
  /** 違う題・短い名前・やることの文・元の番号の数（同梱データの文字列の表の大きさの目安） */
  distinct: { title: number; short: number; todo: number; cite: number };
  /** やることのある手の数・やることの数 */
  movesWithTodo: number;
  todoItems: number;
  /** 年収ごとに組み立てた時間（ms） */
  ms: number[];
  textVersion: string;
}

/**
 * 開発用の木（丸めた木。書き換える）に題・短い名前・やることを焼き込み、入口の textVersion を文の型の束の版にする。
 * 入口の年収（header.annual）で組み立てた物を焼き込み、annuals のほかの年収でも新しい覚え（束の写し）で組み立てて、どれも同じことを確かめる。
 * 通らない物があれば fails（木はそれでも書き換える。呼ぶ側が書き出さない）
 */
export function bakeText(tree: DevTree, opts: { annuals?: readonly number[]; banks?: Banks; compose?: ComposeFn } = {}): BakeResult {
  const banks = opts.banks ?? BANKS;
  const compose = opts.compose ?? defaultCompose;
  const annual0 = tree.header.annual;
  const others = (opts.annuals ?? [360, 540]).filter((a) => a !== annual0);
  const nodes = devNodes(tree);
  const map = fromDevTree(tree);
  if (map.n !== nodes.length) throw new Error(`文章の焼き込み: 地図の枚数 ${map.n} が木の ${nodes.length} と違います`);
  const fails: string[] = [];
  const fail = (s: string) => {
    if (fails.length < LIMIT) fails.push(s);
    else if (fails.length === LIMIT) fails.push("（ほかにもある）");
  };
  const pick = (c: Card): Baked => ({ title: c.title, short: c.short, todo: c.todo.map((t) => ({ text: t.text, cite: t.cite })) });
  const ms: number[] = [];
  let t0 = performance.now();
  const baked: Baked[] = new Array<Baked>(map.n);
  for (let i = 0; i < map.n; i++) baked[i] = pick(compose(map, i, annual0, banks));
  ms.push(performance.now() - t0);
  // 年収で変わらない（年収ごとに新しい覚えで。題は兄弟ごとに覚えるので、年収で変わると組み立ての順で変わってしまう）
  for (const a of others) {
    t0 = performance.now();
    const fresh: Banks = { ...banks };
    let diff = 0;
    for (let i = 0; i < map.n; i++) {
      const c = pick(compose(map, i, a, fresh));
      const b = baked[i]!;
      const what = [c.title !== b.title ? "題" : "", c.short !== b.short ? "短い名前" : "", !sameTodo(c.todo, b.todo) ? "やること" : ""].filter(Boolean);
      if (what.length) {
        diff++;
        if (diff <= 5) fail(`TB2 ${what.join("・")}が年収で変わる（${annual0}「${b.title}」・${a}「${c.title}」）: ${map.key(i)}`);
      }
    }
    if (diff > 5) fail(`TB2 年収 ${a} 万円で題・短い名前・やることが変わるカードは全部で ${diff} 枚`);
    ms.push(performance.now() - t0);
  }
  // 形: 題はどれも空でない（空だと開発用の木の読み手 fromDevTree が仮の題を返し、同梱データの読み手と答えが違う）・やることは手だけ・文と元の番号は空でない
  const titles = new Set<string>();
  const shorts = new Set<string>();
  const todoTexts = new Set<string>();
  const cites = new Set<string>();
  let movesWithTodo = 0;
  let todoItems = 0;
  for (let i = 0; i < map.n; i++) {
    const b = baked[i]!;
    const n = nodes[i]!;
    if (n.k !== map.key(i)) throw new Error(`文章の焼き込み: ${i} 番の鍵 ${n.k} が地図の ${map.key(i)} と違います`);
    if (!b.title) fail(`TB2 題が空: ${n.k}`);
    if (b.todo.length && n.r !== "a") fail(`TB2 手でないカードにやること: ${n.k}`);
    for (const t of b.todo) if (!t.text || !t.cite) fail(`TB2 やることの文か元の番号が空: ${n.k}`);
    titles.add(b.title);
    shorts.add(b.short);
    if (b.todo.length) movesWithTodo++;
    todoItems += b.todo.length;
    for (const t of b.todo) {
      todoTexts.add(t.text);
      cites.add(t.cite);
    }
  }
  // 書き込む（子の並びは最後のまま）
  for (let i = 0; i < map.n; i++) {
    const n = nodes[i]!;
    const b = baked[i]!;
    const kids = n.kids;
    delete n.kids;
    delete n.title;
    delete n.short;
    delete n.todo;
    n.title = b.title;
    if (b.short) n.short = b.short;
    if (n.r === "a" && b.todo.length) n.todo = b.todo;
    if (kids) n.kids = kids;
  }
  tree.header.textVersion = banks.version;
  return { fails, cards: map.n, distinct: { title: titles.size, short: shorts.size, todo: todoTexts.size, cite: cites.size }, movesWithTodo, todoItems, ms, textVersion: banks.version };
}

/**
 * 読んだ地図（同梱データ）の題・短い名前・やることと入口の textVersion が、その地図をその場で組み立てた物（入口の年収・新しい覚え）と同じか。
 * アプリと試し版は同じ地図から本文をその場で組み立てるので、焼き込んだ題と、その場の組み立てが食い違わないことの点検（TB1）
 */
export function checkBaked(map: MapData, opts: { banks?: Banks; compose?: ComposeFn } = {}): string[] {
  const banks = opts.banks ?? BANKS;
  const compose = opts.compose ?? defaultCompose;
  const fails: string[] = [];
  if (map.header.textVersion !== banks.version) fails.push(`TB1 入口の文の型の版 ${map.header.textVersion} が文の型の束の版 ${banks.version} と違います`);
  const fresh: Banks = { ...banks };
  let diff = 0;
  for (let i = 0; i < map.n; i++) {
    const c = compose(map, i, map.header.annual, fresh);
    const todo = map.role(i) === "a" ? map.todo(i) : [];
    if (c.title !== map.title(i) || c.short !== map.short(i) || !sameTodo(c.todo, todo)) {
      diff++;
      if (diff <= 5) fails.push(`TB1 焼き込んだ文章がその場の組み立てと違う: ${map.key(i)}（「${map.title(i)}」・「${c.title}」）`);
    }
  }
  if (diff > 5) fails.push(`TB1 焼き込んだ文章がその場の組み立てと違うカードは全部で ${diff} 枚`);
  return fails;
}

export interface TextGate {
  /** 止める点検で見つかった物（runTextChecks の failures） */
  fails: string[];
  /** データの指摘（runTextChecks の warnings。止めない） */
  warns: string[];
  report: TextCheckReport;
  ms: number;
}

/** 文章の点検（年収 360・540。SPEC §4.6）を生成の点検にする。run は差し替えられる（テスト用） */
export function textGate(map: MapData, opts: TextCheckOpts = {}, run: (m: MapData, o: TextCheckOpts) => TextCheckReport = runTextChecks): TextGate {
  const t0 = performance.now();
  const report = run(map, { annuals: [360, 540], ...opts });
  return { fails: report.failures.map((f) => (f.startsWith("  ") ? f : `TC ${f}`)), warns: report.warnings, report, ms: performance.now() - t0 };
}

/** 文章の点検の短いまとめ（生成の報告の 1 行。年収ごとの点検の数・道の繰り返し・兄弟の題） */
export function textSummary(r: TextCheckReport): string {
  return r.runs
    .map((x) => {
      const n = (id: string) => x.checks.find((c) => c.id === id)?.n ?? 0;
      const blocking = x.checks.filter((c) => c.block).reduce((a, c) => a + c.n, 0);
      const warn = x.checks.filter((c) => !c.block).reduce((a, c) => a + c.n, 0);
      return `年収 ${x.annual}: 止める ${blocking}（C6 ${n("C6")}・C9 ${n("C9")}・T4 ${n("T4")}）・注意 ${warn}・道の繰り返し 最大 ${x.pathRepeats.dist.max}（門 ${r.gates.pathRepeats}）・兄弟の骨組みが同じ ${x.siblings.moveSame + x.siblings.outSame}・題が同じ兄弟 ${x.siblings.titleSame}・${(x.ms.compose / 1000).toFixed(1)} 秒`;
    })
    .join(" / ");
}
