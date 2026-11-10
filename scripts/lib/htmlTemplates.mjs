// HTML を組むテンプレートの見張り（Batch 88。scripts/test-text-safe.mjs の 7。docs/SECURITY.md）。
// js/*.js のテンプレート（`…`）のうち HTML のタグ（<a・</a・<!）を含む物の ${…} を見て、語・訳・名前・id の字
// （.ja・.en・.term・.label・.q・.explain・.name・.id・answerLabel(…)・裸の ja／en／label／wordId）が、
// esc／escapeHtml／numHtml を通らずに出る所を挙げる。
// 「出る所」は式の値になる部分だけ: 三項の条件・比べる式（真偽）・&& の左・関数の引数・入れ子のテンプレート（それ自体を別に見る）・
// *Html という名の関数の呼び出し（HTML を返す関数。中で守る。その関数のテンプレートも別に見る）は数えない。
// .map((w) => …) は戻りの式を見る（{ … } の本体なら return の式）。
// 字の解析は小さな字句の読み方（文字列・コメント・正規表現・入れ子の ${}）で、JS の全部の形は読まない。見落としを減らすため、
// 自信が無い式は「出る」とみなす（検査の側の許す一覧に理由つきで置く）。
// *Html の呼び出しを数えないのは、その関数が中で守るから。だから *Html という名の関数そのものも見る（scanHtmlParams。Batch 88 の反証）:
// 字の名前の引数（text・term・label・name・title・ja・en・q・explain・answer・word。{ text } のように分けて受けた物も）を、
// esc を通さずに HTML に出していれば挙げる（前は名前だけで信じたので、hasumiBubbleHtml が一言〔覚えた語の名前を含む〕をそのまま出していた）。

// テンプレートを集める: [{ line, quasis: [字...], exprs: [{ src, line }] }]（入れ子のテンプレートも 1 つずつ）
export function templates(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  let lastSig = ""; // 直前の意味のある字（/ が割り算か正規表現かの判定）
  let lastWord = "";
  const lineAt = (k) => {
    let line = 1;
    for (let p = 0; p < k; p++) if (src.charCodeAt(p) === 10) line++;
    return line;
  };
  const skipString = (q) => {
    i++;
    while (i < n && src[i] !== q) {
      if (src[i] === "\\") i++;
      i++;
    }
    i++;
  };
  const skipRegex = () => {
    i++;
    let cls = false;
    while (i < n) {
      const c = src[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "[") cls = true;
      else if (c === "]") cls = false;
      else if (c === "/" && !cls) {
        i++;
        break;
      } else if (c === "\n") break;
      i++;
    }
    while (i < n && /[a-z]/.test(src[i])) i++;
  };
  const readTemplate = () => {
    const t = { line: lineAt(i), start: i, end: -1, quasis: [], exprs: [] };
    i++;
    let text = "";
    while (i < n) {
      const c = src[i];
      if (c === "\\") {
        text += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === "`") {
        i++;
        break;
      }
      if (c === "$" && src[i + 1] === "{") {
        t.quasis.push(text);
        text = "";
        i += 2;
        const start = i;
        readCode(true);
        t.exprs.push({ src: src.slice(start, i), line: lineAt(start) });
        i++;
        continue;
      }
      text += c;
      i++;
    }
    t.quasis.push(text);
    t.end = i;
    out.push(t);
  };
  const KEYWORDS_BEFORE_REGEX = new Set(["return", "typeof", "case", "of", "in", "void", "delete", "throw", "new", "else", "do", "yield", "await"]);
  function readCode(inExpr) {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === "/" && src[i + 1] === "/") {
        while (i < n && src[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && src[i + 1] === "*") {
        const end = src.indexOf("*/", i + 2);
        i = end < 0 ? n : end + 2;
        continue;
      }
      if (c === "'" || c === '"') {
        skipString(c);
        lastSig = "a";
        lastWord = "";
        continue;
      }
      if (c === "`") {
        readTemplate();
        lastSig = "a";
        lastWord = "";
        continue;
      }
      if (c === "/" && (!lastSig || "(,=:[!&|?{};+-*%<>~^".includes(lastSig) || KEYWORDS_BEFORE_REGEX.has(lastWord))) {
        skipRegex();
        lastSig = "a";
        lastWord = "";
        continue;
      }
      if (c === "{") depth++;
      if (c === "}") {
        if (inExpr && depth === 0) return;
        depth--;
      }
      if (/\s/.test(c)) {
        i++;
        continue;
      }
      if (/[A-Za-z_$0-9]/.test(c)) {
        let w = "";
        while (i < n && /[A-Za-z_$0-9]/.test(src[i])) w += src[i++];
        lastWord = w;
        lastSig = "a";
        continue;
      }
      lastSig = c;
      lastWord = "";
      i++;
    }
  }
  readCode(false);
  return out;
}

// 式の中の文字列と入れ子のテンプレートを "" にする（入れ子のテンプレートは別に見る）
export function stripLiterals(expr) {
  let out = "";
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === "'" || c === '"') {
      i++;
      while (i < expr.length && expr[i] !== c) {
        if (expr[i] === "\\") i++;
        i++;
      }
      i++;
      out += '""';
      continue;
    }
    if (c === "`") {
      let depth = 0;
      i++;
      while (i < expr.length) {
        if (expr[i] === "\\") {
          i += 2;
          continue;
        }
        if (expr[i] === "$" && expr[i + 1] === "{") {
          depth++;
          i += 2;
          continue;
        }
        if (expr[i] === "}" && depth > 0) {
          depth--;
          i++;
          continue;
        }
        if (expr[i] === "`" && depth === 0) {
          i++;
          break;
        }
        i++;
      }
      out += '""';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function matchClose(s, open) {
  const close = { "(": ")", "[": "]", "{": "}" }[s[open]];
  let depth = 0;
  for (let k = open; k < s.length; k++) {
    if (s[k] === s[open]) depth++;
    else if (s[k] === close && --depth === 0) return k;
  }
  return s.length - 1;
}

// かっこの外（深さ 0）で re に合う最初の所
function topLevel(s, re) {
  const sticky = new RegExp(re.source, "y");
  let depth = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0) {
      sticky.lastIndex = k;
      const m = sticky.exec(s);
      if (m) return { at: k, len: m[0].length };
    }
  }
  return null;
}

const SAFE_CALL = /^(esc|escapeHtml|numHtml|\w+Html)$/;
const NOT_CALLS = new Set(["if", "for", "while", "switch", "return", "typeof", "function", "catch"]);

// 呼び出しを畳む: 守る関数と *Html の呼び出しは ""、.map は戻りの式だけ残す、ほかは f()（引数は出ない）
export function foldCalls(s) {
  let out = "";
  let k = 0;
  while (k < s.length) {
    const c = s[k];
    if (c === "(") {
      const close = matchClose(s, k);
      const inner = s.slice(k + 1, close);
      const m = out.match(/([A-Za-z_$][\w$]*)\s*$/);
      if (m && !NOT_CALLS.has(m[1])) {
        if (SAFE_CALL.test(m[1])) out = `${out.slice(0, out.length - m[0].length)}""`;
        else if (m[1] === "map" && /\.\s*map\s*$/.test(out)) {
          // .map(esc)・.map(escapeHtml): 中身はどれも守られる（並べた物ごと ""）
          if (SAFE_CALL.test(inner.trim())) out = out.replace(/[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*\s*\??\.\s*map\s*$/, '""');
          else out += `(${mapBody(inner)})`;
        }
        else out += "()";
      } else {
        out += `(${foldCalls(inner)})`;
      }
      k = close + 1;
      continue;
    }
    out += c;
    k++;
  }
  return out;
}

function mapBody(arg) {
  const arrow = topLevel(arg, /=>/);
  if (!arrow) return foldCalls(arg);
  let body = arg.slice(arrow.at + 2).trim();
  if (body.startsWith("{")) {
    const inner = body.slice(1, matchClose(body, 0));
    const returns = [];
    const re = /\breturn\b/g;
    let m;
    while ((m = re.exec(inner))) {
      const rest = inner.slice(m.index + 6);
      const semi = topLevel(rest, /;/);
      returns.push(rest.slice(0, semi ? semi.at : rest.length));
    }
    body = returns.join(" || ");
  }
  return foldCalls(body);
}

const RISKY = /\.(ja|en|term|label|q|explain|name|id)\b|\banswerLabel\(|(?<![.\w$])(ja|en|label|wordId)\b/;

// 畳んだ式の、値になる部分に危ない字があるか
export function risky(expr, leaf = RISKY) {
  let s = expr.trim();
  if (!s) return false;
  while (s.startsWith("(") && matchClose(s, 0) === s.length - 1) s = s.slice(1, -1).trim();
  const q = topLevel(s, /\?(?![.?])/);
  if (q) {
    let depth = 0;
    let nest = 0;
    for (let k = q.at + 1; k < s.length; k++) {
      const c = s[k];
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      else if (depth === 0 && c === "?" && s[k + 1] !== "." && s[k + 1] !== "?" && s[k - 1] !== "?") nest++;
      else if (depth === 0 && c === ":") {
        if (nest === 0) return risky(s.slice(q.at + 1, k), leaf) || risky(s.slice(k + 1), leaf);
        nest--;
      }
    }
  }
  const or = topLevel(s, /\|\||\?\?/);
  if (or) return risky(s.slice(0, or.at), leaf) || risky(s.slice(or.at + or.len), leaf);
  const and = topLevel(s, /&&/);
  if (and) return risky(s.slice(and.at + 2), leaf);
  if (s.startsWith("!") || topLevel(s, /===|!==|==|!=|<=|>=|<(?!=)|(?<!=)>(?!=)|(?<![\w$])(instanceof|in)(?![\w$])/)) return false;
  return leaf.test(s);
}

const HTMLISH = /<[a-zA-Z!/]/;

// 1 つのファイルの字から、守られずに HTML に出る式: [{ line, expr }]
export function scanHtmlTemplates(src) {
  const hits = [];
  let exprs = 0;
  for (const t of templates(src)) {
    if (!t.quasis.some((q) => HTMLISH.test(q))) continue;
    for (const e of t.exprs) {
      exprs++;
      if (risky(foldCalls(stripLiterals(e.src)))) hits.push({ line: e.line, expr: e.src.replace(/\s+/g, " ").trim() });
    }
  }
  return { hits, exprs };
}

// ----- *Html という名の関数の、字の名前の引数（Batch 88 の反証） -----
const TEXT_PARAMS = /^(text|term|label|name|title|ja|en|q|explain|answer|word)$/;
const HTML_FN = /\bfunction\s+([A-Za-z_$][\w$]*Html)\s*\(|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*Html)\s*=\s*(?:async\s+)?(?:function\s*)?\(/g;

// 引数の字（"a, { b, c = 1 }, d = \"x\""）→ 名前（既定の値は外す。分けて受けた物の中の名前も）
function paramNames(list) {
  const bare = list.replace(/=\s*("[^"]*"|'[^']*'|`[^`]*`|\[[^\]]*\]|[^,{}()]+)/g, "");
  return [...new Set(bare.match(/[A-Za-z_$][\w$]*/g) ?? [])];
}

// *Html という名の関数: [{ name, params, start, end }]（start〜end は本体の字の位置。式だけの矢印の関数は、その行の終わりまで）
export function htmlFunctions(src) {
  const out = [];
  const re = new RegExp(HTML_FN.source, "g");
  let m;
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(src, open);
    const params = paramNames(src.slice(open + 1, close));
    let k = close + 1;
    while (k < src.length && /\s/.test(src[k])) k++;
    if (src.startsWith("=>", k)) {
      k += 2;
      while (k < src.length && /\s/.test(src[k])) k++;
    }
    let start = k;
    let end;
    if (src[k] === "{") end = matchClose(src, k);
    else {
      start = k;
      end = src.indexOf("\n", k);
      if (end < 0) end = src.length;
    }
    out.push({ name: m[1] || m[2], params, start, end });
  }
  return out;
}

// 1 つのファイルの字から、*Html の関数が字の名前の引数を守らずに HTML に出す式: { hits: [{ line, fn, expr }], fns }
export function scanHtmlParams(src) {
  const hits = [];
  const fns = htmlFunctions(src);
  if (fns.length === 0) return { hits, fns: 0 };
  const tpls = templates(src);
  for (const f of fns) {
    const names = f.params.filter((p) => TEXT_PARAMS.test(p));
    if (names.length === 0) continue;
    const leaf = new RegExp(`(?<![.\\w$])(?:${names.join("|")})(?![\\w$]|\\s*\\()`);
    for (const t of tpls) {
      if (t.start < f.start || t.start > f.end || !t.quasis.some((q) => HTMLISH.test(q))) continue;
      for (const e of t.exprs) if (risky(foldCalls(stripLiterals(e.src)), leaf)) hits.push({ line: e.line, fn: f.name, expr: e.src.replace(/\s+/g, " ").trim() });
    }
  }
  return { hits, fns: fns.length };
}
