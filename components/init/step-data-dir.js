/**
 * 第 1 步：数据目录（固定在插件里：`<插件根>/data`）
 */
import { OK, SKIP, rel } from "./shared.js"

export function stepDataDir(ctx) {
  if (ctx.fs.existsSync(ctx.paths.dataDir)) return SKIP(`已存在：${rel(ctx, ctx.paths.dataDir)}`)
  ctx.fs.mkdirSync(ctx.paths.dataDir, { recursive: true })
  return OK(`已创建：${rel(ctx, ctx.paths.dataDir)}`)
}
