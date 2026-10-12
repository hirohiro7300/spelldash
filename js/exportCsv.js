import { getLearnedWordList, getKnownWordList, historyOf } from "./learnedWords.js";
import { getNote } from "./wordNotes.js";
import { getWordStats } from "./storage.js";
import { rankOf, RANK_NAMES } from "./mastery.js";

// ===== 覚えた単語帳のCSV書き出し =====
// 自分の資産として持ち出せるように（Excel/Numbers/Sheetsで開ける。BOM付きUTF-8）
// mastery 列 = 習熟度の段の名前（js/mastery.js。段 0 は空）。知ってた語の行にも入れる（docs/SPEC_MASTERY.md §5.9）

const masteryName = (stat) => RANK_NAMES[rankOf(stat)] ?? "";

function csvCell(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function buildLearnedCsv() {
  const header = ["english", "japanese", "category", "status", "mastery", "last_recalled", "history", "note"];
  const rows = [header];
  const statusLabel = { learning: "覚えた", mastered: "習得", known: "知ってた" };
  for (const w of getLearnedWordList()) {
    rows.push([
      w.en,
      w.ja,
      w.label,
      statusLabel[w.status] ?? w.status,
      masteryName(w.stat),
      w.stat.lastRecallSuccessAt ? w.stat.lastRecallSuccessAt.slice(0, 10) : "",
      historyOf(w.stat).map((h) => (h.r === "o" ? "o" : "x")).join(""),
      getNote(w.id)
    ]);
  }
  const stats = getWordStats();
  for (const w of getKnownWordList()) {
    rows.push([w.en, w.ja, "", statusLabel.known, masteryName(stats[w.id]), "", "", getNote(w.id)]);
  }
  return "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

export function downloadLearnedCsv() {
  const csv = buildLearnedCsv();
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const d = new Date();
  a.href = url;
  a.download = `spelldash-words-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return csv.split("\r\n").length - 1;
}
