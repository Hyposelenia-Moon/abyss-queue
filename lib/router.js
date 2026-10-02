/**
 * 工具函数（纯函数，不依赖 Yunzai / 文件系统，可独立测试）
 */
import { matchOption } from "./queue.js"
import { SHEETS } from "../components/constants.js"

/** 用户输入问题（预期内的失败）：直接回复原因，不当成程序异常 */
export class ValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = "ValidationError"
  }
}

/** 支持 「带空格的内容」/"..." 的单行参数切分 */
export function tokenize(text) {
  const out = []
  const re = /「([^」]*)」|"([^"]*)"|'([^']*)'|(\S+)/g
  let m
  while ((m = re.exec(text))) out.push(m[1] ?? m[2] ?? m[3] ?? m[4])
  return out
}

/** 表名顺序：配置里认识的榜优先，其余按表内顺序 */
export function sheetChoices(models) {
  const known = SHEETS.filter(n => models.has(n))
  return known.length ? known : [...models.keys()]
}

/** 把用户输入解析成表名：完整名 / 序号 / 唯一的包含匹配 */
export function resolveSheet(input, models) {
  const text = String(input ?? "").trim()
  if (!text) return null
  const choices = sheetChoices(models)
  if (models.has(text)) return text
  const idx = Number(text)
  if (Number.isInteger(idx) && idx >= 1 && idx <= choices.length) return choices[idx - 1]
  const hit = choices.filter(n => n.includes(text) || text.includes(n))
  return hit.length === 1 ? hit[0] : null
}

/** 带序号的选项提示（引导流程用） */
export const optionPrompt = (label, options) =>
  [`请选择${label}（回复序号或内容）：`, ...options.map((o, i) => `${i + 1}. ${o}`)].join("\n")

/** 未匹配到下拉选项时的提示：只列出与输入相关的候选，避免刷屏 */
export function optionNotice(label, input, options) {
  const text = String(input ?? "").trim()
  const related = text ? options.filter(o => o.includes(text) || text.includes(o)) : []
  const shown = related.length ? related : options
  return [
    related.length > 1 ? `${label}「${text}」对应多个选项，请回复序号：` : `${label}「${text}」不在下拉选项中，可选：`,
    ...shown.map(o => `· ${o}`),
    "回复序号或完整内容（多个候选时必须回复序号）",
  ].join("\n")
}

/** 把输入归一到下拉选项：唯一命中才采用；未命中或歧义返回 null */
export function normalizeChoice(input, options) {
  if (!options?.length) return String(input ?? "").trim()
  return matchOption(input, options)
}
