// 計算の芯（src/deepmap/core）の入口。試し版（src/preview）とアプリ（P2）の見取り図・道の画面はここから使う
//   compileMap(map)               地図を 1 回だけ型付き配列に組み直す（形と数の版を持つ）
//   analyze(cm, annual, opts)     年収ごとの値・おすすめの選び方・来る見込み（おすすめ・ずっと今のまま）
//   overview(a)                   見取り図の数（今日の手ごとの分布・差・分かること・今のままとの違い・数）
//   fanData / forkStrip(a, 手)    選んだ手の扇と分かれ道の帯
//   planView(a, 手)               進め方（3 か月ごとのおすすめの手と割合と理由）
//   walkPath(a, カード, 開いた所) 道の画面（一番ありそうな道・ほかの結果と手・静かな期のまとめ・標準の続き）
//   destinations(a, 手 | null)    行き先を種類ごとにまとめる
//   heatValues(a)                 カードごとの 3 年の合計 − ずっと今のまま（地図の塗り）

export * from "./compile";
export * from "./passes";
export * from "./stats";
export * from "./moves";
export * from "./fan";
export * from "./plan";
export * from "./path";
export * from "./dest";
export * from "./text";
export * from "./time";
