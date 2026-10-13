// ===== 読み上げの行の行き先（窓が開いている間は窓の中の行へ） =====
//
// ページの読み上げの行（index.html などの #srStatus、typing.html の #typingLive、typing-game.html の #tgLive。ref）は、背後を inert にする窓
// （ご意見・語の詳細）や <dialog>.showModal() の窓（本を足す）が開いている間は窓の外で読まれない。書く瞬間に開いている窓があれば、
// その窓の中の読み上げの行（[data-sr-live]）に書く（aria-modal の窓の外を読まない読み上げでも読まれる。PR #166 レビューの 7）。
// js/ui.js announce とタイピングの 2 ページ（js/typingPage.js・js/typingGamePage.js）が同じ判定を通る（Batch 66 R1）。
// タイピングの 2 ページは js/ui.js を読まない（js/ui.js は学習記録の js/storage.js を import し、読み込みのときに記録の移行を書く）ので、判定はこの小さな module に置く。

// 開いている窓（読み上げをその中に書く）。無ければ null。1 つの判定で 2 つの開き方を見る:
//   - <dialog>.showModal()（本棚の「本を足す」js/bookshelf.js）: 外を属性なしで inert にするので [inert] では分からない。:modal で見る
//   - 背後に [inert] を付ける窓（ご意見・語の詳細。js/focusTrap.js inertOthers）: ref が [inert] の中なら、inert でも hidden でもない aria-modal の札
// （ref が inert でないときの aria-modal の札〔コースを選ぶ。背後を inert にしない〕は見ない: ref がそのまま読まれる）
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

// 今書くならどの行か: 開いている窓の中の行、無ければ ref
export function liveTarget(ref) {
  const box = openWindow(ref);
  return box ? liveLineIn(box) : ref;
}

// ref と窓の中の行を全部空にする（窓を開け閉めしても、前の文が残った行で同じ文が読まれないことがない）
export function clearLive(ref) {
  if (ref) ref.textContent = "";
  for (const line of document.querySelectorAll("[data-sr-live]")) line.textContent = "";
}

// タイピングの 2 ページの書き方: 行を全部空にして、今の行き先に text を書く（空なら空にするだけ）。
// 窓の無い間に ref に書いた文は、同じ操作の続きで窓が開いたら（ご意見のボタンを押した: クリックの capture で長文を止めて「止めた。」を書き、
// そのあと同じクリックで窓が開き背後が inert になる）MOVE_GAP_MS 後に窓の中の行に移す（ご意見の窓は初めて開くときに作るので、行が置かれてから
// 少し間をあけて書く。2 ページの読み上げの間 50ms と同じ）。そのあいだに書き替えた・空にしたなら移さない
const MOVE_GAP_MS = 50;
let moveTimer = 0;
export function writeLive(ref, text) {
  clearTimeout(moveTimer);
  moveTimer = 0;
  clearLive(ref);
  if (!text) return;
  const target = liveTarget(ref);
  if (!target) return;
  target.textContent = text;
  if (target !== ref) return;
  moveTimer = setTimeout(() => {
    moveTimer = 0;
    const box = ref.textContent === text ? openWindow(ref) : null;
    if (!box) return;
    ref.textContent = "";
    liveLineIn(box).textContent = text;
  }, MOVE_GAP_MS);
}
