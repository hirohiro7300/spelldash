// 分野パックの台帳同期。data/packs/*.json を読み、manifest.json のカテゴリに
// pack:true のエントリを追加・更新する（label / blurb / audience / count / group）。
//   node scripts/sync-packs.mjs
// group はここの表で決める（未登録の id は「その他」）。既存の並び順は保つ。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACK_DIR = path.join(ROOT, "data", "packs");
const MANIFEST = path.join(ROOT, "data", "manifest.json");

const GROUPS = {
  "文法（中学・高校・TOEIC）": ["grammar-jhs1", "grammar-jhs2", "grammar-jhs3", "grammar-hs1", "grammar-hs2", "grammar-toeic"],
  "試験・レベル別（英検・TOEIC）": ["eiken5", "eiken4", "eiken3", "eikenp2", "eiken2", "eikenp1", "eiken1", "toeic500", "toeic600", "toeic730", "toeic860", "toeic990"],
  "ビジネス・バックオフィス": ["accounting", "legal", "hr", "freelancetax", "staffing", "publicbid", "startupfinance", "banking", "insurance", "trade"],
  "営業・マーケティング": ["saas", "ec", "sns", "video", "callcenter", "webdev"],
  "IT・セキュリティ": ["programming", "itsupport", "security"],
  "医療・福祉・保育": ["medical", "nursing", "pharmacy", "care", "dental", "childcare"],
  "店舗・サービス": ["restaurant", "hotel", "apparel", "salon"],
  "建設・製造・物流": ["construction", "manufacturing", "logistics", "printing"],
  "不動産・自動車": ["realestate", "usedcar", "mechanic"]
};
const groupOf = (id) => Object.entries(GROUPS).find(([, ids]) => ids.includes(id))?.[0] ?? "その他";

// 表示順: グループ順 → グループ内の並び順
const ORDER = Object.values(GROUPS).flat();

const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const subject = manifest.subjects.find((s) => s.id === "english");
const base = subject.categories.filter((c) => !c.pack);
const existing = new Map(subject.categories.filter((c) => c.pack).map((c) => [c.id, c]));

const packs = fs
  .readdirSync(PACK_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(fs.readFileSync(path.join(PACK_DIR, f), "utf8")));

// cardType: "word"（英単語 en/ja のパック）は kind を付けない。それ以外は場面カード（concept）
const entries = packs.map((p) => ({
  id: p.category,
  label: p.label,
  file: `packs/${p.category}.json`,
  ...(p.cardType === "word" ? {} : { kind: "concept" }),
  pack: true,
  count: p.words.length,
  blurb: p.blurb,
  audience: p.audience,
  group: groupOf(p.category)
}));
entries.sort((a, b) => (ORDER.indexOf(a.id) + 1 || 999) - (ORDER.indexOf(b.id) + 1 || 999));

subject.categories = [...base, ...entries];
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");

const added = entries.filter((e) => !existing.has(e.id)).map((e) => e.id);
const changed = entries.filter((e) => existing.has(e.id) && existing.get(e.id).count !== e.count).map((e) => e.id);
console.log(`packs: ${entries.length} / cards: ${entries.reduce((n, e) => n + e.count, 0)}`);
if (added.length) console.log(`added: ${added.join(", ")}`);
if (changed.length) console.log(`count changed: ${changed.join(", ")}`);
