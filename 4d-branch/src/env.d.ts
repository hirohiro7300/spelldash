// ビルドの切り替え（src/demo/pageBundle.ts）の型
interface ImportMetaEnv {
  /** "1" のとき、3 か月ごとの地図（版 7 の候補）をページに入れる（開発と確かめのビルドだけ） */
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
