/**
 * 排队业务逻辑（纯函数，不依赖 Yunzai / 文件系统，可独立测试）
 */
import { DATA_COLUMNS } from "./schema.js"

const clean = s => String(s ?? "").trim()

/**
 * 把用户输入匹配到下拉选项
 * 支持：完整值、序号（1 起）、唯一的包含匹配
 */
export function matchOption(input, options = []) {
  const text = clean(input)
  if (!text || !options.length) return null
  const exact = options.find(o => o === text)
  if (exact) return exact

  const idx = Number(text)
  if (Number.isInteger(idx) && idx >= 1 && idx <= options.length) return options[idx - 1]

  const hits = options.filter(o => o.includes(text) || text.includes(o))
  if (hits.length === 1) return hits[0]
  return null
}

/** 第一个空行（B–H 全空） */
export function firstEmptyRow(model) {
  for (let r = model.dataStart; r <= model.dataEnd; r++) {
    const item = model.rows.find(i => i.row === r)
    if (!item) return r
    if (!DATA_COLUMNS.some(k => clean(item[k]))) return r
  }
  return null
}

/** 按群昵称找行（可能有重名，返回数组） */
export function findByNickname(model, nickname) {
  const text = clean(nickname)
  return model.rows.filter(i => clean(i.nickname) === text)
}

/** 某行是否还存在且内容未变（防止人工改表后指错行） */
export function rowMatches(model, row, nickname) {
  const item = model.rows.find(i => i.row === row)
  if (!item) return false
  return clean(item.nickname) === clean(nickname)
}

/** 队列（按表内顺序） */
export function listQueue(model, { limit = 0, status = "" } = {}) {
  let list = model.rows.filter(i => clean(i.nickname))
  if (status) list = list.filter(i => i.status === status)
  return limit > 0 ? list.slice(0, limit) : list
}

/** 校验报名数据 */
export function validateJoin(model, data) {
  const errors = []
  const nickname = clean(data.nickname)
  const gameName = clean(data.gameName)
  if (!nickname) errors.push("群昵称为空")
  if (!gameName) errors.push("原神游戏名不能为空")
  if (gameName.length > 40) errors.push("原神游戏名过长（≤40 字）")
  if (clean(data.note).length > 120) errors.push("备注过长（≤120 字）")

  for (const [key, label] of [
    ["anchor", "选择主播"],
    ["goal", "难度及目标"],
    ["strength", "账号强度"],
  ]) {
    const value = clean(data[key])
    const options = model.options[key]
    if (!value) {
      errors.push(`${label}不能为空`)
      continue
    }
    if (options?.length && !options.includes(value))
      errors.push(`${label}「${value}」不在下拉选项中：${options.join(" / ")}`)
  }
  return errors
}

/** 报名要写入的单元格内容 */
export function joinCells(model, data, defaultStatus) {
  const status = clean(data.status) || clean(defaultStatus) || model.options.status?.[0] || "排队中"
  return {
    nickname: clean(data.nickname),
    gameName: clean(data.gameName),
    anchor: clean(data.anchor),
    goal: clean(data.goal),
    strength: clean(data.strength),
    note: clean(data.note),
    status,
  }
}
