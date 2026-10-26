// ===== 線画アイコン（16px・1色・currentColor） =====
// UI ラベルに絵文字を使わない（docs/CONCEPT.md 原則5）。必要な所だけこの SVG を使う。
// 使い方: el.innerHTML = `${icon("speaker")} 発音`

const PATHS = {
  speaker: '<path d="M3 6h3l4-3v10l-4-3H3z"/><path d="M12 5.5a3.5 3.5 0 0 1 0 5"/>',
  check: '<path d="M3 8.5l3 3 7-7"/>',
  lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
  arrowRight: '<path d="M3 8h10"/><path d="M9 4l4 4-4 4"/>',
  arrowLeft: '<path d="M13 8H3"/><path d="M7 4L3 8l4 4"/>',
  book: '<path d="M2.5 3.5h4a2 2 0 0 1 1.5.7 2 2 0 0 1 1.5-.7h4v9h-4a2 2 0 0 0-1.5.7 2 2 0 0 0-1.5-.7h-4z"/><path d="M8 4.2v8.3"/>',
  note: '<path d="M4 2.5h6l3 3v8H4z"/><path d="M10 2.5v3h3"/><path d="M6 8h4M6 10.5h4"/>',
  spark: '<path d="M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3M4.2 4.2l2 2M9.8 9.8l2 2M4.2 11.8l2-2M9.8 6.2l2-2"/>',
  flame: '<path d="M8 2.5c.5 2 2.5 3 2.5 5.5a2.5 2.5 0 0 1-5 0c0-1 .5-1.7 1-2.2 0 .8.3 1.2.8 1.2C8 5.5 6.8 4 8 2.5z"/>',
  play: '<path d="M5 3.5v9l7-4.5z"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 3v3h-3"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  bulb: '<path d="M5.5 10.5a3.8 3.8 0 1 1 5 0v1.5h-5z"/><path d="M6.5 14h3"/>',
  star: '<path d="M8 2.5l1.7 3.6 3.9.5-2.9 2.7.8 3.9L8 11.3l-3.5 1.9.8-3.9L2.4 6.6l3.9-.5z"/>',
  trophy: '<path d="M5 3h6v3.5a3 3 0 0 1-6 0z"/><path d="M5 4H3v1.5a2 2 0 0 0 2 2M11 4h2v1.5a2 2 0 0 1-2 2"/><path d="M8 9.5v2.5M5.5 13h5"/>'
};

export function icon(name, { size = 16, className = "" } = {}) {
  const d = PATHS[name];
  if (!d) return "";
  return `<svg class="icon${className ? ` ${className}` : ""}" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${d}</svg>`;
}

export const ICONS = Object.keys(PATHS);
