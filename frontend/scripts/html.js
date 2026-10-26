// ===== HTML 文字列を組むときの小さな道具（道・初回・本棚・例文で共通） =====
//
// esc(s)     … 文字列を HTML に入れる（& < > " を実体に。属性値にも使えるように " も）
// numHtml(s) … esc したうえで、数字を Cormorant の別名（<span class="n">）で組む。textContent は変わらない（E2E の includes はそのまま）

export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const numHtml = (s) => esc(s).replace(/\d+/g, '<span class="n">$&</span>');
