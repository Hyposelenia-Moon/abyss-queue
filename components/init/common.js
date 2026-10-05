/**
 * 五步共用的常量与小工具
 *
 * 只有**跨步骤**的东西放这里：步骤标题、状态构造器、报告用的路径 / 脱敏 / 单行化。
 * 只被单一步骤用到的（如任务 XML、remote 段解析）留在那个步骤自己的文件里。
 */
import path from "node:path"
import { randomBytes } from "node:crypto"

/** 计划任务名（`启动排队表编辑器.vbs` 里是同一个常量，两处必须一致） */
export const TASK_NAME = "AbyssQueueEditor"

/** 编辑器默认端口（与 editor-launch.mjs / editor.mjs 的默认值一致） */
export const DEFAULT_PORT = 7788

/** 探活的超时：几秒即可，编辑器不在就直接跳过这一步 */
export const PROBE_TIMEOUT_MS = 5000

/** 五步的标题（顺序即执行顺序；"未做"列表也按它报） */
export const STEP_TITLES = ["访问口令 / 签名密钥", "启动器产物", "编辑器白名单", "计划任务", "编辑器探活"]

export const OK = detail => ({ status: "done", detail })
export const SKIP = detail => ({ status: "skip", detail })
export const FAIL = detail => ({ status: "fail", detail })

/** 报告里的路径：在插件根里就写相对路径（不把主人的盘符路径发到群里） */
export const rel = (ctx, p) => {
  const r = path.relative(ctx.pluginRoot, p)
  return r && !r.startsWith("..") ? r.replace(/\\/g, "/") : p
}

/**
 * Windows 路径比较（大小写不敏感、忽略结尾斜杠）
 *
 * 这套东西本来就是 Windows 专用的（vbs / schtasks），所以按 Windows 的规矩比。
 */
export const samePath = (a, b) =>
  path.resolve(String(a ?? "")).replace(/[\\/]+$/, "").toLowerCase() ===
  path.resolve(String(b ?? "")).replace(/[\\/]+$/, "").toLowerCase()

/** 密钥只报前几位（报告可能发在群里，不能把口令整条打出去） */
export const mask = v => (v ? `${String(v).slice(0, 4)}…（${String(v).length} 位）` : "（空）")

export const oneLine = s => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 200)

/** 随机 hex（口令 16 字节 / 签名密钥 24 字节，与工具的既有口径一致） */
export const randomHex = n => randomBytes(n).toString("hex")

/** 逗号分隔的步骤号列表（报告里"未做：3、4、5"） */
export const list = arr => arr.join("、")
