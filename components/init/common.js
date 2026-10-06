/**
 * 三步共用的常量与小工具
 *
 * 只有**跨步骤**的东西放这里：步骤标题、状态构造器、报告用的路径 / 脱敏 / 单行化。
 * 只被单一步骤用到的（如 remote 段解析）留在那个步骤自己的文件里。
 */
import path from "node:path"
import { randomBytes } from "node:crypto"

/** 编辑器默认端口（与 `editor/config.js` 的 `DEFAULTS.port` 一致） */
export const DEFAULT_PORT = 7788

/** 探活的超时：几秒即可，编辑器不在就直接跳过这一步 */
export const PROBE_TIMEOUT_MS = 5000

/** 三步的标题（顺序即执行顺序；"未做"列表也按它报） */
export const STEP_TITLES = ["访问口令 / 签名密钥", "编辑器白名单", "编辑器探活"]

export const OK = detail => ({ status: "done", detail })
export const SKIP = detail => ({ status: "skip", detail })
export const FAIL = detail => ({ status: "fail", detail })

/** 报告里的路径：在插件根里就写相对路径（不把主人的盘符路径发到群里） */
export const rel = (ctx, p) => {
  const r = path.relative(ctx.pluginRoot, p)
  return r && !r.startsWith("..") ? r.replace(/\\/g, "/") : p
}

/**
 * 报告里怎么描述一个口令 / 地址
 *
 * 只说"前几位 + 长度"是不够的：一个「空值 + 行尾注释」的长串会被显示成
 * `已有 remote.token ""  …（55 位）`——**看着像一条正常口令**，出了事也看不出来。
 * 含空白 / 引号 / 井号的值一律标成"可疑"。
 */
export const describeSecret = v => {
  const s = String(v ?? "")
  if (!s) return "（空）"
  if (/[\s"'#]/.test(s)) return `（可疑：含空白或引号/井号，${s.length} 位 —— 请人工核对）`
  return `${s.slice(0, 4)}…（${s.length} 位）`
}

export const oneLine = s => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 200)

/** 随机 hex（口令 16 字节 / 签名密钥 24 字节，与工具的既有口径一致） */
export const randomHex = n => randomBytes(n).toString("hex")

/** 逗号分隔的步骤号列表（报告里"未做：3、4、5"） */
export const list = arr => arr.join("、")
