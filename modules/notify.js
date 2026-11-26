/** 唯一的定时任务：一条 tick 里按**内部时间判断**做四件事 */
import {
  atOrAfter,
  defaultStatusOf,
  detectCompletions,
  detectReverts,
  isLastDayOfMonth,
  localDayKey,
  QUEUED,
  sameShape,
  snapshot,
  snapshotShape,
  statusOf,
} from "./progress.js"
import {
  abyssCycle,
  attackCycle,
  dramaCycle,
  stygianCycle,
  SHEET_ABYSS,
  SHEET_ATTACK,
  SHEET_DRAMA,
  SHEET_STYGIAN,
} from "../components/cycle.js"

export const TICK_NAME = "队列定时检查"

export const sheetOpenOf = (model, now = new Date()) =>
  defaultStatusOf(model.name, now) === QUEUED || (model.rows ?? []).some(r => statusOf(r.status) === "queued")
export function openPeriodOf(sheet, now = new Date()) {
  if (sheet === SHEET_DRAMA) return `drama:${dramaCycle(now).month}`
  if (sheet === SHEET_ABYSS) return `abyss:${abyssCycle(now).month}`
  if (sheet === SHEET_STYGIAN) return `stygian:${stygianCycle(now).start.getTime()}`
  if (sheet === SHEET_ATTACK) return `attack:${attackCycle(now).lastStart.getTime()}`
  return `static:${sheet}`
}

export const queuedInSheet = model =>
  (model.rows ?? [])
    .filter(r => statusOf(r.status) === "queued")
    .sort((a, b) => a.row - b.row)
    .map(r => ({ row: r.row, seq: String(r.seq ?? "").trim() || String(r.row), nickname: String(r.nickname ?? "").trim() }))
    .filter(r => r.nickname)
export function tickTasks({ prev, models, now, cfg = {} }) {
  const done = prev?.rows && typeof prev.rows === "object" ? prev.rows : {}
  const beforeOpen = prev?.open && typeof prev.open === "object" ? prev.open : {}
  const beforeNotified = prev?.openNotified && typeof prev.openNotified === "object" ? prev.openNotified : {}
  const beforeDaily = prev?.daily && typeof prev.daily === "object" ? prev.daily : {}
  const first = !prev
  const next = snapshot(models)
  const shape = snapshotShape(models)
  const structureChanged = !sameShape(prev?.shape, shape)
  const open = {}
  const openNotified = { ...beforeNotified }
  const openNow = []
  for (const model of models) {
    const isOpen = sheetOpenOf(model, now)
    open[model.name] = isOpen
    if (!isOpen) continue
    const key = openPeriodOf(model.name, now)
    const queue = queuedInSheet(model)
    const notified = Object.hasOwn(beforeNotified, model.name)
    if (first) {
      openNotified[model.name] = key
      continue
    }
    if (!notified) {
      if (beforeOpen[model.name] === true) openNotified[model.name] = key
      else if (queue.length) {
        openNow.push(model.name)
        openNotified[model.name] = key
      }
      continue
    }
    if (openNotified[model.name] !== key && queue.length) {
      openNow.push(model.name)
      openNotified[model.name] = key
    }
  }
  const day = localDayKey(now)
  const daily = { ...beforeDaily }
  const monthly = monthlyTask({ models, now, cfg, daily, day })
  const roster = atOrAfter(now, cfg.rosterAt || "05:00")
  const tidy = atOrAfter(now, cfg.rosterAt || "05:00") && daily.tidy !== day
  return {
    state: { rows: next, shape, open, openNotified, daily, at: now.getTime() },
    ready: !first,
    openNow,
    completions: first
      ? []
      : detectCompletions(done, next, structureChanged ? { byNickname: true } : {}),
    reverts: first ? [] : detectReverts(done, next, structureChanged ? { byNickname: true } : {}),
    monthly,
    roster,
    tidy,
  }
}

function monthlyTask({ models, now, cfg, daily, day }) {
  if (cfg.monthlyEnable === false) return null
  if (!isLastDayOfMonth(now)) return null
  if (!atOrAfter(now, cfg.monthlyAt || "12:00")) return null
  if (daily.monthly === day) return null
  const sheets = pendingSheets(models)
  if (!sheets.length) return null
  daily.monthly = day
  return { sheets, day }
}

function pendingSheets(models) {
  const out = []
  for (const model of models) {
    const rows = queuedInSheet(model)
    if (rows.length) out.push({ sheet: model.name, rows })
  }
  return out
}

export function readState(readJson) {
  const raw = readJson()
  return raw && typeof raw === "object" ? raw : null
}
