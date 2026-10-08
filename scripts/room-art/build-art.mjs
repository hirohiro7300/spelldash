// 線画の SVG（切石・肋・天井の星図・ルネット・歯飾り・帯）を assets/images/room に書き出す。
// 使い方: node scripts/room-art/build-art.mjs
import fs from "fs"; import path from "path";
import { ashlarSvg, ribSvg, vaultSvg, lunetteSvg, dentilSvg, friezeSvg } from "./ornament.mjs";
const OUT = "/home/user/spelldash/assets/images/room";
const files = {
  "ashlar.svg": ashlarSvg(false), "ashlar-dark.svg": ashlarSvg(true),
  "rib.svg": ribSvg(false), "rib-dark.svg": ribSvg(true),
  "vault.svg": vaultSvg(), "lunette.svg": lunetteSvg(), "dentil.svg": dentilSvg(), "frieze.svg": friezeSvg(),
};
for (const [name, svg] of Object.entries(files)) { fs.writeFileSync(path.join(OUT, name), svg); console.log(name, svg.length); }
