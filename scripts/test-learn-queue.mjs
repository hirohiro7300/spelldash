// 中心の学習の 3 つのモード（これから・あやふや・覚えた）の出題の列と回の区切り（js/learnQueue.js）の単体テスト。ブラウザなし（1 秒未満）:
//   node scripts/test-learn-queue.mjs [<木の根>]
// 失敗が 1 つでもあれば終了コード 1。決まりは js/learnQueue.js の頭の注・docs/SPEC_LEARN_STATE.md §11（創業者の決定 §4・PRESTART「出題の順」「あやふやの出し方」）。
// 木の根を渡すと、その木の js/ を読む（変異の確かめ: 写した木の js を壊して流すと落ちる）。公開の語は data/public/english.json（本物の 2,857 語）
process.env.TZ = "Asia/Tokyo";

import fs from "fs";
import path from "path";
import { isDeepStrictEqual } from "util";
import { fileURLToPath, pathToFileURL } from "url";

const ROOT = path.resolve(process.argv.slice(2).find((a) => !a.startsWith("--")) ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const modUrl = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

let passed = 0;
const failures = [];
function eq(name, actual, expected) {
  if (isDeepStrictEqual(actual, expected)) passed++;
  else failures.push(`${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}
const ok = (name, cond) => eq(name, !!cond, true);

const Q = await import(modUrl("js/learnQueue.js"));
const L = await import(modUrl("js/learnState.js"));
const { makePublicVocab } = await import(modUrl("js/publicVocab.js"));
const vocab = makePublicVocab(JSON.parse(fs.readFileSync(path.join(ROOT, "data/public/english.json"), "utf8")));

// 決まった乱数（同じ種なら同じ表）
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const TODAY = L.learnDayOf(Date.parse("2026-10-27T12:00:00+09:00"));
const NOW = Date.parse("2026-10-27T12:00:00+09:00");
const base = { playCount: 1, correctCount: 1, missCount: 0, recallFail: 0, lastPlayed: "2026-10-20T00:00:00.000Z" };

// 公開の語ぜんぶに状態を振った表（あやふやの数えた日は 無い・昨日・今日・明日、lsAt は 無い・ばらばら・同じ）。非公開の語も混ぜる
function randomTable(seed) {
  const r = rng(seed);
  const t = {};
  for (const id of vocab.order) {
    const x = r();
    if (x < 0.35) continue; // 記録なし（これから）
    if (x < 0.45) {
      t[id] = { ...base }; // 記録はあるが欄なし（これから: 版 7 では欄が無い = これから）
      continue;
    }
    const s = { ...base, ls: x < 0.75 ? L.LEARN_UNSURE : L.LEARN_LEARNED };
    const y = r();
    if (s.ls === L.LEARN_UNSURE && y < 0.25) s.lsd = TODAY - 1 - Math.floor(r() * 5);
    else if (s.ls === L.LEARN_UNSURE && y < 0.45) s.lsd = TODAY;
    else if (s.ls === L.LEARN_UNSURE && y < 0.5) s.lsd = TODAY + 1;
    const z = r();
    if (z < 0.6) s.lsAt = NOW - Math.floor(r() * 20) * 86400000;
    else if (z < 0.8) s.lsAt = NOW - 5 * 86400000; // 同じ時刻（並びは公開の並びで決まる）
    t[id] = s;
  }
  t["concept-ad-cpc"] = { ...base, ls: L.LEARN_UNSURE };
  t["my-river"] = { ...base, ls: L.LEARN_LEARNED };
  return t;
}

// ===== 入口の値 =====
eq("入口: new・unsure・learned だけ（前後の空白は落とす）", ["new", "unsure", " learned ", "x", "", null, undefined, "__proto__", "constructor", "toString", "NEW"].map(Q.parseLearnMode), ["new", "unsure", "learned", null, null, null, null, null, null, null, null]);
eq("1 セットの語数: これから 10・あやふや 30・覚えた 10。区切りは 10 語ごと", [Q.LEARN_SET_SIZE.new, Q.LEARN_SET_SIZE.unsure, Q.LEARN_SET_SIZE.learned, Q.LEARN_BREAK_EVERY], [10, 30, 10, 10]);

// ===== 排他性: どの列もその状態の語だけ。あやふやは今日の分だけ =====
for (const seed of [1, 2, 3]) {
  const t = randomTable(seed);
  const qs = Object.fromEntries(["new", "unsure", "learned"].map((m) => [m, Q.buildLearnQueue(m, t, vocab, TODAY)]));
  const c = L.countLearnStates(t, vocab);
  ok(`排他 ${seed}: これからの列はどれも状態なし`, qs.new.every((id) => L.learnStateOf(t[id]) === L.LEARN_NEW));
  ok(`排他 ${seed}: あやふやの列はどれも あやふや`, qs.unsure.every((id) => t[id]?.ls === L.LEARN_UNSURE));
  ok(`排他 ${seed}: 覚えたの列はどれも 覚えた`, qs.learned.every((id) => t[id]?.ls === L.LEARN_LEARNED));
  const all = [...qs.new, ...qs.unsure, ...qs.learned];
  eq(`排他 ${seed}: 3 つの列は重ならない・公開の語だけ`, [new Set(all).size === all.length, all.every(vocab.isPublic)], [true, true]);
  eq(`排他 ${seed}: これから・覚えたの列の長さは 3 状態の数と同じ（制限しない）`, [qs.new.length, qs.learned.length], [c.new, c.learned]);
  const portion = vocab.order.filter((id) => t[id]?.ls === L.LEARN_UNSURE && !(Number.isInteger(t[id].lsd) && t[id].lsd >= TODAY));
  eq(`排他 ${seed}: あやふやの列 = 今日の分（数えた日が無いか今日より前。あやふやの語そのものは制限しない）`, [...qs.unsure].sort(), [...portion].sort());
  ok(`排他 ${seed}: 今日の分は あやふや の数より少ない（今日・明日を数えた語を除く）`, qs.unsure.length < c.unsure && qs.unsure.length > 30);
  eq(`排他 ${seed}: これからは公開の並びのまま`, qs.new, vocab.order.filter((id) => qs.new.includes(id)));
  for (const m of ["unsure", "learned"]) {
    const keys = qs[m].map((id) => [Number.isFinite(t[id].lsAt) ? t[id].lsAt : 0, vocab.positionOf(id)]);
    ok(`並び ${seed} ${m}: 最後に答えた時刻（無ければ 0）の古い順、同じなら公開の並び`, keys.every((k, i) => i === 0 || keys[i - 1][0] < k[0] || (keys[i - 1][0] === k[0] && keys[i - 1][1] < k[1])));
  }
}

// ===== 決定的: 同じ保存なら同じ列（鍵の順・JSON の往復・作り直しで変わらない） =====
{
  const t = randomTable(7);
  const shuffled = Object.fromEntries(Object.entries(t).reverse());
  const round = JSON.parse(JSON.stringify(t));
  for (const m of ["new", "unsure", "learned"]) {
    const a = Q.buildLearnQueue(m, t, vocab, TODAY);
    eq(`決定的 ${m}: 2 回作っても・鍵の順を逆にしても・JSON を往復しても同じ列`, [Q.buildLearnQueue(m, t, vocab, TODAY), Q.buildLearnQueue(m, shuffled, vocab, TODAY), Q.buildLearnQueue(m, round, vocab, TODAY)], [a, a, a]);
  }
  eq("決定的: 記録の無い端末のこれからの列 = 公開の並び（頭は数・曜日・月の補助の語）", Q.buildLearnQueue("new", {}, vocab, TODAY).slice(0, 3), vocab.order.slice(0, 3));
  eq("決定的: 記録の無い端末のあやふや・覚えたの列は空", [Q.buildLearnQueue("unsure", {}, vocab, TODAY), Q.buildLearnQueue("learned", null, vocab, TODAY)], [[], []]);
}

// ===== あやふやの数えた日: 無い・今日より前は出す、今日・今日より後（時計が戻った）は出さない =====
{
  const [a, b, c, d, e] = vocab.order.slice(100, 105);
  const t = {
    [a]: { ...base, ls: 1 },
    [b]: { ...base, ls: 1, lsd: TODAY - 1 },
    [c]: { ...base, ls: 1, lsd: TODAY },
    [d]: { ...base, ls: 1, lsd: TODAY + 1 },
    [e]: { ...base, ls: 1, lsd: "x" } // 読めない日は数えていない扱い
  };
  eq("あやふや: 数えた日が無い・昨日・読めない語は出す。今日・明日の語は出さない", Q.buildLearnQueue("unsure", t, vocab, TODAY), [a, b, e]);
  eq("あやふや: 今日が読めない時刻なら、数えた日のある語は出さない", Q.buildLearnQueue("unsure", t, vocab, null), [a, e]);
  ok("あやふや: 欄に書いた 覚えた の語に lsd が残っていても 覚えた の列（あやふやの列に入らない）", Q.isLearnTarget("learned", { ls: 2, lsd: TODAY - 3 }, undefined, TODAY) && !Q.isLearnTarget("unsure", { ls: 2, lsd: TODAY - 3 }, undefined, TODAY));
}

// ===== 版 6 の間（移行が書けていない端末）: 欄の無い語は pending の状態で読む =====
{
  const [a, b, c] = vocab.order.slice(200, 203);
  const t = { [a]: { ...base }, [b]: { ...base }, [c]: { ...base, ls: 1 } };
  const pending = new Map([[a, 2], [b, 1]]);
  eq("版 6: pending の 覚えた・あやふや は その列、欄のある語は欄の値", [Q.buildLearnQueue("learned", t, vocab, TODAY, pending), Q.buildLearnQueue("unsure", t, vocab, TODAY, pending)], [[a], [b, c]]);
  ok("版 6: pending の語はこれからの列に入らない", !Q.buildLearnQueue("new", t, vocab, TODAY, pending).some((id) => id === a || id === b));
  // 欄（ls）が無く数えた日（lsd）だけが残った語: 数えた日は欄に書いた あやふや のときだけ読む（pending の あやふや は今日の分・今日を 1 日目に数えない）
  const d = vocab.order[203];
  const td = { [d]: { ...base, lsd: TODAY } };
  const pd = new Map([[d, L.LEARN_UNSURE]]);
  ok("版 6: ls が無く lsd が今日の語（pending は あやふや）は今日の分に入る", Q.isLearnTarget("unsure", td[d], L.LEARN_UNSURE, TODAY) && Q.buildLearnQueue("unsure", td, vocab, TODAY, pd).includes(d));
  eq("版 6: ls が無く lsd が今日の語は、回の結果で今日を 1 日目に数えない（あやふや 1・1 日目 0）", Q.learnSummary([d], td, pd, TODAY), { learned: 0, unsure: 1, dayOne: 0 });
}

// ===== 回の進み: 答えた語は二度出さない・順が来たとき対象でない語は飛ばす・開き直しても同じ次の語 =====
{
  // 回を書き手の決まり（js/learnState.js applyLearnAnswer）で流す。answers = 1 問ごとの種類（自力正解 exact か × miss）
  function play(mode, table, answers, { from = 0, answered = new Set() } = {}) {
    const t = { ...table };
    const queue = Q.buildLearnQueue(mode, t, vocab, TODAY);
    const target = (id) => Q.isLearnTarget(mode, t[id], undefined, TODAY);
    const asked = [];
    let cursor = from;
    for (const kind of answers) {
      const i = Q.nextLearnIndex(queue, cursor, answered, target);
      if (i < 0) break;
      const id = queue[i];
      asked.push(id);
      t[id] = L.applyLearnAnswer(t[id] ?? { ...base }, kind, NOW + asked.length * 1000);
      answered.add(id);
      cursor = i + 1;
    }
    return { asked, table: t, answered, queue };
  }
  const tbl = randomTable(11);
  for (const m of ["new", "unsure", "learned"]) {
    const kinds = Array.from({ length: 25 }, (_, i) => (i % 3 === 0 ? "miss" : "exact"));
    const r = play(m, tbl, kinds);
    eq(`回 ${m}: 25 問で同じ語は二度出ない`, new Set(r.asked).size, r.asked.length);
    ok(`回 ${m}: 出した語はどれも回の始めにそのモードの対象`, r.asked.every((id) => Q.isLearnTarget(m, tbl[id], undefined, TODAY)));
    // 開き直し: 保存（答えた後の表）から列を作り直し、答えた語を除くと、続きの語は回の続きと同じ
    const head = play(m, tbl, kinds.slice(0, 7));
    const reload = Q.buildLearnQueue(m, head.table, vocab, TODAY).filter((id) => !head.answered.has(id));
    const rest = play(m, tbl, kinds).asked.slice(7, 12);
    eq(`回 ${m}: 7 問で開き直しても、次の 5 語は同じ（入れ替わらない）`, reload.slice(0, 5), rest);
  }
  // × の あやふや の語は、回の中ではもう出ないが、次の回では今日の分に戻る（数えた日が消える・最後に答えた時刻は今なので後ろ）
  {
    const t = randomTable(12);
    const r = play("unsure", t, ["miss", "exact"]);
    const next = Q.buildLearnQueue("unsure", r.table, vocab, TODAY);
    eq("あやふや: × の語は次の回の今日の分の最後・自力正解の語（今日を 1 日目）は今日の分から外れる", [next.at(-1), next.includes(r.asked[1])], [r.asked[0], false]);
  }
  // ほかのタブで答えた語（状態が変わった）は、順が来たときに飛ばす
  {
    const t = randomTable(13);
    const queue = Q.buildLearnQueue("new", t, vocab, TODAY);
    const live = { ...t, [queue[1]]: { ...base, ls: 1 } };
    const target = (id) => Q.isLearnTarget("new", live[id], undefined, TODAY);
    eq("飛ばす: 2 番目の語がほかのタブで あやふや になったら、1 番目の次は 3 番目", Q.nextLearnIndex(queue, 1, new Set([queue[0]]), target), 2);
    const tu = randomTable(14);
    const qu = Q.buildLearnQueue("unsure", tu, vocab, TODAY);
    const liveU = { ...tu, [qu[0]]: { ...tu[qu[0]], lsd: TODAY } };
    eq("飛ばす: あやふやの頭の語がほかのタブで今日を数えたら、頭は 2 番目", Q.nextLearnIndex(qu, 0, new Set(), (id) => Q.isLearnTarget("unsure", liveU[id], undefined, TODAY)), 1);
    eq("飛ばす: 出せる語が無ければ -1", Q.nextLearnIndex(queue, queue.length, new Set(), () => true), -1);
    eq("二度出さない: 列の頭から探しても、答えた語（× で今も対象の語）は飛ばす", Q.nextLearnIndex(queue, 0, new Set([queue[0], queue[1]]), () => true), 2);
  }
  // これからは最後に答えた時刻を見ない（状態の欄の無い語に lsAt だけがある、ふつうは無い形でも公開の並び）
  {
    const [a, b, c] = vocab.order.slice(40, 43);
    eq("これから: lsAt を見ない（公開の並び）", Q.buildLearnQueue("new", { [a]: { ...base, lsAt: NOW }, [b]: { ...base, lsAt: 5 } }, vocab, TODAY).slice(40, 43), [a, b, c]);
  }
}

// ===== 区切り: あやふやは 10・20 語で区切り（続けるを選んだら同じ所で出さない）、30 語でセットの終わり、今日の分が 0 で終わり =====
{
  const step = (mode, setAnswered, more = true, ackBreak = -1) => Q.learnStep(mode, { setAnswered, more, ackBreak });
  eq("区切り あやふや: 0〜9 語は出す・10 語で区切り・続ける の後は出す・20 語で区切り・30 語でセットの終わり",
    [step("unsure", 0), step("unsure", 9), step("unsure", 10), step("unsure", 10, true, 10), step("unsure", 11, true, 10), step("unsure", 20, true, 10), step("unsure", 29, true, 20), step("unsure", 30, true, 20)],
    ["play", "play", "break", "play", "play", "break", "play", "set"]);
  eq("区切り あやふや: 今日の分が尽きたら区切り・セットの途中でも終わり（今日の分は終わり）", [step("unsure", 10, false), step("unsure", 30, false), step("unsure", 0, false), step("unsure", 17, false)], ["done", "done", "done", "done"]);
  eq("区切り これから・覚えた: 区切りは無く、10 語でセットの終わり（残りがあれば続けて学ぶ）・尽きたら終わり",
    [step("new", 9), step("new", 10), step("new", 10, false), step("new", 5, false), step("learned", 10), step("learned", 3, false)],
    ["play", "set", "done", "done", "set", "done"]);

  // 75 語の今日の分を通しで: 区切り 10・20 → 30 で続けて学ぶ → 次のセットの 10・20 → 30 で続けて学ぶ → 15 語で今日の分は終わり
  const t = {};
  vocab.order.slice(300, 375).forEach((id, i) => (t[id] = { ...base, ls: 1, lsAt: NOW - 100000 + i }));
  const queue = Q.buildLearnQueue("unsure", t, vocab, TODAY);
  const answered = new Set();
  const live = { ...t };
  const events = [];
  let setAnswered = 0;
  let ackBreak = -1;
  let cursor = 0;
  for (let guard = 0; guard < 200; guard++) {
    const i = Q.nextLearnIndex(queue, cursor, answered, (id) => Q.isLearnTarget("unsure", live[id], undefined, TODAY));
    const s = Q.learnStep("unsure", { setAnswered, ackBreak, more: i >= 0 });
    if (s === "break") {
      events.push(`break@${answered.size}`);
      ackBreak = setAnswered;
      continue;
    }
    if (s === "set") {
      events.push(`set@${answered.size}`);
      setAnswered = 0; // 続けて学ぶ（次のセット）
      ackBreak = -1;
      continue;
    }
    if (s === "done") {
      events.push(`done@${answered.size}`);
      break;
    }
    const id = queue[i];
    live[id] = L.applyLearnAnswer(live[id], "exact", NOW + answered.size);
    answered.add(id);
    setAnswered++;
    cursor = i + 1;
  }
  eq("通し 75 語: 区切り 10・20、30 で続けて学ぶ、40・50、60 で続けて学ぶ、70、75 で今日の分は終わり", events, ["break@10", "break@20", "set@30", "break@40", "break@50", "set@60", "break@70", "done@75"]);
  ok("通し 75 語: どれも今日を 1 日目に数えた（あやふやのまま・同じ日に二度は出さない）", [...answered].every((id) => live[id].ls === 1 && live[id].lsd === TODAY) && Q.buildLearnQueue("unsure", live, vocab, TODAY).length === 0);
  // 翌日は 75 語ぜんぶが今日の分に戻り、自力正解で 覚えた（別の日の 2 回目）
  const tomorrow = Q.buildLearnQueue("unsure", live, vocab, TODAY + 1);
  eq("翌日: 75 語が今日の分（最後に答えた順）・自力正解で 覚えた", [tomorrow.length, tomorrow[0], L.applyLearnAnswer(live[tomorrow[0]], "exact", NOW + 86400000).ls], [75, queue[0], L.LEARN_LEARNED]);
}

// ===== 覚えたの復習: 答えるたびに後ろへ回る（毎回同じ 10 語にならない）。× は あやふや へ（列から外れる） =====
{
  const t = {};
  vocab.order.slice(500, 530).forEach((id) => (t[id] = { ...base, ls: 2 })); // lsAt なし（移行した 覚えた）: 公開の並び
  const first = Q.buildLearnQueue("learned", t, vocab, TODAY).slice(0, 10);
  eq("覚えた: lsAt の無い語は公開の並びの頭から 10 語", first, vocab.order.slice(500, 510));
  const after = { ...t };
  first.forEach((id, i) => (after[id] = L.applyLearnAnswer(after[id], i === 0 ? "reveal" : "exact", NOW + i)));
  const second = Q.buildLearnQueue("learned", after, vocab, TODAY);
  eq("覚えた: 次の回は答えていない 20 語が先、答えた 9 語が最後に答えた順で後ろ、答え表示の語は あやふや（列に無い）",
    [second.slice(0, 20), second.slice(20), after[first[0]].ls], [vocab.order.slice(510, 530), first.slice(1), L.LEARN_UNSURE]);
}

// ===== 答えの種類（自力正解かどうかは js/learnState.js isCleanKind の 1 か所） =====
{
  const card = { id: "english-make", en: "make", ja: "作る", accept: ["Create", " build "] };
  const kinds = [Q.cleanKindOf("make", card), Q.cleanKindOf("favourite", { en: "favorite" }), Q.cleanKindOf("create", card), Q.cleanKindOf("build", card), Q.cleanKindOf("produce", card)];
  eq("種類: 出題語 exact・綴り違い variant・accept の語 altAccept（大文字・空白は落として比べる）・同じ訳の別のカードの語 altIndex", kinds, ["exact", "variant", "altAccept", "altAccept", "altIndex"]);
  eq("種類: × の細目 e 答え表示・m 1 打ミス・h ヒント・読めない細目は答え表示", ["e", "m", "h", "p", undefined].map(Q.failKindOf), ["reveal", "miss", "hint", "reveal", "reveal"]);
  ok("種類: 打ち終えた種類はどれも自力正解、× の種類はどれも自力正解でない（js/learnState.js isCleanKind）", kinds.every(L.isCleanKind) && ["e", "m", "h"].map(Q.failKindOf).every((k) => L.isAnswerKind(k) && !L.isCleanKind(k)));
  ok("種類: どの値も js/learnState.js ANSWER_KINDS の値（書き手が受ける）", [...kinds, ...["e", "m", "h"].map(Q.failKindOf)].every(L.isAnswerKind));
}

// ===== 回の結果: 答えた語の今の状態から（同じ語は 1 回） =====
{
  const [a, b, c, d, e] = vocab.order.slice(700, 705);
  const t = { [a]: { ls: 2 }, [b]: { ls: 1, lsd: TODAY }, [c]: { ls: 1, lsd: TODAY - 2 }, [d]: { ...base }, [e]: { ls: 1 } };
  eq("結果: 覚えた 1・あやふや 3（うち今日を 1 日目 1）・状態の動かなかった語（保存できなかった）は数えない・同じ語は 1 回", Q.learnSummary([a, b, c, d, e, a, b], t, null, TODAY), { learned: 1, unsure: 3, dayOne: 1 });
  eq("結果: 版 6 の pending の状態も数える", Q.learnSummary([d], t, new Map([[d, 2]]), TODAY), { learned: 1, unsure: 0, dayOne: 0 });
}

// ===== 中心の学習の別解の索引（js/answers.js buildAlternativeIndexById。公開のカードだけ・カードの id で引く） =====
{
  const A = await import(modUrl("js/answers.js"));
  const aux = { id: "english-may", en: "may", ja: "〜かもしれない", pos: "助" };
  const month = { id: "english-may-month", en: "may", ja: "5月", pos: "名" };
  const might = { id: "english-might", en: "might", ja: "〜かもしれない", pos: "助" };
  const byId = A.buildAlternativeIndexById([aux, month, might]);
  const byEn = A.buildAlternativeIndex([aux, month, might]);
  eq("別解の索引 id: 同じ綴りの 2 枚（助動詞の may・5月の May）で、5月の問いに might を混ぜない・助動詞の問いは might を受ける",
    [A.acceptedAnswers(month, byId, month.id), A.acceptedAnswers(aux, byId, aux.id), A.acceptedAnswers(might, byId, might.id)], [["may"], ["may", "might"], ["might", "may"]]);
  eq("別解の索引 id: 綴りで引く今の索引は 5月の問いに might が混ざる（id で引く理由）", A.acceptedAnswers(month, byEn), ["may", "might"]);
  // 公開の 2,857 枚（綴りは重ならない）では、id で引いても綴りで引いても同じ候補・同じ並び（中心の学習の判定は今の Study の判定と同じ）
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "data/manifest.json"), "utf8"));
  const cats = manifest.subjects.find((s) => s.id === "english").categories;
  const json = JSON.parse(fs.readFileSync(path.join(ROOT, "data/public/english.json"), "utf8"));
  const cards = json.packs.flatMap((id) => {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data", cats.find((c) => c.id === id).file), "utf8"));
    return data.words.map((w) => ({ ...w, category: data.category }));
  });
  const ia = A.buildAlternativeIndexById(cards);
  const ie = A.buildAlternativeIndex(cards);
  const differ = cards.filter((w) => JSON.stringify(A.acceptedAnswers(w, ia, w.id)) !== JSON.stringify(A.acceptedAnswers(w, ie)));
  eq("別解の索引 id: 公開の 2,857 枚で、綴りの索引と候補が同じ（違う 0 枚）・別解のある語は 1,500 枚以上", [cards.length, differ.length, cards.filter((w) => A.acceptedAnswers(w, ia, w.id).length > 1).length >= 1500], [vocab.total, 0, true]);
}

// ===== 純なこと: DOM・localStorage・乱数・時刻を読まない =====
{
  const src = fs.readFileSync(path.join(ROOT, "js/learnQueue.js"), "utf8").replace(/\/\/.*$/gm, "");
  ok("純: js/learnQueue.js は document・window・localStorage・Math.random・Date を使わない", !/\b(document|window|localStorage|sessionStorage|Math\.random|Date)\b/.test(src));
  eq("純: import は js/learnState.js と js/judge.js だけ", [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]), ["./learnState.js", "./judge.js"]);
}

// ===== 入口の値の写し: js/game.js（この module を読む前に入口かを決める）と index.html の <head> の 1 行（初回の本を出すか）は LEARN_MODES の鍵と同じ =====
{
  const game = fs.readFileSync(path.join(ROOT, "js/game.js"), "utf8");
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const fromGame = JSON.parse(game.match(/const LEARN_ENTRY_MODES = (\[[^\]]*\]);/)?.[1] ?? "null");
  const fromHead = JSON.parse(html.match(/(\[[^\]]*\])\.includes\(\(q\.get\("learn"\)/)?.[1] ?? "null");
  eq("入口の値の写し: js/game.js LEARN_ENTRY_MODES と index.html の <head> の 1 行は LEARN_MODES の鍵と同じ", [fromGame, fromHead], [Object.keys(Q.LEARN_MODES), Object.keys(Q.LEARN_MODES)]);
}

if (failures.length) {
  console.error(`test-learn-queue: ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`test-learn-queue: ${passed} passed`);
process.exit(0);
