// 操作ガイド: 画面の各領域を順に照らして説明する（スキップ可・? から再表示）

import type { AppContext } from "../app/context";
import { MOD, h } from "./dom";
import { icon } from "./icons";

interface Step {
  title: string;
  body: string;
  /** 照らす要素（セレクタ）。ノードを照らすときは node に ID の一部 */
  target?: string;
  node?: () => string | null;
  before?: () => void;
  place?: "right" | "left" | "top" | "bottom" | "center";
}

export function startTour(app: AppContext): void {
  const { store, ui, view } = app;
  const findHub = (): string | null => {
    const doc = store.doc;
    const demo = doc.nodes["n_demo_learn_ads"];
    if (demo) return demo.id;
    // いちばん多くのプロジェクトに属し、線の多いノード
    let best: { id: string; score: number } | null = null;
    for (const id in doc.nodes) {
      const n = doc.nodes[id]!;
      const score = n.projectIds.length * 10 + (app.vm.index.out.get(id)?.length ?? 0);
      if (!best || score > best.score) best = { id, score };
    }
    return best?.id ?? null;
  };
  const steps: Step[] = [
    {
      title: "プロジェクトは「所属」",
      body: "3 つのプロジェクトが 1 つのグラフを共有しています。押すとそのプロジェクトが強調され、⌘／Ctrl クリックで複数を選べます。🔗 の数字は、ほかのプロジェクトと共有しているノードの数です。",
      target: '.sidebar-left [data-section="projects"]',
      place: "right",
    },
    {
      title: "無限のキャンバス",
      body: `ドラッグ・2 本指スクロールで移動、ピンチ（${MOD}＋スクロール）で拡大縮小。空いている所をダブルクリックするとノードを作れます。縮小すると全体の形が見えます。`,
      target: ".canvas-wrap",
      place: "center",
      before: () => {
        ui.setPrefs({ view: "map" });
        ui.clearSelection();
        view.fit();
      },
    },
    {
      title: "つなぐ・分岐する・合流する",
      body: "ノードを選ぶと、そこへ至る道と、そこから広がる未来が光ります。ノード右の ● をドラッグして別のノードで離すと接続、何もない所で離すと新しい分岐ができます（Tab でも）。複数のノードを選んで「合流ノードを作る」もできます。",
      node: findHub,
      place: "right",
      before: () => {
        const id = findHub();
        if (id) {
          ui.select([id]);
          view.centerOn(id, { zoom: 0.9, animate: false });
        }
      },
    },
    {
      title: "詳細はここで",
      body: "選んだノードの文章・期限・条件・タグ・所属プロジェクト・シナリオを編集します。「つながり」から前後のノードへ移れます。",
      target: ".sidebar-right",
      place: "left",
    },
    {
      title: "検索・追加・元に戻す",
      body: `${MOD}K で検索（#タグ でタグ検索）。＋目標・＋行動・＋分岐・＋結果で追加。間違えても ${MOD}Z で元に戻せます。「表示」から線の出し方などを切り替えられます。`,
      target: ".topbar",
      place: "bottom",
    },
    {
      title: "時間軸とシナリオ",
      body: "時間軸を押すと、その日までに起きることだけが明るくなります。▶ で今日から未来へ再生。右のシナリオを切り替えると、そのシナリオで進む分岐だけが明るくなります。",
      target: ".bottombar",
      place: "top",
      before: () => ui.clearSelection(),
    },
    {
      title: "保存とバックアップ",
      body: "変更は自動でこのブラウザに保存され、10 分ごと・毎日のバックアップも残ります。ほかの場所にも残すには、メニューから JSON で書き出してください。",
      target: ".save-status",
      place: "bottom",
    },
  ];

  document.querySelector(".tour")?.remove();
  const hole = h("div", { class: "tour-hole" });
  const card = h("div", { class: "tour-card", role: "dialog", attrs: { "aria-live": "polite", "aria-label": "操作ガイド" } });
  const layer = h("div", { class: "tour" }, hole, card);
  (document.getElementById("overlay-root") ?? document.body).append(layer);
  let i = 0;

  const close = () => {
    layer.remove();
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", place);
    ui.setPrefs({ onboardingDone: true });
    app.afterTour?.();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      close();
    } else if (ev.key === "ArrowRight" || ev.key === "Enter") {
      ev.preventDefault();
      ev.stopPropagation();
      go(i + 1);
    } else if (ev.key === "ArrowLeft") {
      ev.preventDefault();
      ev.stopPropagation();
      go(i - 1);
    }
  };

  const rectOf = (s: Step): DOMRect | null => {
    if (s.node) {
      const id = s.node();
      const n = id ? store.doc.nodes[id] : null;
      if (!n) return null;
      const cr = view.canvas.getBoundingClientRect();
      const z = view.camera.zoom;
      const p = view.camera.toScreen(n.x, n.y);
      return new DOMRect(cr.left + p.x - 120 * z - 14, cr.top + p.y - 52 * z - 14, 240 * z + 28, 104 * z + 28);
    }
    const el = s.target ? document.querySelector<HTMLElement>(s.target) : null;
    return el ? el.getBoundingClientRect() : null;
  };

  const place = () => {
    const s = steps[i]!;
    const r = rectOf(s);
    const pad = 6;
    if (r) {
      hole.style.left = `${r.left - pad}px`;
      hole.style.top = `${r.top - pad}px`;
      hole.style.width = `${r.width + pad * 2}px`;
      hole.style.height = `${r.height + pad * 2}px`;
      hole.hidden = false;
    } else hole.hidden = true;
    const cw = Math.min(360, window.innerWidth - 32);
    card.style.width = `${cw}px`;
    const ch = card.getBoundingClientRect().height || 200;
    let left = (window.innerWidth - cw) / 2;
    let top = (window.innerHeight - ch) / 2;
    if (r && s.place !== "center") {
      if (s.place === "right") {
        left = r.right + 18;
        top = r.top + Math.min(40, r.height / 4);
      } else if (s.place === "left") {
        left = r.left - cw - 18;
        top = r.top + 60;
      } else if (s.place === "bottom") {
        left = Math.min(r.left, window.innerWidth - cw - 16);
        top = r.bottom + 16;
      } else if (s.place === "top") {
        left = r.left + r.width / 2 - cw / 2;
        top = r.top - ch - 16;
      }
    } else if (r && s.place === "center") {
      top = r.top + r.height / 2 - ch / 2;
      left = r.left + r.width / 2 - cw / 2;
    }
    card.style.left = `${Math.max(16, Math.min(window.innerWidth - cw - 16, left))}px`;
    card.style.top = `${Math.max(16, Math.min(window.innerHeight - ch - 16, top))}px`;
  };

  const go = (k: number) => {
    if (k >= steps.length) return close();
    if (k < 0) return;
    i = k;
    const s = steps[i]!;
    s.before?.();
    card.innerHTML = "";
    const dots = h("div", { class: "tour-dots" }, ...steps.map((_, j) => h("span", { class: `tour-dot${j === i ? " on" : ""}` })));
    const back = h("button", { class: "btn btn-sm", type: "button", disabled: i === 0, onClick: () => go(i - 1) }, "戻る");
    const next = h("button", { class: "btn btn-sm btn-primary", type: "button", onClick: () => go(i + 1) }, i === steps.length - 1 ? "はじめる" : "次へ", i === steps.length - 1 ? null : icon("chevronRight", 14));
    card.append(
      h("div", { class: "tour-step" }, `${i + 1} / ${steps.length}`),
      h("h3", { class: "tour-title" }, s.title),
      h("p", { class: "tour-body" }, s.body),
      h("div", { class: "tour-foot" }, h("button", { class: "tour-skip", type: "button", onClick: close }, "スキップ"), dots, h("div", { class: "tour-nav" }, back, next)),
    );
    // カメラが動き終わってから位置を合わせる
    place();
    setTimeout(place, 60);
    setTimeout(place, 420);
    next.focus();
  };

  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", place);
  go(0);
}
