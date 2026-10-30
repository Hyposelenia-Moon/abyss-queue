/**
 * 清榜周期（纯函数）
 *
 * 三个固定榜 + 一个长期枪战：
 *   - 幻想真境剧诗：每月 1 日 04:00 清空全部成员行，上月最后一天 12:00 提醒。
 *   - 深境螺旋：每月 1–15 日等待开启，15 日 12:00 提醒，16 日 04:00 清排队/已完成并翻等待行。
 *   - 幽境危战：42 天一轮（9/30、11/11、12/23 …），清榜在第 34 天 04:00，下一轮第 42 天 10:00。
 *   - 绝境攻炼：长期开放，版更日 10:00 只清已完成；版更前一日 12:00 提醒；按 11/04 起 42 天。
 *
 * 这里只算「什么时候该做什么」，不读写文件、不访问网络。
 */

export const SHEET_DRAMA = "幻想真境剧诗"
export const SHEET_ABYSS = "深境螺旋"
export const SHEET_STYGIAN = "幽境危战"
export const SHEET_ATTACK = "绝境攻炼"

const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

/** 本地时间构造（月份从 0 开始，保持 Date 口径） */
const local = (y, m, d, h = 0, min = 0) => new Date(y, m, d, h, min, 0, 0)
const startOfDay = date => local(date.getFullYear(), date.getMonth(), date.getDate())
const daysInMonth = date => new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
const monthKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`
/** 某月前一个月（用于“1 日清的是上个月”） */
const previousMonthKey = date => {
  const d = new Date(date.getFullYear(), date.getMonth() - 1, 1)
  return monthKey(d)
}
const dayKey = date =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`

/** 幽境危战第 1 个（7.1）周期：2026-09-30 10:00；每 42 天一轮 */
export const STYGIAN_ANCHOR = local(2026, 8, 30, 10)
export const STYGIAN_PERIOD_DAYS = 42
/** 周期开始后第 34 天 04:00 清榜；第 42 天 10:00 下一轮 */
export const STYGIAN_CLEAR_DAY = 34
export const STYGIAN_PERIOD_MS = STYGIAN_PERIOD_DAYS * DAY_MS

/** 枪战版更：2026-11-04 10:00，每 42 天 */
export const ATTACK_ANCHOR = local(2026, 10, 4, 10)
export const ATTACK_PERIOD_DAYS = 42
export const ATTACK_PERIOD_MS = ATTACK_PERIOD_DAYS * DAY_MS

/**
 * 某个时刻所在的幽境危战周期。
 * @returns {{index:number,start:Date,clear:Date,reminder:Date,nextStart:Date}}
 */
export function stygianCycle(now = new Date()) {
  const at = new Date(now)
  const index = Math.floor((at.getTime() - STYGIAN_ANCHOR.getTime()) / STYGIAN_PERIOD_MS)
  const start = new Date(STYGIAN_ANCHOR.getTime() + index * STYGIAN_PERIOD_MS)
  const clear = new Date(start.getTime() + STYGIAN_CLEAR_DAY * DAY_MS)
  clear.setHours(4, 0, 0, 0)
  const nextStart = new Date(start.getTime() + STYGIAN_PERIOD_MS)
  const reminder = new Date(clear.getTime() - DAY_MS)
  reminder.setHours(12, 0, 0, 0)
  return { index, start, clear, reminder, nextStart }
}

/**
 * 枪战版更周期（开始日 10:00）。
 * @returns {{index:number,lastStart:Date,nextStart:Date,reminder:Date}}
 */
export function attackCycle(now = new Date()) {
  const at = new Date(now)
  const index = Math.floor((at.getTime() - ATTACK_ANCHOR.getTime()) / ATTACK_PERIOD_MS)
  const current = new Date(ATTACK_ANCHOR.getTime() + index * ATTACK_PERIOD_MS)
  const past = at.getTime() >= current.getTime()
  const lastStart = past ? current : new Date(current.getTime() - ATTACK_PERIOD_MS)
  const nextStart = past ? new Date(current.getTime() + ATTACK_PERIOD_MS) : current
  const reminder = new Date(nextStart.getTime() - DAY_MS)
  reminder.setHours(12, 0, 0, 0)
  return { index, lastStart, nextStart, reminder }
}

/** 最近一次清榜 / 下一次清榜（剧诗：1 日 04:00；提醒为下一次清榜前一个月最后一天 12:00） */
export function dramaCycle(now = new Date()) {
  const at = new Date(now)
  const thisClear = local(at.getFullYear(), at.getMonth(), 1, 4)
  const pastThis = at.getTime() >= thisClear.getTime()
  const lastClear = pastThis ? thisClear : local(at.getFullYear(), at.getMonth() - 1, 1, 4)
  const nextClear = pastThis ? local(at.getFullYear(), at.getMonth() + 1, 1, 4) : thisClear
  const beforeNext = new Date(nextClear.getFullYear(), nextClear.getMonth(), 0)
  const reminder = local(beforeNext.getFullYear(), beforeNext.getMonth(), beforeNext.getDate(), 12)
  return { clear: nextClear, lastClear, nextClear, reminder, month: monthKey(at) }
}

/** 当月 16 日 04:00 / 15 日 12:00（深渊） */
export function abyssCycle(now = new Date()) {
  const at = new Date(now)
  const clear = local(at.getFullYear(), at.getMonth(), 16, 4)
  const reminder = local(at.getFullYear(), at.getMonth(), 15, 12)
  return { clear, reminder, month: monthKey(at) }
}

/**
 * 三榜当前阶段：给编辑器/插件做“新行默认状态”。
 * 只返回剧情状态，不负责清表。
 */
export function phaseOf(sheet, now = new Date()) {
  const at = new Date(now)
  if (sheet === SHEET_DRAMA) return "queued"
  if (sheet === SHEET_ABYSS) {
    const c = abyssCycle(at)
    return at.getTime() >= c.clear.getTime() ? "queued" : "waiting"
  }
  if (sheet === SHEET_STYGIAN) {
    const c = stygianCycle(at)
    if (at.getTime() >= c.start.getTime() && at.getTime() < c.clear.getTime()) return "queued"
    return "waiting"
  }
  return "queued"
}

/**
 * 清榜提醒前核查窗口：提醒时间前 1 小时内，只对三张有清榜动作的榜生效。
 * 枪战长期开放，不做完成核查。
 *
 * @param {Date} now
 * @returns {Array<{sheet:string,type:"verify",at:Date,targetAt:Date,round:string}>}
 */
export function precheckEvents(now = new Date()) {
  const at = new Date(now)
  const out = []
  const add = (sheet, reminder, round) => {
    const start = new Date(reminder.getTime() - 60 * 60 * 1000)
    if (at.getTime() >= start.getTime() && at.getTime() < reminder.getTime())
      out.push({ sheet, type: "verify", at: start, targetAt: reminder, round })
  }

  {
    const c = dramaCycle(at)
    add(SHEET_DRAMA, c.reminder, previousMonthKey(c.nextClear))
  }
  {
    const c = abyssCycle(at)
    add(SHEET_ABYSS, c.reminder, monthKey(c.clear))
  }
  {
    const c = stygianCycle(at)
    add(
      SHEET_STYGIAN,
      c.reminder,
      `${c.start.getFullYear()}-${String(c.start.getMonth() + 1).padStart(2, "0")}-${String(c.start.getDate()).padStart(2, "0")}`,
    )
  }
  return out
}

/** 某个事件是否在可补做窗口内（防首次部署把很久以前的事件重放） */
const recent = (at, now, windowMs = 36 * 60 * 60 * 1000) =>
  at.getTime() <= now.getTime() && now.getTime() - at.getTime() <= windowMs

/**
 * 本轮 tick 要处理的清榜/提醒/翻状态事件。
 *
 * 只给出最近 36 小时内的到期事件；正常 3 分钟一轮足够。
 * 返回事件按时间升序，调用方按顺序处理并用 state 去重。
 *
 * @param {Date} now
 * @returns {Array<{sheet:string,type:"reminder"|"clear"|"start"|"update",at:Date,round:string}>}
 */
export function cycleEvents(now = new Date()) {
  const at = new Date(now)
  const out = []

  /** 剧诗：1 日清上个月；下一次清榜前一个月最后一天提醒 */
  {
    const c = dramaCycle(at)
    if (recent(c.reminder, at) && at < c.nextClear) {
      out.push({
        sheet: SHEET_DRAMA,
        type: "reminder",
        at: c.reminder,
        targetAt: c.nextClear,
        round: previousMonthKey(c.nextClear),
      })
    }
    if (recent(c.lastClear, at)) {
      out.push({
        sheet: SHEET_DRAMA,
        type: "clear",
        at: c.lastClear,
        round: previousMonthKey(c.lastClear),
      })
    }
  }

  /** 深渊：本月 16 日清榜；15 日提醒；上月 16 日补做 */
  {
    const c = abyssCycle(at)
    const prev = new Date(at.getFullYear(), at.getMonth() - 1, 1)
    const prevC = abyssCycle(prev)
    if (recent(prevC.reminder, at) && at < prevC.clear)
      out.push({ sheet: SHEET_ABYSS, type: "reminder", at: prevC.reminder, targetAt: prevC.clear, round: monthKey(prev) })
    if (recent(prevC.clear, at)) out.push({ sheet: SHEET_ABYSS, type: "clear", at: prevC.clear, round: monthKey(prev) })
    if (recent(c.reminder, at) && at < c.clear)
      out.push({ sheet: SHEET_ABYSS, type: "reminder", at: c.reminder, targetAt: c.clear, round: c.month })
    if (recent(c.clear, at)) out.push({ sheet: SHEET_ABYSS, type: "clear", at: c.clear, round: c.month })
  }

  /** 危战：清榜 + 下一轮开始翻等待行；上一轮补做 */
  for (const back of [1, 0]) {
    const ref = new Date(at.getTime() - back * STYGIAN_PERIOD_MS)
    const c = stygianCycle(ref)
    const round = `${c.start.getFullYear()}-${String(c.start.getMonth() + 1).padStart(2, "0")}-${String(c.start.getDate()).padStart(2, "0")}`
    if (recent(c.reminder, at) && at < c.clear)
      out.push({ sheet: SHEET_STYGIAN, type: "reminder", at: c.reminder, targetAt: c.clear, round })
    if (recent(c.clear, at)) out.push({ sheet: SHEET_STYGIAN, type: "clear", at: c.clear, round })
    if (recent(c.nextStart, at)) out.push({ sheet: SHEET_STYGIAN, type: "start", at: c.nextStart, round })
  }

  /** 枪战：版更日只清已完成 + 空预设转实；前一天提醒 */
  {
    const c = attackCycle(at)
    if (recent(c.reminder, at) && at < c.nextStart) {
      out.push({
        sheet: SHEET_ATTACK,
        type: "reminder",
        at: c.reminder,
        targetAt: c.nextStart,
        round: dayKey(c.nextStart),
      })
    }
    if (recent(c.lastStart, at)) {
      out.push({ sheet: SHEET_ATTACK, type: "update", at: c.lastStart, round: dayKey(c.lastStart) })
    }
  }

  return out.sort((a, b) => a.at - b.at)
}

/**
 * 给测试与调用方用的日期展示（本地时区）。
 * @param {Date} date
 */
export const fmt = date => {
  const d = new Date(date)
  const p = n => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

