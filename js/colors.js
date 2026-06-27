export const letterColors = {
  a: "#ef4444",
  b: "#f97316",
  c: "#f59e0b",
  d: "#eab308",
  e: "#84cc16",
  f: "#22c55e",
  g: "#10b981",
  h: "#14b8a6",
  i: "#06b6d4",
  j: "#0ea5e9",
  k: "#3b82f6",
  l: "#6366f1",
  m: "#8b5cf6",
  n: "#a855f7",
  o: "#d946ef",
  p: "#ec4899",
  q: "#f43f5e",
  r: "#fb7185",
  s: "#fdba74",
  t: "#fde047",
  u: "#bef264",
  v: "#86efac",
  w: "#67e8f9",
  x: "#93c5fd",
  y: "#c4b5fd",
  z: "#f0abfc"
};

export function renderColoredWord(word) {
  return word
    .split("")
    .map((letter) => {
      const color = letterColors[letter.toLowerCase()] || "#facc15";
      return `<span style="color: ${color};">${letter}</span>`;
    })
    .join("");
}