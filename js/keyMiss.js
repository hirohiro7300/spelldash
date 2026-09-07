// ===== よく間違えるキー =====
// 打ち間違いを「どの文字で」「何と打ち間違えたか」で数える（タイピング側の成長の材料）。
// 端末ローカル（spelldash_key_miss）。装飾データなので失っても学習に影響しない。

const KEY = "spelldash_key_miss";

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { letters: raw.letters ?? {}, pairs: raw.pairs ?? {}, total: raw.total ?? 0 };
  } catch {
    return { letters: {}, pairs: {}, total: 0 };
  }
}

export function recordKeyMiss(expected, typed) {
  if (!expected || !/^[a-z]$/.test(expected)) return;
  try {
    const data = load();
    data.letters[expected] = (data.letters[expected] ?? 0) + 1;
    if (typed && /^[a-z]$/.test(typed) && typed !== expected) {
      const pair = `${expected}>${typed}`;
      data.pairs[pair] = (data.pairs[pair] ?? 0) + 1;
    }
    data.total += 1;
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // 計測はゲームを止めない
  }
}

export function getKeyMissSummary(limit = 5) {
  const data = load();
  const letters = Object.entries(data.letters)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([letter, count]) => ({ letter, count }));
  const pairs = Object.entries(data.pairs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([pair, count]) => {
      const [expected, typed] = pair.split(">");
      return { expected, typed, count };
    });
  return { total: data.total, letters, pairs, all: data.letters };
}

// キーボード配列のヒートマップ（3段）。文字ごとにミス回数で濃さを変える
const ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];

export function renderKeyMiss(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const s = getKeyMissSummary();
  if (s.total === 0) {
    el.innerHTML = '<p class="muted">打ち間違いのデータはまだありません。プレイすると、よく間違える文字がここに出ます。</p>';
    return;
  }
  const max = Math.max(1, ...Object.values(s.all));
  const keyboard = ROWS.map(
    (row) =>
      `<div class="keymap__row">${[...row]
        .map((ch) => {
          const n = s.all[ch] ?? 0;
          const level = n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4));
          return `<span class="keymap__key keymap__key--${level}" title="${ch}: ${n}回">${ch}</span>`;
        })
        .join("")}</div>`
  ).join("");
  const top = s.letters.map((l) => `<b>${l.letter}</b> ${l.count}回`).join(" ・ ");
  const pairs = s.pairs.length
    ? `<p class="keymiss__pairs">打ち間違えの型: ${s.pairs.map((p) => `<span>${p.expected}→${p.typed} ${p.count}回</span>`).join(" ")}</p>`
    : "";
  el.innerHTML = `
    <p class="keymiss__top">よく間違える文字: ${top}</p>
    <div class="keymap" aria-label="ミスタイプの分布">${keyboard}</div>
    ${pairs}
  `;
}
