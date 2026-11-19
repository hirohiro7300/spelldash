// 単体テストの準備（vitest.config.ts の setupFiles。どのテストのファイルでも、そのファイルを読む前に動く）:
// 同梱の地図を読み込んでおく。同期で読む口（futureData・futureVersion・futureRelease・buildFuture）は読み込む前に呼ぶと止まるので、
// ファイルの先頭で呼ぶテストもそのまま使えるように、ここで 1 度だけ待つ（src/demo/futureBundle.ts。見直し gaps-3）
import { loadImpactBundle } from "../../src/demo/futureBundle";

await loadImpactBundle();
