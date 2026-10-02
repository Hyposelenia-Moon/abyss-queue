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

/**
 * 找出这个人的行号（0 = 没找到）
 *
 * 填表已移到本地编辑器，不再产生 QQ 绑定，所以：
 *   1. 先看绑定（老数据仍兼容，绑定失效则忽略）
 *   2. 兜底按群昵称匹配：表内某行昵称等于他的群名片/昵称，就认作他本人
 * @returns {number} 表格行号；0 表示没匹配到
 */
export function myRowOf(model, store, sheet, qq, nickname) {
  if (!model) return 0
  const bind = store?.get?.(sheet, qq)
  if (bind && rowMatches(model, bind.row, bind.nickname)) return bind.row
  const nick = clean(nickname)
  if (!nick) return 0
  const hit = model.rows.find(r => clean(r.nickname) === nick)
  return hit ? hit.row : 0
}

/** 队列（按表内顺序） */
export function listQueue(model, { limit = 0, status = "" } = {}) {
  let list = model.rows.filter(i => clean(i.nickname))
  if (status) list = list.filter(i => i.status === status)
  return limit > 0 ? list.slice(0, limit) : list
}

/** 报名要写入的单元格内容（编辑器保存时用的同一套映射） */
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
