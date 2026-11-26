/** 绝境攻炼：模式 / 目标 / 版更的固定口径 */

import { config, refreshAttackVersions } from "./config.js"

export const ATTACK_SHEET = "绝境攻炼"

const WAITING_STATUS = "等待开启"

export const ATTACK_MODES = [
  "线列破袭", "至寒风暴", "狭域死战",
  "焰羽追绞", "囚笼冰城",
  "交错锤砧", "重兵固港", "灾厄旧城",
]

export const ATTACK_FUTURE_VERSION_MODES = {
  "7.3": "7.3模式",
}

export const ATTACK_ALL_MODES = [...ATTACK_MODES, ...Object.values(ATTACK_FUTURE_VERSION_MODES)]

export const ATTACK_TARGETS = [
  { name: "满原石", color: "green" },
  { name: "满星章", color: "red" },
  { name: "顶分", color: "dark" },
]

export const ATTACK_TARGET_NAMES = ATTACK_TARGETS.map(t => t.name)

export const ATTACK_TARGET_ALIASES = { 满星: "满星章" }
export const canonicalAttackTarget = value => ATTACK_TARGET_ALIASES[clean(value)] ?? clean(value)

const DAY_MS = 24 * 60 * 60 * 1000

export const ATTACK_VERSION_START = new Date(2026, 10, 4, 10, 0, 0, 0)
export const ATTACK_VERSION_INTERVAL_DAYS = 42
export const ATTACK_VERSION_INTERVAL_MS = ATTACK_VERSION_INTERVAL_DAYS * DAY_MS

export const ATTACK_VERSION_MESSAGE = "【绝境攻炼】新模式已开启，如需帮帮可前往排队。"

const clean = value => String(value ?? "").trim()

export const ATTACK_DEFAULT_VERSIONS = [
  { version: "7.0", open_at: "2026-08-26 10:00", preset: "7.0模式", modes: ["线列破袭", "至寒风暴", "狭域死战"] },
  { version: "7.1", open_at: "2026-09-30 10:00", preset: "7.1模式", modes: ["焰羽追绞", "囚笼冰城"] },
  { version: "7.2", open_at: "2026-11-04 10:00", preset: "7.2模式", modes: ["交错锤砧", "重兵固港", "灾厄旧城"] },
  { version: "7.3", open_at: "2026-12-16 10:00", preset: "7.3模式", modes: [] },
]

const byVersion = (a, b) => String(a.version).localeCompare(String(b.version), "en", { numeric: true })

export function attackVersions() {
  const raw = refreshAttackVersions()
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? Object.entries(raw).map(([version, item]) => ({ version, ...(item ?? {}) }))
      : []
  const out = []
  for (const item of list) {
    const version = clean(item?.version)
    if (!version) continue
    const modes = (Array.isArray(item?.modes) ? item.modes : String(item?.modes ?? "").split(/[、,，\n]/))
      .map(clean)
      .filter(Boolean)
    const preset = clean(item?.preset) || `${version}模式`
    out.push({ version, open_at: clean(item?.open_at), preset, modes })
  }
  return out.length ? out.sort(byVersion) : ATTACK_DEFAULT_VERSIONS.map(item => ({ ...item, modes: [...item.modes] }))
}

export function attackModeNames() {
  return [
    ...new Set(attackVersions().flatMap(item => (item.modes.length ? item.modes : [item.preset])).filter(Boolean)),
  ]
}

export function attackKnownModes() {
  return [...new Set([...attackModeNames(), ...attackVersions().map(item => item.preset).filter(Boolean)])]
}

export function attackVersionOfMode(mode) {
  const text = clean(mode)
  if (!text) return ""
  return attackVersions().find(item => item.modes.includes(text) || item.preset === text)?.version ?? ""
}

export function attackVersionOpenAt(version) {
  const item = attackVersions().find(v => v.version === clean(version))
  if (!item?.open_at) return 0
  const at = new Date(item.open_at).getTime()
  return Number.isFinite(at) ? at : 0
}

export function attackVersionIsOpen(version, now = new Date()) {
  return new Date(now).getTime() >= attackVersionOpenAt(version)
}

function attackVersionsForModes(modes) {
  const order = attackVersions().map(v => v.version)
  const wanted = new Set((Array.isArray(modes) ? modes : []).map(attackVersionOfMode).filter(Boolean))
  return order.filter(v => wanted.has(v))
}

export function attackAutoStatus(goal, now = new Date()) {
  const parsed = typeof goal === "object" && goal ? goal : parseAttackGoal(goal)
  if (!parsed?.modes?.length) return WAITING_STATUS
  const versions = attackVersionsForModes(parsed.modes)
  if (!versions.length) return WAITING_STATUS
  const open = versions.filter(v => attackVersionIsOpen(v, now))
  const future = versions.filter(v => !attackVersionIsOpen(v, now))
  if (open.length) return `${open.join("/")}排队中`
  if (future.length) return `${future.join("/")}等待开启`
  return WAITING_STATUS
}

export function attackPendingStatus(goal, now = new Date()) {
  const parsed = typeof goal === "object" && goal ? goal : parseAttackGoal(goal)
  if (!parsed?.modes?.length) return WAITING_STATUS
  const versions = attackVersionsForModes(parsed.modes)
  if (!versions.length) return WAITING_STATUS
  const open = versions.filter(v => attackVersionIsOpen(v, now))
  const future = versions.filter(v => !attackVersionIsOpen(v, now))
  const parts = []
  if (open.length) parts.push(`${open.join("/")}排队中`)
  if (future.length) parts.push(`${future.join("/")}等待开启`)
  return parts.join(" ") || WAITING_STATUS
}

export function attackCompletedStatus(goal, people, now = new Date()) {
  const parsed = typeof goal === "object" && goal ? goal : parseAttackGoal(goal)
  if (!parsed?.modes?.length) return WAITING_STATUS
  const versions = attackVersionsForModes(parsed.modes)
  if (!versions.length) return WAITING_STATUS
  const perVersion = new Map()
  for (const part of attackStatusParts(people) ?? [])
    for (const version of part.versions) perVersion.set(version, part.label)
  if (perVersion.size) {
    const labels = new Map()
    for (const version of versions) {
      labels.set(version, perVersion.get(version) ||
        (attackVersionIsOpen(version, now) ? "排队中" : "等待开启"))
    }
    const grouped = new Map()
    for (const version of versions) {
      const label = labels.get(version)
      const list = grouped.get(label) ?? []
      list.push(version)
      grouped.set(label, list)
    }
    if (![...grouped.keys()].some(label => label !== "排队中" && label !== "等待开启")) {
      return attackAutoStatus(parsed, now)
    }
    return [...grouped.entries()]
      .map(([label, list]) => `${list.join("/")}${label}`)
      .join(" ")
  }
  const person = String(people ?? "").trim().split(/[,，、]/).map(clean).filter(Boolean).join("/")
  const open = versions.filter(v => attackVersionIsOpen(v, now))
  const future = versions.filter(v => !attackVersionIsOpen(v, now))
  const parts = []
  if (open.length) parts.push(`${open.join("/")}${person || "排队中"}`)
  if (future.length) parts.push(`${future.join("/")}等待开启`)
  return parts.join(" ") || WAITING_STATUS
}

export function attackStatusParts(status) {
  const raw = clean(status)
  if (!raw) return null
  const tokens = raw.split(/\s+/).filter(Boolean)
  const out = []
  for (const token of tokens) {
    const m = token.match(/^((?:\d+\.\d+)(?:\/\d+\.\d+)*)(.+)$/)
    if (!m) return null
    const versions = m[1].split("/").filter(Boolean)
    const suffix = m[2]
    if (suffix === "等待开启") out.push({ kind: "waiting", versions, label: suffix })
    else if (suffix === "排队中") out.push({ kind: "queued", versions, label: suffix })
    else if (suffix) out.push({ kind: "done", versions, label: suffix })
    else return null
  }
  return out.length ? out : null
}

export function attackStatusKind(status) {
  const parts = attackStatusParts(status)
  if (!parts) return null
  if (parts.some(p => p.kind === "queued")) return "queued"
  if (parts.some(p => p.kind === "waiting")) return "waiting"
  return "done"
}

export function attackVersionIndex(now = new Date()) {
  const at = now instanceof Date ? now.getTime() : new Date(now).getTime()
  if (!Number.isFinite(at) || at < ATTACK_VERSION_START.getTime()) return 0
  return Math.floor((at - ATTACK_VERSION_START.getTime()) / ATTACK_VERSION_INTERVAL_MS) + 1
}

export function attackVersionStart(index) {
  const n = Number(index)
  if (!Number.isFinite(n) || n < 1) return null
  return new Date(ATTACK_VERSION_START.getTime() + (n - 1) * ATTACK_VERSION_INTERVAL_MS)
}

const localDay = date => {
  const d = date instanceof Date ? date : new Date(date)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

export function attackVersionNotice(prev, now = new Date()) {
  if (!prev) return null
  const index = attackVersionIndex(now)
  if (!index) return null
  const last = Number(prev?.attackVersion?.index ?? prev?.attackVersion ?? 0)
  if (last >= index) return null
  const start = attackVersionStart(index)
  if (!start) return null
  const at = now instanceof Date ? now : new Date(now)
  if (at.getTime() < start.getTime()) return null
  if (localDay(at) !== localDay(start)) return null
  return { index, at: start }
}

export function attackGoalValue(modes, target) {
  const known = attackKnownModes()
  const raw = [...new Set((Array.isArray(modes) ? modes : String(modes ?? "").split(/[、,，/]/))
    .map(clean)
    .filter(m => known.includes(m)))]
  const versions = attackVersions()
  const list = [...new Set(raw.flatMap(m => {
    const row = versions.find(v => v.preset === m)
    return row?.modes?.length ? row.modes : [m]
  }))]
  const t = canonicalAttackTarget(target)
  if (!list.length || !ATTACK_TARGET_NAMES.includes(t)) return ""
  return `${list.join("、")}｜${t}`
}

export function parseAttackGoal(value, { expand = true } = {}) {
  const raw = clean(value)
  const at = raw.indexOf("｜")
  if (at <= 0) return null
  const left = raw.slice(0, at)
  const target = canonicalAttackTarget(raw.slice(at + 1).trim())
  const compact = left.match(/^((?:\d+\.\d+)(?:\/\d+\.\d+)*)模式$/)
  const rawModes = compact
    ? compact[1].split("/").map(v => `${v}模式`)
    : [...new Set(left.split(/[、,，/]/).map(clean).filter(Boolean))]
  if (!rawModes.length || !ATTACK_TARGET_NAMES.includes(target)) return null
  const known = attackKnownModes()
  if (rawModes.some(m => !known.includes(m))) return null
  if (!expand) return { modes: rawModes, target }
  const versions = attackVersions()
  const modes = [...new Set(rawModes.flatMap(m => {
    const row = versions.find(v => v.preset === m)
    return row?.modes?.length ? row.modes : [m]
  }))]
  return { modes, target }
}

export function attackModeShort(modes) {
  const known = attackKnownModes()
  const versions = attackVersions()
  const list = (Array.isArray(modes) ? modes : []).map(clean).filter(m => known.includes(m))
  const expanded = list.flatMap(m => {
    const item = versions.find(v => v.preset === m)
    return item?.modes?.length ? item.modes : [m]
  })
  const picked = new Set(expanded)
  const groups = versions.map(v => v.version)
  const complete = groups.filter(version => {
    const item = versions.find(v => v.version === version)
    const members = item?.modes?.length ? item.modes : [item?.preset].filter(Boolean)
    return members.length > 0 && members.every(m => picked.has(m))
  })
  const rest = list.filter(m => !complete.includes(attackVersionOfMode(m)))
  if (complete.length) return [`${complete.join("/")}模式`, ...rest].join("、")
  return list.join("、")
}

export function attackGoalView(value) {
  const parsed = parseAttackGoal(value)
  if (!parsed) return null
  const target = ATTACK_TARGETS.find(t => t.name === parsed.target)
  return {
    prefix: attackModeShort(parsed.modes),
    target: parsed.target,
    color: target?.color ?? "",
    full: parsed.modes.join("、"),
  }
}

export function goalPrefixTone(prefix) {
  if (/困难模式|第11层|险恶/.test(prefix)) return "green"
  if (/卓越模式|无畏/.test(prefix)) return "orange"
  if (/月谕模式|第12层|绝境/.test(prefix)) return "red"
  return "neutral"
}

const OLD_TARGET_RE = /(满原石|满星章|满星|顶分|180s)$/

export function goalParts(value) {
  const atk = attackGoalView(value)
  if (atk) return { ...atk, prefixTone: "neutral" }
  const v = clean(value)
  const m = OLD_TARGET_RE.exec(v)
  if (!m) return { prefix: v, target: "", prefixTone: goalPrefixTone(v), color: goalPrefixTone(v) }
  const prefix = v.slice(0, -m[1].length)
  return {
    prefix,
    target: m[1],
    prefixTone: goalPrefixTone(prefix),
    color: m[1] === "180s" ? "dark" : goalPrefixTone(prefix),
  }
}

export function attackGoalColor(value) {
  const view = attackGoalView(value)
  return view?.color ?? ""
}
