// キャンバスの文字の折り返し（日本語は 1 文字ずつ、英数は単語でなるべく切る）。結果はキャッシュする

export const CANVAS_FONT = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic UI", Meiryo, sans-serif';

const cache = new Map<string, string[]>();
const NO_LINE_START = /[、。，．・：；？！）」』】〕ー〜…,.!?)\]]/;

function measure(ctx: CanvasRenderingContext2D, s: string): number {
  return ctx.measureText(s).width;
}

/** ctx.font は呼ぶ側で設定しておく（font も鍵に入れる） */
export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const key = `${ctx.font}|${maxWidth}|${maxLines}|${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  const lines: string[] = [];
  let line = "";
  let i = 0;
  for (; i < chars.length; i++) {
    const ch = chars[i]!;
    const test = line + ch;
    if (line === "" || measure(ctx, test) <= maxWidth) {
      line = test;
      continue;
    }
    if (NO_LINE_START.test(ch) && measure(ctx, test) <= maxWidth * 1.06) {
      line = test;
      continue;
    }
    let carry = ch;
    if (/[A-Za-z0-9]/.test(ch)) {
      const sp = line.lastIndexOf(" ");
      if (sp > 0 && line.length - sp <= 14) {
        carry = line.slice(sp + 1) + ch;
        line = line.slice(0, sp);
      }
    }
    lines.push(line);
    line = carry.trimStart();
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines) {
    if (line) lines.push(line);
  } else {
    // 入りきらない: 最後の行を「…」で切る
    let last = lines[maxLines - 1]!;
    while (last.length > 0 && measure(ctx, `${last}…`) > maxWidth) last = Array.from(last).slice(0, -1).join("");
    lines[maxLines - 1] = `${last}…`;
  }
  if (cache.size > 6000) cache.clear();
  cache.set(key, lines);
  return lines;
}

/** 1 行に収める（はみ出したら「…」） */
export function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  return wrapText(ctx, text, maxWidth, 1)[0] ?? "";
}
