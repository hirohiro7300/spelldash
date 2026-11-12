// ショートカットキーの表（Batch 92。docs/SPEC_SHORTCUTS.md §11）。項目は行と絵の状態を足すだけ

export const CHECKED_AT = "2026-11-11";
export const SOURCES = Object.freeze({
  "os-ctrl": "Ctrl のキーボードのパソコンの公式の一覧（英語版・日本語版）",
  "os-cmd": "⌘ のキーボードのパソコンの公式の一覧（英語版・日本語版）",
  "shot-cmd": "⌘ のキーボードの画面の写しの公式の頁",
  doc: "文書作成のアプリの公式の一覧",
  "web-g": "ブラウザ g の公式の一覧",
  "web-e": "ブラウザ e の公式の一覧",
  "web-s": "ブラウザ s の公式の一覧"
});

const P = (show, accept, src, more = {}) => ({ show, how: "press", accept, src, ...more });
const G = (show, accept, src, more = {}) => ({ show, how: "guard", accept, src, ...more });
const C = (show, why, src, more = {}) => ({ show, how: "choice", why, src, ...more });
// 両向きの組は向きのない short を渡す（仕様 §7）
const item = (id, g, p, ja, keys, scene, say, short = ja.replace(/（[^）]*）/g, "").trim()) => ({ id, g, p, ja, short, keys, scene, say });

const MEET = "会議は10時から";
const EN = "see you soon";
const TABS3 = ["予定", "天気", "地図"];
const ZOOM_NOTE = "表示の大きさが変わったら、元の大きさの組で戻せる。";

const ITEMS = [
  // ---- パソコン共通: 文字の編集 ----
  item("pc.copy", "pc", "A", "選んだものをコピーする", {
    ctrl: P([["Ctrl", "C"]], ["ctrl+c"], ["os-ctrl"], { also: ["ctrl+Insert"], alt: [["Ctrl", "Insert"]], note: "ほかに Ctrl + Insert でも同じ。" }),
    cmd: P([["⌘", "C"]], ["meta+c"], ["os-cmd"])
  }, { k: "doc", a: { t: MEET, sel: [0, 8], clip: "" }, b: { t: MEET, sel: [0, 8], clip: MEET } },
  ["文字を選んでいる。クリップボードは空", "選んだ文字がクリップボードに入った。元の文はそのまま"]),
  item("pc.paste", "pc", "A", "コピーしたものを貼り付ける", {
    ctrl: P([["Ctrl", "V"]], ["ctrl+v"], ["os-ctrl"], { also: ["shift+Insert"], alt: [["Shift", "Insert"]], note: "ほかに Shift + Insert でも同じ。" }),
    cmd: P([["⌘", "V"]], ["meta+v"], ["os-cmd"])
  }, { k: "doc", a: { t: "場所: ", car: 4, clip: "3階 会議室" }, b: { t: "場所: 3階 会議室", car: 10, clip: "3階 会議室", ins: [4, 10] } },
  ["カーソルが「場所:」の後ろにある", "クリップボードの文字がカーソルの所に入った"]),
  item("pc.cut", "pc", "A", "選んだものを切り取る（あとで貼り付けられる）", {
    ctrl: P([["Ctrl", "X"]], ["ctrl+x"], ["os-ctrl"]),
    cmd: P([["⌘", "X"]], ["meta+x"], ["os-cmd"])
  }, { k: "doc", a: { t: "会議は午後3時から", sel: [3, 5], clip: "" }, b: { t: "会議は3時から", car: 3, clip: "午後" } },
  ["「午後」を選んでいる", "「午後」が文から消え、クリップボードに入った"]),
  item("pc.undo", "pc", "A", "直前の操作を取り消す（元に戻す）", {
    ctrl: P([["Ctrl", "Z"]], ["ctrl+z"], ["os-ctrl"]),
    cmd: P([["⌘", "Z"]], ["meta+z"], ["os-cmd"])
  }, { k: "doc", a: { t: "会議は", car: 3, note: "消した" }, b: { t: MEET, car: 8, note: "戻った", ins: [3, 8] } },
  ["文の後ろをうっかり消した", "消す前の文に戻った"]),
  item("pc.redo", "pc", "A", "取り消した操作をやり直す", {
    ctrl: P([["Ctrl", "Y"]], ["ctrl+y"], ["os-ctrl", "doc"], { near: ["ctrl+shift+z"], note: "Ctrl + Shift + Z を使うアプリもある。" }),
    cmd: P([["⇧", "⌘", "Z"]], ["shift+meta+z"], ["os-cmd", "doc"], { near: ["meta+y"], note: "⌘ + Y を使うアプリもある。" })
  }, { k: "doc", a: { t: MEET, car: 8, note: "取り消した" }, b: { t: "会議は", car: 3, note: "やり直した" } },
  ["文の後ろを消す操作を取り消した", "取り消した操作をもう一度した"]),
  item("pc.select-all", "pc", "A", "すべて選ぶ", {
    ctrl: P([["Ctrl", "A"]], ["ctrl+a"], ["os-ctrl"]),
    cmd: P([["⌘", "A"]], ["meta+a"], ["os-cmd"])
  }, { k: "doc", a: { t: ["議事録", "1. 予算", "2. 日程"] }, b: { t: ["議事録", "1. 予算", "2. 日程"], sel: "all" } },
  ["3 行の文", "3 行がすべて選ばれた"]),
  item("pc.save", "pc", "A", "保存する", {
    ctrl: P([["Ctrl", "S"]], ["ctrl+s"], ["doc", "web-g", "web-e"]),
    cmd: P([["⌘", "S"]], ["meta+s"], ["os-cmd", "doc"])
  }, { k: "doc", a: { title: "報告書", dirty: true, t: "今月の売上" }, b: { title: "報告書", t: "今月の売上", note: "保存した" } },
  ["題に、まだ保存していない印がある", "保存して、印が消えた"]),
  item("pc.print", "pc", "B", "印刷する（印刷の画面を開く）", {
    ctrl: P([["Ctrl", "P"]], ["ctrl+p"], ["doc", "web-g", "web-e"]),
    cmd: P([["⌘", "P"]], ["meta+p"], ["os-cmd", "web-s"])
  }, { k: "doc", a: { title: "報告書", t: "今月の売上" }, b: { title: "報告書", t: "今月の売上", panel: "print" } },
  ["文書を開いている", "印刷の画面が出た"]),
  item("pc.paste-plain", "pc", "B", "書式なしで貼り付ける（文字だけ）", {
    ctrl: C([["Ctrl", "Shift", "V"]], "differ", ["os-ctrl", "web-e"], { note: "アプリによって使えないことがある。" }),
    cmd: C([["⌥", "⇧", "⌘", "V"]], "differ", ["os-cmd"], { note: "アプリによって組が違う（⇧ + ⌘ + V のアプリもある）。" })
  }, { k: "doc", a: { t: "場所: ", car: 4, clip: "3階 会議室", fmt: true }, b: { t: "場所: 3階 会議室", car: 10, clip: "3階 会議室", fmt: true, ins: [4, 10] } },
  ["太字のままの文字をコピーしてある", "太字を外して、文字だけが入った"]),
  item("pc.bold", "pc", "B", "選んだ文字を太字にする", {
    ctrl: P([["Ctrl", "B"]], ["ctrl+b"], ["os-ctrl", "doc"]),
    cmd: P([["⌘", "B"]], ["meta+b"], ["os-cmd", "doc"])
  }, { k: "doc", a: { t: "締め切りは金曜", sel: [5, 7] }, b: { t: "締め切りは金曜", sel: [5, 7], bold: [5, 7] } },
  ["「金曜」を選んでいる", "「金曜」が太字になった"]),
  item("pc.word-left-right", "pc", "B", "カーソルを 1 語ずつ動かす", {
    ctrl: P([["Ctrl", "←"], ["Ctrl", "→"]], ["ctrl+ArrowLeft", "ctrl+ArrowRight"], ["os-ctrl", "web-g"]),
    cmd: P([["⌥", "←"], ["⌥", "→"]], ["alt+ArrowLeft", "alt+ArrowRight"], ["os-cmd"])
  }, { k: "doc", a: { t: EN, car: 0 }, b: { t: EN, car: 4 }, bCmd: { t: EN, car: 3 } },
  ["カーソルが文の頭にある", "カーソルが 1 語ぶん右へ跳んだ"]),
  item("pc.line-start-end", "pc", "B", "カーソルを行の頭・行の終わりへ動かす", {
    ctrl: P([["Home"], ["End"]], ["Home", "End"], ["os-ctrl"]),
    cmd: C([["⌘", "←"], ["⌘", "→"]], "differ", ["os-cmd"], { note: "⌘ + ← を前のページに戻るに使うブラウザがある。" })
  }, { k: "doc", a: { t: MEET, car: 3 }, b: { t: MEET, car: 8 } },
  ["カーソルが行の途中にある", "カーソルが行の終わりへ跳んだ"]),
  item("pc.select-word", "pc", "B", "1 語ずつ選ぶ範囲を広げる", {
    ctrl: P([["Ctrl", "Shift", "←"], ["Ctrl", "Shift", "→"]], ["ctrl+shift+ArrowLeft", "ctrl+shift+ArrowRight"], ["os-ctrl"]),
    cmd: P([["⌥", "⇧", "←"], ["⌥", "⇧", "→"]], ["alt+shift+ArrowLeft", "alt+shift+ArrowRight"], ["os-cmd"])
  }, { k: "doc", a: { t: EN, car: 0 }, b: { t: EN, sel: [0, 4] }, bCmd: { t: EN, sel: [0, 3] } },
  ["カーソルが文の頭にある", "1 語ぶんが選ばれた"]),
  item("pc.delete-word", "pc", "B", "前の 1 語をまとめて消す", {
    ctrl: P([["Ctrl", "Backspace"]], ["ctrl+Backspace"], ["os-ctrl", "web-g"]),
    cmd: P([["⌥", "Delete"]], ["alt+Backspace"], ["os-cmd"])
  }, { k: "doc", a: { t: EN, car: 12 }, b: { t: "see you ", car: 8 } },
  ["カーソルが文の終わりにある", "最後の 1 語がまとめて消えた"]),
  item("pc.next-field", "pc", "A", "次の入力欄・ボタンへ移る（戻るは Shift 付き）", {
    ctrl: C([["Tab"], ["Shift", "Tab"]], "screen", ["os-ctrl", "web-g", "web-e"]),
    cmd: C([["Tab"], ["⇧", "Tab"]], "screen", ["os-cmd"])
  }, { k: "doc", a: { form: 0 }, b: { form: 1 } },
  ["「名前」の欄にいる", "次の「メール」の欄へ移った"]),
  item("pc.cancel", "pc", "B", "やめる・小窓を閉じる", {
    ctrl: C([["Esc"]], "screen", ["os-ctrl", "web-e"]),
    cmd: C([["Esc"]], "screen", ["web-e"])
  }, { k: "doc", a: { title: "報告書", t: "今月の売上", panel: "print" }, b: { title: "報告書", t: "今月の売上" } },
  ["印刷の小窓が開いている", "小窓が閉じた"]),
  item("pc.open", "pc", "B", "ファイルを開く（開く画面を出す）", {
    ctrl: P([["Ctrl", "O"]], ["ctrl+o"], ["doc", "web-g", "web-e"]),
    cmd: P([["⌘", "O"]], ["meta+o"], ["os-cmd"])
  }, { k: "doc", a: { t: MEET }, b: { t: MEET, panel: "open" } },
  ["文書を開いている", "開くファイルを選ぶ画面が出た"]),
  item("pc.new", "pc", "B", "新しいウィンドウ（書類）を開く", {
    ctrl: C([["Ctrl", "N"]], "browser", ["doc", "os-ctrl", "web-g", "web-e"]),
    cmd: C([["⌘", "N"]], "browser", ["web-g", "web-e"])
  }, { k: "desk", a: { wins: ["報告書"] }, b: { wins: ["新しい書類", "報告書"], fresh: true } },
  ["報告書の窓が開いている", "新しい書類の窓が前に開いた"]),
  item("pc.close-window", "pc", "B", "いまのウィンドウを閉じる", {
    ctrl: C([["Alt", "F4"]], "os", ["os-ctrl", "web-g", "web-e"]),
    cmd: C([["⌘", "W"]], "os", ["os-cmd"])
  }, { k: "desk", a: { wins: ["メモ", "文書"] }, b: { wins: ["文書"] } },
  ["メモの窓が前にある", "メモの窓が閉じた"]),
  item("pc.switch-app", "pc", "A", "開いているアプリ・ウィンドウを切り替える", {
    ctrl: C([["Alt", "Tab"]], "os", ["os-ctrl"]),
    cmd: C([["⌘", "Tab"]], "os", ["os-cmd"])
  }, { k: "desk", a: { wins: ["文書", "地図"] }, b: { wins: ["地図", "文書"], over: "switch" } },
  ["文書の窓が前にある", "切り替えの一覧が出て、地図の窓が前に来た"]),
  item("pc.all-windows", "pc", "B", "開いているウィンドウを全部並べて見る", {
    ctrl: C([["⊞", "Tab"]], "os", ["os-ctrl"]),
    cmd: C([["⌃", "↑"]], "os", ["os-cmd"])
  }, { k: "desk", a: { wins: ["文書", "メモ", "地図"] }, b: { wins: ["文書", "メモ", "地図"], tile: true } },
  ["窓が重なっている", "窓が全部、重ならずに並んだ"]),
  item("pc.show-desktop", "pc", "B", "デスクトップを見せる", {
    ctrl: C([["⊞", "D"]], "os", ["os-ctrl"], { note: "もう一度押すと元に戻る。" }),
    cmd: C([["Fn", "H"]], "os", ["os-cmd"], { alt: [["Fn", "F11"]], note: "ほかに Fn + F11 でも同じ。" })
  }, { k: "desk", a: { wins: ["文書", "地図"] }, b: { wins: [], icons: true } },
  ["窓が開いている", "窓がよけられ、デスクトップが見えた"]),
  item("pc.minimize", "pc", "B", "ウィンドウを小さくしまう（最小化）", {
    ctrl: C([["⊞", "↓"]], "os", ["os-ctrl"]),
    cmd: C([["⌘", "M"]], "os", ["os-cmd"])
  }, { k: "desk", a: { wins: ["文書"] }, b: { wins: [], dock: "文書" } },
  ["文書の窓が開いている", "窓が画面の下の帯にしまわれた"]),
  item("pc.screenshot-area", "pc", "A", "画面の一部を写真に撮る（範囲を選ぶ）", {
    ctrl: C([["⊞", "Shift", "S"]], "os", ["os-ctrl"]),
    cmd: C([["⇧", "⌘", "4"]], "os", ["shot-cmd", "os-cmd"])
  }, { k: "desk", a: { wins: ["文書"] }, b: { wins: ["文書"], over: "shotArea" } },
  ["文書の窓", "選んだ範囲だけが写真になった"]),
  item("pc.screenshot-full", "pc", "B", "画面全体を写真に撮って保存する", {
    ctrl: C([["⊞", "PrtScn"]], "os", ["os-ctrl"]),
    cmd: C([["⇧", "⌘", "3"]], "os", ["shot-cmd", "os-cmd"])
  }, { k: "desk", a: { wins: ["文書"] }, b: { wins: ["文書"], over: "shotFull" } },
  ["文書の窓", "画面全体が写真になって保存された"]),
  item("pc.lock", "pc", "A", "画面をロックする（席を離れるとき）", {
    ctrl: C([["⊞", "L"]], "os", ["os-ctrl"]),
    cmd: C([["⌃", "⌘", "Q"]], "os", ["os-cmd"])
  }, { k: "desk", a: { wins: ["文書"] }, b: { over: "lock" } },
  ["文書の窓が開いている", "鍵の絵の画面になった。開くにはパスワードが要る"]),
  item("pc.emoji", "pc", "B", "絵文字・記号の一覧を出す", {
    ctrl: C([["⊞", "."]], "os", ["os-ctrl"], { alt: [["⊞", ";"]], note: "ほかに ⊞ + ; でも同じ。" }),
    cmd: C([["⌃", "⌘", "Space"]], "os", ["os-cmd"], { alt: [["Fn", "E"]], note: "ほかに Fn + E でも同じ。" })
  }, { k: "doc", a: { t: "ありがとう", car: 5 }, b: { t: "ありがとう", car: 5, panel: "emoji" } },
  ["文を打っている", "絵文字と記号の一覧が出た"]),
  item("pc.clipboard-history", "pc", "B", "前にコピーしたものの一覧から貼り付ける（最初は切ってある）", {
    ctrl: C([["⊞", "V"]], "os", ["os-ctrl"], { note: "最初は切ってある。設定で入れると使える。" })
  }, { k: "doc", a: { t: "場所: ", car: 4 }, b: { t: "場所: ", car: 4, panel: "clips" } },
  ["カーソルが「場所:」の後ろにある", "前にコピーした物の一覧が出た"]),
  item("pc.search", "pc", "B", "パソコンの中を検索する（アプリやファイルを名前で開く）", {
    ctrl: C([["⊞", "S"]], "os", ["os-ctrl"]),
    cmd: C([["⌘", "Space"]], "os", ["os-cmd"], { note: "入力の切り替えに ⌘ + Space を使う設定もある。" })
  }, { k: "desk", a: { wins: ["文書"] }, b: { wins: ["文書"], over: "search" } },
  ["文書の窓", "検索の欄が出た"]),
  item("pc.task-manager", "pc", "B", "動かないアプリを止める画面を開く", {
    ctrl: C([["Ctrl", "Shift", "Esc"]], "os", ["os-ctrl"]),
    cmd: C([["⌥", "⌘", "Esc"]], "os", ["os-cmd"])
  }, { k: "desk", a: { wins: ["文書"], hang: true }, b: { wins: ["文書"], hang: true, over: "task" } },
  ["文書の窓が止まって動かない", "アプリの一覧が出て、止めるボタンがある"]),

  // ---- ブラウザ ----
  item("br.new-tab", "br", "A", "新しいタブを開く", {
    ctrl: C([["Ctrl", "T"]], "browser", ["web-g", "web-e"]),
    cmd: C([["⌘", "T"]], "browser", ["web-g", "os-cmd"])
  }, { k: "web", a: { tabs: ["予定"], on: 0 }, b: { tabs: ["予定", "新規"], on: 1, blank: true } },
  ["タブが 1 つ", "新しいタブが開いた"]),
  item("br.close-tab", "br", "A", "いまのタブを閉じる", {
    ctrl: C([["Ctrl", "W"]], "browser", ["web-g", "web-e"]),
    cmd: C([["⌘", "W"]], "browser", ["web-g", "web-s"])
  }, { k: "web", a: { tabs: ["予定", "天気"], on: 1 }, b: { tabs: ["予定"], on: 0 } },
  ["天気のタブを見ている", "天気のタブが閉じた"]),
  item("br.reopen-tab", "br", "A", "閉じたタブを開き直す", {
    ctrl: C([["Ctrl", "Shift", "T"]], "browser", ["web-g", "web-e"]),
    cmd: C([["⇧", "⌘", "T"]], "browser", ["web-g", "web-s"])
  }, { k: "web", a: { tabs: ["予定"], on: 0 }, b: { tabs: ["予定", "天気"], on: 1, fresh: true } },
  ["天気のタブを閉じてしまった", "天気のタブが戻った"]),
  item("br.next-tab", "br", "A", "右隣のタブへ移る", {
    ctrl: C([["Ctrl", "Tab"]], "browser", ["web-g", "web-e"]),
    cmd: C([["⌥", "⌘", "→"], ["⌃", "Tab"]], "differ", ["web-g", "web-s"], { note: "ブラウザによって組が違う（⌥ + ⌘ + → か ⌃ + Tab）。" })
  }, { k: "web", a: { tabs: TABS3, on: 0 }, b: { tabs: TABS3, on: 1 } },
  ["左のタブを見ている", "右隣のタブへ移った"]),
  item("br.prev-tab", "br", "B", "左隣のタブへ移る", {
    ctrl: C([["Ctrl", "Shift", "Tab"]], "browser", ["web-g", "web-e"]),
    cmd: C([["⌥", "⌘", "←"], ["⌃", "⇧", "Tab"]], "differ", ["web-g", "web-s"], { note: "ブラウザによって組が違う（⌥ + ⌘ + ← か ⌃ + ⇧ + Tab）。" })
  }, { k: "web", a: { tabs: TABS3, on: 1 }, b: { tabs: TABS3, on: 0 } },
  ["真ん中のタブを見ている", "左隣のタブへ移った"]),
  item("br.tab-n", "br", "B", "左から n 番目のタブへ跳ぶ", {
    ctrl: P([["Ctrl", "1〜8"]], ["ctrl+#"], ["web-g", "web-e"], { note: "数のキーは 1〜8。その番目のタブへ跳ぶ。" }),
    cmd: P([["⌘", "1〜8"]], ["meta+#"], ["web-g", "web-s"], { note: "数のキーは 1〜8。その番目のタブへ跳ぶ。" })
  }, { k: "web", a: { tabs: ["1", "2", "3", "4", "5", "6", "7", "8"], on: 0 }, b: { tabs: ["1", "2", "3", "4", "5", "6", "7", "8"], on: "n" } },
  ["いちばん左のタブを見ている", "左から n 番目のタブへ跳んだ"]),
  item("br.back", "br", "A", "前のページに戻る", {
    ctrl: G([["Alt", "←"]], ["alt+ArrowLeft"], ["web-g", "web-e", "os-ctrl"]),
    cmd: G([["⌘", "["]], ["meta+["], ["web-g", "web-s"], { near: ["meta+ArrowLeft"], note: "⌘ + ← を使うブラウザもある。" })
  }, { k: "web", a: { tabs: ["予定"], page: 2 }, b: { tabs: ["予定"], page: 1 } },
  ["2 ページ目を見ている", "前の 1 ページ目に戻った"]),
  item("br.forward", "br", "B", "次のページに進む（戻った後）", {
    ctrl: G([["Alt", "→"]], ["alt+ArrowRight"], ["web-g", "web-e", "os-ctrl"]),
    cmd: G([["⌘", "]"]], ["meta+]"], ["web-g", "web-s"], { near: ["meta+ArrowRight"], note: "⌘ + → を使うブラウザもある。" })
  }, { k: "web", a: { tabs: ["予定"], page: 1 }, b: { tabs: ["予定"], page: 2 } },
  ["1 ページ目に戻ってきた", "次の 2 ページ目に進んだ"]),
  item("br.reload", "br", "A", "ページを読み込み直す", {
    ctrl: G([["F5"], ["Ctrl", "R"]], ["F5", "ctrl+r"], ["web-g", "web-e", "os-ctrl"]),
    cmd: G([["⌘", "R"]], ["meta+r"], ["web-e", "os-cmd"])
  }, { k: "web", a: { tabs: ["予定"] }, b: { tabs: ["予定"], reload: true } },
  ["ページを開いている", "ページが読み込み直された"]),
  item("br.address", "br", "A", "アドレスバーに移る（URL を打つ・検索する）", {
    ctrl: P([["Ctrl", "L"], ["Alt", "D"]], ["ctrl+l", "alt+d"], ["web-g", "web-e", "os-ctrl"], { near: ["F6", "F4"], note: "F6 を使うブラウザもある。" }),
    cmd: P([["⌘", "L"]], ["meta+l"], ["web-g", "web-s"])
  }, { k: "web", a: { tabs: ["予定"] }, b: { tabs: ["予定"], urlSel: true } },
  ["ページを開いている", "アドレスバーの URL が選ばれ、打ち直せる"]),
  item("br.find", "br", "A", "ページ（文書）の中の言葉を探す", {
    ctrl: P([["Ctrl", "F"], ["F3"]], ["ctrl+f", "F3"], ["web-g", "web-e"]),
    cmd: P([["⌘", "F"]], ["meta+f"], ["web-g", "web-s"])
  }, { k: "web", a: { tabs: ["予定"] }, b: { tabs: ["予定"], find: "会議", hit: 1 } },
  ["ページを開いている", "探す欄が出て、「会議」が光った"]),
  item("br.find-next", "br", "B", "探した言葉の次の場所へ（前へは Shift 付き）", {
    ctrl: P([["Ctrl", "G"], ["Ctrl", "Shift", "G"]], ["ctrl+g", "ctrl+shift+g"], ["web-g", "web-e"]),
    cmd: P([["⌘", "G"], ["⇧", "⌘", "G"]], ["meta+g", "shift+meta+g"], ["web-g", "os-cmd"])
  }, { k: "web", a: { tabs: ["予定"], find: "会議", hit: 1 }, b: { tabs: ["予定"], find: "会議", hit: 2 } },
  ["1 つ目の「会議」が光っている", "2 つ目の「会議」へ移った"], "探した言葉の場所を順に移る"),
  item("br.zoom-in", "br", "A", "ページを大きく表示する", {
    ctrl: P([["Ctrl", "+"]], ["ctrl+?shift+plus"], ["web-g", "web-e"], { note: `日本語の並びでは ; + のキー。テンキーの + でもよい。${ZOOM_NOTE}` }),
    cmd: P([["⌘", "+"]], ["meta+?shift+plus"], ["web-g", "web-s"], { note: `日本語の並びでは ; + のキー。${ZOOM_NOTE}` })
  }, { k: "web", a: { tabs: ["予定"], zoom: 1 }, b: { tabs: ["予定"], zoom: 1.1, pct: "110%" } },
  ["ふつうの大きさ", "ページの字が大きくなった"]),
  item("br.zoom-out", "br", "A", "ページを小さく表示する", {
    ctrl: P([["Ctrl", "-"]], ["ctrl+?shift+minus"], ["web-g", "web-e"], { note: ZOOM_NOTE }),
    cmd: P([["⌘", "-"]], ["meta+?shift+minus"], ["web-g", "web-s"], { note: ZOOM_NOTE })
  }, { k: "web", a: { tabs: ["予定"], zoom: 1 }, b: { tabs: ["予定"], zoom: 0.9, pct: "90%" } },
  ["ふつうの大きさ", "ページの字が小さくなった"]),
  item("br.zoom-reset", "br", "B", "表示の大きさを元に戻す", {
    ctrl: P([["Ctrl", "0"]], ["ctrl+0"], ["web-g", "web-e"]),
    cmd: P([["⌘", "0"]], ["meta+0"], ["web-g"])
  }, { k: "web", a: { tabs: ["予定"], zoom: 1.3, pct: "130%" }, b: { tabs: ["予定"], zoom: 1, pct: "100%" } },
  ["字が大きくなっている", "元の 100% に戻った"]),
  item("br.bookmark", "br", "B", "いまのページをブックマークに入れる", {
    ctrl: P([["Ctrl", "D"]], ["ctrl+d"], ["web-g", "web-e"]),
    cmd: P([["⌘", "D"]], ["meta+d"], ["web-g"])
  }, { k: "web", a: { tabs: ["予定"], star: false }, b: { tabs: ["予定"], star: true } },
  ["星の印が空", "星の印が付き、ブックマークに入った"]),
  item("br.history", "br", "B", "閲覧の履歴を開く", {
    ctrl: P([["Ctrl", "H"]], ["ctrl+h"], ["web-g", "web-e"]),
    cmd: P([["⌘", "Y"]], ["meta+y"], ["web-g"])
  }, { k: "web", a: { tabs: ["予定"] }, b: { tabs: ["予定"], panel: "history" } },
  ["ページを開いている", "見たページの履歴の一覧が出た"]),
  item("br.downloads", "br", "B", "ダウンロードの一覧を開く", {
    ctrl: C([["Ctrl", "J"]], "browser", ["web-g", "web-e"]),
    cmd: C([["⌥", "⌘", "L"], ["⇧", "⌘", "J"]], "differ", ["web-g", "web-e"], { note: "ブラウザによって組が違う（⌥ + ⌘ + L か ⇧ + ⌘ + J）。" })
  }, { k: "web", a: { tabs: ["予定"] }, b: { tabs: ["予定"], panel: "downloads" } },
  ["ページを開いている", "ダウンロードした物の一覧が出た"]),
  item("br.private-window", "br", "B", "履歴を残さない新しいウィンドウを開く", {
    ctrl: C([["Ctrl", "Shift", "N"]], "browser", ["web-g", "web-e"]),
    cmd: C([["⇧", "⌘", "N"]], "browser", ["web-g"])
  }, { k: "web", a: { tabs: ["予定"] }, b: { tabs: ["新規"], dark: true } },
  ["ふつうのウィンドウ", "履歴を残さない暗いウィンドウが開いた"]),
  item("br.scroll-page", "br", "B", "ページを 1 画面ずつ下へ（上へは Shift 付き）", {
    ctrl: P([["Space"], ["Shift", "Space"]], ["Space", "shift+Space"], ["web-g", "web-e", "os-ctrl"], { also: ["PageDown", "PageUp"], alt: [["PgDn"], ["PgUp"]], note: "ほかに PgDn・PgUp でも同じ。" }),
    cmd: P([["Space"], ["⇧", "Space"]], ["Space", "shift+Space"], ["web-g", "web-s", "os-cmd"], { also: ["PageDown", "PageUp"], alt: [["Fn", "↓"], ["Fn", "↑"]], note: "ほかに Fn + ↓・Fn + ↑ でも同じ。" })
  }, { k: "web", a: { tabs: ["予定"], scroll: 0 }, b: { tabs: ["予定"], scroll: 1 } },
  ["ページの頭を見ている", "1 画面ぶん下へ進んだ"], "ページを 1 画面ずつ動かす")
];

function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

export const SHORTCUTS = deepFreeze(ITEMS);
