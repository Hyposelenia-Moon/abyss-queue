/**
 * 第 2 步：本地表格副本 —— **存在就绝不覆盖**（本机那份可能已经有数据）
 */
import { FAIL, OK, SKIP, rel } from "./shared.js"

export function stepLocalXlsx(ctx) {
  const { localXlsx, templateXlsx } = ctx.paths
  if (ctx.fs.existsSync(localXlsx)) return SKIP(`已存在（不覆盖）：${rel(ctx, localXlsx)}`)
  if (!ctx.fs.existsSync(templateXlsx))
    return FAIL(`找不到空模板：${rel(ctx, templateXlsx)}（插件里的 resources/空模板.xlsx 是不是没同步过去？）`)
  ctx.fs.copyFileSync(templateXlsx, localXlsx)
  return OK(`已从空模板复制：${rel(ctx, localXlsx)}`)
}
