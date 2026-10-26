// 台本が直接呼ばれたか（node scripts/x.mjs）。tests/e2e.mjs・単体の検査が値を読むために import しただけなら false（Chromium を立ち上げない・書かない）。
// symlink を含むパスで呼ばれても実体のパスでそろえて比べる。使い方: if (isMain(import.meta.url)) await main();
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const realOf = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
export const isMain = (metaUrl) => !!process.argv[1] && realOf(path.resolve(process.argv[1])) === realOf(fileURLToPath(metaUrl));
