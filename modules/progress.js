/** 排队进度的判定与变化检测（纯函数，可独立测试） */
import { phaseOf as cyclePhaseOf } from "../components/cycle.js"
import { attackStatusKind } from "../components/attack.js"

const clean = s => String(s ?? "").trim()

export const WAITING = "等待开启"

export const QUEUED = "排队中"
export const SELF_DONE = "本人已完成"

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

export const isDone = status => {
  const kind = attackStatusKind(status)
  if (kind) return kind === "done"
  const s = clean(status)
  return Boolean(s) && s !== WAITING && s !== QUEUED
}

export const isPending = status => {
  const kind = attackStatusKind(status)
  if (kind) return kind === "queued"
  return !isDone(status) && clean(status) !== WAITING
}

export const completionState = status => {
  const kind = attackStatusKind(status)
  if (kind) return kind === "done" ? "已完成" : "未完成"
  const s = clean(status)
  if (!s || s === WAITING || s === QUEUED || /^(未开始|进行中|待开始)$/.test(s)) return "未完成"
  return "已完成"
}

const rowPending = row => isPending(row?.status)
const rowDone = row => isDone(row?.status)

export const statusOf = status => {
  const kind = attackStatusKind(status)
  if (kind) return kind
  const s = clean(status)
  if (!s) return null
  if (s === WAITING) return "waiting"
  if (s === QUEUED) return "queued"
  return "done"
}

export const rowKey = (sheet, row) => `${sheet}#${row}`

export const defaultStatusOf = (sheetName, now = new Date()) => {
  const name = String(sheetName ?? "")
  if (/攻炼|绝境/.test(name)) return QUEUED
  return cyclePhaseOf(name, now) === "queued" ? QUEUED : WAITING
}

export const minuteOfDay = (hhmm, fallback = 0) => {
  const m = /^\s*(\d{1,2})\s*:\s*(\d{1,2})\s*$/.exec(String(hhmm ?? ""))
  if (!m) return fallback
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return fallback
  return h * 60 + min
}

export const atOrAfter = (date, hhmm) => date.getHours() * 60 + date.getMinutes() >= minuteOfDay(hhmm)

export const localDayKey = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
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

export function snapshotShape(models) {
  const shape = {}
  for (const model of models) {
    shape[model.name] = (model.rows ?? [])
      .filter(r => clean(r.nickname))
      .map(r => `${r.row}:${clean(r.nickname)}`)
  }
  return shape
}

export const sameShape = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

const nickKey = item => {
  const nickname = clean(item?.nickname)
  return nickname ? `${clean(item?.sheet)}\u0000${nickname}` : ""
}

const uniqueByNickname = snapshot => {
  const index = new Map()
  const dup = new Set()
  for (const item of Object.values(snapshot ?? {})) {
    const key = nickKey(item)
    if (!key) continue
    if (index.has(key)) dup.add(key)
    else index.set(key, item)
  }
  for (const key of dup) index.delete(key)
  return index
}

export function detectCompletions(prev = {}, next = {}, { byNickname = false } = {}) {
  const out = []
  const beforeByNick = byNickname ? uniqueByNickname(prev) : null
  for (const [key, now] of Object.entries(next)) {
    const before = beforeByNick ? beforeByNick.get(nickKey(now)) : prev[key]
    if (!before) continue
    if (before.done || !now.done) continue
    if (before.status === now.status) continue
    out.push({ sheet: now.sheet, row: now.row, seq: now.seq, nickname: now.nickname, status: now.status })
  }
  return out.sort((a, b) => a.sheet.localeCompare(b.sheet, "zh") || a.row - b.row)
}

export function detectReverts(prev = {}, next = {}, { byNickname = false } = {}) {
  const out = []
  const beforeByNick = byNickname ? uniqueByNickname(prev) : null
  for (const [key, now] of Object.entries(next)) {
    const before = beforeByNick ? beforeByNick.get(nickKey(now)) : prev[key]
    if (!before) continue
    if (!before.done || now.done) continue
    if (before.status === now.status) continue
    if (statusOf(now.status) !== "queued") continue
    out.push({ sheet: now.sheet, row: now.row, seq: now.seq, nickname: now.nickname, status: now.status })
  }
  return out.sort((a, b) => a.sheet.localeCompare(b.sheet, "zh") || a.row - b.row)
}

export function nextPending(model, row, { wrap = false } = {}) {
  const rows = (model.rows ?? []).filter(r => clean(r.nickname)).sort((a, b) => a.row - b.row)
  const i = rows.findIndex(r => r.row === row)
  if (i < 0) return null
  for (let j = i + 1; j < rows.length; j++) if (rowPending(rows[j])) return rows[j]
  if (!wrap) return null
  return rows.find(rowPending) ?? null
}

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

export function isLastDayOfMonth(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return false
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
  return next.getDate() === 1
}
