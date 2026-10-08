// 本棚のデータ（taxonomy.md の棚・本・枚数）。
// 革の色は 3 系統（土色・藍・金）だけ: 胡桃 walnut／牛血 oxblood／コニャック cognac／藍 indigo／深い鉄紺 slate／鉄紺の布 cloth／仔牛皮紙 vellum
export const L = {
  walnut: "#2B1F17", oxblood: "#4A2320", cognac: "#5E361C", indigo: "#1E2436", slate: "#2C3550", cloth: "#3F4A6B", vellum: "#E2D3B4", umber: "#3A2A1E",
};
// b(t, s, opts): t=題, s=副題, n=枚数, u=単位, c=革, h=高さ, kind: leather|cloth|label|vellum
const b = (t, s, n, o = {}) => ({ t, s, n, u: o.u || "語", c: o.c || L.walnut, h: o.h || 128, kind: o.kind || "leather", ...o });

export const SHELVES = [
  { id: "course", name: "コース", idx: "コース", note: "順に読む巻もの", count: "4組", lang: "棚をまたぐ", type: "box", books: [
    { t: "中学英語", s: "やり直し", vols: 8, n: 770, c: L.indigo, label: "中学英語やり直し 全8巻（コース）、770語、答えは英語、読みかけ", reading: true },
    { t: "ビジネス英語", s: "社会人", vols: 8, n: 910, c: L.umber, label: "社会人ビジネス英語 全8巻（コース）、910語、答えは英語" },
    { t: "英会話", s: "日常・旅行の", vols: 4, n: 510, c: L.slate, label: "日常・旅行の英会話 全4巻（コース）、510語、答えは英語" },
    { t: "高校英語", s: "", vols: 6, n: 622, c: L.oxblood, label: "高校英語 全6巻（コース）、622語、答えは英語" },
  ] },
  { id: "eng", name: "英単語", idx: "英単語", count: "11冊", lang: "答えは英語", books: [
    b("小学英語", "", 120, { c: L.cognac, h: 118, w: 46 }),
    b("中学英語", "1年", 120, { c: L.indigo, h: 134, vol: "I", reading: true, full: "中学英語 1年（教科書レベル）" }),
    { slot: true, label: "中学英語 2年（教科書レベル）は机の上" },
    b("中学英語", "3年", 120, { c: L.indigo, h: 134, vol: "III", lean: true, full: "中学英語 3年（教科書レベル）" }),
    b("中学英語", "基本", 160, { c: L.walnut, h: 142, w: 52 }),
    b("高校英語", "基本", 160, { c: L.oxblood, h: 142, w: 52 }),
    b("日常英会話", "", 120, { c: L.cloth, h: 134, kind: "label", w: 46 }),
    b("旅行の英語", "", 130, { kind: "vellum", h: 124, w: 46 }),
    b("ビジネス", "英単語", 140, { c: L.slate, h: 130, full: "ビジネスの英単語" }),
    b("IT", "英単語", 140, { c: L.walnut, h: 118, lat: true, full: "ITの英単語" }),
    b("広告", "英単語", 101, { c: L.cognac, h: 126, w: 48, full: "広告の英単語" }),
  ] },
  { id: "exam", name: "試験", idx: "試験", count: "13冊", lang: "答えは英語", books: [
    ...["5", "4", "3", "準2", "2", "準1", "1"].map((g, i) => b(`英検${g}級`, "", 120, { c: L.oxblood, h: 142, eiken: g, vol: ["I", "II", "III", "IV", "V", "VI", "VII"][i] })),
    { bookend: true },
    ...["500", "600", "730", "860", "990"].map((sc) => b("TOEIC", sc, sc === "990" ? 121 : 120, { c: L.slate, h: 126, kind: "label", lat: true, full: `TOEIC ${sc}点` })),
    b("TOEIC", "頻出", 150, { c: L.walnut, h: 134, w: 52, lat: true, full: "TOEIC 頻出" }),
  ] },
  { id: "grammar", name: "文法・英作文", idx: "文法", count: "11冊", lang: "答えは英語・空欄と英文", books: [
    ...["1", "2", "3"].map((g, i) => b("中学英文法", `${g}年`, 70, { u: "枚", c: L.cognac, h: 138, vol: ["I", "II", "III"][i], full: `中学英文法 ${g}年` })),
    b("高校英文法", "基礎", 70, { u: "枚", c: L.indigo, h: 134, w: 48 }),
    b("高校英文法", "発展", 72, { u: "枚", c: L.indigo, h: 134, w: 48 }),
    b("TOEIC", "文法", 70, { u: "枚", c: L.slate, h: 118, lat: true, full: "TOEIC 文法（短文穴埋め）" }),
    { flat: [L.walnut, L.slate] },
    b("中学英語", "並べ替え", 100, { u: "枚", kind: "vellum", h: 122 }),
    b("中学英作文", "", 100, { u: "枚", c: L.walnut, h: 126, w: 52 }),
    b("高校英作文", "構文", 80, { u: "枚", c: L.oxblood, h: 132, full: "高校英作文（構文）" }),
    b("英検", "ライティング", 70, { u: "枚", c: L.cloth, h: 132, kind: "label", full: "英検ライティング 定型表現" }),
    b("英語面接", "定番フレーズ", 70, { u: "枚", c: L.umber, h: 124, full: "英語面接 定番フレーズ" }),
  ] },
  { id: "freq", name: "頻度順の全集", idx: "頻度順", count: "4組", lang: "答えは英語", type: "box", books: [
    { t: "基本英単語", s: "NGSL", vols: 24, n: 2857, c: L.indigo, w: 72, h: 160, label: "基本英単語 2,800語（NGSL）全24巻、2,857語、答えは英語" },
    { t: "TOEIC英単語", s: "TSL", vols: 11, n: 1247, c: L.slate, w: 72, h: 160, label: "TOEIC 英単語 1,250語（TSL）全11巻、1,247語、答えは英語" },
    { t: "ビジネス英単語", s: "BSL", vols: 15, n: 1753, c: L.umber, w: 72, h: 160, label: "ビジネス英単語 1,750語（BSL）全15巻、1,753語、答えは英語" },
    { t: "学術英単語", s: "NAWL", vols: 8, n: 957, c: L.oxblood, w: 72, h: 160, label: "学術英単語 960語（NAWL）全8巻、957語、答えは英語" },
  ] },
  { id: "social", name: "社会", idx: "社会", count: "14冊", lang: "答えは日本語・かな可", books: [
    b("小学歴史", "人物", 65, { u: "枚", c: L.cognac, h: 118, full: "小学 歴史の人物とできごと" }),
    b("都道府県", "", 60, { u: "枚", kind: "vellum", h: 118, w: 46, full: "都道府県と県庁所在地" }),
    b("中学地理", "日本", 60, { u: "枚", c: L.cloth, h: 124, kind: "label" }),
    b("中学地理", "世界", 60, { u: "枚", c: L.cloth, h: 124, kind: "label" }),
    b("中学歴史", "上巻", 75, { u: "枚", c: L.walnut, h: 132, reading: true, href: "book.html", full: "中学歴史 上巻 古代〜近世" }),
    b("中学歴史", "下巻", 75, { u: "枚", c: L.walnut, h: 132, full: "中学歴史 下巻 近現代" }),
    b("中学公民", "", 65, { u: "枚", c: L.indigo, h: 126, w: 48 }),
    { flat: [L.oxblood, L.cognac, L.umber] },
    b("高校日本史", "上巻", 80, { u: "枚", c: L.oxblood, h: 138, full: "高校日本史 上巻 原始〜近世" }),
    b("高校日本史", "下巻", 80, { u: "枚", c: L.oxblood, h: 138, full: "高校日本史 下巻 近現代" }),
    b("高校世界史", "上巻", 80, { u: "枚", c: L.slate, h: 138, full: "高校世界史 上巻 古代〜近世" }),
    b("高校世界史", "下巻", 80, { u: "枚", c: L.slate, h: 138, full: "高校世界史 下巻 近代〜現代" }),
    b("高校地理", "総合・探究", 70, { u: "枚", c: L.cognac, h: 126, w: 52, full: "高校 地理総合・探究" }),
    b("政治・経済", "高校", 70, { u: "枚", c: L.indigo, h: 128, full: "高校 政治・経済" }),
    b("高校倫理", "", 65, { u: "枚", kind: "vellum", h: 122, full: "高校 倫理" }),
  ] },
  { id: "science", name: "理科・数学", idx: "理科", count: "9冊", lang: "答えは日本語・かな可", books: [
    b("小学理科", "", 65, { u: "枚", c: L.cognac, h: 118, full: "小学 理科の用語" }),
    b("中学理科", "物理・化学", 65, { u: "枚", c: L.indigo, h: 128 }),
    b("中学理科", "生物・地学", 65, { u: "枚", c: L.indigo, h: 128 }),
    ...["物理", "化学", "生物", "地学"].map((k) => b(`${k}基礎`, "高校", 65, { u: "枚", c: L.cloth, h: 132, kind: "label", full: `高校 ${k}基礎` })),
    { bookend: true },
    b("小学算数", "用語", 60, { u: "枚", kind: "vellum", h: 116, full: "小学 算数の用語" }),
    b("中学数学", "用語と定理", 60, { u: "枚", c: L.walnut, h: 126, w: 48, full: "中学数学 用語と定理" }),
  ] },
  { id: "kokugo", name: "国語・漢字", idx: "国語", count: "6冊", lang: "答えは日本語・一部は漢字で", books: [
    b("漢字の読み", "小学5・6年", 80, { u: "枚", c: L.oxblood, h: 128, full: "小学 漢字の読み（5・6年）", tcySub: true }),
    b("漢字の読み", "中学", 80, { u: "枚", c: L.oxblood, h: 132, full: "国語 漢字の読み（中学）、一部は漢字で答える" }),
    b("四字熟語", "ことわざ", 75, { u: "枚", c: L.walnut, h: 136, full: "四字熟語・ことわざ・慣用句" }),
    b("現代文", "キーワード", 70, { u: "枚", c: L.indigo, h: 124, full: "高校 現代文 キーワード" }),
    b("古文単語", "", 100, { u: "枚", c: L.cognac, h: 134, w: 52, full: "高校 古文単語" }),
    b("漢文", "句法と重要語", 65, { u: "枚", kind: "vellum", h: 124, full: "高校 漢文 句法と重要語、一部は漢字で答える" }),
    { flat: [L.slate, L.cognac, L.walnut] },
  ] },
];
