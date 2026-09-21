// 「訳が紛らわしいか」の判定だけを切り出したもの（出題側から使い、単体で試せるようにする）。
//
// 同じカテゴリに「始める（start）」と「始める（begin）」があると、訳だけでは
// どちらを打てばよいか決まらない。完全一致だけでなく、「義務を負わせる」と
// 「義務づける」のようなほぼ同じ訳も拾う必要がある。

// 訳を「・」「、」「／」「,」で区切ったもの
export function jaTokens(ja) {
  return String(ja ?? "")
    .split(/[・、／,]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

// かっこ書きと活用語尾を落とした語幹
export function jaCore(token) {
  return String(token ?? "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/(させる|られる|する|した|れる|な|の|い)$/u, "")
    .trim();
}

// 2つの訳が「学習者にはどちらか決められない」ほど近いか。
// 語幹が3文字以上で、片方がもう片方を含むときに近いとみなす（短い語幹は偶然当たるので見ない）。
export function jaLooksSame(aJa, bJa) {
  const a = jaTokens(aJa);
  const b = jaTokens(bJa);
  if (a.length === 0 || b.length === 0) return false;
  const bSet = new Set(b);
  if (a.some((t) => bSet.has(t))) return true;
  const aCores = a.map(jaCore).filter((c) => c.length >= 3);
  const bCores = b.map(jaCore).filter((c) => c.length >= 3);
  return aCores.some((c) => bCores.some((t) => c === t || c.includes(t) || t.includes(c)));
}
