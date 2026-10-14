// ===== 読み上げ（ページの読み上げの行に、間をあけて書く。窓が開いている間は窓の中の行へ） =====
//
// ページの読み上げの行（index.html などの #srStatus、typing.html の #typingLive、typing-game.html の #tgLive。ref）は、背後を inert にする窓
// （ご意見・語の詳細）や <dialog>.showModal() の窓（本を足す）が開いている間は窓の外で読まれない。書く瞬間に開いている窓があれば、
// その窓の中の読み上げの行（[data-sr-live]）に書く（aria-modal の窓の外を読まない読み上げでも読まれる。PR #166 レビューの 7）。
// js/ui.js announce とタイピングの 2 ページ（js/typingPage.js・js/typingGamePage.js）は同じ createLive を使う（Batch 66 R1 → PR #168 レビューの 6・7）。
// タイピングの 2 ページの打鍵を止める判定（js/typingKeys.js modalOpen）も同じ openWindow を通る（読み上げの行き先と同じ窓を見る）。
// タイピングの 2 ページは js/ui.js を読まない（js/ui.js は学習記録の js/storage.js を import し、読み込みのときに記録の移行を書く）ので、この小さな module に置く。

// 開いている窓（読み上げをその中に書く）。無ければ null。1 つの判定で 2 つの開き方を見る:
//   - <dialog>.showModal()（本棚の「本を足す」js/bookshelf.js）: 外を属性なしで inert にするので [inert] では分からない。:modal で見る
//   - 背後に [inert] を付ける窓（ご意見・語の詳細。js/focusTrap.js inertOthers）: ref が [inert] の中なら、inert でも hidden でもない aria-modal の札
// （ref が inert でないときの aria-modal の札〔コースを選ぶ。背後を inert にしない〕は見ない: ref がそのまま読まれる）。
// 打鍵ごとにも呼ぶ（js/typingKeys.js modalOpen）ので、レイアウトを読まない
export function openWindow(ref) {
  let dialog = null;
  try {
    dialog = document.querySelector("dialog:modal");
  } catch {
    dialog = document.querySelector("dialog[open]"); // :modal を知らない古いブラウザ（show() で開く <dialog> は使っていない）
  }
  if (dialog) return dialog;
  if (!ref?.closest("[inert]")) return null;
  return [...document.querySelectorAll('[aria-modal="true"]')].find((node) => !node.closest("[inert], [hidden]")) ?? null;
}

// 窓の中の読み上げの行（[data-sr-live]）。3 つの窓（ご意見・語の詳細・本を足す）は markup に最初から置く（後から差し込んだ live 領域は
// 読まれないことがある）。置いていない窓には作って足す（role=status・aria-live=polite・sr-only）
function liveLineIn(box) {
  let line = box.querySelector("[data-sr-live]");
  if (!line) {
    line = document.createElement("p");
    line.className = "sr-only";
    line.setAttribute("role", "status");
    line.setAttribute("aria-live", "polite");
    line.setAttribute("data-sr-live", "");
    box.append(line);
  }
  return line;
}

// ref と窓の中の行を全部空にする（窓を開け閉めしても、前の文が残った行で同じ文が読まれないことがない）
function clearLive(ref) {
  ref.textContent = "";
  for (const line of document.querySelectorAll("[data-sr-live]")) line.textContent = "";
}

// 文の終わりの印（つなげるとき、前の文がこれで終わっていなければ「。」を挟む）
const SENTENCE_END = /[。．.!?！？]$/;

// 読み上げ（ページに 1 つ）。ref: ページの読み上げの行（要素か、要素を返す関数。書く瞬間にも引き直す）。
//   gap: 空にしてから書くまでの ms（同じ文を同じタスクで書き直すと読まれない環境がある。タイピングの 2 ページは既定の 50、js/ui.js は 30）
//   join: 待っている間に次の文が来たら、前の文を消さずに 1 つの文につなげる（js/ui.js: 時間切れでレベルアップと見出しの文が同じ tick に来る。PR #164 レビューの 3）
// say(text): ref と窓の中の行を全部空にし、gap 後に書く。書く行はその瞬間に選ぶ（開いている窓の中の行、無ければ ref）。
//   同じ操作の続きで窓が開いても（ご意見のボタンを押した: クリックの capture で長文を止めて「止めた。」を言い、そのあと同じクリックで窓が開き
//   背後が inert になる。ご意見の窓は初めて開くときに作る）、書く瞬間には窓と窓の中の行があるので、そこに入る。ref に書いてから移すことはしない（PR #168 レビューの 6）。
//   空の text は空にするだけ（待っている文も捨てる）
// cancel(): 待っている文を捨てる（行はそのまま）
export function createLive(ref, { gap = 50, join = false } = {}) {
  const refOf = typeof ref === "function" ? ref : () => ref;
  let pending = "";
  let timer = 0;
  const cancel = () => {
    clearTimeout(timer);
    timer = 0;
    pending = "";
  };
  const say = (text) => {
    const s = String(text ?? "");
    const next = join && timer && pending ? `${pending}${SENTENCE_END.test(pending) ? "" : "。"}${s}` : s;
    cancel();
    const line = refOf();
    if (!line) return;
    clearLive(line);
    if (!next) return;
    pending = next;
    timer = setTimeout(() => {
      const t = pending;
      cancel();
      const at = refOf();
      if (!at) return;
      const box = openWindow(at);
      (box ? liveLineIn(box) : at).textContent = t;
    }, gap);
  };
  return { say, cancel };
}
