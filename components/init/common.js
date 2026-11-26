/** 三步共用的常量与小工具 */
import path from "node:path"
import { randomBytes } from "node:crypto"

export const PROBE_TIMEOUT_MS = 5000

export const STEP_TITLES = ["访问口令 / 签名密钥", "编辑器白名单", "编辑器探活"]

export const OK = detail => ({ status: "done", detail })
export const SKIP = detail => ({ status: "skip", detail })
export const FAIL = detail => ({ status: "fail", detail })

export const rel = (ctx, p) => {
  const r = path.relative(ctx.pluginRoot, p)
  return r && !r.startsWith("..") ? r.replace(/\\/g, "/") : p
}

export const describeSecret = v => {
  const s = String(v ?? "")
  if (!s) return "（空）"
  if (/[\s"'#]/.test(s)) return `（可疑：含空白或引号/井号，${s.length} 位 —— 请人工核对）`
  return `${s.slice(0, 4)}…（${s.length} 位）`
}

export const oneLine = s => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 200)

export const randomHex = n => randomBytes(n).toString("hex")

export const list = arr => arr.join("、")
