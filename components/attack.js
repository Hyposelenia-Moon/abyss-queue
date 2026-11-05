/**
 * 绝境攻炼：模式 / 目标 / 版更的固定口径
 *
 * 数据仍落在 A–H 八列里：E 列「模式及目标」存一个组合值，
 * 形如 `焰羽追绞、囚笼冰城｜满星章`。模式多选、目标单选；
 * 超过 2 个模式时显示按版本简写为 `7.0模式` / `7.1模式` / `7.0/7.1模式`。
 * 7.2 / 7.3 是**空预设**：未来版本模式名未知时，直接以「7.2模式 / 7.3模式」占位排队。
 *
 * 版更：2026-11-04 10:00 第 1 期，之后每 42 天一期。
 */

import { config, refreshAttackVersions } from "./config.js"

export const ATTACK_SHEET = "绝境攻炼"

/** 状态词与编辑器/进度模块同一口径；这个模块不反向依赖它们 */
const WAITING_STATUS = "等待开启"

export const ATTACK_MODES = ["焰羽追绞", "囚笼冰城", "线列破袭", "至寒风暴", "狭域死战"]

/** 模式所属版本：前三个 7.0，后两个 7.1；7.2 / 7.3 暂用空预设占位 */
export const ATTACK_FUTURE_VERSION_MODES = {
  "7.2": "7.2模式",
  "7.3": "7.3模式",
}

export const ATTACK_ALL_MODES = [...ATTACK_MODES, ...Object.values(ATTACK_FUTURE_VERSION_MODES)]

export const ATTACK_MODE_VERSIONS = {
  焰羽追绞: "7.0",
  囚笼冰城: "7.0",
  线列破袭: "7.0",
  至寒风暴: "7.1",
  狭域死战: "7.1",
  ...Object.fromEntries(Object.entries(ATTACK_FUTURE_VERSION_MODES).map(([v, m]) => [m, v])),
}

/** 目标：不设难度，只三选一 */
export const ATTACK_TARGETS = [
  { name: "满原石", color: "green" },
  { name: "满星章", color: "red" },
  { name: "顶分", color: "dark" },
]

export const ATTACK_TARGET_NAMES = ATTACK_TARGETS.map(t => t.name)

/** 旧写法兼容：表里已有的「满星」按「满星章」展示/保存，但不再作为新选项 */
export const ATTACK_TARGET_ALIASES = { 满星: "满星章" }
export const canonicalAttackTarget = value => ATTACK_TARGET_ALIASES[clean(value)] ?? clean(value)

export const ATTACK_STRENGTHS = ["高配｜满配满体", "中配｜半配半体", "低配｜裸配无体"]

const DAY_MS = 24 * 60 * 60 * 1000

/** 第 1 期开始：2026-11-04 10:00（本地时区） */
export const ATTACK_VERSION_START = new Date(2026, 10, 4, 10, 0, 0, 0)
export const ATTACK_VERSION_INTERVAL_DAYS = 42
export const ATTACK_VERSION_INTERVAL_MS = ATTACK_VERSION_INTERVAL_DAYS * DAY_MS
/** 版更播报正文（@全体成员 由发送侧拼） */
export const ATTACK_VERSION_MESSAGE = "【绝境攻炼】新模式已开启，如需帮帮可前往排队。"

const clean = value => String(value ?? "").trim()

/** 配置缺失时的兜底：与 `DEFAULT_CONFIG.attack_versions` 保持同一口径 */
export const ATTACK_DEFAULT_VERSIONS = [
  { version: "7.0", open_at: "2026-08-26 10:00", preset: "7.0模式", modes: ["焰羽追绞", "囚笼冰城", "线列破袭"] },
  { version: "7.1", open_at: "2026-09-30 10:00", preset: "7.1模式", modes: ["至寒风暴", "狭域死战"] },
  { version: "7.2", open_at: "2026-11-04 10:00", preset: "7.2模式", modes: [] },
  { version: "7.3", open_at: "2026-12-16 10:00", preset: "7.3模式", modes: [] },
]

/** 锅巴配置里的版本表 → 归一后的数组（兼容数组 / 以版本号为键的对象） */
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
  return out.length ? out : ATTACK_DEFAULT_VERSIONS.map(item => ({ ...item, modes: [...item.modes] }))
}

/** 这一版实际可选的模式：配了具体模式就用具体模式，否则用预设占位 */
export function attackModeNames() {
  return [
    ...new Set(attackVersions().flatMap(item => (item.modes.length ? item.modes : [item.preset])).filter(Boolean)),
  ]
}

/**
 * 解析/兼容用的模式名：除了当前可选项，还要认每个版本的旧占位名（`7.2模式`）。
 * 用户配了新版具体模式后，老行里仍可能留着占位名；保存不能再把它判成格式错误。
 */
export function attackKnownModes() {
  return [...new Set([...attackModeNames(), ...attackVersions().map(item => item.preset).filter(Boolean)])]
}

/**
 * 把版本占位名展开成该版本当前的具体模式。
 * 旧表里可能留着 `7.2模式`；配置了具体模式后，它仍代表「7.2 整版」。
 */
export function attackExpandModes(modes) {
  const list = Array.isArray(modes) ? modes : String(modes ?? "").split(/[、,，]/)
  const versions = attackVersions()
  const out = []
  for (const raw of list) {
    const mode = clean(raw)
    if (!mode) continue
    const item = versions.find(v => v.preset === mode)
    if (item?.modes?.length) out.push(...item.modes)
    else out.push(mode)
  }
  return [...new Set(out)]
}

/** 某个模式下属于哪一版 */
export function attackVersionOfMode(mode) {
  const text = clean(mode)
  if (!text) return ""
  return attackVersions().find(item => item.modes.includes(text) || item.preset === text)?.version ?? ""
}

/** 这一版的开放时刻；没配 / 配坏的按已开放处理，避免历史数据突然全变等待 */
export function attackVersionOpenAt(version) {
  const item = attackVersions().find(v => v.version === clean(version))
  if (!item?.open_at) return 0
  const at = new Date(item.open_at).getTime()
  return Number.isFinite(at) ? at : 0
}

export function attackVersionIsOpen(version, now = new Date()) {
  return new Date(now).getTime() >= attackVersionOpenAt(version)
}

/** 由模式列表取版本（按配置顺序去重） */
function attackVersionsForModes(modes) {
  const order = attackVersions().map(v => v.version)
  const wanted = new Set((Array.isArray(modes) ? modes : []).map(attackVersionOfMode).filter(Boolean))
  return order.filter(v => wanted.has(v))
}

/** 自动状态：已开放版本排队中、未开放版本等待开启；两段用空格隔开 */
export function attackAutoStatus(goal, now = new Date()) {
  const parsed = typeof goal === "object" && goal ? goal : parseAttackGoal(goal)
  if (!parsed?.modes?.length) return WAITING_STATUS
  const versions = attackVersionsForModes(parsed.modes)
  if (!versions.length) return WAITING_STATUS
  const open = versions.filter(v => attackVersionIsOpen(v, now))
  const future = versions.filter(v => !attackVersionIsOpen(v, now))
  /**
   * 排队状态只报「已经开放」的版本：同一行同时选了 7.2（已开）和 7.3（未来）时，
   * 当前就是 `7.2排队中`，未来的 7.3 不参与排队状态；只有全选未来版本才显示等待。
   */
  if (open.length) return `${open.join("/")}排队中`
  if (future.length) return `${future.join("/")}等待开启`
  return WAITING_STATUS
}

/** 完成状态：已开放版本带完成人，未开放版本仍等待开启 */
export function attackCompletedStatus(goal, people, now = new Date()) {
  const parsed = typeof goal === "object" && goal ? goal : parseAttackGoal(goal)
  if (!parsed?.modes?.length) return WAITING_STATUS
  const versions = attackVersionsForModes(parsed.modes)
  if (!versions.length) return WAITING_STATUS

  /**
   * 4B：不同版本可以是不同完成人。调用方传进来的若是已经带版本的复合状态
   * （例如 `7.0阿修 7.1听雨`），按版本保留各自的人；缺的版本再按开没开补状态。
   * 只传一个裸名字时仍按旧口径套到所有已开放版本。
   */
  const perVersion = new Map()
  for (const part of attackStatusParts(people) ?? [])
    for (const version of part.versions) perVersion.set(version, part.label)
  if (perVersion.size) {
    return versions
      .map(v => `${v}${perVersion.get(v) ?? (attackVersionIsOpen(v, now) ? "排队中" : "等待开启")}`)
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

/**
 * 解析枪战复合状态：`7.2排队中`、`7.2阿修Axiu 7.3等待开启`、`7.0/7.2阿修/听雨`
 * @returns {{kind:"waiting"|"queued"|"done", versions:string[]}[]|null}
 */
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

/** 枪战复合状态归类；普通状态返回 null，交给旧逻辑 */
export function attackStatusKind(status) {
  const parts = attackStatusParts(status)
  if (!parts) return null
  if (parts.some(p => p.kind === "waiting")) return "waiting"
  if (parts.some(p => p.kind === "queued")) return "queued"
  return "done"
}

/** 某个时刻属于第几期；第 1 期之前返回 0 */
export function attackVersionIndex(now = new Date()) {
  const at = now instanceof Date ? now.getTime() : new Date(now).getTime()
  if (!Number.isFinite(at) || at < ATTACK_VERSION_START.getTime()) return 0
  return Math.floor((at - ATTACK_VERSION_START.getTime()) / ATTACK_VERSION_INTERVAL_MS) + 1
}

/** 第 index 期（从 1 开始）的开始时刻 */
export function attackVersionStart(index) {
  const n = Number(index)
  if (!Number.isFinite(n) || n < 1) return null
  return new Date(ATTACK_VERSION_START.getTime() + (n - 1) * ATTACK_VERSION_INTERVAL_MS)
}

/** 绝境攻炼是否已经开榜（第 1 期开始后一直开） */
export const attackIsOpen = (now = new Date()) =>
  new Date(now).getTime() >= ATTACK_VERSION_START.getTime()

const localDay = date => {
  const d = date instanceof Date ? date : new Date(date)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/**
 * 版更播报：只在版更当天 10:00 之后触发一次，且同一期不重复。
 *
 * `prev` 是进度状态文件（首跑没有状态文件时返回 null，避免刚部署就 @全体）。
 * @param {object|null} prev
 * @param {Date} [now]
 * @returns {{index:number, at:Date}|null}
 */
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
  /** 只认版更当天；停机跨过一整天不补发，避免上线时突然 @全体 */
  if (localDay(at) !== localDay(start)) return null
  return { index, at: start }
}

/** 由模式数组 + 目标拼成表里的规范值 */
export function attackGoalValue(modes, target) {
  const known = attackKnownModes()
  const list = [...new Set((Array.isArray(modes) ? modes : String(modes ?? "").split(/[、,，]/))
    .map(clean)
    .filter(m => known.includes(m)))]
  const t = canonicalAttackTarget(target)
  if (!list.length || !ATTACK_TARGET_NAMES.includes(t)) return ""
  return `${list.join("、")}｜${t}`
}

/**
 * 解析 E 列组合值；格式不对、模式/目标认不出时返回 null。
 * @returns {{modes:string[], target:string}|null}
 */
export function parseAttackGoal(value) {
  const raw = clean(value)
  const at = raw.indexOf("｜")
  if (at <= 0) return null
  const left = raw.slice(0, at)
  const target = canonicalAttackTarget(raw.slice(at + 1).trim())
  const modes = [...new Set(left.split(/[、,，]/).map(clean).filter(Boolean))]
  if (!modes.length || !ATTACK_TARGET_NAMES.includes(target)) return null
  const known = attackKnownModes()
  if (modes.some(m => !known.includes(m))) return null
  return { modes, target }
}

/**
 * 模式显示：某个版本的模式**全部选中**时才用版本简写。
 * 连续的完整版本合并成区间（7.0/7.1模式、7.2/7.3模式），不连续的版本用「、」分隔。
 */
export function attackModeShort(modes) {
  const known = attackKnownModes()
  const versions = attackVersions()
  const list = (Array.isArray(modes) ? modes : []).map(clean).filter(m => known.includes(m))
  /**
   * 旧行可能存的是版本占位名（`7.3模式、7.2模式`）；配置了具体模式后，
   * 这个占位名不再等于任何单个模式，但仍代表「该版本整版」。
   * 先把占位名展开成该版本当前的具体模式，再参与完整版判断。
   */
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
  /** 所有完整版本统一用 / 连接：7.0/7.1、7.0/7.2/7.3 都写成一段 */
  const rest = list.filter(m => !complete.includes(attackVersionOfMode(m)))
  if (complete.length) return [`${complete.join("/")}模式`, ...rest].join("、")
  return list.join("、")
}

/**
 * 表格/菜单显示用：模式短名 + 目标 + 目标颜色。
 * @returns {{prefix:string,target:string,color:string,full:string}|null}
 */
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

/** 目标对应的颜色；旧三榜的目标段也复用这一档 */
export function attackTargetColor(target) {
  return ATTACK_TARGETS.find(t => t.name === canonicalAttackTarget(target))?.color ?? ""
}

/** 旧三榜前缀的颜色（难度/层数） */
export function goalPrefixTone(prefix) {
  if (/困难模式|第11层|险恶/.test(prefix)) return "green"
  if (/卓越模式|无畏/.test(prefix)) return "orange"
  if (/月谕模式|第12层|绝境/.test(prefix)) return "red"
  return "neutral"
}

const OLD_TARGET_RE = /(满原石|满星章|满星|顶分|180s)$/

/**
 * 显示层拆「难度/模式前缀 + 目标段」；表里的原值不变。
 * 攻击组合值走 attackGoalView，前缀按版本简写；旧三榜按后缀拆。
 */
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

/** 兼容旧调用：E 列组合值按目标上色 */
export function attackGoalColor(value) {
  const view = attackGoalView(value)
  return view?.color ?? ""
}
