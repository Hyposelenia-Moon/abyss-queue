/**
 * 排队进度的判定与变化检测（纯函数，可独立测试）
 *
 * 「帮帮完成情况」这一列里出现的东西分三类：
 *   等待开启  —— 这个榜还没开（深境螺旋没开时整榜都是它），既不算排队也不算完成
 *   排队中    —— 还在等主播（还没轮到他）
 *   其它任何值 —— 主播名、本人已完成……都表示这一位已经处理过了
 * 项目的三个功能都建立在这个约定上：月度催办只找「排队中」的人，
 * 上一位完成后要 @ 的下一位也是「排队中」的人。
 */

const clean = s => String(s ?? "").trim()

/** 整榜还没开 */
export const WAITING = "等待开启"
/** 还在排队 */
export const QUEUED = "排队中"
/** 填表的人给自己选的「我完成了」：编辑器会把它落成该行的群昵称，表里也可能直接手选到这个字面值 */
export const SELF_DONE = "本人已完成"

/**
 * 「帮帮完成情况」显示成什么
 *
 * 「本人已完成」看不出是谁完成的，所以显示时按这一行自己的群昵称显示
 * （编辑器落表时也会写成昵称；这里兜的是表里还留着字面值的老数据）。
 * 多选（"阿修Axiu,本人已完成"）逐个值都换。
 */
export const statusLabel = (status, nickname) => {
  const parts = clean(status)
    .split(/[,，]/)
    .map(s => s.trim())
    .filter(Boolean)
  if (!parts.includes(SELF_DONE)) return parts.join(",")
  const nick = clean(nickname)
  if (!nick) return parts.join(",")
  return [...new Set(parts.map(p => (p === SELF_DONE ? nick : p)))].join(",")
}

/** 这一位是否已经处理过（非空、且不是「等待开启」「排队中」） */
export const isDone = status => {
  const s = clean(status)
  return Boolean(s) && s !== WAITING && s !== QUEUED
}

/** 这一位是否还在排队（含状态为空的老数据） */
export const isPending = status => !isDone(status) && clean(status) !== WAITING

/** 这一行是否在排队 */
const rowPending = row => isPending(row?.status)
const rowDone = row => isDone(row?.status)

/** 行标识：状态变化检测与去重都用它 */
export const rowKey = (sheet, row) => `${sheet}#${row}`

/**
 * 取一张表的进度快照
 * @returns {Object<string, {sheet, row, seq, nickname, status, done}>}
 */
export function snapshot(models) {
  const state = {}
  for (const model of models) {
    for (const r of model.rows ?? []) {
      if (!clean(r.nickname)) continue
      state[rowKey(model.name, r.row)] = {
        sheet: model.name,
        row: r.row,
        seq: clean(r.seq) || String(r.row),
        nickname: clean(r.nickname),
        status: clean(r.status),
        done: rowDone(r),
      }
    }
  }
  return state
}

/**
 * 对比前后两份快照，找出「刚刚完成」的行
 *
 * 只认「上一次还没完成 → 这一次完成了」的转变：
 *   - 快照里原本没有的行（新加的、且一加上就是已完成）不通知
 *   - 状态一直没变的不通知
 * @returns {Array<{sheet, row, seq, nickname, status}>}
 */
export function detectCompletions(prev = {}, next = {}) {
  const out = []
  for (const [key, now] of Object.entries(next)) {
    const before = prev[key]
    if (!before) continue
    if (before.done || !now.done) continue
    if (before.status === now.status) continue
    out.push({ sheet: now.sheet, row: now.row, seq: now.seq, nickname: now.nickname, status: now.status })
  }
  return out.sort((a, b) => a.sheet.localeCompare(b.sheet, "zh") || a.row - b.row)
}

/**
 * 同一张表里、这一行之后下一个还在排队的人
 * @param {object} model 榜模型
 * @param {number} row 已完成的那个人的行号
 * @returns {object|null} `model.rows` 里的那一行
 */
export function nextPending(model, row) {
  const rows = (model.rows ?? []).filter(r => clean(r.nickname)).sort((a, b) => a.row - b.row)
  const i = rows.findIndex(r => r.row === row)
  if (i < 0) return null
  for (let j = i + 1; j < rows.length; j++) if (rowPending(rows[j])) return rows[j]
  return null
}

/**
 * 各榜还在排队的人（月度催办用）
 * @returns {Array<{sheet, name, rows: Array<{row, seq, nickname}>}>} 没有人在排的榜不返回
 */
export function pendingBySheet(models) {
  const out = []
  for (const model of models) {
    const rows = (model.rows ?? [])
      .filter(r => clean(r.nickname) && rowPending(r))
      .sort((a, b) => a.row - b.row)
      .map(r => ({ row: r.row, seq: clean(r.seq) || String(r.row), nickname: clean(r.nickname) }))
    if (rows.length) out.push({ sheet: model.name, name: model.name, rows })
  }
  return out
}

/** 当月最后一天（本地时区） */
export function isLastDayOfMonth(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
  return next.getDate() === 1
}
