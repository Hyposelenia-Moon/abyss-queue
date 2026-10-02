/**
 * 工具函数（纯函数，不依赖 Yunzai / 文件系统，可独立测试）
 */
import { SHEET_ALIASES, SHEETS } from "../components/constants.js"

/** 用户输入问题（预期内的失败）：直接回复原因，不当成程序异常 */
export class ValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = "ValidationError"
  }
}

/** 表名顺序：配置里认识的榜优先，其余按表内顺序 */
export function sheetChoices(models) {
  const known = SHEETS.filter(n => models.has(n))
  return known.length ? known : [...models.keys()]
}

/** 把用户输入解析成表名：完整名 / 简称 / 序号 / 唯一的包含匹配 */
export function resolveSheet(input, models) {
  const text = String(input ?? "").trim()
  if (!text) return null
  if (models.has(text)) return text

  /** 简称（#排队 危战 / #危战排队） */
  const aliased = SHEET_ALIASES[text]
  if (aliased && models.has(aliased)) return aliased

  const choices = sheetChoices(models)
  const idx = Number(text)
  if (Number.isInteger(idx) && idx >= 1 && idx <= choices.length) return choices[idx - 1]
  const hit = choices.filter(n => n.includes(text) || text.includes(n))
  return hit.length === 1 ? hit[0] : null
}
