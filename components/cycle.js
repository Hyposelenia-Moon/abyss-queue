/** 清榜周期（纯函数） */

export const SHEET_DRAMA = "幻想真境剧诗"
export const SHEET_ABYSS = "深境螺旋"
export const SHEET_STYGIAN = "幽境危战"
export const SHEET_ATTACK = "绝境攻炼"

const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

const local = (y, m, d, h = 0, min = 0) => new Date(y, m, d, h, min, 0, 0)
const startOfDay = date => local(date.getFullYear(), date.getMonth(), date.getDate())
const daysInMonth = date => new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
const monthKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`

const previousMonthKey = date => {
  const d = new Date(date.getFullYear(), date.getMonth() - 1, 1)
  return monthKey(d)
}
const dayKey = date =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
export const STYGIAN_ANCHOR = local(2026, 8, 30, 10)
export const STYGIAN_PERIOD_DAYS = 42

export const STYGIAN_CLEAR_DAY = 34
export const STYGIAN_PERIOD_MS = STYGIAN_PERIOD_DAYS * DAY_MS

export const ATTACK_ANCHOR = local(2026, 10, 4, 10)
export const ATTACK_PERIOD_DAYS = 42
export const ATTACK_PERIOD_MS = ATTACK_PERIOD_DAYS * DAY_MS

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

export function abyssCycle(now = new Date()) {
  const at = new Date(now)
  const clear = local(at.getFullYear(), at.getMonth(), 16, 4)
  const reminder = local(at.getFullYear(), at.getMonth(), 15, 12)
  return { clear, reminder, month: monthKey(at) }
}

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

const recent = (at, now, windowMs = 36 * 60 * 60 * 1000) =>
  at.getTime() <= now.getTime() && now.getTime() - at.getTime() <= windowMs
export function cycleEvents(now = new Date()) {
  const at = new Date(now)
  const out = []
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
  for (const back of [1, 0]) {
    const ref = new Date(at.getTime() - back * STYGIAN_PERIOD_MS)
    const c = stygianCycle(ref)
    const round = `${c.start.getFullYear()}-${String(c.start.getMonth() + 1).padStart(2, "0")}-${String(c.start.getDate()).padStart(2, "0")}`
    if (recent(c.reminder, at) && at < c.clear)
      out.push({ sheet: SHEET_STYGIAN, type: "reminder", at: c.reminder, targetAt: c.clear, round })
    if (recent(c.clear, at)) out.push({ sheet: SHEET_STYGIAN, type: "clear", at: c.clear, round })
    if (recent(c.nextStart, at)) out.push({ sheet: SHEET_STYGIAN, type: "start", at: c.nextStart, round })
  }
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

export const fmt = date => {
  const d = new Date(date)
  const p = n => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
