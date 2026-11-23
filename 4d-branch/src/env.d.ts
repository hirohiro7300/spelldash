// ビルドの切り替え（src/demo/pageBundle.ts）の型
interface ImportMetaEnv {
  /** "0" のとき、3 か月ごとの地図をページに入れない（版 6 だけのページ）。"1" と IMPACT_Q_BUNDLE で生成の候補を入れる。無ければ同梱の版 7 */
  readonly VITE_IMPACT_Q?: string;
}

declare module "@impact-q-bundle?raw" {
  const b64: string;
  export default b64;
}

declare module "@impact-q-release?raw" {
  const json: string;
  export default json;
}
