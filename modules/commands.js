/** 查询类指令的**唯一定义**（纯函数，不依赖 Yunzai / 文件系统） */
import { SHEET_ALIASES_KEYS, SHEETS } from "../components/constants.js"

export const SHEET_CMD_NAMES = [...SHEETS, ...SHEET_ALIASES_KEYS]

export const SHEET_CMD_ARG = `(?:${SHEET_CMD_NAMES.join("|")}|\\d+)`

export const SHEET_CMD_REGEX = `^(?:#排队(?:\\s+(${SHEET_CMD_ARG}))?|#(${SHEET_CMD_NAMES.join("|")})(?:排队|列表))$`

export function matchSheetCommand(msg) {
  const m = new RegExp(SHEET_CMD_REGEX).exec(String(msg ?? "").trim())
  if (!m) return null
  return { name: (m[1] ?? m[2] ?? "").trim() }
}
