/** 榜名解析与用户输入错误类型（纯函数，不依赖 Yunzai / 文件系统，可独立测试） */
import { SHEET_ALIASES, SHEETS } from "../components/constants.js"

export class ValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = "ValidationError"
  }
}

export function sheetChoices(models) {
  const known = SHEETS.filter(n => models.has(n))
  return known.length ? known : [...models.keys()]
}

export function resolveSheet(input, models) {
  const text = String(input ?? "").trim()
  if (!text) return null
  if (models.has(text)) return text
  const aliased = SHEET_ALIASES[text]
  if (aliased && models.has(aliased)) return aliased
  const choices = sheetChoices(models)
  const idx = Number(text)
  if (Number.isInteger(idx) && idx >= 1 && idx <= choices.length) return choices[idx - 1]
  const hit = choices.filter(n => n.includes(text) || text.includes(n))
  return hit.length === 1 ? hit[0] : null
}
