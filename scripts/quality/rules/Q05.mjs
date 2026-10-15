// Q05 判定の再現（docs/PACK_FORMAT.md「品質の規則と基準線」）: そのカードで正解になるはずのもの（出題語・主な読み・ほかの読み・データの別解・別解の索引の語・
// 漢字の別解をデータの中の読みで打ったもの）を、盤面と同じ判定器（js/judge.js）で頭から打ち切ると × になる（1 打ミス・Enter で答えが開く）。
// 判定器のシミュレーション（scripts/quality/sim-judge.mjs）の own の打つものを流し、× の件をカードごとに出す。
// 出題語・主な読み・ほかの読みは Enter なしで正解でないといけない。別解（綴り）は Enter で確定してもよい（advertisement の問いの ad）。
// 漢字の別解の読みは辞書を使わず、同じ字面を答えにするカードの主な読みで打つ（読みが分からない別解は数えない。規則 Q04 が見る）。
// 短い別表記（直列／直列回路）の読みは辞書でなら出せるが、CI には辞書を入れない（依存を増やさない）ので、データの中で読みが分かるものだけを数える
import { simulate, ownFailures } from "../sim-judge.mjs";
import * as judge from "../../../js/judge.js";

const HOW = { miss: (r) => `${r.at} 打目で ×${r.expected ? `（${r.expected} のところ）` : ""}`, reveal: (r) => `${r.at} 打を打ち切っても完成せず Enter で ×`, wrong: () => "違う答えとして ×" };
const INPUT = { answer: "出題語", reading: "読み", accept: "別解", alt: "別解の索引の語", kanjiAccept: "漢字の別解（データの中の読み）" };

export default {
  id: "Q05",
  level: "error",
  describe: "正答・読み・別解を判定器で打ち切ると × になる（js/judge.js で再現。漢字の別解はデータの中の読みで打つ）",
  run(ctx) {
    const { rows } = simulate(ctx, { judge, rivals: false });
    return ownFailures(rows).map((r) => ({
      card: r.ref,
      detail: `${INPUT[r.input] ?? r.input}${r.sub ? `・${r.sub}` : ""}「${r.text}」（${r.keys}）: ${(HOW[r.how] ?? (() => r.how))(r)}`
    }));
  }
};
